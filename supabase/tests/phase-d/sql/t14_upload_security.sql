-- t14: product-images upload security (078 storage policies, 079 sessions).
-- storage-api is simulated the way it talks to Postgres:
--   * a signed-in upload / createSignedUploadUrl = INSERT into storage.objects
--     as `authenticated` with owner = owner_id = the caller (uploader.canUpload
--     runs that INSERT and rolls it back: test.can_insert_object below);
--   * the phone's uploadToSignedUrl = INSERT as the storage superuser
--     (RLS bypassed) with owner = the desktop user named in the token;
--   * public URL reads of the public bucket = superuser reads (no RLS).
-- Legacy objects are synthetic copies of the 574 migrated ones: owner NULL,
-- temp/<sessionId> referenced by products.image_url, products/<id>/<ts>.
-- Gated by run.sh on migrations >= 079. Runs after t09-t13 (org-test + org-two).
\set ON_ERROR_STOP on
\set AA  'a0000000-0000-4000-8000-000000000001'
\set MA  'a0000000-0000-4000-8000-000000000002'
\set CA1 'a0000000-0000-4000-8000-000000000003'
\set AX  'a0000000-0000-4000-8000-000000000011'
\set MX  'a0000000-0000-4000-8000-000000000012'
\set PUB 'https://pos.test/storage/v1/object/public/product-images/'
SELECT test.logout() AS zz \gset
-- 083: completion is service_role-only (phone -> phone-upload-token function)
SELECT test.completer() AS completer \gset

-- INSERT probe with rollback, as the CURRENT role (what canUpload does)
CREATE OR REPLACE FUNCTION test.can_insert_object(p_name text, p_owner uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner, owner_id)
    VALUES ('product-images', p_name, p_owner, p_owner::text);
    RAISE EXCEPTION USING ERRCODE = 'P0T14', MESSAGE = 'probe ok (rolled back)';
  EXCEPTION
    WHEN SQLSTATE 'P0T14' THEN RETURN true;
    WHEN insufficient_privilege THEN RETURN false;   -- new row violates row-level security policy
  END;
END $$;
-- a real (committed) signed-in upload as the current role
CREATE OR REPLACE FUNCTION test.upload_object(p_name text, p_owner uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO storage.objects (bucket_id, name, owner, owner_id)
  VALUES ('product-images', p_name, p_owner, p_owner::text);
  RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;

-- ============================================================
-- 0. Synthetic legacy objects (574-style: owner NULL, no org in the path)
-- ============================================================
INSERT INTO product_image_upload_sessions (id, token_hash, created_by, shop_id, product_id, storage_path, public_url, bytes, mime_type, status, expires_at, completed_at)
VALUES
  ('pimg-legacya1', md5('t14-legacy-a1'), 'u-admin',   'shop-a', 'prod-3',  'temp/pimg-legacya1', :'PUB' || 'temp/pimg-legacya1', 5000, 'image/webp', 'COMPLETED', now() - interval '30 days', now() - interval '30 days'),
  ('pimg-legacyx1', md5('t14-legacy-x1'), 'u-admin-x', 'shop-x', 'prod-x2', 'temp/pimg-legacyx1', :'PUB' || 'temp/pimg-legacyx1', 5000, 'image/webp', 'COMPLETED', now() - interval '30 days', now() - interval '30 days');
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('product-images', 'temp/pimg-legacya1', NULL, NULL),
  ('product-images', 'temp/pimg-legacyx1', NULL, NULL),
  ('product-images', 'products/prod-1/1700000000000.webp', NULL, NULL),
  ('product-images', 'products/brand/1700000000001.webp', NULL, NULL),
  ('product-images', 'products/prod-ghost/1700000000002.webp', NULL, NULL);
UPDATE products SET image_url = :'PUB' || 'temp/pimg-legacya1' WHERE id = 'prod-3';
UPDATE products SET image_url = :'PUB' || 'temp/pimg-legacyx1' WHERE id = 'prod-x2';
UPDATE business_profile SET logo_url = :'PUB' || 'products/brand/1700000000001.webp' WHERE org_id = 'org-test';
SELECT string_agg(name || '=' || COALESCE(public.app_storage_object_org(name), 'NULL'), ' ' ORDER BY name) AS legacy_map
  FROM storage.objects WHERE owner IS NULL \gset
SELECT test.check('t14/078: legacy paths resolve to their org through server-side facts (session row, product id, own logo); unknown -> NULL',
  public.app_storage_object_org('temp/pimg-legacya1') = 'org-test'
  AND public.app_storage_object_org('temp/pimg-legacyx1') = 'org-two'
  AND public.app_storage_object_org('products/prod-1/1700000000000.webp') = 'org-test'
  AND public.app_storage_object_org('products/brand/1700000000001.webp') = 'org-test'
  AND public.app_storage_object_org('products/prod-ghost/1700000000002.webp') IS NULL
  AND public.app_storage_object_org('org/org-two/products/prod-x1/1.webp') = 'org-two'
  AND public.app_storage_object_org('temp/pimg-nosuchsession') IS NULL
  AND public.app_storage_object_org('') IS NULL AND public.app_storage_object_org('org//x') IS NULL,
  :'legacy_map');

SELECT CASE WHEN test.m084() THEN
  test.check('t14/084: policies - 2 (read, delete), all TO authenticated, path-first with the 071 uploader fallback; no INSERT / UPDATE policy',
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects') = 2
    AND (SELECT bool_and(roles = '{authenticated}') FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')
    AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd IN ('INSERT', 'UPDATE', 'ALL'))
    AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
          AND qual LIKE '%app_storage_object_in_my_org(name)%' AND qual LIKE '%app_storage_owner_in_org%') = 2)
