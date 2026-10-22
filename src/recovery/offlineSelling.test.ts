// Step 4 (Part B) end to end on the till: a recovery-aware server, ACTIVE, issued an offline capability while it was
// reachable. When it becomes unreachable (network loss, Tailscale interruption, timeout, the device offline) a SALE may
// be recorded locally under that capability — as a local record, never as a server-accepted sale. It is queued with
// its key and the capability reference, never deleted, and synced with the x-orvix-offline header; a server refusal
// (stale epoch, revoked device, exposure, …) holds it for review. Anything else (or no capability) stays refused.
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
import { loadRecoveryState, recoveryView, resetRecoveryStateForTests, storeTillCredential } from "../stores/data/recoveryState";
import { refreshRecoveryEpoch } from "../stores/data/recovery87";
import { resetRecoveryGateForTests } from "../stores/data/recoveryGate";
import { configureIndependentTrust } from "./trust";
import { deviceVault } from "./deviceVault";
import { refreshRecoveryV1, resetRecoveryV1ForTests } from "./client";
import { syntheticRecoveryFixture } from "./testing";
import { maintainOfflineCapability, offlineDeviceId, OFFLINE_HEADER, resetOfflineCapabilityForTests } from "./offlineCapability";

type Status = "ACTIVE" | "RESTRICTED" | "down" | "timeout";
let plan: Status[] = ["ACTIVE"];
let statusCalls = 0;
const statusReply = (s: Status) =>
  s === "down" ? { data: null, error: { code: "", message: "TypeError: Failed to fetch" }, status: 0 }
  : s === "timeout" ? { data: null, error: { code: "", message: "AbortError: signal is aborted without reason" }, status: 0 }
  : { data: { protocol: "orvix-recovery-v1", org_id: "org-1", state: s, recovered_as_of: null, uncertainties: [], required_evidence: true }, error: null, status: 200 };
let capReply: () => unknown = () => null;

beforeEach(async () => {
  vi.restoreAllMocks(); fake.reset(); fake.enableExecutor(); setExecutorCapabilityForTests("available");
  simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetRecoveryStateForTests(); resetRecoveryGateForTests(); resetRecoveryV1ForTests();
  resetOfflineCapabilityForTests();
  await Promise.all(localDb.tables.map((t) => t.clear())); await deviceVault.identities.clear();
  plan = ["ACTIVE"]; statusCalls = 0;
  useAppStore.setState({ currentShopId: "shop-1" });
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  vi.stubGlobal("navigator", { onLine: true }); registerVerifiedReload(async () => true);
  const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
  const real = fake.rpc;
  vi.spyOn(fake, "rpc").mockImplementation((name, args = {}) => {
    let r: unknown = null;
    if (name === "recovery_v1_status") { const s = plan[Math.min(statusCalls, plan.length - 1)]; statusCalls++; r = statusReply(s); }
    else if (name === "recovery_v1_offline_capability") r = capReply();
    else return real(name, args);
    const promise = Promise.resolve(r);
    const builder = { abortSignal: () => builder, then: promise.then.bind(promise) };
    return builder as ReturnType<typeof real>;
  });
});
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
  try { return await get().createSale(sale()); } catch (error) { if (!/Pending confirmation/.test(String(error))) throw error; return null; }
};
const queued = async () => (await localDb.syncOutbox.toArray()).filter((r) => r.kind === "rpc" && r.name === "complete_sale");
const sentSales = () => fake.callsFor("op_execute").filter((c) => c.args.p_rpc === "complete_sale");

async function activeWithCapability(over: Record<string, unknown> = {}) {
  await refreshRecoveryV1("org-1", { force: true });
  const deviceId = await offlineDeviceId();
  const now = Date.now();
  capReply = () => ({ data: { outcome: "issued", serverTime: new Date(now).toISOString(), capability: {
    protocol: "orvix-offline-capability-v1", id: "cap-1", orgId: "org-1", shopId: "shop-1", deviceId, userId: "user-1", offlineEpoch: 0,
    policyScope: "*", policyStatus: "DEFAULT_UNAPPROVED", issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 7200_000).toISOString(),
    syncDeadline: new Date(now + 9 * 86400_000).toISOString(), maxOps: 2, maxAmountMmk: 100_000, allowedOps: ["complete_sale"], ...over } }, error: null, status: 200 });
  await maintainOfflineCapability("org-1", "shop-1", "user-1", { force: true });
}

