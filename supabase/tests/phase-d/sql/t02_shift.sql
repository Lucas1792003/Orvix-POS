-- t02: open_shift replay returns the SAME shift; state guard still fires for a
-- new key; two cashiers get separate shifts on one shop.
\set ON_ERROR_STOP on
\set k1 '11111111-0000-4000-8000-000000000001'
\set k2 '11111111-0000-4000-8000-000000000002'
\set k3 '11111111-0000-4000-8000-000000000003'

SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT public.open_shift('shop-a', 5000, NULL, NULL, :'k1') AS r1 \gset
SELECT public.open_shift('shop-a', 5000, NULL, NULL, :'k1') AS r2 \gset
SELECT test.check('open_shift replay returns an identical response', :'r1'::jsonb = :'r2'::jsonb);
SELECT test.check('open_shift replay returns the same shift id',
  (:'r1'::jsonb->'shift'->>'id') = (:'r2'::jsonb->'shift'->>'id') AND (:'r1'::jsonb->'shift'->>'id') LIKE 'shift-%');
SELECT test.setvar('shift_a1', :'r1'::jsonb->'shift'->>'id') AS zz \gset
SELECT test.expect_error('open_shift with a NEW key while a shift is open -> state guard still fires',
  format($q$SELECT public.open_shift('shop-a', 5000, NULL, NULL, %L)$q$, :'k2'), 'already has an open shift');
RESET ROLE;
SELECT test.check('exactly one open shift for cashier A1',
  (SELECT count(*) FROM shifts WHERE cashier_id = 'u-cash-a1' AND ended_at IS NULL) = 1);
SELECT test.check('exactly one SHIFT_OPENED audit row for cashier A1',
  (SELECT count(*) FROM audit_logs WHERE actor_id = 'u-cash-a1' AND action_type = 'SHIFT_OPENED') = 1);
SELECT test.check('idempotency row for open_shift stores actor + rpc',
  (SELECT rpc = 'open_shift' AND actor_id = 'u-cash-a1' AND response IS NOT NULL FROM idempotency_keys WHERE key = :'k1'));

-- second terminal: cashier A2
SELECT test.login('a0000000-0000-4000-8000-000000000004') AS zz \gset
SET ROLE authenticated;
SELECT public.open_shift('shop-a', 3000, NULL, NULL, :'k3') AS r3 \gset
SELECT test.setvar('shift_a2', :'r3'::jsonb->'shift'->>'id') AS zz \gset
SELECT test.check('cashier A2 opened a separate shift on the same shop',
  (:'r3'::jsonb->'shift'->>'id') <> test.var('shift_a1') AND (:'r3'::jsonb->'shift'->>'cashierId') = 'u-cash-a2');
RESET ROLE;
SELECT test.check('two open shifts on shop A (one per cashier)',
  (SELECT count(*) FROM shifts WHERE shop_id = 'shop-a' AND ended_at IS NULL) = 2);
SELECT test.logout() AS zz \gset
