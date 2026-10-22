-- PROVISIONAL / UNNUMBERED. LOCAL IMPLEMENTATION ONLY. Not migration 088.
-- Install only in an explicitly isolated database, in ONE transaction as superuser.
-- Preserves all numbered migrations and pinned financial/helper bodies.
-- Supported exact helper contracts: 085 (074) or 086. Migration 087 is supported ONLY through the
-- 087 adapter below: 087 installed BEFORE V1, catalog-identical to the reviewed 087 (pinned
-- fingerprint), its DDL backstop clean. Then both guards apply (a write needs BOTH an open 087
-- server and an ACTIVE V1 organization), V1's public functions are 087-registry compatible
-- (SECURITY INVOKER wrappers owned by recovery_owner), V1 fencing is refused (087's held guard
-- blocks the sentinel), and any later change or
-- removal of 087 is refused (DDL) or quarantines every organization (runtime); no fence path exists
-- while V1 is installed (087's own fence writes need an ACTIVE organization). 087 applied AFTER
-- V1 is never adopted: every organization stays QUARANTINED (fail closed).
-- Fresh install is RESTRICTED for every org. There is NO production ACTIVE release
-- or unfence authority implementation. A restore never constitutes authorization.
-- Run ONLY as:  psql -X -v recovery_v1_install_ack=restrict-every-organization -f RECOVERY_V1_guards.sql
-- The file opens its own transaction and stops at the first error. The acknowledgement
-- comes from a per-invocation psql variable passed as the installer's ARGUMENT, so a stored
-- session-, role- or database-level setting cannot satisfy it (run with -X: a .psqlrc that sets
-- the variable would be a deliberate acknowledgement). Without the variable the
-- next statement is a syntax error, the transaction aborts and NOTHING is created. BEGIN is
-- the very first statement, and every object is created inside ONE session-temporary function
-- call after the acknowledgement check, so neither a client that ignores psql meta-commands nor
-- one that runs each statement on its own connection can create anything.
BEGIN;
\set ON_ERROR_STOP on
SELECT pg_catalog.set_config('orvix.recovery_v1_install_ack', :'recovery_v1_install_ack', true);
-- Optional, per invocation (never stored settings):
--   -v recovery_v1_owner_public_key='{"keyId":"...","n":"<hex modulus>","e":65537}'   the owner's RSA public key (>= 2048 bits),
--      generated and held OFFLINE by the owner; without it no owner-authorized migration or offline policy is ever possible
--   -v recovery_v1_offline_defaults=allow-unapproved-test-defaults   lets tills receive offline capabilities under the
--      conservative built-in defaults before the owner signs an offline policy (test / staging only; recorded and audited)
\if :{?recovery_v1_owner_public_key}
\else
\set recovery_v1_owner_public_key ''
\endif
\if :{?recovery_v1_offline_defaults}
\else
\set recovery_v1_offline_defaults ''
\endif
-- The entire installation is ONE call of a session-temporary function. Every object is created
-- inside it, after the acknowledgement check, or not at all. A client that runs each statement on
-- its own connection cannot install anything: pg_temp functions exist only in the creating session.
CREATE FUNCTION pg_temp.recovery_v1_install(p_ack text, p_owner_key text, p_offline_defaults text) RETURNS void LANGUAGE plpgsql AS $rv1install$
BEGIN
 -- The acknowledgement is THIS call's argument (from the per-invocation psql variable), never a
 -- stored session/role/database setting; the setting below only records it for the install row.
 IF p_ack IS DISTINCT FROM 'restrict-every-organization' THEN
  RAISE EXCEPTION 'RECOVERY_V1_INSTALL_ACK_REQUIRED: run psql -X -v recovery_v1_install_ack=restrict-every-organization -f RECOVERY_V1_guards.sql';
 END IF;
 PERFORM pg_catalog.set_config('orvix.recovery_v1_install_ack', p_ack, true);
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = pg_catalog, pg_temp;
-- as 087 does: no event trigger can be created, altered or dropped while this transaction runs
LOCK TABLE pg_catalog.pg_event_trigger IN EXCLUSIVE MODE;
DO $pre$
DECLARE v text; t text;
BEGIN
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN RAISE EXCEPTION 'RECOVERY_V1_INSTALL_SUPERUSER_REQUIRED'; END IF;
 -- Correction pass P5: installing restricts EVERY organization at once, and V1 has no
 -- reopen path (no independent owner-authorization verifier exists). An accidental
 -- install on a live database is a full outage, so the installer requires the explicit
 -- per-invocation acknowledgement set above and refuses without it (nothing is created).
 IF current_setting('orvix.recovery_v1_install_ack', true) IS DISTINCT FROM 'restrict-every-organization' THEN
  RAISE EXCEPTION 'RECOVERY_V1_INSTALL_ACK_REQUIRED: this install restricts every organization immediately and nothing in V1 can reopen one. Only on an isolated database: psql -v recovery_v1_install_ack=restrict-every-organization -f RECOVERY_V1_guards.sql';
 END IF;
 IF to_regnamespace('recovery_v1') IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_ALREADY_INSTALLED: inspect existing evidence; never replace it'; END IF;
 -- 087 adapter preconditions (087 present). CATALOG ONLY here: nothing of 087 is executed or read
 -- before the pinned catalog fingerprint is compared (below, right after schema recovery_v1 exists);
 -- 087's data (continuity row, guard snapshot) is read only after that, so a view or function swapped
 -- into an 087 schema can never run in this superuser transaction.
 IF (to_regnamespace('recovery') IS NULL) <> (to_regnamespace('recovery_guard') IS NULL) THEN
  RAISE EXCEPTION 'RECOVERY_V1_087_PARTIAL: only one of the 087 schemas (recovery, recovery_guard) exists; refusing';
 END IF;
 IF to_regnamespace('recovery') IS NOT NULL THEN
  IF to_regprocedure('recovery_guard.register_guards()') IS NULL OR to_regprocedure('recovery_guard.ddl_guard()') IS NULL OR to_regprocedure('recovery_guard.fingerprint(oid)') IS NULL
     OR to_regrole('recovery_owner') IS NULL
     OR NOT EXISTS(SELECT 1 FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid
                    WHERE e.evtname='zz_recovery_ddl_guard' AND e.evtenabled='A' AND p.oid=to_regprocedure('recovery_guard.ddl_guard()')
                      AND (SELECT rolsuper FROM pg_roles WHERE oid=e.evtowner) AND (SELECT rolsuper FROM pg_roles WHERE oid=p.proowner))
     OR NOT coalesce((SELECT bool_and(r.rolsuper) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
                       WHERE p.oid IN(to_regprocedure('recovery_guard.register_guards()'),to_regprocedure('recovery_guard.fingerprint(oid)'))),false)
     OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('recovery.continuity') AND c.relkind='r' AND c.relowner=to_regrole('recovery_owner'))
     OR (SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
          WHERE c.oid IN(to_regclass('recovery_guard.snapshot'),to_regclass('recovery_guard.functions')) AND c.relkind='r' AND r.rolsuper)<>2 THEN
   RAISE EXCEPTION 'RECOVERY_V1_087_NOT_INTACT: 087 DDL guard (enabled ALWAYS, superuser-owned), registry functions, continuity or guard tables are missing or not as 087 creates them; refusing';
  END IF;
 END IF;
 -- No event trigger controlled by a non-superuser (it would run inside this superuser transaction).
 SELECT string_agg(e.evtname::text, ', ') INTO t FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid
  WHERE NOT (SELECT rolsuper FROM pg_roles WHERE oid=e.evtowner) OR NOT (SELECT rolsuper FROM pg_roles WHERE oid=p.proowner);
 IF t IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_FOREIGN_EVENT_TRIGGER: event trigger(s) controlled by a non-superuser exist: %; refusing', t; END IF;
 -- supautils present: the role this installer creates must already be reserved (otherwise the Supabase
 -- privileged role could alter it, log in as it and fence keys) -- same rule as 087's recovery roles.
 IF current_setting('supautils.privileged_role', true) IS NOT NULL OR current_setting('supautils.reserved_roles', true) IS NOT NULL
    OR 'supautils' = ANY (ARRAY(SELECT btrim(x) FROM unnest(string_to_array(current_setting('session_preload_libraries') || ',' || current_setting('shared_preload_libraries'), ',')) x)) THEN
  IF NOT 'orvix_recovery_operator' = ANY (ARRAY(SELECT btrim(x) FROM unnest(string_to_array(coalesce(current_setting('supautils.reserved_roles', true), ''), ',')) x)) THEN
   RAISE EXCEPTION 'RECOVERY_V1_OPERATOR_ROLE_NOT_RESERVED: supautils.reserved_roles must list orvix_recovery_operator before installing (host prerequisite, docs/selfhost-migration/phase-g/recovery-roles-prerequisite.md)';
  END IF;
 END IF;
 SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = to_regprocedure('public.idem_begin(uuid,text,text)');
 IF v IS NULL OR v NOT IN ('afca065fea226a0c7a5b9bb56b540a9d','c9f577ed5608de19b25c00c649deaf50') THEN RAISE EXCEPTION 'RECOVERY_V1_UNKNOWN_IDEMPOTENCY_CONTRACT'; END IF;
 IF (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(att,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.att WHERE c.conrelid='public.idempotency_keys'::regclass AND c.contype='p')
    IS DISTINCT FROM (CASE v WHEN 'afca065fea226a0c7a5b9bb56b540a9d' THEN 'key' ELSE 'org_id,key' END) THEN RAISE EXCEPTION 'RECOVERY_V1_UNKNOWN_LEDGER_IDENTITY'; END IF;
 FOREACH t IN ARRAY ARRAY['brands','business_profile','categories','idempotency_keys','price_levels','product_barcodes','products','shops','suppliers','unit_types','users','organizations','audit_logs','inventory','inventory_movements','price_tiers','product_image_upload_sessions','product_unit_prices','purchase_orders','refund_void_requests','sales','shifts','supplier_payments','stock_transfers','stock_transfer_items','product_units','purchase_order_items','sale_items','reprint_logs','supplier_products','app_config','platform_admins'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||t) AND relkind='r') THEN RAISE EXCEPTION 'RECOVERY_V1_UNKNOWN_SCHEMA: required plain table %',t; END IF;
 END LOOP;
 IF to_regrole('orvix_recovery_operator') IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_RESERVED_ROLE_ALREADY_EXISTS'; END IF;
END $pre$;
CREATE ROLE orvix_recovery_operator NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE;
CREATE SCHEMA recovery_v1;
REVOKE ALL ON SCHEMA recovery_v1 FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA recovery_v1 TO orvix_recovery_operator;
-- authenticated reaches ONLY the four client entry points (EXECUTE granted below); every table,
-- sequence and other function in this schema stays revoked from it.
GRANT USAGE ON SCHEMA recovery_v1 TO authenticated;
-- 087 adapter. Catalog fingerprint of migration 087's objects (never data or OIDs). p_full=false is the
-- PORTABLE form pinned below (the same committed 087 gives the same value whichever superuser ran it, on
-- any cluster): every function of schemas recovery and recovery_guard and every public 087 function
-- (recovery_% / %_v87, except exactly V1's four wrappers) with signature, result, language, security,
-- volatility, strictness, leakproof, parallel, cost, settings, owner and body digest; every relation of
-- the 087 schemas and the canary (kind, owner, row security, columns with types, NOT NULL and defaults),
-- their constraints, indexes, policies, rules and triggers, the types and schema owners of the 087
-- schemas; 087's triggers on public tables (full definition, enabled state); 087's event trigger
-- (event, tags, function, enabled, superuser owner); the attributes of the three 087 roles (never
-- passwords); and the EFFECTIVE privileges of PUBLIC, anon, authenticated and service_role on every
-- such function and relation. p_full=true adds the raw ACLs (platform default privileges make them
-- cluster-specific): recorded at adoption and compared on every DDL command.
CREATE FUNCTION recovery_v1.m087_fingerprint(p_full boolean DEFAULT false) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH ns AS (SELECT n.oid, n.nspname, n.nspowner, n.nspacl FROM pg_namespace n WHERE n.nspname IN('recovery','recovery_guard')),
 fns AS (SELECT p.*, n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.oid IN(SELECT oid FROM ns)
             OR (n.nspname='public' AND (p.proname LIKE 'recovery\_%' OR p.proname LIKE '%\_v87')
                 AND p.oid::regprocedure::text NOT IN('public.recovery_v1_status(text)','public.recovery_v1_transition(text,text,text,text)',
                                                      'public.recovery_v1_store_evidence(jsonb)','public.recovery_v1_store_checkpoint(jsonb)',
                                                      'public.recovery_v1_offline_capability(text,text,text)','public.recovery_v1_revoke_device(text,text,text)'))),
 rels AS (SELECT c.*, n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.oid IN(SELECT oid FROM ns) OR (n.nspname='public' AND c.relname='zz_recovery_canary')),
 api AS (SELECT r FROM unnest(ARRAY['public','anon','authenticated','service_role']) r WHERE r='public' OR to_regrole(r) IS NOT NULL)
 SELECT md5(concat_ws(E'\n',
  (SELECT string_agg(x, E'\n' ORDER BY x) FROM (
    SELECT f.nspname||'.'||f.proname||'('||pg_get_function_identity_arguments(f.oid)||'):'||pg_get_function_result(f.oid)||':'||l.lanname||':'
           ||f.prosecdef::text||f.provolatile::text||f.proisstrict::text||f.proleakproof::text||f.proparallel::text||':'||f.procost::text||':'
           ||coalesce(array_to_string(f.proconfig,'|'),'')||':'||pg_get_userbyid(f.proowner)||':'||md5(f.prosrc)
           ||':'||(SELECT string_agg(a.r||'='||has_function_privilege(a.r,f.oid,'EXECUTE')::text,',' ORDER BY a.r) FROM api a)
           ||CASE WHEN p_full THEN ':'||coalesce(f.proacl::text,'') ELSE '' END AS x
      FROM fns f JOIN pg_language l ON l.oid=f.prolang) q),
  (SELECT string_agg(x, E'\n' ORDER BY x) FROM (
    SELECT c.nspname||'.'||c.relname||':'||c.relkind::text||':'||pg_get_userbyid(c.relowner)||':'||c.relrowsecurity::text||c.relforcerowsecurity::text||':'
           ||coalesce((SELECT string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||CASE WHEN a.attnotnull THEN ' NN' ELSE '' END
                                 ||coalesce(' DEFAULT '||pg_get_expr(d.adbin,d.adrelid),'')||CASE WHEN p_full THEN ' '||coalesce(a.attacl::text,'') ELSE '' END, ',' ORDER BY a.attnum)
                         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
                        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'')
           ||':'||CASE WHEN c.relkind='S' THEN (SELECT string_agg(a.r||'='||has_sequence_privilege(a.r,c.oid,'USAGE')::text||has_sequence_privilege(a.r,c.oid,'SELECT')::text
                                                   ||has_sequence_privilege(a.r,c.oid,'UPDATE')::text,',' ORDER BY a.r) FROM api a)
                       WHEN c.relkind IN('r','p','v','m','f') THEN (SELECT string_agg(a.r||'='||has_table_privilege(a.r,c.oid,'SELECT')::text||has_table_privilege(a.r,c.oid,'INSERT')::text
                                                   ||has_table_privilege(a.r,c.oid,'UPDATE')::text||has_table_privilege(a.r,c.oid,'DELETE')::text||has_table_privilege(a.r,c.oid,'TRUNCATE')::text
                                                   ||has_table_privilege(a.r,c.oid,'REFERENCES')::text||has_table_privilege(a.r,c.oid,'TRIGGER')::text,',' ORDER BY a.r) FROM api a)
                       ELSE '' END
           ||CASE WHEN p_full THEN ':'||coalesce(c.relacl::text,'') ELSE '' END AS x
      FROM rels c) q),
  (SELECT string_agg(x, E'\n' ORDER BY x) FROM (SELECT k.conrelid::regclass::text||':'||k.conname||':'||pg_get_constraintdef(k.oid) AS x
      FROM pg_constraint k WHERE k.conrelid IN(SELECT oid FROM rels) OR k.connamespace IN(SELECT oid FROM ns)) q),
  (SELECT string_agg(x, E'\n' ORDER BY x) FROM (SELECT pg_get_indexdef(i.indexrelid) AS x FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM rels)) q),
  (SELECT string_agg(x, E'\n' ORDER BY x) FROM (SELECT y.polrelid::regclass::text||':'||y.polname||':'||y.polcmd::text||':'||y.polpermissive::text||':'
           ||coalesce(pg_get_expr(y.polqual,y.polrelid),'')||':'||coalesce(pg_get_expr(y.polwithcheck,y.polrelid),'')
           ||':'||coalesce((SELECT string_agg(CASE WHEN rr=0 THEN 'public' ELSE pg_get_userbyid(rr) END,',' ORDER BY 1) FROM unnest(y.polroles) rr),'') AS x
      FROM pg_policy y WHERE y.polrelid IN(SELECT oid FROM rels)) q),
  (SELECT string_agg(x, E'\n' ORDER BY x) FROM (SELECT w.ev_class::regclass::text||':'||w.rulename||':'||pg_get_ruledef(w.oid) AS x
      FROM pg_rewrite w WHERE w.ev_class IN(SELECT oid FROM rels)) q),
  (SELECT string_agg(x, E'\n' ORDER BY x) FROM (SELECT pg_get_triggerdef(g.oid)||':'||g.tgenabled::text AS x FROM pg_trigger g
      WHERE NOT g.tgisinternal AND (g.tgrelid IN(SELECT oid FROM rels)
         OR (g.tgname IN('zz_recovery_guard','zz_recovery_truncate','zz_recovery_chain')
             AND g.tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)))) q),
  (SELECT string_agg(x, E'\n' ORDER BY x) FROM (SELECT t.typnamespace::regnamespace::text||'.'||t.typname||':'||t.typtype::text||':'||pg_get_userbyid(t.typowner) AS x
      FROM pg_type t WHERE t.typnamespace IN(SELECT oid FROM ns)) q),
  (SELECT string_agg(n.nspname||':'||pg_get_userbyid(n.nspowner)||CASE WHEN p_full THEN ':'||coalesce(n.nspacl::text,'') ELSE '' END, E'\n' ORDER BY n.nspname) FROM ns n),
  (SELECT string_agg(e.evtname||':'||e.evtevent||':'||e.evtenabled::text||':'||e.evtfoid::regprocedure::text||':'||coalesce(array_to_string(e.evttags,'|'),'')
                     ||':'||(SELECT rolsuper FROM pg_roles WHERE oid=e.evtowner)::text, E'\n' ORDER BY e.evtname)
     FROM pg_event_trigger e WHERE e.evtname='zz_recovery_ddl_guard'),
  (SELECT string_agg(r.rolname||':'||r.rolsuper::text||r.rolinherit::text||r.rolcreaterole::text||r.rolcreatedb::text||r.rolcanlogin::text||r.rolreplication::text||r.rolbypassrls::text, E'\n' ORDER BY r.rolname)
     FROM pg_roles r WHERE r.rolname IN('recovery_owner','recovery_authority','recovery_gate'))))
