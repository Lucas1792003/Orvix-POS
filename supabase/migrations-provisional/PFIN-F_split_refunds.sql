-- ============================================================
-- PROVISIONAL migration PFIN-F: split-payment refunds, original-method attribution, exception approvals,
-- non-cash payout confirmation, drawer and change safeguards (no number assigned)
--
-- OWNER DECISIONS IMPLEMENTED (Step 6 finalization, 2026-10-22)
--   D1 a refund of a sale paid by several methods is paid back by the ORIGINAL methods by default. The default split of a
--      refund of X MMK is deterministic: the cumulative refunded amount after X is shared in proportion to what each
--      method paid (floor), minus what that method already got back, within what it has left; the rounding leftover goes
--      to the methods with the largest remainders (then method name). A full refund therefore returns exactly what is
--      left per method. Never more than what is left of the originally paid amount (total and per method).
--   D1 a non-cash payout (bank transfer, wallet, card, other) is NOT paid out until a confirmation is recorded
--      (refund_payout_confirmations); only cash payouts move the drawer (PFIN-D fin_shift_cash).
--   D2 a payout by a different method than the default ("alternative payout") is prepared by a manager (pos:refund) and
--      needs a SEPARATE approval by a Shop Admin of the shop who is not the requester, before the refund can be approved.
--      The approval records the original allocation, the proposed payout, requester, approver, reason and time; the
--      refund's ATTRIBUTION to the original methods (what caps later refunds) stays the original allocation.
--   D3 P-2: the default refund amount of a sale line is the actual paid price per unit after every discount (PFIN-B
--      fin_sale_line_net, the client's refundMath rounding); any other amount is a manager-adjusted price that needs a
--      separate Shop Admin approval. No cash refund may take the shift's expected cash below zero (f125). No change is
--      ever given from a non-cash payment (f10). Refund and void requests are refused when recorded offline.
--   SHOP ADMIN (interpretation, owner to confirm): a user holding the permission fin:approve_exception for the shop
--      (granted per user, e.g. to a shop's manager; an organization ADMIN holds it by default). Always another person
--      than the requester.
--
-- WHY ADDITIVE: create_refund_void_request / approve_refund_request / complete_sale stay pinned (086 MD5); everything
--   is enforced by triggers on refund_void_requests and sales, and new tables and RPCs. Replaced here (pre-V1 only):
--   fin_refund_prior_methods (attribution of approved alternative payouts) and fin_refund_caps_problem (per-method caps
--   on the attribution, not on the alternative payout). Same signatures and result shapes.
-- DEPENDS ON PFIN-E (refund_lines / refund_payouts) and PFIN-D. Refuses after Recovery V1 (owner-authorized migrations
--   only add). ROLLBACK: PFIN-F.rollback.sql (refuses while any approval or confirmation exists).
-- ============================================================

SET lock_timeout = '3s';

DO $pfin_f_pre$
DECLARE v_path text := current_setting('search_path');
BEGIN
  IF to_regclass('public.refund_payouts') IS NULL OR to_regprocedure('public.fin_refund_caps_problem(text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PFIN-F: apply PFIN-E first';
  END IF;
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN
    RAISE EXCEPTION 'PFIN-F: Recovery V1 is installed; schema changes after V1 need an owner-authorized migration';
  END IF;
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PFIN-F: migration 087 is installed: run as the superuser migration runner';
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
      RAISE EXCEPTION 'PFIN-F: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
    PERFORM set_config('search_path', v_path, true);
  END IF;
END $pfin_f_pre$;

-- ------------------------------------------------------------ 1. exception approvals (refunds here; discounts: PDISC-A)
CREATE TABLE IF NOT EXISTS public.fin_approvals (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  shop_id          text NOT NULL REFERENCES public.shops(id),
  kind             text NOT NULL CHECK (kind IN ('DISCOUNT', 'REFUND_ALT_PAYOUT', 'REFUND_PRICE_ADJUST')),
  subject_id       text REFERENCES public.refund_void_requests(id),     -- the refund request (NULL for a discount)
  details          jsonb NOT NULL,
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  requested_by     text NOT NULL,
  requested_at     timestamptz NOT NULL,
  request_key      uuid,
  status           text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
  decided_by       text,
  decided_at       timestamptz,
  decision_reason  text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 3 AND 300),
  decide_key       uuid,
  expires_at       timestamptz,
  consumed_sale_id text UNIQUE,
  consumed_at      timestamptz,
  CHECK ((kind = 'DISCOUNT') = (subject_id IS NULL)),
  CHECK ((status = 'REQUESTED') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),                -- never self-approved
  CHECK (consumed_sale_id IS NULL OR (kind = 'DISCOUNT' AND status = 'APPROVED')),
  CHECK ((consumed_sale_id IS NULL) = (consumed_at IS NULL)),
  UNIQUE (org_id, request_key),
  UNIQUE (subject_id, kind)
);
CREATE INDEX IF NOT EXISTS fin_approvals_shop_status_idx ON public.fin_approvals (shop_id, status, requested_at);
ALTER TABLE public.fin_approvals OWNER TO postgres;
ALTER TABLE public.fin_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fin_approvals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.fin_approvals TO authenticated, service_role;
DROP POLICY IF EXISTS fin_approvals_sel ON public.fin_approvals;
-- the requester sees their own; approvers (approval:view) see their shop's (an ADMIN every shop of the org) (review 2, L4)
CREATE POLICY fin_approvals_sel ON public.fin_approvals FOR SELECT TO authenticated
  USING (org_id = public.app_org_id()
         AND (requested_by = (public.current_app_user()).id
              OR (public.app_has_perm('approval:view') AND (public.app_role() = 'ADMIN' OR shop_id = public.app_shop_id()))));

-- written only by the definer functions below; a decision or a consumption happens once and is never changed
CREATE OR REPLACE FUNCTION public.fin_approvals_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FIN_RECORD_IMMUTABLE: approvals are never deleted' USING ERRCODE = '42501'; END IF;
  IF (NEW.id, NEW.org_id, NEW.shop_id, NEW.kind, NEW.subject_id, NEW.details, NEW.reason, NEW.requested_by, NEW.requested_at, NEW.request_key)
     IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.shop_id, OLD.kind, OLD.subject_id, OLD.details, OLD.reason, OLD.requested_by, OLD.requested_at, OLD.request_key) THEN
    RAISE EXCEPTION 'FIN_RECORD_IMMUTABLE: an approval request is never changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'REQUESTED' AND (NEW.status, NEW.decided_by, NEW.decided_at, NEW.decision_reason, NEW.decide_key, NEW.expires_at)
     IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decided_at, OLD.decision_reason, OLD.decide_key, OLD.expires_at) THEN
    RAISE EXCEPTION 'FIN_RECORD_IMMUTABLE: an approval decision is never changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.consumed_sale_id IS NOT NULL AND (NEW.consumed_sale_id, NEW.consumed_at) IS DISTINCT FROM (OLD.consumed_sale_id, OLD.consumed_at) THEN
    RAISE EXCEPTION 'FIN_RECORD_IMMUTABLE: an approval is used once' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.fin_approvals_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_approvals_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS zzf_approvals_guard ON public.fin_approvals;
