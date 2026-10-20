-- ============================================================
-- Migration 087: recovery hold and rollback detection (hold + detection ONLY)
--                (design, threat model, tests, rollout, rollback and limits:
--                docs/selfhost-migration/phase-g/migration-087.md)
--
-- WHY
--   A restored database (physical, PITR, logical, same-server reload) silently loses committed
--   operations and keeps serving tills, which then re-send, re-fence or re-price old work. 087 makes
--   every restore, restart and rollback FAIL CLOSED until people with evidence decide, and gives the
--   tills a server-issued cutoff (epoch) so nothing created before a recovery runs automatically.
--
-- WHAT IT DOES
--   1. Server-wide gate on every guarded write: identity (system id, timeline, database OID), a
--      LEASE that is valid only if present, unexpired, issued after THIS server start and written by
--      its issuing transaction (a restored/copied row has another xmin), and state 'open'.
--   2. The lease is renewed ONLY by the off-host witness authority (role recovery_authority; tools in
--      tools/recovery-authority/). One genesis per install, increasing sequence numbers, a per-renewal
--      secret token whose hash the signed intent carries (a renewal by anyone else is detectable), a
--      public-schema canary renewed with the lease, two-person owner anchors after every server start.
--   3. Per-organisation hold and server-issued epoch (recovery.org_state). Releasing a hold is NOT
--      part of 087 (088); nothing in 087 reopens an organisation after an epoch change.
--   4. Hold enforcement: ENABLE ALWAYS AFTER-row guards + BEFORE TRUNCATE guards on 30 organisation
--      tables and 2 platform tables; every organisation a row touches is resolved; an event trigger
--      refuses non-superuser DDL on guarded tables and the canary and any change of their triggers,
--      columns, defaults, ACLs, policies, indexes, rules, inheritance, names or schema, and any drop,
--      replacement or overload of the public 087 functions (schema recovery_guard, superuser-owned).
--   5. Ledger evidence: public.idempotency_keys rows are chained per organisation (hash chain) and
--      can no longer be deleted, truncated or rewritten (only response / response_purged_at may
--      change). 086's prune therefore deletes nothing while 087 is installed.
--   6. Legacy paths closed at install: executor RPCs only through op_execute_v87 / op_status_v87;
--      API table writes must carry x-orvix-epoch = the organisation's epoch at creation.
--   7. Tills: registered by an MFA org ADMIN, unreconciled until an MFA ADMIN who did not submit their
--      journal approves a COMPLETE journal (chunks 1..n, the last one final); a till receives an epoch
--      ONLY while its organisation is not held and the server accepts writes. Journals are evidence
--      (never deleted on quota); their keys are quarantined. Fence decisions: proposed (and withdrawable)
--      by the MFA org ADMIN for a journaled operation of one till, bound to (org, key, rpc, args digest,
--      actor, op epoch, till), approved ONLY by the infrastructure owner in a superuser session, naming
--      two people and restating the whole operation (no API role, JWT or GoTrue identity can approve),
--      consumed once.
--   8. Every refusal: SQLSTATE PT429 -> HTTP 429, fixed ASCII
--      'ORG_SUSPENDED: server recovery in progress [CODE]'.
--   Installs HELD (no lease, state 'hold'): owner anchor -> authority genesis -> till reconciliation
--   -> smoke -> owner_open (two people).
--
-- NOT IN 087 (088): restoring financial outcomes, receipt-number continuity, bulk approval, reopening.
-- Runs ONLY through deploy/lucashome/apply-migrations.sh (one transaction + its ledger row), as
-- supabase_admin. Rollback: supabase/rollbacks/087_recovery_hold.rollback.sql (keeps all evidence).
-- ============================================================

-- ------------------------------------------------------------ 0/9 preflight
-- v87.x correction (2026-10-19, before 087 was applied to any real server): the recovery roles must be protected from
-- the Supabase privileged role BEFORE anything is created. supautils lets `postgres` (via supabase_privileged_role)
-- ALTER any role that is not listed in supautils.reserved_roles — e.g. give recovery_owner LOGIN and a password and
-- log in as it — and lets it create event triggers, which then run AS recovery_owner inside this file's
-- `SET ROLE recovery_owner` DDL. Required: recovery_owner, recovery_authority and recovery_gate in
-- supautils.reserved_roles (host configuration; deploy/lucashome/db-conf/20-recovery-reserved-roles.conf and
-- docs/selfhost-migration/phase-g/recovery-roles-prerequisite.md), no event trigger that is owned by, or runs a
-- function owned by, a non-superuser; then the roles are PROBED below (fail closed: any role that can still alter
-- them stops the migration). Superusers are not constrained by any of this (infrastructure trust).
-- FIRST, before any other statement: no event trigger can appear while this transaction runs (CREATE EVENT TRIGGER
-- waits on this lock), and objects a non-superuser may plant in public / extensions (functions, operators) are never
-- resolved by unqualified names in this migration (event trigger functions without their own search_path, too).
LOCK TABLE pg_catalog.pg_event_trigger IN EXCLUSIVE MODE;
SET LOCAL search_path = pg_catalog, pg_temp;
-- every pre-existing event trigger is DISABLED for this transaction and re-enabled with its own mode at the end of this
-- file: none of their code (nor anything it calls) can run as recovery_owner inside the SET ROLE DDL below
DO $evt_off$
DECLARE e record; v_saved jsonb := '[]';
BEGIN
  FOR e IN SELECT evtname, evtenabled FROM pg_catalog.pg_event_trigger WHERE evtenabled <> 'D' ORDER BY evtname LOOP
    v_saved := v_saved || pg_catalog.jsonb_build_object('n', e.evtname::text, 'm', e.evtenabled::text);
    EXECUTE pg_catalog.format('ALTER EVENT TRIGGER %I DISABLE', e.evtname);
  END LOOP;
  PERFORM pg_catalog.set_config('m087.event_triggers', v_saved::text, true);
