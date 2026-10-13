# Hosted Supabase — status

| Item | State | How verified |
|---|---|---|
| Plan / region | Free plan, `ap-southeast-1`, ACTIVE_HEALTHY | `supabase projects list`, Management API, 2026-10-11 |
| Postgres | 17.6.1.121 | `select version()`, 2026-10-11 |
| Schema | migrations 001–061 (no Phase D/G migrations — not org-isolated, no idempotency) | `supabase migration list --linked`, 2026-10-11 |
| Data | 10 auth users (2 TOTP factors), 3 app users, 1 org, 1 shop, 539 products, 0 sales, 574 storage objects | SELECT counts, 2026-10-11; auth users back to 10 after the 2026-10-12 cleanup |
| Cron | `rotate-audit-log` (*/5), `weekly-sales-report` (Sun 17:30 UTC) — still active on hosted | `cron.job`, 2026-10-11 |
| Realtime | reported UNHEALTHY by the Management API on 2026-10-11 | Management API GET |
| Changes during migration | **one only**: deletion of one accidental QA orphan auth user, 2026-10-12 (approved) — see [`incidents.md`](incidents.md) | manifest diff pre/post |
| Clients pointing at it | the published Electron v1.0.15 and the Vercel web build | `dist` bundle host check, 2026-10-11 |
