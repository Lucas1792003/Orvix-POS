import { localDb } from "../../lib/localDb";
import { newId } from "../../lib/id";
import { classifyFailure } from "../../lib/failureClass";
import {
  callRpc, executorCapability, executorDemonstrated, IDEMPOTENCY_KEY_ARG, idempotencyKeyFor, keepUnknown, lookupOperation, ONLINE_ONLY_RETRIES, recoveryModeError, RpcError, stampOperationArgs,
  type OperationStatus, type RpcOutcome,
} from "./idempotentRpc";
import { replyProblem } from "./replyShapes";
import { verifiedReload } from "./verifiedReload";
import { askAboutUnresolved, SessionEndedError, UnresolvedOperationError, type UnresolvedOperationInfo } from "./operationPrompt";
import { useAuthStore } from "../authStore";
import { blockingEarlierWork, drainOutbox, isOwnerSession, ownerAudit } from "./outbox";
import { wasExported } from "../../lib/queueExport/exportRecord";
import { classifyOnlineRecord, UNREADABLE_SET_ASIDE_PREFIX, unreadableInScope, type UnreadableOnlineRecord } from "../../lib/onlineOpRecord";
export { classifyOnlineRecord, type UnreadableOnlineRecord };
import { currentBackendOrigin } from "../../lib/backendOrigin";
import { currentOpEpoch, recoveryBlocksSending } from "./recoveryState";
import { gateNewOperation } from "./recoveryGate";
import { continuityWarning, journalKeyReconciliationRequired, journalOnline, journalReplacement, type JournalEvidence } from "./opJournal";

// ----------------------------------------------------------------------
// Online-only operations with an explicit, persisted identity (Batch 2A,
// Q-H6; rewritten in the correction pass).
//
// Supplier payments, purchase orders, transfers, voids and approvals are
// never queued. Each call is ONE operation with its own id, scoped to the
// organisation and user, saved (with its key and frozen arguments) BEFORE
// the first request:
//
//  - a reply the caller can use (valid shape) settles it;
//  - a definitive refusal, or a failure that proves nothing was applied,
//    settles it too (a later entry is simply a new operation);
//  - an UNKNOWN outcome keeps it unresolved and is reported as "pending
//    confirmation" — never as failed. It stays listed (Sync page, across
//    restarts) and is retried ONLY unchanged, with its original key.
//
// A new submission never silently becomes a retry, and a retry never
// silently becomes a new operation. When something is entered while an
// unresolved operation of the same kind exists (same supplier and shop for
// a payment or purchase order, same shops for a transfer, …), the person
// decides through the app's prompt (operationPrompt.ts): retry the earlier
// one unchanged, or record a genuinely separate new one. With no answer,
// nothing is sent. Operations on one specific record (approve / cancel /
// reject X, update X, void payment X …) are their own identity: the same
// call on the same record while it is unresolved IS the retry.
//
// Age never mints a new key. Since migration 086 the server never prunes a
// v4 / pre-086 key and keeps a UUIDv7 decision for at least 13 months (and
// nothing schedules pruning); on a server WITHOUT 086 the old 062 prune
// (30 days, unscheduled) may still exist. RETRY_WINDOW_MS stays the
// conservative bound: an operation unresolved for longer can no longer be
// retried from here — it is listed as needing manual verification (Check
// status still asks the server, without resending).
// ----------------------------------------------------------------------

const PREFIX = "online-op:";
export const RETRY_WINDOW_MS = 25 * 24 * 60 * 60 * 1000;
const SETTLED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

type Status = "unresolved" | "settled";

export interface OnlineOperation {
  v: 2;
  id: string;
  name: string;
  orgId: string | null;
  userId: string | null;
  fingerprint: string;
  scope: string;
  /** Frozen arguments, key included — what every retry sends. */
  args: Record<string, unknown>;
  status: Status;
  outcome?: "applied" | "refused" | "not-applied" | "abandoned" | "verified-manually";
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  attempts: number;
  /** An attempt's outcome was unknown (it may have been applied). From then
   *  on only the SERVER's answer for this key settles it: a later failure
   *  that never reached the operation (401, network, …) does not. Written
   *  BEFORE every request; a stored operation is treated as uncertain
   *  whether or not it carries the flag (payment-safety pass). */
  uncertain?: boolean;
  /** 087: the server-issued epoch it was created under (never replaced). */
  opEpoch?: string | null;
  /** The backend this operation was created for (origin). Missing on records
   *  of older builds: those are never looked up with a fence, retried or
   *  replaced here — only a read-only Check, or an owner's verification. */
  backendOrigin?: string;
  /** Who decided its settled outcome: the SERVER (its ledger / a success),
   *  this CLIENT's own evidence (a fresh first attempt that provably never
   *  reached the operation), or an OWNER (manual verification). Outcomes are
   *  monotonic: a client decision never overwrites a server or owner one, and
   *  a later attempt whose outcome is unknown re-opens a client decision. */
  decidedBy?: "server" | "client" | "owner";
}

