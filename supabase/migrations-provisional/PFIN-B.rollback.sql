-- Rollback of provisional PFIN-B (functions only; no data). Roll back PFIN-C first: its trigger calls
-- fin_sale_line_net / fin_items, and plpgsql records no dependency, so dropping them under it would make
-- every refund approval fail.
DO $r$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('fin_guard_refund_net_paid', 'fin_guard_refund_net_paid_ins', 'fin_guard_refund_net_paid_upd')) THEN
    RAISE EXCEPTION 'PFIN-B rollback: PFIN-C is still installed (roll back PFIN-C first)';
  END IF;
END $r$;
DROP FUNCTION IF EXISTS public.fin_report_summary(text, date, date, text);
DROP FUNCTION IF EXISTS public.fin_shift_reconciliation(text);
DROP FUNCTION IF EXISTS public.fin_refund_lines(text[]);
DROP FUNCTION IF EXISTS public.fin_line_costs(text[]);
DROP FUNCTION IF EXISTS public.fin_approval_times(text, text[]);
DROP FUNCTION IF EXISTS public.fin_sale_line_net(text[]);
DROP FUNCTION IF EXISTS public.fin_items(jsonb);
DROP FUNCTION IF EXISTS public.fin_report_scope(text);
