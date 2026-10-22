-- ============================================================
-- PROVISIONAL migration PDISC-A: discount authorization at the database boundary (no number assigned)
--
-- OWNER DECISION (Step 6 finalization, 2026-10-22)
--   - A cashier never applies a discretionary discount on their own.
--   - A manager or an organization admin may apply up to AND INCLUDING 5% on their own.
--   - Anything else (a cashier's discount of any size; more than 5% for anyone) needs a separate approval, recorded in
--     fin_approvals (kind DISCOUNT): requested by the seller, decided by another person — a Shop Admin of the shop (see
--     PFIN-F: fin:approve_exception for the shop, or an organization ADMIN); for a cashier's discount of 5% or less a
--     manager of the shop may decide too. No self-approval (table CHECK + decision function).
--   - The approval records amount, percentage, reference price (subtotal before discounts), reason, requester, approver
--     and time; it is bound to ONE sale (single use), to the seller, the shop, the exact reference subtotal and a maximum
--     discount, and expires 30 minutes after it was approved. The till names it in the request header
--     x-orvix-discount-approval; the server validates everything (no frontend state is trusted).
--   - Approval-required discounts never take effect OFFLINE (x-orvix-offline marker): refused, nothing saved.
-- WHAT COUNTS (cumulative, per sale): line discounts + cart discount (sales.discount_mmk = subtotal - total) PLUS any
--   manual price override BELOW the reference unit price (shop price for the level, else the global price, else the
--   unit's own price, with the quantity tier exactly as complete_sale applies it). Effective % = (discount + override
--   reduction) / (subtotal + override reduction). Several small discounts on one sale add up; they cannot pass the 5% line
--   one by one. A single layer the seller entered at <= 5% (a cart discount alone, or line discounts each <= 5% with no cart
--   discount, and no override) is within the 5% even when whole-MMK rounding makes it a few MMK more.
-- NOT DISCRETIONARY (verifiable server-resolved sources, unchanged): price levels, shop/global unit prices, quantity
--   tiers, open-price items (an open price has no reference). There is no promotions table in this schema.
-- ENFORCED ON EVERY PATH: ONE deferred constraint trigger on sales checks the complete sale at commit (every line,
--   the cart discount and every manual override known), so complete_sale direct, op_execute, op_execute_v87, fin_complete_sale_split and old clients are all covered (the
--   pinned complete_sale body is untouched). A superuser session WITHOUT a signed-in user (fixtures, maintenance) is not
--   a client path and is not checked.
-- DEPENDS ON PFIN-F (fin_approvals). Refuses after Recovery V1. ROLLBACK: PDISC-A.rollback.sql.
-- ============================================================

SET lock_timeout = '3s';

DO $pdisc_a_pre$
DECLARE v_path text := current_setting('search_path');
BEGIN
  IF to_regclass('public.fin_approvals') IS NULL THEN RAISE EXCEPTION 'PDISC-A: apply PFIN-F first'; END IF;
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN
    RAISE EXCEPTION 'PDISC-A: Recovery V1 is installed; schema changes after V1 need an owner-authorized migration';
  END IF;
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PDISC-A: migration 087 is installed: run as the superuser migration runner';
    END IF;
    IF EXISTS (SELECT 1 FROM recovery_guard.snapshot g
                WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = g.relid)
                   OR g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))
       OR EXISTS (SELECT 1 FROM recovery_guard.functions f
                   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f.fnid AND p.oid::regprocedure::text = f.fn
                                       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')))
       OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                    AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%')
                    AND p.oid NOT IN (SELECT fnid FROM recovery_guard.functions)) THEN
      RAISE EXCEPTION 'PDISC-A: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
    PERFORM set_config('search_path', v_path, true);
  END IF;
END $pdisc_a_pre$;

