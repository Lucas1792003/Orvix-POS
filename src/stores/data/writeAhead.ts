import { localDb, type SyncOutboxEntry } from "../../lib/localDb";
import { useSyncStore } from "../syncStore";
import { belongsToBackend, currentBackendOrigin } from "../../lib/backendOrigin";
import type { InventoryMovement } from "../../types";
import { classifyFailure, failureInfo } from "../../lib/failureClass";
import { appliedLedger, flushStockCommit, noteStagedStock, snapshotStock } from "./stockLedger";
import {
  acknowledgeEntry, buildOutboxRow, clearWriteAheadInFlight, discardWriteAhead, drainOutbox, markWriteAheadInFlight, OWNER_REVIEW,
  blockingEarlierWork, NOT_YET_CONFIRMED_TEXT, notifyQueueChanged, persistStaged, settleBeforeReplacement,
} from "./outbox";
import { callRpc, currentActorId, RpcError, stampOperationArgs, v87Routing, type OperationContext } from "./idempotentRpc";
import { replyProblem } from "./replyShapes";
import { getJournalRecord, journalReplacement } from "./opJournal";
import { assertOfflineQueueAllowed, gateNewOperation, recoveryRefusalError } from "./recoveryGate";
import { RecoveryBlockedError, noteAuthorizationLost, offlineFinancialBlockedError, offlineFinancialOpsBlocked } from "./recoveryState";
import type { LocalRowBatch } from "./localWrites";
import { useConnectivityStore } from "../connectivityStore";
import {
  askAboutUnresolved, PendingConfirmationError, SessionEndedError, UnresolvedOperationError, type UnresolvedOperationInfo,
} from "./operationPrompt";

/** v87.x: an operation whose outcome is unknown on an 087 server — held for confirmation, never staged. */
class HeldOnRecoveryServer extends Error {
  constructor() { super(""); }
}

export { PendingConfirmationError } from "./operationPrompt";

/** Step 6 (PDISC-A): an operation that may only be SENT NOW (never staged, queued or recorded offline) and could not be.
 *  Nothing was saved or sent. */
export class MustSendNowError extends Error {
  constructor(message: string) { super(message); this.name = "MustSendNowError"; }
}

/** The till is offline by any account (the browser, or the connectivity store the UI shows). */
const tillOffline = (): boolean =>
  (typeof navigator !== "undefined" && navigator.onLine === false) || useConnectivityStore.getState().isOnline === false;

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
  /** Step 4: the value this operation counts against an offline capability (a sale's total). */
  offlineAmountMmk?: number;
  /** Step 6 (PDISC-A): the operation is sent NOW or not at all — never staged, queued behind earlier work or recorded
   *  offline (a discount that needs an approval; a sale naming a single-use, expiring approval). The messages say why
   *  it was refused; nothing is saved or sent when it is. */
  mustSendNow?: { offline: string; backlog: string };
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

/**
 * The logical scope an attempt belongs to, for operations a person re-enters
 * by hand: a sale re-rung after "pending confirmation" may come back with the
 * items in another order or another tender, so its exact arguments differ
 * but it is still the same customer's sale. Same shop, same shift, same
 * cashier: possibly the same sale. Stock adjustment: same shop and product.
 * null = matched by exact arguments only.
 */
export const scopeOf = (name: string, args: Record<string, unknown>, actorId: string | null | undefined): string | null => {
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  if (name === "complete_sale") return `${name}|${s(args.p_shop_id)}|${s(args.p_shift_id)}|${s(actorId)}`;
  if (name === "adjust_stock") return `${name}|${s(args.p_shop_id)}|${s(args.p_product_id)}`;
  return null;
};

/** Every earlier attempt whose outcome nobody has established — whatever its
 *  queue status (H1): sending or in doubt, HELD for lookup ("conflict" +
 *  fenceRequired), parked, or set aside by an owner before the server
 *  decided it. Only a server decision (committed -> reconciled and gone;
 *  rejected / abandoned -> serverOutcome) ends it.
 *  `twins`: the same intent (identical arguments). `overlapping`: another
 *  intent in the same logical scope (scopeOf) — possibly the same sale
 *  re-entered differently, possibly a genuinely separate one; never
 *  decided here. */
