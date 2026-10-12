# 02 · Production Dependencies — hosted Supabase project `shwephala`

Snapshot: 2026-10-11 ≈20:10 UTC. Method: `SELECT`-only SQL through the Supabase
Management API (`supabase db query --linked`), `supabase functions list`,
`supabase migration list`, `supabase secrets list` (names only), GET-only
Management API reads of auth/PostgREST/storage/organisation config, and
read-only inspection of the application repository at HEAD `ac2d663` plus the
uncommitted working tree. No row of business data was read; no secret value was
printed or stored.

Legend: **V** verified · **I** inferred · **U** unknown.

## 0. The headline facts

| Fact | Value | |
|---|---|---|
| Plan | **Free** (no PITR, no platform backups listed, no add-ons) | V |
| Project | ref `gzqiukxnzfdouwaotelx`, ap-southeast-1 (Singapore), ACTIVE_HEALTHY, created 2026-05-21 | V |
| Postgres | 17.6.1.121 (aarch64), UTC, `max_connections` 60, `shared_buffers` 224 MB, `statement_timeout` 2 min | V |
| Database size | 55 MB, of which ≈36 MB is `cron.job_run_details` (19 MB) + `net._http_response` (17 MB) | V |
| **Sales recorded** | **0** (`sales`, `sale_items`, `shifts`, `refund_void_requests`, `supplier_payments`, `purchase_orders`, `stock_transfers` all 0 rows) | V |
| Business data | 539 products, 931 product units, 956 unit prices, 176 brands, 23 categories, 18 inventory rows, 5 inventory movements (last 2026-06-10), 81 audit logs (last 2026-08-25), 4 suppliers, 1 shop, 1 organisation, 3 app users | V |
| Auth users | 10 (all email/password, all confirmed), **7 have no `public.users` row**; 1 sign-in in the last 30 days (2026-09-30); 2 verified TOTP factors; 1 live session | V |
| Storage | 1 public bucket `product-images`, 574 objects, 5.1 MB, 573 under `temp/`; 533 products reference an image, all resolve, 41 objects unreferenced | V |
| Edge functions | 5 active, all `verify_jwt=true`; user secrets `RESEND_API_KEY`, `REPORT_EMAIL_FROM` | V |
| Cron | 2 jobs (`rotate-audit-log` every 5 min, `weekly-sales-report` Sun 17:30 UTC), both succeeding; commands embed a bearer token | V |
| Migrations | `supabase_migrations.schema_migrations` has 001–061 — including 059–061, which exist **only** in the uncommitted working tree | V |

**Interpretation.** This is a fully built, catalogue-loaded system that has not
yet gone live for trading. The brief's premise of "production POS used by retail
shops with sales data" is not what the database shows. That lowers the data
risk of a migration to almost nothing today, and raises a different question:
the same free hosted project already satisfies the "zero cost" objective. See
[MIGRATION-PLAN.md](./MIGRATION-PLAN.md) §Architecture concerns.

## 1. Postgres inventory

### Extensions (must exist in the target image) — V
`pg_cron` 1.6.4 (pg_catalog), `pg_net` 0.20.0 (**installed in `public`**, not
relocatable — the schema dump will emit `CREATE EXTENSION pg_net WITH SCHEMA
public`), `pg_stat_statements` 1.11, `pgcrypto` 1.3, `supabase_vault` 0.3.1
(0 secrets), `uuid-ossp` 1.1, `plpgsql`. `pg_graphql` is **not** installed. All
are present in `supabase/postgres:17.6.1.136` (V from the upstream image's
documented extension list; confirm at G2).

### Objects — V
- `public`: 31 tables, 1 view (`rbac_assignment_violations`), 58 functions (45
  `SECURITY DEFINER`), 10 triggers, 70 indexes, **0 sequences, 0 identity
  columns** (all ids are app-generated text), 0 custom types. All owned by
  `postgres`.
- `auth`: 27 tables, schema migrations at `20260831180000` (82 rows); no custom
  triggers. `storage`: 8 tables incl. `buckets_analytics`, `buckets_vectors`,
  `vector_indexes`; 73 migrations; standard triggers only.
