/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 6 — complete BUSINESS workflows in the REAL Electron app on the complete local system (tools/recovery-v1/step6/
// run-business.sh): 085 + 086, PSAFE-A, PFIN-A/B, PCOST-A, PFIN-D/E (PFIN-C held), the QA seed, then Recovery V1 + Step 5
// with a genuinely enrolled till and an owner-reopened organization (SYNTHETIC owner signer; the operator role carries
// the documents here — the Control link itself is proven by step6-integration.e2e.ts). Every financial outcome is
// asserted in PostgreSQL, not only in the UI.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Terminal } from "./helpers/terminal";
import { PROJECT_ROOT, qaTotpSecret } from "./helpers/env";
import { P1, P2, P3, profile, st, pw } from "./m086-helpers";
import { userClient } from "./helpers/db";
import { approveDevice, pendingRequests, reconcile, reopen, sqlOne, SyntheticOwner } from "./helpers/step5Owner";

test.describe.configure({ mode: "serial" });
test.skip(process.env.STEP6_BUSINESS_LIVE !== "1", "Step 6 business workflows: run via tools/recovery-v1/step6/run-business.sh");
if (process.env.STEP6_BUSINESS_LIVE === "1" && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("STEP6_BUSINESS_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER");
}
const OUT = process.env.STEP6_OUT ?? path.join(PROJECT_ROOT, "tools/recovery-v1/step6/results/adhoc-business");
const evidence: Record<string, unknown> = {};
const note = (id: string, v: unknown) => { evidence[id] = v; console.log(`[step6b] ${id} ${JSON.stringify(v)}`); };
const ORG = () => st.ids.org;
const SHOP = () => st.ids.shop;
const n = (q: string) => Number(sqlOne(q));
const inv = (prod: string) => n(`SELECT qty_base_units FROM public.inventory WHERE shop_id='${SHOP()}' AND product_id='${prod}';`);
let owner: SyntheticOwner;
let T: Terminal;
let shiftId = "";
const sales: Record<string, string> = {};   // label -> sale id

test.afterAll(async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "e2e-evidence.json"), JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
  await T?.close().catch(() => undefined);
  await A?.close().catch(() => undefined);
});

let lastAdminCode: string | undefined;   // a TOTP code is accepted once: never reuse the previous sign-in's code
const sessionNotes: unknown[] = [];
async function signInAs(t: Terminal, who: "cashier" | "manager" | "admin"): Promise<void> {
  if (await t.page.locator("aside.sidebar").isVisible().catch(() => false)) await t.logout();
  const at = new Date().toISOString();
  if (who === "admin") { lastAdminCode = await t.loginAdminWithTotp(st.emails.admin, pw, qaTotpSecret(), lastAdminCode); await t.waitForApp(); await t.selectShop(SHOP()); }
  else { await t.signIn(who === "cashier" ? st.emails.cashA : st.emails.mgr, pw, "/app"); await t.waitForApp(); }
  // a fresh sign-in must not carry a "sign in again" flag; and whatever banner shows, the page keeps its width (layout fix)
  await t.page.waitForTimeout(3_000);
  const flag = (await t.syncState()).find((r) => r.key === "needs-reauth") as any;
  const width = await t.page.locator(".app-content").evaluate((el) => el.getBoundingClientRect().width).catch(() => -1);
  sessionNotes.push({ who, loginAt: at, flag: flag ? { reason: flag.reason, updatedAt: flag.updatedAt } : null, contentWidth: Math.round(width) });
  evidence.sessions = sessionNotes;
  expect(width, "page content width").toBeGreaterThan(400);
}
const panel = (t: Terminal) => t.page.getByTestId("device-trust-panel");
const lastSale = () => JSON.parse(sqlOne(`SELECT row_to_json(s)::text FROM public.sales s WHERE s.shop_id='${SHOP()}' ORDER BY s.created_at DESC LIMIT 1;`));
async function openPayment(t: Terminal): Promise<void> {
  await t.page.keyboard.press("F2");
  await t.page.getByLabel("Amount received").waitFor({ state: "visible" });
}
/** fill an in-app ReasonDialog (labelled field) and submit its form */
async function reasonDialog(t: Terminal, label: RegExp, text: string): Promise<void> {
  const f = t.page.getByLabel(label);
  await f.fill(text);
  const formId = await t.page.locator("form", { has: f }).getAttribute("id");
  await t.page.locator(`button[type="submit"][form="${formId}"]`).click();
}
// Step 6 finalization: the Shop Admin's back office in a SECOND session (Chromium, web). An approval decision is not a
// device-signed operation (it moves no money); the refund approval and the discounted sale that use it are, on the till.
let A: Terminal | undefined;
async function adminDecides(kind: RegExp, decision: "Approve" | "Reject", reason?: string): Promise<string> {
  if (!A) {
    rmSync(profile("s6b-admin"), { recursive: true, force: true });
    A = await Terminal.launchPersistent(profile("s6b-admin"));
    await A.goto("/app");
  }
  // leave and re-enter: navigating to the route the page is already on does not remount it
  await A.navigate("/app");
  // the back office may have been signed out meanwhile (the same admin signed in on the till): sign in again, as a person would
  const signedOut = await Promise.race([
    A.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 30_000 }).then(() => false),
    A.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 30_000 }).then(() => true),
  ]).catch(() => true);
  if (signedOut) {
    adminNotes.push({ at: new Date().toISOString(), backOfficeSignedOut: true });
    lastAdminCode = await A.loginAdminWithTotp(st.emails.admin, pw, qaTotpSecret(), lastAdminCode);
    await A.waitForApp();
    await A.selectShop(SHOP());
  }
  await A.navigate("/app/approvals");
  const card = A.page.getByTestId("exception-approvals").locator(":scope > div").filter({ hasText: kind }).first();
  try { await card.waitFor({ timeout: 60_000 }); }
  catch (e) {
    note("adminDecides.not-found", { url: A.page.url(), kind: String(kind), signedOut, shot: await A.screenshot(`s6b-admin-${Date.now()}`).catch(() => "none") });
    throw e;
  }
  await A.toastsNow();
  await card.getByRole("button", { name: decision, exact: true }).click();
  if (decision === "Reject") await reasonDialog(A, /Reason \(3/, reason ?? "Step 6: not justified");
  return A.toast(/Decision recorded|Decision not recorded/, 60_000);
}
const adminNotes: unknown[] = [];
const approvalRow = (id: string) => JSON.parse(sqlOne(`SELECT row_to_json(f)::text FROM public.fin_approvals f WHERE id='${id}';`));

