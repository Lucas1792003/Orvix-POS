-- Step 4 financial completion (PFIN-D payments / cash, PFIN-E refund lines). Synthetic data only. Runs after the
-- financial provisionals and BEFORE Recovery V1 (business behaviour), as the real API roles.
\set ON_ERROR_STOP on
SELECT test.logout();
-- ---------------------------------------------------------------- single payment (every existing path)
SELECT test.login('a0000000-0000-4000-8000-000000000003');   -- cashier A1, shop-a, shift_a1
SET ROLE authenticated;
SELECT public.complete_sale('shop-a', test.var('shift_a1'), 'CASH', 5000, 0, '[{"product_id":"prod-1","qty":2}]'::jsonb, NULL, '77777777-0000-4000-8000-000000000001') AS s1 \gset
RESET ROLE;
SELECT test.check('p01 single cash sale: one synthesized CASH payment of the total (change excluded)',
  (SELECT count(*) = 1 AND min(method) = 'CASH' AND sum(amount_mmk) = 2000 AND min(tendered_mmk) = 5000 AND min(source) = 'single'
     FROM sale_payments WHERE sale_id = :'s1'::jsonb->'sale'->>'id'));
-- ---------------------------------------------------------------- split / mixed payments (cashier A2, shift_a2: closed at the end)
SELECT test.login('a0000000-0000-4000-8000-000000000004');

SET ROLE authenticated;
SELECT public.fin_complete_sale_split('direct', '77777777-0000-4000-8000-000000000002',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','CASH','p_paid_mmk',5000,
    'p_cart_discount_pct',0,'p_items','[{"product_id":"prod-2","qty":2}]'::jsonb,'p_idempotency_key','77777777-0000-4000-8000-000000000002'),
  '[{"method":"CASH","amountMmk":3000,"tenderedMmk":4000},{"method":"BANK_TRANSFER","amountMmk":1000,"reference":"TRX-1"}]') AS s2 \gset
RESET ROLE;
SELECT :'s2'::jsonb->'sale'->>'id' AS s2_id \gset
SELECT test.check('p02 split sale: CASH 3000 (tendered 4000) + BANK_TRANSFER 1000 = total 4000; change 1000; sale recorded as CASH',
  (SELECT count(*) = 2 AND sum(amount_mmk) = 4000 AND bool_and(source = 'split') FROM sale_payments WHERE sale_id = :'s2_id')
  AND (SELECT payment_method = 'CASH' AND paid_mmk = 5000 AND change_mmk = 1000 AND total_mmk = 4000 FROM sales WHERE id = :'s2_id'));
