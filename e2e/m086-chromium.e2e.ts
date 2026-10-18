/* eslint-disable @typescript-eslint/no-explicit-any */
// MIGRATION 086 (tools/m086-verify) — REAL Chromium (persistent profile: real on-disk
// IndexedDB, real Web Locks, real crash + restart) running the 086 client
// against the disposable loopback stack WITH migration 086. Every outcome is
// asserted in the till's IndexedDB AND in PostgreSQL.
import { test, expect, type Route } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Terminal, blockedNonLoopback } from "./helpers/terminal";
import { runSql } from "./helpers/db";
import { liveCfg, qaTotpSecret } from "./helpers/env";
import { signedInClient } from "../src/live/liveHelpers";
import {
  P1, P2, RPC, freshTill, idbSnapshot, profile, reopenTill, serverSales, serverStock, sessionsLostOnRestart, st, pw,
} from "./m086-helpers";

test.describe.configure({ mode: "serial" });
// Disposable loopback stack only (tools/m086-verify/run.sh sets M086_LIVE=1);
// a normal e2e run skips this file.
test.skip(process.env.M086_LIVE !== "1", "migration 086 verification: run via tools/m086-verify/run.sh");
if (process.env.M086_LIVE === "1" && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("M086_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run tools/m086-verify/run.sh)");
}
const evidence: Record<string, unknown> = {};
const note = (id: string, v: unknown) => { evidence[id] = v; console.log(`[m086] ${id} ${JSON.stringify(v)}`); };
const ledger = (key: string) => runSql(`SELECT coalesce((SELECT state || '/' || coalesce(outcome_code, '') FROM idempotency_keys WHERE key = '${key}'::uuid), '<none>');`).trim();

test.afterAll(() => {
  writeFileSync(process.env.M086_E2E_EVIDENCE ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), evidence, blockedNonLoopback: [...new Set(blockedNonLoopback)], sessionsLostOnRestart }, null, 2));
});

async function confirmPayment(T: any, paid = 5000): Promise<void> {
  await T.page.keyboard.press("F2");
  const amount = T.page.getByLabel("Amount received");
  await amount.waitFor({ state: "visible" });
  await expect.poll(() => amount.inputValue()).toBe("0");
  await amount.fill(String(paid));
  await amount.press("Enter");
}

test("M1 C1: crash during the FIRST online attempt (never reached the server) -> restart -> fenced, never executed; the late copy is refused", async () => {
  const T = await freshTill("m086-1");
  const salesBefore = await serverSales();
  let captured: any = null;
  await T.context.route(RPC("op_execute"), async (route: Route) => {
    captured = route.request().postDataJSON();
    await new Promise(() => undefined); // never forwarded, never answered
  });
  await T.posAddByCard(P1);
  await confirmPayment(T);
  await expect.poll(() => captured !== null, { timeout: 20_000 }).toBe(true);
  const [row] = (await idbSnapshot(T)).outbox.filter((r: any) => r.name === "complete_sale");
  expect(row).toMatchObject({ status: "syncing", writeAhead: true });
  expect(row.idempotencyKey).toBe(captured.p_key);
  expect(row.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // UUIDv7
  await T.crash();

  const R = await reopenTill("m086-1");
  try {
    await expect.poll(async () => (await idbSnapshot(R)).outbox.find((r: any) => r.localId === row.localId)?.serverOutcome, { timeout: 60_000 }).toBe("abandoned");
    const after = (await idbSnapshot(R)).outbox.find((r: any) => r.localId === row.localId);
    expect(after).toMatchObject({ status: "conflict", fenceRequired: true, inDoubt: false });
    expect(ledger(row.idempotencyKey)).toBe("abandoned/FENCED");
    expect(await serverSales()).toBe(salesBefore);
    expect(R.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_key === row.idempotencyKey)).toHaveLength(0);
    expect(R.rpcBodies.some((b) => b.name === "op_status" && (b.body as any)?.p_key === row.idempotencyKey && (b.body as any)?.p_fence === true)).toBe(true);
    // the delayed original request finally arrives: refused on both paths
    const c = await signedInClient(liveCfg(), st.emails.cashA, pw);
    const late = await c.rpc("op_execute", captured);
    expect(late.data).toEqual({ outcome: "abandoned", replayed: true });
    const legacy = await c.rpc("complete_sale", { ...captured.p_args, p_idempotency_key: captured.p_key });
    expect(legacy.error?.message).toMatch(/^OP_EXECUTOR_REQUIRED/);   // UUIDv7: never through a legacy RPC on an 086 server
    expect(await serverSales()).toBe(salesBefore);
    note("M1", { beforeCrash: "syncing write-ahead, v7 key", afterRestart: "op_status fence -> abandoned", resent: 0, ledger: "abandoned/FENCED", lateExecutor: late.data, lateLegacy: legacy.error?.message?.slice(0, 21), sales: "unchanged" });
  } finally {
    await R.close();
  }
});

