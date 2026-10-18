import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// A lump-sum supplier payment the server COMMITTED but whose reply this till
// cannot read (lost, then purged / withheld) is a recorded payment — never a
// failure: the store reports it as recorded (no second payment can follow
// from a "failed" message). An unknown outcome stays pending with its key.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let acting = { user: "user-1", org: "org-1", role: "MANAGER" };
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: acting.user, currentOrgId: acting.org, currentRole: acting.role }) } };
});
vi.mock("../authCache", () => ({ refreshAuthCacheSnapshot: vi.fn(async () => undefined), touchAuthCache: vi.fn(async () => undefined) }));

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb } from "../../lib/localDb";
import { simulateNewAppInstanceForTests } from "./outbox";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { registerVerifiedReload } from "./verifiedReload";
import { listUnresolvedOnlineOperations, resetOnlineOnlyForTests, retryOnlineOperation } from "./onlineOnly";
import { isPendingConfirmation, registerOperationPrompt } from "./operationPrompt";
import { useDataStore } from "./index";
import { checkPendingLumpSum, inDoubtPoPayments, pendingLumpSumState, resendPendingLumpSum } from "../../features/suppliers/lumpSumOutcome";
import { currentBackendOrigin } from "../../lib/backendOrigin";

const input = { supplierId: "s1", shopId: "shop-1", amountMmk: 1000, paymentMethod: "CASH" as const };
const records = async () => (await localDb.syncState.toArray())
  .filter((r) => r.key.startsWith("online-op:")).map((r) => JSON.parse(r.value ?? "{}"));
const reload = vi.fn(async () => true);

beforeEach(async () => {
  acting = { user: "user-1", org: "org-1", role: "MANAGER" };
  fake.reset();
  fake.setCaller("user-1");
  setExecutorCapabilityForTests("available");
  fake.enableExecutor();
  simulateNewAppInstanceForTests();
  resetOnlineOnlyForTests();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  reload.mockClear();
  registerVerifiedReload(reload);
  registerOperationPrompt(async () => "retry");
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
  registerVerifiedReload(null);
});

describe("a committed lump sum whose reply is unavailable", () => {
  it("reply lost (unknown) -> pending with its key, NEVER a failure; purged reply on the same-key resend -> RECORDED, once", async () => {
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    const first = await useDataStore.getState().paySupplierLumpSum(input).then(() => null, (e: unknown) => e);
    expect(isPendingConfirmation(first)).toBe(true);                      // unknown, not failed
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    const [op] = await listUnresolvedOnlineOperations();
    const key = op.args.p_idempotency_key as string;
    fake.purgeResponse(key);                                              // the stored reply is gone

    // the same payment entered again; the cashier chooses to resend the earlier one (same key)
    const result = await useDataStore.getState().paySupplierLumpSum(input);
    expect(result).toEqual({ replyAvailable: false });                     // recorded, details reloaded
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);          // never executed twice
    expect((await records()).find((r) => r.id === op.id)).toMatchObject({ status: "settled", outcome: "applied" });
    expect((await records()).map((r) => r.args.p_idempotency_key)).toEqual([key]);   // no new key
    expect(reload).toHaveBeenCalled();
  });

  it("the Sync page's Retry of the same key: the server's committed answer settles it applied (no new key)", async () => {
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    await useDataStore.getState().paySupplierLumpSum(input).catch(() => undefined);
    const [op] = await listUnresolvedOnlineOperations();
    fake.purgeResponse(op.args.p_idempotency_key as string);
    simulateNewAppInstanceForTests();                                     // a restart in between
    resetOnlineOnlyForTests();
    const out = await retryOnlineOperation(op.id);
    expect(out.error).toBeNull();
    expect(out.responseUnavailable).toBe("purged");
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    expect(await listUnresolvedOnlineOperations()).toEqual([]);
  });

  it("a reply withheld (another user's committed key) is recorded too, never 'failed'", async () => {
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    await useDataStore.getState().paySupplierLumpSum(input).catch(() => undefined);
    const [op] = await listUnresolvedOnlineOperations();
    // the server answers the committed key without its reply (withheld)
    fake.queueReply({ data: { outcome: "committed", replayed: true, response: null, withheld: true }, error: null, status: 200 });
    const result = await useDataStore.getState().paySupplierLumpSum(input);
    expect(result).toEqual({ replyAvailable: false });
    expect((await records()).find((r) => r.id === op.id)).toMatchObject({ status: "settled", outcome: "applied" });
  });
});

