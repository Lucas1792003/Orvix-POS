import { useMemo } from "react";
import type { Product, Sale, SaleItem, Inventory } from "../types/domain";
import {
  calculateCostOfGoods,
  calculateGrossRevenue,
  countsAsSale,
  netRefundedLines,
  type RefundForMetrics,
} from "../features/dashboard/dashboardMetrics";

export interface BusinessInsight {
  id: string;
  type: "profit_risk" | "inventory_risk" | "growth_opportunity" | "dependency_risk";
  priority: 1 | 2 | 3; // 1 = highest
  title: string;
  titleMy: string;
  message: string;
  messageMy: string;
  action: string;
  actionMy: string;
  icon: string;
  color: "red" | "amber" | "blue" | "emerald";
}

export interface ProductProfitability {
  productId: string;
  name: string;
  revenue: number;
  /** From each line's own cost snapshot; null when any line has none (never today's cost or 0). */
  cost: number | null;
  profit: number | null;
  profitMargin: number | null;
  qtySold: number;
}

export interface CategoryAnalysis {
  category: string;
  revenue: number;
  cost: number | null;
  profit: number | null;
  revenuePercent: number;
  profitPercent: number | null;
}

export interface StockHealthItem {
  product: Product;
  currentQty: number;
  status: "healthy" | "low" | "out";
  daysUntilStockout: number | null;
  avgDailySales: number;
}

export interface FastSlowMover {
  product: Product;
  salesVelocity: number; // sales per day
  currentStock: number;
  daysOfStock: number | null;
  type: "fast" | "slow" | "normal";
}

interface UseDashboardInsightsParams {
  sales: Sale[];
  saleItems: SaleItem[];
  products: Product[];
  inventory: Inventory[];
  /**
   * Resolved metric scope:
   *   - `null`  → all shops (ADMIN All Shops mode)
   *   - `"shop-id"` → scope to one shop (ADMIN selected shop, MANAGER assigned)
   *
   * Mirrors `metricShopId` from `resolveDashboardScope` so this hook agrees
   * with the headline KPI cards. The earlier `isAdmin` short-circuit was
   * dropped because it ignored ADMIN's shop picker.
   */
  metricShopId: string | null;
  /** Refund/void requests: units given back by approved PARTIAL refunds
   *  are taken out of the per-product figures and velocity (ORV-034). */
  refunds?: RefundForMetrics[];
}

interface UseDashboardInsightsReturn {
  insights: BusinessInsight[];
  productProfitability: ProductProfitability[];
  categoryAnalysis: CategoryAnalysis[];
  stockHealth: StockHealthItem[];
  fastSlowMovers: FastSlowMover[];
  lossCauses: { cause: string; causeMy: string; amount: number; percent: number }[];
  totalProfit: number | null;
  totalRevenue: number;
  totalCost: number | null;
}

