import type { StateCreator } from "zustand";
import type { BufferedInventoryEvent, DataState, InventoryState, AdjustStockInput } from "../types";
import type { AuditLog, Inventory, InventoryMovement } from "../../../types";
import { newId } from "../../../lib/id";
import { beginOperation, type OperationContext } from "../idempotentRpc";
import { Stage, submitOfflineCapable } from "../writeAhead";
import { deleteLocalRows, putLocalRows } from "../localWrites";
import { assertOfflineWriteEligible } from "../../authStore";
import { supabase } from "../../../lib/supabase";
import { localDb } from "../../../lib/localDb";
import { mapInventory } from "../mappers";
import { inventoryKey, pendingStockLedger, sumLedger, type StockLedger } from "../pendingStock";
import { onQueueChanged } from "../outbox";
import {
  appliedFor, appliedLedger, effectOfMovements, eventsSince, isReleased, markStockRead, noteStaged, putLedgerInTransaction,
  readPersistedLedger, registerStagedStockHook, registerStockAccess, rowKey, serverStockRows, setAppliedLedger, setStockUnverified,
  assertStockKnown,
  withoutReleased, type LedgerMap,
} from "../stockLedger";
import { fetchAllRows } from "../fetchAll";
import { clearStoreTimers, later } from "../storeTimers";
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
// every row when `shopId` is null) with `rows` — rows the server no longer
// has are removed, the rest upserted — together with the ledger describing
// them, in ONE transaction (crash-safe pair, stockLedger.ts). Never throws.
async function replaceLocalInventory(shopId: string | null, rows: Inventory[], ledger: LedgerMap): Promise<void> {
  try {
    await localDb.transaction("rw", localDb.inventory, localDb.syncState, async () => {
      const keep = new Set(rows.map((r) => inventoryKey(r.shopId, r.productId)));
      const existing = shopId
        ? await localDb.inventory.where("shopId").equals(shopId).primaryKeys()
        : await localDb.inventory.toCollection().primaryKeys();
      const gone = existing.filter(([s, p]) => !keep.has(inventoryKey(s, p)));
      if (gone.length) await localDb.inventory.bulkDelete(gone);
      if (rows.length) await localDb.inventory.bulkPut(rows);
      await putLedgerInTransaction(ledger);
    });
  } catch (err) {
    console.error("[DB] Failed to replace the local inventory mirror:", err);
  }
}

// Rows + the ledger, one transaction. Rejects on failure.
async function commitStockRows(rows: Inventory[]): Promise<void> {
  await localDb.transaction("rw", localDb.inventory, localDb.syncState, async () => {
    if (rows.length) await localDb.inventory.bulkPut(rows);
    await putLedgerInTransaction();
  });
}

/** Unresolved entries the server read below does not know about yet, plus
 *  how the result must be adjusted for things that happened DURING the read
 *  (see composeServerStock). */
interface ComposedStock {
  rows: Inventory[];
  applied: LedgerMap;
  pendingConfirmation: Record<string, number>;
  followUp: boolean;
}

