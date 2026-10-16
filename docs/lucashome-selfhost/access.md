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
| Studio | `https://lucashome.tail8a86e4.ts.net/` behind basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in `.env`); reachable by every tailnet device. Same origin as the API and the phone page (still true 2026-10-16; isolation prepared in [`studio-isolation.md`](../selfhost-migration/phase-f/studio-isolation.md): Studio on `127.0.0.1:54323` via SSH tunnel once applied) |
| Backups | `/srv/supabase/backups/` (dump/, base/, logs/, status.json, checkpoints); scripts `/srv/supabase/backup/bin/`; config `/srv/supabase/backup/backup.env` (0600); WAL archive `/srv/supabase/stack/volumes/db/wal_archive` |
| Migration apply | `deploy/lucashome/apply-migrations.sh` from the Mac (backs up, records LSN, single transaction) — see [`../runbooks/README.md`](../runbooks/README.md) |
| Config backups | `/srv/supabase/backups/config-backup-20261011T234707Z/` (Postgres config before WAL change); `/srv/supabase/backups/tailscale-preflight-20261011T215421Z/` (Tailscale state before Serve, private keys redacted) |
| Edge functions | `/srv/supabase/stack/volumes/functions/<name>/` (deploy = rsync + `docker compose restart functions`); router `volumes/functions/main/index.ts` patched for `phone-upload-page`, pre-patch copy `index.ts.pre-phone-page`; router script copied to `~/functions-router/` when needed (2026-10-13) |
| Pre-deploy copies kept on the server (2026-10-13 … 16) | removed functions `~/removed-edge-functions-20261013/` (with SHA256SUMS); `~/staff-admin.pre-082`; `~/fn-pre-083`; Envoy template `volumes/api/envoy/lds.template.yaml.pre-g5-headers`; `.env.pre-signup-off-20261013` (0600, same secrecy as `.env`) |
| Recovery-point ledger | `/srv/supabase/backups/migration-checkpoints.txt` (LSN per migration / cleanup; written by `apply-migrations.sh`) |
| Email backup tier | scripts `/srv/supabase/backup/bin/`, settings in `backup.env` (`EMAIL_*`, disabled); Gmail token goes to `/srv/supabase/backup/credentials/` (0700 dir / 0600 file) — **does not exist yet**, the owner copies it there himself ([`owner-setup-checklist.md`](../selfhost-migration/phase-f/owner-setup-checklist.md) Part 4). Owner backup key: owner's Mac keyring + password manager + sealed paper copy (not created yet, Part 1); only the fingerprint and public key ever reach the engineer |
| Security audit (Mac, disposable) | `tools/security-audit/run.sh`; live access only for the read-only schema-parity read via `PHF_ISO_PARITY_SSH=<ssh alias>`; results `tools/security-audit/results/` (git-ignored) |
| Migration workspace (Mac) | `~/shwephala-migration/20261011T2347Z/` (0700) — scrubbed hosted export, manifests, storage copy. Golden copy until offsite backups exist |
