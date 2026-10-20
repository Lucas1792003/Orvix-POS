// ----------------------------------------------------------------------
// Cost privacy on the client (P-4; server side: provisional PCOST-A).
//
// Purchase cost and the COGS snapshot are visible only with
// report:shop_profit. On a server with PCOST-A they live in three
// permission-gated tables (product_costs, product_unit_costs,
// sale_item_costs) and the legacy columns read NULL; RLS returns no rows to
// anyone else. This module:
//   - reads those tables (tolerating a server that does not have them yet) and
//     lays the values onto the usual Product / ProductUnit / SaleItem fields,
//     so screens that show cost keep working for permitted users;
//   - strips every cost field for users without the permission (defence in
//     depth: an older server still returns the legacy columns to everyone);
//   - scrubs cost fields from the local mirror (IndexedDB) on logout, on an
//     account switch and on start-up for a user without the permission. Rows
//     are never deleted: offline sales, queued operations and their journal
//     are untouched (only the three cost fields are removed from snapshot rows).
// ----------------------------------------------------------------------
import { localDb } from "../../lib/localDb";
import { hasPermission } from "../../lib/permissions";
import type { Product, ProductUnit, SaleItem, User } from "../../types";
import { fetchAllRows, fetchAllRowsIn } from "./fetchAll";

export const COST_PERMISSION = "report:shop_profit" as const;

/** May this user see purchase cost / COGS? Unknown user: no. */
export const userMayViewCost = (users: readonly User[], userId: string | null | undefined): boolean => {
  if (!userId) return false;
  const me = users.find((u) => u.id === userId);
  return hasPermission(me, COST_PERMISSION);
};

// ---------------------------------------------------------------- stripping
export const stripProductCost = <T extends Partial<Pick<Product, "costMmk">>>(p: T): T => {
  if (p.costMmk === undefined) return p;
  const copy = { ...p };
  delete copy.costMmk;
  return copy;
};
export const stripUnitCost = <T extends Partial<Pick<ProductUnit, "purchasePriceMmk">>>(u: T): T => {
  if (u.purchasePriceMmk === undefined) return u;
  const copy = { ...u };
  delete copy.purchasePriceMmk;
  return copy;
};
export const stripLineCost = <T extends Partial<Pick<SaleItem, "unitCostMmkSnapshot">>>(i: T): T => {
  if (i.unitCostMmkSnapshot === undefined) return i;
  const copy = { ...i };
  delete copy.unitCostMmkSnapshot;
  return copy;
};

// ---------------------------------------------------------------- overlay
export interface CostOverlay {
  products: Map<string, number>;
  units: Map<string, number>;
  lines: Map<string, number>;
}

/** PostgREST / Postgres "no such table": a server without PCOST-A. */
const isMissingTable = (error: { code?: string; message?: string } | null | undefined): boolean =>
  !!error && (error.code === "PGRST205" || error.code === "42P01" || /could not find the table|does not exist/i.test(error.message ?? ""));

/**
 * Read the permitted cost rows. Returns null when the server has no cost
 * tables (legacy columns are then the only source). Any other failure
 * throws: the caller keeps the cost it already holds (overlayFromRows)
 * rather than showing a known cost as missing / 0. Cost is not needed to
 * sell or count stock, so callers never fail their load on it.
 */
