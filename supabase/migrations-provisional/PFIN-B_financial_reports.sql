-- ============================================================
-- PROVISIONAL migration PFIN-B: permission-scoped server financial reports
-- (no number assigned; see supabase/migrations-provisional/README.md)
--
-- WHY
--   The Dashboard and Reports pages compute revenue, refunds and profit in
--   the client from a cache of at most 1,000 sales, using the device's local
--   day and whatever refund rows the caller's RLS happens to expose. A
--   cashier sees their own sales but only the refund requests they created
--   themselves (069 refund_void_requests_sel), so refunds entered by someone
--   else never reduce their figures. A user with sale:view but without
--   pos:refund sees the same gap for the whole shop.
--
-- WHAT
--   Read-only, SECURITY DEFINER report functions that apply their own scope
--   (never RLS) and return aggregates only:
--     fin_report_summary(p_shop_id, p_from, p_to, p_refund_basis)  -> jsonb
--     fin_shift_reconciliation(p_shift_id)                          -> jsonb
--   Internal helpers (not executable by API roles), all set-based:
--     fin_report_scope(p_shop_id)          caller scope
--     fin_items(p_items)                   defensive parser of request items
--     fin_sale_line_net(p_sale_ids[])      net amount per line (cart discount)
--     fin_approval_times(kind, p_ids[])    server-attested approval time
--     fin_refund_lines(p_request_ids[])    amount / COGS reversal / evidence
--
-- ACCOUNTING DEFINITIONS (stated, not chosen silently)
--   Business day     the Asia/Yangon calendar date of sales.created_at
--                    (ring-up time, already clamped by resolve_event_time).
--   Gross sales      Σ sales.total_mmk (after item and cart discounts).
--   Refund basis     REQUIRED argument, no default:
--                      SALE_DATE      a refund or void reduces the day the
--                                     sale was rung up (voided sales are
--                                     left out of gross on that day). This is
--                                     what the fin-ui client computes.
--                      APPROVAL_DATE  a refund or void reduces the day it was
--                                     approved (cash basis; owner decision
--                                     D-07 recommends this, not yet approved).
--                    The response echoes the basis.
--   Approval time    the audit row the approving RPC writes in the same
--                    transaction (REFUND 'Refund approved for sale …' /
--                    VOID_SALE 'Void approved for sale …', server now()).
--                    log_audit_event cannot write these action types since
--                    051 and audit_logs has no client INSERT; the message
--                    prefix excludes free-text rows written before 051.
--                    Without such a row the time is UNKNOWN: under
--                    APPROVAL_DATE the adjustment is reported in
--                    `undatedAdjustments`, never placed on a guessed day.
--                    Invariant: audit_logs REFUND / VOID_SALE rows are never
--                    pruned (a retention job would turn refunds undated).
--   Refund amount    the approved amountMmk recorded on the request (what
--                    the approver authorised). Nothing is capped or rewritten;
--                    refunds above what the customer paid are counted in
--                    `evidence`.
--   Net line amount  fin_sale_line_net reproduces the fin-ui client's
--                    allocateNetLineAmounts (src/features/sales/refundMath.ts)
--                    exactly: integer discount shares floor(D·t/S), leftover
--                    MMK of discount to the largest remainder, ties by item id
--                    ascending (C collation = JavaScript string order).
--   COGS             Σ qty_units × unit cost snapshot (per base unit,
--                    041), reversed for refunded / voided quantities at the
--                    sale's own snapshot cost. Never today's product cost.
--                    Lines or adjustments without a snapshot make COGS
--                    incomplete; gross profit is then NULL (not a number that
--                    silently overstates profit); cogsMmk is the known part.
--   Payment method   a refund is assumed to be paid back by the sale's
--                    method: no payout record exists before planned 089/090.
--
-- SCOPE (fin_report_scope)
--   ADMIN              any shop of the caller's organisation, or all of them,
--                      like the ADMIN branch of every table policy (069): an
--                      ADMIN's revoked report:* / supplier / sale:view grants
--                      do not narrow reports (report:shop_profit still does)
--                      (ORG level: at most 93 days per call; ask per shop for
--                      longer ranges)
--   report:shop_sales  the caller's own shop (at most 367 days)
--   report:own_shift   the caller's own sales only (cashier_id = caller)
--   COGS / profit      only with report:shop_profit (ADMIN by default; D-14)
--   Supplier payments  only for ADMIN or supplier:debt_view / purchase:view
--   Another organisation's shop and a non-existent shop give the same answer.
--   A cashier (OWN level) sees the amounts of refunds on their own sales that
--   others entered (RLS hides those rows; reasons and items are never shown),
--   and their own open shift's live expected cash, as the client already does.
--
-- TIMEOUT
--   statement_timeout = 30s on the entry points is honoured when the caller
--   applies function settings at transaction level (PostgREST >= 12.1); a
--   direct SQL call keeps its role's timeout (8 s for authenticated on stock
--   Supabase), which then bounds the report.
--
-- 086 / 087 COMPATIBILITY
--   Touches no 086-digested function body, no executor RPC, no guarded
--   table (indexes are in PFIN-A). Function names avoid 087's protected
--   name patterns (%_v87, recovery_%). Owned by postgres like every other
--   business function (a superuser-owned SECURITY DEFINER function calling
--   postgres-owned helpers would let postgres act as superuser). Read-only:
--   unaffected by a recovery hold.
--
-- Idempotent (CREATE OR REPLACE / DROP of earlier provisional helpers).
-- Rollback: PFIN-B.rollback.sql.
-- ============================================================

SET lock_timeout = '3s';

-- helpers of an earlier provisional revision
DROP FUNCTION IF EXISTS public.fin_refund_figures(text);
DROP FUNCTION IF EXISTS public.fin_approval_time(text, text);
DROP FUNCTION IF EXISTS public.fin_sale_line_net(text);