describe("offline selling under a server-issued capability", () => {
  for (const [label, failure, offline] of [
    ["Tailscale / upstream down while the OS reports online", "down", false],
    ["status request timed out", "timeout", false],
    ["the device is offline", "down", true],
  ] as const) {
    it(`${label}: the sale is recorded LOCALLY with its capability reference and queued, never sent`, async () => {
      await activeWithCapability();
      plan = [failure]; if (offline) vi.stubGlobal("navigator", { onLine: false });
      fake.setDefaultMode("network-error");
      await ringUp();
      const [row] = await queued();
      expect(row).toBeTruthy();
      expect(row.offlineAuth).toEqual({ capabilityId: "cap-1", deviceSeq: 1 });
      expect(fake.server.sales).toHaveLength(0);                // local record only, not a server sale
    });
  }

  it("exhausted capability: the next sale is refused and nothing is saved", async () => {
    await activeWithCapability({ maxOps: 1 });
    plan = ["down"]; fake.setDefaultMode("network-error");
    await ringUp();
    await expect(saleStore()().createSale(sale())).rejects.toThrow(/limit|Reconnect/);
    expect(await queued()).toHaveLength(1);
  });

  it("no capability (never issued): offline after detection stays refused, nothing saved", async () => {
    await refreshRecoveryV1("org-1", { force: true });
    plan = ["down"];
    await expect(saleStore()().createSale(sale())).rejects.toThrow(/Recovery/);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("reconnect: the queued sale is sent once, with its original key and the x-orvix-offline header; restart in between changes nothing", async () => {
    await activeWithCapability();
    plan = ["down"]; fake.setDefaultMode("network-error");
    await ringUp();
    const [row] = await queued();
    // the app restarts while offline: the queued sale is still there, unchanged
    simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetRecoveryV1ForTests();
    expect((await queued())[0]).toMatchObject({ idempotencyKey: row.idempotencyKey, offlineAuth: row.offlineAuth });
    plan = ["ACTIVE"]; fake.setDefaultMode("succeed");
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    const sent = sentSales();
    expect(sent.map((c) => c.args.p_key)).toEqual([row.idempotencyKey]);
    expect(JSON.parse(sent[0].headers?.[OFFLINE_HEADER] ?? "null")).toEqual({ capabilityId: "cap-1", deviceSeq: 1 });
    expect(fake.server.sales).toHaveLength(1);
    // a duplicate resend (same key) creates nothing new
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);
  });

  it("the server refuses the offline operation (stale epoch / revoked / exposure): it is HELD, never deleted, never re-keyed", async () => {
    await activeWithCapability();
    plan = ["down"]; fake.setDefaultMode("network-error");
    await ringUp();
    const [row] = await queued();
    plan = ["ACTIVE"]; fake.setDefaultMode("succeed");
    for (const code of ["offline_capability_stale_epoch", "offline_device_revoked", "offline_exposure_amount", "offline_capability_integrity", "offline_device_sequence_reused"]) {
      // exactly what recovery_v1.deny raises
      fake.queueReply({ data: null, status: 503, error: { code: "PT503", message: `ORG_SUSPENDED: recovery evidence unresolved [${code}]`, details: null, hint: null } });
      await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined, heldReason: undefined });
      await drainOutbox();
      const after = await queued();
      expect(after).toHaveLength(1);
      expect(after[0].idempotencyKey).toBe(row.idempotencyKey);
      expect(after[0].offlineAuth).toEqual(row.offlineAuth);
      expect(after[0].heldReason).toBe(OWNER_REVIEW);               // listed for an owner, not an endless "suspended" retry
      expect(after[0].lastError).toContain(code);
      // not resent automatically
      const sentBefore = sentSales().length;
      await drainOutbox();
      expect(sentSales().length).toBe(sentBefore);
    }
    expect(fake.server.sales).toHaveLength(0);
  });

  it("restriction while offline: when the server is reached again and reports RESTRICTED, the capability is withdrawn and nothing is sent", async () => {
    await activeWithCapability();
    plan = ["down"]; fake.setDefaultMode("network-error");
    await ringUp();
    plan = ["RESTRICTED"]; fake.setDefaultMode("succeed");
    await refreshRecoveryV1("org-1", { force: true });
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    expect(sentSales()).toHaveLength(0);
    expect(await queued()).toHaveLength(1);                     // kept, with its key
    plan = ["down"];
    await expect(saleStore()().createSale(sale())).rejects.toThrow(/withdrawn|Recovery/);
  });

  it("on an 087 server (as every V1 server is): recorded locally under the capability despite the v87.x offline rule, then sent through op_execute_v87 with its epoch and the header", async () => {
    fake.enable087(); fake.setCaller("user-1", false, "org-1");
    resetRecoveryStateForTests(null); resetRecoveryGateForTests(); await loadRecoveryState("org-1");
    const secret = fake.register87Till(recoveryView().tillId, { reconciled: true });
    await storeTillCredential({ orgId: "org-1", secret });
    expect((await refreshRecoveryEpoch({ shopId: "shop-1" })).kind).toBe("issued");
    await activeWithCapability();
    plan = ["down"]; fake.setDefaultMode("network-error");
    await ringUp();
    const [row] = await queued();
    expect(row.offlineAuth).toEqual({ capabilityId: "cap-1", deviceSeq: 1 });
    expect(row.opEpoch).toBeTruthy();
    // without a capability the same situation stays refused (the v87.x rule is unchanged for everything else)
    const { withdrawOfflineCapability } = await import("./offlineCapability");
    await withdrawOfflineCapability("org-1", "shop-1", "test");
    await expect(saleStore()().createSale(sale())).rejects.toThrow();
    expect(await queued()).toHaveLength(1);
    plan = ["ACTIVE"]; fake.setDefaultMode("succeed");
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    const sent = fake.callsFor("op_execute_v87").filter((c) => c.args.p_rpc === "complete_sale");
    expect(sent.map((c) => c.args.p_key)).toEqual([row.idempotencyKey]);
    expect(JSON.parse(sent[0].headers?.[OFFLINE_HEADER] ?? "null")).toEqual({ capabilityId: "cap-1", deviceSeq: 1 });
  });
});
