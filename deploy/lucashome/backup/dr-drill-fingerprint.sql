-- dr-drill-fingerprint.sql — read-only fingerprint of a POS database, one line per item:
--   <item>|<count or value>|<md5 or detail>
-- Run identically against the LIVE database (in a read-only transaction) and against every
-- disposable restore made by dr-drill.sh; the two outputs are compared line by line.
-- No row content is printed: only counts and md5s over the ordered row texts.
\set ON_ERROR_STOP 1
SET timezone = 'UTC';
SET datestyle = 'ISO, MDY';
SET intervalstyle = 'postgres';
SET extra_float_digits = 1;
SET bytea_output = 'hex';

-- every public table: rows + md5 over the ordered row texts
SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM %I.%I t',
              'public.' || c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
 ORDER BY c.relname
\gexec

SELECT 'count:public tables', count(*), '' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');

-- auth (row texts include hashes; only their md5 leaves the database)
SELECT 'auth.users', count(*), md5(coalesce(string_agg(t::text, E'\n' ORDER BY t.id), '')) FROM auth.users t;
SELECT 'auth.identities', count(*), md5(coalesce(string_agg(t::text, E'\n' ORDER BY t.id), '')) FROM auth.identities t;
SELECT 'auth.mfa_factors', count(*), md5(coalesce(string_agg(t::text, E'\n' ORDER BY t.id), '')) FROM auth.mfa_factors t;
SELECT 'auth.mfa_factors verified', count(*) FILTER (WHERE status = 'verified'), '' FROM auth.mfa_factors;

-- storage: same fingerprints as e2e/d-phone-upload.e2e.ts (STORAGE_FP / ORPHANS_FP)
SELECT 'storage.buckets', count(*), md5(coalesce(string_agg(t::text, E'\n' ORDER BY t.id), '')) FROM storage.buckets t;
SELECT 'storage.objects (all columns but last_accessed_at)', count(*),
       md5(string_agg((to_jsonb(z) - 'last_accessed_at')::text, '|' ORDER BY z.bucket_id, z.name))
  FROM storage.objects z WHERE z.name NOT LIKE 'org/qa-%';
SELECT 'storage.objects orphans', count(*), md5(string_agg((to_jsonb(o) - 'last_accessed_at')::text, '|' ORDER BY o.name))
  FROM storage.objects o
 WHERE o.bucket_id = 'product-images' AND (
       (o.name LIKE 'temp/%' AND NOT EXISTS (SELECT 1 FROM public.product_image_upload_sessions s WHERE s.storage_path = o.name))
    OR (o.name LIKE 'products/%' AND o.name NOT LIKE 'products/brand/%'
        AND NOT EXISTS (SELECT 1 FROM public.products p WHERE o.name LIKE 'products/' || p.id || '/%')));

-- migration history and the runtime configuration row
SELECT 'supabase_migrations.schema_migrations', count(*), md5(coalesce(string_agg(t::text, E'\n' ORDER BY t.version), ''))
  FROM supabase_migrations.schema_migrations t;
SELECT 'schema version (max)', max(version), '' FROM supabase_migrations.schema_migrations;
SELECT 'vault.secrets', count(*), '' FROM vault.secrets;
SELECT 'cron.job', count(*), '' FROM cron.job;
