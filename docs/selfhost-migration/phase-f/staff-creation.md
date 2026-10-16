# Phase F · Server-side staff creation, public sign-up OFF

Date: 2026-10-13. Hosted Supabase is untouched by this change.

## 1. Why

The self-hosted stack ran with `DISABLE_SIGNUP=false` only because the app
itself created accounts through GoTrue's **public** sign-up endpoint:

| Where | What it did |
|---|---|
| `src/pages/UsersPage.tsx` | admin → `supabase.auth.signUp()` for the new staff member (browser briefly signed in as them), `setSession()` back to the admin, then `create_app_user()` |
| `src/stores/authStore.ts` `bootstrapFirstAdmin()` (`/setup`) | `signUp()` for the first administrator when sign-in failed |
| `src/live/liveHelpers.ts` `signUpUser()`, `e2e/global-setup.ts`, live suites | QA accounts via `signUp()` |

With sign-up open, **anyone who can reach `/auth/v1/signup` with the anon key
(which ships in every client) can mint a confirmed auth account**
(`ENABLE_EMAIL_AUTOCONFIRM=true`). Such an orphan has no `users` row, so RLS
gives it nothing today, but it is an unauthenticated write into `auth.users`,
an enumeration oracle, and one bug away from a foothold. Every other sign-up
need is administrative, so the endpoint can be closed.

`platform-console` already used the GoTrue admin API (unchanged).

## 2. Design

> **Update 2026-10-14:** migration **082** now exists
> ([migration-082.md](migration-082.md)): `create_app_user()` links only an
> account staff-admin created for the caller's org (`app_metadata` marker,
> never signed in, ≤ 15 min old) from a fully verified caller, and direct
> writes of `users.auth_id` are refused. staff-admin sets the marker at
> `createUser`; deploy both in the same window (procedure in that doc). The
> text below describes the function as first written.

New Edge Function **`supabase/functions/staff-admin`**, two actions. No SQL
change: **no migration 082** — everything it needs already exists
(`current_app_user()`, `app_has_perm()`, `create_app_user()`,
`app_setup_needed()`, `admin_login_codes`, `audit_logs`).

### 2.1 `create_staff` (Users page)

Request (JSON, caller's session JWT as Bearer):
`{ action, name, email, password, role, shopId, idempotencyKey }`. Response
`201 { user }` (the `create_app_user()` jsonb — never the password or a key),
`200 { user, replayed: true }` on a retried key, or `{ error, code }`.

Order — every refusal happens before anything is written:

1. **Authenticate**: `auth.getUser(token)` (GoTrue verifies the signature) →
   401. The JWT payload is decoded only afterwards and `sub` must equal the
   verified user.
2. **Authorize from the database, as the caller** (anon key + caller JWT —
   the same functions RLS uses): `current_app_user()` must return an
   **active** row with an org, and `app_has_perm('user:create')` must be true
   (role defaults ∪ grants − revokes; ADMIN has it, MANAGER only if granted).
   → 403 `forbidden`.
3. **Assurance level — never weaker than the app's admin gate**
   (`authStore`: an ADMIN is verified by TOTP *or* the emailed code):
   * caller has a **verified TOTP factor** (GoTrue admin API
     `GET /admin/users/{id}/factors`) → the JWT must carry `aal: "aal2"` →
     else 403 `mfa_required`;
   * else, caller is **ADMIN** → an `admin_login_codes` row for this auth user
     with `consumed_at ≥` the session's first `amr` timestamp (i.e. the
     emailed code was entered *after this session signed in*) → else 403
     `verification_required`. Fail closed if `amr` is missing;
   * else (non-admin with a granted `user:create`, no TOTP) → nothing extra,
     exactly as in the app (non-admins have no verification step).
4. **Rate limits**: per caller, 30 authorised attempts / 10 min (worker
   memory, best effort) and 20 successful creations / hour (count of the
   caller's `USER_CREATED` audit rows — durable, same pattern as admin-2fa's
   cooldown read). → 429 `rate_limited` + `Retry-After`. Limits are env
   overridable (`STAFF_ADMIN_MAX_ATTEMPTS_PER_10_MIN`,
   `STAFF_ADMIN_MAX_CREATES_PER_HOUR`, `STAFF_ADMIN_MAX_BOOTSTRAP_PER_10_MIN`).
