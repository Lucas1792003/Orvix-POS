#!/usr/bin/env bash
# Disposable-database test for provisional PSAFE-A (never re-run 086 after 087).
# Its OWN throwaway Postgres container on loopback; synthetic schema only; never
# touches lucashome, hosted Supabase, production, or any shared harness container
# (pos-test-db, phf-iso-*, zz-m087*, orvix-*, zz-finbe-db).
#
#   supabase/tests/m086-rerun/run.sh        # container removed at the end
#
# Steps: baseline -> 062..086 (as postgres) -> 087 (superuser) -> PSAFE-A ->
# every way of re-running 086 (postgres; superuser one transaction; superuser
# autocommit with / without ON_ERROR_STOP) and direct privilege changes: each
# refused with the database fingerprint unchanged -> unrelated DDL still works
# -> 087 rollback and re-apply WITH the guard present -> PSAFE-A rollback ->
# CONTROL: without the guard the superuser re-run of 086 silently breaks 087.
set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PD="$REPO/supabase/tests/phase-d/sql"
PROV="$REPO/supabase/migrations-provisional"
M086="$REPO/supabase/migrations/086_operation_outcomes.sql"
M087="$REPO/supabase/migrations/087_recovery_hold.sql"
RB087="$REPO/supabase/rollbacks/087_recovery_hold.rollback.sql"

IMAGE="${M086R_TEST_IMAGE:-supabase/postgres:17.6.1.136}"
NAME="${M086R_TEST_CONTAINER:-zz-m086rerun-db}"
PORT="${M086R_TEST_PORT:-55495}"
BASELINE_SQL="${BASELINE_SQL:-$HOME/shwephala-migration/20261011T2347Z/schema.scrubbed.sql}"
LABEL="orvix.m086-rerun-test=1"
PW="$(openssl rand -hex 16)"
WORK="$(mktemp -d)"
PASS=0; FAILS=0

log()  { printf '\n==> %s\n' "$*"; }
ok()   { echo "PASS $*"; PASS=$((PASS + 1)); }
nok()  { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

case "$NAME" in
  pos-test-db|phf-iso-*|zz-m087*|orvix-*|zz-finbe-db) echo "REFUSE: $NAME belongs to a shared harness"; exit 3;;
esac
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
if docker container inspect "$NAME" >/dev/null 2>&1; then
  if [ "$(docker container inspect -f '{{index .Config.Labels "orvix.m086-rerun-test"}}' "$NAME")" != "1" ]; then
    echo "REFUSE: a container named $NAME exists and was not created by this harness"; exit 3
  fi
  docker rm -f "$NAME" >/dev/null
fi
cleanup() { rc=$?; docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; exit $rc; }
trap cleanup EXIT INT TERM

