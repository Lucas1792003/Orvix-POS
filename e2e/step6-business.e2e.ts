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
});

const sessionNotes: unknown[] = [];
async function signInAs(t: Terminal, who: "cashier" | "manager" | "admin"): Promise<void> {
  if (await t.page.locator("aside.sidebar").isVisible().catch(() => false)) await t.logout();
  const at = new Date().toISOString();
  if (who === "admin") { await t.loginAdminWithTotp(st.emails.admin, pw, qaTotpSecret()); await t.waitForApp(); await t.selectShop(SHOP()); }
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

// =====================================================================================================================
test("W00 complete local system: financial provisionals applied BEFORE Recovery V1; V1 installed; a till enrolled by the owner; the organization reopened by an owner-signed authorization", async () => {
  expect(sqlOne("SELECT to_regclass('public.sale_payments') IS NOT NULL AND to_regclass('public.cash_movements') IS NOT NULL AND to_regclass('public.refund_lines') IS NOT NULL AND to_regclass('public.product_costs') IS NOT NULL;")).toBe("t");
  expect(sqlOne("SELECT to_regclass('public.refund_net_paid_cap') IS NULL;")).toBe("t");      // PFIN-C held (P-6)
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
  note("W00", { enrollmentId: r.enrollmentId, provisionals: "PSAFE-A,PFIN-A,PFIN-B,PCOST-A,PFIN-D,PFIN-E", pfinC: "held" });
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

test("W03 cart discount: 10% off is applied by the server and stored (no per-role limit or approval exists — recorded as a product fact)", async () => {
  await T.gotoPos();
  await T.posAddByCard(P2); await T.posAddByCard(P2);        // 4000
  await T.page.locator("div", { hasText: /^Discount %/ }).locator("input").last().fill("10");
  await openPayment(T);
  await T.page.getByLabel("Amount received").fill("3600");
  await T.toastsNow();
  await T.page.getByLabel("Amount received").press("Enter");
  await T.toast(/Sale recorded/, 60_000);
  const s = lastSale();
  sales.discount = s.id;
  expect([Number(s.cart_discount_pct), s.discount_mmk, s.total_mmk]).toEqual([10, 400, 3600]);
  note("W03", { discountMmk: s.discount_mmk, total: s.total_mmk });
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

test("W05b refunds of a SPLIT-paid sale: a manager cannot approve their own request; the refund asks how the money goes back, and a payout larger than what was paid that way is refused (the UI offers ONE payout method per refund)", async () => {
  // the manager requests a refund of one unit of the cash sale from W01 ...
  await signInAs(T, "manager");
  // ... and the split sale (W02: 1,000 cash + 2,000 mobile wallet for one 3,000 item): the payout selector appears
  await T.navigate(`/app/sales/${sales.split}`);
  await T.page.getByRole("button", { name: "Request refund" }).click();
  const line = JSON.parse(sqlOne(`SELECT json_build_object('id', id)::text FROM public.sale_items WHERE sale_id='${sales.split}' LIMIT 1;`));
  await T.page.getByTestId(`refund-line-${line.id}`).getByRole("spinbutton").fill("1");
  const payout = T.page.getByLabel("Refund paid back as");
  await expect(payout).toBeVisible();
  const methods = await payout.locator("option").allInnerTexts();
  await payout.selectOption({ index: 2 });                      // one method for the whole 3,000 (first option is the placeholder)
  await T.page.getByPlaceholder("Reason").fill("Step 6: split sale refund");
  await T.toastsNow();
  await T.page.getByRole("button", { name: /^Submit MMK/ }).click();
  const answer = await T.toast(/Refund request submitted|Refund request failed/, 60_000);
  await T.page.keyboard.press("Escape").catch(() => undefined);
  const lines = n(`SELECT count(*) FROM public.refund_lines WHERE sale_id='${sales.split}';`);
  const payouts = n(`SELECT count(*) FROM public.refund_payouts WHERE sale_id='${sales.split}';`);
  const splitRequests = n(`SELECT count(*) FROM public.refund_void_requests WHERE sale_id='${sales.split}';`);
  // fail closed: the single-method payout of the whole 3,000 is refused (each method took less) — and the UI cannot split it
  expect(answer).toMatch(/failed/i); expect(answer).toMatch(/exceeds what the customer paid/);
  expect([lines, payouts, splitRequests]).toEqual([0, 0, 0]);

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
  note("W05b", { splitRefund: answer.slice(0, 200), payoutChoices: methods, ownRequest: own, ownRequestDecidedBy: "admin (rejected)" });
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
