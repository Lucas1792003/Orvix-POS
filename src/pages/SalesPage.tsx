import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Select } from "../components/ui/Select";
import { SearchInput } from "../components/forms/SearchInput";
import { SalesTable } from "../components/sales/SalesTable";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { downloadCsv } from "../lib/csv";
import { getErrorMessage } from "../lib/errors";
import { supabase } from "../lib/supabase";
import { formatDate, formatMmk, getEffectiveShopId } from "../lib/utils";
import { Input } from "../components/ui/Input";
import { hasPermission } from "../lib/permissions";
import {
  buildDailySalesReportsByShop,
  getLocalDateValue,
  getOpenShiftReportNotice,
} from "../features/sales/dailySalesReport";
import { formatMonthLabel, getMonthBounds, inCurrentMonth } from "../features/sales/monthCycle";
import { WeeklyReportCountdown } from "../features/sales/WeeklyReportCountdown";
import { businessDayKey, businessToday, dayKeyToDisplayDate, isDayKey } from "../lib/businessDay";
import { filterSalesByBusinessDay, groupSalesByBusinessDay } from "../features/sales/salesDayGroups";

// A business-day key shown as that calendar date on any device
// (`formatDate("YYYY-MM-DD")` parses it as UTC midnight: the day before
// west of UTC).
const formatDayKey = (key: string) => (isDayKey(key) ? formatDate(dayKeyToDisplayDate(key)) : key);

