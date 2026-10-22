-- ============================================================
-- PROVISIONAL migration PNET-A: outgoing-HTTP (pg_net) lockdown (no number assigned)
--
-- OWNER DECISION (Step 6 finalization, 2026-10-22): remove PUBLIC and application-role write and execute access to the
-- database's outgoing-HTTP facility. Only explicitly authorized service roles may queue HTTP requests.
--
-- FOUND (supabase/postgres 17.6.1.136, pg_net 0.20.3, the disposable stack; production is expected to match but was not
--   inspected — lucashome is production and is out of scope):
--   schema net: USAGE for PUBLIC, anon, authenticated, service_role, postgres, supabase_functions_admin
--     (extensions.grant_pg_net_access, Supabase's CREATE EXTENSION event trigger issue_pg_net_access, grants it again
--     whenever the extension is created);
--   net.http_request_queue, net._http_response, net.http_request_queue_id_seq: ALL privileges for PUBLIC;
--   every net.* function: no ACL (= EXECUTE for PUBLIC), all SECURITY INVOKER: so any login could queue arbitrary
--   outgoing HTTP from the database host (SSRF), read or delete other components' responses, or restart the worker.
--   No Orvix migration, trigger or SECURITY DEFINER function calls net.*; hosted cron jobs ran as postgres; Supabase
--   database webhooks run as supabase_functions_admin (supabase_functions.http_request, when that schema exists).
-- RESULT (an exact privilege matrix, re-applied idempotently):
--   PUBLIC, anon, authenticated, service_role and every other role: nothing in schema net.
--   Authorized service roles (orvix_netguard.authorized_roles(): postgres, supabase_functions_admin when present):
--   schema USAGE; SELECT+INSERT on net.http_request_queue; USAGE on its sequence; SELECT on net._http_response; EXECUTE on
--   http_get, http_post, http_delete, http_collect_response, _http_collect_response, _await_response, _urlencode_string,
--   _encode_url_with_params_array, wake. No grant options. The worker controls (worker_restart, wait_until_running,
--   check_worker_is_up) stay with the extension owner.
--   supabase_functions.http_request (a SECURITY DEFINER webhook wrapper owned by supabase_functions_admin, which Supabase
--   grants to anon/authenticated/service_role): EXECUTE revoked from PUBLIC, anon, authenticated, service_role.
-- HELPERS LIVE IN A PRIVATE SCHEMA (review 3, C1): orvix_netguard is owned by the superuser runner and nobody else has
--   USAGE or CREATE on it, so no other role (not even postgres, which owns schema public on Supabase and could otherwise
--   drop and replace a helper the superuser event trigger calls) can change or call them.
-- RE-GRANT PROTECTION: Supabase's own hook re-grants on CREATE EXTENSION, and an extension update may recreate objects
--   with PUBLIC defaults. The superuser-owned event trigger zz_orvix_net_lockdown (ddl_command_end, every CREATE/ALTER
--   EXTENSION; it fires after issue_pg_net_access by name order) re-applies the matrix in the same transaction.
--   orvix_netguard.exposure_problems() (superuser-only) lists anything outside the matrix: grants, grant options,
--   default privileges in schema net, members of the authorized roles, the webhook wrapper, and the helpers' own
--   integrity. ESCAPE (documented): an error inside the lockdown makes every CREATE/ALTER EXTENSION fail; a superuser can
--   bypass it for one session with SET event_triggers = off, then re-run orvix_netguard.lockdown_apply().
-- Additive: no Orvix object changes; no historical migration touched. Refuses after Recovery V1 (an authorized migration
--   may not add event triggers); an installation that already has V1 applies PNET-A_post_v1_revoke.sql (GRANT/REVOKE
--   only) through recovery_v1.apply_authorized_migration. ROLLBACK: PNET-A.rollback.sql.
-- ============================================================

SET lock_timeout = '3s';

DO $pnet_a_pre$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'PNET-A: run as the superuser migration runner (it changes privileges on an extension schema)';
  END IF;
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN
    RAISE EXCEPTION 'PNET-A: Recovery V1 is installed; apply PNET-A_post_v1_revoke.sql through recovery_v1.apply_authorized_migration instead';
  END IF;
  IF to_regnamespace('orvix_netguard') IS NOT NULL
     AND NOT (SELECT rolsuper FROM pg_roles WHERE oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'orvix_netguard')) THEN
    RAISE EXCEPTION 'PNET-A: a schema orvix_netguard exists that a non-superuser owns; refusing';
  END IF;
END $pnet_a_pre$;

