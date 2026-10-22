-- Cross-organization privileged-write tests (correction pass P4). Runs after smoke.sql,
-- which leaves org-test ACTIVE (synthetic superuser fixture) and org-unrelated RESTRICTED.
-- Every write below is a DIRECT privileged write (superuser or service_role, which
-- bypass RLS): only the database recovery guard stands between it and the data.
\set ON_ERROR_STOP on
SELECT test.check('precondition: org-test ACTIVE, org-unrelated RESTRICTED',
  (SELECT state FROM recovery_v1.org_state WHERE org_id='org-test')='ACTIVE' AND (SELECT state FROM recovery_v1.org_state WHERE org_id='org-unrelated')='RESTRICTED');

-- A template row of the ACTIVE organization, re-pointed at a RESTRICTED parent.
CREATE TEMP TABLE xorg_template AS SELECT to_jsonb(s) AS sale FROM public.sales s WHERE shop_id='shop-a' LIMIT 1;
GRANT SELECT ON xorg_template TO service_role;
SET ROLE service_role;
SELECT test.expect_error('service_role: sale in ACTIVE shop referencing a RESTRICTED org shift is refused',
  $$INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, sale||'{"id":"x-sale-1","receipt_no":"X-1","shift_id":"shift-unrel"}')).* FROM xorg_template$$, 'ORG_SUSPENDED');
SELECT test.expect_error('service_role: sale in ACTIVE shop with a RESTRICTED org cashier is refused',
  $$INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, sale||'{"id":"x-sale-2","receipt_no":"X-2","cashier_id":"u-unrel"}')).* FROM xorg_template$$, 'ORG_SUSPENDED');
SELECT test.expect_error('service_role: supplier payment in ACTIVE shop against a RESTRICTED org purchase order is refused',
  $$INSERT INTO public.supplier_payments(id,supplier_id,purchase_order_id,shop_id,amount_mmk,payment_method,created_by) VALUES('x-pay-1','sup-1','po-unrel','shop-a',100,'CASH','u-mgr-a')$$, 'ORG_SUSPENDED');
SELECT test.expect_error('service_role: refund/void request in ACTIVE shop against a RESTRICTED org sale is refused',
  $$INSERT INTO public.refund_void_requests(id,sale_id,shop_id,type,reason,created_by) VALUES('x-rvr-1','sale-unrel','shop-a','VOID','synthetic','u-mgr-a')$$, 'ORG_SUSPENDED');
SELECT test.expect_error('service_role: stock movement in ACTIVE shop whose reference is a RESTRICTED org sale is refused',
  $$INSERT INTO public.inventory_movements(id,shop_id,product_id,type,qty_change,qty_before,qty_after,reason,reference_type,reference_id,created_by)
    VALUES('x-mv-1','shop-a','prod-1','ADJUSTMENT',1,0,1,'synthetic','sale','sale-unrel','u-mgr-a')$$, 'ORG_SUSPENDED');
SELECT test.expect_error('service_role: re-pointing an ACTIVE org sale at a RESTRICTED org shift is refused',
  $$UPDATE public.sales SET shift_id='shift-unrel' WHERE id=(SELECT sale->>'id' FROM xorg_template)$$, 'ORG_SUSPENDED');
-- Review round 2 (H3): every *_by actor column, audit entity ids, refund item JSON
CREATE TEMP TABLE xorg_item AS SELECT to_jsonb(i) AS item FROM public.sale_items i JOIN public.sales s ON s.id=i.sale_id WHERE s.shop_id='shop-a' LIMIT 1;
CREATE TEMP TABLE xorg_audit AS SELECT to_jsonb(a) AS audit FROM public.audit_logs a WHERE a.shop_id='shop-a' LIMIT 1;
GRANT SELECT ON xorg_item, xorg_audit TO service_role;
SELECT test.expect_error('service_role: a sale line whose price override is by a RESTRICTED org user is refused',
  $$INSERT INTO public.sale_items SELECT (jsonb_populate_record(NULL::public.sale_items, item||'{"id":"x-item-1","price_overridden_by":"u-unrel"}')).* FROM xorg_item$$, 'ORG_SUSPENDED');
SELECT test.expect_error('service_role: a supplier payment voided by a RESTRICTED org user is refused',
  $$INSERT INTO public.supplier_payments(id,supplier_id,purchase_order_id,shop_id,amount_mmk,payment_method,created_by,voided_by) VALUES('x-pay-3','sup-1','po-appr','shop-a',100,'CASH','u-mgr-a','u-unrel')$$, 'ORG_SUSPENDED');
SELECT test.expect_error('service_role: an audit row whose entity is a RESTRICTED org sale is refused',
  $$INSERT INTO public.audit_logs SELECT (jsonb_populate_record(NULL::public.audit_logs, audit||'{"id":"x-audit-1","entity_id":"sale-unrel"}')).* FROM xorg_audit$$, 'ORG_SUSPENDED');
