import Dexie, { type Table } from "dexie";
import type {
  AuditLog, Brand, BusinessProfile, Category, Inventory, InventoryMovement, PriceLevel, PriceTier,
  Product, ProductBarcode, ProductUnit, ProductUnitPrice, PurchaseOrder, PurchaseOrderItem,
  Refund, Sale, SaleItem, Shift, Shop, StockTransfer, StockTransferItem,
  Supplier, SupplierPayment, SupplierProduct, UnitType, User,
} from "../types";

// Singleton business_profile row wrapped with a fixed key so Dexie has a
// primary key to store it under (the DB row itself has no id column).
export interface StoredBusinessProfile extends BusinessProfile {
  key: "default";
}

export type ReprintLog = { id: string; saleId: string; printedBy: string; printedAt: string };

/** One queued local mutation, replayed against Supabase when back online. */
export interface SyncOutboxEntry {
  localId: string;
  // "rpc": replay via supabase.rpc(name, args). "table_write": replay via
  // supabase.from(table)[op](row).
  kind: "rpc" | "table_write";
  name: string; // RPC name, or a label for table_write (e.g. "products.insert")
  args?: Record<string, unknown>;
  table?: string;
  op?: "insert" | "update" | "delete";
  row?: Record<string, unknown>;
  // Primary key of the row a "table_write" entry targets — needed at replay
  // time for .eq("id", ...) on update/delete, since an update's `row` is
  // often a partial column set that may not include it.
  id?: string;
  shopId: string | null;
  createdAt: string;
  // "quarantined" (1.0.16): the entry was queued for a different backend
  // than the one this build talks to — or by a build that did not record
  // its backend at all (v1.0.15, which targeted hosted Supabase). It is
  // never sent, never retried and never deleted automatically; staff export
  // it and the owner reconciles it (lib/backendOrigin.ts).
  status: "pending" | "syncing" | "failed" | "conflict" | "quarantined";
  attempts: number;
  lastError?: string;
  // Origin (scheme://host[:port]) of the backend this entry was queued for,
  // stamped at enqueue time (1.0.16+). Absent on entries written by older
  // builds. The drain only ever sends an entry whose origin equals the
  // running build's backend origin.
  backendOrigin?: string;
  /** When / why the entry was quarantined, and the status it had before. */
  quarantinedAt?: string;
  quarantineReason?: string;
  statusBeforeQuarantine?: "pending" | "syncing" | "failed" | "conflict";
  // Client-minted UUID v4, generated when the operation was created and
  // sent as `p_idempotency_key` on every attempt (online or replay) so the
  // server can return the original response instead of applying the
  // operation twice. Also present inside `args` for "rpc" entries. See
  // docs/selfhost-migration/phase-d/idempotency-contract.md.
  idempotencyKey?: string;
  // Earliest time the next automatic attempt may run (exponential backoff
  // after a transient failure). Absent = eligible now.
  nextAttemptAt?: string;
  // How the last failure was classified — "transient" entries stay
  // pending and auto-retry, "permanent" ones are conflicts needing a
  // person. Shown on the Sync Conflicts page.
  failureKind?: "transient" | "permanent";
  // Provisional local rows (by table + id) this entry created. RPCs mint
  // their own ids server-side, so on success these get removed and replaced
  // with the server's authoritative rows rather than updated in place.
  provisional?: { table: string; ids: string[] }[];
  // Fields in `args` that reference another entity created offline (e.g.
  // complete_sale's p_shift_id, when the shift itself was also opened
  // offline and hasn't synced yet). Resolved against provisionalIdMap
  // immediately before sending — an entry with an unresolved ref is left
  // pending until the entry that created that id syncs. See outbox.ts.
  refs?: { field: string; provisionalId: string }[];
}

/** provisionalId -> the real id the server assigned once that entry synced.
 *  Lets a later-queued entry (e.g. a sale referencing a shift opened in the
 *  same offline session) resolve the reference before replaying. Pruned
 *  after a week (see outbox.ts's pruneProvisionalIdMap) — low volume, but
 *  unbounded otherwise. */
export interface ProvisionalIdMapping {
  provisionalId: string;
  realId: string;
  createdAt: string;
}

export interface SyncMetaEntry {
  table: string;
  lastPulledAt: string;
}

/** Last-known resolved app user for a Supabase auth identity, cached so
 *  restoreSession() can keep a device logged in for a bounded window
 *  (see authStore.ts) when it can't reach the network at boot — without
 *  this, reopening the app offline bounces straight to /login even with a
 *  perfectly valid cached Supabase session. */
export interface CachedAuthUser {
  authId: string;
  userId: string;
  role: string;
  shopId: string | null;
  orgId: string | null;
  isActive: boolean;
  hasTotp: boolean;
  // Permission snapshot from the `users` row (additive grants / explicit
  // denials on top of the role defaults). Only ever written from a server
  // response — never from local state.
  grantedPermissions?: string[];
  revokedPermissions?: string[];
  // Time of the last successful *authenticated* server round trip (full
  // load, delta pull, RPC reply, login/restore). The offline authorisation
  // window in authStore.ts is measured from here — see
  // docs/selfhost-migration/phase-d/offline-authorization.md.
  cachedAt: string;
}

export const SYNC_STATE_KEYS = {
  needsReauth: "needs-reauth",
  drainLease: "drain-lease",
  // Origin of the backend this profile's local data (snapshot, auth cache,
  // session) belongs to. Written by lib/backendOrigin.ts at startup.
  backendOrigin: "backend-origin",
} as const;

