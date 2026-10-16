# Deprecated Edge Functions (NOT deployable)

This folder holds the source of retired Supabase Edge Functions **for history only**.

**Rules**
- Nothing here is deployed. `deploy/lucashome/sync-functions.sh` deploys only the approved list in `deploy/lucashome/functions-guard.sh`.
- The guard refuses any retired name, and refuses to run if a retired function reappears under `supabase/functions/`.
- Do not move anything from here back into `supabase/functions/` without a new, explicit owner approval and a security review.

| Function | Retired | Original path | Why | Server rollback copy |
|---|---|---|---|---|
| [`platform-console`](platform-console/) | removed from lucashome 2026-10-16 20:19 UTC (G0-1); source archived here 2026-10-16 (G0-2) | `supabase/functions/platform-console/index.ts` | Platform-wide admin function: creates organisations and platform admins with a password only (no MFA, no rate limit, no audit table, temporary passwords returned in the response, any platform admin can mint more). Organisation-ADMIN features never used it. Its replacement is the separate Orvix Control project (`docs/plans/orvix-platform-control-plane-architecture.md`). | `lucashome:~/removed-edge-functions-20261016T2019Z/platform-console` (tree sha256 `0f650c9e9e3a338d8b75eb085fcc56e4c5935080d08ddea7ea73b821036a7bff`, identical to this copy) |

Evidence:
- [G0-1 containment](../../docs/selfhost-migration/evidence/G0-1/2026-10-16-platform-console-containment.md)
- [G0-2 deployment protection](../../docs/selfhost-migration/evidence/G0-2/2026-10-16-platform-console-deployment-protection.md)

`rotate-audit-log` and `weekly-sales-report` were removed from the server on 2026-10-13 and are no longer in the repository. Their names are on the guard's retired list too (owner rule 2026-10-12: not re-enabled).

This copy contains no secrets. It reads `SUPABASE_SERVICE_ROLE_KEY` from its runtime environment by name only.
