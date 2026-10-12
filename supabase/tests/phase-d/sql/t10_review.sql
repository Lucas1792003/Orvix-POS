-- t10: independent review of 067-072 (Phase G). Covers gaps the t09 audit
-- did not exercise. Runs after t09 (reuses its org-two seed) and only when
-- migrations >= 068 are applied (run.sh gates it).
--   1. bootstrap hatch: an authenticated caller WITHOUT an app user (orphan
--      auth account) cannot create an organization / user on a populated
--      install (069 regression: users_sel's org term made the RLS-filtered
--      `NOT EXISTS (SELECT 1 FROM users)` true for such callers)
--   2. client-supplied org_id on INSERT is rejected; UPDATE cannot move a row
--      to another org (catalog, shops, users)
--   3. cross-org references between catalog rows are refused (068 5b)
--   4. upload session for another org's shop/product is refused
--   5. Realtime: the only published table (inventory) is filtered by an
--      org-aware SELECT policy, both directions
--   6. idempotency: a same-org replay returns the stored response; another
--      org's caller re-using that key is stopped by the org guard and never
--      receives the stored response
\set ON_ERROR_STOP on
\set AX  'a0000000-0000-4000-8000-000000000011'
\set CX  'a0000000-0000-4000-8000-000000000013'
\set AA  'a0000000-0000-4000-8000-000000000001'
\set MA  'a0000000-0000-4000-8000-000000000002'
\set ORPH 'a0000000-0000-4000-8000-0000000000f1'
SELECT test.logout() AS zz \gset

-- ============================================================
-- 1. Bootstrap hatch closed for orphan auth accounts
-- ============================================================
INSERT INTO auth.users (id, email) VALUES (:'ORPH', 'orphan@review.local');
SELECT test.login(:'ORPH') AS zz \gset
SET ROLE authenticated;
SELECT test.check('review: app_setup_needed() is false on a populated install', NOT public.app_setup_needed());
SELECT test.expect_error('review: orphan auth account cannot create an organization',
  $q$INSERT INTO organizations (id, name) VALUES ('org-orphan', 'Orphan Org')$q$, 'row-level security');
SELECT test.expect_error('review: orphan auth account cannot enrol itself as MANAGER of another org''s shop',
  $q$INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id)
     VALUES ('u-orphan', 'Orphan', 'orphan@review.local', 'MANAGER', 'shop-x', 'a0000000-0000-4000-8000-0000000000f1', 'org-two')$q$,
  'row-level security');
SELECT test.expect_error('review: orphan auth account cannot enrol itself as BUYER of org A',
  $q$INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id)
     VALUES ('u-orphan', 'Orphan', 'orphan@review.local', 'BUYER', 'shop-a', 'a0000000-0000-4000-8000-0000000000f1', 'org-test')$q$,
  'row-level security');
RESET ROLE;
SELECT test.check('review: orphan created no organization / users row',
  NOT EXISTS (SELECT 1 FROM organizations WHERE id = 'org-orphan')
  AND NOT EXISTS (SELECT 1 FROM users WHERE auth_id = :'ORPH'));
-- the trigger layer agrees with the policy layer (073 replaces the RLS-filtered
-- first-user check with app_setup_needed()); only meaningful once 073 is in
SELECT CASE WHEN (SELECT prosrc LIKE '%app_setup_needed()%' FROM pg_proc WHERE proname = 'guard_user_privilege_columns')
  THEN test.check('review: 047 guard first-user bypass uses the unfiltered app_setup_needed()', true)
  ELSE 'SKIP guard check (073 not applied)' END;

-- an org ADMIN may not create organizations either (only the bootstrap / the
-- service-role platform console)
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('review: org A ADMIN cannot create an organization',
  $q$INSERT INTO organizations (id, name) VALUES ('org-by-admin', 'X')$q$, 'row-level security');

-- ============================================================
-- 2. Client-supplied org_id / moving rows across orgs (as org A ADMIN)
-- ============================================================
SELECT test.expect_error('review: INSERT products with explicit foreign org_id rejected',
  $q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk, org_id)
     VALUES ('prod-r1', 'SKUR1', 'R1', 'General', 'pcs', 1, 1, 'org-two')$q$, 'row-level security');
