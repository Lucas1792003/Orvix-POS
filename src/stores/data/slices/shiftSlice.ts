import type { StateCreator } from "zustand";
import type { DataState, ShiftState } from "../types";
import type { AuditLog, Shift } from "../../../types";
import { isNetworkError } from "../../../lib/errors";
import { newId } from "../../../lib/id";
import { enqueueOutbox, recordIdMapping } from "../outbox";
import { beginOperation, callRpc, type OperationContext } from "../idempotentRpc";
import { deleteLocalRows, putLocalRows } from "../localWrites";
import { assertOfflineWriteEligible } from "../../authStore";

interface ShiftRpcResult {
  shift: Shift;
  auditLogs: AuditLog[];
}

const replaceShift = (shifts: Shift[], shift: Shift): Shift[] => {
  const exists = shifts.some((item) => item.id === shift.id);
  if (!exists) return [shift, ...shifts];
  return shifts.map((item) => (item.id === shift.id ? shift : item));
};

export const createShiftSlice: StateCreator<DataState, [], [], ShiftState> = (set, get) => {
  const startShiftOnline = async (shopId: string, openingCashMmk: number, op: OperationContext): Promise<string> => {
    const { data, error } = await callRpc("open_shift", {
      p_shop_id: shopId,
      p_opening_cash_mmk: openingCashMmk,
      p_created_at: op.createdAt,
      p_idempotency_key: op.idempotencyKey,
    });
    if (error) throw error;
    if (!data) throw new Error("Open shift returned no data.");

    const result = data as ShiftRpcResult;
    set((state) => ({
      shifts: replaceShift(state.shifts, result.shift),
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    void putLocalRows({ shifts: [result.shift], auditLogs: result.auditLogs });
    return result.shift.id;
  };

  // No network: open the shift locally and queue open_shift for replay. A
  // sale rung up against this provisional shift (see saleSlice.ts) carries a
  // `refs` entry so it waits for THIS entry's real shift id before sending.
  const startShiftOffline = async (
    shopId: string, cashierId: string, openingCashMmk: number, op: OperationContext,
  ): Promise<string> => {
    await assertOfflineWriteEligible();
    const now = op.createdAt;
    const shift: Shift = {
      id: newId("shift"), shopId, cashierId,
      startedAt: now, openingCashMmk, pendingSync: true, idempotencyKey: op.idempotencyKey,
    };
    set((state) => ({ shifts: [shift, ...state.shifts] }));
    void putLocalRows({ shifts: [shift] });

    await enqueueOutbox({
      kind: "rpc",
      name: "open_shift",
      args: {
        p_shop_id: shopId, p_opening_cash_mmk: openingCashMmk, p_created_at: now,
        p_idempotency_key: op.idempotencyKey,
      },
      idempotencyKey: op.idempotencyKey,
      shopId,
      provisional: [{ table: "shifts", ids: [shift.id] }],
    });

    return shift.id;
  };

  const endShiftOnline = async (
    shiftId: string, closingCashMmk: number, varianceReason: string | undefined, op: OperationContext,
  ): Promise<void> => {
    const { data, error } = await callRpc("close_shift", {
      p_shift_id: shiftId,
      p_closing_cash_mmk: closingCashMmk,
      p_variance_reason: varianceReason ?? null,
      p_created_at: op.createdAt,
      p_idempotency_key: op.idempotencyKey,
    });
    if (error) throw error;
    if (!data) throw new Error("Close shift returned no data.");

    const result = data as ShiftRpcResult;
    set((state) => ({
      shifts: replaceShift(state.shifts, result.shift),
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    void putLocalRows({ shifts: [result.shift], auditLogs: result.auditLogs });
  };

  // No network: close the shift locally, approximating expected cash from
  // this device's own sales/refunds for the shift the same way close_shift
  // does server-side. The server is still the final say — a mismatch once
  // it actually runs (e.g. a sale from another device syncs first) surfaces
  // there like any other conflict.
  const endShiftOffline = async (
    shiftId: string, closingCashMmk: number, varianceReason: string | undefined, op: OperationContext,
  ): Promise<void> => {
    await assertOfflineWriteEligible();
    const shift = get().shifts.find((s) => s.id === shiftId);
    if (!shift) throw new Error("Shift not found.");

    const shiftSaleIds = new Set(get().sales.filter((s) => s.shiftId === shiftId).map((s) => s.id));
    const cashSales = get().sales
      .filter((s) => s.shiftId === shiftId && s.paymentMethod === "CASH" && s.status !== "VOID")
      .reduce((sum, s) => sum + s.totalMmk, 0);
    const cashRefunds = get().refunds
      .filter((r) => shiftSaleIds.has(r.saleId) && r.type === "PARTIAL" && r.status === "APPROVED")
      .flatMap((r) => r.items ?? [])
      .reduce((sum, item) => sum + item.amountMmk, 0);

    const expectedCashMmk = shift.openingCashMmk + cashSales - cashRefunds;
    const varianceMmk = closingCashMmk - expectedCashMmk;
    if (varianceMmk !== 0 && !varianceReason?.trim()) {
      throw new Error("Variance reason is required when closing cash does not match expected cash.");
    }

    const now = op.createdAt;
    const closedShift: Shift = {
      ...shift, endedAt: now, closingCashMmk,
      expectedCashMmk, varianceMmk, varianceReason: varianceReason?.trim() || undefined,
      pendingSync: true, idempotencyKey: op.idempotencyKey,
    };
    set((state) => ({ shifts: replaceShift(state.shifts, closedShift) }));
    void putLocalRows({ shifts: [closedShift] });

    await enqueueOutbox({
      kind: "rpc",
      name: "close_shift",
      args: {
        p_shift_id: shiftId, p_closing_cash_mmk: closingCashMmk,
        p_variance_reason: varianceReason ?? null, p_created_at: now,
        p_idempotency_key: op.idempotencyKey,
      },
      idempotencyKey: op.idempotencyKey,
      shopId: shift.shopId,
      // If this shift was itself opened offline and hasn't synced yet, wait
      // for its real id before sending — see resolveArgs() in outbox.ts.
      refs: shift.pendingSync ? [{ field: "p_shift_id", provisionalId: shiftId }] : undefined,
    });
  };

  return {
    shifts: [],

    startShift: async ({ shopId, cashierId, openingCashMmk }) => {
      const existing = get().shifts.find((shift) => shift.cashierId === cashierId && !shift.endedAt);
      if (existing) return existing.id;

      const op = beginOperation();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return startShiftOffline(shopId, cashierId, openingCashMmk, op);
      }
      try {
        return await startShiftOnline(shopId, openingCashMmk, op);
      } catch (err) {
        if (isNetworkError(err)) return startShiftOffline(shopId, cashierId, openingCashMmk, op);
        throw err;
      }
    },

    endShift: async ({ shiftId, closingCashMmk, varianceReason }) => {
      const op = beginOperation();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return endShiftOffline(shiftId, closingCashMmk, varianceReason, op);
      }
      try {
        return await endShiftOnline(shiftId, closingCashMmk, varianceReason, op);
      } catch (err) {
        if (isNetworkError(err)) return endShiftOffline(shiftId, closingCashMmk, varianceReason, op);
        throw err;
      }
    },

    // Called by the outbox once a queued open_shift actually runs — swaps
    // the provisional shift for the server's authoritative one and records
    // the id mapping so anything else queued against it (a sale, the
    // matching close_shift) resolves on its next drain pass.
    reconcileOpenShift: (data, provisional) => {
      const result = data as ShiftRpcResult;
      const provisionalId = provisional.find((p) => p.table === "shifts")?.ids[0];

      set((state) => ({
        shifts: [result.shift, ...state.shifts.filter((s) => s.id !== provisionalId)],
      }));
      void deleteLocalRows(provisional);
      void putLocalRows({ shifts: [result.shift], auditLogs: result.auditLogs });
      if (provisionalId) void recordIdMapping(provisionalId, result.shift.id);
    },

    // Called by the outbox once a queued close_shift actually runs — the
    // shift's own id never changes (close_shift updates the existing row),
    // just replaces the provisional numbers with the server's real ones.
    reconcileCloseShift: (data) => {
      const result = data as ShiftRpcResult;
      set((state) => ({
        shifts: replaceShift(state.shifts, result.shift),
        auditLogs: [...result.auditLogs, ...state.auditLogs],
      }));
      void putLocalRows({ shifts: [result.shift], auditLogs: result.auditLogs });
    },

    requireShiftForCashier: (shopId: string, cashierId: string) =>
      get().shifts.find((shift) => shift.shopId === shopId && shift.cashierId === cashierId && !shift.endedAt),
  };
};
