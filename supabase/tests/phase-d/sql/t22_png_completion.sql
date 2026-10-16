-- t22 part A: 085 - complete_product_image_upload_session accepts image/png
-- with the same size rule as image/jpeg and image/webp. Gated by run.sh on
-- migrations >= 085; runs after t21 (org-test, sessions, products.image_url
-- exist) and before the t12 bootstrap prep (which empties users). run.sh
-- re-applies 085 right before this file (t21's guard cycles re-applied 083,
-- which resets the COMMENT to its 083 text), and runs the 085 guard cycles
-- between part A and part B (t22_png_completion_b.sql).
--
-- Byte checks (PNG magic number / IHDR, markup) and the delete-on-refusal of
-- the phone-upload-token function are covered by the Deno tests and the
-- security-audit stack (real storage-api). This file covers the RPC.
\set ON_ERROR_STOP on
\set AA  'a0000000-0000-4000-8000-000000000001'
\set SIG 'public.complete_product_image_upload_session(text,text,text,integer,text)'
\set TRUSTED 'https://pos.test/storage/v1/object/public/product-images/'
\set INTERNAL 'http://api-gw:8000/storage/v1/object/public/product-images/'
SELECT test.logout() AS zz \gset

-- ============================================================
-- 1. State after 085
-- ============================================================
SELECT test.check('t22/085: completion body is the 085 body (md5 dc822a64...), i.e. the 080 body with only the two type lists extended',
  (SELECT md5(prosrc) = 'dc822a6435c3e512acdc933c4a2995a8' FROM pg_proc WHERE oid = :'SIG'::regprocedure),
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = :'SIG'::regprocedure));
SELECT test.check('t22/085: both type checks list image/webp, image/jpeg, image/png; no two-type list is left',
  (SELECT (length(prosrc) - length(replace(prosrc, $q$NOT IN ('image/webp', 'image/jpeg', 'image/png')$q$, ''))) / length($q$NOT IN ('image/webp', 'image/jpeg', 'image/png')$q$) = 2
          AND position($q$('image/webp', 'image/jpeg')$q$ in prosrc) = 0
     FROM pg_proc WHERE oid = :'SIG'::regprocedure));
SELECT test.check('t22/085: the size rule is unchanged and type-independent (1..102400, caller value and object metadata)',
  (SELECT (length(prosrc) - length(replace(prosrc, '> 102400', ''))) / length('> 102400') = 2 FROM pg_proc WHERE oid = :'SIG'::regprocedure));
