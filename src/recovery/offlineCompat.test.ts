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
import { OWNER_REVIEW, drainOutbox, readNeedsReauth, registerOutboxReconciler, simulateNewAppInstanceForTests } from "../stores/data/outbox";
import { resetWriteAheadForTests } from "../stores/data/writeAhead";
import { setExecutorCapabilityForTests } from "../stores/data/idempotentRpc";
import { registerVerifiedReload } from "../stores/data/verifiedReload";
import { resetRecoveryStateForTests } from "../stores/data/recoveryState";
import { resetRecoveryGateForTests } from "../stores/data/recoveryGate";
import { configureIndependentTrust } from "./trust";
import { deviceVault } from "./deviceVault";
import { RecoveryV1Blocked, isAuthorizationFailure, refreshRecoveryV1, requireRecoveryV1Write, resetRecoveryV1ForTests } from "./client";
import { syntheticRecoveryFixture } from "./testing";

type Status = "ACTIVE" | "RESTRICTED" | "absent" | "down" | "timeout" | "server-500" | "jwt-expired" | "caller-required" | "malformed";
/** Each recovery_v1_status call consumes the next planned answer; the last one repeats. */
let plan: Status[] = ["absent"];
let statusCalls = 0;
const statusReply = (s: Status) =>
  s === "absent" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.recovery_v1_status(p_org_id) in the schema cache" }, status: 404 }
  : s === "down" ? { data: null, error: { code: "", message: "TypeError: Failed to fetch" }, status: 0 }
  : s === "timeout" ? { data: null, error: { code: "", message: "AbortError: signal is aborted without reason" }, status: 0 }
  : s === "server-500" ? { data: null, error: { code: "", message: "Internal Server Error" }, status: 500 }
  : s === "jwt-expired" ? { data: null, error: { code: "PGRST301", message: "JWT expired" }, status: 401 }
  : s === "malformed" ? { data: { protocol: "orvix-recovery-v1", org_id: "org-1", state: "OPEN" }, error: null, status: 200 }
  : s === "caller-required" ? { data: null, error: { code: "42501", message: "RECOVERY_V1_CALLER_REQUIRED" }, status: 403 }
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

/** Final migration integration: authorization expiry is not a network failure. */
describe("authorization expiry vs network failure", () => {
  const blockOf = async (p: Promise<unknown>) => {
    try { await p; } catch (error) { return error; }
    throw new Error("expected a RecoveryV1Blocked");
  };
  it("classifies only server answers that refuse the session as authorization failures", () => {
    expect(isAuthorizationFailure({ code: "PGRST301", message: "JWT expired" }, 401)).toBe(true);
    expect(isAuthorizationFailure({ code: "", message: "JWT expired" })).toBe(true);
    expect(isAuthorizationFailure({ code: "42501", message: "RECOVERY_V1_CALLER_REQUIRED" }, 403)).toBe(true);
    expect(isAuthorizationFailure({ code: "", message: "TypeError: Failed to fetch" }, 0)).toBe(false);
    expect(isAuthorizationFailure({ code: "", message: "Internal Server Error" }, 500)).toBe(false);
    expect(isAuthorizationFailure({ code: "42501", message: "permission denied for table sales" }, 403)).toBe(false);
    expect(isAuthorizationFailure(null, 401)).toBe(false);
  });
  it("legacy server (never detected): an expired sign-in on the status request keeps 085 behaviour: legacy rules, the sale goes through, nothing marked, no V1 refresh", async () => {
    plan = ["jwt-expired"];
    const refreshBefore = fake.refreshCalls;
    expect(await requireRecoveryV1Write("org-1", "shop-1")).toBe(false);
    expect(fake.refreshCalls).toBe(refreshBefore);
    resetRecoveryV1ForTests();
    await ringUp();
    expect(fake.server.sales.length + (await queuedSales()).length).toBe(1);   // sent (or queued) exactly as on 085; never refused
    expect(await v1Required()).toBe(false);
  });
  it("recovery-aware server: an expired sign-in is refreshed ONCE and the status asked again", async () => {
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    plan = ["jwt-expired", "ACTIVE"]; statusCalls = 0; fake.setAuth("valid", "ok");
    const refreshBefore = fake.refreshCalls;
    expect((await refreshRecoveryV1("org-1", { force: true }))?.state).toBe("ACTIVE");
    expect(fake.refreshCalls - refreshBefore).toBe(1);
    expect(statusCalls).toBe(2);
  });
  it("recovery-aware server: a refused refresh blocks with reason 'authorization', not 'communication'; nothing saved or sent", async () => {
    plan = ["RESTRICTED"]; await refreshRecoveryV1("org-1", { force: true });
    plan = ["jwt-expired"]; fake.setAuth("valid", "invalid");
    const auth = await blockOf(refreshRecoveryV1("org-1", { force: true }));
    expect(auth).toBeInstanceOf(RecoveryV1Blocked);
    expect((auth as RecoveryV1Blocked).reason).toBe("authorization");
    expect(String(auth)).toMatch(/sign in again/);
    plan = ["down"];
    const net = await blockOf(refreshRecoveryV1("org-1", { force: true }));
    expect((net as RecoveryV1Blocked).reason).toBe("communication");
    plan = ["caller-required"]; fake.setAuth("valid", "invalid");
    expect(((await blockOf(refreshRecoveryV1("org-1", { force: true }))) as RecoveryV1Blocked).reason).toBe("authorization");
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(sentKeys()).toEqual([]);
    expect(await v1Required()).toBe(true);
  });
  it("recovery-aware server: a refresh that cannot reach the auth server is a communication failure", async () => {
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    plan = ["jwt-expired"]; fake.setAuth("valid", "network");
    expect(((await blockOf(refreshRecoveryV1("org-1", { force: true }))) as RecoveryV1Blocked).reason).toBe("communication");
  });
  it("recovery-aware server: still refused after one successful refresh -> authorization, and never a second refresh (no loop)", async () => {
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    plan = ["jwt-expired", "jwt-expired"]; statusCalls = 0; fake.setAuth("valid", "ok");
    const refreshBefore = fake.refreshCalls;
    expect(((await blockOf(refreshRecoveryV1("org-1", { force: true }))) as RecoveryV1Blocked).reason).toBe("authorization");
    expect(fake.refreshCalls - refreshBefore).toBe(1);
    expect(statusCalls).toBe(2);
  });
  it("an authorization failure at the send boundary keeps the queued sale PENDING with its original key; it drains once after sign-in", async () => {
    vi.stubGlobal("navigator", { onLine: false }); plan = ["absent"];
    await ringUp();
    const [queued] = await queuedSales();
    vi.stubGlobal("navigator", { onLine: true });
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    plan = ["ACTIVE", "jwt-expired"]; statusCalls = 0; fake.setAuth("valid", "invalid");
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    const [after] = await queuedSales();
    expect(after.status).toBe("pending");
    expect(after.idempotencyKey).toBe(queued.idempotencyKey);
    expect(after.heldReason).toBe("recovery");
    expect(sentKeys()).toEqual([]);
    // signed in again: exactly one sale, same key
    plan = ["ACTIVE"]; fake.setAuth("valid", "ok");
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
    expect(sentKeys()).toEqual([queued.idempotencyKey]);
  });
});

