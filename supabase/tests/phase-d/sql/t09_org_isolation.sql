-- t09: ORGANIZATION isolation (Phase G audit). Seeds a second organization
-- ("org-two": shops shop-x / shop-y, ADMIN u-admin-x, MANAGER u-mgr-x /
-- u-mgr-y, CASHIER u-cash-x, catalog, inventory, supplier, POs, transfers,
-- refund requests, a supplier payment, storage objects) and then, as org-A
-- users (ADMIN u-admin, MANAGER u-mgr-a, CASHIERs), attempts every cross-org
-- read, direct write and mutating RPC. test.finding* records an isolation
-- gap as FINDING (expected on the schema before 068; must PASS after 068-072);
-- test.check records positive controls that must hold in both states.
-- Runs LAST: the org-B rows would otherwise shift the earlier global counts.
\set ON_ERROR_STOP on
\set AX  'a0000000-0000-4000-8000-000000000011'
\set MX  'a0000000-0000-4000-8000-000000000012'
\set CX  'a0000000-0000-4000-8000-000000000013'
\set MY  'a0000000-0000-4000-8000-000000000014'
\set AA  'a0000000-0000-4000-8000-000000000001'
\set MA  'a0000000-0000-4000-8000-000000000002'
\set CA1 'a0000000-0000-4000-8000-000000000003'
\set CA2 'a0000000-0000-4000-8000-000000000004'
SELECT test.logout() AS zz \gset

-- ============================================================
-- 0. Seed org B (superuser; triggers fire, RLS bypassed)
-- ============================================================
INSERT INTO organizations (id, name) VALUES ('org-two', 'Org Two');
INSERT INTO shops (id, code, name, address, org_id) VALUES
  ('shop-x', 'SX', 'Shop X', 'X Street', 'org-two'),
  ('shop-y', 'SY', 'Shop Y', 'Y Street', 'org-two');
INSERT INTO auth.users (id, email) VALUES
  (:'AX', 'admin-x@two.local'), (:'MX', 'mgr-x@two.local'), (:'CX', 'cash-x@two.local'), (:'MY', 'mgr-y@two.local');
-- 047's privilege-column trigger only lets an ADMIN session create an ADMIN
-- row once users is non-empty (it does not look at the org), so the org-B
-- ADMIN is inserted under org A's ADMIN claims. NB: the same trigger blocks
-- the platform console's service-role insert of a new org's ADMIN - see the
-- audit doc.
SELECT test.login(:'AA') AS zz \gset
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-admin-x', 'Admin X', 'admin-x@two.local', 'ADMIN', NULL, :'AX', 'org-two');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-mgr-x', 'Manager X', 'mgr-x@two.local', 'MANAGER', 'shop-x', :'MX', 'org-two'),
  ('u-mgr-y', 'Manager Y', 'mgr-y@two.local', 'MANAGER', 'shop-y', :'MY', 'org-two');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-cash-x', 'Cashier X', 'cash-x@two.local', 'CASHIER', 'shop-x', :'CX', 'org-two');

-- catalog rows "as the org-B ADMIN" so 068's fill-from-caller triggers resolve org-two
SELECT test.login(:'AX') AS zz \gset
INSERT INTO categories (id, name, color) VALUES ('cat-x', 'Cat X', '#000000');
INSERT INTO brands (id, category_id, name) VALUES ('brand-x', 'cat-x', 'Brand X');
INSERT INTO unit_types (id, name, abbreviation) VALUES ('ut-x', 'Carton X', 'ctnx');
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES
  ('prod-x1', 'SKUX1', 'Product X1', 'Cat X', 'pcs', 1000, 600),
  ('prod-x2', 'SKUX2', 'Product X2', 'Cat X', 'pcs', 2000, 1200);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk) VALUES
  ('unit-x1', 'prod-x1', 'pcs', 1, true, true, 1000, 600),
  ('unit-x2', 'prod-x2', 'pcs', 1, true, true, 2000, 1200);
INSERT INTO product_barcodes (id, product_id, value, type) VALUES ('bc-x1', 'prod-x1', '8850000000017', 'EAN13');
INSERT INTO suppliers (id, code, name) VALUES ('sup-x', 'SUPX', 'Supplier X');
INSERT INTO supplier_products (supplier_id, product_id) VALUES ('sup-x', 'prod-x1');
INSERT INTO price_tiers (id, product_id, shop_id, min_qty, price_mmk, created_by) VALUES ('tier-x1', 'prod-x1', 'shop-x', 10, 900, 'u-mgr-x');
-- Global uniqueness on price_levels.code and "one active default" blocks org B
-- from having its own Retail default before 068 (FINDING); fall back to a
-- non-default level so the later write tests have an org-B row to target.
SELECT test.finding_succeeds('org B can create its own default RETAIL price level (per-org uniqueness)',
  $q$INSERT INTO price_levels (id, code, name, is_default, is_active) VALUES ('pl-x-retail', 'RETAIL', 'Retail', true, true)$q$);
INSERT INTO price_levels (id, code, name, is_default, is_active)
SELECT 'pl-x-retail', 'RETAILX', 'Retail X', false, true WHERE NOT EXISTS (SELECT 1 FROM price_levels WHERE id = 'pl-x-retail');
INSERT INTO product_unit_prices (id, product_unit_id, price_level_id, price_mmk) VALUES ('pup-x1', 'unit-x1', 'pl-x-retail', 1000);
SELECT test.logout() AS zz \gset

-- before 068 business_profile is a schema-only singleton with no row in the
-- harness; give the "shared row" something to show. After 068 the
-- organizations trigger has already seeded one row per org.
INSERT INTO business_profile (id) SELECT 'default' WHERE NOT test.col_exists('business_profile', 'org_id');

