-- ROLLBACK of PROVISIONAL PFIN-F (split refunds, exception approvals, payout confirmations, f10 / f125).
-- Refuses while any approval or payout confirmation exists (financial evidence is never discarded).
-- Run as the superuser migration runner, before Recovery V1 only, IN ONE TRANSACTION WITH PFIN-E re-applied (which restores
-- PFIN-E's own fin_refund_prior_methods and fin_refund_caps_problem; between the two they would reference dropped objects):
--   psql --single-transaction -f PFIN-F.rollback.sql -f PFIN-E_refund_lines.sql
DO $pfin_f_rb$
BEGIN
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN RAISE EXCEPTION 'PFIN-F rollback: Recovery V1 is installed'; END IF;
  IF to_regprocedure('public.fin_discount_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'PFIN-F rollback: PDISC-A is installed (its sale trigger needs PFIN-F); roll PDISC-A back first';
  END IF;
  IF to_regclass('public.fin_approvals') IS NOT NULL AND EXISTS (SELECT 1 FROM public.fin_approvals) THEN
    RAISE EXCEPTION 'PFIN-F rollback: approvals exist; they are financial evidence and are never discarded';
  END IF;
  IF to_regclass('public.refund_cash_drawer') IS NOT NULL AND EXISTS (SELECT 1 FROM public.refund_cash_drawer) THEN
    RAISE EXCEPTION 'PFIN-F rollback: closed-shift refund drawer records exist; they are financial evidence and are never discarded';
  END IF;
  IF to_regclass('public.refund_payout_confirmations') IS NOT NULL AND EXISTS (SELECT 1 FROM public.refund_payout_confirmations) THEN
    RAISE EXCEPTION 'PFIN-F rollback: payout confirmations exist; they are financial evidence and are never discarded';
  END IF;
END $pfin_f_rb$;
DROP TRIGGER IF EXISTS zzg_refund_policy_ins ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzg_refund_policy_upd ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzg_refund_exceptions ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzg_refund_default_payout ON public.refund_void_requests;
DROP FUNCTION IF EXISTS public.fin_refund_default_payout_record();
DROP TRIGGER IF EXISTS zzf_sale_change_guard ON public.sales;
DROP FUNCTION IF EXISTS public.fin_confirm_refund_payout(text, text, uuid);
DROP FUNCTION IF EXISTS public.fin_refund_payout_state(text);
DROP FUNCTION IF EXISTS public.fin_refund_plan(text, jsonb);
DROP FUNCTION IF EXISTS public.fin_decide_approval(text, text, text, uuid);
DROP FUNCTION IF EXISTS public.fin_approval_json(public.fin_approvals);
DROP FUNCTION IF EXISTS public.fin_refund_policy();
DROP FUNCTION IF EXISTS public.fin_refund_exceptions_record();
DROP FUNCTION IF EXISTS public.fin_sale_change_guard();
DROP TABLE IF EXISTS public.refund_payout_confirmations;
DROP TABLE IF EXISTS public.refund_cash_drawer;
DROP TABLE IF EXISTS public.fin_approvals;
DROP FUNCTION IF EXISTS public.fin_approvals_guard();
DROP FUNCTION IF EXISTS public.fin_refund_exceptions(text, text, jsonb);
DROP FUNCTION IF EXISTS public.fin_refund_default_line(text, text, text, bigint);
DROP FUNCTION IF EXISTS public.fin_refund_default_payouts(text, text, bigint);
DROP FUNCTION IF EXISTS public.fin_is_shop_admin(text);
DROP FUNCTION IF EXISTS public.fin_request_offline();
-- role_default_permissions: migration 057's definition, byte for byte (ADMIN loses fin:approve_exception)
CREATE OR REPLACE FUNCTION public.role_default_permissions(p_role text)
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE upper(p_role)
    WHEN 'ADMIN' THEN ARRAY[
      'shop:create','shop:read','shop:update','shop:delete',
      'user:create','user:read','user:update','user:delete',
      'product:create','product:read','product:update','product:delete','product:edit_price','barcode:manage',
      'inventory:view_stock','inventory:view_movements','inventory:adjust','inventory:damage','inventory:override_negative',
      'transfer:create','transfer:approve','transfer:cancel','transfer:view',
      'pos:create_sale','pos:apply_discount','pos:override_price','pos:override_stock',
      'pos:void_sale','pos:refund','pos:request_refund','pos:request_void',
      'sale:view','sales:view_own_shift','receipt:reprint',
      'supplier:create','supplier:read','supplier:update','supplier:delete',
      'supplier:debt_view','supplier:payment_create',
      'purchase:create','purchase:approve','purchase:receive','purchase:view',
      'pricing:manage','approval:view',
      'shift:manage_own','shift:manage_all','shift:verify',
      'report:own_shift','report:shop_sales','report:shop_inventory','report:shop_profit','report:global',
      'audit:view_shop','audit:view_global'
    ]
    WHEN 'MANAGER' THEN ARRAY[
      'shop:read','user:read',
      'product:read','product:update','product:edit_price',
      'inventory:view_stock','inventory:view_movements','inventory:adjust','inventory:damage','inventory:override_negative',
      'transfer:create','transfer:approve','transfer:cancel','transfer:view',
      'pos:create_sale','pos:apply_discount','pos:override_price','pos:override_stock',
      'pos:void_sale','pos:refund','pos:request_refund','pos:request_void',
      'sale:view','sales:view_own_shift','receipt:reprint',
      'supplier:read','supplier:debt_view','supplier:payment_create',
      'purchase:create','purchase:approve','purchase:receive','purchase:view','approval:view',
      'shift:manage_own','shift:manage_all','shift:verify',
      'report:own_shift','report:shop_sales','report:shop_inventory',
      'audit:view_shop'
    ]
    WHEN 'CASHIER' THEN ARRAY[
      'product:read','inventory:view_stock',
      'pos:create_sale','pos:apply_discount','pos:request_refund','pos:request_void',
      'sales:view_own_shift','receipt:reprint',
      'shift:manage_own','report:own_shift'
    ]
    WHEN 'BUYER' THEN ARRAY[
      'product:read','supplier:read','supplier:debt_view','purchase:view','purchase:create'
    ]
    ELSE ARRAY[]::text[]
  END;
$$;
-- PFIN-E_refund_lines.sql must follow in the same transaction (see the header)
NOTIFY pgrst, 'reload schema';
