-- ============================================================
-- PROVISIONAL migration PFIN-E: refund lines, refund payouts, separate restock (no number assigned)
--
-- WHY ADDITIVE
--   create_refund_void_request and approve_refund_request are pinned by 086 (MD5) and are 087 executor RPCs.
--   Their request items (jsonb) are stored verbatim and are part of the request hash. A refund item may
--   therefore carry its line detail; this migration validates and records it with triggers. No body,
--   signature, hash or reply changes.
--
-- ITEM SHAPE (per product, as the pinned approval requires one item per product)
--   { productId, qtyUnits, amountMmk,                                   -- unchanged legacy fields
--     lines:   [{ saleItemId, qtyUnits, amountMmk, restock }],         -- optional: sale-line attribution
--     payouts: [{ method, amountMmk }] }                               -- optional: how the money goes back
--   With `lines`, the line quantities and amounts add up to the item's; every saleItemId belongs to the
--   sale and to the item's product. With `payouts`, their amounts add up to the item's amount.
--
-- RULES (only for items that carry `lines`; legacy items keep their existing checks)
--   - cumulative APPROVED quantity per sale line <= the line's quantity;
--   - cumulative APPROVED amount per sale line <= the line's net paid amount after every discount
--     (PFIN-B fin_sale_line_net, the same allocation as the client's refundMath.ts);
--   - cumulative APPROVED payouts per method <= what the sale was paid with that method (PFIN-D
--     sale_payments; cash: the applied amount, never the change);
--   - restock = false (damaged / not returned) is recorded with an explicit compensating stock movement
--     RETURN_NO_RESTOCK after the pinned approval's RETURN_IN, so restoration is tracked separately.
--   Checked at request creation and again at approval (under the sale's row lock).
-- RECORDS at approval (immutable): refund_lines (sale line, product, qty, amount, restocked, cost from the
--   sale's own snapshot or NULL when unknown, sale business date, refund business date, approver) and
--   refund_payouts (method, amount). A legacy item gets ONE refund_lines row with sale_item_id NULL
--   (unattributed): no line is ever fabricated. Expected shift cash (PFIN-D fin_shift_cash) uses explicit
--   cash payouts when recorded, else the legacy rule; attribution stays on the sale's shift (P-3).
-- NOT DONE HERE: PFIN-C (a cap for LEGACY items) stays held (P-2, P-6 unresolved). Lines are a strictly
--   additive, opt-in contract of updated tills, so no released till is affected.
-- DEPENDS ON PFIN-B (fin_sale_line_net, fin_line_costs) and PFIN-D (sale_payments). Refuses after V1.
-- ROLLBACK: PFIN-E.rollback.sql (refuses while any refund line exists).
-- ============================================================

SET lock_timeout = '3s';

DO $pfin_e_pre$
DECLARE v_path text := current_setting('search_path');
BEGIN
  IF to_regprocedure('public.fin_sale_line_net(text[])') IS NULL OR to_regprocedure('public.fin_line_costs(text[])') IS NULL THEN
    RAISE EXCEPTION 'PFIN-E: apply PFIN-B first';
  END IF;
  IF to_regclass('public.sale_payments') IS NULL THEN RAISE EXCEPTION 'PFIN-E: apply PFIN-D first'; END IF;
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN
    RAISE EXCEPTION 'PFIN-E: Recovery V1 is installed; schema changes after V1 need an owner-authorized migration';
  END IF;
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PFIN-E: migration 087 is installed: run as the superuser migration runner';
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
      RAISE EXCEPTION 'PFIN-E: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
    PERFORM set_config('search_path', v_path, true);
  END IF;
END $pfin_e_pre$;

CREATE TABLE IF NOT EXISTS public.refund_lines (
  id                   text PRIMARY KEY,
  org_id               text NOT NULL,
  shop_id              text NOT NULL,
  request_id           text NOT NULL REFERENCES public.refund_void_requests(id),
  sale_id              text NOT NULL REFERENCES public.sales(id),
  sale_item_id         text REFERENCES public.sale_items(id),       -- NULL: a legacy item (no line attribution)
  product_id           text NOT NULL,
  qty_units            integer NOT NULL CHECK (qty_units > 0),
  amount_mmk           integer NOT NULL CHECK (amount_mmk >= 0),
  restocked            boolean NOT NULL,
  cost_mmk             bigint,                                        -- NULL: the sale's cost was not recorded
  reason               text NOT NULL,
  sale_business_date   date NOT NULL,
  refund_business_date date NOT NULL,
  approved_by          text NOT NULL,
  approved_at          timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS refund_lines_sale_idx ON public.refund_lines (sale_id);
CREATE INDEX IF NOT EXISTS refund_lines_request_idx ON public.refund_lines (request_id);
CREATE TABLE IF NOT EXISTS public.refund_payouts (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  shop_id      text NOT NULL,
  request_id   text NOT NULL REFERENCES public.refund_void_requests(id),
  sale_id      text NOT NULL REFERENCES public.sales(id),
  method       text NOT NULL CHECK (method IN ('CASH', 'BANK_TRANSFER', 'MOBILE_WALLET', 'CARD', 'OTHER')),
  amount_mmk   integer NOT NULL CHECK (amount_mmk > 0),
  approved_by  text NOT NULL,
  approved_at  timestamptz NOT NULL,
  UNIQUE (request_id, method)
);
CREATE INDEX IF NOT EXISTS refund_payouts_sale_idx ON public.refund_payouts (sale_id);
ALTER TABLE public.refund_lines OWNER TO postgres;
ALTER TABLE public.refund_payouts OWNER TO postgres;
ALTER TABLE public.refund_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_payouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refund_lines, public.refund_payouts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.refund_payouts TO authenticated, service_role;
GRANT SELECT ON public.refund_lines TO service_role;
-- cost stays behind report:shop_profit (P-4, PCOST-A): every column but cost_mmk
GRANT SELECT (id, org_id, shop_id, request_id, sale_id, sale_item_id, product_id, qty_units, amount_mmk, restocked, reason,
  sale_business_date, refund_business_date, approved_by, approved_at) ON public.refund_lines TO authenticated;
DROP POLICY IF EXISTS refund_lines_sel ON public.refund_lines;
DROP POLICY IF EXISTS refund_payouts_sel ON public.refund_payouts;
-- the visibility of the original sale (sales_sel); cost stays behind report:shop_profit (P-4, PCOST-A)
CREATE POLICY refund_lines_sel ON public.refund_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales s WHERE s.id = refund_lines.sale_id));
CREATE POLICY refund_payouts_sel ON public.refund_payouts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sales s WHERE s.id = refund_payouts.sale_id));
DROP TRIGGER IF EXISTS zzf_immutable ON public.refund_lines;
CREATE TRIGGER zzf_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.refund_lines FOR EACH STATEMENT EXECUTE FUNCTION public.fin_immutable();
DROP TRIGGER IF EXISTS zzf_immutable ON public.refund_payouts;
CREATE TRIGGER zzf_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.refund_payouts FOR EACH STATEMENT EXECUTE FUNCTION public.fin_immutable();

