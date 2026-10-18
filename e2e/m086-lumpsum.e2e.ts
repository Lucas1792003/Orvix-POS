/* eslint-disable @typescript-eslint/no-explicit-any */
// MIGRATION 086 (tools/m086-verify) — lump-sum supplier payment REFUSALS in real Chromium
// against the disposable loopback stack. Owner decision: a definitive
// insufficient-balance refusal is FINAL — the cashier is told it was NOT
// recorded, the balance is re-checked with the server, and only an explicit
// confirmation sends a NEW payment (new key). The refused key is never sent
// again: not by the other window, not after a delayed receipt raises the
// balance, not after a crash + restart. Asserted in the UI, the till's
// IndexedDB and PostgreSQL.
import { test, expect, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { Terminal } from "./helpers/terminal";
import { runSql } from "./helpers/db";
import { liveCfg } from "./helpers/env";
import { signedInClient } from "../src/live/liveHelpers";
import { RPC, idbAll, profile, st, pw } from "./m086-helpers";

test.describe.configure({ mode: "serial" });
test.skip(process.env.M086_LIVE !== "1", "migration 086 verification: run via tools/m086-verify/run.sh");
if (process.env.M086_LIVE === "1" && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("M086_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run tools/m086-verify/run.sh)");
}
const evidence: Record<string, unknown> = {};
const note = (id: string, v: unknown) => { evidence[id] = v; console.log(`[m086] ${id} ${JSON.stringify(v)}`); };
test.afterAll(() => {
  const f = process.env.M086_E2E_EVIDENCE;
  writeFileSync(f ? f.replace(/\.json$/, "-lumpsum.json") : "/dev/null", JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
});

const ledger = (key: string) => runSql(`SELECT coalesce((SELECT state || '/' || coalesce(outcome_code, '') FROM idempotency_keys WHERE key = '${key}'::uuid), '<none>');`).trim();
const payments = (sup: string) => runSql(`SELECT count(*) || ':' || coalesce(sum(amount_mmk), 0) FROM supplier_payments WHERE supplier_id = '${sup}' AND voided_at IS NULL;`).trim();
const onlineOps = async (T: Terminal) => (await idbAll(T, "syncState"))
  .filter((r: any) => typeof r.key === "string" && r.key.startsWith("online-op:"))
  .map((r: any) => { try { return JSON.parse(r.value); } catch { return { unreadable: r.key }; } });
const sentKeys = (T: Terminal) => T.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_rpc === "pay_supplier_lump_sum").map((b) => (b.body as any).p_key as string);

test("M-LS a refused lump sum is final: NOT recorded, balance re-checked, a NEW payment only on explicit confirmation; never re-sent (other window, delayed receipt, restart)", async () => {
  // ---- fixture: a supplier with two received POs (3,000 + 2,000 due) -----------------------
  const cfg = liveCfg();
  const admin = await signedInClient(cfg, st.emails.admin, pw);
  const mgr = await signedInClient(cfg, st.emails.mgr, pw);
  const code = `LS${Date.now()}`;
  const s = await admin.rpc("create_supplier", { p_code: code, p_name: `m086 lump ${code}`, p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_idempotency_key: randomUUID() });
  expect(s.error).toBeNull();
  const sup: string = (s.data as any).supplier?.id ?? (s.data as any).id;
  const receivedPo = async (total: number) => {
    const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: sup, p_notes: "m086 lump", p_items: [{ product_id: st.ids.prod2, ordered_qty: total / 1000, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
    expect(po.error).toBeNull();
    const id = (po.data as any).purchaseOrder.id;
    expect((await mgr.rpc("approve_purchase_order", { p_purchase_order_id: id, p_idempotency_key: randomUUID() })).error).toBeNull();
    expect((await mgr.rpc("receive_purchase_order", { p_purchase_order_id: id, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID() })).error).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    return id;
  };
  await receivedPo(3000);
  await receivedPo(2000);
  const paidPos = () => runSql(`SELECT string_agg(paid_mmk::text, ',' ORDER BY created_at, id) FROM purchase_orders WHERE supplier_id = '${sup}';`).trim();
  expect(payments(sup)).toBe("0:0");

  // ---- one till, two windows (same profile: one IndexedDB), the manager signed in -----------
  rmSync(profile("m086-ls"), { recursive: true, force: true });
  let A = await Terminal.launchPersistent(profile("m086-ls"));
  try {
    await A.signIn(st.emails.mgr, pw, "/app");
    await A.waitForApp();
    const B = await A.openTab();
    await B.goto(`/app/suppliers/${sup}`);
    await A.goto(`/app/suppliers/${sup}`);
    const openModal = async (T: Terminal) => {
      await T.page.getByRole("button", { name: "Pay supplier" }).click();
      const dlg = T.page.locator(".fixed.inset-0.z-50");          // the app's Modal overlay (no dialog role)
      await expect(dlg.getByText("Total outstanding")).toBeVisible();
      return dlg;
    };
    const dlgB = await openModal(B);
    await expect(dlgB).toContainText("MMK 5,000");
    await dlgB.getByRole("button", { name: "Pay all" }).click();

    // B's request is held at the network; meanwhile ANOTHER device pays 2,000 of it
    let refusedKey = "";
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await B.page.route(RPC("op_execute"), async (route: Route) => {
      const body = route.request().postDataJSON() as any;
      if (body?.p_rpc === "pay_supplier_lump_sum" && !refusedKey) {
        refusedKey = body.p_key;
        await held;
      }
      await route.continue();
    });
    await dlgB.getByRole("button", { name: "Record payment" }).click();
    await expect.poll(() => refusedKey !== "", { timeout: 20_000 }).toBe(true);
    const other = await mgr.rpc("pay_supplier_lump_sum", { p_supplier_id: sup, p_shop_id: st.ids.shop, p_amount_mmk: 2000, p_payment_method: "CASH", p_reference_no: null, p_notes: "other device", p_idempotency_key: randomUUID() });
    expect(other.error).toBeNull();
    release();

    // ---- the refusal: told NOT recorded; balance re-checked; nothing sendable until confirmed --
    const alert = dlgB.getByRole("alert");
    await expect(alert).toContainText("Payment NOT recorded");
    await expect(alert).toContainText("Nothing was recorded, and this attempt will not be sent again.");
    await expect(alert).toContainText("Current balance from the server: MMK 3,000", { timeout: 30_000 });
    expect(payments(sup)).toBe("1:2000");                       // only the other device's payment
    expect(ledger(refusedKey)).toMatch(/^rejected\//);           // the refusal is recorded on the server
    const record = (await onlineOps(B)).find((o: any) => o.args?.p_idempotency_key === refusedKey);
    expect(record).toMatchObject({ status: "settled", outcome: "refused" });
    await expect(dlgB.getByRole("button", { name: "Record payment" })).toBeDisabled();   // amount cleared (0), not confirmed
    expect((await dlgB.locator('input[inputmode="numeric"]').first().inputValue()).replace(/[^\d]/g, "")).toBe("0");
    // the other window of this till: nothing pending, nothing to retry
    expect((await onlineOps(A)).filter((o: any) => o.status === "unresolved")).toHaveLength(0);

    // ---- closing and re-opening does NOT clear the refusal (here and in the other window) ------
    await dlgB.getByRole("button", { name: "Cancel" }).click();
    await expect(dlgB).toHaveCount(0);
    const dlgB2 = await openModal(B);
    await expect(dlgB2.getByRole("alert")).toContainText("Payment NOT recorded");
    await expect(dlgB2.getByRole("alert")).toContainText("Current balance from the server: MMK 3,000", { timeout: 30_000 });
    const submit = dlgB2.getByRole("button", { name: "Record payment" });
    await expect(submit).toBeDisabled();
    const amountB = dlgB2.locator('input[inputmode="numeric"]').first();
    expect((await amountB.inputValue()).replace(/[^\d]/g, "")).toBe("0");   // never filled in for the cashier
    const dlgA = await openModal(A);
    await expect(dlgA.getByRole("alert")).toContainText("Payment NOT recorded");
    await expect(dlgA.getByRole("button", { name: "Record payment" })).toBeDisabled();
    await dlgA.getByRole("button", { name: "Cancel" }).click();

    // ---- a NEW payment only on explicit confirmation, with a NEW key ---------------------------
    for (let i = 0; i < 5; i++) { await amountB.fill("1000"); await B.page.waitForTimeout(500); if ((await amountB.inputValue()).replace(/[^\d]/g, "") === "1000") break; }
    await expect(submit).toBeDisabled();                         // still not confirmed
    await dlgB2.getByLabel("I checked the current balance. Record this as a NEW payment.").check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => payments(sup), { timeout: 30_000 }).toBe("2:3000");
    const keysB = sentKeys(B);
    const newKey = keysB.find((k) => k !== refusedKey)!;
    expect(newKey).toBeTruthy();
    expect(ledger(newKey)).toBe("committed/");
    expect(keysB.filter((k) => k === refusedKey)).toHaveLength(1);   // the refused key: sent once, never again
    expect(paidPos()).toBe("3000,0");                            // oldest first: 2,000 + 1,000 settle the 3,000 PO
    // the new payment cleared the refusal: the dialog opens normally again
    const dlgA2 = await openModal(A);
    await expect(dlgA2.getByRole("button", { name: "Record payment" })).toBeEnabled({ timeout: 10_000 });
    await expect(dlgA2.getByRole("alert")).toHaveCount(0);
    await dlgA2.getByRole("button", { name: "Cancel" }).click();

    // ---- a delayed receipt raises the balance: the refused payment never executes -------------
    await receivedPo(4000);
    await A.reload();
    await A.goto(`/app/suppliers/${sup}`);
    await new Promise((r) => setTimeout(r, 5000));
    expect(payments(sup)).toBe("2:3000");
    expect(ledger(refusedKey)).toMatch(/^rejected\//);
    expect(sentKeys(A).filter((k) => k === refusedKey)).toHaveLength(0);

    // ---- crash + restart: still final, still never sent ----------------------------------------
    await A.crash();
    A = await Terminal.launchPersistent(profile("m086-ls"));
    await A.goto(`/app/suppliers/${sup}`);
    await Promise.race([
      A.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 30_000 }),
      A.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 30_000 }),
    ]);
    if (await A.page.locator('input[type="email"]').isVisible()) {
      await A.signIn(st.emails.mgr, pw, "/app");
      await A.goto(`/app/suppliers/${sup}`);
    }
    await A.waitForApp();
    await new Promise((r) => setTimeout(r, 5000));
    expect(sentKeys(A).filter((k) => k === refusedKey)).toHaveLength(0);
    expect(payments(sup)).toBe("2:3000");
    expect(ledger(refusedKey)).toMatch(/^rejected\//);
    const after = (await onlineOps(A)).find((o: any) => o.args?.p_idempotency_key === refusedKey);
    expect(after).toMatchObject({ status: "settled", outcome: "refused" });
    expect((await onlineOps(A)).filter((o: any) => o.status === "unresolved")).toHaveLength(0);
    note("M-LS", {
      refusal: "UI: Payment NOT recorded; balance re-checked from the server (MMK 3,000)",
      server: `refused key ${ledger(refusedKey)}; payments ${payments(sup)} (other device 2,000 + new 1,000)`,
      till: "refused record settled/refused in IndexedDB, before and after restart; 0 unresolved",
      newPayment: "only after explicit confirmation; new key committed; per-PO paid 3000,0",
      reopen: "close + re-open, and the other window, start from the refusal until a new payment is recorded",
      refusedKeySent: "once (never again: other window, delayed receipt, restart)",
    });
  } finally {
    await A.close().catch(() => undefined);
  }
});

test("M-LU a lump sum COMMITTED with its reply lost (then purged) is never 'failed': status unknown, every payment entry blocked (re-open, single-PO dialog, other window, restart) until the server answers for its key -> 'Payment recorded'; one payment, no new key", async () => {
  test.setTimeout(300_000);
  const cfg = liveCfg();
  const admin = await signedInClient(cfg, st.emails.admin, pw);
  const mgr = await signedInClient(cfg, st.emails.mgr, pw);
  const code = `LU${Date.now()}`;
  const s = await admin.rpc("create_supplier", { p_code: code, p_name: `m086 unknown ${code}`, p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_idempotency_key: randomUUID() });
  expect(s.error).toBeNull();
  const sup: string = (s.data as any).supplier?.id ?? (s.data as any).id;
  for (const total of [3000, 2000]) {
    const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: sup, p_notes: "m086 unknown", p_items: [{ product_id: st.ids.prod2, ordered_qty: total / 1000, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
    expect(po.error).toBeNull();
    const id = (po.data as any).purchaseOrder.id;
    expect((await mgr.rpc("approve_purchase_order", { p_purchase_order_id: id, p_idempotency_key: randomUUID() })).error).toBeNull();
    expect((await mgr.rpc("receive_purchase_order", { p_purchase_order_id: id, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID() })).error).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
  }
  const paidPos = () => runSql(`SELECT string_agg(paid_mmk::text, ',' ORDER BY created_at, id) FROM purchase_orders WHERE supplier_id = '${sup}';`).trim();
  const dlgOf = (T: Terminal) => T.page.locator(".fixed.inset-0.z-50").filter({ hasText: "Total outstanding" });
  const openLump = async (T: Terminal) => {
    await T.page.getByRole("button", { name: "Pay supplier" }).click();
    await expect(dlgOf(T)).toBeVisible();
    return dlgOf(T);
  };
  const unknownShown = async (T: Terminal) => {
    const d = await openLump(T);
    await expect(d.getByTestId("lump-unknown")).toContainText("Payment status unknown");
    await expect(d.getByTestId("lump-unknown")).toContainText("MMK 1,000");
    await expect(d.getByRole("button", { name: "Record payment" })).toBeDisabled();
    return d;
  };

  rmSync(profile("m086-lu"), { recursive: true, force: true });
  let A = await Terminal.launchPersistent(profile("m086-lu"));
  try {
    await A.signIn(st.emails.mgr, pw, "/app");
    await A.waitForApp();
    await A.goto(`/app/suppliers/${sup}`);

    // ---- the payment commits; its reply never arrives; the server then stays unreachable --------
    let key = "";
    await A.page.route(RPC("op_execute"), async (route: Route) => {
      const b = route.request().postDataJSON() as any;
      if (b?.p_rpc === "pay_supplier_lump_sum" && !key) { key = b.p_key; await route.fetch().catch(() => null); }
      await route.abort("failed");
    });
    await A.page.route(RPC("op_status"), (route: Route) => route.abort("failed"));
    const d0 = await openLump(A);
    const amt = d0.locator('input[inputmode="numeric"]').first();
    for (let i = 0; i < 5; i++) { await amt.fill("1000"); await A.page.waitForTimeout(400); if ((await amt.inputValue()).replace(/[^\d]/g, "") === "1000") break; }
    await d0.getByRole("button", { name: "Record payment" }).click();
    // never "failed": the dialog stays, says the status is unknown, and blocks a new payment
    await expect(d0.getByTestId("lump-unknown")).toContainText("Payment status unknown", { timeout: 60_000 });
    await expect(d0.getByRole("button", { name: "Record payment" })).toBeDisabled();
    expect(await A.toastsNow()).not.toContain("Payment failed");
    expect(payments(sup)).toBe("1:1000");
    expect(ledger(key)).toBe("committed/");
    // the backend is unavailable: Check with server -> still unknown, still blocked
    await d0.getByRole("button", { name: "Check with server" }).click();
    await expect(d0.getByTestId("lump-unknown")).toContainText("Still unknown", { timeout: 30_000 });
    await expect(d0.getByRole("button", { name: "Record payment" })).toBeDisabled();

    // ---- its stored reply is purged (as op_purge_responses does after 90 days) ---------------------
    runSql(`UPDATE idempotency_keys SET response = NULL, response_purged_at = clock_timestamp() WHERE key = '${key}'::uuid;`);
    // close + re-open: still unknown, still blocked, never refilled into a sendable payment
    await d0.getByRole("button", { name: "Cancel" }).click();
    await unknownShown(A);
    await dlgOf(A).getByRole("button", { name: "Cancel" }).click();
    // the other entry path: a single purchase-order payment is blocked as well
    await A.page.getByRole("button", { name: "Purchase Orders" }).click();
    await A.page.getByRole("button", { name: "Record payment" }).first().click();
    await expect(A.page.getByTestId("po-blocked-by-lump-sum")).toBeVisible();
    await expect(A.page.locator(".fixed.inset-0.z-50").getByRole("button", { name: "Record payment" })).toBeDisabled();
    await A.page.keyboard.press("Escape");
    // another window of the till: blocked too
    const B = await A.openTab();
    await B.goto(`/app/suppliers/${sup}`);
    await unknownShown(B);

    // every lump-sum key this till sent before the crash: only the one payment's key
    const keysBeforeCrash = new Set([...A.rpcBodies, ...B.rpcBodies].filter((b) => b.name === "op_execute" && (b.body as any)?.p_rpc === "pay_supplier_lump_sum").map((b) => (b.body as any).p_key));
    expect([...keysBeforeCrash]).toEqual([key]);

    // ---- crash + restart (the server reachable again): still unknown until the server is asked -----
    await A.crash();
    A = await Terminal.launchPersistent(profile("m086-lu"));
    await A.goto(`/app/suppliers/${sup}`);
    await Promise.race([
      A.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 30_000 }),
      A.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 30_000 }),
    ]);
    if (await A.page.locator('input[type="email"]').isVisible()) {
      await A.signIn(st.emails.mgr, pw, "/app");
      await A.goto(`/app/suppliers/${sup}`);
    }
    await A.waitForApp();
    const d1 = await unknownShown(A);
    const sentBefore = A.rpcBodies.filter((b) => b.name === "op_execute").length;
    await d1.getByRole("button", { name: "Check with server" }).click();
    // the server's own answer for the key: committed (reply purged) -> "Payment recorded"
    await A.toast(/Payment recorded/, 30_000);
    await expect(dlgOf(A)).toHaveCount(0);
    expect(A.rpcBodies.filter((b) => b.name === "op_execute").length).toBe(sentBefore);   // a lookup: nothing sent
    expect(A.rpcBodies.some((b) => b.name === "op_status" && (b.body as any)?.p_key === key && (b.body as any)?.p_fence === false)).toBe(true);

    // ---- PostgreSQL: ONE payment of 1,000, the oldest PO, the ledger committed, no other key ----------
    expect(payments(sup)).toBe("1:1000");
    expect(paidPos()).toBe("1000,0");
    expect(ledger(key)).toBe("committed/");
    expect(A.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_rpc === "pay_supplier_lump_sum")).toHaveLength(0);   // after the restart: none sent
    const rec = (await onlineOps(A)).find((o: any) => o.args?.p_idempotency_key === key);
    expect(rec).toMatchObject({ status: "settled", outcome: "applied" });
    // the dialog opens normally with the server's balance (reloaded), nothing pending
    const d2 = await openLump(A);
    await expect(d2).toContainText("MMK 4,000", { timeout: 30_000 });
    await expect(d2.getByTestId("lump-unknown")).toHaveCount(0);

    // ---- a DELAYED reply (inside the request timeout) is simply recorded ----------------------------
    await A.page.route(RPC("op_execute"), async (route: Route) => {
      const res = await route.fetch();
      await new Promise((r) => setTimeout(r, 5000));
      await route.fulfill({ response: res });
    });
    const amt2 = d2.locator('input[inputmode="numeric"]').first();
    for (let i = 0; i < 5; i++) { await amt2.fill("500"); await A.page.waitForTimeout(400); if ((await amt2.inputValue()).replace(/[^\d]/g, "") === "500") break; }
    await d2.getByRole("button", { name: "Record payment" }).click();
    await A.toast(/Payment recorded/, 30_000);
    expect(payments(sup)).toBe("2:1500");
    expect(paidPos()).toBe("1500,0");
    note("M-LU", {
      lostReply: "dialog stays: 'Payment status unknown', Record payment disabled (never 'Payment failed')",
      unavailable: "Check with server -> 'Still unknown', still blocked",
      blockedPaths: "close + re-open, single-PO dialog, second window, crash + restart",
      resolved: "Check with server (op_status, no fence, nothing sent) -> committed, reply purged -> 'Payment recorded'",
      postgres: "1 payment of 1,000 (then +500 delayed-reply payment); per-PO 1000,0 then 1500,0; ledger committed; one key",
    });
    await B.close().catch(() => undefined);
  } finally {
    await A.close().catch(() => undefined);
  }
});