-- ------------------------------------------------------------
-- Scope of the caller for financial reports
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_report_scope(p_shop_id text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user  users;
  v_shops text[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF app_role() = 'ADMIN' THEN
    IF p_shop_id IS NULL THEN
      v_shops := ARRAY(SELECT x FROM app_org_shop_ids() x ORDER BY 1);
    ELSIF app_shop_in_org(p_shop_id) THEN
      v_shops := ARRAY[p_shop_id];
    ELSE
      -- the same answer for another organisation's shop and for no shop
      RAISE EXCEPTION 'Shop not found in your organization';
    END IF;
    RETURN jsonb_build_object(
      'level', CASE WHEN p_shop_id IS NULL THEN 'ORG' ELSE 'SHOP' END,
      'shopIds', to_jsonb(v_shops), 'cashierId', NULL,
      'profit', app_has_perm('report:shop_profit'),
      'supplier', true);
  END IF;

  -- non-ADMIN: own shop only, decided before anything reveals whether a
  -- foreign id exists
  IF v_user.shop_id IS NULL OR (p_shop_id IS NOT NULL AND p_shop_id IS DISTINCT FROM v_user.shop_id) THEN
    RAISE EXCEPTION 'You are not permitted to view reports for this shop';
  END IF;

  IF app_has_perm('report:shop_sales') THEN
    RETURN jsonb_build_object(
      'level', 'SHOP', 'shopIds', to_jsonb(ARRAY[v_user.shop_id]), 'cashierId', NULL,
      'profit', app_has_perm('report:shop_profit'),
      'supplier', app_has_perm('supplier:debt_view') OR app_has_perm('purchase:view'));
  ELSIF app_has_perm('report:own_shift') THEN
    RETURN jsonb_build_object(
      'level', 'OWN', 'shopIds', to_jsonb(ARRAY[v_user.shop_id]), 'cashierId', v_user.id,
      'profit', false, 'supplier', false);
  END IF;

  RAISE EXCEPTION 'You are not permitted to view financial reports';
END;
$$;

-- ------------------------------------------------------------
-- Defensive parser of refund_void_requests.items. create_refund_void_request
-- (070) stores p_items unchecked; only approval validates them. One row per
-- element (ok = false for anything unusable, which is then never summed),
-- or one ok = false row when items is not an array. SQL NULL -> no rows.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_items(p_items jsonb)
RETURNS TABLE (product_id text, qty bigint, amount bigint, ok boolean)
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $$
  WITH e AS (
    SELECT i,
           CASE WHEN jsonb_typeof(i) = 'object' THEN COALESCE(i->>'productId', i->>'product_id') END AS pid,
           CASE WHEN jsonb_typeof(i) = 'object' THEN COALESCE(i->>'qtyUnits', i->>'qty_units') END AS q,
           CASE WHEN jsonb_typeof(i) = 'object' THEN COALESCE(i->>'amountMmk', i->>'amount_mmk') END AS a
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) i
  ),
  v AS (
    SELECT pid, q, a,
           -- what 070's ::integer cast accepts for a non-negative value: blanks and a leading '+'
           (COALESCE(pid, '') <> '' AND COALESCE(q, '') ~ '^\s*\+?[0-9]{1,9}\s*$' AND COALESCE(a, '') ~ '^\s*\+?[0-9]{1,9}\s*$') AS good
      FROM e
  )
  SELECT CASE WHEN good THEN pid END, CASE WHEN good THEN q::bigint END, CASE WHEN good THEN a::bigint END, good FROM v
  UNION ALL
  SELECT NULL, NULL, NULL, false WHERE p_items IS NOT NULL AND jsonb_typeof(p_items) <> 'array';
$$;

-- ------------------------------------------------------------
-- Net (after cart discount) amount of every line of the given sales, exactly
-- as the fin-ui client allocates it (refundMath.ts allocateNetLineAmounts):
--   t = max(0, line_total_mmk) (after item discount, BEFORE cart discount)
--   S = Σ t, D = max(0, S − max(0, total_mmk)) (0 when S ≤ 0)
--   share = floor(D·t / S), remainder = (D·t) mod S
--   leftover = D − Σ share, one MMK each to the largest remainders, ties by
--   item id ascending (C collation), net = t − share.
-- Σ net = total_mmk whenever S ≥ total ≥ 0 (every sale since 004).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_sale_line_net(p_sale_ids text[])
RETURNS TABLE (sale_id text, item_id text, product_id text, qty_units integer, line_total_mmk integer, net_mmk bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH l AS (
    SELECT si.sale_id, si.id, si.product_id, si.qty_units, si.line_total_mmk,
           greatest(si.line_total_mmk, 0)::numeric AS t
      FROM sale_items si WHERE si.sale_id = ANY (p_sale_ids)
  ),
  s AS (
    SELECT l.sale_id, sum(l.t) AS sum_t FROM l GROUP BY l.sale_id
  ),
  d AS (
    SELECT s.sale_id, s.sum_t,
           CASE WHEN s.sum_t > 0 THEN greatest(0, s.sum_t - greatest(sa.total_mmk, 0)) ELSE 0 END AS disc
      FROM s JOIN sales sa ON sa.id = s.sale_id
  ),
  x AS (
    SELECT l.*, d.disc,
           CASE WHEN d.disc > 0 THEN div(d.disc * l.t, d.sum_t) ELSE 0 END AS share,   -- exact (numeric / rounds near 1e16)
           CASE WHEN d.disc > 0 THEN mod(d.disc * l.t, d.sum_t) ELSE 0 END AS rem
      FROM l JOIN d ON d.sale_id = l.sale_id
  ),
  y AS (
    SELECT x.*,
           x.disc - sum(x.share) OVER (PARTITION BY x.sale_id) AS leftover,
           row_number() OVER (PARTITION BY x.sale_id ORDER BY x.rem DESC, x.id COLLATE "C" ASC) AS rk
      FROM x
  )
  -- the client skips a line whose share already equals its total; that can
  -- only happen when D = S (total 0), and then leftover is 0
  SELECT y.sale_id, y.id, y.product_id, y.qty_units, y.line_total_mmk,
         (y.t - y.share - CASE WHEN y.rk <= y.leftover AND y.share < y.t THEN 1 ELSE 0 END)::bigint
    FROM y;
$$;

-- ------------------------------------------------------------
-- Cost snapshot of every line of the given sales (per base unit). The one
-- place the reports read cost: sale_item_costs (the confidential table of the
-- provisional cost-privacy migration PCOST-A) when it exists, else the legacy
-- sale_items.unit_cost_mmk_snapshot column. PL/pgSQL resolves the table only
-- when that branch runs, so PFIN-B installs with or without PCOST-A, in either
-- order, and re-applying PFIN-B never loses the PCOST-A source.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_line_costs(p_sale_ids text[])
RETURNS TABLE (sale_id text, item_id text, product_id text, qty_units integer, unit_cost_mmk integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('public.sale_item_costs') IS NULL THEN
    RETURN QUERY
      SELECT si.sale_id, si.id, si.product_id, si.qty_units, si.unit_cost_mmk_snapshot
        FROM sale_items si WHERE si.sale_id = ANY (p_sale_ids);
  ELSE
    RETURN QUERY
      SELECT si.sale_id, si.id, si.product_id, si.qty_units, COALESCE(c.unit_cost_mmk, si.unit_cost_mmk_snapshot)
        FROM sale_items si LEFT JOIN sale_item_costs c ON c.sale_item_id = si.id
       WHERE si.sale_id = ANY (p_sale_ids);
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- Server-attested approval time of refund requests ('REFUND', request ids)
-- or voids ('VOID', sale ids). Missing id = no evidence.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_approval_times(p_kind text, p_ids text[])
RETURNS TABLE (id text, approved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.entity_id, min(a.created_at) FROM audit_logs a
   WHERE p_kind = 'REFUND' AND a.action_type = 'REFUND' AND a.entity_type = 'Refund'
     AND a.message LIKE 'Refund approved for sale %' AND a.entity_id = ANY (p_ids)
   GROUP BY a.entity_id
  UNION ALL
  SELECT a.entity_id, min(a.created_at) FROM audit_logs a
   WHERE p_kind = 'VOID' AND a.action_type = 'VOID_SALE' AND a.entity_type = 'Sale'
     AND a.message LIKE 'Void approved for sale %' AND a.entity_id = ANY (p_ids)
   GROUP BY a.entity_id;
$$;

-- ------------------------------------------------------------
-- Figures of APPROVED partial refund requests (set-based):
--   amount_mmk      Σ usable amountMmk of the request
--   cogs_mmk        refunded base units × the sale's own snapshot cost of
--                   that product (quantity-weighted across lines; rounded
--                   once per request item)
--   cost_missing    a refunded product has a line without a snapshot
--   above_net_paid  this request is the one whose cumulative refund of a
--                   product first passes what the customer paid for it after
--                   discounts (order: approval time, else creation time, id)
--   unparseable     the request has an unusable item (not summed)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_refund_lines(p_request_ids text[])
RETURNS TABLE (request_id text, sale_id text, amount_mmk bigint, cogs_mmk bigint,
               cost_missing boolean, above_net_paid boolean, unparseable boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH req AS (
    SELECT r.id, r.sale_id FROM refund_void_requests r
     WHERE r.id = ANY (p_request_ids) AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
  ),
  sale_ids AS (SELECT array_agg(DISTINCT sale_id) AS ids FROM req),
  -- every approved partial refund of those sales (cumulative evidence)
  peers AS (
    SELECT r.id, r.sale_id, r.created_at, r.items FROM refund_void_requests r
     WHERE r.sale_id = ANY (CAST((SELECT ids FROM sale_ids) AS text[])) AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
  ),
  peer_time AS (
    SELECT t.id, t.approved_at FROM fin_approval_times('REFUND', ARRAY(SELECT id FROM peers)) t
  ),
  it AS (
    SELECT p.id, p.sale_id, f.product_id, f.qty, f.amount, f.ok,
           COALESCE(pt.approved_at, p.created_at) AS ord_at
      FROM peers p LEFT JOIN peer_time pt ON pt.id = p.id
     CROSS JOIN LATERAL fin_items(p.items) f
  ),
  net AS (
    SELECT n.sale_id, n.product_id, sum(n.net_mmk) AS net
      FROM fin_sale_line_net((SELECT ids FROM sale_ids)) n GROUP BY 1, 2
  ),
  cost AS (
    SELECT si.sale_id, si.product_id,
           count(*) = count(si.unit_cost_mmk) AND sum(si.qty_units) > 0 AS costed,
           sum(si.qty_units::numeric * si.unit_cost_mmk) AS qc, sum(si.qty_units)::numeric AS q
      FROM fin_line_costs(CAST((SELECT ids FROM sale_ids) AS text[])) si GROUP BY 1, 2
  ),
  -- Script 2 (f72): quantities refunded WITHOUT restock (PFIN-E lines, restock=false) did not come back to stock, so
  -- their cost is not reversed. Only when PFIN-E is installed: without it the pinned approval restocked everything.
  norestock AS (
    SELECT p.id, coalesce(item->>'productId', item->>'product_id') AS product_id, sum((ln->>'qtyUnits')::numeric) AS q
      FROM peers p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.items) = 'array' THEN p.items ELSE '[]'::jsonb END) item
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(item->'lines') = 'array' THEN item->'lines' ELSE '[]'::jsonb END) ln
     WHERE to_regclass('public.refund_lines') IS NOT NULL AND ln->>'restock' = 'false'
     GROUP BY 1, 2
  ),
  cum AS (
    SELECT it.*,
           sum(it.amount) OVER w AS cum_amount,
           COALESCE(sum(it.amount) OVER w, 0) - it.amount AS prev_amount
      FROM it WHERE it.ok
    WINDOW w AS (PARTITION BY it.sale_id, it.product_id ORDER BY it.ord_at, it.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  )
  SELECT req.id, req.sale_id,
         COALESCE((SELECT sum(c.amount) FROM cum c WHERE c.id = req.id), 0)::bigint,
         COALESCE((SELECT sum(round(greatest(c.qty - COALESCE(nr.q, 0), 0) * co.qc / co.q)) FROM cum c JOIN cost co
                     ON co.sale_id = c.sale_id AND co.product_id = c.product_id AND co.costed
                     LEFT JOIN norestock nr ON nr.id = c.id AND nr.product_id = c.product_id
                    WHERE c.id = req.id), 0)::bigint,
         EXISTS (SELECT 1 FROM cum c LEFT JOIN cost co ON co.sale_id = c.sale_id AND co.product_id = c.product_id
                  WHERE c.id = req.id AND COALESCE(co.costed, false) = false),
         EXISTS (SELECT 1 FROM cum c LEFT JOIN net n ON n.sale_id = c.sale_id AND n.product_id = c.product_id
                  WHERE c.id = req.id AND c.cum_amount > COALESCE(n.net, 0) AND c.prev_amount <= COALESCE(n.net, 0)),
         EXISTS (SELECT 1 FROM it WHERE it.id = req.id AND NOT it.ok)
    FROM req;
$$;

-- ------------------------------------------------------------
-- Script 2 (f124): money per payment method from the records PFIN-D / PFIN-E keep, when they exist:
--   fin_sale_method_amounts: a sale's payment lines (they add up to its total)
--   fin_refund_method_amounts: a refund request's recorded payouts
-- Empty when those tables are absent (the legacy rule, the sale's own method, applies).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_sale_method_amounts(p_sale_ids text[])
RETURNS TABLE (sale_id text, method text, amount bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('public.sale_payments') IS NULL THEN RETURN; END IF;
  RETURN QUERY EXECUTE 'SELECT p.sale_id, p.method, sum(p.amount_mmk)::bigint FROM public.sale_payments p WHERE p.sale_id = ANY ($1) GROUP BY 1, 2'
    USING p_sale_ids;
END $$;
CREATE OR REPLACE FUNCTION public.fin_refund_method_amounts(p_request_ids text[])
RETURNS TABLE (request_id text, method text, amount bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('public.refund_payouts') IS NULL THEN RETURN; END IF;
  RETURN QUERY EXECUTE 'SELECT p.request_id, p.method, sum(p.amount_mmk)::bigint FROM public.refund_payouts p WHERE p.request_id = ANY ($1) GROUP BY 1, 2'
    USING p_request_ids;
END $$;

-- ------------------------------------------------------------
-- fin_report_summary
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_report_summary(
  p_shop_id text, p_from date, p_to date, p_refund_basis text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
SET statement_timeout = '30s'
AS $$
DECLARE
  v_scope    jsonb := fin_report_scope(p_shop_id);
  v_shops    text[];
  v_cashier  text;
  v_profit   boolean;
  v_supplier boolean;
  v_appr     boolean;
  v_lo       timestamptz;
  v_hi       timestamptz;
  v_out      jsonb;
BEGIN
  IF p_refund_basis IS NULL OR p_refund_basis NOT IN ('SALE_DATE', 'APPROVAL_DATE') THEN
    RAISE EXCEPTION 'Refund basis must be SALE_DATE or APPROVAL_DATE';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Invalid report date range';
  END IF;
  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION 'A report covers at most 367 days';
  END IF;
  IF v_scope->>'level' = 'ORG' AND p_to - p_from > 92 THEN
    RAISE EXCEPTION 'An all-shops report covers at most 93 days; report per shop for longer ranges';
  END IF;

  v_shops    := ARRAY(SELECT jsonb_array_elements_text(v_scope->'shopIds'));
  v_cashier  := v_scope->>'cashierId';
  v_profit   := (v_scope->>'profit')::boolean;
  v_supplier := (v_scope->>'supplier')::boolean;
  v_appr     := p_refund_basis = 'APPROVAL_DATE';
  -- Asia/Yangon has no DST: a business day is [00:00, 24:00) at UTC+06:30.
  v_lo := p_from::timestamp AT TIME ZONE 'Asia/Yangon';
  v_hi := (p_to + 1)::timestamp AT TIME ZONE 'Asia/Yangon';

  WITH
  -- sales rung up in the range, in scope
  sr AS (
    SELECT s.id, s.total_mmk::bigint AS total, s.payment_method AS method, s.status,
           (s.created_at AT TIME ZONE 'Asia/Yangon')::date AS bday
      FROM sales s
     WHERE s.shop_id = ANY (v_shops)
       AND s.created_at >= v_lo AND s.created_at < v_hi
       AND (v_cashier IS NULL OR s.cashier_id = v_cashier)
  ),
  sr_cost AS (
    SELECT si.sale_id,
           COALESCE(sum(si.qty_units::bigint * si.unit_cost_mmk), 0)::bigint AS cogs,
           count(*) FILTER (WHERE si.unit_cost_mmk IS NULL) AS missing
      FROM fin_line_costs(ARRAY(SELECT id FROM sr)) si GROUP BY si.sale_id
  ),
  -- approved partial refunds: of sales in the range, plus (approval basis)
  -- those approved in the range for in-scope sales of any date
  rq AS (
    SELECT r.id FROM refund_void_requests r
     WHERE r.sale_id IN (SELECT id FROM sr) AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
    UNION
    SELECT a.entity_id FROM audit_logs a
     WHERE v_appr AND a.action_type = 'REFUND' AND a.entity_type = 'Refund'
       AND a.message LIKE 'Refund approved for sale %'
       AND a.shop_id = ANY (v_shops) AND a.created_at >= v_lo AND a.created_at < v_hi
  ),
  req AS (
    SELECT r.id, s.id AS sale_id, s.payment_method AS method,
           (s.created_at AT TIME ZONE 'Asia/Yangon')::date AS sale_bday
      FROM rq JOIN refund_void_requests r ON r.id = rq.id AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
      JOIN sales s ON s.id = r.sale_id
     WHERE s.shop_id = ANY (v_shops) AND (v_cashier IS NULL OR s.cashier_id = v_cashier)
  ),
  rfig AS (SELECT * FROM fin_refund_lines(ARRAY(SELECT id FROM req))),
  rtime AS (
    SELECT * FROM fin_approval_times('REFUND', CASE WHEN v_appr THEN ARRAY(SELECT id FROM req) ELSE '{}'::text[] END)
  ),
  -- voids: only the approval basis deducts them (the sale basis leaves the
  -- voided sale out of gross instead)
  vq AS (
    SELECT id FROM sr WHERE v_appr AND status = 'VOID'
    UNION
    SELECT a.entity_id FROM audit_logs a
     WHERE v_appr AND a.action_type = 'VOID_SALE' AND a.entity_type = 'Sale'
       AND a.message LIKE 'Void approved for sale %'
       AND a.shop_id = ANY (v_shops) AND a.created_at >= v_lo AND a.created_at < v_hi
  ),
  vs AS (
    SELECT s.id, s.payment_method AS method, s.total_mmk::bigint AS total,
           (s.created_at AT TIME ZONE 'Asia/Yangon')::date AS sale_bday
      FROM vq JOIN sales s ON s.id = vq.id AND s.status = 'VOID'
     WHERE s.shop_id = ANY (v_shops) AND (v_cashier IS NULL OR s.cashier_id = v_cashier)
  ),
  vcost AS (
    SELECT si.sale_id, COALESCE(sum(si.qty_units::bigint * si.unit_cost_mmk), 0)::bigint AS cogs,
           bool_or(si.unit_cost_mmk IS NULL) AS missing
      FROM fin_line_costs(ARRAY(SELECT id FROM vs)) si GROUP BY si.sale_id
  ),
  vtime AS (SELECT * FROM fin_approval_times('VOID', ARRAY(SELECT id FROM vs))),
  adj AS (
    SELECT 'REFUND'::text AS kind, q.id AS req_id, q.sale_id, q.method, q.sale_bday, t.approved_at,
           f.amount_mmk AS amount, f.cogs_mmk AS cogs, f.cost_missing, f.above_net_paid, f.unparseable
      FROM req q JOIN rfig f ON f.request_id = q.id LEFT JOIN rtime t ON t.id = q.id
    UNION ALL
    SELECT 'VOID', NULL::text, v.id, v.method, v.sale_bday, t.approved_at, v.total, COALESCE(c.cogs, 0),
           COALESCE(c.missing, false), false, false
      FROM vs v LEFT JOIN vcost c ON c.sale_id = v.id LEFT JOIN vtime t ON t.id = v.id
  ),
  -- where each adjustment lands: a business day, or "undated"
  adj_placed AS (
    SELECT adj.*,
           CASE
             WHEN NOT v_appr THEN CASE WHEN adj.sale_bday BETWEEN p_from AND p_to THEN adj.sale_bday END
             WHEN adj.approved_at >= v_lo AND adj.approved_at < v_hi THEN (adj.approved_at AT TIME ZONE 'Asia/Yangon')::date
           END AS bday,
           (v_appr AND adj.approved_at IS NULL AND adj.sale_bday BETWEEN p_from AND p_to) AS undated
      FROM adj
  ),
  -- one row per money event on a business day
  ev AS (
    SELECT sr.bday, sr.method, sr.id AS sale_id, NULL::text AS req_id,
           sr.total AS gross, 0::bigint AS refund, 0::bigint AS void,
           COALESCE(c.cogs, 0) AS cogs_in, 0::bigint AS cogs_out,
           COALESCE(c.missing, 0) AS missing_lines, 0 AS missing_adj, 0 AS undated_n,
           1 AS sale_n, 0 AS refund_n, 0 AS void_n
      FROM sr LEFT JOIN sr_cost c ON c.sale_id = sr.id
     WHERE v_appr OR sr.status <> 'VOID'
    UNION ALL
    -- an approved adjustment with no approval time: no money placed, but the
    -- profit of the day its sale was rung up (and of the totals) is incomplete
    SELECT a.sale_bday, a.method, a.sale_id, a.req_id, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0
      FROM adj_placed a WHERE a.undated
    UNION ALL
    SELECT a.bday, a.method, a.sale_id, a.req_id, 0,
           CASE WHEN a.kind = 'REFUND' THEN a.amount ELSE 0 END,
           CASE WHEN a.kind = 'VOID' THEN a.amount ELSE 0 END,
           0, a.cogs, 0, CASE WHEN a.cost_missing THEN 1 ELSE 0 END, 0, 0,
           CASE WHEN a.kind = 'REFUND' THEN 1 ELSE 0 END,
           CASE WHEN a.kind = 'VOID' THEN 1 ELSE 0 END
      FROM adj_placed a WHERE a.bday IS NOT NULL
  ),
  tot AS (
    SELECT COALESCE(sum(gross), 0) AS gross, COALESCE(sum(refund), 0) AS refund, COALESCE(sum(void), 0) AS void,
           COALESCE(sum(cogs_in), 0) - COALESCE(sum(cogs_out), 0) AS cogs,
           COALESCE(sum(missing_lines), 0) AS missing_lines, COALESCE(sum(missing_adj), 0) + COALESCE(sum(undated_n), 0) AS missing_adj,
           COALESCE(sum(sale_n), 0) AS sale_n, COALESCE(sum(refund_n), 0) AS refund_n, COALESCE(sum(void_n), 0) AS void_n
      FROM ev
  ),
  days AS (
    SELECT d::date AS bday FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  ),
  by_day AS (
    SELECT d.bday,
           COALESCE(sum(ev.sale_n), 0) AS sale_n, COALESCE(sum(ev.gross), 0) AS gross,
           COALESCE(sum(ev.refund_n), 0) AS refund_n, COALESCE(sum(ev.refund), 0) AS refund,
           COALESCE(sum(ev.void_n), 0) AS void_n, COALESCE(sum(ev.void), 0) AS void,
           COALESCE(sum(ev.cogs_in), 0) - COALESCE(sum(ev.cogs_out), 0) AS cogs,
           COALESCE(sum(ev.missing_lines), 0) + COALESCE(sum(ev.missing_adj), 0) + COALESCE(sum(ev.undated_n), 0) AS missing
      FROM days d LEFT JOIN ev ON ev.bday = d.bday GROUP BY d.bday
  ),
  -- sales and voids by the sale's payment lines (when recorded), refunds by their recorded payouts; otherwise the
  -- sale's legacy method (Script 2, f124)
  pay AS (SELECT * FROM fin_sale_method_amounts(ARRAY(SELECT DISTINCT e.sale_id FROM ev e WHERE e.gross <> 0 OR e.void <> 0))),
  rpay AS (SELECT * FROM fin_refund_method_amounts(ARRAY(SELECT DISTINCT e.req_id FROM ev e WHERE e.refund <> 0 AND e.req_id IS NOT NULL))),
  by_method AS (
    SELECT x.method, sum(x.gross) AS gross, sum(x.refund) AS refund, sum(x.void) AS void FROM (
      SELECT COALESCE(p.method, e.method) AS method,
             CASE WHEN e.gross <> 0 THEN COALESCE(p.amount, e.gross) ELSE 0 END AS gross, 0::bigint AS refund,
             CASE WHEN e.void <> 0 THEN COALESCE(p.amount, e.void) ELSE 0 END AS void
        FROM ev e LEFT JOIN pay p ON p.sale_id = e.sale_id AND (e.gross <> 0 OR e.void <> 0)
       WHERE e.refund = 0
      UNION ALL
      SELECT COALESCE(r.method, e.method), 0, COALESCE(r.amount, e.refund), 0
        FROM ev e LEFT JOIN rpay r ON r.request_id = e.req_id WHERE e.refund <> 0
    ) x GROUP BY x.method
  ),
  -- requests not decided yet, on sales rung up in the range (any basis)
  pend AS (
    SELECT r.id, r.type, s.total_mmk,
           (SELECT COALESCE(sum(f.amount) FILTER (WHERE f.ok), 0) FROM fin_items(r.items) f) AS amount,
           (r.type = 'PARTIAL' AND (r.items IS NULL OR EXISTS (SELECT 1 FROM fin_items(r.items) f WHERE NOT f.ok))) AS bad
      FROM refund_void_requests r JOIN sales s ON s.id = r.sale_id
     WHERE r.status = 'REQUESTED' AND s.id IN (SELECT id FROM sr)
  ),
  sup AS (
    SELECT count(*) FILTER (WHERE sp.voided_at IS NULL) AS n,
           COALESCE(sum(sp.amount_mmk) FILTER (WHERE sp.voided_at IS NULL), 0) AS paid,
           COALESCE(sum(sp.amount_mmk) FILTER (WHERE sp.voided_at IS NULL AND sp.payment_method = 'CASH'), 0) AS cash,
           COALESCE(sum(sp.amount_mmk) FILTER (WHERE sp.voided_at IS NOT NULL), 0) AS voided
      FROM supplier_payments sp
     WHERE v_supplier AND sp.shop_id = ANY (v_shops) AND sp.paid_at >= v_lo AND sp.paid_at < v_hi
  ),
  -- sales whose approved partial refunds (all of them, any date) exceed the
  -- total, among the sales of the adjustments considered (under APPROVAL_DATE
  -- that includes in-range sales whose refunds were approved after the range,
  -- so this count is not limited to refunds placed in the range)
  over_total AS (
    SELECT s.id FROM sales s
     WHERE s.id IN (SELECT sale_id FROM req)
       AND (SELECT COALESCE(sum(f.amount) FILTER (WHERE f.ok), 0)
              FROM refund_void_requests r CROSS JOIN LATERAL fin_items(r.items) f
             WHERE r.sale_id = s.id AND r.type = 'PARTIAL' AND r.status = 'APPROVED') > s.total_mmk
  )
  SELECT jsonb_build_object(
    'basis', jsonb_build_object(
      'timezone', 'Asia/Yangon', 'refundBasis', p_refund_basis,
      'from', p_from, 'to', p_to, 'fromUtc', v_lo, 'toUtcExclusive', v_hi, 'asOf', now(),
      'refundMethodAssumption', 'ORIGINAL_SALE_METHOD',
      'pendingRequestsBasis', 'SALES_RUNG_UP_IN_RANGE'),
    'scope', jsonb_build_object('level', v_scope->'level', 'shopIds', v_scope->'shopIds', 'profitVisible', v_profit),
    'totals', (SELECT jsonb_build_object(
        'saleCount', sale_n, 'grossSalesMmk', gross,
        'refundCount', refund_n, 'refundMmk', refund,
        'voidCount', void_n, 'voidMmk', void,
        'netRevenueMmk', gross - refund - void,
        'cogsMmk', CASE WHEN v_profit THEN cogs END,
        'cogsComplete', CASE WHEN v_profit THEN missing_lines + missing_adj = 0 END,
        'grossProfitMmk', CASE WHEN v_profit AND missing_lines + missing_adj = 0 THEN gross - refund - void - cogs END,
        'linesMissingCost', CASE WHEN v_profit THEN missing_lines END,
        'adjustmentsMissingCost', CASE WHEN v_profit THEN missing_adj END) FROM tot),   -- incl. undated adjustments (APPROVAL_DATE)
    'excludedVoids', CASE WHEN NOT v_appr THEN (
        SELECT jsonb_build_object('count', count(*), 'amountMmk', COALESCE(sum(total), 0)) FROM sr WHERE status = 'VOID') END,
    'undatedAdjustments', (
        SELECT jsonb_build_object('count', count(*), 'amountMmk', COALESCE(sum(amount), 0),
                                  'refundCount', count(*) FILTER (WHERE kind = 'REFUND'),
                                  'voidCount', count(*) FILTER (WHERE kind = 'VOID'))
          FROM adj_placed WHERE undated),
    'pendingRequests', (SELECT jsonb_build_object(
        'count', count(*),
        'amountMmk', COALESCE(sum(CASE WHEN type = 'VOID' THEN total_mmk ELSE amount END), 0),
        'unparseable', count(*) FILTER (WHERE bad)) FROM pend),
    'byDay', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'date', bday, 'saleCount', sale_n, 'grossSalesMmk', gross,
        'refundCount', refund_n, 'refundMmk', refund, 'voidCount', void_n, 'voidMmk', void,
        'netRevenueMmk', gross - refund - void,
        'cogsMmk', CASE WHEN v_profit THEN cogs END,
        'cogsComplete', CASE WHEN v_profit THEN missing = 0 END,
        'grossProfitMmk', CASE WHEN v_profit AND missing = 0 THEN gross - refund - void - cogs END) ORDER BY bday), '[]'::jsonb)
      FROM by_day),
    'byPaymentMethod', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'method', method, 'grossSalesMmk', gross, 'refundMmk', refund, 'voidMmk', void,
        'netMmk', gross - refund - void) ORDER BY method), '[]'::jsonb) FROM by_method),
    'supplierPayments', CASE WHEN v_supplier THEN (SELECT jsonb_build_object(
        'count', n, 'paidMmk', paid, 'cashPaidMmk', cash, 'voidedMmk', voided, 'dateField', 'paid_at') FROM sup) END,
    'evidence', jsonb_build_object(
        'refundsAboveNetPaid', (SELECT count(*) FROM adj_placed WHERE kind = 'REFUND' AND above_net_paid
                                  AND (bday IS NOT NULL OR undated)),
        'salesRefundedAboveTotal', (SELECT count(*) FROM over_total),
        'unparseableApprovedRefunds', (SELECT count(*) FROM adj_placed WHERE kind = 'REFUND' AND unparseable
                                         AND (bday IS NOT NULL OR undated)))
  ) INTO v_out;

  RETURN v_out;
