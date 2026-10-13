/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase E · A. Application workflows through the real UI (Electron terminal
// A + Chromium terminal B), every step verified against the database with
// the service role / SQL. See docs/selfhost-migration/phase-e/e2e-results.md.
import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { authSessions, count, inv, keyRows, row, rows, runSql, userClient, waitFor } from "./helpers/db";
import { RESULTS_DIR, qaPassword, qaState, qaTotpSecret } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal } from "./helpers/terminal";

test.describe.configure({ mode: "serial" });

const st = qaState();
const pw = qaPassword();
const secret = qaTotpSecret();
const { ids, emails, authIds } = st;

let A: Terminal; // Electron
let B: Terminal; // Chromium
let lastTotp = "";
let poId = "";
let adminShiftId = "";

/** Terminal B: Chromium, cashier B at the POS (launched on first use). */
async function ensureB(): Promise<Terminal> {
  if (B) return B;
  B = await Terminal.launchBrowser();
  await B.login(emails.cashB, pw);
  await B.waitForRoute("/app/pos");
  await B.waitForApp();
  await B.gotoPos();
  await B.waitForRealtimeReady();
  await B.page.evaluate(() => { (window as any).__e2eMarker = "no-reload"; });
  return B;
}

test.beforeAll(async () => {
  // A fresh till for this spec (B/C relaunch their own profiles deliberately).
  rmSync(path.join(RESULTS_DIR, "userdata-a"), { recursive: true, force: true });
  A = await Terminal.launchElectron(path.join(RESULTS_DIR, "userdata-a"));
});

test.afterAll(async () => {
  try {
    await assertConsistency("spec A", [A, B].filter(Boolean));
  } finally {
    await A?.close();
    await B?.close();
  }
});

test("A1 admin login: password + TOTP (wrong code refused), shop selection, logout", async () => {
  const preExisting = new Set(authSessions(authIds.admin).map((s) => s.id));
  await A.login(emails.admin, pw);
  await A.waitForRoute("/verify");
  const mine = () => authSessions(authIds.admin).filter((s) => !preExisting.has(s.id));
  const before = mine();
  expect(before.length).toBe(1);
  expect(before[0].aal).not.toBe("aal2");

  await A.submitVerifyCode("000000");
  const wrong = await A.verifyError();
  expect(wrong).toBeTruthy();
  expect(A.currentRoute()).toMatch(/^\/verify/);
  expect(mine().every((s) => s.aal !== "aal2")).toBe(true);

  // Wrong attempt consumed the challenge, not the code window; a fresh code.
  lastTotp = await (await import("./helpers/totp")).freshTotpCode(secret);
  await A.submitVerifyCode(lastTotp);
  await A.waitForRoute("/app/dashboard");
  await A.waitForApp();
  const aal2 = mine().filter((s) => s.aal === "aal2");
  expect(aal2.length).toBe(1);
  expect(aal2[0].factorId).toBeTruthy();

  // Shop selection (ADMIN has no assigned shop): POS is blocked until one is picked.
  await A.gotoPos();
  const shopWrites = await A.shopWrites();
  const persistedBefore = await A.page.evaluate(() => localStorage.getItem("pos-app"));
  expect(persistedBefore, `pos-app before any selection: ${persistedBefore}; writes: ${JSON.stringify(shopWrites)}`).toBeNull();
  await expect(A.page.getByText("No shop selected")).toBeVisible();
  await A.selectShop(ids.shop);
  await expect(A.page.locator(".shop-switcher .shop-title")).toHaveText(`QA Shop ${st.ts}`);
  await expect(A.page.getByRole("heading", { name: "Point of Sale" })).toBeVisible();
  await expect(A.page.getByText("No Shift", { exact: true })).toBeVisible();
  const shopPref = await A.page.evaluate(() => JSON.parse(localStorage.getItem("pos-app") ?? "{}")?.state?.currentShopId);
  expect(shopPref).toBe(ids.shop);

  await A.logout();
  // Sidebar logout navigates without awaiting the sign-out request.
  await expect.poll(() => mine().length, { timeout: 15_000 }).toBe(0);
  record("A", "admin login + TOTP + shop selection + logout", "PASS",
    `wrong code -> "${wrong}" (session stayed aal1); correct code -> auth.sessions aal2=1 with factor_id; shop ${ids.shop} selected (persisted pos-app.currentShopId); logout -> this terminal's auth.sessions row deleted (global sign-out)`);
});

