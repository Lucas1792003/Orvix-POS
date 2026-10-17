import type { StateCreator } from "zustand";
import type { BufferedInventoryEvent, DataState, InventoryState, AdjustStockInput } from "../types";
import type { AuditLog, Inventory, InventoryMovement } from "../../../types";
import { isNetworkError } from "../../../lib/errors";
import { newId } from "../../../lib/id";
import { enqueueOutbox } from "../outbox";
import { beginOperation, callRpc, type OperationContext } from "../idempotentRpc";
import { deleteLocalRows, putLocalRows } from "../localWrites";
import { assertOfflineWriteEligible } from "../../authStore";
import { supabase } from "../../../lib/supabase";
import { localDb } from "../../../lib/localDb";
import { mapInventory } from "../mappers";
import { inventoryKey, pendingStockDeltas, withPendingStock } from "../pendingStock";
import { fetchAllRows } from "../fetchAll";
import { useAppStore } from "../../appStore";

// Shape returned by the adjust_stock RPC (camelCase keys).
interface AdjustStockResult {
  inventory: Inventory;
  movement: InventoryMovement;
  auditLog: AuditLog;
}

// Shared by the online call and the offline path (which stores this exact
// payload in the outbox to replay verbatim once back online).
const buildAdjustStockArgs = (
  { shopId, productId, type, qtyChange, reason, productUnitId, unitQty }: AdjustStockInput,
  { createdAt, idempotencyKey }: OperationContext,
) => ({
  p_shop_id: shopId,
  p_product_id: productId,
  p_adjustment_type: type,
  // When a sellable unit is selected, the server overrides the magnitude
  // (`unitQty * base_quantity`) but keeps the sign of `qtyChange`. Pass
  // ±1 from the form as a direction hint in that path.
  p_quantity_delta: qtyChange,
  p_reason: reason,
  p_product_unit_id: productUnitId ?? null,
  p_unit_qty: unitQty ?? null,
  // Preserved through an offline queue-and-replay — see migration 045.
  p_created_at: createdAt,
  // Same key on every attempt, so a retry after a lost response can't
  // double-apply the adjustment (Phase D idempotency contract).
  p_idempotency_key: idempotencyKey,
});

// Replace the local mirror's inventory rows for one scope (one shop, or
// every row when `shopId` is null) with `rows`: rows the server no longer
// has are removed, the rest upserted. Never throws.
async function replaceLocalInventory(shopId: string | null, rows: Inventory[]): Promise<void> {
  try {
    const keep = new Set(rows.map((r) => inventoryKey(r.shopId, r.productId)));
    const existing = shopId
      ? await localDb.inventory.where("shopId").equals(shopId).primaryKeys()
      : await localDb.inventory.toCollection().primaryKeys();
    const gone = existing.filter(([s, p]) => !keep.has(inventoryKey(s, p)));
    if (gone.length) await localDb.inventory.bulkDelete(gone);
  } catch (err) {
    console.error("[DB] Failed to prune the local inventory mirror:", err);
  }
  await putLocalRows({ inventory: rows });
}

