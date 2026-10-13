-- t05: adjust_stock, record_supplier_payment, pay_supplier_lump_sum and
-- void_supplier_payment each apply ONCE under replay.
\set ON_ERROR_STOP on
\set ka '44444444-0000-4000-8000-000000000001'
\set kp '44444444-0000-4000-8000-000000000002'
\set kl '44444444-0000-4000-8000-000000000003'
\set kv '44444444-0000-4000-8000-000000000004'

SELECT test.login('a0000000-0000-4000-8000-000000000002') AS zz \gset
SET ROLE authenticated;

-- adjust_stock
SELECT public.adjust_stock('shop-a', 'prod-2', 'ADJUSTMENT', 5, 'count correction', NULL, NULL, NULL, 'u-mgr-a', :'ka') AS a1 \gset
SELECT public.adjust_stock('shop-a', 'prod-2', 'ADJUSTMENT', 5, 'count correction', NULL, NULL, NULL, 'u-mgr-a', :'ka') AS a2 \gset
SELECT test.check('adjust_stock replay -> identical response', :'a1'::jsonb = :'a2'::jsonb);
SELECT test.check('adjust_stock: qty changed once (55)', (:'a1'::jsonb->'inventory'->>'qtyBaseUnits')::int = 55);

-- record_supplier_payment
SELECT public.record_supplier_payment('po-recv', 30000, 'CASH', 'REF-1', NULL, NULL, 'u-mgr-a', :'kp') AS p1 \gset
SELECT public.record_supplier_payment('po-recv', 30000, 'CASH', 'REF-1', NULL, NULL, 'u-mgr-a', :'kp') AS p2 \gset
SELECT test.check('record_supplier_payment replay -> identical response', :'p1'::jsonb = :'p2'::jsonb);
SELECT test.check('record_supplier_payment: paid 30000 / PARTIAL in response',
  (:'p1'::jsonb->'purchaseOrder'->>'paidMmk')::int = 30000 AND (:'p1'::jsonb->'purchaseOrder'->>'paymentStatus') = 'PARTIAL');

-- pay_supplier_lump_sum
SELECT public.pay_supplier_lump_sum('sup-1', 'shop-a', 20000, 'BANK', 'REF-2', 'lump', :'kl') AS l1 \gset
SELECT public.pay_supplier_lump_sum('sup-1', 'shop-a', 20000, 'BANK', 'REF-2', 'lump', :'kl') AS l2 \gset
SELECT test.check('pay_supplier_lump_sum replay -> identical response', :'l1'::jsonb = :'l2'::jsonb);
SELECT test.check('pay_supplier_lump_sum: one payment row in response, PO paid 50000',
  jsonb_array_length(:'l1'::jsonb->'supplierPayments') = 1
  AND (:'l1'::jsonb->'purchaseOrders'->0->>'paidMmk')::int = 50000);
SELECT test.setvar('lump_pay', :'l1'::jsonb->'supplierPayments'->0->>'id') AS zz \gset

-- void_supplier_payment (state-guarded: replay today would raise 'already voided')
SELECT public.void_supplier_payment(test.var('lump_pay'), 'entered twice', :'kv') AS v1 \gset
SELECT public.void_supplier_payment(test.var('lump_pay'), 'entered twice', :'kv') AS v2 \gset
SELECT test.check('void_supplier_payment replay -> identical response (no "already voided" error)', :'v1'::jsonb = :'v2'::jsonb);
SELECT test.check('void_supplier_payment: PO back to 30000',
  (:'v1'::jsonb->'purchaseOrder'->>'paidMmk')::int = 30000);
RESET ROLE;

SELECT test.check('DB: prod-2 = 55 after adjust replay',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-2') = 55);
SELECT test.check('DB: exactly one ADJUSTMENT movement with that reason',
  (SELECT count(*) FROM inventory_movements WHERE product_id = 'prod-2' AND reason = 'count correction') = 1);
SELECT test.check('DB: outstanding reduced once -> paid_mmk 30000, status PARTIAL',
  (SELECT paid_mmk = 30000 AND payment_status = 'PARTIAL' FROM purchase_orders WHERE id = 'po-recv'));
SELECT test.check('DB: exactly 2 supplier_payments rows (one voided)',
  (SELECT count(*) FROM supplier_payments WHERE purchase_order_id = 'po-recv') = 2
  AND (SELECT count(*) FROM supplier_payments WHERE purchase_order_id = 'po-recv' AND voided_at IS NOT NULL) = 1);
SELECT test.check('DB: SUPPLIER_PAYMENT_RECORDED audit rows = 2, VOIDED = 1',
  (SELECT count(*) FROM audit_logs WHERE action_type = 'SUPPLIER_PAYMENT_RECORDED') = 2
  AND (SELECT count(*) FROM audit_logs WHERE action_type = 'SUPPLIER_PAYMENT_VOIDED') = 1);
SELECT test.logout() AS zz \gset
