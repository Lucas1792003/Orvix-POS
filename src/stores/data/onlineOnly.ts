import { localDb } from "../../lib/localDb";
import { newId } from "../../lib/id";
import { classifyFailure } from "../../lib/failureClass";
import {
  callRpc, IDEMPOTENCY_KEY_ARG, newIdempotencyKey, ONLINE_ONLY_RETRIES, RpcError, stampOperationArgs, type RpcOutcome,
} from "./idempotentRpc";
import { replyProblem } from "./replyShapes";
import { askAboutUnresolved, UnresolvedOperationError, type UnresolvedOperationInfo } from "./operationPrompt";
import { useAuthStore } from "../authStore";

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
// Age never mints a new key. The server keeps keys for 30 days (migration
// 062 ledger retention); an operation unresolved for longer than
// RETRY_WINDOW_MS can no longer be retried safely from here (the server
// may have forgotten its key) — it is listed as needing manual
// verification instead.
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
  outcome?: "applied" | "refused" | "not-applied" | "verified-manually";
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  attempts: number;
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

async function settle(op: OnlineOperation, outcome: NonNullable<OnlineOperation["outcome"]>): Promise<void> {
  // Never reusable after this, even if the write below fails.
  settledThisSession.add(op.id);
  const next: OnlineOperation = { ...op, status: "settled", outcome, updatedAt: new Date().toISOString() };
  await save(next).catch((err) => console.error(`[sync] ${op.name}: could not record its settlement (kept as settled for this session):`, err));
}

async function send(op: OnlineOperation, retries: number): Promise<RpcOutcome> {
  op.attempts += 1;
  const outcome = await callRpc(op.name, op.args, { retries });
  if (!outcome.error) {
    const problem = replyProblem(op.name, outcome.data);
    if (problem) {
      op.lastError = `Unrecognised reply (${problem})`;
      await save({ ...op, updatedAt: new Date().toISOString() }).catch(() => undefined);
      return { data: null, status: outcome.status, error: pendingError(op, null, `the server's reply could not be read (${problem}).`) };
    }
    await settle(op, "applied");
    return outcome;
  }
  const { failure } = outcome.error;
  if (!failure.retryable) {
    await settle(op, "refused");
    return outcome;
  }
  if (!failure.mayHaveCommitted) {
    // Proven not applied: nothing to confirm; entering it again is new.
    await settle(op, "not-applied");
    return outcome;
  }
  op.lastError = outcome.error.message;
  await save({ ...op, updatedAt: new Date().toISOString() }).catch(() => undefined);
  return { data: null, status: outcome.status, error: pendingError(op, outcome.error, "the server did not confirm this (its reply was lost or unclear).") };
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
  let existing: OnlineOperation[] = [];
  try {
    existing = (await loadAll()).filter((op) => isUnresolved(op) && op.orgId === orgId && op.scope === scope);
  } catch (err) {
    throw new Error(`Not sent: the till could not check for an unresolved earlier attempt (${err instanceof Error ? err.message : String(err)}).`);
  }

  if (existing.length) {
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
  }

  // A new operation: identity, key and frozen arguments saved BEFORE sending.
  const createdAt = new Date(now).toISOString();
  const op: OnlineOperation = {
    v: 2, id: newId("op"), name, orgId, userId, fingerprint, scope,
    args: stampOperationArgs(name, { ...args, [IDEMPOTENCY_KEY_ARG]: newIdempotencyKey() }),
    status: "unresolved", createdAt, updatedAt: createdAt, attempts: 0,
  };
  try {
    await save(op);
  } catch (err) {
    // Without the record a lost reply could not be recovered: do not send.
    throw new Error(`Not sent: the operation could not be saved on this till (${err instanceof Error ? err.message : String(err)}). Try again.`);
  }
  return send(op, retries);
}

// ---- recovery (Sync page) --------------------------------------------------------

/** Unresolved operations of this organisation (newest first). Prunes
 *  settled records past the server's key retention. */
export async function listUnresolvedOnlineOperations(now = Date.now()): Promise<(OnlineOperation & { retryable: boolean; mine: boolean })[]> {
  const { orgId, userId } = identity();
  const all = await loadAll();
  const stale = all.filter((op) => op.status === "settled" && now - Date.parse(op.updatedAt) > SETTLED_KEEP_MS);
  if (stale.length) await localDb.syncState.bulkDelete(stale.map((op) => PREFIX + op.id)).catch(() => undefined);
  return all
    .filter((op) => isUnresolved(op) && op.orgId === orgId)
    .map((op) => ({ ...op, retryable: isRetryable(op, now), mine: op.userId === userId }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Resend an unresolved operation unchanged (its own key). Same user only,
 *  inside the server's key retention. */
export async function retryOnlineOperation(id: string, now = Date.now()): Promise<RpcOutcome> {
  const op = (await loadAll()).find((o) => o.id === id);
  if (!op || !isUnresolved(op)) throw new Error("This operation is no longer unresolved.");
  const { orgId, userId } = identity();
  if (op.orgId !== orgId || op.userId !== userId) throw new Error("Only the person who entered it can retry this operation.");
  if (!isRetryable(op, now)) {
    throw new Error("Too old to retry safely: the server may no longer recognise its key. Check the server records and mark it verified.");
  }
  return send(op, ONLINE_ONLY_RETRIES);
}

/** After checking the server's records by hand: close it (owner decision). */
export async function markOnlineOperationVerified(id: string): Promise<void> {
  const op = (await loadAll()).find((o) => o.id === id);
  if (!op) return;
  await settle(op, "verified-manually");
}

/** Tests / diagnostics. */
export async function countUnsettledOnlineOperations(): Promise<number> {
  return (await loadAll()).filter(isUnresolved).length;
}
