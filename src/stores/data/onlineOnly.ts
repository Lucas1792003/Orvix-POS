import { localDb } from "../../lib/localDb";
import { newId } from "../../lib/id";
import { classifyFailure } from "../../lib/failureClass";
import {
  callRpc, IDEMPOTENCY_KEY_ARG, keepUnknown, lookupOperation, newIdempotencyKey, ONLINE_ONLY_RETRIES, RpcError, stampOperationArgs,
  type OperationStatus, type RpcOutcome,
} from "./idempotentRpc";
import { replyProblem } from "./replyShapes";
import { verifiedReload } from "./verifiedReload";
import { askAboutUnresolved, UnresolvedOperationError, type UnresolvedOperationInfo } from "./operationPrompt";
import { useAuthStore } from "../authStore";
import { blockingEarlierWork, drainOutbox, isOwnerSession } from "./outbox";
import { currentBackendOrigin } from "../../lib/backendOrigin";

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
};

// Log writes: each call is its own new event; nothing to recover.
const LOGS = new Set(["log_audit_event", "log_receipt_reprint"]);

const FRIENDLY: Record<string, string> = {
  pay_supplier_lump_sum: "Supplier payment", create_purchase_order: "Purchase order", create_stock_transfer: "Stock transfer",
  create_supplier: "New supplier", void_supplier_payment: "Void supplier payment", approve_purchase_order: "Approve purchase order",
  cancel_purchase_order: "Cancel purchase order", approve_stock_transfer: "Approve transfer", reject_stock_transfer: "Reject transfer",
  cancel_stock_transfer: "Cancel transfer", approve_void_request: "Approve void", approve_refund_request: "Approve refund",
  reject_refund_void_request: "Reject refund/void", create_refund_void_request: "Void request", delete_product: "Delete product",
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

const settledThisSession = new Set<string>();
const inFlight = new Map<string, Promise<RpcOutcome>>();

/** Tests only: a new app instance. */
export function resetOnlineOnlyForTests(): void {
  inFlight.clear();
  settledThisSession.clear();
}

async function save(op: OnlineOperation): Promise<void> {
  await localDb.syncState.put({ key: PREFIX + op.id, value: JSON.stringify(op), updatedAt: op.updatedAt });
}

async function loadAll(): Promise<OnlineOperation[]> {
  const rows = await localDb.syncState.filter((e) => e.key.startsWith(PREFIX)).toArray();
  const out: OnlineOperation[] = [];
  for (const row of rows) {
    try {
      const op = JSON.parse(row.value ?? "") as OnlineOperation;
      if (op?.v === 2 && op.id) out.push(op);
    } catch {
      // A record from the pre-correction format (fingerprint-keyed): ignored —
      // it carried no identity; see listUnresolvedOnlineOperations.
    }
  }
  return out;
}

const isUnresolved = (op: OnlineOperation) => op.status === "unresolved" && !settledThisSession.has(op.id);
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
const storedOp = async (id: string): Promise<OnlineOperation | undefined> =>
  (await loadAll().catch(() => [] as OnlineOperation[])).find((o) => o.id === id);

/** Settle monotonically (payment-safety race fix). A client-evidence
 *  outcome is written only by the LATEST attempt (`attempt` = its sequence
 *  number) and never over an existing settlement; a server / owner outcome
 *  overwrites a client one but never another server / owner one. */
async function settle(
  op: OnlineOperation, outcome: NonNullable<OnlineOperation["outcome"]>,
  by: "server" | "client" | "owner" = "server", attempt?: number,
): Promise<boolean> {
  const stored = await storedOp(op.id);
  if (stored?.status === "settled" && RANK[stored.decidedBy ?? "server"] >= RANK[by]) {
    settledThisSession.add(op.id);
    return false;                                         // a decision at least as authoritative stands
  }
  if (by === "client" && stored && (stored.status === "settled" || (attempt !== undefined && stored.attempts !== attempt))) {
    return false;                                         // a newer attempt exists: its outcome decides
  }
  // Never reusable after this, even if the write below fails.
  settledThisSession.add(op.id);
  const base = stored ?? op;
  const next: OnlineOperation = { ...base, status: "settled", outcome, decidedBy: by, updatedAt: new Date().toISOString() };
  await save(next).catch((err) => console.error(`[sync] ${op.name}: could not record its settlement (kept as settled for this session):`, err));
  return true;
}

/** `fresh`: the operation was created by this very call and has never been
 *  sent. Every other one (stored, retried, reloaded after a restart, written
 *  by an older build) may already have been applied: only a server decision
 *  (or success) settles it — never a 401, 503, timeout or unreadable reply. */
async function send(op: OnlineOperation, retries: number, fresh = false): Promise<RpcOutcome> {
  if (isForeignOperation(op)) {
    return { data: null, error: pendingError(op, null, "it was made against another server (or by an older version that did not record its server); it can only be verified there or by an owner.") };
  }
  const uncertainBefore = !fresh || op.uncertain === true;
  // Durable attempt sequence: never behind what is stored (another window or
  // a Retry may have sent it meanwhile).
  const current = await storedOp(op.id);
  op.attempts = Math.max(op.attempts, current?.attempts ?? 0) + 1;
  const myAttempt = op.attempts;
  // Durable BEFORE the request: a crash from here on leaves it uncertain.
  try {
    await save({ ...op, uncertain: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    return { data: null, error: pendingError(op, null, `it could not be saved before sending (${err instanceof Error ? err.message : String(err)}); nothing was sent.`) };
  }
  // Executed only in its creator's session (the server checks p_actor_id).
  let outcome = await callRpc(op.name, op.args, { retries, actorId: op.userId });
  if (uncertainBefore) outcome = keepUnknown(outcome);
  const keepPending = async (detail: string, cause: RpcError | null) => {
    const stored = await storedOp(op.id);
    // Decided by the SERVER or an OWNER meanwhile: that stands.
    if (stored?.status === "settled" && (stored.decidedBy ?? "server") !== "client") {
      return { data: null, status: outcome.status, error: pendingError(op, cause, "it was settled meanwhile — check before entering it again.") } as RpcOutcome;
    }
    // Unresolved, or only settled "not applied" on a CLIENT's evidence: this
    // attempt may have been applied — it is (re)opened, never left closed.
    settledThisSession.delete(op.id);
    const base = stored ?? op;
    const next: OnlineOperation = {
      ...base, status: "unresolved", outcome: undefined, decidedBy: undefined, uncertain: true,
      attempts: Math.max(base.attempts, op.attempts), lastError: cause?.message ?? detail, updatedAt: new Date().toISOString(),
    };
    await save(next).catch(() => undefined);
    return { data: null, status: outcome.status, error: pendingError(op, cause, detail) } as RpcOutcome;
  };
  if (!outcome.error && outcome.responseUnavailable) {
    // Applied on the server (086 ledger); the reply is not readable here.
    // Settled, and the till's data is reloaded from the server instead.
    await settle(op, "applied");
    void verifiedReload();
    return outcome;
  }
  if (outcome.error && outcome.serverOutcome === "abandoned") {
    await settle(op, "abandoned");
    return outcome;
  }
  if (outcome.error && outcome.serverOutcome === "rejected") {
    await settle(op, "refused");
    return outcome;
  }
  if (!outcome.error) {
    const problem = replyProblem(op.name, outcome.data);
    if (problem) return keepPending(`the server's reply could not be read (${problem}).`, null);
    await settle(op, "applied");
    return outcome;
  }
  const { failure } = outcome.error;
  // A key mismatch means the server holds ANOTHER decision under this key
  // (possibly committed): never a refusal of a stored operation.
  if (outcome.serverOutcome === "mismatch" && uncertainBefore) {
    return keepPending("the server holds a different request under this key; it may have been applied.", outcome.error);
  }
  // Below: no server decision. Only the FIRST attempt of a fresh operation
  // can prove anything by its own answer (keepUnknown turned every other
  // answer into "may have committed") — and only while it is still the
  // latest attempt (a Retry or another window may have sent it meanwhile).
  if (!failure.mayHaveCommitted) {
    const settledHere = await settle(op, failure.retryable ? "not-applied" : "refused", "client", myAttempt);
    if (!settledHere) {
      return { data: null, status: outcome.status, error: pendingError(op, outcome.error, "another attempt of it was sent meanwhile; that attempt's outcome decides it.") };
    }
    return outcome;
  }
  return keepPending("the server did not confirm this (its reply was lost or unclear).", outcome.error);
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
    return callRpc(name, stampOperationArgs(name, { ...args, [IDEMPOTENCY_KEY_ARG]: newIdempotencyKey() }), { retries });
  }

  // A double click acts once.
  const flightKey = `${scope}|${fingerprint}`;
  const running = inFlight.get(flightKey);
  if (running) return running;
  const promise = run(name, args, fingerprint, scope, retries, options.now ?? Date.now())
    .finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, promise);
  return promise;
}


async function run(
  name: string, args: Record<string, unknown>, fingerprint: string, scope: string, retries: number, now: number,
): Promise<RpcOutcome> {
  const { orgId, userId } = identity();
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
  try {
    existing = (await loadAll()).filter((op) => isUnresolved(op) && op.orgId === orgId && op.scope === scope);
  } catch (err) {
    throw new Error(`Not sent: the till could not check for an unresolved earlier attempt (${err instanceof Error ? err.message : String(err)}).`);
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
    args: stampOperationArgs(name, { ...args, [IDEMPOTENCY_KEY_ARG]: newIdempotencyKey() }),
    status: "unresolved", createdAt, updatedAt: createdAt, attempts: 0, backendOrigin: currentBackendOrigin(),
  };
  try {
    await save(op);
  } catch (err) {
    // Without the record a lost reply could not be recovered: do not send.
    throw new Error(`Not sent: the operation could not be saved on this till (${err instanceof Error ? err.message : String(err)}). Try again.`);
  }
  return send(op, retries, true);
}

/** Settle earlier unresolved operations before a separate new one is sent:
 *  "applied" if any of them happened, "blocked" if any cannot be decided
 *  now, "clear" when none happened (absent ones are fenced first). */
async function settleEarlier(ops: OnlineOperation[]): Promise<"clear" | "applied" | "blocked"> {
  let applied = false;
  for (const op of ops) {
    if (isForeignOperation(op)) return "blocked";
    const key = op.args[IDEMPOTENCY_KEY_ARG];
    if (typeof key !== "string") return "blocked";
    const { absent, status, error } = await lookupOperation(op.name, key, { fence: true, actorId: op.userId, args: op.args });
    if (absent || error || !status) return "blocked";
    if (status.status === "committed") {
      await settle(op, "applied");
      applied = true;
    } else if (status.status === "rejected") {
      await settle(op, "refused");
    } else if (status.status === "abandoned") {
      await settle(op, "abandoned");
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
export async function listUnresolvedOnlineOperations(now = Date.now()): Promise<(OnlineOperation & { retryable: boolean; mine: boolean; foreign: boolean })[]> {
  const { orgId, userId } = identity();
  const all = await loadAll();
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
  await settle(op, "verified-manually", "owner");
}

/** Tests / diagnostics. */
export async function countUnsettledOnlineOperations(): Promise<number> {
  return (await loadAll()).filter(isUnresolved).length;
}
