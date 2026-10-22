// Recovery V1, Step 5: this till's owner-approved device identity (docs/recovery-v1/STEP5-DESIGN.md §1).
//
// * Request-signing key: RSA-2048 RSASSA-PKCS1-v1_5 / SHA-256, generated here with WebCrypto `extractable: false` and kept
//   in the device vault (IndexedDB structured clone). The server verifies every financial operation's signature in
//   PostgreSQL. HONEST LIMIT: non-extractable stops app code from exporting the key; Chromium still serialises it into
//   the profile on disk. It is not hardware-bound: copying the profile clones the till. The per-operation counter makes a
//   clone or a rolled-back profile collide with counters the server already recorded (refused).
// * Evidence key: ECDSA P-256 (also non-extractable) for the local evidence journal; its public key is inside the
//   enrollment request the RSA key signs, which the owner's approval binds (request id + nonce + key fingerprint).
// * Trust anchor: the owner's key fingerprints PROVISIONED on this till out of band (Electron owner-trust.json / build
//   setting), never taken from the server. Without one the till never considers itself trusted.
// Nothing here ever regenerates, replaces or resets an identity silently: a new identity is an explicit re-enrollment.
import Dexie, { type Table } from "dexie";
import { supabase } from "../lib/supabase";
import { runRequest } from "../stores/data/idempotentRpc";
import { digest, toBase64 } from "./canonical";
import type { DeviceIdentity } from "./deviceVault";
import type { Enrollment } from "./trust";
import { TrustUnavailable } from "./trust";

export const DEVICE_HEADER = "x-orvix-device";

export interface OwnerKey { keyId: string; n: string; e: number; fingerprint: string; scope: string }
export interface VerifiedEnrollment {
  enrollmentId: string; authorization: string; signature: string; ownerKey: OwnerKey; notAfter: string; verifiedAt: string;
}
export interface TillStatus { state: string; checkedAt: number; reason?: string | null; containment?: { kind: string; reason: string; eventId: number } | null }
export interface TillIdentity {
  scope: string; origin: string; orgId: string; shopId: string; deviceId: string;
  signingKey: CryptoKey; publicN: string; fingerprint: string;
  evidenceKey: CryptoKey; evidencePublicKey: string;
  requestId: string; requestNonce: string; requestText: string; requestSig: string; replacesEnrollmentId: string | null;
  createdAt: string; nextCounter: number;
  enrollment: VerifiedEnrollment | null;
  lastStatus: TillStatus | null;
  /** an earlier identity of this till that this one replaced (kept, never deleted) */
  retired?: boolean;
}
interface CounterRow { opKey: string; scope: string; counter: number; rpc: string; enrollmentId?: string; marker?: string }

class TillVault extends Dexie {
  tills!: Table<TillIdentity, string>;
  counters!: Table<CounterRow, string>;
  constructor() {
    super("orvix-recovery-till-v1");
    this.version(1).stores({ tills: "scope", counters: "opKey, scope" });
  }
}
export const tillVault = new TillVault();
export const tillScope = (origin: string, orgId: string, shopId: string): string => JSON.stringify([origin, orgId, shopId]);

// ---------------------------------------------------------------- trust anchors (owner key fingerprints, provisioned)
let anchorsForTests: string[] | null = null;
/** Tests only. */
export function setOwnerTrustAnchorsForTests(value: string[] | null): void { anchorsForTests = value; }
export async function ownerTrustAnchors(): Promise<string[]> {
  if (anchorsForTests) return anchorsForTests;
  const valid = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)).slice(0, 8) : [];
  const api = (globalThis as { electronAPI?: { ownerTrustAnchors?: () => Promise<unknown> } }).electronAPI;
  if (api?.ownerTrustAnchors) {
    try { return valid(await api.ownerTrustAnchors()); } catch { return []; }
  }
  const built = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ORVIX_OWNER_TRUST_ANCHORS ?? "";
  return valid(built.split(",").map((s) => s.trim()).filter(Boolean));
}