test("A2 manager and cashier permissions: routes/nav gated, forbidden RPCs refused server-side", async () => {
  // Manager
  await A.login(emails.mgr, pw);
  await A.waitForRoute("/app");
  await A.waitForApp();
  const mgrNav = await A.navLabels();
  expect(mgrNav).toEqual(expect.arrayContaining(["Purchases", "Inventory", "Shifts"]));
  expect(mgrNav).not.toContain("Users");
  expect(mgrNav).not.toContain("Sync Conflicts");
  await A.navigate("/app/admin/users");
  await A.waitForRoute("/app/pos");
  const staffId = `qa-user-mgrattempt-${st.ts}`;
  const mgrCreate = await A.rpcAsPageUser("create_app_user", {
    p_id: staffId, p_name: "QA Mgr Attempt", p_email: `qa-mgrattempt-${st.ts}@qa.invalid`, p_role: "CASHIER",
    p_shop_id: ids.shop, p_auth_id: null, p_granted_permissions: null, p_revoked_permissions: null,
    p_idempotency_key: crypto.randomUUID(),
  });
  expect(mgrCreate.status).toBeGreaterThanOrEqual(400);
  expect(String(mgrCreate.body?.message)).toMatch(/not permitted|permission/i);
  expect(await count("users", { id: staffId })).toBe(0);
  await A.logout();

  // Cashier
  await A.login(emails.cashA, pw);
  await A.waitForRoute("/app/pos");
  await A.waitForApp();
  const cashNav = await A.navLabels();
  expect(cashNav).toEqual(expect.arrayContaining(["Point of Sale", "Shifts", "Inventory"]));
  expect(cashNav).not.toContain("Purchases");
  expect(cashNav).not.toContain("Users");
  await A.navigate("/app/purchases");
  await A.waitForRoute("/app/pos");
  await A.navigate("/app/inventory");
  await expect(A.page.getByRole("heading", { name: "Inventory" })).toBeVisible();
  expect(await A.page.getByRole("button", { name: "Adjust" }).count()).toBe(0);
  const q0 = await inv(ids.shop, ids.prod2);
  const cashAdjust = await A.rpcAsPageUser("adjust_stock", {
    p_shop_id: ids.shop, p_product_id: ids.prod2, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 7,
    p_reason: "QA cashier attempt", p_product_unit_id: null, p_unit_qty: null, p_created_at: null,
    p_expected_actor_id: ids.cashA, p_idempotency_key: crypto.randomUUID(),
  });
  expect(cashAdjust.status).toBeGreaterThanOrEqual(400);
  expect(String(cashAdjust.body?.message)).toMatch(/not permitted|permission/i);
  expect(await inv(ids.shop, ids.prod2)).toBe(q0);
  expect(await count("inventory_movements", { product_id: ids.prod2, reason: "QA cashier attempt" })).toBe(0);
  record("A", "manager/cashier permissions", "PASS",
    `manager nav=[${mgrNav.join("|")}] (no Users); /app/admin/users -> ${"/app/pos"}; create_app_user as manager -> HTTP ${mgrCreate.status} "${mgrCreate.body?.message}", users row absent; cashier nav=[${cashNav.join("|")}] (no Purchases); /app/purchases -> /app/pos; Inventory page has 0 Adjust buttons; adjust_stock as cashier -> HTTP ${cashAdjust.status} "${cashAdjust.body?.message}", stock unchanged (${q0}), 0 movements`);
});

