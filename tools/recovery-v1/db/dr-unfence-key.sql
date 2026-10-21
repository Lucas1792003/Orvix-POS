-- LOCAL authorization-interface probe only. NO fence is removed by v1.
-- The independent owner verifier/enrollment is unprovisioned; an operator's
-- names, JSON, service key, reconstruction or restored backup cannot approve.
-- Same psql target/org/shop/key/incident/evidence variables as dr-fence-keys;
-- additional independent_authorization contains opaque JSON for audit presence.
\set ON_ERROR_STOP on
SELECT recovery_v1.request_unfence(:'expected_database', :'expected_system_identifier', :'org_id', :'shop_id',
 :'operation_key'::uuid, :'incident_id', :'preserved_evidence_sha256', :'independent_authorization'::jsonb);
