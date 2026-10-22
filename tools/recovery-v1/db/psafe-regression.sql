-- Disposable contract regression for the EXISTING PSAFE privilege checker.
-- This is a minimal 087-shaped fixture, not a full 087 integration test.
-- It rolls back its role/schema/functions/grants before recovery-v1 installs.
\set ON_ERROR_STOP on
BEGIN;
REVOKE EXECUTE ON FUNCTION public.prune_idempotency_keys() FROM service_role;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.idempotency_keys FROM service_role,anon,authenticated;
CREATE ROLE recovery_owner NOLOGIN NOSUPERUSER;
CREATE SCHEMA recovery;
CREATE FUNCTION public.op_execute_v87(uuid,text,jsonb,text,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
CREATE FUNCTION public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
-- Grant both together before changing ownership: one transaction is enough,
-- and the checker should reject the owner drift at this intermediate point.
DO $$
BEGIN
 BEGIN
  GRANT EXECUTE ON FUNCTION public.op_execute_v87(uuid,text,jsonb,text,jsonb), public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb) TO authenticated;
  RAISE EXCEPTION 'PSAFE regression: untrusted owner change was accepted';
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM NOT LIKE 'ORVIX_NO_086_AFTER_087:%' THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;
SELECT test.check('PSAFE absent087 installation succeeds and present087-shaped ownership drift denied',EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='zz_orvix_no_086_after_087' AND evtenabled='A') AND to_regnamespace('recovery') IS NULL);
