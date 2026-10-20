import { describe, expect, it } from "vitest";
import type { Product, RefundVoidRequest, Sale, SaleItem, Shop } from "../../types";
import {
  calculateAvgOrderValue,
  calculateCostOfGoods,
  calculateDailyRevenueCostProfitTrend,
  calculateNetRevenue,
  calculatePerShopMetrics,
  calculateProfit,
  calculateSalesCount,
  filterSalesByRange,
  scopeSales,
} from "../dashboard/dashboardMetrics";
import { buildRefundState, planRefundRequest } from "../sales/refundMath";
import { calculateProfitByShop } from "./profitByShop";
import { mapRefund } from "../../stores/data/mappers";
import { calculateShopReportSummary } from "./shopReportSummary";
import { filterSalesByBusinessDay, groupSalesByBusinessDay } from "../sales/salesDayGroups";

// ----------------------------------------------------------------------
// One shop's day of trade, checked through every report path against
// totals worked out by hand (ORV-034). Refund amounts come from the app's
// own request builder (refundMath), so a cart discount is refunded at what
// the customer actually paid. Quantities are base units, as the server
// stores them. All timestamps are Yangon wall-clock times (ORV-069).
//
//  sale  pay    status    lines (qty × price)                total  refund
//  S1    CASH   NORMAL    A 2×1000                            2000   —
//  S2    OTHER  REFUNDED  A 3×1000, B 2×700, 10% cart disc   3960   1 A → 900
//  S3    CASH   REFUNDED  B 1×700                              700   1 B → 700 (all)
//  S4    CASH   VOID      A 5×1000                            5000   (void)
//  S5    CASH   NORMAL    A 1×1000                            1000   REQUESTED 1000, REJECTED 500
//  S6    CASH   NORMAL    A 1×1000 — shop B                   1000   —
//
//  Cost A = 600, B = 400 (S2's A line carries a 550 sale-time snapshot).
//
//  Shop A net revenue = 2000 + (3960−900) + (700−700) + 1000          = 6060
//  Shop A cost        = 1200 + (3×550 + 2×400 − 550) + (400 − 400) + 600 = 3700
//  Shop A profit      = 2360;  orders 4;  avg order round(6060/4)      = 1515
//  Shop A cash        = 2000 + 0 + 1000 = 3000;  other = 3960 − 900    = 3060
//  All shops          = revenue 7060, cost 4300
// ----------------------------------------------------------------------

const YGN = 6.5 * 3_600_000;
const ygn = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min) - YGN).toISOString();
const DAY = (h: number, min = 0) => ygn(2026, 10, 19, h, min);
const NOW = new Date(Date.UTC(2026, 9, 19, 22, 0) - YGN); // 22:00 Yangon

const products: Product[] = [
  { id: "A", name: "Beer", category: "beer", unitType: "can", priceMmk: 1000, costMmk: 600, lowStockThreshold: 1, isActive: true, createdAt: "" },
  { id: "B", name: "Soda", category: "soft", unitType: "can", priceMmk: 700, costMmk: 400, lowStockThreshold: 1, isActive: true, createdAt: "" },
];
const shops: Shop[] = [
  { id: "shop-a", name: "Shop A" } as Shop,
  { id: "shop-b", name: "Shop B" } as Shop,
];

const sale = (o: Partial<Sale> & Pick<Sale, "id" | "totalMmk">): Sale => ({
  shopId: "shop-a", shiftId: "sh1", receiptNo: o.id, cashierId: "u1", status: "NORMAL",
  subtotalMmk: o.totalMmk, discountMmk: 0, paymentMethod: "CASH", paidMmk: o.totalMmk, changeMmk: 0,
  createdAt: DAY(10), ...o,
});
const line = (id: string, saleId: string, productId: string, qty: number, price: number, o: Partial<SaleItem> = {}): SaleItem => ({
  id, saleId, productId, qtyUnits: qty, unitPriceMmk: price, lineTotalMmk: qty * price, ...o,
});