SELECT test.expect_error('service_role: a refund request whose items name a RESTRICTED org product is refused',
  format($q$INSERT INTO public.refund_void_requests(id,sale_id,shop_id,type,reason,created_by,items) VALUES('x-rvr-2',%L,'shop-a','REFUND','synthetic','u-mgr-a','[{"productId":"prod-unrel","qty":1}]')$q$, (SELECT sale->>'id' FROM xorg_template)), 'ORG_SUSPENDED');
-- Review round 2 (M1): dangling parents and row identity changes
SELECT test.expect_error('service_role: a sale whose shift does not exist (dangling) is refused',
  $$INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, sale||'{"id":"x-sale-4","receipt_no":"X-4","shift_id":"shift-does-not-exist"}')).* FROM xorg_template$$, 'dangling_reference');
SELECT test.expect_error('service_role: changing a row''s id (re-linking references to it) is refused',
  $$UPDATE public.shifts SET id='shift-renamed' WHERE id=(SELECT sale->>'shift_id' FROM xorg_template)$$, 'row_identity_change');
RESET ROLE;
SELECT test.expect_error('superuser direct SQL: the same cross-organization reference is refused',
  $$INSERT INTO public.supplier_payments(id,supplier_id,purchase_order_id,shop_id,amount_mmk,payment_method,created_by) VALUES('x-pay-2','sup-1','po-unrel','shop-a',100,'CASH','u-mgr-a')$$, 'ORG_SUSPENDED');

-- Isolation is enforced even when BOTH organizations are ACTIVE (synthetic superuser fixture).
\set fx_org org-unrelated
\ir ../step5/fixture-activate.psql
SET ROLE service_role;
SELECT test.expect_error('both ACTIVE: a row linking two organizations is still refused',
  $$INSERT INTO public.sales SELECT (jsonb_populate_record(NULL::public.sales, sale||'{"id":"x-sale-3","receipt_no":"X-3","shift_id":"shift-unrel"}')).* FROM xorg_template$$, 'ORG_SUSPENDED');
RESET ROLE;
UPDATE recovery_v1.org_state SET state='RESTRICTED' WHERE org_id='org-unrelated';

-- Positive control: the same privileged write within ONE active organization succeeds.
SET ROLE service_role;
INSERT INTO public.supplier_payments(id,supplier_id,purchase_order_id,shop_id,amount_mmk,payment_method,created_by) VALUES('x-pay-ok','sup-1','po-appr','shop-a',100,'CASH','u-mgr-a');
RESET ROLE;
SELECT test.check('same-organization privileged write in an ACTIVE organization succeeds', EXISTS(SELECT 1 FROM public.supplier_payments WHERE id='x-pay-ok'));
SELECT test.check('no cross-organization row was written', NOT EXISTS(SELECT 1 FROM public.sales WHERE id LIKE 'x-sale-%')
  AND NOT EXISTS(SELECT 1 FROM public.supplier_payments WHERE id='x-pay-1' OR id='x-pay-2') AND NOT EXISTS(SELECT 1 FROM public.refund_void_requests WHERE id='x-rvr-1')
  AND NOT EXISTS(SELECT 1 FROM public.inventory_movements WHERE id='x-mv-1') AND NOT EXISTS(SELECT 1 FROM public.sales WHERE shift_id='shift-unrel' AND shop_id='shop-a'));
-- Cleanup of the positive-control row is itself a guarded delete in an ACTIVE org (allowed).
DELETE FROM public.supplier_payments WHERE id='x-pay-ok';
DROP TABLE xorg_template, xorg_item, xorg_audit;

-- Review round 2 (M2): no audit row without an active app user; every audited input capped
SELECT count(*) AS audit_before FROM recovery_v1.audit \gset
SELECT test.login('a0000000-0000-4000-8000-0000000000ee') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('a JWT with no app user cannot write to the immutable audit', $$SELECT public.recovery_v1_transition('org-unrelated',repeat('x',100000),'r','e')$$, 'RECOVERY_V1_CALLER_REQUIRED');
RESET ROLE;
SELECT test.check('no audit row was written for the anonymous attempt', (SELECT count(*) FROM recovery_v1.audit)=:audit_before);
SELECT test.login('a0000000-0000-4000-8000-000000000001') AS zz \gset
SET ROLE authenticated;
SELECT public.recovery_v1_transition('org-unrelated',repeat('x',100000),repeat('r',100000),repeat('e',100000)) AS big \gset
RESET ROLE;
SELECT test.check('an oversized foreign-org attempt is denied, recorded under the CALLER org, with every input capped',
  :'big'::jsonb->>'outcome'='denied' AND NOT EXISTS(SELECT 1 FROM recovery_v1.audit WHERE org_id='org-unrelated' AND kind LIKE 'transition%'
                                                       AND coalesce(detail->>'by','') <> 'superuser:fixture')   -- Step 5: the genuine reopening fixture's own containment step
  AND (SELECT max(octet_length(detail::text)) FROM recovery_v1.audit WHERE kind LIKE 'transition%') < 2000);
