// Recovery V1, Step 4 (Part B): bounded offline selling for an ACTIVE organization.
//
// The server issues a capability (recovery_v1_offline_capability) while this till is connected and the organization is
// ACTIVE. It binds one organization, shop, device and cashier, an offline epoch, an expiry and a count / value limit.
// While disconnected the till may record ELIGIBLE operations (sales) under it; each one carries the capability id and a
// device sequence number to the server when it syncs (request header x-orvix-offline).
//
// The SERVER is the verifier: at sync it re-checks the stored capability (MAC), the device, the organization's current
// state and offline epoch, and the cumulative count and value. A recovery event while this till was offline (the
// organization left ACTIVE) changes the epoch: such operations are held for review, never accepted as verified.
// This module is the till's own, conservative enforcement: it never renews or extends a capability while disconnected,
// stops at the capability's expiry, its count and its value, and stops when it sees the clock run backwards.
// It cannot verify the issuer cryptographically (the server keeps the MAC key); a tampered local copy can only make this
// till record more local sales, which the server then holds for review — never accept.
import { localDb } from "../lib/localDb";
import { currentBackendOrigin } from "../lib/backendOrigin";
import { supabase } from "../lib/supabase";
import { runRequest } from "../stores/data/idempotentRpc";

export const OFFLINE_HEADER = "x-orvix-offline";
/** Operations a capability can authorize (the server's allowed_ops). */
export const OFFLINE_ELIGIBLE_OPS = new Set(["complete_sale"]);
/** Clock tolerance before a backwards jump counts as rollback. */
const CLOCK_ROLLBACK_TOLERANCE_MS = 2 * 60_000;
/** Ask for a fresh capability once this share of the lifetime has passed (only while connected). */
const REFRESH_AT_FRACTION = 0.5;

export interface OfflineCapability {
  protocol: "orvix-offline-capability-v1";
  id: string; orgId: string; shopId: string; deviceId: string; userId: string;
  offlineEpoch: number; policyScope: string; policyStatus: "OWNER_APPROVED" | "DEFAULT_UNAPPROVED";
  issuedAt: string; expiresAt: string; syncDeadline: string;
  maxOps: number; maxAmountMmk: number; allowedOps: string[];
}
interface Stored {
  capability: OfflineCapability;
  serverTime: string;
  receivedAt: string;
  usedOps: number;
  usedAmountMmk: number;
  nextSeq: number;
  withdrawn?: string;
  withdrawnAt?: string;
}
export interface OfflineAuth { capabilityId: string; deviceSeq: number }
export type OfflineState = "valid" | "missing" | "expired" | "exhausted" | "withdrawn" | "clock" | "other-user";
export interface OfflineView {
  state: OfflineState;
  expiresAt: string | null;
  remainingOps: number;
  remainingAmountMmk: number;
  policyStatus: OfflineCapability["policyStatus"] | null;
  reason: string;
}

export class OfflineAuthorizationUnavailable extends Error {
  readonly state: OfflineState;
  constructor(state: OfflineState, message: string) { super(message); this.name = "OfflineAuthorizationUnavailable"; this.state = state; }
}

const capKey = (origin: string, org: string, shop: string) => `rv1:offline-cap:${JSON.stringify([origin, org, shop])}`;
const deviceKey = (origin: string) => `rv1:device-id:${origin}`;
const clockKey = (origin: string) => `rv1:clock-hwm:${origin}`;

/** A stable random id for this till on this backend (never re-used across backends). */
export async function offlineDeviceId(origin = currentBackendOrigin()): Promise<string> {
  const row = await localDb.syncState.get(deviceKey(origin));
  if (row?.value && /^[A-Za-z0-9._:-]{8,128}$/.test(row.value)) return row.value;
  const id = `till-${crypto.randomUUID()}`;
  await localDb.syncState.put({ key: deviceKey(origin), value: id, updatedAt: new Date().toISOString() });
  return id;
}

async function read(origin: string, org: string, shop: string): Promise<Stored | null> {
  const row = await localDb.syncState.get(capKey(origin, org, shop));
  if (!row?.value) return null;
  try {
    const s = JSON.parse(row.value) as Stored;
    return s && s.capability && typeof s.capability.id === "string" ? s : null;
  } catch { return null; }
}
async function write(origin: string, org: string, shop: string, s: Stored): Promise<void> {
  await localDb.syncState.put({ key: capKey(origin, org, shop), value: JSON.stringify(s), updatedAt: new Date().toISOString() });
}

/** The highest wall-clock time this till has observed (persisted). A clock now earlier than it (beyond tolerance) means
 *  the clock was turned back: offline authority stops until the server is reached again. */
