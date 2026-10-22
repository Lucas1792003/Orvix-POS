-- c01 (HELD, runs only with FIN_WITH_HELD=1, after f05 and after PFIN-C was
-- applied to the populated database): refunds capped at what the customer
-- paid after discounts. Not part of the PFIN-A/B checkpoint.
-- c7 (S3, F1): 2 x prod-2 + 1 x prod-1, 10 % cart: 5,000 - 500 = 4,500.
-- Net by line: prod-2 4,000 x 0.9 = 3,600 ; prod-1 1,000 x 0.9 = 900.
\set ON_ERROR_STOP on
SELECT test.check('c01 precondition: PFIN-C triggers installed (insert + update)',
  (SELECT count(*) FROM pg_trigger WHERE tgname IN ('fin_guard_refund_net_paid_ins', 'fin_guard_refund_net_paid_upd')) = 2);
SELECT test.check('c01 PFIN-C did not re-check or change existing over-refunds (f03''s rows still APPROVED)',
  (SELECT status FROM refund_void_requests WHERE id = 'refund-legacy-over') = 'APPROVED'
  AND (SELECT status FROM refund_void_requests WHERE id = test.var('q1')) = 'APPROVED');
\set MGRF    '''f0000000-0000-4000-8000-000000000001'''
\set F1      '''f0000000-0000-4000-8000-000000000002'''
\set F2      '''f0000000-0000-4000-8000-000000000003'''
\set ADMIN   '''a0000000-0000-4000-8000-000000000001'''

SELECT test.setvar('c7', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 4500, 10,
  '[{"product_id":"prod-2","qty":2},{"product_id":"prod-1","qty":1}]', NULL));
SELECT test.check('c01 fixture: c7 total 4,500', (SELECT total_mmk FROM sales WHERE id = test.var('c7')) = 4500);

-- the over-ask: prod-2 refunded at its PRE-cart-discount line total 4,000
SELECT test.setvar('cq1', test.f_request(:F2, test.var('c7'), 'PARTIAL', 'over-ask',
  '[{"productId":"prod-2","qtyUnits":2,"amountMmk":4000}]'));

-- DEFECT demonstration (070 alone): with the PFIN-C trigger disabled the
-- approval of 4,000 SUCCEEDS although the customer paid 3,600 for prod-2.
-- Done inside a transaction that is rolled back.
BEGIN;
ALTER TABLE refund_void_requests DISABLE TRIGGER fin_guard_refund_net_paid_upd;
SELECT (test.f_approve(:MGRF, test.var('cq1'))->'request'->>'status') AS defect_status \gset
ROLLBACK;
SELECT test.check('c01 DEFECT (070 without PFIN-C): a 4,000 refund of prod-2 is approved on a sale that took 3,600 for it',
  :'defect_status' = 'APPROVED');
SELECT test.check('c01 the demonstration was rolled back (request still REQUESTED, trigger enabled)',
  (SELECT status FROM refund_void_requests WHERE id = test.var('cq1')) = 'REQUESTED'
  AND (SELECT bool_and(tgenabled = 'O') FROM pg_trigger WHERE tgname LIKE 'fin_guard_refund_net_paid%'));

-- with PFIN-C: refused, nothing written
SELECT count(*) AS mv_before FROM inventory_movements WHERE reference_id = test.var('c7') \gset
SELECT count(*) AS au_before FROM audit_logs WHERE entity_id = test.var('cq1') AND action_type = 'REFUND' \gset
SELECT test.login(:MGRF) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('c01 PFIN-C refuses 4,000 for prod-2 (3,600 refundable after the cart discount)',
  format($q$SELECT public.approve_refund_request(%L, gen_random_uuid())$q$, test.var('cq1')),
  'Refund amount exceeds what the customer paid for Product Two after discounts (3600 MMK refundable)');
RESET ROLE;
SELECT test.check('c01 refused approval wrote nothing: request REQUESTED, sale NORMAL, no movement, no audit row',
  (SELECT status FROM refund_void_requests WHERE id = test.var('cq1')) = 'REQUESTED'
  AND (SELECT status FROM sales WHERE id = test.var('c7')) = 'NORMAL'
  AND (SELECT count(*) FROM inventory_movements WHERE reference_id = test.var('c7')) = :mv_before
  AND (SELECT count(*) FROM audit_logs WHERE entity_id = test.var('cq1') AND action_type = 'REFUND') = :au_before);
