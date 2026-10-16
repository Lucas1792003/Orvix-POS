import { localDb, SNAPSHOT_TABLE_NAMES, type StoredBusinessProfile } from "../../lib/localDb";
import type { DataState } from "./types";
import type { BusinessProfile } from "../../types";

const SNAPSHOT_MARKER = "__snapshot__";

// The subset of DataState fields that mirror a Dexie table 1:1 by name.
// `refundVoidRequests` is deliberately excluded — loadData sets it to the
// same array as `refunds` (see stores/data/index.ts), so it isn't stored
// twice locally; callers derive it back out on hydrate.
export type LocalSnapshot = Pick<DataState,
  | "shops" | "users" | "categories" | "brands" | "unitTypes" | "products" | "productUnits"
  | "barcodes" | "priceTiers" | "priceLevels" | "productUnitPrices" | "inventory" | "movements"
  | "suppliers" | "purchaseOrders" | "purchaseOrderItems" | "supplierPayments" | "supplierProducts"
  | "stockTransfers" | "stockTransferItems" | "shifts" | "sales" | "saleItems" | "reprintLogs"
  | "refunds" | "auditLogs" | "businessProfile"
>;

/**
 * Replace the local mirror of the server snapshot with a fresh full load.
 * Only the snapshot tables are cleared — `syncOutbox`, `provisionalIdMap`,
 * `syncMeta`, `authCache` and `syncState` are device-local state that must
 * survive every load (a queued sale lost here is a lost sale). Cursor-based
 * delta merge lives in deltaSync.ts.
 */
export async function persistSnapshotToLocal(snapshot: LocalSnapshot): Promise<void> {
  const snapshotTables = SNAPSHOT_TABLE_NAMES.map((name) => localDb.table(name));
  await localDb.transaction("rw", [...snapshotTables, localDb.syncMeta], async () => {
    await Promise.all(snapshotTables.map((table) => table.clear()));
    await Promise.all([
      localDb.shops.bulkPut(snapshot.shops),
      localDb.users.bulkPut(snapshot.users),
      localDb.categories.bulkPut(snapshot.categories),
      localDb.brands.bulkPut(snapshot.brands),
      localDb.unitTypes.bulkPut(snapshot.unitTypes),
      localDb.products.bulkPut(snapshot.products),
      localDb.productUnits.bulkPut(snapshot.productUnits),
      localDb.barcodes.bulkPut(snapshot.barcodes),
      localDb.priceTiers.bulkPut(snapshot.priceTiers),
      localDb.priceLevels.bulkPut(snapshot.priceLevels),
      localDb.productUnitPrices.bulkPut(snapshot.productUnitPrices),
      localDb.inventory.bulkPut(snapshot.inventory),
      localDb.movements.bulkPut(snapshot.movements),
      localDb.suppliers.bulkPut(snapshot.suppliers),
      localDb.purchaseOrders.bulkPut(snapshot.purchaseOrders),
      localDb.purchaseOrderItems.bulkPut(snapshot.purchaseOrderItems),
      localDb.supplierPayments.bulkPut(snapshot.supplierPayments),
      localDb.supplierProducts.bulkPut(snapshot.supplierProducts),
      localDb.stockTransfers.bulkPut(snapshot.stockTransfers),
      localDb.stockTransferItems.bulkPut(snapshot.stockTransferItems),
      localDb.shifts.bulkPut(snapshot.shifts),
      localDb.sales.bulkPut(snapshot.sales),
      localDb.saleItems.bulkPut(snapshot.saleItems),
      localDb.reprintLogs.bulkPut(snapshot.reprintLogs),
      localDb.refunds.bulkPut(snapshot.refunds),
      localDb.auditLogs.bulkPut(snapshot.auditLogs),
      snapshot.businessProfile
        ? localDb.businessProfile.put({ key: "default", ...snapshot.businessProfile })
        : Promise.resolve(),
    ]);
    await localDb.syncMeta.put({ table: SNAPSHOT_MARKER, lastPulledAt: new Date().toISOString() });
  });
}

// Snapshot tables whose rows an offline write can *create* (as opposed to
// update in place) — the ones outbox entries list under `provisional`.
const PROVISIONAL_TABLES = new Set<keyof LocalSnapshot>([
  "sales", "saleItems", "movements", "shifts", "refunds", "supplierPayments",
]);

