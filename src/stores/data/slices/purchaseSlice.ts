import type { StateCreator } from "zustand";
import type { DataState, PurchaseState, CreatePurchaseOrderInput, CreateSupplierInput } from "../types";
import type {
  AuditLog, Inventory, InventoryMovement, PurchaseOrder, PurchaseOrderItem,
  Supplier, SupplierPayment,
} from "../../../types";
import { isNetworkError } from "../../../lib/errors";
import { newId } from "../../../lib/id";
import { useAuthStore, assertOfflineWriteEligible } from "../../authStore";
import { enqueueOutbox } from "../outbox";
import { deleteLocalRows, putLocalRows } from "../localWrites";
import {
  beginOperation, callRpc, newIdempotencyKey, ONLINE_ONLY_RETRIES, type OperationContext,
} from "../idempotentRpc";

// Shape returned by the receive_purchase_order RPC (camelCase keys).
interface ReceivePurchaseOrderResult {
  purchaseOrder: PurchaseOrder;
  purchaseOrderItems: PurchaseOrderItem[];
  inventory: Inventory[];
  movements: InventoryMovement[];
  auditLogs: AuditLog[];
}

interface CreatePurchaseOrderResult {
  purchaseOrder: PurchaseOrder;
  purchaseOrderItems: PurchaseOrderItem[];
  auditLogs: AuditLog[];
}

interface PurchaseOrderStatusResult {
  purchaseOrder: PurchaseOrder;
  auditLogs: AuditLog[];
}

interface RecordSupplierPaymentResult {
  purchaseOrder: PurchaseOrder;
  supplierPayment: SupplierPayment;
  auditLogs: AuditLog[];
}

