import { useMemo, useState } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Badge } from "../../components/ui/Badge";
import { hasPermission } from "../../lib/permissions";
import { formatDateTime, formatMmk } from "../../lib/utils";
import { useDataStore } from "../../stores/dataStore";
import type { Shop, User } from "../../types";
import {
  calculateActionNeeded,
  calculateLowStock,
  calculateSalesByCategoryPercent,
  calculateSupplierDebt,
  calculateTopProducts,
  decorateLowStockWithShopName,
  filterActiveShifts,
  filterPendingApprovals,
  filterPendingReceipts,
  recentTransfers,
  filterSalesByRange,
  getDashboardVisibility,
  scopeSales,
  type DateRange,
} from "./dashboardMetrics";
import {
  DateRangeSelector,
  EmptyState,
  KpiCard,
  MiniMoney,
  SectionCard,
} from "./DashboardCommon";
import { canRetry, pendingText, useDashboardFinancials } from "./useServerDashboard";
import { useShiftReconciliations } from "../reports/useFinReport";
import { closeWouldExpect } from "../reports/finReports";
import { rangeLabel, useDashboardCopy } from "./dashboardCopy";
import { LowStockCard } from "./LowStockCard";
import { TransfersStatusCard } from "./TransfersStatusCard";

const COLORS = ["#047857", "#2563eb", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];

interface ManagerDashboardProps {
  currentUser: User;
  shopId: string;
  shops: Shop[];
}

const findShopName = (shops: Shop[], shopId: string | undefined, fallback: string) =>
  shops.find((shop) => shop.id === shopId)?.name ?? fallback;

const paymentPercent = (value: number, total: number) =>
  total > 0 ? Math.round((value / total) * 100) : 0;

