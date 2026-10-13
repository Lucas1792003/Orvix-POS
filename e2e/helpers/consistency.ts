/* eslint-disable @typescript-eslint/no-explicit-any */
// Data-consistency gate run after every spec (and after the riskier
// failure-injection tests). Reads the database with the service role, so
// RLS cannot hide anything, and the terminals' local outboxes. Throws on the
// first violation; records one evidence line per check.
import { rows } from "./db";
import { qaState } from "./env";
import { record } from "./evidence";
import { hostedRequests } from "./hostedGuard";
import type { Terminal } from "./terminal";

interface Violation { check: string; detail: string }

const qaLike = (q: any, col: string) => q.like(col, "qa-%");

export async function assertConsistency(label: string, terminals: Terminal[] = []): Promise<void> {
  const st = qaState();
  const violations: Violation[] = [];
  const notes: string[] = [];

  // 0. The hosted project was never contacted (helpers/hostedGuard.ts).
  const hosted = hostedRequests();
  if (hosted.length > 0) violations.push({ check: "hosted project touched", detail: `${hosted.length} aborted request(s): ${hosted.join(", ")}` });

  const [sales, shifts, payments, movements, inventory, saleItems] = await Promise.all([
    rows("sales", {}, (q) => qaLike(q, "shop_id")),
    rows("shifts", {}, (q) => qaLike(q, "shop_id")),
    rows("supplier_payments", {}, (q) => qaLike(q, "shop_id")),
    rows("inventory_movements", {}, (q) => qaLike(q, "shop_id")),
    rows("inventory", {}, (q) => qaLike(q, "shop_id")),
    rows("sale_items", {}, (q) => qaLike(q, "product_id")),
  ]);

  // 1. No duplicate sales: same shift + total + the same item lines, with
  //    created_at within 2 s (two different baskets rung up back to back on
  //    one till legitimately share a total; a replayed duplicate would not
  //    differ in its lines).
  const itemsSig = (saleId: string) => saleItems.filter((i) => i.sale_id === saleId)
    .map((i) => `${i.product_id}x${i.qty_units}`).sort().join(",");
  const bySeq = [...sales].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (let i = 1; i < bySeq.length; i++) {
    const a = bySeq[i - 1], b = bySeq[i];
    if (a.shift_id === b.shift_id && a.total_mmk === b.total_mmk && itemsSig(a.id) === itemsSig(b.id)
      && Math.abs(Date.parse(b.created_at) - Date.parse(a.created_at)) < 2000) {
      violations.push({ check: "duplicate sale", detail: `${a.id} / ${b.id} (shift ${a.shift_id}, total ${a.total_mmk})` });
    }
  }
  notes.push(`sales=${sales.length}`);

  // 2. No duplicate payments (same PO + amount within 2 s) or movements
  //    (same reference + product + type).
  const pSorted = [...payments].sort((a, b) => String(a.paid_at ?? a.created_at).localeCompare(String(b.paid_at ?? b.created_at)));
  for (let i = 1; i < pSorted.length; i++) {
    const a = pSorted[i - 1], b = pSorted[i];
    const ta = Date.parse(a.paid_at ?? a.created_at), tb = Date.parse(b.paid_at ?? b.created_at);
    if (a.purchase_order_id && a.purchase_order_id === b.purchase_order_id && a.amount_mmk === b.amount_mmk && Math.abs(tb - ta) < 2000) {
      violations.push({ check: "duplicate supplier payment", detail: `${a.id} / ${b.id}` });
    }
  }
  const moveKeys = new Map<string, number>();
  for (const m of movements) {
    if (!m.reference_id) continue;
    const k = `${m.reference_id}|${m.product_id}|${m.type}`;
    moveKeys.set(k, (moveKeys.get(k) ?? 0) + 1);
  }
  for (const [k, n] of moveKeys) if (n > 1) violations.push({ check: "duplicate movement", detail: `${k} x${n}` });
  // every sale has exactly one SALE_OUT movement per stock item
  for (const s of sales) {
    const items = saleItems.filter((i) => i.sale_id === s.id);
    const moves = movements.filter((m) => m.reference_id === s.id && m.type === "SALE_OUT");
    if (items.length === 0) violations.push({ check: "sale without items", detail: s.id });
    if (moves.length !== items.length) violations.push({ check: "sale movement count", detail: `${s.id}: items=${items.length} SALE_OUT=${moves.length}` });
  }
  notes.push(`payments=${payments.length} movements=${movements.length}`);

  // 3. inventory = initial + sum(movements) for every QA shop x product.
  for (const init of st.initialInventory) {
    const sum = movements.filter((m) => m.shop_id === init.shopId && m.product_id === init.productId)
      .reduce((acc, m) => acc + Number(m.qty_change), 0);
    const onHand = inventory.find((r) => r.shop_id === init.shopId && r.product_id === init.productId)?.qty_base_units;
    if (onHand !== init.qty + sum) {
      violations.push({ check: "inventory ledger", detail: `${init.shopId}/${init.productId}: on hand ${onHand} != ${init.qty} + ${sum}` });
    }
    if (typeof onHand === "number" && onHand < 0) violations.push({ check: "negative stock", detail: `${init.shopId}/${init.productId}=${onHand}` });
  }
  const unexpected = inventory.filter((r) => !st.initialInventory.some((i) => i.shopId === r.shop_id && i.productId === r.product_id));
  if (unexpected.length) violations.push({ check: "unexpected inventory rows", detail: unexpected.map((r) => `${r.shop_id}/${r.product_id}`).join(",") });
  notes.push(`inventory rows=${inventory.length} all = initial + sum(movements)`);

  // 4. Shift ownership: every sale's cashier/shop equals its shift's.
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  for (const s of sales) {
    const sh = shiftById.get(s.shift_id);
    if (!sh) violations.push({ check: "sale without shift", detail: s.id });
    else if (sh.cashier_id !== s.cashier_id || sh.shop_id !== s.shop_id) {
      violations.push({ check: "shift ownership", detail: `${s.id} cashier ${s.cashier_id}/shop ${s.shop_id} vs shift ${sh.cashier_id}/${sh.shop_id}` });
    }
  }
  // at most one open shift per cashier
  const openByCashier = new Map<string, number>();
  for (const sh of shifts) if (!sh.ended_at) openByCashier.set(sh.cashier_id, (openByCashier.get(sh.cashier_id) ?? 0) + 1);
  for (const [c, n] of openByCashier) if (n > 1) violations.push({ check: "multiple open shifts", detail: `${c} x${n}` });
  notes.push(`shifts=${shifts.length} open=${[...openByCashier.values()].reduce((a, b) => a + b, 0)}`);

  // 5. Receipt numbers unique per shop/day and sequential (1..n, no gaps).
  const perShopDay = new Map<string, number[]>();
  for (const s of sales) {
    const m = String(s.receipt_no).match(/^(.+)-(\d{8})-(\d{4})$/);
    if (!m) { violations.push({ check: "receipt format", detail: `${s.id} ${s.receipt_no}` }); continue; }
    const k = `${s.shop_id}|${m[2]}`;
    perShopDay.set(k, [...(perShopDay.get(k) ?? []), Number(m[3])]);
  }
  for (const [k, seqs] of perShopDay) {
    const sorted = [...seqs].sort((a, b) => a - b);
    const unique = new Set(sorted).size === sorted.length;
    const contiguous = sorted.every((v, i) => v === i + 1);
    if (!unique || !contiguous) violations.push({ check: "receipt sequence", detail: `${k}: ${sorted.join(",")}` });
  }
  notes.push(`receipt sequences ok for ${perShopDay.size} shop/day bucket(s)`);

  // 6. Isolation: QA shops never touch real products / real shops, and QA
  //    actors never wrote into a real shop.
  const cross = await Promise.all([
    rows("inventory", {}, (q) => q.like("shop_id", "qa-%").not("product_id", "like", "qa-%")),
    rows("inventory", {}, (q) => q.like("product_id", "qa-%").not("shop_id", "like", "qa-%")),
    rows("inventory_movements", {}, (q) => q.like("created_by", "qa-%").not("shop_id", "like", "qa-%")),
    rows("sales", {}, (q) => q.like("cashier_id", "qa-%").not("shop_id", "like", "qa-%")),
    rows("shifts", {}, (q) => q.like("cashier_id", "qa-%").not("shop_id", "like", "qa-%")),
    rows("sales", {}, (q) => q.like("shop_id", "qa-%").not("cashier_id", "like", "qa-%")),
  ]);
  const crossTotal = cross.reduce((a, r) => a + r.length, 0);
  if (crossTotal > 0) violations.push({ check: "isolation", detail: `${crossTotal} cross row(s)` });
  // the two QA shops never share a shift or a sale
  const shop2Sales = sales.filter((s) => s.shop_id === st.ids.shop2).length;
  const shop2Shifts = shifts.filter((s) => s.shop_id === st.ids.shop2).length;
  notes.push(`isolation: 0 cross rows (real<->QA); shop2 sales=${shop2Sales} shifts=${shop2Shifts}`);

  // 7. No lost pending operations on the terminals.
  for (const t of terminals) {
    const pending = await t.outboxPending();
    const all = await t.outbox();
    if (pending.length > 0) violations.push({ check: "outbox not empty", detail: `${t.kind}: ${pending.map((e) => `${e.name}:${e.status}`).join(",")}` });
    notes.push(`${t.kind} outbox: ${all.length} row(s), ${pending.length} pending`);
  }

  if (violations.length) {
    record("D", `consistency after ${label}`, "FAIL", violations.map((v) => `${v.check}: ${v.detail}`).join("; "));
    throw new Error(`consistency violations after ${label}: ${JSON.stringify(violations)}`);
  }
  record("D", `consistency after ${label}`, "PASS", notes.join("; "));
}
