#!/usr/bin/env bash
# Step 6: full BUSINESS workflows in the real Electron app on the COMPLETE local system: 085 + 086 (real runner), then the
# financial provisionals in the recommended order (PSAFE-A, PFIN-A, PFIN-B, PCOST-A, PFIN-D, PFIN-E; PFIN-C stays HELD —
# owner decision P-6), the QA seed, then Recovery V1 + Step 5 (installed by the spec, which needs them BEFORE V1: PFIN-D/E
# refuse to install once V1 is present). Owner signatures are SYNTHETIC. Disposable loopback stack only.
#   tools/recovery-v1/step6/run-business.sh [TAG]      KEEP=1 leaves the stack up
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
PHF_ISO_REALTIME=1 PHF_ISO_SKIP_MIGRATIONS=084 bash "$ROOT/tools/security-audit/run.sh" --max-migration 085 --stack-only > "$OUT/stack/stack.log" 2>&1 || { echo "stack failed"; exit 1; }
SWORK=$(dirname "$(grep -o 'secrets in [^,;]*secrets.env' "$OUT/stack/stack.log" | head -1 | sed 's/^secrets in //')")
echo "$SWORK" > "$OUT/stack/swork.path"
set -a; . "$SWORK/secrets.env"; set +a
case "$PHF_ISO_URL" in http://127.0.0.1:*) ;; *) echo "REFUSE: not loopback"; exit 3;; esac
q() { docker exec -i phf-iso-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
q -c "alter table supabase_migrations.schema_migrations add column if not exists statements text[], add column if not exists name text" > /dev/null
( cd "$ROOT" && APPLY_MIGRATIONS_TEST_CONTAINER=phf-iso-db bash deploy/lucashome/apply-migrations.sh --from 086 --to 086 ) > "$OUT/stack/apply-086.log" 2>&1 || { echo "086 failed"; exit 1; }
for f in PSAFE-A_no_086_rerun_after_087 PFIN-A_report_indexes PFIN-B_financial_reports PCOST-A_cost_privacy PFIN-D_payments_cash PFIN-E_refund_lines PFIN-F_split_refunds PDISC-A_discount_authorization PNET-A_pg_net_lockdown; do
  q --single-transaction -f - < "$ROOT/supabase/migrations-provisional/$f.sql" > "$OUT/stack/$f.log" 2>&1 || { echo "$f failed"; tail -5 "$OUT/stack/$f.log"; exit 1; }
done
echo "financial provisionals applied: $(q -c "select string_agg(x, ',') from (values (to_regclass('public.sale_payments')::text), (to_regclass('public.cash_movements')::text), (to_regclass('public.refund_lines')::text), (to_regclass('public.product_costs')::text)) v(x)")" > "$OUT/stack/financial.txt"
unset ELECTRON_RUN_AS_NODE
export E2E_SUPABASE_URL="http://localhost:5187" E2E_API_GATEWAY="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY"
export E2E_DB_CONTAINER=phf-iso-db E2E_LOOPBACK_ONLY=1 E2E_DEV_PORT=5187 E2E_NO_CAFFEINATE=1 STEP6_BUSINESS_LIVE=1 STEP6_OUT="$OUT"
( cd "$ROOT" && npx playwright test -c playwright.step6business.config.ts ${E2E_GREP:+-g "$E2E_GREP"} 2>&1 | redact; exit "${PIPESTATUS[0]}" ) > "$OUT/e2e.log"
rc=$?   # Playwright's own status, not the redact filter's
echo "step6 business: $(grep -E '[0-9]+ (passed|failed|flaky|skipped|did not run)' "$OUT/e2e.log" | tr '\n' ' ')"
exit "$rc"
