-- t12 bootstrap, step 2a: session A (operator 1) calls bootstrap_first_admin
-- on the empty install and holds its transaction open 3 s before COMMIT.
-- Prints the RPC result as its last line.
\set ON_ERROR_STOP on
SELECT test.login('a0000000-0000-4000-8000-0000000000b1') AS zz \gset
SET ROLE authenticated;
BEGIN;
SELECT public.bootstrap_first_admin() AS ra \gset
SELECT pg_sleep(3);
COMMIT;
RESET ROLE;
SELECT :'ra';
