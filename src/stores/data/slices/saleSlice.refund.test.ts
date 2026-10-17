import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Flow test: refund/void approval through the data store with Supabase mocked.
// approveRefund routes to a different RPC by request type (VOID vs PARTIAL),
// then reconciles the request, the sale, and inventory from the result. Pins
// that routing + reconcile. See saleSlice.checkout.test.ts for the harness.

const rpc = vi.fn();
vi.mock("../../../lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { createSaleSlice } from "./saleSlice";

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
    sales: [{ id: "sale-1", status: "COMPLETED" }],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 90 }],
    movements: [],
    auditLogs: [],
    ...seed,
  };
  return { get };
}

beforeEach(() => rpc.mockReset());

describe("approveRefund flow", () => {
  it("routes a VOID request to approve_void_request and updates the sale", async () => {
    rpc.mockResolvedValue({
      data: {
        request: { id: "req-1", type: "VOID", status: "APPROVED" },
        sale: { id: "sale-1", status: "VOIDED" },
        movements: [{ id: "mv-1" }],
        inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 100 }],
        auditLogs: [{ id: "au-1" }],
      },
      error: null,
    });
    const { get } = makeStore({
      refundVoidRequests: [{ id: "req-1", type: "VOID", status: "PENDING" }],
      refunds: [{ id: "req-1", type: "VOID", status: "PENDING" }],
    });

    await get().approveRefund({ refundId: "req-1" });

    expect(rpc.mock.calls[0][0]).toBe("approve_void_request");
    expect(rpc.mock.calls[0][1]).toEqual({ p_request_id: "req-1", p_idempotency_key: expect.any(String) });
    const state = get();
    expect(state.sales[0].status).toBe("VOIDED");
    expect(state.inventory[0].qtyBaseUnits).toBe(100); // restocked, merged in place
    expect(state.refundVoidRequests[0].status).toBe("APPROVED");
  });

  it("routes a PARTIAL request to approve_refund_request", async () => {
    rpc.mockResolvedValue({
      data: {
        request: { id: "req-2", type: "PARTIAL", status: "APPROVED" },
        sale: { id: "sale-1", status: "COMPLETED" },
        movements: [],
        inventory: [],
        auditLogs: [{ id: "au-2" }],
      },
      error: null,
    });
    const { get } = makeStore({
      refundVoidRequests: [{ id: "req-2", type: "PARTIAL", status: "PENDING" }],
      refunds: [{ id: "req-2", type: "PARTIAL", status: "PENDING" }],
    });

    await get().approveRefund({ refundId: "req-2" });

    expect(rpc.mock.calls[0][0]).toBe("approve_refund_request");
  });

  it("throws when the request id is unknown", async () => {
    const { get } = makeStore({ refundVoidRequests: [], refunds: [] });
    await expect(get().approveRefund({ refundId: "nope" })).rejects.toThrow(
      "Refund or void request not found.",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("throws the server message on error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Already approved" } });
    const { get } = makeStore({
      refundVoidRequests: [{ id: "req-1", type: "VOID", status: "PENDING" }],
      refunds: [],
    });
    await expect(get().approveRefund({ refundId: "req-1" })).rejects.toThrow("Already approved");
  });
});

describe("rejectRefund (Batch 1-code: existing reject_refund_void_request, now reachable from the UI)", () => {
  it("calls reject_refund_void_request with the reason and an idempotency key, and updates the request", async () => {
    rpc.mockResolvedValue({
      data: { request: { id: "req-2", type: "PARTIAL", status: "REJECTED", saleId: "sale-1" }, auditLogs: [{ id: "au-9" }] },
      error: null,
    });
    const { get } = makeStore({
      refundVoidRequests: [{ id: "req-2", type: "PARTIAL", status: "REQUESTED" }],
      refunds: [{ id: "req-2", type: "PARTIAL", status: "REQUESTED" }],
    });
    await get().rejectRefund({ refundId: "req-2", reason: "Wrong amount" });
    expect(rpc.mock.calls[0][0]).toBe("reject_refund_void_request");
    expect(rpc.mock.calls[0][1]).toEqual({ p_request_id: "req-2", p_reason: "Wrong amount", p_idempotency_key: expect.any(String) });
    expect(get().refundVoidRequests.find((r: { id: string }) => r.id === "req-2").status).toBe("REJECTED");
    expect(get().refunds.find((r: { id: string }) => r.id === "req-2").status).toBe("REJECTED");
    expect(get().auditLogs[0].id).toBe("au-9");
    // the sale and stock are untouched by a rejection
    expect(get().sales).toEqual([{ id: "sale-1", status: "COMPLETED" }]);
    expect(get().inventory).toEqual([{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 90 }]);
  });

  it("surfaces the server's refusal and changes nothing", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Request is not pending", code: "P0001" } });
    const { get } = makeStore({ refundVoidRequests: [{ id: "req-3", type: "PARTIAL", status: "APPROVED" }], refunds: [] });
    await expect(get().rejectRefund({ refundId: "req-3", reason: "x" })).rejects.toMatchObject({ message: "Request is not pending" });
    expect(get().refundVoidRequests[0].status).toBe("APPROVED");
  });
});
