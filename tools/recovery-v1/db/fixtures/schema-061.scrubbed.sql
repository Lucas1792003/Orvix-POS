


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."adjust_stock"("p_shop_id" "text", "p_product_id" "text", "p_adjustment_type" "text", "p_quantity_delta" integer, "p_reason" "text", "p_product_unit_id" "text" DEFAULT NULL::"text", "p_unit_qty" integer DEFAULT NULL::integer, "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_actor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid    uuid := auth.uid();
  v_user        users;
  v_now         timestamptz := resolve_event_time(p_created_at);
  v_perm        text;
  v_ref_type    text;
  v_qty_before  integer;
  v_qty_after   integer;
  v_move_id     text;
  v_audit_id    text;
  v_message     text;
  v_unit        product_units;
  v_sign        integer;
  v_delta       integer;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This offline action was queued by a different user — reconnect as them to sync it, or dismiss it from Sync Conflicts.';
  END IF;

  IF p_adjustment_type NOT IN ('ADJUSTMENT', 'DAMAGE', 'PURCHASE_IN', 'RETURN_IN') THEN
    RAISE EXCEPTION 'Unsupported adjustment type: %', p_adjustment_type;
  END IF;

  IF p_shop_id IS NULL OR btrim(p_shop_id) = '' THEN
    RAISE EXCEPTION 'Shop is required';
  END IF;
  IF p_product_id IS NULL OR btrim(p_product_id) = '' THEN
    RAISE EXCEPTION 'Product is required';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  IF p_quantity_delta IS NULL OR p_quantity_delta = 0 THEN
    RAISE EXCEPTION 'Quantity change cannot be zero';
  END IF;

  -- Resolve the unit-aware delta when the caller picked a unit.
  -- Sign comes from p_quantity_delta; magnitude comes from p_unit_qty *
  -- unit.base_quantity. This keeps the sign semantics shared with the
  -- legacy path (DAMAGE → negative, PURCHASE_IN/RETURN_IN → positive,
  -- ADJUSTMENT → either) without doubling the parameter list.
  IF p_product_unit_id IS NOT NULL THEN
    SELECT * INTO v_unit
      FROM product_units
     WHERE id = p_product_unit_id
       AND product_id = p_product_id
       AND is_active = true;
    IF v_unit.id IS NULL THEN
      RAISE EXCEPTION 'Sellable unit % is not active for product %', p_product_unit_id, p_product_id;
    END IF;
    IF p_unit_qty IS NULL OR p_unit_qty <= 0 THEN
      RAISE EXCEPTION 'Unit qty must be greater than zero when a sellable unit is selected';
    END IF;
    v_sign  := CASE WHEN p_quantity_delta < 0 THEN -1 ELSE 1 END;
    v_delta := v_sign * (p_unit_qty * v_unit.base_quantity);
  ELSE
    v_delta := p_quantity_delta;
  END IF;

  IF p_adjustment_type = 'DAMAGE' AND v_delta > 0 THEN
    RAISE EXCEPTION 'Damage write-off must reduce stock';
  END IF;
  IF p_adjustment_type IN ('PURCHASE_IN', 'RETURN_IN') AND v_delta < 0 THEN
    RAISE EXCEPTION 'Stock-in adjustments must increase stock';
  END IF;

  v_perm := CASE WHEN p_adjustment_type = 'DAMAGE'
                 THEN 'inventory:damage' ELSE 'inventory:adjust' END;

  IF NOT app_has_perm(v_perm) THEN
    RAISE EXCEPTION 'You are not permitted to make this inventory adjustment';
  END IF;
  IF NOT app_can_for_shop(v_perm, p_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to adjust inventory in this shop';
  END IF;

  PERFORM 1 FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found: %', p_product_id;
  END IF;

  INSERT INTO inventory (shop_id, product_id, qty_base_units)
  VALUES (p_shop_id, p_product_id, 0)
  ON CONFLICT (shop_id, product_id) DO NOTHING;

  SELECT qty_base_units INTO v_qty_before
    FROM inventory
   WHERE shop_id = p_shop_id AND product_id = p_product_id
   FOR UPDATE;

  v_qty_after := v_qty_before + v_delta;

  IF v_qty_after < 0 AND NOT app_has_perm('pos:override_stock') THEN
    RAISE EXCEPTION 'Adjustment would drive stock negative (% to %)',
      v_qty_before, v_qty_after;
  END IF;

  UPDATE inventory SET qty_base_units = v_qty_after
   WHERE shop_id = p_shop_id AND product_id = p_product_id;

  v_ref_type := CASE WHEN p_adjustment_type = 'DAMAGE' THEN 'damage' ELSE 'adjustment' END;
  v_move_id  := 'move-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO inventory_movements (
    id, shop_id, product_id, type, qty_change,
    qty_before, qty_after, reason, reference_type, reference_id,
    created_by, created_at,
    product_unit_id, unit_name_snapshot, unit_base_quantity_snapshot,
    selected_unit_quantity
  )
  VALUES (
    v_move_id, p_shop_id, p_product_id, p_adjustment_type, v_delta,
    v_qty_before, v_qty_after, p_reason, v_ref_type, NULL,
    v_user.id, v_now,
    v_unit.id, v_unit.name, v_unit.base_quantity, p_unit_qty
  );

  v_message := 'Stock ' || p_adjustment_type || ': ' || v_delta
    || ' (from ' || v_qty_before || ' to ' || v_qty_after || '). ' || p_reason;
  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, p_shop_id, v_user.id, 'STOCK_' || p_adjustment_type, v_message,
    'Inventory', p_product_id, v_now
  );

  RETURN jsonb_build_object(
    'inventory', jsonb_build_object(
      'shopId', p_shop_id, 'productId', p_product_id, 'qtyBaseUnits', v_qty_after
    ),
    'movement', jsonb_build_object(
      'id', v_move_id, 'shopId', p_shop_id, 'productId', p_product_id,
      'type', p_adjustment_type, 'qtyChange', v_delta,
      'qtyBefore', v_qty_before, 'qtyAfter', v_qty_after,
      'reason', p_reason, 'referenceType', v_ref_type, 'referenceId', NULL,
      'createdBy', v_user.id, 'createdAt', v_now,
      'productUnitId', v_unit.id,
      'unitNameSnapshot', v_unit.name,
      'unitBaseQuantitySnapshot', v_unit.base_quantity,
      'selectedUnitQuantity', p_unit_qty
    ),
    'auditLog', jsonb_build_object(
      'id', v_audit_id, 'shopId', p_shop_id, 'actorId', v_user.id,
      'actionType', 'STOCK_' || p_adjustment_type, 'message', v_message,
      'entityType', 'Inventory', 'entityId', p_product_id, 'createdAt', v_now
    )
  );
END;
$$;


ALTER FUNCTION "public"."adjust_stock"("p_shop_id" "text", "p_product_id" "text", "p_adjustment_type" "text", "p_quantity_delta" integer, "p_reason" "text", "p_product_unit_id" "text", "p_unit_qty" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_can_for_shop"("p_perm" "text", "p_shop_id" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT app_has_perm(p_perm)
     AND (app_role() = 'ADMIN' OR app_shop_id() IS NOT DISTINCT FROM p_shop_id);
$$;


ALTER FUNCTION "public"."app_can_for_shop"("p_perm" "text", "p_shop_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_has_perm"("p_perm" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM users u
    WHERE u.auth_id = auth.uid()
      AND u.is_active = true
      AND p_perm IN (
        SELECT unnest(role_default_permissions(u.role))
        UNION
        SELECT unnest(COALESCE(u.granted_permissions, ARRAY[]::text[]))
        EXCEPT
        SELECT unnest(COALESCE(u.revoked_permissions, ARRAY[]::text[]))
      )
  );
$$;


ALTER FUNCTION "public"."app_has_perm"("p_perm" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_org_id"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT org_id FROM users
  WHERE auth_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;


ALTER FUNCTION "public"."app_org_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT role FROM users
  WHERE auth_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;


ALTER FUNCTION "public"."app_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_shop_id"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT shop_id FROM users
  WHERE auth_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;


ALTER FUNCTION "public"."app_shop_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_user_id"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT id FROM users
  WHERE auth_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;


ALTER FUNCTION "public"."app_user_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_po purchase_orders; v_now timestamptz := now(); v_audit_id text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
  IF v_po.id IS NULL THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF v_po.status NOT IN ('DRAFT', 'SUBMITTED') THEN
    RAISE EXCEPTION 'Purchase order cannot be approved from status %', v_po.status;
  END IF;
  IF NOT app_can_for_shop('purchase:approve', v_po.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to approve purchase orders for this shop';
  END IF;
  IF v_po.created_by = v_user.id THEN
    RAISE EXCEPTION 'You cannot approve your own purchase order';
  END IF;

  UPDATE purchase_orders
     SET status = 'APPROVED', approved_by = v_user.id, approved_at = v_now
   WHERE id = v_po.id
   RETURNING * INTO v_po;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_po.shop_id, v_user.id, 'PO_APPROVED',
    'Purchase order ' || v_po.order_no || ' approved', 'PurchaseOrder', v_po.id, v_now);

  RETURN jsonb_build_object(
    'purchaseOrder', jsonb_build_object(
      'id', v_po.id, 'orderNo', v_po.order_no, 'shopId', v_po.shop_id, 'supplierId', v_po.supplier_id,
      'status', v_po.status, 'subtotalMmk', v_po.subtotal_mmk, 'taxMmk', v_po.tax_mmk,
      'totalMmk', v_po.total_mmk, 'notes', v_po.notes, 'createdBy', v_po.created_by,
      'createdAt', v_po.created_at, 'approvedBy', v_po.approved_by, 'approvedAt', v_po.approved_at,
      'receivedBy', v_po.received_by, 'receivedAt', v_po.received_at),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_po.shop_id, 'actorId', v_user.id, 'actionType', 'PO_APPROVED',
      'message', 'Purchase order ' || v_po.order_no || ' approved',
      'entityType', 'PurchaseOrder', 'entityId', v_po.id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_refund_request"("p_request_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid     uuid := auth.uid();
  v_user         users;
  v_request      refund_void_requests;
  v_sale         sales;
  v_now          timestamptz := now();
  v_item         jsonb;
  v_product_id   text;
  v_qty_units    integer;
  v_amount_mmk   integer;
  v_sale_qty     integer;
  v_prev_qty     integer;
  v_sale_amount  integer;
  v_prev_amount  integer;
  v_qty_before   integer;
  v_qty_after    integer;
  v_move_id      text;
  v_audit_id     text;
  v_movements    jsonb := '[]'::jsonb;
  v_inventory    jsonb := '[]'::jsonb;
  v_audit_logs   jsonb := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_has_perm('pos:refund') THEN
    RAISE EXCEPTION 'You are not permitted to approve refunds';
  END IF;

  SELECT * INTO v_request
    FROM refund_void_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Refund request not found';
  END IF;

  IF v_request.type <> 'PARTIAL' THEN
    RAISE EXCEPTION 'Request is not a refund request';
  END IF;

  IF v_request.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'Refund request is not pending';
  END IF;

  SELECT * INTO v_sale
    FROM sales
   WHERE id = v_request.sale_id
   FOR UPDATE;

  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Original sale not found';
  END IF;

  IF v_request.shop_id IS DISTINCT FROM v_sale.shop_id THEN
    RAISE EXCEPTION 'Refund request shop does not match sale shop';
  END IF;

  IF NOT app_can_for_shop('pos:refund', v_sale.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to approve refunds in this shop';
  END IF;

  IF v_request.created_by = v_user.id THEN
    RAISE EXCEPTION 'You cannot approve your own refund request';
  END IF;

  IF v_sale.status = 'VOID' THEN
    RAISE EXCEPTION 'Cannot refund a voided sale';
  END IF;

  IF v_request.items IS NULL OR jsonb_typeof(v_request.items) <> 'array' OR jsonb_array_length(v_request.items) = 0 THEN
    RAISE EXCEPTION 'Refund request has no items';
  END IF;

  IF (
    SELECT count(*)
      FROM jsonb_array_elements(v_request.items) item
  ) <> (
    SELECT count(DISTINCT COALESCE(item->>'productId', item->>'product_id'))
      FROM jsonb_array_elements(v_request.items) item
  ) THEN
    RAISE EXCEPTION 'A product appears more than once in the refund request; combine the lines';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_request.items) AS t(value)
  LOOP
    v_product_id := COALESCE(v_item->>'productId', v_item->>'product_id');
    v_qty_units := COALESCE(v_item->>'qtyUnits', v_item->>'qty_units')::integer;
    v_amount_mmk := COALESCE(v_item->>'amountMmk', v_item->>'amount_mmk')::integer;

    IF COALESCE(v_product_id, '') = '' THEN
      RAISE EXCEPTION 'Refund item product is required';
    END IF;

    IF v_qty_units IS NULL OR v_qty_units <= 0 THEN
      RAISE EXCEPTION 'Invalid refund quantity for %', v_product_id;
    END IF;

    IF v_amount_mmk IS NULL OR v_amount_mmk < 0 THEN
      RAISE EXCEPTION 'Invalid refund amount for %', v_product_id;
    END IF;

    SELECT si.qty_units, si.line_total_mmk
      INTO v_sale_qty, v_sale_amount
      FROM sale_items si
     WHERE si.sale_id = v_sale.id AND si.product_id = v_product_id;

    IF v_sale_qty IS NULL THEN
      RAISE EXCEPTION 'Refund item is not part of the sale: %', v_product_id;
    END IF;

    SELECT
      COALESCE(sum((COALESCE(item->>'qtyUnits', item->>'qty_units'))::integer), 0),
      COALESCE(sum((COALESCE(item->>'amountMmk', item->>'amount_mmk'))::integer), 0)
      INTO v_prev_qty, v_prev_amount
      FROM refund_void_requests r
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.items, '[]'::jsonb)) item
     WHERE r.sale_id = v_sale.id
       AND r.type = 'PARTIAL'
       AND r.status = 'APPROVED'
       AND COALESCE(item->>'productId', item->>'product_id') = v_product_id;

    IF v_prev_qty + v_qty_units > v_sale_qty THEN
      RAISE EXCEPTION 'Refund quantity exceeds original sale quantity for %', v_product_id;
    END IF;

    IF v_prev_amount + v_amount_mmk > v_sale_amount THEN
      RAISE EXCEPTION 'Refund amount exceeds original sale amount for %', v_product_id;
    END IF;
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_request.items) AS t(value)
  LOOP
    v_product_id := COALESCE(v_item->>'productId', v_item->>'product_id');
    v_qty_units := COALESCE(v_item->>'qtyUnits', v_item->>'qty_units')::integer;

    SELECT qty_base_units INTO v_qty_before
      FROM inventory
     WHERE shop_id = v_sale.shop_id AND product_id = v_product_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inventory row not found for refunded item %', v_product_id;
    END IF;

    v_qty_after := v_qty_before + v_qty_units;

    UPDATE inventory
       SET qty_base_units = v_qty_after
     WHERE shop_id = v_sale.shop_id AND product_id = v_product_id;

    v_move_id := 'move-' || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO inventory_movements (
      id, shop_id, product_id, type, qty_change,
      qty_before, qty_after, reason, reference_type, reference_id,
      created_by, created_at
    )
    VALUES (
      v_move_id, v_sale.shop_id, v_product_id, 'RETURN_IN', v_qty_units,
      v_qty_before, v_qty_after, 'Refund approved for ' || v_sale.receipt_no,
      'sale', v_sale.id, v_user.id, v_now
    );

    v_movements := v_movements || jsonb_build_array(jsonb_build_object(
      'id', v_move_id,
      'shopId', v_sale.shop_id,
      'productId', v_product_id,
      'type', 'RETURN_IN',
      'qtyChange', v_qty_units,
      'qtyBefore', v_qty_before,
      'qtyAfter', v_qty_after,
      'reason', 'Refund approved for ' || v_sale.receipt_no,
      'referenceType', 'sale',
      'referenceId', v_sale.id,
      'createdBy', v_user.id,
      'createdAt', v_now
    ));

    v_inventory := v_inventory || jsonb_build_array(jsonb_build_object(
      'shopId', v_sale.shop_id,
      'productId', v_product_id,
      'qtyBaseUnits', v_qty_after
    ));
  END LOOP;

  UPDATE refund_void_requests
     SET status = 'APPROVED'
   WHERE id = v_request.id
   RETURNING * INTO v_request;

  UPDATE sales
     SET status = 'REFUNDED'
   WHERE id = v_sale.id
   RETURNING * INTO v_sale;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, v_sale.shop_id, v_user.id, 'REFUND',
    'Refund approved for sale ' || v_sale.receipt_no || '. Reason: ' || v_request.reason,
    'Refund', v_request.id, v_now
  );

  v_audit_logs := v_audit_logs || jsonb_build_array(jsonb_build_object(
    'id', v_audit_id,
    'shopId', v_sale.shop_id,
    'actorId', v_user.id,
    'actionType', 'REFUND',
    'message', 'Refund approved for sale ' || v_sale.receipt_no || '. Reason: ' || v_request.reason,
    'entityType', 'Refund',
    'entityId', v_request.id,
    'createdAt', v_now
  ));

  RETURN jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_request.id,
      'saleId', v_request.sale_id,
      'shopId', v_request.shop_id,
      'type', v_request.type,
      'reason', v_request.reason,
      'createdBy', v_request.created_by,
      'createdAt', v_request.created_at,
      'items', v_request.items,
      'status', v_request.status
    ),
    'sale', jsonb_build_object(
      'id', v_sale.id,
      'shopId', v_sale.shop_id,
      'shiftId', v_sale.shift_id,
      'receiptNo', v_sale.receipt_no,
      'cashierId', v_sale.cashier_id,
      'status', v_sale.status,
      'subtotalMmk', v_sale.subtotal_mmk,
      'discountMmk', v_sale.discount_mmk,
      'cartDiscountPct', v_sale.cart_discount_pct,
      'totalMmk', v_sale.total_mmk,
      'paymentMethod', v_sale.payment_method,
      'paidMmk', v_sale.paid_mmk,
      'changeMmk', v_sale.change_mmk,
      'createdAt', v_sale.created_at
    ),
    'inventory', v_inventory,
    'movements', v_movements,
    'auditLogs', v_audit_logs
  );
END;
$$;


