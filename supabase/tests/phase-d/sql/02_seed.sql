-- Synthetic data only. Runs as the superuser (bypasses RLS; triggers still
-- fire, so the insert order respects migration 020's assignment rules:
-- ADMIN first while users is empty, then managers, then cashiers).
\set ON_ERROR_STOP on

INSERT INTO organizations (id, name) VALUES ('org-test', 'Test Org');
-- 077 seeds the default price levels for every new organization. org-test
-- stands for the production organization, which existed (with its own
-- levels) BEFORE 077; its levels come from the fixture below, so the
-- auto-seeded set is removed again. No-op before 077 (no trigger).
DO $$ BEGIN
  IF to_regprocedure('public.organizations_seed_price_levels()') IS NOT NULL THEN
    DELETE FROM price_levels WHERE org_id = 'org-test';
  END IF;
END $$;

INSERT INTO shops (id, code, name, address, org_id) VALUES
  ('shop-a', 'SA', 'Shop A', 'A Street', 'org-test'),
  ('shop-b', 'SB', 'Shop B', 'B Street', 'org-test');

-- auth identities (synthetic, fixed UUIDs so test files can reference them)
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'admin@test.local'),
  ('a0000000-0000-4000-8000-000000000002', 'mgr-a@test.local'),
  ('a0000000-0000-4000-8000-000000000003', 'cash-a1@test.local'),
  ('a0000000-0000-4000-8000-000000000004', 'cash-a2@test.local'),
  ('a0000000-0000-4000-8000-000000000005', 'mgr-b@test.local'),
  ('a0000000-0000-4000-8000-000000000006', 'cash-b@test.local');

INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-admin',   'Admin',      'admin@test.local',   'ADMIN',   NULL,     'a0000000-0000-4000-8000-000000000001', 'org-test');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-mgr-a',   'Manager A',  'mgr-a@test.local',   'MANAGER', 'shop-a', 'a0000000-0000-4000-8000-000000000002', 'org-test'),
  ('u-mgr-b',   'Manager B',  'mgr-b@test.local',   'MANAGER', 'shop-b', 'a0000000-0000-4000-8000-000000000005', 'org-test');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-cash-a1', 'Cashier A1', 'cash-a1@test.local', 'CASHIER', 'shop-a', 'a0000000-0000-4000-8000-000000000003', 'org-test'),
  ('u-cash-a2', 'Cashier A2', 'cash-a2@test.local', 'CASHIER', 'shop-a', 'a0000000-0000-4000-8000-000000000004', 'org-test'),
  ('u-cash-b',  'Cashier B',  'cash-b@test.local',  'CASHIER', 'shop-b', 'a0000000-0000-4000-8000-000000000006', 'org-test');

-- Catalog rows are inserted "as the ADMIN": after migration 068 the catalog
-- tables carry org_id, filled by a BEFORE INSERT trigger from app_org_id(),
-- which resolves through the JWT claim GUCs even in a superuser session.
-- Harmless before 068 (the GUCs are simply unused).
SELECT test.login('a0000000-0000-4000-8000-000000000001') AS zz \gset

INSERT INTO price_levels (id, code, name, is_default, is_active) VALUES
  ('pl-retail', 'RETAIL', 'Retail', true, true);

INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES
  ('prod-1', 'SKU1', 'Product One',   'General', 'pcs', 1000, 600),
  ('prod-2', 'SKU2', 'Product Two',   'General', 'pcs', 2000, 1200),
  ('prod-3', 'SKU3', 'Product Three', 'General', 'pcs', 3000, 1800);

INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk) VALUES
  ('unit-1', 'prod-1', 'pcs', 1, true, true, 1000, 600),
  ('unit-2', 'prod-2', 'pcs', 1, true, true, 2000, 1200),
  ('unit-3', 'prod-3', 'pcs', 1, true, true, 3000, 1800);

-- Inventory rows were auto-created (0) by the products trigger; set stock.
UPDATE inventory SET qty_base_units = 100 WHERE shop_id = 'shop-a' AND product_id = 'prod-1';
UPDATE inventory SET qty_base_units = 50  WHERE shop_id = 'shop-a' AND product_id = 'prod-2';
UPDATE inventory SET qty_base_units = 20  WHERE shop_id = 'shop-a' AND product_id = 'prod-3';
UPDATE inventory SET qty_base_units = 10  WHERE shop_id = 'shop-b';

INSERT INTO suppliers (id, code, name) VALUES ('sup-1', 'SUP1', 'Supplier One');

-- RECEIVED PO with an outstanding balance (supplier-payment tests).
INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by, received_by, received_at, paid_mmk, payment_status)
VALUES ('po-recv', 'PO-TEST-0001', 'shop-a', 'sup-1', 'RECEIVED', 100000, 100000, 'u-mgr-a', 'u-mgr-a', now(), 0, 'UNPAID');
INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, received_qty, unit_cost_mmk, line_total_mmk)
VALUES ('poitem-recv-1', 'po-recv', 'prod-2', 50, 50, 2000, 100000);

-- APPROVED PO awaiting receipt (receive_purchase_order replay test).
INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by, approved_by, approved_at)
VALUES ('po-appr', 'PO-TEST-0002', 'shop-a', 'sup-1', 'APPROVED', 5000, 5000, 'u-mgr-a', 'u-admin', now());
INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, unit_cost_mmk, line_total_mmk)
VALUES ('poitem-appr-1', 'po-appr', 'prod-1', 10, 500, 5000);

-- DRAFT PO (cashier approve-permission test).
INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by)
VALUES ('po-draft', 'PO-TEST-0003', 'shop-a', 'sup-1', 'DRAFT', 1000, 1000, 'u-mgr-a');
INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, unit_cost_mmk, line_total_mmk)
VALUES ('poitem-draft-1', 'po-draft', 'prod-1', 2, 500, 1000);

-- Shop B activity (cross-shop read isolation test).
INSERT INTO shifts (id, shop_id, cashier_id, started_at, opening_cash_mmk)
VALUES ('shift-b', 'shop-b', 'u-cash-b', now(), 0);
INSERT INTO sales (id, shop_id, shift_id, receipt_no, cashier_id, status, subtotal_mmk, discount_mmk, total_mmk, payment_method, paid_mmk, change_mmk)
VALUES ('sale-b1', 'shop-b', 'shift-b', 'SB-TEST-0001', 'u-cash-b', 'NORMAL', 1000, 0, 1000, 'CASH', 1000, 0);

SELECT test.logout() AS zz \gset

INSERT INTO test.initial_inventory SELECT shop_id, product_id, qty_base_units FROM inventory;

SELECT 'seeded: ' || (SELECT count(*) FROM users) || ' users, ' || (SELECT count(*) FROM products) || ' products, '
       || (SELECT count(*) FROM inventory) || ' inventory rows, ' || (SELECT count(*) FROM purchase_orders) || ' POs' AS seed;
