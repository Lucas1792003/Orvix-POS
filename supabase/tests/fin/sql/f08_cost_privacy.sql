-- f08: PCOST-A cost privacy, adversarial, through the real API roles.
--   cashier (F1) · manager without report:shop_profit (Manager F) ·
--   manager WITH report:shop_profit (Manager A, granted here) · owner (ADMIN A) ·
--   another tenant's ADMIN (ADMIN X) · anon
-- Runs after f00..f05 with PCOST-A applied (run.sh, FIN_WITH_PCOST=1).
\set ON_ERROR_STOP on
\set ADMIN   '''a0000000-0000-4000-8000-000000000001'''
\set ADMINX  '''a0000000-0000-4000-8000-000000000011'''
\set MGRA    '''a0000000-0000-4000-8000-000000000002'''
\set MGRF    '''f0000000-0000-4000-8000-000000000001'''
\set F1      '''f0000000-0000-4000-8000-000000000002'''

-- Manager A gets report:shop_profit (granted by the ADMIN, as the app would)
SELECT test.login(:ADMIN) AS zz \gset
UPDATE users SET granted_permissions = ARRAY['report:shop_profit'] WHERE id = 'u-mgr-a';
SELECT test.logout() AS zz \gset

-- ---------------------------------------------------------------- 0. data moved
SELECT test.check('f08 the legacy cost columns hold no value anywhere (products, product_units, sale_items)',
  NOT EXISTS (SELECT 1 FROM products WHERE cost_mmk IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM product_units WHERE purchase_price_mmk IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM sale_items WHERE unit_cost_mmk_snapshot IS NOT NULL));
SELECT test.check('f08 the costs live in the side tables (prod-1/2/3 = 600/1,200/1,800; unit purchase prices; sale line costs)',
  (SELECT array_agg(cost_mmk ORDER BY product_id) FROM product_costs WHERE product_id IN ('prod-1', 'prod-2', 'prod-3')) = ARRAY[600, 1200, 1800]
  AND (SELECT count(*) FROM product_unit_costs WHERE product_unit_id IN ('unit-1', 'unit-2', 'unit-3')) = 3
  AND (SELECT count(*) FROM sale_item_costs) > 0);
SELECT test.check('f08 every org-test sale line that had a cost keeps it (side table rows >= lines of costed products sold)',
  (SELECT count(*) FROM sale_item_costs c JOIN sale_items si ON si.id = c.sale_item_id) = (SELECT count(*) FROM sale_item_costs));

SELECT test.check('f08 exact table grants on the side tables: authenticated SELECT only; anon none; service_role SELECT only',
  (SELECT string_agg(table_name || ':' || grantee || ':' || privs, ' ' ORDER BY table_name, grantee) FROM (
     SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name IN ('product_costs', 'product_unit_costs', 'sale_item_costs')
        AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
      GROUP BY 1, 2) g)
  = 'product_costs:authenticated:SELECT product_costs:service_role:SELECT '
    || 'product_unit_costs:authenticated:SELECT product_unit_costs:service_role:SELECT '
    || 'sale_item_costs:authenticated:SELECT sale_item_costs:service_role:SELECT');
SELECT test.check('f08 RLS is enabled on the side tables and every policy is SELECT-only',
  (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.product_costs'::regclass, 'public.product_unit_costs'::regclass, 'public.sale_item_costs'::regclass))
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('product_costs', 'product_unit_costs', 'sale_item_costs') AND cmd <> 'SELECT'));

