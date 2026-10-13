-- Phase E live QA seed EXTENSION (run as supabase_admin AFTER
-- supabase/tests/phase-d/live/seed.sql with the same :ts).
--
-- Adds what the UI flows need on top of the Phase D tenant:
--   * a barcode on QA Product One's default unit so POS barcode mode (F4,
--     keyboard-wedge input) resolves a scan to a product/unit;
--   * a second QA shop (already seeded by Phase D as qa-shop2-<ts>) gets
--     inventory for all three QA products so cross-shop isolation checks
--     can compare full rows (seed.sql only gives it product one).
-- Everything is identifiable (qa- ids) and removed by the Phase D
-- cleanup.sql (product_barcodes / inventory predicates already cover it).
-- session_replication_role = replica for the same reason as seed.sql: no
-- auto-created cross rows for real products x QA shops.
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL session_replication_role = replica;

-- org_id explicit (068): the product_barcodes_set_org_id trigger that copies
-- the parent product's org does not fire under replica mode.
INSERT INTO product_barcodes (id, product_id, product_unit_id, value, type, org_id) VALUES
  ('qa-bc-1-' || :'ts', 'qa-prod-1-' || :'ts', 'qa-unit-1-' || :'ts', 'QABC1' || :'ts', 'CODE128', 'qa-org-' || :'ts');

INSERT INTO inventory (shop_id, product_id, qty_base_units) VALUES
  ('qa-shop2-' || :'ts', 'qa-prod-2-' || :'ts', 50),
  ('qa-shop2-' || :'ts', 'qa-prod-3-' || :'ts', 50)
ON CONFLICT (shop_id, product_id) DO NOTHING;

COMMIT;

SELECT 'seeded-extra ts=' || :'ts'
  || ' barcodes=' || (SELECT count(*) FROM product_barcodes WHERE id = 'qa-bc-1-' || :'ts')
  || ' inventory_shop2=' || (SELECT count(*) FROM inventory WHERE shop_id = 'qa-shop2-' || :'ts')
  || ' inventory_cross_rows=' || (SELECT count(*) FROM inventory
        WHERE (shop_id LIKE 'qa-%' AND product_id NOT LIKE 'qa-%')
           OR (product_id LIKE 'qa-%' AND shop_id NOT LIKE 'qa-%')) AS seed_extra;
