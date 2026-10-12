-- t07: two cashiers on one shop with separate shifts, interleaved sales.
-- Running stock before this file: prod-1 = 100 -2 (t03) -1 (t04) +10 (t06) = 107
--                                   prod-2 = 50 +5 (t05) -5 (t06) = 50
\set ON_ERROR_STOP on

SELECT test.check('precondition: prod-1 = 107, prod-2 = 50',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-1') = 107
  AND (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-2') = 50);

-- A1 sells 3 x prod-1
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 3000, 0,
  '[{"product_id":"prod-1","qty":3}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000001') AS m1 \gset
RESET ROLE;

-- A2 sells 4 x prod-1
SELECT test.login('a0000000-0000-4000-8000-000000000004') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a2'), 'CASH', 4000, 0,
  '[{"product_id":"prod-1","qty":4}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000002') AS m2 \gset
SELECT test.expect_error('A2 cannot sell on A1''s shift',
  $q$SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 1000, 0,
    '[{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000099')$q$, 'No open shift for this cashier');
RESET ROLE;

-- A1 sells 1 x prod-2 (OTHER payment)
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'OTHER', 2000, 0,
  '[{"product_id":"prod-2","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000003') AS m3 \gset
RESET ROLE;

-- A2 sells 2 x prod-2 + 1 x prod-1 with 10% cart discount
SELECT test.login('a0000000-0000-4000-8000-000000000004') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a2'), 'CASH', 5000, 10,
  '[{"product_id":"prod-2","qty":2},{"product_id":"prod-1","qty":1}]'::jsonb, NULL, '66666666-0000-4000-8000-000000000004') AS m4 \gset
SELECT test.check('cart discount computed server-side: total 4500, change 500',
  (:'m4'::jsonb->'sale'->>'totalMmk')::int = 4500 AND (:'m4'::jsonb->'sale'->>'changeMmk')::int = 500);
RESET ROLE;

SELECT test.check('inventory arithmetic exact: prod-1 = 107-3-4-1 = 99',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-1') = 99);
SELECT test.check('inventory arithmetic exact: prod-2 = 50-1-2 = 47',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-2') = 47);
SELECT test.check('sales attributed to the right cashier/shift',
  (SELECT count(*) FROM sales WHERE shift_id = test.var('shift_a1') AND cashier_id = 'u-cash-a1') = 5
  AND (SELECT count(*) FROM sales WHERE shift_id = test.var('shift_a2') AND cashier_id = 'u-cash-a2') = 2);
SELECT test.check('receipt numbers unique and contiguous 0001..0007 for shop A today',
  (SELECT array_agg(right(receipt_no, 4) ORDER BY receipt_no) FROM sales WHERE shop_id = 'shop-a')
  = ARRAY['0001','0002','0003','0004','0005','0006','0007']);
SELECT test.check('7 sales, 8 sale_items, 8 SALE_OUT movements in shop A',
  (SELECT count(*) FROM sales WHERE shop_id = 'shop-a') = 7
  AND (SELECT count(*) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.shop_id = 'shop-a') = 8
  AND (SELECT count(*) FROM inventory_movements WHERE shop_id = 'shop-a' AND type = 'SALE_OUT') = 8);
SELECT test.logout() AS zz \gset