ELSE test.check('t14/078: policies - 4, all TO authenticated; INSERT path-scoped; read/update/delete path-first with the 071 uploader fallback',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects') = 4
  AND (SELECT bool_and(roles = '{authenticated}') FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')
  AND (SELECT with_check LIKE '%app_storage_can_write_path(name)%' FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'product_images_insert')
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
        AND qual LIKE '%app_storage_object_in_my_org(name)%' AND qual LIKE '%app_storage_owner_in_org%') = 3
  AND (SELECT with_check LIKE '%app_storage_object_in_my_org(name)%' FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'product_images_update')) END;
SELECT test.check('t14/078: helper grants - path->org resolver is service_role only; the boolean helpers are not anon',
  NOT has_function_privilege('authenticated', 'public.app_storage_object_org(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.app_storage_object_org(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.app_storage_object_in_my_org(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.app_storage_can_write_path(text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.app_storage_can_write_path(text)', 'EXECUTE'));

-- ============================================================
-- 1. Legacy (owner NULL) objects: managed by their org's admin only
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078 legacy: org-test ADMIN lists its own owner-less legacy objects (temp session, product folder, logo)',
  (SELECT count(*) FROM storage.objects WHERE name IN ('temp/pimg-legacya1', 'products/prod-1/1700000000000.webp', 'products/brand/1700000000001.webp')) = 3);
SELECT test.check('t14/078 legacy: org-test ADMIN does not see org-two''s legacy object nor the unresolvable orphan',
  (SELECT count(*) FROM storage.objects WHERE name IN ('temp/pimg-legacyx1', 'products/prod-ghost/1700000000002.webp')) = 0);
SELECT test.check('t14/078 legacy: org-test ADMIN can update (replace metadata of) its legacy objects (084: no staff UPDATE at all -> 0); org-two''s: 0 rows',
  test.affected($q$UPDATE storage.objects SET metadata = '{"t14":"a"}' WHERE name IN ('temp/pimg-legacya1', 'products/prod-1/1700000000000.webp', 'products/brand/1700000000001.webp')$q$) = CASE WHEN test.m084() THEN 0 ELSE 3 END
  AND test.affected($q$UPDATE storage.objects SET metadata = '{"pwned":true}' WHERE name = 'temp/pimg-legacyx1'$q$) = 0);