CREATE TRIGGER zzf_approvals_guard BEFORE UPDATE OR DELETE ON public.fin_approvals FOR EACH ROW EXECUTE FUNCTION public.fin_approvals_guard();
DROP TRIGGER IF EXISTS zzf_approvals_truncate ON public.fin_approvals;
CREATE TRIGGER zzf_approvals_truncate BEFORE TRUNCATE ON public.fin_approvals FOR EACH STATEMENT EXECUTE FUNCTION public.fin_immutable();

-- ------------------------------------------------------------ 2. helpers
-- recorded OFFLINE: the till sent its offline marker (Recovery V1 x-orvix-offline). Unreadable headers count as offline.
CREATE OR REPLACE FUNCTION public.fin_request_offline()
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE h jsonb;
BEGIN
  BEGIN h := nullif(current_setting('request.headers', true), '')::jsonb -> 'x-orvix-offline';
  EXCEPTION WHEN OTHERS THEN RETURN true; END;
  RETURN h IS NOT NULL AND jsonb_typeof(h) <> 'null';
END $$;
ALTER FUNCTION public.fin_request_offline() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_request_offline() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_request_offline() TO authenticated, service_role;

-- Shop Admin = the permission fin:approve_exception, for a shop the user may act for (app_can_for_shop: a shop-bound user
-- only its own shop, an organization ADMIN every shop of its org). ADMIN holds it by default (role_default_permissions
-- below, migration 057's list + this one permission; the client's DEFAULT_ROLE_PERMISSIONS changes with it); it can be
-- granted to a shop's manager, and revoked from an admin, per user (users.granted_permissions / revoked_permissions).
CREATE OR REPLACE FUNCTION public.role_default_permissions(p_role text)
RETURNS text[]
LANGUAGE sql IMMUTABLE
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
      'audit:view_shop','audit:view_global',
      'fin:approve_exception'
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

-- the CURRENT user is a Shop Admin of p_shop_id, in its org
CREATE OR REPLACE FUNCTION public.fin_is_shop_admin(p_shop_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM shops s WHERE s.id = p_shop_id AND s.org_id = app_org_id())
     AND app_can_for_shop('fin:approve_exception', p_shop_id);
$$;
ALTER FUNCTION public.fin_is_shop_admin(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_is_shop_admin(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_is_shop_admin(text) TO authenticated, service_role;

-- What every OTHER approved refund of the sale took, per ORIGINAL payment method (its attribution):
--   a refund paid by an approved alternative payout: the original allocation recorded with that approval;
--   otherwise its payouts; a legacy item (no payouts) as paid back by the sale's own legacy method (CASH / OTHER).
CREATE OR REPLACE FUNCTION public.fin_refund_prior_methods(p_sale_id text, p_request_id text)
RETURNS TABLE (method text, a bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH r AS (
    SELECT r.id, r.items, s.payment_method,
           (SELECT f.details FROM fin_approvals f WHERE f.subject_id = r.id AND f.kind = 'REFUND_ALT_PAYOUT' AND f.status = 'APPROVED') AS alt
      FROM refund_void_requests r JOIN sales s ON s.id = r.sale_id
     WHERE r.sale_id = p_sale_id AND r.id IS DISTINCT FROM p_request_id AND r.type = 'PARTIAL' AND r.status = 'APPROVED')
  SELECT x.method, sum(x.a)::bigint FROM (
    SELECT o->>'method' AS method, (o->>'amountMmk')::bigint AS a
      FROM r CROSS JOIN LATERAL jsonb_array_elements(r.alt->'original') o WHERE r.alt IS NOT NULL
    UNION ALL
    SELECT po->>'method', (po->>'amountMmk')::bigint
      FROM r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) it
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN it ? 'payouts' THEN it->'payouts' ELSE '[]'::jsonb END) po
     WHERE r.alt IS NULL
    UNION ALL
    SELECT CASE WHEN r.payment_method = 'CASH' THEN 'CASH' ELSE 'OTHER' END, (coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint
      FROM r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) it
     WHERE r.alt IS NULL AND jsonb_typeof(it) = 'object' AND NOT it ? 'payouts') x
   GROUP BY 1 $$;

-- D1: the default payout of a refund of p_amount MMK by the original methods (NULL: more than what is left)
CREATE OR REPLACE FUNCTION public.fin_refund_default_payouts(p_sale_id text, p_request_id text, p_amount bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_total bigint; v_prior bigint; v_target bigint; v_rows jsonb; v_left bigint; e jsonb; v_out jsonb := '{}'; v_give bigint;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(sum(amount_mmk), 0) INTO v_total FROM sale_payments WHERE sale_id = p_sale_id;
  IF v_total = 0 THEN RETURN NULL; END IF;
  SELECT coalesce(sum(a), 0) INTO v_prior FROM fin_refund_prior_methods(p_sale_id, p_request_id);
  v_target := v_prior + p_amount;
  IF v_target > v_total THEN RETURN NULL; END IF;
  WITH paid AS (SELECT p.method, sum(p.amount_mmk)::bigint AS a FROM sale_payments p WHERE p.sale_id = p_sale_id GROUP BY 1),
       prior AS (SELECT pm.method, pm.a FROM fin_refund_prior_methods(p_sale_id, p_request_id) pm)
  SELECT jsonb_agg(jsonb_build_object('m', z.method, 'cap', z.cap, 'base', z.base, 'rem', z.rem) ORDER BY z.rem DESC, z.method)
    INTO v_rows
    FROM (SELECT p.method, greatest(p.a - coalesce(pr.a, 0), 0) AS cap,
                 greatest(0, least(p.a - coalesce(pr.a, 0), div(p.a::numeric * v_target, v_total)::bigint - coalesce(pr.a, 0))) AS base,
                 mod(p.a::numeric * v_target, v_total) AS rem
            FROM paid p LEFT JOIN prior pr ON pr.method = p.method) z;
  v_left := p_amount - (SELECT coalesce(sum((x->>'base')::bigint), 0) FROM jsonb_array_elements(v_rows) x);
  FOR e IN SELECT value FROM jsonb_array_elements(v_rows) LOOP v_out := v_out || jsonb_build_object(e->>'m', (e->>'base')::bigint); END LOOP;
  -- short (rounding): add to the largest remainders first (then method name), within what each method has left
  FOR e IN SELECT value FROM jsonb_array_elements(v_rows) x ORDER BY (x->>'rem')::numeric DESC, x->>'m' LOOP
    EXIT WHEN v_left <= 0;
    v_give := least(v_left, (e->>'cap')::bigint - (v_out->>(e->>'m'))::bigint);
    v_out := v_out || jsonb_build_object(e->>'m', (v_out->>(e->>'m'))::bigint + v_give);
    v_left := v_left - v_give;
  END LOOP;
  -- over (several methods already got back more than their proportional share, so their floors were raised to 0):
  -- take the excess back from the smallest remainders first (then method name), never below 0 (review 1, F1)
  FOR e IN SELECT value FROM jsonb_array_elements(v_rows) x ORDER BY (x->>'rem')::numeric ASC, x->>'m' LOOP
    EXIT WHEN v_left >= 0;
    v_give := least(-v_left, (v_out->>(e->>'m'))::bigint);
    v_out := v_out || jsonb_build_object(e->>'m', (v_out->>(e->>'m'))::bigint - v_give);
    v_left := v_left + v_give;
  END LOOP;
  IF v_left <> 0 THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('method', k, 'amountMmk', (v_out->>k)::bigint) ORDER BY k)
                     FROM jsonb_object_keys(v_out) k WHERE (v_out->>k)::bigint > 0), '[]'::jsonb);
