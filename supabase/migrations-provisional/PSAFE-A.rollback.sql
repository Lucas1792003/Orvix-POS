-- Rollback of provisional PSAFE-A: removes the guard event trigger and its
-- function. Nothing else changes. WARNING: afterwards a manual superuser
-- re-run of 086 on a database with 087 again silently takes the v87
-- executors away from the tills (see PSAFE-A_no_086_rerun_after_087.sql).
SET lock_timeout = '3s';
DROP EVENT TRIGGER IF EXISTS zz_orvix_no_086_after_087;
DROP FUNCTION IF EXISTS orvix_guard.no_086_after_087();
DROP SCHEMA IF EXISTS orvix_guard;
RESET lock_timeout;
