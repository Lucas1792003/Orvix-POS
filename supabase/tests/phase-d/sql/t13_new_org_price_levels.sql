-- t13 (part A): 077 - every organization gets the default price levels.
-- Console path (service_role, like supabase/functions/platform-console
-- create_organization), idempotent seeding, concurrent creation (dblink),
-- checkout in the new orgs and in the existing org, no cross-org references,
-- console rollback delete. run.sh then RE-APPLIES 077 (backfill of a pre-077
-- org with zero levels) and runs part B (t13_new_org_price_levels_b.sql).
-- Gated by run.sh on migrations >= 077. Synthetic data only.
\set ON_ERROR_STOP on
\set AA  'a0000000-0000-4000-8000-000000000001'
\set Q1  'c0000000-0000-4000-8000-0000000000a1'
\set Q2  'c0000000-0000-4000-8000-0000000000b1'
\set QZ  'c0000000-0000-4000-8000-0000000000c1'
\set QD  'c0000000-0000-4000-8000-0000000000d1'
SELECT test.logout() AS zz \gset

CREATE OR REPLACE FUNCTION test.as_service_role() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', false);
  PERFORM set_config('request.jwt.claim.role', 'service_role', false);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, false);
END $$;
GRANT EXECUTE ON FUNCTION test.as_service_role() TO service_role;

