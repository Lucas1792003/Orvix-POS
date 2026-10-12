# Shwe Pha Lar POS — Hosted Supabase → Self-hosted on `lucashome`

**Master plan and audit summary.** Prepared 2026-10-11 from read-only
inspection only. **Nothing has been migrated, exported, started, or changed.**
Status of every gate: see [10-go-no-go-checklist.md](./10-go-no-go-checklist.md).

| Document | Contents |
|---|---|
| [01-infrastructure-audit.md](./01-infrastructure-audit.md) | `lucashome` hardware, OS, Docker, ports, Tailscale, firewall, power, backups, location, capacity |
| [02-production-dependencies.md](./02-production-dependencies.md) | hosted project inventory, auth/API/storage config, dump coverage, application coupling, POS reliability findings, required app changes |
| [03-risk-register.md](./03-risk-register.md) | 39 risks with probability, impact, detection, prevention, recovery, validation, status |
| [04-target-architecture.md](./04-target-architecture.md) | pinned versions, topology, the 18 deviations from upstream and why, secrets, network/ACL, latency profile |
| [05-migration-runbook.md](./05-migration-runbook.md) | exact export → scrub → restore → verify procedure; stack build; release build |
| [06-rehearsal-test-plan.md](./06-rehearsal-test-plan.md) | rehearsal 1 and 2, failure-injection tests F1–F19, shop-device tests |
| [07-backup-disaster-recovery.md](./07-backup-disaster-recovery.md) | RPO/RTO, WAL archiving, base backups, encrypted offsite (R2 + Mac), restore tests, recovery procedures |
| [08-cutover-rollback.md](./08-cutover-rollback.md) | timed cutover runbook, canary, validation window, rollback tiers A/B/C, post-cutover write reconciliation |
| [09-monitoring-alerting.md](./09-monitoring-alerting.md) | three monitoring layers, thresholds, escalation |
| [10-go-no-go-checklist.md](./10-go-no-go-checklist.md) | gates G0–G14 with pass criteria, evidence, stop/rollback; approval checkpoints; owner prerequisites |

---

## 1. Current readiness: **NOT READY** (and one premise of the brief is wrong)

G0 is partially complete (both inventories done). Nothing else has started.
Beyond the gates, two findings change the decision itself:

1. **Production has never recorded a sale.** `sales`, `sale_items`, `shifts`,
   `purchase_orders`, `stock_transfers`, `supplier_payments` are all **0 rows**
   (verified 2026-10-11). The database holds a catalogue (539 products, 931
   units, 956 prices, 574 images = 5 MB), 18 inventory rows, 3 app users, 1 shop,
   and 1 sign-in in the last 30 days. The brief describes a live retail
   backend; the data describes a system that is built but not yet trading.
2. **The hosted project is on the Free plan.** It already costs nothing. The
   stated primary objective — "completely free" — is met today. Self-hosting
   on `lucashome` saves $0 and adds every availability and security risk in
   [03](./03-risk-register.md) §A. What self-hosting *does* buy is
   independence from Supabase's free-tier terms (500 MB DB, 1 GB storage, 7-day
   inactivity pause, no platform backups, policy changes) and data on hardware
   you own.

The plan below remains valid if the owner still chooses `lucashome` with those
facts in view. The decision is G1.

## 2. Critical risks (ranked)

| Rank | Risk | Why it is critical | Doc |
|---|---|---|---|
| 1 | **Duplicate sales on commit-then-timeout** — `complete_sale` has no idempotency key; the client re-sends on reconnect | money and stock corruption, more likely on a 300 ms relayed link | 02 §8, R1 |
| 2 | **Offline queue turns network failures into manual "conflicts"** and only drains after a restart/login | stranded sales per till, invisible to monitoring | 02 §8, R2 |
| 3 | **Offline writes blocked after 1–2 h** (trust window from boot, JWT 1 h) | the offline-first safety net does not work for a full trading day | 02 §8, R3 |
| 4 | **Host availability**: consumer laptop, Wi-Fi only, residential ISP, 3 crashes in the last 5 boots, pending reboot, no UPS daemon, single NVMe of unknown health | hours-long outages are a matter of when, not if | 01, R4 |
| 5 | **No backups exist today** anywhere on `lucashome` (and the hosted Free plan has none either) | — | 01 §8, R5 |
| 6 | **Rollback after real sales = untestable reverse migration into hosted** | mitigated by canary + no-sales validation window; irrelevant until trading starts | 08 §4, R6 |
| 7 | **Hosted service-role key rides inside the data dump** (`cron.job` commands) | leak if dumps are mishandled | 02 §6, R9 |
| 8 | **Host security**: sshd on all interfaces with probable password auth, firewall state unknown, public services and tunnels on the same box, docker-group user | compromise of a hobby box = compromise of the business DB | 01 §6, R12 |
| 9 | **Every RPC is executable by `anon`** on hosted today (pre-existing) | defence rests on in-function checks | 02 §1, A7 |
| 10 | **Production schema is not in git** (059–061 applied, uncommitted) | rebuild-from-source is impossible; dump is the only truth | 02 §0, R10 |

