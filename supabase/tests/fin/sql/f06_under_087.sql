-- f06: with migration 087 installed (HELD: no lease, no witness authority).
-- PFIN-A/B were re-applied by the superuser runner AFTER 087 (run.sh); PFIN-C is held and not part of this suite.
\set ON_ERROR_STOP on
\set ADMIN '''a0000000-0000-4000-8000-000000000001'''
\set F1    '''f0000000-0000-4000-8000-000000000002'''

SELECT test.check('f06 087 is installed and holding',
  to_regnamespace('recovery') IS NOT NULL AND (SELECT state FROM recovery.continuity) <> 'open');
SELECT test.check('f06 guarded tables include sales, sale_items, shifts, refund_void_requests, audit_logs, supplier_payments',
  (SELECT count(*) FROM recovery_guard.snapshot WHERE relname IN
     ('sales', 'sale_items', 'shifts', 'refund_void_requests', 'audit_logs', 'supplier_payments')) = 6);
SELECT test.check('f06 after the PFIN re-apply every guarded fingerprint equals its snapshot (re-registered, no drift)',
  NOT EXISTS (SELECT 1 FROM recovery_guard.snapshot g WHERE g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid)));
SELECT test.check('f06 the snapshot includes the PFIN-A indexes',
  (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname = 'sales') LIKE '%sales_shop_created_idx%'
  AND (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname = 'refund_void_requests') LIKE '%refund_void_requests_sale_idx%'
  AND (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname = 'sales') LIKE '%sales_shift_idx%'
  AND (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname = 'audit_logs') LIKE '%audit_logs_fin_approval_time_idx%'
  AND (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname = 'audit_logs') LIKE '%audit_logs_fin_approval_entity_idx%');
SELECT test.check('f06 S1 under 087: the server close time is still read from the ledger (closeTimeSource SERVER_LEDGER)',
  test.f_recon('f0000000-0000-4000-8000-000000000001', test.var('S1'))->'shift'->>'closeTimeSource' = 'SERVER_LEDGER');
SELECT test.check('f06 no PFIN function uses a name 087 protects (%_v87, recovery_%)',
  NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'fin\_%'
               AND (proname LIKE '%\_v87' OR proname LIKE 'recovery\_%')));

SELECT test.check('f06 every PFIN-B function is owned by postgres (never by the superuser runner that applied it)',
  (SELECT bool_and(proowner = 'postgres'::regrole) AND count(*) = 7 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_report_scope', 'fin_items', 'fin_sale_line_net',
      'fin_approval_times', 'fin_refund_lines', 'fin_report_summary', 'fin_shift_reconciliation')));
-- regprocedure text depends on search_path: compare as recovery_guard.ddl_guard does
SET search_path = pg_catalog, pg_temp;
SELECT test.check('f06 the 087 function registry is unchanged by the PFIN re-apply (no drift blessed)',
  NOT EXISTS (SELECT 1 FROM recovery_guard.functions f WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f.fnid AND p.oid::regprocedure::text = f.fn))
  AND (SELECT count(*) FROM recovery_guard.functions) > 0);
RESET search_path;

-- reads work during the hold and are unchanged
SELECT test.f_report(:ADMIN, 'shop-f', (now() AT TIME ZONE 'Asia/Yangon')::date, (now() AT TIME ZONE 'Asia/Yangon')::date, 'SALE_DATE') AS rh \gset
SELECT test.check('f06 fin_report_summary works during a recovery hold and matches the pre-087 figures',
  (:'rh'::jsonb->'totals') = test.var('f05_totals')::jsonb, (:'rh'::jsonb->'totals')::text);
SELECT test.f_recon(:ADMIN, test.var('S2')) AS xh \gset
SELECT test.check('f06 fin_shift_reconciliation works during a recovery hold',
  (:'xh'::jsonb->>'evidenceExpectedCashMmk')::int = 22000);

-- writes stay held (the hold is 087's, reports do not weaken it)
SELECT test.login(:F1) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f06 a direct sale during the hold is refused by 087',
  format($q$SELECT public.complete_sale('shop-f', %L, 'CASH', 1000, 0, '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, gen_random_uuid())$q$, test.var('S3')),
  'ORG_SUSPENDED');
RESET ROLE;
SELECT test.logout() AS zz \gset
