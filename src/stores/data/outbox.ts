import { supabase } from "../../lib/supabase";
import { belongsToBackend, currentBackendOrigin, quarantineForeignOutboxEntries } from "../../lib/backendOrigin";
import { localDb, SYNC_STATE_KEYS, type SyncOutboxEntry } from "../../lib/localDb";
import { newId } from "../../lib/id";
import { isDuplicateError, isNetworkError } from "../../lib/errors";
import { replayTableWrite } from "./tableWrite";
import { callRpc, IDEMPOTENCY_KEY_ARG, newIdempotencyKey, RPC_TIMEOUT_MS, runRequest, type RpcOutcome } from "./idempotentRpc";
import { useAuthStore } from "../authStore";
import { useSyncStore } from "../syncStore";
import { touchAuthCache } from "../authCache";

type EnqueueInput = Pick<
  SyncOutboxEntry,
  "kind" | "name" | "args" | "shopId" | "provisional" | "refs" | "table" | "op" | "row" | "id" | "idempotencyKey"
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

async function pendingInQueueOrder(): Promise<OutboxRow[]> {
  const rows = (await localDb.syncOutbox.where("status").anyOf("pending", "failed").toArray()) as OutboxRow[];
  return rows.sort(byQueueOrder);
}

// RPCs that accept p_expected_actor_id (see migration 055) — the queuing
// user's app id is stamped on at enqueue time and checked again at replay,
// so a queued action can't silently execute under whoever happens to be
// logged in when the device reconnects (a shared till, another cashier).
// complete_sale is deliberately excluded — it already checks shift
// ownership independently, and doesn't declare this param.
const ACTOR_STAMPED_RPCS = new Set([
  "adjust_stock",
  "receive_purchase_order",
  "record_supplier_payment",
  "open_shift",
  "close_shift",
  "create_refund_void_request",
  "dispatch_stock_transfer",
  "receive_stock_transfer",
]);

/**
 * Queue a mutation for replay. RPC entries always carry an idempotency key
 * (the caller's, minted when the operation was created — or a fresh one
 * for legacy callers), stored both on the entry and inside `args` as
 * `p_idempotency_key` so the replay payload is exactly what gets sent.
 */
export async function enqueueOutbox(entry: EnqueueInput): Promise<void> {
  let args = entry.args;
  let idempotencyKey = entry.idempotencyKey;
  if (entry.kind === "rpc") {
    const existing = args?.[IDEMPOTENCY_KEY_ARG];
    idempotencyKey = idempotencyKey ?? (typeof existing === "string" ? existing : newIdempotencyKey());
    args = { ...(args ?? {}), [IDEMPOTENCY_KEY_ARG]: idempotencyKey };
    if (ACTOR_STAMPED_RPCS.has(entry.name)) {
      args = { ...args, p_expected_actor_id: useAuthStore.getState().currentUserId ?? null };
    }
  }
  const row: OutboxRow = {
    ...entry,
    args,
    idempotencyKey,
    // Which backend this entry is for (blocker D-d): the drain sends it only
    // to this origin; anywhere else it is quarantined (lib/backendOrigin.ts).
    backendOrigin: currentBackendOrigin(),
    localId: newId("outbox"),
    createdAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
  };
  // The read-max + put run in one transaction so two enqueues cannot be
  // handed the same seq.
  await localDb.transaction("rw", localDb.syncOutbox, async () => {
    const existing = (await localDb.syncOutbox.toArray()) as OutboxRow[];
    row.seq = existing.reduce((max, e) => Math.max(max, e.seq ?? 0), 0) + 1;
    await localDb.syncOutbox.put(row);
  });
  void refreshSyncStatus();
}

/** Record that a provisional (offline-minted) id turned out to be `realId`
 *  once its outbox entry synced — called by reconcilers for anything a
 *  later-queued entry might reference (e.g. reconcileOpenShift). */
export async function recordIdMapping(provisionalId: string, realId: string): Promise<void> {
  if (provisionalId === realId) return;
  await localDb.provisionalIdMap.put({ provisionalId, realId, createdAt: new Date().toISOString() });
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
 *  resolve). One transaction, so an entry queued meanwhile is seen. */
