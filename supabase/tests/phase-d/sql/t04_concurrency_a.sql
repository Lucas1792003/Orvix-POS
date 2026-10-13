-- Session A: executes the sale and HOLDS the transaction open for 3 s so
-- session B (same key) is forced to wait on the idempotency advisory lock.
-- Output (psql -At -q): exactly one line, the jsonb response.
\set ON_ERROR_STOP on
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
BEGIN;
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0,
  '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '33333333-0000-4000-8000-000000000001') AS r \gset
SELECT pg_sleep(3) AS zz \gset
COMMIT;
\echo :r
