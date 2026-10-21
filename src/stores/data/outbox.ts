import { supabase } from "../../lib/supabase";
import { requireRecoveryV1Write } from "../../recovery/client";
import { uuidV7TimeMs } from "../../lib/executorRpcs";
import { mayDepend, type DependencyContext, type DependencySubject } from "./dependencies";
import { belongsToBackend, currentBackendOrigin, quarantineForeignOutboxEntries } from "../../lib/backendOrigin";
import { localDb, RECONCILE_LOG_PREFIX, SYNC_STATE_KEYS, type SyncOutboxEntry } from "../../lib/localDb";
import { newId } from "../../lib/id";
import { isNetworkError } from "../../lib/errors";
import { classifyFailure, holdBackoffMs } from "../../lib/failureClass";
import { isPrimaryKeyDuplicate, runTableWrite } from "./tableWrite";
import {
  callRpc, currentActorId, IDEMPOTENCY_KEY_ARG, LEGACY_OPERATION, legacyOperationError, lookupOperation, newIdempotencyKey, RPC_TIMEOUT_MS,
  RpcError, setActorSource, stampOperationArgs, v87Routing, type RpcOutcome,
} from "./idempotentRpc";
import { recoveryCodeOf } from "../../lib/failureClass";
import {
  currentOpEpoch, offlineFinancialBlockedError, offlineFinancialOpsBlocked, recoveryBlocksSending, recoveryCapability, recoveryMessage, recoveryView,
  setRecoveryOrgSource, verifiedSinceStart,
} from "./recoveryState";
import { runRecoveryCheck } from "./recovery87";
import { replyProblem } from "./replyShapes";
import { flushStockCommit, releaseEntry, stagedStockInTransaction } from "./stockLedger";
import { deleteLocalRows, localRowTables, putLocalRowsInTransaction, recordCommittedPut, type LocalRowBatch } from "./localWrites";
import { verifiedReload } from "./verifiedReload";
import { lastQueueExportAt } from "../../lib/queueExport/exportRecord";
import type { Inventory, InventoryMovement } from "../../types";
import { useAuthStore } from "../authStore";
import { useSyncStore } from "../syncStore";
import { touchAuthCache } from "../authCache";
import {
  continuityWarning, journalCommitted, journalDecided, journalOwner, journalQueued, journalReconciliationRequired, journalRecoveryRefusal, journalRowChanged,
  journalSent, type JournalEvidence,
} from "./opJournal";

// The acting user for p_expected_actor_id (idempotentRpc.stampOperationArgs).
setActorSource(() => useAuthStore.getState().currentUserId ?? null);
// 087: recovery state applies only to the organisation it was loaded for (recoveryState.ts).
setRecoveryOrgSource(() => useAuthStore.getState().currentOrgId ?? null);

type EnqueueInput = Pick<
  SyncOutboxEntry,
  "kind" | "name" | "args" | "shopId" | "provisional" | "refs" | "table" | "op" | "row" | "id" | "idempotencyKey" | "opEpoch"
>;

// Queue position, assigned inside the enqueue transaction. `createdAt` has
// millisecond precision, so two entries queued in the same tick (a shift
// opened and the first sale rung up against it) tie on it — and the
// dependent one could be drained first. `seq` is the authoritative order;
// createdAt is display/age only. Stored on the row (Dexie keeps undeclared
// fields; it's never indexed — the queue is read whole and sorted in memory).
type OutboxRow = SyncOutboxEntry & { seq?: number };

/** Oldest-first by queue position. Entries written before `seq` existed
 *  (none in production yet) sort first, by createdAt then id. */
export const byQueueOrder = (a: OutboxRow, b: OutboxRow): number => {
  if (a.seq != null && b.seq != null) return a.seq - b.seq;
  if (a.seq == null && b.seq == null) {
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.localId.localeCompare(b.localId);
  }
  return a.seq == null ? -1 : 1;
};

/** G1 Stage 1: an operation whose outcome is unknown and that was never
 *  authorised offline is HELD as status "conflict" + fenceRequired — a
 *  status no older build ever sends automatically (downgrade safety). This
 *  build still processes it: by lookup + fence, never by resending. */
const isHeldRecovery = (e: SyncOutboxEntry): boolean => e.status === "conflict" && e.fenceRequired === true && !e.serverOutcome;
/** A conflict the server has not decided: never sent automatically, but it
 *  keeps the head of the queue until a person retries or sets it aside. */
const isBlockingConflict = (e: SyncOutboxEntry): boolean =>
  e.status === "conflict" && e.blocksQueue === true && !e.serverOutcome && e.fenceRequired !== true;

async function pendingInQueueOrder(): Promise<OutboxRow[]> {
  const rows = (await localDb.syncOutbox.where("status").anyOf("pending", "failed", "conflict").toArray()) as OutboxRow[];
  return rows.filter((r) => r.status !== "conflict" || isHeldRecovery(r) || isBlockingConflict(r)).sort(byQueueOrder);
}

/** Unsent work of THIS backend that could still change server state — the
 *  entries being sent right now ("syncing") included; the only bypassable
 *  entry (committed, reply unreadable here) excluded. */
async function unsentWork(): Promise<OutboxRow[]> {
  const origin = currentBackendOrigin();
  const syncing = (await localDb.syncOutbox.where("status").equals("syncing").toArray()) as OutboxRow[];
  return [...(await pendingInQueueOrder()), ...syncing].filter((r) => belongsToBackend(r, origin) && !isParked(r));
}

/** How ids compare in dependency checks (final ordering pass): an id this
 *  till created offline is compared under its SERVER id once the verified
 *  mapping exists (provisionalIdMap — written when its creating entry was
 *  acknowledged); an offline id still unmapped (it appears in a queued
 *  entry's provisional records, or in a ref) stands for ANY id, so it can
 *  never prove independence. Whose shift it is comes from the till's shift
 *  rows (under either id). Stored arguments are never rewritten. */
async function dependencyContext(): Promise<DependencyContext> {
  const [maps, rows, shifts, exportMark] = await Promise.all([
    localDb.provisionalIdMap.toArray(),
    localDb.syncOutbox.toArray(),
    localDb.shifts.toArray(),
    localDb.syncState.get(SYNC_STATE_KEYS.lastQueueExport).catch(() => null),
  ]);
  const real = new Map(maps.map((m) => [m.provisionalId, m.realId]));
  const unmapped = new Set<string>();
  // An offline id whose creating entry was PROVABLY never sent to this
  // backend (still queued here, no attempt, never stamped as sent, not in
  // doubt, not being sent) cannot be any server record yet: it is compared as
  // itself ("local:<id>") instead of "any id" — e.g. another cashier's close of
  // a server-known shift does not wait for sales on a shift that does not
  // exist on the server yet. Any doubt keeps the wildcard: an entry queued
  // before the last queue export (it may have been replayed elsewhere with
  // the recovery tool), or an id that any sent row also lists.
  const neverSent = new Set<string>();
  const sentIds = new Set<string>();
  const origin = currentBackendOrigin();
  const marks = [typeof exportMark?.value === "string" ? exportMark.value : null, lastQueueExportAt()].filter((m): m is string => !!m).sort();
  const exportedUpTo = marks.at(-1) ?? null;
  for (const r of rows) {
    if (r.status === "reconciled") continue;
    const unsentHere = (r.status === "pending" || r.status === "failed") && (r.attempts ?? 0) === 0 && !r.sentAt
      && r.inDoubt !== true && r.fenceRequired !== true && belongsToBackend(r, origin)
      && !(exportedUpTo && !(r.createdAt > exportedUpTo));
    for (const p of r.provisional ?? []) for (const id of p.ids) {
      if (real.has(id)) continue;
      unmapped.add(id);
      (unsentHere ? neverSent : sentIds).add(id);
    }
    for (const ref of r.refs ?? []) if (!real.has(ref.provisionalId)) unmapped.add(ref.provisionalId);
  }
  for (const id of sentIds) neverSent.delete(id);
  const cashier = new Map<string, string>();
  for (const sh of shifts) {
    if (!sh?.id || !sh.cashierId) continue;
    cashier.set(sh.id, sh.cashierId);
    const mapped = real.get(sh.id);
    if (mapped) cashier.set(mapped, sh.cashierId);
  }
  return {
    resolve: (id) => real.get(id) ?? (neverSent.has(id) ? `local:${id}` : unmapped.has(id) ? "*" : id),
    shiftCashier: (id) => cashier.get(id) ?? null,
  };
}

/** Earlier unsent entries an operation about to be sent ONLINE might depend
 *  on (dependencies.ts — anything not proven independent). It must never
 *  overtake them: queued behind them, or refused (shared-till pass). */
export async function blockingEarlierWork(subject: DependencySubject): Promise<SyncOutboxEntry[]> {
  const [work, ctx] = await Promise.all([unsentWork(), dependencyContext()]);
  return work.filter((r) => mayDepend(subject, r, ctx));
}

/** Any unsent work at all (diagnostics / tests). */
export async function queueHasUnsentWork(): Promise<boolean> {
  return (await unsentWork()).length > 0;
}

/** The entry is waiting for its creator (another app user). */
const ownedByOther = (entry: SyncOutboxEntry, me: string | null): boolean => {
  const owner = entry.kind === "rpc" ? actorOf(entry) : null;
  return Boolean(owner && me && owner !== me);
};

/** A ref whose creating entry can never succeed any more: set aside,
 *  reconciled, quarantined or decided (refused / stopped) — or gone without
 *  leaving the real id. The waiting entry can never resolve it. */
async function deadParent(entry: SyncOutboxEntry): Promise<boolean> {
  for (const ref of entry.refs ?? []) {
    if (await localDb.provisionalIdMap.get(ref.provisionalId)) continue;
    const parent = await localDb.syncOutbox.filter((r) => (r.provisional ?? []).some((p) => p.ids.includes(ref.provisionalId))).first();
    if (!parent) return true;
    if (parent.status === "archived" || parent.status === "reconciled" || parent.status === "quarantined" || parent.serverOutcome) return true;
  }
  return false;
}


/**
 * Queue a mutation for replay. RPC entries always carry an idempotency key
 * (the caller's, minted when the operation was created — or a fresh one
 * for legacy callers), stored both on the entry and inside `args` as
 * `p_idempotency_key` so the replay payload is exactly what gets sent.
 */
export async function enqueueOutbox(entry: EnqueueInput): Promise<void> {
  // v87.x: this queues a NEW operation for later — never on an 087 server (rows already queued are not touched)
  if (offlineFinancialOpsBlocked()) throw offlineFinancialBlockedError("It cannot be queued for later on this server.");
  const row = buildOutboxRow(entry);
  // The read-max + put run in one transaction so two enqueues cannot be
  // handed the same seq.
  await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
    await putWithSeq(row);
    await journalQueued(row);   // the till's evidence, in the same transaction (W8 Phase 0)
  });
  void refreshSyncStatus();
  notifyQueueChanged(row);
}

/** A new outbox row for `entry` (key and actor stamped by the shared rule). */
export function buildOutboxRow(entry: EnqueueInput, overrides: Partial<SyncOutboxEntry> = {}): OutboxRow {
  let args = entry.args;
  let idempotencyKey = entry.idempotencyKey;
  if (entry.kind === "rpc") {
    const existing = args?.[IDEMPOTENCY_KEY_ARG];
    idempotencyKey = idempotencyKey ?? (typeof existing === "string" ? existing : newIdempotencyKey());
    // The same rule the online call uses (idempotentRpc.stampOperationArgs).
    args = stampOperationArgs(entry.name, { ...(args ?? {}), [IDEMPOTENCY_KEY_ARG]: idempotencyKey }, idempotencyKey);
  }
  return {
    ...entry,
    args,
    idempotencyKey,
    // Who created the operation (086 recovery: only that user, or an
    // administrator, may resolve it on the server).
    actorId: currentActorId(),
    orgId: useAuthStore.getState().currentOrgId ?? null,
    // Which backend this entry is for (blocker D-d): the drain sends it only
    // to this origin; anywhere else it is quarantined (lib/backendOrigin.ts).
    backendOrigin: currentBackendOrigin(),
    // 087: the epoch the operation is created under — the caller's (stamped at
    // beginOperation) or, for a write created right here, the current one.
    // Never re-stamped later (a requeue keeps its row's own value).
    opEpoch: "opEpoch" in entry ? entry.opEpoch ?? null : currentOpEpoch(),
    localId: newId("outbox"),
    createdAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    ...overrides,
  };
}

async function putWithSeq(row: OutboxRow): Promise<void> {
  const existing = (await localDb.syncOutbox.toArray()) as OutboxRow[];
  row.seq = existing.reduce((max, e) => Math.max(max, e.seq ?? 0), 0) + 1;
  await localDb.syncOutbox.put(row);
}

