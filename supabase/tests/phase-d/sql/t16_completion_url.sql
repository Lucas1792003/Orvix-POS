-- t16: 080 - phone-upload completion stores a server-derived URL and requires
-- the uploaded object. Gated by run.sh on migrations >= 080; runs after t15
-- (org-test + org-two exist) and before the t12 bootstrap prep (which empties
-- users). The trusted base is seeded by 02_seed.sql: https://pos.test.
-- storage-api is simulated as in t14: the phone's uploadToSignedUrl = an
-- INSERT into storage.objects as the storage superuser (RLS bypassed), with
-- storage-api's metadata {size, mimetype}.
--
-- DECISION under test: a client-supplied host is IGNORED, not rejected - the
-- URL's path must be the session's own object, and the URL stored / returned
-- is always <app_config base>/storage/v1/object/public/product-images/<path>.
\set ON_ERROR_STOP on
\set AA  'a0000000-0000-4000-8000-000000000001'
\set AX  'a0000000-0000-4000-8000-000000000011'
\set PUBPATH '/storage/v1/object/public/product-images/'
\set TRUSTED 'https://pos.test/storage/v1/object/public/product-images/'
SELECT test.logout() AS zz \gset

-- the phone's upload (storage superuser), with storage-api metadata
CREATE OR REPLACE FUNCTION test.t16_put(p_bucket text, p_name text, p_size bigint, p_mime text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
  VALUES (p_bucket, p_name, 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
          CASE WHEN p_size IS NULL THEN NULL
               ELSE jsonb_build_object('size', p_size, 'mimetype', p_mime, 'eTag', '"t16"') END);
$$;

-- call completion as the CURRENT role; return 'OK:<publicUrl>' (the call is
-- rolled back, so the session stays usable) or the error message
CREATE OR REPLACE FUNCTION test.t16_err(p_token text, p_path text, p_url text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  BEGIN
    v := public.complete_product_image_upload_session(p_token, p_path, p_url, 2000, 'image/webp');
    RAISE EXCEPTION USING ERRCODE = 'P0T16', MESSAGE = 'OK:' || COALESCE(v->>'publicUrl', 'null');
  EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
  END;
END $$;
GRANT EXECUTE ON FUNCTION test.t16_err(text, text, text) TO anon;

-- ============================================================
-- 0. Static: grants, config table, helper
-- ============================================================
SELECT test.check('t16/080: complete_/status/_by_token bodies carry 080; signatures unchanged',
  (SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%080%' AND oid IN (
     'public.complete_product_image_upload_session(text,text,text,integer,text)'::regprocedure,
     'public.get_product_image_upload_session_status(text)'::regprocedure,
     'public.get_product_image_upload_session_by_token(text)'::regprocedure)) = 3
  AND (SELECT bool_and(prosecdef) FROM pg_proc WHERE proname IN
       ('complete_product_image_upload_session','get_product_image_upload_session_status','get_product_image_upload_session_by_token')));
SELECT test.check('t16/080: grants unchanged - anon executes complete_ and _by_token, not status',
  has_function_privilege('anon', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE')
  AND has_function_privilege('anon', 'public.get_product_image_upload_session_by_token(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.get_product_image_upload_session_status(text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.get_product_image_upload_session_status(text)', 'EXECUTE'));
SELECT test.check('t16/080: app_config is service_role-only (no anon/authenticated table privilege), RLS on, owned by postgres',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
               WHERE table_schema = 'public' AND table_name = 'app_config' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
  AND (SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'app_config' AND grantee = 'service_role') = 'DELETE,INSERT,SELECT,UPDATE'
  AND (SELECT relrowsecurity AND pg_get_userbyid(relowner) = 'postgres' FROM pg_class WHERE oid = 'public.app_config'::regclass));
SELECT test.check('t16/080: the URL helper is not executable by anon / authenticated',
  NOT has_function_privilege('anon', 'public.app_upload_session_public_url(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.app_upload_session_public_url(text)', 'EXECUTE'));
SET ROLE anon;
SELECT test.expect_error('t16/080: anon cannot read app_config', 'SELECT count(*) FROM public.app_config', 'permission denied');
SELECT test.expect_error('t16/080: anon cannot call the URL helper', $q$SELECT public.app_upload_session_public_url('temp/x')$q$, 'permission denied');
RESET ROLE;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t16/080: an org ADMIN (authenticated) cannot repoint the trusted base',
  $q$UPDATE public.app_config SET value = 'https://evil.example'$q$, 'permission denied');
SELECT test.expect_error('t16/080: an org ADMIN (authenticated) cannot insert configuration',
  $q$INSERT INTO public.app_config (key, value) VALUES ('supabase_public_url', 'https://evil.example')$q$, 'permission denied');
RESET ROLE;
SELECT test.check('t16/080: the configured base value has the allowed shape (harness: https://pos.test)',
  (SELECT value FROM public.app_config WHERE key = 'supabase_public_url') = 'https://pos.test');
-- shape constraint (as superuser: even the operator cannot store a bad base)
SELECT test.expect_error('t16/080: base with a trailing slash is refused by the CHECK',
  $q$UPDATE public.app_config SET value = 'https://pos.test/' WHERE key = 'supabase_public_url'$q$, 'app_config_supabase_public_url_shape');
SELECT test.expect_error('t16/080: base with a path is refused',
  $q$UPDATE public.app_config SET value = 'https://pos.test/storage/v1' WHERE key = 'supabase_public_url'$q$, 'app_config_supabase_public_url_shape');
SELECT test.expect_error('t16/080: base with a query is refused',
  $q$UPDATE public.app_config SET value = 'https://pos.test?x=1' WHERE key = 'supabase_public_url'$q$, 'app_config_supabase_public_url_shape');
SELECT test.expect_error('t16/080: base with upper-case host is refused',
  $q$UPDATE public.app_config SET value = 'https://POS.test' WHERE key = 'supabase_public_url'$q$, 'app_config_supabase_public_url_shape');
SELECT test.expect_error('t16/080: base with userinfo is refused',
  $q$UPDATE public.app_config SET value = 'https://pos.test@evil.example' WHERE key = 'supabase_public_url'$q$, 'app_config_supabase_public_url_shape');
SELECT test.expect_error('t16/080: plain http to a non-local host is refused',
  $q$UPDATE public.app_config SET value = 'http://pos.test' WHERE key = 'supabase_public_url'$q$, 'app_config_supabase_public_url_shape');
SELECT test.expect_error('t16/080: unknown configuration keys are refused',
  $q$INSERT INTO public.app_config (key, value) VALUES ('storage_public_base', 'https://pos.test')$q$, 'app_config_key_known');

-- ============================================================
-- 1. Sessions (org-test desktop) + one org-two session
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS v1  \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS v2  \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-2') AS v3  \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS ext \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS wb  \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS enc \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS exp \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS can \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS mis \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS big \gset
SELECT public.create_product_image_upload_session('shop-a', 'prod-1') AS cfg \gset
SELECT public.cancel_product_image_upload_session(:'can'::jsonb->>'sessionId') AS zz \gset
RESET ROLE;
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session('shop-x', 'prod-x2') AS x1 \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
UPDATE product_image_upload_sessions SET expires_at = now() - interval '1 minute' WHERE id = :'exp'::jsonb->>'sessionId';

SELECT :'v1'::jsonb->>'storagePath' AS p_v1, :'v2'::jsonb->>'storagePath' AS p_v2, :'v3'::jsonb->>'storagePath' AS p_v3,
       :'ext'::jsonb->>'storagePath' AS p_ext, :'wb'::jsonb->>'storagePath' AS p_wb, :'enc'::jsonb->>'storagePath' AS p_enc,
       :'exp'::jsonb->>'storagePath' AS p_exp, :'can'::jsonb->>'storagePath' AS p_can, :'mis'::jsonb->>'storagePath' AS p_mis,
       :'big'::jsonb->>'storagePath' AS p_big, :'cfg'::jsonb->>'storagePath' AS p_cfg, :'x1'::jsonb->>'storagePath' AS p_x1,
       :'v1'::jsonb->>'token' AS t_v1, :'v2'::jsonb->>'token' AS t_v2, :'ext'::jsonb->>'token' AS t_ext,
       :'wb'::jsonb->>'token' AS t_wb, :'enc'::jsonb->>'token' AS t_enc, :'exp'::jsonb->>'token' AS t_exp,
       :'can'::jsonb->>'token' AS t_can, :'mis'::jsonb->>'token' AS t_mis, :'big'::jsonb->>'token' AS t_big,
       :'cfg'::jsonb->>'token' AS t_cfg \gset

-- the phone uploads (storage superuser). v3 / x1 / exp / can / big / cfg / enc
-- have objects; mis has none; wb's object is in ANOTHER bucket.
INSERT INTO storage.buckets (id, name, public) VALUES ('t16-other', 't16-other', true) ON CONFLICT (id) DO NOTHING;
SELECT test.t16_put('product-images', :'p_v1', 3210, 'image/webp'),
       test.t16_put('product-images', :'p_v2', 2000, 'image/webp'),
       test.t16_put('product-images', :'p_v3', 2000, 'image/webp'),
       test.t16_put('product-images', :'p_x1', 2000, 'image/webp'),
       test.t16_put('product-images', :'p_ext', 2500, 'image/jpeg'),
       test.t16_put('t16-other',      :'p_wb', 2000, 'image/webp'),
       test.t16_put('product-images', :'p_enc', 2000, 'image/webp'),
       test.t16_put('product-images', :'p_exp', 2000, 'image/webp'),
       test.t16_put('product-images', :'p_can', 2000, 'image/webp'),
       test.t16_put('product-images', :'p_big', 150000, 'image/webp'),
       test.t16_put('product-images', :'p_cfg', 2000, 'image/webp') \gset

-- ============================================================
-- 2. Valid upload -> COMPLETED with the derived URL; values from storage
-- ============================================================
SET ROLE anon;
-- client claims 4000 bytes / image/jpeg; storage-api metadata says 3210 / image/webp
SELECT public.complete_product_image_upload_session(:'t_v1', :'p_v1', 'https://pos.test' || :'PUBPATH' || :'p_v1', 4000, 'image/jpeg') AS done_v1 \gset
SELECT public.get_product_image_upload_session_by_token(:'t_v1') AS bt_v1 \gset
RESET ROLE;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.get_product_image_upload_session_status(:'v1'::jsonb->>'sessionId') AS st_v1 \gset
-- what the desktop does with the poll result: onUploaded(publicUrl) -> products.image_url
UPDATE products SET image_url = :'st_v1'::jsonb->>'publicUrl' WHERE id = 'prod-1';
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t16/080: valid uploaded object -> COMPLETED; completion, phone (by-token) and desktop poll all return the derived URL',
  :'done_v1'::jsonb->>'status' = 'COMPLETED'
  AND :'done_v1'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_v1'
  AND :'bt_v1'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_v1'
  AND :'st_v1'::jsonb->>'status' = 'COMPLETED' AND :'st_v1'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_v1',
  'publicUrl=' || COALESCE(:'st_v1'::jsonb->>'publicUrl', 'null'));
