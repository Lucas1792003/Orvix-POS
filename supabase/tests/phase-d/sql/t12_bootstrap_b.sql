-- t12 bootstrap, step 2b: session B (operator 2) starts 1 s after A, while
-- A's bootstrap is uncommitted. Without 076's lock both would see an empty
-- users table and both would create an organization + ADMIN. With it B
-- blocks on the advisory lock until A commits, re-checks, and is refused.
\set ON_ERROR_STOP on
SELECT test.login('a0000000-0000-4000-8000-0000000000b2') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t12/076 concurrent: the second simultaneous bootstrap_first_admin is refused after waiting for the first',
  $q$SELECT public.bootstrap_first_admin()$q$, 'SETUP_ALREADY_COMPLETED');
RESET ROLE;
