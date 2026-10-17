import type { Inventory, InventoryMovement } from "../../types";
import { localDb } from "../../lib/localDb";
import { inventoryKey } from "./pendingStock";

// ----------------------------------------------------------------------
// The per-entry ledger of unresolved stock effects this till has baked into
// the displayed inventory rows (Batch 2A, D-NEW-1). Owned by the inventory
// slice; shared here so every writer of server stock rows (sale, purchase,
// transfer, adjustment replies) keeps the invariant
//
//     displayed row = confirmed server row + Σ applied[entry][row]
//
// An entry's effect is applied once and released once:
//  - an acknowledged entry's server reply releases exactly its own effect
//    (`serverStockRows(rows, ackId)` — the entry is named explicitly; there
//    is no ambient "current acknowledgement");
//  - a refused / set-aside entry is released by the next recompute.
//
// Correction pass (review findings P1/P2 and the load/refresh races):
//  - a reply is never allowed to RAISE the displayed stock (a reply may be
//    older than a live event already shown, and until migration 086 there
//    is no commit time to compare); a reload of the shop is requested so
//    the exact figure comes back;
//  - releases and stagings are logged with a sequence number, so a reader
//    whose queue snapshot predates them (recompute, reload, full load) can
//    neither resurrect a released entry nor drop a newly staged one;
//  - the ledger is persisted with every mirror write of inventory rows, in
//    the SAME IndexedDB transaction, so after a crash the mirror's rows and
//    the ledger describing them always belong together.
// ----------------------------------------------------------------------

export type LedgerMap = Map<string, Map<string, number>>;

let applied: LedgerMap = new Map();

export const rowKey = (r: { shopId: string; productId: string }): string => inventoryKey(r.shopId, r.productId);

export function appliedLedger(): LedgerMap {
  return applied;
}

/** Replace the applied ledger. Released entries are never (re)admitted. */
export function setAppliedLedger(next: LedgerMap): void {
  applied = withoutReleased(next);
}

/** Σ of the applied effects for one row, optionally without one entry. */
export function appliedFor(key: string, without?: string | null): number {
  let total = 0;
  for (const [entry, effect] of applied) if (entry !== without) total += effect.get(key) ?? 0;
  return total;
}

// ---- release / staging log ------------------------------------------------

export interface LedgerEvent {
  seq: number; type: "staged" | "released"; localId: string; effect: Map<string, number>;
  /** Rows a release's reply wrote (their server figure moved). */
  keys?: string[];
}
let seq = 0;
let log: LedgerEvent[] = [];
const released = new Set<string>();
const LOG_LIMIT = 2000;

const pushEvent = (event: Omit<LedgerEvent, "seq">): void => {
  seq += 1;
  log.push({ ...event, seq });
  if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
};

/** A reader's marker: events after it happened while the reader was reading. */
export function markStockRead(): number {
  return seq;
}

export function eventsSince(marker: number): LedgerEvent[] {
  return log.filter((e) => e.seq > marker);
}

export function isReleased(localId: string): boolean {
  return released.has(localId);
}

export function withoutReleased(ledger: LedgerMap): LedgerMap {
  if (released.size === 0) return ledger;
  return new Map([...ledger].filter(([entry]) => !released.has(entry)));
}

/** Record a local staging's effect (the inventory slice applies the rows). */
export function noteStaged(localId: string, effect: Map<string, number>): void {
  if (released.has(localId)) return;
  applied.set(localId, effect);
  pushEvent({ type: "staged", localId, effect });
}

/** Release an acknowledged entry's effect (it is now inside the server rows). */
export function releaseEntry(localId: string, keys: string[] = []): void {
  const effect = applied.get(localId) ?? new Map<string, number>();
  applied.delete(localId);
  released.add(localId);
  pushEvent({ type: "released", localId, effect, keys: [...new Set([...effect.keys(), ...keys])] });
}

// ---- access the inventory slice registers ----------------------------------

interface StockAccess {
  /** The displayed quantity for a row, or undefined when there is none. */
  currentQty: (key: string) => number | undefined;
  /** Every displayed row's quantity, by key. */
  snapshot: () => Map<string, number>;
  /** Re-read the authoritative rows for a shop (coalesced by the owner). */
  requestRefresh: (shopId: string) => void;
  /** Write rows to the mirror together with the ledger (one transaction). */
  commit: (rows: Inventory[]) => Promise<void>;
}
let access: StockAccess | null = null;

export function registerStockAccess(next: StockAccess): void {
  access = next;
}

const pendingCommits = new Map<string, Promise<void>>();

/**
 * Server rows from a reply, as they must be displayed: + the effects of
 * every OTHER unresolved entry, and never above what is displayed now
 * (understate, never oversell; a shop reload is requested to restore the
 * exact figure). `ackId` is the outbox entry this reply acknowledges — its
 * own effect is released; null for an operation that was never queued.
 * The rows are mirrored with the ledger; `flushStockCommit(ackId)` awaits
 * that write (the drain does, BEFORE deleting the entry).
 */