END $evt_off$;
DO $pre$
DECLARE v_reserved text[]; v_missing text[]; v_evt text; v_supautils boolean;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION '087 preflight: must run as the superuser migration runner (supabase_admin)';
  END IF;
  -- supautils present (loaded, or any of its settings defined): the recovery roles must be listed as reserved, exactly (no '*')
  v_supautils := current_setting('supautils.privileged_role', true) IS NOT NULL OR current_setting('supautils.reserved_roles', true) IS NOT NULL
    OR 'supautils' = ANY (ARRAY(SELECT btrim(x) FROM unnest(string_to_array(current_setting('session_preload_libraries') || ',' || current_setting('shared_preload_libraries'), ',')) x));
  IF v_supautils AND current_setting('supautils.privileged_role', true) IS NULL THEN
    RAISE EXCEPTION '087 preflight: supautils is loaded but supautils.privileged_role is not readable (renamed setting?): the protection of the recovery roles cannot be verified';
  END IF;
  IF v_supautils THEN
    v_reserved := ARRAY(SELECT btrim(x) FROM unnest(string_to_array(coalesce(current_setting('supautils.reserved_roles', true), ''), ',')) x);
    v_missing := ARRAY(SELECT r FROM unnest(ARRAY['recovery_owner', 'recovery_authority', 'recovery_gate']) r WHERE NOT r = ANY (v_reserved));
    IF cardinality(v_missing) > 0 THEN
      RAISE EXCEPTION '087 preflight: supautils.reserved_roles does not list %: the Supabase privileged role could alter them (log in as recovery_owner). Configure the reserved roles first (docs/selfhost-migration/phase-g/recovery-roles-prerequisite.md)',
        array_to_string(v_missing, ', ');
    END IF;
  END IF;
  -- no event trigger a non-superuser controls (it would run as recovery_owner inside this migration's DDL)
  SELECT string_agg(e.evtname::text || ' (owner ' || e.evtowner::regrole::text || ', function owner ' || p.proowner::regrole::text || ')', ', ') INTO v_evt
    FROM pg_event_trigger e JOIN pg_proc p ON p.oid = e.evtfoid
   WHERE NOT (SELECT rolsuper FROM pg_roles WHERE oid = e.evtowner) OR NOT (SELECT rolsuper FROM pg_roles WHERE oid = p.proowner);
  IF v_evt IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: event trigger(s) controlled by a non-superuser exist: %. Remove them (superuser) before installing 087', v_evt;
  END IF;
  IF to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NULL OR to_regprocedure('public.op_status(uuid,text,boolean,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '087 preflight: migration 086 (op_execute / op_status) is not applied';
  END IF;
  IF to_regnamespace('recovery') IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: schema recovery already exists (087 applied, or a rollback did not archive it)';
  END IF;
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: schema recovery_guard already exists (087 applied, or a rollback did not remove it)';
  END IF;
  IF to_regclass('public.zz_recovery_canary') IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: public.zz_recovery_canary already exists';
  END IF;
  -- every public relation this migration reads or guards is a plain table (a view swapped in by its owner would run
  -- that owner's functions in this superuser transaction)
  SELECT string_agg(t, ', ') INTO v_evt FROM unnest(ARRAY['brands','business_profile','categories','idempotency_keys','price_levels',
      'product_barcodes','products','shops','suppliers','unit_types','users','organizations','audit_logs','inventory','inventory_movements',
      'price_tiers','product_image_upload_sessions','product_unit_prices','purchase_orders','refund_void_requests','sales','shifts',
      'supplier_payments','stock_transfers','stock_transfer_items','product_units','purchase_order_items','sale_items','reprint_logs',
      'supplier_products','app_config','platform_admins']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = t AND c.relkind IN ('r', 'p'));
  IF v_evt IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: not plain tables in public: %', v_evt;
  END IF;
END $pre$;

-- ACLs of every public relation and of the prune function BEFORE 087 changes any grant (the rollback restores these exactly)
CREATE TEMP TABLE m087_acl0 ON COMMIT DROP AS
  SELECT c.oid AS relid, c.relname::text AS relname, c.relkind::text AS relkind, c.relacl::text AS relacl
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S');
CREATE TEMP TABLE m087_fnacl0 ON COMMIT DROP AS
  SELECT p.oid AS fnid, p.oid::regprocedure::text AS fn, p.proacl::text AS proacl FROM pg_proc p
   WHERE p.oid = 'public.prune_idempotency_keys()'::regprocedure;

-- ------------------------------------------------------------ 1/9 roles and schema
DO $r$ BEGIN   -- idempotent: a rolled-back 087 keeps its roles (they own the archived evidence)
  -- v87.x: recovery roles may pre-exist ONLY as the roles of a rolled-back 087 (an archive schema they own); roles
  -- created by anyone else (e.g. `postgres` before the roles were reserved) may carry planted objects or privileges
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('recovery_owner', 'recovery_authority', 'recovery_gate'))
     AND NOT EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner
                      WHERE n.nspname ~ '^recovery_archived_087_[0-9]{8}t[0-9]{6}$' AND o.rolname = 'recovery_owner') THEN
    RAISE EXCEPTION '087 preflight: recovery roles exist but no rolled-back 087 archive does: they were not created by 087. A superuser must drop them (after checking what they own) before installing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recovery_owner') THEN
    CREATE ROLE recovery_owner NOLOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE BYPASSRLS; END IF;   -- owns every 087 object
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recovery_authority') THEN
    CREATE ROLE recovery_authority LOGIN NOSUPERUSER NOINHERIT; END IF;                                  -- the OFF-HOST witness authority
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recovery_gate') THEN
    CREATE ROLE recovery_gate LOGIN NOSUPERUSER NOINHERIT; END IF;                                       -- the read-only restore gate
  -- a rollback sets both NOLOGIN. v87.x: attributes normalised and any password cleared (a credential set while a
  -- rolled-back install's roles were unprotected is not trusted): the owner provisions the logins after installing
  ALTER ROLE recovery_authority LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD NULL VALID UNTIL 'infinity' CONNECTION LIMIT -1;
  ALTER ROLE recovery_gate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD NULL VALID UNTIL 'infinity' CONNECTION LIMIT -1;
END $r$;
-- v87.x: the recovery roles as they exist now (a rolled-back 087 keeps them): recovery_owner without login or password,
-- no non-superuser member of any of them, no membership / setting / elevated attribute of their own, nothing of theirs
-- outside a rolled-back 087 archive; then an ACTIVE probe: every role that could manage roles (the supautils privileged
-- role and its members, and every non-superuser with CREATEROLE) tries to ALTER, ALTER ... SET, RENAME and DROP each
-- recovery role and to GRANT it to itself, each attempt in its own rolled-back subtransaction. Any success stops the
-- migration (fail closed).
DO $probe$
DECLARE v_bad text; r text; x text; v_hits text[] := '{}';
  v_owner oid := (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner');
  v_arch oid[];
BEGIN
  IF (SELECT rolcanlogin OR rolpassword IS NOT NULL OR rolsuper OR rolcreaterole FROM pg_authid WHERE rolname = 'recovery_owner') THEN
    RAISE EXCEPTION '087 preflight: recovery_owner has a login, a password or elevated attributes (it may have been altered): a superuser must reset it (ALTER ROLE recovery_owner NOLOGIN PASSWORD NULL NOCREATEROLE) before installing';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'recovery_owner') THEN   -- 087 creates it BYPASSRLS; a rollback keeps it
    RAISE EXCEPTION '087 preflight: recovery_owner is not as 087 creates it (no BYPASSRLS): it was not created by 087 or has been altered; a superuser must investigate before installing';
  END IF;
  SELECT string_agg(m.member::regrole::text || ' in ' || m.roleid::regrole::text, ', ') INTO v_bad FROM pg_auth_members m
   WHERE m.roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('recovery_owner', 'recovery_authority', 'recovery_gate'))
     AND NOT (SELECT rolsuper FROM pg_roles WHERE oid = m.member);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: non-superuser members of the recovery roles: % (a superuser must revoke them before installing)', v_bad;
  END IF;
  -- the recovery roles themselves: no memberships, no role / database settings, no elevated attributes
  SELECT string_agg(m.member::regrole::text || ' in ' || m.roleid::regrole::text, ', ') INTO v_bad FROM pg_auth_members m
   WHERE m.member IN (SELECT oid FROM pg_roles WHERE rolname IN ('recovery_owner', 'recovery_authority', 'recovery_gate'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: recovery roles are members of other roles: % (a superuser must revoke them before installing)', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_db_role_setting s JOIN pg_roles g ON g.oid = s.setrole WHERE g.rolname IN ('recovery_owner', 'recovery_authority', 'recovery_gate'))
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('recovery_owner', 'recovery_authority', 'recovery_gate')
                  AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION '087 preflight: a recovery role has per-role settings or elevated attributes (it may have been altered): a superuser must reset it before installing';
  END IF;
  -- the rolled-back 087 archives: the rollback's exact schema name, owned by recovery_owner. Any other schema with the archive
  -- prefix is refused (a name alone can be forged).
  v_arch := ARRAY(SELECT n.oid FROM pg_namespace n WHERE n.nspname ~ '^recovery_archived_087_[0-9]{8}t[0-9]{6}$' AND n.nspowner = v_owner);
  SELECT string_agg(quote_ident(n.nspname) || ' (owner ' || n.nspowner::regrole::text || ')', ', ') INTO v_bad FROM pg_namespace n
   WHERE n.nspname LIKE 'recovery\_archived\_087\_%' AND n.oid <> ALL (v_arch);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: a recovery archive schema is not as a 087 rollback leaves it: schema % (a superuser must investigate before installing)', v_bad;
  END IF;
  -- nothing owned by, granted to, or default-granted for a recovery role outside a rolled-back 087 archive schema (in any database)
  SELECT string_agg(d.classid::regclass::text || ':' || d.objid::text || ' (' || d.deptype::text || ' ' || d.refobjid::regrole::text || ')', ', ') INTO v_bad
    FROM pg_shdepend d
   WHERE d.refclassid = 'pg_authid'::regclass
     AND d.refobjid IN (SELECT oid FROM pg_roles WHERE rolname IN ('recovery_owner', 'recovery_authority', 'recovery_gate'))
     AND (d.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database()) OR NOT coalesce(
           CASE d.classid
             WHEN 'pg_namespace'::regclass THEN d.objid
             WHEN 'pg_class'::regclass THEN (SELECT relnamespace FROM pg_class WHERE oid = d.objid)
             WHEN 'pg_proc'::regclass THEN (SELECT pronamespace FROM pg_proc WHERE oid = d.objid)
             WHEN 'pg_type'::regclass THEN (SELECT typnamespace FROM pg_type WHERE oid = d.objid)
             WHEN 'pg_default_acl'::regclass THEN (SELECT nullif(defaclnamespace, 0) FROM pg_default_acl WHERE oid = d.objid)
           END = ANY (v_arch), false));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: objects, grants or default privileges of the recovery roles exist outside a rolled-back 087 archive: % (a superuser must remove them before installing)', v_bad;
  END IF;
  -- ... and an archive holds only the kinds of objects the rollback leaves (allow-list of object kinds, measured on a real
  -- rollback); anything else refuses:
  -- schema privileges: the owner's, and USAGE (no grant option) for authenticated, recovery_authority, recovery_gate (087's grants);
  -- relations: ALL of the 087 tables and no other table, sequences owned by a column of them, indexes on them; permanent, not
  --   partitions, owned by recovery_owner, with no privilege (table, sequence, column) held by or granted by any other role;
  -- types: the row types of those tables and their array types only, owned by recovery_owner, no privilege beyond the
  --   PostgreSQL default (PUBLIC USAGE);
  -- constraints: primary key, unique, check, not-null on those tables;
  -- dependencies: of its objects only on objects of the same archive (built-in objects are pinned and never recorded): no
  --   default, check, index expression, column type, collation or access method outside it; none of the schema itself
  --   (e.g. extension membership);
  -- nothing else in it or attached to it: function, operator, operator class / family, collation, conversion, text search
  --   object, extension, statistics object, trigger, rule, policy, inheritance, publication, subscription target, default privilege.
  SELECT string_agg(z.item, ', ') INTO v_bad FROM (
    SELECT 'missing 087 table ' || quote_ident(n.nspname) || '.' || t AS item
      FROM pg_namespace n CROSS JOIN unnest(ARRAY['settings', 'continuity', 'lease', 'anchor_permit', 'install', 'org_state', 'epoch_history', 'events',
             'org_chain', 'chain_log', 'keys', 'v87_txn', 'executor_rpcs', 'tills', 'journal', 'quarantine', 'quota', 'till_reconciliations',
             'decisions', 'acl_snapshot', 'fn_acl_snapshot', 'zz_recovery_canary']) t
     WHERE n.oid = ANY (v_arch) AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = t AND c.relkind = 'r')
    UNION ALL
    SELECT 'dependency of schema ' || quote_ident(n.nspname) || ' on ' || pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid)
      FROM pg_depend d JOIN pg_namespace n ON n.oid = d.objid WHERE d.classid = 'pg_namespace'::regclass AND d.objid = ANY (v_arch)
    UNION ALL
    SELECT 'schema privilege ' || a.privilege_type || ' of ' || n.nspname::text || ' for ' || CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS item
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
     WHERE n.oid = ANY (v_arch)
       AND NOT (a.grantor = v_owner AND (a.grantee = v_owner OR (a.privilege_type = 'USAGE' AND NOT a.is_grantable
                AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('authenticated', 'recovery_authority', 'recovery_gate')))))
    UNION ALL
    SELECT 'relation ' || c.oid::regclass::text || ' (kind ' || c.relkind::text || ', owner ' || c.relowner::regrole::text || ')' FROM pg_class c
     WHERE c.relnamespace = ANY (v_arch)
       AND NOT (c.relowner = v_owner AND c.relpersistence = 'p' AND NOT c.relispartition AND (
             (c.relkind = 'r' AND c.relname IN ('settings', 'continuity', 'lease', 'anchor_permit', 'install', 'org_state', 'epoch_history', 'events',
                'org_chain', 'chain_log', 'keys', 'v87_txn', 'executor_rpcs', 'tills', 'journal', 'quarantine', 'quota', 'till_reconciliations',
                'decisions', 'acl_snapshot', 'fn_acl_snapshot', 'zz_recovery_canary'))
          OR (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
                                           WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass
                                             AND d.deptype = 'a' AND t.relnamespace = c.relnamespace AND t.relkind = 'r'))
          OR (c.relkind = 'i' AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
                                           WHERE i.indexrelid = c.oid AND t.relnamespace = c.relnamespace AND t.relkind = 'r'))))
    UNION ALL
    SELECT 'privilege ' || a.privilege_type || ' on ' || c.oid::regclass::text || ' for ' || CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = ANY (v_arch) AND (a.grantee <> v_owner OR a.grantor <> v_owner)
    UNION ALL
    SELECT 'column privilege ' || a.privilege_type || ' on ' || c.oid::regclass::text || '.' || t.attname::text || ' for '
           || CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
      FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid CROSS JOIN LATERAL aclexplode(t.attacl) a
     WHERE c.relnamespace = ANY (v_arch) AND (a.grantee <> v_owner OR a.grantor <> v_owner)
    UNION ALL
    SELECT 'type ' || t.oid::regtype::text FROM pg_type t
     WHERE t.typnamespace = ANY (v_arch)
       AND NOT (t.typowner = v_owner
                AND ((t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relnamespace = t.typnamespace AND c.relkind = 'r'))
                  OR (t.typcategory = 'A' AND EXISTS (SELECT 1 FROM pg_type e JOIN pg_class c ON c.oid = e.typrelid
                                                       WHERE e.oid = t.typelem AND e.typarray = t.oid AND e.typtype = 'c'
                                                         AND c.relnamespace = t.typnamespace AND c.relkind = 'r')))
                AND NOT EXISTS (SELECT 1 FROM aclexplode(t.typacl) a        -- the default only: the owner's, and USAGE for PUBLIC
                                 WHERE NOT (a.grantor = v_owner AND (a.grantee = v_owner OR (a.grantee = 0 AND a.privilege_type = 'USAGE' AND NOT a.is_grantable)))))
    UNION ALL
    SELECT 'constraint ' || k.conname::text || ' (' || k.contype::text || ')' FROM pg_constraint k
     WHERE k.connamespace = ANY (v_arch)
       AND NOT (k.contype IN ('p', 'u', 'c', 'n') AND k.contypid = 0
                AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = k.conrelid AND c.relnamespace = k.connamespace AND c.relkind = 'r'))
    UNION ALL
    SELECT 'dependency of ' || pg_describe_object(d.classid, d.objid, d.objsubid) || ' on ' || pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid)
      FROM pg_depend d
      JOIN LATERAL (SELECT CASE d.classid
             WHEN 'pg_class'::regclass THEN (SELECT relnamespace FROM pg_class WHERE oid = d.objid)
             WHEN 'pg_type'::regclass THEN (SELECT typnamespace FROM pg_type WHERE oid = d.objid)
             WHEN 'pg_constraint'::regclass THEN (SELECT connamespace FROM pg_constraint WHERE oid = d.objid)
             WHEN 'pg_attrdef'::regclass THEN (SELECT c.relnamespace FROM pg_attrdef f JOIN pg_class c ON c.oid = f.adrelid WHERE f.oid = d.objid)
           END AS ns) o ON o.ns = ANY (v_arch)
     WHERE d.classid IN ('pg_class'::regclass, 'pg_type'::regclass, 'pg_constraint'::regclass, 'pg_attrdef'::regclass)
       AND o.ns IS DISTINCT FROM CASE d.refclassid
             WHEN 'pg_namespace'::regclass THEN d.refobjid
             WHEN 'pg_class'::regclass THEN (SELECT relnamespace FROM pg_class WHERE oid = d.refobjid)
             WHEN 'pg_type'::regclass THEN (SELECT typnamespace FROM pg_type WHERE oid = d.refobjid)
             WHEN 'pg_constraint'::regclass THEN (SELECT connamespace FROM pg_constraint WHERE oid = d.refobjid)
           END
    UNION ALL SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = ANY (v_arch)
    UNION ALL SELECT 'operator ' || o.oid::regoperator::text FROM pg_operator o WHERE o.oprnamespace = ANY (v_arch)
    UNION ALL SELECT 'operator class ' || opcname::text FROM pg_opclass WHERE opcnamespace = ANY (v_arch)
    UNION ALL SELECT 'operator family ' || opfname::text FROM pg_opfamily WHERE opfnamespace = ANY (v_arch)
    UNION ALL SELECT 'collation ' || collname::text FROM pg_collation WHERE collnamespace = ANY (v_arch)
    UNION ALL SELECT 'conversion ' || conname::text FROM pg_conversion WHERE connamespace = ANY (v_arch)
    UNION ALL SELECT 'text search configuration ' || cfgname::text FROM pg_ts_config WHERE cfgnamespace = ANY (v_arch)
    UNION ALL SELECT 'text search dictionary ' || dictname::text FROM pg_ts_dict WHERE dictnamespace = ANY (v_arch)
    UNION ALL SELECT 'text search parser ' || prsname::text FROM pg_ts_parser WHERE prsnamespace = ANY (v_arch)
    UNION ALL SELECT 'text search template ' || tmplname::text FROM pg_ts_template WHERE tmplnamespace = ANY (v_arch)
    UNION ALL SELECT 'extension ' || extname::text FROM pg_extension WHERE extnamespace = ANY (v_arch)
    UNION ALL SELECT 'statistics object ' || s.stxname::text FROM pg_statistic_ext s
               WHERE s.stxnamespace = ANY (v_arch) OR s.stxrelid IN (SELECT oid FROM pg_class WHERE relnamespace = ANY (v_arch))
    UNION ALL SELECT 'trigger ' || t.tgname::text || ' on ' || t.tgrelid::regclass::text FROM pg_trigger t
               WHERE t.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = ANY (v_arch))
    UNION ALL SELECT 'rule ' || w.rulename::text || ' on ' || w.ev_class::regclass::text FROM pg_rewrite w
               WHERE w.ev_class IN (SELECT oid FROM pg_class WHERE relnamespace = ANY (v_arch))
    UNION ALL SELECT 'policy ' || p.polname::text || ' on ' || p.polrelid::regclass::text FROM pg_policy p
               WHERE p.polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = ANY (v_arch))
    UNION ALL SELECT 'inheritance ' || i.inhrelid::regclass::text || ' of ' || i.inhparent::regclass::text FROM pg_inherits i
               WHERE i.inhrelid IN (SELECT oid FROM pg_class WHERE relnamespace = ANY (v_arch)) OR i.inhparent IN (SELECT oid FROM pg_class WHERE relnamespace = ANY (v_arch))
    UNION ALL SELECT 'publication of ' || r.prrelid::regclass::text FROM pg_publication_rel r
               WHERE r.prrelid IN (SELECT oid FROM pg_class WHERE relnamespace = ANY (v_arch))
    UNION ALL SELECT 'publication of schema ' || n.pnnspid::regnamespace::text FROM pg_publication_namespace n WHERE n.pnnspid = ANY (v_arch)
    UNION ALL SELECT 'subscription target ' || s.srrelid::regclass::text FROM pg_subscription_rel s
               WHERE s.srrelid IN (SELECT oid FROM pg_class WHERE relnamespace = ANY (v_arch))
    UNION ALL SELECT 'default privilege of ' || d.defaclrole::regrole::text || ' in ' || d.defaclnamespace::regnamespace::text FROM pg_default_acl d
               WHERE d.defaclnamespace = ANY (v_arch)) z;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '087 preflight: a recovery archive schema is not as a 087 rollback leaves it: % (a superuser must investigate before installing)', v_bad;
  END IF;
  -- probed: every non-superuser that can manage roles (CREATEROLE) or is the supautils privileged role / a member of it
  FOR r IN SELECT DISTINCT g.rolname FROM pg_roles g
            WHERE NOT g.rolsuper AND (g.rolcreaterole OR g.rolname = current_setting('supautils.privileged_role', true)
                  OR (current_setting('supautils.privileged_role', true) IS NOT NULL AND to_regrole(current_setting('supautils.privileged_role', true)) IS NOT NULL
                      AND pg_has_role(g.oid, to_regrole(current_setting('supautils.privileged_role', true)), 'MEMBER'))) ORDER BY 1 LOOP
    FOREACH x IN ARRAY ARRAY['recovery_owner', 'recovery_authority', 'recovery_gate'] LOOP
      -- (becoming a recovery role needs membership — refused above from pg_auth_members; SET ROLE cannot be probed from
      -- here: PostgreSQL authorises it against the SESSION user, the superuser runner)
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', r);
        EXECUTE format('ALTER ROLE %I SET work_mem = %L', x, '1MB');
        RAISE EXCEPTION USING MESSAGE = 'm087_probe_succeeded';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'm087_probe_succeeded' THEN v_hits := v_hits || (r || ' can ALTER ROLE SET on ' || x); END IF;
      END;
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', r);
        EXECUTE format('ALTER ROLE %I RENAME TO %I', x, x || '_m087probe');
        RAISE EXCEPTION USING MESSAGE = 'm087_probe_succeeded';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'm087_probe_succeeded' THEN v_hits := v_hits || (r || ' can RENAME ' || x); END IF;
      END;
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', r);
        EXECUTE format('DROP ROLE %I', x);
        RAISE EXCEPTION USING MESSAGE = 'm087_probe_succeeded';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'm087_probe_succeeded' THEN v_hits := v_hits || (r || ' can DROP ' || x); END IF;
      END;
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', r);
        EXECUTE format('ALTER ROLE %I CONNECTION LIMIT 1', x);
        RAISE EXCEPTION USING MESSAGE = 'm087_probe_succeeded';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'm087_probe_succeeded' THEN v_hits := v_hits || (r || ' can ALTER ' || x); END IF;
      END;
      BEGIN
        EXECUTE format('SET LOCAL ROLE %I', r);
        EXECUTE format('GRANT %I TO %I', x, r);
        RAISE EXCEPTION USING MESSAGE = 'm087_probe_succeeded';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM = 'm087_probe_succeeded' THEN v_hits := v_hits || (r || ' can GRANT itself ' || x); END IF;
      END;
    END LOOP;
  END LOOP;
  IF session_user <> current_user THEN RAISE EXCEPTION '087 preflight: the probe did not restore the runner role'; END IF;
  IF cardinality(v_hits) > 0 THEN
    RAISE EXCEPTION '087 preflight: the recovery roles are NOT protected: %. Add them to supautils.reserved_roles (docs/selfhost-migration/phase-g/recovery-roles-prerequisite.md)',
      array_to_string(v_hits, '; ');
  END IF;
