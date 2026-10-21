import { create } from "zustand";
import type { DataState } from "./types";
import { supabase } from "../../lib/supabase";
import { reportError } from "../../lib/errors";
import { useAppStore } from "../appStore";
import { mergeProvisionalRows, persistSnapshotToLocal, readLocalSnapshot, type LocalSnapshot } from "./localSync";
import { classifyLegacyQueue, countPendingOutbox, drainOutbox, registerOutboxReconciler, setNeedsReauth } from "./outbox";
import { registerVerifiedReload } from "./verifiedReload";
import { backfillJournal } from "./opJournal";
import { allOnlineOperations } from "./onlineOnly";
import { bootstrapDeltaCursors, pullDeltaChanges } from "./deltaSync";
import { refreshInventoryIfNotLive } from "./inventoryRealtime";
import { fetchAllRows, fetchAllRowsIn, fetchServerTime, type ReadResult, type Row } from "./fetchAll";
import { serializeLedger } from "./stockLedger";
import { applyRecordedWrites, beginWriteRecording, endWriteRecording } from "./localWrites";
import { refreshAuthCacheSnapshot, touchAuthCache } from "../authCache";
import { useAuthStore } from "../authStore";
import { applyCostOverlay, fetchCostOverlay, overlayFromRows, userMayViewCost } from "./costPrivacy";
import { prepareCachedSnapshot } from "./sensitiveCache";
import {
  mapAuditLog, mapBarcode, mapBrand, mapBusinessProfile, mapCategory, mapInventory, mapMovement,
  mapPriceLevel, mapPriceTier, mapProduct, mapProductUnit, mapProductUnitPrice, mapPurchaseOrder,
  mapPurchaseOrderItem, mapRefund, mapReprintLog, mapSale, mapSaleItem, mapShift, mapShop,
  mapStockTransfer, mapStockTransferItem, mapSupplier, mapSupplierPayment, mapSupplierProduct,
  mapUnitType, mapUser,
} from "./mappers";

// Import all slices
import { createShopSlice } from "./slices/shopSlice";
import { createCategorySlice } from "./slices/categorySlice";
import { createBrandSlice } from "./slices/brandSlice";
import { createUnitTypeSlice } from "./slices/unitTypeSlice";
import { createPriceLevelSlice } from "./slices/priceLevelSlice";
import { createProductSlice } from "./slices/productSlice";
import { createInventorySlice } from "./slices/inventorySlice";
import { createShiftSlice } from "./slices/shiftSlice";
import { createSaleSlice } from "./slices/saleSlice";
import { createTransferSlice } from "./slices/transferSlice";
import { createPurchaseSlice } from "./slices/purchaseSlice";
import { createPricingSlice } from "./slices/pricingSlice";
import { createAuditSlice } from "./slices/auditSlice";

// ============================================================
// Store
// ============================================================

