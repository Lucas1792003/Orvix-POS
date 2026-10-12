-- Post-restore integrity checks for the SELF-HOSTED database (docs/05 §4.3–§4.10).
-- Read-only except where noted (nothing is modified; the setval statement is
-- only PRINTED). Run as:
--   docker compose exec -T db psql -U supabase_admin -d postgres -f /tmp/post_restore_checks.sql
-- Every result has a `status` column: ok | FAIL | INFO | ACTION.

\set ON_ERROR_STOP 0
\pset format aligned

-- 1. Orphan checks (FKs are not validated while session_replication_role = replica)
select 'orphans: sale_items -> sales' as check,
       count(*)::text as value,
       case when count(*) = 0 then 'ok' else 'FAIL' end as status
  from public.sale_items si
  left join public.sales s on s.id = si.sale_id
 where s.id is null
union all
select 'orphans: inventory -> products', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from public.inventory i left join public.products p on p.id = i.product_id
 where p.id is null
union all
select 'orphans: inventory -> shops', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from public.inventory i left join public.shops s on s.id = i.shop_id
 where s.id is null
union all
select 'orphans: users.auth_id -> auth.users', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from public.users u left join auth.users au on au.id::text = u.auth_id::text
 where u.auth_id is not null and au.id is null
union all
select 'orphans: auth.identities -> auth.users', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from auth.identities i left join auth.users au on au.id = i.user_id
 where au.id is null
union all
select 'orphans: auth.sessions -> auth.users', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from auth.sessions s left join auth.users au on au.id = s.user_id
 where au.id is null
union all
select 'orphans: auth.refresh_tokens -> auth.sessions', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from auth.refresh_tokens r left join auth.sessions s on s.id = r.session_id
 where r.session_id is not null and s.id is null
union all
select 'orphans: auth.mfa_factors -> auth.users', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from auth.mfa_factors f left join auth.users au on au.id = f.user_id
 where au.id is null;

-- 2. products.image_url / business_profile.logo_url hosts (after §4.6 there must be
--    no *.supabase.co host left; every row should point at the new base URL)
select 'image_url host: ' || coalesce(substring(image_url from '^[a-z]+://[^/]+'), '(none/relative)') as check,
       count(*)::text as value,
       case when coalesce(image_url, '') like '%supabase.co%' then 'FAIL' else 'INFO' end as status
  from public.products
 where image_url is not null and image_url <> ''
 group by 1, 3
union all
select 'logo_url host: ' || coalesce(substring(logo_url from '^[a-z]+://[^/]+'), '(none/relative)'),
       count(*)::text,
       case when coalesce(logo_url, '') like '%supabase.co%' then 'FAIL' else 'INFO' end
  from public.business_profile
 where logo_url is not null and logo_url <> ''
 group by 1, 3
union all
select 'products with supabase.co image_url (must be 0)', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from public.products where image_url like '%supabase.co%'
order by 1;

-- 3. auth.refresh_tokens_id_seq — prints the setval statement to run (§4.3); does not run it
select 'auth.refresh_tokens_id_seq' as check,
       format('last_value=%s max(id)=%s', (select last_value from auth.refresh_tokens_id_seq),
              coalesce((select max(id) from auth.refresh_tokens), 0)) as value,
       case when (select last_value from auth.refresh_tokens_id_seq) >= coalesce((select max(id) from auth.refresh_tokens), 0)
            then 'ok' else 'ACTION' end as status
union all
select 'run this if ACTION above',
       format('SELECT setval(%L, %s, %s);', 'auth.refresh_tokens_id_seq',
              coalesce((select max(id) from auth.refresh_tokens), 1),
              (select max(id) is not null from auth.refresh_tokens)),
       'INFO';