SELECT test.check('c01 the refusal text is classified by 086 as a definitive rejection',
  public.op_classify_refusal('P0001', 'Refund amount exceeds what the customer paid for Product Two after discounts (3600 MMK refundable)') = 'rejected'
  AND public.op_classify_refusal('P0001', 'Refund amount exceeds the sale total after discounts (0 MMK refundable)') = 'rejected');

-- reject the over-ask; partial refunds up to the exact net amounts pass
SELECT test.login(:MGRF) AS zz \gset
SELECT public.reject_refund_void_request(test.var('cq1'), 'over-ask', gen_random_uuid()) AS rj \gset
SELECT test.setvar('cq2', test.f_request(:F2, test.var('c7'), 'PARTIAL', 'one unit',
  '[{"productId":"prod-2","qtyUnits":1,"amountMmk":1800}]'));
SELECT test.f_approve(:MGRF, test.var('cq2')) AS aq2 \gset
SELECT test.setvar('cq3', test.f_request(:F2, test.var('c7'), 'PARTIAL', 'second unit + 1 MMK too much',
  '[{"productId":"prod-2","qtyUnits":1,"amountMmk":1801}]'));
SELECT test.login(:MGRF) AS zz \gset
SELECT test.expect_error('c01 cumulative: 1,800 + 1,801 > 3,600 refused (1,800 refundable)',
  format($q$SELECT public.approve_refund_request(%L, gen_random_uuid())$q$, test.var('cq3')), '(1800 MMK refundable)');
SELECT public.reject_refund_void_request(test.var('cq3'), 'too much', gen_random_uuid()) AS rj3 \gset
SELECT test.setvar('cq4', test.f_request(:F2, test.var('c7'), 'PARTIAL', 'rest of the sale',
  '[{"productId":"prod-2","qtyUnits":1,"amountMmk":1800},{"productId":"prod-1","qtyUnits":1,"amountMmk":900}]'));
SELECT test.f_approve(:MGRF, test.var('cq4')) AS aq4 \gset
SELECT test.check('c01 full refund in two partials = exactly the 4,500 paid; stock returned 3 units',
  :'aq2'::jsonb->'request'->>'status' = 'APPROVED' AND :'aq4'::jsonb->'request'->>'status' = 'APPROVED'
  AND (SELECT sum((i->>'amountMmk')::int) FROM refund_void_requests r, jsonb_array_elements(r.items) i
        WHERE r.sale_id = test.var('c7') AND r.status = 'APPROVED') = 4500
  AND (SELECT sum(qty_change) FROM inventory_movements WHERE reference_id = test.var('c7') AND type = 'RETURN_IN') = 3);
SELECT test.setvar('cq5', test.f_request(:F2, test.var('c7'), 'PARTIAL', 'nothing left', '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1}]'));
SELECT test.login(:MGRF) AS zz \gset
SELECT test.expect_error('c01 a fully refunded sale refuses even 1 MMK more (the 070 qty check fires first)',
  format($q$SELECT public.approve_refund_request(%L, gen_random_uuid())$q$, test.var('cq5')), 'Refund quantity exceeds original sale quantity');

-- no-discount sale: the full line price remains refundable (no behaviour change)
SELECT test.setvar('c9', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 2000, 0, '[{"product_id":"prod-2","qty":1}]', NULL));
SELECT test.setvar('cq6', test.f_request(:F2, test.var('c9'), 'PARTIAL', 'full price', '[{"productId":"prod-2","qtyUnits":1,"amountMmk":2000}]'));
SELECT test.check('c01 undiscounted sale: refund of the full 2,000 still approved',
  test.f_approve(:MGRF, test.var('cq6'))->'request'->>'status' = 'APPROVED');

-- item-discounted line (no cart discount): line total already net; 25 % off prod-3 = 2,250
SELECT test.setvar('c10', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 2250, 0,
  '[{"product_id":"prod-3","qty":1,"item_discount_pct":25}]', NULL));
