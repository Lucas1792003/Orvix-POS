# 08 · Cutover and Rollback Runbook

Status: **plan**. Not scheduled. Requires gates G0–G12 passed with evidence
([10-go-no-go-checklist.md](./10-go-no-go-checklist.md)).

## 1. Facts this runbook is built on

| Fact | Source |
|---|---|
| The Supabase URL and anon key are **compiled into** the Electron app; the only way to move a till is a new release through GitHub auto-update, or a manual installer | app audit (02 §A) |
| `electron-updater` is configured with `autoDownload`, `autoInstallOnAppQuit`, checks 5 s after launch and every 4 h; `allowDowngrade` is false, so an **older** version is never auto-installed | app audit (02 §G) |
| GitHub pre-releases are ignored by `electron-updater` unless `allowPrerelease` is set (library default) — this is the canary mechanism. **U** until proven in F14 | library behaviour |
| JWT secret changes ⇒ all sessions invalid ⇒ every user logs in once; TOTP factors carry over (base32, unencrypted on hosted) **if** R1.8 passed | 04 §6, G5 |
| All money/stock writes go through RPCs that mint ids server-side; there is no client idempotency key today | 02 §POS |
| Trading hours ≈ Asia/Yangon daytime (UTC+6:30); the owner is in EDT/EST (UTC−4/−5) | docs, audit |
| Hosted Free-plan project pauses after ~7 idle days; restorable for up to 1 year | Supabase docs |

**As of 2026-10-11 the hosted database contains no sales, shifts, or
payments (V).** If the cutover happens before trading starts, the freeze is
nominal, the export is a 5 MB catalogue, tier B rollback cannot arise, and the
canary's "3 real sales" become the first sales the system ever records. The
procedure below is written for the general case so it stays valid if trading
begins first.

## 2. Pre-cutover preparation (T−7 days → T−1 day)

| # | Item | Owner | Done when |
|---|---|---|---|
| P1 | G0–G12 all passed, evidence filed | engineer | checklist signed |
| P2 | Application changes shipped and tested on the rehearsal: idempotency key for `complete_sale` (and `adjust_stock`, `record_supplier_payment`), outbox network-error classification, trust-window refresh, periodic drain (02 §POS "required changes") | engineer | R1.15 + F15 pass with no duplicates |
| P3 | **Two builds prepared and tested, neither published:** `v1.0.16` (new URL/key, includes P2) and `v1.0.17-rollback` (hosted URL/key, includes P2). Both signed-off on a Windows till | engineer | installers archived |
| P4 | Tailscale on **every** till, tagged, key expiry disabled, ACL applied, each till has opened `https://lucashome.tail8a86e4.ts.net/auth/v1/health` in a browser → `200` | owner + shop staff | per-till checklist |
| P5 | Backups running and verified on the rehearsal stack for ≥ 7 days; weekly restore test passed twice | engineer | 09 dashboard green |
| P6 | Monitoring layers A/B/C live, alerts delivered to the owner's phone (test alert sent) | engineer | screenshot |
| P7 | Staff briefed: date/time, "you will need to log in again", "authenticator app keeps working", who to call, what to do if the app shows Offline | owner | message sent |
| P8 | Hosted keep-alive ping scheduled (read-only daily `SELECT 1`) so the rollback target cannot pause | engineer | cron on cyfro-staging |
| P9 | Rollback decision authority named: **the owner** decides; the engineer executes. Abort/rollback criteria below are pre-agreed | owner | written here |
| P10 | Go/no-go call at T−1 day: weather for the house's power/Wi-Fi, no pending kernel reboot, disk free, no open incidents | both | note |

## 3. Cutover timeline (T = shop close, e.g. 21:00 MMT = 14:30 UTC = 10:30 EDT)

Target total write-freeze duration: **best case ~1.5 h, worst case 6 h**, after
which the abort path is taken (see §5). Times are cumulative from T.

