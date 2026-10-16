/* eslint-disable @typescript-eslint/no-explicit-any */
// RC3 · I. Owner reconciliation of outbox entries (docs/desktop-app/
// release-1.0.16.md §11). Prepared for the coordinator's live run; not run
// by the RC3 developer (no live runs against lucashome).
//
//   I1  "cancelled": cashier A queues a shift + a sale offline; online, the
//       API rejects complete_sale permanently (400 P0001, injected) -> the
//       sale is a conflict. The owner signs in on the same till (TOTP):
//         * Reconcile before an export -> blocked ("Export … first");
//         * export (native save stubbed) -> server check: NOT RECORDED;
//         * "matched" impossible, "cancelled" + reason -> main verifies the
//           owner with the server -> row "reconciled" (same key + payload),
//           listed under Reconciled with the owner's name;
//         * the update-guard report no longer counts it (unsynced 0);
//         * server: no sale and no key row for it.
//   I2  "matched" (response lost): a queued sale reaches the server, the
//       server COMMITS, the reply is cut (connection reset); further sends
//       get 503 so it stays pending. The owner exports and sets it aside,
//       then reconciles: server check RECORDED (sale id + receipt no);
//       "cancelled" is not offered; "matched" + reason -> reconciled with that
//       sale id. Server: exactly one sale, one key row. Guard: unsynced 0.
//   Consistency gate afterwards (the ledger must show no duplicate).
//
// Needs E2E_QA_TOTP_SECRET like spec A/C/D/G/H. Main's owner check reads
// E2E_SUPABASE_URL / E2E_ANON_KEY from the harness env (unpackaged app with
// SHWE_POS_E2E=1 only; electron/main.cjs).
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { closeOpenShifts, count, assertQaBarcode, keyRows, rows } from "./helpers/db";
import { RESULTS_DIR, qaPassword, qaState, qaTotpSecret } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal, type OutboxRow } from "./helpers/terminal";

test.describe.configure({ mode: "serial" });

const st = qaState();
const pw = qaPassword();
const { ids, emails } = st;
const USERDATA = path.join(RESULTS_DIR, "userdata-i");
const EXPORT_DIR = path.join(RESULTS_DIR, "reconcile");
const PASSPHRASE = `qx-${randomBytes(18).toString("base64url")}`;

let A: Terminal;

test.beforeAll(async () => {
  rmSync(USERDATA, { recursive: true, force: true });
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  const closed = await closeOpenShifts([ids.cashA], { email: emails.mgr, password: pw }, "spec I");
  record("I", "precondition: no open shift for cashier A", "INFO", closed.length ? closed.join("; ") : "none open");
  record("I", "precondition: QA Product One barcode", "INFO", await assertQaBarcode(st));
  A = await Terminal.launchElectron(USERDATA);
});

test.afterAll(async () => {
  try {
    await assertConsistency("spec I", A ? [A] : []);
  } finally {
    await A?.close();
  }
});

const byName = (r: OutboxRow[], name: string) => r.find((x) => x.name === name)!;
const byId = (r: OutboxRow[], localId: string) => r.find((x) => x.localId === localId)!;

/** The update guard's report as the renderer would send it now. */
async function guardReport(): Promise<{ unsynced: number }> {
  return A.page.evaluate(async () => {
    const modulePath = "/src/lib/updateGuardBridge.ts";
    const m: any = await import(/* @vite-ignore */ modulePath);
    return m.collectAppState();
  });
}

async function exportQueue(file: string): Promise<void> {
  await A.app!.evaluate(({ dialog }, f) => {
    (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: f });
  }, file);
  await A.page.getByTestId("export-queue-open").click();
  await A.page.getByTestId("queue-export-passphrase").fill(PASSPHRASE);
  await A.page.getByTestId("queue-export-passphrase-confirm").fill(PASSPHRASE);
  await A.page.getByTestId("queue-export-submit").click();
  await expect(A.page.getByTestId("queue-export-result")).toBeVisible({ timeout: 60_000 });
  await A.page.getByTestId("queue-export-close").click();
}

