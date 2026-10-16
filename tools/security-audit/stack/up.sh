#!/usr/bin/env bash
# Disposable Supabase-shaped stack for the org-isolation security audit.
# Every container/network/volume is named phf-iso-*, every port is published
# on 127.0.0.1 only, every secret is random per run and written only to
# $PHF_ISO_WORK/secrets.env (mode 0600). Nothing here contacts a real server.
#
# Sourced by ../run.sh (needs: HERE, REPO, WORK, MAX_MIG, BASELINE_SQL, log, die).
# Order matters: GoTrue and storage-api must migrate auth/storage BEFORE the
# app baseline is restored (the baseline has FKs to auth.users and policies
# on storage.objects), exactly like a fresh production install.

NET=phf-iso-net
DB=phf-iso-db; AUTH=phf-iso-auth; REST=phf-iso-rest; STORE=phf-iso-storage; FN=phf-iso-fn; GW=phf-iso-gw
DB_IMAGE="${PHF_ISO_DB_IMAGE:-supabase/postgres:17.6.1.136}"
AUTH_IMAGE="${PHF_ISO_AUTH_IMAGE:-supabase/gotrue:v2.196.0}"
REST_IMAGE="${PHF_ISO_REST_IMAGE:-postgrest/postgrest:v14.17}"
STORE_IMAGE="${PHF_ISO_STORAGE_IMAGE:-supabase/storage-api:v1.74.0}"
EDGE_IMAGE="${PHF_ISO_EDGE_IMAGE:-supabase/edge-runtime:v1.76.2}"
NODE_IMAGE="${PHF_ISO_NODE_IMAGE:-node:24-slim}"
# Upstream self-hosted router (pinned; sha-checked against functions-router.sh)
UPSTREAM_COMMIT=564eab8ad7840b13324f68b1bfac074ef8d51c21

stack_down() {
  docker rm -f "$GW" "$FN" "$REST" "$STORE" "$AUTH" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm phf-iso-storage-data >/dev/null 2>&1 || true
}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
mkjwt() {  # mkjwt <role>  (HS256, this run's secret)
  local h p s
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '{"role":"%s","iss":"phf-iso","iat":%s,"exp":%s}' "$1" "$(date +%s)" "$(( $(date +%s) + 86400 ))" | b64url)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -mac HMAC -macopt "key:$JWT_SECRET" -binary | b64url)
  printf '%s.%s.%s' "$h" "$p" "$s"
}

