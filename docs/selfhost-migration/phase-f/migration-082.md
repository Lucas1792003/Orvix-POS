# Phase F · Migration 082: close the "link any auth account" path

Date: 2026-10-14. Branch `feature/selfhost-supabase-migration` (local, not
pushed). **Nothing deployed**: no migration applied, no function synced, no
restart. Hosted Supabase untouched. Server inspection was read-only
(counts / booleans / ids only).

Files:

| File | Change |
|---|---|
| `supabase/migrations/082_close_auth_id_linking.sql` | new (sha256 `c4613aa38b64c67b88588f01e78b8573511cf1473f7ca85343f6af6fbc1621cc`) |
| `supabase/functions/staff-admin/index.ts` | `createUser` sets `app_metadata {created_via: "staff-admin", org_id: <caller org>}`; a `42501` from `create_app_user` → 403 `link_refused` (compensated, generic) |
| `supabase/tests/functions/staff_admin_test.ts` | mock DB emulates 082; +3 tests; createUser body / bootstrap body assertions |
| `supabase/tests/phase-d/sql/t18_auth_link.sql`, `t18_auth_link_b.sql`, `t18_bootstrap.sql`, `run.sh`, `00_prep.sql`, `README.md` | new t18 assertions; `auth.mfa_factors` + `auth.jwt()` shims for the bare image |
| `src/live/liveHelpers.ts`, `src/live/phase-d.live.test.ts`, `src/live/phase-g.org-isolation.live.test.ts` | live suites that call `create_app_user` directly now create marked accounts and a consumed admin code (otherwise they would fail after 082) |

## 1. Audit — every path that can write `users.auth_id`

Sources: `grep` over `supabase/migrations/*.sql`, `supabase/functions`,
`src/`, plus the live catalog (`pg_proc`, `pg_trigger`, `pg_policies`, table
grants) on the self-hosted stack.

| # | Path | Who | Before 082 | After 082 |
|---|---|---|---|---|
| 1 | `create_app_user(..., p_auth_id, ...)` (049 → 063 → 066 → 070), SECURITY DEFINER, EXECUTE authenticated + service_role | anyone with `user:create` (ADMIN; MANAGER if granted) | **inserted any `p_auth_id`** — orphan sign-up account, another org's user (blocked only by the unique index if already linked), a platform admin's login, an old QA account | only a fresh staff-admin account of the caller's org, verified caller (§2.1) |
| 2 | direct `INSERT INTO users (…, auth_id)` — policy `users_ins` `app_has_perm('user:create') AND org_id = app_org_id()` (076); 065 table grant INSERT to authenticated | same | **any `auth_id`** in a row of the caller's org | refused: `AUTH_ID_READ_ONLY` (AFTER trigger) |
| 3 | direct `UPDATE users SET auth_id` — policy `users_upd` `app_has_perm('user:update') AND org_id = app_org_id()`; 065 table grant UPDATE | ADMIN (`user:update`) | **re-link / unlink any row of the org** to any account | refused: `AUTH_ID_READ_ONLY` |
| 4 | client self-heal in `src/stores/authStore.ts resolveAppUser()` (`update({auth_id}).is("auth_id", null)` for an email-matched unlinked row) | the signed-in person | already dead under RLS (an unlinked caller has no `app_org_id()` / `user:update`); logs an error | refused by the trigger as well; behaviour unchanged (error logged, login continues as "no profile") |
| 5 | `bootstrap_first_admin()` (076), SECURITY DEFINER | first operator, only while `app_setup_needed()` | links `auth.uid()` (own account) | **unchanged** (runs as owner; t12 + t18 prove it) |
| 6 | `platform-console` `create_organization` (service role REST insert) | platform admin via Edge Function | links the account it just created | **unchanged** (service_role trusted, as in 073) |
| 7 | `update_app_user`, `deactivate_app_user`, `replace_manager` | ADMIN | never touch `auth_id` | unchanged |
| 8 | FK `users_auth_id_fkey … ON DELETE SET NULL` | GoTrue deleting an auth user | sets NULL | unchanged (RI action runs as the table owner, not `authenticated`) |
| 9 | 001 / 010 email backfills, 002 / 014 / 059 one-off UPDATEs | migration runner | historical one-offs | not re-run |