SELECT test.check('t14/078 legacy: org-test ADMIN cannot delete org-two''s legacy object',
  test.affected($q$DELETE FROM storage.objects WHERE name = 'temp/pimg-legacyx1'$q$) = 0);
SELECT test.check('t14/078 legacy: org-test ADMIN can delete its own unreferenced legacy object',
  test.affected($q$DELETE FROM storage.objects WHERE name = 'products/prod-1/1700000000000.webp'$q$) = 1);
RESET ROLE;
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078 legacy: org-two ADMIN sees and manages its own legacy object, none of org-test''s',
  (SELECT count(*) FROM storage.objects WHERE name = 'temp/pimg-legacyx1') = 1
  AND (SELECT count(*) FROM storage.objects WHERE name IN ('temp/pimg-legacya1', 'products/brand/1700000000001.webp')) = 0
  AND test.affected($q$UPDATE storage.objects SET metadata = '{"t14":"x"}' WHERE name = 'temp/pimg-legacyx1'$q$) = CASE WHEN test.m084() THEN 0 ELSE 1 END
  AND test.affected($q$DELETE FROM storage.objects WHERE name IN ('temp/pimg-legacya1', 'products/brand/1700000000001.webp')$q$) = 0);
RESET ROLE;
SELECT test.login(:'CA1') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078 legacy: an org-test CASHIER (no product permission) can list but not change or delete them',
  (SELECT count(*) FROM storage.objects WHERE name = 'temp/pimg-legacya1') = 1
  AND test.affected($q$UPDATE storage.objects SET metadata = '{}' WHERE name = 'temp/pimg-legacya1'$q$) = 0
  AND test.affected($q$DELETE FROM storage.objects WHERE name = 'temp/pimg-legacya1'$q$) = 0);
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t14/078 legacy: nothing was moved or renamed - the bucket is still public and every products.image_url / logo_url still names an existing object',
  (SELECT public FROM storage.buckets WHERE id = 'product-images')
  AND (SELECT count(*) FROM storage.objects WHERE name IN ('temp/pimg-legacya1', 'temp/pimg-legacyx1', 'products/brand/1700000000001.webp')) = 3
  AND NOT EXISTS (
    SELECT 1 FROM (SELECT image_url AS u FROM products WHERE image_url LIKE '%/product-images/%'
                   UNION ALL SELECT logo_url FROM business_profile WHERE logo_url LIKE '%/product-images/%') r
     WHERE NOT EXISTS (SELECT 1 FROM storage.objects o
                        WHERE o.bucket_id = 'product-images'
                          AND r.u = :'PUB' || o.name)));

-- ============================================================
-- 2. Cross-org writes (signed-in uploads), both path layouts
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078: org-test ADMIN cannot create objects under org-two''s prefix',
  NOT test.can_insert_object('org/org-two/products/prod-x1/1.webp', :'AA')
  AND NOT test.can_insert_object('org/org-two/products/prod-new/1.webp', :'AA')
  AND NOT test.can_insert_object('org/org-two/temp/pimg-legacyx1', :'AA'));
SELECT test.check('t14/078: org-test ADMIN cannot create objects in org-two''s PRODUCT folder (own prefix or legacy layout)',
  NOT test.can_insert_object('org/org-test/products/prod-x1/2.webp', :'AA')
  AND NOT test.can_insert_object('products/prod-x1/2.webp', :'AA'));
SELECT test.check('t14/078: org-test ADMIN cannot create objects at org-two''s legacy session path',
  NOT test.can_insert_object('temp/pimg-legacyx1', :'AA'));
