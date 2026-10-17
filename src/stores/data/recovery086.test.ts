import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// G1 Stage 1 / migration 086 — the client recovery protocol against the fake
// server's 086 emulation (testing/fakeSupabase.ts): executor routing and its
// fallback, durable refusals (B2), lookup + fence for operations that were
// never authorised offline (C1), committed-without-reply by verified reload,
// online-only lookup-before-replay, and the one-request-per-attempt rule.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let actingUser = "user-1";
let actingRole = "CASHIER";
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: actingUser, currentOrgId: "org-1", currentRole: actingRole }) } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb, type SyncOutboxEntry } from "../../lib/localDb";
import {
  classifyLegacyQueue, confirmWithServer, countPendingOutbox, drainOutbox, enqueueOutbox, registerOutboxReconciler, restoreSetAsideEntry,
  retryOutboxEntry, setAsideOutboxEntry, simulateNewAppInstanceForTests,
} from "./outbox";
import {
  callRpc, fromExecutorReply, newIdempotencyKey, runRequest, setExecutorCapabilityForTests, executorCapability,
} from "./idempotentRpc";
import { classifyFailure } from "../../lib/failureClass";
import { registerVerifiedReload } from "./verifiedReload";
import { callOnlineOnly, listUnresolvedOnlineOperations, resetOnlineOnlyForTests, retryOnlineOperation, checkOnlineOperation } from "./onlineOnly";
import { pendingStockDeltas } from "./pendingStock";
import { registerOperationPrompt } from "./operationPrompt";

const sale = (n = 1) => ({
  p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0,
  p_items: [{ product_id: "p1", qty: n, units_per_item: 1 }], p_created_at: new Date().toISOString(),
});
// queue order (seq), so [a, b] means "a was queued first"
const rows = async () => (await localDb.syncOutbox.toArray()).sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
const one = async (): Promise<SyncOutboxEntry> => (await rows())[0];
const reconciled: unknown[] = [];

beforeEach(async () => {
  fake.reset();
  actingUser = "user-1";
  actingRole = "CASHIER";
  setExecutorCapabilityForTests("available");
  fake.enableExecutor();
  simulateNewAppInstanceForTests();
  resetOnlineOnlyForTests();
  reconciled.length = 0;
  await Promise.all(localDb.tables.map((t) => t.clear()));
  registerOutboxReconciler("complete_sale", (data) => { reconciled.push(data); });
  registerVerifiedReload(null);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerVerifiedReload(null);
});

describe("operation keys", () => {
  it("are RFC 9562 UUIDv7: version 7, variant 10, the millisecond time in the first 48 bits", () => {
    const t = Date.UTC(2026, 9, 17, 3, 0, 0, 123);
    const key = newIdempotencyKey(t);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(key.replace(/-/g, "").slice(0, 12), 16)).toBe(t);
    expect(new Set(Array.from({ length: 500 }, () => newIdempotencyKey(t))).size).toBe(500);
  });
});