let unsubscribeQueue: (() => void) | null = null;

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

  // ---------------------------------------------------------------------
  // Unresolved stock effects (Batch 2A, D-NEW-1; supersedes the H2 event
  // correction). Every displayed row is
  //
  //     confirmed server row  +  Σ applied[entry][row]
  //
  // where `applied` (../stockLedger) is the per-entry ledger of the unresolved effects this
  // till has baked into the row (pendingStock.ts decides what counts: whole
  // effects of entries not yet sent; only DECREASES of entries being sent or
  // in doubt). Whenever the queue changes the ledger is recomputed and every
  // row moves by exactly (new − applied) — an entry's effect is therefore
  // applied once, released once (acknowledged → its exact contribution is
  // removed when the server row arrives; refused → removed on the next
  // recompute), and never silently omitted. Writers keep the invariant:
  //  - a server row from a refresh/full load: + the fresh ledger;
  //  - a Realtime row: + the currently applied effects for that row;
  //  - a reply for an acknowledged entry: + the effects of OTHER entries;
  //  - a local staging: its own effect is recorded as applied.
  // ---------------------------------------------------------------------
  const catalog = () => ({
    products: get().products ?? [], productUnits: get().productUnits ?? [],
    stockTransfers: get().stockTransfers ?? [], stockTransferItems: get().stockTransferItems ?? [],
  });
  const replaceRow = (current: Inventory[], row: Inventory): Inventory[] => {
    const idx = current.findIndex((i) => i.shopId === row.shopId && i.productId === row.productId);
    return idx >= 0 ? current.map((i, n) => (n === idx ? row : i)) : [...current, row];
  };
  const mirrorRows = (rows: Inventory[]): void => {
    // Straight to the mirror (with the ledger), NOT putLocalRows.
    commitStockRows(rows).catch((err) => console.error("[DB] Failed to mirror stock rows:", err));
  };
  const pendingConfirmationOf = (target: LedgerMap, ledger: StockLedger): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [entry, effect] of target) {
      if (!ledger.doubtful.has(entry)) continue;
      for (const [key, delta] of effect) if (delta < 0) out[key] = (out[key] ?? 0) - delta;
    }
    return out;
  };
  // What should be applied now: the queue as read (released entries never
  // re-admitted) + entries staged after `marker` that the read missed.
  const targetLedger = (ledger: StockLedger, marker: number): LedgerMap => {
    const target = new Map(withoutReleased(ledger.byEntry));
    for (const e of eventsSince(marker)) {
      if (e.type !== "staged" || isReleased(e.localId) || target.has(e.localId)) continue;
      target.set(e.localId, appliedLedger().get(e.localId) ?? e.effect);
    }
    return target;
  };
  const markUnverified = (err: unknown): void => {
    console.error("[DB] Stock effects of the queue could not be established; stock is unverified:", err);
    setStockUnverified(true);
    set({ stockUnverified: true });
  };
  // The queue was read again: stock is established (for the state field).
  const markVerified = (): false => {
    setStockUnverified(false);
    return false;
  };

  // Recompute serially; queue notifications that arrive during a run are
  // coalesced into one more run.
  let syncChain: Promise<void> = Promise.resolve();
  let syncQueued = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const runStockSync = async (): Promise<void> => {
    syncQueued = false;
    const marker = markStockRead();
    let ledger: StockLedger;
    try {
      ledger = await pendingStockLedger(get().movements ?? [], catalog());
    } catch (err) {
      // Fail closed: keep what is shown, refuse offline stock checks, retry.
      markUnverified(err);
      if (!retryTimer) retryTimer = later(() => { retryTimer = null; void scheduleStockSync(); }, 5_000);
      return;
    }
    const target = targetLedger(ledger, marker);
    const changed: Inventory[] = [];
    set((s) => {
      const want = sumLedger(target);
      const have = sumLedger(appliedLedger());
      let inventory = s.inventory;
      for (const key of new Set([...want.keys(), ...have.keys()])) {
        const diff = (want.get(key) ?? 0) - (have.get(key) ?? 0);
        if (!diff) continue;
        const idx = inventory.findIndex((r) => rowKey(r) === key);
        if (idx < 0) continue;
        const row = { ...inventory[idx], qtyBaseUnits: inventory[idx].qtyBaseUnits + diff };
        inventory = inventory.map((r, n) => (n === idx ? row : r));
        changed.push(row);
      }
      setAppliedLedger(target);
      return { inventory, stockPendingConfirmation: pendingConfirmationOf(target, ledger), stockUnverified: markVerified() };
    });
    await commitStockRows(changed).catch((err) => console.error("[DB] Failed to mirror stock rows:", err));
  };
  const scheduleStockSync = (): Promise<void> => {
    if (syncQueued) return syncChain;
    syncQueued = true;
    syncChain = syncChain.then(runStockSync).catch((err) => console.error("[DB] Stock recompute failed:", err));
    return syncChain;
  };

  /**
   * Server rows (from a refresh or a full load) as they must be displayed.
   * `marker` was taken BEFORE the server read. Rows whose server figure
   * moved by an acknowledgement DURING the read may or may not include it,
   * so they are never shown above what is displayed now, and a follow-up
   * refresh is asked for. Live events newer than the read win over pages
   * (they are server rows too). Null when the queue cannot be read.
   */
  const composeServerStock = async (
    serverRows: Inventory[], marker: number, inScope: (key: string) => boolean,
    events: BufferedInventoryEvent[] = [], sinceTs = Number.NEGATIVE_INFINITY,
  ): Promise<ComposedStock | null> => {
    let ledger: StockLedger;
    try {
      ledger = await pendingStockLedger(get().movements ?? [], catalog());
    } catch (err) {
      markUnverified(err);
      return null;
    }
    const target = targetLedger(ledger, marker);
    const sum = sumLedger(target);
    const byKey = new Map(serverRows.map((r) => [rowKey(r), r]));
    for (const e of events) {
      const key = inventoryKey(e.shopId, e.productId);
      if (!inScope(key) || e.ts < sinceTs) continue;
      if (e.row) byKey.set(key, e.row);
      else byKey.delete(key);
    }
    const moved = new Set(eventsSince(marker).filter((e) => e.type === "released").flatMap((e) => e.keys ?? []));
    const current = new Map(get().inventory.map((r) => [rowKey(r), r.qtyBaseUnits]));
    let followUp = false;
    const rows = [...byKey.values()].map((r) => {
      const key = rowKey(r);
      let qty = r.qtyBaseUnits + (sum.get(key) ?? 0);
      if (moved.has(key)) {
        followUp = true;
        const shown = current.get(key);
        if (shown !== undefined && shown < qty) qty = shown;
      }
      return { ...r, qtyBaseUnits: qty };
    });
    return { rows, applied: target, pendingConfirmation: pendingConfirmationOf(target, ledger), followUp };
  };

  // The ledger describes THIS store's rows: a new store starts empty and
  // takes over the queue subscription (only one store exists in the app;
  // tests create several).
  setAppliedLedger(new Map());
  clearStoreTimers();
  unsubscribeQueue?.();
  unsubscribeQueue = onQueueChanged(() => { void scheduleStockSync(); });
  // Reads for the ledger; refreshes it requests are coalesced per shop.
  const refreshRequested = new Set<string>();
  const requestRefresh = (shopId: string, delayMs = 0): void => {
    if (refreshRequested.has(shopId)) return;
    refreshRequested.add(shopId);
    later(() => {
      refreshRequested.delete(shopId);
      void get().refreshInventoryFromServer({ shopId }).catch(() => undefined);
    }, delayMs);
  };
  registerStockAccess({
    currentQty: (key) => get().inventory.find((r) => rowKey(r) === key)?.qtyBaseUnits,
    snapshot: () => new Map(get().inventory.map((r) => [rowKey(r), r.qtyBaseUnits])),
    requestRefresh: (shopId) => requestRefresh(shopId, 250),
    commit: commitStockRows,
  });

  registerStagedStockHook((localId, movements, before) => {
    // Each touched row = what was displayed just before the staging was
    // applied + its effect − whatever this entry already had applied (an
    // online attempt counted while it was being sent is replaced, not
    // added to). The staging's own absolute figures were computed from an
    // earlier read and are not trusted for the row. The mirror got the same
    // re-based rows and the ledger in the staging's own transaction.
    const previous = appliedLedger().get(localId) ?? new Map<string, number>();
    const effect = effectOfMovements(movements);
    set((s) => {
      let inventory = s.inventory;
      for (const key of new Set([...effect.keys(), ...previous.keys()])) {
        const base = before.get(key);
        if (base === undefined) continue; // a new row: the staging's figure stands
        const idx = inventory.findIndex((r) => rowKey(r) === key);
        if (idx < 0) continue;
        const row = { ...inventory[idx], qtyBaseUnits: base + (effect.get(key) ?? 0) - (previous.get(key) ?? 0) };
        inventory = inventory.map((r, n) => (n === idx ? row : r));
      }
      return { inventory };
    });
    noteStaged(localId, effect);
  });

  // Manual inventory adjustment / damage write-off — a single atomic Supabase
  // RPC. The database validates permission, shop scope, the reason, the type
  // and the resulting stock level, then writes inventory, the movement and the
  // audit row in one transaction.
  const applyAdjustStock = async (data: unknown, ackId: string): Promise<void> => {
    const result = data as AdjustStockResult;
    const [shown] = serverStockRows([result.inventory], ackId);

    // Reconcile local state from the authoritative RPC result.
    set((s) => ({
      inventory: replaceRow(s.inventory, shown),
      movements: [result.movement, ...s.movements],
      auditLogs: [result.auditLog, ...s.auditLogs],
    }));
    await putLocalRows({ movements: [result.movement], auditLogs: [result.auditLog] });
  };

  // No network: stage the adjustment locally against the current cached
  // stock level and queue the exact RPC call for replay once back online.
  // The server is still the final say: reconcileAdjustStock() below replaces
  // this provisional movement with whatever the server actually accepts.
  const stageAdjustStock = async (input: AdjustStockInput, op: OperationContext, stage: Stage): Promise<void> => {
    await assertOfflineWriteEligible();
    assertStockKnown();
    const { shopId, productId, type, qtyChange, reason, actorId, referenceType, referenceId, productUnitId, unitQty } = input;
    const now = op.createdAt;
    const qtyBefore = stage.qty(get, shopId, productId);

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

    stage.set((s: DataState) => {
      const idx = s.inventory.findIndex((i) => i.shopId === shopId && i.productId === productId);
      const inventory = idx >= 0
        ? s.inventory.map((i, n) => (n === idx ? inventoryUpdate : i))
        : [...s.inventory, inventoryUpdate];
      return { inventory, movements: [movement, ...s.movements] };
    });
    stage.put({ inventory: [inventoryUpdate], movements: [movement] });

    stage.enqueue({
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
      return submitOfflineCapable({
        set, name: "adjust_stock", shopId: input.shopId, op,
        args: buildAdjustStockArgs(input, op),
        applyOnline: applyAdjustStock,
        stage: (stage) => stageAdjustStock(input, op, stage),
      });
    },

    // Called by the outbox once a queued adjust_stock actually runs — swaps
    // the provisional movement for the server's authoritative one.
    reconcileAdjustStock: (data, provisional, ackId) => {
      const result = data as AdjustStockResult;
      const provisionalMovementIds = new Set(provisional.find((p) => p.table === "movements")?.ids ?? []);
      const [shown] = serverStockRows([result.inventory], ackId ?? null);

      set((s) => {
        return {
          inventory: replaceRow(s.inventory, shown),
          // also drop an existing copy of the authoritative rows (a full
          // reload between a lost-response commit and this replay already
          // brought them in) so nothing is listed twice
          movements: [result.movement, ...s.movements.filter((m) => !provisionalMovementIds.has(m.id) && m.id !== result.movement.id)],
          auditLogs: [result.auditLog, ...s.auditLogs.filter((a) => a.id !== result.auditLog.id)],
        };
      });
      void deleteLocalRows(provisional);
      void putLocalRows({ movements: [result.movement], auditLogs: [result.auditLog] });
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
      // The server's row + the unresolved effects already applied to it:
      // a queued offline sale stays visible, nothing is counted twice.
      const shown = { ...row, qtyBaseUnits: row.qtyBaseUnits + appliedFor(key) };
      set((s) => ({ inventory: replaceRow(s.inventory, shown) }));
      mirrorRows([shown]);
    },

    applyInventoryRealtimeDelete: (shopId: string, productId: string, commitTimestamp?: string) => {
      const key = inventoryKey(shopId, productId);
      if (isStaleEvent(key, commitTimestamp)) return;
      noteEvent(key, commitTimestamp);
      bufferEvent(key, { row: null, shopId, productId, ts: eventTs(commitTimestamp) });
      set((s) => ({ inventory: s.inventory.filter((i) => !(i.shopId === shopId && i.productId === productId)) }));
      localDb.inventory.delete([shopId, productId]).catch((err) => {
        console.error("[DB] Failed to remove a deleted inventory row from the local cache:", err);
      });
    },

    refreshInventoryFromServer: async (options) => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
      const shopId = options?.shopId !== undefined ? options.shopId : useAppStore.getState().currentShopId;
      const inScope = (row: { shopId: string }): boolean => (shopId ? row.shopId === shopId : true);

      // Events accepted from here on are re-applied over the pages (G-5);
      // acknowledgements and stagings from here on are accounted for too.
      const buffer = new Map<string, BufferedInventoryEvent>();
      eventBuffers.add(buffer);
      const marker = markStockRead();
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

        // 3. Unresolved effects of the queue (read AFTER the pages) and the
        //    live events newer than the watermark that arrived meanwhile.
        const composed = await composeServerStock(serverRows, marker, (key) => (shopId ? key.startsWith(`${shopId}|`) : true), [...buffer.values()], watermark);
        if (!composed) return false; // fail closed: nothing replaced
        const rows = composed.rows;

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
        // The scope now carries exactly the composed ledger; rows outside it
        // keep their applied effects (the recompute below aligns them).
        const scoped = (key: string) => (shopId ? key.startsWith(`${shopId}|`) : true);
        const merged: LedgerMap = new Map();
        for (const [entry, effect] of appliedLedger()) {
          const keep = new Map([...effect].filter(([k]) => !scoped(k)));
          if (keep.size) merged.set(entry, keep);
        }
        for (const [entry, effect] of composed.applied) {
          const into = merged.get(entry) ?? new Map<string, number>();
          for (const [k, d] of effect) if (scoped(k)) into.set(k, d);
          if (into.size) merged.set(entry, into);
        }
        setAppliedLedger(merged);
        set((s) => ({
          inventory: [...s.inventory.filter((row) => !inScope(row)), ...rows],
          stockPendingConfirmation: composed.pendingConfirmation, stockUnverified: markVerified(),
        }));
        await replaceLocalInventory(shopId ?? null, rows, appliedLedger());
        void scheduleStockSync();
        // Something was acknowledged while the pages were read: confirm.
        if (composed.followUp && shopId) requestRefresh(shopId, 500);
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

    // A full load replaced every row with its composed rows (composeServerStock).
    noteStockLedger: (applied, pendingConfirmation) => {
      setAppliedLedger(new Map(applied));
      set({ stockPendingConfirmation: Object.fromEntries(pendingConfirmation), stockUnverified: markVerified() });
      void scheduleStockSync();
    },

    beginStockRead: () => markStockRead(),

    composeServerStock: (serverRows, marker, events, sinceTs) =>
      composeServerStock(serverRows, marker, () => true, events, sinceTs ?? Number.NEGATIVE_INFINITY),

    // Rows rendered from the local mirror at startup. The persisted ledger
    // was written with them (same transaction) and says what they contain —
    // but only for entries the queue still counts: an entry that is gone
    // (an older app version drained it, or the owner settled it) or no
    // longer counted is dropped WITHOUT moving any row (at worst stock stays
    // understated until the next refresh — never overstated). A queued entry
    // the ledger does not know (queued by an older version, whose mirror
    // rows include it) is taken as applied with its current effect.
    adoptStockLedger: async () => {
      try {
        const [persisted, ledger] = await Promise.all([
          readPersistedLedger(),
          pendingStockLedger(get().movements ?? [], catalog()),
        ]);
        const adopted: LedgerMap = new Map();
        for (const [entry, effect] of ledger.byEntry) adopted.set(entry, persisted?.get(entry) ?? effect);
        setAppliedLedger(adopted);
      } catch (err) {
        markUnverified(err);
        return;
      }
      await scheduleStockSync();
    },

    stockUnverified: false,

    stockPendingConfirmation: {},

    syncStockWithQueue: () => scheduleStockSync(),

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
