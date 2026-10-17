// ----------------------------------------------------------------------
// Minimal VALID replies per offline-capable RPC, for test doubles. Since
// Batch 2A a 2xx must have the shape its reconciler needs (replyShapes.ts);
// tests that only care that "the server accepted it" use these instead of
// `{ ok: true }`, which is now (correctly) an unrecognised reply.
// No vitest imports: type-checks in the app build.
// ----------------------------------------------------------------------

let n = 0;
const id = (prefix: string) => `${prefix}-reply-${++n}`;

export function validReply(rpc: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  switch (rpc) {
    case "complete_sale":
      return { sale: { id: id("sale"), shopId: "shop-1", receiptNo: "R-1", status: "NORMAL", totalMmk: 0 }, items: [], movements: [], inventory: [], auditLogs: [], ...overrides };
    case "adjust_stock":
      return {
        inventory: { shopId: "shop-1", productId: "p1", qtyBaseUnits: 0 },
        movement: { id: id("mv"), shopId: "shop-1", productId: "p1" }, auditLog: { id: id("au") }, ...overrides,
      };
    case "open_shift":
    case "close_shift":
      return { shift: { id: id("shift"), shopId: "shop-1" }, auditLogs: [], ...overrides };
    case "create_refund_void_request":
      return { request: { id: id("refund"), saleId: "sale-1", status: "REQUESTED" }, auditLogs: [], ...overrides };
    case "receive_purchase_order":
      return { purchaseOrder: { id: id("po") }, purchaseOrderItems: [], inventory: [], movements: [], auditLogs: [], ...overrides };
    case "record_supplier_payment":
      return { purchaseOrder: { id: id("po") }, supplierPayment: { id: id("suppay") }, auditLogs: [], ...overrides };
    case "dispatch_stock_transfer":
      return { stockTransfer: { id: id("tr") }, stockTransferItems: [], auditLogs: [], ...overrides };
    case "receive_stock_transfer":
      return { stockTransfer: { id: id("tr") }, stockTransferItems: [], inventory: [], movements: [], auditLogs: [], ...overrides };
    case "pay_supplier_lump_sum":
      return { supplierPayments: [{ id: id("suppay") }], purchaseOrders: [], auditLogs: [], ...overrides };
    case "void_supplier_payment":
      return { purchaseOrder: { id: id("po") }, supplierPayment: { id: id("suppay") }, auditLogs: [], ...overrides };
    case "create_purchase_order":
      return { purchaseOrder: { id: id("po") }, purchaseOrderItems: [], auditLogs: [], ...overrides };
    case "create_stock_transfer":
      return { stockTransfer: { id: id("tr") }, stockTransferItems: [], auditLogs: [], ...overrides };
    case "approve_void_request":
    case "approve_refund_request":
      return { request: { id: id("refund") }, sale: { id: id("sale") }, movements: [], inventory: [], auditLogs: [], ...overrides };
    default:
      return { ok: true, ...overrides };
  }
}