-- ---------------------------------------------------------------- 1. reads per role
CREATE OR REPLACE FUNCTION test.cost_view(p_auth uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  IF p_auth IS NULL THEN PERFORM test.logout(); ELSE PERFORM test.login(p_auth); END IF;
  EXECUTE CASE WHEN p_auth IS NULL THEN 'SET LOCAL ROLE anon' ELSE 'SET LOCAL ROLE authenticated' END;
  SELECT jsonb_build_object(
    'products_cost_non_null', (SELECT count(*) FROM products WHERE cost_mmk IS NOT NULL),
    'products_visible', (SELECT count(*) FROM products),
    'units_price_non_null', (SELECT count(*) FROM product_units WHERE purchase_price_mmk IS NOT NULL),
    'lines_snapshot_non_null', (SELECT count(*) FROM sale_items WHERE unit_cost_mmk_snapshot IS NOT NULL),
    'product_costs', (SELECT count(*) FROM product_costs),
    'product_costs_foreign_org', (SELECT count(*) FROM product_costs WHERE org_id <> COALESCE(public.app_org_id(), '')),
    'unit_costs', (SELECT count(*) FROM product_unit_costs),
    'line_costs', (SELECT count(*) FROM sale_item_costs),
    'line_cost_shops', (SELECT COALESCE(jsonb_agg(DISTINCT shop_id), '[]'::jsonb) FROM sale_item_costs)
  ) INTO r;
  EXECUTE 'RESET ROLE';
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END $$;

SELECT test.cost_view(:F1) AS v_cash \gset
SELECT test.cost_view(:MGRF) AS v_mgrf \gset
SELECT test.cost_view(:MGRA) AS v_mgra \gset
SELECT test.cost_view(:ADMIN) AS v_admin \gset
SELECT test.cost_view(:ADMINX) AS v_adminx \gset
SELECT test.cost_view(NULL) AS v_anon \gset

SELECT test.check('f08 CASHIER: legacy columns read NULL; product_costs / unit costs / line costs: 0 rows',
  (:'v_cash'::jsonb->>'products_visible')::int > 0 AND (:'v_cash'::jsonb->>'products_cost_non_null')::int = 0
  AND (:'v_cash'::jsonb->>'lines_snapshot_non_null')::int = 0
  AND (:'v_cash'::jsonb->>'product_costs')::int = 0 AND (:'v_cash'::jsonb->>'unit_costs')::int = 0
  AND (:'v_cash'::jsonb->>'line_costs')::int = 0, :'v_cash');
SELECT test.check('f08 MANAGER without report:shop_profit: no cost rows at all',
  (:'v_mgrf'::jsonb->>'product_costs')::int = 0 AND (:'v_mgrf'::jsonb->>'unit_costs')::int = 0
  AND (:'v_mgrf'::jsonb->>'line_costs')::int = 0 AND (:'v_mgrf'::jsonb->>'products_cost_non_null')::int = 0, :'v_mgrf');
SELECT test.check('f08 MANAGER with report:shop_profit: org product costs; sale line costs of OWN shop only',
  (:'v_mgra'::jsonb->>'product_costs')::int > 0 AND (:'v_mgra'::jsonb->>'product_costs_foreign_org')::int = 0
  AND (:'v_mgra'::jsonb->>'line_costs')::int > 0 AND :'v_mgra'::jsonb->'line_cost_shops' = '["shop-a"]'::jsonb, :'v_mgra');
SELECT test.check('f08 OWNER (ADMIN): all org costs, every org shop, nothing of another org',
  (:'v_admin'::jsonb->>'product_costs')::int = (SELECT count(*) FROM product_costs WHERE org_id = 'org-test')
  AND (:'v_admin'::jsonb->>'line_costs')::int = (SELECT count(*) FROM sale_item_costs WHERE org_id = 'org-test')
  AND (:'v_admin'::jsonb->>'product_costs_foreign_org')::int = 0, :'v_admin');
SELECT test.check('f08 OTHER TENANT ADMIN: only its own org rows (none of org-test)',
  (:'v_adminx'::jsonb->>'product_costs')::int = (SELECT count(*) FROM product_costs WHERE org_id = 'org-two')
  AND (:'v_adminx'::jsonb->>'product_costs_foreign_org')::int = 0
  AND NOT (:'v_adminx'::jsonb->'line_cost_shops') ?| ARRAY['shop-a', 'shop-b', 'shop-f', 'shop-v'], :'v_adminx');
SELECT test.check('f08 ANON: refused on the cost tables (no grant)', :'v_anon'::jsonb->>'error' LIKE 'permission denied%', :'v_anon');

-- ---------------------------------------------------------------- 2. select * (released clients)
SELECT test.login(:F1) AS zz \gset
SET ROLE authenticated;
SELECT test.check('f08 released clients: select * on products / product_units / sale_items still works for a cashier',
  (SELECT count(*) FROM (SELECT * FROM products) x) > 0 AND (SELECT count(*) FROM (SELECT * FROM product_units) x) > 0
  AND (SELECT count(*) FROM (SELECT * FROM sale_items) x) > 0);
SELECT test.expect_error('f08 CASHIER cannot write product_costs directly', $q$INSERT INTO product_costs (product_id, org_id, cost_mmk) VALUES ('prod-1', 'org-test', 1)$q$, 'permission denied');
SELECT test.expect_error('f08 CASHIER cannot call the redirect machinery', $q$SELECT public.cost_write_allowed()$q$, 'permission denied');
SELECT test.check('f08 CASHIER updating products is still blocked by RLS (0 rows touched)',
  test.affected($q$UPDATE products SET cost_mmk = 1 WHERE id = 'prod-1'$q$) = 0);
RESET ROLE;

-- ---------------------------------------------------------------- 3. writes by role
SELECT test.login(:MGRF) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f08 MANAGER without report:shop_profit cannot set a product cost (42501)',
  $q$UPDATE products SET cost_mmk = 999 WHERE id = 'prod-1'$q$, 'not permitted to set product cost');