ALTER FUNCTION "public"."approve_refund_request"("p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_stock_transfer"("p_transfer_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_t stock_transfers; v_now timestamptz := now();
  v_audit_id text; v_items jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_t FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_t.id IS NULL THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
  IF v_t.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Transfer cannot be approved from status %', v_t.status;
  END IF;
  IF NOT app_can_for_shop('transfer:approve', v_t.from_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to approve transfers for this shop';
  END IF;

  -- approved quantity defaults to the requested base-unit quantity
  UPDATE stock_transfer_items SET approved_qty = requested_qty WHERE transfer_id = v_t.id;
  UPDATE stock_transfers
     SET status = 'APPROVED', approved_by = v_user.id, approved_at = v_now
   WHERE id = v_t.id RETURNING * INTO v_t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'transferId', i.transfer_id,
    'productId', i.product_id,
    'requestedQty', i.requested_qty,
    'approvedQty', i.approved_qty,
    'transferredQty', i.transferred_qty,
    'productUnitId', i.product_unit_id,
    'unitNameSnapshot', i.unit_name_snapshot,
    'unitBaseQuantitySnapshot', i.unit_base_quantity_snapshot,
    'selectedUnitQuantity', i.selected_unit_quantity
  )), '[]'::jsonb)
    INTO v_items FROM stock_transfer_items i WHERE i.transfer_id = v_t.id;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_t.from_shop_id, v_user.id, 'TRANSFER_APPROVED',
    'Transfer ' || v_t.transfer_no || ' approved', 'StockTransfer', v_t.id, v_now);

  RETURN jsonb_build_object(
    'stockTransfer', transfer_json(v_t),
    'stockTransferItems', v_items,
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_t.from_shop_id, 'actorId', v_user.id, 'actionType', 'TRANSFER_APPROVED',
      'message', 'Transfer ' || v_t.transfer_no || ' approved',
      'entityType', 'StockTransfer', 'entityId', v_t.id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."approve_stock_transfer"("p_transfer_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_void_request"("p_request_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid    uuid := auth.uid();
  v_user        users;
  v_request     refund_void_requests;
  v_sale        sales;
  v_now         timestamptz := now();
  v_sale_item   sale_items;
  v_qty_before  integer;
  v_qty_after   integer;
  v_move_id     text;
  v_audit_id    text;
  v_movements   jsonb := '[]'::jsonb;
  v_inventory   jsonb := '[]'::jsonb;
  v_audit_logs  jsonb := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_has_perm('pos:void_sale') THEN
    RAISE EXCEPTION 'You are not permitted to approve voids';
  END IF;

  SELECT * INTO v_request
    FROM refund_void_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Void request not found';
  END IF;

  IF v_request.type <> 'VOID' THEN
    RAISE EXCEPTION 'Request is not a void request';
  END IF;

  IF v_request.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'Void request is not pending';
  END IF;

  SELECT * INTO v_sale
    FROM sales
   WHERE id = v_request.sale_id
   FOR UPDATE;

  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  IF v_request.shop_id IS DISTINCT FROM v_sale.shop_id THEN
    RAISE EXCEPTION 'Void request shop does not match sale shop';
  END IF;

  IF NOT app_can_for_shop('pos:void_sale', v_sale.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to approve voids in this shop';
  END IF;

  IF v_request.created_by = v_user.id THEN
    RAISE EXCEPTION 'You cannot approve your own void request';
  END IF;

  IF v_sale.status <> 'NORMAL' THEN
    RAISE EXCEPTION 'Sale is not voidable';
  END IF;

  FOR v_sale_item IN SELECT * FROM sale_items WHERE sale_id = v_sale.id
  LOOP
    SELECT qty_base_units INTO v_qty_before
      FROM inventory
     WHERE shop_id = v_sale.shop_id AND product_id = v_sale_item.product_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inventory row not found for void item %', v_sale_item.product_id;
    END IF;

    v_qty_after := v_qty_before + v_sale_item.qty_units;

    UPDATE inventory
       SET qty_base_units = v_qty_after
     WHERE shop_id = v_sale.shop_id AND product_id = v_sale_item.product_id;

    v_move_id := 'move-' || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO inventory_movements (
      id, shop_id, product_id, type, qty_change,
      qty_before, qty_after, reason, reference_type, reference_id,
      created_by, created_at
    )
    VALUES (
      v_move_id, v_sale.shop_id, v_sale_item.product_id, 'RETURN_IN',
      v_sale_item.qty_units, v_qty_before, v_qty_after,
      'Void approved for ' || v_sale.receipt_no || ': ' || v_request.reason,
      'sale', v_sale.id, v_user.id, v_now
    );

    v_movements := v_movements || jsonb_build_array(jsonb_build_object(
      'id', v_move_id,
      'shopId', v_sale.shop_id,
      'productId', v_sale_item.product_id,
      'type', 'RETURN_IN',
      'qtyChange', v_sale_item.qty_units,
      'qtyBefore', v_qty_before,
      'qtyAfter', v_qty_after,
      'reason', 'Void approved for ' || v_sale.receipt_no || ': ' || v_request.reason,
      'referenceType', 'sale',
      'referenceId', v_sale.id,
      'createdBy', v_user.id,
      'createdAt', v_now
    ));

    v_inventory := v_inventory || jsonb_build_array(jsonb_build_object(
      'shopId', v_sale.shop_id,
      'productId', v_sale_item.product_id,
      'qtyBaseUnits', v_qty_after
    ));
  END LOOP;

  UPDATE refund_void_requests
     SET status = 'APPROVED'
   WHERE id = v_request.id
   RETURNING * INTO v_request;

  UPDATE sales
     SET status = 'VOID'
   WHERE id = v_sale.id
   RETURNING * INTO v_sale;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, v_sale.shop_id, v_user.id, 'VOID_SALE',
    'Void approved for sale ' || v_sale.receipt_no || '. Reason: ' || v_request.reason,
    'Sale', v_sale.id, v_now
  );

  v_audit_logs := v_audit_logs || jsonb_build_array(jsonb_build_object(
    'id', v_audit_id,
    'shopId', v_sale.shop_id,
    'actorId', v_user.id,
    'actionType', 'VOID_SALE',
    'message', 'Void approved for sale ' || v_sale.receipt_no || '. Reason: ' || v_request.reason,
    'entityType', 'Sale',
    'entityId', v_sale.id,
    'createdAt', v_now
  ));

  RETURN jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_request.id,
      'saleId', v_request.sale_id,
      'shopId', v_request.shop_id,
      'type', v_request.type,
      'reason', v_request.reason,
      'createdBy', v_request.created_by,
      'createdAt', v_request.created_at,
      'items', v_request.items,
      'status', v_request.status
    ),
    'sale', jsonb_build_object(
      'id', v_sale.id,
      'shopId', v_sale.shop_id,
      'shiftId', v_sale.shift_id,
      'receiptNo', v_sale.receipt_no,
      'cashierId', v_sale.cashier_id,
      'status', v_sale.status,
      'subtotalMmk', v_sale.subtotal_mmk,
      'discountMmk', v_sale.discount_mmk,
      'cartDiscountPct', v_sale.cart_discount_pct,
      'totalMmk', v_sale.total_mmk,
      'paymentMethod', v_sale.payment_method,
      'paidMmk', v_sale.paid_mmk,
      'changeMmk', v_sale.change_mmk,
      'createdAt', v_sale.created_at
    ),
    'inventory', v_inventory,
    'movements', v_movements,
    'auditLogs', v_audit_logs
  );
END;
$$;


ALTER FUNCTION "public"."approve_void_request"("p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attach_product_image_upload_session_token"("p_session_id" "text", "p_signed_upload_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users;
  v_session product_image_upload_sessions;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF COALESCE(btrim(p_signed_upload_token), '') = '' THEN
    RAISE EXCEPTION 'Signed upload token is required';
  END IF;

  SELECT * INTO v_session
    FROM product_image_upload_sessions
   WHERE id = p_session_id
     AND created_by = v_user.id
   FOR UPDATE;

  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'Upload session not found';
  END IF;

  IF v_session.status <> 'PENDING' OR v_session.expires_at <= now() THEN
    UPDATE product_image_upload_sessions
       SET status = CASE WHEN status = 'PENDING' THEN 'EXPIRED' ELSE status END,
           signed_upload_token = NULL
     WHERE id = v_session.id
     RETURNING * INTO v_session;
    RAISE EXCEPTION 'Upload link is no longer active';
  END IF;

  UPDATE product_image_upload_sessions
     SET signed_upload_token = p_signed_upload_token
   WHERE id = v_session.id
   RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'storagePath', v_session.storage_path,
    'expiresAt', v_session.expires_at,
    'status', v_session.status
  );
END;
$$;


ALTER FUNCTION "public"."attach_product_image_upload_session_token"("p_session_id" "text", "p_signed_upload_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."brands_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."brands_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_product_image_upload_session"("p_session_id" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE product_image_upload_sessions
     SET status = 'CANCELED',
         signed_upload_token = NULL
   WHERE id = p_session_id
     AND created_by = v_user.id
     AND status = 'PENDING';
END;
$$;


ALTER FUNCTION "public"."cancel_product_image_upload_session"("p_session_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_purchase_order"("p_purchase_order_id" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_po purchase_orders; v_now timestamptz := now();
  v_audit_id text; v_msg text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_purchase_order_id FOR UPDATE;
  IF v_po.id IS NULL THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF v_po.status IN ('RECEIVED', 'CANCELED') THEN
    RAISE EXCEPTION 'Purchase order cannot be canceled from status %', v_po.status;
  END IF;
  IF NOT app_can_for_shop('purchase:create', v_po.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to cancel purchase orders for this shop';
  END IF;

  UPDATE purchase_orders SET status = 'CANCELED' WHERE id = v_po.id RETURNING * INTO v_po;

  v_msg := 'Purchase order ' || v_po.order_no || ' canceled'
           || COALESCE('. Reason: ' || NULLIF(btrim(p_reason), ''), '');
  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_po.shop_id, v_user.id, 'PO_CANCELED', v_msg, 'PurchaseOrder', v_po.id, v_now);

  RETURN jsonb_build_object(
    'purchaseOrder', jsonb_build_object(
      'id', v_po.id, 'orderNo', v_po.order_no, 'shopId', v_po.shop_id, 'supplierId', v_po.supplier_id,
      'status', v_po.status, 'subtotalMmk', v_po.subtotal_mmk, 'taxMmk', v_po.tax_mmk,
      'totalMmk', v_po.total_mmk, 'notes', v_po.notes, 'createdBy', v_po.created_by,
      'createdAt', v_po.created_at, 'approvedBy', v_po.approved_by, 'approvedAt', v_po.approved_at,
      'receivedBy', v_po.received_by, 'receivedAt', v_po.received_at),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_po.shop_id, 'actorId', v_user.id, 'actionType', 'PO_CANCELED',
      'message', v_msg, 'entityType', 'PurchaseOrder', 'entityId', v_po.id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."cancel_purchase_order"("p_purchase_order_id" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_stock_transfer"("p_transfer_id" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_t stock_transfers; v_now timestamptz := now();
  v_audit_id text; v_msg text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_t FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_t.id IS NULL THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
  IF v_t.status IN ('COMPLETED', 'CANCELED') THEN
    RAISE EXCEPTION 'Transfer cannot be canceled from status %', v_t.status;
  END IF;
  IF NOT app_can_for_shop('transfer:cancel', v_t.from_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to cancel transfers for this shop';
  END IF;

  v_msg := COALESCE(NULLIF(btrim(p_reason), ''), 'No reason given');
  UPDATE stock_transfers
     SET status = 'CANCELED', canceled_by = v_user.id, canceled_at = v_now, cancel_reason = v_msg
   WHERE id = v_t.id RETURNING * INTO v_t;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_t.from_shop_id, v_user.id, 'TRANSFER_CANCELED',
    'Transfer ' || v_t.transfer_no || ' canceled. Reason: ' || v_msg,
    'StockTransfer', v_t.id, v_now);

  RETURN jsonb_build_object(
    'stockTransfer', transfer_json(v_t),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_t.from_shop_id, 'actorId', v_user.id, 'actionType', 'TRANSFER_CANCELED',
      'message', 'Transfer ' || v_t.transfer_no || ' canceled. Reason: ' || v_msg,
      'entityType', 'StockTransfer', 'entityId', v_t.id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."cancel_stock_transfer"("p_transfer_id" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."close_shift"("p_shift_id" "text", "p_closing_cash_mmk" integer, "p_variance_reason" "text" DEFAULT NULL::"text", "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_actor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid      uuid := auth.uid();
  v_user          users;
  v_shift         shifts;
  v_now           timestamptz := resolve_event_time(p_created_at);
  v_cash_sales    integer := 0;
  v_cash_refunds  integer := 0;
  v_expected_cash integer;
  v_variance      integer;
  v_audit_id      text;
  v_audit_logs    jsonb := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This offline action was queued by a different user — reconnect as them to sync it, or dismiss it from Sync Conflicts.';
  END IF;

  IF p_shift_id IS NULL OR btrim(p_shift_id) = '' THEN
    RAISE EXCEPTION 'Shift is required';
  END IF;

  IF p_closing_cash_mmk IS NULL OR p_closing_cash_mmk < 0 THEN
    RAISE EXCEPTION 'Closing cash must be zero or greater';
  END IF;

  SELECT * INTO v_shift
    FROM shifts
   WHERE id = p_shift_id
   FOR UPDATE;

  IF v_shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift not found';
  END IF;

  IF v_shift.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'Shift is already closed';
  END IF;

  IF NOT (
    (v_shift.cashier_id = v_user.id AND app_can_for_shop('shift:manage_own', v_shift.shop_id))
    OR app_can_for_shop('shift:manage_all', v_shift.shop_id)
  ) THEN
    RAISE EXCEPTION 'You are not permitted to close this shift';
  END IF;

  SELECT COALESCE(sum(total_mmk), 0) INTO v_cash_sales
    FROM sales
   WHERE shift_id = v_shift.id
     AND payment_method = 'CASH'
     AND status <> 'VOID';

  SELECT COALESCE(sum((COALESCE(item->>'amountMmk', item->>'amount_mmk'))::integer), 0)
    INTO v_cash_refunds
    FROM refund_void_requests r
    JOIN sales s ON s.id = r.sale_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.items, '[]'::jsonb)) item
   WHERE s.shift_id = v_shift.id
     AND s.payment_method = 'CASH'
     AND r.type = 'PARTIAL'
     AND r.status = 'APPROVED';

  v_expected_cash := v_shift.opening_cash_mmk + v_cash_sales - v_cash_refunds;
  v_variance := p_closing_cash_mmk - v_expected_cash;

  IF v_variance <> 0 AND COALESCE(btrim(p_variance_reason), '') = '' THEN
    RAISE EXCEPTION 'Variance reason is required when closing cash does not match expected cash';
  END IF;

  UPDATE shifts
     SET ended_at = v_now,
         closing_cash_mmk = p_closing_cash_mmk,
         expected_cash_mmk = v_expected_cash,
         variance_mmk = v_variance,
         variance_reason = NULLIF(btrim(p_variance_reason), '')
   WHERE id = v_shift.id
   RETURNING * INTO v_shift;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, v_shift.shop_id, v_user.id, 'SHIFT_CLOSED',
    'Closed shift. Expected cash ' || v_expected_cash || ' MMK, closing cash '
      || p_closing_cash_mmk || ' MMK, variance ' || v_variance || ' MMK',
    'Shift', v_shift.id, v_now
  );

  v_audit_logs := v_audit_logs || jsonb_build_array(jsonb_build_object(
    'id', v_audit_id,
    'shopId', v_shift.shop_id,
    'actorId', v_user.id,
    'actionType', 'SHIFT_CLOSED',
    'message', 'Closed shift. Expected cash ' || v_expected_cash || ' MMK, closing cash '
      || p_closing_cash_mmk || ' MMK, variance ' || v_variance || ' MMK',
    'entityType', 'Shift',
    'entityId', v_shift.id,
    'createdAt', v_now
  ));

  RETURN jsonb_build_object(
    'shift', jsonb_build_object(
      'id', v_shift.id,
      'shopId', v_shift.shop_id,
      'cashierId', v_shift.cashier_id,
      'startedAt', v_shift.started_at,
      'endedAt', v_shift.ended_at,
      'openingCashMmk', v_shift.opening_cash_mmk,
      'closingCashMmk', v_shift.closing_cash_mmk,
      'expectedCashMmk', v_shift.expected_cash_mmk,
      'varianceMmk', v_shift.variance_mmk,
      'varianceReason', v_shift.variance_reason
    ),
    'auditLogs', v_audit_logs
  );
END;
$$;


ALTER FUNCTION "public"."close_shift"("p_shift_id" "text", "p_closing_cash_mmk" integer, "p_variance_reason" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_product_image_upload_session"("p_token" "text", "p_storage_path" "text", "p_public_url" "text", "p_bytes" integer, "p_mime_type" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_session product_image_upload_sessions;
BEGIN
  IF COALESCE(length(p_token), 0) < 32 THEN
    RAISE EXCEPTION 'Invalid upload link';
  END IF;

  SELECT * INTO v_session
    FROM product_image_upload_sessions
   WHERE token_hash = product_image_upload_token_hash(p_token)
   FOR UPDATE;

  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'Invalid upload link';
  END IF;

  IF v_session.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Upload link is no longer active';
  END IF;

  IF v_session.expires_at <= now() THEN
    UPDATE product_image_upload_sessions
       SET status = 'EXPIRED',
           signed_upload_token = NULL
     WHERE id = v_session.id;
    RAISE EXCEPTION 'Upload link has expired';
  END IF;

  IF p_storage_path IS DISTINCT FROM v_session.storage_path THEN
    RAISE EXCEPTION 'Upload path does not match this session';
  END IF;

  IF p_bytes IS NULL OR p_bytes <= 0 OR p_bytes > 102400 THEN
    RAISE EXCEPTION 'Uploaded image must be 100 KB or smaller';
  END IF;

  IF p_mime_type NOT IN ('image/webp', 'image/jpeg') THEN
    RAISE EXCEPTION 'Unsupported uploaded image type';
  END IF;

  IF COALESCE(btrim(p_public_url), '') = '' OR lower(p_public_url) LIKE 'data:%' THEN
    RAISE EXCEPTION 'Uploaded image URL must be a Storage URL';
  END IF;

  IF position('/storage/v1/object/public/product-images/' in p_public_url) = 0 THEN
    RAISE EXCEPTION 'Uploaded image URL must point to the product-images bucket';
  END IF;

  UPDATE product_image_upload_sessions
     SET status = 'COMPLETED',
         storage_path = p_storage_path,
         public_url = p_public_url,
         bytes = p_bytes,
         mime_type = p_mime_type,
         signed_upload_token = NULL,
         completed_at = now()
   WHERE id = v_session.id
   RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'storagePath', v_session.storage_path,
    'publicUrl', v_session.public_url,
    'bytes', v_session.bytes,
    'mimeType', v_session.mime_type,
    'expiresAt', v_session.expires_at,
    'status', v_session.status
  );
END;
$$;


ALTER FUNCTION "public"."complete_product_image_upload_session"("p_token" "text", "p_storage_path" "text", "p_public_url" "text", "p_bytes" integer, "p_mime_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_sale"("p_shop_id" "text", "p_shift_id" "text", "p_payment_method" "text", "p_paid_mmk" integer, "p_cart_discount_pct" numeric, "p_items" "jsonb", "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid          uuid := auth.uid();
  v_user              users;
  v_shop              shops;
  v_sale_id           text := 'sale-' || replace(gen_random_uuid()::text, '-', '');
  v_now               timestamptz := resolve_event_time(p_created_at);
  v_receipt_no        text;
  v_seq               integer;
  v_can_ovr_stock     boolean;
  v_can_ovr_price     boolean;
  v_default_level     price_levels;

  v_item              jsonb;
  v_product           products;
  v_unit              product_units;
  v_product_unit_id   text;
  v_qty               integer;
  v_base_qty_sold     integer;
  v_unit_price        integer;
  v_item_disc         numeric;
  v_line_total        integer;
  v_qty_before        integer;
  v_qty_after         integer;
  v_price_ovr         boolean;
  v_expected_price    integer;
  v_line_key          text;

  v_requested_level_id text;
  v_level             price_levels;
  v_resolved_level_id text;
  v_resolved_level_nm text;
  v_resolved_source   text;

  v_is_open_price     boolean;
  v_is_non_stock      boolean;
  v_client_price_raw  text;

  v_subtotal          integer := 0;
  v_after_disc        integer := 0;
  v_cart_disc         integer;
  v_total             integer;
  v_discount          integer;
  v_change            integer;

  v_computed          jsonb := '[]'::jsonb;
  v_c                 jsonb;

  -- Running on-hand per product across the cart lines (migration 034).
  v_stock_running     jsonb := '{}'::jsonb;

  v_items_out         jsonb := '[]'::jsonb;
  v_moves_out         jsonb := '[]'::jsonb;
  v_inv_out           jsonb := '[]'::jsonb;
  v_audit_out         jsonb := '[]'::jsonb;

  v_sale_item_id      text;
  v_move_id           text;
  v_audit_id          text;
  v_po_by             text;
  v_so_by             text;
BEGIN
  IF v_auth_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT app_has_perm('pos:create_sale') THEN
    RAISE EXCEPTION 'You are not permitted to create sales';
  END IF;
  IF NOT app_can_for_shop('pos:create_sale', p_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to create sales in this shop';
  END IF;

  IF p_shop_id IS NULL OR btrim(p_shop_id) = '' THEN RAISE EXCEPTION 'Shop is required'; END IF;
  IF p_shift_id IS NULL OR btrim(p_shift_id) = '' THEN RAISE EXCEPTION 'Open shift is required'; END IF;
  IF p_payment_method NOT IN ('CASH', 'OTHER') THEN RAISE EXCEPTION 'Unsupported payment method'; END IF;
  IF p_paid_mmk IS NULL OR p_paid_mmk < 0 THEN RAISE EXCEPTION 'Paid amount must be zero or greater'; END IF;
  IF COALESCE(p_cart_discount_pct, 0) < 0 OR COALESCE(p_cart_discount_pct, 0) > 100 THEN
    RAISE EXCEPTION 'Cart discount must be between 0 and 100';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Cart is empty';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e WHERE COALESCE(e->>'product_id', '') = ''
  ) THEN
    RAISE EXCEPTION 'Product is required for every sale item';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('complete_sale:' || p_shop_id));

  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id;
  IF v_shop.id IS NULL THEN RAISE EXCEPTION 'Shop not found'; END IF;

  PERFORM 1 FROM shifts WHERE id = p_shift_id AND shop_id = p_shop_id
    AND cashier_id = v_user.id AND ended_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No open shift for this cashier and shop'; END IF;

  v_can_ovr_stock := app_has_perm('pos:override_stock');
  v_can_ovr_price := app_has_perm('pos:override_price');

  SELECT * INTO v_default_level FROM price_levels
   WHERE is_default = true AND is_active = true LIMIT 1;

  SELECT count(*) INTO v_seq FROM sales
   WHERE shop_id = p_shop_id AND created_at::date = v_now::date;
  v_receipt_no := v_shop.code || '-' || to_char(v_now, 'YYYYMMDD')
                  || '-' || lpad((v_seq + 1)::text, 4, '0');

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) AS t(value)
  LOOP
    SELECT * INTO v_product FROM products
     WHERE id = (v_item->>'product_id') AND is_active = true;
    IF v_product.id IS NULL THEN
      RAISE EXCEPTION 'Product not found or inactive: %', (v_item->>'product_id');
    END IF;

    v_is_open_price := COALESCE(v_product.is_open_price, false);
    v_is_non_stock  := COALESCE(v_product.is_non_stock, false);

    v_product_unit_id := NULLIF(v_item->>'product_unit_id', '');
    IF v_product_unit_id IS NULL THEN
      SELECT * INTO v_unit FROM product_units
       WHERE product_id = v_product.id AND is_active = true AND is_default = true LIMIT 1;
    ELSE
      SELECT * INTO v_unit FROM product_units
       WHERE id = v_product_unit_id AND product_id = v_product.id AND is_active = true;
    END IF;
    IF v_unit.id IS NULL THEN
      RAISE EXCEPTION 'Sellable unit not found or inactive for %', v_product.name;
    END IF;

    v_requested_level_id := NULLIF(v_item->>'price_level_id', '');
    IF v_requested_level_id IS NULL THEN
      v_level := v_default_level;
    ELSE
      SELECT * INTO v_level FROM price_levels
       WHERE id = v_requested_level_id AND is_active = true;
      IF v_level.id IS NULL THEN
        RAISE EXCEPTION 'Price level % is not active', v_requested_level_id;
      END IF;
    END IF;
    IF v_level.id IS NULL THEN
      RAISE EXCEPTION 'No active price level available';
    END IF;

    v_resolved_level_id := v_level.id;
    v_resolved_level_nm := v_level.name;
    v_expected_price    := NULL;
    v_resolved_source   := NULL;
    v_price_ovr         := false;

    IF v_is_open_price THEN
      v_client_price_raw := NULLIF(v_item->>'unit_price_mmk', '');
      IF v_client_price_raw IS NULL THEN
        RAISE EXCEPTION 'Open Price item % requires a unit price', v_product.name;
      END IF;
      v_unit_price := v_client_price_raw::integer;
      IF v_unit_price <= 0 THEN
        RAISE EXCEPTION 'Open Price for % must be greater than 0', v_product.name;
      END IF;
      v_resolved_source := 'open_price';
      v_expected_price  := v_unit_price;

    ELSE
      SELECT price_mmk INTO v_expected_price FROM product_unit_prices
       WHERE product_unit_id = v_unit.id AND price_level_id = v_level.id
         AND shop_id = p_shop_id AND is_active = true LIMIT 1;
      IF v_expected_price IS NOT NULL THEN
        v_resolved_source := 'shop_override';
      ELSE
        SELECT price_mmk INTO v_expected_price FROM product_unit_prices
         WHERE product_unit_id = v_unit.id AND price_level_id = v_level.id
           AND shop_id IS NULL AND is_active = true LIMIT 1;
        IF v_expected_price IS NOT NULL THEN
          v_resolved_source := 'global_price_level';
        END IF;
      END IF;

      IF v_expected_price IS NULL AND v_default_level.id IS NOT NULL AND v_level.id <> v_default_level.id THEN
        SELECT price_mmk INTO v_expected_price FROM product_unit_prices
         WHERE product_unit_id = v_unit.id AND price_level_id = v_default_level.id
           AND shop_id = p_shop_id AND is_active = true LIMIT 1;
        IF v_expected_price IS NOT NULL THEN
          v_resolved_level_id := v_default_level.id;
          v_resolved_level_nm := v_default_level.name;
          v_resolved_source   := 'retail_fallback_shop';
        ELSE
          SELECT price_mmk INTO v_expected_price FROM product_unit_prices
           WHERE product_unit_id = v_unit.id AND price_level_id = v_default_level.id
             AND shop_id IS NULL AND is_active = true LIMIT 1;
          IF v_expected_price IS NOT NULL THEN
            v_resolved_level_id := v_default_level.id;
            v_resolved_level_nm := v_default_level.name;
            v_resolved_source   := 'retail_fallback_global';
          END IF;
        END IF;
      END IF;

      IF v_expected_price IS NULL THEN
        v_expected_price  := v_unit.sale_price_mmk;
        v_resolved_source := 'legacy_sale_price';
      END IF;

      IF v_expected_price IS NULL THEN
        RAISE EXCEPTION 'No active price configured for %', v_product.name;
      END IF;

      v_unit_price := v_expected_price;
    END IF;

    IF v_is_open_price THEN
      v_line_key := v_product.id || ':' || v_unit.id || ':' || v_resolved_level_id
                   || ':open:' || replace(gen_random_uuid()::text, '-', '');
    ELSE
      v_line_key := v_product.id || ':' || v_unit.id || ':' || v_resolved_level_id;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_computed) e WHERE e->>'line_key' = v_line_key) THEN
      RAISE EXCEPTION 'A product unit + price level appears more than once in the cart; combine the lines';
    END IF;

    v_qty := NULLIF(v_item->>'qty', '')::integer;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity for %', v_product.name;
    END IF;
    v_base_qty_sold := v_qty * v_unit.base_quantity;

    IF NOT v_is_open_price
       AND v_unit.is_default
       AND v_resolved_level_id = COALESCE(v_default_level.id, '') THEN
      SELECT pt.price_mmk INTO v_unit_price FROM price_tiers pt
       WHERE pt.product_id = v_product.id AND pt.is_active = true
         AND (pt.shop_id = p_shop_id OR pt.shop_id IS NULL)
         AND v_base_qty_sold >= pt.min_qty
         AND (pt.max_qty IS NULL OR v_base_qty_sold <= pt.max_qty)
       ORDER BY CASE WHEN pt.shop_id = p_shop_id THEN 0 ELSE 1 END, pt.min_qty DESC LIMIT 1;
      v_unit_price := COALESCE(v_unit_price, v_expected_price);
    END IF;

    IF NOT v_is_open_price
       AND v_item ? 'unit_price_mmk'
       AND NULLIF(v_item->>'unit_price_mmk', '') IS NOT NULL THEN
      DECLARE v_client_price integer := (v_item->>'unit_price_mmk')::integer;
      BEGIN
        IF v_client_price < 0 THEN RAISE EXCEPTION 'Invalid unit price for %', v_product.name; END IF;
        IF v_client_price <> v_unit_price THEN
          IF NOT v_can_ovr_price THEN
            RAISE EXCEPTION 'You are not permitted to override prices';
          END IF;
          v_unit_price := v_client_price;
          v_resolved_source := 'manual_override';
        END IF;
      END;
    END IF;

    v_price_ovr := (v_resolved_source = 'manual_override');

    v_item_disc := COALESCE(NULLIF(v_item->>'item_discount_pct', '')::numeric, 0);
    IF v_item_disc < 0 OR v_item_disc > 100 THEN
      RAISE EXCEPTION 'Item discount must be between 0 and 100 for %', v_product.name;
    END IF;

    -- ------------------------------------------------------------------
    -- Inventory branch. Non-stock products skip the whole chain. For
    -- stock-tracked products we keep a per-product running on-hand value
    -- (`v_stock_running`) so multiple lines for the same product deduct
    -- cumulatively instead of all reading the same starting stock — the
    -- migration 034 fix. The first line per product reads + locks the
    -- inventory row; later lines start from the prior line's result.
    -- ------------------------------------------------------------------
    IF v_is_non_stock THEN
      v_qty_before := NULL;
      v_qty_after  := NULL;
    ELSE
      IF v_stock_running ? v_product.id THEN
        v_qty_before := (v_stock_running ->> v_product.id)::integer;
      ELSE
        SELECT qty_base_units INTO v_qty_before FROM inventory
         WHERE shop_id = p_shop_id AND product_id = v_product.id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory row not found for % in %', v_product.name, v_shop.name;
        END IF;
      END IF;

      v_qty_after := v_qty_before - v_base_qty_sold;
      IF v_qty_after < 0 AND NOT v_can_ovr_stock THEN
        RAISE EXCEPTION 'Insufficient stock for %: have %, need %',
          v_product.name, v_qty_before, v_base_qty_sold;
      END IF;

      v_stock_running := jsonb_set(v_stock_running, ARRAY[v_product.id], to_jsonb(v_qty_after));
    END IF;

    v_line_total := round(v_qty * v_unit_price * (1 - v_item_disc / 100))::integer;
    v_subtotal   := v_subtotal + (v_unit_price * v_qty);
    v_after_disc := v_after_disc + v_line_total;

    v_computed := v_computed || jsonb_build_array(jsonb_build_object(
      'line_key',          v_line_key,
      'product_id',        v_product.id,
      'product_name',      v_product.name,
      'product_unit_id',   v_unit.id,
      'unit_name',         v_unit.name,
      'unit_base_qty',     v_unit.base_quantity,
      'qty',               v_qty,
      'base_qty_sold',     v_base_qty_sold,
      'unit_price',        v_unit_price,
      'unit_cost',         v_product.cost_mmk,   -- migration 041: COGS snapshot (per base unit)
      'item_discount',     v_item_disc,
      'line_total',        v_line_total,
      'qty_before',        v_qty_before,
      'qty_after',         v_qty_after,
      'price_ovr',         v_price_ovr,
      'stock_ovr',         CASE WHEN v_is_non_stock THEN false ELSE (v_qty_after < 0) END,
      'is_non_stock',      v_is_non_stock,
      'is_open_price',     v_is_open_price,
      'price_level_id',    v_resolved_level_id,
      'price_level_name',  v_resolved_level_nm,
      'price_source',      v_resolved_source
    ));
  END LOOP;

  v_cart_disc := round(v_after_disc * COALESCE(p_cart_discount_pct, 0) / 100)::integer;
  v_total     := greatest(0, v_after_disc - v_cart_disc);
  v_discount  := v_subtotal - v_total;
  v_change    := greatest(0, p_paid_mmk - v_total);
  IF p_paid_mmk < v_total THEN RAISE EXCEPTION 'Paid amount is less than the sale total'; END IF;

  INSERT INTO sales (
    id, shop_id, shift_id, receipt_no, cashier_id, status,
    subtotal_mmk, discount_mmk, cart_discount_pct, total_mmk,
    payment_method, paid_mmk, change_mmk, created_at
  )
  VALUES (
    v_sale_id, p_shop_id, p_shift_id, v_receipt_no, v_user.id, 'NORMAL',
    v_subtotal, v_discount, COALESCE(p_cart_discount_pct, 0), v_total,
    p_payment_method, p_paid_mmk, v_change, v_now
  );

  FOR v_c IN SELECT value FROM jsonb_array_elements(v_computed) AS t(value)
  LOOP
    v_po_by := CASE WHEN (v_c->>'price_ovr')::boolean THEN v_user.id ELSE NULL END;
    v_so_by := CASE WHEN (v_c->>'stock_ovr')::boolean THEN v_user.id ELSE NULL END;
    v_sale_item_id := 'item-' || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO sale_items (
      id, sale_id, product_id, product_unit_id, qty_units, unit_price_mmk,
      item_discount_pct, line_total_mmk, price_overridden_by,
      unit_label, units_per_item, unit_name_snapshot,
      unit_base_quantity_snapshot, unit_price_mmk_snapshot,
      base_quantity_sold, stock_override_by,
      price_level_id, price_level_name_snapshot, price_source_snapshot,
      unit_cost_mmk_snapshot
    )
    VALUES (
      v_sale_item_id, v_sale_id, v_c->>'product_id', v_c->>'product_unit_id',
      (v_c->>'base_qty_sold')::integer, (v_c->>'unit_price')::integer,
      NULLIF((v_c->>'item_discount')::numeric, 0),
      (v_c->>'line_total')::integer, v_po_by,
      v_c->>'unit_name', (v_c->>'unit_base_qty')::integer,
      v_c->>'unit_name', (v_c->>'unit_base_qty')::integer,
      (v_c->>'unit_price')::integer, (v_c->>'base_qty_sold')::integer,
      v_so_by,
      v_c->>'price_level_id', v_c->>'price_level_name', v_c->>'price_source',
      (v_c->>'unit_cost')::integer
    );

    IF NOT (v_c->>'is_non_stock')::boolean THEN
      UPDATE inventory SET qty_base_units = (v_c->>'qty_after')::integer
       WHERE shop_id = p_shop_id AND product_id = v_c->>'product_id';

      v_move_id := 'move-' || replace(gen_random_uuid()::text, '-', '');
      INSERT INTO inventory_movements (
        id, shop_id, product_id, type, qty_change,
        qty_before, qty_after, reason, reference_type, reference_id,
        created_by, created_at,
        product_unit_id, unit_name_snapshot, unit_base_quantity_snapshot,
        selected_unit_quantity
      )
      VALUES (
        v_move_id, p_shop_id, v_c->>'product_id', 'SALE_OUT',
        -(v_c->>'base_qty_sold')::integer, (v_c->>'qty_before')::integer,
        (v_c->>'qty_after')::integer, 'Sale ' || v_receipt_no,
        'sale', v_sale_id, v_user.id, v_now,
        v_c->>'product_unit_id', v_c->>'unit_name',
        (v_c->>'unit_base_qty')::integer, (v_c->>'qty')::integer
      );

      v_moves_out := v_moves_out || jsonb_build_array(jsonb_build_object(
        'id', v_move_id,
        'shopId', p_shop_id,
        'productId', v_c->>'product_id',
        'type', 'SALE_OUT',
        'qtyChange', -(v_c->>'base_qty_sold')::integer,
        'qtyBefore', (v_c->>'qty_before')::integer,
        'qtyAfter', (v_c->>'qty_after')::integer,
        'reason', 'Sale ' || v_receipt_no,
        'referenceType', 'sale',
        'referenceId', v_sale_id,
        'createdBy', v_user.id,
        'createdAt', v_now,
        'productUnitId', v_c->>'product_unit_id',
        'unitNameSnapshot', v_c->>'unit_name',
        'unitBaseQuantitySnapshot', (v_c->>'unit_base_qty')::integer,
        'selectedUnitQuantity', (v_c->>'qty')::integer
      ));

      v_inv_out := v_inv_out || jsonb_build_array(jsonb_build_object(
        'shopId', p_shop_id,
        'productId', v_c->>'product_id',
        'qtyBaseUnits', (v_c->>'qty_after')::integer
      ));
    END IF;

    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'id', v_sale_item_id,
      'saleId', v_sale_id,
      'productId', v_c->>'product_id',
      'productUnitId', v_c->>'product_unit_id',
      'qtyUnits', (v_c->>'base_qty_sold')::integer,
      'unitPriceMmk', (v_c->>'unit_price')::integer,
      'itemDiscountPct', NULLIF((v_c->>'item_discount')::numeric, 0),
      'lineTotalMmk', (v_c->>'line_total')::integer,
      'priceOverriddenBy', v_po_by,
      'unitLabel', v_c->>'unit_name',
      'unitsPerItem', (v_c->>'unit_base_qty')::integer,
      'unitNameSnapshot', v_c->>'unit_name',
      'unitBaseQuantitySnapshot', (v_c->>'unit_base_qty')::integer,
      'unitPriceMmkSnapshot', (v_c->>'unit_price')::integer,
      'baseQuantitySold', (v_c->>'base_qty_sold')::integer,
      'unitCostMmkSnapshot', (v_c->>'unit_cost')::integer,
      'stockOverrideBy', v_so_by,
      'priceLevelId', v_c->>'price_level_id',
      'priceLevelNameSnapshot', v_c->>'price_level_name',
      'priceSourceSnapshot', v_c->>'price_source'
    ));

    IF v_po_by IS NOT NULL THEN
      v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
      INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message,
        entity_type, entity_id, created_at)
      VALUES (v_audit_id, p_shop_id, v_user.id, 'PRICE_OVERRIDE',
        'Price override on ' || (v_c->>'product_name') || ' for sale ' || v_receipt_no,
        'Sale', v_sale_id, v_now);
      v_audit_out := v_audit_out || jsonb_build_array(jsonb_build_object(
        'id', v_audit_id, 'shopId', p_shop_id, 'actorId', v_user.id,
        'actionType', 'PRICE_OVERRIDE',
        'message', 'Price override on ' || (v_c->>'product_name') || ' for sale ' || v_receipt_no,
        'entityType', 'Sale', 'entityId', v_sale_id, 'createdAt', v_now));
    END IF;

    IF v_so_by IS NOT NULL THEN
      v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
      INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message,
        entity_type, entity_id, created_at)
      VALUES (v_audit_id, p_shop_id, v_user.id, 'STOCK_OVERRIDE',
        'Sold ' || (v_c->>'product_name') || ' below available stock for sale ' || v_receipt_no,
        'Sale', v_sale_id, v_now);
      v_audit_out := v_audit_out || jsonb_build_array(jsonb_build_object(
        'id', v_audit_id, 'shopId', p_shop_id, 'actorId', v_user.id,
        'actionType', 'STOCK_OVERRIDE',
        'message', 'Sold ' || (v_c->>'product_name') || ' below available stock for sale ' || v_receipt_no,
        'entityType', 'Sale', 'entityId', v_sale_id, 'createdAt', v_now));
    END IF;
  END LOOP;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at)
  VALUES (v_audit_id, p_shop_id, v_user.id, 'SALE_COMPLETED',
    'Completed sale ' || v_receipt_no || ' - total ' || v_total || ' MMK',
    'Sale', v_sale_id, v_now);
  v_audit_out := v_audit_out || jsonb_build_array(jsonb_build_object(
    'id', v_audit_id, 'shopId', p_shop_id, 'actorId', v_user.id,
    'actionType', 'SALE_COMPLETED',
    'message', 'Completed sale ' || v_receipt_no || ' - total ' || v_total || ' MMK',
    'entityType', 'Sale', 'entityId', v_sale_id, 'createdAt', v_now));

  RETURN jsonb_build_object(
    'sale', jsonb_build_object(
      'id', v_sale_id, 'shopId', p_shop_id, 'shiftId', p_shift_id,
      'receiptNo', v_receipt_no, 'cashierId', v_user.id, 'status', 'NORMAL',
      'subtotalMmk', v_subtotal, 'discountMmk', v_discount,
      'cartDiscountPct', COALESCE(p_cart_discount_pct, 0),
      'totalMmk', v_total, 'paymentMethod', p_payment_method,
      'paidMmk', p_paid_mmk, 'changeMmk', v_change, 'createdAt', v_now),
    'items', v_items_out,
    'movements', v_moves_out,
    'inventory', v_inv_out,
    'auditLogs', v_audit_out,
    'shopName', v_shop.name,
    'cashierName', v_user.name
  );
END;
$$;


ALTER FUNCTION "public"."complete_sale"("p_shop_id" "text", "p_shift_id" "text", "p_payment_method" "text", "p_paid_mmk" integer, "p_cart_discount_pct" numeric, "p_items" "jsonb", "p_created_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_stock_transfer"("p_transfer_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid    uuid := auth.uid();
  v_user        users;
  v_transfer    stock_transfers;
  v_now         timestamptz := now();
  v_titem       stock_transfer_items;
  v_qty         integer;
  v_src_before  integer;
  v_src_after   integer;
  v_dst_before  integer;
  v_dst_after   integer;
  v_item_count  integer := 0;
  v_move_id     text;
  v_audit_id    text;
  v_items_out   jsonb := '[]'::jsonb;
  v_inv_out     jsonb := '[]'::jsonb;
  v_moves_out   jsonb := '[]'::jsonb;
  v_audit_out   jsonb := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT app_has_perm('transfer:approve') THEN
    RAISE EXCEPTION 'You are not permitted to complete stock transfers';
  END IF;
  IF p_transfer_id IS NULL OR btrim(p_transfer_id) = '' THEN
    RAISE EXCEPTION 'Stock transfer is required';
  END IF;

  SELECT * INTO v_transfer FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN
    RAISE EXCEPTION 'Stock transfer not found';
  END IF;
  IF v_transfer.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Stock transfer is not in a completable (APPROVED) status';
  END IF;
  IF v_transfer.from_shop_id = v_transfer.to_shop_id THEN
    RAISE EXCEPTION 'Transfer source and destination shop are the same';
  END IF;
  IF NOT app_can_for_shop('transfer:approve', v_transfer.from_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to complete transfers for this shop';
  END IF;

  PERFORM pg_advisory_xact_lock(
    least(hashtext('xfer:' || v_transfer.from_shop_id),
          hashtext('xfer:' || v_transfer.to_shop_id))
  );
  PERFORM pg_advisory_xact_lock(
    greatest(hashtext('xfer:' || v_transfer.from_shop_id),
             hashtext('xfer:' || v_transfer.to_shop_id))
  );

  FOR v_titem IN
    SELECT * FROM stock_transfer_items
     WHERE transfer_id = v_transfer.id
     ORDER BY id
     FOR UPDATE
  LOOP
    v_qty := COALESCE(v_titem.approved_qty, v_titem.requested_qty);

    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    -- Source shop: decrement.
    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    VALUES (v_transfer.from_shop_id, v_titem.product_id, 0)
    ON CONFLICT (shop_id, product_id) DO NOTHING;

    SELECT qty_base_units INTO v_src_before
      FROM inventory
     WHERE shop_id = v_transfer.from_shop_id AND product_id = v_titem.product_id
     FOR UPDATE;

    v_src_after := v_src_before - v_qty;
    IF v_src_after < 0 THEN
      RAISE EXCEPTION 'Insufficient stock at source for %: have %, need %',
        v_titem.product_id, v_src_before, v_qty;
    END IF;

    UPDATE inventory SET qty_base_units = v_src_after
     WHERE shop_id = v_transfer.from_shop_id AND product_id = v_titem.product_id;

    -- Destination shop: increment.
    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    VALUES (v_transfer.to_shop_id, v_titem.product_id, 0)
    ON CONFLICT (shop_id, product_id) DO NOTHING;

    SELECT qty_base_units INTO v_dst_before
      FROM inventory
     WHERE shop_id = v_transfer.to_shop_id AND product_id = v_titem.product_id
     FOR UPDATE;

    v_dst_after := v_dst_before + v_qty;
    UPDATE inventory SET qty_base_units = v_dst_after
     WHERE shop_id = v_transfer.to_shop_id AND product_id = v_titem.product_id;

    -- OUT movement (carries the snapshot if set).
    v_move_id := 'move-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO inventory_movements (
      id, shop_id, product_id, type, qty_change,
      qty_before, qty_after, reason, reference_type, reference_id,
      created_by, created_at,
      product_unit_id, unit_name_snapshot, unit_base_quantity_snapshot,
      selected_unit_quantity
    )
    VALUES (
      v_move_id, v_transfer.from_shop_id, v_titem.product_id, 'TRANSFER_OUT', -v_qty,
      v_src_before, v_src_after, 'Stock transfer ' || v_transfer.transfer_no,
      'transfer', v_transfer.id, v_user.id, v_now,
      v_titem.product_unit_id, v_titem.unit_name_snapshot,
      v_titem.unit_base_quantity_snapshot, v_titem.selected_unit_quantity
    );

    v_moves_out := v_moves_out || jsonb_build_array(jsonb_build_object(
      'id', v_move_id,
      'shopId', v_transfer.from_shop_id,
      'productId', v_titem.product_id,
      'type', 'TRANSFER_OUT',
      'qtyChange', -v_qty,
      'qtyBefore', v_src_before,
      'qtyAfter', v_src_after,
      'reason', 'Stock transfer ' || v_transfer.transfer_no,
      'referenceType', 'transfer',
      'referenceId', v_transfer.id,
      'createdBy', v_user.id,
      'createdAt', v_now,
      'productUnitId', v_titem.product_unit_id,
      'unitNameSnapshot', v_titem.unit_name_snapshot,
      'unitBaseQuantitySnapshot', v_titem.unit_base_quantity_snapshot,
      'selectedUnitQuantity', v_titem.selected_unit_quantity
    ));

    -- IN movement (mirror snapshot).
    v_move_id := 'move-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO inventory_movements (
      id, shop_id, product_id, type, qty_change,
      qty_before, qty_after, reason, reference_type, reference_id,
      created_by, created_at,
      product_unit_id, unit_name_snapshot, unit_base_quantity_snapshot,
      selected_unit_quantity
    )
    VALUES (
      v_move_id, v_transfer.to_shop_id, v_titem.product_id, 'TRANSFER_IN', v_qty,
      v_dst_before, v_dst_after, 'Stock transfer ' || v_transfer.transfer_no,
      'transfer', v_transfer.id, v_user.id, v_now,
      v_titem.product_unit_id, v_titem.unit_name_snapshot,
      v_titem.unit_base_quantity_snapshot, v_titem.selected_unit_quantity
    );

    v_moves_out := v_moves_out || jsonb_build_array(jsonb_build_object(
      'id', v_move_id,
      'shopId', v_transfer.to_shop_id,
      'productId', v_titem.product_id,
      'type', 'TRANSFER_IN',
      'qtyChange', v_qty,
      'qtyBefore', v_dst_before,
      'qtyAfter', v_dst_after,
      'reason', 'Stock transfer ' || v_transfer.transfer_no,
      'referenceType', 'transfer',
      'referenceId', v_transfer.id,
      'createdBy', v_user.id,
      'createdAt', v_now,
      'productUnitId', v_titem.product_unit_id,
      'unitNameSnapshot', v_titem.unit_name_snapshot,
      'unitBaseQuantitySnapshot', v_titem.unit_base_quantity_snapshot,
      'selectedUnitQuantity', v_titem.selected_unit_quantity
    ));

    UPDATE stock_transfer_items SET transferred_qty = v_qty WHERE id = v_titem.id;

    v_inv_out := v_inv_out
      || jsonb_build_array(jsonb_build_object(
          'shopId', v_transfer.from_shop_id,
          'productId', v_titem.product_id,
          'qtyBaseUnits', v_src_after))
      || jsonb_build_array(jsonb_build_object(
          'shopId', v_transfer.to_shop_id,
          'productId', v_titem.product_id,
          'qtyBaseUnits', v_dst_after));

    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'id', v_titem.id,
      'transferId', v_titem.transfer_id,
      'productId', v_titem.product_id,
      'requestedQty', v_titem.requested_qty,
      'approvedQty', v_titem.approved_qty,
      'transferredQty', v_qty,
      'productUnitId', v_titem.product_unit_id,
      'unitNameSnapshot', v_titem.unit_name_snapshot,
      'unitBaseQuantitySnapshot', v_titem.unit_base_quantity_snapshot,
      'selectedUnitQuantity', v_titem.selected_unit_quantity
    ));

    v_item_count := v_item_count + 1;
  END LOOP;

  UPDATE stock_transfers
     SET status = 'COMPLETED', completed_at = v_now
   WHERE id = v_transfer.id
   RETURNING * INTO v_transfer;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, v_transfer.from_shop_id, v_user.id, 'TRANSFER_COMPLETED',
    'Stock transfer ' || v_transfer.transfer_no || ' completed (' || v_item_count || ' lines)',
    'StockTransfer', v_transfer.id, v_now
  );
  v_audit_out := v_audit_out || jsonb_build_array(jsonb_build_object(
    'id', v_audit_id,
    'shopId', v_transfer.from_shop_id,
    'actorId', v_user.id,
    'actionType', 'TRANSFER_COMPLETED',
    'message', 'Stock transfer ' || v_transfer.transfer_no || ' completed (' || v_item_count || ' lines)',
    'entityType', 'StockTransfer',
    'entityId', v_transfer.id,
    'createdAt', v_now
  ));

  RETURN jsonb_build_object(
    'stockTransfer', jsonb_build_object(
      'id', v_transfer.id,
      'transferNo', v_transfer.transfer_no,
      'fromShopId', v_transfer.from_shop_id,
      'toShopId', v_transfer.to_shop_id,
      'status', v_transfer.status,
      'notes', v_transfer.notes,
      'createdBy', v_transfer.created_by,
      'createdAt', v_transfer.created_at,
      'approvedBy', v_transfer.approved_by,
      'approvedAt', v_transfer.approved_at,
      'completedAt', v_transfer.completed_at,
      'canceledBy', v_transfer.canceled_by,
      'canceledAt', v_transfer.canceled_at,
      'cancelReason', v_transfer.cancel_reason
    ),
    'stockTransferItems', v_items_out,
    'inventory', v_inv_out,
    'movements', v_moves_out,
    'auditLogs', v_audit_out
  );
