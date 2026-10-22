-- Rollback of provisional PFIN-B (functions only; no data). Roll back PFIN-C first: its trigger calls
-- fin_sale_line_net / fin_items, and plpgsql records no dependency, so dropping them under it would make
-- every refund approval fail.
-- Script 2 (migration review D2): never after Recovery V1 (forward repair only), like PFIN-D / PFIN-E
DO $s2_no_rollback_after_v1$
BEGIN
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN RAISE EXCEPTION 'PFIN-B rollback: Recovery V1 is installed (forward repair only)'; END IF;
  -- PFIN-D / PFIN-E call fin_report_scope / fin_sale_line_net (plpgsql records no dependency)
  IF to_regclass('public.sale_payments') IS NOT NULL OR to_regclass('public.refund_lines') IS NOT NULL THEN
    RAISE EXCEPTION 'PFIN-B rollback: PFIN-D / PFIN-E are installed (roll them back first)';
  END IF;
END $s2_no_rollback_after_v1$;
DO $r$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('fin_guard_refund_net_paid', 'fin_guard_refund_net_paid_ins', 'fin_guard_refund_net_paid_upd')) THEN
    RAISE EXCEPTION 'PFIN-B rollback: PFIN-C is still installed (roll back PFIN-C first)';
  END IF;
END $r$;
DROP FUNCTION IF EXISTS public.fin_report_summary(text, date, date, text);
DROP FUNCTION IF EXISTS public.fin_shift_reconciliation(text);
DROP FUNCTION IF EXISTS public.fin_refund_lines(text[]);
DROP FUNCTION IF EXISTS public.fin_sale_method_amounts(text[]);
DROP FUNCTION IF EXISTS public.fin_refund_method_amounts(text[]);
DROP FUNCTION IF EXISTS public.fin_line_costs(text[]);
DROP FUNCTION IF EXISTS public.fin_approval_times(text, text[]);
DROP FUNCTION IF EXISTS public.fin_sale_line_net(text[]);
DROP FUNCTION IF EXISTS public.fin_items(jsonb);
DROP FUNCTION IF EXISTS public.fin_report_scope(text);