SELECT test.expect_error('f08 ... nor a unit purchase price',
  $q$UPDATE product_units SET purchase_price_mmk = 999 WHERE id = 'unit-1'$q$, 'not permitted to set purchase prices');
SELECT test.check('f08 MANAGER without the permission can still edit prices; cost untouched',
  test.affected($q$UPDATE products SET price_mmk = 1000 WHERE id = 'prod-1'$q$) = 1);
SELECT test.check('f08 a released client re-sending cost_mmk = NULL is "no change", not an erase',
  test.affected($q$UPDATE products SET cost_mmk = NULL, price_mmk = 1000 WHERE id = 'prod-1'$q$) = 1);
RESET ROLE;
SELECT test.check('f08 prod-1 cost still 600 after the manager edits', (SELECT cost_mmk FROM product_costs WHERE product_id = 'prod-1') = 600);

SELECT test.login(:ADMIN) AS zz \gset
SET ROLE authenticated;
SELECT test.check('f08 OWNER sets a cost through the legacy column: redirected (table 650, column NULL)',
  test.affected($q$UPDATE products SET cost_mmk = 650 WHERE id = 'prod-1'$q$) = 1);
SELECT test.check('f08 OWNER inserts a product with cost: redirected',
  test.affected($q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-cp', 'SKUCP', 'Cost Privacy Product', 'General', 'pcs', 900, 400)$q$) = 1);
SELECT test.expect_error('f08 even the OWNER cannot write product_costs directly (only through the guarded tables)',
  $q$UPDATE product_costs SET cost_mmk = 1 WHERE product_id = 'prod-1'$q$, 'permission denied');
RESET ROLE;
SELECT test.check('f08 redirected values landed in the side table; legacy columns NULL',
  (SELECT cost_mmk FROM product_costs WHERE product_id = 'prod-1') = 650
  AND (SELECT cost_mmk FROM product_costs WHERE product_id = 'prod-cp') = 400
  AND (SELECT cost_mmk FROM products WHERE id IN ('prod-1')) IS NULL AND (SELECT cost_mmk FROM products WHERE id = 'prod-cp') IS NULL
  AND (SELECT org_id FROM product_costs WHERE product_id = 'prod-cp') = 'org-test');
-- put prod-1 back to 600 (later checks use it)
SELECT test.login(:ADMIN) AS zz \gset
UPDATE products SET cost_mmk = 600 WHERE id = 'prod-1';

-- released clients' units editor upserts every unit with purchase_price_mmk = NULL when it does not know it
SELECT test.login(:MGRF) AS zz \gset
SET ROLE authenticated;
SELECT test.check('f08 released-client units upsert by a manager (purchase_price_mmk NULL) succeeds and erases nothing',
  test.affected($q$INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk)
     VALUES ('unit-1', 'prod-1', 'pcs', 1, true, true, 1000, NULL)
     ON CONFLICT (id) DO UPDATE SET sale_price_mmk = EXCLUDED.sale_price_mmk, purchase_price_mmk = EXCLUDED.purchase_price_mmk$q$) = 1);
RESET ROLE;
SELECT test.check('f08 unit-1 purchase price kept in product_unit_costs', (SELECT purchase_price_mmk FROM product_unit_costs WHERE product_unit_id = 'unit-1') IS NOT NULL);
SELECT test.login(:ADMIN) AS zz \gset
SET ROLE authenticated;
SELECT test.check('f08 the same upsert by the OWNER with a value is redirected (side table 610, column NULL)',
  test.affected($q$INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk)
     VALUES ('unit-1', 'prod-1', 'pcs', 1, true, true, 1000, 610)
     ON CONFLICT (id) DO UPDATE SET sale_price_mmk = EXCLUDED.sale_price_mmk, purchase_price_mmk = EXCLUDED.purchase_price_mmk$q$) = 1);
