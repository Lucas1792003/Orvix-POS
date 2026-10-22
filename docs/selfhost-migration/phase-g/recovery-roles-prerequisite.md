# Recovery roles — host prerequisite of migration 087 (v87.x)

Status: **prepared, not applied anywhere real.** Verified on disposable test stacks only (2026-10-19). Nothing here has
been run on `lucashome`; the owner applies it with the deployment checklist below.

## Why

On the Supabase database image, the `supautils` extension makes `postgres` (through `supabase_privileged_role`) a
privileged role. It can `ALTER` **any role that is not listed in `supautils.reserved_roles`**, and it can create event
triggers. Measured on `supabase/postgres:17.6.1.136` (the image `lucashome` runs):

- `postgres` gave `recovery_owner` LOGIN and a password and logged in as it — full control of every 087 object.
- An event trigger created by `postgres` ran **as `recovery_owner`** inside the `SET ROLE recovery_owner` DDL that
  migration 087 uses to create its objects.

Both stop when the three 087 roles are reserved: supautils then refuses every change to them by the privileged role
("is a reserved role, only superusers can modify it") and does not run a privileged role's event trigger as them.

| Role | Created by | Login |
|---|---|---|
| `recovery_owner` | 087 | never (owns every 087 object) |
| `recovery_authority` | 087 | yes — the off-host witness authority |
| `recovery_gate` | 087 | yes — the read-only restore gate |
| `recovery_restorer` | proposed by the original 088 only (that design is rejected; 088 is a retired number) | never created |
| `orvix_recovery_operator` | Recovery V1 installer (provisional) | never; **must be listed in `supautils.reserved_roles` before V1 is installed** (the installer refuses otherwise when supautils is loaded): it holds EXECUTE on `recovery_v1.fence_key` |

## What 087 now checks (fail closed)

`supabase/migrations/087_recovery_hold.sql` refuses to install, applying nothing, unless all of these hold. Before any
other statement it takes `pg_event_trigger` EXCLUSIVE (no event trigger can be created during the transaction) and pins
`search_path = pg_catalog, pg_temp` (functions or operators planted in `public` / `extensions` are never resolved, in the
checks either). It then **disables every existing event trigger** for the transaction and re-enables each with its own mode
at the end, so no event-trigger code (nor anything it calls) runs as `recovery_owner` inside the `SET ROLE` DDL.

1. supautils present (loaded, or either of its settings defined): `supautils.privileged_role` readable, and
   `supautils.reserved_roles` lists `recovery_owner`, `recovery_authority`, `recovery_gate` exactly (a `*` suffix does not
   count).
2. No event trigger owned by, or running a function owned by, a non-superuser.
3. Every public table 087 reads or guards is a plain table (not swapped for a view).
4. The recovery roles do not exist — or exist only as the roles of a rolled-back 087: a schema with the rollback's exact
   name (`recovery_archived_087_YYYYMMDDtHHMMSS`) owned by `recovery_owner`, holding only the **kinds** of objects the
   rollback leaves (an allow-list, measured on a real rollback). Allowed: schema privileges of the owner plus `USAGE` (no
   grant option) for `authenticated`, `recovery_authority`, `recovery_gate`; **all** 22 tables of 087 and no other table;
   sequences owned by a column of them; indexes on them; their row / array types — all owned by `recovery_owner`,
   permanent, not partitions, with no table, sequence or column privilege for any other role (superusers and the other
   recovery roles included) and no type privilege beyond PostgreSQL's default `PUBLIC USAGE`; primary-key, unique, check
   and not-null constraints; dependencies of its objects only on objects of the same archive (no default, check, index
   expression, column type, collation or access method reaching outside it). Anything else refuses: any other object in
   the schema (function, view, materialized view, extra table or sequence, domain / enum / composite type, operator,
   collation, text-search object, extension, statistics), any trigger, rule, policy, inheritance, publication or
   subscription on its tables, any default privilege in it, a dependency of the schema itself (extension membership), an
   archive missing one of the 087 tables, and any other schema with the `recovery_archived_087_` prefix. Roles that do not
   match this (no such archive, or `recovery_owner` without `BYPASSRLS`, as 087 creates it) are refused (a superuser drops
   them after checking what they own). The check proves the archive and roles are **harmless and shaped like a
   rollback's**, not who created them: item 5 normalises the roles either way.
5. `recovery_owner` has no login, no password, no elevated attribute; no recovery role has per-role settings, superuser /
   CREATEROLE / CREATEDB / REPLICATION / INHERIT, a membership in another role, or a non-superuser member; nothing is owned
   by, granted to, or default-granted for a recovery role outside a rolled-back 087 archive (`pg_shdepend`, every database).
6. `recovery_authority` / `recovery_gate` are normalised (no elevated attributes) and **their passwords cleared**: the owner
   provisions the logins after installing (also after a re-install).
7. An **active probe** passes: as the supautils privileged role, each of its members and every non-superuser with
   CREATEROLE, the migration tries to `ALTER`, `ALTER … SET`, `RENAME` and `DROP` each recovery role and to `GRANT` it to
   itself, each in a rolled-back subtransaction — any success stops the migration. (`SET ROLE` cannot be probed this way:
   PostgreSQL authorises it against the session user; membership is refused by 5.)

