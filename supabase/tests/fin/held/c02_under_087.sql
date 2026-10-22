-- c02 (HELD, FIN_WITH_HELD=1): PFIN-C after 087 was installed and PFIN-C re-applied by the superuser runner.
\set ON_ERROR_STOP on
SELECT test.check('c02 the 087 snapshot of refund_void_requests includes the PFIN-C triggers',
  (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname = 'refund_void_requests') LIKE '%fin_guard_refund_net_paid_ins%'
  AND (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname = 'refund_void_requests') LIKE '%fin_guard_refund_net_paid_upd%');
SELECT test.check('c02 every guarded fingerprint equals its snapshot after the PFIN-C re-apply',
  NOT EXISTS (SELECT 1 FROM recovery_guard.snapshot g WHERE g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid)));
SELECT test.check('c02 the trigger function is owned by postgres, not by the superuser runner',
  (SELECT proowner = 'postgres'::regrole FROM pg_proc WHERE proname = 'fin_guard_refund_net_paid'));