/**
 * Commit one operation durably and atomically (Batch 2A): its local rows
 * (provisional sale, items, movements, stock, …) and its outbox row — a new
 * one (`put`) or the conversion of the operation's write-ahead row
 * (`update`) — in ONE IndexedDB transaction. Either all of it is on disk or
 * none of it is; there is no window where stock moved locally but nothing
 * will ever sync it, or the reverse. Rejects (nothing written) on failure.
 */
export async function persistStaged(
  rows: LocalRowBatch[],
  outbox: { put: OutboxRow } | { update: { localId: string; changes: Partial<SyncOutboxEntry> } },
): Promise<void> {
  const localId = "put" in outbox ? outbox.put.localId : outbox.update.localId;
  const stockRows = rows.flatMap((r) => (r.inventory ?? []) as Inventory[]);
  const stockMoves = rows.flatMap((r) => (r.movements ?? []) as InventoryMovement[]);
  const touchesStock = stockRows.length > 0 || stockMoves.length > 0;
  const tables = new Set([
    localDb.syncOutbox, localDb.syncState, ...rows.flatMap((r) => localRowTables(r)),
    ...(touchesStock ? [localDb.inventory] : []),
  ]);
  await localDb.transaction("rw", [...tables], async () => {
    for (const batch of rows) await putLocalRowsInTransaction(batch);
    // Stock rows are re-based on the mirror and written WITH the ledger
    // that describes them (crash-safe pair — stockLedger.ts).
    if (touchesStock) await stagedStockInTransaction(localId, stockRows, stockMoves);
    if ("put" in outbox) {
      await putWithSeq(outbox.put);
      await journalQueued(outbox.put);
    } else {
      const updated = await localDb.syncOutbox.update(outbox.update.localId, outbox.update.changes);
      if (updated !== 1) throw new Error("The operation's queue record is missing; nothing was saved.");
      const row = await localDb.syncOutbox.get(outbox.update.localId);
      if (row) await journalRowChanged(row, row.fenceRequired === true ? "held-outcome-unknown" : row.inDoubt === true ? "outcome-unknown" : "not-delivered-queued");
    }
  });
  // Only now, committed: a running full load re-applies these rows.
  for (const batch of rows) recordCommittedPut(batch);
  void refreshSyncStatus();
  notifyQueueChanged();
}

// ----------------------------------------------------------------------
// Write-ahead rows in flight (an online attempt of THIS instance is waiting
// for its reply). Never recovered as "stranded", never sent by the drain,
// and the drain holds while one exists so a queued entry cannot overtake an
// operation still in flight (plan v2 §5.1 rule 6).
// ----------------------------------------------------------------------
const inFlightWriteAhead = new Set<string>();
// Cross-window guard (web build — Electron runs one window): a Web Lock per
// in-flight row, held for the duration of the attempt. Another window's
// startup recovery and drain skip rows whose lock is held, so they cannot
// resend a request this window is still waiting on (review finding P5).
const WA_LOCK_PREFIX = "orvix-wa:";
const heldLocks = new Map<string, () => void>();

type FullLockManager = {
  request: (name: string, callback: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
  query?: () => Promise<{ held?: { name?: string }[] }>;
};
const fullLockManager = (): FullLockManager | null => {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: FullLockManager }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
};

export function markWriteAheadInFlight(localId: string): Promise<void> {
  inFlightWriteAhead.add(localId);
  const locks = fullLockManager();
  if (!locks) return Promise.resolve();
  return new Promise<void>((acquired) => {
    void locks.request(WA_LOCK_PREFIX + localId, () => new Promise<void>((release) => {
      heldLocks.set(localId, release);
      acquired();
    })).catch(() => acquired());
  });
}

export function clearWriteAheadInFlight(localId: string): void {
  inFlightWriteAhead.delete(localId);
  heldLocks.get(localId)?.();
  heldLocks.delete(localId);
}

/** Rows some window of this profile is still sending (Web Locks), plus ours. */
async function rowsInFlightAnywhere(): Promise<Set<string>> {
  const ids = new Set(inFlightWriteAhead);
  const locks = fullLockManager();
  if (locks?.query) {
    try {
      const state = await locks.query();
      for (const l of state.held ?? []) if (l.name?.startsWith(WA_LOCK_PREFIX)) ids.add(l.name.slice(WA_LOCK_PREFIX.length));
    } catch {
      // unknown: fall back to this window's own set
    }
  }
  return ids;
}

export function writeAheadInFlightCount(): number {
  return inFlightWriteAhead.size;
}

/** Tests only: behave like a freshly started app instance (no attempt of
 *  "this" instance is in flight; the next drain is the startup pass). */
export function simulateNewAppInstanceForTests(): void {
  inFlightWriteAhead.clear();
  startupRecoveryDone = false;
  draining = false;   // a new process has no drain running (a hung one died with the old one)
}

/**
 * The ONE exception to "only a confirmed success deletes an outbox row"
 * (B-24), approved as D-10(a): an online attempt the server DEFINITIVELY
 * refused at the counter (the cashier sees the error, nothing was charged)
 * leaves no record. Guarded so it can never remove anything else: the row
 * must be a write-ahead row of an attempt of THIS instance that is still in
 * flight and still `syncing` — never a queued, conflicted, quarantined, set
 * aside or reconciled entry. Throws (and deletes nothing) otherwise.
 */
export async function discardWriteAhead(
  localId: string, reason: string,
  evidence: { serverOutcome?: "rejected" | "abandoned" | "mismatch" | "committed" | null; code?: string | null; message?: string | null } = {},
): Promise<void> {
  if (!inFlightWriteAhead.has(localId)) throw new Error(`Refusing to discard ${localId}: not an in-flight write-ahead attempt of this instance.`);
  await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
    const row = await localDb.syncOutbox.get(localId);
    if (!row) return;
    if (row.writeAhead !== true || row.status !== "syncing") {
      throw new Error(`Refusing to discard ${localId}: status ${row.status}, writeAhead ${String(row.writeAhead)}.`);
    }
    // The queue row goes (D-10(a)); the journal keeps what the server said.
    if (evidence.serverOutcome === "mismatch") {
      // the server holds ANOTHER decision under this key: it may have been applied
      await journalReconciliationRequired(row, `discarded at the counter: the server holds a different request under this key (${reason})`);
      await localDb.syncOutbox.delete(localId);
      return;
    }
    const state = reason === "REJECTED" || reason === "CONTRACT" ? "rejected" : reason === "ABANDONED" ? "abandoned" : "not-applied";
    await journalDecided(row, state, {
      source: reason === "offline-path-refused" || reason === "offline-disabled-087" ? "client" : "reply",
      code: evidence.code ?? null, message: evidence.message ? evidence.message.slice(0, 500) : null,
      recordedOnServer: evidence.serverOutcome === "rejected" || evidence.serverOutcome === "abandoned",
    }, `discarded at the counter: ${reason}`);
    await localDb.syncOutbox.delete(localId);
  });
  console.info(`[sync] wal-discarded:${localId}:${reason}`);
  void refreshSyncStatus();
  notifyQueueChanged();
}

/** Record that a provisional (offline-minted) id turned out to be `realId`
 *  once its outbox entry synced — called by reconcilers for anything a
 *  later-queued entry might reference (e.g. reconcileOpenShift). */
export async function recordIdMapping(provisionalId: string, realId: string): Promise<void> {
  if (provisionalId === realId) return;
  const mapping = { provisionalId, realId, createdAt: new Date().toISOString() };
  // Inside a drain acknowledgement the mapping is committed together with
  // the removal of the entry that produced it (acknowledgeEntry): a crash
  // can never leave the entry gone and its mapping unwritten, which would
  // strand every entry that references the provisional id.
  if (mappingCapture) {
    mappingCapture.push(mapping);
    return;
  }
  await localDb.provisionalIdMap.put(mapping);
}

type IdMapping = { provisionalId: string; realId: string; createdAt: string };
let mappingCapture: IdMapping[] | null = null;

function beginMappingCapture(): void {
  mappingCapture = [];
}

function endMappingCapture(): IdMapping[] {
  const captured = mappingCapture ?? [];
  mappingCapture = null;
  return captured;
}

/** Acknowledge an operation: write its id mappings and delete its entry in
 *  ONE transaction. Exported for tests. */
export async function acknowledgeEntry(
  localId: string, mappings: IdMapping[],
  evidence: Omit<JournalEvidence, "at"> = { source: "reply" },
  signedReply?: { signed: unknown; sig: string } | null,
): Promise<void> {
  await localDb.transaction("rw", localDb.syncOutbox, localDb.provisionalIdMap, localDb.syncState, async () => {
    if (mappings.length) await localDb.provisionalIdMap.bulkPut(mappings);
    // W8 Phase 0: the queue row goes, the till's evidence of the committed
    // operation (key, request, the server's reply) stays — same transaction:
    // if the journal cannot be written, the row is NOT deleted (it is resent
    // with its key later and answered from the server's ledger).
    const row = await localDb.syncOutbox.get(localId);
    if (row) await journalCommitted(row, evidence, signedReply);
    await localDb.syncOutbox.delete(localId);
  });
}

// ----------------------------------------------------------------------
// Queue-change notifications (Batch 2A): stock display and the "pending
// confirmation" indicator depend on which entries are pending, sending, in
// doubt or gone, so they are recomputed whenever an entry changes state.
// ----------------------------------------------------------------------
type QueueListener = (entry?: SyncOutboxEntry) => void;
const queueListeners = new Set<QueueListener>();

export function onQueueChanged(listener: QueueListener): () => void {
  queueListeners.add(listener);
  return () => queueListeners.delete(listener);
}

export function notifyQueueChanged(entry?: SyncOutboxEntry): void {
  for (const listener of queueListeners) {
    try {
      listener(entry);
    } catch (err) {
      console.error("[sync] queue listener failed:", err);
    }
  }
}

export const PROVISIONAL_MAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Every provisional id an outbox entry may still need resolved: its `refs`
 *  (exactly what resolveArgs here and the recovery replay resolve) plus,
 *  defensively, any string anywhere in its payload. Collected over EVERY
 *  remaining row, whatever its status — pending, syncing, failed, conflict,
 *  quarantined and set aside alike — since all of them can still be
 *  exported and replayed. */
export function referencedProvisionalIds(rows: readonly SyncOutboxEntry[]): Set<string> {
  const ids = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === "string") ids.add(v);
    else if (depth < 8 && Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (depth < 8 && v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const row of rows) {
    for (const ref of row.refs ?? []) ids.add(ref.provisionalId);
    walk(row.args, 0);
    walk(row.row, 0);
  }
  return ids;
}

/** Low volume (one row per offline-created shift/sale/etc. that something
 *  else referenced), but otherwise unbounded — sweep out mappings older
 *  than a week that NO remaining outbox entry references (RC2, D3: a
 *  quarantined or set-aside entry can sit for weeks; its export must still
 *  resolve). RC3: a RECONCILED row no longer pins its mappings — the till
 *  never replays it, and its record keeps the refs as resolved when it was
 *  reconciled (`resolvedRefs`). A mapping any non-reconciled row still
 *  references is kept. One transaction, so an entry queued meanwhile is seen. */
export async function pruneProvisionalIdMap(now: number = Date.now()): Promise<number> {
  const cutoff = now - PROVISIONAL_MAP_MAX_AGE_MS;
  return localDb.transaction("rw", localDb.syncOutbox, localDb.provisionalIdMap, async () => {
    const referenced = referencedProvisionalIds((await localDb.syncOutbox.toArray()).filter((r) => r.status !== "reconciled"));
    const stale = (await localDb.provisionalIdMap.toArray())
      .filter((m) => Date.parse(m.createdAt) < cutoff && !referenced.has(m.provisionalId))
      .map((m) => m.provisionalId);
    if (stale.length) await localDb.provisionalIdMap.bulkDelete(stale);
    return stale.length;
  });
}

// ----------------------------------------------------------------------
// Stranded `syncing` entries (RC2, D2)
// ----------------------------------------------------------------------

/** A `syncing` row older than this is a request whose response never came
 *  back (the app quit, crashed or lost power mid-request): longer than the
 *  RPC timeout twice over plus the drain lease, so a live request of
 *  another instance is never touched. */
export const SYNCING_STALE_MS = 2 * RPC_TIMEOUT_MS + 2 * 60_000;

/**
 * Return stranded `syncing` entries to `pending`: with `olderThanMs: 0`
 * every one (startup — the first drain pass of this app instance, under
 * the drain lock, so no request of ours is in flight), otherwise those that
 * entered `syncing` longer ago than the threshold (a row with no
 * `syncingSince`, written before RC2, counts as old). The entry keeps its
 * payload and idempotency key — the resend is answered by the server's
 * idempotency ledger with the original result if the first attempt
 * committed — and its attempt counter goes up by one. Returns how many.
 */