-- inventory rows were auto-created by the products trigger (before 068: for
-- EVERY shop of every org; after: org-two shops only)
UPDATE inventory SET qty_base_units = 10 WHERE shop_id IN ('shop-x', 'shop-y') AND product_id IN ('prod-x1', 'prod-x2');
-- cross-org pollution row (exists only before 068): give it stock so a sale of
-- org B's product in org A's shop is demonstrably possible
UPDATE inventory SET qty_base_units = 5 WHERE shop_id = 'shop-a' AND product_id = 'prod-x1';
INSERT INTO inventory_movements (id, shop_id, product_id, type, qty_change, qty_before, qty_after, reason, created_by)
VALUES ('mv-x1', 'shop-x', 'prod-x1', 'ADJUSTMENT', 10, 0, 10, 'seed', 'u-mgr-x');

INSERT INTO shifts (id, shop_id, cashier_id, started_at, opening_cash_mmk) VALUES ('shift-x', 'shop-x', 'u-cash-x', now(), 0);
INSERT INTO sales (id, shop_id, shift_id, receipt_no, cashier_id, status, subtotal_mmk, discount_mmk, total_mmk, payment_method, paid_mmk, change_mmk)
VALUES ('sale-x1', 'shop-x', 'shift-x', 'SX-TEST-0001', 'u-cash-x', 'NORMAL', 1000, 0, 1000, 'CASH', 1000, 0),
       ('sale-x2', 'shop-x', 'shift-x', 'SX-TEST-0002', 'u-cash-x', 'NORMAL', 1000, 0, 1000, 'CASH', 1000, 0),
       ('sale-x3', 'shop-x', 'shift-x', 'SX-TEST-0003', 'u-cash-x', 'NORMAL', 1000, 0, 1000, 'CASH', 1000, 0),
       ('sale-x4', 'shop-x', 'shift-x', 'SX-TEST-0004', 'u-cash-x', 'NORMAL', 1000, 0, 1000, 'CASH', 1000, 0);
INSERT INTO sale_items (id, sale_id, product_id, qty_units, unit_price_mmk, line_total_mmk) VALUES
  ('si-x1', 'sale-x1', 'prod-x1', 1, 1000, 1000), ('si-x2', 'sale-x2', 'prod-x1', 1, 1000, 1000),
  ('si-x3', 'sale-x3', 'prod-x1', 1, 1000, 1000), ('si-x4', 'sale-x4', 'prod-x1', 1, 1000, 1000);
INSERT INTO reprint_logs (id, sale_id, printed_by) VALUES ('rp-x1', 'sale-x1', 'u-cash-x');
INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, items, status) VALUES
  ('rvr-x-pending',  'sale-x2', 'shop-x', 'PARTIAL', 'x', 'u-cash-x', '[{"productId":"prod-x1","qtyUnits":1,"amountMmk":1000}]', 'REQUESTED'),
  ('rvr-x-pending2', 'sale-x3', 'shop-x', 'PARTIAL', 'x', 'u-cash-x', '[{"productId":"prod-x1","qtyUnits":1,"amountMmk":1000}]', 'REQUESTED'),
  ('rvr-x-void',     'sale-x4', 'shop-x', 'VOID',    'x', 'u-cash-x', '[]', 'REQUESTED');

INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by, received_by, received_at, paid_mmk, payment_status)
VALUES ('po-x-recv', 'PO-X-0001', 'shop-x', 'sup-x', 'RECEIVED', 50000, 50000, 'u-mgr-x', 'u-mgr-x', now(), 10000, 'PARTIAL');
INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, received_qty, unit_cost_mmk, line_total_mmk)
VALUES ('poi-x-recv', 'po-x-recv', 'prod-x1', 50, 50, 1000, 50000);
INSERT INTO supplier_payments (id, supplier_id, purchase_order_id, shop_id, amount_mmk, payment_method, created_by)
VALUES ('suppay-x1', 'sup-x', 'po-x-recv', 'shop-x', 10000, 'CASH', 'u-mgr-x');
INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by, approved_by, approved_at)
VALUES ('po-x-appr', 'PO-X-0002', 'shop-x', 'sup-x', 'APPROVED', 5000, 5000, 'u-mgr-x', 'u-admin-x', now());
INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, unit_cost_mmk, line_total_mmk)
VALUES ('poi-x-appr', 'po-x-appr', 'prod-x1', 5, 1000, 5000);
INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by) VALUES
  ('po-x-draft',  'PO-X-0003', 'shop-x', 'sup-x', 'DRAFT', 1000, 1000, 'u-mgr-x'),
  ('po-x-draft2', 'PO-X-0004', 'shop-x', 'sup-x', 'DRAFT', 1000, 1000, 'u-mgr-x');
INSERT INTO purchase_order_items (id, purchase_order_id, product_id, ordered_qty, unit_cost_mmk, line_total_mmk) VALUES
  ('poi-x-draft', 'po-x-draft', 'prod-x1', 1, 1000, 1000), ('poi-x-draft2', 'po-x-draft2', 'prod-x1', 1, 1000, 1000);

INSERT INTO stock_transfers (id, transfer_no, from_shop_id, to_shop_id, status, created_by, approved_by, approved_at, dispatched_by, dispatched_at) VALUES
  ('tr-x-pending',  'TR-X-0001', 'shop-x', 'shop-y', 'PENDING',    'u-mgr-x', NULL, NULL, NULL, NULL),
  ('tr-x-pending2', 'TR-X-0002', 'shop-x', 'shop-y', 'PENDING',    'u-mgr-x', NULL, NULL, NULL, NULL),
  ('tr-x-pending3', 'TR-X-0003', 'shop-x', 'shop-y', 'PENDING',    'u-mgr-x', NULL, NULL, NULL, NULL),
  ('tr-x-appr',     'TR-X-0004', 'shop-x', 'shop-y', 'APPROVED',   'u-mgr-x', 'u-admin-x', now(), NULL, NULL),
  ('tr-x-transit',  'TR-X-0005', 'shop-x', 'shop-y', 'IN_TRANSIT', 'u-mgr-x', 'u-admin-x', now(), 'u-mgr-x', now());