`anon` has table INSERT/UPDATE grants on `users` (065 hosted parity) but no
policy, so RLS refuses it; the trigger also covers it. `DELETE` has no
policy for clients. No other function in `pg_proc` writes `public.users`
(live triggers on `users`: `trg_enforce_user_assignment_rules`,
`users_guard_privilege_columns`).

Why not a column-level `REVOKE UPDATE (auth_id)`: `authenticated` holds
table-level INSERT/UPDATE on `users`; a column REVOKE is a no-op under a
table grant, and replacing the table grant with a column list would break
the 065 hosted-grant parity check (`t01`, `hosted-grants.txt`). A trigger
gives the same guarantee without touching the grant inventory.

## 2. Design

### 2.1 `create_app_user` (same signature, grants, idempotency, audit)

Order is unchanged up to the permission check (`auth.uid()` → active
caller row → `app_require_org('shop')` → idempotency gate → `user:create`
→ id/name). Then, **only when `p_auth_id IS NOT NULL`**:

**a. Caller assurance** — identical to staff-admin step 3 and the app's
admin gate, never weaker:

* caller has a verified TOTP factor (`auth.mfa_factors`, `factor_type =
  totp`, `status = verified`) → JWT `aal` must be `aal2` → else
  `MFA_REQUIRED` (42501);
* else, caller is ADMIN → there must be an `admin_login_codes` row of
  `auth.uid()` with `consumed_at ≥ to_timestamp(min(amr[].timestamp))`,
  i.e. the emailed code was entered after this session signed in; a JWT
  without `amr` fails closed → else `VERIFICATION_REQUIRED` (42501);
* else (non-ADMIN granted `user:create`, no TOTP) → nothing extra, as in the
  app and staff-admin.

**b. Target account** — all must hold, one message for every failure
(`AUTH_ACCOUNT_NOT_LINKABLE`, 42501; no cross-org oracle):

* exists in `auth.users`;
* `raw_app_meta_data.created_via = 'staff-admin'` **and**
  `raw_app_meta_data.org_id = caller's org`. `app_metadata` can only be
  written with the service role (GoTrue `PUT /user` edits `user_metadata`
  only), so the account holder cannot forge it; only staff-admin (and
  platform-console / operators, both already service-role trusted) can;
* `last_sign_in_at IS NULL` (never used);
* `created_at ≥ now() − 15 min` (staff-admin calls the RPC within
  milliseconds; an orphan left by a failed compensation cannot be adopted
  later);
* `lower(trim(email)) = lower(trim(p_email))`;
* not linked to any `users` row (any org), not in `platform_admins`, not
  `auth.uid()`.

A NULL `p_auth_id` still creates an **unlinked** profile (t06 relies on it);
after 082 nobody but the service role can ever link such a row, so it grants
nothing.

**c. Direct writes**: `guard_user_privilege_columns()` (047/073) gains one
branch for its new firing as **`users_guard_auth_id` AFTER INSERT OR UPDATE
FOR EACH ROW**: when `current_user` is `anon` or `authenticated` and the
statement sets `auth_id` (INSERT) or changes it (UPDATE, incl. to NULL) →
`AUTH_ID_READ_ONLY` (42501). AFTER, so RLS `WITH CHECK`, the BEFORE guards
and constraints keep reporting first exactly as before (every existing
assertion message unchanged). Inside SECURITY DEFINER RPCs `current_user` is
the owner (`supabase_admin` / `postgres`), so `create_app_user` and
`bootstrap_first_admin` keep working; the service role is trusted (073).
Reusing the existing function keeps the public function count unchanged.

**d. No existing row is touched.** The file snapshots an md5 of every
`users` row (whole-row text) and the row count at its start (session GUCs)
and its final `DO` block raises if either differs — the whole
single-transaction apply then rolls back. It contains no `UPDATE`/`DELETE`
of data.

Grants: none changed. anon-executable public functions stay **3**
(`app_setup_needed`, the two token-scoped upload RPCs); RPCs with
`p_idempotency_key` stay **30**; `create_app_user` EXECUTE authenticated +
service_role only.

### 2.2 staff-admin

