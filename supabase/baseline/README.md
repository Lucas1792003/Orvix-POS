# Database baseline and the two supported install paths

`supabase/schema.sql` is a pre-`050` snapshot kept for history. It **cannot
rebuild production**: migrations `001`–`061` were applied over years by hand,
by `supabase db push`, and by the SQL editor, and the production function
bodies now differ from several migration files (see
`docs/selfhost-migration/phase-d/migrations-reconciliation.md`). Do not try to
replay `schema.sql` + `001`–`061` to create a new environment.

There are exactly two supported ways to arrive at a correct schema.

## (a) Upgrade an existing install

Applies to hosted production and to any self-hosted database that was
restored from a production dump.

1. Find the last applied migration (`supabase migration list`, or the
   `supabase_migrations.schema_migrations` table, or the `baseline-migration-
   level` header of the baseline you restored from).
2. Apply every file in `supabase/migrations/` with a number **greater** than
   that, in numeric order, as role `postgres` (what `supabase db push` and the
   runbook's `psql -U postgres -v ON_ERROR_STOP=1 -f` both do).
3. Each Phase D migration (`062`–`066`) is idempotent and carries a
   "Verification" query in its header; run it after applying.

## (b) Fresh install

A new self-hosted environment (or a disaster-recovery rebuild without a full
data restore).

1. Start the platform stack first (`supabase/postgres` image, GoTrue, Storage,
   Realtime). GoTrue creates `auth.users` on first boot; the application
   schema has foreign keys to it (`users.auth_id`, `admin_login_codes`,
   `platform_admins`) and the restore fails without it. The image ships the
   platform roles (`anon`, `authenticated`, `service_role`, `postgres`,
   `supabase_admin`) and the `supabase_realtime` publication.
2. Restore `supabase/baseline/schema-baseline.sql` as a superuser
   (`supabase_admin`) with `ON_ERROR_STOP`:
   `psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f supabase/baseline/schema-baseline.sql`
   Objects end up owned by `postgres` (the dump carries `ALTER ... OWNER TO
   postgres`).
3. Apply every migration numbered **above** the baseline's
   `baseline-migration-level` header, in order, as `postgres` (path (a) step 2).
   The Phase D migrations are written to be correct on a fresh install as well:
   `064` resets function EXECUTE and `065` resets table grants regardless of
   which role's default ACL the restore picked up (verified in the harness,
   which restores as `supabase_admin` on purpose).
4. Run `supabase/tests/phase-d/run.sh` with `BASELINE_SQL` pointing at the
   baseline you restored to prove the result (synthetic data, throwaway
   container).
5. Runbook item that no migration can do for you: as `supabase_admin`,
   `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE
   EXECUTE ON FUNCTIONS FROM anon, PUBLIC;` (the image's default ACL for that
   role grants `anon`; `064` only controls role `postgres`'s and logs a
   NOTICE when it cannot alter `supabase_admin`'s).

## Producing `schema-baseline.sql`

`make_baseline.sh` wraps the exact `pg_dump --schema-only` command (app
schema only, Supabase-internal schemas excluded, secret-pattern check, pg_dump
17.6 `\restrict` guards stripped) and stamps the migration level into the
header:

```sh
BASELINE_DB_URL='postgresql://postgres:***@HOST:5432/postgres' \
  ./supabase/baseline/make_baseline.sh --level 066
```

Take it from a database that is **known good**: production after the Phase D
migrations are applied and verified, or the rehearsal database once it has
passed the harness. The script never runs on its own and refuses to run
without an explicit URL. Review the diff against the previous baseline, run
the harness against it, then commit the file - it is schema only, contains no
rows and no secrets, and is what path (b) depends on.

The raw export under `<workspace>/<timestamp>/` is **not** committed;
it is the evidence snapshot, not the baseline.
