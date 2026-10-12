# Phase E · Scheduled jobs and email audit

Status: **analysis + hermetic tests, 2026-10-12**. Nothing was scheduled,
deployed or changed on `lucashome` or on hosted Supabase. No email was sent.
Legend: **V** verified (by reading code / running the tests) · **I** inferred ·
**U** unknown, to confirm on the stack.

Scope: the two `pg_cron` jobs (`rotate-audit-log`, `weekly-sales-report`) and
the two client-invoked email functions (`email-sales-report`, `admin-2fa`).
`platform-console` sends no email and has no schedule; out of scope.

## 0. Summary and recommendation

| Job / function | Trigger | What it does | Recommendation at production readiness |
|---|---|---|---|
| `rotate-audit-log` | `pg_cron` `*/5 * * * *` | when `audit_logs` ≥ 200 rows: emails the oldest 200 as CSV to every active ADMIN, then **deletes them** | **Do not schedule** at cutover. The reason it existed (bounded table on a free hosted plan) is gone; the email is the only copy after the delete and the function is not idempotent across a delete failure (§4). Decide retention per §2.2; if a bounded hot table is still wanted, implement "archive to table" (option C) and run it **daily**, not every 5 minutes |
| `weekly-sales-report` | `pg_cron` `30 17 * * 0` (UTC) = Monday 00:00 Asia/Yangon | emails one CSV per shop for the week just ended to every active ADMIN; sends a "(no sales)" notice when empty | **Enable** with the existing schedule. Read-only, 52 emails/year. Requires a **verified sender domain** in Resend as soon as there is more than one admin address (§3) |
| `email-sales-report` | admin button on `/app/sales` | emails the caller's own address the day's per-shop CSVs | Enable (nothing to schedule). Same Resend config |
| `admin-2fa` | admin login | emails a 6-digit login code; stores only its SHA-256 | Enable (nothing to schedule). Shares the Resend daily quota — this is the function that must never be starved (§6) |

Config needed on the stack: `RESEND_API_KEY` and `REPORT_EMAIL_FROM` in
`/srv/supabase/stack/.env` (already forwarded to the `functions` container by
`deploy/lucashome/docker-compose.override.yml` D7, **V**). Cron needs the
service-role key inside the job command, rendered with
`tools/selfhost-migration/render_cron.py` (procedure in §8, no key values).

Tests: 26 hermetic Deno tests under `supabase/tests/functions/` execute the
real function code with Resend, PostgREST and GoTrue mocked in-process (§7).
All pass. They also pin down three behaviours worth fixing before enabling the
jobs (§7.3).

## 1. Facts about how the jobs are invoked (self-hosted)

- `pg_cron` runs the SQL command `SELECT net.http_post(url, headers, body)`.
  `net.http_post` is **asynchronous**: it enqueues the request in
  `net.http_request_queue` and returns a request id immediately; the pg_net
  background worker performs the HTTP call later and writes the outcome to
  `net._http_response` (`status_code`, `content`, `timed_out`, `error_msg`,
  `created`). Rows there are purged after `pg_net.ttl` (6 h default). **V**
  for the mechanism (pg_net 0.20 on hosted, 02 §1); request timeout default
  **I** 5 s (`timeout_milliseconds`; confirm with `\df net.http_post`).
- Consequence 1: `cron.job_run_details.status = 'succeeded'` only proves that
  the enqueue succeeded. The 2026-08-25 incident (288 silent failures/day, 02 §5)
  is exactly this: `cron.job` showed `active`, `job_run_details` showed
  `succeeded`, and only `net._http_response` carried the failing HTTP result.
- Consequence 2: pg_cron's own overlap behaviour is irrelevant; the SQL
  command finishes in milliseconds. Nothing stops two HTTP calls from being in
  flight at once if a function run takes longer than the schedule interval.
  There is **no lock** anywhere (§4).
