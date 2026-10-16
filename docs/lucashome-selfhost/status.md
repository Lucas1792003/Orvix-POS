# lucashome — status

Last verified **2026-10-13 ~02:00 UTC** unless stated otherwise.

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
| Schema version | **082** (82 rows). 062–066 applied 2026-10-12 01:22 UTC; 067–073 applied 2026-10-12 16:56 UTC; **074–076 applied 2026-10-13 00:48 UTC** (hashes `e717402c…`/`c615d617…`/`e5884a99…`, the bytes that passed 371/0 in the harness); **077–079 applied 2026-10-13 01:56 UTC** (hashes `2319775b…`/`5f0b1c13…`/`a49ed009…`, passed 467/0); **080 applied 2026-10-13 04:09 UTC** (hash `d8b38edd…`, passed 519/0; pre-LSN `1/6F000058`, post-deploy LSN `1/82004780` with verified base `20261013T053857Z`); **081 applied 2026-10-13 10:14 UTC** (hash `4fe2dd7c…`, passed 564/0; pre-LSN `1/BC000058`, post-deploy LSN `1/C7000000` with verified base `20261013T110121Z`) + rate-limited `phone-upload-token` (sha256 `b7c90e0e…`) — [`../selfhost-migration/evidence/G7/2026-10-13-081-and-email-install.md`](../selfhost-migration/evidence/G7/2026-10-13-081-and-email-install.md); **082 applied 2026-10-16 05:31 UTC** (hash `c4613aa3…`, harness 647/0; pre-LSN `4/F0000058`, post-deploy LSN `4/F2000058`, verified base `20261016T053520Z`), after the marker-writing `staff-admin` (sha256 `7b61a848…`, previous version kept in `~/staff-admin.pre-082`) — [`../selfhost-migration/evidence/G9/2026-10-16-migration-082.md`](../selfhost-migration/evidence/G9/2026-10-16-migration-082.md); schema version now **082**. `public.app_config` holds exactly 1 row (the serve origin), writable only by `service_role`/`postgres`. Edge Function `phone-upload-token` deployed 2026-10-13 to `volumes/functions/` (no restart) — [`../selfhost-migration/evidence/G5/2026-10-13-080-and-phone-upload.md`](../selfhost-migration/evidence/G5/2026-10-13-080-and-phone-upload.md) | `apply-migrations.sh` output + `max(version)`; business manifest 148/148 unchanged; price levels (3) and unit prices (956) checksums unchanged |
| Data | 1 organization (`org-shwe-pha-lar`), 1 shop, 3 app users, 10 auth users (2 verified TOTP factors on the ADMIN), 539 products, 18 inventory rows, 0 sales, 574 storage objects (5.3 MB) | SQL counts after QA cleanup, 2026-10-12 |
| Storage objects | 574 migrated objects intact: all 574 public URLs verify by SHA-256 against the export manifest before and after 077–079; 17 orphans preserved — [`orphan-objects.md`](orphan-objects.md) | `verify_objects.py` 574/574, 2026-10-13 |
| Origin of data | restored from the hosted export of 2026-10-11 23:47 UTC (manifest 148/149 equal, 574/574 objects SHA-256 verified) | `../selfhost-migration/evidence/G4/2026-10-12-restoration.md` |
| Security shape | org isolation enforced (RLS + RPC guards + storage); anon may execute only `app_setup_needed`, `get_product_image_upload_session_by_token`, `complete_product_image_upload_session`; 30 mutating RPCs require an idempotency key, replays bound to the caller's org (074); first-time setup only via `bootstrap_first_admin()` under an install-wide lock (076); new orgs auto-seeded with Retail/Wholesale/Special (077); storage authorized by org path, legacy objects by path→product/session→org (078); uploads on `org/<org>/temp/<session>`, completion URL must end with the session path (079) | live two-org suite 12/12, 2026-10-12 |
| Realtime | publication `supabase_realtime` = `public.inventory` | `pg_publication_tables` |
| Cron / email | **none** — no cron jobs, no Resend key, SMTP password empty. `rotate-audit-log` and `weekly-sales-report` **removed** from `volumes/functions/` 2026-10-13 ~11:40 UTC (moved to `~/removed-edge-functions-20261013/` with SHA256SUMS; routes now fail to boot; no DB/cron/trigger/client dependency; 0 invocations in the prior 72 h); functions now: admin-2fa, email-sales-report, phone-upload-token, platform-console, **staff-admin** (deployed 2026-10-13 ~19:15 UTC) and **phone-upload-page** (deployed ~21:30 UTC with the router allow-list patch `deploy/lucashome/functions-main-public-page.patch`; pre-patch router backed up as `volumes/functions/main/index.ts.pre-phone-page`; functions container restarted once). **`DISABLE_SIGNUP=true`** since 2026-10-13 ~21:35 UTC (auth recreated; `.env.pre-signup-off-20261013` kept, 0600); public `/auth/v1/signup` → 422 `signup_disabled` — [`../selfhost-migration/evidence/G8/2026-10-13-staff-qr-signup.md`](../selfhost-migration/evidence/G8/2026-10-13-staff-qr-signup.md) | `cron.job` = 0; `.env` key presence check |

