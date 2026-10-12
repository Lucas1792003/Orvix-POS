# 09 · Monitoring and Alerting

Status: **design**. Principle: at least one monitor must live **off**
`lucashome` and **outside its tailnet dependency** so that "the laptop is dead",
"the Wi-Fi dropped", and "Tailscale is down" are all detectable.

## 1. Three layers

| Layer | Runs on | Detects | Independence |
|---|---|---|---|
| **A. Dead-man's switch** (healthchecks.io, free ≤ 20 checks) | nothing on the server beyond `curl` pings from cron jobs | host down, internet down, cron broken, backup not run, archive stalled | fully independent SaaS; alerts by email / Telegram / SMS-via-integration |
| **B. Active tailnet probe** | `cyfro-staging` (an existing datacenter-hosted tailnet node) and optionally one till | API unreachable over Tailscale even if the host is alive; TLS cert validity; per-endpoint health; latency from a remote vantage | independent of `lucashome`; depends on Tailscale control plane being up |
| **C. Local collector** | `lucashome` (cron script, no extra daemon) | CPU/RAM/swap/disk/filesystem/container state/Postgres internals/backup internals; pushes a status line to healthchecks.io "log" and fails the ping on threshold breach | not independent, but rich |

Optional later: Uptime Kuma container on `lucashome` for dashboards and history
(free), notifying Telegram. It is not a substitute for layer A.

## 2. What is checked, thresholds, actions

### Availability

| Check | Source | Threshold → Alert | Action |
|---|---|---|---|
| Host heartbeat | A: cron every 5 min pings | 2 missed (10 min) → **critical** | Check power/Wi-Fi at the house; if unreachable > 30 min, tills continue offline; start DR clock |
| Tailscale connectivity | B: `tailscale ping lucashome` + HTTPS probe | 3 consecutive failures (≈3 min) → **critical** | `tailscale status` on host; restart `tailscaled`; check key expiry |
| `GET /auth/v1/health` | B | non-200 or > 5 s, 3× → **critical** | `docker compose ps auth`, logs |
| `GET /rest/v1/` with service key | B | non-200 → **critical** | PostgREST/db |
| `GET /storage/v1/status` | B | non-200 → **high** | storage container |
| Realtime: `GET /realtime/v1/api/tenants/realtime-dev/health` with anon key | B | non-200 → **high** | realtime container; images Realtime also fails if JWT secret mismatched |
| Functions: `POST /functions/v1/<probe>` (a no-op probe function, or `rotate-audit-log` in dry-run mode if it has one) | B | non-200 → **high** | edge runtime logs |
| TLS certificate expiry | B: `openssl s_client` | < 14 days → **high** | `tailscale cert` renew; check `tailscale serve` |
| Tailscale node key expiry | C: `tailscale status --json` KeyExpiry | < 30 days → **high** (should be disabled → 0 alerts) | disable key expiry in admin console |

### Resources (layer C, every 5 min)

| Metric | Warn | Critical | Action |
|---|---|---|---|
| RAM available | < 2 GiB | < 1 GiB | identify tenant (`docker stats`); stop ollama model; verify container limits |
| Swap used | > 2.5 GiB | > 3.5 GiB | same |
| PSI memory `full` avg60 | > 5 % | > 20 % | same; Postgres latency will already be visible |
| Disk `/` free | < 15 GiB | < 8 GiB | `docker system prune`, log rotation |
| Disk `/srv` free | < 50 GiB | < 20 GiB | backup retention, storage growth |
| Inodes | > 80 % | > 90 % | — |
| Load avg (1 m) | > 8 | > 14 | — |
| CPU temperature | > 85 °C | > 95 °C | laptop cooling/dust; sustained load from Minecraft |
| Filesystem errors | any `EXT4-fs error` in `journalctl -k` | — → **critical** | fsck at next maintenance; treat as disk-failure warning |
| NVMe SMART (needs `nvme-cli` + sudo rule) | spare < 20 %, media errors > 0, temp > 70 °C | — → **high** | plan disk replacement; verify offsite backup |
| Battery | AC offline → **high** immediately; capacity < 30 % on battery → **critical** | | clean shutdown script when < 15 % (prerequisite: a sudo rule for `shutdown`) |
| Reboot required | `/var/run/reboot-required` present > 7 days | — → warn | schedule maintenance window |
| Container state | any Supabase container not `running`/`healthy` for > 2 min | → **critical** | `docker compose up -d`, logs |
| Container restarts | RestartCount increased | → **high** | logs |