describe("executor routing", () => {
  it("an allow-listed RPC goes through op_execute with the key ONLY in p_key", async () => {
    const out = await callRpc("complete_sale", { ...sale(), p_idempotency_key: newIdempotencyKey() });
    expect(out).toMatchObject({ via: "executor", serverOutcome: "committed", error: null });
    const [call] = fake.callsFor("op_execute");
    expect(call.args.p_rpc).toBe("complete_sale");
    expect(call.args.p_args).not.toHaveProperty("p_idempotency_key");
    expect(fake.callsFor("complete_sale")).toHaveLength(0);
  });

  it("a server WITHOUT 086 (PGRST202): the same attempt goes to the RPC directly, same key; then the capability is remembered", async () => {
    fake.enableExecutor(false);
    setExecutorCapabilityForTests("unknown", false);
    const key = newIdempotencyKey();
    const out = await callRpc("complete_sale", { ...sale(), p_idempotency_key: key });
    expect(out).toMatchObject({ via: "direct", error: null });
    expect(fake.callsFor("op_execute")).toHaveLength(1);
    expect(fake.callsFor("complete_sale").map((c) => c.args.p_idempotency_key)).toEqual([key]);
    expect(executorCapability()).toBe("absent");
    await callRpc("complete_sale", { ...sale(2), p_idempotency_key: newIdempotencyKey() });
    expect(fake.callsFor("op_execute")).toHaveLength(1); // not asked again while remembered
    expect(fake.server.sales).toHaveLength(2);
  });

  it("maps every executor envelope", () => {
    expect(fromExecutorReply("complete_sale", { outcome: "committed", replayed: true, response: { a: 1 } })).toMatchObject({ data: { a: 1 }, error: null, replayed: true });
    expect(fromExecutorReply("complete_sale", { outcome: "committed", response: null, withheld: true })).toMatchObject({ responseUnavailable: "withheld", error: null });
    expect(fromExecutorReply("complete_sale", { outcome: "committed", response: null, response_purged: true })).toMatchObject({ responseUnavailable: "purged" });
    const rejected = fromExecutorReply("complete_sale", { outcome: "rejected", code: "P0001", message: "Insufficient stock" });
    expect(rejected.error?.failure).toMatchObject({ klass: "REJECTED", retryable: false });
    expect(rejected.error?.message).toBe("Insufficient stock");
    expect(fromExecutorReply("complete_sale", { outcome: "abandoned" }).error?.failure.klass).toBe("ABANDONED");
    expect(fromExecutorReply("complete_sale", { outcome: "mismatch" }).error?.failure.klass).toBe("CONTRACT");
    expect(fromExecutorReply("complete_sale", { weird: 1 }).error?.failure).toMatchObject({ klass: "MALFORMED_SUCCESS", mayHaveCommitted: true });
  });

  it("classifies the executor's own refusals (nothing was executed or recorded)", () => {
    expect(classifyFailure({ status: 403, code: "42501", message: "OP_NOT_AUTHENTICATED" }).klass).toBe("AUTH_REAUTH");
    expect(classifyFailure({ status: 400, code: "22023", message: "OP_KEY_OUTSIDE_WINDOW" })).toMatchObject({ klass: "KEY_EXPIRED", retryable: false });
    expect(classifyFailure({ status: 400, code: "22023", message: "OP_UNKNOWN_ARGUMENT: p_x" }).klass).toBe("CONTRACT");
    expect(classifyFailure({ status: 400, code: "P0001", message: "Shift not found", hint: "op_not_recorded:dependency" }).klass).toBe("DEPENDENCY");
    expect(classifyFailure({ status: 400, code: "22023", message: "OP_ACTOR_MISMATCH: this operation belongs to another user" }).klass).toBe("WRONG_ACTOR");
    expect(classifyFailure({ status: 400, code: "P0001", message: "This offline action was queued by a different user", hint: "op_not_recorded:actor" }).klass).toBe("WRONG_ACTOR");
    // refusals the server did NOT record are never final (stabilization H)
    for (const hint of ["op_not_recorded:actor_unverified", "op_not_recorded:unclassified", "op_not_recorded:internal"]) {
      expect(classifyFailure({ status: 400, code: "P0001", message: "Insufficient stock", hint })).toMatchObject({ klass: "NOT_RECORDED", retryable: true, hold: "not-recorded" });
    }
    expect(classifyFailure({ status: 400, code: "22023", message: "OP_EXECUTOR_REQUIRED: this operation must be sent through op_execute" })).toMatchObject({ klass: "TEMPORARY_SERVER", mayHaveCommitted: false });
    expect(classifyFailure({ status: 400, code: "22023", message: "OP_ACTOR_REQUIRED" }).klass).toBe("CONTRACT");
    expect(classifyFailure({ status: 400, code: "P0001", message: "No app user found for this auth identity", hint: "op_not_recorded:auth" }).klass).toBe("AUTH_REAUTH");
  });

  it("each attempt awaits its supabase-js builder exactly once (a lazy builder re-sends on every .then)", async () => {
    let thens = 0;
    const builder = {
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        thens += 1;
        return Promise.resolve({ data: { ok: true }, error: null, status: 200 }).then(onF, onR);
      },
    };
    await runRequest(builder as never, "x");
    expect(thens).toBe(1);
    await callRpc("complete_sale", { ...sale(), p_idempotency_key: newIdempotencyKey() });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("B2: a definitive refusal is final", () => {
  it("drain: the executor records the refusal; the entry becomes a FINAL conflict, its stock effect is released, it is never resent", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(2), shopId: "shop-1" });
    const key = (await one()).idempotencyKey!;
    fake.queueModes("permanent-error");
    expect(await drainOutbox()).toBe("drained");
    expect(await one()).toMatchObject({ status: "conflict", serverOutcome: "rejected", inDoubt: false, idempotencyKey: key });
    expect((await one()).lastError).toMatch(/Refused by the server \(final/);
    expect(fake.server.idempotency.get(key)).toMatchObject({ state: "rejected" });
    expect((await pendingStockDeltas()).size).toBe(0);
    // a person pressing Retry cannot resend it
    await expect(retryOutboxEntry((await one()).localId)).rejects.toThrow(/refused this operation for good/);
    // even a forced resend of the same key is answered from the ledger: rejected, no sale
    const again = await callRpc("complete_sale", { ...sale(2), p_idempotency_key: key });
    expect(again).toMatchObject({ serverOutcome: "rejected", replayed: true });
    expect(fake.server.sales).toHaveLength(0);
    // and the legacy direct path refuses the key too (a UUIDv7 key only runs through op_execute)
    const legacy = await fake.rpc("complete_sale", { ...sale(2), p_idempotency_key: key });
    expect((legacy as { error: { message: string } }).error.message).toMatch(/^OP_EXECUTOR_REQUIRED/);
  });

  it("online-only money operation: refusal settled as refused; a retry is answered from the ledger, nothing executes", async () => {
    fake.queueModes("permanent-error");
    const out = await callOnlineOnly("pay_supplier_lump_sum", { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null });
    expect(out.serverOutcome).toBe("rejected");
    expect(await listUnresolvedOnlineOperations()).toHaveLength(0);
    expect(fake.server.executions.pay_supplier_lump_sum ?? 0).toBe(0);
  });
});

describe("C1: never authorised offline -> asked about, fenced, never resent", () => {
  const heldEntry = async (over: Partial<SyncOutboxEntry> = {}) => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    await localDb.syncOutbox.update(e.localId, { fenceRequired: true, inDoubt: true, writeAhead: true, ...over });
    return (await one());
  };

  it("never delivered: fenced as abandoned by its own actor; final; the delayed request can never execute", async () => {
    const e = await heldEntry();
    expect(await drainOutbox()).toBe("drained");
    expect(fake.callsFor("op_execute")).toHaveLength(0);
    expect(fake.callsFor("op_status")[0].args).toMatchObject({ p_key: e.idempotencyKey, p_fence: true, p_expected_actor_id: "user-1" });
    expect(await one()).toMatchObject({ status: "conflict", serverOutcome: "abandoned" });
    expect((await pendingStockDeltas()).size).toBe(0);
    const late = await callRpc("complete_sale", { ...sale(1), p_idempotency_key: e.idempotencyKey });
    expect(late.serverOutcome).toBe("abandoned");
    expect(fake.server.sales).toHaveLength(0);
  });

  it("committed on the server: reconciled from the lookup's stored reply, exactly once, nothing resent", async () => {
    const e = await heldEntry();
    await fake.rpc("op_execute", { p_key: e.idempotencyKey, p_rpc: "complete_sale", p_args: sale(1), p_actor_id: "user-1" }); // it did arrive
    expect(await drainOutbox()).toBe("drained");
    expect(reconciled).toHaveLength(1);
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("rejected on the server: final conflict with the refusal", async () => {
    const e = await heldEntry();
    fake.queueModes("permanent-error");
    await fake.rpc("op_execute", { p_key: e.idempotencyKey, p_rpc: "complete_sale", p_args: sale(1), p_actor_id: "user-1" });
    await drainOutbox();
    expect(await one()).toMatchObject({ status: "conflict", serverOutcome: "rejected" });
    expect((await one()).lastError).toMatch(/Insufficient stock/);
  });

  it("in flight on the server: parked (asked again later), not sent; later entries WAIT behind it (H2)", async () => {
    const e = await heldEntry();
    fake.queueModes("hang");
    void fake.rpc("op_execute", { p_key: e.idempotencyKey, p_rpc: "complete_sale", p_args: sale(1), p_actor_id: "user-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(3), shopId: "shop-1" });
    expect(await drainOutbox()).toBe("backoff");
    const [held] = (await rows()).filter((r) => r.localId === e.localId);
    expect(held).toMatchObject({ status: "conflict", heldReason: "in-flight", fenceRequired: true });
    expect(fake.callsFor("op_execute").filter((c) => (c.args.p_args as { p_items: { qty: number }[] }).p_items[0].qty === 3)).toHaveLength(0);
    expect(await localDb.syncOutbox.count()).toBe(2);
  });

  it("another cashier's session cannot fence it: parked for the original user or an administrator", async () => {
    await heldEntry();
    actingUser = "user-2";
    fake.setCaller("user-2");
    await drainOutbox();
    expect(await one()).toMatchObject({ status: "conflict", fenceRequired: true });
    expect(fake.callsFor("op_status")).toHaveLength(0);              // not even asked in another cashier's session
    expect(fake.server.idempotency.size).toBe(0);
    // an administrator can (server-authorized)
    actingUser = "admin-1";
    actingRole = "ADMIN";
    fake.setCaller("admin-1", true);
    await localDb.syncOutbox.update((await one()).localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect(await one()).toMatchObject({ serverOutcome: "abandoned" });
  });

  it("server WITHOUT 086: held with the 'not recorded on this till' warning; never sent; later entries wait until an owner sets it aside", async () => {
    fake.enableExecutor(false);
    setExecutorCapabilityForTests("absent", false);
    const e = await heldEntry();
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(4), shopId: "shop-1" });
    expect(await drainOutbox()).toBe("backoff");
    const held = (await rows()).find((r) => r.localId === e.localId)!;
    expect(held).toMatchObject({ heldReason: "needs-server-086", fenceRequired: true, status: "conflict" });
    expect(held.lastError).toMatch(/NOT recorded on this till/);
    expect(fake.server.sales).toHaveLength(0);
    expect(fake.callsFor("complete_sale")).toHaveLength(0);
    // the owner sets it aside (keeps it, exported): the rest of the queue continues
    actingRole = "ADMIN";
    await setAsideOutboxEntry(e.localId, { wasExported: () => true });
    actingRole = "CASHIER";
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
    expect((await localDb.syncOutbox.get(e.localId))!.status).toBe("archived");
  });

  it("a stranded first online attempt (crash) becomes fenceRequired on restart; a stranded RESEND of a staged entry does not", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(2), shopId: "shop-1" });
    const [a, b] = await rows();
    await localDb.syncOutbox.update(a.localId, { status: "syncing", writeAhead: true, attempts: 0, syncingSince: new Date(0).toISOString() });
    await localDb.syncOutbox.update(b.localId, { status: "syncing", writeAhead: true, staged: true, attempts: 1, syncingSince: new Date(0).toISOString() });
    fake.enableExecutor(false);
    setExecutorCapabilityForTests("absent", false);
    await drainOutbox();
    const after = new Map((await rows()).map((r) => [r.localId, r]));
    expect(after.get(a.localId)).toMatchObject({ fenceRequired: true, heldReason: "needs-server-086" });
    // b is authorised (staged) and goes back to the queue — but waits behind a (H2)
    expect(after.get(b.localId)).toMatchObject({ status: "pending", staged: true });
    expect(after.get(b.localId)!.fenceRequired).not.toBe(true);
  });
});

