-- Rollback of provisional PFIN-D. Drops objects only. Refuses while any split payment or cash movement exists
-- (those records would be lost); synthesized single-payment rows are derivable from sales and are dropped.
-- Refuses after Recovery V1 and while PFIN-E is installed.
SET lock_timeout = '3s';
DO $rb$
BEGIN
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN RAISE EXCEPTION 'PFIN-D-RB: Recovery V1 is installed (forward repair only)'; END IF;
  IF to_regclass('public.refund_lines') IS NOT NULL THEN RAISE EXCEPTION 'PFIN-D-RB: roll back PFIN-E first'; END IF;
  IF to_regclass('public.sale_payments') IS NOT NULL AND EXISTS (SELECT 1 FROM public.sale_payments WHERE source = 'split') THEN
    RAISE EXCEPTION 'PFIN-D-RB: split payments exist; rolling back would lose them';
  END IF;
  IF to_regclass('public.cash_movements') IS NOT NULL AND EXISTS (SELECT 1 FROM public.cash_movements) THEN
    RAISE EXCEPTION 'PFIN-D-RB: cash movements exist; rolling back would lose them';
  END IF;
END $rb$;
DROP TRIGGER IF EXISTS zzf_sale_payments ON public.sales;
DROP TRIGGER IF EXISTS zzf_shift_close_guard ON public.shifts;
DROP FUNCTION IF EXISTS public.fin_capabilities();
DROP FUNCTION IF EXISTS public.fin_payment_summary(text, date, date);
DROP FUNCTION IF EXISTS public.fin_close_shift(text, integer, text, timestamptz, text, uuid);
DROP FUNCTION IF EXISTS public.fin_guard_shift_close();
DROP FUNCTION IF EXISTS public.fin_record_cash_movement(text, text, integer, text, text, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.fin_shift_cash_summary(text);
DROP FUNCTION IF EXISTS public.fin_shift_cash(text);
DROP FUNCTION IF EXISTS public.fin_complete_sale_split(text, uuid, jsonb, jsonb, text, jsonb);
DROP FUNCTION IF EXISTS public.fin_split_replay_problem(uuid, text);
DROP TABLE IF EXISTS public.cash_movements;
DROP TABLE IF EXISTS public.sale_payments;
DROP FUNCTION IF EXISTS public.fin_sale_payments_record();
DROP FUNCTION IF EXISTS public.fin_payments_canonical(jsonb);
DROP FUNCTION IF EXISTS public.fin_immutable();
DO $r$ BEGIN IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF; END $r$;
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
