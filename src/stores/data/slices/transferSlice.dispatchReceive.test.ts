// Transfers write their outbox row BEFORE sending (Batch 2A write-ahead).
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Flow test: the two-step stock transfer (dispatch → receive) through the data
// store with Supabase mocked. Dispatch must NOT touch inventory ("hold at
// source"); receive moves stock and merges the returned inventory rows. Pins
// the RPC contracts and the state reconcile. See saleSlice.checkout.test.ts
// for the harness rationale.

const rpc = vi.fn();
vi.mock("../../../lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { createTransferSlice } from "./transferSlice";

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
  const slice = createTransferSlice(set as any, get as any, {} as any);
  state = {
    ...slice,
    stockTransfers: [{ id: "tr-1", status: "APPROVED", fromShopId: "shop-a", toShopId: "shop-b" }],
    stockTransferItems: [{ id: "tri-1", stockTransferId: "tr-1", approvedQty: 10 }],
    inventory: [
      { shopId: "shop-a", productId: "p1", qtyBaseUnits: 50 },
      { shopId: "shop-b", productId: "p1", qtyBaseUnits: 0 },
    ],
    movements: [],
    auditLogs: [],
    ...seed,
  };
  return { get };
}

beforeEach(async () => {
  const { localDb } = await import("../../../lib/localDb");
  await localDb.syncOutbox.clear();
});
beforeEach(() => rpc.mockReset());

describe("dispatchTransfer flow", () => {
  it("marks the transfer IN_TRANSIT without changing inventory", async () => {
    rpc.mockResolvedValue({
      data: {
        stockTransfer: { id: "tr-1", status: "IN_TRANSIT", fromShopId: "shop-a", toShopId: "shop-b" },
        stockTransferItems: [{ id: "tri-1", stockTransferId: "tr-1", approvedQty: 10 }],
        auditLogs: [{ id: "au-1" }],
      },
      error: null,
    });
    const { get } = makeStore();
    const before = get().inventory;

    await get().dispatchTransfer({ transferId: "tr-1" });

    expect(rpc.mock.calls[0][0]).toBe("dispatch_stock_transfer");
    // The online call carries the same actor stamp as a queued replay
    // (Batch 2A, Q-M1: identical arguments on both paths).
    expect(rpc.mock.calls[0][1]).toEqual({
      p_transfer_id: "tr-1", p_created_at: expect.any(String), p_idempotency_key: expect.any(String),
      p_expected_actor_id: null,
    });
    expect(get().stockTransfers[0].status).toBe("IN_TRANSIT");
    expect(get().inventory).toEqual(before); // hold at source — no movement yet
  });

  // Batch 2A: an empty reply is an UNKNOWN outcome — kept in doubt with its
  // key; reported as pending confirmation, never as failed.
  it("an empty dispatch reply is an unknown outcome: kept in doubt with its key", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const { get } = makeStore();
    await get().dispatchTransfer({ transferId: "tr-1" }).catch((e: Error) => expect(e.name).toBe("PendingConfirmationError"));
    const { localDb } = await import("../../../lib/localDb");
    const [row] = await localDb.syncOutbox.toArray();
    expect(row).toMatchObject({ name: "dispatch_stock_transfer", status: "pending", inDoubt: true, idempotencyKey: rpc.mock.calls[0][1].p_idempotency_key });
  });
});

describe("receiveTransfer flow", () => {
  const received = {
    stockTransfer: { id: "tr-1", status: "COMPLETED", fromShopId: "shop-a", toShopId: "shop-b" },
    stockTransferItems: [{ id: "tri-1", stockTransferId: "tr-1", approvedQty: 10, receivedQty: 8 }],
    inventory: [
      { shopId: "shop-a", productId: "p1", qtyBaseUnits: 42 }, // source decremented
      { shopId: "shop-b", productId: "p1", qtyBaseUnits: 8 }, // dest incremented
    ],
    movements: [{ id: "mv-out" }, { id: "mv-in" }],
    auditLogs: [{ id: "au-1" }],
  };

  it("moves stock and merges both shops' inventory rows", async () => {
    rpc.mockResolvedValue({ data: received, error: null });
    const { get } = makeStore();

    await get().receiveTransfer({
      transferId: "tr-1",
      receivedItems: [{ productId: "p1", receivedQty: 8 }],
    });

    const [name, params] = rpc.mock.calls[0];
    expect(name).toBe("receive_stock_transfer");
    expect(params.p_transfer_id).toBe("tr-1");
    expect(params.p_received_items).toEqual([{ product_id: "p1", received_qty: 8 }]);

    const state = get();
    expect(state.stockTransfers[0].status).toBe("COMPLETED");
    expect(state.inventory).toHaveLength(2); // merged in place, not duplicated
    expect(state.inventory.find((i: { shopId: string }) => i.shopId === "shop-a").qtyBaseUnits).toBe(42);
    expect(state.inventory.find((i: { shopId: string }) => i.shopId === "shop-b").qtyBaseUnits).toBe(8);
    expect(state.movements).toHaveLength(2);
  });

  it("sends null received items when the caller omits them (receive-all)", async () => {
    rpc.mockResolvedValue({ data: received, error: null });
    const { get } = makeStore();

    await get().receiveTransfer({ transferId: "tr-1" });

    expect(rpc.mock.calls[0][1].p_received_items).toBeNull();
  });

  it("throws the server message on error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Not in transit" } });
    const { get } = makeStore();
    await expect(
      get().receiveTransfer({ transferId: "tr-1", receivedItems: [{ productId: "p1", receivedQty: 8 }] }),
    ).rejects.toThrow("Not in transit");
  });
});
