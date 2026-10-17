import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// Batch 2A, checkpoint B — the write-ahead lifecycle (writeAhead.ts) and
// stable keys for online-only operations (onlineOnly.ts), driven through the
// REAL sale slice, engine and outbox against the fake server's idempotency
// ledger (testing/fakeSupabase.ts). "Crash" = the in-flight promise is
// abandoned and the outbox behaves like a freshly started app instance.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: "user-1" }) } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb } from "../../lib/localDb";
import { createSaleSlice } from "./slices/saleSlice";
import { drainOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests, writeAheadInFlightCount } from "./outbox";
import { registerOperationPrompt } from "./operationPrompt";
import { callOnlineOnly, countUnsettledOnlineOperations, resetOnlineOnlyForTests } from "./onlineOnly";
import { resetWriteAheadForTests } from "./writeAhead";
import { setExecutorCapabilityForTests } from "./idempotentRpc";

/** A restart: no attempt or submission of the old process survives in memory. */
const restart = () => {
  simulateNewAppInstanceForTests();
  resetWriteAheadForTests();
  resetOnlineOnlyForTests();
};

const TEST_AUTH_ID = "auth-test-user";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSaleStore(seed: Record<string, any> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => {
    const patch = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...patch };
  };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createSaleSlice(set as any, get as any, {} as any);
  state = {
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
    products: [{ id: "p1", isNonStock: false }],
    getProductPrice: () => 0,
    getInventoryQty: (shopId: string, productId: string) =>
      state.inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits ?? 0,
    shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    ...slice,
    ...seed,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}

const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can",
  qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail",
  ...over,
});
const saleInput = (over: Record<string, unknown> = {}) => ({
  shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1",
  cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000, cartItems: [cartItem()],
  ...over,
});
const rows = () => localDb.syncOutbox.toArray();
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  fake.reset();
  setExecutorCapabilityForTests("absent"); // a server at 085 unless a test opts in
  restart();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({
    authId: TEST_AUTH_ID, userId: "user-1", role: "CASHIER", shopId: "shop-1",
    isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
  });
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

