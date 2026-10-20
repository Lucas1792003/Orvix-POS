-- f04: high-volume history (far above the client's 1,000-sale cache) in shop V.
-- 30,000 sales over 3 years (1,095 Yangon days; reports cover the last year), 1-3 lines each, cart discounts, CASH /
-- OTHER, 2,400 approved partial refunds and 600 voids, each with its server
-- audit row (as the approving RPCs write them); 100 legacy refunds without
-- one. Direct rows (synthetic history); the report is checked against an
-- independent ground-truth query for both bases, and for speed.
\set ON_ERROR_STOP on
\set ADMIN '''a0000000-0000-4000-8000-000000000001'''
\set MGRV  '''f0000000-0000-4000-8000-000000000006'''

CREATE OR REPLACE FUNCTION test.explain_lines(p_sql text) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN EXECUTE 'EXPLAIN ' || p_sql LOOP RETURN NEXT r."QUERY PLAN"; END LOOP;
END $$;

INSERT INTO shifts (id, shop_id, cashier_id, started_at, ended_at, opening_cash_mmk)
VALUES ('shift-v-hist', 'shop-v', 'u-mgr-v', now() - interval '400 days', now() - interval '1 hour', 0);

-- sales: line totals 1,000..3,000 per line, cart 0 % or 5 %
INSERT INTO sales (id, shop_id, shift_id, receipt_no, cashier_id, status, subtotal_mmk, discount_mmk, cart_discount_pct,
                   total_mmk, payment_method, paid_mmk, change_mmk, created_at)
SELECT 'vs-' || g, 'shop-v', 'shift-v-hist', 'SV-' || lpad(g::text, 6, '0'), 'u-mgr-v', 'NORMAL',
       0, 0, CASE WHEN g % 4 = 0 THEN 5 ELSE 0 END, 0,
       CASE WHEN g % 3 = 0 THEN 'OTHER' ELSE 'CASH' END, 0, 0,
       (test.var('B')::timestamptz) - ((g % 1095) || ' days')::interval + ((g * 37) % 86400 || ' seconds')::interval - interval '1 day'
  FROM generate_series(1, 30000) g;
INSERT INTO sale_items (id, sale_id, product_id, qty_units, unit_price_mmk, line_total_mmk, unit_cost_mmk_snapshot)
SELECT 'vi-' || g || '-' || l, 'vs-' || g, (ARRAY['prod-1', 'prod-2', 'prod-3'])[l], l, 1000, 1000 * l,
       CASE WHEN g % 50 = 0 AND l = 1 THEN NULL ELSE (ARRAY[600, 1200, 1800])[l] / l END
  FROM generate_series(1, 30000) g, generate_series(1, 3) l
 WHERE l <= 1 + (g % 3);
UPDATE sales s SET subtotal_mmk = x.after_disc,
                   total_mmk = x.after_disc - round(x.after_disc * s.cart_discount_pct / 100)::int,
                   discount_mmk = round(x.after_disc * s.cart_discount_pct / 100)::int,
                   paid_mmk = x.after_disc - round(x.after_disc * s.cart_discount_pct / 100)::int
  FROM (SELECT sale_id, sum(line_total_mmk) AS after_disc FROM sale_items WHERE sale_id LIKE 'vs-%' GROUP BY 1) x
 WHERE s.id = x.sale_id;

-- voids (every 50th + 7), approved one hour after the sale
UPDATE sales SET status = 'VOID' WHERE id IN (SELECT 'vs-' || g FROM generate_series(7, 30000, 50) g);
INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, created_at, status)
SELECT 'vv-' || s.id, s.id, 'shop-v', 'VOID', 'v', 'u-mgr-v', s.created_at + interval '30 minutes', 'APPROVED'
  FROM sales s WHERE s.id LIKE 'vs-%' AND s.status = 'VOID';
INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
SELECT 'va-' || s.id, 'shop-v', 'u-mgr-v', 'VOID_SALE', 'Void approved for sale ' || s.receipt_no || '. Reason: v', 'Sale', s.id, s.created_at + interval '1 hour'
  FROM sales s WHERE s.id LIKE 'vs-%' AND s.status = 'VOID';
-- partial refunds of 1 unit of prod-1 (every 12th sale, not void), 2 days after the sale
-- (so refunds cross business days); the first 100 have NO approval record (legacy)
INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, created_at, items, status)
SELECT 'vr-' || s.id, s.id, 'shop-v', 'PARTIAL', 'r', 'u-mgr-v', s.created_at + interval '1 day',
       jsonb_build_array(jsonb_build_object('productId', 'prod-1', 'qtyUnits', 1,
         'amountMmk', (SELECT net_mmk FROM public.fin_sale_line_net(ARRAY[s.id]) n WHERE n.product_id = 'prod-1'))), 'APPROVED'
  FROM sales s WHERE s.id LIKE 'vs-%' AND s.status <> 'VOID' AND (substr(s.id, 4)::int) % 12 = 0
 ORDER BY substr(s.id, 4)::int LIMIT 2400;
