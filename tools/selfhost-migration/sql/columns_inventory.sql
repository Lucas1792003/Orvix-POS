-- Column inventory of the service-owned schemas (auth, storage), used by
-- schema_compat.py to compare hosted vs self-hosted before restoring data.sql.
--
-- hosted:      supabase db query --linked -f tools/selfhost-migration/sql/columns_inventory.sql > columns-hosted.json
-- self-hosted: docker compose exec -T db psql -U supabase_admin -d postgres -A -F '|' \
--                -f /tmp/columns_inventory.sql > columns-selfhost.txt
select table_schema,
       table_name,
       column_name,
       data_type,
       is_nullable,
       column_default,
       ordinal_position
  from information_schema.columns
 where table_schema in ('auth', 'storage')
 order by table_schema, table_name, ordinal_position;
