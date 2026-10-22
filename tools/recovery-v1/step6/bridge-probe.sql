-- Step 6: what the Control bridge login can reach on the POS, run AS that login (psql -U orvix_control_bridge, over TCP).
-- One JSON line. Expected: no table, view or sequence privilege anywhere outside the system catalogs; direct reads of
-- money tables refused (42501); the seven operator functions executable; the Step 4/5 operator extras (R4-M3) reported.
\set ON_ERROR_STOP 0
\pset tuples_only on
\pset format unaligned
SELECT json_build_object(
  'login', session_user,
  'attributes', (SELECT json_build_object('super', rolsuper, 'createrole', rolcreaterole, 'createdb', rolcreatedb, 'replication', rolreplication,
                   'bypassrls', rolbypassrls, 'inherit', rolinherit) FROM pg_roles WHERE rolname = session_user),
  'memberOf', (SELECT coalesce(json_agg(g.rolname ORDER BY g.rolname), '[]') FROM pg_roles g
                WHERE g.rolname <> session_user AND pg_has_role(session_user, g.oid, 'MEMBER')),
  -- every table/view this login can touch, with the privileges and whether anon (the PUBLIC baseline every role inherits)
  -- holds the same: the Supabase image grants some extension tables to PUBLIC
  'tablePrivileges', (SELECT coalesce(json_agg(json_build_object('rel', n.nspname || '.' || c.relname,
                    'privileges', (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) x
                                    WHERE has_table_privilege(c.oid, x)),
                    'schemaUsage', has_schema_privilege(n.oid, 'USAGE'),
                    'sameAsAnon', (SELECT bool_and(has_table_privilege(c.oid, x) = has_table_privilege('anon', c.oid, x))
                                    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) x)) ORDER BY n.nspname, c.relname), '[]')
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
                  AND CASE WHEN c.relkind IN ('r', 'v', 'm', 'p', 'f') THEN has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END),
  'sequencePrivileges', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE,SELECT,UPDATE') ELSE false END),
  'recoveryV1Executable', (SELECT coalesce(json_agg(p.proname ORDER BY p.proname), '[]') FROM pg_proc p
                WHERE p.pronamespace = 'recovery_v1'::regnamespace AND has_function_privilege(p.oid, 'EXECUTE')),
  'publicDefinerExecutable', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                AND has_function_privilege(p.oid, 'EXECUTE')),
  'publicDefinerExecutableByAnon', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'publicDefinerBridgeOnly', (SELECT coalesce(json_agg(p.proname ORDER BY p.proname), '[]') FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND has_function_privilege(p.oid, 'EXECUTE')
                  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')))::text;
-- direct reads of money and customer tables: each must fail with 42501
SELECT 'read public.sales' AS probe; SELECT count(*) FROM public.sales;
SELECT 'read public.sale_items' AS probe; SELECT count(*) FROM public.sale_items;
SELECT 'read public.products' AS probe; SELECT count(*) FROM public.products;
SELECT 'read recovery_v1.org_state' AS probe; SELECT count(*) FROM recovery_v1.org_state;
SELECT 'read auth.users' AS probe; SELECT count(*) FROM auth.users;
-- rows actually visible through the PUBLIC-granted extension tables (each separately: no schema usage = an error = unreachable)
SELECT 'visible extensions.pg_stat_statements other_users_query_text ' || count(*) FROM extensions.pg_stat_statements s
 WHERE s.userid <> (SELECT oid FROM pg_roles WHERE rolname = session_user) AND s.query <> '<insufficient privilege>';
SELECT 'visible cron.job ' || count(*) FROM cron.job;
SELECT 'visible cron.job_run_details ' || count(*) FROM cron.job_run_details;
SELECT 'visible net._http_response ' || count(*) FROM net._http_response;
SELECT 'visible net.http_request_queue ' || count(*) FROM net.http_request_queue;
