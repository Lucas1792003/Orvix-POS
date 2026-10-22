-- ROLLBACK of PROVISIONAL PNET-A (pg_net lockdown): removes the event trigger and the private helper schema
-- orvix_netguard, and restores the privileges Supabase's grant_pg_net_access gives (schema USAGE to
-- supabase_functions_admin, postgres, anon, authenticated, service_role). It does NOT restore PUBLIC's table rights or
-- PUBLIC function EXECUTE, nor EXECUTE on supabase_functions.http_request for API roles: re-exposing arbitrary outgoing
-- HTTP to every login is never automated; an owner who needs it must grant it explicitly.
-- Superuser runner, before Recovery V1 only.
DO $pnet_a_rb$
BEGIN
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN RAISE EXCEPTION 'PNET-A rollback: Recovery V1 is installed'; END IF;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN RAISE EXCEPTION 'PNET-A rollback: run as the superuser'; END IF;
END $pnet_a_rb$;
DROP EVENT TRIGGER IF EXISTS zz_orvix_net_lockdown;
DROP SCHEMA IF EXISTS orvix_netguard CASCADE;
-- (an earlier draft kept the helpers in schema public)
DROP FUNCTION IF EXISTS public.net_lockdown_event();
DROP FUNCTION IF EXISTS public.net_exposure_problems();
DROP FUNCTION IF EXISTS public.net_lockdown_apply();
DROP FUNCTION IF EXISTS public.net_authorized_roles();
DO $pnet_a_rb_grants$
DECLARE r text;
BEGIN
  IF to_regnamespace('net') IS NULL THEN RETURN; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('supabase_functions_admin', 'postgres', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA net TO %I', r);
  END LOOP;
END $pnet_a_rb_grants$;
