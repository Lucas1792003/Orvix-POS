-- t22 part B: after run.sh's 085 guard cycles (drift abort, 083-missing
-- abort, 085 on the production 083 state WITHOUT 084, 084 on top of 085,
-- 085 re-run on 083+084): the final state is the 085 state and no session
-- or object row changed across all of it.
\set ON_ERROR_STOP on
\set SIG 'public.complete_product_image_upload_session(text,text,text,integer,text)'
SELECT test.logout() AS zz \gset

SELECT test.check('t22/085 final: body is the 085 body, grants service_role only, comment 083:..085:',
  (SELECT md5(prosrc) = 'dc822a6435c3e512acdc933c4a2995a8' AND prosecdef AND pg_get_userbyid(proowner) = 'postgres'
     FROM pg_proc WHERE oid = :'SIG'::regprocedure)
  AND NOT has_function_privilege('anon', :'SIG', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', :'SIG', 'EXECUTE')
  AND has_function_privilege('service_role', :'SIG', 'EXECUTE')
  AND obj_description(:'SIG'::regprocedure, 'pg_proc') LIKE '083:%085:%');
SELECT test.check('t22/085 final: 084 is in place again (staff write policies gone; read + delete kept)',
  test.m084()
  AND (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects') = 'product_images_delete,product_images_read');
SELECT test.check('t22/085 guard: no product_image_upload_sessions or storage.objects row changed across every 085 / 080 / 083 / 078 / 084 run (whole-row digests)',
  (SELECT count(*)::text || ':' || md5(coalesce(string_agg(s::text, E'\n' ORDER BY s.id), '')) FROM product_image_upload_sessions s)
  || '/' || (SELECT count(*)::text || ':' || md5(coalesce(string_agg(o::text, E'\n' ORDER BY o.id), '')) FROM storage.objects o)
  = test.var('t22_rows_a'));