SELECT test.check('t16/080: bytes / mime_type stored from the storage object metadata, not the client (3210 webp, client said 4000 jpeg)',
  (SELECT bytes = 3210 AND mime_type = 'image/webp' AND public_url = :'TRUSTED' || :'p_v1' AND storage_path = :'p_v1'
     FROM product_image_upload_sessions WHERE id = :'v1'::jsonb->>'sessionId')
  AND (:'done_v1'::jsonb->>'bytes')::int = 3210 AND :'done_v1'::jsonb->>'mimeType' = 'image/webp');
SELECT test.check('t16/080: products.image_url written from the poll is the trusted URL and names an existing product-images object',
  (SELECT p.image_url = :'TRUSTED' || :'p_v1'
          AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'product-images'
                         AND :'TRUSTED' || o.name = p.image_url)
     FROM products p WHERE p.id = 'prod-1'));

-- ============================================================
-- 3. Repeated completion -> rejected; nothing duplicated or changed
-- ============================================================
SELECT (SELECT row_to_json(s)::text FROM product_image_upload_sessions s WHERE id = :'v1'::jsonb->>'sessionId') AS v1_row \gset
SET ROLE anon;
SELECT test.expect_error('t16/080: repeated completion (same token, same values) is rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 4000, 'image/webp')$q$,
         :'t_v1', :'p_v1', 'https://pos.test' || :'PUBPATH' || :'p_v1'),
  'Upload link is no longer active');
