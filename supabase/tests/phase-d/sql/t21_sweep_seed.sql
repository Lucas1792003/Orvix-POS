-- t21 sweep, part 1: fixtures for the deployment's sweep-abandoned-uploads.sql
-- (SWEEP_SQL; G5 follow-up §2). Superuser writes only (storage-api and
-- the session RPCs are simulated). Session ids follow the server format
-- pimg-<32 hex> (md5 of a label). run.sh then runs the REAL candidate query
-- file with grace_hours=24, loads its output into test.t21_sweep and
-- t21_sweep_check.sql asserts the exact verdicts.
\set ON_ERROR_STOP on
SELECT test.logout() AS zz \gset

CREATE TABLE IF NOT EXISTS test.t21_sweep (verdict text, name text, status text, age_hours bigint, size_bytes bigint);
TRUNCATE test.t21_sweep;
GRANT ALL ON test.t21_sweep TO postgres;

CREATE OR REPLACE FUNCTION test.t21_sid(p_label text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'pimg-' || md5('t21-sweep-' || p_label) $$;

-- label, creator, org in the object path, status, session age, object age, completed?, path override
CREATE TEMP TABLE fx (label text, creator text, path_org text, status text, s_age interval, o_age interval, completed boolean, path text);
INSERT INTO fx VALUES
  ('expired-old',        'u-admin',   'org-test', 'EXPIRED',   '3 days',  '3 days',  false, NULL),
  ('canceled-old',       'u-admin',   'org-test', 'CANCELED',  '2 days',  '2 days',  false, NULL),
  ('pending-stale-old',  'u-admin',   'org-test', 'PENDING',   '26 hours','26 hours',false, NULL),
  ('org2-expired-old',   'u-admin-x', 'org-two',  'EXPIRED',   '5 days',  '5 days',  false, NULL),
  ('expired-recent',     'u-admin',   'org-test', 'EXPIRED',   '2 hours', '2 hours', false, NULL),
  ('expired-in-grace',   'u-admin',   'org-test', 'EXPIRED',   '23 hours','23 hours',false, NULL),
  ('object-recent',      'u-admin',   'org-test', 'EXPIRED',   '3 days',  '1 hour',  false, NULL),
  ('completed-old',      'u-admin',   'org-test', 'COMPLETED', '4 days',  '4 days',  true,  NULL),
  ('pending-live',       'u-admin',   'org-test', 'PENDING',   '2 minutes','1 minute',false, NULL),
  ('ref-product-old',    'u-admin',   'org-test', 'EXPIRED',   '3 days',  '3 days',  false, NULL),
  ('ref-logo-old',       'u-admin-x', 'org-two',  'CANCELED',  '3 days',  '3 days',  false, NULL),
  ('wrong-org-old',      'u-admin',   'org-two',  'EXPIRED',   '3 days',  '3 days',  false, NULL),
  ('legacy-temp-old',    'u-admin',   NULL,       'EXPIRED',   '3 days',  '3 days',  false, 'temp/' || test.t21_sid('legacy-temp-old')),
  ('bad-id-old',         'u-admin',   'org-test', 'EXPIRED',   '3 days',  '3 days',  false, 'org/org-test/temp/pimg-NOTHEX0000000000000000000000000'),
  ('subpath-old',        'u-admin',   'org-test', 'EXPIRED',   '3 days',  '3 days',  false, 'org/org-test/temp/' || test.t21_sid('subpath-old') || '/x.webp'),
  ('dup-path-old',       'u-admin',   'org-test', 'EXPIRED',   '3 days',  '3 days',  false, NULL);

INSERT INTO product_image_upload_sessions (id, token_hash, created_by, shop_id, product_id, storage_path, public_url, bytes, mime_type,
                                           status, created_at, expires_at, completed_at)
SELECT test.t21_sid(f.label), md5('t21-sweep-tok-' || f.label), f.creator, NULL, NULL,
       coalesce(f.path, 'org/' || f.path_org || '/temp/' || test.t21_sid(f.label)),
       CASE WHEN f.completed THEN 'https://pos.test/storage/v1/object/public/product-images/org/' || f.path_org || '/temp/' || test.t21_sid(f.label) END,
       CASE WHEN f.completed THEN 3000 END, CASE WHEN f.completed THEN 'image/webp' END,
       f.status, now() - f.s_age, now() - f.s_age + interval '10 minutes',
       CASE WHEN f.completed THEN now() - f.s_age + interval '1 minute' END
  FROM fx f;

INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, created_at)
SELECT 'product-images', coalesce(f.path, 'org/' || f.path_org || '/temp/' || test.t21_sid(f.label)), NULL, NULL,
       jsonb_build_object('size', 1000 + row_number() OVER (ORDER BY f.label), 'mimetype', 'image/jpeg'), now() - f.o_age
  FROM fx f;

-- 085 review: a SECOND (completed, URL-less) session row holding the same
-- path as the abandoned 'dup-path-old' session -> that object is "referenced"
INSERT INTO product_image_upload_sessions (id, token_hash, created_by, storage_path, status, created_at, expires_at, completed_at)
VALUES (test.t21_sid('dup-path-twin'), md5('t21-sweep-tok-dup-path-twin'), 'u-admin', 'org/org-test/temp/' || test.t21_sid('dup-path-old'),
        'COMPLETED', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes', now() - interval '3 days' + interval '1 minute');

-- an object at a session-shaped path WITHOUT any session row (never touched)
INSERT INTO storage.objects (bucket_id, name, metadata, created_at)
VALUES ('product-images', 'org/org-test/temp/' || test.t21_sid('no-session-old'), '{"size": 10, "mimetype": "image/jpeg"}', now() - interval '9 days');
-- the same session-shaped name in ANOTHER bucket (never touched)
INSERT INTO storage.buckets (id, name, public) VALUES ('t21-other', 't21-other', false) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name, metadata, created_at)
VALUES ('t21-other', 'org/org-test/temp/' || test.t21_sid('expired-old'), '{"size": 10, "mimetype": "image/jpeg"}', now() - interval '9 days');

-- references that keep an abandoned object alive (reported, never deleted)
UPDATE products SET image_url = 'https://pos.test/storage/v1/object/public/product-images/org/org-test/temp/' || test.t21_sid('ref-product-old')
 WHERE id = 'prod-3';
UPDATE business_profile SET logo_url = 'https://pos.test/storage/v1/object/public/product-images/org/org-two/temp/' || test.t21_sid('ref-logo-old')
 WHERE org_id = 'org-two';

SELECT test.setvar('t21_sweep_before', (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o));
SELECT test.setvar('t21_sessions_before', (SELECT count(*)::text || ':' || md5(coalesce(string_agg(s::text, E'\n' ORDER BY s.id), '')) FROM product_image_upload_sessions s));
SELECT 'INFO t21 sweep fixtures: ' || (SELECT count(*) FROM fx) || ' session objects + 1 without session + 1 in another bucket';
