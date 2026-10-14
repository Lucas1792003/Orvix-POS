-- t19: old client (v1.0.15, tag 3445d42) against schema 081 - "an old build
-- cannot silently write incompatible data"
-- (docs/selfhost-migration/phase-f/electron-compatibility.md).
--
-- v1.0.15 is pinned to hosted at build time (VITE_SUPABASE_URL baked into
-- the bundle, no runtime override). This file simulates what would happen if
-- its requests reached a backend at 081 anyway, using the EXACT argument
-- names / column sets of the v1.0.15 source (extracted from the tag):
--   1. the 30 keyed RPCs, called with v1.0.15's named arguments (no
--      p_idempotency_key) -> every one resolves (no PGRST202: the key has a
--      DEFAULT) and raises IDEMPOTENCY_KEY_REQUIRED; nothing is written;
--   2. v1.0.15's direct table writes (no org_id in any payload) -> org taken
--      from the caller by the 068 triggers, cross-org targets refused or
--      0 rows, an orphan's old first-time-setup insert refused;
--   3. v1.0.15's phone-upload flow (attach token, legacy temp/ path,
--      client-supplied public URL, legacy products/<id>/ desktop upload)
--      -> works only inside the caller's own org, legacy paths refused,
--      the client URL is never stored.
-- auth.signUp (v1.0.15 Users page + first-time setup) is a GoTrue endpoint:
-- not testable here (no GoTrue in this harness); see G8 evidence (422
-- signup_disabled on lucashome).
--
-- Gated by run.sh on migrations >= 081; runs after t17 (org-test + org-two
-- exist) and before the t12 bootstrap prep (which empties users).
\set ON_ERROR_STOP on
\set AA   'a0000000-0000-4000-8000-000000000001'
\set MA   'a0000000-0000-4000-8000-000000000002'
\set CA1  'a0000000-0000-4000-8000-000000000003'
\set AX   'a0000000-0000-4000-8000-000000000011'
\set ORPH 'a0000000-0000-4000-8000-0000000000f9'
\set PUB  'https://pos.test/storage/v1/object/public/product-images/'
SELECT test.logout() AS zz \gset

-- ============================================================
-- helpers
-- ============================================================
-- Row count of every public table + total stock: a write anywhere shows up.
CREATE OR REPLACE FUNCTION test.t19_counts() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record; v jsonb := '{}'; n bigint;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1 LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.tablename) INTO n;
    v := v || jsonb_build_object(r.tablename, n);
  END LOOP;
  SELECT COALESCE(sum(qty_base_units), 0) INTO n FROM public.inventory;
  RETURN v || jsonb_build_object('inventory_qty_sum', n);
END $$;