- Consequence 3: if the function runs longer than pg_net's timeout, pg_net
  records `timed_out = true` while the edge runtime keeps executing the
  function to completion. A "timed out" row is therefore not proof that
  nothing happened. **I** for the runtime continuing (edge-runtime does not
  cancel a handler on client disconnect in the code paths used here).
- The URL from inside the `db` container must be the compose-network address:
  `http://api-gw:8000/functions/v1/<fn>` (template default, **V**). Whether
  the Envoy gateway in `self-hosted/v0.8.2` requires an `apikey` header in
  addition to `Authorization` on `/functions/v1/*` is **U** — the hosted cron
  command sent only `Authorization`. Phase C function tests used the gateway;
  re-check with one manual `curl` from the `db` container during §8 step 6.
- `FUNCTIONS_VERIFY_JWT=true` (env.settings.md): the edge runtime verifies the
  bearer is a JWT signed with `JWT_SECRET` before the function sees it. The
  service-role key is such a JWT, so the cron call passes; the functions then
  do their own `token === SUPABASE_SERVICE_ROLE_KEY` comparison. **V** from
  the function code; the runtime's verify step **I** from upstream `main/index.ts`.
- `cron.timezone` must be UTC/GMT for `30 17 * * 0` to mean Monday 00:00 MMT
  (05 runbook already checks `SHOW cron.timezone`).
- `cron.job_run_details` is never pruned by pg_cron. Hosted accumulated 27 k
  rows / 19 MB in 94 days from the 5-minute job (02 §0). Add a weekly prune
  job (§8 step 7) whatever else is decided.
- `pg_net` must be in `shared_preload_libraries` and its worker running
  (`SELECT 1 FROM pg_stat_activity WHERE backend_type LIKE 'pg_net%'`). The
  template only creates `pg_cron`; the restored schema dump carries
  `CREATE EXTENSION pg_net` (02 §6). **U** on the stack until §8 step 2 runs.

## 2. `rotate-audit-log`

### 2.1 Exact behaviour (V, `supabase/functions/rotate-audit-log/index.ts`)

1. Refuses anything but `POST`; returns 500 if `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` or `REPORT_EMAIL_FROM` is
   missing — **before** checking the bearer (so an anonymous caller can learn
   whether Resend is configured: 500 vs 401; cosmetic).
2. Requires `Authorization: Bearer <service-role key>` (exact string compare)
   → else 401, no DB access.
3. `HEAD audit_logs?select=id` with `Prefer: count=exact`. If count < 200 →
   `{rotated:false}` and stop. Only the count query runs.
4. `GET audit_logs?select=*&order=created_at.asc&limit=200` — the oldest 200.
5. Name lookups: `users?select=id,name&id=in.(…)`, `shops?select=id,name&id=in.(…)`.
6. Builds a CSV (`Action, Actor, Branch, Entity, Message, Time, Entity Id,
   Log Id`) with a formula-injection guard on string cells.
7. Recipients: `users?select=email&role=eq.ADMIN&is_active=eq.true&email=not.is.null`.
   Zero recipients → 422, nothing deleted.
8. `POST https://api.resend.com/emails` with `from`, `to` (all admins in one
   message), subject `Shwe PhaLar — Audit log archive (200 entries, <date>)`,
   one base64 CSV attachment `audit-log-<date>.csv`. Non-2xx → 502, nothing deleted.
9. `DELETE audit_logs?id=in.(<the 200 ids>)`. Failure → 500 with
   `emailed: 200`; rows remain.

Data touched: reads `audit_logs`, `users`, `shops`; deletes from `audit_logs`.
All through PostgREST with the service-role key (bypasses RLS; migration 013
revoked audit writes from `authenticated` only).

Trace proven by the tests, in order:
`HEAD audit_logs → GET audit_logs → GET users → GET shops → GET users → POST
resend → DELETE audit_logs`.

### 2.2 Is it still required? — the retention decision