test("M2 committed, reply lost, crash -> restart -> the lookup returns the committed reply; reconciled once, nothing resent", async () => {
  const T = await freshTill("m086-2");
  const salesBefore = await serverSales();
  const stockBefore = await serverStock();
  let committed = false;
  let key = "";
  await T.context.route(RPC("op_execute"), async (route: Route) => {
    key = (route.request().postDataJSON() as any).p_key;
    const res = await route.fetch().catch(() => null);
    committed = Boolean(res);
    await new Promise(() => undefined); // the reply never arrives
  });
  await T.posAddByCard(P1);
  await confirmPayment(T);
  await expect.poll(() => committed, { timeout: 20_000 }).toBe(true);
  expect(await serverSales()).toBe(salesBefore + 1);
  await T.crash();

  const R = await reopenTill("m086-2");
  try {
    await expect.poll(async () => (await idbSnapshot(R)).outbox.filter((r: any) => r.name === "complete_sale").length, { timeout: 60_000 }).toBe(0);
    expect(await serverSales()).toBe(salesBefore + 1);
    expect(await serverStock()).toBe(stockBefore - 1);
    expect(ledger(key)).toBe("committed/");
    expect(R.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_key === key)).toHaveLength(0);
    const serverSaleId = runSql(`SELECT response->'sale'->>'id' FROM idempotency_keys WHERE key = '${key}'::uuid;`).trim();
    await expect.poll(async () => (await idbSnapshot(R)).sales.some((s: any) => s.id === serverSaleId), { timeout: 20_000 }).toBe(true);
    note("M2", { serverSales: "+1 exactly", stock: "-1 exactly", resent: 0, reconciledFrom: "op_status stored reply", localSale: "server id" });
  } finally {
    await R.close();
  }
});

test("M3 B2: an offline sale the server refuses (stock gone meanwhile) is recorded FINAL; after a restock it never executes", async () => {
  const T = await freshTill("m086-3");
  const c = await signedInClient(liveCfg(), st.emails.mgr, pw);
  const adjust = async (delta: number) => {
    const r = await c.rpc("adjust_stock", {
      p_shop_id: st.ids.shop, p_product_id: st.ids.prod2, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: delta,
      p_reason: "m086 e2e", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: st.ids.mgr,
      p_idempotency_key: crypto.randomUUID(),
    });
    if (r.error) throw new Error(r.error.message);
  };
  const salesBefore = await serverSales();
  try {
    await T.setOffline(true);
    await T.posAddByCard(P2);
    await confirmPayment(T);
    await expect.poll(async () => (await idbSnapshot(T)).outbox.filter((r: any) => r.name === "complete_sale").length).toBe(1);
    const [row] = (await idbSnapshot(T)).outbox.filter((r: any) => r.name === "complete_sale");
    const stock = await serverStock(st.ids.prod2);
    await adjust(-stock); // the server's stock is gone before the till reconnects
    await T.setOffline(false);
    await expect.poll(async () => (await idbSnapshot(T)).outbox.find((r: any) => r.localId === row.localId)?.serverOutcome, { timeout: 60_000 }).toBe("rejected");
    expect(ledger(row.idempotencyKey)).toBe("rejected/P0001");
    await adjust(10); // restock
    await T.reload();
    await T.waitForApp();
    await T.page.waitForTimeout(5000);
    expect(await serverSales()).toBe(salesBefore);
    const after = (await idbSnapshot(T)).outbox.find((r: any) => r.localId === row.localId);
    expect(after).toMatchObject({ status: "conflict", serverOutcome: "rejected" });
    expect(after.lastError).toMatch(/Refused by the server \(final/);
    expect(T.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_key === row.idempotencyKey)).toHaveLength(1);
    note("M3", { refusal: after.lastError.slice(0, 90), ledger: "rejected/P0001", afterRestock: "no sale, never resent" });
  } finally {
    await adjust(Math.max(0, 100 - (await serverStock(st.ids.prod2)))).catch(() => undefined);
    await T.close();
  }
});

