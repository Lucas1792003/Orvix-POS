# lucashome — status

Last verified **2026-10-13 ~00:50 UTC** unless stated otherwise.

## Stack

| Item | State | How verified |
|---|---|---|
| Upstream | `self-hosted/v0.8.2` (commit `564eab8a`), copied to `/srv/supabase/stack`; all deviations in `docker-compose.override.yml` (repo copy `deploy/lucashome/`) | `git rev-parse HEAD` in `/srv/supabase/upstream`, 2026-10-11 |
| Containers | 10/10 healthy (db, auth, rest, realtime, storage, imgproxy, meta, functions, envoy gateway, studio); Supavisor pooler removed | `docker compose ps`, 2026-10-12 |
| Exposure | gateway on `127.0.0.1:8000` only; `tailscale serve` → `https://lucashome.tail8a86e4.ts.net` (tailnet only, Funnel **off**), Let's Encrypt cert valid to 2027-01-09 | `tailscale serve status`, `openssl s_client`, 2026-10-11/12 |
| Memory limits / log rotation | set on every Supabase container (db 2 GB, others 256–512 MB; json-file 20 MB × 5) | `docker compose config`, 2026-10-11 |

## Database

| Item | State | How verified |
|---|---|---|
| Schema version | **076** (76 rows). 062–066 applied 2026-10-12 01:22 UTC; 067–073 applied 2026-10-12 16:56 UTC; **074–076 applied 2026-10-13 00:48 UTC** (hashes `e717402c…`/`c615d617…`/`e5884a99…`, the bytes that passed 371/0 in the harness) | `apply-migrations.sh` output + `max(version)`; business manifest 149/149 unchanged |
| Not applied | 077+ (new-org price levels, upload security) — being prepared, see [`risks.md`](risks.md) | — |
| Data | 1 organization (`org-shwe-pha-lar`), 1 shop, 3 app users, 10 auth users (2 verified TOTP factors on the ADMIN), 539 products, 18 inventory rows, 0 sales, 574 storage objects (5.3 MB) | SQL counts after QA cleanup, 2026-10-12 |
| Origin of data | restored from the hosted export of 2026-10-11 23:47 UTC (manifest 148/149 equal, 574/574 objects SHA-256 verified) | `../selfhost-migration/evidence/G4/2026-10-12-restoration.md` |
| Security shape | org isolation enforced (RLS + RPC guards + storage); anon may execute only `app_setup_needed`, `get_product_image_upload_session_by_token`, `complete_product_image_upload_session`; 30 mutating RPCs require an idempotency key, replays bound to the caller's org (074); first-time setup only via `bootstrap_first_admin()` under an install-wide lock (076) | live two-org suite 12/12, 2026-10-12 |
| Realtime | publication `supabase_realtime` = `public.inventory` | `pg_publication_tables` |
| Cron / email | **none** — no cron jobs, no Resend key, SMTP password empty | `cron.job` = 0; `.env` key presence check |

## Backups

| Item | State |
|---|---|
| Logical | hourly at :15 (globals + `postgres` + `_supabase`), retention 48 h / 14 d / 8 w |
| Physical | daily 02:30 UTC `pg_basebackup` + `pg_verifybackup`, keep 14 |
| WAL | archiving on, `archive_timeout = 300`, measured lag 0.1–0.3 s; PITR drill passed 2026-10-11 |
| Restore drill | weekly Sun 03:30 UTC (logical + physical into throwaway containers) |
| Latest verified | logical + base taken 2026-10-12 22:38 UTC after QA cleanup; LSN `1/26000058`; archiver 291 archived / 0 failed; `backup-status.sh` STATUS OK |
| Recovery points | pre-062 LSN `0/22000090` (2026-10-12 01:22); pre-067 LSN `0/E0000000` (2026-10-12 16:56); pre-074 LSN `1/41000000` (2026-10-13 00:48, base `20261013T004814Z` verified) — all in `/srv/supabase/backups/migration-checkpoints.txt` |
| Offsite | scripts deployed **disabled** (`OFFSITE_ENABLED=false`); no rclone config, no cron lines. All copies are on the same NVMe |

## Host

| Item | State | How verified |
|---|---|---|
| Machine | ASUS Zenbook laptop, Ryzen 7 5800H, 14 GiB RAM, 1 TB NVMe, Wi-Fi only, Barrie ON | audit 2026-10-11 |
| Uptime | since 2026-09-02; **reboot required since 2026-10-08** (kernel updates pending) — not rebooted | `/var/run/reboot-required`, 2026-10-12 |
| Other workloads | house app (+ postgres, tailscale sidecar), minecraft, postgres:18, open-webui, ollama — untouched | `docker ps`, 2026-10-12 |
