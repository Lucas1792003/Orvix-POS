import type { Product, Shop } from "../../types";
import { isWithinBusinessDays } from "../../lib/businessDay";
import {
  calculateCostOfGoods,
  calculateNetRevenue,
  calculateProfit,
  calculateProfitMargin,
  scopeSales,
  type RefundForMetrics,
} from "../dashboard/dashboardMetrics";
import type { RangedSale, RangedSaleItem } from "./useRangedSales";

export interface ProfitByShopRow {
  shopId: string;
  shopName: string;
  revenue: number;
  cost: number;
  profit: number;
  margin: number;
}

/**
 * Profit Reports "by shop" table — the same money rules as the dashboard
 * (dashboardMetrics): VOID dropped; REFUNDED (partly/wholly refunded) kept,
 * net of approved refund amounts and of the refunded units' cost (ORV-034).
 * `range` is in business days (Asia/Yangon, ORV-069); the server query
 * already bounds it, the filter here is defence in depth.
 */
export const calculateProfitByShop = (input: {
  shops: Pick<Shop, "id" | "name">[];
  sales: RangedSale[];
  saleItems: RangedSaleItem[];
  refunds: RefundForMetrics[];
  products: Pick<Product, "id" | "costMmk">[];
  range: { start: string; end: string };
  shopId: string | null;
}): ProfitByShopRow[] => {
  const { shops, sales, saleItems, refunds, products, range, shopId } = input;
  const rows: ProfitByShopRow[] = [];
  for (const shop of shops) {
    if (shopId && shop.id !== shopId) continue;
    const shopSales = scopeSales(sales, shop.id).filter((s) =>
      isWithinBusinessDays(s.createdAt, range.start, range.end),
    );
    const revenue = calculateNetRevenue(shopSales, refunds);
    const cost = calculateCostOfGoods(shopSales, saleItems, products, refunds);
    const profit = calculateProfit(revenue, cost);
    rows.push({
      shopId: shop.id,
      shopName: shop.name,
      revenue,
      cost,
      profit,
      margin: calculateProfitMargin(revenue, profit),
    });
  }
  return rows;
};
