import { describe, expect, it } from "vitest";
import type {
  Inventory,
  Product,
  PurchaseOrder,
  RefundVoidRequest,
  Sale,
  SaleItem,
  Shift,
  Shop,
  StockTransfer,
  Supplier,
  User,
} from "../../types";
import {
  calculateActionNeeded,
  calculateAvgOrderValue,
  calculateCashVsOther,
  calculateCategoryRevenue,
  calculateCostOfGoods,
  calculateDailyRevenueCostProfitTrend,
  calculateExpectedCashForActiveShifts,
  calculateGrossRevenue,
  calculateInventoryValue,
  calculateLowStock,
  calculateNetRevenue,
  calculatePerShopMetrics,
  calculateProfit,
  calculateProfitMargin,
  calculateRefundDeductions,
  calculateSalesByCategoryPercent,
  calculateSalesCount,
  calculateSupplierDebt,
  calculateTopProducts,
  dateRangeStart,
  filterActiveShifts,
  filterPendingApprovals,
  filterPendingReceipts,
  filterPendingTransfers,
  filterSalesByRange,
  getDashboardVisibility,
  groupSupplierDebtByShop,
  groupSupplierDebtBySupplier,
  listActiveShiftRows,
  recentAuditLogs,
  recentTransfers,
  resolveDashboardScope,
  scopeSales,
  netRefundedLines,
} from "./dashboardMetrics";

// Dashboard days are business days in Asia/Yangon (UTC+06:30, no DST —
// ORV-069). Fixtures are built from Yangon wall-clock times so every case
// passes whatever time zone the test machine is in.
const YGN_OFFSET_MS = 6.5 * 3_600_000;
/** A Date at Yangon wall-clock time; month 0-based like `new Date(y, m, d, h)`. */
const ygnDate = (y: number, m: number, d: number, h = 0, min = 0): Date =>
  new Date(Date.UTC(y, m, d, h, min) - YGN_OFFSET_MS);

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------
const product = (overrides: Partial<Product>): Product => ({
  id: "prod",
  name: "Product",
  category: "beer",
  unitType: "piece",
  priceMmk: 1000,
  costMmk: 600,
  lowStockThreshold: 5,
  isActive: true,
  createdAt: "",
  ...overrides,
});

const sale = (overrides: Partial<Sale>): Sale => ({
  id: "sale",
  shopId: "shop-a",
  shiftId: "shift-1",
  receiptNo: "A-001",
  cashierId: "u-cash",
  status: "NORMAL",
  subtotalMmk: 1000,
  discountMmk: 0,
  totalMmk: 1000,
  paymentMethod: "CASH",
  paidMmk: 1000,
  changeMmk: 0,
  createdAt: "2026-05-10T08:00:00.000Z",
  ...overrides,
});

const item = (overrides: Partial<SaleItem>): SaleItem => ({
  saleId: "sale",
  productId: "prod",
  qtyUnits: 1,
  unitPriceMmk: 1000,
  lineTotalMmk: 1000,
  ...overrides,
});

const inv = (shopId: string, productId: string, qty: number): Inventory => ({
  shopId,
  productId,
  qtyBaseUnits: qty,
});

const po = (overrides: Partial<PurchaseOrder>): PurchaseOrder => ({
  id: "po",
  orderNo: "PO-1",
  shopId: "shop-a",
  supplierId: "sup-1",
  status: "RECEIVED",
  subtotalMmk: 10000,
  totalMmk: 10000,
  paidMmk: 0,
  paymentStatus: "UNPAID",
  createdBy: "u-admin",
  createdAt: "",
  ...overrides,
});

const refund = (overrides: Partial<RefundVoidRequest>): RefundVoidRequest => ({
  id: "r",
  saleId: "sale",
  shopId: "shop-a",
  type: "PARTIAL",
  reason: "x",
  createdBy: "u-cash",
  createdAt: "",
  status: "APPROVED",
  items: [{ productId: "prod", qtyUnits: 1, amountMmk: 0 }],
  ...overrides,
});

const user = (overrides: Partial<User>): User => ({
  id: "u",
  name: "User",
  role: "MANAGER",
  shopId: "shop-a",
  isActive: true,
  createdAt: "",
  ...overrides,
});

// ------------------------------------------------------------
// scopeSales
// ------------------------------------------------------------
describe("scopeSales", () => {
  const sales: Sale[] = [
    sale({ id: "n-a", shopId: "shop-a", status: "NORMAL" }),
    sale({ id: "n-b", shopId: "shop-b", status: "NORMAL" }),
    sale({ id: "void-a", shopId: "shop-a", status: "VOID" }),
    sale({ id: "refunded-a", shopId: "shop-a", status: "REFUNDED" }),
  ];

  it("excludes VOID but keeps REFUNDED (partly refunded) sales — ORV-034", () => {
    // approve_refund_request (070) marks the WHOLE sale REFUNDED on any
    // approved partial refund; dropping it lost the units that were kept.
    const out = scopeSales(sales, null);
    expect(out.map((s) => s.id).sort()).toEqual(["n-a", "n-b", "refunded-a"]);
  });

  it("restricts to a single shop when shopId is provided", () => {
    expect(scopeSales(sales, "shop-a").map((s) => s.id)).toEqual(["n-a", "refunded-a"]);
    expect(scopeSales(sales, "shop-b").map((s) => s.id)).toEqual(["n-b"]);
  });

  it("returns empty list for a shop with no sales (not all sales)", () => {
    expect(scopeSales(sales, "shop-ghost")).toEqual([]);
  });
});

// ------------------------------------------------------------
// Revenue + refunds
// ------------------------------------------------------------
describe("calculateGrossRevenue", () => {
  it("sums sale.totalMmk (cash basis, post cart-discount)", () => {
    const sales: Sale[] = [
      sale({ id: "s1", totalMmk: 9500, subtotalMmk: 10000 }), // 5% cart discount
      sale({ id: "s2", totalMmk: 2200 }),
    ];
    expect(calculateGrossRevenue(sales)).toBe(11700);
  });

  it("returns 0 for an empty list", () => {
    expect(calculateGrossRevenue([])).toBe(0);
  });

  it("ignores non-finite totals defensively", () => {
    const sales: Sale[] = [sale({ id: "s", totalMmk: NaN as unknown as number })];
    expect(calculateGrossRevenue(sales)).toBe(0);
  });
});

describe("calculateRefundDeductions", () => {
  const sales: Sale[] = [sale({ id: "s1" }), sale({ id: "s2" })];

  it("sums APPROVED PARTIAL refund amounts on in-scope sales", () => {
    const refunds: RefundVoidRequest[] = [
      refund({
        id: "r1",
        saleId: "s1",
        items: [{ productId: "prod", qtyUnits: 1, amountMmk: 1000 }],
      }),
      refund({
        id: "r2",
        saleId: "s2",
        items: [
          { productId: "prod", qtyUnits: 1, amountMmk: 200 },
          { productId: "prod", qtyUnits: 1, amountMmk: 300 },
        ],
      }),
    ];
    expect(calculateRefundDeductions(sales, refunds)).toBe(1500);
  });

  it("ignores refunds against sales NOT in scope", () => {
    const refunds = [refund({ id: "r-out", saleId: "s-other", items: [{ productId: "p", qtyUnits: 1, amountMmk: 9999 }] })];
    expect(calculateRefundDeductions(sales, refunds)).toBe(0);
  });

  it("ignores REQUESTED / REJECTED refunds", () => {
    const refunds: RefundVoidRequest[] = [
      refund({ id: "rA", saleId: "s1", status: "REQUESTED", items: [{ productId: "p", qtyUnits: 1, amountMmk: 100 }] }),
      refund({ id: "rB", saleId: "s1", status: "REJECTED", items: [{ productId: "p", qtyUnits: 1, amountMmk: 200 }] }),
    ];
    expect(calculateRefundDeductions(sales, refunds)).toBe(0);
  });

  it("ignores VOID requests (a void changes sale.status to VOID and is dropped by scopeSales)", () => {
    const refunds = [refund({ id: "rV", saleId: "s1", type: "VOID", items: [{ productId: "p", qtyUnits: 1, amountMmk: 100 }] })];
    expect(calculateRefundDeductions(sales, refunds)).toBe(0);
  });
});