- Other schemas: `cron`, `net`, `vault`, `realtime`, `extensions`, `graphql`,
  `graphql_public`, `supabase_migrations`. **No `supabase_functions` schema.**
- Timestamps: all 46 `public` timestamp columns are `timestamptz` (V).

### RLS and grants — V
- 59 policies on 29 tables, all PERMISSIVE, all `TO authenticated`. No `anon`
  or `service_role` policies. `admin_login_codes` and `platform_admins`: RLS on,
  zero policies, service-role only. No table has RLS off.
- `anon` holds **full table-level grants** (incl. DELETE/TRUNCATE) on every
  public table; only RLS blocks it. Default ACLs for `postgres`/`supabase_admin`
  keep granting this to every new object.
- **All 58 public functions are executable by `anon`** (PUBLIC EXECUTE never
  revoked), including every SECURITY DEFINER RPC. `complete_stock_transfer`
  was revoked from `authenticated` (migration 052) but **remains executable by
  `anon`**. Every RPC's safety therefore rests on its internal
  `current_app_user()` checks, which fail for an anonymous JWT. Pre-existing;
  not caused by the migration; carried into [03](./03-risk-register.md) as an
  application finding to fix with a migration (`REVOKE EXECUTE … FROM anon`).

### Realtime — V
- Publication `supabase_realtime` contains exactly `public.inventory`;
  `supabase_realtime_messages_publication` holds daily `realtime.messages_*`
  partitions. 0 replication slots, 0 subscriptions at snapshot.
- Management API reported the hosted **realtime service UNHEALTHY** at snapshot
  (db/auth/rest/storage healthy). Nobody was subscribed, so the app did not
  notice. Whether the app's inventory-live channel works on hosted today is
  **U**.

### Roles — V
Platform roles present: `supabase_admin` (superuser), `postgres` (non-superuser,
`bypassrls`, `createrole`), `dashboard_user`, `supabase_auth_admin`,
`supabase_storage_admin`, `supabase_functions_admin`, `supabase_etl_admin`,
`supabase_privileged_role`, `supabase_read_only_user`,
`supabase_replication_admin`, `supabase_realtime_admin`, `authenticator`,
`anon`, `authenticated`, `service_role`. **Custom roles: none**, except
`cli_login_postgres` (a Supabase-CLI artefact created by `db query`; exclude
from the dump). The CLI roles dump already comments out reserved roles.

### Performance baseline — V
2.56 M commits / 3.1 k rollbacks since stats reset (57 days); 14 backends;
cache hit 1.00. `rotate-audit-log` drives 27 k `audit_logs_pkey` index scans.
Nothing performance-relevant to port.

## 2. Auth configuration (GoTrue, Management API) — V

| Setting | Hosted value | Self-hosted implication |
|---|---|---|
| `site_url` | `http://localhost:3000` (never changed); allow-list empty | set to the new origin (D11) |
| `jwt_exp` | 3600 s | **decision**: keep 3600 for parity, or raise to ≥ 86400 to make the app's 24 h offline cache reachable (§5, R3) |
| Signing keys | **ES256 `in_use`**, HS256 `previously_used` | hosted already signs user JWTs asymmetrically. Upstream v0.8.2 supports `JWT_KEYS`/`JWT_JWKS` (PostgREST `PGRST_JWT_SECRET=${JWT_JWKS:-${JWT_SECRET}}`, functions `SUPABASE_JWKS`). Either HS256 or ES256 works for the app (supabase-js never verifies). Any change invalidates sessions — expected |
| `disable_signup` | false | keep false: staff creation (Users page) and the explicit `/setup` first-admin page call `auth.signUp` client-side. Since Phase G the login page itself never does (`phase-g/login-signup-fix.md`) |
| `mailer_autoconfirm` | **true** | `ENABLE_EMAIL_AUTOCONFIRM=true` |
| SMTP | **null** → built-in Supabase mailer, 2 emails/hour | the app does **not** use GoTrue email (no `resetPasswordForEmail` call found; 2FA codes go through the `admin-2fa` function + Resend). SMTP on self-hosted is optional; configure Resend SMTP anyway so password recovery is possible from Studio |
| MFA | TOTP enroll + verify enabled, max 10; phone/webauthn off | pin explicitly (D9) |
| Password policy | min length 6, a required-characters rule set, HIBP off | `GOTRUE_PASSWORD_MIN_LENGTH=6`; required-characters string **U** (API returns it; copy at G2) |
| Rate limits | email 2/h, token refresh 150, verify 30, otp 30; `otp_length` 8, `otp_exp` 3600 | upstream defaults are similar except email (30/h); irrelevant with Resend |
| Sessions | no timebox, no inactivity timeout, refresh rotation on (reuse 10 s) | upstream defaults match |
| Providers | email only; no OAuth, no anonymous, no hooks, no captcha | nothing to configure |