Risks 1–3 and 9 are **application** defects that exist on hosted Supabase
today; they must be fixed before the business starts trading on any backend.

## 3. Architecture concerns — Myanmar tills → Canada laptop

Measured: `lucashome` is in Barrie, Ontario, on Wi-Fi, behind a NAT with no
port mapping, and already fails to make a direct Tailscale path to a peer on
the same continent (relayed via Toronto DERP). Singapore DERP is 243 ms away.
Expected till RTT is 250–340 ms versus roughly 30–80 ms to the hosted Singapore
region. Per-sale impact is ~0.3 s; login and startup 2–4 s. Tolerable on
numbers alone, **provided** the application's failure handling (risks 1–3) is
fixed first; without that, a slow, relayed, occasionally lossy path will
manufacture duplicates and stranded sales.

The deeper concern is not latency but **availability and blast radius**: a
laptop on home Wi-Fi shared with Minecraft, an AI inference server, a public
tunnel, and a Funnel-exposed web app is not production infrastructure for a
retail business, however well it is hardened. Alternatives, all at zero or
near-zero cost:

| Option | Cost | Latency to Myanmar | Availability | Data control | Notes |
|---|---|---|---|---|---|
| **A. Stay on hosted Free + add your own backups and the app fixes** | $0 | best (Singapore) | Supabase SLA-less but datacenter-grade | Supabase | Recommended until trading volume or free-tier limits force a move. Add: hourly `pg_dump` + storage sync to R2 (same scripts as 07), the app fixes A1–A7, commit 059–061 |
| B. `lucashome` as specified | $0 + electricity | worst | lowest | full | this plan; needs the hardening list and the app fixes |
| C. Self-hosted on a datacenter VPS in Singapore (Oracle Always Free, now 2 OCPU / 12 GB; capacity scarce; idle reclaim) | $0 nominal | best | datacenter | full | same stack and runbook; the Oracle terms and capacity make it fragile as a sole host |
| D. Mini PC at the shop in Myanmar | one-time hardware | ~1 ms | depends on shop power (laptop-class battery helps) | full | best for an offline-tolerant POS; needs a local admin |
| E. B + A as cold standby | $0 | — | better | — | keep hosted Free as the rollback target permanently (keep-alive ping); already in the plan for 30 days |

Recommendation: **A now, revisit B/D when the business is live and the real
constraint (free-tier limits or sovereignty) materialises.** If the owner's
priority is ownership of the data rather than cost, **B with the hardening list
and app fixes** is workable, and this plan is how to do it safely.

## 4. Missing prerequisites (owner)

See [10](./10-go-no-go-checklist.md) "Prerequisites the owner must provide",
O1–O11. The blocking ones for any next step: **O1** (architecture decision),
**O3** (sudo for operator/reboot/firewall), **O10** (commit the uncommitted
schema work), **O4** (hosted DB password at export time, entered by you).

## 5. Migration compatibility

| Component | Status |
|---|---|
| Postgres 17.6 → `supabase/postgres:17.6.1.136` | **confirmed** same major/minor; aarch64 → x86_64 is irrelevant for logical dumps |
| Extensions (pg_cron, pg_net, pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault) | **confirmed present** in the image per upstream docs; `pg_net` schema placement to confirm at G2 |
| `public` schema, RLS, 58 functions, triggers | **confirmed** dumpable; all owned by `postgres`; no sequences, no custom types |
| Auth users + passwords | **confirmed** in the data dump (official restore guide) |
| TOTP factors | **plausible**: 2 verified factors stored as plain base32 (not DB-encrypted); GoTrue v2.196 accepts them — **unverified until R1.8** |
| ES256 signing key on hosted | **confirmed**; self-hosted v0.8.2 supports JWKS; any key change forces one re-login — expected |
| Storage (574 objects, 5 MB, public bucket) | **confirmed** re-uploadable by name; URL rewrite required (533 rows + logo) |
| Edge functions (5) | **confirmed** portable code; `npm:` resolution and secrets injection on self-hosted edge-runtime **unverified until G6** |
| Cron (2 jobs) | **confirmed** must be re-created with internal URL + new key |
| Realtime | **unverified**: hosted Realtime reports UNHEALTHY; self-hosted needs the publication created manually |
| Gateway: Kong (hosted) → Envoy (self-hosted default) | **confirmed** same routes; CORS for Electron `Origin: null` allowed by default; to verify at G2 |
| Electron app | **confirmed** only the URL/key need changing (build-time); release via GitHub; canary via pre-release **unverified** |
| Supabase CLI migration history | **confirmed** not carried; re-insert 61 rows |

