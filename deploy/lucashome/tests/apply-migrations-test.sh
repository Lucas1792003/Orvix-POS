#!/usr/bin/env bash
# apply-migrations-test.sh — integration tests for deploy/lucashome/apply-migrations.sh against LOCAL
# disposable containers only (the runner's test target; never lucashome, never ssh).
#   deploy/lucashome/tests/apply-migrations-test.sh            # plain PostgreSQL 17 + synthetic migrations
#   deploy/lucashome/tests/apply-migrations-test.sh --stack    # also: the real 083 → 085 → 086 → rollback →
#                                                              #   re-apply cycle on the phf-iso audit stack
# Plain part: atomic apply + ledger record (failure injection in a migration AND in the record step),
# re-run / gap / held / checksum refusals, dry-run, concurrent runners, ledger changed between plan and
# apply, bounded lock_timeout. Stack part: the real files, rollback owner gate, rollback lock timeout,
# rollback failure injected at its last statement, operation ledger byte-identical, apply → rollback →
# re-apply twice, and refusal of 062–085 at every step.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
RUNNER="$REPO/deploy/lucashome/apply-migrations.sh"
STACK=0; [ "${1:-}" = "--stack" ] && STACK=1
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker socket only"; exit 3;; esac
T="$(mktemp -d)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok    $*"; }
nok() { FAIL=$((FAIL+1)); echo "FAIL  $*"; sed 's/^/        | /' "$T/last.out" | tail -15; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else FAIL=$((FAIL+1)); echo "FAIL  $1 (got [$2], want [$3])"; fi; }

CT=""; DBU=""; MIGD=""; RBD=""; HELDV=""
R() { APPLY_MIGRATIONS_TEST_CONTAINER="$CT" APPLY_MIGRATIONS_TEST_MIGRATIONS="$MIGD" APPLY_MIGRATIONS_TEST_ROLLBACKS="$RBD" \
      APPLY_MIGRATIONS_TEST_DB_USER="$DBU" APPLY_MIGRATIONS_TEST_HELD="$HELDV" bash "$RUNNER" "$@" > "$T/last.out" 2>&1; }
pg() { docker exec -i "$CT" psql -X -U "$DBU" -d postgres -At -v ON_ERROR_STOP=1 "$@"; }
runs()    { local d=$1; shift; if R "$@"; then ok "$d"; else nok "$d (runner failed)"; fi; }
refuses() { local d=$1 pat=$2; shift 2; if R "$@"; then nok "$d (runner succeeded)"; elif grep -q -- "$pat" "$T/last.out"; then ok "$d"; else nok "$d (no '$pat')"; fi; }
ledger() { pg -c "select string_agg(version, ' ' order by version) from supabase_migrations.schema_migrations"; }
shaf() { echo "sha256:$(shasum -a 256 "$1" | cut -c1-64)"; }