-- 4. Realtime publication (§4.6): expect exactly public.inventory
select 'publication supabase_realtime tables' as check,
       coalesce(string_agg(schemaname || '.' || tablename, ',' order by 1), '(absent)') as value,
       case when string_agg(schemaname || '.' || tablename, ',') = 'public.inventory' then 'ok' else 'FAIL' end as status
  from pg_publication_tables where pubname = 'supabase_realtime';

-- 5. Functions executable by anon (§4.7): after REVOKE the list must be empty
select 'anon-executable public functions' as check,
       count(*)::text || coalesce(': ' || string_agg(p.proname, ',' order by p.proname), '') as value,
       case when count(*) = 0 then 'ok' else 'FAIL' end as status
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind in ('f', 'p')
   and has_function_privilege('anon', p.oid, 'EXECUTE');

-- 6. RLS enabled on every public table; stale authenticated_all policies must be 0
select 'public tables without RLS' as check,
       count(*)::text || coalesce(': ' || string_agg(c.relname, ',' order by c.relname), '') as value,
       case when count(*) = 0 then 'ok' else 'FAIL' end as status
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
union all
select 'leftover authenticated_all policies', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from pg_policies where schemaname = 'public' and policyname = 'authenticated_all'
union all
select 'public policies total', count(*)::text, 'INFO' from pg_policies where schemaname = 'public'
union all
select 'public tables', count(*)::text, case when count(*) = 31 then 'ok' else 'INFO' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p');

-- 7. Migration history (§4.4): hosted has 61 rows, 001..061
select 'supabase_migrations.schema_migrations rows' as check,
       count(*)::text || ' (max ' || coalesce(max(version), '-') || ')' as value,
       case when count(*) >= 61 then 'ok' else 'ACTION' end as status
  from supabase_migrations.schema_migrations;

-- 8. Storage bucket + cron jobs + extensions (informational)
select 'storage bucket product-images' as check,
       coalesce((select 'public=' || public::text from storage.buckets where id = 'product-images'), '(absent)') as value,
       case when exists (select 1 from storage.buckets where id = 'product-images' and public) then 'ok' else 'FAIL' end as status
union all
select 'storage.objects in product-images', count(*)::text, 'INFO' from storage.objects where bucket_id = 'product-images'
union all
select 'cron.job rows', count(*)::text || coalesce(': ' || string_agg(jobname, ',' order by jobname), ''),
       case when count(*) in (0, 2) then 'INFO' else 'FAIL' end
  from cron.job
union all
select 'cron.job commands referencing supabase.co (must be 0)', count(*)::text,
       case when count(*) = 0 then 'ok' else 'FAIL' end
  from cron.job where command like '%supabase.co%'
union all
select 'extension ' || extname, extversion || ' in ' || n.nspname, 'INFO'
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
 where extname in ('pg_cron', 'pg_net', 'pgcrypto', 'uuid-ossp', 'pg_stat_statements', 'supabase_vault')
union all
select 'timezone', current_setting('TimeZone'), case when current_setting('TimeZone') in ('UTC', 'Etc/UTC', 'GMT') then 'ok' else 'FAIL' end
union all
select 'cron.timezone', coalesce(current_setting('cron.timezone', true), '(unset)'),
       case when coalesce(current_setting('cron.timezone', true), 'GMT') in ('UTC', 'Etc/UTC', 'GMT') then 'ok' else 'FAIL' end
order by 1;

-- 9. Row counts of the auth tables we restored (quick eyeball; the full
--    comparison is manifest_diff.py against manifest-hosted.json)
select 'auth.users' as check, count(*)::text as value, 'INFO' as status from auth.users
union all select 'auth.identities', count(*)::text, 'INFO' from auth.identities
union all select 'auth.mfa_factors', count(*)::text, 'INFO' from auth.mfa_factors
union all select 'auth.sessions', count(*)::text, 'INFO' from auth.sessions
union all select 'auth.refresh_tokens', count(*)::text, 'INFO' from auth.refresh_tokens
union all select 'public.users without auth row', count(*)::text, 'INFO'
  from public.users u where u.auth_id is null;