/** Final migration integration, review round 1 fixes. */
describe("hold handling after review", () => {
  async function queuedThenDetected() {
    vi.stubGlobal("navigator", { onLine: false }); plan = ["absent"];
    await ringUp();
    const [queued] = await queuedSales();
    vi.stubGlobal("navigator", { onLine: true });
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    return queued;
  }
  it("an integrity block at the send boundary stops for an owner (not a silent retry); key kept, nothing sent", async () => {
    const queued = await queuedThenDetected();
    plan = ["ACTIVE", "malformed"]; statusCalls = 0;
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    const [after] = await queuedSales();
    expect(after.heldReason).toBe(OWNER_REVIEW);
    expect(after.status).toBe("pending");
    expect(after.idempotencyKey).toBe(queued.idempotencyKey);
    expect(after.lastError).toMatch(/^Not sent:/);
    expect(sentKeys()).toEqual([]);
  });
  it("an authorization block at the start of a drain asks for a new sign-in (needs-reauth), queue kept", async () => {
    const queued = await queuedThenDetected();
    plan = ["jwt-expired"]; fake.setAuth("valid", "invalid");
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    expect(await drainOutbox()).toBe("needs-reauth");
    expect(await readNeedsReauth()).toBe(true);
    const [after] = await queuedSales();
    expect(after.idempotencyKey).toBe(queued.idempotencyKey);
    expect(after.status).toBe("pending");
    expect(sentKeys()).toEqual([]);
  });
  it("an auth server answering 5xx on refresh is a communication failure, not a refused sign-in", async () => {
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    plan = ["jwt-expired"];
    vi.spyOn(fake.auth, "refreshSession").mockResolvedValue({ data: { session: null, user: null },
      error: { name: "AuthApiError", message: "Internal Server Error", status: 500 } } as never);
    try { await refreshRecoveryV1("org-1", { force: true }); throw new Error("expected a block"); }
    catch (error) { expect((error as RecoveryV1Blocked).reason).toBe("communication"); }
  });
  it("messages say an already queued operation stays queued with its key", async () => {
    plan = ["ACTIVE"]; await refreshRecoveryV1("org-1", { force: true });
    plan = ["down"];
    try { await refreshRecoveryV1("org-1", { force: true }); throw new Error("expected a block"); }
    catch (error) { expect(String(error)).toMatch(/already queued stays queued with its key/); }
  });
});