export const ManagerDashboard = ({ currentUser, shopId, shops }: ManagerDashboardProps) => {
  const copy = useDashboardCopy();
  const [range, setRange] = useState<DateRange>("today");
  const sales = useDataStore((state) => state.sales);
  const saleItems = useDataStore((state) => state.saleItems);
  const products = useDataStore((state) => state.products);
  const inventory = useDataStore((state) => state.inventory);
  const refunds = useDataStore((state) => state.refundVoidRequests);
  const purchaseOrders = useDataStore((state) => state.purchaseOrders);
  const stockTransfers = useDataStore((state) => state.stockTransfers);
  const shifts = useDataStore((state) => state.shifts);
  const suppliers = useDataStore((state) => state.suppliers);

  const visibility = useMemo(() => getDashboardVisibility(currentUser), [currentUser]);
  const canViewShiftCash =
    visibility.canViewAllShifts || hasPermission(currentUser, "shift:manage_own");
  const shopName = findShopName(shops, shopId, copy("shop"));

  const scopedSales = useMemo(() => scopeSales(sales, shopId), [sales, shopId]);
  const rangedSales = useMemo(
    () => filterSalesByRange(scopedSales, range),
    [scopedSales, range]
  );

  // Money headline from the server report; no cached fallback.
  const fin = useDashboardFinancials(shopId, range);
  const kpis = fin.kpis;
  const finPending = pendingText(fin.state, { loading: copy("serverLoading"), unavailable: copy("serverUnavailable"), forbidden: copy("notPermitted") });
  // what the server actually reported: the shop, or (report:own_shift only) the caller's own sales
  const scopeText = fin.report?.scope.level === "OWN" ? copy("ownSalesScope") : shopName;
  const activeShifts = useMemo(() => filterActiveShifts(shifts, shopId), [shifts, shopId]);
  // Expected cash of the open shifts: the server reconciliation of each one
  // (every approved refund of their cash sales, whoever entered it).
  const activeShiftIds = useMemo(
    () => (canViewShiftCash ? activeShifts.map((shift) => shift.id) : null),
    [canViewShiftCash, activeShifts]
  );
  const recon = useShiftReconciliations(activeShiftIds);
  const expectedCash = useMemo(() => {
    if (recon.state.status !== "ok") return null;
    const results = Object.values(recon.state.data);
    if (results.some((r) => r.status !== "ok")) return null;
    return results.reduce((sum, r) => sum + (r.status === "ok" ? closeWouldExpect(r.data) ?? r.data.evidenceExpectedCashMmk : 0), 0);
  }, [recon.state]);
  const actionNeeded = useMemo(
    () => calculateActionNeeded(shopId, inventory, products, refunds, purchaseOrders, stockTransfers, shops),
    [shopId, inventory, products, refunds, purchaseOrders, stockTransfers, shops]
  );

  const visibleActionCount =
    (visibility.canViewInventory ? actionNeeded.lowStockCount + actionNeeded.outOfStockCount : 0) +
    (visibility.canViewApprovals ? actionNeeded.pendingApprovals : 0) +
    (visibility.canViewPurchases ? actionNeeded.pendingReceipts : 0) +
    (visibility.canViewTransfers ? actionNeeded.pendingTransfers + actionNeeded.inTransitCount : 0);

  const recentSales = useMemo(
    () =>
      [...rangedSales]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 6),
    [rangedSales]
  );

  const topProducts = useMemo(
    () => calculateTopProducts(rangedSales, saleItems, products, 5, refunds),
    [rangedSales, saleItems, products, refunds]
  );

  // Full low-stock list for this shop, sorted most-urgent-first. The card
  // shows a preview and a "View all" modal — do NOT pre-slice here.
  const lowStockRows = useMemo(
    () =>
      decorateLowStockWithShopName(calculateLowStock(products, inventory, shopId, shops), shops),
    [products, inventory, shopId, shops]
  );

  const pendingApprovals = useMemo(
    () => filterPendingApprovals(refunds, shopId).slice(0, 4),
    [refunds, shopId]
  );
  const pendingReceipts = useMemo(
    () => filterPendingReceipts(purchaseOrders, shopId).slice(0, 4),
    [purchaseOrders, shopId]
  );
  const recentTransferRows = useMemo(
    () => recentTransfers(stockTransfers, shopId, 100),
    [stockTransfers, shopId]
  );
  const supplierDebt = useMemo(
    () => calculateSupplierDebt(purchaseOrders, shopId),
    [purchaseOrders, shopId]
  );
  const categoryData = useMemo(
    () => calculateSalesByCategoryPercent(sales, saleItems, products, shopId, range, undefined, refunds),
    [sales, saleItems, products, shopId, range, refunds]
  );
  // Net of every approved refund, from the server report (by payment method).
  const paymentSplit = useMemo(() => {
    const methods = fin.report?.byPaymentMethod ?? [];
    const cashRevenue = methods.filter((m) => m.method === "CASH").reduce((sum, m) => sum + m.netMmk, 0);
    const otherRevenue = methods.filter((m) => m.method !== "CASH").reduce((sum, m) => sum + m.netMmk, 0);
    return { cashRevenue, otherRevenue };
  }, [fin.report]);
  const paymentTotal = paymentSplit.cashRevenue + paymentSplit.otherRevenue;
  const selectedRangeLabel = rangeLabel(copy, range);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{copy("dashboard")}</h1>
          <p className="text-sm text-slate-500">{shopName} {copy("operations")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={shopId}
            disabled
            className="min-h-11 rounded-lg border border-slate-200 bg-slate-100 px-3 text-sm font-medium text-slate-600"
          >
            <option value={shopId}>{shopName}</option>
          </select>
          <DateRangeSelector value={range} onChange={setRange} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label={`${selectedRangeLabel} ${copy("revenue")}`}
          value={kpis ? formatMmk(kpis.revenue) : finPending}
          detail={kpis ? `${scopeText} · ${copy("serverVerified")} · ${copy("bySaleDate")}` : canRetry(fin.state) ? (
            <button type="button" className="underline" onClick={fin.refresh}>{copy("tryAgain")}</button>
          ) : null}
          icon="payments"
          tone="emerald"
        />
        <KpiCard
          label={`${selectedRangeLabel} ${copy("orders")}`}
          value={kpis ? kpis.orders : finPending}
          detail={copy("validSales")}
          icon="receipt_long"
          tone="blue"
        />
        <KpiCard
          label={copy("aov")}
          value={kpis ? formatMmk(kpis.aov) : finPending}
          detail={`${selectedRangeLabel} ${copy("average")}`}
          icon="analytics"
          tone="slate"
        />
        <KpiCard
          label={copy("activeShiftCash")}
          value={canViewShiftCash ? activeShifts.length : copy("locked")}
          detail={!canViewShiftCash ? copy("shiftPermissionRequired")
            : activeShifts.length === 0 ? `${copy("expected")} ${formatMmk(0)}`
            : expectedCash !== null ? `${copy("serverExpectedCash")} ${formatMmk(expectedCash)}`
            : pendingText(recon.state, { loading: copy("serverLoading"), unavailable: copy("serverUnavailable") }) ?? copy("serverUnavailable")}
          icon="point_of_sale"
          tone="amber"
        />
        <KpiCard
          label={copy("actionNeeded")}
          value={visibleActionCount}
          detail={copy("currentOpenItems")}
          icon="priority_high"
          tone={visibleActionCount > 0 ? "rose" : "emerald"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <SectionCard title={copy("recentSales")} icon="receipt_long">
          {recentSales.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {recentSales.map((sale) => (
                <div key={sale.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-slate-800">
                        #{sale.receiptNo}
                      </span>
                      <Badge tone={sale.paymentMethod === "CASH" ? "green" : "blue"}>
                        {sale.paymentMethod === "CASH" ? copy("cash") : copy("other")}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-slate-500">
                      {formatDateTime(sale.createdAt)}
                    </p>
                  </div>
                  <MiniMoney value={sale.totalMmk} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message={copy("noSalesInRange")} icon="receipt" />
          )}
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title={copy("topSellingProducts")} action={<span className="text-[11px] text-slate-400" data-cached-note>{copy("fromLoadedSales")}</span>} icon="leaderboard">
            {topProducts.length > 0 ? (
              <div className="space-y-3">
                {topProducts.map((row, index) => (
                  <div key={row.product.id} className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-600">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-800">{row.product.name}</p>
                        <p className="text-xs text-slate-500">{row.qty} {copy("sold")}</p>
                      </div>
                    </div>
                    <MiniMoney value={row.revenue} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message={copy("noProductSalesInRange")} icon="inventory_2" />
            )}
          </SectionCard>

          {visibility.canViewSupplierDebt && (
            <SectionCard title={copy("supplierDebt")} icon="account_balance_wallet">
              {supplierDebt.debt > 0 ? (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-2xl font-bold text-rose-700">
                      {formatMmk(supplierDebt.debt)}
                    </div>
                    <p className="text-sm text-slate-500">
                      {supplierDebt.openPoCount} {copy("receivedPosUnpaidPartial")}
                    </p>
                  </div>
                  <Badge tone="red">{copy("needsPayment")}</Badge>
                </div>
              ) : (
                <EmptyState message={copy("noOutstandingSupplierDebt")} icon="task_alt" />
              )}
            </SectionCard>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {visibility.canViewApprovals && (
          <SectionCard title={copy("pendingRefundVoidApprovals")} icon="approval">
            {pendingApprovals.length > 0 ? (
              <div className="space-y-2">
                {pendingApprovals.map((request) => (
                  <div key={request.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-slate-800">
                        {request.type === "VOID" ? copy("voidRequest") : copy("partialRefund")}
                      </span>
                      <Badge tone="amber">{copy("requested")}</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">{request.reason}</p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message={copy("noPendingApprovals")} icon="task_alt" />
            )}
          </SectionCard>
        )}

        {visibility.canViewInventory && (
          <LowStockCard
            title={copy("inventoryAlerts")}
            rows={lowStockRows}
            previewLimit={5}
            showShop={false}
          />
        )}

        {visibility.canViewPurchases && (
          <SectionCard title={copy("pendingPoReceipts")} icon="local_shipping">
            {pendingReceipts.length > 0 ? (
              <div className="space-y-2">
                {pendingReceipts.map((po) => (
                  <div key={po.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-semibold text-slate-800">{po.orderNo}</span>
                      <MiniMoney value={po.totalMmk} />
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">
                      {suppliers.find((supplier) => supplier.id === po.supplierId)?.name ?? copy("supplier")}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message={copy("noApprovedPosWaitingReceipt")} icon="task_alt" />
            )}
          </SectionCard>
        )}

        {visibility.canViewTransfers && (
          <TransfersStatusCard transfers={recentTransferRows} shops={shops} />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={copy("salesByCategory")} action={<span className="text-[11px] text-slate-400" data-cached-note>{copy("fromLoadedSales")}</span>} icon="donut_small">
          <div className="h-56">
            {categoryData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={categoryData}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={72}
                    paddingAngle={4}
                    dataKey="value"
                    // `percent` is our 0–100 field (calculateSalesByCategoryPercent),
                    // not Recharts' 0–1 builtin — do not multiply by 100 again.
                    label={({ name, percent }) => `${name} ${(Number(percent) || 0).toFixed(0)}%`}
                  >
                    {categoryData.map((_, index) => (
                      <Cell key={`category-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, name, props) => [
                      `${formatMmk(Number(value))} (${Number(props.payload?.percent ?? 0).toFixed(1)}%)`,
                      name,
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState message={copy("noCategorySalesForPeriod")} icon="donut_small" />
            )}
          </div>
        </SectionCard>

        <SectionCard title={copy("cashVsOtherSales")} action={<span className="text-[11px] text-slate-400">{copy("bySaleDate")}</span>} icon="payments">
          <div className="space-y-4">
            <div>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">{copy("cash")}</span>
                <span className="text-slate-600">
                  {kpis ? formatMmk(paymentSplit.cashRevenue) : finPending}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-emerald-600"
                  style={{ width: `${paymentPercent(paymentSplit.cashRevenue, paymentTotal)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">{copy("other")}</span>
                <span className="text-slate-600">
                  {kpis ? formatMmk(paymentSplit.otherRevenue) : finPending}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-blue-600"
                  style={{ width: `${paymentPercent(paymentSplit.otherRevenue, paymentTotal)}%` }}
                />
              </div>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
};
