-- Session B: started ~1 s after A with the SAME key and payload. Blocks in
-- idem_begin() until A commits, then must replay A's response.
\set ON_ERROR_STOP on
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0,
  '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '33333333-0000-4000-8000-000000000001') AS r \gset
\echo :r