export async function fetchCostOverlay(saleIds: readonly string[] | null): Promise<CostOverlay | null> {
  const [pc, uc, lc] = await Promise.all([
    fetchAllRows({ table: "product_costs", keys: ["product_id"], columns: "product_id,cost_mmk" }),
    fetchAllRows({ table: "product_unit_costs", keys: ["product_unit_id"], columns: "product_unit_id,purchase_price_mmk" }),
    saleIds && saleIds.length > 0
      ? fetchAllRowsIn({ table: "sale_item_costs", keys: ["sale_item_id"], columns: "sale_item_id,unit_cost_mmk", column: "sale_id", values: saleIds })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (isMissingTable(pc.error) || isMissingTable(uc.error)) return null;
  const rows = <T,>(r: { data: unknown; error: unknown }): T[] => {
    if (r.error) throw new Error(`cost rows unavailable: ${(r.error as { message?: string }).message ?? "unknown error"}`);
    return (r.data ?? []) as T[];
  };
  return {
    products: new Map(rows<{ product_id: string; cost_mmk: number }>(pc).map((r) => [r.product_id, r.cost_mmk])),
    units: new Map(rows<{ product_unit_id: string; purchase_price_mmk: number }>(uc).map((r) => [r.product_unit_id, r.purchase_price_mmk])),
    lines: new Map(rows<{ sale_item_id: string; unit_cost_mmk: number }>(lc).map((r) => [r.sale_item_id, r.unit_cost_mmk])),
  };
}

/** Product cost rows for some products only (delta pages). */
export async function fetchProductCosts(productIds: readonly string[]): Promise<Map<string, number> | null> {
  if (productIds.length === 0) return new Map();
  const r = await fetchAllRowsIn({ table: "product_costs", keys: ["product_id"], columns: "product_id,cost_mmk", column: "product_id", values: productIds });
  if (isMissingTable(r.error)) return null;
  if (r.error) throw new Error(`product cost rows unavailable: ${r.error.message}`);
  return new Map(((r.data ?? []) as { product_id: string; cost_mmk: number }[]).map((x) => [x.product_id, x.cost_mmk]));
}
export async function fetchUnitCosts(unitIds: readonly string[]): Promise<Map<string, number> | null> {
  if (unitIds.length === 0) return new Map();
  const r = await fetchAllRowsIn({ table: "product_unit_costs", keys: ["product_unit_id"], columns: "product_unit_id,purchase_price_mmk", column: "product_unit_id", values: unitIds });
  if (isMissingTable(r.error)) return null;
  if (r.error) throw new Error(`unit purchase price rows unavailable: ${r.error.message}`);
  return new Map(((r.data ?? []) as { product_unit_id: string; purchase_price_mmk: number }[]).map((x) => [x.product_unit_id, x.purchase_price_mmk]));
}

/**
 * The cost a permitted user already holds (hydrated cache / memory), as an
 * overlay: used when the cost tables cannot be read right now, so a known
 * cost is kept instead of silently becoming "missing" (shown as 0).
 */
export function overlayFromRows(
  products: readonly Pick<Product, "id" | "costMmk">[],
  units: readonly Pick<ProductUnit, "id" | "purchasePriceMmk">[],
  lines: readonly Pick<SaleItem, "id" | "unitCostMmkSnapshot">[],
): CostOverlay {
  const known = <R,>(rows: readonly R[], key: (r: R) => string | undefined, val: (r: R) => number | undefined) =>
    new Map(rows.flatMap((r) => { const k = key(r), v = val(r); return k !== undefined && v !== undefined && v !== null ? [[k, v] as [string, number]] : []; }));
  return {
    products: known(products, (p) => p.id, (p) => p.costMmk),
    units: known(units, (u) => u.id, (u) => u.purchasePriceMmk),
    lines: known(lines, (i) => i.id, (i) => i.unitCostMmkSnapshot),
  };
}

/**
 * Lay permitted cost onto mapped rows. `overlay` null (server without the
 * cost tables): the legacy column values stay. A user without the
 * permission gets every cost field removed whatever the server sent.
 */
export function applyCostOverlay<S extends { products: Product[]; productUnits: ProductUnit[]; saleItems: SaleItem[] }>(
  snapshot: S, overlay: CostOverlay | null, allowed: boolean,
): S {
  if (!allowed) {
    return {
      ...snapshot,
      products: snapshot.products.map(stripProductCost),
      productUnits: snapshot.productUnits.map(stripUnitCost),
      saleItems: snapshot.saleItems.map(stripLineCost),
    };
  }
  if (!overlay) return snapshot;
  return {
    ...snapshot,
    products: snapshot.products.map((p) => (overlay.products.has(p.id) ? { ...p, costMmk: overlay.products.get(p.id) } : p)),
    productUnits: snapshot.productUnits.map((u) => (overlay.units.has(u.id) ? { ...u, purchasePriceMmk: overlay.units.get(u.id) } : u)),
    saleItems: snapshot.saleItems.map((i) => (i.id && overlay.lines.has(i.id) ? { ...i, unitCostMmkSnapshot: overlay.lines.get(i.id) } : i)),
  };
}

// ---------------------------------------------------------------- local mirror
/**
 * Remove the cost fields from the local mirror. Only the snapshot rows'
 * three cost fields change; no row is deleted, so provisional (offline)
 * sales, the outbox, the operation journal and every other table are kept.
 */
export async function scrubLocalCostCache(): Promise<void> {
  await localDb.transaction("rw", localDb.products, localDb.productUnits, localDb.saleItems, async () => {
    await localDb.products.toCollection().modify((row: Partial<Product>) => { delete row.costMmk; });
    await localDb.productUnits.toCollection().modify((row: Partial<ProductUnit>) => { delete row.purchasePriceMmk; });
    await localDb.saleItems.toCollection().modify((row: Partial<SaleItem>) => { delete row.unitCostMmkSnapshot; });
  });
}
