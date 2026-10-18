// Area "rpcs": every authenticated-callable mutating RPC, called by org A's
// ADMIN (aal2) with org B's ids in each id parameter, must be refused with no
// effect in B. Row digests of all of B's business tables are taken before and
// after the whole batch. Then idempotency-key binding (074): a key used by A
// cannot drive an effect in B, and a replay returns the original only to the
// same org.
import type { World } from "./seed";
import { applied, capture, check, gap, rpc, sql, q, uuid } from "./lib";

const B_DIGEST_TABLES = [
  "shops", "users", "products", "product_units", "inventory", "inventory_movements", "shifts", "sales", "sale_items",
  "purchase_orders", "purchase_order_items", "stock_transfers", "stock_transfer_items", "supplier_payments",
  "refund_void_requests", "reprint_logs", "suppliers", "price_levels", "audit_logs",
];
function bDigest(): string {
  // one digest over every org-B row across the business tables
  const parts = B_DIGEST_TABLES.map((t) => {
    const col = ["shops", "users", "products", "suppliers", "price_levels"].includes(t) ? "org_id='org-iso-b'"
      : t === "inventory" || t === "shifts" || t === "sales" || t === "purchase_orders" || t === "supplier_payments" || t === "refund_void_requests" || t === "inventory_movements"
        ? "shop_id IN (SELECT id FROM shops WHERE org_id='org-iso-b')"
      : t === "stock_transfers" ? "from_shop_id IN (SELECT id FROM shops WHERE org_id='org-iso-b')"
      : t === "sale_items" ? "sale_id IN (SELECT id FROM sales WHERE shop_id IN (SELECT id FROM shops WHERE org_id='org-iso-b'))"
      : t === "purchase_order_items" ? "purchase_order_id IN (SELECT id FROM purchase_orders WHERE shop_id IN (SELECT id FROM shops WHERE org_id='org-iso-b'))"
      : t === "stock_transfer_items" ? "transfer_id IN (SELECT id FROM stock_transfers WHERE from_shop_id IN (SELECT id FROM shops WHERE org_id='org-iso-b'))"
      : t === "reprint_logs" ? "sale_id IN (SELECT id FROM sales WHERE shop_id IN (SELECT id FROM shops WHERE org_id='org-iso-b'))"
      : t === "product_units" ? "product_id IN (SELECT id FROM products WHERE org_id='org-iso-b')"
      : t === "audit_logs" ? "actor_id IN (SELECT id FROM users WHERE org_id='org-iso-b')"
      : "true";
    return sql(`SELECT md5(coalesce(string_agg(to_jsonb(zz)::text, '|' ORDER BY zz.*::text), '')) FROM ${t} zz WHERE ${col}`);
  });
  return parts.join(":");
}