export const useDataStore = create<DataState>()((...args) => {
  const [set, get] = args;
  return {
    ...createShopSlice(...args),
    ...createCategorySlice(...args),
    ...createBrandSlice(...args),
    ...createUnitTypeSlice(...args),
    ...createPriceLevelSlice(...args),
    ...createProductSlice(...args),
    ...createInventorySlice(...args),
    ...createShiftSlice(...args),
    ...createSaleSlice(...args),
    ...createTransferSlice(...args),
    ...createPurchaseSlice(...args),
    ...createPricingSlice(...args),
    ...createAuditSlice(...args),

    isLoading: false,
    isLoaded: false,
    loadError: null,

    retryLoadData: async () => {
      await get().loadData({ force: true });
    },

    pullDeltas: async () => {
      if (!get().isLoaded) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      try {
        const pullUserId = useAuthStore.getState().currentUserId;
        const { changes, hadErrors } = await pullDeltaChanges(get());
        if (useAuthStore.getState().currentUserId !== pullUserId) return;   // overtaken by a sign-out / switch
        if (Object.keys(changes).length > 0) set(changes);
        // `inventory` is outside delta-sync (no updated_at); while its
        // Realtime channel is not delivering, this periodic pull is what
        // bounds how stale stock can get — see inventoryRealtime.ts.
        await refreshInventoryIfNotLive();
        // A clean pull is an authenticated round trip — it moves the
        // offline authorisation window forward (see authCache.ts) and is
        // the routine moment to replay anything still queued: a sale
        // queued because a single request timed out while navigator.onLine
        // stayed true would otherwise wait for a restart.
        if (!hadErrors) {
          void touchAuthCache();
          if ((await countPendingOutbox()) > 0) {
            drainOutbox().catch((err) => console.error("[DB] Failed to drain the sync outbox:", err));
          }
        }
      } catch (err) {
        console.error("[DB] pullDeltas failed:", err);
      }
    },

    loadData: async (options) => {
      // The isLoading flag is only raised after the cache fast path below
      // has awaited IndexedDB, so two callers in the same tick (React's
      // StrictMode double effect in dev, a mount effect racing a reconnect)
      // both got through and raced each other's snapshot. Share one load.
      if (loadInFlight) return loadInFlight;
      if (get().isLoading) return;
      if (get().isLoaded && !options?.force) return;
      loadInFlight = runLoad().finally(() => {
        loadInFlight = null;
        // A load overtaken by a sign-out / account switch was discarded: the
        // person now signed in gets their own (their screen waits on isLoaded).
        if (staleLoadDiscarded) {
          staleLoadDiscarded = false;
          if (useAuthStore.getState().currentUserId) void get().loadData({ force: true });
        }
      });
      return loadInFlight;
    },
  };

  async function runLoad(): Promise<void> {
    // Whose load this is: everything below (the mirror, the server pages) is
    // for this person only. A sign-out or another sign-in meanwhile discards it.
    const loadUserId = useAuthStore.getState().currentUserId;
    // Fast path: render immediately from the local mirror (works offline
    // and on a cold, slow connection). The network fetch below still runs
    // in the background to refresh it — isLoading stays true throughout so
    // callers can show a non-blocking "syncing" indicator.
    if (!get().isLoaded) {
      try {
        const rawCached = await readLocalSnapshot();
        // P-4 / fix 3: the mirror may hold another session's data (another
        // user, an older build, an older server): cost, purchase-order and
        // supplier-payment money, audit messages. Only what this person may
        // see reaches memory; the rest is scrubbed from the mirror (fields
        // only — no row, queued operation or journal entry is deleted).
        const cached = rawCached ? await prepareCachedSnapshot(rawCached, loadUserId) : null;
        if (cached && useAuthStore.getState().currentUserId !== loadUserId) {
          staleLoadDiscarded = true;
          return;
        }
        if (cached) {
          set({ ...cached, refundVoidRequests: cached.refunds, isLoaded: true });
          // The mirrored rows already carry what is queued (D-NEW-1 ledger).
          await get().adoptStockLedger();
        }
      } catch (err) {
        console.error("[DB] Failed to hydrate from local cache:", err);
      }
    }

    // Batch 2A queues: classify them while the local evidence of an offline
    // staging (the shift / transfer row carrying the operation's key) still
    // exists — the full load below replaces those rows with the server's
    // (M4). Local only; idempotent; the drain repeats it.
    await classifyLegacyQueue().catch((err) => console.error("[DB] Failed to classify the sync queue:", err));
    // W8 Phase 0: every queued / unresolved operation already on this till
    // gets its journal record (operations acknowledged before this build
    // cannot be recovered — nothing is invented). Idempotent.
    await backfillJournal(allOnlineOperations).catch((err) => console.error("[DB] Failed to backfill the operation journal:", err));

    // No point firing 27 requests that will just fail — leave whatever we
    // rendered from cache (or the "Loading data…" / Retry screen if this is
    // a first run with no cache yet) in place until connectivity returns.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      if (!get().isLoaded) set({ loadError: "You're offline and no cached data is available yet." });
      return;
    }

    set({ isLoading: true, loadError: null });
    // Anything written while the reads below are in flight (a shift
    // opened, a sale completed) is newer than the snapshot they return —
    // re-applied below so the load cannot roll it back (see localWrites.ts).
    const recorder = beginWriteRecording();
    // Realtime inventory events that arrive while the pages are read: the
    // pages may predate them, so they are re-applied on top (H2 / G-5).
    const liveEvents = get().captureInventoryEvents();
    // Acknowledgements and stagings from here on are accounted for when the
    // stock rows are composed (stockLedger.ts).
    const stockMarker = get().beginStockRead();
    try {
      // A session the server has revoked (refresh token invalid) is dropped
      // by supabase-js the moment it tries to refresh; the reads below
      // would then go out anonymously and come back as EMPTY tables under
      // RLS — which must never be rendered or persisted over the real
      // cached data. Checked before and after the reads (Phase E finding:
      // the till bounced to /login and lost its offline mirror).
      if (await sessionGone()) {
        endWriteRecording(recorder);
        liveEvents.finish();
        set({ isLoading: false });
        await setNeedsReauth("The server rejected this device's sign-in. Sign in again to resume syncing.");
        return;
      }
      // Server clock BEFORE the first read: the delta cursors start just
      // before it (bootstrapDeltaCursors), so a row changed while the pages
      // below are being read is pulled again by the next delta pull rather
      // than skipped. Null (older server / failure) keeps the old seeding.
      const serverTimeBeforeLoad = await fetchServerTime();

      // Every table that is meant to be complete is read with keyset paging
      // (fetchAll.ts): past PostgREST's 1,000-row cap, all-or-nothing. The
      // three recent-history windows (movements, sales, audit) are bounded
      // on purpose; they get a unique tie-breaker so the window is
      // deterministic. sale_items is scoped to the sales actually loaded.
      // Complete reads come back in key order; tables the UI showed in
      // their old physical (≈ creation) order are re-sorted oldest first
      // (then id), so lists keep their order and become deterministic (M2).
      const all = (table: string) => fetchAllRows({ table, keys: ["id"] });
      const byCreation = (table: string, column = "created_at") => all(table).then(sortedBy(column));
      // One promise, awaited twice: a supabase-js builder re-sends its
      // request every time it is awaited.
      const salesRead = Promise.resolve(supabase.from("sales").select("*")
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1000));
      const saleItemsRead = salesRead.then((res): Promise<ReadResult> => {
        if (res.error) return Promise.resolve({ data: null, error: { message: res.error.message, code: res.error.code } });
        const ids = ((res.data ?? []) as { id: string }[]).map((s) => s.id);
        return fetchAllRowsIn({ table: "sale_items", keys: ["id"], column: "sale_id", values: ids });
      });
      const [
        shops, users, categories, brands, unitTypes, products, productUnits, barcodes, priceTiers,
        priceLevels, productUnitPrices,
        inventory, movements, suppliers, purchaseOrders, purchaseOrderItems, supplierPayments,
        supplierProducts,
        stockTransfers, stockTransferItems, shifts, sales, saleItems,
        reprintLogs, refunds, auditLogs, businessProfileRes,
      ] = await Promise.all([
        byCreation("shops"),
        byCreation("users"),
        byCreation("categories"),
        all("brands").then(sortedBy("sort_order")),
        all("unit_types").then(sortedBy("sort_order")),
        byCreation("products"),
        all("product_units").then(sortedBy("sort_order")),
        all("product_barcodes"),
        byCreation("price_tiers"),
        all("price_levels").then(sortedBy("sort_order")),
        byCreation("product_unit_prices"),
        fetchAllRows({ table: "inventory", keys: ["shop_id", "product_id"] }),
        supabase.from("inventory_movements").select("*")
          .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(500),
        byCreation("suppliers"),
        byCreation("purchase_orders"),
        all("purchase_order_items"),
        all("supplier_payments").then(sortedBy("paid_at", "desc")),
        fetchAllRows({ table: "supplier_products", keys: ["supplier_id", "product_id"] }).then(sortedBy("created_at")),
        byCreation("stock_transfers"),
        all("stock_transfer_items"),
        byCreation("shifts", "started_at"),
        salesRead,
        saleItemsRead,
        byCreation("reprint_logs", "printed_at"),
        byCreation("refund_void_requests"),
        supabase.from("audit_logs").select("*")
          .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(500),
        supabase.from("business_profile").select("*").eq("id", "default").maybeSingle(),
      ]);

      // Surface RLS / network failures from any of the parallel reads.
      // The arrays default to [] otherwise — that would render an empty
      // shop with no error indication, hiding the real cause.
      const failedRead = [
        shops, users, categories, brands, unitTypes, products, productUnits, barcodes, priceTiers,
        priceLevels, productUnitPrices,
        inventory, movements,
        suppliers, purchaseOrders, purchaseOrderItems, supplierPayments,
        supplierProducts,
        stockTransfers, stockTransferItems, shifts, sales, saleItems,
        reprintLogs, refunds, auditLogs, businessProfileRes,
      ].find((result) => result.error);
      if (failedRead?.error) throw failedRead.error;
      if (await sessionGone()) {
        endWriteRecording(recorder);
        liveEvents.finish();
        set({ isLoading: false });
        await setNeedsReauth("The server rejected this device's sign-in. Sign in again to resume syncing.");
        return;
      }

      // Clear `currentShopId` only if it points to a shop that no longer
      // exists (e.g., it was deleted between sessions). We deliberately
      // DO NOT auto-pick `shops[0]` when nothing is selected — shop-scoped
      // UIs (POS, shift, inventory adjust, purchases, transfers) show a
      // clear "no shop selected" blocked state for ADMIN instead. See
      // `getEffectiveShopId` for the contract.
      const shopsList: ReturnType<typeof mapShop>[] = (shops.data ?? []).map(mapShop);
      // Queued offline stock deltas, read AFTER the server rows (see below).

      const { currentShopId, setShopId } = useAppStore.getState();
      if (currentShopId && !shopsList.find((s) => s.id === currentShopId)) {
        setShopId(null);
      }

      const loadedUsers = (users.data ?? []).map(mapUser);
      const costUserId = useAuthStore.getState().currentUserId;
      const costAllowed = userMayViewCost(loadedUsers, costUserId);
      // The awaits below can outlive the session: if the permitted user
      // logged out (or another signed in) meanwhile, strip cost again before
      // it reaches memory or the mirror, which logout has already scrubbed.
      const withCostForCurrentUser = <S extends LocalSnapshot>(snap: S): S =>
        costAllowed && useAuthStore.getState().currentUserId !== costUserId ? applyCostOverlay(snap, null, false) : snap;
      // P-4: permitted cost from the gated tables (none for anyone else);
      // never fails the load (cost is not needed to sell or count stock).
      const costOverlay = costAllowed
        ? await fetchCostOverlay(((sales.data ?? []) as { id: string }[]).map((s) => s.id)).catch((err) => {
            // keep the cost already held rather than showing it as missing
            console.warn("[cost] keeping cached cost:", err instanceof Error ? err.message : err);
            const s = get();
            return overlayFromRows(s.products, s.productUnits, s.saleItems);
          })
        : null;
      const serverSnapshot: LocalSnapshot = applyCostOverlay({
        shops: shopsList,
        users: loadedUsers,
        categories: (categories.data ?? []).map(mapCategory),
        brands: (brands.data ?? []).map(mapBrand),
        unitTypes: (unitTypes.data ?? []).map(mapUnitType),
        products: (products.data ?? []).map(mapProduct),
        productUnits: (productUnits.data ?? []).map(mapProductUnit),
        barcodes: (barcodes.data ?? []).map(mapBarcode),
        priceTiers: (priceTiers.data ?? []).map(mapPriceTier),
        priceLevels: (priceLevels.data ?? []).map(mapPriceLevel),
        productUnitPrices: (productUnitPrices.data ?? []).map(mapProductUnitPrice),
        // Composed below (queue effects, acknowledgements during the read,
        // live events).
        inventory: (inventory.data ?? []).map(mapInventory),
        movements: (movements.data ?? []).map(mapMovement),
        suppliers: (suppliers.data ?? []).map(mapSupplier),
        purchaseOrders: (purchaseOrders.data ?? []).map(mapPurchaseOrder),
        purchaseOrderItems: (purchaseOrderItems.data ?? []).map(mapPurchaseOrderItem),
        supplierPayments: (supplierPayments.data ?? []).map(mapSupplierPayment),
        supplierProducts: (supplierProducts.data ?? []).map(mapSupplierProduct),
        stockTransfers: (stockTransfers.data ?? []).map(mapStockTransfer),
        stockTransferItems: (stockTransferItems.data ?? []).map(mapStockTransferItem),
        shifts: (shifts.data ?? []).map(mapShift),
        sales: (sales.data ?? []).map(mapSale),
        saleItems: (saleItems.data ?? []).map(mapSaleItem),
        reprintLogs: (reprintLogs.data ?? []).map(mapReprintLog),
        refunds: (refunds.data ?? []).map(mapRefund),
        auditLogs: (auditLogs.data ?? []).map(mapAuditLog),
        businessProfile: businessProfileRes.data ? mapBusinessProfile(businessProfileRes.data) : null,
      }, costOverlay, costAllowed);
      // Keep offline-created rows that are still queued for replay visible
      // (and mirrored) across the reload — see mergeProvisionalRows — and
      // re-apply writes that completed while the reads were in flight.
      const recorded = applyRecordedWrites(await mergeProvisionalRows(serverSnapshot), endWriteRecording(recorder));
      // Live stock changes committed after the load began win over the
      // pages, with the queued offline deltas applied to them as well.
      // Stock: the server rows + the effects of what is still queued (read
      // AFTER the server rows), adjusted for acknowledgements made during
      // the read; live events newer than the load win. Fail closed: if the
      // queue cannot be read the stock shown is kept as it is.
      const composed = await get().composeServerStock(
        recorded.inventory, stockMarker, liveEvents.finish(),
        serverTimeBeforeLoad ? Date.parse(serverTimeBeforeLoad) : Number.NEGATIVE_INFINITY,
      );
      // Overtaken by a sign-out or another sign-in while the pages were read:
      // those rows belong to the previous session — never shown, never mirrored.
      if (useAuthStore.getState().currentUserId !== loadUserId || costUserId !== loadUserId) {
        staleLoadDiscarded = true;
        set({ isLoading: false });
        return;
      }
      const snapshot = withCostForCurrentUser({ ...recorded, inventory: composed ? composed.rows : get().inventory });
      if (composed) get().noteStockLedger(composed.applied, new Map(Object.entries(composed.pendingConfirmation)));
      const ledgerForSnapshot = serializeLedger();
      set({ ...snapshot, refundVoidRequests: snapshot.refunds, isLoading: false, isLoaded: true });
      // Verified only when the stock rows were composed from the server too.
      if (composed) completedServerLoads += 1;
      if (composed?.followUp) void get().refreshInventoryFromServer({ shopId: null }).catch(() => undefined);

      // A full load is an authenticated round trip and carries the
      // current `users` row: refresh the offline auth snapshot from it.
      const { currentUserId } = useAuthStore.getState();
      const me = currentUserId ? snapshot.users.find((u) => u.id === currentUserId) : undefined;
      if (me) {
        void refreshAuthCacheSnapshot({
          role: me.role, shopId: me.shopId ?? null, orgId: me.orgId ?? null, isActive: me.isActive,
          grantedPermissions: me.grantedPermissions, revokedPermissions: me.revokedPermissions,
        });
      } else {
        void touchAuthCache();
      }

      // Persist BEFORE draining: the drain reconciles server rows into the
      // local mirror, and a persist still in flight would otherwise race
      // it (and used to clear every table, outbox included).
      // A sign-out between showing the rows and mirroring them: logout has
      // already scrubbed the mirror; this session's rows are not written back.
      if (useAuthStore.getState().currentUserId !== loadUserId) {
        staleLoadDiscarded = true;
        return;
      }
      try {
        const who = useAuthStore.getState();
        const meNow = who.currentUserId ? snapshot.users.find((u) => u.id === who.currentUserId) : undefined;
        await persistSnapshotToLocal(withCostForCurrentUser(snapshot), ledgerForSnapshot, {
          userId: who.currentUserId ?? null, role: who.currentRole ?? null, orgId: who.currentOrgId ?? null, shopId: meNow?.shopId ?? null,
          permissions: JSON.stringify([[...(meNow?.grantedPermissions ?? [])].sort(), [...(meNow?.revokedPermissions ?? [])].sort()]),
        });
      } catch (err) {
        console.error("[DB] Failed to persist local cache:", err);
      }
      // A full load always has the freshest data for every table, so it's
      // always safe to (re)set the delta-pull cursors from it — the next
      // background refresh (see AppLayout.tsx) can then pull just what
      // changed since, instead of another full 27-table reload.
      bootstrapDeltaCursors(snapshot, serverTimeBeforeLoad).catch((err) => {
        console.error("[DB] Failed to bootstrap delta-sync cursors:", err);
      });
      // We just proved the network is reachable — replay anything queued
      // while offline (previous outages, or writes made before this boot).
      drainOutbox().catch((err) => {
        console.error("[DB] Failed to drain the sync outbox:", err);
      });
    } catch (err) {
      endWriteRecording(recorder);
      liveEvents.finish();
      const message = reportError("loadData", err, "Failed to load data. Please try again.");
      set({ isLoading: false, loadError: message });
    }
  }
});