test("A3 cashier: open shift, barcode scan (F4), checkout (F2), receipt + print path (F3) with no printer", async () => {
  await A.openShift(0);
  const shift = await row("shifts", { cashier_id: ids.cashA, ended_at: null });
  expect(shift).toBeTruthy();
  expect(shift.shop_id).toBe(ids.shop);
  expect(shift.opening_cash_mmk).toBe(0);

  await A.gotoPos();
  await expect(A.page.getByText("Shift Open", { exact: true })).toBeVisible();
  const q0 = await inv(ids.shop, ids.prod1);
  // unknown barcode first
  await A.posScan("QA-NOPE-000");
  const notFound = await A.toast("Barcode not found");
  await A.posScan(st.barcodeValue);
  await A.toast("Added QA Product One - pcs");
  await expect(A.page.locator("text=1 item")).toBeVisible();

  const seqBefore = await count("sales", { shop_id: ids.shop });
  const { receiptNo } = await A.posCheckout(1000);
  expect(receiptNo).toMatch(new RegExp(`^${ids.shopCode}-\\d{8}-${String(seqBefore + 1).padStart(4, "0")}$`));
  const sale = await row("sales", { receipt_no: receiptNo });
  expect(sale).toMatchObject({ shop_id: ids.shop, shift_id: shift.id, cashier_id: ids.cashA, total_mmk: 1000, paid_mmk: 1000, status: "NORMAL" });
  expect(await count("sale_items", { sale_id: sale.id })).toBe(1);
  expect(await count("inventory_movements", { reference_id: sale.id, type: "SALE_OUT" })).toBe(1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  expect(await count("sales", { shift_id: shift.id })).toBe(seqBefore + 1);

  // F3: silent print path. No printer is connected to this Mac. The
  // documented behaviour (src/lib/print.ts) is: Electron silent print fails
  // cleanly -> fall back to window.print(). The native print dialog would
  // block automation, so window.print is replaced by a recorder here; the
  // IPC result itself is read by calling electronAPI.printReceipt() directly.
  const printers = await A.page.evaluate(() => window.electronAPI!.listPrinters());
  const directPrint = await A.page.evaluate(() => window.electronAPI!.printReceipt());
  await A.page.evaluate(() => {
    const w = window as any;
    w.__e2ePrint = { windowPrint: 0 };
    w.print = () => { w.__e2ePrint.windowPrint++; };
  });
  // Two scans -> one cart line, qty 2 (a different total from the sale above,
  // so the consistency gate's duplicate heuristic cannot confuse the two).
  await A.posScan(st.barcodeValue);
  await A.posScan(st.barcodeValue);
  await expect(A.page.locator("text=1 item")).toBeVisible();
  const second = await A.posCheckout(2000, { print: true });
  expect(second.toast).toContain("printing");
  expect(second.receiptNo).toMatch(new RegExp(`^${ids.shopCode}-\\d{8}-${String(seqBefore + 2).padStart(4, "0")}$`));
  // The hidden 80 mm receipt is portaled into <body> for ~500 ms before printing.
  const receiptSeen = await waitFor(async () => {
    const txt = await A.page.locator("body > .print-only-host .receipt").first().textContent().catch(() => null);
    return txt && txt.includes(second.receiptNo) ? txt : undefined;
  }, 3_000, 50);
  await expect.poll(() => A.page.evaluate(() => (window as any).__e2ePrint.windowPrint), { timeout: 10_000 }).toBe(1);
  const sale2 = await row("sales", { receipt_no: second.receiptNo });
  expect(sale2).toMatchObject({ shift_id: shift.id, total_mmk: 2000 });
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 3);
  expect(await A.page.locator("aside.sidebar").isVisible()).toBe(true);
  expect(directPrint.ok).toBe(false);
  expect(directPrint.error).toBeTruthy();
  record("A", "open shift + barcode scan + F2 checkout", "PASS",
    `shift ${shift.id} open (opening 0); unknown code -> toast "${notFound}"; scan ${st.barcodeValue} -> card added; receipt ${receiptNo}; DB sale ${sale.id} total 1000 shift ${shift.id} cashier ${ids.cashA}; 1 sale_item; 1 SALE_OUT; stock ${q0}->${q0 - 1}`);
  record("A", "F3 receipt + silent print path (no printer)", "PASS",
    `printers=${JSON.stringify(printers)}; electronAPI.printReceipt() -> ${JSON.stringify(directPrint)} (clean error, no crash); F3 sale ${second.receiptNo}: receipt rendered in the print host=${Boolean(receiptSeen)}, window.print() fallback invoked once; app still responsive; DB sale ${sale2.id} (qty 2, total 2000), stock -> ${q0 - 3}`);
});

