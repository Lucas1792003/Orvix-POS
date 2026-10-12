-- t11: creating further organizations the way the platform console does
-- (supabase/functions/platform-console, action create_organization: service
-- role key -> PostgREST runs as `service_role`, no `sub`). Before 073 the 047
-- guard rejects the new org's ADMIN insert once any user exists - recorded
-- here as FINDING (so a run capped below 073 reproduces the defect). Then
-- both new orgs are populated through the app path (their ADMINs,
-- authenticated) and isolated from each other in both directions; org
-- ADMINs / orphans / anon cannot create organizations or foreign ADMINs.
-- Runs after t10; run.sh gates it on migrations >= 069.
\set ON_ERROR_STOP on
\set A1 'b0000000-0000-4000-8000-0000000000a1'
\set B1 'b0000000-0000-4000-8000-0000000000b1'
\set A2 'b0000000-0000-4000-8000-0000000000a2'
\set AA 'a0000000-0000-4000-8000-000000000001'
\set ORPH 'a0000000-0000-4000-8000-0000000000f1'
SELECT test.logout() AS zz \gset

-- auth.admin.createUser() equivalent (GoTrue writes auth.users itself)
INSERT INTO auth.users (id, email) VALUES
  (:'A1', 'owner@alpha.local'), (:'B1', 'owner@beta.local'), (:'A2', 'second@alpha.local');

-- service-role request context, exactly what PostgREST sets for the service key
CREATE OR REPLACE FUNCTION test.as_service_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', false);
  PERFORM set_config('request.jwt.claim.role', 'service_role', false);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, false);
END $$;
GRANT EXECUTE ON FUNCTION test.as_service_role() TO service_role;

-- ============================================================
-- 1. Console path: org + first ADMIN, as service_role
-- ============================================================
SELECT test.as_service_role() AS zz \gset
SET ROLE service_role;
SELECT test.check('console: service_role inserts organization org-alpha',
  test.affected($q$INSERT INTO organizations (id, name) VALUES ('org-alpha', 'Alpha')$q$) = 1);
SELECT test.finding_succeeds('console: service_role creates org-alpha''s first ADMIN (047 guard must trust service_role)',
  $q$INSERT INTO users (id, name, email, role, org_id, auth_id, is_active)
     VALUES ('u-alpha-admin', 'Alpha Owner', 'owner@alpha.local', 'ADMIN', 'org-alpha', 'b0000000-0000-4000-8000-0000000000a1', true)$q$);
SELECT test.check('console: service_role inserts organization org-beta',
  test.affected($q$INSERT INTO organizations (id, name) VALUES ('org-beta', 'Beta')$q$) = 1);
SELECT test.finding_succeeds('console: service_role creates org-beta''s first ADMIN',
  $q$INSERT INTO users (id, name, email, role, org_id, auth_id, is_active)
     VALUES ('u-beta-admin', 'Beta Owner', 'owner@beta.local', 'ADMIN', 'org-beta', 'b0000000-0000-4000-8000-0000000000b1', true)$q$);
-- one ADMIN per ORGANIZATION (059 partial unique index), even for the service role
SELECT test.expect_error('console: a second ADMIN in the same org is refused (per-org unique index)',
  $q$INSERT INTO users (id, name, email, role, org_id, auth_id, is_active)
     VALUES ('u-alpha-admin2', 'Alpha 2', 'second@alpha.local', 'ADMIN', 'org-alpha', 'b0000000-0000-4000-8000-0000000000a2', true)$q$,
  'users_only_one_admin');
-- console rollback path: an org whose ADMIN insert failed is deleted again
INSERT INTO organizations (id, name) VALUES ('org-rollback', 'Rollback');
SELECT test.check('console: rollback DELETE of a just-created empty org succeeds',
  test.affected($q$DELETE FROM organizations WHERE id = 'org-rollback'$q$) = 1);
SELECT test.check('console: its auto-seeded business_profile row went with it (ON DELETE CASCADE)',
  NOT EXISTS (SELECT 1 FROM business_profile WHERE org_id = 'org-rollback'));
RESET ROLE;
SELECT test.logout() AS zz \gset

-- If the console path failed (pre-073), seed the ADMINs the way t09 does so the
-- isolation part below still runs and reports on the rest.
SELECT test.login(:'AA') AS zz \gset
INSERT INTO users (id, name, email, role, org_id, auth_id, is_active)
SELECT 'u-alpha-admin', 'Alpha Owner', 'owner@alpha.local', 'ADMIN', 'org-alpha', :'A1', true
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'u-alpha-admin');
INSERT INTO users (id, name, email, role, org_id, auth_id, is_active)
SELECT 'u-beta-admin', 'Beta Owner', 'owner@beta.local', 'ADMIN', 'org-beta', :'B1', true
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'u-beta-admin');
SELECT test.logout() AS zz \gset