SELECT test.expect_error('t16/080: repeated completion with an external host is rejected too',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 4000, 'image/webp')$q$,
         :'t_v1', :'p_v1', 'https://evil.example' || :'PUBPATH' || :'p_v1'),
  'Upload link is no longer active');
RESET ROLE;
SELECT test.check('t16/080: after repeated completions the session row is byte-identical and there is one session / one object for the path',
  (SELECT row_to_json(s)::text FROM product_image_upload_sessions s WHERE id = :'v1'::jsonb->>'sessionId') = :'v1_row'
  AND (SELECT count(*) FROM product_image_upload_sessions WHERE storage_path = :'p_v1') = 1
  AND (SELECT count(*) FROM storage.objects WHERE name = :'p_v1') = 1);

-- ============================================================
-- 4. External host with the matching path -> host IGNORED, trusted URL stored
-- ============================================================
SET ROLE anon;
SELECT public.complete_product_image_upload_session(:'t_ext', :'p_ext',
  'https://evil.example' || :'PUBPATH' || :'p_ext', 2500, 'image/jpeg') AS done_ext \gset
RESET ROLE;
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.get_product_image_upload_session_status(:'ext'::jsonb->>'sessionId') AS st_ext \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t16/080: external hostname + matching path -> host ignored: COMPLETED with the TRUSTED URL (stored, returned, polled); evil.example appears nowhere',
  :'done_ext'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_ext'
  AND :'st_ext'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_ext'
  AND (SELECT public_url = :'TRUSTED' || :'p_ext' AND position('evil' in row_to_json(s)::text) = 0
         FROM product_image_upload_sessions s WHERE id = :'ext'::jsonb->>'sessionId'),
  'stored=' || (SELECT public_url FROM product_image_upload_sessions WHERE id = :'ext'::jsonb->>'sessionId'));