SELECT test.check('t14/078: malformed / unknown paths are refused (no prefix escape)',
  NOT test.can_insert_object('org/org-test/products/prod-1', :'AA')
  AND NOT test.can_insert_object('org/org-test/other/x.webp', :'AA')
  AND NOT test.can_insert_object('org/org-test/products/../x.webp', :'AA')
  AND NOT test.can_insert_object('org/org-test//products/prod-1/x.webp', :'AA')
  AND NOT test.can_insert_object('org/org-test/temp/pimg-nosuchsession', :'AA')
  AND NOT test.can_insert_object('random/x.webp', :'AA')
  AND NOT test.can_insert_object('x.webp', :'AA'));
SELECT CASE WHEN test.m084() THEN
  test.check('t14/084: own-org DIRECT uploads are refused too - existing product, new product id, logo, legacy layout (only signed upload URLs write)',
    NOT test.upload_object('org/org-test/products/prod-1/1800000000000.webp', :'AA')
    AND NOT test.upload_object('org/org-test/products/prod-unsaved-1/1800000000001.webp', :'AA')
    AND NOT test.upload_object('org/org-test/products/brand/1800000000002.webp', :'AA')
    AND NOT test.can_insert_object('products/prod-1/1800000000003.webp', :'AA')
    AND NOT test.can_insert_object('products/prod-unsaved-2/1800000000004.webp', :'AA'))
ELSE test.check('t14/078: own-org uploads work - existing product, new (unsaved) product id, logo, and the legacy layout for old clients',
  test.upload_object('org/org-test/products/prod-1/1800000000000.webp', :'AA')
  AND test.upload_object('org/org-test/products/prod-unsaved-1/1800000000001.webp', :'AA')
  AND test.upload_object('org/org-test/products/brand/1800000000002.webp', :'AA')
  AND test.can_insert_object('products/prod-1/1800000000003.webp', :'AA')
  AND test.can_insert_object('products/prod-unsaved-2/1800000000004.webp', :'AA')) END;
RESET ROLE;
SELECT test.login(:'CA1') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078: a CASHIER cannot upload even under its own org prefix (permission unchanged since 016)',
  NOT test.can_insert_object('org/org-test/products/prod-1/1800000000009.webp', :'CA1'));
RESET ROLE;
-- 084: staff cannot write at all; the org-two object the move tests need is
-- created the way storage-api writes a signed upload (superuser)
INSERT INTO storage.objects (bucket_id, name, owner, owner_id)
SELECT 'product-images', 'org/org-two/products/prod-x1/1800000000005.webp', :'AX', :'AX' WHERE test.m084();
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078: org-two ADMIN cannot see, overwrite or delete org-test''s org/ objects',
  (SELECT count(*) FROM storage.objects WHERE name LIKE 'org/org-test/%') = 0
  AND test.affected($q$UPDATE storage.objects SET metadata = '{"pwned":true}' WHERE name LIKE 'org/org-test/%'$q$) = 0
  AND test.affected($q$DELETE FROM storage.objects WHERE name LIKE 'org/org-test/%'$q$) = 0);
SELECT CASE WHEN test.m084() THEN NOT test.upload_object('org/org-two/products/prod-x1/1800000000006.webp', :'AX')
            ELSE test.upload_object('org/org-two/products/prod-x1/1800000000005.webp', :'AX') END AS ax_up \gset
-- 078: the move is refused by UPDATE's WITH CHECK (error); 084: there is no
-- UPDATE policy, so the UPDATE matches no row at all
SELECT CASE WHEN test.m084() THEN
  test.check('t14/084: org-two ADMIN cannot MOVE its object into org-test''s prefix (no UPDATE policy: 0 rows)',
    test.affected($q$UPDATE storage.objects SET name = 'org/org-test/products/prod-1/stolen.webp' WHERE name = 'org/org-two/products/prod-x1/1800000000005.webp'$q$) = 0)
ELSE test.expect_error('t14/078: org-two ADMIN cannot MOVE its object into org-test''s prefix (UPDATE ... SET name, WITH CHECK)',
  $q$UPDATE storage.objects SET name = 'org/org-test/products/prod-1/stolen.webp' WHERE name = 'org/org-two/products/prod-x1/1800000000005.webp'$q$,
  'row-level security') END;