export async function recoverStrandedSyncing(olderThanMs: number = SYNCING_STALE_MS, now: number = Date.now()): Promise<number> {
  const busy = await rowsInFlightAnywhere();
  const n = await localDb.transaction("rw", localDb.syncOutbox, localDb.shifts, localDb.stockTransfers, localDb.syncState, async () => {
    let n = 0;
    for (const entry of await localDb.syncOutbox.where("status").equals("syncing").toArray()) {
      // An online attempt of this (or another) window still waits for its reply.
      if (busy.has(entry.localId)) continue;
      const since = entry.syncingSince ? Date.parse(entry.syncingSince) : Number.NaN;
      if (olderThanMs > 0 && Number.isFinite(since) && now - since < olderThanMs) continue;
      // G1 Stage 1: a write-ahead row whose offline eligibility was never
      // established (its FIRST online attempt, or an older build's row with
      // nothing staged and no local proof) is never resent blindly: it is
      // held and the drain asks the server, fencing it if it never arrived.
      // One rule for every recovery path (offlineAuthorisation).
      const auth = await offlineAuthorisation(entry);
      entry.status = "pending";
      // The request was sent and no reply arrived: it may have committed.
      entry.inDoubt = true;
      if (auth === "never") holdForRecovery(entry);
      else if (entry.kind === "rpc" && entry.staged === undefined) entry.staged = true;   // keep the proof
      entry.attempts = (entry.attempts ?? 0) + 1;
      entry.failureKind = "transient";
      entry.lastError = auth === "never" ? NOT_YET_CONFIRMED_TEXT
        : "Interrupted while sending (no reply from the server). Resent with the same idempotency key, so it cannot be applied twice.";
      entry.nextAttemptAt = undefined;
      delete entry.syncingSince;
      await localDb.syncOutbox.put(entry);
      await journalRowChanged(entry, "interrupted-no-reply");
      n += 1;
    }
    return n;
  });
  if (n > 0) notifyQueueChanged();
  return n;
}

let startupRecoveryDone = false;

/** Text for an operation whose outcome is unknown and that this till never
 *  authorised offline. */
export const NOT_YET_CONFIRMED_TEXT =
  "Not recorded on this till: the server may or may not have received it. It is NEVER resent — the till asks the server " +
  "what happened to it. If the server has no record of it, it is NOT stopped automatically (the server may have been " +
  "restored from an older backup): it waits for an owner's decision.";

/** Batch 2A staged close_shift / dispatch_stock_transfer with no provisional
 *  rows: the staging wrote the operation's own key onto the local shift /
 *  transfer row. That row is proof the operation was authorised offline —
 *  while it survives (a later full load replaces it with the server's). */
async function stagedWithoutProvisional(entry: SyncOutboxEntry): Promise<boolean> {
  const key = entry.idempotencyKey;
  if (!key) return false;
  if (entry.name === "close_shift" && typeof entry.args?.p_shift_id === "string") {
    const shift = await localDb.shifts.get(entry.args.p_shift_id);
    return shift?.idempotencyKey === key && Boolean(shift.endedAt);
  }
  if (entry.name === "dispatch_stock_transfer" && typeof entry.args?.p_transfer_id === "string") {
    const transfer = await localDb.stockTransfers.get(entry.args.p_transfer_id);
    return transfer?.idempotencyKey === key && Boolean(transfer.dispatchedAt);
  }
  return false;
}

/**
 * Deployment-blocker pass: ONE rule for whether an RPC entry was authorised
 * offline — used by startup classification, stranded-attempt recovery,
 * Retry, Restore and Confirm with server alike (and mirrored by the
 * emergency recovery tool, which cannot see the local shift / transfer rows).
 *  - held (`fenceRequired`) or refused offline (`staged: false`): never;
 *  - `staged: true`, or not write-ahead (queued offline): authorised;
 *  - a write-ahead row in its FIRST attempt while being sent (this build's
 *    own interrupted online attempt): never established -> never;
 *  - staged records, or (Batch 2A close / dispatch) the local row carrying
 *    the operation's own key: authorised;
 *  - otherwise in doubt / being sent with nothing staged: never; else (never
 *    sent, nothing in doubt) authorised.
 * Must run inside a transaction covering syncOutbox, shifts and stockTransfers
 * when used to rewrite an entry.
 */
export async function offlineAuthorisation(entry: SyncOutboxEntry): Promise<"authorised" | "never"> {
  if (entry.kind !== "rpc") return "authorised";
  if (entry.fenceRequired === true || entry.staged === false) return "never";
  if (entry.staged === true || entry.writeAhead !== true) return "authorised";
  const sending = entry.status === "syncing" || entry.statusBeforeArchive === "syncing";
  // A write-ahead row with no staged flag and NO attempt recorded is a first
  // online attempt (every build records attempts: 1 when an attempt falls
  // back to the queue) — whatever its status now (e.g. a Retry moved it).
  if ((entry.attempts ?? 0) === 0) return "never";
  if ((entry.provisional?.length ?? 0) > 0 || (await stagedWithoutProvisional(entry))) return "authorised";
  return entry.inDoubt === true || sending ? "never" : "authorised";
}

/** Mark an entry (in a modify/transaction) as held for lookup + fence. */
function holdForRecovery(entry: SyncOutboxEntry): void {
  entry.fenceRequired = true;
  entry.staged = false;
  entry.status = "conflict";
  entry.inDoubt = true;
  entry.heldReason = "outcome-unknown";
  entry.failureKind = "transient";
  entry.lastError = NOT_YET_CONFIRMED_TEXT;
  entry.nextAttemptAt = undefined;
  delete entry.syncingSince;
}

/**
 * G1 Stage 1, once per entry: rows written by an older build carry no
 * `staged` flag. A queued offline operation (not write-ahead) was authorised
 * offline. A write-ahead row in doubt with nothing staged cannot prove it
 * was — it is held for lookup + fence and never resent. Identity (key,
 * arguments) is untouched. Returns how many were held.
 */
export async function classifyLegacyQueue(): Promise<number> {
  const n = await localDb.transaction("rw", localDb.syncOutbox, localDb.shifts, localDb.stockTransfers, localDb.syncState, async () => {
    let held = 0;
    const rows = await localDb.syncOutbox.where("status").anyOf("pending", "failed").toArray();
    for (const entry of rows) {
      if (entry.kind !== "rpc" || entry.staged !== undefined || entry.fenceRequired !== undefined) continue;
      if ((await offlineAuthorisation(entry)) === "authorised") {
        await localDb.syncOutbox.update(entry.localId, { staged: true });
      } else {
        holdForRecovery(entry);
        await localDb.syncOutbox.put(entry);
        await journalRowChanged(entry, "held-legacy-row");
        held += 1;
      }
    }
    return held;
  });
  if (n > 0) notifyQueueChanged();
  return n;
}

// Resolves an entry's `refs` against provisionalIdMap and returns the args
// to actually send — or null if a reference hasn't synced yet (e.g. a sale
// queued against a shift that was also opened offline and is still waiting
// its own turn). A null result means "not ready", not "failed" — the entry
// stays pending and is retried on the next drain once its dependency lands.
async function resolveArgs(entry: SyncOutboxEntry): Promise<Record<string, unknown> | null> {
  const args: Record<string, unknown> = { ...(entry.args ?? {}) };
  for (const ref of entry.refs ?? []) {
    const mapping = await localDb.provisionalIdMap.get(ref.provisionalId);
    if (!mapping) return null;
    args[ref.field] = mapping.realId;
  }
  return args;
}

// Reconciles one RPC's result into Zustand + the local mirror. Each RPC this
// outbox supports needs a matching reconciler, registered by ./index.ts once
// the data store exists (see reconcileCompleteSale / reconcileAdjustStock).
// Deliberately NOT a static import of useDataStore here — every slice
// imports enqueueOutbox from this file, and index.ts imports every slice, so
// importing the store back from here would create a circular import that
// breaks module init (index.ts calling createSaleSlice before its module
// finishes evaluating).
/** `ackId` is the outbox entry being acknowledged (its stock effect is
 *  released exactly once — stockLedger.serverStockRows). */
type Reconciler = (data: unknown, provisional: SyncOutboxEntry["provisional"], ackId: string) => void;
const reconcilers: Record<string, Reconciler> = {};

export function registerOutboxReconciler(rpcName: string, reconciler: Reconciler): void {
  reconcilers[rpcName] = reconciler;
}

// ----------------------------------------------------------------------
// Backoff
// ----------------------------------------------------------------------

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 5 * 60 * 1_000;
export const BACKOFF_JITTER = 0.2;

/** Delay before attempt number `attempts + 1`, after `attempts` transient
 *  failures: 1 s, 2 s, 4 s … capped at 5 min, ±20 % jitter so a fleet of
 *  tills reconnecting after the same outage doesn't retry in lockstep.
 *  Pure — `random` is injectable for tests. */
export function computeBackoffMs(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.min(BACKOFF_CAP_MS, Math.max(0, Math.round(exponential * jitter)));
}

// ----------------------------------------------------------------------
// Persisted sync-state flags (survive reloads; never cleared by a load)
// ----------------------------------------------------------------------

export async function readNeedsReauth(): Promise<boolean> {
  try {
    return (await localDb.syncState.get(SYNC_STATE_KEYS.needsReauth))?.flag === true;
  } catch {
    return false;
  }
}

/** Flag that the server rejected this device's session. Set by the drain
 *  preflight and by a full load that finds the session gone (see
 *  stores/data/index.ts); cleared by clearNeedsReauth after a sign-in. */
export async function setNeedsReauth(reason: string): Promise<void> {
  await localDb.syncState.put({
    key: SYNC_STATE_KEYS.needsReauth, flag: true, reason, updatedAt: new Date().toISOString(),
  });
  useSyncStore.getState().setStatus({ needsReauth: true });
}

/** Called after a successful sign-in / token refresh (AppLayout's auth
 *  listener) and by the drain itself once a session is confirmed valid. */
export async function clearNeedsReauth(): Promise<void> {
  await localDb.syncState.delete(SYNC_STATE_KEYS.needsReauth);
  useSyncStore.getState().setStatus({ needsReauth: false });
}

/** Recount the queue and push it to the UI store. */
export async function refreshSyncStatus(): Promise<void> {
  try {
    const [pendingCount, conflictCount, quarantinedCount, needsReauth] = await Promise.all([
      countPendingOutbox(),
      localDb.syncOutbox.where("status").equals("conflict").count(),
      localDb.syncOutbox.where("status").equals("quarantined").count(),
      readNeedsReauth(),
    ]);
    useSyncStore.getState().setStatus({ pendingCount, conflictCount, quarantinedCount, needsReauth });
  } catch (err) {
    console.error("[DB] Failed to read sync status:", err);
  }
}

// ----------------------------------------------------------------------
// Session preflight
// ----------------------------------------------------------------------

type SessionCheck = "ok" | "network" | "needs-reauth";

// supabase-js refreshes a token that is within this margin of expiry; we
// use the same margin so a token about to expire mid-drain is refreshed up
// front instead of producing a 401 on the first entry.
const EXPIRY_MARGIN_MS = 30_000;

const sessionExpired = (session: { expires_at?: number } | null | undefined): boolean =>
  typeof session?.expires_at === "number" && session.expires_at * 1000 - Date.now() < EXPIRY_MARGIN_MS;

/**
 * Make sure replaying is worth attempting: getSession() reads (and, if the
 * access token is expired, refreshes) the persisted session. A refresh that
 * fails because the network is down leaves everything pending for the next
 * pass; one the server *rejects* (invalid/revoked refresh token — at which
 * point supabase-js has already dropped the session) means this device
 * must sign in again before anything is sent. Nothing is discarded either
 * way. See docs/selfhost-migration/phase-d/offline-authorization.md §4.
 */
async function ensureSessionForDrain(): Promise<SessionCheck> {
  let sessionResult: Awaited<ReturnType<typeof supabase.auth.getSession>>;
  try {
    sessionResult = await supabase.auth.getSession();
  } catch (err) {
    return isNetworkError(err) ? "network" : "needs-reauth";
  }
  if (sessionResult.error) return isNetworkError(sessionResult.error) ? "network" : "needs-reauth";
  const session = sessionResult.data?.session;
  if (!session) return "needs-reauth";
  if (!sessionExpired(session)) return "ok";

  // getSession() normally refreshes an expired token itself; if it handed
  // back a stale one anyway, refresh explicitly before sending anything.
  let refreshed: Awaited<ReturnType<typeof supabase.auth.refreshSession>>;
  try {
    refreshed = await supabase.auth.refreshSession();
  } catch (err) {
    return isNetworkError(err) ? "network" : "needs-reauth";
  }
  if (refreshed.error) return isNetworkError(refreshed.error) ? "network" : "needs-reauth";
  return refreshed.data?.session ? "ok" : "needs-reauth";
}

