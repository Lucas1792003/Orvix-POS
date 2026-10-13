-- Phase D / G live QA cleanup (run as supabase_admin). Single transaction;
-- aborts on the first error so a partial delete can never be committed.
--
-- Removes EVERY row created by the live QA runs, in FK dependency order:
-- rows whose own id starts with qa-, plus rows the RPCs minted server-side
-- (sale-/shift-/move-/audit-/po-/suppay-/pimg-...) that belong to a QA shop,
-- QA actor, QA product or QA supplier. Prints a count per table.
--
-- Works for ONE or SEVERAL QA organizations (Phase G two-org suite): a QA
-- organization is `id LIKE 'qa-%' OR name LIKE 'QA %'` - the second org of
-- the Phase G suite is created by the platform console, which mints its own
-- ids (`org-<uuid>`, `user-<uuid>`), so everything that belongs to a QA org
-- by org_id / shop / user is collected into temp sets first (qa_orgs,
-- qa_shops, qa_users, qa_products, qa_suppliers) and every delete matches on
-- those sets as well as on the qa- / @qa.invalid / "QA " anchors.
--
-- Since 068: catalog tables (categories, brands, unit_types, price_levels,
-- product_barcodes) and business_profile carry org_id; QA rows there are
-- removed by org. platform_admins rows of QA accounts (@qa.invalid) too.
-- Storage OBJECTS are not deleted here: they must go through the Storage API
-- so the file on disk is removed as well (the suites do that themselves).
--
-- Real rows are never touched: every predicate is anchored on a qa- id, an
-- @qa.invalid email, a "QA " name or membership in a QA organization. Nothing
-- is restricted to one run stamp on purpose (a failed earlier run must be
-- cleaned by the same file).
\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE qa_orgs ON COMMIT DROP AS
  SELECT id FROM organizations WHERE id LIKE 'qa-%' OR name LIKE 'QA %';
CREATE TEMP TABLE qa_shops ON COMMIT DROP AS
  SELECT id FROM shops WHERE id LIKE 'qa-%' OR name LIKE 'QA %' OR org_id IN (SELECT id FROM qa_orgs);
CREATE TEMP TABLE qa_users ON COMMIT DROP AS
  SELECT id FROM users
   WHERE id LIKE 'qa-%' OR email LIKE '%@qa.invalid' OR name LIKE 'QA %'
      OR org_id IN (SELECT id FROM qa_orgs) OR shop_id IN (SELECT id FROM qa_shops);
CREATE TEMP TABLE qa_products ON COMMIT DROP AS
  SELECT id FROM products WHERE id LIKE 'qa-%' OR name LIKE 'QA %' OR org_id IN (SELECT id FROM qa_orgs);
CREATE TEMP TABLE qa_suppliers ON COMMIT DROP AS
  SELECT id FROM suppliers WHERE id LIKE 'qa-%' OR name LIKE 'QA %' OR org_id IN (SELECT id FROM qa_orgs);

-- Guard: the sets must never reach the real organization.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM qa_orgs o WHERE o.id NOT LIKE 'qa-%'
               AND NOT EXISTS (SELECT 1 FROM organizations x WHERE x.id = o.id AND x.name LIKE 'QA %')) THEN
    RAISE EXCEPTION 'cleanup: a non-QA organization matched the QA set - aborting';
  END IF;
  IF EXISTS (SELECT 1 FROM qa_shops s JOIN shops x ON x.id = s.id
              WHERE x.org_id NOT IN (SELECT id FROM qa_orgs)) THEN
    RAISE EXCEPTION 'cleanup: a QA-named shop belongs to a non-QA organization - aborting';
  END IF;
  IF EXISTS (SELECT 1 FROM qa_products p JOIN products x ON x.id = p.id
              WHERE x.org_id NOT IN (SELECT id FROM qa_orgs)) THEN
    RAISE EXCEPTION 'cleanup: a QA-named product belongs to a non-QA organization - aborting';
  END IF;
  IF EXISTS (SELECT 1 FROM qa_users u JOIN users x ON x.id = u.id
              WHERE x.org_id IS NOT NULL AND x.org_id NOT IN (SELECT id FROM qa_orgs)) THEN
    RAISE EXCEPTION 'cleanup: a QA-named user belongs to a non-QA organization - aborting';
  END IF;
