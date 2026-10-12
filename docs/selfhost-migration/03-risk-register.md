# 03 · Risk Register

Context that reframes several entries (V, 2026-10-11): production has **never
recorded a sale** (0 rows in `sales`/`shifts`), holds a 5 MB catalogue, and is
on the **Free plan**. Risks about sales data loss are therefore about the
*future* trading system, not about data that exists today; risks about the
host, the application's failure handling, and the absence of backups apply now.

Probability: Low / Medium / High. Impact: Low / Medium / Critical. Status: Open /
Mitigated / Blocked. Every "Validation" must produce an evidence file before the
status can move to Mitigated. Risks are ranked by (impact, probability).

Sources: [01](./01-infrastructure-audit.md) infra audit, [02](./02-production-dependencies.md)
production/app audit, upstream stack review, external docs. Evidence tags V/I/U
as in those documents.

## A. Critical-impact risks

| ID | Risk | P | I | Detection | Prevention | Recovery | Validation | Status |
|---|---|---|---|---|---|---|---|---|
| R1 | **Duplicate sale and double stock deduction** when the network drops after the server commits `complete_sale` but before the client receives the response; the client stages the sale offline and the outbox re-sends it. No idempotency key exists (V, `045_…sql`, `saleSlice.ts`). Same for `adjust_stock` and `record_supplier_payment` (V). Probability rises sharply on a 300 ms relayed link | High (on this link) | Critical | duplicate-sale query (09); staff notice double receipts | **Application change before cutover**: client-generated `p_client_sale_id` with a unique index; RPC returns the existing sale on replay. Same pattern for the other two RPCs | manual void of the duplicate; stock adjustment | F15 and F17 pass with +1 row, not +2 | **Open — blocks G11** |
| R2 | **Outbox turns network failures into manual "conflicts"**: supabase-js resolves fetch failures as `{error}` instead of throwing; `drainOutbox` marks the entry *and every later entry* as `conflict` (V, `outbox.ts:150-171`). A flaky link strands sales until someone opens Sync Conflicts on each till | High | Critical | stuck entries are not visible server-side; only on each till | Application change: classify resolved errors with `isNetworkError()`/status ≥ 500 → keep `pending`; drain on the periodic refresh, not only after full load | staff press Retry per entry | F15, R1.15 | Open — blocks G11 |
| R3 | **2-hour offline-write window measured from boot/login, not last contact** (V, `authStore.ts`), plus **JWT expiry (1 h) blocks the offline path** because `getSession()` returns null when the token cannot be refreshed (V). A till that boots at 08:00 and loses WAN at 11:00 cannot sell offline | High | Critical | "Reconnect to the internet to verify your session" on tills | Application change: refresh `authCache.cachedAt` on every successful server contact; set `GOTRUE_JWT_EXP` ≥ 24 h on the self-hosted stack (D12 decision) | reconnect | F5 on a till after 3 h uptime | Open — blocks G11 |
| R4 | **Home-server availability**: laptop (V), Wi-Fi-only uplink (V), residential ISP (V), 3 of last 5 boots crashed (V), pending kernel reboot (V), no UPS daemon (V), single NVMe with unknown SMART health (U). Any of these takes the backend down for hours | High | Critical | layer-A heartbeat + layer-B probe | Hardening list in G1; reboot and burn-in ≥ 14 days before cutover; wired Ethernet if at all possible; battery guard script; SMART monitoring; offline-first POS absorbs short outages (once R2/R3 are fixed) | 07 §5; tills sell offline | G3, F3/F3b, 14-day uptime record | Open |
| R5 | **No tested backup of anything**; a restore has never been performed (V: `/srv/backups` empty) | High today | Critical | — | 07 in full: WAL archiving, offsite crypt, weekly automated restore, secrets bundle | — | G8 | Open — blocks G11 |
| R6 | **Rollback after real sales requires a reverse migration** that cannot be rehearsed against the real hosted project without writing to it (08 §4 tier B). Note: production has **0 sales today** (V), so this risk only materialises if trading starts on `lucashome` and then fails | Low today / Medium once trading | Critical | — | canary + overnight no-sales validation window keep rollbacks in tier A; rehearse tier B against a stand-in; roll back same-day if ever | tier B procedure | R1 add-on: reverse restore into a throwaway stack with manifest match | Open |
| R7 | **TOTP factors fail after migration** (secrets are plain base32 on hosted — V; GoTrue v2.196 accepts them — I, unproven) → admins locked out unless the email path (needs Resend) works | Low | Critical | admin login fails on rehearsal | prove in R1.8; keep email-code path working (Resend key + SMTP) as the recovery route; document re-enrolment | admin re-enrols via email code | G5 | Open |
| R8 | **Latency makes the POS unacceptable**: Myanmar→Barrie ≈ 250–340 ms (I), possibly DERP-relayed (lucashome already fails direct to a same-continent peer — V); 27-request `loadData`, 5–6 sequential RTTs for admin login (V) | Medium | Critical (business) | G10 measurements | HTTP/2 via Tailscale serve (U), `PGRST_DB_MAX_ROWS` parity, consider wired uplink; otherwise choose a different host location (MIGRATION-PLAN alternatives) | — | G10 from real tills | Open |
| R9 | **Secrets leak via dumps**: the CLI data dump includes `cron.job` rows whose `command` embeds the hosted service-role key, and `net._http_response` bodies (V, CLI dump scripts include `cron` and `net` schemas) | High if unhandled | Critical | `grep -c eyJ` on dumps | scrub step in 05 §3.4 before any file leaves the Mac; dumps stored 0600; never in git | rotate the hosted service-role key (Dashboard) | R1.4 shows 0 matches | Open (procedure written) |
| R10 | **Production schema diverged from git**: migrations 059–061 and the platform-console function exist only in the working tree; `schema.sql` is pre-050 (V). Rebuilding from migrations would not reproduce production | Certain | Critical (for any rebuild-from-source path) | — | source of truth for the migration = `pg_dump` of hosted, never migration replay; commit 059–061 (O10) | — | R1.7 schema diff | Open |
| R11 | **Tailnet account is a single point of control**: one owner login, `lucashome` is admin/owner (V); losing it = cannot add tills, rotate keys, or fix ACLs; node key expiry 2027-03-15 (V) | Low | Critical | — | second admin; disable key expiry on server and tills; tailnet lock considered; recovery codes stored | Tailscale support process (slow) | G1 evidence | Open |
| R40 | **Every public function, including all 45 SECURITY DEFINER RPCs, is executable by `anon`** on hosted today; `complete_stock_transfer` was revoked from `authenticated` but not from `anon`; `anon` also holds full table grants and default ACLs keep re-granting (V). Safety rests entirely on each RPC's internal `current_app_user()` check | Low (checks hold) | Critical (if any RPC skips the check) | — | migration A7: `REVOKE EXECUTE … FROM anon` + default-ACL change on **both** hosted and self-hosted; applied in runbook §4.7 | — | `has_function_privilege('anon', …)` = false for all | Open (pre-existing) |
| R41 | **The migration saves no money**: the hosted organisation is on the Free plan (V). The only benefits are independence from free-tier terms (500 MB / 1 GB / pausing / no platform backups) and data ownership; every risk in this register is the price | Certain | Medium (decision risk) | — | decide G1 with this fact in view (MIGRATION-PLAN §3) | — | owner note | Open |
| R12 | **Host compromise**: sshd on all interfaces with probable password auth (I), fail2ban absent (V), firewall state unknown (U), several services and a public tunnel (playit, Funnel) on the same host (V); `lucario` is docker-group (root-equivalent) | Medium | Critical | auth log monitoring; failed-login alerts | keys-only sshd bound to Tailscale, ufw default-deny with explicit allows, remove/park public services or move them off-host, separate user for the stack, container limits | rebuild from offsite backup on a clean host | G1 hardening evidence; `ss -tlnp` after | Open |

