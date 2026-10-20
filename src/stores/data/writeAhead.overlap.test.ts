import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// Financial-safety fix 1 (audit G1): an unresolved sale re-rung with the items
// in another order, another tender or another quantity used to get a NEW key
// with no prompt (the re-entry check matched identical arguments only) — a
// possible second sale. Unresolved attempts are now also matched by logical
// scope (shop + shift + cashier), and the person must decide: wait, resend
// the earlier one with its key, replace it (stopped on the server first), or
// record a genuinely additional sale. Driven through the REAL sale slice,
// engine and outbox against the fake server's idempotency ledger.
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
import { drainOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "./outbox";
import { registerOperationPrompt, type PromptDecision, type UnresolvedPromptRequest } from "./operationPrompt";
import { resetOnlineOnlyForTests } from "./onlineOnly";
import { resetWriteAheadForTests, scopeOf } from "./writeAhead";
import { setExecutorCapabilityForTests } from "./idempotentRpc";

const restart = () => {
  simulateNewAppInstanceForTests();
  resetWriteAheadForTests();
  resetOnlineOnlyForTests();
};

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
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }, { id: "u2", isDefault: true, baseQuantity: 1 }],
    products: [{ id: "p1", isNonStock: false }, { id: "p2", isNonStock: false }],
    getProductPrice: () => 0,
    getInventoryQty: (shopId: string, productId: string) =>
      state.inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits ?? 0,
    shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 50 }, { shopId: "shop-1", productId: "p2", qtyBaseUnits: 50 }],
    ...slice,
    ...seed,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}

const tea = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea", unitName: "Can",
  qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail", ...over,
});
const coffee = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c2", productId: "p2", productUnitId: "u2", name: "Coffee", unitName: "Can",
  qty: 1, unitPriceMmk: 1500, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail", ...over,
});
const sale = (over: Record<string, unknown> = {}) => ({
  shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1",
  cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000, cartItems: [tea(), coffee()], ...over,
});
const rows = () => localDb.syncOutbox.toArray();
const keysSent = () => fake.callsFor("complete_sale").map((c) => c.args.p_idempotency_key)
  .concat(fake.callsFor("op_execute").map((c) => (c.args as { p_key?: unknown }).p_key ?? c.args.p_idempotency_key));

/** Records every prompt; answers with `answer`. */
const promptAnswering = (answer: PromptDecision) => {
  const asked: UnresolvedPromptRequest[] = [];
  registerOperationPrompt(async (request) => { asked.push(request); return answer; });
  return asked;
};

/** Sale A: the server COMMITS it, the reply is lost -> pending + in doubt, same key. */
const lostReplySale = async (get: () => { createSale: (i: unknown) => Promise<string> }) => {
  fake.queueModes("commit-then-timeout");
  await expect(get().createSale(sale())).rejects.toMatchObject({ name: "PendingConfirmationError" });
  const [row] = await rows();
  expect(row).toMatchObject({ inDoubt: true, name: "complete_sale" });
  return row;
};