async function observeClock(origin: string, now = Date.now()): Promise<{ rolledBack: boolean; seen: number }> {
  const row = await localDb.syncState.get(clockKey(origin));
  const hwm = row?.value ? Number(row.value) : 0;
  if (Number.isFinite(hwm) && now < hwm - CLOCK_ROLLBACK_TOLERANCE_MS) return { rolledBack: true, seen: hwm };
  if (!Number.isFinite(hwm) || now > hwm) await localDb.syncState.put({ key: clockKey(origin), value: String(now), updatedAt: new Date(now).toISOString() });
  // the latest time this till has already seen: a clock set back within the tolerance never revives an expired capability
  return { rolledBack: false, seen: Number.isFinite(hwm) ? Math.max(hwm, now) : now };
}

/** The server's clock as this till best knows it: its own clock corrected by the offset seen when the capability was
 *  issued (a till running slow must not sell past the expiry). Never later than the till's own clock reading. */
const serverNow = (s: Stored, now: number): number => {
  const offset = Date.parse(s.serverTime) - Date.parse(s.receivedAt);
  return Number.isFinite(offset) ? Math.max(now, now + offset) : now;
};

function evaluate(s: Stored | null, userId: string | null, now: number, rolledBack: boolean, seen: number = now): OfflineView {
  if (!s) return { state: "missing", expiresAt: null, remainingOps: 0, remainingAmountMmk: 0, policyStatus: null, reason: "This till has no offline authorization yet (it is issued while connected)." };
  const c = s.capability;
  const base = { expiresAt: c.expiresAt, remainingOps: Math.max(0, c.maxOps - s.usedOps), remainingAmountMmk: Math.max(0, c.maxAmountMmk - s.usedAmountMmk), policyStatus: c.policyStatus };
  if (s.withdrawn) return { ...base, state: "withdrawn", reason: `Offline authorization was withdrawn: ${s.withdrawn}.` };
  if (rolledBack || now < Date.parse(s.serverTime) - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return { ...base, state: "clock", reason: "This till's clock is earlier than a time it already saw. Offline selling stops until the server is reached again." };
  }
  if (userId && c.userId !== userId) return { ...base, state: "other-user", reason: "The offline authorization on this till belongs to another cashier." };
  if (!(Math.max(serverNow(s, now), seen) < Date.parse(c.expiresAt))) return { ...base, state: "expired", reason: "Offline authorization has expired. Reconnect to continue selling." };
  if (base.remainingOps <= 0 || base.remainingAmountMmk <= 0) return { ...base, state: "exhausted", reason: "The offline sales limit for this period is used up. Reconnect to continue selling." };
  return { ...base, state: "valid", reason: "" };
}

/** What the till may do offline right now (for the banner and the gate). */
export async function offlineAuthorizationView(orgId: string, shopId: string, userId: string | null, origin = currentBackendOrigin()): Promise<OfflineView> {
  const { rolledBack, seen } = await observeClock(origin);
  return evaluate(await read(origin, orgId, shopId), userId, Date.now(), rolledBack, seen);
}

/** Reserve one offline operation under the current capability (persisted before anything is saved). */
export async function authorizeOfflineOperation(input: { orgId: string; shopId: string; userId: string | null; rpc: string; amountMmk: number },
  origin = currentBackendOrigin()): Promise<OfflineAuth> {
  if (!OFFLINE_ELIGIBLE_OPS.has(input.rpc)) {
    throw new OfflineAuthorizationUnavailable("missing", "This operation needs the server; only sales can be recorded offline.");
  }
  // ONE readwrite transaction: IndexedDB serialises overlapping readwrite transactions across windows and tabs, so two
  // windows can never take the same device sequence number or both spend the last unit of the limit.
  return localDb.transaction("rw", localDb.syncState, async () => {
    const { rolledBack, seen } = await observeClock(origin);
    const s = await read(origin, input.orgId, input.shopId);
    const view = evaluate(s, input.userId, Date.now(), rolledBack, seen);
    if (view.state !== "valid" || !s) throw new OfflineAuthorizationUnavailable(view.state, view.reason);
    const amount = Math.max(0, Math.round(input.amountMmk));
    if (s.usedAmountMmk + amount > s.capability.maxAmountMmk) {
      throw new OfflineAuthorizationUnavailable("exhausted", `This sale would exceed the offline limit (${view.remainingAmountMmk} MMK left). Reconnect to continue.`);
    }
    const auth: OfflineAuth = { capabilityId: s.capability.id, deviceSeq: s.nextSeq };
    await write(origin, input.orgId, input.shopId, { ...s, usedOps: s.usedOps + 1, usedAmountMmk: s.usedAmountMmk + amount, nextSeq: s.nextSeq + 1 });
    return auth;
  });
}

