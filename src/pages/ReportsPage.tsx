import { useMemo } from "react";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import { Card } from "../components/ui/Card";
import { PageHeader } from "../components/layout/PageHeader";
import { formatMmk, getEffectiveShopId } from "../lib/utils";
import { calculateShopReportSummary } from "../features/reports/shopReportSummary";

export const ReportsPage = () => {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const { currentShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const sales = useDataStore((state) => state.sales);
  const refunds = useDataStore((state) => state.refundVoidRequests);

  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);

  // Net of refunds, business days (ORV-034/069); still the all-time,
  // store-cached placeholder (ORV-035) — see features/reports/shopReportSummary.ts.
  const { totalSales, cashSales, otherSales, dailyTotals } = useMemo(
    () => calculateShopReportSummary(sales, refunds, shopId),
    [sales, refunds, shopId],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" subtitle="Quick view of shop performance." />
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <div className="text-sm text-slate-500">Total sales</div>
          <div className="mt-2 text-2xl font-semibold">{formatMmk(totalSales)}</div>
        </Card>
        <Card>
          <div className="text-sm text-slate-500">Cash</div>
          <div className="mt-2 text-2xl font-semibold">{formatMmk(cashSales)}</div>
        </Card>
        <Card>
          <div className="text-sm text-slate-500">Other</div>
          <div className="mt-2 text-2xl font-semibold">{formatMmk(otherSales)}</div>
        </Card>
      </div>
      <Card>
        <div className="text-lg font-semibold">7-day sales pulse</div>
        <div className="mt-4 grid gap-3">
          {dailyTotals.map(([date, value]) => (
            <div key={date} className="flex min-w-0 items-center gap-3">
              <div className="w-24 shrink-0 text-xs text-slate-500">{date}</div>
              <div className="min-w-0 flex-1 rounded-full bg-slate-100">
                <div className="h-3 rounded-full bg-indigo-600" style={{ width: `${Math.min(100, (value / (totalSales || 1)) * 100)}%` }} />
              </div>
              <div className="w-28 shrink-0 text-right text-xs font-semibold">{formatMmk(value)}</div>
            </div>
          ))}
          {dailyTotals.length === 0 && <div className="text-sm text-slate-400">No sales yet.</div>}
        </div>
      </Card>
    </div>
  );
};
