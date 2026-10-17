import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CartItem } from "../../../types";

// ---------------------------------------------------------------------------
// Offline counterpart to saleSlice.checkout.test.ts: createSale must keep
// checkout working with no network — staging the sale locally and queuing it
// — then reconcile cleanly once the outbox actually reaches complete_sale.
// ---------------------------------------------------------------------------

const rpc = vi.fn();
const TEST_AUTH_ID = "auth-test-user";
vi.mock("../../../lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: TEST_AUTH_ID } } } }) },
  },
}));

import { createSaleSlice } from "./saleSlice";
import { localDb } from "../../../lib/localDb";
import { drainOutbox, registerOutboxReconciler } from "../outbox";

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
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
    products: [{ id: "p1", isNonStock: false }],
    getProductPrice: () => 0,
    getInventoryQty: (shopId: string, productId: string) =>
      state.inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)
        ?.qtyBaseUnits ?? 0,
    shifts: [],
    sales: [],
    saleItems: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    movements: [],
    auditLogs: [],
    ...slice,
    ...seed,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) =>
    get().reconcileCompleteSale(data, provisional ?? []));
  return { get, set };
}

const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can",
  qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail",
  ...over,
});

const baseInput = {
  shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1",
  cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000,
};

beforeEach(async () => {
  rpc.mockReset();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({
    authId: TEST_AUTH_ID, userId: "user-1", role: "CASHIER", shopId: "shop-1",
    isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
  });
  vi.stubGlobal("navigator", { onLine: false });
});
afterEach(() => vi.unstubAllGlobals());

