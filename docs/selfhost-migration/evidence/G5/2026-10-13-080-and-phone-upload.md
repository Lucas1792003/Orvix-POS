# G5 — Migration 080, phone-upload function, live verification (2026-10-13)

Private evidence. Names the server; not for the public repo.

## Deployment
- **080** applied 2026-10-13 04:09 UTC via `deploy/lucashome/apply-migrations.sh`. File sha256 `d8b38eddda20e57cb2aaa5a1c8acf7e91d63a4264e3996395e184038e8b318f2` = the version that passed the harness 519/0. Pre-migration LSN `1/6F000058`, pre base `20261013T040930Z` verified.
- `public.app_config`: 1 row, https origin from `tailscale serve status --json`, no userinfo. INSERT granted to `postgres`, `service_role` only. anon/authenticated get 42501 on every verb (live phase-g4).
- `phone-upload-token` rsynced to `/srv/supabase/stack/volumes/functions/phone-upload-token/`, no container restart. Smoke: no auth 401, bad bearer 401, OPTIONS 200, bad token 404 generic, GET 405, no key material in responses.

## Post-deployment checks (coordinator, 2026-10-13 05:40 UTC)
| Check | Result |
|---|---|
| schema | 080 |
| orgs / products / inventory / price levels / auth users | 1 / 539 / 18 / 3 / 10 |
| QA auth users | 0 |
| storage objects (product-images) | 574; verify_objects 574/574 |
| 17 orphan rows | byte-identical before/after (agent) |
| anon-executable public functions | 3 |
| pending upload sessions | 1, restored from hosted (2026-08-17), expired; left untouched |
| post-deploy base backup | `20261013T053857Z`, pg_verifybackup ok; LSN `1/82004780` appended to `migration-checkpoints.txt` |
| backup-status | OK; WAL failed=0 pending=0; offsite still disabled |

## Live verification (agent run, deployed function)
- e2e run 2: 39/39 in 23.9 min, 0 hosted requests. Run 1: 2 test bugs (D-race assertion, E1 timing) fixed.
- Spec D: uploads at 30/65/120/300 s ok (token minted ~0.3 s after pick); stale token 66 s → refused → refetched → 200; double tap 1/1/1; lost response → "already uploaded"; expired/cancelled → 410, no object.
- phase-g4 8/8: 25 path variants, 26 URL variants refused; 6 external-host variants store only the trusted URL; missing object refused; concurrent completion 1 winner.
- Abuse: 50 seq + 50 concurrent all 200, no 429; ≤1 distinct token/second; extra tokens add no capability (first upload wins, rest 409). Rate-limit plan R1–R5 in `../../phase-g/phone-upload-jit.md`, not implemented.
- Regression: tsc clean; unit 774 passed; functions 42; harness 519/0 full and capped at 080; live d 16, g 12, g2 4, g3 9, g4 8; build:electron + mac arm64 package + packaged smoke ok.
- Outage drill B13: 240 s API refusal on 2 tills, 6 sales queued, drained in 60–74 s, 6 keys = 6 sales.
- Cleanup: CLEAN, 80 QA audit rows purged (0 others).