[ -f "$BASELINE_SQL" ] || { echo "BASELINE_SQL not found: $BASELINE_SQL"; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not present locally (this harness never pulls)"; exit 2; }
docker run -d --name "$NAME" --label "$LABEL" -p "127.0.0.1:$PORT:5432" --memory 1g -e POSTGRES_PASSWORD="$PW" "$IMAGE" >/dev/null \
  || { echo "docker run failed"; exit 2; }

pg() { PGPASSWORD="$PW" psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -q "$@"; }
su() { docker exec -i -e PGPASSWORD="$PW" "$NAME" psql -X -U supabase_admin -d postgres -q "$@"; }
for i in $(seq 1 90); do pg -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
sleep 3
su -Atc 'select 1' >/dev/null 2>&1 || { echo "supabase_admin login failed"; exit 2; }

log "baseline + 062..086 (as postgres) + 087 (superuser)"
su -v ON_ERROR_STOP=1 -At < "$PD/00_prep.sql" > "$WORK/prep.log" 2>&1 || { cat "$WORK/prep.log"; exit 1; }
su -v ON_ERROR_STOP=1 < "$BASELINE_SQL" > "$WORK/baseline.log" 2>&1 || { tail -5 "$WORK/baseline.log"; exit 1; }
su -v ON_ERROR_STOP=1 < "$REPO/supabase/migrations/016_product_images_storage.sql" > "$WORK/s016.log" 2>&1 || { tail -5 "$WORK/s016.log"; exit 1; }
for f in "$REPO"/supabase/migrations/*.sql; do
  n="$(basename "$f" | cut -d_ -f1)"; case "$n" in ''|*[!0-9]*) continue;; esac
  if [ "$((10#$n))" -gt 61 ] && [ "$((10#$n))" -le 86 ]; then
    pg -v ON_ERROR_STOP=1 -f "$f" > "$WORK/mig_$n.log" 2>&1 || { tail -5 "$WORK/mig_$n.log"; echo "migration $n failed"; exit 1; }
  fi
done
su -Atc "alter system set supautils.reserved_roles = '$(su -Atc 'show supautils.reserved_roles'), recovery_owner, recovery_authority, recovery_gate'" >/dev/null \
  && su -Atc "select pg_reload_conf()" >/dev/null && sleep 2
su -v ON_ERROR_STOP=1 --single-transaction -f - < "$M087" > "$WORK/087.log" 2>&1 || { tail -5 "$WORK/087.log"; echo "087 failed"; exit 1; }
# the runner records each migration; the 087 rollback requires the 087 row
su -v ON_ERROR_STOP=1 -Atc "CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text)" >/dev/null
su -Atc "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('086','operation_outcomes'), ('087','recovery_hold') ON CONFLICT DO NOTHING" >/dev/null \
  || echo "note: could not record 086/087 in supabase_migrations"
echo "062..087 applied"

# Everything a re-run of 086 could change: functions (body, owner, ACL, settings) in
# public / recovery / recovery_guard, public relation ACLs, event triggers, 087 drift.
FP_SQL="SELECT md5(coalesce((SELECT string_agg(x, '|' ORDER BY x) FROM (
    SELECT p.oid::regprocedure::text || md5(p.prosrc) || pg_get_userbyid(p.proowner) || coalesce(p.proacl::text, '-') || coalesce(p.proconfig::text, '-') AS x
      FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace, 'recovery'::regnamespace, 'recovery_guard'::regnamespace)
    UNION ALL SELECT c.relname || coalesce(c.relacl::text, '-') FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL SELECT e.evtname::text || e.evtenabled::text FROM pg_event_trigger e
    UNION ALL SELECT k.conrelid::regclass::text || k.conname::text || pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.connamespace = 'public'::regnamespace
    UNION ALL SELECT 'reg:' || f.fn || ':' || f.fnid::text FROM recovery_guard.functions f) z), ''))
  || ':' || (SELECT count(*) FROM recovery_guard.snapshot g WHERE g.fingerprint IS DISTINCT FROM recovery_guard.fingerprint(g.relid))"
fp() {   # a query error must never look like an unchanged fingerprint
  local v; v="$(su -v ON_ERROR_STOP=1 -Atc "$FP_SQL" 2>&1)" || { echo "FINGERPRINT-ERROR-$RANDOM: $v"; return; }
  case "$v" in [0-9a-f]*:[0-9]*) echo "$v";; *) echo "FINGERPRINT-ERROR-$RANDOM: $v";; esac
}
V87_OK="SELECT bool_and(pg_get_userbyid(p.proowner) = 'recovery_owner' AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
           AND NOT has_function_privilege('service_role', 'public.prune_idempotency_keys()', 'EXECUTE')
          FROM pg_proc p WHERE p.oid IN ('public.op_execute_v87(uuid,text,jsonb,text,jsonb)'::regprocedure, 'public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb)'::regprocedure)"
v87_ok() { [ "$(su -Atc "$V87_OK" 2>&1)" = "t" ]; }

v87_ok && ok "after 087: both v87 executors owned by recovery_owner, executable by authenticated; prune not service_role" \
       || nok "after 087 the v87 invariants already fail (harness setup)"

log "PSAFE-A (superuser, one transaction), twice"
for pass in 1 2; do
  if su -v ON_ERROR_STOP=1 --single-transaction -f - < "$PROV/PSAFE-A_no_086_rerun_after_087.sql" > "$WORK/psafe.$pass.log" 2>&1; then
    ok "PSAFE-A applies (pass $pass)"
  else nok "PSAFE-A apply pass $pass: $(tail -2 "$WORK/psafe.$pass.log")"; fi
done
if pg -v ON_ERROR_STOP=1 --single-transaction -f "$PROV/PSAFE-A_no_086_rerun_after_087.sql" > "$WORK/psafe.pg.log" 2>&1; then
  nok "PSAFE-A must refuse a non-superuser runner"
else ok "PSAFE-A refuses a non-superuser runner"; fi
FP0="$(fp)"
echo "fingerprint: $FP0"
case "$FP0" in *:0) ok "no 087 drift after PSAFE-A";; *) nok "087 drift after PSAFE-A: $FP0";; esac

refused() {   # $1 = name, $2 = log, $3 = expected text
  if grep -qF "$3" "$2"; then ok "$1 (refused: $3)"; else nok "$1: expected \"$3\" in $2: $(grep -m1 ERROR "$2")"; fi
  local now; now="$(fp)"
  [ "$now" = "$FP0" ] && ok "$1: database fingerprint unchanged" || nok "$1: fingerprint changed ($FP0 -> $now)"
  v87_ok && ok "$1: v87 executors still owned by recovery_owner and executable by authenticated" || nok "$1: v87 executors damaged"
}

log "re-running 086 on a database with 087 + PSAFE-A"
pg -v ON_ERROR_STOP=1 -f "$M086" > "$WORK/rerun.pg.log" 2>&1
refused "086 re-run as postgres (autocommit)" "$WORK/rerun.pg.log" "RECOVERY_GUARD_PROTECTED"
su -v ON_ERROR_STOP=1 --single-transaction -f - < "$M086" > "$WORK/rerun.su1.log" 2>&1
refused "086 re-run as superuser, one transaction" "$WORK/rerun.su1.log" "ORVIX_NO_086_AFTER_087"
su -v ON_ERROR_STOP=1 -f - < "$M086" > "$WORK/rerun.su2.log" 2>&1
refused "086 re-run as superuser, autocommit, ON_ERROR_STOP" "$WORK/rerun.su2.log" "ORVIX_NO_086_AFTER_087"
su -v ON_ERROR_STOP=0 -f - < "$M086" > "$WORK/rerun.su3.log" 2>&1
refused "086 re-run as superuser, autocommit, WITHOUT ON_ERROR_STOP (every later statement still runs)" "$WORK/rerun.su3.log" "ORVIX_NO_086_AFTER_087"
pg -v ON_ERROR_STOP=0 -f "$M086" > "$WORK/rerun.pg0.log" 2>&1
refused "086 re-run as postgres WITHOUT ON_ERROR_STOP (its later prune GRANT runs as the prune's owner)" "$WORK/rerun.pg0.log" "ORVIX_NO_086_AFTER_087"

log "direct privilege changes"
attack() {   # $1 = name, $2 = SQL
  su -v ON_ERROR_STOP=1 -c "$2" > "$WORK/attack.log" 2>&1
  refused "$1" "$WORK/attack.log" "ORVIX_NO_086_AFTER_087"
}
attack "ALTER FUNCTION op_execute_v87 OWNER TO postgres" "ALTER FUNCTION public.op_execute_v87(uuid,text,jsonb,text,jsonb) OWNER TO postgres"
attack "REVOKE EXECUTE on op_status_v87 FROM authenticated" "REVOKE EXECUTE ON FUNCTION public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb) FROM authenticated"
attack "GRANT prune_idempotency_keys TO service_role" "GRANT EXECUTE ON FUNCTION public.prune_idempotency_keys() TO service_role"
attack "GRANT INSERT ON idempotency_keys TO service_role" "GRANT INSERT ON public.idempotency_keys TO service_role"
attack "column-level GRANT UPDATE (response) ON idempotency_keys TO service_role" "GRANT UPDATE (response) ON public.idempotency_keys TO service_role"
attack "ALTER ROUTINE op_status_v87 OWNER TO postgres" "ALTER ROUTINE public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb) OWNER TO postgres"

log "a non-superuser (postgres owns prune_idempotency_keys) is refused too, escape hatch or not"
pg -v ON_ERROR_STOP=1 -c "GRANT EXECUTE ON FUNCTION public.prune_idempotency_keys() TO service_role" > "$WORK/attack.pg.log" 2>&1
refused "postgres: GRANT prune TO service_role" "$WORK/attack.pg.log" "ORVIX_NO_086_AFTER_087"
pg -v ON_ERROR_STOP=1 -c "SET orvix.allow_v87_executor_privilege_change = 'on'; GRANT EXECUTE ON FUNCTION public.prune_idempotency_keys() TO service_role" > "$WORK/attack.pg2.log" 2>&1
refused "postgres with the escape setting: still refused (honoured for superusers only)" "$WORK/attack.pg2.log" "ORVIX_NO_086_AFTER_087"
su -v ON_ERROR_STOP=1 -c "BEGIN; SET LOCAL orvix.allow_v87_executor_privilege_change = 'on'; GRANT EXECUTE ON FUNCTION public.prune_idempotency_keys() TO service_role; COMMIT;" > "$WORK/attack.su.log" 2>&1
refused "superuser with the escape setting: the prune check is NOT lifted (executor check only)" "$WORK/attack.su.log" "ORVIX_NO_086_AFTER_087"

log "the deliberate escape hatch (a future migration replacing the executors) works for its own transaction only"
out="$(su -v ON_ERROR_STOP=1 -At -c "BEGIN; SET LOCAL orvix.allow_v87_executor_privilege_change = 'on'; REVOKE EXECUTE ON FUNCTION public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb) FROM authenticated; SELECT has_function_privilege('authenticated', 'public.op_status_v87(uuid,text,boolean,text,jsonb,jsonb)', 'EXECUTE'); ROLLBACK;" 2>&1)"
[ "$out" = "f" ] && ok "escape hatch: the change is allowed inside a transaction that sets it" || nok "escape hatch: $out"
[ "$(fp)" = "$FP0" ] && ok "escape hatch rolled back: fingerprint unchanged" || nok "escape hatch left a change"

log "PFIN-A, PFIN-B and PCOST-A apply with the guard present (their own owner / grant statements pass)"
for f in PFIN-A_report_indexes PFIN-B_financial_reports PCOST-A_cost_privacy; do
  if su -v ON_ERROR_STOP=1 --single-transaction -f - < "$PROV/$f.sql" > "$WORK/$f.log" 2>&1; then ok "$f applies with PSAFE-A installed"
  else nok "$f with PSAFE-A installed: $(grep -m1 ERROR "$WORK/$f.log")"; fi
done
v87_ok && ok "after PFIN/PCOST the v87 invariants still hold" || nok "v87 invariants after PFIN/PCOST"
FP0="$(fp)"

log "unrelated DDL is unaffected"
if su -v ON_ERROR_STOP=1 -c "CREATE FUNCTION public.zz_psafe_probe() RETURNS int LANGUAGE sql AS 'select 1'; ALTER FUNCTION public.zz_psafe_probe() OWNER TO postgres; GRANT EXECUTE ON FUNCTION public.zz_psafe_probe() TO authenticated; REVOKE EXECUTE ON FUNCTION public.zz_psafe_probe() FROM authenticated; DROP FUNCTION public.zz_psafe_probe();" > "$WORK/unrelated.log" 2>&1; then
  ok "ALTER FUNCTION / GRANT / REVOKE on an unrelated function still work"
else nok "unrelated DDL refused: $(grep -m1 ERROR "$WORK/unrelated.log")"; fi

log "087 rollback and re-apply WITH the guard present (fresh upgrade ordering: guard first, then 087)"
{ echo "SET LOCAL orvix.rollback_gate = 'till-queues-empty-confirmed-by-owner'; SET LOCAL lock_timeout = '5s';"
  echo "SELECT set_config('orvix.runner_txid', txid_current()::text, true);"
  cat "$RB087"; } | su -v ON_ERROR_STOP=1 --single-transaction -f - > "$WORK/rb087.log" 2>&1
if [ $? -eq 0 ] && [ "$(su -Atc "SELECT to_regnamespace('recovery') IS NULL AND to_regprocedure('public.op_execute_v87(uuid,text,jsonb,text,jsonb)') IS NULL")" = "t" ]; then
  ok "087 rollback runs with the guard installed"
  su -Atc "DELETE FROM supabase_migrations.schema_migrations WHERE version = '087'" >/dev/null 2>&1 || true
  if su -v ON_ERROR_STOP=1 --single-transaction -f - < "$M087" > "$WORK/087re.log" 2>&1; then
    ok "087 re-applies with the guard installed (087 disables pre-existing event triggers for its own transaction)"
    [ "$(su -Atc "SELECT evtenabled FROM pg_event_trigger WHERE evtname = 'zz_orvix_no_086_after_087'")" = "A" ] \
      && ok "the guard is enabled ALWAYS again after the 087 re-apply" || nok "guard not re-enabled after 087 re-apply"
    v87_ok && ok "after the 087 re-apply the v87 invariants hold" || nok "v87 invariants after 087 re-apply"
    FP0="$(fp)"
    su -v ON_ERROR_STOP=1 --single-transaction -f - < "$M086" > "$WORK/rerun.after.log" 2>&1
    refused "086 re-run as superuser after the 087 re-apply" "$WORK/rerun.after.log" "ORVIX_NO_086_AFTER_087"
  else nok "087 re-apply with the guard installed: $(grep -m1 ERROR "$WORK/087re.log")"; fi
else
  nok "087 rollback with the guard installed: $(grep -m1 ERROR "$WORK/rb087.log")"
fi

log "PSAFE-A rollback, then CONTROL: the original failure"
if su -v ON_ERROR_STOP=1 --single-transaction -f - < "$PROV/PSAFE-A.rollback.sql" > "$WORK/psafe.rb.log" 2>&1 \
   && [ "$(su -Atc "SELECT count(*) FROM pg_event_trigger WHERE evtname = 'zz_orvix_no_086_after_087'")" = "0" ]; then
  ok "PSAFE-A rollback removes the guard"
else nok "PSAFE-A rollback: $(tail -2 "$WORK/psafe.rb.log")"; fi
if su -v ON_ERROR_STOP=1 --single-transaction -f - < "$M086" > "$WORK/control.log" 2>&1; then
  ok "CONTROL: without the guard the superuser re-run of 086 SUCCEEDS silently (the defect)"
else nok "CONTROL: expected the unguarded re-run to succeed: $(grep -m1 ERROR "$WORK/control.log")"; fi
v87_ok && nok "CONTROL: expected the v87 executors to be damaged" \
       || ok "CONTROL: after it the v87 executors are no longer recovery_owner / authenticated (every v87 till refused)"
if su -v ON_ERROR_STOP=1 --single-transaction -f - < "$PROV/PSAFE-A_no_086_rerun_after_087.sql" > "$WORK/psafe.damaged.log" 2>&1; then
  nok "PSAFE-A must refuse to install over an already damaged database"
else grep -q "already damaged" "$WORK/psafe.damaged.log" && ok "PSAFE-A refuses to install over an already damaged database (repair first)" \
       || nok "PSAFE-A on a damaged database: $(grep -m1 ERROR "$WORK/psafe.damaged.log")"; fi
FP_CTL="$(fp)"
case "$FP_CTL" in FINGERPRINT-ERROR*) nok "CONTROL fingerprint query failed: $FP_CTL";;
  *) [ "$FP_CTL" != "$FP0" ] && ok "CONTROL: the fingerprint detects that damage (so 'unchanged' above is meaningful)" || nok "CONTROL: fingerprint did not change";; esac

echo
echo "m086-rerun: $PASS passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
