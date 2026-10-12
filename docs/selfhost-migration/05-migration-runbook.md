# 05 · Migration Runbook

Status: **not executed**. This runbook is the single procedure used for the
rehearsal (R1), the rebuild (R2), and the final cutover (G11). Anything that
had to be improvised during R2 is a defect here.

Conventions:
- `mac$` = on the Mac in `/Users/waiyan/Projects/personal/ShwePhaLa`;
  `ls$` = on `lucashome` as `lucario`; `db$` = inside the `supabase-db` container.
- `<…>` = value supplied at run time, never written into this file.
- Every section ends with a **Verify** block; do not continue on a failed verify.
- Hosted Supabase is touched only by the read-only commands in §3.
- No command in this file is run until the gate that owns it is approved
  ([10-go-no-go-checklist.md](./10-go-no-go-checklist.md)).

## 1. Pre-flight (Mac)

```
mac$ supabase --version                 # 2.115.0 (update to 2.120.0 first is fine; re-check dump flags)
mac$ docker info >/dev/null && echo ok  # supabase db dump uses a pg_dump container
mac$ supabase projects list | grep -c '"linked":true'   # 1 — linked to shwephala
mac$ supabase migration list --linked | grep -c remote  # 61
mac$ git status --short | wc -l          # record; commit 059-061 first (O10)
mac$ mkdir -p ~/shwephala-migration && chmod 700 ~/shwephala-migration   # dump workspace, NOT in the repo, NOT in iCloud
```

Hosted DB password: `supabase db dump` needs it. Supply interactively with
`-p` prompt or `SUPABASE_DB_PASSWORD` in the shell for that command only; never
write it to a file.

**Verify:** linked project is `gzqiukxnzfdouwaotelx`; workspace exists; owner
has approved checkpoint 4 (export) before §3 is run.

## 2. Build the empty self-hosted stack on `lucashome` (gate G2)

### 2.1 Clone the release tag (replaces the master clone)

```
ls$ rm -rf /srv/supabase/upstream          # read-only clone, no state
ls$ cd /srv/supabase
ls$ git clone --filter=blob:none --no-checkout --depth=1 --quiet --branch self-hosted/v0.8.2 https://github.com/supabase/supabase upstream
ls$ cd upstream && git sparse-checkout init --cone && git sparse-checkout set docker && git checkout --quiet
ls$ git rev-parse HEAD                      # 564eab8ad7840b13324f68b1bfac074ef8d51c21
ls$ mkdir -p /srv/supabase/stack && cp -rf /srv/supabase/upstream/docker/. /srv/supabase/stack/
ls$ cd /srv/supabase/stack && cp .env.example .env && chmod 600 .env
ls$ printf 'ref=self-hosted/v0.8.2\n' > .supabase-version
```

### 2.2 Secrets

```
ls$ sh utils/generate-keys.sh --update-env          # POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, SECRET_KEY_BASE, REALTIME_DB_ENC_KEY, VAULT_ENC_KEY, PG_META_CRYPTO_KEY, S3_PROTOCOL_*, DASHBOARD_PASSWORD
ls$ sh utils/add-new-auth-keys.sh                   # EC key pair (JWT_KEYS/JWT_JWKS), sb_publishable/sb_secret, *_ASYMMETRIC (needs node>=16 or docker)
ls$ rm -f .env.old                                  # generate-keys leaves a sed backup
```

Then edit `.env` (values, not names, are secret; set with an editor, never `echo`):

