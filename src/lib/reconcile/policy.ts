// ----------------------------------------------------------------------
// Reconciliation rules (1.0.16 RC3). Pure: the Sync Conflicts page uses
// them to decide what to offer, and stores/data/reconcile.ts enforces them
// again (with the server-verified owner) before anything is written.
// ----------------------------------------------------------------------
import type { SyncOutboxEntry } from "../localDb";
import { REASON_MAX_LENGTH, REASON_MIN_LENGTH, RECONCILABLE_STATUSES, SERVER_CHECK_MAX_AGE_MS } from "./constants";
import type { ReconcilableStatus, ReconcileResolution, ReconciliationRecord, ServerCheck, ServerSaleRef } from "./types";

export type ReconcileBlock =
  | "already-reconciled"
  | "still-syncing"     // pending / syncing / failed: in the drain; set it aside first
  | "no-desktop"        // no main process to verify the owner (plain browser / old preload)
  | "not-owner"
  | "export-first"      // not exported in this session
  | "export-stale"      // exported, but the entry changed since (digest differs)
  | null;

export const isReconcilableStatus = (s: string): s is ReconcilableStatus =>
  (RECONCILABLE_STATUSES as readonly string[]).includes(s);

/** Why "Reconcile" may not start for this entry now (null = it may). */
export function reconcileBlock(
  entry: Pick<SyncOutboxEntry, "status">,
  ctx: { isOwner: boolean; canVerifyOwner: boolean; exportedDigest: string | null | undefined; currentDigest: string | null },
): ReconcileBlock {
  if (entry.status === "reconciled") return "already-reconciled";
  if (!isReconcilableStatus(entry.status)) return "still-syncing";
  if (!ctx.canVerifyOwner) return "no-desktop";
  if (!ctx.isOwner) return "not-owner";
  if (ctx.exportedDigest === undefined) return "export-first";
  if (!ctx.exportedDigest || !ctx.currentDigest || ctx.exportedDigest !== ctx.currentDigest) return "export-stale";
  return null;
}

export const RECONCILE_BLOCK_TEXT: Record<Exclude<ReconcileBlock, null>, string> = {
  "already-reconciled": "This entry is already reconciled.",
  "still-syncing": "This entry is still in the sync queue. Set it aside first (that stops sending it), then reconcile it.",
  "no-desktop": "Reconciling needs the desktop app: the owner is checked with the server by the app itself.",
  "not-owner": "Owner only. Ask the owner (administrator) to sign in on this till.",
  "export-first": "Export pending transactions first (in this session) and keep the file: the export must contain this entry.",
  "export-stale": "This entry changed after the last export. Export again so the file holds this exact version.",
};

export interface ResolutionInput {
  resolution: ReconcileResolution;
  check: ServerCheck | null;
  /** matched: the server sale picked from the check's results. */
  matchedSaleId?: string | null;
  /** recreated: the new sale, as verified on the server (verifyRecreatedSale). */
  recreatedSale?: ServerSaleRef | null;
  reason: string;
}

/** Validate the owner's documented resolution against the server check.
 *  Returns the server sale the record references, or an error message. */
export function validateResolution(
  input: ResolutionInput,
  ctx: { entryDigest: string; now: number },
): { ok: true; serverRef: ServerSaleRef | null; reason: string } | { ok: false; message: string } {
  const reason = (input.reason ?? "").trim();
  if (reason.length < REASON_MIN_LENGTH) return { ok: false, message: `Write a reason (at least ${REASON_MIN_LENGTH} characters).` };
  if (reason.length > REASON_MAX_LENGTH) return { ok: false, message: `The reason is too long (max ${REASON_MAX_LENGTH} characters).` };
  const check = input.check;
  if (!check) return { ok: false, message: "Run the server check first." };
  if (check.entryDigest !== ctx.entryDigest) return { ok: false, message: "The server check was made for another version of this entry. Check again." };
  const age = ctx.now - Date.parse(check.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > SERVER_CHECK_MAX_AGE_MS) return { ok: false, message: "The server check is too old. Check again." };
  const found = [...check.matches, ...check.candidates];

  switch (input.resolution) {
    case "matched": {
      if (check.result === "not-recorded" || found.length === 0) return { ok: false, message: "The server check found no sale to match." };
      const id = check.result === "recorded" ? check.matches[0]?.saleId : input.matchedSaleId;
      const ref = found.find((s) => s.saleId === id);
      if (!ref) return { ok: false, message: "Pick one of the sales the server check found." };
      if (check.result === "recorded" && input.matchedSaleId && input.matchedSaleId !== ref.saleId) {
        return { ok: false, message: "The server check found exactly one sale; matched must reference it." };
      }
      return { ok: true, serverRef: ref, reason };
    }
    case "recreated": {
      if (check.result === "recorded") return { ok: false, message: "The server already has this sale: choose \"matched\" (re-entering it would count it twice)." };
      const sale = input.recreatedSale;
      if (!sale) return { ok: false, message: "Verify the re-entered sale on the server first." };
      if (found.some((s) => s.saleId === sale.saleId)) return { ok: false, message: "That sale is one the server check found: choose \"matched\" instead." };
      return { ok: true, serverRef: sale, reason };
    }
    case "cancelled":
      if (check.result !== "not-recorded") {
        return { ok: false, message: check.result === "recorded"
          ? "The server has this sale, so it cannot be cancelled here: choose \"matched\" (a refund goes through the normal refund flow)."
          : "\"Cancelled\" needs the server check to show \"not recorded\"." };
      }
      return { ok: true, serverRef: null, reason };
    default:
      return { ok: false, message: "Choose a resolution." };
  }
}

/** Structural consistency of a stored record (no crypto): used on load. */
export function recordConsistencyProblem(row: SyncOutboxEntry, rec: ReconciliationRecord): string | null {
  if (rec.v !== 1) return "unknown record version";
  if (rec.localId !== row.localId) return "record belongs to another entry";
  const key = row.idempotencyKey ?? (typeof row.args?.p_idempotency_key === "string" ? row.args.p_idempotency_key : null);
  if ((rec.idempotencyKey ?? null) !== key) return "idempotency key differs";
  if (!isReconcilableStatus(rec.statusBefore) || row.statusBeforeReconcile !== rec.statusBefore) return "status before reconciliation differs";
  if (!rec.owner || rec.owner.role !== "ADMIN" || !rec.owner.userId) return "owner missing";
  if (!rec.reason || rec.reason.trim().length < REASON_MIN_LENGTH) return "reason missing";
  if (!rec.check || rec.check.entryDigest !== rec.entryDigest) return "server check not bound to the entry";
  const found = [...(rec.check.matches ?? []), ...(rec.check.candidates ?? [])];
  if (rec.resolution === "cancelled" && (rec.serverRef !== null || rec.check.result !== "not-recorded")) return "cancelled without a not-recorded check";
  if (rec.resolution === "matched" && (!rec.serverRef || !found.some((s) => s.saleId === rec.serverRef!.saleId))) return "matched sale not from the check";
  if (rec.resolution === "recreated" && (!rec.serverRef || rec.check.result === "recorded")) return "recreated without a verified new sale";
  if (!["matched", "recreated", "cancelled"].includes(rec.resolution)) return "unknown resolution";
  return null;
}
