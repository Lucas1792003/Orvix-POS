import type { RefundVoidRequest, Sale, SaleItem } from "../../types";

// ----------------------------------------------------------------------
// Refund amounts from what the customer actually paid (ORV-002 / ORV-006).
//
// `sale_items.line_total_mmk` is the line AFTER its item discount but
// BEFORE the cart discount (072: line totals, then one rounded cart
// discount on their sum, total = Σ lines − cart discount). Refunding
// `qty / sold × line_total` therefore paid back more than the customer
// paid whenever the sale had a cart discount.
//
// Here the cart discount D = Σ line totals − sale total is spread over the
// lines in proportion to their totals, rounded by largest remainder (ties
// by line key, code-point order), so the net line amounts sum EXACTLY to
// the sale total. A refund of q of a line's Q base units pays
// round(net × q / Q); the request that takes the line's last remaining
// units pays exactly what is left of its net, so successive partial
// refunds sum to the net line amount without rounding drift.
//
// CLIENT-SIDE ONLY. Until migration 090 the server (approve_refund_request,
// 070) still accepts any amount up to the pre-discount line total and
// matches lines by product. These rules stop this app from asking for too
// much; they do not stop a crafted or older client. Migration 090 must use
// the same allocation (see docs/plans, 090 revised design).
// ----------------------------------------------------------------------

export interface RefundLine {
  /** Stable key of the sale line (sale_items.id, or product#index). */
  key: string;
  productId: string;
  unitLabel: string;
  /** Base units per sold unit (pack size); ≥ 1. */
  unitsPerItem: number;
  /** Base units sold — `sale_items.qty_units`, what the server compares. */
  soldBaseQty: number;
  /** Line total before the cart discount. */
  lineTotalMmk: number;
  /** Line total after its share of the cart discount. */
  netMmk: number;
  /** Already approved or pending for this product (base units / MMK). */
  claimedBaseQty: number;
  claimedMmk: number;
  remainingBaseQty: number;
  /** Whole sold units that can still be refunded. */
  remainingSoldUnits: number;
  /** The product is on more than one line of this sale. The server (before
   *  090) matches refund items by product and checks an arbitrary one of
   *  those lines, so such a line cannot be refunded safely here. */
  ambiguous: boolean;
}

export interface RefundState {
  lines: RefundLine[];
  saleTotalMmk: number;
  /** Σ amounts of approved + pending partial refunds for the sale. */
  claimedTotalMmk: number;
  remainingTotalMmk: number;
  hasPendingRefund: boolean;
  hasApprovedRefund: boolean;
  /** Every line refunded to the last unit. */
  fullyRefunded: boolean;
  /** At least one partial refund approved, units still refundable. */
  partiallyRefunded: boolean;
}

