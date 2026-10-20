import { create } from "zustand";
import { localDb } from "../../lib/localDb";
import { currentBackendOrigin } from "../../lib/backendOrigin";
import { getTillId } from "../../lib/tillId";
import { setEpochHeaderProvider } from "../../lib/epochHeader";

// ----------------------------------------------------------------------
// Migration 087 client state: the till's recovery mode, its server-issued
// epoch and witness, its till credential and whether the backend has 087
// (docs/selfhost-migration/phase-g/migration-087.md, "Client contract").
//
// Everything lives in Dexie `syncState` (never cleared by a snapshot load,
// a sign-out or a reconnect), keyed by backend origin + organisation (+ till
// for the epoch), so it survives an app or Electron restart, a sign-out, a
// network loss and an offline-to-online transition. An in-memory copy for
// the signed-in organisation serves the synchronous readers (beginOperation,
// the x-orvix-epoch header).
//
// Rules (never relaxed by connectivity):
//  - The epoch is only ever the value `recovery_epoch` returned. Nothing here
//    invents, guesses or re-stamps one; an operation keeps the epoch it was
//    created under (stamped once, at creation).
//  - Recovery mode is entered from the SERVER's refusals (PT429 codes, the
//    committed `{outcome:'held'}` reply) and left ONLY by a successful
//    `recovery_epoch` (the server issues an epoch only to a reconciled till
//    of an organisation that is not held, on a server that accepts writes).
//  - Fail closed: state that cannot be read counts as "uncertain"; a backend
//    whose 087 status is unknown blocks new financial operations until it
//    has been asked (online).
//  - A backend that has never shown 087 (it answers PGRST202 for
//    recovery_epoch) keeps the pre-087 behaviour. Once a backend has shown
//    087 it is remembered for good (durably, per origin).
// ----------------------------------------------------------------------

/** Server-side recovery codes (migration 087 refusal contract) + client-side states. */
export type RecoveryMode =
  | "normal"            // a verified epoch is held; new operations allowed
  | "no-epoch"          // 087 server, no epoch fetched yet (or it is stale): ask the server
  | "hold"              // the organisation or the server is held (RECOVERY_HOLD, ORG_UNRESOLVED, CONTINUITY_ROLLBACK)
  | "uncertain"         // server continuity uncertain (LEASE_INVALID, IDENTITY_CHANGED, NO_CONTINUITY, API_GUARD, WITNESS_INVALID, unreadable state)
  | "till-unregistered" // this till has no valid credential on this server (TILL_UNKNOWN)
  | "not-reconciled";   // the till must upload its journal and be approved (TILL_NOT_RECONCILED)

export type Capability = "unknown" | "present" | "absent";

export interface StoredEpoch {
  epoch: string;
  epochNo: number;
  witness: Witness | null;
  /** The highest witness recovery_epoch has shown (evidence; never sent as the till's own). */
  serverWitness?: Witness | null;
  /** When this till last received a witness (client clock). */
  witnessAt: string | null;
  obtainedAt: string;
  orgId: string;
  shopId: string | null;
  tillId: string;
  backendOrigin: string;
  /** Earlier epochs this till held for the organisation (newest last). */
  previous?: { epoch: string; epochNo: number; replacedAt: string; witness?: Witness | null }[];
}

/** A signed till witness as the server issues it (org, epoch_no, n, h, mac). */
export interface Witness {
  org: string;
  epoch_no: number;
  n: number;
  h: string;
  mac: string;
}

export interface TillCredential {
  tillId: string;
  secret: string;
  orgId: string;
  backendOrigin: string;
  registeredAt: string;
}

export interface ModeRecord {
  mode: RecoveryMode;
  code: string | null;
  detail: string | null;
  since: string;
  updatedAt: string;
  /** Set when a recovery_epoch call verified the till (mode "normal"). */
  verifiedAt?: string | null;
}

const KEY = {
  capability: (origin: string) => `r87:capability:${origin}`,
  till: (origin: string, org: string) => `r87:till:${origin}:${org}`,
  epoch: (origin: string, org: string, till: string) => `r87:epoch:${origin}:${org}:${till}`,
  mode: (origin: string, org: string) => `r87:mode:${origin}:${org}`,
} as const;
export const RECOVERY_KEY_PREFIX = "r87:";

/** PT429 code → till mode (null: a per-operation refusal, no mode change). */
export function modeForCode(code: string): RecoveryMode | null {
  switch (code) {
    case "RECOVERY_HOLD": case "CONTINUITY_ROLLBACK": return "hold";
    case "LEASE_INVALID": case "IDENTITY_CHANGED": case "NO_CONTINUITY": case "API_GUARD": case "WITNESS_INVALID": case "WITNESS_BEHIND": return "uncertain";
    case "TILL_UNKNOWN": return "till-unregistered";
    case "TILL_NOT_RECONCILED": return "not-reconciled";
    // PRE_EPOCH_OPERATION / CLIENT_UPGRADE_REQUIRED / FENCE_NOT_APPLIED / ORG_UNRESOLVED (a row that resolves
    // to no organisation while ANOTHER one is held) concern ONE operation
    default: return null;
  }
}

