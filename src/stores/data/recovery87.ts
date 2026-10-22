import { supabase } from "../../lib/supabase";
import { localDb } from "../../lib/localDb";
import { currentBackendOrigin } from "../../lib/backendOrigin";
import { recoveryCodeOf } from "../../lib/failureClass";
import { useAuthStore } from "../authStore";
import { useAppStore } from "../appStore";
import { runRequest, type RpcOutcome } from "./idempotentRpc";
import { listJournal, type JournalRecord } from "./opJournal";
import {
  archiveTillCredential, asWitness, clearWitnessBehind, loadRecoveryState, noteEpochIssued, resetAfterRollback, noteRecoveryAbsent, noteRecoveryPresent, noteRecoveryRefusal,
  recoveryCapability, recoveryView, storedEpoch, storeTillCredential, tillCredential, v87Context, type RecoveryView,
} from "./recoveryState";

// ----------------------------------------------------------------------
// Migration 087 server actions (the only 087 interfaces a till calls besides
// op_execute_v87 / op_status_v87): recovery_epoch, recovery_register_till,
// recovery_submit_journal, recovery_approve_till. Contracts as defined in
// supabase/migrations/087_recovery_hold.sql §8 and
// docs/selfhost-migration/phase-g/migration-087.md ("API").
// ----------------------------------------------------------------------

export type RefreshResult =
  | { kind: "issued"; epochNo: number; changed: boolean }
  | { kind: "refused"; code: string; message: string }
  | { kind: "legacy-server" }
  | { kind: "unreachable"; message: string }
  | { kind: "error"; message: string };

const missingFunction = (o: RpcOutcome, fn: string): boolean =>
  o.error?.code === "PGRST202" || (o.error?.code === "42883" && (o.error.message ?? "").includes(fn));

const orgNow = (): string | null => useAuthStore.getState().currentOrgId ?? null;

/**
 * Ask the server for this till's epoch. The ONLY way out of a recovery mode:
 * the server answers with an epoch only for a reconciled till of an
 * organisation that is not held, on a server that accepts writes. Also how a
 * till learns whether its backend has 087.
 */
export async function refreshRecoveryEpoch(opts: { shopId?: string | null } = {}): Promise<RefreshResult> {
  if (recoveryView().orgId !== orgNow()) await loadRecoveryState(orgNow());
  if (!orgNow()) return { kind: "error", message: "No organisation is signed in." };
  const askedFor = orgNow();
  const before = storedEpoch();
  const outcome = await runRequest(supabase.rpc("recovery_epoch", { p_ctx: v87Context(null) }), "recovery_epoch");
  if (outcome.error) {
    if (missingFunction(outcome, "recovery_epoch")) {
      if (recoveryCapability() === "present") {
        return { kind: "error", message: "The server's schema cache does not list recovery_epoch although it has migration 087. Nothing changed; asked again later." };
      }
      await noteRecoveryAbsent();
      return { kind: "legacy-server" };
    }
    const code = recoveryCodeOf(outcome.error.message);
    if (code) {
      await noteRecoveryRefusal(code, outcome.error.message);
      return { kind: "refused", code, message: outcome.error.message };
    }
    if (outcome.error.failure.mayHaveCommitted || outcome.error.failure.klass === "NOT_DELIVERED" || outcome.error.failure.klass === "TEMPORARY_SERVER") {
      return { kind: "unreachable", message: outcome.error.message };
    }
    return { kind: "error", message: outcome.error.message };
  }
  const d = (outcome.data ?? {}) as Record<string, unknown>;
  if (typeof d.epoch !== "string" || typeof d.epoch_no !== "number") {
    return { kind: "error", message: "Unrecognised recovery_epoch reply: nothing changed." };
  }
  const shopId = opts.shopId !== undefined ? opts.shopId : useAppStore.getState().currentShopId ?? null;
  let decided = await noteEpochIssued(d.epoch, d.epoch_no, asWitness(d.witness), shopId ?? null, askedFor);
  if (decided === "recheck") {
    // the server looked behind this till: never decided from one answer — asked again, and the epoch and
    // witness of that SECOND answer are compared with the stored state
    await new Promise((r) => setTimeout(r, 1_000));
    const again = await runRequest(supabase.rpc("recovery_epoch", { p_ctx: v87Context(null) }), "recovery_epoch");
    if (again.error) {
      const code = recoveryCodeOf(again.error.message);
      return code ? { kind: "refused", code, message: again.error.message } : { kind: "unreachable", message: again.error.message };
    }
    const d2 = (again.data ?? {}) as Record<string, unknown>;
    if (typeof d2.epoch !== "string" || typeof d2.epoch_no !== "number") return { kind: "error", message: "Unrecognised recovery_epoch reply: nothing changed." };
    decided = await noteEpochIssued(d2.epoch, d2.epoch_no, asWitness(d2.witness), shopId ?? null, askedFor, true);
  }
  if (decided === "other-org") return { kind: "error", message: "Another organisation signed in while the server was asked; nothing changed." };
  if (decided === "witness-behind") return { kind: "refused", code: "WITNESS_BEHIND", message: "The server is behind what this till already saw from it." };
  // the till is reconciled for this epoch: an upload plan of the incident is done (a later incident builds a new one)
  await closeUploadPlan();
  return { kind: "issued", epochNo: d.epoch_no, changed: Boolean(before && before.epoch !== d.epoch) };
}

