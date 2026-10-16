-- Seed ONE synthetic organization (run once per org by suites/seed.ts).
-- Superuser session; synthetic data only. Every free-text value carries the
-- org's canary token (:can) so the leak scanner can recognise it in any
-- response another org receives. Auth ids are REAL GoTrue users created just
-- before through the GoTrue admin API.
--   psql vars: p (id prefix, e.g. iso-b), org, can, au_admin, au_mgr, au_mgr2,
--              au_cash, au_buyer, au_deact, price (canary price, integer)
\set ON_ERROR_STOP on
SET client_min_messages = warning;

INSERT INTO organizations (id, name) VALUES (:'org', 'Org ' || :'can');
INSERT INTO shops (id, code, name, address, org_id) VALUES
  (:'p' || '-shop1', upper(:'can') || '1', 'Shop one ' || :'can', 'Street ' || :'can', :'org'),
  (:'p' || '-shop2', upper(:'can') || '2', 'Shop two ' || :'can', 'Road ' || :'can', :'org');

-- users: trusted server identity (073), exactly like the platform console
SET ROLE service_role;
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  (:'p' || '-admin', 'Admin ' || :'can', 'admin.' || :'can' || '@qa.invalid', 'ADMIN', NULL, :'au_admin', :'org');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id)
SELECT * FROM (VALUES
  (:'p' || '-mgr',   'Manager ' || :'can',  'mgr.' || :'can' || '@qa.invalid',   'MANAGER', :'p' || '-shop1', NULLIF(:'au_mgr', '')::uuid,   :'org'),
  (:'p' || '-mgr2',  'Manager2 ' || :'can', 'mgr2.' || :'can' || '@qa.invalid',  'MANAGER', :'p' || '-shop2', NULLIF(:'au_mgr2', '')::uuid,  :'org'),
  (:'p' || '-cash',  'Cashier ' || :'can',  'cash.' || :'can' || '@qa.invalid',  'CASHIER', :'p' || '-shop1', NULLIF(:'au_cash', '')::uuid,  :'org'),
  (:'p' || '-buyer', 'Buyer ' || :'can',    'buyer.' || :'can' || '@qa.invalid', 'BUYER',   :'p' || '-shop1', NULLIF(:'au_buyer', '')::uuid, :'org'),
  (:'p' || '-deact', 'Former ' || :'can',   'deact.' || :'can' || '@qa.invalid', 'CASHIER', :'p' || '-shop2', NULLIF(:'au_deact', '')::uuid, :'org')
) v(id, name, email, role, shop_id, auth_id, org_id) WHERE v.auth_id IS NOT NULL;
UPDATE users SET is_active = false WHERE id = :'p' || '-deact';
RESET ROLE;

-- catalog "as the org's ADMIN" (068 fills org_id from the caller)
SELECT set_config('request.jwt.claims', json_build_object('sub', :'au_admin', 'role', 'authenticated')::text, false),
       set_config('request.jwt.claim.sub', :'au_admin', false) \gset
INSERT INTO categories (id, name, color) VALUES (:'p' || '-cat', 'Category ' || :'can', '#123456');
INSERT INTO brands (id, category_id, name) VALUES (:'p' || '-brand', :'p' || '-cat', 'Brand ' || :'can');
INSERT INTO unit_types (id, name, abbreviation) VALUES (:'p' || '-ut', 'Carton ' || :'can', 'c' || :'can');
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES
  (:'p' || '-prod1', 'SKU-' || :'can' || '-1', 'Product one ' || :'can', 'Category ' || :'can', 'pcs', :'price', 600),
  (:'p' || '-prod2', 'SKU-' || :'can' || '-2', 'Product two ' || :'can', 'Category ' || :'can', 'pcs', :'price' + 1, 700),
  (:'p' || '-prod3', 'SKU-' || :'can' || '-3', 'Product three ' || :'can', 'Category ' || :'can', 'pcs', :'price' + 2, 800);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk) VALUES
  (:'p' || '-unit1', :'p' || '-prod1', 'pcs', 1, true, true, :'price', 600),
  (:'p' || '-unit2', :'p' || '-prod2', 'pcs', 1, true, true, :'price' + 1, 700),
  (:'p' || '-unit3', :'p' || '-prod3', 'pcs', 1, true, true, :'price' + 2, 800),
  (:'p' || '-unit1b', :'p' || '-prod1', 'box ' || :'can', 12, false, true, :'price' * 12, 7200);
INSERT INTO product_barcodes (id, product_id, value, type) VALUES
  (:'p' || '-bc1', :'p' || '-prod1', :'bc', 'EAN13');
INSERT INTO suppliers (id, code, name, contact_person, phone, email, address, notes) VALUES
  (:'p' || '-sup', 'SUP-' || upper(:'can'), 'Supplier ' || :'can', 'Contact ' || :'can', '09' || :'price',
   'supplier.' || :'can' || '@qa.invalid', 'Supplier street ' || :'can', 'Notes ' || :'can');
INSERT INTO supplier_products (supplier_id, product_id) VALUES (:'p' || '-sup', :'p' || '-prod1');
INSERT INTO price_tiers (id, product_id, shop_id, min_qty, price_mmk, created_by)
  VALUES (:'p' || '-tier1', :'p' || '-prod1', :'p' || '-shop1', 10, :'price' - 1, :'p' || '-mgr');
INSERT INTO product_unit_prices (id, product_unit_id, price_level_id, price_mmk)
  SELECT :'p' || '-pup1', :'p' || '-unit1', id, :'price' FROM price_levels WHERE org_id = :'org' AND is_default LIMIT 1;
UPDATE business_profile SET business_name = 'Business ' || :'can', email = 'shop.' || :'can' || '@qa.invalid',
  phone = '09' || :'price', address = 'HQ ' || :'can', tagline = 'Tagline ' || :'can',
  logo_url = 'http://127.0.0.1/storage/v1/object/public/product-images/products/brand/' || :'p' || '-logo.jpg'
  WHERE org_id = :'org';
SELECT set_config('request.jwt.claims', '', false), set_config('request.jwt.claim.sub', '', false) \gset

-- stock (inventory rows were created by the 068 same-org trigger)
UPDATE inventory SET qty_base_units = 500 WHERE shop_id IN (:'p' || '-shop1', :'p' || '-shop2');

SELECT 'seeded ' || :'org' || ': ' || (SELECT count(*) FROM users WHERE org_id = :'org') || ' users, '
  || (SELECT count(*) FROM products WHERE org_id = :'org') || ' products, '
  || (SELECT count(*) FROM inventory i JOIN shops s ON s.id = i.shop_id WHERE s.org_id = :'org') || ' inventory rows';
