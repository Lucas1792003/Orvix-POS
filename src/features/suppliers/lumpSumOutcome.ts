import {
  checkOnlineOperation, listUnreadableOnlineRecords, listUnresolvedOnlineOperations, retryOnlineOperation,
} from "../../stores/data/onlineOnly";
import { isPendingConfirmation } from "../../stores/data/operationPrompt";
import { isOwnerSession } from "../../stores/data/outbox";
import { localDb } from "../../lib/localDb";
import { verifiedReload } from "../../stores/data/verifiedReload";
import { isLumpSumBalanceRefusal } from "./lumpSumRefusal";

// ----------------------------------------------------------------------
// A lump-sum supplier payment whose outcome is UNKNOWN (its reply was lost:
// it may be recorded) blocks every new supplier payment for that supplier
// and shop on this till — the lump-sum dialog and the single-PO dialog — until
// the SERVER says what happened to its own key. Nothing here creates a key:
// "Check with server" is a read-only lookup; "Send the same payment again"
// resends the stored operation unchanged (its key, its creator). A changed
// balance is never taken as proof either way. The operations live in the
// till's IndexedDB (onlineOnly.ts): the block survives a restart, navigation
// and every window of the till; only this organisation's records count.
// ----------------------------------------------------------------------

const NAME = "pay_supplier_lump_sum";
const scopeOf = (supplierId: string, shopId: string) => `${NAME}#${supplierId}|${shopId}`;

export interface PendingLumpSum {
  id: string;
  amountMmk: number | null;
  createdAt: string;
  /** Entered by the signed-in user (only they can resend it). */
  mine: boolean;
  /** Can be resent with its key (own, recent, this backend). */
  retryable: boolean;
  /** Can be checked here (its creator, or the owner). */
  checkable: boolean;
}

export type PendingState =
  | { kind: "none" }
  | { kind: "pending"; ops: PendingLumpSum[] }
  /** This till's records could not be read, or one is unreadable and may be
   *  this payment: nothing can be entered (fail closed). */
  | { kind: "unreadable"; detail: string }
  /** A single-purchase-order payment of this supplier and shop is in doubt
   *  (queued with an unknown outcome): it may have paid what is shown as owed. */
  | { kind: "po-pending"; count: number };

const OPEN_STATUSES = ["pending", "syncing", "failed", "conflict", "archived", "quarantined"] as const;

/** Single-PO payments (outbox) of these purchase orders whose outcome nobody
 *  has established — writeAhead's "unresolved twin" rule, for ANY amount. */
export async function inDoubtPoPayments(poIds: string[]): Promise<number> {
  if (!poIds.length) return 0;
  const ids = new Set(poIds);
  const rows = await localDb.syncOutbox.where("status").anyOf(...OPEN_STATUSES).toArray();
  return rows.filter((r) => r.kind === "rpc" && r.name === "record_supplier_payment" && !r.serverOutcome
    && (r.writeAhead === true || r.fenceRequired === true)
    && (r.status === "syncing" || r.inDoubt === true || r.fenceRequired === true || r.statusBeforeArchive === "syncing")
    && ids.has(String(r.args?.p_purchase_order_id ?? ""))).length;
}

/** The unresolved lump sums of this supplier and shop (this organisation). */
export async function pendingLumpSumState(supplierId: string, shopId: string, poIds: string[] = []): Promise<PendingState> {
  const scope = scopeOf(supplierId, shopId);
  try {
    const [ops, unreadable, poInDoubt] = await Promise.all([listUnresolvedOnlineOperations(), listUnreadableOnlineRecords(), inDoubtPoPayments(poIds)]);
    const mayBeThis = unreadable.filter((r) => !r.setAside
      && !(r.claimed.scope && r.claimed.scope !== scope) && !(r.claimed.name && r.claimed.name !== NAME));
    if (mayBeThis.length) return { kind: "unreadable", detail: `${mayBeThis.length} unreadable payment record(s)` };
    const mine = ops.filter((op) => op.name === NAME && op.scope === scope);
    if (!mine.length) return poInDoubt ? { kind: "po-pending", count: poInDoubt } : { kind: "none" };
    const owner = isOwnerSession();
    return {
      kind: "pending",
      ops: mine.map((op) => ({
        id: op.id,
        amountMmk: typeof op.args.p_amount_mmk === "number" ? op.args.p_amount_mmk : null,
        createdAt: op.createdAt, mine: op.mine, retryable: op.mine && op.retryable, checkable: op.mine || owner,
      })),
    };
  } catch (err) {
    return { kind: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
}

export type Resolution =
  | { kind: "recorded" }
  | { kind: "refused"; message: string; balanceRefusal: boolean }
  | { kind: "stopped" }
  | { kind: "unknown"; reason: string };

const BALANCE_TEXT = /exceeds (the )?(total )?outstanding balance|has no outstanding balance/i;

/** Ask the server (read-only, never a fence) what happened to this key. */
export async function checkPendingLumpSum(id: string): Promise<Resolution> {
  let result: Awaited<ReturnType<typeof checkOnlineOperation>>;
  try {
    result = await checkOnlineOperation(id);
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  const { absent, status, error } = result;
  if (absent) return { kind: "unknown", reason: "this server cannot be asked about earlier operations (no status lookup)." };
  if (error || !status) return { kind: "unknown", reason: error?.message ?? "the server did not answer." };
  switch (status.status) {
    case "committed": {
      // settled by checkOnlineOperation when its reply is readable, withheld or purged
      const still = (await listUnresolvedOnlineOperations().catch(() => [])).some((op) => op.id === id);
      void verifiedReload();
      return still ? { kind: "unknown", reason: "the server recorded it, but its record on this till could not be closed — check it on the Sync page." }
        : { kind: "recorded" };
    }
    case "rejected": {
      const message = status.message ?? "refused by the server (recorded).";
      return { kind: "refused", message, balanceRefusal: BALANCE_TEXT.test(message) };
    }
    case "abandoned":
      return { kind: "stopped" };
    case "in_flight":
      return { kind: "unknown", reason: "the server is still processing it." };
    default:
      return { kind: "unknown", reason: "the server has no decision for it yet (it may not have arrived)." };
  }
}

/** Resend the stored operation unchanged — its own key, by its own creator. */
export async function resendPendingLumpSum(id: string): Promise<Resolution> {
  let out: Awaited<ReturnType<typeof retryOnlineOperation>>;
  try {
    out = await retryOnlineOperation(id);
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!out.error) {
    void verifiedReload();
    return { kind: "recorded" };
  }
  const err = out.error;
  if (isPendingConfirmation(err as unknown)) return { kind: "unknown", reason: err.message };
  if (out.serverOutcome === "abandoned") return { kind: "stopped" };
  if (out.serverOutcome === "rejected" || err.failure?.klass === "REJECTED") {
    return { kind: "refused", message: err.message, balanceRefusal: isLumpSumBalanceRefusal(err) };
  }
  return { kind: "unknown", reason: err.message };
}