describe("committed, reply not readable here (another user's / purged)", () => {
  it("verified reload: kept in doubt until a full server reload succeeds, then acknowledged once", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    // committed earlier (reply lost); its stored reply has since been purged
    await fake.rpc("op_execute", { p_key: e.idempotencyKey, p_rpc: "complete_sale", p_args: sale(1), p_actor_id: "user-1" });
    fake.purgeResponse(e.idempotencyKey!);
    let reloads = 0;
    let reloadOk = false;
    registerVerifiedReload(async () => { reloads += 1; return reloadOk; });
    expect(await drainOutbox()).toBe("network");
    expect(await one()).toMatchObject({ status: "pending", inDoubt: true, heldReason: "committed-verifying" });
    expect(reconciled).toHaveLength(0);
    reloadOk = true;
    await localDb.syncOutbox.update(e.localId, { nextAttemptAt: undefined });
    expect(await drainOutbox()).toBe("drained");
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(reloads).toBeGreaterThanOrEqual(2);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("an entry later entries depend on is parked for someone who can read the reply", async () => {
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-1", p_opening_cash_mmk: 0 }, shopId: "shop-1", provisional: [{ table: "shifts", ids: ["shift-local"] }] });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1", refs: [{ field: "p_shift_id", provisionalId: "shift-local" }] });
    const os = (await rows()).find((r) => r.name === "open_shift")!;
    await fake.rpc("op_execute", { p_key: os.idempotencyKey, p_rpc: "open_shift", p_args: { p_shop_id: "shop-1", p_opening_cash_mmk: 0, p_expected_actor_id: "user-1" }, p_actor_id: "user-1" });
    fake.purgeResponse(os.idempotencyKey!);
    registerVerifiedReload(async () => true);
    // a later entry with no ref: it waits too — it may depend on the waiting
    // one without a ref (strict order, stabilization H)
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(7), shopId: "shop-1" });
    await drainOutbox();
    const held = (await rows()).find((r) => r.localId === os.localId);
    expect(held).toMatchObject({ heldReason: "committed-reply-unavailable" });
    const dependent = (await rows()).find((r) => r.refs?.length);
    expect(dependent).toMatchObject({ status: "pending" });                       // still waits on its ref
    expect(fake.server.sales.some((x) => x.idempotencyKey === dependent!.idempotencyKey)).toBe(false);
    expect(fake.server.sales).toHaveLength(0);                                     // the later sale did NOT overtake it
    expect((await rows()).find((r) => (r.args?.p_items as { qty: number }[] | undefined)?.[0]?.qty === 7)).toMatchObject({ status: "pending" });
  });
});

