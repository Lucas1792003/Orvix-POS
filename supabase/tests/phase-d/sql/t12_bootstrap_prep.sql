-- t12 bootstrap, step 1 of 4 (superuser). Runs LAST in run.sh, after every
-- other test, and only when 076 is applied: it EMPTIES public.users
-- (TRUNCATE ... CASCADE also empties the two tables with a users FK:
-- product_image_upload_sessions, supplier_payments) so this throwaway
-- database becomes a "fresh install" for the concurrent-bootstrap proof.
-- Organizations and everything else stay; test.results is untouched.
-- (A separate scratch database is not practical here: CREATE DATABASE ...
-- TEMPLATE postgres is refused while pg_cron / pg_net workers are connected
-- to it, and the auth/storage/extension shims live only in `postgres`.)
\set ON_ERROR_STOP on
\set BA   'a0000000-0000-4000-8000-0000000000b1'
\set BB   'a0000000-0000-4000-8000-0000000000b2'
\set BO   'a0000000-0000-4000-8000-0000000000b3'
SELECT test.logout() AS zz \gset

TRUNCATE public.users CASCADE;
INSERT INTO auth.users (id, email) VALUES
  (:'BA', 'First.Owner@Boot.test'), (:'BB', 'second-owner@boot.test'), (:'BO', 'orphan@boot.test');
SELECT test.setvar('t12_boot_orgs_before', (SELECT count(*)::text FROM organizations));
SELECT test.setvar('t12_boot_bp_before', (SELECT count(*)::text FROM business_profile));

SELECT test.check('t12/076 empty install: app_setup_needed() is true after emptying users', public.app_setup_needed());

-- The RLS hatch is closed even on an EMPTY install: direct inserts are refused.
SELECT test.login(:'BO') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/076 empty install: direct INSERT organizations is refused (RPC is the only path)',
  $q$INSERT INTO organizations (id, name) VALUES ('org-boot-direct', 'Direct')$q$, 'row-level security');
SELECT test.expect_error('t12/076 empty install: direct self-INSERT as ADMIN into users is refused',
  $q$INSERT INTO users (id, name, email, role, org_id, auth_id)
     VALUES ('user-direct', 'Direct', 'orphan@boot.test', 'ADMIN', 'org-test', 'a0000000-0000-4000-8000-0000000000b3')$q$,
  'row-level security');
RESET ROLE;
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.expect_error('t12/076 empty install: anon cannot execute bootstrap_first_admin',
  $q$SELECT public.bootstrap_first_admin()$q$, 'permission denied');
RESET ROLE;
SELECT test.check('t12/076 empty install: still empty after the refused direct inserts',
  public.app_setup_needed() AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = 'org-boot-direct'));