-- fingerprint of one org's price levels (ids, codes, names, flags, order, timestamps)
CREATE OR REPLACE FUNCTION test.pl_fingerprint(p_org text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT count(*)::text || ':' || COALESCE(md5(string_agg(
           concat_ws('|', id, code, name, is_default, is_active, sort_order, created_at, updated_at),
           ',' ORDER BY id)), '-')
    FROM public.price_levels WHERE org_id = p_org;
$$;
-- the 030 default set, as (code, name, default, active, sort) for one org
CREATE OR REPLACE FUNCTION test.pl_is_default_set(p_org text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (SELECT string_agg(concat_ws('|', code, name, is_default, is_active, sort_order), ',' ORDER BY sort_order)
            FROM public.price_levels WHERE org_id = p_org)
       = 'retail|Retail|t|t|10,wholesale|Wholesale|f|t|20,special|Special|f|t|30';
$$;

-- fingerprints of every org that exists now (all of them already have levels)
DO $$ BEGIN PERFORM test.setvar('t13_fp_' || o.id, test.pl_fingerprint(o.id)) FROM organizations o; END $$;
SELECT test.setvar('t13_orgs_before', string_agg(id, ',' ORDER BY id)) AS zz FROM organizations \gset
SELECT test.check('t13/077: structure - AFTER INSERT trigger on organizations, SECURITY DEFINER seed functions, FK ON DELETE CASCADE',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organizations'::regclass
           AND tgname = 'organizations_seed_price_levels' AND NOT tgisinternal)
  AND (SELECT prosecdef FROM pg_proc WHERE oid = 'public.app_seed_default_price_levels(text)'::regprocedure)
  AND (SELECT prosecdef FROM pg_proc WHERE oid = 'public.organizations_seed_price_levels()'::regprocedure)
  AND (SELECT confdeltype FROM pg_constraint WHERE conname = 'price_levels_org_id_fkey') = 'c');
SELECT test.check('t13/077: app_seed_default_price_levels is service_role only (takes a foreign org id)',
  NOT has_function_privilege('authenticated', 'public.app_seed_default_price_levels(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.app_seed_default_price_levels(text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.app_seed_default_price_levels(text)', 'EXECUTE'));

INSERT INTO auth.users (id, email) VALUES
  (:'Q1', 'owner@qa1.local'), (:'Q2', 'owner@qa2.local'), (:'QZ', 'owner@qzero.local'), (:'QD', 'owner@qdel.local');

-- ============================================================
-- 1. Root cause, reproduced: an org WITHOUT price levels cannot sell.
--    org-q-zero is created, then its levels are removed (= an org created
--    before 077). It is left in that state for the re-applied 077 backfill.
-- ============================================================
SELECT test.as_service_role() AS zz \gset
SET ROLE service_role;
INSERT INTO organizations (id, name) VALUES ('org-q-zero', 'QA Zero');
INSERT INTO users (id, name, email, role, org_id, auth_id, is_active)
VALUES ('u-qzero-admin', 'QZ Owner', 'owner@qzero.local', 'ADMIN', 'org-q-zero', :'QZ', true);
RESET ROLE;
DELETE FROM price_levels WHERE org_id = 'org-q-zero';
SELECT test.logout() AS zz \gset

SELECT test.login(:'QZ') AS zz \gset
SET ROLE authenticated;
INSERT INTO shops (id, code, name, address) VALUES ('shop-qz', 'QZ1', 'QZ Main', 'Z St');
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-qz', 'QZ-1', 'Zed', 'General', 'pcs', 1500, 700);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk)
VALUES ('unit-qz', 'prod-qz', 'pcs', 1, true, true, 1500, 700);
SELECT public.adjust_stock('shop-qz', 'prod-qz', 'ADJUSTMENT', 10, 'opening', NULL, NULL, NULL, NULL, 'cccccccc-0000-4000-8000-0000000000c1') AS zz \gset
SELECT public.open_shift('shop-qz', 0, NULL, NULL, 'cccccccc-0000-4000-8000-0000000000c2') AS osz \gset
SELECT test.setvar('t13_shift_qz', :'osz'::jsonb->'shift'->>'id') AS zz \gset
SELECT test.expect_error('t13/077 root cause: an org with no price level cannot complete a sale',
  format($q$SELECT public.complete_sale('shop-qz', %L, 'CASH', 1500, 0, '[{"product_id":"prod-qz","qty":1}]'::jsonb, NULL, 'cccccccc-0000-4000-8000-0000000000c3')$q$,
         test.var('t13_shift_qz')),
  'No active price level available');
RESET ROLE;
SELECT test.logout() AS zz \gset

-- ============================================================
-- 2. Console path: two QA orgs + their first ADMINs, as service_role
-- ============================================================
SELECT test.as_service_role() AS zz \gset
SET ROLE service_role;
SELECT test.check('t13/077 console: service_role creates org-qa1 and org-qa2 with their ADMINs',
  test.affected($q$INSERT INTO organizations (id, name) VALUES ('org-qa1', 'QA One')$q$) = 1
  AND test.affected($q$INSERT INTO users (id, name, email, role, org_id, auth_id, is_active)
        VALUES ('u-qa1-admin', 'QA1 Owner', 'owner@qa1.local', 'ADMIN', 'org-qa1', 'c0000000-0000-4000-8000-0000000000a1', true)$q$) = 1
  AND test.affected($q$INSERT INTO organizations (id, name) VALUES ('org-qa2', 'QA Two')$q$) = 1
  AND test.affected($q$INSERT INTO users (id, name, email, role, org_id, auth_id, is_active)
        VALUES ('u-qa2-admin', 'QA2 Owner', 'owner@qa2.local', 'ADMIN', 'org-qa2', 'c0000000-0000-4000-8000-0000000000b1', true)$q$) = 1);
-- re-running the trigger path: the seed function again, for the same orgs
SELECT public.app_seed_default_price_levels('org-qa1') AS reseed1 \gset
SELECT public.app_seed_default_price_levels('org-qa1') AS reseed2 \gset
SELECT public.app_seed_default_price_levels('org-qa2') AS reseed3 \gset
RESET ROLE;
SELECT test.logout() AS zz \gset

SELECT test.check('t13/077: both new orgs got exactly the 030 default set (Retail default 10, Wholesale 20, Special 30, all active)',
  test.pl_is_default_set('org-qa1') AND test.pl_is_default_set('org-qa2'),
  'qa1=' || test.pl_fingerprint('org-qa1') || ' qa2=' || test.pl_fingerprint('org-qa2'));
SELECT test.check('t13/077: one active default per new org; level ids are distinct across orgs',
  (SELECT count(*) FROM price_levels WHERE org_id = 'org-qa1' AND is_default AND is_active) = 1
  AND (SELECT count(*) FROM price_levels WHERE org_id = 'org-qa2' AND is_default AND is_active) = 1
  AND NOT EXISTS (SELECT 1 FROM price_levels a JOIN price_levels b ON a.id = b.id AND a.org_id <> b.org_id));
SELECT test.check('t13/077: re-running the seed for an org that has its levels inserts nothing (no duplicates)',
  :reseed1 = 0 AND :reseed2 = 0 AND :reseed3 = 0
  AND (SELECT count(*) FROM price_levels WHERE org_id IN ('org-qa1', 'org-qa2')) = 6,
  'reseed=' || :reseed1 || '/' || :reseed2 || '/' || :reseed3);
SELECT test.check('t13/077: existing organizations unchanged (count + checksum of their price levels)',
  (SELECT bool_and(test.pl_fingerprint(o.id) = test.var('t13_fp_' || o.id))
     FROM organizations o WHERE o.id = ANY (string_to_array(test.var('t13_orgs_before'), ','))),
  'org-test=' || test.pl_fingerprint('org-test'));

-- ============================================================
-- 3. Concurrent creation (two real sessions through dblink)
-- ============================================================
-- dblink lives in its own schema so it never shows up in the public
-- function inventory (t01 / t15 count public functions and anon grants)
CREATE SCHEMA IF NOT EXISTS test_dblink;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA test_dblink;
SET search_path = public, test_dblink;
SELECT dblink_connect('t13c1', 'dbname=postgres user=supabase_admin') AS zz \gset
SELECT dblink_connect('t13c2', 'dbname=postgres user=supabase_admin') AS zz \gset
SELECT dblink_exec('t13c1', 'SET ROLE service_role') AS zz \gset
SELECT dblink_exec('t13c2', 'SET ROLE service_role') AS zz \gset
-- (a) the SAME org id from two sessions: c1 holds its insert open, c2 blocks
--     on the primary key, c1 commits, c2 fails; its trigger never ran.
SELECT dblink_exec('t13c1', 'BEGIN') AS zz \gset
SELECT dblink_exec('t13c1', $q$INSERT INTO organizations (id, name) VALUES ('org-qa-same', 'Same')$q$) AS zz \gset
SELECT dblink_send_query('t13c2', $q$INSERT INTO organizations (id, name) VALUES ('org-qa-same', 'Same again')$q$) AS zz \gset
SELECT pg_sleep(1) AS zz \gset
SELECT dblink_is_busy('t13c2') AS c2_busy \gset
SELECT dblink_exec('t13c1', 'COMMIT') AS zz \gset
SELECT count(*) AS c2_rows FROM dblink_get_result('t13c2', false) AS t(x text) \gset
SELECT dblink_error_message('t13c2') AS c2_err \gset
SELECT count(*) AS zz FROM dblink_get_result('t13c2', false) AS t(x text) \gset
SELECT test.check('t13/077 concurrent: same org id from two sessions -> the second waits and fails, exactly one org with 3 levels',
  :'c2_busy'::boolean AND position('duplicate key' in :'c2_err') > 0
  AND (SELECT count(*) FROM organizations WHERE id = 'org-qa-same') = 1
  AND test.pl_is_default_set('org-qa-same'),
  'c2 busy=' || :'c2_busy' || ' err=' || left(:'c2_err', 80) || ' levels=' || test.pl_fingerprint('org-qa-same'));
-- (b) two different orgs inside overlapping transactions
SELECT dblink_exec('t13c1', 'BEGIN') AS zz \gset
SELECT dblink_exec('t13c2', 'BEGIN') AS zz \gset
SELECT dblink_exec('t13c1', $q$INSERT INTO organizations (id, name) VALUES ('org-qa-c1', 'C1')$q$) AS zz \gset
SELECT dblink_exec('t13c2', $q$INSERT INTO organizations (id, name) VALUES ('org-qa-c2', 'C2')$q$) AS zz \gset
SELECT dblink_exec('t13c2', 'COMMIT') AS zz \gset
SELECT dblink_exec('t13c1', 'COMMIT') AS zz \gset
SELECT dblink_disconnect('t13c1') AS zz \gset
SELECT dblink_disconnect('t13c2') AS zz \gset
RESET search_path;
SELECT test.check('t13/077 concurrent: two orgs created in overlapping transactions each get exactly their own default set',
  test.pl_is_default_set('org-qa-c1') AND test.pl_is_default_set('org-qa-c2'));

-- ============================================================
-- 4. Checkout succeeds in both new orgs (default level, no price_level_id sent)
-- ============================================================
SELECT test.login(:'Q1') AS zz \gset
SET ROLE authenticated;
INSERT INTO shops (id, code, name, address) VALUES ('shop-qa1', 'QA1', 'QA1 Main', 'One St');
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-qa1', 'QA-1', 'Gadget', 'General', 'pcs', 1200, 600);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk)
VALUES ('unit-qa1', 'prod-qa1', 'pcs', 1, true, true, 1200, 600);
SELECT public.adjust_stock('shop-qa1', 'prod-qa1', 'ADJUSTMENT', 10, 'opening', NULL, NULL, NULL, NULL, 'cccccccc-0000-4000-8000-0000000000a1') AS zz \gset
SELECT public.open_shift('shop-qa1', 0, NULL, NULL, 'cccccccc-0000-4000-8000-0000000000a2') AS os1 \gset
SELECT public.complete_sale('shop-qa1', :'os1'::jsonb->'shift'->>'id', 'CASH', 1200, 0,
  '[{"product_id":"prod-qa1","qty":1}]'::jsonb, NULL, 'cccccccc-0000-4000-8000-0000000000a3') AS sale1 \gset
RESET ROLE;
SELECT test.check('t13/077: checkout in console-created org-qa1 succeeds, priced through ITS OWN Retail default',
  (:'sale1'::jsonb->'sale'->>'shopId') = 'shop-qa1'
  AND (SELECT l.org_id = 'org-qa1' AND l.code = 'retail'
         FROM sale_items si JOIN price_levels l ON l.id = si.price_level_id
        WHERE si.sale_id = :'sale1'::jsonb->'sale'->>'id' LIMIT 1),
  'sale=' || (:'sale1'::jsonb->'sale'->>'id'));

SELECT test.login(:'Q2') AS zz \gset
SET ROLE authenticated;
INSERT INTO shops (id, code, name, address) VALUES ('shop-qa2', 'QA1', 'QA2 Main', 'Two St');   -- same code as qa1: per org
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-qa2', 'QA-1', 'Gadget', 'General', 'pcs', 900, 400);
INSERT INTO product_units (id, product_id, name, base_quantity, is_default, is_active, sale_price_mmk, purchase_price_mmk)
VALUES ('unit-qa2', 'prod-qa2', 'pcs', 1, true, true, 900, 400);
SELECT public.adjust_stock('shop-qa2', 'prod-qa2', 'ADJUSTMENT', 10, 'opening', NULL, NULL, NULL, NULL, 'cccccccc-0000-4000-8000-0000000000b1') AS zz \gset
SELECT public.open_shift('shop-qa2', 0, NULL, NULL, 'cccccccc-0000-4000-8000-0000000000b2') AS os2 \gset
SELECT test.setvar('t13_shift_qa2', :'os2'::jsonb->'shift'->>'id') AS zz \gset
SELECT public.complete_sale('shop-qa2', :'os2'::jsonb->'shift'->>'id', 'CASH', 900, 0,
  '[{"product_id":"prod-qa2","qty":1}]'::jsonb, NULL, 'cccccccc-0000-4000-8000-0000000000b3') AS sale2 \gset
-- explicit Wholesale (own org): resolves, falls back to the Retail/legacy price (030 resolver)
SELECT public.complete_sale('shop-qa2', :'os2'::jsonb->'shift'->>'id', 'CASH', 900, 0,
  jsonb_build_array(jsonb_build_object('product_id', 'prod-qa2', 'qty', 1,
    'price_level_id', (SELECT id FROM price_levels WHERE code = 'wholesale'))), NULL, 'cccccccc-0000-4000-8000-0000000000b4') AS sale2w \gset
RESET ROLE;
SELECT test.check('t13/077: checkout in console-created org-qa2 succeeds (default level, and its own Wholesale level)',
  (:'sale2'::jsonb->'sale'->>'shopId') = 'shop-qa2' AND (:'sale2w'::jsonb->'sale'->>'shopId') = 'shop-qa2'
  AND (SELECT bool_and(l.org_id = 'org-qa2') FROM sale_items si JOIN price_levels l ON l.id = si.price_level_id
        WHERE si.sale_id IN (:'sale2'::jsonb->'sale'->>'id', :'sale2w'::jsonb->'sale'->>'id')));

-- existing org (org-test, its pre-077 levels): checkout still priced through pl-retail
SELECT test.login(:'AA') AS zz \gset
SELECT COALESCE((SELECT id FROM shifts WHERE cashier_id = 'u-admin' AND shop_id = 'shop-b' AND ended_at IS NULL LIMIT 1), '') AS t13_shift_a \gset
SELECT (:'t13_shift_a' = '') AS t13_need_shift \gset
SET ROLE authenticated;
\if :t13_need_shift
SELECT public.open_shift('shop-b', 0, NULL, NULL, 'cccccccc-0000-4000-8000-0000000000e1') AS osa \gset
SELECT :'osa'::jsonb->'shift'->>'id' AS t13_shift_a \gset
\endif
SELECT public.complete_sale('shop-b', :'t13_shift_a', 'CASH', 2000, 0,
  '[{"product_id":"prod-2","qty":1}]'::jsonb, NULL, 'cccccccc-0000-4000-8000-0000000000e2') AS salea \gset
RESET ROLE;
SELECT test.check('t13/077: checkout in the existing org still works and is priced through its own pl-retail',
  (:'salea'::jsonb->'sale'->>'shopId') = 'shop-b'
  AND (SELECT price_level_id FROM sale_items WHERE sale_id = :'salea'::jsonb->'sale'->>'id' LIMIT 1) = 'pl-retail');

-- ============================================================
-- 5. Org A cannot reference org B's price levels
-- ============================================================
SELECT test.login(:'Q1') AS zz \gset
SELECT id AS qa2_retail FROM price_levels WHERE org_id = 'org-qa2' AND code = 'retail' \gset
SET ROLE authenticated;
SELECT test.check('t13/077: org-qa1 ADMIN sees exactly its own 3 price levels',
  (SELECT count(*) FROM price_levels) = 3 AND (SELECT count(*) FROM price_levels WHERE org_id <> 'org-qa1') = 0);
SELECT test.expect_error('t13/077: org-qa1 cannot price its unit through org-qa2''s level (068 same-org trigger)',
  format($q$INSERT INTO product_unit_prices (id, product_unit_id, price_level_id, price_mmk) VALUES ('pup-qa-x', 'unit-qa1', %L, 1)$q$, :'qa2_retail'),
  'Price level not found in your organization');
SELECT test.expect_error('t13/077: org-qa1 cannot sell through org-qa2''s level (072 lookup)',
  format($q$SELECT public.complete_sale('shop-qa1', %L, 'CASH', 1200, 0, %L::jsonb, NULL, 'cccccccc-0000-4000-8000-0000000000a5')$q$,
         :'os1'::jsonb->'shift'->>'id',
         jsonb_build_array(jsonb_build_object('product_id', 'prod-qa1', 'qty', 1, 'price_level_id', :'qa2_retail'))::text),
  'is not active');
SELECT test.check('t13/077: UPDATE of org-qa2''s levels from org-qa1 touches nothing',
  test.affected(format($q$UPDATE price_levels SET name = 'pwned' WHERE id = %L$q$, :'qa2_retail')) = 0);
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.as_service_role() AS zz \gset
SET ROLE service_role;
SELECT test.expect_error('t13/077: even service_role cannot create a cross-org price reference',
  format($q$INSERT INTO product_unit_prices (id, product_unit_id, price_level_id, price_mmk) VALUES ('pup-qa-y', 'unit-qa1', %L, 1)$q$, :'qa2_retail'),
  'Price level not found in your organization');
-- ============================================================
-- 6. Console rollback: deleting a just-created org removes its seeded levels
-- ============================================================
INSERT INTO organizations (id, name) VALUES ('org-qa-del', 'Rollback QA');
SELECT count(*) AS del_levels FROM price_levels WHERE org_id = 'org-qa-del' \gset
SELECT test.affected($q$DELETE FROM organizations WHERE id = 'org-qa-del'$q$) AS del_rows \gset
SELECT test.check('t13/077 console rollback: DELETE of a just-created org succeeds and its seeded levels go with it (FK CASCADE)',
  :del_levels = 3 AND :del_rows = 1
  AND NOT EXISTS (SELECT 1 FROM price_levels WHERE org_id = 'org-qa-del'),
  'levels before=' || :del_levels || ' deleted orgs=' || :del_rows);
SELECT test.expect_error('t13/077: a populated org still cannot be deleted (CASCADE reaches only its levels; shops/products/users FKs block)',
  $q$DELETE FROM organizations WHERE id = 'org-qa1'$q$, 'violates foreign key constraint');
RESET ROLE;
SELECT test.logout() AS zz \gset

-- state for part B (after run.sh re-applies 077)
DO $$ BEGIN PERFORM test.setvar('t13b_fp_' || o.id, test.pl_fingerprint(o.id)) FROM organizations o WHERE o.id <> 'org-q-zero'; END $$;
SELECT test.setvar('t13b_orgs', string_agg(id, ',' ORDER BY id)) AS zz FROM organizations WHERE id <> 'org-q-zero' \gset
SELECT test.setvar('t13b_levels_before', (SELECT count(*)::text FROM price_levels)) AS zz \gset
SELECT test.check('t13/077: before the re-apply, org-q-zero (pre-077 org) still has zero levels',
  (SELECT count(*) FROM price_levels WHERE org_id = 'org-q-zero') = 0);