/** A lump sum of s1/shop-1 whose reply was lost: committed on the server, unresolved on the till. */
async function unknownPayment(): Promise<{ id: string; key: string }> {
  fake.queueModes("commit-then-timeout", "network-error", "network-error");
  const e = await useDataStore.getState().paySupplierLumpSum(input).then(() => null, (x: unknown) => x);
  expect(isPendingConfirmation(e)).toBe(true);
  const [op] = await listUnresolvedOnlineOperations();
  return { id: op.id, key: op.args.p_idempotency_key as string };
}

describe("the unknown-outcome guard (both payment dialogs read it)", () => {
  it("blocks only this organisation's supplier and shop; survives a restart (another window = the same IndexedDB)", async () => {
    await unknownPayment();
    expect(await pendingLumpSumState("s1", "shop-1")).toMatchObject({ kind: "pending", ops: [{ amountMmk: 1000, mine: true, retryable: true }] });
    expect(await pendingLumpSumState("s2", "shop-1")).toEqual({ kind: "none" });
    expect(await pendingLumpSumState("s1", "shop-2")).toEqual({ kind: "none" });
    simulateNewAppInstanceForTests();
    resetOnlineOnlyForTests();
    expect((await pendingLumpSumState("s1", "shop-1")).kind).toBe("pending");
    acting = { user: "user-9", org: "org-2", role: "ADMIN" };                     // another organisation on this till
    expect(await pendingLumpSumState("s1", "shop-1")).toEqual({ kind: "none" });
  });

  it("another user of the organisation: still blocked, but they cannot resend it (not theirs) and a non-owner cannot check it", async () => {
    const { id } = await unknownPayment();
    acting = { user: "user-2", org: "org-1", role: "ADMIN" };
    expect(await pendingLumpSumState("s1", "shop-1")).toMatchObject({ kind: "pending", ops: [{ mine: false, retryable: false, checkable: true }] });   // the owner may check
    acting = { user: "user-2", org: "org-1", role: "CASHIER" };
    expect(await pendingLumpSumState("s1", "shop-1")).toMatchObject({ kind: "pending", ops: [{ mine: false, retryable: false, checkable: false }] });
    expect(await checkPendingLumpSum(id)).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/Only the person who entered it/) });
    expect(await resendPendingLumpSum(id)).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/Only the person who entered it/) });
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    expect((await pendingLumpSumState("s1", "shop-1")).kind).toBe("pending");
  });

  it("another organisation cannot check or resend it (and is not blocked by it)", async () => {
    const { id } = await unknownPayment();
    acting = { user: "user-1", org: "org-2", role: "ADMIN" };
    expect(await checkPendingLumpSum(id)).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/another organisation/) });
    expect(await resendPendingLumpSum(id)).toMatchObject({ kind: "unknown" });
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
  });

  it("an unreadable payment record that may be this one blocks (fail closed)", async () => {
    await localDb.syncState.put({ key: "online-op:op-bad", value: "{not json", updatedAt: "x" });
    expect(await pendingLumpSumState("s1", "shop-1")).toMatchObject({ kind: "unreadable" });
  });

  it("Check with server: COMMITTED with its reply purged -> recorded (settled, reloaded), no key created, nothing sent", async () => {
    const { key } = await unknownPayment();
    fake.purgeResponse(key);
    const sent = fake.callsFor("op_execute").length;
    const [op] = await listUnresolvedOnlineOperations();
    expect(await checkPendingLumpSum(op.id)).toEqual({ kind: "recorded" });
    expect(fake.callsFor("op_execute").length).toBe(sent);                    // a lookup, never a send
    expect(await pendingLumpSumState("s1", "shop-1")).toEqual({ kind: "none" });
    expect(reload).toHaveBeenCalled();
    expect((await records()).map((r) => r.args.p_idempotency_key)).toEqual([key]);
  });

  it("Check with server: the backend unreachable -> still unknown, still blocked", async () => {
    const { id } = await unknownPayment();
    fake.queueModes("network-error", "network-error", "network-error", "network-error");
    expect((await checkPendingLumpSum(id)).kind).toBe("unknown");
    expect((await pendingLumpSumState("s1", "shop-1")).kind).toBe("pending");
  });

  it("Check with server: never arrived (not found) -> still unknown (the lookup never fences)", async () => {
    fake.queueModes("network-error", "network-error", "network-error");      // nothing reaches the server
    await useDataStore.getState().paySupplierLumpSum(input).catch(() => undefined);
    const [op] = await listUnresolvedOnlineOperations();
    expect(op).toBeTruthy();
    expect(await checkPendingLumpSum(op.id)).toMatchObject({ kind: "unknown" });
    expect(fake.server.idempotency.get(op.args.p_idempotency_key as string)).toBeUndefined();   // not fenced
    expect((await pendingLumpSumState("s1", "shop-1")).kind).toBe("pending");
  });

  it("a definitive balance refusal on the first attempt is settled at once: nothing pending, nothing to check", async () => {
    fake.setRejectionMessage("Payment amount exceeds total outstanding balance");
    fake.queueModes("permanent-error");                                        // recorded as rejected on the server
    const e = await useDataStore.getState().paySupplierLumpSum(input).then(() => null, (x: unknown) => x);
    expect(e).toBeTruthy();
    // (settled refused at once: nothing pending)
    expect(await pendingLumpSumState("s1", "shop-1")).toEqual({ kind: "none" });
  });

  it("Check with server: a rejection the till never heard (reply lost) -> the actual rejection", async () => {
    fake.setRejectionMessage("Payment amount exceeds total outstanding balance");
    fake.queueModes("network-error", "network-error", "network-error");
    await useDataStore.getState().paySupplierLumpSum(input).catch(() => undefined);
    const [op] = await listUnresolvedOnlineOperations();
    const key = op.args.p_idempotency_key as string;
    fake.server.idempotency.set(key, { rpc: "pay_supplier_lump_sum", hash: "R:x", response: null, state: "rejected", actor: "user-1", code: "P0001", message: "Payment amount exceeds total outstanding balance" });
    expect(await checkPendingLumpSum(op.id)).toEqual({ kind: "refused", message: "Payment amount exceeds total outstanding balance", balanceRefusal: true });
    expect(await pendingLumpSumState("s1", "shop-1")).toEqual({ kind: "none" });
    expect(fake.server.executions.pay_supplier_lump_sum ?? 0).toBe(0);
  });

  it("Check with server: stopped (abandoned) -> stopped; it can be entered again", async () => {
    fake.queueModes("network-error", "network-error", "network-error");
    await useDataStore.getState().paySupplierLumpSum(input).catch(() => undefined);
    const [op] = await listUnresolvedOnlineOperations();
    fake.server.idempotency.set(op.args.p_idempotency_key as string, { rpc: "pay_supplier_lump_sum", hash: "A:", response: null, state: "abandoned", actor: "user-1", code: "FENCED" });
    expect(await checkPendingLumpSum(op.id)).toEqual({ kind: "stopped" });
    expect(await pendingLumpSumState("s1", "shop-1")).toEqual({ kind: "none" });
  });

  it("Send the same payment again: SAME key, executed once, recorded (reply purged)", async () => {
    const { id, key } = await unknownPayment();
    fake.purgeResponse(key);
    expect(await resendPendingLumpSum(id)).toEqual({ kind: "recorded" });
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    expect(fake.callsFor("op_execute").every((c) => (c.args as Record<string, unknown>).p_key === key)).toBe(true);
    expect(await pendingLumpSumState("s1", "shop-1")).toEqual({ kind: "none" });
  });

  it("Send the same payment again with the backend still unreachable: unknown, still blocked, still one key", async () => {
    const { id, key } = await unknownPayment();
    fake.queueModes("network-error", "network-error", "network-error", "network-error", "network-error", "network-error");
    expect((await resendPendingLumpSum(id)).kind).toBe("unknown");
    expect((await pendingLumpSumState("s1", "shop-1")).kind).toBe("pending");
    expect((await records()).map((r) => r.args.p_idempotency_key)).toEqual([key]);
  });
});

