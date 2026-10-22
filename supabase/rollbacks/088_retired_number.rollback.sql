-- ============================================================
-- Rollback of 088 (retired number, no-op tombstone). 088 created nothing, so this only removes 088's own
-- ledger row. That keeps 087 rollback-able: the runner and 087's rollback both refuse while a newer version
-- is recorded. Runs only through deploy/lucashome/apply-migrations.sh --rollback 088
-- --owner-confirmed-till-queues-empty, in the runner's transaction (the same gates as 087's rollback).
-- Never with Recovery V1 installed (the runner refuses every rollback then).
-- ============================================================
DO $rb088$
DECLARE v_n integer;
BEGIN
  IF current_setting('orvix.rollback_gate', true) IS DISTINCT FROM 'till-queues-empty-confirmed-by-owner' THEN
    RAISE EXCEPTION 'rollback preflight: no owner confirmation (run only via apply-migrations.sh --rollback 088 --owner-confirmed-till-queues-empty); nothing changed';
  END IF;
  IF current_setting('orvix.runner_txid', true) IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION 'rollback preflight: not inside the runner''s transaction; nothing changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '088') THEN
    RAISE EXCEPTION 'rollback preflight: 088 is not recorded in supabase_migrations; nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version > '088') THEN
    RAISE EXCEPTION 'rollback preflight: a newer migration is recorded; roll it back first; nothing changed';
  END IF;
  DELETE FROM supabase_migrations.schema_migrations WHERE version = '088';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'rollback post-check: expected to remove exactly one 088 ledger row, removed %', v_n; END IF;
  RAISE NOTICE '088 (retired number) rolled back: its ledger row removed; nothing else existed';
END $rb088$;
