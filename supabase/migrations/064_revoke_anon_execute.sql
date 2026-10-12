-- ============================================================
-- Migration 064: function EXECUTE lockdown - anon/PUBLIC out, explicit grants
--                for authenticated + service_role (Phase D, change A7)
--
-- Defect (docs/selfhost-migration/02-production-dependencies.md §1 "RLS and
-- grants"): every one of the 58 public functions - including all 45 SECURITY
-- DEFINER RPCs and the legacy complete_stock_transfer that migration 052
-- revoked from authenticated - was executable by `anon`, because PostgreSQL
-- grants EXECUTE to PUBLIC on every new function and the hosted default ACL
-- for role postgres additionally granted ALL ON FUNCTIONS TO anon. Only the
-- RPCs' internal current_app_user() checks stood between an anonymous JWT and
-- a write path.
--
-- What this does:
--   1. REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, PUBLIC.
--   2. Fix the default ACL for role postgres so FUTURE functions are not
--      granted to anon/PUBLIC either. The 2026-10-11 snapshot shows default
--      ACLs for role postgres only (no supabase_admin entries), so only
--      postgres is altered; ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin
--      would also require running as supabase_admin.
--   3. Re-grant explicitly: service_role on every public function (matches
--      hosted 58/58); authenticated on every function EXCEPT
--      complete_stock_transfer (keeps migration 052's revoke - the hosted
--      snapshot shows it granted to anon+service_role only, so "58/58" for
--      authenticated was never the real state) and the 062 idem_* helpers.
--   4. anon keeps EXACTLY two token-scoped functions, as migration 019
--      intended: get_product_image_upload_session_by_token and
--      complete_product_image_upload_session are called by the phone QR
--      upload page, which has no session (src/lib/productImagePhoneUpload.ts)
--      and they authenticate by the 256-bit session token, not auth.uid().
--      Revoking them would break phone photo uploads. Every other function is
--      anon-free.
--
-- Function names are used without argument lists on purpose: after 063 every
-- public function name is unique (no overloads), and this keeps the file
-- valid when a later migration changes a signature. If a later migration ever
-- adds an overload, this file must be updated to the explicit signature.
--
-- Rollback: GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon; and
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON
-- FUNCTIONS TO anon, PUBLIC; (restores the pre-064 state). Forward recovery:
-- idempotent, re-run.
--
-- Verification (expected: anon 2, authenticated = total - 4, service_role = total):
--   SELECT r.rolname, count(*) FILTER (WHERE has_function_privilege(r.rolname, p.oid, 'EXECUTE')) AS can_exec,
--          count(*) AS total
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) r(rolname)
--    WHERE n.nspname = 'public' GROUP BY 1 ORDER BY 1;
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE');
--   -- expect exactly: complete_product_image_upload_session, get_product_image_upload_session_by_token
--   SELECT defaclacl FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
--    WHERE n.nspname = 'public' AND d.defaclobjtype = 'f';
--   -- expect no "anon=" entry and no "=X/" (PUBLIC) entry
-- ============================================================

-- 1. Blanket revoke. authenticated is included on purpose: the end state must
--    not depend on how the functions were created (hosted default ACL vs a
--    baseline restored as supabase_admin, whose default ACL also grants
--    authenticated - verified in the Phase D harness: without this line
--    complete_stock_transfer came back executable by authenticated on a
--    fresh install). Everything authenticated needs is re-granted in 3b.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, PUBLIC;

-- 2. Default ACL fix for future functions created by postgres.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, PUBLIC;

-- 2b. Best effort for supabase_admin's default ACL (the self-hosted image
--     ships one that grants anon; the hosted snapshot shows none). Only
--     possible when the migration runs as supabase_admin or a member of it;
--     otherwise log a NOTICE so the runbook can do it as supabase_admin:
--       ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
--         REVOKE EXECUTE ON FUNCTIONS FROM anon, PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
     AND EXISTS (SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
                  WHERE n.nspname = 'public' AND d.defaclobjtype = 'f'
                    AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = 'supabase_admin')) THEN
    BEGIN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, PUBLIC';
      RAISE NOTICE '064: supabase_admin default function ACL cleaned';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE '064: cannot alter supabase_admin default privileges as %, run it as supabase_admin (see header)', current_user;
    END;
  END IF;
END $$;

-- 3. service_role: everything (parity with hosted 58/58, plus the 062 helpers).
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- 3b. authenticated: explicit per function. Helpers first (RLS policies and
--     RPC bodies call these as the invoking role, so authenticated needs
--     EXECUTE on them exactly as hosted has it).
GRANT EXECUTE ON FUNCTION public.app_can_for_shop          TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_has_perm              TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_org_id                TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_role                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_shop_id               TO authenticated;
GRANT EXECUTE ON FUNCTION public.app_user_id               TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_app_user          TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_event_time        TO authenticated;
GRANT EXECUTE ON FUNCTION public.role_default_permissions  TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_json             TO authenticated;
GRANT EXECUTE ON FUNCTION public.product_image_upload_token_hash TO authenticated;
-- trigger functions (hosted parity; EXECUTE on these is not checked at fire time)
GRANT EXECUTE ON FUNCTION public.brands_set_updated_at               TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_user_assignment_rules       TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_inventory_rows_for_product   TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_inventory_rows_for_shop      TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_user_privilege_columns        TO authenticated;
GRANT EXECUTE ON FUNCTION public.price_levels_set_updated_at         TO authenticated;
GRANT EXECUTE ON FUNCTION public.product_barcodes_validate_unit_product TO authenticated;
GRANT EXECUTE ON FUNCTION public.product_unit_prices_set_updated_at  TO authenticated;
GRANT EXECUTE ON FUNCTION public.product_units_set_updated_at        TO authenticated;
GRANT EXECUTE ON FUNCTION public.unit_types_set_updated_at           TO authenticated;
-- RPCs (063 signatures)
GRANT EXECUTE ON FUNCTION public.adjust_stock                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_purchase_order       TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_refund_request       TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_stock_transfer       TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_void_request         TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_purchase_order        TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_stock_transfer        TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_shift                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_sale                TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_app_user              TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_purchase_order        TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_refund_void_request   TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_stock_transfer        TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_supplier              TO authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_app_user          TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_product               TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_stock_transfer      TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_audit_event              TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_receipt_reprint          TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_shift                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_supplier_lump_sum        TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order       TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_stock_transfer       TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_supplier_payment      TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_refund_void_request   TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_stock_transfer        TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_manager              TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_app_user              TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_supplier              TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_supplier_payment        TO authenticated;
-- image upload sessions (migration 019 state)
GRANT EXECUTE ON FUNCTION public.attach_product_image_upload_session_token TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_product_image_upload_session       TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_product_image_upload_session     TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_product_image_upload_session       TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_product_image_upload_session_by_token TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_product_image_upload_session_status   TO authenticated;
-- NOT granted to authenticated on purpose: complete_stock_transfer (052),
-- idem_begin, idem_finish, prune_idempotency_keys (062). Re-stated explicitly
-- so the intent survives even if step 1 is ever narrowed:
REVOKE EXECUTE ON FUNCTION public.complete_stock_transfer FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.idem_begin              FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.idem_finish             FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.prune_idempotency_keys  FROM authenticated, anon;

-- 4. anon: only the two token-authenticated phone-upload entry points (019).
GRANT EXECUTE ON FUNCTION public.get_product_image_upload_session_by_token TO anon;
GRANT EXECUTE ON FUNCTION public.complete_product_image_upload_session     TO anon;

NOTIFY pgrst, 'reload schema';