SELECT test.check('t22/085: grants unchanged from 083 - EXECUTE for service_role only (not anon, authenticated, PUBLIC)',
  NOT has_function_privilege('anon', :'SIG', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', :'SIG', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = :'SIG'::regprocedure AND a.grantee = 0)
  AND has_function_privilege('service_role', :'SIG', 'EXECUTE'));
SELECT test.check('t22/085: SECURITY DEFINER, owner postgres, search_path=public, signature and return type unchanged',
  (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=public']
          AND prorettype = 'jsonb'::regtype AND pg_get_function_identity_arguments(oid) = 'p_token text, p_storage_path text, p_public_url text, p_bytes integer, p_mime_type text'
     FROM pg_proc WHERE oid = :'SIG'::regprocedure));
SELECT test.check('t22/085: COMMENT keeps the 083: prefix (084''s guard, test.m083) and names 085',
  test.m083() AND obj_description(:'SIG'::regprocedure, 'pg_proc') LIKE '083:%085: accepts image/jpeg, image/png and image/webp%');
SELECT test.check('t22/085: the bucket is unchanged (083 limits; 085 touches no bucket)',
  (SELECT public AND allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'] AND file_size_limit = 5242880
     FROM storage.buckets WHERE id = 'product-images'));

-- ============================================================
-- 2. Behaviour (service_role = the phone-upload-token function)
-- ============================================================
-- sessions: png, png at exactly 102400 B, png over, png size 0, png declared
-- by the client but stored as gif, gif, svg, html, octet-stream, jpeg, webp
CREATE TEMP TABLE t22 (k text PRIMARY KEY, sess jsonb, size bigint, stored_type text, claimed_type text, claimed_bytes integer);
INSERT INTO t22 (k, size, stored_type, claimed_type, claimed_bytes) VALUES
  ('png',          4321,   'image/png',                'image/png',  4321),
  ('png_max',      102400, 'image/png',                'image/png',  102400),
  ('png_over',     102401, 'image/png',                'image/png',  2000),
  ('png_zero',     0,      'image/png',                'image/png',  10),
  ('png_as_gif',   900,    'image/gif',                'image/png',  900),
  ('gif',          900,    'image/gif',                'image/gif',  900),
  ('svg',          900,    'image/svg+xml',            'image/svg+xml', 900),
  ('html',         300,    'text/html',                'text/html',  300),
  ('octet',        300,    'application/octet-stream', 'image/png',  300),
  ('jpeg',         5000,   'image/jpeg',               'image/jpeg', 5000),
  ('webp',         6000,   'image/webp',               'image/webp', 6000),
  ('claim_png_big',2000,   'image/png',                'image/png',  102401);
GRANT SELECT, UPDATE ON t22 TO authenticated;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT k FROM t22 ORDER BY k LOOP
    UPDATE t22 SET sess = public.create_product_image_upload_session('shop-a', 'prod-2') WHERE k = r.k;
  END LOOP;
END $$;
RESET ROLE;
SELECT test.logout() AS zz \gset
-- the phone's upload (storage-api's own metadata; RLS bypassed like storage-api)
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
SELECT 'product-images', t.sess->>'storagePath', NULL, NULL, jsonb_build_object('size', t.size, 'mimetype', t.stored_type)
  FROM t22 t;

