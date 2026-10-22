#!/usr/bin/env bash
# Financial-backend test harness for the PROVISIONAL migrations PFIN-A/B (PFIN-C held)
# (supabase/migrations-provisional). Its OWN throwaway Postgres container on
# loopback; synthetic data only; never touches lucashome, hosted Supabase,
# production, or any shared harness container (pos-test-db, phf-iso-*,
# zz-m087*, orvix-*).
#
#   supabase/tests/fin/run.sh          # full run, container removed at the end
#   FIN_TEST_KEEP=1 ...                # leave the container up (password printed to a temp file)
#   FIN_BASELINE_T01=1 ...             # control: phase-d t01 on the unmodified schema, then stop
#   FIN_EXPORT_DIR=<dir> ...           # also write the real RPC replies used by the client contract
#                                      # test (src/features/reports/finReports.contract.test.ts)
#   FIN_WITH_HELD=1 ...                # also the HELD PFIN-C (migrations-provisional/held/, tests/fin/held/);
#                                      # default: PFIN-A + PFIN-B only, and the run asserts PFIN-C is absent
#
# Steps: baseline restore -> migrations 062..086 (as postgres, like
# supabase db push) -> phase-d schema + seed -> PFIN-A / PFIN-B independence
# and rollback checks -> PFIN-A + PFIN-B as the superuser (twice: idempotency)
# -> phase-d t01..t09 as a regression run -> the fin test files f00..f05, f07
# -> install 087 (in its recovery HOLD state) -> f06, f07 (reports and PFIN
# re-apply under 087) -> summary. Exit status non-zero on any FAIL or aborted step.
set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SQL="$HERE/sql"
PD="$REPO/supabase/tests/phase-d/sql"
PROV="$REPO/supabase/migrations-provisional"

IMAGE="${FIN_TEST_IMAGE:-supabase/postgres:17.6.1.136}"
NAME="${FIN_TEST_CONTAINER:-zz-finbe-db}"
PORT="${FIN_TEST_PORT:-55493}"
BASELINE_SQL="${BASELINE_SQL:-$HOME/shwephala-migration/20261011T2347Z/schema.scrubbed.sql}"
HOSTED_GRANTS_TXT="${HOSTED_GRANTS_TXT:-$(dirname "$BASELINE_SQL")/hosted-grants.txt}"
KEEP="${FIN_TEST_KEEP:-0}"
LABEL="orvix.fin-backend-test=1"
PW="$(openssl rand -hex 16)"
WORK="$(mktemp -d)"
STEP_FAILS=0

log()  { printf '\n==> %s\n' "$*"; }
fail() { printf 'STEP FAILED: %s\n' "$*"; STEP_FAILS=$((STEP_FAILS + 1)); }

# ---- refuse anything that is not our own disposable container ------------
case "$NAME" in
  pos-test-db|phf-iso-*|zz-m087*|orvix-*) echo "REFUSE: $NAME belongs to a shared harness"; exit 3;;
esac
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
if docker container inspect "$NAME" >/dev/null 2>&1; then
  if [ "$(docker container inspect -f '{{index .Config.Labels "orvix.fin-backend-test"}}' "$NAME")" != "1" ]; then
    echo "REFUSE: a container named $NAME exists and was not created by this harness"; exit 3
  fi
  docker rm -f "$NAME" >/dev/null
fi

