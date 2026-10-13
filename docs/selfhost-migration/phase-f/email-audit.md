# Phase F · Email functionality audit (before email-based backups)

Status: **audit, 2026-10-13**. Read-only. Nothing was changed on `lucashome`
or on hosted Supabase, and no email was sent. Phase E already covered the four
email functions in depth ([phase-e/cron-email-audit.md](../phase-e/cron-email-audit.md),
26 hermetic tests). This document re-checks that work against the code at
`b0d0c7f` (schema 080) and the live stack, and adds what email-based backups
need to know.

Legend: **V** verified (code read, or a read-only command on the stack today),
**I** inferred, **U** unknown.

## 0. Summary

| Function | Sends | Provider | Trigger | Recipients | Org-safe after 068–080? | On `lucashome` today |
|---|---|---|---|---|---|---|
| `email-sales-report` | the day's per-shop sales CSVs (built by the **client**) | Resend | admin button on `/app/sales` | the calling ADMIN only | **yes**: the client builds the CSV from its RLS-scoped reads; the function only forwards it to the caller's own address | 500 "Email provider is not configured" (no `RESEND_API_KEY`) |
| `weekly-sales-report` | one receipt-line CSV per shop, last Mon–Mon week (MMT) | Resend | pg_cron `30 17 * * 0` (hosted) | **every active ADMIN of every org** | **NO**: service-role reads of `sales`, `sale_items`, `shops`, `users`, `products` with no `org_id` filter; one message to all admins of all orgs | not scheduled (`cron.job` = 0) |
| `rotate-audit-log` | the oldest 200 `audit_logs` rows as CSV, **then deletes them** | Resend | pg_cron `*/5 * * * *` (hosted) | every active ADMIN of every org | **NO**: same cross-org read and recipient list; destructive | not scheduled; **must stay off** (owner decision 2026-10-12) |
| `admin-2fa` | a 6-digit login code | Resend | admin login, "email code" path | the caller | yes (per user) | 500 before any write; email path unusable |
| `platform-console` | **nothing** (temp passwords are returned to the console UI, never mailed) | — | platform admin UI | — | yes (platform-admin gate) | deployed |

Recommendation for the email tier: **do not build on the Edge Functions.** The
daily business report and the weekly recovery archive are new server-side
scripts (`deploy/lucashome/backup/email-*.sh`) that read the database
read-only from the backup host and send through a send-only credential. They
never touch the Edge Function runtime, pg_cron, pg_net or the service-role key.
Details in [email-backup-design.md](email-backup-design.md).

## 1. Function by function

### 1.1 `email-sales-report` (**V**, `supabase/functions/email-sales-report/index.ts`)

- Auth: bearer = the user's JWT → `auth.getUser` → `users` row by `auth_id`
  (fallback: unique case-insensitive email match) → must be `ADMIN` and
  `is_active`. Recipient is the caller's own email; nothing else.
- Data: whatever the client posts (`attachments[{filename,csv}]`,
  `shopSummaries`, counts, `openShiftNotice`). The client builds the CSVs in
  `src/features/sales/dailySalesReport.ts` from its own RLS-scoped data, so
  after 068–080 an ADMIN can only include their own org's sales. The function
  does not read any business table itself.
- Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
  `REPORT_EMAIL_FROM`. Provider: `POST https://api.resend.com/emails`.
- Scheduling: none (button).
- Personal data: cashier names and emails are CSV columns → they sit in
  Resend's logs for the plan's retention (30 days on Free).

### 1.2 `weekly-sales-report` (**V**)

- Auth: `Authorization: Bearer <service-role key>` compared by string; the env
  check runs **before** the bearer check (Phase E F5).
- Data: `sales` in `[Mon 00:00, Mon 00:00)` Asia/Yangon (fixed +06:30), then
  `sale_items`, `shops`, cashier `users` (name, **email**), `products` — all
  through the service role, which bypasses RLS. **No `org_id` filter anywhere.**
- Recipients: `users where role='ADMIN' and is_active and email is not null` —
  **across all organizations**, in one message.
- **Org-isolation finding (new since Phase E):** with a second organization
  (platform console, migrations 059–080) this function would mail org A's
  receipt lines, cashier names and cashier emails to org B's admins and vice
  versa. Phase E recommended "enable"; that recommendation was made before
  multi-org mattered and is **withdrawn**. Before it is ever scheduled it needs
  a per-org loop (`shops.org_id`) and per-org recipients. Today there is one
  org, so nothing has leaked; it is simply not safe to schedule.
- Other findings still open from Phase E: zero-sales path ignores the Resend
  status (F2), no retry/sent-marker (F3), UTC date in the filename (F6).

### 1.3 `rotate-audit-log` (**V**)

- Same auth/env pattern. When `audit_logs` ≥ 200 rows it emails the oldest 200
  as CSV to every active ADMIN (all orgs) and **then deletes exactly those
  rows**. Not idempotent across a delete failure or a concurrent run (Phase E
  F1, test-proven).
- **Risk:** the email becomes the only copy of deleted audit history, it goes
  to admins of every org (cross-tenant leak of actor names and messages), and
  it competes with `admin-2fa` for the Resend daily quota.
- **Decision (owner, 2026-10-12, `lucashome-selfhost/risks.md`):** stays off on
  `lucashome`; audit rows are retained and covered by backups. The email tier
  built here does **not** re-enable, schedule, wrap or call it. It is still
  active on **hosted** (`hosted-supabase/status.md`) — a hosted-side decision
  that is out of scope here.

### 1.4 `admin-2fa` (**V**)

