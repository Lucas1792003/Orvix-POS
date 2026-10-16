-- t21 part A: 084 (G5 follow-up) - staff can no longer write product-images
-- objects directly; the validated session flow is the only writer.
-- Gated by run.sh on migrations >= 084; runs after t20 and before the t12
-- bootstrap prep. storage-api is simulated as in t14: a signed-in upload /
-- createSignedUploadUrl = INSERT as `authenticated` (test.can_insert_object,
-- rolled back); the signed upload URL minted by phone-upload-token = INSERT as
-- the storage superuser. The real storage-api / function path is proven by
-- the security-audit stack (suites storage.ts, phone.ts, sweep.ts).
-- At the end this part prepares run.sh's guard cycle (see run.sh).
\set ON_ERROR_STOP on
\set AA  'a0000000-0000-4000-8000-000000000001'
\set MA  'a0000000-0000-4000-8000-000000000002'
\set CA1 'a0000000-0000-4000-8000-000000000003'
\set AX  'a0000000-0000-4000-8000-000000000011'
\set PUB 'https://pos.test/storage/v1/object/public/product-images/'
SELECT test.logout() AS zz \gset

-- ============================================================
-- 1. Catalog state
-- ============================================================
SELECT test.check('t21/084: applied (marker) - storage.objects keeps exactly product_images_read (SELECT) + product_images_delete (DELETE); no INSERT / UPDATE / ALL policy',
  test.m084()
  AND (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')
      = 'product_images_delete:DELETE,product_images_read:SELECT',
  (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'));
SELECT test.check('t21/084: row level security is still enabled on storage.objects (it is what now denies staff writes)',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass));
SELECT test.check('t21/084: the read + delete policies are unchanged (path-first with the 071 uploader fallback, product permission for delete)',
  (SELECT qual LIKE '%app_storage_object_in_my_org(name)%' AND qual LIKE '%app_storage_owner_in_org%' AND roles = '{authenticated}'
     FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'product_images_read')
  AND (SELECT qual LIKE '%app_storage_object_in_my_org(name)%' AND qual LIKE '%app_has_perm%' AND roles = '{authenticated}'
     FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'product_images_delete'));
SELECT test.check('t21/084: app_storage_can_write_path stays for rollback, still not anon-executable; the bucket keeps its 083 limits and stays public',
  to_regprocedure('public.app_storage_can_write_path(text)') IS NOT NULL
  AND NOT has_function_privilege('anon', 'public.app_storage_can_write_path(text)', 'EXECUTE')
  AND (SELECT public AND file_size_limit = 5242880 FROM storage.buckets WHERE id = 'product-images'));

-- ============================================================
-- 2. Every staff write is refused (direct upload, upsert, desktop signing)
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS s1 \gset
SELECT public.create_product_image_upload_session(NULL, 'brand') AS s2 \gset
RESET ROLE;
-- an existing org-test object (written the validated way) for the update / delete probes
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata) VALUES
  ('product-images', 'org/org-test/products/prod-1/t21-existing.webp', :'AA', :'AA', '{"size": 900, "mimetype": "image/webp"}'),
  ('product-images', 'org/org-test/products/prod-1/t21-delete-me.webp', :'AA', :'AA', '{"size": 900, "mimetype": "image/webp"}');

CREATE OR REPLACE FUNCTION test.t21_no_direct_write(p_session_path text, p_logo_session_path text, p_owner uuid, p_org text)
RETURNS boolean LANGUAGE sql AS $$
  SELECT NOT test.can_insert_object('org/' || p_org || '/products/prod-1/t21-new.webp', p_owner)
     AND NOT test.can_insert_object('org/' || p_org || '/products/prod-unsaved-t21/1.webp', p_owner)
     AND NOT test.can_insert_object('org/' || p_org || '/products/brand/t21-logo.webp', p_owner)
     AND NOT test.can_insert_object(p_session_path, p_owner)
     AND NOT test.can_insert_object(p_logo_session_path, p_owner)
     AND NOT test.can_insert_object('products/prod-1/t21-legacy.webp', p_owner)
     AND NOT test.can_insert_object('temp/pimg-t21legacy', p_owner)
$$;

SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t21/084: org ADMIN cannot write ANY path directly - product, new product, logo, its own live session path (product + logo), legacy layouts',
  test.t21_no_direct_write(:'s1'::jsonb->>'storagePath', :'s2'::jsonb->>'storagePath', :'AA', 'org-test'));
SELECT test.check('t21/084: org ADMIN cannot overwrite / upsert or rename its own org''s object (no UPDATE policy: 0 rows)',
  test.affected($q$UPDATE storage.objects SET metadata = '{"size": 1, "mimetype": "image/jpeg"}' WHERE name = 'org/org-test/products/prod-1/t21-existing.webp'$q$) = 0
  AND test.affected($q$UPDATE storage.objects SET name = 'org/org-test/products/prod-1/t21-renamed.webp' WHERE name = 'org/org-test/products/prod-1/t21-existing.webp'$q$) = 0);
SELECT test.check('t21/084: org ADMIN still lists its own org''s objects and may still DELETE them (cleanup keeps working)',
  (SELECT count(*) FROM storage.objects WHERE name = 'org/org-test/products/prod-1/t21-existing.webp') = 1
  AND test.affected($q$DELETE FROM storage.objects WHERE name = 'org/org-test/products/prod-1/t21-delete-me.webp'$q$) = 1);
RESET ROLE;
SELECT test.login(:'MA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t21/084: a MANAGER (product permission) cannot write any path directly either',
  test.t21_no_direct_write(:'s1'::jsonb->>'storagePath', :'s2'::jsonb->>'storagePath', :'MA', 'org-test'));
