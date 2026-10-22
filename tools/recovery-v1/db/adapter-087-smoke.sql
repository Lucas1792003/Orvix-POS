-- 087 adapter (final migration integration): migration 087 installed BEFORE Recovery V1, then V1
-- installed with the acknowledgement. Synthetic disposable cluster only. Runs as the cluster superuser.
-- Part 1: 087 HELD (as installed) + every organization RESTRICTED (as installed).
-- Part 2: a SYNTHETIC opening of 087 (owner anchor, authority genesis, owner open, legacy paths open);
--         fixture only, so that V1's own enforcement can be observed with 087 open.
\set ON_ERROR_STOP on
SELECT test.logout();

-- ---------------------------------------------------------------- adoption
SELECT test.check('a01 adapter recorded exactly one adopted 087',
  (SELECT count(*)=1 FROM recovery_v1.adapter_087) AND (SELECT fingerprint FROM recovery_v1.adapter_087)=recovery_v1.m087_fingerprint());
SELECT test.check('a02 adoption audited, install audit says 087 adopted',
  EXISTS(SELECT 1 FROM recovery_v1.audit WHERE kind='migration_087_adopted')
  AND EXISTS(SELECT 1 FROM recovery_v1.audit WHERE kind='installed' AND (detail->>'migration_087_adopted')::boolean));
SELECT test.check('a03 integrity intact with 087 adopted', recovery_v1.integrity_problem() IS NULL);
SELECT test.check('a04 every organization still RESTRICTED (install never sets ACTIVE)',
  (SELECT bool_and(state='RESTRICTED') FROM recovery_v1.org_state));
SELECT test.check('a05 087 still installed held and untouched (no lease, state hold)',
  (SELECT state='hold' FROM recovery.continuity) AND NOT EXISTS(SELECT 1 FROM recovery.lease));
SELECT test.check('a06 the 7 public V1 entry points (Step 5: + recovery_v1_call) are SECURITY INVOKER wrappers owned by recovery_owner',
  (SELECT count(*)=7 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'recovery\_v1\_%'
     AND NOT prosecdef AND proowner='recovery_owner'::regrole));
SELECT test.check('a07 V1 implementations stay SECURITY DEFINER and are not owned by an 087 role',
  (SELECT count(*)=4 FROM pg_proc WHERE oid IN('recovery_v1.status(text)'::regprocedure,'recovery_v1.transition(text,text,text,text)'::regprocedure,
     'recovery_v1.store_evidence(jsonb)'::regprocedure,'recovery_v1.store_checkpoint(jsonb)'::regprocedure) AND prosecdef AND proowner<>'recovery_owner'::regrole));
-- evaluated exactly as recovery_guard.ddl_guard does (regprocedure text depends on search_path)
SET search_path = pg_catalog, pg_temp;
SELECT test.check('a08 087 registry includes the 7 wrappers and its whole backstop condition is clean',
  (SELECT count(*)=7 FROM recovery_guard.functions WHERE fn LIKE 'public.recovery\_v1\_%')
  AND NOT EXISTS (SELECT 1 FROM recovery_guard.snapshot g WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=g.relid)
                   OR g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))
  AND NOT EXISTS (SELECT 1 FROM recovery_guard.functions f WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=f.fnid
                   AND p.oid::regprocedure::text=f.fn AND p.proowner='recovery_owner'::regrole))
  AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%')
                   AND p.oid NOT IN (SELECT fnid FROM recovery_guard.functions)));
RESET search_path;
SELECT test.check('a09 087 snapshot includes V1 guards on 087-guarded tables',
  (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname='sales') LIKE '%zz_recovery_v1_write:A:%'
  AND (SELECT fingerprint FROM recovery_guard.snapshot WHERE relname='sales') LIKE '%zz_recovery_guard:A:%');
SELECT test.check('a10 both guard sets ENABLE ALWAYS on every 087-guarded org table',
  NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgname='zz_recovery_guard' AND NOT EXISTS(SELECT 1 FROM pg_trigger v WHERE v.tgrelid=g.tgrelid
    AND v.tgname IN('zz_recovery_v1_write','zz_recovery_v1_ledger') AND v.tgenabled='A')));

