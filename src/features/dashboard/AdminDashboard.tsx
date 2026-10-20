import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "../../components/ui/Badge";
import { formatDateTime, formatMmk } from "../../lib/utils";
import { useDataStore } from "../../stores/dataStore";
import type { Shop, User } from "../../types";
import {
  calculateActionNeeded,
  calculateLowStock,
  calculateSalesByCategoryPercent,
  calculateSupplierDebt,
  calculateTopProducts,
  dateRangeStart,
  decorateLowStockWithShopName,
  filterActiveShifts,
  filterPendingApprovals,
  filterPendingReceipts,
  filterSalesByRange,
  getDashboardVisibility,
  groupSupplierDebtByShop,
  groupSupplierDebtBySupplier,
  listActiveShiftRows,
  recentAuditLogs,
  recentTransfers,
  resolveDashboardScope,
  scopeSales,
  type DashboardSelectedShopId,
  type DateRange,
} from "./dashboardMetrics";
import {
  DateRangeSelector,
  EmptyState,
  KpiCard,
  MiniMoney,
  SectionCard,
} from "./DashboardCommon";
import { rangeLabel, useDashboardCopy } from "./dashboardCopy";
import { LowStockCard } from "./LowStockCard";
import { TransfersStatusFeed } from "./TransfersStatusCard";
import { useDashboardInsights } from "../../hooks/useDashboardInsights";
import { InventoryIntelligence } from "../../components/dashboard/InventoryIntelligence";
import { canRetry, kpisOf, pendingText, useDashboardFinancials, useDashboardShopFinancials } from "./useServerDashboard";

interface AdminDashboardProps {
  currentUser: User;
  shops: Shop[];
}

const shopName = (shops: Shop[], shopId: string | undefined, fallback: string) =>
  shops.find((shop) => shop.id === shopId)?.name ?? fallback;

const CATEGORY_COLORS = ["#047857", "#2563eb", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];

const withinRange = (createdAt: string, range: DateRange, now = new Date()) => {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && t >= dateRangeStart(range, now).getTime() && t <= now.getTime();
};