/** The server said the organization is not ACTIVE (or the device is revoked): stop using the local capability at once. */
let withdrawals = 0;
export async function withdrawOfflineCapability(orgId: string, shopId: string | null, reason: string, origin = currentBackendOrigin()): Promise<void> {
  withdrawals += 1;
  const rows = await localDb.syncState.where("key").startsWith("rv1:offline-cap:").toArray();
  for (const row of rows) {
    try {
      const [o, org, shop] = JSON.parse(row.key.slice("rv1:offline-cap:".length)) as [string, string, string];
      if (o !== origin || org !== orgId || (shopId && shop !== shopId)) continue;
      const s = JSON.parse(row.value ?? "null") as Stored | null;
      if (s && !s.withdrawn) await write(o, org, shop, { ...s, withdrawn: reason, withdrawnAt: new Date().toISOString() });
    } catch { /* an unreadable row authorizes nothing anyway */ }
  }
}

let lastAskAt = 0;
/** Tests only. */
export function resetOfflineCapabilityForTests(): void { lastAskAt = 0; }

/**
 * While connected: ask for a capability when there is none, it is withdrawn, or half its lifetime has passed. Never
 * called offline; a failed request changes nothing (the existing capability keeps its own expiry, never extended).
 */
export async function maintainOfflineCapability(orgId: string, shopId: string, userId: string | null,
  options: { origin?: string; force?: boolean } = {}): Promise<OfflineView> {
  const origin = options.origin ?? currentBackendOrigin();
  const current = await read(origin, orgId, shopId);
  const now = Date.now();
  const fresh = current && !current.withdrawn && current.capability.userId === userId
    && now < Date.parse(current.capability.issuedAt) + (Date.parse(current.capability.expiresAt) - Date.parse(current.capability.issuedAt)) * REFRESH_AT_FRACTION;
  if ((fresh && !options.force) || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return offlineAuthorizationView(orgId, shopId, userId, origin);
  }
  if (!options.force && now - lastAskAt < 30_000) return offlineAuthorizationView(orgId, shopId, userId, origin);
  lastAskAt = now;
  try {
    const deviceId = await offlineDeviceId(origin);
    const askedAt = Date.now();
    const withdrawalsBefore = withdrawals;
    const outcome = await runRequest(
      supabase.rpc("recovery_v1_offline_capability", { p_org_id: orgId, p_shop_id: shopId, p_device_id: deviceId }),
      "recovery_v1_offline_capability", 15_000);
    const { data, error } = outcome;
    if (error) return offlineAuthorizationView(orgId, shopId, userId, origin);
    const d = (data ?? {}) as { outcome?: string; reason?: string; capability?: OfflineCapability; serverTime?: string };
    if (d.outcome === "issued" && d.capability && d.capability.orgId === orgId && d.capability.shopId === shopId && d.capability.deviceId === deviceId
        && d.capability.userId === userId && typeof d.serverTime === "string") {
      const issued = d.capability; const serverTime = d.serverTime;
      await localDb.transaction("rw", localDb.syncState, async () => {
        // a withdrawal recorded while this request was in flight wins: a late reply never revives authority
        if (withdrawals !== withdrawalsBefore) return;
        const latest = await read(origin, orgId, shopId);
        if (latest?.withdrawn && Date.parse(latest.withdrawnAt ?? "") >= askedAt) return;
        // Script 2 (D3): the SAME capability delivered again (a replayed or duplicated reply) never resets its usage
        // or lifts a withdrawal — only a NEW capability id replaces the stored one
        if (latest && latest.capability.id === issued.id) return;
        await write(origin, orgId, shopId, { capability: issued, serverTime, receivedAt: new Date().toISOString(), usedOps: 0, usedAmountMmk: 0,
          nextSeq: Math.max(latest?.nextSeq ?? 1, current?.nextSeq ?? 1) });
        // the server's own clock re-anchors the rollback high-water mark (a forward jump of the till's clock is forgotten)
        // re-anchored to THIS till's clock now (review: anchoring to the server's time locked a till whose clock runs
        // more than the tolerance slow out of offline selling); a forward jump seen earlier is forgotten
        const anchored = Date.now();
        await localDb.syncState.put({ key: clockKey(origin), value: String(anchored), updatedAt: new Date().toISOString() });
      });
    } else if (d.outcome === "refused" && d.reason && ["organization_not_active", "device_revoked"].includes(d.reason)) {
      await withdrawOfflineCapability(orgId, shopId, d.reason === "device_revoked" ? "this till was revoked" : "the organization is not active", origin);
    }
  } catch { /* network: keep what we have, with its own expiry */ }
  return offlineAuthorizationView(orgId, shopId, userId, origin);
}
