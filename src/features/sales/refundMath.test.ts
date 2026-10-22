import { describe, it, expect } from "vitest";
import type { RefundVoidRequest, SaleItem } from "../../types";
import {
  allocateNetLineAmounts, attachRefundLines, buildPlannedRefundItems, buildRefundState, defaultRefundPayouts, distributePayouts, planRefundRequest,
  refundRequestExcessMmk,
} from "./refundMath";

// Sales are built the way complete_sale (072) stores them: line_total after
// the item discount, total = Σ lines − round(Σ lines × cart% / 100),
// qty_units in BASE units.
const item = (id: string, productId: string, qtyUnits: number, lineTotalMmk: number, unitsPerItem = 1): SaleItem => ({
  id, saleId: "sale-1", productId, qtyUnits, unitPriceMmk: lineTotalMmk / (qtyUnits / unitsPerItem), lineTotalMmk,
  unitsPerItem, unitBaseQuantitySnapshot: unitsPerItem, unitNameSnapshot: unitsPerItem > 1 ? "Pack" : "Piece",
});
const saleOf = (items: SaleItem[], cartPct: number) => {
  const sum = items.reduce((s, i) => s + i.lineTotalMmk, 0);
  return { id: "sale-1", status: "NORMAL" as const, totalMmk: Math.max(0, sum - Math.round((sum * cartPct) / 100)) };
};
let seq = 0;
const request = (items: { productId: string; qtyUnits: number; amountMmk: number }[], status: RefundVoidRequest["status"] = "APPROVED"): RefundVoidRequest => ({
  id: `req-${++seq}`, saleId: "sale-1", shopId: "shop-1", type: "PARTIAL", reason: "r", createdBy: "u1", createdAt: "t", items, status,
});

describe("allocateNetLineAmounts", () => {
  it("spreads a 20% cart discount proportionally and the nets sum exactly to the sale total", () => {
    const nets = allocateNetLineAmounts([{ key: "a", totalMmk: 1000 }, { key: "b", totalMmk: 2000 }, { key: "c", totalMmk: 3000 }], 4800);
    expect([...nets.values()]).toEqual([800, 1600, 2400]);
  });

  it("rounds by largest remainder with deterministic ties, still summing exactly", () => {
    // Σ 3 × 1001 = 3003, total 3000 → 3 MMK discount, 1 per line exactly
    const exact = allocateNetLineAmounts([{ key: "a", totalMmk: 1001 }, { key: "b", totalMmk: 1001 }, { key: "c", totalMmk: 1001 }], 3000);
    expect([...exact.values()]).toEqual([1000, 1000, 1000]);
    // 2 MMK over 3 equal lines: ties go to the lowest keys
    const ties = allocateNetLineAmounts([{ key: "c", totalMmk: 1000 }, { key: "a", totalMmk: 1000 }, { key: "b", totalMmk: 1000 }], 2998);
    expect(ties.get("a")).toBe(999);
    expect(ties.get("b")).toBe(999);
    expect(ties.get("c")).toBe(1000);
    expect([...ties.values()].reduce((s, v) => s + v, 0)).toBe(2998);
  });

  it("no discount → nets are the line totals; 100% discount → all zero", () => {
    expect([...allocateNetLineAmounts([{ key: "a", totalMmk: 700 }, { key: "b", totalMmk: 300 }], 1000).values()]).toEqual([700, 300]);
    expect([...allocateNetLineAmounts([{ key: "a", totalMmk: 700 }, { key: "b", totalMmk: 300 }], 0).values()]).toEqual([0, 0]);
  });

  it("is exact on large amounts (BigInt, no float drift)", () => {
    const nets = allocateNetLineAmounts([{ key: "a", totalMmk: 4_999_999_999 }, { key: "b", totalMmk: 3_000_000_001 }], 7_200_000_000);
    expect([...nets.values()].reduce((s, v) => s + v, 0)).toBe(7_200_000_000);
  });
});

