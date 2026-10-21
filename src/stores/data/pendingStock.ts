import { localDb, type SyncOutboxEntry } from "../../lib/localDb";
import type { InventoryMovement } from "../../types";

export const inventoryKey = (shopId: string, productId: string): string => `${shopId}|${productId}`;

// ----------------------------------------------------------------------
// Unresolved local stock effects (Batch 2A, owner decision D-NEW-1).
//
// Displayed stock = the confirmed server row + the effects of operations
// this till has not yet had confirmed. Per outbox entry:
//
//  NOT SENT / definitely not applied  (pending|failed, not in doubt)
//      → its whole stock effect counts: the server does not have it yet.
//  SENDING / IN DOUBT                  (syncing, or inDoubt)
//      → the server MAY already have applied it. Conservative: only its
//        stock DECREASES count (a sale, a write-off, the source side of a
//        transfer), increases do not — stock is understated rather than
//        overstated, so the till cannot oversell — and the products are
//        flagged "pending confirmation" until a reply settles it.
//  SET ASIDE / QUARANTINED             (archived, quarantined)
//      → out of this till's queue but not settled (the owner may still
//        reconcile it): only its DECREASES count, flagged as above.
//  HELD FOR CONFIRMATION (G1 Stage 1: conflict + fenceRequired, no server
//        decision yet) → only its DECREASES count, flagged as above: the
//        server may have applied it.
//  acknowledged / conflict / reconciled → nothing (gone, refused by the
//        server — no stock moved — or settled by the owner).
//
// An entry's effect comes from its provisional inventory movements; an
// entry without any (an online attempt in flight, or one that crashed
// before it could stage locally) — or whose movements can no longer be
// read — is derived from its own arguments.
//
// Fail closed (correction pass): when the queue or the movements cannot be
// read, or an effect cannot be established at all, this THROWS
// (StockLedgerUnavailableError) instead of reporting "nothing pending" —
// the caller keeps what it shows and offline stock checks refuse.
// ----------------------------------------------------------------------

export class StockLedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockLedgerUnavailableError";
  }
}

export interface StockCatalog {
  products?: { id: string; isNonStock?: boolean }[];
  productUnits?: { id: string; baseQuantity: number }[];
  stockTransfers?: { id: string; fromShopId: string; toShopId: string }[];
  stockTransferItems?: { transferId: string; productId: string; approvedQty?: number | null; requestedQty: number }[];
}

export interface StockLedger {
  /** Counted delta per entry (localId) and inventory key. */
  byEntry: Map<string, Map<string, number>>;
  /** Base units per key whose deduction is not yet confirmed (indicator). */
  pendingConfirmation: Map<string, number>;
  /** Entries counted as "decreases only" (in doubt, being sent, parked). */
  doubtful: Set<string>;
}

const COUNTED_STATUSES = ["pending", "failed", "syncing", "archived", "quarantined"] as const;

/** A conflict with no server decision: held for lookup + fence, in doubt,
 *  or refused without a recorded refusal (it could still run). Its decrease
 *  stays reserved until the server decides (stabilization H). */
const heldForConfirmation = (entry: SyncOutboxEntry): boolean =>
  entry.status === "conflict" && !entry.serverOutcome
  && (entry.fenceRequired === true || entry.inDoubt === true || entry.blocksQueue === true);

/** Only decreases count (the server may already have it, or it is parked). */
const decreasesOnly = (entry: SyncOutboxEntry): boolean =>
  entry.inDoubt === true || entry.status === "syncing" || entry.status === "archived" || entry.status === "quarantined"
  || heldForConfirmation(entry);

/** Entries the server definitively refused (or fenced) moved no stock. A
 *  set-aside entry whose outcome is NOT established (held for lookup, in
 *  doubt) keeps its conservative decrease (M2): it may yet have run. */
const wasRefused = (entry: SyncOutboxEntry): boolean =>
  entry.serverOutcome === "rejected" || entry.serverOutcome === "abandoned"
  || (entry.status === "archived" && entry.statusBeforeArchive === "conflict"
    && entry.fenceRequired !== true && entry.inDoubt !== true && entry.blocksQueue !== true);

/** Operations whose effect can be derived from their arguments alone. */
const DERIVABLE = new Set(["complete_sale", "adjust_stock", "receive_stock_transfer"]);