| T+ | Step | Command / action | Verify | Abort trigger |
|---|---|---|---|---|
| 0:00 | **Freeze**: all shifts closed in the hosted app; staff told to stop; confirm `SELECT count(*) FROM shifts WHERE status='OPEN'` = 0 and no `sales` in the last 5 min | query via `supabase db query --linked` | counts | an open shift that cannot be closed → wait, do not proceed |
| 0:05 | **Golden export** from hosted per [05 §3](./05-migration-runbook.md): roles, schema, data (`--use-copy`), storage objects + md5 manifest, row-count manifest, cron/vault/auth-config exports | runbook | manifest file written; checksums | export error → retry once, then abort (nothing has changed) |
| 0:20 | Scrub dumps (hosted service-role key in `cron.job`, `net._http_response`) | runbook §3.4 | `grep -c eyJ` = 0 in scrubbed files | — |
| 0:25 | **Fresh stack** on `lucashome`: `sh reset.sh -y` of the rehearsal, rebuild from tag with the **production** `.env` (same secrets as rehearsal are acceptable since no till ever used them; or regenerate — decision: keep, so the RC build P3 remains valid) | runbook §2 | `docker compose ps` healthy; TLS probe | stack unhealthy after 2 attempts → abort |
| 0:40 | **Restore** roles → schema → data → sequences → publication → storage re-upload → URL rewrite → cron jobs with new key → email **unmasked** (production, not rehearsal) | runbook §4 | **row-count manifest matches exactly**; md5 manifest matches; `pg_get_functiondef` diff clean | any mismatch → fix and re-restore from scratch; > 2 attempts → abort |
| 1:10 | **Backups armed**: first base backup taken, WAL archiving confirmed, offsite sync run, golden export copied offsite | 07 | pings green | backup failure → abort (no backups, no go) |
| 1:15 | **Smoke test** with the Mac RC build: admin TOTP login, dashboard, a QA sale on a QA shop, refund, image load, Realtime, functions (`email-sales-report` to the admin) | manual | screenshots | any failure → investigate ≤ 30 min, else abort |
| 1:30 | **Publish `v1.0.16` as a GitHub pre-release** (so no till auto-updates) | `gh release create --prerelease` **(owner approves)** | assets = 12 | — |
| 1:35 | **Canary till**: install v1.0.16 manually on one till (download the installer over Tailscale/GitHub); login; open shift; **3 real sales** of real low-value stock with the owner on the phone; print receipts; close shift. Compare rows on `lucashome` | manual | sales = 3, receipts correct, stock correct, no outbox residue | failure → **rollback tier A** (§4) |
| 2:05 | **Validation window (no production sales)**: shops stay closed overnight. Monitoring watches for 8–10 h. Engineer reviews logs, backup runs, Realtime reconnects on the canary | — | zero criticals | critical → rollback tier A before opening |
| next morning −1 h | **Progressive rollout**: edit the release to a full release → all tills auto-update on launch (they check 5 s after start). Staff instructed to restart the app and log in. Confirm each till shows v1.0.16 in the sidebar | owner/staff | per-till confirmation | a till that cannot update → manual installer; if GitHub unreachable from a shop → that till stays on hosted → **do not open that shop on v1.0.15**; fix first |
| opening | **Go live**: first real sales; engineer online for the first 2 trading hours; monitoring dashboard open | — | sales flowing; p95 latency within G10 acceptance | see §5 abort conditions |
| +1 day | Post-cutover review; hosted project left untouched (keep-alive only) | — | — | — |
| +30 days | **G14**: rollback window closes; hosted project paused or deleted (owner decision); keep the golden export forever | owner | — | — |

Success criteria for declaring G13: 3 consecutive trading days with zero
critical alerts, zero duplicate sales, zero stuck outbox entries on any till,
backups green daily, p95 checkout within acceptance.

## 4. Rollback tiers — and why "the hosted DB still exists" is not a rollback plan

Hosted holds the state **as of the freeze**. Every write that lands on
`lucashome` after T is absent from hosted. A rollback that ignores this
silently deletes those sales, stock movements, shift closures, approvals, and
payments from the business's records.

| Tier | When | Writes on lucashome since T | Procedure | Data loss | Tested? |
|---|---|---|---|---|---|
| **A — clean** | any time before the first real sale (canary and validation window; the 3 canary sales are known and re-keyed by hand) | none, or the 3 canary sales | 1. Publish `v1.0.17-rollback` (hosted URL) as a full release. 2. Tills update on restart. 3. Re-key the canary sales in hosted by hand (3 receipts). 4. Unfreeze. | none | yes — P3 build tested; the release mechanics are the same as forward |
| **B — reconcile** | after real sales on lucashome | yes | 1. Freeze lucashome (close shifts). 2. **Reverse migration**: dump `lucashome` (roles/schema/data exactly as 05 §3, plus storage objects created since T) and restore **into hosted** with the same procedure (truncate + copy under `session_replication_role = replica`). Hosted's own schema is identical, so this is the forward runbook pointed the other way. 3. Rewrite image URLs back to the hosted origin. 4. Re-create hosted cron jobs (the restore drops `cron.job` rows that were scrubbed). 5. Publish `v1.0.17-rollback`. 6. Verify manifest counts on hosted = lucashome counts. | none if step 2 succeeds; the risk is the procedure itself | **partially**: the reverse restore can be rehearsed into a *second throwaway self-hosted stack* standing in for hosted (R1 add-on), but **cannot be rehearsed against the real hosted project without writing to it**. The first real execution would be the first; hence tier B is a last resort and the validation window exists to keep rollbacks in tier A |
| **C — abandon** | lucashome unrecoverable (disk dead) | yes | Restore from offsite backup to a replacement host (07 §5.3). This is **not** a rollback to hosted; hosted stays frozen as a cold spare | ≤ RPO (5 min) | yes — G8 |