| Key | Value |
|---|---|
| `COMPOSE_FILE` | `docker-compose.yml:docker-compose.override.yml` |
| `SUPABASE_PUBLIC_URL` | `https://lucashome.tail8a86e4.ts.net` |
| `API_EXTERNAL_URL` | `https://lucashome.tail8a86e4.ts.net/auth/v1` |
| `SITE_URL` | `https://lucashome.tail8a86e4.ts.net` |
| `JWT_EXPIRY` | `3600` (hosted parity) — or the A6 decision |
| `DISABLE_SIGNUP` | `false` |
| `ENABLE_EMAIL_SIGNUP` | `true` |
| `ENABLE_EMAIL_AUTOCONFIRM` | `true` (hosted parity) |
| `ENABLE_PHONE_SIGNUP` / `ENABLE_PHONE_AUTOCONFIRM` | `false` / `false` |
| `ENABLE_ANONYMOUS_USERS` | `false` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_ADMIN_EMAIL` / `SMTP_SENDER_NAME` | `smtp.resend.com` / `465` / `resend` / `<Resend API key>` / `<sender>` / `Shwe PhaLar` (rehearsal R1: leave `SMTP_PASS` blank) |
| `FUNCTIONS_VERIFY_JWT` | `true` |
| `PGRST_DB_MAX_ROWS` | `1000` |
| `STUDIO_DEFAULT_ORGANIZATION` / `STUDIO_DEFAULT_PROJECT` | `Shwe PhaLar` / `pos` |
| `DASHBOARD_USERNAME` | `<admin name>` |
| `MFA_TOTP_ENROLL_ENABLED` / `MFA_TOTP_VERIFY_ENABLED` / `MFA_MAX_ENROLLED_FACTORS` | `true` / `true` / `10` (uncomment) |
| `RESEND_API_KEY` / `REPORT_EMAIL_FROM` | **absent in R1**; set for R1.12 and production |

### 2.3 Override file (the only customisation)

**Source of truth: `deploy/lucashome/docker-compose.override.yml` in this repo**
(copied to `/srv/supabase/stack/docker-compose.override.yml`). Phase A
(2026-10-11) deployed it **without** the `db.volumes` override below — the
`db-config` bind mount and WAL-archive mount are added in Phase F once the
image's postgres UID is known. The block below is the Phase F target:

```yaml
services:
  api-gw:
    ports: !override
      - "127.0.0.1:${API_GW_HTTP_PORT:-8000}:8000/tcp"
    mem_limit: 256m
    logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } }
  supavisor: !reset null
  db:
    volumes: !override
      - ./volumes/db/realtime.sql:/docker-entrypoint-initdb.d/migrations/99-realtime.sql:Z
      - ./volumes/db/webhooks.sql:/docker-entrypoint-initdb.d/init-scripts/98-webhooks.sql:Z
      - ./volumes/db/roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:Z
      - ./volumes/db/jwt.sql:/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:Z
      - ./volumes/db/data:/var/lib/postgresql/data:Z
      - ./volumes/db/_supabase.sql:/docker-entrypoint-initdb.d/migrations/97-_supabase.sql:Z
      - ./volumes/db/logs.sql:/docker-entrypoint-initdb.d/migrations/99-logs.sql:Z
      - ./volumes/db/pooler.sql:/docker-entrypoint-initdb.d/migrations/99-pooler.sql:Z
      - ./volumes/db/config:/etc/postgresql-custom:Z          # D3: was named volume db-config
      - ./volumes/db/wal_archive:/var/lib/postgresql/wal_archive:Z   # 07 §3.1
    mem_limit: 2g
    logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } }
  auth:
    environment:
      GOTRUE_MFA_TOTP_ENROLL_ENABLED: ${MFA_TOTP_ENROLL_ENABLED}
      GOTRUE_MFA_TOTP_VERIFY_ENABLED: ${MFA_TOTP_VERIFY_ENABLED}
      GOTRUE_MFA_MAX_ENROLLED_FACTORS: ${MFA_MAX_ENROLLED_FACTORS}
      GOTRUE_PASSWORD_MIN_LENGTH: "6"
    mem_limit: 256m
    logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } }
  functions:
    environment:
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      REPORT_EMAIL_FROM: ${REPORT_EMAIL_FROM:-}
    mem_limit: 512m
    logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } }
  rest:      { mem_limit: 256m, logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } } }
  realtime:  { mem_limit: 512m, logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } } }
  storage:   { mem_limit: 512m, logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } } }
  imgproxy:  { mem_limit: 256m, logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } } }
  meta:      { mem_limit: 256m, logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } } }
  studio:    { mem_limit: 512m, logging: { driver: json-file, options: { max-size: "20m", max-file: "5" } } }
