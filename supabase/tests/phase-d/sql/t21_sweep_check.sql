-- t21 sweep, part 2: the deployment's REAL candidate query (SWEEP_SQL,
-- sweep-abandoned-uploads.sql, grace 24 h) was run by run.sh and its output
-- loaded into test.t21_sweep. Exact verdicts; nothing was written.
\set ON_ERROR_STOP on
SELECT test.logout() AS zz \gset

SELECT test.check('t21 sweep: exactly the 4 abandoned uploads (EXPIRED, CANCELED, stale PENDING; both orgs) are "delete"',
  (SELECT string_agg(name, ',' ORDER BY name) FROM test.t21_sweep WHERE verdict = 'delete')
  = (SELECT string_agg(n, ',' ORDER BY n) FROM (VALUES
       ('org/org-test/temp/' || test.t21_sid('expired-old')),
       ('org/org-test/temp/' || test.t21_sid('canceled-old')),
       ('org/org-test/temp/' || test.t21_sid('pending-stale-old')),
       ('org/org-two/temp/' || test.t21_sid('org2-expired-old'))) v(n)),
  (SELECT count(*) FROM test.t21_sweep WHERE verdict = 'delete') || ' delete rows');
SELECT test.check('t21 sweep: abandoned objects referenced by products.image_url / business_profile.logo_url, or whose path another (completed) session also holds, are "referenced" (kept, reported)',
  (SELECT string_agg(name, ',' ORDER BY name) FROM test.t21_sweep WHERE verdict = 'referenced')
  = (SELECT string_agg(n, ',' ORDER BY n) FROM (VALUES
       ('org/org-test/temp/' || test.t21_sid('ref-product-old')),
       ('org/org-two/temp/' || test.t21_sid('ref-logo-old')),
       ('org/org-test/temp/' || test.t21_sid('dup-path-old'))) v(n)));
SELECT test.check('t21 sweep: no other verdict, and the statuses / sizes come from the session and the object',
  NOT EXISTS (SELECT 1 FROM test.t21_sweep WHERE verdict NOT IN ('delete', 'referenced'))
  AND (SELECT string_agg(status, ',' ORDER BY name) FROM test.t21_sweep WHERE verdict = 'delete') IS NOT NULL
  AND (SELECT bool_and(size_bytes > 1000 AND age_hours >= 24) FROM test.t21_sweep));
SELECT test.check('t21 sweep: never a candidate - completed, live, inside the grace period (session or object), wrong org segment, legacy temp/, bad id, sub-path, no session row',
  NOT EXISTS (SELECT 1 FROM test.t21_sweep
               WHERE name LIKE ANY (ARRAY[
                 '%' || test.t21_sid('completed-old'), '%' || test.t21_sid('pending-live'),
                 '%' || test.t21_sid('expired-recent'), '%' || test.t21_sid('expired-in-grace'),
                 '%' || test.t21_sid('object-recent'), '%' || test.t21_sid('wrong-org-old'),
                 'temp/%', '%NOTHEX%', '%/x.webp', '%' || test.t21_sid('no-session-old')])));
SELECT test.check('t21 sweep: no legacy object (temp/<id>, products/<id>/..., products/brand/...) and no object of another bucket can ever be listed',
  NOT EXISTS (SELECT 1 FROM test.t21_sweep WHERE name !~ '^org/[A-Za-z0-9_-]+/temp/pimg-[0-9a-f]{32}$')
  AND (SELECT count(*) FROM test.t21_sweep) = 7);
SELECT test.check('t21 sweep: the query wrote nothing (storage.objects and sessions digests unchanged)',
  (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o) = test.var('t21_sweep_before')
  AND (SELECT count(*)::text || ':' || md5(coalesce(string_agg(s::text, E'\n' ORDER BY s.id), '')) FROM product_image_upload_sessions s) = test.var('t21_sessions_before'));