describe("online-only: lookup before replay", () => {
  it("an unknown outcome that DID commit: Check settles it as applied without sending anything", async () => {
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    const args = { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
    const first = await callOnlineOnly("pay_supplier_lump_sum", args);
    expect(first.error?.name).toBe("PendingConfirmationError");
    const [op] = await listUnresolvedOnlineOperations();
    const executes = fake.callsFor("op_execute").length;
    const checked = await checkOnlineOperation(op.id);
    expect(checked.status?.status).toBe("committed");
    expect(fake.callsFor("op_execute")).toHaveLength(executes);
    expect(await listUnresolvedOnlineOperations()).toHaveLength(0);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
  });

  it("retry: a decided key is answered from the ledger (one request, no retries); an undecided one is sent", async () => {
    fake.queueModes("network-error", "network-error", "network-error");
    const args = { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 500, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
    const first = await callOnlineOnly("pay_supplier_lump_sum", args);
    expect(first.error).toBeTruthy();
    const ops = await listUnresolvedOnlineOperations();
    if (ops.length) {
      const out = await retryOnlineOperation(ops[0].id);
      expect(out.error).toBeNull();
      expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    }
  });
});

describe("correction pass: the review findings", () => {
  it("1: an operation is sent only in its creator's session; another user's drain parks it (nothing runs, nothing recorded); work that may depend on it waits behind it", async () => {
    // user-1 restocked p1; user-2 then sold p1 (it may depend on the restock)
    await enqueueOutbox({ kind: "rpc", name: "adjust_stock", args: { p_shop_id: "shop-1", p_product_id: "p1", p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 5, p_reason: "x" }, shopId: "shop-1" });
    actingUser = "user-2";
    fake.setCaller("user-2");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(2), shopId: "shop-1" }); // by user-2
    await drainOutbox();
    const mine = (await rows()).find((r) => r.actorId === "user-1");
    expect(mine).toMatchObject({ status: "pending", heldReason: "needs-original-user" });
    expect(fake.callsFor("op_execute")).toHaveLength(0);            // the dependent sale does not overtake it
    expect(fake.server.sales).toHaveLength(0);
    expect(fake.server.idempotency.get(mine!.idempotencyKey!)).toBeUndefined();
    // the server refuses a mismatched actor anyway (nothing runs or is recorded)
    const forced = await callRpc("adjust_stock", { ...(mine!.args as Record<string, unknown>) }, { actorId: "user-1" });
    expect(forced.error?.failure.klass).toBe("WRONG_ACTOR");
    expect(fake.server.idempotency.get(mine!.idempotencyKey!)).toBeUndefined();
    // back to user-1: it is sent and committed
    actingUser = "user-1";
    fake.setCaller("user-1");
    await localDb.syncOutbox.update(mine!.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(0);                      // user-1's restock went; user-2's sale waits for user-2
    expect((await rows()).find((r) => r.actorId === "user-1")).toBeUndefined();
    expect((await rows()).find((r) => r.actorId === "user-2")).toMatchObject({ heldReason: "needs-original-user" });
    actingUser = "user-2";
    fake.setCaller("user-2");
    for (const r of await rows()) await localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);
    // each operation ran only in its own creator's session
    for (const c of fake.callsFor("op_execute")) {
      expect(c.args.p_actor_id).toBe(c.args.p_rpc === "adjust_stock" ? "user-1" : "user-2");
    }
  });

  it("2: a dependency refusal is never final: parked (not a conflict), not recorded, retried with the same key", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    fake.queueModes("dependency-error");
    expect(await drainOutbox()).toBe("backoff");   // later entries may depend on it
    expect(await one()).toMatchObject({ status: "pending", heldReason: "dependency" });
    expect(fake.server.idempotency.get(e.idempotencyKey!)).toBeUndefined();
    await localDb.syncOutbox.update(e.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("3: downgrade safety — a held operation is stored as 'conflict' (no older build sends it automatically) and its UUIDv7 key is refused on the legacy path", async () => {
    fake.enableExecutor(false);
    setExecutorCapabilityForTests("absent", false);
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    await localDb.syncOutbox.update(e.localId, { fenceRequired: true, inDoubt: true, writeAhead: true, staged: false, status: "conflict" });
    await drainOutbox();
    const held = await one();
    expect(held.status).toBe("conflict");                     // older drains read anyOf("pending", "failed") only
    fake.enableExecutor(true);                                // the server has 086
    const legacy = await fake.rpc("complete_sale", held.args as Record<string, unknown>);
    expect((legacy as { error: { message: string } }).error.message).toMatch(/^OP_EXECUTOR_REQUIRED/);
    expect(fake.server.sales).toHaveLength(0);
  });

  it("4: legacy queue rows — an older build's write-ahead row in doubt with nothing staged is held (fenced, never resent); queued offline rows stay sendable", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { ...sale(2), p_idempotency_key: randomUUIDv4() }, shopId: "shop-1" });
    const all = await rows();
    const a = all.find((r) => (r.args?.p_items as { qty: number }[])[0].qty === 1)!;
    const b = all.find((r) => (r.args?.p_items as { qty: number }[])[0].qty === 2)!;
    // as Batch 2A wrote them: no staged / fenceRequired / actorId fields
    await localDb.syncOutbox.update(a.localId, { writeAhead: true, inDoubt: true, attempts: 1, staged: undefined, actorId: undefined });
    await localDb.syncOutbox.update(b.localId, { staged: undefined, actorId: undefined });
    await drainOutbox();
    const after = new Map((await rows()).map((r) => [r.localId, r]));
    expect(after.get(a.localId)).toMatchObject({ fenceRequired: true, status: "conflict" });
    expect(fake.callsFor("op_execute").some((c) => c.args.p_key === a.idempotencyKey)).toBe(false);
    // queued offline: authorised (staged) — but it waits behind the held one (H2)
    expect(after.get(b.localId)).toMatchObject({ status: "pending", staged: true });
    expect(fake.server.sales).toHaveLength(0);
  });

  it("5: no recorded actor — a cashier cannot resolve it; an ADMIN can, with the operation's own arguments as server-side evidence", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    await localDb.syncOutbox.update(e.localId, { actorId: undefined, fenceRequired: true, staged: false, status: "conflict", inDoubt: true });
    await drainOutbox();
    expect(await one()).toMatchObject({ heldReason: "needs-administrator", status: "conflict" });
    fake.setCaller("admin-1", true);
    actingUser = "admin-1";
    await localDb.syncOutbox.update(e.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect(await one()).toMatchObject({ serverOutcome: "abandoned" });
    const fenceCall = fake.callsFor("op_status").at(-1)!;
    expect(fenceCall.args).toMatchObject({ p_fence: true, p_expected_actor_id: null });
    expect(fenceCall.args.p_args).toMatchObject({ p_shop_id: "shop-1" });
    expect(fenceCall.args.p_args).not.toHaveProperty("p_idempotency_key");
  });

  it("7: a replacement is refused while the earlier attempt is undecided; allowed once it is fenced; and when it DID commit it is recorded instead", async () => {
    const { settleBeforeReplacement } = await import("./outbox");
    // (a) server WITHOUT 086: cannot decide -> blocked, identity kept
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const a = await one();
    await localDb.syncOutbox.update(a.localId, { inDoubt: true, writeAhead: true });
    fake.enableExecutor(false);
    setExecutorCapabilityForTests("absent", false);
    expect(await settleBeforeReplacement([a.localId])).toBe("blocked");
    expect(await one()).toMatchObject({ idempotencyKey: a.idempotencyKey, status: "pending" });
    // (b) 086, never arrived -> fenced (abandoned), replacement allowed
    fake.enableExecutor(true);
    setExecutorCapabilityForTests("available");
    expect(await settleBeforeReplacement([a.localId])).toBe("proceed");
    expect(await one()).toMatchObject({ serverOutcome: "abandoned" });
    expect(fake.server.idempotency.get(a.idempotencyKey!)).toMatchObject({ state: "abandoned" });
    // (c) 086, it DID commit -> reconciled; the caller must not create a new one
    await localDb.syncOutbox.clear();
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(3), shopId: "shop-1" });
    const c = await one();
    await fake.rpc("op_execute", { p_key: c.idempotencyKey, p_rpc: "complete_sale", p_args: sale(3), p_actor_id: "user-1" });
    expect(await settleBeforeReplacement([c.localId])).toBe("committed");
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(reconciled).toHaveLength(1);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("schema-cache lag: op_execute answering 42883 counts as 'absent' (nothing ran) and the legacy path is used", async () => {
    setExecutorCapabilityForTests("unknown", false);
    fake.queueReply({ data: null, status: 404, error: { code: "42883", message: "function public.op_execute(p_actor_id => text, p_args => jsonb, p_key => uuid, p_rpc => text) does not exist", details: null, hint: null } });
    fake.enableExecutor(false);
    const out = await callRpc("complete_sale", { ...sale(1), p_idempotency_key: newIdempotencyKey() });
    expect(out).toMatchObject({ via: "direct", error: null });
    expect(fake.server.sales).toHaveLength(1);
  });

  it("OP_EXECUTOR_REQUIRED from the legacy path (stale 'absent'): retried through op_execute in the same attempt, once", async () => {
    setExecutorCapabilityForTests("absent", false);
    const key = newIdempotencyKey();
    const out = await callRpc("complete_sale", { ...sale(1), p_idempotency_key: key });
    expect(out).toMatchObject({ via: "executor", serverOutcome: "committed", error: null });
    expect(fake.callsFor("complete_sale")).toHaveLength(1);   // refused, nothing ran
    expect(fake.server.sales).toHaveLength(1);
  });
});