## B. High / medium-impact risks

| ID | Risk | P | I | Detection | Prevention | Recovery | Validation | Status |
|---|---|---|---|---|---|---|---|---|
| R13 | Memory contention: Minecraft 4 GiB heap (V), ollama models (V), no container limits (V), 1.8 GiB swap in use (V) → Postgres evicted/OOM-killed | Medium | High | PSI/swap thresholds (09) | `mem_limit` on every container (D4 + existing tenants); ollama policy (no large models while live); consider `vm.swappiness=10` | automatic restart | F9 | Open |
| R14 | **Upstream clone is master, not a release tag** (V) → `update.sh` and version gating break; drift from documented images | Certain | Medium | — | re-clone at `self-hosted/v0.8.2`; `.supabase-version` set | — | G2 | Open (planned) |
| R15 | Pooler publishes 5432/6543 on all interfaces by default (V) → collides with existing 5432 and exposes Postgres | Certain | High | `docker compose up` fails or exposes port | D2 remove Supavisor | — | G2 `ss -tlnp` | Open (planned) |
| R16 | Gateway binds 0.0.0.0:8000 (V) → API reachable on LAN/Wi-Fi without Tailscale | Certain | High | `ss -tlnp` | D1 loopback bind | — | G2 | Open (planned) |
| R17 | Stale root-owned 443 listener on an old Tailscale IP (V) may conflict with `tailscale serve --https=443` | Medium | Medium | `tailscale serve status` error | test at G2; fall back to 8443 (the app URL would then carry a port) or restart `tailscaled` (clears the stale socket, needs sudo) | — | G2 | Open |
| R18 | **Edge-function side effects during rehearsal**: `rotate-audit-log` deletes audit rows after emailing; `weekly-sales-report` emails every admin (V) | High if careless | High | Resend dashboard, `audit_logs` count | no Resend key in R1 until emails are masked; cron not scheduled until then (06 §1) | restore rehearsal from dump | R1.12 | Open (procedure written) |
| R19 | `npm:@supabase/supabase-js@2` in all five functions needs registry egress on cold start in edge-runtime v1.76 (I); `deno-cache` volume empty on first boot | Medium | Medium | function 500/timeout | warm the cache at G2 by invoking each function once; pin to an exact version | — | G6 | Open |
| R20 | `cron.job` commands hardcode the hosted URL and key (V); self-hosted jobs must use `http://api-gw:8000/...` and the new key; `cron.timezone` must be UTC (V: weekly report assumes it) | Certain | High (silent failure — happened before, docs 07 §274) | `cron.job_run_details` monitor | re-create via runbook; monitor | — | R1.13 | Open (planned) |
| R21 | `products.image_url` and the logo hold absolute hosted URLs (V) | Certain | Medium | images 404 | URL rewrite step (05 §4.7) | — | R1.11 | Open (planned) |
| R22 | Storage object re-upload changes `storage.objects.id`/`version`; anything referencing object ids breaks (U — 02 §Storage checks for references) | Low | Medium | 404s | re-upload by name (names preserved); verify no FK/reference to object ids | — | R1.11 | Open |
| R23 | PostgREST `max_rows`: hosted truncates at 1000 (I); self-hosted default differs → `loadData` returns far more rows over a slow link, or fewer | Certain | Medium | `loadData` time | D13 parity | — | R1.14 timing | Open (planned) |
| R24 | Electron `file://` origin sends `Origin: null`; gateway CORS must accept it (V: Envoy allows `.*` by default — expected OK) | Low | High | app cannot call API | verify at G2 with the RC build | adjust Envoy CORS via override (would be a vendor-file edit → document) | R1.14 | Open |
| R25 | Tills cannot reach GitHub to auto-update (shop firewall/ISP) → stuck on hosted URL after hosted is retired | Low | High | per-till version check | keep hosted alive ≥ 30 days; manual installer path; verify GitHub reachability per till in P4 | manual install | G12/G13 per-till list | Open |
| R26 | Canary mechanism (`electron-updater` ignores pre-releases) unproven (U) → all tills update at once | Medium | Medium | all tills show new version | test F14 with a dummy pre-release in a test repo or with `allowPrerelease` semantics documented | — | F14 | Open |
| R27 | Realtime after reconnect does not replay missed inventory changes; `inventory` has no `updated_at` (V) → stale stock between full loads | Medium | Medium | stock mismatches between tills | pre-existing behaviour; full reload on reconnect; consider adding `updated_at` to `inventory` later | — | R1.10 | Accepted (pre-existing) |
| R28 | Till clock skew: > +5 min silently re-stamped; up to −48 h accepted; JWT handling breaks on large skew (V) | Medium | Medium | failed-login spikes | enforce NTP on tills (Windows time service) | fix clock | F19 | Open |
| R29 | Hosted Free project pauses after 7 idle days during the rollback window | High if unmitigated | Medium | dashboard email | daily read-only keep-alive (P8) | resume project (minutes) | G14 log | Open (planned) |
| R30 | Offsite backup deletable with a stolen R2 token (U whether bucket lock exists on free plan) | Low | High | — | bucket lock if available; Mac copy as deletion-resistant tier; token scoped to one bucket | restore from Mac tier | G8 | Open |
| R31 | Resend free tier: 100 emails/day (V). `rotate-audit-log` every 5 min can send up to 288/day when audit volume is high → cap hit → audit rotation stops (fails safe: no delete without 2xx) | Low | Low | Resend dashboard; cron failures | monitor; consider widening the schedule | — | — | Accepted |
| R32 | Battery: 58 % cap, 91 % health, no shutdown automation (V) → a long power cut ends in a hard stop | Medium | Medium | AC-offline alert | battery guard script with sudo rule (`shutdown` at 15 %) | Postgres crash recovery | F3b | Open |
| R33 | Docker `live-restore` off (V): a Docker daemon restart stops every container | Low | Medium | heartbeat | enable `live-restore` in `daemon.json` (host change, needs sudo; affects existing services only positively) | restart | G3 | Open |
| R34 | `_supabase`/`_realtime`/pooler schemas and `supabase_migrations` history are **not** in the dumps (V: CLI exclusion lists) → `supabase migration list` on the new DB shows nothing; future `db push` would try to re-apply 001–061 | Certain | Medium | `migration list` | re-insert the 61 version rows into `supabase_migrations.schema_migrations` after restore (05 §4.9) or adopt a fresh baseline | — | R1.7 | Open (planned) |
| R35 | Auth schema version skew: hosted GoTrue v2.195 → self-hosted v2.196 migrates `auth` forward on first boot; the data dump's `COPY` column lists come from the older schema (V: official doc warns of column mismatches in the other direction) | Low | Medium | restore errors | restore **after** GoTrue has booted once (schema at v2.196); `--column-inserts`/explicit columns in the dump tolerate added nullable columns | — | R1.5 | Open (planned) |
| R36 | Vercel-hosted web build (Hobby plan, non-commercial) may still be used by someone; it is outside the Tailscale design | U | Low | ask staff | decide: retire or serve statically from lucashome (D18) | — | O2 | Open |
| R37 | Uncommitted app work on the Mac for > 1 month (V) — a Mac failure loses it | Medium | Medium | — | commit to a branch (O10) | — | — | Open |

## C. Accepted risks (require explicit owner acknowledgement)

| ID | Risk | Why accepted | Review at |
|---|---|---|---|
| R27 | Realtime gap after reconnect | pre-existing on hosted | post-G14 |
| R31 | Resend daily cap | low volume; fails safe | post-G14 |
| R38 | No code signing for Windows installers (V) → SmartScreen warnings on manual installs | pre-existing; cost | — |
| R39 | Studio reachable to every tailnet device with basic auth (D17) | tailnet-only; ACL can restrict `lucashome:443` to tills + admin devices, which also covers Studio | G1 |

## D. Risks that make the architecture itself questionable

R4, R8, R11, R12 together are not stack risks; they are properties of running a
retail backend for shops on another continent from a laptop on home Wi-Fi.
Mitigations reduce them; none removes them. [MIGRATION-PLAN.md](./MIGRATION-PLAN.md)
§Architecture concerns lays out the alternatives so the G1 decision is made with
eyes open.
