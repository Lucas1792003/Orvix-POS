// Offline-selling compatibility of the Recovery V1 client (correction pass P0/P2).
// Legacy 085 servers (no recovery protocol) must keep the existing offline-first
// behaviour: a failed STATUS REQUEST is not a restriction. Once a server has been
// positively identified as recovery-aware, an unavailable status never authorizes
// a new operation, and a transient status failure keeps a queued operation pending
// with its original key (never a conflict, never a new key).
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/supabase", async () => ({ supabase: (await import("../stores/data/testing/fakeSupabase")).fakeSupabase }));
vi.mock("../stores/authStore", async () => {
  const actual = await vi.importActual<typeof import("../stores/authStore")>("../stores/authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" }) } };
});
import { fakeSupabase as fake } from "../stores/data/testing/fakeSupabase";
import { localDb } from "../lib/localDb";
import { currentBackendOrigin } from "../lib/backendOrigin";
import { useAppStore } from "../stores/appStore";
import { createSaleSlice } from "../stores/data/slices/saleSlice";
import { drainOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "../stores/data/outbox";
import { resetWriteAheadForTests } from "../stores/data/writeAhead";
import { setExecutorCapabilityForTests } from "../stores/data/idempotentRpc";
import { registerVerifiedReload } from "../stores/data/verifiedReload";
import { resetRecoveryStateForTests } from "../stores/data/recoveryState";
import { resetRecoveryGateForTests } from "../stores/data/recoveryGate";
import { configureIndependentTrust } from "./trust";
import { deviceVault } from "./deviceVault";
import { refreshRecoveryV1, requireRecoveryV1Write, resetRecoveryV1ForTests } from "./client";
import { syntheticRecoveryFixture } from "./testing";

type Status = "ACTIVE" | "RESTRICTED" | "absent" | "down" | "timeout" | "server-500";
/** Each recovery_v1_status call consumes the next planned answer; the last one repeats. */
let plan: Status[] = ["absent"];
let statusCalls = 0;
const statusReply = (s: Status) =>
  s === "absent" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.recovery_v1_status(p_org_id) in the schema cache" }, status: 404 }
  : s === "down" ? { data: null, error: { code: "", message: "TypeError: Failed to fetch" }, status: 0 }
  : s === "timeout" ? { data: null, error: { code: "", message: "AbortError: signal is aborted without reason" }, status: 0 }
  : s === "server-500" ? { data: null, error: { code: "", message: "Internal Server Error" }, status: 500 }
  : { data: { protocol: "orvix-recovery-v1", org_id: "org-1", state: s, recovered_as_of: null, uncertainties: ["synthetic"], required_evidence: true }, error: null, status: 200 };

beforeEach(async () => {
  vi.restoreAllMocks(); fake.reset(); fake.enableExecutor(); setExecutorCapabilityForTests("available");
  simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetRecoveryStateForTests(); resetRecoveryGateForTests(); resetRecoveryV1ForTests();
  await Promise.all(localDb.tables.map((t) => t.clear())); await deviceVault.identities.clear();
  configureIndependentTrust(null); plan = ["absent"]; statusCalls = 0;
  useAppStore.setState({ currentShopId: "shop-1" });
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  vi.stubGlobal("navigator", { onLine: true }); registerVerifiedReload(async () => true);
  const real = fake.rpc;
  vi.spyOn(fake, "rpc").mockImplementation((name, args = {}) => {
    if (name !== "recovery_v1_status") return real(name, args);
    const s = plan[Math.min(statusCalls, plan.length - 1)]; statusCalls++;
    const promise = Promise.resolve(statusReply(s));
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
const sale = () => ({ shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: 5000,
  cartItems: [{ id: "c1", productId: "p1", productUnitId: "u1", name: "Tea", unitName: "Can", qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "retail" }] });
/** An undelivered sale is saved and the cashier is told it is pending confirmation
 *  (existing behaviour); it must never be refused with "Not saved". */
const ringUp = async () => {
  try { await saleStore()().createSale(sale()); } catch (error) {
    if (!/Pending confirmation/.test(String(error))) throw error;
  }
};
const queuedSales = async () => (await localDb.syncOutbox.toArray()).filter((r) => r.kind === "rpc" && r.name === "complete_sale");
/** Every financial send (direct RPC or through the 086 executor) and its key. */
const sentKeys = () => [
  ...fake.callsFor("complete_sale").map((c) => c.args.p_idempotency_key),
  ...fake.callsFor("op_execute").filter((c) => c.args.p_rpc === "complete_sale").map((c) => c.args.p_key),
];
const v1Required = async () => Boolean(await localDb.syncState.get(`rv1:protocol:${currentBackendOrigin()}`));

describe("legacy 085 server (no recovery protocol ever detected)", () => {
  for (const [label, failure, mode] of [
    ["Tailscale/upstream down while the OS reports online", "down", "network-error"],
    ["status request timed out", "timeout", "gateway-502"],
    ["status endpoint returned 500", "server-500", "network-error"],
  ] as const) {
    it(`${label}: the sale is SAVED and queued with its key, then drains once on reconnect`, async () => {
      plan = [failure]; fake.setDefaultMode(mode);
      await ringUp();
      const queued = await queuedSales();
      expect(queued).toHaveLength(1);
      expect(queued[0].status).not.toBe("conflict");
      expect(fake.server.sales).toHaveLength(0);
      expect(await v1Required()).toBe(false);          // a failed request never marks the server as recovery-aware
      const key = queued[0].idempotencyKey;
      // reconnect: the server answers "no recovery protocol"; the original operation is sent once, same key
      plan = ["absent"]; fake.setDefaultMode("succeed");
      const sentBefore = sentKeys().length;
      await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
      expect(await drainOutbox()).toBe("drained");
      expect(fake.server.sales).toHaveLength(1);
      expect(fake.server.idempotency.has(key)).toBe(true);
      // only ever the original key, and the reconnect drain sent it exactly once
      expect(new Set(sentKeys())).toEqual(new Set([key]));
      const sentAfterReconnect = sentKeys().slice(sentBefore);
      expect(sentAfterReconnect).toEqual([key]);
    });
  }
  it("navigator offline: queued exactly as before (no status request at all)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await ringUp();
    expect(await queuedSales()).toHaveLength(1);
    expect(statusCalls).toBe(0);
  });
  it("an explicit 'no protocol' answer keeps legacy rules and is cached briefly", async () => {
    plan = ["absent"];
    expect(await requireRecoveryV1Write("org-1", "shop-1")).toBe(false);
    expect(await requireRecoveryV1Write("org-1", "shop-1")).toBe(false);
    expect(statusCalls).toBe(1);
  });
  it("a failed request is NOT persisted as 'absent': not re-asked for 30 s (no stall per sale), then asked again", async () => {
    plan = ["down", "absent"];
    expect(await requireRecoveryV1Write("org-1", "shop-1")).toBe(false);
    expect(await requireRecoveryV1Write("org-1", "shop-1")).toBe(false);
    expect(statusCalls).toBe(1);
    const marker = await localDb.syncState.get(`rv1:status:${JSON.stringify([currentBackendOrigin(), "org-1"])}`);
    expect(marker).toBeUndefined();                    // nothing durable recorded from a failure
    resetRecoveryV1ForTests();                         // the in-memory window has passed (or the app restarted)
    expect(await requireRecoveryV1Write("org-1", "shop-1")).toBe(false);
    expect(statusCalls).toBe(2);
  });
});

describe("recovery-aware server (protocol positively detected)", () => {
  it("unavailable / timed-out / 500 / downgraded status never authorizes a NEW operation; nothing is saved", async () => {
    plan = ["RESTRICTED"]; await refreshRecoveryV1("org-1", { force: true });
    expect(await v1Required()).toBe(true);
    for (const s of ["down", "timeout", "server-500", "absent"] as const) {
      plan = [s]; statusCalls = 0;
      await expect(saleStore()().createSale(sale())).rejects.toThrow(/Recovery/);
    }
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(fake.server.sales).toHaveLength(0);
    expect(await v1Required()).toBe(true);           // never downgraded by a failure or a missing function
  });
  it("starting from a cached ACTIVE answer, a failed / timed-out / 500 / missing status still refuses a NEW sale; nothing saved or sent", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    for (const s of ["down", "timeout", "server-500", "absent"] as const) {
      plan = [s];
      await expect(saleStore()().createSale(sale())).rejects.toThrow(/Recovery/);
    }
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(sentKeys()).toEqual([]);
    expect(fake.server.sales).toHaveLength(0);
  });
  it("offline after detection: new financial operations stay blocked (V1 has no authorized offline policy)", async () => {
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    vi.stubGlobal("navigator", { onLine: false });
    await expect(requireRecoveryV1Write("org-1", "shop-1")).rejects.toThrow(/offline/);
  });
  /** A sale rung up offline while the server was still legacy (never sent, not in doubt);
   *  the server is then upgraded and positively detected as recovery-aware and ACTIVE. */
  async function neverSentSaleThenUpgraded() {
    vi.stubGlobal("navigator", { onLine: false }); plan = ["absent"];
    await ringUp();
    const [queued] = await queuedSales();
    expect(queued?.inDoubt ?? false).toBe(false);
    vi.stubGlobal("navigator", { onLine: true });
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    expect(await v1Required()).toBe(true);
    return queued;
  }
  it("a transient status failure at the send boundary keeps the queued sale PENDING with its original key (not a conflict); it drains once when status returns", async () => {
    const queued = await neverSentSaleThenUpgraded();
    // drain: the pass-level check succeeds, the per-attempt check hits a network failure
    plan = ["ACTIVE", "down"]; statusCalls = 0;
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    expect(statusCalls).toBeGreaterThanOrEqual(2);           // the per-attempt boundary was really reached
    const [after] = await queuedSales();
    expect(after.status).toBe("pending");
    expect(after.idempotencyKey).toBe(queued.idempotencyKey);
    expect(after.heldReason).toBe("recovery");
    expect(sentKeys()).toEqual([]);                          // nothing was sent
    expect(fake.server.sales).toHaveLength(0);
    // status back: exactly one sale, same key
    plan = ["ACTIVE"]; statusCalls = 0;
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
    expect(sentKeys()).toEqual([queued.idempotencyKey]);
  });
  it("a verified RESTRICTED answer at the send boundary is a hold (pending, same key), never a conflict and never sent", async () => {
    const queued = await neverSentSaleThenUpgraded();
    plan = ["ACTIVE", "RESTRICTED"]; statusCalls = 0;
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    const [after] = await queuedSales();
    expect(after.status).toBe("pending");
    expect(after.idempotencyKey).toBe(queued.idempotencyKey);
    expect(sentKeys()).toEqual([]);
    expect(fake.server.sales).toHaveLength(0);
  });
});
