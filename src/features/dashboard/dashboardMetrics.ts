import type {
  AuditLog,
  Inventory,
  Permission,
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
import { hasPermission } from "../../lib/permissions";
import { addDays, businessDayKey, businessDayStart, businessToday, monthStartKey } from "../../lib/businessDay";
import { getPurchaseOrderBalanceMmk, getPurchaseOrderPaidMmk } from "../suppliers/debt";

// ============================================================
// Dashboard calculation helpers
//
// Single source of truth for every Dashboard card / chart / table.
// Keep these functions PURE — no hooks, no store reads — so the card
// labelled "Total Revenue" and the chart labelled "Sales Trend" never
// disagree because one inlines its own math.
//
// Reference for the rules below:
//   docs/04-features-workflows.md › Dashboard rules
//
// Money conventions
// -----------------
// `sale.totalMmk`           = final cash basis (after item discounts AND
//                             cart discount). Use for headline revenue.
// `sale.subtotalMmk`        = pre-cart-discount total.
// `sale_items.lineTotalMmk` = per-line, pre-cart-discount. Use for
//                             per-product / per-category ranking but NOT
//                             for headline totals (when cart discount > 0
//                             the lineTotal sum is > sale.totalMmk).
//
// Revenue (ORV-034)
// -------
// Net revenue = sum(sale.totalMmk) - sum(approved PARTIAL refund amounts).
// Only VOID sales are excluded by `scopeSales`. Approving ANY partial
// refund flips the whole sale to REFUNDED (approve_refund_request, 070), so
// a REFUNDED sale is "sold, then partly or wholly given back": it stays in
// scope and its approved refund amounts are deducted, capped per sale at the
// sale total so a refund can never remove more than that sale earned.
//
// Cost of goods
// -------------
// Only the per-line cost captured at sale time (migration 041; with PCOST-A
// laid on from sale_item_costs for a permitted person). Never today's
// product cost and never 0: a line without its own snapshot makes the cost —
// and every profit / margin built on it — UNAVAILABLE (null), as the server
// report does (PFIN-B: COGS incomplete -> gross profit null). Units given
// back by an approved PARTIAL refund return to stock (RETURN_IN), so their
// cost is reversed too when the refunds are passed in.
//
// Days
// ----
// "Today", "week", "month" and the daily trend use business days
// (Asia/Yangon, lib/businessDay.ts), not the device clock or UTC (ORV-069).
//
// Shop scope
// ----------
// All scoped functions accept `shopId: string | null`. `null` means
// "ADMIN viewing all shops" (no shop filter). The caller must NEVER pass
// `null` for a non-admin viewer — the page enforces that.
// ============================================================

// ------------------------------------------------------------
// Sale-level helpers
// ------------------------------------------------------------

// Minimal shapes so the same money rules serve the store-backed dashboard
// and the server-ranged profit report (features/reports/useRangedSales).
type RevenueSale = Pick<Sale, "id" | "totalMmk">;
type ScopedSale = Pick<Sale, "status" | "shopId">;
type CostLine = Pick<SaleItem, "saleId" | "productId" | "qtyUnits" | "unitCostMmkSnapshot">;
type CostProduct = Pick<Product, "id" | "costMmk">;
export type RefundForMetrics = Pick<RefundVoidRequest, "saleId" | "type" | "status" | "items">;

/** True for a sale that still counts as trade: anything but VOID. */
export const countsAsSale = (sale: Pick<Sale, "status">): boolean => sale.status !== "VOID";

/**
 * Return only the sales that belong on a dashboard:
 *   * status ≠ VOID — NORMAL and REFUNDED (partly/wholly refunded) stay;
 *     their approved refund amounts are deducted by `calculateNetRevenue`
 *   * if `shopId` is a string, restrict to that shop
 *   * if `shopId` is null, no shop restriction (admin all-shops mode)
 */
export const scopeSales = <T extends ScopedSale>(sales: T[], shopId: string | null): T[] =>
  sales.filter((s) => countsAsSale(s) && (shopId === null || s.shopId === shopId));

const finiteMmk = (value: number | undefined): number => (Number.isFinite(value) ? (value as number) : 0);

/** Sum of `sale.totalMmk` — the cash basis revenue, pre-refund adjustments. */
export const calculateGrossRevenue = (sales: RevenueSale[]): number =>
  sales.reduce((sum, s) => sum + finiteMmk(s.totalMmk), 0);

const isApprovedPartial = (r: RefundForMetrics): boolean => r.status === "APPROVED" && r.type === "PARTIAL";

/**
 * One refund item read the way approve_refund_request (070) reads it:
 * `items` is stored as sent, and the server accepts camelCase or snake_case
 * keys and numeric strings. This app always sends camelCase numbers, but a
 * row written by another client must not silently deduct nothing.
 */
/** The refund's items, or none if the stored value is not an array. */
const refundItemsOf = (r: RefundForMetrics): unknown[] => (Array.isArray(r.items) ? r.items : []);

const refundItemValues = (item: unknown): { productId: string; qtyUnits: number; amountMmk: number } => {
  const raw = (item ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number => {
    const n = typeof value === "string" ? Number(value) : (value as number);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    productId: String(raw.productId ?? raw.product_id ?? ""),
    qtyUnits: Math.max(num(raw.qtyUnits ?? raw.qty_units), 0),
    amountMmk: Math.max(num(raw.amountMmk ?? raw.amount_mmk), 0),
  };
};

/**
 * Sum of approved PARTIAL refund amounts against the given sales, each
 * sale's deduction capped at that sale's total.
 *
 *   * VOID -> the sale becomes VOID and `scopeSales` drops it (and its
 *     revenue) entirely; a VOID request is never a deduction.
 *   * PARTIAL APPROVED -> the sale becomes REFUNDED but stays in scope;
 *     the amount handed back is subtracted here. A refund of every line is
 *     just a PARTIAL refund of everything: the sale nets to 0.
 *   * REQUESTED / REJECTED -> nothing was paid out yet; no deduction.
 *
 * The cap matters while the server still accepts refunds priced from
 * pre-cart-discount line totals (ORV-002, until migration 090): the excess
 * must not eat into other sales' revenue.
 */
export const calculateRefundDeductions = (
  sales: RevenueSale[],
  refunds: RefundForMetrics[]
): number => {
  const totalBySale = new Map(sales.map((s) => [s.id, finiteMmk(s.totalMmk)]));
  const refundedBySale = new Map<string, number>();
  for (const r of refunds) {
    if (!isApprovedPartial(r) || !totalBySale.has(r.saleId)) continue;
    const amount = refundItemsOf(r).reduce<number>((line, item) => line + refundItemValues(item).amountMmk, 0);
    refundedBySale.set(r.saleId, (refundedBySale.get(r.saleId) ?? 0) + amount);
  }
  let total = 0;
  for (const [saleId, refunded] of refundedBySale) {
    total += Math.min(refunded, Math.max(totalBySale.get(saleId) ?? 0, 0));
  }
  return total;
};

/**
 * Headline revenue: gross minus approved PARTIAL refund deductions.
 * Floored at 0 so a refund larger than the captured sale (data bug)
 * never produces a negative dashboard number.
 */
export const calculateNetRevenue = (
  sales: RevenueSale[],
  refunds: RefundForMetrics[]
): number => Math.max(calculateGrossRevenue(sales) - calculateRefundDeductions(sales, refunds), 0);

/** Number of valid orders (a refunded sale is still an order). */
export const calculateSalesCount = (sales: unknown[]): number => sales.length;

/**
 * Cost of goods sold — uses the per-line cost captured at sale time when
 * present (migration 041), else the current product cost (legacy rows).
 *
 * With `refunds`, the cost of units returned by approved PARTIAL refunds is
 * reversed (they went back to stock). A refund item is matched to the sale
 * line by product, as the server does (070), and its quantity is capped at
 * what that sale sold of the product.
 */
export const calculateCostOfGoods = (
  sales: Pick<Sale, "id">[],
  saleItems: CostLine[],
  // Kept for callers; no longer a fallback (today's cost is not the cost of
  // a past sale).
  _products: CostProduct[],
  refunds: RefundForMetrics[] = []
): number | null => {
  void _products;
  const saleIds = new Set(sales.map((s) => s.id));

  let cost = 0;
  // Per sale+product: base units sold and their cost, for refund reversal.
  const sold = new Map<string, { qty: number; cost: number }>();
  for (const item of saleItems) {
    if (!saleIds.has(item.saleId)) continue;
    const unit = item.unitCostMmkSnapshot;
    if (typeof unit !== "number" || !Number.isFinite(unit)) return null;   // no evidence: unavailable
    const lineCost = unit * item.qtyUnits;
    cost += lineCost;
    const key = `${item.saleId}\u0000${item.productId}`;
    const prev = sold.get(key) ?? { qty: 0, cost: 0 };
    sold.set(key, { qty: prev.qty + item.qtyUnits, cost: prev.cost + lineCost });
  }

  const returned = new Map<string, number>();
  for (const r of refunds) {
    if (!isApprovedPartial(r) || !saleIds.has(r.saleId)) continue;
    for (const raw of refundItemsOf(r)) {
      const item = refundItemValues(raw);
      const key = `${r.saleId}\u0000${item.productId}`;
      returned.set(key, (returned.get(key) ?? 0) + item.qtyUnits);
    }
  }
  for (const [key, qty] of returned) {
    const line = sold.get(key);
    if (!line || line.qty <= 0) continue;
    cost -= (line.cost / line.qty) * Math.min(qty, line.qty);
  }
  return Math.max(Math.round(cost), 0);
};

/** null when the cost is unavailable (never a profit equal to the revenue). */
export const calculateProfit = (revenue: number, cost: number | null): number | null =>
  cost === null ? null : revenue - cost;

export const calculateProfitMargin = (revenue: number, profit: number | null): number | null =>
  profit === null ? null : revenue > 0 ? (profit / revenue) * 100 : 0;

/**
 * Average order value. Returns 0 when count = 0 (no Infinity).
 * Rounded to the nearest whole MMK so the dashboard never shows a long
 * float like `MMK 3,333.3333…`. MMK has no sub-unit denomination.
 */
export const calculateAvgOrderValue = (revenue: number, count: number): number =>
  count > 0 ? Math.round(revenue / count) : 0;

// ------------------------------------------------------------
// Inventory helpers
// ------------------------------------------------------------

/**
 * Sum of (qty × current cost) for inventory in scope — a valuation at
 * today's cost. null when any active product with stock in scope has no
 * cost on this device (not permitted, or never entered): never valued at 0.
 *
 *   shopId = null   -> total across ALL shops (admin aggregate)
 *   shopId = "x"    -> just shop x's rows
 *
 * Inactive products are excluded — they don't represent realisable
 * investment. (If a future business rule wants them, parameterise.)
 */
export const calculateInventoryValue = (
  inventory: Inventory[],
  products: Product[],
  shopId: string | null
): number | null => {
  const productById = new Map(products.map((p) => [p.id, p]));
  const scoped = shopId === null ? inventory : inventory.filter((i) => i.shopId === shopId);
  let sum = 0;
  for (const inv of scoped) {
    const product = productById.get(inv.productId);
    if (!product || !product.isActive || inv.qtyBaseUnits === 0) continue;
    if (typeof product.costMmk !== "number") return null;
    sum += product.costMmk * inv.qtyBaseUnits;
  }
  return sum;
};

export interface LowStockRow {
  product: Product;
  shopId: string;
  qty: number;
  threshold: number;
  /** "out" iff qty <= 0; "low" iff qty <= threshold AND qty > 0. */
  status: "low" | "out";
}

/**
 * Urgency ordering for low-stock rows (most urgent first):
 *   1. qty ascending        — fully out (0) before merely low
 *   2. threshold descending — a higher reorder line means it ran short sooner
 *   3. product name ascending
 *   4. shopId ascending     — stable final tiebreak for per-(shop,product) rows
 */
const compareLowStock = (a: LowStockRow, b: LowStockRow): number =>
  a.qty - b.qty ||
  b.threshold - a.threshold ||
  a.product.name.localeCompare(b.product.name) ||
  a.shopId.localeCompare(b.shopId);

/**
 * Low / out-of-stock rows in scope.
 *
 *   shopId = "x"  -> the rows in shop x's inventory where qty <= threshold
 *   shopId = null -> one row per (shop, product) pair across the inventory
 *                    table where qty <= threshold.
 *
 * Both modes are driven by **actual inventory rows** — a product that has no
 * inventory row for a shop is one the shop does not carry, so it is NOT
 * reported as "0 left" for that shop. (The shared product catalog is global;
 * stock is per (shop, product). Listing every catalogue product against a
 * single shop would flood the alert with items the shop never stocked, and
 * would also disagree with the all-shops view, which only ever sees real
 * inventory rows.)
 *
 * **Never sum across shops.** Per the dashboard rules in
 * `docs/04-features-workflows.md`, summing would mask a shop being out
 * of stock when another shop has plenty. ADMIN viewing all shops sees a
 * row per affected (shop, product) pair.
 *
 * Inactive products are always excluded. When the optional `shops` list is
 * supplied, inventory belonging to inactive/archived shops is excluded too,
 * so the card never lists a shop that is hidden from the switcher. (Omitting
 * `shops` skips that filter for callers already scoped to a known-active shop.)
 *
 * Sorted by urgency — see `compareLowStock`.
 */
export const calculateLowStock = (
  products: Product[],
  inventory: Inventory[],
  shopId: string | null,
  shops?: Shop[]
): LowStockRow[] => {
  const productById = new Map(products.map((p) => [p.id, p]));
  const activeShopIds = shops
    ? new Set(shops.filter((s) => s.isActive).map((s) => s.id))
    : null;
  const shopAllowed = (sid: string): boolean =>
    activeShopIds === null || activeShopIds.has(sid);

  const rows: LowStockRow[] = [];
  for (const inv of inventory) {
    if (shopId !== null && inv.shopId !== shopId) continue;
    if (!shopAllowed(inv.shopId)) continue;
    const product = productById.get(inv.productId);
    if (!product || !product.isActive) continue;
    if (inv.qtyBaseUnits <= product.lowStockThreshold) {
      rows.push({
        product,
        shopId: inv.shopId,
        qty: inv.qtyBaseUnits,
        threshold: product.lowStockThreshold,
        status: inv.qtyBaseUnits <= 0 ? "out" : "low",
      });
    }
  }
  return rows.sort(compareLowStock);
};

// ------------------------------------------------------------
// Ranking helpers
// ------------------------------------------------------------

/**
 * Sale lines with the units given back by approved PARTIAL refunds taken
 * out (ORV-034), for the per-product / per-category figures that rank by
 * line: quantity drops by the returned base units and the line total pro
 * rata. Returned units of a product are taken from that sale's lines of
 * the product in the order given; a wholly returned line is dropped. With
 * no refunds the lines are returned as they are.
 */
export const netRefundedLines = <T extends Pick<SaleItem, "saleId" | "productId" | "qtyUnits" | "lineTotalMmk">>(
  items: T[],
  refunds: RefundForMetrics[] = []
): T[] => {
  const returned = new Map<string, number>();
  for (const r of refunds) {
    if (!isApprovedPartial(r)) continue;
    for (const raw of refundItemsOf(r)) {
      const item = refundItemValues(raw);
      if (item.qtyUnits <= 0) continue;
      const key = `${r.saleId}\u0000${item.productId}`;
      returned.set(key, (returned.get(key) ?? 0) + item.qtyUnits);
    }
  }
  if (returned.size === 0) return items;
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.saleId}\u0000${item.productId}`;
    const left = returned.get(key) ?? 0;
    if (left <= 0 || item.qtyUnits <= 0) {
      out.push(item);
      continue;
    }
    const take = Math.min(left, item.qtyUnits);
    returned.set(key, left - take);
    const qty = item.qtyUnits - take;
    if (qty <= 0) continue;
    out.push({ ...item, qtyUnits: qty, lineTotalMmk: Math.round((item.lineTotalMmk * qty) / item.qtyUnits) });
  }
  return out;
};

export interface TopProductRow {
  product: Product;
  qty: number;
  /** Sum of `sale_items.lineTotalMmk` — pre-cart-discount. Documented. */
  revenue: number;
  /** From each line's own cost snapshot; null when any line has none. */
  cost: number | null;
  profit: number | null;
}

/**
 * Top products by line-total revenue (descending). Ranking basis is
 * `lineTotalMmk` because that's the per-product number; cart discounts
 * are applied at the sale level, not the item level. The headline
 * revenue KPI uses `sale.totalMmk` — see header. With `refunds`, units
 * given back by approved PARTIAL refunds are taken out (netRefundedLines).
 */
export const calculateTopProducts = (
  sales: Sale[],
  saleItems: SaleItem[],
  products: Product[],
  limit = 5,
  refunds?: RefundForMetrics[]
): TopProductRow[] => {
  const saleIds = new Set(sales.map((s) => s.id));
  const productById = new Map(products.map((p) => [p.id, p]));
  const map = new Map<string, TopProductRow>();
  for (const item of netRefundedLines(saleItems, refunds)) {
    if (!saleIds.has(item.saleId)) continue;
    const product = productById.get(item.productId);
    if (!product) continue;
    // the line's own snapshot (never today's cost); none -> unavailable
    const cost = typeof item.unitCostMmkSnapshot === "number" ? item.unitCostMmkSnapshot * item.qtyUnits : null;
    const row: TopProductRow = map.get(product.id) ?? {
      product,
      qty: 0,
      revenue: 0,
      cost: 0,
      profit: 0,
    };
    row.qty += item.qtyUnits;
    row.revenue += item.lineTotalMmk;
    row.cost = row.cost === null || cost === null ? null : row.cost + cost;
    row.profit = row.cost === null ? null : row.revenue - row.cost;
    map.set(product.id, row);
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
};

/**
 * Category revenue split — uses `lineTotalMmk` (line basis). Suitable
 * for proportional pie chart; the sum will be ≥ headline net revenue
 * when cart discounts apply. With `refunds`, returned units are taken out.
 */
export const calculateCategoryRevenue = (
  sales: Sale[],
  saleItems: SaleItem[],
  products: Product[],
  refunds?: RefundForMetrics[]
): Array<{ name: string; value: number }> => {
  const saleIds = new Set(sales.map((s) => s.id));
  const productById = new Map(products.map((p) => [p.id, p]));
  const map = new Map<string, number>();
  for (const item of netRefundedLines(saleItems, refunds)) {
    if (!saleIds.has(item.saleId)) continue;
    const product = productById.get(item.productId);
    if (!product) continue;
    map.set(product.category, (map.get(product.category) ?? 0) + item.lineTotalMmk);
  }
  return [...map.entries()].map(([name, value]) => ({ name, value }));
};

export interface SalesByCategoryPercentRow {
  name: string;
  value: number;
  percent: number;
}

/**
 * Sales by category percentage split for dashboard charts.
 *
 * Uses line totals because sale_items has the product/category context.
 * Cart-level discounts are not allocated back into categories yet, so
 * this is a proportional split of gross line revenue, not headline net
 * revenue.
 */
export const calculateSalesByCategoryPercent = (
  sales: Sale[],
  saleItems: SaleItem[],
  products: Product[],
  shopId: string | null,
  range: DateRange,
  now: Date = new Date(),
  refunds?: RefundForMetrics[]
): SalesByCategoryPercentRow[] => {
  const rangedSales = filterSalesByRange(scopeSales(sales, shopId), range, now);
  const rows = calculateCategoryRevenue(rangedSales, saleItems, products, refunds).sort(
    (a, b) => b.value - a.value
  );
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total <= 0) return [];
  return rows.map((row) => ({
    ...row,
    percent: (row.value / total) * 100,
  }));
};

export interface DailyRevenueCostProfitPoint {
  date: string;
  label: string;
  revenue: number;
  /** null: a line of that day has no cost snapshot (unavailable, not 0). */
  cost: number | null;
  profit: number | null;
}

/**
 * Admin profit trend chart data, grouped by business day (ORV-069).
 *
 * Revenue uses `calculateNetRevenue`, so approved PARTIAL refunds are
 * deducted when present; cost reverses the refunded units' cost. A refund is
 * booked against the day of its sale (sales carry the date; refund approval
 * time is not part of this model).
 */
export const calculateDailyRevenueCostProfitTrend = (
  sales: Sale[],
  saleItems: SaleItem[],
  products: Product[],
  refunds: RefundVoidRequest[],
  shopId: string | null,
  range: DateRange,
  now: Date = new Date()
): DailyRevenueCostProfitPoint[] => {
  const rangedSales = filterSalesByRange(scopeSales(sales, shopId), range, now);
  if (rangedSales.length === 0) return [];

  const salesByDay = new Map<string, Sale[]>();
  for (const sale of rangedSales) {
    const key = businessDayKey(sale.createdAt);
    if (!key) continue;
    const daySales = salesByDay.get(key) ?? [];
    daySales.push(sale);
    salesByDay.set(key, daySales);
  }

  return [...salesByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, daySales]) => {
      const revenue = calculateNetRevenue(daySales, refunds);
      const cost = calculateCostOfGoods(daySales, saleItems, products, refunds);
      return {
        date,
        label: date,
        revenue,
        cost,
        profit: calculateProfit(revenue, cost),
      };
    });
};

// ------------------------------------------------------------
// Per-shop name decoration (used by the all-shops low-stock card)
// ------------------------------------------------------------

export const decorateLowStockWithShopName = (
  rows: LowStockRow[],
  shops: Shop[]
): Array<LowStockRow & { shopName: string }> => {
  const shopById = new Map(shops.map((s) => [s.id, s]));
  return rows.map((row) => ({
    ...row,
    shopName: shopById.get(row.shopId)?.name ?? row.shopId,
  }));
};

// ------------------------------------------------------------
// Supplier debt helper (kept here for parity with future Dashboard
// supplier-debt card; not yet rendered, but tested)
// ------------------------------------------------------------

export interface SupplierDebtSummary {
  receivedTotal: number;
  paid: number;
  debt: number;
  openPoCount: number;
}

/**
 * Supplier debt rule (mirrors `04-features-workflows.md` › Purchase Orders):
 *   * Debt only counts RECEIVED POs. DRAFT / SUBMITTED / APPROVED /
 *     CANCELED never contribute.
 *   * Debt = sum(totalMmk) - sum(paidMmk), floored at 0.
 *   * Optional shop scope (null = all shops admin aggregate).
 */
export const calculateSupplierDebt = (
  purchaseOrders: PurchaseOrder[],
  shopId: string | null
): SupplierDebtSummary => {
  // Per-PO paid/balance math is shared with the suppliers workspace
  // (features/suppliers/debt.ts) so debt is computed identically everywhere.
  const received = purchaseOrders.filter(
    (po) => po.status === "RECEIVED" && (shopId === null || po.shopId === shopId)
  );
  const receivedTotal = received.reduce((sum, po) => sum + (po.totalMmk || 0), 0);
  const paid = received.reduce((sum, po) => sum + getPurchaseOrderPaidMmk(po), 0);
  const debt = received.reduce((sum, po) => sum + getPurchaseOrderBalanceMmk(po), 0);
  const openPoCount = received.filter((po) => getPurchaseOrderBalanceMmk(po) > 0).length;
  return { receivedTotal, paid, debt, openPoCount };
};

// ============================================================
// Date-range helpers — used by the Today / Week / Month KPI strip.
//
// Business days (Asia/Yangon, ORV-069), not the device clock:
// `today`   = business midnight today          → now
// `week`    = business midnight 7 days ago     → now (rolling)
// `month`   = business midnight on the 1st     → now
// ============================================================

export type DateRange = "today" | "week" | "month";

export const dateRangeStart = (range: DateRange, now: Date = new Date()): Date => {
  const today = businessToday(now);
  switch (range) {
    case "today":
      return businessDayStart(today);
    case "week":
      return businessDayStart(addDays(today, -7));
    case "month":
    default:
      return businessDayStart(monthStartKey(today));
  }
};

/** Keep sales whose `createdAt` falls within `[dateRangeStart(range), now]`. */
export const filterSalesByRange = (
  sales: Sale[],
  range: DateRange,
  now: Date = new Date()
): Sale[] => {
  const startMs = dateRangeStart(range, now).getTime();
  const endMs = now.getTime();
  return sales.filter((s) => {
    const t = Date.parse(s.createdAt);
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });
};

// ============================================================
// Dashboard scope + permission helpers.
//
// These helpers keep the role-sensitive page branch logic testable:
//   * ADMIN can aggregate all shops or select one shop.
//   * MANAGER / CASHIER / BUYER are locked to their assigned shop.
//   * Sensitive cards are rendered only when their granular permission
//     is present. ADMIN gets these through role defaults.
// ============================================================

export type DashboardSelectedShopId = string | "all";

export interface DashboardScope {
  selectedShopId: DashboardSelectedShopId;
  metricShopId: string | null;
  showAllShops: boolean;
  isBlocked: boolean;
}

export const resolveDashboardScope = (
  user: User | null | undefined,
  selectedShopId: DashboardSelectedShopId,
  assignedShopId: string
): DashboardScope => {
  if (!user) {
    return { selectedShopId: "", metricShopId: null, showAllShops: false, isBlocked: true };
  }

  if (user.role === "ADMIN") {
    if (selectedShopId === "all") {
      return { selectedShopId, metricShopId: null, showAllShops: true, isBlocked: false };
    }
    return {
      selectedShopId,
      metricShopId: selectedShopId || null,
      showAllShops: false,
      isBlocked: !selectedShopId,
    };
  }

  const lockedShopId = user.shopId || assignedShopId;
  return {
    selectedShopId: lockedShopId,
    metricShopId: lockedShopId || null,
    showAllShops: false,
    isBlocked: !lockedShopId,
  };
};

export interface DashboardVisibility {
  canViewShopSales: boolean;
  canViewOwnShift: boolean;
  canViewInventory: boolean;
  canViewProfit: boolean;
  canViewSupplierDebt: boolean;
  canViewApprovals: boolean;
  canViewPurchases: boolean;
  canViewTransfers: boolean;
  canViewAllShifts: boolean;
  canViewAudit: boolean;
  canViewGlobal: boolean;
}

const can = (user: User | null | undefined, permission: Permission): boolean =>
  hasPermission(user, permission);

export const getDashboardVisibility = (
  user: User | null | undefined
): DashboardVisibility => ({
  canViewShopSales: can(user, "report:shop_sales"),
  canViewOwnShift: can(user, "report:own_shift"),
  canViewInventory: can(user, "report:shop_inventory"),
  canViewProfit: can(user, "report:shop_profit"),
  canViewSupplierDebt: can(user, "supplier:debt_view"),
  canViewApprovals: can(user, "approval:view"),
  canViewPurchases: can(user, "purchase:view"),
  canViewTransfers: can(user, "transfer:view"),
  canViewAllShifts: can(user, "shift:manage_all"),
  canViewAudit: can(user, "audit:view_global"),
  canViewGlobal: can(user, "report:global"),
});

// ============================================================
// Action-Needed summary (Manager dashboard headline tile)
// ============================================================

export interface ActionNeededSummary {
  lowStockCount: number;
  outOfStockCount: number;
  pendingApprovals: number;
  pendingReceipts: number;
  pendingTransfers: number;
  /** Transfers IN_TRANSIT awaiting receipt at this shop (destination). */
  inTransitCount: number;
  total: number;
}

/**
 * Count of operational items needing attention for `shopId`.
 *   * lowStock / outOfStock — uses `calculateLowStock` so the rule is
 *     identical to the Low Stock card.
 *   * pendingApprovals — `refund_void_requests.status = 'REQUESTED'`.
 *   * pendingReceipts  — `purchase_orders.status = 'APPROVED'` (next
 *     step is receiving). DRAFT / SUBMITTED / RECEIVED / CANCELED don't
 *     need a receipt action.
 *   * pendingTransfers — `stock_transfers.status = 'PENDING'` where the
 *     shop is the SOURCE or DESTINATION.
 *
 * `null` shopId aggregates across all shops (admin view).
 */
export const calculateActionNeeded = (
  shopId: string | null,
  inventory: Inventory[],
  products: Product[],
  refunds: RefundVoidRequest[],
  purchaseOrders: PurchaseOrder[],
  stockTransfers: StockTransfer[],
  shops?: Shop[]
): ActionNeededSummary => {
  const lowRows = calculateLowStock(products, inventory, shopId, shops);
  const outOfStockCount = lowRows.filter((r) => r.status === "out").length;
  const lowStockCount = lowRows.filter((r) => r.status === "low").length;

  const inShop = (id: string | undefined): boolean => shopId === null || id === shopId;

  const pendingApprovals = refunds.filter(
    (r) => r.status === "REQUESTED" && inShop(r.shopId)
  ).length;
  const pendingReceipts = purchaseOrders.filter(
    (po) => po.status === "APPROVED" && inShop(po.shopId)
  ).length;
  const pendingTransfers = stockTransfers.filter(
    (t) => t.status === "PENDING" && (inShop(t.fromShopId) || inShop(t.toShopId))
  ).length;
  // Awaiting receipt at the destination — the action is the destination's.
  const inTransitCount = stockTransfers.filter(
    (t) => t.status === "IN_TRANSIT" && inShop(t.toShopId)
  ).length;

  return {
    lowStockCount,
    outOfStockCount,
    pendingApprovals,
    pendingReceipts,
    pendingTransfers,
    inTransitCount,
    total:
      lowStockCount + outOfStockCount + pendingApprovals + pendingReceipts +
      pendingTransfers + inTransitCount,
  };
};

// ============================================================
// Cash vs Other payment split (operational sanity tile)
// ============================================================

export interface PaymentSplit {
  cashCount: number;
  cashRevenue: number;
  otherCount: number;
  otherRevenue: number;
}

/**
 * Orders and revenue per payment method. With `refunds`, each method's
 * revenue is net of the approved refunds on its sales (ORV-034) — a refund
 * is taken to be paid back the way the sale was paid (until migration 090
 * records refund payouts with their own method). Without, gross totals.
 */
export const calculateCashVsOther = (
  sales: Pick<Sale, "id" | "paymentMethod" | "totalMmk">[],
  refunds?: RefundForMetrics[]
): PaymentSplit => {
  const cash = sales.filter((s) => s.paymentMethod === "CASH");
  const other = sales.filter((s) => s.paymentMethod !== "CASH");
  const revenue = (group: typeof sales) =>
    refunds ? calculateNetRevenue(group, refunds) : calculateGrossRevenue(group);
  return {
    cashCount: cash.length,
    cashRevenue: revenue(cash),
    otherCount: other.length,
    otherRevenue: revenue(other),
  };
};

// ============================================================
// Active shifts + expected cash (Manager + Admin operational tiles)
// ============================================================

export const filterActiveShifts = (shifts: Shift[], shopId: string | null): Shift[] =>
  shifts.filter((s) => !s.endedAt && (shopId === null || s.shopId === shopId));

/**
 * Sum of `opening_cash + cash sales - approved partial cash refunds` for
 * every currently-open shift in scope. Mirrors the formula `close_shift`
 * uses to recompute `expected_cash_mmk` at close time (migration 009).
 */
export const calculateExpectedCashForActiveShifts = (
  shifts: Shift[],
  sales: Sale[],
  refunds: RefundVoidRequest[],
  shopId: string | null
): number => {
  const activeShifts = filterActiveShifts(shifts, shopId);
  let total = 0;
  for (const shift of activeShifts) {
    const shiftSales = sales.filter((s) => s.shiftId === shift.id);
    const cashSales = shiftSales.filter((s) => s.paymentMethod === "CASH" && s.status !== "VOID");
    const cashTotal = cashSales.reduce((acc, s) => acc + s.totalMmk, 0);
    const cashSaleIds = new Set(cashSales.map((s) => s.id));
    const approvedRefunds = refunds
      .filter((r) => r.status === "APPROVED" && r.type === "PARTIAL" && cashSaleIds.has(r.saleId))
      .reduce(
        (acc, r) =>
          acc + (r.items ?? []).reduce((b, item) => b + (item.amountMmk || 0), 0),
        0
      );
    total += shift.openingCashMmk + cashTotal - approvedRefunds;
  }
  return Math.max(total, 0);
};

export interface ActiveShiftRow {
  shift: Shift;
  user: User | undefined;
  shop: Shop | undefined;
}

export const listActiveShiftRows = (
  shifts: Shift[],
  users: User[],
  shops: Shop[],
  shopId: string | null
): ActiveShiftRow[] => {
  return filterActiveShifts(shifts, shopId).map((shift) => ({
    shift,
    user: users.find((u) => u.id === shift.cashierId),
    shop: shops.find((s) => s.id === shift.shopId),
  }));
};

// ============================================================
// Per-shop business overview (Admin Shop Performance table)
// ============================================================

export interface PerShopMetrics {
  shop: Shop;
  orders: number;
  revenue: number; // net
  /** null: cost evidence incomplete (unavailable, not 0). */
  cost: number | null;
  profit: number | null;
  margin: number | null;
  activeShifts: number;
  debt: number;
}

export const calculatePerShopMetrics = (
  sales: Sale[],
  saleItems: SaleItem[],
  products: Product[],
  shops: Shop[],
  refunds: RefundVoidRequest[],
  shifts: Shift[],
  purchaseOrders: PurchaseOrder[]
): PerShopMetrics[] => {
  return shops.map((shop) => {
    const scoped = scopeSales(sales, shop.id);
    const revenue = calculateNetRevenue(scoped, refunds);
    const cost = calculateCostOfGoods(scoped, saleItems, products, refunds);
    const profit = calculateProfit(revenue, cost);
    return {
      shop,
      orders: scoped.length,
      revenue,
      cost,
      profit,
      margin: calculateProfitMargin(revenue, profit),
      activeShifts: filterActiveShifts(shifts, shop.id).length,
      debt: calculateSupplierDebt(purchaseOrders, shop.id).debt,
    };
  });
};

// ============================================================
// Supplier debt grouped by shop / supplier (Admin debt cards)
// ============================================================

export interface DebtGroup {
  id: string;
  name: string;
  debt: number;
  openPoCount: number;
}

export const groupSupplierDebtByShop = (
  purchaseOrders: PurchaseOrder[],
  shops: Shop[]
): DebtGroup[] =>
  shops
    .map((shop) => {
      const r = calculateSupplierDebt(purchaseOrders, shop.id);
      return { id: shop.id, name: shop.name, debt: r.debt, openPoCount: r.openPoCount };
    })
    .filter((row) => row.debt > 0)
    .sort((a, b) => b.debt - a.debt);

export const groupSupplierDebtBySupplier = (
  purchaseOrders: PurchaseOrder[],
  suppliers: Supplier[],
  shopId: string | null
): DebtGroup[] => {
  const received = purchaseOrders.filter(
    (po) => po.status === "RECEIVED" && (shopId === null || po.shopId === shopId)
  );
  type Agg = { receivedTotal: number; paid: number; openPoCount: number };
  const map = new Map<string, Agg>();
  for (const po of received) {
    const row = map.get(po.supplierId) ?? { receivedTotal: 0, paid: 0, openPoCount: 0 };
    row.receivedTotal += po.totalMmk;
    row.paid += po.paidMmk ?? 0;
    if ((po.paidMmk ?? 0) < po.totalMmk) row.openPoCount += 1;
    map.set(po.supplierId, row);
  }
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const rows: DebtGroup[] = [];
  for (const [supplierId, agg] of map.entries()) {
    const debt = Math.max(agg.receivedTotal - agg.paid, 0);
    if (debt <= 0) continue;
    rows.push({
      id: supplierId,
      name: supplierById.get(supplierId)?.name ?? supplierId,
      debt,
      openPoCount: agg.openPoCount,
    });
  }
  return rows.sort((a, b) => b.debt - a.debt);
};

// ============================================================
// Pending lists (drilldowns for the Manager Action cards)
// ============================================================

export const filterPendingApprovals = (
  refunds: RefundVoidRequest[],
  shopId: string | null
): RefundVoidRequest[] =>
  refunds.filter((r) => r.status === "REQUESTED" && (shopId === null || r.shopId === shopId));

export const filterPendingReceipts = (
  purchaseOrders: PurchaseOrder[],
  shopId: string | null
): PurchaseOrder[] =>
  purchaseOrders.filter(
    (po) => po.status === "APPROVED" && (shopId === null || po.shopId === shopId)
  );

export const filterPendingTransfers = (
  stockTransfers: StockTransfer[],
  shopId: string | null
): StockTransfer[] =>
  stockTransfers.filter(
    (t) =>
      t.status === "PENDING" &&
      (shopId === null || t.fromShopId === shopId || t.toShopId === shopId)
  );

/**
 * Most-recent transfers in scope (newest first), for the "Transfers Between
 * Shops" dashboard card. `null` shopId = all shops (admin); otherwise transfers
 * where the shop is the source OR destination.
 */
export const recentTransfers = (
  stockTransfers: StockTransfer[],
  shopId: string | null,
  limit = 6
): StockTransfer[] =>
  [...stockTransfers]
    .filter((t) => shopId === null || t.fromShopId === shopId || t.toShopId === shopId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

// ============================================================
// Recent audit (Admin dashboard, requires audit:view_global RLS-side)
// ============================================================

export const recentAuditLogs = (
  auditLogs: AuditLog[],
  limit = 10
): AuditLog[] =>
  [...auditLogs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
