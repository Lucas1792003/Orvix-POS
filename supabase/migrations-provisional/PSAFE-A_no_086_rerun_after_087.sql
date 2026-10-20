-- ============================================================
-- PROVISIONAL migration PSAFE-A: never re-run 086 after 087
-- (no number assigned; see supabase/migrations-provisional/README.md)
--
-- DEFECT (financial compatibility audit 2026-10-20, reproduced on a
-- disposable database)
--   086's grant step (086:1595-1605) loops over EVERY public function named
--   op_% and, for each: ALTER FUNCTION ... OWNER TO postgres; REVOKE ALL ...
--   FROM PUBLIC, anon, authenticated, service_role. Then it grants
--   prune_idempotency_keys() to service_role "as 062 granted it".
--   On a database that already has 087 this also matches op_execute_v87 and
--   op_status_v87. Re-running 086 as the superuser (its header says
--   "FORWARD RECOVERY: idempotent; re-run") therefore SUCCEEDS silently and:
--     * hands both v87 executors from recovery_owner to postgres and removes
--       authenticated's EXECUTE -> every v87 till is refused every financial
--       operation;
--     * re-grants the prune 087 revoked from service_role;
--     * leaves 087's function registry drifted (both executors no longer
--       owned by recovery_owner), so later superuser migrations refuse.
--   Re-running it as postgres stops at 087's DDL guard only when psql stops
--   at the first error (ON_ERROR_STOP / one transaction); without that,
--   postgres still owns prune_idempotency_keys() and 086's later GRANT gives
--   it back to service_role — only this guard refuses that. The runner
--   (apply-migrations.sh) refuses a recorded or out-of-order version and,
--   with this change, any 086 run while 087 is installed. The gap this
--   closes is a manual psql run.
--
-- WHY NOT FIX 086 / 087 THEMSELVES
--   086 and 087 are reviewed, verified contracts: the runner records each
--   file's sha256 when applied and refuses a checksum mismatch afterwards;
--   086's digests, tools/m086-verify and tools/m087-verify and the evidence
--   documents are written against these exact files. They are not rewritten.
--
-- WHAT THIS DOES
--   A superuser-owned ddl_command_end event trigger. After every ALTER
--   FUNCTION, GRANT or REVOKE it checks, while 087 is installed (schema
--   recovery and op_execute_v87 present):
--     1. op_execute_v87 / op_status_v87 are owned by recovery_owner and
--        executable by authenticated;
--     2. service_role cannot execute prune_idempotency_keys();
--     3. service_role, anon, authenticated cannot INSERT / UPDATE / DELETE /
--        TRUNCATE public.idempotency_keys (087 revoked them).
--   A violation raises ORVIX_NO_086_AFTER_087 and the statement fails. As one
--   transaction (psql --single-transaction, the runner) nothing at all
--   changes. In psql's AUTOCOMMIT mode the failing statement changes nothing
--   and the definitions 086 re-creates before it are identical, BUT 086 also
--   drops and re-adds idempotency_keys_state_chk in two statements: under
--   load (lock_timeout) or without ON_ERROR_STOP the ledger could be left
--   without that check, which neither this guard nor 087's fingerprint sees.
--   A manual autocommit re-run of 086 is therefore still unsafe — never do it.
--   Tested in supabase/tests/m086-rerun/run.sh.
--
-- COMPATIBILITY
--   * 087 install / re-apply: 087 disables every pre-existing event trigger
--     for its own transaction (087:60-75) and refuses event triggers a
--     non-superuser controls; this one is owned by the superuser runner.
--   * 087 rollback: renames schema recovery and drops the v87 functions
--     before it restores the pre-087 privileges, so the check is inactive
--     by then.
--   * A future migration that must change these privileges on purpose (an
--     088 that replaces the executors) sets, for its own transaction only:
--       SET LOCAL orvix.allow_v87_executor_privilege_change = 'on';
--     honoured only in a superuser session (any role can set a GUC), and it
--     lifts only the executor check — never the prune or ledger checks.
--   * Without 087 installed the trigger does nothing (either order works).
--
-- Apply as the superuser migration runner, one transaction. Idempotent.
-- Rollback: PSAFE-A.rollback.sql.
-- ============================================================

SET lock_timeout = '3s';