/** Net amount per line: Σ result = saleTotal (when Σ lines ≥ saleTotal ≥ 0). */
export function allocateNetLineAmounts(
  lines: readonly { key: string; totalMmk: number }[],
  saleTotalMmk: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const sum = lines.reduce((s, l) => s + Math.max(0, l.totalMmk), 0);
  const discount = Math.max(0, sum - Math.max(0, saleTotalMmk));
  if (sum <= 0 || discount === 0) {
    for (const l of lines) out.set(l.key, Math.max(0, l.totalMmk));
    return out;
  }
  // BigInt: discount × line total can exceed 2^53 on large sales.
  const D = BigInt(discount);
  const S = BigInt(sum);
  const shares = lines.map((l) => {
    const t = BigInt(Math.max(0, l.totalMmk));
    return { key: l.key, total: t, share: (D * t) / S, rem: (D * t) % S };
  });
  let leftover = D - shares.reduce((s, x) => s + x.share, 0n);
  const order = [...shares].sort((a, b) => (a.rem === b.rem ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  for (const x of order) {
    if (leftover <= 0n) break;
    if (x.share < x.total) { x.share += 1n; leftover -= 1n; }
  }
  for (const x of shares) out.set(x.key, Number(x.total - x.share));
  return out;
}

const lineKey = (item: SaleItem, index: number): string => item.id ?? `${item.productId}#${index}`;

/** Requests that already claim refund quantity/amount on the sale. */
const claimingRequests = (requests: readonly RefundVoidRequest[], saleId: string) =>
  requests.filter((r) => r.saleId === saleId && r.type === "PARTIAL" && (r.status === "APPROVED" || r.status === "REQUESTED" || r.status === undefined));

export function buildRefundState(
  sale: Pick<Sale, "id" | "totalMmk" | "status">,
  saleItems: readonly SaleItem[],
  requests: readonly RefundVoidRequest[],
): RefundState {
  const items = saleItems.filter((i) => i.saleId === sale.id);
  const keyed = items.map((item, index) => ({ item, key: lineKey(item, index) }));
  const nets = allocateNetLineAmounts(keyed.map(({ item, key }) => ({ key, totalMmk: item.lineTotalMmk })), sale.totalMmk);

  const claims = claimingRequests(requests, sale.id);
  const claimedByProduct = new Map<string, { qty: number; amount: number }>();
  let claimedTotalMmk = 0;
  for (const r of claims) {
    for (const it of r.items ?? []) {
      const c = claimedByProduct.get(it.productId) ?? { qty: 0, amount: 0 };
      c.qty += Number(it.qtyUnits) || 0;
      c.amount += Number(it.amountMmk) || 0;
      claimedByProduct.set(it.productId, c);
      claimedTotalMmk += Number(it.amountMmk) || 0;
    }
  }
  const linesPerProduct = new Map<string, number>();
  for (const { item } of keyed) linesPerProduct.set(item.productId, (linesPerProduct.get(item.productId) ?? 0) + 1);

  const lines: RefundLine[] = keyed.map(({ item, key }) => {
    const unitsPerItem = Math.max(1, item.unitBaseQuantitySnapshot ?? item.unitsPerItem ?? 1);
    const ambiguous = (linesPerProduct.get(item.productId) ?? 0) > 1;
    const claimed = ambiguous ? { qty: 0, amount: 0 } : claimedByProduct.get(item.productId) ?? { qty: 0, amount: 0 };
    const remainingBaseQty = Math.max(0, item.qtyUnits - claimed.qty);
    return {
      key,
      productId: item.productId,
      unitLabel: item.unitNameSnapshot ?? item.unitLabel ?? "Unit",
      unitsPerItem,
      soldBaseQty: item.qtyUnits,
      lineTotalMmk: item.lineTotalMmk,
      netMmk: nets.get(key) ?? 0,
      claimedBaseQty: claimed.qty,
      claimedMmk: claimed.amount,
      remainingBaseQty,
      remainingSoldUnits: Math.floor(remainingBaseQty / unitsPerItem),
      ambiguous,
    };
  });

  const refundable = lines.filter((l) => !l.ambiguous);
  const fullyRefunded = refundable.length > 0 && refundable.every((l) => l.remainingBaseQty === 0) && lines.every((l) => !l.ambiguous);
  const hasApprovedRefund = claims.some((r) => r.status === "APPROVED");
  return {
    lines,
    saleTotalMmk: sale.totalMmk,
    claimedTotalMmk,
    remainingTotalMmk: Math.max(0, sale.totalMmk - claimedTotalMmk),
    hasPendingRefund: claims.some((r) => r.status !== "APPROVED"),
    hasApprovedRefund,
    fullyRefunded,
    partiallyRefunded: hasApprovedRefund && !fullyRefunded,
  };
}

export interface RefundRequestPlan {
  items: { productId: string; qtyUnits: number; amountMmk: number }[];
  totalMmk: number;
  /** Per-line amount for display, keyed like the selection. */
  amounts: Record<string, number>;
  errors: string[];
}

/**
 * The request for `selection` (line key → whole sold units). Items carry
 * base units, as the server expects (it restocks qty_units base units).
 */
export function planRefundRequest(state: RefundState, selection: Readonly<Record<string, number>>): RefundRequestPlan {
  const items: RefundRequestPlan["items"] = [];
  const amounts: Record<string, number> = {};
  const errors: string[] = [];
  let totalMmk = 0;
  for (const line of state.lines) {
    const units = Math.trunc(Number(selection[line.key] ?? 0));
    if (!units) continue;
    if (units < 0) { errors.push("Refund quantities cannot be negative."); continue; }
    if (line.ambiguous) {
      errors.push("A product that appears on more than one line of this sale cannot be partially refunded yet.");
      continue;
    }
    if (units > line.remainingSoldUnits) {
      errors.push(`Only ${line.remainingSoldUnits} ${line.unitLabel} can still be refunded on one of the lines.`);
      continue;
    }
    const baseQty = units * line.unitsPerItem;
    const leftNet = Math.max(0, line.netMmk - line.claimedMmk);
    const amount = line.claimedBaseQty + baseQty >= line.soldBaseQty
      ? leftNet
      : Math.min(leftNet, Math.max(0, Math.round((line.netMmk * baseQty) / line.soldBaseQty)));
    amounts[line.key] = amount;
    totalMmk += amount;
    items.push({ productId: line.productId, qtyUnits: baseQty, amountMmk: amount });
  }
  if (totalMmk > state.remainingTotalMmk) {
    errors.push(`The refund (${totalMmk} MMK) would exceed what is left of the sale total (${state.remainingTotalMmk} MMK).`);
  }
  if (state.hasPendingRefund) {
    errors.push("A refund request for this sale is already waiting for approval.");
  }
  return { items, totalMmk, amounts, errors: [...new Set(errors)] };
}

/** Step 4 (PFIN-E): the optional line detail of a refund item (sale line, restock) and how the money goes back. */
export interface RefundLineDetail { saleItemId: string; qtyUnits: number; amountMmk: number; restock: boolean }
export interface RefundPayout { method: string; amountMmk: number }
export interface DetailedRefundItem { productId: string; qtyUnits: number; amountMmk: number; lines?: RefundLineDetail[]; payouts?: RefundPayout[] }

/**
 * PFIN-E: attach the sale line (and its restock choice) to every planned item, and — when a payout method is
 * chosen — the payout. Only for a sale the server already has (a provisional sale's line ids are local) and only
 * for lines keyed by a real sale_items id. Lines are an opt-in contract: an item without them keeps the legacy
 * rules. `noRestock[key]` = true: the goods are not returned to stock (damaged / not returned).
 */
export function attachRefundLines(
  state: RefundState, selection: Readonly<Record<string, number>>, plan: RefundRequestPlan,
  options: { serverSale: boolean; noRestock: Readonly<Record<string, boolean>>; payoutMethod: string | null },
): DetailedRefundItem[] {
  if (!options.serverSale) return plan.items;
  const out: DetailedRefundItem[] = [];
  let i = 0;
  for (const line of state.lines) {
    const units = Math.trunc(Number(selection[line.key] ?? 0));
    if (!units || units < 0 || line.ambiguous || units > line.remainingSoldUnits) continue;
    const item = plan.items[i++];
    if (!item) break;
    const detailed: DetailedRefundItem = { ...item };
    if (!line.key.includes("#")) {
      detailed.lines = [{ saleItemId: line.key, qtyUnits: item.qtyUnits, amountMmk: item.amountMmk, restock: options.noRestock[line.key] !== true }];
    }
    if (options.payoutMethod && item.amountMmk > 0) detailed.payouts = [{ method: options.payoutMethod, amountMmk: item.amountMmk }];
    out.push(detailed);
  }
  return out;
}

/**
 * Does a request (e.g. one raised by an older app version, which used the
 * pre-discount line total) ask for more than the net amount still owed?
 * Returns the excess in MMK (0 = fine). Used to warn approvers.
 */
export function refundRequestExcessMmk(
  request: Pick<RefundVoidRequest, "id" | "items">,
  sale: Pick<Sale, "id" | "totalMmk" | "status">,
  saleItems: readonly SaleItem[],
  requests: readonly RefundVoidRequest[],
): number {
  const others = requests.filter((r) => r.id !== request.id && r.status === "APPROVED");
  const state = buildRefundState(sale, saleItems, others);
  let excess = 0;
  let total = 0;
  for (const it of request.items ?? []) {
    total += Number(it.amountMmk) || 0;
    const lines = state.lines.filter((l) => l.productId === it.productId);
    if (lines.length !== 1) continue; // ambiguous or unknown: the line check cannot say
    const line = lines[0];
    const qty = Number(it.qtyUnits) || 0;
    const leftNet = Math.max(0, line.netMmk - line.claimedMmk);
    const owed = line.claimedBaseQty + qty >= line.soldBaseQty
      ? leftNet
      : Math.min(leftNet, Math.max(0, Math.round((line.netMmk * qty) / line.soldBaseQty)));
    excess = Math.max(excess, (Number(it.amountMmk) || 0) - owed);
  }
  return Math.max(excess, total - state.remainingTotalMmk, 0);
}

// ----------------------------------------------------------------------
// Step 6 (PFIN-F): split-payment refunds. The server's fin_refund_plan gives the default amount of every chosen line
// and the default payout by the ORIGINAL methods; the request is built from it. Pure: the server checks everything.
// ----------------------------------------------------------------------

/** What fin_refund_plan reports per original payment method. */
export interface RefundMethodState { method: string; paidMmk: number; attributedRefundedMmk: number }

/**
 * The server's default payout of a refund of `amountMmk` by the original methods (PFIN-F fin_refund_default_payouts,
 * D1): the cumulative refunded amount after this refund is shared in proportion to what each method paid (floor),
 * minus what that method already got back, within what it has left; the rounding leftover goes to the methods with
 * the largest remainders (then method name). Sorted by method; null when it cannot be allocated (more than what is
 * left, or no payment lines). Used for an ADJUSTED refund total (the plan's own defaultPayouts cover the default total).
 */
export function defaultRefundPayouts(methods: readonly RefundMethodState[], amountMmk: number): RefundPayout[] | null {
  if (amountMmk <= 0) return [];
  const total = methods.reduce((s, m) => s + BigInt(m.paidMmk), 0n);
  if (total === 0n) return null;
  const prior = methods.reduce((s, m) => s + BigInt(m.attributedRefundedMmk), 0n);
  const target = prior + BigInt(amountMmk);
  if (target > total) return null;
  const rows = methods.map((m) => {
    const paid = BigInt(m.paidMmk), pr = BigInt(m.attributedRefundedMmk);
    const cap = paid - pr > 0n ? paid - pr : 0n;
    const share = (paid * target) / total - pr;
    const base = share < 0n ? 0n : share < paid - pr ? share : paid - pr;
    return { method: m.method, cap, base: base < 0n ? 0n : base, rem: (paid * target) % total };
  });
  const byName = (a: { method: string }, b: { method: string }) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0);
  let left = BigInt(amountMmk) - rows.reduce((s, r) => s + r.base, 0n);
  // short (rounding): add to the largest remainders first (then method name), within what each method has left
  for (const r of [...rows].sort((a, b) => (a.rem === b.rem ? byName(a, b) : a.rem > b.rem ? -1 : 1))) {
    if (left <= 0n) break;
    const room = r.cap - r.base;
    const give = left < room ? left : room;
    r.base += give;
    left -= give;
  }
  // over (several methods already got back more than their share): take the excess back from the smallest remainders
  // first (then method name), never below 0 — exactly PFIN-F's fin_refund_default_payouts (review 1, F1)
  for (const r of [...rows].sort((a, b) => (a.rem === b.rem ? byName(a, b) : a.rem < b.rem ? -1 : 1))) {
    if (left >= 0n) break;
    const take = -left < r.base ? -left : r.base;
    r.base -= take;
    left += take;
  }
  if (left !== 0n) return null;
  return rows.filter((r) => r.base > 0n).map((r) => ({ method: r.method, amountMmk: Number(r.base) })).sort(byName);
}

/**
 * Spread a refund's payouts over its items deterministically: items in order, each filled from the methods in the
 * given order; every item's payouts add up to its amount. null when the payouts do not add up to the items' total.
 */
export function distributePayouts(itemAmounts: readonly number[], payouts: readonly RefundPayout[]): RefundPayout[][] | null {
  const need = itemAmounts.reduce((s, a) => s + a, 0);
  const have = payouts.reduce((s, p) => s + p.amountMmk, 0);
  if (need !== have || payouts.some((p) => !Number.isInteger(p.amountMmk) || p.amountMmk < 0)) return null;
  const left = payouts.map((p) => ({ method: p.method, amountMmk: p.amountMmk }));
  let j = 0;
  return itemAmounts.map((amount) => {
    const mine: RefundPayout[] = [];
    let rest = amount;
    while (rest > 0 && j < left.length) {
      const take = Math.min(rest, left[j].amountMmk);
      if (take > 0) {
        const same = mine.find((p) => p.method === left[j].method);
        if (same) same.amountMmk += take; else mine.push({ method: left[j].method, amountMmk: take });
        left[j].amountMmk -= take;
        rest -= take;
      }
      if (left[j].amountMmk === 0) j++;
    }
    return mine;
  });
}

/** The selected lines, in request order (the order planRefundRequest and attachRefundLines use). */
export function selectedRefundLines(state: RefundState, selection: Readonly<Record<string, number>>): { line: RefundLine; baseQty: number }[] {
  const out: { line: RefundLine; baseQty: number }[] = [];
  for (const line of state.lines) {
    const units = Math.trunc(Number(selection[line.key] ?? 0));
    if (!units || units < 0 || line.ambiguous || units > line.remainingSoldUnits) continue;
    out.push({ line, baseQty: units * line.unitsPerItem });
  }
  return out;
}

/**
 * PFIN-F: the request items from the server's plan. Every selected line must be a real sale line (sale_items id).
 * `amounts[lineKey]`: the line's refund amount (the plan's default, or a manager-adjusted one); `payouts`: how the
 * money goes back (null: none named — a single-method sale keeps the legacy rule). Each item carries its line; its
 * payouts are distributed with distributePayouts.
 */
export function buildPlannedRefundItems(
  state: RefundState, selection: Readonly<Record<string, number>>,
  options: { amounts: Readonly<Record<string, number>>; noRestock: Readonly<Record<string, boolean>>; payouts: readonly RefundPayout[] | null },
): { ok: true; items: DetailedRefundItem[] } | { ok: false; problem: "LINE_UNKNOWN" | "AMOUNT" | "PAYOUTS" } {
  const chosen = selectedRefundLines(state, selection);
  const amounts: number[] = [];
  for (const { line } of chosen) {
    if (line.key.includes("#")) return { ok: false, problem: "LINE_UNKNOWN" };
    const a = options.amounts[line.key];
    if (typeof a !== "number" || !Number.isInteger(a) || a < 0) return { ok: false, problem: "AMOUNT" };
    amounts.push(a);
  }
  const spread = options.payouts ? distributePayouts(amounts, options.payouts) : null;
  if (options.payouts && !spread) return { ok: false, problem: "PAYOUTS" };
  return {
    ok: true,
    items: chosen.map(({ line, baseQty }, i) => {
      const item: DetailedRefundItem = {
        productId: line.productId, qtyUnits: baseQty, amountMmk: amounts[i],
        lines: [{ saleItemId: line.key, qtyUnits: baseQty, amountMmk: amounts[i], restock: options.noRestock[line.key] !== true }],
      };
      if (spread && spread[i].length > 0) item.payouts = spread[i];
      return item;
    }),
  };
}