END;
$$;


ALTER FUNCTION "public"."complete_stock_transfer"("p_transfer_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_app_user"("p_id" "text", "p_name" "text", "p_email" "text", "p_role" "text", "p_shop_id" "text", "p_auth_id" "uuid", "p_granted_permissions" "text"[] DEFAULT NULL::"text"[], "p_revoked_permissions" "text"[] DEFAULT NULL::"text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user     users;
  v_now      timestamptz := now();
  v_audit_id text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT app_has_perm('user:create') THEN
    RAISE EXCEPTION 'You are not permitted to create users';
  END IF;
  IF p_id IS NULL OR p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'User id and name are required';
  END IF;

  INSERT INTO users (
    id, name, email, role, shop_id, auth_id,
    granted_permissions, revoked_permissions, is_active, created_at
  )
  VALUES (
    p_id, p_name, p_email, p_role, p_shop_id, p_auth_id,
    p_granted_permissions, p_revoked_permissions, true, v_now
  );

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, p_shop_id, v_user.id, 'USER_CREATED',
    'User ' || p_name || ' (' || p_role || ') created', 'User', p_id, v_now);

  RETURN jsonb_build_object(
    'id', p_id, 'name', p_name, 'email', p_email, 'role', p_role, 'shopId', p_shop_id,
    'authId', p_auth_id, 'grantedPermissions', p_granted_permissions,
    'revokedPermissions', p_revoked_permissions, 'isActive', true, 'createdAt', v_now
  );
END;
$$;


ALTER FUNCTION "public"."create_app_user"("p_id" "text", "p_name" "text", "p_email" "text", "p_role" "text", "p_shop_id" "text", "p_auth_id" "uuid", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_product_image_upload_session"("p_shop_id" "text" DEFAULT NULL::"text", "p_product_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users;
  v_session_id text := 'pimg-' || replace(gen_random_uuid()::text, '-', '');
  v_token text := replace(gen_random_uuid()::text, '-', '')
                  || replace(gen_random_uuid()::text, '-', '')
                  || replace(gen_random_uuid()::text, '-', '')
                  || replace(gen_random_uuid()::text, '-', '');
  v_storage_path text := 'temp/' || v_session_id;
  v_product_id text;
  v_expires_at timestamptz := now() + interval '10 minutes';
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (app_has_perm('product:create') OR app_has_perm('product:update')) THEN
    RAISE EXCEPTION 'You are not permitted to upload product images';
  END IF;

  IF p_shop_id IS NOT NULL
     AND app_role() <> 'ADMIN'
     AND app_shop_id() IS DISTINCT FROM p_shop_id THEN
    RAISE EXCEPTION 'You are not permitted to create an upload session for this shop';
  END IF;

  IF p_product_id IS NOT NULL AND EXISTS (SELECT 1 FROM products WHERE id = p_product_id) THEN
    v_product_id := p_product_id;
  END IF;

  INSERT INTO product_image_upload_sessions (
    id, token_hash, created_by, shop_id, product_id, storage_path, expires_at
  )
  VALUES (
    v_session_id, product_image_upload_token_hash(v_token), v_user.id,
    p_shop_id, v_product_id, v_storage_path, v_expires_at
  );

  RETURN jsonb_build_object(
    'sessionId', v_session_id,
    'token', v_token,
    'storagePath', v_storage_path,
    'expiresAt', v_expires_at,
    'status', 'PENDING'
  );
END;
$$;


ALTER FUNCTION "public"."create_product_image_upload_session"("p_shop_id" "text", "p_product_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_purchase_order"("p_shop_id" "text", "p_supplier_id" "text", "p_notes" "text", "p_items" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user      users;
  v_po_id     text := 'po-' || replace(gen_random_uuid()::text, '-', '');
  v_now       timestamptz := now();
  v_order_no  text;
  v_seq       integer;
  v_item      jsonb;
  v_qty       integer;
  v_cost      integer;
  v_line      integer;
  v_subtotal  integer := 0;
  v_audit_id  text;
  v_items_out jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Guard added by 021. Reject blank shop_id before any permission /
  -- "Shop not found" check so the operator sees a precise message.
  IF p_shop_id IS NULL OR btrim(p_shop_id) = '' THEN
    RAISE EXCEPTION 'Shop is required';
  END IF;

  IF NOT app_can_for_shop('purchase:create', p_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to create purchase orders for this shop';
  END IF;
  PERFORM 1 FROM shops WHERE id = p_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shop not found'; END IF;
  PERFORM 1 FROM suppliers WHERE id = p_supplier_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A purchase order needs at least one item';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('po_seq:' || to_char(v_now, 'YYYYMMDD')));
  SELECT count(*) INTO v_seq FROM purchase_orders WHERE created_at::date = v_now::date;
  v_order_no := 'PO-' || to_char(v_now, 'YYYYMMDD') || '-' || lpad((v_seq + 1)::text, 4, '0');

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) AS t(value)
  LOOP
    PERFORM 1 FROM products WHERE id = (v_item->>'product_id');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found: %', (v_item->>'product_id');
    END IF;
    v_qty  := (v_item->>'ordered_qty')::integer;
    v_cost := (v_item->>'unit_cost_mmk')::integer;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid ordered quantity for %', (v_item->>'product_id');
    END IF;
    IF v_cost IS NULL OR v_cost < 0 THEN
      RAISE EXCEPTION 'Invalid unit cost for %', (v_item->>'product_id');
    END IF;
    v_line := v_qty * v_cost;
    v_subtotal := v_subtotal + v_line;
    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'id', 'poitem-' || replace(gen_random_uuid()::text, '-', ''),
      'purchaseOrderId', v_po_id, 'productId', v_item->>'product_id',
      'orderedQty', v_qty, 'unitCostMmk', v_cost, 'lineTotalMmk', v_line
    ));
  END LOOP;

  INSERT INTO purchase_orders (
    id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk,
    notes, created_by, created_at
  )
  VALUES (
    v_po_id, v_order_no, p_shop_id, p_supplier_id, 'DRAFT', v_subtotal, v_subtotal,
    p_notes, v_user.id, v_now
  );

  INSERT INTO purchase_order_items (
    id, purchase_order_id, product_id, ordered_qty, unit_cost_mmk, line_total_mmk
  )
  SELECT i->>'id', v_po_id, i->>'productId',
         (i->>'orderedQty')::integer, (i->>'unitCostMmk')::integer, (i->>'lineTotalMmk')::integer
    FROM jsonb_array_elements(v_items_out) AS t(i);

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, p_shop_id, v_user.id, 'PO_CREATED',
    'Purchase order ' || v_order_no || ' created with ' || jsonb_array_length(v_items_out) || ' item(s)',
    'PurchaseOrder', v_po_id, v_now);

  RETURN jsonb_build_object(
    'purchaseOrder', jsonb_build_object(
      'id', v_po_id, 'orderNo', v_order_no, 'shopId', p_shop_id, 'supplierId', p_supplier_id,
      'status', 'DRAFT', 'subtotalMmk', v_subtotal, 'totalMmk', v_subtotal,
      'notes', p_notes, 'createdBy', v_user.id, 'createdAt', v_now),
    'purchaseOrderItems', v_items_out,
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', p_shop_id, 'actorId', v_user.id, 'actionType', 'PO_CREATED',
      'message', 'Purchase order ' || v_order_no || ' created with ' || jsonb_array_length(v_items_out) || ' item(s)',
      'entityType', 'PurchaseOrder', 'entityId', v_po_id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."create_purchase_order"("p_shop_id" "text", "p_supplier_id" "text", "p_notes" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_refund_void_request"("p_sale_id" "text", "p_type" "text", "p_reason" "text", "p_items" "jsonb" DEFAULT NULL::"jsonb", "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_actor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_sale sales; v_now timestamptz := resolve_event_time(p_created_at);
  v_req_id text := 'refund-' || replace(gen_random_uuid()::text, '-', '');
  v_audit_id text;
  v_perm text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This offline action was queued by a different user — reconnect as them to sync it, or dismiss it from Sync Conflicts.';
  END IF;

  IF p_type NOT IN ('VOID', 'PARTIAL') THEN
    RAISE EXCEPTION 'Unsupported request type: %', p_type;
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT * INTO v_sale FROM sales WHERE id = p_sale_id;
  IF v_sale.id IS NULL THEN RAISE EXCEPTION 'Sale not found'; END IF;

  v_perm := CASE WHEN p_type = 'VOID' THEN 'pos:request_void' ELSE 'pos:request_refund' END;
  IF NOT app_can_for_shop(v_perm, v_sale.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to request a % for sales in this shop', p_type;
  END IF;

  IF p_type = 'VOID' AND v_sale.status <> 'NORMAL' THEN
    RAISE EXCEPTION 'Only a normal sale can be voided';
  END IF;
  IF p_type = 'PARTIAL' AND v_sale.status = 'VOID' THEN
    RAISE EXCEPTION 'A voided sale cannot be refunded';
  END IF;

  IF EXISTS (
    SELECT 1 FROM refund_void_requests
     WHERE sale_id = p_sale_id AND type = p_type AND status = 'REQUESTED'
  ) THEN
    RAISE EXCEPTION 'A pending % request already exists for this sale', p_type;
  END IF;

  INSERT INTO refund_void_requests (
    id, sale_id, shop_id, type, reason, created_by, created_at, items, status
  )
  VALUES (
    v_req_id, p_sale_id, v_sale.shop_id, p_type, p_reason, v_user.id, v_now,
    CASE WHEN p_type = 'PARTIAL' THEN p_items ELSE NULL END, 'REQUESTED'
  );

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_sale.shop_id, v_user.id,
    CASE WHEN p_type = 'VOID' THEN 'VOID_REQUESTED' ELSE 'REFUND_REQUESTED' END,
    p_type || ' requested for sale ' || v_sale.receipt_no || '. Reason: ' || p_reason,
    'Refund', v_req_id, v_now);

  RETURN jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_req_id, 'saleId', p_sale_id, 'shopId', v_sale.shop_id, 'type', p_type,
      'reason', p_reason, 'createdBy', v_user.id, 'createdAt', v_now,
      'items', CASE WHEN p_type = 'PARTIAL' THEN p_items ELSE NULL END, 'status', 'REQUESTED'),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_sale.shop_id, 'actorId', v_user.id,
      'actionType', CASE WHEN p_type = 'VOID' THEN 'VOID_REQUESTED' ELSE 'REFUND_REQUESTED' END,
      'message', p_type || ' requested for sale ' || v_sale.receipt_no || '. Reason: ' || p_reason,
      'entityType', 'Refund', 'entityId', v_req_id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."create_refund_void_request"("p_sale_id" "text", "p_type" "text", "p_reason" "text", "p_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_stock_transfer"("p_from_shop_id" "text", "p_to_shop_id" "text", "p_notes" "text", "p_items" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user       users;
  v_tr_id      text := 'transfer-' || replace(gen_random_uuid()::text, '-', '');
  v_now        timestamptz := now();
  v_transfer_no text;
  v_seq        integer;
  v_item       jsonb;
  v_product_id text;
  v_unit_id    text;
  v_unit       product_units%ROWTYPE;
  v_selected_qty integer;
  v_base_qty   integer;
  v_avail      integer;
  v_audit_id   text;
  v_item_id    text;
  v_items_out  jsonb := '[]'::jsonb;
  v_stock      record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_from_shop_id IS NULL OR btrim(p_from_shop_id) = '' THEN
    RAISE EXCEPTION 'Source shop is required';
  END IF;
  IF p_to_shop_id IS NULL OR btrim(p_to_shop_id) = '' THEN
    RAISE EXCEPTION 'Destination shop is required';
  END IF;

  IF NOT app_can_for_shop('transfer:create', p_from_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to create transfers from this shop';
  END IF;
  IF p_from_shop_id = p_to_shop_id THEN
    RAISE EXCEPTION 'Source and destination shop must differ';
  END IF;
  PERFORM 1 FROM shops WHERE id = p_from_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source shop not found'; END IF;
  PERFORM 1 FROM shops WHERE id = p_to_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Destination shop not found'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A transfer needs at least one item';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('trf_seq:' || to_char(v_now, 'YYYYMMDD')));
  SELECT count(*) INTO v_seq FROM stock_transfers WHERE created_at::date = v_now::date;
  v_transfer_no := 'TRF-' || to_char(v_now, 'YYYYMMDD') || '-' || lpad((v_seq + 1)::text, 4, '0');

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) AS t(value)
  LOOP
    v_product_id := NULLIF(v_item->>'product_id', '');
    v_unit_id := NULLIF(v_item->>'product_unit_id', '');
    v_selected_qty := NULL;
    v_base_qty := NULL;
    v_unit := NULL;

    PERFORM 1 FROM products WHERE id = v_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found: %', COALESCE(v_product_id, '');
    END IF;

    IF v_unit_id IS NOT NULL THEN
      v_selected_qty := COALESCE(
        NULLIF(v_item->>'selected_unit_quantity', '')::integer,
        NULLIF(v_item->>'unit_qty', '')::integer
      );
      IF v_selected_qty IS NULL OR v_selected_qty <= 0 THEN
        RAISE EXCEPTION 'Invalid selected unit quantity for %', v_product_id;
      END IF;

      SELECT * INTO v_unit
        FROM product_units
       WHERE id = v_unit_id
         AND product_id = v_product_id
         AND is_active = true;
      IF v_unit.id IS NULL THEN
        RAISE EXCEPTION 'Sellable unit % is not active for product %', v_unit_id, v_product_id;
      END IF;

      v_base_qty := v_selected_qty * v_unit.base_quantity;
    ELSE
      -- Legacy base-unit path. requested_qty is already base units.
      v_base_qty := NULLIF(v_item->>'requested_qty', '')::integer;
      IF v_base_qty IS NULL OR v_base_qty <= 0 THEN
        RAISE EXCEPTION 'Invalid requested quantity for %', v_product_id;
      END IF;
    END IF;

    v_item_id := 'titem-' || replace(gen_random_uuid()::text, '-', '');
    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'id', v_item_id,
      'transferId', v_tr_id,
      'productId', v_product_id,
      'requestedQty', v_base_qty,
      'productUnitId', v_unit_id,
      'unitNameSnapshot', CASE WHEN v_unit_id IS NULL THEN NULL ELSE v_unit.name END,
      'unitBaseQuantitySnapshot', CASE WHEN v_unit_id IS NULL THEN NULL ELSE v_unit.base_quantity END,
      'selectedUnitQuantity', v_selected_qty
    ));
  END LOOP;

  -- Validate combined stock by product, not line-by-line. This blocks
  -- mixed-unit over-requests such as 1 Case + 2 Can when only 25 cans exist.
  FOR v_stock IN
    SELECT i->>'productId' AS product_id,
           sum((i->>'requestedQty')::integer) AS requested_base_qty
      FROM jsonb_array_elements(v_items_out) AS t(i)
     GROUP BY i->>'productId'
  LOOP
    SELECT qty_base_units INTO v_avail
      FROM inventory
     WHERE shop_id = p_from_shop_id AND product_id = v_stock.product_id;

    IF COALESCE(v_avail, 0) < v_stock.requested_base_qty THEN
      RAISE EXCEPTION 'Insufficient stock for % at the source shop (have %, requested %)',
        v_stock.product_id, COALESCE(v_avail, 0), v_stock.requested_base_qty;
    END IF;
  END LOOP;

  INSERT INTO stock_transfers (
    id, transfer_no, from_shop_id, to_shop_id, status, notes, created_by, created_at
  )
  VALUES (v_tr_id, v_transfer_no, p_from_shop_id, p_to_shop_id, 'PENDING', p_notes, v_user.id, v_now);

  INSERT INTO stock_transfer_items (
    id, transfer_id, product_id, requested_qty,
    product_unit_id, unit_name_snapshot, unit_base_quantity_snapshot,
    selected_unit_quantity
  )
  SELECT
    i->>'id',
    v_tr_id,
    i->>'productId',
    (i->>'requestedQty')::integer,
    NULLIF(i->>'productUnitId', ''),
    NULLIF(i->>'unitNameSnapshot', ''),
    NULLIF(i->>'unitBaseQuantitySnapshot', '')::integer,
    NULLIF(i->>'selectedUnitQuantity', '')::integer
  FROM jsonb_array_elements(v_items_out) AS t(i);

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, p_from_shop_id, v_user.id, 'TRANSFER_CREATED',
    'Transfer ' || v_transfer_no || ' created with ' || jsonb_array_length(v_items_out) || ' item(s)',
    'StockTransfer', v_tr_id, v_now);

  RETURN jsonb_build_object(
    'stockTransfer', jsonb_build_object(
      'id', v_tr_id, 'transferNo', v_transfer_no, 'fromShopId', p_from_shop_id,
      'toShopId', p_to_shop_id, 'status', 'PENDING', 'notes', p_notes,
      'createdBy', v_user.id, 'createdAt', v_now),
    'stockTransferItems', v_items_out,
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', p_from_shop_id, 'actorId', v_user.id, 'actionType', 'TRANSFER_CREATED',
      'message', 'Transfer ' || v_transfer_no || ' created with ' || jsonb_array_length(v_items_out) || ' item(s)',
      'entityType', 'StockTransfer', 'entityId', v_tr_id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."create_stock_transfer"("p_from_shop_id" "text", "p_to_shop_id" "text", "p_notes" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_supplier"("p_code" "text", "p_name" "text", "p_contact_person" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_email" "text" DEFAULT NULL::"text", "p_address" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user        users;
  v_supplier_id text := 'supplier-' || replace(gen_random_uuid()::text, '-', '');
  v_now         timestamptz := now();
  v_audit_id    text;
  v_msg         text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT app_has_perm('supplier:create') THEN
    RAISE EXCEPTION 'You are not permitted to create suppliers';
  END IF;

  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RAISE EXCEPTION 'Supplier code is required';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Supplier name is required';
  END IF;

  INSERT INTO suppliers (
    id, code, name, contact_person, phone, email, address, notes, is_active, created_at
  )
  VALUES (
    v_supplier_id, p_code, p_name, p_contact_person, p_phone, p_email, p_address, p_notes,
    true, v_now
  );

  v_msg := 'Supplier ' || p_code || ' (' || p_name || ') created';
  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, NULL, v_user.id, 'SUPPLIER_CREATED', v_msg, 'Supplier', v_supplier_id, v_now);

  RETURN jsonb_build_object(
    'supplier', jsonb_build_object(
      'id', v_supplier_id, 'code', p_code, 'name', p_name, 'contactPerson', p_contact_person,
      'phone', p_phone, 'email', p_email, 'address', p_address, 'notes', p_notes,
      'isActive', true, 'createdAt', v_now, 'updatedAt', v_now),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', NULL, 'actorId', v_user.id, 'actionType', 'SUPPLIER_CREATED',
      'message', v_msg, 'entityType', 'Supplier', 'entityId', v_supplier_id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."create_supplier"("p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "role" "text" NOT NULL,
    "shop_id" "text",
    "permissions" "text"[],
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "auth_id" "uuid",
    "granted_permissions" "text"[],
    "revoked_permissions" "text"[],
    "org_id" "text" NOT NULL
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_app_user"() RETURNS "public"."users"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT * FROM users
  WHERE auth_id = auth.uid() AND is_active = true
  LIMIT 1;
$$;


ALTER FUNCTION "public"."current_app_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deactivate_app_user"("p_id" "text", "p_is_active" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user     users;
  v_target   users;
  v_now      timestamptz := now();
  v_audit_id text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT app_has_perm('user:update') THEN
    RAISE EXCEPTION 'You are not permitted to change user status';
  END IF;

  SELECT * INTO v_target FROM users WHERE id = p_id FOR UPDATE;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;

  UPDATE users SET is_active = p_is_active WHERE id = p_id
    RETURNING * INTO v_target;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_target.shop_id, v_user.id,
    CASE WHEN p_is_active THEN 'USER_ACTIVATED' ELSE 'USER_DEACTIVATED' END,
    'User ' || v_target.name || CASE WHEN p_is_active THEN ' activated' ELSE ' deactivated' END,
    'User', v_target.id, v_now);

  RETURN jsonb_build_object('id', v_target.id, 'isActive', v_target.is_active);
END;
$$;


ALTER FUNCTION "public"."deactivate_app_user"("p_id" "text", "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_product"("p_product_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid uuid := auth.uid();
  v_user     users;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'No app user found for this auth identity';
  END IF;

  IF NOT app_has_perm('product:delete') THEN
    RAISE EXCEPTION 'You are not permitted to delete products';
  END IF;

  -- Product must still exist; surface a clear error otherwise so
  -- the UI doesn't show a generic RLS denial.
  PERFORM 1 FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found: %', p_product_id;
  END IF;

  -- Inventory rows must go first — the FK has no CASCADE.
  -- `inventory_movements` and `sale_items` reference product_id by
  -- value (no FK) and are left in place as historical ledger data.
  DELETE FROM inventory WHERE product_id = p_product_id;

  -- Now the product itself. product_barcodes and price_tiers
  -- cascade-delete via their own FKs.
  DELETE FROM products WHERE id = p_product_id;

  RETURN jsonb_build_object('productId', p_product_id);
END;
$$;


ALTER FUNCTION "public"."delete_product"("p_product_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dispatch_stock_transfer"("p_transfer_id" "text", "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_actor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_t stock_transfers; v_now timestamptz := resolve_event_time(p_created_at);
  v_audit_id text; v_items jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This offline action was queued by a different user — reconnect as them to sync it, or dismiss it from Sync Conflicts.';
  END IF;
  IF p_transfer_id IS NULL OR btrim(p_transfer_id) = '' THEN
    RAISE EXCEPTION 'Stock transfer is required';
  END IF;

  SELECT * INTO v_t FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_t.id IS NULL THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
  IF v_t.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Transfer cannot be dispatched from status %', v_t.status;
  END IF;
  IF NOT app_can_for_shop('transfer:approve', v_t.from_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to dispatch transfers from this shop';
  END IF;

  UPDATE stock_transfers
     SET status = 'IN_TRANSIT', dispatched_by = v_user.id, dispatched_at = v_now
   WHERE id = v_t.id RETURNING * INTO v_t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id, 'transferId', i.transfer_id, 'productId', i.product_id,
    'requestedQty', i.requested_qty, 'approvedQty', i.approved_qty,
    'transferredQty', i.transferred_qty,
    'productUnitId', i.product_unit_id, 'unitNameSnapshot', i.unit_name_snapshot,
    'unitBaseQuantitySnapshot', i.unit_base_quantity_snapshot,
    'selectedUnitQuantity', i.selected_unit_quantity)), '[]'::jsonb)
    INTO v_items FROM stock_transfer_items i WHERE i.transfer_id = v_t.id;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_t.from_shop_id, v_user.id, 'TRANSFER_DISPATCHED',
    'Transfer ' || v_t.transfer_no || ' dispatched', 'StockTransfer', v_t.id, v_now);

  RETURN jsonb_build_object(
    'stockTransfer', transfer_json(v_t),
    'stockTransferItems', v_items,
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_t.from_shop_id, 'actorId', v_user.id,
      'actionType', 'TRANSFER_DISPATCHED',
      'message', 'Transfer ' || v_t.transfer_no || ' dispatched',
      'entityType', 'StockTransfer', 'entityId', v_t.id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."dispatch_stock_transfer"("p_transfer_id" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_user_assignment_rules"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_active_manager_exists  boolean;
  v_active_cashier_count   int;
  v_replacement_manager    boolean;
BEGIN
  ----------------------------------------------------------------
  -- ADMIN: shop_id is meaningless globally. Normalise to NULL so
  -- callers don't have to remember to clear it on role flips.
  ----------------------------------------------------------------
  IF NEW.role = 'ADMIN' THEN
    NEW.shop_id := NULL;
  END IF;

  ----------------------------------------------------------------
  -- Role/shop binding requirements.
  ----------------------------------------------------------------
  IF NEW.role = 'MANAGER' AND NEW.shop_id IS NULL THEN
    RAISE EXCEPTION 'Manager must be assigned to a shop.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.role = 'CASHIER' AND NEW.shop_id IS NULL THEN
    RAISE EXCEPTION 'Cashier must be assigned to a shop.'
      USING ERRCODE = 'P0001';
  END IF;

  -- BUYER is a per-shop purchasing role (purchase:create / purchase:view
  -- are shop-scoped by RLS) so a shopless BUYER cannot do anything.
  IF NEW.role = 'BUYER' AND NEW.shop_id IS NULL THEN
    RAISE EXCEPTION 'Buyer must be assigned to a shop.'
      USING ERRCODE = 'P0001';
  END IF;

  ----------------------------------------------------------------
  -- An ACTIVE cashier must sit under an active manager of the same
  -- shop. (Inactive cashiers are exempt so historical rows survive.)
  ----------------------------------------------------------------
  IF NEW.role = 'CASHIER' AND NEW.is_active = true THEN
    SELECT EXISTS (
      SELECT 1
        FROM users m
       WHERE m.role = 'MANAGER'
         AND m.is_active = true
         AND m.shop_id = NEW.shop_id
         AND m.id <> NEW.id
    ) INTO v_active_manager_exists;

    IF NOT v_active_manager_exists THEN
      RAISE EXCEPTION 'Cannot create cashier for a shop without an active manager.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  ----------------------------------------------------------------
  -- Manager deactivation / demotion / reassignment safety.
  -- Block the change if it would strip a shop of its only active
  -- manager while active cashiers are still attached to that shop.
  -- A replacement manager already in place lifts the block.
  ----------------------------------------------------------------
  IF TG_OP = 'UPDATE'
     AND OLD.role = 'MANAGER'
     AND OLD.is_active = true
     AND OLD.shop_id IS NOT NULL
     AND (
       NEW.role <> 'MANAGER'
       OR NEW.is_active = false
       OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
     )
  THEN
    SELECT count(*) INTO v_active_cashier_count
      FROM users c
     WHERE c.role = 'CASHIER'
       AND c.is_active = true
       AND c.shop_id = OLD.shop_id
       AND c.id <> NEW.id;

    IF v_active_cashier_count > 0 THEN
      SELECT EXISTS (
        SELECT 1
          FROM users m
         WHERE m.role = 'MANAGER'
           AND m.is_active = true
           AND m.shop_id = OLD.shop_id
           AND m.id <> NEW.id
      ) INTO v_replacement_manager;

      IF NOT v_replacement_manager THEN
        RAISE EXCEPTION
          'Cannot remove the only manager of this shop while % active cashier(s) remain. '
          'Reassign or deactivate the cashiers first, or assign another manager.',
          v_active_cashier_count
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_user_assignment_rules"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_inventory_rows_for_product"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    SELECT s.id, NEW.id, 0
    FROM shops s
    WHERE s.is_active = true
    ON CONFLICT (shop_id, product_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."ensure_inventory_rows_for_product"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_inventory_rows_for_shop"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    SELECT NEW.id, p.id, 0
    FROM products p
    WHERE p.is_active = true
    ON CONFLICT (shop_id, product_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."ensure_inventory_rows_for_shop"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_product_image_upload_session_by_token"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_session product_image_upload_sessions;
BEGIN
  IF COALESCE(length(p_token), 0) < 32 THEN
    RAISE EXCEPTION 'Invalid upload link';
  END IF;

  SELECT * INTO v_session
    FROM product_image_upload_sessions
   WHERE token_hash = product_image_upload_token_hash(p_token)
   FOR UPDATE;

  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'Invalid upload link';
  END IF;

  IF v_session.status = 'PENDING' AND v_session.expires_at <= now() THEN
    UPDATE product_image_upload_sessions
       SET status = 'EXPIRED',
           signed_upload_token = NULL
     WHERE id = v_session.id
     RETURNING * INTO v_session;
  END IF;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'storagePath', v_session.storage_path,
    'publicUrl', v_session.public_url,
    'bytes', v_session.bytes,
    'mimeType', v_session.mime_type,
    'uploadToken', CASE WHEN v_session.status = 'PENDING' THEN v_session.signed_upload_token ELSE NULL END,
    'expiresAt', v_session.expires_at,
    'status', v_session.status
  );
END;
$$;


ALTER FUNCTION "public"."get_product_image_upload_session_by_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_product_image_upload_session_status"("p_session_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users;
  v_session product_image_upload_sessions;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_session
    FROM product_image_upload_sessions
   WHERE id = p_session_id
   FOR UPDATE;

  IF v_session.id IS NULL OR v_session.created_by <> v_user.id THEN
    RAISE EXCEPTION 'Upload session not found';
  END IF;

  IF v_session.status = 'PENDING' AND v_session.expires_at <= now() THEN
    UPDATE product_image_upload_sessions
       SET status = 'EXPIRED',
           signed_upload_token = NULL
     WHERE id = v_session.id
     RETURNING * INTO v_session;
  END IF;

  RETURN jsonb_build_object(
    'sessionId', v_session.id,
    'storagePath', v_session.storage_path,
    'publicUrl', v_session.public_url,
    'bytes', v_session.bytes,
    'mimeType', v_session.mime_type,
    'expiresAt', v_session.expires_at,
    'status', v_session.status
  );
END;
$$;


ALTER FUNCTION "public"."get_product_image_upload_session_status"("p_session_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_user_privilege_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_role text := app_role();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users) THEN
      RETURN NEW; -- first-ever user: legitimate self-bootstrap as ADMIN.
    END IF;
    IF v_caller_role IS DISTINCT FROM 'ADMIN' THEN
      IF NEW.role = 'ADMIN'
         OR NEW.granted_permissions IS NOT NULL
         OR NEW.revoked_permissions IS NOT NULL
         OR NEW.permissions IS NOT NULL
      THEN
        RAISE EXCEPTION 'Only an ADMIN can create a user with an elevated role or custom permission overrides.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF (NEW.role IS DISTINCT FROM OLD.role
      OR NEW.granted_permissions IS DISTINCT FROM OLD.granted_permissions
      OR NEW.revoked_permissions IS DISTINCT FROM OLD.revoked_permissions
      OR NEW.permissions IS DISTINCT FROM OLD.permissions)
     AND v_caller_role IS DISTINCT FROM 'ADMIN'
  THEN
    RAISE EXCEPTION 'Only an ADMIN can change role or permission overrides.';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."guard_user_privilege_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_audit_event"("p_action_type" "text", "p_message" "text", "p_entity_type" "text", "p_entity_id" "text", "p_shop_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_now timestamptz := now();
  v_audit_id text := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  v_required_perm text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Allow-list of legitimate action types, mapped to the same permission
  -- that already gates the UI action producing them (see
  -- src/lib/permissions.ts: adminProductCreate/Edit/adminUnitTypes).
  v_required_perm := CASE p_action_type
    WHEN 'PRODUCT_CREATE'   THEN 'product:create'
    WHEN 'PRODUCT_IMPORT'   THEN 'product:create'
    WHEN 'PRODUCT_EDIT'     THEN 'product:update'
    WHEN 'PRODUCT_DELETE'   THEN 'product:delete'
    WHEN 'CATEGORY_CREATE'  THEN 'product:create'
    WHEN 'CATEGORY_EDIT'    THEN 'product:update'
    WHEN 'CATEGORY_DELETE'  THEN 'product:delete'
    ELSE NULL
  END;

  IF v_required_perm IS NULL THEN
    RAISE EXCEPTION 'Unsupported audit action type: %', p_action_type;
  END IF;

  IF NOT app_has_perm(v_required_perm) THEN
    RAISE EXCEPTION 'You are not permitted to record this audit event';
  END IF;

  -- Every allow-listed action type above is a global catalog entity (no
  -- shop scope) — never trust a caller-supplied shop_id, always record NULL.
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, NULL, v_user.id, p_action_type, p_message, p_entity_type, p_entity_id, v_now);

  RETURN jsonb_build_object('auditLog', jsonb_build_object(
    'id', v_audit_id, 'shopId', NULL, 'actorId', v_user.id, 'actionType', p_action_type,
    'message', p_message, 'entityType', p_entity_type, 'entityId', p_entity_id, 'createdAt', v_now));
END;
$$;


ALTER FUNCTION "public"."log_audit_event"("p_action_type" "text", "p_message" "text", "p_entity_type" "text", "p_entity_id" "text", "p_shop_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_receipt_reprint"("p_sale_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_sale sales; v_now timestamptz := now();
  v_reprint_id text := 'reprint-' || replace(gen_random_uuid()::text, '-', '');
  v_audit_id text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_sale FROM sales WHERE id = p_sale_id;
  IF v_sale.id IS NULL THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT app_can_for_shop('receipt:reprint', v_sale.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to reprint receipts for this shop';
  END IF;

  INSERT INTO reprint_logs (id, sale_id, printed_by, printed_at)
  VALUES (v_reprint_id, p_sale_id, v_user.id, v_now);

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_sale.shop_id, v_user.id, 'REPRINT_RECEIPT',
    'Reprinted receipt ' || v_sale.receipt_no, 'Sale', p_sale_id, v_now);

  RETURN jsonb_build_object(
    'reprintLog', jsonb_build_object(
      'id', v_reprint_id, 'saleId', p_sale_id, 'printedBy', v_user.id, 'printedAt', v_now),
    'auditLog', jsonb_build_object(
      'id', v_audit_id, 'shopId', v_sale.shop_id, 'actorId', v_user.id, 'actionType', 'REPRINT_RECEIPT',
      'message', 'Reprinted receipt ' || v_sale.receipt_no,
      'entityType', 'Sale', 'entityId', p_sale_id, 'createdAt', v_now)
  );
END;
$$;


ALTER FUNCTION "public"."log_receipt_reprint"("p_sale_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_shift"("p_shop_id" "text", "p_opening_cash_mmk" integer, "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_actor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid   uuid := auth.uid();
  v_user       users;
  v_shop       shops;
  v_shift      shifts;
  v_shift_id   text := 'shift-' || replace(gen_random_uuid()::text, '-', '');
  v_now        timestamptz := resolve_event_time(p_created_at);
  v_audit_id   text;
  v_audit_logs jsonb := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This offline action was queued by a different user — reconnect as them to sync it, or dismiss it from Sync Conflicts.';
  END IF;

  IF p_shop_id IS NULL OR btrim(p_shop_id) = '' THEN
    RAISE EXCEPTION 'Shop is required';
  END IF;

  IF p_opening_cash_mmk IS NULL OR p_opening_cash_mmk < 0 THEN
    RAISE EXCEPTION 'Opening cash must be zero or greater';
  END IF;

  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id AND is_active = true;
  IF v_shop.id IS NULL THEN
    RAISE EXCEPTION 'Shop not found or inactive';
  END IF;

  IF NOT (
    app_can_for_shop('shift:manage_own', p_shop_id)
    OR app_can_for_shop('shift:manage_all', p_shop_id)
  ) THEN
    RAISE EXCEPTION 'You are not permitted to open shifts in this shop';
  END IF;

  -- Serialize open attempts for this cashier so the global-open-shift rule is
  -- reliable even across different shops.
  PERFORM pg_advisory_xact_lock(hashtext('open_shift:' || v_user.id));

  IF EXISTS (
    SELECT 1
      FROM shifts
     WHERE cashier_id = v_user.id AND ended_at IS NULL
     FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'This cashier already has an open shift';
  END IF;

  INSERT INTO shifts (
    id, shop_id, cashier_id, started_at, opening_cash_mmk
  )
  VALUES (
    v_shift_id, p_shop_id, v_user.id, v_now, p_opening_cash_mmk
  )
  RETURNING * INTO v_shift;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, p_shop_id, v_user.id, 'SHIFT_OPENED',
    'Opened shift with opening cash ' || p_opening_cash_mmk || ' MMK',
    'Shift', v_shift.id, v_now
  );

  v_audit_logs := v_audit_logs || jsonb_build_array(jsonb_build_object(
    'id', v_audit_id,
    'shopId', p_shop_id,
    'actorId', v_user.id,
    'actionType', 'SHIFT_OPENED',
    'message', 'Opened shift with opening cash ' || p_opening_cash_mmk || ' MMK',
    'entityType', 'Shift',
    'entityId', v_shift.id,
    'createdAt', v_now
  ));

  RETURN jsonb_build_object(
    'shift', jsonb_build_object(
      'id', v_shift.id,
      'shopId', v_shift.shop_id,
      'cashierId', v_shift.cashier_id,
      'startedAt', v_shift.started_at,
      'endedAt', v_shift.ended_at,
      'openingCashMmk', v_shift.opening_cash_mmk,
      'closingCashMmk', v_shift.closing_cash_mmk,
      'expectedCashMmk', v_shift.expected_cash_mmk,
      'varianceMmk', v_shift.variance_mmk,
      'varianceReason', v_shift.variance_reason
    ),
    'auditLogs', v_audit_logs
  );
END;
$$;


ALTER FUNCTION "public"."open_shift"("p_shop_id" "text", "p_opening_cash_mmk" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pay_supplier_lump_sum"("p_supplier_id" "text", "p_shop_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user        users;
  v_now         timestamptz := now();
  v_method      text := upper(COALESCE(NULLIF(btrim(p_payment_method), ''), ''));
  v_remaining   integer;
  v_outstanding integer;
  v_po          purchase_orders;
  v_bal         integer;
  v_apply       integer;
  v_new_paid    integer;
  v_new_status  text;
  v_pay_id      text;
  v_audit_id    text;
  v_pays_out    jsonb := '[]'::jsonb;
  v_pos_out     jsonb := '[]'::jsonb;
  v_audits_out  jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_supplier_id IS NULL OR btrim(p_supplier_id) = '' THEN RAISE EXCEPTION 'Supplier is required'; END IF;
  IF p_shop_id IS NULL OR btrim(p_shop_id) = '' THEN RAISE EXCEPTION 'Shop is required'; END IF;
  IF p_amount_mmk IS NULL OR p_amount_mmk <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF v_method NOT IN ('CASH', 'BANK', 'MOBILE', 'OTHER') THEN
    RAISE EXCEPTION 'Unsupported supplier payment method: %', p_payment_method;
  END IF;
  IF NOT app_can_for_shop('supplier:payment_create', p_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to record supplier payments for this shop';
  END IF;

  -- Total outstanding for this supplier in this shop (received, unpaid balance).
  SELECT COALESCE(sum(total_mmk - COALESCE(paid_mmk, 0)), 0)
    INTO v_outstanding
    FROM purchase_orders
   WHERE supplier_id = p_supplier_id AND shop_id = p_shop_id
     AND status = 'RECEIVED' AND total_mmk - COALESCE(paid_mmk, 0) > 0;

  IF v_outstanding <= 0 THEN
    RAISE EXCEPTION 'This supplier has no outstanding balance in this shop';
  END IF;
  IF p_amount_mmk > v_outstanding THEN
    RAISE EXCEPTION 'Payment amount exceeds total outstanding balance';
  END IF;

  v_remaining := p_amount_mmk;

  FOR v_po IN
    SELECT * FROM purchase_orders
     WHERE supplier_id = p_supplier_id AND shop_id = p_shop_id
       AND status = 'RECEIVED' AND total_mmk - COALESCE(paid_mmk, 0) > 0
     ORDER BY created_at ASC, id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_bal := v_po.total_mmk - COALESCE(v_po.paid_mmk, 0);
    v_apply := LEAST(v_remaining, v_bal);
    IF v_apply <= 0 THEN CONTINUE; END IF;

    v_pay_id := 'suppay-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO supplier_payments (
      id, supplier_id, purchase_order_id, shop_id, amount_mmk,
      payment_method, reference_no, notes, paid_at, created_by, created_at
    )
    VALUES (
      v_pay_id, v_po.supplier_id, v_po.id, v_po.shop_id, v_apply,
      v_method, NULLIF(btrim(p_reference_no), ''), NULLIF(btrim(p_notes), ''),
      v_now, v_user.id, v_now
    );

    v_new_paid := COALESCE(v_po.paid_mmk, 0) + v_apply;
    v_new_status := CASE
      WHEN v_new_paid >= v_po.total_mmk THEN 'PAID'
      WHEN v_new_paid > 0 THEN 'PARTIAL'
      ELSE 'UNPAID'
    END;
    UPDATE purchase_orders
       SET paid_mmk = v_new_paid, payment_status = v_new_status
     WHERE id = v_po.id
     RETURNING * INTO v_po;

    v_remaining := v_remaining - v_apply;

    v_pays_out := v_pays_out || jsonb_build_array(jsonb_build_object(
      'id', v_pay_id, 'supplierId', v_po.supplier_id, 'purchaseOrderId', v_po.id,
      'shopId', v_po.shop_id, 'amountMmk', v_apply, 'paymentMethod', v_method,
      'referenceNo', NULLIF(btrim(p_reference_no), ''), 'notes', NULLIF(btrim(p_notes), ''),
      'paidAt', v_now, 'createdBy', v_user.id, 'createdAt', v_now,
      'voidedAt', NULL, 'voidedBy', NULL, 'voidReason', NULL
    ));
    v_pos_out := v_pos_out || jsonb_build_array(jsonb_build_object(
      'id', v_po.id, 'orderNo', v_po.order_no, 'shopId', v_po.shop_id, 'supplierId', v_po.supplier_id,
      'status', v_po.status, 'subtotalMmk', v_po.subtotal_mmk, 'taxMmk', v_po.tax_mmk,
      'totalMmk', v_po.total_mmk, 'paidMmk', v_po.paid_mmk, 'paymentStatus', v_po.payment_status,
      'supplierInvoiceNo', v_po.supplier_invoice_no, 'deliveryNoteNo', v_po.delivery_note_no,
      'notes', v_po.notes, 'createdBy', v_po.created_by, 'createdAt', v_po.created_at,
      'approvedBy', v_po.approved_by, 'approvedAt', v_po.approved_at,
      'receivedBy', v_po.received_by, 'receivedAt', v_po.received_at
    ));

    v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
    VALUES (v_audit_id, v_po.shop_id, v_user.id, 'SUPPLIER_PAYMENT_RECORDED',
      'Supplier payment (lump-sum) for ' || v_po.order_no || ': MMK ' || v_apply,
      'SupplierPayment', v_pay_id, v_now);
    v_audits_out := v_audits_out || jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_po.shop_id, 'actorId', v_user.id,
      'actionType', 'SUPPLIER_PAYMENT_RECORDED',
      'message', 'Supplier payment (lump-sum) for ' || v_po.order_no || ': MMK ' || v_apply,
      'entityType', 'SupplierPayment', 'entityId', v_pay_id, 'createdAt', v_now));
  END LOOP;

  RETURN jsonb_build_object(
    'supplierPayments', v_pays_out,
    'purchaseOrders', v_pos_out,
    'auditLogs', v_audits_out
  );
END;
$$;


ALTER FUNCTION "public"."pay_supplier_lump_sum"("p_supplier_id" "text", "p_shop_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."price_levels_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."price_levels_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."product_barcodes_validate_unit_product"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.product_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM product_units pu
     WHERE pu.id = NEW.product_unit_id
       AND pu.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'Barcode product_unit_id must belong to the same product_id';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."product_barcodes_validate_unit_product"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."product_image_upload_token_hash"("p_token" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT encode(sha256(convert_to(COALESCE(p_token, ''), 'UTF8')), 'hex');
$$;


ALTER FUNCTION "public"."product_image_upload_token_hash"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."product_unit_prices_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."product_unit_prices_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."product_units_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."product_units_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."receive_purchase_order"("p_purchase_order_id" "text", "p_received_items" "jsonb" DEFAULT NULL::"jsonb", "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_actor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid          uuid := auth.uid();
  v_user              users;
  v_po                purchase_orders;
  v_now               timestamptz := resolve_event_time(p_created_at);
  v_poitem            purchase_order_items;
  v_input             jsonb;
  v_received_base     integer;
  v_line_total        integer;
  v_unit              product_units;
  v_unit_id           text;
  v_unit_qty          integer;
  v_qty_before        integer;
  v_qty_after         integer;
  v_total_received    integer := 0;
  v_subtotal          integer := 0;
  v_move_id           text;
  v_audit_id          text;
  v_items_out         jsonb := '[]'::jsonb;
  v_inv_out           jsonb := '[]'::jsonb;
  v_moves_out         jsonb := '[]'::jsonb;
  v_audit_out         jsonb := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This offline action was queued by a different user — reconnect as them to sync it, or dismiss it from Sync Conflicts.';
  END IF;

  IF NOT app_has_perm('purchase:receive') THEN
    RAISE EXCEPTION 'You are not permitted to receive purchase orders';
  END IF;

  IF p_purchase_order_id IS NULL OR btrim(p_purchase_order_id) = '' THEN
    RAISE EXCEPTION 'Purchase order is required';
  END IF;

  IF p_received_items IS NOT NULL AND jsonb_typeof(p_received_items) <> 'array' THEN
    RAISE EXCEPTION 'Received items must be a JSON array';
  END IF;

  SELECT * INTO v_po
    FROM purchase_orders
   WHERE id = p_purchase_order_id
   FOR UPDATE;

  IF v_po.id IS NULL THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  IF v_po.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Purchase order is not in a receivable (APPROVED) status';
  END IF;

  IF NOT app_can_for_shop('purchase:receive', v_po.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to receive purchase orders in this shop';
  END IF;

  FOR v_poitem IN
    SELECT * FROM purchase_order_items
     WHERE purchase_order_id = v_po.id
     ORDER BY id
     FOR UPDATE
  LOOP
    -- Find this item's matching input row (by product_id).
    v_input := NULL;
    IF p_received_items IS NOT NULL THEN
      SELECT e
        INTO v_input
        FROM jsonb_array_elements(p_received_items) e
       WHERE e->>'product_id' = v_poitem.product_id
       LIMIT 1;
    END IF;

    v_unit_id  := NULLIF(v_input->>'product_unit_id', '');
    v_unit_qty := NULLIF(v_input->>'received_unit_qty', '')::integer;
    v_unit     := NULL;

    -- Unit-aware path. The server resolves the unit and computes base qty;
    -- the client number is only a hint.
    IF v_unit_id IS NOT NULL THEN
      SELECT * INTO v_unit
        FROM product_units
       WHERE id = v_unit_id
         AND product_id = v_poitem.product_id
         AND is_active = true;
      IF v_unit.id IS NULL THEN
        RAISE EXCEPTION 'Sellable unit % is not active for product %',
          v_unit_id, v_poitem.product_id;
      END IF;
      IF v_unit_qty IS NULL OR v_unit_qty < 0 THEN
        RAISE EXCEPTION 'Received unit qty must be zero or greater for product %', v_poitem.product_id;
      END IF;
      v_received_base := v_unit_qty * v_unit.base_quantity;
    ELSIF v_input IS NOT NULL THEN
      v_received_base := COALESCE(NULLIF(v_input->>'received_qty', '')::integer, v_poitem.ordered_qty);
    ELSE
      -- No input row for this PO item → default to ordered qty.
      v_received_base := v_poitem.ordered_qty;
    END IF;

    IF v_received_base < 0 THEN
      RAISE EXCEPTION 'Received quantity cannot be negative for product %', v_poitem.product_id;
    END IF;
    IF v_received_base > v_poitem.ordered_qty THEN
      RAISE EXCEPTION 'Received quantity exceeds ordered quantity for product %', v_poitem.product_id;
    END IF;

    PERFORM 1 FROM products WHERE id = v_poitem.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found: %', v_poitem.product_id;
    END IF;

    -- Bill at received value: each line total and the PO subtotal reflect what
    -- actually arrived, not what was ordered.
    v_line_total := v_received_base * v_poitem.unit_cost_mmk;
    v_subtotal := v_subtotal + v_line_total;

    -- Persist the received quantity, the recomputed line total, AND the unit
    -- snapshot (NULL when legacy).
    UPDATE purchase_order_items
       SET received_qty                  = v_received_base,
           line_total_mmk                = v_line_total,
           product_unit_id               = COALESCE(v_unit.id, product_unit_id),
           unit_name_snapshot            = COALESCE(v_unit.name, unit_name_snapshot),
           unit_base_quantity_snapshot   = COALESCE(v_unit.base_quantity, unit_base_quantity_snapshot),
           selected_unit_quantity        = COALESCE(v_unit_qty, selected_unit_quantity),
           unit_purchase_price_snapshot  = COALESCE(v_unit.purchase_price_mmk, unit_purchase_price_snapshot)
     WHERE id = v_poitem.id;

    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'id', v_poitem.id,
      'purchaseOrderId', v_poitem.purchase_order_id,
      'productId', v_poitem.product_id,
      'orderedQty', v_poitem.ordered_qty,
      'receivedQty', v_received_base,
      'unitCostMmk', v_poitem.unit_cost_mmk,
      'lineTotalMmk', v_line_total,
      'productUnitId', COALESCE(v_unit.id, v_poitem.product_unit_id),
      'unitNameSnapshot', COALESCE(v_unit.name, v_poitem.unit_name_snapshot),
      'unitBaseQuantitySnapshot', COALESCE(v_unit.base_quantity, v_poitem.unit_base_quantity_snapshot),
      'selectedUnitQuantity', COALESCE(v_unit_qty, v_poitem.selected_unit_quantity),
      'unitPurchasePriceSnapshot', COALESCE(v_unit.purchase_price_mmk, v_poitem.unit_purchase_price_snapshot)
    ));

    IF v_received_base = 0 THEN
      CONTINUE;
    END IF;
    v_total_received := v_total_received + v_received_base;

    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    VALUES (v_po.shop_id, v_poitem.product_id, 0)
    ON CONFLICT (shop_id, product_id) DO NOTHING;

    SELECT qty_base_units INTO v_qty_before
      FROM inventory
     WHERE shop_id = v_po.shop_id AND product_id = v_poitem.product_id
     FOR UPDATE;

    v_qty_after := v_qty_before + v_received_base;

    UPDATE inventory
       SET qty_base_units = v_qty_after
     WHERE shop_id = v_po.shop_id AND product_id = v_poitem.product_id;

    v_move_id := 'move-' || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO inventory_movements (
      id, shop_id, product_id, type, qty_change,
      qty_before, qty_after, reason, reference_type, reference_id,
      created_by, created_at,
      product_unit_id, unit_name_snapshot, unit_base_quantity_snapshot,
      selected_unit_quantity
    )
    VALUES (
      v_move_id, v_po.shop_id, v_poitem.product_id, 'PURCHASE_IN', v_received_base,
      v_qty_before, v_qty_after, 'Purchase order ' || v_po.order_no || ' received',
      'purchase', v_po.id, v_user.id, v_now,
      v_unit.id, v_unit.name, v_unit.base_quantity, v_unit_qty
    );

    v_moves_out := v_moves_out || jsonb_build_array(jsonb_build_object(
      'id', v_move_id,
      'shopId', v_po.shop_id,
      'productId', v_poitem.product_id,
      'type', 'PURCHASE_IN',
      'qtyChange', v_received_base,
      'qtyBefore', v_qty_before,
      'qtyAfter', v_qty_after,
      'reason', 'Purchase order ' || v_po.order_no || ' received',
      'referenceType', 'purchase',
      'referenceId', v_po.id,
      'createdBy', v_user.id,
      'createdAt', v_now,
      'productUnitId', v_unit.id,
      'unitNameSnapshot', v_unit.name,
      'unitBaseQuantitySnapshot', v_unit.base_quantity,
      'selectedUnitQuantity', v_unit_qty
    ));

    v_inv_out := v_inv_out || jsonb_build_array(jsonb_build_object(
      'shopId', v_po.shop_id,
      'productId', v_poitem.product_id,
      'qtyBaseUnits', v_qty_after
    ));
  END LOOP;

  -- Bill at received value: PO totals reflect what arrived, so supplier debt
  -- and the payment modal never over-state the payable on a partial receive.
  UPDATE purchase_orders
     SET status        = 'RECEIVED',
         received_by   = v_user.id,
         received_at   = v_now,
         subtotal_mmk  = v_subtotal,
         total_mmk     = v_subtotal + COALESCE(tax_mmk, 0)
   WHERE id = v_po.id
   RETURNING * INTO v_po;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, v_po.shop_id, v_user.id, 'PO_RECEIVED',
    'Purchase order ' || v_po.order_no || ' received (' || v_total_received || ' units)',
    'PurchaseOrder', v_po.id, v_now
  );

  v_audit_out := v_audit_out || jsonb_build_array(jsonb_build_object(
    'id', v_audit_id,
    'shopId', v_po.shop_id,
    'actorId', v_user.id,
    'actionType', 'PO_RECEIVED',
    'message', 'Purchase order ' || v_po.order_no || ' received (' || v_total_received || ' units)',
    'entityType', 'PurchaseOrder',
    'entityId', v_po.id,
    'createdAt', v_now
  ));

  RETURN jsonb_build_object(
    'purchaseOrder', jsonb_build_object(
      'id', v_po.id,
      'orderNo', v_po.order_no,
      'shopId', v_po.shop_id,
      'supplierId', v_po.supplier_id,
      'status', v_po.status,
      'subtotalMmk', v_po.subtotal_mmk,
      'taxMmk', v_po.tax_mmk,
      'totalMmk', v_po.total_mmk,
      'paidMmk', v_po.paid_mmk,
      'paymentStatus', v_po.payment_status,
      'notes', v_po.notes,
      'createdBy', v_po.created_by,
      'createdAt', v_po.created_at,
      'approvedBy', v_po.approved_by,
      'approvedAt', v_po.approved_at,
      'receivedBy', v_po.received_by,
      'receivedAt', v_po.received_at
    ),
    'purchaseOrderItems', v_items_out,
    'inventory', v_inv_out,
    'movements', v_moves_out,
    'auditLogs', v_audit_out
  );
END;
$$;


ALTER FUNCTION "public"."receive_purchase_order"("p_purchase_order_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."receive_stock_transfer"("p_transfer_id" "text", "p_received_items" "jsonb" DEFAULT NULL::"jsonb", "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_actor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user        users;
  v_transfer    stock_transfers;
  v_now         timestamptz := resolve_event_time(p_created_at);
  v_titem       stock_transfer_items;
  v_approved    integer;
  v_input_qty   integer;
  v_qty         integer;
  v_src_before  integer;
  v_src_after   integer;
  v_dst_before  integer;
  v_dst_after   integer;
  v_item_count  integer := 0;
  v_move_id     text;
  v_audit_id    text;
  v_items_out   jsonb := '[]'::jsonb;
  v_inv_out     jsonb := '[]'::jsonb;
  v_moves_out   jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This offline action was queued by a different user — reconnect as them to sync it, or dismiss it from Sync Conflicts.';
  END IF;
  IF p_transfer_id IS NULL OR btrim(p_transfer_id) = '' THEN
    RAISE EXCEPTION 'Stock transfer is required';
  END IF;
  IF p_received_items IS NOT NULL AND jsonb_typeof(p_received_items) <> 'array' THEN
    RAISE EXCEPTION 'Received items must be a JSON array';
  END IF;

  SELECT * INTO v_transfer FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
  IF v_transfer.status <> 'IN_TRANSIT' THEN
    RAISE EXCEPTION 'Transfer cannot be received from status %', v_transfer.status;
  END IF;
  IF v_transfer.from_shop_id = v_transfer.to_shop_id THEN
    RAISE EXCEPTION 'Transfer source and destination shop are the same';
  END IF;
  -- The DESTINATION confirms receipt.
  IF NOT app_can_for_shop('transfer:approve', v_transfer.to_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to receive transfers for this shop';
  END IF;

  PERFORM pg_advisory_xact_lock(
    least(hashtext('xfer:' || v_transfer.from_shop_id),
          hashtext('xfer:' || v_transfer.to_shop_id)));
  PERFORM pg_advisory_xact_lock(
    greatest(hashtext('xfer:' || v_transfer.from_shop_id),
             hashtext('xfer:' || v_transfer.to_shop_id)));

  FOR v_titem IN
    SELECT * FROM stock_transfer_items
     WHERE transfer_id = v_transfer.id
     ORDER BY id
     FOR UPDATE
  LOOP
    v_approved := COALESCE(v_titem.approved_qty, v_titem.requested_qty);

    -- Received qty: explicit per-product input, else the approved qty.
    v_input_qty := NULL;
    IF p_received_items IS NOT NULL THEN
      SELECT NULLIF(e->>'received_qty', '')::integer
        INTO v_input_qty
        FROM jsonb_array_elements(p_received_items) e
       WHERE e->>'product_id' = v_titem.product_id
       LIMIT 1;
    END IF;
    v_qty := COALESCE(v_input_qty, v_approved);

    IF v_qty < 0 THEN
      RAISE EXCEPTION 'Received quantity cannot be negative for product %', v_titem.product_id;
    END IF;
    IF v_qty > v_approved THEN
      RAISE EXCEPTION 'Received quantity exceeds approved quantity for product %', v_titem.product_id;
    END IF;

    UPDATE stock_transfer_items SET transferred_qty = v_qty WHERE id = v_titem.id;

    v_items_out := v_items_out || jsonb_build_array(jsonb_build_object(
      'id', v_titem.id, 'transferId', v_titem.transfer_id, 'productId', v_titem.product_id,
      'requestedQty', v_titem.requested_qty, 'approvedQty', v_titem.approved_qty,
      'transferredQty', v_qty,
      'productUnitId', v_titem.product_unit_id, 'unitNameSnapshot', v_titem.unit_name_snapshot,
      'unitBaseQuantitySnapshot', v_titem.unit_base_quantity_snapshot,
      'selectedUnitQuantity', v_titem.selected_unit_quantity));

    IF v_qty = 0 THEN
      CONTINUE;
    END IF;

    -- Source shop: decrement (stock was held here until now).
    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    VALUES (v_transfer.from_shop_id, v_titem.product_id, 0)
    ON CONFLICT (shop_id, product_id) DO NOTHING;

    SELECT qty_base_units INTO v_src_before
      FROM inventory
     WHERE shop_id = v_transfer.from_shop_id AND product_id = v_titem.product_id
     FOR UPDATE;

    v_src_after := v_src_before - v_qty;
    IF v_src_after < 0 THEN
      RAISE EXCEPTION 'Insufficient stock at source for %: have %, need %',
        v_titem.product_id, v_src_before, v_qty;
    END IF;

    UPDATE inventory SET qty_base_units = v_src_after
     WHERE shop_id = v_transfer.from_shop_id AND product_id = v_titem.product_id;

    -- Destination shop: increment.
    INSERT INTO inventory (shop_id, product_id, qty_base_units)
    VALUES (v_transfer.to_shop_id, v_titem.product_id, 0)
    ON CONFLICT (shop_id, product_id) DO NOTHING;

    SELECT qty_base_units INTO v_dst_before
      FROM inventory
     WHERE shop_id = v_transfer.to_shop_id AND product_id = v_titem.product_id
     FOR UPDATE;

    v_dst_after := v_dst_before + v_qty;
    UPDATE inventory SET qty_base_units = v_dst_after
     WHERE shop_id = v_transfer.to_shop_id AND product_id = v_titem.product_id;

    -- OUT movement (source).
    v_move_id := 'move-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO inventory_movements (
      id, shop_id, product_id, type, qty_change,
      qty_before, qty_after, reason, reference_type, reference_id,
      created_by, created_at,
      product_unit_id, unit_name_snapshot, unit_base_quantity_snapshot, selected_unit_quantity
    )
    VALUES (
      v_move_id, v_transfer.from_shop_id, v_titem.product_id, 'TRANSFER_OUT', -v_qty,
      v_src_before, v_src_after, 'Stock transfer ' || v_transfer.transfer_no,
      'transfer', v_transfer.id, v_user.id, v_now,
      v_titem.product_unit_id, v_titem.unit_name_snapshot,
      v_titem.unit_base_quantity_snapshot, v_titem.selected_unit_quantity);

    v_moves_out := v_moves_out || jsonb_build_array(jsonb_build_object(
      'id', v_move_id, 'shopId', v_transfer.from_shop_id, 'productId', v_titem.product_id,
      'type', 'TRANSFER_OUT', 'qtyChange', -v_qty, 'qtyBefore', v_src_before, 'qtyAfter', v_src_after,
      'reason', 'Stock transfer ' || v_transfer.transfer_no, 'referenceType', 'transfer',
      'referenceId', v_transfer.id, 'createdBy', v_user.id, 'createdAt', v_now,
      'productUnitId', v_titem.product_unit_id, 'unitNameSnapshot', v_titem.unit_name_snapshot,
      'unitBaseQuantitySnapshot', v_titem.unit_base_quantity_snapshot,
      'selectedUnitQuantity', v_titem.selected_unit_quantity));

    -- IN movement (destination).
    v_move_id := 'move-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO inventory_movements (
      id, shop_id, product_id, type, qty_change,
      qty_before, qty_after, reason, reference_type, reference_id,
      created_by, created_at,
      product_unit_id, unit_name_snapshot, unit_base_quantity_snapshot, selected_unit_quantity
    )
    VALUES (
      v_move_id, v_transfer.to_shop_id, v_titem.product_id, 'TRANSFER_IN', v_qty,
      v_dst_before, v_dst_after, 'Stock transfer ' || v_transfer.transfer_no,
      'transfer', v_transfer.id, v_user.id, v_now,
      v_titem.product_unit_id, v_titem.unit_name_snapshot,
      v_titem.unit_base_quantity_snapshot, v_titem.selected_unit_quantity);

    v_moves_out := v_moves_out || jsonb_build_array(jsonb_build_object(
      'id', v_move_id, 'shopId', v_transfer.to_shop_id, 'productId', v_titem.product_id,
      'type', 'TRANSFER_IN', 'qtyChange', v_qty, 'qtyBefore', v_dst_before, 'qtyAfter', v_dst_after,
      'reason', 'Stock transfer ' || v_transfer.transfer_no, 'referenceType', 'transfer',
      'referenceId', v_transfer.id, 'createdBy', v_user.id, 'createdAt', v_now,
      'productUnitId', v_titem.product_unit_id, 'unitNameSnapshot', v_titem.unit_name_snapshot,
      'unitBaseQuantitySnapshot', v_titem.unit_base_quantity_snapshot,
      'selectedUnitQuantity', v_titem.selected_unit_quantity));

    v_inv_out := v_inv_out
      || jsonb_build_array(jsonb_build_object(
          'shopId', v_transfer.from_shop_id, 'productId', v_titem.product_id, 'qtyBaseUnits', v_src_after))
      || jsonb_build_array(jsonb_build_object(
          'shopId', v_transfer.to_shop_id, 'productId', v_titem.product_id, 'qtyBaseUnits', v_dst_after));

    v_item_count := v_item_count + 1;
  END LOOP;

  UPDATE stock_transfers
     SET status = 'COMPLETED', received_by = v_user.id, received_at = v_now, completed_at = v_now
   WHERE id = v_transfer.id
   RETURNING * INTO v_transfer;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_transfer.to_shop_id, v_user.id, 'TRANSFER_RECEIVED',
    'Stock transfer ' || v_transfer.transfer_no || ' received (' || v_item_count || ' lines)',
    'StockTransfer', v_transfer.id, v_now);

  RETURN jsonb_build_object(
    'stockTransfer', transfer_json(v_transfer),
    'stockTransferItems', v_items_out,
    'inventory', v_inv_out,
    'movements', v_moves_out,
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_transfer.to_shop_id, 'actorId', v_user.id,
      'actionType', 'TRANSFER_RECEIVED',
      'message', 'Stock transfer ' || v_transfer.transfer_no || ' received (' || v_item_count || ' lines)',
      'entityType', 'StockTransfer', 'entityId', v_transfer.id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."receive_stock_transfer"("p_transfer_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_supplier_payment"("p_purchase_order_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text", "p_created_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_expected_actor_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users;
  v_po purchase_orders;
  v_payment supplier_payments;
  v_now timestamptz := resolve_event_time(p_created_at);
  v_outstanding integer;
  v_new_paid integer;
  v_new_status text;
  v_payment_id text := 'suppay-' || replace(gen_random_uuid()::text, '-', '');
  v_audit_id text := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  v_method text := upper(COALESCE(NULLIF(btrim(p_payment_method), ''), ''));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_expected_actor_id IS NOT NULL AND p_expected_actor_id <> v_user.id THEN
    RAISE EXCEPTION 'This offline action was queued by a different user — reconnect as them to sync it, or dismiss it from Sync Conflicts.';
  END IF;

  IF p_purchase_order_id IS NULL OR btrim(p_purchase_order_id) = '' THEN
    RAISE EXCEPTION 'Purchase order is required';
  END IF;
  IF p_amount_mmk IS NULL OR p_amount_mmk <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF v_method NOT IN ('CASH', 'BANK', 'MOBILE', 'OTHER') THEN
    RAISE EXCEPTION 'Unsupported supplier payment method: %', p_payment_method;
  END IF;

  SELECT * INTO v_po
    FROM purchase_orders
   WHERE id = p_purchase_order_id
   FOR UPDATE;

  IF v_po.id IS NULL THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF v_po.status <> 'RECEIVED' THEN
    RAISE EXCEPTION 'Supplier payments can only be recorded against received purchase orders';
  END IF;
  IF NOT app_can_for_shop('supplier:payment_create', v_po.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to record supplier payments for this shop';
  END IF;

  v_outstanding := v_po.total_mmk - COALESCE(v_po.paid_mmk, 0);
  IF v_outstanding <= 0 THEN
    RAISE EXCEPTION 'Purchase order is already paid';
  END IF;
  IF p_amount_mmk > v_outstanding THEN
    RAISE EXCEPTION 'Payment amount exceeds outstanding balance';
  END IF;

  INSERT INTO supplier_payments (
    id, supplier_id, purchase_order_id, shop_id, amount_mmk,
    payment_method, reference_no, notes, paid_at, created_by, created_at
  )
  VALUES (
    v_payment_id, v_po.supplier_id, v_po.id, v_po.shop_id, p_amount_mmk,
    v_method, NULLIF(btrim(p_reference_no), ''), NULLIF(btrim(p_notes), ''),
    v_now, v_user.id, v_now
  )
  RETURNING * INTO v_payment;

  v_new_paid := COALESCE(v_po.paid_mmk, 0) + p_amount_mmk;
  v_new_status := CASE
    WHEN v_new_paid >= v_po.total_mmk THEN 'PAID'
    WHEN v_new_paid > 0 THEN 'PARTIAL'
    ELSE 'UNPAID'
  END;

  UPDATE purchase_orders
     SET paid_mmk = v_new_paid,
         payment_status = v_new_status
   WHERE id = v_po.id
   RETURNING * INTO v_po;

  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, v_po.shop_id, v_user.id, 'SUPPLIER_PAYMENT_RECORDED',
    'Supplier payment recorded for ' || v_po.order_no || ': MMK ' || p_amount_mmk,
    'SupplierPayment', v_payment.id, v_now
  );

  RETURN jsonb_build_object(
    'purchaseOrder', jsonb_build_object(
      'id', v_po.id,
      'orderNo', v_po.order_no,
      'shopId', v_po.shop_id,
      'supplierId', v_po.supplier_id,
      'status', v_po.status,
      'subtotalMmk', v_po.subtotal_mmk,
      'taxMmk', v_po.tax_mmk,
      'totalMmk', v_po.total_mmk,
      'paidMmk', v_po.paid_mmk,
      'paymentStatus', v_po.payment_status,
      'supplierInvoiceNo', v_po.supplier_invoice_no,
      'deliveryNoteNo', v_po.delivery_note_no,
      'notes', v_po.notes,
      'createdBy', v_po.created_by,
      'createdAt', v_po.created_at,
      'approvedBy', v_po.approved_by,
      'approvedAt', v_po.approved_at,
      'receivedBy', v_po.received_by,
      'receivedAt', v_po.received_at
    ),
    'supplierPayment', jsonb_build_object(
      'id', v_payment.id,
      'supplierId', v_payment.supplier_id,
      'purchaseOrderId', v_payment.purchase_order_id,
      'shopId', v_payment.shop_id,
      'amountMmk', v_payment.amount_mmk,
      'paymentMethod', v_payment.payment_method,
      'referenceNo', v_payment.reference_no,
      'notes', v_payment.notes,
      'paidAt', v_payment.paid_at,
      'createdBy', v_payment.created_by,
      'createdAt', v_payment.created_at,
      'voidedAt', v_payment.voided_at,
      'voidedBy', v_payment.voided_by,
      'voidReason', v_payment.void_reason
    ),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id,
      'shopId', v_po.shop_id,
      'actorId', v_user.id,
      'actionType', 'SUPPLIER_PAYMENT_RECORDED',
      'message', 'Supplier payment recorded for ' || v_po.order_no || ': MMK ' || p_amount_mmk,
      'entityType', 'SupplierPayment',
      'entityId', v_payment.id,
      'createdAt', v_now
    ))
  );
END;
$$;


ALTER FUNCTION "public"."record_supplier_payment"("p_purchase_order_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_refund_void_request"("p_request_id" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_auth_uid   uuid := auth.uid();
  v_user       users;
  v_request    refund_void_requests;
  v_perm       text;
  v_audit_id   text;
  v_now        timestamptz := now();
  v_audit_logs jsonb := '[]'::jsonb;
BEGIN
  IF v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_user := current_app_user();
  IF v_user.id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_request
    FROM refund_void_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_request.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'Request is not pending';
  END IF;

  v_perm := CASE WHEN v_request.type = 'VOID' THEN 'pos:void_sale' ELSE 'pos:refund' END;

  IF NOT app_can_for_shop(v_perm, v_request.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to reject this request';
  END IF;

  UPDATE refund_void_requests
     SET status = 'REJECTED'
   WHERE id = v_request.id
   RETURNING * INTO v_request;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO audit_logs (
    id, shop_id, actor_id, action_type, message,
    entity_type, entity_id, created_at
  )
  VALUES (
    v_audit_id, v_request.shop_id, v_user.id, 'APPROVAL_REJECTED',
    'Rejected ' || v_request.type || ' request. Reason: ' || COALESCE(p_reason, v_request.reason),
    'Refund', v_request.id, v_now
  );

  v_audit_logs := v_audit_logs || jsonb_build_array(jsonb_build_object(
    'id', v_audit_id,
    'shopId', v_request.shop_id,
    'actorId', v_user.id,
    'actionType', 'APPROVAL_REJECTED',
    'message', 'Rejected ' || v_request.type || ' request. Reason: ' || COALESCE(p_reason, v_request.reason),
    'entityType', 'Refund',
    'entityId', v_request.id,
    'createdAt', v_now
  ));

  RETURN jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_request.id,
      'saleId', v_request.sale_id,
      'shopId', v_request.shop_id,
      'type', v_request.type,
      'reason', v_request.reason,
      'createdBy', v_request.created_by,
      'createdAt', v_request.created_at,
      'items', v_request.items,
      'status', v_request.status
    ),
    'auditLogs', v_audit_logs
  );
END;
$$;


ALTER FUNCTION "public"."reject_refund_void_request"("p_request_id" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_stock_transfer"("p_transfer_id" "text", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user users; v_t stock_transfers; v_now timestamptz := now();
  v_audit_id text; v_msg text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_t FROM stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_t.id IS NULL THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
  IF v_t.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Transfer cannot be rejected from status %', v_t.status;
  END IF;
  IF NOT app_can_for_shop('transfer:approve', v_t.from_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to reject transfers for this shop';
  END IF;

  v_msg := COALESCE(NULLIF(btrim(p_reason), ''), 'No reason given');
  UPDATE stock_transfers
     SET status = 'REJECTED', canceled_by = v_user.id, canceled_at = v_now, cancel_reason = v_msg
   WHERE id = v_t.id RETURNING * INTO v_t;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_t.from_shop_id, v_user.id, 'TRANSFER_REJECTED',
    'Transfer ' || v_t.transfer_no || ' rejected. Reason: ' || v_msg,
    'StockTransfer', v_t.id, v_now);

  RETURN jsonb_build_object(
    'stockTransfer', transfer_json(v_t),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_t.from_shop_id, 'actorId', v_user.id, 'actionType', 'TRANSFER_REJECTED',
      'message', 'Transfer ' || v_t.transfer_no || ' rejected. Reason: ' || v_msg,
      'entityType', 'StockTransfer', 'entityId', v_t.id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."reject_stock_transfer"("p_transfer_id" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_manager"("p_shop_id" "text", "p_new_manager_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user        users;
  v_old_manager users;
  v_new_manager users;
  v_now         timestamptz := now();
  v_audit_id    text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT app_has_perm('user:update') THEN
    RAISE EXCEPTION 'You are not permitted to change shop managers';
  END IF;

  PERFORM 1 FROM shops WHERE id = p_shop_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shop not found'; END IF;

  SELECT * INTO v_new_manager FROM users WHERE id = p_new_manager_id FOR UPDATE;
  IF v_new_manager.id IS NULL THEN RAISE EXCEPTION 'New manager not found'; END IF;

  SELECT * INTO v_old_manager FROM users
   WHERE role = 'MANAGER' AND is_active = true AND shop_id = p_shop_id
   FOR UPDATE;

  IF v_old_manager.id = v_new_manager.id THEN
    RAISE EXCEPTION 'This user is already the manager of this shop';
  END IF;

  -- Statement 1: activate the new manager. Momentarily leaves two active
  -- managers for this shop if one already existed — safe only because
  -- users_one_active_manager_per_shop is DEFERRABLE (section 1 above);
  -- re-checked at this function's implicit transaction commit.
  UPDATE users SET role = 'MANAGER', shop_id = p_shop_id, is_active = true
   WHERE id = v_new_manager.id
   RETURNING * INTO v_new_manager;

  -- Statement 2, separate on purpose: 020's trigger does a live check for
  -- "is a replacement already active" when deactivating the shop's only
  -- manager — it only sees statement 1's change because this is a fresh
  -- statement, not folded into one multi-row UPDATE (verified; see the
  -- file header comment for why the combined form doesn't work).
  IF v_old_manager.id IS NOT NULL THEN
    UPDATE users SET is_active = false WHERE id = v_old_manager.id;
  END IF;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, p_shop_id, v_user.id, 'MANAGER_REPLACED',
    'Manager for shop replaced: ' || COALESCE(v_old_manager.name, '(none)') || ' -> ' || v_new_manager.name,
    'User', v_new_manager.id, v_now);

  RETURN jsonb_build_object(
    'newManagerId', v_new_manager.id,
    'oldManagerId', v_old_manager.id
  );
END;
$$;


ALTER FUNCTION "public"."replace_manager"("p_shop_id" "text", "p_new_manager_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_event_time"("p_client_time" timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
  IF p_client_time IS NULL THEN
    RETURN now();
  END IF;
  IF p_client_time > now() + interval '5 minutes'
     OR p_client_time < now() - interval '48 hours' THEN
    RETURN now();
  END IF;
  RETURN p_client_time;
END;
$$;


ALTER FUNCTION "public"."resolve_event_time"("p_client_time" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."role_default_permissions"("p_role" "text") RETURNS "text"[]
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE upper(p_role)
    WHEN 'ADMIN' THEN ARRAY[
      'shop:create','shop:read','shop:update','shop:delete',
      'user:create','user:read','user:update','user:delete',
      'product:create','product:read','product:update','product:delete','product:edit_price','barcode:manage',
      'inventory:view_stock','inventory:view_movements','inventory:adjust','inventory:damage','inventory:override_negative',
      'transfer:create','transfer:approve','transfer:cancel','transfer:view',
      'pos:create_sale','pos:apply_discount','pos:override_price','pos:override_stock',
      'pos:void_sale','pos:refund','pos:request_refund','pos:request_void',
      'sale:view','sales:view_own_shift','receipt:reprint',
      'supplier:create','supplier:read','supplier:update','supplier:delete',
      'supplier:debt_view','supplier:payment_create',
      'purchase:create','purchase:approve','purchase:receive','purchase:view',
      'pricing:manage','approval:view',
      'shift:manage_own','shift:manage_all','shift:verify',
      'report:own_shift','report:shop_sales','report:shop_inventory','report:shop_profit','report:global',
      'audit:view_shop','audit:view_global'
    ]
    WHEN 'MANAGER' THEN ARRAY[
      'shop:read','user:read',
      'product:read','product:update','product:edit_price',
      'inventory:view_stock','inventory:view_movements','inventory:adjust','inventory:damage','inventory:override_negative',
      'transfer:create','transfer:approve','transfer:cancel','transfer:view',
      'pos:create_sale','pos:apply_discount','pos:override_price','pos:override_stock',
      'pos:void_sale','pos:refund','pos:request_refund','pos:request_void',
      'sale:view','sales:view_own_shift','receipt:reprint',
      'supplier:read','supplier:debt_view','supplier:payment_create',
      'purchase:create','purchase:approve','purchase:receive','purchase:view','approval:view',
      'shift:manage_own','shift:manage_all','shift:verify',
      'report:own_shift','report:shop_sales','report:shop_inventory',
      'audit:view_shop'
    ]
    WHEN 'CASHIER' THEN ARRAY[
      'product:read','inventory:view_stock',
      'pos:create_sale','pos:apply_discount','pos:request_refund','pos:request_void',
      'sales:view_own_shift','receipt:reprint',
      'shift:manage_own','report:own_shift'
    ]
    WHEN 'BUYER' THEN ARRAY[
      'product:read','supplier:read','supplier:debt_view','purchase:view','purchase:create'
    ]
    ELSE ARRAY[]::text[]
  END;
$$;


ALTER FUNCTION "public"."role_default_permissions"("p_role" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_transfers" (
    "id" "text" NOT NULL,
    "transfer_no" "text" NOT NULL,
    "from_shop_id" "text" NOT NULL,
    "to_shop_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "notes" "text",
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "canceled_by" "text",
    "canceled_at" timestamp with time zone,
    "cancel_reason" "text",
    "dispatched_by" "text",
    "dispatched_at" timestamp with time zone,
    "received_by" "text",
    "received_at" timestamp with time zone
);


ALTER TABLE "public"."stock_transfers" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."transfer_json"("v_t" "public"."stock_transfers") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT jsonb_build_object(
    'id', v_t.id, 'transferNo', v_t.transfer_no, 'fromShopId', v_t.from_shop_id,
    'toShopId', v_t.to_shop_id, 'status', v_t.status, 'notes', v_t.notes,
    'createdBy', v_t.created_by, 'createdAt', v_t.created_at,
    'approvedBy', v_t.approved_by, 'approvedAt', v_t.approved_at,
    'dispatchedBy', v_t.dispatched_by, 'dispatchedAt', v_t.dispatched_at,
    'receivedBy', v_t.received_by, 'receivedAt', v_t.received_at,
    'completedAt', v_t.completed_at, 'canceledBy', v_t.canceled_by,
    'canceledAt', v_t.canceled_at, 'cancelReason', v_t.cancel_reason);
$$;


ALTER FUNCTION "public"."transfer_json"("v_t" "public"."stock_transfers") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unit_types_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."unit_types_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_app_user"("p_id" "text", "p_name" "text", "p_role" "text", "p_shop_id" "text", "p_granted_permissions" "text"[] DEFAULT NULL::"text"[], "p_revoked_permissions" "text"[] DEFAULT NULL::"text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user     users;
  v_old      users;
  v_new      users;
  v_now      timestamptz := now();
  v_audit_id text;
  v_changes  text[] := '{}';
  v_msg      text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT app_has_perm('user:update') THEN
    RAISE EXCEPTION 'You are not permitted to update users';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'User name is required';
  END IF;

  SELECT * INTO v_old FROM users WHERE id = p_id FOR UPDATE;
  IF v_old.id IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;

  IF v_old.name IS DISTINCT FROM p_name THEN v_changes := array_append(v_changes, 'name'); END IF;
  IF v_old.role IS DISTINCT FROM p_role THEN v_changes := array_append(v_changes, 'role'); END IF;
  IF v_old.shop_id IS DISTINCT FROM p_shop_id THEN v_changes := array_append(v_changes, 'shop'); END IF;
  IF v_old.granted_permissions IS DISTINCT FROM p_granted_permissions THEN
    v_changes := array_append(v_changes, 'granted permissions');
  END IF;
  IF v_old.revoked_permissions IS DISTINCT FROM p_revoked_permissions THEN
    v_changes := array_append(v_changes, 'revoked permissions');
  END IF;

  UPDATE users
     SET name = p_name, role = p_role, shop_id = p_shop_id,
         granted_permissions = p_granted_permissions, revoked_permissions = p_revoked_permissions
   WHERE id = p_id
   RETURNING * INTO v_new;

  v_msg := 'User ' || v_new.name
           || CASE WHEN array_length(v_changes, 1) > 0
                THEN '. Changed: ' || array_to_string(v_changes, ', ')
                ELSE ' updated (no field changes)' END;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_new.shop_id, v_user.id, 'USER_UPDATED', v_msg, 'User', v_new.id, v_now);

  RETURN jsonb_build_object(
    'id', v_new.id, 'name', v_new.name, 'email', v_new.email, 'role', v_new.role,
    'shopId', v_new.shop_id, 'authId', v_new.auth_id,
    'grantedPermissions', v_new.granted_permissions, 'revokedPermissions', v_new.revoked_permissions,
    'isActive', v_new.is_active, 'createdAt', v_new.created_at
  );
END;
$$;


ALTER FUNCTION "public"."update_app_user"("p_id" "text", "p_name" "text", "p_role" "text", "p_shop_id" "text", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_supplier"("p_id" "text", "p_code" "text", "p_name" "text", "p_contact_person" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_email" "text" DEFAULT NULL::"text", "p_address" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text", "p_is_active" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user      users;
  v_old       suppliers;
  v_new       suppliers;
  v_now       timestamptz := now();
  v_audit_id  text;
  v_changes   text[] := '{}';
  v_msg       text;
  v_is_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF NOT app_has_perm('supplier:update') THEN
    RAISE EXCEPTION 'You are not permitted to update suppliers';
  END IF;

  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RAISE EXCEPTION 'Supplier code is required';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Supplier name is required';
  END IF;

  SELECT * INTO v_old FROM suppliers WHERE id = p_id FOR UPDATE;
  IF v_old.id IS NULL THEN RAISE EXCEPTION 'Supplier not found'; END IF;

  v_is_active := COALESCE(p_is_active, v_old.is_active);

  -- array_append(), not `||` — `text[] || 'literal'` is ambiguous between
  -- the array-concat and element-append overloads and Postgres resolves it
  -- by trying to parse the untyped literal AS an array literal, raising
  -- "malformed array literal" (verified against a real database: every
  -- branch below failed until switched to array_append).
  IF v_old.code IS DISTINCT FROM p_code THEN v_changes := array_append(v_changes, 'code'); END IF;
  IF v_old.name IS DISTINCT FROM p_name THEN v_changes := array_append(v_changes, 'name'); END IF;
  IF v_old.contact_person IS DISTINCT FROM p_contact_person THEN v_changes := array_append(v_changes, 'contact person'); END IF;
  IF v_old.phone IS DISTINCT FROM p_phone THEN v_changes := array_append(v_changes, 'phone'); END IF;
  IF v_old.email IS DISTINCT FROM p_email THEN v_changes := array_append(v_changes, 'email'); END IF;
  IF v_old.address IS DISTINCT FROM p_address THEN v_changes := array_append(v_changes, 'address'); END IF;
  IF v_old.notes IS DISTINCT FROM p_notes THEN v_changes := array_append(v_changes, 'notes'); END IF;
  IF v_old.is_active IS DISTINCT FROM v_is_active THEN
    v_changes := array_append(v_changes, CASE WHEN v_is_active THEN 'activated' ELSE 'deactivated' END);
  END IF;

  UPDATE suppliers
     SET code = p_code, name = p_name, contact_person = p_contact_person, phone = p_phone,
         email = p_email, address = p_address, notes = p_notes, is_active = v_is_active
   WHERE id = p_id
   RETURNING * INTO v_new;

  v_msg := 'Supplier ' || v_new.code || ' (' || v_new.name || ') updated'
           || CASE WHEN array_length(v_changes, 1) > 0
                THEN '. Changed: ' || array_to_string(v_changes, ', ')
                ELSE '' END;

  v_audit_id := 'audit-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, NULL, v_user.id, 'SUPPLIER_UPDATED', v_msg, 'Supplier', v_new.id, v_now);

  RETURN jsonb_build_object(
    'supplier', jsonb_build_object(
      'id', v_new.id, 'code', v_new.code, 'name', v_new.name, 'contactPerson', v_new.contact_person,
      'phone', v_new.phone, 'email', v_new.email, 'address', v_new.address, 'notes', v_new.notes,
      'isActive', v_new.is_active, 'createdAt', v_new.created_at),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', NULL, 'actorId', v_user.id, 'actionType', 'SUPPLIER_UPDATED',
      'message', v_msg, 'entityType', 'Supplier', 'entityId', v_new.id, 'createdAt', v_now))
  );
END;
$$;


ALTER FUNCTION "public"."update_supplier"("p_id" "text", "p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text", "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."void_supplier_payment"("p_payment_id" "text", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user     users;
  v_pay      supplier_payments;
  v_po       purchase_orders;
  v_now      timestamptz := now();
  v_new_paid integer;
  v_new_status text;
  v_audit_id text := 'audit-' || replace(gen_random_uuid()::text, '-', '');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_payment_id IS NULL OR btrim(p_payment_id) = '' THEN
    RAISE EXCEPTION 'Payment is required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A void reason is required';
  END IF;

  SELECT * INTO v_pay FROM supplier_payments WHERE id = p_payment_id FOR UPDATE;
  IF v_pay.id IS NULL THEN RAISE EXCEPTION 'Supplier payment not found'; END IF;
  IF v_pay.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Supplier payment is already voided';
  END IF;
  IF NOT (app_role() = 'ADMIN' OR app_can_for_shop('supplier:payment_create', v_pay.shop_id)) THEN
    RAISE EXCEPTION 'You are not permitted to void supplier payments for this shop';
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = v_pay.purchase_order_id FOR UPDATE;
  IF v_po.id IS NULL THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  -- Reverse the payment off the PO and recompute its status.
  v_new_paid := GREATEST(COALESCE(v_po.paid_mmk, 0) - v_pay.amount_mmk, 0);
  v_new_status := CASE
    WHEN v_new_paid >= v_po.total_mmk AND v_po.total_mmk > 0 THEN 'PAID'
    WHEN v_new_paid > 0 THEN 'PARTIAL'
    ELSE 'UNPAID'
  END;

  UPDATE purchase_orders
     SET paid_mmk = v_new_paid, payment_status = v_new_status
   WHERE id = v_po.id
   RETURNING * INTO v_po;

  UPDATE supplier_payments
     SET voided_at = v_now, voided_by = v_user.id, void_reason = btrim(p_reason)
   WHERE id = v_pay.id
   RETURNING * INTO v_pay;

  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES (v_audit_id, v_po.shop_id, v_user.id, 'SUPPLIER_PAYMENT_VOIDED',
    'Supplier payment voided for ' || v_po.order_no || ': MMK ' || v_pay.amount_mmk || '. Reason: ' || btrim(p_reason),
    'SupplierPayment', v_pay.id, v_now);

  RETURN jsonb_build_object(
    'purchaseOrder', jsonb_build_object(
      'id', v_po.id, 'orderNo', v_po.order_no, 'shopId', v_po.shop_id, 'supplierId', v_po.supplier_id,
      'status', v_po.status, 'subtotalMmk', v_po.subtotal_mmk, 'taxMmk', v_po.tax_mmk,
      'totalMmk', v_po.total_mmk, 'paidMmk', v_po.paid_mmk, 'paymentStatus', v_po.payment_status,
      'supplierInvoiceNo', v_po.supplier_invoice_no, 'deliveryNoteNo', v_po.delivery_note_no,
      'notes', v_po.notes, 'createdBy', v_po.created_by, 'createdAt', v_po.created_at,
      'approvedBy', v_po.approved_by, 'approvedAt', v_po.approved_at,
      'receivedBy', v_po.received_by, 'receivedAt', v_po.received_at
    ),
    'supplierPayment', jsonb_build_object(
      'id', v_pay.id, 'supplierId', v_pay.supplier_id, 'purchaseOrderId', v_pay.purchase_order_id,
      'shopId', v_pay.shop_id, 'amountMmk', v_pay.amount_mmk, 'paymentMethod', v_pay.payment_method,
      'referenceNo', v_pay.reference_no, 'notes', v_pay.notes, 'paidAt', v_pay.paid_at,
      'createdBy', v_pay.created_by, 'createdAt', v_pay.created_at,
      'voidedAt', v_pay.voided_at, 'voidedBy', v_pay.voided_by, 'voidReason', v_pay.void_reason
    ),
    'auditLogs', jsonb_build_array(jsonb_build_object(
      'id', v_audit_id, 'shopId', v_po.shop_id, 'actorId', v_user.id,
      'actionType', 'SUPPLIER_PAYMENT_VOIDED',
      'message', 'Supplier payment voided for ' || v_po.order_no || ': MMK ' || v_pay.amount_mmk,
      'entityType', 'SupplierPayment', 'entityId', v_pay.id, 'createdAt', v_now
    ))
  );
END;
$$;


ALTER FUNCTION "public"."void_supplier_payment"("p_payment_id" "text", "p_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_login_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "auth_id" "uuid" NOT NULL,
    "code_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone,
    "attempts" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_login_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "text" NOT NULL,
    "shop_id" "text",
    "actor_id" "text" NOT NULL,
    "action_type" "text" NOT NULL,
    "message" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."brands" (
    "id" "text" NOT NULL,
    "category_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "brands_name_not_blank" CHECK (("length"("btrim"("name")) > 0))
);


ALTER TABLE "public"."brands" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_profile" (
    "id" "text" DEFAULT 'default'::"text" NOT NULL,
    "business_name" "text",
    "logo_url" "text",
    "address" "text",
    "phone" "text",
    "email" "text",
    "tagline" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "business_profile_singleton" CHECK (("id" = 'default'::"text"))
);


ALTER TABLE "public"."business_profile" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "icon_key" "text"
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory" (
    "shop_id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "qty_base_units" integer DEFAULT 0 NOT NULL,
    "storage_location" "text",
    "last_counted_at" timestamp with time zone
);


ALTER TABLE "public"."inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "text" NOT NULL,
    "shop_id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "qty_change" integer NOT NULL,
    "qty_before" integer NOT NULL,
    "qty_after" integer NOT NULL,
    "reason" "text" NOT NULL,
    "reference_type" "text",
    "reference_id" "text",
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "product_unit_id" "text",
    "unit_name_snapshot" "text",
    "unit_base_quantity_snapshot" integer,
    "selected_unit_quantity" integer
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_admins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "auth_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."platform_admins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."price_levels" (
    "id" "text" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "price_levels_code_not_blank" CHECK (("length"("btrim"("code")) > 0)),
    CONSTRAINT "price_levels_name_not_blank" CHECK (("length"("btrim"("name")) > 0))
);


ALTER TABLE "public"."price_levels" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."price_tiers" (
    "id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "shop_id" "text",
    "min_qty" integer NOT NULL,
    "max_qty" integer,
    "price_mmk" integer NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text" NOT NULL
);


ALTER TABLE "public"."price_tiers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_barcodes" (
    "id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "value" "text" NOT NULL,
    "type" "text" NOT NULL,
    "product_unit_id" "text"
);


ALTER TABLE "public"."product_barcodes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_image_upload_sessions" (
    "id" "text" NOT NULL,
    "token_hash" "text" NOT NULL,
    "created_by" "text" NOT NULL,
    "shop_id" "text",
    "product_id" "text",
    "storage_path" "text" NOT NULL,
    "public_url" "text",
    "bytes" integer,
    "mime_type" "text",
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "signed_upload_token" "text",
    CONSTRAINT "product_image_upload_sessions_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'COMPLETED'::"text", 'EXPIRED'::"text", 'CANCELED'::"text"])))
);


ALTER TABLE "public"."product_image_upload_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_unit_prices" (
    "id" "text" NOT NULL,
    "product_unit_id" "text" NOT NULL,
    "price_level_id" "text" NOT NULL,
    "shop_id" "text",
    "price_mmk" integer NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "product_unit_prices_price_mmk_check" CHECK (("price_mmk" >= 0))
);


ALTER TABLE "public"."product_unit_prices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_units" (
    "id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "base_quantity" integer NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sale_price_mmk" integer NOT NULL,
    "purchase_price_mmk" integer,
    CONSTRAINT "product_units_base_quantity_check" CHECK (("base_quantity" > 0)),
    CONSTRAINT "product_units_name_not_blank" CHECK (("length"("btrim"("name")) > 0)),
    CONSTRAINT "product_units_purchase_price_nonneg" CHECK ((("purchase_price_mmk" IS NULL) OR ("purchase_price_mmk" >= 0))),
    CONSTRAINT "product_units_sale_price_nonneg" CHECK (("sale_price_mmk" >= 0))
);


ALTER TABLE "public"."product_units" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "text" NOT NULL,
    "sku" "text",
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "unit_type" "text" NOT NULL,
    "price_mmk" integer NOT NULL,
    "cost_mmk" integer,
    "pack_size" integer,
    "low_stock_threshold" integer DEFAULT 0 NOT NULL,
    "expiry_date" "text",
    "image_url" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "brand_id" "text",
    "short_name" "text",
    "alias_code" "text",
    "max_qty" integer,
    "is_open_price" boolean DEFAULT false NOT NULL,
    "is_non_stock" boolean DEFAULT false NOT NULL,
    "purchase_type" "text",
    CONSTRAINT "products_max_qty_check" CHECK ((("max_qty" IS NULL) OR ("max_qty" >= 0))),
    CONSTRAINT "products_name_max_length" CHECK (("length"("name") <= 200)),
    CONSTRAINT "products_purchase_type_check" CHECK ((("purchase_type" IS NULL) OR ("purchase_type" = ANY (ARRAY['COD'::"text", 'CREDIT'::"text"])))),
    CONSTRAINT "products_sku_max_length" CHECK ((("sku" IS NULL) OR ("length"("sku") <= 64)))
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_order_items" (
    "id" "text" NOT NULL,
    "purchase_order_id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "ordered_qty" integer NOT NULL,
    "received_qty" integer,
    "unit_cost_mmk" integer NOT NULL,
    "line_total_mmk" integer NOT NULL,
    "product_unit_id" "text",
    "unit_name_snapshot" "text",
    "unit_base_quantity_snapshot" integer,
    "selected_unit_quantity" integer,
    "unit_purchase_price_snapshot" integer
);


ALTER TABLE "public"."purchase_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_orders" (
    "id" "text" NOT NULL,
    "order_no" "text" NOT NULL,
    "shop_id" "text" NOT NULL,
    "supplier_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "subtotal_mmk" integer NOT NULL,
    "tax_mmk" integer,
    "total_mmk" integer NOT NULL,
    "notes" "text",
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "received_by" "text",
    "received_at" timestamp with time zone,
    "paid_mmk" integer DEFAULT 0 NOT NULL,
    "payment_status" "text" DEFAULT 'UNPAID'::"text" NOT NULL,
    "supplier_invoice_no" "text",
    "delivery_note_no" "text",
    CONSTRAINT "purchase_orders_paid_mmk_nonnegative" CHECK (("paid_mmk" >= 0)),
    CONSTRAINT "purchase_orders_paid_mmk_not_over_total" CHECK (("paid_mmk" <= "total_mmk")),
    CONSTRAINT "purchase_orders_payment_status_chk" CHECK (("payment_status" = ANY (ARRAY['UNPAID'::"text", 'PARTIAL'::"text", 'PAID'::"text"])))
);


ALTER TABLE "public"."purchase_orders" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."rbac_assignment_violations" AS
 SELECT 'multiple_admins'::"text" AS "kind",
    NULL::"text" AS "shop_id",
    "u"."id" AS "user_id",
    "u"."name" AS "user_name",
    "u"."role",
    "u"."is_active"
   FROM "public"."users" "u"
  WHERE (("u"."role" = 'ADMIN'::"text") AND (( SELECT "count"(*) AS "count"
           FROM "public"."users"
          WHERE ("users"."role" = 'ADMIN'::"text")) > 1))
UNION ALL
 SELECT 'shop_with_multiple_active_managers'::"text" AS "kind",
    "u"."shop_id",
    "u"."id" AS "user_id",
    "u"."name" AS "user_name",
    "u"."role",
    "u"."is_active"
   FROM "public"."users" "u"
  WHERE (("u"."role" = 'MANAGER'::"text") AND ("u"."is_active" = true) AND ("u"."shop_id" IN ( SELECT "users"."shop_id"
           FROM "public"."users"
          WHERE (("users"."role" = 'MANAGER'::"text") AND ("users"."is_active" = true) AND ("users"."shop_id" IS NOT NULL))
          GROUP BY "users"."shop_id"
         HAVING ("count"(*) > 1))))
UNION ALL
 SELECT 'active_manager_without_shop'::"text" AS "kind",
    "u"."shop_id",
    "u"."id" AS "user_id",
    "u"."name" AS "user_name",
    "u"."role",
    "u"."is_active"
   FROM "public"."users" "u"
  WHERE (("u"."role" = 'MANAGER'::"text") AND ("u"."is_active" = true) AND ("u"."shop_id" IS NULL))
UNION ALL
 SELECT 'active_cashier_without_shop'::"text" AS "kind",
    "u"."shop_id",
    "u"."id" AS "user_id",
    "u"."name" AS "user_name",
    "u"."role",
    "u"."is_active"
   FROM "public"."users" "u"
  WHERE (("u"."role" = 'CASHIER'::"text") AND ("u"."is_active" = true) AND ("u"."shop_id" IS NULL))
UNION ALL
 SELECT 'active_cashier_without_manager'::"text" AS "kind",
    "u"."shop_id",
    "u"."id" AS "user_id",
    "u"."name" AS "user_name",
    "u"."role",
    "u"."is_active"
   FROM "public"."users" "u"
  WHERE (("u"."role" = 'CASHIER'::"text") AND ("u"."is_active" = true) AND ("u"."shop_id" IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."users" "m"
          WHERE (("m"."role" = 'MANAGER'::"text") AND ("m"."is_active" = true) AND ("m"."shop_id" = "u"."shop_id"))))));


ALTER VIEW "public"."rbac_assignment_violations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."refund_void_requests" (
    "id" "text" NOT NULL,
    "sale_id" "text" NOT NULL,
    "shop_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "items" "jsonb",
    "status" "text" DEFAULT 'REQUESTED'::"text" NOT NULL
);


ALTER TABLE "public"."refund_void_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reprint_logs" (
    "id" "text" NOT NULL,
    "sale_id" "text" NOT NULL,
    "printed_by" "text" NOT NULL,
    "printed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reprint_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sale_items" (
    "sale_id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "qty_units" integer NOT NULL,
    "unit_price_mmk" integer NOT NULL,
    "item_discount_pct" numeric,
    "line_total_mmk" integer NOT NULL,
    "price_overridden_by" "text",
    "unit_label" "text",
    "units_per_item" integer,
    "stock_override_by" "text",
    "id" "text" NOT NULL,
    "product_unit_id" "text",
    "unit_name_snapshot" "text",
    "unit_base_quantity_snapshot" integer,
    "unit_price_mmk_snapshot" integer,
    "base_quantity_sold" integer,
    "price_level_id" "text",
    "price_level_name_snapshot" "text",
    "price_source_snapshot" "text",
    "unit_cost_mmk_snapshot" integer
);


ALTER TABLE "public"."sale_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales" (
    "id" "text" NOT NULL,
    "shop_id" "text" NOT NULL,
    "shift_id" "text" NOT NULL,
    "receipt_no" "text" NOT NULL,
    "cashier_id" "text" NOT NULL,
    "status" "text" DEFAULT 'NORMAL'::"text" NOT NULL,
    "subtotal_mmk" integer NOT NULL,
    "discount_mmk" integer DEFAULT 0 NOT NULL,
    "cart_discount_pct" numeric,
    "total_mmk" integer NOT NULL,
    "payment_method" "text" NOT NULL,
    "paid_mmk" integer NOT NULL,
    "change_mmk" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sales" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shifts" (
    "id" "text" NOT NULL,
    "shop_id" "text" NOT NULL,
    "cashier_id" "text" NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "ended_at" timestamp with time zone,
    "opening_cash_mmk" integer NOT NULL,
    "closing_cash_mmk" integer,
    "expected_cash_mmk" integer,
    "variance_mmk" integer,
    "variance_reason" "text"
);


ALTER TABLE "public"."shifts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shops" (
    "id" "text" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "address" "text" NOT NULL,
    "phone" "text",
    "email" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "org_id" "text" NOT NULL
);


ALTER TABLE "public"."shops" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_transfer_items" (
    "id" "text" NOT NULL,
    "transfer_id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "requested_qty" integer NOT NULL,
    "approved_qty" integer,
    "transferred_qty" integer,
    "product_unit_id" "text",
    "unit_name_snapshot" "text",
    "unit_base_quantity_snapshot" integer,
    "selected_unit_quantity" integer
);


ALTER TABLE "public"."stock_transfer_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_payments" (
    "id" "text" NOT NULL,
    "supplier_id" "text" NOT NULL,
    "purchase_order_id" "text" NOT NULL,
    "shop_id" "text" NOT NULL,
    "amount_mmk" integer NOT NULL,
    "payment_method" "text" NOT NULL,
    "reference_no" "text",
    "notes" "text",
    "paid_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "voided_at" timestamp with time zone,
    "voided_by" "text",
    "void_reason" "text",
    CONSTRAINT "supplier_payments_amount_mmk_check" CHECK (("amount_mmk" > 0)),
    CONSTRAINT "supplier_payments_method_chk" CHECK (("payment_method" = ANY (ARRAY['CASH'::"text", 'BANK'::"text", 'MOBILE'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "public"."supplier_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_products" (
    "supplier_id" "text" NOT NULL,
    "product_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."supplier_products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "text" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "contact_person" "text",
    "phone" "text",
    "email" "text",
    "address" "text",
    "notes" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."unit_types" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "abbreviation" "text",
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "unit_types_abbrev_not_blank" CHECK ((("abbreviation" IS NULL) OR ("length"("btrim"("abbreviation")) > 0))),
    CONSTRAINT "unit_types_name_not_blank" CHECK (("length"("btrim"("name")) > 0))
);


ALTER TABLE "public"."unit_types" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_login_codes"
    ADD CONSTRAINT "admin_login_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."brands"
    ADD CONSTRAINT "brands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_profile"
    ADD CONSTRAINT "business_profile_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_pkey" PRIMARY KEY ("shop_id", "product_id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_auth_id_key" UNIQUE ("auth_id");



ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."price_levels"
    ADD CONSTRAINT "price_levels_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."price_tiers"
    ADD CONSTRAINT "price_tiers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_barcodes"
    ADD CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_image_upload_sessions"
    ADD CONSTRAINT "product_image_upload_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_image_upload_sessions"
    ADD CONSTRAINT "product_image_upload_sessions_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."product_unit_prices"
    ADD CONSTRAINT "product_unit_prices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_units"
    ADD CONSTRAINT "product_units_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."refund_void_requests"
    ADD CONSTRAINT "refund_void_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reprint_logs"
    ADD CONSTRAINT "reprint_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shifts"
    ADD CONSTRAINT "shifts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shops"
    ADD CONSTRAINT "shops_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_transfer_items"
    ADD CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_products"
    ADD CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("supplier_id", "product_id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."unit_types"
    ADD CONSTRAINT "unit_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_auth_id_unique" UNIQUE ("auth_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_one_active_manager_per_shop" EXCLUDE USING "btree" ("shop_id" WITH =) WHERE ((("role" = 'MANAGER'::"text") AND "is_active")) DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE INDEX "admin_login_codes_auth_idx" ON "public"."admin_login_codes" USING "btree" ("auth_id", "created_at" DESC);



CREATE INDEX "brands_category_idx" ON "public"."brands" USING "btree" ("category_id", "is_active");



CREATE UNIQUE INDEX "brands_unique_active_name_per_category" ON "public"."brands" USING "btree" ("category_id", "lower"("btrim"("name"))) WHERE "is_active";



CREATE INDEX "inventory_movements_unit_idx" ON "public"."inventory_movements" USING "btree" ("product_unit_id") WHERE ("product_unit_id" IS NOT NULL);



CREATE UNIQUE INDEX "price_levels_code_normalized" ON "public"."price_levels" USING "btree" ("lower"("btrim"("code")));



CREATE UNIQUE INDEX "price_levels_one_active_default" ON "public"."price_levels" USING "btree" ("is_default") WHERE (("is_default" = true) AND ("is_active" = true));



CREATE INDEX "product_barcodes_product_unit_idx" ON "public"."product_barcodes" USING "btree" ("product_unit_id") WHERE ("product_unit_id" IS NOT NULL);



CREATE UNIQUE INDEX "product_barcodes_unique_normalized_value" ON "public"."product_barcodes" USING "btree" ("lower"("btrim"("value"))) WHERE (NULLIF("btrim"("value"), ''::"text") IS NOT NULL);



CREATE INDEX "product_image_upload_sessions_created_by_idx" ON "public"."product_image_upload_sessions" USING "btree" ("created_by", "created_at" DESC);



CREATE INDEX "product_image_upload_sessions_expires_idx" ON "public"."product_image_upload_sessions" USING "btree" ("status", "expires_at");



CREATE INDEX "product_unit_prices_shop_idx" ON "public"."product_unit_prices" USING "btree" ("shop_id") WHERE ("shop_id" IS NOT NULL);



CREATE UNIQUE INDEX "product_unit_prices_unique_global_active" ON "public"."product_unit_prices" USING "btree" ("product_unit_id", "price_level_id") WHERE (("shop_id" IS NULL) AND ("is_active" = true));



CREATE UNIQUE INDEX "product_unit_prices_unique_shop_active" ON "public"."product_unit_prices" USING "btree" ("product_unit_id", "price_level_id", "shop_id") WHERE (("shop_id" IS NOT NULL) AND ("is_active" = true));



CREATE INDEX "product_unit_prices_unit_idx" ON "public"."product_unit_prices" USING "btree" ("product_unit_id", "is_active");



CREATE UNIQUE INDEX "product_units_one_default" ON "public"."product_units" USING "btree" ("product_id") WHERE "is_default";



CREATE INDEX "product_units_product_idx" ON "public"."product_units" USING "btree" ("product_id", "sort_order");



CREATE UNIQUE INDEX "product_units_unique_active_name" ON "public"."product_units" USING "btree" ("product_id", "lower"("btrim"("name"))) WHERE "is_active";



CREATE INDEX "products_alias_code_idx" ON "public"."products" USING "btree" ("lower"("btrim"("alias_code"))) WHERE (("alias_code" IS NOT NULL) AND ("length"("btrim"("alias_code")) > 0));



CREATE INDEX "products_brand_idx" ON "public"."products" USING "btree" ("brand_id") WHERE ("brand_id" IS NOT NULL);



CREATE INDEX "purchase_order_items_unit_idx" ON "public"."purchase_order_items" USING "btree" ("product_unit_id") WHERE ("product_unit_id" IS NOT NULL);



CREATE INDEX "sale_items_price_level_idx" ON "public"."sale_items" USING "btree" ("price_level_id") WHERE ("price_level_id" IS NOT NULL);



CREATE INDEX "sale_items_sale_product_unit_idx" ON "public"."sale_items" USING "btree" ("sale_id", "product_id", "product_unit_id");



CREATE UNIQUE INDEX "sales_shop_receipt_no_unique" ON "public"."sales" USING "btree" ("shop_id", "receipt_no");



CREATE UNIQUE INDEX "shifts_one_open_per_cashier_shop" ON "public"."shifts" USING "btree" ("cashier_id", "shop_id") WHERE ("ended_at" IS NULL);



CREATE UNIQUE INDEX "shops_unique_normalized_code" ON "public"."shops" USING "btree" ("lower"("btrim"("code"))) WHERE (NULLIF("btrim"("code"), ''::"text") IS NOT NULL);



CREATE UNIQUE INDEX "shops_unique_normalized_name" ON "public"."shops" USING "btree" ("lower"("btrim"("name")));



CREATE INDEX "stock_transfer_items_unit_idx" ON "public"."stock_transfer_items" USING "btree" ("product_unit_id") WHERE ("product_unit_id" IS NOT NULL);



CREATE INDEX "supplier_payments_po_idx" ON "public"."supplier_payments" USING "btree" ("purchase_order_id");



CREATE INDEX "supplier_payments_shop_paid_idx" ON "public"."supplier_payments" USING "btree" ("shop_id", "paid_at" DESC);



CREATE INDEX "supplier_payments_supplier_idx" ON "public"."supplier_payments" USING "btree" ("supplier_id");



CREATE INDEX "supplier_products_product_idx" ON "public"."supplier_products" USING "btree" ("product_id");



CREATE UNIQUE INDEX "suppliers_unique_normalized_code" ON "public"."suppliers" USING "btree" ("lower"("btrim"("code"))) WHERE (NULLIF("btrim"("code"), ''::"text") IS NOT NULL);



CREATE UNIQUE INDEX "unit_types_unique_normalized_abbrev" ON "public"."unit_types" USING "btree" ("lower"("btrim"("abbreviation"))) WHERE (("abbreviation" IS NOT NULL) AND ("length"("btrim"("abbreviation")) > 0));



CREATE UNIQUE INDEX "unit_types_unique_normalized_name" ON "public"."unit_types" USING "btree" ("lower"("btrim"("name")));



CREATE UNIQUE INDEX "users_only_one_admin" ON "public"."users" USING "btree" ("org_id") WHERE ("role" = 'ADMIN'::"text");



CREATE OR REPLACE TRIGGER "brands_touch_updated_at" BEFORE UPDATE ON "public"."brands" FOR EACH ROW EXECUTE FUNCTION "public"."brands_set_updated_at"();



CREATE OR REPLACE TRIGGER "price_levels_touch_updated_at" BEFORE UPDATE ON "public"."price_levels" FOR EACH ROW EXECUTE FUNCTION "public"."price_levels_set_updated_at"();



CREATE OR REPLACE TRIGGER "product_barcodes_unit_product_match" BEFORE INSERT OR UPDATE OF "product_id", "product_unit_id" ON "public"."product_barcodes" FOR EACH ROW EXECUTE FUNCTION "public"."product_barcodes_validate_unit_product"();



CREATE OR REPLACE TRIGGER "product_unit_prices_touch_updated_at" BEFORE UPDATE ON "public"."product_unit_prices" FOR EACH ROW EXECUTE FUNCTION "public"."product_unit_prices_set_updated_at"();



CREATE OR REPLACE TRIGGER "product_units_touch_updated_at" BEFORE UPDATE ON "public"."product_units" FOR EACH ROW EXECUTE FUNCTION "public"."product_units_set_updated_at"();



CREATE OR REPLACE TRIGGER "products_ensure_inventory_rows" AFTER INSERT OR UPDATE OF "is_active" ON "public"."products" FOR EACH ROW WHEN (("new"."is_active" = true)) EXECUTE FUNCTION "public"."ensure_inventory_rows_for_product"();



CREATE OR REPLACE TRIGGER "shops_ensure_inventory_rows" AFTER INSERT OR UPDATE OF "is_active" ON "public"."shops" FOR EACH ROW WHEN (("new"."is_active" = true)) EXECUTE FUNCTION "public"."ensure_inventory_rows_for_shop"();



CREATE OR REPLACE TRIGGER "trg_enforce_user_assignment_rules" BEFORE INSERT OR UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_user_assignment_rules"();



CREATE OR REPLACE TRIGGER "unit_types_touch_updated_at" BEFORE UPDATE ON "public"."unit_types" FOR EACH ROW EXECUTE FUNCTION "public"."unit_types_set_updated_at"();



CREATE OR REPLACE TRIGGER "users_guard_privilege_columns" BEFORE INSERT OR UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."guard_user_privilege_columns"();



ALTER TABLE ONLY "public"."admin_login_codes"
    ADD CONSTRAINT "admin_login_codes_auth_id_fkey" FOREIGN KEY ("auth_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."brands"
    ADD CONSTRAINT "brands_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "public"."product_units"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."inventory"
    ADD CONSTRAINT "inventory_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id");



ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_auth_id_fkey" FOREIGN KEY ("auth_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."price_tiers"
    ADD CONSTRAINT "price_tiers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."price_tiers"
    ADD CONSTRAINT "price_tiers_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id");



ALTER TABLE ONLY "public"."product_barcodes"
    ADD CONSTRAINT "product_barcodes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_barcodes"
    ADD CONSTRAINT "product_barcodes_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "public"."product_units"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."product_image_upload_sessions"
    ADD CONSTRAINT "product_image_upload_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."product_image_upload_sessions"
    ADD CONSTRAINT "product_image_upload_sessions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."product_image_upload_sessions"
    ADD CONSTRAINT "product_image_upload_sessions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id");



ALTER TABLE ONLY "public"."product_unit_prices"
    ADD CONSTRAINT "product_unit_prices_price_level_id_fkey" FOREIGN KEY ("price_level_id") REFERENCES "public"."price_levels"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."product_unit_prices"
    ADD CONSTRAINT "product_unit_prices_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "public"."product_units"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_unit_prices"
    ADD CONSTRAINT "product_unit_prices_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_units"
    ADD CONSTRAINT "product_units_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "public"."product_units"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reprint_logs"
    ADD CONSTRAINT "reprint_logs_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id");



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_price_level_id_fkey" FOREIGN KEY ("price_level_id") REFERENCES "public"."price_levels"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "public"."product_units"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sale_items"
    ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shops"
    ADD CONSTRAINT "shops_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."stock_transfer_items"
    ADD CONSTRAINT "stock_transfer_items_product_unit_id_fkey" FOREIGN KEY ("product_unit_id") REFERENCES "public"."product_units"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."stock_transfer_items"
    ADD CONSTRAINT "stock_transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id");



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id");



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");



ALTER TABLE ONLY "public"."supplier_payments"
    ADD CONSTRAINT "supplier_payments_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."supplier_products"
    ADD CONSTRAINT "supplier_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_products"
    ADD CONSTRAINT "supplier_products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_auth_id_fkey" FOREIGN KEY ("auth_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id");



ALTER TABLE "public"."admin_login_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_logs_sel" ON "public"."audit_logs" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR "public"."app_has_perm"('audit:view_global'::"text") OR ("public"."app_has_perm"('audit:view_shop'::"text") AND ("shop_id" = "public"."app_shop_id"()))));



ALTER TABLE "public"."brands" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "brands_ins" ON "public"."brands" FOR INSERT TO "authenticated" WITH CHECK ("public"."app_has_perm"('product:create'::"text"));



CREATE POLICY "brands_sel" ON "public"."brands" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "brands_upd" ON "public"."brands" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('product:create'::"text")) WITH CHECK ("public"."app_has_perm"('product:create'::"text"));



ALTER TABLE "public"."business_profile" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "business_profile_sel" ON "public"."business_profile" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "business_profile_upd" ON "public"."business_profile" FOR UPDATE TO "authenticated" USING (("public"."app_role"() = 'ADMIN'::"text")) WITH CHECK (("public"."app_role"() = 'ADMIN'::"text"));



ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "categories_ins" ON "public"."categories" FOR INSERT TO "authenticated" WITH CHECK ("public"."app_has_perm"('product:create'::"text"));



CREATE POLICY "categories_sel" ON "public"."categories" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "categories_upd" ON "public"."categories" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('product:create'::"text")) WITH CHECK ("public"."app_has_perm"('product:create'::"text"));



ALTER TABLE "public"."inventory" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_movements_sel" ON "public"."inventory_movements" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR ("public"."app_has_perm"('inventory:view_movements'::"text") AND ("shop_id" = "public"."app_shop_id"()))));



CREATE POLICY "inventory_sel" ON "public"."inventory" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR ("public"."app_has_perm"('inventory:view_stock'::"text") AND ("shop_id" = "public"."app_shop_id"()))));



ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organizations_ins" ON "public"."organizations" FOR INSERT TO "authenticated" WITH CHECK (("public"."app_has_perm"('user:create'::"text") OR (NOT (EXISTS ( SELECT 1
   FROM "public"."users")))));



CREATE POLICY "organizations_sel" ON "public"."organizations" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."platform_admins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."price_levels" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "price_levels_ins" ON "public"."price_levels" FOR INSERT TO "authenticated" WITH CHECK (("public"."app_has_perm"('product:create'::"text") OR "public"."app_has_perm"('pricing:manage'::"text")));



CREATE POLICY "price_levels_sel" ON "public"."price_levels" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "price_levels_upd" ON "public"."price_levels" FOR UPDATE TO "authenticated" USING (("public"."app_has_perm"('product:create'::"text") OR "public"."app_has_perm"('pricing:manage'::"text"))) WITH CHECK (("public"."app_has_perm"('product:create'::"text") OR "public"."app_has_perm"('pricing:manage'::"text")));



ALTER TABLE "public"."price_tiers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "price_tiers_del" ON "public"."price_tiers" FOR DELETE TO "authenticated" USING ("public"."app_has_perm"('pricing:manage'::"text"));



CREATE POLICY "price_tiers_ins" ON "public"."price_tiers" FOR INSERT TO "authenticated" WITH CHECK ("public"."app_has_perm"('pricing:manage'::"text"));



CREATE POLICY "price_tiers_sel" ON "public"."price_tiers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "price_tiers_upd" ON "public"."price_tiers" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('pricing:manage'::"text")) WITH CHECK ("public"."app_has_perm"('pricing:manage'::"text"));



ALTER TABLE "public"."product_barcodes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_barcodes_del" ON "public"."product_barcodes" FOR DELETE TO "authenticated" USING ("public"."app_has_perm"('barcode:manage'::"text"));



CREATE POLICY "product_barcodes_ins" ON "public"."product_barcodes" FOR INSERT TO "authenticated" WITH CHECK ("public"."app_has_perm"('barcode:manage'::"text"));



CREATE POLICY "product_barcodes_sel" ON "public"."product_barcodes" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."product_image_upload_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_image_upload_sessions_owner_select" ON "public"."product_image_upload_sessions" FOR SELECT TO "authenticated" USING (("created_by" = ("public"."current_app_user"())."id"));



ALTER TABLE "public"."product_unit_prices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_unit_prices_ins" ON "public"."product_unit_prices" FOR INSERT TO "authenticated" WITH CHECK (("public"."app_has_perm"('product:create'::"text") OR "public"."app_has_perm"('product:update'::"text") OR "public"."app_has_perm"('pricing:manage'::"text")));



CREATE POLICY "product_unit_prices_sel" ON "public"."product_unit_prices" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "product_unit_prices_upd" ON "public"."product_unit_prices" FOR UPDATE TO "authenticated" USING (("public"."app_has_perm"('product:update'::"text") OR "public"."app_has_perm"('pricing:manage'::"text"))) WITH CHECK (("public"."app_has_perm"('product:update'::"text") OR "public"."app_has_perm"('pricing:manage'::"text")));



ALTER TABLE "public"."product_units" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_units_ins" ON "public"."product_units" FOR INSERT TO "authenticated" WITH CHECK (("public"."app_has_perm"('product:create'::"text") OR "public"."app_has_perm"('product:update'::"text")));



CREATE POLICY "product_units_sel" ON "public"."product_units" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "product_units_upd" ON "public"."product_units" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('product:update'::"text")) WITH CHECK ("public"."app_has_perm"('product:update'::"text"));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "products_ins" ON "public"."products" FOR INSERT TO "authenticated" WITH CHECK ("public"."app_has_perm"('product:create'::"text"));



CREATE POLICY "products_sel" ON "public"."products" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "products_upd" ON "public"."products" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('product:update'::"text")) WITH CHECK ("public"."app_has_perm"('product:update'::"text"));



ALTER TABLE "public"."purchase_order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purchase_order_items_sel" ON "public"."purchase_order_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."purchase_orders" "po"
  WHERE ("po"."id" = "purchase_order_items"."purchase_order_id"))));



ALTER TABLE "public"."purchase_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "purchase_orders_sel" ON "public"."purchase_orders" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR ("public"."app_has_perm"('purchase:view'::"text") AND ("shop_id" = "public"."app_shop_id"()))));



ALTER TABLE "public"."refund_void_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "refund_void_requests_sel" ON "public"."refund_void_requests" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR (("public"."app_has_perm"('pos:refund'::"text") OR "public"."app_has_perm"('pos:void_sale'::"text")) AND ("shop_id" = "public"."app_shop_id"())) OR ("created_by" = "public"."app_user_id"())));



ALTER TABLE "public"."reprint_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reprint_logs_sel" ON "public"."reprint_logs" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."sales" "s"
  WHERE ("s"."id" = "reprint_logs"."sale_id"))) OR ("printed_by" = "public"."app_user_id"())));



