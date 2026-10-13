-- t06: record-creating and state-guarded workflow RPCs under replay:
-- create_purchase_order, receive_purchase_order, create/approve/dispatch/
-- receive stock transfer, log_receipt_reprint, log_audit_event,
-- create_supplier, create_app_user, cancel_purchase_order.
\set ON_ERROR_STOP on
\set kpo  '55555555-0000-4000-8000-000000000001'
\set krcv '55555555-0000-4000-8000-000000000002'
\set ktr  '55555555-0000-4000-8000-000000000003'
\set kap  '55555555-0000-4000-8000-000000000004'
\set kdp  '55555555-0000-4000-8000-000000000005'
\set krt  '55555555-0000-4000-8000-000000000006'
\set krp  '55555555-0000-4000-8000-000000000007'
\set kae  '55555555-0000-4000-8000-000000000008'
\set ksu  '55555555-0000-4000-8000-000000000009'
\set kus  '55555555-0000-4000-8000-000000000010'
\set kcn  '55555555-0000-4000-8000-000000000011'

SELECT test.login('a0000000-0000-4000-8000-000000000002') AS zz \gset
SET ROLE authenticated;

-- create_purchase_order
SELECT public.create_purchase_order('shop-a', 'sup-1', 'weekly order',
  '[{"product_id":"prod-1","ordered_qty":10,"unit_cost_mmk":600}]'::jsonb, :'kpo') AS po1 \gset
SELECT public.create_purchase_order('shop-a', 'sup-1', 'weekly order',
  '[{"product_id":"prod-1","ordered_qty":10,"unit_cost_mmk":600}]'::jsonb, :'kpo') AS po2 \gset
SELECT test.check('create_purchase_order replay -> identical response', :'po1'::jsonb = :'po2'::jsonb);
SELECT test.setvar('po_new', :'po1'::jsonb->'purchaseOrder'->>'id') AS zz \gset

-- receive_purchase_order (APPROVED -> RECEIVED; replay today would raise)
SELECT public.receive_purchase_order('po-appr', NULL, NULL, 'u-mgr-a', :'krcv') AS rc1 \gset
SELECT public.receive_purchase_order('po-appr', NULL, NULL, 'u-mgr-a', :'krcv') AS rc2 \gset
SELECT test.check('receive_purchase_order replay -> identical response (no status error)', :'rc1'::jsonb = :'rc2'::jsonb);
SELECT test.check('receive_purchase_order: response shows prod-1 +10',
  (:'rc1'::jsonb->'purchaseOrder'->>'status') = 'RECEIVED'
  AND (:'rc1'::jsonb->'movements'->0->>'qtyChange')::int = 10);

-- stock transfer chain (manager A: create, approve, dispatch)
SELECT public.create_stock_transfer('shop-a', 'shop-b', 'rebalance',
  '[{"product_id":"prod-2","requested_qty":5}]'::jsonb, :'ktr') AS tr1 \gset
SELECT public.create_stock_transfer('shop-a', 'shop-b', 'rebalance',
  '[{"product_id":"prod-2","requested_qty":5}]'::jsonb, :'ktr') AS tr2 \gset
SELECT test.check('create_stock_transfer replay -> identical response', :'tr1'::jsonb = :'tr2'::jsonb);
SELECT test.setvar('tr_new', :'tr1'::jsonb->'stockTransfer'->>'id') AS zz \gset

SELECT public.approve_stock_transfer(test.var('tr_new'), :'kap') AS ap1 \gset
SELECT public.approve_stock_transfer(test.var('tr_new'), :'kap') AS ap2 \gset
SELECT test.check('approve_stock_transfer replay -> identical response', :'ap1'::jsonb = :'ap2'::jsonb);

SELECT public.dispatch_stock_transfer(test.var('tr_new'), NULL, 'u-mgr-a', :'kdp') AS dp1 \gset
SELECT public.dispatch_stock_transfer(test.var('tr_new'), NULL, 'u-mgr-a', :'kdp') AS dp2 \gset
SELECT test.check('dispatch_stock_transfer replay -> identical response', :'dp1'::jsonb = :'dp2'::jsonb);
SELECT test.check('dispatch: status IN_TRANSIT', (:'dp1'::jsonb->'stockTransfer'->>'status') = 'IN_TRANSIT');

-- log_audit_event (manager has product:update)
SELECT public.log_audit_event('PRODUCT_EDIT', 'edited prod-1', 'Product', 'prod-1', NULL, :'kae') AS ae1 \gset
SELECT public.log_audit_event('PRODUCT_EDIT', 'edited prod-1', 'Product', 'prod-1', NULL, :'kae') AS ae2 \gset
SELECT test.check('log_audit_event replay -> identical response', :'ae1'::jsonb = :'ae2'::jsonb);

-- cancel_purchase_order on the DRAFT PO (state-guarded)
SELECT public.cancel_purchase_order('po-draft', 'not needed', :'kcn') AS cn1 \gset
SELECT public.cancel_purchase_order('po-draft', 'not needed', :'kcn') AS cn2 \gset
SELECT test.check('cancel_purchase_order replay -> identical response (no "cannot cancel from CANCELED")', :'cn1'::jsonb = :'cn2'::jsonb);
RESET ROLE;

-- manager B receives the transfer
SELECT test.login('a0000000-0000-4000-8000-000000000005') AS zz \gset
SET ROLE authenticated;
SELECT public.receive_stock_transfer(test.var('tr_new'), NULL, NULL, 'u-mgr-b', :'krt') AS rt1 \gset
SELECT public.receive_stock_transfer(test.var('tr_new'), NULL, NULL, 'u-mgr-b', :'krt') AS rt2 \gset
SELECT test.check('receive_stock_transfer replay -> identical response', :'rt1'::jsonb = :'rt2'::jsonb);
SELECT test.check('receive_stock_transfer: COMPLETED, 2 movements in response',
  (:'rt1'::jsonb->'stockTransfer'->>'status') = 'COMPLETED' AND jsonb_array_length(:'rt1'::jsonb->'movements') = 2);
