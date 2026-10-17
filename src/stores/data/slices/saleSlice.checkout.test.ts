// Checkout writes its outbox row BEFORE sending (Batch 2A write-ahead), so
// the flow needs an IndexedDB.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CartItem } from "../../../types";

// ---------------------------------------------------------------------------
// First integration-style ("flow") test, distinct from the pure-logic and
// SQL-string suites: it drives the real POS checkout path in the data store —
// createSale builds the complete_sale RPC payload, calls Supabase, then
// reconciles local state from the result — with the Supabase client mocked.
// This pins the three things unit tests can't: the per-item price-resolution
// branches, the RPC parameter contract, and the state merge. Add sibling
// flow tests here for PO receive, transfer dispatch/receive, refund approval.
// ---------------------------------------------------------------------------

const rpc = vi.fn();
vi.mock("../../../lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    // The offline rules (sign-in window) apply to an unknown outcome too.
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "auth-test-user" } } } }) },
  },
}));

// Imported after vi.mock so the slice picks up the mocked client.
import { createSaleSlice } from "./saleSlice";

// Minimal zustand-style harness: a mutable state object with set/get that
// support the function-updater form createSale uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStore(seed: Record<string, any> = {}) {
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
    productUnits: [{ id: "u1", isDefault: true }],
    getProductPrice: () => 0,
    sales: [],
    saleItems: [],
    inventory: [],
    movements: [],
    auditLogs: [],
    ...slice,
    ...seed,
  };
  return { get, set };
}

const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1",
  productId: "p1",
  productUnitId: "u1",
  name: "Tea Mix",
  unitName: "Can",
  qty: 2,
  unitPriceMmk: 1000,
  unitsPerItem: 1,
  unitBaseQuantity: 1,
  priceLevelId: "pl-retail",
  ...over,
});

const rpcResult = {
  sale: { id: "sale-1", receiptNo: "R-001", shopId: "shop-1" },
  items: [{ id: "si-1", saleId: "sale-1" }],
  movements: [{ id: "mv-1" }],
  inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 98 }],
  auditLogs: [{ id: "au-1" }],
  shopName: "Shop 1",
  cashierName: "Cashier A",
};

const baseInput = {
  shopId: "shop-1",
  cashierId: "user-1",
  shiftId: "shift-1",
  cartDiscountPct: 0,
  paymentMethod: "CASH" as const,
  paidMmk: 5000,
};

beforeEach(async () => {
  const { localDb } = await import("../../../lib/localDb");
  await localDb.syncOutbox.clear();
});
beforeEach(() => {
  rpc.mockReset();
});

describe("createSale checkout flow", () => {
  it("calls complete_sale with the shift/payment params and returns the new sale id", async () => {
    rpc.mockResolvedValue({ data: rpcResult, error: null });
    const { get } = makeStore();

    const saleId = await get().createSale({ ...baseInput, cartItems: [cartItem()] });

    expect(saleId).toBe("sale-1");
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, params] = rpc.mock.calls[0];
    expect(name).toBe("complete_sale");
    expect(params).toMatchObject({
      p_shop_id: "shop-1",
      p_shift_id: "shift-1",
      p_payment_method: "CASH",
      p_paid_mmk: 5000,
      p_cart_discount_pct: 0,
    });
    expect(params.p_items).toHaveLength(1);
  });

  it("reconciles local state from the authoritative RPC result", async () => {
    rpc.mockResolvedValue({ data: rpcResult, error: null });
    const { get } = makeStore({
      sales: [{ id: "old-sale" }],
      inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 100 }],
    });

    await get().createSale({ ...baseInput, cartItems: [cartItem()] });

    const state = get();
    expect(state.sales[0].id).toBe("sale-1"); // newest first
    expect(state.sales[1].id).toBe("old-sale");
    expect(state.saleItems).toEqual([{ id: "si-1", saleId: "sale-1" }]);
    // Inventory row is merged in place, not duplicated.
    expect(state.inventory).toHaveLength(1);
    expect(state.inventory[0].qtyBaseUnits).toBe(98);
    expect(state.movements[0].id).toBe("mv-1");
    expect(state.auditLogs[0].id).toBe("au-1");
  });

  it("sends a null unit price for a normal fixed-price line (server resolves it)", async () => {
    rpc.mockResolvedValue({ data: rpcResult, error: null });
    const { get } = makeStore();

    await get().createSale({ ...baseInput, cartItems: [cartItem()] });

    const item = rpc.mock.calls[0][1].p_items[0];
    expect(item).toMatchObject({
      product_id: "p1",
      product_unit_id: "u1",
      price_level_id: "pl-retail",
      qty: 2,
      units_per_item: 1,
      unit_price_mmk: null,
      price_overridden: false,
      stock_override_requested: false,
    });
  });

  it("forwards the cashier price and flags an overridden line", async () => {
    rpc.mockResolvedValue({ data: rpcResult, error: null });
    const { get } = makeStore();

    await get().createSale({
      ...baseInput,
      cartItems: [cartItem({ unitPriceMmk: 1500, priceOverriddenBy: "user-1" })],
    });

    const item = rpc.mock.calls[0][1].p_items[0];
    expect(item.unit_price_mmk).toBe(1500);
    expect(item.price_overridden).toBe(true);
  });

  it("always sends the entered price for an open-price line", async () => {
    rpc.mockResolvedValue({ data: rpcResult, error: null });
    const { get } = makeStore();

    await get().createSale({
      ...baseInput,
      cartItems: [cartItem({ unitPriceMmk: 2500, isOpenPrice: true })],
    });

    const item = rpc.mock.calls[0][1].p_items[0];
    expect(item.unit_price_mmk).toBe(2500);
    expect(item.price_overridden).toBe(false);
  });

  it("throws the server message and leaves state untouched on RPC error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Insufficient stock for Tea Mix" } });
    const { get } = makeStore();

    await expect(
      get().createSale({ ...baseInput, cartItems: [cartItem()] }),
    ).rejects.toThrow("Insufficient stock for Tea Mix");
    expect(get().sales).toHaveLength(0);
  });

  // Batch 2A (Q-C1): an empty 2xx is an UNKNOWN outcome, not a failure —
  // the server may have committed. The sale is kept (durable, same key,
  // pending confirmation) instead of an error that invites re-ringing it
  // under a new key.
  it("an empty reply is an unknown outcome: the sale is kept pending confirmation with its key, never reported as failed", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const { get } = makeStore({ products: [{ id: "p1", isNonStock: false }], shifts: [], getInventoryQty: () => 10 });

    const { localDb: db } = await import("../../../lib/localDb");
    await db.authCache.put({
      authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1",
      isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
    });
    await expect(get().createSale({ ...baseInput, cartItems: [cartItem()] })).rejects.toMatchObject({ name: "PendingConfirmationError" });

    const sentKey = rpc.mock.calls[0][1].p_idempotency_key;
    const { localDb } = await import("../../../lib/localDb");
    const [row] = await localDb.syncOutbox.toArray();
    expect(row).toMatchObject({ name: "complete_sale", status: "pending", inDoubt: true, idempotencyKey: sentKey, writeAhead: true });
    // Shown as unconfirmed — not as a recorded sale.
    expect(get().sales[0]).toMatchObject({ pendingSync: true, pendingConfirmation: true });
  });
});
