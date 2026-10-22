import { localDb } from "../lib/localDb";
import { currentBackendOrigin } from "../lib/backendOrigin";
import { supabase } from "../lib/supabase";
import { enrolledDevice } from "./deviceVault";
import { TrustUnavailable } from "./trust";
import { withdrawOfflineCapability } from "./offlineCapability";
import { recoveryCapability } from "../stores/data/recoveryState";

export type RecoveryV1State = "ACTIVE" | "RESTRICTED" | "RECONCILING" | "QUARANTINED";
export interface RecoveryV1Status {
  protocol: "orvix-recovery-v1";
  org_id: string;
  state: RecoveryV1State;
  recovered_as_of: string | null;
  uncertainties: string[];
  required_evidence: true;
}
interface Marker { present: boolean; checkedAt: number; status: RecoveryV1Status | null }
const markerKey = (origin: string, org: string) => `rv1:status:${JSON.stringify([origin, org])}`;
const ABSENT_RECHECK_MS = 60_000;
const listeners = new Set<() => void>();
export function onRecoveryV1Change(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Why a write is blocked. `communication`: a recovery-aware server could not be
 *  asked (network, timeout, 5xx, offline; nothing was sent; the operation keeps its
 *  key and waits). `authorization`: the recovery-aware server was reached but did not
 *  accept this session (expired sign-in, inactive account) even after one session
 *  refresh; nothing was sent, the operation keeps its key and waits for a new
 *  sign-in. `restricted`: the server answered with a non-ACTIVE state, or the
 *  device/organization cannot be authorized. `integrity`: local evidence or the
 *  server's answer is malformed. Only `integrity` stops a queued operation for a
 *  person; every other reason is a hold that is retried automatically. */
export type RecoveryV1BlockReason = "communication" | "authorization" | "restricted" | "integrity";
export class RecoveryV1Blocked extends Error {
  readonly state: RecoveryV1State;
  readonly reason: RecoveryV1BlockReason;
  constructor(state: RecoveryV1State, detail: string, reason: RecoveryV1BlockReason = "restricted") {
    super(`Recovery ${state.toLowerCase()}: ${detail} ${reason === "communication"
      ? "Operations already queued stay on this device with their keys and are retried automatically once the server answers."
      : reason === "authorization"
      ? "Operations already queued stay on this device with their keys and are retried automatically after you sign in again."
      : "Existing operations and evidence stay on this device. Do not enter an uncertain sale again; queued ones are kept and retried only after the server allows it."}`);
    this.name = "RecoveryV1Blocked";
    this.state = state;
    this.reason = reason;
  }
}

/** Before a server has EVER answered with the recovery protocol, a failed status
 *  request (network, timeout, 5xx, Tailscale down) is not a restriction: the
 *  server may be a legacy 085/086/087 server and the existing offline-first rules
 *  apply. The failure is remembered in memory only (never persisted as "absent"),
 *  so an unreachable server does not slow every sale with a new request. */
const UNREACHABLE_RECHECK_MS = 30_000;
const unreachableAt = new Map<string, number>();
/** Tests only. */
export function resetRecoveryV1ForTests(): void { unreachableAt.clear(); }

/** The server answered, but not for this session: an expired / invalid JWT (PostgREST
 *  401, PGRST301-303) or a caller V1 does not accept (no active app user in this
 *  organization). Distinct from a network failure, which never reaches the server. */
export function isAuthorizationFailure(error: { code?: string; message?: string } | null, status?: number): boolean {
  if (!error) return false;
  const code = String(error.code ?? ""); const message = String(error.message ?? "");
  return status === 401 || code === "PGRST301" || code === "PGRST302" || code === "PGRST303"
    || /jwt expired|invalid jwt|jwt.*(malformed|invalid)|not authenticated/i.test(message)
    || (code === "42501" && message.includes("RECOVERY_V1_CALLER_REQUIRED"));
}

function statusOf(value: unknown, orgId: string): RecoveryV1Status | null {
  if (!value || typeof value !== "object") return null;
  const s = value as RecoveryV1Status;
  return s.protocol === "orvix-recovery-v1" && s.org_id === orgId && ["ACTIVE", "RESTRICTED", "RECONCILING", "QUARANTINED"].includes(s.state)
    && s.required_evidence === true && (s.recovered_as_of === null || typeof s.recovered_as_of === "string")
    && Array.isArray(s.uncertainties) && s.uncertainties.every((v) => typeof v === "string") ? s : null;
}

export async function recoveryV1View(orgId: string, origin = currentBackendOrigin()): Promise<Marker> {
  const row = await localDb.syncState.get(markerKey(origin, orgId));
  if (!row) return { present: false, checkedAt: 0, status: null };
  try {
    const marker = JSON.parse(row.value ?? "null") as Marker;
    if (!marker || typeof marker.present !== "boolean" || !Number.isFinite(marker.checkedAt)) throw new Error("invalid");
    return { ...marker, status: statusOf(marker.status, orgId) };
  } catch { throw new RecoveryV1Blocked("QUARANTINED", "Recovery state is unreadable and will not be reset."); }
}

/** Safe reads expose the server's as-of claim and uncertainty. They are not
 * proofs of current balances, profit, settlements, shift state or inventory. */
export async function refreshRecoveryV1(orgId: string, options: { origin?: string; force?: boolean } = {}): Promise<RecoveryV1Status | null> {
  const origin = options.origin ?? currentBackendOrigin();
  const before = await recoveryV1View(orgId, origin);
  const backendRequired = Boolean(await localDb.syncState.get(`rv1:protocol:${origin}`));
  // Positively identified as recovery-aware (durable, per backend and per org):
  // from here on no failure, timeout or missing function can authorize a write.
  const known = before.present || backendRequired;
  const failKey = JSON.stringify([origin, orgId]);
  if (!known && !options.force) {
    if (before.checkedAt && Date.now() - before.checkedAt < ABSENT_RECHECK_MS) return null;
    const failed = unreachableAt.get(failKey);
    if (failed !== undefined && Date.now() - failed < UNREACHABLE_RECHECK_MS) return null;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (known) throw new RecoveryV1Blocked("RESTRICTED", "The server cannot confirm recovery authorization while offline.", "communication");
    return null; // legacy-only offline behavior, explicitly not a V1 guarantee.
  }
  // The till must be able to record what the server said before anything is saved
  // or sent: storage that cannot hold the marker refuses the operation (fail closed).
  const persist = async (rows: { key: string; value: string }[]): Promise<void> => {
    try {
      for (const row of rows) await localDb.syncState.put({ ...row, updatedAt: new Date().toISOString() });
    } catch {
      throw new RecoveryV1Blocked("RESTRICTED", "Not saved and nothing was sent (an operation that was already queued stays queued with its key). This device could not record the server's recovery status (storage unavailable or full). Preserve the device profile.", "restricted");
    }
  };
  // Unknown server and the request failed: legacy rules (not cached as "absent").
  // review (first-contact window): a server known to run 087 is never treated as legacy because ONE status request
  // failed — Recovery V1 is installed after 087, so an unanswered status there is a communication failure
  const legacyUnknown = (): null => {
    if (recoveryCapability() === "present") unreachable();
    unreachableAt.set(failKey, Date.now()); return null;
  };
  const unreachable = (): never => {
    throw new RecoveryV1Blocked("RESTRICTED", "Not saved and nothing was sent (an operation that was already queued stays queued with its key). The recovery-aware server could not be asked for its recovery state. Preserve the device profile.", "communication");
  };
  type Reply = { data: unknown; error: { code?: string; message?: string } | null; status?: number };
  const ask = async (): Promise<Reply | "failed"> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const request = supabase.rpc("recovery_v1_status", { p_org_id: orgId });
      return await (typeof request.abortSignal === "function" ? request.abortSignal(controller.signal) : request) as Reply;
    } catch { return "failed"; } finally { clearTimeout(timer); }
  };
  let asked = await ask();
  if (asked === "failed") {
    if (!known) return legacyUnknown();
    return unreachable();
  }
  // A recovery-aware server that did not accept this session: authorization, not
  // network. One session refresh and one re-ask; never more (no loop per sale).
  // On a server NOT yet identified as recovery-aware the 085 rules apply unchanged:
  // the outbox's own 401 handling refreshes and retries with the same key.
  if (known && isAuthorizationFailure(asked.error, asked.status)) {
    let refreshed = false;
    try {
      const { error: refreshError } = await supabase.auth.refreshSession();
      // the auth server could not be reached: a network failure, not a refused sign-in
      const refreshStatus = (refreshError as { status?: number } | null)?.status;
      if (refreshError && (refreshError.name === "AuthRetryableFetchError" || refreshStatus === 0 || (refreshStatus !== undefined && refreshStatus >= 500))) return unreachable();
      refreshed = !refreshError;
    } catch { return unreachable(); }
    if (refreshed) {
      asked = await ask();
      if (asked === "failed") return unreachable();
    }
    if (!refreshed || isAuthorizationFailure(asked.error, asked.status)) {
      throw new RecoveryV1Blocked("RESTRICTED", "Not saved and nothing was sent (an operation that was already queued stays queued with its key). The recovery-aware server did not accept this sign-in (expired session, inactive account, or an account of another organization).", "authorization");
    }
  }
  const reply = asked;
  const error = reply.error;
  if (error) {
    const missing = error.code === "PGRST202" && String(error.message ?? "").includes("recovery_v1_status");
    if (missing) {
      if (known) throw new RecoveryV1Blocked("RESTRICTED", "A previously required recovery protocol is missing; a downgrade cannot authorize writes.", "integrity");
      unreachableAt.delete(failKey);
      await persist([{ key: markerKey(origin, orgId), value: JSON.stringify({ present: false, checkedAt: Date.now(), status: null }) }]);
      return null;
    }
    // Any other failure: a communication failure, not an answer.
    if (!known) return legacyUnknown();
    return unreachable();
  }
  const status = statusOf(reply.data, orgId);
  // A 200 that is not a valid status for THIS organization is never a legacy
  // signal (a legacy server answers PGRST202): fail closed.
  if (!status) throw new RecoveryV1Blocked("QUARANTINED", "The recovery status reply is malformed or belongs to another organization.", "integrity");
  unreachableAt.delete(failKey);
  await persist([{ key: `rv1:protocol:${origin}`, value: "required" }, { key: markerKey(origin, orgId), value: JSON.stringify({ present: true, checkedAt: Date.now(), status }) }]);
  // Step 4: the server says the organization is not ACTIVE: any local offline authority ends now (not at its expiry)
  if (status.state !== "ACTIVE") await withdrawOfflineCapability(orgId, null, `the server reported ${status.state}`, origin).catch(() => undefined);
  for (const listener of listeners) listener();
  return status;
}