ALTER TABLE "public"."sale_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sale_items_sel" ON "public"."sale_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."sales" "s"
  WHERE ("s"."id" = "sale_items"."sale_id"))));



ALTER TABLE "public"."sales" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_sel" ON "public"."sales" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR ("public"."app_has_perm"('sale:view'::"text") AND ("shop_id" = "public"."app_shop_id"())) OR ("public"."app_has_perm"('sales:view_own_shift'::"text") AND (("cashier_id" = "public"."app_user_id"()) OR ("shift_id" IN ( SELECT "s"."id"
   FROM "public"."shifts" "s"
  WHERE ("s"."cashier_id" = "public"."app_user_id"())))))));



ALTER TABLE "public"."shifts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shifts_sel" ON "public"."shifts" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR (("public"."app_has_perm"('shift:manage_all'::"text") OR "public"."app_has_perm"('report:shop_sales'::"text")) AND ("shop_id" = "public"."app_shop_id"())) OR (("public"."app_has_perm"('shift:manage_own'::"text") OR "public"."app_has_perm"('report:own_shift'::"text")) AND ("cashier_id" = "public"."app_user_id"()))));



ALTER TABLE "public"."shops" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shops_ins" ON "public"."shops" FOR INSERT TO "authenticated" WITH CHECK ("public"."app_has_perm"('shop:create'::"text"));



