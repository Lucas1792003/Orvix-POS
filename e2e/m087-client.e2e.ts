/* eslint-disable @typescript-eslint/no-explicit-any */
// v87 CLIENT against MIGRATION 087 (tools/m087-client-verify/run.sh) — REAL Chromium (persistent profile: real
// on-disk IndexedDB, real crash + restart) and the REAL Electron app, on the disposable loopback stack with the
// committed 087 applied through the real runner and the real witness authority. Every outcome is asserted in the
// till's IndexedDB AND in PostgreSQL. Contract: docs/selfhost-migration/phase-g/migration-087.md ("Client contract").
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Terminal } from "./helpers/terminal";
import { runSql } from "./helpers/db";
import { PROJECT_ROOT, qaTotpSecret } from "./helpers/env";
import { P1, profile, serverSales, st, pw } from "./m086-helpers";

test.describe.configure({ mode: "serial" });
test.skip(process.env.M087_CLIENT_LIVE !== "1", "v87 client verification: run via tools/m087-client-verify/run.sh");
if (process.env.M087_CLIENT_LIVE === "1" && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("M087_CLIENT_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run tools/m087-client-verify/run.sh)");
}
const OUT = process.env.M087_CLIENT_OUT ?? path.join(PROJECT_ROOT, "tools/m087-client-verify/results/adhoc");
const evidence: Record<string, unknown> = {};
const note = (id: string, v: unknown) => { evidence[id] = v; console.log(`[m087c] ${id} ${JSON.stringify(v)}`); };
const org = () => st.ids.org;
const sql1 = (q: string) => runSql(q).trim().split("\n").filter(Boolean).pop() ?? "";
const serverEpoch = () => sql1(`select epoch from recovery.org_state where org_id = '${org()}'`);
const ledger = (key: string) => sql1(`select coalesce((select state from idempotency_keys where key = '${key}'::uuid and org_id = '${org()}'), '<none>')`);

test.beforeAll(() => {
  const out = execFileSync("bash", [path.join(PROJECT_ROOT, "tools/m087-client-verify/install-087.sh"), OUT], { encoding: "utf8" });
  note("install", out.trim());
  expect(sql1("select state from recovery.continuity")).toBe("open");
});
test.afterAll(() => {
  writeFileSync(path.join(OUT, "e2e-evidence.json"), JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
});

// ---- helpers ------------------------------------------------------------------------------------------------
async function asCashier(T: Terminal): Promise<void> {
  await T.logout();
  await T.signIn(st.emails.cashA, pw, "/app");
  await T.waitForApp();
}
async function asAdmin(T: Terminal): Promise<void> {
  await T.logout();
  await T.loginAdminWithTotp(st.emails.admin, pw, qaTotpSecret());
  await T.waitForApp();
}
async function recoveryPage(T: Terminal): Promise<string> {
  await T.navigate("/app/sync/recovery");
  const state = T.page.getByTestId("recovery-state");
  await state.waitFor({ state: "visible" });
  return (await state.getAttribute("data-mode")) ?? "";
}
async function recoveryAction(T: Terminal, testId: string, expected: RegExp): Promise<string> {
  await T.page.getByTestId(testId).click();
  const msg = T.page.getByTestId("recovery-message");
  await expect(msg).toHaveText(expected, { timeout: 60_000 });
  return (await msg.innerText()).trim();
}
/** The same till after a (re)launch: if the stored session did not survive (a crash can lose it), the cashier signs in. */
async function reopen(name: string): Promise<Terminal> {
  const T = await Terminal.launchPersistent(profile(name));
  await T.goto("/app/pos");
  await Promise.race([
    T.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 60_000 }),
    T.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 60_000 }),
  ]);
  if (await T.page.locator('input[type="email"]').isVisible()) { note(`${name}.session-lost-on-restart`, true); await T.signIn(st.emails.cashA, pw, "/app"); }
  await T.waitForApp();
  return T;
}
/** Register (admin, TOTP) -> upload (cashier) -> approve (admin) -> verified (cashier). Ends signed in as the cashier. */
async function reconcileTill(T: Terminal, id: string, register: boolean): Promise<void> {
  if (register) {
    await asAdmin(T);
    expect(await recoveryPage(T)).toBe("till-unregistered");
    note(`${id}.register`, await recoveryAction(T, "recovery-register", /registered/));
  }
  await asCashier(T);
  expect(await recoveryPage(T)).toBe("not-reconciled");
  note(`${id}.upload`, await recoveryAction(T, "recovery-upload", /Journal uploaded/));
  await asAdmin(T);
  await recoveryPage(T);
  note(`${id}.approve`, await recoveryAction(T, "recovery-approve", /approved for epoch/));
  await asCashier(T);
  await recoveryPage(T);
  note(`${id}.verified`, await recoveryAction(T, "recovery-check", /verified this till/));
  expect(await recoveryPage(T)).toBe("normal");
}
/** A checkout that the till refuses with a recovery message (nothing saved). */
async function checkoutRefused(T: Terminal): Promise<string> {
  await T.page.keyboard.press("F2");
  const amount = T.page.getByLabel("Amount received");
  await amount.waitFor({ state: "visible" });
  await expect.poll(() => amount.inputValue(), { timeout: 5_000 }).toBe("0");
  await amount.fill("5000");
  await T.toastsNow();
  await amount.press("Enter");
  const toast = await T.toast(/Sale not recorded — server recovery/, 60_000);
  await T.page.keyboard.press("Escape");
  return toast;
}
const idbRecords = async (T: Terminal, prefix: string): Promise<any[]> =>
  (await T.syncState()).filter((r) => r.key.startsWith(prefix)).map((r: any) => ({ ...JSON.parse(r.value ?? "null"), rowKey: r.key }));