### Postgres (layer C via `docker exec supabase-db psql`, every 5 min)

| Check | Threshold | Action |
|---|---|---|
| `pg_isready` | fail → **critical** | — |
| Connections `pg_stat_activity` | > 80 % of `max_connections` → warn | pool exhaustion; look for idle-in-transaction |
| Longest transaction / idle-in-transaction | > 5 min → warn | kill if it blocks |
| Blocked queries | any > 30 s → warn | lock contention (checkout vs stock adjust) |
| `pg_stat_archiver.last_failed_time` | not null → **critical** | archive dir full or permissions |
| Last archived WAL age | > 10 min → **critical** | RPO breached |
| Replication slots (Realtime) | `pg_replication_slots` inactive or `wal_status` ≠ reserved → **high** | Realtime slot leak fills the disk; drop stale slots |
| Database size growth | > 50 %/week → warn | audit log rotation function working? |
| Dead tuples / autovacuum | `n_dead_tup` > 100 k on `sales`/`audit_logs` → warn | — |
| Cron jobs | `cron.job_run_details` last run of each job: status ≠ succeeded or last start > 2× schedule → **high** | functions reachable from db? service key rotated? |

### Backups (layer A + C)

| Check | Threshold |
|---|---|
| Base backup job pinged | missed daily → **critical** |
| Hourly dump pinged | 2 missed → **high** |
| rclone sync pinged + `rclone check` clean | missed/ mismatched → **high** |
| Weekly restore test pinged with success | missed/fail → **critical** |
| Offsite size | > 8 GB → warn (free-tier ceiling 10 GB) |
| Golden snapshot presence (hash) | missing → **critical** |

### Application-level (from the database, every 15 min)

| Check | How | Threshold |
|---|---|---|
| Failed logins | `auth.audit_log_entries` where action is a failed login, per 15 min | > 20 → warn (brute force or clock skew breaking TOTP) |
| Checkout failures | count of `audit_logs` or edge logs with RPC exceptions — **U** whether failures are persisted; otherwise instrument the app's `reportError()` to POST to a tiny `/functions/v1/client-error` endpoint (application change, optional) | > 5 in 15 min → high |
| Sync conflicts | rows surfaced on the app's Sync Conflicts page come from the client's local outbox, not the server — **not observable server-side**. Mitigation: a daily report of `p_expected_actor_id` mismatches is not possible server-side either; keep a manual weekly review on each till (see 11 in 02) |
| Inventory inconsistency | `inventory.qty_base_units < 0` count; sum of `inventory_movements` deltas per (shop, product) vs `inventory.qty_base_units` | any → **high** |
| Duplicate sales | two `sales` rows for the same shift with identical totals and `created_at` within 2 s | any → warn, investigate |
| Open shifts older than 24 h | count | > 0 → warn |
| Storage failures | storage container logs error rate; `products.image_url` pointing to missing objects (weekly) | — |

## 3. Escalation

| Severity | Channel | Who | Expectation |
|---|---|---|---|
| critical | Telegram + email (healthchecks.io integrations), repeated every 30 min until acknowledged | owner (and the second admin once added) | acknowledge within 30 min during Myanmar trading hours (02:30–15:30 UTC); tills are offline-capable, so the first action is always "confirm tills still sell", then fix |
| high | Telegram | owner | same day |
| warn | daily digest email | owner | weekly review |

Runbook pointers live in [08-cutover-rollback.md](./08-cutover-rollback.md) §Rollback
and [07-backup-disaster-recovery.md](./07-backup-disaster-recovery.md) §5.

## 4. Implementation notes (for the build phase, not for now)

- Layer A: one healthchecks.io project, checks: `heartbeat`, `collector`,
  `backup-base`, `backup-dump`, `backup-wal-check`, `backup-offsite`,
  `restore-test`, `probe-staging`. Ping URLs are secrets (store in the config
  bundle).
- Layer B: a 20-line bash script on `cyfro-staging` under cron (`*/1`), using
  the **anon** key only (never the service key off-box), pinging `probe-staging`
  on success.
- Layer C: one bash script on `lucashome` (`*/5`), using `docker exec` and
  `psql`, writing a one-line summary to the healthchecks ping body; exits
  non-zero (→ `/fail` endpoint) on any critical threshold.
- Needed sudo rules on `lucashome` (user action, one-time): `nvme smart-log`,
  `shutdown` for the battery guard. Everything else runs as `lucario`.
- All thresholds above are initial values; re-tune after two weeks of G14 data.