## 3. PostgREST / API — V
`db_schema = public,graphql_public`, **`max_rows = 1000`**, extra search path
`public, extensions`. Upstream `.env.example` ships `PGRST_DB_MAX_ROWS=1000` —
keep it (D13). The app's `loadData` relies on the 1000 cap for `sales`
(explicit) and implicitly for `sale_items` (uncapped select).

## 4. Storage — V
- Bucket `product-images`: public, no size limit, no MIME allow-list. 574
  objects (561 webp, 13 jpeg), max 40 KB, total 5.1 MB. `storage.objects` has
  `version` (all non-null), `owner_id`, `user_metadata`, `path_tokens`; no
  `level` column (newer storage-api adds it; self-hosted v1.74.0 will migrate).
- References: `products.image_url` (533 rows) and the business-profile logo
  hold **absolute** `https://<ref>.supabase.co/storage/v1/object/public/…` URLs
  built by `getPublicUrl()` (V, `productImageStorage.ts`). The app displays them
  with plain `<img>`; no signed URLs, no transforms, no resumable uploads.
  Nothing references `storage.objects.id` (V: no FK, no column in `public`).
- Migration approach: download all 574 objects + md5 manifest; **re-upload by
  name** through the new storage API (so `objects` rows, versions, and on-disk
  layout are created by storage-api itself); rewrite the host part of
  `image_url` and the logo URL. Do **not** restore `storage.objects`/`buckets`
  rows from the dump (filter them out of `data.sql`); create the bucket via API
  with the same name and `public=true`.
- Storage config: 50 MB file limit, S3 protocol on, image transformation off.

## 5. Edge functions and scheduled jobs — V

| Function | Caller | External | Env (names) | Side effects |
|---|---|---|---|---|
| `admin-2fa` | client (`functions.invoke`) | Resend API | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `REPORT_EMAIL_FROM` | emails a 6-digit code to the admin; 500 before any DB access if the Resend key is missing |
| `email-sales-report` | client | Resend | same | emails CSVs to the caller's email |
| `weekly-sales-report` | `pg_cron` (`30 17 * * 0`, UTC) with service-role bearer | Resend | same | emails **every active ADMIN**, even with zero sales |
| `rotate-audit-log` | `pg_cron` (`*/5 * * * *`) with service-role bearer | Resend | same | when `audit_logs` ≥ 200: emails oldest 200 then **deletes them** (only after a 2xx from Resend) |
| `platform-console` | client (hidden `/console`) | none | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | creates auth users / orgs via `auth.admin.*` |

All five import `npm:@supabase/supabase-js@2` (bare specifier, no import map)
and use `Deno.serve`; they return `Access-Control-Allow-Origin: *`. Self-hosted
edge-runtime v1.76.2 resolves `npm:` specifiers but needs registry egress on
cold start (I; `deno-cache` volume warms after first run).