describe("write-ahead: the record exists before the request leaves", () => {
  it("a syncing write-ahead row with the exact arguments is on disk while the request is in flight", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("hang");
    void get().createSale(saleInput());
    await vi.waitFor(() => expect(fake.callsFor("complete_sale")).toHaveLength(1));
    const [row] = await rows();
    expect(row).toMatchObject({ status: "syncing", writeAhead: true, name: "complete_sale" });
    // the very object sent is the persisted payload (identical, same key)
    expect(row.args).toEqual(fake.callsFor("complete_sale")[0].args);
    expect(writeAheadInFlightCount()).toBe(1);
  });

  // G1 Stage 1 (C1): the FIRST online attempt was never evaluated under the
  // offline rules. After a crash it is never resent blindly any more.
  it("CRASH MID-REQUEST, server WITHOUT 086: after restart the row is held (never resent), shown as not recorded", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("hang"); // the request never reaches/answers
    void get().createSale(saleInput()); // abandoned: the process dies
    await vi.waitFor(() => expect(fake.callsFor("complete_sale")).toHaveLength(1));
    const key = (await rows())[0].idempotencyKey;

    restart();
    makeSaleStore();
    // H2: an undecided held entry keeps the head of the queue
    expect(await drainOutbox()).toBe("backoff");
    expect(fake.server.sales).toHaveLength(0);
    expect(fake.callsFor("complete_sale")).toHaveLength(1); // NOT resent
    const [row] = await rows();
    expect(row).toMatchObject({ idempotencyKey: key, status: "conflict", inDoubt: true, fenceRequired: true, heldReason: "needs-server-086" });
    expect(row.lastError).toMatch(/NOT recorded on this till/);
  });

  it("CRASH MID-REQUEST, server WITH 086, request never arrived: fenced (abandoned), never executed; a late copy cannot run", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const { get } = makeSaleStore();
    fake.queueModes("hang");
    void get().createSale(saleInput());
    await vi.waitFor(() => expect(fake.callsFor("op_execute")).toHaveLength(1));
    const [{ idempotencyKey: key, args }] = await rows();
    fake.releaseExecuting(); // the connection died; the server rolled back

    restart();
    makeSaleStore();
    expect(await drainOutbox()).toBe("drained");
    expect(fake.callsFor("op_execute")).toHaveLength(1); // never resent
    expect(fake.callsFor("op_status").at(-1)?.args).toMatchObject({ p_key: key, p_fence: true, p_expected_actor_id: "user-1" });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "conflict", serverOutcome: "abandoned", inDoubt: false });
    expect(fake.server.sales).toHaveLength(0);
    // the delayed original request: the legacy path and the executor both refuse it
    const legacy = await fake.rpc("complete_sale", args as Record<string, unknown>);
    // a UUIDv7 key is refused on the legacy path before anything else (086 idem_begin guard)
    expect((legacy as { error: { message: string } }).error.message).toMatch(/^OP_EXECUTOR_REQUIRED/);
    expect(fake.server.sales).toHaveLength(0);
  });

  it("CRASH AFTER SERVER COMMIT, server WITH 086: the lookup returns the committed reply — reconciled once, nothing resent", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-hang");
    void get().createSale(saleInput());
    await vi.waitFor(() => expect(fake.server.sales).toHaveLength(1));

    restart();
    const after = makeSaleStore();
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.callsFor("op_execute")).toHaveLength(1);
    expect(after.get().sales[0].id).toBe("sale-server-1");
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("CRASH AFTER SERVER COMMIT, server WITHOUT 086: held, not resent (the till cannot learn the outcome safely)", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-hang");
    void get().createSale(saleInput());
    await vi.waitFor(() => expect(fake.server.sales).toHaveLength(1));

    restart();
    makeSaleStore();
    await drainOutbox();
    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    expect(fake.server.sales).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ fenceRequired: true, heldReason: "needs-server-086" });
  });

  it("LOST REPLY (commit, then timeout): kept pending + in doubt with the same key, shown as a provisional sale; the replay settles it — one sale", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-timeout");
    await expect(get().createSale(saleInput())).rejects.toMatchObject({ name: "PendingConfirmationError" });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", inDoubt: true, writeAhead: true });
    expect(get().sales[0]).toMatchObject({ pendingSync: true, pendingConfirmation: true });
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);
    expect(get().sales.map((s: { id: string }) => s.id)).toEqual(["sale-server-1"]);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("DOUBLE CLICK / repeated Confirm while unresolved: one request, one key, one sale, the same result", async () => {
    const { get } = makeSaleStore();
    const [a, b] = await Promise.all([get().createSale(saleInput()), get().createSale(saleInput())]);
    expect(a).toBe(b);
    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("a NEW identical sale after the first one resolved is a new operation (new key) — not merged into the first", async () => {
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    await get().createSale(saleInput());
    const keys = fake.callsFor("complete_sale").map((c) => c.args.p_idempotency_key);
    expect(new Set(keys).size).toBe(2);
    expect(fake.server.sales).toHaveLength(2);
  });

  it("DEFINITIVE REFUSAL at the counter (D-10(a)): the write-ahead row is removed, the error is shown, nothing is staged", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("permanent-error");
    await expect(get().createSale(saleInput())).rejects.toThrow(/Insufficient stock/);
    expect(await rows()).toEqual([]);
    expect(get().sales).toEqual([]);
    expect(get().inventory[0].qtyBaseUnits).toBe(10);
  });

  it("ORGANISATION SUSPENDED (PT503): refused, nothing staged offline, no record kept", async () => {
    const { get } = makeSaleStore();
    fake.queueReply({ data: null, status: 503, error: { code: "PT503", message: "ORG_SUSPENDED: service unavailable", details: null, hint: null } });
    await expect(get().createSale(saleInput())).rejects.toThrow(/ORG_SUSPENDED/);
    expect(await rows()).toEqual([]);
    expect(get().sales).toEqual([]);
  });

  it("NOT DELIVERED (no healthy upstream): the normal offline path — staged, pending, NOT in doubt, same key", async () => {
    const { get } = makeSaleStore();
    fake.queueReply({ data: null, status: 503, error: { message: "no healthy upstream", code: "", details: "", hint: "" } });
    await get().createSale(saleInput());
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", inDoubt: false });
    expect(row.idempotencyKey).toBe(fake.callsFor("complete_sale")[0].args.p_idempotency_key);
    expect(get().inventory[0].qtyBaseUnits).toBe(8);
  });

  it("NOT DELIVERED but the offline checks refuse (12 h window lapsed): nothing kept, the error is shown", async () => {
    const { get } = makeSaleStore();
    await localDb.authCache.clear(); // no offline authorisation
    fake.queueReply({ data: null, status: 503, error: { message: "no healthy upstream", code: "", details: "", hint: "" } });
    await expect(get().createSale(saleInput())).rejects.toThrow();
    expect(await rows()).toEqual([]);
    expect(get().sales).toEqual([]);
  });

  it("UNKNOWN OUTCOME (Cloudflare 524) with the 12 h window lapsed: kept with its key, but NOT staged — ambiguity never authorises offline trading", async () => {
    const { get } = makeSaleStore();
    await localDb.authCache.clear();
    fake.queueReply({ data: null, status: 524, error: { message: "<html>A timeout occurred</html>", code: "", details: "", hint: "" } });
    await expect(get().createSale(saleInput())).rejects.toThrow(/Not recorded on this till/);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "conflict", inDoubt: true, writeAhead: true, fenceRequired: true, staged: false });
    expect(row.provisional).toBeUndefined();
    expect(get().sales).toHaveLength(0); // no local sale, no receipt
  });

  it("a sale on a provisional (offline-opened) shift is queued directly — no online attempt with a provisional id", async () => {
    const { get } = makeSaleStore({ shifts: [{ id: "shift-local", shopId: "shop-1", cashierId: "user-1", startedAt: "t", openingCashMmk: 0, pendingSync: true }] });
    await get().createSale(saleInput({ shiftId: "shift-local" }));
    expect(fake.callsFor("complete_sale")).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ status: "pending", refs: [{ field: "p_shift_id", provisionalId: "shift-local" }] });
  });

  it("an online sale never overtakes an unsent entry it may depend on (a queued restock of its product) — queued behind it, sent after it", async () => {
    const { get } = makeSaleStore();
    // a restock of p1 is still queued (the server could not be reached)
    const { enqueueOutbox } = await import("./outbox");
    await enqueueOutbox({ kind: "rpc", name: "adjust_stock", args: { p_shop_id: "shop-1", p_product_id: "p1", p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 5, p_reason: "x" }, shopId: "shop-1" });
    fake.setDefaultMode("network-error");                 // the queue cannot drain yet
    await get().createSale(saleInput({ paidMmk: 6000 })); // online, but it may depend on the restock: behind it
    const queued = (await rows()).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({ status: "pending", staged: true });
    expect(fake.server.sales).toHaveLength(0);
    fake.setDefaultMode("succeed");
    for (const r of queued) await localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    for (let i = 0; i < 100; i++) {
      const r = await drainOutbox();
      if (r !== "already-running" && r !== "locked") break;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    expect(fake.server.sales).toHaveLength(1);
    const order = fake.calls.filter((c) => c.name === "adjust_stock" || c.name === "complete_sale").map((c) => c.name);
    expect(order.lastIndexOf("adjust_stock")).toBeLessThan(order.lastIndexOf("complete_sale"));
  });

  it("the drain holds while an online attempt is in flight (a queued entry cannot overtake it)", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("hang");
    void get().createSale(saleInput({ paidMmk: 6000 })); // in flight (the queue was empty)
    await vi.waitFor(() => expect(writeAheadInFlightCount()).toBe(1));
    const { enqueueOutbox } = await import("./outbox");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_items: [] }, shopId: "shop-1" });
    expect(await drainOutbox()).toBe("backoff");
    fake.releaseExecuting();
  });
});

