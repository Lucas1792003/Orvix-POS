-- Constraint / index / trigger names per table in auth and storage, for a
-- side-by-side comparison (schema_compat.py --constraints-hosted/--constraints-selfhost).
--
-- hosted:      supabase db query --linked -f tools/selfhost-migration/sql/constraints_inventory.sql > constraints-hosted.json
-- self-hosted: docker compose exec -T db psql -U supabase_admin -d postgres -A -F '|' \
--                -f /tmp/constraints_inventory.sql > constraints-selfhost.txt
select * from (
  select n.nspname          as table_schema,
         c.relname          as table_name,
         'constraint'       as kind,
         con.conname        as name,
         con.contype::text  as detail
    from pg_constraint con
    join pg_class c      on c.oid = con.conrelid
    join pg_namespace n  on n.oid = c.relnamespace
   where n.nspname in ('auth', 'storage')
  union all
  select schemaname, tablename, 'index', indexname, ''
    from pg_indexes
   where schemaname in ('auth', 'storage')
  union all
  select n.nspname, c.relname, 'trigger', t.tgname, ''
    from pg_trigger t
    join pg_class c      on c.oid = t.tgrelid
    join pg_namespace n  on n.oid = c.relnamespace
   where n.nspname in ('auth', 'storage')
     and not t.tgisinternal
) x
order by table_schema, table_name, kind, name;