describe("calculateNetRevenue", () => {
  it("subtracts approved PARTIAL refunds from gross revenue", () => {
    const sales: Sale[] = [sale({ id: "s1", totalMmk: 10000 })];
    const refunds: RefundVoidRequest[] = [
      refund({ id: "r", saleId: "s1", items: [{ productId: "p", qtyUnits: 1, amountMmk: 2500 }] }),
    ];
    expect(calculateNetRevenue(sales, refunds)).toBe(7500);
  });

  it("floors at 0 if refunds somehow exceed revenue (data bug)", () => {
    const sales: Sale[] = [sale({ id: "s1", totalMmk: 1000 })];
    const refunds: RefundVoidRequest[] = [
      refund({ id: "r", saleId: "s1", items: [{ productId: "p", qtyUnits: 1, amountMmk: 5000 }] }),
    ];
    expect(calculateNetRevenue(sales, refunds)).toBe(0);
  });

  it("counts a partly refunded (REFUNDED) sale net of its refund — ORV-034", () => {
    const sales = scopeSales(
      [
        sale({ id: "kept", totalMmk: 5000 }),
        sale({ id: "partly", status: "REFUNDED", totalMmk: 10000 }),
        sale({ id: "voided", status: "VOID", totalMmk: 7000 }),
      ],
      null,
    );
    const refunds: RefundVoidRequest[] = [
      refund({ id: "r1", saleId: "partly", items: [{ productId: "p", qtyUnits: 1, amountMmk: 3000 }] }),
    ];
    // 5000 + (10000 − 3000); the void contributes nothing.
    expect(calculateNetRevenue(sales, refunds)).toBe(12000);
  });

  it("nets a fully refunded sale to 0 without touching other sales", () => {
    const sales: Sale[] = [
      sale({ id: "all-back", status: "REFUNDED", totalMmk: 4000 }),
      sale({ id: "other", totalMmk: 6000 }),
    ];
    const refunds: RefundVoidRequest[] = [
      refund({ id: "a", saleId: "all-back", items: [{ productId: "p", qtyUnits: 1, amountMmk: 1500 }] }),
      refund({ id: "b", saleId: "all-back", items: [{ productId: "q", qtyUnits: 2, amountMmk: 2500 }] }),
    ];
    expect(calculateNetRevenue(sales, refunds)).toBe(6000);
  });
});

describe("calculateRefundDeductions — per-sale cap", () => {
  it("never deducts more than a sale's own total (pre-090 over-refunds, ORV-002)", () => {
    const sales: Sale[] = [sale({ id: "s1", totalMmk: 900 }), sale({ id: "s2", totalMmk: 5000 })];
    const refunds: RefundVoidRequest[] = [
      // Priced from the pre-cart-discount line total: 1000 > 900 paid.
      refund({ id: "r", saleId: "s1", items: [{ productId: "p", qtyUnits: 1, amountMmk: 1000 }] }),
    ];
    expect(calculateRefundDeductions(sales, refunds)).toBe(900);
    // s2's revenue is intact: 900 − 900 + 5000.
    expect(calculateNetRevenue(sales, refunds)).toBe(5000);
  });

  it("ignores negative amounts and missing items", () => {
    const sales: Sale[] = [sale({ id: "s1", totalMmk: 1000 })];
    const refunds: RefundVoidRequest[] = [
      refund({ id: "neg", saleId: "s1", items: [{ productId: "p", qtyUnits: 1, amountMmk: -500 }] }),
      refund({ id: "none", saleId: "s1", items: undefined }),
    ];
    expect(calculateRefundDeductions(sales, refunds)).toBe(0);
  });
});

// ------------------------------------------------------------
// Cost / profit / margin / AOV
// ------------------------------------------------------------
describe("calculateCostOfGoods", () => {
  const products: Product[] = [product({ id: "p1", costMmk: 600 }), product({ id: "p2", costMmk: 400 })];

  it("multiplies current product cost × qty for items of in-scope sales", () => {
    const sales = [sale({ id: "s1" })];
    const items = [
      item({ saleId: "s1", productId: "p1", qtyUnits: 3 }),
      item({ saleId: "s1", productId: "p2", qtyUnits: 5 }),
      // out-of-scope item — must not contribute
      item({ saleId: "s-other", productId: "p1", qtyUnits: 100 }),
    ];
    expect(calculateCostOfGoods(sales, items, products)).toBe(3 * 600 + 5 * 400);
  });

  it("treats missing product cost as 0", () => {
    const sales = [sale({ id: "s1" })];
    const items = [item({ saleId: "s1", productId: "ghost", qtyUnits: 9 })];
    expect(calculateCostOfGoods(sales, items, products)).toBe(0);
  });

  it("reverses the cost of units returned by approved PARTIAL refunds", () => {
    const sales = [sale({ id: "s1", status: "REFUNDED" })];
    const items = [
      item({ saleId: "s1", productId: "p1", qtyUnits: 4, unitCostMmkSnapshot: 500 }),
      item({ saleId: "s1", productId: "p2", qtyUnits: 2 }),
    ];
    const refunds = [
      refund({ id: "ok", saleId: "s1", items: [{ productId: "p1", qtyUnits: 1, amountMmk: 1000 }] }),
      refund({ id: "pending", saleId: "s1", status: "REQUESTED", items: [{ productId: "p2", qtyUnits: 2, amountMmk: 1 }] }),
    ];
    // (4 − 1) × 500 snapshot + 2 × 400 current (pending refund ignored).
    expect(calculateCostOfGoods(sales, items, products, refunds)).toBe(3 * 500 + 2 * 400);
    // Without refunds the old behaviour holds.
    expect(calculateCostOfGoods(sales, items, products)).toBe(4 * 500 + 2 * 400);
  });

  it("caps the reversal at what that sale sold of the product", () => {
    const sales = [sale({ id: "s1", status: "REFUNDED" })];
    const items = [item({ saleId: "s1", productId: "p1", qtyUnits: 2 })];
    const refunds = [
      refund({ id: "x", saleId: "s1", items: [{ productId: "p1", qtyUnits: 5, amountMmk: 0 }] }),
      refund({ id: "y", saleId: "s1", items: [{ productId: "not-sold", qtyUnits: 3, amountMmk: 0 }] }),
    ];
    expect(calculateCostOfGoods(sales, items, products, refunds)).toBe(0);
  });
});

describe("calculateProfit / calculateProfitMargin / calculateAvgOrderValue", () => {
  it("computes simple cases", () => {
    expect(calculateProfit(10000, 6000)).toBe(4000);
    expect(calculateProfit(0, 0)).toBe(0);
    expect(calculateProfitMargin(10000, 4000)).toBe(40);
    expect(calculateAvgOrderValue(10000, 4)).toBe(2500);
  });

  it("never produces NaN or Infinity on empty data", () => {
    expect(calculateProfitMargin(0, 0)).toBe(0);
    expect(calculateProfitMargin(0, 100)).toBe(0); // no revenue -> 0% margin
    expect(calculateAvgOrderValue(0, 0)).toBe(0);
    expect(calculateAvgOrderValue(10000, 0)).toBe(0);
    expect(Number.isFinite(calculateProfitMargin(0, 0))).toBe(true);
    expect(Number.isFinite(calculateAvgOrderValue(0, 0))).toBe(true);
  });

  it("rounds AVG order value to whole MMK (no sub-unit denomination)", () => {
    // 10000 / 3 = 3333.333… -> 3333. MMK has no fractional unit.
    expect(calculateAvgOrderValue(10000, 3)).toBe(3333);
    // 10001 / 3 = 3333.666… -> 3334.
    expect(calculateAvgOrderValue(10001, 3)).toBe(3334);
  });
});

