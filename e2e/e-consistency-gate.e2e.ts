/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase G · E. Proof of the consistency gate's duplicate-sale detection
// (helpers/saleLedger.ts, used by helpers/consistency.ts after every spec).
//
//   E1  two DISTINCT queued sales of the same basket, rung up back to back
//       offline on one till -> the gate PASSES (the old "same shift + total +
//       lines within 2 s" heuristic flagged exactly this);
//   E2  a GENUINE duplicate forged in SQL (a second sales row for one
//       existing operation, with its items, SALE_OUT movements and the stock
//       deduction, receipt number next in sequence) -> the gate FAILS;
//       reverted -> PASSES;
//   E3  one UI operation sent TWICE under different idempotency keys (test
//       hook: the till's own complete_sale request body re-sent from the page
//       with a fresh key) -> the server creates a second sale -> the gate
//       FAILS (server ledger + terminal ledger); reverted -> PASSES.
//
// QA tenant only (terminal = Chromium, QA cashier B, QA shop). Every forged
// row is removed again inside this spec; the final gate in afterAll must pass.
import { expect, test } from "@playwright/test";
import { closeOpenShifts, count, inv, row, rows, runSql } from "./helpers/db";
import { qaPassword, qaState } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal } from "./helpers/terminal";

test.describe.configure({ mode: "serial" });

const st = qaState();
const pw = qaPassword();
const { ids, emails } = st;
let T: Terminal;

const sql1 = (q: string) => runSql(q).trim();
const gateError = async (label: string): Promise<string> => {
  try {
    await assertConsistency(label, [T]);
    return "";
  } catch (e) {
    return String((e as Error).message);
  }
};
/** The heuristic this gate replaced (for evidence only). */
const oldHeuristicFlags = (a: any, b: any, itemsSig: (id: string) => string) =>
  a.shift_id === b.shift_id && a.total_mmk === b.total_mmk && itemsSig(a.id) === itemsSig(b.id)
  && Math.abs(Date.parse(b.created_at) - Date.parse(a.created_at)) < 2000;

/** Next receipt number in the sale's shop/day bucket (the forged row stays contiguous). */
const nextReceipt = (receipt: string, shopId: string) => {
  const prefix = receipt.slice(0, -4);
  const max = sql1(`SELECT max(right(receipt_no, 4)::int) FROM sales WHERE shop_id = '${shopId}' AND receipt_no LIKE '${prefix}%';`);
  return `${prefix}${String(Number(max) + 1).padStart(4, "0")}`;
};

/** Remove a sale and everything complete_sale wrote for it; give the stock back. */
const revertSale = (saleId: string, key?: string) => sql1(`BEGIN;
UPDATE inventory v SET qty_base_units = v.qty_base_units - m.delta
  FROM (SELECT shop_id, product_id, sum(qty_change) AS delta FROM inventory_movements WHERE reference_id = '${saleId}' AND type = 'SALE_OUT' GROUP BY 1, 2) m
 WHERE v.shop_id = m.shop_id AND v.product_id = m.product_id;
DELETE FROM inventory_movements WHERE reference_id = '${saleId}';
DELETE FROM sale_items WHERE sale_id = '${saleId}';
DELETE FROM audit_logs WHERE entity_id = '${saleId}' AND shop_id LIKE 'qa-%';
${key ? `DELETE FROM idempotency_keys WHERE key = '${key}' AND response->'sale'->>'id' = '${saleId}';` : ""}
DELETE FROM sales WHERE id = '${saleId}' AND shop_id LIKE 'qa-%';
SELECT 'reverted ' || '${saleId}' || ' sales left=' || count(*) FROM sales WHERE id = '${saleId}';
COMMIT;`);

test.beforeAll(async () => {
  // Own preconditions: cashier B starts on a shift this spec opens itself.
  const closed = await closeOpenShifts([ids.cashB], { email: emails.mgr, password: pw }, "spec E");
  record("E", "precondition: no open shift for cashier B", "INFO", closed.length ? closed.join("; ") : "none open");
  T = await Terminal.launchBrowser();
  await T.signIn(emails.cashB, pw, "/app/pos");
  await T.waitForApp();
  if (!(await row("shifts", { cashier_id: ids.cashB, ended_at: null }))) await T.openShift(0);
  await T.gotoPos();
});