Cron commands (V, redacted): `net.http_post('https://<ref>.supabase.co/functions/v1/<fn>', headers: Authorization Bearer <service-role JWT>, body {})`.
They must be re-created on the new DB with `http://api-gw:8000/functions/v1/<fn>`
(reachable from the `db` container on the compose network) and the new key.
`cron.timezone` must remain UTC: the weekly report hard-codes UTC+6:30 in code
and the schedule assumes UTC (V). History shows a 2026-08-25 period where a
mis-templated job failed silently 288 times a day — the monitor in [09](./09-monitoring-alerting.md)
exists because of it.

`vault.secrets` is empty; no DB webhooks; no `supabase_functions` schema.

## 6. What a plain dump does and does not carry (CLI v2.115.0, V from source)

`supabase db dump` runs `pg_dump` with Supabase filters:

| Artefact | `--role-only` | schema dump | `--data-only` | Handling |
|---|---|---|---|---|
| Roles (non-reserved) | yes, **no passwords** | — | — | only `cli_login_postgres` is non-reserved → drop it |
| `public` DDL, RLS, functions, triggers, grants | — | yes (with `IF NOT EXISTS`/`OR REPLACE` rewrites) | — | restore |
| `auth`, `storage` DDL | — | **excluded** (service-owned) | — | GoTrue/storage-api create them on first boot |
| `auth.*` data (users, identities, mfa_factors, sessions, refresh_tokens, …) | — | — | **included** | restore (passwords + TOTP carry over) |
| `storage.buckets/objects` data | — | — | included | **exclude** (re-upload instead) |
| `cron.job`, `cron.job_run_details` | — | — | **included** (27 k rows, with the hosted service-role key inside `command`) | **exclude** `job_run_details`; scrub or exclude `job` and re-create |
| `net._http_response` | — | — | included (17 MB of function responses) | exclude |
| `supabase_functions.*` | — | — | included | schema absent on hosted → nothing |
| `supabase_migrations.schema_migrations` | — | excluded | excluded | re-insert the 61 version rows after restore (R34) |
| `CREATE PUBLICATION supabase_realtime` | — | **commented out** | — | create manually and add `inventory` |
| `CREATE EXTENSION pg_net WITH SCHEMA public` | — | included | — | expect it to succeed on the image; if not, `pg_net` lives in `extensions` on self-host and the search path covers it |
| Vault secrets, auth config, JWT keys, API keys, function code and secrets, storage binaries, SMTP, custom domain | no | no | no | handled explicitly in [05](./05-migration-runbook.md) |
| `SET transaction_timeout` | — | commented out by the CLI | emitted by pg_dump 17; harmless on PG17 target | — |

Consistency: a single `pg_dump --data-only` run is one repeatable-read
snapshot, so `auth` + `public` data are mutually consistent. Storage binaries
and the three dump files are separate operations → a write freeze (no uploads,
no edits) is required during the final export. Today, with 0 sales and ~1
sign-in per fortnight, "freeze" is nominal; the runbook keeps it anyway.

## 7. Application coupling to Supabase (repo audit) — V unless marked

| Area | Finding | Change needed |
|---|---|---|
| Endpoint | `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` inlined at build; one literal hosted URL in `dist/`; no runtime setting, no IPC | rebuild + release (v1.0.16) |
| Hardcoded hosted refs | only `supabase/schedule_*.sql` and a docs example | fix the two SQL files |
| Functions | `supabase.functions.invoke(name)` (3 sites) derives the URL from the base URL | none |
| Realtime | one channel on `public.inventory`, no error callback; needs publication + RLS-aware `postgres_changes` | none in code; publication on server |
| MFA | `mfa.listFactors/enroll(issuer "Shwe PhaLar")/challenge/verify/unenroll/getAuthenticatorAssuranceLevel` | none; TOTP enabled server-side |
| Storage | absolute public URLs stored in two columns | SQL rewrite after upload |
| CSP | `connect-src 'self' https: wss:`, `img-src … https:` — covers `*.ts.net` | none |
| Electron origin | production loads `file://` → `Origin: null`; upstream Envoy CORS allows `.*` (V) | verify at G2 (R24) |
| Fonts | Google Fonts in CSP → tills need general internet, not just Tailscale | none (pre-existing) |
| Phone-upload QR | built from `window.location.origin` → works only in the web build | pre-existing limitation |
| Vercel web build | exists (Hobby plan); usage **U** | decide (R36) |
| Electron updater | GitHub Releases `Lucas1792003/ShwePhaLa`, autoDownload, `allowDowngrade=false`, no code signing; latest public release **v1.0.15** | canary via pre-release (R26) |
| Uncommitted | migrations 059–061, `platform-console` function, platform console pages, `org_id` plumbing — in production, not in git | commit (O10) |

