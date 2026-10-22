#!/usr/bin/env bash
# Step 6: REAL POS <-> Control integration on DISPOSABLE local infrastructure, no mock anywhere:
#   POS      loopback stack phf-iso-* (085 + 086 through the real runner; Recovery V1 + Step 5 installed by the spec after the
#            QA seed) and the real Electron till;
#   Control  its own container + database (migrations 200-223) and `next start` on localhost:3410 (control-stack.sh);
#   bridge   Control's database -> dblink over phf-iso-net -> POS login orvix_control_bridge (created by the spec, as the POS
#            owner would) -> recovery_v1.operator_*.
#   ORVIX_CONTROL_WT=<control worktree> tools/recovery-v1/step6/run-integration.sh [TAG]      KEEP=1 leaves both up
set -u
umask 077
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
TAG=${1:-run-$(date +%Y%m%dT%H%M%S)}; OUT="$HERE/results/$TAG"; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
: "${ORVIX_CONTROL_WT:?ORVIX_CONTROL_WT is required}"; export ORVIX_CONTROL_WT
docker container inspect orvix-control-db >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Running}}' orvix-control-db)" = true ] && { echo "REFUSE: the Control DEV database container is running; this run never shares its port"; exit 3; }
redact() { sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'; }
teardown() {
  [ "${KEEP:-0}" = 1 ] && return
  bash "$HERE/control-stack.sh" down > /dev/null 2>&1
  bash "$ROOT/tools/m087-verify/lib/stack.sh" down "$OUT/stack" > /dev/null 2>&1
  rm -f "$OUT/bridge.env"
}
trap teardown EXIT
mkdir -p "$OUT/stack"
bash "$HERE/control-stack.sh" down > /dev/null 2>&1
bash "$ROOT/tools/m087-verify/lib/stack.sh" down "$OUT/stack" > /dev/null 2>&1
PHF_ISO_SKIP_MIGRATIONS=084 bash "$ROOT/tools/security-audit/run.sh" --max-migration 085 --stack-only > "$OUT/stack/stack.log" 2>&1 || { echo "stack failed"; exit 1; }
SWORK=$(dirname "$(grep -o 'secrets in [^,;]*secrets.env' "$OUT/stack/stack.log" | head -1 | sed 's/^secrets in //')")
echo "$SWORK" > "$OUT/stack/swork.path"
set -a; . "$SWORK/secrets.env"; set +a
case "$PHF_ISO_URL" in http://127.0.0.1:*) ;; *) echo "REFUSE: not loopback"; exit 3;; esac
docker exec -i phf-iso-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At \
  -c "alter table supabase_migrations.schema_migrations add column if not exists statements text[], add column if not exists name text" > /dev/null
( cd "$ROOT" && APPLY_MIGRATIONS_TEST_CONTAINER=phf-iso-db bash deploy/lucashome/apply-migrations.sh --from 086 --to 086 ) > "$OUT/stack/apply-086.log" 2>&1 || { echo "086 failed"; exit 1; }
bash "$HERE/control-stack.sh" up "$OUT" > "$OUT/control-up.log" 2>&1 || { echo "control up failed"; tail -20 "$OUT/control-up.log"; exit 1; }
bash "$HERE/control-stack.sh" start >> "$OUT/control-up.log" 2>&1 || { echo "control start failed"; exit 1; }
unset ELECTRON_RUN_AS_NODE
export E2E_SUPABASE_URL="http://localhost:5185" E2E_API_GATEWAY="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY"
export E2E_DB_CONTAINER=phf-iso-db E2E_LOOPBACK_ONLY=1 E2E_DEV_PORT=5185 E2E_NO_CAFFEINATE=1 STEP6_LIVE=1 STEP6_OUT="$OUT"
( cd "$ROOT" && npx playwright test -c playwright.step6.config.ts ${E2E_GREP:+-g "$E2E_GREP"} 2>&1 | redact; exit "${PIPESTATUS[0]}" ) > "$OUT/e2e.log"
rc=$?   # Playwright's own status, not the redact filter's
cp "$OUT/ctl/next.log" "$OUT/control-next.log" 2>/dev/null
echo "step6 integration: $(grep -E '[0-9]+ (passed|failed|flaky|skipped|did not run)' "$OUT/e2e.log" | tr '\n' ' ')"
exit "$rc"
