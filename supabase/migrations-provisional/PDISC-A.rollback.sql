-- ROLLBACK of PROVISIONAL PDISC-A (discount authorization). Removes the enforcement only; DISCOUNT approval rows in
-- fin_approvals are financial evidence and stay (PFIN-F owns the table). Superuser runner, before Recovery V1 only.
DO $pdisc_a_rb$
BEGIN
  IF to_regnamespace('recovery_v1') IS NOT NULL THEN RAISE EXCEPTION 'PDISC-A rollback: Recovery V1 is installed'; END IF;
END $pdisc_a_rb$;
DROP TRIGGER IF EXISTS zzd_discount_guard ON public.sales;
DROP TRIGGER IF EXISTS zzd_discount_guard ON public.sale_items;
DROP FUNCTION IF EXISTS public.fin_request_discount_approval(text, integer, integer, text, uuid);
DROP FUNCTION IF EXISTS public.fin_discount_guard();
DROP FUNCTION IF EXISTS public.fin_discount_authorize(public.sales, bigint, boolean);
DROP FUNCTION IF EXISTS public.fin_user_has_perm(public.users, text);
DROP FUNCTION IF EXISTS public.fin_reference_unit_price(text, text, text, text, bigint);
NOTIFY pgrst, 'reload schema';