export function serverStockRows(rows: Inventory[] | null | undefined, ackId: string | null): Inventory[] {
  if (!rows?.length) {
    if (ackId) releaseEntry(ackId);
    return [];
  }
  const refresh = new Set<string>();
  const shown = rows.map((r) => {
    const key = rowKey(r);
    let qty = r.qtyBaseUnits + appliedFor(key, ackId);
    const current = access?.currentQty(key);
    if (current !== undefined && current !== qty) {
      // Possibly an older reply (or the till holds a newer event): never
      // raise; a lower server figure is taken at once. Either way confirm
      // the exact figure with a reload.
      if (current < qty) qty = current;
      refresh.add(r.shopId);
    }
    return { ...r, qtyBaseUnits: qty };
  });
  if (ackId) releaseEntry(ackId, shown.map(rowKey));
  const commit = access ? access.commit(shown) : Promise.resolve();
  if (ackId) {
    const tracked = commit.finally(() => {
      if (pendingCommits.get(ackId) === tracked) pendingCommits.delete(ackId);
    });
    pendingCommits.set(ackId, tracked);
  }
  for (const shopId of refresh) access?.requestRefresh(shopId);
  return shown;
}

/** Wait until the stock rows of `ackId`'s reply are on disk with the ledger.
 *  Rejects if that write failed (the caller then keeps the entry). */
export async function flushStockCommit(ackId: string): Promise<void> {
  await pendingCommits.get(ackId);
}

/** Effect of a set of staged movements, per row. */
export function effectOfMovements(movements: Pick<InventoryMovement, "shopId" | "productId" | "qtyChange">[]): Map<string, number> {
  const effect = new Map<string, number>();
  for (const m of movements) effect.set(rowKey(m), (effect.get(rowKey(m)) ?? 0) + m.qtyChange);
  return effect;
}

// ---- persistence --------------------------------------------------------------

export const LEDGER_STATE_KEY = "stock-applied-ledger";

export function serializeLedger(ledger: LedgerMap = applied): string {
  return JSON.stringify(Object.fromEntries([...ledger].map(([entry, effect]) => [entry, Object.fromEntries(effect)])));
}

export function parseLedger(value: string | undefined): LedgerMap | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Record<string, Record<string, number>>;
    return new Map(Object.entries(raw).map(([entry, effect]) => [entry, new Map(Object.entries(effect).map(([k, d]) => [k, Number(d)]))]));
  } catch {
    return null;
  }
}

/** Write the ledger inside the caller's transaction (it must include syncState). */
export async function putLedgerInTransaction(ledger: LedgerMap = applied): Promise<void> {
  await localDb.syncState.put({ key: LEDGER_STATE_KEY, value: serializeLedger(withoutReleased(ledger)), updatedAt: new Date().toISOString() });
}

export async function readPersistedLedger(): Promise<LedgerMap | null> {
  const row = await localDb.syncState.get(LEDGER_STATE_KEY);
  return parseLedger(row?.value);
}

// ---- staging hook ---------------------------------------------------------------

type StagedHook = (localId: string, movements: InventoryMovement[], before: Map<string, number>) => void;
let stagedHook: StagedHook | null = null;

/** The inventory slice registers how a local staging is recorded. */
export function registerStagedStockHook(hook: StagedHook): void {
  stagedHook = hook;
}

/** The displayed rows just before a staging is applied (see noteStagedStock). */
export function snapshotStock(): Map<string, number> {
  return access?.snapshot() ?? new Map();
}

/**
 * Called by the write-ahead engine after a staging is committed and applied.
 * `before` is the displayed rows taken just before its updaters ran: the
 * staging computed its absolute quantities from an earlier read, so the
 * touched rows are re-based on `before` (a recompute or a live event may
 * have moved them meanwhile).
 */
export function noteStagedStock(localId: string, movements: InventoryMovement[], before: Map<string, number>): void {
  stagedHook?.(localId, movements, before);
}

/**
 * Inside persistStaged's transaction (which must include inventory and
 * syncState): re-base the staged inventory rows on the MIRROR's current rows
 * (+ this entry's effect − what it already had applied) and persist the
 * ledger with them. The staging's own absolute figures were computed from
 * an earlier in-memory read and may be stale.
 */
export async function stagedStockInTransaction(localId: string, inventory: Inventory[], movements: InventoryMovement[]): Promise<void> {
  const effect = effectOfMovements(movements);
  const previous = applied.get(localId) ?? new Map<string, number>();
  const keys = new Set([...effect.keys(), ...previous.keys(), ...inventory.map(rowKey)]);
  const out: Inventory[] = [];
  for (const key of keys) {
    const staged = inventory.find((r) => rowKey(r) === key);
    const [shopId, productId] = key.split("|");
    const mirror = await localDb.inventory.get([shopId, productId]);
    if (mirror) {
      out.push({ ...mirror, qtyBaseUnits: mirror.qtyBaseUnits + (effect.get(key) ?? 0) - (previous.get(key) ?? 0) });
    } else if (staged) {
      out.push(staged);
    }
  }
  if (out.length) await localDb.inventory.bulkPut(out);
  const next = new Map(applied);
  next.set(localId, effect);
  await putLedgerInTransaction(next);
}

// ---- fail closed ------------------------------------------------------------------

let unverified = false;

/** Set by the inventory slice when the queue's stock effects cannot be read. */
export function setStockUnverified(value: boolean): void {
  unverified = value;
}

/** Throws when safe available stock cannot be established on this till. */
export function assertStockKnown(): void {
  if (unverified) {
    throw new Error("Stock on this till cannot be verified right now (its sync queue could not be read). Offline sales and adjustments are paused until it can.");
  }
}

/** Tests only. */
export function resetStockLedgerForTests(): void {
  unverified = false;
  applied = new Map();
  log = [];
  seq = 0;
  released.clear();
  pendingCommits.clear();
}
