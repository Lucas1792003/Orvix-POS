-- f02: fin_shift_reconciliation on the f01 fixtures.
--   S1 (F1): opening 50,000; CASH s1 2,000 + s2 2,700 + s4 5,000; OTHER s3 3,000;
--            closed at B + 30 s, counted 59,700; refunds r1 1,000 and r2 1,800 of
--            its cash sales were approved AFTER it closed.
--   S2 (F2): opening 20,000; CASH s5 3,000 + s6 2,000; r3 1,000 and the void of
--            s6 approved while open; counted 19,200 (manager paid r1 + r2 from it).
\set ON_ERROR_STOP on
\set ADMIN   '''a0000000-0000-4000-8000-000000000001'''
\set ADMINX  '''a0000000-0000-4000-8000-000000000011'''
\set MGRF    '''f0000000-0000-4000-8000-000000000001'''
\set F1      '''f0000000-0000-4000-8000-000000000002'''
\set F2      '''f0000000-0000-4000-8000-000000000003'''
\set MGRB    '''a0000000-0000-4000-8000-000000000005'''

CREATE OR REPLACE FUNCTION test.f_recon(p_auth uuid, p_shift text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test.login(p_auth);
  RETURN public.fin_shift_reconciliation(p_shift);
END $$;
GRANT EXECUTE ON FUNCTION test.f_recon(uuid, text) TO authenticated;
CREATE OR REPLACE FUNCTION test.fin_approval_time_for_test(p_id text) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT approved_at FROM public.fin_approval_times('REFUND', ARRAY[p_id])
$$;

-- a legacy CASH refund on s5 (S2) with no approval record: listed, never deducted
INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, created_at, items, status)
VALUES ('refund-legacy-r5', test.var('s5'), 'shop-f', 'PARTIAL', 'legacy', 'u-cash-f2', now() - interval '1 minute',
        '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]', 'APPROVED');

-- ---------------------------------------------------------------- S1
SELECT test.f_recon(:MGRF, test.var('S1')) AS x1 \gset
SELECT test.check('f02 S1: CLOSED, cash sales 3 x = 9,700, OTHER 3,000 listed apart',
  :'x1'::jsonb->'shift'->>'status' = 'CLOSED'
  AND (:'x1'::jsonb->'cashSales'->>'count')::int = 3 AND (:'x1'::jsonb->'cashSales'->>'amountMmk')::int = 9700
  AND (:'x1'::jsonb->'nonCashSales'->0->>'method') = 'OTHER' AND (:'x1'::jsonb->'nonCashSales'->0->>'amountMmk')::int = 3000,
  (:'x1'::jsonb->'cashSales')::text);
SELECT test.check('f02 S1: refunds approved after close (r1 + r2 = 2,800) are listed as afterClose and NOT deducted',
  (:'x1'::jsonb->'afterClosePayouts'->>'count')::int = 2 AND (:'x1'::jsonb->'afterClosePayouts'->>'amountMmk')::int = 2800
  AND (:'x1'::jsonb->'attributedPayouts'->>'amountMmk')::int = 0);
SELECT test.check('f02 S1: the server close time comes from the idempotency ledger (S1 was closed with a past client stamp)',
  :'x1'::jsonb->'shift'->>'closeTimeSource' = 'SERVER_LEDGER'
  AND (:'x1'::jsonb->'shift'->>'closeRecordedAt')::timestamptz > (:'x1'::jsonb->'shift'->>'endedAt')::timestamptz);
SELECT test.check('f02 S1: evidence expected 59,700 = stored expected; variance 0; stored figures untouched',
  (:'x1'::jsonb->>'evidenceExpectedCashMmk')::int = 59700 AND (:'x1'::jsonb->>'storedMatchesEvidence')::boolean
  AND (:'x1'::jsonb->>'evidenceVarianceMmk')::int = 0
  AND (SELECT expected_cash_mmk FROM shifts WHERE id = test.var('S1')) = 59700);
SELECT test.check('f02 S1: cash movements reported as NOT RECORDED (never as zero)',
  (:'x1'::jsonb->'cashMovements'->>'recorded')::boolean = false
  AND :'x1'::jsonb->'cashMovements'->>'reason' = 'NOT_RECORDED_BEFORE_CASH_MOVEMENTS');

-- ---------------------------------------------------------------- S2
SELECT test.f_recon(:MGRF, test.var('S2')) AS x2 \gset
SELECT test.check('f02 S2: cash sales 5,000 (incl. the voided s6); attributed r3 1,000 + void 2,000 = 3,000',
  (:'x2'::jsonb->'cashSales'->>'amountMmk')::int = 5000
  AND (:'x2'::jsonb->'attributedPayouts'->>'refundMmk')::int = 1000 AND (:'x2'::jsonb->'attributedPayouts'->>'voidMmk')::int = 2000,
  (:'x2'::jsonb->'attributedPayouts')::text);