describe("calculateSalesCount", () => {
  it("counts sales as-is (filtering is the caller's responsibility)", () => {
    expect(calculateSalesCount([sale({ id: "s1" }), sale({ id: "s2" })])).toBe(2);
    expect(calculateSalesCount([])).toBe(0);
  });
});

// ------------------------------------------------------------
// Inventory
// ------------------------------------------------------------
describe("calculateInventoryValue", () => {
  const products: Product[] = [
    product({ id: "p1", costMmk: 500 }),
    product({ id: "p2", costMmk: 1000 }),
    product({ id: "p-inactive", costMmk: 9999, isActive: false }),
  ];
  const inventory: Inventory[] = [
    inv("shop-a", "p1", 10), // 5000
    inv("shop-a", "p2", 4),  // 4000
    inv("shop-b", "p1", 20), // 10000
    inv("shop-a", "p-inactive", 100), // skipped
  ];

  it("sums (qty × cost) for the selected shop", () => {
    expect(calculateInventoryValue(inventory, products, "shop-a")).toBe(9000);
    expect(calculateInventoryValue(inventory, products, "shop-b")).toBe(10000);
  });

  it("sums across all shops in admin-aggregate mode", () => {
    expect(calculateInventoryValue(inventory, products, null)).toBe(19000);
  });

  it("excludes inactive products", () => {
    expect(calculateInventoryValue(inventory, products, "shop-a")).not.toBeGreaterThan(9000);
  });

  it("returns 0 for a shop with no rows", () => {
    expect(calculateInventoryValue(inventory, products, "shop-ghost")).toBe(0);
  });
});

describe("calculateLowStock (per-shop visibility, never sums across shops)", () => {
  const products: Product[] = [
    product({ id: "p1", lowStockThreshold: 5 }),
    product({ id: "p2", lowStockThreshold: 3 }),
    product({ id: "p-inactive", lowStockThreshold: 5, isActive: false }),
  ];

  it("flags qty ≤ threshold for a single shop and marks status correctly", () => {
    const inventory: Inventory[] = [
      inv("shop-a", "p1", 4), // low
      inv("shop-a", "p2", 0), // out
      inv("shop-a", "p-inactive", 0), // excluded
    ];
    const rows = calculateLowStock(products, inventory, "shop-a");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ product: products[1], qty: 0, status: "out" });
    expect(rows[1]).toMatchObject({ product: products[0], qty: 4, status: "low" });
  });

  it("returns a row per (shop, product) in admin all-shops mode — does NOT sum across shops", () => {
    // Shop A is out of p1; Shop B has plenty. Summing would have hidden A.
    const inventory: Inventory[] = [
      inv("shop-a", "p1", 0),
      inv("shop-b", "p1", 100),
    ];
    const rows = calculateLowStock(products, inventory, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shopId: "shop-a", qty: 0, status: "out" });
  });

  it("ignores products the shop does not carry (no inventory row) instead of reporting them as 0 left", () => {
    // A product with no inventory row for the shop is not stocked there, so it
    // must NOT flood the low-stock alert. Only real inventory rows count.
    expect(calculateLowStock(products, [], "shop-a")).toEqual([]);
    // p1 has a row (low); p2 has none -> only p1 is reported.
    const rows = calculateLowStock(products, [inv("shop-a", "p1", 2)], "shop-a");
    expect(rows.map((r) => r.product.id)).toEqual(["p1"]);
  });

  it("returns empty list when nothing is low/out", () => {
    const inventory: Inventory[] = [inv("shop-a", "p1", 10), inv("shop-a", "p2", 10)];
    expect(calculateLowStock(products, inventory, "shop-a")).toEqual([]);
  });

  it("excludes inventory of inactive/archived shops in all-shops mode when shops are supplied", () => {
    const shops: Shop[] = [
      { id: "shop-a", code: "A", name: "Shop A", address: "", isActive: true, createdAt: "" },
      { id: "shop-x", code: "X", name: "Archived", address: "", isActive: false, createdAt: "" },
    ];
    const inventory: Inventory[] = [
      inv("shop-a", "p1", 0), // active shop -> kept
      inv("shop-x", "p1", 0), // archived shop -> dropped
    ];
    const rows = calculateLowStock(products, inventory, null, shops);
    expect(rows.map((r) => r.shopId)).toEqual(["shop-a"]);
  });

  it("returns no rows for a picked shop that is inactive", () => {
    const shops: Shop[] = [
      { id: "shop-x", code: "X", name: "Archived", address: "", isActive: false, createdAt: "" },
    ];
    expect(calculateLowStock(products, [inv("shop-x", "p1", 0)], "shop-x", shops)).toEqual([]);
  });

  it("sorts by urgency: qty asc, then higher threshold first", () => {
    // Equal qty (0) -> the product with the larger threshold is more urgent.
    const inventory: Inventory[] = [
      inv("shop-a", "p2", 0), // threshold 3
      inv("shop-a", "p1", 0), // threshold 5
    ];
    const rows = calculateLowStock(products, inventory, "shop-a");
    expect(rows.map((r) => r.product.id)).toEqual(["p1", "p2"]);
  });
});

// ------------------------------------------------------------
// Top products + category revenue
// ------------------------------------------------------------
describe("calculateTopProducts", () => {
  const products: Product[] = [
    product({ id: "p1", name: "Lager", costMmk: 600 }),
    product({ id: "p2", name: "Stout", costMmk: 700 }),
    product({ id: "p3", name: "IPA", costMmk: 800 }),
  ];

  it("ranks by line revenue across in-scope sales", () => {
    const sales: Sale[] = [sale({ id: "s1" }), sale({ id: "s2" })];
    const items: SaleItem[] = [
      item({ saleId: "s1", productId: "p1", qtyUnits: 2, lineTotalMmk: 2200 }),
      item({ saleId: "s1", productId: "p2", qtyUnits: 1, lineTotalMmk: 2100 }),
      item({ saleId: "s2", productId: "p1", qtyUnits: 5, lineTotalMmk: 5500 }),
      item({ saleId: "s2", productId: "p3", qtyUnits: 1, lineTotalMmk: 2800 }),
    ];
    const top = calculateTopProducts(sales, items, products, 5);
    expect(top.map((r) => r.product.id)).toEqual(["p1", "p3", "p2"]);
    const lager = top.find((r) => r.product.id === "p1")!;
    expect(lager.qty).toBe(7);
    expect(lager.revenue).toBe(7700);
    expect(lager.cost).toBe(7 * 600);
    expect(lager.profit).toBe(7700 - 7 * 600);
  });

  it("excludes items belonging to out-of-scope sales (e.g. VOID excluded by caller)", () => {
    const sales: Sale[] = [sale({ id: "s1" })];
    const items: SaleItem[] = [
      item({ saleId: "s1", productId: "p1", qtyUnits: 1, lineTotalMmk: 1000 }),
      item({ saleId: "s-void", productId: "p1", qtyUnits: 99, lineTotalMmk: 99000 }),
    ];
    expect(calculateTopProducts(sales, items, products)[0].qty).toBe(1);
  });

  it("honours the limit", () => {
    const sales: Sale[] = [sale({ id: "s1" })];
    const items: SaleItem[] = [
      item({ saleId: "s1", productId: "p1", qtyUnits: 1, lineTotalMmk: 100 }),
      item({ saleId: "s1", productId: "p2", qtyUnits: 1, lineTotalMmk: 200 }),
      item({ saleId: "s1", productId: "p3", qtyUnits: 1, lineTotalMmk: 300 }),
    ];
    expect(calculateTopProducts(sales, items, products, 2)).toHaveLength(2);
  });

  it("returns empty list on empty data", () => {
    expect(calculateTopProducts([], [], [])).toEqual([]);
  });
});

