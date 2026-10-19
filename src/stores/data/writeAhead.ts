import { localDb, type SyncOutboxEntry } from "../../lib/localDb";
import { useSyncStore } from "../syncStore";
import { belongsToBackend, currentBackendOrigin } from "../../lib/backendOrigin";
import type { InventoryMovement } from "../../types";
import { classifyFailure, failureInfo } from "../../lib/failureClass";
import { appliedLedger, flushStockCommit, noteStagedStock, snapshotStock } from "./stockLedger";
import {
  acknowledgeEntry, buildOutboxRow, clearWriteAheadInFlight, discardWriteAhead, drainOutbox, markWriteAheadInFlight,
  blockingEarlierWork, NOT_YET_CONFIRMED_TEXT, notifyQueueChanged, persistStaged, settleBeforeReplacement,
} from "./outbox";
import { callRpc, currentActorId, RpcError, stampOperationArgs, type OperationContext } from "./idempotentRpc";
import { replyProblem } from "./replyShapes";
import { getJournalRecord, journalReplacement } from "./opJournal";
import type { LocalRowBatch } from "./localWrites";
import {
  askAboutUnresolved, PendingConfirmationError, UnresolvedOperationError, type UnresolvedOperationInfo,
} from "./operationPrompt";

export { PendingConfirmationError } from "./operationPrompt";

/** A sync-layer warning shown with the queue status (non-fatal). */
const syncWarning = (message: string): void => {
  try { useSyncStore.getState().setStatus({ lastTransientError: message }); } catch { /* status only */ }
};

// ----------------------------------------------------------------------
// Write-ahead lifecycle for offline-capable operations (Batch 2A, plan v2
// §5.1; P0-D).
//
//  1. The arguments are built ONCE (key, event time, actor stamped) and
//     frozen. Online, a `syncing` outbox row carrying exactly those
//     arguments is written BEFORE the first request — a crash, a lost
//     reply, a refused fallback can no longer leave a committed sale with
//     no durable record, and a second Confirm can never mint a new key for
//     an operation that is still unresolved.
//  2. The reply decides:
//       POSTED (valid shape)       → apply the server result, remove the row
//       definitive refusal         → remove the row, show the error (D-10(a));
//                                    also suspension / sign-in / server-version
//                                    refusals: nothing is staged offline
//       definitely NOT delivered   → the normal offline path, with its checks
//                                    (12 h window, local stock); the same row
//                                    becomes `pending`
//       outcome UNKNOWN            → the row becomes `pending` + inDoubt, same
//                                    key. It is staged locally ONLY if the
//                                    offline rules allow it (correction pass:
//                                    a transport failure is not evidence that
//                                    the server committed, and ambiguity never
//                                    authorises otherwise-ineligible offline
//                                    trading). Staged or not, the person is
//                                    told "pending confirmation"
//                                    (PendingConfirmationError) — never
//                                    "recorded", never "failed".
//  3. Offline (or the operation references something still provisional):
//     staged and queued directly.
//
// Every local staging is committed atomically with its outbox row
// (persistStaged) and only then applied to the in-memory store.
//
// Re-entry (correction pass): before anything is sent, a durable row of the
// same operation whose outcome is still unknown (in doubt, or left mid-send
// by a crash) is looked for. Finding one, the person decides — wait for the
// earlier one, or (where repeating is legitimate, e.g. a sale) enter a
// genuinely new one — and the default is never to send.
// ----------------------------------------------------------------------