const modeRecord = async (T: Terminal) => (await idbRecords(T, "r87:mode:")).find((r) => r.rowKey.endsWith(`:${org()}`));

// ---- Chromium ------------------------------------------------------------------------------------------------
test("C1 a fresh till on an 087 server: blocked until the server verifies it; then a sale goes through op_execute_v87 with the server's epoch", async () => {
  rmSync(profile("m087c-1"), { recursive: true, force: true });
  const T = await Terminal.launchPersistent(profile("m087c-1"));
  try {
    await T.signIn(st.emails.cashA, pw, "/app");
    await T.waitForApp();
    await expect(T.page.getByTestId("recovery-banner")).toHaveAttribute("data-mode", "till-unregistered", { timeout: 60_000 });
    expect(await recoveryPage(T)).toBe("till-unregistered");
    // opening a shift is a financial operation too: refused before anything is saved or sent
    await T.navigate("/app/shifts");
    await T.page.locator("#opening-cash").fill("10000", { timeout: 30_000 });
    await T.toastsNow();
    await T.page.getByRole("button", { name: "Start shift", exact: true }).click();
    note("C1.shift-refused", await T.toast(/Till reconciliation required/, 30_000));
    expect(sql1(`select count(*) from shifts where cashier_id = '${st.ids.cashA}' and ended_at is null`)).toBe("0");
    expect(T.rpcBodies.filter((b) => b.name === "op_execute_v87" || b.name === "op_execute")).toHaveLength(0);
    await reconcileTill(T, "C1", true);
    await T.openShift(10000);
    await T.gotoPos();
    const salesBefore = await serverSales();
    await T.posAddByCard(P1);
    const { receiptNo } = await T.posCheckout(5000);
    const call = T.rpcBodies.filter((b) => b.name === "op_execute_v87").pop()!;
    const ctx = (call.body as any).p_ctx;
    expect(ctx.op_epoch).toBe(serverEpoch());
    expect(ctx.till).toMatch(/^till-/);
    expect(ledger((call.body as any).p_key)).toBe("committed");
    expect(await serverSales()).toBe(salesBefore + 1);
    const [jr] = (await idbRecords(T, "opj:")).filter((r) => r.rowKey === `opj:${(call.body as any).p_key}`);
    expect(jr).toMatchObject({ state: "committed", opEpoch: serverEpoch() });
    expect(jr.signedReply?.sig).toBeTruthy();
    expect(T.rpcBodies.filter((b) => b.name === "op_execute" || b.name === "complete_sale")).toHaveLength(0);
    note("C1.sale", { receiptNo, via: "op_execute_v87", op_epoch: "= server epoch", ledger: "committed", journal: "committed + signed reply" });
  } finally {
    await T.close();
  }
});