Rules:
- Tier B requires the hosted DB password (not in the CLI keyring; the owner
  holds it) and `psql` against the hosted pooler. Prepare and test the
  connection string **before** cutover (read-only `SELECT 1`), store it in the
  secrets bundle.
- Any rollback (A or B) ends with hosted as the system of record and
  `lucashome` frozen; no "running both".
- During tier B, tills are offline-capable, so staff can keep selling on
  v1.0.16 against a frozen lucashome **only if** writes are blocked
  server-side (revoke `EXECUTE` on `complete_sale` from `authenticated`
  temporarily) — otherwise sales keep landing on lucashome mid-reconcile. The
  simpler rule: **stop trading during a tier-B rollback**.

## 5. Abort and rollback decision table

| Condition | Phase | Decision |
|---|---|---|
| Export or restore fails twice | T+0:05–1:10 | **Abort** (unfreeze hosted, nothing changed) |
| Manifest mismatch that cannot be explained | restore | Abort |
| Backups cannot be armed | T+1:10 | Abort |
| Smoke test fails and is not fixed within 30 min | T+1:15 | Abort |
| Canary till: any duplicate, wrong stock, missing receipt, login failure for the admin TOTP | T+1:35 | **Rollback tier A** |
| Validation window: any critical alert, backup failure, Realtime flapping | overnight | Rollback tier A |
| Rollout: > 1 till cannot update | morning | Delay opening of those shops; do not run mixed versions on one shop |
| Live: p95 checkout > 3 s sustained 30 min, or any duplicate sale, or outbox conflicts on > 1 till | day 1–3 | Owner decides: fix forward (if root cause known) or **rollback tier B** the same day (fewer writes to reconcile) |
| Live: `lucashome` down > 2 h during trading | day 1–30 | Tills continue offline (2 h write window!). Owner decides tier B vs wait. The 2-hour offline-write window makes "wait" risky beyond ~1.5 h unless the trust-window fix (P2) shipped |

Decision authority: owner. Execution: engineer. Every decision and its time are
logged in `evidence/G13/cutover-log.md`.

## 6. Downtime estimate

| Scenario | Write freeze | Assumptions |
|---|---|---|
| Best case | **~1.5 h** (T+0 → canary done), then overnight validation with shops closed anyway | export/restore of a 55 MB DB and ~a few hundred images, no surprises (R2 timing confirms) |
| Typical | 2–3 h | one restore retry, one slow till install |
| Worst case before abort | 6 h | two restore attempts + smoke-test debugging; abort returns to hosted with **zero** data impact because the freeze held |
| Rollback tier A | ~30 min + till restarts | release mechanics only |
| Rollback tier B | 2–4 h with trading stopped | reverse restore + verification; untested against real hosted |

Because the freeze starts at shop close and the validation window is the night,
the **customer-visible** downtime in the best and typical cases is zero. The
real cost is the staff restart/login in the morning.

## 7. Post-cutover writes: the explicit answer

- Before go-live: tier A, no reconciliation, proven.
- After go-live: tier B is a **full reverse migration**, mechanically identical
  to the forward one, rehearsable against a stand-in but not against the real
  hosted project. It is a last resort. The plan reduces the chance of needing
  it with the canary + overnight validation window and by watching the first
  three trading days closely, and reduces its cost by rolling back **the same
  day** if at all, while the delta is small.
- There is no supported "partial" reconciliation (replaying only new sales):
  server-minted ids, receipt-number sequences per shop/day, inventory
  movements, audit rows, and shift state are interdependent. A full-state copy
  is the only procedure that is both simple and verifiable by row counts.