type EnqueueInput = Parameters<typeof buildOutboxRow>[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoreSetter = (updater: any) => void;

/** Collects one operation's local effects; committed by the engine. */
export class Stage {
  readonly rows: LocalRowBatch[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly updaters: any[] = [];
  entry: EnqueueInput | null = null;
  readonly mode: StageMode;
  /** The write-ahead row this staging converts: its own effect may already
   *  be shown (counted while it was being sent) and must not be counted a
   *  second time by the stock checks. */
  readonly ownId: string | null;
  constructor(mode: StageMode, ownId: string | null = null) {
    this.mode = mode;
    this.ownId = ownId;
  }
  /** Displayed stock for a row, without this operation's own shown effect —
   *  both read from the same in-memory state, at the same moment. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qty(get: () => any, shopId: string, productId: string): number {
    const own = this.ownId ? appliedLedger().get(this.ownId)?.get(`${shopId}|${productId}`) ?? 0 : 0;
    return get().getInventoryQty(shopId, productId) - own;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set(updater: any): void { this.updaters.push(updater); }
  put(rows: LocalRowBatch): void { this.rows.push(rows); }
  enqueue(entry: EnqueueInput): void {
    if (this.entry) throw new Error("One operation stages exactly one outbox entry.");
    this.entry = entry;
  }
}

/** "offline": an ordinary offline operation (queued, not yet sent).
 *  "in-doubt": the request may already have committed — staged under the
 *  SAME offline rules, but marked "pending confirmation". */
export type StageMode = "offline" | "in-doubt";

export interface OfflineCapableSpec<T> {
  /** The slice's Zustand setter (local effects are applied through it). */
  set: StoreSetter;
  name: string;
  shopId: string | null;
  op: OperationContext;
  /** Arguments without stamping; built once by the caller's shared builder. */
  args: Record<string, unknown>;
  /** The operation references rows that are themselves still provisional
   *  (e.g. a sale on a shift opened offline): it can only be queued. */
  needsProvisionalRefs?: boolean;
  /** Apply an authoritative (validated) reply to the store/mirror. `ackId`
   *  is the write-ahead row being acknowledged (stockLedger.serverStockRows). */
  applyOnline: (data: unknown, ackId: string) => T | Promise<T>;
  /** Stage the operation locally (the previous offline path, parameterised). */
  stage: (stage: Stage) => Promise<T>;
}

/** Operations a person may legitimately repeat with identical arguments. */
const REPEATABLE = new Set(["complete_sale", "adjust_stock", "record_supplier_payment"]);

const FRIENDLY: Record<string, string> = {
  complete_sale: "Sale", adjust_stock: "Stock adjustment", open_shift: "Open shift", close_shift: "Close shift",
  receive_purchase_order: "Purchase order receipt", record_supplier_payment: "Supplier payment",
  dispatch_stock_transfer: "Transfer dispatch", receive_stock_transfer: "Transfer receipt",
  create_refund_void_request: "Refund / void request",
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Double-press guard: an identical submission still running returns the same promise. */
const inFlightByIntent = new Map<string, Promise<unknown>>();

/** Tests only: a new app instance has no submission running. */
export function resetWriteAheadForTests(): void {
  inFlightByIntent.clear();
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
/** What the operation does, without the per-attempt fields. */
export const intentOf = (name: string, args: Record<string, unknown>): string => {
  const { p_idempotency_key: _k, p_created_at: _c, p_expected_actor_id: _a, ...rest } = args;
  void _k; void _c; void _a;
  return `${name}:${canonical(rest)}`;
};

/** Every earlier attempt of the same intent whose outcome nobody has
 *  established — whatever its queue status (H1): sending or in doubt,
 *  HELD for lookup ("conflict" + fenceRequired), parked, or set aside by an
 *  owner before the server decided it. Only a server decision (committed ->
 *  reconciled and gone; rejected / abandoned -> serverOutcome) ends it. */
async function unresolvedTwins(name: string, intent: string): Promise<SyncOutboxEntry[]> {
  // "quarantined": an attempt queued for another backend still counts — this
  // server cannot tell whether that one ran (it always blocks a replacement).
  const rows = await localDb.syncOutbox.where("status").anyOf("pending", "syncing", "failed", "conflict", "archived", "quarantined").toArray();
  return rows.filter((r) => r.kind === "rpc" && r.name === name && !r.serverOutcome
    && (r.writeAhead === true || r.fenceRequired === true)
    && (r.status === "syncing" || r.inDoubt === true || r.fenceRequired === true || r.statusBeforeArchive === "syncing")
    && intentOf(name, r.args ?? {}) === intent);
}

export const describeEntry = (entry: SyncOutboxEntry): UnresolvedOperationInfo => {
  const items = Array.isArray(entry.args?.p_items) ? (entry.args!.p_items as unknown[]).length : null;
  const label = FRIENDLY[entry.name] ?? entry.name;
  return {
    kind: entry.name === "complete_sale" ? "sale" : "operation",
    summary: items != null ? `${label} · ${items} item${items === 1 ? "" : "s"}` : label,
    createdAt: entry.createdAt,
  };
};

/** Run an offline-capable operation through the write-ahead lifecycle. */
export async function submitOfflineCapable<T>(spec: OfflineCapableSpec<T>): Promise<T> {
  const args = deepFreeze(stampOperationArgs(spec.name, spec.args, spec.op.idempotencyKey));
  const intent = intentOf(spec.name, args);
  const running = inFlightByIntent.get(intent);
  if (running) return running as Promise<T>;
  const promise = guardedRun(spec, args, intent).finally(() => inFlightByIntent.delete(intent));
  inFlightByIntent.set(intent, promise);
  return promise;
}

async function guardedRun<T>(spec: OfflineCapableSpec<T>, args: Record<string, unknown>, intent: string): Promise<T> {
  const twins = await unresolvedTwins(spec.name, intent);
  if (twins.length) {
    const allowNew = REPEATABLE.has(spec.name);
    const decision = await askAboutUnresolved({ existing: twins.map(describeEntry), allowRetry: true, allowNew });
    if (decision === "retry") {
      // The earlier one is resent with ITS key by the queue — never a new one.
      void drainOutbox().catch(() => undefined);
      throw new PendingConfirmationError(
        "The earlier attempt is awaiting the server's confirmation and is being resent with its original key. Do not enter it again.",
      );
    }
    if (decision !== "new" || !allowNew) {
      throw new UnresolvedOperationError(
        "An earlier attempt of this operation is still awaiting confirmation. Nothing was sent.", twins.map(describeEntry),
      );
    }
    // G1 Stage 1: a replacement only once every earlier attempt is known not
    // to have happened — asked, and stopped on the server (fenced) if it
    // never arrived. If one DID happen, it is recorded instead.
    // The twins as they were when the person was asked: durable references
    // (key, arguments, backend), re-checked with the server even if a row
    // disappears meanwhile (stabilization A).
    const origin = currentBackendOrigin();
    if (twins.some((t) => t.status === "quarantined" || !belongsToBackend(t, origin))) {
      throw new UnresolvedOperationError(
        "An earlier attempt was queued for another server. This server cannot tell whether it was applied there, so nothing new was entered. Export it for the owner to check against that server.",
        twins.map(describeEntry),
      );
    }
    const settled = await settleBeforeReplacement(twins);
    if (settled === "committed") {
      throw new PendingConfirmationError(
        "The earlier attempt reached the server and has now been recorded on this till. Nothing new was entered — do not ring it up again.",
      );
    }
    if (settled !== "proceed") {
      throw new UnresolvedOperationError(
        "The earlier attempt could not be confirmed or stopped with the server right now. Nothing new was entered; it is kept with its original key — try again when the server can be reached.",
        twins.map(describeEntry),
      );
    }
    // Every earlier attempt is now decided on the server. Another attempt
    // that appeared meanwhile (another window) is not: nothing new.
    const again = await unresolvedTwins(spec.name, intent);
    if (again.length) {
      throw new UnresolvedOperationError(
        "Another attempt of this operation appeared while the earlier one was being confirmed. Nothing new was entered.",
        again.map(describeEntry),
      );
    }
    // The till's journal links the replacement to the attempts it replaces —
    // only once the replacement exists on this till (its own record).
    const earlierKeys = twins.map((t) => t.idempotencyKey).filter((k): k is string => typeof k === "string");
    try {
      return await run(spec, args);
    } finally {
      if (await getJournalRecord(spec.op.idempotencyKey).catch(() => null)) {
        await localDb.transaction("rw", localDb.syncState, () => journalReplacement(spec.op.idempotencyKey, earlierKeys))
          .catch((err) => console.error(`[sync] ${spec.name}: could not link the replacement in the journal:`, err));
      }
    }
  }
  return run(spec, args);
}

/** `ownId`: the write-ahead row this staging converts — its effect may
 *  already be shown (it was counted while being sent). */
async function stageAndCommit<T>(
  spec: OfflineCapableSpec<T>, mode: StageMode,
  outbox: (entry: EnqueueInput) => Parameters<typeof persistStaged>[1],
  ownId: string | null = null,
): Promise<T> {
  const stage = new Stage(mode, ownId);
  const result = await spec.stage(stage);
  if (!stage.entry) throw new Error(`${spec.name}: the offline path staged no outbox entry.`);
  const target = outbox(stage.entry);
  await persistStaged(stage.rows, target);
  const before = snapshotStock();
  for (const updater of stage.updaters) spec.set(updater);
  // Record the staging's stock effect in the ledger (stockLedger.ts).
  const localId = "put" in target ? target.put.localId : target.update.localId;
  noteStagedStock(localId, stage.rows.flatMap((r) => (r.movements ?? []) as InventoryMovement[]), before);
  return result;
}

async function run<T>(spec: OfflineCapableSpec<T>, args: Record<string, unknown>): Promise<T> {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (offline || spec.needsProvisionalRefs) {
    return stageAndCommit(spec, "offline", (entry) => ({
      put: buildOutboxRow({ ...entry, args, idempotencyKey: spec.op.idempotencyKey }, { staged: true }),
    }));
  }
  // An online operation never overtakes an unsent entry of this till that it
  // may depend on (a close before its queued sales, a sale before a queued
  // restock — entries being sent right now included). It is queued behind
  // them under the offline rules; if those refuse it, nothing is sent.
  // Entries it is proven independent of (dependencies.ts) do not hold it.
  if ((await blockingEarlierWork({ kind: "rpc", name: spec.name, args, shopId: spec.shopId, actorId: currentActorId() })).length) {
    let result: T;
    try {
      result = await stageAndCommit(spec, "offline", (entry) => ({
        put: buildOutboxRow({ ...entry, args, idempotencyKey: spec.op.idempotencyKey }, { staged: true }),
      }));
    } catch (err) {
      throw new Error(`Not sent: earlier entries on this till have not reached the server yet, and this cannot be queued behind them (${
        err instanceof Error ? err.message : String(err)}). Let the queue finish (Sync), then try again.`);
    }
    void drainOutbox().catch(() => undefined);
    return result;
  }

  // 1. Write-ahead: durable BEFORE the first request. The in-flight mark
  //    (a cross-window lock where available) is taken FIRST, so no other
  //    window's recovery can pick the row up while it is being sent.
  const sentAt = new Date().toISOString();
  const row = buildOutboxRow(
    { kind: "rpc", name: spec.name, args, idempotencyKey: spec.op.idempotencyKey, shopId: spec.shopId },
    { status: "syncing", writeAhead: true, syncingSince: sentAt, sentAt },
  );
  await markWriteAheadInFlight(row.localId);
  try {
    try {
      await persistStaged([], { put: row });
    } catch (err) {
      throw new Error(`Not saved and nothing was sent — try again (${err instanceof Error ? err.message : String(err)}).`);
    }
    return await sendAndResolve(spec, args, row.localId);
  } finally {
    clearWriteAheadInFlight(row.localId);
  }
}

const notConfirmed = (detail: string) => new PendingConfirmationError(
  `Pending confirmation: ${detail} It is saved with its original key and will be confirmed automatically — do not enter it again.`,
);

async function sendAndResolve<T>(spec: OfflineCapableSpec<T>, args: Record<string, unknown>, localId: string): Promise<T> {
  // 2. One attempt, bounded; the reply must have the expected shape.
  const outcome = await callRpc(spec.name, args);
  let error: RpcError | null = outcome.error;
  if (!error && outcome.responseUnavailable) {
    // Committed on the server, but this till cannot read the reply (086
    // withholds another user's reply; a purged one is gone). Not guessed:
    // kept as unconfirmed; the queue reconciles it by a verified reload.
    error = new RpcError(`The server applied ${spec.name}, but its reply is not readable on this till`, {
      status: outcome.status, code: "REPLY_UNAVAILABLE", failure: failureInfo("MALFORMED_SUCCESS"),
    });
  }
  if (!error) {
    const problem = replyProblem(spec.name, outcome.data);
    if (problem) {
      error = new RpcError(`Unrecognised reply from ${spec.name} (${problem})`, {
        status: outcome.status, code: "MALFORMED_REPLY",
        failure: { ...classifyFailure({ status: 200 }), klass: "MALFORMED_SUCCESS" },
      });
    }
  }

  if (!error) {
    const result = await spec.applyOnline(outcome.data, localId);
    // Stock rows on disk with the ledger before the row goes.
    await flushStockCommit(localId).catch((err) => console.error(`[sync] ${spec.name}: stock mirror write failed:`, err));
    try {
      // The queue row goes and the journal keeps the server's reply — together.
      await acknowledgeEntry(localId, [], { source: "reply", response: outcome.data });
    } catch (err) {
      // The server committed it (its reply is applied above); the till could
      // not record that durably (e.g. storage full). The queue row stays: it
      // is confirmed later with its own key (answered from the server's
      // ledger), never sent as a new operation.
      console.error(`[sync] ${spec.name}: committed, but its acknowledgement could not be recorded on this till; kept for confirmation:`, err);
      syncWarning(`A ${spec.name} was applied on the server, but this till could not record it (storage). It is kept and confirmed again with its key.`);
    }
    notifyQueueChanged();
    return result;
  }

  const { failure } = error;
  // Definitive refusals, and refusals that must not be traded around offline
  // (a missing prerequisite or another user's operation is shown at the
  // counter, as before 086 — nothing was recorded on the server).
  // NOT_RECORDED: the server refused it without recording the refusal —
  // nothing ran, the reply arrived (no copy is in flight): shown, not
  // staged, and never presented as a final refusal.
  if (!failure.retryable || failure.hold === "suspended" || failure.hold === "reauth" || failure.hold === "backend-version"
      || failure.klass === "DEPENDENCY" || failure.klass === "WRONG_ACTOR" || failure.klass === "NOT_RECORDED") {
    await discardWriteAhead(localId, failure.klass, { serverOutcome: outcome.serverOutcome ?? null, code: error.code ?? null, message: error.message });
    throw error;
  }

  // The row may have been taken over (e.g. confirmed by another window where
  // locks are unavailable): never stage or report a failure for it here.
  if (!(await localDb.syncOutbox.get(localId))) {
    throw notConfirmed("this operation is being confirmed elsewhere on this till.");
  }

  const pendingChanges = (inDoubt: boolean, entry: EnqueueInput): Partial<SyncOutboxEntry> => ({
    status: "pending", syncingSince: undefined, attempts: 1, failureKind: "transient", lastError: error!.message,
    // Staged under the offline rules: authorised to reach the server later.
    staged: true, fenceRequired: false,
    inDoubt, heldReason: failure.klass === "MALFORMED_SUCCESS" ? "unrecognised-reply" : failure.hold ?? undefined,
    provisional: entry.provisional, refs: entry.refs, shopId: entry.shopId ?? spec.shopId,
    // Resend promptly with the same key (a committed attempt is answered
    // from the server's ledger); only a server-requested delay holds it.
    nextAttemptAt: failure.retryAfterMs ? new Date(Date.now() + failure.retryAfterMs).toISOString() : undefined,
  });

  if (!failure.mayHaveCommitted) {
    // Definitely not applied: the ordinary offline path, with its checks.
    try {
      return await stageAndCommit(spec, "offline", (entry) => ({ update: { localId, changes: pendingChanges(false, entry) } }), localId);
    } catch (err) {
      await discardWriteAhead(localId, "offline-path-refused");
      throw err;
    }
  }

  // Outcome unknown: the row is kept either way. It is staged locally only
  // under the ordinary offline rules (sign-in window, local stock).
  try {
    await stageAndCommit(spec, "in-doubt", (entry) => ({ update: { localId, changes: pendingChanges(true, entry) } }), localId);
  } catch (err) {
    // Not staged (offline rules refused it, or the local write failed). The
    // durable row stays — pending, in doubt, same key; its stock effect is
    // derived from its arguments (pendingStock.ts).
    // G1 Stage 1 (C1): it was NOT authorised offline, so it must never be
    // resent: held ("conflict" + fenceRequired — no build ever sends that
    // automatically); the queue asks the server and fences it if the server
    // never saw it (or keeps holding it when the server cannot be asked).
    await persistStaged([], {
      update: {
        localId,
        changes: {
          ...pendingChanges(true, { kind: "rpc", name: spec.name, shopId: spec.shopId }),
          provisional: undefined, staged: false, fenceRequired: true,
          status: "conflict", heldReason: "outcome-unknown", lastError: NOT_YET_CONFIRMED_TEXT, nextAttemptAt: undefined,
        },
      },
    }).catch(() => undefined);
    if (error.code === "REPLY_UNAVAILABLE") {
      throw notConfirmed("the server applied it, but this till cannot read its reply; it is being confirmed from the server's records.");
    }
    console.error(`[sync] ${spec.name}: outcome unknown and not staged locally; kept for confirmation:`, err);
    throw new PendingConfirmationError(
      `Not recorded on this till: the server did not answer, so it may or may not have received this${
        err instanceof Error && err.message ? ` (${err.message})` : ""}. It will NOT be sent again: the till asks the server ` +
      "what happened to it. If the server has no record of it, it waits for an owner — it is not stopped automatically, and " +
      "a delayed copy of this request may still arrive. Check Sync before entering it again.",
    );
  }
  throw notConfirmed("the server's reply was lost. It is shown on this till as unconfirmed.");
}