## 8. POS reliability under network failure (repo audit) — V unless marked

This section answers the brief's §11 with evidence from the current code
(`complete_sale` as defined by migration 045, outbox in
`src/stores/data/outbox.ts`, auth in `src/stores/authStore.ts`).

| Question | Finding | Consequence |
|---|---|---|
| Atomicity | `complete_sale` is one transaction: per-shop advisory lock, `FOR UPDATE` on inventory and shift rows, running per-product tally, `qty_after < 0` rejected unless override, receipt number from `count(*)` per shop/day under the lock | correct; no `CHECK (qty ≥ 0)` constraint (negatives allowed via override) |
| Idempotency | **none.** Sale id minted server-side; the client's provisional id is never sent; no idempotency key; no dedupe | a commit-then-timeout retry **duplicates the sale and the stock deduction** (F15). Same for `adjust_stock`, `record_supplier_payment`. `open/close_shift`, PO receive, transfers, refund requests reject replays by state checks |
| Does a failed HTTP response mean not committed? | **No.** supabase-js does not retry RPC POSTs; the app classifies a fetch failure as network → stages the sale offline → the outbox re-sends on reconnect | the only safe fix is server-side idempotency |
| Outbox persistence | Dexie `syncOutbox` in IndexedDB — survives restarts; **but** `persistSnapshotToLocal` clears *every* Dexie table (incl. `syncOutbox`) and is fired, not awaited, just before `drainOutbox()` on every full load | **U** at runtime whether pending entries can be lost in that race; never exercised live (docs 10) — R1.15 |
| Outbox error handling | a *thrown* error → entry stays `pending`, pass stops; a *resolved* `{error}` → entry becomes `conflict`, pass continues. supabase-js **resolves** fetch failures | a flaky link converts every pending entry into a manual "conflict" (R2) |
| Drain trigger | only after a full `loadData` (boot, offline→online, login) or manual Retry; the 30 s / 120 s delta poll does **not** drain | a sale queued because of a timeout while `navigator.onLine` stayed true waits for a restart |
| Offline window | `OFFLINE_WRITE_TRUST_MS` 2 h and `OFFLINE_SESSION_TRUST_MS` 24 h measured from `authCache.cachedAt`, refreshed **only at boot/login** | a till booted at 08:00 cannot sell offline after a 10:00 outage |
| JWT expiry offline | `getSession()` returns null when the 1 h token cannot be refreshed; `restoreSession` then treats the user as logged out before the cache is consulted | the 24 h cache is reachable only within the token's lifetime; raising `jwt_exp` on self-hosted (or refreshing the cache on contact) is required for the design to hold |
| 5xx handling | 502/503/504 are not classified as network → online checkout **fails** (not queued); during drain → `conflict` | a gateway blip fails a sale |
| Receipt consistency | offline receipts print `PENDING`; server assigns `shop-YYYYMMDD-NNNN` later; back-dated sales get the next number for their date | acceptable; reprint logging exists |
| Clock | `p_created_at` from the till clock, trusted within (−48 h, +5 min]; otherwise silently `now()`; JWT checks use the till clock | NTP on tills is a prerequisite (F19) |
| Multi-terminal | advisory lock per shop serialises checkouts; Realtime pushes inventory changes; missed changes are not replayed | fine for 1–2 tills per shop |
| Sync Conflicts UI | list, Retry, Dismiss; no edit; no server-side visibility | monitoring cannot see stuck tills (09) |

### Required application changes (before trading on *any* backend, mandatory before a 300 ms link)

