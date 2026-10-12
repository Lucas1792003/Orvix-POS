-- ============================================================
-- Migration 065: table/view privilege parity with hosted production
--
-- Why: on a fresh self-hosted install the public tables are created by
-- migrations/baseline under whatever default ACL the target image ships, so
-- GRANTs drift from production (and the hosted default ACL itself grants ALL
-- to anon/authenticated/service_role on every new table). This file pins the
-- EXACT per-relation grant set captured from hosted on 2026-10-11
-- (~/shwephala-migration/20261011T2347Z/hosted-grants.txt, 92 rows, 32
-- relations incl. the rbac_assignment_violations view) so a fresh install and
-- the upgraded production database carry identical table privileges. It is
-- REVOKE ALL then GRANT per relation, for anon / authenticated / service_role.
--
-- Notes on what this preserves (pre-existing hosted state, NOT changed here):
--   * anon holds full table-level grants on most tables. RLS is enabled on
--     every table with policies `TO authenticated` only, so anon still reads
--     and writes nothing; the grants are inert but kept for parity. Tightening
--     them is a separate decision (see report).
--   * rbac_assignment_violations is a plain view (security_invoker off) owned
--     by postgres (bypassrls). anon/authenticated SELECT on it is the hosted
--     state; it exposes id/name/role/shop/is_active of users that violate the
--     RBAC assignment rules. Flagged for the owner; kept for parity.
--   * The PG17 MAINTAIN privilege that pg_dump shows for authenticated on the
--     read-only tables is not in the hosted-grants.txt extract (information_
--     schema does not list it) and is not granted here; it only allows
--     VACUUM/ANALYZE/REINDEX, which PostgREST callers cannot issue.
--   * admin_login_codes and platform_admins: service_role only (042, 061).
--   * idempotency_keys (062): service_role only - included so the picture is
--     complete after 062-065 are applied.
--
-- Rollback: there is no "previous" grant set to restore on a fresh install;
-- on hosted this file is a no-op by construction. Forward recovery: re-run
-- (idempotent).
--
-- Verification (expect the 92 rows of hosted-grants.txt plus one row
-- idempotency_keys|service_role|DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE):
--   SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--     FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role')
--    GROUP BY 1,2 ORDER BY 1,2;
-- ============================================================

-- admin_login_codes
REVOKE ALL ON TABLE public.admin_login_codes FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_login_codes TO service_role;

-- audit_logs
REVOKE ALL ON TABLE public.audit_logs FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.audit_logs TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.audit_logs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.audit_logs TO service_role;

-- brands
REVOKE ALL ON TABLE public.brands FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.brands TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.brands TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.brands TO service_role;

-- business_profile
REVOKE ALL ON TABLE public.business_profile FROM PUBLIC, anon, authenticated, service_role;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.business_profile TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.business_profile TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.business_profile TO service_role;

-- categories
REVOKE ALL ON TABLE public.categories FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.categories TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.categories TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.categories TO service_role;

-- inventory
REVOKE ALL ON TABLE public.inventory FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.inventory TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.inventory TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.inventory TO service_role;

-- inventory_movements
REVOKE ALL ON TABLE public.inventory_movements FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.inventory_movements TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.inventory_movements TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.inventory_movements TO service_role;

-- organizations
REVOKE ALL ON TABLE public.organizations FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.organizations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.organizations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.organizations TO service_role;

-- platform_admins
REVOKE ALL ON TABLE public.platform_admins FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.platform_admins TO service_role;

-- price_levels
REVOKE ALL ON TABLE public.price_levels FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.price_levels TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.price_levels TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.price_levels TO service_role;

-- price_tiers
REVOKE ALL ON TABLE public.price_tiers FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.price_tiers TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.price_tiers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.price_tiers TO service_role;

-- product_barcodes
REVOKE ALL ON TABLE public.product_barcodes FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_barcodes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_barcodes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_barcodes TO service_role;

-- product_image_upload_sessions
REVOKE ALL ON TABLE public.product_image_upload_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_image_upload_sessions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_image_upload_sessions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_image_upload_sessions TO service_role;

-- product_unit_prices
REVOKE ALL ON TABLE public.product_unit_prices FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_unit_prices TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_unit_prices TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_unit_prices TO service_role;

-- product_units
REVOKE ALL ON TABLE public.product_units FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_units TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_units TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_units TO service_role;

-- products
REVOKE ALL ON TABLE public.products FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.products TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.products TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.products TO service_role;

-- purchase_order_items
REVOKE ALL ON TABLE public.purchase_order_items FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.purchase_order_items TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.purchase_order_items TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.purchase_order_items TO service_role;

-- purchase_orders
REVOKE ALL ON TABLE public.purchase_orders FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.purchase_orders TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.purchase_orders TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.purchase_orders TO service_role;

-- rbac_assignment_violations
REVOKE ALL ON TABLE public.rbac_assignment_violations FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.rbac_assignment_violations TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.rbac_assignment_violations TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.rbac_assignment_violations TO service_role;

-- refund_void_requests
REVOKE ALL ON TABLE public.refund_void_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.refund_void_requests TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.refund_void_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.refund_void_requests TO service_role;

-- reprint_logs
REVOKE ALL ON TABLE public.reprint_logs FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.reprint_logs TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.reprint_logs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.reprint_logs TO service_role;

-- sale_items
REVOKE ALL ON TABLE public.sale_items FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.sale_items TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.sale_items TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.sale_items TO service_role;

-- sales
REVOKE ALL ON TABLE public.sales FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.sales TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.sales TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.sales TO service_role;

-- shifts
REVOKE ALL ON TABLE public.shifts FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.shifts TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.shifts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.shifts TO service_role;

-- shops
REVOKE ALL ON TABLE public.shops FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.shops TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.shops TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.shops TO service_role;

-- stock_transfer_items
REVOKE ALL ON TABLE public.stock_transfer_items FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.stock_transfer_items TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.stock_transfer_items TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.stock_transfer_items TO service_role;

-- stock_transfers
REVOKE ALL ON TABLE public.stock_transfers FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.stock_transfers TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.stock_transfers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.stock_transfers TO service_role;

-- supplier_payments
REVOKE ALL ON TABLE public.supplier_payments FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.supplier_payments TO anon;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.supplier_payments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.supplier_payments TO service_role;

-- supplier_products
REVOKE ALL ON TABLE public.supplier_products FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.supplier_products TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.supplier_products TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.supplier_products TO service_role;

-- suppliers
REVOKE ALL ON TABLE public.suppliers FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.suppliers TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.suppliers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.suppliers TO service_role;

-- unit_types
REVOKE ALL ON TABLE public.unit_types FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.unit_types TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.unit_types TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.unit_types TO service_role;

-- users
REVOKE ALL ON TABLE public.users FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.users TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.users TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.users TO service_role;

-- idempotency_keys (062): service_role only
REVOKE ALL ON TABLE public.idempotency_keys FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.idempotency_keys TO service_role;
