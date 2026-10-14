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
| `functions-main-public-page.patch` + `functions-router.sh` | patch applied to `/srv/supabase/stack/volumes/functions/main/index.ts`; script copied to `~/functions-router/` when needed | router allow-list for the public phone page, pinned by sha256 (see "Edge functions" below) |
| `env.settings.md` | — | the non-secret `.env` keys and their values, so `.env` can be rebuilt from `.env.example` + `generate-keys.sh` + this list |
| `backup/` | `/srv/supabase/backup/bin/` + `backup.env`, crontab of `lucario` | local Postgres backups (hourly logical, daily base, weekly restore drill, status check, WAL archiving applied 2026-10-11) and the **offsite tier (deployed disabled)**: rclone-crypt sync to R2, age-encrypted secrets bundle, offsite restore drill, Mac pull; see [backup/README.md](./backup/README.md), [backup/OFFSITE-ENABLE.md](./backup/OFFSITE-ENABLE.md), [backup/MAC-TIER.md](./backup/MAC-TIER.md) |

`COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml` is set in `.env`,
so `docker compose …` in `/srv/supabase/stack` always applies the override.

## Edge functions

`/srv/supabase/stack/volumes/functions/` contains upstream `main/` and
`deno.jsonc` plus the four app functions copied from `supabase/functions/` in
this repo (`admin-2fa`, `email-sales-report`, `phone-upload-token`,
`platform-console`; `staff-admin` is prepared in the repo but NOT deployed yet —
see `docs/selfhost-migration/phase-f/staff-creation.md` §5). `rotate-audit-log` and `weekly-sales-report` were removed
2026-10-13 (moved to `~/removed-edge-functions-20261013/` on the server). Upstream `hello/` removed. Re-sync
with:

```
rsync -a --delete --exclude .DS_Store supabase/functions/<name>/ lucashome:/srv/supabase/stack/volumes/functions/<name>/
```

**Router allow-list (deployed 2026-10-13):** `phone-upload-page` (the phone
page for the packaged app's QR) needs `functions-main-public-page.patch` in
the upstream `main/index.ts`, because a browser navigation cannot pass the
global `VERIFY_JWT` gate. The patch is a small allow-list: GET/HEAD to exactly
`/phone-upload-page` skip the gate. `functions-router.sh` manages it:

| Subcommand | What it does |
|---|---|
| `status` | read-only. Prints `upstream`, `patched` or `unknown` by sha256, plus the allow-list marker and the upstream backup. Exit 1 on unknown |
| `apply` | idempotent. `patched` is a no-op. `upstream` gets a timestamped backup `main/index.ts.pre-phone-page.<UTC>`, `patch --dry-run` on a temp copy, then the patch, then a sha check. `unknown` is refused, with the re-derive steps |
| `revert` | `patched` is restored from the newest backup with the upstream sha, then the sha is checked |
| `verify` | HTTP probes (default: loopback gateway `127.0.0.1:8000`), no data written. Checks the page, then GET/POST 401 for every other function directory found at run time, OPTIONS, path tricks, and the optional anon-key probe |

Pinned: upstream `self-hosted/v0.8.2` `9b7978ab…787d2da6`, patched
`d2901ffa…37cd111bc`. Local tests:
`deploy/lucashome/tests/functions-router-test.sh` (Docker for part B). The
mechanism and the rejected alternative (a full copy mounted over
`main/index.ts`) are described in
`docs/selfhost-migration/phase-f/phone-qr-origin.md` §6, along with the
smoke checks and rollback.

### Upgrade checklist (after ANY stack upgrade / `update.sh`)

Upstream `update.sh` 3-way merges `volumes/functions/main/index.ts`, so an
upgrade can drop the allow-list (page → 401), keep it in a merged file
(unknown hash), or leave conflict markers (functions container will not start).

```
mac$ scp deploy/lucashome/functions-router.sh deploy/lucashome/functions-main-public-page.patch lucashome:~/functions-router/
ls$  ~/functions-router/functions-router.sh status    # patched -> skip to verify; unknown -> re-derive (apply prints how)
ls$  ~/functions-router/functions-router.sh apply     # when status says upstream
ls$  cd /srv/supabase/stack && docker compose restart functions
ls$  ~/functions-router/functions-router.sh verify    # must end "0 failed"
```

`status` can also run without copying anything:
`ssh lucashome 'bash -s -- status' < deploy/lucashome/functions-router.sh`.
`verify` can run from the Mac through the tailnet. Set
`FUNCTIONS_URL=https://lucashome.tail8a86e4.ts.net/functions/v1` and
`FUNCTION_NAMES="<dirs>"`, and optionally `SUPABASE_ANON_KEY` in the
environment only. `backup-status.sh` does not check the router: it is a
backup-health hook, and an unpatched router fails closed (the phone page
answers 401).

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
