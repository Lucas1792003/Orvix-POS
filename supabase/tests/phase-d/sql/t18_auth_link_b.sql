-- t18 part B: run.sh re-applied 082 to the populated database between part A
-- and this file (the migration's own DO block also asserts it changed no
-- users row). Every users row - seeded, t09-t17 and t18's own - must be
-- byte-identical, and every login link exactly as before.
\set ON_ERROR_STOP on
SELECT test.logout() AS zz \gset
SELECT test.check('t18 re-applying 082 to a populated database leaves every users row unchanged (whole-row digest)',
  (SELECT md5(string_agg(u::text, E'\n' ORDER BY u.id)) FROM users u) = test.var('t18_users_digest_b')
  AND (SELECT count(*)::text FROM users) = test.var('t18_users_count_b'),
  'rows now ' || (SELECT count(*) FROM users) || ', before ' || test.var('t18_users_count_b'));
SELECT test.check('t18 existing links (pre-t18 rows) identical after the re-apply',
  (SELECT md5(string_agg(u.id || '=' || COALESCE(u.auth_id::text, '-'), ',' ORDER BY u.id)) FROM users u WHERE u.id NOT LIKE 'u-t18-%')
  = test.var('t18_links_digest'));
SELECT test.check('t18 still exactly one users_guard_auth_id trigger after the re-apply',
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'users_guard_auth_id') = 1);
