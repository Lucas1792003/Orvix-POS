-- Catalog inventory of the API surface, as one JSON document (stdout).
-- Read-only. Derived from the catalog of the database under test, never from
-- a hand-written list, so any object added later appears here automatically
-- and the coverage gate fails until a test maps to it.
--
-- Table classification:
--   org-scoped : has an org_id column, OR reaches a table with org_id through
--                a chain of foreign keys (shop_id -> shops.org_id,
--                product_id -> products.org_id, sale_id -> sales.shop_id ...)
--   internal   : no SELECT/INSERT/UPDATE/DELETE grant to anon or authenticated
--                (service role / definer functions only)
--   global     : API-granted, no org path (reference data / singletons)
WITH RECURSIVE
tbl AS (
  SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE (n.nspname = 'public' AND c.relkind IN ('r','v','m','p'))
     OR (n.nspname = 'storage' AND c.relname IN ('objects','buckets'))
),
-- real single-column foreign keys
realfk AS (
  SELECT con.conrelid AS src, con.confrelid AS dst, a.attname::text AS col
  FROM pg_constraint con
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
),
-- link columns WITHOUT a declared FK (production has none on e.g. sales.shop_id):
-- followed by naming convention, marked "~" in the path so the report shows it
namelink (col, dst) AS (VALUES
  ('shop_id','shops'), ('from_shop_id','shops'), ('to_shop_id','shops'),
  ('product_id','products'), ('sale_id','sales'), ('shift_id','shifts'),
  ('supplier_id','suppliers'), ('purchase_order_id','purchase_orders'),
  ('transfer_id','stock_transfers'), ('stock_transfer_id','stock_transfers'),
  ('cashier_id','users'), ('created_by','users'), ('actor_id','users'), ('user_id','users'), ('printed_by','users')
),
fk AS (
  SELECT src, dst, col FROM realfk
  UNION
  SELECT a.attrelid, (SELECT c2.oid FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace WHERE n2.nspname = 'public' AND c2.relname = nl.dst), '~' || a.attname::text
  FROM pg_attribute a JOIN namelink nl ON nl.col = a.attname::text
  WHERE a.attrelid IN (SELECT oid FROM tbl) AND a.attnum > 0 AND NOT a.attisdropped
    AND NOT EXISTS (SELECT 1 FROM realfk r WHERE r.src = a.attrelid AND r.col = a.attname::text)
),
has_org AS (
  SELECT t.oid FROM tbl t
  WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
     OR (t.schema = 'public' AND t.name = 'organizations')
),
reach (oid, path, depth) AS (
  SELECT oid, ARRAY[]::text[] COLLATE "C", 0 FROM has_org
  UNION
  SELECT fk.src, (ARRAY[(fk.col::text || '->' || (SELECT relname::text FROM pg_class WHERE oid = fk.dst))] || r.path) COLLATE "C", r.depth + 1
  FROM fk JOIN reach r ON r.oid = fk.dst
  WHERE r.depth < 4 AND fk.src IN (SELECT oid FROM tbl) AND fk.src <> fk.dst
),
org_path AS (
  SELECT DISTINCT ON (oid) oid, path FROM reach ORDER BY oid, depth
),
grants AS (
  SELECT t.oid,
    jsonb_object_agg(r.rolname, (SELECT coalesce(jsonb_agg(p ORDER BY p), '[]') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
                                  WHERE has_table_privilege(r.rolname, t.oid, p))) AS g
  FROM tbl t CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) r
  GROUP BY t.oid
),
tables AS (
  SELECT jsonb_agg(jsonb_build_object(
    'id', t.schema || '.' || t.name,
    'kind', CASE t.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE 'table' END,
    'rls', t.rls,
    'security_invoker', CASE WHEN t.relkind = 'v' THEN coalesce((SELECT option_value::bool FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid = t.oid)) WHERE option_name = 'security_invoker'), false) END,
    'has_org_id', t.oid IN (SELECT oid FROM has_org),
    'org_path', (SELECT to_jsonb(path) FROM org_path op WHERE op.oid = t.oid),
    'grants', g.g,
    'class', CASE
      WHEN t.schema = 'storage' THEN 'storage'
      WHEN NOT (jsonb_array_length(g.g->'anon') > 0 OR jsonb_array_length(g.g->'authenticated') > 0) THEN 'internal'
      WHEN EXISTS (SELECT 1 FROM org_path op WHERE op.oid = t.oid) THEN 'org-scoped'
      ELSE 'global' END,
    'columns', (SELECT jsonb_agg(attname ORDER BY attnum) FROM pg_attribute WHERE attrelid = t.oid AND attnum > 0 AND NOT attisdropped)
  ) ORDER BY t.schema, t.name) AS j
  FROM tbl t JOIN grants g ON g.oid = t.oid
),
fns AS (
  SELECT jsonb_agg(jsonb_build_object(
    'id', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    'name', n.nspname || '.' || p.proname,
    'security_definer', p.prosecdef,
    'returns_trigger', p.prorettype = 'trigger'::regtype,
    'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
    'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
    'args', (SELECT coalesce(jsonb_agg(x), '[]') FROM unnest(coalesce(p.proargnames, ARRAY[]::text[])) x),
    'md5', md5(pg_get_functiondef(p.oid))
  ) ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS j
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public','storage') AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
),
pols AS (
  SELECT jsonb_agg(jsonb_build_object(
    'id', schemaname || '.' || tablename || ':' || policyname,
    'table', schemaname || '.' || tablename, 'cmd', cmd, 'roles', roles, 'permissive', permissive,
    'qual_md5', md5(coalesce(qual,'')), 'check_md5', md5(coalesce(with_check,''))
  ) ORDER BY schemaname, tablename, policyname) AS j
  FROM pg_policies WHERE schemaname IN ('public','storage')
),
buckets AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'public', public) ORDER BY id), '[]') AS j FROM storage.buckets
),
mig AS (
  SELECT max(version) AS v FROM supabase_migrations.schema_migrations
)
SELECT jsonb_pretty(jsonb_build_object(
  'migration_level', (SELECT v FROM mig),
  'tables', (SELECT j FROM tables),
  'functions', (SELECT j FROM fns),
  'policies', (SELECT j FROM pols),
  'buckets', (SELECT j FROM buckets),
  'realtime_publication', (SELECT coalesce(jsonb_agg(schemaname || '.' || tablename ORDER BY 1), '[]') FROM pg_publication_tables WHERE pubname = 'supabase_realtime')
));