END $probe$;
GRANT SELECT ON public.shops, public.products, public.product_units, public.purchase_orders, public.sales, public.stock_transfers,
  public.suppliers, public.users, public.price_levels, public.organizations, public.idempotency_keys TO recovery_owner;
CREATE SCHEMA recovery AUTHORIZATION recovery_owner;
REVOKE ALL ON SCHEMA recovery FROM PUBLIC;
GRANT USAGE ON SCHEMA recovery TO authenticated, recovery_authority, recovery_gate;   -- functions only; the schema is not exposed by PostgREST
ALTER DEFAULT PRIVILEGES FOR ROLE recovery_owner IN SCHEMA recovery REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;   -- records nothing (a per-schema default cannot revoke the built-in PUBLIC EXECUTE): every function is revoked explicitly below, and a later migration must do the same

-- public-schema canary: renewed with the lease; a reload of the public schema brings back an old or copied row
CREATE TABLE public.zz_recovery_canary (one boolean PRIMARY KEY DEFAULT true CHECK (one), seq int NOT NULL, issued_xid xid8 NOT NULL);
ALTER TABLE public.zz_recovery_canary OWNER TO recovery_owner;
ALTER TABLE public.zz_recovery_canary ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zz_recovery_canary FROM PUBLIC, anon, authenticated, service_role, postgres;

SET ROLE recovery_owner;
-- ------------------------------------------------------------ 2/9 state
CREATE TABLE recovery.settings (one boolean PRIMARY KEY DEFAULT true CHECK (one),
  legacy_paths text NOT NULL DEFAULT 'closed' CHECK (legacy_paths IN ('closed', 'open')));   -- 'open' only as an owner SQL decision (D7)
INSERT INTO recovery.settings DEFAULT VALUES;
CREATE TABLE recovery.continuity (one boolean PRIMARY KEY DEFAULT true CHECK (one), state text NOT NULL CHECK (state IN ('open', 'hold')),
  sysid text NOT NULL, timeline int NOT NULL, db_oid oid NOT NULL);