-- the unit price complete_sale (072) would have resolved for a line before a manual override: the shop price for the line's
-- (resolved) price level, else the global price, else the unit's own price; and, exactly like 072, the quantity tier for
-- the sold base quantity when the unit is the product's default unit and the level is the organization's default level
DROP FUNCTION IF EXISTS public.fin_reference_unit_price(text, text, text);
CREATE OR REPLACE FUNCTION public.fin_reference_unit_price(p_shop_id text, p_product_id text, p_unit_id text, p_level_id text, p_base_qty bigint)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (SELECT * FROM product_units WHERE id = p_unit_id),
  lvl AS (SELECT pl.id FROM price_levels pl JOIN shops s ON s.org_id = pl.org_id
           WHERE s.id = p_shop_id AND pl.is_default AND pl.is_active LIMIT 1),
  expected AS (SELECT coalesce(
    (SELECT price_mmk FROM product_unit_prices WHERE product_unit_id = p_unit_id AND price_level_id = p_level_id AND shop_id = p_shop_id AND is_active LIMIT 1),
    (SELECT price_mmk FROM product_unit_prices WHERE product_unit_id = p_unit_id AND price_level_id = p_level_id AND shop_id IS NULL AND is_active LIMIT 1),
    (SELECT sale_price_mmk FROM u)) AS v),
  tier AS (SELECT pt.price_mmk AS v FROM price_tiers pt
            WHERE pt.product_id = p_product_id AND pt.is_active AND (pt.shop_id = p_shop_id OR pt.shop_id IS NULL)
              AND p_base_qty >= pt.min_qty AND (pt.max_qty IS NULL OR p_base_qty <= pt.max_qty)
            ORDER BY CASE WHEN pt.shop_id = p_shop_id THEN 0 ELSE 1 END, pt.min_qty DESC LIMIT 1)
  SELECT CASE WHEN (SELECT is_default FROM u) AND p_level_id IS NOT DISTINCT FROM (SELECT id FROM lvl)
              THEN coalesce((SELECT v FROM tier), (SELECT v FROM expected)) ELSE (SELECT v FROM expected) END $$;

