-- Phase D live QA post-cleanup verification (run as supabase_admin).
-- RAISEs an EXCEPTION (non-zero psql exit) if any QA row remains in any
-- table touched by the live run, including the auth schema and storage.
-- Prints one line per table with the remaining count (all must be 0).
--
-- Phase G: also covers console-created QA organizations (ids `org-<uuid>`,
-- name 'QA ...'), every table that carries org_id since 068
-- (categories, brands, unit_types, price_levels, product_barcodes,
-- business_profile), platform_admins of QA accounts, rows owned by a
-- @qa.invalid user whose id is not qa- (console-minted `user-<uuid>`), and
-- storage objects uploaded by a QA account (owner = a QA auth uid, or a
-- qa-/QA path). It also asserts that no catalog/user/shop row references an
-- organization that no longer exists.
\set ON_ERROR_STOP on

DO $$
DECLARE
  r record;
  v_total bigint := 0;
  v_lines text := '';
BEGIN
  FOR r IN
    SELECT 'organizations' AS t, count(*) AS n FROM organizations WHERE id LIKE 'qa-%' OR name LIKE 'QA %'
    UNION ALL SELECT 'business_profile (qa org / orphan)', count(*) FROM business_profile
                WHERE org_id LIKE 'qa-%' OR org_id NOT IN (SELECT id FROM organizations)
                   OR business_name LIKE 'QA %'
    UNION ALL SELECT 'categories (qa)', count(*) FROM categories WHERE id LIKE 'qa-%' OR org_id LIKE 'qa-%' OR name LIKE 'QA %'
    UNION ALL SELECT 'brands (qa)', count(*) FROM brands WHERE id LIKE 'qa-%' OR org_id LIKE 'qa-%' OR name LIKE 'QA %'
    UNION ALL SELECT 'unit_types (qa)', count(*) FROM unit_types WHERE id LIKE 'qa-%' OR org_id LIKE 'qa-%' OR name LIKE 'QA %'
    UNION ALL SELECT 'price_levels (qa)', count(*) FROM price_levels WHERE id LIKE 'qa-%' OR org_id LIKE 'qa-%' OR name LIKE 'QA %' OR code LIKE 'QA%'
    UNION ALL SELECT 'rows whose organization is gone', (
                  (SELECT count(*) FROM products   WHERE org_id NOT IN (SELECT id FROM organizations))
                + (SELECT count(*) FROM categories WHERE org_id NOT IN (SELECT id FROM organizations))
                + (SELECT count(*) FROM brands     WHERE org_id NOT IN (SELECT id FROM organizations))
                + (SELECT count(*) FROM suppliers  WHERE org_id NOT IN (SELECT id FROM organizations))
                + (SELECT count(*) FROM unit_types WHERE org_id NOT IN (SELECT id FROM organizations))
                + (SELECT count(*) FROM price_levels WHERE org_id NOT IN (SELECT id FROM organizations))
                + (SELECT count(*) FROM product_barcodes WHERE org_id NOT IN (SELECT id FROM organizations))
                + (SELECT count(*) FROM shops WHERE org_id NOT IN (SELECT id FROM organizations))
                + (SELECT count(*) FROM users WHERE org_id NOT IN (SELECT id FROM organizations)))
    UNION ALL SELECT 'platform_admins (qa)', count(*) FROM platform_admins WHERE email LIKE '%@qa.invalid'
                   OR auth_id NOT IN (SELECT id FROM auth.users)
    UNION ALL SELECT 'shops', count(*) FROM shops WHERE id LIKE 'qa-%' OR name LIKE 'QA %' OR code LIKE 'QA%'
    UNION ALL SELECT 'users', count(*) FROM users WHERE id LIKE 'qa-%' OR email LIKE '%@qa.invalid' OR name LIKE 'QA %'
    UNION ALL SELECT 'products', count(*) FROM products WHERE id LIKE 'qa-%' OR name LIKE 'QA %' OR sku LIKE 'QA%'
    UNION ALL SELECT 'product_units', count(*) FROM product_units WHERE id LIKE 'qa-%' OR product_id LIKE 'qa-%'
    UNION ALL SELECT 'product_unit_prices', count(*) FROM product_unit_prices WHERE id LIKE 'qa-%' OR shop_id LIKE 'qa-%' OR product_unit_id LIKE 'qa-%'
    UNION ALL SELECT 'product_barcodes', count(*) FROM product_barcodes WHERE id LIKE 'qa-%' OR product_id LIKE 'qa-%'
    UNION ALL SELECT 'price_tiers', count(*) FROM price_tiers WHERE id LIKE 'qa-%' OR product_id LIKE 'qa-%' OR shop_id LIKE 'qa-%'
    UNION ALL SELECT 'inventory (qa shop or qa product)', count(*) FROM inventory WHERE shop_id LIKE 'qa-%' OR product_id LIKE 'qa-%'
    UNION ALL SELECT 'inventory_movements', count(*) FROM inventory_movements WHERE shop_id LIKE 'qa-%' OR product_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
    UNION ALL SELECT 'suppliers', count(*) FROM suppliers WHERE id LIKE 'qa-%' OR name LIKE 'QA %' OR code LIKE 'QASUP%'
    UNION ALL SELECT 'supplier_products', count(*) FROM supplier_products WHERE supplier_id LIKE 'qa-%' OR product_id LIKE 'qa-%'
    UNION ALL SELECT 'purchase_orders', count(*) FROM purchase_orders WHERE shop_id LIKE 'qa-%' OR supplier_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
    UNION ALL SELECT 'purchase_order_items', count(*) FROM purchase_order_items WHERE product_id LIKE 'qa-%'
    UNION ALL SELECT 'supplier_payments', count(*) FROM supplier_payments WHERE supplier_id LIKE 'qa-%' OR shop_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
    UNION ALL SELECT 'stock_transfers', count(*) FROM stock_transfers WHERE from_shop_id LIKE 'qa-%' OR to_shop_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
    UNION ALL SELECT 'stock_transfer_items', count(*) FROM stock_transfer_items WHERE product_id LIKE 'qa-%'
    UNION ALL SELECT 'shifts', count(*) FROM shifts WHERE shop_id LIKE 'qa-%' OR cashier_id LIKE 'qa-%'
    UNION ALL SELECT 'sales', count(*) FROM sales WHERE shop_id LIKE 'qa-%' OR cashier_id LIKE 'qa-%'
    UNION ALL SELECT 'sale_items', count(*) FROM sale_items WHERE product_id LIKE 'qa-%'
    UNION ALL SELECT 'refund_void_requests', count(*) FROM refund_void_requests WHERE shop_id LIKE 'qa-%' OR created_by LIKE 'qa-%'
    UNION ALL SELECT 'reprint_logs', count(*) FROM reprint_logs WHERE printed_by LIKE 'qa-%'
    UNION ALL SELECT 'product_image_upload_sessions', count(*) FROM product_image_upload_sessions WHERE created_by LIKE 'qa-%' OR shop_id LIKE 'qa-%' OR product_id LIKE 'qa-%'
    UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs WHERE actor_id LIKE 'qa-%' OR shop_id LIKE 'qa-%' OR entity_id LIKE 'qa-%'
    UNION ALL SELECT 'idempotency_keys', count(*) FROM idempotency_keys WHERE actor_id LIKE 'qa-%'
                   OR actor_id NOT IN (SELECT id FROM users) OR org_id LIKE 'qa-org-%'
    UNION ALL SELECT 'auth.users', count(*) FROM auth.users WHERE email LIKE '%@qa.invalid'
    UNION ALL SELECT 'auth.identities', count(*) FROM auth.identities WHERE email LIKE '%@qa.invalid' OR user_id NOT IN (SELECT id FROM auth.users)
    UNION ALL SELECT 'auth.sessions (orphan)', count(*) FROM auth.sessions WHERE user_id NOT IN (SELECT id FROM auth.users)
    UNION ALL SELECT 'auth.refresh_tokens (orphan)', count(*) FROM auth.refresh_tokens WHERE user_id NOT IN (SELECT id::text FROM auth.users)
    UNION ALL SELECT 'auth.mfa_factors (orphan)', count(*) FROM auth.mfa_factors WHERE user_id NOT IN (SELECT id FROM auth.users)
    -- Phase E: the QA admin enrols a TOTP factor through the API; challenges
    -- cascade from the factor, and GoTrue audit rows that name a QA account
    -- are purged by supabase/tests/phase-e/live/audit_purge.sql.
    UNION ALL SELECT 'auth.mfa_challenges (orphan)', count(*) FROM auth.mfa_challenges WHERE factor_id NOT IN (SELECT id FROM auth.mfa_factors)
    UNION ALL SELECT 'auth.audit_log_entries (@qa.invalid)', count(*) FROM auth.audit_log_entries WHERE payload::text ILIKE '%@qa.invalid%'
    UNION ALL SELECT 'storage.objects (qa upload paths)', count(*) FROM storage.objects
                WHERE name LIKE 'temp/pimg-%' AND name IN (SELECT storage_path FROM product_image_upload_sessions WHERE created_by LIKE 'qa-%')
                   OR name LIKE '%qa-prod-%' OR name LIKE '%qa-%' OR name LIKE '%QA%'
    -- 078/079: org-scoped paths. A QA org prefix, or the prefix of an
    -- organization that no longer exists (console-created QA orgs have
    -- org-<uuid> ids without a qa- marker), must be empty after cleanup.
    UNION ALL SELECT 'storage.objects (org/<qa or deleted org>/...)', count(*) FROM storage.objects
                WHERE name LIKE 'org/%'
                  AND (split_part(name, '/', 2) LIKE 'qa-%'
                       OR split_part(name, '/', 2) NOT IN (SELECT id FROM organizations))
    UNION ALL SELECT 'storage.objects (uploaded by a QA or deleted account)', count(*) FROM storage.objects o
                WHERE COALESCE(o.owner_id, o.owner::text) IS NOT NULL
                  AND (COALESCE(o.owner_id, o.owner::text) IN (SELECT id::text FROM auth.users WHERE email LIKE '%@qa.invalid')
                       OR NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id::text = COALESCE(o.owner_id, o.owner::text)))
  LOOP
    v_lines := v_lines || format('%s=%s ', r.t, r.n);
    v_total := v_total + r.n;
    RAISE NOTICE 'remaining % = %', r.t, r.n;
  END LOOP;

  IF v_total > 0 THEN
    RAISE EXCEPTION 'verify_clean FAILED: % QA row(s) remain: %', v_total, v_lines;
  END IF;
  RAISE NOTICE 'verify_clean OK: no qa-/@qa.invalid/"QA " rows remain in any checked table';
END $$;

SELECT 'CLEAN' AS verify_clean;