beforeEach(async () => {
  fake.reset();
  setExecutorCapabilityForTests("absent");
  restart();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({
    authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1",
    isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
  });
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

describe("scopeOf", () => {
  it("a sale: shop + shift + cashier; a stock adjustment: shop + product; other operations: exact arguments only", () => {
    expect(scopeOf("complete_sale", { p_shop_id: "s", p_shift_id: "sh", p_items: [1] }, "u")).toBe("complete_sale|s|sh|u");
    expect(scopeOf("complete_sale", { p_shop_id: "s", p_shift_id: "sh", p_items: [2] }, "u"))
      .toBe(scopeOf("complete_sale", { p_shop_id: "s", p_shift_id: "sh", p_paid_mmk: 9 }, "u"));
    expect(scopeOf("complete_sale", { p_shop_id: "s", p_shift_id: "sh" }, "other")).not.toBe(scopeOf("complete_sale", { p_shop_id: "s", p_shift_id: "sh" }, "u"));
    expect(scopeOf("adjust_stock", { p_shop_id: "s", p_product_id: "p" }, "u")).toBe("adjust_stock|s|p");
    expect(scopeOf("record_supplier_payment", { p_purchase_order_id: "po" }, "u")).toBeNull();
  });
});

describe("re-ringing an unresolved sale differently is never sent silently under a new key", () => {
  it("REORDERED ITEMS after an uncertain reply: the person is asked (similar), and the default sends nothing — one sale, one key", async () => {
    const { get } = makeSaleStore();
    const earlier = await lostReplySale(get);
    const asked = promptAnswering("cancel");
    await expect(get().createSale(sale({ cartItems: [coffee(), tea()] }))).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ overlap: "similar", allowRetry: true, allowNew: true, allowAdditional: true });
    expect(asked[0].existing[0].summary).toMatch(/2 items \(3 units\) · CASH 5,000 MMK/);
    expect(fake.callsFor("complete_sale")).toHaveLength(1);                // nothing new left the till
    expect((await rows()).map((r) => r.idempotencyKey)).toEqual([earlier.idempotencyKey]);
    await drainOutbox();                                                    // the earlier one resolves with ITS key
    expect(fake.server.sales).toHaveLength(1);
    expect(new Set(keysSent())).toEqual(new Set([earlier.idempotencyKey]));
  });

  it("CHANGED TENDER + 'resend the earlier one': the earlier attempt goes again with its ORIGINAL key — nothing new, one sale", async () => {
    const { get } = makeSaleStore();
    const earlier = await lostReplySale(get);
    promptAnswering("retry");
    await expect(get().createSale(sale({ paidMmk: 10_000 }))).rejects.toMatchObject({ name: "PendingConfirmationError" });
    await vi.waitFor(async () => expect(await localDb.syncOutbox.count()).toBe(0));
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.callsFor("complete_sale").every((c) => c.args.p_idempotency_key === earlier.idempotencyKey)).toBe(true);
  });

  it("CHANGED QUANTITY + 'same sale, replace it' on a server WITH 086, and the earlier one HAD committed: it is recorded instead — nothing new, one sale", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const { get } = makeSaleStore();
    const earlier = await lostReplySale(get);
    promptAnswering("new");
    await expect(get().createSale(sale({ cartItems: [tea({ qty: 3 }), coffee()] }))).rejects.toThrow(/has now been recorded/);
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.server.sales[0].idempotencyKey).toBe(earlier.idempotencyKey);
  });

  it("'same sale, replace it' when the earlier attempt NEVER arrived: it is stopped on the server first, then exactly one sale (the corrected one)", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const first = makeSaleStore();
    fake.queueModes("hang");
    void first.get().createSale(sale());
    await vi.waitFor(() => expect(fake.callsFor("op_execute")).toHaveLength(1));
    fake.releaseExecuting();                     // the connection died; nothing committed
    restart();
    const [earlier] = await rows();
    promptAnswering("new");
    const { get } = makeSaleStore();
    await get().createSale(sale({ paymentMethod: "KPAY" as never, paidMmk: 3500 }));
    expect(fake.server.idempotency.get(earlier.idempotencyKey!)).toMatchObject({ state: "abandoned" });
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.server.sales[0].idempotencyKey).not.toBe(earlier.idempotencyKey);
  });

  it("'replace' on a server WITHOUT 086 cannot stop the earlier attempt: refused, nothing new (never two sales)", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-hang");
    void get().createSale(sale());
    await vi.waitFor(() => expect(fake.server.sales).toHaveLength(1));
    restart();
    makeSaleStore();
    await drainOutbox();                          // held: needs-server-086
    promptAnswering("new");
    const again = makeSaleStore();
    await expect(again.get().createSale(sale({ cartItems: [coffee(), tea()] }))).rejects.toThrow(/could not be confirmed or stopped/);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("DELIBERATE ADDITIONAL SALE (another customer, same products and prices) while one is unresolved: recorded after an explicit choice; the earlier one is still confirmed with its own key — two sales, two keys", async () => {
    const { get } = makeSaleStore();
    const earlier = await lostReplySale(get);
    const asked = promptAnswering("additional");
    await get().createSale(sale({ cartItems: [tea({ qty: 1 })], paidMmk: 1000 }));
    expect(asked).toHaveLength(1);
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(2);
    expect(new Set(fake.server.sales.map((s) => s.idempotencyKey)).size).toBe(2);
    expect(fake.server.sales.map((s) => s.idempotencyKey)).toContain(earlier.idempotencyKey);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("IDENTICAL re-entry (another customer, same products, same tender): 'additional' is offered and records a second sale; the earlier one keeps its key", async () => {
    const { get } = makeSaleStore();
    const earlier = await lostReplySale(get);
    const asked = promptAnswering("additional");
    await get().createSale(sale());
    expect(asked[0]).toMatchObject({ overlap: "identical", allowAdditional: true, allowNew: true });
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(2);
    expect(fake.server.sales.map((s) => s.idempotencyKey)).toContain(earlier.idempotencyKey);
  });

  it("SEVERAL similar unresolved sales (different customers): 'replace' is NOT offered and a 'new' answer stops nothing", async () => {
    const { get } = makeSaleStore();
    await lostReplySale(get);
    fake.queueModes("commit-then-timeout");
    promptAnswering("additional");
    await expect(get().createSale(sale({ cartItems: [tea({ qty: 5 })], paidMmk: 5000 }))).rejects.toMatchObject({ name: "PendingConfirmationError" });
    expect((await rows()).filter((r) => r.inDoubt)).toHaveLength(2);
    const asked = promptAnswering("new");
    await expect(get().createSale(sale({ cartItems: [tea({ qty: 3 })], paidMmk: 3000 }))).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    expect(asked[0]).toMatchObject({ overlap: "similar", allowNew: false, allowAdditional: true });
    expect([...fake.server.idempotency.values()].some((v) => (v as { state?: string }).state === "abandoned")).toBe(false);
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(2);                       // both earlier customers' sales recorded
  });

  it("OUTAGE: an in-doubt sale older than the re-ring window does not make later similar sales ask", async () => {
    const { get } = makeSaleStore();
    const earlier = await lostReplySale(get);
    await localDb.syncOutbox.update(earlier.localId, { createdAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    const asked = promptAnswering("cancel");
    await get().createSale(sale({ paidMmk: 9000 }));
    expect(asked).toHaveLength(0);
  });

  it("a sale with no product in common with the unresolved one is not 'similar'", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-timeout");
    await expect(get().createSale(sale({ cartItems: [tea()] }))).rejects.toMatchObject({ name: "PendingConfirmationError" });
    const asked = promptAnswering("cancel");
    await get().createSale(sale({ cartItems: [coffee()], paidMmk: 1500 }));
    expect(asked).toHaveLength(0);
  });

  it("a queued offline sale the outbox is merely sending (staged, not in doubt) does not make a new sale ask", async () => {
    const { get } = makeSaleStore();
    vi.stubGlobal("navigator", { onLine: false });
    await get().createSale(sale());
    vi.stubGlobal("navigator", { onLine: true });
    const [queued] = await rows();
    await localDb.syncOutbox.update(queued.localId, { status: "syncing" });   // being drained right now
    const asked = promptAnswering("cancel");
    fake.queueModes("succeed");
    await get().createSale(sale({ paidMmk: 8000 })).catch(() => undefined);
    expect(asked).toHaveLength(0);
  });

  it("with no prompt available (early startup, tests) a similar re-entry is never sent", async () => {
    const { get } = makeSaleStore();
    await lostReplySale(get);
    registerOperationPrompt(null);
    await expect(get().createSale(sale({ paidMmk: 20_000 }))).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    expect(fake.callsFor("complete_sale")).toHaveLength(1);
  });

  it("RESTART: the unresolved attempt is durable — after a restart a re-ring with another tender is still caught", async () => {
    const { get } = makeSaleStore();
    const earlier = await lostReplySale(get);
    restart();
    const asked = promptAnswering("cancel");
    const after = makeSaleStore();
    await expect(after.get().createSale(sale({ paymentMethod: "KPAY" as never }))).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    expect(asked).toHaveLength(1);
    expect((await rows()).map((r) => r.idempotencyKey)).toEqual([earlier.idempotencyKey]);
  });

  it("DOUBLE CLICK of the corrected sale while the prompt is open: asked once per submission, still one sale", async () => {
    const { get } = makeSaleStore();
    await lostReplySale(get);
    const asked = promptAnswering("cancel");
    const corrected = sale({ cartItems: [coffee(), tea()] });
    const results = await Promise.allSettled([get().createSale(corrected), get().createSale(corrected)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(asked).toHaveLength(1);                  // the identical second press joined the first
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);
  });
});

describe("legitimate separate sales are not blocked", () => {
  it("no unresolved attempt: identical consecutive sales go straight through, no prompt", async () => {
    const { get } = makeSaleStore();
    const asked = promptAnswering("cancel");
    await get().createSale(sale());
    await get().createSale(sale());
    await get().createSale(sale({ cartItems: [coffee(), tea()] }));
    expect(asked).toHaveLength(0);
    expect(fake.server.sales).toHaveLength(3);
  });

  it("an unresolved sale of ANOTHER shift or ANOTHER cashier does not overlap", async () => {
    const { get } = makeSaleStore();
    await lostReplySale(get);
    const asked = promptAnswering("cancel");
    await get().createSale(sale({ shiftId: "shift-2", paidMmk: 9000 }));
    expect(asked).toHaveLength(0);
    // the other cashier's row: same shop and shift
    const [row] = (await rows()).filter((r) => r.args?.p_shift_id === "shift-1");
    await localDb.syncOutbox.update(row.localId, { args: { ...row.args, p_expected_actor_id: "user-2" }, actorId: "user-2" });
    await get().createSale(sale({ paidMmk: 7000 }));
    expect(asked).toHaveLength(0);
  });

  it("OFFLINE then RECONNECT: queued (not in doubt) sales never prompt each other, and all of them reach the server once", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { get } = makeSaleStore();
    const asked = promptAnswering("cancel");
    await get().createSale(sale());
    await get().createSale(sale());
    await get().createSale(sale({ cartItems: [coffee(), tea()], paidMmk: 3500 }));
    expect(asked).toHaveLength(0);
    expect(await localDb.syncOutbox.count()).toBe(3);
    vi.stubGlobal("navigator", { onLine: true });
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(3);
    expect(new Set(fake.server.sales.map((s) => s.idempotencyKey)).size).toBe(3);
  });

  it("RECONNECT after an uncertain sale: once the queue settles it, the next different sale is not asked about", async () => {
    const { get } = makeSaleStore();
    await lostReplySale(get);
    await drainOutbox();                                  // reconnect: settled with its key
    const asked = promptAnswering("cancel");
    await get().createSale(sale({ cartItems: [coffee()], paidMmk: 1500 }));
    expect(asked).toHaveLength(0);
    expect(fake.server.sales).toHaveLength(2);
  });
});