RESET ROLE;
SELECT test.login(:'CA1') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t21/084: a CASHIER cannot write any path (unchanged)',
  test.t21_no_direct_write(:'s1'::jsonb->>'storagePath', :'s2'::jsonb->>'storagePath', :'CA1', 'org-test'));
RESET ROLE;
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t21/084: org-two ADMIN cannot write its own paths nor org-test''s session path; cannot touch org-test''s object',
  test.t21_no_direct_write(:'s1'::jsonb->>'storagePath', :'s2'::jsonb->>'storagePath', :'AX', 'org-two')
  AND test.affected($q$UPDATE storage.objects SET metadata = '{}' WHERE name = 'org/org-test/products/prod-1/t21-existing.webp'$q$) = 0
  AND test.affected($q$DELETE FROM storage.objects WHERE name = 'org/org-test/products/prod-1/t21-existing.webp'$q$) = 0);
RESET ROLE;
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.check('t21/084: anon cannot write any path',
  test.t21_no_direct_write(:'s1'::jsonb->>'storagePath', :'s2'::jsonb->>'storagePath', NULL, 'org-test'));
RESET ROLE;
SELECT test.check('t21/084: the object refused to everyone is unchanged (metadata and name)',
  (SELECT metadata->>'size' = '900' FROM storage.objects WHERE name = 'org/org-test/products/prod-1/t21-existing.webp'));

-- ============================================================
-- 3. The validated flow still works end to end (desktop as its own "phone")
-- ============================================================
-- the signed upload URL minted by phone-upload-token (service role) -> storage superuser write
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
VALUES ('product-images', :'s1'::jsonb->>'storagePath', NULL, NULL, '{"size": 4321, "mimetype": "image/webp"}'),
       ('product-images', :'s2'::jsonb->>'storagePath', NULL, NULL, '{"size": 1234, "mimetype": "image/jpeg"}');
-- the function's completion (after its byte check) as service_role
SET ROLE service_role;
SELECT public.complete_product_image_upload_session(:'s1'::jsonb->>'token', :'s1'::jsonb->>'storagePath',
  'https://client.example/storage/v1/object/public/product-images/' || (:'s1'::jsonb->>'storagePath'), 4321, 'image/webp') AS c1 \gset
SELECT public.complete_product_image_upload_session(:'s2'::jsonb->>'token', :'s2'::jsonb->>'storagePath',
  'https://client.example/storage/v1/object/public/product-images/' || (:'s2'::jsonb->>'storagePath'), 1234, 'image/jpeg') AS c2 \gset
RESET ROLE;
SELECT test.check('t21/084 flow: desktop sessions (product + logo) complete through the service role with the SERVER-derived URL (client host ignored)',
  :'c1'::jsonb->>'status' = 'COMPLETED' AND :'c1'::jsonb->>'publicUrl' = :'PUB' || (:'s1'::jsonb->>'storagePath')
  AND :'c2'::jsonb->>'status' = 'COMPLETED' AND :'c2'::jsonb->>'publicUrl' = :'PUB' || (:'s2'::jsonb->>'storagePath')
  AND (:'s1'::jsonb->>'storagePath') LIKE 'org/org-test/temp/pimg-%' AND (:'s2'::jsonb->>'storagePath') LIKE 'org/org-test/temp/pimg-%');
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t21/084 flow: the desktop saves the trusted URL on the product and the logo (table RLS unchanged), and lists both objects',
  test.affected(format($q$UPDATE products SET image_url = %L WHERE id = 'prod-1'$q$, :'c1'::jsonb->>'publicUrl')) = 1
  AND test.affected(format($q$UPDATE business_profile SET logo_url = %L WHERE id = 'default'$q$, :'c2'::jsonb->>'publicUrl')) = 1
  AND (SELECT count(*) FROM storage.objects WHERE name IN (:'s1'::jsonb->>'storagePath', :'s2'::jsonb->>'storagePath')) = 2);
SELECT test.check('t21/084 flow: the completed object cannot be overwritten by its creator either',
  test.affected(format($q$UPDATE storage.objects SET metadata = '{}' WHERE name = %L$q$, :'s1'::jsonb->>'storagePath')) = 0
  AND NOT test.can_insert_object(:'s1'::jsonb->>'storagePath', :'AA'));
RESET ROLE;
SELECT test.logout() AS zz \gset

-- ============================================================
-- 4. Prepare run.sh's guard cycle: the database as it is BEFORE 084 (run.sh
--    re-applies 078 next), plus two recent direct-upload-shaped objects:
--    one with an uploader (an old client) and one without (a migrated object).
-- ============================================================
-- the owner'd direct-upload-shaped objects earlier tests created (t09, t14,
-- section 2 above) stand for uploads made long before 084: 30 days old
UPDATE storage.objects SET created_at = now() - interval '30 days'
 WHERE bucket_id = 'product-images' AND name ~ '^(org/[^/]+/)?products/[^/]+/[^/]+$';
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, created_at) VALUES
  ('product-images', 'org/org-test/products/prod-1/t21-recent-direct.webp', :'AA', :'AA', '{"size": 700, "mimetype": "image/webp"}', now() - interval '2 days'),
  ('product-images', 'products/prod-1/t21-recent-migrated.webp', NULL, NULL, '{"size": 700, "mimetype": "image/webp"}', now() - interval '3 days'),
  ('product-images', 'org/org-test/products/prod-1/t21-old-direct.webp', :'AA', :'AA', '{"size": 700, "mimetype": "image/webp"}', now() - interval '30 days');
SELECT test.setvar('t21_objects_a', (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o));