export class RecoveryBlockedError extends Error {
  readonly mode: RecoveryMode | "unknown-server";
  readonly code: string | null;
  constructor(mode: RecoveryMode | "unknown-server", code: string | null, message: string) {
    super(message);
    this.name = "RecoveryBlockedError";
    this.mode = mode;
    this.code = code;
  }
}

export const isRecoveryBlocked = (err: unknown): err is RecoveryBlockedError =>
  err instanceof RecoveryBlockedError || (err instanceof Error && err.name === "RecoveryBlockedError");

/** The cashier-facing sentence for a mode (shown by the banner and by every refused action). */
export function recoveryMessage(mode: RecoveryMode | "unknown-server", code: string | null = null): string {
  const c = code ? ` [${code}]` : "";
  switch (mode) {
    case "hold":
      return `Recovery hold active${c}: the server is holding this organisation while it is checked after a recovery. No sales or other financial operations can be entered — online or offline. Everything already saved on this till is kept with its original key; nothing is resent automatically.`;
    case "uncertain":
      if (code === "WITNESS_BEHIND") {
        return "Server continuity uncertain [WITNESS_BEHIND]: the server is behind what this till already received from it — it may have been restored from an older backup. No sales or other financial operations can be entered. Everything on this till is kept; tell the owner (this till's record is evidence for the check).";
      }
      return `Server continuity uncertain${c}: the server cannot confirm it is the same, up-to-date server. No sales or other financial operations can be entered until it is verified. Everything saved on this till is kept; nothing is resent automatically.`;
    case "till-unregistered":
      return `Till reconciliation required${c}: this till is not registered with the server. An administrator with an authenticator app (two-step sign-in) must register it on the Sync page before sales can resume.`;
    case "not-reconciled":
      return `Till reconciliation required${c}: this till must upload its operation journal and an administrator must approve it on the Sync page before sales can resume. Nothing saved on this till is deleted.`;
    case "no-epoch":
      return `Waiting for the server's recovery epoch${c}: this till has not been authorised by the server yet. Connect to the server; sales resume only once it confirms this till.`;
    case "unknown-server":
      return "This till has not yet checked whether its server is in a recovery hold. Connect to the server once; sales resume only after that check.";
    case "normal":
      return "Safe to resume: the server has verified this till.";
  }
}

// ---- second, independent record of a blocking state (fail closed) ---------------
//
// Entering any blocking mode is written to localStorage FIRST (synchronous, a
// different storage engine than IndexedDB), then to Dexie. Loading honours it
// even when Dexie says "normal" (its write failed, or the record was lost);
// only an epoch issued by the server removes it. If both stores fail, the
// block holds for this process; after a restart an ONLINE till asks the server
// before anything is sold or sent (verifiedThisProcess), and an OFFLINE till
// is in the documented unwitnessed tail (the server never executes a stale
// epoch).
const BLOCK_KEY = (origin: string, org: string) => `r87:block:${origin}:${org}`;
const storageOrNull = (): Storage | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
};
function writeBlockRecord(origin: string, org: string, rec: ModeRecord): void {
  const ls = storageOrNull();
  if (!ls) return;
  try { ls.setItem(BLOCK_KEY(origin, org), JSON.stringify({ mode: rec.mode, code: rec.code, since: rec.since })); }
  catch (err) { console.error("[recovery] could not write the backup record of the recovery state (kept for this session):", err); }
}
function clearBlockRecord(origin: string, org: string): void {
  try { storageOrNull()?.removeItem(BLOCK_KEY(origin, org)); } catch { /* the next issued epoch clears it */ }
}
/** "unreadable": the store exists but throws (fail closed). */
function readBlockRecord(origin: string, org: string): ModeRecord | null | "unreadable" {
  const ls = storageOrNull();
  if (!ls) return null;
  try {
    const v = ls.getItem(BLOCK_KEY(origin, org));
    if (!v) return null;
    const r = JSON.parse(v) as { mode?: RecoveryMode; code?: string | null; since?: string };
    const mode: RecoveryMode = r.mode && r.mode !== "normal" ? r.mode : "uncertain";
    const at = new Date().toISOString();
    return { mode, code: r.code ?? null, detail: "Restored from this till's backup record of its recovery state.", since: r.since ?? at, updatedAt: at, verifiedAt: null };
  } catch {
    return "unreadable";
  }
}