// ----------------------------------------------------------------------
// Cross-instance drain lock
// ----------------------------------------------------------------------

const DRAIN_LOCK_NAME = "pos-outbox-drain";
const LEASE_TTL_MS = 60_000;
// One id per JS context (window / worker / test module instance).
const instanceId = newId("drain");
let leaseHeld = false;

async function acquireLease(): Promise<boolean> {
  return localDb.transaction("rw", localDb.syncState, async () => {
    const now = Date.now();
    const lease = await localDb.syncState.get(SYNC_STATE_KEYS.drainLease);
    const heldByOther =
      lease?.ownerId && lease.ownerId !== instanceId && lease.expiresAt && Date.parse(lease.expiresAt) > now;
    if (heldByOther) return false;
    await localDb.syncState.put({
      key: SYNC_STATE_KEYS.drainLease, ownerId: instanceId,
      expiresAt: new Date(now + LEASE_TTL_MS).toISOString(), updatedAt: new Date(now).toISOString(),
    });
    return true;
  });
}

async function renewLease(): Promise<void> {
  if (!leaseHeld) return;
  const now = Date.now();
  await localDb.syncState.put({
    key: SYNC_STATE_KEYS.drainLease, ownerId: instanceId,
    expiresAt: new Date(now + LEASE_TTL_MS).toISOString(), updatedAt: new Date(now).toISOString(),
  });
}

async function releaseLease(): Promise<void> {
  const lease = await localDb.syncState.get(SYNC_STATE_KEYS.drainLease);
  if (lease?.ownerId === instanceId) await localDb.syncState.delete(SYNC_STATE_KEYS.drainLease);
}