// shared fixture for the next two tests: a supplier with POs of 3,000 and 2,000 (received)
async function supplierWith(prefix: string): Promise<{ sup: string; pos: string[] }> {
  const cfg = liveCfg();
  const admin = await signedInClient(cfg, st.emails.admin, pw);
  const mgr = await signedInClient(cfg, st.emails.mgr, pw);
  const code = `${prefix}${Date.now()}`;
  const s = await admin.rpc("create_supplier", { p_code: code, p_name: `m086 ${prefix} ${code}`, p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_idempotency_key: randomUUID() });
  expect(s.error).toBeNull();
  const sup: string = (s.data as any).supplier?.id ?? (s.data as any).id;
  const pos: string[] = [];
  for (const total of [3000, 2000]) {
    const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: sup, p_notes: prefix, p_items: [{ product_id: st.ids.prod2, ordered_qty: total / 1000, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
    expect(po.error).toBeNull();
    const id = (po.data as any).purchaseOrder.id;
    expect((await mgr.rpc("approve_purchase_order", { p_purchase_order_id: id, p_idempotency_key: randomUUID() })).error).toBeNull();
    expect((await mgr.rpc("receive_purchase_order", { p_purchase_order_id: id, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID() })).error).toBeNull();
    pos.push(id);
    await new Promise((r) => setTimeout(r, 5));
  }
  return { sup, pos };
}
const paidOf = (sup: string) => runSql(`SELECT string_agg(paid_mmk::text, ',' ORDER BY created_at, id) FROM purchase_orders WHERE supplier_id = '${sup}';`).trim();

test("M-LU2 'Send the same payment again': the unknown lump sum is resent with ITS key (the server replays it, never twice) -> 'Payment recorded'", async () => {
  test.setTimeout(240_000);
  const { sup } = await supplierWith("LV");
  rmSync(profile("m086-lu2"), { recursive: true, force: true });
  const T = await Terminal.launchPersistent(profile("m086-lu2"));
  try {
    await T.signIn(st.emails.mgr, pw, "/app");
    await T.waitForApp();
    await T.goto(`/app/suppliers/${sup}`);
    let key = "";
    await T.page.route(RPC("op_execute"), async (route: Route) => {
      const b = route.request().postDataJSON() as any;
      if (b?.p_rpc === "pay_supplier_lump_sum" && !key) { key = b.p_key; await route.fetch().catch(() => null); }
      await route.abort("failed");
    });
    await T.page.route(RPC("op_status"), (route: Route) => route.abort("failed"));
    await T.page.getByRole("button", { name: "Pay supplier" }).click();
    const dlg = T.page.locator(".fixed.inset-0.z-50").filter({ hasText: "Total outstanding" });
    const amt = dlg.locator('input[inputmode="numeric"]').first();
    for (let i = 0; i < 5; i++) { await amt.fill("1200"); await T.page.waitForTimeout(400); if ((await amt.inputValue()).replace(/[^\d]/g, "") === "1200") break; }
    await dlg.getByRole("button", { name: "Record payment" }).click();
    await expect(dlg.getByTestId("lump-unknown")).toContainText("Payment status unknown", { timeout: 60_000 });
    expect(payments(sup)).toBe("1:1200");
    await T.page.unroute(RPC("op_execute"));
    await T.page.unroute(RPC("op_status"));
    const sentBefore = T.rpcBodies.filter((b) => b.name === "op_execute").length;
    await dlg.getByRole("button", { name: "Send the same payment again (never applied twice)" }).click();
    await T.toast(/Payment recorded/, 30_000);
    await expect(dlg).toHaveCount(0);
    const resent = T.rpcBodies.filter((b) => b.name === "op_execute").slice(sentBefore);
    expect(resent.length).toBeGreaterThan(0);
    expect(resent.every((b) => (b.body as any)?.p_key === key)).toBe(true);             // ITS key, never a new one
    expect(payments(sup)).toBe("1:1200");                                                   // replayed, not executed twice
    expect(paidOf(sup)).toBe("1200,0");
    expect(ledger(key)).toBe("committed/");
    expect((await onlineOps(T)).find((o: any) => o.args?.p_idempotency_key === key)).toMatchObject({ status: "settled", outcome: "applied" });
    note("M-LU2", { resend: "same key (op_execute replay)", postgres: "1 payment of 1,200; per-PO 1200,0; ledger committed" });
  } finally {
    await T.close().catch(() => undefined);
  }
});

test("M-PO a single purchase-order payment whose reply is lost is never 'failed' and never refilled: it blocks both dialogs while in doubt; the queue confirms it ONCE", async () => {
  test.setTimeout(300_000);
  const { sup, pos } = await supplierWith("PQ");
  rmSync(profile("m086-po"), { recursive: true, force: true });
  let T = await Terminal.launchPersistent(profile("m086-po"));
  try {
    await T.signIn(st.emails.mgr, pw, "/app");
    await T.waitForApp();
    await T.goto(`/app/suppliers/${sup}`);
    let key = "";
    await T.page.route(RPC("op_execute"), async (route: Route) => {
      const b = route.request().postDataJSON() as any;
      if (b?.p_rpc === "record_supplier_payment" && !key) { key = b.p_key; await route.fetch().catch(() => null); }
      await route.abort("failed");
    });
    await T.page.route(RPC("op_status"), (route: Route) => route.abort("failed"));
    await T.page.route(RPC("record_supplier_payment"), (route: Route) => route.abort("failed"));
    await T.page.getByRole("button", { name: "Purchase Orders" }).click();
    await T.page.getByRole("button", { name: "Record payment" }).first().click();
    const poDlg = T.page.locator(".fixed.inset-0.z-50");
    const amt = poDlg.locator('input[inputmode="numeric"]').first();
    for (let i = 0; i < 5; i++) { await amt.fill("800"); await T.page.waitForTimeout(400); if ((await amt.inputValue()).replace(/[^\d]/g, "") === "800") break; }
    await poDlg.getByRole("button", { name: "Record payment" }).click();
    await expect.poll(() => key !== "", { timeout: 30_000 }).toBe(true);
    await expect(poDlg).toHaveCount(0, { timeout: 60_000 });                     // closed: never a filled form after an unknown outcome
    const toasts = await T.toastsNow();
    expect(toasts.join(" ")).not.toMatch(/Payment failed/);
    expect(payments(sup)).toBe("1:800");
    expect(ledger(key)).toBe("committed/");
    // re-opened: this PO's payment is blocked while the earlier one is in doubt
    await T.page.getByRole("button", { name: "Record payment" }).first().click();
    await expect(T.page.getByTestId("po-payment-unknown")).toBeVisible({ timeout: 20_000 });
    await expect(poDlg.getByRole("button", { name: "Record payment" })).toBeDisabled();
    await T.page.keyboard.press("Escape");
    // and a lump sum to the same supplier and shop is blocked as well
    await T.page.getByRole("button", { name: "Pay supplier" }).click();
    const lump = T.page.locator(".fixed.inset-0.z-50").filter({ hasText: "Total outstanding" });
    await expect(lump.getByTestId("lump-blocked-by-po")).toBeVisible({ timeout: 20_000 });
    await expect(lump.getByRole("button", { name: "Record payment" })).toBeDisabled();
    // the server reachable again (a restart): the queue confirms the earlier payment by ITS key, once
    await T.close();
    T = await Terminal.launchPersistent(profile("m086-po"));
    await T.goto(`/app/suppliers/${sup}`);
    await Promise.race([
      T.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 30_000 }),
      T.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 30_000 }),
    ]);
    if (await T.page.locator('input[type="email"]').isVisible()) {
      await T.signIn(st.emails.mgr, pw, "/app");
      await T.goto(`/app/suppliers/${sup}`);
    }
    await T.waitForApp();
    await expect.poll(async () => (await idbAll(T, "syncOutbox")).filter((r: any) => r.name === "record_supplier_payment" && r.args?.p_purchase_order_id === pos[0]).length, { timeout: 90_000 }).toBe(0);
    expect(payments(sup)).toBe("1:800");                                          // once
    expect(paidOf(sup)).toBe("800,0");
    expect(T.rpcBodies.filter((b) => b.name === "op_execute" && (b.body as any)?.p_rpc === "record_supplier_payment" && (b.body as any)?.p_key !== key)).toHaveLength(0);
    note("M-PO", { lostReply: "dialog closed with a pending notice, never 'Payment failed'", blocked: "the PO dialog and the lump-sum dialog while in doubt", postgres: "1 payment of 800 once confirmed; per-PO 800,0; ledger committed" });
  } finally {
    await T.close().catch(() => undefined);
  }
});