// Operations on one specific record: the record is the identity.
const TARGET_ARG: Record<string, string> = {
  update_supplier: "p_id",
  approve_purchase_order: "p_purchase_order_id",
  cancel_purchase_order: "p_purchase_order_id",
  void_supplier_payment: "p_payment_id",
  approve_stock_transfer: "p_transfer_id",
  reject_stock_transfer: "p_transfer_id",
  cancel_stock_transfer: "p_transfer_id",
  approve_void_request: "p_request_id",
  approve_refund_request: "p_request_id",
  reject_refund_void_request: "p_request_id",
  create_refund_void_request: "p_sale_id",
  delete_product: "p_product_id",
  update_app_user: "p_id",
  deactivate_app_user: "p_id",
  replace_manager: "p_shop_id",
};

// Creations a person may repeat on purpose: the conflict scope.
const CREATION_SCOPE: Record<string, (a: Record<string, unknown>) => string> = {
  pay_supplier_lump_sum: (a) => `${a.p_supplier_id}|${a.p_shop_id}`,
  create_purchase_order: (a) => `${a.p_supplier_id}|${a.p_shop_id}`,
  create_stock_transfer: (a) => `${a.p_from_shop_id}|${a.p_to_shop_id}`,
  create_supplier: (a) => String(a.p_code ?? "").trim().toLowerCase(),
  // Step 4: one shift's drawer (an unresolved movement is offered for retry before a new one is entered)
  fin_record_cash_movement: (a) => String(a.p_shift_id),
};

// Log writes: each call is its own new event; nothing to recover.
const LOGS = new Set(["log_audit_event", "log_receipt_reprint"]);

