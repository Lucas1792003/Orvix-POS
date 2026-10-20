import { useMemo } from "react";
import { addDays, businessToday, monthStartKey } from "../../lib/businessDay";
import { profitOf, type FinReportSummary, type FinResult } from "../reports/finReports";
import { useFinReport, useFinReportsByShop, type FinState } from "../reports/useFinReport";
import type { DateRange } from "./dashboardMetrics";

/** Business-day bounds of a dashboard range (the same windows as dateRangeStart). */
export const dashboardRangeDays = (range: DateRange, now: Date = new Date()): { from: string; to: string } => {
  const today = businessToday(now);
  switch (range) {
    case "today":
      return { from: today, to: today };
    case "week":
      return { from: addDays(today, -7), to: today };
    case "month":
    default:
      return { from: monthStartKey(today), to: today };
  }
};

export interface ServerKpis {
  revenue: number;
  orders: number;
  aov: number;
  /** null: cost not visible to the caller, or incomplete. */
  profit: number | null;
  marginPct: number | null;
  costIncomplete: boolean;
}

export const kpisOf = (r: FinReportSummary): ServerKpis => {
  const { profit, marginPct } = profitOf(r.totals);
  return {
    revenue: r.totals.netRevenueMmk,
    orders: r.totals.saleCount,
    aov: r.totals.saleCount > 0 ? Math.round(r.totals.netRevenueMmk / r.totals.saleCount) : 0,
    profit,
    marginPct,
    costIncomplete: r.totals.cogsComplete === false,
  };
};

export interface ServerTrendPoint {
  date: string;
  label: string;
  revenue: number;
  /** null: hidden or incomplete for that day (drawn as a gap, never as 0). */
  cost: number | null;
  profit: number | null;
}

export const trendOf = (r: FinReportSummary): ServerTrendPoint[] =>
  r.byDay
    .filter((d) => d.saleCount > 0 || d.refundCount > 0 || d.voidCount > 0)
    .map((d) => ({
      date: d.date, label: d.date, revenue: d.netRevenueMmk,
      // the server returns the KNOWN part of cost when it is incomplete: never draw that as the day's cost
      cost: d.cogsComplete === true ? d.cogsMmk : null,
      profit: d.grossProfitMmk,
    }));

/**
 * The dashboard's money headline (sales-performance basis: refunds on the
 * original sale's day). `shopId` null = the caller's whole scope (ADMIN: all
 * shops; others: their own shop or own sales, decided by the server).
 */
export function useDashboardFinancials(shopId: string | null, range: DateRange, enabled = true) {
  const { from, to } = dashboardRangeDays(range);
  const params = useMemo(() => (enabled ? { shopId, from, to, basis: "SALE_DATE" as const } : null), [enabled, shopId, from, to]);
  const { state, refresh } = useFinReport(params);
  const kpis = state.status === "ok" ? kpisOf(state.data) : null;
  const trend = state.status === "ok" ? trendOf(state.data) : [];
  return { state, refresh, kpis, trend, report: state.status === "ok" ? state.data : null };
}

export function useDashboardShopFinancials(shopIds: string[] | null, range: DateRange) {
  const { from, to } = dashboardRangeDays(range);
  const { state, refresh } = useFinReportsByShop(shopIds, from, to, "SALE_DATE");
  const byShop: Record<string, FinResult<FinReportSummary>> = state.status === "ok" ? state.data : {};
  return { state, refresh, byShop };
}

/** One short status word for a KPI tile when the server has not answered. */
export const pendingText = <T,>(state: FinState<T>, text: { loading: string; unavailable: string; forbidden?: string }): string | null =>
  state.status === "ok" ? null
  : state.status === "loading" || state.status === "idle" ? text.loading
  : state.status === "forbidden" && text.forbidden ? text.forbidden
  : text.unavailable;

/** Whether "Try again" can help (not for a refusal or a bad argument). */
export const canRetry = <T,>(state: FinState<T>): boolean => state.status === "unavailable" || state.status === "error";