describe("createSale offline", () => {
  it("stages a provisional sale locally without touching the network", async () => {
    const { get } = makeStore();

    const saleId = await get().createSale({ ...baseInput, cartItems: [cartItem()] });

    expect(rpc).not.toHaveBeenCalled();
    expect(get().sales[0]).toMatchObject({ id: saleId, pendingSync: true, totalMmk: 2000, receiptNo: "PENDING" });
    expect(get().inventory.find((i: { productId: string }) => i.productId === "p1")?.qtyBaseUnits).toBe(8);
    expect(get().movements[0]).toMatchObject({ pendingSync: true, qtyChange: -2 });

    const queued = await localDb.syncOutbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0].name).toBe("complete_sale");
    expect(queued[0].args).toMatchObject({ p_shop_id: "shop-1", p_shift_id: "shift-1" });
  });

  // Migration 045: the queued RPC must carry the moment the sale actually
  // happened, not whenever the outbox later replays it — otherwise a sale
  // rung up at 3pm that doesn't sync until 9pm would record as a 9pm sale.
  it("queues complete_sale with p_created_at matching the local provisional sale's own timestamp", async () => {
    const { get } = makeStore();

    const saleId = await get().createSale({ ...baseInput, cartItems: [cartItem()] });

    const localCreatedAt = get().sales.find((s: { id: string }) => s.id === saleId)?.createdAt;
    expect(typeof localCreatedAt).toBe("string");

    const queued = await localDb.syncOutbox.toArray();
    expect((queued[0].args as { p_created_at: string }).p_created_at).toBe(localCreatedAt);
  });

  it("deducts cumulatively across two lines of the same product", async () => {
    const { get } = makeStore();
    await get().createSale({
      ...baseInput,
      cartItems: [cartItem({ id: "c1", qty: 3 }), cartItem({ id: "c2", qty: 4 })],
    });
    expect(get().inventory.find((i: { productId: string }) => i.productId === "p1")?.qtyBaseUnits).toBe(3);
  });

  it("blocks checkout when local stock is insufficient", async () => {
    const { get } = makeStore({ inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 1 }] });

    await expect(
      get().createSale({ ...baseInput, cartItems: [cartItem({ qty: 2 })] }),
    ).rejects.toThrow("Only 1 in stock for this shop.");
    expect(get().sales).toHaveLength(0);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("a transport failure while navigator looks online: kept (same key), staged under the offline rules, shown as UNCONFIRMED", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    const { get } = makeStore();

    // "Failed to fetch" may come after the request left: the outcome is
    // unknown — never "recorded", never "failed" (correction pass).
    await expect(get().createSale({ ...baseInput, cartItems: [cartItem()] })).rejects.toMatchObject({ name: "PendingConfirmationError" });

    expect(get().sales[0]).toMatchObject({ pendingSync: true, pendingConfirmation: true });
    const [row] = await localDb.syncOutbox.toArray();
    expect(row).toMatchObject({ status: "pending", inDoubt: true, writeAhead: true });
  });

  it("does NOT fall back to offline for a genuine server rejection while online", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    rpc.mockResolvedValue({ data: null, error: { message: "Insufficient stock for Tea Mix" } });
    const { get } = makeStore();

    await expect(
      get().createSale({ ...baseInput, cartItems: [cartItem()] }),
    ).rejects.toThrow("Insufficient stock for Tea Mix");
    expect(get().sales).toHaveLength(0);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("replaces the provisional sale with the server's authoritative rows once the outbox drains", async () => {
    const { get } = makeStore();
    const provisionalId = await get().createSale({ ...baseInput, cartItems: [cartItem()] });
    const provisionalMovementId = get().movements[0].id;

    vi.stubGlobal("navigator", { onLine: true });
    rpc.mockResolvedValue({
      data: {
        sale: { id: "sale-server-1", receiptNo: "R-100", shopId: "shop-1", totalMmk: 2000 },
        items: [{ id: "si-server-1", saleId: "sale-server-1" }],
        movements: [{ id: "mv-server-1", shopId: "shop-1", productId: "p1" }],
        inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 8 }],
        auditLogs: [{ id: "au-server-1" }],
      },
      error: null,
    });

    await drainOutbox();

    // Provisional record is gone, replaced by the server's — not merged in
    // place, since complete_sale mints its own id server-side.
    expect(get().sales.map((s: { id: string }) => s.id)).toEqual(["sale-server-1"]);
    expect(get().sales[0].pendingSync).toBeUndefined();
    expect(get().movements.map((m: { id: string }) => m.id)).toEqual(["mv-server-1"]);
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(await localDb.sales.get(provisionalId)).toBeUndefined();
    expect(await localDb.movements.get(provisionalMovementId)).toBeUndefined();
    expect((await localDb.sales.get("sale-server-1"))?.receiptNo).toBe("R-100");
  });

  it("does not list the server's sale twice when a full reload already brought it in before the replay", async () => {
    // Commit-then-lost-response: the sale is already on the server when the
    // reconnect reload runs, so the store holds the server row AND the
    // still-queued provisional row when the replay finally reconciles.
    const { get, set } = makeStore();
    const provisionalId = await get().createSale({ ...baseInput, cartItems: [cartItem()] });
    const serverRows = {
      sale: { id: "sale-server-2", receiptNo: "R-200", shopId: "shop-1", shiftId: "shift-1", totalMmk: 2000 },
      items: [{ id: "si-server-2", saleId: "sale-server-2" }],
      movements: [{ id: "mv-server-2", shopId: "shop-1", productId: "p1" }],
      inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 8 }],
      auditLogs: [{ id: "au-server-2" }],
    };
    // what loadData() would have applied: server rows + the merged-back provisional ones
    set({
      sales: [serverRows.sale, ...get().sales],
      saleItems: [...serverRows.items, ...get().saleItems],
      movements: [...serverRows.movements, ...get().movements],
      auditLogs: [...serverRows.auditLogs, ...get().auditLogs],
    });
    expect(get().sales.map((s: { id: string }) => s.id)).toEqual(["sale-server-2", provisionalId]);

    vi.stubGlobal("navigator", { onLine: true });
    rpc.mockResolvedValue({ data: serverRows, error: null });
    await drainOutbox();

    expect(get().sales.map((s: { id: string }) => s.id)).toEqual(["sale-server-2"]);
    expect(get().saleItems.map((i: { id?: string }) => i.id)).toEqual(["si-server-2"]);
    expect(get().movements.map((m: { id: string }) => m.id)).toEqual(["mv-server-2"]);
    expect(get().auditLogs.map((a: { id: string }) => a.id)).toEqual(["au-server-2"]);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("keeps the provisional sale (flagged, not deleted) and marks the outbox entry a conflict on server rejection", async () => {
    const { get } = makeStore();
    const provisionalId = await get().createSale({ ...baseInput, cartItems: [cartItem()] });

    vi.stubGlobal("navigator", { onLine: true });
    rpc.mockResolvedValue({ data: null, error: { message: "Insufficient stock for Tea Mix" } });

    await drainOutbox();

    expect(get().sales.find((s: { id: string }) => s.id === provisionalId)?.pendingSync).toBe(true);
    const entries = await localDb.syncOutbox.toArray();
    expect(entries[0]).toMatchObject({ status: "conflict", blocksQueue: true });   // not recorded on the server: not final
    expect(entries[0].lastError).toMatch(/NOT recorded.*Insufficient stock for Tea Mix/);
  });
});
