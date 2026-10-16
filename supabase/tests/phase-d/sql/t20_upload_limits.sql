-- t20 part A: 083 (G5) - product-images upload limits + service_role-only
-- completion. Gated by run.sh on migrations >= 083; runs after t19 (org-test,
-- org-two, t16's completed sessions and products.image_url exist) and before
-- the t12 bootstrap prep (which empties users).
--
-- Byte-level checks (magic number, markup, delete on refusal) live in the
-- phone-upload-token Edge Function: Deno tests + the security-audit stack
-- (real storage-api). This harness has no storage-api: it asserts the bucket
-- configuration, the grants, the RPC behaviour for the function's role, and
-- the migration's guard (run.sh re-applies 083 between parts A, B and C).
\set ON_ERROR_STOP on
\set AA  'a0000000-0000-4000-8000-000000000001'
\set TRUSTED 'https://pos.test/storage/v1/object/public/product-images/'
SELECT test.logout() AS zz \gset

-- ============================================================
-- 1. Bucket settings
-- ============================================================
SELECT test.check('t20/083: product-images allows exactly image/jpeg, image/png, image/webp',
  (SELECT allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'] FROM storage.buckets WHERE id = 'product-images'),
  (SELECT allowed_mime_types::text FROM storage.buckets WHERE id = 'product-images'));
SELECT test.check('t20/083: product-images file_size_limit = 5242880 bytes (5 MiB)',
  (SELECT file_size_limit = 5242880 FROM storage.buckets WHERE id = 'product-images'),
  (SELECT file_size_limit::text FROM storage.buckets WHERE id = 'product-images'));
SELECT test.check('t20/083: product-images is still public (public object URLs keep working)',
  (SELECT public FROM storage.buckets WHERE id = 'product-images'));
SELECT test.check('t20/083: other buckets are untouched (t16-other keeps NULL limits)',
  NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id <> 'product-images'
                AND (file_size_limit IS NOT NULL OR allowed_mime_types IS NOT NULL)));

-- ============================================================
-- 2. Grants: completion is service_role-only
-- ============================================================
SELECT test.check('t20/083: complete_product_image_upload_session - no EXECUTE for anon / authenticated / PUBLIC, service_role keeps it',
  NOT has_function_privilege('anon', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                   WHERE p.oid = 'public.complete_product_image_upload_session(text,text,text,integer,text)'::regprocedure
                     AND a.grantee = 0)
  AND has_function_privilege('service_role', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE'));
SELECT test.check('t20/083: the RPC itself is unchanged (080 body, SECURITY DEFINER, owner postgres) and carries the 083 marker comment',
  (SELECT prosecdef AND prosrc LIKE '%080%' AND pg_get_userbyid(proowner) = 'postgres'
     FROM pg_proc WHERE oid = 'public.complete_product_image_upload_session(text,text,text,integer,text)'::regprocedure)
  AND test.m083());
SELECT test.check('t20/083: the phone''s other RPC (by_token) is still anon-executable; the desktop poll is still authenticated-only',
  has_function_privilege('anon', 'public.get_product_image_upload_session_by_token(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.get_product_image_upload_session_status(text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.get_product_image_upload_session_status(text)', 'EXECUTE'));

-- ============================================================
-- 3. Behaviour: anon / authenticated refused; service_role (the function) completes
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-a', 'prod-2') AS g1 \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-2') AS g2 \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT :'g1'::jsonb->>'storagePath' AS p_g1, :'g1'::jsonb->>'token' AS t_g1,
       :'g2'::jsonb->>'storagePath' AS p_g2, :'g2'::jsonb->>'token' AS t_g2 \gset
-- the phone's upload (storage-api; RLS bypassed): g1 a JPEG, g2 declared text/html
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata) VALUES
  ('product-images', :'p_g1', :'AA', :'AA', '{"size": 4321, "mimetype": "image/jpeg"}'),
  ('product-images', :'p_g2', :'AA', :'AA', '{"size": 300, "mimetype": "text/html"}');
SELECT (SELECT row_to_json(s)::text FROM product_image_upload_sessions s WHERE id = :'g1'::jsonb->>'sessionId') AS g1_before \gset

SET ROLE anon;
SELECT test.expect_error('t20/083: anon (an old phone page calling the RPC directly) -> permission denied',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 4321, 'image/jpeg')$q$,
         :'t_g1', :'p_g1', :'TRUSTED' || :'p_g1'),
  'permission denied');
RESET ROLE;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t20/083: an org ADMIN (authenticated) holding the token -> permission denied',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 4321, 'image/jpeg')$q$,
         :'t_g1', :'p_g1', :'TRUSTED' || :'p_g1'),
  'permission denied');
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t20/083: the refused calls left the session row byte-identical (PENDING)',
  (SELECT row_to_json(s)::text FROM product_image_upload_sessions s WHERE id = :'g1'::jsonb->>'sessionId') = :'g1_before');