$$;
CREATE TABLE recovery_v1.adapter_087 (
 one boolean PRIMARY KEY DEFAULT true CHECK(one), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{32}$'), full_fingerprint text NOT NULL CHECK(full_fingerprint ~ '^[a-f0-9]{32}$'),
 recovery_nsp oid NOT NULL, guard_nsp oid NOT NULL, ddl_evt oid NOT NULL, adopted_at timestamptz NOT NULL DEFAULT clock_timestamp());
-- V1's own pins, recorded at the very end of the install: the four public entry points (and no other
-- public recovery_v1_* function) and the identity of the DDL event triggers (V1's, and 087's when
-- adopted): oid, function, tags and the catalog row version (xmin). ALTER/DROP/CREATE EVENT TRIGGER fire
-- no event trigger, but they rewrite that row, so the per-row integrity check sees any disable window.
CREATE TABLE recovery_v1.pins (one boolean PRIMARY KEY DEFAULT true CHECK(one), entry_fingerprint text NOT NULL, event_triggers jsonb NOT NULL CHECK(jsonb_typeof(event_triggers)='array'),
 guard_triggers text NOT NULL, public_tables oid[] NOT NULL,
 -- Step 4 review: V1's OWN catalog (every function, relation and its privileges, trigger, policy and rule in schema
 -- recovery_v1, and the schema itself), by row version: replacing guard_write or rsa_verify, dropping an immutability
 -- trigger or granting on recovery_v1.keys is refused by the DDL guard and, if event triggers were off, quarantines
 v1_catalog text);
-- Every recovery row/statement trigger row (V1's zz_recovery_v1_* and 087's zz_recovery_*) ON THE PUBLIC TABLES
-- PINNED AT INSTALL, by oid and row version: a superuser who switches event triggers off (PostgreSQL 17:
-- SET event_triggers = off) and replaces, disables or drops one still rewrites its pg_trigger row, so the per-row
-- integrity check sees it. Scoped to the pinned tables: a trigger of that name on anyone's own (or temporary) table
-- elsewhere is irrelevant and must not be able to quarantine every organization.
CREATE FUNCTION recovery_v1.guard_triggers_state(p_rels oid[]) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT md5(coalesce(string_agg(t.oid::text||':'||t.xmin::text||':'||t.tgenabled::text, ',' ORDER BY t.oid),''))
   FROM pg_trigger t WHERE t.tgrelid = ANY (p_rels) AND t.tgname LIKE 'zz\_recovery\_%' AND NOT t.tgisinternal $$;
CREATE FUNCTION recovery_v1.entry_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT md5(coalesce(string_agg(p.oid::regprocedure::text||':'||p.prosecdef::text||p.provolatile::text||p.proisstrict::text||p.proleakproof::text||':'
        ||coalesce(array_to_string(p.proconfig,'|'),'')||':'||pg_get_userbyid(p.proowner)||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,''), E'\n' ORDER BY p.oid::regprocedure::text),''))
   FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'recovery\_v1\_%' $$;
COMMENT ON TABLE recovery_v1.adapter_087 IS 'One row only when migration 087 was installed BEFORE V1 and adopted by the reviewed adapter. Empty = 087 must be absent.';
-- The ONLY 087 this adapter accepts: the committed supabase/migrations/087_recovery_hold.sql
-- (sha256 2dbaf34673e243de..., pinned in supabase/migrations-provisional/SEQUENCE.json), as installed.
IF to_regnamespace('recovery') IS NOT NULL THEN
 IF recovery_v1.m087_fingerprint() IS DISTINCT FROM '3406f665ad19c883798e40d607412c4d' THEN
  RAISE EXCEPTION 'RECOVERY_V1_087_UNKNOWN_VERSION: the installed 087 is not catalog-identical to the reviewed 087 (fingerprint %); refusing', recovery_v1.m087_fingerprint();
 END IF;
 -- Only now (087 verified) its data: the continuity row and 087's whole backstop condition, evaluated
 -- exactly as recovery_guard.ddl_guard does. V1 calls register_guards() at the end, so it must never
 -- bless drift that already exists.
 IF (SELECT count(*) FROM recovery.continuity) <> 1 THEN RAISE EXCEPTION 'RECOVERY_V1_087_NOT_INTACT: 087 continuity state missing'; END IF;
 IF EXISTS (SELECT 1 FROM recovery_guard.snapshot g
             WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = g.relid)
                OR g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))
    OR EXISTS (SELECT 1 FROM recovery_guard.functions f
                WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f.fnid AND p.oid::regprocedure::text = f.fn
                                    AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')))
    OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                 AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%')
                 AND p.oid NOT IN (SELECT fnid FROM recovery_guard.functions)) THEN
  RAISE EXCEPTION 'RECOVERY_V1_087_DRIFT: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
 END IF;
 -- the full form (raw ACLs) as found now; asserted unchanged at adoption (no concurrent change is blessed)
 PERFORM pg_catalog.set_config('orvix.recovery_v1_m087_full', recovery_v1.m087_fingerprint(true), true);
END IF;
CREATE TABLE recovery_v1.install (
 one boolean PRIMARY KEY DEFAULT true CHECK(one), database_name text NOT NULL, database_oid oid NOT NULL,
 system_identifier text NOT NULL, idem_body_md5 text NOT NULL, stage int NOT NULL CHECK(stage IN(85,86)), installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 install_ack text NOT NULL DEFAULT current_setting('orvix.recovery_v1_install_ack', true) CHECK(install_ack='restrict-every-organization'));
INSERT INTO recovery_v1.install SELECT true,current_database(),(SELECT oid FROM pg_database WHERE datname=current_database()),
 (SELECT system_identifier::text FROM pg_control_system()),md5(prosrc),CASE md5(prosrc) WHEN 'afca065fea226a0c7a5b9bb56b540a9d' THEN 85 ELSE 86 END FROM pg_proc WHERE oid='public.idem_begin(uuid,text,text)'::regprocedure;
CREATE TABLE recovery_v1.org_state (
 org_id text PRIMARY KEY, state text NOT NULL DEFAULT 'RESTRICTED' CHECK(state IN('ACTIVE','RESTRICTED','RECONCILING','QUARANTINED')),
 recovered_as_of timestamptz, uncertainties jsonb NOT NULL DEFAULT '["Independent recovery authorization and completeness evidence are unavailable"]'::jsonb CHECK(jsonb_typeof(uncertainties)='array'),
 reason text NOT NULL DEFAULT 'Recovery evidence not independently established', changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 offline_epoch int NOT NULL DEFAULT 0 CHECK(offline_epoch >= 0));
INSERT INTO recovery_v1.org_state(org_id) SELECT id FROM public.organizations;
-- Every departure from ACTIVE starts a new offline epoch: capabilities of an older epoch never authorize a sync again
-- (operations created under them are held for review, never accepted as verified). The epoch never decreases.
CREATE FUNCTION recovery_v1.org_state_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.offline_epoch < OLD.offline_epoch THEN RAISE EXCEPTION 'RECOVERY_V1_OFFLINE_EPOCH_DECREASE' USING ERRCODE='42501'; END IF;
 IF OLD.state = 'ACTIVE' AND NEW.state <> 'ACTIVE' THEN NEW.offline_epoch := greatest(NEW.offline_epoch, OLD.offline_epoch + 1); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recovery_v1_offline_epoch BEFORE UPDATE ON recovery_v1.org_state FOR EACH ROW EXECUTE FUNCTION recovery_v1.org_state_epoch();
ALTER TABLE recovery_v1.org_state ENABLE ALWAYS TRIGGER recovery_v1_offline_epoch;
-- ------------------------------------------------------------ registries for owner-authorized change (Step 4)
-- Guarded tables: every public table V1 guards and how a row's organization is resolved ('builtin' = the resolver below;
-- 'org_id' = a table added later by an owner-authorized migration, which must carry org_id NOT NULL).
CREATE TABLE recovery_v1.guarded_tables (relid oid PRIMARY KEY, relname text NOT NULL UNIQUE, resolver text NOT NULL CHECK(resolver IN('builtin','org_id')),
 added_at timestamptz NOT NULL DEFAULT clock_timestamp(), migration_id text);
-- The transaction context of ONE owner-authorized operation (written only by the verifying functions below; a session
-- setting is never trusted). Empty outside such a transaction.
CREATE TABLE recovery_v1.authorized_txn (txid bigint PRIMARY KEY, purpose text NOT NULL CHECK(purpose IN('migration','enroll-owner-key','offline-policy')),
 ref text NOT NULL, allowed_commands text[] NOT NULL DEFAULT '{}', new_tables text[] NOT NULL DEFAULT '{}');
-- Owner public keys (RSA, PKCS#1 v1.5 with SHA-256). The private keys never touch this server.
CREATE TABLE recovery_v1.owner_keys (key_id text PRIMARY KEY CHECK(key_id ~ '^[A-Za-z0-9._-]{1,64}$'), n numeric NOT NULL, e numeric NOT NULL CHECK(e IN (3, 65537)),
 bits int NOT NULL CHECK(bits >= 2048), fingerprint text NOT NULL UNIQUE CHECK(fingerprint ~ '^[0-9a-f]{64}$'), enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 enrolled_via text NOT NULL CHECK(enrolled_via IN('install','owner-authorization')), retired_at timestamptz);
-- Every owner authorization ever accepted (single use: its nonce), and the chain of applied migrations.
-- the exact signed text and its signature are kept, so every enrolled key, policy and migration can be re-verified
-- later against the keys enrolled before it (a row inserted without a valid signature is detectable)
CREATE TABLE recovery_v1.owner_authorizations_used (nonce uuid PRIMARY KEY, purpose text NOT NULL, key_id text NOT NULL, auth_sha256 text NOT NULL,
 authorization_text text NOT NULL, signature text NOT NULL,
 used_at timestamptz NOT NULL DEFAULT clock_timestamp(), used_by text NOT NULL DEFAULT session_user);
CREATE TABLE recovery_v1.applied_migrations (seq int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, migration_id text NOT NULL UNIQUE, sql_sha256 text NOT NULL,
 auth_sha256 text NOT NULL, key_id text NOT NULL, nonce uuid NOT NULL UNIQUE, predecessor text NOT NULL, chain_head text NOT NULL UNIQUE,
 new_tables text[] NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), applied_by text NOT NULL DEFAULT session_user);
-- Offline authorization (Part B): policy, issued capabilities, their sync-time usage, device revocations, server MAC key.
CREATE TABLE recovery_v1.settings (one boolean PRIMARY KEY DEFAULT true CHECK(one), offline_unapproved_defaults boolean NOT NULL);
CREATE TABLE recovery_v1.offline_policy (scope text PRIMARY KEY, max_lifetime_seconds int NOT NULL CHECK(max_lifetime_seconds BETWEEN 300 AND 86400),
 max_ops int NOT NULL CHECK(max_ops BETWEEN 1 AND 1000), max_amount_mmk bigint NOT NULL CHECK(max_amount_mmk BETWEEN 1 AND 1000000000),
 sync_grace_seconds int NOT NULL CHECK(sync_grace_seconds BETWEEN 0 AND 2592000), status text NOT NULL CHECK(status IN('DEFAULT_UNAPPROVED','OWNER_APPROVED')),
 auth_sha256 text, set_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK((status = 'OWNER_APPROVED') = (auth_sha256 IS NOT NULL)));
CREATE TABLE recovery_v1.keys (name text PRIMARY KEY, k bytea NOT NULL CHECK(octet_length(k) = 32));
CREATE TABLE recovery_v1.device_revocations (org_id text NOT NULL, device_id text NOT NULL, reason text NOT NULL, revoked_by text NOT NULL,
 revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(org_id, device_id));
CREATE TABLE recovery_v1.offline_capabilities (id uuid PRIMARY KEY, org_id text NOT NULL, shop_id text NOT NULL, device_id text NOT NULL, user_id text NOT NULL,
 offline_epoch int NOT NULL, policy_scope text NOT NULL, policy_status text NOT NULL, issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 sync_deadline timestamptz NOT NULL, max_ops int NOT NULL, max_amount_mmk bigint NOT NULL, allowed_ops text[] NOT NULL, document text NOT NULL, mac text NOT NULL);
CREATE INDEX offline_capabilities_user_issued ON recovery_v1.offline_capabilities(user_id, issued_at);
CREATE TABLE recovery_v1.offline_usage (capability_id uuid NOT NULL REFERENCES recovery_v1.offline_capabilities(id), op_key uuid NOT NULL,
 device_seq bigint NOT NULL CHECK(device_seq > 0), amount_mmk bigint NOT NULL DEFAULT 0, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(capability_id, op_key), UNIQUE(capability_id, device_seq));
INSERT INTO recovery_v1.keys VALUES ('offline-mac', decode(replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),'hex'));
-- Conservative TEST defaults (2 h, 30 operations, 1,000,000 MMK, 7 days to sync). They are NOT production policy: the
-- owner must sign one (set_offline_policy). Until then capabilities are issued only if the installer was explicitly told so.
INSERT INTO recovery_v1.settings VALUES (true, coalesce(p_offline_defaults, '') = 'allow-unapproved-test-defaults');
INSERT INTO recovery_v1.offline_policy(scope, max_lifetime_seconds, max_ops, max_amount_mmk, sync_grace_seconds, status) VALUES ('*', 7200, 30, 1000000, 604800, 'DEFAULT_UNAPPROVED');
IF coalesce(p_offline_defaults, '') NOT IN ('', 'allow-unapproved-test-defaults') THEN
 RAISE EXCEPTION 'RECOVERY_V1_OFFLINE_DEFAULTS_INVALID: only allow-unapproved-test-defaults is accepted';
END IF;
CREATE TABLE recovery_v1.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id text, kind text NOT NULL, detail jsonb NOT NULL,
 actor text NOT NULL DEFAULT session_user, at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO recovery_v1.audit(org_id,kind,detail) SELECT NULL,'installed',jsonb_build_object('organizations_restricted',(SELECT count(*) FROM recovery_v1.org_state),
 'install_ack',current_setting('orvix.recovery_v1_install_ack', true),'stage',(SELECT stage FROM recovery_v1.install),'reopen_path','none: independent owner authorization not provisioned',
 'migration_087_adopted',to_regnamespace('recovery') IS NOT NULL);
CREATE INDEX audit_org_kind_at ON recovery_v1.audit(org_id,kind,at);
CREATE TABLE recovery_v1.fences (
 key uuid PRIMARY KEY, org_id text NOT NULL, shop_id text NOT NULL, rpc text NOT NULL, actor_id text NOT NULL,
 incident text NOT NULL, preserved_evidence_sha256 text NOT NULL CHECK(preserved_evidence_sha256 ~ '^[a-f0-9]{64}$'),
 authorization_reference text NOT NULL, dependencies uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE recovery_v1.untrusted_evidence (
 org_id text NOT NULL, shop_id text NOT NULL, device_id text NOT NULL, key_id text NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), operation_id uuid NOT NULL, envelope jsonb NOT NULL,
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(org_id,hash), UNIQUE(org_id,device_id,key_id,sequence));
CREATE TABLE recovery_v1.untrusted_checkpoints (
 org_id text NOT NULL, shop_id text NOT NULL, witness_id text NOT NULL, stream_id text NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), receipt jsonb NOT NULL,
 stored_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(org_id,hash), UNIQUE(org_id,witness_id,stream_id,sequence));
COMMENT ON TABLE recovery_v1.untrusted_evidence IS 'Opaque original signed evidence; storage is NOT signature verification, enrollment, completeness or owner authority. Never log raw payloads.';
COMMENT ON TABLE recovery_v1.untrusted_checkpoints IS 'Opaque witness receipts; trust, independent verification and latest-boundary checks happen outside infrastructure. Storage never authorizes reopen.';

CREATE FUNCTION recovery_v1.immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'RECOVERY_V1_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END $$;
-- pins, the guarded-table registry, owner keys and offline policy change ONLY inside the transaction of an owner-authorized
-- operation of the matching purpose (authorized_txn row of THIS transaction, written by the verifying functions)
CREATE FUNCTION recovery_v1.registry_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM recovery_v1.pins) THEN RETURN coalesce(NEW, OLD); END IF;   -- during the install itself
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'RECOVERY_V1_REGISTRY_IMMUTABLE: %', TG_TABLE_NAME USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM recovery_v1.authorized_txn a WHERE a.txid = txid_current() AND a.purpose = TG_ARGV[0]) THEN
  RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_REQUIRED: % changes only inside an owner-authorized %', TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE='42501';
 END IF;
 RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER recovery_v1_registry BEFORE INSERT OR UPDATE OR DELETE ON recovery_v1.pins FOR EACH ROW EXECUTE FUNCTION recovery_v1.registry_guard('migration');
