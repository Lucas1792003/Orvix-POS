// RC3 reconciliation constants. Dependency-free (the recovery tool and the
// export reader import them without the app's database).

/** One syncState row per local reconciliation log line
 *  ("reconcile-log:<id>", JSON in `value`). Never cleared by a load or a
 *  backend change (those clear only named keys). */
export const RECONCILE_LOG_PREFIX = "reconcile-log:";

/** Statuses an owner may reconcile: entries the till will never send by
 *  itself. pending / syncing / failed are still in (or about to re-enter)
 *  the drain, so the owner sets them aside first; that stops sending. */
export const RECONCILABLE_STATUSES = ["conflict", "quarantined", "archived"] as const;

/** A server check older than this must be repeated before reconciling. */
export const SERVER_CHECK_MAX_AGE_MS = 10 * 60 * 1000;

export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 500;