test("C2 offline sale with the previously valid epoch: queued with it, synced with it", async () => {
  const T = await reopen("m087c-1");
  try {
    await T.gotoPos();
    const epoch = serverEpoch();
    const salesBefore = await serverSales();
    await T.setOffline(true);
    await T.posAddByCard(P1);
    const { receiptNo } = await T.posCheckout(5000);
    const [row] = (await T.outbox() as any[]).filter((r: any) => r.name === "complete_sale");
    expect(row).toMatchObject({ status: "pending", opEpoch: epoch });
    await T.setOffline(false);
    await expect.poll(async () => (await T.outbox() as any[]).filter((r: any) => r.name === "complete_sale").length, { timeout: 120_000 }).toBe(0);
    expect(await serverSales()).toBe(salesBefore + 1);
    expect(ledger(row.idempotencyKey)).toBe("committed");
    const sent = T.rpcBodies.filter((b) => b.name === "op_execute_v87" && (b.body as any)?.p_key === row.idempotencyKey);
    expect(sent.every((b) => (b.body as any).p_ctx.op_epoch === epoch)).toBe(true);
    note("C2", { receiptNo, queuedWith: "the epoch it was created under", synced: "committed", resentWithSameEpoch: sent.length });
  } finally {
    await T.close();
  }
});

test("C3 a hold received while ONLINE: the sale is refused (never turned into an offline sale); held across crash, restart and network loss", async () => {
  let T = await reopen("m087c-1");
  try {
    await T.gotoPos();
    // a sale queued offline BEFORE the hold (created under the current epoch)
    await T.setOffline(true);
    await T.posAddByCard(P1);
    await T.posCheckout(5000);
    const [queued] = (await T.outbox() as any[]).filter((r: any) => r.name === "complete_sale");
    note("C3.queued-before-hold", { key: queued.idempotencyKey, opEpoch: queued.opEpoch });
    sql1(`select recovery.owner_hold_org('${org()}', 'v87 client e2e: simulated restore')`);
    const salesBefore = await serverSales();
    await T.setOffline(false);
    await T.posAddByCard(P1);
    note("C3.online-refused", await checkoutRefused(T));
    await expect(T.page.getByTestId("recovery-banner")).toBeVisible({ timeout: 60_000 });
    expect(["hold", "not-reconciled"]).toContain(await T.page.getByTestId("recovery-banner").getAttribute("data-mode"));
    expect((await T.outbox() as any[]).filter((r: any) => r.name === "complete_sale" && r.idempotencyKey !== queued.idempotencyKey)).toHaveLength(0);
    expect(await serverSales()).toBe(salesBefore);
    expect(ledger(queued.idempotencyKey)).toBe("<none>");                // the queued sale was not executed either
    // network loss during the hold: still refused offline
    await T.setOffline(true);
    await T.gotoPos();
    await T.posAddByCard(P1);
    note("C3.offline-refused", await checkoutRefused(T));
    await T.setOffline(false);
    // crash + restart: the recovery state is read back from disk
    await T.crash();
    T = await reopen("m087c-1");
    await expect(T.page.getByTestId("recovery-banner")).toBeVisible({ timeout: 60_000 });
    const mode = await modeRecord(T);
    expect(["hold", "not-reconciled"]).toContain(mode?.mode);
    await T.gotoPos();
    await T.posAddByCard(P1);
    note("C3.after-restart-refused", await checkoutRefused(T));
    expect(await serverSales()).toBe(salesBefore);
    const kept = (await T.outbox() as any[]).find((r: any) => r.idempotencyKey === queued.idempotencyKey);
    expect(kept).toMatchObject({ opEpoch: queued.opEpoch, args: queued.args });          // kept unchanged: key, args, epoch
    note("C3.persisted-mode", { mode: mode?.mode, code: mode?.code });
  } finally {
    await T.close();
  }
});