SET ROLE service_role;
SELECT public.complete_product_image_upload_session(:'t_g1', :'p_g1', 'http://api-gw:8000/storage/v1/object/public/product-images/' || :'p_g1',
                                                    4321, 'image/jpeg') AS done_g1 \gset
SELECT test.expect_error('t20/083: service_role completion of an object stored as text/html is still refused by the RPC (second line behind the function)',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 300, 'image/jpeg')$q$,
         :'t_g2', :'p_g2', :'TRUSTED' || :'p_g2'),
  'Unsupported uploaded image type');
RESET ROLE;
SELECT test.check('t20/083: service_role (the phone-upload-token function) completes a valid session; the stored URL is the trusted one, not the internal host it passed',
  :'done_g1'::jsonb->>'status' = 'COMPLETED' AND :'done_g1'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_g1'
  AND (SELECT status = 'COMPLETED' AND public_url = :'TRUSTED' || :'p_g1' AND bytes = 4321 AND mime_type = 'image/jpeg'
         FROM product_image_upload_sessions WHERE id = :'g1'::jsonb->>'sessionId'));
SELECT test.check('t20/083: the text/html session stayed PENDING with no URL',
  (SELECT status = 'PENDING' AND public_url IS NULL FROM product_image_upload_sessions WHERE id = :'g2'::jsonb->>'sessionId'));
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.get_product_image_upload_session_status(:'g1'::jsonb->>'sessionId') AS st_g1 \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t20/083: the desktop poll still returns the derived URL for the function-completed session',
  :'st_g1'::jsonb->>'status' = 'COMPLETED' AND :'st_g1'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_g1');

-- ============================================================
-- 4. Existing image references still resolve
-- ============================================================
SELECT test.check('t20/083: every products.image_url that names a product-images object still has that object (no row removed)',
  NOT EXISTS (SELECT 1 FROM products p
               WHERE p.image_url LIKE :'TRUSTED' || '%'
                 AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'product-images'
                                    AND :'TRUSTED' || o.name = p.image_url))
  AND EXISTS (SELECT 1 FROM products WHERE image_url LIKE :'TRUSTED' || '%'));

-- ============================================================
-- 5. Guard preparation: production's pre-083 state (NULL limits) + violators
-- ============================================================
-- The guard's rule, as a test helper: an object violates 083 when its
-- storage-api metadata lacks a numeric size or an allowed mimetype, or is
-- over the limit (CASE: the cast never sees a non-numeric size).
CREATE OR REPLACE FUNCTION test.t20_bad(m jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT m IS NULL
      OR NOT coalesce(m->>'mimetype' = ANY (ARRAY['image/jpeg', 'image/png', 'image/webp']), false)
      OR coalesce(m->>'size', '') !~ '^[0-9]{1,18}$'
      OR CASE WHEN m->>'size' ~ '^[0-9]{1,18}$' THEN (m->>'size')::bigint > 5242880 ELSE true END $$;
-- Earlier harness tests insert objects without (complete) storage-api
-- metadata; production has none like that (574/574 carry size + mimetype,
-- measured 2026-10-16). Give them what storage-api would have written, so
-- only the deliberate violators below trip the guard.
UPDATE storage.objects SET metadata = jsonb_build_object('size', 2000, 'mimetype', 'image/webp')
 WHERE bucket_id = 'product-images' AND test.t20_bad(metadata);
UPDATE storage.buckets SET allowed_mime_types = NULL, file_size_limit = NULL WHERE id = 'product-images';
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata) VALUES
  ('product-images', 'org/org-test/products/prod-1/t20-page.jpg', :'AA', :'AA', '{"size": 300, "mimetype": "text/html"}'),
  ('product-images', 'org/org-test/products/prod-1/t20-oversize.webp', :'AA', :'AA', '{"size": 5242881, "mimetype": "image/webp"}'),
  ('product-images', 'org/org-test/products/prod-1/t20-vector.svg', :'AA', :'AA', '{"size": 900, "mimetype": "image/svg+xml"}'),
  ('product-images', 'org/org-test/products/prod-1/t20-nometa.jpg', :'AA', :'AA', NULL);
SELECT test.setvar('t20_objects_a', (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o));
SELECT test.check('t20 guard prep: bucket reset to the production pre-083 state (NULL / NULL); exactly 4 violating objects (html, oversize, svg, no metadata)',
  (SELECT allowed_mime_types IS NULL AND file_size_limit IS NULL FROM storage.buckets WHERE id = 'product-images')
  AND (SELECT count(*) FROM storage.objects WHERE bucket_id = 'product-images' AND test.t20_bad(metadata)) = 4);