let loadInFlight: Promise<void> | null = null;
let staleLoadDiscarded = false;
/** Full loads that replaced the state with server data (verified reload). */
let completedServerLoads = 0;

/** Re-order a complete read client-side (the keyset read is in key order).
 *  Like Postgres: NULLs last ascending, first descending; ties by id (or the
 *  composite key). Timestamps compare as instants, numbers as numbers. */
export function sortedBy(column: string, direction: "asc" | "desc" = "asc") {
  return (res: ReadResult): ReadResult => {
    if (res.error) return res;
    const sign = direction === "asc" ? 1 : -1;
    const tie = (row: Row): string => String(row.id ?? `${row.supplier_id ?? ""}|${row.product_id ?? ""}`);
    const compare = (x: unknown, y: unknown): number => {
      if (typeof x === "number" && typeof y === "number") return x - y;
      const sx = String(x);
      const sy = String(y);
      const dx = Date.parse(sx);
      const dy = Date.parse(sy);
      if (/^\d{4}-\d{2}-\d{2}/.test(sx) && /^\d{4}-\d{2}-\d{2}/.test(sy) && !Number.isNaN(dx) && !Number.isNaN(dy)) return dx - dy;
      return sx < sy ? -1 : sx > sy ? 1 : 0;
    };
    const data = [...res.data].sort((a, b) => {
      const x = a[column];
      const y = b[column];
      const xNull = x === null || x === undefined;
      const yNull = y === null || y === undefined;
      if (xNull !== yNull) return (xNull ? 1 : -1) * sign; // NULLS LAST asc / FIRST desc
      if (!xNull) {
        const c = compare(x, y);
        if (c !== 0) return c * sign;
      }
      const tx = tie(a);
      const ty = tie(b);
      return tx < ty ? -1 : tx > ty ? 1 : 0;
    });
    return { data, error: null };
  };
}

