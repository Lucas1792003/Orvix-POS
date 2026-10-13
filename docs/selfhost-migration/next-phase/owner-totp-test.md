# Owner TOTP login test on `lucashome` — proposal

Status: **proposal, 2026-10-13 (UTC)**. Supersedes the procedure in [phase-g/owner-totp-verification.md](../phase-g/owner-totp-verification.md) for the current server and client state. That file stays as the original; its steps are still valid, but this version adds the safety pins and the "don't press" list.

## Decision summary

- **What:** you sign in once as the ADMIN, through the app's own login page, against `lucashome`, using your existing authenticator app. This proves the migrated TOTP factor works. It is gate **G5** and an open release blocker in [risks.md](../../lucashome-selfhost/risks.md).
- **Safe by construction:** no credential, code, secret or recovery code is ever shared. Nothing is reset, re-enrolled or created. Hosted is not contacted (the dev server is pinned to `lucashome` and refuses to start otherwise). A failed sign-in can no longer create an account (fixed 2026-10-12, commit `293fdf4`; `/setup` is the only path that creates one, server function `bootstrap_first_admin()`, migration 076).
- **Your time ~10 min; engineer ~10 min read-only afterwards. No downtime, no approval needed beyond yours to run it.** The engineer's checks are read-only SQL on `lucashome`.
- **What you report back:** only the outcome ("dashboard reached", or the exact error text on screen).

## What changed since the phase-g procedure (state 2026-10-13)

| Item | State | Effect on this test |
|---|---|---|
| Server schema | **079** (077–079 applied 2026-10-13 01:56 UTC per [status.md](../../lucashome-selfhost/status.md)); 076 = `bootstrap_first_admin()` | none on login; 077–079 are price levels and upload paths |
| Login | sign-in only; a wrong password returns GoTrue's message and stops; `signUp` is never called from the login page | a typo cannot create an account |
| `/verify` page | ADMIN without an `aal2` session is sent to `/verify`. It opens in **authenticator** mode when a verified TOTP factor exists | you should see "enter the code from your authenticator app" |
| Email-code path | **unavailable on `lucashome`**: no Resend key, so `admin-2fa` answers *"Email provider is not configured…"* (HTTP 500) before writing anything | do not use it; it is not part of this test |
| "Set up an authenticator app" link | shown only in email mode; starts enrolling a **new** factor | do not press it (it would add a factor and change what we are verifying) |
| Backend shown | login page footer and sidebar footer show `Backend: <host>` | must read `lucashome.tail8a86e4.ts.net` before you type anything |

## Prerequisites

1. `lucashome` healthy: engineer runs `backup-status.sh` (OK) and `docker compose ps` (10/10 healthy) just before.
2. Engineer has taken the **pre-snapshot** (§3.1) so "factor ids unchanged" can be proven.
3. Your phone's clock is on automatic time (TOTP tolerates about ±30 s).
4. Not during the reboot window ([reboot-and-hardening.md](reboot-and-hardening.md)).

## 1. Your procedure (Mac, repo root)

```
cd /Users/waiyan/Projects/personal/ShwePhaLa
export VITE_SUPABASE_URL=https://lucashome.tail8a86e4.ts.net
export VITE_SUPABASE_EXPECTED_HOST=lucashome.tail8a86e4.ts.net
export VITE_SUPABASE_ANON_KEY="$(ssh -o BatchMode=yes lucashome 'grep "^ANON_KEY=" /srv/supabase/stack/.env | cut -d= -f2-')"
npm run dev
```

- `VITE_SUPABASE_EXPECTED_HOST` is the safety pin. If the URL ever fell back to `.env.local` (hosted), the dev server and the app refuse to start with "Backend host mismatch" instead of talking to hosted. The anon key is public by design and only lands in your shell.
- Use the dev server in a browser, **not** the packaged app in `release/`. The packaged app shares its local database folder with any installed v1.0.15 (same app id), which still points at hosted.

Then:

1. Open **http://localhost:5173** in a **private/incognito window** (fresh local storage).
2. Check the footer: `Backend: lucashome.tail8a86e4.ts.net`. Anything else → stop, close the window, tell the engineer.
3. Sign in with your ADMIN email and password, as usual.
   - Wrong password → an error appears and **nothing is created**. After two failures, stop and report the exact text (GoTrue rate-limits repeated attempts).
4. You land on **/verify**, asking for the 6-digit code from your authenticator app. Enter the current code.
   - **Do not press** "Use email code instead" or "Set up an authenticator app".
5. Expected: the **Dashboard**. The sidebar footer again shows `backend: lucashome.tail8a86e4.ts.net`.
6. **Leave the tab open and tell the engineer the outcome.** The engineer checks the live session (§3.2); signing out first would delete the session row being checked.
7. When the engineer says done: sign out, stop the server (Ctrl+C), `unset VITE_SUPABASE_URL VITE_SUPABASE_EXPECTED_HOST VITE_SUPABASE_ANON_KEY`, and close the private window.

