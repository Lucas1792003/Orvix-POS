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

  it("CRASH BEFORE SEND / MID-REQUEST, nothing committed: after restart the row is resent with the same key — exactly one sale", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("hang"); // the request never reaches/answers
    void get().createSale(saleInput()); // abandoned: the process dies
    await vi.waitFor(() => expect(fake.callsFor("complete_sale")).toHaveLength(1));
    const key = (await rows())[0].idempotencyKey;

    restart();
    makeSaleStore();
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.callsFor("complete_sale").map((c) => c.args.p_idempotency_key)).toEqual([key, key]);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("CRASH AFTER SERVER COMMIT (reply never arrived): restart replays the same key, the server answers from its ledger — one sale, not two", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-hang");
    void get().createSale(saleInput());
    await vi.waitFor(() => expect(fake.server.sales).toHaveLength(1));

    restart();
    const after = makeSaleStore();
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.callsFor("complete_sale")[1].replayed).toBe(true);
    expect(after.get().sales[0].id).toBe("sale-server-1");
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
    await expect(get().createSale(saleInput())).rejects.toThrow(/Pending confirmation: .*NOT recorded on this till/);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", inDoubt: true, writeAhead: true });
    expect(row.provisional).toBeUndefined();
    expect(get().sales).toHaveLength(0); // no local sale, no receipt
  });

  it("a sale on a provisional (offline-opened) shift is queued directly — no online attempt with a provisional id", async () => {
    const { get } = makeSaleStore({ shifts: [{ id: "shift-local", shopId: "shop-1", cashierId: "user-1", startedAt: "t", openingCashMmk: 0, pendingSync: true }] });
    await get().createSale(saleInput({ shiftId: "shift-local" }));
    expect(fake.callsFor("complete_sale")).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ status: "pending", refs: [{ field: "p_shift_id", provisionalId: "shift-local" }] });
  });

  it("the drain holds while an online attempt is in flight (a queued entry cannot overtake it)", async () => {
    const { get } = makeSaleStore();
    vi.stubGlobal("navigator", { onLine: false });
    await get().createSale(saleInput()); // queued
    vi.stubGlobal("navigator", { onLine: true });
    fake.queueModes("hang");
    void get().createSale(saleInput({ paidMmk: 6000 })); // in flight
    await vi.waitFor(() => expect(writeAheadInFlightCount()).toBe(1));
    expect(await drainOutbox()).toBe("backoff");
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