test("C4 stale epoch after the restore: reconciliation, the old queued sale awaits an owner (never executed), new sales use the new epoch", async () => {
  const oldEpoch = serverEpoch();
  sql1(`select recovery.zz_test_release_org('${org()}')`);           // 088 stand-in: released, the epoch stays advanced
  const T = await reopen("m087c-1");
  try {
    await reconcileTill(T, "C4", false);
    const epoch = serverEpoch();
    expect(epoch).toBe(oldEpoch);                                      // (the hold advanced it before; the release keeps it)
    const queued = (await T.outbox() as any[]).find((r: any) => r.name === "complete_sale");
    await expect.poll(async () => (await T.outbox() as any[]).find((r: any) => r.idempotencyKey === queued.idempotencyKey)?.heldReason, { timeout: 120_000 })
      .toBe("awaiting-owner-review");
    await expect(T.page.getByTestId("recovery-review-banner")).toBeVisible({ timeout: 60_000 });
    expect(ledger(queued.idempotencyKey)).toBe("<none>");
    const salesBefore = await serverSales();
    await T.gotoPos();
    await T.posAddByCard(P1);
    await T.posCheckout(5000);
    const last = T.rpcBodies.filter((b) => b.name === "op_execute_v87").pop()!;
    expect((last.body as any).p_ctx.op_epoch).toBe(epoch);
    expect(await serverSales()).toBe(salesBefore + 1);
    note("C4", { oldQueuedSale: "awaiting-owner-review, not in the ledger", newSale: "committed under the current epoch" });
  } finally {
    await T.close();
  }
});

// ---- Electron ------------------------------------------------------------------------------------------------
test("E1 Electron: a fresh till is blocked until verified; sells via v87; a hold refuses sales and survives an app relaunch", async () => {
  rmSync(profile("m087c-e1"), { recursive: true, force: true });
  let T = await Terminal.launchElectron(profile("m087c-e1"));
  try {
    await T.signIn(st.emails.cashA, pw, "/app");
    await T.waitForApp();
    await expect(T.page.getByTestId("recovery-banner")).toHaveAttribute("data-mode", "till-unregistered", { timeout: 60_000 });
    await reconcileTill(T, "E1", true);
    await T.gotoPos();
    const salesBefore = await serverSales();
    await T.posAddByCard(P1);
    await T.posCheckout(5000);
    expect(await serverSales()).toBe(salesBefore + 1);
    const last = T.rpcBodies.filter((b) => b.name === "op_execute_v87").pop();
    expect((last?.body as any)?.p_ctx?.op_epoch).toBe(serverEpoch());
    sql1(`select recovery.owner_hold_org('${org()}', 'v87 client e2e: electron hold')`);
    await T.posAddByCard(P1);
    note("E1.refused", await checkoutRefused(T));
    await T.close();
    T = await Terminal.launchElectron(profile("m087c-e1"));
    await T.goto("/app/pos");
    await Promise.race([
      T.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 30_000 }),
      T.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 30_000 }),
    ]);
    if (await T.page.locator('input[type="email"]').isVisible()) await T.signIn(st.emails.cashA, pw, "/app");
    await T.waitForApp();
    await expect(T.page.getByTestId("recovery-banner")).toBeVisible({ timeout: 60_000 });
    await T.gotoPos();
    await T.posAddByCard(P1);
    note("E1.after-relaunch-refused", await checkoutRefused(T));
    expect(await serverSales()).toBe(salesBefore + 1);
  } finally {
    await T.close();
    sql1(`select recovery.zz_test_release_org('${org()}')`);
  }
});

