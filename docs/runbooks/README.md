# Runbooks

Reusable procedures. The scripts live in the repo; this table says which one to use and where it runs. All commands from the repo root on the Mac unless marked.

| Procedure | Environment | Where |
|---|---|---|
| Apply migrations to lucashome (pre-flight, backups, LSN, single transaction, verification) | lucashome | `deploy/lucashome/apply-migrations.sh --from NNN --to NNN [--dry-run]` — [`../../deploy/lucashome/apply-migrations.sh`](../../deploy/lucashome/apply-migrations.sh) |
| Rebuild the stack from scratch | lucashome | [`../../deploy/lucashome/README.md`](../../deploy/lucashome/README.md) |
| Backups: jobs, manual restore, PITR | lucashome | [`../../deploy/lucashome/backup/README.md`](../../deploy/lucashome/backup/README.md), [`WAL-ARCHIVING.md`](../../deploy/lucashome/backup/WAL-ARCHIVING.md) |
| Enable offsite backups (R2 + Mac tier) | lucashome | [`../../deploy/lucashome/backup/OFFSITE-ENABLE.md`](../../deploy/lucashome/backup/OFFSITE-ENABLE.md), [`MAC-TIER.md`](../../deploy/lucashome/backup/MAC-TIER.md) |
| Hosted export → scrub → restore | hosted → lucashome | [`../selfhost-migration/05-migration-runbook.md`](../selfhost-migration/05-migration-runbook.md), [`../../tools/selfhost-migration/README.md`](../../tools/selfhost-migration/README.md) |
| Disposable DB test harness (idempotency, RLS, org isolation) | Mac (Docker) | `bash supabase/tests/phase-d/run.sh` (`POS_TEST_MAX_MIGRATION=NNN` to cap) — [`../../supabase/tests/phase-d/README.md`](../../supabase/tests/phase-d/README.md) |
| Live API suites against lucashome (QA data) + cleanup | lucashome | [`../../supabase/tests/phase-d/live/README.md`](../../supabase/tests/phase-d/live/README.md); cleanup `cleanup.sql` → audit purge → `verify_clean.sql` must print CLEAN |
| Electron end-to-end suite + cleanup | lucashome | [`../../e2e/README.md`](../../e2e/README.md) (`npm run e2e`, `npm run e2e:cleanup`) |
| Edge-function tests (mocked email, no network) | Mac | `bash supabase/tests/functions/run.sh` |
| Owner TOTP verification on lucashome | lucashome | [`../selfhost-migration/phase-g/owner-totp-verification.md`](../selfhost-migration/phase-g/owner-totp-verification.md) |
| Cutover and rollback | all | [`../selfhost-migration/08-cutover-rollback.md`](../selfhost-migration/08-cutover-rollback.md) |
| Next phase (proposals, 2026-10-13, not yet approved): maintenance window: reboot + G3 persistence test, then host hardening steps H1–H10 | lucashome | [`../selfhost-migration/next-phase/reboot-and-hardening.md`](../selfhost-migration/next-phase/reboot-and-hardening.md) |
| Next phase: enable offsite backups (R2 + Mac tier), first offsite restore test, bundle decrypt on the Mac | lucashome + Mac | [`../selfhost-migration/next-phase/offsite-backup-enable.md`](../selfhost-migration/next-phase/offsite-backup-enable.md) |
| Next phase: owner TOTP login test against lucashome (supersedes the phase-g procedure) | lucashome | [`../selfhost-migration/next-phase/owner-totp-test.md`](../selfhost-migration/next-phase/owner-totp-test.md) |
| Next phase: Electron 1.0.16 release checklist: gates, build, rollback build, pre-release canary, promotion, keep-alive | desktop app | [`../selfhost-migration/next-phase/electron-1.0.16-canary.md`](../selfhost-migration/next-phase/electron-1.0.16-canary.md) |

Rule for every lucashome procedure: check `backup-status.sh` is OK first, never `docker compose down -v` / `reset.sh`, always `</dev/null` on `docker compose exec` in scripts, never print `.env` values.
