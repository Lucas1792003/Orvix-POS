# G7 — Migration 081, rate-limited phone-upload function, email tier installed disabled (2026-10-13)

Private evidence. Owner approval: "Phase F Activation — Controlled Approval".

## Preflight
| Check | Result |
|---|---|
| 081 sha256 | `4fe2dd7c597589f0ac734c2a5dcc3248678176cfd0f35c16cb0dcef3f0b514c3` = commit b623573 (tested 564/0) = publish branch copy |
| Harness on the tree to apply | 564/0 PASS (10:0x UTC) |
| Schema before | 080 |
| Fresh backups | logical + base `20261013T101222Z` (pg_verifybackup) and the apply script's own base `20261013T101427Z` |
| WAL | failed=0 pending=0 |
| Thresholds | per session 20 lifetime / 5 per 10 s; per org 60 per 60 s; per user 120 sessions per hour; spec D cases need ≤ 2 tokens |
| Concurrency | harness races: 40 claims → exactly 5; 70 → exactly 60; 6 creates at 118/120 → exactly 2 |
| Cross-org | org derived server-side from the session creator; counter table has no grants (anon/authenticated/service_role/ADMIN refused); t17 "another organization is unaffected" |

## Apply
`deploy/lucashome/apply-migrations.sh --from 081 --to 081` at 10:14 UTC, pre-LSN `1/BC000058`. Verification: 81 migrations, max 081; anon executes 3 functions; 30 keyed RPCs; post logical backup ok.
Function `phone-upload-token` rsynced (sha256 `b7c90e0e…` both sides, no restart). Smoke: no auth 401, bad bearer 401, OPTIONS 200, bad token 404 generic, GET 405.

## Regression after deploy
| Suite | Result |
|---|---|
| unit (vitest, no live env) | 825 passed |
| tsc | clean |
| Deno functions | 51 passed |
| harness full / capped 080 | 564/0, 519/0 |
| live phase-g4 | 12 passed, 1 skipped (pre-081-only abuse measurement, correct); rate-limit tests 9–13 passed |
| live phase-d / g / g2 | 16 / 12 / 4 |
| live phase-g3 | first run failed on a hard-coded `max(version) = 080`; fixed to `>= 080`; rerun 9/9 |
| e2e full run | 27 passed, 3 failed (B13 terminal left on Inventory page; D30 TOTP digit entry; F1 setup timeout) |
| e2e reruns per spec | b-failures 14/14, f-queue-export 3/3, d-phone-upload 12/12 incl. D-ratelimit-wait and D-ratelimit-used-up, after fixing the phone test terminal to set English (the phone page became bilingual, default Myanmar) |
| cleanup | CLEAN after every run |
| build:electron + mac arm64 package | ok; backend host in bundle, 0 hosted refs |
| storage | verify_objects 574/574 |
| fingerprint (45 items incl. 17 orphans) | identical before vs after all tests |

Post-deploy base `20261013T110121Z` verified, LSN `1/C7000000` appended to `migration-checkpoints.txt`; backup-status OK, WAL failed=0.

## Email tier install (disabled)
`deploy/lucashome/backup/deploy.sh` without `--cron`. `backup.env` gained `EMAIL_ENABLED=false`, `EMAIL_REPORT_ENABLED=false`, `EMAIL_SECRETS_MODE=off`. `email-archive.sh`, `email-report.sh`, `email-secrets.sh` each log "disabled"/"nothing to do"; `backup-status.sh` adds one "email tier: disabled" line, STATUS OK. Crontab unchanged (4 jobs). gpg secret keys for the backup user: 0. No credential files created.
Note: `rotate-audit-log` and `weekly-sales-report` source is still present in `volumes/functions/` (restored from hosted). Both need the service-role bearer and return 500 before any work because no `RESEND_API_KEY` exists in the stack env; no cron. Recommend removing both directories before any Resend key is ever placed in the stack `.env` (owner approval).