What it was for: keeping `audit_logs` small on the hosted free plan. On the
self-hosted stack none of the pressures apply:

- Disk: 730 GB free (`backup-status.sh`, 2026-10-12). An audit row is a few
  hundred bytes; even 1,000 rows/day is < 150 MB/year.
- UI: the app loads only the newest 500 rows
  (`src/stores/data/index.ts:145`, `.order(created_at desc).limit(500)`, **V**),
  so table size does not affect the Audit page.
- Backups: hourly dumps, daily base, WAL, and (Phase F) offsite copies retain
  the rows anyway — until the function deletes them, after which the only
  copy is an attachment in admins' mailboxes (a third-party mailbox is not a
  system of record, and emails get deleted).
- Today: 81 audit rows on hosted, 0 sales. The job has never had much to do.

Options (the owner decides; none is wrong, but "as-is" is the weakest):

| | Option | Change needed | Pros | Cons |
|---|---|---|---|---|
| A | Keep as-is: email + delete, threshold 200, every 5 min | none | nothing to build | non-idempotent on delete failure (duplicate emails, §4); only copy is email; 5-minute cadence can burn the Resend quota in a backlog (§6); noisy (one email per 200 rows) |
| **B** | **Do not schedule; keep all rows** | none (leave the job out of the rendered cron) | simplest; full audit history stays queryable; covered by backups | table grows without bound (slowly); revisit when > ~1 M rows |
| **C** | Archive to a table: `audit_logs_archive` (same columns + `archived_at`), moved by a `SECURITY DEFINER` RPC `archive_audit_logs(p_older_than interval, p_limit int)` in **one transaction**; cron daily; optional monthly digest email | migration + function change | transactional (no email-then-delete window); hot table bounded; history still in the DB and in backups; no Resend dependency | small build; archive table also grows (fine) |
| D | Archive to Storage: upload the CSV to a private bucket, then delete | function change | file naming is idempotent (`audit-log-<first id>.csv`), re-runs overwrite rather than duplicate; files ride along in the storage offsite sync | still upload-then-delete (two systems); CSV is less queryable than a table |
| E | Keep email + delete, raise threshold, lower frequency | the code ties batch size to `THRESHOLD` (a daily run clears at most 200 rows/day); needs `THRESHOLD` / `BATCH` split + env-driven values | fewer emails | still non-idempotent; still email-as-only-copy |

Recommendation: **B now** (zero work, zero risk), **C when a bounded hot
table is wanted**. Do not run A on the self-hosted stack.

### 2.3 Credentials and config

| Item | Where | Notes |
|---|---|---|
| `RESEND_API_KEY` | `stack/.env` (0600) → `functions` container env (override D7) | the self-hosted runtime forwards the whole container env to every function (**V** override comment; upstream behaviour) |
| `REPORT_EMAIL_FROM` | same | must be an address on a **verified domain** in Resend to deliver to more than the Resend account's own address (§3). `onboarding@resend.dev` only delivers to the account owner |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | set by upstream compose for the `functions` container | the function builds its PostgREST client from these |
| service-role key in the cron command | `cron.job.command` (readable by `supabase_admin`/`postgres` and whoever is granted the `cron` schema) | rendered by `render_cron.py` (§8); the same key the functions compare against — rotating `SERVICE_ROLE_KEY` in `.env` requires re-rendering the cron jobs or every run returns 401 |
| internal URL | `http://api-gw:8000/functions/v1/rotate-audit-log` | reachable from the `db` container only on the compose network |

## 3. `weekly-sales-report`

### 3.1 Exact behaviour (V)

1–2. Same env check and service-role bearer check as §2.1 (env first, then bearer).
3. Computes the window from `Date.now()`: most recent Monday 00:00 Asia/Yangon
   (fixed UTC+6:30, no DST) as `weekEnd`, minus 7 days as `weekStart`. The
   boundary is recomputed from the calendar, so firing **late** keeps the same
   week; firing **early** (before 17:30 UTC Sunday) reports the **previous**
   week again (test-proven: 17:29 → week of Sep 28–Oct 4). pg_cron does not
   fire early, but a wrong `cron.timezone` would — hence the UTC check.
