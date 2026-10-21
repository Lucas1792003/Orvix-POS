import { recoveryCodeOf } from "../../lib/failureClass";
import { refreshRecoveryEpoch } from "./recovery87";
import { useAuthStore } from "../authStore";
import { useAppStore } from "../appStore";
import { requireRecoveryV1Write } from "../../recovery/client";
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

export async function gateNewOperation(op: { opEpoch: string | null }): Promise<void> {
  // the durable state as it is NOW (another window may have entered a hold; another organisation may be signed in)
  const org = useAuthStore.getState().currentOrgId ?? null;
  await requireRecoveryV1Write(org, useAppStore.getState().currentShopId ?? null);
  await loadRecoveryState(org);
  void loadedRecoveryOrg;
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
export function assertOfflineQueueAllowed(reason: string): void {
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