test("A4 inventory adjust (manager) -> movement row; Realtime refresh on terminal B", async () => {
  await ensureB();
  const qB0 = await inv(ids.shop, ids.prod2);
  await expect.poll(() => B.posStockText("QA Product Two")).toBe(`${qB0} in stock`);

  await A.logout();
  await A.login(emails.mgr, pw);
  await A.waitForRoute("/app");
  await A.waitForApp();
  await A.navigate("/app/inventory");
  await A.page.getByPlaceholder("Search product").fill("QA Product Two");
  const rowLoc = A.page.locator("tr", { hasText: "QA Product Two" }).first();
  await rowLoc.getByRole("button", { name: "Adjust" }).click();
  const modal = A.page.locator(".fixed.inset-0.z-50");
  await modal.locator("select").nth(0).selectOption("ADJUSTMENT");
  await modal.locator("select").nth(1).selectOption("add");
  await modal.getByPlaceholder("0").fill("5");
  const reason = `QA count correction ${st.ts}`;
  await modal.getByPlaceholder("Enter reason for adjustment").fill(reason);
  const t0 = Date.now();
  await modal.getByRole("button", { name: "Save adjustment" }).click();
  await expect(modal).toBeHidden();
  const move = await waitFor(() => row("inventory_movements", { product_id: ids.prod2, shop_id: ids.shop, reason }), 15_000);
  expect(move).toBeTruthy();
  expect(move).toMatchObject({ type: "ADJUSTMENT", qty_change: 5, qty_before: qB0, qty_after: qB0 + 5, created_by: ids.mgr });
  expect(await inv(ids.shop, ids.prod2)).toBe(qB0 + 5);
  expect(await count("audit_logs", { entity_id: ids.prod2, action_type: "STOCK_ADJUSTMENT", actor_id: ids.mgr })).toBe(1);

  await expect.poll(() => B.posStockText("QA Product Two"), { timeout: 20_000 }).toBe(`${qB0 + 5} in stock`);
  const latency = Date.now() - t0;
  const marker = await B.page.evaluate(() => (window as any).__e2eMarker);
  expect(marker).toBe("no-reload");
  record("A", "inventory adjust -> movement; Realtime refresh on other terminal", "PASS",
    `manager adjusted prod2 +5 via UI: movement ${move.id} (${move.qty_before}->${move.qty_after}), audit STOCK_ADJUSTMENT=1, inventory ${qB0}->${qB0 + 5}; terminal B (cashier B, Chromium, no reload — marker kept) showed "${qB0 + 5} in stock" ${latency} ms after save`);
});