test.afterAll(async () => {
  try {
    await assertConsistency("spec E (after reverting every forgery)", [T]);
  } finally {
    await T?.close();
  }
});

test("E1 two distinct queued sales of the same basket rung up back to back -> gate PASSES", async () => {
  const q0 = await inv(ids.shop, ids.prod1);
  const shift = await row("shifts", { cashier_id: ids.cashB, ended_at: null });
  const before = await count("sales", { shift_id: shift.id });
  await T.setOffline(true);
  // same basket twice (1x QA Product One); added by card, as fast as the UI allows
  await T.posAddByCard("QA Product One");
  const s1 = await T.posCheckout(1000);
  await T.posAddByCard("QA Product One");
  const s2 = await T.posCheckout(1000);
  expect([s1.receiptNo, s2.receiptNo]).toEqual(["PENDING", "PENDING"]);
  const queued = await T.outbox();
  expect(queued.map((e) => e.name)).toEqual(["complete_sale", "complete_sale"]);
  expect(new Set(queued.map((e) => e.idempotencyKey)).size).toBe(2);
  await T.setOffline(false);
  await expect.poll(async () => (await T.outbox()).length, { timeout: 90_000 }).toBe(0);
  const sales = (await rows("sales", { shift_id: shift.id })).sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
  expect(sales.length).toBe(before + 2);
  const [a, b] = sales.slice(-2);
  const items = await rows("sale_items", {}, (q) => q.in("sale_id", [a.id, b.id]));
  const sig = (id: string) => items.filter((i: any) => i.sale_id === id).map((i: any) => `${i.product_id}x${i.qty_units}`).sort().join(",");
  const oldFlag = oldHeuristicFlags(a, b, sig);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 2);
  const err = await gateError("E1 two distinct queued sales");
  expect(err).toBe("");
  record("E", "two distinct identical-basket queued sales", "PASS",
    `2 offline checkouts (1x prod1, 1000 MMK each, same shift) -> 2 outbox entries with 2 keys -> drained: ${a.receipt_no} / ${b.receipt_no}, created_at ${Math.abs(Date.parse(b.created_at) - Date.parse(a.created_at))} ms apart, same lines (${sig(a.id)}); old heuristic would flag them: ${oldFlag}; new gate: PASS; stock ${q0}->${q0 - 2}`);
});

