-- dr-financial-checks.sql — read-only financial, isolation and ledger invariants after a restore.
-- Output: <check>|<value>. Every line whose check does not start with "info:" must be 0.
-- Complements dr-drill-consistency.sql (sales/key ledger, orphans, every foreign key). No row
-- content is printed. Works at schema 085 and 086 (086-only checks report 0 when 086 is absent).
\set ON_ERROR_STOP 1
SET timezone = 'UTC';

-- supplier money: every purchase order's paid amount is exactly its non-voided payments
SELECT 'po paid_mmk differs from its non-voided supplier payments', count(*) FROM public.purchase_orders po
 WHERE po.paid_mmk IS DISTINCT FROM (SELECT coalesce(sum(sp.amount_mmk), 0) FROM public.supplier_payments sp
                                      WHERE sp.purchase_order_id = po.id AND sp.voided_at IS NULL);
SELECT 'po paid more than its total, or negative', count(*) FROM public.purchase_orders
 WHERE paid_mmk < 0 OR paid_mmk > total_mmk;
SELECT 'supplier payments that are not positive', count(*) FROM public.supplier_payments WHERE amount_mmk <= 0;
SELECT 'supplier payments on a purchase order that is not RECEIVED', count(*) FROM public.supplier_payments sp
  JOIN public.purchase_orders po ON po.id = sp.purchase_order_id WHERE sp.voided_at IS NULL AND po.status <> 'RECEIVED';
SELECT 'supplier payments whose supplier/shop differ from their purchase order', count(*) FROM public.supplier_payments sp
  JOIN public.purchase_orders po ON po.id = sp.purchase_order_id
 WHERE sp.supplier_id IS DISTINCT FROM po.supplier_id OR sp.shop_id IS DISTINCT FROM po.shop_id;
SELECT 'info: supplier payments (count:sum, non-voided)', count(*) || ':' || coalesce(sum(amount_mmk), 0)
  FROM public.supplier_payments WHERE voided_at IS NULL;
SELECT 'info: purchase orders outstanding (sum total - paid, RECEIVED)', coalesce(sum(total_mmk - paid_mmk), 0)
  FROM public.purchase_orders WHERE status = 'RECEIVED';

-- organisation isolation: no row links two organisations
SELECT 'isolation: purchase order shop and supplier in different organisations', count(*) FROM public.purchase_orders po
  JOIN public.shops s ON s.id = po.shop_id JOIN public.suppliers su ON su.id = po.supplier_id WHERE s.org_id IS DISTINCT FROM su.org_id;
SELECT 'isolation: sale shop and cashier in different organisations', count(*) FROM public.sales sa
  JOIN public.shops s ON s.id = sa.shop_id JOIN public.users u ON u.id = sa.cashier_id WHERE s.org_id IS DISTINCT FROM u.org_id;
SELECT 'isolation: stock movement shop and product in different organisations', count(*) FROM public.inventory_movements m
  JOIN public.shops s ON s.id = m.shop_id JOIN public.products p ON p.id = m.product_id WHERE s.org_id IS DISTINCT FROM p.org_id;
SELECT 'isolation: inventory shop and product in different organisations', count(*) FROM public.inventory i
  JOIN public.shops s ON s.id = i.shop_id JOIN public.products p ON p.id = i.product_id WHERE s.org_id IS DISTINCT FROM p.org_id;
SELECT 'isolation: users without an organisation', count(*) FROM public.users WHERE org_id IS NULL;
SELECT 'isolation: sale item product and sale shop in different organisations', count(*) FROM public.sale_items si
  JOIN public.sales sa ON sa.id = si.sale_id JOIN public.shops s ON s.id = sa.shop_id JOIN public.products p ON p.id = si.product_id
 WHERE s.org_id IS DISTINCT FROM p.org_id;
SELECT 'isolation: purchase order item product and order shop in different organisations', count(*) FROM public.purchase_order_items pi
  JOIN public.purchase_orders po ON po.id = pi.purchase_order_id JOIN public.shops s ON s.id = po.shop_id JOIN public.products p ON p.id = pi.product_id
 WHERE s.org_id IS DISTINCT FROM p.org_id;
SELECT 'isolation: shift shop and cashier in different organisations', count(*) FROM public.shifts sh
  JOIN public.shops s ON s.id = sh.shop_id JOIN public.users u ON u.id = sh.cashier_id WHERE s.org_id IS DISTINCT FROM u.org_id;