su_psql() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
pg_psql() { docker exec -i -e PGPASSWORD="$DB_PW" "$DB" psql -X -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

wait_http() {  # wait_http <url> <accept-regex> <seconds>
  local i c
  for i in $(seq 1 "$3"); do
    c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" || true)
    if printf '%s' "$c" | grep -Eq "$2"; then return 0; fi
    sleep 1
  done
  echo "timeout: $1 (last $c)"; return 1
}

fetch_upstream_router() {  # -> $WORK/fn/main/index.ts (patched) + deno.jsonc
  local cache="$HERE/.cache/upstream-$UPSTREAM_COMMIT" want_up want_pa
  want_up=$(sed -n 's/^UPSTREAM_SHA=\([0-9a-f]\{64\}\)$/\1/p' "$REPO/deploy/lucashome/functions-router.sh")
  want_pa=$(sed -n 's/^PATCHED_SHA=\([0-9a-f]\{64\}\)$/\1/p' "$REPO/deploy/lucashome/functions-router.sh")
  mkdir -p "$cache"
  if [ -n "${UPSTREAM_ROUTER:-}" ]; then cp "$UPSTREAM_ROUTER" "$cache/index.ts"; fi
  for f in main/index.ts deno.jsonc; do
    local dst="$cache/$(basename "$f")"
    [ -s "$dst" ] || curl -sSfL "https://raw.githubusercontent.com/supabase/supabase/$UPSTREAM_COMMIT/docker/volumes/functions/$f" -o "$dst" \
      || die "cannot fetch upstream $f (set UPSTREAM_ROUTER=<path to main/index.ts> to use a local copy)"
  done
  [ "$(shasum -a 256 "$cache/index.ts" | cut -d' ' -f1)" = "$want_up" ] || die "upstream router sha mismatch"
  mkdir -p "$WORK/fn/main"
  cp "$cache/index.ts" "$WORK/fn/main/index.ts"; cp "$cache/deno.jsonc" "$WORK/fn/deno.jsonc"
  ( cd "$WORK/fn" && patch -p1 -s < "$REPO/deploy/lucashome/functions-main-public-page.patch" ) || die "router patch failed"
  [ "$(shasum -a 256 "$WORK/fn/main/index.ts" | cut -d' ' -f1)" = "$want_pa" ] || die "patched router sha mismatch"
  echo "router: upstream $UPSTREAM_COMMIT + functions-main-public-page.patch (sha = PATCHED_SHA)"
}

stack_up() {
  stack_down
  DB_PW="$(openssl rand -hex 16)"; AUTH_PW="$(openssl rand -hex 16)"
  JWT_SECRET="$(openssl rand -hex 32)"
  ANON_KEY="$(mkjwt anon)"; SERVICE_KEY="$(mkjwt service_role)"
  ( umask 077; cat > "$WORK/secrets.env" <<EOF
PHF_ISO_JWT_SECRET=$JWT_SECRET
PHF_ISO_ANON_KEY=$ANON_KEY
PHF_ISO_SERVICE_KEY=$SERVICE_KEY
PHF_ISO_DB_PW=$DB_PW
EOF
  )

  docker network create "$NET" >/dev/null || die "network create failed"

  log "db ($DB_IMAGE)"
  docker run -d --name "$DB" --network "$NET" -p 127.0.0.1::5432 --memory 1536m \
    -e POSTGRES_PASSWORD="$DB_PW" "$DB_IMAGE" >/dev/null || die "db run failed"
  local i
  for i in $(seq 1 120); do su_psql -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
  sleep 4
  su_psql -Atc 'select 1' >/dev/null 2>&1 || { docker logs "$DB" 2>&1 | tail -30; die "db did not come up"; }
  # service logins (random per run; supplied on stdin, never on a command line)
  printf "ALTER ROLE authenticator WITH LOGIN PASSWORD '%s';
ALTER ROLE supabase_auth_admin WITH LOGIN PASSWORD '%s';
ALTER ROLE supabase_storage_admin WITH LOGIN PASSWORD '%s';
ALTER ROLE postgres WITH LOGIN PASSWORD '%s';\n" "$AUTH_PW" "$AUTH_PW" "$AUTH_PW" "$DB_PW" | su_psql >/dev/null || die "role passwords"

  log "GoTrue ($AUTH_IMAGE, DISABLE_SIGNUP=true, TOTP on — production settings)"
  docker run -d --name "$AUTH" --network "$NET" \
    -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://127.0.0.1/auth/v1 \
    -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:$AUTH_PW@$DB:5432/postgres" \
    -e GOTRUE_SITE_URL=http://127.0.0.1 -e GOTRUE_URI_ALLOW_LIST= \
    -e GOTRUE_DISABLE_SIGNUP=true -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_JWT_AUD=authenticated \
    -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_SECRET="$JWT_SECRET" \
    -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false \
    -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_SMS_AUTOCONFIRM=false -e GOTRUE_EXTERNAL_PHONE_ENABLED=false \
    -e GOTRUE_MFA_TOTP_ENROLL_ENABLED=true -e GOTRUE_MFA_TOTP_VERIFY_ENABLED=true -e GOTRUE_MFA_MAX_ENROLLED_FACTORS=10 \
    -e GOTRUE_PASSWORD_MIN_LENGTH=6 -e GOTRUE_RATE_LIMIT_VERIFY=100000 -e GOTRUE_RATE_LIMIT_TOKEN_REFRESH=100000 \
    -e GOTRUE_RATE_LIMIT_EMAIL_SENT=100000 -e GOTRUE_RATE_LIMIT_OTP=100000 -e GOTRUE_SMTP_HOST= \
    "$AUTH_IMAGE" >/dev/null || die "auth run failed"
  for i in $(seq 1 90); do
    docker exec "$AUTH" wget -qO- http://127.0.0.1:9999/health >/dev/null 2>&1 && break; sleep 1
  done
  docker exec "$AUTH" wget -qO- http://127.0.0.1:9999/health >/dev/null 2>&1 || { docker logs "$AUTH" 2>&1 | tail -30; die "GoTrue did not come up"; }

  log "storage-api ($STORE_IMAGE, file backend on a disposable docker volume: storage-api needs xattrs, which macOS bind mounts lack)"
  docker run -d --name "$STORE" --network "$NET" -v phf-iso-storage-data:/var/lib/storage \
    -e ANON_KEY="$ANON_KEY" -e SERVICE_KEY="$SERVICE_KEY" -e POSTGREST_URL="http://$REST:3000" \
    -e PGRST_JWT_SECRET="$JWT_SECRET" -e AUTH_JWT_SECRET="$JWT_SECRET" \
    -e DATABASE_URL="postgres://supabase_storage_admin:$AUTH_PW@$DB:5432/postgres" \
    -e FILE_SIZE_LIMIT=52428800 -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/var/lib/storage \
    -e TENANT_ID=stub -e REGION=stub -e GLOBAL_S3_BUCKET=stub -e ENABLE_IMAGE_TRANSFORMATION=false \
    -e UPLOAD_SIGNED_URL_EXPIRATION_TIME=60 \
    "$STORE_IMAGE" >/dev/null || die "storage run failed"
  for i in $(seq 1 120); do
    [ "$(su_psql -Atc "select to_regclass('storage.objects') is not null and exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='storage' and proname='foldername')")" = t ] && break
    sleep 1
  done
  [ "$(su_psql -Atc "select to_regclass('storage.objects') is not null")" = t ] || { docker logs "$STORE" 2>&1 | tail -30; die "storage did not migrate"; }
  sleep 3

  log "app schema: prep, baseline, storage 016, migrations > 061 and <= $MAX_MIG"
  su_psql -At < "$REPO/supabase/tests/phase-d/sql/00_prep.sql" > "$WORK/prep.log" 2>&1 || { cat "$WORK/prep.log"; die "prep"; }
  if grep -q 'created minimal auth.users shim\|created storage shim\|created auth.mfa_factors shim\|created auth.jwt() shim' "$WORK/prep.log"; then
    die "prep created a shim — GoTrue/storage did not create the real objects"
  fi
  su_psql < "$BASELINE_SQL" > "$WORK/baseline.log" 2>&1 || { tail -30 "$WORK/baseline.log"; die "baseline restore"; }
  su_psql < "$REPO/supabase/migrations/016_product_images_storage.sql" > "$WORK/016.log" 2>&1 || { tail -10 "$WORK/016.log"; die "016"; }
  local f n applied=""
  for f in "$REPO"/supabase/migrations/*.sql; do
    n="$(basename "$f" | cut -d_ -f1)"
    case "$n" in ''|*[!0-9]*) continue;; esac
    case " ${PHF_ISO_SKIP_MIGRATIONS:-} " in *" $((10#$n)) "*|*" $n "*) log "skipping migration $n (PHF_ISO_SKIP_MIGRATIONS)"; continue;; esac
    if [ "$((10#$n))" -gt 61 ] && [ "$((10#$n))" -le "$((10#$MAX_MIG))" ]; then
      pg_psql -f - < "$f" > "$WORK/mig_$n.log" 2>&1 || { tail -20 "$WORK/mig_$n.log"; die "migration $(basename "$f")"; }
      applied="$n"
    fi
  done
  echo "migrations applied through $applied"
  # supabase_migrations ledger, so the catalog states its level like production
  su_psql >/dev/null <<SQL || die "migration ledger"
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY);
INSERT INTO supabase_migrations.schema_migrations SELECT lpad(g::text, 3, '0') FROM generate_series(1, $((10#$applied))) g WHERE NOT (g = ANY ('{${PHF_ISO_SKIP_MIGRATIONS// /,}}'::int[])) ON CONFLICT DO NOTHING;
SQL
  # 080: trusted public API origin for the completion URL
  su_psql -c "INSERT INTO public.app_config (key, value) SELECT 'supabase_public_url', 'http://127.0.0.1' WHERE to_regclass('public.app_config') IS NOT NULL ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null 2>&1 || true
  # first-time setup runbook item (baseline README step 5)
  su_psql -c "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, PUBLIC;" >/dev/null

  log "PostgREST ($REST_IMAGE)"
  docker run -d --name "$REST" --network "$NET" \
    -e PGRST_DB_URI="postgres://authenticator:$AUTH_PW@$DB:5432/postgres" -e PGRST_DB_SCHEMAS=public,storage,graphql_public \
    -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" -e PGRST_DB_MAX_ROWS=1000 \
    -e PGRST_DB_USE_LEGACY_GUCS=false -e PGRST_APP_SETTINGS_JWT_SECRET="$JWT_SECRET" -e PGRST_APP_SETTINGS_JWT_EXP=3600 \
    "$REST_IMAGE" >/dev/null || die "rest run failed"

  log "edge-runtime ($EDGE_IMAGE, VERIFY_JWT=true, patched upstream router)"
  fetch_upstream_router
  local mounts=() d
  for d in "$REPO"/supabase/functions/*/; do mounts+=(-v "$d:/home/deno/functions/$(basename "$d"):ro"); done
  # api.resend.com -> 127.0.0.1: no email can ever leave this machine.
  docker run -d --name "$FN" --network "$NET" --add-host api.resend.com:127.0.0.1 \
    -v "$WORK/fn/main:/home/deno/functions/main:ro" -v "$WORK/fn/deno.jsonc:/home/deno/functions/deno.jsonc:ro" "${mounts[@]}" \
    -e JWT_SECRET="$JWT_SECRET" -e SUPABASE_JWKS='{"keys":[]}' -e SUPABASE_URL="http://$GW:8000" \
    -e SUPABASE_PUBLIC_URL=http://127.0.0.1 \
    -e SUPABASE_ANON_KEY="$ANON_KEY" -e SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY" -e VERIFY_JWT=true \
    -e RESEND_API_KEY=re_disposable_not_a_key -e REPORT_EMAIL_FROM=audit@qa.invalid \
    "$EDGE_IMAGE" start --main-service /home/deno/functions/main >/dev/null || die "edge run failed"

  log "gateway ($NODE_IMAGE, 127.0.0.1 only)"
  docker run -d --name "$GW" --network "$NET" -p 127.0.0.1::8000 \
    -v "$HERE/stack/gateway.mjs:/gw/gateway.mjs:ro" "$NODE_IMAGE" node /gw/gateway.mjs >/dev/null || die "gateway run failed"
  GW_URL="http://$(docker port "$GW" 8000/tcp | head -1)"
  case "$GW_URL" in http://127.0.0.1:*) ;; *) die "gateway not on loopback: $GW_URL";; esac
  DB_PORT="$(docker port "$DB" 5432/tcp | head -1 | sed 's/.*://')"
  printf 'PHF_ISO_URL=%s\nPHF_ISO_DB_PORT=%s\n' "$GW_URL" "$DB_PORT" >> "$WORK/secrets.env"

  wait_http "$GW_URL/rest/v1/" '^(200|401)$' 90 || die "PostgREST via gateway"
  wait_http "$GW_URL/auth/v1/health" '^200$' 60 || die "GoTrue via gateway"
  wait_http "$GW_URL/storage/v1/status" '^200$' 60 || die "storage via gateway"
  wait_http "$GW_URL/functions/v1/phone-upload-page" '^200$' 180 || { docker logs "$FN" 2>&1 | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g' | tail -20; die "edge-runtime"; }
  # warm every function (npm:@supabase/supabase-js loads on first use)
  for d in admin-2fa email-sales-report phone-upload-token platform-console staff-admin; do
    curl -s -o /dev/null --max-time 120 -X POST -H "Authorization: Bearer $ANON_KEY" -H 'content-type: application/json' \
      -d '{}' "$GW_URL/functions/v1/$d" || true
  done
  echo "stack up: gateway $GW_URL (secrets in $WORK/secrets.env, never printed)"
}
