# Hosted Supabase — risks

Fixes exist on lucashome only; hosted is deliberately not changed while it is the fallback.

- **All 58 public functions executable by `anon`** (incl. legacy `complete_stock_transfer`); safety rests on in-function checks. Fixed on lucashome by 064.
- **No organization isolation** (pre-068 schema). Single org today, so no cross-tenant data exists.
- **No idempotency**: commit-then-timeout retries can duplicate sales/stock/payments if the old client is used with real trading.
- **`create_app_user` broken since 2026-09-02** (org_id NOT NULL) — staff cannot be created through the app on hosted. Fixed on lucashome by 066.
- **No backups** (Free plan); the only copy outside Supabase is the 2026-10-11 export on the Mac.
- **Pauses after 7 idle days** (restorable); keep-alive needed during the rollback window.
- **`rotate-audit-log` cron is still active on hosted** and deletes audit rows after emailing them (decided not to carry this job over).
