// Recovery Script 2 -- offline-first adversarial tests (till side, end to end through the sale slice and the outbox).
// New file; product code untouched. Same harness as offlineSelling.test.ts / offlineCompat.test.ts.
// "S.." tests assert the CORRECT behaviour; a failing one is a demonstrated defect.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/supabase", async () => ({ supabase: (await import("../stores/data/testing/fakeSupabase")).fakeSupabase }));
vi.mock("../stores/authStore", async () => {
  const actual = await vi.importActual<typeof import("../stores/authStore")>("../stores/authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" }) } };
});
import { fakeSupabase as fake } from "../stores/data/testing/fakeSupabase";
import { localDb } from "../lib/localDb";
import { useAppStore } from "../stores/appStore";
import { createSaleSlice } from "../stores/data/slices/saleSlice";
import { drainOutbox, OWNER_REVIEW, registerOutboxReconciler, simulateNewAppInstanceForTests } from "../stores/data/outbox";
import { resetWriteAheadForTests } from "../stores/data/writeAhead";
import { setExecutorCapabilityForTests } from "../stores/data/idempotentRpc";
import { registerVerifiedReload } from "../stores/data/verifiedReload";
import { resetRecoveryStateForTests } from "../stores/data/recoveryState";
import { resetRecoveryGateForTests } from "../stores/data/recoveryGate";
import { configureIndependentTrust } from "./trust";
import { deviceVault } from "./deviceVault";
import { refreshRecoveryV1, resetRecoveryV1ForTests } from "./client";
import { syntheticRecoveryFixture } from "./testing";
import { maintainOfflineCapability, offlineDeviceId, OFFLINE_HEADER, resetOfflineCapabilityForTests } from "./offlineCapability";

type Status = "ACTIVE" | "RESTRICTED" | "absent" | "down" | "jwt-expired";
let plan: Status[] = ["ACTIVE"];
let statusCalls = 0;
const statusReply = (s: Status) =>
  s === "absent" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.recovery_v1_status(p_org_id) in the schema cache" }, status: 404 }
  : s === "down" ? { data: null, error: { code: "", message: "TypeError: Failed to fetch" }, status: 0 }
  : s === "jwt-expired" ? { data: null, error: { code: "PGRST301", message: "JWT expired" }, status: 401 }
  : { data: { protocol: "orvix-recovery-v1", org_id: "org-1", state: s, recovered_as_of: null, uncertainties: [], required_evidence: true }, error: null, status: 200 };
let capReply: () => unknown = () => null;

async function boot(trusted: boolean) {
  vi.restoreAllMocks(); fake.reset(); fake.enableExecutor(); setExecutorCapabilityForTests("available");
  simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetRecoveryStateForTests(); resetRecoveryGateForTests(); resetRecoveryV1ForTests();
  resetOfflineCapabilityForTests();
  await Promise.all(localDb.tables.map((t) => t.clear())); await deviceVault.identities.clear();
  statusCalls = 0;
  useAppStore.setState({ currentShopId: "shop-1" });
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  vi.stubGlobal("navigator", { onLine: true }); registerVerifiedReload(async () => true);
  if (trusted) { const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source); } else configureIndependentTrust(null);
  const real = fake.rpc;
  vi.spyOn(fake, "rpc").mockImplementation((name, args = {}) => {
    let r: unknown = null;
    if (name === "recovery_v1_status") { const s = plan[Math.min(statusCalls, plan.length - 1)]; statusCalls++; r = statusReply(s); }
    else if (name === "recovery_v1_offline_capability") { fake.calls.push({ name, args, mode: "succeed", replayed: false }); r = capReply(); }
    else return real(name, args);
    const promise = Promise.resolve(r);
    const builder = { abortSignal: () => builder, then: promise.then.bind(promise) };
    return builder as ReturnType<typeof real>;
  });
}
afterEach(() => { configureIndependentTrust(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function saleStore() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (value: any) => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; };
  const get = () => state;
  const slice = createSaleSlice(set as never, get as never, {} as never);
  state = { productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }], products: [{ id: "p1", isNonStock: false }],
    getProductPrice: () => 0, getInventoryQty: () => 10, shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }], ...slice };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return get;
}
const sale = () => ({ shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 2000,
  cartItems: [{ id: "c1", productId: "p1", productUnitId: "u1", name: "Tea", unitName: "Can", qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "retail" }] });
const ringUp = async (get = saleStore()) => {
  try { await get().createSale(sale()); } catch (error) { if (!/Pending confirmation/.test(String(error))) throw error; }
  return get;
};
const queued = async () => (await localDb.syncOutbox.toArray()).filter((r) => r.kind === "rpc" && r.name === "complete_sale");
const sends = () => [...fake.callsFor("op_execute"), ...fake.callsFor("complete_sale")]
  .filter((c) => c.name === "complete_sale" || c.args.p_rpc === "complete_sale");