END $$;

SELECT 'qa sets' AS "table",
       format('orgs=%s shops=%s users=%s products=%s suppliers=%s',
              (SELECT count(*) FROM qa_orgs), (SELECT count(*) FROM qa_shops), (SELECT count(*) FROM qa_users),
              (SELECT count(*) FROM qa_products), (SELECT count(*) FROM qa_suppliers)) AS deleted;

-- Since 078/079 QA uploads live under org/<qa org>/... (products/<id>/<file>
-- and temp/<session>). They are NOT deleted here (SQL would leave the file on
-- disk): the suites remove them through the Storage API. Reported so a
-- leftover is visible before the org rows that resolve them disappear;
-- verify_clean.sql fails while any remain.
SELECT 'storage.objects under QA org prefixes (remove via Storage API)' AS "table",
       count(*) AS remaining
  FROM storage.objects
 WHERE name LIKE 'org/%' AND split_part(name, '/', 2) IN (SELECT id FROM qa_orgs);

-- 077: price levels of QA organizations (the organizations AFTER INSERT
-- trigger seeds Retail/Wholesale/Special with random plv-<hex> ids for every
-- console-created org; seed.sql's replica-mode org gets its own qa-pl-*).
-- They are deleted below by org_id (and would cascade with the org since
-- 077's ON DELETE CASCADE). Guard: never a level of a non-QA organization.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM price_levels l
              WHERE (l.id LIKE 'qa-%' OR l.org_id IN (SELECT id FROM qa_orgs))
                AND l.org_id NOT IN (SELECT id FROM qa_orgs)) THEN
    RAISE EXCEPTION 'cleanup: a qa- price level belongs to a non-QA organization - aborting';
  END IF;
END $$;

CREATE TEMP TABLE qa_sales ON COMMIT DROP AS
  SELECT id FROM sales
   WHERE shop_id LIKE 'qa-%' OR cashier_id LIKE 'qa-%'
      OR shop_id IN (SELECT id FROM qa_shops) OR cashier_id IN (SELECT id FROM qa_users);
CREATE TEMP TABLE qa_pos ON COMMIT DROP AS
  SELECT id FROM purchase_orders
   WHERE shop_id LIKE 'qa-%' OR supplier_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
      OR shop_id IN (SELECT id FROM qa_shops) OR supplier_id IN (SELECT id FROM qa_suppliers)
      OR created_by IN (SELECT id FROM qa_users);
CREATE TEMP TABLE qa_transfers ON COMMIT DROP AS
  SELECT id FROM stock_transfers
   WHERE from_shop_id LIKE 'qa-%' OR to_shop_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
      OR from_shop_id IN (SELECT id FROM qa_shops) OR to_shop_id IN (SELECT id FROM qa_shops)
      OR created_by IN (SELECT id FROM qa_users);

-- Sales ledger (refund/void requests and reprints reference sales)
WITH d AS (DELETE FROM refund_void_requests
            WHERE shop_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
               OR shop_id IN (SELECT id FROM qa_shops) OR created_by IN (SELECT id FROM qa_users)
               OR sale_id IN (SELECT id FROM qa_sales)
            RETURNING 1)
SELECT 'refund_void_requests' AS "table", count(*) AS deleted FROM d;

WITH d AS (DELETE FROM reprint_logs
            WHERE printed_by LIKE 'qa-%' OR printed_by IN (SELECT id FROM qa_users)
               OR sale_id IN (SELECT id FROM qa_sales)
            RETURNING 1)
SELECT 'reprint_logs', count(*) FROM d;

WITH d AS (DELETE FROM sale_items
            WHERE product_id LIKE 'qa-%' OR product_id IN (SELECT id FROM qa_products)
               OR sale_id IN (SELECT id FROM qa_sales)
            RETURNING 1)
SELECT 'sale_items', count(*) FROM d;

WITH d AS (DELETE FROM sales
            WHERE id IN (SELECT id FROM qa_sales)
               OR shift_id IN (SELECT id FROM shifts WHERE shop_id LIKE 'qa-%' OR cashier_id LIKE 'qa-%'
                                OR shop_id IN (SELECT id FROM qa_shops) OR cashier_id IN (SELECT id FROM qa_users))
            RETURNING 1)
SELECT 'sales', count(*) FROM d;

WITH d AS (DELETE FROM shifts
            WHERE shop_id LIKE 'qa-%' OR cashier_id LIKE 'qa-%'
               OR shop_id IN (SELECT id FROM qa_shops) OR cashier_id IN (SELECT id FROM qa_users)
            RETURNING 1)
SELECT 'shifts', count(*) FROM d;

-- Stock ledger
WITH d AS (DELETE FROM inventory_movements
            WHERE shop_id LIKE 'qa-%' OR product_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
               OR shop_id IN (SELECT id FROM qa_shops) OR product_id IN (SELECT id FROM qa_products)
               OR created_by IN (SELECT id FROM qa_users)
            RETURNING 1)
SELECT 'inventory_movements', count(*) FROM d;

WITH d AS (DELETE FROM stock_transfer_items
            WHERE product_id LIKE 'qa-%' OR product_id IN (SELECT id FROM qa_products)
               OR transfer_id IN (SELECT id FROM qa_transfers)
            RETURNING 1)
SELECT 'stock_transfer_items', count(*) FROM d;

WITH d AS (DELETE FROM stock_transfers WHERE id IN (SELECT id FROM qa_transfers) RETURNING 1)
SELECT 'stock_transfers', count(*) FROM d;

WITH d AS (DELETE FROM inventory
            WHERE shop_id LIKE 'qa-%' OR product_id LIKE 'qa-%'
               OR shop_id IN (SELECT id FROM qa_shops) OR product_id IN (SELECT id FROM qa_products)
            RETURNING 1)
SELECT 'inventory', count(*) FROM d;

-- Purchasing
WITH d AS (DELETE FROM supplier_payments
            WHERE supplier_id LIKE 'qa-%' OR shop_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
               OR supplier_id IN (SELECT id FROM qa_suppliers) OR shop_id IN (SELECT id FROM qa_shops)
               OR created_by IN (SELECT id FROM qa_users)
               OR purchase_order_id IN (SELECT id FROM qa_pos)
            RETURNING 1)
SELECT 'supplier_payments', count(*) FROM d;

WITH d AS (DELETE FROM purchase_order_items
            WHERE product_id LIKE 'qa-%' OR product_id IN (SELECT id FROM qa_products)
               OR purchase_order_id IN (SELECT id FROM qa_pos)
            RETURNING 1)
SELECT 'purchase_order_items', count(*) FROM d;

WITH d AS (DELETE FROM purchase_orders WHERE id IN (SELECT id FROM qa_pos) RETURNING 1)
SELECT 'purchase_orders', count(*) FROM d;

WITH d AS (DELETE FROM supplier_products
            WHERE supplier_id LIKE 'qa-%' OR product_id LIKE 'qa-%'
               OR supplier_id IN (SELECT id FROM qa_suppliers) OR product_id IN (SELECT id FROM qa_products)
            RETURNING 1)
SELECT 'supplier_products', count(*) FROM d;

WITH d AS (DELETE FROM suppliers WHERE id IN (SELECT id FROM qa_suppliers) RETURNING 1)
SELECT 'suppliers', count(*) FROM d;

-- Catalog
WITH d AS (DELETE FROM product_image_upload_sessions
            WHERE created_by LIKE 'qa-%' OR shop_id LIKE 'qa-%' OR product_id LIKE 'qa-%'
               OR created_by IN (SELECT id FROM qa_users) OR shop_id IN (SELECT id FROM qa_shops)
               OR product_id IN (SELECT id FROM qa_products)
            RETURNING 1)
SELECT 'product_image_upload_sessions', count(*) FROM d;

WITH d AS (DELETE FROM product_unit_prices
            WHERE id LIKE 'qa-%' OR shop_id LIKE 'qa-%' OR shop_id IN (SELECT id FROM qa_shops)
               OR product_unit_id IN (SELECT id FROM product_units
                                       WHERE product_id LIKE 'qa-%' OR product_id IN (SELECT id FROM qa_products))
               OR price_level_id IN (SELECT id FROM price_levels WHERE org_id IN (SELECT id FROM qa_orgs))
            RETURNING 1)
SELECT 'product_unit_prices', count(*) FROM d;

WITH d AS (DELETE FROM product_barcodes
            WHERE id LIKE 'qa-%' OR product_id LIKE 'qa-%' OR product_id IN (SELECT id FROM qa_products)
               OR org_id IN (SELECT id FROM qa_orgs)
            RETURNING 1)
SELECT 'product_barcodes', count(*) FROM d;

WITH d AS (DELETE FROM price_tiers
            WHERE id LIKE 'qa-%' OR product_id LIKE 'qa-%' OR shop_id LIKE 'qa-%'
               OR product_id IN (SELECT id FROM qa_products) OR shop_id IN (SELECT id FROM qa_shops)
            RETURNING 1)
SELECT 'price_tiers', count(*) FROM d;

WITH d AS (DELETE FROM product_units
            WHERE id LIKE 'qa-%' OR product_id LIKE 'qa-%' OR product_id IN (SELECT id FROM qa_products)
            RETURNING 1)
SELECT 'product_units', count(*) FROM d;

WITH d AS (DELETE FROM products WHERE id IN (SELECT id FROM qa_products) RETURNING 1)
SELECT 'products', count(*) FROM d;

-- Per-org catalog dictionaries (068 org_id). brands before categories (FK).
WITH d AS (DELETE FROM brands WHERE id LIKE 'qa-%' OR org_id IN (SELECT id FROM qa_orgs) RETURNING 1)
SELECT 'brands', count(*) FROM d;

WITH d AS (DELETE FROM categories WHERE id LIKE 'qa-%' OR org_id IN (SELECT id FROM qa_orgs) RETURNING 1)
SELECT 'categories', count(*) FROM d;

WITH d AS (DELETE FROM unit_types WHERE id LIKE 'qa-%' OR org_id IN (SELECT id FROM qa_orgs) RETURNING 1)
SELECT 'unit_types', count(*) FROM d;

WITH d AS (DELETE FROM price_levels WHERE id LIKE 'qa-%' OR org_id IN (SELECT id FROM qa_orgs) RETURNING 1)
SELECT 'price_levels', count(*) FROM d;

-- Audit + idempotency ledger
WITH d AS (DELETE FROM audit_logs
            WHERE actor_id LIKE 'qa-%' OR shop_id LIKE 'qa-%' OR entity_id LIKE 'qa-%'
               OR actor_id IN (SELECT id FROM qa_users) OR shop_id IN (SELECT id FROM qa_shops)
               OR entity_id IN (SELECT id FROM qa_users UNION ALL SELECT id FROM qa_products
                                UNION ALL SELECT id FROM qa_suppliers UNION ALL SELECT id FROM qa_shops
                                UNION ALL SELECT id FROM qa_orgs)
            RETURNING 1)
SELECT 'audit_logs', count(*) FROM d;

WITH d AS (DELETE FROM idempotency_keys
            WHERE actor_id LIKE 'qa-%' OR actor_id IN (SELECT id FROM qa_users)
            RETURNING 1)
SELECT 'idempotency_keys', count(*) FROM d;

-- People / tenancy (users before shops before business_profile before organizations)
WITH d AS (DELETE FROM users WHERE id IN (SELECT id FROM qa_users) RETURNING 1)
SELECT 'users', count(*) FROM d;

WITH d AS (DELETE FROM shops WHERE id IN (SELECT id FROM qa_shops) RETURNING 1)
SELECT 'shops', count(*) FROM d;

WITH d AS (DELETE FROM business_profile WHERE org_id IN (SELECT id FROM qa_orgs) RETURNING 1)
SELECT 'business_profile', count(*) FROM d;

WITH d AS (DELETE FROM organizations WHERE id IN (SELECT id FROM qa_orgs) RETURNING 1)
SELECT 'organizations', count(*) FROM d;

-- Platform console test identities (QA accounts only)
WITH d AS (DELETE FROM platform_admins WHERE email LIKE '%@qa.invalid' RETURNING 1)
SELECT 'platform_admins', count(*) FROM d;

-- Auth side: cascades to identities, sessions, refresh_tokens, mfa_factors,
-- one_time_tokens, admin_login_codes, platform_admins (all ON DELETE CASCADE).
WITH d AS (DELETE FROM auth.users WHERE email LIKE '%@qa.invalid' RETURNING 1)
SELECT 'auth.users', count(*) FROM d;

COMMIT;