describe("refund requests (ORV-002 / ORV-006)", () => {
  it("a full refund of a line pays what the customer paid after the cart discount, not the line total", () => {
    const items = [item("i1", "p1", 2, 10_000), item("i2", "p2", 1, 5_000)];
    const sale = saleOf(items, 20); // 15,000 − 3,000 = 12,000
    const plan = planRefundRequest(buildRefundState(sale, items, []), { i1: 2 });
    expect(plan.errors).toEqual([]);
    expect(plan.items).toEqual([{ productId: "p1", qtyUnits: 2, amountMmk: 8_000 }]); // not 10,000
  });

  it("refunding everything returns exactly the sale total", () => {
    const items = [item("i1", "p1", 3, 1_000), item("i2", "p2", 7, 2_333), item("i3", "p3", 1, 99)];
    const sale = saleOf(items, 13);
    const plan = planRefundRequest(buildRefundState(sale, items, []), { i1: 3, i2: 7, i3: 1 });
    expect(plan.totalMmk).toBe(sale.totalMmk);
  });

  it("three successive partial refunds of one line sum exactly to its net amount", () => {
    const items = [item("i1", "p1", 3, 1_000)];
    const sale = saleOf(items, 0); // net 1,000 for 3 units
    const requests: RefundVoidRequest[] = [];
    const amounts: number[] = [];
    for (let k = 0; k < 3; k += 1) {
      const plan = planRefundRequest(buildRefundState(sale, items, requests), { i1: 1 });
      expect(plan.errors).toEqual([]);
      amounts.push(plan.totalMmk);
      requests.push(request(plan.items));
    }
    expect(amounts).toEqual([333, 333, 334]);
    expect(amounts.reduce((s, v) => s + v, 0)).toBe(1_000);
    const after = buildRefundState(sale, items, requests);
    expect(after.fullyRefunded).toBe(true);
    expect(after.lines[0].remainingSoldUnits).toBe(0);
  });

  it("blocks over-refund: more units than remain, and anything beyond the sale total already refunded", () => {
    const items = [item("i1", "p1", 2, 10_000), item("i2", "p2", 1, 5_000)];
    const sale = saleOf(items, 20);
    const one = buildRefundState(sale, items, [request([{ productId: "p1", qtyUnits: 1, amountMmk: 4_000 }])]);
    expect(planRefundRequest(one, { i1: 2 }).errors.join(" ")).toMatch(/Only 1/);
    // An older app refunded p1 at the PRE-discount line total (10,000):
    // only 2,000 of the 12,000 sale total is left, so p2's 4,000 net is too much.
    const legacy = buildRefundState(sale, items, [request([{ productId: "p1", qtyUnits: 2, amountMmk: 10_000 }])]);
    const plan = planRefundRequest(legacy, { i2: 1 });
    expect(plan.errors.join(" ")).toMatch(/exceed what is left of the sale total \(2000 MMK\)/);
  });

  it("a product on two lines (different unit/price level) is not refundable per line; other lines are", () => {
    const items = [item("i1", "p1", 1, 1_000), item("i2", "p1", 12, 9_000, 12), item("i3", "p2", 1, 500)];
    const state = buildRefundState(saleOf(items, 0), items, []);
    expect(state.lines.filter((l) => l.ambiguous).map((l) => l.key)).toEqual(["i1", "i2"]);
    expect(planRefundRequest(state, { i1: 1 }).errors.join(" ")).toMatch(/more than one line/);
    expect(planRefundRequest(state, { i3: 1 })).toMatchObject({ errors: [], items: [{ productId: "p2", qtyUnits: 1, amountMmk: 500 }] });
  });

  it("works in the unit sold: one pack of 12 sends 12 base units and half the net", () => {
    const items = [item("i1", "p1", 24, 20_000, 12)]; // 2 packs of 12
    const state = buildRefundState(saleOf(items, 10), items, []); // net 18,000
    expect(state.lines[0].remainingSoldUnits).toBe(2);
    expect(planRefundRequest(state, { i1: 1 }).items).toEqual([{ productId: "p1", qtyUnits: 12, amountMmk: 9_000 }]);
  });

  it("a pending request blocks a second one (the server allows one pending refund per sale); rejected ones do not count", () => {
    const items = [item("i1", "p1", 2, 1_000)];
    const sale = saleOf(items, 0);
    const pending = buildRefundState(sale, items, [request([{ productId: "p1", qtyUnits: 1, amountMmk: 500 }], "REQUESTED")]);
    expect(pending.hasPendingRefund).toBe(true);
    expect(planRefundRequest(pending, { i1: 1 }).errors.join(" ")).toMatch(/already waiting/);
    const rejected = buildRefundState(sale, items, [request([{ productId: "p1", qtyUnits: 2, amountMmk: 1_000 }], "REJECTED")]);
    expect(rejected.lines[0].remainingSoldUnits).toBe(2);
  });

  it("derives 'partially refunded' (the server marks any refunded sale REFUNDED)", () => {
    const items = [item("i1", "p1", 2, 1_000)];
    const sale = { ...saleOf(items, 0), status: "REFUNDED" as const };
    const state = buildRefundState(sale, items, [request([{ productId: "p1", qtyUnits: 1, amountMmk: 500 }])]);
    expect(state.partiallyRefunded).toBe(true);
    expect(state.fullyRefunded).toBe(false);
  });

  it("rejects negative and empty selections", () => {
    const items = [item("i1", "p1", 2, 1_000)];
    const state = buildRefundState(saleOf(items, 0), items, []);
    expect(planRefundRequest(state, {}).items).toEqual([]);
    expect(planRefundRequest(state, { i1: -1 }).errors.join(" ")).toMatch(/negative/);
  });
});

