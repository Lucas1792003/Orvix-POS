import type { StateCreator } from "zustand";
import type { DataState, TransferState, CreateTransferInput } from "../types";
import type {
  AuditLog, Inventory, InventoryMovement, StockTransfer, StockTransferItem,
} from "../../../types";
import { isNetworkError } from "../../../lib/errors";
import { newId } from "../../../lib/id";
import { enqueueOutbox } from "../outbox";
import {
  beginOperation, callRpc, newIdempotencyKey, ONLINE_ONLY_RETRIES, type OperationContext,
} from "../idempotentRpc";
import { deleteLocalRows, putLocalRows } from "../localWrites";
import { assertOfflineWriteEligible } from "../../authStore";

// ---- RPC result shapes (camelCase, ready for the store) ----
interface CreateTransferResult {
  stockTransfer: StockTransfer;
  stockTransferItems: StockTransferItem[];
  auditLogs: AuditLog[];
}
interface ApproveTransferResult {
  stockTransfer: StockTransfer;
  stockTransferItems: StockTransferItem[];
  auditLogs: AuditLog[];
}
interface TransferStatusResult {
  stockTransfer: StockTransfer;
  auditLogs: AuditLog[];
}
interface CompleteTransferResult {
  stockTransfer: StockTransfer;
  stockTransferItems: StockTransferItem[];
  inventory: Inventory[];
  movements: InventoryMovement[];
  auditLogs: AuditLog[];
}

// Merge RPC-returned inventory rows into the current store array.
const mergeInventory = (current: Inventory[], updates: Inventory[]): Inventory[] => {
  const result = [...current];
  for (const u of updates) {
    const idx = result.findIndex((i) => i.shopId === u.shopId && i.productId === u.productId);
    if (idx >= 0) result[idx] = { ...result[idx], qtyBaseUnits: u.qtyBaseUnits };
    else result.push(u);
  }
  return result;
};