describe("atomic offline commit (item 4)", () => {
  it("if the transaction fails, NOTHING is written and the store is unchanged — no orphan stock change, no orphan queue row", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { get } = makeSaleStore();
    const put = vi.spyOn(localDb.syncOutbox, "put").mockImplementationOnce(() => { throw new Error("quota exceeded"); });
    await expect(get().createSale(saleInput())).rejects.toThrow(/quota/);
    put.mockRestore();
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(await localDb.sales.count()).toBe(0);
    expect(await localDb.movements.count()).toBe(0);
    expect(get().sales).toEqual([]);
    expect(get().inventory[0].qtyBaseUnits).toBe(10);
  });

  it("after the transaction commits, the sale, its movement, the stock change and the queue row are all on disk", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { get } = makeSaleStore();
    const id = await get().createSale(saleInput());
    expect(await localDb.sales.get(id)).toBeDefined();
    expect(await localDb.movements.count()).toBe(1);
    expect((await localDb.inventory.get(["shop-1", "p1"]))?.qtyBaseUnits).toBe(8);
    expect(await localDb.syncOutbox.count()).toBe(1);
  });
});

// Stabilization pass H1: an earlier attempt stays visible to duplicate-sale
// prevention whatever its queue status — held ("conflict" + fenceRequired),
// set aside, in doubt — until the SERVER has decided it.
describe("H1: held / set-aside attempts are never invisible to a replacement checkout", () => {
  const crashAfterCommit = async () => {
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-hang");
    void get().createSale(saleInput());
    await vi.waitFor(() => expect(fake.server.sales).toHaveLength(1));
    restart();
  };
  const holdUndecided = async () => {
    const [row] = await rows();
    await localDb.syncOutbox.update(row.localId, {
      status: "conflict", fenceRequired: true, inDoubt: true, staged: false, syncingSince: undefined,
      heldReason: "status-unreachable", nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return row;
  };

  it("server WITHOUT 086: the first attempt committed (reply lost), held after the restart; the same sale again -> asked, and 'new' is REFUSED (no second sale)", async () => {
    await crashAfterCommit();
    makeSaleStore();
    await drainOutbox();
    expect((await rows())[0]).toMatchObject({ status: "conflict", fenceRequired: true, heldReason: "needs-server-086" });
    let asked = 0;
    registerOperationPrompt(async () => { asked += 1; return "new"; });
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toThrow(/could not be confirmed or stopped/);
    expect(asked).toBe(1);
    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("server WITHOUT 086: still visible once an owner has SET IT ASIDE (undecided)", async () => {
    await crashAfterCommit();
    makeSaleStore();
    await drainOutbox();
    const [row] = await rows();
    await localDb.syncOutbox.update(row.localId, { status: "archived", statusBeforeArchive: "conflict" });
    let asked = 0;
    registerOperationPrompt(async () => { asked += 1; return "new"; });
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toThrow(/could not be confirmed or stopped/);
    expect(asked).toBe(1);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("server WITH 086: a HELD attempt that did commit -> 'new' records the original instead; nothing new is sent", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    await crashAfterCommit();
    const row = await holdUndecided();
    registerOperationPrompt(async () => "new");
    const { get } = makeSaleStore();
    const executes = fake.callsFor("op_execute").length;
    await expect(get().createSale(saleInput())).rejects.toThrow(/has now been recorded/);
    expect(fake.callsFor("op_execute")).toHaveLength(executes);
    expect(fake.server.sales).toHaveLength(1);
    expect(await localDb.syncOutbox.get(row.localId)).toBeUndefined();   // reconciled
  });

  it("server WITH 086: a HELD attempt that never arrived -> fenced first, then exactly one new sale; two concurrent replacements still make one", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const first = makeSaleStore();
    fake.queueModes("hang");
    void first.get().createSale(saleInput());
    await vi.waitFor(() => expect(fake.callsFor("op_execute")).toHaveLength(1));
    fake.releaseExecuting();
    restart();
    const row = await holdUndecided();
    registerOperationPrompt(async () => "new");
    const { get } = makeSaleStore();
    await Promise.allSettled([get().createSale(saleInput()), get().createSale(saleInput())]);
    expect(fake.server.idempotency.get(row.idempotencyKey!)).toMatchObject({ state: "abandoned" });
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.server.sales[0].idempotencyKey).not.toBe(row.idempotencyKey);
  });

  it("a server decision ends it: a fenced (abandoned) attempt is no longer asked about", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const first = makeSaleStore();
    fake.queueModes("hang");
    void first.get().createSale(saleInput());
    await vi.waitFor(() => expect(fake.callsFor("op_execute")).toHaveLength(1));
    fake.releaseExecuting();
    restart();
    makeSaleStore();
    await drainOutbox();
    expect((await rows())[0]).toMatchObject({ serverOutcome: "abandoned" });
    let asked = 0;
    registerOperationPrompt(async () => { asked += 1; return "new"; });
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    expect(asked).toBe(0);
    expect(fake.server.sales).toHaveLength(1);
  });
});

// Final financial-safety pass, blocker A/B: the replacement prompt races
// the drain; earlier attempts stay bound to their backend.
describe("A/B: replacement checkout races and backend identity", () => {
  const inDoubtSale = async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-timeout");
    await expect(get().createSale(saleInput())).rejects.toThrow(/Pending confirmation/);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", inDoubt: true });
    return row;
  };

  it("A: the earlier attempt COMMITS and its queue row is deleted (drain acknowledged it) WHILE the cashier is asked -> 'new' records nothing new", async () => {
    const row = await inDoubtSale();                    // committed on the server, reply lost
    expect(fake.server.sales).toHaveLength(1);
    registerOperationPrompt(async () => {
      // during the prompt: another worker acknowledges it (the row disappears)
      await localDb.syncOutbox.delete(row.localId);
      return "new";
    });
    const { get } = makeSaleStore();
    const executes = fake.callsFor("op_execute").length;
    await expect(get().createSale(saleInput())).rejects.toThrow(/has now been recorded/);
    expect(fake.callsFor("op_execute")).toHaveLength(executes);                 // nothing new sent
    expect(fake.server.sales).toHaveLength(1);                                  // no duplicate
    expect(fake.callsFor("op_status").at(-1)?.args).toMatchObject({ p_key: row.idempotencyKey, p_fence: true });
  });

  it("A: the row disappears during the prompt but the server never saw the attempt -> it is fenced by its OWN key first, then exactly one new sale", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const first = makeSaleStore();
    fake.queueModes("network-error");                    // never reached the server
    await expect(first.get().createSale(saleInput())).rejects.toThrow();
    const [row] = await rows();
    await localDb.syncOutbox.update(row.localId, { inDoubt: true, status: "pending" });
    registerOperationPrompt(async () => { await localDb.syncOutbox.delete(row.localId); return "new"; });
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    expect(fake.server.idempotency.get(row.idempotencyKey!)).toMatchObject({ state: "abandoned" });
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.server.sales[0].idempotencyKey).not.toBe(row.idempotencyKey);
  });

  it("A: the original is IN FLIGHT on the server when 'new' is chosen (a delayed copy is executing) -> blocked, nothing new", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const first = makeSaleStore();
    fake.queueModes("network-error");
    await expect(first.get().createSale(saleInput())).rejects.toThrow();
    const [row] = await rows();
    await localDb.syncOutbox.update(row.localId, { inDoubt: true, status: "pending" });
    // the delayed original request reaches the server and holds its key's lock
    fake.queueModes("hang");
    const { p_idempotency_key: _k, ...rowArgs } = row.args as Record<string, unknown>;
    void _k;
    void fake.rpc("op_execute", { p_key: row.idempotencyKey, p_rpc: "complete_sale", p_args: rowArgs, p_actor_id: "user-1" });
    registerOperationPrompt(async () => "new");
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toThrow(/could not be confirmed or stopped/);
    expect(fake.server.idempotency.get(row.idempotencyKey!)).toBeUndefined();   // never fenced while in flight
    expect(fake.server.sales.filter((x) => x.idempotencyKey !== row.idempotencyKey)).toHaveLength(0);
    expect(await localDb.syncOutbox.get(row.localId)).toMatchObject({ idempotencyKey: row.idempotencyKey }); // kept
    fake.releaseExecuting();
  });

  it("B: an earlier attempt queued for ANOTHER backend blocks the replacement; this server is never asked or fenced", async () => {
    const row = await inDoubtSale();
    await localDb.syncOutbox.update(row.localId, { backendOrigin: "https://other-backend.example.test", status: "quarantined" });
    registerOperationPrompt(async () => "new");
    const { get } = makeSaleStore();
    const lookups = fake.callsFor("op_status").length;
    await expect(get().createSale(saleInput())).rejects.toThrow(/another server/);
    expect(fake.callsFor("op_status")).toHaveLength(lookups);
    expect(fake.server.idempotency.get(row.idempotencyKey!)).toMatchObject({ state: "committed" }); // untouched
    expect(fake.server.sales).toHaveLength(1);
  });
});

