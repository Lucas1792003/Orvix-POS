import { recoveryCodeOf } from "../../lib/failureClass";
import { refreshRecoveryEpoch } from "./recovery87";
import { useAuthStore } from "../authStore";
import { useAppStore } from "../appStore";
import { RecoveryV1Blocked, recoveryV1View, requireRecoveryV1Write } from "../../recovery/client";
import { authorizeOfflineOperation, maintainOfflineCapability, OfflineAuthorizationUnavailable, OFFLINE_ELIGIBLE_OPS, type OfflineAuth } from "../../recovery/offlineCapability";
import {
  assertNewOperationAllowed, loadedRecoveryOrg, loadRecoveryState, verifiedSinceStart, capabilityCheckedAt, currentOpEpoch, modeForCode, recoveryCapability, recoveryMessage, recoveryView,
  RecoveryBlockedError, offlineFinancialBlockedError, offlineFinancialOpsBlocked, verifiedWithin,
} from "./recoveryState";

// ----------------------------------------------------------------------
// Migration 087: the gate in front of every NEW financial operation (sales
// and the other offline-capable operations, online-only operations, table
// writes), before anything is saved or sent (docs/selfhost-migration/phase-g/
// migration-087.md, "Client contract": never sell before the first epoch;
// recovery mode blocks online and offline sales until recovery_epoch
// succeeds).
// ----------------------------------------------------------------------

/** How long a "this backend has no 087" answer is trusted before asking again. */
const ABSENT_RECHECK_MS = 10 * 60_000;

const online = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false;

/**
 * Throws RecoveryBlockedError unless a new operation may be created now. When
 * the backend's 087 status is unknown (or its "no 087" answer is old) and the
 * till is online, the server is asked first (one request). The operation is
 * stamped with the till's epoch HERE if it had none yet — this is still its
 * creation (nothing about it is saved or sent before this returns).
 */
let lastAskAt = 0;
/** Tests only. */
export function resetRecoveryGateForTests(): void { lastAskAt = 0; }

export async function gateNewOperation(op: { opEpoch: string | null; offlineAuth?: OfflineAuth | null },
  intent?: { name: string; amountMmk?: number; refuseOffline?: () => Error }): Promise<void> {
  // the durable state as it is NOW (another window may have entered a hold; another organisation may be signed in)
  const org = useAuthStore.getState().currentOrgId ?? null;
  const shop = useAppStore.getState().currentShopId ?? null;
  const user = useAuthStore.getState().currentUserId ?? null;
  try {
    const protectedByV1 = await requireRecoveryV1Write(org, shop);
    // connected to a Recovery V1 server and ACTIVE: keep this till's offline authorization fresh (never while offline)
    if (protectedByV1 && org && shop) void maintainOfflineCapability(org, shop, user).catch(() => undefined);
  } catch (error) {
    // Step 4: the recovery-aware server cannot be reached. An ELIGIBLE operation (a sale) may still be recorded locally
    // under a valid server-issued offline capability; anything else (and every other block) stays refused.
    if (!(error instanceof RecoveryV1Blocked) || error.reason !== "communication" || !intent || !OFFLINE_ELIGIBLE_OPS.has(intent.name) || !org || !shop) throw error;
    // the server's LAST answer must have been ACTIVE (a restriction it reported is never sold through offline, even if
    // the local capability was not withdrawn yet — e.g. a crash between saving the answer and the withdrawal)
    const last = await recoveryV1View(org).catch(() => null);
    if (last?.status?.state !== "ACTIVE") throw error;
    // Step 6 (PDISC-A): an operation that must never be recorded offline: refused before any authorization is reserved
    if (intent.refuseOffline) throw intent.refuseOffline();
    try {
      op.offlineAuth = await authorizeOfflineOperation({ orgId: org, shopId: shop, userId: user, rpc: intent.name, amountMmk: intent.amountMmk ?? 0 });
    } catch (offline) {
      if (offline instanceof OfflineAuthorizationUnavailable) throw new RecoveryV1Blocked("RESTRICTED", offline.message, "communication");
      throw offline;
    }
  }
  await loadRecoveryState(org);
  void loadedRecoveryOrg;
  if (op.offlineAuth) {
    // Step 4: authorized by a server-issued offline capability (Recovery V1, which needs 087). The capability replaces
    // the v87.x "server now" rule for THIS operation only: it was issued by the server while connected and ACTIVE, is
    // bounded (count, value, expiry, epoch) and is verified again by the server at sync. The till must still hold an
    // epoch and must not be in recovery mode; a sale created under an older epoch is held there for review.
    if (!op.opEpoch) op.opEpoch = currentOpEpoch();
    assertNewOperationAllowed(op.opEpoch);
    return;
  }
  const cap = recoveryCapability();
  const checkedAt = capabilityCheckedAt();
  const stale = cap === "absent" && (!checkedAt || Date.now() - Date.parse(checkedAt) > ABSENT_RECHECK_MS);
  const view = recoveryView();
  // blocked by a state the SERVER set: ask again (only the server can clear it — e.g. after an approval);
  // at most once a minute (an unreachable server must not slow every sale down)
  // after every start an ONLINE till asks the server before its first new operation (fresh authorization)
  const firstSinceStart = cap === "present" && !verifiedSinceStart();
  if (online() && (firstSinceStart || (Date.now() - lastAskAt > 60_000 && (cap === "unknown" || stale || (cap === "present" && !view.allowed))))) {
    lastAskAt = Date.now();
    await refreshRecoveryEpoch().catch((err) => console.warn("[recovery] epoch check failed:", err));
  }
  if (offlineFinancialOpsBlocked()) await requireFreshAuthorization();
  if (!op.opEpoch) op.opEpoch = currentOpEpoch();
  assertNewOperationAllowed(op.opEpoch);
}