export const SalesPage = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState("all");
  const [cashier, setCashier] = useState("all");
  const [search, setSearch] = useState("");
  // Default to today's sales (business day, Asia/Yangon — ORV-069); the
  // calendar filter / "show all days" can widen it.
  const [dayFilter, setDayFilter] = useState(() => businessToday());
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const [sendingDailyReport, setSendingDailyReport] = useState(false);
  const toast = useToast();

  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const { currentShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const users = useDataStore((state) => state.users);
  const sales = useDataStore((state) => state.sales);
  const saleItems = useDataStore((state) => state.saleItems);
  const refunds = useDataStore((state) => state.refundVoidRequests);
  const products = useDataStore((state) => state.products);
  const shifts = useDataStore((state) => state.shifts);

  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  // A cashier without the broad `sale:view` permission only sees their own
  // sales — this matches the sales_sel RLS in migration 015 (defense in depth).
  const canViewShopSales = hasPermission(currentUser, "sale:view");
  const ownSalesOnly = !canViewShopSales;
  const isAdmin = currentUser?.role === "ADMIN";

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const saleItemsBySaleId = useMemo(() => {
    const itemsBySale = new Map<string, typeof saleItems>();
    saleItems.forEach((item) => {
      const existingItems = itemsBySale.get(item.saleId);
      if (existingItems) {
        existingItems.push(item);
      } else {
        itemsBySale.set(item.saleId, [item]);
      }
    });
    return itemsBySale;
  }, [saleItems]);

  // Recomputed each render (cheap) so the month boundaries stay current.
  const monthBounds = getMonthBounds();
  // Business-day YYYY-MM-DD for the date input + its min/max (the calendar
  // is limited to the current month, which is all this page shows).
  const monthMin = businessDayKey(monthBounds.thisStart) ?? "";
  const monthMax = businessDayKey(monthBounds.nextStart - 1) ?? "";

  // The "Email …'s CSV" button targets the day the admin is viewing: today
  // by default, or the day picked in the calendar filter.
  const todayKey = getLocalDateValue();
  const emailTargetDate = dayFilter !== "all" ? dayFilter : todayKey;
  const emailIsToday = emailTargetDate === todayKey;

  const filteredSales = useMemo(() => {
    const searchTerm = search.trim().toLowerCase();

    return sales.filter((sale) => {
      const matchesShop = sale.shopId === shopId;
      const matchesOwner = !ownSalesOnly || sale.cashierId === currentUserId;
      // Only the current month is shown here; past months are archived +
      // emailed away by the monthly job.
      const matchesMonth = inCurrentMonth(sale.createdAt, monthBounds);
      const matchesStatus = status === "all" || sale.status === status;
      const matchesCashier = ownSalesOnly || cashier === "all" || sale.cashierId === cashier;
      const cashierName = usersById.get(sale.cashierId)?.name ?? "";
      const saleLineItems = saleItemsBySaleId.get(sale.id) ?? [];
      const searchableText = [
        sale.receiptNo,
        cashierName,
        sale.paymentMethod,
        sale.status,
        sale.totalMmk.toString(),
        sale.totalMmk.toLocaleString("en-US"),
        formatMmk(sale.totalMmk),
        ...saleLineItems.flatMap((item) => {
          const product = productsById.get(item.productId);
          return [
            product?.name,
            product?.shortName,
            product?.sku,
            product?.aliasCode,
            item.unitLabel,
            item.unitNameSnapshot,
            item.unitPriceMmk.toString(),
            item.unitPriceMmk.toLocaleString("en-US"),
            item.lineTotalMmk.toString(),
            item.lineTotalMmk.toLocaleString("en-US"),
          ];
        }),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const matchesSearch = !searchTerm || searchableText.includes(searchTerm);
      return matchesShop && matchesOwner && matchesMonth && matchesStatus && matchesCashier && matchesSearch;
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.receiptNo.localeCompare(a.receiptNo));
  }, [
    sales,
    shopId,
    ownSalesOnly,
    currentUserId,
    monthBounds,
    status,
    cashier,
    search,
    usersById,
    saleItemsBySaleId,
    productsById,
  ]);

  // Business days, not the UTC date (ORV-069); day totals net of refunds
  // (ORV-034) — see features/sales/salesDayGroups.ts.
  const displayedSales = useMemo(
    () => filterSalesByBusinessDay(filteredSales, dayFilter),
    [filteredSales, dayFilter]
  );

  // Group the displayed sales by business day so each day is a clearly-headed section.
  const groupedByDay = useMemo(
    () => groupSalesByBusinessDay(displayedSales, refunds),
    [displayedSales, refunds]
  );

  const exportSales = () => {
    const rows = filteredSales.map((sale) => ({
      receiptNo: sale.receiptNo,
      createdAt: sale.createdAt,
      cashier: usersById.get(sale.cashierId)?.name ?? "",
      paymentMethod: sale.paymentMethod,
      totalMmk: sale.totalMmk,
      status: sale.status,
    }));
    downloadCsv("sales.csv", rows);
  };

  const emailDailySalesReport = async (reportDate: string = getLocalDateValue()) => {
    if (!currentUser || currentUser.role !== "ADMIN") {
      toast({
        title: "Admin only",
        description: "Only an admin account can email the all-branch daily sales report.",
        variant: "error",
      });
      return;
    }

    const adminEmail = currentUser.email?.trim();
    if (!adminEmail) {
      toast({
        title: "Admin email missing",
        description: "Add an email address to the admin account before sending reports.",
        variant: "error",
      });
      return;
    }

    // Open shifts no longer block the send — the admin asked to be
    // notified inside the email instead. Pass the structured notice
    // through to the edge function, which renders it as a banner in
    // the email body so the data-may-be-incomplete warning still lands
    // in front of the admin without aborting the send.
    const openShiftNotice = getOpenShiftReportNotice(shifts, users, shops);

    // Per-shop bundles — one CSV attachment per shop with sales on the
    // report date. Empty shops are skipped so the admin doesn't get a
    // wall of zero-row files.
    const bundle = buildDailySalesReportsByShop({
      reportDate,
      sales,
      saleItems,
      products,
      users,
      shops,
    });

    setSendingDailyReport(true);
    try {
      const { data, error } = await supabase.functions.invoke<{
        sent?: boolean;
        recipient?: string;
        error?: string;
      }>("email-sales-report", {
        body: {
          subject: bundle.subject,
          reportDateLabel: bundle.reportDateLabel,
          totalSaleCount: bundle.totalSaleCount,
          totalRowCount: bundle.totalRowCount,
          attachments: bundle.shopReports.map((report) => ({
            filename: report.filename,
            csv: report.csv,
          })),
          shopSummaries: bundle.shopReports.map((report) => ({
            shopName: report.shopName,
            shopCode: report.shopCode,
            filename: report.filename,
            saleCount: report.saleCount,
            rowCount: report.rowCount,
          })),
          openShiftNotice,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const shopCount = bundle.shopReports.length;
      toast({
        title: openShiftNotice
          ? "Daily sales report emailed (partial)"
          : "Daily sales report emailed",
        description: openShiftNotice
          ? `Sent ${bundle.totalSaleCount} sales across ${shopCount} shop${shopCount === 1 ? "" : "s"} to ${data?.recipient ?? adminEmail}. ${openShiftNotice.openShiftCount} shift${openShiftNotice.openShiftCount === 1 ? "" : "s"} still open — flagged in the email.`
          : `Sent ${bundle.totalSaleCount} sales across ${shopCount} shop${shopCount === 1 ? "" : "s"} to ${data?.recipient ?? adminEmail}.`,
        variant: "success",
      });
    } catch (error) {
      console.error("[SalesPage] email daily sales report failed", error);
      toast({
        title: "Email report failed",
        description: getErrorMessage(error, "Could not email the daily sales report. Check the email function configuration."),
        variant: "error",
      });
    } finally {
      setSendingDailyReport(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales"
        subtitle="Track sales, voids, refunds, and reprints."
        actions={
          <>
            {isAdmin && <WeeklyReportCountdown />}
            <Button variant="secondary" onClick={exportSales}>Export CSV</Button>
            {isAdmin && (
              <Button onClick={() => emailDailySalesReport(emailTargetDate)} disabled={sendingDailyReport}>
                {sendingDailyReport
                  ? "Sending..."
                  : emailIsToday
                    ? "Email today's CSV"
                    : `Email ${formatDayKey(emailTargetDate)} CSV`}
              </Button>
            )}
          </>
        }
      />

      <Card>
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
            This month
          </span>
          <span className="text-slate-500">{formatMonthLabel(monthBounds)}</span>
        </div>
        <div className="flex flex-wrap gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search receipt, product, cashier, amount" className="min-w-64 flex-1 md:w-72 md:flex-none" />
          <Select value={status} onChange={(event) => setStatus(event.target.value)} className="min-w-44 flex-1 md:w-auto md:flex-none">
            <option value="all">All statuses</option>
            <option value="NORMAL">Normal</option>
            <option value="VOID">Void</option>
            <option value="REFUNDED">Refunded</option>
          </Select>
          {!ownSalesOnly && (
            <Select value={cashier} onChange={(event) => setCashier(event.target.value)} className="min-w-48 flex-1 md:w-auto md:flex-none">
              <option value="all">All cashiers</option>
              {users.filter((user) => user.role === "CASHIER").map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </Select>
          )}

          {/* Date filter — a button that opens a calendar; picking a day in
              this month replaces the list with that day's sales. */}
          <div className="relative md:ml-auto">
            <Button
              variant={dayFilter === "all" ? "secondary" : "primary"}
              onClick={() => setDateFilterOpen((open) => !open)}
            >
              <span className="material-symbols-rounded mr-1 text-base">calendar_month</span>
              {dayFilter === "all" ? "Filter by date" : formatDayKey(dayFilter)}
            </Button>
            {dateFilterOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setDateFilterOpen(false)} />
                <div className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    Pick a date ({formatMonthLabel(monthBounds)})
                  </div>
                  <Input
                    type="date"
                    min={monthMin}
                    max={monthMax}
                    value={dayFilter === "all" ? "" : dayFilter}
                    onChange={(event) => {
                      setDayFilter(event.target.value || "all");
                      setDateFilterOpen(false);
                    }}
                  />
                  {dayFilter !== "all" && (
                    <button
                      type="button"
                      onClick={() => {
                        setDayFilter("all");
                        setDateFilterOpen(false);
                      }}
                      className="mt-2 w-full rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200"
                    >
                      Clear — show all days
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="mt-6 space-y-6">
          {displayedSales.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300/70 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
              No sales found.
            </div>
          ) : (
            groupedByDay.map((group) => (
              <div key={group.day} className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <div className="text-sm font-semibold text-slate-700">{formatDayKey(group.day)}</div>
                  <div className="text-xs text-slate-500">
                    {group.sales.length} sale{group.sales.length === 1 ? "" : "s"} · {formatMmk(group.netTotal)}
                  </div>
                </div>
                <SalesTable
                  sales={group.sales}
                  users={users}
                  onView={(saleId) => navigate(`/app/sales/${saleId}`)}
                />
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
};
