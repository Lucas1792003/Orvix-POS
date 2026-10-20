-- Read-only inventory of every rolled-back 087 archive schema, used by archive-allowlist.py (disposable stack only): taken before
-- and after the deviation cases, it proves every planted deviation was reverted. Rows carry their schema; ACLs are compared as
-- effective ACLs (a GRANT + REVOKE leaves an explicit owner-only ACL equivalent to the NULL default).
\pset footer off
\echo == schemas
SELECT n.nspname, n.nspowner::regrole, n.nspacl, coalesce(n.nspacl, acldefault('n', n.nspowner)) AS effective_acl
  FROM pg_namespace n WHERE n.nspname LIKE 'recovery\_archived\_087\_%' ORDER BY 1;
\echo == relations
SELECT n.nspname, c.relname, c.relkind, c.relowner::regrole,
       coalesce(c.relacl, acldefault(CASE c.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)) AS effective_acl,
       c.relpersistence, c.relrowsecurity, c.relforcerowsecurity, c.relispartition, c.relam, c.reloptions,
       CASE c.relkind WHEN 'i' THEN pg_get_indexdef(c.oid) END AS indexdef
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%' ORDER BY 1, 3, 2;
\echo == columns
SELECT n.nspname, c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
       pg_get_expr(d.adbin, d.adrelid), a.attacl, a.attcollation
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE n.nspname LIKE 'recovery\_archived\_087\_%' AND c.relkind IN ('r', 'S') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, 2, 3;
\echo == types
SELECT n.nspname, t.typname, t.typtype, t.typcategory, t.typowner::regrole, coalesce(t.typacl, acldefault('T', t.typowner)) AS effective_acl,
       t.typrelid::regclass, t.typelem::regtype
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%' ORDER BY 1, 3, 2;
\echo == constraints
SELECT n.nspname, c.conname, c.contype, c.conrelid::regclass, c.contypid, pg_get_constraintdef(c.oid)
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%' ORDER BY 1, 4, 2;
\echo == default acls in archive / of recovery roles
SELECT d.defaclrole::regrole, d.defaclnamespace::regnamespace, d.defaclobjtype, d.defaclacl FROM pg_default_acl d
 WHERE d.defaclnamespace IN (SELECT oid FROM pg_namespace WHERE nspname LIKE 'recovery\_archived\_087\_%')
    OR d.defaclrole IN (SELECT oid FROM pg_roles WHERE rolname LIKE 'recovery\_%') ORDER BY 1, 2, 3;
\echo == dependencies of archive objects (dependent, deptype, referenced, referenced class)
SELECT pg_describe_object(d.classid, d.objid, d.objsubid) AS dependent, d.deptype, pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) AS referenced,
       d.refclassid::regclass AS refclass
  FROM pg_depend d
 WHERE (d.classid = 'pg_class'::regclass AND d.objid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%'))
    OR (d.classid = 'pg_type'::regclass AND d.objid IN (SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%'))
    OR (d.classid = 'pg_constraint'::regclass AND d.objid IN (SELECT c.oid FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%'))
    OR (d.classid = 'pg_attrdef'::regclass AND d.objid IN (SELECT a.oid FROM pg_attrdef a JOIN pg_class c ON c.oid = a.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%'))
    OR (d.classid = 'pg_namespace'::regclass AND d.objid IN (SELECT oid FROM pg_namespace WHERE nspname LIKE 'recovery\_archived\_087\_%'))
 ORDER BY 1, 2, 3, 4;
\echo == other object kinds in or on the archive (all expected 0)
SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace IN (SELECT oid FROM pg_namespace WHERE nspname LIKE 'recovery\_archived\_087\_%')) procs,
       (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%') triggers,
       (SELECT count(*) FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%') rules,
       (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'recovery\_archived\_087\_%') policies;
\echo == shared dependencies on the recovery roles
SELECT d.dbid, d.classid::regclass, pg_describe_object(d.classid, d.objid, d.objsubid), d.deptype, d.refobjid::regrole FROM pg_shdepend d
 WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid IN (SELECT oid FROM pg_roles WHERE rolname LIKE 'recovery\_%') ORDER BY 1, 2, 3, 4, 5;
\echo == recovery roles
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname LIKE 'recovery\_%' ORDER BY 1;
