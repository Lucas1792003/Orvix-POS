import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Financial UI × v87.x store (integration). The Transfers reason dialog and
// the stock-adjust form decide from classifySubmitFailure() whether to close
// (pending: may already be recorded), stay open (not-sent / failed) or close
// on success. Here the REAL transfer / inventory slices, write-ahead engine,
// online-only layer and recovery state run against the fake server's 087
// emulation (stores/data/testing/fakeSupabase.ts), and each outcome must land
// in the right class — with no automatic resend of an uncertain operation and
// no second operation (new key) from a repeated submit.
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
import { createInventorySlice } from "../stores/data/slices/inventorySlice";
import { createTransferSlice } from "../stores/data/slices/transferSlice";
import { registerOutboxReconciler, simulateNewAppInstanceForTests } from "../stores/data/outbox";
import { registerOperationPrompt, type PromptDecision } from "../stores/data/operationPrompt";
import { resetOnlineOnlyForTests } from "../stores/data/onlineOnly";
import { resetWriteAheadForTests } from "../stores/data/writeAhead";
import { setExecutorCapabilityForTests } from "../stores/data/idempotentRpc";
import {
  isRecoveryBlocked, loadRecoveryState, recoveryView, resetRecoveryStateForTests, storeTillCredential, OFFLINE_FINANCIAL_DISABLED,
} from "../stores/data/recoveryState";
import { refreshRecoveryEpoch } from "../stores/data/recovery87";
import { resetRecoveryGateForTests } from "../stores/data/recoveryGate";
import { classifySubmitFailure } from "./submitOutcome";
import { getErrorMessage } from "./errors";

function makeStore() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => { const patch = typeof updater === "function" ? updater(state) : updater; state = { ...state, ...patch }; };
  const get = () => state;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const inventorySlice = createInventorySlice(set as any, get as any, {} as any);
  const transferSlice = createTransferSlice(set as any, get as any, {} as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  state = {
    ...inventorySlice, ...transferSlice,
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
    products: [{ id: "p1", isNonStock: false }],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    movements: [], auditLogs: [],
    stockTransfers: [{ id: "t1", fromShopId: "shop-1", toShopId: "shop-2", status: "PENDING" }],
    stockTransferItems: [],
  };
  registerOutboxReconciler("adjust_stock", (data, provisional, ackId) => get().reconcileAdjustStock(data, provisional ?? [], ackId));
  return { get };
}

const adjust = (get: () => { adjustStock: (i: unknown) => Promise<unknown> }) =>
  get().adjustStock({ shopId: "shop-1", productId: "p1", type: "ADJUSTMENT", qtyChange: -2, reason: "Recount", actorId: "user-1" });
const online = (on: boolean) => vi.stubGlobal("navigator", { onLine: on });
const keysSent = (rpc: string) => new Set(fake.calls
  .filter((c) => c.name === rpc || ((c.name === "op_execute" || c.name === "op_execute_v87") && (c.args as { p_rpc?: string })?.p_rpc === rpc))
  .map((c) => {
    const a = c.args as Record<string, unknown>;
    return (a.p_key ?? a.p_idempotency_key ?? (a.p_args as Record<string, unknown> | undefined)?.p_idempotency_key) as string;
  }));
const prompt = vi.fn(async (): Promise<PromptDecision> => "cancel");