The witness authority (`tools/recovery-authority/authority.py`, with `search_path = pg_catalog, pg_temp`) re-checks on
**every** genesis and tick and refuses — revoking the lease, so the server stops accepting writes — while any fails:
`PREREQ_RECOVERY_ROLES_NOT_RESERVED`, `PREREQ_NON_SUPERUSER_EVENT_TRIGGER`, `PREREQ_RECOVERY_OWNER_CAN_LOG_IN`,
`PREREQ_RECOVERY_ROLE_ELEVATED`, `PREREQ_RECOVERY_ROLE_MEMBERSHIP`, `PREREQ_NON_SUPERUSER_MEMBER`. A restore or PITR into a
container without the configuration therefore stops at the first tick.

## Deployment checklist (owner-approved, BEFORE `apply-migrations.sh --from 086 --to 087`)

1. Copy the reviewed file to the host, next to the WAL-archiving file:
   `deploy/lucashome/db-conf/20-recovery-reserved-roles.conf` →
   `/srv/supabase/stack/volumes/db/custom-conf.d/20-recovery-reserved-roles.conf` (owner root, mode 0644).
2. Check the file's list equals **the image's own** default plus the three roles. Read the default from the image, not
   from the running container (`/etc/postgresql-custom` is a volume that can keep an older image's copy):
   `docker run --rm --entrypoint grep supabase/postgres:<tag> '^supautils.reserved_roles' /etc/postgresql-custom/supautils.conf`.
   Regenerate the file whenever it differs (every image upgrade). Also check that no `ALTER SYSTEM` value overrides it:
   `select count(*) from pg_file_settings where name = 'supautils.reserved_roles' and sourcefile like '%postgresql.auto.conf'`
   must be 0.
3. Add the mount to `deploy/lucashome/docker-compose.override.yml` (db service volumes):
   `- ./volumes/db/custom-conf.d/20-recovery-reserved-roles.conf:/etc/postgresql-custom/conf.d/20-recovery-reserved-roles.conf:ro`
4. Recreate the db container (`docker compose up -d db`; a reload is enough when the file is already mounted:
   `select pg_reload_conf()` as `supabase_admin`).
5. Verify (as `supabase_admin`): `show supautils.reserved_roles;` lists the image's entries and the three roles, none
   with a `*` added; `select sourcefile from pg_file_settings where name = 'supautils.reserved_roles' and applied` names
   `20-recovery-reserved-roles.conf`. Add the file to the DR drill's expected host files.
6. Check (as `supabase_admin`) that none of the three roles and no `recovery_archived_087_*` schema exists yet on the
   server (`lucashome` is at 085: any of them means someone created it — investigate before going on):
   `select rolname from pg_roles where rolname like 'recovery\_%'` and
   `select nspname from pg_namespace where nspname like 'recovery\_archived\_087\_%'` must both return nothing.
7. Apply 087 through the runner as planned. If step 5 was skipped or failed, 087 refuses with
   `087 preflight: supautils.reserved_roles does not list ...` and nothing is applied.

## Fresh install vs an already-installed 087

- **Fresh install (every real server: `lucashome` is at 085):** steps 1–6 above. The corrected 087 is the version that
  gets applied; its checksum is what the ledger records.
- **A database where the earlier 087 text is already recorded (disposable test stacks only — no real server has 087):**
  the runner refuses every later run there, **including `--rollback 087`** (its history check reports the checksum
  mismatch). Do not edit the ledger: re-create the test database. The prerequisite itself takes effect at once with steps
  1–5, and the authority refuses to renew until it holds.
- **Re-install after a rollback of the corrected 087:** the kept roles pass (they own the archive); their passwords are
  cleared, so provision the logins again before genesis.
- **Re-install refused with `a recovery archive schema is not as a 087 rollback leaves it: …`:** some archive changed after
  the rollback (e.g. a grant to read the evidence, an owner change, an added index, trigger or object). The message lists
  every deviation. A superuser investigates how it got there, then **reverts exactly those items** (revoke the grant, drop
  the added object, restore the owner) and re-runs the install. Never drop or rename the archive to get past the check:
  it is the evidence. Export it first (`pg_dump -n <archive>`) if in doubt.

## Remaining trust assumptions

- **Superusers** (`supabase_admin`, anyone with host / container root) can change the configuration, the roles and every
  object. The authority detects the configuration and role changes above within one tick and stops the server's writes;
  it cannot prevent them.
- **`postgres` still owns the business schema** (086's RPCs, the tables): it can change business behaviour. 087's own
  objects and roles are protected; the 086 executor that 087 calls is not (out of scope here).
- **`postgres` can still create event triggers** (supautils). They do not run as the reserved roles; 087 and the
  authority refuse while one exists, so it must be removed by a superuser before 087 is installed or the lease renewed.
  Superuser-owned event triggers (the image's own) are disabled during the 087 transaction; after it they run as whoever
  runs DDL — never inside 087's `SET ROLE` blocks, which only the migration runs.
- **Disposable verification only:** `tools/m087-verify/lib/reserve-recovery-roles.sh` uses `ALTER SYSTEM` on test
  containers (`orvix-migtest-*`, `phf-iso-db`); the conf.d file itself was verified once in a throwaway container
  (`orvix-migtest-v87x-conf`, 2026-10-19). Steps 2 and 5 are the checks on the real host.
- **`supautils.reserved_roles` is replaced wholesale** by the file: an image upgrade that changes the default list needs
  the file regenerated (step 2) or the new image's own entries are lost.
