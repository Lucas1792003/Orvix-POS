import { recoveryCodeOf } from "../../lib/failureClass";
import { refreshRecoveryEpoch } from "./recovery87";
import { useAuthStore } from "../authStore";
import {
  assertNewOperationAllowed, loadedRecoveryOrg, loadRecoveryState, verifiedSinceStart, capabilityCheckedAt, currentOpEpoch, modeForCode, recoveryCapability, recoveryMessage, recoveryView,
  RecoveryBlockedError,
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
  if (!op.opEpoch) op.opEpoch = currentOpEpoch();
  assertNewOperationAllowed(op.opEpoch);
}

/** What the cashier is told when the server refused an operation with an 087 code. */
export function recoveryRefusalError(message: string): RecoveryBlockedError {
  const code = recoveryCodeOf(message);
  const mode = (code ? modeForCode(code) : null) ?? recoveryView().mode;
  const shown = mode === "legacy-server" ? "uncertain" : mode;
  return new RecoveryBlockedError(shown, code,
    `Not recorded — the server refused it: ${recoveryMessage(shown, code)}`);
}
