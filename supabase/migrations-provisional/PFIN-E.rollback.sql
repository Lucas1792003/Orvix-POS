-- Rollback of provisional PFIN-E. Drops objects only; refuses while any refund line or payout exists, and after V1.
SET lock_timeout = '3s';
DO $rb$
BEGIN
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN RAISE EXCEPTION 'PFIN-E-RB: Recovery V1 is installed (forward repair only)'; END IF;
  IF (to_regclass('public.refund_lines') IS NOT NULL AND EXISTS (SELECT 1 FROM public.refund_lines))
     OR (to_regclass('public.refund_payouts') IS NOT NULL AND EXISTS (SELECT 1 FROM public.refund_payouts)) THEN
    RAISE EXCEPTION 'PFIN-E-RB: refund lines or payouts exist; rolling back would lose them';
  END IF;
END $rb$;
DROP TRIGGER IF EXISTS zzf_refund_guard_ins ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzf_refund_guard_upd ON public.refund_void_requests;
DROP TRIGGER IF EXISTS zzf_refund_record ON public.refund_void_requests;
DROP FUNCTION IF EXISTS public.fin_refund_lines_state(text);
DROP FUNCTION IF EXISTS public.fin_refund_record();
DROP FUNCTION IF EXISTS public.fin_refund_guard();
DROP FUNCTION IF EXISTS public.fin_refund_caps_problem(text, text, jsonb);
DROP FUNCTION IF EXISTS public.fin_refund_prior_lines(text, text);
DROP FUNCTION IF EXISTS public.fin_refund_prior_methods(text, text);
DROP FUNCTION IF EXISTS public.fin_refund_items_problem(text, jsonb);
DROP TABLE IF EXISTS public.refund_payouts;
DROP TABLE IF EXISTS public.refund_lines;
DO $r$ BEGIN IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF; END $r$;
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
