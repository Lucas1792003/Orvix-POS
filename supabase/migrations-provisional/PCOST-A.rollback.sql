-- Rollback of provisional PCOST-A. Copies every cost back into the legacy
-- columns (asserted), then drops the triggers' functions and the side tables.
-- With 087 installed: superuser session, server OPEN (the copy-back writes
-- guarded tables), and nothing else drifted from the 087 snapshot.
-- WARNING: after this rollback cost is again readable by every org user.
SET lock_timeout = '3s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $r_pre$
BEGIN
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PCOST-A rollback: migration 087 is installed: run as the superuser migration runner';
    END IF;
    IF EXISTS (SELECT 1 FROM recovery_guard.snapshot g
                WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = g.relid)
                   OR g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))
       OR EXISTS (SELECT 1 FROM recovery_guard.functions f
                   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f.fnid AND p.oid::regprocedure::text = f.fn
                                       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')))
       OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                    AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%')
                    AND p.oid NOT IN (SELECT fnid FROM recovery_guard.functions)) THEN
      RAISE EXCEPTION 'PCOST-A rollback: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
  END IF;
END $r_pre$;

DROP TRIGGER IF EXISTS zzc_cost_redirect ON public.products;
DROP TRIGGER IF EXISTS zzc_cost_redirect ON public.product_units;
DROP TRIGGER IF EXISTS zzc_cost_redirect ON public.sale_items;
DROP TRIGGER IF EXISTS zzc_cost_po_unit_price ON public.purchase_order_items;

DO $r_copy$
DECLARE v_n bigint; v_m bigint;
BEGIN
  IF to_regclass('public.product_costs') IS NOT NULL THEN
    UPDATE public.products p SET cost_mmk = c.cost_mmk FROM public.product_costs c WHERE c.product_id = p.id;
    SELECT count(*) INTO v_n FROM public.product_costs;
    SELECT count(*) INTO v_m FROM public.products p JOIN public.product_costs c ON c.product_id = p.id AND p.cost_mmk = c.cost_mmk;
    IF v_n <> v_m THEN RAISE EXCEPTION 'PCOST-A rollback: product cost copy-back mismatch (% vs %)', v_n, v_m; END IF;
  END IF;
  IF to_regclass('public.product_unit_costs') IS NOT NULL THEN
    UPDATE public.product_units u SET purchase_price_mmk = c.purchase_price_mmk FROM public.product_unit_costs c WHERE c.product_unit_id = u.id;
    SELECT count(*) INTO v_n FROM public.product_unit_costs;
    SELECT count(*) INTO v_m FROM public.product_units u JOIN public.product_unit_costs c ON c.product_unit_id = u.id AND u.purchase_price_mmk = c.purchase_price_mmk;
    IF v_n <> v_m THEN RAISE EXCEPTION 'PCOST-A rollback: unit purchase price copy-back mismatch (% vs %)', v_n, v_m; END IF;
  END IF;
  IF to_regclass('public.sale_item_costs') IS NOT NULL THEN
    UPDATE public.sale_items si SET unit_cost_mmk_snapshot = c.unit_cost_mmk FROM public.sale_item_costs c WHERE c.sale_item_id = si.id;
    SELECT count(*) INTO v_n FROM public.sale_item_costs;
    SELECT count(*) INTO v_m FROM public.sale_items si JOIN public.sale_item_costs c ON c.sale_item_id = si.id AND si.unit_cost_mmk_snapshot = c.unit_cost_mmk;
    IF v_n <> v_m THEN RAISE EXCEPTION 'PCOST-A rollback: sale line cost copy-back mismatch (% vs %)', v_n, v_m; END IF;
  END IF;
END $r_copy$;

DROP FUNCTION IF EXISTS public.cost_redirect_products();
DROP FUNCTION IF EXISTS public.cost_redirect_product_units();
DROP FUNCTION IF EXISTS public.cost_redirect_sale_items();
DROP FUNCTION IF EXISTS public.cost_fill_po_unit_price();
DROP FUNCTION IF EXISTS public.cost_write_allowed();
DROP TABLE IF EXISTS public.sale_item_costs;
DROP TABLE IF EXISTS public.product_unit_costs;
DROP TABLE IF EXISTS public.product_costs;

DO $r_post$ BEGIN
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF;
END $r_post$;
NOTIFY pgrst, 'reload schema';
RESET lock_timeout;
RESET search_path;