const FRIENDLY: Record<string, string> = {
  pay_supplier_lump_sum: "Supplier payment", create_purchase_order: "Purchase order", create_stock_transfer: "Stock transfer",
  create_supplier: "New supplier", void_supplier_payment: "Void supplier payment", approve_purchase_order: "Approve purchase order",
  cancel_purchase_order: "Cancel purchase order", approve_stock_transfer: "Approve transfer", reject_stock_transfer: "Reject transfer",
  cancel_stock_transfer: "Cancel transfer", approve_void_request: "Approve void", approve_refund_request: "Approve refund",
  reject_refund_void_request: "Reject refund/void", create_refund_void_request: "Void request", delete_product: "Delete product",
  fin_record_cash_movement: "Cash movement",
  update_supplier: "Update supplier", update_app_user: "Update user", deactivate_app_user: "User status", replace_manager: "Replace manager",
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** The operation's content: what it does, not when or under which key. */
export function operationFingerprint(name: string, args: Record<string, unknown>): string {
  const { [IDEMPOTENCY_KEY_ARG]: _k, p_created_at: _c, p_expected_actor_id: _a, ...rest } = args;
  void _k; void _c; void _a;
  return `${name}:${canonical(rest)}`;
}

const scopeOf = (name: string, args: Record<string, unknown>): string => {
  if (TARGET_ARG[name]) return `${name}#${String(args[TARGET_ARG[name]])}`;
  const creation = CREATION_SCOPE[name];
  return creation ? `${name}#${creation(args)}` : `${name}#${operationFingerprint(name, args)}`;
};

const identity = () => {
  const { currentOrgId, currentUserId } = useAuthStore.getState();
  return { orgId: currentOrgId ?? null, userId: currentUserId ?? null };
};

// ---- storage ----------------------------------------------------------------

// The STORED record is the only truth about an operation (post-checkpoint
// fix): no in-memory "settled" note can hide a stored unresolved operation,
// and every state change is ONE IndexedDB read-check-write transaction on the
// stored record (atomic across windows, reloads and restarts) — never a write
// of a caller's possibly stale copy. The in-flight map below only coalesces a
// double click; it decides nothing.
const inFlight = new Map<string, Promise<RpcOutcome>>();

/** Tests only: a new app instance. */
export function resetOnlineOnlyForTests(): void {
  inFlight.clear();
}

async function save(op: OnlineOperation): Promise<void> {
  // The record and the till's journal entry are written together (W8 Phase 0).
  await localDb.transaction("rw", localDb.syncState, async () => {
    await localDb.syncState.put({ key: PREFIX + op.id, value: JSON.stringify(op), updatedAt: op.updatedAt });
    await journalOnline(op, "created");
  });
}

/** The stored record as an operation, or null when this build cannot read it
 *  (the same rule as classifyOnlineRecord: never acted on). */
const parseOp = (value: string | undefined): OnlineOperation | null => {
  const c = classifyOnlineRecord<OnlineOperation>({ key: "", value });
  return "op" in c ? c.op : null;
};

/** Every stored record, readable or not. Reads fail CLOSED: an unreadable
 *  STORE throws (callers send nothing). */
async function loadRecords(): Promise<{ ops: OnlineOperation[]; unreadable: UnreadableOnlineRecord[] }> {
  const rows = await localDb.syncState.where("key").startsWith(PREFIX).toArray();
  const ops: OnlineOperation[] = [];
  const unreadable: UnreadableOnlineRecord[] = [];
  for (const row of rows) {
    const c = classifyOnlineRecord<OnlineOperation>(row);
    if ("op" in c) ops.push(c.op);
    else unreadable.push(c.unreadable);
  }
  return { ops, unreadable };
}

async function loadAll(): Promise<OnlineOperation[]> {
  return (await loadRecords()).ops;
}

/** Unreadable records that may belong to the signed-in organisation (one
 *  that claims another organisation is not shown here — it is exported from
 *  the sign-in screen, the whole till). */
export async function listUnreadableOnlineRecords(): Promise<UnreadableOnlineRecord[]> {
  const { orgId } = identity();
  return (await loadRecords()).unreadable.filter((r) => unreadableInScope(r, orgId));
}

/** Could this unreadable record be the operation `name` / `scope`? Unless it
 *  names ANOTHER operation (or scope) it might be the same: yes. */
const mayBeSameOperation = (r: UnreadableOnlineRecord, name: string, scope: string): boolean =>
  !(r.claimed.scope && r.claimed.scope !== scope) && !(r.claimed.name && r.claimed.name !== name);

/** Atomically read the stored record, decide, and write the result (or
 *  nothing). `decide` gets the CURRENT stored record; it returns the record
 *  to store, or null to leave it untouched. Throws if the store fails. */
async function transition<T>(
  id: string, decide: (stored: OnlineOperation | null) => { next: OnlineOperation | null; result: T },
  event = "updated", evidence?: Omit<JournalEvidence, "at">,
): Promise<T> {
  return localDb.transaction("rw", localDb.syncState, async () => {
    const row = await localDb.syncState.get(PREFIX + id);
    let current: OnlineOperation | null = null;
    try { current = row ? parseOp(row.value) : null; } catch { current = null; }
    const { next, result } = decide(current);
    if (next) {
      await localDb.syncState.put({ key: PREFIX + id, value: JSON.stringify(next), updatedAt: next.updatedAt });
      // Same transaction: the journal follows every change of the record.
      await journalOnline(next, event, next.status === "settled" ? evidence : undefined);
    }
    return result;
  });
}

const isUnresolved = (op: OnlineOperation) => op.status === "unresolved";
/** Not bound to THIS backend (another origin, or an older record with none):
 *  nothing this server says "not found" about it proves anything. */
export const isForeignOperation = (op: OnlineOperation): boolean => op.backendOrigin !== currentBackendOrigin();
export const isRetryable = (op: OnlineOperation, now = Date.now()) => now - Date.parse(op.createdAt) < RETRY_WINDOW_MS;

const describe = (op: OnlineOperation): UnresolvedOperationInfo => {
  const amount = typeof op.args.p_amount_mmk === "number" ? ` · ${op.args.p_amount_mmk.toLocaleString("en-US")} MMK` : "";
  return { kind: "operation", summary: `${FRIENDLY[op.name] ?? op.name}${amount}`, createdAt: op.createdAt };
};

// ---- the call ------------------------------------------------------------------

/** Ask for a "pending confirmation" error the UI recognises. */
const pendingError = (op: OnlineOperation, cause: RpcError | null, detail: string): RpcError => {
  const err = new RpcError(
    `Pending confirmation: ${detail} It is saved and must not be entered again — retry it from Sync › Unresolved operations.`,
    { status: cause?.status, code: cause?.code ?? "PENDING_CONFIRMATION", failure: cause?.failure ?? { ...classifyFailure({ status: 0 }) } },
  );
  err.name = "PendingConfirmationError";
  (err as RpcError & { operationId?: string }).operationId = op.id;
  return err;
};

const RANK = { client: 1, server: 2, owner: 2 } as const;

/** Settle atomically and monotonically. A client-evidence outcome is written
 *  only by the LATEST attempt of a still-unresolved operation (`attempt` = its
 *  sequence number); a server / owner outcome overwrites an unresolved or a
 *  client-settled record, never another server / owner decision. Returns
 *  whether THIS call decided it. A storage failure decides nothing (the
 *  record stays as it was — unresolved operations stay listed). */
async function settle(
  op: OnlineOperation, outcome: NonNullable<OnlineOperation["outcome"]>,
  by: "server" | "client" | "owner" = "server", attempt?: number, evidence?: Omit<JournalEvidence, "at">,
): Promise<boolean> {
  try {
    return await transition(op.id, (stored) => {
      if (!stored) return { next: null, result: false };
      if (stored.status === "settled" && RANK[stored.decidedBy ?? "server"] >= RANK[by]) return { next: null, result: false };
      if (by === "client" && (stored.status !== "unresolved" || attempt === undefined || stored.attempts !== attempt)) {
        return { next: null, result: false };            // a newer attempt exists: its outcome decides
      }
      return { next: { ...stored, status: "settled", outcome, decidedBy: by, updatedAt: new Date().toISOString() }, result: true };
    }, `settled:${outcome}`, evidence ?? { source: by === "owner" ? "owner" : by === "client" ? "client" : "reply" });
  } catch (err) {
    console.error(`[sync] ${op.name}: could not record its settlement (it stays unresolved):`, err);
    return false;
  }
}

/** Claim the next attempt of an UNRESOLVED operation, atomically: the stored
 *  attempt counter is incremented and the record marked uncertain BEFORE the
 *  request (a crash from here on leaves it uncertain). A settled operation is
 *  never resent. Returns the stored record as claimed, or why not. */
type Claim = { claimed: OnlineOperation } | { refused: OnlineOperation | null };
async function claimAttempt(op: OnlineOperation): Promise<Claim> {
  return transition<Claim>(op.id, (stored) => {
    if (!stored || stored.status !== "unresolved") return { next: null, result: { refused: stored } };
    const claimed: OnlineOperation = { ...stored, attempts: stored.attempts + 1, uncertain: true, updatedAt: new Date().toISOString() };
    return { next: claimed, result: { claimed } };
  }, "attempt");
}

/** An attempt whose outcome is unknown: the operation is unresolved again
 *  (it may have been applied) unless the SERVER or an OWNER has decided it. */
async function reopen(op: OnlineOperation, lastError: string): Promise<"reopened" | "decided"> {
  try {
    return await transition(op.id, (stored) => {
      if (!stored) return { next: null, result: "reopened" as const };
      if (stored.status === "settled" && (stored.decidedBy ?? "server") !== "client") return { next: null, result: "decided" as const };
      return {
        next: { ...stored, status: "unresolved", outcome: undefined, decidedBy: undefined, uncertain: true, lastError, updatedAt: new Date().toISOString() },
        result: "reopened" as const,
      };
    }, "outcome-unknown");
  } catch {
    return "reopened";                                    // nothing written: it was unresolved before the attempt
  }
}

/** `fresh`: the operation was created by this very call and has never been
 *  sent. Every other one (stored, retried, reloaded after a restart, written
 *  by an older build) may already have been applied: only a server decision
 *  (or success) settles it — never a 401, 503, timeout or unreadable reply. */
async function send(op: OnlineOperation, retries: number, fresh = false): Promise<RpcOutcome> {
  if (isForeignOperation(op)) {
    return { data: null, error: pendingError(op, null, "it was made against another server (or by an older version that did not record its server); it can only be verified there or by an owner.") };
  }
  // 087: nothing is sent while the till is in recovery mode (it keeps its key and epoch)
  if (recoveryBlocksSending()) return { data: null, error: recoveryModeError() };
  // Claim the attempt on the STORED record (atomic): never a stale copy, and
  // never a resend of an operation already settled.
  let claim: Awaited<ReturnType<typeof claimAttempt>>;
  try {
    claim = await claimAttempt(op);
  } catch (err) {
    return { data: null, error: pendingError(op, null, `its record could not be read or saved before sending (${err instanceof Error ? err.message : String(err)}); nothing was sent.`) };
  }
  if ("refused" in claim) {
    const s0 = claim.refused;
    return {
      data: null,
      error: pendingError(op, null, s0
        ? `it is already settled (${s0.outcome ?? "decided"}${s0.decidedBy ? ` by the ${s0.decidedBy}` : ""}); nothing was sent — check Sync before entering anything again.`
        : "its record is missing on this till; nothing was sent."),
    };
  }
  const claimed = claim.claimed;
  const myAttempt = claimed.attempts;
  // Only the FIRST attempt of an operation created by this very call can
  // prove "not applied" by its own answer; every other attempt may follow
  // one that committed.
  const uncertainBefore = !fresh || myAttempt !== 1 || op.uncertain === true;
  // Executed only in its creator's session (the server checks p_actor_id),
  // with the STORED frozen arguments and key.
  let outcome = await callRpc(claimed.name, claimed.args, { retries, actorId: claimed.userId, opEpoch: claimed.opEpoch ?? null });
  // 087 recovery refusal of a fresh first attempt: nothing ran and nothing was
  // recorded. It stays unresolved with its key and epoch — never stopped
  // (fenced), replaced or resent automatically; the cashier is told why.
  if (!uncertainBefore && outcome.error?.failure.klass === "RECOVERY" && !outcome.serverOutcome) {
    await reopen(claimed, outcome.error.message);
    return { data: null, status: outcome.status, error: outcome.error };
  }
  if (uncertainBefore) outcome = keepUnknown(outcome);
  const keepPending = async (detail: string, cause: RpcError | null) => {
    const r = await reopen(claimed, cause?.message ?? detail);
    return {
      data: null, status: outcome.status,
      error: pendingError(claimed, cause, r === "decided" ? "it was settled meanwhile — check before entering it again." : detail),
    } as RpcOutcome;
  };
  if (!outcome.error && outcome.responseUnavailable) {
    // Applied on the server (086 ledger); the reply is not readable here.
    await settle(claimed, "applied", "server", undefined, { source: "reply", responseUnavailable: outcome.responseUnavailable });
    void verifiedReload();
    return outcome;
  }
  if (outcome.error && outcome.serverOutcome === "abandoned") {
    await settle(claimed, "abandoned", "server", undefined, { source: "reply", message: outcome.error.message.slice(0, 500), recordedOnServer: true });
    return outcome;
  }
  if (outcome.error && outcome.serverOutcome === "rejected") {
    await settle(claimed, "refused", "server", undefined, { source: "reply", code: outcome.error.code ?? null, message: outcome.error.message.slice(0, 500), recordedOnServer: true });
    return outcome;
  }
  if (!outcome.error) {
    const problem = replyProblem(claimed.name, outcome.data);
    if (problem) return keepPending(`the server's reply could not be read (${problem}).`, null);
    await settle(claimed, "applied", "server", undefined, { source: "reply", response: outcome.data });
    return outcome;
  }
  const { failure } = outcome.error;
  // A key mismatch means the server holds ANOTHER decision under this key
  // (possibly committed): never a refusal — fresh or not.
  if (outcome.serverOutcome === "mismatch") {
    return keepPending("the server holds a different request under this key; it may have been applied.", outcome.error);
  }
  if (!failure.mayHaveCommitted) {
    // Deployment-blocker pass: the client's own evidence never makes it
    // replaceable on a server that HAS 086 — its key is stopped there first
    // (fenced) or the server's decision taken; if that is impossible, or
    // whether the server has 086 is unknown, it is held. Only a server known
    // to lack 086 (no fence exists) keeps the client's evidence.
    if ((await executorDemonstrated()) || executorCapability() !== "absent") {
      return decideOnServer(claimed, myAttempt, outcome, keepPending);
    }
    // The first attempt of a fresh operation proved it was not applied —
    // recorded only while it is still the latest attempt.
    const settledHere = await settle(claimed, failure.retryable ? "not-applied" : "refused", "client", myAttempt);
    if (!settledHere) {
      return { data: null, status: outcome.status, error: pendingError(claimed, outcome.error, "another attempt of it was sent meanwhile (or its record could not be updated); that attempt's outcome decides it.") };
    }
    return outcome;
  }
  return keepPending("the server did not confirm this (its reply was lost or unclear).", outcome.error);
}

/** A client-side "not applied" on an 086 server: fence the key (a late copy
 *  can never run) or take the server's decision; anything else holds it. */
async function decideOnServer(
  op: OnlineOperation, myAttempt: number, outcome: RpcOutcome,
  keepPending: (detail: string, cause: RpcError | null) => Promise<RpcOutcome>,
): Promise<RpcOutcome> {
  // Only the LATEST attempt asks: an older one never stops a newer attempt
  // (a Retry) — that attempt's own outcome decides.
  const stored = await loadAll().then((all) => all.find((o) => o.id === op.id), () => undefined);
  if (!stored || stored.status !== "unresolved" || stored.attempts !== myAttempt) {
    return { data: null, status: outcome.status, error: pendingError(op, outcome.error, "another attempt of it was sent meanwhile (or its record could not be read); that attempt's outcome decides it.") };
  }
  const key = op.args[IDEMPOTENCY_KEY_ARG];
  if (typeof key !== "string") return keepPending("it has no key to confirm on the server.", outcome.error);
  const { status, error } = await lookupOperation(op.name, key, { fence: true, actorId: op.userId, args: op.args, opEpoch: op.opEpoch ?? null });
  if (!error && status?.status === "abandoned") {
    // a fresh first attempt proven not applied: stopping its key is safe (nothing could have run)
    await settle(op, "abandoned", "server", undefined, { source: "lookup", recordedOnServer: true, fencedByTill: status.fenced === true, fencedFor: "new-separate-operation" });
    return outcome;                                       // stopped on the server: it never runs
  }
  if (!error && status?.status === "rejected") {
    await settle(op, "refused");
    return outcome;
  }
  if (!error && status?.status === "committed") {
    await settle(op, "applied");
    void verifiedReload();
    // an unreadable stored reply is never handed back as the operation's result
    const readable = status.response != null && replyProblem(op.name, status.response) === null;
    return { data: readable ? status.response : null, error: null, serverOutcome: "committed", status: outcome.status,
      ...(readable ? {} : { responseUnavailable: status.withheld ? "withheld" as const : "purged" as const }) };
  }
  return keepPending("it could not be confirmed or stopped on the server; it may still be applied.", error ?? outcome.error);
}

/**
 * Call an online-only RPC as ONE operation (see the header). Resolves like
 * callRpc (never rejects for a server failure); an unknown outcome comes
 * back as an error named "PendingConfirmationError". Throws
 * UnresolvedOperationError when the person chose not to send.
 */
export async function callOnlineOnly(
  name: string,
  args: Record<string, unknown>,
  options: { retries?: number; now?: number } = {},
): Promise<RpcOutcome> {
  const retries = options.retries ?? ONLINE_ONLY_RETRIES;
  const fingerprint = operationFingerprint(name, args);
  const scope = scopeOf(name, args);

  if (LOGS.has(name)) {
    return callRpc(name, stampOperationArgs(name, { ...args, [IDEMPOTENCY_KEY_ARG]: idempotencyKeyFor(name) }), { retries, opEpoch: currentOpEpoch() });
  }

  // A double click acts once.
  const flightKey = `${scope}|${fingerprint}`;
  // fix 3: who asked. A reply that arrives after a sign-out / account switch
  // is settled as usual (its record, the journal) but never handed back to be
  // applied to the next session's screen and mirror.
  const askedBy = useAuthStore.getState().currentUserId;
  const sameSession = (outcome: RpcOutcome): RpcOutcome => {
    if (!outcome.error && useAuthStore.getState().currentUserId !== askedBy) throw new SessionEndedError(name);
    return outcome;
  };
  const running = inFlight.get(flightKey);
  if (running) return running.then(sameSession);
  const promise = run(name, args, fingerprint, scope, retries, options.now ?? Date.now())
    .finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, promise);
  return promise.then(sameSession);
}