5. **Validation** → 400: name 1–120; email trimmed + lower-cased, ≤ 254,
   shape-checked; password **8–72** characters (GoTrue's default minimum is 6,
   bcrypt truncates past 72 bytes); shop required; idempotency key a UUID.
6. **Role**: `ADMIN` is never creatable (one ADMIN per org — 059/073 — and
   the caller's org already has one). ADMIN may create MANAGER / CASHIER /
   BUYER; a non-ADMIN with `user:create` only CASHIER / BUYER **in their own
   shop**. → 403 `role_not_allowed` / `shop_not_allowed`.
7. **Shop ∈ caller's org** (service-role lookup `shops.id = ? AND org_id =
   caller.org_id`). Foreign and non-existent shops get the same 403.
8. **Retry**: the users id is `user-<idempotency key hex>`. A row with that id
   in the caller's org with the same email/role/shop is returned as a replay
   (200); any other row with that id → 409.
9. **Email uniqueness** across the install (`users.email`, case-insensitive,
   any org) and GoTrue's own `email_exists` → one generic 409
   `email_taken` ("A user with this email already exists.") — no org or
   account-type detail. (An admin necessarily learns that an address is
   taken; auth emails are global.)
10. **Auth account**: `auth.admin.createUser({ email, password,
    email_confirm: true })` with the service role (works with sign-up
    disabled; no confirmation mail).
11. **Users row**: `create_app_user()` **with the caller's JWT**, so every
    existing server rule still applies unchanged: `users_ins` RLS and the
    RPC's `app_has_perm('user:create')`, `app_require_org('shop', …)`, the
    047/073 privilege guard (only an ADMIN may create elevated roles), the 020
    assignment rules (manager/cashier/buyer ↔ shop), the per-org
    `users_only_one_admin` index, org taken from `current_app_user()`, the
    `USER_CREATED` audit row (existing style: `'User <name> (<role>)
    created'`, actor = caller) and the 063/074 idempotency key bound to the
    caller. **On any error the just-created auth user is deleted again**
    (compensation); a failed compensation is logged as `COMPENSATION FAILED:
    orphan auth user <uuid>` (no secret). Business-rule errors (`P0001`,
    `23505`, `23P01`) are returned with their message and `dbCode` so the
    Users form maps them as before (`mapUserFormError`); anything else is a
    generic 500 "Nothing was created".

Logs contain ids, roles and status codes only — never the password, the
caller's token, the service key or the new user's email.

### 2.2 `bootstrap_account` (first-time setup, `/setup`)

Anonymous (anon key as Bearer). Creates **only the auth account** of the first
administrator; the organization + ADMIN row are still created by the client
through `bootstrap_first_admin()` (076) after it signs in — under that
function's install-wide advisory lock and its own `app_setup_needed()`
re-check, unchanged. Guards, all fail closed (503 when a check cannot be
made):

* `app_setup_needed()` must be `true` (no `users` row at all) **and**
  `organizations` must be empty → else 403 `setup_closed`. On any populated
  install the action can never create anything.
* at most 10 auth users may exist (`listUsers`), so an empty install cannot be
  used as an account mint;
* 10 attempts / 10 min per worker; password 8–72; email normalised;
* existing email → 409 ("Use its password").

The client (`bootstrapFirstAdmin`) keeps its order: server says setup needed →
try `signInWithPassword` → only if that fails call `bootstrap_account` → sign
in → re-check → `bootstrap_first_admin()`.

### 2.3 Client

* `src/lib/staffAdmin.ts` — `createStaffAccount()`, `createBootstrapAccount()`
  (`supabase.functions.invoke("staff-admin")`), `StaffAdminError`,
  `STAFF_PASSWORD_MIN/MAX`.
* `shopSlice.createStaffUser()` replaces `addUser()`; `UsersPage` builds the
  request with `features/admin/staffForm.ts` and keeps one idempotency key per
  form state (a retry after a lost response returns the first row). No
  `signUp`, no `setSession`, no client-side users insert.
* `/setup` password minimum 6 → 8 (`setupValidation.ts`); Users form
  placeholder "min 8".
* Guard test `src/test/noPublicSignUp.test.ts` fails the unit suite if
  `auth.signUp(` or `/auth/v1/signup` appears anywhere in `src/`, `e2e/`,
  `electron/` (exempt: the live suite that proves refusal, the hosted-guard
  test).
* Login is unchanged (it never signs up — Phase G).

### 2.4 QA tooling

`liveHelpers.createAuthUser()` / `deleteAuthUser()` use the GoTrue admin API
with the service key (`email_confirm: true`); `signUpUser` is gone; all live
suites (phase-d, g, g2, g3, g4) and `e2e/global-setup.ts` switched. E2E A6
finds the created staff row by email (the id is now `user-<32 hex>`).

## 3. Threat model

| Threat | Mitigation |
|---|---|
| Anonymous account minting via `/signup` | `DISABLE_SIGNUP=true`; app no longer needs it |
| Anonymous minting via `bootstrap_account` | only while `users` AND `organizations` are empty, ≤ 10 auth users, rate-limited; closed forever after setup |
| Cashier/manager creates accounts | `app_has_perm('user:create')` evaluated by the DB as the caller; RPC re-checks |
| Privilege escalation (create ADMIN / MANAGER) | ADMIN never creatable; non-ADMIN limited to CASHIER/BUYER in own shop; 047/073 guard + per-org admin index behind it |
| Cross-org staff / foreign shop | org derived server-side (body `orgId` ignored); shop must be in caller's org; `app_require_org` in the RPC |
| Stolen aal1 token of a TOTP admin | `aal2` required when a verified factor exists |
| Stolen password-only session of an email-2FA admin | a code consumed after that session's sign-in is required |
| Deactivated caller with a live JWT | `current_app_user()` returns active rows only |
| Orphan auth user after a failed insert | compensating `deleteUser`; failure logged with the uuid for manual removal |
| Double submit / lost response | key-derived id + `create_app_user` idempotency → replay, no duplicate |
| Account enumeration | one generic 409; endpoint requires an authorised, verified admin; rate limits |
| Secret leakage | service key only inside the function; responses carry the row only; tests assert no key/password/JWT in any response or log |
| Platform-admin account takeover via "adopt existing auth user" | never adopted: an existing auth email is always 409 |

Residual: the email-2FA check accepts a code consumed by the same user on
another device after this session's sign-in (same person, already verified).
The in-memory attempt limiter resets on a worker cold start (durable
creation cap stays).

## 4. Tests

| Suite | Result |
|---|---|
| `bash supabase/tests/functions/run.sh` | **54 passed / 0 failed** (34 before + 20 `staff_admin_test.ts`) |
| `npx vitest run --exclude '.claude/**'` | **838 passed**, 63 skipped (825 before + 13: `createStaffUser.test.ts` 5, `staffForm.test.ts` 5, `noPublicSignUp.test.ts` 3; `authStore.setup.test.ts` and `SetupPage.test.tsx` rewritten for the server path) |
| `npx tsc -b`, `npx tsc -p e2e/tsconfig.json` | clean |
| Phase-D SQL harness | not affected (no SQL change) |

`staff_admin_test.ts` covers: 401 (none / invalid bearer); 403 for cashier,
manager without the permission, inactive and orphan callers; TOTP admin on
aal1 → `mfa_required`, aal2 → OK; email-2FA admin without / with an old / with
an unconsumed / with a fresh consumed code; unverified factor does not force
aal2; happy path (createUser body, RPC called with the caller's JWT, org from
the caller even when the body says otherwise, audit row); replay and key
reuse; granted manager own-shop only; ADMIN / MANAGER / unknown role refused;
cross-org and missing shop identical 403; malformed input (9 cases + bad JSON
+ unknown action + GET); duplicate email in another org and auth-only
duplicate → same 409, nothing deleted; compensation on a business error, on an
unexpected error (generic 500, no internals) and failed compensation logged;
hourly creation cap and attempt limiter (429 + Retry-After); bootstrap closed
on a populated install / with an org / when the check fails (503); bootstrap
happy path, duplicate, cap; only the createUser call ever carries the
password.

Live suite (prepared, **not run**): `src/live/phase-f-staff.live.test.ts` —
F1 sign-up refused, F2 admin (aal2) creates a CASHIER in own org, F3 new
cashier signs in, F4 same admin on aal1 refused, F5 manager/cashier/anon
refused, F6 cross-org (second QA org) refused incl. the email-code path, F7
duplicate 409 + replay, F8 existing QA admin with TOTP still logs in, F9
`cleanup.sql` + `audit_purge.sql` + `verify_clean.sql` → `CLEAN`. Run with the
usual live env (`LIVE_SUPABASE_URL`, `LIVE_ANON_KEY`, `LIVE_SERVICE_KEY`,
`LIVE_SSH_HOST`, `LIVE_STACK_DIR`):
`npx vitest run src/live/phase-f-staff.live.test.ts`.

## 5. Deploy steps (after owner approval)

No migration to apply (082 not needed). Commands run on the self-hosted stack
host, in the stack directory (`$STACK_DIR`).

1. **Pre-checks** (read-only): `docker compose ps` all healthy;
   `grep -c '^DISABLE_SIGNUP=false' .env` → 1; the functions container has
   `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` set (names only:
   `docker compose exec -T functions env | cut -d= -f1 | grep SUPABASE_`).
2. **Function**:
   `rsync -a --delete --exclude .DS_Store supabase/functions/staff-admin/ <host>:$STACK_DIR/volumes/functions/staff-admin/`
   (the edge runtime serves new folders without a restart; if the first call
   404s, `docker compose restart functions`).
3. **Smoke (sign-up still open)**:
   `curl -s -X POST $URL/functions/v1/staff-admin -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' -d '{"action":"create_staff"}'`
   → `401 {"code":"unauthenticated"}`;
   `-d '{"action":"bootstrap_account","email":"probe@qa.invalid","password":"xxxxxxxxxx"}'`
   → `403 {"code":"setup_closed"}` (populated install). No auth row created:
   `SELECT count(*) FROM auth.users WHERE email='probe@qa.invalid'` → 0.
4. **Client**: build/run the app from this branch against the stack; as the
   owner (TOTP) create a throwaway CASHIER on the Users page, sign in as it,
   then deactivate it (or run the live suite, which cleans up after itself).
5. **Disable sign-up**: in `$STACK_DIR/.env` set
   `DISABLE_SIGNUP=true` (single line edit, keep a dated copy of the file
   with `umask 077`), then recreate **only** the auth service:
   `docker compose up -d auth` (do not touch other services).
   Verify: `docker compose exec -T auth env | grep '^GOTRUE_DISABLE_SIGNUP='`
   → `true`.
6. **Smoke (sign-up closed)**:
   `curl -s -X POST $URL/auth/v1/signup -H "apikey: $ANON" -H 'Content-Type: application/json' -d '{"email":"probe2@qa.invalid","password":"xxxxxxxxxx"}'`
   → 422 `signup_disabled`; owner password + TOTP login still works; one
   cashier login works; then run `src/live/phase-f-staff.live.test.ts`
   (expect 9/9 and `CLEAN`).
7. Record the change (dated, how verified) in the environment's own
   operations notes, including the `DISABLE_SIGNUP` setting and the deployed
   function list.

### Rollback

* Sign-up: set `DISABLE_SIGNUP=false` in `.env`, `docker compose up -d auth`.
  Needed only if an **old client build** (one that still calls `signUp`) must
  create staff against this stack.
* Function: `rm -rf $STACK_DIR/volumes/functions/staff-admin`
  (clients from this branch then cannot create staff until it is restored;
  the old Users page needs sign-up re-enabled).
* No data migration to revert; accounts created meanwhile are ordinary
  users + auth rows.

## 6. Compatibility

* **Shipped v1.0.15** targets the **hosted** project: unaffected (hosted
  sign-up setting and functions untouched). Its Users page still uses
  `signUp`, so it must never be pointed at the self-hosted stack once sign-up
  is disabled — it is not (build-time host pinning, Phase G).
* **Builds from this branch** need `staff-admin` deployed on whatever backend
  they target to create staff or run first-time setup. Hosted does **not**
  have it; a build from this branch pointed at hosted could not create staff
  (owner decision needed before any such build; hosted is not to be changed
  without approval).
* Existing accounts, `users` rows, login (password + TOTP / emailed code),
  edits (`update_app_user`), deactivation (`deactivate_app_user`) and manager
  replacement are unchanged.
* `platform-console` already uses the admin API; unaffected by
  `DISABLE_SIGNUP`.