```

The `db.volumes` list must repeat the upstream entries verbatim (copy them from
`docker-compose.yml` at the pinned tag; the list above mirrors v0.8.2 and must
be re-checked on every `update.sh`). The `db-config` named volume in the base
file becomes unused; `docker compose config` must show no reference to it.

```
ls$ mkdir -p volumes/db/config volumes/db/wal_archive
ls$ docker compose config --quiet && echo "compose ok"
ls$ docker compose config | grep -nE 'published|target: (5432|6543|8000)'   # only 127.0.0.1:8000
```

### 2.4 Functions

```
mac$ rsync -av --delete supabase/functions/ lucashome:/srv/supabase/stack/volumes/functions/app/   # staging copy
ls$ cd /srv/supabase/stack/volumes/functions
ls$ for f in admin-2fa email-sales-report weekly-sales-report rotate-audit-log platform-console; do rm -rf "$f"; cp -r "app/$f" "$f"; done; rm -rf app
ls$ ls                                         # main/ hello/ deno.jsonc + the five
```

`main/index.ts` and `deno.jsonc` stay upstream. `hello/` may be removed.

### 2.5 Start

```
ls$ docker system prune -f --filter "until=720h"   # reclaims the 4 GB build cache on / (approved host change)
ls$ cd /srv/supabase/stack && docker compose pull
ls$ docker compose up -d --wait
ls$ docker compose ps                               # 10 containers, all healthy (meta has no healthcheck: running)
ls$ ss -tlnp 2>/dev/null | grep -E ':(8000|5432|6543) '   # only 127.0.0.1:8000 new; 127.0.0.1:5432 is the pre-existing postgres:18
ls$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/auth/v1/health   # 200
```

### 2.6 Postgres post-init (first boot only)

```
db$ psql -U supabase_admin -d postgres
  CREATE EXTENSION IF NOT EXISTS pg_cron;            -- image preloads it (confirm: SHOW shared_preload_libraries)
  CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;   -- hosted has it in public; see §4.2
  CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA extensions;
  CREATE EXTENSION IF NOT EXISTS supabase_vault;
  SHOW timezone;                                     -- UTC (else ALTER SYSTEM SET timezone='UTC')
  SHOW cron.timezone;                                -- GMT/UTC
  SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime';   -- create in §4.6 if absent