async function run(
  name: string, args: Record<string, unknown>, fingerprint: string, scope: string, retries: number, now: number,
): Promise<RpcOutcome> {
  const { orgId, userId } = identity();
  // 087: a new operation only with a verified epoch and outside recovery mode
  // (an earlier unresolved one is never resent here while the till is held).
  const created = { opEpoch: currentOpEpoch() };
  await gateNewOperation(created);
  // Never ahead of an unsent entry of this till it may depend on (a payment
  // against a receipt still queued, a cancel of a PO whose receipt is
  // queued, …) — entries being sent included. Independent ones do not hold
  // it (dependencies.ts).
  const subject = { kind: "rpc" as const, name, args, shopId: typeof args.p_shop_id === "string" ? args.p_shop_id : null, actorId: userId };
  if ((await blockingEarlierWork(subject)).length) {
    await drainOutbox().catch(() => undefined);
    if ((await blockingEarlierWork(subject)).length) {
      throw new Error("Not sent: this depends on entries of this till that have not reached the server yet, and must not overtake them. Let the queue finish (Sync), then try again.");
    }
  }
  let existing: OnlineOperation[] = [];
  let unreadable: UnreadableOnlineRecord[] = [];
  try {
    const records = await loadRecords();
    existing = records.ops.filter((op) => isUnresolved(op) && op.orgId === orgId && op.scope === scope);
    unreadable = records.unreadable.filter((r) => mayBeSameOperation(r, name, scope));
  } catch (err) {
    throw new Error(`Not sent: the till could not check for an unresolved earlier attempt (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (unreadable.length) {
    // It may be an earlier attempt of this very payment (outcome unknown):
    // its key cannot be read, so it cannot be asked about or stopped.
    throw new UnresolvedOperationError(
      `This till holds ${unreadable.length === 1 ? "a payment record it cannot read" : `${unreadable.length} payment records it cannot read`} (damaged, or written by a newer version) that may be this same operation. Nothing was sent. Export the pending data (Sync) and have the owner resolve it before entering it again.`,
      unreadable.map((r) => ({ kind: "operation" as const, summary: `Unreadable record${r.claimed.name ? ` (${FRIENDLY[r.claimed.name] ?? r.claimed.name}?)` : ""}`, createdAt: "" })),
    );
  }

  if (existing.length) {
    if (existing.some(isForeignOperation)) {
      throw new UnresolvedOperationError(
        "An earlier attempt was made against another server (or recorded by an older version without its server). Its outcome cannot be verified here, so nothing was sent — an owner verifies it first.",
        existing.map(describe),
      );
    }
    const mine = existing.filter((op) => op.userId === userId && isRetryable(op, now));
    // The same call on the same record, unchanged: that IS the retry.
    const sameTarget = TARGET_ARG[name] ? mine.find((op) => op.fingerprint === fingerprint) : undefined;
    if (sameTarget) return send(sameTarget, retries);

    const decision = await askAboutUnresolved({ existing: existing.map(describe), allowRetry: mine.length > 0, allowNew: true });
    if (decision === "retry" && mine.length > 0) {
      // The earliest unresolved one, unchanged, original key.
      const earliest = [...mine].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      return send(earliest, retries);
    }
    if (decision !== "new") {
      throw new UnresolvedOperationError(
        "An earlier attempt is still awaiting confirmation. Nothing was sent.", existing.map(describe),
      );
    }
    // G1 Stage 1: a separate new operation only once every earlier one is
    // known not to have happened (asked; stopped on the server if it never
    // arrived). If one DID happen it is settled and nothing new is sent.
    const settled = await settleEarlier(existing);
    if (settled === "applied") {
      throw new UnresolvedOperationError(
        "The earlier attempt reached the server and has now been recorded. Nothing new was sent — check before entering it again.",
        existing.map(describe),
      );
    }
    if (settled === "blocked") {
      throw new UnresolvedOperationError(
        "The earlier attempt could not be confirmed or stopped with the server right now. Nothing new was sent; it is kept with its original key.",
        existing.map(describe),
      );
    }
  }

  // A new operation: identity, key and frozen arguments saved BEFORE sending.
  const createdAt = new Date(now).toISOString();
  const op: OnlineOperation = {
    v: 2, id: newId("op"), name, orgId, userId, fingerprint, scope,
    args: stampOperationArgs(name, { ...args, [IDEMPOTENCY_KEY_ARG]: idempotencyKeyFor(name) }),
    status: "unresolved", createdAt, updatedAt: createdAt, attempts: 0, backendOrigin: currentBackendOrigin(),
    opEpoch: created.opEpoch,
  };
  try {
    await save(op);
  } catch (err) {
    // Without the record a lost reply could not be recovered: do not send.
    throw new Error(`Not sent: the operation could not be saved on this till (${err instanceof Error ? err.message : String(err)}). Try again.`);
  }
  if (existing.length) {
    const earlierKeys = existing.map((e) => e.args[IDEMPOTENCY_KEY_ARG]).filter((k): k is string => typeof k === "string");
    await localDb.transaction("rw", localDb.syncState, () => journalReplacement(String(op.args[IDEMPOTENCY_KEY_ARG]), earlierKeys))
      .catch((err) => console.error(`[sync] ${name}: could not link the replacement in the journal:`, err));
  }
  return send(op, retries, true);
}

/** Settle earlier unresolved operations before a separate new one is sent:
 *  "applied" if any of them happened, "blocked" if any cannot be decided
 *  now, "clear" when none happened (absent ones are fenced first). */
async function settleEarlier(ops: OnlineOperation[]): Promise<"clear" | "applied" | "blocked"> {
  // W10 Phase 0: never stop an earlier attempt on a server this till suspects
  // was restored (it may have been applied there and lost by the restore).
  if (await continuityWarning()) return "blocked";
  let applied = false;
  for (const op of ops) {
    if (isForeignOperation(op)) return "blocked";
    const key = op.args[IDEMPOTENCY_KEY_ARG];
    if (typeof key !== "string") return "blocked";
    const { absent, status, error } = await lookupOperation(op.name, key, { fence: true, actorId: op.userId, args: op.args, opEpoch: op.opEpoch ?? null });
    if (absent || error || !status) return "blocked";
    if (status.status === "committed") {
      await settle(op, "applied");
      applied = true;
    } else if (status.status === "rejected") {
      await settle(op, "refused");
    } else if (status.status === "abandoned") {
      await settle(op, "abandoned", "server", undefined, { source: "lookup", recordedOnServer: true, fencedByTill: status.fenced === true, fencedFor: "replacement" });
    } else {
      return "blocked";
    }
  }
  if (applied) void verifiedReload();
  return applied ? "applied" : "clear";
}

// ---- recovery (Sync page) --------------------------------------------------------

/** Unresolved operations of this organisation (newest first). Prunes
 *  settled records past the server's key retention. */
export async function listUnresolvedOnlineOperations(
  now = Date.now(), opts: { own?: boolean } = {},
): Promise<(OnlineOperation & { retryable: boolean; mine: boolean; foreign: boolean })[]> {
  const { orgId, userId } = identity();
  const all = (await loadAll()).filter((op) => !opts.own || (userId !== null && op.userId === userId));
  const stale = all.filter((op) => op.status === "settled" && now - Date.parse(op.updatedAt) > SETTLED_KEEP_MS);
  if (stale.length) await localDb.syncState.bulkDelete(stale.map((op) => PREFIX + op.id)).catch(() => undefined);
  return all
    .filter((op) => isUnresolved(op) && op.orgId === orgId)
    .map((op) => ({ ...op, retryable: isRetryable(op, now) && !isForeignOperation(op), mine: op.userId === userId, foreign: isForeignOperation(op) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** What the server says about an unresolved operation, settling it when the
 *  server has decided it (086). Nothing is sent. `absent`: the server has no
 *  status lookup (no migration 086) — nothing can be learnt this way. */
export async function checkOnlineOperation(id: string): Promise<{ absent: boolean; status: OperationStatus | null; error: RpcError | null }> {
  const op = (await loadAll()).find((o) => o.id === id);
  if (!op || !isUnresolved(op)) throw new Error("This operation is no longer unresolved.");
  // Own organisation only; anyone but the owner checks only their OWN
  // operations (the server's own rules apply as well: a lookup never fences).
  const me = identity();
  if (op.orgId !== me.orgId) throw new Error("This operation belongs to another organisation; it cannot be checked here.");
  if (!isOwnerSession() && op.userId !== me.userId) throw new Error("Only the person who entered it (or the owner) can check this operation.");
  if (op.backendOrigin && op.backendOrigin !== currentBackendOrigin()) {
    throw new Error("This operation was made against another server; it can only be checked there (or verified by an owner). Nothing was asked here.");
  }
  const key = op.args[IDEMPOTENCY_KEY_ARG];
  if (typeof key !== "string") return { absent: false, status: null, error: null };
  // Read-only (never a fence). For an older record without its server, only
  // a positive answer (committed / rejected / abandoned for this key) is
  // taken: "not found" proves nothing.
  const result = await lookupOperation(op.name, key, { args: op.args });
  const status = result.status;
  if (status?.status === "committed") {
    if (status.response != null && replyProblem(op.name, status.response) === null) {
      await settle(op, "applied");
    } else if (status.withheld || status.responsePurged) {
      await settle(op, "applied");
      void verifiedReload();
    }
  } else if (status?.status === "rejected") {
    await settle(op, "refused");
  } else if (status?.status === "abandoned") {
    await settle(op, "abandoned");
  } else if (status?.status === "not_found" && !isForeignOperation(op) && (op.attempts > 0 || op.uncertain)) {
    // W10 Phase 0: sent (or possibly sent) and the server has no record of
    // it — it may have been lost by a restore of the server. Nothing is
    // stopped; the till's journal records that an owner must decide.
    await localDb.transaction("rw", localDb.syncState, () => journalKeyReconciliationRequired(key,
      "the server has no record of it (it may never have arrived, or a restore of the server lost it)"))
      .catch(() => undefined);
  }
  return result;
}

/** Resend an unresolved operation unchanged (its own key). Same user only,
 *  inside the server's key retention. Lookup before replay: when the server
 *  has already decided it (086), it is settled from that answer and nothing
 *  is sent; op_execute itself never re-executes a decided key either. */
export async function retryOnlineOperation(id: string, now = Date.now()): Promise<RpcOutcome> {
  const op = (await loadAll()).find((o) => o.id === id);
  if (!op || !isUnresolved(op)) throw new Error("This operation is no longer unresolved.");
  const { orgId, userId } = identity();
  if (op.orgId !== orgId || op.userId !== userId) throw new Error("Only the person who entered it can retry this operation.");
  if (isForeignOperation(op)) {
    throw new Error("This operation was made against another server (or recorded by an older version without its server): it is never resent here. Check it, or an owner verifies it.");
  }
  if (!isRetryable(op, now)) {
    throw new Error("Too old to retry safely: the server may no longer recognise its key. Check the server records and mark it verified.");
  }
  const key = op.args[IDEMPOTENCY_KEY_ARG];
  if (typeof key === "string") {
    const { status } = await lookupOperation(op.name, key);
    if (status?.status === "in_flight") {
      return { data: null, error: pendingError(op, null, "the server is still processing it.") };
    }
    if (status && status.status !== "not_found" && status.status !== "unavailable") {
      // committed / rejected / abandoned: op_execute answers from the ledger
      // with the same decision (and the stored reply) — one request, no
      // second execution.
      return send(op, 0);
    }
  }
  return send(op, ONLINE_ONLY_RETRIES);
}

/** After checking the server's records by hand: close it (owner decision). */
export async function markOnlineOperationVerified(id: string): Promise<void> {
  if (!isOwnerSession()) throw new Error("Only the owner (administrator) can mark an operation as verified.");
  const op = (await loadAll()).find((o) => o.id === id);
  if (!op) return;
  // An owner closes operations of THEIR organisation only.
  if (op.orgId !== identity().orgId) throw new Error("This operation belongs to another organisation; it cannot be verified here.");
  // Closing it lets the same payment be entered again under a NEW key: on its
  // own backend, the earlier key is first decided or stopped (fenced) on the
  // server, exactly as before a replacement. Only where no fence exists (no
  // 086, another or an unrecorded backend) does the owner's word close it.
  // W10 Phase 0: not while this till suspects its server was restored.
  if (isUnresolved(op) && (await continuityWarning())) {
    throw new Error("This till has a server-continuity warning (the server may have been restored from an older backup). Review it on the Sync page first: this payment may have been applied there and lost. Nothing was changed.");
  }
  const key = op.args[IDEMPOTENCY_KEY_ARG];
  if (isUnresolved(op) && !isForeignOperation(op) && typeof key === "string") {
    const { absent, status, error } = await lookupOperation(op.name, key, { fence: true, actorId: op.userId, args: op.args, opEpoch: op.opEpoch ?? null });
    // A key the server says can never execute any more (too old: outside the
    // executor window) cannot be stopped, but cannot run either: the owner's
    // word closes it, as the server's own records direct ("a person verifies it").
    const neverRuns = status?.status === "not_found" && (status.executable === false || status.reason === "expired");
    if (!absent && !neverRuns) {
      if (error || !status || !["committed", "rejected", "abandoned"].includes(status.status)) {
        throw new Error("It could not be confirmed or stopped on the server (it may still be running). Nothing was changed — try again when the server answers.");
      }
      const outcome = status.status === "committed" ? "applied" : status.status === "rejected" ? "refused" : "abandoned";
      if (!(await settle(op, outcome, "server", undefined, outcome === "abandoned"
        ? { source: "lookup", recordedOnServer: true, fencedByTill: status.fenced === true, fencedFor: "owner-verified" } : { source: "lookup" }))) {
        const now = (await loadAll()).find((o) => o.id === id);
        if (now?.status !== "settled") throw new Error("Its record could not be updated on this till; nothing was changed. Try again.");
      }
      if (outcome === "applied") void verifiedReload();
      return;
    }
  }
  if (!(await settle(op, "verified-manually", "owner"))) {
    const now = (await loadAll()).find((o) => o.id === id);
    if (now?.status !== "settled") throw new Error("Its record could not be updated on this till; nothing was changed. Try again.");
  }
}

/** Every readable online-only record (the journal backfill reads them). */
export async function allOnlineOperations(): Promise<OnlineOperation[]> {
  return loadAll();
}

/** Tests / diagnostics: unresolved operations plus unreadable records. */
export async function countUnsettledOnlineOperations(): Promise<number> {
  const { ops, unreadable } = await loadRecords();
  return ops.filter(isUnresolved).length + unreadable.length;
}

export { UNREADABLE_SET_ASIDE_PREFIX };

/** Owner (ADMIN) only, and only after the pending data was exported in this
 *  session: move an unreadable record out of the way of new operations. The
 *  raw record is KEPT (under another key) and the action audited — it is not
 *  "cancelled" or "not applied": nobody can tell what it was. */
export async function setAsideUnreadableOnlineRecord(key: string): Promise<void> {
  if (!isOwnerSession()) throw new Error("Only the owner (administrator) can set aside an unreadable record.");
  // Only once THIS record was in an export of this session (its raw contents saved).
  if (!wasExported(key)) throw new Error("Export the pending data first (in this session, with this record in it): the record is kept, but its contents must be saved for recovery.");
  const moved = await localDb.transaction("rw", localDb.syncState, async () => {
    const row = await localDb.syncState.get(key);
    if (!row || !key.startsWith(PREFIX)) return null;
    const c = classifyOnlineRecord<OnlineOperation>(row);
    if ("op" in c) throw new Error("This record is readable; it is resolved under Unresolved operations, not set aside.");
    if (!unreadableInScope(c.unreadable, identity().orgId)) throw new Error("This record claims another organisation; only its own owner can set it aside.");
    const at = new Date().toISOString();
    await localDb.syncState.put({
      key: `${UNREADABLE_SET_ASIDE_PREFIX}${key.slice(PREFIX.length)}`, updatedAt: at,
      value: JSON.stringify({ originalKey: key, raw: c.unreadable.raw, reason: c.unreadable.reason, setAsideAt: at, setAsideBy: identity().userId }),
    });
    await localDb.syncState.delete(key);
    return c.unreadable;
  });
  if (moved) {
    await ownerAudit(key, `unreadable online-operation record set aside (${moved.reason}${moved.claimed.name ? `, claims ${moved.claimed.name}` : ""}); raw record kept under ${UNREADABLE_SET_ASIDE_PREFIX}; its outcome is UNKNOWN`);
  }
}