export const AdminDashboard = ({ currentUser, shops }: AdminDashboardProps) => {
  const copy = useDashboardCopy();
  const [selectedShopId, setSelectedShopId] = useState<DashboardSelectedShopId>("all");
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
  const users = useDataStore((state) => state.users);
  const auditLogs = useDataStore((state) => state.auditLogs);

  const visibility = useMemo(() => getDashboardVisibility(currentUser), [currentUser]);
  const scope = resolveDashboardScope(currentUser, selectedShopId, "");
  const metricShopId = scope.metricShopId;
  const activeShops = useMemo(() => shops.filter((shop) => shop.isActive), [shops]);
  const visibleShops = useMemo(
    () => (metricShopId ? activeShops.filter((shop) => shop.id === metricShopId) : activeShops),
    [activeShops, metricShopId]
  );

  const scopedSales = useMemo(() => scopeSales(sales, metricShopId), [sales, metricShopId]);
  const rangedSales = useMemo(
    () => filterSalesByRange(scopedSales, range),
    [scopedSales, range]
  );

  // Money headline: the server report (full history, every approved refund,
  // cost snapshots only). No client fallback: while it is not available the
  // tiles say so instead of showing cached totals.
  const fin = useDashboardFinancials(metricShopId, range);
  const kpis = fin.kpis;
  const finPending = pendingText(fin.state, { loading: copy("serverLoading"), unavailable: copy("serverUnavailable"), forbidden: copy("notPermitted") });
  const supplierDebt = useMemo(
    () => calculateSupplierDebt(purchaseOrders, metricShopId),
    [purchaseOrders, metricShopId]
  );

  // Per-shop money from one server report per visible shop; open shifts
  // (operational, not money) still from the store.
  const visibleShopIds = useMemo(() => visibleShops.map((shop) => shop.id), [visibleShops]);
  const shopFin = useDashboardShopFinancials(visibleShopIds, range);
  const perShopRows = useMemo(
    () =>
      visibleShops
        .map((shop) => {
          const result = shopFin.byShop[shop.id];
          const k = result?.status === "ok" ? kpisOf(result.data) : null;
          return { shop, kpis: k, activeShifts: filterActiveShifts(shifts, shop.id).length };
        })
        .sort((a, b) => (b.kpis?.revenue ?? -Infinity) - (a.kpis?.revenue ?? -Infinity)),
    [visibleShops, shopFin.byShop, shifts]
  );

  const revenueByShopData = useMemo(
    () =>
      perShopRows
        .filter((row) => row.kpis)
        .map((row) => ({
          shop: row.shop.code || row.shop.name,
          revenue: row.kpis?.revenue ?? 0,
          orders: row.kpis?.orders ?? 0,
        })),
    [perShopRows]
  );

  const trendData = visibility.canViewProfit ? fin.trend : [];

  const categoryData = useMemo(
    () => calculateSalesByCategoryPercent(sales, saleItems, products, metricShopId, range, undefined, refunds),
    [sales, saleItems, products, metricShopId, range, refunds]
  );

  // Top selling products in the current shop+range scope. Ranked by line
  // revenue; VOID sales are excluded upstream by `scopeSales` (so they
  // never enter `rangedSales`). Lines of partly refunded sales still rank
  // net of units given back by approved refunds (ORV-034). Cost/profit columns are only
  // rendered when the user holds `report:shop_profit`.
  const topProducts = useMemo(
    () => calculateTopProducts(rangedSales, saleItems, products, 5, refunds),
    [rangedSales, saleItems, products, refunds]
  );
  const topProductsRevenueTotal = useMemo(
    () => topProducts.reduce((sum, row) => sum + row.revenue, 0),
    [topProducts]
  );

  // Stock health + fast/slow movers + reorder suggestions for the
  // Inventory Intelligence card. Gated on `canViewInventory` so the
  // hook is only consulted when the card renders. Sales velocity is a
  // fixed last-7-days window — the dashboard `range` selector does not
  // change it (mid-week vs week-ago "fast mover" stays comparable).
  const { stockHealth, fastSlowMovers } = useDashboardInsights({
    sales,
    saleItems,
    products,
    inventory,
    metricShopId,
    refunds,
  });

  // Full low-stock list (active shops only), sorted most-urgent-first. The
  // card shows a preview and a "View all" modal — do NOT pre-slice here.
  const lowStockRows = useMemo(
    () =>
      decorateLowStockWithShopName(
        calculateLowStock(products, inventory, metricShopId, shops),
        shops
      ),
    [products, inventory, metricShopId, shops]
  );

  const pendingApprovals = useMemo(
    () => filterPendingApprovals(refunds, metricShopId).slice(0, 6),
    [refunds, metricShopId]
  );
  const pendingReceipts = useMemo(
    () => filterPendingReceipts(purchaseOrders, metricShopId).slice(0, 6),
    [purchaseOrders, metricShopId]
  );
  const actionNeeded = useMemo(
    () => calculateActionNeeded(metricShopId, inventory, products, refunds, purchaseOrders, stockTransfers, shops),
    [metricShopId, inventory, products, refunds, purchaseOrders, stockTransfers, shops]
  );
  const activeShiftRows = useMemo(
    () => listActiveShiftRows(shifts, users, shops, metricShopId),
    [shifts, users, shops, metricShopId]
  );
  const debtGroups = useMemo(
    () =>
      metricShopId
        ? groupSupplierDebtBySupplier(purchaseOrders, suppliers, metricShopId).slice(0, 6)
        : groupSupplierDebtByShop(purchaseOrders, shops).slice(0, 6),
    [metricShopId, purchaseOrders, suppliers, shops]
  );
  const recentSales = useMemo(
    () =>
      [...rangedSales]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 6),
    [rangedSales]
  );
  const recentTransferRows = useMemo(
    () => recentTransfers(stockTransfers, metricShopId, 100),
    [stockTransfers, metricShopId]
  );
  const auditRows = useMemo(
    () =>
      recentAuditLogs(
        auditLogs.filter(
          (log) => (metricShopId === null || log.shopId === metricShopId) && withinRange(log.createdAt, range)
        ),
        6
      ),
    [auditLogs, metricShopId, range]
  );

  const selectedRangeLabel = rangeLabel(copy, range);
  const scopeLabel = scope.showAllShops
    ? copy("allShopsScope")
    : shopName(shops, metricShopId ?? undefined, copy("unknownShop"));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{copy("dashboard")}</h1>
          <p className="text-sm text-slate-500">
            {scopeLabel} {copy("businessControlFor")} {new Date().toLocaleDateString("en-US")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedShopId}
            onChange={(event) => setSelectedShopId(event.target.value as DashboardSelectedShopId)}
            className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          >
            <option value="all">{copy("allShops")}</option>
            {activeShops.map((shop) => (
              <option key={shop.id} value={shop.id}>
                {shop.name}
              </option>
            ))}
          </select>
          <DateRangeSelector value={range} onChange={setRange} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label={`${selectedRangeLabel} ${copy("revenue")}`}
          value={kpis ? formatMmk(kpis.revenue) : finPending}
          detail={kpis ? `${scopeLabel} · ${copy("serverVerified")} · ${copy("bySaleDate")}` : canRetry(fin.state) ? (
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
        {visibility.canViewProfit && (
          <KpiCard
            label={copy("profitMargin")}
            value={kpis ? (kpis.profit !== null ? formatMmk(kpis.profit) : copy("profitNotAvailable")) : finPending}
            detail={kpis
              ? kpis.costIncomplete ? copy("costIncomplete")
                : kpis.marginPct !== null ? `${kpis.marginPct.toFixed(1)}% ${copy("margin")}` : copy("profitNotAvailable")
              : null}
            icon={(kpis?.profit ?? 0) >= 0 ? "trending_up" : "trending_down"}
            tone={(kpis?.profit ?? 0) >= 0 ? "violet" : "rose"}
          />
        )}
        {visibility.canViewSupplierDebt && (
          <KpiCard
            label={copy("supplierDebt")}
            value={formatMmk(supplierDebt.debt)}
            detail={`${supplierDebt.openPoCount} ${copy("receivedPosUnpaidPartial")}`}
            icon="account_balance_wallet"
            tone={supplierDebt.debt > 0 ? "amber" : "emerald"}
          />
        )}
      </div>

      {visibility.canViewProfit && (
        <SectionCard
          title={copy("revenueCostProfitTrend")}
          icon="show_chart"
          action={
            <div className="flex items-center gap-3 text-[11px] font-medium text-slate-600">
              {[
                { label: copy("revenue"), color: "#10b981" },
                { label: copy("costInvestment"), color: "#8b5cf6" },
                { label: copy("profit"), color: "#3b82f6" },
              ].map((series) => (
                <span key={series.label} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: series.color }}
                  />
                  {series.label}
                </span>
              ))}
            </div>
          }
        >
          {trendData.length === 1 ? (
            // Single-day fallback. AreaChart needs 2+ points to draw a
            // filled shape; with one point all you'd see is three isolated
            // dots. Render a polished 3-tile snapshot instead so the card
            // looks intentional. Same data, same colors as the multi-day
            // area chart. Helper text below still nudges toward a wider
            // range for a real trend.
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  { label: copy("revenue"), value: trendData[0].revenue, color: "#10b981", bg: "bg-emerald-50", text: "text-emerald-700" },
                  { label: copy("costInvestment"), value: trendData[0].cost, color: "#8b5cf6", bg: "bg-violet-50", text: "text-violet-700" },
                  { label: copy("profit"), value: trendData[0].profit, color: "#3b82f6", bg: "bg-blue-50", text: "text-blue-700" },
                ].map((tile) => (
                  <div key={tile.label} className={`rounded-xl ${tile.bg} p-4`}>
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: tile.color }}
                      />
                      <span className={`text-xs font-medium ${tile.text}`}>{tile.label}</span>
                    </div>
                    <div className={`mt-2 text-xl font-bold tabular-nums ${tile.text}`}>
                      {tile.value === null ? "—" : formatMmk(tile.value)}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">{trendData[0].label}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-center text-xs text-slate-400">
                {copy("trendNeedsMoreDays")}
              </p>
            </>
          ) : trendData.length > 1 ? (
            <>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  {/*
                   * Restored old AreaChart style: three overlapping areas
                   * with gradient fills (30% opacity top → 0% bottom) and a
                   * 2px stroke. Colors match the original dashboard palette
                   * (emerald / violet / blue). Formula and scope come from
                   * `calculateDailyRevenueCostProfitTrend` — unchanged.
                   */}
                  <AreaChart data={trendData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="trendRevenueFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="trendCostFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="trendProfitFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: "#64748b" }}
                      tickLine={false}
                      axisLine={{ stroke: "#e2e8f0" }}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#64748b" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value) => `MMK ${Math.round(Number(value) / 1000)}k`}
                      width={70}
                    />
                    <Tooltip
                      cursor={{ stroke: "#cbd5e1", strokeWidth: 1 }}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid #e2e8f0",
                        boxShadow: "0 6px 18px rgba(15,23,42,0.08)",
                        fontSize: 12,
                      }}
                      labelStyle={{ color: "#475569", fontWeight: 600, marginBottom: 4 }}
                      formatter={(value, name) => [formatMmk(Number(value)), name]}
                    />
                    {[
                      { key: "revenue", color: "#10b981", name: copy("revenue"), fill: "url(#trendRevenueFill)" },
                      { key: "cost", color: "#8b5cf6", name: copy("costInvestment"), fill: "url(#trendCostFill)" },
                      { key: "profit", color: "#3b82f6", name: copy("profit"), fill: "url(#trendProfitFill)" },
                    ].map((series) => (
                      <Area
                        key={series.key}
                        type="monotone"
                        dataKey={series.key}
                        name={series.name}
                        stroke={series.color}
                        strokeWidth={2}
                        fill={series.fill}
                        // On short ranges show dots so a single-day plot
                        // doesn't read as broken; on longer ranges the
                        // shaded area itself is the trend.
                        dot={trendData.length <= 5 ? { r: 3, strokeWidth: 0, fill: series.color } : false}
                        activeDot={{ r: 5, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : (
            <EmptyState message={copy("noSalesDataForPeriod")} icon="show_chart" />
          )}
        </SectionCard>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] xl:items-stretch">
        <SectionCard title={copy("shopPerformance")} icon="storefront">
          {perShopRows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px]">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-semibold text-slate-500">
                    <th className="pb-2 pr-3">{copy("shop")}</th>
                    <th className="pb-2 pr-3 text-right">{copy("revenue")}</th>
                    <th className="pb-2 pr-3 text-right">{copy("orders")}</th>
                    <th className="pb-2 pr-3 text-right">{copy("aov")}</th>
                    {visibility.canViewProfit && <th className="pb-2 pr-3 text-right">{copy("profit")}</th>}
                    {visibility.canViewProfit && <th className="pb-2 pr-3 text-right">{copy("margin")}</th>}
                    <th className="pb-2 text-right">{copy("openShifts")}</th>
                  </tr>
                </thead>
                <tbody>
                  {perShopRows.map((row) => (
                    <tr key={row.shop.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 pr-3">
                        <div className="font-semibold text-slate-800">{row.shop.name}</div>
                        <div className="text-xs text-slate-500">{row.shop.code}</div>
                      </td>
                      <td className="py-2.5 pr-3 text-right text-sm font-semibold text-emerald-700">
                        {row.kpis ? formatMmk(row.kpis.revenue) : copy("serverUnavailable")}
                      </td>
                      <td className="py-2.5 pr-3 text-right text-sm text-slate-600">{row.kpis ? row.kpis.orders : "—"}</td>
                      <td className="py-2.5 pr-3 text-right text-sm text-slate-600">
                        {row.kpis ? formatMmk(row.kpis.aov) : "—"}
                      </td>
                      {visibility.canViewProfit && (
                        <td className="py-2.5 pr-3 text-right text-sm font-semibold text-slate-800">
                          {row.kpis && row.kpis.profit !== null ? formatMmk(row.kpis.profit) : "—"}
                          {row.kpis?.costIncomplete && <div className="text-[11px] font-normal text-amber-700">{copy("costIncomplete")}</div>}
                        </td>
                      )}
                      {visibility.canViewProfit && (
                        <td className="py-2.5 pr-3 text-right text-sm text-slate-600">
                          {row.kpis && row.kpis.marginPct !== null ? `${row.kpis.marginPct.toFixed(1)}%` : "—"}
                        </td>
                      )}
                      <td className="py-2.5 text-right text-sm text-slate-600">{row.activeShifts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState message={copy("noShopSalesInRange")} icon="storefront" />
          )}
        </SectionCard>

        <div className="space-y-4 xl:h-full">
          <SectionCard title={copy("salesByCategory")} action={<span className="text-[11px] text-slate-400" data-cached-note>{copy("fromLoadedSales")}</span>} icon="donut_small" className="xl:h-full">
            <div className="h-56">
              {categoryData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={categoryData}
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={82}
                      paddingAngle={4}
                      dataKey="value"
                      nameKey="name"
                      // `percent` here comes from our row (already 0–100 from
                      // calculateSalesByCategoryPercent), NOT Recharts' 0–1
                      // builtin — Recharts merges payload into label-render
                      // props and our field shadows the builtin. Do not
                      // multiply by 100 again or we get values like 7625%.
                      label={({ name, percent }) => `${name} ${(Number(percent) || 0).toFixed(0)}%`}
                    >
                      {categoryData.map((_, index) => (
                        <Cell key={`admin-category-${index}`} fill={CATEGORY_COLORS[index % CATEGORY_COLORS.length]} />
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
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3 xl:items-start xl:gap-6">
        <div className={visibility.canViewInventory ? "space-y-4 xl:col-span-1" : "space-y-4 xl:col-span-3"}>
          <SectionCard title={copy("topSellingProducts")} action={<span className="text-[11px] text-slate-400" data-cached-note>{copy("fromLoadedSales")}</span>} icon="leaderboard">
            {topProducts.length > 0 ? (
              <div className="space-y-2.5">
                {topProducts.map((row, index) => {
                  const sharePct =
                    topProductsRevenueTotal > 0
                      ? (row.revenue / topProductsRevenueTotal) * 100
                      : 0;
                  return (
                    <div
                      key={row.product.id}
                      className="flex items-center justify-between gap-3"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-600">
                          {index + 1}
                        </span>
                        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                          {row.product.imageUrl ? (
                            <img
                              src={row.product.imageUrl}
                              alt={row.product.name}
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-slate-400">
                              <span className="material-symbols-rounded text-base">
                                inventory_2
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-800">
                            {row.product.name}
                          </p>
                          <p className="truncate text-[11px] text-slate-500">
                            {row.qty} {copy("sold")}
                            {row.product.sku ? ` · ${row.product.sku}` : ""}
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <MiniMoney value={row.revenue} />
                        <div className="text-[10px] text-slate-400 tabular-nums">
                          {sharePct.toFixed(0)}%
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState message={copy("noProductSalesInRange")} icon="inventory_2" />
            )}
          </SectionCard>

          <SectionCard title={copy("revenueByShop")} icon="bar_chart">
            <div className="h-72">
              {revenueByShopData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={revenueByShopData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="shop" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
                    <Tooltip
                      formatter={(value) => formatMmk(Number(value))}
                      labelFormatter={(label) => `${copy("shop")} ${label}`}
                    />
                    <Bar dataKey="revenue" fill="#047857" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState message={copy("noRevenueToChart")} icon="bar_chart" />
              )}
            </div>
          </SectionCard>
        </div>

        {/* Restored Inventory Intelligence — stock health summary, fast/slow
            movers, and reorder suggestions. Gated on `canViewInventory`. The
            3-stat summary at the top overlaps with the Action Queue counts
            below; kept because the card stands on its own and the operator
            may scan only this section when planning a reorder. */}
        {visibility.canViewInventory && (
          <div className="xl:col-span-2 xl:self-stretch">
            <InventoryIntelligence
              stockHealth={stockHealth}
              fastSlowMovers={fastSlowMovers}
              className="h-full"
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {visibility.canViewInventory && (
          <LowStockCard
            title={scope.showAllShops ? copy("lowStockAcrossShops") : copy("lowStock")}
            rows={lowStockRows}
            previewLimit={8}
            showShop
          />
        )}

        {visibility.canViewApprovals && (
          <SectionCard title={copy("pendingApprovals")} icon="approval">
            {pendingApprovals.length > 0 ? (
              <div className="space-y-2">
                {pendingApprovals.map((request) => (
                  <div key={request.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-slate-800">
                        {request.type === "VOID" ? copy("voidRequest") : copy("partialRefund")}
                      </span>
                      <Badge tone="amber">{shopName(shops, request.shopId, copy("unknownShop"))}</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">{request.reason}</p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message={copy("noPendingRefundVoidApprovals")} icon="task_alt" />
            )}
          </SectionCard>
        )}

        <SectionCard title={copy("activeStaffOpenShifts")} icon="groups">
          {activeShiftRows.length > 0 ? (
            <div className="space-y-2">
              {activeShiftRows.slice(0, 6).map((row) => (
                <div key={row.shift.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-semibold text-slate-800">
                      {row.user?.name ?? copy("unknownUser")}
                    </span>
                    <Badge tone="green">{copy("open")}</Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {row.shop?.name ?? row.shift.shopId} - {copy("since")} {formatDateTime(row.shift.startedAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message={copy("noOpenShifts")} icon="groups" />
          )}
        </SectionCard>

        <SectionCard title={copy("actionQueue")} icon="priority_high">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-rose-50 p-3">
              <div className="text-xl font-bold text-rose-700">{actionNeeded.outOfStockCount}</div>
              <div className="text-xs text-rose-700">{copy("outOfStock")}</div>
            </div>
            <div className="rounded-lg bg-amber-50 p-3">
              <div className="text-xl font-bold text-amber-700">{actionNeeded.lowStockCount}</div>
              <div className="text-xs text-amber-700">{copy("lowStock")}</div>
            </div>
            <div className="rounded-lg bg-blue-50 p-3">
              <div className="text-xl font-bold text-blue-700">{pendingReceipts.length}</div>
              <div className="text-xs text-blue-700">{copy("poReceipts")}</div>
            </div>
            <div className="rounded-lg bg-slate-100 p-3">
              <div className="text-xl font-bold text-slate-800">{actionNeeded.pendingTransfers}</div>
              <div className="text-xs text-slate-600">{copy("transfers")}</div>
            </div>
            <div className="rounded-lg bg-violet-50 p-3">
              <div className="text-xl font-bold text-violet-700">{actionNeeded.inTransitCount}</div>
              <div className="text-xs text-violet-700">{copy("toReceive")}</div>
            </div>
          </div>

          {visibility.canViewTransfers && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                <span className="material-symbols-rounded text-sm text-emerald-700">local_shipping</span>
                {copy("transfersBetweenShops")}
              </div>
              <TransfersStatusFeed transfers={recentTransferRows} shops={shops} previewLimit={5} />
            </div>
          )}
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {visibility.canViewSupplierDebt && (
          <SectionCard title={metricShopId ? copy("supplierDebtBySupplier") : copy("supplierDebtByShop")} icon="account_balance_wallet">
            {debtGroups.length > 0 ? (
              <div className="space-y-2">
                {debtGroups.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-800">{row.name}</p>
                      <p className="text-xs text-slate-500">{row.openPoCount} {copy("openPoCount")}</p>
                    </div>
                    <MiniMoney value={row.debt} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message={copy("noOutstandingSupplierDebt")} icon="task_alt" />
            )}
          </SectionCard>
        )}

        {visibility.canViewAudit && (
          <SectionCard title={copy("recentAuditActivity")} icon="manage_search">
            {auditRows.length > 0 ? (
              <div className="space-y-2">
                {auditRows.map((log) => (
                  <div key={log.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-semibold text-slate-800">{log.actionType}</span>
                      {log.shopId && <Badge tone="slate">{shopName(shops, log.shopId, copy("unknownShop"))}</Badge>}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">{log.message}</p>
                    <p className="mt-1 text-xs text-slate-400">{formatDateTime(log.createdAt)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message={copy("noAuditActivity")} icon="manage_search" />
            )}
          </SectionCard>
        )}

        <SectionCard title={copy("recentSales")} icon="receipt_long" className="xl:col-span-1">
          {recentSales.length > 0 ? (
            <div className="space-y-2">
              {recentSales.map((sale) => (
                <div key={sale.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-800">#{sale.receiptNo}</p>
                    <p className="truncate text-xs text-slate-500">
                      {shopName(shops, sale.shopId, copy("unknownShop"))} - {formatDateTime(sale.createdAt)}
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
      </div>
    </div>
  );
};
