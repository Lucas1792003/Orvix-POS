/* eslint-disable @typescript-eslint/no-explicit-any */
// RC2 · H. Sync Conflicts "Set aside" (replaces RC1's hard-deleting
// "Dismiss", audit D1). Prepared for the coordinator's live run; not run by
// the RC2 developer (no live runs during gateway maintenance).
//
//   H1  cashier A queues a shift + a sale offline; the API answers 503 for
//       both RPCs (entries stay queued, retrying); the owner signs in on the
//       same till (TOTP), opens Sync Conflicts:
//         * "Set aside" before an export -> "Export first", nothing changes;
//         * export through the dialog (native save stubbed);
//         * "Set aside" on the sale -> confirmation names the entry; a
//           double click on the confirm button sets aside exactly ONE row;
//         * the row stays on the till (status archived, same key + payload),
//           moves to the "Set aside" list, the shift row is untouched;
//         * "Restore" puts it back (same key);
//       then the API comes back, the cashier signs in again and the till
//       drains both entries: 1 sale on the server for the sale's key, no
//       duplicate; consistency gate.
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { closeOpenShifts, count, assertQaBarcode, keyRows } from "./helpers/db";
import { RESULTS_DIR, qaPassword, qaState, qaTotpSecret } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal, type OutboxRow } from "./helpers/terminal";

test.describe.configure({ mode: "serial" });

const st = qaState();
const pw = qaPassword();
const { ids, emails } = st;
const USERDATA = path.join(RESULTS_DIR, "userdata-h");
const EXPORT_DIR = path.join(RESULTS_DIR, "set-aside");
const EXPORT_FILE = path.join(EXPORT_DIR, "h1-export.spqx");
const PASSPHRASE = `qx-${randomBytes(18).toString("base64url")}`;

let A: Terminal;

test.beforeAll(async () => {
  rmSync(USERDATA, { recursive: true, force: true });
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  const closed = await closeOpenShifts([ids.cashA], { email: emails.mgr, password: pw }, "spec H");
  record("H", "precondition: no open shift for cashier A", "INFO", closed.length ? closed.join("; ") : "none open");
  record("H", "precondition: QA Product One barcode", "INFO", await assertQaBarcode(st));
  A = await Terminal.launchElectron(USERDATA);
  await A.signIn(emails.cashA, pw, "/app/pos");
  await A.waitForApp();
});

test.afterAll(async () => {
  try {
    await assertConsistency("spec H", A ? [A] : []);
  } finally {
    await A?.close();
  }
});

const byName = (rows: OutboxRow[], name: string) => rows.find((r) => r.name === name)!;

test("H1 owner sets a queued sale aside (export first, confirm, one row), restores it; it syncs once", async () => {
  test.setTimeout(10 * 60_000);
  const salesBefore = await count("sales", { shop_id: ids.shop });

  // 1. queue a shift + a sale offline
  await A.setOffline(true);
  await A.openShift(0);
  await A.gotoPos();
  await A.posScan(st.barcodeValue);
  expect((await A.posCheckout(1000)).receiptNo).toBe("PENDING");
  const queued = await A.outbox();
  expect(queued.map((e) => e.name)).toEqual(["open_shift", "complete_sale"]);
  const sale = byName(queued, "complete_sale");

  // 2. API refuses both RPCs (503) so nothing syncs while the owner works
  const refused = { hits: 0 };
  const g1 = await A.routeStatus("/rest/v1/rpc/open_shift", 503, { message: "e2e: held" }, refused);
  const g2 = await A.routeStatus("/rest/v1/rpc/complete_sale", 503, { message: "e2e: held" }, refused);
  await A.setOffline(false);
  await A.logout();
  await A.loginAdminWithTotp(emails.admin, pw, qaTotpSecret());
  await A.navigate("/app/admin/sync-conflicts");
  const rowsUi = A.page.getByTestId("outbox-row");
  await expect(rowsUi).toHaveCount(2);

  // 3. before an export: refused, nothing changes
  const saleRow = rowsUi.filter({ hasText: "POS Sale" });
  await A.toastsNow();
  await saleRow.getByTestId("outbox-set-aside").click();
  await A.toast("Export first");
  await expect(A.page.getByTestId("set-aside-confirm")).toHaveCount(0);
  expect((await A.outbox()).map((r) => r.status)).not.toContain("archived");

  // 4. export (native save dialog stubbed to a fixed path)
  await A.app!.evaluate(({ dialog }, file) => {
    (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, EXPORT_FILE);
  await A.page.getByTestId("export-queue-open").click();
  await A.page.getByTestId("queue-export-passphrase").fill(PASSPHRASE);
  await A.page.getByTestId("queue-export-passphrase-confirm").fill(PASSPHRASE);
  await A.page.getByTestId("queue-export-submit").click();
  await expect(A.page.getByTestId("queue-export-result")).toBeVisible({ timeout: 60_000 });
  await A.page.getByTestId("queue-export-close").click();
  expect(existsSync(EXPORT_FILE)).toBe(true);

  // 5. set aside the sale: the dialog names it; a double click acts once
  await saleRow.getByTestId("outbox-set-aside").click();
  await expect(A.page.getByTestId("set-aside-confirm-entry")).toContainText("POS Sale");
  await expect(A.page.getByTestId("set-aside-confirm-entry")).toContainText(sale.idempotencyKey!.slice(0, 8));
  await A.toastsNow();
  await A.page.getByTestId("set-aside-confirm").dblclick();
  await A.toast("Set aside (not deleted)");
  await expect(A.page.getByTestId("set-aside-row")).toHaveCount(1);
  await expect(rowsUi).toHaveCount(1);
  const after = await A.outbox();
  expect(after).toHaveLength(2); // nothing deleted
  expect(byName(after, "complete_sale")).toMatchObject({ status: "archived", idempotencyKey: sale.idempotencyKey });
  expect((byName(after, "complete_sale") as any).args).toEqual((sale as any).args);
  expect(byName(after, "open_shift").status).not.toBe("archived"); // the next row was NOT acted on

  // 6. restore
  await A.toastsNow();
  await A.page.getByTestId("set-aside-restore").click();
  await A.toast("Restored");
  await expect(A.page.getByTestId("set-aside-row")).toHaveCount(0);
  const restored = await A.outbox();
  expect(restored.map((r) => r.status)).not.toContain("archived");
  expect(byName(restored, "complete_sale").idempotencyKey).toBe(sale.idempotencyKey);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);

  // 7. API back; the cashier (the entries' actor) signs in; the till drains once
  await A.unroutePath(g1);
  await A.unroutePath(g2);
  await A.logout();
  await A.signIn(emails.cashA, pw, "/app/pos");
  await A.waitForApp();
  await expect.poll(async () => (await A.outbox()).length, { timeout: 120_000 }).toBe(0);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect(await keyRows([sale.idempotencyKey!])).toHaveLength(1);

  record("H", "Set aside replaces Dismiss (owner, export-first, confirm, single row, restore)", "PASS",
    `2 queued ops (offline shift + sale), API 503 for both (${refused.hits} refused requests); owner on the same till: Set aside before export refused; export saved; confirm dialog named the sale (key ${sale.idempotencyKey!.slice(0, 8)}); double click -> exactly 1 row archived (shift row untouched), still on the till with the same key/payload, listed under Set aside; Restore -> back in the queue; API restored + cashier sign-in -> drained, sales ${salesBefore}->${salesBefore + 1}, 1 idempotency key row`);
});