SELECT test.expect_error('review: INSERT categories with explicit foreign org_id rejected',
  $q$INSERT INTO categories (id, name, color, org_id) VALUES ('cat-r1', 'R1', '#000000', 'org-two')$q$, 'row-level security');
SELECT test.expect_error('review: INSERT suppliers with explicit foreign org_id rejected',
  $q$INSERT INTO suppliers (id, code, name, org_id) VALUES ('sup-r1', 'SUPR1', 'R1', 'org-two')$q$, 'row-level security');
SELECT test.expect_error('review: INSERT price_levels with explicit foreign org_id rejected',
  $q$INSERT INTO price_levels (id, code, name, is_default, is_active, org_id) VALUES ('pl-r1', 'R1', 'R1', false, true, 'org-two')$q$, 'row-level security');
SELECT test.expect_error('review: INSERT shops with explicit foreign org_id rejected',
  $q$INSERT INTO shops (id, code, name, address, org_id) VALUES ('shop-r1', 'SR1', 'R1', 'r', 'org-two')$q$, 'row-level security');
SELECT test.expect_error('review: INSERT users with explicit foreign org_id rejected',
  $q$INSERT INTO users (id, name, email, role, shop_id, org_id) VALUES ('u-r1', 'R1', 'r1@x', 'BUYER', 'shop-x', 'org-two')$q$, 'row-level security');
-- barcode org_id always follows the product, whatever the client sends
INSERT INTO product_barcodes (id, product_id, value, type, org_id) VALUES ('bc-r1', 'prod-1', '8850000009999', 'EAN13', 'org-two');
SELECT test.check('review: product_barcodes.org_id sent by the client is overwritten with the product''s org',
  (SELECT org_id FROM product_barcodes WHERE id = 'bc-r1') = 'org-test');

SELECT test.expect_error('review: UPDATE products SET org_id = foreign org rejected',
  $q$UPDATE products SET org_id = 'org-two' WHERE id = 'prod-1'$q$, 'row-level security');
SELECT test.expect_error('review: UPDATE shops SET org_id = foreign org rejected',
  $q$UPDATE shops SET org_id = 'org-two' WHERE id = 'shop-a'$q$, 'row-level security');
SELECT test.expect_error('review: UPDATE users SET org_id = foreign org rejected',
  $q$UPDATE users SET org_id = 'org-two' WHERE id = 'u-cash-a1'$q$, 'row-level security');
SELECT test.expect_error('review: UPDATE suppliers SET org_id = foreign org rejected',
  $q$UPDATE suppliers SET org_id = 'org-two' WHERE id = 'sup-1'$q$, 'row-level security');
SELECT test.check('review: UPDATE of an org B row touches 0 rows (products/shops/users/suppliers/business_profile)',
  test.affected($q$UPDATE products SET name = 'pwned' WHERE id = 'prod-x1'$q$) = 0
  AND test.affected($q$UPDATE shops SET name = 'pwned' WHERE id = 'shop-x'$q$) = 0
  AND test.affected($q$UPDATE users SET name = 'pwned' WHERE id = 'u-mgr-x'$q$) = 0
  AND test.affected($q$UPDATE suppliers SET name = 'pwned' WHERE id = 'sup-x'$q$) = 0
  AND test.affected($q$UPDATE business_profile SET id = 'default' WHERE org_id = 'org-two'$q$) = 0);

-- ============================================================
-- 3. Cross-org references between catalog rows
-- ============================================================
SELECT test.expect_error('review: product cannot reference org B''s brand',
  $q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk, brand_id)
     VALUES ('prod-r2', 'SKUR2', 'R2', 'General', 'pcs', 1, 1, 'brand-x')$q$, 'Brand not found in your organization');
SELECT test.expect_error('review: unknown brand id gives the same message as a foreign one (no oracle)',
  $q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk, brand_id)
     VALUES ('prod-r3', 'SKUR3', 'R3', 'General', 'pcs', 1, 1, 'brand-nope')$q$, 'Brand not found in your organization');