INSERT INTO stock_transfer_items (id, transfer_id, product_id, requested_qty, approved_qty) VALUES
  ('tri-x1', 'tr-x-pending', 'prod-x1', 1, NULL), ('tri-x2', 'tr-x-pending2', 'prod-x1', 1, NULL), ('tri-x3', 'tr-x-pending3', 'prod-x1', 1, NULL),
  ('tri-x4', 'tr-x-appr', 'prod-x1', 1, 1), ('tri-x5', 'tr-x-transit', 'prod-x1', 1, 1);

INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id) VALUES
  ('audit-x1', 'shop-x', 'u-mgr-x', 'PO_CREATED', 'x', 'PurchaseOrder', 'po-x-draft'),
  ('audit-x2', NULL,     'u-mgr-x', 'PRODUCT_EDIT', 'x', 'Product', 'prod-x1');

-- storage: one object per org, stamped with its uploader like storage-api does
INSERT INTO storage.objects (bucket_id, name, owner, owner_id) VALUES
  ('product-images', 'products/prod-x1/1.webp', :'MX', :'MX'),
  ('product-images', 'products/prod-1/1.webp',  :'MA', :'MA');

SELECT 'seeded org-two: ' || (SELECT count(*) FROM users WHERE org_id = 'org-two') || ' users, '
  || (SELECT count(*) FROM products WHERE id LIKE 'prod-x%') || ' products, '
  || (SELECT count(*) FROM inventory WHERE shop_id = 'shop-x') || ' shop-x inventory rows, '
  || (SELECT count(*) FROM inventory WHERE shop_id = 'shop-a' AND product_id LIKE 'prod-x%') || ' cross-org inventory rows in shop-a' AS seed;

-- ============================================================
-- 1. Positive controls: each org still sees and operates on its own data
-- ============================================================
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.check('org B ADMIN: sees own 2 shops', (SELECT count(*) FROM shops WHERE org_id = 'org-two') = 2);
SELECT test.check('org B ADMIN: sees own 2 products', (SELECT count(*) FROM products WHERE id LIKE 'prod-x%') = 2);
SELECT test.check('org B ADMIN: sees own 4 users', (SELECT count(*) FROM users WHERE org_id = 'org-two') = 4);
SELECT test.check('org B ADMIN: sees shop-x inventory', (SELECT count(*) FROM inventory WHERE shop_id = 'shop-x') >= 2);
SELECT test.check('org B ADMIN: sees own 4 purchase orders', (SELECT count(*) FROM purchase_orders WHERE shop_id = 'shop-x') = 4);
SELECT test.check('org B ADMIN: sees own supplier + payment', (SELECT count(*) FROM suppliers WHERE id = 'sup-x') = 1 AND (SELECT count(*) FROM supplier_payments WHERE id = 'suppay-x1') = 1);
SELECT test.check('org B ADMIN: sees own audit rows (shop + shop-less)', (SELECT count(*) FROM audit_logs WHERE id IN ('audit-x1', 'audit-x2')) = 2);
SELECT test.check('org B ADMIN: sees exactly one business_profile row', (SELECT count(*) FROM business_profile) = 1);
RESET ROLE;
SELECT test.login(:'MX') AS zz \gset
SET ROLE authenticated;
SELECT test.check('org B MANAGER: sees own catalog + shop inventory + own cashier',
  (SELECT count(*) FROM products WHERE id LIKE 'prod-x%') = 2
  AND (SELECT count(*) FROM inventory WHERE shop_id = 'shop-x') >= 2
  AND (SELECT count(*) FROM users WHERE id = 'u-cash-x') = 1);
RESET ROLE;
SELECT test.login(:'CX') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-x', 'shift-x', 'CASH', 1000, 0, '[{"product_id":"prod-x1","qty":1}]'::jsonb, NULL,
  '99999999-0000-4000-8000-000000000001') AS sx \gset
SELECT test.check('org B CASHIER: complete_sale in own shop succeeds', (:'sx'::jsonb->'sale'->>'shopId') = 'shop-x');
SELECT test.setvar('sale_x_new', :'sx'::jsonb->'sale'->>'id') AS zz \gset
RESET ROLE;
SELECT test.finding('org B sale is priced through org B''s own default price level (not org A''s)',
  (SELECT price_level_id FROM sale_items WHERE sale_id = test.var('sale_x_new') LIMIT 1) = 'pl-x-retail',
  'price_level_id=' || COALESCE((SELECT price_level_id FROM sale_items WHERE sale_id = test.var('sale_x_new') LIMIT 1), 'NULL'));

SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('org A ADMIN: still sees own shops / products / inventory / users / POs',
  (SELECT count(*) FROM shops WHERE org_id = 'org-test') >= 2
  AND (SELECT count(*) FROM products WHERE id IN ('prod-1', 'prod-2', 'prod-3')) = 3
  AND (SELECT count(*) FROM inventory WHERE shop_id = 'shop-a' AND product_id IN ('prod-1', 'prod-2', 'prod-3')) = 3
  AND (SELECT count(*) FROM users WHERE org_id = 'org-test') >= 6
  AND (SELECT count(*) FROM purchase_orders WHERE shop_id = 'shop-a') = 4);
