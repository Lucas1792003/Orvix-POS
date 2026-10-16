# 07 · Setup & Deployment

## Local Setup

```bash
npm install
npm run dev      # http://localhost:5173 (or the Vite default)
```

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b && vite build` — production bundle into `dist/` |
| `npm run preview` | Local preview of the production build |
| `npm test` | Vitest unit tests |
| `npm run lint` | ESLint |

## Environment Variables

`.env.local` (do **not** commit):

```bash
VITE_SUPABASE_URL=<your-project-url>
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

Both are **required** (Phase G, `src/lib/backendConfig.ts`): the app refuses
to start — and `vite build` refuses to build when the pin below is set —
if either is missing/empty or the URL is malformed; there is no default
backend. Optional pin:

```bash
VITE_SUPABASE_EXPECTED_HOST=lucashome.tail8a86e4.ts.net   # set by `npm run build:electron`
```

When set, the host of `VITE_SUPABASE_URL` must equal it exactly, otherwise
the build fails and the app shows "The app cannot start … Backend host
mismatch". The host the bundle talks to is shown in the login page footer
and the sidebar footer (`backend: <host>`). See
`deploy/lucashome/README.md` § "Building the desktop app".

> Do **not** put a service-role key in any `VITE_*` variable — Vite inlines
> those into the browser bundle. The anon key plus RLS is the security
> boundary on the client. Service-role keys belong only in private
> server-side tooling.

Optional development-only flags:

- `VITE_ALLOW_BROWSER_SUPABASE_SEED=true` — explicitly unlocks
  `src/data/seedSupabase.ts` for local development against a non-production
  database. Off by default; production builds must not set it.

## Supabase Setup

For a fresh Supabase project:

1. Apply `supabase/schema.sql` in the SQL Editor.
2. Apply every file in `supabase/migrations/` **in numeric order**
   (`001` → `043`). See
   [03-database-security.md](./03-database-security.md) for the full
   migration list.
3. Verify the `auth` and `public` schemas have the expected tables, RPCs,
   and policies (see the live verification checklist in
   [`archive/29-live-supabase-rls-rpc-verification.md`](./archive/29-live-supabase-rls-rpc-verification.md)).
4. Create the **first administrator** from the app's `/setup` page
   (Electron: `#/setup`) — it is offered only while `app_setup_needed()`
   (migration `067`) reports an empty `users` table, and asks for the
   e-mail twice plus an explicit confirmation. Signing in on the login page
   never creates an account (Phase G,
   `docs/selfhost-migration/phase-g/login-signup-fix.md`).
5. Create further staff from the Users page (admin → `auth.signUp` +
   `create_app_user`). Rows inserted by hand must set `auth_id` to the Auth
   user's UUID (or the email-fallback path in `authStore.ts` self-heals the
   link on first login).
6. Every non-admin user (MANAGER / CASHIER / BUYER) must have a `shop_id`.

For an existing database, apply only new migrations in numeric order.

## Storage Bucket

The `product-images` bucket and its RLS policies are created by
`016_product_images_storage.sql`. If your environment rejects
`CREATE POLICY ON storage.objects` from a migration, follow the dashboard
fallback in [`archive/31-product-images-storage-setup.md`](./archive/31-product-images-storage-setup.md):

- Bucket name: `product-images`
- Public read: **yes**
- File size limit: ~128 KB (the app caps images at 100 KB)
- Allowed MIME: `image/webp`, `image/jpeg`
- Read: `public`
- Insert / update / delete: `authenticated` AND
  `public.app_has_perm('product:create' OR 'product:update')`

The phone QR upload sessions table and helpers are added by
`019_product_image_upload_sessions.sql`.

## Daily Sales Email Function