CREATE TRIGGER recovery_v1_registry BEFORE INSERT OR UPDATE OR DELETE ON recovery_v1.guarded_tables FOR EACH ROW EXECUTE FUNCTION recovery_v1.registry_guard('migration');
CREATE TRIGGER recovery_v1_registry BEFORE INSERT OR UPDATE OR DELETE ON recovery_v1.owner_keys FOR EACH ROW EXECUTE FUNCTION recovery_v1.registry_guard('enroll-owner-key');
CREATE TRIGGER recovery_v1_registry BEFORE INSERT OR UPDATE OR DELETE ON recovery_v1.offline_policy FOR EACH ROW EXECUTE FUNCTION recovery_v1.registry_guard('offline-policy');
CREATE TRIGGER recovery_v1_registry_truncate BEFORE TRUNCATE ON recovery_v1.pins FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.immutable();
CREATE TRIGGER recovery_v1_registry_truncate BEFORE TRUNCATE ON recovery_v1.guarded_tables FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.immutable();
CREATE TRIGGER recovery_v1_registry_truncate BEFORE TRUNCATE ON recovery_v1.owner_keys FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.immutable();
CREATE TRIGGER recovery_v1_registry_truncate BEFORE TRUNCATE ON recovery_v1.offline_policy FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.immutable();
-- usage rows are added at sync time and their amount grows within the syncing transaction; never deleted
CREATE FUNCTION recovery_v1.usage_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.capability_id, NEW.op_key, NEW.device_seq) IS NOT DISTINCT FROM (OLD.capability_id, OLD.op_key, OLD.device_seq)
    AND NEW.amount_mmk >= OLD.amount_mmk THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'RECOVERY_V1_EVIDENCE_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER recovery_v1_usage BEFORE UPDATE OR DELETE ON recovery_v1.offline_usage FOR EACH ROW EXECUTE FUNCTION recovery_v1.usage_guard();
