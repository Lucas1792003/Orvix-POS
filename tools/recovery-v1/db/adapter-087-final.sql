-- 087 adapter, last part (after cross-org-smoke.sql and the financial smokes): an 087 organization
-- hold wins over a V1 ACTIVE state, and the read-only retention report still works. Synthetic only.
\set ON_ERROR_STOP on
SELECT test.logout();
SELECT test.check('z01 precondition: org-test V1 ACTIVE and 087 open', (SELECT state='ACTIVE' FROM recovery_v1.org_state WHERE org_id='org-test')
  AND (SELECT state='open' FROM recovery.continuity) AND recovery.lease_ok());
SELECT recovery.owner_hold_org('org-test','synthetic 087 hold over a V1 ACTIVE organization');
SELECT test.expect_error('z02 087 org hold + V1 ACTIVE: write refused by 087', $$UPDATE public.shops SET address='after hold' WHERE id='shop-a'$$, 'RECOVERY_HOLD');
SELECT test.login('a0000000-0000-4000-8000-000000000001');
SET ROLE authenticated;
SELECT test.check('z03 087 org hold + V1 ACTIVE: status RESTRICTED (087 hold reported)',
  public.recovery_v1_status('org-test')->>'state'='RESTRICTED' AND public.recovery_v1_status('org-test')->>'uncertainties' LIKE '%087 recovery hold%');
RESET ROLE;
SELECT test.logout();
SET ROLE orvix_recovery_operator;
SELECT recovery_v1.ledger_retention_report() AS report \gset
RESET ROLE;
SELECT test.check('z04 retention report read-only and covers every organization',
  (:'report'::jsonb->>'deletes_performed')::int=0 AND jsonb_array_length(:'report'::jsonb->'organizations')=(SELECT count(*) FROM recovery_v1.org_state));
SELECT test.check('z05 no V1 fence was ever written under 087', NOT EXISTS(SELECT 1 FROM recovery_v1.fences));
SELECT test.check('z06 integrity intact at the end', recovery_v1.integrity_problem() IS NULL AND recovery_v1.m087_fingerprint()=(SELECT fingerprint FROM recovery_v1.adapter_087));
