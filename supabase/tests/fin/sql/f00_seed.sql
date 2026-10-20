-- f00: synthetic fixtures for the financial tests (runs as the superuser after
-- phase-d t01..t09, so org-test / org-two and their data already exist).
-- Shop F (org-test) is new and used only by f01..f05, so its figures are
-- hand-computable. Shop V holds the high-volume history (f04).
\set ON_ERROR_STOP on

-- UUIDv7 for op_execute keys (086 accepts v7 only through the executor).
CREATE OR REPLACE FUNCTION test.uuid7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT (lpad(to_hex((extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0')
          || '7' || substr(md5(random()::text), 1, 3)
          || '8' || substr(md5(random()::text), 1, 15))::uuid
$$;
GRANT EXECUTE ON FUNCTION test.uuid7() TO anon, authenticated, service_role;

-- Business-day anchors: B = today's Asia/Yangon midnight (a past instant,
-- less than 24 h ago, so B - 3 h is inside resolve_event_time's 48 h window).
SELECT test.setvar('B', (date_trunc('day', now() AT TIME ZONE 'Asia/Yangon') AT TIME ZONE 'Asia/Yangon')::text);
SELECT test.setvar('D2', ((now() AT TIME ZONE 'Asia/Yangon')::date)::text);
SELECT test.setvar('D1', ((now() AT TIME ZONE 'Asia/Yangon')::date - 1)::text);

INSERT INTO shops (id, code, name, address, org_id) VALUES
  ('shop-f', 'SF', 'Shop F', 'F Street', 'org-test'),
  ('shop-v', 'SV', 'Shop V', 'V Street', 'org-test');

INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'mgr-f@test.local'),
  ('f0000000-0000-4000-8000-000000000002', 'cash-f1@test.local'),
  ('f0000000-0000-4000-8000-000000000003', 'cash-f2@test.local'),
  ('f0000000-0000-4000-8000-000000000004', 'view-f@test.local'),
  ('f0000000-0000-4000-8000-000000000005', 'gone-f@test.local'),
  ('f0000000-0000-4000-8000-000000000006', 'mgr-v@test.local');

SELECT test.login('a0000000-0000-4000-8000-000000000001') AS zz \gset
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-mgr-f', 'Manager F', 'mgr-f@test.local', 'MANAGER', 'shop-f', 'f0000000-0000-4000-8000-000000000001', 'org-test'),
  ('u-mgr-v', 'Manager V', 'mgr-v@test.local', 'MANAGER', 'shop-v', 'f0000000-0000-4000-8000-000000000006', 'org-test');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-cash-f1', 'Cashier F1', 'cash-f1@test.local', 'CASHIER', 'shop-f', 'f0000000-0000-4000-8000-000000000002', 'org-test'),
  ('u-cash-f2', 'Cashier F2', 'cash-f2@test.local', 'CASHIER', 'shop-f', 'f0000000-0000-4000-8000-000000000003', 'org-test'),
  ('u-gone-f',  'Former F',   'gone-f@test.local',  'CASHIER', 'shop-f', 'f0000000-0000-4000-8000-000000000005', 'org-test');
-- a cashier granted shop-wide sale reading and shop reports, but no refund
-- approval: RLS shows every sale of the shop and only their own refund rows
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id, granted_permissions) VALUES
  ('u-view-f', 'Viewer F', 'view-f@test.local', 'CASHIER', 'shop-f', 'f0000000-0000-4000-8000-000000000004', 'org-test',
   ARRAY['sale:view', 'report:shop_sales']);
UPDATE users SET is_active = false WHERE id = 'u-gone-f';

-- a product with no cost (COGS must be reported incomplete, never guessed)
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES
  ('prod-nc', 'SKUNC', 'No-Cost Product', 'General', 'pcs', 5000, NULL);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk) VALUES
  ('unit-nc', 'prod-nc', 'pcs', 1, true, true, 5000, NULL);
SELECT test.logout() AS zz \gset

UPDATE inventory SET qty_base_units = 10000 WHERE shop_id IN ('shop-f', 'shop-v');

SELECT test.check('f00 seed: shop F and V, 5 shop-F users (1 inactive), prod-nc without cost',
  (SELECT count(*) FROM users WHERE shop_id = 'shop-f') = 5
  AND (SELECT cost_mmk FROM products WHERE id = 'prod-nc') IS NULL
  AND (SELECT count(*) FROM inventory WHERE shop_id = 'shop-f') >= 4);
SELECT 'INFO B=' || test.var('B') || ' D1=' || test.var('D1') || ' D2=' || test.var('D2');
