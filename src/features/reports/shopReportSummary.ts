import type { Sale } from "../../types";
import { businessDayKey } from "../../lib/businessDay";
import { calculateNetRevenue, scopeSales, type RefundForMetrics } from "../dashboard/dashboardMetrics";

export interface ShopReportSummary {
  totalSales: number;
  cashSales: number;
  otherSales: number;
  /** Last 7 business days with sales, oldest first: [YYYY-MM-DD, net]. */
  dailyTotals: (readonly [string, number])[];
}

/**
 * Reports page (shop) summary — the dashboard's money rules (ORV-034):
 * VOID dropped; partly refunded (REFUNDED) sales kept net of their approved
 * refunds. Days are business days (ORV-069). Still the all-time,
 * store-cached placeholder view (ORV-035): it sees only the sales in the
 * client cache.
 */
export const calculateShopReportSummary = (
  sales: Pick<Sale, "id" | "shopId" | "status" | "totalMmk" | "paymentMethod" | "createdAt">[],
  refunds: RefundForMetrics[],
  shopId: string | null | undefined,
): ShopReportSummary => {
  const shopSales = shopId ? scopeSales(sales, shopId) : [];
  const cash = shopSales.filter((sale) => sale.paymentMethod === "CASH");
  const byDay = new Map<string, typeof shopSales>();
  for (const sale of shopSales) {
    const day = businessDayKey(sale.createdAt);
    if (!day) continue;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(sale);
    else byDay.set(day, [sale]);
  }
  const totalSales = calculateNetRevenue(shopSales, refunds);
  const cashSales = calculateNetRevenue(cash, refunds);
  return {
    totalSales,
    cashSales,
    otherSales: totalSales - cashSales,
    dailyTotals: [...byDay.entries()]
      .sort((a, b) => (a[0] > b[0] ? 1 : -1))
      .slice(-7)
      .map(([day, daySales]) => [day, calculateNetRevenue(daySales, refunds)] as const),
  };
};
