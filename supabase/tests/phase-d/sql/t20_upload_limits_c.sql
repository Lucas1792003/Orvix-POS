-- t20 part C: run.sh re-applied 083 to the clean, populated bucket (from the
-- production pre-083 state NULL / NULL). It must have set the limits, kept the
-- bucket public, changed no object row, and left the grants as in part A.
\set ON_ERROR_STOP on
SELECT test.logout() AS zz \gset
SELECT test.check('t20/083 re-apply: limits set from the NULL / NULL state; bucket still public',
  (SELECT public AND allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'] AND file_size_limit = 5242880
     FROM storage.buckets WHERE id = 'product-images'));
SELECT test.check('t20/083 re-apply: no storage.objects row changed (whole-row digest)',
  (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o)
  = test.var('t20_objects_b'));
SELECT test.check('t20/083 re-apply: completion still service_role-only',
  NOT has_function_privilege('anon', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE'));
