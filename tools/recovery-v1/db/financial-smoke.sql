-- Main smoke leaves org-test ACTIVE solely as a synthetic superuser fixture.
\set ON_ERROR_STOP on
SELECT test.check('PCOST side tables all guarded ALWAYS',(SELECT count(*)=6 FROM pg_trigger WHERE tgrelid IN('public.product_costs'::regclass,'public.product_unit_costs'::regclass,'public.sale_item_costs'::regclass) AND tgname IN('zz_recovery_v1_write','zz_recovery_v1_truncate') AND tgenabled='A'));
SELECT test.check('PCOST public client cost grants remain SELECT only',NOT EXISTS(SELECT 1 FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN('product_costs','product_unit_costs','sale_item_costs') AND grantee IN('anon','authenticated','service_role','PUBLIC') AND (privilege_type<>'SELECT' OR grantee IN('anon','PUBLIC'))));
SELECT test.login('a0000000-0000-4000-8000-000000000003') AS zz \gset
SET ROLE authenticated;
SELECT test.check('CASHIER cost privacy retained under recovery v1',(SELECT count(*)=0 FROM public.product_costs) AND (SELECT count(*)=0 FROM public.product_unit_costs) AND (SELECT count(*)=0 FROM public.sale_item_costs));
RESET ROLE;
SELECT test.login('a0000000-0000-4000-8000-000000000001') AS zz \gset
SET ROLE authenticated;
SELECT public.recovery_v1_transition('org-test','RESTRICTED','synthetic cost test','synthetic evidence');
RESET ROLE;
SELECT test.expect_error('cost-side direct SQL cannot bypass restricted mode', $$UPDATE public.product_costs SET cost_mmk=1 WHERE product_id='prod-1'$$,'ORG_SUSPENDED');
SELECT test.check('PFIN report + PSAFE guard preserved',to_regprocedure('public.fin_report_summary(text,date,date,text)') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtname='zz_orvix_no_086_after_087' AND evtenabled='A'));
-- Step 5: genuine owner-signed reopening (synthetic owner), not a superuser edit
\set fx_org org-test
\ir ../step5/fixture-activate.psql
-- Review round 3: PCOST-A writes cost side rows BEFORE their parent exists (deferred FKs). Normal
-- single-organization creation with a cost must keep working in an ACTIVE organization.
INSERT INTO public.products SELECT (jsonb_populate_record(NULL::public.products, to_jsonb(x)
  || jsonb_build_object('id','prod-new-cost','sku','NEW-COST-SKU','name','New product with cost','cost_mmk',500))).* FROM public.products x WHERE id='prod-1';
SELECT test.check('ACTIVE org: a new product with a purchase cost is created (cost row written before the product)',
  EXISTS(SELECT 1 FROM public.products WHERE id='prod-new-cost') AND EXISTS(SELECT 1 FROM public.product_costs WHERE product_id='prod-new-cost'));
INSERT INTO public.product_units SELECT (jsonb_populate_record(NULL::public.product_units, to_jsonb(u)
  || jsonb_build_object('id','pu-new-cost','name','Box of 10','base_quantity',10,'is_default',false,'purchase_price_mmk',800))).*
  FROM public.product_units u WHERE product_id='prod-1' LIMIT 1;
SELECT test.check('ACTIVE org: a new product unit with a purchase price is created',
  EXISTS(SELECT 1 FROM public.product_units WHERE id='pu-new-cost') AND EXISTS(SELECT 1 FROM public.product_unit_costs WHERE product_unit_id='pu-new-cost'));
