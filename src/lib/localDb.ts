import Dexie, { type Table } from "dexie";
import type {
  AuditLog, Brand, BusinessProfile, Category, Inventory, InventoryMovement, PriceLevel, PriceTier,
  Product, ProductBarcode, ProductUnit, ProductUnitPrice, PurchaseOrder, PurchaseOrderItem,
  Refund, Sale, SaleItem, Shift, Shop, StockTransfer, StockTransferItem,
  Supplier, SupplierPayment, SupplierProduct, UnitType, User,
} from "../types";
import type { ReconciliationRecord } from "./reconcile/types";

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
  // "archived" (1.0.16 RC2, shown as "Set aside"): an owner took the entry
  // out of the sync queue after exporting it (Sync Conflicts page). The row,
  // its payload and idempotency key stay on the till; it is never sent,
  // is included in every export, still counts as unsynced for the updater
  // guard, and an owner can restore it. There is no UI path that deletes
  // an unsynced entry (docs/desktop-app/release-1.0.16.md, RC2).
  // "reconciled" (1.0.16 RC3): the owner documented what happened to an
  // entry that will never sync from here (matched to a server sale,
  // re-entered through the normal sales flow, or confirmed cancelled), after
  // an export of it in this session, a read-only server check and a fresh
  // server-verified owner check (src/stores/data/reconcile.ts). The row,
  // payload, key and earlier status fields stay; it is never sent, stays in
  // every export, and (while its integrity checks pass) no longer blocks an
  // ordinary update install.
  status: "pending" | "syncing" | "failed" | "conflict" | "quarantined" | "archived" | "reconciled";
  attempts: number;
  /** RC3: the status the entry had when it was reconciled. */
  statusBeforeReconcile?: "conflict" | "quarantined" | "archived";
  /** RC3: the owner's reconciliation record (see lib/reconcile/types.ts). */
  reconciliation?: ReconciliationRecord;
  /** RC3: a reconciliation that failed its integrity check on load (the
   *  row was edited after it was reconciled). Kept for the audit; the row is
   *  back in "Set aside" and blocks updates again. */
  reconcileRejected?: { record: unknown; detectedAt: string; reason: string };
  /** When the drain marked the entry `syncing` (RC2): a `syncing` row older
   *  than the stale threshold, or any at startup, is a request whose
   *  response never arrived and is resent with the same key (outbox.ts). */
  syncingSince?: string;
  /** Set aside (status "archived"): when, by which app user, and the status
   *  it had before — restored as-is (a former `syncing` row comes back as
   *  `pending`). */
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
  statusBeforeArchive?: "pending" | "syncing" | "failed" | "conflict" | "quarantined";
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
  // ---- Batch 2A (queue safety). Additive only: older builds ignore them
  // and keep working on the same row (statuses are unchanged). ----
  /** Written BEFORE the first online attempt (write-ahead, plan v2 §5.1):
   *  the row exists while the online request is in flight. */
  writeAhead?: boolean;
  /** When the latest attempt was sent (client clock, ISO). */
  sentAt?: string;
  /** The server may already have applied this operation (an attempt ended
   *  in a timeout/reset/unrecognised reply). Its stock effect is still
   *  counted (conservative, D-NEW-1) and shown as "pending confirmation"
   *  until a reply establishes the outcome. Never cleared by a retry alone. */
  inDoubt?: boolean;
  /** Why the entry is waiting for something outside the queue (sign-in,
   *  suspension, an edge block, a server upgrade, an unrecognised reply). */
  heldReason?: string;
  /** Consecutive "credentials rejected" answers (reauth after the second). */
  authFailures?: number;
  // ---- G1 Stage 1 / migration 086 (recovery protocol). Additive only. ----
  /** The app user who created the operation (stamped when the row is built). */
  actorId?: string | null;
  /** Its local effects were staged under the offline rules (the operation
   *  was authorised to exist on this till without the server). */
  staged?: boolean;
  /** Outcome unknown AND never authorised offline (or never evaluated: a
   *  crash during the first online attempt). It is NEVER resent: the drain
   *  asks the server (op_status) and fences it if the server never saw it.
   *  Without migration 086 on the server it is held, not sent. */
  fenceRequired?: boolean;
  /** The server's final decision on this key (086): never resent. */
  serverOutcome?: "rejected" | "abandoned";
  /** The path of the latest attempt. */
  protocol?: "executor" | "direct" | "lookup";
  /** A conflict the server has NOT decided (it could still run if retried):
   *  it keeps its place at the head of the queue — later entries wait until
   *  a person retries or sets it aside. Never sent automatically. */
  blocksQueue?: boolean;
  /** When the server first refused it for a missing prerequisite (the 24 h
   *  "needs a person" timer starts here, not at creation). */
  dependencySince?: string;
  /** When it first waited for a record another entry creates (its ref). */
  refWaitSince?: string;
  /** Who was signed in when it was parked as "another user's" — only a
   *  sign-in by its own creator AFTER that skips the rest of the park. */
  parkedWhileSignedIn?: string | null;
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
  /** Delta keyset tie-breaker: id of the last row pulled at `lastPulledAt`
   *  (deltaSync.ts). Not indexed — no schema version change. Absent on
   *  cursors written before it existed, read as "". */
  lastPulledId?: string;
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
  // When the queue was last exported (ISO, durable): an entry queued before
  // it may have been replayed elsewhere (tools/queue-recovery), so it can no
  // longer prove it was never sent (stores/data/outbox.ts dependencyContext).
  lastQueueExport: "queue-export:last-at",
} as const;

export { RECONCILE_LOG_PREFIX } from "./reconcile/constants";

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