const keyOf = (c: { args: Record<string, unknown> }) => (c.args.p_key ?? c.args.p_idempotency_key) as string;
const headerOf = (c: { headers?: Record<string, string> }) => JSON.parse(c.headers?.[OFFLINE_HEADER] ?? "null");
const retryNow = () => localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });

async function activeWithCapability(over: Record<string, unknown> = {}) {
  await refreshRecoveryV1("org-1", { force: true });
  const deviceId = await offlineDeviceId();
  const now = Date.now();
  capReply = () => ({ data: { outcome: "issued", serverTime: new Date(now).toISOString(), capability: {
    protocol: "orvix-offline-capability-v1", id: "cap-1", orgId: "org-1", shopId: "shop-1", deviceId, userId: "user-1", offlineEpoch: 0,
    policyScope: "*", policyStatus: "OWNER_APPROVED", issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600_000).toISOString(),
    syncDeadline: new Date(now + 25 * 3600_000).toISOString(), maxOps: 3, maxAmountMmk: 20_000, allowedOps: ["complete_sale"], ...over } }, error: null, status: 200 });
  await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
}
/** A V1 till that recorded one sale offline under cap-1 (the server unreachable). */
async function oneOfflineSale() {
  plan = ["ACTIVE"]; await activeWithCapability();
  plan = ["down"]; fake.setDefaultMode("network-error");
  const get = await ringUp();
  const [row] = await queued();
  expect(row.offlineAuth).toEqual({ capabilityId: "cap-1", deviceSeq: 1 });
  return { get, row };
}

describe("Script 2 / legacy 085 server compatibility", () => {
  beforeEach(async () => { await boot(false); plan = ["absent"]; });

  it("S01 no V1 ever detected: offline sale queued exactly as before -- no capability asked, no offline reference, no x-orvix-offline header on sync", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await ringUp();
    const [row] = await queued();
    expect(row).toBeTruthy();
    expect(row.offlineAuth ?? null).toBeNull();
    expect(fake.calls.filter((c) => c.name === "recovery_v1_offline_capability")).toHaveLength(0);
    vi.stubGlobal("navigator", { onLine: true }); fake.setDefaultMode("succeed");
    await retryNow();
    expect(await drainOutbox()).toBe("drained");
    expect(sends().map(keyOf)).toEqual([row.idempotencyKey]);
    expect(sends().every((c) => !c.headers?.[OFFLINE_HEADER])).toBe(true);
    expect(fake.server.sales).toHaveLength(1);
  });
});