/** Small key/value table for sync-layer state that must survive a reload
 *  and must never be wiped by a snapshot replace: the cross-instance drain
 *  lease and the "needs sign-in" flag. See stores/data/outbox.ts. */
export interface SyncStateEntry {
  key: string;
  ownerId?: string;
  expiresAt?: string;
  flag?: boolean;
  reason?: string;
  /** Free-form value (the backend-origin marker stores the origin here). */
  value?: string;
  updatedAt: string;
}

// Mirrors DataState's arrays one-for-one so hydrate/persist can stay a
// straight loop over TABLE_NAMES instead of hand-written per-entity glue.
export class LocalDb extends Dexie {
  shops!: Table<Shop, string>;
  users!: Table<User, string>;
  categories!: Table<Category, string>;
  brands!: Table<Brand, string>;
  unitTypes!: Table<UnitType, string>;
  products!: Table<Product, string>;
  productUnits!: Table<ProductUnit, string>;
  barcodes!: Table<ProductBarcode, string>;
  priceTiers!: Table<PriceTier, string>;
  priceLevels!: Table<PriceLevel, string>;
  productUnitPrices!: Table<ProductUnitPrice, string>;
  inventory!: Table<Inventory, [string, string]>;
  movements!: Table<InventoryMovement, string>;
  suppliers!: Table<Supplier, string>;
  purchaseOrders!: Table<PurchaseOrder, string>;
  purchaseOrderItems!: Table<PurchaseOrderItem, string>;
  supplierPayments!: Table<SupplierPayment, string>;
  supplierProducts!: Table<SupplierProduct, [string, string]>;
  stockTransfers!: Table<StockTransfer, string>;
  stockTransferItems!: Table<StockTransferItem, string>;
  shifts!: Table<Shift, string>;
  sales!: Table<Sale, string>;
  saleItems!: Table<SaleItem, string>;
  reprintLogs!: Table<ReprintLog, string>;
  refunds!: Table<Refund, string>;
  auditLogs!: Table<AuditLog, string>;
  businessProfile!: Table<StoredBusinessProfile, string>;

  syncOutbox!: Table<SyncOutboxEntry, string>;
  syncMeta!: Table<SyncMetaEntry, string>;
  provisionalIdMap!: Table<ProvisionalIdMapping, string>;
  authCache!: Table<CachedAuthUser, string>;
  syncState!: Table<SyncStateEntry, string>;

  constructor() {
    super("shwe-phala-local");
    this.version(1).stores({
      shops: "id",
      users: "id",
      categories: "id",
      brands: "id, categoryId",
      unitTypes: "id",
      products: "id, category, brandId",
      productUnits: "id, productId",
      barcodes: "id, productId",
      priceTiers: "id, productId",
      priceLevels: "id",
      productUnitPrices: "id, productUnitId",
      inventory: "[shopId+productId], shopId, productId",
      movements: "id, shopId, productId, createdAt",
      suppliers: "id",
      purchaseOrders: "id, shopId, supplierId",
      purchaseOrderItems: "id, purchaseOrderId",
      supplierPayments: "id, supplierId, purchaseOrderId",
      supplierProducts: "[supplierId+productId], supplierId, productId",
      stockTransfers: "id, fromShopId, toShopId",
      stockTransferItems: "id, transferId",
      shifts: "id, shopId, cashierId",
      sales: "id, shopId, shiftId, createdAt",
      saleItems: "id, saleId",
      reprintLogs: "id, saleId",
      refunds: "id, saleId",
      auditLogs: "id, shopId, createdAt",
      businessProfile: "key",
      syncOutbox: "localId, status, shopId, createdAt",
      syncMeta: "table",
      provisionalIdMap: "provisionalId",
      authCache: "authId",
    });
    // Phase D: idempotency keys on outbox entries + the syncState table.
    // Only changed/new tables need listing; the rest carry over. Entries
    // queued before this version get a key here so their first replay is
    // already idempotent (outbox.ts also assigns one lazily, in case the
    // upgrade was interrupted).
    this.version(2)
      .stores({
        syncOutbox: "localId, status, shopId, createdAt, idempotencyKey",
        syncState: "key",
      })
      .upgrade((tx) =>
        tx.table("syncOutbox").toCollection().modify((entry: SyncOutboxEntry) => {
          if (entry.kind !== "rpc" || entry.idempotencyKey) return;
          const existing = entry.args?.p_idempotency_key;
          const key = typeof existing === "string" ? existing : crypto.randomUUID();
          entry.idempotencyKey = key;
          entry.args = { ...(entry.args ?? {}), p_idempotency_key: key };
        }),
      );
  }
}

/** Tables that hold the server snapshot and are fully replaced by a load.
 *  Everything else (outbox, id map, cursors, auth cache, sync state) is
 *  device-local state that a load must never clear. */
export const SNAPSHOT_TABLE_NAMES = [
  "shops", "users", "categories", "brands", "unitTypes", "products", "productUnits", "barcodes",
  "priceTiers", "priceLevels", "productUnitPrices", "inventory", "movements", "suppliers",
  "purchaseOrders", "purchaseOrderItems", "supplierPayments", "supplierProducts", "stockTransfers",
  "stockTransferItems", "shifts", "sales", "saleItems", "reprintLogs", "refunds", "auditLogs",
  "businessProfile",
] as const;

export const localDb = new LocalDb();
