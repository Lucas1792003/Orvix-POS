# Phone-upload rate limiting (migration 081)

**Status 2026-10-13: implemented and tested locally. NOT deployed.** Nothing
was applied to or changed on lucashome; the server was only read (Envoy route
layout, by `grep`). The deploy steps in §8 need owner approval.

Follows the measurements and plan R1–R5 in
[`../phase-g/phone-upload-jit.md`](../phase-g/phone-upload-jit.md) §3 "Rate
limiting". Before 081 there is no limit: 50 sequential and 50 concurrent token
requests for one session all got 200 (§3 there).

## 1. The problem

- **Load, not capability.** Extra tokens give no extra capability: one path,
  `upsert:false`, at most one distinct token per second. Each accepted call
  costs about 6 internal requests (4 PostgREST reads, a storage HEAD, a storage
  sign). The home server is shared with the tills.
- **Who can do it.**
  - Anyone holding a QR token can call the function in a loop (~25/s per
    connection).
  - A signed-in user can create sessions without limit.
  - Anyone with the public anon key can send invalid tokens. Each costs one
    indexed lookup.
- **Exposure.** Tailnet only (`tailscale serve`, Funnel off).

## 2. Design

Three layers. Only the first two are needed. The third is optional.

| Layer | What | Where | Key |
|---|---|---|---|
| A. Token issue (R1 + per-org part of R3) | Each signed-token issue is claimed **in the database before storage is called**: lock the session row, lock the org counter row, decide, and increment only if every limit allows. | `public.claim_phone_upload_token_issue(p_token)` (081), called by `phone-upload-token` with the service role | session (from the QR token), organization (the session creator's `org_id`) |
| B. Session creation (user part of R3) | At most N sessions per creating user per rolling hour. Calls are serialised per user with `pg_advisory_xact_lock`. | `create_product_image_upload_session` (081 hunk) | `created_by` |
| C. Optional global bucket (R4) | One Envoy token bucket for the function route only, so a flood never reaches the functions container and the POS API keeps its capacity. | `deploy/lucashome/envoy-phone-upload-ratelimit.yaml` (prepared, not applied) | none (whole route) |

Why the counters live in the database:
- edge-runtime runs several workers and recycles them, so an in-memory counter
  is per worker and is lost on recycle;
- the database is already the authority for the session;
- one transaction with row locks makes the count exact under concurrency. This
  is proven with parallel sessions in §6.

### 2a. `claim_phone_upload_token_issue(p_token text) → jsonb`

- **Type and access.** `SECURITY DEFINER`, owner `postgres`,
  `search_path=public`. **EXECUTE for `service_role` only** (revoked from
  PUBLIC, anon and authenticated). The anon surface stays exactly 3 functions.
- **Steps, in order:**
  1. Token length 32–512, else `invalid`.
  2. Look up the session by `token_hash` with **`FOR UPDATE`**. Concurrent
     claims for the same session queue here. No row → `invalid`.
  3. `v_now := clock_timestamp()`, taken **after** the lock, so a queued caller
     sees the real time.
  4. Not PENDING, or expired → `{reason:"inactive", status}`.
  5. The creator's org must exist, else `refused`.
  6. Lifetime cap. `token_issue_count >= 20` → `rate_limited`, scope
     `session`, `retry_after` = seconds until the session expires.
  7. Burst. A fixed 10 s window with ≥ 5 tokens → `rate_limited`, scope
     `session_burst`, `retry_after` = seconds until the window ends.
  8. Org window. Upsert, then lock (`FOR UPDATE`) `phone_upload_org_rate(org_id)`.
     A fixed 60 s window with ≥ 60 tokens → `rate_limited`, scope `org`.
  9. Everything allowed: increment the org counter and the session counters.
     Returns `{allowed:true, issued, remaining}`.
- **Lock order.** Always session, then org. `complete_` takes only the session
  row, so no deadlock is possible.
- **Refusals never write.** Refused attempts don't count, so a caller who
  keeps hammering does not push the window further out.
- **Never raises** for a caller-controlled condition.

### 2b. New schema

**`product_image_upload_sessions`** gets three new columns:
- `token_issue_count int NOT NULL DEFAULT 0`
- `token_window_start timestamptz`
- `token_window_count int NOT NULL DEFAULT 0`

Table-level grants are unchanged. The existing RLS still applies: the creator
can SELECT their own rows, and nobody can UPDATE through the API (harness:
0 rows).

**`public.phone_upload_org_rate`** has `org_id` PK, with an FK to
`organizations ON DELETE CASCADE`, so QA cleanup removes it. It also has
`window_start` and `issued`.
- RLS on, owner `postgres`.
- **No privileges for anon, authenticated, service_role or PUBLIC.** Only the
  definer function touches it.
- Because it has no grantee rows, the 065 hosted-grants parity check is
  unaffected.

### 2c. Per-user session limit (in `create_product_image_upload_session`)

This is the 079 body plus one hunk. The diff against 079 is only the
declarations and the block below:
1. After the permission checks, take
   `pg_advisory_xact_lock(hashtextextended('pimg-create:'||user, 81))`.
2. Count the user's sessions with `created_at > now() - 1 hour`. The existing
   index `(created_by, created_at DESC)` covers it.
3. At ≥ 120: `RAISE 'Too many phone upload links were created. Try again in N
   minutes.' USING ERRCODE = 'PT429'`. PostgREST turns `PTxyz` into HTTP xyz,
   so the desktop gets **HTTP 429**. This was verified through a real PostgREST
   v14.17 (§6). The desktop modal shows the message as it already does for RPC
   errors.

### 2d. Function behaviour (`supabase/functions/phone-upload-token/index.ts`)

- **Order of checks.** The existing checks 1–6 run first, then the claim, then
  storage. Invalid, inactive and refused requests never reach the claim. A
  rate-limited request never reaches storage, and that includes the
  `alreadyUploaded` HEAD.
- **429 response.** `429 {"error":"Too many upload attempts. Please wait a
  moment and try again.","code":"rate_limited","retry_after_seconds":N}`.
  - It has a `Retry-After: N` header. N is an integer clamped to 1–3600.
  - It has `Cache-Control: no-store`.
  - CORS exposes `Retry-After`.
  - The limiter scope is logged, not returned.
- **Fail closed.** Any of these gives `503 unavailable` and **no token**:
  - an RPC error, including the function missing on a pre-081 schema,
    permission denied, or a timeout;
  - any answer that is not exactly `allowed === true` or a well-formed refusal.
- **Unchanged.** The 60 s signed-upload lifetime and every other response.

### 2e. Phone page (`src/pages/PhoneProductImageUploadPage.tsx`, `src/lib/productImagePhoneUpload.ts`)

- `requestPhoneUploadTarget` maps 429 / `code:"rate_limited"` to
  `PhoneUploadRateLimitedError(retryAfterSeconds)`. The wait comes from the
  body, else the `Retry-After` header, else 10 s.
- `uploadPhoneProductImage` waits out a 429 by itself (Retry-After + < 1 s
  jitter) when **all** of these hold:
  - the wait is ≤ 60 s;
  - the wait ends before the link expires;
  - it has retried fewer than **3** times in this upload.

  Otherwise the error goes to the page. The stale-token refresh (one fresh
  token after an expired token) still works after a wait.
- `adviseOnRateLimit()` decides between `wait` (short), `later` (try again in
  ~N min; the page goes back to "ready" so the user can pick again) and
  `linkExhausted` (the wait outlasts the link, i.e. the per-session cap → "This
  upload link has been used too many times. Create a new QR code on the
  computer.").
- **i18n.** All the page's texts now come from the `phoneUpload` section of
  `src/i18n/translations.ts`, in English and Myanmar. The page also has an
  EN/မြန်မာ switch, which persists through the existing language store. The
  English strings are unchanged, and spec D matches them verbatim.
  - Wording: `src/lib/phoneUploadMessages.ts`.
  - While waiting, the status line counts down: "Too many attempts right now.
    Trying again automatically in N s...".
- **Older phone pages** (before this build) show the server's message on a
  429 ("Too many upload attempts..."), because any non-410/404/403 answer
  becomes a plain error with that message. They do not retry automatically.

## 3. Numbers and why

| Limit | Value | Legitimate worst case | Margin |
|---|---|---|---|
| Tokens per session, lifetime | **20** | 1 per pick. A stale or lost-response retry adds 1, and a double tap or race adds 1. A user who retries a failing pick 5–6 times uses ≤ 12. | Every spec D case needs ≤ 2 tokens. 30/65/120/300 s: 1 each. Stale: 2. Double tap: 1. Race: 2. Lost response: 2 (token + alreadyUploaded). Expired/cancelled: 0 (410 before the claim). |
| Tokens per session per 10 s | **5** | Race (2) + its stale retry (1), or double tap + lost response, is ≤ 3 in a few seconds. | Real use is ≤ 1 token per second. 5 allows two simultaneous retry pairs. |
| Tokens per org per 60 s | **60** | Several staff photographing products at once: one upload ≈ 1–2 tokens, about one photo per 10 s each → < 30/min even with 4 phones. | 2×. Abuse with one QR is already capped at 5/10 s per session. This bounds many sessions at once. |
| Sessions per user per rolling hour | **120** | Bulk cataloguing: one session per product photo, plus re-opened QR modals. 120/h is one every 30 s, sustained for an hour. | The harness and live suites create ≤ 45 per user per run. |
| Envoy route bucket (optional) | **20 burst, +10/s** | All phones together: a handful of requests per minute. | Protects the functions container from floods with invalid tokens, which no DB limit can key. |

**Fixed windows.** The 10 s and 60 s windows are fixed, not sliding. At a
window boundary up to 2× the limit can pass in a short span: 10 per session,
120 per org. The lifetime cap of 20 and the per-session row lock still bound
this. A sliding window would need a log table, which is not worth it for a
load limit. The per-user hour is a rolling count, so it is exact.

**60 s token lifetime.** Kept, as the owner decided. 081 does not touch storage
or `UPLOAD_SIGNED_URL_EXPIRATION_TIME`.

## 4. What is not limited by the database, and why

- **Invalid tokens** (random 128-hex) cost one indexed lookup and get the same
  404. There is no session or org to key on.
  - Keying on the client IP is useless: Envoy sees every request from
    `tailscale serve` on loopback.
  - Layer C (the global route bucket) bounds the cost instead.
- **Concurrent uploads per org** are bounded by the token window, not by the
  PUTs themselves. Storage enforces `upsert:false`, so one object per session.

## 5. Tailscale identity headers: investigated, deliberately not used as a key

Tailscale's docs (kb/1312 "Serve", identity headers) say:
- Serve adds `Tailscale-User-Login`, `Tailscale-User-Name` and
  `Tailscale-User-Profile-Pic` for tailnet users;
- it **strips client-supplied values of those headers**;
- it does **not** set them for traffic from **tagged devices** or for Funnel.

So through serve the header cannot be forged. It is still not used, for these
reasons:

1. **Envoy can be reached without serve.** Envoy listens on `0.0.0.0:8000` in
   its container: the compose network (aliases `envoy`/`kong`) and
   `127.0.0.1:8000` on the host. Any container on that network, or any process
   on the host, can send `Tailscale-User-Login: <anyone>` directly. Neither
   Envoy nor the function can tell that request from one that came through
   serve.
2. **It is not per device.** The shop's phones are usually signed in to the
   tailnet as the same owner account, so one bucket would cover every phone.
   Tagged devices get no header at all, so they would share an
   "unauthenticated" bucket.
3. **It adds nothing to layer A.** Layer A already keys on things the attacker
   cannot choose: the session the QR token resolves to, and that session's
   organization.

If a per-client Envoy limit is ever wanted, it must first:
- restrict the Envoy listener to the serve path only (bind and network);
- reject any request that lacks the header.

That is a gateway change outside this task.

## 6. Test evidence (2026-10-13, all local)

| Suite | Command | Result |
|---|---|---|
| Phase D harness, all migrations | `POS_TEST_CONTAINER=phf-rl-db POS_TEST_PORT=55481 bash supabase/tests/phase-d/run.sh` | **564 assertions, 0 failed** (519 before 081 + **45 new** in t17), RESULT: PASS; 081 applied twice (idempotent) |
| Phase D harness, capped at 080 | `POS_TEST_MAX_MIGRATION=080 … run.sh` | **519, 0 failed**, PASS (081 is additive; t17 skipped) |
| Deno hermetic function tests | `bash supabase/tests/functions/run.sh` | **51 passed** (42 before + 9 new) |
| Local end-to-end (real function + real PostgREST + harness DB with 081, storage stubbed) | `bash supabase/tests/rate-limit-local/run.sh` | **12/12 passed**, and the harness inside it 564/0 |
| Envoy snippet | `bash supabase/tests/rate-limit-local/envoy/test.sh` | config valid on envoy v1.39.1; 40 concurrent → 20×200 + 20×429 (`Retry-After: 1`); another function 40×200; refill → 200 |
| Unit tests | `npm test` (no LIVE env) | **792 passed**, 54 skipped (baseline 774 + 16 rate-limit/i18n + 2 page; +5 skipped = the post-081 live tests) |
| Types | `npx tsc -b` | clean; eslint clean on every touched file |

**Harness t17.**
- *Static and grants:*
  - definer, owner and search_path;
  - EXECUTE for service_role only, with no PUBLIC ACL entry;
  - anon still has exactly 3 functions;
  - `phone_upload_org_rate` has no grants for anon, authenticated, service_role
    or PUBLIC, has RLS on, and is owned by postgres;
  - anon and an org ADMIN cannot call the claim or reset the counters;
  - even service_role cannot read the counter table.
- *Sequential behaviour:*
  - burst 5 → 6th and 7th refused, with retry 1..10;
  - a refusal leaves the row md5 and the org counter unchanged;
  - the answer has only the whitelisted keys;
  - the window resets after 10 s and is still closed at 9 s;
  - lifetime: the 20th is allowed, the 21st is refused with retry = lifetime
    left, and it stays refused after the window resets; after expiry →
    inactive/EXPIRED;
  - inactive, invalid, hash-as-token and id-as-token are refused and not
    counted;
  - org: the 60th is allowed and the 61st refused (retry ≈ 55 s); the refused
    session is not counted; org-two is unaffected; a new window opens after
    60 s;
  - FK cascade.
- *Concurrency.* Parallel psql sessions fired from run.sh:
  - 40 claims queued behind a session-row lock held for 2 s (wall 2 s) →
    exactly 5 allowed (issued 1..5 once each) and 35 `session_burst`; counters
    5|5;
  - 70 claims over 14 sessions → exactly 60 allowed, 10 `org`; org counter 60
    = the sum of the session counters, each ≤ 5;
  - 6 parallel creates at 118/120 → exactly 2 OK and 4 PT429; the user has 120.
- *Per-user (sequential):*
  - fill to 120 → the 121st and 122nd get PT429 with N in 1..60 minutes, and no
    row is written;
  - once one of AX's sessions ages past 60 min, AX gets exactly one more;
  - AA is still refused (the limit is per user).

**Local end-to-end.** `supabase/tests/rate-limit-local/` has five parts:
- the harness DB, kept;
- PostgREST v14.17 with a random JWT secret;
- a node gateway with a storage stub;
- `supabase/edge-runtime:v1.76.2` running this repo's function with a
  service-role JWT minted from that secret;
- a host driver.

All containers are named `phf-rl-*`, sit on network `phf-rl-net`, and are
removed on exit. No secret is printed. Results:
- 5×200, then the 6th → 429 with body and Retry-After; DB counters 5|5; after
  Retry-After → 200 (6|1);
- 30 concurrent → exactly 5×200 / 25×429;
- 65 requests over 13 sessions → 60/5;
- lifetime cap → 429 Retry-After 600;
- **fail closed:** EXECUTE revoked → 503 and the stub signed nothing; function
  renamed (as on a pre-081 schema) → 503; restored → 200;
- per-user: the 121st create through PostgREST → **HTTP 429, code PT429**,
  message as above;
- anon and authenticated cannot call the claim through PostgREST (401/403).

The run redefines `auth.uid()` to also read `request.jwt.claims`, as GoTrue's
own migrations do on a real stack. The bare postgres image reads only
`request.jwt.claim.sub`.

**Limits of the local run.** Storage is a stub. The real storage-api behaviour
(60 s tokens, `upsert:false`, duplicate refusal) is covered by phase-g4 and
spec D. Envoy, tailscale serve and GoTrue are not in that stack.

**Prepared for after deployment. Not run against lucashome.**
- `src/live/phase-g4.live.test.ts`: tests 9–13 run only when
  `max(schema_migrations.version) >= 081`:
  - 9: burst, Retry-After, window reset, then the upload completes; invalid
    tokens still 404;
  - 10: 30 concurrent → 5;
  - 11: lifetime cap;
  - 12: org window 60/5, with org B unaffected;
  - 13: per-user 121st → HTTP 429.

  Test 8 (the unlimited pre-081 measurement) now skips when the schema is
  ≥ 081. `beforeAll` accepts ≥ 080 and asserts that the limiter exists exactly
  when the schema says 081.
- `e2e/d-phone-upload.e2e.ts`:
  - `D-ratelimit-wait`: 5 tokens are taken right before the pick. The phone
    gets a real 429, shows the wait message, retries by itself after
    Retry-After, and the upload completes once.
  - `D-ratelimit-used-up`: the counter is set to 20. The phone shows the "new
    QR" message, with no PUT and no completion.
  - Both are skipped when the schema is < 081.

## 7. Optional Envoy layer (prepared, not applied)

File: `deploy/lucashome/envoy-phone-upload-ratelimit.yaml`. It is two edits to
`volumes/api/envoy/lds.template.yaml`:
1. A `envoy.filters.http.local_ratelimit` HTTP filter (no bucket) placed
   before `envoy.filters.http.router`.
2. A route `functions-v1-phone-upload-token` (exact path) placed **before**
   `functions-v1-all`. It is the same cluster, rewrite, timeout, header,
   basic_auth-disabled and RBAC-allow-all as that route, plus a per-route
   bucket: 20 burst, +10/s, `Retry-After: 1`, `Cache-Control: no-store`.
   Beyond the bucket Envoy answers `429 local_rate_limited`. The phone maps
   that to its normal rate-limit path with a 1 s wait (the header fallback).

Apply only after layer A has run for a while, and only with owner approval:
1. Back up the file.
2. Make the two edits.
3. `docker compose up -d --force-recreate api-gw` (the entrypoint renders the
   template).
4. Smoke test with the 404 probe in §8.
5. Check that `curl -s 127.0.0.1:9901/stats | grep phone_upload_token_rl`
   works from inside the container, if admin is enabled.

Rollback: restore the backup and recreate `api-gw`. Recheck the CORS headers on
Envoy's own 429 after applying. The local check has no CORS filter, so it could
not test this.

## 8. Deploy procedure (owner approval required; nothing done)

**Order: 081 first, then the function, then (optionally) the web build and
Envoy.**
- The new function fails closed (503) without 081.
- The deployed function ignores 081.
- Old clients work with both.

1. **Migration 081.** Use the standard script. It runs pre-flight, a fresh
   logical + base backup, records the LSN, applies everything in one
   transaction, records versions, hardens default ACLs, and runs verification:
   ```sh
   deploy/lucashome/apply-migrations.sh --from 081 --to 081 --dry-run
   deploy/lucashome/apply-migrations.sh --from 081 --to 081
   ```
   - The script's verification must show `anon-executable:
     app_setup_needed,complete_product_image_upload_session,get_product_image_upload_session_by_token`
     (still 3).
   - The migration's own DO block aborts the transaction if the limiter is not
     owned by postgres or is executable by anon or authenticated.
   - Extra checks (`docker compose exec -T db psql -U supabase_admin -d
     postgres -Atc "…" </dev/null`):
     ```sql
     SELECT has_function_privilege('service_role','public.claim_phone_upload_token_issue(text)','EXECUTE'),
            has_function_privilege('anon','public.claim_phone_upload_token_issue(text)','EXECUTE'),
            has_function_privilege('authenticated','public.claim_phone_upload_token_issue(text)','EXECUTE'); -- t|f|f
     SELECT count(*) FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name='phone_upload_org_rate';                                -- 0
     ```
2. **Function.** Use the same rsync as the first deploy
   (deploy/lucashome/README.md "Edge functions"):
   ```sh
   rsync -a --delete --exclude .DS_Store supabase/functions/phone-upload-token/ \
     <host>:<stack>/volumes/functions/phone-upload-token/
   ```
   No restart is needed. Workers pick up the new code within about 30 s;
   `docker compose restart functions` forces it at once. No env change.
3. **Smoke test** (writes nothing): POST `{"token":"short"}` with the anon
   bearer to `/functions/v1/phone-upload-token` → `404 invalid`. Then run, with
   the LIVE env set as for the other live suites:
   - `npx vitest run src/live/phase-g4.live.test.ts` (tests 9–13 now run);
   - `npx playwright test e2e/d-phone-upload.e2e.ts` (the D-ratelimit cases
     now run).

   Both use QA tenants only. Clean up with the usual `cleanup.sql` +
   `verify_clean`. The org counter rows go with the QA orgs through the FK
   cascade.
4. **Web build / desktop release.** Ship the phone page's 429 handling and the
   i18n with the next web build. It is not required for safety.
5. **Optional:** Envoy (§7).

**Rollback.**
- Function: rsync the previous `index.ts` from git (`git show
  <previous>:supabase/functions/phone-upload-token/index.ts`). It ignores the
  limiter.
- Database: re-run 079's `create_product_image_upload_session` block (with its
  grants), then
  `DROP FUNCTION public.claim_phone_upload_token_issue(text); DROP TABLE public.phone_upload_org_rate;`.
  The three columns may stay. Always roll the function back **first**, because
  the new function without the RPC refuses every upload (503).
- Envoy: §7.
- **Forward recovery:** 081 is idempotent; re-run it.

## 9. Files

| File | Change |
|---|---|
| `supabase/migrations/081_phone_upload_rate_limits.sql` | new: counters, `phone_upload_org_rate`, `claim_phone_upload_token_issue`, per-user limit in `create_product_image_upload_session` |
| `supabase/functions/phone-upload-token/index.ts` | claim before storage, 429 + Retry-After, fail closed |
| `supabase/tests/phase-d/sql/t17_rate_limits.sql`, `t17_rate_limits_b.sql`, `run.sh` | 45 assertions incl. three parallel races (gated ≥ 081) |
| `supabase/tests/phase-d/sql/t01_permissions_rls.sql` | function inventory: +1 service_role-only function after 081 (same conditional pattern as 077–080) |
| `supabase/tests/functions/phone_upload_token_test.ts` | limiter model in the fixture; traces include the claim; 9 new tests |
| `supabase/tests/rate-limit-local/` | local end-to-end (run.sh, gateway.mjs, main/index.ts, driver.mjs) + Envoy check (envoy/) |
| `src/lib/productImagePhoneUpload.ts` | `PhoneUploadRateLimitedError`, `adviseOnRateLimit`, bounded auto-retry |
| `src/lib/phoneUploadMessages.ts` | phone page wording helpers |
| `src/pages/PhoneProductImageUploadPage.tsx` | i18n (EN/MY + switch), waiting countdown, rate-limit messages |
| `src/i18n/translations.ts` | `phoneUpload` section (en + my) |
| `src/lib/productImagePhoneUpload.rateLimit.test.ts`, `src/pages/PhoneProductImageUploadPage.test.tsx` | 16 + 2 tests |
| `src/live/phase-g4.live.test.ts`, `e2e/d-phone-upload.e2e.ts` | post-081 cases (skipped before 081) |
| `deploy/lucashome/envoy-phone-upload-ratelimit.yaml` | optional Envoy layer (not applied) |