SELECT test.setvar('cq7', test.f_request(:F2, test.var('c10'), 'PARTIAL', 'item disc', '[{"productId":"prod-3","qtyUnits":1,"amountMmk":3000}]'));
SELECT test.login(:MGRF) AS zz \gset
SELECT test.expect_error('c01 item-discounted line: 3,000 (list price) refused, 070''s own line-total check fires first',
  format($q$SELECT public.approve_refund_request(%L, gen_random_uuid())$q$, test.var('cq7')), 'Refund amount exceeds original sale amount');

-- a privileged direct INSERT of an APPROVED over-refund is refused as well
SELECT test.setvar('c11', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 900, 10, '[{"product_id":"prod-1","qty":1}]', NULL));
SELECT test.expect_error('c01 PFIN-C also refuses a direct (superuser) INSERT of an APPROVED over-refund',
  format($q$INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, created_at, items, status)
     VALUES ('refund-direct-over', %L, 'shop-f', 'PARTIAL', 'x', 'u-cash-f2', now(), '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]', 'APPROVED')$q$,
     test.var('c11')), '(900 MMK refundable)');
SELECT test.expect_error('c01 PFIN-C refuses editing the items of an APPROVED refund upwards',
  format($q$UPDATE refund_void_requests SET items = '[{"productId":"prod-2","qtyUnits":1,"amountMmk":2001}]' WHERE id = %L$q$, test.var('cq6')),
  '(2000 MMK refundable)');
-- ---------------------------------------------------------------- server = client allocation (ties)
-- f03's s14: three lines of 1,000, total 2,998, server and client nets 999 / 999 / 1,000.
-- the product on the line with the LARGEST id is refundable for the full 1,000 the client asks for
SELECT product_id AS tie_top FROM sale_items WHERE sale_id = test.var('s14') ORDER BY id COLLATE "C" DESC LIMIT 1 \gset
SELECT test.setvar('cq9', test.f_request(:F2, test.var('s14'), 'PARTIAL', 'tie top',
  jsonb_build_array(jsonb_build_object('productId', :'tie_top', 'qtyUnits', 1, 'amountMmk', 1000))));
SELECT test.check('c01 tie: the client''s 1,000 for the largest-id line is approved (no 1 MMK rejection)',
  test.f_approve(:MGRF, test.var('cq9'))->'request'->>'status' = 'APPROVED');
-- the PFIN-C refusal through the 086 executor is RECORDED as a definitive rejection
SELECT test.uuid7() AS ck2 \gset
SELECT test.setvar('c12', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 900, 10, '[{"product_id":"prod-1","qty":1}]', NULL));
SELECT test.setvar('cq8', test.f_request(:F2, test.var('c12'), 'PARTIAL', 'over-ask via queue',
  '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]'));
SELECT test.login(:MGRF) AS zz \gset
SET ROLE authenticated;
SELECT public.op_execute(:'ck2', 'approve_refund_request', jsonb_build_object('p_request_id', test.var('cq8')), 'u-mgr-f') AS ce2 \gset
SELECT public.op_execute(:'ck2', 'approve_refund_request', jsonb_build_object('p_request_id', test.var('cq8')), 'u-mgr-f') AS ce2r \gset
RESET ROLE;
SELECT test.check('c01 PFIN-C refusal through op_execute: outcome rejected, message kept, replay answers rejected',
  :'ce2'::jsonb->>'outcome' = 'rejected'
  AND :'ce2'::jsonb->>'message' LIKE 'Refund amount exceeds what the customer paid for Product One after discounts (900 MMK refundable)%'
  AND :'ce2r'::jsonb->>'outcome' = 'rejected' AND (:'ce2r'::jsonb->>'replayed')::boolean, :'ce2'::text);
SELECT test.check('c01 the rejected approval left nothing (request REQUESTED, no REFUND audit row)',
  (SELECT status FROM refund_void_requests WHERE id = test.var('cq8')) = 'REQUESTED'
  AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE entity_id = test.var('cq8') AND action_type = 'REFUND'));
-- f06 compares the under-087 report with the figures before 087: refresh them
SELECT test.f_report(:ADMIN, 'shop-f', (now() AT TIME ZONE 'Asia/Yangon')::date, (now() AT TIME ZONE 'Asia/Yangon')::date, 'SALE_DATE') AS cfinal \gset
SELECT test.setvar('f05_totals', (:'cfinal'::jsonb->'totals')::text);
SELECT test.logout() AS zz \gset