type LockManagerLike = {
  request: (name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
};

const getLockManager = (): LockManagerLike | null => {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
};

/**
 * Run `fn` while holding the drain lock. Web Locks (Chromium/Electron,
 * shared across windows of the same origin) when available; otherwise a
 * Dexie lease row with a 60 s TTL, renewed per entry while draining, so a
 * crashed holder frees the queue within a minute. Either way a second
 * instance finding the lock taken returns "locked" without sending.
 */
async function withDrainLock(fn: () => Promise<DrainResult>): Promise<DrainResult> {
  return withDrainLockOr(fn, "locked");
}

async function withDrainLockOr<T>(fn: () => Promise<T>, busyValue: T): Promise<T> {
  const locks = getLockManager();
  if (locks) {
    const result = await locks.request(DRAIN_LOCK_NAME, { ifAvailable: true }, async (lock) =>
      lock ? fn() : busyValue,
    );
    return result as T;
  }
  if (!(await acquireLease())) return busyValue;
  leaseHeld = true;
  try {
    return await fn();
  } finally {
    leaseHeld = false;
    await releaseLease().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------
// Drain
// ----------------------------------------------------------------------

let draining = false;

// How long an entry can sit blocked on an unresolved `refs` dependency
// before it's treated as stuck rather than "just hasn't had a turn yet" —
// e.g. its parent entry (the shift it references) was dismissed from the
// Sync Conflicts page instead of retried, so the dependency will never
// resolve on its own.
const STUCK_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type DrainResult =
  | "drained"        // queue empty, or everything ready was sent (or conflicted)
  | "already-running"
  | "locked"         // another window/instance holds the drain lock
  | "network"        // transient failure (or session refresh failed on the network) — pass stopped, entries pending
  | "needs-reauth"   // server rejected the session — nothing sent, entries kept
  | "backoff";       // the head-of-line entry is still in its backoff window

/**
 * Replay queued mutations against Supabase in queue order (see
 * byQueueOrder — enqueue sequence, not the millisecond clock). Safe to call
 * repeatedly (on reconnect, on every background refresh, after a token
 * refresh) — a no-op while already draining, locked by another instance,
 * or when the queue is empty.
 *
 * A transient failure (network/gateway, timeout, 5xx, 429, expired JWT)
 * stops the whole pass — later entries may depend on this one, and the
 * server was probably unreachable for them too — and leaves the entry
 * `pending` with a capped exponential backoff and no attempt cap. A
 * permanent rejection (validation, RLS, business rule, IDEMPOTENCY_MISMATCH)
 * is a real conflict: flagged for manual review, and draining continues so
 * a rejected sale on one till doesn't block another.
 */
export async function drainOutbox(): Promise<DrainResult> {
  if (draining) return "already-running";
  draining = true;
  useSyncStore.getState().setStatus({ isDraining: true });
  try {
    return await withDrainLock(runDrainPass);
  } finally {
    draining = false;
    useSyncStore.getState().setStatus({ isDraining: false });
    await refreshSyncStatus();
  }
}

async function runDrainPass(): Promise<DrainResult> {
  // D2: we hold the drain lock, so a `syncing` row is not a request of this
  // instance in flight. The first pass after startup frees them all; every
  // later pass (the loop resuming after an error, offline period, backoff)
  // frees those past the stale threshold.
  const recovered = await recoverStrandedSyncing(startupRecoveryDone ? SYNCING_STALE_MS : 0);
  startupRecoveryDone = true;
  if (recovered > 0) {
    console.warn(`[sync] ${recovered} entr${recovered === 1 ? "y" : "ies"} left 'syncing' by an interrupted request returned to the queue (same idempotency key).`);
    await refreshSyncStatus();
  }
  const legacyHeld = await classifyLegacyQueue();
  if (legacyHeld > 0) console.warn(`[sync] ${legacyHeld} older unconfirmed entr${legacyHeld === 1 ? "y is" : "ies are"} held for confirmation (never resent).`);
  await pruneProvisionalIdMap();
  // Never send an entry to a backend other than the one it was queued for
  // (main.tsx does this at startup too; repeated here so the drain does not
  // depend on it). Quarantined entries are not "pending" and are skipped.
  if ((await quarantineForeignOutboxEntries(localDb, currentBackendOrigin())) > 0) {
    await refreshSyncStatus();
    notifyQueueChanged();
  }
  if ((await pendingInQueueOrder()).length === 0) return "drained";
  try {
    await requireRecoveryV1Write(useAuthStore.getState().currentOrgId ?? null, null, { requireDevice: false });
  } catch (error) {
    useSyncStore.getState().setStatus({ lastTransientError: error instanceof Error ? error.message : "Recovery evidence unavailable; queue preserved." });
    return "backoff";
  }
  // W8 Phase 0: the server no longer has records this till had loaded from it
  // (possibly restored from an older backup): nothing is sent or looked up
  // automatically until an owner acknowledges it (Sync page).
  const warning = await continuityWarning();
  if (warning) {
    useSyncStore.getState().setStatus({ lastTransientError: `Automatic sync paused: ${warning.reason} An owner must review it on the Sync page.` });
    return "backoff";
  }
  // Migration 087: while this till is in recovery mode (or its backend's 087
  // status is unknown) the server is asked first — recovery_epoch is the only
  // way out of a recovery mode; reconnecting is not. Nothing is sent, looked
  // up or stopped automatically while it holds.
  // (after every start: the server authorises the till before anything is sent)
  if (recoveryBlocksSending() || recoveryCapability() === "unknown" || (recoveryCapability() === "present" && !verifiedSinceStart())) {
    await runRecoveryCheck().catch(() => undefined);
  }
  if (recoveryCapability() === "present" && !verifiedSinceStart() && !recoveryBlocksSending()) {
    useSyncStore.getState().setStatus({ lastTransientError: "Automatic sync paused: the server has not confirmed this till since it started. Retried automatically." });
    return "network";
  }
  if (recoveryCapability() === "unknown") {
    // whether this server has 087 is not known (it could not be asked): nothing is sent on a guess
    useSyncStore.getState().setStatus({ lastTransientError: "Automatic sync paused: the server could not be asked whether it is in a recovery hold. Retried automatically." });
    return "network";
  }
  if (recoveryBlocksSending()) {
    const view = recoveryView();
    useSyncStore.getState().setStatus({ lastTransientError: `Automatic sync paused: ${recoveryMessage(view.mode === "legacy-server" ? "normal" : view.mode, view.code)}` });
    return "backoff";
  }
  // The server verified the till again: entries kept during the recovery are
  // due now (each keeps its own epoch; an old one is then held for review).
  await localDb.syncOutbox.filter((e) => e.heldReason === "recovery" && Boolean(e.nextAttemptAt))
    .modify((e) => { e.nextAttemptAt = undefined; }).catch(() => undefined);
  // An online attempt is in flight (here or in another window): let it
  // finish first (its reply decides whether dependent queued work can go).
  if ((await rowsInFlightAnywhere()).size > 0) return "backoff";

  const session = await ensureSessionForDrain();
  if (session === "network") return "network";
  if (session === "needs-reauth") {
    await setNeedsReauth("The server rejected this device's sign-in. Sign in again to resume syncing.");
    return "needs-reauth";
  }
  await clearNeedsReauth();

  for (;;) {
    await renewLease();
    if (recoveryBlocksSending()) return "backoff";     // a reply in this pass put the till in recovery mode
    const pending = await pendingInQueueOrder();

    // Strict queue order: the first entry that is not provably finished on
    // the server is the head; nothing that could depend on it overtakes it.
    // Shared-till pass: an entry that cannot be sent in THIS session (it
    // belongs to another app user — it waits for them) does not stop the
    // whole till. Later entries PROVEN independent of it (dependencies.ts)
    // pass; anything that may depend on it — or on an entry waiting behind
    // it — waits too. This user's own blocked entries (an undecided
    // conflict, a ref still unresolved, a backoff) stop the pass as before.
    // A committed entry whose reply cannot be read here is always passed.
    const me = currentActorId();
    const meIsAdmin = useAuthStore.getState().currentRole === "ADMIN";
    const depCtx = await dependencyContext();
    let entry: SyncOutboxEntry | null = null;
    let resolvedArgs: Record<string, unknown> | null = null;
    let waitingOnRef: SyncOutboxEntry | null = null;
    const passed: SyncOutboxEntry[] = [];
    for (const candidate of pending) {
      if (isParked(candidate)) continue;
      // W10 Phase 0: an operation the server has no record of waits for an
      // owner (never stopped automatically). While it waits, later entries
      // PROVEN independent of it continue; anything that may depend on it waits.
      if (awaitsReconciliation(candidate)) {
        passed.push(candidate);
        continue;
      }
      if (passed.some((p) => mayDepend(candidate, p, depCtx))) {
        passed.push(candidate);                      // waits with what it depends on
        continue;
      }
      if (ownedByOther(candidate, me) && !(candidate.fenceRequired === true && meIsAdmin)) {
        // (An ADMIN may still ask about — and fence — another user's HELD
        // entry: it was never authorised offline; the server authorizes it.)
        if (candidate.status === "pending" && (candidate.heldReason !== "needs-original-user" || !candidate.nextAttemptAt)) {
          await park(candidate, "needs-original-user", OTHER_USER_TEXT, 5 * 60_000);
          await localDb.syncOutbox.update(candidate.localId, { parkedWhileSignedIn: me });
        }
        passed.push(candidate);
        continue;
      }
      if (isBlockingConflict(candidate)) return "backoff";   // a person decides; never sent automatically
      if (candidate.heldReason === "needs-original-user" && candidate.nextAttemptAt
          && candidate.parkedWhileSignedIn && candidate.parkedWhileSignedIn !== me && me && actorOf(candidate) === me) {
        // Parked while ANOTHER user was signed in; its own creator is signed in
        // now: due at once. A park set in the creator's own session (the
        // server refused it for this user — WRONG_ACTOR, an unauthorised
        // fence) keeps its backoff: no resend loop.
        await localDb.syncOutbox.update(candidate.localId, { nextAttemptAt: undefined, parkedWhileSignedIn: undefined });
        candidate.nextAttemptAt = undefined;
      }
      const args = await resolveArgs(candidate);
      if (args) {
        entry = candidate;
        resolvedArgs = args;
      } else {
        waitingOnRef = candidate;
      }
      break;
    }
    if (!entry) {
      if (!waitingOnRef) return passed.length ? "backoff" : "drained";
      // The head waits for a record another entry creates. If that entry can
      // never succeed (set aside, refused, gone), say so now — no 24 h wait;
      // otherwise flag it after 24 h of waiting (from when it first waited).
      // Either way it keeps the head: nothing that may depend on it passes.
      const now = Date.now();
      const candidate = waitingOnRef;
      const since = candidate.refWaitSince ?? new Date(now).toISOString();
      if (!candidate.refWaitSince) await localDb.syncOutbox.update(candidate.localId, { refWaitSince: since });
      const dead = await deadParent(candidate);
      if (dead || now - Date.parse(since) >= STUCK_ENTRY_MAX_AGE_MS) {
        await localDb.syncOutbox.update(candidate.localId, {
          status: "conflict",
          failureKind: "permanent",
          blocksQueue: true,
          lastError: dead
            ? "Stuck: it needs a record that an earlier entry was to create, but that entry was set aside, refused or stopped. A person decides (retry the earlier one, or an owner sets this one aside). Later entries that may depend on it wait."
            : "Stuck waiting on a dependency that never synced — its parent entry may need to be retried, or an owner sets this one aside. Later entries wait behind it.",
        });
        notifyQueueChanged(candidate);
      }
      return "backoff";
    }

    // The head of the line is still backing off from a transient failure.
    // Stop here rather than let later (possibly dependent) entries overtake
    // it; the periodic trigger will come back once the window has passed.
    if (entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > Date.now()) return "backoff";

    // Last line of defence for the origin rule: re-read the stored row (it
    // may have been rewritten since the list above was taken) and refuse
    // anything not tagged with this backend.
    const stored = await localDb.syncOutbox.get(entry.localId);
    if (!stored || !belongsToBackend(stored, currentBackendOrigin())) {
      await quarantineForeignOutboxEntries(localDb, currentBackendOrigin());
      continue;
    }

    // 087 (before anything else touches it — never re-keyed or reclassified): an entry created without a recovery epoch (an older build's queue,
    // or queued while the server had no 087) is never sent to an 087 server:
    // it would be refused, and replaying it automatically is never allowed.
    // It keeps its key and arguments and waits for an owner's review.
    if (v87Routing() && !entry.opEpoch) {
      await holdForOwnerReview(entry, LEGACY_OPERATION, legacyOperationError(entry.kind === "rpc" ? entry.name : entry.name).message);
      continue;
    }

    // Entries queued before Phase D carry no key (the Dexie v2 upgrade
    // assigns one, but be safe) — mint it now so that from this attempt on
    // every retry is idempotent.
    if (entry.kind === "rpc" && !entry.idempotencyKey) {
      // A pre-Phase-D entry: a legacy (v4) key, as the build that queued it
      // would have minted — it has no recorded actor, so a UUIDv7 key could
      // never be executed for it (op_execute requires the actor for v7).
      const key = typeof resolvedArgs?.[IDEMPOTENCY_KEY_ARG] === "string"
        ? (resolvedArgs[IDEMPOTENCY_KEY_ARG] as string)
        : crypto.randomUUID();
      entry.idempotencyKey = key;
      entry.args = { ...(entry.args ?? {}), [IDEMPOTENCY_KEY_ARG]: key };
      resolvedArgs = { ...(resolvedArgs ?? {}), [IDEMPOTENCY_KEY_ARG]: key };
      await localDb.syncOutbox.update(entry.localId, { idempotencyKey: key, args: entry.args });
    }

    // A row of an older build that has not been classified yet (restored or
    // retried while this pass runs): classify it before anything is sent.
    if (entry.kind === "rpc" && entry.staged === undefined && entry.fenceRequired === undefined) {
      await classifyLegacyQueue();
      const fresh = await localDb.syncOutbox.get(entry.localId);
      if (fresh && fresh.staged === undefined && fresh.fenceRequired === undefined) {
        if (fresh.writeAhead === true) {
          holdForRecovery(fresh);                  // never resent without a lookup
          await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
            await localDb.syncOutbox.put(fresh);
            await journalRowChanged(fresh, "held-legacy-row");
          });
        } else {
          await localDb.syncOutbox.update(entry.localId, { staged: true });
        }
      }
      continue;
    }
    // G1 Stage 1: an operation whose outcome is unknown and that was never
    // authorised offline is NEVER resent; the server is asked instead.
    if (entry.kind === "rpc" && entry.fenceRequired === true) {
      const resolved = await resolveByLookup(entry, resolvedArgs);
      if (resolved === "next") continue;
      return resolved;
    }
    // An operation is sent only in its creator's session (the server
    // enforces it too): drained by someone else, it waits for them.
    if (entry.kind === "rpc") {
      const owner = actorOf(entry);
      const me = currentActorId();
      if (owner && me && owner !== me) {
        // Head of the queue: later entries may depend on it (e.g. a restock
        // entered by its manager before this cashier's sale).
        await park(entry, "needs-original-user", OTHER_USER_TEXT, 5 * 60_000);
        return "backoff";
      }
    }

    const sentAt = new Date().toISOString();
    await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
      await localDb.syncOutbox.update(entry!.localId, { status: "syncing", syncingSince: sentAt, sentAt });
      await journalSent(entry!, sentAt);
    });
    notifyQueueChanged();

    let outcome: RpcOutcome = entry.kind === "table_write"
      ? await runTableWrite(entry.table!, entry.op!, entry.row, entry.id!, entry.opEpoch ?? null)
      : await callRpc(entry.name, resolvedArgs ?? {}, { actorId: actorOf(entry), opEpoch: entry.opEpoch ?? null });
    if (entry.kind === "rpc" && outcome.via) {
      await localDb.syncOutbox.update(entry.localId, { protocol: outcome.via });
    }

    // Committed on the server, reply not readable here (another user's, or
    // purged): reconciled by a verified reload, never guessed.
    if (!outcome.error && outcome.responseUnavailable) {
      const done = await acknowledgeCommittedWithoutReply(entry);
      if (done === "next") continue;
      return done;
    }
    // The server's ledger holds a FINAL decision (086): never resent.
    if (outcome.error && (outcome.serverOutcome === "rejected" || outcome.serverOutcome === "abandoned")) {
      await markFinal(entry, outcome.serverOutcome, outcome.error.message);
      continue;
    }
    // 087 recovery refusal: nothing ran, nothing was recorded. A refusal of
    // THIS operation (created under an older epoch, or without one) waits for
    // an owner — never resent, re-stamped or stopped automatically; anything
    // else put the till in recovery mode (recoveryState): the pass stops and
    // the entry keeps its key, arguments and epoch.
    if (outcome.error?.failure.klass === "RECOVERY") {
      const code = recoveryCodeOf(outcome.error.message) ?? outcome.error.code ?? "RECOVERY";
      if (code === "ORG_UNRESOLVED") {
        // a row that resolves to no organisation, while another organisation is held: this one waits (5 min)
        await park(entry, "recovery", outcome.error.message, 5 * 60_000);
        return "backoff";
      }
      if (code === "PRE_EPOCH_OPERATION" || code === "CLIENT_UPGRADE_REQUIRED" || code === LEGACY_OPERATION) {
        await holdForOwnerReview(entry, code, `Not executed: the server treats it as an operation from before its current recovery epoch (${code}). It keeps its original key, arguments and epoch, is never resent or stopped automatically, and waits for an owner's review (Sync).`);
        continue;
      }
      await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
        await localDb.syncOutbox.update(entry.localId, {
          status: keptStatus(entry, entry.fenceRequired === true ? "conflict" : "pending"), syncingSince: undefined, failureKind: "transient",
          heldReason: "recovery", lastError: outcome.error!.message, inDoubt: entry.inDoubt === true || entry.fenceRequired === true,
          nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
        const row = await localDb.syncOutbox.get(entry.localId);
        if (row) await journalRecoveryRefusal(row, code, outcome.error!.message);
      });
      notifyQueueChanged(entry);
      useSyncStore.getState().setStatus({ lastTransientError: outcome.error.message });
      return "backoff";
    }
    // Not executed and not recorded: belongs to another user, or waits for
    // a prerequisite another till has not synchronised yet. Kept, same key.
    if (outcome.error?.failure.klass === "WRONG_ACTOR") {
      await park(entry, "needs-original-user", OTHER_USER_TEXT, 5 * 60_000);
      return "backoff";
    }
    if (outcome.error?.failure.klass === "DEPENDENCY") {
      // The 24 h clock starts at the FIRST dependency refusal (a till that
      // was offline for days still gets its grace period).
      const since = entry.dependencySince ?? new Date().toISOString();
      if (Date.now() - Date.parse(since) >= STUCK_ENTRY_MAX_AGE_MS) {
        await localDb.syncOutbox.update(entry.localId, {
          status: "conflict", failureKind: "permanent", syncingSince: undefined, attempts: entry.attempts + 1, nextAttemptAt: undefined,
          heldReason: undefined, blocksQueue: true, dependencySince: since,
          lastError: `Still refused after a day, waiting for data that never arrived (${outcome.error.message}). Needs a person; later entries wait behind it.`,
        });
        notifyQueueChanged(entry);
      } else {
        await localDb.syncOutbox.update(entry.localId, { dependencySince: since });
        await park(entry, "dependency",
          `Waiting for related data to reach the server (${outcome.error.message}). Not recorded there; retried automatically with the same key.`,
          Math.max(computeBackoffMs(entry.attempts + 1), 5 * 60_000));
      }
      return "backoff";   // later entries may depend on it (e.g. a close after this sale)
    }

    // A 2xx is not success by itself (plan v2 §5.2): an RPC reply must have
    // the shape its reconciler needs, or the outcome is unknown.
    if (!outcome.error && entry.kind === "rpc") {
      const problem = replyProblem(entry.name, outcome.data);
      if (problem) outcome = { data: null, status: outcome.status, error: malformedReply(entry.name, problem, outcome.status) };
    }

    if (outcome.error) {
      // A table_write insert's id is client-minted, so a duplicate on the
      // PRIMARY KEY means our earlier attempt committed before the reply was
      // lost. A duplicate on any other unique index is a real conflict.
      const alreadyApplied =
        entry.kind === "table_write" && entry.op === "insert" && isPrimaryKeyDuplicate(entry.table!, outcome.error);

      if (!alreadyApplied) {
        const { failure } = outcome.error;
        if (failure.retryable) {
          const held = await holdOrRetry(entry, outcome.error);
          return held;
        }
        // A key dated in the FUTURE (a till clock running ahead) is refused
        // only until real time catches up — never a final outcome.
        const keyTime = uuidV7TimeMs(entry.idempotencyKey);
        if (failure.klass === "KEY_EXPIRED" && keyTime !== null && keyTime > Date.now()) {
          await park(entry, "future-key",
            "This till's clock was ahead when it was entered; the server accepts it once the time is reached. Kept with its key; later entries wait.",
            Math.max(Math.min(keyTime - 30 * 24 * 60 * 60_000 - Date.now(), 6 * 60 * 60_000), 5 * 60_000));
          return "backoff";
        }
        // Not decided on the server (a legacy direct refusal is never
        // recorded; it could still run if retried): it keeps the head of the
        // queue until a person retries or sets it aside. A key mismatch or
        // a key too old to execute can never run under this key.
        const dead = failure.klass === "CONTRACT" || failure.klass === "KEY_EXPIRED";
        await localDb.syncOutbox.update(entry.localId, {
          status: "conflict",
          syncingSince: undefined,
          attempts: entry.attempts + 1,
          failureKind: "permanent",
          nextAttemptAt: undefined,
          heldReason: undefined,
          blocksQueue: dead ? undefined : true,
          lastError: dead ? outcome.error.message
            : `Refused by the server, but the refusal is NOT recorded there (not final): ${outcome.error.message}. Later entries wait until a person retries it or an owner sets it aside.`,
        });
        notifyQueueChanged(entry);
        if (!dead) return "backoff";
        continue;
      }
    }

    // table_write entries need no reconciliation: the row content was
    // already client-chosen and applied optimistically (last-write-wins),
    // so a successful replay just confirms it — nothing new to merge in.
    // An RPC replay that hit the server's idempotency table comes back with
    // the original response, which is reconciled exactly like a first-time
    // success (contract: "treat the stored response as a first-time success").
    if (entry.kind === "table_write") void touchAuthCache();
    if ((await applyServerReply(entry, outcome.data, "reply", outcome.signedReply)) === "network") return "network";
  }
}

/** Reconcile a committed reply and acknowledge the entry (exactly once:
 *  the entry and its mappings go in one transaction). "network" when the
 *  reconciler failed — the entry is kept and asked about again later. */
async function applyServerReply(
  entry: SyncOutboxEntry, data: unknown, source: "reply" | "lookup" = "reply", signedReply?: { signed: unknown; sig: string } | null,
): Promise<"ok" | "network"> {
  const reconcile = reconcilers[entry.name];
  if (reconcile) {
    // A reconciler that throws must not take the queue down with it, and
    // must not lose the entry: keep it (the server HAS the operation — a
    // resend returns the same stored reply) and stop this pass.
    try {
      beginMappingCapture();
      reconcile(data, entry.provisional, entry.localId);
      // The reply's stock rows must be on disk (with the ledger) BEFORE
      // the entry disappears, or a crash in between could show stock as
      // if the sale had never happened.
      await flushStockCommit(entry.localId);
    } catch (err) {
      endMappingCapture();
      console.error(`[sync] Reconciling ${entry.name} failed; the entry is kept and resent later:`, err);
      await localDb.syncOutbox.update(entry.localId, {
        status: keptStatus(entry, "pending"), syncingSince: undefined, attempts: entry.attempts + 1, failureKind: "transient",
        inDoubt: true, heldReason: "reconcile-failed",
        lastError: `Applied on the server, but this till could not record the reply (${err instanceof Error ? err.message : String(err)}). Kept; resent with the same key.`,
        nextAttemptAt: new Date(Date.now() + Math.max(computeBackoffMs(entry.attempts + 1), 60_000)).toISOString(),
      });
      notifyQueueChanged(entry);
      return "network";
    }
  }
  // Acknowledge: the id mappings the reconciler produced and the removal
  // of the entry commit together, or not at all (Batch 2A item 7).
  await acknowledgeEntry(entry.localId, endMappingCapture(), { source, response: data }, signedReply);
  notifyQueueChanged(entry);
  useSyncStore.getState().setStatus({ lastTransientError: null });
  return "ok";
}

