-- Synthetic data for the email-tier tests (runs as supabase_admin after baseline + migrations).
-- Two organizations; org A has a known business day 2026-10-12 (Asia/Yangon, UTC+06:30) whose
-- expected report figures are asserted by suite.sh. Strings starting "phfcanary" must never
-- appear in an archive mail; org B's canary must never appear in org A's report.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION pg_temp.login(p uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p::text, false), set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false); $$;

-- ---------------------------------------------------------------- auth ----
-- column set common to the image's initial auth.users and current GoTrue
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, updated_at, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'phfcanary.owner@example.invalid',
   '$2a$10$phfcanaryHASHphfcanaryHASHphfcanaryHASHphfcanaryHA', now(), '{"provider":"email"}', '{}'),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cashier-a@example.invalid',
   '$2a$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', now(), '{"provider":"email"}', '{}'),
  ('00000000-0000-0000-0000-000000000000', 'b0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'admin-b@example.invalid',
   '$2a$10$yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy', now(), '{"provider":"email"}', '{}');
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  SELECT id::text, id, json_build_object('sub', id, 'email', email)::jsonb, 'email' FROM auth.users;
INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'owner phone', 'totp', 'verified', 'PHFCANARYTOTPSECRET234567ABCDEF'),
  ('f0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'backup phone', 'totp', 'unverified', 'PHFCANARYTOTPSECRET2BCDEFGHIJKL');

-- ----------------------------------------------------- migration history ----
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
  SELECT lpad(g::text, 3, '0'), 'synthetic_' || g, ARRAY['-- synthetic statement ' || g] FROM generate_series(1, 80) g;

-- ------------------------------------------------------------- tenants ----
INSERT INTO organizations (id, name) VALUES ('org-a', 'Org A'), ('org-b', 'Org B');
DELETE FROM price_levels WHERE org_id IN ('org-a', 'org-b');
INSERT INTO shops (id, code, name, address, org_id) VALUES
  ('shop-a', 'SA', 'Shop A', 'A Street', 'org-a'),
  ('shop-b', 'SB', 'Shop B', 'B Street', 'org-b');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-admin-a', 'Owner A', 'phfcanary.owner@example.invalid', 'ADMIN', NULL, 'a0000000-0000-4000-8000-000000000001', 'org-a');
SELECT pg_temp.login('a0000000-0000-4000-8000-000000000001');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-admin-b', 'Admin B', 'admin-b@example.invalid', 'ADMIN', NULL, 'b0000000-0000-4000-8000-000000000001', 'org-b');
-- 020: a shop needs an active manager before it can have cashiers
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-mgr-a', 'Manager A', 'manager-a@example.invalid', 'MANAGER', 'shop-a', NULL, 'org-a'),
  ('u-mgr-b', 'Manager B', 'manager-b@example.invalid', 'MANAGER', 'shop-b', NULL, 'org-b');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-cash-a', 'Cashier A', 'cashier-a@example.invalid', 'CASHIER', 'shop-a', 'a0000000-0000-4000-8000-000000000002', 'org-a');

-- catalog of org A (as org A's admin so the org_id triggers resolve org-a)
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk, low_stock_threshold) VALUES
  ('p-a1', 'A1', 'phfcanary-product-7Q2x Rice', 'General', 'pcs', 1000, 600, 10),
  ('p-a2', 'A2', 'Cooking Oil', 'General', 'pcs', 2500, 1500, 5),
  ('p-a3', 'A3', 'Salt', 'General', 'pcs', 500, NULL, 5);
INSERT INTO suppliers (id, code, name) VALUES ('sup-a', 'SUPA', 'Supplier A');
-- catalog of org B
SELECT pg_temp.login('b0000000-0000-4000-8000-000000000001');
INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk, low_stock_threshold) VALUES
  ('p-b1', 'B1', 'phfcanary-orgb-product', 'General', 'pcs', 77777, 1, 100000);
SELECT pg_temp.login('a0000000-0000-4000-8000-000000000001');