export const createInventorySlice: StateCreator<DataState, [], [], InventoryState> = (set, get) => {
  // Server-time watermark per inventory row (ms since epoch, SERVER clock
  // only — never compared with Date.now()): the commit time of the latest
  // state this device holds for the row, from a Realtime event's
  // `commit_timestamp` or from the server's `now()` taken just before an
  // authoritative refresh. An event older than the watermark is a stale
  // delivery (reordered, or committed before a refresh that already
  // includes it) and is ignored. Kept outside the Zustand state: it is
  // bookkeeping, not data, and must not be persisted or rendered.
  const watermarks = new Map<string, number>();
  const parseTs = (value: string | undefined): number => (value ? Date.parse(value) : NaN);
  // True when `commitTimestamp` is known to be older than what we hold.
  const isStaleEvent = (key: string, commitTimestamp?: string): boolean => {
    const eventTs = parseTs(commitTimestamp);
    const known = watermarks.get(key);
    return !Number.isNaN(eventTs) && known !== undefined && eventTs < known;
  };
  const noteEvent = (key: string, commitTimestamp?: string): void => {
    const eventTs = parseTs(commitTimestamp);
    if (!Number.isNaN(eventTs)) watermarks.set(key, eventTs);
  };
  // Watermarks only move forward: a refresh's server time must not lower
  // the watermark an event newer than it already set.
  const raiseWatermark = (key: string, ts: number): void => {
    const known = watermarks.get(key);
    if (known === undefined || ts > known) watermarks.set(key, ts);
  };

  // Realtime events accepted WHILE a paged refresh or a full load is reading
  // (one buffer per read in flight). The pages may have been read before
  // such an event committed, so replacing the rows with them would roll it
  // back (G-5); each reader re-applies the newest buffered event per row on
  // top of its pages. Latest commit time wins; an event without a commit
  // time is treated as newest.
  const eventBuffers = new Set<Map<string, BufferedInventoryEvent>>();
  const bufferEvent = (key: string, event: BufferedInventoryEvent): void => {
    for (const buffer of eventBuffers) {
      const prev = buffer.get(key);
      if (!prev || !(event.ts < prev.ts)) buffer.set(key, event);
    }
  };
  const eventTs = (commitTimestamp?: string): number => {
    const ts = parseTs(commitTimestamp);
    return Number.isNaN(ts) ? Number.POSITIVE_INFINITY : ts;
  };

  // Pending offline stock on live rows (H2, ORV-021). A Realtime row is the
  // SERVER's value; operations still queued on this till (pendingStock.ts)
  // are not in it, so showing it raw "un-sells" an offline sale until the
  // queue drains (oversell risk).
  //  - No queued stock change for the row (no provisional movement with
  //    pendingSync in memory — every offline stock write creates one, and
  //    the drain's reconcile removes it): the server row is exact and is
  //    applied synchronously, as before.
  //  - Otherwise the row is NOT shown raw: the current row stays until the
  //    queued deltas are read from the outbox, then server row + those
  //    deltas is applied. pendingStockDeltas counts only pending/failed
  //    entries — never one being sent or already acknowledged — so a sale is
  //    never subtracted twice.
  // Either way the result is (re)computed from the outbox before the local
  // mirror is written, and dropped when a newer event for the row arrived
  // (eventSeq), when a refresh or full load replaced the rows meanwhile
  // (they re-apply buffered events themselves), or when another writer
  // replaced the row (a drain's authoritative row, a local write).
  const eventSeq = new Map<string, number>();
  let refreshGeneration = 0;
  const nextSeq = (key: string): number => {
    const seq = (eventSeq.get(key) ?? 0) + 1;
    eventSeq.set(key, seq);
    return seq;
  };
  const replaceRow = (current: Inventory[], row: Inventory): Inventory[] => {
    const idx = current.findIndex((i) => i.shopId === row.shopId && i.productId === row.productId);
    return idx >= 0 ? current.map((i, n) => (n === idx ? row : i)) : [...current, row];
  };

  // Manual inventory adjustment / damage write-off — a single atomic Supabase
  // RPC. The database validates permission, shop scope, the reason, the type
  // and the resulting stock level, then writes inventory, the movement and the
  // audit row in one transaction.
  const adjustStockOnline = async (input: AdjustStockInput, op: OperationContext): Promise<void> => {
    const { data, error } = await callRpc("adjust_stock", buildAdjustStockArgs(input, op));
    if (error) throw error;
    if (!data) throw new Error("Stock adjustment returned no data.");

    const result = data as AdjustStockResult;

    // Reconcile local state from the authoritative RPC result.
    set((s) => {
      const idx = s.inventory.findIndex(
        (i) => i.shopId === result.inventory.shopId && i.productId === result.inventory.productId
      );
      const inventory =
        idx >= 0
          ? s.inventory.map((i, n) => (n === idx ? result.inventory : i))
          : [...s.inventory, result.inventory];
      return {
        inventory,
        movements: [result.movement, ...s.movements],
        auditLogs: [result.auditLog, ...s.auditLogs],
      };
    });
    void putLocalRows({ inventory: [result.inventory], movements: [result.movement], auditLogs: [result.auditLog] });
  };

  // No network: stage the adjustment locally against the current cached
  // stock level and queue the exact RPC call for replay once back online.
  // The server is still the final say: reconcileAdjustStock() below replaces
  // this provisional movement with whatever the server actually accepts.
  const adjustStockOffline = async (input: AdjustStockInput, op: OperationContext): Promise<void> => {
    await assertOfflineWriteEligible();
    const { shopId, productId, type, qtyChange, reason, actorId, referenceType, referenceId, productUnitId, unitQty } = input;
    const now = op.createdAt;
    const qtyBefore = get().getInventoryQty(shopId, productId);

    // Mirror the server: a sellable unit overrides the magnitude but keeps
    // qtyChange's sign as the direction.
    let delta = qtyChange;
    if (productUnitId && unitQty != null) {
      const unit = get().productUnits.find((u) => u.id === productUnitId);
      const magnitude = unit ? unitQty * unit.baseQuantity : Math.abs(qtyChange);
      delta = qtyChange < 0 ? -magnitude : magnitude;
    }
    const qtyAfter = qtyBefore + delta;
    if (qtyAfter < 0) {
      throw new Error(`Adjustment would leave negative stock (${qtyAfter}).`);
    }

    const inventoryUpdate: Inventory = { shopId, productId, qtyBaseUnits: qtyAfter };
    const movement: InventoryMovement = {
      id: newId("move"), shopId, productId, type,
      qtyChange: delta, qtyBefore, qtyAfter, reason,
      referenceType, referenceId, createdBy: actorId, createdAt: now,
      productUnitId, pendingSync: true, idempotencyKey: op.idempotencyKey,
    };

    set((s) => {
      const idx = s.inventory.findIndex((i) => i.shopId === shopId && i.productId === productId);
      const inventory = idx >= 0
        ? s.inventory.map((i, n) => (n === idx ? inventoryUpdate : i))
        : [...s.inventory, inventoryUpdate];
      return { inventory, movements: [movement, ...s.movements] };
    });
    void putLocalRows({ inventory: [inventoryUpdate], movements: [movement] });

    await enqueueOutbox({
      kind: "rpc",
      name: "adjust_stock",
      args: buildAdjustStockArgs(input, op),
      idempotencyKey: op.idempotencyKey,
      shopId,
      provisional: [{ table: "movements", ids: [movement.id] }],
    });
  };

  return {
    inventory: [],
    movements: [],

    adjustStock: async (input: AdjustStockInput) => {
      const op = beginOperation();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return adjustStockOffline(input, op);
      }
      try {
        return await adjustStockOnline(input, op);
      } catch (err) {
        if (isNetworkError(err)) return adjustStockOffline(input, op);
        throw err;
      }
    },

    // Called by the outbox once a queued adjust_stock actually runs — swaps
    // the provisional movement for the server's authoritative one.
    reconcileAdjustStock: (data, provisional) => {
      const result = data as AdjustStockResult;
      const provisionalMovementIds = new Set(provisional.find((p) => p.table === "movements")?.ids ?? []);

      set((s) => {
        const idx = s.inventory.findIndex(
          (i) => i.shopId === result.inventory.shopId && i.productId === result.inventory.productId
        );
        const inventory = idx >= 0
          ? s.inventory.map((i, n) => (n === idx ? result.inventory : i))
          : [...s.inventory, result.inventory];
        return {
          inventory,
          // also drop an existing copy of the authoritative rows (a full
          // reload between a lost-response commit and this replay already
          // brought them in) so nothing is listed twice
          movements: [result.movement, ...s.movements.filter((m) => !provisionalMovementIds.has(m.id) && m.id !== result.movement.id)],
          auditLogs: [result.auditLog, ...s.auditLogs.filter((a) => a.id !== result.auditLog.id)],
        };
      });
      void deleteLocalRows(provisional);
      void putLocalRows({ inventory: [result.inventory], movements: [result.movement], auditLogs: [result.auditLog] });
    },

    // Called by the Realtime subscription (migration 058, stores/data/
    // inventoryRealtime.ts) when another device changes a stock level —
    // `inventory` has no `updated_at`, so it's excluded from delta-sync's
    // polling entirely (see deltaSync.ts). Steady-state path only: after a
    // gap the subscription runs refreshInventoryFromServer() below, and an
    // event that predates that refresh (or a later event) is dropped here.
    applyInventoryRealtimeUpdate: (row: Inventory, commitTimestamp?: string) => {
      const key = inventoryKey(row.shopId, row.productId);
      if (isStaleEvent(key, commitTimestamp)) return;
      noteEvent(key, commitTimestamp);
      bufferEvent(key, { row, shopId: row.shopId, productId: row.productId, ts: eventTs(commitTimestamp) });
      const seq = nextSeq(key);
      const generation = refreshGeneration;
      const mayHavePending = get().movements.some(
        (m) => m.pendingSync && m.shopId === row.shopId && m.productId === row.productId,
      );
      // The row this handler expects to find when its async step runs.
      const expected = mayHavePending
        ? get().inventory.find((i) => i.shopId === row.shopId && i.productId === row.productId)
        : row;
      if (!mayHavePending) set((s) => ({ inventory: replaceRow(s.inventory, row) }));
      void (async () => {
        let pending: Map<string, number>;
        try {
          pending = await pendingStockDeltas(get().movements);
        } catch (err) {
          console.error("[DB] Realtime stock: could not read queued deltas:", err);
          return;
        }
        if (eventSeq.get(key) !== seq || refreshGeneration !== generation) return;
        const current = get().inventory.find((i) => i.shopId === row.shopId && i.productId === row.productId);
        if (current !== expected) return; // replaced by another writer: theirs stands
        const corrected = withPendingStock([row], pending)[0];
        if (corrected !== current) set((s) => ({ inventory: replaceRow(s.inventory, corrected) }));
        // Straight to the mirror, NOT putLocalRows: that would also record the
        // row as a local write a running full load re-applies over its pages
        // (localWrites.ts) — even for an event that predates the load. The
        // load re-applies captured events itself, by commit time.
        await localDb.inventory.put(corrected).catch((err) => {
          console.error("[DB] Realtime stock: failed to mirror the row:", err);
        });
      })();
    },

    applyInventoryRealtimeDelete: (shopId: string, productId: string, commitTimestamp?: string) => {
      const key = inventoryKey(shopId, productId);
      if (isStaleEvent(key, commitTimestamp)) return;
      noteEvent(key, commitTimestamp);
      bufferEvent(key, { row: null, shopId, productId, ts: eventTs(commitTimestamp) });
      nextSeq(key); // cancels a pending correction of an earlier update
      set((s) => ({ inventory: s.inventory.filter((i) => !(i.shopId === shopId && i.productId === productId)) }));
      localDb.inventory.delete([shopId, productId]).catch((err) => {
        console.error("[DB] Failed to remove a deleted inventory row from the local cache:", err);
      });
    },

    refreshInventoryFromServer: async (options) => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
      const shopId = options?.shopId !== undefined ? options.shopId : useAppStore.getState().currentShopId;
      const inScope = (row: { shopId: string }): boolean => (shopId ? row.shopId === shopId : true);

      // Events accepted from here on are re-applied over the pages (G-5).
      const buffer = new Map<string, BufferedInventoryEvent>();
      eventBuffers.add(buffer);
      try {
        // 1. Server time BEFORE the read (resolve_event_time(NULL) is now(),
        //    migration 045; granted to authenticated by 064). Anything
        //    committed before this instant is visible to the pages below,
        //    so a Realtime event with an older commit_timestamp that is still
        //    delivered afterwards must not overwrite the rows. Client clocks
        //    are never involved.
        let watermark: number;
        try {
          const { data, error } = await supabase.rpc("resolve_event_time", { p_client_time: null });
          if (error) {
            console.error("[DB] Inventory refresh: could not read server time:", error.message);
            return false;
          }
          watermark = Date.parse(String(data));
        } catch (err) {
          console.error("[DB] Inventory refresh: could not read server time:", err);
          return false;
        }

        // 2. The authoritative rows for the scope — every page (ORV-001),
        //    all-or-nothing: a failed or interrupted read changes nothing.
        const res = await fetchAllRows({
          table: "inventory",
          keys: ["shop_id", "product_id"],
          filter: shopId ? (q) => q.eq("shop_id", shopId) : undefined,
        });
        if (res.error) {
          console.error("[DB] Inventory refresh failed:", res.error.message);
          return false;
        }
        const serverRows: Inventory[] = res.data.map(mapInventory);

        // 3. Provisional deltas of operations still queued — read AFTER the
        //    pages so an entry the drain finished meanwhile (its effect now
        //    inside the server rows) is not applied twice.
        const pending = await pendingStockDeltas(get().movements);
        const byKey = new Map(withPendingStock(serverRows, pending).map((r) => [inventoryKey(r.shopId, r.productId), r]));

        // 4. Live events newer than the watermark that arrived during the
        //    read win over the pages (they may postdate them). Their rows are
        //    server rows too, so the queued deltas apply to them as well.
        for (const [key, event] of buffer) {
          if (!inScope(event) || event.ts < watermark) continue;
          if (event.row) byKey.set(key, withPendingStock([event.row], pending)[0]);
          else byKey.delete(key);
        }
        const rows = [...byKey.values()];

        // 5. Replace — not merge — the scope.
        if (!Number.isNaN(watermark)) {
          if (shopId) {
            for (const row of serverRows) raiseWatermark(inventoryKey(row.shopId, row.productId), watermark);
          } else {
            // Rows that vanished server-side must not be resurrected by a
            // late event either: stamp every key we knew plus every key read.
            for (const key of [...watermarks.keys()]) raiseWatermark(key, watermark);
            for (const row of serverRows) raiseWatermark(inventoryKey(row.shopId, row.productId), watermark);
          }
        }
        refreshGeneration += 1; // corrections of earlier events are superseded by these rows
        set((s) => ({ inventory: [...s.inventory.filter((row) => !inScope(row)), ...rows] }));
        await replaceLocalInventory(shopId ?? null, rows);
        return true;
      } finally {
        eventBuffers.delete(buffer);
      }
    },

    captureInventoryEvents: () => {
      const buffer = new Map<string, BufferedInventoryEvent>();
      eventBuffers.add(buffer);
      return {
        finish: () => {
          eventBuffers.delete(buffer);
          return [...buffer.values()];
        },
      };
    },

    notePendingStockDeltas: () => {
      refreshGeneration += 1; // a full load replaced every row
    },

    recordDamage: async ({ shopId, productId, qty, reason, actorId }) => {
      // Damage write-off is a negative adjustment of type DAMAGE.
      await get().adjustStock({
        shopId,
        productId,
        type: "DAMAGE",
        qtyChange: -Math.abs(qty),
        reason: `Damage/Expiry: ${reason}`,
        actorId,
        referenceType: "damage",
      });
    },

    getInventoryQty: (shopId: string, productId: string) => {
      const record = get().inventory.find((item) => item.shopId === shopId && item.productId === productId);
      return record?.qtyBaseUnits ?? 0;
    },
  };
};
