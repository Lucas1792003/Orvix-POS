-- LOCAL disposable target only. psql -X --single-transaction -v ON_ERROR_STOP=1
-- Required psql variables: expected_database, expected_system_identifier, org_id,
-- shop_id, operation_key, rpc, actor_id, incident_id, preserved_evidence_sha256,
-- authorization_reference. Never derive the expected target from the same live
-- connection; compare it with a preserved, reviewed incident target record.
-- This tool only contains uncertain same-key execution. No row absence proves
-- non-execution; a different operation key is NOT fenced. Dependencies need
-- separate inventory/reconciliation, never automatic resend/rekey/reconstruction.
\set ON_ERROR_STOP on
SELECT recovery_v1.fence_key(:'expected_database', :'expected_system_identifier', :'org_id', :'shop_id',
 :'operation_key'::uuid, :'rpc', :'actor_id', :'incident_id', :'preserved_evidence_sha256', :'authorization_reference');