test("M4 H1: committed, reply lost, crash; after restart the server cannot be asked (held) -> ringing the same sale again and choosing 'new' is BLOCKED (no second sale); once reachable, reconciled once", async () => {
  const T = await freshTill("m086-4");
  const salesBefore = await serverSales();
  let committed = false;
  let key = "";
  await T.context.route(RPC("op_execute"), async (route: Route) => {
    key = (route.request().postDataJSON() as any).p_key;
    const res = await route.fetch().catch(() => null);
    committed = Boolean(res);
    await new Promise(() => undefined); // the reply never arrives
  });
  await T.posAddByCard(P1);
  await confirmPayment(T);
  await expect.poll(() => committed, { timeout: 20_000 }).toBe(true);
  expect(await serverSales()).toBe(salesBefore + 1);
  await T.crash();

  // restart: the server cannot be asked what happened (op_status unreachable)
  const R = await reopenTill("m086-4", async (X) => {
    await X.context.route(RPC("op_status"), (route: Route) => route.abort("failed"));
  });
  try {
    await expect.poll(async () => (await idbSnapshot(R)).outbox.find((r: any) => r.idempotencyKey === key)?.fenceRequired, { timeout: 60_000 }).toBe(true);
    const held = (await idbSnapshot(R)).outbox.find((r: any) => r.idempotencyKey === key);
    expect(held.status).toBe("conflict");
    const execBefore = R.rpcBodies.filter((b) => b.name === "op_execute").length;
    // the cashier rings the same sale again and says it is a separate, new one
    await R.posAddByCard(P1);
    await confirmPayment(R);
    // the duplicate-sale prompt lists the HELD earlier attempt
    await expect(R.page.getByRole("heading", { name: "Awaiting confirmation" })).toBeVisible({ timeout: 20_000 });
    await R.page.getByRole("button", { name: "This is a separate, new one" }).click();
    await R.page.waitForTimeout(3000);
    expect(R.rpcBodies.filter((b) => b.name === "op_execute").length).toBe(execBefore);   // nothing new sent
    expect(await serverSales()).toBe(salesBefore + 1);                                    // no second sale
    expect((await idbSnapshot(R)).outbox.find((r: any) => r.idempotencyKey === key)).toBeTruthy(); // kept, same key
    // the server becomes reachable: the held original is looked up and reconciled once
    await R.context.unroute(RPC("op_status"));
    await expect.poll(async () => (await idbSnapshot(R)).outbox.some((r: any) => r.idempotencyKey === key), { timeout: 120_000 }).toBe(false);
    expect(await serverSales()).toBe(salesBefore + 1);
    expect(ledger(key)).toBe("committed/");
    note("M4", { heldAfterRestart: "conflict + fenceRequired (status unreachable)", replacement: "prompt -> 'new' -> blocked, nothing sent", serverSales: "+1 exactly", later: "reconciled once by lookup" });
  } finally {
    await R.close();
  }
});

