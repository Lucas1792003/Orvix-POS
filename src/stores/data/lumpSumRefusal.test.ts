import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Owner decision (086): a definitive insufficient-balance refusal of a
// lump-sum supplier payment is FINAL — never retried automatically, its key
// never sent again (Retry, sync, restart, another window); a new attempt is
// a NEW operation with a NEW key. Both server paths: the 086 executor
// (recorded refusal) and an 085 server's direct RPC.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: "user-1", currentOrgId: "org-1", currentRole: "MANAGER" }) } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb } from "../../lib/localDb";
import { drainOutbox, simulateNewAppInstanceForTests } from "./outbox";
import { RpcError, setExecutorCapabilityForTests } from "./idempotentRpc";
import { failureInfo } from "../../lib/failureClass";
import { registerVerifiedReload } from "./verifiedReload";
import { callOnlineOnly, listUnresolvedOnlineOperations, resetOnlineOnlyForTests, retryOnlineOperation } from "./onlineOnly";
import { PendingConfirmationError, registerOperationPrompt, UnresolvedOperationError } from "./operationPrompt";
import { clearLumpSumRefusal, isLumpSumBalanceRefusal, markLumpSumRefusal, readLumpSumRefusal } from "../../features/suppliers/lumpSumRefusal";

const REFUSAL = "Payment amount exceeds total outstanding balance";
const payArgs = { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 5000, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
const records = async () => (await localDb.syncState.toArray())
  .filter((r) => r.key.startsWith("online-op:")).map((r) => JSON.parse(r.value));
const sentWith = (key: string) => fake.calls.filter((c) => {
  const a = c.args as Record<string, unknown> | undefined;
  return (c.name === "op_execute" && a?.p_key === key) || (c.name === "pay_supplier_lump_sum" && a?.p_idempotency_key === key);
}).length;
const prompt = vi.fn(async () => "new" as const);

beforeEach(async () => {
  fake.reset();
  fake.setCaller("user-1");
  fake.setRejectionMessage(REFUSAL);
  setExecutorCapabilityForTests("available");
  fake.enableExecutor();
  simulateNewAppInstanceForTests();
  resetOnlineOnlyForTests();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  registerVerifiedReload(null);
  prompt.mockClear();
  registerOperationPrompt(prompt);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

describe("isLumpSumBalanceRefusal", () => {
  it("only the server's definitive balance refusal", () => {
    expect(isLumpSumBalanceRefusal(new RpcError(REFUSAL, { code: "P0001", failure: failureInfo("REJECTED") }))).toBe(true);
    expect(isLumpSumBalanceRefusal(new RpcError("Insufficient stock", { code: "P0001", failure: failureInfo("REJECTED") }))).toBe(false);
    // nothing owed any more (paid in full elsewhere meanwhile) is the same refusal
    expect(isLumpSumBalanceRefusal(new RpcError("This supplier has no outstanding balance in this shop", { code: "P0001", failure: failureInfo("REJECTED") }))).toBe(true);
    // the same text on a failure that is not a definitive refusal is never final
    for (const k of ["TEMPORARY_SERVER", "UNKNOWN_OUTCOME", "NOT_RECORDED", "ABANDONED"] as const) {
      expect(isLumpSumBalanceRefusal(new RpcError(REFUSAL, { code: "P0001", failure: failureInfo(k) }))).toBe(false);
    }
    expect(isLumpSumBalanceRefusal(new Error(REFUSAL))).toBe(false);
    expect(isLumpSumBalanceRefusal(new PendingConfirmationError(REFUSAL))).toBe(false);
    expect(isLumpSumBalanceRefusal(new UnresolvedOperationError(REFUSAL, []))).toBe(false);
  });
});

describe.each([
  ["086 executor (recorded refusal)", true],
  ["085 server, direct RPC", false],
])("a refused lump sum is final — %s", (_label, executor) => {
  beforeEach(() => {
    if (!executor) { fake.enableExecutor(false); setExecutorCapabilityForTests("absent"); }
  });

  it("settled refused with its key; never re-sent by Retry, sync, restart or a later call; a new attempt gets a new key", async () => {
    fake.queueModes("permanent-error");
    const first = await callOnlineOnly("pay_supplier_lump_sum", payArgs);
    expect(isLumpSumBalanceRefusal(first.error)).toBe(true);
    expect(fake.server.executions.pay_supplier_lump_sum ?? 0).toBe(0);
    const [rec] = await records();
    const k1 = rec.args.p_idempotency_key as string;
    expect(rec).toMatchObject({ status: "settled", outcome: "refused", name: "pay_supplier_lump_sum" });
    if (executor) expect(fake.server.idempotency.get(k1)).toMatchObject({ state: "rejected", message: REFUSAL });
    expect(sentWith(k1)).toBe(1);

    // nothing to retry, nothing pending
    await expect(retryOnlineOperation(rec.id)).rejects.toThrow(/no longer unresolved/);
    expect(await listUnresolvedOnlineOperations()).toEqual([]);
    // sync and a restart (new app instance, in-memory state gone) never send it
    await drainOutbox();
    simulateNewAppInstanceForTests();
    resetOnlineOnlyForTests();
    await drainOutbox();
    expect(await listUnresolvedOnlineOperations()).toEqual([]);
    expect(sentWith(k1)).toBe(1);
    expect((await records()).find((r) => r.id === rec.id)).toMatchObject({ status: "settled", outcome: "refused" });

    // the balance rose meanwhile (a delayed receipt): the same payment entered again is a NEW
    // operation — a new key, no prompt about the refused one, executed once
    const second = await callOnlineOnly("pay_supplier_lump_sum", payArgs);
    expect(second.error).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
    const all = await records();
    const k2 = all.find((r) => r.id !== rec.id)!.args.p_idempotency_key as string;
    expect(k2).not.toBe(k1);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    expect(sentWith(k1)).toBe(1);
    expect(all.find((r) => r.id === rec.id)).toMatchObject({ status: "settled", outcome: "refused" });   // the refusal is kept
  });

  it("another window of the till (shared IndexedDB, own memory) sees it settled and never sends it", async () => {
    fake.queueModes("permanent-error");
    await callOnlineOnly("pay_supplier_lump_sum", payArgs);
    const [rec] = await records();
    const k1 = rec.args.p_idempotency_key as string;
    resetOnlineOnlyForTests();                       // window 2: no in-memory state of window 1
    await expect(retryOnlineOperation(rec.id)).rejects.toThrow(/no longer unresolved/);
    await drainOutbox();
    expect(sentWith(k1)).toBe(1);
    expect(await listUnresolvedOnlineOperations()).toEqual([]);
  });
});

describe("the refusal gate is kept on the till", () => {
  it("survives a new app instance (restart / another window) until a new payment clears it; per organisation, supplier and shop", async () => {
    expect(await readLumpSumRefusal("org-1", "s1", "shop-1")).toBeNull();
    await markLumpSumRefusal("org-1", "s1", "shop-1", 5000);
    simulateNewAppInstanceForTests();
    resetOnlineOnlyForTests();
    expect(await readLumpSumRefusal("org-1", "s1", "shop-1")).toMatchObject({ amountMmk: 5000 });
    expect(await readLumpSumRefusal("org-2", "s1", "shop-1")).toBeNull();
    expect(await readLumpSumRefusal("org-1", "s1", "shop-2")).toBeNull();
    // never counted as unsynced work or an online operation
    expect(await listUnresolvedOnlineOperations()).toEqual([]);
    await clearLumpSumRefusal("org-1", "s1", "shop-1");
    expect(await readLumpSumRefusal("org-1", "s1", "shop-1")).toBeNull();
  });

  it("an unreadable gate record counts as a refusal (fail closed: the dialog re-checks)", async () => {
    await localDb.syncState.put({ key: "lump-refusal:org-1|s1|shop-1", value: "{not json", updatedAt: "x" });
    expect(await readLumpSumRefusal("org-1", "s1", "shop-1")).toEqual({ amountMmk: 0, at: "" });
  });
});