DO $psafe_pre$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'PSAFE-A: run as the superuser migration runner (an event trigger needs it)';
  END IF;
  -- a schema a non-superuser created first could later be dropped with the guard in it
  IF EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'orvix_guard' AND NOT r.rolsuper) THEN
    RAISE EXCEPTION 'PSAFE-A: schema orvix_guard exists and is not owned by a superuser; remove it (superuser) first';
  END IF;
  -- installing over an already damaged database would refuse every later GRANT / REVOKE
  -- / ALTER FUNCTION and even the step-by-step repair: repair first, then install
  IF to_regnamespace('recovery') IS NOT NULL
     AND to_regprocedure('public.op_execute_v87(uuid,text,jsonb,text,jsonb)') IS NOT NULL
     AND (EXISTS (SELECT 1 FROM pg_proc p
                   WHERE p.oid IN ('public.op_execute_v87(uuid,text,jsonb,text,jsonb)'::regprocedure,
                                   'public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb)'::regprocedure)
                     AND (p.proowner IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')
                          OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')))
          OR has_function_privilege('service_role', 'public.prune_idempotency_keys()', 'EXECUTE')) THEN
    RAISE EXCEPTION 'PSAFE-A: the 087 executors or the prune privileges are already damaged here (086 re-run?); repair them (re-apply 087 via the runner) before installing this guard';
  END IF;
END $psafe_pre$;

CREATE SCHEMA IF NOT EXISTS orvix_guard;
REVOKE ALL ON SCHEMA orvix_guard FROM PUBLIC;

CREATE OR REPLACE FUNCTION orvix_guard.no_086_after_087()
RETURNS event_trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $f$
DECLARE
  v_exec regprocedure;
  v_status regprocedure;
  v_prune regprocedure;
  v_problem text;
  v_allow boolean;
BEGIN
  IF to_regnamespace('recovery') IS NULL THEN RETURN; END IF;                          -- 087 not installed
  v_exec := to_regprocedure('public.op_execute_v87(uuid,text,jsonb,text,jsonb)');
  v_status := to_regprocedure('public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb)');
  IF v_exec IS NULL AND v_status IS NULL THEN RETURN; END IF;                          -- 087 rollback in progress
  -- deliberate change of the EXECUTORS by a future migration: honoured for a
  -- superuser session only, and it skips only check 1 (never 2 or 3)
  v_allow := coalesce(current_setting('orvix.allow_v87_executor_privilege_change', true) = 'on', false)
             AND coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false);

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_problem
    FROM pg_proc p
   WHERE p.oid IN (v_exec, v_status)
     AND (p.proowner IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')
          OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_problem IS NOT NULL AND NOT v_allow THEN
    RAISE EXCEPTION 'ORVIX_NO_086_AFTER_087: this statement would take the 087 executors (%) away from recovery_owner or from authenticated: every v87 till would be refused. Migration 086 must never be re-run once 087 is installed (docs/selfhost-migration/phase-g/migration-086.md). Nothing was changed by this statement.', v_problem
      USING ERRCODE = '42501';
  END IF;

  v_prune := to_regprocedure('public.prune_idempotency_keys()');
  IF v_prune IS NOT NULL AND to_regrole('service_role') IS NOT NULL AND has_function_privilege('service_role', v_prune, 'EXECUTE') THEN
    RAISE EXCEPTION 'ORVIX_NO_086_AFTER_087: this statement would let service_role prune the operation ledger again (087 revoked it). Migration 086 must never be re-run once 087 is installed. Nothing was changed by this statement.'
      USING ERRCODE = '42501';
  END IF;

  -- table AND column grants (has_table_privilege ignores column-level INSERT / UPDATE)
  IF to_regclass('public.idempotency_keys') IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(ARRAY['service_role', 'anon', 'authenticated']) r(role)
                CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
        WHERE to_regrole(r.role) IS NOT NULL
          AND (has_table_privilege(r.role, 'public.idempotency_keys', p.priv)
               OR (p.priv IN ('INSERT', 'UPDATE') AND has_any_column_privilege(r.role, 'public.idempotency_keys', p.priv)))) THEN
    RAISE EXCEPTION 'ORVIX_NO_086_AFTER_087: this statement would let an API role rewrite the operation ledger (087 revoked it). Nothing was changed by this statement.'
      USING ERRCODE = '42501';
  END IF;
END;
$f$;

REVOKE ALL ON FUNCTION orvix_guard.no_086_after_087() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS zz_orvix_no_086_after_087;
CREATE EVENT TRIGGER zz_orvix_no_086_after_087 ON ddl_command_end
  WHEN TAG IN ('ALTER FUNCTION', 'ALTER ROUTINE', 'GRANT', 'REVOKE')
  EXECUTE FUNCTION orvix_guard.no_086_after_087();
-- fires in every session_replication_role, like 087's own DDL guard
ALTER EVENT TRIGGER zz_orvix_no_086_after_087 ENABLE ALWAYS;

DO $psafe_post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'zz_orvix_no_086_after_087' AND evtenabled = 'A') THEN
    RAISE EXCEPTION 'PSAFE-A post-check: the guard event trigger is not enabled ALWAYS';
  END IF;
  IF NOT (SELECT r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
           WHERE p.oid = 'orvix_guard.no_086_after_087()'::regprocedure) THEN
    RAISE EXCEPTION 'PSAFE-A post-check: the guard function must be owned by a superuser (087 refuses event triggers a non-superuser controls)';
  END IF;
  IF NOT (SELECT r.rolsuper FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'orvix_guard') THEN
    RAISE EXCEPTION 'PSAFE-A post-check: schema orvix_guard must be owned by a superuser';
  END IF;
END $psafe_post$;

RESET lock_timeout;