SELECT CASE WHEN test.m084() THEN
  test.check('t14/084: ... nor into org-test''s legacy product folder (0 rows)',
    test.affected($q$UPDATE storage.objects SET name = 'products/prod-1/stolen.webp' WHERE name = 'org/org-two/products/prod-x1/1800000000005.webp'$q$) = 0)
ELSE test.expect_error('t14/078: ... nor into org-test''s legacy product folder',
  $q$UPDATE storage.objects SET name = 'products/prod-1/stolen.webp' WHERE name = 'org/org-two/products/prod-x1/1800000000005.webp'$q$,
  'row-level security') END;
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t14/078: org-two''s own upload landed (control; 084: its direct upload is refused, the object exists via the signed-upload path)', :'ax_up'::boolean
  AND (SELECT count(*) FROM storage.objects WHERE name = 'org/org-two/products/prod-x1/1800000000005.webp') = 1);
SET ROLE anon;
SELECT test.check('t14/078: anon lists 0 objects and cannot insert any',
  (SELECT count(*) FROM storage.objects) = 0
  AND NOT test.can_insert_object('org/org-test/products/prod-1/anon.webp', NULL));
RESET ROLE;

-- ============================================================
-- 3. Phone-upload sessions (079): org-scoped path, token lifecycle
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS ok1 \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS exp1 \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS can1 \gset
RESET ROLE;
SELECT test.check('t14/079: the server mints org/<org>/temp/<sessionId>; the returned storagePath equals the stored storage_path',
  (SELECT bool_and(s.storage_path = 'org/org-test/temp/' || s.id AND s.storage_path = r.p)
     FROM (VALUES (:'ok1'::jsonb->>'sessionId', :'ok1'::jsonb->>'storagePath'),
                  (:'exp1'::jsonb->>'sessionId', :'exp1'::jsonb->>'storagePath'),
                  (:'can1'::jsonb->>'sessionId', :'can1'::jsonb->>'storagePath')) r(id, p)
     JOIN product_image_upload_sessions s ON s.id = r.id));

-- signing (createSignedUploadUrl) is an INSERT RLS check as the desktop user
SET ROLE authenticated;
SELECT CASE WHEN test.m084() THEN
  test.check('t14/084: not even the creating desktop user may write its live session path directly (only phone-upload-token signs it, as service_role)',
    NOT test.can_insert_object(:'ok1'::jsonb->>'storagePath', :'AA'))
ELSE test.check('t14/078+079: the creating desktop user may sign its live session path',
  test.can_insert_object(:'ok1'::jsonb->>'storagePath', :'AA')) END;
RESET ROLE;
SELECT test.login(:'MA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078: another user of the same org cannot sign someone else''s session path',
  NOT test.can_insert_object(:'ok1'::jsonb->>'storagePath', :'MA'));
RESET ROLE;
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078: an org-two ADMIN cannot sign org-test''s session path',
  NOT test.can_insert_object(:'ok1'::jsonb->>'storagePath', :'AX'));
RESET ROLE;

-- active session end to end: attach -> phone reads -> phone uploads -> completes -> desktop sees it
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.attach_product_image_upload_session_token(:'ok1'::jsonb->>'sessionId', 'signed-t14-ok1') AS att1 \gset
SELECT public.attach_product_image_upload_session_token(:'can1'::jsonb->>'sessionId', 'signed-t14-can1') AS zz \gset
SELECT public.attach_product_image_upload_session_token(:'exp1'::jsonb->>'sessionId', 'signed-t14-exp1') AS zz \gset
SELECT public.cancel_product_image_upload_session(:'can1'::jsonb->>'sessionId') AS zz \gset
RESET ROLE;
UPDATE product_image_upload_sessions SET expires_at = now() - interval '1 minute' WHERE id = :'exp1'::jsonb->>'sessionId';
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT public.get_product_image_upload_session_by_token(:'ok1'::jsonb->>'token') AS bt1 \gset
RESET ROLE;
-- the phone's uploadToSignedUrl: storage superuser, owner = the desktop user from the token
INSERT INTO storage.objects (bucket_id, name, owner, owner_id)
VALUES ('product-images', :'bt1'::jsonb->>'storagePath', :'AA', :'AA');
SET ROLE :completer;
SELECT test.expect_error('t14/079: completion with a URL of another host / object is rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 4000, 'image/webp')$q$,
         :'ok1'::jsonb->>'token', :'bt1'::jsonb->>'storagePath',
         'https://evil.example/storage/v1/object/public/product-images/org/org-two/products/prod-x1/1.webp'),
  'does not match this upload session');
