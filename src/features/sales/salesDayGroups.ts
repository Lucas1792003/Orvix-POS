import type { Sale } from "../../types";
import { businessDayKey } from "../../lib/businessDay";
import { calculateNetRevenue, scopeSales, type RefundForMetrics } from "../dashboard/dashboardMetrics";

export interface SalesDayGroup<T> {
  /** Business day, YYYY-MM-DD (Asia/Yangon). */
  day: string;
  /** Every listed sale of the day, VOID included (shown, not counted). */
  sales: T[];
  /** Net takings: VOID dropped, REFUNDED net of approved refunds (ORV-034). */
  netTotal: number;
}

/**
 * Sales page sections: sales grouped by BUSINESS day — not
 * `createdAt.slice(0, 10)`, the UTC date, which put 00:00–06:30 Yangon on
 * the previous day (ORV-069) — in the order given.
 */
export const groupSalesByBusinessDay = <T extends Pick<Sale, "id" | "shopId" | "status" | "totalMmk" | "createdAt">>(
  sales: T[],
  refunds: RefundForMetrics[],
): SalesDayGroup<T>[] => {
  const groups = new Map<string, T[]>();
  for (const sale of sales) {
    const day = businessDayKey(sale.createdAt) ?? "";
    const bucket = groups.get(day);
    if (bucket) bucket.push(sale);
    else groups.set(day, [sale]);
  }
  return [...groups.entries()].map(([day, daySales]) => ({
    day,
    sales: daySales,
    netTotal: calculateNetRevenue(scopeSales(daySales, null), refunds),
  }));
};

/** The sales of one business day (or all of them for "all"). */
export const filterSalesByBusinessDay = <T extends Pick<Sale, "createdAt">>(sales: T[], day: string): T[] =>
  day === "all" ? sales : sales.filter((s) => businessDayKey(s.createdAt) === day);