SELECT public.open_shift('shop-a', 0, NULL, NULL, '99999999-0000-4000-8000-000000000002') AS osa \gset
SELECT test.check('org A ADMIN: open_shift on own shop still works (ADMIN all-shops-in-org)', (:'osa'::jsonb->'shift'->>'shopId') = 'shop-a');
-- close it again: one open shift per cashier, and §4 needs ADMIN A free to try org B's shop
SELECT public.close_shift(:'osa'::jsonb->'shift'->>'id', 0, NULL, NULL, NULL, '99999999-0000-4000-8000-000000000004') AS csa \gset
SELECT test.check('org A ADMIN: close_shift on own shop still works', (:'csa'::jsonb->'shift'->>'endedAt') IS NOT NULL);
RESET ROLE;
SELECT test.login(:'MA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('org A MANAGER: adjust_stock on own shop/product still works',
  (public.adjust_stock('shop-a', 'prod-3', 'ADJUSTMENT', 1, 'control', NULL, NULL, NULL, NULL, '99999999-0000-4000-8000-000000000003')->'inventory'->>'shopId') = 'shop-a');
RESET ROLE;

-- ============================================================
-- 2. Cross-org READS as org A ADMIN (sees everything in org A; must see
--    nothing of org B)
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.finding('ADMIN A: organizations - org B row hidden',   (SELECT count(*) FROM organizations WHERE id = 'org-two') = 0);
SELECT test.finding('ADMIN A: shops - org B rows hidden',          (SELECT count(*) FROM shops WHERE org_id = 'org-two') = 0);
SELECT test.finding('ADMIN A: users - org B rows hidden',          (SELECT count(*) FROM users WHERE org_id = 'org-two') = 0);
SELECT test.finding('ADMIN A: products - org B rows hidden',       (SELECT count(*) FROM products WHERE id LIKE 'prod-x%') = 0);
SELECT test.finding('ADMIN A: categories - org B rows hidden',     (SELECT count(*) FROM categories WHERE id = 'cat-x') = 0);
SELECT test.finding('ADMIN A: brands - org B rows hidden',         (SELECT count(*) FROM brands WHERE id = 'brand-x') = 0);
SELECT test.finding('ADMIN A: unit_types - org B rows hidden',     (SELECT count(*) FROM unit_types WHERE id = 'ut-x') = 0);
SELECT test.finding('ADMIN A: price_levels - org B rows hidden',   (SELECT count(*) FROM price_levels WHERE id = 'pl-x-retail') = 0);
SELECT test.finding('ADMIN A: product_units - org B rows hidden',  (SELECT count(*) FROM product_units WHERE id LIKE 'unit-x%') = 0);
SELECT test.finding('ADMIN A: product_barcodes - org B rows hidden', (SELECT count(*) FROM product_barcodes WHERE id = 'bc-x1') = 0);
SELECT test.finding('ADMIN A: product_unit_prices - org B rows hidden', (SELECT count(*) FROM product_unit_prices WHERE id = 'pup-x1') = 0);
SELECT test.finding('ADMIN A: price_tiers - org B rows hidden',    (SELECT count(*) FROM price_tiers WHERE id = 'tier-x1') = 0);
SELECT test.finding('ADMIN A: suppliers - org B rows hidden',      (SELECT count(*) FROM suppliers WHERE id = 'sup-x') = 0);
SELECT test.finding('ADMIN A: supplier_products - org B rows hidden', (SELECT count(*) FROM supplier_products WHERE supplier_id = 'sup-x') = 0);
SELECT test.finding('ADMIN A: business_profile has an org dimension', test.col_exists('business_profile', 'org_id'));
SELECT test.finding('ADMIN A: inventory - org B rows hidden (same policy filters Realtime postgres_changes)', (SELECT count(*) FROM inventory WHERE shop_id IN ('shop-x', 'shop-y')) = 0);
SELECT test.finding('ADMIN A: inventory_movements - org B rows hidden', (SELECT count(*) FROM inventory_movements WHERE shop_id = 'shop-x') = 0);
SELECT test.finding('ADMIN A: sales - org B rows hidden',          (SELECT count(*) FROM sales WHERE shop_id = 'shop-x') = 0);
SELECT test.finding('ADMIN A: sale_items - org B rows hidden',     (SELECT count(*) FROM sale_items WHERE sale_id LIKE 'sale-x%') = 0);
SELECT test.finding('ADMIN A: shifts - org B rows hidden',         (SELECT count(*) FROM shifts WHERE shop_id = 'shop-x') = 0);
SELECT test.finding('ADMIN A: purchase_orders - org B rows hidden', (SELECT count(*) FROM purchase_orders WHERE shop_id = 'shop-x') = 0);
SELECT test.finding('ADMIN A: purchase_order_items - org B rows hidden', (SELECT count(*) FROM purchase_order_items WHERE purchase_order_id LIKE 'po-x%') = 0);
SELECT test.finding('ADMIN A: supplier_payments - org B rows hidden', (SELECT count(*) FROM supplier_payments WHERE shop_id = 'shop-x') = 0);
SELECT test.finding('ADMIN A: stock_transfers - org B rows hidden', (SELECT count(*) FROM stock_transfers WHERE from_shop_id = 'shop-x') = 0);
SELECT test.finding('ADMIN A: stock_transfer_items - org B rows hidden', (SELECT count(*) FROM stock_transfer_items WHERE transfer_id LIKE 'tr-x%') = 0);
SELECT test.finding('ADMIN A: refund_void_requests - org B rows hidden', (SELECT count(*) FROM refund_void_requests WHERE shop_id = 'shop-x') = 0);
SELECT test.finding('ADMIN A: reprint_logs - org B rows hidden',   (SELECT count(*) FROM reprint_logs WHERE id = 'rp-x1') = 0);
SELECT test.finding('ADMIN A: audit_logs - org B rows hidden (shop + shop-less)', (SELECT count(*) FROM audit_logs WHERE actor_id IN ('u-mgr-x', 'u-cash-x', 'u-admin-x')) = 0);
SELECT test.finding('ADMIN A: rbac_assignment_violations view does not list org B''s ADMIN',
  (SELECT count(*) FROM rbac_assignment_violations WHERE user_id = 'u-admin-x') = 0);