cleanup() {
  docker rm -f orvix-migtest-pg >/dev/null 2>&1
  [ "$STACK" = 1 ] && { ids=$(docker ps -aq --filter 'name=^phf-iso-'); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1; docker network rm phf-iso-net >/dev/null 2>&1; }
  case "${SWORK:-}" in /tmp/*|/private/tmp/*|/var/folders/*) [ -f "$SWORK/secrets.env" ] && rm -rf "$SWORK";; esac
  rm -rf "$T"
}
trap cleanup EXIT

# ======================================================================== plain PostgreSQL
echo "== plain: postgres:17 (no published port), synthetic migrations 001–006, held 004"
docker rm -f orvix-migtest-pg >/dev/null 2>&1
docker run -d --name orvix-migtest-pg -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null || { echo "cannot start postgres:17"; exit 1; }
CT=orvix-migtest-pg; DBU=postgres; MIGD="$T/mig"; RBD="$T/rb"; HELDV=004
# the image answers on its socket during initdb (a temporary server) and then restarts: wait for the end of init
ready=0; for _ in $(seq 1 90); do docker logs orvix-migtest-pg 2>&1 | grep -q "PostgreSQL init process complete" && { ready=1; break; }; sleep 1; done
[ "$ready" = 1 ] || { echo "postgres:17 did not finish its init"; exit 1; }
ready=0; for _ in $(seq 1 60); do pg -c 'select 1' >/dev/null 2>&1 && { ready=1; break; }; sleep 1; done
[ "$ready" = 1 ] || { echo "postgres:17 not ready"; exit 1; }
pg >/dev/null <<'SQL' || { echo "test database setup failed"; exit 1; }
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
CREATE TABLE public.idempotency_keys (key uuid PRIMARY KEY);
SQL
mkdir -p "$MIGD" "$RBD"
for v in 001 002 003 004 005 006; do echo "CREATE TABLE public.t$v (id int);" > "$MIGD/${v}_t$v.sql"; done

refuses "dry-run with nothing recorded: 003 needs 001 and 002 (gap)" "gap: earlier migration 001" --from 003 --to 003 --dry-run
runs    "dry-run 001–003 plans" --from 001 --to 003 --dry-run
check   "dry-run changed nothing" "$(ledger)" ""
runs    "apply 001–003" --from 001 --to 003
check   "ledger 001 002 003" "$(ledger)" "001 002 003"
check   "002 recorded with its file sha256" "$(pg -c "select statements[1] || '|' || name from supabase_migrations.schema_migrations where version='002'")" "$(shaf "$MIGD/002_t002.sql")|t002"
refuses "re-run 002 refused" "already recorded" --from 002 --to 002
refuses "held 004 refused without --allow-skipped" "held list" --from 004 --to 004

# failure injection 1: the second of two migrations fails -> neither applied nor recorded
echo "CREATE TABLE public.t006 (id int); SELECT 1/0;" > "$MIGD/006_t006.sql"
refuses "005+006 with 006 failing: rolled back" "nothing was applied or recorded" --from 005 --to 006
check   "005 not applied (atomic)" "$(pg -c "select to_regclass('public.t005') is null")" "t"
check   "ledger unchanged" "$(ledger)" "001 002 003"
echo "CREATE TABLE public.t006 (id int);" > "$MIGD/006_t006.sql"

# failure injection 2: the migration succeeds but its ledger record fails -> the migration is rolled back too
echo "CREATE TABLE public.t005 (id int); INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('005');" > "$MIGD/005_t005.sql"
refuses "005 whose ledger record clashes: rolled back" "nothing was applied or recorded" --from 005 --to 005
check   "005 not applied when its record failed (atomic apply+record)" "$(pg -c "select to_regclass('public.t005') is null")" "t"
check   "ledger unchanged" "$(ledger)" "001 002 003"
echo "CREATE TABLE public.t005 (id int);" > "$MIGD/005_t005.sql"

runs    "005 with 004 held (not a gap)" --from 005 --to 005
check   "ledger 001 002 003 005" "$(ledger)" "001 002 003 005"
refuses "004 after 005 refused (out of order) even with --allow-skipped" "out-of-order" --from 004 --to 004 --allow-skipped

# checksum mismatch: a recorded file edited afterwards
cp "$MIGD/002_t002.sql" "$T/002.bak"; echo "-- edited" >> "$MIGD/002_t002.sql"
refuses "edited 002 -> checksum mismatch refuses 006" "CHECKSUM MISMATCH" --from 006 --to 006
check   "mismatch did not repair the ledger" "$(pg -c "select statements[1] from supabase_migrations.schema_migrations where version='002'")" "$(shaf "$T/002.bak")"
cp "$T/002.bak" "$MIGD/002_t002.sql"

# ledger changed between plan and apply: an uncommitted ledger insert is invisible to the plan; the guard
# waits for it (bounded), sees a different ledger and refuses
cp "$MIGD/005_t005.sql" "$MIGD/007_t007.sql"; sed -i.bak 's/t005/t007/' "$MIGD/007_t007.sql"; rm -f "$MIGD/007_t007.sql.bak"
( echo "BEGIN; INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES ('900', NULL, 'x'); SELECT pg_sleep(4); COMMIT;" | pg >/dev/null 2>&1 ) &
sleep 1
refuses "ledger changed after planning -> LEDGER_CHANGED" "LEDGER_CHANGED" --from 006 --to 006
wait
check   "006 not applied" "$(pg -c "select to_regclass('public.t006') is null")" "t"
pg -c "delete from supabase_migrations.schema_migrations where version='900'" >/dev/null

# concurrent runners: A sleeps inside its transaction; B (same range) and C (another range) start meanwhile
echo "CREATE TABLE public.t006 (id int); SELECT pg_sleep(5);" > "$MIGD/006_t006.sql"
( APPLY_MIGRATIONS_TEST_CONTAINER="$CT" APPLY_MIGRATIONS_TEST_MIGRATIONS="$MIGD" APPLY_MIGRATIONS_TEST_DB_USER="$DBU" APPLY_MIGRATIONS_TEST_HELD="$HELDV" \
  bash "$RUNNER" --from 006 --to 006 > "$T/a.out" 2>&1; echo $? > "$T/a.rc" ) &
sleep 2
refuses "concurrent runner B (same range) refused" "RUNNER_BUSY" --from 006 --to 006
refuses "concurrent runner C (006–007) refused" "RUNNER_BUSY" --from 006 --to 007
wait
check   "runner A succeeded" "$(cat "$T/a.rc")" "0"
check   "006 recorded exactly once" "$(pg -c "select count(*) from supabase_migrations.schema_migrations where version='006'")" "1"
check   "ledger 001 002 003 005 006" "$(ledger)" "001 002 003 005 006"

# bounded lock_timeout: a migration that needs a lock another session holds fails (default 10s), nothing applied
echo "ALTER TABLE public.t001 ADD COLUMN x int;" > "$MIGD/007_t007.sql"
( echo "BEGIN; LOCK TABLE public.t001 IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(25); COMMIT;" | pg >/dev/null 2>&1 ) &
sleep 1; t0=$(date +%s)
refuses "007 behind a held lock fails on lock_timeout" "lock timeout" --from 007 --to 007
el=$(( $(date +%s) - t0 ))
[ "$el" -lt 22 ] && ok "lock wait was bounded (${el}s < 22s)" || { FAIL=$((FAIL+1)); echo "FAIL  lock wait not bounded (${el}s)"; }
check   "007 not recorded" "$(ledger)" "001 002 003 005 006"
wait

# a migration that ends the runner's transaction (a top-level END the detector cannot see) is caught by
# the tripwire: reported, NOT recorded (what it committed before the END is left for owner review)
printf 'CREATE TABLE public.t007a (id int);\nEND;\nCREATE TABLE public.t007b (id int);\n' > "$MIGD/007_t007.sql"
refuses "007 with a top-level END: tripwire" "RUNNER_TRANSACTION_BROKEN" --from 007 --to 007
grep -q "PARTIALLY COMMITTED" "$T/last.out" && ok "the tripwire is reported as PARTIALLY COMMITTED (not 'nothing applied')" || nok "tripwire not reported as partial"
check   "007 not recorded after the tripwire" "$(ledger)" "001 002 003 005 006"
pg -c "drop table if exists public.t007a, public.t007b" >/dev/null
echo "ALTER TABLE public.t001 ADD COLUMN x int;" > "$MIGD/007_t007.sql"

# unknown ledger states
pg -c "insert into supabase_migrations.schema_migrations (version) values ('20240101120000')" >/dev/null
refuses "unknown ledger version refused" "does not know" --from 007 --to 007 --dry-run
pg -c "delete from supabase_migrations.schema_migrations where version='20240101120000'" >/dev/null
pg -c "insert into supabase_migrations.schema_migrations (version) values ('050')" >/dev/null
refuses "recorded version without a repo file refused" "has no 050" --from 007 --to 007 --dry-run
pg -c "delete from supabase_migrations.schema_migrations where version='050'" >/dev/null
CT=lucashome-db; refuses "non-disposable test container name refused" "test container must be" --from 007 --to 007 --dry-run; CT=orvix-migtest-pg

if [ "$STACK" = 1 ]; then
  # ====================================================================== real stack
  echo "== stack: phf-iso audit stack at 083 (084 held), production-shaped ledger"
  ids=$(docker ps -aq --filter 'name=^phf-iso-'); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1; docker network rm phf-iso-net >/dev/null 2>&1
  PHF_ISO_SKIP_MIGRATIONS=084 bash "$REPO/tools/security-audit/run.sh" --max-migration 083 --stack-only > "$T/stack.log" 2>&1 || { tail -20 "$T/stack.log"; echo "stack failed"; exit 1; }
  SWORK=$(dirname "$(grep -o 'secrets in [^,;]*secrets.env' "$T/stack.log" | head -1 | sed 's/^secrets in //')")
  CT=phf-iso-db; DBU=supabase_admin; MIGD="$REPO/supabase/migrations"; RBD="$REPO/supabase/rollbacks"; HELDV=084
  pg -c "alter table supabase_migrations.schema_migrations add column if not exists statements text[], add column if not exists name text" >/dev/null
  check "stack ledger ends at 083 without 084" "$(pg -c "select max(version) || ' ' || bool_or(version='084') from supabase_migrations.schema_migrations")" "083 false"
  M085="$MIGD/085_png_only_product_images.sql"; [ -f "$M085" ] || M085=$(ls "$MIGD"/085_*.sql)
  M086="$MIGD/086_operation_outcomes.sql"
  ROLLMD5=$(grep -o "idem_begin(uuid,text,text)'::regprocedure) <> '[0-9a-f]*' THEN\$" "$RBD/086_operation_outcomes.rollback.sql" | tail -1 | grep -o "[0-9a-f]\{32\}")
  FWDMD5=$(grep -o "idem_begin(uuid,text,text)'::regprocedure) <> '[0-9a-f]*' THEN\$" "$RBD/086_operation_outcomes.rollback.sql" | head -1 | grep -o "[0-9a-f]\{32\}")
  ib()  { pg -c "select md5(prosrc) from pg_proc where oid='public.idem_begin(uuid,text,text)'::regprocedure"; }
  opx() { pg -c "select to_regprocedure('public.op_execute(uuid,text,jsonb,text)') is not null"; }
  pk()  { pg -c "select pg_get_constraintdef(oid) from pg_constraint where conname='idempotency_keys_pkey'"; }
  ik()  { pg -c "select count(*) || ' ' || md5(coalesce(string_agg(k::text, '|' order by org_id, key), '')) from idempotency_keys k"; }

  refuses "084 (held) refused" "held list" --from 084 --to 085
  refuses "--from 086 with 085 unrecorded refused (gap)" "gap: earlier migration 085" --from 086 --to 086 --dry-run
  runs    "083 -> 085 (084 skipped)" --from 085 --to 085
  check   "085 recorded with its sha256" "$(pg -c "select statements[1] from supabase_migrations.schema_migrations where version='085'")" "$(shaf "$M085")"
  runs    "085 -> 086" --from 086 --to 086
  check   "086 recorded with its sha256" "$(pg -c "select statements[1] from supabase_migrations.schema_migrations where version='086'")" "$(shaf "$M086")"
  check   "086 fingerprint: executor, per-org identity, 086 idem_begin" "$(opx) $(pk) $(ib)" "t PRIMARY KEY (org_id, key) $FWDMD5"
  refuses "re-run 062–085 after 086 refused" "already recorded" --from 062 --to 085 --dry-run
  refuses "re-run 085 after 086 refused" "already recorded" --from 085 --to 085 --dry-run
  refuses "084 after 086 refused (out of order)" "out-of-order" --from 084 --to 084 --allow-skipped --dry-run
  refuses "re-run 086 refused" "already recorded" --from 086 --to 086 --dry-run

  # operation history the rollback must keep: a committed row, a rejected and an abandoned tombstone
  pg >/dev/null <<'SQL' || nok "seeding the operation history failed"
INSERT INTO idempotency_keys (key, rpc, actor_id, org_id, request_hash, state, outcome_code, decided_at)
VALUES (gen_random_uuid(), 'complete_sale', NULL, '!unattributed', 'R:' || md5('t1'), 'rejected', 'P0001', now()),
       (gen_random_uuid(), 'complete_sale', NULL, '!unattributed', 'A:', 'abandoned', 'FENCED', now()),
       (gen_random_uuid(), 'complete_sale', NULL, '!unattributed', md5('t3'), 'committed', NULL, now());
SQL
  check   "operation history seeded (committed, rejected, abandoned)" "$(pg -c "select string_agg(state, ',' order by state) from idempotency_keys")" "abandoned,committed,rejected"
  IK0=$(ik)
  refuses "rollback without the owner's till-queue confirmation refused" "owner has not confirmed" --rollback 086
  check   "nothing changed" "$(opx) $(ledger | tr ' ' '\n' | tail -1)" "t 086"
  if pg -f - < "$RBD/086_operation_outcomes.rollback.sql" > "$T/last.out" 2>&1; then nok "direct psql rollback ran"; else grep -q "no owner confirmation" "$T/last.out" && ok "direct psql rollback refused by its gate" || nok "direct psql rollback: unexpected error"; fi
  check   "nothing changed" "$(opx) $(ib)" "t $FWDMD5"
  # plain psql WITHOUT ON_ERROR_STOP, outside a transaction (ordinary incident behaviour): still nothing
  docker exec -i "$CT" psql -X -U "$DBU" -d postgres -f - < "$RBD/086_operation_outcomes.rollback.sql" > "$T/last.out" 2>&1
  grep -q "no owner confirmation" "$T/last.out" && ok "plain psql rollback refused by its preflight (the reason)" || nok "plain psql rollback: unexpected failure reason"
  check   "rollback as plain psql without ON_ERROR_STOP: nothing changed" "$(opx) $(ib) $(ledger | tr ' ' '\n' | tail -1)" "t $FWDMD5 086"
  { echo "SET orvix.rollback_gate = 'till-queues-empty-confirmed-by-owner';"; cat "$RBD/086_operation_outcomes.rollback.sql"; } | docker exec -i "$CT" psql -X -U "$DBU" -d postgres -f - > "$T/last.out" 2>&1
  grep -q "not inside the runner's transaction" "$T/last.out" && ok "a gate set by hand for the session is refused" || nok "session gate not refused"
  check   "nothing changed" "$(opx) $(ib) $(ledger | tr ' ' '\n' | tail -1)" "t $FWDMD5 086"

  # rollback failure 1: the operation ledger is busy -> bounded lock wait, nothing changed
  ( echo "BEGIN; LOCK TABLE public.idempotency_keys IN ROW EXCLUSIVE MODE; SELECT pg_sleep(15); COMMIT;" | pg >/dev/null 2>&1 ) &
  sleep 1; t0=$(date +%s)
  refuses "rollback while the operation ledger is write-locked fails on lock_timeout" "lock timeout" --rollback 086 --owner-confirmed-till-queues-empty
  el=$(( $(date +%s) - t0 )); [ "$el" -lt 13 ] && ok "rollback lock wait bounded (${el}s)" || { FAIL=$((FAIL+1)); echo "FAIL  rollback lock wait ${el}s"; }
  wait
  check   "after failed rollback: executor, 086 body, 086 recorded, ledger identical" "$(opx) $(ib) $(ledger | tr ' ' '\n' | tail -1) $(ik)" "t $FWDMD5 086 $IK0"

  # rollback failure 2: injected at its LAST statement (the ledger-row delete) -> every drop is undone
  pg >/dev/null <<'SQL'
CREATE FUNCTION public.zz_test_block_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_FAILURE'; END $$;
CREATE TRIGGER zz_test_block_delete BEFORE DELETE ON supabase_migrations.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.zz_test_block_delete();
SQL
  refuses "rollback failing at its last statement" "INJECTED_FAILURE" --rollback 086 --owner-confirmed-till-queues-empty
  check   "after injected failure: executor, 086 body, 086 recorded, ledger identical" "$(opx) $(ib) $(ledger | tr ' ' '\n' | tail -1) $(ik)" "t $FWDMD5 086 $IK0"
  pg -c "DROP TRIGGER zz_test_block_delete ON supabase_migrations.schema_migrations; DROP FUNCTION public.zz_test_block_delete();" >/dev/null

  for round in 1 2; do
    runs    "rollback 086 (round $round)" --rollback 086 --owner-confirmed-till-queues-empty
    check   "rolled back: no executor, per-org identity kept, rollback idem_begin, 086 row removed" "$(opx) $(pk) $(ib) $(ledger | tr ' ' '\n' | tail -1)" "f PRIMARY KEY (org_id, key) $ROLLMD5 085"
    check   "operation ledger byte-identical (tombstones kept)" "$(ik)" "$IK0"
    refuses "second rollback refused" "not recorded" --rollback 086 --owner-confirmed-till-queues-empty
    refuses "085 after the rollback refused (086 lineage present)" "already recorded" --from 085 --to 085 --dry-run
    refuses "062–086 after the rollback refused" "already recorded" --from 062 --to 086 --dry-run
    refuses "held 084 after the rollback refused (086 lineage present, 086 unrecorded)" "lineage is present" --from 084 --to 084 --allow-skipped --dry-run
    runs    "re-apply 086 (forward recovery, round $round)" --from 086 --to 086
    check   "re-applied: executor, 086 body, 086 recorded with sha" "$(opx) $(ib) $(pg -c "select statements[1] from supabase_migrations.schema_migrations where version='086'")" "t $FWDMD5 $(shaf "$M086")"
    check   "operation ledger still identical" "$(ik)" "$IK0"
  done

  # concurrent rollbacks: one wins, the other is refused; no half state
  ( APPLY_MIGRATIONS_TEST_CONTAINER="$CT" APPLY_MIGRATIONS_TEST_MIGRATIONS="$MIGD" APPLY_MIGRATIONS_TEST_ROLLBACKS="$RBD" APPLY_MIGRATIONS_TEST_DB_USER="$DBU" \
    bash "$RUNNER" --rollback 086 --owner-confirmed-till-queues-empty > "$T/r1.out" 2>&1; echo $? > "$T/r1.rc" ) &
  ( APPLY_MIGRATIONS_TEST_CONTAINER="$CT" APPLY_MIGRATIONS_TEST_MIGRATIONS="$MIGD" APPLY_MIGRATIONS_TEST_ROLLBACKS="$RBD" APPLY_MIGRATIONS_TEST_DB_USER="$DBU" \
    bash "$RUNNER" --rollback 086 --owner-confirmed-till-queues-empty > "$T/r2.out" 2>&1; echo $? > "$T/r2.rc" ) &
  wait
  check   "concurrent rollbacks: exactly one succeeded" "$(cat "$T/r1.rc" "$T/r2.rc" | grep -c '^0$')" "1"
  check   "state is the rolled-back state" "$(opx) $(ib) $(ledger | tr ' ' '\n' | tail -1) $(ik)" "f $ROLLMD5 085 $IK0"
  runs    "final re-apply 086" --from 086 --to 086
  check   "final: 086 fingerprint" "$(opx) $(pk) $(ib)" "t PRIMARY KEY (org_id, key) $FWDMD5"
fi

echo
echo "apply-migrations-test: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