-- The v1.0.15 call sites (src/stores/data/slices/*.ts, src/lib/*.ts at tag
-- v1.0.15): RPC name + the argument names it sends. reject_refund_void_request
-- has no v1.0.15 caller; its args are what the function needed then.
CREATE TABLE IF NOT EXISTS test.t19_old_calls (rpc text PRIMARY KEY, args text[] NOT NULL);
TRUNCATE test.t19_old_calls;
INSERT INTO test.t19_old_calls (rpc, args) VALUES
  ('adjust_stock',               ARRAY['p_shop_id','p_product_id','p_adjustment_type','p_quantity_delta','p_reason','p_product_unit_id','p_unit_qty','p_created_at']),
  ('approve_purchase_order',     ARRAY['p_purchase_order_id']),
  ('approve_refund_request',     ARRAY['p_request_id']),
  ('approve_stock_transfer',     ARRAY['p_transfer_id']),
  ('approve_void_request',       ARRAY['p_request_id']),
  ('cancel_purchase_order',      ARRAY['p_purchase_order_id','p_reason']),
  ('cancel_stock_transfer',      ARRAY['p_transfer_id','p_reason']),
  ('close_shift',                ARRAY['p_shift_id','p_closing_cash_mmk','p_variance_reason','p_created_at']),
  ('complete_sale',              ARRAY['p_shop_id','p_shift_id','p_payment_method','p_paid_mmk','p_cart_discount_pct','p_items','p_created_at']),
  ('create_app_user',            ARRAY['p_id','p_name','p_email','p_role','p_shop_id','p_auth_id','p_granted_permissions','p_revoked_permissions']),
  ('create_purchase_order',      ARRAY['p_shop_id','p_supplier_id','p_items','p_notes']),
  ('create_refund_void_request', ARRAY['p_sale_id','p_type','p_reason','p_items','p_created_at']),
  ('create_stock_transfer',      ARRAY['p_from_shop_id','p_to_shop_id','p_items','p_notes']),
  ('create_supplier',            ARRAY['p_code','p_name','p_contact_person','p_phone','p_email','p_address','p_notes']),
  ('deactivate_app_user',        ARRAY['p_id','p_is_active']),
  ('delete_product',             ARRAY['p_product_id']),
  ('dispatch_stock_transfer',    ARRAY['p_transfer_id','p_created_at']),
  ('log_audit_event',            ARRAY['p_action_type','p_entity_type','p_entity_id','p_message','p_shop_id']),
  ('log_receipt_reprint',        ARRAY['p_sale_id']),
  ('open_shift',                 ARRAY['p_shop_id','p_opening_cash_mmk','p_created_at']),
  ('pay_supplier_lump_sum',      ARRAY['p_supplier_id','p_shop_id','p_amount_mmk','p_payment_method','p_reference_no','p_notes']),
  ('receive_purchase_order',     ARRAY['p_purchase_order_id','p_received_items','p_created_at']),
  ('receive_stock_transfer',     ARRAY['p_transfer_id','p_received_items','p_created_at']),
  ('record_supplier_payment',    ARRAY['p_purchase_order_id','p_amount_mmk','p_payment_method','p_reference_no','p_notes','p_created_at']),
  ('reject_refund_void_request', ARRAY['p_request_id','p_reason']),
  ('reject_stock_transfer',      ARRAY['p_transfer_id','p_reason']),
  ('replace_manager',            ARRAY['p_shop_id','p_new_manager_id']),
  ('update_app_user',            ARRAY['p_id','p_name','p_role','p_shop_id','p_granted_permissions','p_revoked_permissions']),
  ('update_supplier',            ARRAY['p_id','p_code','p_name','p_contact_person','p_phone','p_email','p_address','p_notes','p_is_active']),
  ('void_supplier_payment',      ARRAY['p_payment_id','p_reason']);
GRANT SELECT ON test.t19_old_calls TO authenticated;

-- Call p_rpc with v1.0.15's named arguments (all NULL: PostgREST resolves by
-- NAME, and the key gate runs before any argument is validated). Returns the
-- error message, or 'OK' if the call went through (it is then rolled back).
CREATE OR REPLACE FUNCTION test.t19_old_call(p_rpc text, p_args text[]) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_sql text;
BEGIN
  SELECT format('SELECT public.%I(%s)', p_rpc, string_agg(format('%I => NULL', a), ', ' ORDER BY o))
    INTO v_sql FROM unnest(p_args) WITH ORDINALITY AS t(a, o);
  BEGIN
    EXECUTE v_sql;
    RAISE EXCEPTION USING ERRCODE = 'P0T19', MESSAGE = 'OK';
  EXCEPTION WHEN OTHERS THEN
    RETURN CASE WHEN SQLSTATE = 'P0T19' THEN 'OK' ELSE SQLSTATE || ':' || SQLERRM END;
  END;
END $$;

-- A statement that must be REFUSED with some error; the message is recorded
-- in the PASS line (detail) so the doc can quote it.
CREATE OR REPLACE FUNCTION test.t19_refused(p_name text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO test.results (name, ok, detail) VALUES (p_name, true, SQLSTATE || ' ' || left(SQLERRM, 140));
    RETURN 'PASS ' || p_name || ' -- refused: ' || SQLSTATE || ' ' || left(SQLERRM, 140);
  END;
  RETURN test.check(p_name, false, 'statement SUCCEEDED (expected a refusal)');
END $$;

GRANT EXECUTE ON FUNCTION test.t19_refused(text, text), test.t19_old_call(text, text[]) TO anon, authenticated;

-- ============================================================
-- 1. The 30 keyed RPCs with v1.0.15 payloads
-- ============================================================
SELECT test.check('t19/rpc: the old-call list covers exactly the 30 keyed RPCs',
  (SELECT count(*) FROM test.t19_old_calls) = 30
  AND NOT EXISTS (
    SELECT p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proargnames @> ARRAY['p_idempotency_key']
    EXCEPT SELECT rpc FROM test.t19_old_calls));

-- PostgREST picks a function whose parameter names cover the request's keys
-- and whose other parameters have defaults. No PGRST202 for an old client:
SELECT test.check('t19/rpc: every v1.0.15 argument name is still a parameter (old payloads RESOLVE, no PGRST202)',
  NOT EXISTS (
    SELECT 1 FROM test.t19_old_calls c, unnest(c.args) a
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = c.rpc
                          AND a = ANY (p.proargnames))),
  (SELECT string_agg(c.rpc || '.' || a, ', ') FROM test.t19_old_calls c, unnest(c.args) a
    WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                       AND p.proname = c.rpc AND a = ANY (p.proargnames))));
SELECT test.check('t19/rpc: exactly one overload each, p_idempotency_key uuid DEFAULT NULL (so the gate, not resolution, decides)',
  (SELECT bool_and(n = 1 AND has_default) FROM (
     SELECT c.rpc, count(p.oid) AS n,
            bool_and(pg_get_function_arguments(p.oid) LIKE '%p_idempotency_key uuid DEFAULT NULL%') AS has_default
       FROM test.t19_old_calls c JOIN pg_proc p ON p.proname = c.rpc AND p.pronamespace = 'public'::regnamespace
      GROUP BY c.rpc) x)
  AND (SELECT count(DISTINCT c.rpc) FROM test.t19_old_calls c JOIN pg_proc p ON p.proname = c.rpc
        AND p.pronamespace = 'public'::regnamespace) = 30);

SELECT test.setvar('t19_before_rpc', test.t19_counts()::text);

-- as the org ADMIN (holds every permission: the refusal is the key gate,
-- not a permission check)
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
WITH r AS (SELECT rpc, test.t19_old_call(rpc, args) AS result FROM test.t19_old_calls)
SELECT test.check('t19/rpc: all 30 v1.0.15 calls (ADMIN) -> 22023 IDEMPOTENCY_KEY_REQUIRED',
  (SELECT count(*) FROM r WHERE result LIKE '22023:%IDEMPOTENCY_KEY_REQUIRED%') = 30,
  (SELECT string_agg(rpc || ' => ' || left(result, 80), ' | ') FROM r
    WHERE result NOT LIKE '22023:%IDEMPOTENCY_KEY_REQUIRED%'));
RESET ROLE;

-- as a CASHIER with realistic v1.0.15 checkout payloads (the till's path)
SELECT test.login(:'CA1') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t19/rpc: v1.0.15 open_shift payload (cashier) -> IDEMPOTENCY_KEY_REQUIRED',
  $q$SELECT public.open_shift(p_shop_id => 'shop-a', p_opening_cash_mmk => 50000, p_created_at => now())$q$,
  'IDEMPOTENCY_KEY_REQUIRED');
SELECT test.expect_error('t19/rpc: v1.0.15 complete_sale payload (cashier) -> IDEMPOTENCY_KEY_REQUIRED',
  $q$SELECT public.complete_sale(p_shop_id => 'shop-a', p_shift_id => 'shift-none', p_payment_method => 'CASH',
       p_paid_mmk => 1000, p_cart_discount_pct => 0,
       p_items => '[{"productId":"prod-1","qty":1,"unitPriceMmk":1000}]'::jsonb, p_created_at => now())$q$,
  'IDEMPOTENCY_KEY_REQUIRED');
SELECT test.expect_error('t19/rpc: v1.0.15 adjust_stock payload (cashier) -> IDEMPOTENCY_KEY_REQUIRED',
  $q$SELECT public.adjust_stock(p_shop_id => 'shop-a', p_product_id => 'prod-1', p_adjustment_type => 'DAMAGE',
       p_quantity_delta => -1, p_reason => 'old client', p_product_unit_id => NULL, p_unit_qty => NULL, p_created_at => now())$q$,
  'IDEMPOTENCY_KEY_REQUIRED');
RESET ROLE;
SELECT test.logout() AS zz \gset

SELECT test.check('t19/rpc: nothing written by any refused old call (every public table count + total stock unchanged)',
  test.t19_counts() = test.var('t19_before_rpc')::jsonb,
  (SELECT string_agg(k || ' ' || (test.var('t19_before_rpc')::jsonb ->> k) || '->' || v, ', ')
     FROM jsonb_each_text(test.t19_counts()) AS e(k, v)
    WHERE v IS DISTINCT FROM (test.var('t19_before_rpc')::jsonb ->> k)));

-- ============================================================
-- 2. v1.0.15 direct table writes (no org_id in any payload)
-- ============================================================
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
-- productSlice.addProduct: products.insert with v1.0.15's column set
INSERT INTO products (id, sku, alias_code, name, short_name, category, brand_id, unit_type, price_mmk, cost_mmk,
                      pack_size, low_stock_threshold, max_qty, is_open_price, is_non_stock, purchase_type,
                      expiry_date, image_url, is_active, created_at)
VALUES ('prod-t19-old', 'T19-OLD', NULL, 'Old client product', NULL, 'Cat A', NULL, 'pcs', 1500, 900,
        1, 5, NULL, false, false, NULL, NULL, NULL, true, now());
-- productSlice.addProduct barcodes (no org_id), replaceProductUnits upsert
INSERT INTO product_barcodes (id, product_id, product_unit_id, value, type)
VALUES ('bc-t19-old', 'prod-t19-old', NULL, '8850000019001', 'EAN13');
INSERT INTO product_units (id, product_id, name, base_quantity, sale_price_mmk, purchase_price_mmk, is_default, is_active, sort_order, created_at, updated_at)
VALUES ('unit-t19-old', 'prod-t19-old', 'pcs', 1, 1500, 900, true, true, 0, now(), now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sale_price_mmk = EXCLUDED.sale_price_mmk;
-- priceLevelSlice: product_unit_prices upsert
INSERT INTO product_unit_prices (id, product_unit_id, price_level_id, shop_id, price_mmk, is_active, created_at, updated_at)
VALUES ('pup-t19-old', 'unit-t19-old', 'pl-retail', NULL, 1400, true, now(), now())
ON CONFLICT (id) DO UPDATE SET price_mmk = EXCLUDED.price_mmk;
-- writeTableRow inserts: categories / brands / unit_types / shops / price_tiers
INSERT INTO categories (id, name, color, icon_key, is_active, created_at)
VALUES ('cat-t19-old', 'T19 Old Category', '#123456', NULL, true, now());
INSERT INTO brands (id, category_id, name, color, is_active, sort_order, created_at)
VALUES ('brand-t19-old', 'cat-t19-old', 'T19 Old Brand', NULL, true, 0, now());
INSERT INTO unit_types (id, name, abbreviation, description, is_active, sort_order, created_at, updated_at)
VALUES ('ut-t19-old', 't19box', NULL, NULL, true, 99, now(), now());
INSERT INTO shops (id, code, name, address, phone, email, is_active, created_at)
VALUES ('shop-t19-old', 'T19', 'T19 Old Shop', 'Old Street', NULL, NULL, true, now());
INSERT INTO price_tiers (id, product_id, shop_id, min_qty, price_mmk, created_by)
VALUES ('tier-t19-old', 'prod-t19-old', 'shop-a', 10, 1300, 'u-admin');
-- productSlice.linkSupplier: supplier_products insert
INSERT INTO supplier_products (supplier_id, product_id) VALUES ('sup-1', 'prod-t19-old');
-- shopSlice.updateBusinessProfile: business_profile.update().eq('id','default')
SELECT test.check('t19/table: old business_profile update .eq(id,default) touches exactly the caller''s org row',
  test.affected($q$UPDATE business_profile SET tagline = 't19 old client', updated_at = now() WHERE id = 'default'$q$) = 1);
RESET ROLE;

SELECT test.check('t19/table: old inserts without org_id get the CALLER''s org (products, barcodes, categories, brands, unit_types, shops)',
  (SELECT org_id FROM products WHERE id = 'prod-t19-old') = 'org-test'
  AND (SELECT org_id FROM product_barcodes WHERE id = 'bc-t19-old') = 'org-test'
  AND (SELECT org_id FROM categories WHERE id = 'cat-t19-old') = 'org-test'
  AND (SELECT org_id FROM brands WHERE id = 'brand-t19-old') = 'org-test'
  AND (SELECT org_id FROM unit_types WHERE id = 'ut-t19-old') = 'org-test'
  AND (SELECT org_id FROM shops WHERE id = 'shop-t19-old') = 'org-test');
SELECT test.check('t19/table: old product insert creates inventory rows only for the caller''s org shops',
  (SELECT count(*) FROM inventory i JOIN shops s ON s.id = i.shop_id
    WHERE i.product_id = 'prod-t19-old' AND s.org_id <> 'org-test') = 0
  AND (SELECT count(*) FROM inventory WHERE product_id = 'prod-t19-old') >= 2);
SELECT test.check('t19/table: org-two''s business_profile untouched by the old update',
  (SELECT tagline FROM business_profile WHERE org_id = 'org-two') IS DISTINCT FROM 't19 old client'
  AND (SELECT tagline FROM business_profile WHERE org_id = 'org-test') = 't19 old client');

-- cross-org targets an old client could hold as stale ids
SELECT test.setvar('t19_before_xorg', test.t19_counts()::text);
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t19/table: old products.update on another org''s product id -> 0 rows',
  test.affected($q$UPDATE products SET name = 'pwned by old client' WHERE id = 'prod-x1'$q$) = 0);
SELECT test.check('t19/table: old product_barcodes delete .eq(product_id, foreign) -> 0 rows',
  test.affected($q$DELETE FROM product_barcodes WHERE product_id = 'prod-x1'$q$) = 0);
SELECT test.t19_refused('t19/table: old product_units upsert reusing a foreign unit id is refused',
  $q$INSERT INTO product_units (id, product_id, name, base_quantity, sale_price_mmk, is_default, is_active, sort_order)
     VALUES ('unit-x1', 'prod-t19-old', 'hijack', 1, 1, false, true, 0)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sale_price_mmk = EXCLUDED.sale_price_mmk$q$);
SELECT test.t19_refused('t19/table: old barcode insert on a foreign product is refused',
  $q$INSERT INTO product_barcodes (id, product_id, product_unit_id, value, type)
     VALUES ('bc-t19-x', 'prod-x1', NULL, '8850000019002', 'EAN13')$q$);
SELECT test.t19_refused('t19/table: old price_tiers insert on a foreign shop is refused',
  $q$INSERT INTO price_tiers (id, product_id, shop_id, min_qty, price_mmk, created_by)
     VALUES ('tier-t19-x', 'prod-t19-old', 'shop-x', 10, 1, 'u-admin')$q$);
SELECT test.t19_refused('t19/table: old supplier_products link to a foreign product is refused',
  $q$INSERT INTO supplier_products (supplier_id, product_id) VALUES ('sup-1', 'prod-x1')$q$);
RESET ROLE;
-- a CASHIER's old catalogue write (v1.0.15 hides the form, but the request
-- shape is what matters)
SELECT test.login(:'CA1') AS zz \gset
SET ROLE authenticated;
SELECT test.t19_refused('t19/table: old products.insert as CASHIER is refused',
  $q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-t19-cash', 'T19C', 'x', 'c', 'pcs', 1, 1)$q$);
RESET ROLE;
-- v1.0.15 first-time setup: orphan auth account inserts its own ADMIN row
-- directly (authStore.login at the tag), with no org_id
INSERT INTO auth.users (id, email) VALUES (:'ORPH', 'orphan-t19@old.local') ON CONFLICT (id) DO NOTHING;
SELECT test.login(:'ORPH') AS zz \gset
SET ROLE authenticated;
SELECT test.t19_refused('t19/table: old first-time-setup users.insert (ADMIN, no org_id) by an orphan is refused',
  $q$INSERT INTO users (id, name, email, role, auth_id, is_active, created_at)
     VALUES ('user-orphan-t19-old-local', 'orphan t19', 'orphan-t19@old.local', 'ADMIN',
             'a0000000-0000-4000-8000-0000000000f9', true, now())$q$);
SELECT test.t19_refused('t19/table: an orphan''s old catalogue insert is refused (no org to derive)',
  $q$INSERT INTO products (id, sku, name, category, unit_type, price_mmk, cost_mmk) VALUES ('prod-t19-orph', 'T19O', 'x', 'c', 'pcs', 1, 1)$q$);
RESET ROLE;
SELECT test.logout() AS zz \gset
SELECT test.check('t19/table: no cross-org / orphan old write landed (counts unchanged, foreign rows intact)',
  test.t19_counts() = test.var('t19_before_xorg')::jsonb
  AND (SELECT name FROM products WHERE id = 'prod-x1') = 'Product X1'
  AND (SELECT name FROM product_units WHERE id = 'unit-x1') = 'pcs'
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = 'user-orphan-t19-old-local'),
  (SELECT string_agg(k || ' ' || (test.var('t19_before_xorg')::jsonb ->> k) || '->' || v, ', ')
     FROM jsonb_each_text(test.t19_counts()) AS e(k, v)
    WHERE v IS DISTINCT FROM (test.var('t19_before_xorg')::jsonb ->> k)));
SELECT test.check('t19/table: no row anywhere has a NULL org_id after the old writes',
  NOT EXISTS (SELECT 1 FROM products WHERE org_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM product_barcodes WHERE org_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM categories WHERE org_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM brands WHERE org_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM unit_types WHERE org_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM shops WHERE org_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM users WHERE org_id IS NULL));

-- ============================================================
-- 3. v1.0.15 phone-upload flow at 079/080/081
-- ============================================================
-- (a) desktop: create session (server-minted org path), then the OLD attach.
-- t17 part 2 leaves u-admin exactly at the 081 per-user cap (120 sessions in
-- the rolling hour); age those rows out of the window (superuser, test-only)
-- so this file can create one session as the org ADMIN.
UPDATE product_image_upload_sessions SET created_at = created_at - interval '2 hours'
 WHERE created_by = 'u-admin' AND created_at > now() - interval '1 hour';
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.create_product_image_upload_session(p_product_id => 'prod-t19-old', p_shop_id => 'shop-a') AS s1 \gset
SELECT test.check('t19/phone: the session path is server-minted org/<caller org>/temp/<id> (old client uses it as given)',
  :'s1'::jsonb->>'storagePath' = 'org/org-test/temp/' || (:'s1'::jsonb->>'sessionId'));
SELECT public.attach_product_image_upload_session_token(
         p_session_id => :'s1'::jsonb->>'sessionId', p_signed_upload_token => 'old-client-signed-token') AS att \gset
SELECT test.check('t19/phone: old attach on the caller''s own live session still works (compatible, own org only)',
  :'att'::jsonb->>'status' = 'PENDING');
RESET ROLE;
-- another org's admin cannot attach to it
SELECT test.login(:'AX') AS zz \gset
SET ROLE authenticated;
SELECT test.expect_error('t19/phone: old attach on another org''s session -> Upload session not found',
  format($q$SELECT public.attach_product_image_upload_session_token('%s', 'evil-token')$q$, :'s1'::jsonb->>'sessionId'),
  'Upload session not found');
RESET ROLE;
-- anon (the phone) cannot call attach at all
SET ROLE anon;
SELECT test.expect_error('t19/phone: anon cannot call attach_product_image_upload_session_token',
  format($q$SELECT public.attach_product_image_upload_session_token('%s', 'evil-token')$q$, :'s1'::jsonb->>'sessionId'),
  'permission denied');
RESET ROLE;
SELECT test.check('t19/phone: the attached token is still the desktop''s (foreign attach changed nothing)',
  (SELECT signed_upload_token FROM product_image_upload_sessions WHERE id = :'s1'::jsonb->>'sessionId') = 'old-client-signed-token');

-- (b) desktop direct upload (productImageStorage at the tag): legacy
-- unprefixed products/<productId>/<ts>.webp
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT test.check('t19/phone: old desktop upload to legacy products/<own product>/x.webp is allowed (own org)',
  test.can_insert_object('products/prod-t19-old/1790000000000.webp', :'AA'));
SELECT test.check('t19/phone: old desktop upload to legacy products/<FOREIGN product>/x.webp is refused',
  NOT test.can_insert_object('products/prod-x1/1790000000000.webp', :'AA'));
SELECT test.check('t19/phone: a legacy unprefixed temp/<session id> write is refused (the session minted org/... instead)',
  NOT test.can_insert_object('temp/' || (:'s1'::jsonb->>'sessionId'), :'AA'));
RESET ROLE;

-- (c) phone (anon, the token from the QR): old page reads _by_token, uploads
-- to storagePath, then completes with getPublicUrl() of ITS OWN host
SET ROLE anon;
SELECT public.get_product_image_upload_session_by_token(:'s1'::jsonb->>'token') AS bt \gset
RESET ROLE;
SELECT test.check('t19/phone: old phone page gets the session''s org path and the attached upload token',
  :'bt'::jsonb->>'storagePath' = :'s1'::jsonb->>'storagePath'
  AND :'bt'::jsonb->>'uploadToken' = 'old-client-signed-token');
-- the upload itself (storage-api, signed token) - as the storage superuser
INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
VALUES ('product-images', :'s1'::jsonb->>'storagePath', NULL, NULL,
        jsonb_build_object('size', 3000, 'mimetype', 'image/webp'));
SET ROLE anon;
SELECT test.expect_error('t19/phone: old completion with the legacy temp/<id> path -> path mismatch',
  format($q$SELECT public.complete_product_image_upload_session('%s', 'temp/%s', '%s', 3000, 'image/webp')$q$,
         :'s1'::jsonb->>'token', :'s1'::jsonb->>'sessionId',
         'https://gzqiukxnzfdouwaotelx.supabase.co/storage/v1/object/public/product-images/temp/' || (:'s1'::jsonb->>'sessionId')),
  'Upload path does not match this session');
-- the old page built its URL from ITS backend (hosted, if it were the hosted
-- web page): host differs from this server
SELECT public.complete_product_image_upload_session(
         :'s1'::jsonb->>'token', :'s1'::jsonb->>'storagePath',
         'https://gzqiukxnzfdouwaotelx.supabase.co/storage/v1/object/public/product-images/' || (:'s1'::jsonb->>'storagePath'),
         3000, 'image/webp') AS done \gset
RESET ROLE;
SELECT test.check('t19/phone: old completion with a client-supplied foreign-host URL: host IGNORED, server-derived URL stored and returned',
  :'done'::jsonb->>'publicUrl' = :'PUB' || (:'s1'::jsonb->>'storagePath')
  AND (SELECT public_url FROM product_image_upload_sessions WHERE id = :'s1'::jsonb->>'sessionId') = :'PUB' || (:'s1'::jsonb->>'storagePath')
  AND NOT EXISTS (SELECT 1 FROM product_image_upload_sessions WHERE public_url LIKE '%supabase.co%'));
SELECT test.login(:'AA') AS zz \gset
SET ROLE authenticated;
SELECT public.get_product_image_upload_session_status(:'s1'::jsonb->>'sessionId') AS st \gset
RESET ROLE;
SELECT test.check('t19/phone: the old desktop poll receives only the server-derived URL (what it writes to products.image_url)',
  :'st'::jsonb->>'status' = 'COMPLETED' AND :'st'::jsonb->>'publicUrl' = :'PUB' || (:'s1'::jsonb->>'storagePath'));
SET ROLE anon;
SELECT test.expect_error('t19/phone: a second (replayed) old completion is refused',
  format($q$SELECT public.complete_product_image_upload_session('%s', '%s', '%s', 3000, 'image/webp')$q$,
         :'s1'::jsonb->>'token', :'s1'::jsonb->>'storagePath', :'PUB' || (:'s1'::jsonb->>'storagePath')),
  'Upload link is no longer active');
RESET ROLE;
SELECT test.logout() AS zz \gset

-- ============================================================
-- 4. Sign-up is a GoTrue setting, not a database object
-- ============================================================
SELECT test.check('t19/signup: no public-schema function creates auth users (sign-up is GoTrue-only; DISABLE_SIGNUP tested live, G8: 422 signup_disabled)',
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                AND p.prosrc ~* 'insert\s+into\s+auth\.users'));