describe("refundRequestExcessMmk (approver warning)", () => {
  const items = [item("i1", "p1", 2, 10_000), item("i2", "p2", 1, 5_000)];
  const sale = saleOf(items, 20);

  it("flags a request raised with the pre-discount line total by exactly the excess", () => {
    const oldClient = request([{ productId: "p1", qtyUnits: 1, amountMmk: 5_000 }], "REQUESTED"); // net share is 4,000
    expect(refundRequestExcessMmk(oldClient, sale, items, [oldClient])).toBe(1_000);
  });

  it("accepts a request built by this version", () => {
    const plan = planRefundRequest(buildRefundState(sale, items, []), { i1: 1, i2: 1 });
    const fresh = request(plan.items, "REQUESTED");
    expect(refundRequestExcessMmk(fresh, sale, items, [fresh])).toBe(0);
  });
});

describe("attachRefundLines (Step 4, PFIN-E)", () => {
  const items = [item("i1", "p1", 3, 3000), item("i2", "p2", 2, 1000)];
  const sale = saleOf(items, 0);
  it("each planned item names its sale line, quantity and amount; restock is per line; a payout only when chosen", () => {
    const state = buildRefundState(sale, items, []);
    const selection = { i1: 1, i2: 2 };
    const plan = planRefundRequest(state, selection);
    const out = attachRefundLines(state, selection, plan, { serverSale: true, noRestock: { i2: true }, payoutMethod: null });
    expect(out).toEqual([
      { productId: "p1", qtyUnits: 1, amountMmk: 1000, lines: [{ saleItemId: "i1", qtyUnits: 1, amountMmk: 1000, restock: true }] },
      { productId: "p2", qtyUnits: 2, amountMmk: 1000, lines: [{ saleItemId: "i2", qtyUnits: 2, amountMmk: 1000, restock: false }] },
    ]);
    const paid = attachRefundLines(state, selection, plan, { serverSale: true, noRestock: {}, payoutMethod: "BANK_TRANSFER" });
    expect(paid.map((i) => i.payouts)).toEqual([[{ method: "BANK_TRANSFER", amountMmk: 1000 }], [{ method: "BANK_TRANSFER", amountMmk: 1000 }]]);
    // the legacy fields are exactly the plan's (the pinned approval reads only those)
    expect(out.map(({ productId, qtyUnits, amountMmk }) => ({ productId, qtyUnits, amountMmk }))).toEqual(plan.items);
  });
  it("a sale the server does not have yet (provisional line ids) keeps the legacy items", () => {
    const state = buildRefundState(sale, items, []);
    const plan = planRefundRequest(state, { i1: 1 });
    expect(attachRefundLines(state, { i1: 1 }, plan, { serverSale: false, noRestock: { i1: true }, payoutMethod: "CASH" })).toEqual(plan.items);
  });
});