/** Stock effect implied by an operation's own arguments (no provisional rows). */
export function stockEffectOfArgs(entry: Pick<SyncOutboxEntry, "name" | "args">, catalog: StockCatalog = {}): Map<string, number> {
  const effect = new Map<string, number>();
  const a = entry.args ?? {};
  const add = (shopId: unknown, productId: unknown, qty: number) => {
    if (typeof shopId !== "string" || typeof productId !== "string" || !Number.isFinite(qty) || qty === 0) return;
    const key = inventoryKey(shopId, productId);
    effect.set(key, (effect.get(key) ?? 0) + qty);
  };
  const nonStock = new Set((catalog.products ?? []).filter((p) => p.isNonStock).map((p) => p.id));
  if (entry.name === "complete_sale" && Array.isArray(a.p_items)) {
    for (const item of a.p_items as { product_id?: string; qty?: number; units_per_item?: number }[]) {
      if (!item.product_id || nonStock.has(item.product_id)) continue;
      add(a.p_shop_id, item.product_id, -Number(item.qty ?? 0) * Number(item.units_per_item ?? 1));
    }
  } else if (entry.name === "adjust_stock") {
    let delta = Number(a.p_quantity_delta ?? 0);
    if (typeof a.p_product_unit_id === "string" && a.p_unit_qty != null) {
      const unit = (catalog.productUnits ?? []).find((u) => u.id === a.p_product_unit_id);
      const magnitude = unit ? Number(a.p_unit_qty) * unit.baseQuantity : Math.abs(delta);
      delta = delta < 0 ? -magnitude : magnitude;
    }
    add(a.p_shop_id, a.p_product_id, delta);
  } else if (entry.name === "receive_stock_transfer") {
    // Source → destination for the received (else approved) quantities.
    const transfer = (catalog.stockTransfers ?? []).find((t) => t.id === a.p_transfer_id);
    if (!transfer) return effect;
    const received = new Map(((a.p_received_items as { product_id: string; received_qty: number }[] | null) ?? [])
      .map((r) => [r.product_id, Number(r.received_qty)]));
    for (const item of (catalog.stockTransferItems ?? []).filter((i) => i.transferId === transfer.id)) {
      const qty = received.get(item.productId) ?? Number(item.approvedQty ?? item.requestedQty);
      add(transfer.fromShopId, item.productId, -qty);
      add(transfer.toShopId, item.productId, qty);
    }
  }
  return effect;
}

/** The ledger of unresolved effects, by entry (see the policy above). */
export async function pendingStockLedger(movementsInState: InventoryMovement[] = [], catalog: StockCatalog = {}): Promise<StockLedger> {
  const ledger: StockLedger = { byEntry: new Map(), pendingConfirmation: new Map(), doubtful: new Set() };
  let entries: SyncOutboxEntry[];
  try {
    entries = (await localDb.syncOutbox.where("status").anyOf([...COUNTED_STATUSES, "conflict"]).toArray())
      .filter((e) => e.status !== "conflict" || heldForConfirmation(e));
  } catch (err) {
    throw new StockLedgerUnavailableError(`The sync queue could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
  entries = entries.filter((e) => !wasRefused(e));
  if (entries.length === 0) return ledger;

  const movementIds = new Set<string>();
  for (const entry of entries) {
    for (const ref of entry.provisional ?? []) if (ref.table === "movements") ref.ids.forEach((id) => movementIds.add(id));
  }
  const byId = new Map<string, InventoryMovement>();
  if (movementIds.size) {
    try {
      for (const m of await localDb.movements.bulkGet([...movementIds])) if (m) byId.set(m.id, m);
    } catch (err) {
      throw new StockLedgerUnavailableError(`Queued stock movements could not be read (${err instanceof Error ? err.message : String(err)}).`);
    }
    for (const m of movementsInState) if (movementIds.has(m.id) && !byId.has(m.id)) byId.set(m.id, m);
  }

  for (const entry of entries) {
    const ids = (entry.provisional ?? []).filter((r) => r.table === "movements").flatMap((r) => r.ids);
    let effect: Map<string, number>;
    const missing = ids.filter((id) => !byId.has(id));
    if (ids.length && missing.length === 0) {
      effect = new Map();
      for (const id of ids) {
        const m = byId.get(id)!;
        const key = inventoryKey(m.shopId, m.productId);
        effect.set(key, (effect.get(key) ?? 0) + m.qtyChange);
      }
    } else if (entry.kind === "rpc" && DERIVABLE.has(entry.name)) {
      effect = stockEffectOfArgs(entry, catalog);
      if (effect.size === 0 && (ids.length > 0 || entry.name === "receive_stock_transfer")) {
        // Movements gone and the arguments do not say enough (e.g. the
        // transfer's lines are not on this till): the effect is unknown.
        throw new StockLedgerUnavailableError(`The stock effect of a queued ${entry.name} could not be established.`);
      }
    } else if (ids.length) {
      // An operation that only ADDS stock (receipts): counting nothing
      // understates — safe — but say so when it was supposed to be there.
      console.warn(`[sync] ${entry.name}: ${missing.length} provisional movement(s) missing; its stock increase is not shown.`);
      continue;
    } else {
      continue;
    }
    if (effect.size === 0) continue;
    const doubt = decreasesOnly(entry);
    const counted = new Map<string, number>();
    for (const [key, delta] of effect) {
      if (doubt && delta > 0) continue; // an unconfirmed increase is not counted
      counted.set(key, delta);
      if (doubt) ledger.pendingConfirmation.set(key, (ledger.pendingConfirmation.get(key) ?? 0) - delta);
    }
    if (counted.size) ledger.byEntry.set(entry.localId, counted);
    if (doubt && counted.size) ledger.doubtful.add(entry.localId);
  }
  return ledger;
}

/** Σ over entries, per key. */
export function sumLedger(byEntry: Map<string, Map<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const effect of byEntry.values()) for (const [key, delta] of effect) out.set(key, (out.get(key) ?? 0) + delta);
  return out;
}

/** Net unresolved stock effect per (shop, product) — the policy above, summed. */
export async function pendingStockDeltas(movementsInState: InventoryMovement[] = [], catalog: StockCatalog = {}): Promise<Map<string, number>> {
  return sumLedger((await pendingStockLedger(movementsInState, catalog)).byEntry);
}
