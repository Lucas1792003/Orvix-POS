-- PNET-A, REVOKE PART ONLY, for an installation where Recovery V1 is ALREADY installed (review 3, M3).
-- Apply only through recovery_v1.apply_authorized_migration with an owner-signed authorization naming this file's exact
-- sha256, the chain predecessor and allowedCommands ["REVOKE", "GRANT"] (no new tables). It creates no function, schema
-- or event trigger (an authorized migration cannot add an event trigger), so after a later CREATE/ALTER EXTENSION pg_net
-- Supabase's hook may re-grant schema USAGE: re-run this through the same owner-authorized path after any extension change,
-- and audit with the same rules (an empty result of the matrix check in tools/recovery-v1/step6f/pnet_check.sh).
-- Same matrix as PNET-A: nothing for PUBLIC / anon / authenticated / service_role / any other role in schema net;
-- postgres and supabase_functions_admin (when present): schema USAGE, SELECT+INSERT on the queue, its sequence, SELECT on
-- responses, EXECUTE on the request / collect functions; supabase_functions.http_request not executable by API roles.
DO $pnet_a_post_v1$
DECLARE r text; f record; v_owner name;
BEGIN
  IF to_regprocedure('supabase_functions.http_request()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION supabase_functions.http_request() FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION supabase_functions.http_request() FROM %I', r);
    END LOOP;
  END IF;
  IF to_regnamespace('net') IS NULL THEN RETURN; END IF;
  SELECT nspowner::regrole::name INTO v_owner FROM pg_namespace WHERE nspname = 'net';
  FOR r IN
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM (SELECT (aclexplode(nspacl)).grantee FROM pg_namespace WHERE nspname = 'net'
            UNION ALL SELECT (aclexplode(relacl)).grantee FROM pg_class WHERE relnamespace = 'net'::regnamespace AND relacl IS NOT NULL
            UNION ALL SELECT (aclexplode(proacl)).grantee FROM pg_proc WHERE pronamespace = 'net'::regnamespace AND proacl IS NOT NULL
            UNION ALL SELECT 0::oid) a
     WHERE a.grantee = 0 OR a.grantee::regrole::name <> v_owner
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA net FROM %s', r);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA net FROM %s', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA net FROM %s', r);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM %s', r);
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('postgres', 'supabase_functions_admin') AND rolname <> v_owner LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA net TO %I', r);
    IF to_regclass('net.http_request_queue') IS NOT NULL THEN EXECUTE format('GRANT SELECT, INSERT ON net.http_request_queue TO %I', r); END IF;
    IF to_regclass('net.http_request_queue_id_seq') IS NOT NULL THEN EXECUTE format('GRANT USAGE ON SEQUENCE net.http_request_queue_id_seq TO %I', r); END IF;
    IF to_regclass('net._http_response') IS NOT NULL THEN EXECUTE format('GRANT SELECT ON net._http_response TO %I', r); END IF;
    FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'net'::regnamespace
               AND p.proname IN ('http_get', 'http_post', 'http_delete', 'http_collect_response', '_http_collect_response', '_await_response',
                                 '_urlencode_string', '_encode_url_with_params_array', 'wake') LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, r);
    END LOOP;
  END LOOP;
END $pnet_a_post_v1$;