/** Called before new operations, manual retry/reconciliation and each actual
 * financial RPC attempt. A restored ACTIVE assertion alone cannot enroll a key. */
export async function requireRecoveryV1Write(orgId: string | null, shopId: string | null, options: { origin?: string; requireDevice?: boolean } = {}): Promise<boolean> {
  const origin = options.origin ?? currentBackendOrigin();
  if (!orgId) {
    if (await localDb.syncState.get(`rv1:protocol:${origin}`)) throw new RecoveryV1Blocked("RESTRICTED", "The organization is unknown.");
    return false; // Legacy callers; server tenant/authorization guards still apply.
  }
  const status = await refreshRecoveryV1(orgId, { origin });
  if (!status) return false; // Compatible legacy server; V1 is unprotected.
  if (status.state !== "ACTIVE") throw new RecoveryV1Blocked(status.state, "The organization is closed for financial and ownership writes pending independent recovery review.");
  if (options.requireDevice !== false) {
    if (!shopId) throw new RecoveryV1Blocked("RESTRICTED", "The operation has no unambiguous shop. It cannot be signed safely.");
    try { await enrolledDevice(origin, orgId, shopId); }
    catch (error) { throw new RecoveryV1Blocked("RESTRICTED", error instanceof TrustUnavailable ? error.message : "Independent device authorization could not be verified.", "restricted"); }
  }
  return true;
}