RESET ROLE;

-- ---- as org A MANAGER / CASHIER (shop-scoped already; the catalog + users/shops/orgs are the gap)
SELECT test.login(:'MA') AS zz \gset
SET ROLE authenticated;
SELECT test.finding('MANAGER A: org B catalog hidden (products/categories/brands/suppliers/unit_types/price_levels/units/barcodes)',
  (SELECT count(*) FROM products WHERE id LIKE 'prod-x%') = 0 AND (SELECT count(*) FROM categories WHERE id = 'cat-x') = 0
  AND (SELECT count(*) FROM brands WHERE id = 'brand-x') = 0 AND (SELECT count(*) FROM suppliers WHERE id = 'sup-x') = 0
  AND (SELECT count(*) FROM unit_types WHERE id = 'ut-x') = 0 AND (SELECT count(*) FROM price_levels WHERE id = 'pl-x-retail') = 0
  AND (SELECT count(*) FROM product_units WHERE id LIKE 'unit-x%') = 0 AND (SELECT count(*) FROM product_barcodes WHERE id = 'bc-x1') = 0);
SELECT test.finding('MANAGER A: org B shops hidden', (SELECT count(*) FROM shops WHERE org_id = 'org-two') = 0);
SELECT test.finding('MANAGER A: storage.objects - org B object not listable', (SELECT count(*) FROM storage.objects WHERE name LIKE 'products/prod-x1/%') = 0);
SELECT test.check('MANAGER A: storage.objects - own org object listable', (SELECT count(*) FROM storage.objects WHERE name = 'products/prod-1/1.webp') = 1);
SELECT test.finding('MANAGER A: storage.objects - cannot overwrite (UPDATE) org B object',
  test.affected($q$UPDATE storage.objects SET metadata = '{"pwned":true}' WHERE name LIKE 'products/prod-x1/%'$q$) = 0);
SELECT test.finding('MANAGER A: storage.objects - cannot DELETE org B object',
  test.affected($q$DELETE FROM storage.objects WHERE name LIKE 'products/prod-x1/%'$q$) = 0);
RESET ROLE;
SELECT test.login(:'CA1') AS zz \gset
SET ROLE authenticated;
SELECT test.finding('CASHIER A: org B ADMIN row hidden (056 "any ADMIN row" clause was global)', (SELECT count(*) FROM users WHERE id = 'u-admin-x') = 0);
SELECT test.finding('CASHIER A: org B organization row hidden', (SELECT count(*) FROM organizations WHERE id = 'org-two') = 0);
SELECT test.finding('CASHIER A: org B products hidden', (SELECT count(*) FROM products WHERE id LIKE 'prod-x%') = 0);
RESET ROLE;

-- ============================================================
-- 3. Cross-org DIRECT WRITES as org A ADMIN (RLS write policies)
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.finding('ADMIN A: UPDATE products of org B affects 0 rows',
  test.affected($q$UPDATE products SET name = 'pwned' WHERE id = 'prod-x1'$q$) = 0);
SELECT test.finding('ADMIN A: UPDATE shops of org B affects 0 rows',
  test.affected($q$UPDATE shops SET name = 'pwned' WHERE id = 'shop-x'$q$) = 0);
SELECT test.finding('ADMIN A: UPDATE users of org B affects 0 rows',
  test.affected($q$UPDATE users SET name = 'pwned' WHERE id = 'u-cash-x'$q$) = 0);
SELECT test.finding('ADMIN A: UPDATE suppliers of org B affects 0 rows',
  test.affected($q$UPDATE suppliers SET name = 'pwned' WHERE id = 'sup-x'$q$) = 0);
SELECT test.finding('ADMIN A: UPDATE categories / brands / unit_types / price_levels of org B affect 0 rows',
  test.affected($q$UPDATE categories SET name = 'pwned' WHERE id = 'cat-x'$q$) = 0
  AND test.affected($q$UPDATE brands SET name = 'pwned' WHERE id = 'brand-x'$q$) = 0
  AND test.affected($q$UPDATE unit_types SET name = 'pwned' WHERE id = 'ut-x'$q$) = 0
  AND test.affected($q$UPDATE price_levels SET name = 'pwned' WHERE id = 'pl-x-retail'$q$) = 0);
SELECT test.finding('ADMIN A: UPDATE product_units / product_unit_prices / price_tiers of org B affect 0 rows',
  test.affected($q$UPDATE product_units SET name = 'pwned' WHERE id = 'unit-x1'$q$) = 0
  AND test.affected($q$UPDATE product_unit_prices SET price_mmk = 1 WHERE id = 'pup-x1'$q$) = 0
  AND test.affected($q$UPDATE price_tiers SET price_mmk = 1 WHERE id = 'tier-x1'$q$) = 0);
-- control: the update always touches exactly one row (the shared singleton
-- before 068, own org's row after); whether org B sees it is the finding below
SELECT test.check('ADMIN A: UPDATE business_profile touches exactly one row',
  test.affected($q$UPDATE business_profile SET tagline = 'A-only'$q$) = 1);
SELECT test.finding_error('ADMIN A: INSERT product_units for an org B product is rejected',
  $q$INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk) VALUES ('unit-x1-a', 'prod-x1', 'box', 12, false, true, 11000)$q$,
  'row-level security');
SELECT test.finding_error('ADMIN A: INSERT supplier_products linking org B supplier is rejected',
  $q$INSERT INTO supplier_products (supplier_id, product_id) VALUES ('sup-x', 'prod-1')$q$, 'not found in your organization');