/** The server authorised this till (issued its epoch) since this process started. */
let verifiedThisProcess = false;
/** When it last did, and for which backend / organisation / till (monotonic clock: a wall-clock change never extends
 *  it). Memory only: a restart, a reload or another window starts without one, so a stale epoch on disk never counts
 *  as a fresh authorisation. */
let verifiedAt: { origin: string; orgId: string; tillId: string; at: number } | null = null;
const monotonicNow = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
export function verifiedSinceStart(): boolean {
  return verifiedThisProcess;
}
/** The server issued THIS till its epoch, for the organisation signed in now on this backend, within the last `ms`
 *  milliseconds, in THIS process. */
export function verifiedWithin(ms: number): boolean {
  if (!verifiedThisProcess || !verifiedAt) return false;
  const m = current();
  if (verifiedAt.origin !== m.origin || verifiedAt.orgId !== m.orgId || verifiedAt.tillId !== m.tillId) return false;
  const age = monotonicNow() - verifiedAt.at;
  return age >= 0 && age <= ms;
}
/** v87.x: a request of this till did not reach the server (or its reply was lost): the next new financial operation
 *  must reach the server first (a recent authorisation no longer counts). */
export function noteAuthorizationLost(): void {
  verifiedAt = null;
}
/** Tests only: the last authorisation happened `ms` earlier than recorded (inert outside the unit-test build). */
export function ageAuthorizationForTests(ms: number): void {
  if (import.meta.env?.MODE === "test" && verifiedAt) verifiedAt = { ...verifiedAt, at: verifiedAt.at - ms };
}

// ---- in-memory view of the signed-in organisation ----------------------------

interface Mem {
  origin: string;
  orgId: string | null;
  tillId: string;
  capability: Capability;
  capabilityAt: string | null;
  till: TillCredential | null;
  epoch: StoredEpoch | null;
  mode: ModeRecord | null;
  /** Reading the durable state failed: everything counts as uncertain. */
  unreadable: boolean;
}

// Which organisation is signed in now (wired by stores/data/outbox.ts, like the
// actor source): state loaded for ANOTHER organisation is never used for it.
let orgSource: (() => string | null) | null = null;
export function setRecoveryOrgSource(next: () => string | null): void {
  orgSource = next;
}
/** The in-memory state, as it applies to the organisation signed in NOW: for
 *  another organisation than the one loaded, nothing of it (fail closed). */
function current(): Mem {
  if (!orgSource) return mem;
  let org: string | null = null;
  try { org = orgSource(); } catch { org = null; }
  if (org === mem.orgId) return mem;
  return { ...mem, orgId: org, till: null, epoch: null, mode: null };
}

// The unit suites emulate servers without 087: under vitest the capability
// starts PINNED to "absent" (like idempotentRpc's 086 pin) unless a test opts in.
let pinned: Capability | null = import.meta.env?.MODE === "test" ? "absent" : null;

const fresh = (): Mem => ({
  origin: currentBackendOrigin(), orgId: null, tillId: safeTillId(), capability: pinned ?? "unknown", capabilityAt: pinned ? new Date().toISOString() : null,
  till: null, epoch: null, mode: null, unreadable: false,
});
let mem: Mem = fresh();

/** The server-side id of this till: its local id, or that id re-registered with a ".rN" suffix. */
export const isThisTill = (serverId: string, localId: string): boolean => serverId === localId || new RegExp(`^${localId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.r[0-9]+$`).test(serverId);

function safeTillId(): string {
  try { return getTillId(); } catch { return "till-unknown"; }
}

export interface RecoveryView {
  orgId: string | null;
  capability: Capability;
  mode: RecoveryMode | "unknown-server" | "legacy-server";
  code: string | null;
  detail: string | null;
  since: string | null;
  verifiedAt: string | null;
  epochNo: number | null;
  tillId: string;
  /** The id this till is registered under on the server (may carry a ".rN" suffix). */
  serverTillId: string | null;
  tillRegistered: boolean;
  /** New financial operations may be created right now. */
  allowed: boolean;
}

export const useRecoveryStore = create<{ view: RecoveryView }>()(() => ({ view: computeView(current()) }));

function effectiveMode(m: Mem): RecoveryView["mode"] {
  if (m.unreadable) return "uncertain";
  const stored = m.mode?.mode;
  // A recovery refusal holds the till even on a server not (yet) known to have 087.
  if (stored && stored !== "normal" && stored !== "no-epoch") return stored;
  if (m.capability === "absent") return "legacy-server";
  if (m.capability === "unknown") return "unknown-server";
  if (!m.till) return "till-unregistered";
  if (!m.epoch || stored !== "normal") return stored === "no-epoch" || !stored ? "no-epoch" : stored;
  return "normal";
}