test("M5 A (two windows, real IndexedDB + Web Locks): the earlier sale commits and ANOTHER WINDOW acknowledges it (queue row deleted) while the replacement prompt is open -> 'new' records nothing new", async () => {
  test.setTimeout(300_000);
  const T = await freshTill("m086-5");
  const salesBefore = await serverSales();
  // Window 1: every op_execute reaches the server, but its reply is lost.
  await T.page.route(RPC("op_execute"), async (route: Route) => {
    await route.fetch().catch(() => null);
    await route.abort("failed");
  });
  await T.posAddByCard(P1);
  await confirmPayment(T);
  await expect.poll(async () => (await idbSnapshot(T)).outbox.find((r: any) => r.name === "complete_sale")?.inDoubt, { timeout: 60_000 }).toBe(true);
  const row = (await idbSnapshot(T)).outbox.find((r: any) => r.name === "complete_sale");
  expect(await serverSales()).toBe(salesBefore + 1);
  expect(ledger(row.idempotencyKey)).toBe("committed/");
  // The cashier rings the same sale again: the prompt lists the earlier one.
  await T.posAddByCard(P1);
  await confirmPayment(T);
  await expect(T.page.getByRole("heading", { name: "Awaiting confirmation" })).toBeVisible({ timeout: 20_000 });
  // Meanwhile a second window of the same till (no lost replies) drains:
  // it replays the ORIGINAL key and deletes the row.
  const W2 = await T.context.newPage();
  try {
    await W2.goto(T.page.url());
    // Window 1's own attempts keep losing their replies and back the row
    // off; make it due again (from window 2) until window 2's periodic
    // drain — the only one that can read a reply — acknowledges it.
    const makeDue = (localId: string) => W2.evaluate((id) => new Promise<void>((resolve) => {
      const open = indexedDB.open("shwe-phala-local");
      open.onsuccess = () => {
        const tx = open.result.transaction("syncOutbox", "readwrite");
        const store = tx.objectStore("syncOutbox");
        const get = store.get(id);
        get.onsuccess = () => { if (get.result) store.put({ ...get.result, nextAttemptAt: undefined }); };
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => { open.result.close(); resolve(); };
      };
      open.onerror = () => resolve();
    }), localId);
    await expect.poll(async () => {
      await makeDue(row.localId);
      return (await idbSnapshot(T)).outbox.some((r: any) => r.localId === row.localId);
    }, { timeout: 180_000, intervals: [2000] }).toBe(false);
    const newKeysBefore = T.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_key !== row.idempotencyKey).length;
    await T.page.getByRole("button", { name: "This is a separate, new one" }).click();
    const texts: string[] = [];
    for (let i = 0; i < 20; i++) {
      texts.push(...(await T.page.locator('[role="status"], [role="alert"], [data-sonner-toast], li[role="status"]').allInnerTexts().catch(() => [])));
      if (texts.some((t) => /Pending confirmation|could not be confirmed|appeared while/.test(t)) && i >= 4) break;
      await T.page.waitForTimeout(500);
    }
    await T.page.waitForTimeout(3000);
    const newExec = T.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_key !== row.idempotencyKey).length - newKeysBefore;
    console.log("[m086] M5-diag", JSON.stringify({ texts: [...new Set(texts)].map((t) => t.slice(0, 160)), sales: (await serverSales()) - salesBefore, newExecAfterClick: newExec }));
    expect(await serverSales()).toBe(salesBefore + 1);                                          // never a duplicate
    expect(newExec).toBe(0);                                                                    // no replacement was sent
    expect(texts.some((t) => /do not ring it up again/.test(t))).toBe(true);                    // what the cashier is told
    expect((await idbSnapshot(T)).outbox.filter((r: any) => r.name === "complete_sale")).toHaveLength(0); // nothing new queued
    expect(T.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_key !== row.idempotencyKey).length).toBe(newKeysBefore);
    expect(T.rpcBodies.some((b) => b.name === "op_status" && (b.body as any)?.p_key === row.idempotencyKey && (b.body as any)?.p_fence === true)).toBe(true);
    note("M5", { window1: "lost replies; in doubt; prompt open", window2: "drained: replayed the original, row deleted", replacement: "re-asked by the original key -> committed -> nothing new", serverSales: "+1 exactly" });
  } finally {
    await W2.close().catch(() => undefined);
    await T.close();
  }
});

