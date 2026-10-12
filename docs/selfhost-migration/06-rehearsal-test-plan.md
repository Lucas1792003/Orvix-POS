# 06 · Rehearsal and Failure-Injection Test Plan

Status: **plan only; no test has been run**. Every result cell in this document
is blank until executed, and no gate may cite this document without an attached
evidence log (command output, screenshots, or exported query results stored in
`docs/selfhost-migration/evidence/<gate>/`).

## 1. Rehearsal principles

1. Hosted production is **read-only** throughout: dumps and object downloads only.
2. The rehearsal stack is the eventual production stack directory
   (`/srv/supabase/stack`) so that the procedure rehearsed is the procedure used.
   Isolation comes from the fact that no till is on the tailnet yet and from the
   neutralisation steps below, not from a different location.
3. **Side effects are neutralised by construction**, not by care:
   - `RESEND_API_KEY` is **absent** in rehearsal 1. Every one of the five edge
     functions returns HTTP 500 before touching data or sending mail when the key
     is missing (verified in code: `admin-2fa`, `email-sales-report`,
     `weekly-sales-report`, `rotate-audit-log`; `platform-console` sends no mail).
   - `rotate-audit-log` **deletes** audit rows after a successful email. It and
     `weekly-sales-report` are run by `pg_cron`; cron jobs are **not scheduled**
     until the email-safety step (1.4) is in place.
   - Every email address in the restored copy (`auth.users.email`,
     `public.users.email`, `raw_user_meta_data`) is rewritten to a Resend test
     address (`delivered@resend.dev` family, uniquified with `+tag`) **before**
     any function gets a Resend key. Real staff can never be emailed from the
     rehearsal.
   - No external financial operation exists in this system (no payment gateway).
4. Test accounts (`qa-cashier`, `qa-manager`, `qa-admin`) are created **in the
   rehearsal copy only**, via the app's own user-management RPCs, and deleted
   before the final cutover restore (the final restore starts from a fresh
   hosted dump anyway).
5. The rehearsal is executed **twice**: R1 interactively with notes, R2 by
   destroying the stack (`reset.sh`) and rebuilding **only** from the runbook
   ([05-migration-runbook.md](./05-migration-runbook.md)) with no improvisation.
   Any step that needed improvisation in R2 goes back into the runbook and R2
   is repeated.

## 2. Rehearsal 1 (R1) — step list and what each proves