-- an earlier draft of this migration kept its helpers in schema public (review 3, C1): remove them
DROP EVENT TRIGGER IF EXISTS zz_orvix_net_lockdown;
DROP FUNCTION IF EXISTS public.net_lockdown_event();
DROP FUNCTION IF EXISTS public.net_exposure_problems();
DROP FUNCTION IF EXISTS public.net_lockdown_apply();
DROP FUNCTION IF EXISTS public.net_authorized_roles();

CREATE SCHEMA IF NOT EXISTS orvix_netguard AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA orvix_netguard FROM PUBLIC;
DO $pnet_a_schema$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'postgres', 'supabase_functions_admin') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA orvix_netguard FROM %I', r);
  END LOOP;
END $pnet_a_schema$;

-- the roles allowed to queue outgoing HTTP (service roles only; never a role a tenant user or the anon key can assume)
CREATE OR REPLACE FUNCTION orvix_netguard.authorized_roles()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT ARRAY['postgres', 'supabase_functions_admin'] $$;

-- the exact privileges an authorized role holds: (object kind, object name, privilege)
CREATE OR REPLACE FUNCTION orvix_netguard.allowed()
RETURNS TABLE (kind text, obj text, priv text) LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM (VALUES ('schema', 'net', 'USAGE'),
    ('table', 'http_request_queue', 'SELECT'), ('table', 'http_request_queue', 'INSERT'),
    ('table', 'http_request_queue_id_seq', 'USAGE'), ('table', '_http_response', 'SELECT'),
    ('function', 'http_get', 'EXECUTE'), ('function', 'http_post', 'EXECUTE'), ('function', 'http_delete', 'EXECUTE'),
    ('function', 'http_collect_response', 'EXECUTE'), ('function', '_http_collect_response', 'EXECUTE'),
    ('function', '_await_response', 'EXECUTE'), ('function', '_urlencode_string', 'EXECUTE'),
    ('function', '_encode_url_with_params_array', 'EXECUTE'), ('function', 'wake', 'EXECUTE')) v(kind, obj, priv) $$;

-- apply the matrix (idempotent; does nothing when pg_net / the webhook wrapper are not installed)
CREATE OR REPLACE FUNCTION orvix_netguard.lockdown_apply()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r text; f record; v_owner name; v_ok text[];
BEGIN
  IF to_regprocedure('supabase_functions.http_request()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION supabase_functions.http_request() FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION supabase_functions.http_request() FROM %I', r);
    END LOOP;
  END IF;
  IF to_regnamespace('net') IS NULL THEN RETURN; END IF;
  SELECT nspowner::regrole::name INTO v_owner FROM pg_namespace WHERE nspname = 'net';
  -- every grantee other than the owner loses everything (PUBLIC, anon, authenticated, service_role, any login granted
  -- directly, and the authorized roles too: their exact rights are granted again below, without grant options)
  FOR r IN
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END   -- regrole text is already quoted
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
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA net FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM %I', r);
  END LOOP;
  v_ok := ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname = ANY (orvix_netguard.authorized_roles()) AND rolname <> v_owner);
  FOREACH r IN ARRAY v_ok LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA net TO %I', r);
    IF to_regclass('net.http_request_queue') IS NOT NULL THEN EXECUTE format('GRANT SELECT, INSERT ON net.http_request_queue TO %I', r); END IF;
    IF to_regclass('net.http_request_queue_id_seq') IS NOT NULL THEN EXECUTE format('GRANT USAGE ON SEQUENCE net.http_request_queue_id_seq TO %I', r); END IF;
    IF to_regclass('net._http_response') IS NOT NULL THEN EXECUTE format('GRANT SELECT ON net._http_response TO %I', r); END IF;
    FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'net'::regnamespace
               AND p.proname IN (SELECT obj FROM orvix_netguard.allowed() WHERE kind = 'function') LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f.sig, r);
    END LOOP;
  END LOOP;
END $$;

