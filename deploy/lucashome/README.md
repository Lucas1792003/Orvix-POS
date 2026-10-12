# Self-hosted Supabase on `lucashome` — deployment manifest

Reproducible description of what is deployed under `/srv/supabase/stack` on
`lucashome`. Secrets live only in `/srv/supabase/stack/.env` (mode 0600,
owner `lucario`) and are never committed, printed, or copied into this repo.

## Pinned upstream

| Item | Value |
|---|---|
| Repository | https://github.com/supabase/supabase |
| Tag | `self-hosted/v0.8.2` → commit `564eab8ad7840b13324f68b1bfac074ef8d51c21` |
| Clone | `/srv/supabase/upstream` (blobless sparse clone of `docker/`) |
| Deployed copy | `/srv/supabase/stack` = `upstream/docker/` + `.env` + `docker-compose.override.yml` + `.supabase-version` (`ref=self-hosted/v0.8.2`) |
| Images | darthsim/imgproxy:v3.31.4 · envoyproxy/envoy:v1.39.1 · postgrest/postgrest:v14.17 · supabase/edge-runtime:v1.76.2 · supabase/gotrue:v2.196.0 · supabase/postgres:17.6.1.136 · supabase/postgres-meta:v0.99.0 · supabase/realtime:v2.134.10 · supabase/storage-api:v1.74.0 · supabase/studio:2026.09.07-sha-7996410 (supavisor:2.9.12 is removed by the override) |

## Files in this directory

| File | Deployed to | Purpose |
|---|---|---|
| `docker-compose.override.yml` | `/srv/supabase/stack/docker-compose.override.yml` | every deviation from upstream (loopback-only gateway, pooler removed, memory limits, log rotation, MFA pin, function secrets, WAL-archive / pg_hba / conf.d mounts on `db` since 2026-10-11) |
| `env.settings.md` | — | the non-secret `.env` keys and their values, so `.env` can be rebuilt from `.env.example` + `generate-keys.sh` + this list |
| `backup/` | `/srv/supabase/backup/bin/` + `backup.env`, crontab of `lucario` | local Postgres backups (hourly logical, daily base, weekly restore drill, status check, WAL archiving applied 2026-10-11) and the **offsite tier (deployed disabled)**: rclone-crypt sync to R2, age-encrypted secrets bundle, offsite restore drill, Mac pull; see [backup/README.md](./backup/README.md), [backup/OFFSITE-ENABLE.md](./backup/OFFSITE-ENABLE.md), [backup/MAC-TIER.md](./backup/MAC-TIER.md) |

`COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml` is set in `.env`,
so `docker compose …` in `/srv/supabase/stack` always applies the override.

## Edge functions

`/srv/supabase/stack/volumes/functions/` contains upstream `main/` and
`deno.jsonc` plus the five app functions copied from `supabase/functions/` in
this repo (`admin-2fa`, `email-sales-report`, `weekly-sales-report`,
`rotate-audit-log`, `platform-console`). Upstream `hello/` removed. Re-sync
with:

```
rsync -a --delete --exclude .DS_Store supabase/functions/<name>/ lucashome:/srv/supabase/stack/volumes/functions/<name>/
```

## Rebuild from scratch (Phase A, no containers started)

```
ls$ cd /srv/supabase && git clone --filter=blob:none --no-checkout --depth=1 --branch self-hosted/v0.8.2 https://github.com/supabase/supabase upstream
ls$ cd upstream && git sparse-checkout init --cone && git sparse-checkout set docker && git checkout
ls$ mkdir -p /srv/supabase/stack && cp -rf /srv/supabase/upstream/docker/. /srv/supabase/stack/ && cd /srv/supabase/stack
ls$ printf 'ref=self-hosted/v0.8.2\n' > .supabase-version
ls$ umask 077 && cp .env.example .env && sh utils/generate-keys.sh --update-env >/dev/null 2>&1 && rm -f .env.old
ls$ # apply env.settings.md values with an editor or sed; append RESEND_API_KEY= / REPORT_EMAIL_FROM=
mac$ scp deploy/lucashome/docker-compose.override.yml lucashome:/srv/supabase/stack/
mac$ rsync … supabase/functions → volumes/functions (see above); remove volumes/functions/hello
ls$ docker compose config --quiet && docker compose pull
```

## Phase B — done 2026-10-11 (see docs/selfhost-migration/evidence/G2/)

Stack running (10 containers), `tailscale serve` active: `https://lucashome.tail8a86e4.ts.net` → `http://127.0.0.1:8000`, tailnet only, Funnel off. Operator set to `lucario`. Commands used:

```
ls$ sudo tailscale set --operator=lucario            # once; lets lucario manage serve/cert without sudo
ls$ cd /srv/supabase/stack && docker compose up -d --wait
ls$ tailscale serve --bg --https=443 http://127.0.0.1:8000
ls$ tailscale serve status && tailscale funnel status   # funnel must stay empty
```

## Building the desktop app against this stack (Phase G)

The renderer bundle inlines its backend at build time. The build is
**fail-closed** (`src/lib/backendConfig.ts`, checked in `vite.config.ts` and
again when the app starts):

| Variable | Value for lucashome | Effect |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://lucashome.tail8a86e4.ts.net` | required; empty/missing → build/app refuses |
| `VITE_SUPABASE_ANON_KEY` | the stack's `ANON_KEY` (public by design) | required |
| `VITE_SUPABASE_EXPECTED_HOST` | `lucashome.tail8a86e4.ts.net` — **set by `npm run build:electron`** | the URL's host must equal it, otherwise `vite build` fails ("Backend host mismatch") and a mis-built app shows "The app cannot start" |

```
mac$ cd /Users/waiyan/Projects/personal/ShwePhaLa
mac$ export VITE_SUPABASE_URL=https://lucashome.tail8a86e4.ts.net
mac$ export VITE_SUPABASE_ANON_KEY="$(ssh -o BatchMode=yes lucashome 'grep "^ANON_KEY=" /srv/supabase/stack/.env | cut -d= -f2-')"
mac$ npm run electron:build:mac      # or electron:build:win — runs build:electron with the host pin
```

Shell variables win over `.env.local` for Vite, so `.env.local` (which may
still hold the hosted project) can stay untouched; with the pin set, a
build that accidentally fell back to it fails instead of shipping. The
running app shows the host it talks to in the login page footer and the
sidebar footer (`backend: lucashome.tail8a86e4.ts.net`).

Migration to apply with the Phase G client: `067_app_setup_needed.sql`
(read-only `app_setup_needed()` for the explicit `/setup` page; see
`docs/selfhost-migration/phase-g/login-signup-fix.md`). Not yet applied.

## Not done in Phase A (deliberately)

- `utils/add-new-auth-keys.sh` (EC key pair, `sb_publishable_…`/`sb_secret_…`
  keys): not run. The app uses the legacy HS256 `ANON_KEY`; the asymmetric
  keys are optional and the script edits the vendor `docker-compose.yml`.
  Can be added later with `utils/rotate-new-api-keys.sh`.
- `db-config` bind mount (04 §4 D3) and the WAL-archive mount: deferred to
  Phase F because the directories must be owned by the image's postgres UID.
- `docker system prune` of the 4 GB build cache on `/`: deletes existing data
  → needs approval.