CREATE POLICY "shops_sel" ON "public"."shops" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "shops_upd" ON "public"."shops" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('shop:update'::"text")) WITH CHECK ("public"."app_has_perm"('shop:update'::"text"));



ALTER TABLE "public"."stock_transfer_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stock_transfer_items_sel" ON "public"."stock_transfer_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."stock_transfers" "t"
  WHERE ("t"."id" = "stock_transfer_items"."transfer_id"))));



ALTER TABLE "public"."stock_transfers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "stock_transfers_sel" ON "public"."stock_transfers" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR ("public"."app_has_perm"('transfer:view'::"text") AND (("from_shop_id" = "public"."app_shop_id"()) OR ("to_shop_id" = "public"."app_shop_id"())))));



ALTER TABLE "public"."supplier_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "supplier_payments_sel" ON "public"."supplier_payments" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR (("shop_id" = "public"."app_shop_id"()) AND ("public"."app_has_perm"('supplier:debt_view'::"text") OR "public"."app_has_perm"('purchase:view'::"text")))));



ALTER TABLE "public"."supplier_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "supplier_products_del" ON "public"."supplier_products" FOR DELETE TO "authenticated" USING (("public"."app_has_perm"('product:create'::"text") OR "public"."app_has_perm"('product:update'::"text")));



