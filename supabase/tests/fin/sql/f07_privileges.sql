-- f07: effective ownership and privileges of the PFIN-B functions, on the
-- tested image (runs before 087 and again under 087). Scoped to the 7 PFIN-B
-- functions by name, so it holds whether or not the held PFIN-C is installed.
-- Regression test for the
-- review finding "SECURITY DEFINER functions owned by the superuser runner".
\set ON_ERROR_STOP on
SELECT 'INFO roles: ' || string_agg(rolname || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls || ' createrole=' || rolcreaterole, '; ' ORDER BY rolname)
  FROM pg_roles WHERE rolname IN ('postgres', 'supabase_admin', 'authenticated', 'service_role', 'anon', 'recovery_owner');
SELECT 'INFO supautils: privileged_role=' || coalesce(current_setting('supautils.privileged_role', true), '-')
       || ' reserved_roles=' || coalesce(current_setting('supautils.reserved_roles', true), '-');
SELECT 'INFO fn ' || p.oid::regprocedure || ' owner=' || p.proowner::regrole || ' secdef=' || p.prosecdef
       || ' volatile=' || p.provolatile::text || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-') || ' acl=' || coalesce(p.proacl::text, 'default')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'fin\_%' ORDER BY 1;

-- 1. the tested image: postgres is not a superuser (the reason ownership by postgres is the safe choice)
SELECT test.check('f07 on the tested image postgres is NOT a superuser (it has BYPASSRLS); supabase_admin is',
  NOT (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') AND (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'postgres')
  AND (SELECT rolsuper FROM pg_roles WHERE rolname = 'supabase_admin'));
-- 2. ownership: every PFIN-B function owned by postgres; no PFIN function owned by any superuser or recovery role
SELECT test.check('f07 fin_report_summary and fin_shift_reconciliation are SECURITY DEFINER owned by postgres',
  (SELECT bool_and(prosecdef AND proowner = 'postgres'::regrole) AND count(*) = 2 FROM pg_proc
    WHERE oid IN ('public.fin_report_summary(text,date,date,text)'::regprocedure, 'public.fin_shift_reconciliation(text)'::regprocedure)));
SELECT test.check('f07 no fin_ function is owned by a superuser or a recovery role (no escalation through a definer function)',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
               WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'fin\_%'
                 AND (r.rolsuper OR r.rolname LIKE 'recovery\_%')));
SELECT test.check('f07 the identity helpers the PFIN-B definers call are postgres-owned definer functions too (one trust level, no superuser code path)',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
               WHERE p.oid IN ('public.app_role()'::regprocedure, 'public.app_has_perm(text)'::regprocedure, 'public.current_app_user()'::regprocedure,
                               'public.app_org_shop_ids()'::regprocedure, 'public.app_shop_in_org(text)'::regprocedure)
                 AND (r.rolsuper OR NOT p.prosecdef)));
-- 3. pinned configuration
SELECT test.check('f07 entry points pin search_path = public, pg_temp, force_custom_plan and a 30 s statement timeout',
  (SELECT bool_and(proconfig @> ARRAY['search_path=public, pg_temp', 'plan_cache_mode=force_custom_plan', 'statement_timeout=30s']) FROM pg_proc
    WHERE oid IN ('public.fin_report_summary(text,date,date,text)'::regprocedure, 'public.fin_shift_reconciliation(text)'::regprocedure)));
SELECT test.check('f07 every fin_ helper pins search_path = public, pg_temp',
  (SELECT bool_and(proconfig @> ARRAY['search_path=public, pg_temp']) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'fin\_%'));
-- 4. EXECUTE: entry points for authenticated + service_role only; helpers for neither anon nor authenticated; nothing for PUBLIC
SELECT test.check('f07 EXECUTE on the entry points: authenticated and service_role yes; anon no; no PUBLIC grant',
  has_function_privilege('authenticated', 'public.fin_report_summary(text,date,date,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.fin_report_summary(text,date,date,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.fin_shift_reconciliation(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.fin_report_summary(text,date,date,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.fin_shift_reconciliation(text)', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'fin\_%' AND a.grantee = 0));
SELECT test.check('f07 exact EXECUTE grantees: entry points {authenticated, postgres, service_role}; helpers {postgres, service_role}',
  (SELECT bool_and(g = CASE WHEN p.proname IN ('fin_report_summary', 'fin_shift_reconciliation')
                            THEN ARRAY['authenticated', 'postgres', 'service_role'] ELSE ARRAY['postgres', 'service_role'] END)
     FROM pg_proc p, LATERAL (SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) AS g
                                FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) x
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('fin_report_summary', 'fin_shift_reconciliation',
      'fin_report_scope', 'fin_items', 'fin_sale_line_net', 'fin_approval_times', 'fin_refund_lines', 'fin_line_costs')));
SELECT test.check('f07 helpers (scope, items, line net, approval times, refund lines) not executable by anon or authenticated',
  (SELECT bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('fin_report_scope', 'fin_items', 'fin_sale_line_net', 'fin_approval_times', 'fin_refund_lines', 'fin_line_costs')));
-- 5. the definer reads every table it needs as its owner, unfiltered (no FORCE RLS, owner = postgres or SELECT granted)
SELECT test.check('f07 postgres can read every table the reports use, and none has FORCE ROW LEVEL SECURITY (no silent filtering)',
  (SELECT bool_and(has_table_privilege('postgres', c.oid, 'SELECT') AND NOT c.relforcerowsecurity) FROM pg_class c
    WHERE c.oid IN ('public.sales'::regclass, 'public.sale_items'::regclass, 'public.refund_void_requests'::regclass, 'public.audit_logs'::regclass,
                    'public.shifts'::regclass, 'public.supplier_payments'::regclass, 'public.idempotency_keys'::regclass,
                    'public.shops'::regclass, 'public.users'::regclass, 'public.products'::regclass)),
  (SELECT string_agg(c.relname || ' owner=' || c.relowner::regrole || ' force=' || c.relforcerowsecurity, '; ') FROM pg_class c
    WHERE c.oid IN ('public.idempotency_keys'::regclass, 'public.audit_logs'::regclass)));
-- 6. 087 compatibility (only when installed): reserved roles configured, no PFIN function uses a protected name or the recovery schemas
SELECT test.check('f07 087 reserved-role protection intact (recovery roles reserved) and no PFIN object depends on a recovery role',
  to_regnamespace('recovery') IS NULL
  OR (string_to_array(replace(current_setting('supautils.reserved_roles', true), ' ', ''), ',') @> ARRAY['recovery_owner', 'recovery_authority', 'recovery_gate']
      AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'fin\_%'
                       AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%' OR p.prosrc LIKE '%recovery.%' OR p.prosrc LIKE '%recovery_guard.%'))));
-- 7. behaviour: a definer call made as authenticated runs with postgres's rights, never superuser rights
SELECT test.login('a0000000-0000-4000-8000-000000000001') AS zz \gset
SET ROLE authenticated;
SELECT test.check('f07 an authenticated caller gets a report through the definer function, and has no SELECT on idempotency_keys itself',
  jsonb_typeof(public.fin_report_summary('shop-f', current_date, current_date, 'SALE_DATE')->'totals') = 'object'
  AND NOT has_table_privilege('authenticated', 'public.idempotency_keys', 'SELECT'));
RESET ROLE;
SELECT test.logout() AS zz \gset
