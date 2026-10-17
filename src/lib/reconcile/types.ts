// ----------------------------------------------------------------------
// Owner reconciliation of outbox entries (1.0.16 RC3). Types only.
// Design + state machine: docs/desktop-app/release-1.0.16.md §11.
// ----------------------------------------------------------------------

/** What the owner decided happened to the entry. */
export type ReconcileResolution =
  /** The server already has it: the sale found by the read-only check. */
  | "matched"
  /** The owner re-entered it through the normal (idempotent) sales flow;
   *  references the NEW server sale, which the app verified exists. */
  | "recreated"
  /** It did not happen / was cancelled. Only when the check found nothing. */
  | "cancelled";

export type ServerCheckResult = "recorded" | "not-recorded" | "inconclusive";

/** A server sale as read through the owner's normal RLS access. */
export interface ServerSaleRef {
  saleId: string;
  receiptNo: string | null;
  shopId: string | null;
  shiftId: string | null;
  createdAt: string | null;
}

/** Result of the read-only server check (lib/reconcile/serverCheck.ts). */
export interface ServerCheck {
  result: ServerCheckResult;
  /** How it was looked up. The idempotency ledger is not readable by any
   *  app user (062: RLS on, no policies, revoked), so sales are matched by
   *  the client operation identity, as the e2e sale ledger does. */
  method: "sale-client-identity" | "unsupported";
  checkedAt: string;
  /** Digest of the entry the check was run for (bound to it). */
  entryDigest: string;
  /** Exact matches: same shop (+ shift when known), same ring-up instant,
   *  same payment method / paid amount / cart discount, same lines. */
  matches: ServerSaleRef[];
  /** Possible matches (same lines and amounts, different time — e.g. a
   *  replay more than 48 h after ring-up is stamped with server time). */
  candidates: ServerSaleRef[];
  detail: string;
}

export interface ReconcileOwner {
  /** App user id (users.id) from the server (app_user_id()). */
  userId: string;
  name: string;
  orgId: string | null;
  role: "ADMIN";
  /** When the main process verified the session with the server. */
  verifiedAt: string;
  source: "backend";
}

export type ReconcilableStatus = "conflict" | "quarantined" | "archived";

export interface ReconciliationRecord {
  v: 1;
  id: string;
  localId: string;
  idempotencyKey: string | null;
  /** sha256 over localId + idempotency key + kind/name/table/op/id + payload. */
  entryDigest: string;
  resolution: ReconcileResolution;
  /** matched: the sale the check found; recreated: the new sale; cancelled: null. */
  serverRef: ServerSaleRef | null;
  check: ServerCheck;
  reason: string;
  reconciledAt: string;
  statusBefore: ReconcilableStatus;
  /** The entry's earlier states as recorded on the row (queued, quarantined,
   *  set aside, ...), oldest first. */
  statusHistory: { status: string; at: string | null; note?: string }[];
  /** The export of this session that contained exactly this entry. */
  export: { exportedAt: string; digest: string };
  /** The entry's `refs` resolved at reconcile time (the id map entry may be
   *  pruned later: reconciled rows are never replayed by the till). */
  resolvedRefs: { field: string; provisionalId: string; realId: string | null }[];
  owner: ReconcileOwner;
  /** sha256 over every field above except `owner`. */
  recordDigest: string;
  /** HMAC-SHA-256 by the Electron main process (key kept in userData, never
   *  given to the renderer) over localId, entryDigest, recordDigest and the
   *  owner it verified with the server. */
  seal: string;
}

/** Local, append-only reconciliation log (syncState rows "reconcile-log:<id>"). */
export interface ReconcileLogEntry {
  id: string;
  at: string;
  /** "owner-action": an owner's recovery action on an entry (Confirm with
   *  server, set aside, restore) — audited, exported with the queue. */
  event: "reconciled" | "refused" | "tamper-detected" | "owner-action";
  localId: string;
  recordId?: string;
  resolution?: ReconcileResolution;
  serverSaleId?: string | null;
  ownerUserId?: string | null;
  ownerName?: string | null;
  entryDigest?: string;
  detail: string;
}
