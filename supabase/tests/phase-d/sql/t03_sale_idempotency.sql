-- t03: checkout; same key twice; same key different payload; same key
-- different RPC; failing txn rolls the key back so a retry executes.
\set ON_ERROR_STOP on
\set ks1 '22222222-0000-4000-8000-000000000001'
\set kf  '22222222-0000-4000-8000-000000000009'
\set kadj '22222222-0000-4000-8000-000000000010'

SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;

-- normal checkout
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 2000, 0,
  '[{"product_id":"prod-1","qty":2}]'::jsonb, NULL, :'ks1') AS s1 \gset
SELECT test.check('checkout returns sale id + shop-coded receipt',
  (:'s1'::jsonb->'sale'->>'id') LIKE 'sale-%' AND (:'s1'::jsonb->'sale'->>'receiptNo') LIKE 'SA-%-0001');
SELECT test.check('checkout total 2000, change 0',
  (:'s1'::jsonb->'sale'->>'totalMmk')::int = 2000 AND (:'s1'::jsonb->'sale'->>'changeMmk')::int = 0);
SELECT test.check('checkout response carries 1 item, 1 movement, inventory 98',
  jsonb_array_length(:'s1'::jsonb->'items') = 1 AND jsonb_array_length(:'s1'::jsonb->'movements') = 1
  AND (:'s1'::jsonb->'inventory'->0->>'qtyBaseUnits')::int = 98);
SELECT test.setvar('sale1', :'s1'::jsonb->'sale'->>'id') AS zz \gset

-- commit-then-timeout: client discards the result and sends again
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 2000, 0,
  '[{"product_id":"prod-1","qty":2}]'::jsonb, NULL, :'ks1') AS s2 \gset
SELECT test.check('same key twice -> identical response (byte-equal jsonb)', :'s1'::jsonb = :'s2'::jsonb);

-- same key, key order of the item JSON shuffled + a different client timestamp:
-- still the same request (jsonb canonicalises, p_created_at is excluded)
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 2000, 0,
  '[{"qty":2,"product_id":"prod-1"}]'::jsonb, now() - interval '1 minute', :'ks1') AS s2b \gset
SELECT test.check('same key, reordered JSON + different p_created_at -> still a replay', :'s1'::jsonb = :'s2b'::jsonb);

SELECT test.expect_error('same key, different payload -> IDEMPOTENCY_MISMATCH',
  format($q$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 3000, 0,
    '[{"product_id":"prod-1","qty":2}]'::jsonb, NULL, %L)$q$, :'ks1'), 'IDEMPOTENCY_MISMATCH');
SELECT test.expect_error('same key, different RPC -> IDEMPOTENCY_MISMATCH',
  format($q$SELECT public.log_receipt_reprint(test.var('sale1'), %L)$q$, :'ks1'), 'IDEMPOTENCY_MISMATCH');
RESET ROLE;

SELECT test.check('exactly one sale in shop A after replay + mismatch attempts',
  (SELECT count(*) FROM sales WHERE shop_id = 'shop-a') = 1);
SELECT test.check('exactly one SALE_OUT movement for the sale',
  (SELECT count(*) FROM inventory_movements WHERE reference_id = test.var('sale1')) = 1);
SELECT test.check('exactly one SALE_COMPLETED audit row',
  (SELECT count(*) FROM audit_logs WHERE entity_id = test.var('sale1') AND action_type = 'SALE_COMPLETED') = 1);
SELECT test.check('stock unchanged by replays: prod-1 = 98',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-1') = 98);
SELECT test.check('idempotency row stores the exact response',
  (SELECT response FROM idempotency_keys WHERE key = :'ks1') = :'s1'::jsonb);

-- ---- failing transaction: key must roll back ----
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('insufficient stock -> RPC raises (cashier has no pos:override_stock)',
  format($q$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 75000, 0,
    '[{"product_id":"prod-3","qty":25}]'::jsonb, NULL, %L)$q$, :'kf'), 'Insufficient stock');
RESET ROLE;
SELECT test.check('failed txn left NO idempotency row', (SELECT count(*) FROM idempotency_keys WHERE key = :'kf') = 0);
SELECT test.check('failed txn left no sale', (SELECT count(*) FROM sales WHERE shop_id = 'shop-a') = 1);
SELECT test.check('failed txn left prod-3 at 20',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-3') = 20);

-- manager restocks (its own key), then the cashier retries with the SAME key
SELECT test.login('a0000000-0000-4000-8000-000000000002') AS zz \gset
SET ROLE authenticated;
SELECT public.adjust_stock('shop-a', 'prod-3', 'PURCHASE_IN', 10, 'restock for test', NULL, NULL, NULL, NULL, :'kadj') AS adj \gset
SELECT test.check('manager restock: prod-3 -> 30', (:'adj'::jsonb->'inventory'->>'qtyBaseUnits')::int = 30);
RESET ROLE;

SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 75000, 0,
  '[{"product_id":"prod-3","qty":25}]'::jsonb, NULL, :'kf') AS s3 \gset
SELECT test.check('retry with the rolled-back key EXECUTES (new sale, not a replay, not a mismatch)',
  (:'s3'::jsonb->'sale'->>'id') LIKE 'sale-%' AND (:'s3'::jsonb->'sale'->>'id') <> test.var('sale1')
  AND (:'s3'::jsonb->'sale'->>'receiptNo') LIKE 'SA-%-0002');
RESET ROLE;
SELECT test.check('retry: prod-3 = 5', (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-3') = 5);
SELECT test.check('retry: two sales in shop A', (SELECT count(*) FROM sales WHERE shop_id = 'shop-a') = 2);
SELECT test.check('retry: idempotency row now exists with response',
  (SELECT count(*) FROM idempotency_keys WHERE key = :'kf' AND response IS NOT NULL) = 1);
SELECT test.logout() AS zz \gset