* `createUser({ email, password, email_confirm: true, app_metadata: {
  created_via: "staff-admin", org_id: caller.org_id } })` — org from
  `current_app_user()` (never the body).
* `create_app_user` failing with `42501` (082 refusal: database disagreed
  with the function's own checks) → auth user deleted (compensation) →
  `403 { code: "link_refused" }`, generic text, no DB message.
* `bootstrap_account` is unchanged and sets **no** marker (that account is
  linked only by `bootstrap_first_admin()`).
* The function's own step-3 check stays; the DB now enforces the same rule
  (defence in depth — a caller hitting PostgREST directly gets the same
  answer).

## 3. Test evidence (2026-10-14, local)

| Suite | Result |
|---|---|
| `bash supabase/tests/phase-d/run.sh` (all migrations) | **610 assertions, 0 failed**, 0 findings (564 baseline + 46 new t18) |
| `POS_TEST_MAX_MIGRATION=081 … run.sh` | **564 / 0** (t18 skipped; shims inert) |
| `bash supabase/tests/functions/run.sh` | **64 passed / 0 failed** (61 + 3) |
| `npx tsc -b` | clean |
| `npx vitest run --exclude '.claude/**'` | **884 passed**, 63 skipped (unchanged) |

t18 (46): admin (email-code verified) links a fresh staff-admin account ✓,
replay identical ✓; refused: already-linked fresh account, seeded cashier's
account, other org's ADMIN account, account marked for the other org, fresh
orphan without marker, old t10 orphan, old signed-in account (even marked),
fresh but signed-in, marked but > 15 min old, platform admin, wrong email,
own account, non-existent id; cross-org shop → "Shop not found"; refused
calls leave no row / audit; email-2FA ADMIN with the code consumed before
the session / without `amr` → `VERIFICATION_REQUIRED`; NULL `p_auth_id`
still OK; TOTP ADMIN aal1 → `MFA_REQUIRED`, aal2 → OK; aal2 ADMIN of org-two
cannot link an org-test account; cashier / manager without permission /
orphan / anon refused; direct `UPDATE … SET auth_id` (re-link, unlink),
direct `INSERT` with `auth_id` → `AUTH_ID_READ_ONLY`; positive controls
(other-column UPDATE, unlinked INSERT); cashier / anon touch nothing;
service_role can still set `auth_id`; seeded links intact; inventory (3 anon
functions, 30 keyed RPCs, SECURITY DEFINER, trigger shape); part B after
**re-applying 082 to the populated database**: every `users` row
byte-identical (21 rows), links identical, one trigger; `t18_bootstrap`
after the t12 concurrent bootstrap: first ADMIN linked to its own account,
and it cannot re-link directly.

Live suites (prepared, **not run**): `src/live/phase-d.live.test.ts` #11 and
`phase-g.org-isolation.live.test.ts` org-B staff now create marked accounts
and insert a consumed admin code for the QA admin (service role), the state
staff-admin leaves; `phase-f-staff.live.test.ts` goes through staff-admin.

## 4. Live inventory (read-only, 2026-10-14)

| Item | Value |
|---|---|
| schema version | 081 |
| `public.users` rows / linked / unlinked / active | 3 / 3 / 0 / 3 (1 ADMIN, 1 MANAGER, 1 CASHIER, one org) |
| `auth.users` | 10 |
| platform admins | 0 |
| links to a platform admin / email mismatch / auth created > 1 day before the row / after the row / never signed in | 0 / 0 / 0 / 0 / 0 |
| accounts with `app_metadata.org_id` | 0 |
| ADMINs with verified TOTP | 1 of 1 |
| `USER_CREATED` audit rows | 0 (no staff created via staff-admin yet) |
| deployed staff-admin | = afab6cc version (no marker); `DISABLE_SIGNUP=true` |

**No existing link violates anything** — 082 never re-checks existing rows,
and none of the three links looks suspicious.

**For owner review:** 7 **orphan auth accounts** (no `users` row, not
platform admins), all confirmed and all signed in at least once — exactly
the accounts the old path could have adopted. Ids (no emails):
`cced48c9-…42e2`, `54352097-…f2b0`, `7ed2a699-…c1b5` (2026-06-10),
`98abaec7-…5090` (06-12), `f73b4d23-…4d10` (06-14), `9b6a2453-…dc6b`,
`af9eccd9-…914f` (08-25). After 082 they can never be linked by a client
(signed in, no marker). Deleting them is a separate owner decision
(GoTrue admin API; `admin_login_codes` / factors cascade).

## 5. Deploy procedure (after owner approval — not done)

Order: **staff-admin first, then 082, in the same window.**

* New staff-admin against the 081 database: the extra `app_metadata` is
  ignored by the old `create_app_user` → staff creation keeps working.
* 082 with the **old** staff-admin: every `create_staff` is refused by the
  DB (no marker) and the function deletes the auth user again — fail closed
  but broken. Hence the function goes first and 082 follows immediately.

Steps (self-hosted stack, stack dir `/srv/supabase/stack`):

1. Pre-checks (read-only): `docker compose ps` healthy;
   `select max(version) from supabase_migrations.schema_migrations` → `081`;
   `select count(*) from public.users` (record);
   `select md5(string_agg(u::text, E'\n' order by u.id)) from public.users u`
   (record, compare in step 6).
2. Function: `rsync -a --delete --exclude .DS_Store supabase/functions/staff-admin/ <host>:/srv/supabase/stack/volumes/functions/staff-admin/`
   (edge runtime picks it up; `docker compose restart functions` only if the
   old code is still served). Smoke: unauthenticated `create_staff` → 401.
3. Dry run: `deploy/lucashome/apply-migrations.sh --from 082 --to 082 --dry-run`.
4. Apply: `deploy/lucashome/apply-migrations.sh --from 082 --to 082`
   (fresh backups + LSN checkpoint, one transaction; expect
   `NOTICE: 082: public.users unchanged (3 rows)`; script checks:
   anon-executable = 3, keyed RPCs = 30).
5. Verify: `select prosrc like '%AUTH_ACCOUNT_NOT_LINKABLE%' from pg_proc where proname='create_app_user'` → t;
   `select tgname from pg_trigger where tgrelid='public.users'::regclass and tgname='users_guard_auth_id'` → 1 row.
6. Users digest/count equal to step 1. Owner logs in (password + TOTP);
   creates a throwaway CASHIER on the Users page (TOTP → aal2), signs in as
   it, deactivates it — or runs `src/live/phase-f-staff.live.test.ts`
   (expects `CLEAN`).
7. Record in `docs/lucashome-selfhost/status.md`.

## 6. Rollback

* Database: in one transaction re-run the `create_app_user` block of
  `070_org_isolation_rpc_guards.sql` (incl. its REVOKE/GRANT) and the
  function block of `073_user_guard_service_role.sql`, then
  `DROP TRIGGER IF EXISTS users_guard_auth_id ON public.users;` and
  `delete from supabase_migrations.schema_migrations where version='082'`.
  No data to restore (082 wrote none). Or PITR to the step-4 checkpoint.
* Function: leaving the new staff-admin in place is harmless with the old
  database (marker ignored); re-sync the afab6cc version only if wanted.

## 7. Compatibility

* **v1.0.15** targets **hosted**; 082 is not applied there. Its Users page
  (signUp + `create_app_user` with the new account) would be refused by 082
  — another reason it must never point at the self-hosted stack (it does
  not; build-time host pinning, Phase G).
* **Feature builds** create staff only through staff-admin; they need the
  new staff-admin on whatever backend has 082. Login, edits
  (`update_app_user`), deactivation, manager replacement, first-time setup
  (`bootstrap_first_admin`) and platform-console org creation are unchanged.
* A MANAGER granted `user:create` without TOTP: unchanged (no extra factor,
  as in the app).

## 8. Risks / residuals

* The 15-minute window is wall-clock on the database; staff-admin calls the
  RPC immediately, so only extreme latency would trip it (fails closed,
  compensated).
* A service-role holder can still link anything — by design (console,
  operators); the service key stays server-side.
* Email-2FA residual unchanged from staff-admin: a code consumed by the same
  person on another device after this session's sign-in counts.
* `aal`/`amr` are read from the PostgREST-verified JWT (`auth.jwt()`); a
  GoTrue change to `amr` shape would make the email-2FA branch fail closed,
  not open.