SELECT test.check('f02 S2: evidence expected 22,000 = stored (close_shift formula reproduced), variance -2,800',
  (:'x2'::jsonb->>'evidenceExpectedCashMmk')::int = 22000 AND (:'x2'::jsonb->>'storedMatchesEvidence')::boolean
  AND (:'x2'::jsonb->>'evidenceVarianceMmk')::int = -2800);
SELECT test.check('f02 S2: the -2,800 variance is explained by cross-shift payouts r1 + r2 approved while S2 was open (listed, not deducted)',
  (:'x2'::jsonb->'crossShiftPayoutsDuringShift'->>'count')::int = 2
  AND (:'x2'::jsonb->'crossShiftPayoutsDuringShift'->>'amountMmk')::int = 2800
  AND (SELECT bool_and(i->>'saleShiftId' = test.var('S1')) FROM jsonb_array_elements(:'x2'::jsonb->'crossShiftPayoutsDuringShift'->'items') i),
  (:'x2'::jsonb->'crossShiftPayoutsDuringShift')::text);
SELECT test.check('f02 S2: the legacy refund without approval time is UNKNOWN_TIME (1 x 1,000), not deducted',
  (:'x2'::jsonb->'unknownTimePayouts'->>'count')::int = 1 AND (:'x2'::jsonb->'unknownTimePayouts'->>'amountMmk')::int = 1000
  AND (:'x2'::jsonb->>'evidenceExpectedCashMmk')::int = 22000);

-- the cashier sees their own shift; the cross-shift and supplier blocks are withheld (null)
SELECT test.login(:F2) AS zz \gset
SET ROLE authenticated;
SELECT public.fin_shift_reconciliation(test.var('S2')) AS x2c \gset
SELECT test.check('f02 cashier F2 own shift: same figures; other cashiers'' refunds (cross-shift block) and supplier payments withheld entirely',
  (:'x2c'::jsonb->>'evidenceExpectedCashMmk')::int = 22000
  AND :'x2c'::jsonb->'crossShiftPayoutsDuringShift' = 'null'::jsonb
  AND :'x2c'::jsonb->'supplierCashPaymentsDuringShift' = 'null'::jsonb);
SELECT test.expect_error('f02 cashier F2 cannot open S1 (another cashier''s shift)',
  format($q$SELECT public.fin_shift_reconciliation(%L)$q$, test.var('S1')), 'not permitted to view this shift');
RESET ROLE;

SELECT test.login(:MGRB) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f02 cross-shop: manager B cannot open a shop-F shift',
  format($q$SELECT public.fin_shift_reconciliation(%L)$q$, test.var('S1')), 'not permitted to view this shift');
RESET ROLE;
SELECT test.login(:ADMINX) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f02 cross-tenant: org-two ADMIN gets "Shift not found" (same as a non-existent id)',
  format($q$SELECT public.fin_shift_reconciliation(%L)$q$, test.var('S1')), 'Shift not found');
SELECT test.expect_error('f02 unknown shift id', $q$SELECT public.fin_shift_reconciliation('shift-nope')$q$, 'Shift not found');
RESET ROLE;

-- ---------------------------------------------------------------- open shift (live)
SELECT test.setvar('S3', test.f_open(:F1, 'shop-f', 10000, NULL));
SELECT test.setvar('s8', test.f_sale(:F1, 'shop-f', test.var('S3'), 'CASH', 1500, 0, '[{"product_id":"prod-1","qty":1}]', NULL));
SELECT test.f_recon(:F1, test.var('S3')) AS x3 \gset
SELECT test.check('f02 open shift: OPEN, live evidence expected 11,000, nothing stored yet, change not counted as cash in',
  :'x3'::jsonb->'shift'->>'status' = 'OPEN' AND (:'x3'::jsonb->>'evidenceExpectedCashMmk')::int = 11000
  AND :'x3'::jsonb->'storedMatchesEvidence' = 'null'::jsonb AND :'x3'::jsonb->'evidenceVarianceMmk' = 'null'::jsonb);
SELECT test.check('f02 open shift: the stored row was not touched by the read',
  (SELECT expected_cash_mmk IS NULL AND ended_at IS NULL FROM shifts WHERE id = test.var('S3')));