// ---------------------------------------------------------------- crypto primitives
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const hexOf = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const b64urlToHex = (s: string): string => hexOf(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer);
const hexToB64url = (hex: string): string => {
  const h = hex.length % 2 ? "0" + hex : hex;
  const bytes = new Uint8Array(h.length / 2); for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return toBase64(bytes.buffer).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const canonicalHex = (hex: string): string => hex.toLowerCase().replace(/^0+/, "") || "0";
/** The fingerprint PostgreSQL computes (recovery_v1.owner_key_fingerprint): sha256 of "<hex modulus without leading zeros>:65537". */
export async function keyFingerprint(nHex: string): Promise<string> {
  return hexOf(await crypto.subtle.digest("SHA-256", utf8(`${canonicalHex(nHex)}:65537`)));
}
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
export async function rsaSignHex(key: CryptoKey, text: string): Promise<string> {
  return hexOf(await crypto.subtle.sign(RSA.name, key, utf8(text)));
}
export async function rsaVerifyHex(nHex: string, text: string, sigHex: string): Promise<boolean> {
  try {
    if (!/^[0-9a-f]+$/.test(sigHex) || sigHex.length % 2) return false;
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: hexToB64url(canonicalHex(nHex)), e: "AQAB", ext: true }, RSA, false, ["verify"]);
    const sig = new Uint8Array(sigHex.length / 2); for (let i = 0; i < sig.length; i++) sig[i] = parseInt(sigHex.slice(2 * i, 2 * i + 2), 16);
    return await crypto.subtle.verify(RSA.name, key, sig, utf8(text));
  } catch { return false; }
}
/** marker: "<capabilityId>:<deviceSeq>" for an operation recorded offline, else "online" — signed, so removing or changing the
 *  x-orvix-offline header invalidates the signature (recovery_v1.offline_marker). */
export const offlineMarker = (offline: { capabilityId: string; deviceSeq: number } | null | undefined): string =>
  offline ? `${offline.capabilityId}:${offline.deviceSeq}` : "online";
export const requestMessage = (enrollmentId: string, orgId: string, shopId: string, key: string, rpc: string, counter: number, marker = "online"): string =>
  `orvix-device-request-v1\n${enrollmentId}\n${orgId}\n${shopId}\n${key}\n${rpc}\n${counter}\n${marker}`;