describe("calculateCategoryRevenue", () => {
  it("splits revenue by product.category from in-scope sale items", () => {
    const products: Product[] = [
      product({ id: "p1", category: "beer" }),
      product({ id: "p2", category: "juice" }),
    ];
    const sales: Sale[] = [sale({ id: "s1" })];
    const items: SaleItem[] = [
      item({ saleId: "s1", productId: "p1", lineTotalMmk: 5000 }),
      item({ saleId: "s1", productId: "p2", lineTotalMmk: 1500 }),
    ];
    expect(calculateCategoryRevenue(sales, items, products)).toEqual([
      { name: "beer", value: 5000 },
      { name: "juice", value: 1500 },
    ]);
  });
});

describe("calculateSalesByCategoryPercent", () => {
  const NOW = ygnDate(2026, 4, 24, 12);
  const products: Product[] = [
    product({ id: "p1", category: "beer" }),
    product({ id: "p2", category: "juice" }),
  ];

  it("excludes VOID sales and returns category percentages", () => {
    const sales: Sale[] = [
      sale({ id: "s1", shopId: "shop-a", createdAt: ygnDate(2026, 4, 24, 9).toISOString() }),
      sale({ id: "void", shopId: "shop-a", status: "VOID", createdAt: ygnDate(2026, 4, 24, 10).toISOString() }),
    ];
    const items: SaleItem[] = [
      item({ saleId: "s1", productId: "p1", lineTotalMmk: 3000 }),
      item({ saleId: "s1", productId: "p2", lineTotalMmk: 1000 }),
      item({ saleId: "void", productId: "p1", lineTotalMmk: 99000 }),
    ];

    const rows = calculateSalesByCategoryPercent(sales, items, products, "shop-a", "today", NOW);
    expect(rows).toEqual([
      { name: "beer", value: 3000, percent: 75 },
      { name: "juice", value: 1000, percent: 25 },
    ]);
  });

  it("respects shop scope", () => {
    const sales: Sale[] = [
      sale({ id: "s-a", shopId: "shop-a", createdAt: ygnDate(2026, 4, 24, 9).toISOString() }),
      sale({ id: "s-b", shopId: "shop-b", createdAt: ygnDate(2026, 4, 24, 9).toISOString() }),
    ];
    const items: SaleItem[] = [
      item({ saleId: "s-a", productId: "p1", lineTotalMmk: 1000 }),
      item({ saleId: "s-b", productId: "p2", lineTotalMmk: 4000 }),
    ];

    expect(
      calculateSalesByCategoryPercent(sales, items, products, "shop-a", "today", NOW).map((r) => r.name)
    ).toEqual(["beer"]);
    expect(
      calculateSalesByCategoryPercent(sales, items, products, null, "today", NOW).map((r) => r.name)
    ).toEqual(["juice", "beer"]);
  });

  it("percentage total is approximately 100", () => {
    const sales: Sale[] = [
      sale({ id: "s1", shopId: "shop-a", createdAt: ygnDate(2026, 4, 24, 9).toISOString() }),
    ];
    const items: SaleItem[] = [
      item({ saleId: "s1", productId: "p1", lineTotalMmk: 1 }),
      item({ saleId: "s1", productId: "p2", lineTotalMmk: 2 }),
    ];

    const total = calculateSalesByCategoryPercent(sales, items, products, "shop-a", "today", NOW)
      .reduce((sum, row) => sum + row.percent, 0);
    expect(total).toBeCloseTo(100, 5);
  });

  it("returns empty data safely", () => {
    expect(calculateSalesByCategoryPercent([], [], [], null, "today", NOW)).toEqual([]);
  });
});

describe("calculateDailyRevenueCostProfitTrend", () => {
  const NOW = ygnDate(2026, 4, 24, 12);
  const products: Product[] = [product({ id: "p1", costMmk: 600 })];

  it("excludes VOID sales from revenue, cost, and profit", () => {
    const sales: Sale[] = [
      sale({ id: "s1", shopId: "shop-a", totalMmk: 10000, createdAt: ygnDate(2026, 4, 24, 9).toISOString() }),
      sale({ id: "void", shopId: "shop-a", status: "VOID", totalMmk: 99000, createdAt: ygnDate(2026, 4, 24, 10).toISOString() }),
    ];
    const items: SaleItem[] = [
      item({ saleId: "s1", productId: "p1", qtyUnits: 5 }),
      item({ saleId: "void", productId: "p1", qtyUnits: 99 }),
    ];

    const rows = calculateDailyRevenueCostProfitTrend(sales, items, products, [], "shop-a", "today", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      revenue: 10000,
      cost: 3000,
      profit: 7000,
    });
  });

  it("groups by day and subtracts approved partial refunds from revenue", () => {
    const dayOne = ygnDate(2026, 4, 23, 9).toISOString();
    const dayTwo = ygnDate(2026, 4, 24, 9).toISOString();
    const sales: Sale[] = [
      sale({ id: "s1", shopId: "shop-a", totalMmk: 10000, createdAt: dayOne }),
      sale({ id: "s2", shopId: "shop-a", totalMmk: 5000, createdAt: dayOne }),
      sale({ id: "s3", shopId: "shop-a", totalMmk: 8000, createdAt: dayTwo }),
    ];
    const items: SaleItem[] = [
      item({ saleId: "s1", productId: "p1", qtyUnits: 10 }),
      item({ saleId: "s2", productId: "p1", qtyUnits: 2 }),
      item({ saleId: "s3", productId: "p1", qtyUnits: 3 }),
    ];
    const refunds: RefundVoidRequest[] = [
      refund({ saleId: "s2", status: "APPROVED", type: "PARTIAL", items: [{ productId: "p1", qtyUnits: 1, amountMmk: 1000 }] }),
    ];

    const rows = calculateDailyRevenueCostProfitTrend(sales, items, products, refunds, "shop-a", "week", NOW);
    expect(rows.map((row) => row.date)).toEqual(["2026-05-23", "2026-05-24"]);
    expect(rows[0]).toMatchObject({
      revenue: 14000,
      // 10 × 600 + (2 − 1 refunded) × 600: the returned unit's cost is reversed.
      cost: 6600,
      profit: 7400,
    });
    expect(rows[1]).toMatchObject({
      revenue: 8000,
      cost: 1800,
      profit: 6200,
    });
  });

  it("respects admin all-shops vs selected-shop scope", () => {
    const createdAt = ygnDate(2026, 4, 24, 9).toISOString();
    const sales: Sale[] = [
      sale({ id: "s-a", shopId: "shop-a", totalMmk: 10000, createdAt }),
      sale({ id: "s-b", shopId: "shop-b", totalMmk: 7000, createdAt }),
    ];
    const items: SaleItem[] = [
      item({ saleId: "s-a", productId: "p1", qtyUnits: 2 }),
      item({ saleId: "s-b", productId: "p1", qtyUnits: 3 }),
    ];

    expect(
      calculateDailyRevenueCostProfitTrend(sales, items, products, [], "shop-a", "today", NOW)[0].revenue
    ).toBe(10000);
    expect(
      calculateDailyRevenueCostProfitTrend(sales, items, products, [], null, "today", NOW)[0].revenue
    ).toBe(17000);
  });

  it("returns an empty array safely", () => {
    expect(calculateDailyRevenueCostProfitTrend([], [], [], [], null, "today", NOW)).toEqual([]);
  });
});

