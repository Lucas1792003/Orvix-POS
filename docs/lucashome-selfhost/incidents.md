# lucashome — incidents and near-misses

Newest at the top. App defects found by the e2e suite against this stack are in [`../desktop-app/incidents.md`](../desktop-app/incidents.md).

## 2026-10-16 — Near-miss: G10 PNG finding diagnosed wrongly (corrected same day)
- **Symptom:** after 083, live suite g4 failed G5-2 on the PNG case; G10 recorded "the function accepts PNG, the RPC refuses it and the object is left behind" and asked the owner for a decision.
- **Root cause of the misdiagnosis:** the deployed function's byte check actually refused PNG and deleted the object; the failure came from the test's own follow-up RPC call (type check fires before the "object missing" check). The real, different gap: when the **RPC** refused after a passing byte check, the object stayed at `org/<org>/temp/<session>`.
- **Fix:** test corrected; 085 + scoped delete-on-refusal in `phone-upload-token`, deployed 2026-10-16 07:51–07:52 UTC; G10 "Correction" section (commit `0abe0ad`); analysis [`../selfhost-migration/phase-f/migration-085-png.md`](../selfhost-migration/phase-f/migration-085-png.md) §1.
- **Lesson:** before recording a finding as a server defect, compare the deployed code (sha256 vs git) and separate the test's own steps from the system's behaviour.

## 2026-10-16 — Near-miss: org-isolation live suite not re-run after 082 (found before 083)
- **Symptom:** during the 083 pre-deploy checks, `phase-g.org-isolation` only passed against production at 082 after a test fix.
- **Root cause:** the suite's staff setup predated 082 (accounts not created through the verified-admin, staff-admin-marked path that 082 requires) — a test-only failure; the suite had not been re-run after the 082 deploy.
- **Fix:** suite made 082-compliant (verified admin sign-in, staff-admin-marked accounts), commit `e4e8c62`; 12/12 before and after 083 ([G10](../selfhost-migration/evidence/G10/2026-10-16-migration-083-headers.md) "Before").
- **Lesson:** after every migration, re-run **all** live suites, not only the ones the change targets.

## 2026-10-16 — Security-audit coverage-gate files missing from git (repo/tooling, no server impact)
- **Symptom:** `tools/security-audit/coverage/gate.mjs`, `summarise.mjs` and `static-map.json` were not in the audit commit `9b62930`.
- **Root cause:** the root `.gitignore` pattern `coverage` also matched `tools/security-audit/coverage/`.
- **Fix:** files restored from the authoring session and committed with a negation rule `!/tools/security-audit/coverage/` (commit `b355ee9`).
- **Lesson:** after adding a tool directory, check `git status --ignored` / `git check-ignore` for its files before committing.

## 2026-10-12 — Near-miss: org-isolation migration 069 reopened the first-user bootstrap (caught before deploy)
- **Symptom:** independent review of the unapplied 067–072 reproduced, in a throwaway container, an orphan auth account inserting itself as MANAGER in another org's shop and reading its sales, and creating a new org with itself as ADMIN.
- **Root cause:** the "first user?" test `NOT EXISTS (SELECT 1 FROM users)` ran under the caller's RLS; once 069 scoped `users` reads by org, such a caller saw zero users. The original 101 isolation tests did not cover it.
- **Fix:** policies and the 047 trigger use `app_setup_needed()` (RLS-independent); org inserts only on an empty install; migration 073. Deployed only after the fix (2026-10-12 16:56 UTC).
- **Lesson:** isolation tests must include identity edge cases (orphan, deactivated), not only cross-org ADMIN access; keep an independent reviewer separate from the author.

## 2026-10-12 — App regression after 069: admin bounced to /login on a shared till
- **Symptom:** E2E — after a deactivated cashier was logged out, the next admin sign-in on the same till returned to /login.
- **Root cause:** the cached data snapshot (now org-scoped, empty for the deactivated user) lacked the admin row; route guards redirected instead of waiting.
- **Fix:** fresh sign-in resets cached data; guards wait while loading (`authStore.ts`, `RequireRole.tsx`, `AppRouter.tsx`), commit `293fdf4`.

## 2026-10-12 — Table grants after restore broader than hosted
- **Symptom:** post-restore check: `anon`/`authenticated` had DELETE/INSERT/UPDATE on tables where hosted had only SELECT.
- **Root cause:** self-host default privileges applied at `CREATE TABLE`; the schema dump carries no REVOKEs.
- **Fix:** revoke-all + exact hosted grant set (then pinned in migration 065). **Lesson:** compare grant fingerprints after any restore.

## 2026-10-11 — Realtime crashed on the db container restart (WAL change)
- **Symptom:** `realtime` exited `FATAL 57P01 admin_shutdown`, restarted by Docker (`RestartCount=1`).
- **Fix:** none needed. **Lesson:** expect Realtime to bounce in any db maintenance window; check its health afterwards.

## 2026-10-11 — Realtime delivered no change events (empty publication)
- **Symptom:** Phase B probe subscribed fine but received no `postgres_changes`.
- **Root cause:** the Realtime poller only starts once `supabase_realtime` has at least one table.
- **Fix:** table added; after the restore the dump's `ALTER PUBLICATION … ADD TABLE inventory` covers it. **Lesson:** verify the publication after every restore.