The admin-only "Email today's CSV" button calls a Supabase Edge Function
that emails per-shop CSVs via [Resend](https://resend.com). Feature spec
in [04-features-workflows.md](./04-features-workflows.md#daily-sales-email-report).

### One-time setup

1. **Sign up to Resend** (https://resend.com) with the email address
   that should receive the report. The Resend free tier (3 000
   emails/month, 100/day) only delivers from `onboarding@resend.dev` to
   the signed-up email. For multi-recipient or production use, verify a
   custom domain in Resend instead.
2. **Create a Resend API key** → Resend dashboard → **API Keys** →
   `Create API Key` → Full access → copy the `re_…` value (only shown
   once).
3. **Set Supabase secrets** — either via CLI:
   ```bash
   supabase secrets set RESEND_API_KEY=re_xxx
   supabase secrets set REPORT_EMAIL_FROM="Shwe PhaLar <onboarding@resend.dev>"
   ```
   …or via the dashboard: **Edge Functions → email-sales-report →
   Secrets → Add new secret**.
4. **Deploy the function** — either CLI:
   ```bash
   supabase functions deploy email-sales-report
   ```
   …or paste the contents of
   `supabase/functions/email-sales-report/index.ts` into **Edge
   Functions → email-sales-report → Code editor** and click **Deploy
   function**. The function name must match exactly so
   `supabase.functions.invoke("email-sales-report", …)` reaches it.

### Required configuration

| Secret | Value | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | `re_…` | From Resend dashboard |
| `REPORT_EMAIL_FROM` | `Shwe PhaLar <onboarding@resend.dev>` | Free tier; replace with a verified-domain address for production |
| `SUPABASE_URL` | (auto) | Injected by Supabase at runtime |
| `SUPABASE_SERVICE_ROLE_KEY` | (auto) | Used to read `users` past RLS for the admin-role check |

### Recipient resolution

The function emails the address on the admin's row in `users` (falling
back to `auth.users.email`). For Resend's free tier to deliver, that
address must equal the email the Resend account was signed up with. If
the admin email changes, either:
- update the Resend account's email, or
- verify a custom sender domain and edit `REPORT_EMAIL_FROM` to a
  verified address — then any recipient is allowed.

### Verify

After deploy:
1. Log in as an admin user with a valid email
2. Sales page → **Email today's CSV** (admin-only button)
3. Inbox should receive an email within ~30 s with one CSV attachment
   per shop with sales today
4. If it errors, check **Edge Functions → email-sales-report → Logs**;
   the latest invocation reports the failing branch (config, admin
   lookup, Resend response)

## Admin Login Verification (2FA)

After an ADMIN passes the password check, they must complete a second factor
before reaching the app — an **authenticator-app (TOTP) code** if one is set
up, otherwise a **6-digit code emailed** to them (10-minute expiry). Feature
spec in [04-features-workflows.md](./04-features-workflows.md#admin-login-verification-2fa).

### Email-code path — `admin-2fa` edge function

1. **Migration:** apply `042_admin_login_codes.sql` (service-role-only table
   holding code hashes + expiry).
2. **Secrets:** reuses the same Resend config as the email report — no new
   secrets (`RESEND_API_KEY`, `REPORT_EMAIL_FROM`; `SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY` auto-injected).
3. **Deploy:**
   ```bash
   supabase functions deploy admin-2fa
   ```
   …or paste `supabase/functions/admin-2fa/index.ts` into **Edge Functions →
   admin-2fa → Code editor** and Deploy. The name must match exactly so
   `supabase.functions.invoke("admin-2fa", …)` reaches it.
   - `action: "request"` → generates a code, stores its SHA-256 hash, emails
     the plaintext via Resend.
   - `action: "verify"` → checks the latest unconsumed code (expiry / attempts
     / consume).
4. **Codes landing in spam:** the same Resend deliverability rules apply —
   verify a sender domain and set `REPORT_EMAIL_FROM` to an address on it.

### Authenticator-app path — Supabase MFA (TOTP)

1. **Enable TOTP MFA:** Supabase dashboard → **Authentication →
   Multi-Factor Authentication** → enable **Authenticator app (TOTP)** (on by
   default). No code or secret needed — enrollment/verification use the native
   `supabase.auth.mfa.*` API.
2. Admins enroll/manage devices on the in-app **Security** page
   (`/app/security`); the enrolled-issuer label is set to the brand
   ("Shwe PhaLar") so the entry reads sensibly in the authenticator app.
3. **Recovery:** a lost phone falls back to the email-code path ("Use email
   code instead"), so no separate backup codes are required.

## Platform Admin Console

> **RETIRED (2026-10-16).** The `platform-console` Edge Function was removed from lucashome (G0-1) and its source
> moved to `archive/deprecated-edge-functions/platform-console/` (G0-2). It must not be deployed: `deploy/lucashome/sync-functions.sh`
> refuses it, and `supabase functions deploy platform-console` no longer finds a source. Organisation creation is an operator
> runbook until the separate Orvix Control project exists (`docs/plans/orvix-platform-control-plane-architecture.md`). The
> `/console` pages below still ship in the app bundle and are scheduled for removal in the 1.0.17 UI work. The text below is
> kept for history only. Evidence: `docs/selfhost-migration/evidence/G0-1/`, `docs/selfhost-migration/evidence/G0-2/`.

Internal, operator-only tool for provisioning new organizations
(multi-tenant Phase 2 — see [09-roadmap-todo.md](./09-roadmap-todo.md#future-vision--multi-tenant-saas-2026-08-25-not-scheduled)).
Reachable at `/console/login` — a URL deliberately not linked from
anywhere in the app (not `/login`, not the sidebar). A platform admin's
account is structurally unrelated to any org's `users` row: no
`org_id`, no shared role, and its own `platform_admins` table with RLS
enabled and **zero policies** (`REVOKE ALL FROM anon, authenticated`,
same lockdown as `admin_login_codes`) — no client call can ever read or
write it, so the only way in is the Edge Function below using the
service-role key.

1. **Migration:** apply `061_platform_admins.sql`.
2. **Secrets:** none new — only the auto-injected `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY`. No email step in this pass.
3. **Deploy:**
   ```bash
   supabase functions deploy platform-console
   ```
   `supabase/functions/platform-console/index.ts` — actions:
   - `whoami` — confirms the caller is an active `platform_admins` row;
     used as the console's own login/session gate.
   - `list_organizations` — all orgs + their ADMIN's name/email + shop count.
   - `create_organization` — creates the org, a temp-password auth
     account, and its first ADMIN `users` row in one call; the temp
     password is shown once in the console UI (never emailed, never
     logged) for the operator to relay manually. Best-effort rolls back
     the auth account if a later step fails.
   - `create_platform_admin` — same primitive, for provisioning a second
     operator account (no separate manual DB step needed after the
     first one).
4. **Bootstrapping the first platform admin:** the table has no
   client-side write path by design, so the very first row is created
   once via a manual `supabase.auth.admin.createUser()` + insert (ask
   Claude, or run directly with the service-role key) — never scripted
   into the repo, no plaintext password committed anywhere.
5. **Frontend:** `src/stores/platformAuthStore.ts`,
   `src/pages/PlatformConsoleLoginPage.tsx`,
   `src/pages/PlatformConsolePage.tsx` — deliberately share no code or
   state with `authStore.ts`, `RequireAuth`, `RequireRole`, or
   `AppLayout`. Visually distinct (slate/graphite, "Internal Console")
   from the real product login so it can't be mistaken for it.

## Business Profile (brand)

Apply `043_business_profile.sql` (singleton brand row: name, logo, contacts).
Admins edit it on the **Profile** page (`/app/profile`); the sidebar header and
receipts render it (fallback to the built-in "Shwe PhaLar" / static logo). The
logo upload reuses the existing `product-images` bucket — no new storage setup.

## Audit Log Rotation

Keeps `audit_logs` bounded: when it reaches **200 rows**, the oldest 200 are
archived to a CSV, emailed to every active ADMIN, and then permanently
deleted. Behaviour spec in
[04-features-workflows.md](./04-features-workflows.md#audit-log-rotation-archive--auto-delete).

### Setup

1. **Deploy the function:**
   ```bash
   supabase functions deploy rotate-audit-log
   ```
   …or paste `supabase/functions/rotate-audit-log/index.ts` into **Edge
   Functions → rotate-audit-log → Code editor** and Deploy.
2. **Secrets** — reuses the email config (set once for both functions):
   ```bash
   supabase secrets set RESEND_API_KEY=re_xxx
   supabase secrets set REPORT_EMAIL_FROM="Shwe PhaLar <onboarding@resend.dev>"
   ```
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
3. **Schedule the cron** — open `supabase/schedule_audit_rotation.sql`, fill in
   `<PROJECT_REF>` and `<SERVICE_ROLE_KEY>`, and run it in the SQL Editor. It
   enables `pg_cron` + `pg_net` and schedules a 5-minute job. (For stricter
   setups, store the service-role key in Supabase Vault rather than inlining it.)

### Verify

- `SELECT * FROM cron.job WHERE jobname = 'rotate-audit-log';` shows the job.
- Generate 200+ audit rows (or temporarily lower the threshold), wait for a
  run, and confirm: admins receive the CSV, and `audit_logs` drops to < 200.
- Run history: `SELECT * FROM cron.job_run_details ORDER BY start_time DESC;`
  and **Edge Functions → rotate-audit-log → Logs** (it returns
  `{ rotated, archived, recipients, remaining }`).

### Safety notes

- The delete runs **only after** Resend confirms the send, targeting only the
  archived ids — a failed email or missing admin email skips the delete and
  retries next run (no data loss).
- Only callers presenting the service-role key (the cron job) can invoke it.

⚠️ **Gotcha hit in production once**: running `schedule_audit_rotation.sql`
with the `<SERVICE_ROLE_KEY>`/`<PROJECT_REF>` placeholders never actually
replaced meant `cron.job` showed the job as `active` — but every single
5-minute run silently failed (`net.http_post` to a literal `<PROJECT_REF>`
domain with an invalid `Authorization` header). "Scheduled and active" is
not the same as "working" — after running the script, always check
`SELECT command FROM cron.job WHERE jobname = 'rotate-audit-log';` for any
leftover `<...>` placeholder text, and confirm at least one row in
`cron.job_run_details` has `status = 'succeeded'` before considering setup
done.

## Weekly Sales Report

Every Monday at 00:00 Asia/Yangon (Myanmar Time), emails one CSV per shop
covering the week that just ended (Mon–Sun) to every active ADMIN —
matching the countdown shown on the Sales page (`WeeklyReportCountdown`).
Email-only: unlike audit-log rotation, nothing is ever deleted.

### Setup

1. **Deploy the function:**
   ```bash
   supabase functions deploy weekly-sales-report
   ```
   …or paste `supabase/functions/weekly-sales-report/index.ts` into **Edge
   Functions → weekly-sales-report → Code editor** and Deploy.
2. **Secrets** — reuses the same Resend config as the daily report and audit
   rotation; nothing new to set if those are already configured.
3. **Schedule the cron** — open `supabase/schedule_weekly_sales_report.sql`,
   fill in `<SERVICE_ROLE_KEY>` (project URL is already filled in), and run
   it in the SQL Editor. Fires `30 17 * * 0` (17:30 UTC every Sunday == 00:00
   Monday Myanmar Time) — pg_cron runs on the Postgres server's UTC clock, so
   this is the correct way to express a Myanmar-local weekly schedule, not a
   typo.

### Verify

- `SELECT * FROM cron.job WHERE jobname = 'weekly-sales-report';` shows the
  job, and confirm the `command` column has no leftover `<...>` placeholder
  text (see the gotcha noted above — check this for **every** cron job you
  set up this way, not just this one).
- Manually invoke it once to confirm end-to-end before waiting for Sunday:
  ```bash
  curl -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/weekly-sales-report' \
    -H "Authorization: Bearer <SERVICE_ROLE_KEY>" -H "Content-Type: application/json" -d '{}'
  ```
  Response includes `{ sent, recipients, weekStart, weekEnd, totalSaleCount, shops }`
  on success. Admins should receive the email within ~30s.
- After the first real Sunday-night run: **Edge Functions →
  weekly-sales-report → Logs**, and `SELECT * FROM cron.job_run_details
  WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname =
  'weekly-sales-report') ORDER BY start_time DESC LIMIT 5;` — confirm
  `status = 'succeeded'`.

## Vercel Deployment

The app is a static SPA. `vercel.json` rewrites all routes to
`index.html` so client-side routing works on deep links.

Steps:

1. Push the repo to GitHub.
2. Import the project into Vercel.
3. **Set environment variables** in the Vercel project:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Build command: `npm run build` (default). Output: `dist/`.
5. Deploy.

### Public Repo Safety

- `.env.local` is gitignored. Verify it never lands in commits.
- Service-role keys must never be added to a `VITE_*` variable, the
  repo, or Vercel "preview" env. Use them only from private server-side
  tooling.
- The `users` table is globally readable (the UI needs it), but RLS
  blocks direct writes to all operational/audit tables. Confirm RLS is
  ON on every protected table before going public.

## Seed Data

After RLS lockdown, do **not** seed protected tables from the browser /
authenticated Supabase client. Use one of:

- the Supabase SQL editor,
- `supabase db reset` with SQL seed files, or
- a private server-side service-role script.

`src/data/seedSupabase.ts` is retained as a guarded development reference
and refuses to run unless `VITE_ALLOW_BROWSER_SUPABASE_SEED=true`. The
file should eventually move out of the browser source tree entirely
(see [09-roadmap-todo.md](./09-roadmap-todo.md)).

## Verification

After deployment, run the live verification:

- [`archive/29-live-supabase-rls-rpc-verification.md`](./archive/29-live-supabase-rls-rpc-verification.md)
  — identity mapping, RPC happy/failure paths, direct-write failures.
- [`archive/30-rls-permission-gating-checklist.md`](./archive/30-rls-permission-gating-checklist.md)
  — permission-gated SELECT RLS.
- [`archive/33-supplier-debt-payment-rpc-tests.md`](./archive/33-supplier-debt-payment-rpc-tests.md)
  — supplier debt and `record_supplier_payment`.

[08-testing-qa.md](./08-testing-qa.md) summarizes the full QA surface and
the recommended Playwright smoke tests.

## Updating an Existing Deployment

1. Apply any new SQL migrations in numeric order (live SQL editor or
   `supabase db push`).
2. Push the new frontend bundle (Vercel auto-deploys on push to the main
   branch).
3. Re-run the relevant section of the live verification checklist —
   especially after migrations that add or change RLS or RPCs.

## Common Pitfalls

| Symptom | Likely cause |
| --- | --- |
| Bootstrap stuck on "Loading data…" | One of the parallel reads in `loadData()` failed. The new `AppLayout` should show the friendly Retry surface; if it does not, check console for the `[loadData]` log. |
| "Permission denied" on a write the user should have | Check `granted_permissions` / `revoked_permissions` on the user — revokes win. Also confirm `users.is_active` is true. |
| First admin cannot sign in on a fresh install | The `users` table is empty and sign-in never creates accounts: use `/setup` (Phase G). If `/setup` says it "could not confirm", migration `067` (`app_setup_needed()`) is not applied, or the backend is unreachable. |
| "The app cannot start" screen | Backend env missing (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`) or the host differs from `VITE_SUPABASE_EXPECTED_HOST` — the build is pinned to another backend on purpose. |
| "Live stock paused — stock may be out of date" badge | The Realtime channel is down; stock is re-read from the server on the next periodic pull and on rejoin (`docs/selfhost-migration/phase-g/realtime-reconciliation.md`). Persistent = check the Realtime service / websocket path. |
| Product photo upload "Bucket not found" | Apply `016_product_images_storage.sql` (or set up the bucket via the dashboard). |
| RLS surprises | Re-read [03-database-security.md](./03-database-security.md) — direct authenticated writes to operational tables are blocked by design. Use RPCs. |