-- structure of one request's line-bearing items (NULL = fine; else the problem)
CREATE OR REPLACE FUNCTION public.fin_refund_items_problem(p_sale_id text, p_items jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it jsonb; ln jsonb; po jsonb; v_q bigint; v_a bigint; v_pa bigint; v_si sale_items; v_seen text[] := '{}'; v_m text[];
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RETURN NULL; END IF;
  -- payouts are all-or-none within one request: a request with payouts names the payout of EVERY item that pays money
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x WHERE jsonb_typeof(x) = 'object' AND x ? 'payouts')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x WHERE jsonb_typeof(x) = 'object' AND NOT x ? 'payouts'
                  AND coalesce((coalesce(x->>'amountMmk', x->>'amount_mmk'))::numeric, 0) > 0) THEN
    RETURN 'when a refund names how the money goes back, every item must name it';
  END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(it) <> 'object' THEN CONTINUE; END IF;
    IF it ? 'lines' THEN
      IF jsonb_typeof(it->'lines') <> 'array' OR jsonb_array_length(it->'lines') = 0 THEN RETURN 'refund lines must be a non-empty list'; END IF;
      v_q := 0; v_a := 0;
      FOR ln IN SELECT value FROM jsonb_array_elements(it->'lines') LOOP
        IF jsonb_typeof(ln->'qtyUnits') <> 'number' OR jsonb_typeof(ln->'amountMmk') <> 'number'
           OR (ln->>'qtyUnits')::numeric <= 0 OR (ln->>'qtyUnits')::numeric <> trunc((ln->>'qtyUnits')::numeric)
           OR (ln->>'amountMmk')::numeric < 0 OR (ln->>'amountMmk')::numeric <> trunc((ln->>'amountMmk')::numeric) THEN
          RETURN 'a refund line needs a positive whole quantity and a whole amount';
        END IF;
        IF ln ? 'restock' AND jsonb_typeof(ln->'restock') <> 'boolean' THEN RETURN 'restock must be true or false'; END IF;
        SELECT * INTO v_si FROM sale_items WHERE id = ln->>'saleItemId' AND sale_id = p_sale_id;
        IF v_si.id IS NULL THEN RETURN 'a refund line is not a line of this sale'; END IF;
        IF v_si.product_id IS DISTINCT FROM coalesce(it->>'productId', it->>'product_id') THEN RETURN 'a refund line belongs to another product'; END IF;
        IF v_si.id = ANY (v_seen) THEN RETURN 'a sale line appears more than once in the request'; END IF;
        v_seen := v_seen || v_si.id;
        v_q := v_q + (ln->>'qtyUnits')::bigint; v_a := v_a + (ln->>'amountMmk')::bigint;
      END LOOP;
      IF v_q <> (coalesce(it->>'qtyUnits', it->>'qty_units'))::bigint OR v_a <> (coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint THEN
        RETURN 'refund lines do not add up to the item quantity and amount';
      END IF;
    END IF;
    IF it ? 'payouts' THEN
      IF jsonb_typeof(it->'payouts') <> 'array' OR jsonb_array_length(it->'payouts') = 0 THEN RETURN 'payouts must be a non-empty list'; END IF;
      v_pa := 0; v_m := '{}';
      FOR po IN SELECT value FROM jsonb_array_elements(it->'payouts') LOOP
        IF po->>'method' IS NULL OR po->>'method' NOT IN ('CASH', 'BANK_TRANSFER', 'MOBILE_WALLET', 'CARD', 'OTHER') OR po->>'method' = ANY (v_m) THEN
          RETURN 'unsupported or repeated payout method';
        END IF;
        v_m := v_m || (po->>'method');
        IF jsonb_typeof(po->'amountMmk') <> 'number' OR (po->>'amountMmk')::numeric <= 0 OR (po->>'amountMmk')::numeric <> trunc((po->>'amountMmk')::numeric) THEN
          RETURN 'a payout needs a positive whole amount';
        END IF;
        v_pa := v_pa + (po->>'amountMmk')::bigint;
      END LOOP;
      IF v_pa <> (coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint THEN RETURN 'payouts do not add up to the item amount'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- What every OTHER approved refund of the sale already took, read from the requests themselves, so refunds approved
-- BEFORE this migration and refunds from released tills (legacy items, no payouts) count too:
--   per sale line: line-bearing items by their lines; a legacy item by its product when that product is on exactly one
--   line of the sale (otherwise it stays unattributed: the pinned per-product check bounds it);
--   per payment method: recorded payouts; a legacy item as paid back by the sale's own legacy method (CASH / OTHER).
CREATE OR REPLACE FUNCTION public.fin_refund_prior_lines(p_sale_id text, p_request_id text)
RETURNS TABLE (item_id text, q bigint, a bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.item_id, sum(x.q)::bigint, sum(x.a)::bigint FROM (
    SELECT ln->>'saleItemId' AS item_id, (ln->>'qtyUnits')::bigint AS q, (ln->>'amountMmk')::bigint AS a
      FROM refund_void_requests r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) it
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN it ? 'lines' THEN it->'lines' ELSE '[]'::jsonb END) ln
     WHERE r.sale_id = p_sale_id AND r.id IS DISTINCT FROM p_request_id AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
    UNION ALL
    SELECT (SELECT min(si.id) FROM sale_items si WHERE si.sale_id = p_sale_id AND si.product_id = coalesce(it->>'productId', it->>'product_id')
             HAVING count(*) = 1),
           (coalesce(it->>'qtyUnits', it->>'qty_units'))::bigint, (coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint
      FROM refund_void_requests r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) it
     WHERE r.sale_id = p_sale_id AND r.id IS DISTINCT FROM p_request_id AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
       AND jsonb_typeof(it) = 'object' AND NOT it ? 'lines') x
   WHERE x.item_id IS NOT NULL GROUP BY 1 $$;
CREATE OR REPLACE FUNCTION public.fin_refund_prior_methods(p_sale_id text, p_request_id text)
RETURNS TABLE (method text, a bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.method, sum(x.a)::bigint FROM (
    SELECT po->>'method' AS method, (po->>'amountMmk')::bigint AS a
      FROM refund_void_requests r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) it
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN it ? 'payouts' THEN it->'payouts' ELSE '[]'::jsonb END) po
     WHERE r.sale_id = p_sale_id AND r.id IS DISTINCT FROM p_request_id AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
    UNION ALL
    SELECT CASE WHEN s.payment_method = 'CASH' THEN 'CASH' ELSE 'OTHER' END, (coalesce(it->>'amountMmk', it->>'amount_mmk'))::bigint
      FROM refund_void_requests r JOIN sales s ON s.id = r.sale_id CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) it
     WHERE r.sale_id = p_sale_id AND r.id IS DISTINCT FROM p_request_id AND r.type = 'PARTIAL' AND r.status = 'APPROVED'
       AND jsonb_typeof(it) = 'object' AND NOT it ? 'payouts') x
   GROUP BY 1 $$;