export const createTransferSlice: StateCreator<DataState, [], [], TransferState> = (set, get) => {
  // Dispatch: source releases the goods. Marks the transfer IN_TRANSIT with
  // no inventory change ("hold at source" — stock only moves on receipt).
  const dispatchTransferOnline = async (transferId: string, op: OperationContext): Promise<void> => {
    const { data, error } = await callRpc("dispatch_stock_transfer", {
      p_transfer_id: transferId,
      p_created_at: op.createdAt,
      p_idempotency_key: op.idempotencyKey,
    });
    if (error) throw error;
    if (!data) throw new Error("Dispatch transfer returned no data.");
    const result = data as ApproveTransferResult;

    set((s) => ({
      stockTransfers: s.stockTransfers.map((t) => (t.id === result.stockTransfer.id ? result.stockTransfer : t)),
      stockTransferItems: s.stockTransferItems.map((i) => result.stockTransferItems.find((u) => u.id === i.id) ?? i),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    void putLocalRows({ stockTransfers: [result.stockTransfer], stockTransferItems: result.stockTransferItems, auditLogs: result.auditLogs });
  };

  // No network: no stock moves on dispatch (only on receipt), so this is
  // just a status flip — nothing to approximate. The transfer this
  // references is assumed to already have a real id (creation/approval stay
  // online-only).
  const dispatchTransferOffline = async (transferId: string, actorId: string, op: OperationContext): Promise<void> => {
    await assertOfflineWriteEligible();
    const transfer = get().stockTransfers.find((t) => t.id === transferId);
    if (!transfer) throw new Error("Stock transfer not found.");
    if (transfer.status !== "APPROVED") {
      throw new Error(`Transfer cannot be dispatched from status ${transfer.status}.`);
    }

    const now = op.createdAt;
    const updated: StockTransfer = {
      ...transfer, status: "IN_TRANSIT", dispatchedBy: actorId,
      dispatchedAt: now, pendingSync: true, idempotencyKey: op.idempotencyKey,
    };
    set((s) => ({ stockTransfers: s.stockTransfers.map((t) => (t.id === transferId ? updated : t)) }));
    void putLocalRows({ stockTransfers: [updated] });

    await enqueueOutbox({
      kind: "rpc", name: "dispatch_stock_transfer",
      args: { p_transfer_id: transferId, p_created_at: now, p_idempotency_key: op.idempotencyKey },
      idempotencyKey: op.idempotencyKey,
      shopId: transfer.fromShopId,
    });
  };

  // Receive: destination confirms receipt; atomic RPC moves stock (source →
  // dest) for the received quantities and writes paired movements.
  const receiveTransferOnline = async (
    transferId: string, receivedItems: { productId: string; receivedQty: number }[] | undefined, op: OperationContext,
  ): Promise<void> => {
    const { data, error } = await callRpc("receive_stock_transfer", {
      p_transfer_id: transferId,
      p_received_items: receivedItems ? receivedItems.map((r) => ({ product_id: r.productId, received_qty: r.receivedQty })) : null,
      p_created_at: op.createdAt,
      p_idempotency_key: op.idempotencyKey,
    });
    if (error) throw error;
    if (!data) throw new Error("Receive transfer returned no data.");
    const result = data as CompleteTransferResult;

    set((s) => ({
      stockTransfers: s.stockTransfers.map((t) => (t.id === result.stockTransfer.id ? result.stockTransfer : t)),
      stockTransferItems: s.stockTransferItems.map((i) => result.stockTransferItems.find((u) => u.id === i.id) ?? i),
      inventory: mergeInventory(s.inventory, result.inventory),
      movements: [...result.movements, ...s.movements],
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    void putLocalRows({
      stockTransfers: [result.stockTransfer], stockTransferItems: result.stockTransferItems,
      inventory: result.inventory, movements: result.movements, auditLogs: result.auditLogs,
    });
  };

  // No network: receive against locally-known data, mirroring
  // receive_stock_transfer's own math (clamp to the approved qty, move
  // source → dest, write paired OUT/IN movements). The transfer this
  // references is assumed to already have a real id.
  const receiveTransferOffline = async (
    transferId: string, actorId: string, receivedItems: { productId: string; receivedQty: number }[] | undefined,
    op: OperationContext,
  ): Promise<void> => {
    await assertOfflineWriteEligible();
    const transfer = get().stockTransfers.find((t) => t.id === transferId);
    if (!transfer) throw new Error("Stock transfer not found.");
    if (transfer.status !== "IN_TRANSIT") {
      throw new Error(`Transfer cannot be received from status ${transfer.status}.`);
    }

    const now = op.createdAt;
    const lines = get().stockTransferItems.filter((i) => i.transferId === transferId);
    const inputByProduct = new Map((receivedItems ?? []).map((r) => [r.productId, r.receivedQty]));

    const updatedItems: StockTransferItem[] = [];
    const movements: InventoryMovement[] = [];
    const inventoryUpdates: Inventory[] = [];

    for (const item of lines) {
      const approved = item.approvedQty ?? item.requestedQty;
      const qty = inputByProduct.get(item.productId) ?? approved;
      if (qty < 0 || qty > approved) {
        throw new Error(`Received quantity for a line must be between 0 and the approved quantity.`);
      }
      updatedItems.push({ ...item, transferredQty: qty });
      if (qty === 0) continue;

      const srcBefore = get().getInventoryQty(transfer.fromShopId, item.productId);
      const srcAfter = srcBefore - qty;
      if (srcAfter < 0) {
        throw new Error(`Insufficient stock at source for this product: have ${srcBefore}, need ${qty}.`);
      }
      const dstBefore = get().getInventoryQty(transfer.toShopId, item.productId);
      const dstAfter = dstBefore + qty;
      inventoryUpdates.push({ shopId: transfer.fromShopId, productId: item.productId, qtyBaseUnits: srcAfter });
      inventoryUpdates.push({ shopId: transfer.toShopId, productId: item.productId, qtyBaseUnits: dstAfter });

      const unitFields = {
        productUnitId: item.productUnitId, unitNameSnapshot: item.unitNameSnapshot,
        unitBaseQuantitySnapshot: item.unitBaseQuantitySnapshot, selectedUnitQuantity: item.selectedUnitQuantity,
      };
      movements.push({
        id: newId("move"), shopId: transfer.fromShopId, productId: item.productId, type: "TRANSFER_OUT",
        qtyChange: -qty, qtyBefore: srcBefore, qtyAfter: srcAfter,
        reason: `Stock transfer ${transfer.transferNo} (offline — pending sync)`,
        referenceType: "transfer", referenceId: transfer.id, createdBy: actorId, createdAt: now,
        pendingSync: true, idempotencyKey: op.idempotencyKey, ...unitFields,
      });
      movements.push({
        id: newId("move"), shopId: transfer.toShopId, productId: item.productId, type: "TRANSFER_IN",
        qtyChange: qty, qtyBefore: dstBefore, qtyAfter: dstAfter,
        reason: `Stock transfer ${transfer.transferNo} (offline — pending sync)`,
        referenceType: "transfer", referenceId: transfer.id, createdBy: actorId, createdAt: now,
        pendingSync: true, idempotencyKey: op.idempotencyKey, ...unitFields,
      });
    }

    const updatedTransfer: StockTransfer = {
      ...transfer, status: "COMPLETED", receivedBy: actorId, receivedAt: now, completedAt: now,
      pendingSync: true, idempotencyKey: op.idempotencyKey,
    };

    set((s) => ({
      stockTransfers: s.stockTransfers.map((t) => (t.id === transferId ? updatedTransfer : t)),
      stockTransferItems: s.stockTransferItems.map((i) => updatedItems.find((u) => u.id === i.id) ?? i),
      inventory: mergeInventory(s.inventory, inventoryUpdates),
      movements: [...movements, ...s.movements],
    }));
    void putLocalRows({
      stockTransfers: [updatedTransfer], stockTransferItems: updatedItems,
      inventory: inventoryUpdates, movements,
    });

    await enqueueOutbox({
      kind: "rpc",
      name: "receive_stock_transfer",
      args: {
        p_transfer_id: transferId,
        p_received_items: receivedItems ? receivedItems.map((r) => ({ product_id: r.productId, received_qty: r.receivedQty })) : null,
        p_created_at: now,
        p_idempotency_key: op.idempotencyKey,
      },
      idempotencyKey: op.idempotencyKey,
      shopId: transfer.toShopId,
      provisional: [{ table: "movements", ids: movements.map((m) => m.id) }],
    });
  };

  return {
  stockTransfers: [],
  stockTransferItems: [],

  // Transfer creation: atomic RPC (validates permission, shop scope, stock).
  createTransfer: async ({ fromShopId, toShopId, items, notes }: CreateTransferInput) => {
    const { data, error } = await callRpc("create_stock_transfer", {
      p_from_shop_id: fromShopId,
      p_to_shop_id: toShopId,
      p_notes: notes ?? null,
      p_items: items.map((i) => ({
        product_id: i.productId,
        requested_qty: i.requestedQty ?? null,
        product_unit_id: i.productUnitId ?? null,
        selected_unit_quantity: i.selectedUnitQuantity ?? null,
      })),
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Create transfer returned no data.");
    const result = data as CreateTransferResult;

    set((s) => ({
      stockTransfers: [result.stockTransfer, ...s.stockTransfers],
      stockTransferItems: [...result.stockTransferItems, ...s.stockTransferItems],
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    return result.stockTransfer.id;
  },

  approveTransfer: async ({ transferId }) => {
    const { data, error } = await callRpc(
      "approve_stock_transfer",
      { p_transfer_id: transferId, p_idempotency_key: newIdempotencyKey() },
      { retries: ONLINE_ONLY_RETRIES },
    );
    if (error) throw error;
    if (!data) throw new Error("Approve transfer returned no data.");
    const result = data as ApproveTransferResult;

    set((s) => ({
      stockTransfers: s.stockTransfers.map((t) =>
        t.id === result.stockTransfer.id ? result.stockTransfer : t
      ),
      stockTransferItems: s.stockTransferItems.map(
        (i) => result.stockTransferItems.find((u) => u.id === i.id) ?? i
      ),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
  },

  rejectTransfer: async ({ transferId, reason }) => {
    const { data, error } = await callRpc("reject_stock_transfer", {
      p_transfer_id: transferId,
      p_reason: reason,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Reject transfer returned no data.");
    const result = data as TransferStatusResult;

    set((s) => ({
      stockTransfers: s.stockTransfers.map((t) =>
        t.id === result.stockTransfer.id ? result.stockTransfer : t
      ),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
  },

  dispatchTransfer: async ({ transferId, actorId }) => {
    const op = beginOperation();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return dispatchTransferOffline(transferId, actorId, op);
    }
    try {
      return await dispatchTransferOnline(transferId, op);
    } catch (err) {
      if (isNetworkError(err)) return dispatchTransferOffline(transferId, actorId, op);
      throw err;
    }
  },

  receiveTransfer: async ({ transferId, actorId, receivedItems }) => {
    const op = beginOperation();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return receiveTransferOffline(transferId, actorId, receivedItems, op);
    }
    try {
      return await receiveTransferOnline(transferId, receivedItems, op);
    } catch (err) {
      if (isNetworkError(err)) return receiveTransferOffline(transferId, actorId, receivedItems, op);
      throw err;
    }
  },

  // Called by the outbox once a queued dispatch actually runs — dispatch
  // never touches inventory, so this just replaces the provisional status.
  reconcileDispatchTransfer: (data) => {
    const result = data as ApproveTransferResult;
    set((s) => ({
      stockTransfers: s.stockTransfers.map((t) => (t.id === result.stockTransfer.id ? result.stockTransfer : t)),
      stockTransferItems: s.stockTransferItems.map((i) => result.stockTransferItems.find((u) => u.id === i.id) ?? i),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    void putLocalRows({ stockTransfers: [result.stockTransfer], stockTransferItems: result.stockTransferItems, auditLogs: result.auditLogs });
  },

  // Called by the outbox once a queued receive actually runs — swaps the
  // provisional OUT/IN movements for the server's authoritative ones.
  reconcileReceiveTransfer: (data, provisional) => {
    const result = data as CompleteTransferResult;
    const provisionalMovementIds = new Set(provisional.find((p) => p.table === "movements")?.ids ?? []);

    set((s) => ({
      stockTransfers: s.stockTransfers.map((t) => (t.id === result.stockTransfer.id ? result.stockTransfer : t)),
      stockTransferItems: s.stockTransferItems.map((i) => result.stockTransferItems.find((u) => u.id === i.id) ?? i),
      inventory: mergeInventory(s.inventory, result.inventory),
      movements: [...result.movements, ...s.movements.filter((m) => !provisionalMovementIds.has(m.id))],
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    void deleteLocalRows(provisional);
    void putLocalRows({
      stockTransfers: [result.stockTransfer], stockTransferItems: result.stockTransferItems,
      inventory: result.inventory, movements: result.movements, auditLogs: result.auditLogs,
    });
  },

  cancelTransfer: async ({ transferId, reason }) => {
    const { data, error } = await callRpc("cancel_stock_transfer", {
      p_transfer_id: transferId,
      p_reason: reason,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Cancel transfer returned no data.");
    const result = data as TransferStatusResult;

    set((s) => ({
      stockTransfers: s.stockTransfers.map((t) =>
        t.id === result.stockTransfer.id ? result.stockTransfer : t
      ),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
  },

  getTransfersByShop: (shopId: string) =>
    get().stockTransfers.filter((t) => t.fromShopId === shopId || t.toShopId === shopId),

  getPendingTransfersForApproval: (shopId: string) =>
    get().stockTransfers.filter((t) => t.fromShopId === shopId && t.status === "PENDING"),
  };
};