## 6. Backup and recovery strategy (summary)

WAL archiving (5-minute cap) + daily base backups + hourly logical dumps on
`lucashome`; `rclone crypt` to Cloudflare R2 (free 10 GB) as copy of record
and the Mac as deletion-resistant tier; encrypted secrets bundle; weekly
automated restore from R2 into a throwaway container; healthchecks.io dead-man
pings. **Realistic exposure after G8:** ≤ 5 min of writes on a clean failure;
up to `archive_timeout` + unsynced offsite delta (≤ 15 min) on a total host
loss. **Today's exposure on either platform: everything** — hosted Free has no
backups and `lucashome` has none. This is the first thing to fix regardless of
the architecture decision. Details: [07](./07-backup-disaster-recovery.md).

## 7. Estimated downtime

| Scenario | Write freeze | Customer-visible |
|---|---|---|
| Best case (data as of today: 55 MB, 0 sales) | ~1.5 h at shop close | none (overnight validation) |
| Typical | 2–3 h | none |
| Worst before abort | 6 h, then abort with zero data impact | none if aborted before opening |
| Rollback tier A (before first live sale) | ~30 min + till restarts | none |
| Rollback tier B (after live sales) | 2–4 h with trading stopped | yes; untested against real hosted |

Assumptions: export/restore timing confirmed by R2; tills can reach GitHub for
the update; the owner is available during the Myanmar evening (≈10:30 EDT).

## 8. Implementation phases and dependencies

```
Phase 0  Decisions & prerequisites (O1–O11) ............................ gates G0–G1
Phase 1  Backups for the CURRENT hosted project (hourly dump + storage → R2) — independent of the decision
Phase 2  Application fixes A1–A10 on a branch, tested with the existing suite + new tests
Phase 3  Host hardening on lucashome (reboot, sshd, firewall, limits, ollama policy) ... G1 evidence
Phase 4  Empty stack from tag v0.8.2 + Tailscale TLS .................. G2, G3
Phase 5  Rehearsal 1: export → scrub → restore → verify → app tests → functions → cron → Electron RC → offline cycle
Phase 6  Backups + monitoring on the rehearsal stack, 7+ days ........... G8, G9 (failure injection)
Phase 7  Rehearsal 2 from the runbook only ............................. G7
Phase 8  Tailscale on shop tills, real-device measurements ............. G10
Phase 9  Cutover (freeze → export → restore → canary → overnight validation → rollout) ... G11–G13
Phase 10 30-day window; hosted kept alive; then decide .................. G14
```
Phases 1 and 2 are valuable even if the answer to O1 is "stay on hosted".

## 9. Approval checkpoints

Ten explicit stops, listed in [10](./10-go-no-go-checklist.md) "Approval
checkpoints": architecture (G1), first server change (G2), reboot (G3), first
production export (G4), credentials for backups (G8), touching shop tills
(G10), cutover date (G11), every GitHub release, every rollback, and closing
the hosted project (G14).

## 10. First safe action after approval

Smallest next step, reversible, touching no production data and no running
service:

1. **Owner answers O1** (architecture) and **O10** (commit the uncommitted
   migrations 059–061 and platform console to a branch — this is Phase 2's
   starting point regardless of hosting).
2. If the answer to O1 is "lucashome": the engineer runs §2.1–§2.3 of the
   runbook **up to but not including** `docker compose up` — re-clone the
   release tag, copy to `/srv/supabase/stack`, generate secrets into a 0600
   `.env`, write the override, and run `docker compose config` to validate.
   No container starts, no port opens, nothing on the host changes except
   files under `/srv/supabase/`. The owner then reviews `docker compose config`
   output (secrets redacted) before checkpoint 2.
3. In parallel and independent of O1: set up the hosted-project backup job
   (Phase 1) — a read-only dump on a schedule from the Mac or `cyfro-staging`
   to R2, so that for the first time the business has a backup at all.

---

*Verified facts in these documents came from commands run on 2026-10-11; they
describe that moment. Re-verify anything older than a week before acting on it.*