SELECT 'isolation: stock transfer between shops of different organisations', count(*) FROM public.stock_transfers t
  JOIN public.shops a ON a.id = t.from_shop_id JOIN public.shops b ON b.id = t.to_shop_id WHERE a.org_id IS DISTINCT FROM b.org_id;
SELECT 'isolation: supplier payment recorded by a user of another organisation', count(*) FROM public.supplier_payments sp
  JOIN public.shops s ON s.id = sp.shop_id JOIN public.users u ON u.id = sp.created_by WHERE s.org_id IS DISTINCT FROM u.org_id;
SELECT 'isolation: operation-ledger row in another organisation than its actor (074+)', count(*) FROM public.idempotency_keys k
  JOIN public.users u ON u.id = k.actor_id WHERE k.org_id IS NOT NULL AND k.org_id <> '!unattributed' AND k.org_id IS DISTINCT FROM u.org_id;

-- stock: every movement's before/after is consistent with its change
SELECT 'stock movements with qty_after <> qty_before + qty_change', count(*) FROM public.inventory_movements
 WHERE qty_after IS DISTINCT FROM qty_before + qty_change;

-- financial audit trail present
SELECT 'info: audit_logs rows', count(*) FROM public.audit_logs;

-- operation ledger (062+; 086 states)
SELECT 'ledger: rows without an organisation (086: every row has one)', count(*) FROM public.idempotency_keys
 WHERE to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NOT NULL AND org_id IS NULL;
SELECT 'ledger: duplicate (org_id, key)', count(*) FROM (
  SELECT 1 FROM public.idempotency_keys GROUP BY org_id, key HAVING count(*) > 1) x;
SELECT format('SELECT %L, count(*) FROM public.idempotency_keys WHERE NOT ('
    '(state = ''committed'' AND left(request_hash, 2) NOT IN (''R:'', ''A:'')) '
    'OR (state = ''rejected'' AND left(request_hash, 2) = ''R:'' AND response IS NULL AND outcome_code IS NOT NULL) '
    'OR (state = ''abandoned'' AND request_hash = ''A:'' AND response IS NULL))',
    'ledger: rows violating the 086 state/tombstone rule')
 WHERE EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.idempotency_keys'::regclass AND attname = 'state' AND NOT attisdropped)
\gexec
SELECT 'ledger: state constraint missing or not validated (086)', count(*) FROM (SELECT 1) x
 WHERE to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_state_chk' AND convalidated);
SELECT format('SELECT %L, count(*) || '':'' || coalesce(string_agg(s || ''='' || n, '','' ORDER BY s), '''') FROM (SELECT state AS s, count(*) AS n FROM public.idempotency_keys GROUP BY state) x',
    'info: ledger rows by state')
 WHERE EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.idempotency_keys'::regclass AND attname = 'state' AND NOT attisdropped)
\gexec
SELECT 'ledger: committed supplier-payment keys without their payment row', count(*) FROM public.idempotency_keys k
 WHERE k.rpc = 'record_supplier_payment' AND k.response IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.supplier_payments sp WHERE sp.id::text = k.response->'supplierPayment'->>'id');
SELECT 'ledger: supplier payments claimed by more than one key', count(*) FROM (
  SELECT k.response->'supplierPayment'->>'id' FROM public.idempotency_keys k
   WHERE k.rpc = 'record_supplier_payment' AND k.response->'supplierPayment'->>'id' IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;

-- migration ledger and the platform roles the services log in as
SELECT 'migration ledger: versions that are not NNN', count(*) FROM supabase_migrations.schema_migrations WHERE version !~ '^\d{3}$';
SELECT 'info: migration ledger (count, max)', count(*) || ',' || coalesce(max(version), '-') FROM supabase_migrations.schema_migrations;
SELECT 'roles: required platform roles missing', count(*) FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('authenticator'),
  ('supabase_admin'), ('supabase_auth_admin'), ('supabase_storage_admin'), ('postgres')) r(n)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.n);
SELECT 'grants: API roles without USAGE on the extension schemas (run dr-restore-fixups.sql after a logical restore)', count(*)
  FROM (VALUES ('graphql'), ('graphql_public')) s(n) CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) r(n)
 WHERE to_regnamespace(s.n) IS NOT NULL AND NOT has_schema_privilege(r.n, s.n, 'USAGE');
SELECT 'rls: public tables without row level security', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;
-- (grants are compared for EQUALITY with the source by dr-schema-fingerprint.sql; listed here for the record)
SELECT 'info: public functions executable by anon', count(*) || ':' || coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE');