/** v87.x: how recently THIS process must have been authorised by the server (recovery_epoch) for a new financial
 *  operation on an 087 server (or one whose 087 status is not established). Older: the server is asked again first. */
export const FRESH_AUTHORIZATION_MS = 2 * 60_000;

/**
 * v87.x (recoveryState.ts, "emergency safeguard"): on an 087 server a new financial operation needs the server NOW —
 * the till online, and an epoch the server issued to this process within FRESH_AUTHORIZATION_MS (else it is asked;
 * an unreachable server or any refusal stops the operation). A stale epoch on disk, a temporary network failure, a
 * restart or another window never authorise anything here. Only an explicit "no 087" answer restores the old rules.
 */
async function requireFreshAuthorization(): Promise<void> {
  if (!online()) throw offlineFinancialBlockedError("This till is offline.");
  if (verifiedWithin(FRESH_AUTHORIZATION_MS)) return;
  lastAskAt = Date.now();
  const r = await refreshRecoveryEpoch().catch((err): { kind: "error"; message: string } => ({ kind: "error", message: String(err) }));
  if (r.kind === "legacy-server" && !offlineFinancialOpsBlocked()) return;   // the server answered: no 087 (pre-087 rules apply)
  if (r.kind === "issued" && verifiedWithin(FRESH_AUTHORIZATION_MS)) return;
  if (r.kind === "refused") assertNewOperationAllowed(currentOpEpoch());     // the server's own reason (hold, reconciliation, ...)
  throw offlineFinancialBlockedError(r.kind === "unreachable" ? "The server could not be reached."
    : `The server could not confirm this till right now${"message" in r && r.message ? ` (${r.message})` : ""}.`);
}

/** v87.x: refuse to stage / queue a NEW financial operation offline on an 087 server (the shared layers call this
 *  before anything is persisted; existing queued operations are never touched). */
export function assertOfflineQueueAllowed(reason: string, offlineAuth?: OfflineAuth | null): void {
  // Step 4: an operation reserved under a server-issued offline capability is the one exception (gateNewOperation)
  if (offlineAuth) return;
  if (offlineFinancialOpsBlocked()) throw offlineFinancialBlockedError(reason);
}

/** What the cashier is told when the server refused an operation with an 087 code. */
export function recoveryRefusalError(message: string): RecoveryBlockedError {
  const code = recoveryCodeOf(message);
  const mode = (code ? modeForCode(code) : null) ?? recoveryView().mode;
  const shown = mode === "legacy-server" ? "uncertain" : mode;
  return new RecoveryBlockedError(shown, code,
    `Not recorded — the server refused it: ${recoveryMessage(shown, code)}`);
}