SET ROLE authenticated;
SELECT test.expect_error('p03 over-allocation refused (payments exceed the total)', $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000003',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','OTHER','p_paid_mmk',2500,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-2","qty":1}]'::jsonb), '[{"method":"CARD","amountMmk":1500},{"method":"MOBILE_WALLET","amountMmk":1000}]')$q$, 'FIN_PAYMENTS_TOTAL');
SELECT test.expect_error('p04 under-allocation refused (payments below the total)', $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000004',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','OTHER','p_paid_mmk',1500,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-2","qty":1}]'::jsonb), '[{"method":"CARD","amountMmk":500},{"method":"MOBILE_WALLET","amountMmk":1000}]')$q$, 'less than the sale total');
SELECT test.expect_error('p05 a non-cash payment cannot be over-tendered', $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000005',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','OTHER','p_paid_mmk',3000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-2","qty":1}]'::jsonb), '[{"method":"CARD","amountMmk":2000,"tenderedMmk":3000}]')$q$, 'FIN_PAYMENTS_INVALID');
SELECT test.expect_error('p06 a repeated method is refused', $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000006',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','OTHER','p_paid_mmk',2000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-2","qty":1}]'::jsonb), '[{"method":"CARD","amountMmk":1000},{"method":"CARD","amountMmk":1000}]')$q$, 'more than once');
SELECT test.expect_error('p07 an unsupported method is refused', $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000007',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','OTHER','p_paid_mmk',2000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-2","qty":1}]'::jsonb), '[{"method":"BITCOIN","amountMmk":2000}]')$q$, 'unsupported payment method');
SELECT test.expect_error('p08 sale arguments that contradict the payment list are refused', $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000008',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','CASH','p_paid_mmk',2000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-2","qty":1}]'::jsonb), '[{"method":"CARD","amountMmk":2000}]')$q$, 'must match the payment list');
SELECT test.expect_error('p09 fractional money refused', $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000009',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','OTHER','p_paid_mmk',2000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-2","qty":1}]'::jsonb), '[{"method":"CARD","amountMmk":1999.5},{"method":"OTHER","amountMmk":0.5}]')$q$, 'whole MMK');
-- the same key: same split replays the original sale; a different split is refused
SELECT public.fin_complete_sale_split('direct', '77777777-0000-4000-8000-000000000002',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','CASH','p_paid_mmk',5000,
    'p_cart_discount_pct',0,'p_items','[{"product_id":"prod-2","qty":2}]'::jsonb,'p_idempotency_key','77777777-0000-4000-8000-000000000002'),
  '[{"method":"BANK_TRANSFER","amountMmk":1000,"reference":"TRX-1"},{"method":"CASH","amountMmk":3000,"tenderedMmk":4000}]') AS s2b \gset
SELECT test.expect_error('p11 the same key with a different split is refused (never silently accepted)', $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000002',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a2'),'p_payment_method','CASH','p_paid_mmk',5000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-2","qty":2}]'::jsonb), '[{"method":"CASH","amountMmk":2000,"tenderedMmk":3000},{"method":"CARD","amountMmk":2000}]')$q$, 'FIN_PAYMENTS_MISMATCH');
RESET ROLE;
SELECT test.check('p10 duplicate resend of the same split (any order) replays: same sale, no new rows',
  :'s2b'::jsonb->'sale'->>'id' = :'s2_id' AND (SELECT count(*) = 2 FROM sale_payments WHERE sale_id = :'s2_id')
  AND (SELECT count(*) FROM sales WHERE shift_id = test.var('shift_a2') AND id = :'s2_id') = 1);
SELECT test.expect_error('p12 payment rows are immutable', $$UPDATE sale_payments SET amount_mmk = 1 WHERE sale_id = (SELECT min(sale_id) FROM sale_payments)$$, 'FIN_RECORD_IMMUTABLE');
SET ROLE authenticated;
SELECT test.expect_error('p13 API roles cannot write payment rows directly', $$INSERT INTO sale_payments (id) VALUES ('x')$$, 'permission denied');
RESET ROLE;
-- ---------------------------------------------------------------- cash movements
SELECT (public.fin_shift_cash(test.var('shift_a2'))->>'expectedCashMmk')::int AS exp0 \gset
SET ROLE authenticated;
SELECT public.fin_record_cash_movement(test.var('shift_a2'), 'PAY_IN', 10000, 'Additional float from safe', NULL, NULL, '77777777-0000-4000-8000-000000000021') AS cm1 \gset
SELECT test.expect_error('c02 a cashier cannot take cash out (manager only by default, P-8)', $q$SELECT public.fin_record_cash_movement(test.var('shift_a2'),'PAY_OUT',100,'Petty cash',NULL,NULL,'77777777-0000-4000-8000-000000000022')$q$, 'Only a manager');
SELECT test.expect_error('c03 a reason is required', $q$SELECT public.fin_record_cash_movement(test.var('shift_a2'),'PAY_IN',100,'',NULL,NULL,'77777777-0000-4000-8000-000000000023')$q$, 'reason of 3 to 300');
SELECT public.fin_record_cash_movement(test.var('shift_a2'), 'PAY_IN', 10000, 'Additional float from safe', NULL, NULL, '77777777-0000-4000-8000-000000000021') AS cm1b \gset
RESET ROLE;
SELECT test.check('c01 cashier PAY_IN on own shift recorded, audited', :'cm1'::jsonb->'movement'->>'kind' = 'PAY_IN'
  AND EXISTS (SELECT 1 FROM audit_logs WHERE action_type = 'CASH_MOVEMENT' AND entity_id = test.var('shift_a2')));
SELECT test.check('c04 duplicate request (same key) replays: one movement', :'cm1b'::jsonb = :'cm1'::jsonb
  AND (SELECT count(*) = 1 FROM cash_movements WHERE shift_id = test.var('shift_a2') AND kind = 'PAY_IN'));
SELECT test.login('a0000000-0000-4000-8000-000000000002');   -- manager A
SET ROLE authenticated;
SELECT public.fin_record_cash_movement(test.var('shift_a2'), 'PAY_OUT', 2500, 'Bought cleaning supplies', NULL, NULL, '77777777-0000-4000-8000-000000000024') AS cm2 \gset
SELECT test.expect_error('c05 cash out beyond the drawer is refused', $q$SELECT public.fin_record_cash_movement(test.var('shift_a2'),'DEPOSIT_OUT',99999999,'Bank deposit',NULL,NULL,'77777777-0000-4000-8000-000000000025')$q$, 'cannot be taken out');
SELECT public.fin_record_cash_movement(test.var('shift_a2'), 'REVERSAL', NULL, 'Entered against the wrong shift', :'cm2'::jsonb->'movement'->>'id', NULL, '77777777-0000-4000-8000-000000000026') AS cm3 \gset
SELECT test.expect_error('c06 a movement cannot be reversed twice', format($q$SELECT public.fin_record_cash_movement(%L,'REVERSAL',NULL,'Again',%L,NULL,'77777777-0000-4000-8000-000000000027')$q$, test.var('shift_a2'), :'cm2'::jsonb->'movement'->>'id'), 'already reversed');
SELECT test.expect_error('c07 another organization''s shift is not found', $q$SELECT public.fin_record_cash_movement('shift-unrel','PAY_IN',100,'Cross tenant',NULL,NULL,'77777777-0000-4000-8000-000000000028')$q$, 'not found');
RESET ROLE;
SELECT test.check('c08 reversal is a new row with the opposite direction (nothing edited)',
  :'cm3'::jsonb->'movement'->>'direction' = '1' AND (SELECT count(*) = 3 FROM cash_movements WHERE shift_id = test.var('shift_a2')));
SELECT test.expect_error('c09 movements are immutable', $$DELETE FROM cash_movements$$, 'FIN_RECORD_IMMUTABLE');
SELECT test.check('c10 expected cash = before + 10000 in - 2500 out + 2500 reversal',
  (public.fin_shift_cash(test.var('shift_a2'))->>'expectedCashMmk')::int = :exp0 + 10000);
-- ---------------------------------------------------------------- refunds with lines and payouts (PFIN-E)
SELECT id AS s2_line FROM sale_items WHERE sale_id = :'s2_id' \gset
SELECT test.login('a0000000-0000-4000-8000-000000000004');
SET ROLE authenticated;
SELECT public.create_refund_void_request(:'s2_id', 'PARTIAL', 'Customer returned one',
  jsonb_build_array(jsonb_build_object('productId','prod-2','qtyUnits',1,'amountMmk',2000,
    'lines', jsonb_build_array(jsonb_build_object('saleItemId', :'s2_line', 'qtyUnits',1,'amountMmk',2000,'restock',false)),
    'payouts', '[{"method":"CASH","amountMmk":1500},{"method":"BANK_TRANSFER","amountMmk":500}]'::jsonb)),
  NULL, NULL, '77777777-0000-4000-8000-000000000031') AS r1 \gset
RESET ROLE;
SELECT id AS s1_line FROM sale_items WHERE sale_id = :'s1'::jsonb->'sale'->>'id' \gset
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SET ROLE authenticated;
SELECT test.expect_error('r02 a refund line of another sale is refused at request time', format($q$SELECT public.create_refund_void_request(%L,'PARTIAL','x',
  jsonb_build_array(jsonb_build_object('productId','prod-1','qtyUnits',1,'amountMmk',100,'lines',jsonb_build_array(jsonb_build_object('saleItemId',%L,'qtyUnits',1,'amountMmk',100)))),
  NULL,NULL,'77777777-0000-4000-8000-000000000032')$q$, :'s1'::jsonb->'sale'->>'id', :'s2_line'), 'not a line of this sale');
SELECT test.expect_error('r03 lines that do not add up are refused', format($q$SELECT public.create_refund_void_request(%L,'PARTIAL','x',
  jsonb_build_array(jsonb_build_object('productId','prod-1','qtyUnits',1,'amountMmk',100,'lines',jsonb_build_array(jsonb_build_object('saleItemId',%L,'qtyUnits',1,'amountMmk',90)))),
  NULL,NULL,'77777777-0000-4000-8000-000000000033')$q$, :'s1'::jsonb->'sale'->>'id', :'s1_line'), 'do not add up');
RESET ROLE;
SELECT stock_qty AS inv_before FROM (SELECT qty_base_units AS stock_qty FROM inventory WHERE shop_id='shop-a' AND product_id='prod-2') x \gset
SELECT test.login('a0000000-0000-4000-8000-000000000002');   -- manager approves
SET ROLE authenticated;
SELECT public.approve_refund_request(:'r1'::jsonb->'request'->>'id', '77777777-0000-4000-8000-000000000034') AS a1 \gset
RESET ROLE;
SELECT test.check('r01 approved refund recorded per sale line with payouts, business dates and cost',
  (SELECT count(*) = 1 AND min(sale_item_id) = :'s2_line' AND sum(qty_units) = 1 AND sum(amount_mmk) = 2000 AND bool_and(NOT restocked)
          AND min(cost_mmk) IS NOT NULL AND min(refund_business_date) IS NOT NULL FROM refund_lines WHERE sale_id = :'s2_id')
  AND (SELECT count(*) = 2 AND sum(amount_mmk) = 2000 FROM refund_payouts WHERE sale_id = :'s2_id'));
SELECT test.check('r04 no-restock: the approval''s RETURN_IN is taken back by a separate RETURN_NO_RESTOCK movement (net stock unchanged)',
  (SELECT qty_base_units FROM inventory WHERE shop_id='shop-a' AND product_id='prod-2') = :inv_before
  AND EXISTS (SELECT 1 FROM inventory_movements WHERE type = 'RETURN_NO_RESTOCK' AND reference_id = :'r1'::jsonb->'request'->>'id' AND qty_change = -1));
SELECT test.login('a0000000-0000-4000-8000-000000000004');
SET ROLE authenticated;
SELECT test.expect_error('r05 a payout beyond what was paid that way is refused when the request is CREATED (bank 500 already + 2000 > 1000)',
  format($q$SELECT public.create_refund_void_request(%L, 'PARTIAL', 'Second unit too',
    jsonb_build_array(jsonb_build_object('productId','prod-2','qtyUnits',1,'amountMmk',2000,
      'lines', jsonb_build_array(jsonb_build_object('saleItemId', %L, 'qtyUnits',1,'amountMmk',2000)),
      'payouts', '[{"method":"BANK_TRANSFER","amountMmk":2000}]'::jsonb)), NULL, NULL, '77777777-0000-4000-8000-000000000035')$q$, :'s2_id', :'s2_line'),
  'exceeds what the customer paid that way');
RESET ROLE;
SELECT test.check('r06 the refused request left nothing behind (no pending request blocking the sale, no lines)',
  NOT EXISTS (SELECT 1 FROM refund_void_requests WHERE sale_id = :'s2_id' AND status = 'REQUESTED')
  AND (SELECT count(*) = 1 FROM refund_lines WHERE sale_id = :'s2_id'));
-- legacy item (no lines): recorded unattributed; nothing invented
SELECT test.login('a0000000-0000-4000-8000-000000000003');
SET ROLE authenticated;
SELECT public.create_refund_void_request(:'s1'::jsonb->'sale'->>'id', 'PARTIAL', 'Legacy till refund',
  '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]'::jsonb, NULL, NULL, '77777777-0000-4000-8000-000000000038') AS r7 \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000002');
SET ROLE authenticated;
SELECT public.approve_refund_request(:'r7'::jsonb->'request'->>'id', '77777777-0000-4000-8000-000000000039') AS a7 \gset
SELECT test.expect_error('r09 refund line cost stays private to report:shop_profit (column not readable)', $$SELECT cost_mmk FROM refund_lines$$, 'permission denied');
SELECT public.fin_refund_lines_state(:'s2_id') AS st \gset
RESET ROLE;
SELECT test.check('r07 a legacy refund item is recorded with no sale line (unattributed), restocked, no cost guessed',
  (SELECT count(*) = 1 AND min(sale_item_id) IS NULL AND bool_and(restocked) AND min(cost_mmk) IS NULL
     FROM refund_lines WHERE request_id = :'r7'::jsonb->'request'->>'id'));
SELECT test.check('r08 refundable state per line and per method', (:'st'::jsonb->'lines'->0->>'remainingQtyUnits')::int = 1
  AND (SELECT (x->>'refundedMmk')::int FROM jsonb_array_elements(:'st'::jsonb->'payments') x WHERE x->>'method' = 'CASH') = 1500);
-- ---------------------------------------------------------------- shift close: authoritative vs legacy
SELECT test.login('a0000000-0000-4000-8000-000000000004');
SET ROLE authenticated;
SELECT test.expect_error('s01 legacy close_shift is refused on a shift with split payments / movements (no wrong figure stored)',
  format('SELECT public.close_shift(%L, 0, %L, NULL, NULL, %L)', test.var('shift_a2'), 'count', '77777777-0000-4000-8000-000000000041'), 'FIN_CLOSE_SHIFT_UPGRADE_REQUIRED');
SELECT (public.fin_shift_cash_summary(test.var('shift_a2'))->>'expectedCashMmk')::int AS expected_a1 \gset
SELECT test.expect_error('s02 fin_close_shift requires a variance reason', format('SELECT public.fin_close_shift(%L, %s, NULL, NULL, NULL, %L)',
  test.var('shift_a2'), :expected_a1 - 1, '77777777-0000-4000-8000-000000000042'), 'Variance reason is required');
SELECT public.fin_close_shift(test.var('shift_a2'), :expected_a1, NULL, NULL, NULL, '77777777-0000-4000-8000-000000000043') AS cl \gset
RESET ROLE;
SELECT test.check('s03 fin_close_shift stores the authoritative figures (cash applied 3000 from the split, refund cash payout 1500, movements +10000)',
  (SELECT expected_cash_mmk = :expected_a1 AND variance_mmk = 0 AND ended_at IS NOT NULL FROM shifts WHERE id = test.var('shift_a2'))
  AND (:'cl'::jsonb->'cash'->>'cashRefundsMmk')::int = 1500 AND (:'cl'::jsonb->'cash'->>'cashSalesMmk')::int = 3000
  AND (:'cl'::jsonb->'cash'->>'expectedCashMmk')::int = (SELECT opening_cash_mmk FROM shifts WHERE id = test.var('shift_a2')) + 3000 - 1500 + 10000);
SELECT test.login('a0000000-0000-4000-8000-000000000004');   -- cashier A2 opens a clean shift: the legacy close keeps working
SET ROLE authenticated;
SELECT public.open_shift('shop-a', 700, NULL, NULL, '77777777-0000-4000-8000-000000000045')->'shift'->>'id' AS clean_shift \gset
SELECT public.close_shift(:'clean_shift', 700, NULL, NULL, NULL, '77777777-0000-4000-8000-000000000044') AS cl2 \gset
RESET ROLE;
SELECT test.check('s04 legacy close_shift unchanged on a shift without new-style records', (SELECT ended_at IS NOT NULL AND expected_cash_mmk = 700 FROM shifts WHERE id = :'clean_shift'));
-- ---------------------------------------------------------------- review fixes: payouts across items, history, legacy on splits, key reuse
SELECT test.login('a0000000-0000-4000-8000-000000000004');
SET ROLE authenticated;
SELECT public.open_shift('shop-a', 0, NULL, NULL, '77777777-0000-4000-8000-000000000050')->'shift'->>'id' AS shift_a3 \gset
SELECT public.fin_complete_sale_split('direct', '77777777-0000-4000-8000-000000000051',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',:'shift_a3','p_payment_method','CASH','p_paid_mmk',3000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-1","qty":1},{"product_id":"prod-2","qty":1}]'::jsonb,'p_idempotency_key','77777777-0000-4000-8000-000000000051'),
  '[{"method":"CASH","amountMmk":1000},{"method":"CARD","amountMmk":2000}]')->'sale'->>'id' AS s3 \gset
RESET ROLE;
SELECT (SELECT id FROM sale_items WHERE sale_id = :'s3' AND product_id = 'prod-1') AS s3_p1, (SELECT id FROM sale_items WHERE sale_id = :'s3' AND product_id = 'prod-2') AS s3_p2 \gset
SET ROLE authenticated;
SELECT public.create_refund_void_request(:'s3', 'PARTIAL', 'Both items back',
  jsonb_build_array(
    jsonb_build_object('productId','prod-1','qtyUnits',1,'amountMmk',1000,'lines',jsonb_build_array(jsonb_build_object('saleItemId',:'s3_p1','qtyUnits',1,'amountMmk',1000,'restock',true)),
      'payouts','[{"method":"CARD","amountMmk":1000}]'::jsonb),
    jsonb_build_object('productId','prod-2','qtyUnits',1,'amountMmk',2000,'lines',jsonb_build_array(jsonb_build_object('saleItemId',:'s3_p2','qtyUnits',1,'amountMmk',2000,'restock',true)),
      'payouts','[{"method":"CASH","amountMmk":1000},{"method":"CARD","amountMmk":1000}]'::jsonb)),
  NULL, NULL, '77777777-0000-4000-8000-000000000052')->'request'->>'id' AS r10 \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000002');
SET ROLE authenticated;
SELECT public.approve_refund_request(:'r10', '77777777-0000-4000-8000-000000000053') AS a10 \gset
RESET ROLE;
SELECT test.check('r10 payouts of several items by the same method are added up (CARD 1000 + 1000), never one item''s only',
  (SELECT amount_mmk FROM refund_payouts WHERE request_id = :'r10' AND method = 'CARD') = 2000
  AND (SELECT amount_mmk FROM refund_payouts WHERE request_id = :'r10' AND method = 'CASH') = 1000
  AND (public.fin_shift_cash(:'shift_a3')->>'cashRefundsMmk')::int = 1000);
-- a refund approved from a released till (no lines, no payouts) counts against later caps
SELECT test.login('a0000000-0000-4000-8000-000000000004');
SET ROLE authenticated;
SELECT public.fin_complete_sale_split('direct', '77777777-0000-4000-8000-000000000054',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',:'shift_a3','p_payment_method','CASH','p_paid_mmk',2000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-1","qty":2}]'::jsonb,'p_idempotency_key','77777777-0000-4000-8000-000000000054'),
  '[{"method":"CASH","amountMmk":1000},{"method":"CARD","amountMmk":1000}]')->'sale'->>'id' AS s4 \gset
SELECT public.create_refund_void_request(:'s4', 'PARTIAL', 'Released till refund', '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]'::jsonb,
  NULL, NULL, '77777777-0000-4000-8000-000000000055')->'request'->>'id' AS r11a \gset
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000002');
SET ROLE authenticated;
SELECT public.approve_refund_request(:'r11a', '77777777-0000-4000-8000-000000000056') AS a11 \gset
RESET ROLE;
SELECT id AS s4_line FROM sale_items WHERE sale_id = :'s4' \gset
SELECT test.login('a0000000-0000-4000-8000-000000000004');
SET ROLE authenticated;
SELECT test.expect_error('r11 a legacy refund (paid back by the sale''s legacy method, CASH) counts: a further CASH payout beyond the cash taken is refused',
  format($q$SELECT public.create_refund_void_request(%L,'PARTIAL','Second unit',
    jsonb_build_array(jsonb_build_object('productId','prod-1','qtyUnits',1,'amountMmk',1000,'lines',jsonb_build_array(jsonb_build_object('saleItemId',%L,'qtyUnits',1,'amountMmk',1000)),
      'payouts','[{"method":"CASH","amountMmk":1000}]'::jsonb)), NULL, NULL, '77777777-0000-4000-8000-000000000057')$q$, :'s4', :'s4_line'),
  'exceeds what the customer paid that way');
-- a legacy refund of a split sale is counted as cash only up to the cash that sale took
SELECT public.fin_complete_sale_split('direct', '77777777-0000-4000-8000-000000000058',
  jsonb_build_object('p_shop_id','shop-a','p_shift_id',:'shift_a3','p_payment_method','CASH','p_paid_mmk',2000,'p_cart_discount_pct',0,
    'p_items','[{"product_id":"prod-1","qty":2}]'::jsonb,'p_idempotency_key','77777777-0000-4000-8000-000000000058'),
  '[{"method":"CASH","amountMmk":100},{"method":"CARD","amountMmk":1900}]')->'sale'->>'id' AS s5 \gset
SELECT public.create_refund_void_request(:'s5', 'PARTIAL', 'Released till refund', '[{"productId":"prod-1","qtyUnits":1,"amountMmk":1000}]'::jsonb,
  NULL, NULL, '77777777-0000-4000-8000-000000000059')->'request'->>'id' AS r12a \gset
RESET ROLE;
SELECT (public.fin_shift_cash(:'shift_a3')->>'cashRefundsMmk')::int AS cr_before \gset
SELECT test.login('a0000000-0000-4000-8000-000000000002');
SET ROLE authenticated;
SELECT public.approve_refund_request(:'r12a', '77777777-0000-4000-8000-000000000060') AS a12 \gset
RESET ROLE;
SELECT test.check('r12 a legacy refund of a split sale lowers expected cash by at most that sale''s cash part (100, not 1000)',
  (public.fin_shift_cash(:'shift_a3')->>'cashRefundsMmk')::int = :cr_before + 100);
-- a key that already committed a single-payment sale never becomes a split sale (checked from the server's rows, not the reply)
SELECT test.login('a0000000-0000-4000-8000-000000000004');
SET ROLE authenticated;
SELECT test.expect_error('p14 a key already committed WITHOUT a split is refused as a split (FIN_PAYMENTS_MISMATCH before anything runs)',
  $q$SELECT public.fin_complete_sale_split('direct','77777777-0000-4000-8000-000000000001',
    jsonb_build_object('p_shop_id','shop-a','p_shift_id',test.var('shift_a1'),'p_payment_method','CASH','p_paid_mmk',5000,'p_cart_discount_pct',0,
      'p_items','[{"product_id":"prod-1","qty":2}]'::jsonb), '[{"method":"CASH","amountMmk":1000,"tenderedMmk":4000},{"method":"CARD","amountMmk":1000}]')$q$,
  'FIN_PAYMENTS_MISMATCH');
RESET ROLE;
-- ---------------------------------------------------------------- reports and isolation
SELECT test.login('a0000000-0000-4000-8000-000000000001');   -- admin
SET ROLE authenticated;
SELECT public.fin_payment_summary('shop-a', (now() AT TIME ZONE 'Asia/Yangon')::date - 1, (now() AT TIME ZONE 'Asia/Yangon')::date + 1) AS rep \gset
RESET ROLE;
SELECT test.check('x01 payment report per method (cash and bank transfer present; split sale counted)',
  (:'rep'::jsonb->'payments'->>'BANK_TRANSFER')::int >= 1000 AND (:'rep'::jsonb->>'splitSales')::int >= 1);
SELECT test.login('a0000000-0000-4000-8000-0000000000f2');   -- org-unrelated manager
SET ROLE authenticated;
SELECT test.check('x02 another organization sees none of these payments, movements or refund lines',
  (SELECT count(*) FROM sale_payments WHERE shop_id = 'shop-a') = 0 AND (SELECT count(*) FROM cash_movements) = 0
  AND (SELECT count(*) FROM refund_lines WHERE shop_id = 'shop-a') = 0);
RESET ROLE;
SELECT test.logout();
