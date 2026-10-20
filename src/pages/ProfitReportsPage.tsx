import { useMemo, useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Tabs } from "../components/ui/Tabs";
import { Select } from "../components/ui/Select";
import { DateRangePicker } from "../components/forms/DateRangePicker";
import { Button } from "../components/ui/Button";
import { downloadCsv } from "../lib/csv";
import { getEffectiveShopId } from "../lib/utils";
import { businessToday, isWithinBusinessDays, monthStartKey } from "../lib/businessDay";
import { MAX_ORG_RANGE_DAYS, MAX_SHOP_RANGE_DAYS, profitOf, type FinReportSummary, type FinResult } from "../features/reports/finReports";
import { useFinReportsByShop } from "../features/reports/useFinReport";
import { BasisBadge, FinStatusNotice, FinWarnings } from "../features/reports/FinReportStatus";

const rangeDays = (start: string, end: string): number =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;

interface ServerProfitRow {
  shopId: string;
  shopName: string;
  result: FinResult<FinReportSummary>;
}

// Default report window: start of the current business month → today
// (YYYY-MM-DD business days, Asia/Yangon — ORV-069).
const currentMonthRange = () => {
  const today = businessToday();
  return { start: monthStartKey(today), end: today };
};

export const ProfitReportsPage = () => {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((u) => u.id === currentUserId));
  const { currentShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const products = useDataStore((state) => state.products);
  const inventory = useDataStore((state) => state.inventory);
  const transfers = useDataStore((state) => state.stockTransfers);
  const transferItems = useDataStore((state) => state.stockTransferItems);
  const purchaseOrders = useDataStore((state) => state.purchaseOrders);
  const purchaseOrderItems = useDataStore((state) => state.purchaseOrderItems);

  const [activeTab, setActiveTab] = useState("profit");
  const [range, setRange] = useState(currentMonthRange);
  const [shopFilter, setShopFilter] = useState("all");

  const _shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  void _shopId; // Used for context, but effectiveShopId is user-controllable
  const isAdmin = currentUser?.role === "ADMIN";
  const effectiveShopId = shopFilter === "all" ? null : shopFilter;

  // Profit by shop: one server report per shop (fin_report_summary, sale-date
  // basis = sales performance). Revenue net of every approved refund, COGS from
  // the sales' own cost snapshots; profit is null (shown as unavailable) when
  // cost is hidden from the caller or incomplete — never estimated client-side.
  const days = rangeDays(range.start, range.end);
  // P-7: an all-shops view (and its organisation-wide totals) is limited to 93
  // days even though it is assembled from per-shop reports; one shop: 367.
  const rangeLimit = isAdmin && !effectiveShopId ? MAX_ORG_RANGE_DAYS : MAX_SHOP_RANGE_DAYS;
  const rangeError = !range.start || !range.end || !(days >= 1) ? "Choose a start and an end day."
    : days > rangeLimit ? `A profit report covers at most ${rangeLimit} days${rangeLimit === MAX_ORG_RANGE_DAYS ? " for all shops; choose one shop for longer ranges" : ""}.` : null;
  const ownShopId = currentUser?.shopId ?? null;
  const reportShopIds = useMemo(
    () => (rangeError ? null : isAdmin
      ? shops.filter((shop) => !effectiveShopId || shop.id === effectiveShopId).map((shop) => shop.id)
      : ownShopId ? [ownShopId] : []),
    [rangeError, isAdmin, shops, effectiveShopId, ownShopId],
  );
  const byShop = useFinReportsByShop(reportShopIds, range.start, range.end, "SALE_DATE");
  const profitByShop: ServerProfitRow[] = useMemo(() => {
    if (byShop.state.status !== "ok") return [];
    const results = byShop.state.data;
    return (reportShopIds ?? []).map((id) => ({
      shopId: id,
      shopName: shops.find((shop) => shop.id === id)?.name ?? id,
      result: results[id],
    }));
  }, [byShop.state, reportShopIds, shops]);

  // Calculate stock valuation
  const stockValuation = useMemo(() => {
    const result: { productId: string; productName: string; totalQty: number; retailValue: number; costValue: number }[] = [];

    products.forEach((product) => {
      let totalQty = 0;
      shops.forEach((shop) => {
        if (effectiveShopId && shop.id !== effectiveShopId) return;
        const inv = inventory.find((i) => i.shopId === shop.id && i.productId === product.id);
        totalQty += inv?.qtyBaseUnits ?? 0;
      });

      if (totalQty > 0) {
        result.push({
          productId: product.id,
          productName: product.name,
          totalQty,
          retailValue: totalQty * product.priceMmk,
          costValue: totalQty * (product.costMmk ?? 0),
        });
      }
    });

    return result.sort((a, b) => b.retailValue - a.retailValue);
  }, [products, inventory, shops, effectiveShopId]);

  // Calculate transfer summary (borrowed vs lent)
  const transferSummary = useMemo(() => {
    const completedTransfers = transfers.filter((t) => {
      if (t.status !== "COMPLETED") return false;
      if (t.completedAt && !isWithinBusinessDays(t.completedAt, range.start, range.end)) return false;
      return true;
    });

    const summary: { shopId: string; shopName: string; lent: number; borrowed: number; net: number }[] = [];

    shops.forEach((shop) => {
      let lent = 0;
      let borrowed = 0;

      completedTransfers.forEach((transfer) => {
        const items = transferItems.filter((i) => i.transferId === transfer.id);
        const totalQty = items.reduce((sum, i) => sum + (i.transferredQty ?? i.requestedQty), 0);

        if (transfer.fromShopId === shop.id) {
          lent += totalQty;
        }
        if (transfer.toShopId === shop.id) {
          borrowed += totalQty;
        }
      });

      summary.push({
        shopId: shop.id,
        shopName: shop.name,
        lent,
        borrowed,
        net: borrowed - lent,
      });
    });

    return summary;
  }, [shops, transfers, transferItems, range]);

  // Calculate purchase summary
  const purchaseSummary = useMemo(() => {
    const receivedPOs = purchaseOrders.filter((po) => {
      if (po.status !== "RECEIVED") return false;
      if (effectiveShopId && po.shopId !== effectiveShopId) return false;
      if (po.receivedAt && !isWithinBusinessDays(po.receivedAt, range.start, range.end)) return false;
      return true;
    });

    const totalPurchases = receivedPOs.reduce((sum, po) => sum + po.totalMmk, 0);
    const totalItems = receivedPOs.reduce((sum, po) => {
      const items = purchaseOrderItems.filter((i) => i.purchaseOrderId === po.id);
      return sum + items.reduce((itemSum, i) => itemSum + (i.receivedQty ?? i.orderedQty), 0);
    }, 0);

    return {
      orderCount: receivedPOs.length,
      totalPurchases,
      totalItems,
    };
  }, [purchaseOrders, purchaseOrderItems, range, effectiveShopId]);

  // Totals over the shops whose server report answered. A total is only a number
  // when EVERY shop answered and (for cost/profit) every shop's cost is complete.
  const totals = useMemo(() => {
    const ok = profitByShop.flatMap((row) => (row.result?.status === "ok" ? [row.result.data] : []));
    const allAnswered = profitByShop.length > 0 && ok.length === profitByShop.length;
    const totalRevenue = allAnswered ? ok.reduce((sum, r) => sum + r.totals.netRevenueMmk, 0) : null;
    const costKnown = allAnswered && ok.every((r) => r.totals.cogsMmk !== null && r.totals.cogsComplete === true);
    const totalCost = costKnown ? ok.reduce((sum, r) => sum + (r.totals.cogsMmk ?? 0), 0) : null;
    const totalProfit = costKnown && totalRevenue !== null && totalCost !== null ? totalRevenue - totalCost : null;
    const avgMargin = totalProfit !== null && totalRevenue ? (totalProfit / totalRevenue) * 100 : null;
    const unanswered = profitByShop.length - ok.length;

    const totalRetailValue = stockValuation.reduce((sum, s) => sum + s.retailValue, 0);
    const totalCostValue = stockValuation.reduce((sum, s) => sum + s.costValue, 0);

    return { totalRevenue, totalCost, totalProfit, avgMargin, unanswered, totalRetailValue, totalCostValue };
  }, [profitByShop, stockValuation]);

  const exportProfitReport = () => {
    downloadCsv("profit_report.csv", profitByShop.map((s) => {
      const r = s.result?.status === "ok" ? s.result.data : null;
      const p = r ? profitOf(r.totals) : null;
      return {
        shop: s.shopName,
        basis: "sale date (Asia/Yangon)",
        revenue: r ? r.totals.netRevenueMmk : "unavailable",
        cost: r && r.totals.cogsMmk !== null ? r.totals.cogsMmk : "unavailable",
        cost_complete: r ? String(r.totals.cogsComplete) : "unavailable",
        profit: p && p.profit !== null ? p.profit : "unavailable",
        margin: p && p.marginPct !== null ? `${p.marginPct.toFixed(1)}%` : "unavailable",
      };
    }));
  };
  const money = (v: number | null) => (v === null ? "—" : `MMK ${v.toLocaleString()}`);

  const exportStockValuation = () => {
    downloadCsv("stock_valuation.csv", stockValuation.map((s) => ({
      product: s.productName,
      quantity: s.totalQty,
      retail_value: s.retailValue,
      cost_value: s.costValue,
    })));
  };

  return (
    <Card>
      <PageHeader
        title="Profit & Analytics"
        subtitle="Track profitability, stock valuation, and transfer history"
      />

      <div className="mt-6">
        <Tabs
          tabs={[
            { id: "profit", label: "Profit by Shop" },
            { id: "valuation", label: "Stock Valuation" },
            { id: "transfers", label: "Transfer Summary" },
            { id: "purchases", label: "Purchase Summary" },
          ]}
          active={activeTab}
          onChange={setActiveTab}
        />
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
        {isAdmin && (
          <Select value={shopFilter} onChange={(e) => setShopFilter(e.target.value)} className="min-w-48 flex-1 md:w-auto md:flex-none">
            <option value="all">All Shops</option>
            {shops.map((shop) => (
              <option key={shop.id} value={shop.id}>{shop.name}</option>
            ))}
          </Select>
        )}
      </div>

      {/* Profit by Shop */}
      {activeTab === "profit" && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <BasisBadge basis="SALE_DATE" />
            <span>Server-verified: every approved refund deducted; cost from each sale's own cost snapshot.</span>
          </div>
          {rangeError && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{rangeError}</div>}
          <FinStatusNotice state={byShop.state} onRetry={byShop.refresh} />
          {byShop.state.status === "ok" && totals.unanswered > 0 && (
            <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {totals.unanswered} shop report(s) could not be loaded, so totals are not shown.
              <button type="button" onClick={byShop.refresh} className="ml-2 font-semibold underline">Try again</button>
            </div>
          )}
          {/* Summary Cards */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="bg-slate-50 rounded-lg p-4">
              <div className="text-sm text-slate-500">Net Revenue</div>
              <div className="text-xl font-bold text-slate-900" data-total="revenue">{money(totals.totalRevenue)}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-4">
              <div className="text-sm text-slate-500">Total Cost</div>
              <div className="text-xl font-bold text-slate-900" data-total="cost">{money(totals.totalCost)}</div>
            </div>
            <div className="bg-green-50 rounded-lg p-4">
              <div className="text-sm text-green-600">Total Profit</div>
              <div className="text-xl font-bold text-green-700" data-total="profit">{money(totals.totalProfit)}</div>
            </div>
            <div className="bg-blue-50 rounded-lg p-4">
              <div className="text-sm text-blue-600">Avg Margin</div>
              <div className="text-xl font-bold text-blue-700" data-total="margin">{totals.avgMargin === null ? "—" : `${totals.avgMargin.toFixed(1)}%`}</div>
            </div>
          </div>
          {byShop.state.status === "ok" && totals.totalRevenue !== null && totals.totalCost === null && (
            <p className="text-xs text-slate-500">
              This view shows cost and profit only when every shop's cost is complete and your account holds report:shop_profit.
            </p>
          )}

          <div className="flex justify-end">
            <Button variant="secondary" onClick={exportProfitReport} disabled={byShop.state.status !== "ok"}>Export CSV</Button>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-3 font-medium">Shop</th>
                  <th className="pb-3 font-medium text-right">Net revenue</th>
                  <th className="pb-3 font-medium text-right">Cost</th>
                  <th className="pb-3 font-medium text-right">Profit</th>
                  <th className="pb-3 font-medium text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {profitByShop.map((row) => {
                  const r = row.result?.status === "ok" ? row.result.data : null;
                  const p = r ? profitOf(r.totals) : null;
                  return (
                    <tr key={row.shopId} className="border-b last:border-0 align-top" data-shop={row.shopId}>
                      <td className="py-3 font-medium">
                        {row.shopName}
                        {!r && row.result && <div className="mt-1"><FinStatusNotice state={row.result} compact /></div>}
                        {r && <div className="mt-1"><FinWarnings report={r} /></div>}
                      </td>
                      <td className="py-3 text-right">{r ? money(r.totals.netRevenueMmk) : "—"}</td>
                      <td className="py-3 text-right">
                        {r ? money(r.totals.cogsMmk) : "—"}
                        {r && r.totals.cogsComplete === false && <div className="text-[11px] text-amber-700">incomplete</div>}
                      </td>
                      <td className={`py-3 text-right font-medium ${p?.profit !== null && p?.profit !== undefined && p.profit < 0 ? "text-red-600" : "text-green-600"}`}>
                        {p ? money(p.profit) : "—"}
                      </td>
                      <td className="py-3 text-right">{p && p.marginPct !== null ? `${p.marginPct.toFixed(1)}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stock Valuation */}
      {activeTab === "valuation" && (
        <div className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="bg-slate-50 rounded-lg p-4">
              <div className="text-sm text-slate-500">Total Retail Value</div>
              <div className="text-xl font-bold text-slate-900">MMK {totals.totalRetailValue.toLocaleString()}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-4">
              <div className="text-sm text-slate-500">Total Cost Value</div>
              <div className="text-xl font-bold text-slate-900">MMK {totals.totalCostValue.toLocaleString()}</div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button variant="secondary" onClick={exportStockValuation}>Export CSV</Button>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-3 font-medium">Product</th>
                  <th className="pb-3 font-medium text-right">Total Qty</th>
                  <th className="pb-3 font-medium text-right">Retail Value</th>
                  <th className="pb-3 font-medium text-right">Cost Value</th>
                  <th className="pb-3 font-medium text-right">Potential Profit</th>
                </tr>
              </thead>
              <tbody>
                {stockValuation.slice(0, 20).map((row) => (
                  <tr key={row.productId} className="border-b last:border-0">
                    <td className="py-3">{row.productName}</td>
                    <td className="py-3 text-right">{row.totalQty}</td>
                    <td className="py-3 text-right">MMK {row.retailValue.toLocaleString()}</td>
                    <td className="py-3 text-right">MMK {row.costValue.toLocaleString()}</td>
                    <td className="py-3 text-right text-green-600">
                      MMK {(row.retailValue - row.costValue).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stockValuation.length > 20 && (
              <p className="text-sm text-slate-500 mt-2">Showing top 20 products by value. Export CSV for full list.</p>
            )}
          </div>
        </div>
      )}

      {/* Transfer Summary */}
      {activeTab === "transfers" && (
        <div className="mt-5 space-y-4">
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h4 className="font-medium text-blue-800 mb-2">Transfer Balance Explanation</h4>
            <ul className="text-sm text-blue-700 space-y-1">
              <li>- <strong>Lent:</strong> Items this shop sent to other shops</li>
              <li>- <strong>Borrowed:</strong> Items this shop received from other shops</li>
              <li>- <strong>Net:</strong> Borrowed - Lent (positive = net receiver, negative = net lender)</li>
            </ul>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-3 font-medium">Shop</th>
                  <th className="pb-3 font-medium text-right">Items Lent</th>
                  <th className="pb-3 font-medium text-right">Items Borrowed</th>
                  <th className="pb-3 font-medium text-right">Net Balance</th>
                </tr>
              </thead>
              <tbody>
                {transferSummary.map((row) => (
                  <tr key={row.shopId} className="border-b last:border-0">
                    <td className="py-3 font-medium">{row.shopName}</td>
                    <td className="py-3 text-right text-red-600">-{row.lent}</td>
                    <td className="py-3 text-right text-green-600">+{row.borrowed}</td>
                    <td className={`py-3 text-right font-medium ${row.net >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {row.net >= 0 ? "+" : ""}{row.net}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Purchase Summary */}
      {activeTab === "purchases" && (
        <div className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="bg-slate-50 rounded-lg p-4">
              <div className="text-sm text-slate-500">Purchase Orders</div>
              <div className="text-xl font-bold text-slate-900">{purchaseSummary.orderCount}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-4">
              <div className="text-sm text-slate-500">Total Items Received</div>
              <div className="text-xl font-bold text-slate-900">{purchaseSummary.totalItems.toLocaleString()}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-4">
              <div className="text-sm text-slate-500">Total Purchases</div>
              <div className="text-xl font-bold text-slate-900">MMK {purchaseSummary.totalPurchases.toLocaleString()}</div>
            </div>
          </div>

          <p className="text-sm text-slate-500">
            These figures represent received purchase orders within the selected date range.
            View detailed purchase history in the Purchase Orders section.
          </p>
        </div>
      )}
    </Card>
  );
};
