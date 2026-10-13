-- t08: ledger consistency across everything that ran, then close_shift replay.
\set ON_ERROR_STOP on
\set kc1 '77777777-0000-4000-8000-000000000001'
\set kc2 '77777777-0000-4000-8000-000000000002'

-- initial + sum(movements) = current, for EVERY inventory row (both shops)
SELECT test.check('inventory consistency: initial + sum(movements) = qty for every row',
  NOT EXISTS (
    SELECT 1
      FROM inventory i
      JOIN test.initial_inventory ii ON ii.shop_id = i.shop_id AND ii.product_id = i.product_id
      LEFT JOIN inventory_movements m ON m.shop_id = i.shop_id AND m.product_id = i.product_id
     GROUP BY i.shop_id, i.product_id, i.qty_base_units, ii.qty
    HAVING i.qty_base_units <> ii.qty + COALESCE(sum(m.qty_change), 0)),
  (SELECT string_agg(shop_id || '/' || product_id || '=' || qty_base_units, ', ') FROM inventory));
SELECT test.check('every movement satisfies qty_after - qty_before = qty_change',
  NOT EXISTS (SELECT 1 FROM inventory_movements WHERE qty_after - qty_before <> qty_change));
SELECT test.check('movement chain is gapless per shop/product (each qty_before = previous qty_after)',
  NOT EXISTS (
    SELECT 1 FROM (
      SELECT qty_before, lag(qty_after) OVER (PARTITION BY shop_id, product_id ORDER BY created_at, id) AS prev_after
        FROM inventory_movements) x
     WHERE prev_after IS NOT NULL AND qty_before <> prev_after));
SELECT test.check('every sale has >= 1 sale_item and a SALE_COMPLETED audit row',
  NOT EXISTS (SELECT 1 FROM sales s WHERE s.shop_id = 'shop-a' AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id))
  AND (SELECT count(*) FROM audit_logs WHERE action_type = 'SALE_COMPLETED') = (SELECT count(*) FROM sales WHERE shop_id = 'shop-a'));
SELECT test.check('every committed idempotency row has a stored response',
  (SELECT count(*) FROM idempotency_keys WHERE response IS NULL) = 0
  AND (SELECT count(*) FROM idempotency_keys) >= 24,
  'rows=' || (SELECT count(*) FROM idempotency_keys));
SELECT test.check('idempotency rows reference the RPC that created them',
  (SELECT count(DISTINCT rpc) FROM idempotency_keys) >= 15);

-- close_shift (cashier A1): closing cash = expected -> no variance reason needed
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT 5000 + COALESCE(sum(total_mmk), 0) AS expected_cash
  FROM sales WHERE shift_id = test.var('shift_a1') AND payment_method = 'CASH' AND status <> 'VOID' \gset
SELECT public.close_shift(test.var('shift_a1'), :expected_cash, NULL, NULL, 'u-cash-a1', :'kc1') AS c1 \gset
SELECT public.close_shift(test.var('shift_a1'), :expected_cash, NULL, NULL, 'u-cash-a1', :'kc1') AS c2 \gset
SELECT test.check('close_shift replay -> identical response (no "already closed" error)', :'c1'::jsonb = :'c2'::jsonb);
SELECT test.check('close_shift: variance 0, endedAt set',
  (:'c1'::jsonb->'shift'->>'varianceMmk')::int = 0 AND (:'c1'::jsonb->'shift'->>'endedAt') IS NOT NULL);
SELECT test.expect_error('close_shift with a NEW key on a closed shift -> state guard fires',
  format($q$SELECT public.close_shift(test.var('shift_a1'), %s, NULL, NULL, 'u-cash-a1', %L)$q$, :expected_cash, :'kc2'),
  'already closed');
RESET ROLE;
SELECT test.check('DB: shift A1 closed exactly once, one SHIFT_CLOSED audit row',
  (SELECT ended_at IS NOT NULL FROM shifts WHERE id = test.var('shift_a1'))
  AND (SELECT count(*) FROM audit_logs WHERE entity_id = test.var('shift_a1') AND action_type = 'SHIFT_CLOSED') = 1);
SELECT test.check('DB: shift A2 still open', (SELECT ended_at IS NULL FROM shifts WHERE id = test.var('shift_a2')));

SET ROLE service_role;
SELECT test.check('prune_idempotency_keys removes nothing younger than 30 days', public.prune_idempotency_keys() = 0);
RESET ROLE;
SELECT test.logout() AS zz \gset
