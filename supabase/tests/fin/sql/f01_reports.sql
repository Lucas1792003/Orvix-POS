-- f01: fin_report_summary. A hand-computed day pair on shop F around the
-- Asia/Yangon midnight B, every money event made through the real RPCs
-- (complete_sale, create_refund_void_request, approve_refund_request,
-- approve_void_request, open_shift, close_shift), then: both refund bases,
-- partial / discounted / full refunds, a void, a legacy refund without an
-- approval record, COGS with a missing cost, payment methods, and the scope /
-- isolation rules (own sales, shop, org, other org, inactive, anon).
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- helpers
-- Fixture helpers run as the superuser with the user's JWT claims: the RPCs
-- are SECURITY DEFINER and authorise through auth.uid(), exactly as for an
-- API call. Permission tests below use SET ROLE authenticated explicitly.
CREATE OR REPLACE FUNCTION test.f_open(p_auth uuid, p_shop text, p_cash int, p_at timestamptz) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test.login(p_auth);
  RETURN public.open_shift(p_shop, p_cash, p_at, NULL, gen_random_uuid())->'shift'->>'id';
END $$;
CREATE OR REPLACE FUNCTION test.f_close(p_auth uuid, p_shift text, p_cash int, p_reason text, p_at timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test.login(p_auth);
  RETURN public.close_shift(p_shift, p_cash, p_reason, p_at, NULL, gen_random_uuid());
END $$;
CREATE OR REPLACE FUNCTION test.f_sale(p_auth uuid, p_shop text, p_shift text, p_method text, p_paid int, p_cart numeric, p_items jsonb, p_at timestamptz)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test.login(p_auth);
  RETURN public.complete_sale(p_shop, p_shift, p_method, p_paid, p_cart, p_items, p_at, gen_random_uuid())->'sale'->>'id';
END $$;
CREATE OR REPLACE FUNCTION test.f_request(p_auth uuid, p_sale text, p_type text, p_reason text, p_items jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test.login(p_auth);
  RETURN public.create_refund_void_request(p_sale, p_type, p_reason, p_items, NULL, NULL, gen_random_uuid())->'request'->>'id';
END $$;
CREATE OR REPLACE FUNCTION test.f_approve(p_auth uuid, p_request text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test.login(p_auth);
  IF (SELECT type FROM refund_void_requests WHERE id = p_request) = 'VOID' THEN
    RETURN public.approve_void_request(p_request, gen_random_uuid());
  END IF;
  RETURN public.approve_refund_request(p_request, gen_random_uuid());
END $$;
CREATE OR REPLACE FUNCTION test.f_report(p_auth uuid, p_shop text, p_from date, p_to date, p_basis text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test.login(p_auth);
  RETURN public.fin_report_summary(p_shop, p_from, p_to, p_basis);
END $$;
CREATE OR REPLACE FUNCTION test.f_day(p_rep jsonb, p_day text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT d FROM jsonb_array_elements(p_rep->'byDay') d WHERE d->>'date' = p_day
$$;
CREATE OR REPLACE FUNCTION test.f_method(p_rep jsonb, p_m text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT d FROM jsonb_array_elements(p_rep->'byPaymentMethod') d WHERE d->>'method' = p_m
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO anon, authenticated, service_role;

\set ADMIN   '''a0000000-0000-4000-8000-000000000001'''
\set ADMINX  '''a0000000-0000-4000-8000-000000000011'''
\set MGRF    '''f0000000-0000-4000-8000-000000000001'''
\set F1      '''f0000000-0000-4000-8000-000000000002'''
\set F2      '''f0000000-0000-4000-8000-000000000003'''
\set VIEWF   '''f0000000-0000-4000-8000-000000000004'''
\set GONEF   '''f0000000-0000-4000-8000-000000000005'''
\set MGRA    '''a0000000-0000-4000-8000-000000000002'''

-- ---------------------------------------------------------------- fixtures
-- S1: cashier F1, opened B - 3 h with 50,000; closed at B + 30 s.
SELECT test.setvar('S1', test.f_open(:F1, 'shop-f', 50000, test.var('B')::timestamptz - interval '3 hours'));
-- s1  D1  CASH   2 x prod-1                     = 2,000  (cost 2 x 600)
SELECT test.setvar('s1', test.f_sale(:F1, 'shop-f', test.var('S1'), 'CASH', 2000, 0,
  '[{"product_id":"prod-1","qty":2}]', test.var('B')::timestamptz - interval '2 hours'));
-- s2  D1 23:59:59  CASH  prod-2 + prod-1, 10 % cart: 3,000 - 300 = 2,700 (paid 3,000, change 300)
SELECT test.setvar('s2', test.f_sale(:F1, 'shop-f', test.var('S1'), 'CASH', 3000, 10,
  '[{"product_id":"prod-2","qty":1},{"product_id":"prod-1","qty":1}]', test.var('B')::timestamptz - interval '1 second'));
-- s3  D2 00:00:01  OTHER  prod-3                = 3,000  (cost 1,800)
SELECT test.setvar('s3', test.f_sale(:F1, 'shop-f', test.var('S1'), 'OTHER', 3000, 0,
  '[{"product_id":"prod-3","qty":1}]', test.var('B')::timestamptz + interval '1 second'));
-- s4  D2  CASH  prod-nc (no cost)               = 5,000
SELECT test.setvar('s4', test.f_sale(:F1, 'shop-f', test.var('S1'), 'CASH', 5000, 0,
  '[{"product_id":"prod-nc","qty":1}]', test.var('B')::timestamptz + interval '10 seconds'));
SELECT test.f_close(:F1, test.var('S1'), 59700, NULL, test.var('B')::timestamptz + interval '30 seconds') AS c1 \gset

-- S2: cashier F2, opened now - 10 min with 20,000 (S1 already closed).
SELECT test.setvar('S2', test.f_open(:F2, 'shop-f', 20000, now() - interval '10 minutes'));
-- s5  D2  CASH  3 x prod-1 = 3,000 ; s6  D2  CASH  prod-2 = 2,000 (voided below)
SELECT test.setvar('s5', test.f_sale(:F2, 'shop-f', test.var('S2'), 'CASH', 3000, 0, '[{"product_id":"prod-1","qty":3}]', NULL));
SELECT test.setvar('s6', test.f_sale(:F2, 'shop-f', test.var('S2'), 'CASH', 2000, 0, '[{"product_id":"prod-2","qty":1}]', NULL));

-- Refunds, all approved NOW (business day D2) by Manager F while S2 is open:
-- r1  s1 (S1, closed): 1 x prod-1, 1,000; requested by F2, so F1's RLS cannot see it
SELECT test.setvar('r1', test.f_request(:F2, test.var('s1'), 'PARTIAL', 'secret-reason-r1',
  '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]'));
-- r2  s2 (S1, discounted): prod-2 at its net price 2,000 x 0.9 = 1,800
SELECT test.setvar('r2', test.f_request(:F1, test.var('s2'), 'PARTIAL', 'r2',
  '[{"productId":"prod-2","qtyUnits":1,"amountMmk":1800}]'));
-- r3  s5 (S2): 1 x prod-1, 1,000
SELECT test.setvar('r3', test.f_request(:F2, test.var('s5'), 'PARTIAL', 'r3',
  '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]'));
-- v6  s6 (S2): void
SELECT test.setvar('v6', test.f_request(:F2, test.var('s6'), 'VOID', 'v6', NULL));
SELECT test.f_approve(:MGRF, test.var('r1')) AS a1 \gset
SELECT test.f_approve(:MGRF, test.var('r2')) AS a2 \gset
SELECT test.f_approve(:MGRF, test.var('r3')) AS a3 \gset
SELECT test.f_approve(:MGRF, test.var('v6')) AS a6 \gset
-- r4  s3 (OTHER): a LEGACY approved refund with no approval record (direct
-- row, as written before the RPCs existed): 1 x prod-3, 500
INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, created_at, items, status)
VALUES ('refund-legacy-r4', test.var('s3'), 'shop-f', 'PARTIAL', 'legacy', 'u-cash-f1', now() - interval '1 minute',
        '[{"productId":"prod-3","qtyUnits":1,"amountMmk":500}]', 'APPROVED');

-- S2 closes now: expected 20,000 + 3,000 (s5) - 1,000 (r3) = 22,000 (s6 is VOID).
-- The drawer holds 2,800 less: the manager paid r1 + r2 out of it.
SELECT test.f_close(:F2, test.var('S2'), 19200, 'paid r1 and r2 from this drawer', NULL) AS c2 \gset
SELECT test.check('f01 fixtures: S1 closed at 59,700 variance 0; S2 expected 22,000 variance -2,800',
  (:'c1'::jsonb->'shift'->>'expectedCashMmk')::int = 59700 AND (:'c1'::jsonb->'shift'->>'varianceMmk')::int = 0
  AND (:'c2'::jsonb->'shift'->>'expectedCashMmk')::int = 22000 AND (:'c2'::jsonb->'shift'->>'varianceMmk')::int = -2800,
  :'c1'::jsonb->'shift'->>'expectedCashMmk' || ' / ' || (:'c2'::jsonb->'shift'->>'expectedCashMmk'));
SELECT test.check('f01 fixtures: s2 total 2,700 and lands on D1; s3 lands on D2 (Yangon midnight)',
  (SELECT total_mmk FROM sales WHERE id = test.var('s2')) = 2700
  AND (SELECT (created_at AT TIME ZONE 'Asia/Yangon')::date::text FROM sales WHERE id = test.var('s2')) = test.var('D1')
  AND (SELECT (created_at AT TIME ZONE 'Asia/Yangon')::date::text FROM sales WHERE id = test.var('s3')) = test.var('D2'));
SELECT test.check('f01 fixtures: the partial refund marked the WHOLE sale REFUNDED (070 behaviour the reports must not rely on)',
  (SELECT status FROM sales WHERE id = test.var('s1')) = 'REFUNDED');

-- ---------------------------------------------------------------- SALE_DATE
SELECT test.f_report(:ADMIN, 'shop-f', test.var('D1')::date, test.var('D2')::date, 'SALE_DATE') AS rs \gset
SELECT test.check('f01 SALE_DATE totals: 5 sales, gross 15,700, 4 refunds 4,300, net 11,400',
  (:'rs'::jsonb->'totals'->>'saleCount')::int = 5 AND (:'rs'::jsonb->'totals'->>'grossSalesMmk')::int = 15700
  AND (:'rs'::jsonb->'totals'->>'refundCount')::int = 4 AND (:'rs'::jsonb->'totals'->>'refundMmk')::int = 4300
  AND (:'rs'::jsonb->'totals'->>'voidMmk')::int = 0 AND (:'rs'::jsonb->'totals'->>'netRevenueMmk')::int = 11400,
  (:'rs'::jsonb->'totals')::text);
SELECT test.check('f01 SALE_DATE: the void is excluded from gross and listed (1 x 2,000)',
  (:'rs'::jsonb->'excludedVoids'->>'count')::int = 1 AND (:'rs'::jsonb->'excludedVoids'->>'amountMmk')::int = 2000);
SELECT test.check('f01 SALE_DATE by day: D1 gross 4,700 refunds 2,800 net 1,900; D2 gross 11,000 refunds 1,500 net 9,500',
  (test.f_day(:'rs'::jsonb, test.var('D1'))->>'grossSalesMmk')::int = 4700
  AND (test.f_day(:'rs'::jsonb, test.var('D1'))->>'refundMmk')::int = 2800
  AND (test.f_day(:'rs'::jsonb, test.var('D1'))->>'netRevenueMmk')::int = 1900
  AND (test.f_day(:'rs'::jsonb, test.var('D2'))->>'grossSalesMmk')::int = 11000
  AND (test.f_day(:'rs'::jsonb, test.var('D2'))->>'refundMmk')::int = 1500
  AND (test.f_day(:'rs'::jsonb, test.var('D2'))->>'netRevenueMmk')::int = 9500,
  (:'rs'::jsonb->'byDay')::text);
SELECT test.check('f01 SALE_DATE COGS: known 6,600 sold - 4,200 returned = 2,400; incomplete (1 line without cost) so profit is NULL, not 9,000',
  (:'rs'::jsonb->'totals'->>'cogsMmk')::int = 2400 AND :'rs'::jsonb->'totals'->'grossProfitMmk' = 'null'::jsonb
  AND (:'rs'::jsonb->'totals'->>'cogsComplete')::boolean = false AND (:'rs'::jsonb->'totals'->>'linesMissingCost')::int = 1
  AND (:'rs'::jsonb->'totals'->>'adjustmentsMissingCost')::int = 0);
SELECT test.check('f01 SALE_DATE by method: CASH 12,700 - 3,800 = 8,900; OTHER 3,000 - 500 = 2,500',
  (test.f_method(:'rs'::jsonb, 'CASH')->>'netMmk')::int = 8900 AND (test.f_method(:'rs'::jsonb, 'CASH')->>'grossSalesMmk')::int = 12700
  AND (test.f_method(:'rs'::jsonb, 'OTHER')->>'netMmk')::int = 2500);
SELECT test.check('f01 SALE_DATE: basis echoed (Asia/Yangon, SALE_DATE, original-method assumption); no undated adjustments',
  :'rs'::jsonb->'basis'->>'timezone' = 'Asia/Yangon' AND :'rs'::jsonb->'basis'->>'refundBasis' = 'SALE_DATE'
  AND :'rs'::jsonb->'basis'->>'refundMethodAssumption' = 'ORIGINAL_SALE_METHOD'
  AND (:'rs'::jsonb->'undatedAdjustments'->>'count')::int = 0);
SELECT test.check('f01 evidence: no refund above net paid, no sale refunded above its total',
  (:'rs'::jsonb->'evidence'->>'refundsAboveNetPaid')::int = 0 AND (:'rs'::jsonb->'evidence'->>'salesRefundedAboveTotal')::int = 0);

-- ---------------------------------------------------------------- APPROVAL_DATE
SELECT test.f_report(:ADMIN, 'shop-f', test.var('D1')::date, test.var('D2')::date, 'APPROVAL_DATE') AS ra \gset
SELECT test.check('f01 APPROVAL_DATE totals: 6 sales gross 17,700, refunds 3,800, void 2,000, net 11,900',
  (:'ra'::jsonb->'totals'->>'saleCount')::int = 6 AND (:'ra'::jsonb->'totals'->>'grossSalesMmk')::int = 17700
  AND (:'ra'::jsonb->'totals'->>'refundMmk')::int = 3800 AND (:'ra'::jsonb->'totals'->>'voidMmk')::int = 2000
  AND (:'ra'::jsonb->'totals'->>'netRevenueMmk')::int = 11900, (:'ra'::jsonb->'totals')::text);
SELECT test.check('f01 APPROVAL_DATE by day: D1 net 4,700 (its refunds were approved on D2); D2 13,000 - 5,800 = 7,200',
  (test.f_day(:'ra'::jsonb, test.var('D1'))->>'netRevenueMmk')::int = 4700
  AND (test.f_day(:'ra'::jsonb, test.var('D2'))->>'grossSalesMmk')::int = 13000
  AND (test.f_day(:'ra'::jsonb, test.var('D2'))->>'netRevenueMmk')::int = 7200);
SELECT test.check('f01 APPROVAL_DATE: the legacy refund without approval evidence is UNDATED (1 x 500), never placed on a day',
  (:'ra'::jsonb->'undatedAdjustments'->>'count')::int = 1 AND (:'ra'::jsonb->'undatedAdjustments'->>'amountMmk')::int = 500);
SELECT test.check('f01 APPROVAL_DATE COGS: 7,800 - 3,600 = 4,200',
  (:'ra'::jsonb->'totals'->>'cogsMmk')::int = 4200);
SELECT test.f_report(:ADMIN, 'shop-f', test.var('D1')::date, test.var('D1')::date, 'APPROVAL_DATE') AS ra1 \gset
SELECT test.f_report(:ADMIN, 'shop-f', test.var('D1')::date, test.var('D1')::date, 'SALE_DATE') AS rs1 \gset
SELECT test.check('f01 one day D1: APPROVAL_DATE net 4,700 vs SALE_DATE net 1,900 (the policy choice is visible, not silent)',
  (:'ra1'::jsonb->'totals'->>'netRevenueMmk')::int = 4700 AND (:'rs1'::jsonb->'totals'->>'netRevenueMmk')::int = 1900);
SELECT test.check('f01 one day D1 SALE_DATE, all costs known: COGS 3,000 - 1,800 = 1,200, profit 700, complete',
  (:'rs1'::jsonb->'totals'->>'cogsMmk')::int = 1200 AND (:'rs1'::jsonb->'totals'->>'grossProfitMmk')::int = 700
  AND (:'rs1'::jsonb->'totals'->>'cogsComplete')::boolean);
-- APPROVAL_DATE on D2 alone: r1 and r2 belong to D1 sales (outside the range) but were approved on D2
SELECT test.f_report(:ADMIN, 'shop-f', test.var('D2')::date, test.var('D2')::date, 'APPROVAL_DATE') AS ra2 \gset
SELECT test.check('f01 APPROVAL_DATE D2 only: gross 13,000, refunds 3,800 incl. r1 + r2 of D1 sales, void 2,000, net 7,200, 1 undated',
  (:'ra2'::jsonb->'totals'->>'grossSalesMmk')::int = 13000 AND (:'ra2'::jsonb->'totals'->>'refundMmk')::int = 3800
  AND (:'ra2'::jsonb->'totals'->>'refundCount')::int = 3 AND (:'ra2'::jsonb->'totals'->>'voidMmk')::int = 2000
  AND (:'ra2'::jsonb->'totals'->>'netRevenueMmk')::int = 7200 AND (:'ra2'::jsonb->'undatedAdjustments'->>'count')::int = 1,
  (:'ra2'::jsonb->'totals')::text);
SELECT test.f_report(:ADMIN, 'shop-f', test.var('D2')::date, test.var('D2')::date, 'SALE_DATE') AS rs2 \gset
SELECT test.check('f01 SALE_DATE D2 only: r1 + r2 stay with their D1 sales (refunds 1,500 = r3 + r4)',
  (:'rs2'::jsonb->'totals'->>'refundMmk')::int = 1500);

-- a malformed pending request (create_refund_void_request stores items unchecked) cannot break the report
SELECT test.setvar('bad1', test.f_request(:F2, test.var('s4'), 'PARTIAL', 'malformed', '{"amountMmk":"12.5"}'::jsonb));
SELECT test.f_report(:ADMIN, 'shop-f', test.var('D1')::date, test.var('D2')::date, 'SALE_DATE') AS rbad \gset
SELECT test.check('f01 malformed pending items: report still answers, totals unchanged, counted as unparseable',
  (:'rbad'::jsonb->'totals') = (:'rs'::jsonb->'totals') AND (:'rbad'::jsonb->'pendingRequests'->>'unparseable')::int = 1);
SELECT test.login(:MGRF) AS zz \gset
SELECT public.reject_refund_void_request(test.var('bad1'), 'malformed', gen_random_uuid()) AS rjbad \gset

-- ---------------------------------------------------------------- scope
-- Cashier F1: own sales only (s1..s4). SALE_DATE: 12,700 - (r1 1,000 + r2 1,800 + r4 500) = 9,400.
SELECT test.login(:F1) AS zz \gset
SET ROLE authenticated;
SELECT public.fin_report_summary(NULL, test.var('D1')::date, test.var('D2')::date, 'SALE_DATE') AS rf1 \gset
SELECT test.check('f01 scope cashier: OWN level, own sales only, net 9,400, no COGS / profit, no supplier section',
  :'rf1'::jsonb->'scope'->>'level' = 'OWN' AND (:'rf1'::jsonb->'totals'->>'saleCount')::int = 4
  AND (:'rf1'::jsonb->'totals'->>'netRevenueMmk')::int = 9400
  AND :'rf1'::jsonb->'totals'->'cogsMmk' = 'null'::jsonb AND :'rf1'::jsonb->'totals'->'grossProfitMmk' = 'null'::jsonb
  AND :'rf1'::jsonb->'supplierPayments' = 'null'::jsonb, (:'rf1'::jsonb->'totals')::text);
SELECT test.check('f01 MISMATCH reproduced: cashier F1 cannot read refund r1 on their own sale (RLS), yet the report deducts it',
  (SELECT count(*) FROM refund_void_requests WHERE id = test.var('r1')) = 0
  AND (SELECT count(*) FROM sales WHERE id = test.var('s1')) = 1);
SELECT test.check('f01 the report carries no refund reason text (aggregates only)',
  position('secret-reason-r1' in :'rf1'::text) = 0);
SELECT test.expect_error('f01 scope cashier: another shop is refused',
  $q$SELECT public.fin_report_summary('shop-a', current_date, current_date, 'SALE_DATE')$q$, 'not permitted to view reports for this shop');
SELECT test.expect_error('f01 scope cashier: a shop of ANOTHER organisation gets the same answer as any other shop (no existence oracle)',
  $q$SELECT public.fin_report_summary('shop-x', current_date, current_date, 'SALE_DATE')$q$, 'not permitted to view reports for this shop');
SELECT test.expect_error('f01 scope cashier: a non-existent shop gets the same answer',
  $q$SELECT public.fin_report_summary('shop-nope', current_date, current_date, 'SALE_DATE')$q$, 'not permitted to view reports for this shop');
SELECT test.expect_error('f01 refund basis is required (no silent default)',
  $q$SELECT public.fin_report_summary(NULL, current_date, current_date, NULL)$q$, 'Refund basis must be SALE_DATE or APPROVAL_DATE');
SELECT test.expect_error('f01 range above 367 days refused',
  $q$SELECT public.fin_report_summary(NULL, current_date - 400, current_date, 'SALE_DATE')$q$, 'at most 367 days');
SELECT test.expect_error('f01 helpers are not callable by authenticated (fin_sale_line_net)',
  format($q$SELECT * FROM public.fin_sale_line_net(ARRAY[%L])$q$, test.var('s2')), 'permission denied');
SELECT test.expect_error('f01 helpers are not callable by authenticated (fin_refund_lines)',
  format($q$SELECT * FROM public.fin_refund_lines(ARRAY[%L])$q$, test.var('r1')), 'permission denied');
SELECT test.expect_error('f01 helpers are not callable by authenticated (fin_approval_times)',
  format($q$SELECT * FROM public.fin_approval_times('REFUND', ARRAY[%L])$q$, test.var('r1')), 'permission denied');
SELECT test.expect_error('f01 helpers are not callable by authenticated (fin_items)',
  $q$SELECT * FROM public.fin_items('[]'::jsonb)$q$, 'permission denied');
SELECT test.expect_error('f01 helpers are not callable by authenticated (fin_report_scope)',
  $q$SELECT public.fin_report_scope(NULL)$q$, 'permission denied');
RESET ROLE;

-- Viewer F: CASHIER + sale:view + report:shop_sales. RLS shows all shop-F sales but none of its refunds.
SELECT test.login(:VIEWF) AS zz \gset
SET ROLE authenticated;
SELECT public.fin_report_summary(NULL, test.var('D1')::date, test.var('D2')::date, 'SALE_DATE') AS rv \gset
SELECT test.check('f01 MISMATCH reproduced: sale:view without pos:refund reads 6 sales and 0 refund rows of shop F',
  (SELECT count(*) FROM sales WHERE shop_id = 'shop-f') = 6 AND (SELECT count(*) FROM refund_void_requests WHERE shop_id = 'shop-f') = 0);
SELECT test.check('f01 scope viewer: SHOP level, the server report still nets all 4,300 of refunds (net 11,400), no COGS',
  :'rv'::jsonb->'scope'->>'level' = 'SHOP' AND (:'rv'::jsonb->'totals'->>'netRevenueMmk')::int = 11400
  AND :'rv'::jsonb->'totals'->'cogsMmk' = 'null'::jsonb);
RESET ROLE;

-- Manager F: shop level, no report:shop_profit by default -> no COGS
SELECT test.login(:MGRF) AS zz \gset
SET ROLE authenticated;
SELECT public.fin_report_summary('shop-f', test.var('D1')::date, test.var('D2')::date, 'SALE_DATE') AS rm \gset
SELECT test.check('f01 scope manager: SHOP, net 11,400, COGS hidden (no report:shop_profit), supplier section present',
  :'rm'::jsonb->'scope'->>'level' = 'SHOP' AND (:'rm'::jsonb->'totals'->>'netRevenueMmk')::int = 11400
  AND :'rm'::jsonb->'totals'->'cogsMmk' = 'null'::jsonb AND (:'rm'::jsonb->'scope'->>'profitVisible')::boolean = false
  AND jsonb_typeof(:'rm'::jsonb->'supplierPayments') = 'object');
SELECT test.expect_error('f01 scope manager: shop A refused', $q$SELECT public.fin_report_summary('shop-a', current_date, current_date, 'SALE_DATE')$q$, 'not permitted');
RESET ROLE;

-- Manager A cannot read shop F
SELECT test.login(:MGRA) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f01 cross-shop: manager A cannot report on shop F',
  $q$SELECT public.fin_report_summary('shop-f', current_date, current_date, 'SALE_DATE')$q$, 'not permitted');
RESET ROLE;

-- ADMIN org-wide: every org-test shop and none of org-two
SELECT test.login(:ADMIN) AS zz \gset
SET ROLE authenticated;
SELECT public.fin_report_summary(NULL, test.var('D1')::date, test.var('D2')::date, 'SALE_DATE') AS rorg \gset
SELECT test.expect_error('f01 ORG level (all shops) is limited to 93 days per call',
  $q$SELECT public.fin_report_summary(NULL, current_date - 100, current_date, 'SALE_DATE')$q$, 'at most 93 days');
SELECT test.check('f01 a single shop may still cover a year',
  jsonb_typeof(public.fin_report_summary('shop-f', current_date - 366, current_date, 'SALE_DATE')) = 'object');
SELECT test.expect_error('f01 ADMIN: a non-existent shop and another org''s shop give the same answer',
  $q$SELECT public.fin_report_summary('shop-nope', current_date, current_date, 'SALE_DATE')$q$, 'Shop not found in your organization');
RESET ROLE;
SELECT test.check('f01 scope admin: ORG level = exactly the org-test shops, no org-two shop',
  :'rorg'::jsonb->'scope'->>'level' = 'ORG'
  AND (SELECT array_agg(x ORDER BY x) FROM jsonb_array_elements_text(:'rorg'::jsonb->'scope'->'shopIds') x)
      = (SELECT array_agg(id ORDER BY id) FROM shops WHERE org_id = 'org-test'),
  (:'rorg'::jsonb->'scope'->'shopIds')::text);
SELECT test.check('f01 scope admin: org gross = ground truth over org-test sales (D1..D2, non-void)',
  (:'rorg'::jsonb->'totals'->>'grossSalesMmk')::bigint =
  (SELECT COALESCE(sum(s.total_mmk), 0) FROM sales s JOIN shops sh ON sh.id = s.shop_id
    WHERE sh.org_id = 'org-test' AND s.status <> 'VOID'
      AND (s.created_at AT TIME ZONE 'Asia/Yangon')::date BETWEEN test.var('D1')::date AND test.var('D2')::date));

-- ADMIN of org two: shop F is "not found"; org-wide totals contain no org-test money
SELECT test.login(:ADMINX) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f01 cross-tenant: org-two ADMIN cannot report on shop F',
  $q$SELECT public.fin_report_summary('shop-f', current_date, current_date, 'SALE_DATE')$q$, 'Shop not found in your organization');
SELECT public.fin_report_summary(NULL, test.var('D1')::date, test.var('D2')::date, 'SALE_DATE') AS rx \gset
RESET ROLE;
SELECT test.check('f01 cross-tenant: org-two ADMIN org report = org-two ground truth only',
  (SELECT bool_and(x IN (SELECT id FROM shops WHERE org_id = 'org-two')) FROM jsonb_array_elements_text(:'rx'::jsonb->'scope'->'shopIds') x)
  AND (:'rx'::jsonb->'totals'->>'grossSalesMmk')::bigint =
      (SELECT COALESCE(sum(s.total_mmk), 0) FROM sales s JOIN shops sh ON sh.id = s.shop_id
        WHERE sh.org_id = 'org-two' AND s.status <> 'VOID'
          AND (s.created_at AT TIME ZONE 'Asia/Yangon')::date BETWEEN test.var('D1')::date AND test.var('D2')::date),
  (:'rx'::jsonb->'totals')::text);

-- inactive user and anon
SELECT test.login(:GONEF) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f01 an inactive user is not authenticated for reports',
  $q$SELECT public.fin_report_summary(NULL, current_date, current_date, 'SALE_DATE')$q$, 'Not authenticated');
RESET ROLE;
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.expect_error('f01 anon cannot execute fin_report_summary',
  $q$SELECT public.fin_report_summary(NULL, current_date, current_date, 'SALE_DATE')$q$, 'permission denied');
SELECT test.expect_error('f01 anon cannot execute fin_shift_reconciliation',
  $q$SELECT public.fin_shift_reconciliation('x')$q$, 'permission denied');
RESET ROLE;

-- net line allocation sums exactly to the sale total (s2: 1,800 + 900 = 2,700)
SELECT test.check('f01 fin_sale_line_net: cart discount allocated by line, Σ net = total (s2: prod-2 1,800, prod-1 900)',
  (SELECT sum(net_mmk) FROM public.fin_sale_line_net(ARRAY[test.var('s2')])) = 2700
  AND (SELECT net_mmk FROM public.fin_sale_line_net(ARRAY[test.var('s2')]) WHERE product_id = 'prod-2') = 1800
  AND (SELECT net_mmk FROM public.fin_sale_line_net(ARRAY[test.var('s2')]) WHERE product_id = 'prod-1') = 900);
SELECT test.check('f01 fin_items is defensive: object / null / decimals / strings / overflow are unusable, never cast',
  (SELECT count(*) FILTER (WHERE NOT ok) FROM public.fin_items('{"a":1}'::jsonb)) = 1
  AND (SELECT count(*) FROM public.fin_items(NULL)) = 0
  AND (SELECT bool_and(NOT ok) FROM public.fin_items('[{"productId":"p","qtyUnits":1,"amountMmk":12.5},{"productId":"p","qtyUnits":"x","amountMmk":1},{"productId":"p","qtyUnits":1,"amountMmk":1e30},"str",null]'::jsonb))
  AND (SELECT amount FROM public.fin_items('[{"product_id":"p","qty_units":"2","amount_mmk":"700"}]'::jsonb)) = 700);
SELECT test.logout() AS zz \gset