UPDATE sales SET status = 'REFUNDED' WHERE id IN (SELECT sale_id FROM refund_void_requests WHERE id LIKE 'vr-%');
INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at)
SELECT 'ra-' || r.id, 'shop-v', 'u-mgr-v', 'REFUND', 'Refund approved for sale ' || s.receipt_no || '. Reason: r', 'Refund', r.id, s.created_at + interval '2 days'
  FROM refund_void_requests r JOIN sales s ON s.id = r.sale_id
 WHERE r.id LIKE 'vr-%' AND (substr(s.id, 4)::int) > (SELECT (array_agg(substr(sale_id, 4)::int ORDER BY substr(sale_id, 4)::int))[100]
                                                        FROM refund_void_requests WHERE id LIKE 'vr-%');
ANALYZE sales; ANALYZE sale_items; ANALYZE refund_void_requests; ANALYZE audit_logs;

SELECT test.check('f04 fixture: 30,000 sales in shop V (30x the client cache), 2,400 refunds (100 without approval record), 600 voids',
  (SELECT count(*) FROM sales WHERE shop_id = 'shop-v') = 30000
  AND (SELECT count(*) FROM refund_void_requests WHERE id LIKE 'vr-%') = 2400
  AND (SELECT count(*) FROM refund_void_requests r WHERE r.id LIKE 'vr-%') - (SELECT count(*) FROM public.fin_approval_times('REFUND', ARRAY(SELECT id FROM refund_void_requests WHERE id LIKE 'vr-%'))) = 100
  AND (SELECT count(*) FROM sales WHERE shop_id = 'shop-v' AND status = 'VOID') = 600);

-- ground truth, computed independently of the report functions
SELECT test.setvar('vfrom', ((test.var('B')::timestamptz - interval '366 days') AT TIME ZONE 'Asia/Yangon')::date::text);
SELECT test.setvar('vto',   test.var('D2'));
CREATE TEMP TABLE gt_sale AS
  SELECT s.id, s.total_mmk, s.status, s.payment_method, (s.created_at AT TIME ZONE 'Asia/Yangon')::date AS bday
    FROM sales s WHERE s.shop_id = 'shop-v'
     AND (s.created_at AT TIME ZONE 'Asia/Yangon')::date BETWEEN test.var('vfrom')::date AND test.var('vto')::date;
CREATE TEMP TABLE gt_ref AS
  SELECT r.id, r.sale_id, (r.items->0->>'amountMmk')::int AS amount,
         (a.created_at AT TIME ZONE 'Asia/Yangon')::date AS abday
    FROM refund_void_requests r LEFT JOIN audit_logs a ON a.entity_id = r.id AND a.action_type = 'REFUND'
   WHERE r.id LIKE 'vr-%';
CREATE TEMP TABLE gt_void AS
  SELECT s.id, s.total_mmk, (a.created_at AT TIME ZONE 'Asia/Yangon')::date AS abday
    FROM sales s JOIN audit_logs a ON a.entity_id = s.id AND a.action_type = 'VOID_SALE' WHERE s.shop_id = 'shop-v';
SELECT
  (SELECT sum(total_mmk) FROM gt_sale WHERE status <> 'VOID') AS g_gross_sale,
  (SELECT sum(amount) FROM gt_ref WHERE sale_id IN (SELECT id FROM gt_sale)) AS g_ref_sale,
  (SELECT sum(total_mmk) FROM gt_sale) AS g_gross_appr,
  (SELECT sum(amount) FROM gt_ref WHERE abday BETWEEN test.var('vfrom')::date AND test.var('vto')::date) AS g_ref_appr,
  (SELECT sum(total_mmk) FROM gt_void WHERE abday BETWEEN test.var('vfrom')::date AND test.var('vto')::date) AS g_void_appr,
  (SELECT count(*) FROM gt_ref WHERE abday IS NULL AND sale_id IN (SELECT id FROM gt_sale)) AS g_undated,
  (SELECT count(*) FROM gt_sale WHERE status <> 'VOID') AS g_n_sale
\gset

SELECT clock_timestamp() AS t0 \gset
SELECT test.f_report(:ADMIN, 'shop-v', test.var('vfrom')::date, test.var('vto')::date, 'SALE_DATE') AS vs \gset
SELECT clock_timestamp() AS t1 \gset
SELECT test.f_report(:ADMIN, 'shop-v', test.var('vfrom')::date, test.var('vto')::date, 'APPROVAL_DATE') AS va \gset
SELECT clock_timestamp() AS t2 \gset
SELECT test.check('f04 SALE_DATE year report = ground truth (count, gross, refunds, net)',
  (:'vs'::jsonb->'totals'->>'saleCount')::int = :g_n_sale
  AND (:'vs'::jsonb->'totals'->>'grossSalesMmk')::bigint = :g_gross_sale
  AND (:'vs'::jsonb->'totals'->>'refundMmk')::bigint = :g_ref_sale
  AND (:'vs'::jsonb->'totals'->>'netRevenueMmk')::bigint = :g_gross_sale - :g_ref_sale,
  (:'vs'::jsonb->'totals')::text || ' vs gross ' || :g_gross_sale || ' ref ' || :g_ref_sale);