-- (a BUYER: the only shop role 020's trigger accepts without looking up the shop's manager)
SELECT test.finding_error('ADMIN A: INSERT a users row into org B (direct write) is rejected',
  $q$INSERT INTO users (id, name, email, role, shop_id, org_id) VALUES ('u-x-smuggled', 'Smuggled', 'sm@two.local', 'BUYER', 'shop-x', 'org-two')$q$,
  'row-level security');
-- collisions: global uniqueness lets org B block org A's codes/names/barcodes (and vice versa)
SELECT test.finding_succeeds('ADMIN A: can create supplier code SUPX although org B uses it (per-org uniqueness)',
  $q$INSERT INTO suppliers (id, code, name) VALUES ('sup-a-x', 'SUPX', 'Supplier X of A')$q$);
SELECT test.finding_succeeds('ADMIN A: can create a shop named "Shop X" although org B has one (per-org uniqueness)',
  $q$INSERT INTO shops (id, code, name, address, org_id) VALUES ('shop-a-x', 'SX', 'Shop X', 'A side', 'org-test')$q$);
SELECT test.finding_succeeds('ADMIN A: can create unit type "Carton X" although org B has one (per-org uniqueness)',
  $q$INSERT INTO unit_types (id, name, abbreviation) VALUES ('ut-a-x', 'Carton X', 'ctnx')$q$);
SELECT test.finding_succeeds('ADMIN A: can register barcode 8850000000017 on its own product although org B has it (per-org uniqueness)',
  $q$INSERT INTO product_barcodes (id, product_id, value, type) VALUES ('bc-a-dup', 'prod-1', '8850000000017', 'EAN13')$q$);
SELECT test.finding_succeeds('ADMIN A: can add a shop WITHOUT sending org_id (addShop() has failed since 059 made shops.org_id NOT NULL)',
  $q$INSERT INTO shops (id, code, name, address) VALUES ('shop-a3', 'SA3', 'Shop A3', 'A3 Street')$q$);
SELECT test.finding('ADMIN A: the new shop landed in org A', (SELECT org_id FROM shops WHERE id = 'shop-a3') = 'org-test');
SELECT test.finding_error('ADMIN A: INSERT product_barcodes for an org B product is rejected',
  $q$INSERT INTO product_barcodes (id, product_id, value, type) VALUES ('bc-x-a', 'prod-x1', '9990001', 'EAN13')$q$,
  'not found in your organization');
SELECT test.finding('ADMIN A: DELETE product_barcodes of org B affects 0 rows',
  test.affected($q$DELETE FROM product_barcodes WHERE id = 'bc-x1'$q$) = 0);
SELECT CASE WHEN test.col_exists('products', 'org_id')
  THEN test.finding_error('ADMIN A: INSERT products with org_id = org B is rejected',
         $q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk, org_id) VALUES ('prod-a-in-x', 'SKUAX', 'Smuggled', 'Cat X', 'pcs', 1, 1, 'org-two')$q$,
         'row-level security')
  ELSE test.finding('ADMIN A: INSERT products with org_id = org B is rejected', false, 'products has no org_id column') END;
RESET ROLE;
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.finding('org B ADMIN: its business_profile was not changed by org A''s update',
  (SELECT COALESCE(tagline, '') FROM business_profile LIMIT 1) <> 'A-only');
RESET ROLE;

-- ============================================================
-- 4. Cross-org RPC calls as org A users. Before 068-070 every call below
--    SUCCEEDS and mutates org B's data; after, the guard raises
--    "<Entity> not found in your organization" before any side effect.
-- ============================================================
\set k 99999999-0000-4000-8000-0000000001
SELECT test.login(:'CA2') AS zz \gset
SET ROLE authenticated;
SELECT test.finding_error('CASHIER A2: complete_sale of an org B PRODUCT in own shop (inventory row created cross-org by 046 trigger)',
  format($q$SELECT public.complete_sale('shop-a', %L, 'CASH', 5000, 0, '[{"product_id":"prod-x1","qty":1}]'::jsonb, NULL, '%s01')$q$, test.var('shift_a2'), :'k'),
  'Product not found in your organization');
RESET ROLE;
SELECT test.login(:'MA') AS zz \gset
SET ROLE authenticated;
SELECT test.finding_error('MANAGER A: adjust_stock of an org B product in own shop',
  format($q$SELECT public.adjust_stock('shop-a', 'prod-x1', 'ADJUSTMENT', 1, 'x', NULL, NULL, NULL, NULL, '%s02')$q$, :'k'),
  'Product not found in your organization');
SELECT test.expect_error('MANAGER A: complete_sale on org B shop blocked by shop scope (already true before the fix)',
  format($q$SELECT public.complete_sale('shop-x', 'shift-x', 'CASH', 1000, 0, '[{"product_id":"prod-x1","qty":1}]'::jsonb, NULL, '%s03')$q$, :'k'),
  'not');
RESET ROLE;

SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.finding_error('ADMIN A: open_shift on org B shop',
  format($q$SELECT public.open_shift('shop-x', 0, NULL, NULL, '%s04')$q$, :'k'), 'Shop not found in your organization');
RESET ROLE;
SELECT test.setvar('shift_ax', COALESCE((SELECT id FROM shifts WHERE cashier_id = 'u-admin' AND shop_id = 'shop-x' AND ended_at IS NULL LIMIT 1), 'none')) AS zz \gset
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.finding_error('ADMIN A: complete_sale in org B shop',
  format($q$SELECT public.complete_sale('shop-x', %L, 'CASH', 1000, 0, '[{"product_id":"prod-x1","qty":1}]'::jsonb, NULL, '%s05')$q$, test.var('shift_ax'), :'k'),
  'Shop not found in your organization');