| # | Change | Where | Why |
|---|---|---|---|
| A1 | Client idempotency key for `complete_sale` (`p_client_sale_id`, unique index on `sales`; RPC returns the existing sale when the key is seen again); same pattern for `adjust_stock` and `record_supplier_payment` | new migration + `saleSlice.ts`, `inventorySlice.ts`, `purchaseSlice.ts` | R1 — duplicate sales |
| A2 | In `drainOutbox`, classify a resolved `error` with `isNetworkError()` or HTTP status ≥ 500 as transient → keep `pending`, stop the pass | `outbox.ts:164-171` | R2 |
| A3 | Treat 502/503/504 as network errors in `errors.ts` | `errors.ts:42-53` | R2 |
| A4 | Drain the outbox from the periodic refresh / `pullDeltas` | `AppLayout.tsx`, `index.ts` | R2 |
| A5 | Refresh `authCache.cachedAt` on every successful server contact | `authStore.ts`, `deltaSync.ts` | R3 |
| A6 | Decide and set `GOTRUE_JWT_EXP` (≥ 24 h) or add a token-refresh-aware offline path | `.env` / `authStore.ts` | R3 |
| A7 | `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon` + default-ACL fix | new migration | §1 finding |
| A8 | Await `persistSnapshotToLocal` before draining, or exclude the outbox tables from the clear | `localSync.ts`, `index.ts` | §8 race |
| A9 | Surface pending-outbox count in the UI (`countPendingOutbox` exists, unused) | `AppLayout.tsx` | operability |
| A10 | Commit 059–061 and the platform-console code | repo | R10 |

Existing tests that cover these areas (`npm test`, 652 tests, Supabase mocked):
`outbox.test.ts`, `tableWrite.test.ts`, `localSync.test.ts`, `deltaSync.test.ts`,
`authStore.offline.test.ts`, `saleSlice.offline.test.ts`,
`saleSlice.checkout.test.ts`, `inventorySlice.offline.test.ts`,
`shiftSlice.offline.test.ts`, `purchaseSlice.offline.test.ts`,
`transferSlice.offline.test.ts`. Caveat: they model network failure as a
*rejected* promise and a *valid* session, so they pass today despite R2/R3.

## 9. Latency sensitivity (sequential round trips)

| Step | Blocking RTTs | At ≈60 ms (Singapore) | At ≈300 ms (Barrie) |
|---|---|---|---|
| Cashier login | 2 (+1 first time) | ~0.2 s | ~0.7 s |
| Admin login with TOTP | 5–6 | ~0.4 s | ~2 s |
| `loadData` | 27 parallel GETs (≈5 waves on HTTP/1.1 with 6 connections; 1 wave on HTTP/2 — **U** whether Tailscale serve negotiates h2 to the app) | ~1 s | 2–4 s |
| Open shift | 1 | — | +0.3 s |
| Scan / cart | 0 (local) | — | — |
| Checkout (F2) | 1 (`complete_sale`), UI blocks until response; F3 prints after it | ~0.15 s | ~0.4–0.5 s |
| Background | delta pull every 120 s (11 GETs), Realtime WS | — | — |

Per-sale impact is a fraction of a second; login and startup are the visible
costs. The decisive factor is not latency but the failure handling in §8.

## 10. Items that are UNKNOWN after this audit

- Whether hosted Realtime actually delivers to the app today (service reported UNHEALTHY; no subscribers).
- Pooler mode on hosted (endpoint empty) — irrelevant to the app, which uses PostgREST.
- `password_required_characters` exact string.
- Whether `pg_net` created in `public` restores cleanly on the image.
- Whether the Vercel web build has any users.
- Whether `persistSnapshotToLocal` races the outbox drain at runtime.
- ~~HTTP/2 negotiation through `tailscale serve`~~ — **verified 2026-10-11**: curl negotiates HTTP/2 to `https://lucashome.tail8a86e4.ts.net` (evidence/G2).
- ~~Electron `Origin: null` CORS~~ — **verified 2026-10-11**: gateway answers `access-control-allow-origin: null` on rest/auth/storage/functions (evidence/G2).
