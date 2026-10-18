-- Migration 086 ROLLBACK (the documented rollback; docs/selfhost-migration/phase-g/migration-086.md "Rollback").
-- GENERATED together with 086 (gen086.py). Owner-approved rollbacks only, and ONLY through the runner:
--   deploy/lucashome/apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty [--dry-run]
-- ONE statement (a single DO block), so it is atomic in any client mode — with or without
-- ON_ERROR_STOP, inside or outside a transaction. It runs only inside the runner's transaction: the
-- runner guard (one runner at a time, ledger locked and re-checked, bounded lock and statement
-- timeouts) sets, for THAT transaction only, the owner's till-queue confirmation
-- (orvix.rollback_gate; the server cannot prove that every till's queue is empty) and the
-- transaction's id (orvix.runner_txid). Run any other way — plain psql, a gate set by hand for a
-- session — the preflight refuses and nothing changes.
-- Drops the executor, the status lookup and every op_* helper, and restores idem_begin WITHOUT the
-- UUIDv7 guard (the 085 behaviour on the per-organisation ledger: (org_id, key) lookups and locks;
-- the 085 key-only body is NOT restored — it would read another organisation's row once a key is used
-- in two organisations). KEEPS the per-organisation identity, idem_finish (per organisation), the
-- corrected pay_supplier_lump_sum, the idempotency_keys columns, constraint and index, every
-- rejected/abandoned tombstone (their R:/A: hashes keep them refused on the legacy path), the 086
-- prune_idempotency_keys (inert without the executor) and the search_path hardening. The operation
-- ledger is write-locked (bounded by lock_timeout) and must be unchanged afterwards (row count and
-- per-row hashes). The 086 ledger row is removed LAST, after every post-check; any failure rolls
-- back everything. Never restore 062's prune body. Re-apply 086 (apply-migrations.sh --from 086
-- --to 086) to recover forward.
DO $rollback$
DECLARE
  f regprocedure;
  v_n integer;
  v_before text;
  v_after text;
BEGIN
  -- preflight
  IF current_setting('orvix.rollback_gate', true) IS DISTINCT FROM 'till-queues-empty-confirmed-by-owner' THEN
    RAISE EXCEPTION 'rollback preflight: no owner confirmation that every till queue is empty (run only via apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty); nothing changed';
  END IF;
  IF current_setting('orvix.runner_txid', true) IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION 'rollback preflight: not inside the runner''s transaction (run only via apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty); nothing changed';
  END IF;
  IF current_setting('lock_timeout') IN ('0', '0ms', '0s') THEN
    RAISE EXCEPTION 'rollback preflight: lock_timeout is unbounded; nothing changed';
  END IF;
  IF to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'rollback preflight: 086 is not applied here (no op_execute); nothing changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '086') THEN
    RAISE EXCEPTION 'rollback preflight: 086 is not recorded in supabase_migrations; nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version > '086') THEN
    RAISE EXCEPTION 'rollback preflight: a newer migration is recorded; roll it back first; nothing changed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure) <> 'c9f577ed5608de19b25c00c649deaf50' THEN
    RAISE EXCEPTION 'rollback preflight: idem_begin is not the 086 body (unknown state; owner review); nothing changed';
  END IF;
  -- operation history: write-locked, and proven unchanged below (per-row hashes: no size limit)
  LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) || ':' || coalesce(sum(hashtextextended(k::text, 0)::numeric), 0) || ':' || coalesce(sum(hashtextextended(k::text, 1)::numeric), 0)
    INTO v_before FROM public.idempotency_keys k;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'op\_%' LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
  EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.idem_begin(p_key uuid, p_rpc text, p_request_hash text)
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

  -- 074: the caller, resolved exactly as 062 resolved actor_id.
  SELECT u.id, u.org_id INTO v_caller_id, v_caller_org
    FROM public.users u WHERE u.auth_id = auth.uid() LIMIT 1;
  -- 086: the ledger is per organisation (org_id, key); a caller with no
  -- organisation (bootstrap) uses the reserved unattributed namespace.
  v_caller_org := coalesce(v_caller_org, '!unattributed');

  -- Concurrent duplicates serialise here until the first transaction ends.
  PERFORM pg_advisory_xact_lock(hashtext('idem:' || v_caller_org || ':' || p_key::text));

  -- 086: a key whose organisation was never recorded (pre-074) stays
  -- refused in every organisation, as 074 refused it.
  IF v_caller_org <> '!unattributed'
     AND EXISTS (SELECT 1 FROM public.idempotency_keys WHERE org_id = '!unattributed' AND key = p_key) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH: key % was used for a different request', p_key
      USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v FROM public.idempotency_keys WHERE org_id = v_caller_org AND key = p_key;
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
$function$$ddl$;
  -- post-checks
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure) <> '1fc0d1d2ae39fc56c86d9b20a417ea7f' THEN
    RAISE EXCEPTION 'rollback post-check: idem_begin is not the per-organisation body without the UUIDv7 guard';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.idem_finish(uuid,jsonb)'::regprocedure) <> 'dd11818faf8853eadab1d3332fd5d7e6'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pay_supplier_lump_sum(text,text,integer,text,text,text,uuid)'::regprocedure) <> 'cf4142b64ef02ff5414c64bf8eb827b3' THEN
    RAISE EXCEPTION 'rollback post-check: idem_finish / pay_supplier_lump_sum must stay the corrected 086 bodies';
  END IF;
  IF (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'public.idempotency_keys'::regclass AND c.contype = 'p') IS DISTINCT FROM 'org_id,key' THEN
    RAISE EXCEPTION 'rollback post-check: the per-organisation ledger identity must be kept';
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
  SELECT count(*) || ':' || coalesce(sum(hashtextextended(k::text, 0)::numeric), 0) || ':' || coalesce(sum(hashtextextended(k::text, 1)::numeric), 0)
    INTO v_after FROM public.idempotency_keys k;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'rollback post-check: the operation ledger (idempotency_keys) changed; nothing rolled back';
  END IF;
  -- last: the ledger row, so a re-apply of 086 is the forward recovery
  DELETE FROM supabase_migrations.schema_migrations WHERE version = '086';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'rollback post-check: expected to remove exactly one 086 ledger row, removed %', v_n;
  END IF;
  PERFORM pg_notify('pgrst', 'reload schema');
END $rollback$;