END $$;

-- P-2: the default refund amount of p_qty units of one sale line (paid price per unit after every discount; the last
-- unit takes what is left; the client's refundMath.ts planRefundRequest computes exactly this)
CREATE OR REPLACE FUNCTION public.fin_refund_default_line(p_sale_id text, p_request_id text, p_item_id text, p_qty bigint)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN coalesce(pr.q, 0) + p_qty >= n.qty_units THEN greatest(n.net_mmk - coalesce(pr.a, 0), 0)
              ELSE least(greatest(n.net_mmk - coalesce(pr.a, 0), 0), greatest(0, round(n.net_mmk::numeric * p_qty / n.qty_units)::bigint)) END
    FROM fin_sale_line_net(ARRAY[p_sale_id]) n LEFT JOIN fin_refund_prior_lines(p_sale_id, p_request_id) pr ON pr.item_id = n.item_id
   WHERE n.item_id = p_item_id $$;

-- the exceptions a refund request asks for, against the defaults at this moment:
--   {totalMmk, priceAdjust: [{saleItemId, qtyUnits, defaultMmk, proposedMmk}], defaultPayouts, proposedPayouts,
--    altPayout: bool, legacyAmbiguous: bool, cashMmk (what leaves the drawer)}
CREATE OR REPLACE FUNCTION public.fin_refund_exceptions(p_sale_id text, p_request_id text, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it jsonb; ln jsonb; v_total bigint := 0; v_adj jsonb := '[]'; v_amb boolean := false; v_line text; v_def bigint;
        v_amt bigint; v_qty bigint; v_has_payouts boolean; v_prop jsonb; v_dflt jsonb; v_cash bigint; v_sale sales;
BEGIN
  SELECT * INTO v_sale FROM sales WHERE id = p_sale_id;
  FOR it IN SELECT value FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) LOOP
    IF jsonb_typeof(it) <> 'object' THEN CONTINUE; END IF;
    v_total := v_total + coalesce((coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint, 0);
    IF it ? 'lines' THEN
      FOR ln IN SELECT value FROM jsonb_array_elements(it->'lines') LOOP
        v_def := fin_refund_default_line(p_sale_id, p_request_id, ln->>'saleItemId', (ln->>'qtyUnits')::bigint);
        IF v_def IS DISTINCT FROM (ln->>'amountMmk')::bigint THEN
          v_adj := v_adj || jsonb_build_array(jsonb_build_object('saleItemId', ln->>'saleItemId', 'qtyUnits', (ln->>'qtyUnits')::bigint,
                     'defaultMmk', v_def, 'proposedMmk', (ln->>'amountMmk')::bigint));
        END IF;
      END LOOP;
    ELSE
      -- legacy item: priced against its product's ONLY line in the sale; a product on several lines cannot be checked
      SELECT min(si.id) INTO v_line FROM sale_items si WHERE si.sale_id = p_sale_id AND si.product_id = coalesce(it->>'productId', it->>'product_id')
       HAVING count(*) = 1;
      v_amt := (coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint;
      v_qty := (coalesce(it->>'qtyUnits', it->>'qty_units'))::bigint;
      IF v_line IS NULL THEN v_amb := true;
      ELSE
        v_def := fin_refund_default_line(p_sale_id, p_request_id, v_line, v_qty);
        IF v_def IS DISTINCT FROM v_amt THEN
          v_adj := v_adj || jsonb_build_array(jsonb_build_object('saleItemId', v_line, 'qtyUnits', v_qty, 'defaultMmk', v_def, 'proposedMmk', v_amt));
        END IF;
      END IF;
    END IF;
  END LOOP;
  v_has_payouts := EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x WHERE jsonb_typeof(x) = 'object' AND x ? 'payouts');
  v_dflt := fin_refund_default_payouts(p_sale_id, p_request_id, v_total);
  IF v_has_payouts THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('method', m, 'amountMmk', a) ORDER BY m), '[]'::jsonb) INTO v_prop
      FROM (SELECT po->>'method' AS m, sum((po->>'amountMmk')::bigint) AS a
              FROM jsonb_array_elements(p_items) x CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN x ? 'payouts' THEN x->'payouts' ELSE '[]'::jsonb END) po
             GROUP BY 1 HAVING sum((po->>'amountMmk')::bigint) > 0) y;
    SELECT coalesce(sum((p->>'amountMmk')::bigint), 0) INTO v_cash FROM jsonb_array_elements(v_prop) p WHERE p->>'method' = 'CASH';
  ELSE
    v_prop := v_dflt;                                         -- no payouts named: the default (legacy items: the sale's method)
    v_cash := CASE WHEN v_sale.payment_method = 'CASH' AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = p_sale_id AND sp.source = 'split')
                   THEN v_total
                   ELSE coalesce((SELECT sum((p->>'amountMmk')::bigint) FROM jsonb_array_elements(coalesce(v_dflt, '[]'::jsonb)) p WHERE p->>'method' = 'CASH'), 0) END;
  END IF;
  RETURN jsonb_build_object('totalMmk', v_total, 'priceAdjust', v_adj, 'defaultPayouts', v_dflt, 'proposedPayouts', v_prop,
    -- fail closed (review 1, F1): payouts named while no default exists count as an alternative payout (needs approval)
    'altPayout', v_has_payouts AND (v_dflt IS NULL OR v_prop IS DISTINCT FROM v_dflt), 'legacyAmbiguous', v_amb, 'cashMmk', v_cash);