-- more host tricks, each on v2 (object present): all ignored, so v2 would
-- complete - run them inside a rolled-back probe and look at what is stored
SET ROLE anon;
SELECT test.check('t16/080: host variants (userinfo, port, http, IP, other bucket-looking host) are all ignored - stored URL is always the trusted one',
  (SELECT bool_and(test.t16_err(:'t_v2', :'p_v2', u || :'PUBPATH' || :'p_v2') = 'OK:' || :'TRUSTED' || :'p_v2')
     FROM unnest(ARRAY['https://pos.test@evil.example', 'https://evil.example:443', 'http://evil.example',
                       'https://10.0.0.1', 'https://pos.test.evil.example', 'http://localhost:54321']) u));
RESET ROLE;
SELECT test.check('t16/080: the rolled-back host probes left v2 PENDING with no public_url',
  (SELECT status = 'PENDING' AND public_url IS NULL FROM product_image_upload_sessions WHERE id = :'v2'::jsonb->>'sessionId'));

-- ============================================================
-- 5. Wrong bucket / wrong product / wrong session
-- ============================================================
SET ROLE anon;
SELECT test.expect_error('t16/080: object only in ANOTHER bucket (same name) -> rejected, not found',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_wb', :'p_wb', 'https://pos.test' || :'PUBPATH' || :'p_wb'),
  'Uploaded image was not found in storage');