// ----------------------------------------------------------------------
// G1 Stage 1 recovery (migration 086): final outcomes, lookup + fence,
// committed-without-reply.
// ----------------------------------------------------------------------

/** Text shown for an operation this till did not record and will not send
 *  until the server can say what happened to it. */
export const NOT_RECORDED_HELD_TEXT =
  "NOT recorded on this till. The server may or may not have received it, and this server cannot confirm it yet " +
  "(it needs the operation-status update, migration 086). It is held with its original key and will NOT be sent automatically.";

const OTHER_USER_TEXT =
  "Entered by another user: it is sent only when that user signs in on this till, and later entries wait behind it. " +
  "An administrator can check it, or an owner can set it aside to let the rest of the queue continue.";

/** The ONLY hold later entries may pass (stabilization pass, H2): the
 *  server has confirmed the operation COMMITTED (its reply just cannot be
 *  read here), so it can never change server state again, and anything that
 *  needs its ids still waits on its refs. Every other hold — another
 *  user's entry, a missing prerequisite, an unknown outcome — keeps its
 *  place at the head of the queue: a later entry may depend on it. */
const isParked = (entry: SyncOutboxEntry): boolean =>
  entry.heldReason === "committed-reply-unavailable"
  && Boolean(entry.nextAttemptAt) && Date.parse(entry.nextAttemptAt!) > Date.now();

/** The server decided this key for good: it never executes from here. Its
 *  local stock effect is released by the next recompute (conflict rows are
 *  not counted — pendingStock.ts). */
async function markFinal(
  entry: SyncOutboxEntry, outcome: "rejected" | "abandoned", message: string, source: "reply" | "lookup" = "reply",
  fencedFor?: "replacement" | "owner",
): Promise<void> {
  await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
    await journalDecided(entry, outcome, { source, message: message.slice(0, 500), recordedOnServer: true, ...(fencedFor ? { fencedByTill: true, fencedFor } : {}) });
    await localDb.syncOutbox.update(entry.localId, {
      // A set-aside / quarantined entry keeps that status; it now carries the server's decision.
      status: keptStatus(entry, "conflict"), serverOutcome: outcome, failureKind: "permanent", syncingSince: undefined,
      attempts: entry.attempts + 1, inDoubt: false, heldReason: undefined, nextAttemptAt: undefined,
      lastError: outcome === "abandoned"
        ? `Not applied: ${message}`
        : `Refused by the server (final; it will not be sent again): ${message}`,
    });
  });
  notifyQueueChanged(entry);
}

/** Audit line for an owner's recovery action (exported with the queue). */
export async function ownerAudit(localId: string, detail: string): Promise<void> {
  const at = new Date().toISOString();
  const line = { id: newId("rlog"), at, event: "owner-action" as const, localId, ownerUserId: useAuthStore.getState().currentUserId ?? null, detail: detail.slice(0, 300) };
  await localDb.syncState.put({ key: `${RECONCILE_LOG_PREFIX}${line.id}`, value: JSON.stringify(line), updatedAt: at }).catch(() => undefined);
}

/** The status a rewrite may give an entry: a set-aside or quarantined entry
 *  keeps it, a held recovery stays "conflict" (no older build sends it). */
const keptStatus = (entry: SyncOutboxEntry, otherwise: SyncOutboxEntry["status"]): SyncOutboxEntry["status"] =>
  entry.status === "archived" || entry.status === "quarantined" ? entry.status
    : entry.fenceRequired === true && otherwise === "pending" ? "conflict" : otherwise;

/** Keep an entry, its key and arguments, and look again after `delayMs`.
 *  A held recovery stays "conflict" (never sent by any older build). */
async function park(entry: SyncOutboxEntry, heldReason: string, lastError: string, delayMs: number): Promise<void> {
  await localDb.syncOutbox.update(entry.localId, {
    status: keptStatus(entry, entry.fenceRequired === true ? "conflict" : "pending"),
    syncingSince: undefined, failureKind: "transient", heldReason, lastError,
    inDoubt: entry.inDoubt === true || entry.fenceRequired === true,
    nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
  });
  notifyQueueChanged(entry);
}

const actorOf = (entry: SyncOutboxEntry): string | null =>
  entry.actorId ?? (typeof entry.args?.p_expected_actor_id === "string" ? (entry.args.p_expected_actor_id as string) : null);

/** Text for an operation the server has no record of (W10 Phase 0). */
export const RECONCILIATION_REQUIRED_TEXT =
  "The server has no record of this operation. It may never have arrived — or it may have been applied on a server that was " +
  "later restored from an older backup. It is NOT stopped and NOT resent automatically: it keeps its original key, and later " +
  "entries that may depend on it wait. An owner decides (Sync › Stop on server, or reconcile it).";

/** Waiting for an owner's decision (the server has no record of it): not due again yet. */
const awaitsReconciliation = (e: SyncOutboxEntry): boolean =>
  // 087 owner review: never resent automatically, whatever its time (an owner acts: retry, set aside, reconcile)
  (e.heldReason === OWNER_REVIEW && !e.serverOutcome)
  || (e.heldReason === "reconciliation-required" && !e.serverOutcome && Boolean(e.nextAttemptAt) && Date.parse(e.nextAttemptAt!) > Date.now());

/** 087: an operation the server will not run under its own epoch (created
 *  before the current one, or without one): it waits for an owner — 088 /
 *  an owner-approved decision settles it. */
export const OWNER_REVIEW = "awaiting-owner-review";

/** Hold an entry for an owner's review (087), with its journal event, in one transaction.
 *  Its key, arguments and epoch are kept; it is never resent automatically (an owner sets it aside or reconciles it). */
async function holdForOwnerReview(entry: SyncOutboxEntry, code: string, lastError: string): Promise<void> {
  await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
    await localDb.syncOutbox.update(entry.localId, {
      status: keptStatus(entry, entry.fenceRequired === true ? "conflict" : "pending"),
      syncingSince: undefined, failureKind: "transient", heldReason: OWNER_REVIEW, lastError,
      inDoubt: entry.inDoubt === true || entry.fenceRequired === true,
      nextAttemptAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    });
    const row = await localDb.syncOutbox.get(entry.localId);
    if (row) await journalRecoveryRefusal(row, code, lastError);
  });
  notifyQueueChanged(entry);
}

/** Hold an entry for an owner's decision, with its journal record, in one transaction. */
async function holdForReconciliation(entry: SyncOutboxEntry, lastError: string, delayMs: number): Promise<void> {
  await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
    await localDb.syncOutbox.update(entry.localId, {
      status: keptStatus(entry, entry.fenceRequired === true ? "conflict" : "pending"),
      syncingSince: undefined, failureKind: "transient", heldReason: "reconciliation-required", lastError,
      inDoubt: true, nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
    });
    const row = await localDb.syncOutbox.get(entry.localId);
    if (row) await journalReconciliationRequired(row, lastError);
  });
  notifyQueueChanged(entry);
}

/**
 * An operation that must never be resent (its outcome is unknown and it was
 * never authorised offline): ask the server (op_status), READ-ONLY.
 *
 * W10 Phase 0: "not found" no longer stops (fences) the key. On a server
 * restored from an older backup, "not found" cannot tell "never arrived"
 * from "arrived and was lost by the restore" — fencing then would make a
 * real sale unrecordable under its key. The entry keeps its key, is looked
 * up again later, and an owner decides (stopOnServer / reconcile). Only the
 * server's positive answers decide it here: committed (recorded on this
 * till), rejected or abandoned (final, as recorded in the server's ledger).
 * "next" when the entry was settled or is waiting; a DrainResult to stop.
 */
async function resolveByLookup(entry: SyncOutboxEntry, resolvedArgs: Record<string, unknown> | null = null): Promise<DrainResult | "next"> {
  if (!entry.idempotencyKey) {
    await park(entry, "outcome-unknown", "No operation key on this entry: it cannot be checked with the server. Kept; never sent. Later entries wait behind it until an owner sets it aside.", 30 * 60_000);
    return "backoff";
  }
  const actorId = actorOf(entry);
  const { absent, status, error } = await lookupOperation(entry.name, entry.idempotencyKey, {
    fence: false, actorId, args: resolvedArgs ?? entry.args ?? null, opEpoch: entry.opEpoch ?? null,
  });
  await localDb.syncOutbox.update(entry.localId, { protocol: "lookup" });
  if (absent) {
    await park(entry, "needs-server-086", NOT_RECORDED_HELD_TEXT, 30 * 60_000);
    return "backoff";
  }
  if (error || !status) {
    // Could not ask (network, timeout, server error): try again later, same
    // entry, nothing sent.
    const err = error ?? new RpcError("No status reply", { failure: { klass: "UNKNOWN_OUTCOME", mayHaveCommitted: true, retryable: true, hold: null } });
    if (err.failure.klass === "AUTH_REAUTH" || err.failure.klass === "AUTH_REFRESH") return holdOrRetry(entry, err);
    await park(entry, "status-unreachable", `The server could not be asked about this operation (${err.message}). Kept; asked again later — never resent.`,
      Math.max(computeBackoffMs(entry.attempts + 1), 30_000));
    useSyncStore.getState().setStatus({ lastTransientError: err.message });
    return err.failure.hold ? "backoff" : "network";
  }
  switch (status.status) {
    case "committed": {
      if (status.withheld || status.responsePurged || status.response == null) return acknowledgeCommittedWithoutReply(entry);
      const problem = replyProblem(entry.name, status.response);
      if (problem) {
        await park(entry, "unrecognised-reply", `Applied on the server, but its stored reply could not be read (${problem}). Kept.`, 30 * 60_000);
        return "next";
      }
      return (await applyServerReply(entry, status.response, "lookup")) === "network" ? "network" : "next";
    }
    case "rejected":
      await markFinal(entry, "rejected", status.message ?? "the details are visible to the person who entered it or an administrator.", "lookup");
      return "next";
    case "abandoned":
      await markFinal(entry, "abandoned",
        "the server records it as stopped before it ran, so it can never be applied. Enter it again as a new operation if it is still needed.", "lookup");
      return "next";
    case "in_flight":
      await park(entry, "in-flight", "The server is still processing this operation. Asked again shortly.", Math.max(computeBackoffMs(entry.attempts + 1), 5_000));
      return "backoff";
    case "unavailable":
      await park(entry, "outcome-unavailable",
        "The server cannot report on this operation to this till. Kept with its original key; never resent. An administrator should check it.", 30 * 60_000);
      return "backoff";
    case "not_found":
    default:
      if (status.reason === "expired") {
        await holdForReconciliation(entry,
          "Too old for the server to confirm. It is never sent and never stopped automatically; an owner must check the server records and reconcile it.",
          24 * 60 * 60_000);
      } else {
        await holdForReconciliation(entry, RECONCILIATION_REQUIRED_TEXT, 30 * 60_000);
      }
      // Undecided and waiting for an owner: later entries proven independent
      // of it continue (the drain passes it while it waits); anything that may
      // depend on it waits with it (H2).
      return "next";
  }
}

/**
 * The server says COMMITTED but this till cannot read the reply. Never
 * guessed: the entry stays (in doubt — its decrease keeps counting) until a
 * full reload from the server has the authoritative rows; only then is it
 * acknowledged, its provisional rows dropped and its stock effect released
 * — once. An operation other queued entries reference (their provisional
 * ids need the server's) waits for someone who can read the reply.
 */
