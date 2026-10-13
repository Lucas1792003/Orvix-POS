# Desktop app — incidents and defects fixed

Newest at the top. All on branch `feature/selfhost-supabase-migration`.

## 2026-10-12 — Failed login created an account (root cause of the hosted incident)
`login()` called `signUp()` after any failed password sign-in. Removed; first-admin setup is the explicit `/setup` page. See [`../hosted-supabase/incidents.md`](../hosted-supabase/incidents.md).

## 2026-10-12 — Realtime gap left stock stale
After a socket drop the channel rejoined but missed changes were never fetched. Fixed: server-authoritative inventory refresh after any gap; E2E B11b.

## 2026-10-12 — Defects found by the Electron E2E run (Phase E)
Silent print always reported success with no printer; a write during an in-flight load was overwritten; two concurrent full loads at login; revoked session mid-load overwrote the offline mirror; 12-hour offline refusal shown as "Network error"; commit-then-lost-response replay listed the sale twice; route guards bounced a fresh sign-in; Users page success message cleared. All fixed with tests (commit `293fdf4`).

## 2026-10-12 — Duplicate sale on commit-then-timeout; queue stranded on flaky links (Phase D)
No idempotency key; resolved fetch errors marked as permanent conflicts; offline window measured from boot; snapshot persistence cleared the outbox; queue ordering ties. Fixed with server idempotency (062–063) and client outbox rework; live suite 16/16.

## 2026-10-12 — Type-check failed at baseline
Dexie 4.4.5 type wrapper self-reference under `moduleResolution: bundler`, plus three typing errors. Fixed via `tsconfig.app.json` `paths` and typed rows; builds were blocked before this.
