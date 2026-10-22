-- Rollback of provisional PFIN-C (triggers + function; no data). With 087 installed: superuser session,
-- and only when nothing else has drifted from the 087 snapshot.
SET lock_timeout = '3s';
DO $pfin_pfin_c_rb_pre$
DECLARE v_path text := current_setting('search_path');
BEGIN
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    -- evaluate exactly as recovery_guard.ddl_guard does (regprocedure text depends on search_path)
    PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PFIN-C-RB: migration 087 is installed: run as the superuser migration runner';
    END IF;
    -- the whole 087 backstop condition (recovery_guard.ddl_guard): register_guards() below re-blesses
    -- tables AND the public 087 function registry, so neither may already differ from the snapshot
    IF EXISTS (SELECT 1 FROM recovery_guard.snapshot g
                WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = g.relid)
                   OR g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))
       OR EXISTS (SELECT 1 FROM recovery_guard.functions f
                   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = f.fnid AND p.oid::regprocedure::text = f.fn
                                       AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'recovery_owner')))
       OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                    AND (p.proname LIKE '%\_v87' OR p.proname LIKE 'recovery\_%')
                    AND p.oid NOT IN (SELECT fnid FROM recovery_guard.functions)) THEN
      RAISE EXCEPTION 'PFIN-C-RB: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
    PERFORM set_config('search_path', v_path, true);
  END IF;
END $pfin_pfin_c_rb_pre$;
DROP TRIGGER IF EXISTS fin_guard_refund_net_paid ON public.refund_void_requests;
DROP TRIGGER IF EXISTS fin_guard_refund_net_paid_ins ON public.refund_void_requests;
DROP TRIGGER IF EXISTS fin_guard_refund_net_paid_upd ON public.refund_void_requests;
DROP FUNCTION IF EXISTS public.fin_guard_refund_net_paid();
DO $r$ BEGIN
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN PERFORM recovery_guard.register_guards(); END IF;
END $r$;
RESET lock_timeout;
