import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Migration 086 — final ordering and recovery pass. Deterministic
// reproductions of the review-snapshot-5 findings (they FAIL on that code and
// pass after the fix), through public APIs:
//   H1  a close keyed by the shift's SERVER id overtakes the shift's sales
//       still queued under its offline id;
//   M   payment Retry race: a stale attempt's "not applied" overwrites the
//       outcome of a newer attempt (deterministic interleavings — replies are
//       released by the test, no sleeps);
//   M   close vs void/refund approval; open after a manager's close;
//       negative unit adjustment classified as an increase.
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
import { localDb } from "../../lib/localDb";
import {
  blockingEarlierWork, drainOutbox, enqueueOutbox, recordIdMapping, registerOutboxReconciler, simulateNewAppInstanceForTests,
} from "./outbox";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { registerVerifiedReload } from "./verifiedReload";
import { callOnlineOnly, listUnresolvedOnlineOperations, resetOnlineOnlyForTests, retryOnlineOperation } from "./onlineOnly";
import { registerOperationPrompt } from "./operationPrompt";

const as = (user: string, role = "CASHIER") => { actingUser = user; actingRole = role; fake.setCaller(user, role === "ADMIN"); };
const sale = (shift: string, product = "p1") => ({
  p_shop_id: "shop-1", p_shift_id: shift, p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0,
  p_items: [{ product_id: product, qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString(),
});
const payArgs = { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
const NO_UPSTREAM = { data: null, status: 503, error: { message: "no healthy upstream", code: "", details: "", hint: "" } };
const TIMEOUT = { data: null, status: 504, error: { message: "<html>504 Gateway Time-out</html>", code: "", details: "", hint: "" } };
/** A reply the test releases when it chooses (deterministic interleaving). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const storedOp = async (id: string) => JSON.parse((await localDb.syncState.get(`online-op:${id}`))!.value!);

beforeEach(async () => {
  fake.reset();
  as("user-1");
  setExecutorCapabilityForTests("available");
  fake.enableExecutor();
  simulateNewAppInstanceForTests();
  resetOnlineOnlyForTests();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  registerOutboxReconciler("complete_sale", () => undefined);
  registerOutboxReconciler("open_shift", () => undefined);
  registerVerifiedReload(null);
  registerOperationPrompt(async () => "new");
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

describe("H1: an offline shift id and its server id are the same shift for ordering", () => {
  it("sales queued under the OFFLINE shift id block a close made with the SERVER id (after the open synced)", async () => {
    // opened offline: the sales reference the offline id
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-1", p_opening_cash_mmk: 0 }, shopId: "shop-1", provisional: [{ table: "shifts", ids: ["shift-local-1"] }] });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("shift-local-1"), shopId: "shop-1", refs: [{ field: "p_shift_id", provisionalId: "shift-local-1" }] });
    // the open synced: its verified mapping exists, the sale is still queued
    const open = (await localDb.syncOutbox.toArray()).find((r) => r.name === "open_shift")!;
    await localDb.syncOutbox.delete(open.localId);
    await recordIdMapping("shift-local-1", "shift-server-9");
    const close = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-server-9" }, shopId: "shop-1", actorId: "user-1" };
    const blocking = await blockingEarlierWork(close);
    expect(blocking.map((r) => r.name)).toEqual(["complete_sale"]);
  });

  it("an offline shift id with NO mapping yet, whose open was SENT (outcome unknown), blocks every close (it may be that shift)", async () => {
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-1", p_opening_cash_mmk: 0 }, shopId: "shop-1", provisional: [{ table: "shifts", ids: ["shift-local-2"] }] });
    const sentOpen = (await localDb.syncOutbox.toArray()).find((r) => r.name === "open_shift")!;
    await localDb.syncOutbox.update(sentOpen.localId, { sentAt: new Date().toISOString(), inDoubt: true, attempts: 1 });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("shift-local-2"), shopId: "shop-1", refs: [{ field: "p_shift_id", provisionalId: "shift-local-2" }] });
    const close = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-server-77" }, shopId: "shop-1", actorId: "user-1" };
    expect((await blockingEarlierWork(close)).map((r) => r.name)).toContain("complete_sale");
  });
});

describe("payment Retry race (deterministic interleavings)", () => {
  it("a first attempt still in flight answers 'not delivered' AFTER a Retry committed: the committed outcome stands (never overwritten)", async () => {
    const first = deferred<unknown>();
    fake.queueReply(first.promise as unknown as Record<string, unknown>);          // attempt A: reply held by the test
    const a = callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    await vi.waitFor(async () => expect(await listUnresolvedOnlineOperations()).toHaveLength(1));
    const [op] = await listUnresolvedOnlineOperations();
    const b = await retryOnlineOperation(op.id);                                  // attempt B commits
    expect(b.error).toBeNull();
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    first.resolve(NO_UPSTREAM);                                                   // A's late answer
    await a;
    expect(await storedOp(op.id)).toMatchObject({ status: "settled", outcome: "applied" });
    expect(await listUnresolvedOnlineOperations()).toHaveLength(0);
  });

  it("A answers 'not delivered' while a Retry B is still in flight; B then times out: it stays UNRESOLVED (B may have committed)", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    fake.queueReply(first.promise as unknown as Record<string, unknown>);
    const a = callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    await vi.waitFor(async () => expect(await listUnresolvedOnlineOperations()).toHaveLength(1));
    const [op] = await listUnresolvedOnlineOperations();
    fake.queueReply({ data: { status: "not_found" }, status: 200, error: null }, second.promise as unknown as Record<string, unknown>, TIMEOUT, TIMEOUT);
    const b = retryOnlineOperation(op.id);                                        // lookup, then B's first send (held)
    await vi.waitFor(() => expect(fake.callsFor("op_execute").length).toBeGreaterThanOrEqual(2));
    first.resolve(NO_UPSTREAM);                                                   // A: "not delivered"
    await a;
    second.resolve(TIMEOUT);                                                      // B: unknown
    expect((await b).error?.name).toBe("PendingConfirmationError");
    expect(await storedOp(op.id)).toMatchObject({ status: "unresolved" });
    expect(await listUnresolvedOnlineOperations()).toHaveLength(1);
  });
});

describe("shift ownership, close vs approvals, stock direction", () => {
  it("a MANAGER's queued close of a cashier's shift blocks that cashier's new open (one open shift per cashier)", async () => {
    await localDb.shifts.put({ id: "shift-c", shopId: "shop-1", cashierId: "cash-c", startedAt: new Date().toISOString(), openingCashMmk: 0 } as never);
    as("mgr-1", "MANAGER");
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: { p_shift_id: "shift-c", p_closing_cash_mmk: 0 }, shopId: "shop-1" });
    const open = { kind: "rpc" as const, name: "open_shift", args: { p_shop_id: "shop-2" }, shopId: "shop-2", actorId: "cash-c" };
    expect((await blockingEarlierWork(open)).map((r) => r.name)).toEqual(["close_shift"]);
    const otherCashier = { ...open, actorId: "cash-d" };
    expect(await blockingEarlierWork(otherCashier)).toHaveLength(0);
  });

  it("a queued close blocks a void / refund approval (it changes the shift's expected cash), whoever approves it", async () => {
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: { p_shift_id: "shift-a", p_closing_cash_mmk: 0 }, shopId: "shop-1" });
    for (const name of ["approve_void_request", "approve_refund_request"]) {
      expect((await blockingEarlierWork({ kind: "rpc", name, args: { p_request_id: "req-1" }, actorId: "mgr-1" })).map((r) => r.name)).toEqual(["close_shift"]);
    }
  });

  it("a NEGATIVE adjustment in units is a stock decrease: ordered after a queued receipt, commutes with a queued sale", async () => {
    await enqueueOutbox({ kind: "rpc", name: "receive_purchase_order", args: { p_purchase_order_id: "po-1", p_shop_id: "shop-1" }, shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("shift-1", "p1"), shopId: "shop-1" });
    const writeOff = { kind: "rpc" as const, name: "adjust_stock", shopId: "shop-1", actorId: "user-1",
      args: { p_shop_id: "shop-1", p_product_id: "p1", p_quantity_delta: -2, p_product_unit_id: "box", p_unit_qty: 1 } };
    expect((await blockingEarlierWork(writeOff)).map((r) => r.name)).toEqual(["receive_purchase_order"]);
  });
});

describe("drain: the same rules on a shared till", () => {
  it("a cashier's sale on an offline shift (now mapped) is NOT passed by a close of that shift queued by another user", async () => {
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("shift-local-3"), shopId: "shop-1", refs: [{ field: "p_shift_id", provisionalId: "shift-local-3" }] });
    await recordIdMapping("shift-local-3", "shift-server-3");
    as("mgr-1", "MANAGER");
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: { p_shift_id: "shift-server-3", p_closing_cash_mmk: 0 }, shopId: "shop-1" });
    await drainOutbox();
    expect(fake.callsFor("op_execute").filter((c) => c.args.p_rpc === "close_shift")).toHaveLength(0);
  });
});
