-- dr-restore-fixups.sql — run as supabase_admin right after a LOGICAL restore (README "Restore manually" §A),
-- before dr-verify-restore.sh and before the API is reopened. Idempotent.
--
-- A logical restore comes back WITHOUT the USAGE grants on the schemas `graphql` and `graphql_public`
-- (found by the DR drill, deploy/lucashome/backup/tests/dr, 2026-10-18: the dump carries no schema ACL
-- for them; cause unverified — likely the image's init grants are recorded as initial privileges, which
-- pg_dump treats as the default). PostgREST serves graphql_public on this stack. A physical restore
-- (base backup / PITR) is not affected. dr-financial-checks.sql reports the grants if this step is skipped.
\set ON_ERROR_STOP 1
GRANT USAGE ON SCHEMA graphql, graphql_public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA graphql, graphql_public TO postgres WITH GRANT OPTION;