-- ---------------------------------------------------------------- offline close stamp
-- S4 (F2): a refund approved at server time T is deducted by close_shift,
-- which runs AFTER T but carries a client stamp BEFORE T (offline close).
SELECT test.setvar('S4', test.f_open(:F2, 'shop-f', 5000, now() - interval '20 minutes'));
SELECT test.setvar('s13', test.f_sale(:F2, 'shop-f', test.var('S4'), 'CASH', 2000, 0, '[{"product_id":"prod-1","qty":2}]', now() - interval '15 minutes'));
SELECT test.setvar('r6', test.f_request(:F1, test.var('s13'), 'PARTIAL', 'r6', '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]'));
SELECT test.f_approve(:MGRF, test.var('r6')) AS a6x \gset
SELECT test.f_close(:F2, test.var('S4'), 6000, NULL, now() - interval '5 minutes') AS c4 \gset
SELECT test.check('f02 S4 fixture: close_shift deducted the refund (stored expected 6,000) although ended_at precedes its approval',
  (:'c4'::jsonb->'shift'->>'expectedCashMmk')::int = 6000
  AND (SELECT ended_at FROM shifts WHERE id = test.var('S4')) < test.fin_approval_time_for_test(test.var('r6')));
SELECT test.f_recon(:MGRF, test.var('S4')) AS x4 \gset
SELECT test.check('f02 S4 with the server close time on record: the refund is ATTRIBUTED, stored = evidence (6,000)',
  :'x4'::jsonb->'shift'->>'closeTimeSource' = 'SERVER_LEDGER' AND (:'x4'::jsonb->'attributedPayouts'->>'amountMmk')::int = 1000
  AND (:'x4'::jsonb->'afterClosePayouts'->>'count')::int = 0 AND (:'x4'::jsonb->>'storedMatchesEvidence')::boolean,
  (:'x4'::jsonb->'shift')::text);
-- the same shift when the ledger row is gone (062's 30-day prune ran before 086): no guess
BEGIN;
DELETE FROM idempotency_keys WHERE rpc = 'close_shift' AND response->'shift'->>'id' = test.var('S4');
SELECT test.f_recon(:MGRF, test.var('S4')) AS x4b \gset
ROLLBACK;
SELECT test.check('f02 S4 without the server close time: the refund is CLOSE_WINDOW (listed, not deducted, not called after-close)',
  :'x4b'::jsonb->'shift'->>'closeTimeSource' = 'ENDED_AT_ONLY'
  AND (:'x4b'::jsonb->'closeWindowPayouts'->>'amountMmk')::int = 1000 AND (:'x4b'::jsonb->'afterClosePayouts'->>'count')::int = 0
  AND (:'x4b'::jsonb->>'evidenceExpectedCashMmk')::int = 7000 AND NOT (:'x4b'::jsonb->>'storedMatchesEvidence')::boolean
  AND (:'x4b'::jsonb->>'storedMatchesEvidenceIfCloseWindowDeducted')::boolean, (:'x4b'::jsonb)::text);

-- a till clock 3 minutes FAST: ended_at is later than the server close time.
-- A refund approved after close_shift ran (but before the fast ended_at) was
-- NOT deducted, so it must be AFTER_CLOSE, not ATTRIBUTED.
SELECT test.setvar('S5', test.f_open(:F2, 'shop-f', 1000, now() - interval '10 minutes'));
SELECT test.setvar('s17', test.f_sale(:F2, 'shop-f', test.var('S5'), 'CASH', 3000, 0, '[{"product_id":"prod-1","qty":3}]', now() - interval '5 minutes'));
SELECT test.setvar('r7', test.f_request(:F1, test.var('s17'), 'PARTIAL', 'r7', '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]'));
SELECT test.f_close(:F2, test.var('S5'), 4000, NULL, now() + interval '3 minutes') AS c5 \gset
SELECT pg_sleep(0.05);
SELECT test.f_approve(:MGRF, test.var('r7')) AS a7 \gset
SELECT test.f_recon(:MGRF, test.var('S5')) AS x5 \gset
SELECT test.check('f02 fast till clock: stored expected 4,000; the refund approved after close_shift ran is AFTER_CLOSE; evidence = stored',
  (:'c5'::jsonb->'shift'->>'expectedCashMmk')::int = 4000
  AND (SELECT ended_at FROM shifts WHERE id = test.var('S5')) > test.fin_approval_time_for_test(test.var('r7'))
  AND (:'x5'::jsonb->'afterClosePayouts'->>'amountMmk')::int = 1000 AND (:'x5'::jsonb->'attributedPayouts'->>'amountMmk')::int = 0
  AND (:'x5'::jsonb->>'storedMatchesEvidence')::boolean, (:'x5'::jsonb->'shift')::text);

-- ADMIN may read any shop-F shift
SELECT test.f_recon(:ADMIN, test.var('S2')) AS xa \gset
SELECT test.check('f02 ADMIN reads S2 with full detail', jsonb_typeof(:'xa'::jsonb->'crossShiftPayoutsDuringShift'->'items') = 'array');
SELECT test.logout() AS zz \gset
DROP FUNCTION test.fin_approval_time_for_test(text);