END;
$$;

-- ------------------------------------------------------------
-- fin_shift_reconciliation
--
-- Drawer events of one shift, each with its evidence. Nothing is inferred.
--   close cut-off   the server time close_shift actually ran: the created_at
--                   of its committed idempotency-ledger row in the shift's org
--                   (close_shift needs a key since 063). ended_at alone may be
--                   a client stamp up to 48 h earlier (offline close). The row
--                   or its response can be gone (062's 30-day prune before 086,
--                   086's 13-month prune, op_purge_responses): the shift then
--                   reports closeTimeSource ENDED_AT_ONLY and a close window,
--                   never a guess.
--   cash in         CASH sales rung up on the shift (total = paid − change),
--                   including sales voided or refunded later
--   attributed      refunds / voids of THIS shift's CASH sales approved
--                   before the cut-off: what close_shift deducted (070), so
--                   evidenceExpectedCashMmk reproduces the stored figure
--   closeWindow     only when the server close time is NOT on record:
--                   approvals between ended_at and ended_at + 48 h. close_shift
--                   may or may not have deducted them: listed, NOT deducted
--   afterClose      approved after the cut-off: the money left another drawer
--                   or the safe; no payout record says which (planned 089)
--   unknownTime     approved, but no server approval time exists: listed
--   crossShift      refunds / voids of OTHER shifts' CASH sales of this shop
--                   approved while this shift was open: candidates for
--                   explaining a variance, NOT deducted (paying drawer unknown)
--   supplierCash    CASH supplier payments (paid_at) while the shift was open,
--                   in this shop: informational, NOT deducted
--   cashMovements   pay-in / pay-out are not recorded before 089: reported as
--                   not recorded (never as zero)
-- Residual race, both directions: the cut-off is close_shift's transaction
-- start, but it read approved refunds under a later snapshot. An approval
-- started before the cut-off but committed after close_shift read is
-- classified ATTRIBUTED although not deducted; one started after the cut-off
-- but committed before the read was deducted although classified
-- AFTER_CLOSE. storedMatchesEvidence then reports the mismatch; nothing is
-- rewritten (I-8). Unknown-time items were deducted by close_shift if they
-- existed when it ran: see storedMatchesEvidenceIfUnknownTimeDeducted.
-- Detail level: other cashiers' events (crossShift) only for callers with
-- shop-wide access (ADMIN, or shift:manage_all / report:shop_sales); their
-- receipts and ids additionally need ADMIN or sale:view; supplier payments
-- follow the summary report's supplier rule.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_shift_reconciliation(p_shift_id text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
SET statement_timeout = '30s'
AS $$
DECLARE
  v_user     users;
  v_shift    shifts;
  v_admin    boolean;
  v_full     boolean;
  v_items    boolean;
  v_supplier boolean;
  v_close_at timestamptz;
  v_cut      timestamptz;
  v_open_end timestamptz;
  v_window   timestamptz;
  v_out      jsonb;
  v_cash     jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_shift_id IS NULL OR btrim(p_shift_id) = '' THEN RAISE EXCEPTION 'Shift is required'; END IF;

  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id;
  -- the same answer for another organisation's shift and for no shift
  IF v_shift.id IS NULL OR NOT app_shop_in_org(v_shift.shop_id) THEN RAISE EXCEPTION 'Shift not found'; END IF;

  v_admin := app_role() = 'ADMIN';
  v_full := v_admin
         OR ((app_has_perm('shift:manage_all') OR app_has_perm('report:shop_sales'))
             AND v_shift.shop_id = v_user.shop_id);
  IF NOT v_full AND NOT (
       (app_has_perm('shift:manage_own') OR app_has_perm('report:own_shift'))
       AND v_shift.cashier_id = v_user.id) THEN
    RAISE EXCEPTION 'You are not permitted to view this shift';
  END IF;
  v_items    := v_full AND (v_admin OR app_has_perm('sale:view'));
  v_supplier := v_full AND (v_admin OR app_has_perm('supplier:debt_view') OR app_has_perm('purchase:view'));

  IF v_shift.ended_at IS NULL THEN
    v_cut := 'infinity';                       -- open: everything visible happened while open
  ELSE
    SELECT min(k.created_at) INTO v_close_at
      FROM idempotency_keys k
     WHERE k.rpc = 'close_shift'
       AND k.state = 'committed'
       AND k.org_id = (SELECT sh.org_id FROM shops sh WHERE sh.id = v_shift.shop_id)
       AND k.created_at >= v_shift.ended_at - interval '5 minutes'
       AND k.created_at <= v_shift.ended_at + interval '48 hours 5 minutes'
       AND k.response->'shift'->>'id' = v_shift.id;
    -- what close_shift saw is decided by when it RAN, not by its (possibly
    -- client-stamped, up to 5 min fast or 48 h slow) ended_at
    v_cut := COALESCE(v_close_at, v_shift.ended_at);
    IF v_close_at IS NULL THEN
      v_window := v_shift.ended_at + interval '48 hours';
    END IF;
  END IF;

  -- events "while the shift was open" (other shifts' payouts, supplier cash): the later of the two ends
  v_open_end := CASE WHEN v_shift.ended_at IS NULL THEN 'infinity'::timestamptz ELSE greatest(v_shift.ended_at, v_cut) END;

  WITH
  own_sales AS (SELECT s.* FROM sales s WHERE s.shift_id = v_shift.id),
  own_req AS (
    SELECT r.id, r.sale_id, s.receipt_no FROM own_sales s
      JOIN refund_void_requests r ON r.sale_id = s.id AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
     WHERE s.payment_method = 'CASH'
  ),
  own_void AS (SELECT s.id, s.receipt_no, s.total_mmk FROM own_sales s WHERE s.payment_method = 'CASH' AND s.status = 'VOID'),
  own_adj AS (
    SELECT 'REFUND'::text AS kind, q.id AS ref_id, q.sale_id, q.receipt_no, t.approved_at, f.amount_mmk AS amount
      FROM own_req q JOIN fin_refund_lines(ARRAY(SELECT id FROM own_req)) f ON f.request_id = q.id
      LEFT JOIN fin_approval_times('REFUND', ARRAY(SELECT id FROM own_req)) t ON t.id = q.id
    UNION ALL
    SELECT 'VOID', v.id, v.id, v.receipt_no, t.approved_at, v.total_mmk::bigint
      FROM own_void v LEFT JOIN fin_approval_times('VOID', ARRAY(SELECT id FROM own_void)) t ON t.id = v.id
  ),
  own_cls AS (
    SELECT a.*, CASE WHEN a.approved_at IS NULL THEN 'UNKNOWN_TIME'
                     WHEN a.approved_at <= v_cut THEN 'ATTRIBUTED'
                     WHEN v_window IS NOT NULL AND a.approved_at <= v_window THEN 'CLOSE_WINDOW'
                     ELSE 'AFTER_CLOSE' END AS cls
      FROM own_adj a
  ),
  cross_ev AS (
    SELECT CASE a.action_type WHEN 'REFUND' THEN 'REFUND' ELSE 'VOID' END AS kind, a.entity_id AS ref_id,
           min(a.created_at) AS approved_at
      FROM audit_logs a
     WHERE a.shop_id = v_shift.shop_id
       AND ((a.action_type = 'REFUND' AND a.entity_type = 'Refund' AND a.message LIKE 'Refund approved for sale %')
         OR (a.action_type = 'VOID_SALE' AND a.entity_type = 'Sale' AND a.message LIKE 'Void approved for sale %'))
       AND a.created_at >= v_shift.started_at AND a.created_at <= v_open_end
     GROUP BY 1, 2
  ),
  cross_adj AS (
    SELECT e.kind, e.ref_id, s.id AS sale_id, s.receipt_no, s.shift_id AS sale_shift_id, e.approved_at,
           CASE WHEN e.kind = 'REFUND' THEN f.amount_mmk ELSE s.total_mmk::bigint END AS amount
      FROM cross_ev e
      LEFT JOIN refund_void_requests r ON e.kind = 'REFUND' AND r.id = e.ref_id AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
      JOIN sales s ON s.id = CASE WHEN e.kind = 'REFUND' THEN r.sale_id ELSE e.ref_id END
      LEFT JOIN fin_refund_lines(ARRAY(SELECT ref_id FROM cross_ev WHERE kind = 'REFUND')) f ON f.request_id = e.ref_id
     WHERE s.shop_id = v_shift.shop_id AND s.shift_id IS DISTINCT FROM v_shift.id AND s.payment_method = 'CASH'
       AND (e.kind = 'VOID' AND s.status = 'VOID' OR e.kind = 'REFUND' AND r.id IS NOT NULL)
  ),
  cash_in AS (
    SELECT count(*) AS n, COALESCE(sum(total_mmk), 0)::bigint AS amount FROM own_sales WHERE payment_method = 'CASH'
  ),
  sums AS (
    SELECT COALESCE(sum(amount) FILTER (WHERE cls = 'ATTRIBUTED'), 0)::bigint AS attributed,
           COALESCE(sum(amount) FILTER (WHERE cls = 'CLOSE_WINDOW'), 0)::bigint AS window_amt,
           COALESCE(sum(amount) FILTER (WHERE cls = 'UNKNOWN_TIME'), 0)::bigint AS unknown_amt
      FROM own_cls
  ),
  supplier_cash AS (
    SELECT count(*) AS n, COALESCE(sum(sp.amount_mmk), 0)::bigint AS amount
      FROM supplier_payments sp
     WHERE sp.shop_id = v_shift.shop_id AND sp.payment_method = 'CASH' AND sp.voided_at IS NULL
       AND sp.paid_at >= v_shift.started_at AND sp.paid_at <= v_open_end
  ),
  ex AS (
    SELECT v_shift.opening_cash_mmk + (SELECT amount FROM cash_in) - (SELECT attributed FROM sums) AS expected
  )
  SELECT jsonb_build_object(
    'shift', jsonb_build_object(
      'id', v_shift.id, 'shopId', v_shift.shop_id, 'cashierId', v_shift.cashier_id,
      'status', CASE WHEN v_shift.ended_at IS NULL THEN 'OPEN' ELSE 'CLOSED' END,
      'startedAt', v_shift.started_at, 'endedAt', v_shift.ended_at,
      'closeRecordedAt', v_close_at,
      'closeTimeSource', CASE WHEN v_shift.ended_at IS NULL THEN NULL
                              WHEN v_close_at IS NOT NULL THEN 'SERVER_LEDGER' ELSE 'ENDED_AT_ONLY' END,
      'openingCashMmk', v_shift.opening_cash_mmk, 'closingCashMmk', v_shift.closing_cash_mmk,
      'storedExpectedCashMmk', v_shift.expected_cash_mmk, 'storedVarianceMmk', v_shift.variance_mmk,
      'varianceReason', v_shift.variance_reason),
    'cashSales', (SELECT jsonb_build_object('count', n, 'amountMmk', amount) FROM cash_in),
    'nonCashSales', (SELECT COALESCE(jsonb_agg(jsonb_build_object('method', m, 'count', n, 'amountMmk', amt) ORDER BY m), '[]'::jsonb)
                       FROM (SELECT payment_method AS m, count(*) AS n, sum(total_mmk)::bigint AS amt
                               FROM own_sales WHERE payment_method <> 'CASH' AND status <> 'VOID' GROUP BY payment_method) x),
    'attributedPayouts', (SELECT jsonb_build_object(
        'count', count(*), 'amountMmk', COALESCE(sum(amount), 0),
        'refundMmk', COALESCE(sum(amount) FILTER (WHERE kind = 'REFUND'), 0),
        'voidMmk', COALESCE(sum(amount) FILTER (WHERE kind = 'VOID'), 0)) FROM own_cls WHERE cls = 'ATTRIBUTED'),
    'closeWindowPayouts', (SELECT jsonb_build_object(
        'count', count(*), 'amountMmk', COALESCE(sum(amount), 0),
        'items', COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'id', ref_id, 'saleId', sale_id, 'receiptNo', receipt_no,
                                                       'approvedAt', approved_at, 'amountMmk', amount) ORDER BY approved_at, ref_id), '[]'::jsonb))
        FROM own_cls WHERE cls = 'CLOSE_WINDOW'),
    'afterClosePayouts', (SELECT jsonb_build_object(
        'count', count(*), 'amountMmk', COALESCE(sum(amount), 0),
        'items', COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'id', ref_id, 'saleId', sale_id, 'receiptNo', receipt_no,
                                                       'approvedAt', approved_at, 'amountMmk', amount) ORDER BY approved_at, ref_id), '[]'::jsonb))
        FROM own_cls WHERE cls = 'AFTER_CLOSE'),
    'unknownTimePayouts', (SELECT jsonb_build_object(
        'count', count(*), 'amountMmk', COALESCE(sum(amount), 0),
        'items', COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'id', ref_id, 'saleId', sale_id, 'receiptNo', receipt_no,
                                                       'amountMmk', amount) ORDER BY ref_id), '[]'::jsonb))
        FROM own_cls WHERE cls = 'UNKNOWN_TIME'),
    'crossShiftPayoutsDuringShift', CASE WHEN v_full THEN (SELECT jsonb_build_object(
        'count', count(*), 'amountMmk', COALESCE(sum(amount), 0),
        'items', CASE WHEN v_items THEN COALESCE(jsonb_agg(jsonb_build_object(
                   'kind', kind, 'id', ref_id, 'saleId', sale_id, 'receiptNo', receipt_no, 'saleShiftId', sale_shift_id,
                   'approvedAt', approved_at, 'amountMmk', amount) ORDER BY approved_at, ref_id), '[]'::jsonb) END)
        FROM cross_adj) END,
    'supplierCashPaymentsDuringShift', CASE WHEN v_supplier THEN (
        SELECT jsonb_build_object('count', n, 'amountMmk', amount, 'dateField', 'paid_at') FROM supplier_cash) END,
    'cashMovements', jsonb_build_object('recorded', false, 'reason', 'NOT_RECORDED_BEFORE_CASH_MOVEMENTS'),
    'evidenceExpectedCashMmk', (SELECT expected FROM ex),
    'evidenceVarianceMmk', CASE WHEN v_shift.ended_at IS NOT NULL THEN v_shift.closing_cash_mmk - (SELECT expected FROM ex) END,
    'storedMatchesEvidence', CASE WHEN v_shift.ended_at IS NOT NULL THEN v_shift.expected_cash_mmk = (SELECT expected FROM ex) END,
    'storedMatchesEvidenceIfCloseWindowDeducted', CASE WHEN v_shift.ended_at IS NOT NULL AND (SELECT window_amt FROM sums) > 0 THEN
        v_shift.expected_cash_mmk = (SELECT expected FROM ex) - (SELECT window_amt FROM sums) END,
    -- close_shift deducted every approved refund / void that existed when it ran, audit row or not
    'storedMatchesEvidenceIfUnknownTimeDeducted', CASE WHEN v_shift.ended_at IS NOT NULL AND (SELECT unknown_amt FROM sums) > 0 THEN
        v_shift.expected_cash_mmk = (SELECT expected FROM ex) - (SELECT unknown_amt FROM sums) END,
    'asOf', now()
  ) INTO v_out;

  -- Script 2 (financial review H1): with PFIN-D the authoritative drawer is fin_shift_cash (split payments' cash part,
  -- cash movements, recorded refund payouts; every approved refund of the shift's sales deducted, P-3). The evidence
  -- figures are replaced by it, so no screen shows a pre-PFIN-D "expected cash" as server-verified. Unchanged without PFIN-D.
  IF to_regprocedure('public.fin_shift_cash(text)') IS NOT NULL THEN
    EXECUTE 'SELECT public.fin_shift_cash($1)' INTO v_cash USING v_shift.id;
    v_out := v_out || jsonb_build_object(
      'model', 'PFIN-D',
      'cashSales', jsonb_build_object('count', v_out->'cashSales'->'count', 'amountMmk', (v_cash->>'cashSalesMmk')::bigint),
      'attributedPayouts', jsonb_build_object('count', v_out->'attributedPayouts'->'count', 'amountMmk', (v_cash->>'cashRefundsMmk')::bigint,
                                              'refundMmk', (v_cash->>'cashRefundsMmk')::bigint, 'voidMmk', 0),
      -- the payout-timing groups do not apply: fin_shift_cash already deducts every approved refund of this shift's sales
      'closeWindowPayouts', jsonb_build_object('count', 0, 'amountMmk', 0, 'items', '[]'::jsonb),
      'afterClosePayouts', jsonb_build_object('count', 0, 'amountMmk', 0, 'items', '[]'::jsonb),
      'unknownTimePayouts', jsonb_build_object('count', 0, 'amountMmk', 0, 'items', '[]'::jsonb),
      'cashMovements', jsonb_build_object('recorded', true, 'reason', 'RECORDED',
                                          'inMmk', (v_cash->>'movementsInMmk')::bigint, 'outMmk', (v_cash->>'movementsOutMmk')::bigint),
      'evidenceExpectedCashMmk', (v_cash->>'expectedCashMmk')::bigint,
      'evidenceVarianceMmk', CASE WHEN v_shift.closing_cash_mmk IS NOT NULL THEN v_shift.closing_cash_mmk - (v_cash->>'expectedCashMmk')::bigint END,
      'storedMatchesEvidence', CASE WHEN v_shift.ended_at IS NOT NULL THEN v_shift.expected_cash_mmk = (v_cash->>'expectedCashMmk')::bigint END,
      'storedMatchesEvidenceIfCloseWindowDeducted', NULL,
      'storedMatchesEvidenceIfUnknownTimeDeducted', NULL);
  END IF;

  RETURN v_out;
END;
$$;

-- ------------------------------------------------------------
-- Ownership and privileges. Owned by postgres like every business function
-- (080/081/086); the two report entry points for signed-in users, helpers
-- for nobody but the owner and service_role (they bypass RLS and take ids
-- from the caller).
-- ------------------------------------------------------------
ALTER FUNCTION public.fin_report_scope(text) OWNER TO postgres;
ALTER FUNCTION public.fin_items(jsonb) OWNER TO postgres;
ALTER FUNCTION public.fin_sale_line_net(text[]) OWNER TO postgres;
ALTER FUNCTION public.fin_approval_times(text, text[]) OWNER TO postgres;
ALTER FUNCTION public.fin_line_costs(text[]) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_lines(text[]) OWNER TO postgres;
ALTER FUNCTION public.fin_sale_method_amounts(text[]) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_method_amounts(text[]) OWNER TO postgres;
ALTER FUNCTION public.fin_report_summary(text, date, date, text) OWNER TO postgres;
ALTER FUNCTION public.fin_shift_reconciliation(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fin_report_scope(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_items(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_sale_line_net(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_approval_times(text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_line_costs(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_refund_lines(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_sale_method_amounts(text[]), public.fin_refund_method_amounts(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_report_scope(text), public.fin_items(jsonb), public.fin_sale_line_net(text[]),
  public.fin_approval_times(text, text[]), public.fin_refund_lines(text[]), public.fin_line_costs(text[]),
  public.fin_sale_method_amounts(text[]), public.fin_refund_method_amounts(text[]) TO service_role;

REVOKE ALL ON FUNCTION public.fin_report_summary(text, date, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_shift_reconciliation(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_report_summary(text, date, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_shift_reconciliation(text) TO authenticated, service_role;

RESET lock_timeout;