END $$;

-- cumulative caps for THIS request plus every other APPROVED request of the sale (replaces PFIN-E's):
-- the per-method cap applies to the request's ATTRIBUTION (its payouts, or for an alternative payout the default
-- allocation by the original methods); the total cap is unchanged.
CREATE OR REPLACE FUNCTION public.fin_refund_caps_problem(p_sale_id text, p_request_id text, p_items jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_bad record; v_mine_total bigint; v_prior_total bigint; v_paid_total bigint; v_x jsonb; v_attr jsonb;
BEGIN
  WITH mine AS (
    SELECT ln->>'saleItemId' AS item_id, sum((ln->>'qtyUnits')::bigint) AS q, sum((ln->>'amountMmk')::bigint) AS a
      FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN it ? 'lines' THEN it->'lines' ELSE '[]'::jsonb END) ln
     GROUP BY 1
  ), prior AS (SELECT * FROM fin_refund_prior_lines(p_sale_id, p_request_id)),
  net AS (SELECT n.item_id, n.qty_units, n.net_mmk FROM fin_sale_line_net(ARRAY[p_sale_id]) n)
  SELECT m.item_id, n.qty_units, n.net_mmk, coalesce(p.q, 0) + m.q AS tq, coalesce(p.a, 0) AS pa INTO v_bad
    FROM mine m JOIN net n ON n.item_id = m.item_id LEFT JOIN prior p ON p.item_id = m.item_id
   WHERE coalesce(p.q, 0) + m.q > n.qty_units OR coalesce(p.a, 0) + m.a > n.net_mmk
   LIMIT 1;
  IF v_bad.item_id IS NOT NULL THEN
    RETURN CASE WHEN v_bad.tq > v_bad.qty_units THEN 'Refund quantity exceeds what was sold on this line'
                ELSE 'Refund amount exceeds what the customer paid for this line after discounts (' || greatest(v_bad.net_mmk - v_bad.pa, 0) || ' MMK refundable)' END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it WHERE it ? 'payouts') THEN RETURN NULL; END IF;
  SELECT coalesce(sum((coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint), 0) INTO v_mine_total FROM jsonb_array_elements(p_items) it;
  SELECT coalesce(sum(a), 0) INTO v_prior_total FROM fin_refund_prior_methods(p_sale_id, p_request_id);
  SELECT coalesce(sum(amount_mmk), 0) INTO v_paid_total FROM sale_payments WHERE sale_id = p_sale_id;
  IF v_prior_total + v_mine_total > v_paid_total THEN RETURN 'Refunds would exceed what the customer paid for this sale'; END IF;
  v_x := fin_refund_exceptions(p_sale_id, p_request_id, p_items);
  v_attr := CASE WHEN (v_x->>'altPayout')::boolean THEN v_x->'defaultPayouts' ELSE v_x->'proposedPayouts' END;
  -- payouts per ORIGINAL method never exceed what the sale was paid with that method (cash: the applied amount, never the change)
  WITH mine AS (SELECT e->>'method' AS method, (e->>'amountMmk')::bigint AS a FROM jsonb_array_elements(coalesce(v_attr, '[]'::jsonb)) e),
  prior AS (SELECT * FROM fin_refund_prior_methods(p_sale_id, p_request_id)),
  paid AS (SELECT method, sum(amount_mmk)::bigint AS a FROM sale_payments WHERE sale_id = p_sale_id GROUP BY 1)
  SELECT m.method, coalesce(d.a, 0) - coalesce(p.a, 0) AS left_mmk INTO v_bad
    FROM mine m LEFT JOIN prior p ON p.method = m.method LEFT JOIN paid d ON d.method = m.method
   WHERE coalesce(p.a, 0) + m.a > coalesce(d.a, 0) LIMIT 1;
  IF v_bad.method IS NOT NULL THEN
    RETURN 'Refund payout by ' || v_bad.method || ' exceeds what the customer paid that way (' || greatest(v_bad.left_mmk, 0) || ' MMK left)';
  END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------ 2b. which drawer paid a closed-shift sale's cash refund
-- P-3 charges a cash refund to the SALE's shift. When that shift is already closed the cash physically leaves another
-- drawer that is open now; that drawer's expected cash does not include it (P-3), so every later f125 check of that
-- drawer subtracts what was already drawn from it (review follow-up, F2). Immutable evidence, written at approval.
CREATE TABLE IF NOT EXISTS public.refund_cash_drawer (
  request_id       text PRIMARY KEY REFERENCES public.refund_void_requests(id),
  org_id           text NOT NULL,
  shop_id          text NOT NULL,
  sale_shift_id    text NOT NULL REFERENCES public.shifts(id),
  drawer_shift_id  text NOT NULL REFERENCES public.shifts(id),
  cash_mmk         integer NOT NULL CHECK (cash_mmk > 0),
  recorded_at      timestamptz NOT NULL,
  CHECK (drawer_shift_id <> sale_shift_id)
);
CREATE INDEX IF NOT EXISTS refund_cash_drawer_drawer_idx ON public.refund_cash_drawer (drawer_shift_id);
ALTER TABLE public.refund_cash_drawer OWNER TO postgres;
ALTER TABLE public.refund_cash_drawer ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refund_cash_drawer FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.refund_cash_drawer TO authenticated, service_role;
DROP POLICY IF EXISTS refund_cash_drawer_sel ON public.refund_cash_drawer;
CREATE POLICY refund_cash_drawer_sel ON public.refund_cash_drawer FOR SELECT TO authenticated
  USING (org_id = public.app_org_id() AND EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = refund_cash_drawer.drawer_shift_id));
DROP TRIGGER IF EXISTS zzf_immutable ON public.refund_cash_drawer;
CREATE TRIGGER zzf_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.refund_cash_drawer FOR EACH STATEMENT EXECUTE FUNCTION public.fin_immutable();