export async function rpcsSuite(w: World) {
  const admin = w.adminA2;
  const B = w.B;
  const k = () => uuid();
  const before = bDigest();

  // each entry: [rpc, args-with-B-ids, which B id param this proves, covers]
  const calls: [string, Record<string, unknown>][] = [
    ["open_shift", { p_shop_id: B.shops[0], p_opening_cash_mmk: 0, p_idempotency_key: k() }],
    ["close_shift", { p_shift_id: B.shifts[0], p_closing_cash_mmk: 0, p_idempotency_key: k() }],
    ["complete_sale", { p_shop_id: B.shops[0], p_shift_id: B.shifts[0], p_payment_method: "CASH", p_paid_mmk: 1, p_cart_discount_pct: 0, p_items: [{ product_id: B.products[0], qty: 1 }], p_idempotency_key: k() }],
    ["adjust_stock", { p_shop_id: B.shops[0], p_product_id: B.products[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "x", p_idempotency_key: k() }],
    ["create_purchase_order", { p_shop_id: B.shops[0], p_supplier_id: B.supplier, p_notes: "x", p_items: [{ product_id: B.products[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: k() }],
    ["approve_purchase_order", { p_purchase_order_id: B.pos.draft, p_idempotency_key: k() }],
    ["cancel_purchase_order", { p_purchase_order_id: B.pos.draft, p_reason: "x", p_idempotency_key: k() }],
    ["receive_purchase_order", { p_purchase_order_id: B.pos.appr, p_received_items: null, p_idempotency_key: k() }],
    ["record_supplier_payment", { p_purchase_order_id: B.pos.recv, p_amount_mmk: 1, p_payment_method: "CASH", p_idempotency_key: k() }],
    ["pay_supplier_lump_sum", { p_supplier_id: B.supplier, p_shop_id: B.shops[0], p_amount_mmk: 1, p_payment_method: "CASH", p_idempotency_key: k() }],
    ["void_supplier_payment", { p_payment_id: B.payments[0], p_reason: "x", p_idempotency_key: k() }],
    ["create_stock_transfer", { p_from_shop_id: B.shops[0], p_to_shop_id: B.shops[1], p_notes: "x", p_items: [{ product_id: B.products[0], requested_qty: 1 }], p_idempotency_key: k() }],
    ["approve_stock_transfer", { p_transfer_id: B.transfers.pending, p_idempotency_key: k() }],
    ["reject_stock_transfer", { p_transfer_id: B.transfers.pending, p_reason: "x", p_idempotency_key: k() }],
    ["cancel_stock_transfer", { p_transfer_id: B.transfers.pending, p_reason: "x", p_idempotency_key: k() }],
    ["dispatch_stock_transfer", { p_transfer_id: B.transfers.pending, p_idempotency_key: k() }],
    ["receive_stock_transfer", { p_transfer_id: B.transfers.transit, p_received_items: null, p_idempotency_key: k() }],
    ["create_refund_void_request", { p_sale_id: B.sales[0], p_type: "PARTIAL", p_reason: "x", p_items: [{ productId: B.products[0], qtyUnits: 1, amountMmk: 1 }], p_idempotency_key: k() }],
    ["approve_refund_request", { p_request_id: B.refunds.partial, p_idempotency_key: k() }],
    ["reject_refund_void_request", { p_request_id: B.refunds.partial, p_reason: "x", p_idempotency_key: k() }],
    ["approve_void_request", { p_request_id: B.refunds.void, p_idempotency_key: k() }],
    ["log_receipt_reprint", { p_sale_id: B.sales[0], p_idempotency_key: k() }],
    ["log_audit_event", { p_action_type: "PRODUCT_EDIT", p_message: "x", p_entity_type: "Product", p_entity_id: B.products[0], p_shop_id: B.shops[0], p_idempotency_key: k() }],
    ["delete_product", { p_product_id: B.products[0], p_idempotency_key: k() }],
    ["update_supplier", { p_id: B.supplier, p_code: "X", p_name: "HACK", p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_is_active: true, p_idempotency_key: k() }],
    ["update_app_user", { p_id: B.people.cash.userId, p_name: "HACK", p_role: "CASHIER", p_shop_id: B.shops[0], p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: k() }],
    ["deactivate_app_user", { p_id: B.people.cash.userId, p_is_active: false, p_idempotency_key: k() }],
    ["replace_manager", { p_shop_id: B.shops[0], p_new_manager_id: w.A.people.mgr.userId, p_idempotency_key: k() }],
    ["create_app_user", { p_id: `iso-x-${Date.now()}`, p_name: "x", p_email: `x${Date.now()}@qa.invalid`, p_role: "CASHIER", p_shop_id: B.shops[0], p_auth_id: null, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: k() }],
    ["create_product_image_upload_session", { p_shop_id: B.shops[0], p_product_id: B.products[0] }],
  ];

  for (const [name, args] of calls) {
    const r = await rpc(admin, name, args);
    capture(`rpc ${name} A->B`, r.text, Object.values(args).filter((v) => typeof v === "string") as string[]);
    // Refused (>=300) is the expected outcome at 070+. A 2xx is a failure only
    // if it actually changed B (checked by the global digest after the loop).
    const refused = r.status >= 300;
    check("rpcs", `${name}: org A ADMIN with org B ids is refused`, refused, [`rpc:public.${name}`],
      `status ${r.status} ${(r.json?.message ?? r.json?.error ?? r.text).toString().slice(0, 120)}`);
  }

  const after = bDigest();
  check("rpcs", "no org-B row changed by any cross-org RPC call", before === after, ["rpc:cross-org-digest"],
    before === after ? "" : "org B business tables changed");

  // Positive control: the same RPCs on A's own data still work
  const okShift = await rpc(admin, "adjust_stock", { p_shop_id: w.A.shops[0], p_product_id: w.A.products[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: `pos-${w.A.can}`, p_idempotency_key: k() });
  check("rpcs", "positive: admin A adjust_stock on own shop/product works", okShift.status < 300, ["rpc:public.adjust_stock"], `status ${okShift.status}`);
  // create_supplier carries no org target: the new row must land in the caller's org, never B
  const sup = await rpc(admin, "create_supplier", { p_code: `X${Date.now()}`, p_name: `sup-${w.A.can}`, p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_idempotency_key: k() });
  const supId = sup.json?.supplier?.id ?? sup.json?.id;
  const supOrg = supId ? sql(`SELECT org_id FROM suppliers WHERE id=${q(supId)}`) : "";
  check("rpcs", "create_supplier: new supplier lands in caller's org (A), not B", sup.status < 300 && supOrg === w.A.id, ["rpc:public.create_supplier"], `status ${sup.status} org ${supOrg}`);

  // ---- idempotency key binding (074) ----
  // 1. A's existing complete_sale key, replayed by A, returns A's original result
  const aKey = w.A.idemKeys.complete_sale;
  const replay = await rpc(w.A.people.cash.token, "complete_sale", {
    p_shop_id: w.A.shops[0], p_shift_id: w.A.shifts[0], p_payment_method: "CASH", p_paid_mmk: w.A.price * 3, p_cart_discount_pct: 0,
    p_items: [{ product_id: w.A.products[0], qty: 1 }], p_idempotency_key: aKey });
  check("rpcs", "idempotency: A replays its own key -> original result (same org)", replay.status < 300 && replay.json?.sale?.id === w.A.sales[0], ["rpc:idempotency-074"],
    `status ${replay.status} sale ${replay.json?.sale?.id ?? "?"}`);
  // 2. B reuses A's key for a sale in B. 074..085: refused (one global key,
  //    bound to A's org). 086+ (per-organisation ledger identity, org_id+key):
  //    A's key does not exist in B — it is B's OWN independent operation in B
  //    (B could use any fresh key as well). Either way B must never receive
  //    A's result or any of A's data.
  const steal = await rpc(w.B.people.cash.token, "complete_sale", {
    p_shop_id: w.B.shops[0], p_shift_id: w.B.shifts[0], p_payment_method: "CASH", p_paid_mmk: w.B.price * 3, p_cart_discount_pct: 0,
    p_items: [{ product_id: w.B.products[0], qty: 1 }], p_idempotency_key: aKey });
  if (applied(86)) {
    const bSale = steal.json?.sale;
    const aReplay = await rpc(w.A.people.cash.token, "complete_sale", {
      p_shop_id: w.A.shops[0], p_shift_id: w.A.shifts[0], p_payment_method: "CASH", p_paid_mmk: w.A.price * 3, p_cart_discount_pct: 0,
      p_items: [{ product_id: w.A.products[0], qty: 1 }], p_idempotency_key: aKey });
    check("rpcs", "idempotency (086 per-organisation ledger): B's use of A's key is B's OWN sale in B (committed there), never A's result or data; A's replay still returns A's sale",
      steal.status < 300 && bSale?.shopId === w.B.shops[0] && bSale?.id !== w.A.sales[0] && !steal.text.includes(w.A.can) && !steal.text.includes(w.A.shops[0])
        && aReplay.status < 300 && aReplay.json?.sale?.id === w.A.sales[0], ["rpc:idempotency-074"],
      `B status ${steal.status} sale ${bSale?.id ?? "-"} shop ${bSale?.shopId ?? "-"}; A replay ${aReplay.json?.sale?.id ?? aReplay.status}`);
  } else {
    capture("rpc idem steal B uses A key", steal.text);
    gap("rpcs", "idempotency: B reusing A's key is refused (074 caller/org binding)", steal.status >= 300, ["rpc:idempotency-074"], "high", `status ${steal.status}`);
  }
  check("rpcs", "idempotency: B's attempt with A's key did not return A's sale", !(steal.status < 300 && steal.json?.sale?.id === w.A.sales[0]), ["rpc:idempotency-074"],
    `returned ${steal.json?.sale?.id ?? "-"}`);
}
