#!/usr/bin/env bash
# Step 5: real Electron app: device enrollment, owner-signed reopening and offline budgets under Recovery V1 on a DISPOSABLE loopback stack (085 + 086, then V1 after the QA seed).
#   tools/recovery-v1/step5/run-electron.sh [TAG]     KEEP=1 leaves the stack up
set -u
umask 077
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
TAG=${1:-run-$(date +%Y%m%dT%H%M%S)}; OUT="$HERE/results/$TAG"; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
redact() { sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'; }
teardown() { [ "${KEEP:-0}" = 1 ] || bash "$ROOT/tools/m087-verify/lib/stack.sh" down "$OUT/stack" > /dev/null 2>&1; }
trap teardown EXIT
mkdir -p "$OUT/stack"
bash "$ROOT/tools/m087-verify/lib/stack.sh" down "$OUT/stack" > /dev/null 2>&1
PHF_ISO_SKIP_MIGRATIONS=084 bash "$ROOT/tools/security-audit/run.sh" --max-migration 085 --stack-only > "$OUT/stack/stack.log" 2>&1 || { echo "stack failed"; exit 1; }
SWORK=$(dirname "$(grep -o 'secrets in [^,;]*secrets.env' "$OUT/stack/stack.log" | head -1 | sed 's/^secrets in //')")
set -a; . "$SWORK/secrets.env"; set +a
case "$PHF_ISO_URL" in http://127.0.0.1:*) ;; *) echo "REFUSE: not loopback"; exit 3;; esac
docker exec -i phf-iso-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At \
  -c "alter table supabase_migrations.schema_migrations add column if not exists statements text[], add column if not exists name text" > /dev/null
( cd "$ROOT" && APPLY_MIGRATIONS_TEST_CONTAINER=phf-iso-db bash deploy/lucashome/apply-migrations.sh --from 086 --to 086 ) > "$OUT/stack/apply-086.log" 2>&1 || { echo "086 failed"; exit 1; }
unset ELECTRON_RUN_AS_NODE
export E2E_SUPABASE_URL="http://localhost:5183" E2E_API_GATEWAY="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY"
export E2E_DB_CONTAINER=phf-iso-db E2E_LOOPBACK_ONLY=1 E2E_DEV_PORT=5183 E2E_NO_CAFFEINATE=1 STEP5_LIVE=1 STEP5_OUT="$OUT"
( cd "$ROOT" && npx playwright test -c playwright.step5.config.ts ${E2E_GREP:+-g "$E2E_GREP"} 2>&1 | redact ) > "$OUT/e2e.log"
echo "step5 electron: $(grep -E '[0-9]+ (passed|failed|flaky|skipped)' "$OUT/e2e.log" | tr '\n' ' ')"