/** How long an unresolved attempt counts as possibly the same sale re-rung. */
export const SIMILAR_WINDOW_MS = 10 * 60_000;

/** Products a sale's items name (similar = at least one in common). */
const productsOf = (args: Record<string, unknown> | undefined): Set<string> =>
  new Set(Array.isArray(args?.p_items) ? (args!.p_items as { product_id?: unknown }[]).map((i) => String(i.product_id)) : []);

async function unresolvedAttempts(
  name: string, intent: string, scope: string | null, args?: Record<string, unknown>,
): Promise<{ twins: SyncOutboxEntry[]; overlapping: SyncOutboxEntry[] }> {
  // "quarantined": an attempt queued for another backend still counts — this
  // server cannot tell whether that one ran (it always blocks a replacement).
  const rows = await localDb.syncOutbox.where("status").anyOf("pending", "syncing", "failed", "conflict", "archived", "quarantined").toArray();
  const unresolved = rows.filter((r) => r.kind === "rpc" && r.name === name && !r.serverOutcome
    && (r.writeAhead === true || r.fenceRequired === true)
    && (r.status === "syncing" || r.inDoubt === true || r.fenceRequired === true || r.statusBeforeArchive === "syncing"));
  const twins = unresolved.filter((r) => intentOf(name, r.args ?? {}) === intent);
  const mine = productsOf(args);
  const shareProduct = (r: SyncOutboxEntry) => name !== "complete_sale" || [...productsOf(r.args)].some((p) => mine.has(p));
  // A re-ring follows the "pending confirmation" message within minutes; an
  // attempt older than that is not plausibly the same sale entered again
  // (an outage must not make every later sale ask). A queued offline entry
  // the outbox is merely sending is not an uncertain attempt either.
  const recent = (r: SyncOutboxEntry) => Date.now() - Date.parse(r.createdAt) <= SIMILAR_WINDOW_MS;
  const uncertain = (r: SyncOutboxEntry) => r.inDoubt === true || r.fenceRequired === true || r.staged !== true;
  const overlapping = scope === null ? [] : unresolved.filter((r) =>
    intentOf(name, r.args ?? {}) !== intent
    && scopeOf(name, r.args ?? {}, (r.args?.p_expected_actor_id as string | undefined) ?? r.actorId) === scope
    && shareProduct(r) && recent(r) && uncertain(r));
  return { twins, overlapping };
}

export const describeEntry = (entry: SyncOutboxEntry): UnresolvedOperationInfo => {
  const items = Array.isArray(entry.args?.p_items) ? (entry.args!.p_items as { qty?: unknown }[]) : null;
  const label = FRIENDLY[entry.name] ?? entry.name;
  // Enough for the person to recognise the earlier attempt (item count and
  // quantities, tender) — never cost.
  const units = items?.reduce((n, i) => n + (typeof i.qty === "number" ? i.qty : 0), 0) ?? 0;
  const tender = entry.name === "complete_sale" && typeof entry.args?.p_payment_method === "string"
    ? ` · ${entry.args.p_payment_method}${typeof entry.args.p_paid_mmk === "number" ? ` ${entry.args.p_paid_mmk.toLocaleString()} MMK` : ""}`
    : "";
  return {
    kind: entry.name === "complete_sale" ? "sale" : "operation",
    summary: items != null ? `${label} · ${items.length} item${items.length === 1 ? "" : "s"} (${units} unit${units === 1 ? "" : "s"})${tender}` : label,
    createdAt: entry.createdAt,
  };
};

