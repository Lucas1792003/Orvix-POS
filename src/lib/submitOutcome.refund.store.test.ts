import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Financial submissions × v87.x store (integration): refund APPROVAL (online
// only) and refund REQUEST (queued when offline). The REAL sale slice,
// write-ahead / online-only layers and recovery state run against the fake
// server's 086/087 emulation. For every outcome: the right submit class
// (lib/submitOutcome.ts), no automatic resend after the call returns, a
// person's repeat sends the ORIGINAL key only, and the server executes the
// operation at most once (no duplicate refund decision, so no second stock return).
// ---------------------------------------------------------------------------

vi.mock("./supabase", async () => {
  const { fakeSupabase } = await import("../stores/data/testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "MANAGER" };
vi.mock("../stores/authStore", async () => {
  const actual = await vi.importActual<typeof import("../stores/authStore")>("../stores/authStore");
  return { ...actual, useAuthStore: { getState: () => acting } };
});

import { fakeSupabase as fake } from "../stores/data/testing/fakeSupabase";
import { localDb } from "./localDb";
import { createSaleSlice } from "../stores/data/slices/saleSlice";
import { drainOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "../stores/data/outbox";
import { registerOperationPrompt, type PromptDecision } from "../stores/data/operationPrompt";
import { resetOnlineOnlyForTests } from "../stores/data/onlineOnly";
import { resetWriteAheadForTests } from "../stores/data/writeAhead";
import { setExecutorCapabilityForTests } from "../stores/data/idempotentRpc";
import { loadRecoveryState, recoveryView, resetRecoveryStateForTests, storeTillCredential } from "../stores/data/recoveryState";
import { refreshRecoveryEpoch } from "../stores/data/recovery87";
import { resetRecoveryGateForTests } from "../stores/data/recoveryGate";
import { classifySubmitFailure } from "./submitOutcome";

function makeStore() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => { const patch = typeof updater === "function" ? updater(state) : updater; state = { ...state, ...patch }; };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createSaleSlice(set as any, get as any, {} as any);
  state = {
    ...slice,
    shifts: [],
    sales: [{ id: "sale-1", shopId: "shop-1", status: "NORMAL", totalMmk: 4500 }],
    saleItems: [],
    refunds: [{ id: "req-1", saleId: "sale-1", shopId: "shop-1", type: "PARTIAL", status: "REQUESTED", items: [] }],
    refundVoidRequests: [{ id: "req-1", saleId: "sale-1", shopId: "shop-1", type: "PARTIAL", status: "REQUESTED", items: [] }],
    inventory: [], movements: [], auditLogs: [],
  };
  registerOutboxReconciler("create_refund_void_request", (data, provisional) =>
    get().reconcileCreateRefundVoidRequest(data, provisional ?? []));
  return { get };
}

const online = (on: boolean) => vi.stubGlobal("navigator", { onLine: on });
const keysSent = (rpc: string) => new Set(fake.calls
  .filter((c) => c.name === rpc || ((c.name === "op_execute" || c.name === "op_execute_v87") && (c.args as { p_rpc?: string })?.p_rpc === rpc))
  .map((c) => {
    const a = c.args as Record<string, unknown>;
    return (a.p_key ?? a.p_idempotency_key ?? (a.p_args as Record<string, unknown> | undefined)?.p_idempotency_key) as string;
  }));
const prompt = vi.fn(async (): Promise<PromptDecision> => "cancel");
const approve = (get: () => { approveRefund: (i: unknown) => Promise<unknown> }) => get().approveRefund({ refundId: "req-1" });
const request = (get: () => { requestRefund: (i: unknown) => Promise<unknown> }) =>
  get().requestRefund({ saleId: "sale-1", items: [{ productId: "p1", qtyUnits: 1, amountMmk: 900 }], reason: "Damaged", actorId: "user-1" });

async function normalTill(): Promise<void> {
  const secret = fake.register87Till(recoveryView().tillId, { reconciled: true });
  await storeTillCredential({ orgId: "org-1", secret });
  expect((await refreshRecoveryEpoch({ shopId: "shop-1" })).kind).toBe("issued");
}

beforeEach(async () => {
  fake.reset();
  fake.enable087();
  fake.enableExecutor();
  fake.setCaller("user-1", false, "org-1");
  setExecutorCapabilityForTests("available");
  acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "MANAGER" };
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "MANAGER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  online(true);
  simulateNewAppInstanceForTests();
  resetWriteAheadForTests();
  resetOnlineOnlyForTests();
  resetRecoveryStateForTests(null);
  resetRecoveryGateForTests();
  await loadRecoveryState("org-1");
  prompt.mockClear();
  registerOperationPrompt(prompt);
  await normalTill();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

describe("approveRefund (refund approval, online only)", () => {
  it("confirmed success: resolves, executed exactly once, one key", async () => {
    const { get } = makeStore();
    await expect(approve(get)).resolves.toBeUndefined();
    expect(fake.server.executions.approve_refund_request).toBe(1);
    expect(keysSent("approve_refund_request").size).toBe(1);
  });

  it("confirmed rejection (server refusal, e.g. the refund cap): failed, nothing applied, the dialog stays open", async () => {
    fake.setRejectionMessage("Refund amount exceeds original sale amount for p1");
    fake.setDefaultMode("permanent-error");
    const { get } = makeStore();
    const err = await approve(get).catch((e) => e);
    expect(classifySubmitFailure(err)).toBe("failed");
    expect(String((err as Error).message)).toMatch(/Refund amount exceeds/);
    expect(get().refundVoidRequests[0].status).toBe("REQUESTED");
  });

  it("not sent (offline): failed before anything is sent — an approval is never queued", async () => {
    online(false);
    const { get } = makeStore();
    const err = await approve(get).catch((e) => e);
    expect(classifySubmitFailure(err)).toBe("failed");
    expect(keysSent("approve_refund_request").size).toBe(0);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("pending confirmation (network loss): the dialog closes; no background resend after the call returns", async () => {
    fake.setDefaultMode("network-error");
    const { get } = makeStore();
    const err = await approve(get).catch((e) => e);
    expect(classifySubmitFailure(err)).toBe("pending");
    expect(keysSent("approve_refund_request").size).toBe(1);
    const attempts = fake.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.length).toBe(attempts);
  });

  it("reply lost after the server committed: never a confirmed failure; executed once; any resend uses the ORIGINAL key", async () => {
    fake.queueModes("commit-then-timeout");
    const { get } = makeStore();
    const first = await approve(get).then(() => null, (e) => e);
    expect(fake.server.executions.approve_refund_request).toBe(1);
    const keys = keysSent("approve_refund_request");
    expect(keys.size).toBe(1);
    // PINNED CURRENT BEHAVIOUR (owner decision open): inside the one call,
    // callRpc resends the possibly-committed approval with the SAME key and the
    // 086 ledger answers it (replayed), so the call resolves. If callRpc stops
    // resending uncertain writes, this becomes "pending" and this test must change.
    expect(first).toBeNull();
    const sent = fake.calls.filter((c) => (c.args as { p_rpc?: string })?.p_rpc === "approve_refund_request");
    expect(sent.length).toBe(2);
    expect(sent[1].replayed).toBe(true);
    // a later approval is a NEW decision (new key); the real server refuses it ("not pending")
  });
});

describe("requestRefund (refund request, queued offline)", () => {
  it("confirmed success online: one request, one key", async () => {
    const { get } = makeStore();
    await request(get);
    expect(fake.server.executions.create_refund_void_request).toBe(1);
    expect(keysSent("create_refund_void_request").size).toBe(1);
  });

  it("offline on an 087 server: refused before anything is sent or queued", async () => {
    online(false);
    const { get } = makeStore();
    const err = await request(get).catch((e) => e);
    expect(err).toBeTruthy();
    expect(classifySubmitFailure(err)).toBe("failed");
    expect(keysSent("create_refund_void_request").size).toBe(0);
  });

  it("reply lost after commit: kept unresolved under its ORIGINAL key; a replay never executes it twice", async () => {
    fake.queueModes("commit-then-timeout");
    const { get } = makeStore();
    const err = await request(get).then(() => null, (e) => e);
    if (err) expect(classifySubmitFailure(err)).toBe("pending");
    expect(fake.server.executions.create_refund_void_request).toBe(1);
    const keys = keysSent("create_refund_void_request");
    expect(keys.size).toBe(1);
    // whatever the till kept for it carries the same key (never a new operation)
    const kept = (await localDb.syncOutbox.toArray()).filter((e) => e.name === "create_refund_void_request");
    expect(kept.length).toBeLessThanOrEqual(1);
    for (const e of kept) expect(keys.has(e.idempotencyKey as string)).toBe(true);
    await drainOutbox().catch(() => undefined);   // replay of whatever is still unresolved
    expect(fake.server.executions.create_refund_void_request).toBe(1);
    expect(keysSent("create_refund_void_request")).toEqual(keys);
  });
});
