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
import { drainOutbox, enqueueOutbox, registerOutboxReconciler, retryOutboxEntry, simulateNewAppInstanceForTests } from "../stores/data/outbox";
import { resetWriteAheadForTests } from "../stores/data/writeAhead";
import { setExecutorCapabilityForTests } from "../stores/data/idempotentRpc";
import { registerVerifiedReload } from "../stores/data/verifiedReload";
import { resetRecoveryStateForTests } from "../stores/data/recoveryState";
import { listJournal } from "../stores/data/opJournal";
import { configureIndependentTrust } from "./trust";
import { deviceVault } from "./deviceVault";
import { listDeviceEvidence } from "./journalCapture";
import { verifyEvidencePrefix } from "./evidence";
import { refreshRecoveryV1, requireRecoveryV1Write, type RecoveryV1Status } from "./client";
import { syntheticRecoveryFixture } from "./testing";
import { uploadRecoveryEvidence } from "./sync";

let serverState: RecoveryV1Status["state"] | "absent" | "malformed" | "down" = "ACTIVE";
let storedEvidence = 0;
beforeEach(async () => {
  vi.restoreAllMocks(); fake.reset(); fake.enableExecutor(); setExecutorCapabilityForTests("available");
  simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetRecoveryStateForTests();
  await Promise.all(localDb.tables.map((t) => t.clear())); await deviceVault.identities.clear();
  configureIndependentTrust(null); serverState = "ACTIVE"; storedEvidence = 0;
  useAppStore.setState({ currentShopId: "shop-1" });
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  vi.stubGlobal("navigator", { onLine: true }); registerVerifiedReload(async () => true);
  const real = fake.rpc;
  vi.spyOn(fake, "rpc").mockImplementation((name, args = {}) => {
    if (name === "recovery_v1_store_evidence") {
      storedEvidence++;
      const promise = Promise.resolve({ data: { outcome: "stored", verified: false }, error: null, status: 200 });
      const builder = { abortSignal: () => builder, then: promise.then.bind(promise) }; return builder as ReturnType<typeof real>;
    }
    if (name !== "recovery_v1_status") return real(name, args);
    const response = serverState === "absent" ? { data: null, error: { code: "PGRST202", message: "Could not find public.recovery_v1_status" }, status: 404 }
      : serverState === "down" ? { data: null, error: { code: "FETCH_ERROR", message: "network" }, status: 0 }
      : { data: serverState === "malformed" ? { state: "ACTIVE" } : { protocol: "orvix-recovery-v1", org_id: "org-1", state: serverState,
        recovered_as_of: null, uncertainties: ["financial history incomplete"], required_evidence: true }, error: null, status: 200 };
    const promise = Promise.resolve(response); const builder = { abortSignal: () => builder, then: promise.then.bind(promise) }; return builder as ReturnType<typeof real>;
  });
});
afterEach(() => { configureIndependentTrust(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function saleStore() {
  // Same real slice harness as the journal integration suite.
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

describe("V1 actual financial slice and recovery gating", () => {
  it("signed actual sale passes write-ahead, exact transmission, commit observation with stable financial key", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source);
    await saleStore()().createSale(sale());
    expect(fake.server.sales).toHaveLength(1); expect(await localDb.syncOutbox.count()).toBe(0);
    const records = await listDeviceEvidence("org-1");
    expect(records.some((r) => r.envelope.body.evidenceKind === "transmission")).toBe(true);
    expect(records.some((r) => (r.observation as { state?: unknown }).state === "committed")).toBe(true);
    expect(new Set(records.map((r) => r.envelope.body.operationId)).size).toBe(1);
    expect(await verifyEvidencePrefix(records, f.source, f)).toMatchObject({ valid: true, complete: false });
  });
  it("ACTIVE server cannot substitute independent enrollment; no financial row saved/sent", async () => {
    await expect(saleStore()().createSale(sale())).rejects.toThrow(/independent|Independent/);
    expect(fake.server.sales).toHaveLength(0); expect(await localDb.syncOutbox.count()).toBe(0); expect(await deviceVault.identities.count()).toBe(0);
  });
  it("restricted reconnect retains pre-existing unsigned offline evidence byte-identically and never syncs/retries", async () => {
    serverState = "absent";
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "shop-1", p_paid_mmk: 100 }, shopId: "shop-1", orgId: "org-1", staged: true });
    const before = await localDb.syncOutbox.toArray(); const journal = await listJournal({ orgId: "org-1" });
    serverState = "RESTRICTED"; await refreshRecoveryV1("org-1", { force: true });
    vi.stubGlobal("navigator", { onLine: false });
    await expect(requireRecoveryV1Write("org-1", "shop-1")).rejects.toThrow(/offline/);
    vi.stubGlobal("navigator", { onLine: true });
    expect(await drainOutbox()).toBe("backoff"); await expect(retryOutboxEntry(before[0].localId)).rejects.toThrow(/restricted/);
    expect(await localDb.syncOutbox.toArray()).toEqual(before); expect(await listJournal({ orgId: "org-1" })).toEqual(journal);
    expect(fake.server.sales).toHaveLength(0); expect(await deviceVault.identities.count()).toBe(0);
  });
  it("once positively detected, downgrade/malformed/unreachable status never authorizes a write", async () => {
    await refreshRecoveryV1("org-1");
    for (const state of ["absent", "malformed", "down"] as const) {
      serverState = state; await expect(requireRecoveryV1Write("org-1", "shop-1")).rejects.toThrow(/Recovery/);
    }
    serverState = "absent";
    await expect(requireRecoveryV1Write("org-2", "shop-2")).rejects.toThrow(/Recovery/);
  });
  it("evidence-only upload remains available while restricted and preserves every local original", async () => {
    const f = await syntheticRecoveryFixture(); configureIndependentTrust(f.source); await saleStore()().createSale(sale());
    const before = await listDeviceEvidence("org-1"); serverState = "RESTRICTED"; await refreshRecoveryV1("org-1");
    expect(await uploadRecoveryEvidence("org-1", "shop-1")).toMatchObject({ stored: before.length, verifiedByServer: false });
    expect(storedEvidence).toBe(before.length); expect(await listDeviceEvidence("org-1")).toEqual(before);
    await expect(uploadRecoveryEvidence("org-2")).rejects.toThrow("TENANT_OR_SESSION_MISMATCH");
  });
});