async function acknowledgeCommittedWithoutReply(entry: SyncOutboxEntry): Promise<DrainResult | "next"> {
  const ids = new Set((entry.provisional ?? []).flatMap((p) => p.ids));
  if (ids.size) {
    const others = await localDb.syncOutbox.filter((r) => r.localId !== entry.localId && r.status !== "reconciled").toArray();
    if (others.some((r) => (r.refs ?? []).some((ref) => ids.has(ref.provisionalId)))) {
      await park(entry, "committed-reply-unavailable",
        "Applied on the server, but its reply belongs to another user. Later entries need it: sign in as the person who entered it, or an administrator.",
        5 * 60_000);
      return "next";
    }
  }
  await localDb.syncOutbox.update(entry.localId, {
    status: keptStatus(entry, "pending"), syncingSince: undefined, inDoubt: true, heldReason: "committed-verifying",
    lastError: "Applied on the server; confirming it by reloading the server's records.",
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
  });
  notifyQueueChanged(entry);
  if (!(await verifiedReload())) {
    await localDb.syncOutbox.update(entry.localId, {
      nextAttemptAt: new Date(Date.now() + Math.max(computeBackoffMs(entry.attempts + 1), 60_000)).toISOString(),
      attempts: entry.attempts + 1,
    });
    return "network";
  }
  releaseEntry(entry.localId);
  await deleteLocalRows(entry.provisional);
  await acknowledgeEntry(entry.localId, [], { source: "verified-reload", responseUnavailable: "unreadable" });
  notifyQueueChanged(entry);
  // Drop the provisional rows from what is shown (they are no longer queued).
  void verifiedReload();
  return "next";
}

const malformedReply = (rpc: string, problem: string, status?: number): RpcError =>
  new RpcError(`Unrecognised reply from ${rpc} (${problem}) — outcome unknown; kept and resent with the same key.`, {
    status, code: "MALFORMED_REPLY", failure: { ...classifyFailure({ status: 200 }), klass: "MALFORMED_SUCCESS" },
  });

/** Consecutive credential rejections on one entry before the till is told
 *  to sign in again (the first one is retried after a forced refresh). */
const REAUTH_AFTER_FAILURES = 2;

/**
 * Keep a retryable failure's entry for a later resend with the same key,
 * and decide how this pass ends. An outcome that may have committed marks
 * the entry in doubt (never cleared by a retry alone); a hold records why
 * it waits and backs off at least the hold's floor; a server Retry-After is
 * honoured. Credentials: refreshed once, then "sign in again".
 */
async function holdOrRetry(entry: SyncOutboxEntry, error: RpcError): Promise<DrainResult> {
  const { failure } = error;
  const attempts = entry.attempts + 1;
  const authFailures = failure.klass === "AUTH_REAUTH" ? (entry.authFailures ?? 0) + 1 : 0;
  const delay = Math.max(computeBackoffMs(attempts), holdBackoffMs(failure.hold), failure.retryAfterMs ?? 0);
  await localDb.syncOutbox.update(entry.localId, {
    // A held recovery stays "conflict" (downgrade safety), whatever the failure.
    status: entry.fenceRequired === true ? "conflict" : "pending",
    syncingSince: undefined,
    attempts,
    failureKind: "transient",
    lastError: entry.fenceRequired === true ? `${NOT_YET_CONFIRMED_TEXT} (${error.message})` : error.message,
    inDoubt: entry.inDoubt === true || failure.mayHaveCommitted,
    heldReason: failure.klass === "MALFORMED_SUCCESS" ? "unrecognised-reply" : failure.hold ?? undefined,
    authFailures,
    nextAttemptAt: new Date(Date.now() + delay).toISOString(),
  });
  notifyQueueChanged(entry);
  useSyncStore.getState().setStatus({ lastTransientError: error.message });

  if (failure.klass === "AUTH_REAUTH") {
    let refreshed = false;
    if (authFailures < REAUTH_AFTER_FAILURES) {
      try {
        const res = await supabase.auth.refreshSession();
        refreshed = !res.error && Boolean(res.data?.session);
      } catch {
        refreshed = false;
      }
    }
    if (!refreshed) {
      await setNeedsReauth("The server rejected this device's sign-in. Sign in again to resume syncing.");
      return "needs-reauth";
    }
  }
  return failure.hold === null && failure.klass !== "MALFORMED_SUCCESS" ? "network" : "backoff";
}

// ----------------------------------------------------------------------
// Queue inspection / management (Sync Conflicts page)
// ----------------------------------------------------------------------

export async function listOutboxConflicts(): Promise<SyncOutboxEntry[]> {
  const rows = (await localDb.syncOutbox.where("status").equals("conflict").toArray()) as OutboxRow[];
  return rows.sort(byQueueOrder);
}

/** Every entry that hasn't reached the server yet — pending (queued or
 *  auto-retrying after a transient failure) and conflicts alike, in queue
 *  order (the order the drain replays them), so the Sync page can show
 *  both and tell them apart. */
export async function listOutboxEntries(): Promise<SyncOutboxEntry[]> {
  const rows = (await localDb.syncOutbox.toArray()) as OutboxRow[];
  return rows.sort(byQueueOrder);
}

/** Give a conflicted (or backing-off) entry another chance right now —
 *  e.g. after a manager corrects the shop's stock so a re-run of the same
 *  sale might succeed. Clears the backoff window as well as the status. */
export async function retryOutboxEntry(localId: string): Promise<void> {
  // A quarantined entry belongs to another backend: retrying it here would
  // send it to the wrong server. It can only be exported and reconciled.
  const entry = await localDb.syncOutbox.get(localId);
  if (!entry) return;
  await requireRecoveryV1Write(entry.orgId ?? useAuthStore.getState().currentOrgId ?? null, entry.shopId);
  if (entry.status === "archived") {
    throw new Error("This entry is set aside. An owner restores it first (Set aside list), then it syncs again.");
  }
  if (entry.status === "reconciled") {
    throw new Error("This entry was reconciled by the owner. It is never sent again from this till.");
  }
  if (entry.serverOutcome) {
    throw new Error(entry.serverOutcome === "abandoned"
      ? "This operation was stopped before the server applied it; it can never be sent. Enter it again as a new operation if it is still needed."
      : "The server refused this operation for good; it is never sent again. Enter a new one if it is still needed.");
  }
  if (entry.status === "quarantined" || !belongsToBackend(entry, currentBackendOrigin())) {
    throw new Error("This entry was queued for another server and cannot be retried here. Export it for the owner.");
  }
  if (entry.fenceRequired === true) {
    // Held for confirmation: "retry" asks the server again now — it is never
    // resent, and it stays out of every older build's automatic queue.
    await localDb.syncOutbox.update(localId, { nextAttemptAt: undefined });
    notifyQueueChanged();
    return;
  }
  // Being sent right now (this or another window): its reply decides it.
  if (entry.status === "syncing" || (await rowsInFlightAnywhere()).has(localId)) {
    throw new Error("This entry is being sent right now. Wait for its outcome (or a restart's check with the server) — it is never sent twice.");
  }
  // An attempt never authorised offline: "retry" means ask the server, never
  // resend. One proven authorised keeps its proof (staged).
  const held = await localDb.transaction("rw", localDb.syncOutbox, localDb.shifts, localDb.stockTransfers, localDb.syncState, async () => {
    const row = await localDb.syncOutbox.get(localId);
    if (!row) return true;
    // (re-checked atomically: a drain may have started sending it meanwhile)
    if (row.status === "syncing") throw new Error("This entry is being sent right now. Wait for its outcome (or a restart's check with the server) — it is never sent twice.");
    const auth = row.kind === "rpc" && (row.inDoubt === true || row.writeAhead === true) ? await offlineAuthorisation(row) : "authorised";
    if (row.kind === "rpc" && auth === "never") {
      holdForRecovery(row);
      await localDb.syncOutbox.put(row);
      await journalRowChanged(row, "held-on-retry");
      return true;
    }
    await localDb.syncOutbox.update(localId, {
      status: "pending", lastError: undefined, nextAttemptAt: undefined, failureKind: undefined,
      blocksQueue: undefined, dependencySince: undefined, refWaitSince: undefined,
      ...(row.kind === "rpc" && row.writeAhead === true && row.staged === undefined && auth === "authorised" ? { staged: true } : {}),
    });
    return false;
  });
  void held;
  notifyQueueChanged();
}

/** An entry whose outcome nobody has established: it was sent (or may have
 *  been) and the server has not decided it for this till yet. */
export const isUndecided = (entry: SyncOutboxEntry): boolean =>
  entry.kind === "rpc" && !entry.serverOutcome && Boolean(entry.idempotencyKey)
  && (entry.fenceRequired === true || entry.inDoubt === true || entry.status === "syncing" || entry.statusBeforeArchive === "syncing");

/**
 * Owner action: ask the server what became of an undecided operation —
 * READ-ONLY (W10 Phase 0). Committed -> recorded on this till; rejected /
 * abandoned -> the server's decision is kept. "Not found" stops nothing: it
 * is "not-found" (the server has no record — it may never have arrived, or
 * it may have been lost by a restore of the server), and the owner decides
 * with stopOnServer. Nothing is ever resent.
 */
export async function confirmWithServer(localId: string): Promise<"committed" | "rejected" | "abandoned" | "not-found" | "undecided"> {
  const entry = await localDb.syncOutbox.get(localId);
  if (entry && (entry.status === "quarantined" || !belongsToBackend(entry, currentBackendOrigin()))) {
    // Never asked of a server it was not queued for: "not found" here proves
    // nothing about the server it was sent to.
    throw new Error("This entry was queued for another server. It can only be checked against that server (export it for the owner); nothing was asked or changed here.");
  }
  // Owner action: enforced here, not only in the UI.
  if (!isOwnerSession()) throw new OutboxActionError("not-owner", "Only the owner (administrator) can confirm an entry with the server.");
  let notFound = false;
  const r = await settleBeforeReplacement([localId], {
    fence: () => false, readOnly: true,
    notFound: async (e) => {
      notFound = true;
      // Only an attempt never authorised offline waits for an owner; one
      // authorised offline is a real operation the queue sends with its key.
      if (e.localId === localId && e.fenceRequired === true && (await localDb.syncOutbox.get(localId))) {
        await holdForReconciliation(e, RECONCILIATION_REQUIRED_TEXT, 30 * 60_000);
      }
    },
  });
  const after = await localDb.syncOutbox.get(localId);
  await ownerAudit(localId, `confirm-with-server (lookup only): ${r === "committed" ? "committed (recorded)" : after?.serverOutcome ?? (notFound ? "not found on the server — not stopped; an owner decides" : "not decided")}${
    entry && ownedByOther(entry, currentActorId()) ? ` (entered by ${actorOf(entry)})` : ""}`);
  if (r === "committed") return "committed";
  const row = await localDb.syncOutbox.get(localId);
  if (row?.serverOutcome === "rejected" || row?.serverOutcome === "abandoned") return row.serverOutcome;
  return notFound ? "not-found" : "undecided";
}

/** The owner's written statement must say what they decided and why. */
export const STOP_STATEMENT_MIN = 15;

/**
 * EXPLICIT owner decision (W10 Phase 0): stop (fence) an undecided operation
 * on the server so it can never run — only after the owner has established,
 * outside the system, that it did not happen (or will be entered again). The
 * statement is recorded in the till's journal and audit log. If the server
 * was restored from an older backup and this operation had in fact been
 * applied there, stopping it makes it unrecordable under its key: the
 * dialog says so. Never called automatically.
 */
export async function stopOnServer(localId: string, statement: string): Promise<"committed" | "rejected" | "abandoned" | "undecided"> {
  if (!isOwnerSession()) throw new OutboxActionError("not-owner", "Only the owner (administrator) can stop an operation on the server.");
  const text = statement.trim();
  if (text.length < STOP_STATEMENT_MIN) throw new Error(`Write down what you established and why it may be stopped (at least ${STOP_STATEMENT_MIN} characters). Nothing was changed.`);
  const entry = await localDb.syncOutbox.get(localId);
  if (!entry) throw new OutboxActionError("not-found", "This entry is no longer on this till.");
  await requireRecoveryV1Write(entry.orgId ?? useAuthStore.getState().currentOrgId ?? null, entry.shopId, { requireDevice: false });
  const myOrg = useAuthStore.getState().currentOrgId ?? null;
  if (entry.orgId && entry.orgId !== myOrg) throw new Error("This entry belongs to another organisation; only its own owner can decide it. Nothing was changed.");
  if (entry.status === "quarantined" || !belongsToBackend(entry, currentBackendOrigin())) {
    throw new Error("This entry was queued for another server; it cannot be stopped here. Nothing was changed.");
  }
  if (!isUndecided(entry)) throw new Error("The server's outcome of this entry is already known, or it was never sent; there is nothing to stop.");
  if ((await localDb.transaction("r", localDb.syncOutbox, localDb.shifts, localDb.stockTransfers, () => offlineAuthorisation(entry))) !== "never") {
    throw new Error("This operation was authorised offline: it is a real operation waiting to be sent, and is never stopped. Set it aside or reconcile it instead.");
  }
  await localDb.transaction("rw", localDb.syncState, () => journalOwner(entry, "owner-stop-requested", text));
  const r = await settleBeforeReplacement([localId], { fence: (e) => e.localId === localId, fencedFor: "owner" });
  const row = await localDb.syncOutbox.get(localId);
  await ownerAudit(localId, `stop-on-server (owner statement: ${text.slice(0, 160)}): ${r === "committed" ? "it HAD been applied — recorded, not stopped" : row?.serverOutcome ?? "not decided (nothing changed)"}`);
  if (r === "committed") return "committed";
  if (row?.serverOutcome === "rejected" || row?.serverOutcome === "abandoned") return row.serverOutcome;
  return "undecided";
}