SELECT public.complete_product_image_upload_session(:'ok1'::jsonb->>'token', :'bt1'::jsonb->>'storagePath',
  :'PUB' || (:'bt1'::jsonb->>'storagePath'), 4000, 'image/webp') AS done1 \gset
RESET ROLE;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.get_product_image_upload_session_status(:'ok1'::jsonb->>'sessionId') AS st1 \gset
SELECT test.check('t14/079: active session end to end - attach, by-token (upload token + same path), upload, complete, desktop poll',
  :'att1'::jsonb->>'status' = 'PENDING'
  AND :'bt1'::jsonb->>'status' = 'PENDING' AND :'bt1'::jsonb->>'uploadToken' = 'signed-t14-ok1'
  AND :'bt1'::jsonb->>'storagePath' = :'ok1'::jsonb->>'storagePath'
  AND :'done1'::jsonb->>'status' = 'COMPLETED'
  AND :'st1'::jsonb->>'status' = 'COMPLETED' AND :'st1'::jsonb->>'publicUrl' = :'PUB' || (:'ok1'::jsonb->>'storagePath'));
SELECT test.check('t14/078: the phone-uploaded object is listable and manageable by its org (path org/org-test/temp/...)',
  (SELECT count(*) FROM storage.objects WHERE name = :'ok1'::jsonb->>'storagePath') = 1
  AND test.affected(format($q$UPDATE storage.objects SET metadata = '{"t14":"ok"}' WHERE name = %L$q$, :'ok1'::jsonb->>'storagePath')) = CASE WHEN test.m084() THEN 0 ELSE 1 END);
SELECT test.check('t14/078: a COMPLETED session''s path can no longer be signed (no second token)',
  NOT test.can_insert_object(:'ok1'::jsonb->>'storagePath', :'AA'));
RESET ROLE;
SELECT test.check('t14/079: storage path, session.storage_path, object name and public_url agree',
  (SELECT s.storage_path = o.name AND s.public_url = :'PUB' || s.storage_path AND s.status = 'COMPLETED'
     FROM product_image_upload_sessions s JOIN storage.objects o ON o.name = s.storage_path
    WHERE s.id = :'ok1'::jsonb->>'sessionId'));

-- expired / cancelled: no new upload token, no completion
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t14/079(d): attach on an EXPIRED session is refused with the common message',
  format($q$SELECT public.attach_product_image_upload_session_token(%L, 'signed-again')$q$, :'exp1'::jsonb->>'sessionId'),
  'Upload link is no longer active');
SELECT test.expect_error('t14/079(d): attach on a CANCELED session is refused with the common message',
  format($q$SELECT public.attach_product_image_upload_session_token(%L, 'signed-again')$q$, :'can1'::jsonb->>'sessionId'),
  'Upload link is no longer active');
SELECT test.check('t14/078: an expired or cancelled session''s path cannot be signed (no new storage upload token)',
  NOT test.can_insert_object(:'exp1'::jsonb->>'storagePath', :'AA')
  AND NOT test.can_insert_object(:'can1'::jsonb->>'storagePath', :'AA'));
