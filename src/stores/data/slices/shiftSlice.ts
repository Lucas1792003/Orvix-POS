import type { StateCreator } from "zustand";
import type { DataState, ShiftState } from "../types";
import type { AuditLog, Shift } from "../../../types";
import { newId } from "../../../lib/id";
import { recordIdMapping } from "../outbox";
import { beginOperation, type OperationContext } from "../idempotentRpc";
import { Stage, submitOfflineCapable } from "../writeAhead";
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
  // The ONE argument builders for open_shift / close_shift (online and queued).
  const openArgs = (shopId: string, openingCashMmk: number, op: OperationContext) => ({
    p_shop_id: shopId, p_opening_cash_mmk: openingCashMmk, p_created_at: op.createdAt,
    p_idempotency_key: op.idempotencyKey,
  });
  const closeArgs = (shiftId: string, closingCashMmk: number, varianceReason: string | undefined, op: OperationContext) => ({
    p_shift_id: shiftId, p_closing_cash_mmk: closingCashMmk, p_variance_reason: varianceReason ?? null,
    p_created_at: op.createdAt, p_idempotency_key: op.idempotencyKey,
  });

  const applyShift = async (data: unknown): Promise<string> => {
    const result = data as ShiftRpcResult;
    set((state) => ({
      shifts: replaceShift(state.shifts, result.shift),
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    await putLocalRows({ shifts: [result.shift], auditLogs: result.auditLogs });
    return result.shift.id;
  };

  // No network: open the shift locally and queue open_shift for replay. A
  // sale rung up against this provisional shift (see saleSlice.ts) carries a
  // `refs` entry so it waits for THIS entry's real shift id before sending.
  const stageOpenShift = async (
    shopId: string, cashierId: string, openingCashMmk: number, op: OperationContext, stage: Stage,
  ): Promise<string> => {
    await assertOfflineWriteEligible();
    const now = op.createdAt;
    const shift: Shift = {
      id: newId("shift"), shopId, cashierId,
      startedAt: now, openingCashMmk, pendingSync: true, idempotencyKey: op.idempotencyKey,
    };
    stage.set((state: DataState) => ({ shifts: [shift, ...state.shifts] }));
    stage.put({ shifts: [shift] });

    stage.enqueue({
      kind: "rpc",
      name: "open_shift",
      args: openArgs(shopId, openingCashMmk, op),
      idempotencyKey: op.idempotencyKey,
      shopId,
      provisional: [{ table: "shifts", ids: [shift.id] }],
    });

    return shift.id;
  };

  // No network: close the shift locally, approximating expected cash from
  // this device's own sales/refunds for the shift the same way close_shift
  // does server-side. The server is still the final say — a mismatch once
  // it actually runs (e.g. a sale from another device syncs first) surfaces
  // there like any other conflict.
  const stageCloseShift = async (
    shiftId: string, closingCashMmk: number, varianceReason: string | undefined, op: OperationContext, stage: Stage,
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
    stage.set((state: DataState) => ({ shifts: replaceShift(state.shifts, closedShift) }));
    stage.put({ shifts: [closedShift] });

    stage.enqueue({
      kind: "rpc",
      name: "close_shift",
      args: closeArgs(shiftId, closingCashMmk, varianceReason, op),
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
      return submitOfflineCapable({
        set, name: "open_shift", shopId, op, args: openArgs(shopId, openingCashMmk, op),
        applyOnline: applyShift,
        stage: (stage) => stageOpenShift(shopId, cashierId, openingCashMmk, op, stage),
      });
    },

    endShift: async ({ shiftId, closingCashMmk, varianceReason }) => {
      const op = beginOperation();
      const shift = get().shifts.find((s) => s.id === shiftId);
      await submitOfflineCapable({
        set, name: "close_shift", shopId: shift?.shopId ?? null, op,
        args: closeArgs(shiftId, closingCashMmk, varianceReason, op),
        needsProvisionalRefs: shift?.pendingSync === true,
        applyOnline: async (data) => { await applyShift(data); },
        stage: (stage) => stageCloseShift(shiftId, closingCashMmk, varianceReason, op, stage),
      });
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