/**
 * Before a person enters a REPLACEMENT for earlier attempts of the same
 * operation, every earlier attempt is settled with the SERVER (stabilization
 * pass A/B). `earlier` are the attempts as they were when the person was
 * asked — durable references (key, name, arguments, actor, backend), so a
 * row that disappears meanwhile (a drain committed and acknowledged it, or
 * reconciled it) is never mistaken for "it did not happen":
 *  - each one is asked again under the drain lock, by its OWN key, row or
 *    no row: committed -> recorded ("committed": nothing new may be
 *    created); rejected / abandoned (fenced now if the server never saw it)
 *    -> the replacement may proceed; in flight, unknown, unreachable, no
 *    086 -> "blocked";
 *  - an attempt queued for ANOTHER backend (or quarantined) is never looked
 *    up or fenced here — a "not found" from this server proves nothing
 *    about that one -> "blocked".
 */
export async function settleBeforeReplacement(
  earlier: (string | SyncOutboxEntry)[],
  opts: {
    fence?: (entry: SyncOutboxEntry) => boolean; notFound?: (entry: SyncOutboxEntry) => Promise<void>;
    fencedFor?: "replacement" | "owner"; readOnly?: boolean;
  } = {},
): Promise<"proceed" | "committed" | "blocked"> {
  // W10 Phase 0: a replacement never stops anything on a server this till
  // suspects was restored (the continuity warning). Read-only lookups and the
  // owner's explicit decision (stopOnServer) still run.
  if (!opts.readOnly && opts.fencedFor !== "owner" && (await continuityWarning())) return "blocked";
  const snapshots: SyncOutboxEntry[] = [];
  for (const ref of earlier) {
    const snap = typeof ref === "string" ? await localDb.syncOutbox.get(ref) : ref;
    if (!snap) return "blocked";                 // no durable reference to ask about
    snapshots.push(snap);
  }
  const origin = currentBackendOrigin();
  for (const snap of snapshots) {
    if (snap.status === "quarantined" || !belongsToBackend(snap, origin)) return "blocked";
  }
  const run = async (): Promise<"proceed" | "committed" | "blocked"> => {
    const busy = await rowsInFlightAnywhere();
    let committed = false;
    let reloadNeeded = false;
    for (const snap of snapshots) {
      await renewLease();
      if (busy.has(snap.localId)) return "blocked";   // the original is being sent right now
      const row = await localDb.syncOutbox.get(snap.localId);
      if (row && (row.status === "quarantined" || !belongsToBackend(row, origin))) return "blocked";
      if (row?.serverOutcome) continue;              // decided on the server: rejected / abandoned
      const subject = row ?? snap;
      if (subject.kind !== "rpc" || !subject.idempotencyKey) return "blocked";
      // A replacement (the person enters the operation again) fences the
      // earlier attempt if the server never saw it: the replacement records
      // the operation, so it exists once either way — also when the earlier
      // one was lost by a restore of the server.
      const fence = opts.fence ? opts.fence(subject) : true;
      const { absent, status, error } = await lookupOperation(subject.name, subject.idempotencyKey, {
        fence, actorId: actorOf(subject), args: (row ? await resolveArgs(row) : null) ?? subject.args ?? null, opEpoch: subject.opEpoch ?? null,
      });
      if (absent || error || !status) return "blocked";
      if (status.status === "committed") {
        committed = true;
        if (!row || row.status === "reconciled") {
          // Already recorded on this till (or by the owner): just refresh.
          reloadNeeded = true;
        } else if (status.withheld || status.responsePurged || status.response == null || replyProblem(row.name, status.response)) {
          const done = await acknowledgeCommittedWithoutReply(row);
          if (done !== "next" || (await localDb.syncOutbox.get(row.localId))) return "blocked";
        } else if ((await applyServerReply(row, status.response)) !== "ok") {
          return "blocked";
        }
      } else if (status.status === "rejected") {
        if (row && row.status !== "reconciled") await markFinal(row, "rejected", status.message ?? "the details are visible to the person who entered it or an administrator.", "lookup");
      } else if (status.status === "abandoned") {
        if (row && row.status !== "reconciled") {
          await markFinal(row, "abandoned", status.fenced === true
            ? "the server had no record of it and it has now been stopped there (by this till), so it can never run under its key."
            : "the server records it as stopped before it ran.", "lookup", status.fenced === true ? opts.fencedFor ?? "replacement" : undefined);
        }
      } else {
        if (status.status === "not_found" && !fence && row && opts.notFound) await opts.notFound(row);
        return "blocked";                            // in flight, unavailable, not fenced
      }
    }
    if (reloadNeeded) void verifiedReload();
    return committed ? "committed" : "proceed";
  };
  // Never alongside a drain pass of this instance (the Dexie lease cannot
  // tell the two apart): wait for it (bounded); another window's pass holds
  // the lock.
  for (let i = 0; draining && i < 200; i++) await new Promise((r) => setTimeout(r, 100));
  if (draining) return "blocked";
  draining = true;
  try {
    return await withDrainLockOr(run, "blocked");
  } finally {
    draining = false;
  }
}

// ----------------------------------------------------------------------
// Set aside / restore (RC2, D1 — replaces RC1's hard-deleting "Dismiss")
// ----------------------------------------------------------------------
// No staff action deletes an unsynced entry. "Set aside" only takes it out
// of the sync queue: the row keeps its payload, idempotency key and
// history, is listed under "Set aside", is part of every export and still
// counts as unsynced for the updater guard. Owner (ADMIN) only, and only
// for an entry exported in this app session. Permanent removal does not
// exist in the app; the owner reconciles from the export file
// (tools/queue-recovery) and the row stays until then.

export type OutboxActionErrorCode = "not-found" | "not-owner" | "export-first" | "already-set-aside" | "not-set-aside" | "reconciled";

export class OutboxActionError extends Error {
  readonly code: OutboxActionErrorCode;
  constructor(code: OutboxActionErrorCode, message: string) {
    super(message);
    this.name = "OutboxActionError";
    this.code = code;
  }
}

/** Owner = ADMIN, as resolved from the server-verified app user at sign-in
 *  (authStore.currentRole). */
export function isOwnerSession(): boolean {
  const { currentUserId, currentRole } = useAuthStore.getState();
  return Boolean(currentUserId) && currentRole === "ADMIN";
}

export async function setAsideOutboxEntry(
  localId: string,
  opts: { wasExported: (localId: string) => boolean; reason?: string; now?: Date },
): Promise<SyncOutboxEntry> {
  if (!isOwnerSession()) {
    throw new OutboxActionError("not-owner", "Only the owner (administrator) can set an entry aside.");
  }
  if (!opts.wasExported(localId)) {
    throw new OutboxActionError("export-first", "Export pending transactions first (in this session), keep the file, then set the entry aside.");
  }
  const actor = useAuthStore.getState().currentUserId ?? undefined;
  const before = await localDb.syncOutbox.get(localId);
  if (before) await requireRecoveryV1Write(before.orgId ?? useAuthStore.getState().currentOrgId ?? null, before.shopId, { requireDevice: false });
  const updated = await localDb.transaction("rw", localDb.syncOutbox, localDb.syncState, async () => {
    const entry = await localDb.syncOutbox.get(localId);
    if (!entry) throw new OutboxActionError("not-found", "This entry is no longer in the queue (it may have synced).");
    if (entry.status === "archived") throw new OutboxActionError("already-set-aside", "This entry is already set aside.");
    if (entry.status === "reconciled") throw new OutboxActionError("reconciled", "This entry is reconciled; it is kept as it is.");
    const next: SyncOutboxEntry = {
      ...entry,
      status: "archived",
      statusBeforeArchive: entry.status,
      archivedAt: (opts.now ?? new Date()).toISOString(),
      archivedBy: actor,
      archiveReason: opts.reason?.slice(0, 500),
      nextAttemptAt: undefined,
    };
    await localDb.syncOutbox.put(next);
    await journalOwner(next, "set-aside", opts.reason);
    return next;
  });
  void refreshSyncStatus();
  notifyQueueChanged(updated);
  // Set aside is NOT "cancelled" and NOT "never executed": the entry, its key
  // and its conservative stock reservation stay; it just stops blocking.
  await ownerAudit(localId, `set-aside (was ${updated.statusBeforeArchive ?? "?"}; not cancelled — its outcome is ${updated.serverOutcome ?? (isUndecided(updated) ? "UNKNOWN (it may have been applied)" : "not established")})${
    ownedByOther(updated, currentActorId()) ? `, entered by ${actorOf(updated)}` : ""}`);
  return updated;
}

/** Put a set-aside entry back where it was (owner only). A former
 *  `syncing` entry comes back as `pending`; a former quarantined one stays
 *  quarantined (and an entry for another backend is re-quarantined by the
 *  next drain). Same payload and idempotency key. */
export async function restoreSetAsideEntry(localId: string): Promise<SyncOutboxEntry> {
  if (!isOwnerSession()) {
    throw new OutboxActionError("not-owner", "Only the owner (administrator) can restore a set-aside entry.");
  }
  const beforeRestore = await localDb.syncOutbox.get(localId);
  if (beforeRestore) await requireRecoveryV1Write(beforeRestore.orgId ?? useAuthStore.getState().currentOrgId ?? null, beforeRestore.shopId, { requireDevice: false });
  const restored = await localDb.transaction("rw", localDb.syncOutbox, localDb.shifts, localDb.stockTransfers, localDb.syncState, async () => {
    const entry = await localDb.syncOutbox.get(localId);
    if (!entry) throw new OutboxActionError("not-found", "This entry is no longer on this till.");
    if (entry.status !== "archived") throw new OutboxActionError("not-set-aside", "This entry is not set aside.");
    const before = entry.statusBeforeArchive ?? "pending";
    const next: SyncOutboxEntry = { ...entry, status: before === "syncing" ? "pending" : before };
    // An entry whose outcome is unknown (it was being sent, or is in doubt)
    // is never blindly resent: never authorised offline -> held (lookup +
    // fence first); authorised offline (staged) -> in doubt, resent only with
    // its own key (the server answers a committed key from its ledger).
    if (entry.kind === "rpc" && !entry.serverOutcome && before !== "quarantined" && (before === "syncing" || entry.inDoubt === true)) {
      if ((await offlineAuthorisation(entry)) === "never") {
        holdForRecovery(next);
      } else {
        next.inDoubt = true;
        next.staged = true;
      }
    }
    delete next.statusBeforeArchive;
    delete next.archivedAt;
    delete next.archivedBy;
    delete next.archiveReason;
    delete next.syncingSince;
    await localDb.syncOutbox.put(next);
    await journalOwner(next, "restored-to-queue");
    return next;
  });
  void refreshSyncStatus();
  notifyQueueChanged(restored);
  await ownerAudit(localId, `restore -> ${restored.status}${restored.fenceRequired ? " (held: looked up before anything is sent)" : ""}`);
  return restored;
}

export async function listSetAsideEntries(): Promise<SyncOutboxEntry[]> {
  const rows = (await localDb.syncOutbox.where("status").equals("archived").toArray()) as OutboxRow[];
  return rows.sort(byQueueOrder);
}

export async function countPendingOutbox(): Promise<number> {
  // Held recoveries ("conflict" + fenceRequired, no server decision) still
  // need the server's answer: they count, so the periodic drain asks again.
  const queued = await localDb.syncOutbox.where("status").anyOf("pending", "syncing", "failed").count();
  const held = await localDb.syncOutbox.where("status").equals("conflict").filter(isHeldRecovery).count();
  return queued + held;
}

/** Everything the server does not have yet and the owner has not
 *  reconciled, whatever the status (pending, syncing, failed, conflict,
 *  quarantined, set aside). A quick count only: the desktop updater guard's
 *  report (lib/updateGuardBridge.ts) uses blockingOutboxRows() from
 *  ./reconcile, which also counts a reconciled row whose integrity check
 *  fails (and sends it back to Set aside). */
export async function countUnsyncedOutbox(): Promise<number> {
  return localDb.syncOutbox.filter((r) => r.status !== "reconciled").count();
}

export async function listReconciledEntries(): Promise<SyncOutboxEntry[]> {
  const rows = (await localDb.syncOutbox.where("status").equals("reconciled").toArray()) as OutboxRow[];
  return rows.sort(byQueueOrder);
}