CREATE POLICY "supplier_products_ins" ON "public"."supplier_products" FOR INSERT TO "authenticated" WITH CHECK (("public"."app_has_perm"('product:create'::"text") OR "public"."app_has_perm"('product:update'::"text")));



CREATE POLICY "supplier_products_sel" ON "public"."supplier_products" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "suppliers_ins" ON "public"."suppliers" FOR INSERT TO "authenticated" WITH CHECK ("public"."app_has_perm"('supplier:create'::"text"));



CREATE POLICY "suppliers_sel" ON "public"."suppliers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "suppliers_upd" ON "public"."suppliers" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('supplier:update'::"text")) WITH CHECK ("public"."app_has_perm"('supplier:update'::"text"));



ALTER TABLE "public"."unit_types" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "unit_types_ins" ON "public"."unit_types" FOR INSERT TO "authenticated" WITH CHECK ("public"."app_has_perm"('product:create'::"text"));



CREATE POLICY "unit_types_sel" ON "public"."unit_types" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "unit_types_upd" ON "public"."unit_types" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('product:create'::"text")) WITH CHECK ("public"."app_has_perm"('product:create'::"text"));



ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_ins" ON "public"."users" FOR INSERT TO "authenticated" WITH CHECK (("public"."app_has_perm"('user:create'::"text") OR (NOT (EXISTS ( SELECT 1
   FROM "public"."users" "users_1")))));



