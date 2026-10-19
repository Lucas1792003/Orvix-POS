-- Migration 087 ROLLBACK (docs/selfhost-migration/phase-g/migration-087.md "Rollback"). Owner-approved rollbacks only, and ONLY
-- through the runner:
--   deploy/lucashome/apply-migrations.sh --rollback 087 --owner-confirmed-till-queues-empty [--dry-run]
-- ONE statement (a single DO block): atomic in any client mode. Like 086's rollback it runs only inside the runner's transaction
-- (orvix.rollback_gate + orvix.runner_txid, bounded lock_timeout); any other way the preflight refuses and nothing changes.
-- Before running it, the runbook exports the evidence (pg_dump -n recovery) off the host and stops the witness authority.
-- What it does:
--   * drops the DDL event trigger, every zz_recovery_* trigger, the 8 public 087 API functions, every function in schema recovery
--     and schema recovery_guard (the DDL guard and its fingerprints: configuration, not evidence);
--   * KEEPS ALL EVIDENCE: schema recovery (journals, quarantine, decisions, events, epochs, chain, tills) and the public canary are
--     moved into schema recovery_archived_087_<UTC timestamp> (a later re-apply and a second rollback never collide);
--   * restores the pre-087 privileges EXACTLY from the install-time snapshot (ACLs of every public relation and of
--     prune_idempotency_keys) and removes recovery_owner's read grants; recovery_authority / recovery_gate become NOLOGIN;
--   * proves the operation ledger (idempotency_keys) unchanged, then removes the 087 ledger row LAST.
-- Forward recovery: re-apply 087 (apply-migrations.sh --from 087 --to 087); the archived schema is untouched by a re-apply.
DO $rollback$
DECLARE
  r record;
  v_arch text := 'recovery_archived_087_' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDD"t"HH24MISS');   -- lower case: usable unquoted
  v_n integer;
  v_before text;
  v_after text;
  v_ev_before text;
  v_ev_after text;
