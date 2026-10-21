-- Synthetic second-tenant financial records for the cross-organization guard tests
-- (correction pass P4). Runs as the disposable cluster's superuser BEFORE the
-- recovery guards are installed. Every value is synthetic; rows are cloned from the
-- phase-d seed's shop-b records and re-homed into org-unrelated.
\set ON_ERROR_STOP on
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-4000-8000-0000000000f1', 'unrel@test.local'), ('a0000000-0000-4000-8000-0000000000f2', 'unrel-mgr@test.local');
INSERT INTO public.shops SELECT (jsonb_populate_record(NULL::public.shops, to_jsonb(s)
  || jsonb_build_object('id','shop-unrel','org_id','org-unrelated','name','Unrelated synthetic shop','code','UR'))).* FROM public.shops s WHERE id='shop-b';
-- business rule (enforce_user_assignment_rules): a shop needs an active manager before a cashier
INSERT INTO public.users SELECT (jsonb_populate_record(NULL::public.users, to_jsonb(u)
  || jsonb_build_object('id','u-unrel-mgr','org_id','org-unrelated','shop_id','shop-unrel','auth_id','a0000000-0000-4000-8000-0000000000f2','email','unrel-mgr@test.local','name','Unrelated manager'))).*
  FROM public.users u WHERE id='u-mgr-b';
INSERT INTO public.users SELECT (jsonb_populate_record(NULL::public.users, to_jsonb(u)
  || jsonb_build_object('id','u-unrel','org_id','org-unrelated','shop_id','shop-unrel','auth_id','a0000000-0000-4000-8000-0000000000f1','email','unrel@test.local','name','Unrelated cashier'))).*
  FROM public.users u WHERE id='u-cash-b';
INSERT INTO public.shifts SELECT (jsonb_populate_record(NULL::public.shifts, to_jsonb(x)
  || jsonb_build_object('id','shift-unrel','shop_id','shop-unrel','cashier_id','u-unrel'))).* FROM public.shifts x WHERE id='shift-b';
INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, to_jsonb(x)
  || jsonb_build_object('id','sale-unrel','shop_id','shop-unrel','shift_id','shift-unrel','cashier_id','u-unrel','receipt_no','UNREL-1'))).* FROM public.sales x WHERE id='sale-b1';
INSERT INTO public.suppliers SELECT (jsonb_populate_record(NULL::public.suppliers, to_jsonb(x)
  || jsonb_build_object('id','sup-unrel','org_id','org-unrelated','name','Unrelated supplier','code','URS'))).* FROM public.suppliers x WHERE id='sup-1';
INSERT INTO public.purchase_orders SELECT (jsonb_populate_record(NULL::public.purchase_orders, to_jsonb(x)
  || jsonb_build_object('id','po-unrel','shop_id','shop-unrel','supplier_id','sup-unrel','created_by','u-unrel','approved_by',NULL,'received_by',NULL))).*
  FROM public.purchase_orders x WHERE id='po-draft';
INSERT INTO public.products SELECT (jsonb_populate_record(NULL::public.products, to_jsonb(x)
  || jsonb_build_object('id','prod-unrel','org_id','org-unrelated','brand_id',NULL,'category_id',NULL,'sku','UNREL-SKU','name','Unrelated product'))).* FROM public.products x WHERE id='prod-1';
SELECT test.check('cross-org fixture: org-unrelated owns a shop, cashier, shift, sale, supplier and purchase order',
  (SELECT count(*)=6 FROM (
    SELECT org_id FROM public.shops WHERE id='shop-unrel' UNION ALL SELECT org_id FROM public.users WHERE id='u-unrel'
    UNION ALL SELECT s.org_id FROM public.shifts x JOIN public.shops s ON s.id=x.shop_id WHERE x.id='shift-unrel'
    UNION ALL SELECT s.org_id FROM public.sales x JOIN public.shops s ON s.id=x.shop_id WHERE x.id='sale-unrel'
    UNION ALL SELECT org_id FROM public.suppliers WHERE id='sup-unrel'
    UNION ALL SELECT s.org_id FROM public.purchase_orders x JOIN public.shops s ON s.id=x.shop_id WHERE x.id='po-unrel') t WHERE org_id='org-unrelated'));