const sales: Sale[] = [
  sale({ id: "S1", totalMmk: 2000, createdAt: DAY(0, 15) }), // 00:15 Yangon = previous UTC day
  sale({ id: "S2", status: "REFUNDED", paymentMethod: "OTHER", subtotalMmk: 4400, discountMmk: 440, cartDiscountPct: 10, totalMmk: 3960, createdAt: DAY(9) }),
  sale({ id: "S3", status: "REFUNDED", totalMmk: 700, createdAt: DAY(12) }),
  sale({ id: "S4", status: "VOID", totalMmk: 5000, createdAt: DAY(13) }),
  sale({ id: "S5", totalMmk: 1000, createdAt: DAY(18) }),
  sale({ id: "S6", shopId: "shop-b", totalMmk: 1000, createdAt: DAY(19) }),
];
const items: SaleItem[] = [
  line("i11", "S1", "A", 2, 1000),
  line("i21", "S2", "A", 3, 1000, { unitCostMmkSnapshot: 550 }),
  line("i22", "S2", "B", 2, 700),
  line("i31", "S3", "B", 1, 700),
  line("i41", "S4", "A", 5, 1000),
  line("i51", "S5", "A", 1, 1000),
  line("i61", "S6", "A", 1, 1000),
];

const planned = (saleId: string, selection: Record<string, number>) => {
  const target = sales.find((s) => s.id === saleId)!;
  const plan = planRefundRequest(buildRefundState(target, items, []), selection);
  expect(plan.errors).toEqual([]);
  return plan.items;
};
const request = (id: string, saleId: string, status: RefundVoidRequest["status"], reqItems: RefundVoidRequest["items"]): RefundVoidRequest => ({
  id, saleId, shopId: "shop-a", type: "PARTIAL", reason: "test", createdBy: "u1", createdAt: DAY(20), status, items: reqItems,
});
const refunds: RefundVoidRequest[] = [
  request("R2", "S2", "APPROVED", planned("S2", { i21: 1 })),
  request("R3", "S3", "APPROVED", planned("S3", { i31: 1 })),
  request("R5a", "S5", "REQUESTED", [{ productId: "A", qtyUnits: 1, amountMmk: 1000 }]),
  request("R5b", "S5", "REJECTED", [{ productId: "A", qtyUnits: 1, amountMmk: 500 }]),
  { ...request("V4", "S4", "APPROVED", undefined), type: "VOID" },
];

describe("refund amounts come from what was paid (refundMath)", () => {
  it("refunds 1 of 3 discounted A at 900 and the whole of S3 at 700", () => {
    expect(refunds[0].items).toEqual([{ productId: "A", qtyUnits: 1, amountMmk: 900 }]);
    expect(refunds[1].items).toEqual([{ productId: "B", qtyUnits: 1, amountMmk: 700 }]);
  });
});

