// Migration 086 (supabase/migrations/086_operation_outcomes.sql, op_spec):
// the RPCs the guarded executor op_execute dispatches. create_app_user stays
// direct-only (it is exempt from the UUIDv7 executor guard). Dependency-free:
// shared by the app (stores/data/idempotentRpc.ts) and tools/queue-recovery.
export const EXECUTOR_RPCS: ReadonlySet<string> = new Set([
  "adjust_stock", "approve_purchase_order", "approve_refund_request", "approve_stock_transfer", "approve_void_request",
  "cancel_purchase_order", "cancel_stock_transfer", "close_shift", "complete_sale", "create_purchase_order",
  "create_refund_void_request", "create_stock_transfer", "create_supplier", "deactivate_app_user", "delete_product",
  "dispatch_stock_transfer", "log_audit_event", "log_receipt_reprint", "open_shift", "pay_supplier_lump_sum",
  "receive_purchase_order", "receive_stock_transfer", "record_supplier_payment", "reject_refund_void_request",
  "reject_stock_transfer", "replace_manager", "update_app_user", "update_supplier", "void_supplier_payment",
]);

/** RFC 9562 UUIDv7: the keys an 086-era till mints (executor-only on an 086 server). */
export const isUuidV7 = (key: string | null | undefined): boolean =>
  typeof key === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);

/** The millisecond time carried by a UUIDv7 key (null for any other key). */
export const uuidV7TimeMs = (key: string | null | undefined): number | null =>
  isUuidV7(key) ? parseInt(key!.replace(/-/g, "").slice(0, 12), 16) : null;