| # | Step | Proves | Evidence to capture |
|---|---|---|---|
| R1.0 | Prerequisites: Phase 0 items from [10-go-no-go-checklist.md](./10-go-no-go-checklist.md) G0–G1 complete | — | checklist |
| R1.1 | Build empty stack from tag `self-hosted/v0.8.2` per runbook §2; `docker compose ps` all healthy; `tailscale serve` up; from the Mac: `curl https://lucashome.tail8a86e4.ts.net/auth/v1/health` | G2: empty stack works over Tailscale TLS | `docker compose ps`, curl outputs, `tailscale serve status` |
| R1.2 | Reboot `lucashome` (this also applies the pending kernel) → everything returns without manual action within 5 min | G3 | `uptime`, `docker compose ps`, probe log from the Mac |
| R1.3 | Export from hosted per runbook §3 (roles/schema/data dumps + storage objects + manifests) with **row-count manifest** taken in the same minute | consistent snapshot | manifest file, dump sizes, checksums |
| R1.4 | Scrub the dumps per runbook §3.4 (hosted service-role key in `cron.job`, `net._http_response` rows) and record diffs | no hosted secret enters the new stack | `grep -c eyJ` before/after = N → 0 |
| R1.5 | Restore per runbook §4 (roles → schema → data with triggers off → sequences → publication → storage re-upload → URL rewrite) | G4 | psql log with `ON_ERROR_STOP`, row-count comparison table (every public table, `auth.users`, `auth.identities`, `auth.mfa_factors`, `storage.objects`) |
| R1.6 | Email masking (1.3) applied; verify `SELECT count(*) FROM auth.users WHERE email NOT LIKE '%@resend.dev'` = 0 | safety | query output |
| R1.7 | Schema parity: `pg_dump --schema-only` of rehearsal vs hosted schema dump, normalised diff; `pg_get_functiondef` of all 40+ public RPCs byte-compared; `pg_policies` compared; `has_function_privilege('authenticated', …)` for every RPC compared | G4 | diff output (expected: only owner/ACL lines for platform roles) |
| R1.8 | Auth: cashier login with migrated password; **admin login with the migrated TOTP factor** (the real admin, using the real authenticator app, against the rehearsal with their masked email); `getAuthenticatorAssuranceLevel` reaches `aal2`; add a second factor on the Security page; remove it; email-code path tested only after 1.3 masking **and** with a Resend key present (R1.12) | G5 — TOTP migration is **unproven until this passes** | screenshots, `auth.mfa_challenges` rows, `auth.sessions.aal` |
| R1.9 | RLS/RPC: run the August 2026 live-verification checklist (`docs/archive/29-…` and `30-…`) against the rehearsal with the QA accounts; specifically re-confirm the 20-table `authenticated_all` leak is closed, `users` read-scoping, self-approval guards, `complete_stock_transfer` revoked, `log_audit_event` allow-list | G5 | checklist with pass/fail per line |
| R1.10 | Realtime: subscribe with the app (or a Node script with the **anon** key) as a cashier; `UPDATE inventory` on a QA product from psql; the change arrives; a change on another shop's row does **not** arrive for a shop-scoped user | G6 | script output |
| R1.11 | Storage: every `products.image_url` resolves with HTTP 200 over the new origin; md5 of each downloaded object equals the hosted manifest; upload a new image through the app; phone-upload QR flow noted as web-only (pre-existing) | G6 | script output: `N URLs, N 200s, N md5 matches` |
| R1.12 | Edge functions with **Resend key present and emails masked**: `admin-2fa` email code to `delivered@resend.dev` (observed in Resend dashboard); `email-sales-report` from the app; `weekly-sales-report` invoked manually with the service key; `rotate-audit-log` invoked manually on a copy where `audit_logs` ≥ 200 → email observed → rows deleted (**on rehearsal data only**); `platform-console` login + `list_organizations` | G6 | Resend log entries, function logs, row counts before/after |
| R1.13 | Cron: `pg_cron` + `pg_net` enabled; both jobs created with the internal URL; `cron.job_run_details` shows a succeeded run within one schedule period; `cron.timezone` = UTC | G6 | query output |
| R1.14 | Electron: build v1.0.16-rc locally (`npm run electron:build:win` / `:mac`, **not published**) pointing at the rehearsal; run on the Mac and on one Windows machine; full cashier day: login → open shift → scan → F2 → F3 print → refund request → manager approve → close shift; admin: dashboard, reports, product edit, image upload, user create | G5/G6/G12-prep | screenshots, `sales` rows |
| R1.15 | Offline cycle on the Electron build: pull the Tailscale/Wi-Fi link → sell 3 items → reconnect → outbox drains → server rows appear once, receipt numbers assigned, stock correct. **Repeat with the link cut during the `complete_sale` request** (see failure test F15) | the cycle `docs/10` says was never exercised live | outbox table before/after, `sales` count, `inventory` before/after |
| R1.16 | Automated test suite on the Mac: `npm test` (652 tests) — passes, with the caveat that it mocks Supabase | regression | output |
| R1.17 | Backups per [07](./07-backup-disaster-recovery.md): base + WAL + dumps + offsite sync + **restore from R2 into a throwaway container** + secrets bundle decrypt on the Mac | G8 | job logs, restore counts |
| R1.18 | Latency: from the Mac (Toronto-area) and from **one real shop device** once it has Tailscale: 100× `GET /rest/v1/shops?select=id` with anon key → p50/p95; `tailscale ping lucashome` → direct or DERP; a scripted `complete_sale` of a QA sale → wall time | G10 | CSV of timings |
| R1.19 | Failure injection F1–F16 (§4) on the rehearsal stack | G9 | per-test log |

## 3. Rehearsal 2 (R2) — rebuild from the runbook only

1. `sh reset.sh -y` (destroys the rehearsal stack, including `db-config`).
2. Delete `/srv/supabase/stack`.
3. A second person (or the owner on a different day) follows
   [05-migration-runbook.md](./05-migration-runbook.md) literally from §2 to §5
   using the **same** dump files as R1 (not a fresh export), timing each section.
4. Compare: row-count manifest identical to R1; schema diff identical; R1.8,
   R1.10, R1.11 re-run and pass; total wall time recorded (this is the cutover
   duration estimate).