-- ---------------------------------------------------------------- 087 held + V1 restricted
SELECT test.expect_error('h01 superuser write refused (V1 first, BEFORE trigger)', $$UPDATE public.shops SET address='x' WHERE id='shop-a'$$, 'ORG_SUSPENDED: recovery evidence unresolved');
SELECT test.login('a0000000-0000-4000-8000-000000000001');
SET ROLE authenticated;
SELECT test.check('h02 status RESTRICTED for own organization', public.recovery_v1_status('org-test')->>'state'='RESTRICTED');
SELECT test.expect_error('h03 status cannot read another tenant through the wrapper', $$SELECT public.recovery_v1_status('org-unrelated')$$, 'RECOVERY_V1_CALLER_REQUIRED');
SELECT test.check('h04 ACTIVE transition denied through the wrapper', public.recovery_v1_transition('org-test','ACTIVE','looks fine','synthetic')->>'outcome'='denied');
SELECT test.expect_error('h05 authenticated cannot read V1 tables despite schema USAGE', $$SELECT * FROM recovery_v1.org_state$$, 'permission denied');
SELECT test.expect_error('h06 authenticated cannot call V1 internals despite schema USAGE', $$SELECT recovery_v1.integrity_problem()$$, 'permission denied');
SELECT test.expect_error('h07 087 executor refused while 087 is held', $$SELECT public.op_execute_v87(gen_random_uuid(),'open_shift','{}'::jsonb,'u-admin','{}'::jsonb)$$, 'ORG_SUSPENDED');
RESET ROLE;
SELECT test.logout();
-- V1 ACTIVE alone is not enough while 087 holds (Step 5: genuine owner-signed reopening, synthetic owner)
\set fx_org org-test
\ir ../step5/fixture-activate.psql
SELECT test.expect_error('h08 V1 ACTIVE + 087 held: write refused by 087', $$UPDATE public.shops SET address='x' WHERE id='shop-a'$$, 'ORG_SUSPENDED: server recovery in progress');
SELECT test.login('a0000000-0000-4000-8000-000000000001');
SET ROLE authenticated;
SELECT test.check('h09 V1 ACTIVE + 087 held: status reports RESTRICTED with the 087 hold',
  public.recovery_v1_status('org-test')->>'state'='RESTRICTED' AND public.recovery_v1_status('org-test')->>'uncertainties' LIKE '%087 recovery hold%');
RESET ROLE;
SELECT test.logout();
UPDATE recovery_v1.org_state SET state='RESTRICTED' WHERE org_id='org-test';

-- ---------------------------------------------------------------- fencing under 087
SELECT current_database() AS expected_database,(SELECT system_identifier::text FROM pg_control_system()) AS expected_system_identifier \gset
SELECT count(*) AS ledger_before FROM public.idempotency_keys \gset
SET ROLE orvix_recovery_operator;
SELECT recovery_v1.fence_key(:'expected_database',:'expected_system_identifier','org-test','shop-a','99999999-0000-4000-8000-000000000087','complete_sale','u-cash-a1','incident',repeat('a',64),'synthetic-authorization') AS f87 \gset
RESET ROLE;
SELECT test.expect_error('f02 wrong target still raises before the 087 refusal',format($q$SELECT recovery_v1.fence_key('wrong',%L,'org-test','shop-a','99999999-0000-4000-8000-000000000088','complete_sale','u-cash-a1','incident',repeat('a',64),'synthetic-authorization')$q$,:'expected_system_identifier'),'RECOVERY_V1_TARGET_MISMATCH');
SELECT test.check('f01 V1 fence refused under 087: outcome refused, audited, no fence row, no ledger row',
  :'f87'::jsonb->>'outcome'='refused' AND (:'f87'::jsonb->>'fence_written')::boolean IS FALSE
  AND EXISTS(SELECT 1 FROM recovery_v1.audit WHERE kind='fence_refused_087_adopted' AND detail->>'key'='99999999-0000-4000-8000-000000000087')
  AND NOT EXISTS(SELECT 1 FROM recovery_v1.fences WHERE key='99999999-0000-4000-8000-000000000087')
  AND (SELECT count(*) FROM public.idempotency_keys)=:ledger_before);
SELECT test.expect_error('f03 unfence of a key that was never fenced is refused', format($q$SELECT recovery_v1.request_unfence(%L,%L,'org-test','shop-a','99999999-0000-4000-8000-000000000087','incident',repeat('a',64),'{}')$q$,:'expected_database',:'expected_system_identifier'), 'RECOVERY_V1_INVALID_UNFENCE_TARGET');

