import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Batch 2A correction pass — Priority A: online-only money operations have an
// explicit, persisted identity (org + user scoped). A retry is never a new
// operation and a new operation is never silently merged into an old one.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import {
  callOnlineOnly, countUnsettledOnlineOperations, listUnresolvedOnlineOperations, markOnlineOperationVerified,
  resetOnlineOnlyForTests, retryOnlineOperation, RETRY_WINDOW_MS,
} from "./onlineOnly";
import { registerOperationPrompt, type PromptDecision, type UnresolvedPromptRequest } from "./operationPrompt";
import { useAuthStore } from "../authStore";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { localDb } from "../../lib/localDb";

const payArgs = (over: Record<string, unknown> = {}) => ({
  p_supplier_id: "sup-1", p_shop_id: "shop-1", p_amount_mmk: 50_000, p_payment_method: "CASH",
  p_reference_no: null, p_notes: null, p_idempotency_key: "ignored", ...over,
});
const pay = (over: Record<string, unknown> = {}, now?: number) => callOnlineOnly("pay_supplier_lump_sum", payArgs(over), { now });
const payments = () => fake.callsFor("pay_supplier_lump_sum");
const keys = () => payments().map((c) => c.args.p_idempotency_key);
// The first payment commits on the server but every reply is lost (1 + 2 automatic retries).
const lostReplies = () => fake.queueModes("commit-then-timeout", "commit-then-timeout", "commit-then-timeout");

let asked: UnresolvedPromptRequest[] = [];
const answer = (decision: PromptDecision) => registerOperationPrompt(async (request) => {
  asked.push(request);
  return decision;
});

beforeEach(async () => {
  fake.reset();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  resetOnlineOnlyForTests();
  asked = [];
  registerOperationPrompt(null);
  useAuthStore.setState({ currentUserId: "user-1", currentOrgId: "org-1" });
  setExecutorCapabilityForTests("absent");
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  registerOperationPrompt(null);
  vi.unstubAllGlobals();
});

describe("an unknown outcome", () => {
  it("is reported as PENDING CONFIRMATION, never as failed, and stays recorded with its key", async () => {
    lostReplies();
    const first = await pay();
    expect(first.error?.name).toBe("PendingConfirmationError");
    expect(first.error?.message).toMatch(/^Pending confirmation:/);
    expect(await countUnsettledOnlineOperations()).toBe(1);
    expect(new Set(keys()).size).toBe(1); // the automatic retries reused the key
  });

  it("an EMPTY successful reply is not success: kept unresolved, pending confirmation", async () => {
    fake.queueReply({ data: null, error: null, status: 200 });
    const outcome = await pay();
    expect(outcome.error?.name).toBe("PendingConfirmationError");
    expect(await countUnsettledOnlineOperations()).toBe(1);
  });

  it("a reply without the expected shape is not success either", async () => {
    fake.queueReply({ data: { ok: true }, error: null, status: 200 });
    expect((await pay()).error?.name).toBe("PendingConfirmationError");
    expect(await countUnsettledOnlineOperations()).toBe(1);
  });
});

describe("two genuine identical payments", () => {
  // G1 Stage 1 (finding 7): "new" is only possible once the earlier attempt
  // is known not to have happened.
  it("the second one, confirmed as NEW — server WITHOUT 086: refused (the earlier one cannot be confirmed or stopped); nothing new sent", async () => {
    lostReplies();
    await pay();
    answer("new");
    await expect(pay()).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    expect(asked[0]).toMatchObject({ allowNew: true, allowRetry: true });
    expect(new Set(keys()).size).toBe(1);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
  });

  it("the second one, confirmed as NEW — server WITH 086: the earlier one is found applied and recorded; the next identical payment is then simply new", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    lostReplies();
    await pay();
    answer("new");
    await expect(pay()).rejects.toMatchObject({ name: "UnresolvedOperationError", message: expect.stringMatching(/reached the server and has now been recorded/) });
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    const third = await pay();                 // nothing unresolved any more: a genuine new payment
    expect(third.error).toBeNull();
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(2);
  });

  it("is never merged silently: with no answer (no prompt) nothing is sent", async () => {
    lostReplies();
    await pay();
    const before = payments().length;
    await expect(pay()).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    expect(payments()).toHaveLength(before);
  });

  it("after the first one settled, an identical one is simply new (no prompt)", async () => {
    answer("cancel");
    await pay();
    await pay();
    expect(asked).toHaveLength(0);
    expect(new Set(keys()).size).toBe(2);
  });
});

describe("an edited retry after a lost reply", () => {
  it("does not silently become a new operation: the person is asked, and RETRY resends the ORIGINAL unchanged", async () => {
    lostReplies();
    await pay();
    const original = payments()[0].args;
    answer("retry");
    const retried = await pay({ p_notes: "retry after the error" });
    expect(asked).toHaveLength(1);
    expect(retried.error).toBeNull();
    expect(payments().at(-1)!.args).toEqual(original); // frozen arguments, original key
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1); // one payment
    expect(await countUnsettledOnlineOperations()).toBe(0);
  });

  it("or, chosen as new, is a separate payment with its own key — once the earlier one is known not to have happened (086: fenced)", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    fake.queueModes("network-error", "network-error", "network-error");   // never arrived
    await pay();
    answer("new");
    const second = await pay({ p_amount_mmk: 20_000 });
    expect(second.error).toBeNull();
    const ops = fake.callsFor("op_execute").map((c) => c.args.p_key);
    expect(new Set(ops).size).toBe(2);
    expect([...fake.server.idempotency.values()].filter((r) => r.state === "abandoned")).toHaveLength(1);
  });
});

