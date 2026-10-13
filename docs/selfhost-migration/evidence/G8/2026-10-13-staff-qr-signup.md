# G8 — Gmail transport installed disabled, QA cleanup, staff-admin, phone page, signup closed (2026-10-13)

Private evidence. Owner decisions of 2026-10-13: no domain; owner does GPG + Google setup; install Gmail transport disabled; approved exact QA cleanup; fix packaged QR origin; server-side staff creation; no public exposure; Tailscale/SSH/firewall/reboot/publication/release unchanged.

| Step (UTC) | Result |
|---|---|
| 18:46 email/Gmail scripts installed (`deploy.sh`, no `--cron`) | all email jobs log "disabled"; `--selftest` refused while disabled; no credentials dir; crontab unchanged |
| 18:46–18:47 QA cleanup | see `phase-f/qa-cleanup-manifest.md` §7: only the 3 target tables changed (5→3, 15→0, 578→557); audit 81, products 539, auth users 10, images 574 (+17 orphans) identical; 574/574 SHA-256 |
| ~19:15 `staff-admin` deployed (rsync, no restart) | hash match; no-auth 401, anon create 401 `unauthenticated`, bootstrap 403 `setup_closed`, GET 405, OPTIONS 200 |
| ~21:30 `phone-upload-page` + router patch | router pre-patch sha256 `9b7978ab…` matched; backup `main/index.ts.pre-phone-page`; `patch --dry-run` ok; functions restarted (healthy in 8 s). Smoke: page 200 `text/html`, strict CSP with nonce, service key absent from page, sub-path 401, POST 401, phone-upload-token/staff-admin still 401 without auth, all functions OPTIONS 200 |
| ~21:35 `DISABLE_SIGNUP=true` | `.env` backed up (0600), single line changed, `docker compose up -d auth` only; 10/10 healthy; public signup → 422 `signup_disabled`; auth users unchanged (10) |

## Regression after all changes (21:43–22:16 UTC, then reruns)
| Suite | Result |
|---|---|
| unit (vitest) | 884 passed |
| tsc (app + e2e) | clean |
| Deno functions | 61 passed |
| harness full / capped 081 | 564/0, 564/0 |
| live phase-f-staff (new) | first run: setup bug (test inserted a shop without `address`); fixed; rerun **9/9** — signup refused; ADMIN aal2 creates CASHIER; cashier signs in; aal1 with TOTP refused; MANAGER/CASHIER refused; cross-org refused; duplicate 409 + idempotent replay; existing TOTP admin logs in; CLEAN |
| live phase-g4 / d / g / g2 / g3 | 12 (+1 pre-081-only skip) / 16 / 12 / 4 / 9 — all CLEAN |
| e2e full, phone page **deployed** | 41 passed, 1 failed: F1 shift-close waited for the variance-reason box (order-dependent state from earlier specs); `f-queue-export` rerun alone 3/3; spec D (deployed page, QR asserted = configured https origin) passed inside the full run |
| cleanup | CLEAN after every run |
| build:electron (guard: https origin required) + mac arm64 package | ok |
| storage | 574/574 |
| fingerprint vs post-cleanup | **identical** |

Post-change base `20261013T232229Z` verified; LSN `2/60000090` recorded (`post-staff-qr-signup`); backup-status OK.