cleanup() {
  rc=$?
  if [ "$KEEP" = "1" ]; then
    echo "$PW" > "$WORK/pw"
    echo "FIN_TEST_KEEP=1: $NAME left running on 127.0.0.1:$PORT (password in $WORK/pw)"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

[ -f "$BASELINE_SQL" ] || { echo "BASELINE_SQL not found: $BASELINE_SQL"; exit 2; }
command -v psql >/dev/null || { echo "psql not found"; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not present locally (this harness never pulls)"; exit 2; }

log "starting $NAME from $IMAGE on 127.0.0.1:$PORT"
docker run -d --name "$NAME" --label "$LABEL" -p "127.0.0.1:$PORT:5432" --memory 1g \
  -e POSTGRES_PASSWORD="$PW" "$IMAGE" >/dev/null || { echo "docker run failed"; exit 2; }

pg_psql() { PGPASSWORD="$PW" psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
su_psql() { docker exec -i -e PGPASSWORD="$PW" "$NAME" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

for i in $(seq 1 90); do pg_psql -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
pg_psql -Atc 'select 1' >/dev/null 2>&1 || { echo "postgres did not come up"; exit 2; }
sleep 3
su_psql -Atc 'select 1' >/dev/null 2>&1 || { echo "supabase_admin login failed"; exit 2; }

log "prep + baseline restore + storage 016"
su_psql -At < "$PD/00_prep.sql" > "$WORK/prep.log" 2>&1 || { cat "$WORK/prep.log"; fail prep; exit 1; }
su_psql < "$BASELINE_SQL" > "$WORK/baseline.log" 2>&1 || { tail -20 "$WORK/baseline.log"; fail baseline; exit 1; }
su_psql < "$REPO/supabase/migrations/016_product_images_storage.sql" > "$WORK/s016.log" 2>&1 || { tail -5 "$WORK/s016.log"; fail storage016; }

log "migrations 062..086 (as postgres)"
for f in "$REPO"/supabase/migrations/*.sql; do
  n="$(basename "$f" | cut -d_ -f1)"
  case "$n" in ''|*[!0-9]*) continue;; esac
  if [ "$((10#$n))" -gt 61 ] && [ "$((10#$n))" -le 86 ]; then
    pg_psql -f "$f" > "$WORK/mig_$n.log" 2>&1 || { tail -20 "$WORK/mig_$n.log"; fail "migration $n"; exit 1; }
  fi
done
echo "applied 062..086"

log "phase-d test schema + seed"
su_psql -At < "$PD/01_test_schema.sql" > "$WORK/schema.log" 2>&1 || { cat "$WORK/schema.log"; fail "test schema"; exit 1; }
su_psql -At < "$PD/02_seed.sql" > "$WORK/seed.log" 2>&1 || { cat "$WORK/seed.log"; fail seed; exit 1; }
if [ -f "$HOSTED_GRANTS_TXT" ]; then
  pg_psql -c "\\copy test.expected_grants FROM '$HOSTED_GRANTS_TXT' (FORMAT csv, DELIMITER '|')" >/dev/null || fail "hosted grants"
fi

HELD="${FIN_WITH_HELD:-0}"
HELD_MIG="$PROV/held/PFIN-C_refund_net_paid_cap.sql"
HELD_RB="$PROV/held/PFIN-C.rollback.sql"
if [ "$HELD" = "1" ] && { [ ! -f "$HELD_MIG" ] || [ ! -f "$HELD_RB" ] || [ ! -d "$HERE/held" ]; }; then
  echo "FIN_WITH_HELD=1 but the held PFIN-C files are not present"; exit 2
fi

apply_one() {    # $1 = file, $2 = label
  su_psql --single-transaction -f - < "$1" > "$WORK/$(basename "$1" .sql).$2.log" 2>&1 \
    && echo "applied $(basename "$1") ($2)" || { tail -10 "$WORK/$(basename "$1" .sql).$2.log"; fail "$(basename "$1") ($2)"; }
}
PCOST="${FIN_WITH_PCOST:-1}"   # provisional cost privacy (P-4); FIN_WITH_PCOST=0 = the pre-PCOST control
apply_pfin() {   # $1 = pass label. PFIN-A, PFIN-B (+ PCOST-A); PFIN-C (held) is applied separately, and only with FIN_WITH_HELD=1
  apply_one "$PROV/PFIN-A_report_indexes.sql" "$1"
  apply_one "$PROV/PFIN-B_financial_reports.sql" "$1"
  [ "$PCOST" = "1" ] && apply_one "$PROV/PCOST-A_cost_privacy.sql" "$1"
  return 0
}
chk() {          # $1 = name, $2 = SQL boolean
  local n; n="$(printf '%s' "$1" | sed "s/'/''/g")"
  su_psql -Atc "SELECT test.check('$n', $2)" | grep -E '^(PASS|FAIL)'
}
N_IDX="(select count(*) from pg_indexes where schemaname = 'public' and indexname in ('sales_shop_created_idx','sales_shift_idx','refund_void_requests_sale_idx','audit_logs_fin_approval_entity_idx','audit_logs_fin_approval_time_idx'))"
N_FN="(select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'fin\_%')"
N_TRG="(select count(*) from pg_trigger where tgrelid = 'public.refund_void_requests'::regclass and tgname like 'fin\_%')"

if [ "${FIN_BASELINE_T01:-0}" = "1" ]; then
  # control run: the unmodified 234b761 schema (no PFIN) through phase-d t01 only
  log "CONTROL: phase-d t01 WITHOUT the PFIN migrations"
  su_psql -At < "$PD/t01_permissions_rls.sql" 2>&1 | grep -E '^(PASS|FAIL)' | grep -E '^FAIL' || echo "t01: no FAIL"
  exit 0
fi

log "INDEPENDENCE: PFIN-A alone, PFIN-B alone (without PFIN-A), each rolled back; PFIN-C never applied"
apply_one "$PROV/PFIN-A_report_indexes.sql" a-alone
chk "independence: PFIN-A alone installs its 5 indexes and nothing else" "$N_IDX = 5 AND $N_FN = 0 AND $N_TRG = 0"
apply_one "$PROV/PFIN-A.rollback.sql" a-alone-rb
chk "independence: PFIN-A rollback alone removes all 5 indexes" "$N_IDX = 0 AND $N_FN = 0"
expect_refusal() {   # $1 = file, $2 = expected text, $3 = check name, $4 = label
  if su_psql --single-transaction -f - < "$1" > "$WORK/refuse.$4.log" 2>&1; then
    chk "$3" "false"
  else
    ok=false; grep -qF "$2" "$WORK/refuse.$4.log" && ok=true; chk "$3" "$ok"
  fi
}
log "PFIN-A refusals: an INVALID same-named index (failed concurrent build), a same-named index with another definition"
su_psql -Atc "CREATE INDEX CONCURRENTLY sales_shift_idx ON public.sales ((1 / (length(id) - length(id))))" > "$WORK/invalid_idx.log" 2>&1 || true
chk "fixture: a failed concurrent build left an INVALID sales_shift_idx" \
  "EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.sales_shift_idx') AND NOT i.indisvalid)"
expect_refusal "$PROV/PFIN-A_report_indexes.sql" "PFIN-A: an INVALID index with a PFIN-A name exists" \
  "PFIN-A refuses when an INVALID index with one of its names exists" invalid
su_psql -Atc "DROP INDEX public.sales_shift_idx; CREATE INDEX sales_shift_idx ON public.sales (receipt_no)" >/dev/null
expect_refusal "$PROV/PFIN-A_report_indexes.sql" "exist with a different definition than PFIN-A creates" \
  "PFIN-A refuses a same-named index with a different definition (never registers it as its own)" otherdef
su_psql -Atc "DROP INDEX public.sales_shift_idx" >/dev/null
chk "the refused PFIN-A runs left nothing behind" "$N_IDX = 0"

apply_one "$PROV/PFIN-B_financial_reports.sql" b-alone
chk "independence: PFIN-B alone (no PFIN-A indexes) installs its 10 functions (Script 2: + 2 payment-method helpers), no trigger" "$N_IDX = 0 AND $N_FN = 10 AND $N_TRG = 0"
chk "independence: PFIN-B alone answers a report (ADMIN, shop A, today)" \
  "(SELECT jsonb_typeof(public.fin_report_summary('shop-a', current_date, current_date, 'SALE_DATE')->'totals') = 'object' FROM (SELECT test.login('a0000000-0000-4000-8000-000000000001')) l)"
apply_one "$PROV/PFIN-B.rollback.sql" b-alone-rb
chk "independence: PFIN-B rollback alone removes all 10 functions" "$N_FN = 0 AND $N_IDX = 0"

if [ "$PCOST" = "1" ]; then
  log "PCOST-A alone: costs moved to the gated tables, rolled back (copied back), re-applied"
  COSTS="(select string_agg(id || '=' || coalesce(cost_mmk::text, '-'), ',' order by id) from products) || '|' || (select string_agg(id || '=' || coalesce(purchase_price_mmk::text, '-'), ',' order by id) from product_units)"
  BEFORE_COSTS="$(su_psql -Atc "select $COSTS")"
  # a till's write transaction is open: the move must wait for it (lock), and
  # past lock_timeout give up cleanly with nothing moved -- never copy around it
  su_psql -Atc "BEGIN; UPDATE products SET name = name WHERE id = 'prod-1'; SELECT pg_sleep(8); COMMIT;" > "$WORK/pcost_locker.log" 2>&1 &
  LOCKER=$!
  sleep 1
  expect_refusal "$PROV/PCOST-A_cost_privacy.sql" "lock timeout" \
    "PCOST-A waits for live writers on the guarded tables and, past lock_timeout, fails cleanly" pcost-locked
  wait "$LOCKER"
  chk "PCOST-A refused under the lock moved nothing (no side tables, legacy costs intact)" \
    "to_regclass('public.product_costs') IS NULL AND $COSTS = '$(printf '%s' "$BEFORE_COSTS" | sed "s/'/''/g")'"
  apply_one "$PROV/PCOST-A_cost_privacy.sql" pcost-alone
  chk "PCOST-A alone: legacy columns NULL, every cost in product_costs / product_unit_costs" \
    "NOT EXISTS (SELECT 1 FROM products WHERE cost_mmk IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM product_units WHERE purchase_price_mmk IS NOT NULL) AND (SELECT count(*) FROM product_costs) > 0"
  apply_one "$PROV/PCOST-A.rollback.sql" pcost-rb
  chk "PCOST-A rollback copies every cost back exactly and removes the side tables" \
    "$COSTS = '$(printf '%s' "$BEFORE_COSTS" | sed "s/'/''/g")' AND to_regclass('public.product_costs') IS NULL AND to_regproc('public.cost_redirect_products') IS NULL"
fi

log "PFIN-A + PFIN-B (+ PCOST-A) (superuser, one transaction each), twice (idempotency), then rolled back B -> A and re-applied"
apply_pfin first
apply_pfin second
apply_one "$PROV/PFIN-B.rollback.sql" rb
apply_one "$PROV/PFIN-A.rollback.sql" rb
chk "rollback: B then A leave no fin_ function and no PFIN-A index" "$N_FN = 0 AND $N_IDX = 0"
apply_pfin reapply
chk "checkpoint state: PFIN-A + PFIN-B installed, PFIN-C absent (no fin_ trigger, no fin_guard function)" \
  "$N_IDX = 5 AND $N_FN = 10 AND $N_TRG = 0 AND to_regproc('public.fin_guard_refund_net_paid') IS NULL"

run_sql_test() {
  f="$1"; name="$(basename "$f" .sql)"
  log "test $name"
  if su_psql -At < "$f" > "$WORK/$name.log" 2>&1; then
    grep -E '^(PASS|FAIL|FINDING|SKIP|INFO)' "$WORK/$name.log"
  else
    cat "$WORK/$name.log"; fail "$name (psql aborted)"
  fi
}

log "REGRESSION: phase-d t01..t09 with PFIN-A + PFIN-B applied"
run_sql_test "$PD/t01_permissions_rls.sql"
run_sql_test "$PD/t02_shift.sql"
run_sql_test "$PD/t03_sale_idempotency.sql"
BEFORE="$(su_psql -Atc "select count(*) from sales where shop_id='shop-a'")"
su_psql -At < "$PD/t04_concurrency_a.sql" > "$WORK/t04a.out" 2>&1 &
APID=$!
sleep 1; T0=$(date +%s)
su_psql -At < "$PD/t04_concurrency_b.sql" > "$WORK/t04b.out" 2>&1 || fail "t04 session B"
T1=$(date +%s); wait $APID || fail "t04 session A"
RA="$(tail -n 1 "$WORK/t04a.out")"; RB="$(tail -n 1 "$WORK/t04b.out")"
su_psql -At -v ra="$RA" -v rb="$RB" -v before="$BEFORE" -v bsecs="$((T1 - T0))" < "$PD/t04_concurrency_check.sql" > "$WORK/t04c.log" 2>&1 \
  && grep -E '^(PASS|FAIL)' "$WORK/t04c.log" || { cat "$WORK/t04c.log"; fail "t04 check"; }
run_sql_test "$PD/t05_stock_supplier.sql"
run_sql_test "$PD/t06_po_transfer_records.sql"
run_sql_test "$PD/t07_multi_terminal.sql"
run_sql_test "$PD/t08_consistency_close.sql"
run_sql_test "$PD/t09_org_isolation.sql"

EXPORT_DIR="${FIN_EXPORT_DIR:-}"
# export_json NAME AUTH-UUID|null SQL  -> $EXPORT_DIR/NAME.json (the reply AS that user, or its error)
export_json() {
  [ -n "$EXPORT_DIR" ] || return 0
  local auth="$2" q; q="$(printf '%s' "$3" | sed "s/'/''/g")"
  [ "$auth" = "null" ] && auth="NULL" || auth="'$auth'::uuid"
  # written to a temp file and moved only on success: a failed export never leaves a partial fixture
  if su_psql -At -c "SELECT jsonb_pretty(test.capture($auth, '$q'))" > "$EXPORT_DIR/.$1.json.tmp" && [ -s "$EXPORT_DIR/.$1.json.tmp" ]; then
    mv "$EXPORT_DIR/.$1.json.tmp" "$EXPORT_DIR/$1.json" && echo "exported $1"
  else
    rm -f "$EXPORT_DIR/.$1.json.tmp"; fail "export $1"
  fi
}
ADMIN_A=a0000000-0000-4000-8000-000000000001; ADMIN_X=a0000000-0000-4000-8000-000000000011
MGR_F=f0000000-0000-4000-8000-000000000001; CASH_F1=f0000000-0000-4000-8000-000000000002

log "FINANCIAL tests"
run_sql_test "$SQL/f00_seed.sql"
run_sql_test "$SQL/f01_reports.sql"
if [ -n "$EXPORT_DIR" ]; then
  mkdir -p "$EXPORT_DIR"
  su_psql -At < "$HERE/export/x00_capture.sql" > "$WORK/x00.log" 2>&1 || { cat "$WORK/x00.log"; fail "export helper"; }
  D1="$(su_psql -Atc "select test.var('D1')")"; D2="$(su_psql -Atc "select test.var('D2')")"
  printf '{"D1":"%s","D2":"%s"}\n' "$D1" "$D2" > "$EXPORT_DIR/days.json"
  # the fixtures belong to exactly this PFIN-B text; the contract test fails when PFIN-B changes without a re-export
  shasum -a 256 "$PROV/PFIN-B_financial_reports.sql" | cut -c1-64 > "$EXPORT_DIR/pfin-b.sha256"
  export_json summary_admin_shop_sale "$ADMIN_A" "SELECT public.fin_report_summary('shop-f', '$D1', '$D2', 'SALE_DATE')"
  export_json summary_admin_shop_approval "$ADMIN_A" "SELECT public.fin_report_summary('shop-f', '$D1', '$D2', 'APPROVAL_DATE')"
  export_json summary_admin_shop_sale_d1 "$ADMIN_A" "SELECT public.fin_report_summary('shop-f', '$D1', '$D1', 'SALE_DATE')"
  export_json summary_manager_own_shop "$MGR_F" "SELECT public.fin_report_summary(NULL, '$D1', '$D2', 'SALE_DATE')"
  export_json summary_cashier_own "$CASH_F1" "SELECT public.fin_report_summary(NULL, '$D1', '$D2', 'SALE_DATE')"
  export_json summary_other_org_admin "$ADMIN_X" "SELECT public.fin_report_summary(NULL, '$D1', '$D2', 'SALE_DATE')"
  export_json error_cashier_other_shop "$CASH_F1" "SELECT public.fin_report_summary('shop-a', '$D1', '$D2', 'SALE_DATE')"
  export_json error_other_org_shop "$ADMIN_X" "SELECT public.fin_report_summary('shop-f', '$D1', '$D2', 'SALE_DATE')"
  export_json error_org_range "$ADMIN_A" "SELECT public.fin_report_summary(NULL, current_date - 100, current_date, 'SALE_DATE')"
  export_json error_anon null "SELECT public.fin_report_summary(NULL, current_date, current_date, 'SALE_DATE')"
fi
run_sql_test "$SQL/f02_shift_reconciliation.sql"
if [ -n "$EXPORT_DIR" ]; then
  for v in S1 S2 S3 S4 S5; do
    id="$(su_psql -Atc "select test.var('$v')")"
    export_json "recon_$(echo "$v" | tr 'S' 's')_manager" "$MGR_F" "SELECT public.fin_shift_reconciliation('$id')"
  done
  export_json recon_s2_cashier_own "f0000000-0000-4000-8000-000000000003" "SELECT public.fin_shift_reconciliation('$(su_psql -Atc "select test.var('S2')")')"
  export_json error_recon_other_cashier "f0000000-0000-4000-8000-000000000003" "SELECT public.fin_shift_reconciliation('$(su_psql -Atc "select test.var('S1')")')"
fi
run_sql_test "$SQL/f03_allocation_evidence.sql"
run_sql_test "$SQL/f04_volume.sql"
if [ -n "$EXPORT_DIR" ]; then
  export_json summary_volume_year "$ADMIN_A" "SELECT public.fin_report_summary('shop-v', '$(su_psql -Atc "select test.var('vfrom')")', '$(su_psql -Atc "select test.var('vto')")', 'SALE_DATE')"
fi
run_sql_test "$SQL/f05_outcomes.sql"
run_sql_test "$SQL/f07_privileges.sql"
[ "$PCOST" = "1" ] && run_sql_test "$SQL/f08_cost_privacy.sql"

if [ "$HELD" = "1" ]; then
  log "HELD: PFIN-C applied to the populated database, its tests, and the PFIN-B rollback guard"
  apply_one "$HELD_MIG" held
  run_sql_test "$HERE/held/c01_refund_cap.sql"
  if su_psql --single-transaction -f - < "$PROV/PFIN-B.rollback.sql" > "$WORK/rbB_held.log" 2>&1; then
    chk "held: PFIN-B rollback refuses while PFIN-C is installed" "false"
  else
    ok=false; grep -q 'PFIN-B rollback: PFIN-C is still installed' "$WORK/rbB_held.log" && ok=true
    chk "held: PFIN-B rollback refuses while PFIN-C is installed" "$ok AND $N_FN = 11"
  fi
fi

log "install 087 (superuser, single transaction; left in its recovery hold - no lease, no authority)"
su_psql -Atc "alter system set supautils.reserved_roles = '$(su_psql -Atc 'show supautils.reserved_roles'), recovery_owner, recovery_authority, recovery_gate'" >/dev/null \
  && su_psql -Atc "select pg_reload_conf()" >/dev/null && sleep 2
if su_psql --single-transaction -f - < "$REPO/supabase/migrations/087_recovery_hold.sql" > "$WORK/mig_087.log" 2>&1; then
  echo "087 installed: $(su_psql -Atc "select state from recovery.continuity")"
  log "PFIN-A/B re-applied under 087 (superuser)"
  apply_pfin under087
  [ "$HELD" = "1" ] && apply_one "$HELD_MIG" under087
  if [ "$PCOST" = "1" ]; then
    chk "PCOST-A re-applied during the 087 hold: nothing to move, legacy columns still NULL, costs kept" \
      "NOT EXISTS (SELECT 1 FROM products WHERE cost_mmk IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM sale_items WHERE unit_cost_mmk_snapshot IS NOT NULL) AND (SELECT cost_mmk FROM product_costs WHERE product_id = 'prod-1') = 600"
    chk "PCOST-A redirect triggers are part of the 087 snapshot (products, product_units, sale_items, purchase_order_items)" \
      "(SELECT count(*) FROM recovery_guard.snapshot WHERE relname IN ('products','product_units','sale_items','purchase_order_items') AND fingerprint LIKE '%zzc_cost_%') = 4"
    chk "no unexplained 087 drift after the PCOST-A re-apply" \
      "NOT EXISTS (SELECT 1 FROM recovery_guard.snapshot g WHERE g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))"
  fi
  log "PFIN-A under 087: refuses over unexplained drift; rollback + re-apply under 087"
  su_psql -Atc "CREATE INDEX zz_fin_drift_probe ON public.sales (paid_mmk)" >/dev/null
  expect_refusal "$PROV/PFIN-A_report_indexes.sql" "differ from the 087 snapshot; refusing to re-register over unexplained drift" \
    "f06 PFIN-A refuses to run (and re-register 087) while a guarded table has unexplained drift" drift
  su_psql -Atc "DROP INDEX public.zz_fin_drift_probe" >/dev/null
  chk "f06 drift probe removed: fingerprints equal the snapshot again" \
    "NOT EXISTS (SELECT 1 FROM recovery_guard.snapshot g WHERE g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))"
  apply_one "$PROV/PFIN-A.rollback.sql" rb-under087
  chk "f06 PFIN-A rollback under 087 removes the indexes and re-registers (no drift)" \
    "$N_IDX = 0 AND NOT EXISTS (SELECT 1 FROM recovery_guard.snapshot g WHERE g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))"
  apply_one "$PROV/PFIN-A_report_indexes.sql" reapply-under087
  log "PFIN-A as the non-superuser postgres under 087 (must refuse)"
  if pg_psql --single-transaction -f "$PROV/PFIN-A_report_indexes.sql" > "$WORK/pfin_a_pg.log" 2>&1; then
    su_psql -Atc "SELECT test.check('f06 PFIN-A refuses a non-superuser runner when 087 is installed', false, 'it applied')" | grep -E '^(PASS|FAIL)'
  else
    ok=false; grep -q 'PFIN-A: migration 087 is installed: run as the superuser migration runner' "$WORK/pfin_a_pg.log" && ok=true
    su_psql -Atc "SELECT test.check('f06 PFIN-A refuses a non-superuser runner when 087 is installed', $ok)" | grep -E '^(PASS|FAIL)'
  fi
  log "087 DDL guard after the PFIN re-apply: non-superuser DDL on a guarded table refused, unrelated DDL allowed (no drift left)"
  if pg_psql -c "CREATE INDEX zz_fin_probe ON public.sales (receipt_no)" > "$WORK/ddl1.log" 2>&1; then
    su_psql -Atc "SELECT test.check('f06 non-superuser CREATE INDEX on sales refused by 087', false, 'it succeeded')" | grep -E '^(PASS|FAIL)'
  else
    ok=false; grep -q 'RECOVERY_GUARD_PROTECTED' "$WORK/ddl1.log" && ok=true
    su_psql -Atc "SELECT test.check('f06 non-superuser CREATE INDEX on sales refused by 087', $ok)" | grep -E '^(PASS|FAIL)'
  fi
  if pg_psql -c "CREATE TABLE public.zz_fin_probe_free (x int); DROP TABLE public.zz_fin_probe_free" > "$WORK/ddl2.log" 2>&1; then
    su_psql -Atc "SELECT test.check('f06 unrelated non-superuser DDL still allowed (the backstop sees no fingerprint drift)', true)" | grep -E '^(PASS|FAIL)'
  else
    tail -3 "$WORK/ddl2.log"
    su_psql -Atc "SELECT test.check('f06 unrelated non-superuser DDL still allowed (the backstop sees no fingerprint drift)', false)" | grep -E '^(PASS|FAIL)'
  fi
  run_sql_test "$SQL/f06_under_087.sql"
  run_sql_test "$SQL/f07_privileges.sql"
  [ "$HELD" = "1" ] && run_sql_test "$HERE/held/c02_under_087.sql"
else
  tail -15 "$WORK/mig_087.log"; fail "087 install"
fi

[ "$HELD" = "1" ] || chk "end state: PFIN-C was never installed in this run" "$N_TRG = 0 AND to_regproc('public.fin_guard_refund_net_paid') IS NULL"

log "summary"
su_psql -At -c "select kind, ok, count(*) from test.results group by 1, 2 order by 1, 2"
su_psql -At -c "select 'FAIL ' || name || coalesce(' -- ' || detail, '') from test.results where not ok and kind = 'CHECK' order by seq"
su_psql -At -c "select 'FINDING-NOT-FIXED ' || name from test.results where not ok and kind = 'FINDING' order by seq"
NFAIL="$(su_psql -Atc "select count(*) from test.results where not ok")"
echo "assertion failures: $NFAIL, step failures: $STEP_FAILS"
[ "$NFAIL" = "0" ] && [ "$STEP_FAILS" = "0" ]