SELECT test.expect_error('review: UPDATE product to org B''s brand rejected',
  $q$UPDATE products SET brand_id = 'brand-x' WHERE id = 'prod-1'$q$, 'Brand not found in your organization');
SELECT test.expect_error('review: brand cannot reference org B''s category',
  $q$INSERT INTO brands (id, category_id, name) VALUES ('brand-r1', 'cat-x', 'R1')$q$, 'Category not found in your organization');
SELECT test.expect_error('review: unit price cannot use org B''s price level',
  $q$INSERT INTO product_unit_prices (id, product_unit_id, price_level_id, price_mmk) VALUES ('pup-r1', 'unit-1', 'pl-x-retail', 1)$q$,
  'Price level not found in your organization');
SELECT test.expect_error('review: unit price cannot target org B''s shop',
  $q$INSERT INTO product_unit_prices (id, product_unit_id, price_level_id, price_mmk, shop_id) VALUES ('pup-r2', 'unit-1', 'pl-retail', 1, 'shop-x')$q$,
  'Shop not found in your organization');
SELECT test.expect_error('review: price tier cannot target org B''s shop',
  $q$INSERT INTO price_tiers (id, product_id, shop_id, min_qty, price_mmk, created_by) VALUES ('tier-r1', 'prod-1', 'shop-x', 5, 1, 'u-admin')$q$,
  'Shop not found in your organization');
SELECT test.expect_error('review: barcode cannot point at org B''s sellable unit (pre-existing unit/product trigger)',
  $q$INSERT INTO product_barcodes (id, product_id, value, type, product_unit_id) VALUES ('bc-r2', 'prod-1', '8850000008888', 'EAN13', 'unit-x1')$q$,
  'Barcode product_unit_id must belong to the same product_id');
SELECT test.expect_error('review: supplier_products cannot pair own supplier with org B''s product',
  $q$INSERT INTO supplier_products (supplier_id, product_id) VALUES ('sup-1', 'prod-x1')$q$, 'not found in your organization');
RESET ROLE;
-- the same checks hold for the service role (RLS bypassed): exact org comparison
SET ROLE service_role;
SELECT test.expect_error('review: service_role cannot create a cross-org price tier either',
  $q$INSERT INTO price_tiers (id, product_id, shop_id, min_qty, price_mmk, created_by) VALUES ('tier-r2', 'prod-x1', 'shop-a', 5, 1, 'u-mgr-x')$q$,
  'Shop not found in your organization');
SELECT test.expect_error('review: service_role cannot pair suppliers and products of different orgs',
  $q$INSERT INTO supplier_products (supplier_id, product_id) VALUES ('sup-x', 'prod-1')$q$, 'not found in your organization');
RESET ROLE;
SELECT test.check('review: no catalog cross-reference spans two orgs',
  (SELECT count(*) FROM products p JOIN brands b ON b.id = p.brand_id WHERE b.org_id <> p.org_id) = 0
  AND (SELECT count(*) FROM brands b JOIN categories c ON c.id = b.category_id WHERE c.org_id <> b.org_id) = 0
  AND (SELECT count(*) FROM product_unit_prices x JOIN product_units u ON u.id = x.product_unit_id JOIN products p ON p.id = u.product_id
         JOIN price_levels l ON l.id = x.price_level_id WHERE l.org_id <> p.org_id) = 0
  AND (SELECT count(*) FROM price_tiers t JOIN products p ON p.id = t.product_id JOIN shops s ON s.id = t.shop_id WHERE s.org_id <> p.org_id) = 0
  AND (SELECT count(*) FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id JOIN products p ON p.id = sp.product_id WHERE s.org_id <> p.org_id) = 0);
-- positive control: same-org references still work
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
INSERT INTO categories (id, name, color) VALUES ('cat-r-ok', 'Review OK', '#111111');
INSERT INTO brands (id, category_id, name) VALUES ('brand-r-ok', 'cat-r-ok', 'Review OK');
UPDATE products SET brand_id = 'brand-r-ok' WHERE id = 'prod-3';
INSERT INTO price_tiers (id, product_id, shop_id, min_qty, price_mmk, created_by) VALUES ('tier-r-ok', 'prod-3', 'shop-a', 5, 2500, 'u-admin');
SELECT test.check('review: same-org brand/category/tier references still accepted',
  (SELECT brand_id FROM products WHERE id = 'prod-3') = 'brand-r-ok' AND EXISTS (SELECT 1 FROM price_tiers WHERE id = 'tier-r-ok'));