CREATE OR REPLACE FUNCTION pg_temp.t22_complete(p_k text, p_role text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE t record; v jsonb;
BEGIN
  SELECT * INTO t FROM t22 WHERE k = p_k;
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    v := public.complete_product_image_upload_session(t.sess->>'token', t.sess->>'storagePath',
           'http://api-gw:8000/storage/v1/object/public/product-images/' || (t.sess->>'storagePath'), t.claimed_bytes, t.claimed_type);
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RETURN 'ERR ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN 'OK ' || (v->>'status') || ' ' || (v->>'mimeType') || ' ' || (v->>'bytes') || ' ' || coalesce(v->>'publicUrl', '<null>');
END $$;

-- anon / authenticated are refused before any type rule (083 grants, unchanged by 085)
SELECT test.check('t22/085: anon cannot complete a valid PNG session (permission denied)',
  pg_temp.t22_complete('png', 'anon') LIKE 'ERR permission denied%', pg_temp.t22_complete('png', 'anon'));
SELECT test.check('t22/085: authenticated cannot complete a valid PNG session (permission denied)',
  pg_temp.t22_complete('png', 'authenticated') LIKE 'ERR permission denied%');

SELECT pg_temp.t22_complete(k, 'service_role') AS r_png FROM t22 WHERE k = 'png' \gset
SELECT pg_temp.t22_complete(k, 'service_role') AS r_png_max FROM t22 WHERE k = 'png_max' \gset
SELECT pg_temp.t22_complete(k, 'service_role') AS r_jpeg FROM t22 WHERE k = 'jpeg' \gset
SELECT pg_temp.t22_complete(k, 'service_role') AS r_webp FROM t22 WHERE k = 'webp' \gset
SELECT sess->>'storagePath' AS p_png, sess->>'sessionId' AS id_png FROM t22 WHERE k = 'png' \gset
SELECT test.check('t22/085: a valid PNG (4321 B, stored image/png) completes for service_role; type and size come from the object; URL is the trusted one',
  :'r_png' = 'OK COMPLETED image/png 4321 ' || :'TRUSTED' || :'p_png'
  AND (SELECT status = 'COMPLETED' AND mime_type = 'image/png' AND bytes = 4321 AND public_url = :'TRUSTED' || :'p_png' AND completed_at IS NOT NULL
         FROM product_image_upload_sessions WHERE id = :'id_png'), :'r_png');
SELECT test.check('t22/085: a PNG of exactly 102400 B (the limit, same as JPEG/WebP) completes',
  :'r_png_max' LIKE 'OK COMPLETED image/png 102400 %', :'r_png_max');
SELECT test.check('t22/085: JPEG and WebP still complete exactly as before',
  :'r_jpeg' LIKE 'OK COMPLETED image/jpeg 5000 %' AND :'r_webp' LIKE 'OK COMPLETED image/webp 6000 %', :'r_jpeg' || ' / ' || :'r_webp');

SELECT test.check('t22/085: PNG object of 102401 B -> "100 KB or smaller" (same size rule)',
  pg_temp.t22_complete('png_over', 'service_role') = 'ERR Uploaded image must be 100 KB or smaller', pg_temp.t22_complete('png_over', 'service_role'));
SELECT test.check('t22/085: PNG object of 0 B -> refused by the size rule',
  pg_temp.t22_complete('png_zero', 'service_role') = 'ERR Uploaded image must be 100 KB or smaller');
SELECT test.check('t22/085: client claims a 102401 B PNG -> refused by the caller-value size check',
  pg_temp.t22_complete('claim_png_big', 'service_role') = 'ERR Uploaded image must be 100 KB or smaller');
SELECT test.check('t22/085: client claims image/png but the object is image/gif -> "Unsupported uploaded image type" (object metadata wins)',
  pg_temp.t22_complete('png_as_gif', 'service_role') = 'ERR Unsupported uploaded image type');
SELECT test.check('t22/085: client claims image/png but the object is application/octet-stream -> refused',
  pg_temp.t22_complete('octet', 'service_role') = 'ERR Unsupported uploaded image type');
SELECT test.check('t22/085: other types are still refused (image/gif, image/svg+xml, text/html)',
  pg_temp.t22_complete('gif', 'service_role') = 'ERR Unsupported uploaded image type'
  AND pg_temp.t22_complete('svg', 'service_role') = 'ERR Unsupported uploaded image type'
  AND pg_temp.t22_complete('html', 'service_role') = 'ERR Unsupported uploaded image type');
SELECT test.check('t22/085: every refused session stayed PENDING with no URL / bytes / type; exactly the 4 valid ones completed',
  (SELECT count(*) FILTER (WHERE s.status = 'COMPLETED') = 4
      AND bool_and(s.status = 'COMPLETED') FILTER (WHERE t.k IN ('png', 'png_max', 'jpeg', 'webp'))
      AND bool_and(s.status = 'PENDING' AND s.public_url IS NULL AND s.bytes IS NULL AND s.mime_type IS NULL AND s.completed_at IS NULL)
            FILTER (WHERE t.k NOT IN ('png', 'png_max', 'jpeg', 'webp'))
     FROM t22 t JOIN product_image_upload_sessions s ON s.id = t.sess->>'sessionId'));
SELECT test.check('t22/085: a completed PNG session cannot be completed again ("no longer active")',
  pg_temp.t22_complete('png', 'service_role') = 'ERR Upload link is no longer active');
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.get_product_image_upload_session_status(:'id_png') AS st_png \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t22/085: the desktop poll returns COMPLETED, image/png and the derived URL for the PNG session',
  :'st_png'::jsonb->>'status' = 'COMPLETED' AND :'st_png'::jsonb->>'mimeType' = 'image/png'
  AND :'st_png'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_png');

-- clean the refused fixtures' objects (the function would have deleted them); keep the completed ones
DELETE FROM storage.objects o USING t22 t
 WHERE o.bucket_id = 'product-images' AND o.name = t.sess->>'storagePath'
   AND t.k NOT IN ('png', 'png_max', 'jpeg', 'webp');

-- fingerprint for the guard cycles (run.sh) and part B
SELECT test.setvar('t22_rows_a',
  (SELECT count(*)::text || ':' || md5(coalesce(string_agg(s::text, E'\n' ORDER BY s.id), '')) FROM product_image_upload_sessions s)
  || '/' || (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o));
SELECT 'INFO t22 part A done; rows ' || test.var('t22_rows_a');
