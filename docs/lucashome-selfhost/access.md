# lucashome — access

Names and locations only. **No secret values in this file.**

| What | Where / how |
|---|---|
| SSH | alias `lucashome` in `~/.ssh/config` on the Mac; user `lucario`; key auth; tailnet IP `100.74.43.4`. `sudo` needs a password (owner only) |
| Tailscale | node `lucashome.tail8a86e4.ts.net`; tailnet owner = the owner's personal account; operator set to `lucario` (2026-10-11), so `tailscale serve` works without sudo; node key expiry 2027-03-15 |
| API base URL | `https://lucashome.tail8a86e4.ts.net` (tailnet only) |
| Stack directory | `/srv/supabase/stack` (compose project `supabase`); upstream clone `/srv/supabase/upstream` |
| Stack secrets | `/srv/supabase/stack/.env` (mode 0600, owner `lucario`) — `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, dashboard credentials, etc. Read into a shell variable only (`grep '^ANON_KEY=' … \| cut -d= -f2-`), never printed |
| pgsodium / vault root key | `supabase_db-config` Docker volume (`/etc/postgresql-custom` in the db container); also copied into each base backup dir |
| Database shell | `cd /srv/supabase/stack && docker compose exec -T db psql -U supabase_admin -d postgres … </dev/null` (always `</dev/null` in scripts) |
| Studio | `https://lucashome.tail8a86e4.ts.net/` behind basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in `.env`); reachable by every tailnet device |
| Backups | `/srv/supabase/backups/` (dump/, base/, logs/, status.json, checkpoints); scripts `/srv/supabase/backup/bin/`; config `/srv/supabase/backup/backup.env` (0600); WAL archive `/srv/supabase/stack/volumes/db/wal_archive` |
| Migration apply | `deploy/lucashome/apply-migrations.sh` from the Mac (backs up, records LSN, single transaction) — see [`../runbooks/README.md`](../runbooks/README.md) |
| Config backups | `/srv/supabase/backups/config-backup-20261011T234707Z/` (Postgres config before WAL change); `/srv/supabase/backups/tailscale-preflight-20261011T215421Z/` (Tailscale state before Serve, private keys redacted) |
| Migration workspace (Mac) | `~/shwephala-migration/20261011T2347Z/` (0700) — scrubbed hosted export, manifests, storage copy. Golden copy until offsite backups exist |