export async function pruneProvisionalIdMap(now: number = Date.now()): Promise<number> {
  const cutoff = now - PROVISIONAL_MAP_MAX_AGE_MS;
  return localDb.transaction("rw", localDb.syncOutbox, localDb.provisionalIdMap, async () => {
    const referenced = referencedProvisionalIds(await localDb.syncOutbox.toArray());
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
  return localDb.transaction("rw", localDb.syncOutbox, async () => {
    let n = 0;
    await localDb.syncOutbox.where("status").equals("syncing").modify((entry: SyncOutboxEntry) => {
      const since = entry.syncingSince ? Date.parse(entry.syncingSince) : Number.NaN;
      if (olderThanMs > 0 && Number.isFinite(since) && now - since < olderThanMs) return;
      entry.status = "pending";
      entry.attempts = (entry.attempts ?? 0) + 1;
      entry.failureKind = "transient";
      entry.lastError = "Interrupted while sending (no reply from the server). Resent with the same idempotency key, so it cannot be applied twice.";
      entry.nextAttemptAt = undefined;
      delete entry.syncingSince;
      n += 1;
    });
    return n;
  });
}

let startupRecoveryDone = false;

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
type Reconciler = (data: unknown, provisional: SyncOutboxEntry["provisional"]) => void;
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
  const locks = getLockManager();
  if (locks) {
    const result = await locks.request(DRAIN_LOCK_NAME, { ifAvailable: true }, async (lock) =>
      lock ? fn() : "locked",
    );
    return result as DrainResult;
  }
  if (!(await acquireLease())) return "locked";
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
  await pruneProvisionalIdMap();
  // Never send an entry to a backend other than the one it was queued for
  // (main.tsx does this at startup too; repeated here so the drain does not
  // depend on it). Quarantined entries are not "pending" and are skipped.
  if ((await quarantineForeignOutboxEntries(localDb, currentBackendOrigin())) > 0) await refreshSyncStatus();
  const queued = await localDb.syncOutbox.where("status").anyOf("pending", "failed").count();
  if (queued === 0) return "drained";

  const session = await ensureSessionForDrain();
  if (session === "network") return "network";
  if (session === "needs-reauth") {
    await setNeedsReauth("The server rejected this device's sign-in. Sign in again to resume syncing.");
    return "needs-reauth";
  }
  await clearNeedsReauth();

  for (;;) {
    await renewLease();
    const pending = await pendingInQueueOrder();

    // Skip past entries still waiting on a dependency (e.g. a sale queued
    // against a shift opened in the same offline session) rather than
    // stalling the whole queue behind them.
    let entry: SyncOutboxEntry | null = null;
    let resolvedArgs: Record<string, unknown> | null = null;
    for (const candidate of pending) {
      const args = await resolveArgs(candidate);
      if (args) {
        entry = candidate;
        resolvedArgs = args;
        break;
      }
    }
    if (!entry) {
      // Nothing ready to send. Flag anything that's been blocked on a
      // dependency for too long — otherwise it sits `pending` forever,
      // indistinguishable from "hasn't had a chance yet".
      const now = Date.now();
      for (const candidate of pending) {
        if (!candidate.refs?.length) continue;
        if (now - Date.parse(candidate.createdAt) < STUCK_ENTRY_MAX_AGE_MS) continue;
        await localDb.syncOutbox.update(candidate.localId, {
          status: "conflict",
          failureKind: "permanent",
          lastError: "Stuck waiting on a dependency that never synced — its parent entry may need to be retried or this one dismissed.",
        });
      }
      return "drained";
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

    // Entries queued before Phase D carry no key (the Dexie v2 upgrade
    // assigns one, but be safe) — mint it now so that from this attempt on
    // every retry is idempotent.
    if (entry.kind === "rpc" && !entry.idempotencyKey) {
      const key = typeof resolvedArgs?.[IDEMPOTENCY_KEY_ARG] === "string"
        ? (resolvedArgs[IDEMPOTENCY_KEY_ARG] as string)
        : newIdempotencyKey();
      entry.idempotencyKey = key;
      entry.args = { ...(entry.args ?? {}), [IDEMPOTENCY_KEY_ARG]: key };
      resolvedArgs = { ...(resolvedArgs ?? {}), [IDEMPOTENCY_KEY_ARG]: key };
      await localDb.syncOutbox.update(entry.localId, { idempotencyKey: key, args: entry.args });
    }

    await localDb.syncOutbox.update(entry.localId, { status: "syncing", syncingSince: new Date().toISOString() });

    const outcome: RpcOutcome = entry.kind === "table_write"
      ? await runRequest(replayTableWrite(entry.table!, entry.op!, entry.row, entry.id!), entry.name)
      : await callRpc(entry.name, resolvedArgs ?? {});

    if (outcome.error) {
      // A table_write insert's id is client-minted, so a duplicate-key
      // reply on replay means our earlier attempt committed before the
      // response was lost — the write is already on the server.
      const alreadyApplied =
        entry.kind === "table_write" && entry.op === "insert" && isDuplicateError(outcome.error);

      if (!alreadyApplied && outcome.error.transient) {
        const attempts = entry.attempts + 1;
        await localDb.syncOutbox.update(entry.localId, {
          status: "pending",
          syncingSince: undefined,
          attempts,
          failureKind: "transient",
          lastError: outcome.error.message,
          nextAttemptAt: new Date(Date.now() + computeBackoffMs(attempts)).toISOString(),
        });
        useSyncStore.getState().setStatus({ lastTransientError: outcome.error.message });
        return "network";
      }

      if (!alreadyApplied) {
        await localDb.syncOutbox.update(entry.localId, {
          status: "conflict",
          syncingSince: undefined,
          attempts: entry.attempts + 1,
          failureKind: "permanent",
          nextAttemptAt: undefined,
          lastError: outcome.error.message,
        });
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
    const reconcile = reconcilers[entry.name];
    if (reconcile) reconcile(outcome.data, entry.provisional);
    await localDb.syncOutbox.delete(entry.localId);
    useSyncStore.getState().setStatus({ lastTransientError: null });
  }
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
  if (entry.status === "archived") {
    throw new Error("This entry is set aside. An owner restores it first (Set aside list), then it syncs again.");
  }
  if (entry.status === "quarantined" || !belongsToBackend(entry, currentBackendOrigin())) {
    throw new Error("This entry was queued for another server and cannot be retried here. Export it for the owner.");
  }
  await localDb.syncOutbox.update(localId, {
    status: "pending", lastError: undefined, nextAttemptAt: undefined, failureKind: undefined,
  });
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

export type OutboxActionErrorCode = "not-found" | "not-owner" | "export-first" | "already-set-aside" | "not-set-aside";

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
  const updated = await localDb.transaction("rw", localDb.syncOutbox, async () => {
    const entry = await localDb.syncOutbox.get(localId);
    if (!entry) throw new OutboxActionError("not-found", "This entry is no longer in the queue (it may have synced).");
    if (entry.status === "archived") throw new OutboxActionError("already-set-aside", "This entry is already set aside.");
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
    return next;
  });
  void refreshSyncStatus();
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
  const restored = await localDb.transaction("rw", localDb.syncOutbox, async () => {
    const entry = await localDb.syncOutbox.get(localId);
    if (!entry) throw new OutboxActionError("not-found", "This entry is no longer on this till.");
    if (entry.status !== "archived") throw new OutboxActionError("not-set-aside", "This entry is not set aside.");
    const before = entry.statusBeforeArchive ?? "pending";
    const next: SyncOutboxEntry = { ...entry, status: before === "syncing" ? "pending" : before };
    delete next.statusBeforeArchive;
    delete next.archivedAt;
    delete next.archivedBy;
    delete next.archiveReason;
    delete next.syncingSince;
    await localDb.syncOutbox.put(next);
    return next;
  });
  void refreshSyncStatus();
  return restored;
}

export async function listSetAsideEntries(): Promise<SyncOutboxEntry[]> {
  const rows = (await localDb.syncOutbox.where("status").equals("archived").toArray()) as OutboxRow[];
  return rows.sort(byQueueOrder);
}

export async function countPendingOutbox(): Promise<number> {
  return localDb.syncOutbox.where("status").anyOf("pending", "syncing", "failed").count();
}

/** Everything the server does not have yet, whatever the status (pending,
 *  syncing, failed, conflict, quarantined, set aside). The desktop updater guard
 *  (electron/updateGuard.cjs) refuses to install while this is non-zero. */
export async function countUnsyncedOutbox(): Promise<number> {
  return localDb.syncOutbox.count();
}
