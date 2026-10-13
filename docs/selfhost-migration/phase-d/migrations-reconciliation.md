# Phase D · Reconciliation of migrations 059–061 against production

Source of truth: the scrubbed production schema snapshot of 2026-10-11
(`<workspace>/<ts>/schema.scrubbed.sql`, pg_dump of the
hosted project, no data). Every object that migrations `059`, `060` and `061`
create or alter was compared with its definition in that snapshot: tables by
columns/defaults/constraints/indexes, functions by body, policies by
expression, grants by ACL. The migration files were not edited.

Legend: **identical** = same definition; **differs** = what and why.

## 059_organizations_foundation.sql

| Object | Result | Detail |
|---|---|---|
| table `organizations` | identical | `id text PK`, `name text NOT NULL`, `is_active boolean NOT NULL DEFAULT true`, `created_at timestamptz NOT NULL DEFAULT now()`; PK `organizations_pkey`. |
| seed row `org-shwe-pha-lar` | present | Data, so not in the schema dump; the scrubbed data dump carries the row. |
| `shops.org_id` | identical | `text NOT NULL`, FK `shops_org_id_fkey → organizations(id)` (no ON DELETE action, as in the migration). |
| `users.org_id` | identical | `text NOT NULL`, FK `users_org_id_fkey → organizations(id)`. |
| index `users_only_one_admin` | identical | `UNIQUE (org_id) WHERE role = 'ADMIN'` — the migration's `DROP INDEX IF EXISTS` + re-create with the org scope is what production has (the pre-059 global form is gone). |
| function `app_org_id()` body | identical | `SELECT org_id FROM users WHERE auth_id = auth.uid() AND is_active = true LIMIT 1;` — `sql STABLE SECURITY DEFINER SET search_path = public`, owner postgres. |
| function `app_org_id()` grants | **differs** | Migration grants EXECUTE to `authenticated` only. Production ACL: `anon`, `authenticated`, `service_role` (and PUBLIC never revoked). Cause: the hosted default ACL for role `postgres` grants ALL ON FUNCTIONS to the three API roles at creation time, so every function gets them whether or not the migration says so. Normalised by migration `064` (anon/PUBLIC revoked, authenticated + service_role explicit). Not a migration-file error. |

Side effect worth knowing: `create_app_user` (migration `049`, body unchanged in
production) inserts into `users` **without** `org_id`, so after `059` made the
column NOT NULL every call to that RPC fails. `059` did not touch the RPC
("No RLS/RPC changes" in its header), which is exactly the gap. Fixed by
migration `066`; found by the Phase D harness, not by inspection.

## 060_organizations_rls.sql

| Object | Result | Detail |
|---|---|---|
| RLS on `organizations` | identical | `relrowsecurity = true`. |
| policy `organizations_sel` | identical | `FOR SELECT TO authenticated USING (true)`. |
| policy `organizations_ins` | identical | `FOR INSERT TO authenticated WITH CHECK (app_has_perm('user:create') OR NOT EXISTS (SELECT 1 FROM users))`. |
| UPDATE / DELETE policies | identical | none in either (default deny), as the migration intends. |
| table grants | note | Production: `anon`, `authenticated`, `service_role` all hold full table privileges (default ACL); RLS is what denies. Pinned as-is by `065` for parity. |

## 061_platform_admins.sql

| Object | Result | Detail |
|---|---|---|
| table `platform_admins` | identical | `id uuid PK DEFAULT gen_random_uuid()`, `auth_id uuid NOT NULL UNIQUE` (`platform_admins_auth_id_key`) FK `→ auth.users(id) ON DELETE CASCADE`, `name text NOT NULL`, `email text NOT NULL`, `is_active boolean NOT NULL DEFAULT true`, `created_at timestamptz NOT NULL DEFAULT now()`. |
| RLS | identical | enabled, zero policies. |
| grants | identical | `service_role` only (`REVOKE ALL FROM anon, authenticated` took effect; the dump shows no anon/authenticated ACL entry). |

## Beyond 059–061 (observed while extracting bodies for 063)

Not part of the brief's reconciliation scope but recorded because they
influence what "current" means:

- The 2026-10-11 snapshot lists 58 public functions, 45 of them
  `SECURITY DEFINER`, 31 tables + 1 view, 58 policies (the audit doc says 59;
  the dump has 58 `CREATE POLICY` statements), 0 sequences.
- `complete_stock_transfer`: EXECUTE for `authenticated` revoked (`052`), but
  `anon` and PUBLIC still had it — closed by `064`.
- Two token-authenticated phone-upload RPCs
  (`get_product_image_upload_session_by_token`,
  `complete_product_image_upload_session`) are granted to `anon` by design
  (`019`); `064` keeps exactly those two.
- All function ACLs in production include `anon` via the default ACL, matching
  §1 of the production-dependencies audit (private ops notes).
- The migration-tracking table (`supabase_migrations.schema_migrations`) is not
  in the public-schema dump; the migration level of the snapshot is inferred as
  `061` from the objects present (all of 059–061 are there, nothing newer).

## Method

Function bodies: extracted from the dump with the same line-based parser that
generated `063` and compared with the migration file text after normalising
quoting (`"public"."x"` vs `x`) and `SET search_path` spelling. Tables:
column list, types, NOT NULL, defaults, constraints and indexes read from the
`CREATE TABLE` / `ALTER TABLE ... ADD CONSTRAINT` / `CREATE INDEX` statements.
Policies: `CREATE POLICY` statements. Grants: the dump's `GRANT`/`REVOKE`
section plus `hosted-grants.txt` (92 table-grant rows, fingerprint
`1b502454…`).
