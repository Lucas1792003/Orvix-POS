#!/usr/bin/env bash
# The main POS e2e suite (playwright.config.ts: Electron + Chromium terminals, all default specs) against a DISPOSABLE
# loopback stack at migration 086 (tools/security-audit/run.sh --stack-only), with the production Realtime service
# (PHF_ISO_REALTIME=1). Never a real server: the dev server, the gateway and the database are on 127.0.0.1 only.
#   tools/e2e-local/run-main.sh OUT_DIR [playwright args...]      KEEP=1 leaves the stack up
set -uo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(mkdir -p "$1" && cd "$1" && pwd); shift
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
redact() { sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'; }
iso() { docker ps -aq --filter 'name=^phf-iso-'; }
WORK=""
teardown() {
  [ "${KEEP:-0}" = 1 ] && return
  ids=$(iso); [ -n "$ids" ] && docker rm -f -v $ids >/dev/null 2>&1
  docker network rm phf-iso-net >/dev/null 2>&1; docker volume rm phf-iso-storage-data >/dev/null 2>&1
  case "$WORK" in /tmp/*|/private/tmp/*|/var/folders/*) [ -f "$WORK/secrets.env" ] && rm -rf "$WORK";; esac
}
trap teardown EXIT
cd "$ROOT"
ids=$(iso); [ -n "$ids" ] && docker rm -f -v $ids >/dev/null 2>&1; docker network rm phf-iso-net >/dev/null 2>&1
echo "== stack (<=086, realtime)"
PHF_ISO_REALTIME=1 bash tools/security-audit/run.sh --max-migration 086 --stack-only > "$OUT/stack.log" 2>&1 || { echo "stack failed"; tail -5 "$OUT/stack.log"; exit 1; }
SECRETS=$(grep -o 'secrets in [^,;]*secrets.env' "$OUT/stack.log" | head -1 | sed 's/^secrets in //')
[ -f "$SECRETS" ] || { echo "no secrets file"; exit 1; }
WORK=$(dirname "$SECRETS")
set -a; . "$SECRETS"; set +a
case "$PHF_ISO_URL" in http://127.0.0.1:*) ;; *) echo "REFUSE: not loopback"; exit 3;; esac
unset ELECTRON_RUN_AS_NODE
export E2E_API_GATEWAY="$PHF_ISO_URL" E2E_DEV_PORT=5179 E2E_SUPABASE_URL="http://localhost:5179" \
       E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY" \
       E2E_DB_CONTAINER=phf-iso-db E2E_LOOPBACK_ONLY=1 E2E_NO_CAFFEINATE=1 E2E_STORAGE_BASELINE=0,0
# 080: the trusted public origin is the one the apps are built for (migration 080's CHECK allows loopback http)
docker exec -i phf-iso-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qc \
  "UPDATE public.app_config SET value = '$E2E_SUPABASE_URL' WHERE key = 'supabase_public_url'" || { echo "public url seed failed"; exit 1; }
echo "== playwright (all default specs)"
npx playwright test "$@" 2>&1 | redact > "$OUT/e2e.log"
grep -E '^\s+(✓|✘|-)\s+[0-9]+|[0-9]+ (passed|failed|flaky|did not run|skipped)' "$OUT/e2e.log" | cut -c1-160
