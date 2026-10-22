-- Script 2 (financial review H1): on a PFIN-D server the shift reconciliation report must show the authoritative
-- drawer (fin_shift_cash), never the pre-PFIN-D figure. Synthetic data; runs as a --script2-pre module.
\set ON_ERROR_STOP on
SELECT test.login('a0000000-0000-4000-8000-000000000004');   -- cashier A2
SET ROLE authenticated;
RESET ROLE;
-- the cashier's own open shift (the earlier smokes leave one open)
SELECT id AS rshift FROM shifts WHERE ended_at IS NULL AND cashier_id = (SELECT id FROM users WHERE auth_id = 'a0000000-0000-4000-8000-000000000004') ORDER BY started_at DESC LIMIT 1 \gset
SELECT (public.fin_shift_cash(:'rshift')->>'expectedCashMmk')::bigint AS exp0 \gset
SET ROLE authenticated;
SELECT public.fin_complete_sale_split('direct', '77777777-0000-4000-8000-0000000003a2',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',:'rshift','p_payment_method','CASH','p_paid_mmk',4000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-1","qty":4}]'::jsonb,'p_idempotency_key','77777777-0000-4000-8000-0000000003a2'),
  '[{"method":"CASH","amountMmk":1000},{"method":"CARD","amountMmk":3000}]') AS rsale \gset
SELECT public.fin_record_cash_movement(:'rshift', 'PAY_IN', 700, 'Float from safe', NULL, NULL, '77777777-0000-4000-8000-0000000003a3') AS rmove \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000001');   -- admin
SET ROLE authenticated;
SELECT public.fin_shift_reconciliation(:'rshift') AS recon \gset
RESET ROLE;
SELECT test.check('fr01 open shift: the reconciliation''s expected cash is the authoritative fin_shift_cash figure (before + cash part 1000 + 700 in)',
  (:'recon'::jsonb->>'evidenceExpectedCashMmk')::bigint = (public.fin_shift_cash(:'rshift')->>'expectedCashMmk')::bigint
  AND (:'recon'::jsonb->>'evidenceExpectedCashMmk')::bigint = :exp0 + 1000 + 700 AND :'recon'::jsonb->>'model' = 'PFIN-D',
  :'recon'::jsonb->>'evidenceExpectedCashMmk');
SELECT test.check('fr02 cash sales = fin_shift_cash cash sales (split counted by its CASH part); movements recorded',
  (:'recon'::jsonb->'cashSales'->>'amountMmk')::bigint = (public.fin_shift_cash(:'rshift')->>'cashSalesMmk')::bigint AND (:'recon'::jsonb->'cashMovements'->>'recorded')::boolean
  AND (:'recon'::jsonb->'cashMovements'->>'inMmk')::bigint >= 700, (:'recon'::jsonb)::text);
-- the close is tried inside a transaction that is rolled back (later smokes still use this shift)
BEGIN;
SELECT test.login('a0000000-0000-4000-8000-000000000004');
SET LOCAL ROLE authenticated;
SELECT public.fin_close_shift(:'rshift', (public.fin_shift_cash_summary(:'rshift')->>'expectedCashMmk')::int, NULL, NULL, NULL, '77777777-0000-4000-8000-0000000003a4') AS rclose \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000001');
SET LOCAL ROLE authenticated;
SELECT public.fin_shift_reconciliation(:'rshift') AS recon2 \gset
RESET ROLE;
ROLLBACK;
SELECT test.check('fr03 closed shift: stored expected matches the evidence (no false variance)',
  (:'recon2'::jsonb->>'storedMatchesEvidence')::boolean AND (:'recon2'::jsonb->>'evidenceVarianceMmk')::bigint = 0, (:'recon2'::jsonb)::text);
SELECT test.logout();