-- ---------------------------------------------------------------- 087 is fixed while V1 is installed (DDL)
SELECT test.expect_error('d01 superuser change of an 087 function refused', $$ALTER FUNCTION recovery.refuse(text) SET work_mem='1MB'$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d02 superuser replacement of an 087 function body refused',
  $$CREATE OR REPLACE FUNCTION recovery.lease_ok() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS 'SELECT true'$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d03 dropping an 087 row guard refused', $$DROP TRIGGER zz_recovery_guard ON public.shops$$, '_CHANGE_BLOCKED');
SELECT test.expect_error('d04 disabling an 087 row guard refused', $$ALTER TABLE public.shops DISABLE TRIGGER zz_recovery_guard$$, '_CHANGE_BLOCKED');
SELECT test.expect_error('d05 renaming the 087 schema refused', $$ALTER SCHEMA recovery RENAME TO recovery_moved$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d06 disabling a V1 guard still refused', $$ALTER TABLE public.sales DISABLE TRIGGER zz_recovery_v1_write$$, 'RECOVERY_V1_GUARD_CHANGE_BLOCKED');
SELECT test.check('d07 nothing changed by the refused DDL',
  recovery_v1.m087_fingerprint()=(SELECT fingerprint FROM recovery_v1.adapter_087) AND to_regnamespace('recovery') IS NOT NULL
  AND recovery_v1.integrity_problem() IS NULL);
-- review round 1: what the fingerprint now also covers (each refused as superuser, nothing changed)
SELECT test.expect_error('d09 GRANT on an 087 table (effective privileges) refused', $$GRANT SELECT ON recovery.keys TO authenticated$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d10 column default on an 087 table refused', $$ALTER TABLE recovery.settings ALTER COLUMN legacy_paths SET DEFAULT 'open'$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d11 dropping an 087 index refused', $$DROP INDEX recovery.decisions_one_open_per_key$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d12 a view added to an 087 schema refused', $$CREATE VIEW recovery.zz_v AS SELECT 1 AS x$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d13 a trigger on an 087 table refused', $$CREATE TRIGGER zz_t BEFORE UPDATE ON recovery.continuity FOR EACH ROW EXECUTE FUNCTION recovery_v1.immutable()$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d14 LEAKPROOF on an 087 function refused', $$ALTER FUNCTION recovery.lease_ok() LEAKPROOF$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d15 row security off on the 087 canary refused', $$ALTER TABLE public.zz_recovery_canary DISABLE ROW LEVEL SECURITY$$, 'RECOVERY_V1_087_CHANGE_BLOCKED');
SELECT test.expect_error('d16 a V1 entry point replaced refused', $$CREATE OR REPLACE FUNCTION public.recovery_v1_status(p_org_id text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $b$ SELECT '{"state":"ACTIVE"}'::jsonb $b$ $$, 'RECOVERY_V1_ENTRY_POINT_CHANGE_BLOCKED');
SELECT test.expect_error('d17 a V1 entry point made SECURITY DEFINER refused', $$ALTER FUNCTION public.recovery_v1_status(text) SECURITY DEFINER$$, 'RECOVERY_V1_ENTRY_POINT_CHANGE_BLOCKED');
SELECT test.expect_error('d18 a V1 entry point granted to anon refused', $$GRANT EXECUTE ON FUNCTION public.recovery_v1_status(text) TO anon$$, 'RECOVERY_V1_ENTRY_POINT_CHANGE_BLOCKED');
SELECT test.expect_error('d19 a new public recovery_v1_* function refused', $$CREATE FUNCTION public.recovery_v1_backdoor() RETURNS int LANGUAGE sql AS 'SELECT 1'$$, 'RECOVERY_V1_ENTRY_POINT_CHANGE_BLOCKED');
SELECT test.expect_error('d20 a new public table (unguarded) refused', $$CREATE TABLE public.sale_payments_probe (id text PRIMARY KEY)$$, 'RECOVERY_V1_UNGUARDED_TABLE_BLOCKED');
SELECT test.check('d21 nothing changed by the refused DDL',
  recovery_v1.m087_fingerprint()=(SELECT fingerprint FROM recovery_v1.adapter_087) AND recovery_v1.m087_fingerprint(true)=(SELECT full_fingerprint FROM recovery_v1.adapter_087)
  AND recovery_v1.entry_fingerprint()=(SELECT entry_fingerprint FROM recovery_v1.pins) AND recovery_v1.integrity_problem() IS NULL);
-- a non-superuser's unrelated DDL (outside public) still passes every DDL guard: the 087 registry is clean with V1
CREATE ROLE zz_adapter_ddl_probe NOLOGIN;
CREATE SCHEMA zz_adapter_probe AUTHORIZATION zz_adapter_ddl_probe;
SET ROLE zz_adapter_ddl_probe;
CREATE TABLE zz_adapter_probe.unrelated (id int);
DROP TABLE zz_adapter_probe.unrelated;
RESET ROLE;
DROP SCHEMA zz_adapter_probe;
DROP ROLE zz_adapter_ddl_probe;
SELECT test.check('d08 non-superuser unrelated DDL passed every DDL guard (087 registry compatible)', true);

-- ---------------------------------------------------------------- runtime fail-closed when an event trigger is touched
-- (ALTER/DROP/CREATE EVENT TRIGGER fire no event trigger; they rewrite the catalog row the install pinned).
-- Each probe runs in a transaction that is rolled back; results are carried out in psql variables.
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $t$BEGIN EXECUTE p_sql; RETURN 'ALLOWED'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END$t$;
-- Step 5: the probes below need an ACTIVE organization (genuine owner-signed reopening; was a superuser UPDATE inside the
-- rolled-back transaction), and org-test is restricted again afterwards exactly as before (o02 expects RESTRICTED)
\set fx_org org-test
\ir ../step5/fixture-activate.psql
BEGIN;
ALTER EVENT TRIGGER zz_recovery_v1_ddl DISABLE;
ALTER EVENT TRIGGER zz_recovery_v1_ddl ENABLE ALWAYS;   -- the disable window is over, enabled again
SELECT recovery_v1.integrity_problem() AS ip_v1window, pg_temp.try($$UPDATE public.shops SET address='x' WHERE id='shop-a'$$) AS w_v1window \gset
ROLLBACK;
UPDATE recovery_v1.org_state SET state='RESTRICTED' WHERE org_id='org-test';   -- back to the state the original sequence had here
BEGIN;
ALTER EVENT TRIGGER zz_recovery_ddl_guard DISABLE;
SELECT recovery_v1.integrity_problem() AS ip_087off \gset
ALTER EVENT TRIGGER zz_recovery_ddl_guard ENABLE ALWAYS;
SELECT recovery_v1.integrity_problem() AS ip_087window \gset
ROLLBACK;
BEGIN;
DROP EVENT TRIGGER zz_recovery_v1_ddl;
CREATE EVENT TRIGGER zz_recovery_v1_ddl ON ddl_command_end WHEN TAG IN ('COMMENT') EXECUTE FUNCTION recovery_v1.ddl_guard();
ALTER EVENT TRIGGER zz_recovery_v1_ddl ENABLE ALWAYS;
SELECT recovery_v1.integrity_problem() AS ip_recreated \gset
ROLLBACK;
BEGIN;
ALTER EVENT TRIGGER zz_recovery_v1_ddl DISABLE; ALTER EVENT TRIGGER zz_recovery_ddl_guard DISABLE;   -- stands in for PG17's SET event_triggers = off
CREATE OR REPLACE TRIGGER zz_recovery_v1_write BEFORE INSERT OR UPDATE OR DELETE ON public.shops FOR EACH ROW WHEN (false) EXECUTE FUNCTION recovery_v1.guard_write();
ALTER TABLE public.shops ENABLE ALWAYS TRIGGER zz_recovery_v1_write;
SELECT (recovery_v1.guard_triggers_state((SELECT public_tables FROM recovery_v1.pins)) IS DISTINCT FROM (SELECT guard_triggers FROM recovery_v1.pins))::text AS gt_changed \gset
ROLLBACK;
CREATE SCHEMA zz_moveprobe; CREATE TABLE zz_moveprobe.t (id int);
SELECT test.expect_error('d22 a table moved into public (SET SCHEMA) refused', $$ALTER TABLE zz_moveprobe.t SET SCHEMA public$$, 'RECOVERY_V1_UNGUARDED_TABLE_BLOCKED');
DROP SCHEMA zz_moveprobe CASCADE;
-- review round 3: a zz_recovery_* trigger on someone's own / temporary table elsewhere is irrelevant (no false quarantine)
CREATE ROLE zz_dos_probe LOGIN;
GRANT TEMPORARY ON DATABASE postgres TO zz_dos_probe;
SET ROLE zz_dos_probe;
CREATE TEMP TABLE zz_dos_t (x int);
CREATE TRIGGER zz_recovery_dos BEFORE UPDATE ON zz_dos_t FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
RESET ROLE;
SELECT test.check('r08 a zz_recovery_* trigger on a temporary table of an unprivileged role does not quarantine', recovery_v1.integrity_problem() IS NULL);
DROP TABLE pg_temp.zz_dos_t;
SELECT test.expect_error('d23 a new zz_recovery_* trigger on a guarded table refused', $$CREATE TRIGGER zz_recovery_extra BEFORE UPDATE ON public.shops FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()$$, 'RECOVERY_V1_GUARD_CHANGE_BLOCKED');
SELECT test.check('d24 integrity intact after the refused trigger', recovery_v1.integrity_problem() IS NULL);
REVOKE TEMPORARY ON DATABASE postgres FROM zz_dos_probe;
DROP ROLE zz_dos_probe;
SELECT test.check('r07 a guard trigger replaced while event triggers are off -> pinned trigger state differs (guard_trigger_changed)', :'gt_changed'='true');
SELECT test.check('r01 V1 DDL trigger disabled then re-enabled -> quarantined (row version changed)', :'ip_v1window'='event_trigger_changed');
SELECT test.check('r02 ... and an ACTIVE organization''s write is refused', :'w_v1window' LIKE '%integrity:event_trigger_changed%');
SELECT test.check('r03 087 DDL trigger disabled -> quarantined', :'ip_087off' IN ('event_trigger_changed','migration_087_ddl_guard_not_enabled'));
SELECT test.check('r04 087 DDL trigger disabled then re-enabled -> still quarantined', :'ip_087window'='event_trigger_changed');
SELECT test.check('r05 V1 DDL trigger recreated with a tag filter -> quarantined', :'ip_recreated'='event_trigger_changed');
SELECT test.check('r06 after the rolled-back probes: integrity intact, every organization still RESTRICTED',
  recovery_v1.integrity_problem() IS NULL AND (SELECT bool_and(state='RESTRICTED') FROM recovery_v1.org_state));

-- ---------------------------------------------------------------- Part 2: SYNTHETIC opening of 087 (fixture only)
SELECT recovery.owner_anchor('synthetic harness anchor','harness-person-a','harness-person-b');
SET ROLE recovery_authority;
SELECT recovery.authority_renew(1, 3600, pg_postmaster_start_time(), true, repeat('ab',32)) AS renewed \gset
RESET ROLE;
SELECT recovery.owner_open('harness-person-a','harness-person-b');
UPDATE recovery.settings SET legacy_paths='open';   -- owner SQL decision D7 in 087; fixture only (direct SQL test writes)
SELECT test.check('o01 synthetic 087 opening worked', :'renewed'='RENEWED' AND (SELECT state='open' FROM recovery.continuity) AND recovery.lease_ok());
SELECT test.expect_error('o02 087 open + V1 RESTRICTED: write refused by V1', $$UPDATE public.shops SET address='x' WHERE id='shop-a'$$, 'ORG_SUSPENDED: recovery evidence unresolved');
\set fx_org org-test
\ir ../step5/fixture-activate.psql
UPDATE public.shops SET address='Synthetic composed write' WHERE id='shop-a';
SELECT test.check('o03 087 open + V1 ACTIVE: write allowed (both guards pass)', (SELECT address='Synthetic composed write' FROM public.shops WHERE id='shop-a'));
SELECT test.login('a0000000-0000-4000-8000-000000000001');
SET ROLE authenticated;
SELECT test.check('o04 087 open + V1 ACTIVE: status ACTIVE', public.recovery_v1_status('org-test')->>'state'='ACTIVE');
RESET ROLE;
SELECT test.logout();
SELECT test.check('o05 org-unrelated stays RESTRICTED', (SELECT state='RESTRICTED' FROM recovery_v1.org_state WHERE org_id='org-unrelated'));
SELECT test.expect_error('o06 087 open: org-unrelated write refused by V1', $$UPDATE public.shops SET address='x' WHERE id='shop-unrel'$$, 'ORG_SUSPENDED: recovery evidence unresolved');
SELECT test.expect_error('o07 087 open: ledger rows still immutable (V1)', $$UPDATE public.idempotency_keys SET request_hash='x' WHERE org_id='org-test'$$, 'ORG_SUSPENDED');
-- both BEFORE TRUNCATE guards refuse; 087's (zz_recovery_truncate) sorts first and answers
SELECT test.expect_error('o08 087 open: ledger TRUNCATE refused', $$TRUNCATE public.idempotency_keys$$, 'LEDGER_EVIDENCE_PROTECTED');
SELECT count(*) AS ledger_before_prune FROM public.idempotency_keys \gset
SELECT public.prune_idempotency_keys();
SELECT test.check('o09 prune deletes nothing (V1 skips, 087 never sees a delete)', (SELECT count(*) FROM public.idempotency_keys)=:ledger_before_prune);
SELECT test.check('o10 integrity intact after the synthetic opening', recovery_v1.integrity_problem() IS NULL);
-- leaves org-test ACTIVE + 087 open for cross-org-smoke.sql / financial smokes (same preconditions as smoke.sql)