/** Admin (MFA, aal2): register THIS till with the server; the secret is shown once and stored only here. */
export async function registerThisTill(opts: { replaceUnknown?: boolean } = {}): Promise<{ tillId: string }> {
  const orgId = orgNow();
  if (!orgId) throw new Error("No organisation is signed in.");
  if (tillCredential()) {
    // the server answered TILL_UNKNOWN for the stored credential (its registration is gone — e.g. 087 rolled
    // back and re-applied): an MFA admin registers again; the old credential is kept as evidence
    const view = recoveryView();
    if (!opts.replaceUnknown || view.mode !== "till-unregistered" || view.code !== "TILL_UNKNOWN") {
      throw new Error("This till is already registered with this server.");
    }
    await archiveTillCredential();
  }
  const base = recoveryView().tillId;
  // A till whose credential was lost (local data cleared) cannot be registered
  // again under the same id (the server keeps it; 087 has no rotation): it is
  // registered under a new suffix — the old registration stays on the server.
  for (const tillId of [base, `${base}.r2`, `${base}.r3`, `${base}.r4`]) {
    const outcome = await runRequest(supabase.rpc("recovery_register_till", { p_till: tillId }), "recovery_register_till");
    if (outcome.error) {
      if (outcome.error.code === "23505") continue;
      if (missingFunction(outcome, "recovery_register_till")) throw new Error("This server does not have the recovery update (migration 087).");
      if ((outcome.error.message ?? "").includes("RECOVERY_ADMIN_MFA_REQUIRED")) {
        throw new Error("Registering a till needs the administrator signed in with an authenticator app (two-step sign-in). Sign in with it and try again.");
      }
      throw new Error(`The server refused to register this till: ${outcome.error.message}`);
    }
    const d = (outcome.data ?? {}) as Record<string, unknown>;
    if (typeof d.till_secret !== "string" || typeof d.till !== "string") throw new Error("Unrecognised reply while registering the till: nothing stored.");
    await noteRecoveryPresent();
    await storeTillCredential({ orgId, tillId: d.till, secret: d.till_secret });
    // a new till is unreconciled on the server until its journal is approved
    await noteRecoveryRefusal("TILL_NOT_RECONCILED", "Registered; the till's journal must be uploaded and approved.");
    return { tillId: d.till };
  }
  throw new Error("This till id is already registered on the server and its secret is not on this till. Contact the infrastructure owner.");
}

/**
 * Owner (ADMIN) only, with a written statement: this till's server was rolled
 * back to before migration 087. Done only if the server itself confirms it
 * has no recovery_epoch now (PGRST202) — a stale schema cache or an outage is
 * never enough. The till's 087 state is archived, not deleted; queued
 * operations keep their keys and epochs (on a pre-087 server they are sent as
 * before 087; the owner reconciles any created under an 087 epoch).
 */
export async function ownerConfirmRollback(statement: string): Promise<void> {
  if (useAuthStore.getState().currentRole !== "ADMIN") throw new Error("Only the owner (administrator) can confirm this.");
  if (statement.trim().length < 15) throw new Error("Write down what was rolled back and why (at least 15 characters). Nothing was changed.");
  if (recoveryCapability() !== "present") throw new Error("This till does not hold recovery state for this server. Nothing was changed.");
  const outcome = await runRequest(supabase.rpc("recovery_epoch", { p_ctx: v87Context(null) }), "recovery_epoch");
  if (!missingFunction(outcome, "recovery_epoch")) {
    throw new Error(`The server still answers for migration 087 (${outcome.error?.message ?? "it issued an epoch"}). Nothing was changed.`);
  }
  // twice, a moment apart: never decided from one answer (a server being changed may answer either way)
  await new Promise((r) => setTimeout(r, 2_000));
  const again = await runRequest(supabase.rpc("recovery_epoch", { p_ctx: v87Context(null) }), "recovery_epoch");
  if (!missingFunction(again, "recovery_epoch")) throw new Error("The server answered differently the second time. Nothing was changed.");
  await resetAfterRollback({ statement: statement.trim().slice(0, 500), by: useAuthStore.getState().currentUserId ?? null });
}

