#!/usr/bin/env bash
# DISPOSABLE loopback stack for the 087 verification: tools/security-audit (085, 084 held) + 086 through the real runner
# + the DR seed tenants. Containers phf-iso-*, network phf-iso-net, 127.0.0.1 only; secrets stay in the stack's temp dir.
#   lib/stack.sh up   OUTDIR      lib/stack.sh down OUTDIR
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); DB=phf-iso-db
cmd=$1; OUT=$2; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
down() {
  local ids; ids=$(docker ps -aq --filter 'name=^phf-iso-'); [ -n "$ids" ] && docker rm -f -v $ids >/dev/null 2>&1
  docker volume rm phf-iso-storage-data >/dev/null 2>&1; docker network rm phf-iso-net >/dev/null 2>&1
  local w; w=$(cat "$OUT/swork.path" 2>/dev/null)
  case "${w:-}" in /tmp/*|/private/tmp/*|/var/folders/*) [ -f "$w/secrets.env" ] && rm -rf "$w";; esac
  echo "stack down: $(docker ps -aq --filter 'name=^phf-iso-' | wc -l | tr -d ' ') phf-iso containers left"
}
if [ "$cmd" = down ]; then down; exit 0; fi
q() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
down >/dev/null
PHF_ISO_SKIP_MIGRATIONS=084 bash "$ROOT/tools/security-audit/run.sh" --max-migration 085 --stack-only > "$OUT/stack.log" 2>&1 || { tail -20 "$OUT/stack.log"; exit 1; }
SWORK=$(dirname "$(grep -o 'secrets in [^,;]*secrets.env' "$OUT/stack.log" | head -1 | sed 's/^secrets in //')"); echo "$SWORK" > "$OUT/swork.path"
set -a; . "$SWORK/secrets.env"; set +a
case "$PHF_ISO_URL" in http://127.0.0.1:*) ;; *) echo "REFUSE: non-loopback gateway"; exit 3;; esac
q "alter table supabase_migrations.schema_migrations add column if not exists statements text[], add column if not exists name text" >/dev/null
APPLY_MIGRATIONS_TEST_CONTAINER=$DB bash "$ROOT/deploy/lucashome/apply-migrations.sh" --from 086 --to 086 > "$OUT/apply-086.log" 2>&1 || { echo "086 apply failed"; tail -5 "$OUT/apply-086.log"; exit 1; }
( cd "$ROOT" && E2E_SUPABASE_URL="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY" \
  E2E_DB_CONTAINER=$DB E2E_LOOPBACK_ONLY=1 DR_LIVE=1 DR_STATE="$OUT/state.json" npx vitest run src/live/dr-seed.live.test.ts 2>&1 | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g' ) > "$OUT/seed.log"
grep -qE '^ +Tests +1 passed' "$OUT/seed.log" || { echo "seed failed"; tail -10 "$OUT/seed.log"; exit 1; }
echo "stack up: schema $(q 'select max(version) from supabase_migrations.schema_migrations')"