// =====================================================================================================================
test("W00 complete local system: financial provisionals applied BEFORE Recovery V1; V1 installed; a till enrolled by the owner; the organization reopened by an owner-signed authorization", async () => {
  expect(sqlOne("SELECT to_regclass('public.sale_payments') IS NOT NULL AND to_regclass('public.cash_movements') IS NOT NULL AND to_regclass('public.refund_lines') IS NOT NULL AND to_regclass('public.product_costs') IS NOT NULL;")).toBe("t");
  expect(sqlOne("SELECT to_regclass('public.refund_net_paid_cap') IS NULL;")).toBe("t");      // PFIN-C held (P-6)
  // Step 6 finalization provisionals: split refunds + approvals (PFIN-F), discount authorization (PDISC-A), pg_net lockdown (PNET-A)
  expect(sqlOne("SELECT to_regclass('public.fin_approvals') IS NOT NULL AND to_regprocedure('public.fin_discount_authorize(public.sales,bigint,boolean)') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname='zz_orvix_net_lockdown');")).toBe("t");
  // the owner's back office records each product's cost through PCOST-A's permitted path (the QA seed is loaded with triggers
  // off and bypasses it): costs live in product_costs, so every later sale snapshots its cost (sale_item_costs)
  sqlOne(`UPDATE public.products SET cost_mmk = CASE id WHEN '${st.ids.prod1}' THEN 600 WHEN '${st.ids.prod2}' THEN 1200 ELSE 1800 END
          WHERE id IN ('${st.ids.prod1}', '${st.ids.prod2}', '${st.ids.prod3}'); SELECT 1;`);
  expect(sqlOne(`SELECT count(*) || '/' || count(*) FILTER (WHERE p.cost_mmk IS NULL) FROM public.product_costs c JOIN public.products p ON p.id = c.product_id WHERE c.product_id IN ('${st.ids.prod1}', '${st.ids.prod2}', '${st.ids.prod3}');`)).toBe("3/3");
  // the shop is trading before Recovery V1 arrives: a till signed in, the cashier's shift open (V1 refuses opening one while RESTRICTED)
  rmSync(profile("s6b-t1"), { recursive: true, force: true });
  T = await Terminal.launchElectron(profile("s6b-t1"));
  await T.goto("/app/pos");
  await signInAs(T, "cashier");
  await T.openShift(50000);
  shiftId = sqlOne(`SELECT id FROM public.shifts WHERE shop_id='${SHOP()}' AND cashier_id='${st.ids.cashA}' AND ended_at IS NULL;`);
  await T.close();
  const out = execFileSync("bash", [path.join(PROJECT_ROOT, "tools/recovery-v1/step5/install-v1-stack.sh"), OUT, ORG()], { encoding: "utf8" });
  const info = JSON.parse(out.trim().split("\n").pop()!);
  expect(info.integrity).toBe("none");
  owner = new SyntheticOwner(info.keydir, info.keyId, path.join(OUT, "owner-work"));
  process.env.ORVIX_POS_E2E_OWNER_TRUST = JSON.stringify([info.ownerFingerprint]);
  expect(n("SELECT count(*) FROM pg_trigger WHERE tgname='zz_recovery_v1_write' AND tgrelid IN ('public.sale_payments'::regclass,'public.cash_movements'::regclass,'public.refund_lines'::regclass,'public.refund_payouts'::regclass);")).toBe(4);
  await new Promise((r) => setTimeout(r, 65_000));
  T = await Terminal.launchElectron(profile("s6b-t1"));
  await T.goto("/app/pos");
  if (await T.page.locator('input[type="email"]').isVisible().catch(() => false)) await signInAs(T, "cashier");
  await T.waitForApp();
  await T.gotoPos();
  // a sale attempt: refused (RESTRICTED, untrusted); the till learns the server runs Recovery V1
  await T.posAddByCard(P1);
  await T.page.keyboard.press("F2");
  await T.page.getByLabel("Amount received").fill("1000");
  await T.toastsNow();
  await T.page.getByLabel("Amount received").press("Enter");
  await T.toast(/Sale not recorded|Checkout failed|not recorded/i, 60_000);
  await T.page.keyboard.press("Escape").catch(() => undefined);
  await expect(panel(T)).toHaveAttribute("data-phase", "none", { timeout: 90_000 });
  await T.page.getByTestId("device-trust-request").click();
  await expect(panel(T)).toHaveAttribute("data-phase", "pending", { timeout: 90_000 });
  const deviceId = await T.page.evaluate(async () => {
    const req = indexedDB.open("orvix-recovery-till-v1");
    const db: IDBDatabase = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const rows: any[] = await new Promise((res, rej) => { const g = db.transaction("tills").objectStore("tills").getAll(); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
    db.close(); return rows.filter((r) => !r.retired).map((r) => r.deviceId)[0] ?? "";
  });
  const r = approveDevice(owner, ORG(), pendingRequests(ORG()).find((x) => x.deviceId === deviceId)!);
  expect(r.outcome).toBe("enrolled");
  await T.page.getByTestId("device-trust-check").click({ timeout: 3_000 }).catch(() => undefined);
  await expect(panel(T)).toHaveAttribute("data-phase", "trusted", { timeout: 90_000 });
  await expect.poll(() => sqlOne(`SELECT count(*) FROM recovery_v1.device_attestations WHERE enrollment_id='${r.enrollmentId}';`), { timeout: 120_000 }).not.toBe("0");
  const rep = reconcile(ORG());
  expect(rep.blockers).toEqual([]);
  expect(reopen(owner, ORG(), rep, "verified").outcome).toBe("reopened");
  expect(sqlOne(`SELECT state || '/' || coalesce(recovery_v1.activation_problem('${ORG()}'), 'verified') FROM recovery_v1.org_state WHERE org_id='${ORG()}';`)).toBe("ACTIVE/verified");
  note("W00", { enrollmentId: r.enrollmentId, provisionals: "PSAFE-A,PFIN-A,PFIN-B,PCOST-A,PFIN-D,PFIN-E,PFIN-F,PDISC-A,PNET-A", pfinC: "held" });
});

test("W01 cashier: (shift opened with a float in W00) product search by name and by barcode; a single CASH payment with change — sale, payment row, stock movement and device signature in the database", async () => {
  // the shift opened in W00 (before V1) with a 50,000 float
  expect(n(`SELECT opening_cash_mmk FROM public.shifts WHERE id='${shiftId}';`)).toBe(50000);
  await T.gotoPos();
  await T.posClearCart();                                     // the refused W00 attempt left its item in the cart (kept, never sent)
  const q1 = inv(st.ids.prod1), q2 = inv(st.ids.prod2);
  await T.page.getByPlaceholder("Search items here...").fill("Two");
  await expect(T.page.getByRole("button", { name: `Add ${P2}`, exact: true })).toBeVisible();
  await expect(T.page.getByRole("button", { name: `Add ${P1}`, exact: true })).toHaveCount(0);
  await T.posAddByCard(P2);
  await T.page.getByPlaceholder("Search items here...").fill("");
  await T.posScan(st.barcodeValue);
  await openPayment(T);
  await T.page.getByLabel("Amount received").fill("5000");
  await expect(T.page.getByText("Change to return", { exact: true }).locator("xpath=..")).toContainText("MMK 2,000");
  await T.toastsNow();
  await T.page.getByLabel("Amount received").press("Enter");
  await T.toast(/Sale recorded/, 60_000);
  const s = lastSale();
  expect([s.total_mmk, s.paid_mmk, s.change_mmk, s.payment_method, s.status]).toEqual([3000, 5000, 2000, "CASH", "NORMAL"]);
  sales.single = s.id;
  expect(sqlOne(`SELECT string_agg(method || ':' || amount_mmk || ':' || tendered_mmk || ':' || source, ',') FROM public.sale_payments WHERE sale_id='${s.id}';`)).toBe("CASH:3000:5000:single");
  expect(n(`SELECT count(*) FROM public.inventory_movements WHERE reference_id='${s.id}' AND type='SALE_OUT';`)).toBe(2);
  expect([inv(st.ids.prod1), inv(st.ids.prod2)]).toEqual([q1 - 1, q2 - 1]);
  expect(n(`SELECT count(*) FROM recovery_v1.device_counters c JOIN public.idempotency_keys k ON k.key = c.op_key WHERE k.rpc='complete_sale' AND k.response->'sale'->>'id' = '${s.id}';`)).toBe(1);
  note("W01", { receipt: s.receipt_no, total: s.total_mmk, change: s.change_mmk });
});

test("W02 split payment: cash + mobile wallet for one sale — one sale, two payment rows that add up, cash change only on the cash part", async () => {
  await T.gotoPos();
  await T.posAddByCard(P3);                                   // 3000
  await openPayment(T);
  await T.page.getByRole("button", { name: "Split across payment methods" }).click();
  const split = T.page.getByTestId("split-payment");
  await split.getByLabel("Payment method").nth(1).selectOption("MOBILE_WALLET");
  await split.getByLabel("Amount (MMK)").nth(0).fill("1000");
  await split.getByLabel("Amount (MMK)").nth(1).fill("2000");
  await split.getByLabel("Cash received (optional)").fill("1500");
  await T.toastsNow();
  await T.page.getByRole("button", { name: "Confirm payment" }).click();
  await T.toast(/Sale recorded/, 60_000);
  const s = lastSale();
  sales.split = s.id;
  expect([s.total_mmk, s.change_mmk]).toEqual([3000, 500]);
  expect(sqlOne(`SELECT string_agg(seq || ':' || method || ':' || amount_mmk || ':' || coalesce(tendered_mmk::text,'-') || ':' || source, ',' ORDER BY seq) FROM public.sale_payments WHERE sale_id='${s.id}';`))
    .toBe("1:CASH:1000:1500:split,2:MOBILE_WALLET:2000:2000:split");
  expect(n(`SELECT sum(amount_mmk) FROM public.sale_payments WHERE sale_id='${s.id}';`)).toBe(3000);
  expect(T.logicalCalls("complete_sale").some((c) => c.via.startsWith("fin_complete_sale_split"))).toBe(true);
  note("W02", { receipt: s.receipt_no, payments: 2 });
});

test("W03 discount authorization (owner decision E): a cashier's 10% is blocked at the till and on the server until a Shop Admin in another session approves it; the approved sale uses the approval once; a manager's own 5% needs none, 5.01% does", async () => {
  await T.gotoPos();
  await T.posClearCart();
  await T.posAddByCard(P2); await T.posAddByCard(P2);        // 4000
  const before = n(`SELECT count(*) FROM public.sales WHERE shop_id='${SHOP()}';`);
  await T.page.locator("div", { hasText: /^Discount %/ }).locator("input").last().fill("10");
  const notice = T.page.getByTestId("discount-approval");
  await expect(notice).toContainText("needs approval by a Shop Admin");
  await expect(T.page.getByRole("button", { name: "Place Order (F2)" })).toBeDisabled();
  await T.toastsNow();
  await T.page.keyboard.press("F2");                          // the keyboard path is blocked too
  await T.toast(/Checkout blocked/, 30_000);
  expect(n(`SELECT count(*) FROM public.sales WHERE shop_id='${SHOP()}';`)).toBe(before);
  // the cashier asks; the request records amount, %, reference price, reason, requester
  await T.toastsNow();
  await notice.getByRole("button", { name: "Request approval" }).click();
  await reasonDialog(T, /Reason \(3/, "Step 6: regular customer, damaged box");
  await T.toast(/Approval requested/, 60_000);
  const aid = sqlOne(`SELECT id FROM public.fin_approvals WHERE kind='DISCOUNT' AND requested_by='${st.ids.cashA}' ORDER BY requested_at DESC LIMIT 1;`);
  const req = approvalRow(aid);
  expect([req.status, req.details.referenceSubtotalMmk, req.details.discountMmk, Number(req.details.pct)]).toEqual(["REQUESTED", 4000, 400, 10]);
  await expect(notice).toContainText("waiting for a decision");
  await expect(T.page.getByRole("button", { name: "Place Order (F2)" })).toBeDisabled();
  // the Shop Admin decides in the back office (a second session); the cashier's till sees it and unblocks
  expect(await adminDecides(/Discount/, "Approve")).toMatch(/Decision recorded/);
  await expect(notice).toContainText("Discount approved", { timeout: 30_000 });
  await openPayment(T);
  await T.page.getByLabel("Amount received").fill("3600");
  await T.toastsNow();
  await T.page.getByLabel("Amount received").press("Enter");
  await T.toast(/Sale recorded/, 60_000);
  const s = lastSale();
  sales.discount = s.id;
  expect([Number(s.cart_discount_pct), s.discount_mmk, s.total_mmk]).toEqual([10, 400, 3600]);
  const used = approvalRow(aid);
  expect([used.status, used.decided_by, used.consumed_sale_id]).toEqual(["APPROVED", st.ids.admin, s.id]);
  expect(used.decided_by).not.toBe(used.requested_by);
  note("W03", { discountMmk: s.discount_mmk, total: s.total_mmk, approval: aid, decidedBy: used.decided_by, decidedAt: used.decided_at });
});

test("W03b manager discounts at the till: up to and including 5% on their own (no approval notice), 5.01% needs a Shop Admin; a till that is offline cannot use an approval-needing discount", async () => {
  await signInAs(T, "manager");
  await T.gotoPos();
  await T.posClearCart();
  // 10,000 MMK: 5.01% is 501 MMK (> 500 = 5%); on a smaller cart 5.01% can round to exactly 5%, which needs no approval
  for (let k = 0; k < 5; k++) await T.posAddByCard(P2);       // 5 x 2,000
  const disc = T.page.locator("div", { hasText: /^Discount %/ }).locator("input").last();
  await disc.fill("5");
  await expect(T.page.getByTestId("discount-approval")).toHaveCount(0);
  await disc.fill("5.01");
  await expect(T.page.getByTestId("discount-approval")).toContainText("needs approval by a Shop Admin");
  await T.setOffline(true);
  await expect(T.page.getByTestId("discount-approval")).toContainText("not available offline", { timeout: 30_000 });
  await expect(T.page.getByRole("button", { name: "Place Order (F2)" })).toBeDisabled();
  await T.setOffline(false);
  await T.posClearCart();
  note("W03b", { manager5: "no approval", manager501: "Shop Admin", offline: "blocked" });
  await signInAs(T, "cashier");
});

test("W04 offline sale under the owner-signed offline policy, restart while offline with the sale queued, reconnect: synced exactly once with its original key", async () => {
  await expect.poll(() => sqlOne(`SELECT count(*) FROM recovery_v1.offline_capabilities WHERE org_id='${ORG()}';`), { timeout: 90_000 }).not.toBe("0");
  await T.gotoPos();
  await T.setOffline(true);
  const shopSalesBefore = n(`SELECT count(*) FROM public.sales WHERE shop_id='${SHOP()}';`);
  await T.posAddByCard(P1);
  const r = await T.posCheckout(1000);
  expect(r.receiptNo).toBe("PENDING");
  const key = (await T.outbox()).filter((e) => e.name === "complete_sale")[0].idempotencyKey!;
  await T.close();
  T = await Terminal.launchElectron(profile("s6b-t1"), { offline: true });
  await T.waitForApp();
  expect((await T.outbox()).filter((e) => e.name === "complete_sale").map((e) => e.idempotencyKey)).toEqual([key]);
  await T.close();
  T = await Terminal.launchElectron(profile("s6b-t1"));
  await T.goto("/app/pos"); await T.waitForApp();
  await expect.poll(async () => (await T.outbox()).filter((e) => e.name === "complete_sale").length, { timeout: 120_000 }).toBe(0);
  expect(n(`SELECT count(*) FROM public.idempotency_keys WHERE key='${key}';`)).toBe(1);
  const saleId = sqlOne(`SELECT response->'sale'->>'id' FROM public.idempotency_keys WHERE key='${key}';`);
  expect(n(`SELECT count(*) FROM public.sales WHERE id='${saleId}';`)).toBe(1);
  sales.offline = saleId;
  expect(n(`SELECT count(*) FROM public.sales WHERE shop_id='${SHOP()}';`)).toBe(shopSalesBefore + 1);   // exactly one sale, no re-keyed duplicate
  note("W04", { key, saleId, capability: sqlOne(`SELECT max(max_amount_mmk) FROM recovery_v1.offline_capabilities WHERE org_id='${ORG()}';`) });
});

async function requestRefund(saleId: string, lines: { item: string; qty: number; noRestock?: boolean }[], reason: string): Promise<string> {
  await T.navigate(`/app/sales/${saleId}`);
  await T.page.getByRole("button", { name: "Request refund" }).click();
  for (const l of lines) {
    const row = T.page.getByTestId(`refund-line-${l.item}`);
    await row.getByRole("spinbutton").fill(String(l.qty));
    if (l.noRestock) await row.getByRole("checkbox").check();
  }
  await T.page.getByPlaceholder("Reason").fill(reason);
  await T.toastsNow();
  await T.page.getByRole("button", { name: /^Submit MMK/ }).click();
  await T.toast(/Refund request submitted/, 60_000);
  return sqlOne(`SELECT id FROM public.refund_void_requests WHERE sale_id='${saleId}' ORDER BY created_at DESC LIMIT 1;`);
}
async function approveAsManager(requestId: string): Promise<string> {
  await signInAs(T, "manager");
  await T.navigate("/app/approvals");
  const card = T.page.locator("div", { hasText: requestId.slice(0, 0) }).filter({ has: T.page.getByRole("button", { name: "Approve" }) }).last();
  await T.toastsNow();
  await card.getByRole("button", { name: "Approve" }).first().click();
  const t = await T.toast(/Approval completed|Approval failed/, 60_000);
  return t;
}

test("W05 partial refund (one of two units) requested by the cashier, approved by the manager: refund line, stock back, request APPROVED", async () => {
  const items = JSON.parse(sqlOne(`SELECT json_agg(json_build_object('id', id, 'product', product_id, 'qty', qty_units) ORDER BY id)::text FROM public.sale_items WHERE sale_id='${sales.discount}';`));
  const q2 = inv(st.ids.prod2);
  const req = await requestRefund(sales.discount, [{ item: items[0].id, qty: 1 }], "Step 6: customer returned one unit");
  expect(sqlOne(`SELECT status || '/' || type FROM public.refund_void_requests WHERE id='${req}';`)).toBe("REQUESTED/PARTIAL");
  await T.navigate("/app/approvals").catch(() => undefined);
  const result = await approveAsManager(req);
  note("W05.approval", result);
  expect(result).toMatch(/Approval completed/);
  expect(sqlOne(`SELECT status FROM public.refund_void_requests WHERE id='${req}';`)).toBe("APPROVED");
  expect(sqlOne(`SELECT string_agg(qty_units || ':' || amount_mmk || ':' || restocked, ',') FROM public.refund_lines WHERE request_id='${req}';`)).toBe("1:1800:true");
  expect(inv(st.ids.prod2)).toBe(q2 + 1);
  expect(n(`SELECT count(*) FROM public.inventory_movements WHERE type='RETURN_IN' AND reference_id='${sales.discount}';`)).toBe(1);
  note("W05", { request: req, refundLines: sqlOne(`SELECT count(*) FROM public.refund_lines WHERE request_id='${req}';`) });
});

test("W05b self-approval: a manager's own refund request is never theirs to decide (UI and server); another approver rejects it with a reason and nothing is paid", async () => {
  await signInAs(T, "manager");
  // self-approval: a manager's own refund request is never theirs to decide (UI and server); another approver decides it
  await T.navigate(`/app/sales/${sales.offline}`);
  await T.page.getByRole("button", { name: "Request refund" }).click();
  const offLine = JSON.parse(sqlOne(`SELECT json_build_object('id', id)::text FROM public.sale_items WHERE sale_id='${sales.offline}' LIMIT 1;`));
  await T.page.getByTestId(`refund-line-${offLine.id}`).getByRole("spinbutton").fill("1");
  await T.page.getByPlaceholder("Reason").fill("Step 6: manager's own request");
  await T.toastsNow();
  await T.page.getByRole("button", { name: /^Submit MMK/ }).click();
  await T.toast(/Refund request submitted/, 60_000);
  const own = sqlOne(`SELECT id FROM public.refund_void_requests WHERE sale_id='${sales.offline}' ORDER BY created_at DESC LIMIT 1;`);
  await T.navigate("/app/approvals");
  await expect(T.page.getByText("Your own request — another approver must decide it.").first()).toBeVisible();
  await signInAs(T, "admin");
  await T.navigate("/app/approvals");
  await T.page.getByRole("button", { name: "Reject" }).first().click();
  await T.page.getByPlaceholder("Reason (required)").fill("Step 6: test request, not a real return");
  await T.toastsNow();
  await T.page.getByRole("button", { name: "Reject" }).last().click();
  await T.toast(/Request rejected/, 60_000);
  expect(sqlOne(`SELECT status FROM public.refund_void_requests WHERE id='${own}';`)).toBe("REJECTED");
  expect(n(`SELECT count(*) FROM public.refund_lines WHERE request_id='${own}';`)).toBe(0);
  note("W05b", { ownRequest: own, ownRequestDecidedBy: "admin (rejected)" });
  await signInAs(T, "cashier");
});

test("W06 multi-item refund with one line NOT returned to stock: two refund lines, stock back only for the restocked one, a RETURN_NO_RESTOCK movement for the other", async () => {
  await signInAs(T, "cashier");
  const items = JSON.parse(sqlOne(`SELECT json_agg(json_build_object('id', id, 'product', product_id) ORDER BY product_id)::text FROM public.sale_items WHERE sale_id='${sales.single}';`));
  const before = Object.fromEntries(items.map((i: any) => [i.product, inv(i.product)]));
  const req = await requestRefund(sales.single, [{ item: items[0].id, qty: 1 }, { item: items[1].id, qty: 1, noRestock: true }], "Step 6: both items returned, one damaged");
  expect(await approveAsManager(req)).toMatch(/Approval completed/);
  expect(sqlOne(`SELECT string_agg(restocked::text, ',' ORDER BY sale_item_id) FROM public.refund_lines WHERE request_id='${req}';`)).toBe(
    [items[0].id, items[1].id].sort().map((id) => (id === items[1].id ? "false" : "true")).join(","));
  expect(inv(items[0].product)).toBe(before[items[0].product] + 1);
  expect(inv(items[1].product)).toBe(before[items[1].product]);
  expect(n(`SELECT count(*) FROM public.inventory_movements WHERE type='RETURN_NO_RESTOCK' AND reference_id='${req}';`)).toBe(1);
  note("W06", { request: req });
});

test("W07 manager inventory adjustment: movement row with before/after, inventory changed; a cashier has no Adjust button", async () => {
  await T.navigate("/app/inventory");
  const q3 = inv(st.ids.prod3);
  await T.page.getByPlaceholder("Search product").fill(P3);
  await T.page.locator("tr", { hasText: P3 }).getByRole("button", { name: "Adjust" }).click();
  const m = T.page.locator(".fixed.inset-0.z-50");
  await m.locator("select").nth(0).selectOption("DAMAGE");
  await m.getByPlaceholder("0").fill("2");
  await m.getByPlaceholder("Enter reason for adjustment").fill("Step 6: two units damaged in storage");
  await m.getByRole("button", { name: "Save adjustment" }).click();
  await expect(m).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => inv(st.ids.prod3), { timeout: 30_000 }).toBe(q3 - 2);
  expect(sqlOne(`SELECT type || ':' || qty_change || ':' || qty_before || ':' || qty_after FROM public.inventory_movements WHERE product_id='${st.ids.prod3}' AND shop_id='${SHOP()}' ORDER BY created_at DESC LIMIT 1;`)).toBe(`DAMAGE:-2:${q3}:${q3 - 2}`);
  await signInAs(T, "cashier");
  await T.navigate("/app/inventory");
  await expect(T.page.getByRole("button", { name: "Adjust" })).toHaveCount(0);
  note("W07", { prod3: `${q3}->${q3 - 2}` });
});

test("W08 product and cost privacy: the server keeps cost out of the legacy columns; a manager sees no cost and cannot read it directly; the admin sees cost and profit", async () => {
  // (the QA seed is loaded with triggers disabled, so its rows bypass PCOST-A's redirect: recorded, not asserted)
  const seedLegacy = sqlOne(`SELECT count(*) FILTER (WHERE cost_mmk IS NOT NULL) FROM public.products WHERE org_id='${ORG()}';`);
  const mgr = await userClient(st.emails.mgr, pw);
  // a manager (no report:shop_profit) cannot write a cost through the API
  const mgrWrite = await mgr.from("products").update({ cost_mmk: 1 }).eq("id", st.ids.prod1).select("id");
  expect(mgrWrite.error?.code ?? "none").toBe("42501");
  // a permitted write (SQL session, as the owner's back office would) lands in the protected side table; the column is NULL
  sqlOne(`UPDATE public.products SET cost_mmk = 650 WHERE id = '${st.ids.prod1}'; SELECT 1;`);
  expect(sqlOne(`SELECT coalesce(p.cost_mmk::text, 'NULL') || '/' || c.cost_mmk FROM public.products p JOIN public.product_costs c ON c.product_id = p.id WHERE p.id = '${st.ids.prod1}';`)).toBe("NULL/650");
  // the manager's own session, through the real API: no cost rows, no cost on that product
  const costs = await mgr.from("product_costs").select("*");
  const legacy = await mgr.from("products").select("id, cost_mmk").eq("id", st.ids.prod1);
  expect(["denied", 0]).toContain(costs.error ? "denied" : costs.data?.length);
  expect(legacy.data?.[0]?.cost_mmk ?? null).toBeNull();
  const direct = { status: costs.error ? costs.error.code : "200", body: JSON.stringify(costs.data ?? []) };
  await signInAs(T, "manager");
  await T.navigate("/app/admin/products");
  await expect(T.page.getByRole("columnheader", { name: "Cost" })).toHaveCount(0);
  await signInAs(T, "admin");
  await T.navigate("/app/admin/products");
  await expect(T.page.getByRole("columnheader", { name: "Cost" })).toBeVisible();
  note("W08", { managerDirectRead: `${direct.status} ${direct.body.slice(0, 40)}`, managerWrite: mgrWrite.error?.code, seedLegacyCostsBypassingPcostA: seedLegacy });
});

test("W09 cash IN by the cashier, cash OUT and a REVERSAL by the manager: immutable cash movements, expected cash follows them", async () => {
  await signInAs(T, "cashier");
  await T.navigate("/app/shifts");
  const card = T.page.getByTestId("cash-movements");
  await card.getByLabel("Movement").selectOption({ label: "Pay in" });
  await card.getByPlaceholder("Amount (MMK)").fill("2500");
  await card.getByLabel("Reason (required)").fill("Step 6: change float top-up");
  await T.toastsNow();
  await card.getByRole("button", { name: "Record cash movement" }).click();
  const cashIn = await T.toast(/Cash movement recorded|Cash movement not recorded/, 60_000);
  note("W09.cashier-in", cashIn);
  expect(cashIn).toMatch(/Cash movement recorded/);
  expect(sqlOne(`SELECT kind || ':' || direction || ':' || amount_mmk FROM public.cash_movements WHERE shift_id='${shiftId}' ORDER BY created_at DESC LIMIT 1;`)).toBe("PAY_IN:1:2500");
  await signInAs(T, "manager");
  await T.navigate(`/app/shifts/${shiftId}`);
  const mcard = T.page.getByTestId("cash-movements");
  await mcard.getByLabel("Movement").selectOption({ label: "Pay out" });
  await mcard.getByPlaceholder("Amount (MMK)").fill("1000");
  await mcard.getByLabel("Reason (required)").fill("Step 6: supplier delivery paid in cash");
  await T.toastsNow();
  await mcard.getByRole("button", { name: "Record cash movement" }).click();
  const out = await T.toast(/Cash movement recorded|Cash movement not recorded/, 60_000);
  note("W09.manager-out", out);
  expect(out).toMatch(/Cash movement recorded/);
  await T.toastsNow();
  await mcard.locator("li", { hasText: "Step 6: supplier delivery paid in cash" }).getByRole("button", { name: "Reverse" }).click();
  // the reason is asked in a ReasonDialog (Step 6 fix: window.prompt does not exist in Electron, the reversal did nothing)
  const why = T.page.getByLabel(/Why is this movement being reversed/);
  await why.fill("Step 6: recorded in error");
  const formId = await T.page.locator("form", { has: why }).getAttribute("id");
  await T.page.locator(`button[type="submit"][form="${formId}"]`).click();
  const rev = await T.toast(/Cash movement recorded|Cash movement not recorded/, 60_000);
  expect(rev).toMatch(/Cash movement recorded/);
  const rows = sqlOne(`SELECT string_agg(kind || ':' || direction || ':' || amount_mmk || ':' || (reverses_id IS NOT NULL), ',' ORDER BY created_at) FROM public.cash_movements WHERE shift_id='${shiftId}';`);
  expect(rows).toMatch(/^PAY_IN:1:2500:false,PAY_OUT:-1:1000:false,REVERSAL:1:1000:true$/);
  expect(rev).toContain("56,300");                              // the pay-out is undone: back to opening + sales + pay-in
  note("W09", { movements: rows, expected: sqlOne(`SELECT public.fin_shift_cash('${shiftId}')::text;`).slice(0, 200) });
});

test("W10 reports: the manager's sales report and the admin's profit report agree with the database", async () => {
  await signInAs(T, "manager");
  await T.navigate("/app/reports");
  const perf = T.page.locator('section[data-basis="SALE_DATE"]');
  await expect(perf).toBeVisible({ timeout: 60_000 });
  await expect(T.page.locator("[data-fin-state]")).toHaveCount(0, { timeout: 60_000 });
  const gross = n(`SELECT coalesce(sum(total_mmk),0) FROM public.sales WHERE shop_id='${SHOP()}' AND status <> 'VOID';`);
  const refunded = n(`SELECT coalesce(sum(rl.amount_mmk),0) FROM public.refund_lines rl JOIN public.sales s ON s.id = rl.sale_id WHERE s.shop_id='${SHOP()}';`);
  const txt = await perf.innerText();
  note("W10.salesReport", txt.slice(0, 400));
  expect(txt.replace(/,/g, "")).toContain(String(gross));
  await signInAs(T, "admin");
  await T.navigate("/app/reports/profit");
  await expect(T.page.locator("[data-total=revenue]")).toBeVisible({ timeout: 60_000 });
  const num = async (k: string) => Number((await T.page.locator(`[data-total=${k}]`).innerText()).replace(/[^0-9-]/g, ""));
  await expect(T.page.locator("[data-total=profit]")).not.toHaveText("—", { timeout: 60_000 });   // complete costs: a profit is shown
  const [revenue, cost, profit] = [await num("revenue"), await num("cost"), await num("profit")];
  const netRevenue = Number((txt.match(/Net revenue\s*MMK\s*([\d,]+)/)?.[1] ?? "").replace(/,/g, ""));
  expect(revenue).toBe(netRevenue);                                // the profit page and the sales report agree
  // and both agree with figures derived independently from the scenario (see the review): gross 10,600 - refunds 4,800;
  // cost of goods 6,600 sold - 1,800 restocked returns (the damaged, not-restocked unit stays a cost)
  expect([gross, refunded, netRevenue]).toEqual([10600, 4800, gross - refunded]);
  expect([cost, profit]).toEqual([4800, 1000]);
  expect(profit).toBe(revenue - cost);
  expect(cost).toBeGreaterThan(0);
  note("W10.profit", { revenue, cost, profit, netRevenueSalesReport: netRevenue, dbGross: gross });
});

test("W11 close shift with a cash discrepancy: refused without a reason, closed with one; expected, counted and variance stored", async () => {
  await signInAs(T, "cashier");
  await T.navigate("/app/shifts");
  // read the figure only once the SERVER is its source (the device's provisional estimate shows first while it loads)
  await expect(T.page.locator("[data-close-expected-source]")).toHaveAttribute("data-close-expected-source", "server", { timeout: 30_000 });
  const expected = await T.expectedCashShown();
  expect(expected).toBe(n(`SELECT (public.fin_shift_cash('${shiftId}')->>'expectedCashMmk')::int;`));
  const counted = expected - 700;
  expect(await T.closeShift(counted)).toMatch(/variance reason/i);
  expect(sqlOne(`SELECT ended_at IS NULL FROM public.shifts WHERE id='${shiftId}';`)).toBe("t");
  expect(await T.closeShift(counted, "Step 6: 700 short, under review")).toBeNull();
  const s = JSON.parse(sqlOne(`SELECT row_to_json(x)::text FROM (SELECT expected_cash_mmk, closing_cash_mmk, variance_mmk, variance_reason, ended_at IS NOT NULL AS closed FROM public.shifts WHERE id='${shiftId}') x;`));
  expect(s).toMatchObject({ expected_cash_mmk: expected, closing_cash_mmk: counted, variance_mmk: -700, variance_reason: "Step 6: 700 short, under review", closed: true });
  note("W11", s);
});

// =====================================================================================================================
// Step 6 FINALIZATION (owner decisions D1-D3, E): split-payment refunds, alternative payouts, adjusted refund prices,
// online-only refunds. A fresh shift after W11, so the reconciliation figures above stay as they were.
let shift2 = "";
const expectedCash = (shift: string) => n(`SELECT (public.fin_shift_cash('${shift}')->>'expectedCashMmk')::int;`);
const payoutsOf = (req: string) => sqlOne(`SELECT coalesce(string_agg(method || ':' || amount_mmk, ',' ORDER BY method), '') FROM public.refund_payouts WHERE request_id='${req}';`);
const lastRequest = (sale: string) => sqlOne(`SELECT id FROM public.refund_void_requests WHERE sale_id='${sale}' ORDER BY created_at DESC LIMIT 1;`);
async function splitSale(items: string[], pays: { method: string; amount: number }[]): Promise<string> {
  await T.gotoPos();
  await T.posClearCart();
  for (const it of items) await T.posAddByCard(it);
  await openPayment(T);
  await T.page.getByRole("button", { name: "Split across payment methods" }).click();
  const split = T.page.getByTestId("split-payment");
  await split.getByLabel("Payment method").nth(0).selectOption(pays[0].method);
  await split.getByLabel("Payment method").nth(1).selectOption(pays[1].method);
  await split.getByLabel("Amount (MMK)").nth(0).fill(String(pays[0].amount));
  await split.getByLabel("Amount (MMK)").nth(1).fill(String(pays[1].amount));
  await T.toastsNow();
  await T.page.getByRole("button", { name: "Confirm payment" }).click();
  await T.toast(/Sale recorded/, 60_000);
  return lastSale().id;
}
async function openRefund(saleId: string, qty: number): Promise<string> {
  await T.navigate(`/app/sales/${saleId}`);
  await T.page.getByRole("button", { name: "Request refund" }).click();
  const line = sqlOne(`SELECT id FROM public.sale_items WHERE sale_id='${saleId}' ORDER BY id LIMIT 1;`);
  await T.page.getByTestId(`refund-line-${line}`).getByRole("spinbutton").fill(String(qty));
  return line;
}
async function submitRefund(reason: string): Promise<string> {
  await T.page.getByPlaceholder("Reason").fill(reason);
  await T.toastsNow();
  await T.page.getByRole("button", { name: /^Submit MMK/ }).click();
  return T.toast(/Refund request submitted|Refund request failed|online only/, 60_000);
}
async function approveOnTill(who: "manager" | "admin", requestId: string): Promise<string> {
  await signInAs(T, who);
  await T.navigate("/app/approvals");
  const reason = sqlOne(`SELECT reason FROM public.refund_void_requests WHERE id='${requestId}';`);
  const card = T.page.locator("div", { hasText: reason }).filter({ has: T.page.getByRole("button", { name: "Approve" }) }).last();
  await T.toastsNow();
  await card.getByRole("button", { name: "Approve" }).first().click();
  return T.toast(/Approval completed|Approval failed/, 60_000);
}

test("W12 PARTIAL then FULL refund of a split sale (D1): the default payout follows the original methods (cash 3,600 + bank 2,400), only cash leaves the drawer, and the bank payout is not paid until its transfer is confirmed", async () => {
  await signInAs(T, "cashier");
  await T.gotoPos();
  await T.openShift(20000);
  shift2 = sqlOne(`SELECT id FROM public.shifts WHERE shop_id='${SHOP()}' AND cashier_id='${st.ids.cashA}' AND ended_at IS NULL;`);
  const sale = await splitSale([P3, P3], [{ method: "CASH", amount: 3600 }, { method: "BANK_TRANSFER", amount: 2400 }]);   // 6000
  expect(sqlOne(`SELECT string_agg(method || ':' || amount_mmk, ',' ORDER BY method) FROM public.sale_payments WHERE sale_id='${sale}';`)).toBe("BANK_TRANSFER:2400,CASH:3600");
  const exp0 = expectedCash(shift2);
  // partial: one of two units (3,000) -> default 1,800 cash + 1,200 bank, shown before anything is sent
  await openRefund(sale, 1);
  await expect(T.page.getByTestId("refund-default-payouts")).toContainText("1,800", { timeout: 30_000 });
  await expect(T.page.getByTestId("refund-default-payouts")).toContainText("1,200");
  await expect(T.page.getByRole("checkbox", { name: /Pay back differently/ })).toHaveCount(0);   // a cashier is never offered exceptions
  expect(await submitRefund("Step 6F: one unit returned")).toMatch(/Refund request submitted/);
  const r1 = lastRequest(sale);
  expect(await approveOnTill("manager", r1)).toMatch(/Approval completed/);
  expect(payoutsOf(r1)).toBe("BANK_TRANSFER:1200,CASH:1800");
  expect(exp0 - expectedCash(shift2)).toBe(1800);
  // the receipt shows the bank payout as NOT paid out; the manager records the transfer reference
  await T.navigate(`/app/sales/${sale}`);
  const payouts = T.page.getByTestId("refund-payouts");
  await expect(payouts).toContainText("Transfer not yet confirmed — not paid out", { timeout: 30_000 });
  await T.toastsNow();
  await payouts.getByRole("button", { name: "Record transfer confirmation" }).click();
  await reasonDialog(T, /Transfer reference/, "TRX-W12-1");
  await T.toast(/Transfer confirmation recorded/, 60_000);
  await expect(payouts).toContainText("Paid (ref TRX-W12-1)", { timeout: 30_000 });
  expect(n(`SELECT count(*) FROM public.refund_payout_confirmations c JOIN public.refund_payouts p ON p.id = c.payout_id WHERE p.request_id='${r1}';`)).toBe(1);
  // full: the remaining unit -> exactly what is left per method
  await signInAs(T, "cashier");
  await openRefund(sale, 1);
  await expect(T.page.getByTestId("refund-default-payouts")).toContainText("1,800", { timeout: 30_000 });
  expect(await submitRefund("Step 6F: second unit returned")).toMatch(/Refund request submitted/);
  const r2 = lastRequest(sale);
  expect(await approveOnTill("manager", r2)).toMatch(/Approval completed/);
  expect(sqlOne(`SELECT string_agg(method || ':' || s, ',' ORDER BY method) FROM (SELECT method, sum(amount_mmk) s FROM public.refund_payouts WHERE sale_id='${sale}' GROUP BY 1) x;`)).toBe("BANK_TRANSFER:2400,CASH:3600");
  expect(exp0 - expectedCash(shift2)).toBe(3600);
  note("W12", { sale, partial: payoutsOf(r1), full: payoutsOf(r2), drawerOut: exp0 - expectedCash(shift2) });
});

test("W13 alternative payout (D2): a manager proposes paying a cash + wallet sale back all in cash; a Shop Admin in another session approves it; the refund is then approved on the till by someone else; original and approved payouts recorded", async () => {
  await signInAs(T, "cashier");
  const sale = await splitSale([P3], [{ method: "CASH", amount: 1000 }, { method: "MOBILE_WALLET", amount: 2000 }]);  // 3000
  const exp0 = expectedCash(shift2);
  await signInAs(T, "manager");
  await openRefund(sale, 1);
  await T.page.getByRole("checkbox", { name: /Pay back differently/ }).check();
  // the per-method amount inputs (the checkbox's own label starts with the same words)
  const alt = T.page.getByRole("textbox", { name: /^Pay back differently — / });
  for (let i = 0; i < await alt.count(); i++) await alt.nth(i).fill("0");
  await T.page.getByRole("textbox", { name: /^Pay back differently — Cash$/ }).fill("3000");
  expect(await submitRefund("Step 6F: customer has no wallet any more")).toMatch(/Refund request submitted/);
  const r = lastRequest(sale);
  const a = JSON.parse(sqlOne(`SELECT row_to_json(f)::text FROM public.fin_approvals f WHERE subject_id='${r}' AND kind='REFUND_ALT_PAYOUT';`));
  expect([a.status, a.details.original, a.details.proposed, a.requested_by]).toEqual(["REQUESTED",
    [{ method: "CASH", amountMmk: 1000 }, { method: "MOBILE_WALLET", amountMmk: 2000 }], [{ method: "CASH", amountMmk: 3000 }], st.ids.mgr]);
  await T.navigate("/app/approvals");
  await expect(T.page.getByText("Waiting for Shop Admin decision: alternative payout").first()).toBeVisible({ timeout: 30_000 });
  expect(await adminDecides(/Refund paid back differently/, "Approve")).toMatch(/Decision recorded/);
  expect(await approveOnTill("admin", r)).toMatch(/Approval completed/);
  expect(payoutsOf(r)).toBe("CASH:3000");
  expect(exp0 - expectedCash(shift2)).toBe(3000);
  expect(sqlOne(`SELECT string_agg(method || ':' || a, ',' ORDER BY method) FROM public.fin_refund_prior_methods('${sale}', NULL);`)).toBe("CASH:1000,MOBILE_WALLET:2000");
  const d = JSON.parse(sqlOne(`SELECT row_to_json(f)::text FROM public.fin_approvals f WHERE id='${a.id}';`));
  expect([d.status, d.decided_by]).toEqual(["APPROVED", st.ids.admin]);
  note("W13", { request: r, original: a.details.original, approvedPayout: payoutsOf(r), requester: a.requested_by, approver: d.decided_by, decidedAt: d.decided_at });
});

test("W14 manager-adjusted refund price (P-2): 800 instead of the paid 1,000 needs a Shop Admin approval before the refund can be approved", async () => {
  await signInAs(T, "cashier");
  await T.gotoPos(); await T.posClearCart();
  await T.posAddByCard(P1);
  await T.posCheckout(1000);
  const sale = lastSale().id;
  await signInAs(T, "manager");
  await openRefund(sale, 1);
  await expect(T.page.getByTestId("split-refund")).toBeVisible({ timeout: 30_000 });
  await T.page.getByRole("checkbox", { name: /Adjust refund amount/ }).check();
  await T.page.getByRole("textbox", { name: new RegExp(`^Adjust refund amount — ${P1}$`) }).fill("800");
  expect(await submitRefund("Step 6F: box opened, partial credit")).toMatch(/Refund request submitted/);
  const r = lastRequest(sale);
  const a = JSON.parse(sqlOne(`SELECT row_to_json(f)::text FROM public.fin_approvals f WHERE subject_id='${r}' AND kind='REFUND_PRICE_ADJUST';`));
  expect(a.details.lines.map((l: any) => [l.defaultMmk, l.proposedMmk])).toEqual([[1000, 800]]);
  expect(await adminDecides(/Refund amount adjusted/, "Approve")).toMatch(/Decision recorded/);
  expect(await approveOnTill("admin", r)).toMatch(/Approval completed/);
  expect(sqlOne(`SELECT sum(amount_mmk) FROM public.refund_lines WHERE request_id='${r}';`)).toBe("800");
  note("W14", { request: r, default: 1000, approved: 800 });
});

test("W15 refunds are online only (nothing queued offline) and a cashier cannot give a 100% discount on their own", async () => {
  await signInAs(T, "cashier");
  const sale = lastSale().id;
  const before = n(`SELECT count(*) FROM public.refund_void_requests;`);
  await T.navigate(`/app/sales/${sale}`);
  await T.setOffline(true);
  const btn = T.page.getByRole("button", { name: "Request refund" });
  let offline = "button disabled";
  if (await btn.isEnabled().catch(() => false)) {
    await btn.click();
    const line = sqlOne(`SELECT id FROM public.sale_items WHERE sale_id='${sale}' ORDER BY id LIMIT 1;`);
    await T.page.getByTestId(`refund-line-${line}`).getByRole("spinbutton").fill("1").catch(() => undefined);
    offline = await submitRefund("Step 6F: offline attempt");
    await T.page.keyboard.press("Escape").catch(() => undefined);
    expect(offline).toMatch(/online only|failed/i);
  }
  expect((await T.outbox()).filter((e) => e.name === "create_refund_void_request")).toEqual([]);
  await T.setOffline(false);
  expect(n(`SELECT count(*) FROM public.refund_void_requests;`)).toBe(before);
  await T.gotoPos(); await T.posClearCart();
  await T.posAddByCard(P1);
  await T.page.locator("div", { hasText: /^Discount %/ }).locator("input").last().fill("100");
  await expect(T.page.getByTestId("discount-approval")).toContainText("needs approval by a Shop Admin");
  await expect(T.page.getByRole("button", { name: "Place Order (F2)" })).toBeDisabled();
  await T.posClearCart();
  note("W15", { offlineRefund: offline.slice(0, 120), cashier100: "blocked" });
});