-- cumulative caps for THIS request plus every other APPROVED request of the sale
CREATE OR REPLACE FUNCTION public.fin_refund_caps_problem(p_sale_id text, p_request_id text, p_items jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_bad record; v_mine_total bigint; v_prior_total bigint; v_paid_total bigint;
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
  -- payouts per method never exceed what the sale was paid with that method (cash: the applied amount, never the change)
  WITH mine AS (
    SELECT po->>'method' AS method, sum((po->>'amountMmk')::bigint) AS a
      FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN it ? 'payouts' THEN it->'payouts' ELSE '[]'::jsonb END) po
     GROUP BY 1
  ), prior AS (SELECT * FROM fin_refund_prior_methods(p_sale_id, p_request_id)),
  paid AS (SELECT method, sum(amount_mmk)::bigint AS a FROM sale_payments WHERE sale_id = p_sale_id GROUP BY 1)
  SELECT m.method, coalesce(d.a, 0) - coalesce(p.a, 0) AS left_mmk INTO v_bad
    FROM mine m LEFT JOIN prior p ON p.method = m.method LEFT JOIN paid d ON d.method = m.method
   WHERE coalesce(p.a, 0) + m.a > coalesce(d.a, 0) LIMIT 1;
  IF v_bad.method IS NOT NULL THEN
    RETURN 'Refund payout by ' || v_bad.method || ' exceeds what the customer paid that way (' || greatest(v_bad.left_mmk, 0) || ' MMK left)';
  END IF;
  -- and all refunds together never exceed what the sale took
  SELECT coalesce(sum((po->>'amountMmk')::bigint), 0) INTO v_mine_total
    FROM jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) it CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN it ? 'payouts' THEN it->'payouts' ELSE '[]'::jsonb END) po;
  SELECT coalesce(sum(a), 0) INTO v_prior_total FROM fin_refund_prior_methods(p_sale_id, p_request_id);
  SELECT coalesce(sum(amount_mmk), 0) INTO v_paid_total FROM sale_payments WHERE sale_id = p_sale_id;
  IF v_prior_total + v_mine_total > v_paid_total THEN RETURN 'Refunds would exceed what the customer paid for this sale'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.fin_refund_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_problem text;