test("E2 Electron: the recovery record lost from IndexedDB (a failed write) — relaunched offline and online the till stays blocked until the server authorises it", async () => {
  rmSync(profile("m087c-e2"), { recursive: true, force: true });
  const signedIn = async (T: Terminal) => {
    await T.goto("/app/pos");
    await Promise.race([
      T.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 60_000 }),
      T.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 60_000 }),
    ]);
    if (await T.page.locator('input[type="email"]').isVisible()) await T.signIn(st.emails.cashA, pw, "/app");
    await T.waitForApp();
  };
  let T = await Terminal.launchElectron(profile("m087c-e2"));
  try {
    await T.signIn(st.emails.cashA, pw, "/app");
    await T.waitForApp();
    await reconcileTill(T, "E2", true);
    sql1(`select recovery.owner_hold_org('${org()}', 'v87 client e2e: lost-write test')`);
    await T.gotoPos();
    await T.posAddByCard(P1);
    note("E2.refused", await checkoutRefused(T));
    // the Dexie write of the recovery state is lost; only the backup record survives
    const removed = await T.page.evaluate(() => new Promise<number>((resolve, reject) => {
      const req = indexedDB.open("shwe-phala-local");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("syncState", "readwrite");
        const store = tx.objectStore("syncState");
        let n = 0;
        store.openCursor().onsuccess = (e) => {
          const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!c) return;
          if (String(c.key).startsWith("r87:mode:")) { c.delete(); n++; }
          c.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(n); };
      };
    }));
    expect(removed).toBeGreaterThan(0);
    expect(await T.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("r87:block:")).length)).toBe(1);
    const salesBefore = await serverSales();
    await T.close();
    // relaunch OFFLINE: still blocked (backup record), nothing saved
    T = await Terminal.launchElectron(profile("m087c-e2"), { offline: true });
    await signedIn(T);
    await expect(T.page.getByTestId("recovery-banner")).toBeVisible({ timeout: 60_000 });
    await T.gotoPos();
    await T.posAddByCard(P1);
    note("E2.offline-relaunch-refused", await checkoutRefused(T));
    expect((await T.outbox() as any[]).filter((r) => r.name === "complete_sale")).toHaveLength(0);
    await T.close();
    // relaunch ONLINE: the server still holds the organisation — still blocked
    T = await Terminal.launchElectron(profile("m087c-e2"));
    await signedIn(T);
    await expect(T.page.getByTestId("recovery-banner")).toBeVisible({ timeout: 60_000 });
    await T.gotoPos();
    await T.posAddByCard(P1);
    note("E2.online-relaunch-refused", await checkoutRefused(T));
    expect(await serverSales()).toBe(salesBefore);
    // only the server's authorization lifts it: released (088 stand-in) and reconciled for the new epoch
    sql1(`select recovery.zz_test_release_org('${org()}')`);
    sql1(`update recovery.tills set reconciled_epoch_no = (select epoch_no from recovery.org_state where org_id = '${org()}') where org_id = '${org()}'`);
    expect(await recoveryPage(T)).not.toBe("normal");
    note("E2.verified", await recoveryAction(T, "recovery-check", /verified this till/));
    expect(await T.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("r87:block:")).length)).toBe(0);
    await T.gotoPos();
    await T.posAddByCard(P1);
    await T.posCheckout(5000);
    expect(await serverSales()).toBe(salesBefore + 1);
  } finally {
    await T.close();
  }
});
