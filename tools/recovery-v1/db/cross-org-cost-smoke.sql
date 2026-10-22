-- Review round 2 (H3), financial provisionals only: product_costs is keyed on product_id and
-- read when sale costs are snapshotted, so an ACTIVE org must not write a RESTRICTED org's product cost.
\set ON_ERROR_STOP on
SELECT test.expect_error('superuser: an ACTIVE org cost row for a RESTRICTED org product is refused',
  $$INSERT INTO public.product_costs(product_id,org_id,cost_mmk) VALUES('prod-unrel','org-test',1)$$, 'ORG_SUSPENDED');
SELECT test.expect_error('superuser: a cost row updated by a RESTRICTED org user is refused',
  $$UPDATE public.product_costs SET updated_by='u-unrel' WHERE product_id='prod-1'$$, 'ORG_SUSPENDED');
-- Review round 4: a cost row written FIRST for a not-yet-existing id must not let that id be
-- created in another organization afterwards (even with BOTH organizations ACTIVE).
\set fx_org org-unrelated
\ir ../step5/fixture-activate.psql
SELECT test.expect_error('both ACTIVE: org-test cost row first, then the product created in org-unrelated, is refused',
  $$DO $x$ BEGIN
    INSERT INTO public.product_costs(product_id,org_id,cost_mmk) VALUES('p-future','org-test',42);
    INSERT INTO public.products SELECT (jsonb_populate_record(NULL::public.products, to_jsonb(p)||'{"id":"p-future","sku":"P-FUTURE"}')).* FROM public.products p WHERE id='prod-unrel';
  END $x$ $$, 'unknown_or_cross_tenant_write');
SELECT test.expect_error('both ACTIVE: org-test unit cost first, then the unit created under an org-unrelated product, is refused',
  $$DO $x$ BEGIN
    INSERT INTO public.product_unit_costs(product_unit_id,product_id,org_id,purchase_price_mmk) VALUES('pu-future','prod-1','org-test',7);    -- cost row is self-consistent (org-test product)
    INSERT INTO public.product_units SELECT (jsonb_populate_record(NULL::public.product_units, to_jsonb(u)||'{"id":"pu-future","product_id":"prod-unrel","is_default":false,"name":"future"}')).* FROM public.product_units u LIMIT 1;
  END $x$ $$, 'cross_tenant');
UPDATE recovery_v1.org_state SET state='RESTRICTED' WHERE org_id='org-unrelated';
SELECT test.check('no forward-referenced cost row or parent was left behind',
  NOT EXISTS(SELECT 1 FROM public.product_costs WHERE product_id='p-future') AND NOT EXISTS(SELECT 1 FROM public.products WHERE id='p-future')
  AND NOT EXISTS(SELECT 1 FROM public.product_unit_costs WHERE product_unit_id='pu-future') AND NOT EXISTS(SELECT 1 FROM public.product_units WHERE id='pu-future'));