function randomUUIDv4(): string {
  return crypto.randomUUID();
}

// =================== stabilization pass: ordering (H2) and MEDIUM M1–M5 ===
describe("stabilization pass", () => {
  const close = { p_shift_id: "shift-1", p_closing_cash_mmk: 5000 };
  const sent = (rpc: string) => fake.callsFor("op_execute").filter((c) => c.args.p_rpc === rpc);
  const undecidedHeld = async (localId: string) => localDb.syncOutbox.update(localId, {
    status: "conflict", fenceRequired: true, inDoubt: true, writeAhead: true, staged: false,
  });

  it("H2 restock -> sale: the manager's restock heads the queue in the cashier's session; the sale is NOT sent ahead of it", async () => {
    actingUser = "mgr-1";
    fake.setCaller("mgr-1");
    await enqueueOutbox({ kind: "rpc", name: "adjust_stock", args: { p_shop_id: "shop-1", p_product_id: "p1", p_adjustment_type: "RESTOCK", p_quantity_delta: 5, p_reason: "delivery" }, shopId: "shop-1" });
    actingUser = "user-1";
    fake.setCaller("user-1");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(3), shopId: "shop-1" });
    expect(await drainOutbox()).toBe("backoff");
    expect(fake.callsFor("op_execute")).toHaveLength(0);
    // the manager signs in: restock first, then (back as the cashier) the sale
    actingUser = "mgr-1";
    fake.setCaller("mgr-1");
    for (const r of await rows()) await localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    actingUser = "user-1";
    fake.setCaller("user-1");
    for (const r of await rows()) await localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect(fake.callsFor("op_execute").map((c) => c.args.p_rpc)).toEqual(["adjust_stock", "complete_sale"]);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("H2 sale -> close_shift: a sale refused for a missing prerequisite (dependency) keeps the close behind it", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: close, shopId: "shop-1" });
    fake.queueModes("dependency-error");
    expect(await drainOutbox()).toBe("backoff");
    expect(sent("close_shift")).toHaveLength(0);
    for (const r of await rows()) await localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect(fake.callsFor("op_execute").map((c) => c.args.p_rpc)).toEqual(["complete_sale", "complete_sale", "close_shift"]);
  });

  it("H2 sale -> close_shift: an UNDECIDED held sale (still running on the server) keeps the close behind it; once decided, the close follows", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: close, shopId: "shop-1" });
    const s1 = (await rows()).find((r) => r.name === "complete_sale")!;
    await undecidedHeld(s1.localId);
    fake.queueModes("hang");
    void fake.rpc("op_execute", { p_key: s1.idempotencyKey, p_rpc: "complete_sale", p_args: sale(1), p_actor_id: "user-1" });
    expect(await drainOutbox()).toBe("backoff");
    expect(sent("close_shift")).toHaveLength(0);
    fake.releaseExecuting();
    for (const r of await rows()) await localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect((await localDb.syncOutbox.get(s1.localId))).toMatchObject({ serverOutcome: "abandoned" });
    expect(sent("close_shift")).toHaveLength(1);
  });

  it("H2: another user's held entry blocks; an owner setting it aside releases the queue (stock decrease kept, M2)", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(2), shopId: "shop-1" });
    const e = await one();
    await undecidedHeld(e.localId);
    actingUser = "user-2";
    fake.setCaller("user-2");
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: close, shopId: "shop-1" });
    expect(await drainOutbox()).toBe("backoff");
    expect(fake.callsFor("op_execute")).toHaveLength(0);
    expect(fake.server.idempotency.size).toBe(0);                               // a cashier cannot fence another's entry
    actingUser = "admin-1";
    actingRole = "ADMIN";
    await setAsideOutboxEntry(e.localId, { wasExported: () => true });
    // M2: set aside but undecided -> its decrease still counts
    expect([...(await pendingStockDeltas()).values()]).toEqual([-2]);
    actingUser = "user-2";
    actingRole = "CASHIER";
    expect(await drainOutbox()).toBe("drained");
    expect(sent("close_shift")).toHaveLength(1);
  });

  it("M1: a credential refresh on a held entry never moves it to 'pending' (downgrade-safe)", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    await undecidedHeld(e.localId);
    fake.queueModes("jwt-expired", "jwt-expired", "jwt-expired");
    await drainOutbox();
    const after = (await localDb.syncOutbox.get(e.localId))!;
    expect(after).toMatchObject({ status: "conflict", fenceRequired: true });
    expect(sent("complete_sale")).toHaveLength(0);
  });

  it("M2: set aside AFTER the server fenced it -> no decrease; set aside undecided -> decrease kept", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(2), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(5), shopId: "shop-1" });
    const [a, b] = await rows();
    await localDb.syncOutbox.update(a.localId, { status: "archived", statusBeforeArchive: "conflict", serverOutcome: "abandoned", fenceRequired: true });
    await localDb.syncOutbox.update(b.localId, { status: "archived", statusBeforeArchive: "conflict", fenceRequired: true, inDoubt: true });
    expect([...(await pendingStockDeltas()).values()]).toEqual([-5]);
  });

  it("M3: 'Confirm with server' on a set-aside undecided entry fences it (abandoned) and keeps it set aside; a committed one is recorded", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(2), shopId: "shop-1" });
    const [a, b] = await rows();
    for (const r of [a, b]) await localDb.syncOutbox.update(r.localId, { status: "archived", statusBeforeArchive: "syncing", inDoubt: true, writeAhead: true });
    await fake.rpc("op_execute", { p_key: b.idempotencyKey, p_rpc: "complete_sale", p_args: sale(2), p_actor_id: "user-1" });
    expect(await confirmWithServer(a.localId)).toBe("abandoned");
    expect(await localDb.syncOutbox.get(a.localId)).toMatchObject({ status: "archived", serverOutcome: "abandoned" });
    expect(fake.server.idempotency.get(a.idempotencyKey!)).toMatchObject({ state: "abandoned" });
    expect(await confirmWithServer(b.localId)).toBe("committed");
    expect(await localDb.syncOutbox.get(b.localId)).toBeUndefined();
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.callsFor("op_execute").filter((c) => c.args.p_key === a.idempotencyKey)).toHaveLength(0);
  });

  it("M4: a Batch 2A close_shift staged offline (its key on the local shift row) is proven staged; one without that evidence is held", async () => {
    const k1 = "11111111-1111-4111-8111-111111111111";
    const k2 = "22222222-2222-4222-8222-222222222222";
    await localDb.shifts.bulkPut([
      { id: "shift-a", shopId: "shop-1", cashierId: "user-1", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), openingCashMmk: 0, idempotencyKey: k1, pendingSync: true },
      { id: "shift-b", shopId: "shop-1", cashierId: "user-1", startedAt: new Date().toISOString(), openingCashMmk: 0 },
    ] as never);
    const base = { kind: "rpc" as const, name: "close_shift", shopId: "shop-1", status: "pending" as const, attempts: 1, writeAhead: true, inDoubt: true, createdAt: new Date().toISOString() };
    await localDb.syncOutbox.bulkPut([
      { ...base, localId: "l-a", seq: 1, idempotencyKey: k1, args: { p_shift_id: "shift-a", p_closing_cash_mmk: 0, p_idempotency_key: k1 } },
      { ...base, localId: "l-b", seq: 2, idempotencyKey: k2, args: { p_shift_id: "shift-b", p_closing_cash_mmk: 0, p_idempotency_key: k2 } },
    ] as never);
    expect(await classifyLegacyQueue()).toBe(1);
    expect(await localDb.syncOutbox.get("l-a")).toMatchObject({ staged: true, status: "pending" });
    expect(await localDb.syncOutbox.get("l-b")).toMatchObject({ fenceRequired: true, status: "conflict" });
  });

  it("M5: held entries count as pending work (the periodic drain keeps asking)", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    await undecidedHeld(e.localId);
    expect(await countPendingOutbox()).toBe(1);
    await localDb.syncOutbox.update(e.localId, { serverOutcome: "abandoned" });
    expect(await countPendingOutbox()).toBe(0);
  });

  it("keyless legacy entry: given a legacy (v4) key, never a UUIDv7 one", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    const { p_idempotency_key: _drop, ...args } = e.args as Record<string, unknown>;
    void _drop;
    await localDb.syncOutbox.put({ ...e, idempotencyKey: undefined, actorId: undefined, args });
    await drainOutbox();
    const key = fake.callsFor("op_execute")[0]?.args.p_key ?? fake.callsFor("complete_sale")[0]?.args.p_idempotency_key;
    expect(String(key)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });

  it("OP_RPC_DISABLED is a wait-for-the-server hold, never a final refusal", () => {
    const f = classifyFailure({ status: 403, code: "42501", message: "OP_RPC_DISABLED: complete_sale" });
    expect(f).toMatchObject({ klass: "WAITING_BACKEND", retryable: true, mayHaveCommitted: false });
  });
});