test("A5 purchase order: create -> self-approval blocked -> approve -> receive -> supplier payment", async () => {
  // Manager creates the PO
  await A.navigate("/app/purchases");
  await A.page.getByRole("button", { name: "New Purchase Order" }).click();
  const modal = A.page.locator(".fixed.inset-0.z-50");
  await modal.locator("select").nth(0).selectOption(ids.sup);
  await modal.locator("select").nth(1).selectOption(ids.prod2);
  await modal.locator('input[type="number"]').nth(0).fill("40");
  await modal.locator('input[type="number"]').nth(1).fill("1200");
  await A.toastsNow();
  await modal.getByRole("button", { name: "Create order" }).click();
  await A.toast("Purchase order created");
  const po = await waitFor(() => row("purchase_orders", { supplier_id: ids.sup, shop_id: ids.shop, status: "DRAFT" }), 10_000);
  expect(po).toBeTruthy();
  poId = po.id;
  expect(po).toMatchObject({ created_by: ids.mgr, total_mmk: 48_000 });
  expect(await count("purchase_order_items", { purchase_order_id: poId })).toBe(1);

  // Self-approval blocked (server)
  const poRow = A.page.locator("tr", { hasText: po.order_no }).first();
  await A.toastsNow();
  await poRow.getByRole("button", { name: "Approve" }).click();
  const selfApprove = await A.toast(/Approval failed/);
  expect((await row("purchase_orders", { id: poId })).status).toBe("DRAFT");

  // Cashier cannot approve (server, API session of cashier A)
  const cashClient = await userClient(emails.cashA, pw);
  const cashApprove = await cashClient.rpc("approve_purchase_order", { p_purchase_order_id: poId, p_idempotency_key: crypto.randomUUID() });
  expect(cashApprove.error?.message).toMatch(/not permitted/i);
  await cashClient.auth.signOut();
  expect((await row("purchase_orders", { id: poId })).status).toBe("DRAFT");

  // Admin approves
  await A.logout();
  lastTotp = await A.loginAdminWithTotp(emails.admin, pw, secret, lastTotp);
  await A.waitForApp();
  await A.navigate("/app/purchases");
  await A.toastsNow();
  await A.page.locator("tr", { hasText: po.order_no }).first().getByRole("button", { name: "Approve" }).click();
  await A.toast("Purchase order approved");
  const approved = await waitFor(async () => { const r = await row("purchase_orders", { id: poId }); return r.status === "APPROVED" ? r : undefined; }, 10_000);
  expect(approved).toMatchObject({ approved_by: ids.admin });

  // Manager receives
  await A.logout();
  await A.login(emails.mgr, pw);
  await A.waitForRoute("/app");
  await A.waitForApp();
  const qBefore = await inv(ids.shop, ids.prod2);
  await A.navigate("/app/purchases");
  await A.page.locator("tr", { hasText: po.order_no }).first().getByRole("button", { name: "Receive" }).click();
  await A.toastsNow();
  await A.page.getByRole("button", { name: "Confirm receipt" }).click();
  await A.toast("Purchase order received");
  const received = await waitFor(async () => { const r = await row("purchase_orders", { id: poId }); return r.status === "RECEIVED" ? r : undefined; }, 10_000);
  expect(received).toMatchObject({ received_by: ids.mgr, total_mmk: 48_000 });
  expect(received.paid_mmk ?? 0).toBe(0);
  expect(await inv(ids.shop, ids.prod2)).toBe(qBefore + 40);
  expect(await count("inventory_movements", { reference_id: poId, type: "PURCHASE_IN" })).toBe(1);

  // Supplier payment (manager, supplier workspace)
  await A.navigate(`/app/suppliers/${ids.sup}`);
  await A.page.getByRole("button", { name: "Purchase Orders" }).click();
  await A.page.getByRole("button", { name: "Record payment" }).first().click();
  const payModal = A.page.locator(".fixed.inset-0.z-50");
  await payModal.locator('input[inputmode="numeric"]').first().fill("20000");
  await payModal.getByPlaceholder(/reference/i).fill("QA-UI-REF-1").catch(() => undefined);
  await A.toastsNow();
  await payModal.getByRole("button", { name: "Record payment" }).click();
  await A.toast("Supplier payment recorded");
  const paid = await waitFor(async () => { const r = await row("purchase_orders", { id: poId }); return r.paid_mmk === 20_000 ? r : undefined; }, 10_000);
  expect(paid).toMatchObject({ payment_status: "PARTIAL" });
  const payments = await rows("supplier_payments", { purchase_order_id: poId });
  expect(payments).toHaveLength(1);
  expect(payments[0]).toMatchObject({ amount_mmk: 20_000, created_by: ids.mgr, supplier_id: ids.sup });
  record("A", "PO create -> approve -> receive -> supplier payment", "PASS",
    `po ${poId} ${po.order_no} by manager (40 x 1200 = 48000); manager self-approve -> toast "${selfApprove}" (status DRAFT); cashier approve -> "${cashApprove.error?.message}"; admin approve -> APPROVED approved_by ${ids.admin}; manager receive -> RECEIVED, prod2 ${qBefore}->${qBefore + 40}, 1 PURCHASE_IN; payment 20000 -> paid_mmk 20000 PARTIAL, 1 supplier_payments row ${payments[0].id}`);
});

