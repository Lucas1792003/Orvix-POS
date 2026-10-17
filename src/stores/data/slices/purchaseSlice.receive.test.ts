// Receiving writes its outbox row BEFORE sending (Batch 2A write-ahead).
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Flow test: PO receiving through the data store with Supabase mocked. Pins the
// receive_purchase_order payload (base-qty vs unit-aware line shapes), the RPC
// contract, and the state reconcile (PO + line items replaced, inventory
// merged, movements/audit prepended). See saleSlice.checkout.test.ts for the
// harness rationale.

const rpc = vi.fn();
vi.mock("../../../lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  dbExec: vi.fn(),
}));

import { createPurchaseSlice } from "./purchaseSlice";

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
  const slice = createPurchaseSlice(set as any, get as any, {} as any);
  state = {
    ...slice,
    purchaseOrders: [{ id: "po-1", status: "APPROVED", totalMmk: 0 }],
    purchaseOrderItems: [{ id: "poi-1", purchaseOrderId: "po-1", orderedQty: 10, receivedQty: 0 }],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 5 }],
    movements: [],
    auditLogs: [],
    ...seed,
  };
  return { get };
}

const result = {
  purchaseOrder: { id: "po-1", status: "RECEIVED", totalMmk: 7000 },
  purchaseOrderItems: [{ id: "poi-1", purchaseOrderId: "po-1", orderedQty: 10, receivedQty: 7 }],
  inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 12 }],
  movements: [{ id: "mv-1" }],
  auditLogs: [{ id: "au-1" }],
};

beforeEach(async () => {
  const { localDb } = await import("../../../lib/localDb");
  await localDb.syncOutbox.clear();
});
beforeEach(() => rpc.mockReset());

describe("receivePurchaseOrder flow", () => {
  it("calls receive_purchase_order with the base-qty line shape", async () => {
    rpc.mockResolvedValue({ data: result, error: null });
    const { get } = makeStore();

    await get().receivePurchaseOrder({
      purchaseOrderId: "po-1",
      receivedItems: [{ productId: "p1", receivedQty: 7 }],
    });

    const [name, params] = rpc.mock.calls[0];
    expect(name).toBe("receive_purchase_order");
    expect(params.p_purchase_order_id).toBe("po-1");
    expect(params.p_received_items[0]).toMatchObject({
      product_id: "p1",
      received_qty: 7,
      product_unit_id: null,
      received_unit_qty: null,
    });
  });

  it("forwards the unit-aware line shape when provided", async () => {
    rpc.mockResolvedValue({ data: result, error: null });
    const { get } = makeStore();

    await get().receivePurchaseOrder({
      purchaseOrderId: "po-1",
      receivedItems: [{ productId: "p1", productUnitId: "u-case", receivedUnitQty: 2 }],
    });

    expect(rpc.mock.calls[0][1].p_received_items[0]).toMatchObject({
      product_id: "p1",
      received_qty: null,
      product_unit_id: "u-case",
      received_unit_qty: 2,
    });
  });

  it("reconciles the PO, line items and inventory from the result", async () => {
    rpc.mockResolvedValue({ data: result, error: null });
    const { get } = makeStore();

    await get().receivePurchaseOrder({
      purchaseOrderId: "po-1",
      receivedItems: [{ productId: "p1", receivedQty: 7 }],
    });

    const state = get();
    expect(state.purchaseOrders[0]).toMatchObject({ status: "RECEIVED", totalMmk: 7000 });
    expect(state.purchaseOrderItems[0].receivedQty).toBe(7);
    expect(state.inventory).toHaveLength(1); // merged in place
    expect(state.inventory[0].qtyBaseUnits).toBe(12);
    expect(state.movements[0].id).toBe("mv-1");
    expect(state.auditLogs[0].id).toBe("au-1");
  });

  it("throws the server message on error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "PO already received" } });
    const { get } = makeStore();
    await expect(
      get().receivePurchaseOrder({ purchaseOrderId: "po-1", receivedItems: [{ productId: "p1", receivedQty: 7 }] }),
    ).rejects.toThrow("PO already received");
  });

  // Batch 2A: an empty reply is an UNKNOWN outcome. With no local PO to
  // stage against (this harness), the durable row is still kept — pending,
  // in doubt, same key — and the user is told it is pending confirmation,
  // never that it failed.
  it("an empty reply is an unknown outcome: kept in doubt with its key, reported as pending confirmation", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const { get } = makeStore();
    await expect(
      get().receivePurchaseOrder({ purchaseOrderId: "po-1", receivedItems: [{ productId: "p1", receivedQty: 7 }] }),
    ).rejects.toMatchObject({ name: "PendingConfirmationError" });
    const { localDb } = await import("../../../lib/localDb");
    const [row] = await localDb.syncOutbox.toArray();
    expect(row).toMatchObject({ name: "receive_purchase_order", status: "pending", inDoubt: true, idempotencyKey: rpc.mock.calls[0][1].p_idempotency_key });
  });
});