SELECT test.expect_error('t16/080: URL naming another bucket -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_v2', :'p_v2', 'https://pos.test/storage/v1/object/public/t16-other/' || :'p_v2'),
  'Uploaded image URL');  -- 079's bucket-path check or 080's exact-path check
SELECT test.expect_error('t16/080: URL of a non-public route (object/sign) -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_v2', :'p_v2', 'https://pos.test/storage/v1/object/sign/product-images/' || :'p_v2'),
  'Uploaded image URL');  -- 079's bucket-path check or 080's exact-path check
SELECT test.expect_error('t16/080: wrong product - path of another session of the same org (prod-2) -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_v2', :'p_v3', 'https://pos.test' || :'PUBPATH' || :'p_v3'),
  'Upload path does not match this session');
SELECT test.expect_error('t16/080: wrong product - own path but URL of the prod-2 session''s object -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_v2', :'p_v2', 'https://pos.test' || :'PUBPATH' || :'p_v3'),
  'does not match this upload session');
SELECT test.expect_error('t16/080: wrong org - path of an org-two session -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_v2', :'p_x1', 'https://pos.test' || :'PUBPATH' || :'p_x1'),
  'Upload path does not match this session');
SELECT test.expect_error('t16/080: product path (org/<org>/products/<id>/...) instead of the session path -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_v2', 'org/org-test/products/prod-1/1.webp', 'https://pos.test' || :'PUBPATH' || 'org/org-test/products/prod-1/1.webp'),
  'Upload path does not match this session');
SELECT test.expect_error('t16/080: legacy unprefixed temp/<id> form of the own session -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_v2', 'temp/' || (:'v2'::jsonb->>'sessionId'), 'https://pos.test' || :'PUBPATH' || 'temp/' || (:'v2'::jsonb->>'sessionId')),
  'Upload path does not match this session');
SELECT test.expect_error('t16/080: wrong session - a completed session''s token with v2''s path -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_v1', :'p_v2', 'https://pos.test' || :'PUBPATH' || :'p_v2'),
  'Upload link is no longer active');
SELECT test.expect_error('t16/080: wrong session - the session id instead of the token -> Invalid upload link',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'v2'::jsonb->>'sessionId', :'p_v2', 'https://pos.test' || :'PUBPATH' || :'p_v2'),
  'Invalid upload link');
SELECT test.expect_error('t16/080: wrong session - a well-formed random token -> Invalid upload link',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         md5('t16a') || md5('t16b') || md5('t16c') || md5('t16d'), :'p_v2', 'https://pos.test' || :'PUBPATH' || :'p_v2'),
  'Invalid upload link');
RESET ROLE;

