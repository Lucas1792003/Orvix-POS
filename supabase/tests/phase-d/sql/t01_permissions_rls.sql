-- t01: privilege matrix (064), idempotency_keys lockdown (062), anon /
-- unauthenticated / cashier / service_role behaviour, cross-shop RLS.
\set ON_ERROR_STOP on
SELECT test.logout() AS zz \gset

-- ---- privilege matrix, evaluated as superuser ----
-- (+ app_setup_needed once 067 is applied: the anonymous /setup probe)
SELECT test.check('anon can execute exactly the 2 token-scoped phone-upload RPCs (064 §4) (+ app_setup_needed after 067)',
  (SELECT COALESCE(array_agg(p.proname::text ORDER BY p.proname), '{}')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
  = (SELECT array_agg(x ORDER BY x) FROM unnest(
       ARRAY['get_product_image_upload_session_by_token']
       -- 083: completion only through the phone-upload-token function (service_role)
       || CASE WHEN test.m083() THEN '{}'::text[] ELSE ARRAY['complete_product_image_upload_session'] END
       || CASE WHEN to_regprocedure('public.app_setup_needed()') IS NOT NULL THEN ARRAY['app_setup_needed'] ELSE '{}'::text[] END) x),
  (SELECT string_agg(p.proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')));

-- (+ the two org-guard helpers once 068 is applied: they are called from inside
--  the SECURITY DEFINER RPCs and would be an existence oracle for foreign ids)
SELECT test.check('authenticated can execute every public function except complete_stock_transfer + idem helpers (+ org-guard helpers after 068)',
  (SELECT COALESCE(array_agg(p.proname::text ORDER BY p.proname), '{}')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  = (SELECT array_agg(x ORDER BY x) FROM unnest(
       ARRAY['complete_stock_transfer','idem_begin','idem_finish','prune_idempotency_keys']
       || CASE WHEN to_regprocedure('public.app_require_org(text,text)') IS NOT NULL
               THEN ARRAY['app_require_org','app_require_org_items'] ELSE '{}'::text[] END
       -- 077/078 internal helpers that take a foreign id (service_role only)
       || CASE WHEN to_regprocedure('public.app_seed_default_price_levels(text)') IS NOT NULL
               THEN ARRAY['app_seed_default_price_levels'] ELSE '{}'::text[] END
       || CASE WHEN to_regprocedure('public.app_storage_object_org(text)') IS NOT NULL
               THEN ARRAY['app_storage_object_org'] ELSE '{}'::text[] END
       -- 080: URL helper reading service_role-only configuration
       || CASE WHEN to_regprocedure('public.app_upload_session_public_url(text)') IS NOT NULL
               THEN ARRAY['app_upload_session_public_url'] ELSE '{}'::text[] END
       -- 081: phone-upload token limiter (the Edge Function, service_role only)
       || CASE WHEN to_regprocedure('public.claim_phone_upload_token_issue(text)') IS NOT NULL
               THEN ARRAY['claim_phone_upload_token_issue'] ELSE '{}'::text[] END
       -- 083: phone completion through the validating Edge Function (service_role only)
       || CASE WHEN test.m083() THEN ARRAY['complete_product_image_upload_session'] ELSE '{}'::text[] END) x),
  (SELECT string_agg(p.proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')));

SELECT test.check('service_role can execute every public function',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')) = 0);

-- 58 (snapshot) + 3 idem helpers (062) + app_setup_needed (067) + 9 org helpers/triggers (068, incl. enforce_same_org_refs) + 1 storage helper (071) + bootstrap_first_admin (076)
SELECT test.check('public function count = 58 + 3 idem helpers (+1 after 067, +9 after 068, +1 after 071, +1 after 076)',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
  = 61 + CASE WHEN to_regprocedure('public.app_setup_needed()') IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN to_regprocedure('public.app_require_org(text,text)') IS NOT NULL THEN 9 ELSE 0 END
       + CASE WHEN to_regprocedure('public.app_storage_owner_in_org(text,uuid)') IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN to_regprocedure('public.bootstrap_first_admin()') IS NOT NULL THEN 1 ELSE 0 END
       -- 077: app_seed_default_price_levels + organizations_seed_price_levels
       + CASE WHEN to_regprocedure('public.app_seed_default_price_levels(text)') IS NOT NULL THEN 2 ELSE 0 END
       -- 078: app_storage_object_org / _object_in_my_org / _can_write_path
       + CASE WHEN to_regprocedure('public.app_storage_object_org(text)') IS NOT NULL THEN 3 ELSE 0 END
       -- 080: app_upload_session_public_url
       + CASE WHEN to_regprocedure('public.app_upload_session_public_url(text)') IS NOT NULL THEN 1 ELSE 0 END
       -- 081: claim_phone_upload_token_issue
       + CASE WHEN to_regprocedure('public.claim_phone_upload_token_issue(text)') IS NOT NULL THEN 1 ELSE 0 END,
  (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'));

SELECT test.check('no overloaded public functions after 063 (old signatures dropped)',
  (SELECT count(*) FROM (SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' GROUP BY 1 HAVING count(*) > 1) x) = 0);

SELECT test.check('30 RPCs carry p_idempotency_key',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND pg_get_function_identity_arguments(p.oid) LIKE '%p_idempotency_key%') = 30);

-- Only role postgres's default ACL is under the migration's control (it runs
-- as postgres, like `supabase db push`); supabase_admin's is a runbook step.
SELECT test.check('default ACL (role postgres) for new functions has no anon / PUBLIC entry',
  NOT EXISTS (SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
               WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'
                 AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
                 AND (d.defaclacl::text LIKE '%anon=%' OR d.defaclacl::text LIKE '{=%' OR d.defaclacl::text LIKE '%,=%')),
  (SELECT string_agg(pg_get_userbyid(d.defaclrole) || ':' || d.defaclacl::text, ' ')
     FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
    WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'));

SELECT test.check('idempotency_keys: RLS on, zero policies',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.idempotency_keys'::regclass)
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'idempotency_keys') = 0);

SELECT test.check('idempotency_keys: no table privileges for anon/authenticated',
  NOT has_table_privilege('anon', 'public.idempotency_keys', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.idempotency_keys', 'SELECT')
  AND has_table_privilege('service_role', 'public.idempotency_keys', 'SELECT'));

SELECT test.check('idem helpers are SECURITY DEFINER',
  (SELECT bool_and(prosecdef) FROM pg_proc WHERE proname IN ('idem_begin','idem_finish','prune_idempotency_keys')));

-- table grants vs hosted list (loaded by run.sh into test.expected_grants)
SELECT test.check('table grants match hosted-grants.txt exactly (065)',
  (SELECT count(*) FROM test.expected_grants) > 0 AND NOT EXISTS (
    SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role')
       AND table_name NOT IN ('idempotency_keys', 'app_config')  -- both new after the snapshot; app_config (080) checked in t16
     GROUP BY 1,2
    EXCEPT SELECT table_name, grantee, privs FROM test.expected_grants
  ) AND NOT EXISTS (
    SELECT table_name, grantee, privs FROM test.expected_grants
    EXCEPT
    SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role')
     GROUP BY 1,2
  ),
  'expected rows: ' || (SELECT count(*) FROM test.expected_grants));

-- ---- anon ----
SET ROLE anon;
SELECT test.expect_error('anon: complete_sale -> permission denied',
  $q$SELECT public.complete_sale('shop-a','x','CASH',0,0,'[]'::jsonb)$q$, 'permission denied');
SELECT test.expect_error('anon: open_shift -> permission denied',
  $q$SELECT public.open_shift('shop-a', 0)$q$, 'permission denied');
SELECT test.expect_error('anon: app_has_perm helper -> permission denied',
  $q$SELECT public.app_has_perm('pos:create_sale')$q$, 'permission denied');
SELECT test.expect_error('anon: complete_stock_transfer (legacy) -> permission denied',
  $q$SELECT public.complete_stock_transfer('x')$q$, 'permission denied');
SELECT test.expect_error('anon: idempotency_keys -> permission denied',
  $q$SELECT count(*) FROM public.idempotency_keys$q$, 'permission denied');
SELECT test.check('anon: RLS hides every users row', (SELECT count(*) FROM users) = 0);
RESET ROLE;

-- ---- authenticated with NO JWT claims ----
SET ROLE authenticated;
SELECT test.expect_error('authenticated without claims: complete_sale raises Not authenticated',
  $q$SELECT public.complete_sale('shop-a','x','CASH',0,0,'[]'::jsonb, NULL, gen_random_uuid())$q$, 'Not authenticated');
SELECT test.expect_error('authenticated without claims: adjust_stock raises Not authenticated',
  $q$SELECT public.adjust_stock('shop-a','prod-1','ADJUSTMENT',1,'x',NULL,NULL,NULL,NULL,gen_random_uuid())$q$, 'Not authenticated');
SELECT test.expect_error('authenticated: idempotency_keys -> permission denied',
  $q$SELECT count(*) FROM public.idempotency_keys$q$, 'permission denied');
SELECT test.expect_error('authenticated: idem_begin not callable directly',
  $q$SELECT public.idem_begin(gen_random_uuid(), 'x', 'y')$q$, 'permission denied');
SELECT test.expect_error('authenticated: complete_stock_transfer (052 revoke kept)',
  $q$SELECT public.complete_stock_transfer('x')$q$, 'permission denied');
RESET ROLE;

-- ---- cashier A1 ----
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT test.check('cashier: auth.uid() resolves from JWT claim GUC', auth.uid() = 'a0000000-0000-4000-8000-000000000003');
SELECT test.check('cashier: current_app_user() = u-cash-a1', (current_app_user()).id = 'u-cash-a1');
SELECT test.expect_error('cashier: open_shift without key -> IDEMPOTENCY_KEY_REQUIRED',
  $q$SELECT public.open_shift('shop-a', 0)$q$, 'IDEMPOTENCY_KEY_REQUIRED');
SELECT test.expect_error('cashier: approve_purchase_order -> permission error raised inside the RPC',
  $q$SELECT public.approve_purchase_order('po-draft', gen_random_uuid())$q$, 'not permitted to approve purchase orders');
SELECT test.expect_error('cashier: approve_refund_request -> permission error raised inside the RPC',
  $q$SELECT public.approve_refund_request('nope', gen_random_uuid())$q$, 'not permitted to approve refunds');
SELECT test.expect_error('cashier: approve_void_request -> permission error raised inside the RPC',
  $q$SELECT public.approve_void_request('nope', gen_random_uuid())$q$, 'not permitted to approve voids');
SELECT test.expect_error('cashier: adjust_stock -> permission error raised inside the RPC',
  $q$SELECT public.adjust_stock('shop-a','prod-1','ADJUSTMENT',1,'x',NULL,NULL,NULL,NULL,gen_random_uuid())$q$, 'not permitted');
SELECT test.expect_error('cashier: expected_actor mismatch (055 guard) still raises',
  $q$SELECT public.open_shift('shop-a', 0, NULL, 'u-cash-a2', gen_random_uuid())$q$, 'queued by a different user');
SELECT test.check('cashier A1 cannot read shop B inventory', (SELECT count(*) FROM inventory WHERE shop_id = 'shop-b') = 0);
SELECT test.check('cashier A1 cannot read shop B sales',     (SELECT count(*) FROM sales     WHERE shop_id = 'shop-b') = 0);
SELECT test.check('cashier A1 cannot read shop B shifts',    (SELECT count(*) FROM shifts    WHERE shop_id = 'shop-b') = 0);
SELECT test.check('cashier A1 cannot read shop B users',     (SELECT count(*) FROM users     WHERE shop_id = 'shop-b') = 0);
SELECT test.check('cashier A1 can read own shop inventory (3 rows)', (SELECT count(*) FROM inventory WHERE shop_id = 'shop-a') = 3);
SELECT test.check('cashier A1 cannot write inventory directly', NOT has_table_privilege('inventory', 'UPDATE'));
SELECT test.check('cashier A1 cannot insert sales directly',   NOT has_table_privilege('sales', 'INSERT'));
RESET ROLE;
SELECT test.check('sanity: shop B rows exist when RLS is bypassed', (SELECT count(*) FROM sales WHERE shop_id = 'shop-b') = 1);

-- ---- service_role ----
SET ROLE service_role;
SELECT test.check('service_role: prune_idempotency_keys callable', public.prune_idempotency_keys() >= 0);
SELECT test.check('service_role: can read idempotency_keys', (SELECT count(*) FROM public.idempotency_keys) >= 0);
RESET ROLE;
SELECT test.logout() AS zz \gset