// ---------------------------------------------------------------- Step 6 (PFIN-F) split-payment refunds

describe("defaultRefundPayouts (mirrors PFIN-F fin_refund_default_payouts)", () => {
  const paid = [{ method: "CASH", paidMmk: 1_800, attributedRefundedMmk: 0 }, { method: "BANK_TRANSFER", paidMmk: 1_200, attributedRefundedMmk: 0 }];
  it("shares the refund in proportion to what each method paid, sorted by method", () => {
    expect(defaultRefundPayouts(paid, 3_000)).toEqual([{ method: "BANK_TRANSFER", amountMmk: 1_200 }, { method: "CASH", amountMmk: 1_800 }]);
    expect(defaultRefundPayouts(paid, 1_000)).toEqual([{ method: "BANK_TRANSFER", amountMmk: 400 }, { method: "CASH", amountMmk: 600 }]);
  });
  it("the rounding leftover goes to the largest remainder (then method name)", () => {
    expect(defaultRefundPayouts(paid, 1_001)).toEqual([{ method: "BANK_TRANSFER", amountMmk: 400 }, { method: "CASH", amountMmk: 601 }]);
    const even = [{ method: "CARD", paidMmk: 1, attributedRefundedMmk: 0 }, { method: "CASH", paidMmk: 1, attributedRefundedMmk: 0 }];
    expect(defaultRefundPayouts(even, 1)).toEqual([{ method: "CARD", amountMmk: 1 }]);
  });
  it("is cumulative: what each method already got back is deducted; a full refund returns exactly what is left", () => {
    const after = paid.map((m) => ({ ...m, attributedRefundedMmk: m.method === "CASH" ? 601 : 400 }));
    expect(defaultRefundPayouts(after, 1_999)).toEqual([{ method: "BANK_TRANSFER", amountMmk: 800 }, { method: "CASH", amountMmk: 1_199 }]);
  });
  it("review 1 F1: when several methods already got back more than their share, the excess is taken back (never null)", () => {
    const three = [{ method: "CASH", paidMmk: 2_000, attributedRefundedMmk: 1_994 }, { method: "BANK_TRANSFER", paidMmk: 500, attributedRefundedMmk: 500 },
      { method: "MOBILE_WALLET", paidMmk: 2_000, attributedRefundedMmk: 1_994 }];
    expect(defaultRefundPayouts(three, 3)).toEqual([{ method: "CASH", amountMmk: 1 }, { method: "MOBILE_WALLET", amountMmk: 2 }]);
    const k = [{ method: "CASH", paidMmk: 3_500, attributedRefundedMmk: 14 }, { method: "BANK_TRANSFER", paidMmk: 2_500, attributedRefundedMmk: 91 },
      { method: "MOBILE_WALLET", paidMmk: 4_000, attributedRefundedMmk: 895 }];
    expect(defaultRefundPayouts(k, 1_000)).toEqual([{ method: "BANK_TRANSFER", amountMmk: 314 }, { method: "CASH", amountMmk: 686 }]);   // = PFIN-F (fin_policy p6d0)
  });
  it("property: any sequence of refunds up to the total gets an exact default within what each method has left", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return 1 + (seed % n); };
    for (let trial = 0; trial < 2_000; trial++) {
      const ms = ["BANK_TRANSFER", "CARD", "CASH", "MOBILE_WALLET", "OTHER"].slice(0, 2 + (trial % 4));
      const state = ms.map((method) => ({ method, paidMmk: rnd(3_000), attributedRefundedMmk: 0 }));
      let left = state.reduce((s, m) => s + m.paidMmk, 0);
      while (left > 0) {
        const x = rnd(left);
        const d = defaultRefundPayouts(state, x);
        expect(d).not.toBeNull();
        expect(d!.reduce((s, p) => s + p.amountMmk, 0)).toBe(x);
        for (const p of d!) {
          const m = state.find((s) => s.method === p.method)!;
          m.attributedRefundedMmk += p.amountMmk;
          expect(m.attributedRefundedMmk).toBeLessThanOrEqual(m.paidMmk);
        }
        left -= x;
      }
    }
  });
  it("never more than what is left (null), nothing for nothing", () => {
    expect(defaultRefundPayouts(paid, 3_001)).toBeNull();
    expect(defaultRefundPayouts([], 10)).toBeNull();
    expect(defaultRefundPayouts(paid, 0)).toEqual([]);
  });
});

