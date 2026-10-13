-- Phase E: purge ONLY the GoTrue audit entries produced by the QA accounts
-- (payload mentions an @qa.invalid address). Every other audit row is kept.
-- Run AFTER cleanup.sql and BEFORE verify_clean.sql. Prints before/after
-- counts so the run report can quote them.
\set ON_ERROR_STOP on

SELECT 'auth.audit_log_entries before: total=' || count(*)
  || ' qa=' || count(*) FILTER (WHERE payload::text ILIKE '%@qa.invalid%')
  || ' other=' || count(*) FILTER (WHERE payload::text NOT ILIKE '%@qa.invalid%') AS before
FROM auth.audit_log_entries;

BEGIN;
WITH d AS (DELETE FROM auth.audit_log_entries WHERE payload::text ILIKE '%@qa.invalid%' RETURNING 1)
SELECT 'deleted qa audit entries: ' || count(*) AS purged FROM d;
COMMIT;

SELECT 'auth.audit_log_entries after: total=' || count(*)
  || ' qa=' || count(*) FILTER (WHERE payload::text ILIKE '%@qa.invalid%') AS after
FROM auth.audit_log_entries;