5. Every deviation from the written runbook is a defect in the runbook. Fix and
   repeat R2 until it runs clean. **G7 = one clean R2.**

## 4. Failure-injection tests (G9)

Run on the rehearsal stack only, never on hosted and never on `lucashome` while
tills depend on it. "POS continues?" refers to the Electron app's offline mode
as it exists today (see [02-production-dependencies.md](./02-production-dependencies.md) §POS
for its limits: 2-hour offline write window measured from boot/login, and the
JWT-expiry constraint).

| # | Test | How to inject | Expected behaviour | Detection | Recovery | Integrity check | Max acceptable recovery | POS continues? |
|---|---|---|---|---|---|---|---|---|
| F1 | Postgres container dies | `docker kill supabase-db` | all API calls fail within seconds; compose restarts `db` (`unless-stopped`); dependents reconnect | layer-C collector critical within 5 min; app toasts | automatic; if not, `docker compose up -d db` | `pg_isready`; `sales` count unchanged; WAL archive resumes | 5 min | yes (offline mode) |
| F2 | Gateway dies | `docker kill supabase-envoy` | same, restarts automatically | layer-B probe within 3 min | automatic | — | 5 min | yes |
| F3 | Full server reboot (clean) | `sudo reboot` | all containers back, `tailscale serve` persists, cert still valid | heartbeat gap ≤ 10 min | none | counts; archive continuity | 10 min | yes |
| F3b | Power loss (dirty) | hold power button (battery removed/drained is not testable; simulate with `echo b > /proc/sysrq-trigger` — needs root) | Postgres crash-recovers; no corruption; ext4 journal replays | same | none; if PGDATA corrupt → 07 §5.1 | `pg_amcheck`/`pg_dump` succeeds; counts vs last dump | 30 min | yes |
| F4 | Tailscale down on server | `sudo systemctl stop tailscaled` 10 min | tills lose API; local services fine | layer-B critical; layer-A heartbeat still OK (distinguishes from F3) | `systemctl start tailscaled` | — | 15 min | yes |
| F5 | Internet down at the house | disconnect Wi-Fi 15 min | same as F4 from the tills' view; backups' offsite sync fails and retries | layer-A heartbeat missed (host cannot ping out) | reconnect; verify `tailscale status` recovers without manual login | archive continuity; offsite catch-up | 15 min | yes |
| F6 | DNS failure (MagicDNS) | on a till: block `100.100.100.100` or set a wrong resolver | app cannot resolve `lucashome.tail8a86e4.ts.net`; falls to offline mode | app offline badge | fix resolver; fallback: none (IP-based URL would need a rebuild) | — | — | yes |
| F7 | Expired / invalid credentials | rotate `ANON_KEY` on server without rebuilding app; separately revoke a user's refresh token | 401 → app classifies as **permission** error → checkout fails, not queued (known gap) | app error toast; layer-B probe with old key fails | never rotate keys without a release; user re-login | — | — | **no** for the affected till until fixed |
| F8 | Disk exhaustion | `fallocate` a file to fill `/srv` to 99 %, then `/` | Postgres refuses writes (PANIC risk if WAL cannot be written); archive fails | layer-C disk thresholds (should fire at 50 GiB free, long before) | delete the file; `docker compose restart db` if needed | `pg_isready`; no data loss expected (WAL fsync) | 30 min | yes |
| F9 | Memory pressure | start a 10 GiB `stress-ng --vm` or load a 14B ollama model | with container limits (D4): Postgres survives, stress process OOM-killed; without limits: unpredictable | PSI and swap thresholds | kill the hog; confirm limits are set | counts | 15 min | yes |
| F10 | Corrupted backup | flip bytes in the latest base tar in R2 (test copy) | `pg_verifybackup`/restore test fails loudly | weekly restore-test ping fails | use previous base + WAL; investigate | restore from N-1 succeeds | 2 h | n/a |
| F11 | Storage unavailable | `docker stop supabase-storage` | images 5xx; sales unaffected; uploads fail with friendly error | layer-B storage probe | `docker start` | object count unchanged | 15 min | yes |
| F12 | Edge function failure | remove `RESEND_API_KEY`; invoke `admin-2fa` | email-code login fails with 500; TOTP login unaffected; `rotate-audit-log` cron fails before deleting anything | cron run status failed; function logs | restore env; `recreate functions` | `audit_logs` count unchanged | 1 h | yes (cashiers); admins via TOTP |
| F13 | Interrupted restore | kill `psql` halfway through `data.sql` | `--single-transaction` ⇒ nothing applied; DB empty of data, schema intact | restore script exit code | re-run restore from scratch (idempotent by construction: fresh stack) | counts = 0 then = manifest after re-run | 1 h | n/a |
| F14 | Failed Electron update | publish a broken RC to a **test** GitHub repo or block GitHub on a till | old app keeps running against the old URL; nothing breaks until hosted is retired | manual version check per till | reinstall known-good NSIS; `allowDowngrade` is false so no automatic rollback | — | 1 h per till | yes |
| F15 | Network cut **during** `complete_sale` (after server commit, before response) | on a till: `iptables`/Windows firewall rule dropping packets to lucashome applied 100 ms after pressing F2 (scripted), or Tailscale disconnect at that moment | **Today:** app sees a fetch failure → classifies as network → stages the sale offline → on reconnect the outbox **re-sends** `complete_sale` → **duplicate sale and double stock deduction**. **Required:** after the idempotency fix (02 §POS), the replay is a no-op returning the existing sale | duplicate-sale query in 09 | manual void of the duplicate today | `sales` count = +1 not +2; `inventory` delta once | — | yes, but with corruption risk until fixed |
| F16 | Concurrent inventory operations | two tills (or two scripted clients) sell the last 3 units of a product simultaneously; a manager adjusts stock at the same time | advisory lock + `FOR UPDATE` serialise; second sale rejected with insufficient stock (unless override) | — | — | `inventory.qty_base_units` ≥ 0; movements sum = qty | — | yes |
| F17 | Duplicate transaction submission (double-click, two tabs) | press F2 twice fast; replay the same outbox entry twice from Sync Conflicts | UI disables Confirm while processing (verified); outbox entry deleted on success so manual Retry cannot double-send; **manual Retry of a `conflict` entry whose RPC actually committed will duplicate** (same root cause as F15) | duplicate-sale query | manual void | — | — | — |
| F18 | Tailscale node key expiry | set key expiry to 1 day on the rehearsal node and wait, or `tailscale logout` | node drops off the tailnet; everything looks like F4 | layer-B critical; KeyExpiry monitor | `tailscale up` with re-auth; disable expiry | — | 30 min | yes |
| F19 | Clock skew on a till | set the till clock +10 min / −2 h | +10 min: server stamps `now()` silently (sale time ≠ receipt time); JWT refresh churn. −2 h: back-dated sales accepted; expired-looking JWTs → 401 → checkout **fails** | failed-login / 401 spikes | NTP on tills (Windows time sync) | sale timestamps vs receipt | — | degraded |