CREATE POLICY "users_sel" ON "public"."users" FOR SELECT TO "authenticated" USING ((("public"."app_role"() = 'ADMIN'::"text") OR ("id" = "public"."app_user_id"()) OR ("role" = 'ADMIN'::"text") OR (("public"."app_shop_id"() IS NOT NULL) AND ("shop_id" = "public"."app_shop_id"()))));



CREATE POLICY "users_upd" ON "public"."users" FOR UPDATE TO "authenticated" USING ("public"."app_has_perm"('user:update'::"text")) WITH CHECK ("public"."app_has_perm"('user:update'::"text"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."inventory";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";














































































































































































REVOKE ALL ON FUNCTION "public"."adjust_stock"("p_shop_id" "text", "p_product_id" "text", "p_adjustment_type" "text", "p_quantity_delta" integer, "p_reason" "text", "p_product_unit_id" "text", "p_unit_qty" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."adjust_stock"("p_shop_id" "text", "p_product_id" "text", "p_adjustment_type" "text", "p_quantity_delta" integer, "p_reason" "text", "p_product_unit_id" "text", "p_unit_qty" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."adjust_stock"("p_shop_id" "text", "p_product_id" "text", "p_adjustment_type" "text", "p_quantity_delta" integer, "p_reason" "text", "p_product_unit_id" "text", "p_unit_qty" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."adjust_stock"("p_shop_id" "text", "p_product_id" "text", "p_adjustment_type" "text", "p_quantity_delta" integer, "p_reason" "text", "p_product_unit_id" "text", "p_unit_qty" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."app_can_for_shop"("p_perm" "text", "p_shop_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."app_can_for_shop"("p_perm" "text", "p_shop_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_can_for_shop"("p_perm" "text", "p_shop_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."app_has_perm"("p_perm" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."app_has_perm"("p_perm" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_has_perm"("p_perm" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."app_org_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_org_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_org_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."app_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."app_shop_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_shop_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_shop_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."app_user_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_user_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_user_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."approve_refund_request"("p_request_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."approve_refund_request"("p_request_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_refund_request"("p_request_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_refund_request"("p_request_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."approve_stock_transfer"("p_transfer_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."approve_stock_transfer"("p_transfer_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_stock_transfer"("p_transfer_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_stock_transfer"("p_transfer_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."approve_void_request"("p_request_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."approve_void_request"("p_request_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_void_request"("p_request_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_void_request"("p_request_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."attach_product_image_upload_session_token"("p_session_id" "text", "p_signed_upload_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attach_product_image_upload_session_token"("p_session_id" "text", "p_signed_upload_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."attach_product_image_upload_session_token"("p_session_id" "text", "p_signed_upload_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."attach_product_image_upload_session_token"("p_session_id" "text", "p_signed_upload_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."brands_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."brands_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."brands_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_product_image_upload_session"("p_session_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_product_image_upload_session"("p_session_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_product_image_upload_session"("p_session_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_product_image_upload_session"("p_session_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_purchase_order"("p_purchase_order_id" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_purchase_order"("p_purchase_order_id" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_purchase_order"("p_purchase_order_id" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_purchase_order"("p_purchase_order_id" "text", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cancel_stock_transfer"("p_transfer_id" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_stock_transfer"("p_transfer_id" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_stock_transfer"("p_transfer_id" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_stock_transfer"("p_transfer_id" "text", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."close_shift"("p_shift_id" "text", "p_closing_cash_mmk" integer, "p_variance_reason" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."close_shift"("p_shift_id" "text", "p_closing_cash_mmk" integer, "p_variance_reason" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."close_shift"("p_shift_id" "text", "p_closing_cash_mmk" integer, "p_variance_reason" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_shift"("p_shift_id" "text", "p_closing_cash_mmk" integer, "p_variance_reason" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_product_image_upload_session"("p_token" "text", "p_storage_path" "text", "p_public_url" "text", "p_bytes" integer, "p_mime_type" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_product_image_upload_session"("p_token" "text", "p_storage_path" "text", "p_public_url" "text", "p_bytes" integer, "p_mime_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."complete_product_image_upload_session"("p_token" "text", "p_storage_path" "text", "p_public_url" "text", "p_bytes" integer, "p_mime_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_product_image_upload_session"("p_token" "text", "p_storage_path" "text", "p_public_url" "text", "p_bytes" integer, "p_mime_type" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_sale"("p_shop_id" "text", "p_shift_id" "text", "p_payment_method" "text", "p_paid_mmk" integer, "p_cart_discount_pct" numeric, "p_items" "jsonb", "p_created_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_sale"("p_shop_id" "text", "p_shift_id" "text", "p_payment_method" "text", "p_paid_mmk" integer, "p_cart_discount_pct" numeric, "p_items" "jsonb", "p_created_at" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."complete_sale"("p_shop_id" "text", "p_shift_id" "text", "p_payment_method" "text", "p_paid_mmk" integer, "p_cart_discount_pct" numeric, "p_items" "jsonb", "p_created_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_sale"("p_shop_id" "text", "p_shift_id" "text", "p_payment_method" "text", "p_paid_mmk" integer, "p_cart_discount_pct" numeric, "p_items" "jsonb", "p_created_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_stock_transfer"("p_transfer_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_stock_transfer"("p_transfer_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."complete_stock_transfer"("p_transfer_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_app_user"("p_id" "text", "p_name" "text", "p_email" "text", "p_role" "text", "p_shop_id" "text", "p_auth_id" "uuid", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_app_user"("p_id" "text", "p_name" "text", "p_email" "text", "p_role" "text", "p_shop_id" "text", "p_auth_id" "uuid", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."create_app_user"("p_id" "text", "p_name" "text", "p_email" "text", "p_role" "text", "p_shop_id" "text", "p_auth_id" "uuid", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_app_user"("p_id" "text", "p_name" "text", "p_email" "text", "p_role" "text", "p_shop_id" "text", "p_auth_id" "uuid", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_product_image_upload_session"("p_shop_id" "text", "p_product_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_product_image_upload_session"("p_shop_id" "text", "p_product_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_product_image_upload_session"("p_shop_id" "text", "p_product_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_product_image_upload_session"("p_shop_id" "text", "p_product_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_purchase_order"("p_shop_id" "text", "p_supplier_id" "text", "p_notes" "text", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_purchase_order"("p_shop_id" "text", "p_supplier_id" "text", "p_notes" "text", "p_items" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."create_purchase_order"("p_shop_id" "text", "p_supplier_id" "text", "p_notes" "text", "p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_purchase_order"("p_shop_id" "text", "p_supplier_id" "text", "p_notes" "text", "p_items" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_refund_void_request"("p_sale_id" "text", "p_type" "text", "p_reason" "text", "p_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_refund_void_request"("p_sale_id" "text", "p_type" "text", "p_reason" "text", "p_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_refund_void_request"("p_sale_id" "text", "p_type" "text", "p_reason" "text", "p_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_refund_void_request"("p_sale_id" "text", "p_type" "text", "p_reason" "text", "p_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_stock_transfer"("p_from_shop_id" "text", "p_to_shop_id" "text", "p_notes" "text", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_stock_transfer"("p_from_shop_id" "text", "p_to_shop_id" "text", "p_notes" "text", "p_items" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."create_stock_transfer"("p_from_shop_id" "text", "p_to_shop_id" "text", "p_notes" "text", "p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_stock_transfer"("p_from_shop_id" "text", "p_to_shop_id" "text", "p_notes" "text", "p_items" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_supplier"("p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_supplier"("p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_supplier"("p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_supplier"("p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON FUNCTION "public"."current_app_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_app_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_app_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."deactivate_app_user"("p_id" "text", "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deactivate_app_user"("p_id" "text", "p_is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."deactivate_app_user"("p_id" "text", "p_is_active" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deactivate_app_user"("p_id" "text", "p_is_active" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_product"("p_product_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_product"("p_product_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_product"("p_product_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_product"("p_product_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."dispatch_stock_transfer"("p_transfer_id" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dispatch_stock_transfer"("p_transfer_id" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."dispatch_stock_transfer"("p_transfer_id" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dispatch_stock_transfer"("p_transfer_id" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_user_assignment_rules"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_user_assignment_rules"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_user_assignment_rules"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_inventory_rows_for_product"() TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_inventory_rows_for_product"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_inventory_rows_for_product"() TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_inventory_rows_for_shop"() TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_inventory_rows_for_shop"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_inventory_rows_for_shop"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_product_image_upload_session_by_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_product_image_upload_session_by_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_product_image_upload_session_by_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_product_image_upload_session_by_token"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_product_image_upload_session_status"("p_session_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_product_image_upload_session_status"("p_session_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_product_image_upload_session_status"("p_session_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_product_image_upload_session_status"("p_session_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_user_privilege_columns"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_user_privilege_columns"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_user_privilege_columns"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_audit_event"("p_action_type" "text", "p_message" "text", "p_entity_type" "text", "p_entity_id" "text", "p_shop_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_audit_event"("p_action_type" "text", "p_message" "text", "p_entity_type" "text", "p_entity_id" "text", "p_shop_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."log_audit_event"("p_action_type" "text", "p_message" "text", "p_entity_type" "text", "p_entity_id" "text", "p_shop_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_audit_event"("p_action_type" "text", "p_message" "text", "p_entity_type" "text", "p_entity_id" "text", "p_shop_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_receipt_reprint"("p_sale_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_receipt_reprint"("p_sale_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."log_receipt_reprint"("p_sale_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_receipt_reprint"("p_sale_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."open_shift"("p_shop_id" "text", "p_opening_cash_mmk" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_shift"("p_shop_id" "text", "p_opening_cash_mmk" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."open_shift"("p_shop_id" "text", "p_opening_cash_mmk" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."open_shift"("p_shop_id" "text", "p_opening_cash_mmk" integer, "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."pay_supplier_lump_sum"("p_supplier_id" "text", "p_shop_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pay_supplier_lump_sum"("p_supplier_id" "text", "p_shop_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."pay_supplier_lump_sum"("p_supplier_id" "text", "p_shop_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pay_supplier_lump_sum"("p_supplier_id" "text", "p_shop_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."price_levels_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."price_levels_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."price_levels_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."product_barcodes_validate_unit_product"() TO "anon";
GRANT ALL ON FUNCTION "public"."product_barcodes_validate_unit_product"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."product_barcodes_validate_unit_product"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."product_image_upload_token_hash"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."product_image_upload_token_hash"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."product_image_upload_token_hash"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."product_image_upload_token_hash"("p_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."product_unit_prices_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."product_unit_prices_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."product_unit_prices_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."product_units_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."product_units_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."product_units_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."receive_purchase_order"("p_purchase_order_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."receive_purchase_order"("p_purchase_order_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."receive_purchase_order"("p_purchase_order_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."receive_purchase_order"("p_purchase_order_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."receive_stock_transfer"("p_transfer_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."receive_stock_transfer"("p_transfer_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."receive_stock_transfer"("p_transfer_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."receive_stock_transfer"("p_transfer_id" "text", "p_received_items" "jsonb", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_supplier_payment"("p_purchase_order_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_supplier_payment"("p_purchase_order_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."record_supplier_payment"("p_purchase_order_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_supplier_payment"("p_purchase_order_id" "text", "p_amount_mmk" integer, "p_payment_method" "text", "p_reference_no" "text", "p_notes" "text", "p_created_at" timestamp with time zone, "p_expected_actor_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_refund_void_request"("p_request_id" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_refund_void_request"("p_request_id" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reject_refund_void_request"("p_request_id" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_refund_void_request"("p_request_id" "text", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reject_stock_transfer"("p_transfer_id" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reject_stock_transfer"("p_transfer_id" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reject_stock_transfer"("p_transfer_id" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_stock_transfer"("p_transfer_id" "text", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_manager"("p_shop_id" "text", "p_new_manager_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_manager"("p_shop_id" "text", "p_new_manager_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."replace_manager"("p_shop_id" "text", "p_new_manager_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_manager"("p_shop_id" "text", "p_new_manager_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_event_time"("p_client_time" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_event_time"("p_client_time" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_event_time"("p_client_time" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."role_default_permissions"("p_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."role_default_permissions"("p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."role_default_permissions"("p_role" "text") TO "service_role";



GRANT ALL ON TABLE "public"."stock_transfers" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."stock_transfers" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_transfers" TO "service_role";



REVOKE ALL ON FUNCTION "public"."transfer_json"("v_t" "public"."stock_transfers") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."transfer_json"("v_t" "public"."stock_transfers") TO "anon";
GRANT ALL ON FUNCTION "public"."transfer_json"("v_t" "public"."stock_transfers") TO "authenticated";
GRANT ALL ON FUNCTION "public"."transfer_json"("v_t" "public"."stock_transfers") TO "service_role";



GRANT ALL ON FUNCTION "public"."unit_types_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."unit_types_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."unit_types_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_app_user"("p_id" "text", "p_name" "text", "p_role" "text", "p_shop_id" "text", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_app_user"("p_id" "text", "p_name" "text", "p_role" "text", "p_shop_id" "text", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."update_app_user"("p_id" "text", "p_name" "text", "p_role" "text", "p_shop_id" "text", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_app_user"("p_id" "text", "p_name" "text", "p_role" "text", "p_shop_id" "text", "p_granted_permissions" "text"[], "p_revoked_permissions" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_supplier"("p_id" "text", "p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text", "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_supplier"("p_id" "text", "p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text", "p_is_active" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."update_supplier"("p_id" "text", "p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text", "p_is_active" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_supplier"("p_id" "text", "p_code" "text", "p_name" "text", "p_contact_person" "text", "p_phone" "text", "p_email" "text", "p_address" "text", "p_notes" "text", "p_is_active" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."void_supplier_payment"("p_payment_id" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."void_supplier_payment"("p_payment_id" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."void_supplier_payment"("p_payment_id" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."void_supplier_payment"("p_payment_id" "text", "p_reason" "text") TO "service_role";
























GRANT ALL ON TABLE "public"."admin_login_codes" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."brands" TO "anon";
GRANT ALL ON TABLE "public"."brands" TO "authenticated";
GRANT ALL ON TABLE "public"."brands" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."business_profile" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE "public"."business_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."business_profile" TO "service_role";



GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";



GRANT ALL ON TABLE "public"."inventory" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."platform_admins" TO "service_role";



GRANT ALL ON TABLE "public"."price_levels" TO "anon";
GRANT ALL ON TABLE "public"."price_levels" TO "authenticated";
GRANT ALL ON TABLE "public"."price_levels" TO "service_role";



GRANT ALL ON TABLE "public"."price_tiers" TO "anon";
GRANT ALL ON TABLE "public"."price_tiers" TO "authenticated";
GRANT ALL ON TABLE "public"."price_tiers" TO "service_role";



GRANT ALL ON TABLE "public"."product_barcodes" TO "anon";
GRANT ALL ON TABLE "public"."product_barcodes" TO "authenticated";
GRANT ALL ON TABLE "public"."product_barcodes" TO "service_role";



GRANT ALL ON TABLE "public"."product_image_upload_sessions" TO "anon";
GRANT ALL ON TABLE "public"."product_image_upload_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."product_image_upload_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."product_unit_prices" TO "anon";
GRANT ALL ON TABLE "public"."product_unit_prices" TO "authenticated";
GRANT ALL ON TABLE "public"."product_unit_prices" TO "service_role";



GRANT ALL ON TABLE "public"."product_units" TO "anon";
GRANT ALL ON TABLE "public"."product_units" TO "authenticated";
GRANT ALL ON TABLE "public"."product_units" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_order_items" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."purchase_order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_order_items" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_orders" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_orders" TO "service_role";



GRANT ALL ON TABLE "public"."rbac_assignment_violations" TO "anon";
GRANT ALL ON TABLE "public"."rbac_assignment_violations" TO "authenticated";
GRANT ALL ON TABLE "public"."rbac_assignment_violations" TO "service_role";



GRANT ALL ON TABLE "public"."refund_void_requests" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."refund_void_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."refund_void_requests" TO "service_role";



GRANT ALL ON TABLE "public"."reprint_logs" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."reprint_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."reprint_logs" TO "service_role";



GRANT ALL ON TABLE "public"."sale_items" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sale_items" TO "authenticated";
GRANT ALL ON TABLE "public"."sale_items" TO "service_role";



GRANT ALL ON TABLE "public"."sales" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sales" TO "authenticated";
GRANT ALL ON TABLE "public"."sales" TO "service_role";



GRANT ALL ON TABLE "public"."shifts" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."shifts" TO "authenticated";
GRANT ALL ON TABLE "public"."shifts" TO "service_role";



GRANT ALL ON TABLE "public"."shops" TO "anon";
GRANT ALL ON TABLE "public"."shops" TO "authenticated";
GRANT ALL ON TABLE "public"."shops" TO "service_role";



GRANT ALL ON TABLE "public"."stock_transfer_items" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."stock_transfer_items" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_transfer_items" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_payments" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."supplier_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_payments" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_products" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."supplier_products" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_products" TO "service_role";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."suppliers" TO "service_role";



GRANT ALL ON TABLE "public"."unit_types" TO "anon";
GRANT ALL ON TABLE "public"."unit_types" TO "authenticated";
GRANT ALL ON TABLE "public"."unit_types" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































