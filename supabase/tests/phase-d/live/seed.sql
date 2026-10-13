-- Phase D live QA seed (run as supabase_admin on the self-hosted stack).
--
-- Every row is identifiable: ids start with qa-, emails end in @qa.invalid,
-- names start with "QA ". The auth side (auth.users) is created FIRST through
-- the GoTrue signup API by the test runner; their uuids come in as psql vars.
--
-- Required psql variables (-v):
--   ts          run stamp, digits only            e.g. 1760200000000
--   auth_admin  auth.users.id of qa-admin-<ts>@qa.invalid
--   auth_mgr    auth.users.id of qa-manager-<ts>@qa.invalid
--   auth_casha  auth.users.id of qa-cashier-a-<ts>@qa.invalid
--   auth_cashb  auth.users.id of qa-cashier-b-<ts>@qa.invalid
--
-- session_replication_role = replica for the whole transaction so that
--   (a) the 046 inventory auto-create triggers do NOT create rows for
--       real products x QA shops or QA products x real shops, and
--   (b) the 047 privilege guard / 020 assignment trigger do not block the
--       direct inserts (we still respect their rules: one ADMIN per org,
--       one active MANAGER per shop, CASHIERs only where a MANAGER exists).
-- Inventory rows are created explicitly for QA shops x QA products only.
--
-- Since 068 (org isolation): catalog tables carry `org_id NOT NULL`, filled
-- by a BEFORE INSERT trigger from the caller - which does NOT fire under
-- replica mode (and supabase_admin has no app org anyway), so every catalog
-- row below names the QA org explicitly. business_profile is one row per org,
-- normally seeded by the AFTER INSERT trigger on organizations (also
-- suppressed here), so the QA org's row is inserted explicitly with the same
-- shape the trigger would create (id 'default', every field NULL).
--
-- The RECEIVED purchase order with an outstanding balance is NOT seeded
-- here: the test creates it through the RPCs (create -> approve -> receive)
-- as the QA users, each call with its own idempotency key.
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO organizations (id, name, is_active)
VALUES ('qa-org-' || :'ts', 'QA Org ' || :'ts', true);

-- what organizations_seed_business_profile() (068) would have inserted
INSERT INTO business_profile (id, org_id) VALUES ('default', 'qa-org-' || :'ts');

-- Since 072, complete_sale resolves the default price level inside the
-- caller's organization only ("No active price level available" otherwise;
-- before 068 the QA tenant silently used the real org's global default).
-- Mirror the real org's default level (code 'retail', sort 10) for the QA org.
-- No product_unit_prices are seeded, so sales keep the legacy unit price.
INSERT INTO price_levels (id, code, name, is_default, is_active, sort_order, org_id)
VALUES ('qa-pl-retail-' || :'ts', 'retail', 'QA Retail', true, true, 10, 'qa-org-' || :'ts');

INSERT INTO shops (id, code, name, address, org_id, is_active) VALUES
  ('qa-shop-'  || :'ts', 'QA' || :'ts', 'QA Shop '     || :'ts', 'QA Street 1', 'qa-org-' || :'ts', true),
  ('qa-shop2-' || :'ts', 'QB' || :'ts', 'QA Shop Two ' || :'ts', 'QA Street 2', 'qa-org-' || :'ts', true);

-- ADMIN first (one per org), then the MANAGER, then the CASHIERs.
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id, is_active) VALUES
  ('qa-user-admin-' || :'ts', 'QA Admin', 'qa-admin-' || :'ts' || '@qa.invalid',
     'ADMIN', NULL, :'auth_admin'::uuid, 'qa-org-' || :'ts', true);
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id, is_active) VALUES
  ('qa-user-manager-' || :'ts', 'QA Manager', 'qa-manager-' || :'ts' || '@qa.invalid',
     'MANAGER', 'qa-shop-' || :'ts', :'auth_mgr'::uuid, 'qa-org-' || :'ts', true);
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id, is_active) VALUES
  ('qa-user-cashier-a-' || :'ts', 'QA Cashier A', 'qa-cashier-a-' || :'ts' || '@qa.invalid',
     'CASHIER', 'qa-shop-' || :'ts', :'auth_casha'::uuid, 'qa-org-' || :'ts', true),
  ('qa-user-cashier-b-' || :'ts', 'QA Cashier B', 'qa-cashier-b-' || :'ts' || '@qa.invalid',
     'CASHIER', 'qa-shop-' || :'ts', :'auth_cashb'::uuid, 'qa-org-' || :'ts', true);

INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk, is_active, org_id) VALUES
  ('qa-prod-1-' || :'ts', 'QA1-' || :'ts', 'QA Product One',   'QA', 'pcs', 1000,  600, true, 'qa-org-' || :'ts'),
  ('qa-prod-2-' || :'ts', 'QA2-' || :'ts', 'QA Product Two',   'QA', 'pcs', 2000, 1200, true, 'qa-org-' || :'ts'),
  ('qa-prod-3-' || :'ts', 'QA3-' || :'ts', 'QA Product Three', 'QA', 'pcs', 3000, 1800, true, 'qa-org-' || :'ts');

-- Default sellable unit per product: base_quantity 1, sale price (legacy_sale_price path).
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk) VALUES
  ('qa-unit-1-' || :'ts', 'qa-prod-1-' || :'ts', 'pcs', 1, true, true, 1000,  600),
  ('qa-unit-2-' || :'ts', 'qa-prod-2-' || :'ts', 'pcs', 1, true, true, 2000, 1200),
  ('qa-unit-3-' || :'ts', 'qa-prod-3-' || :'ts', 'pcs', 1, true, true, 3000, 1800);

-- Explicit inventory: QA shop x QA products only (100 each); the second QA
-- shop gets one row (realtime cross-shop isolation check).
INSERT INTO inventory (shop_id, product_id, qty_base_units) VALUES
  ('qa-shop-'  || :'ts', 'qa-prod-1-' || :'ts', 100),
  ('qa-shop-'  || :'ts', 'qa-prod-2-' || :'ts', 100),
  ('qa-shop-'  || :'ts', 'qa-prod-3-' || :'ts', 100),
  ('qa-shop2-' || :'ts', 'qa-prod-1-' || :'ts',  50);

INSERT INTO suppliers (id, code, name, is_active, org_id)
VALUES ('qa-sup-' || :'ts', 'QASUP' || :'ts', 'QA Supplier ' || :'ts', true, 'qa-org-' || :'ts');

COMMIT;

SELECT 'seeded ts=' || :'ts'
  || ' orgs=' || (SELECT count(*) FROM organizations WHERE id = 'qa-org-' || :'ts')
  || ' business_profile=' || (SELECT count(*) FROM business_profile WHERE org_id = 'qa-org-' || :'ts')
  || ' default_price_level=' || (SELECT count(*) FROM price_levels WHERE org_id = 'qa-org-' || :'ts' AND is_default AND is_active)
  || ' shops=' || (SELECT count(*) FROM shops WHERE id LIKE 'qa-shop%-' || :'ts')
  || ' users=' || (SELECT count(*) FROM users WHERE id LIKE 'qa-user-%-' || :'ts' AND auth_id IS NOT NULL)
  || ' products=' || (SELECT count(*) FROM products WHERE id LIKE 'qa-prod-%-' || :'ts')
  || ' units=' || (SELECT count(*) FROM product_units WHERE id LIKE 'qa-unit-%-' || :'ts')
  || ' inventory=' || (SELECT count(*) FROM inventory WHERE shop_id LIKE 'qa-shop%-' || :'ts')
  || ' inventory_cross_rows=' || (SELECT count(*) FROM inventory
        WHERE (shop_id LIKE 'qa-%' AND product_id NOT LIKE 'qa-%')
           OR (product_id LIKE 'qa-%' AND shop_id NOT LIKE 'qa-%'))
  || ' suppliers=' || (SELECT count(*) FROM suppliers WHERE id = 'qa-sup-' || :'ts')
  || ' catalog_rows_outside_qa_org=' || (
        (SELECT count(*) FROM products  WHERE id LIKE 'qa-prod-%-' || :'ts' AND org_id <> 'qa-org-' || :'ts')
      + (SELECT count(*) FROM suppliers WHERE id = 'qa-sup-' || :'ts'     AND org_id <> 'qa-org-' || :'ts')) AS seed;
