import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    ...slice,
    shifts: [],
    sales: [{ id: "sale-1", shopId: "shop-1", status: "NORMAL" }],
    saleItems: [],
    refunds: [],
    refundVoidRequests: [],
    inventory: [],
    movements: [],
    auditLogs: [],
    ...seed,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) =>
    get().reconcileCompleteSale(data, provisional ?? []));
  registerOutboxReconciler("create_refund_void_request", (data, provisional) =>
    get().reconcileCreateRefundVoidRequest(data, provisional ?? []));
  return { get };
}

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

describe("requestVoid offline", () => {
  it("stages a provisional void request and queues it, with no ref for an already-synced sale", async () => {
    const { get } = makeStore();

    await get().requestVoid({ saleId: "sale-1", reason: "Wrong item", actorId: "user-1" });

    expect(rpc).not.toHaveBeenCalled();
    expect(get().refundVoidRequests[0]).toMatchObject({
      saleId: "sale-1", type: "VOID", status: "REQUESTED", pendingSync: true,
    });
    // Both views stay in sync, same as the online path.
    expect(get().refunds[0].id).toBe(get().refundVoidRequests[0].id);

    const queued = await localDb.syncOutbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0].name).toBe("create_refund_void_request");
    expect(queued[0].refs ?? []).toHaveLength(0);
  });

  it("throws when the sale isn't known locally", async () => {
    const { get } = makeStore({ sales: [] });
    await expect(get().requestVoid({ saleId: "nope", reason: "x", actorId: "user-1" }))
      .rejects.toThrow("Sale not found.");
  });
});

describe("requestRefund offline (Step 6, PFIN-F: refunds are recorded online only)", () => {
  it("is refused before anything is staged, queued or sent", async () => {
    const { get } = makeStore();

    await expect(get().requestRefund({
      saleId: "sale-1", reason: "Damaged", actorId: "user-1",
      items: [{ productId: "p1", qtyUnits: 1, amountMmk: 1000 }],
    })).rejects.toThrow(/Refunds are recorded online only/);

    expect(rpc).not.toHaveBeenCalled();
    expect(get().refundVoidRequests).toHaveLength(0);
    expect(get().refunds).toHaveLength(0);
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(await localDb.refunds.count()).toBe(0);
  });

  it("online, a sale that has not reached the server yet is refused too (no provisional refs for refunds)", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const { get } = makeStore({ sales: [{ id: "sale-local", shopId: "shop-1", status: "NORMAL", pendingSync: true }] });

    await expect(get().requestRefund({
      saleId: "sale-local", reason: "Damaged", actorId: "user-1",
      items: [{ productId: "p1", qtyUnits: 1, amountMmk: 1000 }],
    })).rejects.toThrow(/has not reached the server yet/);

    expect(rpc).not.toHaveBeenCalled();
    expect(await localDb.syncOutbox.count()).toBe(0);
  });
});

describe("reconcileCreateRefundVoidRequest", () => {
  it("replaces the provisional request with the server's once the outbox drains", async () => {
    const { get } = makeStore();
    await get().requestVoid({ saleId: "sale-1", reason: "Wrong item", actorId: "user-1" });
    const provisionalId = get().refundVoidRequests[0].id;

    vi.stubGlobal("navigator", { onLine: true });
    rpc.mockResolvedValue({
      data: { request: { id: "refund-server-1", saleId: "sale-1", type: "VOID", status: "REQUESTED" }, auditLogs: [] },
      error: null,
    });

    await drainOutbox();

    expect(get().refundVoidRequests.map((r: { id: string }) => r.id)).toEqual(["refund-server-1"]);
    expect(get().refunds.map((r: { id: string }) => r.id)).toEqual(["refund-server-1"]);
    expect(await localDb.refunds.get(provisionalId)).toBeUndefined();
  });
});

describe("sale and its void request both created offline in the same session", () => {
  it("waits for the sale to sync before sending the void request, then resolves the ref", async () => {
    const { get } = makeStore({
      sales: [],
      inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
      products: [{ id: "p1", isNonStock: false }],
      productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
      getProductPrice: () => 0,
      getInventoryQty: (shopId: string, productId: string) =>
        get().inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)
          ?.qtyBaseUnits ?? 0,
    });

    const saleId = await get().createSale({
      shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1",
      cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: 5000,
      cartItems: [{ id: "c1", productId: "p1", productUnitId: "u1", name: "Tea", unitName: "Can", qty: 1, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-1" }],
    });
    await get().requestVoid({ saleId, reason: "Changed mind", actorId: "user-1" });

    // Dexie's plain toArray() isn't insertion-ordered — check membership
    // here; actual replay order is asserted below via the rpc call order,
    // which is what drainOutbox's own createdAt sort guarantees.
    expect(new Set((await localDb.syncOutbox.toArray()).map((e) => e.name)))
      .toEqual(new Set(["complete_sale", "create_refund_void_request"]));

    vi.stubGlobal("navigator", { onLine: true });
    rpc.mockImplementation(async (name: string) => {
      if (name === "complete_sale") {
        return {
          data: {
            sale: { id: "sale-server-1", shopId: "shop-1", receiptNo: "R-1" },
            items: [], movements: [], inventory: [], auditLogs: [],
          },
          error: null,
        };
      }
      return { data: { request: { id: "refund-server-1", saleId: "sale-server-1", type: "VOID", status: "REQUESTED" }, auditLogs: [] }, error: null };
    });

    await drainOutbox();

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(2, "create_refund_void_request", expect.objectContaining({ p_sale_id: "sale-server-1" }));
    expect(get().refundVoidRequests[0]).toMatchObject({ id: "refund-server-1", saleId: "sale-server-1" });
  });
});