test("E2 a forged second sale row for one operation (SQL, with items, movements and stock) -> gate FAILS; reverted -> PASSES", async () => {
  const shift = await row("shifts", { cashier_id: ids.cashB, ended_at: null });
  const src = (await rows("sales", { shift_id: shift.id })).sort((x: any, y: any) => String(x.created_at).localeCompare(String(y.created_at))).at(-1);
  const forged = `qa-forged-sale-${st.ts}`;
  const receipt = nextReceipt(src.receipt_no, src.shop_id);
  const q0 = await inv(ids.shop, ids.prod1);
  const out = sql1(`BEGIN;
INSERT INTO sales SELECT (jsonb_populate_record(NULL::sales, to_jsonb(s) || jsonb_build_object('id', '${forged}', 'receipt_no', '${receipt}'))).* FROM sales s WHERE s.id = '${src.id}';
INSERT INTO sale_items SELECT (jsonb_populate_record(NULL::sale_items, to_jsonb(i) || jsonb_build_object('id', i.id || '-forged', 'sale_id', '${forged}'))).* FROM sale_items i WHERE i.sale_id = '${src.id}';
INSERT INTO inventory_movements SELECT (jsonb_populate_record(NULL::inventory_movements, to_jsonb(m) || jsonb_build_object('id', m.id || '-forged', 'reference_id', '${forged}'))).* FROM inventory_movements m WHERE m.reference_id = '${src.id}' AND m.type = 'SALE_OUT';
UPDATE inventory v SET qty_base_units = v.qty_base_units + m.delta
  FROM (SELECT shop_id, product_id, sum(qty_change) AS delta FROM inventory_movements WHERE reference_id = '${forged}' GROUP BY 1, 2) m
 WHERE v.shop_id = m.shop_id AND v.product_id = m.product_id;
SELECT 'forged ' || count(*) FROM sales WHERE id = '${forged}';
COMMIT;`);
  expect(out).toContain("forged 1");
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  const err = await gateError("E2 forged duplicate (expected FAIL)");
  const reverted = revertSale(forged);
  const after = await gateError("E2 after revert");
  expect(err).toContain("duplicate sale: one client operation applied more than once");
  expect(err).toContain("sale without a committed idempotency key");
  expect(err).not.toContain("inventory ledger"); // the forgery is internally consistent: only the ledger can see it
  expect(reverted).toContain("sales left=0");
  expect(await inv(ids.shop, ids.prod1)).toBe(q0);
  expect(after).toBe("");
  const checks = [...err.matchAll(/"check":"([^"]+)"/g)].map((m) => m[1]);
  record("E", "forged duplicate sale row -> gate FAILS", "PASS",
    `copied ${src.receipt_no} as ${receipt} (same cashier/shift/created_at/total, items + SALE_OUT movement + stock -1, so the inventory ledger still balances); gate -> FAIL with [${checks.join("; ")}]; reverted (${reverted.replace(/^.*reverted /s, "")}), stock back to ${q0}; gate -> PASS`);
});

test("E3 one UI operation re-sent under a NEW idempotency key (test hook) -> second sale created -> gate FAILS; reverted -> PASSES", async () => {
  await T.gotoPos();
  const q0 = await inv(ids.shop, ids.prod1);
  await T.posAddByCard("QA Product One");
  const sold = await T.posCheckout(1000);
  expect(sold.receiptNo).not.toBe("PENDING");
  // the operation as the till sent it (086+: inside op_execute); replayed DIRECTLY under a fresh v4 key, as a buggy client would
  const orig = [...T.logicalCalls("complete_sale")].reverse().find((b) => b.body);
  expect(orig).toBeTruthy();
  const freshKey = crypto.randomUUID();
  const replay = await T.rpcAsPageUser("complete_sale", { ...orig!.body, p_idempotency_key: freshKey });
  expect(replay.status).toBe(200);
  const dupId: string = replay.body?.sale?.id;
  expect(dupId).toBeTruthy();
  const pair = await rows("sales", {}, (q) => q.eq("created_at", orig!.body!.p_created_at as string).eq("cashier_id", ids.cashB));
  expect(pair).toHaveLength(2);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 2);
  const err = await gateError("E3 same operation, two keys (expected FAIL)");
  const reverted = revertSale(dupId, freshKey);
  // the injected request stays out of the terminal ledger once its effect is reverted
  const injected = T.rpcBodies.findIndex((b) => b.name === "complete_sale" && b.body?.p_idempotency_key === freshKey);
  if (injected >= 0) T.rpcBodies.splice(injected, 1);
  const after = await gateError("E3 after revert");
  expect(err).toContain("duplicate sale: one client operation applied more than once");
  expect(err).toContain("client replayed one operation under a new key");
  expect(reverted).toContain("sales left=0");
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  expect(after).toBe("");
  const checks = [...err.matchAll(/"check":"([^"]+)"/g)].map((m) => m[1]);
  record("E", "same UI operation under two keys -> gate FAILS", "PASS",
    `UI sale ${sold.receiptNo} (key A); its own request body re-sent from the page with a fresh key B -> HTTP ${replay.status}, second sale ${replay.body?.sale?.receiptNo} (both keys committed, each owns one sale, so a key-only check would miss it); gate -> FAIL with [${checks.join("; ")}]; reverted (sale, items, movement, audit, key B; stock +1); gate -> PASS`);
});
