-- Correction pass P5: installation acknowledgement and ledger retention reporting.
\set ON_ERROR_STOP on
SELECT test.check('install recorded its explicit acknowledgement', (SELECT install_ack='restrict-every-organization' FROM recovery_v1.install));
SELECT test.check('install is audited with the number of organizations it restricted and no reopen path',
  EXISTS(SELECT 1 FROM recovery_v1.audit WHERE kind='installed' AND (detail->>'organizations_restricted')::int>=2 AND detail->>'reopen_path' LIKE 'none:%'));
SELECT count(*) AS ledger_before FROM public.idempotency_keys \gset
SET ROLE orvix_recovery_operator;
SELECT recovery_v1.ledger_retention_report() AS report \gset
RESET ROLE;
SELECT test.check('retention report is read-only and covers every organization',
  (:'report'::jsonb->>'deletes_performed')::int=0 AND jsonb_array_length(:'report'::jsonb->'organizations')=(SELECT count(*) FROM recovery_v1.org_state)
  AND (SELECT count(*) FROM public.idempotency_keys)=:ledger_before);
SELECT test.check('retention report counts the aged fence the original prune could not expire',
  (SELECT (o->>'ledger_rows_retained_beyond_30d_prune')::int>=1 AND (o->>'fenced_keys')::int>=2 FROM jsonb_array_elements(:'report'::jsonb->'organizations') o WHERE o->>'org_id'='org-test'));
SET ROLE authenticated;
SELECT test.expect_error('client roles cannot read the retention report', $$SELECT recovery_v1.ledger_retention_report()$$, 'permission denied');
RESET ROLE;
SET ROLE service_role;
SELECT test.expect_error('service_role cannot read the retention report', $$SELECT recovery_v1.ledger_retention_report()$$, 'permission denied');
RESET ROLE;
