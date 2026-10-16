-- Normalised, sorted DDL/catalog fingerprint of the public + storage schemas.
-- Same query runs on the live server (read-only) and on the disposable DB; the
-- two outputs are diffed. Emits one stable line per object. No data, no secrets.
-- Categories: COLUMN, CONSTRAINT, INDEX, POLICY, GRANT-TABLE, GRANT-FUNC, FUNC,
--             VIEW, TRIGGER, BUCKET, RLS, PUBLICATION, MIGRATION.
\pset format unaligned
\pset tuples_only on
\pset pager off
SET statement_timeout = '60s';

WITH lines AS (
  SELECT format('COLUMN|%s.%s|%s|%s|%s|%s', table_schema, table_name, column_name, data_type,
                is_nullable, (column_default IS NOT NULL)::text) AS l
  FROM information_schema.columns WHERE table_schema IN ('public','storage')
  UNION ALL
  SELECT format('CONSTRAINT|%s|%s|%s', conrelid::regclass, conname, pg_get_constraintdef(oid))
  FROM pg_constraint WHERE connamespace IN ('public'::regnamespace,'storage'::regnamespace)
  UNION ALL
  SELECT format('INDEX|%s.%s|%s|%s', schemaname, tablename, indexname, indexdef)
  FROM pg_indexes WHERE schemaname IN ('public','storage')
  UNION ALL
  SELECT format('POLICY|%s.%s|%s|%s|%s|%s|%s', schemaname, tablename, policyname, cmd,
                array_to_string(roles, ','), md5(coalesce(qual,'')), md5(coalesce(with_check,'')))
  FROM pg_policies WHERE schemaname IN ('public','storage')
  UNION ALL
  SELECT format('RLS|%s.%s|%s|%s', n.nspname, c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','storage') AND c.relkind IN ('r','p')
  UNION ALL
  SELECT format('GRANT-TABLE|%s|%s.%s|%s', grantee, table_schema, table_name, privilege_type)
  FROM information_schema.role_table_grants
  WHERE table_schema IN ('public','storage') AND grantee IN ('anon','authenticated','service_role','PUBLIC')
  UNION ALL
  SELECT format('GRANT-FUNC|%s|%s.%s(%s)', r.rolname, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) r
  WHERE n.nspname IN ('public','storage') AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
  UNION ALL
  SELECT format('FUNC|%s.%s(%s)|secdef=%s|%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                p.prosecdef::text, md5(pg_get_functiondef(p.oid)))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public','storage') AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT format('TRIGGER|%s|%s|%s', t.tgrelid::regclass, t.tgname, md5(pg_get_triggerdef(t.oid)))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','storage') AND NOT t.tgisinternal
  UNION ALL
  SELECT format('VIEW|%s.%s|%s', schemaname, viewname, md5(definition))
  FROM pg_views WHERE schemaname IN ('public','storage')
  UNION ALL
  -- id + public are the isolation-relevant facts. allowed_mime_types is a
  -- storage-api upload-validation attribute (production, upgraded from hosted,
  -- carries none; a fresh install via migration 016 adds image/webp,image/jpeg)
  -- and is reported separately, not treated as a schema-parity difference.
  SELECT format('BUCKET|%s|public=%s', id, public::text)
  FROM storage.buckets
  UNION ALL
  SELECT format('PUBLICATION|%s.%s', schemaname, tablename)
  FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
  UNION ALL
  SELECT format('MIGRATION|%s', version) FROM supabase_migrations.schema_migrations WHERE version >= '062'
)
SELECT l FROM lines ORDER BY l;
