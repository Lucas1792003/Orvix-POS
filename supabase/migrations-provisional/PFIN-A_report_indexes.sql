-- ============================================================
-- PROVISIONAL migration PFIN-A: indexes for server financial reports and
-- shift close (no number assigned; see README.md in this folder)
--
-- WHY
--   sales has no index on created_at or shift_id: close_shift (070) and any
--   ranged report scan the whole table; refund_void_requests has no index on
--   sale_id (every refund approval scans every request); the approval-time
--   evidence (audit_logs REFUND / VOID_SALE rows) has no index at all.
--
-- 087 INTERACTION
--   sales, refund_void_requests and audit_logs are 087-guarded tables: their
--   index lists are part of the guard fingerprint. When 087 is installed this
--   file must run as the superuser migration runner, refuses to run if any
--   guarded table ALREADY differs from its snapshot (it never blesses
--   unexplained drift), and re-registers the snapshot at the end.
--
-- LOCKING
--   Plain CREATE INDEX inside the runner's single transaction: every SHARE
--   lock is held until COMMIT, so writes to sales / refund_void_requests /
--   audit_logs wait for the whole file. Seconds at current shop volumes.
--   Apply this file ALONE (runner --from N --to N), never bundled with other
--   migrations, in a quiet period. (Building the indexes CONCURRENTLY by hand
--   first is not supported: 087's fingerprint would see them as drift.)
--
-- Idempotent. Rollback: PFIN-A.rollback.sql.
-- ============================================================

SET lock_timeout = '3s';
-- every name below is schema-qualified; nothing resolves through the runner's search_path
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pfin_pfin_a_pre$
DECLARE v_path text := current_setting('search_path');
BEGIN
  -- a failed CREATE INDEX CONCURRENTLY leaves an INVALID index of the same name that IF NOT EXISTS would skip
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relnamespace = 'public'::regnamespace AND NOT i.indisvalid
                AND c.relname IN ('sales_shop_created_idx', 'sales_shift_idx', 'refund_void_requests_sale_idx',
                                  'audit_logs_fin_approval_entity_idx', 'audit_logs_fin_approval_time_idx')) THEN
    RAISE EXCEPTION 'PFIN-A: an INVALID index with a PFIN-A name exists (failed concurrent build): drop it first';
  END IF;
  IF to_regnamespace('recovery_guard') IS NOT NULL THEN
    -- evaluate exactly as recovery_guard.ddl_guard does (regprocedure text depends on search_path)
    PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      RAISE EXCEPTION 'PFIN-A: migration 087 is installed: run as the superuser migration runner';
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
      RAISE EXCEPTION 'PFIN-A: guarded tables or the 087 function registry already differ from the 087 snapshot; refusing to re-register over unexplained drift';
    END IF;
    PERFORM set_config('search_path', v_path, true);
  END IF;
END $pfin_pfin_a_pre$;

-- ranged reports by shop and business day
CREATE INDEX IF NOT EXISTS sales_shop_created_idx ON public.sales (shop_id, created_at);
-- close_shift and fin_shift_reconciliation (sales of one shift)
CREATE INDEX IF NOT EXISTS sales_shift_idx ON public.sales (shift_id);
-- refund caps in approve_refund_request, pending/approved refunds of a sale
CREATE INDEX IF NOT EXISTS refund_void_requests_sale_idx ON public.refund_void_requests (sale_id);
-- approval-time evidence: by entity (request id / sale id) ...
CREATE INDEX IF NOT EXISTS audit_logs_fin_approval_entity_idx ON public.audit_logs (entity_id)
  WHERE action_type IN ('REFUND', 'VOID_SALE');
-- ... and by shop and time (approval-date reports, shift windows)
CREATE INDEX IF NOT EXISTS audit_logs_fin_approval_time_idx ON public.audit_logs (shop_id, created_at)
  WHERE action_type IN ('REFUND', 'VOID_SALE');

-- IF NOT EXISTS only checks the name: refuse a same-named index with another definition
-- (it would otherwise be registered into 087's snapshot as if it were PFIN-A's)
DO $pfin_a_defs$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.name, ', ') INTO v_bad
    FROM (VALUES
      ('sales_shop_created_idx', 'CREATE INDEX sales_shop_created_idx ON public.sales USING btree (shop_id, created_at)'),
      ('sales_shift_idx', 'CREATE INDEX sales_shift_idx ON public.sales USING btree (shift_id)'),
      ('refund_void_requests_sale_idx', 'CREATE INDEX refund_void_requests_sale_idx ON public.refund_void_requests USING btree (sale_id)'),
      ('audit_logs_fin_approval_entity_idx', 'CREATE INDEX audit_logs_fin_approval_entity_idx ON public.audit_logs USING btree (entity_id) WHERE (action_type = ANY (ARRAY[''REFUND''::text, ''VOID_SALE''::text]))'),
      ('audit_logs_fin_approval_time_idx', 'CREATE INDEX audit_logs_fin_approval_time_idx ON public.audit_logs USING btree (shop_id, created_at) WHERE (action_type = ANY (ARRAY[''REFUND''::text, ''VOID_SALE''::text]))')
    ) AS e(name, def)
   WHERE pg_catalog.pg_get_indexdef(pg_catalog.to_regclass('public.' || e.name)) IS DISTINCT FROM e.def;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PFIN-A: index(es) % exist with a different definition than PFIN-A creates', v_bad;
  END IF;
END $pfin_a_defs$;

DO $pfin_a_post$
BEGIN
  IF to_regprocedure('recovery_guard.register_guards()') IS NOT NULL THEN
    PERFORM recovery_guard.register_guards();
  END IF;
END $pfin_a_post$;

RESET lock_timeout;
RESET search_path;
