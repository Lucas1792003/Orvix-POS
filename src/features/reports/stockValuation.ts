import type { Inventory, Product, Shop } from "../../types";

// Stock valuation for the profit report (fix 4). Retail value at today's
// price; cost value at today's cost — and only where that cost is known on
// this device. A product without one is valued as UNAVAILABLE (null), never
// at 0 (which used to make "potential profit" the whole retail value).

export interface StockValuationRow {
  productId: string;
  productName: string;
  totalQty: number;
  retailValue: number;
  /** null: no cost for that product on this device (never entered, or not permitted). */
  costValue: number | null;
}

export function stockValuationRows(
  products: Pick<Product, "id" | "name" | "priceMmk" | "costMmk">[],
  inventory: Pick<Inventory, "shopId" | "productId" | "qtyBaseUnits">[],
  shops: Pick<Shop, "id">[],
  shopId: string | null,
): StockValuationRow[] {
  const rows: StockValuationRow[] = [];
  for (const product of products) {
    let totalQty = 0;
    for (const shop of shops) {
      if (shopId && shop.id !== shopId) continue;
      const inv = inventory.find((i) => i.shopId === shop.id && i.productId === product.id);
      totalQty += inv?.qtyBaseUnits ?? 0;
    }
    if (totalQty > 0) {
      rows.push({
        productId: product.id,
        productName: product.name,
        totalQty,
        retailValue: totalQty * product.priceMmk,
        costValue: typeof product.costMmk === "number" ? totalQty * product.costMmk : null,
      });
    }
  }
  return rows.sort((a, b) => b.retailValue - a.retailValue);
}

/** Totals: the cost total is unavailable while any row's cost is. */
export function stockValuationTotals(rows: StockValuationRow[]): { retail: number; cost: number | null; costMissing: number } {
  const costMissing = rows.filter((r) => r.costValue === null).length;
  return {
    retail: rows.reduce((sum, r) => sum + r.retailValue, 0),
    cost: costMissing === 0 ? rows.reduce((sum, r) => sum + (r.costValue ?? 0), 0) : null,
    costMissing,
  };
}
