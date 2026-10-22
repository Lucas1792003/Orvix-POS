// ----------------------------------------------------------------------
// Reply validation (Batch 2A, plan v2 §5.2 step 2): a 2xx is never success
// by itself. Each offline-capable RPC's reply must have exactly what its
// reconciler dereferences before the operation is acknowledged; anything
// else is MALFORMED_SUCCESS — the operation is kept (in doubt) and resent
// with the same key, never reconciled and never deleted.
//
// The fields required here are the ones the reconcilers use unguarded
// (reconcileCompleteSale, reconcileAdjustStock, reconcileOpenShift, …).
// ----------------------------------------------------------------------

type Check = (data: unknown) => string | null; // null = valid, else the reason

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): boolean => typeof v === "string" && v.length > 0;

function require(data: unknown, spec: Record<string, "id-object" | "array" | "object" | "inventory-row">): string | null {
  if (!isObj(data)) return "reply is not an object";
  for (const [key, kind] of Object.entries(spec)) {
    const v = data[key];
    switch (kind) {
      case "array":
        if (!Array.isArray(v)) return `"${key}" is not a list`;
        break;
      case "object":
        if (!isObj(v)) return `"${key}" is missing`;
        break;
      case "id-object":
        if (!isObj(v) || !str(v.id)) return `"${key}.id" is missing`;
        break;
      case "inventory-row":
        if (!isObj(v) || !str(v.shopId) || !str(v.productId)) return `"${key}" is not a stock row`;
        break;
    }
  }
  return null;
}

const CHECKS: Record<string, Check> = {
  complete_sale: (d) => require(d, { sale: "id-object", items: "array", movements: "array", inventory: "array", auditLogs: "array" }),
  adjust_stock: (d) => require(d, { inventory: "inventory-row", movement: "id-object", auditLog: "id-object" }),
  open_shift: (d) => require(d, { shift: "id-object", auditLogs: "array" }),
  close_shift: (d) => require(d, { shift: "id-object", auditLogs: "array" }),
  // Step 4 (PFIN-D)
  fin_close_shift: (d) => require(d, { shift: "id-object", auditLogs: "array" }),
  fin_record_cash_movement: (d) => require(d, { movement: "id-object" }),
  create_refund_void_request: (d) => require(d, { request: "id-object", auditLogs: "array" }),
  receive_purchase_order: (d) => require(d, {
    purchaseOrder: "id-object", purchaseOrderItems: "array", inventory: "array", movements: "array", auditLogs: "array",
  }),
  record_supplier_payment: (d) => require(d, { purchaseOrder: "id-object", supplierPayment: "id-object", auditLogs: "array" }),
  dispatch_stock_transfer: (d) => require(d, { stockTransfer: "id-object", stockTransferItems: "array", auditLogs: "array" }),
  receive_stock_transfer: (d) => require(d, {
    stockTransfer: "id-object", stockTransferItems: "array", inventory: "array", movements: "array", auditLogs: "array",
  }),
  // Online-only money operations (correction pass): a saved operation is
  // only settled on a reply the caller can actually use.
  pay_supplier_lump_sum: (d) => require(d, { supplierPayments: "array", purchaseOrders: "array", auditLogs: "array" }),
  void_supplier_payment: (d) => require(d, { purchaseOrder: "id-object", supplierPayment: "id-object", auditLogs: "array" }),
  create_purchase_order: (d) => require(d, { purchaseOrder: "id-object", purchaseOrderItems: "array", auditLogs: "array" }),
  create_stock_transfer: (d) => require(d, { stockTransfer: "id-object", stockTransferItems: "array", auditLogs: "array" }),
  approve_void_request: (d) => require(d, { request: "id-object", sale: "id-object", movements: "array", inventory: "array", auditLogs: "array" }),
  approve_refund_request: (d) => require(d, { request: "id-object", sale: "id-object", movements: "array", inventory: "array", auditLogs: "array" }),
};

/**
 * Why `data` is not an acceptable reply for `rpc`, or null when it is.
 * RPCs without a registered shape only need a non-null reply.
 */
export function replyProblem(rpc: string, data: unknown): string | null {
  const check = CHECKS[rpc];
  if (check) return check(data);
  return data === null || data === undefined ? "empty reply" : null;
}