RESET ROLE;

-- cashier A1 reprints a receipt
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT public.log_receipt_reprint(test.var('sale1'), :'krp') AS rp1 \gset
SELECT public.log_receipt_reprint(test.var('sale1'), :'krp') AS rp2 \gset
SELECT test.check('log_receipt_reprint replay -> identical response', :'rp1'::jsonb = :'rp2'::jsonb);
RESET ROLE;

-- admin creates a supplier and a user
SELECT test.login('a0000000-0000-4000-8000-000000000001') AS zz \gset
SET ROLE authenticated;
SELECT public.create_supplier('SUP2', 'Supplier Two', NULL, NULL, NULL, NULL, NULL, :'ksu') AS su1 \gset
SELECT public.create_supplier('SUP2', 'Supplier Two', NULL, NULL, NULL, NULL, NULL, :'ksu') AS su2 \gset
SELECT test.check('create_supplier replay -> identical response (same server-minted id)', :'su1'::jsonb = :'su2'::jsonb);
SELECT public.create_app_user('u-new', 'New Cashier', 'new@test.local', 'CASHIER', 'shop-a', NULL, NULL, NULL, :'kus') AS us1 \gset
SELECT public.create_app_user('u-new', 'New Cashier', 'new@test.local', 'CASHIER', 'shop-a', NULL, NULL, NULL, :'kus') AS us2 \gset
SELECT test.check('create_app_user replay -> identical response (no PK violation)', :'us1'::jsonb = :'us2'::jsonb);
RESET ROLE;

-- DB-level counts: everything happened exactly once
SELECT test.check('DB: one new PO created', (SELECT count(*) FROM purchase_orders WHERE id = test.var('po_new')) = 1
  AND (SELECT count(*) FROM purchase_orders) = 4);
SELECT test.check('DB: PO_CREATED audit rows for the new PO = 1',
  (SELECT count(*) FROM audit_logs WHERE entity_id = test.var('po_new') AND action_type = 'PO_CREATED') = 1);
SELECT test.check('DB: po-appr RECEIVED once; one PURCHASE_IN movement; prod-1 +10',
  (SELECT status FROM purchase_orders WHERE id = 'po-appr') = 'RECEIVED'
  AND (SELECT count(*) FROM inventory_movements WHERE reference_id = 'po-appr') = 1);
SELECT test.check('DB: one stock transfer created, status COMPLETED',
  (SELECT count(*) FROM stock_transfers) = 1 AND (SELECT status FROM stock_transfers WHERE id = test.var('tr_new')) = 'COMPLETED');
SELECT test.check('DB: transfer produced exactly 2 movements (OUT + IN)',
  (SELECT count(*) FROM inventory_movements WHERE reference_id = test.var('tr_new')) = 2);
SELECT test.check('DB: shop B prod-2 = 15, shop A prod-2 = 50 after transfer',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-b' AND product_id = 'prod-2') = 15
  AND (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-a' AND product_id = 'prod-2') = 50);
SELECT test.check('DB: transfer audit rows CREATED/APPROVED/DISPATCHED/RECEIVED = 1 each',
  (SELECT count(*) FROM audit_logs WHERE entity_id = test.var('tr_new') AND action_type = 'TRANSFER_CREATED') = 1
  AND (SELECT count(*) FROM audit_logs WHERE entity_id = test.var('tr_new') AND action_type = 'TRANSFER_APPROVED') = 1
  AND (SELECT count(*) FROM audit_logs WHERE entity_id = test.var('tr_new') AND action_type = 'TRANSFER_DISPATCHED') = 1
  AND (SELECT count(*) FROM audit_logs WHERE entity_id = test.var('tr_new') AND action_type = 'TRANSFER_RECEIVED') = 1);
SELECT test.check('DB: one reprint_logs row + one REPRINT_RECEIPT audit row',
  (SELECT count(*) FROM reprint_logs WHERE sale_id = test.var('sale1')) = 1
  AND (SELECT count(*) FROM audit_logs WHERE action_type = 'REPRINT_RECEIPT') = 1);
SELECT test.check('DB: one PRODUCT_EDIT audit row', (SELECT count(*) FROM audit_logs WHERE action_type = 'PRODUCT_EDIT') = 1);
SELECT test.check('DB: one supplier SUP2, one SUPPLIER_CREATED audit row',
  (SELECT count(*) FROM suppliers WHERE code = 'SUP2') = 1 AND (SELECT count(*) FROM audit_logs WHERE action_type = 'SUPPLIER_CREATED') = 1);
SELECT test.check('DB: one user u-new, one USER_CREATED audit row',
  (SELECT count(*) FROM users WHERE id = 'u-new') = 1 AND (SELECT count(*) FROM audit_logs WHERE action_type = 'USER_CREATED') = 1);
SELECT test.check('DB: u-new inherited the creator''s org_id (066 fix for the 059 NOT NULL defect)',
  (SELECT org_id FROM users WHERE id = 'u-new') = 'org-test');
SELECT test.check('DB: po-draft CANCELED once, one PO_CANCELED audit row',
  (SELECT status FROM purchase_orders WHERE id = 'po-draft') = 'CANCELED'
  AND (SELECT count(*) FROM audit_logs WHERE entity_id = 'po-draft' AND action_type = 'PO_CANCELED') = 1);
SELECT test.logout() AS zz \gset
