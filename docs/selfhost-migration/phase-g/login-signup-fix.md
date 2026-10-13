# Phase G · Failed login must never create an account

Date: 2026-10-12. Scope: frontend (Electron + web bundle), one new migration
file (`067_app_setup_needed.sql`, **not applied anywhere** by this change),
the vitest and Playwright harnesses. Nothing committed; `.env.local`, the
hosted project and the self-hosted stack untouched.

## 1. Root cause

`useAuthStore.login()` (`src/stores/authStore.ts`) did two things on a
failed `signInWithPassword`:

1. it called **`supabase.auth.signUp({ email, password })`**, because the
   "very first user" case could not be told apart from a wrong password
   before a session exists (`users` is `SELECT … TO authenticated` only —
   migrations `010`/`056` — so the anonymous "is the table empty?" probe the
   code once used always read back empty);
2. if the sign-up succeeded it signed in with the new account and, finding
   the `users` table empty, created the organization + first ADMIN row.

Step 1 is reached by *every* failed sign-in. On a backend where the e-mail
has no account yet, a mistyped e-mail — or a probe pointed at the wrong
backend — therefore **creates an auth user**. That is exactly what happened
during Phase E (the Phase E evidence log (private ops notes),
"Incident"): a throwaway probe used a hand-started Vite server that fell
back to `.env.local` (the hosted project), and the hosted project gained the
orphan auth user `qa-admin-1791782177708@qa.invalid`. Two contributing
weaknesses: `src/lib/supabase.ts` silently created a client from whatever
`import.meta.env` held, and the login page itself advertised the behaviour
("Sign in with any email to create the admin account").

## 2. What changed

| Area | Before | After |
|---|---|---|
| `login()` | signIn → on failure `signUp` → signIn → maybe create org + ADMIN | **signIn only.** A failed sign-in returns GoTrue's own message (`Invalid login credentials`, `Email not confirmed`, …) and stops. `signUp` is never called from the login path. |
| Empty `users` table on a successful sign-in | created the first ADMIN inline | signs the session back out and returns `setupNeeded: true` with a message pointing at first-time setup; nothing is written |
| First-admin bootstrap | implicit, inside `login()` | **explicit** `bootstrapFirstAdmin(email, password)` behind the new `/setup` route (`src/pages/SetupPage.tsx`). Same semantics as before — organization row + ADMIN `users` row linked by `auth_id`, admin still has to pass `/verify` — but reachable only through that page. |
| Server gate | none | `app_setup_needed()` — migration `067`, a read-only `SECURITY DEFINER STABLE` function returning `NOT EXISTS (SELECT 1 FROM users)`, granted to `anon` (the pages run before any session exists), `authenticated` and `service_role`. `isAppSetupNeeded()` in the auth store **fails closed**: any error (function not deployed, network, RLS) is reported as "not needed" with the reason, so the UI never offers setup on a backend it could not confirm is empty. `bootstrapFirstAdmin()` calls it first, then signs in (or, only if sign-in fails, signs up — the one remaining `signUp` the app makes for itself), then re-checks `users` with the session before inserting. The RLS escape hatches `users_ins` / `organizations_ins` (`010`, `060`: insert allowed only while `users` is empty) stay the server-side authority. |
| `/setup` page | — | shows the backend host; renders the form **only** while the status is "needed" (checking / done / unavailable render a read-only message with a link back to sign-in); requires the e-mail typed twice, a password, and an explicit "I understand this creates the first administrator account on <host>" checkbox. |
| Login page | "First time? Sign in with any email…" | shows "Staff accounts are created by the administrator. Signing in never creates an account."; the "Run first-time setup" link appears only when `app_setup_needed()` returned true (or a successful sign-in reported `setupNeeded`). Footer shows `Backend: <host>`. |
| Staff creation | Users page: admin → `auth.signUp` + `create_app_user` | unchanged (already explicit). |
| Backend selection (`src/lib/backendConfig.ts`, `src/lib/supabase.ts`) | `createClient(import.meta.env.VITE_SUPABASE_URL as string, …)` — a missing value became the string `"undefined"` | **fail closed**: empty/missing `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY`, a malformed URL, or — when `VITE_SUPABASE_EXPECTED_HOST` is set — a host that does not match it, throws `BackendConfigError` while the client module loads. `src/main.tsx` imports the app dynamically and renders the message on screen ("The app cannot start …") instead of a blank window. `vite.config.ts` runs the same check at **build** time when `VITE_SUPABASE_EXPECTED_HOST` is set; `npm run build:electron` now sets it to `your-backend.example.ts.net` (see the deployment notes (kept outside this repository)). |
| Visible backend | — | `backendHost` is shown in the login page footer, the sidebar footer (`backend: <host>`) and on `/setup`. |
| Test harnesses | e2e terminals aborted `*.supabase.co` and B12 asserted on it; vitest had no guard | `src/test/hostedGuard.ts` patches `fetch`/`WebSocket` to **throw** on `*.supabase.co` and records the attempt; `src/test/setup.ts` (new `vitest.config.ts` `setupFiles`) installs it for every test file, pins `VITE_SUPABASE_URL`/`ANON_KEY` to a loopback placeholder so `.env.local` can never leak into the unit suite, and fails the test in `afterEach` if anything was attempted. `src/live/liveHelpers.ts` installs the same guard and refuses a hosted `LIVE_SUPABASE_URL`. Playwright: `e2e/helpers/hostedGuard.ts` writes a FAIL evidence line per attempt; `assertConsistency()` (after every spec) treats it as a violation; `global-teardown` scans the ledger and throws, so the run exits non-zero even if a spec swallowed it; `E2E_SUPABASE_URL` is refused if hosted; the route pattern now covers `wss://` too. B12 kept. |