test("A6 staff management: create a QA cashier via the Users page -> public.users row in the QA org", async () => {
  await A.logout();
  lastTotp = await A.loginAdminWithTotp(emails.admin, pw, secret, lastTotp);
  await A.waitForApp();
  await A.navigate("/app/admin/users");
  await expect(A.page.getByRole("heading", { name: "Users" })).toBeVisible();
  const staffEmail = `qa-staff-ui-${st.ts}-${Date.now()}@qa.invalid`;
  await A.page.getByPlaceholder("Full name").fill("QA Staff UI");
  await A.page.getByPlaceholder("staff@yourcompany.com").fill(staffEmail);
  await A.page.getByPlaceholder("Password (min 6 characters)").fill(pw);
  await A.page.locator("select").nth(1).selectOption("CASHIER");
  await A.page.locator("select").nth(2).selectOption(ids.shop);
  await A.page.getByRole("button", { name: "Create account" }).click();
  await expect(A.page.getByText("created. They can now log in with")).toBeVisible({ timeout: 30_000 });
  const staffId = `user-${staffEmail.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
  const staff = await row("users", { id: staffId });
  expect(staff).toMatchObject({ org_id: ids.org, role: "CASHIER", shop_id: ids.shop, is_active: true, email: staffEmail });
  expect(staff.auth_id).toBeTruthy();
  const authRow = runSql(`SELECT count(*) FROM auth.users WHERE id = '${staff.auth_id}' AND email = '${staffEmail}';`).trim();
  expect(authRow).toBe("1");
  expect(await count("audit_logs", { entity_id: staffId, action_type: "USER_CREATED", actor_id: ids.admin })).toBe(1);
  // the admin session survived the sign-up detour (still ADMIN in the shell)
  await expect(A.page.locator("aside.sidebar .user-role")).toHaveText("ADMIN");
  // and the new cashier can really sign in
  const staffClient = await userClient(staffEmail, pw);
  const me = await staffClient.from("users").select("id, org_id").eq("auth_id", staff.auth_id).single();
  expect(me.data).toMatchObject({ id: staffId, org_id: ids.org });
  await staffClient.auth.signOut();
  record("A", "staff creation via Users page", "PASS",
    `created ${staffId}: org_id=${staff.org_id} role=CASHIER shop=${staff.shop_id} auth_id linked (auth.users row=1); USER_CREATED audit=1; admin session intact after sign-up detour; new cashier signs in and resolves own row`);
});

test("A7 Realtime across terminals: a sale on A changes the stock shown on B without reload", async () => {
  await A.logout();
  await A.login(emails.cashA, pw);
  await A.waitForRoute("/app/pos");
  await A.waitForApp();
  await A.gotoPos();
  await ensureB();
  const q0 = await inv(ids.shop, ids.prod1);
  await expect.poll(() => B.posStockText("QA Product One")).toBe(`${q0} in stock`);
  await A.posScan(st.barcodeValue);
  await A.toast("Added QA Product One - pcs");
  const t0 = Date.now();
  const { receiptNo } = await A.posCheckout(1000);
  await expect.poll(() => B.posStockText("QA Product One"), { timeout: 20_000 }).toBe(`${q0 - 1} in stock`);
  const latency = Date.now() - t0;
  const marker = await B.page.evaluate(() => (window as any).__e2eMarker);
  expect(marker).toBe("no-reload");
  const sale = await row("sales", { receipt_no: receiptNo });
  expect(sale.cashier_id).toBe(ids.cashA);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  record("A", "Realtime across two terminals", "PASS",
    `sale ${receiptNo} on terminal A (Electron, cashier A); terminal B (Chromium, cashier B) card went ${q0} -> ${q0 - 1} in stock in ${latency} ms, marker shows no reload; DB inventory ${q0 - 1}`);
});

test("A8 sync badges + Sync Conflicts page: pending count, transient vs permanent, Retry, Dismiss", async () => {
  await A.logout();
  lastTotp = await A.loginAdminWithTotp(emails.admin, pw, secret, lastTotp);
  await A.waitForApp();
  await A.selectShop(ids.shop);
  await A.openShift(0);
  adminShiftId = (await row("shifts", { cashier_id: ids.admin, ended_at: null })).id;
  const adminSalesBefore = await count("sales", { shift_id: adminShiftId });
  // Load the lazily-split Sync Conflicts chunk while online so the page can
  // be opened offline later (the bundled app ships it locally).
  await A.navigate("/app/admin/sync-conflicts");
  await expect(A.page.getByText("Nothing waiting. Everything recorded on this device has synced cleanly.")).toBeVisible();
  await A.gotoPos();

  // Queue a sale offline
  await A.setOffline(true);
  await expect(A.badge("Offline — showing cached data")).toBeVisible();
  const q0 = await inv(ids.shop, ids.prod3);
  await A.posAddByCard("QA Product Three");
  const queued = await A.posCheckout(3000);
  expect(queued.receiptNo).toBe("PENDING");
  await expect(A.badge("1 action waiting to sync")).toBeVisible();
  let entries = await A.outbox();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ name: "complete_sale", status: "pending" });
  const key = entries[0].idempotencyKey!;
  await A.navigate("/app/admin/sync-conflicts");
  await expect(A.page.getByText("0 conflicts · 1 entry still syncing")).toBeVisible();
  await expect(A.page.getByText("POS Sale")).toBeVisible();
  await expect(A.page.getByText("Queued", { exact: true })).toBeVisible();

  // Reconnect behind a 503 gateway: transient, auto-retrying
  const hits = { hits: 0 };
  const glob503 = await A.routeStatus("/rest/v1/rpc/complete_sale", 503, { message: "Service Unavailable" }, hits);
  await A.setOffline(false);
  // The reconnect full load drains the queue; the 503 makes the entry a
  // transient failure (pending, backing off). The page lists on demand.
  await expect.poll(async () => (await A.outbox())[0]?.failureKind, { timeout: 60_000 }).toBe("transient");
  await A.page.getByRole("button", { name: "Refresh" }).click();
  await expect(A.page.getByText(/Retrying automatically/)).toBeVisible();
  entries = await A.outbox();
  expect(entries[0]).toMatchObject({ status: "pending", failureKind: "transient" });
  const attemptsAfter503 = entries[0].attempts;
  await A.toastsNow();
  await A.page.getByRole("button", { name: "Retry" }).click();
  const stillUnreachable = await A.toast(/Still unreachable/);
  expect((await keyRows([key])).length).toBe(0);
  expect(await inv(ids.shop, ids.prod3)).toBe(q0);

  // Gateway back: Retry succeeds, exactly one sale
  await A.unroutePath(glob503);
  await A.toastsNow();
  await A.page.getByRole("button", { name: "Retry" }).click();
  const retried = await A.toast(/Retried/);
  await expect(A.page.getByText("Nothing waiting. Everything recorded on this device has synced cleanly.")).toBeVisible();
  const [k] = await keyRows([key]);
  expect(k).toMatchObject({ rpc: "complete_sale", actor_id: ids.admin });
  const syncedAll = await rows("sales", { shift_id: adminShiftId });
  expect(syncedAll).toHaveLength(adminSalesBefore + 1);
  const synced = [...syncedAll].sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at))).slice(-1);
  expect(await inv(ids.shop, ids.prod3)).toBe(q0 - 1);
  const localSynced = (await A.localSales()).find((s: any) => s.id === synced[0].id);
  expect(localSynced?.receiptNo).toBe(synced[0].receipt_no);
  expect((await A.localSales()).some((s: any) => s.receiptNo === "PENDING")).toBe(false);
  record("A", "sync badges + Sync Conflicts: transient (503) -> Retry", "PASS",
    `offline sale -> receipt PENDING, badge "1 action waiting to sync", page "0 conflicts · 1 entry still syncing" / Queued; reconnect behind 503 (${hits.hits} gateway hits) -> "Retrying automatically", attempts=${attemptsAfter503}, Retry -> toast "${stillUnreachable}", no key row, stock ${q0}; gateway restored -> Retry -> toast "${retried}", exactly 1 sale ${synced[0].receipt_no} (key row actor ${k.actor_id}), stock ${q0 - 1}, local PENDING record replaced`);

  // Permanent conflict: the queued sale's shift is closed before replay.
  await A.gotoPos();
  await A.setOffline(true);
  await A.posAddByCard("QA Product Three");
  const queued2 = await A.posCheckout(3000);
  expect(queued2.receiptNo).toBe("PENDING");
  const entry2 = (await A.outbox())[0];
  const closedBySql = runSql(`UPDATE shifts SET ended_at = now() WHERE id = '${adminShiftId}' AND ended_at IS NULL RETURNING id;`).trim();
  expect(closedBySql).toBe(adminShiftId);
  await A.setOffline(false);
  await expect(A.badge(/1 sync conflict needs attention/)).toBeVisible({ timeout: 60_000 });
  await A.navigate("/app/admin/sync-conflicts");
  await expect(A.page.getByText("1 conflict · 0 entries still syncing")).toBeVisible();
  await expect(A.page.getByText("Needs action")).toBeVisible();
  const lastError = (await A.page.locator("td span[title]").first().getAttribute("title")) ?? "";
  expect(lastError).toMatch(/No open shift/i);
  const conflictEntry = (await A.outbox())[0];
  expect(conflictEntry).toMatchObject({ localId: entry2.localId, status: "conflict", failureKind: "permanent" });
  expect((await keyRows([entry2.idempotencyKey!])).length).toBe(0);
  expect(await count("sales", { shift_id: adminShiftId })).toBe(adminSalesBefore + 1);
  await A.toastsNow();
  await A.page.getByRole("button", { name: "Dismiss" }).click();
  const dismissed = await A.toast(/Dismissed/);
  await expect(A.page.getByText("Nothing waiting. Everything recorded on this device has synced cleanly.")).toBeVisible();
  expect(await A.outbox()).toHaveLength(0);
  const keptLocal = (await A.localSales()).find((s: any) => s.receiptNo === "PENDING");
  expect(keptLocal?.pendingSync).toBe(true);
  expect(await count("sales", { shift_id: adminShiftId })).toBe(adminSalesBefore + 1);
  expect(await inv(ids.shop, ids.prod3)).toBe(q0 - 1);
  record("A", "sync conflicts: permanent rejection -> Needs action -> Dismiss", "PASS",
    `second offline sale queued, its shift ${adminShiftId} closed server-side; reconnect -> badge "1 sync conflict needs attention", page "1 conflict · 0 entries still syncing", Needs action, last error "${lastError}", entry status=conflict/permanent, no key row, DB still 1 sale; Dismiss -> toast "${dismissed}", outbox empty, local PENDING record kept flagged pendingSync, stock unchanged (${q0 - 1})`);
});

test("A9 close shift: variance reason gate, then close (cashier A)", async () => {
  await A.logout();
  await A.login(emails.cashA, pw);
  await A.waitForRoute("/app/pos");
  await A.waitForApp();
  const shift = await row("shifts", { cashier_id: ids.cashA, ended_at: null });
  const cashSales = (await rows("sales", { shift_id: shift.id, payment_method: "CASH", status: "NORMAL" }))
    .reduce((s: number, r: any) => s + r.total_mmk, 0);
  const expected = shift.opening_cash_mmk + cashSales;
  const gate = await A.closeShift(expected + 500);
  expect(gate).toBe("Enter a variance reason before ending the shift.");
  expect((await row("shifts", { id: shift.id })).ended_at).toBeNull();
  const ok = await A.closeShift(expected + 500, "QA: 500 MMK found extra in drawer");
  expect(ok).toBeNull();
  const closed = await waitFor(async () => { const r = await row("shifts", { id: shift.id }); return r.ended_at ? r : undefined; }, 10_000);
  expect(closed).toMatchObject({ closing_cash_mmk: expected + 500, variance_mmk: 500, variance_reason: "QA: 500 MMK found extra in drawer" });
  expect(closed.expected_cash_mmk).toBe(expected);
  await expect(A.page.getByText("No active shift")).toBeVisible();
  record("A", "close shift with variance reason gate", "PASS",
    `shift ${shift.id}: expected cash ${expected} (opening ${shift.opening_cash_mmk} + cash sales ${cashSales}); closing ${expected + 500} without reason -> "${gate}" (DB still open); with reason -> closed: closing_cash=${closed.closing_cash_mmk} expected=${closed.expected_cash_mmk} variance=${closed.variance_mmk} reason stored`);
});