RESET ROLE;
SELECT test.check('f08 redirected unit price stored, legacy column NULL',
  (SELECT purchase_price_mmk FROM product_unit_costs WHERE product_unit_id = 'unit-1') = 610
  AND (SELECT purchase_price_mmk FROM product_units WHERE id = 'unit-1') IS NULL);

-- review: an upsert naming ANOTHER tenant's id. BEFORE INSERT runs before the
-- primary-key conflict; with ignore-duplicates (ON CONFLICT DO NOTHING) the
-- conflict is a no-op, so only the trigger stands between it and the cost row.
SELECT test.login(:ADMINX) AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('f08 ADMIN X: ignore-duplicates upsert of org-test''s product id with a cost is refused',
  $q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-1', 'SKUXX', 'Hijack', 'Cat X', 'pcs', 1, 1) ON CONFLICT (id) DO NOTHING$q$,
  'not permitted');
SELECT test.expect_error('f08 ADMIN X: ignore-duplicates upsert of org-test''s unit id (own product) with a price is refused',
  $q$INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk)
     VALUES ('unit-1', 'prod-x1', 'pcs', 1, false, true, 1, 1) ON CONFLICT (id) DO NOTHING$q$,
  'not permitted');
SELECT test.check('f08 ADMIN X: a plain ignore-duplicates upsert WITHOUT cost is still a harmless no-op',
  test.affected($q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk) VALUES ('prod-1', 'SKUXX', 'Hijack', 'Cat X', 'pcs', 1) ON CONFLICT (id) DO NOTHING$q$) = 0);
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('f08 org-test cost rows untouched by ADMIN X (prod-1 600 / unit-1 610, still org-test)',
  (SELECT (cost_mmk, org_id) FROM product_costs WHERE product_id = 'prod-1') = (600, 'org-test'::text)
  AND (SELECT (purchase_price_mmk, org_id) FROM product_unit_costs WHERE product_unit_id = 'unit-1') = (610, 'org-test'::text)
  AND (SELECT name FROM products WHERE id = 'prod-1') <> 'Hijack');

-- ---------------------------------------------------------------- 4. complete_sale: no cost in the reply, snapshot taken
SELECT test.login(:F1) AS zz \gset
SET ROLE authenticated;
SELECT public.complete_sale('shop-f', test.var('S3'), 'CASH', 2000, 0,
  '[{"product_id":"prod-1","qty":2}]'::jsonb, NULL, gen_random_uuid()) AS cs \gset
RESET ROLE;
SELECT test.setvar('cp_sale', :'cs'::jsonb->'sale'->>'id');
SELECT test.check('f08 complete_sale reply to the cashier carries no cost (unitCostMmkSnapshot null)',
  NOT EXISTS (SELECT 1 FROM jsonb_array_elements(:'cs'::jsonb->'items') i WHERE i->'unitCostMmkSnapshot' IS NOT NULL AND i->'unitCostMmkSnapshot' <> 'null'::jsonb),
  (:'cs'::jsonb->'items')::text);
SELECT test.check('f08 the sale line cost snapshot was taken into sale_item_costs (600 per unit), column NULL',
  (SELECT c.unit_cost_mmk FROM sale_item_costs c JOIN sale_items si ON si.id = c.sale_item_id WHERE si.sale_id = test.var('cp_sale')) = 600
  AND (SELECT unit_cost_mmk_snapshot FROM sale_items WHERE sale_id = test.var('cp_sale')) IS NULL
  AND (SELECT shop_id FROM sale_item_costs c JOIN sale_items si ON si.id = c.sale_item_id WHERE si.sale_id = test.var('cp_sale')) = 'shop-f');
SELECT test.check('f08 the stored idempotency reply of that sale carries no cost either',
  NOT EXISTS (SELECT 1 FROM idempotency_keys k, jsonb_array_elements(k.response->'items') i
               WHERE k.rpc = 'complete_sale' AND k.response->'sale'->>'id' = test.var('cp_sale')
                 AND i->'unitCostMmkSnapshot' IS NOT NULL AND i->'unitCostMmkSnapshot' <> 'null'::jsonb));
-- the shop-F sale is visible to a profit manager of shop A? (no: other shop)
SELECT test.cost_view(:MGRA) AS v_mgra2 \gset
SELECT test.check('f08 the new shop-F line cost is not visible to shop A''s profit manager', NOT (:'v_mgra2'::jsonb->'line_cost_shops') ? 'shop-f');

