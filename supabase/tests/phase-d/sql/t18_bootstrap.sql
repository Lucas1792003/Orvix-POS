-- t18 bootstrap: runs after t12_bootstrap_check (082 applied). First-time
-- setup through bootstrap_first_admin() (076) still links the operator's own
-- auth account, and the new ADMIN cannot re-link it directly afterwards.
\set ON_ERROR_STOP on
\set BA 'a0000000-0000-4000-8000-0000000000b1'
\set BO 'a0000000-0000-4000-8000-0000000000b3'
SELECT test.logout() AS zz \gset
SELECT test.check('t18 bootstrap with 082: the first ADMIN row is linked to the operator''s own auth account',
  (SELECT count(*) FROM users WHERE role = 'ADMIN' AND auth_id = :'BA') = 1
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'users_guard_auth_id'));
SELECT test.login(:'BA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t18 bootstrap with 082: the new ADMIN cannot re-link its row to another account directly',
  format($q$UPDATE users SET auth_id = %L WHERE auth_id = %L$q$, :'BO', :'BA'), 'AUTH_ID_READ_ONLY');
RESET ROLE;
SELECT test.logout() AS zz \gset