4. `GET sales?select=…&created_at=gte.<weekStart>&created_at=lt.<weekEnd>&order=created_at.desc`
   (`[start, end)`; a sale stamped exactly Monday 00:00 MMT belongs to the
   *new* week — test-proven).
5. If no sales: fetches admins and emails a `(no sales)` notice, **ignores
   the Resend status**, returns 200 `{sent: 0}` (§7.3).
6. Else `GET sale_items?…&sale_id=in.(…)`, then `shops`, `users`
   (cashiers), `products` name lookups; one CSV per shop with sales, header
   `Report Week, Branch, Branch Code, Receipt No, Sale Date Time, Cashier Name,
   Cashier Email, Payment Method, Sale Status, Receipt Line, Price Level,
   Product Name, Product SKU, Product Alias, Unit, Quantity, Unit Price MMK,
   Item Discount %, Line Total MMK, Subtotal MMK, Sale Discount MMK, Cart
   Discount %, Total MMK, Paid MMK, Change MMK`; filename
   `weekly-sales-<shop code>-<weekStart UTC date>.csv` (note: UTC date of the
   boundary, e.g. `2026-10-04` for the week starting Monday Oct 5 MMT — cosmetic).
7. Recipients: active admins with an email (same query as §2.1); zero → 422.
8. One Resend message to all admins with every CSV attached; non-2xx → 502.

Data touched: **reads only** `sales`, `sale_items`, `shops`, `users`,
`products`. Never writes.

Still required? Yes if the admins want it — it is the product feature the UI
advertises (`WeeklyReportCountdown`, docs 04). Cost: 52 emails/year. It is
harmless to data. Keep.

Credentials/config: identical to §2.3; URL
`http://api-gw:8000/functions/v1/weekly-sales-report`. The Resend free tier
**only delivers to the account owner's address** unless a domain is verified;
with two admin addresses the send to the second is rejected (Resend returns
403/422 for the whole message), so the job fails for everyone until a domain
is verified and `REPORT_EMAIL_FROM` uses it. Today there is one admin; verify
the domain before adding the second.

## 4. Retry safety (both cron functions)

| Scenario | `rotate-audit-log` | `weekly-sales-report` |
|---|---|---|
| Resend 2xx received, then DELETE fails | Email already delivered; rows stay; response 500 `emailed: 200`. **Next run selects the same oldest 200 and emails them again** (duplicate archive email, identical CSV — test-proven), then deletes. Data is never lost; the mailbox gets duplicates and the Resend quota is spent twice | n/a (no write) |
| Invoked twice sequentially (both succeed) | Second run sees `count − 200`; if still ≥ 200 it rotates the next batch — no overlap (test-proven). This is the designed catch-up: 200 rows per 5 min = 57,600 rows/day capacity | Two identical emails for the same week. No guard (no "already sent for weekStart" record) |
| Cron fires while a previous run is still executing | **No lock.** Both runs read the same 200 rows, both email, the second DELETE matches nothing (test-proven with two concurrent in-process invocations). Possible whenever a run exceeds 5 minutes (Resend slow, 429 retry storms) | Two identical emails |
| Resend non-2xx (429/500/422) | 502, no delete, no in-function retry; the next tick retries the whole thing. A sustained Resend outage = one attempt per 5 minutes, each a full table read of 200 rows + 2 lookups | 502; **no retry until next Sunday** — a transient failure at 17:30 UTC loses that week's report unless re-invoked by hand |
| Function slower than pg_net's timeout | pg_net records `timed_out`; the function most likely completes anyway (§1) — the delete can happen after the "failure" was logged | same, harmless |
| Service-role key rotated in `.env` only | every run 401 forever, `job_run_details` still `succeeded` | same |