Optional look (don't click anything): **Security** page lists your authenticator entries. Do not add or remove any.

## 2. What you report

Exactly one of:
- "Dashboard reached."
- The exact error text, and which step it appeared at (sign-in or `/verify`).

Never send the password, the 6-digit code, a screenshot of the authenticator app, or recovery codes.

## 3. What the engineer verifies (read-only SQL on `lucashome`)

All queries run as:
`ssh -o BatchMode=yes lucashome 'cd /srv/supabase/stack && docker compose exec -T db psql -U supabase_admin -d postgres -At -v ON_ERROR_STOP=1 -c "<SQL>" </dev/null'`.
They never select `auth.mfa_factors.secret`, password hashes, or tokens. Ids go into the evidence file truncated to 8 characters.

The ADMIN is identified as `a = (select auth_id from public.users where role = 'ADMIN' and org_id = 'org-shwe-pha-lar')`. Compare with `::text` on both sides.

### 3.1 Before (snapshot)

```sql
-- factors: expect 2 rows, factor_type totp, status verified (status.md: "2 verified TOTP factors on the ADMIN")
select f.id, f.factor_type, f.status, f.created_at, f.updated_at, f.last_challenged_at
  from auth.mfa_factors f where f.user_id::text in (select auth_id::text from public.users where role='ADMIN' and org_id='org-shwe-pha-lar')
 order by f.created_at;
select count(*) from auth.users;                                     -- expect 10
select count(*) from auth.sessions s where s.user_id::text in (select auth_id::text from public.users where role='ADMIN' and org_id='org-shwe-pha-lar');
```

### 3.2 After "dashboard reached" (tab still open)

| # | Check | SQL (same ADMIN filter) | Pass |
|---|---|---|---|
| V1 | Fresh session at `aal2` | `select id, aal, created_at, factor_id from auth.sessions where user_id::text in (…) order by created_at desc limit 3;` | newest row created during the test, `aal = aal2`, `factor_id` is one of the 2 pre-snapshot ids |
| V2 | The step-up was TOTP | `select c.authentication_method, c.created_at from auth.mfa_amr_claims c join auth.sessions s on s.id = c.session_id where s.user_id::text in (…) and s.created_at > now() - interval '1 hour';` | rows `password` and `totp` for the new session |
| V3 | A verified challenge on an existing factor | `select ch.factor_id, ch.created_at, ch.verified_at from auth.mfa_challenges ch join auth.mfa_factors f on f.id = ch.factor_id where f.user_id::text in (…) and ch.created_at > now() - interval '1 hour';` | ≥ 1 row with `verified_at` set |
| V4 | Factors unchanged | re-run the 3.1 factor query | same 2 ids, same `factor_type`/`status`/`created_at`; only `updated_at`/`last_challenged_at` may move |
| V5 | Nothing created | `select count(*) from auth.users;` | still 10 |
| V6 | No email-code row written | `select count(*) from public.admin_login_codes where created_at > now() - interval '1 hour';` | 0 |

Evidence: `docs/selfhost-migration/evidence/G5/<date>-owner-totp.md` with your reported outcome, the before/after tables (ids truncated), and pass/fail per V-row. Then tick "Owner TOTP login test" in [roadmap.md](../../lucashome-selfhost/roadmap.md) and mark the risk resolved in `risks.md`.

## 4. Failure handling (nothing is reset in any branch)

| What you see | Most likely | What the engineer does (read-only first) | What you do |
|---|---|---|---|
| Footer shows another host, or "The app cannot start / Backend host mismatch" | env not exported in this shell | nothing | stop; re-export in the same terminal; retry |
| "Invalid login credentials" | password hash not migrated for this account, or a typo | compare `auth.users` row presence / `encrypted_password` **format only** (`left(encrypted_password,4)`, length), never the value; compare with the hosted export manifest | stop after 2 tries; report the text. **No password reset** without a separate decision |
| "Too many requests" / 429 | GoTrue rate limit | — | wait 10 min, try once more |
| `/verify` shows the email-code screen (not the authenticator one) | the app saw no verified TOTP factor | check the factor rows' `user_id` matches the ADMIN `auth_id` and `status = verified` | press "Back to login", report. Do not press "Set up an authenticator app" |
| Code rejected ("Invalid TOTP code" / "Incorrect code…") | phone clock skew, or a stale code | check `auth.mfa_challenges` for the failed attempts; check the server clock (`date -u` on `lucashome`; chrony is synced per the audit) | fix the phone's time; try the next code **once**; then stop and report |
| Stuck on "Checking session…" | backend unreachable | `backup-status.sh`, `docker compose ps`, Tailscale status | report; close the tab |
| Dashboard reached but V1 shows `aal1` | client marked verified without a server step-up (would be an app defect) | capture V1–V3; open a defect | sign out |

Hard rules: no `mfa.unenroll`, no new enrolment, no admin-API change to factors or passwords, no direct SQL writes to `auth.*`. If the migrated factor truly does not work, the fallback (re-enrolment, which needs either an email provider or an admin-API path) is a separate proposal for your approval, per G5 in [10-go-no-go-checklist.md](../10-go-no-go-checklist.md).

## 5. Risks

| Risk | Mitigation |
|---|---|
| Dev server talks to hosted (the 2026-10-12 incident pattern) | `VITE_SUPABASE_EXPECTED_HOST` pin + footer check before typing |
| Accidental factor enrolment | "do not press" list; V4 detects any change |
| Session left at `aal1` if abandoned at `/verify` | "Back to login" signs out; sessions expire with the 1 h JWT / refresh policy |
| Owner's credentials exposed | nothing is shared; the engineer sees only database metadata |