async function normalTill(): Promise<void> {
  const tillId = recoveryView().tillId;
  const secret = fake.register87Till(tillId, { reconciled: true });
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

describe("adjustStock (stock-adjust form)", () => {
  it("success resolves (the form closes)", async () => {
    const { get } = makeStore();
    const err = await adjust(get).then(() => null, (e) => e);
    expect(err).toBeNull();
    expect(fake.server.executions.adjust_stock).toBe(1);
  });

  it("server recovery hold → failed: nothing recorded, the toast explains it, the form stays open", async () => {
    fake.set087Server({ state: "hold" });
    const { get } = makeStore();
    const err = await adjust(get).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(classifySubmitFailure(err)).toBe("failed");
    expect(getErrorMessage(err, "x")).toContain("Not recorded");
    expect(fake.server.executions.adjust_stock ?? 0).toBe(0);
  });

  it("offline on an 087 server → failed (offline financial entry refused), nothing queued", async () => {
    online(false);
    const { get } = makeStore();
    const err = await adjust(get).catch((e) => e);
    expect(isRecoveryBlocked(err) && (err as { code: string }).code === OFFLINE_FINANCIAL_DISABLED).toBe(true);
    expect(classifySubmitFailure(err)).toBe("failed");
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("reply lost after the server committed → never a confirmed failure; no automatic resend; a repeat is not a second adjustment", async () => {
    fake.queueModes("commit-then-timeout");
    const { get } = makeStore();
    const first = await adjust(get).then(() => null, (e) => e);
    // Either surfaced as pending confirmation (form closes) or resolved as
    // an in-doubt entry shown as pending — never "failed" (which would
    // invite re-entering it).
    if (first) expect(classifySubmitFailure(first)).toBe("pending");
    expect(fake.server.executions.adjust_stock).toBe(1);
    const keysAfterFirst = keysSent("adjust_stock");

    // The person submits the same adjustment again: the store asks about
    // the unresolved earlier attempt; declining sends nothing.
    prompt.mockResolvedValueOnce("cancel");
    const again = await adjust(get).then(() => null, (e) => e);
    expect(again && classifySubmitFailure(again)).toBe("not-sent");
    expect(fake.server.executions.adjust_stock).toBe(1);
    expect(keysSent("adjust_stock")).toEqual(keysAfterFirst);
  });
});

describe.each([
  ["rejectTransfer", "reject_stock_transfer"],
  ["cancelTransfer", "cancel_stock_transfer"],
] as const)("%s (transfer reason dialog)", (action, rpc) => {
  const call = (get: () => Record<string, (i: unknown) => Promise<unknown>>) =>
    get()[action]({ transferId: "t1", actorId: "user-1", reason: "Wrong shop" });

  it("server recovery hold → failed: nothing ran, the dialog stays open", async () => {
    fake.set087Server({ state: "hold" });
    const { get } = makeStore();
    const err = await call(get).catch((e) => e);
    expect(classifySubmitFailure(err)).toBe("failed");
    expect(getErrorMessage(err, "x")).toMatch(/recover/i);
    expect(fake.server.executions[rpc] ?? 0).toBe(0);
  });

  it("offline on an 087 server → failed before anything is sent", async () => {
    online(false);
    const { get } = makeStore();
    const err = await call(get).catch((e) => e);
    expect(classifySubmitFailure(err)).toBe("failed");
    expect(keysSent(rpc).size).toBe(0);
  });

  it("network loss (outcome unknown) → pending: the dialog closes; nothing is resent automatically", async () => {
    fake.setDefaultMode("network-error");
    const { get } = makeStore();
    const err = await call(get).catch((e) => e);
    expect(classifySubmitFailure(err)).toBe("pending");
    const keys = keysSent(rpc);
    expect(keys.size).toBe(1);
    const attempts = fake.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.calls.length).toBe(attempts);            // no background resend by the UI path
  });

  // After a pending outcome the dialog closes; a person can still reopen it.
  // onlineOnly.ts: "the same call on the same record, unchanged: that IS the
  // retry" — the ORIGINAL key is resent (idempotent), never a new operation.
  it("the same reason again after an unknown outcome resends the ORIGINAL key only (person-initiated), still pending", async () => {
    fake.setDefaultMode("network-error");
    const { get } = makeStore();
    await call(get).catch(() => undefined);
    const keys = keysSent(rpc);
    const again = await call(get).catch((e) => e);
    expect(classifySubmitFailure(again)).toBe("pending");
    expect(keysSent(rpc)).toEqual(keys);                 // no new key
    expect(prompt).not.toHaveBeenCalled();
  });

  it("a DIFFERENT reason on the same transfer asks first; declining → not-sent, nothing new sent", async () => {
    fake.setDefaultMode("network-error");
    const { get } = makeStore();
    await call(get).catch(() => undefined);
    const keys = keysSent(rpc);
    prompt.mockResolvedValueOnce("cancel");
    const again = await get()[action]({ transferId: "t1", actorId: "user-1", reason: "Damaged in transit" }).catch((e) => e);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(classifySubmitFailure(again)).toBe("not-sent");
    expect(keysSent(rpc)).toEqual(keys);
  });
});
