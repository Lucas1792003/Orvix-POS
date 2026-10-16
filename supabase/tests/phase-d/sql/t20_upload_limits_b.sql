-- t20 part B: run.sh re-applied 083 to a bucket holding 4 violating objects
-- (part A) and the apply MUST have aborted. Nothing may have changed: the
-- bucket is still at the pre-083 NULL limits and every object row is
-- byte-identical. Then the violators are removed so part C can re-apply 083
-- successfully (exactly what an operator does after reading the abort).
\set ON_ERROR_STOP on
SELECT test.logout() AS zz \gset
SELECT test.check('t20 guard: the aborted re-apply left the bucket untouched (still NULL / NULL)',
  (SELECT allowed_mime_types IS NULL AND file_size_limit IS NULL FROM storage.buckets WHERE id = 'product-images'));
SELECT test.check('t20 guard: the aborted re-apply changed no storage.objects row (whole-row digest)',
  (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o)
  = test.var('t20_objects_a'));
DELETE FROM storage.objects WHERE bucket_id = 'product-images' AND test.t20_bad(metadata);
SELECT test.setvar('t20_objects_b', (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o));
SELECT test.check('t20 guard: violators removed; no product-images object breaks the new rules',
  NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'product-images' AND test.t20_bad(metadata)));