Files: `src/stores/authStore.ts`, `src/pages/SetupPage.tsx` (new),
`src/pages/LoginPage.tsx`, `src/app/routes/AppRouter.tsx`,
`src/app/layout/Sidebar.tsx`, `src/index.css`, `src/i18n/translations.ts`,
`src/lib/backendConfig.ts` (new), `src/lib/supabase.ts`, `src/main.tsx`,
`vite.config.ts`, `vitest.config.ts` (new), `tsconfig.node.json`,
`src/test/{hostedGuard,setup}.ts` (new), `src/live/liveHelpers.ts`,
`e2e/helpers/{hostedGuard,terminal,consistency,env}.ts`,
`e2e/global-teardown.ts`, `package.json` (`build:electron`),
`supabase/migrations/067_app_setup_needed.sql` (new).

Tests (vitest, no backend): `src/stores/authStore.login.test.ts` (rewritten:
wrong password / unknown e-mail / other GoTrue errors return the GoTrue
message and never call `signUp`; empty table → `setupNeeded`, no insert;
orphan account signed out), `src/stores/authStore.setup.test.ts`
(`isAppSetupNeeded` fails closed; `bootstrapFirstAdmin` refuses when not
needed or unconfirmed, happy path creates org + ADMIN linked by `auth_id`,
reuses an existing auth account without `signUp`, surfaces a `signUp` error
with no writes, backs out when a row appeared meanwhile),
`src/lib/backendConfig.test.ts`, `src/lib/supabase.test.ts` (module import
throws on missing env / wrong expected host via `vi.stubEnv`),
`src/pages/SetupPage.test.tsx` (form rendered only for status "needed"),
`src/test/hostedGuard.test.ts`.

## 3. What an operator must do on a brand-new install

1. Apply the migrations through `066` **and `067`** (`<deployment>/apply-migrations.sh`).
   Until `067` is applied the `/setup` page reports "Could not confirm with
   the backend whether first-time setup is needed" and refuses to act — by
   design. Verify: `SELECT app_setup_needed();` → `true` on an empty install.
2. Build/run the app against that backend (`VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`; for the Electron build the host must equal
   `VITE_SUPABASE_EXPECTED_HOST`). Check the host shown in the login page
   footer.
3. Open **`/setup`** (Electron: `#/setup`; the login page links to it while
   the backend reports no users). Type the administrator e-mail twice, a
   password (≥ 6 characters, GoTrue's policy applies), tick the
   acknowledgement, click **Create administrator**. This creates the auth
   account (or signs in to an existing one with that password), one
   organization named after the e-mail's local part, and the ADMIN `users`
   row linked by `auth_id`.
4. The admin is then sent to `/verify`. **Caveat (pre-existing, not changed
   here):** a fresh ADMIN has no TOTP factor, so `/verify` offers the
   e-mailed code, which needs the `admin-2fa` function and a mail provider.
   On a self-hosted stack without e-mail the owner's TOTP factor is migrated
   with the data (owner TOTP verification, private ops notes); for a genuinely empty
   install an e-mail provider or an out-of-band TOTP enrolment is needed
   before the first admin can get past `/verify`. Decision for the owner —
   see the report.
5. Once a `users` row exists, `/setup` renders "Setup has already been
   completed" and the login page stops linking to it. Staff are created from
   the Users page.

Sign-in behaviour afterwards: a wrong password shows `Invalid login
credentials`; an auth account without a staff profile shows "No staff
profile is linked to this account. Contact an administrator." — in both
cases nothing is created.

## 4. Not changed / follow-ups

- The hosted orphan auth user from the incident is still there (deleting it
  is a hosted change needing owner approval).
- `disable_signup` can stay `false` for now because the Users page still
  creates staff through `auth.signUp` (it could move to
  `auth.admin.createUser` via an edge function later; then `disable_signup`
  could be turned on and `bootstrapFirstAdmin` would need the same path).
- `/verify` for a first admin without e-mail (above).