/** Run an offline-capable operation through the write-ahead lifecycle. */
export async function submitOfflineCapable<T>(spec: OfflineCapableSpec<T>): Promise<T> {
  // 087: nothing is saved or sent unless the till may create a financial
  // operation now (verified epoch, not in recovery mode) — online or offline.
  const mustSend = spec.mustSendNow;
  // Step 6 (PDISC-A): refused BEFORE the gate (which could reserve an offline authorization) and before anything is saved
  if (mustSend && tillOffline()) throw new MustSendNowError(mustSend.offline);
  await gateNewOperation(spec.op, {
    name: spec.name, amountMmk: spec.offlineAmountMmk,
    ...(mustSend ? { refuseOffline: () => new MustSendNowError(mustSend.offline) } : {}),
  });
  if (mustSend && spec.op.offlineAuth) throw new MustSendNowError(mustSend.offline);
  const args = deepFreeze(stampOperationArgs(spec.name, spec.args, spec.op.idempotencyKey));
  const intent = intentOf(spec.name, args);
  const running = inFlightByIntent.get(intent);
  if (running) return running as Promise<T>;
  const promise = guardedRun(spec, args, intent).finally(() => inFlightByIntent.delete(intent));
  inFlightByIntent.set(intent, promise);
  return promise;
}

