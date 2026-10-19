#!/usr/bin/env bash
# v87 CLIENT verification against migration 087 on a DISPOSABLE loopback stack (never a real server):
# the real app in real Chromium (persistent profiles: on-disk IndexedDB, crash + restart) and in the real Electron app,
# against the committed 087 migration applied through the real runner, with the real witness authority.
#   tools/m087-client-verify/run.sh [TAG]          KEEP=1: leave the stack up   E2E_GREP="C1": one test
# Keys come from the stack's secrets file into the environment only (never printed); logs have JWTs redacted.
set -u
umask 077
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
TAG=${1:-run-$(date +%Y%m%dT%H%M%S)}; OUT="$HERE/results/$TAG"; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
redact() { sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'; }
teardown() { [ "${KEEP:-0}" = 1 ] || bash "$ROOT/tools/m087-verify/lib/stack.sh" down "$OUT/stack" > /dev/null 2>&1; }
trap teardown EXIT
# the disposable stack: tools/security-audit (085, 084 held) + 086 through the real runner (as tools/m087-verify/lib/stack.sh,
# without its DR seed: the e2e global setup seeds its own QA tenant and requires a clean stack)
mkdir -p "$OUT/stack"
bash "$ROOT/tools/m087-verify/lib/stack.sh" down "$OUT/stack" > /dev/null 2>&1
PHF_ISO_SKIP_MIGRATIONS=084 bash "$ROOT/tools/security-audit/run.sh" --max-migration 085 --stack-only > "$OUT/stack/stack.log" 2>&1 || { echo "stack failed (see $OUT/stack/stack.log)"; exit 1; }
SWORK=$(dirname "$(grep -o 'secrets in [^,;]*secrets.env' "$OUT/stack/stack.log" | head -1 | sed 's/^secrets in //')"); echo "$SWORK" > "$OUT/stack/swork.path"
set -a; . "$SWORK/secrets.env"; set +a
case "$PHF_ISO_URL" in http://127.0.0.1:*) ;; *) echo "REFUSE: not loopback"; exit 3;; esac
docker exec -i phf-iso-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At \
  -c "alter table supabase_migrations.schema_migrations add column if not exists statements text[], add column if not exists name text" > /dev/null
( cd "$ROOT" && APPLY_MIGRATIONS_TEST_CONTAINER=phf-iso-db bash deploy/lucashome/apply-migrations.sh --from 086 --to 086 ) > "$OUT/stack/apply-086.log" 2>&1 \
  || { echo "086 apply failed (see $OUT/stack/apply-086.log)"; exit 1; }
unset ELECTRON_RUN_AS_NODE
export E2E_SUPABASE_URL="http://localhost:5183" E2E_API_GATEWAY="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY"
export E2E_DB_CONTAINER=phf-iso-db E2E_LOOPBACK_ONLY=1 E2E_DEV_PORT=5183 E2E_NO_CAFFEINATE=1 M087_CLIENT_LIVE=1 M087_CLIENT_OUT="$OUT"
( cd "$ROOT" && npx playwright test -c playwright.m087client.config.ts ${E2E_GREP:+-g "$E2E_GREP"} 2>&1 | redact ) > "$OUT/e2e.log"
echo "v87 client e2e: $(grep -E '[0-9]+ (passed|failed|flaky|skipped)' "$OUT/e2e.log" | tr '\n' ' ')"
grep -qE '[0-9]+ passed' "$OUT/e2e.log" && ! grep -qE '[0-9]+ (failed|flaky)' "$OUT/e2e.log"