-- review: a SQL-session insert (data-only restore / import, no API request)
-- of a line without a snapshot stays uncosted; it never takes today's cost.
SELECT test.logout() AS zz \gset
INSERT INTO sale_items (id, sale_id, product_id, qty_units, unit_price_mmk, line_total_mmk)
VALUES ('si-restore-1', test.var('cp_sale'), 'prod-1', 1, 1000, 1000);
SELECT test.check('f08 restored line without a snapshot gets no cost row (COGS stays incomplete, not today''s cost)',
  NOT EXISTS (SELECT 1 FROM sale_item_costs WHERE sale_item_id = 'si-restore-1'));
INSERT INTO sale_items (id, sale_id, product_id, qty_units, unit_price_mmk, line_total_mmk, unit_cost_mmk_snapshot)
VALUES ('si-restore-2', test.var('cp_sale'), 'prod-1', 1, 1000, 1000, 333);
SELECT test.check('f08 restored line WITH its snapshot keeps that snapshot (side table 333, column NULL)',
  (SELECT unit_cost_mmk FROM sale_item_costs WHERE sale_item_id = 'si-restore-2') = 333
  AND (SELECT unit_cost_mmk_snapshot FROM sale_items WHERE id = 'si-restore-2') IS NULL);
DELETE FROM sale_items WHERE id IN ('si-restore-1', 'si-restore-2');

-- ---------------------------------------------------------------- 5. reports keep their own permission checks
SELECT test.f_report(:ADMIN, 'shop-f', (now() AT TIME ZONE 'Asia/Yangon')::date, (now() AT TIME ZONE 'Asia/Yangon')::date, 'SALE_DATE') AS rep \gset
SELECT test.f_report(:MGRF, NULL, (now() AT TIME ZONE 'Asia/Yangon')::date, (now() AT TIME ZONE 'Asia/Yangon')::date, 'SALE_DATE') AS rep_m \gset
SELECT test.check('f08 reports read cost from sale_item_costs (owner sees COGS); manager without the permission gets none',
  (:'rep'::jsonb->'totals'->>'cogsMmk')::bigint > 0 AND :'rep_m'::jsonb->'totals'->'cogsMmk' = 'null'::jsonb);
SELECT test.logout() AS zz \gset
SET ROLE anon;
SELECT test.expect_error('f08 anon cannot reach the reports', $q$SELECT public.fin_report_summary(NULL, current_date, current_date, 'SALE_DATE')$q$, 'permission denied');
RESET ROLE;

-- ---------------------------------------------------------------- 6. purchase receive keeps its unit price snapshot
SELECT test.login(:ADMIN) AS zz \gset
UPDATE product_units SET purchase_price_mmk = 550 WHERE id = 'unit-1';
INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by, approved_by, approved_at)
VALUES ('po-cp', 'PO-CP-0001', 'shop-a', 'sup-1', 'APPROVED', 5500, 5500, 'u-mgr-a', 'u-admin', now());
INSERT INTO purchase_order_items (id, purchase_order_id, product_id, product_unit_id, ordered_qty, unit_cost_mmk, line_total_mmk)
VALUES ('poi-cp', 'po-cp', 'prod-1', 'unit-1', 10, 550, 5500);
SELECT test.login(:MGRA) AS zz \gset
SELECT public.receive_purchase_order('po-cp', NULL, NULL, NULL, gen_random_uuid()) AS rcv \gset
SELECT test.check('f08 receive_purchase_order still snapshots the unit purchase price (from product_unit_costs)',
  (SELECT unit_purchase_price_snapshot FROM purchase_order_items WHERE id = 'poi-cp') = 550
  AND (SELECT purchase_price_mmk FROM product_units WHERE id = 'unit-1') IS NULL);
SELECT test.logout() AS zz \gset
-- f06 compares the under-087 report with the figures before 087: refresh them (this file added a sale)
SELECT test.f_report('a0000000-0000-4000-8000-000000000001', 'shop-f', (now() AT TIME ZONE 'Asia/Yangon')::date, (now() AT TIME ZONE 'Asia/Yangon')::date, 'SALE_DATE') AS rfinal \gset
SELECT test.setvar('f05_totals', (:'rfinal'::jsonb->'totals')::text);
SELECT test.logout() AS zz \gset
