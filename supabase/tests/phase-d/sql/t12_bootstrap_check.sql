-- t12 bootstrap, step 3: outcome of the concurrent pair + sequential calls on
-- the now-populated install. Variables from run.sh: ra (session A's result),
-- bsecs (session B wall time in seconds).
\set ON_ERROR_STOP on
SELECT test.logout() AS zz \gset
SELECT test.check('t12/076 concurrent: session A created the first ADMIN',
  (:'ra'::jsonb->>'role') = 'ADMIN' AND (:'ra'::jsonb->>'userId') = 'user-first-owner-boot-test'
  AND (:'ra'::jsonb->>'email') = 'first.owner@boot.test' AND (:'ra'::jsonb->>'orgId') LIKE 'org-%',
  left(:'ra', 160));
SELECT test.check('t12/076 concurrent: session B waited on the lock (wall time >= 2 s)', :bsecs >= 2, 'B wall time ' || :bsecs || 's');
SELECT test.check('t12/076 concurrent: exactly one users row, an ADMIN, linked to operator A, in A''s new org',
  (SELECT count(*) FROM users) = 1
  AND (SELECT role = 'ADMIN' AND auth_id = 'a0000000-0000-4000-8000-0000000000b1' AND org_id = (:'ra'::jsonb->>'orgId')
         AND name = 'first owner' AND is_active FROM users),
  (SELECT string_agg(id || ':' || role || ':' || org_id, ',') FROM users));
SELECT test.check('t12/076 concurrent: exactly one new organization, with its business_profile row',
  (SELECT count(*) FROM organizations)::text = (test.var('t12_boot_orgs_before')::int + 1)::text
  AND (SELECT count(*) FROM business_profile)::text = (test.var('t12_boot_bp_before')::int + 1)::text
  AND EXISTS (SELECT 1 FROM business_profile WHERE org_id = (:'ra'::jsonb->>'orgId')),
  'orgs before=' || test.var('t12_boot_orgs_before') || ' after=' || (SELECT count(*) FROM organizations));

-- sequential calls on the populated install
SELECT test.login('a0000000-0000-4000-8000-0000000000b2') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/076 populated: operator B calling again later is refused',
  $q$SELECT public.bootstrap_first_admin()$q$, 'SETUP_ALREADY_COMPLETED');
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-0000000000b1') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/076 populated: the first ADMIN calling again is refused (no second org)',
  $q$SELECT public.bootstrap_first_admin()$q$, 'SETUP_ALREADY_COMPLETED');
-- positive control: the new ADMIN works through RLS in its own org
SELECT test.check('t12/076 populated: the new ADMIN sees exactly its own organization and business_profile',
  (SELECT count(*) FROM organizations) = 1 AND (SELECT id FROM organizations) = (:'ra'::jsonb->>'orgId')
  AND (SELECT count(*) FROM business_profile) = 1);
RESET ROLE;
SELECT test.check('t12/076 populated: still exactly one organization created and one users row',
  (SELECT count(*) FROM organizations)::text = (test.var('t12_boot_orgs_before')::int + 1)::text
  AND (SELECT count(*) FROM users) = 1);
SELECT test.logout() AS zz \gset