-- ------------------------------------------------------------ 3. refund policy (after PFIN-E's guard)
CREATE OR REPLACE FUNCTION public.fin_refund_policy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_x jsonb; v_multi boolean; v_sale sales; v_exp bigint; v_pending text; v_drawer shifts; v_me text;
BEGIN
  IF TG_OP = 'INSERT' AND public.fin_request_offline() THEN
    RAISE EXCEPTION 'FIN_REFUND_OFFLINE: refund and void requests are recorded online only (nothing was saved)';
  END IF;
  IF NEW.type <> 'PARTIAL' OR NEW.items IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_sale FROM sales WHERE id = NEW.sale_id;
  v_multi := (SELECT count(*) FROM sale_payments WHERE sale_id = NEW.sale_id) > 1;
  IF v_multi AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.items) x
                          WHERE jsonb_typeof(x) = 'object' AND coalesce((coalesce(x->>'amountMmk', x->>'amount_mmk'))::numeric, 0) > 0
                            AND (NOT x ? 'lines' OR NOT x ? 'payouts')) THEN
    RAISE EXCEPTION 'FIN_REFUND_DETAIL_REQUIRED: a refund of a sale paid by several methods names its sale lines and payouts (update this till)';
  END IF;
  v_x := public.fin_refund_exceptions(NEW.sale_id, NEW.id, NEW.items);
  IF (v_x->>'legacyAmbiguous')::boolean THEN
    RAISE EXCEPTION 'FIN_REFUND_LINES_REQUIRED: this product is on several lines of the sale; the refund must name the sale line (update this till)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF (jsonb_array_length(v_x->'priceAdjust') > 0 OR (v_x->>'altPayout')::boolean) AND NOT app_can_for_shop('pos:refund', NEW.shop_id) THEN
      RAISE EXCEPTION 'FIN_REFUND_EXCEPTION_NOT_PERMITTED: only a manager may propose a refund price other than the paid price or a payout by another method';
    END IF;
    IF (jsonb_array_length(v_x->'priceAdjust') > 0 OR (v_x->>'altPayout')::boolean) AND length(btrim(coalesce(NEW.reason, ''))) < 3 THEN
      RAISE EXCEPTION 'FIN_REFUND_REASON_REQUIRED: a refund that needs a Shop Admin decision needs a reason of 3 to 300 characters';
    END IF;
    -- an alternative payout goes back in cash or by a method the customer actually used (never a method the sale never had)
    IF (v_x->>'altPayout')::boolean AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_x->'proposedPayouts') p
          WHERE p->>'method' <> 'CASH' AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = NEW.sale_id AND sp.method = p->>'method')) THEN
      RAISE EXCEPTION 'FIN_REFUND_METHOD_INVALID: a refund is paid back in cash or by a method this sale was paid with';
    END IF;
    RETURN NEW;
  END IF;
  -- approval: every exception the request asks for was approved separately, exactly as it stands now
  SELECT string_agg(kind || ' ' || status, ', ') INTO v_pending FROM fin_approvals WHERE subject_id = NEW.id AND status <> 'APPROVED';
  IF v_pending IS NOT NULL THEN
    RAISE EXCEPTION 'FIN_REFUND_EXCEPTION_PENDING: a Shop Admin decision is outstanding or refused (%)', v_pending;
  END IF;
  IF jsonb_array_length(v_x->'priceAdjust') > 0 AND NOT EXISTS (
       SELECT 1 FROM fin_approvals f WHERE f.subject_id = NEW.id AND f.kind = 'REFUND_PRICE_ADJUST' AND f.status = 'APPROVED'
          AND f.details->'lines' = v_x->'priceAdjust') THEN
    RAISE EXCEPTION 'FIN_REFUND_EXCEPTION_UNAPPROVED: the adjusted refund price has no matching Shop Admin approval (the defaults changed: create a new request)';
  END IF;
  IF (v_x->>'altPayout')::boolean AND NOT EXISTS (
       SELECT 1 FROM fin_approvals f WHERE f.subject_id = NEW.id AND f.kind = 'REFUND_ALT_PAYOUT' AND f.status = 'APPROVED'
          AND f.details->'original' = v_x->'defaultPayouts' AND f.details->'proposed' = v_x->'proposedPayouts') THEN
    RAISE EXCEPTION 'FIN_REFUND_EXCEPTION_UNAPPROVED: the alternative payout has no matching Shop Admin approval (the defaults changed: create a new request)';
  END IF;
  IF (v_x->>'altPayout')::boolean IS NOT TRUE AND v_x->'defaultPayouts' IS NOT NULL
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.items) x WHERE x ? 'payouts')
     AND v_x->'proposedPayouts' IS DISTINCT FROM v_x->'defaultPayouts' THEN
    RAISE EXCEPTION 'FIN_REFUND_EXCEPTION_UNAPPROVED: the payout differs from the original methods';
  END IF;
  -- f125: a cash payout never takes the drawer the cash leaves below zero. That drawer is the sale's shift while it is
  -- open; once it is closed, a drawer open NOW in the same shop (the approver's own, else the one holding the most cash).
  -- The drawer's shift row is locked first, so concurrent approvals are checked one after the other (review 1, F2).
  -- (Expected-cash accounting keeps charging the refund to the sale's shift: owner decision P-3, unchanged.)
  IF (v_x->>'cashMmk')::bigint > 0 THEN
    SELECT * INTO v_drawer FROM shifts WHERE id = v_sale.shift_id AND ended_at IS NULL FOR UPDATE;
    IF v_drawer.id IS NULL THEN
      v_me := (current_app_user()).id;
      SELECT s.* INTO v_drawer FROM shifts s
       WHERE s.shop_id = v_sale.shop_id AND s.ended_at IS NULL
       ORDER BY (s.cashier_id = v_me) DESC NULLS LAST, (public.fin_shift_cash(s.id)->>'expectedCashMmk')::bigint DESC, s.id
       LIMIT 1 FOR UPDATE;
    END IF;
    IF v_drawer.id IS NULL THEN
      RAISE EXCEPTION 'FIN_DRAWER_INSUFFICIENT: a cash refund of % MMK needs an open drawer in this shop (the sale''s shift is closed and no shift is open)', (v_x->>'cashMmk')::bigint;
    END IF;
    -- the drawer's expected cash, less what closed-shift refunds already drew from it (not in its expected cash: P-3)
    v_exp := (public.fin_shift_cash(v_drawer.id)->>'expectedCashMmk')::bigint
             - (SELECT coalesce(sum(cash_mmk), 0) FROM refund_cash_drawer WHERE drawer_shift_id = v_drawer.id);
    IF v_exp - (v_x->>'cashMmk')::bigint < 0 THEN
      RAISE EXCEPTION 'FIN_DRAWER_INSUFFICIENT: a cash refund of % MMK would take the drawer below zero (% MMK available in shift %)', (v_x->>'cashMmk')::bigint, v_exp, v_drawer.id;
    END IF;
    IF v_drawer.id <> v_sale.shift_id THEN
      INSERT INTO refund_cash_drawer (request_id, org_id, shop_id, sale_shift_id, drawer_shift_id, cash_mmk, recorded_at)
      VALUES (NEW.id, (SELECT org_id FROM shops WHERE id = NEW.shop_id), NEW.shop_id, v_sale.shift_id, v_drawer.id, (v_x->>'cashMmk')::int, clock_timestamp());
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- a refund approved WITHOUT named payouts (a single-payment sale, a released till) records its default payout by the
-- sale's own method, so a non-cash payout exists to be confirmed and is never shown as paid before that (review 1, F3).
-- Runs after PFIN-E's zzf_refund_record (AFTER triggers in name order); a request that named payouts already has them.
CREATE OR REPLACE FUNCTION public.fin_refund_default_payout_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org text; v_d jsonb; v_total bigint; v_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.type <> 'PARTIAL' OR NEW.items IS NULL OR EXISTS (SELECT 1 FROM refund_payouts WHERE request_id = NEW.id) THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM sale_payments WHERE sale_id = NEW.sale_id) <> 1 THEN RETURN NULL; END IF;   -- split sales always name payouts
  SELECT coalesce(sum((coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint), 0) INTO v_total FROM jsonb_array_elements(NEW.items) it;
  IF v_total <= 0 THEN RETURN NULL; END IF;
  SELECT org_id INTO v_org FROM shops WHERE id = NEW.shop_id;
  INSERT INTO refund_payouts (id, org_id, shop_id, request_id, sale_id, method, amount_mmk, approved_by, approved_at)
  SELECT 'rp-' || replace(gen_random_uuid()::text, '-', ''), v_org, NEW.shop_id, NEW.id, NEW.sale_id, sp.method, v_total,
         coalesce((current_app_user()).id, NEW.created_by), v_now
    FROM sale_payments sp WHERE sp.sale_id = NEW.sale_id;
  RETURN NULL;
END $$;
ALTER FUNCTION public.fin_refund_default_payout_record() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_refund_default_payout_record() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS zzg_refund_default_payout ON public.refund_void_requests;
CREATE TRIGGER zzg_refund_default_payout AFTER UPDATE ON public.refund_void_requests FOR EACH ROW
  WHEN (NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED') EXECUTE FUNCTION public.fin_refund_default_payout_record();

-- the exceptions a new request asks for become approval requests (REQUESTED), with the original allocation recorded
CREATE OR REPLACE FUNCTION public.fin_refund_exceptions_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_x jsonb; v_org text; v_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.type <> 'PARTIAL' OR NEW.items IS NULL THEN RETURN NULL; END IF;
  v_x := public.fin_refund_exceptions(NEW.sale_id, NEW.id, NEW.items);
  SELECT org_id INTO v_org FROM shops WHERE id = NEW.shop_id;
  IF jsonb_array_length(v_x->'priceAdjust') > 0 THEN
    INSERT INTO fin_approvals (id, org_id, shop_id, kind, subject_id, details, reason, requested_by, requested_at)
    VALUES ('fa-' || replace(gen_random_uuid()::text, '-', ''), v_org, NEW.shop_id, 'REFUND_PRICE_ADJUST', NEW.id,
            jsonb_build_object('saleId', NEW.sale_id, 'lines', v_x->'priceAdjust'), left(NEW.reason, 300), NEW.created_by, v_now);
  END IF;
  IF (v_x->>'altPayout')::boolean THEN
    INSERT INTO fin_approvals (id, org_id, shop_id, kind, subject_id, details, reason, requested_by, requested_at)
    VALUES ('fa-' || replace(gen_random_uuid()::text, '-', ''), v_org, NEW.shop_id, 'REFUND_ALT_PAYOUT', NEW.id,
            jsonb_build_object('saleId', NEW.sale_id, 'original', v_x->'defaultPayouts', 'proposed', v_x->'proposedPayouts'),
            left(NEW.reason, 300), NEW.created_by, v_now);
  END IF;
  RETURN NULL;
END $$;

ALTER FUNCTION public.fin_refund_prior_methods(text, text) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_default_payouts(text, text, bigint) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_default_line(text, text, text, bigint) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_exceptions(text, text, jsonb) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_caps_problem(text, text, jsonb) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_policy() OWNER TO postgres;
ALTER FUNCTION public.fin_refund_exceptions_record() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_refund_prior_methods(text, text), public.fin_refund_default_payouts(text, text, bigint),
  public.fin_refund_default_line(text, text, text, bigint), public.fin_refund_exceptions(text, text, jsonb),
  public.fin_refund_caps_problem(text, text, jsonb), public.fin_refund_policy(), public.fin_refund_exceptions_record()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS zzg_refund_policy_ins ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzg_refund_policy_upd ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzg_refund_exceptions ON public.refund_void_requests;
-- fire after PFIN-E's zzf_refund_guard_* (BEFORE triggers run in name order)
CREATE TRIGGER zzg_refund_policy_ins BEFORE INSERT ON public.refund_void_requests FOR EACH ROW EXECUTE FUNCTION public.fin_refund_policy();
CREATE TRIGGER zzg_refund_policy_upd BEFORE UPDATE ON public.refund_void_requests FOR EACH ROW
  WHEN (NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED') EXECUTE FUNCTION public.fin_refund_policy();
CREATE TRIGGER zzg_refund_exceptions AFTER INSERT ON public.refund_void_requests FOR EACH ROW EXECUTE FUNCTION public.fin_refund_exceptions_record();

-- ------------------------------------------------------------ 4. decisions (Shop Admin; never the requester)
CREATE OR REPLACE FUNCTION public.fin_approval_json(a public.fin_approvals)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', a.id, 'shopId', a.shop_id, 'kind', a.kind, 'subjectId', a.subject_id, 'details', a.details,
    'reason', a.reason, 'requestedBy', a.requested_by, 'requestedAt', a.requested_at, 'status', a.status, 'decidedBy', a.decided_by,
    'decidedAt', a.decided_at, 'decisionReason', a.decision_reason, 'expiresAt', a.expires_at, 'consumedSaleId', a.consumed_sale_id) $$;
ALTER FUNCTION public.fin_approval_json(public.fin_approvals) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_approval_json(public.fin_approvals) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_approval_json(public.fin_approvals) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fin_decide_approval(p_approval_id text, p_decision text, p_reason text DEFAULT NULL, p_key uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user users; a fin_approvals; v_now timestamptz := clock_timestamp(); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
        v_ok boolean; v_pct numeric;
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL OR NOT v_user.is_active THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('APPROVE', 'REJECT') THEN RAISE EXCEPTION 'FIN_APPROVAL_INVALID: decision must be APPROVE or REJECT'; END IF;
  IF public.fin_request_offline() THEN RAISE EXCEPTION 'FIN_APPROVAL_OFFLINE: approvals are decided online only'; END IF;
  SELECT * INTO a FROM fin_approvals WHERE id = p_approval_id FOR UPDATE;
  IF a.id IS NULL OR a.org_id IS DISTINCT FROM v_user.org_id THEN RAISE EXCEPTION 'FIN_APPROVAL_NOT_FOUND: approval not found'; END IF;
  IF a.status <> 'REQUESTED' THEN
    IF a.decide_key = p_key THEN RETURN jsonb_build_object('approval', public.fin_approval_json(a), 'replayed', true); END IF;
    RAISE EXCEPTION 'FIN_APPROVAL_DECIDED: this request was already %', lower(a.status);
  END IF;
  IF a.requested_by = v_user.id THEN RAISE EXCEPTION 'FIN_APPROVAL_SELF: you cannot decide your own request; another approver must'; END IF;
  v_pct := (a.details->>'pct')::numeric;
  v_ok := public.fin_is_shop_admin(a.shop_id)
          OR (a.kind = 'DISCOUNT' AND NOT coalesce((a.details->>'needsShopAdmin')::boolean, true)      -- exact integer test (review 2, L1)
              AND app_role() IN ('MANAGER', 'ADMIN') AND app_can_for_shop('pos:apply_discount', a.shop_id));
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FIN_APPROVER_NOT_ELIGIBLE: only a Shop Admin of this shop (or, for a discount of 5%% or less, a manager) may decide this';
  END IF;
  IF a.kind <> 'DISCOUNT' AND NOT EXISTS (SELECT 1 FROM refund_void_requests r WHERE r.id = a.subject_id AND r.status = 'REQUESTED') THEN
    RAISE EXCEPTION 'FIN_APPROVAL_DECIDED: the refund request was already decided';
  END IF;
  IF a.kind = 'DISCOUNT' AND a.requested_at < v_now - interval '2 hours' THEN
    RAISE EXCEPTION 'FIN_APPROVAL_EXPIRED: this discount request is older than 2 hours; request it again';
  END IF;
  IF p_decision = 'REJECT' AND v_reason IS NULL THEN RAISE EXCEPTION 'FIN_APPROVAL_INVALID: a rejection needs a reason'; END IF;
  IF v_reason IS NOT NULL AND length(v_reason) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'FIN_APPROVAL_INVALID: the reason must be 3 to 300 characters'; END IF;
  UPDATE fin_approvals SET status = CASE WHEN p_decision = 'APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END, decided_by = v_user.id, decided_at = v_now,
         decision_reason = v_reason, decide_key = p_key,
         expires_at = CASE WHEN kind = 'DISCOUNT' AND p_decision = 'APPROVE' THEN v_now + interval '30 minutes' END
   WHERE id = a.id RETURNING * INTO a;
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES ('audit-' || replace(gen_random_uuid()::text, '-', ''), a.shop_id, v_user.id, 'FIN_APPROVAL_' || a.status,
          a.kind || ' requested by ' || a.requested_by || ' ' || lower(a.status) || coalesce(': ' || left(v_reason, 200), ''), 'FinApproval', a.id, v_now);
  RETURN jsonb_build_object('approval', public.fin_approval_json(a), 'replayed', false);
END $$;
ALTER FUNCTION public.fin_decide_approval(text, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_decide_approval(text, text, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_decide_approval(text, text, text, uuid) TO authenticated;

-- ------------------------------------------------------------ 5. what the till shows before a refund (read only)
-- the default amounts of the chosen lines and their default payout by the original methods, plus what is left per method
CREATE OR REPLACE FUNCTION public.fin_refund_plan(p_sale_id text, p_lines jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user users; ln jsonb; v_out jsonb := '[]'; v_total bigint := 0; v_def bigint;
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.app_require_org('sale', p_sale_id);
  IF NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = p_sale_id
                  AND (app_can_for_shop('pos:refund', s.shop_id) OR app_can_for_shop('pos:request_refund', s.shop_id))) THEN
    RAISE EXCEPTION 'You are not permitted to refund this sale';
  END IF;
  FOR ln IN SELECT value FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) LOOP
    v_def := fin_refund_default_line(p_sale_id, NULL, ln->>'saleItemId', (ln->>'qtyUnits')::bigint);
    IF v_def IS NULL THEN RAISE EXCEPTION 'a refund line is not a line of this sale'; END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object('saleItemId', ln->>'saleItemId', 'qtyUnits', (ln->>'qtyUnits')::bigint, 'defaultMmk', v_def));
    v_total := v_total + v_def;
  END LOOP;
  RETURN jsonb_build_object('saleId', p_sale_id, 'lines', v_out, 'totalMmk', v_total,
    'defaultPayouts', fin_refund_default_payouts(p_sale_id, NULL, v_total),
    'methods', coalesce((SELECT jsonb_agg(jsonb_build_object('method', p.method, 'paidMmk', p.a,
        'attributedRefundedMmk', coalesce(pr.a, 0), 'leftMmk', greatest(p.a - coalesce(pr.a, 0), 0)) ORDER BY p.method)
      FROM (SELECT method, sum(amount_mmk)::bigint AS a FROM sale_payments WHERE sale_id = p_sale_id GROUP BY 1) p
      LEFT JOIN fin_refund_prior_methods(p_sale_id, NULL) pr ON pr.method = p.method), '[]'::jsonb),
    'canProposeExceptions', EXISTS (SELECT 1 FROM sales s WHERE s.id = p_sale_id AND app_can_for_shop('pos:refund', s.shop_id)));
END $$;
ALTER FUNCTION public.fin_refund_plan(text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_refund_plan(text, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_refund_plan(text, jsonb) TO authenticated;

-- ------------------------------------------------------------ 6. non-cash payout confirmation (D1)
CREATE TABLE IF NOT EXISTS public.refund_payout_confirmations (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  shop_id       text NOT NULL,
  payout_id     text NOT NULL UNIQUE REFERENCES public.refund_payouts(id),
  reference     text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  confirmed_by  text NOT NULL,
  confirmed_at  timestamptz NOT NULL,
  confirm_key   uuid NOT NULL,
  UNIQUE (org_id, confirm_key)
);
ALTER TABLE public.refund_payout_confirmations OWNER TO postgres;
ALTER TABLE public.refund_payout_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refund_payout_confirmations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.refund_payout_confirmations TO authenticated, service_role;
DROP POLICY IF EXISTS refund_payout_confirmations_sel ON public.refund_payout_confirmations;
CREATE POLICY refund_payout_confirmations_sel ON public.refund_payout_confirmations FOR SELECT TO authenticated
  USING (org_id = public.app_org_id() AND EXISTS (SELECT 1 FROM public.refund_payouts p WHERE p.id = refund_payout_confirmations.payout_id));
DROP TRIGGER IF EXISTS zzf_immutable ON public.refund_payout_confirmations;
CREATE TRIGGER zzf_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.refund_payout_confirmations FOR EACH STATEMENT EXECUTE FUNCTION public.fin_immutable();

CREATE OR REPLACE FUNCTION public.fin_confirm_refund_payout(p_payout_id text, p_reference text, p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user users; v_p refund_payouts; v_c refund_payout_confirmations; v_now timestamptz := clock_timestamp(); v_ref text := btrim(coalesce(p_reference, ''));
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL OR NOT v_user.is_active THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_key IS NULL THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF public.fin_request_offline() THEN RAISE EXCEPTION 'FIN_PAYOUT_OFFLINE: payouts are confirmed online only'; END IF;
  SELECT * INTO v_c FROM refund_payout_confirmations WHERE org_id = v_user.org_id AND confirm_key = p_key;
  IF v_c.id IS NOT NULL THEN
    IF v_c.payout_id IS DISTINCT FROM p_payout_id THEN RAISE EXCEPTION 'FIN_PAYOUT_KEY_REUSED: this key confirmed another payout'; END IF;
    RETURN jsonb_build_object('confirmation', to_jsonb(v_c), 'replayed', true);
  END IF;
  SELECT * INTO v_p FROM refund_payouts WHERE id = p_payout_id FOR UPDATE;
  IF v_p.id IS NULL OR v_p.org_id IS DISTINCT FROM v_user.org_id THEN RAISE EXCEPTION 'FIN_PAYOUT_NOT_FOUND: payout not found'; END IF;
  IF NOT app_can_for_shop('pos:refund', v_p.shop_id) THEN RAISE EXCEPTION 'You are not permitted to confirm refund payouts for this shop'; END IF;
  IF v_p.method = 'CASH' THEN RAISE EXCEPTION 'FIN_PAYOUT_INVALID: a cash payout is paid at the counter when the refund is approved'; END IF;
  IF length(v_ref) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'FIN_PAYOUT_INVALID: a confirmation needs the transfer reference (1 to 120 characters)'; END IF;
  IF EXISTS (SELECT 1 FROM refund_payout_confirmations WHERE payout_id = v_p.id) THEN RAISE EXCEPTION 'FIN_PAYOUT_CONFIRMED: this payout was already confirmed'; END IF;
  INSERT INTO refund_payout_confirmations (id, org_id, shop_id, payout_id, reference, confirmed_by, confirmed_at, confirm_key)
  VALUES ('rpc-' || replace(gen_random_uuid()::text, '-', ''), v_p.org_id, v_p.shop_id, v_p.id, v_ref, v_user.id, v_now, p_key) RETURNING * INTO v_c;
  INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
  VALUES ('audit-' || replace(gen_random_uuid()::text, '-', ''), v_p.shop_id, v_user.id, 'REFUND_PAYOUT_CONFIRMED',
          v_p.method || ' ' || v_p.amount_mmk || ' MMK paid back (reference ' || left(v_ref, 60) || ')', 'RefundPayout', v_p.id, v_now);
  RETURN jsonb_build_object('confirmation', to_jsonb(v_c), 'replayed', false);
END $$;
ALTER FUNCTION public.fin_confirm_refund_payout(text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_confirm_refund_payout(text, text, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_confirm_refund_payout(text, text, uuid) TO authenticated;

-- the payouts of one sale and whether each was actually paid (cash: at approval; other methods: once confirmed)
CREATE OR REPLACE FUNCTION public.fin_refund_payout_state(p_sale_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user users;
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.app_require_org('sale', p_sale_id);
  IF NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = p_sale_id
                  AND (app_can_for_shop('pos:refund', s.shop_id) OR app_can_for_shop('pos:request_refund', s.shop_id))) THEN
    RAISE EXCEPTION 'You are not permitted to view this sale''s refunds';
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'requestId', p.request_id, 'method', p.method, 'amountMmk', p.amount_mmk,
      'approvedAt', p.approved_at,
      'status', CASE WHEN p.method = 'CASH' THEN 'PAID' WHEN c.id IS NOT NULL THEN 'CONFIRMED' ELSE 'PENDING_CONFIRMATION' END,
      'reference', c.reference, 'confirmedBy', c.confirmed_by, 'confirmedAt', c.confirmed_at,
      'alternative', EXISTS (SELECT 1 FROM fin_approvals f WHERE f.subject_id = p.request_id AND f.kind = 'REFUND_ALT_PAYOUT'))
      ORDER BY p.approved_at, p.method)
    FROM refund_payouts p LEFT JOIN refund_payout_confirmations c ON c.payout_id = p.id WHERE p.sale_id = p_sale_id), '[]'::jsonb);
END $$;
ALTER FUNCTION public.fin_refund_payout_state(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_refund_payout_state(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_refund_payout_state(text) TO authenticated;

-- ------------------------------------------------------------ 7. f10: no change from a non-cash payment (every sale path)
CREATE OR REPLACE FUNCTION public.fin_sale_change_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- a split sale's payment list is validated by PFIN-D (change only from its cash part, FIN_PAYMENTS_*)
  IF coalesce(current_setting('orvix.fin_split_payments', true), '') <> '' THEN RETURN NEW; END IF;
  IF NEW.change_mmk > 0 AND NEW.payment_method IS DISTINCT FROM 'CASH' THEN
    RAISE EXCEPTION 'FIN_NON_CASH_CHANGE: change is given only from cash; a non-cash payment is recorded for exactly the amount due';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.fin_sale_change_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_sale_change_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS zzf_sale_change_guard ON public.sales;
CREATE TRIGGER zzf_sale_change_guard BEFORE INSERT ON public.sales FOR EACH ROW EXECUTE FUNCTION public.fin_sale_change_guard();

DO $pfin_f_post$
BEGIN
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF;
END $pfin_f_post$;
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