// ------------------------------------------------------------
// Supplier debt
// ------------------------------------------------------------
describe("calculateSupplierDebt", () => {
  const baseRows: PurchaseOrder[] = [
    po({ id: "po-draft", status: "DRAFT", totalMmk: 5000 }), // ignored
    po({ id: "po-submit", status: "SUBMITTED", totalMmk: 5000 }), // ignored
    po({ id: "po-approve", status: "APPROVED", totalMmk: 5000 }), // ignored
    po({ id: "po-cancel", status: "CANCELED", totalMmk: 5000 }), // ignored
    po({ id: "po-rec1", status: "RECEIVED", totalMmk: 10000, paidMmk: 3000 }),
    po({ id: "po-rec2", status: "RECEIVED", totalMmk: 4000, paidMmk: 4000 }), // settled
    po({ id: "po-other-shop", status: "RECEIVED", shopId: "shop-b", totalMmk: 2000, paidMmk: 0 }),
  ];

  it("counts debt only from RECEIVED POs (per-shop)", () => {
    const r = calculateSupplierDebt(baseRows, "shop-a");
    expect(r.receivedTotal).toBe(14000);
    expect(r.paid).toBe(7000);
    expect(r.debt).toBe(7000);
    expect(r.openPoCount).toBe(1);
  });

  it("aggregates across shops in null mode", () => {
    const r = calculateSupplierDebt(baseRows, null);
    expect(r.receivedTotal).toBe(16000);
    expect(r.paid).toBe(7000);
    expect(r.debt).toBe(9000);
    expect(r.openPoCount).toBe(2);
  });

  it("floors debt at 0 (overpayment recorded as paid > total)", () => {
    const r = calculateSupplierDebt(
      [po({ status: "RECEIVED", totalMmk: 1000, paidMmk: 1500 })],
      "shop-a"
    );
    expect(r.debt).toBe(0);
  });

  it("returns zeros on empty data", () => {
    expect(calculateSupplierDebt([], null)).toEqual({
      receivedTotal: 0,
      paid: 0,
      debt: 0,
      openPoCount: 0,
    });
  });
});

