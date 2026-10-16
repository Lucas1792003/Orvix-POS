-- hosted-delta.sql: what changed on HOSTED since the export (2026-10-11 23:47 UTC)?
--
-- Run by the OWNER in the hosted dashboard SQL editor (read-only). Nobody else
-- runs it, and no tool in this repo connects to hosted.
-- Guide: docs/selfhost-migration/phase-f/hosted-delta-check.md
-- Compare: tools/selfhost-migration/hosted_delta_compare.py <pasted output>
--
-- What it reads (counts, timestamps and an md5 of ids, nothing else):
--   * every base table in schema public (found at run time, so a missing or
--     extra table is handled), plus auth.users, auth.identities,
--     auth.mfa_factors, storage.buckets, storage.objects
--   * per table: count(*); max(created_at) and max(updated_at) where the
--     column exists; rows with created_at / updated_at after the cutoff; rows
--     where any other timestamp column (shift ended, code consumed, last sign
--     in, ...) is after the cutoff; an md5 over the sorted ids (the same
--     expression as the export manifest, so replaced rows show up)
--   * migration count and max version
-- It never selects a row, an e-mail, a name or any other column value. The
-- result is ONE row, ONE column `hosted_delta`: a compact JSON text.
--
-- The whole text runs as one implicit transaction (one query message), and
-- the first statement makes that transaction READ ONLY. The output repeats
-- the setting ("read_only":"on"), and the compare script checks it.
-- Column names: hosted schema at migration 061 (public: 31 tables; auth and
-- storage: hosted GoTrue / storage-api). Columns are looked up in pg_catalog,
-- so a table without created_at / updated_at is still counted.

set transaction read only;
set local statement_timeout = '60s';
set local timezone = 'UTC';

with
cfg as (
  select timestamptz '2026-10-11 23:47:00+00' as cutoff,
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'::text as fmt
),
-- tables of the export manifest (tools/selfhost-migration/sql/tables.default.txt)
-- with the manifest's id expression; a test keeps this list in step with that file
expected(s, t, id_expr) as (values
  ('public', 'product_unit_prices', 'id'),
  ('public', 'product_units', 'id'),
  ('public', 'product_image_upload_sessions', 'id'),
  ('public', 'products', 'id'),
  ('public', 'brands', 'id'),
  ('public', 'audit_logs', 'id'),
  ('public', 'categories', 'id'),
  ('public', 'inventory', $$product_id||':'||shop_id$$),
  ('public', 'admin_login_codes', 'id'),
  ('public', 'inventory_movements', 'id'),
  ('public', 'suppliers', 'id'),
  ('public', 'users', 'id'),
  ('public', 'price_levels', 'id'),
  ('public', 'business_profile', 'id'),
  ('public', 'organizations', 'id'),
  ('public', 'shops', 'id'),
  ('public', 'platform_admins', 'id'),
  ('public', 'price_tiers', 'id'),
  ('public', 'product_barcodes', 'id'),
  ('public', 'purchase_order_items', 'id'),
  ('public', 'purchase_orders', 'id'),
  ('public', 'refund_void_requests', 'id'),
  ('public', 'reprint_logs', 'id'),
  ('public', 'sale_items', 'id'),
  ('public', 'sales', 'id'),
  ('public', 'shifts', 'id'),
  ('public', 'stock_transfer_items', 'id'),
  ('public', 'stock_transfers', 'id'),
  ('public', 'supplier_payments', 'id'),
  ('public', 'supplier_products', $$supplier_id||':'||product_id$$),
  ('public', 'unit_types', 'id'),
  ('auth', 'users', 'id'),
  ('auth', 'identities', 'id'),
  ('auth', 'mfa_factors', 'id'),
  ('storage', 'buckets', 'id'),
  ('storage', 'objects', 'id')
),
cols as (
  select n.nspname::text as s, c.relname::text as t,
         bool_or(a.attname = 'created_at') as has_c,
         bool_or(a.attname = 'updated_at') as has_u,
         bool_or(a.attname = 'id') as has_id,
         coalesce(array_agg(a.attname::text order by a.attnum) filter (
           where format_type(a.atttypid, a.atttypmod) like 'timestamp%'
             and a.attname not in ('created_at', 'updated_at', 'last_accessed_at')
             and a.attname not like '%expires_at'
             and a.attname not like '%until'), '{}') as other_ts
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where c.relkind in ('r', 'p') and not c.relispartition
    and (n.nspname = 'public'
         or (n.nspname, c.relname) in (select e.s, e.t from expected e where e.s <> 'public'))
  group by 1, 2
),
q as (
  select k.s, k.t, k.has_c, k.has_u,
         format('select count(*) as n%s%s%s%s from %I.%I',
           case when k.has_c then format(
             ', to_char(max(created_at) at time zone ''UTC'', %L) as max_c, count(*) filter (where created_at > %L) as c_after',
             cfg.fmt, cfg.cutoff) else '' end,
           case when k.has_u then format(
             ', to_char(max(updated_at) at time zone ''UTC'', %L) as max_u, count(*) filter (where updated_at > %L) as u_after',
             cfg.fmt, cfg.cutoff) else '' end,
           case when cardinality(k.other_ts) > 0 then format(
             ', count(*) filter (where %s) as o_after',
             (select string_agg(format('%I > %L', x, cfg.cutoff), ' or ') from unnest(k.other_ts) x)) else '' end,
           case when coalesce(e.id_expr, case when k.has_id then 'id' end) is not null then format(
             ', md5(coalesce(string_agg((%1$s)::text, '','' order by (%1$s)::text), '''')) as ids',
             coalesce(e.id_expr, 'id')) else '' end,
           k.s, k.t) as sql
  from cols k
  cross join cfg
  left join expected e on e.s = k.s and e.t = k.t
),
r as (
  select q.s || '.' || q.t as name,
         (select jsonb_object_agg(f.name,
                   case when f.name in ('max_c', 'max_u', 'ids') then to_jsonb(coalesce(f.v, ''))
                        else to_jsonb(f.v::bigint) end)
            from (select fn as name, (xpath('/row/' || fn || '/text()', x.doc))[1]::text as v
                    from unnest(array['n', 'max_c', 'c_after', 'max_u', 'u_after', 'o_after', 'ids']) fn) f
           where f.v is not null
              or (f.name = 'max_c' and q.has_c)
              or (f.name = 'max_u' and q.has_u)) as m
  from q
  cross join lateral (select query_to_xml(q.sql, false, true, '') as doc) x
),
mig as (
  select case when to_regclass('supabase_migrations.schema_migrations') is null then null
         else query_to_xml('select count(*) as n, max(version) as mx from supabase_migrations.schema_migrations',
                           false, true, '') end as doc
)
select jsonb_build_object(
  'kind', 'shwephala-hosted-delta',
  'v', 1,
  'cutoff', '2026-10-11T23:47:00Z',
  'ran_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'read_only', current_setting('transaction_read_only'),
  'pg', current_setting('server_version_num'),
  'migrations', (select jsonb_build_object(
                   'n', ((xpath('/row/n/text()', doc))[1]::text)::bigint,
                   'max', coalesce((xpath('/row/mx/text()', doc))[1]::text, ''))
                 from mig where doc is not null),
  'missing', (select coalesce(jsonb_agg(e.s || '.' || e.t order by e.s, e.t), '[]'::jsonb)
                from expected e where to_regclass(format('%I.%I', e.s, e.t)) is null),
  'n_tables', (select count(*) from r),
  'tables', (select coalesce(jsonb_object_agg(r.name, r.m), '{}'::jsonb) from r)
)::text as hosted_delta