```

WAL archiving settings per [07 §3.1](./07-backup-disaster-recovery.md) are
added here once the image's custom-config mechanism is confirmed
(`/etc/postgresql-custom/*.conf` include, or `ALTER SYSTEM`).

### 2.7 Tailscale TLS (one sudo command, owner)

```
ls$ sudo tailscale set --operator=lucario             # once
ls$ tailscale serve --bg --https=443 http://127.0.0.1:8000
ls$ tailscale serve status                            # https://lucashome.tail8a86e4.ts.net -> http://127.0.0.1:8000
ls$ tailscale funnel status                           # "No serve config" / nothing funneled — MUST stay off
mac$ curl -s https://lucashome.tail8a86e4.ts.net/auth/v1/health     # {"version":...}
mac$ curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: <ANON_KEY>" https://lucashome.tail8a86e4.ts.net/rest/v1/   # 401/403 (anon may not read OpenAPI) — proves the gateway and key path
```

If `serve` fails because of the stale 443 listener (01 §4): `sudo systemctl
restart tailscaled` (owner) and retry; fallback `--https=8443`.

**Verify (G2):** all of the above; `docker stats --no-stream` recorded as the
idle baseline; a Studio login over Tailscale works with `DASHBOARD_*`; SMTP
test from Studio (production only); `docker compose config` contains no
`db-config` reference; `tailscale funnel status` empty.

## 3. Export from hosted (read-only) — gates G4 (rehearsal) and G11 (final)

All files go to `~/shwephala-migration/<yyyy-mm-dd-HHMM>/` on the Mac (0700).
Run §3.1–§3.5 **within the same few minutes** after the freeze (§3.0).

### 3.0 Freeze (final cutover only; nominal for rehearsal)

```
mac$ supabase db query --linked "select (select count(*) from shifts where ended_at is null) open_shifts, (select max(created_at) from sales) last_sale, (select max(created_at) from audit_logs) last_audit, now()"
```
Proceed only with `open_shifts = 0`. Staff have been told to stop (08 P7).

### 3.1 Row-count manifest (consistency reference)

```
mac$ supabase db query --linked -f docs/selfhost-migration/sql/manifest.sql > manifest-hosted.json
```
`manifest.sql` (to be added to the repo before R1): `count(*)` for every
`public` table, `auth.users`, `auth.identities`, `auth.mfa_factors`,
`auth.sessions`, `auth.refresh_tokens`, `storage.objects`, `storage.buckets`,
plus `md5(string_agg(id::text, ',' ORDER BY id))` for `products`, `product_units`,
`product_unit_prices`, `inventory`, `users`, `auth.users` as a content checksum,
and `max(created_at)` for `sales`, `audit_logs`, `inventory_movements`.

### 3.2 Dumps

```
mac$ export SUPABASE_DB_PASSWORD='<hosted db password>'    # for this shell only; `unset` afterwards
mac$ supabase db dump --linked --role-only -f roles.sql
mac$ supabase db dump --linked -f schema.sql
mac$ supabase db dump --linked --data-only --use-copy -f data.sql \
      -x cron.job_run_details -x net._http_response -x net.http_request_queue \
      -x storage.objects -x storage.buckets -x storage.s3_multipart_uploads -x storage.s3_multipart_uploads_parts \
      -x storage.buckets_analytics -x storage.buckets_vectors -x storage.vector_indexes \
      -x auth.audit_log_entries -x auth.flow_state -x auth.one_time_tokens -x auth.mfa_challenges \
      -x auth.mfa_recovery_code_sets -x auth.mfa_recovery_codes -x auth.scim_tokens -x auth.scim_users
      # the last line: tables that exist on hosted (GoTrue platform build, migrations 20260821–20260831) but not in
      # self-hosted GoTrue v2.196.0 — all empty on hosted (evidence/G4/2026-10-11-schema-compatibility.md)
mac$ unset SUPABASE_DB_PASSWORD
mac$ ls -la; sha256sum roles.sql schema.sql data.sql > SHA256SUMS
```

Rationale for `-x`: run-history and response logs are 65 % of the DB and
useless; storage rows are re-created by re-upload (§4.5); `mfa_challenges`
are transient (38 rows) and `audit_log_entries` is empty; `cron.job` is
**kept** so the two definitions travel, but is scrubbed and replaced (§3.4, §4.8).

### 3.3 Storage objects + manifest

```
mac$ mkdir -p storage/product-images
mac$ supabase storage cp --linked -r ss:///product-images/ ./storage/product-images/ -j 4
mac$ find storage/product-images -type f | wc -l                 # 574 (as of 2026-10-11)
mac$ (cd storage && find product-images -type f -exec md5sum {} + | sort -k2) > storage-manifest.md5
```
Plus the metadata the download loses (content type, cache control):
```
mac$ supabase db query --linked "select name, metadata->>'mimetype' mime, metadata->>'size' size, metadata->>'cacheControl' cc from storage.objects where bucket_id='product-images' order by name" > storage-objects.json
```

### 3.4 Scrub (mandatory before any file leaves the Mac)

```
mac$ grep -c 'eyJ[A-Za-z0-9_-]\{20,\}' data.sql schema.sql roles.sql      # expect data.sql: 2 (the cron commands), others 0
mac$ python3 docs/selfhost-migration/scripts/scrub_dump.py data.sql data.scrubbed.sql   # to be written before R1: drops the COPY block for "cron"."job" into cron-job.redacted.txt with tokens replaced, drops any line containing a JWT, drops CREATE ROLE/ALTER ROLE "cli_login_postgres" from roles.sql
mac$ grep -c 'eyJ[A-Za-z0-9_-]\{20,\}' data.scrubbed.sql   # 0 — hard stop otherwise
mac$ grep -n 'cli_login_postgres' roles.sql                  # remove those lines (CLI artefact)
mac$ grep -n '^SET transaction_timeout' data.scrubbed.sql    # harmless on PG17; comment out for safety
```

### 3.5 Auth/config exports (read-only, names/settings only)

Already captured in [02](./02-production-dependencies.md) §2–§3; re-export at
cutover for the record: auth config JSON (secrets stripped), PostgREST config,
`supabase secrets list` names, `supabase functions list`.

**Verify:** `SHA256SUMS` written; manifest JSON present; `grep -c eyJ` = 0 on
the scrubbed data file; object count equals `storage.objects` count in the
manifest; workspace is 0700 and outside the repo and iCloud.

## 4. Restore into the self-hosted stack — gates G4 / G11

### 4.1 Transfer

```
mac$ rsync -av --chmod=F600,D700 ~/shwephala-migration/<ts>/ lucashome:/srv/supabase/backups/import-<ts>/
```

### 4.2 Schema and data (triggers disabled)

The stack must have booted once (§2) so GoTrue and storage-api have created
their schemas at their own versions.

```
ls$ cd /srv/supabase/stack && I=/srv/supabase/backups/import-<ts>
ls$ docker compose cp $I/roles.sql db:/tmp/roles.sql && docker compose cp $I/schema.sql db:/tmp/schema.sql && docker compose cp $I/data.scrubbed.sql db:/tmp/data.sql
db$ psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction \
      --file /tmp/roles.sql \
      --file /tmp/schema.sql \
      --command 'SET session_replication_role = replica' \
      --file /tmp/data.sql 2>&1 | tee /tmp/restore.log
```

Expected and acceptable failures to pre-handle (make the script tolerate them
explicitly rather than dropping `ON_ERROR_STOP`):
- `CREATE EXTENSION "pg_net" WITH SCHEMA "public"` — on the image `pg_net` is
  already in `extensions`; the statement is `IF NOT EXISTS` and succeeds or
  no-ops. If a `public.net` schema mismatch appears, keep `extensions` and rely
  on the search path (the cron commands reference `net.http_post`, which is
  the schema `net`, independent of where the extension object lives).
- `GRANT … TO "supabase_etl_admin"` / `"supabase_privileged_role"` if those
  roles are absent in the image: pre-create them as `NOLOGIN` in `roles.sql`
  (the CLI dump comments out reserved roles but not these two).
- Column mismatch on `COPY "auth"."…"`: the dump lists columns explicitly, so
  only a column that exists on hosted and not on v2.196 fails — none expected
  (self-hosted is newer); if one appears, drop that column from the COPY
  header and record it.

### 4.3 Sequences
None in `public` (V). `auth.refresh_tokens_id_seq` is the only sequence with
restored data: `SELECT setval('auth.refresh_tokens_id_seq', (SELECT max(id) FROM auth.refresh_tokens));`

### 4.4 Migration history
```
db$ INSERT INTO supabase_migrations.schema_migrations(version, name)
    SELECT lpad(g::text,3,'0'), '' FROM generate_series(1,61) g ON CONFLICT DO NOTHING;
```
(Exact `name` values from the hosted table are in the §3.1 export; use them.)

### 4.5 Storage

```
mac$ # bucket, via the new API with the new service key (never the hosted key)
mac$ curl -s -X POST https://lucashome.tail8a86e4.ts.net/storage/v1/bucket -H "Authorization: Bearer <NEW_SERVICE_ROLE_KEY>" -H "apikey: <NEW_SERVICE_ROLE_KEY>" -H 'Content-Type: application/json' -d '{"id":"product-images","name":"product-images","public":true}'
mac$ python3 docs/selfhost-migration/scripts/upload_objects.py storage/product-images storage-objects.json https://lucashome.tail8a86e4.ts.net   # to be written before R1: PUT /storage/v1/object/product-images/<name> with the original content-type and cache-control, 4 parallel, retry 3×, prints uploaded/failed
mac$ python3 docs/selfhost-migration/scripts/verify_objects.py storage-manifest.md5 https://lucashome.tail8a86e4.ts.net   # GET each public URL, compare md5 → "574/574 ok"
```

### 4.6 URL rewrite and publication

```
db$ UPDATE public.products SET image_url = replace(image_url, 'https://gzqiukxnzfdouwaotelx.supabase.co', 'https://lucashome.tail8a86e4.ts.net') WHERE image_url LIKE 'https://gzqiukxnzfdouwaotelx.supabase.co/%';
db$ UPDATE public.business_profile SET logo_url = replace(logo_url, 'https://gzqiukxnzfdouwaotelx.supabase.co', 'https://lucashome.tail8a86e4.ts.net') WHERE logo_url LIKE 'https://gzqiukxnzfdouwaotelx.supabase.co/%';   -- column name confirmed from schema.sql at R1
db$ SELECT count(*) FROM products WHERE image_url LIKE '%supabase.co%';    -- 0
db$ CREATE PUBLICATION supabase_realtime FOR TABLE public.inventory;        -- only if absent (§2.6)
db$ SELECT * FROM pg_publication_tables WHERE pubname='supabase_realtime';  -- public.inventory
```

### 4.7 Security fix-ups carried from the audit (02 §1)
```
db$ REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
db$ ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
```
(Apply the same as migration 062 on hosted later; keep both sides identical.)

### 4.8 Cron jobs
```
db$ DELETE FROM cron.job;    -- the restored rows carry the hosted URL and a scrubbed/old key
db$ SELECT cron.schedule('rotate-audit-log', '*/5 * * * *', $$ select net.http_post(url:='http://api-gw:8000/functions/v1/rotate-audit-log', headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer <NEW_SERVICE_ROLE_KEY>'), body:='{}'::jsonb) $$);
db$ SELECT cron.schedule('weekly-sales-report', '30 17 * * 0', $$ select net.http_post(url:='http://api-gw:8000/functions/v1/weekly-sales-report', headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer <NEW_SERVICE_ROLE_KEY>'), body:='{}'::jsonb) $$);
db$ SELECT jobid, jobname, schedule, active FROM cron.job;   -- 2 rows
```
Rehearsal R1: **do not run §4.8** until emails are masked (06 §1.3) and
`RESEND_API_KEY` is deliberately set for R1.12. Then verify within 10 minutes:
`SELECT status, return_message FROM cron.job_run_details ORDER BY start_time DESC LIMIT 3;`

Update the repo copies `supabase/schedule_audit_rotation.sql` and
`supabase/schedule_weekly_sales_report.sql` to use a placeholder URL + key
and document the internal URL for self-hosting.

### 4.9 Rehearsal-only: mask emails (06 §1.3) — **skip at the final cutover**
```
db$ UPDATE auth.users SET email = 'delivered+' || left(id::text,8) || '@resend.dev', raw_user_meta_data = raw_user_meta_data - 'email';
db$ UPDATE public.users SET email = 'delivered+' || left(id,8) || '@resend.dev';
db$ SELECT count(*) FROM auth.users WHERE email NOT LIKE '%@resend.dev';   -- 0
```

### 4.10 Manifest comparison
```
db$ \i /tmp/manifest.sql      -- same SQL as §3.1
```
Diff against `manifest-hosted.json`: every count equal except the tables
deliberately excluded (`storage.objects` is compared against the upload
script's count instead; `auth.mfa_challenges`, `auth.audit_log_entries`
expected 0). Content checksums (`md5(string_agg(id …))`) must match exactly.

**Verify (G4/G11):** restore log has no errors beyond the pre-handled list;
manifest diff clean; `574/574 ok` from `verify_objects.py`; `products` with
`supabase.co` = 0; publication present; 2 cron jobs (production) or 0
(rehearsal before R1.12); `REVOKE … FROM anon` applied; functions respond
(`curl -X POST …/functions/v1/platform-console` with a bad body → 4xx, not 5xx).

## 5. Application build and release (owner approval before any publish)

```
mac$ # .env.local: VITE_SUPABASE_URL=https://lucashome.tail8a86e4.ts.net, VITE_SUPABASE_ANON_KEY=<NEW_ANON_KEY>
mac$ npm ci && npm test
mac$ npm version 1.0.16 --no-git-tag-version          # commit on a branch; no push without approval
mac$ npm run electron:build:win                          # never bare electron-builder (web dist != electron dist)
mac$ ls release/ | grep -c 'Shwe-Pha-La-POS'            # installer + latest.yml present
```
Rehearsal: run the installer locally / on the Windows test machine; **do not
publish**. Cutover: `gh release create v1.0.16 --prerelease …` per
[08](./08-cutover-rollback.md) §3, then promote.

A parallel `v1.0.17-rollback` build with the hosted URL/key is produced and
archived at the same time (08 P3).

## 6. Post-restore checks that need the app

R1.8–R1.15 in [06](./06-rehearsal-test-plan.md). Evidence into
`docs/selfhost-migration/evidence/G4..G6/`.

## 7. Tooling this runbook references

Built 2026-10-11 (Phase C step 2), 41 unit tests on synthetic fixtures, no
secrets embedded (keys via environment at run time). See
`tools/selfhost-migration/README.md` for usage and the end-to-end order.

| File | Purpose |
|---|---|
| `tools/selfhost-migration/sql/manifest.sql` (+ `gen_manifest.py`, `sql/tables.default.txt`) | row counts, content checksums, max timestamps, sequence, publication, policy/function summaries — same SQL on both sides |
| `tools/selfhost-migration/manifest_diff.py` | compare hosted vs self-hosted manifests; exit 1 on mismatch |
| `tools/selfhost-migration/scrub_dump.py` | drop/redact `cron.job`, drop excluded blocks, hard-stop on any remaining secret, comment `transaction_timeout`, drop `cli_login_postgres` from roles |
| `tools/selfhost-migration/check_secrets.py` | gate: no secret-shaped strings in files about to move |
| `tools/selfhost-migration/schema_compat.py` (+ `sql/columns_inventory.sql`, `sql/constraints_inventory.sql`) | hosted vs self-hosted auth/storage column comparison; `--fix-dump` drops hosted-only columns/tables from COPY blocks |
| `tools/selfhost-migration/upload_objects.py` / `verify_objects.py` | re-upload objects by name with original metadata; verify SHA-256 + size over the public URL |
| `tools/selfhost-migration/sql/post_restore_checks.sql` | orphans, URL hosts, setval, publication, anon EXECUTE, RLS, leftover policies, migrations |
| `tools/selfhost-migration/render_cron.py` (+ `sql/recreate_cron.sql.template`) | render the two cron jobs with the internal URL and the new service key (env) |
| `deploy/lucashome/backup/*` | hourly logical dump, daily base backup, prune, restore test, status (07) |

Still to write: layer-B probe and layer-C collector (09), `cleanup_import.sh`.