-- ============================================================
-- 6. Encoded / normalisation variants of the PATH (all on enc: object present)
-- ============================================================
CREATE TEMP TABLE t16_variants (label text, v text);
INSERT INTO t16_variants VALUES
  ('%2F for /',            replace(:'p_enc', '/', '%2F')),
  ('%2f lower-case',       replace(:'p_enc', '/', '%2f')),
  ('%2e%2e segment',       'org/org-test/temp/%2e%2e/temp/' || (:'enc'::jsonb->>'sessionId')),
  ('.. traversal',         'org/org-test/temp/../temp/' || (:'enc'::jsonb->>'sessionId')),
  ('./ segment',           'org/org-test/./temp/' || (:'enc'::jsonb->>'sessionId')),
  ('double slash',         replace(:'p_enc', '/temp/', '//temp/')),
  ('leading slash',        '/' || :'p_enc'),
  ('trailing slash',       :'p_enc' || '/'),
  ('upper-case',           upper(:'p_enc')),
  ('upper-case org only',  replace(:'p_enc', 'org-test', 'ORG-TEST')),
  ('unicode o (U+043E)',   replace(:'p_enc', 'org/', U&'\043Erg/')),
  ('fullwidth slash',      replace(:'p_enc', '/temp/', U&'/temp\FF0F')),
  ('zero-width space',     replace(:'p_enc', 'temp/', U&'temp\200B/')),
  ('NFD-like combining',   :'p_enc' || U&'\0301'),
  ('trailing space',       :'p_enc' || ' '),
  ('leading space',        ' ' || :'p_enc'),
  ('tab',                  :'p_enc' || E'\t'),
  ('newline',              :'p_enc' || E'\n'),
  ('backslash',            replace(:'p_enc', '/temp/', '\temp\')),
  ('query',                :'p_enc' || '?x=1'),
  ('fragment',             :'p_enc' || '#x'),
  ('empty',                ''),
  ('NULL',                 NULL);
GRANT SELECT ON t16_variants TO anon;
SET ROLE anon;
SELECT test.check('t16/080: every encoded / normalised / lookalike PATH variant is rejected with the path message',
  bool_and(m LIKE '%Upload path does not match this session%'),
  string_agg(label || '=' || left(m, 50), '; ') FILTER (WHERE m NOT LIKE '%Upload path does not match this session%'))
  FROM (SELECT label, (SELECT test.t16_err(:'t_enc', v, 'https://pos.test' || :'PUBPATH' || :'p_enc')) AS m FROM t16_variants) x;
RESET ROLE;

-- ============================================================
-- 7. URL variants: encoded path, query string, fragment, case, slashes
-- ============================================================
CREATE TEMP TABLE t16_url_variants (label text, u text);
INSERT INTO t16_url_variants VALUES
  ('query string',          'https://pos.test' || :'PUBPATH' || :'p_enc' || '?download=1'),
  ('query smuggling host',  'https://pos.test' || :'PUBPATH' || :'p_enc' || '?r=https://evil.example/x'),
  ('fragment',              'https://pos.test' || :'PUBPATH' || :'p_enc' || '#x'),
  ('empty query',           'https://pos.test' || :'PUBPATH' || :'p_enc' || '?'),
  ('%2F in path',           'https://pos.test' || :'PUBPATH' || replace(:'p_enc', '/', '%2F')),
  ('%2e%2e in path',        'https://pos.test' || :'PUBPATH' || 'org/org-test/temp/%2e%2e/temp/' || (:'enc'::jsonb->>'sessionId')),
  ('.. in path',            'https://pos.test' || :'PUBPATH' || 'org/org-test/temp/x/../' || (:'enc'::jsonb->>'sessionId')),
  ('double slash',          'https://pos.test' || replace(:'PUBPATH', '/public/', '/public//') || :'p_enc'),
  ('trailing slash',        'https://pos.test' || :'PUBPATH' || :'p_enc' || '/'),
  ('upper-case path',       'https://pos.test' || upper(:'PUBPATH' || :'p_enc')),
  ('unicode lookalike',     'https://pos.test' || :'PUBPATH' || replace(:'p_enc', 'org/', U&'\043Erg/')),
  ('backslash',             'https://pos.test' || replace(:'PUBPATH', '/', '\') || :'p_enc'),
  ('whitespace',            'https://pos.test' || :'PUBPATH' || :'p_enc' || ' '),
  ('no scheme',             '//pos.test' || :'PUBPATH' || :'p_enc'),
  ('path only',             :'PUBPATH' || :'p_enc'),
  ('javascript: scheme',    'javascript:' || :'PUBPATH' || :'p_enc'),
  ('data: URL',             'data:image/webp;base64,AAAA'),
  ('ftp scheme',            'ftp://pos.test' || :'PUBPATH' || :'p_enc');
GRANT SELECT ON t16_url_variants TO anon;
SET ROLE anon;
SELECT test.check('t16/080: every query / fragment / encoded / case / slash / scheme variant of the URL is rejected',
  bool_and(m NOT LIKE 'OK:%'
           AND (m LIKE '%does not match this upload session%' OR m LIKE '%must be a Storage URL%'
                OR m LIKE '%must point to the product-images bucket%')),
  string_agg(label || '=' || left(m, 60), '; ') FILTER (WHERE m LIKE 'OK:%' OR NOT (m LIKE '%does not match this upload session%' OR m LIKE '%must be a Storage URL%' OR m LIKE '%must point to the product-images bucket%')))
  FROM (SELECT label, test.t16_err(:'t_enc', :'p_enc', u) AS m FROM t16_url_variants) x;
SELECT test.check('t16/080: control - the same session completes with the plain URL (so the rejections above were the variants)',
  test.t16_err(:'t_enc', :'p_enc', 'https://pos.test' || :'PUBPATH' || :'p_enc') = 'OK:' || :'TRUSTED' || :'p_enc');
RESET ROLE;

-- ============================================================
-- 8. Expired / cancelled (object present) -> rejected, consistent message
-- ============================================================
SET ROLE anon;
SELECT test.expect_error('t16/080: expired session (object uploaded) -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_exp', :'p_exp', 'https://pos.test' || :'PUBPATH' || :'p_exp'),
  'Upload link is no longer active');
SELECT test.expect_error('t16/080: cancelled session (object uploaded) -> rejected with the same message',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_can', :'p_can', 'https://pos.test' || :'PUBPATH' || :'p_can'),
  'Upload link is no longer active');
RESET ROLE;
SELECT test.check('t16/080: expired stays derivably expired (PENDING, past expires_at), cancelled stays CANCELED; neither has a public_url',
  (SELECT status = 'PENDING' AND expires_at <= now() AND public_url IS NULL AND completed_at IS NULL
     FROM product_image_upload_sessions WHERE id = :'exp'::jsonb->>'sessionId')
  AND (SELECT status = 'CANCELED' AND public_url IS NULL AND completed_at IS NULL
     FROM product_image_upload_sessions WHERE id = :'can'::jsonb->>'sessionId'));

-- ============================================================
-- 9. Missing storage object -> rejected, session stays PENDING
-- ============================================================
SET ROLE anon;
SELECT test.expect_error('t16/080: storage object absent -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_mis', :'p_mis', 'https://pos.test' || :'PUBPATH' || :'p_mis'),
  'Uploaded image was not found in storage');
RESET ROLE;
SELECT test.check('t16/080: after the missing-object rejection the session is still PENDING, unexpired, no public_url / bytes / completed_at',
  (SELECT status = 'PENDING' AND expires_at > now() AND public_url IS NULL AND bytes IS NULL AND completed_at IS NULL
     FROM product_image_upload_sessions WHERE id = :'mis'::jsonb->>'sessionId'));
-- the object arrives later (upload finished) -> the same call now succeeds
SELECT test.t16_put('product-images', :'p_mis', 1500, 'image/jpeg') \gset
SET ROLE anon;
SELECT public.complete_product_image_upload_session(:'t_mis', :'p_mis', 'https://pos.test' || :'PUBPATH' || :'p_mis', 1500, 'image/jpeg') AS done_mis \gset
RESET ROLE;
SELECT test.check('t16/080: once the object exists the same session completes (only the object was missing)',
  :'done_mis'::jsonb->>'status' = 'COMPLETED' AND :'done_mis'::jsonb->>'publicUrl' = :'TRUSTED' || :'p_mis'
  AND :'done_mis'::jsonb->>'mimeType' = 'image/jpeg');

-- ============================================================
-- 10. Object metadata over the limit / wrong type -> rejected
-- ============================================================
SET ROLE anon;
SELECT test.expect_error('t16/080: object metadata says 150000 bytes (client claims 2000) -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_big', :'p_big', 'https://pos.test' || :'PUBPATH' || :'p_big'),
  'Uploaded image must be 100 KB or smaller');
RESET ROLE;
UPDATE storage.objects SET metadata = '{"size": 2000, "mimetype": "image/svg+xml"}' WHERE name = :'p_big';
SET ROLE anon;
SELECT test.expect_error('t16/080: object metadata type image/svg+xml (client claims webp) -> rejected',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_big', :'p_big', 'https://pos.test' || :'PUBPATH' || :'p_big'),
  'Unsupported uploaded image type');
RESET ROLE;
SELECT test.check('t16/080: the metadata rejections left the session PENDING',
  (SELECT status = 'PENDING' AND public_url IS NULL FROM product_image_upload_sessions WHERE id = :'big'::jsonb->>'sessionId'));

-- ============================================================
-- 11. Trusted base not configured -> fails closed; readers return null
-- ============================================================
DELETE FROM public.app_config WHERE key = 'supabase_public_url';
SET ROLE anon;
SELECT test.expect_error('t16/080: no trusted base configured -> completion refused (fails closed)',
  format($q$SELECT public.complete_product_image_upload_session(%L, %L, %L, 2000, 'image/webp')$q$,
         :'t_cfg', :'p_cfg', 'https://pos.test' || :'PUBPATH' || :'p_cfg'),
  'Phone image upload is not configured on this server');
SELECT public.get_product_image_upload_session_by_token(:'t_v1') AS bt_nocfg \gset
RESET ROLE;
SELECT test.check('t16/080: unconfigured - session stays PENDING; a COMPLETED session reads back publicUrl null (never a stored/client URL)',
  (SELECT status = 'PENDING' AND public_url IS NULL FROM product_image_upload_sessions WHERE id = :'cfg'::jsonb->>'sessionId')
  AND :'bt_nocfg'::jsonb->>'status' = 'COMPLETED' AND (:'bt_nocfg'::jsonb->'publicUrl') = 'null'::jsonb);
INSERT INTO public.app_config (key, value) VALUES ('supabase_public_url', 'https://pos.test');

-- ============================================================
-- 12. A pre-080 COMPLETED row holding a caller-supplied URL
-- ============================================================
INSERT INTO product_image_upload_sessions (id, token_hash, created_by, shop_id, product_id, storage_path, public_url, bytes, mime_type, status, expires_at, completed_at)
VALUES ('pimg-t16pre080', md5('t16-pre080'), 'u-admin', 'shop-a', 'prod-1', 'org/org-test/temp/pimg-t16pre080',
        'https://evil.example/storage/v1/object/public/product-images/org/org-test/temp/pimg-t16pre080', 4000, 'image/webp',
        'COMPLETED', now() - interval '1 day', now() - interval '1 day');
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.get_product_image_upload_session_status('pimg-t16pre080') AS st_pre \gset
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t16/080: desktop poll of a pre-080 row with a stored external URL returns the derived trusted URL instead',
  :'st_pre'::jsonb->>'publicUrl' = :'TRUSTED' || 'org/org-test/temp/pimg-t16pre080');

-- ============================================================
-- 13. Nothing above completed a session it should not have
-- ============================================================
SELECT test.check('t16/080: final state - only v1, ext, enc-control(rolled back), mis completed; wb/v2/enc/big/cfg PENDING; every COMPLETED 080 row has the trusted URL',
  (SELECT bool_and(status = 'PENDING' AND public_url IS NULL) FROM product_image_upload_sessions
    WHERE id IN (:'wb'::jsonb->>'sessionId', :'v2'::jsonb->>'sessionId', :'enc'::jsonb->>'sessionId',
                 :'big'::jsonb->>'sessionId', :'cfg'::jsonb->>'sessionId'))
  AND (SELECT bool_and(status = 'COMPLETED' AND public_url = :'TRUSTED' || storage_path) FROM product_image_upload_sessions
    WHERE id IN (:'v1'::jsonb->>'sessionId', :'ext'::jsonb->>'sessionId', :'mis'::jsonb->>'sessionId')));
DROP FUNCTION test.t16_err(text, text, text);
DROP FUNCTION test.t16_put(text, text, bigint, text);