Ordering guarantee that *is* in place: the DELETE is issued strictly after the
Resend 2xx and targets exactly the archived ids (test-proven order and id
list). A failed send never deletes.

What would make `rotate-audit-log` idempotent: record the archived id range
(or a batch id) before sending, or move to option C (transactional move) —
not worth doing if option B is chosen.

## 5. Failure monitoring

Three places, with different meanings:

| Source | What it tells you | Query / command |
|---|---|---|
| `cron.job_run_details` | the SQL command ran (`succeeded`) or pg_cron itself failed (`failed`, e.g. extension missing, connection refused). Does **not** reflect the HTTP result | `SELECT j.jobname, d.status, d.start_time, d.return_message FROM cron.job j JOIN LATERAL (SELECT * FROM cron.job_run_details WHERE jobid = j.jobid ORDER BY start_time DESC LIMIT 1) d ON true;` |
| `net._http_response` | the HTTP outcome the function returned (`status_code`, body in `content`, `timed_out`, `error_msg`). Kept 6 h only. Does **not** store the URL, and the request id is not written to `job_run_details`, so correlation is by time only | `SELECT id, status_code, timed_out, error_msg, left(content, 160), created FROM net._http_response ORDER BY created DESC LIMIT 20;` |
| function logs | `console.*` output and runtime errors; `rotate-audit-log`/`weekly-sales-report` log nothing themselves (only the JSON response body, which lands in `content` above); `admin-2fa` logs every step | `docker compose logs functions --since 24h \| grep -E 'rotate-audit-log\|weekly-sales-report'` |

Hooks into `09-monitoring-alerting.md` (layer C, every 5 min):

- Existing row "Cron jobs: last run status ≠ succeeded or last start > 2×
  schedule → high" — keep, it catches pg_cron-level failures.
- **Add**: `SELECT count(*) FROM net._http_response WHERE created > now() -
  interval '1 hour' AND (status_code IS DISTINCT FROM 200 OR timed_out)` > 0
  → high. For the weekly job specifically, on Monday 00:00–06:00 UTC: at
  least one `status_code = 200` row with `content LIKE '%"sent":%'` since
  Sunday 17:00 UTC → else critical, and the owner re-invokes by hand
  (`curl` from inside the `db` or `functions` container with the service
  key — never from a till).
- **Optional improvement** (small SQL change, makes correlation exact): wrap
  the cron command in a tiny plpgsql block that inserts the returned request
  id into `ops.cron_http_requests(jobname, request_id, queued_at)`; the
  monitor then joins `net._http_response.id`. Not needed for option B.
- The 09 "Functions: POST /functions/v1/<probe>" row (layer B) suggests
  calling `rotate-audit-log` in dry-run mode; it has none. Use a no-op probe
  function instead, or `weekly-sales-report` with a wrong bearer and expect
  401 (proves gateway + runtime + env without sending anything).

## 6. Resend free tier vs a 5-minute schedule

Resend free: **100 emails/day, 3,000/month**, 2 requests/second, only the
account owner's address as recipient until a domain is verified (docs 07 says
the same; **V** from docs, not re-checked against resend.com today).

- Quota accounting is per *message* regardless of recipient count, so one
  weekly report to N admins costs 1. Fine.
- `rotate-audit-log` sends 0 emails/day while `audit_logs` < 200. With a
  backlog it sends **one email per 5 minutes** until the table is below 200:
  a backlog of 20,000 rows (100 batches) = 100 emails = the **entire daily
  quota in 8 h 20 min**; anything beyond gets 429 → 502 → retried every 5
  minutes (288 attempts/day) until midnight UTC resets the counter.
- The quota is **shared** with `admin-2fa`. While rotation is burning it, an
  admin cannot receive a login code (TOTP still works). This is the concrete
  reason not to run A/E on a shared free-tier key, or to put `admin-2fa` on a
  separate Resend key/account if rotation-by-email is ever kept.
