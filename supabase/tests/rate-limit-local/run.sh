#!/usr/bin/env bash
# Rate-limit local end-to-end (migration 081 + phone-upload-token), fully
# disposable and local. docs/selfhost-migration/phase-f/rate-limiting.md §6.
#
#   1. the Phase D harness database (supabase/tests/phase-d/run.sh with
#      POS_TEST_KEEP=1): baseline + every migration incl. 081, all assertions;
#   2. postgrest/postgrest:v14.17 on that database (random JWT secret and
#      authenticator password, generated here, never printed);
#   3. a test gateway (node:24-slim, gateway.mjs): /rest/v1 -> PostgREST,
#      /storage/v1/object -> storage STUB (HEAD / upload/sign only);
#   4. supabase/edge-runtime:v1.76.2 running THIS repo's phone-upload-token
#      with a service_role JWT minted from the random secret;
#   5. driver.mjs (host node) drives the function on 127.0.0.1.
# Every container is named phf-rl-* on the private network phf-rl-net and is
# removed on exit. Nothing here contacts any real server.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
NET=phf-rl-net
DB=phf-rl-db
PORT="${POS_TEST_PORT:-55482}"
WORK="$(mktemp -d)"
EDGE_IMAGE=supabase/edge-runtime:v1.76.2
REST_IMAGE=postgrest/postgrest:v14.17
NODE_IMAGE=node:24-slim

cleanup() {
  rc=$?
  docker rm -f phf-rl-fn phf-rl-gw phf-rl-rest "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit $rc
}
trap cleanup EXIT INT TERM

echo "==> 1. harness database ($DB, all migrations incl. 081, kept for this run)"
POS_TEST_KEEP=1 POS_TEST_CONTAINER="$DB" POS_TEST_PORT="$PORT" bash "$REPO/supabase/tests/phase-d/run.sh" > "$WORK/harness.log" 2>&1 || { tail -30 "$WORK/harness.log"; echo "harness failed"; exit 1; }
grep -E '^assertions:|^RESULT' "$WORK/harness.log"
PWFILE="$(grep -oE 'password in [^)]+' "$WORK/harness.log" | awk '{print $3}')"
[ -f "$PWFILE" ] || { echo "harness password file not found"; exit 1; }
DB_PW="$(cat "$PWFILE")"; rm -rf "$(dirname "$PWFILE")"
export DB_PW

docker network create "$NET" >/dev/null
docker network connect "$NET" "$DB"

JWT_SECRET="$(openssl rand -hex 32)"
AUTH_PW="$(openssl rand -hex 16)"
export JWT_SECRET AUTH_PW
# authenticator login for PostgREST (password via stdin, never on a command line)
printf "ALTER ROLE authenticator WITH LOGIN PASSWORD '%s';\n" "$AUTH_PW" \
  | docker exec -i -e PGPASSWORD="$DB_PW" "$DB" psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 >/dev/null
# The bare postgres image's auth.uid() reads only request.jwt.claim.sub; on a
# real stack GoTrue's own migrations redefine it to also read
# request.jwt.claims (all PostgREST v14 sets). Do the same here (disposable DB).
docker exec -i -e PGPASSWORD="$DB_PW" "$DB" psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
                  (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
SQL
SERVICE_KEY="$(node -e '
  const c=require("node:crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
  const h=b({alg:"HS256",typ:"JWT"})+"."+b({role:"service_role",iss:"phf-rl-local",iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600});
  process.stdout.write(h+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h).digest("base64url"));')"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY"

echo "==> 2. PostgREST (phf-rl-rest)"
export PGRST_DB_URI="postgres://authenticator:${AUTH_PW}@${DB}:5432/postgres"
export PGRST_JWT_SECRET="$JWT_SECRET"
docker run -d --name phf-rl-rest --network "$NET" \
  -e PGRST_DB_URI -e PGRST_JWT_SECRET -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  "$REST_IMAGE" >/dev/null

echo "==> 3. test gateway + storage stub (phf-rl-gw)"
docker run -d --name phf-rl-gw --network "$NET" -p 127.0.0.1::8000 \
  -v "$HERE/gateway.mjs:/gw/gateway.mjs:ro" -e REST_UPSTREAM=http://phf-rl-rest:3000 \
  "$NODE_IMAGE" node /gw/gateway.mjs >/dev/null

echo "==> 4. edge-runtime with this repo's phone-upload-token (phf-rl-fn)"
docker run -d --name phf-rl-fn --network "$NET" -p 127.0.0.1::9000 \
  -v "$HERE/main:/home/deno/functions/main:ro" \
  -v "$REPO/supabase/functions/phone-upload-token:/home/deno/functions/phone-upload-token:ro" \
  -e SUPABASE_URL=http://phf-rl-gw:8000 -e SUPABASE_SERVICE_ROLE_KEY \
  "$EDGE_IMAGE" start --main-service /home/deno/functions/main >/dev/null

GW_URL="http://$(docker port phf-rl-gw 8000/tcp | head -1)"
FN_URL="http://$(docker port phf-rl-fn 9000/tcp | head -1)/phone-upload-token"
case "$GW_URL$FN_URL" in *0.0.0.0*|*::*) echo "published on a non-loopback address"; exit 1;; esac
export GW_URL FN_URL DB_CONTAINER="$DB"

echo "==> waiting for PostgREST and the function"
for i in $(seq 1 120); do
  s1="$(curl -s -o /dev/null -w '%{http_code}' "$GW_URL/rest/v1/" || true)"
  s2="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"token":"short"}' "$FN_URL" || true)"
  if [ "$s1" != "000" ] && [ "$s1" != "502" ] && [ "$s2" = "404" ]; then break; fi
  sleep 1
done
echo "gateway /rest/v1/ -> $s1, function {token:short} -> $s2"
[ "$s2" = "404" ] || { docker logs phf-rl-fn 2>&1 | sed -E 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/<jwt>/g' | tail -20; exit 1; }

echo "==> 5. driver"
node "$HERE/driver.mjs"