RESET ROLE;

-- ============================================================
-- 4. Upload session for another org's shop / product
-- ============================================================
SELECT test.login(:'MA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('review: upload session for org B''s product refused',
  $q$SELECT public.create_product_image_upload_session('shop-a', 'prod-x1')$q$, 'Product not found in your organization');
SELECT test.expect_error('review: upload session for org B''s shop refused',
  $q$SELECT public.create_product_image_upload_session('shop-x', 'prod-1')$q$, 'Shop not found in your organization');
SELECT test.check('review: upload session for own product still works',
  (public.create_product_image_upload_session('shop-a', 'prod-1')->>'status') = 'PENDING');
RESET ROLE;
SELECT test.check('review: no upload session references a product or shop of another org than its creator',
  (SELECT count(*) FROM product_image_upload_sessions s JOIN users u ON u.id = s.created_by
     LEFT JOIN products p ON p.id = s.product_id LEFT JOIN shops sh ON sh.id = s.shop_id
    WHERE (p.id IS NOT NULL AND p.org_id <> u.org_id) OR (sh.id IS NOT NULL AND sh.org_id <> u.org_id)) = 0);

-- ============================================================
-- 5. Realtime (postgres_changes evaluates the subscriber's SELECT policy)
-- ============================================================
SELECT test.check('review: inventory is the only table in supabase_realtime',
  (SELECT array_agg(schemaname || '.' || tablename) FROM pg_publication_tables WHERE pubname = 'supabase_realtime') = ARRAY['public.inventory']);
SELECT test.check('review: inventory_sel ADMIN branch is bounded by app_org_shop_ids()',
  (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory' AND policyname = 'inventory_sel') LIKE '%app_org_shop_ids%'
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory') = 1);
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.check('review: org B ADMIN cannot see org A inventory rows (Realtime events filtered)',
  (SELECT count(*) FROM inventory WHERE shop_id IN ('shop-a', 'shop-b')) = 0
  AND (SELECT count(*) FROM inventory WHERE shop_id IN ('shop-x', 'shop-y')) > 0);
RESET ROLE;
SELECT test.login(:'MA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('review: org A MANAGER sees only own-shop inventory',
  (SELECT count(*) FROM inventory WHERE shop_id <> 'shop-a') = 0);
RESET ROLE;

-- ============================================================
-- 6. Idempotency replay vs the org guard
--    t09 used key ...0001 for org B cashier's complete_sale on shop-x.
-- ============================================================
SELECT test.login(:'CX') AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-x', 'shift-x', 'CASH', 1000, 0, '[{"product_id":"prod-x1","qty":1}]'::jsonb, NULL,
  '99999999-0000-4000-8000-000000000001') AS rx \gset
RESET ROLE;
SELECT test.check('review: same-org replay returns the stored response (063 semantics kept under the 070 guard)',
  :'rx'::jsonb = (SELECT response FROM idempotency_keys WHERE key = '99999999-0000-4000-8000-000000000001'));
SELECT test.check('review: the replay created no second sale',
  (SELECT count(*) FROM sales WHERE id = (:'rx'::jsonb->'sale'->>'id')) = 1
  AND (SELECT count(*) FROM sales WHERE shop_id = 'shop-x' AND id NOT LIKE 'sale-x_') = 1);
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('review: another org''s user re-using the key with the same payload is stopped by the org guard (no stored-response leak)',
  $q$SELECT public.complete_sale('shop-x', 'shift-x', 'CASH', 1000, 0, '[{"product_id":"prod-x1","qty":1}]'::jsonb, NULL,
       '99999999-0000-4000-8000-000000000001')$q$, 'not found in your organization');
RESET ROLE;

SELECT test.logout() AS zz \gset