BEGIN
  IF NEW.type <> 'PARTIAL' OR NEW.items IS NULL THEN RETURN NEW; END IF;
  v_problem := public.fin_refund_items_problem(NEW.sale_id, NEW.items);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION 'Invalid refund request: %', v_problem; END IF;
  -- checked when the request is created (a request that can never be approved is refused at once, instead of
  -- blocking the sale's refunds as a pending request) and again at approval, under the sale's row lock
  IF NEW.status = 'APPROVED' THEN
    PERFORM 1 FROM sales WHERE id = NEW.sale_id FOR UPDATE;      -- one approval of this sale at a time
  END IF;
  IF TG_OP = 'INSERT' OR NEW.status = 'APPROVED' THEN
    v_problem := public.fin_refund_caps_problem(NEW.sale_id, NEW.id, NEW.items);
    IF v_problem IS NOT NULL THEN RAISE EXCEPTION 'Invalid refund request: %', v_problem; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fin_refund_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  it jsonb; ln jsonb; v_sale sales; v_org text; v_now timestamptz := clock_timestamp(); v_actor text; v_cost bigint; v_unit int;
  v_inv integer; v_sbd date; v_rbd date;
BEGIN
  IF NEW.type <> 'PARTIAL' OR NEW.items IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_sale FROM sales WHERE id = NEW.sale_id;
  SELECT org_id INTO v_org FROM shops WHERE id = v_sale.shop_id;
  v_actor := coalesce((current_app_user()).id, NEW.created_by);
  v_sbd := (v_sale.created_at AT TIME ZONE 'Asia/Yangon')::date;
  v_rbd := (v_now AT TIME ZONE 'Asia/Yangon')::date;
  FOR it IN SELECT value FROM jsonb_array_elements(NEW.items) LOOP
    IF it ? 'lines' THEN
      FOR ln IN SELECT value FROM jsonb_array_elements(it->'lines') LOOP
        SELECT c.unit_cost_mmk INTO v_unit FROM fin_line_costs(ARRAY[NEW.sale_id]) c WHERE c.item_id = ln->>'saleItemId';
        v_cost := CASE WHEN v_unit IS NULL THEN NULL ELSE v_unit::bigint * (ln->>'qtyUnits')::bigint END;
        INSERT INTO refund_lines (id, org_id, shop_id, request_id, sale_id, sale_item_id, product_id, qty_units, amount_mmk, restocked, cost_mmk,
                                  reason, sale_business_date, refund_business_date, approved_by, approved_at)
        VALUES ('rl-' || replace(gen_random_uuid()::text, '-', ''), v_org, v_sale.shop_id, NEW.id, NEW.sale_id, ln->>'saleItemId',
                coalesce(it->>'productId', it->>'product_id'), (ln->>'qtyUnits')::int, (ln->>'amountMmk')::int, coalesce((ln->>'restock')::boolean, true),
                v_cost, NEW.reason, v_sbd, v_rbd, v_actor, v_now);
        IF NOT coalesce((ln->>'restock')::boolean, true) THEN
          -- the pinned approval restocked this quantity (RETURN_IN); take it back out, explicitly and separately
          SELECT qty_base_units INTO v_inv FROM inventory WHERE shop_id = v_sale.shop_id AND product_id = coalesce(it->>'productId', it->>'product_id') FOR UPDATE;
          UPDATE inventory SET qty_base_units = v_inv - (ln->>'qtyUnits')::int
           WHERE shop_id = v_sale.shop_id AND product_id = coalesce(it->>'productId', it->>'product_id');
          INSERT INTO inventory_movements (id, shop_id, product_id, type, qty_change, qty_before, qty_after, reason, reference_type, reference_id, created_by, created_at)
          VALUES ('move-' || replace(gen_random_uuid()::text, '-', ''), v_sale.shop_id, coalesce(it->>'productId', it->>'product_id'), 'RETURN_NO_RESTOCK',
                  -(ln->>'qtyUnits')::int, v_inv, v_inv - (ln->>'qtyUnits')::int, 'Refunded without restock: ' || left(NEW.reason, 200),
                  'refund_void_request', NEW.id, v_actor, v_now);
        END IF;
      END LOOP;
    ELSE
      -- legacy item: one unattributed line; nothing about the sale line is invented
      INSERT INTO refund_lines (id, org_id, shop_id, request_id, sale_id, sale_item_id, product_id, qty_units, amount_mmk, restocked, cost_mmk,
                                reason, sale_business_date, refund_business_date, approved_by, approved_at)
      VALUES ('rl-' || replace(gen_random_uuid()::text, '-', ''), v_org, v_sale.shop_id, NEW.id, NEW.sale_id, NULL,
              coalesce(it->>'productId', it->>'product_id'), (coalesce(it->>'qtyUnits', it->>'qty_units'))::int,
              (coalesce(it->>'amountMmk', it->>'amount_mmk'))::int, true, NULL, NEW.reason, v_sbd, v_rbd, v_actor, v_now);
    END IF;
  END LOOP;
  -- one payout row per method for the whole request: the items' payouts added up (never one item's only)
  INSERT INTO refund_payouts (id, org_id, shop_id, request_id, sale_id, method, amount_mmk, approved_by, approved_at)
  SELECT 'rp-' || replace(gen_random_uuid()::text, '-', ''), v_org, v_sale.shop_id, NEW.id, NEW.sale_id, x.method, x.a, v_actor, v_now
    FROM (SELECT po->>'method' AS method, sum((po->>'amountMmk')::bigint)::int AS a
            FROM jsonb_array_elements(NEW.items) it2 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN it2 ? 'payouts' THEN it2->'payouts' ELSE '[]'::jsonb END) po
           GROUP BY 1) x;
  RETURN NULL;