CREATE TRIGGER recovery_v1_usage_truncate BEFORE TRUNCATE ON recovery_v1.offline_usage FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.immutable();
DO $immut$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['install','audit','fences','untrusted_evidence','untrusted_checkpoints','adapter_087','applied_migrations','owner_authorizations_used','settings','offline_capabilities','device_revocations','keys'] LOOP
  EXECUTE format('CREATE TRIGGER recovery_v1_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON recovery_v1.%I FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.immutable()',t);
  EXECUTE format('ALTER TABLE recovery_v1.%I ENABLE ALWAYS TRIGGER recovery_v1_immutable',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['pins','guarded_tables','owner_keys','offline_policy','offline_usage'] LOOP
  EXECUTE format('ALTER TABLE recovery_v1.%I ENABLE ALWAYS TRIGGER %I',t,CASE t WHEN 'offline_usage' THEN 'recovery_v1_usage' ELSE 'recovery_v1_registry' END);
  EXECUTE format('ALTER TABLE recovery_v1.%I ENABLE ALWAYS TRIGGER %I',t,CASE t WHEN 'offline_usage' THEN 'recovery_v1_usage_truncate' ELSE 'recovery_v1_registry_truncate' END);
 END LOOP;
END $immut$;
-- 087 disables EVERY event trigger before it runs (087_recovery_hold.sql:63-75), so the DDL
-- event trigger alone cannot keep 087 out. Every guarded row write and every status read
-- therefore re-checks the installation itself and fails closed when it is broken: event
-- trigger not enabled ALWAYS, the install record missing, an 087 schema present that the
-- adapter did not adopt at install (087 applied AFTER V1), or an adopted 087 whose schemas were
-- replaced or removed or whose DDL guard is no longer enabled ALWAYS. (The full 087 catalog
-- fingerprint is compared on every DDL command by ddl_guard below; this per-row check is cheap.)
CREATE FUNCTION recovery_v1.v1_catalog_state() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT md5(concat_ws('|',
   (SELECT string_agg(p.oid::text||':'||p.xmin::text, ',' ORDER BY p.oid) FROM pg_proc p WHERE p.pronamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(c.oid::text||':'||c.relname||':'||c.relkind::text||':'||c.relowner::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text||c.relforcerowsecurity::text, ',' ORDER BY c.oid)
      FROM pg_class c WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(t.oid::text||':'||t.xmin::text||':'||t.tgenabled::text, ',' ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(o.oid::text||':'||o.xmin::text, ',' ORDER BY o.oid) FROM pg_policy o JOIN pg_class c ON c.oid = o.polrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(w.oid::text||':'||w.xmin::text, ',' ORDER BY w.oid) FROM pg_rewrite w JOIN pg_class c ON c.oid = w.ev_class WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(k.oid::text||':'||k.xmin::text, ',' ORDER BY k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(d.oid::text||':'||d.xmin::text, ',' ORDER BY d.oid) FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(a.attrelid::text||'.'||a.attnum::text||':'||a.xmin::text, ',' ORDER BY a.attrelid, a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'recovery_v1'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0),
   (SELECT n.nspowner::text||':'||coalesce(n.nspacl::text,'') FROM pg_namespace n WHERE n.nspname = 'recovery_v1'))) $$;
CREATE FUNCTION recovery_v1.integrity_problem() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE
  WHEN NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='zz_recovery_v1_ddl' AND evtenabled='A') THEN 'ddl_guard_not_enabled'
  WHEN NOT EXISTS(SELECT 1 FROM recovery_v1.install) THEN 'install_record_missing'
  WHEN NOT EXISTS(SELECT 1 FROM recovery_v1.pins) THEN 'install_pins_missing'
  -- every pinned event trigger row is still exactly the row the install recorded (same oid, function,
  -- no tags, enabled ALWAYS, same row version): any disable/enable/replace window leaves a new xmin
  WHEN EXISTS(SELECT 1 FROM recovery_v1.pins p CROSS JOIN LATERAL jsonb_array_elements(p.event_triggers) x
               WHERE NOT EXISTS(SELECT 1 FROM pg_event_trigger e WHERE e.oid=(x->>'oid')::oid AND e.evtname=x->>'name' AND e.evtfoid=(x->>'foid')::oid
                                  AND e.evttags IS NULL AND e.evtenabled='A' AND e.xmin::text=x->>'xmin')) THEN 'event_trigger_changed'
  WHEN EXISTS(SELECT 1 FROM recovery_v1.pins p WHERE p.guard_triggers IS DISTINCT FROM recovery_v1.guard_triggers_state(p.public_tables)) THEN 'guard_trigger_changed'
  WHEN EXISTS(SELECT 1 FROM recovery_v1.pins p WHERE p.v1_catalog IS DISTINCT FROM md5(concat_ws('|',
   (SELECT string_agg(p.oid::text||':'||p.xmin::text, ',' ORDER BY p.oid) FROM pg_proc p WHERE p.pronamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(c.oid::text||':'||c.relname||':'||c.relkind::text||':'||c.relowner::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text||c.relforcerowsecurity::text, ',' ORDER BY c.oid)
      FROM pg_class c WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(t.oid::text||':'||t.xmin::text||':'||t.tgenabled::text, ',' ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(o.oid::text||':'||o.xmin::text, ',' ORDER BY o.oid) FROM pg_policy o JOIN pg_class c ON c.oid = o.polrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(w.oid::text||':'||w.xmin::text, ',' ORDER BY w.oid) FROM pg_rewrite w JOIN pg_class c ON c.oid = w.ev_class WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(k.oid::text||':'||k.xmin::text, ',' ORDER BY k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(d.oid::text||':'||d.xmin::text, ',' ORDER BY d.oid) FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(a.attrelid::text||'.'||a.attnum::text||':'||a.xmin::text, ',' ORDER BY a.attrelid, a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'recovery_v1'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0),
   (SELECT n.nspowner::text||':'||coalesce(n.nspacl::text,'') FROM pg_namespace n WHERE n.nspname = 'recovery_v1')))) THEN 'recovery_v1_catalog_changed'
  WHEN NOT EXISTS(SELECT 1 FROM recovery_v1.adapter_087) THEN
   CASE WHEN to_regnamespace('recovery') IS NOT NULL OR to_regnamespace('recovery_guard') IS NOT NULL THEN 'migration_087_present_adapter_required' END
  WHEN NOT EXISTS(SELECT 1 FROM recovery_v1.adapter_087 a WHERE a.recovery_nsp=to_regnamespace('recovery')::oid AND a.guard_nsp=to_regnamespace('recovery_guard')::oid)
   THEN 'migration_087_changed_or_removed'
  WHEN NOT EXISTS(SELECT 1 FROM recovery_v1.adapter_087 a JOIN pg_event_trigger e ON e.oid=a.ddl_evt WHERE e.evtname='zz_recovery_ddl_guard' AND e.evtenabled='A')
   THEN 'migration_087_ddl_guard_not_enabled'
 END $$;
CREATE FUNCTION recovery_v1.require_target(p_database text,p_system_identifier text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM recovery_v1.install i WHERE i.database_name=current_database() AND i.database_name=p_database AND i.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND i.system_identifier=p_system_identifier AND i.system_identifier=(SELECT system_identifier::text FROM pg_control_system())) THEN RAISE EXCEPTION 'RECOVERY_V1_TARGET_MISMATCH' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION recovery_v1.caller() RETURNS public.users LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users;
BEGIN
 SELECT * INTO u FROM public.users WHERE auth_id=auth.uid() AND is_active;
 IF u.id IS NULL OR u.org_id IS NULL THEN RAISE EXCEPTION 'RECOVERY_V1_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN u;
END $$;
CREATE FUNCTION recovery_v1.deny(p_org text,p_kind text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 -- PostgreSQL table writes in an aborted transaction roll back. Server LOG is
 -- the durable denial channel; independent log shipping remains a prerequisite.
 RAISE LOG 'ORVIX_RECOVERY_V1_DENIED %',jsonb_build_object('org_id',p_org,'kind',p_kind,'session_user',session_user,'at',clock_timestamp());
 RAISE EXCEPTION 'ORG_SUSPENDED: recovery evidence unresolved [%]',p_kind USING ERRCODE='PT503';
END $$;
-- ------------------------------------------------------------ Step 4: primitives (pg_catalog built-ins only)
CREATE FUNCTION recovery_v1.hmac_sha256(p_msg bytea, p_key bytea) RETURNS bytea LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k bytea := p_key; ipad bytea; opad bytea; i int;
BEGIN
 IF length(k) > 64 THEN k := sha256(k); END IF;
 k := k || decode(repeat('00', 64 - length(k)), 'hex');
 ipad := k; opad := k;
 FOR i IN 0..63 LOOP ipad := set_byte(ipad, i, get_byte(k, i) # 54); opad := set_byte(opad, i, get_byte(k, i) # 92); END LOOP;
 RETURN sha256(opad || sha256(ipad || p_msg));
END $$;
-- exact big-integer helpers on numeric (no floating point anywhere)
CREATE FUNCTION recovery_v1.hex_to_numeric(p_hex text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE v numeric := 0; i int; h text := lower(p_hex); c text;
BEGIN
 IF h !~ '^[0-9a-f]+$' THEN RAISE EXCEPTION 'RECOVERY_V1_BAD_HEX'; END IF;
 i := 1;
 WHILE i <= length(h) LOOP
  c := substr(h, i, 6);
  v := v * (16::numeric ^ length(c)) + ('x' || lpad(c, 8, '0'))::bit(32)::bigint;
  i := i + 6;
 END LOOP;
 RETURN v;
END $$;
CREATE FUNCTION recovery_v1.numeric_to_hex(p_v numeric, p_bytes int) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE v numeric := p_v; out text := ''; d bigint;
BEGIN
 IF v < 0 THEN RAISE EXCEPTION 'RECOVERY_V1_BAD_NUMBER'; END IF;
 WHILE v > 0 LOOP
  d := mod(v, 16777216)::bigint;
  out := lpad(to_hex(d), 6, '0') || out;
  v := div(v, 16777216);
 END LOOP;
 out := ltrim(out, '0');
 IF length(out) > p_bytes * 2 THEN RETURN NULL; END IF;     -- does not fit: never equal to an encoded message
 RETURN lpad(out, p_bytes * 2, '0');
END $$;
CREATE FUNCTION recovery_v1.modexp(p_b numeric, p_e numeric, p_m numeric) RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE r numeric := 1; b numeric := mod(p_b, p_m); e numeric := p_e;
BEGIN
 WHILE e > 0 LOOP
  IF mod(e, 2) = 1 THEN r := mod(r * b, p_m); END IF;
  e := div(e, 2);
  IF e > 0 THEN b := mod(b * b, p_m); END IF;
 END LOOP;
 RETURN r;
END $$;
-- RSASSA-PKCS1-v1_5 with SHA-256 (RFC 8017 8.2.2): s^e mod n == 0x00 01 FF..FF 00 || DigestInfo(SHA-256) || H(msg)
CREATE FUNCTION recovery_v1.rsa_verify(p_n numeric, p_e numeric, p_msg bytea, p_sig_hex text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k int; s numeric; t text; em text; m text;
BEGIN
 IF p_sig_hex IS NULL OR p_sig_hex !~ '^[0-9a-f]+$' OR p_n IS NULL OR p_e IS NULL OR p_msg IS NULL THEN RETURN false; END IF;
 k := ceil(length(ltrim(recovery_v1.numeric_to_hex(p_n, 1024), '0')) / 2.0)::int;
 IF length(p_sig_hex) <> 2 * k THEN RETURN false; END IF;
 s := recovery_v1.hex_to_numeric(p_sig_hex);
 IF s >= p_n THEN RETURN false; END IF;
 m := recovery_v1.numeric_to_hex(recovery_v1.modexp(s, p_e, p_n), k);
 t := '3031300d060960864801650304020105000420' || encode(sha256(p_msg), 'hex');
 IF k * 2 < length(t) + 22 THEN RETURN false; END IF;
 em := '0001' || repeat('ff', k - 3 - length(t) / 2) || '00' || t;
 RETURN m IS NOT NULL AND m = em;
END $$;
CREATE FUNCTION recovery_v1.owner_key_fingerprint(p_n numeric, p_e numeric) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(sha256(convert_to(ltrim(recovery_v1.numeric_to_hex(p_n, 1024), '0') || ':' || p_e::text, 'UTF8')), 'hex') $$;
-- one key document {"keyId","n":"<hex>","e":65537} -> a row value (validated)
CREATE FUNCTION recovery_v1.parse_owner_key(p_doc jsonb, OUT key_id text, OUT n numeric, OUT e numeric, OUT bits int) LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 key_id := p_doc->>'keyId';
 IF key_id IS NULL OR key_id !~ '^[A-Za-z0-9._-]{1,64}$' OR coalesce(p_doc->>'n', '') !~ '^[0-9a-fA-F]+$' OR jsonb_typeof(p_doc->'e') <> 'number' THEN
  RAISE EXCEPTION 'RECOVERY_V1_OWNER_KEY_INVALID: expected {"keyId","n":"<hex modulus>","e":65537}';
 END IF;
 -- exactly e = 65537 (written as that integer: another spelling would give the same key a second fingerprint)
 IF p_doc->>'e' IS DISTINCT FROM '65537' THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_KEY_INVALID: e = 65537 required'; END IF;
 n := recovery_v1.hex_to_numeric(p_doc->>'n'); e := 65537;
 -- the exact bit length (a 2045-bit modulus is not a 2048-bit key)
 bits := (length(ltrim(lower(p_doc->>'n'), '0')) - 1) * 4
         + CASE WHEN substr(ltrim(lower(p_doc->>'n'), '0'), 1, 1) IN ('8','9','a','b','c','d','e','f') THEN 4
                WHEN substr(ltrim(lower(p_doc->>'n'), '0'), 1, 1) IN ('4','5','6','7') THEN 3
                WHEN substr(ltrim(lower(p_doc->>'n'), '0'), 1, 1) IN ('2','3') THEN 2 ELSE 1 END;
 IF bits < 2048 OR bits > 8192 OR mod(n, 2) = 0 THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_KEY_INVALID: RSA modulus of 2048 to 8192 bits required'; END IF;
END $$;

-- the owner's public key given at install (optional; without one, no owner-authorized change is ever possible)
IF coalesce(p_owner_key, '') <> '' THEN
 INSERT INTO recovery_v1.owner_keys(key_id, n, e, bits, fingerprint, enrolled_via)
 SELECT k.key_id, k.n, k.e, k.bits, recovery_v1.owner_key_fingerprint(k.n, k.e), 'install' FROM recovery_v1.parse_owner_key(p_owner_key::jsonb) k;
END IF;
-- ------------------------------------------------------------ Step 4: owner authorizations (independent of this server)
-- An owner authorization is a UTF-8 JSON document signed OUTSIDE this server with an enrolled owner key. It is single-use
-- (nonce), bound to this database (name + system identifier + V1 install time), valid only between issuedAt and expiresAt,
-- and for exactly one purpose. This server can verify it; it can never create one (it holds no private key).
CREATE FUNCTION recovery_v1.owner_authorization(p_auth text, p_sig text, p_purpose text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a jsonb; k recovery_v1.owner_keys; i recovery_v1.install; v_iat timestamptz; v_exp timestamptz; v_nonce uuid;
BEGIN
 IF (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) IS NOT TRUE THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_RUNNER: superuser runner session required' USING ERRCODE='42501'; END IF;
 IF octet_length(coalesce(p_auth, '')) NOT BETWEEN 2 AND 65536 THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: missing or oversized'; END IF;
 BEGIN a := p_auth::jsonb; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: not JSON'; END;
 IF jsonb_typeof(a) <> 'object' OR a->>'protocol' IS DISTINCT FROM 'orvix-owner-authorization-v1' OR a->>'purpose' IS DISTINCT FROM p_purpose THEN
  RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: wrong protocol or purpose (expected %)', p_purpose;
 END IF;
 SELECT * INTO k FROM recovery_v1.owner_keys WHERE key_id = a->>'keyId';
 IF k.key_id IS NULL THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: unknown owner key'; END IF;
 IF k.retired_at IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: owner key retired'; END IF;
 IF NOT recovery_v1.rsa_verify(k.n, k.e, convert_to(p_auth, 'UTF8'), lower(coalesce(p_sig, ''))) THEN
  RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: signature does not verify';
 END IF;
 SELECT * INTO i FROM recovery_v1.install;
 IF a#>>'{target,database}' IS DISTINCT FROM current_database() OR a#>>'{target,systemIdentifier}' IS DISTINCT FROM (SELECT system_identifier::text FROM pg_control_system())
    OR a#>>'{target,recoveryV1InstalledAt}' IS DISTINCT FROM to_char(i.installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') THEN
  RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_TARGET: this authorization is for another database';
 END IF;
 -- only explicit UTC instants ('today', 'now', 'tomorrow' or a zone-less time would make the window float)
 IF coalesce(a->>'issuedAt', '') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$' OR coalesce(a->>'expiresAt', '') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$' THEN
  RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: issuedAt / expiresAt must be UTC instants (YYYY-MM-DDTHH:MM:SS[.ffffff]Z)';
 END IF;
 BEGIN v_iat := (a->>'issuedAt')::timestamptz; v_exp := (a->>'expiresAt')::timestamptz; v_nonce := (a->>'nonce')::uuid;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: issuedAt / expiresAt / nonce'; END;
 IF v_iat IS NULL OR v_exp IS NULL OR v_nonce IS NULL OR v_exp <= v_iat OR v_exp - v_iat > interval '7 days' THEN
  RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_INVALID: validity window (at most 7 days)';
 END IF;
 IF clock_timestamp() < v_iat - interval '5 minutes' OR clock_timestamp() >= v_exp THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_EXPIRED: outside its validity window'; END IF;
 INSERT INTO recovery_v1.owner_authorizations_used(nonce, purpose, key_id, auth_sha256, authorization_text, signature)
 VALUES (v_nonce, p_purpose, k.key_id, encode(sha256(convert_to(p_auth, 'UTF8')), 'hex'), p_auth, lower(p_sig))
 ON CONFLICT (nonce) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_V1_OWNER_AUTHORIZATION_REPLAY: this authorization was already used'; END IF;
 RETURN a;
END $$;

-- enroll (rotate) an owner key: authorized by an EXISTING owner key
CREATE FUNCTION recovery_v1.enroll_owner_key(p_auth text, p_sig text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a jsonb; nk record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('recovery_v1:owner-authorized'));
 a := recovery_v1.owner_authorization(p_auth, p_sig, 'enroll-owner-key');
 SELECT * INTO nk FROM recovery_v1.parse_owner_key(a->'newKey');
 INSERT INTO recovery_v1.authorized_txn(txid, purpose, ref) VALUES (txid_current(), 'enroll-owner-key', nk.key_id);
 INSERT INTO recovery_v1.owner_keys(key_id, n, e, bits, fingerprint, enrolled_via) VALUES (nk.key_id, nk.n, nk.e, nk.bits, recovery_v1.owner_key_fingerprint(nk.n, nk.e), 'owner-authorization');
 IF a ? 'retireKeyId' THEN UPDATE recovery_v1.owner_keys SET retired_at = clock_timestamp() WHERE key_id = a->>'retireKeyId' AND retired_at IS NULL AND key_id <> nk.key_id; END IF;
 DELETE FROM recovery_v1.authorized_txn WHERE txid = txid_current();
 INSERT INTO recovery_v1.audit(org_id, kind, detail) VALUES (NULL, 'owner_key_enrolled', jsonb_build_object('keyId', nk.key_id, 'byKey', a->>'keyId', 'retired', a->>'retireKeyId'));
 RETURN jsonb_build_object('outcome', 'enrolled', 'keyId', nk.key_id, 'fingerprint', recovery_v1.owner_key_fingerprint(nk.n, nk.e));
END $$;

-- the offline exposure policy, signed by the owner ({"scope":"*" or an org id, maxLifetimeSeconds, maxOps, maxAmountMmk, syncGraceSeconds})
CREATE FUNCTION recovery_v1.set_offline_policy(p_auth text, p_sig text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a jsonb; p jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('recovery_v1:owner-authorized'));
 a := recovery_v1.owner_authorization(p_auth, p_sig, 'offline-policy');
 p := a->'policy';
 IF p IS NULL OR p->>'scope' IS NULL OR (p->>'scope' <> '*' AND NOT EXISTS(SELECT 1 FROM public.organizations WHERE id = p->>'scope')) THEN
  RAISE EXCEPTION 'RECOVERY_V1_OFFLINE_POLICY_INVALID: scope must be * or an organization';
 END IF;
 INSERT INTO recovery_v1.authorized_txn(txid, purpose, ref) VALUES (txid_current(), 'offline-policy', p->>'scope');
 INSERT INTO recovery_v1.offline_policy(scope, max_lifetime_seconds, max_ops, max_amount_mmk, sync_grace_seconds, status, auth_sha256, set_at)
 VALUES (p->>'scope', (p->>'maxLifetimeSeconds')::int, (p->>'maxOps')::int, (p->>'maxAmountMmk')::bigint, (p->>'syncGraceSeconds')::int, 'OWNER_APPROVED',
         encode(sha256(convert_to(p_auth, 'UTF8')), 'hex'), clock_timestamp())
 ON CONFLICT (scope) DO UPDATE SET max_lifetime_seconds = EXCLUDED.max_lifetime_seconds, max_ops = EXCLUDED.max_ops, max_amount_mmk = EXCLUDED.max_amount_mmk,
   sync_grace_seconds = EXCLUDED.sync_grace_seconds, status = EXCLUDED.status, auth_sha256 = EXCLUDED.auth_sha256, set_at = EXCLUDED.set_at;
 DELETE FROM recovery_v1.authorized_txn WHERE txid = txid_current();
 INSERT INTO recovery_v1.audit(org_id, kind, detail) VALUES (nullif(p->>'scope', '*'), 'offline_policy_set', p || jsonb_build_object('byKey', a->>'keyId'));
 RETURN jsonb_build_object('outcome', 'set', 'policy', p);
END $$;

-- ------------------------------------------------------------ Step 4: offline capabilities (Part B)
-- A capability lets ONE device of ONE cashier of ONE shop record a bounded number / value of eligible financial operations
-- while disconnected. The server is the verifier: at sync it re-checks the stored capability (MAC), the device, the
-- organization's current state and offline epoch, and the cumulative count and value. A till's clock is never trusted.
CREATE FUNCTION recovery_v1.offline_policy_for(p_org text) RETURNS recovery_v1.offline_policy LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT * FROM recovery_v1.offline_policy WHERE scope IN (p_org, '*') ORDER BY (scope = '*') LIMIT 1 $$;
CREATE FUNCTION recovery_v1.issue_offline_capability(p_org_id text, p_shop_id text, p_device_id text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; st jsonb; pol recovery_v1.offline_policy; v_id uuid := gen_random_uuid(); v_now timestamptz := clock_timestamp(); d jsonb; v_epoch int;
BEGIN
 u := recovery_v1.caller();
 IF p_org_id IS DISTINCT FROM u.org_id THEN RAISE EXCEPTION 'RECOVERY_V1_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_device_id IS NULL OR p_device_id !~ '^[A-Za-z0-9._:-]{8,128}$' THEN RAISE EXCEPTION 'RECOVERY_V1_OFFLINE_DEVICE_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.shops WHERE id = p_shop_id AND org_id = u.org_id) OR (u.role <> 'ADMIN' AND u.shop_id IS DISTINCT FROM p_shop_id) THEN
  RAISE EXCEPTION 'RECOVERY_V1_OFFLINE_SHOP_INVALID' USING ERRCODE='42501';
 END IF;
 -- the same answer the status endpoint gives (integrity, V1 state, and an adopted 087's hold)
 st := recovery_v1.status(u.org_id);
 IF st->>'state' IS DISTINCT FROM 'ACTIVE' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'organization_not_active', 'state', st->>'state');
 END IF;
 IF EXISTS(SELECT 1 FROM recovery_v1.device_revocations WHERE org_id = u.org_id AND device_id = p_device_id) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'device_revoked');
 END IF;
 pol := recovery_v1.offline_policy_for(u.org_id);
 IF pol.status <> 'OWNER_APPROVED' AND NOT (SELECT offline_unapproved_defaults FROM recovery_v1.settings) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'offline_policy_not_approved');
 END IF;
 IF (SELECT count(*) FROM recovery_v1.offline_capabilities WHERE user_id = u.id AND issued_at > v_now - interval '1 hour') >= 30 THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'rate_limited');
 END IF;
 SELECT offline_epoch INTO v_epoch FROM recovery_v1.org_state WHERE org_id = u.org_id;
 d := jsonb_build_object('protocol', 'orvix-offline-capability-v1', 'id', v_id, 'orgId', u.org_id, 'shopId', p_shop_id, 'deviceId', p_device_id, 'userId', u.id,
   'offlineEpoch', v_epoch, 'policyScope', pol.scope, 'policyStatus', pol.status,
   'issuedAt', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'expiresAt', to_char((v_now + make_interval(secs => pol.max_lifetime_seconds)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'syncDeadline', to_char((v_now + make_interval(secs => pol.max_lifetime_seconds + pol.sync_grace_seconds)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'maxOps', pol.max_ops, 'maxAmountMmk', pol.max_amount_mmk, 'allowedOps', jsonb_build_array('complete_sale', 'fin_complete_sale_split'));
 INSERT INTO recovery_v1.offline_capabilities(id, org_id, shop_id, device_id, user_id, offline_epoch, policy_scope, policy_status, issued_at, expires_at, sync_deadline,
   max_ops, max_amount_mmk, allowed_ops, document, mac)
 VALUES (v_id, u.org_id, p_shop_id, p_device_id, u.id, v_epoch, pol.scope, pol.status, v_now, v_now + make_interval(secs => pol.max_lifetime_seconds),
   v_now + make_interval(secs => pol.max_lifetime_seconds + pol.sync_grace_seconds), pol.max_ops, pol.max_amount_mmk, ARRAY['complete_sale', 'fin_complete_sale_split'],
   d::text, encode(recovery_v1.hmac_sha256(convert_to(d::text, 'UTF8'), (SELECT k FROM recovery_v1.keys WHERE name = 'offline-mac')), 'hex'));
 RETURN jsonb_build_object('outcome', 'issued', 'capability', d, 'serverTime', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;
CREATE FUNCTION recovery_v1.revoke_device(p_org_id text, p_device_id text, p_reason text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users;
BEGIN
 u := recovery_v1.caller();
 IF p_org_id IS DISTINCT FROM u.org_id OR u.role <> 'ADMIN' THEN RAISE EXCEPTION 'RECOVERY_V1_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_device_id IS NULL OR p_device_id !~ '^[A-Za-z0-9._:-]{8,128}$' OR length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 300 THEN
  RAISE EXCEPTION 'RECOVERY_V1_OFFLINE_DEVICE_INVALID' USING ERRCODE='22023';
 END IF;
 INSERT INTO recovery_v1.device_revocations(org_id, device_id, reason, revoked_by) VALUES (u.org_id, p_device_id, btrim(p_reason), u.id) ON CONFLICT DO NOTHING;
 INSERT INTO recovery_v1.audit(org_id, kind, detail) VALUES (u.org_id, 'device_revoked', jsonb_build_object('deviceId', p_device_id, 'by', u.id));
 RETURN jsonb_build_object('outcome', 'revoked', 'deviceId', p_device_id);
END $$;
-- sync-time check of an operation that a till recorded OFFLINE (request header x-orvix-offline:
-- {"capabilityId":"<uuid>","deviceSeq":n}); NULL = accepted, else the reason the operation is held for review
CREATE FUNCTION recovery_v1.offline_problem(p_org text, p_key uuid, p_amount bigint, p_rpc text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE h jsonb; d jsonb; c recovery_v1.offline_capabilities; u public.users; v_seq bigint; v_n int; v_sum bigint; v_cap uuid;
BEGIN
 BEGIN h := nullif(current_setting('request.headers', true), '')::jsonb -> 'x-orvix-offline';
       IF jsonb_typeof(h) = 'string' THEN h := (h #>> '{}')::jsonb; END IF;
 EXCEPTION WHEN OTHERS THEN RETURN 'offline_header_invalid'; END;
 IF h IS NULL OR jsonb_typeof(h) = 'null' THEN RETURN NULL; END IF;        -- an online operation
 BEGIN v_cap := (h->>'capabilityId')::uuid; v_seq := (h->>'deviceSeq')::bigint; EXCEPTION WHEN OTHERS THEN RETURN 'offline_header_invalid'; END;
 -- one sync of a capability at a time (concurrent syncs would each count only their own usage)
 SELECT * INTO c FROM recovery_v1.offline_capabilities WHERE id = v_cap FOR UPDATE;
 IF c.id IS NULL OR v_seq IS NULL OR v_seq < 1 THEN RETURN 'offline_capability_unknown'; END IF;
 IF p_rpc IS NULL OR NOT (p_rpc = ANY (c.allowed_ops)) THEN RETURN 'offline_operation_not_allowed'; END IF;
 -- the stored row must be exactly the document the server MAC'd at issuance (a superuser who copies or edits a row cannot
 -- re-bind another capability's document to it)
 d := c.document::jsonb;
 IF c.mac IS DISTINCT FROM encode(recovery_v1.hmac_sha256(convert_to(c.document, 'UTF8'), (SELECT k FROM recovery_v1.keys WHERE name = 'offline-mac')), 'hex')
    OR d->>'id' IS DISTINCT FROM c.id::text OR d->>'orgId' IS DISTINCT FROM c.org_id OR d->>'userId' IS DISTINCT FROM c.user_id OR d->>'deviceId' IS DISTINCT FROM c.device_id
    OR d->>'shopId' IS DISTINCT FROM c.shop_id OR (d->>'offlineEpoch')::int IS DISTINCT FROM c.offline_epoch OR (d->>'maxOps')::int IS DISTINCT FROM c.max_ops
    OR (d->>'maxAmountMmk')::bigint IS DISTINCT FROM c.max_amount_mmk
    OR abs(extract(epoch FROM (d->>'syncDeadline')::timestamptz - c.sync_deadline)) > 0.001 THEN
  RETURN 'offline_capability_integrity';
 END IF;
 u := recovery_v1.caller();
 IF c.org_id IS DISTINCT FROM p_org OR c.user_id IS DISTINCT FROM u.id THEN RETURN 'offline_capability_binding'; END IF;
 IF EXISTS(SELECT 1 FROM recovery_v1.device_revocations WHERE org_id = c.org_id AND device_id = c.device_id) THEN RETURN 'offline_device_revoked'; END IF;
 IF c.offline_epoch IS DISTINCT FROM (SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id = c.org_id) THEN RETURN 'offline_capability_stale_epoch'; END IF;
 IF clock_timestamp() > c.sync_deadline THEN RETURN 'offline_capability_sync_deadline'; END IF;
 INSERT INTO recovery_v1.offline_usage(capability_id, op_key, device_seq, amount_mmk) VALUES (c.id, p_key, v_seq, greatest(coalesce(p_amount, 0), 0))
 ON CONFLICT (capability_id, op_key) DO UPDATE SET amount_mmk = recovery_v1.offline_usage.amount_mmk + greatest(coalesce(EXCLUDED.amount_mmk, 0), 0);
 SELECT count(*), coalesce(sum(amount_mmk), 0) INTO v_n, v_sum FROM recovery_v1.offline_usage WHERE capability_id = c.id;
 IF v_n > c.max_ops THEN RETURN 'offline_exposure_ops'; END IF;
 IF v_sum > c.max_amount_mmk THEN RETURN 'offline_exposure_amount'; END IF;
 RETURN NULL;
EXCEPTION WHEN unique_violation THEN RETURN 'offline_device_sequence_reused';
END $$;

-- ------------------------------------------------------------ Step 4: owner-authorized migrations after V1 (Part C)
-- The chain head: genesis is bound to this exact V1 install; each applied migration extends it.
CREATE FUNCTION recovery_v1.migration_chain_head() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce((SELECT chain_head FROM recovery_v1.applied_migrations ORDER BY seq DESC LIMIT 1),
   (SELECT encode(sha256(convert_to('orvix-recovery-v1-genesis:' || i.database_name || ':' || i.system_identifier || ':' ||
      to_char(i.installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')), 'hex') FROM recovery_v1.install i)) $$;
-- What an owner needs to write an authorization for THIS database (read-only; superuser runner).
CREATE FUNCTION recovery_v1.authorization_target() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('database', current_database(), 'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
   'recoveryV1InstalledAt', (SELECT to_char(installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM recovery_v1.install),
   'migrationChainHead', recovery_v1.migration_chain_head(),
   'ownerKeys', coalesce((SELECT jsonb_agg(jsonb_build_object('keyId', key_id, 'fingerprint', fingerprint, 'retired', retired_at IS NOT NULL) ORDER BY key_id) FROM recovery_v1.owner_keys), '[]')) $$;
-- Apply ONE reviewed migration after V1. Everything happens in the caller's single transaction: an interruption or any
-- failed check rolls back the whole migration, its guards, pins and chain entry; the last completed step is written to the
-- server log (RAISE LOG 'RECOVERY_V1_MIGRATION <id> step ...'). Recovery restrictions stay in force throughout: the row
-- guards never stop firing, and the DDL guard enforces the authorized scope.
CREATE FUNCTION recovery_v1.apply_authorized_migration(p_auth text, p_sig text, p_sql text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a jsonb; m jsonb; v_id text; v_head text; v_new text[]; v_cmds text[]; v_t text; v_rel oid; v_entry text; v_newhead text; v_tables oid[];
  v_before_tables oid[]; v_before_funcs oid[]; v_snap_before text; v_snap_after text; v_user text := current_user; v_session text := session_user;
BEGIN
 -- one migration at a time (a concurrent attempt waits, then fails its predecessor check)
 PERFORM pg_advisory_xact_lock(hashtext('recovery_v1:owner-authorized'));
 IF recovery_v1.integrity_problem() IS NOT NULL THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_REFUSED: recovery protection is not intact (%); repair it first', recovery_v1.integrity_problem();
 END IF;
 a := recovery_v1.owner_authorization(p_auth, p_sig, 'migration');
 m := a->'migration';
 v_id := m->>'id';
 IF v_id IS NULL OR v_id !~ '^[A-Za-z0-9._-]{3,100}$' THEN RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_INVALID: migration id'; END IF;
 RAISE LOG 'RECOVERY_V1_MIGRATION % step verified-signature', v_id;
 IF p_sql IS NULL OR m->>'sqlSha256' IS DISTINCT FROM encode(sha256(convert_to(p_sql, 'UTF8')), 'hex') THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_CHECKSUM: the SQL is not the reviewed SQL this authorization names';
 END IF;
 v_head := recovery_v1.migration_chain_head();
 IF m->>'predecessor' IS DISTINCT FROM v_head THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_ORDER: this authorization follows %, the database is at %', m->>'predecessor', v_head;
 END IF;
 IF EXISTS(SELECT 1 FROM recovery_v1.applied_migrations WHERE migration_id = v_id) THEN RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_ORDER: % was already applied', v_id; END IF;
 v_cmds := ARRAY(SELECT jsonb_array_elements_text(coalesce(m->'allowedCommands', '[]')));
 v_new := ARRAY(SELECT jsonb_array_elements_text(coalesce(m->'newTables', '[]')));
 IF EXISTS(SELECT 1 FROM unnest(v_new) x WHERE x !~ '^[a-z][a-z0-9_]{0,62}$' OR to_regclass('public.' || x) IS NOT NULL) THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_INVALID: new tables must be new, lower-case names';
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(v_cmds) x WHERE x IN ('CREATE EVENT TRIGGER','ALTER EVENT TRIGGER','DROP EVENT TRIGGER','CREATE EXTENSION','ALTER EXTENSION','DROP EXTENSION',
            'CREATE ROLE','ALTER ROLE','DROP ROLE','ALTER DEFAULT PRIVILEGES','DROP TABLE','DROP SCHEMA','ALTER SCHEMA','DROP OWNED','REASSIGN OWNED','DROP TRIGGER','ALTER TRIGGER')) THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_INVALID: an authorized migration never lists %', (SELECT string_agg(x, ', ') FROM unnest(v_cmds) x WHERE x IN ('CREATE EVENT TRIGGER','ALTER EVENT TRIGGER','DROP EVENT TRIGGER','CREATE EXTENSION','ALTER EXTENSION','DROP EXTENSION','CREATE ROLE','ALTER ROLE','DROP ROLE','ALTER DEFAULT PRIVILEGES','DROP TABLE','DROP SCHEMA','ALTER SCHEMA','DROP OWNED','REASSIGN OWNED','DROP TRIGGER','ALTER TRIGGER'));
 END IF;
 v_entry := recovery_v1.entry_fingerprint();
 INSERT INTO recovery_v1.authorized_txn(txid, purpose, ref, allowed_commands, new_tables) VALUES (txid_current(), 'migration', v_id, v_cmds, v_new);
 -- the state the SQL may not touch, computed by queries written into THIS function's body (the SQL can replace other
 -- functions, never the code already running here)
 v_before_tables := ARRAY(SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','f','m','v'));
 v_before_funcs := ARRAY(SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace);
 SELECT concat_ws(E'\n',
   md5(concat_ws('|',
   (SELECT string_agg(p.oid::text||':'||p.xmin::text, ',' ORDER BY p.oid) FROM pg_proc p WHERE p.pronamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(c.oid::text||':'||c.relname||':'||c.relkind::text||':'||c.relowner::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text||c.relforcerowsecurity::text, ',' ORDER BY c.oid)
      FROM pg_class c WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(t.oid::text||':'||t.xmin::text||':'||t.tgenabled::text, ',' ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(o.oid::text||':'||o.xmin::text, ',' ORDER BY o.oid) FROM pg_policy o JOIN pg_class c ON c.oid = o.polrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(w.oid::text||':'||w.xmin::text, ',' ORDER BY w.oid) FROM pg_rewrite w JOIN pg_class c ON c.oid = w.ev_class WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(k.oid::text||':'||k.xmin::text, ',' ORDER BY k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(d.oid::text||':'||d.xmin::text, ',' ORDER BY d.oid) FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(a.attrelid::text||'.'||a.attnum::text||':'||a.xmin::text, ',' ORDER BY a.attrelid, a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'recovery_v1'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0),
   (SELECT n.nspowner::text||':'||coalesce(n.nspacl::text,'') FROM pg_namespace n WHERE n.nspname = 'recovery_v1'))),
   -- registry data of V1 (small tables): any change by the migration SQL
   (SELECT md5(string_agg(x, ',' ORDER BY x)) FROM (
      SELECT 'o:'||t::text AS x FROM recovery_v1.org_state t UNION ALL SELECT 'k:'||t::text FROM recovery_v1.owner_keys t
      UNION ALL SELECT 'p:'||t::text FROM recovery_v1.offline_policy t UNION ALL SELECT 'd:'||t::text FROM recovery_v1.device_revocations t
      UNION ALL SELECT 's:'||t::text FROM recovery_v1.settings t UNION ALL SELECT 'y:'||md5(t::text) FROM recovery_v1.keys t
      UNION ALL SELECT 'g:'||t::text FROM recovery_v1.guarded_tables t UNION ALL SELECT 'm:'||t::text FROM recovery_v1.applied_migrations t
      UNION ALL SELECT 'i:'||t::text FROM recovery_v1.install t UNION ALL SELECT 'a:'||t::text FROM recovery_v1.adapter_087 t
      UNION ALL SELECT 'n:'||t::text FROM recovery_v1.pins t UNION ALL SELECT 'x:'||t::text FROM recovery_v1.authorized_txn t) z),
   -- append-only evidence: nothing added or removed by the SQL
   (SELECT concat_ws(',', (SELECT count(*) FROM recovery_v1.audit), (SELECT count(*) FROM recovery_v1.owner_authorizations_used),
      (SELECT count(*) FROM recovery_v1.offline_capabilities), (SELECT count(*) FROM recovery_v1.offline_usage), (SELECT count(*) FROM recovery_v1.fences),
      (SELECT count(*) FROM recovery_v1.untrusted_evidence), (SELECT count(*) FROM recovery_v1.untrusted_checkpoints))),
   -- the cluster: extensions, event triggers, roles and memberships
   (SELECT md5(string_agg(e.oid::text||':'||e.xmin::text, ',' ORDER BY e.oid)) FROM pg_extension e),
   (SELECT md5(string_agg(e.oid::text||':'||e.xmin::text||':'||e.evtenabled::text, ',' ORDER BY e.oid)) FROM pg_event_trigger e),
   (SELECT md5(string_agg(r.oid::text||':'||r.rolname||':'||r.rolsuper::text||r.rolinherit::text||r.rolcreaterole::text||r.rolcreatedb::text||r.rolcanlogin::text||r.rolbypassrls::text||r.rolreplication::text, ',' ORDER BY r.oid)) FROM pg_roles r),
   (SELECT md5(string_agg(m.roleid::text||':'||m.member::text, ',' ORDER BY m.roleid, m.member)) FROM pg_auth_members m),
   -- the objects that existed before: triggers, policies and rules on the public tables of the pin, and public functions
   (SELECT md5(string_agg(t.oid::text||':'||t.xmin::text, ',' ORDER BY t.oid)) FROM pg_trigger t WHERE t.tgrelid = ANY (v_before_tables)),
   (SELECT md5(string_agg(o.oid::text||':'||o.xmin::text, ',' ORDER BY o.oid)) FROM pg_policy o WHERE o.polrelid = ANY (v_before_tables)),
   (SELECT md5(string_agg(w.oid::text||':'||w.xmin::text, ',' ORDER BY w.oid)) FROM pg_rewrite w WHERE w.ev_class = ANY (v_before_tables) AND w.rulename <> '_RETURN'),
   (SELECT md5(string_agg(p.oid::text||':'||p.xmin::text, ',' ORDER BY p.oid)) FROM pg_proc p WHERE p.oid = ANY (v_before_funcs)),
   (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (v_before_funcs)),
   -- 087 (adopted), the system catalog's and the auth / 087 schemas' functions, and per-database / per-role settings
   (SELECT CASE WHEN EXISTS (SELECT 1 FROM recovery_v1.adapter_087) THEN recovery_v1.m087_fingerprint(true) END),
   (SELECT md5(string_agg(p.oid::text||':'||p.xmin::text, ',' ORDER BY p.oid)) FROM pg_proc p
     WHERE p.pronamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog', 'auth', 'recovery', 'recovery_guard'))),
   (SELECT md5(string_agg(r.setdatabase::text||':'||r.setrole::text||':'||array_to_string(r.setconfig, '|'), ',' ORDER BY r.setdatabase, r.setrole)) FROM pg_db_role_setting r)) INTO v_snap_before;
 RAISE LOG 'RECOVERY_V1_MIGRATION % step executing-sql', v_id;
 EXECUTE p_sql;
 RAISE LOG 'RECOVERY_V1_MIGRATION % step scope-check', v_id;
 IF coalesce(current_setting('event_triggers', true), 'on') IS DISTINCT FROM 'on' THEN  -- the setting exists from PostgreSQL 17
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_SCOPE: the SQL switched event triggers off';
 END IF;
 IF current_user IS DISTINCT FROM v_user OR session_user IS DISTINCT FROM v_session THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_SCOPE: the SQL changed the session role';
 END IF;
 SELECT concat_ws(E'\n',
   md5(concat_ws('|',
   (SELECT string_agg(p.oid::text||':'||p.xmin::text, ',' ORDER BY p.oid) FROM pg_proc p WHERE p.pronamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(c.oid::text||':'||c.relname||':'||c.relkind::text||':'||c.relowner::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text||c.relforcerowsecurity::text, ',' ORDER BY c.oid)
      FROM pg_class c WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(t.oid::text||':'||t.xmin::text||':'||t.tgenabled::text, ',' ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(o.oid::text||':'||o.xmin::text, ',' ORDER BY o.oid) FROM pg_policy o JOIN pg_class c ON c.oid = o.polrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(w.oid::text||':'||w.xmin::text, ',' ORDER BY w.oid) FROM pg_rewrite w JOIN pg_class c ON c.oid = w.ev_class WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(k.oid::text||':'||k.xmin::text, ',' ORDER BY k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(d.oid::text||':'||d.xmin::text, ',' ORDER BY d.oid) FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid WHERE c.relnamespace = 'recovery_v1'::regnamespace),
   (SELECT string_agg(a.attrelid::text||'.'||a.attnum::text||':'||a.xmin::text, ',' ORDER BY a.attrelid, a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'recovery_v1'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0),
   (SELECT n.nspowner::text||':'||coalesce(n.nspacl::text,'') FROM pg_namespace n WHERE n.nspname = 'recovery_v1'))),
   -- registry data of V1 (small tables): any change by the migration SQL
   (SELECT md5(string_agg(x, ',' ORDER BY x)) FROM (
      SELECT 'o:'||t::text AS x FROM recovery_v1.org_state t UNION ALL SELECT 'k:'||t::text FROM recovery_v1.owner_keys t
      UNION ALL SELECT 'p:'||t::text FROM recovery_v1.offline_policy t UNION ALL SELECT 'd:'||t::text FROM recovery_v1.device_revocations t
      UNION ALL SELECT 's:'||t::text FROM recovery_v1.settings t UNION ALL SELECT 'y:'||md5(t::text) FROM recovery_v1.keys t
      UNION ALL SELECT 'g:'||t::text FROM recovery_v1.guarded_tables t UNION ALL SELECT 'm:'||t::text FROM recovery_v1.applied_migrations t
      UNION ALL SELECT 'i:'||t::text FROM recovery_v1.install t UNION ALL SELECT 'a:'||t::text FROM recovery_v1.adapter_087 t
      UNION ALL SELECT 'n:'||t::text FROM recovery_v1.pins t UNION ALL SELECT 'x:'||t::text FROM recovery_v1.authorized_txn t) z),
   -- append-only evidence: nothing added or removed by the SQL
   (SELECT concat_ws(',', (SELECT count(*) FROM recovery_v1.audit), (SELECT count(*) FROM recovery_v1.owner_authorizations_used),
      (SELECT count(*) FROM recovery_v1.offline_capabilities), (SELECT count(*) FROM recovery_v1.offline_usage), (SELECT count(*) FROM recovery_v1.fences),
      (SELECT count(*) FROM recovery_v1.untrusted_evidence), (SELECT count(*) FROM recovery_v1.untrusted_checkpoints))),
   -- the cluster: extensions, event triggers, roles and memberships
   (SELECT md5(string_agg(e.oid::text||':'||e.xmin::text, ',' ORDER BY e.oid)) FROM pg_extension e),
   (SELECT md5(string_agg(e.oid::text||':'||e.xmin::text||':'||e.evtenabled::text, ',' ORDER BY e.oid)) FROM pg_event_trigger e),
   (SELECT md5(string_agg(r.oid::text||':'||r.rolname||':'||r.rolsuper::text||r.rolinherit::text||r.rolcreaterole::text||r.rolcreatedb::text||r.rolcanlogin::text||r.rolbypassrls::text||r.rolreplication::text, ',' ORDER BY r.oid)) FROM pg_roles r),
   (SELECT md5(string_agg(m.roleid::text||':'||m.member::text, ',' ORDER BY m.roleid, m.member)) FROM pg_auth_members m),
   -- the objects that existed before: triggers, policies and rules on the public tables of the pin, and public functions
   (SELECT md5(string_agg(t.oid::text||':'||t.xmin::text, ',' ORDER BY t.oid)) FROM pg_trigger t WHERE t.tgrelid = ANY (v_before_tables)),
   (SELECT md5(string_agg(o.oid::text||':'||o.xmin::text, ',' ORDER BY o.oid)) FROM pg_policy o WHERE o.polrelid = ANY (v_before_tables)),
   (SELECT md5(string_agg(w.oid::text||':'||w.xmin::text, ',' ORDER BY w.oid)) FROM pg_rewrite w WHERE w.ev_class = ANY (v_before_tables) AND w.rulename <> '_RETURN'),
   (SELECT md5(string_agg(p.oid::text||':'||p.xmin::text, ',' ORDER BY p.oid)) FROM pg_proc p WHERE p.oid = ANY (v_before_funcs)),
   (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (v_before_funcs)),
   -- 087 (adopted), the system catalog's and the auth / 087 schemas' functions, and per-database / per-role settings
   (SELECT CASE WHEN EXISTS (SELECT 1 FROM recovery_v1.adapter_087) THEN recovery_v1.m087_fingerprint(true) END),
   (SELECT md5(string_agg(p.oid::text||':'||p.xmin::text, ',' ORDER BY p.oid)) FROM pg_proc p
     WHERE p.pronamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog', 'auth', 'recovery', 'recovery_guard'))),
   (SELECT md5(string_agg(r.setdatabase::text||':'||r.setrole::text||':'||array_to_string(r.setconfig, '|'), ',' ORDER BY r.setdatabase, r.setrole)) FROM pg_db_role_setting r)) INTO v_snap_after;
 IF v_snap_after IS DISTINCT FROM v_snap_before THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_SCOPE: the SQL changed Recovery V1, its data, roles, extensions, event triggers or an existing trigger, policy, rule or function (an authorized migration only adds)';
 END IF;
 RAISE LOG 'RECOVERY_V1_MIGRATION % step guarding-new-tables', v_id;
 UPDATE recovery_v1.authorized_txn SET ref = v_id || '#guards' WHERE txid = txid_current();
 FOREACH v_t IN ARRAY v_new LOOP
  v_rel := to_regclass('public.' || v_t);
  IF v_rel IS NULL OR (SELECT relkind FROM pg_class WHERE oid = v_rel) <> 'r' THEN RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_POSTCHECK: authorized new table % was not created as a plain table', v_t; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = v_rel AND attname = 'org_id' AND atttypid = 'text'::regtype AND attnotnull AND NOT attisdropped) THEN
   RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_POSTCHECK: new table % needs org_id text NOT NULL (its rows are resolved by that column)', v_t;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_POSTCHECK: new table % must enable row level security', v_t; END IF;
  EXECUTE format('CREATE TRIGGER zz_recovery_v1_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION recovery_v1.guard_write()', v_t);
  EXECUTE format('CREATE TRIGGER zz_recovery_v1_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.deny_truncate()', v_t);
  EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER zz_recovery_v1_write, ENABLE ALWAYS TRIGGER zz_recovery_v1_truncate', v_t);
  EXECUTE format('REVOKE TRUNCATE, TRIGGER ON public.%I FROM anon, authenticated, service_role', v_t);
  INSERT INTO recovery_v1.guarded_tables(relid, relname, resolver, migration_id) VALUES (v_rel, v_t, 'org_id', v_id);
 END LOOP;
 IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF;
 RAISE LOG 'RECOVERY_V1_MIGRATION % step post-validation', v_id;
 v_tables := ARRAY(SELECT c.oid FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','f','m') ORDER BY c.oid);
 IF EXISTS(SELECT 1 FROM unnest(v_tables) o CROSS JOIN recovery_v1.pins p WHERE NOT (o = ANY (p.public_tables))
            AND NOT EXISTS(SELECT 1 FROM recovery_v1.guarded_tables g WHERE g.relid = o AND g.migration_id = v_id)) THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_POSTCHECK: a public relation appeared that is not an authorized, guarded new table';
 END IF;
 IF recovery_v1.entry_fingerprint() IS DISTINCT FROM v_entry THEN RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_POSTCHECK: V1 entry points changed'; END IF;
 UPDATE recovery_v1.pins SET public_tables = v_tables, guard_triggers = recovery_v1.guard_triggers_state(v_tables);
 IF recovery_v1.integrity_problem() IS NOT NULL THEN
  RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_POSTCHECK: recovery protection not intact after the migration (%)', recovery_v1.integrity_problem();
 END IF;
 v_newhead := encode(sha256(convert_to(v_head || ':' || encode(sha256(convert_to(p_auth, 'UTF8')), 'hex') || ':' || (m->>'sqlSha256'), 'UTF8')), 'hex');
 INSERT INTO recovery_v1.applied_migrations(migration_id, sql_sha256, auth_sha256, key_id, nonce, predecessor, chain_head, new_tables)
 VALUES (v_id, m->>'sqlSha256', encode(sha256(convert_to(p_auth, 'UTF8')), 'hex'), a->>'keyId', (a->>'nonce')::uuid, v_head, v_newhead, v_new);
 DELETE FROM recovery_v1.authorized_txn WHERE txid = txid_current();
 INSERT INTO recovery_v1.audit(org_id, kind, detail) VALUES (NULL, 'authorized_migration_applied',
   jsonb_build_object('migrationId', v_id, 'sqlSha256', m->>'sqlSha256', 'keyId', a->>'keyId', 'predecessor', v_head, 'chainHead', v_newhead, 'newTables', to_jsonb(v_new)));
 RAISE LOG 'RECOVERY_V1_MIGRATION % step committed-in-transaction', v_id;
 RETURN jsonb_build_object('outcome', 'applied', 'migrationId', v_id, 'chainHead', v_newhead, 'newTables', to_jsonb(v_new));
END $$;

-- The four client entry points live in schema recovery_v1 (SECURITY DEFINER). public.recovery_v1_*
-- are SECURITY INVOKER wrappers (defined below), so their owner carries no privilege: with 087
-- adopted they are owned by recovery_owner, as 087's registry of public recovery_% functions requires.
CREATE FUNCTION recovery_v1.status(p_org_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; s recovery_v1.org_state; held087 boolean;
BEGIN
 u:=recovery_v1.caller();
 IF p_org_id IS DISTINCT FROM u.org_id THEN RAISE EXCEPTION 'RECOVERY_V1_CALLER_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM recovery_v1.org_state WHERE org_id=u.org_id;
 IF recovery_v1.integrity_problem() IS NOT NULL THEN
  RETURN jsonb_build_object('protocol','orvix-recovery-v1','org_id',u.org_id,'state','QUARANTINED','recovered_as_of',NULL,
   'uncertainties',jsonb_build_array('Recovery protection is not intact on this server ('||recovery_v1.integrity_problem()||')'),'required_evidence',true);
 END IF;
 -- With 087 adopted, a write also needs an OPEN 087 server (valid lease) and an organization 087
 -- does not hold: report RESTRICTED rather than a V1 ACTIVE that 087 would refuse.
 IF s.state='ACTIVE' AND EXISTS(SELECT 1 FROM recovery_v1.adapter_087) THEN
  -- 087's lease condition evaluated inline from its (fingerprinted) tables: no 087 function runs here
  EXECUTE 'SELECT NOT coalesce((SELECT c.state=''open'' FROM recovery.continuity c),false)
                  OR NOT coalesce((SELECT l.valid_until > clock_timestamp() AND l.issued_at > pg_postmaster_start_time()
                                          AND l.postmaster_start = pg_postmaster_start_time()
                                          AND (l.issued_xid::text::numeric % 4294967296) = l.xmin::text::numeric FROM recovery.lease l), false)
                  OR coalesce((SELECT o.held FROM recovery.org_state o WHERE o.org_id=$1),true)' INTO held087 USING u.org_id;
  IF coalesce(held087,true) THEN
   RETURN jsonb_build_object('protocol','orvix-recovery-v1','org_id',u.org_id,'state','RESTRICTED','recovered_as_of',s.recovered_as_of,
    'uncertainties',jsonb_build_array('The migration 087 recovery hold is in effect on this server'),'required_evidence',true);
  END IF;
 END IF;
 RETURN jsonb_build_object('protocol','orvix-recovery-v1','org_id',u.org_id,'state',coalesce(s.state,'RESTRICTED'),
 'recovered_as_of',s.recovered_as_of,'uncertainties',coalesce(s.uncertainties,'["Recovery state unavailable"]'::jsonb),'required_evidence',true);
END $$;
-- The infrastructure can contain an incident; it cannot manufacture independent
-- owner authorization. All attempts to ACTIVE return an audited denial.
CREATE FUNCTION recovery_v1.transition(p_org_id text,p_state text,p_reason text,p_evidence_reference text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; s text; allowed boolean;
BEGIN
 -- An active app user is required before anything is written (no anonymous audit flooding);
 -- every attempt is recorded under the CALLER's organization, with every input capped.
 u:=recovery_v1.caller();
 -- Bounded audit growth: at most 60 transition attempts per user per hour are recorded;
 -- beyond that the call is refused WITHOUT writing (the audit table is append-only forever).
 -- Per USER, so one user (e.g. a cashier whose attempts are always denied) cannot use up the
 -- organization's quota and block its ADMIN's containment transition.
 IF (SELECT count(*) FROM recovery_v1.audit WHERE org_id=u.org_id AND kind='transition_attempt' AND detail->>'actor_id'=u.id AND at > clock_timestamp()-interval '1 hour') >= 60 THEN
  RAISE EXCEPTION 'RECOVERY_V1_TRANSITION_RATE_LIMITED' USING ERRCODE='54000';
 END IF;
 allowed:=u.org_id IS NOT DISTINCT FROM p_org_id AND u.role='ADMIN' AND p_org_id IS NOT NULL;
 INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(u.org_id,'transition_attempt',jsonb_build_object('requested_org',left(p_org_id,200),'requested_state',left(p_state,40),'reason',left(p_reason,500),'evidence_reference',left(p_evidence_reference,500),'actor_id',u.id));
 IF NOT coalesce(allowed,false) OR p_state IS NULL OR p_state NOT IN('RESTRICTED','RECONCILING','QUARANTINED') OR nullif(btrim(p_reason),'') IS NULL OR nullif(btrim(p_evidence_reference),'') IS NULL THEN
  INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(u.org_id,'transition_denied',jsonb_build_object('requested_org',left(p_org_id,200),'requested_state',left(p_state,40),'reason','Independent owner release is unimplemented; authority/arguments must be valid'));
  RETURN jsonb_build_object('outcome','denied','reopen_authorized',false);
 END IF;
 INSERT INTO recovery_v1.org_state(org_id) SELECT id FROM public.organizations WHERE id=p_org_id ON CONFLICT DO NOTHING;
 SELECT state INTO s FROM recovery_v1.org_state WHERE org_id=p_org_id FOR UPDATE;
 UPDATE recovery_v1.org_state SET state=p_state,reason=left(p_reason,500),changed_at=clock_timestamp() WHERE org_id=p_org_id;
 INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org_id,'transition_applied',jsonb_build_object('from',s,'to',p_state,'evidence_reference',left(p_evidence_reference,500)));
 RETURN jsonb_build_object('outcome','applied','state',p_state,'reopen_authorized',false);
END $$;

-- Every touched org is collected from both OLD and NEW, including EVERY financial
-- parent the row references (shop, shift, sale, purchase order, supplier, product,
-- unit, price level, transfer, acting users, polymorphic movement references).
-- Most of these columns have no foreign key, so they are resolved explicitly.
-- guard_write then requires exactly ONE organization: a row that links two
-- organizations is refused even when both are ACTIVE (isolation), and a row that
-- touches a restricted organization through any parent is refused (recovery).
-- This is a recovery boundary in addition to existing RLS/permission checks.
CREATE FUNCTION recovery_v1.org_of_shop(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT org_id FROM public.shops WHERE id=p $$;
CREATE FUNCTION recovery_v1.org_of_user(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT org_id FROM public.users WHERE id=p $$;
CREATE FUNCTION recovery_v1.org_of_product(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT org_id FROM public.products WHERE id=p $$;
CREATE FUNCTION recovery_v1.org_of_unit(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT x.org_id FROM public.product_units u JOIN public.products x ON x.id=u.product_id WHERE u.id=p $$;
CREATE FUNCTION recovery_v1.org_of_sale(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT s.org_id FROM public.sales x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p $$;
CREATE FUNCTION recovery_v1.org_of_shift(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT s.org_id FROM public.shifts x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p $$;
CREATE FUNCTION recovery_v1.org_of_po(p text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT s.org_id FROM public.purchase_orders x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p $$;
CREATE FUNCTION recovery_v1.org_of_movement_ref(p text) RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT ARRAY[recovery_v1.org_of_sale(p),recovery_v1.org_of_shift(p),recovery_v1.org_of_po(p),
  (SELECT s.org_id FROM public.refund_void_requests x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p),
  (SELECT s.org_id FROM public.stock_transfers x JOIN public.shops s ON s.id=x.from_shop_id WHERE x.id=p),
  (SELECT s.org_id FROM public.stock_transfers x JOIN public.shops s ON s.id=x.to_shop_id WHERE x.id=p),
  (SELECT s.org_id FROM public.supplier_payments x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=p)] $$;
CREATE FUNCTION recovery_v1.orgs(p_table text,r jsonb) RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v text[]; u text[]; c text[];
BEGIN
 -- acting/approving users on any row: EVERY column named *_by, plus cashier_id/actor_id/user_id
 -- (derived from the row itself, so a new *_by column is covered without editing this list)
 SELECT coalesce(array_agg(recovery_v1.org_of_user(e.value)),'{}') INTO u FROM jsonb_each_text(r) e
  WHERE e.value IS NOT NULL AND (e.key LIKE '%\_by' OR e.key IN('cashier_id','actor_id','user_id'));
 v:=CASE
 WHEN p_table='organizations' THEN ARRAY[r->>'id']
 WHEN p_table IN('brands','business_profile','categories','price_levels','suppliers','unit_types','idempotency_keys') THEN ARRAY[r->>'org_id']
 WHEN p_table='product_costs' THEN ARRAY[r->>'org_id',recovery_v1.org_of_product(r->>'product_id')]
 WHEN p_table='products' THEN ARRAY[r->>'org_id',(SELECT org_id FROM public.brands WHERE id=r->>'brand_id')]
 WHEN p_table='product_barcodes' THEN ARRAY[r->>'org_id',recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
 WHEN p_table='product_unit_costs' THEN ARRAY[r->>'org_id',recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
 WHEN p_table='sale_item_costs' THEN ARRAY[r->>'org_id',recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_sale(r->>'sale_id'),
   (SELECT recovery_v1.org_of_sale(i.sale_id) FROM public.sale_items i WHERE i.id=r->>'sale_item_id')]
 WHEN p_table='shops' THEN ARRAY[r->>'org_id']
 WHEN p_table='users' THEN ARRAY[r->>'org_id',recovery_v1.org_of_shop(r->>'shop_id')]
 WHEN p_table='audit_logs' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_user(r->>'actor_id'),
   recovery_v1.org_of_product(r->>'entity_id'),recovery_v1.org_of_unit(r->>'entity_id'),recovery_v1.org_of_user(r->>'entity_id'),recovery_v1.org_of_shop(r->>'entity_id'),
   (SELECT org_id FROM public.suppliers WHERE id=r->>'entity_id'),(SELECT org_id FROM public.categories WHERE id=r->>'entity_id'),
   (SELECT org_id FROM public.brands WHERE id=r->>'entity_id'),(SELECT org_id FROM public.unit_types WHERE id=r->>'entity_id'),
   (SELECT org_id FROM public.price_levels WHERE id=r->>'entity_id'),(SELECT id FROM public.organizations WHERE id=r->>'entity_id')]
   ||recovery_v1.org_of_movement_ref(r->>'entity_id')
 WHEN p_table IN('inventory','price_tiers','product_image_upload_sessions') THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_product(r->>'product_id')]
 WHEN p_table='inventory_movements' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
   ||recovery_v1.org_of_movement_ref(r->>'reference_id')
 WHEN p_table='product_unit_prices' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_unit(r->>'product_unit_id'),(SELECT org_id FROM public.price_levels WHERE id=r->>'price_level_id')]
 WHEN p_table='purchase_orders' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),(SELECT org_id FROM public.suppliers WHERE id=r->>'supplier_id')]
 WHEN p_table='supplier_payments' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),(SELECT org_id FROM public.suppliers WHERE id=r->>'supplier_id'),recovery_v1.org_of_po(r->>'purchase_order_id')]
 WHEN p_table='refund_void_requests' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_sale(r->>'sale_id')]
   ||coalesce((SELECT array_agg(x) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r->'items')='array' THEN r->'items' ELSE '[]'::jsonb END) i,
      LATERAL unnest(ARRAY[recovery_v1.org_of_product(coalesce(i->>'productId',i->>'product_id')),
        (SELECT recovery_v1.org_of_sale(si.sale_id) FROM public.sale_items si WHERE si.id=coalesce(i->>'saleItemId',i->>'sale_item_id'))]) x),'{}')
 WHEN p_table='sales' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_shift(r->>'shift_id')]
 WHEN p_table='shifts' THEN ARRAY[recovery_v1.org_of_shop(r->>'shop_id')]
 WHEN p_table='stock_transfers' THEN ARRAY[recovery_v1.org_of_shop(r->>'from_shop_id'),recovery_v1.org_of_shop(r->>'to_shop_id')]
 WHEN p_table='stock_transfer_items' THEN ARRAY[(SELECT s.org_id FROM public.stock_transfers t JOIN public.shops s ON s.id=t.from_shop_id WHERE t.id=r->>'transfer_id'),(SELECT s.org_id FROM public.stock_transfers t JOIN public.shops s ON s.id=t.to_shop_id WHERE t.id=r->>'transfer_id'),recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
 WHEN p_table='product_units' THEN ARRAY[recovery_v1.org_of_product(r->>'product_id')]
 WHEN p_table='purchase_order_items' THEN ARRAY[recovery_v1.org_of_po(r->>'purchase_order_id'),recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id')]
 WHEN p_table='sale_items' THEN ARRAY[recovery_v1.org_of_sale(r->>'sale_id'),recovery_v1.org_of_product(r->>'product_id'),recovery_v1.org_of_unit(r->>'product_unit_id'),(SELECT org_id FROM public.price_levels WHERE id=r->>'price_level_id')]
 WHEN p_table='reprint_logs' THEN ARRAY[recovery_v1.org_of_sale(r->>'sale_id')]
 WHEN p_table='supplier_products' THEN ARRAY[(SELECT org_id FROM public.suppliers WHERE id=r->>'supplier_id'),recovery_v1.org_of_product(r->>'product_id')]
 -- Step 4 financial tables (PFIN-D / PFIN-E): their own org_id plus every parent they name
 WHEN p_table='sale_payments' THEN ARRAY[r->>'org_id',recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_sale(r->>'sale_id')]
 WHEN p_table='cash_movements' THEN ARRAY[r->>'org_id',recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_shift(r->>'shift_id')]
 WHEN p_table IN('refund_lines','refund_payouts') THEN ARRAY[r->>'org_id',recovery_v1.org_of_shop(r->>'shop_id'),recovery_v1.org_of_sale(r->>'sale_id'),
   (SELECT s.org_id FROM public.refund_void_requests x JOIN public.shops s ON s.id=x.shop_id WHERE x.id=r->>'request_id'),
   (SELECT recovery_v1.org_of_sale(i.sale_id) FROM public.sale_items i WHERE i.id=r->>'sale_item_id')]
 END;
 -- a table added by an owner-authorized migration after V1: resolved by its mandatory org_id column
 IF v IS NULL AND EXISTS(SELECT 1 FROM recovery_v1.guarded_tables WHERE relname=p_table AND resolver='org_id') THEN v := ARRAY[r->>'org_id']; END IF;
 -- PCOST-A cost rows may be written before their parent (deferred FKs). A parent row must
 -- therefore also agree with the organization of any cost row that already names its id,
 -- or one organization could pre-write a cost row for an id another organization creates.
 IF p_table='products' AND to_regclass('public.product_costs') IS NOT NULL THEN
  EXECUTE 'SELECT array_agg(org_id) FROM public.product_costs WHERE product_id=$1' INTO c USING r->>'id'; v:=v||coalesce(c,'{}');
 ELSIF p_table='product_units' AND to_regclass('public.product_unit_costs') IS NOT NULL THEN
  EXECUTE 'SELECT array_agg(org_id) FROM public.product_unit_costs WHERE product_unit_id=$1' INTO c USING r->>'id'; v:=v||coalesce(c,'{}');
 ELSIF p_table='sale_items' AND to_regclass('public.sale_item_costs') IS NOT NULL THEN
  EXECUTE 'SELECT array_agg(org_id) FROM public.sale_item_costs WHERE sale_item_id=$1' INTO c USING r->>'id'; v:=v||coalesce(c,'{}');
 END IF;
 RETURN ARRAY(SELECT DISTINCT x FROM unnest(v||u) x WHERE x IS NOT NULL ORDER BY 1);
END $$;
-- A non-NULL reference that resolves to NO organization (a dangling id) would let a later
-- insert of that id in another organization re-link the row; strict parent references must
-- therefore resolve. Returns the first dangling column, or NULL.
CREATE FUNCTION recovery_v1.dangling(p_table text,r jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e record; o text;
BEGIN
 -- PCOST-A cost side rows are written by BEFORE triggers before their parent row exists
 -- (deferred FKs): their parent ids are not strict; their own org_id is, and is resolved.
 FOR e IN SELECT key,value FROM jsonb_each_text(r) WHERE value IS NOT NULL AND key IN('shop_id','from_shop_id','to_shop_id','shift_id','sale_id','purchase_order_id','supplier_id','product_id','product_unit_id','transfer_id')
   AND NOT (p_table IN('product_costs','product_unit_costs','sale_item_costs') AND key IN('product_id','product_unit_id')) LOOP
  -- sale_item_id is NOT strict: PCOST-A snapshots a line's cost (sale_item_costs) BEFORE the line
  -- row exists; that row's sale_id and org_id are strict and resolved instead.
  o:=CASE e.key
   WHEN 'shop_id' THEN recovery_v1.org_of_shop(e.value) WHEN 'from_shop_id' THEN recovery_v1.org_of_shop(e.value) WHEN 'to_shop_id' THEN recovery_v1.org_of_shop(e.value)
   WHEN 'shift_id' THEN recovery_v1.org_of_shift(e.value) WHEN 'sale_id' THEN recovery_v1.org_of_sale(e.value) WHEN 'purchase_order_id' THEN recovery_v1.org_of_po(e.value)
   WHEN 'supplier_id' THEN (SELECT org_id FROM public.suppliers WHERE id=e.value) WHEN 'product_id' THEN recovery_v1.org_of_product(e.value)
   WHEN 'product_unit_id' THEN recovery_v1.org_of_unit(e.value)
   WHEN 'transfer_id' THEN (SELECT s.org_id FROM public.stock_transfers t JOIN public.shops s ON s.id=t.from_shop_id WHERE t.id=e.value) END;
  IF o IS NULL THEN RETURN e.key; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION recovery_v1.guard_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE orgs text[]:='{}'; o text; st text; v_off text;
BEGIN
 IF recovery_v1.integrity_problem() IS NOT NULL THEN PERFORM recovery_v1.deny(NULL,'integrity:'||recovery_v1.integrity_problem()); END IF;
 IF TG_TABLE_NAME IN('app_config','platform_admins') THEN PERFORM recovery_v1.deny(NULL,'global_ownership_write'); END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(OLD)->'id') IS DISTINCT FROM (to_jsonb(NEW)->'id') THEN PERFORM recovery_v1.deny(NULL,'row_identity_change'); END IF;
 IF TG_OP<>'DELETE' AND recovery_v1.dangling(TG_TABLE_NAME,to_jsonb(NEW)) IS NOT NULL THEN PERFORM recovery_v1.deny(NULL,'dangling_reference:'||recovery_v1.dangling(TG_TABLE_NAME,to_jsonb(NEW))); END IF;
 IF TG_OP<>'INSERT' THEN orgs:=orgs||recovery_v1.orgs(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN orgs:=orgs||recovery_v1.orgs(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 orgs:=ARRAY(SELECT DISTINCT x FROM unnest(orgs) x ORDER BY 1);
 IF cardinality(orgs)<>1 THEN PERFORM recovery_v1.deny(NULL,'unknown_or_cross_tenant_write'); END IF;
 FOREACH o IN ARRAY orgs LOOP
  SELECT state INTO st FROM recovery_v1.org_state WHERE org_id=o FOR SHARE;
  IF st IS DISTINCT FROM 'ACTIVE' THEN PERFORM recovery_v1.deny(o,TG_TABLE_NAME||':'||TG_OP); END IF;
 END LOOP;
 IF TG_TABLE_NAME='sales' AND TG_OP='INSERT' AND nullif(current_setting('recovery_v1.offline_op', true), '') IS NOT NULL THEN
  v_off := recovery_v1.offline_problem(orgs[1], current_setting('recovery_v1.offline_op')::uuid, NEW.total_mmk::bigint, 'complete_sale');
  IF v_off IS NOT NULL THEN PERFORM recovery_v1.deny(orgs[1], v_off); END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE FUNCTION recovery_v1.deny_truncate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN PERFORM recovery_v1.deny(NULL,'truncate:'||TG_TABLE_NAME); RETURN NULL; END $$;
-- Ledger writes must remain allowed for a narrowly checked sentinel insertion
-- during restriction. Its registry entry is installed first, inside the same txn.
CREATE FUNCTION recovery_v1.guard_ledger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE f recovery_v1.fences; r jsonb; v_off text;
BEGIN
 IF recovery_v1.integrity_problem() IS NOT NULL THEN PERFORM recovery_v1.deny(NULL,'integrity:'||recovery_v1.integrity_problem()); END IF;
 IF TG_OP='INSERT' THEN r:=to_jsonb(NEW); ELSE r:=to_jsonb(OLD); END IF;
 SELECT * INTO f FROM recovery_v1.fences WHERE key=(r->>'key')::uuid;
 IF FOUND THEN
  IF TG_OP='DELETE' THEN RETURN NULL; END IF; -- original 30d prune skips, retaining sentinel forever
  IF TG_OP='UPDATE' THEN PERFORM recovery_v1.deny(f.org_id,'fence_immutable'); END IF;
  IF NEW.org_id IS DISTINCT FROM f.org_id OR NEW.rpc IS DISTINCT FROM f.rpc OR NEW.actor_id IS DISTINCT FROM f.actor_id OR NEW.response IS NOT NULL
   OR NEW.request_hash IS DISTINCT FROM (CASE (SELECT stage FROM recovery_v1.install) WHEN 85 THEN 'FENCED:'||f.incident ELSE 'A:' END) THEN PERFORM recovery_v1.deny(f.org_id,'fence_binding_mismatch'); END IF;
  RETURN NEW;
 END IF;
 -- Preserve every pre-existing completion/tombstone through recovery retention.
 IF TG_OP='DELETE' THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'response') IS DISTINCT FROM (to_jsonb(OLD)-'response') THEN PERFORM recovery_v1.deny(OLD.org_id,'operation_identity_immutable'); END IF;
 IF TG_OP='UPDATE' AND OLD.response IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN PERFORM recovery_v1.deny(OLD.org_id,'completed_operation_immutable'); END IF;
 IF NOT EXISTS(SELECT 1 FROM recovery_v1.org_state WHERE org_id=r->>'org_id' AND state='ACTIVE' FOR SHARE) THEN PERFORM recovery_v1.deny(r->>'org_id','operation_write'); END IF;
 IF TG_OP='INSERT' THEN
  -- an operation a till recorded OFFLINE is accepted only within its capability (device, epoch, count, value)
  v_off := recovery_v1.offline_problem(NEW.org_id, NEW.key, 0, NEW.rpc);
  IF v_off IS NOT NULL THEN PERFORM recovery_v1.deny(NEW.org_id, v_off); END IF;
  PERFORM set_config('recovery_v1.offline_op', NEW.key::text, true);
 END IF;
 IF TG_OP='UPDATE' THEN RETURN NEW; END IF; RETURN NEW;
END $$;
CREATE FUNCTION recovery_v1.fence_key(p_database text,p_system_identifier text,p_org text,p_shop text,p_key uuid,p_rpc text,p_actor text,p_incident text,p_evidence_sha256 text,p_authorization_reference text,p_dependencies uuid[] DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v record; stage int; unresolved int;
BEGIN
 PERFORM recovery_v1.require_target(p_database,p_system_identifier);
 IF p_key IS NULL OR p_rpc IS NULL OR p_rpc !~ '^[a-z][a-z0-9_]{1,80}$' OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=p_rpc AND p.prosrc LIKE '%idem_begin(%')
 OR nullif(btrim(p_incident),'') IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$' OR p_evidence_sha256 IS NULL OR nullif(btrim(p_authorization_reference),'') IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.shops WHERE id=p_shop AND org_id=p_org) OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor AND org_id=p_org)
 OR p_dependencies IS NULL OR p_key=ANY(p_dependencies) OR array_position(p_dependencies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_INVALID_FENCE_TARGET' USING ERRCODE='22023'; END IF;
 -- 087 adopted: its held row guard refuses the sentinel insert, and bypassing it is not allowed.
 -- 087's own owner-approved decision flow is the fence path; a V1 fence is refused, audited, and
 -- nothing else is written (no fence row, no ledger row).
 IF EXISTS(SELECT 1 FROM recovery_v1.adapter_087) THEN
  INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org,'fence_refused_087_adopted',jsonb_build_object('key',p_key,'rpc',p_rpc,'incident',left(p_incident,500),'reason','migration 087 is installed: use its fence decision flow'));
  RETURN jsonb_build_object('outcome','refused','reason','migration_087_installed_use_087_fence_decision','key',p_key,'fence_written',false,'execution_history_proven',false);
 END IF;
 SELECT i.stage INTO stage FROM recovery_v1.install i;
 -- Exactly the real 074/086 idem_begin lock, including its key namespace.
 PERFORM pg_advisory_xact_lock(hashtext(CASE stage WHEN 85 THEN 'idem:'||p_key::text ELSE 'idem:'||p_org||':'||p_key::text END));
 IF EXISTS(SELECT 1 FROM recovery_v1.fences WHERE key=p_key) THEN
  IF NOT EXISTS(SELECT 1 FROM recovery_v1.fences WHERE key=p_key AND org_id=p_org AND shop_id=p_shop AND rpc=p_rpc AND actor_id=p_actor) THEN RAISE EXCEPTION 'RECOVERY_V1_FENCE_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('outcome','already_fenced','key',p_key,'same_key_only',true);
 END IF;
 -- On either schema, an existing row of ANY org means no overwrite/no attribution.
 IF EXISTS(SELECT 1 FROM public.idempotency_keys WHERE key=p_key) THEN
  INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org,'fence_not_applied_existing_record',jsonb_build_object('key',p_key,'rpc',p_rpc,'incident',p_incident));
  RETURN jsonb_build_object('outcome','existing_record_preserved','key',p_key,'execution_history_proven',false);
 END IF;
 -- Same org-state lock order as regular writes; a transition waits for txn end.
 PERFORM 1 FROM recovery_v1.org_state WHERE org_id=p_org FOR SHARE;
 INSERT INTO recovery_v1.fences(key,org_id,shop_id,rpc,actor_id,incident,preserved_evidence_sha256,authorization_reference,dependencies)
 VALUES(p_key,p_org,p_shop,p_rpc,p_actor,p_incident,p_evidence_sha256,p_authorization_reference,p_dependencies);
 IF stage=85 THEN
  INSERT INTO public.idempotency_keys(key,rpc,actor_id,org_id,request_hash) VALUES(p_key,p_rpc,p_actor,p_org,'FENCED:'||p_incident);
 ELSE
  EXECUTE 'INSERT INTO public.idempotency_keys(key,rpc,actor_id,org_id,request_hash,state,outcome_code,outcome_message,decided_at) VALUES($1,$2,$3,$4,''A:'',''abandoned'',''FENCED'',''Recovery fence; history unresolved'',clock_timestamp())' USING p_key,p_rpc,p_actor,p_org;
 END IF;
 SELECT count(*) INTO unresolved FROM unnest(p_dependencies) d WHERE NOT EXISTS(SELECT 1 FROM public.idempotency_keys WHERE key=d AND org_id=p_org);
 INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org,'key_fenced',jsonb_build_object('key',p_key,'rpc',p_rpc,'incident',p_incident,'dependencies_unresolved',unresolved,'preserved_evidence_sha256',p_evidence_sha256,'authorization_reference',p_authorization_reference));
 RETURN jsonb_build_object('outcome','fenced','key',p_key,'same_key_only',true,'dependencies_unresolved',unresolved,'execution_history_proven',false);
END $$;
CREATE FUNCTION recovery_v1.request_unfence(p_database text,p_system_identifier text,p_org text,p_shop text,p_key uuid,p_incident text,p_preserved_evidence_sha256 text,p_independent_authorization jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM recovery_v1.require_target(p_database,p_system_identifier);
 IF NOT EXISTS(SELECT 1 FROM recovery_v1.fences WHERE key=p_key AND org_id=p_org AND shop_id=p_shop) OR nullif(btrim(p_incident),'') IS NULL OR p_preserved_evidence_sha256 IS NULL OR p_preserved_evidence_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'RECOVERY_V1_INVALID_UNFENCE_TARGET'; END IF;
 INSERT INTO recovery_v1.audit(org_id,kind,detail) VALUES(p_org,'unfence_denied',jsonb_build_object('key',p_key,'incident',p_incident,'preserved_evidence_sha256',p_preserved_evidence_sha256,'reason','Independent authorization verifier not provisioned','authorization_supplied',p_independent_authorization IS NOT NULL));
 RETURN jsonb_build_object('outcome','denied','fence_retained',true,'reason','independent_authorization_verifier_not_provisioned');
END $$;

-- Correction pass P5: while V1 is installed the original 30-day prune (062/074) and
-- the 086 response purge delete nothing (guard_ledger). This READ-ONLY report gives the
-- operator the numbers needed to size storage and to design an evidence-aware retention
-- policy; it changes nothing and deletes nothing.
CREATE FUNCTION recovery_v1.ledger_retention_report() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
  'protocol','orvix-recovery-v1-retention-report',
  'generated_at',clock_timestamp(),
  'deletes_performed',0,
  'ledger_total_bytes',pg_total_relation_size('public.idempotency_keys'),
  'evidence_total_bytes',pg_total_relation_size('recovery_v1.untrusted_evidence')+pg_total_relation_size('recovery_v1.untrusted_checkpoints'),
  'audit_rows',(SELECT count(*) FROM recovery_v1.audit),
  'organizations',coalesce((SELECT jsonb_agg(jsonb_build_object(
     'org_id',o.org_id,'state',o.state,
     'ledger_rows',(SELECT count(*) FROM public.idempotency_keys k WHERE k.org_id=o.org_id),
     'ledger_rows_retained_beyond_30d_prune',(SELECT count(*) FROM public.idempotency_keys k WHERE k.org_id=o.org_id AND k.created_at < now()-interval '30 days'),
     'oldest_ledger_row',(SELECT min(k.created_at) FROM public.idempotency_keys k WHERE k.org_id=o.org_id),
     'ledger_row_bytes',(SELECT coalesce(sum(pg_column_size(k.*)),0) FROM public.idempotency_keys k WHERE k.org_id=o.org_id),
     'fenced_keys',(SELECT count(*) FROM recovery_v1.fences f WHERE f.org_id=o.org_id),
     'evidence_records',(SELECT count(*) FROM recovery_v1.untrusted_evidence e WHERE e.org_id=o.org_id),
     'evidence_bytes',(SELECT coalesce(sum(octet_length(e.envelope::text)),0) FROM recovery_v1.untrusted_evidence e WHERE e.org_id=o.org_id),
     'checkpoint_receipts',(SELECT count(*) FROM recovery_v1.untrusted_checkpoints c WHERE c.org_id=o.org_id)
   ) ORDER BY o.org_id) FROM recovery_v1.org_state o),'[]'::jsonb))
$$;
CREATE FUNCTION recovery_v1.store_evidence(p_envelope jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; b jsonb:=p_envelope->'body'; old jsonb; seq bigint;
BEGIN
 u:=recovery_v1.caller();
 IF octet_length(p_envelope::text)>262144 OR b->>'protocol' IS DISTINCT FROM 'orvix-device-evidence-v1' OR b->>'orgId' IS DISTINCT FROM u.org_id
 OR NOT EXISTS(SELECT 1 FROM public.shops WHERE id=b->>'shopId' AND org_id=u.org_id) OR (u.role<>'ADMIN' AND u.shop_id IS DISTINCT FROM b->>'shopId')
 OR b#>>'{authorization,actorId}' IS NULL OR (u.role<>'ADMIN' AND b#>>'{authorization,actorId}' IS DISTINCT FROM u.id) OR p_envelope->>'hash' IS NULL OR p_envelope->>'hash' !~ '^[a-f0-9]{64}$'
 OR b->>'keyId' IS NULL OR length(b->>'keyId') NOT BETWEEN 1 AND 200 OR b->>'deviceId' IS NULL OR length(b->>'deviceId') NOT BETWEEN 1 AND 200 OR b->>'sequence' IS NULL OR b->>'sequence' !~ '^[1-9][0-9]{0,14}$'
 OR b->>'operationId' IS NULL OR b->>'rpc' IS NULL OR b->>'payloadHash' IS NULL OR b->>'payloadHash' !~ '^[a-f0-9]{64}$' OR p_envelope->>'signature' IS NULL THEN RAISE EXCEPTION 'RECOVERY_V1_INVALID_EVIDENCE' USING ERRCODE='22023'; END IF;
 seq:=(b->>'sequence')::bigint;
 PERFORM pg_advisory_xact_lock(hashtext('recovery-evidence:'||u.org_id));
 SELECT envelope INTO old FROM recovery_v1.untrusted_evidence WHERE org_id=u.org_id AND (hash=p_envelope->>'hash' OR (device_id=b->>'deviceId' AND key_id=b->>'keyId' AND sequence=seq));
 IF FOUND THEN
  IF old IS DISTINCT FROM p_envelope THEN RAISE EXCEPTION 'RECOVERY_V1_IMMUTABLE_EVIDENCE_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('outcome','already_stored','verified',false);
 END IF;
 IF coalesce((SELECT sum(octet_length(envelope::text)) FROM recovery_v1.untrusted_evidence WHERE org_id=u.org_id),0)+octet_length(p_envelope::text)>52428800 THEN RETURN jsonb_build_object('outcome','quota_exceeded','stored',false,'verified',false); END IF;
 INSERT INTO recovery_v1.untrusted_evidence(org_id,shop_id,device_id,key_id,sequence,hash,operation_id,envelope) VALUES(u.org_id,b->>'shopId',b->>'deviceId',b->>'keyId',seq,p_envelope->>'hash',(b->>'operationId')::uuid,p_envelope);
 RETURN jsonb_build_object('outcome','stored','verified',false);
END $$;
CREATE FUNCTION recovery_v1.store_checkpoint(p_receipt jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE u public.users; b jsonb:=p_receipt->'body'; c jsonb:=p_receipt#>'{body,checkpoint}'; old jsonb; seq bigint;
BEGIN
 u:=recovery_v1.caller();
 IF octet_length(p_receipt::text)>262144 OR b->>'protocol' IS DISTINCT FROM 'orvix-witness-receipt-v1' OR c->>'protocol' IS DISTINCT FROM 'orvix-checkpoint-v1'
 OR c->>'orgId' IS DISTINCT FROM u.org_id OR NOT EXISTS(SELECT 1 FROM public.shops WHERE id=c->>'shopId' AND org_id=u.org_id)
 OR (u.role<>'ADMIN' AND u.shop_id IS DISTINCT FROM c->>'shopId') OR b->>'witnessId' IS NULL OR c->>'streamId' IS NULL OR c->>'sequence' IS NULL OR c->>'sequence' !~ '^[1-9][0-9]{0,14}$'
 OR c->>'digest' IS NULL OR c->>'digest' !~ '^[a-f0-9]{64}$' OR p_receipt->>'hash' IS NULL OR p_receipt->>'hash' !~ '^[a-f0-9]{64}$' OR p_receipt->>'signature' IS NULL THEN RAISE EXCEPTION 'RECOVERY_V1_INVALID_CHECKPOINT' USING ERRCODE='22023'; END IF;
 seq:=(c->>'sequence')::bigint;
 PERFORM pg_advisory_xact_lock(hashtext('recovery-checkpoint:'||u.org_id));
 SELECT receipt INTO old FROM recovery_v1.untrusted_checkpoints WHERE org_id=u.org_id AND (hash=p_receipt->>'hash' OR(witness_id=b->>'witnessId' AND stream_id=c->>'streamId' AND sequence=seq));
 IF FOUND THEN
  IF old IS DISTINCT FROM p_receipt THEN RAISE EXCEPTION 'RECOVERY_V1_IMMUTABLE_CHECKPOINT_CONFLICT' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('outcome','already_stored','verified',false);
 END IF;
 IF coalesce((SELECT sum(octet_length(receipt::text)) FROM recovery_v1.untrusted_checkpoints WHERE org_id=u.org_id),0)+octet_length(p_receipt::text)>52428800 THEN RETURN jsonb_build_object('outcome','quota_exceeded','stored',false,'verified',false); END IF;
 INSERT INTO recovery_v1.untrusted_checkpoints(org_id,shop_id,witness_id,stream_id,sequence,hash,receipt) VALUES(u.org_id,c->>'shopId',b->>'witnessId',c->>'streamId',seq,p_receipt->>'hash',p_receipt);
 RETURN jsonb_build_object('outcome','stored','verified',false);
END $$;
-- Client entry points (unchanged names, signatures and replies): SECURITY INVOKER wrappers.
CREATE FUNCTION public.recovery_v1_status(p_org_id text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp
 AS $$ SELECT recovery_v1.status(p_org_id) $$;
CREATE FUNCTION public.recovery_v1_transition(p_org_id text,p_state text,p_reason text,p_evidence_reference text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp
 AS $$ SELECT recovery_v1.transition(p_org_id,p_state,p_reason,p_evidence_reference) $$;
CREATE FUNCTION public.recovery_v1_store_evidence(p_envelope jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp
 AS $$ SELECT recovery_v1.store_evidence(p_envelope) $$;
CREATE FUNCTION public.recovery_v1_store_checkpoint(p_receipt jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp
 AS $$ SELECT recovery_v1.store_checkpoint(p_receipt) $$;
CREATE FUNCTION public.recovery_v1_offline_capability(p_org_id text, p_shop_id text, p_device_id text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp
 AS $$ SELECT recovery_v1.issue_offline_capability(p_org_id, p_shop_id, p_device_id) $$;
CREATE FUNCTION public.recovery_v1_revoke_device(p_org_id text, p_device_id text, p_reason text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp
 AS $$ SELECT recovery_v1.revoke_device(p_org_id, p_device_id, p_reason) $$;

DO $triggers$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['brands','business_profile','categories','price_levels','product_barcodes','products','shops','suppliers','unit_types','users','organizations','audit_logs','inventory','inventory_movements','price_tiers','product_image_upload_sessions','product_unit_prices','purchase_orders','refund_void_requests','sales','shifts','supplier_payments','stock_transfers','stock_transfer_items','product_units','purchase_order_items','sale_items','reprint_logs','supplier_products','app_config','platform_admins','product_costs','product_unit_costs','sale_item_costs','sale_payments','cash_movements','refund_lines','refund_payouts'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN
   INSERT INTO recovery_v1.guarded_tables(relid, relname, resolver) VALUES (to_regclass('public.'||t), t, 'builtin');
   EXECUTE format('CREATE TRIGGER zz_recovery_v1_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION recovery_v1.guard_write()',t);
   EXECUTE format('CREATE TRIGGER zz_recovery_v1_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.deny_truncate()',t);
   EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER zz_recovery_v1_write, ENABLE ALWAYS TRIGGER zz_recovery_v1_truncate',t);
  END IF;
 END LOOP;
END $triggers$;
CREATE TRIGGER zz_recovery_v1_ledger BEFORE INSERT OR UPDATE OR DELETE ON public.idempotency_keys FOR EACH ROW EXECUTE FUNCTION recovery_v1.guard_ledger();
CREATE TRIGGER zz_recovery_v1_truncate BEFORE TRUNCATE ON public.idempotency_keys FOR EACH STATEMENT EXECUTE FUNCTION recovery_v1.deny_truncate();
ALTER TABLE public.idempotency_keys ENABLE ALWAYS TRIGGER zz_recovery_v1_ledger, ENABLE ALWAYS TRIGGER zz_recovery_v1_truncate;
INSERT INTO recovery_v1.guarded_tables(relid, relname, resolver) VALUES ('public.idempotency_keys'::regclass, 'idempotency_keys', 'builtin');
-- No supported API or service_role may edit internal state/evidence, nor bypass
-- row guards using TRUNCATE/TRIGGER. Existing financial RPC ACLs stay intact.
REVOKE ALL ON ALL TABLES IN SCHEMA recovery_v1 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA recovery_v1 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA recovery_v1 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION recovery_v1.fence_key(text,text,text,text,uuid,text,text,text,text,text,uuid[]),recovery_v1.request_unfence(text,text,text,text,uuid,text,text,jsonb),recovery_v1.ledger_retention_report() TO orvix_recovery_operator;
REVOKE ALL ON FUNCTION public.recovery_v1_status(text),public.recovery_v1_transition(text,text,text,text),public.recovery_v1_store_evidence(jsonb),public.recovery_v1_store_checkpoint(jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.recovery_v1_status(text),public.recovery_v1_transition(text,text,text,text),public.recovery_v1_store_evidence(jsonb),public.recovery_v1_store_checkpoint(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION recovery_v1.status(text),recovery_v1.transition(text,text,text,text),recovery_v1.store_evidence(jsonb),recovery_v1.store_checkpoint(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.recovery_v1_offline_capability(text,text,text),public.recovery_v1_revoke_device(text,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.recovery_v1_offline_capability(text,text,text),public.recovery_v1_revoke_device(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION recovery_v1.issue_offline_capability(text,text,text),recovery_v1.revoke_device(text,text,text) TO authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON public.idempotency_keys FROM anon,authenticated,service_role;
REVOKE TRUNCATE,TRIGGER ON ALL TABLES IN SCHEMA public FROM anon,authenticated,service_role;
-- Preserve stage/guards across migration reruns. There is no approval-free
-- bypass GUC: applying 086/087 or future DDL needs a separately reviewed adapter.
CREATE FUNCTION recovery_v1.ddl_guard() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text; r record; ctx recovery_v1.authorized_txn; g recovery_v1.guarded_tables;
BEGIN
 -- The context of an owner-authorized migration of THIS transaction (recovery_v1.apply_authorized_migration writes it after
 -- verifying the owner's signature over the exact SQL; a session setting is never trusted).
 SELECT * INTO ctx FROM recovery_v1.authorized_txn WHERE txid = txid_current() AND purpose = 'migration';
 FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
  IF ctx.txid IS NOT NULL THEN
   IF r.schema_name IN ('recovery_v1','recovery','recovery_guard','pg_catalog','information_schema') THEN
    RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_SCOPE: an authorized migration never changes % objects (%)', r.schema_name, r.command_tag;
   END IF;
   IF ctx.ref NOT LIKE '%#guards' AND NOT (r.command_tag = ANY (ctx.allowed_commands)) THEN
    RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_SCOPE: % is not an authorized command of this migration', r.command_tag;
   END IF;
   IF r.schema_name='public' AND r.object_type IN('table','foreign table','materialized view') AND r.command_tag IN('CREATE TABLE','CREATE TABLE AS','SELECT INTO','CREATE FOREIGN TABLE','CREATE MATERIALIZED VIEW')
      AND NOT (split_part(r.object_identity, '.', 2) = ANY (ctx.new_tables)) THEN
    RAISE EXCEPTION 'RECOVERY_V1_MIGRATION_SCOPE: % is not an authorized new table of this migration', r.object_identity;
   END IF;
  ELSIF r.schema_name='public' AND r.object_type IN('table','foreign table','materialized view') AND r.command_tag IN('CREATE TABLE','CREATE TABLE AS','SELECT INTO','CREATE FOREIGN TABLE','CREATE MATERIALIZED VIEW') THEN
   -- No new public table outside an owner-authorized migration: it would take writes without any recovery guard.
   RAISE EXCEPTION 'RECOVERY_V1_UNGUARDED_TABLE_BLOCKED: no new public table while Recovery V1 is installed (%); use an owner-authorized migration', r.object_identity;
  END IF;
 END LOOP;
 SELECT string_agg(c.oid::regclass::text, ', ') INTO t FROM pg_class c CROSS JOIN recovery_v1.pins p
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','f','m') AND NOT (c.oid = ANY (p.public_tables))
    AND NOT (ctx.txid IS NOT NULL AND c.relname = ANY (ctx.new_tables));
 IF t IS NOT NULL THEN
  RAISE EXCEPTION 'RECOVERY_V1_UNGUARDED_TABLE_BLOCKED: public relation(s) % are not guarded by Recovery V1; use an owner-authorized migration', t;
 END IF;
 -- V1's own catalog is fixed (functions, relations and privileges, triggers, policies, rules): also GRANT/REVOKE and DROP
 -- statements, which carry no schema name or no command row, are caught here by their effect
 IF (SELECT v1_catalog FROM recovery_v1.pins) IS DISTINCT FROM recovery_v1.v1_catalog_state() THEN
  RAISE EXCEPTION 'RECOVERY_V1_SELF_CHANGE_BLOCKED: Recovery V1''s own objects are fixed while it is installed';
 END IF;
 -- a table inheriting from a guarded table would take rows that skip the row guards but appear in every read of the parent
 IF EXISTS(SELECT 1 FROM pg_inherits i CROSS JOIN recovery_v1.pins p
            WHERE (i.inhparent = ANY (p.public_tables) OR i.inhparent IN (SELECT relid FROM recovery_v1.guarded_tables))
              AND NOT (i.inhrelid = ANY (p.public_tables))) THEN
  RAISE EXCEPTION 'RECOVERY_V1_GUARD_CHANGE_BLOCKED: no table may inherit from a guarded table while Recovery V1 is installed';
 END IF;
 -- the recovery trigger rows on the pinned tables are fixed (no new, replaced, re-enabled or dropped one)
 IF EXISTS(SELECT 1 FROM recovery_v1.pins p WHERE p.guard_triggers IS DISTINCT FROM recovery_v1.guard_triggers_state(p.public_tables)) THEN
  RAISE EXCEPTION 'RECOVERY_V1_GUARD_CHANGE_BLOCKED: recovery triggers on the guarded tables are fixed while Recovery V1 is installed';
 END IF;
 -- V1's own public entry points are fixed (owner, security, settings, body, privileges; no new one)
 IF (SELECT entry_fingerprint FROM recovery_v1.pins) IS DISTINCT FROM recovery_v1.entry_fingerprint() THEN
  RAISE EXCEPTION 'RECOVERY_V1_ENTRY_POINT_CHANGE_BLOCKED: the public recovery_v1_* functions are fixed while Recovery V1 is installed';
 END IF;
 -- 087 adopted: no DDL may change, replace, disable or remove any 087 object (its rollback would also
 -- drop every zz_recovery_* trigger, V1's included, and restore pre-V1 grants). Not adopted: no
 -- DDL at all while an 087 schema exists.
 IF EXISTS(SELECT 1 FROM recovery_v1.adapter_087) THEN
  IF recovery_v1.m087_fingerprint() IS DISTINCT FROM (SELECT fingerprint FROM recovery_v1.adapter_087)
     OR recovery_v1.m087_fingerprint(true) IS DISTINCT FROM (SELECT full_fingerprint FROM recovery_v1.adapter_087) THEN
   RAISE EXCEPTION 'RECOVERY_V1_087_CHANGE_BLOCKED: migration 087 objects are fixed while Recovery V1 is installed';
  END IF;
 ELSIF to_regnamespace('recovery') IS NOT NULL OR to_regnamespace('recovery_guard') IS NOT NULL THEN RAISE EXCEPTION 'RECOVERY_V1_087_ADAPTER_REQUIRED'; END IF;
 IF (SELECT idem_body_md5 FROM recovery_v1.install) IS DISTINCT FROM (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.idem_begin(uuid,text,text)'))
 OR (SELECT string_agg(a.attname,',' ORDER BY k.n) FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(att,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.att WHERE c.conrelid='public.idempotency_keys'::regclass AND c.contype='p')
 IS DISTINCT FROM (SELECT CASE stage WHEN 85 THEN 'key' ELSE 'org_id,key' END FROM recovery_v1.install) THEN RAISE EXCEPTION 'RECOVERY_V1_IDEMPOTENCY_STAGE_CHANGE_BLOCKED'; END IF;
 -- every registered guarded table still exists with both V1 guards enabled ALWAYS
 FOR g IN SELECT * FROM recovery_v1.guarded_tables LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=g.relid AND relname=g.relname AND relnamespace='public'::regnamespace) THEN
   RAISE EXCEPTION 'RECOVERY_V1_GUARD_CHANGE_BLOCKED: guarded table % was dropped, renamed or moved', g.relname;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=g.relid AND tgname=CASE g.relname WHEN 'idempotency_keys' THEN 'zz_recovery_v1_ledger' ELSE 'zz_recovery_v1_write' END AND tgenabled='A')
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=g.relid AND tgname='zz_recovery_v1_truncate' AND tgenabled='A') THEN
   RAISE EXCEPTION 'RECOVERY_V1_GUARD_CHANGE_BLOCKED: %', g.relname;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION recovery_v1.ddl_guard() FROM PUBLIC,anon,authenticated,service_role;
-- 087 adoption (087 present; preconditions and the pinned fingerprint were checked above):
-- the public wrappers are owned by recovery_owner (087's registry requires it of every public
-- recovery_% function), the 087 snapshot is re-registered over V1's DDL (V1's triggers and
-- grant changes on 087-guarded tables), and the adopted 087's identity is recorded.
IF to_regnamespace('recovery') IS NOT NULL THEN
 ALTER FUNCTION public.recovery_v1_status(text) OWNER TO recovery_owner;
 ALTER FUNCTION public.recovery_v1_transition(text,text,text,text) OWNER TO recovery_owner;
 ALTER FUNCTION public.recovery_v1_store_evidence(jsonb) OWNER TO recovery_owner;
 ALTER FUNCTION public.recovery_v1_store_checkpoint(jsonb) OWNER TO recovery_owner;
 ALTER FUNCTION public.recovery_v1_offline_capability(text,text,text) OWNER TO recovery_owner;
 ALTER FUNCTION public.recovery_v1_revoke_device(text,text,text) OWNER TO recovery_owner;
 PERFORM recovery_guard.register_guards();
 -- the stored baseline is the PINNED value, never a recomputation (a change made during the install is refused here)
 IF recovery_v1.m087_fingerprint() IS DISTINCT FROM '3406f665ad19c883798e40d607412c4d' THEN
  RAISE EXCEPTION 'RECOVERY_V1_087_UNKNOWN_VERSION: 087 changed during the install (fingerprint %); refusing', recovery_v1.m087_fingerprint();
 END IF;
 IF recovery_v1.m087_fingerprint(true) IS DISTINCT FROM current_setting('orvix.recovery_v1_m087_full') THEN
  RAISE EXCEPTION 'RECOVERY_V1_087_UNKNOWN_VERSION: 087 privileges changed during the install; refusing';
 END IF;
 INSERT INTO recovery_v1.adapter_087(fingerprint,full_fingerprint,recovery_nsp,guard_nsp,ddl_evt)
 SELECT '3406f665ad19c883798e40d607412c4d',current_setting('orvix.recovery_v1_m087_full'),to_regnamespace('recovery')::oid,to_regnamespace('recovery_guard')::oid,
        (SELECT oid FROM pg_event_trigger WHERE evtname='zz_recovery_ddl_guard');
 INSERT INTO recovery_v1.audit(org_id,kind,detail) SELECT NULL,'migration_087_adopted',jsonb_build_object('fingerprint',fingerprint,'fence_path','087 decision flow only') FROM recovery_v1.adapter_087;
END IF;
CREATE EVENT TRIGGER zz_recovery_v1_ddl ON ddl_command_end EXECUTE FUNCTION recovery_v1.ddl_guard();
ALTER EVENT TRIGGER zz_recovery_v1_ddl ENABLE ALWAYS;
-- last: pin the entry points and the event trigger rows as they are now
INSERT INTO recovery_v1.pins(entry_fingerprint,guard_triggers,public_tables,event_triggers,v1_catalog)
SELECT recovery_v1.entry_fingerprint(),
       recovery_v1.guard_triggers_state(ARRAY(SELECT c.oid FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','f','m'))),
       ARRAY(SELECT c.oid FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','f','m') ORDER BY c.oid), jsonb_agg(jsonb_build_object('name',e.evtname,'oid',e.oid,'foid',e.evtfoid,'xmin',e.xmin::text) ORDER BY e.evtname),
       recovery_v1.v1_catalog_state()
  FROM pg_event_trigger e WHERE e.evtname='zz_recovery_v1_ddl' OR (e.evtname='zz_recovery_ddl_guard' AND EXISTS(SELECT 1 FROM recovery_v1.adapter_087));
END $rv1install$;
SELECT pg_temp.recovery_v1_install(:'recovery_v1_install_ack', :'recovery_v1_owner_public_key', :'recovery_v1_offline_defaults');
DROP FUNCTION pg_temp.recovery_v1_install(text, text, text);
COMMIT;