const putOp = (id: string, over: Record<string, unknown>) => localDb.syncState.put({
  key: `online-op:${id}`, updatedAt: "x",
  value: JSON.stringify({
    v: 2, id, name: "pay_supplier_lump_sum", orgId: "org-1", userId: "user-1", fingerprint: id, scope: "pay_supplier_lump_sum#s1|shop-1",
    args: { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 700, p_payment_method: "CASH", p_reference_no: null, p_notes: null, p_idempotency_key: "0190a000-0000-7000-8000-000000000777" },
    status: "unresolved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, uncertain: true,
    backendOrigin: currentBackendOrigin(), ...over,
  }),
});

describe("recovery edge cases", () => {
  it("a server WITHOUT 086: Check cannot ask (still unknown, blocked); the same payment resent goes the direct way with ITS key, once", async () => {
    fake.enableExecutor(false);
    setExecutorCapabilityForTests("absent");
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    await useDataStore.getState().paySupplierLumpSum(input).catch(() => undefined);
    const [op] = await listUnresolvedOnlineOperations();
    const key = op.args.p_idempotency_key as string;
    expect(await checkPendingLumpSum(op.id)).toMatchObject({ kind: "unknown" });
    expect((await pendingLumpSumState("s1", "shop-1")).kind).toBe("pending");
    expect(await resendPendingLumpSum(op.id)).toEqual({ kind: "recorded" });      // the legacy key replay answers
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    expect(fake.callsFor("pay_supplier_lump_sum").every((c) => (c.args as Record<string, unknown>).p_idempotency_key === key)).toBe(true);
  });

  it("an older record WITHOUT its backend: not resendable here (still blocked); checking takes only a positive answer", async () => {
    await putOp("op-old", { backendOrigin: undefined });
    const state = await pendingLumpSumState("s1", "shop-1");
    expect(state).toMatchObject({ kind: "pending", ops: [{ id: "op-old", amountMmk: 700, retryable: false, checkable: true }] });
    expect(await resendPendingLumpSum("op-old")).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/another server/) });
    expect(await checkPendingLumpSum("op-old")).toMatchObject({ kind: "unknown" });           // not found proves nothing
    expect((await pendingLumpSumState("s1", "shop-1")).kind).toBe("pending");
    expect(fake.callsFor("op_execute")).toHaveLength(0);
  });

  it("a record past the retry window: never resent (its key may be forgotten), still blocked until checked / verified", async () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    await putOp("op-aged", { createdAt: old, updatedAt: old });
    expect(await pendingLumpSumState("s1", "shop-1")).toMatchObject({ kind: "pending", ops: [{ retryable: false }] });
    expect(await resendPendingLumpSum("op-aged")).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/Too old/) });
    expect(fake.callsFor("op_execute")).toHaveLength(0);
    expect((await pendingLumpSumState("s1", "shop-1")).kind).toBe("pending");
  });

  it("an in-doubt single-PO payment of this supplier's purchase order blocks a lump sum (any amount); a queued-but-unsent one or a decided one does not", async () => {
    const row = (localId: string, over: Record<string, unknown>) => localDb.syncOutbox.add({
      localId, kind: "rpc", name: "record_supplier_payment", args: { p_purchase_order_id: "po-1", p_amount_mmk: 300, p_idempotency_key: localId },
      status: "pending", createdAt: new Date().toISOString(), attempts: 0, writeAhead: true, ...over,
    } as never);
    await row("q1", {});                                                      // queued, never sent: not in doubt
    expect(await inDoubtPoPayments(["po-1"])).toBe(0);
    await row("q2", { status: "syncing" });                                  // sent, outcome unknown
    expect(await inDoubtPoPayments(["po-1"])).toBe(1);
    expect(await inDoubtPoPayments(["po-2"])).toBe(0);
    expect(await pendingLumpSumState("s1", "shop-1", ["po-1"])).toEqual({ kind: "po-pending", count: 1 });
    await row("q3", { status: "conflict", fenceRequired: true, serverOutcome: "rejected" });   // decided by the server
    expect(await inDoubtPoPayments(["po-1"])).toBe(1);
  });
});