function computeView(m: Mem): RecoveryView {
  const mode = effectiveMode(m);
  return {
    orgId: m.orgId, capability: m.capability, mode,
    code: m.unreadable ? "STATE_UNREADABLE" : m.mode?.code ?? null,
    detail: m.unreadable ? "The till could not read its recovery state." : m.mode?.detail ?? null,
    since: m.mode?.since ?? null, verifiedAt: m.mode?.verifiedAt ?? null,
    epochNo: m.epoch?.epochNo ?? null, tillId: m.tillId, serverTillId: m.till?.tillId ?? null, tillRegistered: Boolean(m.till),
    allowed: mode === "normal" || mode === "legacy-server",
  };
}

function publish(): void {
  useRecoveryStore.setState({ view: computeView(current()) });
}

const parse = <T>(v: string | undefined): T | null => {
  if (!v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
};

/** Load the durable state for `orgId` on this backend (sign-in, startup, organisation change). */
export async function loadRecoveryState(orgId: string | null): Promise<RecoveryView> {
  const origin = currentBackendOrigin();
  const tillId = safeTillId();
  const next: Mem = { ...fresh(), origin, orgId, tillId };
  try {
    const cap = await localDb.syncState.get(KEY.capability(origin));
    const capVal = parse<{ capability: Capability; at: string }>(cap?.value);
    next.capability = pinned ?? (capVal?.capability === "present" || capVal?.capability === "absent" ? capVal.capability : "unknown");
    next.capabilityAt = pinned ? new Date().toISOString() : capVal?.at ?? null;
    if (orgId) {
      next.till = parse<TillCredential>((await localDb.syncState.get(KEY.till(origin, orgId)))?.value);
      next.epoch = parse<StoredEpoch>((await localDb.syncState.get(KEY.epoch(origin, orgId, tillId)))?.value);
      next.mode = parse<ModeRecord>((await localDb.syncState.get(KEY.mode(origin, orgId)))?.value);
      // the backup record of a blocking state wins over a stored "normal" (or a missing record)
      const backup = readBlockRecord(origin, orgId);
      if (backup === "unreadable") next.unreadable = true;
      else if (backup && (!next.mode || next.mode.mode === "normal" || next.mode.mode === "no-epoch")) next.mode = backup;
      // a credential / epoch written for another till or server is never used
      // (a till re-registered after a lost credential carries a suffix: "<till>.r2" … — still this till)
      if (next.till && (!isThisTill(next.till.tillId, tillId) || next.till.backendOrigin !== origin)) next.till = null;
      if (next.epoch && (next.epoch.tillId !== tillId || next.epoch.orgId !== orgId || next.epoch.backendOrigin !== origin)) next.epoch = null;
    }
  } catch (err) {
    console.error("[recovery] could not read the till's recovery state (treated as uncertain):", err);
    next.unreadable = true;
  }
  mem = next;
  publish();
  return computeView(current());
}

/** The current view (synchronous). */
export function recoveryView(): RecoveryView {
  return computeView(current());
}

/** The organisation whose state is loaded in memory. */
export function loadedRecoveryOrg(): string | null {
  return mem.orgId;
}

export function recoveryCapability(): Capability {
  return mem.capability;
}

/** The backend has 087 for good (any 087 answer proves it). */
export async function noteRecoveryPresent(): Promise<void> {
  if (mem.capability === "present" || pinned === "absent") return;
  mem.capability = "present";
  mem.capabilityAt = new Date().toISOString();
  publish();
  await localDb.syncState.put({ key: KEY.capability(mem.origin), value: JSON.stringify({ capability: "present", at: mem.capabilityAt }), updatedAt: mem.capabilityAt })
    .catch((err) => console.error("[recovery] could not record that this server has 087 (kept for this session):", err));
}

/** The backend answered PGRST202 for recovery_epoch and has never shown 087. */
export async function noteRecoveryAbsent(): Promise<void> {
  if (mem.capability === "present" || pinned) return;           // never downgraded
  mem.capability = "absent";
  mem.capabilityAt = new Date().toISOString();
  publish();
  await localDb.syncState.put({ key: KEY.capability(mem.origin), value: JSON.stringify({ capability: "absent", at: mem.capabilityAt }), updatedAt: mem.capabilityAt })
    .catch(() => undefined);
}

/**
 * Owner-confirmed: the backend was rolled back to before 087 (it answers
 * PGRST202 for recovery_epoch again). Its 087 state on this till is archived
 * (kept as evidence) and the till behaves as for a server without 087.
 * Called only by recovery87.ownerConfirmRollback after the server's answer.
 */
export async function resetAfterRollback(note: Record<string, unknown>): Promise<void> {
  const at = new Date().toISOString();
  const origin = mem.origin;
  await localDb.transaction("rw", localDb.syncState, async () => {
    const rows = await localDb.syncState.where("key").startsWith(RECOVERY_KEY_PREFIX).toArray();
    const mine = rows.filter((r) => r.key.includes(`:${origin}`) && !r.key.startsWith("r87:archived:") && !r.key.startsWith("r87:upload:"));
    for (const r of mine) {
      await localDb.syncState.put({ ...r, key: `r87:archived:${Date.now()}:${r.key}`, updatedAt: at });
      await localDb.syncState.delete(r.key);
    }
    await localDb.syncState.put({ key: `r87:rollback-reset:${origin}:${Date.now()}`, value: JSON.stringify({ at, ...note }), updatedAt: at });
    await localDb.syncState.put({ key: KEY.capability(origin), value: JSON.stringify({ capability: "absent", at }), updatedAt: at });
  });
  if (mem.orgId) clearBlockRecord(origin, mem.orgId);
  mem = { ...fresh(), origin, orgId: mem.orgId, capability: pinned ?? "absent", capabilityAt: at };
  publish();
}

/** When the backend was last found to lack 087 (re-asked periodically; never while pinned by a test). */
export function capabilityCheckedAt(): string | null {
  return pinned ? new Date().toISOString() : mem.capabilityAt;
}

async function putMode(rec: ModeRecord): Promise<void> {
  if (!mem.orgId || current().orgId !== mem.orgId) return;   // never into another organisation's state
  // the till's own rollback evidence is cleared only by the owner (clearWitnessBehind), never by a later refusal
  const stored = parse<ModeRecord>((await localDb.syncState.get(KEY.mode(mem.origin, mem.orgId)).catch(() => undefined))?.value);
  if ((stored ?? mem.mode)?.code === "WITNESS_BEHIND" && rec.code !== "WITNESS_BEHIND") return;
  if (rec.mode !== "normal") writeBlockRecord(mem.origin, mem.orgId, rec);     // first: the independent record
  mem.mode = rec;
  publish();
  await localDb.syncState.put({ key: KEY.mode(mem.origin, mem.orgId), value: JSON.stringify(rec), updatedAt: rec.updatedAt });
}

/**
 * The server refused with an 087 code (or answered {outcome:'held'}). Enters
 * the mode the code means (durably). Per-operation codes change nothing here.
 */
export async function noteRecoveryRefusal(code: string, detail?: string | null): Promise<RecoveryMode | null> {
  // The maintenance listener (API_GUARD) is not the database: on a backend never seen with 087 (its install
  // window, or a rollback of it) it is an outage, not a recovery state — nothing is stored.
  if (code === "API_GUARD" && mem.capability !== "present") return null;
  const mode = modeForCode(code);
  if (code !== "API_GUARD") await noteRecoveryPresent();   // any database refusal proves 087
  if (!mode) return null;
  const at = new Date().toISOString();
  const keepSince = mem.mode && mem.mode.mode === mode ? mem.mode.since : at;
  await putMode({ mode, code, detail: detail?.slice(0, 300) ?? null, since: keepSince, updatedAt: at, verifiedAt: null })
    .catch((err) => {
      // the in-memory mode is already set (blocks this session); the next load reads the old one
      console.error("[recovery] could not persist the recovery mode:", err);
    });
  return mode;
}

/** Our current epoch was refused as stale (PRE_EPOCH_OPERATION for an operation stamped with it). */
export async function noteEpochStale(detail: string): Promise<void> {
  const at = new Date().toISOString();
  await putMode({ mode: "no-epoch", code: "PRE_EPOCH_OPERATION", detail: detail.slice(0, 300), since: at, updatedAt: at, verifiedAt: null })
    .catch((err) => console.error("[recovery] could not persist the stale-epoch state:", err));
}

/**
 * `recovery_epoch` succeeded: the ONLY way back to "normal". The epoch is the
 * server's value as returned; an earlier one is kept in `previous`.
 */
/**
 * The server's witness is BEHIND what this till has already seen from it:
 * a lower epoch, or the same epoch with a lower chain position or another
 * hash at the same position. recovery_epoch never checks the till's witness
 * (087 SQL), so this is the till's own evidence of a rollback that the server
 * may not have detected (e.g. a restore inside the unwitnessed tail).
 */
export function witnessBehind(server: Witness | null, mine: Witness | null): boolean {
  if (!server || !mine || server.org !== mine.org) return false;
  if (server.epoch_no < mine.epoch_no) return true;
  if (server.epoch_no > mine.epoch_no) return false;               // a newer epoch: an ordinary recovery
  if (server.n < mine.n) return true;
  return server.n === mine.n && server.h !== mine.h;
}

/**
 * `recovery_epoch` succeeded for `forOrg`: the ONLY way back to "normal". The
 * epoch is the server's value as returned; an earlier one is kept in
 * `previous`. Decided against the STORED state, inside the write transaction
 * (another window may have changed it), and never for another organisation
 * than the one asked for. The till's witness (its evidence of how far it saw
 * the server) is never replaced by the server's within an epoch:
 *  - server behind (lower epoch, lower n, or same n with another hash):
 *    WITNESS_BEHIND — sticky, cleared only by the owner (clearWitnessBehind);
 *  - server ahead in the same epoch: the till keeps ITS witness; the next v87
 *    operation sends it and the server's own check_witness compares the hash
 *    at that position (a fork makes the SERVER commit a hold);
 *  - a newer epoch: the new witness, the old one kept in `previous`.
 * Returns what was decided.
 */
export async function noteEpochIssued(
  epoch: string, epochNo: number, witness: Witness | null, shopId: string | null, forOrg?: string | null, confirmed = false,
): Promise<"normal" | "witness-behind" | "other-org" | "recheck"> {
  if (!mem.orgId) throw new Error("No organisation is signed in.");
  const org = mem.orgId;
  if (forOrg !== undefined && forOrg !== org) return "other-org";
  if (current().orgId !== org) return "other-org";
  const at = new Date().toISOString();
  let result: "normal" | "witness-behind" | "recheck" = "normal";
  let stored: StoredEpoch | null = null;
  let rec: ModeRecord | null = null;
  await localDb.transaction("rw", localDb.syncState, async () => {
    const prev = parse<StoredEpoch>((await localDb.syncState.get(KEY.epoch(mem.origin, org, mem.tillId)))?.value) ?? mem.epoch;
    const mode = parse<ModeRecord>((await localDb.syncState.get(KEY.mode(mem.origin, org)))?.value) ?? mem.mode;
    const behindNow = witnessBehind(witness, prev?.witness ?? null);
    // a NEW "behind" is never decided from one answer (another window's sale may have committed after this
    // snapshot was read): the caller asks the server again and passes `confirmed`
    if (behindNow && mode?.code !== "WITNESS_BEHIND" && !confirmed) { result = "recheck"; return; }
    if (mode?.code === "WITNESS_BEHIND" || behindNow) {
      result = "witness-behind";
      rec = mode?.code === "WITNESS_BEHIND" ? mode : {
        mode: "uncertain", code: "WITNESS_BEHIND", since: at, updatedAt: at, verifiedAt: null,
        detail: `The server is behind what this till already saw from it (till witness epoch ${prev!.witness!.epoch_no} n=${prev!.witness!.n}; server epoch ${witness!.epoch_no} n=${witness!.n}): it may have been restored from an older backup. The owner must check it before anything continues.`,
      };
      writeBlockRecord(mem.origin, org, rec);
      await localDb.syncState.put({ key: KEY.mode(mem.origin, org), value: JSON.stringify(rec), updatedAt: at });
      stored = prev ?? null;
      return;
    }
    const sameEpoch = Boolean(prev && witness && prev.witness && witness.epoch_no === prev.witness.epoch_no);
    const keepMine = (sameEpoch && prev!.witness!.n >= 0 && witness!.n > prev!.witness!.n)    // server ahead: keep ours
      || (!witness && Boolean(prev?.witness) && prev!.epochNo === epochNo);                  // (no witness in the reply: keep ours)
    stored = {
      epoch, epochNo, witness: keepMine ? prev!.witness : witness,
      witnessAt: keepMine ? prev!.witnessAt : witness ? at : prev?.witnessAt ?? null,
      // the highest witness the SERVER has shown this till (evidence alongside the till's own)
      serverWitness: witness && (!prev?.serverWitness || prev.serverWitness.epoch_no < witness.epoch_no || prev.serverWitness.n <= witness.n) ? witness : prev?.serverWitness ?? null,
      obtainedAt: at, orgId: org, shopId, tillId: mem.tillId, backendOrigin: mem.origin,
      previous: prev && prev.epoch !== epoch
        ? [...(prev.previous ?? []), { epoch: prev.epoch, epochNo: prev.epochNo, replacedAt: at, witness: prev.witness }].slice(-20)
        : prev?.previous,
    };
    rec = { mode: "normal", code: null, detail: null, since: at, updatedAt: at, verifiedAt: at };
    // both, or neither: a crash between them must not leave "normal" without the epoch
    await localDb.syncState.put({ key: KEY.epoch(mem.origin, org, mem.tillId), value: JSON.stringify(stored), updatedAt: at });
    await localDb.syncState.put({ key: KEY.mode(mem.origin, org), value: JSON.stringify(rec), updatedAt: at });
  });
  if ((result as string) === "recheck") return "recheck";
  if (mem.orgId === org) { mem.epoch = stored; mem.mode = rec; }
  if (result === "normal") {
    // the server authorised this till: the backup record of a blocking state goes (after the Dexie commit)
    clearBlockRecord(mem.origin, org);
    verifiedThisProcess = true;
    verifiedAt = { origin: mem.origin, orgId: org, tillId: mem.tillId, at: monotonicNow() };
  }
  if (result === "normal") await noteRecoveryPresent();
  publish();
  return result;
}

/**
 * Owner (ADMIN, checked by the caller) after investigating a WITNESS_BEHIND:
 * the till's witness is archived (evidence) and the till asks the server for
 * its epoch again. The server's own witness then becomes the till's.
 */
export async function clearWitnessBehind(note: Record<string, unknown>): Promise<void> {
  const m = current();
  if (!m.orgId || m.mode?.code !== "WITNESS_BEHIND") throw new Error("There is no continuity warning of this kind on this till.");
  const at = new Date().toISOString();
  await localDb.transaction("rw", localDb.syncState, async () => {
    await localDb.syncState.put({ key: `r87:witness-archived:${m.origin}:${m.orgId}:${Date.now()}`, value: JSON.stringify({ at, epoch: m.epoch, mode: m.mode, ...note }), updatedAt: at });
    if (m.epoch) await localDb.syncState.put({ key: KEY.epoch(m.origin, m.orgId!, m.tillId), value: JSON.stringify({ ...m.epoch, witness: null, witnessAt: null }), updatedAt: at });
    await localDb.syncState.put({ key: KEY.mode(m.origin, m.orgId!), value: JSON.stringify({ mode: "no-epoch", code: null, detail: "Cleared by the owner after a continuity check.", since: at, updatedAt: at, verifiedAt: null }), updatedAt: at });
  });
  clearBlockRecord(m.origin, m.orgId);   // the owner's decision (the server still has to issue the epoch)
  await loadRecoveryState(m.orgId);
}

/** A newer witness from a v87 reply (same organisation and epoch, n not lower). */
export async function noteWitness(w: unknown): Promise<void> {
  const wit = asWitness(w);
  if (!wit || !mem.epoch || wit.org !== mem.epoch.orgId || wit.epoch_no !== mem.epoch.epochNo) return;
  if (mem.epoch.witness && wit.n < mem.epoch.witness.n) return;
  const at = new Date().toISOString();
  const next: StoredEpoch = { ...mem.epoch, witness: wit, witnessAt: at };
  mem.epoch = next;
  await localDb.syncState.put({ key: KEY.epoch(mem.origin, next.orgId, mem.tillId), value: JSON.stringify(next), updatedAt: at })
    .catch((err) => console.error("[recovery] could not store the latest witness (the previous one stays valid):", err));
}

export function asWitness(w: unknown): Witness | null {
  const o = (w && typeof w === "object" ? w : null) as Record<string, unknown> | null;
  if (!o || typeof o.org !== "string" || typeof o.epoch_no !== "number" || typeof o.n !== "number" || typeof o.h !== "string" || typeof o.mac !== "string") return null;
  return { org: o.org, epoch_no: o.epoch_no, n: o.n, h: o.h, mac: o.mac };
}

export async function storeTillCredential(cred: Omit<TillCredential, "backendOrigin" | "registeredAt" | "tillId"> & { tillId?: string }): Promise<void> {
  const at = new Date().toISOString();
  const full: TillCredential = { tillId: cred.tillId ?? mem.tillId, secret: cred.secret, orgId: cred.orgId, backendOrigin: mem.origin, registeredAt: at };
  await localDb.syncState.put({ key: KEY.till(mem.origin, full.orgId), value: JSON.stringify(full), updatedAt: at });
  if (full.orgId === mem.orgId) mem.till = full;
  publish();
}

/** Keep a credential the server no longer knows as evidence, then forget it (re-registration). */
export async function archiveTillCredential(): Promise<void> {
  const m = current();
  if (!m.till || !m.orgId) return;
  const at = new Date().toISOString();
  await localDb.transaction("rw", localDb.syncState, async () => {
    await localDb.syncState.put({ key: `r87:till-archived:${m.origin}:${m.orgId}:${Date.now()}`, value: JSON.stringify({ ...m.till, archivedAt: at }), updatedAt: at });
    await localDb.syncState.delete(KEY.till(m.origin, m.orgId!));
  });
  if (mem.orgId === m.orgId) mem.till = null;
  publish();
}

export function tillCredential(): TillCredential | null {
  return current().till;
}

export function storedEpoch(): StoredEpoch | null {
  return current().epoch;
}

/** The epoch a NEW operation is stamped with: only in mode "normal" with an
 *  issued epoch; null otherwise (and on a server without 087). Synchronous. */
export function currentOpEpoch(): string | null {
  const m = current();
  return computeView(m).mode === "normal" ? m.epoch?.epoch ?? null : null;
}

/** The till context every v87 call carries. `opEpoch`: the operation's OWN
 *  creation epoch (never replaced; "" for an operation created without one). */
export function v87Context(opEpoch: string | null): Record<string, unknown> {
  const m = current();
  return {
    till: m.till?.tillId ?? m.tillId,
    till_secret: m.till?.secret ?? "",
    op_epoch: opEpoch ?? "",
    witness: m.epoch?.witness ?? null,
  };
}

/**
 * Before a NEW financial operation is created (nothing persisted yet):
 * throws RecoveryBlockedError unless this till may create one now. On an 087
 * server that means mode "normal", an issued epoch, and that the operation
 * was stamped with it. `stamped`: the epoch the caller stamped at creation.
 */
export function assertNewOperationAllowed(stamped: string | null | undefined): void {
  const m = current();
  const view = computeView(m);
  if (view.mode === "legacy-server") return;
  if (view.mode !== "normal") {
    throw new RecoveryBlockedError(view.mode, view.code, recoveryMessage(view.mode, view.code));
  }
  if (!stamped || stamped !== m.epoch?.epoch) {
    throw new RecoveryBlockedError("no-epoch", null,
      "This operation was started before the till had its current recovery epoch. Nothing was saved or sent — enter it again.");
  }
}

// ---- v87.x emergency safeguard: no NEW offline financial operations on an 087 server ----------------------------
// A v87 till cannot mark an offline sale as provisional: it would be shown as recorded although the server has not seen
// it and, after a recovery, may never execute it (docs/selfhost-migration/phase-g/v87-client.md, "Offline financial
// operations"). So on a backend that has migration 087 — or whose 087 status is NOT established (unknown, unreadable
// state, any recovery mode) — a new financial operation is created only while the server can be reached and has
// authorised this till recently in this process; it is never staged, queued or shown offline. Only a backend that
// answered explicitly that it has no 087 keeps the pre-087 offline rules. Operations already queued are untouched.

/** Code of the refusal (RecoveryBlockedError.code). */
export const OFFLINE_FINANCIAL_DISABLED = "OFFLINE_FINANCIAL_DISABLED";

/** Tests only: behave like the build BEFORE v87.x (offline operations queued on 087 servers), to create the queues
 *  such a build left behind on a till. Inert outside the unit-test build. */
let preV87xForTests = false;
export function simulatePreV87xClientForTests(on: boolean): void {
  if (import.meta.env?.MODE === "test") preV87xForTests = on;
}

/** How long a backend's "no 087" answer keeps the pre-087 offline rules. Older (a till that has not reached the server
 *  since — 087 may have been installed meanwhile): the status counts as not established, so new financial operations
 *  need the server again (the online gate re-asks after ABSENT_RECHECK_MS, recoveryGate.ts). */
export const ABSENT_OFFLINE_TRUST_MS = 30 * 60_000;

/** New financial operations must not be created, staged or queued offline on this backend. */
export function offlineFinancialOpsBlocked(): boolean {
  if (preV87xForTests && import.meta.env?.MODE === "test") return false;
  const m = current();
  if (m.unreadable) return true;
  if (m.mode?.mode && m.mode.mode !== "normal" && m.mode.mode !== "no-epoch") return true;   // a recovery refusal, on any backend
  if (m.capability !== "absent") return true;
  if (pinned === "absent") return false;   // unit suites emulating a pre-087 backend
  const at = m.capabilityAt ? Date.parse(m.capabilityAt) : NaN;
  const age = Date.now() - at;
  return !(age >= 0 && age <= ABSENT_OFFLINE_TRUST_MS);   // stale, missing or future-dated: not established
}

/** What the cashier is told: nothing was saved; why; what to do. */
export function offlineFinancialBlockedError(reason: string): RecoveryBlockedError {
  const mode = computeView(current()).mode;
  return new RecoveryBlockedError(mode === "legacy-server" ? "uncertain" : mode, OFFLINE_FINANCIAL_DISABLED,
    `Not recorded — nothing was saved. ${reason} On this server, sales, money entries and other changes can only be made while the ` +
    "till is connected and the server has confirmed it; offline entries are switched off (recovery safeguard). Reconnect, then enter it again.");
}

/** True while automatic sending must stop (any recovery state on a backend
 *  that has 087, or a recovery refusal on any backend). */
export function recoveryBlocksSending(): boolean {
  const view = computeView(current());
  return !(view.mode === "normal" || view.mode === "legacy-server" || view.mode === "unknown-server");
}

/** Tests only: start a new app instance's view; `capability` pins what the
 *  till believes (null: unpinned, as in the app — learnt from the server). */
export function resetRecoveryStateForTests(capability: Capability | null = "absent"): void {
  pinned = capability === "unknown" ? null : capability;
  verifiedThisProcess = false;
  verifiedAt = null;
  mem = fresh();
  if (capability === "unknown") mem.capability = "unknown";
  publish();
}

// The header value for a PostgREST write created now (lib/epochHeader.ts).
setEpochHeaderProvider(() => currentOpEpoch());