export const useDashboardInsights = ({
  sales,
  saleItems,
  products,
  inventory,
  metricShopId,
  refunds,
}: UseDashboardInsightsParams): UseDashboardInsightsReturn => {
  // Per-product figures and velocity count only the units customers kept
  // (approved PARTIAL refunds taken out). The gross totals below keep the
  // raw lines, matching their documented basis.
  const keptLines = useMemo(() => netRefundedLines(saleItems, refunds), [saleItems, refunds]);
  // Filter sales by scope: `metricShopId === null` ⇒ all shops, otherwise
  // restrict to that shop. Only VOID is excluded (mirrors `scopeSales` in
  // dashboardMetrics): a partly refunded sale is REFUNDED but still sold
  // its other units (ORV-034); its returned units are taken out via
  // `keptLines`.
  const filteredSales = useMemo(() => {
    return sales.filter(
      (s) => countsAsSale(s) && (metricShopId === null || s.shopId === metricShopId)
    );
  }, [sales, metricShopId]);

  // Calculate product profitability
  const productProfitability = useMemo(() => {
    const map: Record<string, ProductProfitability> = {};

    filteredSales.forEach((sale) => {
      const items = keptLines.filter((i) => i.saleId === sale.id);
      items.forEach((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (product) {
          if (!map[product.id]) {
            map[product.id] = {
              productId: product.id,
              name: product.name,
              revenue: 0,
              cost: 0,
              profit: 0,
              profitMargin: 0,
              qtySold: 0,
            };
          }
          // the line's own cost snapshot; none -> this product's profit is unavailable
          const itemCost = typeof item.unitCostMmkSnapshot === "number" ? item.unitCostMmkSnapshot * item.qtyUnits : null;
          const row = map[product.id];
          row.revenue += item.lineTotalMmk;
          row.cost = row.cost === null || itemCost === null ? null : row.cost + itemCost;
          row.profit = row.cost === null ? null : row.revenue - row.cost;
          row.qtySold += item.qtyUnits;
        }
      });
    });

    return Object.values(map)
      .map((p) => ({
        ...p,
        profitMargin: p.profit === null ? null : p.revenue > 0 ? (p.profit / p.revenue) * 100 : 0,
      }))
      // profit ascending (losses first); unavailable last
      .sort((a, b) => (a.profit === null ? 1 : 0) - (b.profit === null ? 1 : 0) || (a.profit ?? 0) - (b.profit ?? 0));
  }, [filteredSales, keptLines, products]);

  // Calculate category analysis
  const categoryAnalysis = useMemo(() => {
    const map: Record<string, { revenue: number; cost: number | null; profit: number | null }> = {};

    filteredSales.forEach((sale) => {
      const items = keptLines.filter((i) => i.saleId === sale.id);
      items.forEach((item) => {
        const product = products.find((p) => p.id === item.productId);
        if (product) {
          const category = product.category;
          if (!map[category]) {
            map[category] = { revenue: 0, cost: 0, profit: 0 };
          }
          const itemCost = typeof item.unitCostMmkSnapshot === "number" ? item.unitCostMmkSnapshot * item.qtyUnits : null;
          const row = map[category];
          row.revenue += item.lineTotalMmk;
          row.cost = row.cost === null || itemCost === null ? null : row.cost + itemCost;
          row.profit = row.cost === null ? null : row.revenue - row.cost;
        }
      });
    });

    const totalRevenue = Object.values(map).reduce((sum, c) => sum + c.revenue, 0);
    const known = Object.values(map).every((c) => c.profit !== null);
    const totalProfit = known ? Object.values(map).reduce((sum, c) => sum + (c.profit ?? 0), 0) : null;

    return Object.entries(map)
      .map(([category, data]) => ({
        category,
        ...data,
        revenuePercent: totalRevenue > 0 ? (data.revenue / totalRevenue) * 100 : 0,
        profitPercent: totalProfit === null || data.profit === null ? null : totalProfit > 0 ? (data.profit / totalProfit) * 100 : 0,
      }))
      .sort((a, b) => b.revenuePercent - a.revenuePercent);
  }, [filteredSales, keptLines, products]);

  // Calculate totals from the SHARED dashboard helpers so this hook
  // and the headline KPI card never disagree. Note: this is the
  // GROSS revenue (post cart discount). The DashboardPage further
  // subtracts approved PARTIAL refunds with `calculateNetRevenue`
  // for the headline number; both totals are exported so callers can
  // pick the basis that matches their card.
  const totalRevenue = useMemo(() => calculateGrossRevenue(filteredSales), [filteredSales]);
  const totalCost = useMemo(
    () => calculateCostOfGoods(filteredSales, saleItems, products),
    [filteredSales, saleItems, products]
  );
  const totalProfit = totalCost === null ? null : totalRevenue - totalCost;

  // Calculate average daily sales for each product (last 7 days)
  const productDailySales = useMemo(() => {
    const salesByProduct: Record<string, number> = {};
    const today = new Date();
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);

    filteredSales.forEach((sale) => {
      const saleDate = new Date(sale.createdAt);
      if (saleDate >= sevenDaysAgo) {
        const items = keptLines.filter((i) => i.saleId === sale.id);
        items.forEach((item) => {
          salesByProduct[item.productId] = (salesByProduct[item.productId] || 0) + item.qtyUnits;
        });
      }
    });

    // Convert to daily average
    return Object.fromEntries(
      Object.entries(salesByProduct).map(([id, qty]) => [id, qty / 7])
    );
  }, [filteredSales, keptLines]);

  // Calculate stock health.
  //
  // Single-shop mode (`metricShopId` set): one row per active product
  // showing that shop's qty.
  //
  // All-shops mode (`metricShopId === null`): we deliberately DO NOT sum
  // qty across shops — that hides "shop A is out, shop B has plenty"
  // cases. Instead we classify each product by its WORST shop:
  //   * "out"  iff any shop has 0
  //   * "low"  iff any shop has 0 < qty <= threshold (and no shop is out)
  //   * "healthy" otherwise
  // `currentQty` reports the minimum qty across the product's inventory
  // rows so the operator sees the worst-affected stock level. (Days-
  // until-stockout is left null in all-shops mode because the velocity
  // and qty come from different denominators.)
  const stockHealth = useMemo(() => {
    return products
      .filter((p) => p.isActive)
      .map((product) => {
        const productRows = inventory.filter((i) => i.productId === product.id);

        let currentQty: number;
        let status: "healthy" | "low" | "out";
        let daysUntilStockout: number | null;

        if (metricShopId === null) {
          const qtys = productRows.length > 0 ? productRows.map((r) => r.qtyBaseUnits) : [0];
          currentQty = Math.min(...qtys);
          const anyOut = qtys.some((q) => q <= 0);
          const anyLow = qtys.some((q) => q > 0 && q <= product.lowStockThreshold);
          status = anyOut ? "out" : anyLow ? "low" : "healthy";
          daysUntilStockout = null;
        } else {
          const inv = productRows.find((i) => i.shopId === metricShopId);
          currentQty = inv?.qtyBaseUnits ?? 0;
          if (currentQty <= 0) status = "out";
          else if (currentQty <= product.lowStockThreshold) status = "low";
          else status = "healthy";

          const avgDailySales = productDailySales[product.id] || 0;
          daysUntilStockout = avgDailySales > 0 ? Math.floor(currentQty / avgDailySales) : null;
        }

        const avgDailySales = productDailySales[product.id] || 0;

        return {
          product,
          currentQty,
          status,
          daysUntilStockout,
          avgDailySales,
        };
      })
      .sort((a, b) => {
        // Sort by status priority (out > low > healthy)
        const statusOrder = { out: 0, low: 1, healthy: 2 };
        return statusOrder[a.status] - statusOrder[b.status];
      });
  }, [products, inventory, metricShopId, productDailySales]);

  // Calculate fast/slow movers
  const fastSlowMovers = useMemo(() => {
    return stockHealth
      .map((item) => {
        const salesVelocity = item.avgDailySales;
        const daysOfStock = salesVelocity > 0 ? item.currentQty / salesVelocity : null;

        let type: "fast" | "slow" | "normal" = "normal";
        // Fast mover: high sales, low stock (< 7 days of stock)
        if (daysOfStock !== null && daysOfStock < 7) {
          type = "fast";
        }
        // Slow mover: low but non-zero sales, high stock (> 30 days of stock).
        // No-sales products do not get a fake "999d" stockout estimate.
        else if (
          daysOfStock !== null &&
          salesVelocity < 0.5 &&
          item.currentQty > 10 &&
          daysOfStock > 30
        ) {
          type = "slow";
        }

        return {
          product: item.product,
          salesVelocity,
          currentStock: item.currentQty,
          daysOfStock: daysOfStock === null ? null : Math.round(daysOfStock),
          type,
        };
      })
      .filter((m) => m.type !== "normal")
      .sort((a, b) => {
        if (a.type === "fast" && b.type !== "fast") return -1;
        if (a.type !== "fast" && b.type === "fast") return 1;
        return (a.daysOfStock ?? Number.MAX_SAFE_INTEGER) - (b.daysOfStock ?? Number.MAX_SAFE_INTEGER);
      });
  }, [stockHealth]);

  // Calculate loss causes (when profit < 0)
  const lossCauses = useMemo(() => {
    if (totalProfit === null || totalProfit >= 0) return [];

    const causes: { cause: string; causeMy: string; amount: number; percent: number }[] = [];
    const totalLoss = Math.abs(totalProfit);

    // Find products with negative profit
    const losingProducts = productProfitability.filter((p) => p.profit !== null && p.profit < 0);
    const productLosses = losingProducts.reduce((sum, p) => sum + Math.abs(p.profit ?? 0), 0);

    if (productLosses > 0) {
      // Group by main causes
      losingProducts.forEach((p) => {
        const lossAmount = Math.abs(p.profit ?? 0);
        causes.push({
          cause: `${p.name} (cost > revenue)`,
          causeMy: `${p.name} (ကုန်ကျစရိတ် > ဝင်ငွေ)`,
          amount: lossAmount,
          percent: (lossAmount / totalLoss) * 100,
        });
      });
    }

    // Sort by amount descending and take top 3
    return causes.sort((a, b) => b.amount - a.amount).slice(0, 3);
  }, [totalProfit, productProfitability]);

  // Generate business insights
  const insights = useMemo(() => {
    const generatedInsights: BusinessInsight[] = [];

    // 1. PROFIT RISK - Check for negative profit
    if (totalProfit !== null && totalProfit < 0) {
      const topLosers = productProfitability.filter((p) => p.profit !== null && p.profit < 0).slice(0, 2);
      const lossReasons = topLosers.map((p) => p.name).join(", ");

      generatedInsights.push({
        id: "profit-negative",
        type: "profit_risk",
        priority: 1,
        title: "Profit Loss Alert",
        titleMy: "အရှုံးသတိပေးချက်",
        message: `Profit is negative because ${lossReasons} costs exceed revenue. Total loss: ${Math.abs(totalProfit).toLocaleString()} MMK.`,
        messageMy: `${lossReasons} တို့၏ ကုန်ကျစရိတ်သည် ဝင်ငွေထက်ပိုများသောကြောင့် အရှုံးဖြစ်နေသည်။ စုစုပေါင်းအရှုံး: ${Math.abs(totalProfit).toLocaleString()} ကျပ်။`,
        action: "Review pricing or find alternative suppliers for these products.",
        actionMy: "ဤကုန်ပစ္စည်းများအတွက် စျေးနှုန်းပြန်သုံးသပ်ပါ သို့မဟုတ် အခြားပေးသွင်းသူများရှာပါ။",
        icon: "trending_down",
        color: "red",
      });
    }

    // 2. PROFIT RISK - Check for products where cost > revenue
    const unprofitableProducts = productProfitability.filter(
      (p) => p.revenue > 0 && p.cost !== null && p.cost > p.revenue
    );
    if (unprofitableProducts.length > 0 && !generatedInsights.find((i) => i.id === "profit-negative")) {
      const worst = unprofitableProducts[0];
      const lossPercent = (((worst.cost ?? 0) - worst.revenue) / worst.revenue * 100).toFixed(0);

      generatedInsights.push({
        id: "cost-exceeds-revenue",
        type: "profit_risk",
        priority: 1,
        title: "Pricing Issue Detected",
        titleMy: "စျေးနှုန်းပြဿနာတွေ့ရှိ",
        message: `${worst.name} is selling at a loss. Cost exceeds revenue by ${lossPercent}%.`,
        messageMy: `${worst.name} အရှုံးခံရောင်းနေရသည်။ ကုန်ကျစရိတ်သည် ဝင်ငွေထက် ${lossPercent}% ပိုများသည်။`,
        action: "Increase price or renegotiate supplier cost.",
        actionMy: "စျေးနှုန်းတိုးပါ သို့မဟုတ် ပေးသွင်းသူနှင့် စျေးပြန်ညှိပါ။",
        icon: "price_change",
        color: "red",
      });
    }

    // 3. INVENTORY RISK - Low stock warning
    const lowStockItems = stockHealth.filter((s) => s.status === "low" || s.status === "out");
    if (lowStockItems.length > 0) {
      const criticalItems = lowStockItems.filter((s) => s.daysUntilStockout !== null && s.daysUntilStockout <= 3);

      generatedInsights.push({
        id: "low-stock",
        type: "inventory_risk",
        priority: 2,
        title: "Stock Running Low",
        titleMy: "ကုန်ပစ္စည်းနည်းနေသည်",
        message: `${lowStockItems.length} product(s) are low on stock.${criticalItems.length > 0 ? ` ${criticalItems.length} may cause lost sales this week.` : ""}`,
        messageMy: `ကုန်ပစ္စည်း ${lowStockItems.length} မျိုး နည်းနေသည်။${criticalItems.length > 0 ? ` ${criticalItems.length} မျိုးသည် ဤအပတ်အတွင်း ရောင်းအားဆုံးရှုံးစေနိုင်သည်။` : ""}`,
        action: "Reorder soon to avoid stockouts.",
        actionMy: "ကုန်မကုန်မီ အမြန်မှာယူပါ။",
        icon: "inventory_2",
        color: "amber",
      });
    }

    // 4. DEPENDENCY RISK - Single category dominance
    // the profit share needs known cost: without it, no claim about profit is made
    const dominantCategory = categoryAnalysis.find((c) => c.revenuePercent > 50 && c.profitPercent !== null);
    if (dominantCategory && dominantCategory.profitPercent !== null) {
      const profitContribution = dominantCategory.profitPercent.toFixed(0);

      generatedInsights.push({
        id: "category-dependency",
        type: "dependency_risk",
        priority: 3,
        title: "Revenue Concentration Risk",
        titleMy: "ဝင်ငွေစုစည်းမှုအန္တရာယ်",
        message: `${dominantCategory.category} generates ${dominantCategory.revenuePercent.toFixed(0)}% of revenue but contributes only ${profitContribution}% of profit.`,
        messageMy: `${dominantCategory.category} သည် ဝင်ငွေ၏ ${dominantCategory.revenuePercent.toFixed(0)}% ထုတ်လုပ်သော်လည်း အမြတ်၏ ${profitContribution}% သာပါဝင်သည်။`,
        action: "Diversify product mix or improve margins in this category.",
        actionMy: "ကုန်ပစ္စည်းမျိုးစုံလင်အောင်လုပ်ပါ သို့မဟုတ် ဤအမျိုးအစား၏ အမြတ်နှုန်းတိုးပါ။",
        icon: "pie_chart",
        color: "blue",
      });
    }

    // 5. GROWTH OPPORTUNITY - Fast movers
    const fastMovers = fastSlowMovers.filter((m) => m.type === "fast");
    if (fastMovers.length > 0 && generatedInsights.length < 3) {
      const topFast = fastMovers[0];

      generatedInsights.push({
        id: "fast-movers",
        type: "growth_opportunity",
        priority: 3,
        title: "High Demand Products",
        titleMy: "ဝယ်လိုအားမြင့်ကုန်ပစ္စည်းများ",
        message: `${topFast.product.name} is selling fast with only ${topFast.daysOfStock} days of stock left.`,
        messageMy: `${topFast.product.name} မြန်မြန်ရောင်းနေပြီး ${topFast.daysOfStock} ရက်စာသာကျန်သည်။`,
        action: "Stock up on this product to maximize sales.",
        actionMy: "ရောင်းအားအများဆုံးရရန် ဤကုန်ပစ္စည်းပိုဝယ်ထားပါ။",
        icon: "trending_up",
        color: "emerald",
      });
    }

    // 6. OPPORTUNITY - Slow movers (if we have room)
    const slowMovers = fastSlowMovers.filter((m) => m.type === "slow");
    if (slowMovers.length > 0 && generatedInsights.length < 3) {
      generatedInsights.push({
        id: "slow-movers",
        type: "growth_opportunity",
        priority: 3,
        title: "Slow-Moving Stock",
        titleMy: "ရောင်းအားနှေးသောကုန်ပစ္စည်း",
        message: `${slowMovers.length} product(s) have high stock but low sales. Consider promotions.`,
        messageMy: `ကုန်ပစ္စည်း ${slowMovers.length} မျိုးသည် စတော့များသော်လည်း ရောင်းအားနည်းသည်။ ပရိုမိုးရှင်းစဉ်းစားပါ။`,
        action: "Run promotions or bundle with fast sellers.",
        actionMy: "ပရိုမိုးရှင်းလုပ်ပါ သို့မဟုတ် ရောင်းရသော ကုန်ပစ္စည်းများနှင့်တွဲရောင်းပါ။",
        icon: "hourglass_empty",
        color: "amber",
      });
    }

    // Sort by priority and limit to 3
    return generatedInsights.sort((a, b) => a.priority - b.priority).slice(0, 3);
  }, [totalProfit, productProfitability, stockHealth, categoryAnalysis, fastSlowMovers]);

  return {
    insights,
    productProfitability,
    categoryAnalysis,
    stockHealth,
    fastSlowMovers,
    lossCauses,
    totalProfit,
    totalRevenue,
    totalCost,
  };
};