async function queueOfflineSale(): Promise<OutboxRow> {
  await A.signIn(emails.cashA, pw, "/app/pos");
  await A.waitForApp();
  // The previous test closed this cashier's shift server-side. Stay online until
  // the till has refreshed and offers a NEW shift; only then go offline, or the
  // local cache can still show the old shift as open (test race, not app state).
  await A.navigate("/app/shifts");
  await expect.poll(async () => {
    if (await A.page.locator("#opening-cash").isVisible()) return "ready";
    await A.reload();
    await A.page.locator("#opening-cash, #own-shift-closing-cash").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    return (await A.page.locator("#opening-cash").isVisible()) ? "ready" : "stale";
  }, { timeout: 90_000, intervals: [1_000, 3_000, 5_000] }).toBe("ready");
  await A.setOffline(true);
  await A.openShift(0);
  await A.gotoPos();
  await A.posScan(st.barcodeValue);
  const before = new Set((await A.outbox()).map((e) => e.localId));
  expect((await A.posCheckout(1000)).receiptNo).toBe("PENDING");
  // earlier tests leave their reconciled / set-aside rows on the till BY DESIGN; only look at this test's new rows
  const queued = (await A.outbox()).filter((e) => !before.has(e.localId) || e.status === "pending");
  expect(queued.filter((e) => e.status === "pending").map((e) => e.name).sort()).toEqual(["complete_sale", "open_shift"]);
  return byName(queued.filter((e) => e.status === "pending"), "complete_sale");
}

/** Close the test's shift server-side (as the manager), as beforeAll does. */
async function closeShiftServerSide(tag: string): Promise<void> {
  const closed = await closeOpenShifts([ids.cashA], { email: emails.mgr, password: pw }, tag);
  record("I", `${tag}: shift closed server-side`, "INFO", closed.length ? closed.join("; ") : "none open");
}

test("I1 owner reconciles a rejected (conflict) sale as CANCELLED; the guard no longer counts it", async () => {
  test.setTimeout(10 * 60_000);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  const sale = await queueOfflineSale();

  // online: open_shift syncs, complete_sale is rejected permanently -> conflict
  const hits = { hits: 0 };
  const g = await A.routeStatus("/rest/v1/rpc/complete_sale", 400, { code: "P0001", message: "e2e: rejected (spec I1)" }, hits);
  await A.setOffline(false);
  await expect.poll(async () => byName(await A.outbox(), "complete_sale")?.status, { timeout: 120_000 }).toBe("conflict");
  await expect.poll(async () => (await A.outbox()).length, { timeout: 60_000 }).toBe(1);
  await A.unroutePath(g);

  await A.logout();
  await A.loginAdminWithTotp(emails.admin, pw, qaTotpSecret());
  await A.navigate("/app/admin/sync-conflicts");
  const row = A.page.getByTestId("outbox-row").filter({ hasText: "POS Sale" });
  await expect(row).toHaveCount(1);
  expect((await guardReport()).unsynced).toBe(1);

  // before an export: blocked
  await row.getByTestId("outbox-reconcile").click();
  await expect(A.page.getByTestId("reconcile-block")).toHaveAttribute("data-block", "export-first");
  await expect(A.page.getByTestId("reconcile-check")).toBeDisabled();
  await A.page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(A.page.getByTestId("reconcile-dialog")).toHaveCount(0);

  await exportQueue(path.join(EXPORT_DIR, "i1.spqx"));
  await row.getByTestId("outbox-reconcile").click();
  await expect(A.page.getByTestId("reconcile-block")).toHaveCount(0);
  await A.page.getByTestId("reconcile-check").click();
  await expect(A.page.getByTestId("reconcile-check-result")).toHaveAttribute("data-result", "not-recorded", { timeout: 30_000 });
  await expect(A.page.getByTestId("reconcile-resolution-matched")).toBeDisabled();
  await A.page.getByTestId("reconcile-resolution-cancelled").check();
  await A.page.getByTestId("reconcile-reason").fill("e2e I1: rejected by the server, customer paid nothing, sale voided on paper");
  await A.toastsNow();
  await A.page.getByTestId("reconcile-submit").click();
  await A.toast("Reconciled");

  const after = await A.outbox();
  expect(after).toHaveLength(1);
  const r = byName(after, "complete_sale") as any;
  expect(r).toMatchObject({ status: "reconciled", idempotencyKey: sale.idempotencyKey, statusBeforeReconcile: "conflict" });
  expect(r.args).toEqual((sale as any).args);
  expect(r.reconciliation).toMatchObject({ resolution: "cancelled", serverRef: null, check: { result: "not-recorded" }, owner: { role: "ADMIN", source: "backend" } });
  expect(r.reconciliation.owner.userId).toBe(ids.admin);
  await expect(A.page.getByTestId("reconciled-row")).toHaveCount(1);
  expect((await guardReport()).unsynced).toBe(0);

  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  expect(await keyRows([sale.idempotencyKey!])).toHaveLength(0);
  record("I", "I1 conflict reconciled as cancelled (owner, export-first, read-only check not-recorded, main-verified owner)", "PASS",
    `complete_sale rejected ${hits.hits}x (400 injected) -> conflict; Reconcile blocked before export; export saved; check not-recorded; cancelled + reason; row reconciled (same key ${sale.idempotencyKey!.slice(0, 8)}, payload unchanged), owner ${r.reconciliation.owner.name}; guard unsynced 1 -> 0; server sales unchanged (${salesBefore}), 0 key rows`);

  await closeShiftServerSide("after I1");
});