// ===================== POST-CHECKPOINT (after d0390a1): a till with NO queued work and ONE unresolved supplier payment =====================
test("M6 zero queue + one unresolved supplier payment: the real UI shows it, exports it (app shell AND sign-in screen), inspect flags it; Check settles it once — ONE supplier_payments row", async () => {
  test.setTimeout(300_000);
  const { randomUUID } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const { decryptQueueExport } = await import("../src/lib/queueExport/format");
  const PASS = "m086-zero-queue-export";
  const admin = await signedInClient(liveCfg(), st.emails.admin, pw);
  const mgr = await signedInClient(liveCfg(), st.emails.mgr, pw);
  const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: st.ids.sup, p_notes: "m086-M6", p_items: [{ product_id: st.ids.prod3, ordered_qty: 3, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
  const poId = (po.data as any).purchaseOrder.id;
  expect((await mgr.rpc("approve_purchase_order", { p_purchase_order_id: poId, p_idempotency_key: randomUUID() })).error).toBeNull();
  expect((await mgr.rpc("receive_purchase_order", { p_purchase_order_id: poId, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID() })).error).toBeNull();
  const pays = () => Number(runSql(`SELECT count(*) FROM supplier_payments WHERE supplier_id = '${st.ids.sup}';`).trim());
  const paidOnPo = () => Number(runSql(`SELECT paid_mmk FROM purchase_orders WHERE id = '${poId}';`).trim());
  const p0 = pays();
  const paid0 = paidOnPo();

  rmSync(profile("m086-6"), { recursive: true, force: true });
  const T = await Terminal.launchPersistent(profile("m086-6"));
  try {
    await T.signIn(st.emails.mgr, pw, "/app");
    await T.waitForApp();
    // every payment request reaches the server but its reply is lost; the lookup cannot be answered
    let key = "";
    await T.page.route(RPC("op_execute"), async (route: Route) => {
      key = (route.request().postDataJSON() as any).p_key;
      await route.fetch().catch(() => null);
      await route.abort("failed");
    });
    await T.page.route(RPC("op_status"), (route: Route) => route.abort("failed"));
    await T.navigate(`/app/suppliers/${st.ids.sup}`);
    await T.page.getByRole("button", { name: "Pay supplier" }).click();
    const modal = T.page.locator(".fixed.inset-0.z-50");
    const amount = modal.locator('input[inputmode="numeric"]').first();
    await expect.poll(async () => (await amount.inputValue()).replace(/[^\d]/g, ""), { timeout: 10_000 }).not.toBe("");
    for (let i = 0; i < 5; i++) { await amount.fill("1500"); await T.page.waitForTimeout(500); if ((await amount.inputValue()).replace(/[^\d]/g, "") === "1500") break; }
    await modal.getByRole("button", { name: "Record payment" }).click();
    await expect(T.page.getByTestId("online-ops-unresolved")).toBeVisible({ timeout: 60_000 });
    expect(await T.page.getByTestId("online-ops-unresolved").innerText()).toMatch(/1 payment awaits server confirmation — do not enter again/);
    expect(pays()).toBe(p0 + 1);                                                         // the server applied it ONCE
    expect(ledger(key)).toBe("committed/");
    const snap = await idbSnapshot(T);
    expect(snap.outbox).toHaveLength(0);                                                 // ZERO queued work
    const opRow = snap.syncState.find((r: any) => String(r.key).startsWith("online-op:"));
    expect(JSON.parse(opRow.value)).toMatchObject({ status: "unresolved", name: "pay_supplier_lump_sum", orgId: st.ids.org });

    // (1) the app shell's export button is reachable with an empty queue
    const exportVia = async (open: () => Promise<void>, file: string) => {
      await open();
      await T.page.getByTestId("queue-export-passphrase").fill(PASS);
      await T.page.getByTestId("queue-export-passphrase-confirm").fill(PASS);
      const dl = T.page.waitForEvent("download", { timeout: 60_000 });
      await T.page.getByTestId("queue-export-submit").click();
      await (await dl).saveAs(file);
      await T.page.getByTestId("queue-export-close").click();
      return decryptQueueExport(readFileSync(file, "utf8"), PASS);
    };
    const f1 = profile("m086-6") + "-shell.spqx";
    const shell = await exportVia(() => T.page.getByTestId("export-queue-open").click(), f1);
    expect(shell.entries).toHaveLength(0);
    expect(shell.onlineOperations).toHaveLength(1);
    expect(shell.onlineOperations[0]).toMatchObject({ idempotencyKey: key, name: "pay_supplier_lump_sum", userId: st.ids.mgr, orgId: st.ids.org, blocksReplacement: true });
    expect(shell.onlineOperations[0].backendOrigin).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
    expect(shell.session).toMatchObject({ userId: st.ids.mgr, orgId: st.ids.org });
    // the export is recorded DURABLY on the till (an entry queued before it can no longer prove it was never sent)
    expect((await idbSnapshot(T)).syncState.some((r: any) => r.key === "queue-export:last-at" && typeof r.value === "string")).toBe(true);
    // inspect shows it and is NOT clean (exit 4)
    let inspectOut = ""; let inspectExit = 0;
    try { inspectOut = execFileSync("npx", ["tsx", "tools/queue-recovery/cli.ts", "inspect", f1], { cwd: process.cwd(), env: { ...process.env, QUEUE_RECOVERY_PASSPHRASE: PASS }, encoding: "utf8" }); }
    catch (e: any) { inspectOut = String(e.stdout ?? ""); inspectExit = e.status; }
    expect(inspectExit).toBe(4);
    expect(inspectOut).toMatch(/NOT CLEAN/);
    expect(inspectOut).toContain(key.slice(0, 8));

    // (2) the Sync page (and its Unresolved operations section) is ADMIN-only (audit:view_global):
    //     a manager is redirected away — recorded as a finding; the ADMIN checks below
    await T.navigate("/app/admin/sync-conflicts");
    await expect.poll(() => T.currentRoute(), { timeout: 20_000 }).not.toMatch(/sync-conflicts/);   // redirected away (dashboard / POS)
    await expect(T.page.getByTestId("sync-export-open")).toHaveCount(0);

    // (3) signed out: the sign-in screen offers the export
    await T.logout();
    await expect(T.page.getByTestId("login-online-ops-export")).toBeVisible({ timeout: 30_000 });
    const f2 = profile("m086-6") + "-login.spqx";
    const login = await exportVia(() => T.page.getByTestId("login-online-ops-export").getByRole("button").click(), f2);
    expect(login.onlineOperations.map((o: any) => o.idempotencyKey)).toEqual([key]);
    expect(pays()).toBe(p0 + 1);

    // (4) the server answers again: Check settles it from the stored outcome — nothing resent
    await T.page.unroute(RPC("op_status"));
    await T.page.unroute(RPC("op_execute"));
    await T.loginAdminWithTotp(st.emails.admin, pw, qaTotpSecret());     // an ADMIN of the same organisation, same till (TOTP)
    await T.waitForApp();
    const execBefore = T.rpcBodies.filter((b) => b.name === "op_execute").length;
    await T.navigate("/app/admin/sync-conflicts");
    await expect(T.page.getByTestId("sync-export-open")).toBeEnabled({ timeout: 20_000 });   // enabled with ONLY the payment
    await T.page.getByRole("button", { name: "Check status" }).first().click();
    await expect(T.page.getByTestId("online-ops-unresolved")).toBeHidden({ timeout: 30_000 });
    expect(T.rpcBodies.filter((b) => b.name === "op_execute").length).toBe(execBefore);
    const after = JSON.parse((await idbSnapshot(T)).syncState.find((r: any) => r.key === opRow.key).value);
    expect(after).toMatchObject({ status: "settled", outcome: "applied", decidedBy: "server" });
    expect(pays()).toBe(p0 + 1);                                                         // ONE row, ever
    expect(paidOnPo()).toBe(paid0 + 1500);                                               // the balance moved once
    expect(ledger(key)).toBe("committed/");
    note("M6", { queue: 0, unresolvedPayments: 1, shellExport: "1 online op, org+backend+actor", inspect: "exit 4 NOT CLEAN", loginExport: "same key", syncPage: "manager redirected (ADMIN-only); ADMIN: export enabled", check: "ADMIN Check: settled applied/server, nothing resent", supplierPayments: "+1 exactly", poPaid: "+1500 once" });
  } finally {
    await T.close();
  }
});

// ===================== DEPLOYMENT-BLOCKER PASS (after 9d37787) =====================
/** A received PO for the QA supplier (an outstanding balance of `qty` x 1000). */
async function outstandingPo(qty: number, note: string): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const admin = await signedInClient(liveCfg(), st.emails.admin, pw);
  const mgr = await signedInClient(liveCfg(), st.emails.mgr, pw);
  const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: st.ids.sup, p_notes: note, p_items: [{ product_id: st.ids.prod3, ordered_qty: qty, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
  const poId = (po.data as any).purchaseOrder.id;
  expect((await mgr.rpc("approve_purchase_order", { p_purchase_order_id: poId, p_idempotency_key: randomUUID() })).error).toBeNull();
  expect((await mgr.rpc("receive_purchase_order", { p_purchase_order_id: poId, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID() })).error).toBeNull();
  return poId;
}
const supplierPayments = () => Number(runSql(`SELECT count(*) FROM supplier_payments WHERE supplier_id = '${st.ids.sup}';`).trim());
async function paySupplier(T: Terminal, amountMmk: number): Promise<void> {
  await T.navigate(`/app/suppliers/${st.ids.sup}`);
  await T.page.getByRole("button", { name: "Pay supplier" }).click();
  const modal = T.page.locator(".fixed.inset-0.z-50");
  const amount = modal.locator('input[inputmode="numeric"]').first();
  await expect.poll(async () => (await amount.inputValue()).replace(/[^\d]/g, ""), { timeout: 10_000 }).not.toBe("");
  for (let i = 0; i < 5; i++) { await amount.fill(String(amountMmk)); await T.page.waitForTimeout(500); if ((await amount.inputValue()).replace(/[^\d]/g, "") === String(amountMmk)) break; }
  await modal.getByRole("button", { name: "Record payment" }).click();
}

test("M7 MANAGER own scope: the badge opens 'My unresolved operations' (own payment only, Check — no Verify); Check settles it from the server, nothing resent — ONE supplier_payments row", async () => {
  test.setTimeout(300_000);
  await outstandingPo(3, "m086-M7");
  const p0 = supplierPayments();
  rmSync(profile("m086-7"), { recursive: true, force: true });
  const T = await Terminal.launchPersistent(profile("m086-7"));
  try {
    await T.signIn(st.emails.mgr, pw, "/app");
    await T.waitForApp();
    let key = "";
    await T.page.route(RPC("op_execute"), async (route: Route) => {
      key = (route.request().postDataJSON() as any).p_key;
      await route.fetch().catch(() => null);
      await route.abort("failed");
    });
    await T.page.route(RPC("op_status"), (route: Route) => route.abort("failed"));
    await paySupplier(T, 1200);
    await expect(T.page.getByTestId("online-ops-unresolved")).toBeVisible({ timeout: 60_000 });
    expect(supplierPayments()).toBe(p0 + 1);
    await T.page.unroute(RPC("op_status"));
    await T.page.unroute(RPC("op_execute"));
    await T.page.getByTestId("online-ops-unresolved").click();
    await T.waitForRoute("/app/sync/unresolved");
    const section = T.page.getByTestId("unresolved-section-own");
    await expect(section.getByTestId("unresolved-row")).toHaveCount(1);
    await expect(section.getByRole("button", { name: "Mark verified" })).toHaveCount(0);   // owner action: not offered
    const execBefore = T.rpcBodies.filter((b) => b.name === "op_execute").length;
    await section.getByRole("button", { name: "Check status" }).click();
    await expect(section.getByTestId("unresolved-row")).toHaveCount(0, { timeout: 30_000 });
    expect(T.rpcBodies.filter((b) => b.name === "op_execute").length).toBe(execBefore);   // nothing resent
    expect(T.rpcBodies.filter((b) => b.name === "op_status").every((b) => (b.body as any)?.p_fence === false)).toBe(true);   // a lookup, never a fence
    expect(supplierPayments()).toBe(p0 + 1);
    expect(ledger(key)).toBe("committed/");
    note("M7", { badge: "-> /app/sync/unresolved", ownRows: 1, verifyOffered: false, check: "read-only lookup, settled applied", resent: 0, supplierPayments: "+1 exactly" });
  } finally {
    await T.close();
  }
});

test("M8 an UNREADABLE payment record on the till: warned, the same payment cannot be entered again (no new row), the export is format 3 with the raw record", async () => {
  test.setTimeout(300_000);
  const { decryptQueueExport } = await import("../src/lib/queueExport/format");
  await outstandingPo(3, "m086-M8");
  const p0 = supplierPayments();
  rmSync(profile("m086-8"), { recursive: true, force: true });
  const T = await Terminal.launchPersistent(profile("m086-8"));
  try {
    await T.signIn(st.emails.mgr, pw, "/app");
    await T.waitForApp();
    // a damaged record (as left by a crash mid-write or a newer build)
    await T.page.evaluate(() => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("shwe-phala-local");
      open.onsuccess = () => {
        const tx = open.result.transaction("syncState", "readwrite");
        tx.objectStore("syncState").put({ key: "online-op:op-damaged", value: "{\"v\":2,\"id\":\"op-damaged\",\"name\":\"pay_supplier_lump_sum\",\"sco", updatedAt: new Date().toISOString() });
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => { open.result.close(); reject(tx.error); };
      };
      open.onerror = () => reject(open.error);
    }));
    await expect(T.page.getByTestId("online-ops-unreadable")).toBeVisible({ timeout: 30_000 });
    await paySupplier(T, 1000);
    await expect(T.page.getByText(/cannot read/).first()).toBeVisible({ timeout: 20_000 });
    await T.page.waitForTimeout(2000);
    expect(supplierPayments()).toBe(p0);                                       // nothing sent
    expect(T.rpcBodies.filter((b) => b.name === "op_execute")).toHaveLength(0);
    // export: format 3, the raw record verbatim
    const file = profile("m086-8") + "-unreadable.spqx";
    await T.page.getByTestId("export-queue-open").click();
    await T.page.getByTestId("queue-export-passphrase").fill("m086-unreadable-export");
    await T.page.getByTestId("queue-export-passphrase-confirm").fill("m086-unreadable-export");
    const dl = T.page.waitForEvent("download", { timeout: 60_000 });
    await T.page.getByTestId("queue-export-submit").click();
    await (await dl).saveAs(file);
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text).formatVersion).toBe(3);
    const payload = await decryptQueueExport(text, "m086-unreadable-export");
    expect(payload.unreadableOnlineRecords.map((r: any) => r.raw)).toEqual(["{\"v\":2,\"id\":\"op-damaged\",\"name\":\"pay_supplier_lump_sum\",\"sco"]);
    note("M8", { warning: "shown", entry: "blocked, nothing sent", supplierPayments: "unchanged", export: "format 3, raw record verbatim" });
  } finally {
    await T.close();
  }
});