- `weekly-sales-report` + `email-sales-report` + `admin-2fa` in normal use:
  ~1/week + ~1/day + a few/week ≈ 40–60/month. Nowhere near the limits.
- Rate limit (2 rps) is irrelevant at these volumes.

## 7. Hermetic tests

### 7.1 What was built

`supabase/tests/functions/` — run with `./supabase/tests/functions/run.sh`.

- `_harness.ts`: stubs `Deno.serve` to capture each function's handler, then
  dynamically imports the **unchanged** `supabase/functions/<fn>/index.ts`.
  Replaces `globalThis.fetch` with an in-process router:
  `https://api.resend.com/emails` → `MockResend` (records every call;
  configurable 200/429/500/422 and checks the bearer is the configured key);
  `<SUPABASE_URL>/rest/v1/<table>` → `MockPostgrest` (in-memory tables; parses
  exactly the filters supabase-js emits: `eq`, `in.(…)`, `is.null`,
  `not.is.null`, `gte`, `lt`, `ilike`, `order`, `limit`, `select`,
  `Prefer: count=exact` on HEAD, object-Accept for `maybeSingle`, POST/PATCH/DELETE,
  forced failures per method+table; asserts every call carries the
  service-role `apikey` + bearer); `<SUPABASE_URL>/auth/v1/user` →
  `MockAuth` (bearer → user or 401). Anything else throws.
- Four test files, 26 tests, listed in the output below. Supabase-js
  (`npm:@supabase/supabase-js@2`, resolved to 2.117.3 at run time) is the real
  library.
- Deno: **not installed** on this Mac. The runner uses the official npm
  package (`npx --yes deno@latest`, Deno 2.9.6) when `deno` is absent; the
  first run fetches `@supabase/supabase-js` into Deno's global cache, after
  which it runs offline. `deno.json` sets `nodeModulesDir: none` and
  `lock: false` so nothing is written into the repo (verified: no
  `node_modules`, no `deno.lock`).
- Permissions: `--allow-env` and `--allow-read=<repo>/supabase/functions`
  only. **No `--allow-net`.** A request that escaped the mocks is refused by
  Deno itself — verified separately:
  `NotCapable: Requires net access to "api.resend.com:443"`.
- No database, no email provider, no server, no hosted project is contacted.

### 7.2 Output (2026-10-12, second run, cache warm)

