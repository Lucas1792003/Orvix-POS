-- ============================================================
-- Migration 067: app_setup_needed() — read-only "is first-time setup still
--                needed?" probe for the explicit /setup page (Phase G)
--
-- Why (docs/selfhost-migration/phase-g/login-signup-fix.md): the login flow
-- used to call auth.signUp() after ANY failed password sign-in, because it
-- could not tell "first-ever user" from "wrong password" anonymously —
-- `users` is readable `TO authenticated` only (010/056), so an anonymous
-- SELECT always came back empty. That implicit sign-up created an orphan
-- auth user on the HOSTED project during Phase E (evidence/G9). The client
-- now never signs up from the login page; the first-admin bootstrap is a
-- separate, explicit page that is reachable only when THIS function says
-- the install has no app users yet.
--
-- What it exposes: one boolean — whether public.users is empty. Nothing
-- about who the users are. SECURITY DEFINER so it can count under RLS
-- without a session; STABLE, no side effects, no parameters.
--
-- Grants: migration 064 revoked EXECUTE from anon/PUBLIC on every function
-- and fixed the default ACL, so a brand-new function is anon-free unless
-- granted here. anon needs it (the login/setup pages run before any
-- session exists), so after this migration anon can execute exactly THREE
-- public functions: the two token-scoped phone-upload RPCs from 019/064
-- and this one. authenticated/service_role get it too (an already
-- signed-in orphan account may land on /setup).
--
-- NOT applied anywhere by this change — apply with deploy/lucashome/
-- apply-migrations.sh (self-hosted) as part of the Phase G rollout. The
-- client treats an RPC error (function missing) as "setup NOT needed"
-- (fail closed), so deploying the client before the migration only means
-- the /setup page stays unavailable — it never means an accidental sign-up.
--
-- Rollback: DROP FUNCTION public.app_setup_needed(); the /setup page then
-- reports "could not confirm" and refuses to act. Forward recovery:
-- idempotent (CREATE OR REPLACE), re-run.
--
-- Verification:
--   SELECT app_setup_needed();                                   -- false on a populated install
--   SELECT has_function_privilege('anon', 'public.app_setup_needed()', 'EXECUTE');  -- t
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE');
--   -- expect exactly: app_setup_needed, complete_product_image_upload_session,
--   --                 get_product_image_upload_session_by_token
--   curl -s "$URL/rest/v1/rpc/app_setup_needed" -X POST -H "apikey: $ANON" -H "Content-Type: application/json" -d '{}'
--   -- expect: false
-- ============================================================

CREATE OR REPLACE FUNCTION public.app_setup_needed()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.users);
$$;

COMMENT ON FUNCTION public.app_setup_needed() IS
  'True while public.users is empty (first-time setup still needed). Read-only probe for the explicit /setup page; see migration 067.';

REVOKE ALL ON FUNCTION public.app_setup_needed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_setup_needed() TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