SELECT test.check('f04 APPROVAL_DATE year report = ground truth (gross incl. voided, refunds and voids by approval day, 100 undated)',
  (:'va'::jsonb->'totals'->>'grossSalesMmk')::bigint = :g_gross_appr
  AND (:'va'::jsonb->'totals'->>'refundMmk')::bigint = :g_ref_appr
  AND (:'va'::jsonb->'totals'->>'voidMmk')::bigint = :g_void_appr
  AND (:'va'::jsonb->'undatedAdjustments'->>'count')::int = :g_undated,
  (:'va'::jsonb->'totals')::text || ' undated ' || (:'va'::jsonb->'undatedAdjustments')::text);
SELECT test.check('f04 the year range excludes older history (sale count < 30,000) and by-day rows sum to the totals',
  (:'vs'::jsonb->'totals'->>'saleCount')::int < 29000 AND (SELECT sum((d->>'netRevenueMmk')::bigint) FROM jsonb_array_elements(:'vs'::jsonb->'byDay') d) = (:'vs'::jsonb->'totals'->>'netRevenueMmk')::bigint
  AND jsonb_array_length(:'vs'::jsonb->'byDay') = test.var('vto')::date - test.var('vfrom')::date + 1);
SELECT test.check('f04 COGS incomplete where snapshots are missing (profit NULL), and no refund above net paid',
  (:'vs'::jsonb->'totals'->>'cogsComplete')::boolean = false AND (:'vs'::jsonb->'totals'->>'linesMissingCost')::int > 0
  AND :'vs'::jsonb->'totals'->'grossProfitMmk' = 'null'::jsonb
  AND (:'vs'::jsonb->'evidence'->>'refundsAboveNetPaid')::int = 0);
SELECT test.check('f04 a full-year report (≈10,000 of 30,000 sales) returns in under 5 s per basis',
  (:'t1'::timestamptz - :'t0'::timestamptz) < interval '5 seconds' AND (:'t2'::timestamptz - :'t1'::timestamptz) < interval '5 seconds',
  'SALE_DATE ' || (:'t1'::timestamptz - :'t0'::timestamptz)::text || ', APPROVAL_DATE ' || (:'t2'::timestamptz - :'t1'::timestamptz)::text);

-- 8 one-day reports on this connection, then the year report again: the
-- function forces custom plans, so a plan built for one day is never reused for a year
DO $$ BEGIN FOR i IN 1..8 LOOP PERFORM test.f_report('a0000000-0000-4000-8000-000000000001', 'shop-v', current_date - i, current_date - i, 'SALE_DATE'); END LOOP; END $$;
SELECT clock_timestamp() AS t3 \gset
SELECT test.f_report(:ADMIN, 'shop-v', test.var('vfrom')::date, test.var('vto')::date, 'SALE_DATE') AS vs2 \gset
SELECT clock_timestamp() AS t4 \gset
SELECT test.check('f04 after 8 one-day reports the year report is unchanged and still fast (force_custom_plan)',
  (:'vs2'::jsonb->'totals') = (:'vs'::jsonb->'totals') AND (:'t4'::timestamptz - :'t3'::timestamptz) < interval '5 seconds',
  (:'t4'::timestamptz - :'t3'::timestamptz)::text);
SELECT test.check('f04 report functions pin plan_cache_mode and statement_timeout',
  (SELECT bool_and(proconfig @> ARRAY['plan_cache_mode=force_custom_plan', 'statement_timeout=30s'])
     FROM pg_proc WHERE proname IN ('fin_report_summary', 'fin_shift_reconciliation')));

-- a one-month report uses the new range index (plan of the report's sales predicate)
SELECT test.check('f04 the shop + business-day range predicate uses sales_shop_created_idx',
  (SELECT string_agg(l, ' ') FROM test.explain_lines(format(
     $q$SELECT id FROM sales WHERE shop_id = ANY (ARRAY['shop-v']) AND created_at >= %L AND created_at < %L$q$,
     test.var('B')::timestamptz - interval '30 days', test.var('B')::timestamptz)) AS l) LIKE '%sales_shop_created_idx%');

-- manager V (shop level) gets the same net as ADMIN for the same shop
SELECT test.f_report(:MGRV, NULL, test.var('vfrom')::date, test.var('vto')::date, 'SALE_DATE') AS vm \gset
SELECT test.check('f04 manager V (SHOP) net = ADMIN net for shop V',
  (:'vm'::jsonb->'totals'->>'netRevenueMmk') = (:'vs'::jsonb->'totals'->>'netRevenueMmk'));
SELECT test.logout() AS zz \gset