/**
 * A full load replaces every table with the server's rows — which would
 * make a sale rung up offline vanish from the screen (and from the local
 * mirror) until its replay lands, and for good if the replay is rejected.
 * Merge back the provisional rows that still have a live outbox entry
 * (pending, retrying or conflicted); rows whose entry was dismissed are
 * dropped on the next load, as before. Never throws — on any failure the
 * snapshot is returned unchanged.
 */
export async function mergeProvisionalRows(snapshot: LocalSnapshot): Promise<LocalSnapshot> {
  try {
    const entries = await localDb.syncOutbox.toArray();
    const idsByTable = new Map<keyof LocalSnapshot, Set<string>>();
    for (const entry of entries) {
      // Quarantined entries belong to another backend (lib/backendOrigin.ts):
      // their provisional rows are not this backend's data.
      if (entry.status === "quarantined") continue;
      for (const { table, ids } of entry.provisional ?? []) {
        if (!PROVISIONAL_TABLES.has(table as keyof LocalSnapshot)) continue;
        const set = idsByTable.get(table as keyof LocalSnapshot) ?? new Set<string>();
        for (const id of ids) set.add(id);
        idsByTable.set(table as keyof LocalSnapshot, set);
      }
    }
    if (idsByTable.size === 0) return snapshot;

    const merged: LocalSnapshot = { ...snapshot };
    for (const [table, ids] of idsByTable) {
      const serverRows = snapshot[table] as unknown as { id?: string }[];
      const serverIds = new Set(serverRows.map((row) => row.id));
      const localRows = (await localDb.table(table).bulkGet([...ids])) as ({ id?: string } | undefined)[];
      const keep = localRows.filter((row): row is { id: string } => Boolean(row?.id) && !serverIds.has(row!.id));
      if (keep.length === 0) continue;
      (merged as unknown as Record<string, unknown[]>)[table] = [...keep, ...serverRows];
    }
    return merged;
  } catch (err) {
    console.error("[DB] Failed to merge provisional rows into the snapshot:", err);
    return snapshot;
  }
}

/** Read the full local mirror back out, or null if nothing was ever synced. */
export async function readLocalSnapshot(): Promise<LocalSnapshot | null> {
  const marker = await localDb.syncMeta.get(SNAPSHOT_MARKER);
  if (!marker) return null;

  const [
    shops, users, categories, brands, unitTypes, products, productUnits, barcodes, priceTiers,
    priceLevels, productUnitPrices, inventory, movements, suppliers, purchaseOrders, purchaseOrderItems,
    supplierPayments, supplierProducts, stockTransfers, stockTransferItems, shifts, sales, saleItems,
    reprintLogs, refunds, auditLogs, businessProfileRow,
  ] = await Promise.all([
    localDb.shops.toArray(), localDb.users.toArray(), localDb.categories.toArray(), localDb.brands.toArray(),
    localDb.unitTypes.toArray(), localDb.products.toArray(), localDb.productUnits.toArray(), localDb.barcodes.toArray(),
    localDb.priceTiers.toArray(), localDb.priceLevels.toArray(), localDb.productUnitPrices.toArray(),
    localDb.inventory.toArray(), localDb.movements.toArray(), localDb.suppliers.toArray(),
    localDb.purchaseOrders.toArray(), localDb.purchaseOrderItems.toArray(), localDb.supplierPayments.toArray(),
    localDb.supplierProducts.toArray(), localDb.stockTransfers.toArray(), localDb.stockTransferItems.toArray(),
    localDb.shifts.toArray(), localDb.sales.toArray(), localDb.saleItems.toArray(), localDb.reprintLogs.toArray(),
    localDb.refunds.toArray(), localDb.auditLogs.toArray(), localDb.businessProfile.get("default"),
  ]);

  return {
    shops, users, categories, brands, unitTypes, products, productUnits, barcodes, priceTiers,
    priceLevels, productUnitPrices, inventory, movements, suppliers, purchaseOrders, purchaseOrderItems,
    supplierPayments, supplierProducts, stockTransfers, stockTransferItems, shifts, sales, saleItems,
    reprintLogs, refunds, auditLogs,
    businessProfile: businessProfileRow ? stripKey(businessProfileRow) : null,
  };
}

// Strip the Dexie-only `key` wrapper — callers expect a plain BusinessProfile.
function stripKey(row: StoredBusinessProfile): BusinessProfile {
  return {
    businessName: row.businessName,
    logoUrl: row.logoUrl,
    address: row.address,
    phone: row.phone,
    email: row.email,
    tagline: row.tagline,
  };
}
