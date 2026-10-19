#!/usr/bin/env bash
# run.sh — disposable disaster-recovery drill (workstation + local Docker only; synthetic data only).
#   deploy/lucashome/backup/tests/dr/run.sh [085|086] [TAG]     the drill below
#   deploy/lucashome/backup/tests/dr/run.sh tills [TAG]         offline tills vs a server restored to an older
#                                                                backup at the same URL (src/live/dr-tills.live.test.ts)
# 1  builds the disposable stack (tools/security-audit stack: db, GoTrue, storage-api, PostgREST,
#    functions, gateway) at 085 (084 held); for 086, 086 is applied with deploy/lucashome/apply-migrations.sh
# 2  seeds two synthetic organisations through the real RPCs (src/live/dr-seed.live.test.ts)
# 3  reference fingerprints of the quiescent source: rows + schema + storage bytes
# 4  backs up with the REAL scripts (backup-logical.sh; email-archive.sh --no-send = the offsite copy)
# 5  verifies the backup set, then injects backup faults (truncated, missing component, stale, wrong version)
# 6  DESTROYS the source: every container, the storage volume, the network
# 7  S1 database loss: restores the local dump set into a fresh container; gate (dr-verify-restore.sh);
#    app check through a fresh PostgREST (password reset, JWT secret kept / lost)
# 8  restore faults: interrupted restore, wrong version, missing ledger rows, corrupted ledger/payments
# 9  S2 server loss: from the offsite copy + the owner's key ONLY: unpack, verify, restore db + storage; gate
# 10 log hygiene: no secret value in any output
# Results: deploy/lucashome/backup/tests/dr/results/<TAG>/ (git-ignored). Exit 1 on any FAIL.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../../.." && pwd)"
BK="$REPO/deploy/lucashome/backup"
GATE="$BK/dr-verify-restore.sh"
LEVEL="${1:-085}"; TAG="${2:-dr-$LEVEL-$(date -u +%Y%m%dT%H%M%SZ)}"
MODE=drill; [ "$LEVEL" = tills ] && { MODE=tills; LEVEL=086; TAG="${2:-dr-tills-$(date -u +%Y%m%dT%H%M%SZ)}"; }
case "$LEVEL" in 085|086) ;; *) echo "level must be 085, 086 or tills"; exit 2;; esac
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker socket only"; exit 3;; esac
IMG="${PHF_PG_IMAGE:-supabase/postgres:17.6.1.136}"
REST_IMG="${PHF_REST_IMAGE:-postgrest/postgrest:v14.17}"
OUT="$HERE/results/$TAG"; mkdir -p "$OUT"; chmod 0700 "$OUT"
NET=phf-dr-net
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
say() { echo; echo "== $*"; }
gate_expect() {  # LABEL healthy|failed ARGS... — run the gate, expect a verdict
  # "failed" counts only as a real verdict (rc 1 + RESULT: FAILED), never a usage error or a crash
  local label=$1 want=$2 log; shift 2
  log="$OUT/gate-$(echo "$label" | tr -c 'a-zA-Z0-9' '-').log"
  "$GATE" "$@" >"$log" 2>&1; local rc=$?
  local why=${GE_WHY:-}
  if [ "$want" = healthy ] && [ $rc -eq 0 ] && grep -q '^RESULT: HEALTHY' "$log"; then ok "$label: HEALTHY"
  elif [ "$want" = inconclusive ] && [ $rc -eq 1 ] && grep -q '^RESULT: INCONCLUSIVE' "$log"; then ok "$label: INCONCLUSIVE (not promoted)"
  elif [ "$want" = not-healthy ] && [ $rc -eq 1 ] && grep -qE '^RESULT: (FAILED|INCONCLUSIVE)' "$log"; then ok "$label: not promoted ($(grep -m1 '^RESULT' "$log" | cut -c9-40))"
  elif [ "$want" = accepted ] && [ $rc -eq 3 ] && grep -q '^RESULT: ACCEPTED-WITHOUT-REFERENCE' "$log"; then ok "$label: ACCEPTED-WITHOUT-REFERENCE (exit 3, never HEALTHY)"
  elif [ "$want" = failed ] && [ $rc -eq 1 ] && grep -q '^RESULT: FAILED' "$log" \
       && { [ -z "$why" ] || awk '/^FAIL/{f=1; print; next} /^        /{if (f) print; next} {f=0}' "$log" | grep -q -- "$why"; }; then
    ok "$label: detected ($(grep -m1 '^FAIL' "$log" | cut -c7-100))"
  else bad "$label: expected $want${why:+ because of '$why'}, got rc=$rc"; grep -E '^(FAIL|RESULT|        )' "$log" | head -10 | sed 's/^/      /'; fi
}
GE_WHY=""
need() { [ -s "$1" ] || { bad "missing $1 — later checks would be vacuous; stopping"; echo "dr drill $LEVEL ($TAG): $PASS passed, $FAIL failed"; exit 1; }; }
pgx() { local c=$1; shift; docker exec -i "$c" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
FRESH_PW=$(openssl rand -hex 16)
wait_pg() {  # the init-time server listens on the socket only: a TCP login means the final server is up
  for _ in $(seq 1 120); do
    if docker exec -e PGPASSWORD="$FRESH_PW" "$1" psql -X -h 127.0.0.1 -U postgres -d postgres -Atc 'select 1' >/dev/null 2>&1; then
      sleep 3; docker exec "$1" psql -X -U supabase_admin -d postgres -Atc 'select 1' >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done; docker logs "$1" 2>&1 | tail -5; return 1
}
fresh_db() {  # NAME — a fresh database server from the image (no data, no volume of the source)
  docker rm -f "$1" >/dev/null 2>&1
  docker run -d --name "$1" --network "$NET" --memory 1g -e POSTGRES_PASSWORD="$FRESH_PW" "$IMG" >/dev/null && wait_pg "$1"
}
restore_into() {  # NAME DIR [LIST] — the runbook (README §A): roles, move the fresh db aside, pg_restore --create, settings
  local c=$1 d=$2 list=${3:-}
  # roles: as the runbook says, without ON_ERROR_STOP — "already exists" for the image's own roles is
  # expected; any OTHER error fails the restore
  docker exec -i "$c" psql -X -U supabase_admin -d postgres -q < "$d/globals.sql" >"$OUT/restore-$c-globals.log" 2>&1
  if grep 'ERROR' "$OUT/restore-$c-globals.log" | grep -qv 'already exists'; then echo "globals.sql: unexpected error" >&2; return 1; fi
  pgx "$c" -q -d template1 >/dev/null 2>&1 <<'SQL'
ALTER DATABASE postgres ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid();
ALTER DATABASE postgres RENAME TO postgres_fresh;
SQL
  if [ -n "$list" ]; then docker cp "$list" "$c:/tmp/restore.list" >/dev/null; set -- -L /tmp/restore.list; else set --; fi
  docker exec -i "$c" pg_restore -U supabase_admin -d template1 --create --exit-on-error "$@" < "$d/postgres.dump" >"$OUT/restore-$c.log" 2>&1; local rc=$?
  docker exec -i "$c" pg_restore -U supabase_admin -d template1 --create < "$d/_supabase.dump" >>"$OUT/restore-$c.log" 2>&1
  [ -s "$d/db-settings.sql" ] && pgx "$c" -q < "$d/db-settings.sql" >>"$OUT/restore-$c.log" 2>&1
  return $rc
}
fixups() { pgx "$1" -q < "$BK/dr-restore-fixups.sql" >>"$OUT/restore-$1.log" 2>&1; }   # README §A, after the restore
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
mkjwt() {  # SECRET ROLE [SUB] — an HS256 token, as GoTrue would sign it
  local h p s; h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '{"role":"%s","iss":"supabase","exp":%s%s}' "$2" "$(( $(date +%s) + 3600 ))" "${3:+,\"sub\":\"$3\",\"aud\":\"authenticated\"}" | b64url)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$1" -binary | b64url); printf '%s.%s.%s' "$h" "$p" "$s"
}
cleanup() {
  # synthetic, but never left behind: the owner's exported key, plaintext dumps, the offsite copy
  rm -rf "$OUT/owner" "$OUT/local-backup" "$OUT/s2-unpack" "$OUT/offsite" "$OUT/email-build" "$OUT/rpc.json" 2>/dev/null
  [ "${KEEP:-0}" = 1 ] && { echo "KEEP=1: left running"; return; }
  ids=$(docker ps -aq --filter 'name=^phf-iso-' --filter 'name=^phf-dr-'); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  docker volume rm phf-iso-storage-data >/dev/null 2>&1; docker network rm phf-iso-net "$NET" >/dev/null 2>&1
  case "${SWORK:-}" in /tmp/*|/private/tmp/*|/var/folders/*) [ -f "$SWORK/secrets.env" ] && rm -rf "$SWORK";; esac
}
trap cleanup EXIT

# ---------------------------------------------------------------- 1 source stack
say "1 disposable source stack at $LEVEL (084 held)"
ids=$(docker ps -aq --filter 'name=^phf-iso-' --filter 'name=^phf-dr-'); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
PHF_ISO_SKIP_MIGRATIONS=084 bash "$REPO/tools/security-audit/run.sh" --max-migration 085 --stack-only > "$OUT/stack.log" 2>&1 || { tail -20 "$OUT/stack.log"; echo "stack failed"; exit 1; }
SWORK=$(dirname "$(grep -o 'secrets in [^,;]*secrets.env' "$OUT/stack.log" | head -1 | sed 's/^secrets in //')")
set -a; . "$SWORK/secrets.env"; set +a
pgx phf-iso-db -c "alter table supabase_migrations.schema_migrations add column if not exists statements text[], add column if not exists name text" >/dev/null
# the production stack's compose init creates _supabase (analytics/supavisor metadata, dumped by the
# backup jobs); the disposable stack does not — create it as the email-tier suite does
pgx phf-iso-db -q -c 'CREATE DATABASE _supabase' >/dev/null 2>&1
docker exec -i phf-iso-db psql -X -U supabase_admin -d _supabase -q -c 'CREATE SCHEMA IF NOT EXISTS _analytics; CREATE SCHEMA IF NOT EXISTS _supavisor;' >/dev/null || bad "_supabase"
if [ "$LEVEL" = 086 ]; then
  APPLY_MIGRATIONS_TEST_CONTAINER=phf-iso-db bash "$REPO/deploy/lucashome/apply-migrations.sh" --from 086 --to 086 > "$OUT/apply-086.log" 2>&1 \
    && ok "086 applied through apply-migrations.sh (test target)" || { bad "086 apply"; tail -5 "$OUT/apply-086.log"; exit 1; }
fi
[ "$(pgx phf-iso-db -c 'select max(version) from supabase_migrations.schema_migrations')" = "$LEVEL" ] && ok "source schema $LEVEL" || bad "source schema"

if [ "$MODE" = tills ]; then
  say "tills: the real client modules vs a server restored to an older backup"
  ( cd "$REPO" && E2E_SUPABASE_URL="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY" \
    E2E_DB_CONTAINER=phf-iso-db E2E_LOOPBACK_ONLY=1 DR_TILLS=1 DR_DUMP="$OUT/tills.dump" DR_EVIDENCE="$OUT/tills.json" \
    npx vitest run src/live/dr-tills.live.test.ts 2>&1 | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g' ) > "$OUT/tills.log"
  rm -f "$OUT/tills.dump"
  grep -E '\[dr-tills\] (PASS|FAIL)' "$OUT/tills.log"
  grep -E '^ +Tests ' "$OUT/tills.log"
  grep -qE '^ +Tests +[0-9]+ passed' "$OUT/tills.log" && ! grep -qE '^ +Tests .*failed' "$OUT/tills.log"; exit $?
fi

# ---------------------------------------------------------------- 2 seed
say "2 synthetic organisations and business activity (real RPCs)"
( cd "$REPO" && E2E_SUPABASE_URL="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY" \
  E2E_DB_CONTAINER=phf-iso-db E2E_LOOPBACK_ONLY=1 DR_LIVE=1 DR_STATE="$OUT/state.json" \
  npx vitest run src/live/dr-seed.live.test.ts 2>&1 | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g' ) > "$OUT/seed.log"
grep -qE '^ +Tests +1 passed' "$OUT/seed.log" && ok "seed: $(grep -o '\[dr-seed\].*' "$OUT/seed.log" | head -1)" || { bad "seed"; tail -20 "$OUT/seed.log"; exit 1; }

ACLQ="select n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity || ' owner=' || pg_get_userbyid(c.relowner) || ' acl=' || (select string_agg(x::text, ',' order by x::text) from unnest(coalesce(c.relacl, acldefault('r', c.relowner))) x) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','auth','storage') and c.relkind in ('r','p','v') union all select 'schema ' || nspname || ' owner=' || pg_get_userbyid(nspowner) || ' acl=' || (select string_agg(x::text, ',' order by x::text) from unnest(coalesce(nspacl, acldefault('n', nspowner))) x) from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema' order by 1"
# ---------------------------------------------------------------- 3 reference
say "3 reference fingerprints of the quiescent source"
"$GATE" fingerprint --container phf-iso-db > "$OUT/reference.txt" 2>"$OUT/reference.err" && ok "reference: $(wc -l < "$OUT/reference.txt" | tr -d ' ') items" || bad "reference fingerprint"
pgx phf-iso-db -F '|' -q -f - < "$BK/dr-financial-checks.sql" > "$OUT/financial-source.txt" 2>&1
awk -F'|' '$1 !~ /^info:/ && NF>=2 && $2 != "0"' "$OUT/financial-source.txt" | grep -q . && bad "source violates an invariant (see financial-source.txt)" || ok "source: every financial/isolation/ledger invariant 0"
docker run --rm --network none -v phf-iso-storage-data:/s:ro --entrypoint sh "$IMG" -c 'cd /s && find . -type f | LC_ALL=C sort | xargs -r sha256sum' > "$OUT/storage-source.sha256"
ok "storage source: $(wc -l < "$OUT/storage-source.sha256" | tr -d ' ') files hashed"
pgx phf-iso-db -c "$ACLQ" > "$OUT/tables-acl-source.txt"

# ---------------------------------------------------------------- 4 backup (real scripts)
say "4 backup with the real scripts (Linux runner)"
docker build -q -t phf-mail-runner:1 -f "$BK/tests/email/Dockerfile.runner" "$BK/tests/email" >/dev/null || { echo "runner build failed"; exit 1; }
docker run --rm --name phf-dr-runner --network none \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$REPO:/repo:ro" -v "$OUT:/work" \
  -v "$BK/tests/email/docker-shim.sh:/usr/local/bin/docker:ro" -v phf-iso-storage-data:/stack-storage:ro \
  --mount type=tmpfs,destination=/keys,tmpfs-size=16m -e PHF_DB_CONTAINER=phf-iso-db -e PHF_PG_IMAGE="$IMG" \
  phf-mail-runner:1 bash /repo/deploy/lucashome/backup/tests/dr/in-runner.sh backup > "$OUT/in-runner-backup.log" 2>&1
grep -E '^(PASS|FAIL)' "$OUT/in-runner-backup.log"
PASS=$((PASS + $(grep -c '^PASS' "$OUT/in-runner-backup.log"))); FAIL=$((FAIL + $(grep -c '^FAIL' "$OUT/in-runner-backup.log")))

# ---------------------------------------------------------------- 5 backup verification + faults
say "5 backup-set verification and faults"
L="$OUT/local-backup"
need "$L/postgres.dump"; need "$OUT/reference.txt"
gate_expect "backup set (local tier)" healthy backup --dir "$L" --expect-version "$LEVEL"
cp -a "$L" "$OUT/f-trunc"; head -c 4096 "$L/postgres.dump" > "$OUT/f-trunc/postgres.dump"
gate_expect "fault: truncated postgres.dump" failed backup --dir "$OUT/f-trunc" --expect-version "$LEVEL"
cp -a "$L" "$OUT/f-missing"; rm -f "$OUT/f-missing/globals.sql"
gate_expect "fault: missing component (globals.sql)" failed backup --dir "$OUT/f-missing" --expect-version "$LEVEL"
cp -a "$L" "$OUT/f-nosums"; rm -f "$OUT/f-nosums/SHA256SUMS"
gate_expect "fault: no SHA256SUMS (interrupted set)" failed backup --dir "$OUT/f-nosums" --expect-version "$LEVEL"
cp -a "$L" "$OUT/f-stale"; jq '.completed_at = "2026-01-01T00:00:00Z"' "$L/meta.json" > "$OUT/f-stale/meta.json"
( cd "$OUT/f-stale" && for f in $(awk '{print $2}' SHA256SUMS | tr -d '*'); do printf '%s *%s\n' "$(shasum -a 256 "$f" | cut -c1-64)" "$f"; done > SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS )
gate_expect "fault: stale backup" failed backup --dir "$OUT/f-stale" --expect-version "$LEVEL"
gate_expect "stale backup accepted explicitly (--accept-stale)" healthy backup --dir "$OUT/f-stale" --accept-stale --expect-version "$LEVEL"
gate_expect "fault: backup of the wrong schema version" failed backup --dir "$L" --expect-version 999
rm -rf "$OUT/f-trunc" "$OUT/f-missing" "$OUT/f-nosums" "$OUT/f-stale"

# ---------------------------------------------------------------- 6 destroy the source
say "6 destroy the source server (containers, storage volume, network)"
ids=$(docker ps -aq --filter 'name=^phf-iso-'); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
docker volume rm phf-iso-storage-data >/dev/null 2>&1; docker network rm phf-iso-net >/dev/null 2>&1
[ -z "$(docker ps -aq --filter 'name=^phf-iso-')" ] && ! docker volume inspect phf-iso-storage-data >/dev/null 2>&1 && ok "source gone: no container, no volume" || bad "source not fully destroyed"
docker network create "$NET" >/dev/null 2>&1

# ---------------------------------------------------------------- 7 S1 database loss
say "7 S1 database loss: local dump set -> fresh database server"
fresh_db phf-dr-s1 && ok "fresh database server (image only)" || bad "fresh db"
t0=$(date +%s); restore_into phf-dr-s1 "$L" && ok "runbook restore (globals, pg_restore --create --exit-on-error, settings) in $(( $(date +%s) - t0 ))s" || bad "restore S1 (see restore-phf-dr-s1.log)"
GE_WHY="schema: schemas" gate_expect "S1 before the fix-ups: the extension schemas' grants are missing (logical restore)" failed restore --container phf-dr-s1 --reference "$OUT/reference.txt" --counts "$L/counts.json" --expect-version "$LEVEL" --migrations "$REPO/supabase/migrations"
fixups phf-dr-s1 && ok "post-restore fix-ups applied (dr-restore-fixups.sql)" || bad "fix-ups"
gate_expect "S1 restored database" healthy restore --container phf-dr-s1 --reference "$OUT/reference.txt" --counts "$L/counts.json" --expect-version "$LEVEL" --migrations "$REPO/supabase/migrations"
gate_expect "S1 without a reference (production case): never HEALTHY by default" inconclusive restore --container phf-dr-s1 --expect-version "$LEVEL" --migrations "$REPO/supabase/migrations"
gate_expect "S1 without a reference, accepted explicitly with the backup's counts" accepted restore --container phf-dr-s1 --accept-no-reference --counts "$L/counts.json" --expect-version "$LEVEL" --migrations "$REPO/supabase/migrations"
pgx phf-dr-s1 -F '|' -q -f - < "$BK/dr-financial-checks.sql" > "$OUT/financial-restored.txt" 2>&1
pgx phf-dr-s1 -c "$ACLQ" > "$OUT/tables-acl-restored.txt"
[ -s "$OUT/tables-acl-source.txt" ] && [ -s "$OUT/tables-acl-restored.txt" ] && diff "$OUT/tables-acl-source.txt" "$OUT/tables-acl-restored.txt" > "$OUT/tables-acl.diff" && ok "table owners, grants and RLS flags identical to the source" || { bad "table owners/grants/RLS differ from the source ($(grep -c '^>' "$OUT/tables-acl.diff") tables; tables-acl.diff)"; head -6 "$OUT/tables-acl.diff" | sed 's/^/      /'; }
if diff <(grep '^info:' "$OUT/financial-source.txt") <(grep '^info:' "$OUT/financial-restored.txt") >/dev/null; then ok "financial totals identical (payments, outstanding, ledger states, audit rows, migrations)"; else bad "financial totals differ"; fi
# app check: a fresh PostgREST on the restored database. globals.sql restored the source's password
# HASHES; the plaintext lives only in the lost .env — the rebuild rotates the passwords (here: authenticator).
NEWPW=$(openssl rand -hex 16)
pgx phf-dr-s1 -q -c "ALTER ROLE authenticator WITH LOGIN PASSWORD '$NEWPW'" >/dev/null 2>&1 && ok "rebuild step: authenticator password rotated (globals.sql restored the source's hash — every login role must be rotated after a theft)" || bad "password reset"
api_up() {  # NAME JWT_SECRET PORT
  docker rm -f "$1" >/dev/null 2>&1
  docker run -d --name "$1" --network "$NET" -p "127.0.0.1:$3:3000" -e PGRST_DB_URI="postgres://authenticator:$NEWPW@phf-dr-s1:5432/postgres" \
    -e PGRST_DB_SCHEMAS=public,storage,graphql_public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$2" -e PGRST_DB_USE_LEGACY_GUCS=false "$REST_IMG" >/dev/null
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$3/" && return 0; sleep 0.5; done; return 1
}
api_up phf-dr-rest "$PHF_ISO_JWT_SECRET" 18731 && ok "PostgREST on the restored database (JWT secret recovered)" || bad "PostgREST did not start"
AUTH_A=$(pgx phf-dr-s1 -c "select auth_id from users where id = '$(jq -r '.orgs[0].users.cashA' "$OUT/state.json")'")
AUTH_B=$(pgx phf-dr-s1 -c "select auth_id from users where id = '$(jq -r '.orgs[1].users.cashA' "$OUT/state.json")'")
TA=$(mkjwt "$PHF_ISO_JWT_SECRET" authenticated "$AUTH_A"); TB=$(mkjwt "$PHF_ISO_JWT_SECRET" authenticated "$AUTH_B")
rpc() { curl -s -o "$OUT/rpc.json" -w '%{http_code}' -X POST "http://127.0.0.1:${4:-18731}/rpc/$2" -H "Authorization: Bearer $1" -H "apikey: $1" -H 'Content-Type: application/json' -d "$3"; }
SALES0=$(pgx phf-dr-s1 -c "select count(*) from sales")
code=$(rpc "$TA" app_user_id '{}'); [ "$code" = 200 ] && ok "restored user A authenticates with a token from the recovered secret (app_user_id 200)" || bad "app_user_id $code"
if [ "$LEVEL" = 086 ]; then
  KC=$(jq -r '.orgs[0].keys.v7.committed' "$OUT/state.json"); KR=$(jq -r '.orgs[0].keys.v7.rejected' "$OUT/state.json"); KA=$(jq -r '.orgs[0].keys.v7.abandoned' "$OUT/state.json")
  for pair in "committed:$KC" "rejected:$KR" "abandoned:$KA"; do
    want=${pair%%:*}; key=${pair#*:}
    rpc "$TA" op_status "{\"p_key\":\"$key\",\"p_rpc\":\"complete_sale\",\"p_fence\":false,\"p_expected_actor_id\":null,\"p_args\":null}" >/dev/null
    [ "$(jq -r .status "$OUT/rpc.json")" = "$want" ] && ok "operation ledger after restore: original key $want (op_status)" || bad "op_status $want -> $(jq -c . "$OUT/rpc.json" | cut -c1-120)"
  done
  code=$(rpc "$TB" op_status "{\"p_key\":\"$KC\",\"p_rpc\":\"complete_sale\",\"p_fence\":false,\"p_expected_actor_id\":null,\"p_args\":null}")
  [ "$code" = 200 ] && [ "$(jq -r .status "$OUT/rpc.json")" = not_found ] && ok "isolation after restore: organisation B's lookup of A's committed key answers not_found (HTTP 200)" || bad "B lookup of A's key: HTTP $code $(jq -c . "$OUT/rpc.json" | cut -c1-100)"
  # REPLAY the original keys through the API: decided keys answer from the ledger, nothing executes again
  CASHA=$(jq -r '.orgs[0].users.cashA' "$OUT/state.json")
  for want in committed rejected abandoned; do
    key=$(jq -r ".orgs[0].replay.v7.$want.key" "$OUT/state.json"); args=$(jq -c ".orgs[0].replay.v7.$want.args" "$OUT/state.json")
    rpc "$TA" op_execute "{\"p_key\":\"$key\",\"p_rpc\":\"complete_sale\",\"p_args\":$args,\"p_actor_id\":\"$CASHA\"}" >/dev/null
    o=$(jq -r '.outcome + "/" + ((.replayed // false) | tostring)' "$OUT/rpc.json" 2>/dev/null)
    [ "$o" = "$want/true" ] && ok "replay after restore: $want key answers '$want' from the ledger (replayed, not executed)" || bad "replay $want -> $(jq -c . "$OUT/rpc.json" | cut -c1-140)"
  done
fi
# a legacy (v4) committed key replays its stored response on the direct path
K=$(jq -r '.orgs[0].replay.sale.key' "$OUT/state.json"); SID=$(jq -r '.orgs[0].replay.sale.saleId' "$OUT/state.json")
ARGS=$(jq -c --arg k "$K" '.orgs[0].replay.sale.args + {p_idempotency_key: $k}' "$OUT/state.json")
code=$(rpc "$TA" complete_sale "$ARGS")
[ "$code" = 200 ] && [ "$(jq -r .sale.id "$OUT/rpc.json")" = "$SID" ] && ok "replay after restore: a committed sale key returns the ORIGINAL sale (same id), no new sale" || bad "legacy replay: HTTP $code $(jq -c . "$OUT/rpc.json" | cut -c1-140)"
[ "$(pgx phf-dr-s1 -c "select count(*) from sales")" = "$SALES0" ] && ok "no sale created by the replays and checks (sales $SALES0)" || bad "sales changed"
api_up phf-dr-rest2 "$(openssl rand -hex 32)" 18732 && ok "PostgREST with a NEW JWT secret (the old one lost)" || bad "PostgREST 2"
code=$(rpc "$PHF_ISO_ANON_KEY" app_setup_needed '{}' 18732); [ "$code" = 401 ] && ok "JWT secret lost -> every installed till's anon key is refused (401): a new build is required" || bad "old anon key with a new secret: $code"
docker rm -f phf-dr-rest phf-dr-rest2 >/dev/null 2>&1

# ---------------------------------------------------------------- 8 restore faults
# every fault on its OWN fresh restore (independent), each with the reason it must be caught for
say "8 restore faults"
fault_db() { fresh_db "$1" >/dev/null && restore_into "$1" "$L" >/dev/null 2>&1; fixups "$1"; }
MIGS="$REPO/supabase/migrations"
fresh_db phf-dr-s1b >/dev/null
docker exec -i phf-dr-s1b pg_restore -l < "$L/postgres.dump" > "$OUT/toc.list" 2>/dev/null
n=$(grep -cE '^[0-9]+;' "$OUT/toc.list"); head -n $(( n * 2 / 3 )) "$OUT/toc.list" > "$OUT/toc-partial.list"
restore_into phf-dr-s1b "$L" "$OUT/toc-partial.list" >/dev/null 2>&1
GE_WHY="fingerprint differs" gate_expect "fault: interrupted restore (two thirds of the archive)" failed restore --container phf-dr-s1b --reference "$OUT/reference.txt" --expect-version "$LEVEL" --migrations "$MIGS"
gate_expect "fault: interrupted restore, no reference but the backup's counts" not-healthy restore --container phf-dr-s1b --accept-no-reference --counts "$L/counts.json" --expect-version "$LEVEL" --migrations "$MIGS"
gate_expect "fault: interrupted restore, no reference at all" not-healthy restore --container phf-dr-s1b --expect-version "$LEVEL" --migrations "$MIGS"
docker rm -f phf-dr-s1b >/dev/null 2>&1
# the whole public DATA section lost (schema, grants, RLS, auth intact): the production fallback must fail
fresh_db phf-dr-s1c >/dev/null
grep -v 'TABLE DATA public ' "$OUT/toc.list" > "$OUT/toc-nodata.list"
restore_into phf-dr-s1c "$L" "$OUT/toc-nodata.list" >/dev/null 2>&1; fixups phf-dr-s1c
GE_WHY="counts differ" gate_expect "fault: public data section lost, no reference + the backup's counts (production fallback)" failed restore --container phf-dr-s1c --accept-no-reference --counts "$L/counts.json" --expect-version "$LEVEL" --migrations "$MIGS"
docker rm -f phf-dr-s1c >/dev/null 2>&1
OTHER=$([ "$LEVEL" = 085 ] && echo 086 || echo 085)
GE_WHY="schema version is" gate_expect "fault: restored database is not the expected schema version ($OTHER)" failed restore --container phf-dr-s1 --reference "$OUT/reference.txt" --expect-version "$OTHER" --migrations "$MIGS"
docker rm -f phf-dr-s1 >/dev/null 2>&1
fault_db phf-dr-f1; pgx phf-dr-f1 -q -c "DELETE FROM supabase_migrations.schema_migrations WHERE version = '083'" >/dev/null
GE_WHY="missing \[083\]" gate_expect "fault: migration-ledger record missing (083)" failed restore --container phf-dr-f1 --reference "$OUT/reference.txt" --expect-version "$LEVEL" --migrations "$MIGS"
docker rm -f phf-dr-f1 >/dev/null 2>&1
fault_db phf-dr-f2; pgx phf-dr-f2 -q -c "SET session_replication_role = replica; UPDATE supplier_payments SET amount_mmk = amount_mmk + 1 WHERE id = (SELECT id FROM supplier_payments WHERE voided_at IS NULL ORDER BY id LIMIT 1);" >/dev/null
GE_WHY="po paid_mmk differs" gate_expect "fault: a supplier payment amount altered" failed restore --container phf-dr-f2 --reference "$OUT/reference.txt" --expect-version "$LEVEL" --migrations "$MIGS"
docker rm -f phf-dr-f2 >/dev/null 2>&1
fault_db phf-dr-f3; pgx phf-dr-f3 -q -c "SET session_replication_role = replica; DELETE FROM sales WHERE id = (SELECT id FROM sales ORDER BY id LIMIT 1);" >/dev/null
GE_WHY="public.sales" gate_expect "fault: a sale missing (lost row)" failed restore --container phf-dr-f3 --reference "$OUT/reference.txt" --expect-version "$LEVEL" --migrations "$MIGS"
docker rm -f phf-dr-f3 >/dev/null 2>&1
if [ "$LEVEL" = 086 ]; then
  fault_db phf-dr-f4; pgx phf-dr-f4 -q -c "DELETE FROM idempotency_keys WHERE key = '$KR'::uuid" >/dev/null
  GE_WHY="public.idempotency_keys" gate_expect "fault: a rejected tombstone deleted (lost refusal)" failed restore --container phf-dr-f4 --reference "$OUT/reference.txt" --expect-version "$LEVEL" --migrations "$MIGS"
  docker rm -f phf-dr-f4 >/dev/null 2>&1
  fault_db phf-dr-f5; pgx phf-dr-f5 -q -c "ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_state_chk; UPDATE idempotency_keys SET state = 'committed' WHERE key = '$KR'::uuid;" >/dev/null
  GE_WHY="state/tombstone rule" gate_expect "fault: a tombstone turned committed (constraint gone)" failed restore --container phf-dr-f5 --reference "$OUT/reference.txt" --expect-version "$LEVEL" --migrations "$MIGS"
  docker rm -f phf-dr-f5 >/dev/null 2>&1
  fault_db phf-dr-f6; pgx phf-dr-f6 -q -c "UPDATE supabase_migrations.schema_migrations SET statements = ARRAY['sha256:' || repeat('0', 64)] WHERE version = '086'" >/dev/null
  GE_WHY="checksum mismatch" gate_expect "fault: migration-ledger checksum altered (086)" failed restore --container phf-dr-f6 --reference "$OUT/reference.txt" --expect-version "$LEVEL" --migrations "$MIGS"
  docker rm -f phf-dr-f6 >/dev/null 2>&1
fi
fault_db phf-dr-f7; pgx phf-dr-f7 -q -c "REVOKE ALL ON TABLE public.audit_logs FROM anon; GRANT SELECT ON TABLE public.sales TO anon;" >/dev/null
GE_WHY="schema: tables" gate_expect "fault: grants changed (anon gains SELECT on sales)" failed restore --container phf-dr-f7 --reference "$OUT/reference.txt" --expect-version "$LEVEL" --migrations "$MIGS"
docker rm -f phf-dr-f7 >/dev/null 2>&1

# ---------------------------------------------------------------- 9 S2 server loss, offsite only
say "9 S2 complete server loss: the offsite copy + the owner's key ONLY"
rm -rf "$L"; [ ! -e "$L" ] && ok "the local backups are gone with the server" || bad "local backups still present"
docker run --rm --name phf-dr-runner2 --network none -v "$REPO:/repo:ro" -v "$OUT:/work" --mount type=tmpfs,destination=/keys,tmpfs-size=16m \
  phf-mail-runner:1 bash /repo/deploy/lucashome/backup/tests/dr/in-runner.sh unpack > "$OUT/in-runner-unpack.log" 2>&1
grep -E '^(PASS|FAIL)' "$OUT/in-runner-unpack.log"
PASS=$((PASS + $(grep -c '^PASS' "$OUT/in-runner-unpack.log"))); FAIL=$((FAIL + $(grep -c '^FAIL' "$OUT/in-runner-unpack.log")))
X="$OUT/s2-unpack/x/db"
need "$X/postgres.dump"
gate_expect "S2 offsite archive verified before restoring (archive layout)" healthy backup --dir "$OUT/s2-unpack/x" --expect-version "$LEVEL"
fresh_db phf-dr-s2 && ok "fresh database server (no source container, volume or local backup)" || bad "fresh db S2"
t0=$(date +%s); restore_into phf-dr-s2 "$X" && fixups phf-dr-s2 && ok "S2 restore from the archive (+ fix-ups) in $(( $(date +%s) - t0 ))s" || bad "restore S2"
gate_expect "S2 restored database + storage bytes" healthy restore --container phf-dr-s2 --reference "$OUT/reference.txt" --counts "$X/counts.json" --expect-version "$LEVEL" --migrations "$REPO/supabase/migrations" --storage-dir "$OUT/s2-unpack/storage"
( cd "$OUT/s2-unpack/storage" && find . -type f | LC_ALL=C sort | xargs -r shasum -a 256 | sed 's/  /  /' ) > "$OUT/storage-restored.sha256"
if diff <(awk '{print $1, $2}' "$OUT/storage-source.sha256") <(awk '{print $1, $2}' "$OUT/storage-restored.sha256") >/dev/null; then ok "storage bytes identical to the source ($(wc -l < "$OUT/storage-source.sha256" | tr -d ' ') files)"; else bad "storage bytes differ from the source"; fi
cp -a "$OUT/s2-unpack/storage" "$OUT/s2-storage-missing"; rm -f "$(find "$OUT/s2-storage-missing" -type f | head -1)"
GE_WHY="storage:" gate_expect "fault: a storage object missing" failed restore --container phf-dr-s2 --expect-version "$LEVEL" --migrations "$REPO/supabase/migrations" --storage-dir "$OUT/s2-storage-missing"
rm -rf "$OUT/s2-storage-missing"
docker rm -f phf-dr-s2 >/dev/null 2>&1

# ---------------------------------------------------------------- 10 hygiene
say "10 log hygiene and what the rebuild needed"
leak=0
for v in "$PHF_ISO_JWT_SECRET" "$PHF_ISO_DB_PW" "$PHF_ISO_SERVICE_KEY" "$NEWPW" "$FRESH_PW"; do grep -rqF -- "$v" "$OUT" 2>/dev/null && leak=1; done
[ "$leak" = 0 ] && ok "no secret value in any log or result file" || bad "a secret value appears in the results"
rm -rf "$OUT/s2-unpack" "$OUT/owner" "$OUT/rpc.json"
echo "rebuild needs beyond the database archive: the whole stack .env (JWT secret — else new builds for every till —, service and dashboard keys, SMTP/email provider, function secrets), every login role's password ROTATED (globals.sql restores the source's hashes), the pgsodium key, the same backend URL; see disaster-recovery.md §4" | tee "$OUT/rebuild-needs.txt"

echo; echo "dr drill $LEVEL ($TAG): $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
