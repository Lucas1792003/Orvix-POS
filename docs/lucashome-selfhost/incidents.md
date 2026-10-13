# lucashome — incidents and near-misses

Newest at the top.

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