SELECT test.finding_error('ADMIN A: adjust_stock in org B shop',
  format($q$SELECT public.adjust_stock('shop-x', 'prod-x1', 'ADJUSTMENT', 1, 'x', NULL, NULL, NULL, NULL, '%s06')$q$, :'k'), 'Shop not found in your organization');
SELECT test.finding_error('ADMIN A: create_purchase_order for org B shop',
  format($q$SELECT public.create_purchase_order('shop-x', 'sup-x', 'x', '[{"product_id":"prod-x1","ordered_qty":1,"unit_cost_mmk":100}]'::jsonb, '%s07')$q$, :'k'), 'Shop not found in your organization');
SELECT test.finding_error('ADMIN A: create_purchase_order with org B supplier',
  format($q$SELECT public.create_purchase_order('shop-a', 'sup-x', 'x', '[{"product_id":"prod-1","ordered_qty":1,"unit_cost_mmk":100}]'::jsonb, '%s08')$q$, :'k'), 'Supplier not found in your organization');
SELECT test.finding_error('ADMIN A: create_purchase_order with org B product',
  format($q$SELECT public.create_purchase_order('shop-a', 'sup-1', 'x', '[{"product_id":"prod-x1","ordered_qty":1,"unit_cost_mmk":100}]'::jsonb, '%s09')$q$, :'k'), 'Product not found in your organization');
SELECT test.finding_error('ADMIN A: approve_purchase_order of org B',
  format($q$SELECT public.approve_purchase_order('po-x-draft', '%s10')$q$, :'k'), 'Purchase order not found in your organization');
SELECT test.finding_error('ADMIN A: cancel_purchase_order of org B',
  format($q$SELECT public.cancel_purchase_order('po-x-draft2', 'x', '%s11')$q$, :'k'), 'Purchase order not found in your organization');
SELECT test.finding_error('ADMIN A: receive_purchase_order of org B',
  format($q$SELECT public.receive_purchase_order('po-x-appr', NULL, NULL, NULL, '%s12')$q$, :'k'), 'Purchase order not found in your organization');
SELECT test.finding_error('ADMIN A: record_supplier_payment on org B purchase order',
  format($q$SELECT public.record_supplier_payment('po-x-recv', 1000, 'CASH', NULL, NULL, NULL, NULL, '%s13')$q$, :'k'), 'Purchase order not found in your organization');
SELECT test.finding_error('ADMIN A: pay_supplier_lump_sum to org B supplier',
  format($q$SELECT public.pay_supplier_lump_sum('sup-x', 'shop-x', 1000, 'CASH', NULL, NULL, '%s14')$q$, :'k'), 'Supplier not found in your organization');
SELECT test.finding_error('ADMIN A: void_supplier_payment of org B',
  format($q$SELECT public.void_supplier_payment('suppay-x1', 'x', '%s15')$q$, :'k'), 'Supplier payment not found in your organization');
SELECT test.finding_error('ADMIN A: create_stock_transfer between org B shops',
  format($q$SELECT public.create_stock_transfer('shop-x', 'shop-y', 'x', '[{"product_id":"prod-x1","requested_qty":1}]'::jsonb, '%s16')$q$, :'k'), 'Shop not found in your organization');
SELECT test.finding_error('ADMIN A: approve_stock_transfer of org B',
  format($q$SELECT public.approve_stock_transfer('tr-x-pending', '%s17')$q$, :'k'), 'Stock transfer not found in your organization');
SELECT test.finding_error('ADMIN A: reject_stock_transfer of org B',
  format($q$SELECT public.reject_stock_transfer('tr-x-pending2', 'x', '%s18')$q$, :'k'), 'Stock transfer not found in your organization');
SELECT test.finding_error('ADMIN A: cancel_stock_transfer of org B',
  format($q$SELECT public.cancel_stock_transfer('tr-x-pending3', 'x', '%s19')$q$, :'k'), 'Stock transfer not found in your organization');
SELECT test.finding_error('ADMIN A: dispatch_stock_transfer of org B',
  format($q$SELECT public.dispatch_stock_transfer('tr-x-appr', NULL, NULL, '%s20')$q$, :'k'), 'Stock transfer not found in your organization');
SELECT test.finding_error('ADMIN A: receive_stock_transfer of org B',
  format($q$SELECT public.receive_stock_transfer('tr-x-transit', NULL, NULL, NULL, '%s21')$q$, :'k'), 'Stock transfer not found in your organization');
SELECT test.finding_error('ADMIN A: create_refund_void_request on org B sale',
  format($q$SELECT public.create_refund_void_request('sale-x1', 'PARTIAL', 'x', '[{"productId":"prod-x1","qtyUnits":1,"amountMmk":1000}]'::jsonb, NULL, NULL, '%s22')$q$, :'k'), 'Sale not found in your organization');
SELECT test.finding_error('ADMIN A: approve_refund_request of org B',
  format($q$SELECT public.approve_refund_request('rvr-x-pending', '%s23')$q$, :'k'), 'Request not found in your organization');
SELECT test.finding_error('ADMIN A: reject_refund_void_request of org B',
  format($q$SELECT public.reject_refund_void_request('rvr-x-pending2', 'x', '%s24')$q$, :'k'), 'Request not found in your organization');
SELECT test.finding_error('ADMIN A: approve_void_request of org B',
  format($q$SELECT public.approve_void_request('rvr-x-void', '%s25')$q$, :'k'), 'Request not found in your organization');
SELECT test.finding_error('ADMIN A: log_receipt_reprint of org B sale',
  format($q$SELECT public.log_receipt_reprint('sale-x1', '%s26')$q$, :'k'), 'Sale not found in your organization');
SELECT test.finding_error('ADMIN A: close_shift of org B cashier',
  format($q$SELECT public.close_shift('shift-x', 0, 'x', NULL, NULL, '%s27')$q$, :'k'), 'Shift not found in your organization');
