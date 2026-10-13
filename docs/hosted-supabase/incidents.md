# Hosted Supabase — incidents

Newest at the top.

## 2026-10-12 — Accidental QA auth user created on hosted (cleaned up)
- **Symptom:** hosted `auth.users` went 10 → 11; one orphan account `qa-admin-…@qa.invalid` created 05:23:28 UTC (1 identity, 0 sessions, no app row, no data).
- **Root cause:** two throwaway E2E probes ran against a hand-started Vite dev server outside the guarded harness, so the app used `.env.local` (hosted). The app's login path then called `supabase.auth.signUp()` after a failed password login, creating the account.
- **Fix:** owner-approved deletion by exact id via the Auth admin API (HTTP 200); auth users back to 10; business manifest unchanged; no audit entry produced. Evidence: [`../selfhost-migration/evidence/G9/2026-10-12-hosted-orphan-cleanup.md`](../selfhost-migration/evidence/G9/2026-10-12-hosted-orphan-cleanup.md).
- **Prevention:** login never signs up (explicit `/setup` only); Electron builds pinned to lucashome; every test harness fails on any `*.supabase.co` request (commits `293fdf4`, `e087861`).
- **Lesson:** never run the app or a probe without the backend explicitly set; a dev server with `.env.local` is a production client.

## 2026-10-11 — Read-only export taken
Not an incident; recorded because it is the only other interaction: SELECT-only queries, `pg_dump` of roles/schema/data and a storage download into `~/shwephala-migration/20261011T2347Z/`. No writes. See [`../lucashome-selfhost/status.md`](../lucashome-selfhost/status.md).