/** Owner (ADMIN), with a written statement, after checking a WITNESS_BEHIND warning (the till's witness is archived). */
export async function ownerClearWitnessBehind(statement: string): Promise<RefreshResult> {
  if (useAuthStore.getState().currentRole !== "ADMIN") throw new Error("Only the owner (administrator) can clear this warning.");
  if (statement.trim().length < 15) throw new Error("Write down what you established (at least 15 characters). Nothing was changed.");
  await clearWitnessBehind({ statement: statement.trim().slice(0, 500), by: useAuthStore.getState().currentUserId ?? null });
  return refreshRecoveryEpoch();
}

/** Admin (MFA, aal2): approve a till's uploaded journal (not the administrator's own upload). */
export async function approveTill(tillId: string): Promise<{ reconciledEpochNo: number }> {
  const outcome = await runRequest(supabase.rpc("recovery_approve_till", { p_till: tillId }), "recovery_approve_till");
  if (outcome.error) {
    const m = outcome.error.message ?? "";
    if (m.includes("RECOVERY_ADMIN_MFA_REQUIRED")) throw new Error("Approving needs the administrator signed in with an authenticator app (two-step sign-in).");
    if (m.includes("RECOVERY_SELF_APPROVAL")) throw new Error("You uploaded part of this till's journal, so you cannot approve it. Another administrator must approve it.");
    if (m.includes("RECOVERY_JOURNAL_INCOMPLETE")) throw new Error("The till's journal is not complete on the server yet (every part, the last one marked final). Let the till finish its upload.");
    throw new Error(`The server refused the approval: ${m}`);
  }
  const d = (outcome.data ?? {}) as Record<string, unknown>;
  return { reconciledEpochNo: typeof d.reconciled_epoch_no === "number" ? d.reconciled_epoch_no : -1 };
}

// ---- journal upload ------------------------------------------------------------

/** Chunk payload limit: the server refuses > 262144 bytes of jsonb text (which adds spaces). */
export const CHUNK_BYTES = 180_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_KEY = (origin: string, org: string, till: string) => `r87:upload:${origin}:${org}:${till}`;

export interface UploadPlan {
  planId: string;
  createdAt: string;
  orgId: string;
  tillId: string;
  /** Exact chunk payloads (resent byte-identical on every retry). */
  chunks: unknown[];
  recordCount: number;
  /** Last outcome per chunk number (1-based). */
  outcomes: Record<string, string>;
  completedAt?: string;
}

const FINAL_STATES = new Set(["committed", "rejected", "abandoned", "not-applied", "owner-closed"]);

/** What a reconciliation needs of one journal record (087 client contract). */
export function uploadRecordOf(r: JournalRecord): Record<string, unknown> {
  const ev = r.evidence;
  return {
    ...(UUID_RE.test(r.key) ? { key: r.key } : { unkeyed: r.key }),       // a non-UUID key would refuse the whole upload
    rpc: r.rpc, args: r.args, actor: r.actorId, org: r.orgId, shop: r.shopId, till: r.tillId, backend: r.backendOrigin,
    op_epoch: r.opEpoch ?? null, legacy: !r.opEpoch,
    state: r.state, created_at: r.createdAt, updated_at: r.updatedAt, sends: r.sends,
    first_sent_at: r.firstSentAt ?? null, last_sent_at: r.lastSentAt ?? null,
    receipt_printed: r.printedReceiptNo ?? null, printed_at: r.printedAt ?? null,
    reply: ev?.response ?? null, reply_unavailable: ev?.responseUnavailable ?? null, decision_source: ev?.source ?? null,
    code: ev?.code ?? null, message: ev?.message ?? null, signed_reply: r.signedReply ?? null, acks: r.acks ?? null,
    contradiction: r.contradiction ?? null, replaced_by: r.replacedBy ?? null, replaces: r.replaces ?? null,
    events: r.events.slice(-12),
    device_evidence_hash: r.deviceEvidenceHash ?? null,
  };
}

/** The oldest backup a server can be restored from (owner decision D9: ~190 days), plus a margin. */
export const RESTORE_HORIZON_DAYS = 200;