UPDATE inventory SET qty_base_units = 3  WHERE shop_id = 'shop-a' AND product_id = 'p-a1';
UPDATE inventory SET qty_base_units = 50 WHERE shop_id = 'shop-a' AND product_id = 'p-a2';
UPDATE inventory SET qty_base_units = 0  WHERE shop_id = 'shop-a' AND product_id = 'p-a3';
UPDATE inventory SET qty_base_units = 5  WHERE shop_id = 'shop-b' AND product_id = 'p-b1';

-- ---------------------------------------------- org A, business day 2026-10-12 ----
INSERT INTO shifts (id, shop_id, cashier_id, started_at, ended_at, opening_cash_mmk, closing_cash_mmk, expected_cash_mmk, variance_mmk) VALUES
  ('sh-a1', 'shop-a', 'u-cash-a', '2026-10-12 08:00+06:30', '2026-10-12 20:00+06:30', 0, 4500, 5000, -500),
  ('sh-a2', 'shop-a', 'u-cash-a', '2026-10-12 09:00+06:30', NULL, 0, NULL, NULL, NULL);
INSERT INTO sales (id, shop_id, shift_id, receipt_no, cashier_id, status, subtotal_mmk, discount_mmk, total_mmk, payment_method, paid_mmk, change_mmk, created_at) VALUES
  ('s1', 'shop-a', 'sh-a1', 'SA-1', 'u-cash-a', 'NORMAL',   1000, 0, 1000, 'CASH',   1000, 0, '2026-10-12 06:20+06:30'),
  ('s2', 'shop-a', 'sh-a1', 'SA-2', 'u-cash-a', 'NORMAL',   2600, 100, 2500, 'KBZPAY', 2500, 0, '2026-10-12 12:00+06:30'),
  ('s3', 'shop-a', 'sh-a1', 'SA-3', 'u-cash-a', 'REFUNDED', 4000, 0, 4000, 'CASH',   5000, 1000, '2026-10-12 23:50+06:30'),
  ('s4', 'shop-a', 'sh-a1', 'SA-4', 'u-cash-a', 'VOID',      700, 0,  700, 'CASH',    700, 0, '2026-10-12 13:00+06:30'),
  ('s5', 'shop-a', 'sh-a2', 'SA-5', 'u-cash-a', 'NORMAL',   9999, 0, 9999, 'CASH',   9999, 0, '2026-10-13 00:10+06:30'),
  ('s6', 'shop-a', 'sh-a1', 'SA-6', 'u-cash-a', 'NORMAL',   5555, 0, 5555, 'CASH',   5555, 0, '2026-10-11 23:59+06:30');
INSERT INTO sale_items (id, sale_id, product_id, qty_units, unit_price_mmk, line_total_mmk, unit_cost_mmk_snapshot, base_quantity_sold) VALUES
  ('si1', 's1', 'p-a1', 1, 1000, 1000, 600, 1),
  ('si2', 's2', 'p-a2', 1, 2600, 2600, 1500, 1),
  ('si3', 's3', 'p-a1', 4, 1000, 4000, NULL, 4),
  ('si4', 's4', 'p-a2', 1,  700,  700, 1500, 1),
  ('si5', 's5', 'p-a2', 4, 2500, 9999, 1500, 4);
INSERT INTO refund_void_requests (id, sale_id, shop_id, type, reason, created_by, items, status, created_at) VALUES
  ('r1', 's3', 'shop-a', 'PARTIAL', 'synthetic', 'u-cash-a', '[]', 'APPROVED', '2026-10-12 23:55+06:30'),
  ('r2', 's4', 'shop-a', 'VOID',    'synthetic', 'u-cash-a', '[]', 'APPROVED', '2026-10-12 13:05+06:30'),
  ('r3', 's6', 'shop-a', 'PARTIAL', 'synthetic', 'u-cash-a', '[]', 'PENDING',  '2026-10-11 23:59+06:30');
INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by, created_at, received_by, received_at, paid_mmk, payment_status) VALUES
  ('po-1', 'PO-A-1', 'shop-a', 'sup-a', 'RECEIVED', 50000, 50000, 'u-admin-a', '2026-10-10 10:00+06:30', 'u-admin-a', '2026-10-12 10:00+06:30', 20000, 'PARTIAL');
INSERT INTO purchase_orders (id, order_no, shop_id, supplier_id, status, subtotal_mmk, total_mmk, created_by, created_at) VALUES
  ('po-2', 'PO-A-2', 'shop-a', 'sup-a', 'APPROVED', 8000, 8000, 'u-admin-a', '2026-10-12 11:00+06:30');
INSERT INTO supplier_payments (id, supplier_id, purchase_order_id, shop_id, amount_mmk, payment_method, created_by, created_at, voided_at) VALUES
  ('sp-1', 'sup-a', 'po-1', 'shop-a', 20000, 'CASH', 'u-admin-a', '2026-10-12 10:30+06:30', NULL),
  ('sp-2', 'sup-a', 'po-1', 'shop-a',   999, 'CASH', 'u-admin-a', '2026-10-12 10:40+06:30', '2026-10-12 10:41+06:30');
INSERT INTO audit_logs (id, shop_id, actor_id, action_type, message, entity_type, entity_id, created_at) VALUES
  ('al-1', 'shop-a', 'u-admin-a', 'TEST', 'synthetic 1', 'sale', 's1', '2026-10-12 06:21+06:30'),
  ('al-2', 'shop-a', 'u-admin-a', 'TEST', 'synthetic 2', 'sale', 's2', '2026-10-12 12:01+06:30'),
  ('al-3', 'shop-a', 'u-admin-a', 'TEST', 'synthetic 3', 'sale', 's3', '2026-10-12 23:51+06:30');

-- ---------------------------------------------- org B, same day (must stay out of A's report) ----
SELECT pg_temp.login('b0000000-0000-4000-8000-000000000001');
INSERT INTO users (id, name, email, role, shop_id, auth_id, org_id) VALUES
  ('u-cash-b', 'Cashier B', 'cashier-b@example.invalid', 'CASHIER', 'shop-b', NULL, 'org-b');
INSERT INTO shifts (id, shop_id, cashier_id, started_at, opening_cash_mmk) VALUES ('sh-b1', 'shop-b', 'u-cash-b', '2026-10-12 08:00+06:30', 0);
INSERT INTO sales (id, shop_id, shift_id, receipt_no, cashier_id, status, subtotal_mmk, discount_mmk, total_mmk, payment_method, paid_mmk, change_mmk, created_at) VALUES
  ('sb1', 'shop-b', 'sh-b1', 'SB-1', 'u-cash-b', 'NORMAL', 77777, 0, 77777, 'CASH', 77777, 0, '2026-10-12 12:00+06:30');
INSERT INTO sale_items (id, sale_id, product_id, qty_units, unit_price_mmk, line_total_mmk, unit_cost_mmk_snapshot, base_quantity_sold) VALUES
  ('sib1', 'sb1', 'p-b1', 1, 77777, 77777, 1, 1);
SELECT pg_temp.login(NULL::uuid);

-- ---------------------------------------------------------- storage + config ----
INSERT INTO storage.buckets (id, name, public) VALUES ('product-images', 'product-images', true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name, metadata, version)
  SELECT 'product-images', 'org-a/products/p-a' || g || '/img.bin', json_build_object('size', 100000 + g, 'mimetype', 'application/octet-stream')::jsonb, 'v' || g
  FROM generate_series(1, 30) g;
INSERT INTO public.app_config (key, value) VALUES ('supabase_public_url', 'https://pos.example.invalid')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

SELECT 'seeded: ' || (SELECT count(*) FROM auth.users) || ' auth users, ' || (SELECT count(*) FROM auth.mfa_factors) || ' mfa factors, '
  || (SELECT count(*) FROM products) || ' products, ' || (SELECT count(*) FROM sales) || ' sales, '
  || (SELECT count(*) FROM storage.objects) || ' objects, ' || (SELECT count(*) FROM supabase_migrations.schema_migrations) || ' migrations';