## Backups

| Item | State |
|---|---|
| Logical | hourly at :15 (globals + `postgres` + `_supabase`), retention 48 h / 14 d / 8 w |
| Physical | daily 02:30 UTC `pg_basebackup` + `pg_verifybackup`, keep 14 |
| WAL | archiving on, `archive_timeout = 300`, measured lag 0.1–0.3 s; PITR drill passed 2026-10-11 |
| Restore drill | weekly Sun 03:30 UTC (logical + physical into throwaway containers) |
| Latest verified | logical + base taken 2026-10-12 22:38 UTC after QA cleanup; LSN `1/26000058`; archiver 291 archived / 0 failed; `backup-status.sh` STATUS OK |
| Recovery points | pre-062 LSN `0/22000090` (2026-10-12 01:22); pre-067 LSN `0/E0000000` (2026-10-12 16:56); pre-074 LSN `1/41000000` (2026-10-13 00:48, base `20261013T004814Z` verified); pre-077 LSN `1/50000058` (2026-10-13 01:56, base `20261013T015650Z` verified); post-079 verified backup LSN `1/5B000058` (2026-10-13 02:37, base `20261013T023734Z`) — all in `/srv/supabase/backups/migration-checkpoints.txt` |
| Full DR drill | **2026-10-13 07:55 UTC, 123 PASS / 0 FAIL** (`dr-drill.sh`, disposable project `phf-drill`, read-only on live): weekly email archive built from live data with a throwaway key, split, reassembled, tamper detected (unpack + gpg), decrypted; restored into a fresh stack (db/rest/auth/storage/functions/gateway): all 33 public tables + auth (10 users, 2/2 verified TOTP) + migrations (80, max 080) + storage (574 objects, 17 orphans) md5-equal to live, `verify_objects` 574/574, `phone-upload-token` 401/404/405, runbook §7 + all 71 FKs 0; PITR from base `20261013T040930Z` + WAL to 4 targets around the 080 rollout, each state as expected; newest base + full replay = live. RTO data steps: email tier ~24 s, PITR ~3–5 s (host rebuild not included); RPO: WAL ≤ 5 min, email ≤ 7 days. Live 10/10 healthy, containers and data unchanged; everything removed — [`../selfhost-migration/evidence/G6/2026-10-13-dr-drill.md`](../selfhost-migration/evidence/G6/2026-10-13-dr-drill.md) |
| Email tier | **installed disabled 2026-10-13 10:17 UTC**: scripts in `bin/` via `deploy.sh` (no `--cron`), `backup.env` has `EMAIL_ENABLED=false`, `EMAIL_REPORT_ENABLED=false`, `EMAIL_SECRETS_MODE=off`; each script exits 0 with "disabled"; no owner public key, no Resend key, no cron entry; no secret key in the user's gpg keyring. Previous state: built and drilled on live data (above) |
| Offsite | scripts deployed **disabled** (`OFFSITE_ENABLED=false`); no rclone config, no cron lines. All copies are on the same NVMe |

## Host

| Item | State | How verified |
|---|---|---|
| Machine | ASUS Zenbook laptop, Ryzen 7 5800H, 14 GiB RAM, 1 TB NVMe, Wi-Fi only, Barrie ON | audit 2026-10-11 |
| Uptime | since 2026-09-02; **reboot required since 2026-10-08** (kernel updates pending) — not rebooted | `/var/run/reboot-required`, 2026-10-12 |
| Other workloads | house app (+ postgres, tailscale sidecar), minecraft, postgres:18, open-webui, ollama — untouched | `docker ps`, 2026-10-12 |