```
running 4 tests from ./admin_2fa_test.ts
admin-2fa: missing RESEND_API_KEY → 500 before any DB or auth call ... ok (76ms)
admin-2fa: refuses missing / invalid bearer and non-admin callers; never emails, never writes ... ok (7ms)
admin-2fa: request stores only the SHA-256 hash and emails the code; verify consumes it; wrong code counts an attempt ... ok (12ms)
admin-2fa: Resend 500 → 502 (hash row already inserted — documents current behaviour) ... ok (1ms)
running 5 tests from ./email_sales_report_test.ts
email-sales-report: refuses missing / invalid bearer and non-admin callers; never emails ... ok (36ms)
email-sales-report: per-shop attachments → one email to the caller only, CSVs byte-identical after base64, filenames kept ... ok (2ms)
email-sales-report: legacy single-CSV payload still produces one attachment; missing subject → 400 ... ok (1ms)
email-sales-report: admin matched by email fallback (no auth_id link), case-insensitive; Resend 500 → 502 ... ok (1ms)
email-sales-report: missing REPORT_EMAIL_FROM → 500 before auth and before any DB call ... ok (121µs)
running 11 tests from ./rotate_audit_log_test.ts
rotate-audit-log: refuses a caller without the service-role bearer (no DB call, no email) ... ok (33ms)
rotate-audit-log: below threshold → no email, no delete ... ok (3ms)
rotate-audit-log: at threshold → one email with a CSV of exactly the oldest 200; delete only after the 2xx ... ok (8ms)
rotate-audit-log: Resend 500 → no delete, non-2xx response ... ok (3ms)
rotate-audit-log: Resend 429 → no delete, non-2xx response ... ok (1ms)
rotate-audit-log: Resend 422 → no delete, non-2xx response ... ok (1ms)
rotate-audit-log: Resend 2xx but DELETE fails → rows stay, 500 with emailed count; the NEXT run re-emails the same 200 (duplicate) ... ok (3ms)
rotate-audit-log: invoked twice sequentially drains in 200-row batches without duplicates ... ok (9ms)
rotate-audit-log: two CONCURRENT invocations (no lock) → both email the same 200 rows; data is safe but the email is duplicated ... ok (3ms)
rotate-audit-log: no active admin email → 422 and nothing deleted ... ok (1ms)
rotate-audit-log: missing RESEND_API_KEY → 500 before auth and before any DB call ... ok (311µs)
running 6 tests from ./weekly_sales_report_test.ts
weekly-sales-report: refuses a caller without the service-role bearer (no DB call, no email) ... ok (33ms)
weekly-sales-report: emails every active admin the Mon-00:00-Yangon week window computed from a fixed clock ... ok (14ms)
weekly-sales-report: cron jitter after the boundary keeps the same week; firing BEFORE Monday 00:00 MMT reports the previous week ... ok (1ms)
weekly-sales-report: zero sales → still emails every active admin a '(no sales)' notice ... ok (698µs)
weekly-sales-report: Resend 500 → 502 (with sales); but in the zero-sales path the failure is swallowed (documents current behaviour) ... ok (1ms)
weekly-sales-report: no active admin email → 422, no email ... ok (698µs)

ok | 26 passed | 0 failed (336ms)
```

### 7.3 Findings the tests pin down (candidate fixes, not applied)

| # | Function | Finding | Suggested fix |
|---|---|---|---|
| F1 | `rotate-audit-log` | not idempotent across a DELETE failure or a concurrent run: the same 200 rows are emailed again | moot under option B; under C the move is one transaction |
| F2 | `weekly-sales-report` | zero-sales path ignores the Resend status and returns 200 — a failed "(no sales)" email is invisible to every monitor | check `resendResponse.ok` there too and return 502 |
| F3 | `weekly-sales-report` | no retry: a transient Resend failure at 17:30 UTC Sunday loses the report until manual re-run | monitor row in §5 + a documented manual re-invoke; or a second cron tick at 18:30 UTC that only sends if the first did not (needs a sent-marker, e.g. a row in an `ops.report_runs` table) |
| F4 | `admin-2fa` | the hash row is inserted before the send; on a Resend failure the 30 s cooldown still blocks the retry | insert after the send, or delete the row on send failure |
| F5 | both cron functions | env check precedes the bearer check → unauthenticated callers can distinguish "Resend not configured" (500) from "unauthorised" (401) | reorder; cosmetic |
| F6 | `weekly-sales-report` | attachment filename uses the UTC date of the week boundary (`…-2026-10-04.csv` for the MMT week starting Oct 5) | format with the MMT date; cosmetic |

## 8. Rendered-cron procedure (production readiness; no key values)

Prerequisite decisions: option for `rotate-audit-log` (§2.2, recommended B),
Resend domain verified, `RESEND_API_KEY` + `REPORT_EMAIL_FROM` in `stack/.env`
and the `functions` container recreated so it sees them
(`docker compose up -d functions`).

1. **Template edit (if option B):** in
   `tools/selfhost-migration/sql/recreate_cron.sql.template` keep the
   `cron.unschedule(...)` line (so a restored hosted job is removed) and
   delete or comment out the `rotate-audit-log` `cron.schedule(...)` block.
   Add `CREATE EXTENSION IF NOT EXISTS pg_net;` next to `pg_cron`. Expect
   `1 row` from the final `SELECT` instead of 2.