// True when supabase-js holds no session any more (a refused refresh clears
// it). A network failure while refreshing keeps the session and returns
// false here — that path is handled by the read errors / offline branch.
async function sessionGone(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    return !data.session;
  } catch {
    return false;
  }
}

// G1 Stage 1 (086): a committed operation whose reply this till cannot read
// is reconciled from the server's own rows — by a full load that certainly
// STARTED after the caller learnt the outcome (one already in flight may
// predate it, so it is awaited and a fresh one run). True only when that
// load replaced the state with server data.
registerVerifiedReload(async () => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  await useDataStore.getState().loadData({ force: true });
  const before = completedServerLoads;
  await useDataStore.getState().loadData({ force: true });
  return completedServerLoads > before;
});

registerOutboxReconciler("complete_sale", (data, provisional, ackId) =>
  useDataStore.getState().reconcileCompleteSale(data, provisional ?? [], ackId));
registerOutboxReconciler("adjust_stock", (data, provisional, ackId) =>
  useDataStore.getState().reconcileAdjustStock(data, provisional ?? [], ackId));
registerOutboxReconciler("open_shift", (data, provisional) =>
  useDataStore.getState().reconcileOpenShift(data, provisional ?? []));
registerOutboxReconciler("close_shift", (data, provisional) =>
  useDataStore.getState().reconcileCloseShift(data, provisional ?? []));
registerOutboxReconciler("create_refund_void_request", (data, provisional) =>
  useDataStore.getState().reconcileCreateRefundVoidRequest(data, provisional ?? []));
registerOutboxReconciler("receive_purchase_order", (data, provisional, ackId) =>
  useDataStore.getState().reconcileReceivePurchaseOrder(data, provisional ?? [], ackId));
registerOutboxReconciler("record_supplier_payment", (data, provisional) =>
  useDataStore.getState().reconcileRecordSupplierPayment(data, provisional ?? []));
registerOutboxReconciler("dispatch_stock_transfer", (data, provisional) =>
  useDataStore.getState().reconcileDispatchTransfer(data, provisional ?? []));
registerOutboxReconciler("receive_stock_transfer", (data, provisional, ackId) =>
  useDataStore.getState().reconcileReceiveTransfer(data, provisional ?? [], ackId));

export type { DataState } from "./types";
