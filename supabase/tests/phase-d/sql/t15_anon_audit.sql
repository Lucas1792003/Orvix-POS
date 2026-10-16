-- t15: anonymous-function audit. anon (the public ANON_KEY, no session) can
-- execute exactly three public functions:
--   app_setup_needed()                          (067: /setup + login page, pre-sign-in)
--   get_product_image_upload_session_by_token() (019/064: phone QR page)
--   complete_product_image_upload_session()     (019/064/075/079: phone QR page)
-- This file proves what an unauthenticated caller - and an authenticated
-- account with no app user (what an open GoTrue signup produces) - can and
-- cannot reach. Populated install (org-test, org-two, t11/t13 orgs).
-- Gated by run.sh on migrations >= 079 (audits the proposed state).
\set ON_ERROR_STOP on
\set AA   'a0000000-0000-4000-8000-000000000001'
\set ORPH 'c0000000-0000-4000-8000-0000000000f5'
\set PUB  'https://pos.test/storage/v1/object/public/product-images/'
SELECT test.logout() AS zz \gset

-- rows the CURRENT role can read from a relation; -1 = permission denied
CREATE OR REPLACE FUNCTION test.visible_rows(p_rel regclass) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM %s', p_rel) INTO v;
  RETURN v;
EXCEPTION WHEN insufficient_privilege THEN RETURN -1;
END $$;
-- every public table / view / matview + storage.objects, with what the current role sees
CREATE OR REPLACE FUNCTION test.visible_sweep() RETURNS TABLE (rel text, n bigint) LANGUAGE sql AS $$
  SELECT c.oid::regclass::text, test.visible_rows(c.oid::regclass)
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE (ns.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p'))
      OR (ns.nspname = 'storage' AND c.relname = 'objects');
$$;
GRANT EXECUTE ON FUNCTION test.visible_rows(regclass), test.visible_sweep() TO anon, authenticated;
-- the statement must fail with a privilege / RLS error (which of the two
-- depends on the table grants anon holds - 065 parity with hosted)
-- true when the statement fails with an RLS error or one of the users-table
-- assignment guards (047 privilege guard, 020 shop-assignment rules)
CREATE OR REPLACE FUNCTION test.expect_denied_re(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RETURN SQLERRM ~ '(row-level security|permission denied|Only an ADMIN|must be assigned|without an active manager|already has)';
  END;
  RETURN false;
END $$;
CREATE OR REPLACE FUNCTION test.expect_denied(p_name text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    RETURN test.check(p_name, v_msg ~ '(permission denied|row-level security)', 'got: ' || left(v_msg, 120));
  END;
  RETURN test.check(p_name, false, 'statement SUCCEEDED');
END $$;

-- ============================================================
-- 1. The anon surface
-- ============================================================
SELECT test.check('t15: anon executes exactly app_setup_needed + the two token-scoped phone RPCs',
  (SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE'))
  = (CASE WHEN test.m083() THEN ARRAY['app_setup_needed', 'get_product_image_upload_session_by_token'] ELSE ARRAY['app_setup_needed', 'complete_product_image_upload_session', 'get_product_image_upload_session_by_token'] END),
  (SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')));
SELECT test.check('t15: app_setup_needed() is a zero-argument STABLE boolean probe over users only (no other table, no parameter)',
  (SELECT pronargs = 0 AND provolatile = 's' AND prorettype = 'boolean'::regtype AND prosecdef
          AND prosrc ~ 'NOT EXISTS \(SELECT 1 FROM public\.users\)' AND prosrc !~ '(organizations|shops|business_profile|auth\.)'
     FROM pg_proc WHERE oid = 'public.app_setup_needed()'::regprocedure));
SELECT test.check('t15: setup/privileged functions are NOT anon-executable (bootstrap_first_admin, create_app_user, seeding, storage helpers)',
  NOT has_function_privilege('anon', 'public.bootstrap_first_admin()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_app_user(text,text,text,text,text,uuid,text[],text[],uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.app_seed_default_price_levels(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.app_storage_can_write_path(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.create_product_image_upload_session(text,text)', 'EXECUTE'));

SET ROLE anon;
SELECT public.app_setup_needed() AS anon_setup \gset
SELECT COALESCE(string_agg(rel || '=' || n, ' ' ORDER BY rel) FILTER (WHERE n > 0), '') AS anon_leaks,
       count(*) AS anon_rels, count(*) FILTER (WHERE n = -1) AS anon_denied
  FROM test.visible_sweep() \gset
SELECT test.expect_error('t15 anon: bootstrap_first_admin -> permission denied (cannot trigger setup)',
  'SELECT public.bootstrap_first_admin()', 'permission denied');
SELECT test.expect_denied('t15 anon: direct INSERT organizations -> refused',
  $q$INSERT INTO organizations (id, name) VALUES ('org-anon', 'Anon')$q$);
SELECT test.expect_denied('t15 anon: direct INSERT users -> refused',
  $q$INSERT INTO users (id, name, email, role, org_id) VALUES ('u-anon', 'Anon', 'a@x', 'ADMIN', 'org-test')$q$);
SELECT test.expect_denied('t15 anon: direct UPDATE business_profile -> refused or 0 rows',
  $q$DO $d$ BEGIN UPDATE business_profile SET business_name = 'pwned'; IF FOUND THEN RAISE EXCEPTION 'updated rows'; END IF; RAISE EXCEPTION 'row-level security: 0 rows'; END $d$$q$);
RESET ROLE;
SELECT test.check('t15 anon: app_setup_needed() on a populated install answers false - one bit, nothing else',
  :'anon_setup' = 'f');
SELECT test.check('t15 anon: reads ZERO rows from every public table/view and storage.objects (organizations, users, shops, business_profile, catalog, sessions, keys ...)',
  :'anon_leaks' = '' AND :anon_rels > 30,
  'relations=' || :anon_rels || ' permission-denied=' || :anon_denied || ' leaks=' || COALESCE(NULLIF(:'anon_leaks', ''), 'none'));

-- ============================================================
-- 2. An account from an open GoTrue signup = an auth.users row, no app user
-- ============================================================
INSERT INTO auth.users (id, email) VALUES (:'ORPH', 'stranger@signup.local');
SELECT count(*) AS orgs_before FROM organizations \gset
SELECT count(*) AS users_before FROM users \gset
SELECT test.login(:'ORPH') AS zz \gset
SET ROLE authenticated;
SELECT COALESCE(public.app_role() IS NULL AND public.app_org_id() IS NULL AND public.app_user_id() IS NULL
        AND NOT public.app_has_perm('user:create') AND NOT public.app_has_perm('product:create'), false) AS orph_noperm \gset
SELECT COALESCE(string_agg(rel || '=' || n, ' ' ORDER BY rel) FILTER (WHERE n > 0), '') AS orph_leaks,
       count(*) AS orph_rels
  FROM test.visible_sweep() \gset
SELECT test.expect_error('t15 signup account: bootstrap_first_admin after initialization -> SETUP_ALREADY_COMPLETED',
  'SELECT public.bootstrap_first_admin()', 'SETUP_ALREADY_COMPLETED');
SELECT test.expect_error('t15 signup account: INSERT itself as an ADMIN users row -> refused (047 privilege guard fires first)',
  format($q$INSERT INTO users (id, name, email, role, org_id, auth_id) VALUES ('u-stranger', 'S', 'stranger@signup.local', 'ADMIN', 'org-test', %L)$q$, :'ORPH'),
  'Only an ADMIN can create a user');
-- any non-ADMIN self-enrolment: whichever guard fires first (020 assignment
-- rules run as BEFORE triggers, RLS WITH CHECK after them), it is refused
SELECT test.check('t15 signup account: INSERT itself as a CASHIER / MANAGER users row -> refused',
  (SELECT bool_and(r) FROM (VALUES
        (test.expect_denied_re(format($q$INSERT INTO users (id, name, email, role, shop_id, org_id, auth_id) VALUES ('u-stranger', 'S', 'stranger@signup.local', 'CASHIER', 'shop-b', 'org-test', %L)$q$, :'ORPH'))),
        (test.expect_denied_re(format($q$INSERT INTO users (id, name, email, role, shop_id, org_id, auth_id) VALUES ('u-stranger', 'S', 'stranger@signup.local', 'MANAGER', 'shop-b', 'org-test', %L)$q$, :'ORPH')))
      ) x(r)));
SELECT test.expect_error('t15 signup account: INSERT an organization -> RLS',
  $q$INSERT INTO organizations (id, name) VALUES ('org-stranger', 'S')$q$, 'row-level security');
SELECT test.expect_error('t15 signup account: create_app_user -> refused',
  $q$SELECT public.create_app_user('u-s2', 'S2', 's2@x', 'ADMIN', NULL, NULL, NULL, NULL, 'ffffffff-0000-4000-8000-0000000000f1')$q$, 'Not authenticated');
SELECT test.expect_error('t15 signup account: open_shift -> refused',
  $q$SELECT public.open_shift('shop-a', 0, NULL, NULL, 'ffffffff-0000-4000-8000-0000000000f2')$q$, 'Not authenticated');
SELECT test.expect_error('t15 signup account: create_product_image_upload_session -> refused',
  $q$SELECT public.create_product_image_upload_session('shop-a', 'prod-1')$q$, 'Not authenticated');
SELECT test.check('t15 signup account: cannot write any product-images object (no org)',
  NOT public.app_storage_can_write_path('org/org-test/products/prod-1/x.webp')
  AND NOT public.app_storage_can_write_path('products/prod-1/x.webp'));
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t15 signup account: no app privilege follows from the auth account (no role, org, user id or permission)',
  :'orph_noperm'::boolean);
SELECT test.check('t15 signup account: reads ZERO rows from every public table/view and storage.objects',
  :'orph_leaks' = '' AND :orph_rels > 30, 'leaks=' || COALESCE(NULLIF(:'orph_leaks', ''), 'none'));
SELECT test.check('t15 signup account: nothing was created (organizations, users unchanged)',
  (SELECT count(*) FROM organizations) = :orgs_before AND (SELECT count(*) FROM users) = :users_before);

-- ============================================================
-- 3. The token-scoped phone RPCs
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-a', 'prod-2') AS ses \gset
SELECT public.attach_product_image_upload_session_token(:'ses'::jsonb->>'sessionId', 'signed-t15') AS zz \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t15 token: 128 hex chars from 4 x gen_random_uuid() (4 x 122 random bits); only its SHA-256 is stored, never the token',
  (:'ses'::jsonb->>'token') ~ '^[0-9a-f]{128}$'
  AND (SELECT token_hash = encode(sha256(convert_to(:'ses'::jsonb->>'token', 'UTF8')), 'hex')
          AND position((:'ses'::jsonb->>'token') in (row_to_json(s)::text)) = 0
         FROM product_image_upload_sessions s WHERE id = :'ses'::jsonb->>'sessionId'));
SELECT token_hash AS ses_hash FROM product_image_upload_sessions WHERE id = :'ses'::jsonb->>'sessionId' \gset
SELECT (SELECT row_to_json(s)::text FROM product_image_upload_sessions s WHERE id = :'ses'::jsonb->>'sessionId') AS ses_row_before \gset

SET ROLE anon;
SELECT test.expect_error('t15 anon: by-token with a random well-formed token -> Invalid upload link',
  format($q$SELECT public.get_product_image_upload_session_by_token(%L)$q$, md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text)),
  'Invalid upload link');
SELECT test.expect_error('t15 anon: by-token with a short token -> Invalid upload link (no lookup)',
  $q$SELECT public.get_product_image_upload_session_by_token('abc')$q$, 'Invalid upload link');
SELECT test.expect_error('t15 anon: by-token with the stored HASH instead of the token -> Invalid upload link',
  format($q$SELECT public.get_product_image_upload_session_by_token(%L)$q$, :'ses_hash'), 'Invalid upload link');
SELECT test.expect_error('t15 anon: by-token with the session id -> Invalid upload link',
  format($q$SELECT public.get_product_image_upload_session_by_token(%L)$q$, :'ses'::jsonb->>'sessionId'), 'Invalid upload link');
SELECT test.expect_error('t15 anon: complete with a random token -> Invalid upload link (from 083: permission denied, service_role only)',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 1000, 'image/webp')$q$,
         md5('x') || md5('y') || md5('z') || md5('w'), :'ses'::jsonb->>'storagePath', :'PUB' || (:'ses'::jsonb->>'storagePath')),
  CASE WHEN test.m083() THEN 'permission denied' ELSE 'Invalid upload link' END);
SELECT public.get_product_image_upload_session_by_token(:'ses'::jsonb->>'token') AS bt \gset
RESET ROLE;
SELECT test.check('t15 anon: failed token guesses changed nothing on the session row',
  (SELECT row_to_json(s)::text FROM product_image_upload_sessions s WHERE id = :'ses'::jsonb->>'sessionId') = :'ses_row_before');
SELECT test.check('t15 anon: a valid by-token response carries only the 8 upload fields - no shop, product, creator, org name or business data',
  (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(:'bt'::jsonb) k)
    = ARRAY['bytes', 'expiresAt', 'mimeType', 'publicUrl', 'sessionId', 'status', 'storagePath', 'uploadToken']
  AND position('shop-a' in :'bt') = 0 AND position('prod-2' in :'bt') = 0 AND position('u-admin' in :'bt') = 0
  AND position('Test Org' in :'bt') = 0 AND position('admin@test.local' in :'bt') = 0,
  'storagePath=' || (:'bt'::jsonb->>'storagePath'));
SELECT 'INFO t15: the storagePath (and so every public image URL) contains the org id: ' || (:'bt'::jsonb->>'storagePath')
       || ' - an opaque id (console: org-<uuid hex>), visible to the token holder; no other org data' AS zz \gset
\echo :zz