/**
 * Which records the server needs: a restore can lose anything committed after
 * the backup it used, and the till cannot know which backup that was — so
 * every operation within the restore horizon (pending, in doubt AND
 * committed), and every operation that is not finally decided, whatever its
 * age. (The till's last witness is NOT the restore point.)
 */
export function recordsForUpload(records: JournalRecord[], now: number = Date.now()): JournalRecord[] {
  const floor = new Date(now - RESTORE_HORIZON_DAYS * 24 * 60 * 60_000).toISOString();
  return records.filter((r) => !FINAL_STATES.has(r.state) || r.createdAt >= floor || r.updatedAt >= floor);
}

/** Split into chunks of at most CHUNK_BYTES (JSON); deterministic for the same input. */
export function chunkRecords(planId: string, tillId: string, orgId: string, records: Record<string, unknown>[], meta: Record<string, unknown> = {}): unknown[] {
  const chunks: Record<string, unknown>[][] = [];
  let cur: Record<string, unknown>[] = [];
  let size = 0;
  for (const rec of records) {
    let bytes = new TextEncoder().encode(JSON.stringify(rec)).length + 1;
    let item = rec;
    if (bytes > CHUNK_BYTES - 2_000) {
      // one huge record (a very large reply): its reply is cut, never the record's key or arguments
      item = { ...rec, reply: "[reply too large for one chunk; kept on the till]", reply_truncated: true };
      bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    }
    if (cur.length && size + bytes > CHUNK_BYTES - 2_000) { chunks.push(cur); cur = []; size = 0; }
    cur.push(item); size += bytes;
  }
  if (cur.length || chunks.length === 0) chunks.push(cur);
  return chunks.map((recs, i) => ({ v: 87, plan: planId, till: tillId, org: orgId, part: i + 1, of: chunks.length, ...meta, records: recs }));
}

export type UploadResult =
  | { kind: "stored"; chunks: number; records: number }
  | { kind: "not-required" }
  | { kind: "conflict"; chunk: number }
  | { kind: "quota-exceeded"; chunk: number }
  | { kind: "refused"; code: string | null; message: string }
  | { kind: "unreachable"; message: string };

/**
 * Upload this till's journal (evidence: never deletes anything). Built once
 * per incident and persisted BEFORE the first request, so a retry resends the
 * same bytes (the server answers already_stored); every chunk is resent on
 * each run (the server's epoch may have advanced since). Not from an
 * administrator's session: 087 forbids approving a till by anyone who
 * submitted part of its journal, and an organisation has one ADMIN.
 */
export async function uploadTillJournal(): Promise<UploadResult> {
  const orgId = orgNow();
  const cred = tillCredential();
  if (!orgId || !cred) return { kind: "refused", code: "TILL_UNKNOWN", message: "This till is not registered with the server." };
  if (useAuthStore.getState().currentRole === "ADMIN") {
    return { kind: "refused", code: "ADMIN_SESSION", message: "Upload the journal from a cashier or manager session on this till: the administrator approves it and must not have submitted it." };
  }
  const origin = currentBackendOrigin();
  const key = PLAN_KEY(origin, orgId, cred.tillId);
  let plan: UploadPlan | null = null;
  try {
    const row = await localDb.syncState.get(key);
    plan = row?.value ? (JSON.parse(row.value) as UploadPlan) : null;
  } catch (err) {
    return { kind: "refused", code: "PLAN_UNREADABLE", message: `The till could not read its upload plan (${err instanceof Error ? err.message : String(err)}). Nothing was sent.` };
  }
  if (!plan || plan.completedAt) {
    const { records, damaged } = await listJournal({ orgId });
    // this server's records only (an older build's record without a backend is kept: it may be this server's)
    const mine = records.filter((r) => !r.backendOrigin || r.backendOrigin === origin);
    const chosen = recordsForUpload(mine);
    const planId = crypto.randomUUID();
    const e = storedEpoch();
    // how far this till had seen the server, and its epochs: evidence for the owner's check (088)
    const meta = {
      created_at: new Date().toISOString(), till_witness: e?.witness ?? null, witness_at: e?.witnessAt ?? null, server_witness: e?.serverWitness ?? null,
      op_epoch: e?.epoch ?? null, epoch_no: e?.epochNo ?? null, previous_epochs: e?.previous ?? [],
      damaged_records: damaged.slice(0, 200), horizon_days: RESTORE_HORIZON_DAYS,
    };
    plan = {
      planId, createdAt: meta.created_at, orgId, tillId: cred.tillId,
      chunks: chunkRecords(planId, cred.tillId, orgId, chosen.map(uploadRecordOf), meta), recordCount: chosen.length, outcomes: {},
    };
    // durable BEFORE anything is sent (fail closed: no plan, no upload)
    await localDb.syncState.put({ key, value: JSON.stringify(plan), updatedAt: plan.createdAt });
  }
  for (let i = 0; i < plan.chunks.length; i++) {
    const n = i + 1;
    const outcome = await runRequest(supabase.rpc("recovery_submit_journal", {
      p_ctx: v87Context(null), p_chunk_no: n, p_chunk: plan.chunks[i], p_final: n === plan.chunks.length,
    }), "recovery_submit_journal");
    if (outcome.error) {
      const code = recoveryCodeOf(outcome.error.message);
      if (code) await noteRecoveryRefusal(code, outcome.error.message);
      await savePlanOutcome(key, plan, n, `error:${code ?? outcome.error.code ?? "?"}`);
      if (outcome.error.failure.retryable && !code) return { kind: "unreachable", message: outcome.error.message };
      return { kind: "refused", code: code ?? outcome.error.code ?? null, message: outcome.error.message };
    }
    const result = String((outcome.data as Record<string, unknown> | null)?.outcome ?? "");
    await savePlanOutcome(key, plan, n, result);
    if (result === "not_required") { await completePlan(key, plan); return { kind: "not-required" }; }
    if (result === "conflict") return { kind: "conflict", chunk: n };
    if (result === "quota_exceeded") return { kind: "quota-exceeded", chunk: n };
    if (result !== "stored" && result !== "already_stored") return { kind: "refused", code: null, message: `Unexpected reply for part ${n}: ${result || "(none)"}` };
  }
  return { kind: "stored", chunks: plan.chunks.length, records: plan.recordCount };
}