RESET ROLE;
SELECT test.check('t14/079(d): the refused attach wrote nothing (old token kept, row derivably expired, no rolled-back UPDATE left in the body)',
  (SELECT status = 'PENDING' AND signed_upload_token = 'signed-t14-exp1' AND expires_at <= now()
     FROM product_image_upload_sessions WHERE id = :'exp1'::jsonb->>'sessionId')
  AND (SELECT prosrc LIKE '%079%' AND prosrc NOT LIKE '%THEN ''EXPIRED'' ELSE status END%'
         FROM pg_proc WHERE proname = 'attach_product_image_upload_session_token'));
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT public.get_product_image_upload_session_by_token(:'exp1'::jsonb->>'token') AS btx \gset
SELECT public.get_product_image_upload_session_by_token(:'can1'::jsonb->>'token') AS btc \gset
RESET ROLE;
SELECT test.check('t14/079: by-token hands out no upload token for an expired or cancelled session (and persists EXPIRED)',
  :'btx'::jsonb->>'status' = 'EXPIRED' AND (:'btx'::jsonb->'uploadToken') = 'null'::jsonb
  AND :'btc'::jsonb->>'status' = 'CANCELED' AND (:'btc'::jsonb->'uploadToken') = 'null'::jsonb
  AND (SELECT status = 'EXPIRED' AND signed_upload_token IS NULL FROM product_image_upload_sessions WHERE id = :'exp1'::jsonb->>'sessionId'));
-- an already-issued storage token outlives the session: the phone CAN still
-- write the object (stateless JWT) - but the session never completes
INSERT INTO storage.objects (bucket_id, name, owner, owner_id)
VALUES ('product-images', :'exp1'::jsonb->>'storagePath', :'AA', :'AA');
SET ROLE :completer;
SELECT test.expect_error('t14/079: completion after expiry is refused even though the object was written',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 4000, 'image/webp')$q$,
         :'exp1'::jsonb->>'token', :'exp1'::jsonb->>'storagePath', :'PUB' || (:'exp1'::jsonb->>'storagePath')),
  'Upload link is no longer active');
SELECT test.expect_error('t14/079: completion of a cancelled session is refused',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 4000, 'image/webp')$q$,
         :'can1'::jsonb->>'token', :'can1'::jsonb->>'storagePath', :'PUB' || (:'can1'::jsonb->>'storagePath')),
  'Upload link is no longer active');
RESET ROLE;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078: the late orphan object belongs to the org (path) - its ADMIN can see and delete it; no product points at it',
  (SELECT count(*) FROM storage.objects WHERE name = :'exp1'::jsonb->>'storagePath') = 1
  AND test.affected(format($q$DELETE FROM storage.objects WHERE name = %L$q$, :'exp1'::jsonb->>'storagePath')) = 1);
RESET ROLE;
SELECT test.check('t14/079: expired / cancelled sessions never reached COMPLETED and carry no public_url',
  (SELECT bool_and(status <> 'COMPLETED' AND public_url IS NULL) FROM product_image_upload_sessions
    WHERE id IN (:'exp1'::jsonb->>'sessionId', :'can1'::jsonb->>'sessionId')));

-- legacy (pre-079) PENDING session with an unprefixed temp/ path: still signable by its creator only
INSERT INTO product_image_upload_sessions (id, token_hash, created_by, shop_id, product_id, storage_path, status, expires_at)
VALUES ('pimg-legacypend', md5('t14-legacy-pend'), 'u-admin', 'shop-a', 'prod-1', 'temp/pimg-legacypend', 'PENDING', now() + interval '5 minutes');
SET ROLE authenticated;
SELECT CASE WHEN test.m084() THEN
  test.check('t14/084 compat: a session created before 079 (temp/<id>) can no longer be signed by the desktop user (old builds: update before 084)',
    NOT test.can_insert_object('temp/pimg-legacypend', :'AA'))
ELSE test.check('t14/078 compat: a session created before 079 (temp/<id>) can still be signed by its creator',
  test.can_insert_object('temp/pimg-legacypend', :'AA')) END;
RESET ROLE;
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t14/078 compat: ... but not by another org',
  NOT test.can_insert_object('temp/pimg-legacypend', :'AX'));
RESET ROLE;
SELECT test.logout() AS zz \gset
