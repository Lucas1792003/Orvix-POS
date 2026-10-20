import { useMemo, useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { useDataStore } from "../stores/dataStore";
import { Card } from "../components/ui/Card";
import { Select } from "../components/ui/Select";
import { PageHeader } from "../components/layout/PageHeader";
import { DateRangePicker } from "../components/forms/DateRangePicker";
import { formatMmk } from "../lib/utils";
import { addDays, businessToday } from "../lib/businessDay";
import {
  BASIS_LABEL,
  MAX_ORG_RANGE_DAYS,
  MAX_SHOP_RANGE_DAYS,
  type FinReportSummary,
  type RefundBasis,
} from "../features/reports/finReports";
import { useFinReport } from "../features/reports/useFinReport";
import { BasisBadge, FinStatusNotice, FinWarnings } from "../features/reports/FinReportStatus";

const dayCount = (start: string, end: string): number =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;

const lastSevenDays = () => {
  const today = businessToday();
  return { start: addDays(today, -6), end: today };
};

const Stat = ({ label, value, detail }: { label: string; value: string; detail?: string }) => (
  <Card>
    <div className="text-sm text-slate-500">{label}</div>
    <div className="mt-2 text-2xl font-semibold">{value}</div>
    {detail && <div className="mt-1 text-xs text-slate-500">{detail}</div>}
  </Card>
);

/**
 * One basis of the report. Every figure comes from the server
 * (fin_report_summary); nothing is computed from the client cache.
 */
const BasisSection = ({ title, basis, report }: { title: string; basis: RefundBasis; report: FinReportSummary }) => {
  const t = report.totals;
  const maxDay = Math.max(1, ...report.byDay.map((d) => Math.abs(d.netRevenueMmk)));
  return (
    <section className="space-y-4" data-basis={basis}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <BasisBadge basis={basis} />
      </div>
      <p className="text-xs text-slate-500">{BASIS_LABEL[basis]}. Refunds are assumed paid back by the original payment method.</p>
      <FinWarnings report={report} />
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Net revenue" value={formatMmk(t.netRevenueMmk)} detail={`${t.saleCount} sale(s)`} />
        <Stat label="Gross sales" value={formatMmk(t.grossSalesMmk)} detail="after discounts" />
        <Stat label="Refunds" value={formatMmk(t.refundMmk)} detail={`${t.refundCount} approved`} />
        {basis === "APPROVAL_DATE" ? (
          <Stat label="Voids" value={formatMmk(t.voidMmk)} detail={`${t.voidCount} approved`} />
        ) : (
          <Stat
            label="Voided sales (excluded)"
            value={formatMmk(report.excludedVoids?.amountMmk ?? 0)}
            detail={`${report.excludedVoids?.count ?? 0} sale(s) left out of gross`}
          />
        )}
      </div>
      <Card>
        <div className="text-sm font-semibold">By payment method</div>
        <div className="mt-3 grid gap-2">
          {report.byPaymentMethod.map((m) => (
            <div key={m.method} className="flex items-center justify-between text-sm">
              <span>{m.method}</span>
              <span className="font-semibold">{formatMmk(m.netMmk)}</span>
            </div>
          ))}
          {report.byPaymentMethod.length === 0 && <div className="text-sm text-slate-400">No sales in this range.</div>}
        </div>
      </Card>
      <Card>
        <div className="text-sm font-semibold">Net by business day</div>
        <div className="mt-4 grid gap-3">
          {report.byDay.map((d) => (
            <div key={d.date} className="flex min-w-0 items-center gap-3" data-day={d.date}>
              <div className="w-24 shrink-0 text-xs text-slate-500">{d.date}</div>
              <div className="min-w-0 flex-1 rounded-full bg-slate-100">
                <div
                  className={`h-3 rounded-full ${d.netRevenueMmk < 0 ? "bg-rose-500" : "bg-indigo-600"}`}
                  style={{ width: `${Math.min(100, (Math.abs(d.netRevenueMmk) / maxDay) * 100)}%` }}
                />
              </div>
              <div className="w-28 shrink-0 text-right text-xs font-semibold">{formatMmk(d.netRevenueMmk)}</div>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
};

export const ReportsPage = () => {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const shops = useDataStore((state) => state.shops);
  const isAdmin = currentUser?.role === "ADMIN";

  const [range, setRange] = useState(lastSevenDays);
  // ADMIN: a shop or all shops. Everyone else: the server scopes to their own shop / sales.
  const [shopFilter, setShopFilter] = useState<string>("all");
  const shopId = isAdmin && shopFilter !== "all" ? shopFilter : null;

  const days = dayCount(range.start, range.end);
  const limit = isAdmin && shopId === null ? MAX_ORG_RANGE_DAYS : MAX_SHOP_RANGE_DAYS;
  const rangeError =
    !range.start || !range.end || !(days >= 1) ? "Choose a start and an end day."
    : days > limit ? `This view covers at most ${limit} days${limit === MAX_ORG_RANGE_DAYS ? " for all shops; choose one shop for longer ranges" : ""}.`
    : null;

  const params = useMemo(
    () => (currentUser && !rangeError ? { shopId, from: range.start, to: range.end } : null),
    [currentUser, rangeError, shopId, range.start, range.end],
  );
  const sales = useFinReport(params ? { ...params, basis: "SALE_DATE" } : null);
  const cash = useFinReport(params ? { ...params, basis: "APPROVAL_DATE" } : null);

  return (
    <div className="space-y-6">
      <PageHeader title="Reports" subtitle="Server-verified figures over the full history, on Asia/Yangon business days." />
      <div className="flex flex-wrap gap-3">
        <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
        {isAdmin && (
          <Select value={shopFilter} onChange={(e) => setShopFilter(e.target.value)} className="min-w-48 flex-1 md:w-auto md:flex-none">
            <option value="all">All shops</option>
            {shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
          </Select>
        )}
      </div>
      {rangeError && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{rangeError}</div>}

      <FinStatusNotice state={sales.state} onRetry={sales.refresh}>
        {(report) => <BasisSection title="Sales performance" basis="SALE_DATE" report={report} />}
      </FinStatusNotice>

      <FinStatusNotice state={cash.state} onRetry={cash.refresh}>
        {(report) => <BasisSection title="Cash flow" basis="APPROVAL_DATE" report={report} />}
      </FinStatusNotice>
    </div>
  );
};