2. **Pre-checks in the db container** (`docker compose exec -T db psql -U
   supabase_admin -d postgres`): `SHOW cron.timezone;` → `GMT`/`UTC`;
   `SELECT extname, extversion FROM pg_extension WHERE extname IN
   ('pg_cron','pg_net');` → both present; `SELECT 1 FROM pg_stat_activity
   WHERE backend_type LIKE 'pg_net%';` → one row (worker alive);
   `SELECT jobid, jobname FROM cron.job;` → expect 0 rows.
3. **Render on `lucashome`** so the key never leaves the host: rsync
   `tools/selfhost-migration/{render_cron.py,_common.py}` and
   `sql/recreate_cron.sql.template` to a 0700 temp dir; in that shell export
   `SERVICE_ROLE_KEY` from `/srv/supabase/stack/.env` **without echoing it**
   (the script reads the key from the environment only, validates it looks
   like a JWT, and never prints it); run
   `python3 render_cron.py --out /srv/supabase/stack/recreate_cron.sql`
   (default `--functions-base-url http://api-gw:8000/functions/v1`). Output
   is created 0600. `unset SERVICE_ROLE_KEY`.
4. **Apply:** `docker compose cp recreate_cron.sql db:/tmp/recreate_cron.sql`
   then `docker compose exec -T db psql -U supabase_admin -d postgres -v
   ON_ERROR_STOP=1 -f /tmp/recreate_cron.sql`.
5. **Verify without printing the key:** `SELECT jobid, jobname, schedule,
   active, command LIKE '%{{%' AS has_placeholder, command LIKE '%<%' AS
   has_angle_placeholder, length(command) FROM cron.job;` → expected rows,
   both booleans `false` (the 07 docs gotcha). Never `SELECT command`.
6. **Prove one end-to-end call before Sunday:** from the `db` container,
   `SELECT net.http_post(url := 'http://api-gw:8000/functions/v1/weekly-sales-report',
   headers := (SELECT jsonb_build_object('Content-Type','application/json',
   'Authorization', substring(command from 'Bearer [^'']+')) FROM cron.job
   WHERE jobname = 'weekly-sales-report'), body := '{}'::jsonb);` (reads the
   header out of the stored job rather than retyping the key), wait 10 s,
   then `SELECT status_code, timed_out, left(content, 200) FROM
   net._http_response ORDER BY created DESC LIMIT 1;` → `200` and
   `{"sent":…}`; the admin inbox receives the previous week's report. If the
   gateway returns 401/403 without an `apikey` header, add
   `'apikey', <same key>` to the template's `jsonb_build_object` and re-render
   (the §1 **U**).
7. **Housekeeping job** (same file or separately):
   `SELECT cron.schedule('prune-cron-history', '0 3 * * 1', $$DELETE FROM
   cron.job_run_details WHERE end_time < now() - interval '14 days'$$);`
8. **Clean up:** delete `/srv/supabase/stack/recreate_cron.sql`,
   `docker compose exec db rm /tmp/recreate_cron.sql`, remove the temp render
   dir, and clear the shell history line that exported the key.
9. **Record** in `work/docs` (per the docs routing rule) the date, the jobs
   scheduled, and the `net._http_response` evidence of step 6.
10. **Rotation rule:** whenever `SERVICE_ROLE_KEY` changes, repeat steps 3–6;
    the stored commands hold the old key.

## 9. Open items / uncertain

- §1 gateway `apikey` requirement on `/functions/v1/*` (**U**, resolved by step 6).
- pg_net default timeout value on this build (**I** 5 s).
- Resend free-tier terms as of today (recipient restriction, 100/day) are
  taken from docs 07; re-read resend.com before enabling.
- Whether the owner wants the audit history at all beyond 500 rows — decides
  B vs C.
- The tests exercise the function code, not the edge runtime's JWT
  verification, the Envoy route, or pg_net; those are covered by step 6 and
  by the Phase C function tests.