CREATE TABLE recovery.lease (one boolean PRIMARY KEY DEFAULT true CHECK (one), valid_until timestamptz NOT NULL, issued_at timestamptz NOT NULL,
  issued_xid xid8 NOT NULL, postmaster_start timestamptz NOT NULL, authority_seq int NOT NULL,
  token_sha256 text NOT NULL);   -- sha256 of the one-time secret the renewing caller presented (the signed intent carries the authority's)
CREATE TABLE recovery.anchor_permit (postmaster_start timestamptz PRIMARY KEY, reason text NOT NULL, approved_by text NOT NULL,
  second_approver text NOT NULL CHECK (second_approver <> approved_by), at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE recovery.install (one boolean PRIMARY KEY DEFAULT true CHECK (one), genesis_done boolean NOT NULL DEFAULT false, max_seq int NOT NULL DEFAULT 0);
INSERT INTO recovery.install DEFAULT VALUES;
CREATE TABLE recovery.org_state (org_id text PRIMARY KEY, epoch_no int NOT NULL DEFAULT 0, epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  held boolean NOT NULL DEFAULT false, reason text, changed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE recovery.epoch_history (org_id text, epoch_no int, epoch uuid NOT NULL UNIQUE, reason text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (org_id, epoch_no));
CREATE TABLE recovery.events (id bigserial PRIMARY KEY, org_id text, kind text NOT NULL, detail jsonb, at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE recovery.org_chain (org_id text PRIMARY KEY, n bigint NOT NULL, h bytea NOT NULL);
CREATE TABLE recovery.chain_log (org_id text, n bigint, h bytea NOT NULL, p text NOT NULL, PRIMARY KEY (org_id, n));
CREATE TABLE recovery.keys (name text PRIMARY KEY, k bytea NOT NULL);
CREATE TABLE recovery.v87_txn (txid bigint PRIMARY KEY);       -- "this transaction came through op_execute_v87 / op_status_v87"
CREATE TABLE recovery.executor_rpcs (rpc text PRIMARY KEY);    -- 086's 29 allow-listed executor RPCs (static; verified by the tests)
CREATE TABLE recovery.tills (org_id text, till_id text CHECK (till_id ~ '^[A-Za-z0-9._-]{1,64}$'), secret_hash text NOT NULL,
  reconciled_epoch_no int NOT NULL, registered_by uuid NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (org_id, till_id));
CREATE TABLE recovery.journal (org_id text, till_id text, epoch_no int, chunk_no int CHECK (chunk_no BETWEEN 1 AND 10000), payload jsonb NOT NULL,
  final boolean NOT NULL, bytes int NOT NULL, submitted_by uuid NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(), exported_at timestamptz,
  PRIMARY KEY (org_id, till_id, epoch_no, chunk_no));
CREATE TABLE recovery.quarantine (org_id text, key uuid, till_id text NOT NULL, epoch_no int NOT NULL, PRIMARY KEY (org_id, key));
CREATE TABLE recovery.quota (org_id text PRIMARY KEY, max_bytes bigint NOT NULL);
CREATE TABLE recovery.till_reconciliations (org_id text, till_id text, epoch_no int, approved_by uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (org_id, till_id, epoch_no));
CREATE TABLE recovery.decisions (id bigserial PRIMARY KEY, org_id text NOT NULL, key uuid NOT NULL, rpc text NOT NULL, args_digest text NOT NULL,
  actor_id text NOT NULL, op_epoch_no int NOT NULL, till_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('fence')),                     -- 087: fence only; restore / re-reject are 088
  proposed_by uuid NOT NULL,
  approved_by text, second_approver text, approved_at timestamptz,     -- the infrastructure owner (superuser session, two names)
  withdrawn_at timestamptz, withdrawn_by uuid, consumed_at timestamptz,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((approved_by IS NULL) = (second_approver IS NULL) AND (approved_by IS NULL) = (approved_at IS NULL)));
CREATE UNIQUE INDEX decisions_one_open_per_key ON recovery.decisions (org_id, key) WHERE consumed_at IS NULL AND withdrawn_at IS NULL;
CREATE TABLE recovery.acl_snapshot (relid oid, relname text, relkind text, relacl text);
CREATE TABLE recovery.fn_acl_snapshot (fnid oid, fn text, proacl text);

-- ------------------------------------------------------------ 3/9 primitives (pg_catalog built-ins and recovery.* only)
CREATE FUNCTION recovery.random_bytes32() RETURNS bytea LANGUAGE sql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
  SELECT decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex') $$;
-- RFC 2104 HMAC-SHA256 from pg_catalog.sha256: no extension schema (postgres owns "extensions")
CREATE FUNCTION recovery.hmac_sha256(p_msg bytea, p_key bytea) RETURNS bytea LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE k bytea := p_key; ipad bytea; opad bytea; i int;
BEGIN
  IF length(k) > 64 THEN k := sha256(k); END IF;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  ipad := k; opad := k;
  FOR i IN 0..63 LOOP ipad := set_byte(ipad, i, get_byte(k, i) # 54); opad := set_byte(opad, i, get_byte(k, i) # 92); END LOOP;
  RETURN sha256(opad || sha256(ipad || p_msg));
END $$;
INSERT INTO recovery.keys VALUES ('witness', recovery.random_bytes32()), ('reply', recovery.random_bytes32());

CREATE FUNCTION recovery.refuse(p_code text) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'PT429', MESSAGE = 'ORG_SUSPENDED: server recovery in progress [' || p_code || ']'; END $$;

CREATE FUNCTION recovery.mac(b jsonb, p_key text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(recovery.hmac_sha256(convert_to(b::text, 'UTF8'), (SELECT k FROM recovery.keys WHERE name = p_key)), 'hex') $$;

-- present, unexpired, issued after THIS server start, for THIS server start, and the row its issuing transaction wrote
CREATE FUNCTION recovery.lease_ok() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT l.valid_until > clock_timestamp() AND l.issued_at > pg_postmaster_start_time()
                      AND l.postmaster_start = pg_postmaster_start_time()
                      AND (l.issued_xid::text::numeric % 4294967296) = l.xmin::text::numeric FROM recovery.lease l), false) $$;

-- the caller from the PostgREST JWT claims (read directly; never through a function another role owns)
CREATE FUNCTION recovery.caller(OUT uid uuid, OUT actor text, OUT org text, OUT role text, OUT aal text, OUT api_role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
BEGIN
  api_role := c->>'role'; aal := c->>'aal'; uid := nullif(c->>'sub', '')::uuid;
  IF uid IS NOT NULL THEN
    SELECT u.id, u.org_id, upper(u.role) INTO actor, org, role FROM public.users u WHERE u.auth_id = uid AND u.is_active LIMIT 1;
  END IF;
END $$;

CREATE FUNCTION recovery.assert_server() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c recovery.continuity;
BEGIN
  SELECT * INTO c FROM recovery.continuity;
  IF NOT FOUND THEN PERFORM recovery.refuse('NO_CONTINUITY'); END IF;
  IF (c.sysid, c.timeline, c.db_oid) IS DISTINCT FROM ((SELECT system_identifier::text FROM pg_control_system()),
      (SELECT timeline_id FROM pg_control_checkpoint())::int, (SELECT oid FROM pg_database WHERE datname = current_database())) THEN
    PERFORM recovery.refuse('IDENTITY_CHANGED'); END IF;
  IF NOT recovery.lease_ok() THEN PERFORM recovery.refuse('LEASE_INVALID'); END IF;
  IF c.state <> 'open' THEN PERFORM recovery.refuse('RECOVERY_HOLD'); END IF;
END $$;

-- every organisation a row touches (the row and its parents); empty = unresolvable
CREATE FUNCTION recovery.org_of(p_tbl text, r jsonb) RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text[];
BEGIN
  v := CASE
    WHEN p_tbl = 'organizations' THEN ARRAY[r->>'id']
    WHEN p_tbl = 'idempotency_keys' THEN ARRAY[nullif(r->>'org_id', '!unattributed')]
    WHEN p_tbl IN ('brands','business_profile','categories','price_levels','product_barcodes','products','shops','suppliers','unit_types','users') THEN ARRAY[r->>'org_id']
    WHEN p_tbl = 'audit_logs' THEN ARRAY[(SELECT org_id FROM public.shops WHERE id = r->>'shop_id'), (SELECT org_id FROM public.users WHERE id = r->>'actor_id')]
    WHEN p_tbl IN ('inventory','inventory_movements','price_tiers','product_image_upload_sessions') THEN
      ARRAY[(SELECT org_id FROM public.shops WHERE id = r->>'shop_id'), (SELECT org_id FROM public.products WHERE id = r->>'product_id')]
    WHEN p_tbl = 'product_unit_prices' THEN ARRAY[(SELECT org_id FROM public.shops WHERE id = r->>'shop_id'),
      (SELECT p.org_id FROM public.product_units u JOIN public.products p ON p.id = u.product_id WHERE u.id = r->>'product_unit_id'),
      (SELECT org_id FROM public.price_levels WHERE id = r->>'price_level_id')]
    WHEN p_tbl IN ('purchase_orders','supplier_payments') THEN
      ARRAY[(SELECT org_id FROM public.shops WHERE id = r->>'shop_id'), (SELECT org_id FROM public.suppliers WHERE id = r->>'supplier_id')]
    WHEN p_tbl IN ('refund_void_requests','sales','shifts') THEN ARRAY[(SELECT org_id FROM public.shops WHERE id = r->>'shop_id')]
    WHEN p_tbl = 'stock_transfers' THEN ARRAY[(SELECT org_id FROM public.shops WHERE id = r->>'from_shop_id'), (SELECT org_id FROM public.shops WHERE id = r->>'to_shop_id')]
    WHEN p_tbl = 'stock_transfer_items' THEN ARRAY[(SELECT s.org_id FROM public.stock_transfers t JOIN public.shops s ON s.id = t.from_shop_id WHERE t.id = r->>'transfer_id'),
      (SELECT s.org_id FROM public.stock_transfers t JOIN public.shops s ON s.id = t.to_shop_id WHERE t.id = r->>'transfer_id'),
      (SELECT org_id FROM public.products WHERE id = r->>'product_id')]
    WHEN p_tbl = 'product_units' THEN ARRAY[(SELECT org_id FROM public.products WHERE id = r->>'product_id')]
    WHEN p_tbl = 'purchase_order_items' THEN ARRAY[(SELECT s.org_id FROM public.purchase_orders o JOIN public.shops s ON s.id = o.shop_id WHERE o.id = r->>'purchase_order_id'),
      (SELECT org_id FROM public.products WHERE id = r->>'product_id')]
    WHEN p_tbl = 'sale_items' THEN ARRAY[(SELECT s.org_id FROM public.sales x JOIN public.shops s ON s.id = x.shop_id WHERE x.id = r->>'sale_id'),
      (SELECT org_id FROM public.products WHERE id = r->>'product_id')]
    WHEN p_tbl = 'reprint_logs' THEN ARRAY[(SELECT s.org_id FROM public.sales x JOIN public.shops s ON s.id = x.shop_id WHERE x.id = r->>'sale_id')]
    WHEN p_tbl = 'supplier_products' THEN ARRAY[(SELECT org_id FROM public.suppliers WHERE id = r->>'supplier_id'), (SELECT org_id FROM public.products WHERE id = r->>'product_id')]
  END;
  RETURN ARRAY(SELECT DISTINCT x FROM unnest(v) x WHERE x IS NOT NULL ORDER BY 1);
END $$;

CREATE FUNCTION recovery.assert_orgs(p_orgs text[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF cardinality(p_orgs) = 0 THEN
    -- a row that resolves to no organisation is refused while ANY organisation is held (fail closed; cross-tenant: see docs)
    IF EXISTS (SELECT 1 FROM recovery.org_state WHERE held) THEN PERFORM recovery.refuse('ORG_UNRESOLVED'); END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM recovery.org_state WHERE held AND org_id = ANY (p_orgs)) THEN PERFORM recovery.refuse('RECOVERY_HOLD'); END IF;
END $$;

-- an API write (anon/authenticated) must carry x-orvix-epoch = the epoch under which it was CREATED, which must be the
-- organisation's current epoch; service_role (edge functions) and SQL sessions are subject to the hold rules only
CREATE FUNCTION recovery.api_epoch_check(p_orgs text[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb; h text; o text;
BEGIN
  IF (SELECT legacy_paths FROM recovery.settings) = 'open' OR coalesce(c->>'role', '') NOT IN ('anon', 'authenticated') THEN RETURN; END IF;
  h := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-orvix-epoch';
  IF h IS NULL THEN PERFORM recovery.refuse('CLIENT_UPGRADE_REQUIRED'); END IF;
  FOREACH o IN ARRAY p_orgs LOOP
    IF NOT EXISTS (SELECT 1 FROM recovery.org_state WHERE org_id = o AND epoch::text = h) THEN PERFORM recovery.refuse('PRE_EPOCH_OPERATION'); END IF;
  END LOOP;
END $$;

CREATE FUNCTION recovery.guard_tg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_orgs text[] := '{}'; n jsonb; o jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  -- ledger evidence is permanent while 087 is installed: no DELETE, and an UPDATE may change only the response columns
  IF TG_TABLE_NAME = 'idempotency_keys' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'LEDGER_EVIDENCE_PROTECTED: operation ledger rows cannot be deleted while 087 is installed' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND (n - 'response' - 'response_purged_at') IS DISTINCT FROM (o - 'response' - 'response_purged_at') THEN
      RAISE EXCEPTION 'LEDGER_EVIDENCE_PROTECTED: only response / response_purged_at of a ledger row may change' USING ERRCODE = '42501';
    END IF;
  END IF;
  PERFORM recovery.assert_server();
  IF TG_ARGV[0] = 'global' THEN RETURN NULL; END IF;
  IF o IS NOT NULL THEN v_orgs := v_orgs || recovery.org_of(TG_TABLE_NAME, o); END IF;
  IF n IS NOT NULL THEN v_orgs := v_orgs || recovery.org_of(TG_TABLE_NAME, n); END IF;
  IF TG_TABLE_NAME = 'organizations' AND TG_OP = 'INSERT' THEN
    INSERT INTO recovery.org_state (org_id) VALUES (n->>'id') ON CONFLICT DO NOTHING;
    INSERT INTO recovery.epoch_history (org_id, epoch_no, epoch, reason)
    SELECT org_id, 0, epoch, 'created' FROM recovery.org_state WHERE org_id = n->>'id' ON CONFLICT DO NOTHING;
  END IF;
  PERFORM recovery.assert_orgs(ARRAY(SELECT DISTINCT unnest(v_orgs)));
  IF NOT EXISTS (SELECT 1 FROM recovery.v87_txn WHERE txid = txid_current()) THEN
    IF TG_TABLE_NAME = 'idempotency_keys' AND TG_OP = 'INSERT' AND (SELECT legacy_paths FROM recovery.settings) = 'closed'
       AND n->>'rpc' IN (SELECT rpc FROM recovery.executor_rpcs) THEN
      PERFORM recovery.refuse('CLIENT_UPGRADE_REQUIRED');   -- an executor RPC outside op_execute_v87 (legacy executor / direct path)
    END IF;
    PERFORM recovery.api_epoch_check(ARRAY(SELECT DISTINCT unnest(v_orgs)));
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION recovery.truncate_tg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'idempotency_keys' THEN
    RAISE EXCEPTION 'LEDGER_EVIDENCE_PROTECTED: the operation ledger cannot be truncated while 087 is installed' USING ERRCODE = '42501';
  END IF;
  PERFORM recovery.assert_server();
  IF TG_ARGV[0] <> 'global' THEN PERFORM recovery.assert_orgs('{}'); END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION recovery.chain_append(p_org text, p_key uuid, p_state text, p_rh text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_n bigint; v_p text;
BEGIN
  IF p_org IS NULL OR p_org = '!unattributed' THEN RETURN; END IF;
  INSERT INTO recovery.org_chain VALUES (p_org, 0, '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea) ON CONFLICT DO NOTHING;
  SELECT n + 1 INTO v_n FROM recovery.org_chain WHERE org_id = p_org FOR UPDATE;
  v_p := json_build_object('org', p_org, 'n', v_n, 'key', p_key, 'state', p_state, 'rh', p_rh)::text;
  UPDATE recovery.org_chain SET n = v_n, h = sha256(h || convert_to(v_p, 'UTF8')) WHERE org_id = p_org;
  INSERT INTO recovery.chain_log SELECT p_org, v_n, h, v_p FROM recovery.org_chain WHERE org_id = p_org;
END $$;
CREATE FUNCTION recovery.chain_tg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM recovery.chain_append(NEW.org_id, NEW.key, NEW.state, NEW.request_hash); RETURN NULL; END $$;
RESET ROLE;

-- ------------------------------------------------------------ 4/9 DDL guard (schema recovery_guard, superuser-owned: supautils requires a
-- superuser-owned event-trigger function, and recovery_owner, which owns schema recovery, must not be able to drop or empty it)
-- One definition of a guarded table's fingerprint, used by the guard and by register_guards (pg_catalog only): triggers
-- (name:enabled:function), columns (number:name:type:not-null:generated:dropped:default), table ACL, policies, indexes, rules,
-- inheritance (both directions), name and schema. The public 087 functions are registered by OID and owner: a drop, a
-- re-creation (new OID or owner) or an overload of one of their names is refused.
CREATE SCHEMA recovery_guard AUTHORIZATION supabase_admin;
REVOKE ALL ON SCHEMA recovery_guard FROM PUBLIC;
CREATE TABLE recovery_guard.snapshot (relid oid PRIMARY KEY, relname text NOT NULL, fingerprint text NOT NULL);
CREATE TABLE recovery_guard.functions (fnid oid PRIMARY KEY, fn text NOT NULL);
ALTER TABLE recovery_guard.snapshot OWNER TO supabase_admin;
ALTER TABLE recovery_guard.functions OWNER TO supabase_admin;
REVOKE ALL ON recovery_guard.snapshot, recovery_guard.functions FROM PUBLIC;
CREATE FUNCTION recovery_guard.fingerprint(p_rel oid) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT concat_ws(' | ',
    (SELECT c.relname::text || '@' || c.relnamespace::regnamespace::text || ' acl=' || coalesce(c.relacl::text, '') FROM pg_class c WHERE c.oid = p_rel),
    (SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text || ':' || t.tgfoid::regproc::text, ',' ORDER BY t.tgname) FROM pg_trigger t
      WHERE t.tgrelid = p_rel AND NOT t.tgisinternal),
    (SELECT string_agg(a.attnum::text || ':' || a.attname::text || ':' || a.atttypid::text || ':' || a.attnotnull::text || ':' || a.attgenerated::text
                       || ':' || a.attisdropped::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = p_rel AND a.attnum > 0),
    'pol=' || coalesce((SELECT string_agg(p.polname::text || ':' || p.polcmd::text || ':' || coalesce(pg_get_expr(p.polqual, p.polrelid), '')
                        || ':' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), ',' ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = p_rel), ''),
    'idx=' || coalesce((SELECT string_agg(pg_get_indexdef(i.indexrelid), ',' ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid = p_rel), ''),
    'rules=' || (SELECT count(*) FROM pg_rewrite w WHERE w.ev_class = p_rel AND w.rulename <> '_RETURN')::text,
    'inh=' || (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = p_rel OR i.inhrelid = p_rel)::text) $$;

CREATE FUNCTION recovery_guard.ddl_guard() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; v_rel oid;
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN RETURN; END IF;   -- migrations and the owner (infrastructure trust)
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    v_rel := CASE r.classid
      WHEN 'pg_class'::regclass THEN coalesce((SELECT indrelid FROM pg_index WHERE indexrelid = r.objid), r.objid)
      WHEN 'pg_trigger'::regclass THEN (SELECT tgrelid FROM pg_trigger WHERE oid = r.objid)
      WHEN 'pg_rewrite'::regclass THEN (SELECT ev_class FROM pg_rewrite WHERE oid = r.objid)
      WHEN 'pg_policy'::regclass THEN (SELECT polrelid FROM pg_policy WHERE oid = r.objid)
      WHEN 'pg_attrdef'::regclass THEN (SELECT adrelid FROM pg_attrdef WHERE oid = r.objid)
      WHEN 'pg_constraint'::regclass THEN (SELECT conrelid FROM pg_constraint WHERE oid = r.objid)
      ELSE NULL END;
    IF v_rel IN (SELECT relid FROM recovery_guard.snapshot)
       OR EXISTS (SELECT 1 FROM pg_inherits i JOIN recovery_guard.snapshot g ON g.relid = i.inhparent WHERE i.inhrelid = r.objid) THEN
      RAISE EXCEPTION 'RECOVERY_GUARD_PROTECTED: no DDL on guarded tables outside a superuser migration (%)', r.command_tag USING ERRCODE = '42501';
    END IF;
  END LOOP;
  -- backstop for commands that report no object (GRANT/REVOKE, DROPs): every guarded table's fingerprint is unchanged, and every
  -- public 087 function still exists with its registered OID, signature and owner, with no other function of those names
  IF EXISTS (SELECT 1 FROM recovery_guard.snapshot g
              WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = g.relid)
                 OR g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))
     OR EXISTS (SELECT 1 FROM recovery_guard.functions f
              WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f.fnid AND p.oid::regprocedure::text = f.fn
                                  AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%')
                  AND p.oid NOT IN (SELECT fnid FROM recovery_guard.functions)) THEN
    RAISE EXCEPTION 'RECOVERY_GUARD_PROTECTED: guarded tables, the canary and the public 087 functions are fixed outside a superuser migration'
      USING ERRCODE = '42501';
  END IF;
END $$;
ALTER FUNCTION recovery_guard.fingerprint(oid) OWNER TO supabase_admin;
ALTER FUNCTION recovery_guard.ddl_guard() OWNER TO supabase_admin;

SET ROLE recovery_owner;
-- ------------------------------------------------------------ 5/9 witness, epochs, tills, the v87 gate
CREATE FUNCTION recovery.witness_of(p_org text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH b AS (SELECT jsonb_build_object('org', s.org_id, 'epoch_no', s.epoch_no, 'n', coalesce(c.n, 0),
                     'h', coalesce(encode(c.h, 'hex'), repeat('00', 32))) AS b
               FROM recovery.org_state s LEFT JOIN recovery.org_chain c USING (org_id) WHERE s.org_id = p_org)
  SELECT b || jsonb_build_object('mac', recovery.mac(b, 'witness')) FROM b $$;

-- NULL = consistent; MISSING / INVALID / STALE (older epoch) / AHEAD (the till saw history this server lacks)
CREATE FUNCTION recovery.check_witness(p_org text, w jsonb) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s recovery.org_state; v_n bigint; v_h text;
BEGIN
  IF w IS NULL OR jsonb_typeof(w) = 'null' THEN RETURN 'MISSING'; END IF;
  IF w->>'org' IS DISTINCT FROM p_org OR w->>'mac' IS DISTINCT FROM recovery.mac(w - 'mac', 'witness')
     OR jsonb_typeof(w->'n') <> 'number' OR jsonb_typeof(w->'epoch_no') <> 'number' THEN RETURN 'INVALID'; END IF;
  SELECT * INTO s FROM recovery.org_state WHERE org_id = p_org;
  IF (w->>'epoch_no')::int > s.epoch_no THEN RETURN 'AHEAD'; END IF;
  IF (w->>'epoch_no')::int < s.epoch_no THEN RETURN 'STALE'; END IF;
  SELECT n INTO v_n FROM recovery.org_chain WHERE org_id = p_org;
  IF (w->>'n')::bigint > coalesce(v_n, 0) THEN RETURN 'AHEAD'; END IF;
  IF (w->>'n')::bigint > 0 THEN
    SELECT encode(h, 'hex') INTO v_h FROM recovery.chain_log WHERE org_id = p_org AND n = (w->>'n')::bigint;
    IF v_h IS DISTINCT FROM w->>'h' THEN RETURN 'AHEAD'; END IF;
  END IF;
  RETURN NULL;
END $$;

-- every epoch change also HOLDS the organisation; 087 has no release (088)
CREATE FUNCTION recovery.bump_epoch(p_org text, p_reason text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE recovery.org_state SET held = true, epoch_no = epoch_no + 1, epoch = gen_random_uuid(), reason = p_reason, changed_at = clock_timestamp() WHERE org_id = p_org;
  INSERT INTO recovery.epoch_history (org_id, epoch_no, epoch, reason) SELECT org_id, epoch_no, epoch, p_reason FROM recovery.org_state WHERE org_id = p_org;
  INSERT INTO recovery.events (org_id, kind, detail) VALUES (p_org, 'epoch_bump', jsonb_build_object('reason', p_reason)) $$;

CREATE FUNCTION recovery.till_auth(p_org text, p_ctx jsonb) RETURNS recovery.tills LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE t recovery.tills;
BEGIN
  SELECT * INTO t FROM recovery.tills WHERE org_id = p_org AND till_id = p_ctx->>'till';
  IF NOT FOUND OR t.secret_hash IS DISTINCT FROM encode(sha256(convert_to(coalesce(p_ctx->>'till_secret', ''), 'UTF8')), 'hex') THEN
    PERFORM recovery.refuse('TILL_UNKNOWN'); END IF;
  RETURN t;
END $$;

-- the v87 gate, called by the SECURITY INVOKER wrappers; returns {proceed} or a final, COMMITTED {outcome:'held'}
CREATE FUNCTION recovery.v87_begin(p_key uuid, p_rpc text, p_ctx jsonb, p_fence boolean, p_args jsonb, p_actor text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record; s recovery.org_state; t recovery.tills; v_w text; v_op_no int; d bigint; b jsonb;
BEGIN
  SELECT * INTO k FROM recovery.caller();
  IF k.org IS NULL THEN RAISE EXCEPTION 'OP_NOT_AUTHENTICATED' USING ERRCODE = '42501'; END IF;
  PERFORM recovery.assert_server();
  t := recovery.till_auth(k.org, p_ctx);
  SELECT * INTO s FROM recovery.org_state WHERE org_id = k.org FOR SHARE;        -- serialises with epoch bumps
  v_w := recovery.check_witness(k.org, p_ctx->'witness');
  IF v_w = 'AHEAD' THEN   -- the till saw history this server lacks: hold + new epoch, COMMITTED (the request does not raise)
    IF NOT s.held THEN PERFORM recovery.bump_epoch(k.org, 'till witness ahead of server'); END IF;   -- one epoch per incident
    b := jsonb_build_object('outcome', 'held', 'code', 'CONTINUITY_ROLLBACK', 'org', k.org, 'key', p_key, 'rpc', p_rpc);
    RETURN b || jsonb_build_object('sig', recovery.mac(b, 'reply'));
  END IF;
  IF v_w = 'INVALID' THEN PERFORM recovery.refuse('WITNESS_INVALID'); END IF;
  IF s.held THEN PERFORM recovery.refuse('RECOVERY_HOLD'); END IF;
  IF v_w IN ('MISSING', 'STALE') OR t.reconciled_epoch_no <> s.epoch_no THEN PERFORM recovery.refuse('TILL_NOT_RECONCILED'); END IF;
  -- an OLD operation: stamped with another epoch, OR listed in an uploaded journal (quarantined), OR (refusal only) a UUIDv7
  -- minted more than 5 minutes before the current epoch began. Client clocks never ALLOW anything.
  IF (p_ctx->>'op_epoch') IS DISTINCT FROM s.epoch::text
     OR EXISTS (SELECT 1 FROM recovery.quarantine qq WHERE qq.org_id = k.org AND qq.key = p_key)
     OR (substr(p_key::text, 15, 1) = '7'
         AND 'epoch'::timestamptz + (('x' || substr(replace(p_key::text, '-', ''), 1, 12))::bit(48)::bigint) * interval '1 millisecond'
             < (SELECT at FROM recovery.epoch_history WHERE org_id = k.org AND epoch_no = s.epoch_no) - interval '5 minutes') THEN
    -- never executed in 087; fenced only by a bound, approved, unconsumed decision for THIS till's journaled operation
    SELECT epoch_no INTO v_op_no FROM recovery.epoch_history WHERE org_id = k.org AND epoch::text = p_ctx->>'op_epoch';
    IF p_fence THEN
      UPDATE recovery.decisions SET consumed_at = clock_timestamp()
       WHERE org_id = k.org AND key = p_key AND rpc = p_rpc AND actor_id = p_actor AND op_epoch_no = v_op_no AND till_id = t.till_id
         AND args_digest = encode(sha256(convert_to(coalesce(p_args, 'null'::jsonb)::text, 'UTF8')), 'hex')
         AND decision = 'fence' AND approved_at IS NOT NULL AND withdrawn_at IS NULL AND consumed_at IS NULL   -- re-checked under the row lock
      RETURNING id INTO d;
    END IF;
    IF d IS NULL THEN PERFORM recovery.refuse('PRE_EPOCH_OPERATION'); END IF;
    INSERT INTO recovery.events (org_id, kind, detail) VALUES (k.org, 'decision_consumed', jsonb_build_object('decision', d, 'key', p_key));
  END IF;
  INSERT INTO recovery.v87_txn VALUES (txid_current()) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('proceed', true);
END $$;

CREATE FUNCTION recovery.v87_finish(p_key uuid, p_rpc text, p_actor text, r jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record; s recovery.org_state; v_rh text; b jsonb;
BEGIN
  DELETE FROM recovery.v87_txn WHERE txid = txid_current();
  IF NOT FOUND THEN RAISE EXCEPTION 'V87_TOKEN_REQUIRED' USING ERRCODE = '42501'; END IF;
  SET CONSTRAINTS public.zz_recovery_chain IMMEDIATE;          -- chain this operation now, so the reply witness covers it
  SELECT * INTO k FROM recovery.caller();
  SELECT * INTO s FROM recovery.org_state WHERE org_id = k.org;
  SELECT request_hash INTO v_rh FROM public.idempotency_keys WHERE org_id = k.org AND key = p_key;
  b := jsonb_build_object('org', k.org, 'key', p_key, 'rpc', p_rpc, 'request_hash', v_rh, 'actor', p_actor, 'epoch_no', s.epoch_no,
         'outcome', r->>'outcome', 'response_sha256', encode(sha256(convert_to(r::text, 'UTF8')), 'hex'));
  RETURN r || jsonb_build_object('signed', b, 'sig', recovery.mac(b, 'reply'), 'witness', recovery.witness_of(k.org));
END $$;

CREATE FUNCTION recovery.require_admin() RETURNS record LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record;
BEGIN
  SELECT * INTO k FROM recovery.caller();
  IF k.org IS NULL OR k.role NOT IN ('ADMIN', 'OWNER') OR k.aal IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'RECOVERY_ADMIN_MFA_REQUIRED' USING ERRCODE = '42501'; END IF;
  RETURN k;
END $$;

-- ------------------------------------------------------------ 6/9 the off-host authority and the gate
CREATE FUNCTION recovery.authority_observe() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('sysid', (SELECT system_identifier::text FROM pg_control_system()), 'timeline', (SELECT timeline_id FROM pg_control_checkpoint()),
    'db_oid', (SELECT oid FROM pg_database WHERE datname = current_database()), 'postmaster_start', pg_postmaster_start_time(), 'lsn', pg_current_wal_lsn()::text,
    'heads', coalesce((SELECT jsonb_object_agg(org_id, jsonb_build_object('n', n, 'h', encode(h, 'hex'))) FROM recovery.org_chain), '{}'),
    'orgs', coalesce((SELECT jsonb_agg(org_id ORDER BY org_id) FROM recovery.org_state), '[]'),
    'held', coalesce((SELECT jsonb_agg(org_id ORDER BY org_id) FROM recovery.org_state WHERE held), '[]'),
    'till_key_fp', (SELECT encode(sha256(k), 'hex') FROM recovery.keys WHERE name = 'witness'),
    'anchor_permit', EXISTS (SELECT 1 FROM recovery.anchor_permit WHERE postmaster_start = pg_postmaster_start_time()),
    'lease_seq', (SELECT authority_seq FROM recovery.lease), 'lease_token_sha256', (SELECT token_sha256 FROM recovery.lease),
    'lease_copied', coalesce((SELECT (l.issued_xid::text::numeric % 4294967296) <> l.xmin::text::numeric FROM recovery.lease l), false),
    'canary_ok', coalesce((SELECT c.seq = l.authority_seq AND (c.issued_xid::text::numeric % 4294967296) = c.xmin::text::numeric
                             FROM public.zz_recovery_canary c, recovery.lease l), (SELECT count(*) = 0 FROM recovery.lease)),
    'ledger', coalesce((SELECT jsonb_object_agg(org_id, c) FROM (SELECT org_id, count(*) c FROM public.idempotency_keys
                         WHERE org_id <> '!unattributed' GROUP BY 1) x), '{}')) $$;
CREATE FUNCTION recovery.authority_hash_at(p_org text, p_n bigint) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(h, 'hex') FROM recovery.chain_log WHERE org_id = p_org AND n = p_n $$;
-- p_token: a one-time 32-byte secret (hex) chosen by the authority for THIS renewal; only its sha256 is stored. The signed intent
-- carries the same hash, so a renewal made by anyone without the secret (a stolen credential) never matches a signed intent.
CREATE FUNCTION recovery.authority_renew(p_seq int, p_seconds int, p_postmaster timestamptz, p_genesis boolean, p_token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
DECLARE l recovery.lease; i recovery.install;
BEGIN
  IF p_seconds NOT BETWEEN 30 AND 3600 THEN RETURN 'BAD_LENGTH'; END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN 'BAD_TOKEN'; END IF;
  IF p_postmaster IS DISTINCT FROM pg_postmaster_start_time() THEN RETURN 'STALE_OBSERVATION'; END IF;
  -- never wait: a renewal that queues behind another session's lock could commit after the authority gave up on it
  SELECT * INTO i FROM recovery.install FOR UPDATE NOWAIT;
  IF p_genesis AND i.genesis_done THEN RETURN 'GENESIS_ALREADY_DONE'; END IF;
  IF NOT p_genesis AND NOT i.genesis_done THEN RETURN 'NO_GENESIS'; END IF;
  IF p_seq <= i.max_seq THEN RETURN 'SEQ_NOT_INCREASING'; END IF;
  IF p_seq > i.max_seq + 100000 THEN RETURN 'SEQ_JUMP_TOO_LARGE'; END IF;
  SELECT * INTO l FROM recovery.lease;
  IF (NOT FOUND OR l.postmaster_start IS DISTINCT FROM pg_postmaster_start_time())
     AND NOT EXISTS (SELECT 1 FROM recovery.anchor_permit WHERE postmaster_start = pg_postmaster_start_time()) THEN RETURN 'ANCHOR_REQUIRED'; END IF;
  INSERT INTO recovery.lease VALUES (true, clock_timestamp() + make_interval(secs => p_seconds), clock_timestamp(), pg_current_xact_id(),
    pg_postmaster_start_time(), p_seq, encode(sha256(decode(p_token, 'hex')), 'hex'))
  ON CONFLICT (one) DO UPDATE SET valid_until = EXCLUDED.valid_until, issued_at = EXCLUDED.issued_at, issued_xid = EXCLUDED.issued_xid,
    postmaster_start = EXCLUDED.postmaster_start, authority_seq = EXCLUDED.authority_seq, token_sha256 = EXCLUDED.token_sha256;
  INSERT INTO public.zz_recovery_canary VALUES (true, p_seq, pg_current_xact_id())
  ON CONFLICT (one) DO UPDATE SET seq = EXCLUDED.seq, issued_xid = EXCLUDED.issued_xid;
  IF NOT recovery.lease_ok() THEN RAISE EXCEPTION 'LEASE_NOT_EFFECTIVE' USING ERRCODE = '55000'; END IF;   -- e.g. called inside a savepoint
  UPDATE recovery.install SET genesis_done = true, max_seq = p_seq;
  RETURN 'RENEWED';
END $$;
CREATE FUNCTION recovery.authority_revoke() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE recovery.lease SET valid_until = clock_timestamp(), issued_xid = pg_current_xact_id() $$;   -- expired, not 'copied'
CREATE FUNCTION recovery.authority_hold(p_org text, p_reason text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO recovery.org_state (org_id) VALUES (p_org) ON CONFLICT DO NOTHING;
  INSERT INTO recovery.epoch_history (org_id, epoch_no, epoch, reason) SELECT org_id, 0, epoch, 'created by authority hold' FROM recovery.org_state
   WHERE org_id = p_org ON CONFLICT DO NOTHING;
  SELECT recovery.bump_epoch(p_org, p_reason) WHERE NOT coalesce((SELECT held FROM recovery.org_state WHERE org_id = p_org), false) $$;
CREATE FUNCTION recovery.gate_evidence() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('observe', recovery.authority_observe(),
    'chain', coalesce((SELECT jsonb_agg(jsonb_build_array(org_id, n, encode(h, 'hex'), p) ORDER BY org_id, n) FROM recovery.chain_log), '[]'),
    'till_key', (SELECT encode(k, 'hex') FROM recovery.keys WHERE name = 'witness')) $$;

-- ------------------------------------------------------------ 7/9 infrastructure owner (superuser session only; two names where it matters)
CREATE FUNCTION recovery.owner_only() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) IS NOT TRUE THEN RAISE EXCEPTION 'OWNER_ONLY' USING ERRCODE = '42501'; END IF; END $$;
CREATE FUNCTION recovery.two(p_a text, p_b text) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF coalesce(btrim(p_a), '') = '' OR coalesce(btrim(p_b), '') = '' OR lower(btrim(p_a)) = lower(btrim(p_b)) THEN
    RAISE EXCEPTION 'TWO_PEOPLE_REQUIRED' USING ERRCODE = '42501'; END IF;
END $$;
CREATE FUNCTION recovery.owner_anchor(p_reason text, p_a text, p_b text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM recovery.owner_only(); PERFORM recovery.two(p_a, p_b);
  INSERT INTO recovery.anchor_permit (postmaster_start, reason, approved_by, second_approver) VALUES (pg_postmaster_start_time(), p_reason, p_a, p_b);
  INSERT INTO recovery.events (kind, detail) VALUES ('anchor', jsonb_build_object('reason', p_reason, 'by', p_a, 'second', p_b)); END $$;
CREATE FUNCTION recovery.owner_open(p_a text, p_b text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM recovery.owner_only(); PERFORM recovery.two(p_a, p_b);
  IF NOT recovery.lease_ok() THEN RAISE EXCEPTION 'LEASE_INVALID' USING ERRCODE = '42501'; END IF;
  UPDATE recovery.continuity SET state = 'open';
  INSERT INTO recovery.events (kind, detail) VALUES ('open', jsonb_build_object('by', p_a, 'second', p_b)); END $$;
-- a recovery: re-seal the identity, advance and HOLD every organisation (no release in 087)
CREATE FUNCTION recovery.owner_begin(p_reason text, p_a text, p_b text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE o text;
BEGIN
  PERFORM recovery.owner_only(); PERFORM recovery.two(p_a, p_b);
  UPDATE recovery.continuity SET state = 'hold', sysid = (SELECT system_identifier::text FROM pg_control_system()),
    timeline = (SELECT timeline_id FROM pg_control_checkpoint())::int, db_oid = (SELECT oid FROM pg_database WHERE datname = current_database());
  FOR o IN SELECT org_id FROM recovery.org_state LOOP PERFORM recovery.bump_epoch(o, 'recovery: ' || p_reason); END LOOP;
  INSERT INTO recovery.events (kind, detail) VALUES ('begin', jsonb_build_object('reason', p_reason, 'by', p_a, 'second', p_b)); END $$;
CREATE FUNCTION recovery.owner_rebaseline(p_reason text, p_a text, p_b text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM recovery.owner_only(); PERFORM recovery.two(p_a, p_b);
  UPDATE recovery.install SET genesis_done = false, max_seq = 0; DELETE FROM recovery.lease;
  INSERT INTO recovery.events (kind, detail) VALUES ('rebaseline', jsonb_build_object('reason', p_reason, 'by', p_a, 'second', p_b)); END $$;
CREATE FUNCTION recovery.owner_hold_org(p_org text, p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM recovery.owner_only(); PERFORM recovery.bump_epoch(p_org, p_reason); END $$;
-- M2: the ONLY way a fence decision is approved. A superuser session (the infrastructure owner; no API role, service_role, JWT,
-- GoTrue identity or postgres session can call it), two different names, and the whole operation restated: the approval is
-- refused unless key, rpc, args, actor, op epoch and till all equal the proposal.
CREATE FUNCTION recovery.owner_approve_decision(p_id bigint, p_key uuid, p_rpc text, p_args jsonb, p_actor_id text, p_op_epoch_no int,
  p_till text, p_a text, p_b text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM recovery.owner_only(); PERFORM recovery.two(p_a, p_b);
  UPDATE recovery.decisions d SET approved_by = btrim(p_a), second_approver = btrim(p_b), approved_at = clock_timestamp()
   WHERE d.id = p_id AND d.key = p_key AND d.rpc = p_rpc AND d.actor_id = p_actor_id AND d.op_epoch_no = p_op_epoch_no AND d.till_id = p_till
     AND d.args_digest = encode(sha256(convert_to(coalesce(p_args, 'null'::jsonb)::text, 'UTF8')), 'hex')
     AND d.approved_at IS NULL AND d.withdrawn_at IS NULL AND d.consumed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_DECISION_NOT_APPROVABLE: no open proposal % for exactly this operation', p_id USING ERRCODE = '42501'; END IF;
  INSERT INTO recovery.events (org_id, kind, detail) SELECT org_id, 'decision_approved', jsonb_build_object('decision', p_id, 'by', p_a, 'second', p_b)
    FROM recovery.decisions WHERE id = p_id;
END $$;
RESET ROLE;
-- (re)registers the guarded tables, the canary and the public 087 functions; superuser session only (after a migration's DDL)
CREATE FUNCTION recovery_guard.register_guards() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n int;
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) IS NOT TRUE THEN RAISE EXCEPTION 'OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  DELETE FROM recovery_guard.snapshot;
  INSERT INTO recovery_guard.snapshot SELECT c.oid, c.relname, recovery_guard.fingerprint(c.oid)
    FROM pg_class c WHERE c.oid IN (SELECT tgrelid FROM pg_trigger WHERE tgname = 'zz_recovery_guard') OR c.oid = 'public.zz_recovery_canary'::regclass;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM recovery_guard.functions;
  INSERT INTO recovery_guard.functions SELECT p.oid, p.oid::regprocedure::text FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%');
  RETURN n;
END $$;
ALTER FUNCTION recovery_guard.register_guards() OWNER TO supabase_admin;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA recovery_guard FROM PUBLIC;

-- ------------------------------------------------------------ 8/9 client and admin API (public, authenticated)
CREATE FUNCTION public.op_execute_v87(p_key uuid, p_rpc text, p_args jsonb, p_actor_id text, p_ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b jsonb;
BEGIN
  b := recovery.v87_begin(p_key, p_rpc, p_ctx, false, p_args, p_actor_id);
  IF b ? 'outcome' THEN RETURN b; END IF;
  RETURN recovery.v87_finish(p_key, p_rpc, p_actor_id, public.op_execute(p_key, p_rpc, p_args, p_actor_id));   -- 086 runs as ITS owner
END $$;

CREATE FUNCTION public.op_status_v87(p_key uuid, p_rpc text, p_fence boolean, p_expected_actor_id text, p_args jsonb, p_ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b jsonb; r jsonb;
BEGIN
  IF p_fence IS NOT TRUE THEN RETURN public.op_status(p_key, p_rpc, false, p_expected_actor_id, p_args); END IF;   -- lookup: read only
  b := recovery.v87_begin(p_key, p_rpc, p_ctx, true, p_args, p_expected_actor_id);
  IF b ? 'outcome' THEN RETURN b; END IF;
  r := public.op_status(p_key, p_rpc, true, p_expected_actor_id, p_args);
  IF (r->>'fenced') IS DISTINCT FROM 'true' THEN   -- in flight / unavailable / expired / not authorised / already decided: roll everything back
    RAISE EXCEPTION USING ERRCODE = 'PT429', MESSAGE = 'ORG_SUSPENDED: server recovery in progress [FENCE_NOT_APPLIED]';
  END IF;
  RETURN recovery.v87_finish(p_key, p_rpc, p_expected_actor_id, r);
END $$;

CREATE FUNCTION public.recovery_register_till(p_till text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record; v_secret text := encode(recovery.random_bytes32(), 'hex');
BEGIN
  SELECT * INTO k FROM recovery.caller();
  PERFORM recovery.require_admin();
  INSERT INTO recovery.tills (org_id, till_id, secret_hash, reconciled_epoch_no, registered_by)
  VALUES (k.org, p_till, encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), -1, k.uid);     -- unreconciled until approved
  RETURN jsonb_build_object('till', p_till, 'till_secret', v_secret);                          -- shown once; only its hash is stored
END $$;

-- the epoch is issued ONLY to a reconciled till of an organisation that is NOT held, on a server that accepts writes:
-- a till can never stamp operations with an epoch that a later release (088) would make executable
CREATE FUNCTION public.recovery_epoch(p_ctx jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record; t recovery.tills; s recovery.org_state;
BEGIN
  SELECT * INTO k FROM recovery.caller();
  t := recovery.till_auth(k.org, p_ctx);
  SELECT * INTO s FROM recovery.org_state WHERE org_id = k.org;
  IF t.reconciled_epoch_no <> s.epoch_no THEN PERFORM recovery.refuse('TILL_NOT_RECONCILED'); END IF;
  PERFORM recovery.assert_server();
  IF s.held THEN PERFORM recovery.refuse('RECOVERY_HOLD'); END IF;
  RETURN jsonb_build_object('epoch', s.epoch, 'epoch_no', s.epoch_no, 'witness', recovery.witness_of(k.org));
END $$;

-- evidence upload: allowed during holds; only from a till that needs reconciliation; idempotent per chunk; never deletes on quota
CREATE FUNCTION public.recovery_submit_journal(p_ctx jsonb, p_chunk_no int, p_chunk jsonb, p_final boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record; t recovery.tills; s recovery.org_state; v_old jsonb; v_bytes int; v_used bigint;
BEGIN
  SELECT * INTO k FROM recovery.caller();
  t := recovery.till_auth(k.org, p_ctx);
  SELECT * INTO s FROM recovery.org_state WHERE org_id = k.org;
  IF t.reconciled_epoch_no = s.epoch_no THEN RETURN jsonb_build_object('outcome', 'not_required'); END IF;
  IF octet_length(p_chunk::text) > 262144 THEN RETURN jsonb_build_object('outcome', 'chunk_too_large'); END IF;
  v_bytes := octet_length(p_chunk::text) + octet_length(t.till_id) + 128;
  SELECT payload INTO v_old FROM recovery.journal WHERE org_id = k.org AND till_id = t.till_id AND epoch_no = s.epoch_no AND chunk_no = p_chunk_no;
  IF FOUND THEN RETURN jsonb_build_object('outcome', CASE WHEN v_old = p_chunk THEN 'already_stored' ELSE 'conflict' END); END IF;
  SELECT coalesce(sum(bytes), 0) INTO v_used FROM recovery.journal WHERE org_id = k.org;
  IF v_used + v_bytes > coalesce((SELECT max_bytes FROM recovery.quota WHERE org_id = k.org), 52428800) THEN
    INSERT INTO recovery.events (org_id, kind, detail)
    SELECT k.org, 'journal_quota_exceeded', jsonb_build_object('till', t.till_id, 'epoch_no', s.epoch_no)
     WHERE NOT EXISTS (SELECT 1 FROM recovery.events WHERE org_id = k.org AND kind = 'journal_quota_exceeded' AND detail->>'till' = t.till_id
                         AND (detail->>'epoch_no')::int = s.epoch_no);
    RETURN jsonb_build_object('outcome', 'quota_exceeded', 'stored', false);
  END IF;
  INSERT INTO recovery.journal (org_id, till_id, epoch_no, chunk_no, payload, final, bytes, submitted_by)
  VALUES (k.org, t.till_id, s.epoch_no, p_chunk_no, p_chunk, coalesce(p_final, false), v_bytes, k.uid);
  INSERT INTO recovery.quarantine (org_id, key, till_id, epoch_no)
  SELECT k.org, (x->>'key')::uuid, t.till_id, s.epoch_no
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_chunk->'records') = 'array' THEN p_chunk->'records' ELSE '[]' END) x
   WHERE x->>'key' IS NOT NULL ON CONFLICT DO NOTHING;   -- a non-UUID key fails the whole upload (22P02): nothing stored
  RETURN jsonb_build_object('outcome', 'stored');
END $$;

-- reconciliation of ONE till for the current epoch: an MFA ADMIN who did not submit any of its journal; the journal is complete
CREATE FUNCTION public.recovery_approve_till(p_till text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record; s recovery.org_state;
BEGIN
  SELECT * INTO k FROM recovery.caller();
  PERFORM recovery.require_admin();
  SELECT * INTO s FROM recovery.org_state WHERE org_id = k.org;
  -- complete: chunks 1..n all stored (a quota-refused or never-sent chunk leaves a gap) and the highest one is final
  IF NOT coalesce((SELECT bool_and(final) FILTER (WHERE chunk_no = mx) AND count(*) = mx
                     FROM (SELECT chunk_no, final, max(chunk_no) OVER () AS mx FROM recovery.journal
                            WHERE org_id = k.org AND till_id = p_till AND epoch_no = s.epoch_no) j
                    GROUP BY mx), false) THEN
    RAISE EXCEPTION 'RECOVERY_JOURNAL_INCOMPLETE: chunks 1..n must all be stored and chunk n final' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM recovery.journal WHERE org_id = k.org AND till_id = p_till AND epoch_no = s.epoch_no AND submitted_by = k.uid) THEN
    RAISE EXCEPTION 'RECOVERY_SELF_APPROVAL' USING ERRCODE = '42501'; END IF;
  UPDATE recovery.tills SET reconciled_epoch_no = s.epoch_no WHERE org_id = k.org AND till_id = p_till;
  INSERT INTO recovery.till_reconciliations VALUES (k.org, p_till, s.epoch_no, k.uid)
  ON CONFLICT (org_id, till_id, epoch_no) DO UPDATE SET approved_by = EXCLUDED.approved_by, at = clock_timestamp();   -- re-approval within an epoch
  RETURN jsonb_build_object('till', p_till, 'reconciled_epoch_no', s.epoch_no);
END $$;

-- a fence decision for ONE journaled operation of ONE till, bound to everything that identifies it
CREATE FUNCTION public.recovery_propose_decision(p_key uuid, p_rpc text, p_args jsonb, p_actor_id text, p_op_epoch_no int, p_till text, p_decision text)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record; v bigint;
BEGIN
  SELECT * INTO k FROM recovery.caller();
  PERFORM recovery.require_admin();
  IF NOT EXISTS (SELECT 1 FROM recovery.quarantine q WHERE q.org_id = k.org AND q.key = p_key AND q.till_id = p_till) THEN
    RAISE EXCEPTION 'RECOVERY_DECISION_NOT_JOURNALED: the operation is not in this till''s uploaded journal' USING ERRCODE = '22023'; END IF;
  INSERT INTO recovery.decisions (org_id, key, rpc, args_digest, actor_id, op_epoch_no, till_id, decision, proposed_by)
  VALUES (k.org, p_key, p_rpc, encode(sha256(convert_to(coalesce(p_args, 'null'::jsonb)::text, 'UTF8')), 'hex'), p_actor_id, p_op_epoch_no,
          p_till, p_decision, k.uid)
  RETURNING id INTO v;
  RETURN v;
END $$;

-- an open (not consumed) proposal is withdrawn by an MFA ADMIN of its organisation; this only ever removes fencing power
CREATE FUNCTION public.recovery_withdraw_decision(p_id bigint) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE k record;
BEGIN
  SELECT * INTO k FROM recovery.caller();
  PERFORM recovery.require_admin();
  UPDATE recovery.decisions SET withdrawn_at = clock_timestamp(), withdrawn_by = k.uid
   WHERE id = p_id AND org_id = k.org AND withdrawn_at IS NULL AND consumed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_DECISION_NOT_WITHDRAWABLE' USING ERRCODE = '22023'; END IF;
  INSERT INTO recovery.events (org_id, kind, detail) VALUES (k.org, 'decision_withdrawn', jsonb_build_object('decision', p_id));
END $$;

-- ------------------------------------------------------------ 9/9 ownership, grants, triggers, install state
ALTER FUNCTION public.op_execute_v87(uuid, text, jsonb, text, jsonb) OWNER TO recovery_owner;
ALTER FUNCTION public.op_status_v87(uuid, text, boolean, text, jsonb, jsonb) OWNER TO recovery_owner;
ALTER FUNCTION public.recovery_register_till(text) OWNER TO recovery_owner;
ALTER FUNCTION public.recovery_epoch(jsonb) OWNER TO recovery_owner;
ALTER FUNCTION public.recovery_submit_journal(jsonb, int, jsonb, boolean) OWNER TO recovery_owner;
ALTER FUNCTION public.recovery_approve_till(text) OWNER TO recovery_owner;
ALTER FUNCTION public.recovery_propose_decision(uuid, text, jsonb, text, int, text, text) OWNER TO recovery_owner;
ALTER FUNCTION public.recovery_withdraw_decision(bigint) OWNER TO recovery_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA recovery FROM PUBLIC;
REVOKE ALL ON FUNCTION public.op_execute_v87(uuid, text, jsonb, text, jsonb), public.op_status_v87(uuid, text, boolean, text, jsonb, jsonb),
  public.recovery_register_till(text), public.recovery_epoch(jsonb), public.recovery_submit_journal(jsonb, int, jsonb, boolean),
  public.recovery_approve_till(text), public.recovery_propose_decision(uuid, text, jsonb, text, int, text, text), public.recovery_withdraw_decision(bigint)
  FROM PUBLIC, anon, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.op_execute_v87(uuid, text, jsonb, text, jsonb), public.op_status_v87(uuid, text, boolean, text, jsonb, jsonb),
  public.recovery_register_till(text), public.recovery_epoch(jsonb), public.recovery_submit_journal(jsonb, int, jsonb, boolean),
  public.recovery_approve_till(text), public.recovery_propose_decision(uuid, text, jsonb, text, int, text, text), public.recovery_withdraw_decision(bigint)
  TO authenticated;
GRANT EXECUTE ON FUNCTION recovery.v87_begin(uuid, text, jsonb, boolean, jsonb, text), recovery.v87_finish(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION recovery.authority_observe(), recovery.authority_hash_at(text, bigint), recovery.authority_renew(int, int, timestamptz, boolean, text),
  recovery.authority_hold(text, text), recovery.authority_revoke() TO recovery_authority;
GRANT EXECUTE ON FUNCTION recovery.gate_evidence() TO recovery_gate;
-- 086 privileges that let service_role rewrite the ledger or prune it, and unneeded TRUNCATE/TRIGGER grants of the API roles
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.idempotency_keys FROM service_role, anon, authenticated;
REVOKE TRUNCATE, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.prune_idempotency_keys() FROM service_role;
INSERT INTO recovery.acl_snapshot SELECT * FROM m087_acl0;
INSERT INTO recovery.fn_acl_snapshot SELECT * FROM m087_fnacl0;

INSERT INTO recovery.executor_rpcs VALUES ('adjust_stock'), ('approve_purchase_order'), ('approve_refund_request'), ('approve_stock_transfer'),
  ('approve_void_request'), ('cancel_purchase_order'), ('cancel_stock_transfer'), ('close_shift'), ('complete_sale'), ('create_purchase_order'),
  ('create_refund_void_request'), ('create_stock_transfer'), ('create_supplier'), ('deactivate_app_user'), ('delete_product'), ('dispatch_stock_transfer'),
  ('log_audit_event'), ('log_receipt_reprint'), ('open_shift'), ('pay_supplier_lump_sum'), ('receive_purchase_order'), ('receive_stock_transfer'),
  ('record_supplier_payment'), ('reject_refund_void_request'), ('reject_stock_transfer'), ('replace_manager'), ('update_app_user'), ('update_supplier'),
  ('void_supplier_payment');
INSERT INTO recovery.org_state (org_id) SELECT id FROM public.organizations;
INSERT INTO recovery.epoch_history (org_id, epoch_no, epoch, reason) SELECT org_id, 0, epoch, 'install' FROM recovery.org_state;
-- chain every ledger row that exists at install, in a deterministic order (ledger rows = chained rows from the start)
SELECT count(recovery.chain_append(org_id, key, state, request_hash)) FROM (SELECT * FROM public.idempotency_keys ORDER BY org_id, created_at, key) x;

DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['brands','business_profile','categories','idempotency_keys','price_levels','product_barcodes','products','shops','suppliers',
    'unit_types','users','organizations','audit_logs','inventory','inventory_movements','price_tiers','product_image_upload_sessions','product_unit_prices',
    'purchase_orders','refund_void_requests','sales','shifts','supplier_payments','stock_transfers','stock_transfer_items','product_units',
    'purchase_order_items','sale_items','reprint_logs','supplier_products'] LOOP
    EXECUTE format('CREATE TRIGGER zz_recovery_guard AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION recovery.guard_tg(%L)', t, 'org');
    EXECUTE format('CREATE TRIGGER zz_recovery_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION recovery.truncate_tg(%L)', t, 'org');
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER zz_recovery_guard, ENABLE ALWAYS TRIGGER zz_recovery_truncate', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['app_config','platform_admins'] LOOP
    EXECUTE format('CREATE TRIGGER zz_recovery_guard AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION recovery.guard_tg(%L)', t, 'global');
    EXECUTE format('CREATE TRIGGER zz_recovery_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION recovery.truncate_tg(%L)', t, 'global');
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER zz_recovery_guard, ENABLE ALWAYS TRIGGER zz_recovery_truncate', t);
  END LOOP;
END $t$;
CREATE CONSTRAINT TRIGGER zz_recovery_chain AFTER INSERT ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION recovery.chain_tg();
ALTER TABLE public.idempotency_keys ENABLE ALWAYS TRIGGER zz_recovery_chain;
CREATE EVENT TRIGGER zz_recovery_ddl_guard ON ddl_command_end EXECUTE FUNCTION recovery_guard.ddl_guard();
ALTER EVENT TRIGGER zz_recovery_ddl_guard ENABLE ALWAYS;
SELECT recovery_guard.register_guards();
-- installed HELD: no lease and state 'hold'. Opening: owner_anchor (two people) -> authority genesis -> tills reconciled -> smoke ->
-- owner_open (two people). Nothing here opens the server.
INSERT INTO recovery.continuity SELECT true, 'hold', (SELECT system_identifier::text FROM pg_control_system()),
  (SELECT timeline_id FROM pg_control_checkpoint())::int, (SELECT oid FROM pg_database WHERE datname = current_database());
NOTIFY pgrst, 'reload schema';
-- v87.x: the event triggers disabled at the top of this file, re-enabled with their own mode (O / R / A)
DO $evt_on$
DECLARE e jsonb;
BEGIN
  FOR e IN SELECT * FROM pg_catalog.jsonb_array_elements(pg_catalog.current_setting('m087.event_triggers')::jsonb) LOOP
    EXECUTE pg_catalog.format('ALTER EVENT TRIGGER %I %s', e->>'n',
      CASE e->>'m' WHEN 'O' THEN 'ENABLE' WHEN 'R' THEN 'ENABLE REPLICA' WHEN 'A' THEN 'ENABLE ALWAYS' END);
  END LOOP;
END $evt_on$;
RESET search_path;   -- v87.x: the pinned path ends with this migration (later files in the same runner transaction get the default)