END $$;

ALTER FUNCTION public.fin_refund_items_problem(text, jsonb) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_caps_problem(text, text, jsonb) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_prior_lines(text, text) OWNER TO postgres;
ALTER FUNCTION public.fin_refund_prior_methods(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_refund_prior_lines(text, text), public.fin_refund_prior_methods(text, text) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.fin_refund_guard() OWNER TO postgres;
ALTER FUNCTION public.fin_refund_record() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_refund_items_problem(text, jsonb), public.fin_refund_caps_problem(text, text, jsonb),
  public.fin_refund_guard(), public.fin_refund_record() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS zzf_refund_guard_ins ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzf_refund_guard_upd ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzf_refund_record ON public.refund_void_requests;
CREATE TRIGGER zzf_refund_guard_ins BEFORE INSERT ON public.refund_void_requests FOR EACH ROW EXECUTE FUNCTION public.fin_refund_guard();
CREATE TRIGGER zzf_refund_guard_upd BEFORE UPDATE ON public.refund_void_requests FOR EACH ROW
  WHEN (NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED') EXECUTE FUNCTION public.fin_refund_guard();
CREATE TRIGGER zzf_refund_record AFTER UPDATE ON public.refund_void_requests FOR EACH ROW
  WHEN (NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED') EXECUTE FUNCTION public.fin_refund_record();

-- what is still refundable, per sale line and per payment method (same visibility as the sale)
CREATE OR REPLACE FUNCTION public.fin_refund_lines_state(p_sale_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user users;
BEGIN
  v_user := current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.app_require_org('sale', p_sale_id);
  IF NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = p_sale_id
                  AND (app_can_for_shop('pos:refund', s.shop_id) OR app_can_for_shop('pos:request_refund', s.shop_id))) THEN
    RAISE EXCEPTION 'You are not permitted to refund this sale';
  END IF;
  RETURN jsonb_build_object('saleId', p_sale_id,
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('saleItemId', n.item_id, 'productId', n.product_id, 'qtyUnits', n.qty_units,
        'netMmk', n.net_mmk, 'refundedQtyUnits', coalesce(r.q, 0), 'refundedMmk', coalesce(r.a, 0),
        'remainingQtyUnits', n.qty_units - coalesce(r.q, 0), 'remainingMmk', greatest(n.net_mmk - coalesce(r.a, 0), 0)) ORDER BY n.item_id)
      FROM fin_sale_line_net(ARRAY[p_sale_id]) n
      LEFT JOIN fin_refund_prior_lines(p_sale_id, NULL) r ON r.item_id = n.item_id), '[]'),
    'unattributedRefundedMmk', (SELECT coalesce(sum(amount_mmk), 0) FROM refund_lines WHERE sale_id = p_sale_id AND sale_item_id IS NULL),
    'payments', coalesce((SELECT jsonb_agg(jsonb_build_object('method', p.method, 'paidMmk', p.amount_mmk,
        'refundedMmk', coalesce((SELECT o.a FROM fin_refund_prior_methods(p_sale_id, NULL) o WHERE o.method = p.method), 0)) ORDER BY p.seq)
      FROM sale_payments p WHERE p.sale_id = p_sale_id), '[]'));
END $$;
ALTER FUNCTION public.fin_refund_lines_state(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fin_refund_lines_state(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fin_refund_lines_state(text) TO authenticated;

DO $pfin_e_post$
BEGIN
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF;
END $pfin_e_post$;
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