// ============================================================
// Date range helpers
// ============================================================
describe("dateRangeStart + filterSalesByRange", () => {
  // Pin the clock to mid-day so today/week boundaries are deterministic.
  const NOW = ygnDate(2026, 4, 15, 12);

  it("today starts at business (Yangon) midnight", () => {
    expect(dateRangeStart("today", NOW).toISOString()).toBe("2026-05-14T17:30:00.000Z");
  });

  it("week starts seven days ago at business midnight (rolling)", () => {
    expect(dateRangeStart("week", NOW).toISOString()).toBe("2026-05-07T17:30:00.000Z");
  });

  it("month starts at business midnight on the 1st", () => {
    expect(dateRangeStart("month", NOW).toISOString()).toBe("2026-04-30T17:30:00.000Z");
  });

  it("puts an early-morning Yangon sale on today, not on the previous UTC day (ORV-069)", () => {
    // 01:00 Yangon on the 15th is 18:30 UTC on the 14th.
    const earlyToday = ygnDate(2026, 4, 15, 1).toISOString();
    expect(earlyToday.slice(0, 10)).toBe("2026-05-14");
    const sales: Sale[] = [sale({ id: "early", createdAt: earlyToday })];
    expect(filterSalesByRange(sales, "today", NOW).map((s) => s.id)).toEqual(["early"]);
  });

  it("keeps the last minute of yesterday out of today", () => {
    const lateYesterday = ygnDate(2026, 4, 14, 23, 59).toISOString();
    const sales: Sale[] = [sale({ id: "late", createdAt: lateYesterday })];
    expect(filterSalesByRange(sales, "today", NOW)).toEqual([]);
    expect(filterSalesByRange(sales, "week", NOW).map((s) => s.id)).toEqual(["late"]);
  });

  it("filters sales by createdAt within the range", () => {
    const inTodayMorning = ygnDate(2026, 4, 15, 9).toISOString();
    const fourDaysAgo = ygnDate(2026, 4, 11, 12).toISOString();
    const fifteenDaysAgo = ygnDate(2026, 4, 1, 12).toISOString();
    const lastMonth = ygnDate(2026, 3, 20, 12).toISOString();
    const sales: Sale[] = [
      sale({ id: "today", createdAt: inTodayMorning }),
      sale({ id: "4d", createdAt: fourDaysAgo }),
      sale({ id: "15d", createdAt: fifteenDaysAgo }),
      sale({ id: "lastm", createdAt: lastMonth }),
    ];

    expect(filterSalesByRange(sales, "today", NOW).map((s) => s.id)).toEqual(["today"]);
    expect(filterSalesByRange(sales, "week", NOW).map((s) => s.id).sort()).toEqual(["4d", "today"]);
    expect(filterSalesByRange(sales, "month", NOW).map((s) => s.id).sort()).toEqual(["15d", "4d", "today"]);
  });

  it("treats sales with invalid createdAt as out of range", () => {
    const sales: Sale[] = [sale({ id: "bad", createdAt: "not-a-date" })];
    expect(filterSalesByRange(sales, "month", NOW)).toEqual([]);
  });

  it("excludes future-dated sales from the selected range", () => {
    const future = ygnDate(2026, 4, 16, 9).toISOString();
    const sales: Sale[] = [sale({ id: "future", createdAt: future })];
    expect(filterSalesByRange(sales, "month", NOW)).toEqual([]);
  });

  it("starts a new month and year at Yangon midnight on 1 January", () => {
    // 00:30 Yangon on 2027-01-01 is still 2026-12-31 in UTC.
    const newYear = ygnDate(2027, 0, 1, 0, 30);
    expect(newYear.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(dateRangeStart("month", newYear).toISOString()).toBe("2026-12-31T17:30:00.000Z");
    expect(dateRangeStart("today", newYear).toISOString()).toBe("2026-12-31T17:30:00.000Z");
    const sales: Sale[] = [
      sale({ id: "last-of-year", createdAt: ygnDate(2026, 11, 31, 23, 59).toISOString() }),
      sale({ id: "first-of-year", createdAt: ygnDate(2027, 0, 1, 0, 5).toISOString() }),
    ];
    expect(filterSalesByRange(sales, "month", newYear).map((s) => s.id)).toEqual(["first-of-year"]);
    expect(filterSalesByRange(sales, "week", newYear).map((s) => s.id)).toEqual(["last-of-year", "first-of-year"]);
  });

  it("ends a 30-day month at Yangon midnight (month-end)", () => {
    const lastMinute = ygnDate(2026, 3, 30, 23, 59); // 30 April, 23:59 Yangon
    const sales: Sale[] = [sale({ id: "apr30", createdAt: ygnDate(2026, 3, 30, 23, 0).toISOString() })];
    expect(filterSalesByRange(sales, "month", lastMinute).map((s) => s.id)).toEqual(["apr30"]);
    const firstMinuteOfMay = ygnDate(2026, 4, 1, 0, 1);
    expect(filterSalesByRange(sales, "month", firstMinuteOfMay)).toEqual([]);
  });
});

// ============================================================
// Dashboard scope + permission visibility
// ============================================================
describe("resolveDashboardScope", () => {
  it("locks manager dashboards to the assigned shop even if all-shops is requested", () => {
    expect(resolveDashboardScope(user({ role: "MANAGER", shopId: "shop-a" }), "all", "shop-a")).toEqual({
      selectedShopId: "shop-a",
      metricShopId: "shop-a",
      showAllShops: false,
      isBlocked: false,
    });
  });

  it("supports admin all-shops and selected-shop modes", () => {
    const admin = user({ role: "ADMIN", shopId: undefined });
    expect(resolveDashboardScope(admin, "all", "")).toMatchObject({
      selectedShopId: "all",
      metricShopId: null,
      showAllShops: true,
      isBlocked: false,
    });
    expect(resolveDashboardScope(admin, "shop-b", "")).toMatchObject({
      selectedShopId: "shop-b",
      metricShopId: "shop-b",
      showAllShops: false,
      isBlocked: false,
    });
  });

  it("blocks non-admin dashboards with no assigned shop", () => {
    expect(resolveDashboardScope(user({ shopId: undefined }), "all", "")).toMatchObject({
      metricShopId: null,
      showAllShops: false,
      isBlocked: true,
    });
  });
});

describe("getDashboardVisibility", () => {
  it("keeps manager profit/global cards hidden by default", () => {
    const visibility = getDashboardVisibility(user({ role: "MANAGER" }));
    expect(visibility.canViewShopSales).toBe(true);
    expect(visibility.canViewInventory).toBe(true);
    expect(visibility.canViewProfit).toBe(false);
    expect(visibility.canViewGlobal).toBe(false);
  });

  it("allows admin profit/global cards through role defaults", () => {
    const visibility = getDashboardVisibility(user({ role: "ADMIN", shopId: undefined }));
    expect(visibility.canViewProfit).toBe(true);
    expect(visibility.canViewSupplierDebt).toBe(true);
    expect(visibility.canViewAudit).toBe(true);
    expect(visibility.canViewGlobal).toBe(true);
  });

  it("keeps cashier dashboards limited to own-shift data unless explicitly granted", () => {
    const cashierVisibility = getDashboardVisibility(user({ role: "CASHIER" }));
    expect(cashierVisibility.canViewOwnShift).toBe(true);
    expect(cashierVisibility.canViewShopSales).toBe(false);
    expect(cashierVisibility.canViewProfit).toBe(false);
    expect(cashierVisibility.canViewSupplierDebt).toBe(false);
  });

  it("keeps buyer sales/profit hidden unless a granular report permission is granted", () => {
    const buyerVisibility = getDashboardVisibility(user({ role: "BUYER" }));
    expect(buyerVisibility.canViewShopSales).toBe(false);
    expect(buyerVisibility.canViewProfit).toBe(false);

    const buyerWithSales = getDashboardVisibility(
      user({ role: "BUYER", grantedPermissions: ["report:shop_sales"] })
    );
    expect(buyerWithSales.canViewShopSales).toBe(true);
    expect(buyerWithSales.canViewProfit).toBe(false);
  });
});

// ============================================================
// Action Needed
// ============================================================
describe("calculateActionNeeded", () => {
  const shopId = "shop-a";
  const products: Product[] = [
    product({ id: "p1", lowStockThreshold: 5 }),
    product({ id: "p2", lowStockThreshold: 3 }),
  ];
  const inventory: Inventory[] = [
    inv("shop-a", "p1", 4), // low
    inv("shop-a", "p2", 0), // out
    inv("shop-b", "p1", 0), // out (other shop)
  ];

  it("counts low + out + pending approvals/receipts/transfers in scope", () => {
    const refunds: RefundVoidRequest[] = [
      refund({ id: "r1", saleId: "s-any", shopId: "shop-a", status: "REQUESTED" }),
      refund({ id: "r2", saleId: "s-any", shopId: "shop-b", status: "REQUESTED" }), // other shop
      refund({ id: "r3", saleId: "s-any", shopId: "shop-a", status: "APPROVED" }),  // not pending
    ];
    const purchaseOrders: PurchaseOrder[] = [
      po({ id: "po-a", shopId: "shop-a", status: "APPROVED" }),
      po({ id: "po-b", shopId: "shop-b", status: "APPROVED" }),
      po({ id: "po-c", shopId: "shop-a", status: "DRAFT" }),
    ];
    const transfers: StockTransfer[] = [
      { id: "t-1", transferNo: "T1", fromShopId: "shop-a", toShopId: "shop-b", status: "PENDING", createdBy: "u", createdAt: "" },
      { id: "t-2", transferNo: "T2", fromShopId: "shop-c", toShopId: "shop-a", status: "PENDING", createdBy: "u", createdAt: "" },
      { id: "t-3", transferNo: "T3", fromShopId: "shop-a", toShopId: "shop-b", status: "COMPLETED", createdBy: "u", createdAt: "" },
    ];
    const r = calculateActionNeeded(shopId, inventory, products, refunds, purchaseOrders, transfers);
    expect(r).toEqual({
      lowStockCount: 1,
      outOfStockCount: 1,
      pendingApprovals: 1,
      pendingReceipts: 1,
      pendingTransfers: 2,
      inTransitCount: 0,
      total: 6,
    });
  });

  it("counts IN_TRANSIT transfers awaiting receipt at the shop (destination)", () => {
    const transfers: StockTransfer[] = [
      { id: "in-1", transferNo: "T1", fromShopId: "shop-b", toShopId: "shop-a", status: "IN_TRANSIT", createdBy: "u", createdAt: "" },
      { id: "in-2", transferNo: "T2", fromShopId: "shop-a", toShopId: "shop-b", status: "IN_TRANSIT", createdBy: "u", createdAt: "" },
    ];
    const r = calculateActionNeeded(shopId, [], [], [], [], transfers);
    // shop-a is destination of in-1 only; in-2 (shop-a is source) is not its action.
    expect(r.inTransitCount).toBe(1);
    expect(r.total).toBe(1);
  });

  it("returns all zeros on empty data", () => {
    expect(calculateActionNeeded(shopId, [], [], [], [], [])).toEqual({
      lowStockCount: 0,
      outOfStockCount: 0,
      pendingApprovals: 0,
      pendingReceipts: 0,
      pendingTransfers: 0,
      inTransitCount: 0,
      total: 0,
    });
  });

  it("aggregates across shops in null mode (admin)", () => {
    const purchaseOrders: PurchaseOrder[] = [
      po({ id: "po-a", shopId: "shop-a", status: "APPROVED" }),
      po({ id: "po-b", shopId: "shop-b", status: "APPROVED" }),
    ];
    const r = calculateActionNeeded(null, inventory, products, [], purchaseOrders, []);
    expect(r.pendingReceipts).toBe(2);
    // Inventory: shop-a p1=low, shop-a p2=out, shop-b p1=out -> 1 low, 2 out
    expect(r.lowStockCount).toBe(1);
    expect(r.outOfStockCount).toBe(2);
  });
});

// ============================================================
// Cash vs Other
// ============================================================
describe("netRefundedLines + rankings (ORV-034)", () => {
  const products: Product[] = [product({ id: "A", category: "beer", costMmk: 600 }), product({ id: "B", category: "soft", costMmk: 400 })];
  const sales: Sale[] = [sale({ id: "s1", status: "REFUNDED", totalMmk: 2000 }), sale({ id: "s2", status: "REFUNDED", totalMmk: 1400 })];
  const items: SaleItem[] = [
    item({ saleId: "s1", productId: "A", qtyUnits: 2, lineTotalMmk: 2000 }),
    item({ saleId: "s2", productId: "B", qtyUnits: 1, lineTotalMmk: 700 }),
    item({ saleId: "s2", productId: "B", qtyUnits: 1, lineTotalMmk: 700 }),
  ];
  const refunds: RefundVoidRequest[] = [
    refund({ id: "all-A", saleId: "s1", items: [{ productId: "A", qtyUnits: 2, amountMmk: 2000 }] }),
    refund({ id: "one-B", saleId: "s2", items: [{ productId: "B", qtyUnits: 1, amountMmk: 700 }] }),
    refund({ id: "pending", saleId: "s2", status: "REQUESTED", items: [{ productId: "B", qtyUnits: 1, amountMmk: 700 }] }),
  ];

  it("drops wholly returned lines and takes returned units from the product's lines in order", () => {
    const kept = netRefundedLines(items, refunds);
    expect(kept.map((i) => [i.saleId, i.productId, i.qtyUnits, i.lineTotalMmk])).toEqual([["s2", "B", 1, 700]]);
    expect(netRefundedLines(items)).toBe(items);
  });

  it("reduces quantity and line total pro rata on a partly returned line", () => {
    const kept = netRefundedLines(
      [item({ saleId: "s9", productId: "A", qtyUnits: 3, lineTotalMmk: 2999 })],
      [refund({ id: "x", saleId: "s9", items: [{ productId: "A", qtyUnits: 1, amountMmk: 1000 }] })],
    );
    expect(kept.map((i) => [i.qtyUnits, i.lineTotalMmk])).toEqual([[2, 1999]]);
  });

  it("a fully refunded sale no longer tops Top Products or the category split", () => {
    expect(calculateTopProducts(sales, items, products, 5, refunds).map((r) => [r.product.id, r.qty, r.revenue])).toEqual([["B", 1, 700]]);
    expect(calculateCategoryRevenue(sales, items, products, refunds)).toEqual([{ name: "soft", value: 700 }]);
    // Without refunds the old (gross) behaviour holds.
    expect(calculateTopProducts(sales, items, products, 5).map((r) => [r.product.id, r.qty])).toEqual([["A", 2], ["B", 2]]);
  });
});

describe("calculateCashVsOther", () => {
  it("nets each method's approved refunds when refunds are given (ORV-034)", () => {
    const sales: Sale[] = [
      sale({ id: "c1", paymentMethod: "CASH", status: "REFUNDED", totalMmk: 4000 }),
      sale({ id: "o1", paymentMethod: "OTHER", status: "REFUNDED", totalMmk: 3000 }),
    ];
    const refunds: RefundVoidRequest[] = [
      refund({ id: "rc", saleId: "c1", items: [{ productId: "p", qtyUnits: 1, amountMmk: 1500 }] }),
      refund({ id: "ro", saleId: "o1", items: [{ productId: "p", qtyUnits: 1, amountMmk: 3000 }] }),
    ];
    expect(calculateCashVsOther(sales, refunds)).toEqual({ cashCount: 1, cashRevenue: 2500, otherCount: 1, otherRevenue: 0 });
  });

  it("splits count + revenue by payment method", () => {
    const sales: Sale[] = [
      sale({ id: "s1", paymentMethod: "CASH", totalMmk: 10000 }),
      sale({ id: "s2", paymentMethod: "OTHER", totalMmk: 3000 }),
      sale({ id: "s3", paymentMethod: "CASH", totalMmk: 5000 }),
    ];
    expect(calculateCashVsOther(sales)).toEqual({
      cashCount: 2,
      cashRevenue: 15000,
      otherCount: 1,
      otherRevenue: 3000,
    });
  });

  it("returns zeros on empty data", () => {
    expect(calculateCashVsOther([], [])).toEqual({ cashCount: 0, cashRevenue: 0, otherCount: 0, otherRevenue: 0 });
    expect(calculateCashVsOther([])).toEqual({
      cashCount: 0,
      cashRevenue: 0,
      otherCount: 0,
      otherRevenue: 0,
    });
  });
});

// ============================================================
// Active shifts + expected cash
// ============================================================
describe("filterActiveShifts + calculateExpectedCashForActiveShifts", () => {
  const shift = (overrides: Partial<Shift>): Shift => ({
    id: "shift-1",
    shopId: "shop-a",
    cashierId: "u-cash",
    startedAt: "2026-05-15T08:00:00.000Z",
    openingCashMmk: 50000,
    ...overrides,
  });

  it("returns shifts without endedAt in the requested scope", () => {
    const shifts: Shift[] = [
      shift({ id: "open-a", shopId: "shop-a" }),
      shift({ id: "open-b", shopId: "shop-b" }),
      shift({ id: "closed-a", shopId: "shop-a", endedAt: "2026-05-15T20:00:00.000Z" }),
    ];
    expect(filterActiveShifts(shifts, "shop-a").map((s) => s.id)).toEqual(["open-a"]);
    expect(filterActiveShifts(shifts, null).map((s) => s.id).sort()).toEqual(["open-a", "open-b"]);
  });

  it("computes expected cash = opening + cash sales − approved partial cash refunds", () => {
    const shifts: Shift[] = [shift({ id: "open-a", openingCashMmk: 50000 })];
    const sales: Sale[] = [
      sale({ id: "cash1", shiftId: "open-a", paymentMethod: "CASH", totalMmk: 10000 }),
      sale({ id: "cash2", shiftId: "open-a", paymentMethod: "CASH", totalMmk: 5000 }),
      sale({ id: "other", shiftId: "open-a", paymentMethod: "OTHER", totalMmk: 3000 }), // ignored
      sale({ id: "voided", shiftId: "open-a", paymentMethod: "CASH", status: "VOID", totalMmk: 99999 }), // ignored
    ];
    const refunds: RefundVoidRequest[] = [
      refund({ saleId: "cash1", type: "PARTIAL", status: "APPROVED", items: [{ productId: "p", qtyUnits: 1, amountMmk: 2000 }] }),
    ];
    expect(calculateExpectedCashForActiveShifts(shifts, sales, refunds, "shop-a")).toBe(50000 + 15000 - 2000);
  });

  it("floors expected cash at 0", () => {
    const shifts: Shift[] = [shift({ id: "open-a", openingCashMmk: 0 })];
    const refunds: RefundVoidRequest[] = [
      refund({ saleId: "cash1", type: "PARTIAL", status: "APPROVED", items: [{ productId: "p", qtyUnits: 1, amountMmk: 999 }] }),
    ];
    const sales: Sale[] = [sale({ id: "cash1", shiftId: "open-a", paymentMethod: "CASH", totalMmk: 100 })];
    expect(calculateExpectedCashForActiveShifts(shifts, sales, refunds, "shop-a")).toBe(0);
  });

  it("listActiveShiftRows decorates with user and shop", () => {
    const shifts: Shift[] = [shift({ id: "open-a", shopId: "shop-a", cashierId: "u-cash" })];
    const users: User[] = [{ id: "u-cash", name: "Cashier A", role: "CASHIER", shopId: "shop-a", isActive: true, createdAt: "" }];
    const shops: Shop[] = [{ id: "shop-a", code: "A", name: "Shop A", address: "", isActive: true, createdAt: "" }];
    const rows = listActiveShiftRows(shifts, users, shops, "shop-a");
    expect(rows).toHaveLength(1);
    expect(rows[0].user?.name).toBe("Cashier A");
    expect(rows[0].shop?.name).toBe("Shop A");
  });
});

// ============================================================
// Per-shop metrics (Admin Shop Performance table)
// ============================================================
describe("calculatePerShopMetrics", () => {
  const shops: Shop[] = [
    { id: "shop-a", code: "A", name: "Shop A", address: "", isActive: true, createdAt: "" },
    { id: "shop-b", code: "B", name: "Shop B", address: "", isActive: true, createdAt: "" },
  ];
  const products: Product[] = [product({ id: "p1", costMmk: 600 })];

  it("computes net revenue, cost, profit, margin per shop + active shifts + debt", () => {
    const sales: Sale[] = [
      sale({ id: "s-a-1", shopId: "shop-a", totalMmk: 10000 }),
      sale({ id: "s-a-2", shopId: "shop-a", totalMmk: 5000 }),
      sale({ id: "s-b-1", shopId: "shop-b", totalMmk: 8000 }),
      sale({ id: "void", shopId: "shop-a", status: "VOID", totalMmk: 9999 }),
    ];
    const items: SaleItem[] = [
      item({ saleId: "s-a-1", productId: "p1", qtyUnits: 5, lineTotalMmk: 5000 }),
      item({ saleId: "s-a-2", productId: "p1", qtyUnits: 2, lineTotalMmk: 2000 }),
      item({ saleId: "s-b-1", productId: "p1", qtyUnits: 4, lineTotalMmk: 4000 }),
    ];
    const shifts: Shift[] = [
      { id: "open-a", shopId: "shop-a", cashierId: "u", startedAt: "", openingCashMmk: 0 },
    ];
    const purchaseOrders: PurchaseOrder[] = [
      po({ id: "po", shopId: "shop-a", status: "RECEIVED", totalMmk: 20000, paidMmk: 5000 }),
    ];

    const rows = calculatePerShopMetrics(sales, items, products, shops, [], shifts, purchaseOrders);
    const a = rows.find((r) => r.shop.id === "shop-a")!;
    const b = rows.find((r) => r.shop.id === "shop-b")!;

    expect(a.orders).toBe(2);
    expect(a.revenue).toBe(15000);
    expect(a.cost).toBe(7 * 600);
    expect(a.profit).toBe(15000 - 7 * 600);
    expect(a.margin).toBeCloseTo(((15000 - 7 * 600) / 15000) * 100, 3);
    expect(a.activeShifts).toBe(1);
    expect(a.debt).toBe(15000);

    expect(b.orders).toBe(1);
    expect(b.revenue).toBe(8000);
    expect(b.activeShifts).toBe(0);
    expect(b.debt).toBe(0);
  });
});

// ============================================================
// Supplier debt groupings
// ============================================================
describe("groupSupplierDebtByShop", () => {
  const shops: Shop[] = [
    { id: "shop-a", code: "A", name: "Shop A", address: "", isActive: true, createdAt: "" },
    { id: "shop-b", code: "B", name: "Shop B", address: "", isActive: true, createdAt: "" },
  ];

  it("returns one row per shop with non-zero debt sorted by debt desc", () => {
    const purchaseOrders: PurchaseOrder[] = [
      po({ id: "1", shopId: "shop-a", status: "RECEIVED", totalMmk: 10000, paidMmk: 2000 }), // debt 8000
      po({ id: "2", shopId: "shop-b", status: "RECEIVED", totalMmk: 5000, paidMmk: 5000 }),  // debt 0
      po({ id: "3", shopId: "shop-b", status: "RECEIVED", totalMmk: 3000, paidMmk: 0 }),     // debt 3000
    ];
    const rows = groupSupplierDebtByShop(purchaseOrders, shops);
    expect(rows.map((r) => r.id)).toEqual(["shop-a", "shop-b"]);
    expect(rows[0].debt).toBe(8000);
    expect(rows[1].debt).toBe(3000);
  });

  it("omits shops with zero debt entirely", () => {
    const purchaseOrders: PurchaseOrder[] = [
      po({ id: "1", shopId: "shop-a", status: "RECEIVED", totalMmk: 5000, paidMmk: 5000 }),
    ];
    expect(groupSupplierDebtByShop(purchaseOrders, shops)).toEqual([]);
  });
});

describe("groupSupplierDebtBySupplier", () => {
  const suppliers: Supplier[] = [
    { id: "sup-1", code: "S1", name: "Beer Co.", isActive: true, createdAt: "" },
    { id: "sup-2", code: "S2", name: "Juice Co.", isActive: true, createdAt: "" },
  ];

  it("aggregates by supplier with open-po count and shop scope", () => {
    const purchaseOrders: PurchaseOrder[] = [
      po({ id: "1", supplierId: "sup-1", shopId: "shop-a", status: "RECEIVED", totalMmk: 5000, paidMmk: 1000 }),
      po({ id: "2", supplierId: "sup-1", shopId: "shop-a", status: "RECEIVED", totalMmk: 3000, paidMmk: 3000 }), // settled
      po({ id: "3", supplierId: "sup-2", shopId: "shop-b", status: "RECEIVED", totalMmk: 2000, paidMmk: 0 }),
    ];
    const allShops = groupSupplierDebtBySupplier(purchaseOrders, suppliers, null);
    expect(allShops.map((r) => r.id)).toEqual(["sup-1", "sup-2"]);
    expect(allShops[0]).toMatchObject({ debt: 4000, openPoCount: 1 });
    expect(allShops[1]).toMatchObject({ debt: 2000, openPoCount: 1 });

    const shopAOnly = groupSupplierDebtBySupplier(purchaseOrders, suppliers, "shop-a");
    expect(shopAOnly.map((r) => r.id)).toEqual(["sup-1"]);
  });
});

// ============================================================
// Pending lists (drilldowns)
// ============================================================
describe("pending list filters", () => {
  it("filterPendingApprovals: REQUESTED in scope", () => {
    const refunds: RefundVoidRequest[] = [
      refund({ id: "r1", shopId: "shop-a", status: "REQUESTED" }),
      refund({ id: "r2", shopId: "shop-b", status: "REQUESTED" }),
      refund({ id: "r3", shopId: "shop-a", status: "APPROVED" }),
    ];
    expect(filterPendingApprovals(refunds, "shop-a").map((r) => r.id)).toEqual(["r1"]);
    expect(filterPendingApprovals(refunds, null).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("filterPendingReceipts: APPROVED PO in scope", () => {
    const purchaseOrders: PurchaseOrder[] = [
      po({ id: "po-a-approved", shopId: "shop-a", status: "APPROVED" }),
      po({ id: "po-a-draft", shopId: "shop-a", status: "DRAFT" }),
      po({ id: "po-b-approved", shopId: "shop-b", status: "APPROVED" }),
    ];
    expect(filterPendingReceipts(purchaseOrders, "shop-a").map((p) => p.id)).toEqual(["po-a-approved"]);
  });

  it("filterPendingTransfers: PENDING involving source OR destination shop", () => {
    const transfers: StockTransfer[] = [
      { id: "t1", transferNo: "T1", fromShopId: "shop-a", toShopId: "shop-b", status: "PENDING", createdBy: "u", createdAt: "" },
      { id: "t2", transferNo: "T2", fromShopId: "shop-b", toShopId: "shop-a", status: "PENDING", createdBy: "u", createdAt: "" },
      { id: "t3", transferNo: "T3", fromShopId: "shop-b", toShopId: "shop-c", status: "PENDING", createdBy: "u", createdAt: "" },
      { id: "t4", transferNo: "T4", fromShopId: "shop-a", toShopId: "shop-b", status: "COMPLETED", createdBy: "u", createdAt: "" },
    ];
    expect(filterPendingTransfers(transfers, "shop-a").map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(filterPendingTransfers(transfers, null).map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
  });
});

// ============================================================
// recentAuditLogs
// ============================================================
describe("recentTransfers", () => {
  const tr = (overrides: Partial<StockTransfer>): StockTransfer => ({
    id: "t", transferNo: "TRF-1", fromShopId: "shop-a", toShopId: "shop-b",
    status: "PENDING", createdBy: "u", createdAt: "2026-05-10T00:00:00.000Z", ...overrides,
  });

  const transfers: StockTransfer[] = [
    tr({ id: "old", createdAt: "2026-05-01T00:00:00.000Z" }),
    tr({ id: "new", createdAt: "2026-05-20T00:00:00.000Z" }),
    tr({ id: "other", fromShopId: "shop-c", toShopId: "shop-d", createdAt: "2026-05-15T00:00:00.000Z" }),
  ];

  it("returns newest-first across all shops in admin mode", () => {
    expect(recentTransfers(transfers, null).map((t) => t.id)).toEqual(["new", "other", "old"]);
  });

  it("scopes to transfers where the shop is source or destination", () => {
    expect(recentTransfers(transfers, "shop-a").map((t) => t.id)).toEqual(["new", "old"]);
    expect(recentTransfers(transfers, "shop-d").map((t) => t.id)).toEqual(["other"]);
  });

  it("honours the limit", () => {
    expect(recentTransfers(transfers, null, 1).map((t) => t.id)).toEqual(["new"]);
  });
});

describe("recentAuditLogs", () => {
  it("returns the N most recent by createdAt descending", () => {
    const logs = [
      { id: "old", shopId: "x", actorId: "u", actionType: "X", message: "", entityType: "X", entityId: "1", createdAt: "2026-05-10T00:00:00.000Z" },
      { id: "mid", shopId: "x", actorId: "u", actionType: "X", message: "", entityType: "X", entityId: "1", createdAt: "2026-05-12T00:00:00.000Z" },
      { id: "new", shopId: "x", actorId: "u", actionType: "X", message: "", entityType: "X", entityId: "1", createdAt: "2026-05-15T00:00:00.000Z" },
    ];
    expect(recentAuditLogs(logs, 2).map((l) => l.id)).toEqual(["new", "mid"]);
  });

  it("returns empty list when no logs", () => {
    expect(recentAuditLogs([], 5)).toEqual([]);
  });
});