// ---------------------------------------------------------------- server calls (recovery_v1_call)
async function call(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await runRequest(supabase.rpc("recovery_v1_call", { p_action: action, p_args: args }) as never, `recovery_v1_call ${action}`, 15_000);
  if (outcome.error) throw new TrustUnavailable(`The server refused the device request (${outcome.error.message}).`);
  return (outcome.data ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------- enrollment workflow
export type TillPhase = "no-anchor" | "none" | "pending" | "trusted" | "suspended" | "revoked" | "replaced" | "expired" | "invalid" | "unverified" | "damaged";
export interface TillView {
  phase: TillPhase; deviceId: string | null; shortCode: string | null; fingerprint: string | null; requestId: string | null;
  enrollmentId: string | null; notAfter: string | null; message: string; anchors: number;
}

export async function currentTill(origin: string, orgId: string, shopId: string): Promise<TillIdentity | null> {
  return (await Dexie.ignoreTransaction(() => tillVault.tills.get(tillScope(origin, orgId, shopId)))) ?? null;
}

const PHASE_MESSAGE: Record<TillPhase, string> = {
  "no-anchor": "This till has no owner trust anchor provisioned. Device enrollment is disabled; financial operations stay refused.",
  none: "This till is not enrolled. Request enrollment, then ask the owner to approve the code below.",
  pending: "Enrollment requested. The owner must approve this till (compare the code). Financial operations stay refused until then.",
  trusted: "This till is enrolled and its approval was verified against the owner's key.",
  suspended: "This till is suspended. Only the owner can reinstate it.",
  revoked: "This till was revoked. Its key can never be used again; a new identity needs a new owner-approved enrollment.",
  replaced: "This till's enrollment was replaced by a newer one. Re-enroll this till if it is still in use.",
  expired: "This till's enrollment expired. A new owner approval is required.",
  invalid: "The server's record of this till's enrollment does not verify. Treat as compromised; re-enroll.",
  unverified: "The approval the server returned does not verify against this till's owner trust anchor. Not trusted.",
  damaged: "This till's stored identity is unreadable or does not match its key. It will not be regenerated silently; re-enroll.",
};

export async function tillView(origin: string, orgId: string, shopId: string): Promise<TillView> {
  const anchors = await ownerTrustAnchors();
  let t: TillIdentity | null;
  try { t = await currentTill(origin, orgId, shopId); } catch { return view("damaged", null, anchors.length); }
  if (!anchors.length) return view("no-anchor", t, 0);
  if (!t) return view("none", null, anchors.length);
  if (!t.signingKey || t.signingKey.extractable || t.signingKey.type !== "private" || !t.evidenceKey || t.evidenceKey.extractable
      || await keyFingerprint(t.publicN) !== t.fingerprint) return view("damaged", t, anchors.length);
  const s = t.lastStatus?.state;
  if (t.enrollment && (!s || s === "ACTIVE")) return view("trusted", t, anchors.length);
  if (s === "SUSPENDED") return view("suspended", t, anchors.length);
  if (s === "REVOKED") return view("revoked", t, anchors.length);
  if (s === "REPLACED") return view("replaced", t, anchors.length);
  if (s === "EXPIRED") return view("expired", t, anchors.length);
  if (s === "INVALID") return view("invalid", t, anchors.length);
  if (s === "UNVERIFIED") return view("unverified", t, anchors.length);
  return view("pending", t, anchors.length);
}
function view(phase: TillPhase, t: TillIdentity | null, anchors: number): TillView {
  return { phase, deviceId: t?.deviceId ?? null, shortCode: t ? t.fingerprint.slice(0, 16).toUpperCase().replace(/(.{4})(?!$)/g, "$1-") : null,
    fingerprint: t?.fingerprint ?? null, requestId: t?.requestId ?? null, enrollmentId: t?.enrollment?.enrollmentId ?? null,
    notAfter: t?.enrollment?.notAfter ?? null, message: PHASE_MESSAGE[phase], anchors };
}

/** Create a NEW identity and ask the server to record its enrollment request. Never overwrites an existing identity unless
 *  `replace` is given (re-enrollment after revocation / loss / expiry): the old one is kept as retired evidence. */
export async function requestEnrollment(origin: string, orgId: string, shopId: string, opts: { replace?: boolean } = {}): Promise<TillView> {
  if (!(await ownerTrustAnchors()).length) throw new TrustUnavailable(PHASE_MESSAGE["no-anchor"]);
  const scope = tillScope(origin, orgId, shopId);
  const existing = await currentTill(origin, orgId, shopId);
  if (existing && !opts.replace) {
    // an earlier request that never reached the server is re-sent with its ORIGINAL text (same key, nonce, id)
    if (!existing.enrollment) await call("device.request", { request: existing.requestText, signature: existing.requestSig });
    return tillView(origin, orgId, shopId);
  }
  const pair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, false, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicN = canonicalHex(b64urlToHex(jwk.n!));
  const evidence = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const evidencePublicKey = toBase64(await crypto.subtle.exportKey("spki", evidence.publicKey));
  const fingerprint = await keyFingerprint(publicN);
  const deviceId = `till-${crypto.randomUUID()}`;
  // (review 2, L4) a replacement names the old enrollment only while it can still be replaced (not when it is itself already REPLACED)
  const replaces = opts.replace && existing?.lastStatus?.state !== "REPLACED" ? existing?.enrollment?.enrollmentId ?? null : null;
  const doc = { protocol: "orvix-device-enrollment-request-v1", requestId: crypto.randomUUID(), orgId, shopId, deviceId, publicKey: { n: publicN, e: 65537 },
    keyFingerprint: fingerprint, evidencePublicKey, requestNonce: crypto.randomUUID(), requestedAt: new Date().toISOString(), replacesEnrollmentId: replaces };
  const requestText = JSON.stringify(doc);
  const requestSig = await rsaSignHex(pair.privateKey, requestText);
  const row: TillIdentity = { scope, origin, orgId, shopId, deviceId, signingKey: pair.privateKey, publicN, fingerprint, evidenceKey: evidence.privateKey,
    evidencePublicKey, requestId: doc.requestId, requestNonce: doc.requestNonce, requestText, requestSig, replacesEnrollmentId: replaces,
    createdAt: doc.requestedAt, nextCounter: 1, enrollment: null, lastStatus: null };
  // the identity is persisted BEFORE it is sent: a crash never leaves a server request whose key this till lost
  await tillVault.transaction("rw", tillVault.tills, async () => {
    if (existing) await tillVault.tills.put({ ...existing, scope: `${scope}#retired:${existing.createdAt}`, retired: true });
    if (existing) await tillVault.tills.delete(scope);
    await tillVault.tills.add(row);
  });
  await call("device.request", { request: requestText, signature: requestSig });
  return tillView(origin, orgId, shopId);
}

/** Verify an owner-signed approval exactly as the database does, against THIS till's pinned anchors and its own request. */
export async function verifyApproval(t: TillIdentity, status: Record<string, unknown>, anchors: string[], now = Date.now()): Promise<VerifiedEnrollment | null> {
  try {
    const ownerKey = status.ownerKey as OwnerKey; const authorization = String(status.authorization ?? ""); const signature = String(status.signature ?? "");
    if (!ownerKey || !anchors.includes(ownerKey.fingerprint) || await keyFingerprint(ownerKey.n) !== ownerKey.fingerprint || ownerKey.e !== 65537) return null;
    if (!await rsaVerifyHex(ownerKey.n, authorization, signature)) return null;
    const a = JSON.parse(authorization) as { protocol?: string; purpose?: string; keyId?: string; scope?: string; device?: Record<string, unknown> };
    const d = a.device ?? {};
    if (a.protocol !== "orvix-owner-authorization-v1" || a.purpose !== "enroll-device" || a.keyId !== ownerKey.keyId || a.scope !== t.orgId
      || d.requestId !== t.requestId || d.orgId !== t.orgId || d.shopId !== t.shopId || d.deviceId !== t.deviceId || d.keyFingerprint !== t.fingerprint
      || d.requestNonce !== t.requestNonce || (d.replacesEnrollmentId ?? null) !== t.replacesEnrollmentId || typeof d.notAfter !== "string"
      || !(Date.parse(d.notAfter) > now) || status.enrollmentId !== t.requestId) return null;
    return { enrollmentId: t.requestId, authorization, signature, ownerKey, notAfter: d.notAfter, verifiedAt: new Date(now).toISOString() };
  } catch { return null; }
}

/** Ask the server for this till's state; record an owner approval once it verifies locally. */
export async function refreshTill(origin: string, orgId: string, shopId: string): Promise<TillView> {
  const t = await currentTill(origin, orgId, shopId);
  if (!t) return tillView(origin, orgId, shopId);
  const status = await call("device.status", { deviceId: t.deviceId });
  const state = String(status.state ?? "NONE");
  let enrollment = t.enrollment;
  let recorded = state;
  if (state === "ACTIVE" && !enrollment) {
    enrollment = await verifyApproval(t, status, await ownerTrustAnchors());
    if (!enrollment) recorded = "UNVERIFIED";
  }
  if (state === "ACTIVE" && enrollment && status.enrollmentId !== enrollment.enrollmentId) recorded = "INVALID";
  const containment = (status.lastContainment ?? null) as TillStatus["containment"];
  await tillVault.tills.update(t.scope, { enrollment, lastStatus: { state: recorded, checkedAt: Date.now(), containment } });
  return tillView(origin, orgId, shopId);
}

const STATUS_FRESH_MS = 60_000;
/** The till's identity when it may sign a financial operation now (enrolled, verified, server-ACTIVE). */
export async function trustedTill(origin: string, orgId: string, shopId: string, opts: { online: boolean }): Promise<TillIdentity> {
  let v = await tillView(origin, orgId, shopId);
  const t0 = await currentTill(origin, orgId, shopId);
  if (opts.online && t0 && (v.phase === "pending" || v.phase === "trusted") && (!t0.lastStatus || Date.now() - t0.lastStatus.checkedAt > STATUS_FRESH_MS)) {
    try { v = await refreshTill(origin, orgId, shopId); } catch (e) { if (v.phase !== "trusted") throw e; }
  }
  const t = await currentTill(origin, orgId, shopId);
  if (v.phase !== "trusted" || !t || !t.enrollment) throw new TrustUnavailable(`Independent device authorization unavailable: ${v.message}`);
  return t;
}

/** Allocate this operation's counter (persisted BEFORE signing; a retry of the same operation reuses it). */
async function counterFor(t: TillIdentity, opKey: string, rpc: string, marker: string): Promise<number> {
  return Dexie.ignoreTransaction(() => tillVault.transaction("rw", tillVault.tills, tillVault.counters, async () => {
    // a retry of the SAME signed request (same enrollment, rpc and marker) reuses its counter; after a re-enrollment the operation
    // gets a fresh counter of the new enrollment (review 2, L3)
    const existing = await tillVault.counters.get(opKey);
    if (existing && existing.scope === t.scope && existing.rpc === rpc && existing.enrollmentId === t.enrollment!.enrollmentId && existing.marker === marker) return existing.counter;
    const fresh = await tillVault.tills.get(t.scope);
    if (!fresh) throw new TrustUnavailable("This till's identity disappeared while signing. Nothing was sent.");
    const counter = fresh.nextCounter;
    await tillVault.tills.update(t.scope, { nextCounter: counter + 1 });
    await tillVault.counters.put({ opKey, scope: t.scope, counter, rpc, enrollmentId: t.enrollment!.enrollmentId, marker });
    return counter;
  }));
}

/** The x-orvix-device header for a ledger operation (key = its idempotency key, rpc = the operation). */
export async function signOperation(t: TillIdentity, opKey: string, rpc: string, offline?: { capabilityId: string; deviceSeq: number } | null): Promise<string> {
  const marker = offlineMarker(offline);
  const counter = await counterFor(t, opKey, rpc, marker);
  const sig = await rsaSignHex(t.signingKey, requestMessage(t.enrollment!.enrollmentId, t.orgId, t.shopId, opKey, rpc, counter, marker));
  return JSON.stringify({ v: 1, enrollmentId: t.enrollment!.enrollmentId, counter, sig });
}
/** The header for a NON-ledger device request (offline capability, surrender): a fresh request key travels in the header. */
export async function signRequest(t: TillIdentity, rpc: string): Promise<string> {
  const key = crypto.randomUUID();
  const counter = await counterFor(t, key, rpc, "online");
  const sig = await rsaSignHex(t.signingKey, requestMessage(t.enrollment!.enrollmentId, t.orgId, t.shopId, key, rpc, counter, "online"));
  return JSON.stringify({ v: 1, enrollmentId: t.enrollment!.enrollmentId, counter, sig, key });
}

/** The evidence-journal identity of a trusted till (ECDSA evidence key, bound through the owner-approved request). The
 *  Enrollment's `signature` carries the OWNER's RSA approval of the request that names this evidence key: verification of
 *  this chain is owner-side tooling (STEP5-DESIGN.md §1.1), not the Step 4 ECDSA authority path. */
export async function tillEvidenceIdentity(origin: string, orgId: string, shopId: string): Promise<DeviceIdentity> {
  const t = await trustedTill(origin, orgId, shopId, { online: false });
  const e = t.enrollment!;
  const enrollment: Enrollment = {
    body: { protocol: "orvix-device-enrollment-v1", enrollmentId: e.enrollmentId, orgId, shopId, deviceId: t.deviceId, keyId: await digest(t.evidencePublicKey),
      publicKey: t.evidencePublicKey, authorityKeyId: `owner-rsa:${e.ownerKey.keyId}`, notBefore: t.createdAt, notAfter: e.notAfter, revokedAt: null,
      replacesEnrollmentId: t.replacesEnrollmentId },
    signature: `owner-rsa-approval:${e.signature}`,
  };
  return { scope: t.scope, privateKey: t.evidenceKey, publicKey: t.evidencePublicKey, enrollment, createdAt: t.createdAt };
}

/** While the organization is restricted / reconciling: this till's SIGNED statement for the current incident — its local
 *  evidence journal head and how many operations it still holds that the server has not confirmed. Reconciliation needs one
 *  from every approved till (device_attestation_missing) and refuses a verified reopening while any till holds operations
 *  (device_operations_unsynced). The server verifies the RSA signature; it learns no operation contents from it. */
export async function attestTill(origin: string, orgId: string, shopId: string, incident: { incidentId: string; recoveryEpoch: number }): Promise<Record<string, unknown>> {
  const t = await trustedTill(origin, orgId, shopId, { online: true });
  const { localDb } = await import("../lib/localDb");
  const pendingOperations = await localDb.syncOutbox.filter((e) => e.kind === "rpc" && !e.serverOutcome).count();
  const { listDeviceEvidence } = await import("./journalCapture");
  const mine = (await listDeviceEvidence(orgId, shopId).catch(() => [])).filter((r) => r.envelope.body.deviceId === t.deviceId);
  const last = mine[mine.length - 1];
  const statement = JSON.stringify({ protocol: "orvix-device-attestation-v1", enrollmentId: t.enrollment!.enrollmentId, orgId, incidentId: incident.incidentId,
    recoveryEpoch: incident.recoveryEpoch, journalSequence: last?.envelope.body.sequence ?? 0, journalHead: last?.envelope.hash ?? null, pendingOperations,
    attestedAt: new Date().toISOString() });
  return call("device.attest", { statement, signature: await rsaSignHex(t.signingKey, statement) });
}

/** Tests only. */
export async function resetTillVaultForTests(): Promise<void> { await tillVault.tills.clear(); await tillVault.counters.clear(); }