async function guardedRun<T>(spec: OfflineCapableSpec<T>, args: Record<string, unknown>, intent: string): Promise<T> {
  const scope = scopeOf(spec.name, args, (args.p_expected_actor_id as string | undefined) ?? currentActorId());
  const { twins: exact, overlapping } = await unresolvedAttempts(spec.name, intent, scope, args);
  // An earlier attempt whose outcome is unknown: identical (the same
  // arguments) or similar (same shop, shift and cashier, a product in common
  // — the same sale re-rung in another order, another tender or quantity,
  // or another customer's). The person decides; nothing is decided here:
  //   retry      -> the earlier one is resent with ITS key (default path);
  //   new        -> a REPLACEMENT: the earlier attempt is stopped on the
  //                 server first (recorded instead if it did arrive). Only
  //                 when exactly ONE earlier attempt is in question — an
  //                 attempt the person did not single out is never stopped;
  //   additional -> a genuinely separate operation (another customer): the
  //                 earlier one stays and is confirmed with its own key;
  //   cancel     -> nothing is sent.
  const candidates = exact.length ? exact : overlapping;
  let twins: SyncOutboxEntry[] = [];
  if (candidates.length) {
    const repeatable = REPEATABLE.has(spec.name);
    const canReplace = repeatable && candidates.length === 1;
    const decision = await askAboutUnresolved({
      existing: candidates.map(describeEntry), allowRetry: true, allowNew: canReplace,
      allowAdditional: repeatable, overlap: exact.length ? "identical" : "similar",
    });
    if (decision === "retry") {
      // The earlier one is resent with ITS key by the queue — never a new one.
      void drainOutbox().catch(() => undefined);
      throw new PendingConfirmationError(
        "The earlier attempt is awaiting the server's confirmation and is being resent with its original key. Do not enter it again.",
      );
    }
    if (decision === "additional" && repeatable) return run(spec, args);
    if (decision !== "new" || !canReplace) {
      throw new UnresolvedOperationError(
        exact.length
          ? "An earlier attempt of this operation is still awaiting confirmation. Nothing was sent."
          : "A similar earlier attempt is still awaiting confirmation. Nothing was sent.",
        candidates.map(describeEntry),
      );
    }
    twins = candidates;
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
    const after = await unresolvedAttempts(spec.name, intent, twins === exact ? null : scope, args);
    const again = [...after.twins, ...after.overlapping];
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
  // v87.x, at the shared staging layer too: an OFFLINE staging is refused on an 087 server whoever asks for it
  // ("in-doubt" staging stays: an attempt that may have committed, shown as pending confirmation, same key)
  if (mode === "offline") assertOfflineQueueAllowed("This till is offline.", spec.op.offlineAuth);
  // Step 6 (PDISC-A), the last line of defence: an operation that must be sent now is never staged offline
  if (mode === "offline" && spec.mustSendNow) throw new MustSendNowError(spec.mustSendNow.offline);
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
  // 087: earlier work this may depend on that waits for an OWNER (held for review, or a legacy entry the
  // server will not run): this operation could never be sent behind it — refused at the counter, nothing saved.
  const earlier = await blockingEarlierWork({ kind: "rpc", name: spec.name, args, shopId: spec.shopId, actorId: currentActorId() });
  const review = earlier.filter((r) => !r.serverOutcome && (r.heldReason === OWNER_REVIEW || (v87Routing() && !r.opEpoch)));
  if (review.length) {
    throw new RecoveryBlockedError("hold", "AWAITING_OWNER_REVIEW",
      `Operation awaiting owner review: ${review.length} earlier ${review.length === 1 ? "operation on this till waits" : "operations on this till wait"} for the owner's review after a server recovery, and this one may depend on ${review.length === 1 ? "it" : "them"}. Nothing was saved or sent. Ask the owner to review the Sync page.`);
  }
  // Step 6 (PDISC-A): sent now or not at all — refused before anything is staged when it would be recorded offline
  // or wait behind earlier entries of this till (the approval is single-use and expires; the queue may take longer).
  if (spec.mustSendNow) {
    if (offline || spec.op.offlineAuth || tillOffline()) throw new MustSendNowError(spec.mustSendNow.offline);
    if (spec.needsProvisionalRefs || (await blockingEarlierWork({ kind: "rpc", name: spec.name, args, shopId: spec.shopId, actorId: currentActorId() })).length) {
      throw new MustSendNowError(spec.mustSendNow.backlog);
    }
  }
  // Step 4: authorized under an offline capability = the server could not be reached when it was created: it is
  // recorded LOCALLY (pending, its key and capability reference) and sent by the queue — never presented as accepted.
  if (offline || spec.needsProvisionalRefs || spec.op.offlineAuth) {
    // v87.x: never a new offline operation on an 087 server (nothing saved; the cashier is told why)
    assertOfflineQueueAllowed(spec.needsProvisionalRefs
      ? "It depends on an entry that has not reached the server yet (e.g. a shift opened offline) — let that finish first (Sync)."
      : "This till is offline.", spec.op.offlineAuth);
    return stageAndCommit(spec, "offline", (entry) => ({
      put: buildOutboxRow({ ...entry, args, idempotencyKey: spec.op.idempotencyKey, opEpoch: spec.op.opEpoch, offlineAuth: spec.op.offlineAuth ?? null, discountApprovalId: spec.op.discountApprovalId ?? null }, { staged: true }),
    }));
  }
  // An online operation never overtakes an unsent entry of this till that it
  // may depend on (a close before its queued sales, a sale before a queued
  // restock — entries being sent right now included). It is queued behind
  // them under the offline rules; if those refuse it, nothing is sent.
  // Entries it is proven independent of (dependencies.ts) do not hold it.
  if ((await blockingEarlierWork({ kind: "rpc", name: spec.name, args, shopId: spec.shopId, actorId: currentActorId() })).length) {
    // v87.x: queuing it behind them would make it an offline operation — refused on an 087 server
    assertOfflineQueueAllowed("Earlier entries on this till have not reached the server yet — let them finish (Sync), then enter it again.", spec.op.offlineAuth);
    let result: T;
    try {
      result = await stageAndCommit(spec, "offline", (entry) => ({
        put: buildOutboxRow({ ...entry, args, idempotencyKey: spec.op.idempotencyKey, opEpoch: spec.op.opEpoch, offlineAuth: spec.op.offlineAuth ?? null, discountApprovalId: spec.op.discountApprovalId ?? null }, { staged: true }),
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
    { kind: "rpc", name: spec.name, args, idempotencyKey: spec.op.idempotencyKey, shopId: spec.shopId, opEpoch: spec.op.opEpoch, offlineAuth: spec.op.offlineAuth ?? null, discountApprovalId: spec.op.discountApprovalId ?? null },
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
  // fix 3: who sent it — a reply arriving after a sign-out / account switch
  // is recorded (queue row acknowledged, journal), never applied to the next
  // session's screen or mirror.
  const sentBy = currentActorId();
  // 2. One attempt, bounded; the reply must have the expected shape.
  const outcome = await callRpc(spec.name, args, { opEpoch: spec.op.opEpoch, offlineAuth: spec.op.offlineAuth ?? null, discountApprovalId: spec.op.discountApprovalId ?? null });
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

  if (!error && currentActorId() !== sentBy) {
    await acknowledgeEntry(localId, [], { source: "reply", response: outcome.data }, outcome.signedReply)
      .catch((err) => console.error(`[sync] ${spec.name}: committed after the session ended; acknowledgement not recorded (kept for confirmation):`, err));
    notifyQueueChanged();
    throw new SessionEndedError(spec.name);
  }
  if (!error) {
    const result = await spec.applyOnline(outcome.data, localId);
    // Stock rows on disk with the ledger before the row goes.
    await flushStockCommit(localId).catch((err) => console.error(`[sync] ${spec.name}: stock mirror write failed:`, err));
    try {
      // The queue row goes and the journal keeps the server's reply — together.
      await acknowledgeEntry(localId, [], { source: "reply", response: outcome.data }, outcome.signedReply);
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
  // 087 RECOVERY: refused by the recovery hold — nothing ran, nothing was
  // recorded, and it is NEVER turned into an offline sale: the till is in
  // recovery mode, and the cashier is told so.
  if (!failure.retryable || failure.hold === "suspended" || failure.hold === "reauth" || failure.hold === "backend-version"
      || failure.klass === "DEPENDENCY" || failure.klass === "WRONG_ACTOR" || failure.klass === "NOT_RECORDED" || failure.klass === "RECOVERY") {
    await discardWriteAhead(localId, failure.klass, { serverOutcome: outcome.serverOutcome ?? null, code: error.code ?? null, message: error.message });
    if (failure.klass === "RECOVERY") throw recoveryRefusalError(error.message);
    throw error;
  }

  // The row may have been taken over (e.g. confirmed by another window where
  // locks are unavailable): never stage or report a failure for it here.
  if (!(await localDb.syncOutbox.get(localId))) {
    throw notConfirmed("this operation is being confirmed elsewhere on this till.");
  }
  // v87.x: the server was not reached (or its reply was lost): a recent authorisation no longer counts
  noteAuthorizationLost();

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

  if (!failure.mayHaveCommitted && spec.mustSendNow) {
    // Step 6 (PDISC-A): definitely not applied, and never turned into an offline operation: the attempt is discarded
    await discardWriteAhead(localId, "must-send-now", { code: error.code ?? null, message: error.message });
    throw new MustSendNowError(`The server could not be reached. ${spec.mustSendNow.offline}`);
  }
  if (!failure.mayHaveCommitted) {
    // v87.x: definitely not applied, and on an 087 server it is NOT turned into an offline operation: the attempt is
    // discarded (nothing ran on the server, nothing stays queued) and the cashier is told it was not recorded.
    if (offlineFinancialOpsBlocked()) {
      await discardWriteAhead(localId, "offline-disabled-087", { code: error.code ?? null, message: error.message });
      throw offlineFinancialBlockedError("The server could not be reached (the request did not arrive).");
    }
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
  // v87.x: on an 087 server it is NEVER staged (a staged operation is resent automatically and shown as pending, like
  // an offline sale): it goes straight to the held path below — same key, the queue asks the server what happened.
  try {
    if (offlineFinancialOpsBlocked()) throw new HeldOnRecoveryServer();
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
    if (!(err instanceof HeldOnRecoveryServer)) console.error(`[sync] ${spec.name}: outcome unknown and not staged locally; kept for confirmation:`, err);
    throw new PendingConfirmationError(
      `Not recorded on this till: the server did not answer, so it may or may not have received this${
        err instanceof Error && err.message ? ` (${err.message})` : ""}. It will NOT be sent again: the till asks the server ` +
      "what happened to it. If the server has no record of it, it waits for an owner — it is not stopped automatically, and " +
      "a delayed copy of this request may still arrive. Check Sync before entering it again.",
    );
  }
  throw notConfirmed("the server's reply was lost. It is shown on this till as unconfirmed.");
}