## 5. Tests from actual shop devices (G10)

Ping is not evidence. For each shop, on a real till with Tailscale installed:

1. `tailscale ping lucashome` ×20 → note direct vs DERP and the relay region.
2. 100× `GET /rest/v1/shops` with the anon key → p50 / p95 / max / failures.
3. 20× scripted `complete_sale` of a 1-item QA sale on a QA shop → wall time.
4. One full cashier day on the rehearsal with the RC build during real opening
   hours, in parallel with the real hosted app (double entry on a QA shop only,
   never on the real shop): count sales, compare timings, note every error.
5. Two tills in the same shop selling simultaneously for 10 minutes (F16).
6. Pull the shop's internet for 10 minutes mid-session; reconnect; verify the
   outbox drained and nothing duplicated (F15 scenario on real hardware).
7. Record Myanmar ISP packet loss over 24 h (`mtr` to the Tailscale IP) — losses
   above ~2 % make the DERP path unreliable for WebSocket Realtime.

Acceptance (proposed, owner to confirm): checkout p95 ≤ 1.5 s, login ≤ 4 s,
`loadData` ≤ 8 s, zero duplicates, zero stuck outbox entries, Realtime
reconnects within 30 s of link recovery.

## 6. Evidence log format

`docs/selfhost-migration/evidence/<gate>/<yyyy-mm-dd>-<test>.md` with: who ran
it, exact commands, raw output (secrets redacted), pass/fail, follow-ups. Gates
in [10-go-no-go-checklist.md](./10-go-no-go-checklist.md) link to these files.
