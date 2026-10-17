-- Migration 086 ROLLBACK (the documented rollback; docs/selfhost-migration/phase-g/migration-086.md "Rollback").
-- GENERATED together with 086 (gen086.py). Owner-approved rollbacks only; never applied by
-- deploy/lucashome/apply-migrations.sh (this directory is not supabase/migrations).
--   psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -f 086_operation_outcomes.rollback.sql
-- Drops the executor, the status lookup and every op_* helper, and restores the 085 idem_begin body
-- (search_path stays hardened). KEEPS the idempotency_keys columns, constraint and index, every
-- rejected/abandoned tombstone (their R:/A: hashes keep them refused on the legacy path), the 086
-- prune_idempotency_keys (inert without the executor) and the search_path hardening.
-- Never restore 062's prune body. Re-apply 086 to recover forward.
BEGIN;
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'op\_%' LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.idem_begin(p_key uuid, p_rpc text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v record;
  v_caller_id  text;  -- 074
  v_caller_org text;  -- 074
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Concurrent duplicates serialise here until the first transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('idem:' || p_key::text));

  -- 074: the caller, resolved exactly as 062 resolved actor_id.
  SELECT u.id, u.org_id INTO v_caller_id, v_caller_org
    FROM public.users u WHERE u.auth_id = auth.uid() LIMIT 1;

  SELECT * INTO v FROM public.idempotency_keys WHERE key = p_key;
  IF FOUND THEN
    IF v.rpc <> p_rpc OR v.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key % was used for a different request', p_key
        USING ERRCODE = '23505';
    END IF;
    -- 074: a stored response is replayed only inside the organization that
    -- produced it. Same text as above on purpose (no cross-org oracle).
    IF v.org_id IS DISTINCT FROM v_caller_org THEN
      RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key % was used for a different request', p_key
        USING ERRCODE = '23505';
    END IF;
    RETURN COALESCE(v.response, '{}'::jsonb);   -- replay
  END IF;

  INSERT INTO public.idempotency_keys (key, rpc, actor_id, org_id, request_hash)
  VALUES (p_key, p_rpc, v_caller_id, v_caller_org, p_request_hash);
  RETURN NULL;  -- execute
END;
$function$;
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure) <> 'afca065fea226a0c7a5b9bb56b540a9d' THEN
    RAISE EXCEPTION 'rollback post-check: idem_begin is not the 085 body';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'op\_%') THEN
    RAISE EXCEPTION 'rollback post-check: op_* functions remain';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proconfig = '{search_path=public}') THEN
    RAISE EXCEPTION 'rollback post-check: search_path hardening lost';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.prune_idempotency_keys()'::regprocedure) NOT LIKE '%nothing pruned%' THEN
    RAISE EXCEPTION 'rollback post-check: prune_idempotency_keys is not the inert 086 body (never restore 062''s)';
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