test("I2 response lost: server committed, reply cut; owner sets it aside and reconciles it as MATCHED to that sale", async () => {
  test.setTimeout(10 * 60_000);
  await A.logout();
  const salesBefore = await count("sales", { shop_id: ids.shop });
  const sale = await queueOfflineSale();

  // the first complete_sale reaches the server (commits) and its reply is cut;
  // every later send gets 503 so the entry stays queued
  const cut = { hits: 0 } as { hits: number; serverStatus?: number; cut?: number };
  const gCut = await A.routeCommitThenAbort("/rest/v1/rpc/complete_sale", cut);
  await A.setOffline(false);
  // wait until the server's answer was captured and the reply cut (not just until the request started)
  await expect.poll(() => cut.cut ?? 0, { timeout: 120_000 }).toBeGreaterThan(0);
  await A.unroutePath(gCut);
  const held = { hits: 0 };
  const g503 = await A.routeStatus("/rest/v1/rpc/complete_sale", 503, { message: "e2e: held (spec I2)" }, held);
  expect(cut.serverStatus).toBe(200);
  await expect.poll(async () => count("sales", { shop_id: ids.shop }), { timeout: 30_000 }).toBe(salesBefore + 1);
  const serverSale = (await rows("sales", { shop_id: ids.shop }, (q: any) => q.order("created_at", { ascending: false }).limit(1)))[0];
  expect((await A.outbox()).map((e) => e.name)).toContain("complete_sale");

  await A.logout();
  await A.loginAdminWithTotp(emails.admin, pw, qaTotpSecret());
  await A.navigate("/app/admin/sync-conflicts");
  await A.exportAndSetAside("POS Sale", path.join(EXPORT_DIR, "i2.spqx"), PASSPHRASE);
  expect(byId(await A.outbox(), sale.localId).status).toBe("archived");
  expect((await guardReport()).unsynced).toBe(1); // unresolved set aside still blocks

  await A.page.getByTestId("set-aside-reconcile").click();
  await A.page.getByTestId("reconcile-check").click();
  await expect(A.page.getByTestId("reconcile-check-result")).toHaveAttribute("data-result", "recorded", { timeout: 30_000 });
  await expect(A.page.getByTestId("reconcile-check-detail")).toContainText(serverSale.receipt_no);
  await expect(A.page.getByTestId("reconcile-resolution-cancelled")).toBeDisabled();
  await A.page.getByTestId("reconcile-resolution-matched").check();
  await A.page.getByTestId("reconcile-reason").fill("e2e I2: reply was lost, the server has the sale (receipt matches the export)");
  await A.toastsNow();
  await A.page.getByTestId("reconcile-submit").click();
  await A.toast("Reconciled");

  const r = byId(await A.outbox(), sale.localId) as any;
  expect(r).toMatchObject({ status: "reconciled", idempotencyKey: sale.idempotencyKey, statusBeforeReconcile: "archived" });
  expect(r.reconciliation).toMatchObject({ resolution: "matched", serverRef: { saleId: serverSale.id, receiptNo: serverSale.receipt_no }, check: { result: "recorded" } });
  expect((await guardReport()).unsynced).toBe(0);

  await A.unroutePath(g503);
  await A.page.waitForTimeout(5_000); // a drain pass: a reconciled row is never sent
  expect(byId(await A.outbox(), sale.localId).status).toBe("reconciled");
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect(await keyRows([sale.idempotencyKey!])).toHaveLength(1);
  record("I", "I2 response lost -> check recorded -> reconciled as matched (cancelled not offered)", "PASS",
    `server committed (status ${cut.serverStatus}), reply cut; ${held.hits} later sends held 503; export + set aside; check recorded -> sale ${serverSale.id} (${serverSale.receipt_no}); matched + reason; guard unsynced 1 -> 0; sales ${salesBefore}->${salesBefore + 1}, 1 key row, not resent`);

  await closeShiftServerSide("after I2");
});