-- everything outside the matrix (empty = locked down). Superuser only.
CREATE OR REPLACE FUNCTION orvix_netguard.exposure_problems()
RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH own AS (SELECT nspowner FROM pg_namespace WHERE nspname = 'net'),
  acl AS (
    SELECT 'schema' AS kind, 'net' AS obj, 'schema net' AS label, (aclexplode(nspacl)).* FROM pg_namespace WHERE nspname = 'net'
    UNION ALL SELECT 'table', relname::text, 'net.' || relname, (aclexplode(relacl)).* FROM pg_class
     WHERE relnamespace = to_regnamespace('net') AND relacl IS NOT NULL
    UNION ALL SELECT 'function', proname::text, oid::regprocedure::text, (aclexplode(proacl)).* FROM pg_proc
     WHERE pronamespace = to_regnamespace('net') AND proacl IS NOT NULL)
  -- a grant outside the matrix, or any grant option
  SELECT label || ': ' || CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE grantee::regrole::text END || ' ' || privilege_type
         || CASE WHEN is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    FROM acl, own
   WHERE grantee <> own.nspowner
     AND (grantee = 0 OR is_grantable OR NOT grantee::regrole::text = ANY (orvix_netguard.authorized_roles())
          OR NOT EXISTS (SELECT 1 FROM orvix_netguard.allowed() m WHERE m.kind = acl.kind AND m.obj = acl.obj AND m.priv = acl.privilege_type))
  UNION ALL
  -- a function without an ACL is executable by PUBLIC (a table or sequence without one is owner-only)
  SELECT oid::regprocedure::text || ': PUBLIC EXECUTE (no ACL)' FROM pg_proc WHERE pronamespace = to_regnamespace('net') AND proacl IS NULL
  UNION ALL
  -- default privileges that would give NEW objects in schema net to someone
  SELECT 'default privileges in schema net for ' || defaclrole::regrole::text || ' (' || defaclobjtype::text || '): ' || defaclacl::text
    FROM pg_default_acl WHERE defaclnamespace = to_regnamespace('net')
  UNION ALL
  -- a role that inherits from, or may SET ROLE to, an authorized role gets its outgoing HTTP (superusers excepted)
  SELECT 'member of ' || g.rolname || ': ' || m.rolname
    FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
   WHERE g.rolname = ANY (orvix_netguard.authorized_roles()) AND NOT m.rolsuper AND to_regnamespace('net') IS NOT NULL
  UNION ALL
  -- Supabase's webhook wrapper queues requests as supabase_functions_admin
  SELECT 'supabase_functions.http_request(): ' || r.rolname || ' EXECUTE'
    FROM pg_roles r WHERE to_regprocedure('supabase_functions.http_request()') IS NOT NULL
     AND r.rolname IN ('anon', 'authenticated', 'service_role') AND has_function_privilege(r.oid, 'supabase_functions.http_request()', 'EXECUTE')
  UNION ALL
  -- the helpers themselves: a private schema the superuser owns, superuser-owned functions, no access for others
  SELECT 'orvix_netguard: ' || x FROM (
    SELECT 'schema not owned by a superuser' AS x WHERE NOT (SELECT rolsuper FROM pg_roles WHERE oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'orvix_netguard'))
    UNION ALL SELECT 'schema accessible to ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM (SELECT (aclexplode(nspacl)).* FROM pg_namespace WHERE nspname = 'orvix_netguard') a
     WHERE a.grantee <> (SELECT nspowner FROM pg_namespace WHERE nspname = 'orvix_netguard')
    UNION ALL SELECT 'function ' || p.oid::regprocedure::text || ' not superuser-owned' FROM pg_proc p
     WHERE p.pronamespace = to_regnamespace('orvix_netguard') AND NOT (SELECT rolsuper FROM pg_roles WHERE oid = p.proowner)
    UNION ALL SELECT 'event trigger zz_orvix_net_lockdown missing, disabled or not calling orvix_netguard.lockdown_event()'
     WHERE NOT EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtname = 'zz_orvix_net_lockdown' AND e.evtenabled <> 'D'
                         AND e.evtfoid = to_regprocedure('orvix_netguard.lockdown_event()')
                         AND (SELECT rolsuper FROM pg_roles WHERE oid = e.evtowner))) h
  ORDER BY 1 $$;

-- on EVERY CREATE / ALTER EXTENSION (an update to the same version records no command; the lockdown is idempotent and cheap)
CREATE OR REPLACE FUNCTION orvix_netguard.lockdown_event()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM orvix_netguard.lockdown_apply();
END $$;

REVOKE ALL ON FUNCTION orvix_netguard.authorized_roles(), orvix_netguard.allowed(), orvix_netguard.lockdown_apply(),
  orvix_netguard.exposure_problems(), orvix_netguard.lockdown_event() FROM PUBLIC;
DO $pnet_a_fn$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'postgres', 'supabase_functions_admin') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION orvix_netguard.authorized_roles(), orvix_netguard.allowed(), orvix_netguard.lockdown_apply(), '
                   'orvix_netguard.exposure_problems(), orvix_netguard.lockdown_event() FROM %I', r);
  END LOOP;
END $pnet_a_fn$;

CREATE EVENT TRIGGER zz_orvix_net_lockdown ON ddl_command_end WHEN TAG IN ('CREATE EXTENSION', 'ALTER EXTENSION')
  EXECUTE FUNCTION orvix_netguard.lockdown_event();

SELECT orvix_netguard.lockdown_apply();

DO $pnet_a_post$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(x, '; ') INTO v_bad FROM orvix_netguard.exposure_problems() x;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'PNET-A: privileges outside the rule remain: %', v_bad; END IF;
END $pnet_a_post$;
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