describe("online-only operations keep their key until settled (item 5)", () => {
  const pay = (amount = 1000) => callOnlineOnly("pay_supplier_lump_sum", { p_supplier_id: "sup-1", p_amount_mmk: amount, p_created_at: new Date().toISOString() });

  it("a lost reply then a retry of the same payment resends the SAME request (same key, same arguments): one payment", async () => {
    fake.queueModes("commit-then-timeout", "commit-then-timeout", "commit-then-timeout"); // + 2 automatic retries
    const first = await pay();
    expect(first.error?.failure.mayHaveCommitted).toBe(true);
    expect(first.error?.name).toBe("PendingConfirmationError"); // never "failed"
    await tick();
    // The user enters it again and, asked, chooses to retry the earlier one.
    registerOperationPrompt(async () => "retry");
    const second = await pay();
    expect(second.error).toBeNull();
    const calls = fake.callsFor("pay_supplier_lump_sum");
    expect(new Set(calls.map((c) => c.args.p_idempotency_key)).size).toBe(1);
    expect(calls.at(-1)!.args).toEqual(calls[0].args);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    expect(await countUnsettledOnlineOperations()).toBe(0); // settled
  });

  it("after a success, an identical payment is a NEW operation (new key)", async () => {
    await pay();
    await pay();
    expect(new Set(fake.callsFor("pay_supplier_lump_sum").map((c) => c.args.p_idempotency_key)).size).toBe(2);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(2);
  });

  it("a definitive refusal settles it (next attempt is a new operation)", async () => {
    fake.queueModes("permanent-error");
    expect((await pay()).error?.failure.klass).toBe("REJECTED");
    expect(await countUnsettledOnlineOperations()).toBe(0);
  });

  it("the remembered key survives an app restart (persisted before sending)", async () => {
    fake.queueModes("commit-then-timeout", "commit-then-timeout", "commit-then-timeout");
    await pay();
    expect(await countUnsettledOnlineOperations()).toBe(1);
    restart();
    registerOperationPrompt(async () => "retry");
    await pay();
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
  });

  it("a double click acts once", async () => {
    const [a, b] = await Promise.all([pay(), pay()]);
    expect(a).toBe(b);
    expect(fake.callsFor("pay_supplier_lump_sum")).toHaveLength(1);
  });
});
