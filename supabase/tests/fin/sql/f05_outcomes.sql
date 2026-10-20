-- f05: offline / uncertain operation outcomes (086 op_execute / op_status)
-- and what the reports count for each. Keys are UUIDv7 (the offline queue's
-- format); every call carries the queued actor.
--   committed + replay   -> counted exactly once
--   rejected (070)       -> recorded as a definitive refusal, nothing counted
--   fenced (abandoned)   -> never executes, nothing counted
--   dependency failure   -> not recorded, nothing counted, still executable
\set ON_ERROR_STOP on
\set ADMIN '''a0000000-0000-4000-8000-000000000001'''
\set MGRF  '''f0000000-0000-4000-8000-000000000001'''
\set F1    '''f0000000-0000-4000-8000-000000000002'''
\set F2    '''f0000000-0000-4000-8000-000000000003'''

SELECT test.uuid7() AS k1 \gset
SELECT test.uuid7() AS k2 \gset
SELECT test.uuid7() AS k3 \gset
SELECT test.uuid7() AS k4 \gset
SELECT test.uuid7() AS k5 \gset
SELECT (now() AT TIME ZONE 'Asia/Yangon')::date AS today \gset
SELECT test.f_report(:ADMIN, 'shop-f', :'today'::date, :'today'::date, 'SALE_DATE') AS r0 \gset

SELECT jsonb_build_object('p_shop_id', 'shop-f', 'p_shift_id', test.var('S3'), 'p_payment_method', 'CASH',
  'p_paid_mmk', 900, 'p_cart_discount_pct', 10, 'p_items', '[{"product_id":"prod-1","qty":1}]'::jsonb) AS sale_args \gset

-- 1. committed, then replayed (the till did not see the first answer)
SELECT test.login(:F1) AS zz \gset
SET ROLE authenticated;
SELECT public.op_execute(:'k1', 'complete_sale', :'sale_args'::jsonb, 'u-cash-f1') AS e1 \gset
SELECT public.op_execute(:'k1', 'complete_sale', :'sale_args'::jsonb, 'u-cash-f1') AS e1r \gset
RESET ROLE;
SELECT test.setvar('s12', :'e1'::jsonb->'response'->'sale'->>'id');
SELECT test.check('f05 committed then replayed: one sale, identical response',
  :'e1'::jsonb->>'outcome' = 'committed' AND :'e1r'::jsonb->>'outcome' = 'committed'
  AND (:'e1r'::jsonb->>'replayed')::boolean AND :'e1'::jsonb->'response' = :'e1r'::jsonb->'response'
  AND (SELECT count(*) FROM sales WHERE id = test.var('s12')) = 1);
SELECT test.f_report(:ADMIN, 'shop-f', :'today'::date, :'today'::date, 'SALE_DATE') AS r1 \gset
SELECT test.check('f05 report counts the replayed sale exactly once (+1 sale, +900)',
  (:'r1'::jsonb->'totals'->>'saleCount')::int = (:'r0'::jsonb->'totals'->>'saleCount')::int + 1
  AND (:'r1'::jsonb->'totals'->>'grossSalesMmk')::bigint = (:'r0'::jsonb->'totals'->>'grossSalesMmk')::bigint + 900);

-- 2. a refund over-ask approved through the executor: 070's own refusal (above the line total) is RECORDED as rejected
SELECT test.setvar('q8', test.f_request(:F2, test.var('s12'), 'PARTIAL', 'over-ask via queue',
  '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1001}]'));
SELECT test.login(:MGRF) AS zz \gset
SET ROLE authenticated;
SELECT public.op_execute(:'k2', 'approve_refund_request', jsonb_build_object('p_request_id', test.var('q8')), 'u-mgr-f') AS e2 \gset
SELECT public.op_execute(:'k2', 'approve_refund_request', jsonb_build_object('p_request_id', test.var('q8')), 'u-mgr-f') AS e2r \gset
SELECT public.op_status(:'k2', 'approve_refund_request', false, 'u-mgr-f', jsonb_build_object('p_request_id', test.var('q8'))) AS st2 \gset
RESET ROLE;
SELECT test.check('f05 refund refusal through op_execute: outcome rejected, message kept, replay answers rejected',
  :'e2'::jsonb->>'outcome' = 'rejected' AND :'e2'::jsonb->>'message' LIKE 'Refund amount exceeds original sale amount for prod-1%'
  AND :'e2r'::jsonb->>'outcome' = 'rejected' AND (:'e2r'::jsonb->>'replayed')::boolean
  AND :'st2'::jsonb->>'status' = 'rejected', :'e2'::text);