describe("age", () => {
  it("a retry two days later still uses the original key — age never mints a new one", async () => {
    lostReplies();
    await pay();
    answer("retry");
    await pay({}, Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(new Set(keys()).size).toBe(1);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
  });

  it("past the server's key retention it cannot be retried: listed for manual verification instead", async () => {
    lostReplies();
    await pay();
    const later = Date.now() + RETRY_WINDOW_MS + 60_000;
    const [row] = await listUnresolvedOnlineOperations(later);
    expect(row.retryable).toBe(false);
    await expect(retryOnlineOperation(row.id, later)).rejects.toThrow(/Too old to retry safely/);
    answer("retry");
    await expect(pay({}, later)).rejects.toMatchObject({ name: "UnresolvedOperationError" }); // retry not possible
    expect(asked[0].allowRetry).toBe(false); // only "new" or "cancel" are offered
  });
});

describe("restart", () => {
  it("an unresolved payment is listed after a restart and retried unchanged with its key", async () => {
    lostReplies();
    await pay();
    resetOnlineOnlyForTests(); // new app instance
    const list = await listUnresolvedOnlineOperations();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "pay_supplier_lump_sum", mine: true, retryable: true });
    const outcome = await retryOnlineOperation(list[0].id);
    expect(outcome.error).toBeNull();
    expect(new Set(keys()).size).toBe(1);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    expect(await listUnresolvedOnlineOperations()).toHaveLength(0);
  });

  it("another user's unresolved operation is shown but not retryable by this user", async () => {
    lostReplies();
    await pay();
    useAuthStore.setState({ currentUserId: "user-2", currentOrgId: "org-1" });
    const [row] = await listUnresolvedOnlineOperations();
    expect(row.mine).toBe(false);
    await expect(retryOnlineOperation(row.id)).rejects.toThrow(/Only the person who entered it/);
  });

  it("is scoped to the organisation", async () => {
    lostReplies();
    await pay();
    useAuthStore.setState({ currentUserId: "user-1", currentOrgId: "org-2" });
    expect(await listUnresolvedOnlineOperations()).toHaveLength(0);
    await pay(); // no prompt: nothing unresolved in this org
    expect(asked).toHaveLength(0);
  });

  it("the owner can close one after checking the server records", async () => {
    lostReplies();
    await pay();
    const [row] = await listUnresolvedOnlineOperations();
    await expect(markOnlineOperationVerified(row.id)).rejects.toThrow(/Only the owner/);   // a cashier cannot
    useAuthStore.setState({ currentRole: "ADMIN" });
    await markOnlineOperationVerified(row.id);
    useAuthStore.setState({ currentRole: null });
    expect(await listUnresolvedOnlineOperations()).toHaveLength(0);
  });
});

describe("record cleanup failure", () => {
  it("a settlement that cannot be written still counts as settled: the operation is never offered for reuse", async () => {
    const put = vi.spyOn(localDb.syncState, "put");
    let calls = 0;
    put.mockImplementation(((...args: Parameters<typeof localDb.syncState.put>) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("disk full")); // the settle write
      put.mockRestore();
      return localDb.syncState.put(...args);
    }) as typeof localDb.syncState.put);
    const first = await pay();
    expect(first.error).toBeNull();
    put.mockRestore();
    answer("retry");
    await pay();
    expect(asked).toHaveLength(0); // not offered for reuse in this session
    expect(new Set(keys()).size).toBe(2);
  });

  it("if the operation cannot be saved BEFORE sending, it is not sent", async () => {
    const put = vi.spyOn(localDb.syncState, "put").mockRejectedValueOnce(new Error("quota"));
    await expect(pay()).rejects.toThrow(/Not sent: the operation could not be saved/);
    expect(payments()).toHaveLength(0);
    put.mockRestore();
  });
});

describe("operations on one specific record", () => {
  it("the same approval on the same order while unresolved IS the retry (same key, no prompt)", async () => {
    fake.queueModes("commit-then-timeout", "commit-then-timeout", "commit-then-timeout");
    const approve = () => callOnlineOnly("approve_purchase_order", { p_purchase_order_id: "po-1", p_idempotency_key: "x" });
    expect((await approve()).error?.name).toBe("PendingConfirmationError");
    await approve();
    expect(asked).toHaveLength(0);
    expect(new Set(fake.callsFor("approve_purchase_order").map((c) => c.args.p_idempotency_key)).size).toBe(1);
  });

  it("purchase orders and transfers with an unresolved twin also ask before sending", async () => {
    fake.queueModes("commit-then-timeout", "commit-then-timeout", "commit-then-timeout");
    const po = () => callOnlineOnly("create_purchase_order", { p_shop_id: "shop-1", p_supplier_id: "sup-1", p_notes: null, p_items: [] });
    await po();
    await expect(po()).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    fake.queueModes("commit-then-timeout", "commit-then-timeout", "commit-then-timeout");
    const tr = () => callOnlineOnly("create_stock_transfer", { p_from_shop_id: "a", p_to_shop_id: "b", p_notes: null, p_items: [] });
    await tr();
    await expect(tr()).rejects.toMatchObject({ name: "UnresolvedOperationError" });
  });

  it("a double click acts once", async () => {
    const [a, b] = await Promise.all([pay(), pay()]);
    expect(a).toBe(b);
    expect(payments()).toHaveLength(1);
  });
});