async function savePlanOutcome(key: string, plan: UploadPlan, n: number, outcome: string): Promise<void> {
  plan.outcomes[String(n)] = outcome;
  await localDb.syncState.put({ key, value: JSON.stringify(plan), updatedAt: new Date().toISOString() }).catch(() => undefined);
}

async function completePlan(key: string, plan: UploadPlan): Promise<void> {
  plan.completedAt = new Date().toISOString();
  await localDb.syncState.put({ key, value: JSON.stringify(plan), updatedAt: plan.completedAt }).catch(() => undefined);
}

/** Close this till's open upload plan (an epoch was issued: the incident is over). */
async function closeUploadPlan(): Promise<void> {
  const orgId = orgNow();
  const cred = tillCredential();
  if (!orgId || !cred) return;
  const key = PLAN_KEY(currentBackendOrigin(), orgId, cred.tillId);
  try {
    const row = await localDb.syncState.get(key);
    const plan = row?.value ? (JSON.parse(row.value) as UploadPlan) : null;
    if (plan && !plan.completedAt) await completePlan(key, plan);
  } catch (err) {
    console.error("[recovery] could not close the upload plan (a later incident would resend it):", err);
  }
}

/** The persisted upload plan of this till (Sync page). */
export async function currentUploadPlan(): Promise<UploadPlan | null> {
  const orgId = orgNow();
  const cred = tillCredential();
  if (!orgId || !cred) return null;
  try {
    const row = await localDb.syncState.get(PLAN_KEY(currentBackendOrigin(), orgId, cred.tillId));
    return row?.value ? (JSON.parse(row.value) as UploadPlan) : null;
  } catch {
    return null;
  }
}

/**
 * One recovery check (sign-in, startup, periodic while held, after a 429):
 * refresh the epoch; while "not-reconciled" in a non-admin session, upload
 * the journal (evidence only — nothing executes). Never clears anything on
 * its own: only an issued epoch does.
 */
let checking: Promise<RecoveryView> | null = null;
export function runRecoveryCheck(opts: { upload?: boolean } = {}): Promise<RecoveryView> {
  if (checking) return checking;
  checking = (async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return recoveryView();
    const first = await refreshRecoveryEpoch();
    const plan = await currentUploadPlan();
    const allStored = Boolean(plan && !plan.completedAt && plan.chunks.length > 0
      && plan.chunks.every((_, i) => ["stored", "already_stored"].includes(plan.outcomes[String(i + 1)] ?? "")));
    // (an already stored plan is not resent every minute; the Upload button resends it on request)
    if (first.kind === "refused" && first.code === "TILL_NOT_RECONCILED" && opts.upload !== false && !allStored
        && useAuthStore.getState().currentRole !== "ADMIN" && tillCredential()) {
      const up = await uploadTillJournal();
      if (up.kind !== "stored" && up.kind !== "not-required") console.warn("[recovery] journal upload:", up);
    }
    return recoveryView();
  })().finally(() => { checking = null; });
  return checking;
}