-- the seller holds a permission (role defaults + granted - revoked), read from the seller's own row
CREATE OR REPLACE FUNCTION public.fin_user_has_perm(p_user public.users, p_perm text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(p_user.is_active, false)
     AND p_perm = ANY (role_default_permissions(p_user.role) || coalesce(p_user.granted_permissions, ARRAY[]::text[]))
     AND NOT p_perm = ANY (coalesce(p_user.revoked_permissions, ARRAY[]::text[])) $$;

-- authorize the discount of one COMPLETE sale (every line written): p_reduction = manual-override reduction below the
-- reference prices (MMK); p_single_layer = the sale has exactly one discount layer of at most 5% (a cart discount <= 5%
-- with no line discount, or line discounts each <= 5% with no cart discount) and no override reduction: the owner's
-- "up to and including 5%" as the seller entered it, whatever whole-MMK rounding the server applied
DROP FUNCTION IF EXISTS public.fin_discount_authorize(public.sales, bigint);
CREATE OR REPLACE FUNCTION public.fin_discount_authorize(p_sale public.sales, p_reduction bigint, p_single_layer boolean)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ref bigint := p_sale.subtotal_mmk::bigint + greatest(p_reduction, 0); v_disc bigint := p_sale.discount_mmk::bigint + greatest(p_reduction, 0);
        v_seller users; v_aid text; a fin_approvals; v_org text; v_pct text;
BEGIN
  IF v_disc <= 0 THEN RETURN; END IF;
  v_pct := to_char(round(v_disc::numeric * 100 / nullif(v_ref, 0), 2), 'FM990.00') || '%';
  SELECT * INTO v_seller FROM users WHERE id = p_sale.cashier_id;
  -- a manager or an organization admin: up to and including 5% on their own
  IF upper(coalesce(v_seller.role, '')) IN ('MANAGER', 'ADMIN') AND public.fin_user_has_perm(v_seller, 'pos:apply_discount')
     AND (v_disc * 100 <= v_ref * 5 OR p_single_layer) THEN
    RETURN;
  END IF;
  IF public.fin_request_offline() THEN
    RAISE EXCEPTION 'DISCOUNT_APPROVAL_OFFLINE: a discount that needs approval (% MMK, %) cannot be given offline; nothing was saved', v_disc, v_pct;
  END IF;
  BEGIN v_aid := nullif(btrim(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-orvix-discount-approval'), '');
  EXCEPTION WHEN OTHERS THEN v_aid := NULL; END;
  IF v_aid IS NULL THEN
    RAISE EXCEPTION 'DISCOUNT_APPROVAL_REQUIRED: this discount (% MMK, % of %) needs a separate approval%', v_disc, v_pct, v_ref,
      CASE WHEN v_disc * 100 > v_ref * 5 THEN ' by a Shop Admin' ELSE '' END;
  END IF;
  SELECT org_id INTO v_org FROM shops WHERE id = p_sale.shop_id;
  SELECT * INTO a FROM fin_approvals WHERE id = v_aid FOR UPDATE;
  IF a.id IS NULL OR a.kind <> 'DISCOUNT' OR a.org_id IS DISTINCT FROM v_org OR a.shop_id IS DISTINCT FROM p_sale.shop_id THEN
    RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: the named approval is not a discount approval of this shop';
  END IF;
  IF a.status <> 'APPROVED' THEN RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: the discount request is % (not approved)', lower(a.status); END IF;
  IF a.requested_by IS DISTINCT FROM p_sale.cashier_id THEN RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: the approval was requested by another seller'; END IF;
  IF a.decided_by IS NULL OR a.decided_by = p_sale.cashier_id THEN RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: no independent approver'; END IF;
  IF a.consumed_sale_id IS NOT NULL THEN RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: the approval was already used for another sale'; END IF;
  IF a.expires_at IS NULL OR a.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: the approval expired; request it again'; END IF;
  IF v_ref <> (a.details->>'referenceSubtotalMmk')::bigint THEN
    RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: the approval is for a cart of % MMK, this sale is % MMK before discounts', (a.details->>'referenceSubtotalMmk'), v_ref;
  END IF;
  IF v_disc > (a.details->>'discountMmk')::bigint THEN
    RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: the approval covers % MMK of discount, this sale gives % MMK', (a.details->>'discountMmk'), v_disc;
  END IF;
  UPDATE fin_approvals SET consumed_sale_id = p_sale.id, consumed_at = clock_timestamp() WHERE id = a.id;
END $$;

-- ONE check per sale, after every line is written (a deferred constraint trigger: line discounts, the cart discount and
-- every manual override are known; the order of the lines cannot matter). A refusal rolls the whole sale back.
CREATE OR REPLACE FUNCTION public.fin_discount_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_sale sales; v_red bigint; v_lines_disc boolean; v_lines_ok boolean; v_cart numeric; v_single boolean;
BEGIN
  IF auth.uid() IS NULL AND (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN RETURN NULL; END IF;
  SELECT * INTO v_sale FROM sales WHERE id = NEW.id;
  IF v_sale.id IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(sum(greatest(0, public.fin_reference_unit_price(v_sale.shop_id, si.product_id, si.product_unit_id, si.price_level_id, si.qty_units::bigint)
                                    - si.unit_price_mmk)::bigint
                      * (si.qty_units / greatest(coalesce(si.unit_base_quantity_snapshot, 1), 1))) FILTER (WHERE si.price_source_snapshot = 'manual_override'), 0),
         coalesce(bool_or(coalesce(si.item_discount_pct, 0) > 0), false),
         coalesce(bool_and(coalesce(si.item_discount_pct, 0) <= 5), true)
    INTO v_red, v_lines_disc, v_lines_ok FROM sale_items si WHERE si.sale_id = v_sale.id;
  v_cart := coalesce(v_sale.cart_discount_pct, 0);
  v_single := v_red = 0 AND ((v_cart <= 5 AND NOT v_lines_disc) OR (v_cart = 0 AND v_lines_ok));
  PERFORM public.fin_discount_authorize(v_sale, v_red, v_single);
  RETURN NULL;
END $$;

ALTER FUNCTION public.fin_reference_unit_price(text, text, text, text, bigint) OWNER TO postgres;
ALTER FUNCTION public.fin_user_has_perm(public.users, text) OWNER TO postgres;
ALTER FUNCTION public.fin_discount_authorize(public.sales, bigint, boolean) OWNER TO postgres;
ALTER FUNCTION public.fin_discount_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_reference_unit_price(text, text, text, text, bigint), public.fin_user_has_perm(public.users, text),
  public.fin_discount_authorize(public.sales, bigint, boolean), public.fin_discount_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS zzd_discount_guard ON public.sales;
DROP TRIGGER IF EXISTS zzd_discount_guard ON public.sale_items;
CREATE CONSTRAINT TRIGGER zzd_discount_guard AFTER INSERT ON public.sales DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fin_discount_guard();

-- a seller asks for a discount approval for the cart they are ringing up (reference subtotal and discount in MMK)
CREATE OR REPLACE FUNCTION public.fin_request_discount_approval(p_shop_id text, p_reference_subtotal_mmk integer, p_discount_mmk integer,
  p_reason text, p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user users; a fin_approvals; v_now timestamptz := clock_timestamp(); v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL OR NOT v_user.is_active THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF public.fin_request_offline() THEN RAISE EXCEPTION 'DISCOUNT_APPROVAL_OFFLINE: discount approvals are requested online only'; END IF;
  SELECT * INTO a FROM fin_approvals WHERE org_id = v_user.org_id AND request_key = p_key;
  IF a.id IS NOT NULL THEN
    IF a.requested_by <> v_user.id OR a.shop_id IS DISTINCT FROM p_shop_id
       OR (a.details->>'referenceSubtotalMmk')::bigint IS DISTINCT FROM p_reference_subtotal_mmk::bigint
       OR (a.details->>'discountMmk')::bigint IS DISTINCT FROM p_discount_mmk::bigint THEN
      RAISE EXCEPTION 'DISCOUNT_APPROVAL_KEY_REUSED: this key named another discount request';
    END IF;
    RETURN jsonb_build_object('approval', public.fin_approval_json(a), 'replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shops s WHERE s.id = p_shop_id AND s.org_id = v_user.org_id) OR NOT app_can_for_shop('pos:create_sale', p_shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to sell in this shop';
  END IF;
  IF p_reference_subtotal_mmk IS NULL OR p_discount_mmk IS NULL OR p_reference_subtotal_mmk <= 0 OR p_discount_mmk <= 0
     OR p_discount_mmk > p_reference_subtotal_mmk OR p_reference_subtotal_mmk > 2000000000 THEN
    RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: a discount request needs a cart amount and a discount between 1 MMK and the cart amount';
  END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'DISCOUNT_APPROVAL_INVALID: the reason must be 3 to 300 characters'; END IF;
  INSERT INTO fin_approvals (id, org_id, shop_id, kind, subject_id, details, reason, requested_by, requested_at, request_key)
  VALUES ('fa-' || replace(gen_random_uuid()::text, '-', ''), v_user.org_id, p_shop_id, 'DISCOUNT', NULL,
          jsonb_build_object('referenceSubtotalMmk', p_reference_subtotal_mmk, 'discountMmk', p_discount_mmk,
                             'pct', round(p_discount_mmk::numeric * 100 / p_reference_subtotal_mmk, 4),
                             'needsShopAdmin', p_discount_mmk::bigint * 100 > p_reference_subtotal_mmk::bigint * 5),
          v_reason, v_user.id, v_now, p_key)
  RETURNING * INTO a;
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES ('audit-' || replace(gen_random_uuid()::text, '-', ''), p_shop_id, v_user.id, 'FIN_APPROVAL_REQUESTED',
          'DISCOUNT ' || p_discount_mmk || ' MMK of ' || p_reference_subtotal_mmk || ' MMK: ' || left(v_reason, 200), 'FinApproval', a.id, v_now);
  RETURN jsonb_build_object('approval', public.fin_approval_json(a), 'replayed', false);
END $$;
ALTER FUNCTION public.fin_request_discount_approval(text, integer, integer, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_request_discount_approval(text, integer, integer, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_request_discount_approval(text, integer, integer, text, uuid) TO authenticated;

DO $pdisc_a_post$
BEGIN
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF;
END $pdisc_a_post$;
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