SELECT test.check('f05 the rejected approval left nothing: request REQUESTED, no RETURN_IN movement, no REFUND audit row',
  (SELECT status FROM refund_void_requests WHERE id = test.var('q8')) = 'REQUESTED'
  AND NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reference_id = test.var('s12') AND type = 'RETURN_IN')
  AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE entity_id = test.var('q8') AND action_type = 'REFUND'));
SELECT test.f_report(:ADMIN, 'shop-f', :'today'::date, :'today'::date, 'SALE_DATE') AS r2 \gset
SELECT test.check('f05 report after the rejected approval: refunds unchanged, the request appears only as pending',
  (:'r2'::jsonb->'totals'->>'refundMmk') = (:'r1'::jsonb->'totals'->>'refundMmk')
  AND (:'r2'::jsonb->'pendingRequests'->>'count')::int = (:'r1'::jsonb->'pendingRequests'->>'count')::int + 1);

-- 3. fenced before it ever arrived (till reset / operator decision): never executes
SELECT test.login(:F1) AS zz \gset
SET ROLE authenticated;
SELECT public.op_status(:'k3', 'complete_sale', true, 'u-cash-f1', :'sale_args'::jsonb) AS f3 \gset
SELECT public.op_execute(:'k3', 'complete_sale', :'sale_args'::jsonb, 'u-cash-f1') AS e3 \gset
RESET ROLE;
SELECT test.check('f05 fenced key: abandoned, the late delivery does not execute',
  :'f3'::jsonb->>'status' = 'abandoned' AND :'e3'::jsonb->>'outcome' = 'abandoned', :'e3'::text);

-- 4. dependency failure (the shift is closed): NOT recorded, still executable, raises with the hint
SELECT test.login(:F2) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f05 sale on a closed shift via op_execute: original error, not recorded',
  format($q$SELECT public.op_execute(%L::uuid, 'complete_sale', %L::jsonb, 'u-cash-f2')$q$, :'k4',
    jsonb_build_object('p_shop_id', 'shop-f', 'p_shift_id', test.var('S2'), 'p_payment_method', 'CASH',
      'p_paid_mmk', 1000, 'p_cart_discount_pct', 0, 'p_items', '[{"product_id":"prod-1","qty":1}]'::jsonb)),
  'No open shift for this cashier and shop');
SELECT public.op_status(:'k4', 'complete_sale', false, 'u-cash-f2', NULL) AS st4 \gset
SELECT public.op_status(:'k5', 'complete_sale', false, 'u-cash-f2', NULL) AS st5 \gset
RESET ROLE;
SELECT test.check('f05 dependency failure leaves the key undecided (not_found, executable); an unknown key likewise',
  :'st4'::jsonb->>'status' = 'not_found' AND (:'st4'::jsonb->>'executable')::boolean
  AND :'st5'::jsonb->>'status' = 'not_found');
SELECT test.f_report(:ADMIN, 'shop-f', :'today'::date, :'today'::date, 'SALE_DATE') AS r4 \gset
SELECT test.check('f05 report after fence + dependency failure: unchanged since the rejected approval',
  (:'r4'::jsonb->'totals') = (:'r2'::jsonb->'totals'));

-- 5. the reports are read-only: no idempotency row, no write of any kind
SELECT count(*) AS keys_before FROM idempotency_keys \gset
SELECT test.f_report(:ADMIN, NULL, :'today'::date - 30, :'today'::date, 'APPROVAL_DATE') AS rz \gset
SELECT test.f_recon(:ADMIN, test.var('S2')) AS zz2 \gset
SELECT test.check('f05 reports write nothing (idempotency ledger unchanged)',
  (SELECT count(*) FROM idempotency_keys) = :keys_before);
SELECT test.check('f05 the 6 report functions are STABLE and fin_items IMMUTABLE (none can write)',
  (SELECT bool_and(provolatile = 's') FROM pg_proc WHERE proname IN ('fin_report_summary', 'fin_shift_reconciliation',
     'fin_report_scope', 'fin_sale_line_net', 'fin_approval_times', 'fin_refund_lines'))
   AND (SELECT count(*) FROM pg_proc WHERE proname IN ('fin_report_summary', 'fin_shift_reconciliation',
     'fin_report_scope', 'fin_sale_line_net', 'fin_approval_times', 'fin_refund_lines')) = 6
   AND (SELECT provolatile FROM pg_proc WHERE proname = 'fin_items') = 'i');
SELECT test.setvar('f05_totals', (:'r4'::jsonb->'totals')::text);
SELECT test.logout() AS zz \gset