// ============ final financial-safety pass: blockers C, D, E, H =============
describe("final pass", () => {
  const pay = (amount = 1000) => callOnlineOnly("pay_supplier_lump_sum", { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: amount, p_payment_method: "CASH", p_reference_no: null, p_notes: null });
  const NOT_RECORDED = { data: null, status: 400, error: { code: "22012", message: "division by zero", details: null, hint: "op_not_recorded:unclassified" } };

  it("C: a payment whose reply was lost and whose retries then get 401 is NEVER 'not applied': kept unresolved; a replacement is refused because the server shows it committed", async () => {
    fake.queueModes("commit-then-timeout", "jwt-expired", "jwt-expired");
    const first = await pay();
    expect(first.error?.name).toBe("PendingConfirmationError");
    expect(first.error?.failure.mayHaveCommitted).toBe(true);
    const [op] = await listUnresolvedOnlineOperations();
    expect(op).toBeTruthy();
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    // "a separate new one": the earlier one is settled with the server first
    registerOperationPrompt(async () => "new");
    await expect(pay()).rejects.toThrow(/reached the server and has now been recorded/);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);               // one payment, never two
  });

  it("C: the same on a server WITHOUT 086 — across a restart, a later 401 still does not settle it; a replacement is blocked (no fence exists)", async () => {
    fake.enableExecutor(false);
    setExecutorCapabilityForTests("absent", false);
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    expect((await pay()).error?.name).toBe("PendingConfirmationError");
    resetOnlineOnlyForTests();                                                   // restart
    const [op] = await listUnresolvedOnlineOperations();
    fake.queueModes("jwt-expired", "jwt-expired", "jwt-expired", "jwt-expired", "jwt-expired");   // the lookup + every attempt
    const retried = await retryOnlineOperation(op.id);
    expect(retried.error?.name).toBe("PendingConfirmationError");                // still unknown, not "not applied"
    expect(await listUnresolvedOnlineOperations()).toHaveLength(1);
    registerOperationPrompt(async () => "new");
    await expect(pay()).rejects.toThrow(/could not be confirmed or stopped/);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
  });

  it("C: a void of a supplier payment (lost reply, then network errors) is retried only with its own key — replayed, applied once", async () => {
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    const v = () => callOnlineOnly("void_supplier_payment", { p_payment_id: "pay-1", p_reason: "wrong amount" });
    expect((await v()).error?.name).toBe("PendingConfirmationError");
    const again = await v();                                                     // the same call on the same record IS the retry
    expect(again.error).toBeNull();
    expect(fake.server.executions.void_supplier_payment).toBe(1);
    const keys = new Set(fake.callsFor("op_execute").filter((c) => c.args.p_rpc === "void_supplier_payment").map((c) => c.args.p_key));
    expect(keys.size).toBe(1);
  });

  it("C/H: a money operation never overtakes an unsent entry it may depend on (a payment behind a queued receipt)", async () => {
    await enqueueOutbox({ kind: "rpc", name: "receive_purchase_order", args: { p_purchase_order_id: "po-1", p_received_items: null }, shopId: "shop-1" });
    fake.setDefaultMode("network-error");                                        // the queue cannot drain
    await expect(pay()).rejects.toThrow(/must not overtake/);
    fake.setDefaultMode("succeed");
    expect(fake.server.executions.pay_supplier_lump_sum ?? 0).toBe(0);
  });

  it("D: the 24 h dependency timer starts at the FIRST dependency refusal, and the converted conflict keeps blocking later entries", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: { p_shift_id: "shift-1", p_closing_cash_mmk: 0 }, shopId: "shop-1" });
    const [s1] = await rows();
    await localDb.syncOutbox.update(s1.localId, { createdAt: new Date(Date.now() - 72 * 3_600_000).toISOString() }); // queued 3 days ago (offline)
    fake.queueModes("dependency-error");
    expect(await drainOutbox()).toBe("backoff");
    const parked = (await localDb.syncOutbox.get(s1.localId))!;
    expect(parked).toMatchObject({ status: "pending", heldReason: "dependency" });   // grace period, not a conflict
    expect(Date.now() - Date.parse(parked.dependencySince!)).toBeLessThan(60_000);
    await localDb.syncOutbox.update(s1.localId, { dependencySince: new Date(Date.now() - 25 * 3_600_000).toISOString(), nextAttemptAt: undefined });
    fake.queueModes("dependency-error");
    expect(await drainOutbox()).toBe("backoff");
    expect(await localDb.syncOutbox.get(s1.localId)).toMatchObject({ status: "conflict", blocksQueue: true });
    expect(await drainOutbox()).toBe("backoff");                                  // still blocking
    expect(fake.callsFor("op_execute").filter((c) => c.args.p_rpc === "close_shift")).toHaveLength(0);
    expect([...(await pendingStockDeltas()).values()]).toEqual([-1]);             // its decrease stays reserved
  });

  it("E: restoring a set-aside entry that was being sent (never authorised offline) brings it back HELD: looked up and fenced, never resent", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    await localDb.syncOutbox.update(e.localId, { status: "archived", statusBeforeArchive: "syncing", writeAhead: true, staged: false, archivedAt: new Date().toISOString() });
    actingRole = "ADMIN";
    const restored = await restoreSetAsideEntry(e.localId);
    actingRole = "CASHIER";
    expect(restored).toMatchObject({ status: "conflict", fenceRequired: true, inDoubt: true });
    await drainOutbox();
    expect(fake.callsFor("op_execute").filter((c) => c.args.p_key === e.idempotencyKey)).toHaveLength(0);
    expect(fake.callsFor("op_status").at(-1)?.args).toMatchObject({ p_key: e.idempotencyKey, p_fence: true });
    expect(await one()).toMatchObject({ serverOutcome: "abandoned" });
  });

  it("E: a restored set-aside entry that WAS authorised offline (staged) comes back in doubt and is resent only with its own key (replayed if committed)", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(1), shopId: "shop-1" });
    const e = await one();
    await fake.rpc("op_execute", { p_key: e.idempotencyKey, p_rpc: "complete_sale", p_args: sale(1), p_actor_id: "user-1" });  // it did commit
    await localDb.syncOutbox.update(e.localId, { status: "archived", statusBeforeArchive: "syncing", staged: true, archivedAt: new Date().toISOString() });
    actingRole = "ADMIN";
    const restored = await restoreSetAsideEntry(e.localId);
    actingRole = "CASHIER";
    expect(restored).toMatchObject({ status: "pending", inDoubt: true, staged: true });
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);                                    // replayed, not re-executed
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("H: a refusal the server did NOT record is never final — held at the head of the queue, retried, its stock kept reserved", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(2), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(3), shopId: "shop-1" });
    fake.queueReply(NOT_RECORDED);
    expect(await drainOutbox()).toBe("backoff");
    const [a, b] = await rows();
    expect(a).toMatchObject({ status: "pending", heldReason: "not-recorded" });
    expect(a.serverOutcome).toBeUndefined();
    expect(b.status).toBe("pending");
    expect(fake.callsFor("op_execute")).toHaveLength(1);
    expect(fake.server.idempotency.get(a.idempotencyKey!)).toBeUndefined();
    await localDb.syncOutbox.update(a.localId, { nextAttemptAt: undefined });
    expect(await drainOutbox()).toBe("drained");                                   // the same key later commits once
    expect(fake.server.sales).toHaveLength(2);
  });

  it("H: a FUTURE-dated key refused as outside the window is held (never final); a key too OLD is final and does not block", async () => {
    const future = newIdempotencyKey(Date.now() + 40 * 864e5);
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { ...sale(1), p_idempotency_key: future }, shopId: "shop-1" });
    fake.queueReply({ data: null, status: 400, error: { code: "22023", message: "OP_KEY_OUTSIDE_WINDOW", details: null, hint: null } });
    expect(await drainOutbox()).toBe("backoff");
    expect(await one()).toMatchObject({ status: "pending", heldReason: "future-key" });
    await localDb.syncOutbox.clear();
    const old = newIdempotencyKey(Date.now() - 400 * 864e5);
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { ...sale(1), p_idempotency_key: old }, shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(2), shopId: "shop-1" });
    fake.queueReply({ data: null, status: 400, error: { code: "22023", message: "OP_KEY_OUTSIDE_WINDOW", details: null, hint: null } });
    expect(await drainOutbox()).toBe("drained");
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "conflict", failureKind: "permanent" });
    expect(after[0].blocksQueue).toBeUndefined();
  });

  it("H: an in-doubt CONFLICT keeps its decrease reserved", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(4), shopId: "shop-1" });
    const e = await one();
    await localDb.syncOutbox.update(e.localId, { status: "conflict", inDoubt: true, failureKind: "permanent" });
    expect([...(await pendingStockDeltas()).values()]).toEqual([-4]);
  });
});
