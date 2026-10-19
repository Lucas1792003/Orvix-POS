-- dr-schema-fingerprint.sql — read-only fingerprint of what the APPLICATION needs beyond rows:
-- roles (no passwords), extensions, public functions (definitions, owners, grants, settings),
-- tables (columns, constraints, RLS flags, grants), policies, triggers. One line per item:
--   <item>|<count>|<md5>
-- Paired with dr-drill-fingerprint.sql (rows) by dr-verify-restore.sh; source and restore must match.
-- Grants are compared as EFFECTIVE privileges (a NULL acl is the owner-only default, acldefault): pg_dump
-- omits an acl equal to the default, so {owner=all/owner} and NULL are the same privileges; the entries
-- are compared as a SET (sorted) — a restore may list the same grants in another order.
\set ON_ERROR_STOP 1
SET timezone = 'UTC';

SELECT 'schema: roles', count(*), md5(string_agg(format('%s/%s/%s/%s/%s/%s', rolname, rolsuper, rolinherit, rolcreaterole, rolcanlogin, rolbypassrls), '|' ORDER BY rolname))
  FROM pg_roles WHERE rolname NOT LIKE 'pg\_%';
SELECT 'schema: role memberships', count(*), md5(coalesce(string_agg(format('%s>%s', r.rolname, m.rolname), '|' ORDER BY r.rolname, m.rolname), ''))
  FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
 WHERE r.rolname NOT LIKE 'pg\_%' AND m.rolname NOT LIKE 'pg\_%';
SELECT 'schema: extensions', count(*), md5(string_agg(format('%s %s %s', e.extname, e.extversion, n.nspname), '|' ORDER BY e.extname))
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace;
SELECT 'schema: public functions (definition, owner, acl, config, security)', count(*),
       md5(string_agg(format('%s|%s|%s|%s|%s|%s', p.oid::regprocedure, md5(pg_get_functiondef(p.oid)), pg_get_userbyid(p.proowner),
                             (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(p.proacl, acldefault('f', p.proowner))) x), coalesce(p.proconfig::text, ''), p.prosecdef), E'\n' ORDER BY p.oid::regprocedure::text))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p');
SELECT 'schema: public tables (columns)', count(DISTINCT c.oid),
       md5(string_agg(format('%s.%s %s %s %s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), '')), E'\n' ORDER BY c.relname, a.attnum))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
SELECT 'schema: tables (public, auth, storage: rls, effective acl, owner)', count(*),
       md5(string_agg(format('%s.%s %s %s %s %s', n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(c.relacl, acldefault('r', c.relowner))) x), pg_get_userbyid(c.relowner)), E'\n' ORDER BY n.nspname, c.relname))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p', 'v', 'm');
SELECT 'schema: functions outside public (owner, effective acl, security)', count(*),
       md5(coalesce(string_agg(format('%s|%s|%s|%s', p.oid::regprocedure, pg_get_userbyid(p.proowner),
                             (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(p.proacl, acldefault('f', p.proowner))) x), p.prosecdef), E'\n' ORDER BY p.oid::regprocedure::text), ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema', 'public');
SELECT 'schema: sequences (owner, effective acl)', count(*),
       md5(coalesce(string_agg(format('%s.%s %s %s', n.nspname, c.relname, pg_get_userbyid(c.relowner),
                             (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(c.relacl, acldefault('s', c.relowner))) x)), E'\n' ORDER BY n.nspname, c.relname), ''))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'S' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema';
SELECT 'schema: column-level grants', count(*),
       md5(coalesce(string_agg(format('%s.%s.%s %s', n.nspname, c.relname, a.attname,
                             (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(a.attacl) x)), E'\n' ORDER BY n.nspname, c.relname, a.attname), ''))
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE a.attacl IS NOT NULL AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema';
SELECT 'schema: database (owner, effective acl)', 1,
       md5(format('%s %s', pg_get_userbyid(d.datdba), (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(d.datacl, acldefault('d', d.datdba))) x)))
  FROM pg_database d WHERE d.datname = current_database();
SELECT 'schema: schemas (owner, effective acl)', count(*),
       md5(string_agg(format('%s %s %s', nspname, pg_get_userbyid(nspowner), (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(coalesce(nspacl, acldefault('n', nspowner))) x)), E'\n' ORDER BY nspname))
  FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema';
SELECT 'schema: constraints (public, auth, storage)', count(*),
       md5(string_agg(format('%s %s %s %s', con.conrelid::regclass, con.conname, pg_get_constraintdef(con.oid), con.convalidated), E'\n' ORDER BY con.conrelid::regclass::text, con.conname))
  FROM pg_constraint con WHERE con.connamespace IN ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace);
SELECT 'schema: policies', count(*),
       md5(string_agg(format('%s.%s %s %s %s %s %s', schemaname, tablename, policyname, permissive, roles::text, coalesce(qual, ''), coalesce(with_check, '')), E'\n' ORDER BY schemaname, tablename, policyname))
  FROM pg_policies;
SELECT 'schema: triggers (public, auth, storage)', count(*),
       md5(string_agg(format('%s %s %s', t.tgrelid::regclass, t.tgname, pg_get_triggerdef(t.oid)), E'\n' ORDER BY t.tgrelid::regclass::text, t.tgname))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND c.relnamespace IN ('public'::regnamespace, 'auth'::regnamespace, 'storage'::regnamespace);
SELECT 'schema: default privileges', count(*), md5(coalesce(string_agg(x, E'\n' ORDER BY x), '')) FROM (
  SELECT format('%s %s %s %s', pg_get_userbyid(defaclrole), defaclnamespace::regnamespace, defaclobjtype, defaclacl::text) AS x FROM pg_default_acl) d;
SELECT 'schema: database and role settings', count(*), md5(coalesce(string_agg(x, E'\n' ORDER BY x), '')) FROM (
  SELECT format('%s %s %s', coalesce(d.datname, '*all databases*'), coalesce(r.rolname, '*'), s.setconfig::text) AS x
    FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase LEFT JOIN pg_roles r ON r.oid = s.setrole
   WHERE s.setdatabase = 0 OR d.datname = current_database()) d;