interface SupplierResult {
  supplier: Supplier;
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

export const createPurchaseSlice: StateCreator<DataState, [], [], PurchaseState> = (set, get) => {
  // Purchase receiving: a single atomic Supabase RPC. The database validates
  // permission, shop scope and the PO status, then writes the PO status,
  // received quantities (billed at received value), inventory, movements
  // and audit row in one transaction.
  const receivePurchaseOrderOnline = async (
    purchaseOrderId: string,
    receivedItems: { productId: string; receivedQty?: number; productUnitId?: string; receivedUnitQty?: number }[],
    op: OperationContext,
  ): Promise<void> => {
    const { data, error } = await callRpc("receive_purchase_order", {
      p_purchase_order_id: purchaseOrderId,
      p_received_items: receivedItems.map((r) => ({
        product_id: r.productId, received_qty: r.receivedQty ?? null,
        product_unit_id: r.productUnitId ?? null, received_unit_qty: r.receivedUnitQty ?? null,
      })),
      p_created_at: op.createdAt,
      p_idempotency_key: op.idempotencyKey,
    });
    if (error) throw error;
    if (!data) throw new Error("Receiving returned no data.");
    const result = data as ReceivePurchaseOrderResult;

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === result.purchaseOrder.id ? result.purchaseOrder : p)),
      purchaseOrderItems: s.purchaseOrderItems.map((i) => result.purchaseOrderItems.find((u) => u.id === i.id) ?? i),
      inventory: mergeInventory(s.inventory, result.inventory),
      movements: [...result.movements, ...s.movements],
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    void putLocalRows({
      purchaseOrders: [result.purchaseOrder], purchaseOrderItems: result.purchaseOrderItems,
      inventory: result.inventory, movements: result.movements, auditLogs: result.auditLogs,
    });
  };

  // No network: receive the PO against locally-known data, mirroring
  // receive_purchase_order's own math (bill at received value: each line
  // total and the PO subtotal/total reflect what actually arrived, not what
  // was ordered) so supplier debt stays accurate even offline. The PO and
  // transfer this references are assumed to already have real ids — PO
  // creation/approval stays online-only, so there's nothing to wait on here.
  const receivePurchaseOrderOffline = async (
    purchaseOrderId: string, receiverId: string,
    receivedItems: { productId: string; receivedQty?: number; productUnitId?: string; receivedUnitQty?: number }[],
    op: OperationContext,
  ): Promise<void> => {
    await assertOfflineWriteEligible();
    const po = get().purchaseOrders.find((p) => p.id === purchaseOrderId);
    if (!po) throw new Error("Purchase order not found.");
    if (po.status !== "APPROVED") throw new Error("Purchase order is not in a receivable (APPROVED) status.");

    const now = op.createdAt;
    const lines = get().purchaseOrderItems.filter((i) => i.purchaseOrderId === purchaseOrderId);
    const inputByProduct = new Map(receivedItems.map((r) => [r.productId, r]));

    const updatedItems: PurchaseOrderItem[] = [];
    const movements: InventoryMovement[] = [];
    const inventoryUpdates: Inventory[] = [];
    let subtotalMmk = 0;

    for (const item of lines) {
      const input = inputByProduct.get(item.productId);
      let receivedBase: number;
      let unit: { id: string; name: string; baseQuantity: number; purchasePriceMmk?: number } | undefined;
      let unitQty: number | undefined;

      if (input?.productUnitId) {
        unit = get().productUnits.find(
          (u) => u.id === input.productUnitId && u.productId === item.productId && u.isActive,
        );
        if (!unit) throw new Error(`Sellable unit is not active for ${item.productId}.`);
        unitQty = input.receivedUnitQty ?? 0;
        if (unitQty < 0) throw new Error("Received unit qty must be zero or greater.");
        receivedBase = unitQty * unit.baseQuantity;
      } else if (input) {
        receivedBase = input.receivedQty ?? item.orderedQty;
      } else {
        receivedBase = item.orderedQty;
      }
      if (receivedBase < 0 || receivedBase > item.orderedQty) {
        throw new Error("Received quantity must be between 0 and the ordered quantity.");
      }

      const lineTotalMmk = receivedBase * item.unitCostMmk;
      subtotalMmk += lineTotalMmk;
      updatedItems.push({
        ...item, receivedQty: receivedBase, lineTotalMmk,
        productUnitId: unit?.id ?? item.productUnitId,
        unitNameSnapshot: unit?.name ?? item.unitNameSnapshot,
        unitBaseQuantitySnapshot: unit?.baseQuantity ?? item.unitBaseQuantitySnapshot,
        selectedUnitQuantity: unitQty ?? item.selectedUnitQuantity,
        unitPurchasePriceSnapshot: unit?.purchasePriceMmk ?? item.unitPurchasePriceSnapshot,
      });

      if (receivedBase === 0) continue;
      const qtyBefore = get().getInventoryQty(po.shopId, item.productId);
      const qtyAfter = qtyBefore + receivedBase;
      inventoryUpdates.push({ shopId: po.shopId, productId: item.productId, qtyBaseUnits: qtyAfter });
      movements.push({
        id: newId("move"), shopId: po.shopId, productId: item.productId, type: "PURCHASE_IN",
        qtyChange: receivedBase, qtyBefore, qtyAfter,
        reason: `Purchase order ${po.orderNo} received (offline — pending sync)`,
        referenceType: "purchase", referenceId: po.id, createdBy: receiverId, createdAt: now,
        productUnitId: unit?.id, unitNameSnapshot: unit?.name, unitBaseQuantitySnapshot: unit?.baseQuantity,
        selectedUnitQuantity: unitQty, pendingSync: true, idempotencyKey: op.idempotencyKey,
      });
    }

    const updatedPo: PurchaseOrder = {
      ...po, status: "RECEIVED", receivedBy: receiverId, receivedAt: now,
      subtotalMmk, totalMmk: subtotalMmk + (po.taxMmk ?? 0), pendingSync: true, idempotencyKey: op.idempotencyKey,
    };

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === po.id ? updatedPo : p)),
      purchaseOrderItems: s.purchaseOrderItems.map((i) => updatedItems.find((u) => u.id === i.id) ?? i),
      inventory: mergeInventory(s.inventory, inventoryUpdates),
      movements: [...movements, ...s.movements],
    }));
    void putLocalRows({
      purchaseOrders: [updatedPo], purchaseOrderItems: updatedItems,
      inventory: inventoryUpdates, movements,
    });

    await enqueueOutbox({
      kind: "rpc",
      name: "receive_purchase_order",
      args: {
        p_purchase_order_id: purchaseOrderId,
        p_received_items: receivedItems.map((r) => ({
          product_id: r.productId, received_qty: r.receivedQty ?? null,
          product_unit_id: r.productUnitId ?? null, received_unit_qty: r.receivedUnitQty ?? null,
        })),
        p_created_at: now,
        p_idempotency_key: op.idempotencyKey,
      },
      idempotencyKey: op.idempotencyKey,
      shopId: po.shopId,
      provisional: [{ table: "movements", ids: movements.map((m) => m.id) }],
    });
  };

  const recordSupplierPaymentOnline = async (input: {
    purchaseOrderId: string; amountMmk: number; paymentMethod: string; referenceNo?: string; notes?: string;
  }, op: OperationContext): Promise<void> => {
    const { data, error } = await callRpc("record_supplier_payment", {
      p_purchase_order_id: input.purchaseOrderId,
      p_amount_mmk: input.amountMmk,
      p_payment_method: input.paymentMethod,
      p_reference_no: input.referenceNo ?? null,
      p_notes: input.notes ?? null,
      p_created_at: op.createdAt,
      p_idempotency_key: op.idempotencyKey,
    });
    if (error) throw error;
    if (!data) throw new Error("Record supplier payment returned no data.");
    const result = data as RecordSupplierPaymentResult;

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === result.purchaseOrder.id ? result.purchaseOrder : p)),
      supplierPayments: [result.supplierPayment, ...s.supplierPayments],
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    void putLocalRows({ purchaseOrders: [result.purchaseOrder], supplierPayments: [result.supplierPayment], auditLogs: result.auditLogs });
  };

  // No network: mirror record_supplier_payment's own balance/status math
  // (paid so far + this payment, capped by outstanding balance) against the
  // locally-known PO. The PO this references is assumed to already be
  // RECEIVED with a real id — PO creation/approval/receiving-approval flows
  // aside from receiving itself stay online-only.
  const recordSupplierPaymentOffline = async (input: {
    purchaseOrderId: string; amountMmk: number; paymentMethod: "CASH" | "BANK" | "MOBILE" | "OTHER";
    referenceNo?: string; notes?: string;
  }, op: OperationContext): Promise<void> => {
    await assertOfflineWriteEligible();
    const po = get().purchaseOrders.find((p) => p.id === input.purchaseOrderId);
    if (!po) throw new Error("Purchase order not found.");
    if (po.status !== "RECEIVED") {
      throw new Error("Supplier payments can only be recorded against received purchase orders.");
    }
    const outstanding = po.totalMmk - (po.paidMmk ?? 0);
    if (outstanding <= 0) throw new Error("Purchase order is already paid.");
    if (input.amountMmk > outstanding) throw new Error("Payment amount exceeds outstanding balance.");

    const now = op.createdAt;
    const newPaid = (po.paidMmk ?? 0) + input.amountMmk;
    const updatedPo: PurchaseOrder = {
      ...po, paidMmk: newPaid,
      paymentStatus: newPaid >= po.totalMmk ? "PAID" : newPaid > 0 ? "PARTIAL" : "UNPAID",
      pendingSync: true, idempotencyKey: op.idempotencyKey,
    };
    const payment: SupplierPayment = {
      id: newId("suppay"), supplierId: po.supplierId, purchaseOrderId: po.id, shopId: po.shopId,
      amountMmk: input.amountMmk, paymentMethod: input.paymentMethod, referenceNo: input.referenceNo,
      notes: input.notes, paidAt: now, createdBy: useAuthStore.getState().currentUserId ?? "system",
      createdAt: now, pendingSync: true, idempotencyKey: op.idempotencyKey,
    };

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === po.id ? updatedPo : p)),
      supplierPayments: [payment, ...s.supplierPayments],
    }));
    void putLocalRows({ purchaseOrders: [updatedPo], supplierPayments: [payment] });

    await enqueueOutbox({
      kind: "rpc",
      name: "record_supplier_payment",
      args: {
        p_purchase_order_id: input.purchaseOrderId, p_amount_mmk: input.amountMmk,
        p_payment_method: input.paymentMethod, p_reference_no: input.referenceNo ?? null,
        p_notes: input.notes ?? null, p_created_at: now, p_idempotency_key: op.idempotencyKey,
      },
      idempotencyKey: op.idempotencyKey,
      shopId: po.shopId,
      provisional: [{ table: "supplierPayments", ids: [payment.id] }],
    });
  };

  return {
  suppliers: [],
  purchaseOrders: [],
  purchaseOrderItems: [],
  supplierPayments: [],

  addSupplier: async (input: CreateSupplierInput) => {
    const { data, error } = await callRpc("create_supplier", {
      p_code: input.code,
      p_name: input.name,
      p_contact_person: input.contactPerson ?? null,
      p_phone: input.phone ?? null,
      p_email: input.email ?? null,
      p_address: input.address ?? null,
      p_notes: input.notes ?? null,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Create supplier returned no data.");
    const result = data as SupplierResult;

    set((s) => ({
      suppliers: [...s.suppliers, result.supplier],
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    return result.supplier;
  },

  updateSupplier: async (supplier: Supplier) => {
    const { data, error } = await callRpc("update_supplier", {
      p_id: supplier.id,
      p_code: supplier.code,
      p_name: supplier.name,
      p_contact_person: supplier.contactPerson ?? null,
      p_phone: supplier.phone ?? null,
      p_email: supplier.email ?? null,
      p_address: supplier.address ?? null,
      p_notes: supplier.notes ?? null,
      p_is_active: supplier.isActive,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Update supplier returned no data.");
    const result = data as SupplierResult;

    set((s) => ({
      suppliers: s.suppliers.map((sup) => (sup.id === result.supplier.id ? result.supplier : sup)),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
  },

  createPurchaseOrder: async ({ shopId, supplierId, items, notes }: CreatePurchaseOrderInput) => {
    const { data, error } = await callRpc("create_purchase_order", {
      p_shop_id: shopId,
      p_supplier_id: supplierId,
      p_notes: notes ?? null,
      p_items: items.map((item) => ({
        product_id: item.productId,
        ordered_qty: item.orderedQty,
        unit_cost_mmk: item.unitCostMmk,
      })),
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Create purchase order returned no data.");
    const result = data as CreatePurchaseOrderResult;

    set((s) => ({
      purchaseOrders: [result.purchaseOrder, ...s.purchaseOrders],
      purchaseOrderItems: [...result.purchaseOrderItems, ...s.purchaseOrderItems],
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
    return result.purchaseOrder.id;
  },

  approvePurchaseOrder: async ({ purchaseOrderId }) => {
    const { data, error } = await callRpc("approve_purchase_order", {
      p_purchase_order_id: purchaseOrderId,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Approve purchase order returned no data.");
    const result = data as PurchaseOrderStatusResult;

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) =>
        p.id === result.purchaseOrder.id ? result.purchaseOrder : p
      ),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
  },

  receivePurchaseOrder: async ({ purchaseOrderId, receiverId, receivedItems }) => {
    const op = beginOperation();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return receivePurchaseOrderOffline(purchaseOrderId, receiverId, receivedItems, op);
    }
    try {
      return await receivePurchaseOrderOnline(purchaseOrderId, receivedItems, op);
    } catch (err) {
      if (isNetworkError(err)) return receivePurchaseOrderOffline(purchaseOrderId, receiverId, receivedItems, op);
      throw err;
    }
  },

  // Called by the outbox once a queued receive_purchase_order actually runs
  // — swaps the provisional movements for the server's authoritative ones.
  reconcileReceivePurchaseOrder: (data, provisional) => {
    const result = data as ReceivePurchaseOrderResult;
    const provisionalMovementIds = new Set(provisional.find((p) => p.table === "movements")?.ids ?? []);

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === result.purchaseOrder.id ? result.purchaseOrder : p)),
      purchaseOrderItems: s.purchaseOrderItems.map((i) => result.purchaseOrderItems.find((u) => u.id === i.id) ?? i),
      inventory: mergeInventory(s.inventory, result.inventory),
      movements: [...result.movements, ...s.movements.filter((m) => !provisionalMovementIds.has(m.id) && !result.movements.some((r) => r.id === m.id))],
      auditLogs: [...result.auditLogs, ...s.auditLogs.filter((a) => !result.auditLogs.some((r) => r.id === a.id))],
    }));
    void deleteLocalRows(provisional);
    void putLocalRows({
      purchaseOrders: [result.purchaseOrder], purchaseOrderItems: result.purchaseOrderItems,
      inventory: result.inventory, movements: result.movements, auditLogs: result.auditLogs,
    });
  },

  cancelPurchaseOrder: async ({ purchaseOrderId }) => {
    const { data, error } = await callRpc("cancel_purchase_order", {
      p_purchase_order_id: purchaseOrderId,
      p_reason: null,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Cancel purchase order returned no data.");
    const result = data as PurchaseOrderStatusResult;

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) =>
        p.id === result.purchaseOrder.id ? result.purchaseOrder : p
      ),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
  },

  recordSupplierPayment: async (input) => {
    const op = beginOperation();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return recordSupplierPaymentOffline(input, op);
    }
    try {
      return await recordSupplierPaymentOnline(input, op);
    } catch (err) {
      if (isNetworkError(err)) return recordSupplierPaymentOffline(input, op);
      throw err;
    }
  },

  // Called by the outbox once a queued record_supplier_payment actually
  // runs — swaps the provisional payment for the server's authoritative one.
  reconcileRecordSupplierPayment: (data, provisional) => {
    const result = data as RecordSupplierPaymentResult;
    const provisionalIds = new Set(provisional.find((p) => p.table === "supplierPayments")?.ids ?? []);

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => (p.id === result.purchaseOrder.id ? result.purchaseOrder : p)),
      supplierPayments: [
        result.supplierPayment, ...s.supplierPayments.filter((p) => !provisionalIds.has(p.id) && p.id !== result.supplierPayment.id),
      ],
      auditLogs: [...result.auditLogs, ...s.auditLogs.filter((a) => !result.auditLogs.some((r) => r.id === a.id))],
    }));
    void deleteLocalRows(provisional);
    void putLocalRows({
      purchaseOrders: [result.purchaseOrder], supplierPayments: [result.supplierPayment], auditLogs: result.auditLogs,
    });
  },

  paySupplierLumpSum: async ({ supplierId, shopId, amountMmk, paymentMethod, referenceNo, notes }) => {
    const { data, error } = await callRpc("pay_supplier_lump_sum", {
      p_supplier_id: supplierId,
      p_shop_id: shopId,
      p_amount_mmk: amountMmk,
      p_payment_method: paymentMethod,
      p_reference_no: referenceNo ?? null,
      p_notes: notes ?? null,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Lump-sum supplier payment returned no data.");
    const result = data as {
      supplierPayments: SupplierPayment[];
      purchaseOrders: PurchaseOrder[];
      auditLogs: AuditLog[];
    };
    const updatedPoById = new Map(result.purchaseOrders.map((p) => [p.id, p]));

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) => updatedPoById.get(p.id) ?? p),
      supplierPayments: [...result.supplierPayments, ...s.supplierPayments],
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
  },

  voidSupplierPayment: async ({ paymentId, reason }) => {
    const { data, error } = await callRpc("void_supplier_payment", {
      p_payment_id: paymentId,
      p_reason: reason,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Void supplier payment returned no data.");
    const result = data as RecordSupplierPaymentResult;

    set((s) => ({
      purchaseOrders: s.purchaseOrders.map((p) =>
        p.id === result.purchaseOrder.id ? result.purchaseOrder : p
      ),
      supplierPayments: s.supplierPayments.map((p) =>
        p.id === result.supplierPayment.id ? result.supplierPayment : p
      ),
      auditLogs: [...result.auditLogs, ...s.auditLogs],
    }));
  },
  };
};