describe("Script 2 / V1 till: queued offline sales", () => {
  beforeEach(async () => { await boot(true); plan = ["ACTIVE"]; });

  it("S02 a pending offline sale is never shown as server-confirmed (pendingSync, placeholder receipt) -- also after the server HOLDS it", async () => {
    const { get } = await oneOfflineSale();
    const local = get().sales[0];
    expect(local).toMatchObject({ pendingSync: true, receiptNo: "PENDING" });
    expect((await localDb.sales.toArray()).every((s) => s.pendingSync === true)).toBe(true);
    plan = ["ACTIVE"]; fake.setDefaultMode("succeed");
    fake.queueReply({ data: null, status: 503, error: { code: "PT503", message: "ORG_SUSPENDED: recovery evidence unresolved [offline_exposure_amount]", details: null, hint: null } });
    await retryNow(); await drainOutbox();
    const [held] = await queued();
    expect(held.heldReason).toBe(OWNER_REVIEW);
    expect(get().sales[0]).toMatchObject({ pendingSync: true, receiptNo: "PENDING" });
    expect((await localDb.sales.toArray()).every((s) => s.pendingSync === true && s.receiptNo === "PENDING")).toBe(true);
  });

  it("S03 sign-in refresh REFUSED while syncing an offline sale: kept pending with the same key and offline reference, not held, nothing sent; drains once after sign-in with the header", async () => {
    const { row } = await oneOfflineSale();
    plan = ["ACTIVE", "jwt-expired"]; statusCalls = 0; fake.setAuth("valid", "invalid"); fake.setDefaultMode("succeed");
    await retryNow(); await drainOutbox();
    const [after] = await queued();
    expect(after).toMatchObject({ idempotencyKey: row.idempotencyKey, offlineAuth: row.offlineAuth, status: "pending" });
    expect(after.heldReason).not.toBe(OWNER_REVIEW);
    expect(sends()).toHaveLength(0);
    plan = ["ACTIVE"]; fake.setAuth("valid", "ok");
    await retryNow();
    expect(await drainOutbox()).toBe("drained");
    expect(sends().map(keyOf)).toEqual([row.idempotencyKey]);
    expect(headerOf(sends()[0])).toEqual({ capabilityId: "cap-1", deviceSeq: 1 });
  });

  it("S04 sign-in refresh that cannot REACH the auth server (network) is a communication failure: queue kept, same identity", async () => {
    const { row } = await oneOfflineSale();
    plan = ["ACTIVE", "jwt-expired"]; statusCalls = 0; fake.setAuth("valid", "network"); fake.setDefaultMode("succeed");
    await retryNow(); await drainOutbox();
    const [after] = await queued();
    expect(after).toMatchObject({ idempotencyKey: row.idempotencyKey, offlineAuth: row.offlineAuth });
    expect(after.heldReason).not.toBe(OWNER_REVIEW);
    expect(sends()).toHaveLength(0);
  });

  it("S05 interrupted drain (commit, reply lost, app restarts): no duplicate sale, every send uses the same key and the same offline header", async () => {
    const { get, row } = await oneOfflineSale();
    plan = ["ACTIVE"]; fake.setDefaultMode("succeed"); fake.queueModes("commit-then-timeout");
    await retryNow(); await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);                     // committed on the server
    const [mid] = await queued();
    // unknown outcome: still in the queue, never confirmed locally
    expect(mid).toBeTruthy();
    expect(mid.idempotencyKey).toBe(row.idempotencyKey);
    expect(get().sales[0]).toMatchObject({ pendingSync: true });
    // crash + restart
    simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetRecoveryV1ForTests(); resetRecoveryGateForTests(); resetOfflineCapabilityForTests();
    plan = ["ACTIVE"]; statusCalls = 0;
    await retryNow(); await drainOutbox();
    await retryNow(); await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);                     // never a second sale
    expect(sends().length + fake.callsFor("op_status").length).toBeGreaterThan(1);   // the restart really asked / resent
    expect(new Set(sends().map(keyOf))).toEqual(new Set([row.idempotencyKey]));
    for (const c of sends()) expect(headerOf(c)).toEqual({ capabilityId: "cap-1", deviceSeq: 1 });
    expect(await queued()).toHaveLength(0);                        // resolved through the server's ledger, not guessed
  });

  it("S06 operation identities (idempotency key, capability id, deviceSeq) are unchanged across restarts; the next sale continues the sequence", async () => {
    const { row } = await oneOfflineSale();
    simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetRecoveryV1ForTests(); resetRecoveryGateForTests(); resetOfflineCapabilityForTests();
    plan = ["down"]; fake.setDefaultMode("network-error");
    await ringUp();
    const rows = await queued();
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.localId === row.localId)!;
    expect(first).toMatchObject({ idempotencyKey: row.idempotencyKey, offlineAuth: row.offlineAuth, args: row.args });
    const second = rows.find((r) => r.localId !== row.localId)!;
    expect(second.offlineAuth).toEqual({ capabilityId: "cap-1", deviceSeq: 2 });
    expect(second.idempotencyKey).not.toBe(row.idempotencyKey);
  });

  it("S07 nothing is silently deleted: through network loss, 5xx, sign-in refusal and offline holds every queued sale stays, same key", async () => {
    await oneOfflineSale();
    await ringUp(); await ringUp();                                // 3 sales under a 3-op capability
    const before = (await queued()).map((r) => r.idempotencyKey).sort();
    expect(before).toHaveLength(3);
    for (const step of ["network-error", "gateway-502", "server-500"] as const) {
      plan = ["ACTIVE"]; statusCalls = 0; fake.setDefaultMode(step);
      await retryNow(); await drainOutbox();
      expect((await queued()).map((r) => r.idempotencyKey).sort()).toEqual(before);
    }
    plan = ["ACTIVE", "jwt-expired"]; statusCalls = 0; fake.setAuth("valid", "invalid"); fake.setDefaultMode("succeed");
    await retryNow(); await drainOutbox();
    expect((await queued()).map((r) => r.idempotencyKey).sort()).toEqual(before);
    plan = ["ACTIVE"]; fake.setAuth("valid", "ok");
    for (const code of ["offline_capability_stale_epoch", "offline_device_revoked", "offline_capability_sync_deadline"]) {
      fake.queueReply({ data: null, status: 503, error: { code: "PT503", message: `ORG_SUSPENDED: recovery evidence unresolved [${code}]`, details: null, hint: null } });
    }
    await retryNow(); await drainOutbox();
    const after = await queued();
    expect(after.map((r) => r.idempotencyKey).sort()).toEqual(before);
    expect(after.every((r) => r.heldReason === OWNER_REVIEW && r.offlineAuth?.capabilityId === "cap-1")).toBe(true);
    expect(fake.server.sales).toHaveLength(0);
  });

  it("S08 a held offline sale is never resent automatically and never re-sent WITHOUT its header", async () => {
    await oneOfflineSale();
    plan = ["ACTIVE"]; fake.setDefaultMode("succeed");
    fake.queueReply({ data: null, status: 503, error: { code: "PT503", message: "ORG_SUSPENDED: recovery evidence unresolved [offline_exposure_ops]", details: null, hint: null } });
    await retryNow(); await drainOutbox();
    const n = sends().length;
    for (let i = 0; i < 3; i++) { await retryNow(); await drainOutbox(); }
    expect(sends().length).toBe(n);
    expect(sends().every((c) => headerOf(c)?.capabilityId === "cap-1")).toBe(true);
  });
});