BEGIN
  -- preflight
  IF current_setting('orvix.rollback_gate', true) IS DISTINCT FROM 'till-queues-empty-confirmed-by-owner' THEN
    RAISE EXCEPTION 'rollback preflight: no owner confirmation that every till queue is empty (run only via apply-migrations.sh --rollback 087 --owner-confirmed-till-queues-empty); nothing changed';
  END IF;
  IF current_setting('orvix.runner_txid', true) IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION 'rollback preflight: not inside the runner''s transaction (run only via apply-migrations.sh --rollback 087 --owner-confirmed-till-queues-empty); nothing changed';
  END IF;
  IF current_setting('lock_timeout') IN ('0', '0ms', '0s') THEN
    RAISE EXCEPTION 'rollback preflight: lock_timeout is unbounded; nothing changed';
  END IF;
  IF to_regnamespace('recovery') IS NULL OR to_regclass('recovery.acl_snapshot') IS NULL THEN
    RAISE EXCEPTION 'rollback preflight: 087 is not applied here (no schema recovery); nothing changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '087') THEN
    RAISE EXCEPTION 'rollback preflight: 087 is not recorded in supabase_migrations; nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version > '087') THEN
    RAISE EXCEPTION 'rollback preflight: a newer migration is recorded; roll it back first; nothing changed';
  END IF;
  IF to_regnamespace(v_arch) IS NOT NULL THEN
    RAISE EXCEPTION 'rollback preflight: archive schema % already exists; nothing changed', v_arch;
  END IF;

  -- the operation ledger and the evidence: write-locked and proven unchanged below
  LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) || ':' || coalesce(sum(hashtextextended(k::text, 0)::numeric), 0) || ':' || coalesce(sum(hashtextextended(k::text, 1)::numeric), 0)
    INTO v_before FROM public.idempotency_keys k;
  SELECT (SELECT count(*) FROM recovery.journal) || ':' || (SELECT count(*) FROM recovery.events) || ':' || (SELECT count(*) FROM recovery.chain_log)
      || ':' || (SELECT count(*) FROM recovery.decisions) || ':' || (SELECT count(*) FROM recovery.quarantine) || ':' || (SELECT count(*) FROM recovery.tills)
    INTO v_ev_before;

  -- 1. enforcement off
  EXECUTE 'DROP EVENT TRIGGER IF EXISTS zz_recovery_ddl_guard';
  FOR r IN SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
            WHERE c.relnamespace = 'public'::regnamespace AND t.tgname LIKE 'zz\_recovery\_%' AND NOT t.tgisinternal LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', r.tgname, r.relname);
  END LOOP;
  -- 2. API and functions
  EXECUTE 'DROP FUNCTION public.op_execute_v87(uuid, text, jsonb, text, jsonb), public.op_status_v87(uuid, text, boolean, text, jsonb, jsonb),
    public.recovery_register_till(text), public.recovery_epoch(jsonb), public.recovery_submit_journal(jsonb, int, jsonb, boolean),
    public.recovery_approve_till(text), public.recovery_propose_decision(uuid, text, jsonb, text, int, text, text), public.recovery_withdraw_decision(bigint)';
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace = 'recovery'::regnamespace LOOP
    EXECUTE format('DROP FUNCTION %s', r.f);
  END LOOP;
  EXECUTE 'DROP SCHEMA IF EXISTS recovery_guard CASCADE';
  -- 3. evidence archived, never deleted
  EXECUTE 'ALTER TABLE public.zz_recovery_canary SET SCHEMA recovery';
  EXECUTE format('ALTER SCHEMA recovery RENAME TO %I', v_arch);
  EXECUTE 'ALTER ROLE recovery_authority NOLOGIN';
  EXECUTE 'ALTER ROLE recovery_gate NOLOGIN';
  -- 4. privileges exactly as before 087
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM recovery_owner';
  FOR r IN EXECUTE format($q$SELECT s.relname, a.privilege_type, g.rolname FROM %I.acl_snapshot s
             CROSS JOIN LATERAL aclexplode(s.relacl::aclitem[]) a JOIN pg_roles g ON g.oid = a.grantee
            WHERE to_regclass('public.' || quote_ident(s.relname)) IS NOT NULL
              AND g.rolname IN ('anon', 'authenticated', 'service_role') AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')$q$, v_arch) LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I', r.privilege_type, r.relname, r.rolname);
  END LOOP;
  FOR r IN EXECUTE format($q$SELECT s.fn, g.rolname FROM %I.fn_acl_snapshot s CROSS JOIN LATERAL aclexplode(s.proacl::aclitem[]) a
             JOIN pg_roles g ON g.oid = a.grantee WHERE a.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role')$q$, v_arch) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', r.fn, r.rolname);
  END LOOP;

  -- post-checks
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'zz\_recovery\_%') OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'zz_recovery_ddl_guard') THEN
    RAISE EXCEPTION 'rollback post-check: a recovery trigger remains';
  END IF;
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN RAISE EXCEPTION 'rollback post-check: schema recovery_guard remains'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND (proname LIKE '%\_v87' OR proname LIKE 'recovery\_%')) THEN
    RAISE EXCEPTION 'rollback post-check: an 087 API function remains';
  END IF;
  EXECUTE format($q$SELECT count(*) FROM %I.acl_snapshot s JOIN pg_class c ON c.relnamespace = 'public'::regnamespace AND c.relname = s.relname
     WHERE (SELECT array_agg(x ORDER BY x) FROM (SELECT (a.grantee, a.privilege_type, a.is_grantable)::text x
              FROM aclexplode(coalesce(c.relacl, acldefault(CASE c.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a) z)
           IS DISTINCT FROM
           (SELECT array_agg(x ORDER BY x) FROM (SELECT (a.grantee, a.privilege_type, a.is_grantable)::text x
              FROM aclexplode(coalesce(s.relacl::aclitem[], acldefault(CASE c.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a) z)$q$, v_arch)
    INTO v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback post-check: % public relation ACL(s) differ from the pre-087 snapshot', v_n; END IF;
  EXECUTE format($q$SELECT count(*) FROM %I.fn_acl_snapshot s JOIN pg_proc p ON p.oid = 'public.prune_idempotency_keys()'::regprocedure
     WHERE (SELECT array_agg(x ORDER BY x) FROM (SELECT (a.grantee, a.privilege_type)::text x FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) z)
           IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM (SELECT (a.grantee, a.privilege_type)::text x
              FROM aclexplode(coalesce(s.proacl::aclitem[], acldefault('f', p.proowner))) a) z)$q$, v_arch)
    INTO v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback post-check: prune_idempotency_keys privileges differ from the pre-087 snapshot'; END IF;
  SELECT count(*) || ':' || coalesce(sum(hashtextextended(k::text, 0)::numeric), 0) || ':' || coalesce(sum(hashtextextended(k::text, 1)::numeric), 0)
    INTO v_after FROM public.idempotency_keys k;
  IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'rollback post-check: the operation ledger changed'; END IF;
  EXECUTE format('SELECT (SELECT count(*) FROM %1$I.journal) || '':'' || (SELECT count(*) FROM %1$I.events) || '':'' || (SELECT count(*) FROM %1$I.chain_log)
      || '':'' || (SELECT count(*) FROM %1$I.decisions) || '':'' || (SELECT count(*) FROM %1$I.quarantine) || '':'' || (SELECT count(*) FROM %1$I.tills)', v_arch)
    INTO v_ev_after;
  IF v_ev_after IS DISTINCT FROM v_ev_before THEN RAISE EXCEPTION 'rollback post-check: archived evidence differs (% vs %)', v_ev_after, v_ev_before; END IF;
  -- last: the ledger row, so a re-apply of 087 is the forward recovery
  DELETE FROM supabase_migrations.schema_migrations WHERE version = '087';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'rollback post-check: expected to remove exactly one 087 ledger row, removed %', v_n; END IF;
  RAISE NOTICE '087 rolled back; evidence archived in schema %', v_arch;
  PERFORM pg_notify('pgrst', 'reload schema');
END $rollback$;