describe("distributePayouts", () => {
  it("fills the items in order from the methods in order; each item's payouts add up to its amount", () => {
    expect(distributePayouts([1_000, 2_000], [{ method: "BANK_TRANSFER", amountMmk: 1_200 }, { method: "CASH", amountMmk: 1_800 }])).toEqual([
      [{ method: "BANK_TRANSFER", amountMmk: 1_000 }],
      [{ method: "BANK_TRANSFER", amountMmk: 200 }, { method: "CASH", amountMmk: 1_800 }],
    ]);
  });
  it("an item of 0 gets no payout; totals that do not match are refused", () => {
    expect(distributePayouts([0, 500], [{ method: "CASH", amountMmk: 500 }])).toEqual([[], [{ method: "CASH", amountMmk: 500 }]]);
    expect(distributePayouts([1_000], [{ method: "CASH", amountMmk: 999 }])).toBeNull();
  });
});

describe("buildPlannedRefundItems", () => {
  const items: SaleItem[] = [
    { id: "si-1", saleId: "s1", productId: "p1", qtyUnits: 2, unitPriceMmk: 1_000, lineTotalMmk: 2_000 },
    { id: "si-2", saleId: "s1", productId: "p2", qtyUnits: 1, unitPriceMmk: 1_000, lineTotalMmk: 1_000 },
  ];
  const state = buildRefundState({ id: "s1", status: "NORMAL", totalMmk: 3_000 }, items, []);
  it("every item names its sale line (with the plan's amount) and its share of the payouts", () => {
    const r = buildPlannedRefundItems(state, { "si-1": 2, "si-2": 1 }, {
      amounts: { "si-1": 2_000, "si-2": 1_000 }, noRestock: { "si-2": true },
      payouts: [{ method: "BANK_TRANSFER", amountMmk: 1_200 }, { method: "CASH", amountMmk: 1_800 }],
    });
    expect(r).toEqual({ ok: true, items: [
      { productId: "p1", qtyUnits: 2, amountMmk: 2_000, lines: [{ saleItemId: "si-1", qtyUnits: 2, amountMmk: 2_000, restock: true }],
        payouts: [{ method: "BANK_TRANSFER", amountMmk: 1_200 }, { method: "CASH", amountMmk: 800 }] },
      { productId: "p2", qtyUnits: 1, amountMmk: 1_000, lines: [{ saleItemId: "si-2", qtyUnits: 1, amountMmk: 1_000, restock: false }],
        payouts: [{ method: "CASH", amountMmk: 1_000 }] },
    ] });
  });
  it("a single-method sale names no payouts (legacy rule); bad amounts or payouts are refused", () => {
    const r = buildPlannedRefundItems(state, { "si-2": 1 }, { amounts: { "si-2": 900 }, noRestock: {}, payouts: null });
    expect(r.ok && r.items[0].payouts).toBeUndefined();
    expect(buildPlannedRefundItems(state, { "si-2": 1 }, { amounts: {}, noRestock: {}, payouts: null })).toEqual({ ok: false, problem: "AMOUNT" });
    expect(buildPlannedRefundItems(state, { "si-2": 1 }, { amounts: { "si-2": 1_000 }, noRestock: {}, payouts: [{ method: "CASH", amountMmk: 1 }] }))
      .toEqual({ ok: false, problem: "PAYOUTS" });
  });
});