SELECT test.check('console: each new org has exactly one ADMIN and its own business_profile row',
  (SELECT count(*) FROM users WHERE org_id = 'org-alpha' AND role = 'ADMIN') = 1
  AND (SELECT count(*) FROM users WHERE org_id = 'org-beta' AND role = 'ADMIN') = 1
  AND (SELECT count(*) FROM business_profile WHERE org_id IN ('org-alpha', 'org-beta')) = 2);

-- ============================================================
-- 2. Each ADMIN builds its org through the app (authenticated)
-- ============================================================
SELECT test.login(:'A1') AS zz \gset
SET ROLE authenticated;
INSERT INTO shops (id, code, name, address) VALUES ('shop-al1', 'SHOP1', 'Main', 'Alpha St');  -- addShop(): no org_id sent
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-al1', 'SKU-1', 'Widget', 'General', 'pcs', 1000, 500);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk)
VALUES ('unit-al1', 'prod-al1', 'pcs', 1, true, true, 1000, 500);
INSERT INTO price_levels (id, code, name, is_default, is_active) VALUES ('pl-al', 'RETAIL', 'Retail', true, true);
SELECT test.check('alpha ADMIN: adjust_stock on own shop/product',
  (public.adjust_stock('shop-al1', 'prod-al1', 'ADJUSTMENT', 40, 'opening', NULL, NULL, NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000a1')->'inventory'->>'qtyBaseUnits')::int = 40);
RESET ROLE;

SELECT test.login(:'B1') AS zz \gset
SET ROLE authenticated;
-- same shop code / SKU / price-level code as alpha: uniqueness is per org
INSERT INTO shops (id, code, name, address) VALUES ('shop-be1', 'SHOP1', 'Main', 'Beta St');
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-be1', 'SKU-1', 'Widget', 'General', 'pcs', 2000, 900);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk)
VALUES ('unit-be1', 'prod-be1', 'pcs', 1, true, true, 2000, 900);
INSERT INTO price_levels (id, code, name, is_default, is_active) VALUES ('pl-be', 'RETAIL', 'Retail', true, true);
SELECT public.adjust_stock('shop-be1', 'prod-be1', 'ADJUSTMENT', 7, 'opening', NULL, NULL, NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000b1') AS zz \gset
RESET ROLE;

SELECT test.check('build: rows landed in the right org (shops, products, price levels)',
  (SELECT org_id FROM shops WHERE id = 'shop-al1') = 'org-alpha' AND (SELECT org_id FROM shops WHERE id = 'shop-be1') = 'org-beta'
  AND (SELECT org_id FROM products WHERE id = 'prod-al1') = 'org-alpha' AND (SELECT org_id FROM products WHERE id = 'prod-be1') = 'org-beta'
  AND (SELECT org_id FROM price_levels WHERE id = 'pl-al') = 'org-alpha' AND (SELECT org_id FROM price_levels WHERE id = 'pl-be') = 'org-beta');
SELECT test.check('build: inventory rows only pair same-org shop+product; stock set separately',
  (SELECT count(*) FROM inventory WHERE shop_id IN ('shop-al1', 'shop-be1') OR product_id IN ('prod-al1', 'prod-be1')) = 2
  AND (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-al1' AND product_id = 'prod-al1') = 40
  AND (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-be1' AND product_id = 'prod-be1') = 7);

-- ============================================================
-- 3. Cross-org denial, both directions
-- ============================================================
SELECT test.login(:'A1') AS zz \gset
SET ROLE authenticated;
SELECT test.check('alpha ADMIN: sees none of beta (orgs, shops, users, products, inventory, price levels, business_profile)',
  (SELECT count(*) FROM organizations WHERE id <> 'org-alpha') = 0
  AND (SELECT count(*) FROM shops WHERE org_id <> 'org-alpha') = 0
  AND (SELECT count(*) FROM users WHERE org_id <> 'org-alpha') = 0
  AND (SELECT count(*) FROM products WHERE org_id <> 'org-alpha') = 0
  AND (SELECT count(*) FROM inventory WHERE shop_id <> 'shop-al1') = 0
  AND (SELECT count(*) FROM price_levels WHERE org_id <> 'org-alpha') = 0
  AND (SELECT count(*) FROM business_profile) = 1);
SELECT test.expect_error('alpha ADMIN: adjust_stock on beta shop refused',
  $q$SELECT public.adjust_stock('shop-be1', 'prod-be1', 'ADJUSTMENT', 1, 'x', NULL, NULL, NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000c1')$q$,
  'not found in your organization');
SELECT test.expect_error('alpha ADMIN: open_shift on beta shop refused',
  $q$SELECT public.open_shift('shop-be1', 0, NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000c2')$q$, 'Shop not found in your organization');
SELECT test.check('alpha ADMIN: direct UPDATE of beta rows touches nothing',
  test.affected($q$UPDATE products SET name = 'x' WHERE id = 'prod-be1'$q$) = 0
  AND test.affected($q$UPDATE shops SET name = 'x' WHERE id = 'shop-be1'$q$) = 0
  AND test.affected($q$UPDATE users SET name = 'x' WHERE id = 'u-beta-admin'$q$) = 0);
RESET ROLE;

SELECT test.login(:'B1') AS zz \gset
SET ROLE authenticated;
SELECT test.check('beta ADMIN: sees none of alpha',
  (SELECT count(*) FROM organizations WHERE id <> 'org-beta') = 0
  AND (SELECT count(*) FROM shops WHERE org_id <> 'org-beta') = 0
  AND (SELECT count(*) FROM users WHERE org_id <> 'org-beta') = 0
  AND (SELECT count(*) FROM products WHERE org_id <> 'org-beta') = 0
  AND (SELECT count(*) FROM inventory WHERE shop_id <> 'shop-be1') = 0);
SELECT test.expect_error('beta ADMIN: adjust_stock on alpha shop refused',
  $q$SELECT public.adjust_stock('shop-al1', 'prod-al1', 'ADJUSTMENT', 1, 'x', NULL, NULL, NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000c3')$q$,
  'not found in your organization');
SELECT test.expect_error('beta ADMIN: create_purchase_order with alpha product refused',
  $q$SELECT public.create_purchase_order('shop-be1', NULL, NULL, '[{"product_id":"prod-al1","ordered_qty":1,"unit_cost_mmk":1}]'::jsonb, 'bbbbbbbb-0000-4000-8000-0000000000c4')$q$,
  'Product not found in your organization');
RESET ROLE;
SELECT test.check('cross-org: stock unchanged after the refused calls',
  (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-al1' AND product_id = 'prod-al1') = 40
  AND (SELECT qty_base_units FROM inventory WHERE shop_id = 'shop-be1' AND product_id = 'prod-be1') = 7);

-- ============================================================
-- 4. Nobody but the service role creates organizations / foreign ADMINs
-- ============================================================
SELECT test.login(:'A1') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('alpha ADMIN cannot create an organization',
  $q$INSERT INTO organizations (id, name) VALUES ('org-gamma', 'Gamma')$q$, 'row-level security');
SELECT test.expect_error('alpha ADMIN cannot create an ADMIN in beta',
  $q$INSERT INTO users (id, name, email, role, org_id, auth_id) VALUES ('u-evil', 'E', 'second@alpha.local', 'ADMIN', 'org-beta', 'b0000000-0000-4000-8000-0000000000a2')$q$,
  'row-level security');
SELECT test.expect_error('alpha ADMIN cannot create a second ADMIN in alpha (per-org unique)',
  $q$INSERT INTO users (id, name, email, role, org_id, auth_id) VALUES ('u-evil', 'E', 'second@alpha.local', 'ADMIN', 'org-alpha', 'b0000000-0000-4000-8000-0000000000a2')$q$,
  'users_only_one_admin');
SELECT test.expect_error('alpha ADMIN cannot promote a user of beta via update_app_user',
  $q$SELECT public.update_app_user('u-beta-admin', 'x', 'ADMIN', NULL, NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000c5')$q$,
  'User not found in your organization');
RESET ROLE;

SELECT test.login(:'ORPH') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('orphan auth account cannot create an organization',
  $q$INSERT INTO organizations (id, name) VALUES ('org-gamma', 'Gamma')$q$, 'row-level security');
SELECT test.expect_error('orphan auth account cannot insert itself as a user of beta',
  $q$INSERT INTO users (id, name, email, role, shop_id, org_id, auth_id) VALUES ('u-evil', 'E', 'orphan@review.local', 'MANAGER', 'shop-be1', 'org-beta', 'a0000000-0000-4000-8000-0000000000f1')$q$,
  'row-level security');
RESET ROLE;
SELECT test.logout() AS zz \gset

SET ROLE anon;
SELECT test.expect_error('anon cannot create an organization',
  $q$INSERT INTO organizations (id, name) VALUES ('org-gamma', 'Gamma')$q$, 'row-level security');
SELECT test.expect_error('anon cannot create a user',
  $q$INSERT INTO users (id, name, email, role, org_id) VALUES ('u-evil', 'E', 'e@x', 'ADMIN', 'org-alpha')$q$, 'permission denied');
SELECT test.check('anon: app_setup_needed() answers false and nothing else', public.app_setup_needed() IS FALSE);
RESET ROLE;

SELECT test.check('t11: no stray organizations or users were created',
  NOT EXISTS (SELECT 1 FROM organizations WHERE id IN ('org-gamma', 'org-by-admin', 'org-orphan', 'org-rollback'))
  AND NOT EXISTS (SELECT 1 FROM users WHERE id IN ('u-evil', 'u-alpha-admin2', 'u-orphan')));
SELECT test.logout() AS zz \gset