describe("dashboard KPIs (store-backed)", () => {
  const shopA = filterSalesByRange(scopeSales(sales, "shop-a"), "today", NOW);

  it("keeps partly/wholly refunded sales and drops the void", () => {
    expect(shopA.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S5"]);
  });

  it("matches the hand-worked totals", () => {
    const revenue = calculateNetRevenue(shopA, refunds);
    const cost = calculateCostOfGoods(shopA, items, products, refunds);
    expect({ revenue, cost, profit: calculateProfit(revenue, cost) }).toEqual({ revenue: 6060, cost: 3700, profit: 2360 });
    expect(calculateSalesCount(shopA)).toBe(4);
    expect(calculateAvgOrderValue(revenue, calculateSalesCount(shopA))).toBe(1515);
  });

  it("per-shop and all-shops figures agree", () => {
    const rows = calculatePerShopMetrics(sales, items, products, shops, refunds, [], []);
    expect(rows.map((r) => [r.shop.id, r.orders, r.revenue, r.cost, r.profit])).toEqual([
      ["shop-a", 4, 6060, 3700, 2360],
      ["shop-b", 1, 1000, 600, 400],
    ]);
    const all = filterSalesByRange(scopeSales(sales, null), "today", NOW);
    expect(calculateNetRevenue(all, refunds)).toBe(7060);
    expect(calculateCostOfGoods(all, items, products, refunds)).toBe(4300);
  });

  it("puts the 00:15 sale on the same business day in the trend", () => {
    expect(sales[0].createdAt.slice(0, 10)).toBe("2026-10-18"); // its UTC date
    const trend = calculateDailyRevenueCostProfitTrend(sales, items, products, refunds, "shop-a", "today", NOW);
    expect(trend).toEqual([{ date: "2026-10-19", label: "2026-10-19", revenue: 6060, cost: 3700, profit: 2360 }]);
  });
});

describe("Profit Reports (server-ranged rows)", () => {
  // The shapes useRangedSales builds, with refunds mapped from DB rows by the
  // store's mapper — including one written with snake_case keys, which the
  // server also accepts (070 COALESCE) and stores as sent.
  const ranged = sales.map(({ id, shopId, status, totalMmk, paymentMethod, createdAt }) => ({ id, shopId, status, totalMmk, paymentMethod, createdAt }));
  const rangedItems = items.map(({ saleId, productId, qtyUnits, unitCostMmkSnapshot }) => ({ saleId, productId, qtyUnits, unitCostMmkSnapshot }));
  const dbRefunds = [
    { id: "R2", sale_id: "S2", shop_id: "shop-a", type: "PARTIAL", status: "APPROVED", items: [{ productId: "A", qtyUnits: 1, amountMmk: 900 }] },
    { id: "R3", sale_id: "S3", shop_id: "shop-a", type: "PARTIAL", status: "APPROVED", items: [{ product_id: "B", qty_units: "1", amount_mmk: "700" }] },
    { id: "R5a", sale_id: "S5", shop_id: "shop-a", type: "PARTIAL", status: "REQUESTED", items: [{ productId: "A", qtyUnits: 1, amountMmk: 1000 }] },
  ].map(mapRefund);

  it("matches the dashboard for the business day", () => {
    const rows = calculateProfitByShop({
      shops, sales: ranged, saleItems: rangedItems, refunds: dbRefunds, products,
      range: { start: "2026-10-19", end: "2026-10-19" }, shopId: null,
    });
    expect(rows.map((r) => [r.shopId, r.revenue, r.cost, r.profit, Math.round(r.margin * 100) / 100])).toEqual([
      ["shop-a", 6060, 3700, 2360, 38.94],
      ["shop-b", 1000, 600, 400, 40],
    ]);
  });

  it("excludes a range that ends the business day before", () => {
    const rows = calculateProfitByShop({
      shops, sales: ranged, saleItems: rangedItems, refunds: dbRefunds, products,
      range: { start: "2026-10-18", end: "2026-10-18" }, shopId: "shop-a",
    });
    expect(rows).toEqual([{ shopId: "shop-a", shopName: "Shop A", revenue: 0, cost: 0, profit: 0, margin: 0 }]);
  });
});

// ---------------------------------------------------------------- pages
// Store-backed pages cannot be rendered with data here (zustand serves its
// initial state to a server render, and no DOM environment is installed),
// so the pages compute through these pure functions, tested directly.

describe("Reports page (shop) summary", () => {
  it("shows net total, cash and other for shop A", () => {
    const summary = calculateShopReportSummary(sales, refunds, "shop-a");
    expect(summary).toEqual({
      totalSales: 6060,
      cashSales: 3000,
      otherSales: 3060,
      dailyTotals: [["2026-10-19", 6060]],
    });
  });

  it("shows nothing without a resolved shop (never the whole org)", () => {
    expect(calculateShopReportSummary(sales, refunds, "").totalSales).toBe(0);
  });
});

describe("Sales page day sections", () => {
  it("lists every shop-A sale of the business day and heads it with net takings", () => {
    const shopA = sales.filter((s) => s.shopId === "shop-a");
    const today = filterSalesByBusinessDay(shopA, "2026-10-19");
    expect(today.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5"]); // 00:15 sale included
    expect(filterSalesByBusinessDay(shopA, "2026-10-18")).toEqual([]);
    const groups = groupSalesByBusinessDay(today, refunds);
    expect(groups.map((g) => [g.day, g.sales.length, g.netTotal])).toEqual([["2026-10-19", 5, 6060]]);
  });

  it("splits a sale at 23:59 and one at 00:01 Yangon into two days", () => {
    const pair = [
      sale({ id: "late", totalMmk: 100, createdAt: ygn(2026, 12, 31, 23, 59) }),
      sale({ id: "early", totalMmk: 200, createdAt: ygn(2027, 1, 1, 0, 1) }),
    ];
    expect(groupSalesByBusinessDay(pair, []).map((g) => [g.day, g.netTotal])).toEqual([
      ["2026-12-31", 100],
      ["2027-01-01", 200],
    ]);
  });
});