SELECT test.finding_error('ADMIN A: create_app_user into org B shop',
  format($q$SELECT public.create_app_user('u-x-new', 'New X', 'nx@two.local', 'CASHIER', 'shop-x', NULL, NULL, NULL, '%s28')$q$, :'k'), 'Shop not found in your organization');
SELECT test.finding_error('ADMIN A: update_app_user of org B user',
  format($q$SELECT public.update_app_user('u-cash-x', 'Pwned', 'CASHIER', 'shop-x', NULL, NULL, '%s29')$q$, :'k'), 'User not found in your organization');
SELECT test.finding_error('ADMIN A: deactivate_app_user of org B user',
  format($q$SELECT public.deactivate_app_user('u-cash-x', false, '%s30')$q$, :'k'), 'User not found in your organization');
SELECT test.finding_error('ADMIN A: delete_product of org B',
  format($q$SELECT public.delete_product('prod-x2', '%s31')$q$, :'k'), 'Product not found in your organization');
SELECT test.finding_error('ADMIN A: update_supplier of org B',
  format($q$SELECT public.update_supplier('sup-x', 'SUPX', 'Pwned', NULL, NULL, NULL, NULL, NULL, NULL, '%s32')$q$, :'k'), 'Supplier not found in your organization');
SELECT test.finding_error('ADMIN A: create_product_image_upload_session for org B shop/product',
  $q$SELECT public.create_product_image_upload_session('shop-x', 'prod-x1')$q$, 'Shop not found in your organization');
SELECT test.finding_error('ADMIN A: log_audit_event naming org B shop',
  format($q$SELECT public.log_audit_event('PRODUCT_EDIT', 'x', 'Product', 'prod-x1', 'shop-x', '%s33')$q$, :'k'), 'Shop not found in your organization');
-- last: before the fix this re-homes an org A cashier as org B's manager and deactivates org B's manager
SELECT test.finding_error('ADMIN A: replace_manager of org B shop with an org A user',
  format($q$SELECT public.replace_manager('shop-x', 'u-cash-a2', '%s34')$q$, :'k'), 'Shop not found in your organization');
RESET ROLE;
SELECT test.logout() AS zz \gset

-- ============================================================
-- 5. Structural checks (what the fix must have put in place)
-- ============================================================
SELECT test.finding('inventory_sel policy carries an org term (Realtime postgres_changes uses this policy)',
  (SELECT qual LIKE '%app_org%' FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory' AND policyname = 'inventory_sel'));
-- all but: organizations_ins (bootstrap), product_image_upload_sessions_owner_select
-- (owner-only) and the 4 parent-inherit policies (sale_items, purchase_order_items,
-- stock_transfer_items, reprint_logs - scoped through their org-aware parent)
SELECT test.finding('every public policy except organizations_ins, upload-session owner and the 4 parent-inherit ones carries an org term',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
     AND (qual LIKE '%app_org%' OR qual LIKE '%org_id%' OR with_check LIKE '%app_org%' OR with_check LIKE '%org_id%'))
  = (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') - 6,
  'org-aware: ' || (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
     AND (qual LIKE '%app_org%' OR qual LIKE '%org_id%' OR with_check LIKE '%app_org%' OR with_check LIKE '%org_id%'))
  || ' of ' || (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'));
SELECT test.check('all public policies are PERMISSIVE and TO authenticated',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND (permissive <> 'PERMISSIVE' OR roles <> '{authenticated}')) = 0);
SELECT test.finding('app_can_for_shop() is org-aware for ADMIN',
  (SELECT prosrc LIKE '%app_shop_in_org%' FROM pg_proc WHERE proname = 'app_can_for_shop'));
SELECT test.finding('30 mutating RPCs carry the org guard',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc LIKE '%PERFORM public.app_require_org%') = 30,
  'guarded: ' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc LIKE '%PERFORM public.app_require_org%'));
SELECT test.finding('ensure_inventory_rows_* pair products and shops of the same org only',
  (SELECT prosrc LIKE '%org_id%' FROM pg_proc WHERE proname = 'ensure_inventory_rows_for_product')
  AND (SELECT prosrc LIKE '%org_id%' FROM pg_proc WHERE proname = 'ensure_inventory_rows_for_shop'));
SELECT CASE WHEN test.col_exists('products', 'org_id')
  THEN test.finding('no inventory row pairs a shop and a product of different orgs',
         test.eval_bigint('SELECT count(*) FROM inventory i JOIN shops s ON s.id = i.shop_id JOIN products p ON p.id = i.product_id WHERE s.org_id <> p.org_id') = 0)
  ELSE test.finding('no inventory row pairs a shop and a product of different orgs', false,
         'products has no org_id; ' || (SELECT count(*) FROM inventory WHERE shop_id IN ('shop-a','shop-b') AND product_id LIKE 'prod-x%') || ' org-B products have rows in org-A shops') END;
SELECT test.finding('rbac_assignment_violations runs with security_invoker',
  EXISTS (SELECT 1 FROM pg_class c, unnest(c.reloptions) o WHERE c.relname = 'rbac_assignment_violations' AND o IN ('security_invoker=on', 'security_invoker=true')));
SELECT test.finding('storage.objects: read/update/delete policies are org-aware',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND qual LIKE '%app_storage_owner_in_org%') = 3);
SELECT test.finding('business_profile is keyed per organization',
  EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
           WHERE c.conrelid = 'business_profile'::regclass AND c.contype = 'p' AND a.attname = 'org_id'));
SELECT test.check('sanity: org B rows exist when RLS is bypassed',
  (SELECT count(*) FROM shops WHERE org_id = 'org-two') = 2 AND (SELECT count(*) FROM products WHERE id = 'prod-x1') = 1);
SELECT test.logout() AS zz \gset