- Second factor for ADMIN sign-in. Two paths in the app
  (`src/stores/authStore.ts`): **TOTP** through GoTrue MFA
  (`auth.mfa.enroll/challenge/verify`, `aal2`) — no email involved — and an
  **email code** through this function (stores only the SHA-256 of the code in
  `admin_login_codes`, 10-minute expiry, 5 attempts, 30 s cooldown).
- Does admin 2FA depend on email delivery? **Only the email-code path.** On
  `lucashome` there is no `RESEND_API_KEY`, so the email path returns 500 before
  writing anything (documented in `next-phase/owner-totp-test.md`); ADMINs must
  use TOTP. Live: `auth.mfa_factors` = 2 rows (**V**, count only).
- **Risk:** an ADMIN who loses their authenticator has no self-service way in
  on `lucashome` (no email fallback). Recovery is a DB-side factor removal by
  the engineer. The weekly archive carries `auth.mfa_factors`, so a restore
  keeps TOTP working (test-proven: secret restored intact).
- The email tier does not use or change this function. If the owner later adds
  a Resend key for `admin-2fa`, keep the backup host's key separate (§3).

### 1.5 `platform-console` (**V**)

No email. Creates organizations and platform admins via
`auth.admin.createUser({email_confirm:true})` with a random temp password that
is shown once in the console and "relayed to the customer manually". Never
logged, never mailed.

## 2. Scheduling — hosted vs `lucashome`

- Repo: `supabase/schedule_weekly_sales_report.sql` and
  `supabase/schedule_audit_rotation.sql` create pg_cron jobs that
  `net.http_post` to the **hosted** function URL with a pasted service-role key
  placeholder. No migration and no `schema.sql` schedules anything
  (`grep cron.schedule|net.http_post` → only those two files and a comment in
  062). **V**
- Hosted (per `hosted-supabase/status.md`, 2026-10-11): `rotate-audit-log`
  `*/5` and `weekly-sales-report` `30 17 * * 0` still active.
- `lucashome` (today, read-only): `cron.job` = **0 rows**; `pg_cron 1.6.4` and
  `pg_net 0.20.3` installed but unused; `RESEND_API_KEY` and
  `REPORT_EMAIL_FROM` **not set** in `stack/.env` (`grep -c '^NAME=.'` → 0);
  the override still forwards both names to the functions container (empty).
  **V**
- Phase E's rendered-cron procedure (§8 there) remains the way to schedule an
  Edge Function if ever wanted; nothing in this phase uses it.

## 3. GoTrue SMTP on `lucashome` (presence only, **V**)

| Variable in `stack/.env` | Present (non-empty) | Note |
|---|---|---|
| `SMTP_HOST` | yes | not the template value `supabase-mail`; no mail container runs |
| `SMTP_PORT` | yes | not `2500` |
| `SMTP_USER` | yes | not `fake_mail_user` |
| `SMTP_PASS` | **no** | empty |
| `SMTP_ADMIN_EMAIL` | **no** | empty |
| `SMTP_SENDER_NAME` | yes | |
| `ENABLE_EMAIL_AUTOCONFIRM` | `true` | sign-ups need no confirmation mail |
| `ENABLE_EMAIL_SIGNUP` | `true` | |

With no password GoTrue cannot deliver mail (password reset, magic link,
invite). The app does not call `resetPasswordForEmail`, `signInWithOtp` or
invites (**V**, grep of `src/`), and users are created confirmed by the
platform console, so nothing in the app depends on GoTrue mail today.
Implication: **"forgot password" does not exist** on `lucashome`; a locked-out
user is reset by an admin/engineer. Not changed here.

## 4. What the email tier must therefore respect

1. No Edge Function, no pg_cron, no pg_net, no service-role key in the
   database: scripts on the backup host, cron on the host (when the owner
   enables it).
2. Org isolation: the daily report is generated **per organization** with every
   query scoped by `shops.org_id` / `<catalog>.org_id`, and routed by an
   explicit owner-maintained targets file — never "all admins".
   Test-proven: org B's canary never appears in org A's report and vice versa.
3. Read-only: the report SQL runs in a `READ ONLY` transaction.
4. `rotate-audit-log` stays off; nothing here deletes anything from the database.
5. Resend Free is 100 messages/day **shared** by everything on the account. The
   email tier sends ≤ 2 reports/day + ≤ 1–7 archive parts/week + rare alerts.
   Use a **separate API key** (`sending_access`, restricted to the sender
   domain) for the backup host so it can be revoked without touching the app's
   functions.
6. Plaintext business mail (the daily report) carries totals and product names
   only — no customer data (the app has no customer table), no staff emails or
   phone numbers, no credentials.

## 5. Risks found

| # | Risk | Severity | Where | Action |
|---|---|---|---|---|
| E1 | `weekly-sales-report` mails every org's sales + cashier emails to every org's admins | high once a 2nd org exists | function code | do not schedule; rewrite per-org before any use (§1.2) |
| E2 | `rotate-audit-log` deletes audit history after an email; cross-org recipients; non-idempotent | high | function code; still active on hosted | stays off on `lucashome` (owner); hosted decision pending in `hosted-supabase/roadmap.md` |
| E3 | ADMIN 2FA has only TOTP on `lucashome`; lost authenticator = engineer-assisted recovery | medium | env (no Resend key) | owner keeps TOTP recovery codes / a second enrolled device; documented |
| E4 | No password-reset mail (GoTrue SMTP has no password) | low (app has no reset flow) | env | none now |
| E5 | Resend quota shared between `admin-2fa` and anything else on the account | low at current volume | provider | separate key for the backup host; volumes in §4.5 |
| E6 | Daily report plaintext sits in the provider's logs (30 days on Resend Free) | low | provider | totals only (§4.6) |
