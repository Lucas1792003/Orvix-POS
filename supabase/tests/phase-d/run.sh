#!/usr/bin/env bash
# Phase D DB-level test harness. Throwaway Postgres container, baseline schema
# restore, migrations > 061, synthetic seed, SQL assertions. Synthetic data
# only; never touches any real database. See README.md.
set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SQL="$HERE/sql"

IMAGE="${POS_TEST_IMAGE:-supabase/postgres:17.6.1.136}"
FALLBACK_IMAGE="public.ecr.aws/supabase/postgres:17.6.1.159"
NAME="${POS_TEST_CONTAINER:-pos-test-db}"
PORT="${POS_TEST_PORT:-55432}"
BASELINE_SQL="${BASELINE_SQL:-$HOME/shwephala-migration/20261011T2347Z/schema.scrubbed.sql}"
HOSTED_GRANTS_TXT="${HOSTED_GRANTS_TXT:-$(dirname "$BASELINE_SQL")/hosted-grants.txt}"
KEEP="${POS_TEST_KEEP:-0}"
# Phase G: apply migrations only up to this number (default: all). Capping at
# 067 reproduces the schema BEFORE the org-isolation fix (068+); t09's
# cross-org assertions then come out as FINDINGs instead of failures.
MAX_MIG="${POS_TEST_MAX_MIGRATION:-999}"
ORG_FIX_MIG=68
PW="$(openssl rand -hex 16)"
WORK="$(mktemp -d)"
STEP_FAILS=0

log()  { printf '\n==> %s\n' "$*"; }
fail() { printf 'STEP FAILED: %s\n' "$*"; STEP_FAILS=$((STEP_FAILS + 1)); }

cleanup() {
  rc=$?
  if [ "$KEEP" = "1" ]; then
    echo "POS_TEST_KEEP=1: leaving container $NAME running on 127.0.0.1:$PORT (password in $WORK/pw)"
    echo "$PW" > "$WORK/pw"
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

[ -f "$BASELINE_SQL" ] || { echo "BASELINE_SQL not found: $BASELINE_SQL"; exit 2; }
command -v docker >/dev/null || { echo "docker not found"; exit 2; }
command -v psql   >/dev/null || { echo "psql not found (brew install libpq)"; exit 2; }

# ---------------------------------------------------------------- image ----
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "pulling $IMAGE"
  if ! docker pull "$IMAGE"; then
    echo "pull failed (no arm64 manifest?) - falling back to $FALLBACK_IMAGE"
    IMAGE="$FALLBACK_IMAGE"
    docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" || { echo "cannot obtain an image"; exit 2; }
  fi
fi

# ------------------------------------------------------------ container ----
docker rm -f "$NAME" >/dev/null 2>&1 || true
log "starting $NAME from $IMAGE on 127.0.0.1:$PORT (--memory 1g, random password)"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5432" --memory 1g \
  -e POSTGRES_PASSWORD="$PW" "$IMAGE" >/dev/null || { echo "docker run failed"; exit 2; }

# host psql as the non-superuser `postgres` (how `supabase db push` applies migrations)
pg_psql() { PGPASSWORD="$PW" psql -X -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
# superuser session inside the container (restores the dump, runs the tests;
# tests switch to API roles with SET ROLE)
su_psql() { docker exec -i -e PGPASSWORD="$PW" "$NAME" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

log "waiting for postgres"
for i in $(seq 1 90); do
  if pg_psql -Atc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
pg_psql -Atc 'select 1' >/dev/null 2>&1 || { echo "postgres did not come up"; docker logs "$NAME" | tail -40; exit 2; }
sleep 3   # the image's init scripts may still be finishing
if ! su_psql -Atc 'select current_user' >/dev/null 2>&1; then
  echo "supabase_admin login failed inside the container"; docker logs "$NAME" | tail -40; exit 2
fi
echo "server: $(pg_psql -Atc 'select version()')"
echo "postgres superuser? $(pg_psql -Atc "select rolsuper from pg_roles where rolname='postgres'")  supabase_admin superuser? $(su_psql -Atc "select rolsuper from pg_roles where rolname='supabase_admin'")"

# --------------------------------------------------------------- prep ----
log "prep: auth.users shim / publication check (as superuser)"
su_psql -At < "$SQL/00_prep.sql" > "$WORK/prep.log" 2>&1 || { cat "$WORK/prep.log"; fail "prep"; exit 1; }
grep -E 'auth_uid|created|already|NOTICE' "$WORK/prep.log" | head -5
echo "auth.uid() reads: $(grep -oE "request\.jwt\.[a-z.]+" "$WORK/prep.log" | sort -u | tr '\n' ' ')"

# ----------------------------------------------------------- baseline ----
log "restoring baseline $BASELINE_SQL (as superuser)"
if ! su_psql < "$BASELINE_SQL" > "$WORK/baseline.log" 2>&1; then
  tail -30 "$WORK/baseline.log"; fail "baseline restore"; exit 1
fi
echo "baseline: $(su_psql -Atc "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'") functions, $(su_psql -Atc "select count(*) from pg_tables where schemaname='public'") tables, $(su_psql -Atc "select count(*) from pg_policies where schemaname='public'") policies"

# The schema dump excludes the storage schema; replay 016 (bucket + the 4
# product-images policies) onto the prep shim so storage.objects RLS reflects
# production before 071 rewrites it.
log "storage baseline: applying 016_product_images_storage.sql onto the storage shim"
if su_psql < "$REPO/supabase/migrations/016_product_images_storage.sql" > "$WORK/storage016.log" 2>&1; then
  echo "storage.objects policies: $(su_psql -Atc "select count(*) from pg_policies where schemaname='storage' and tablename='objects'")"
else
  tail -10 "$WORK/storage016.log"; fail "storage baseline (016)"
fi

# --------------------------------------------------------- migrations ----
log "applying migrations > 061 and <= $MAX_MIG (as postgres, like supabase db push)"
for f in "$REPO"/supabase/migrations/*.sql; do
  n="$(basename "$f" | cut -d_ -f1)"
  case "$n" in ''|*[!0-9]*) continue;; esac
  if [ "$((10#$n))" -gt 61 ] && [ "$((10#$n))" -le "$((10#$MAX_MIG))" ]; then
    if pg_psql -f "$f" > "$WORK/mig_$n.log" 2>&1; then
      echo "applied $(basename "$f")"
    else
      tail -20 "$WORK/mig_$n.log"; fail "migration $(basename "$f")"; exit 1
    fi
  fi
done

log "re-applying migrations > 061 and <= $MAX_MIG a second time (proves they are idempotent)"
for f in "$REPO"/supabase/migrations/*.sql; do
  n="$(basename "$f" | cut -d_ -f1)"
  case "$n" in ''|*[!0-9]*) continue;; esac
  if [ "$((10#$n))" -gt 61 ] && [ "$((10#$n))" -le "$((10#$MAX_MIG))" ]; then
    if pg_psql -f "$f" > "$WORK/mig2_$n.log" 2>&1; then
      echo "re-applied $(basename "$f") OK"
    else
      tail -20 "$WORK/mig2_$n.log"; fail "second apply of $(basename "$f") (not idempotent)"
    fi
  fi
done

# ---------------------------------------------------- test schema+seed ----
log "test schema + synthetic seed (as superuser)"
su_psql -At < "$SQL/01_test_schema.sql" > "$WORK/schema.log" 2>&1 || { cat "$WORK/schema.log"; fail "test schema"; exit 1; }
su_psql -At < "$SQL/02_seed.sql" > "$WORK/seed.log" 2>&1 || { cat "$WORK/seed.log"; fail "seed"; exit 1; }
grep -E '^seeded' "$WORK/seed.log"
if [ -f "$HOSTED_GRANTS_TXT" ]; then
  pg_psql -c "\\copy test.expected_grants FROM '$HOSTED_GRANTS_TXT' (FORMAT csv, DELIMITER '|')" >/dev/null \
    && echo "loaded $(pg_psql -Atc 'select count(*) from test.expected_grants') expected grant rows from $(basename "$HOSTED_GRANTS_TXT")" \
    || fail "loading hosted-grants.txt"
else
  echo "WARNING: $HOSTED_GRANTS_TXT not found - table-grant parity check will FAIL"
fi

# -------------------------------------------------------------- tests ----
run_sql_test() {
  f="$1"; name="$(basename "$f" .sql)"
  log "test $name"
  if su_psql -At < "$f" > "$WORK/$name.log" 2>&1; then
    grep -E '^(PASS|FAIL|FINDING|SKIP|INFO)' "$WORK/$name.log"
  else
    cat "$WORK/$name.log"; fail "$name (psql aborted - see above)"
  fi
}

run_sql_test "$SQL/t01_permissions_rls.sql"
run_sql_test "$SQL/t02_shift.sql"
run_sql_test "$SQL/t03_sale_idempotency.sql"

log "test t04_concurrency (two sessions, same key, session A holds its txn open 3 s)"
BEFORE="$(su_psql -Atc "select count(*) from sales where shop_id='shop-a'")"
su_psql -At < "$SQL/t04_concurrency_a.sql" > "$WORK/t04a.out" 2>&1 &
APID=$!
sleep 1
T0=$(date +%s)
su_psql -At < "$SQL/t04_concurrency_b.sql" > "$WORK/t04b.out" 2>&1 || fail "t04 session B"
T1=$(date +%s)
wait $APID || fail "t04 session A"
RA="$(tail -n 1 "$WORK/t04a.out")"; RB="$(tail -n 1 "$WORK/t04b.out")"
echo "session A: $(echo "$RA" | cut -c1-90)..."
echo "session B: $(echo "$RB" | cut -c1-90)...  (B wall time $((T1 - T0))s)"
if su_psql -At -v ra="$RA" -v rb="$RB" -v before="$BEFORE" -v bsecs="$((T1 - T0))" < "$SQL/t04_concurrency_check.sql" > "$WORK/t04c.log" 2>&1; then
  grep -E '^(PASS|FAIL)' "$WORK/t04c.log"
else
  cat "$WORK/t04c.log"; fail "t04 check"
fi

run_sql_test "$SQL/t05_stock_supplier.sql"
run_sql_test "$SQL/t06_po_transfer_records.sql"
run_sql_test "$SQL/t07_multi_terminal.sql"
run_sql_test "$SQL/t08_consistency_close.sql"
# Phase G: seeds a SECOND organization and attempts every cross-org read /
# write / RPC as org-A users. Runs last so the earlier tests' global counts
# are unaffected.
run_sql_test "$SQL/t09_org_isolation.sql"
# Phase G independent review (bootstrap hatch, org_id override / moves,
# cross-org catalog references, upload sessions, Realtime, idempotency vs
# guard) and second-organization creation via the platform-console path.
# Gated: they need 068/069 objects; a run capped at 067 is unchanged.
if [ "$((10#$MAX_MIG))" -ge 69 ]; then
  run_sql_test "$SQL/t10_review.sql"
  run_sql_test "$SQL/t11_second_org.sql"
else
  log "skipping t10_review / t11_second_org (migrations capped at $MAX_MIG < 069)"
fi
# Remaining review items (074-076): idempotency replay bound to the caller's
# org, expired upload sessions, atomic first-time setup. Gated: a run capped
# at 073 is unchanged.
if [ "$((10#$MAX_MIG))" -ge 74 ]; then
  run_sql_test "$SQL/t12_remaining_fixes.sql"
else
  log "skipping t12_remaining_fixes (migrations capped at $MAX_MIG < 074)"
fi
# 077: default price levels for every organization (console path, re-run,
# concurrent creation via dblink, checkout, cross-org). Part A, then 077 is
# re-applied to the populated database (its one-time backfill must seed only
# the org that has zero levels), then part B. Gated: a run capped at 076 is
# unchanged.
if [ "$((10#$MAX_MIG))" -ge 77 ]; then
  run_sql_test "$SQL/t13_new_org_price_levels.sql"
  log "re-applying 077 to the populated database (backfill must touch only the org with zero levels)"
  if pg_psql -f "$REPO/supabase/migrations/077_new_org_price_levels.sql" > "$WORK/mig3_077.log" 2>&1; then
    grep -h -E '077 backfill' "$WORK/mig3_077.log" | sed 's/^.*NOTICE: */INFO /'
  else
    tail -20 "$WORK/mig3_077.log"; fail "re-apply of 077 on populated data"
  fi
  run_sql_test "$SQL/t13_new_org_price_levels_b.sql"
else
  log "skipping t13_new_org_price_levels (migrations capped at $MAX_MIG < 077)"
fi
# 078/079: org-scoped storage paths, legacy (owner-less) objects, session
# token lifecycle; then the anonymous-surface audit of the proposed state.
if [ "$((10#$MAX_MIG))" -ge 79 ]; then
  run_sql_test "$SQL/t14_upload_security.sql"
  run_sql_test "$SQL/t15_anon_audit.sql"
else
  log "skipping t14_upload_security / t15_anon_audit (migrations capped at $MAX_MIG < 079)"
fi
# 080: completion stores a server-derived URL and requires the object.
if [ "$((10#$MAX_MIG))" -ge 80 ]; then
  run_sql_test "$SQL/t16_completion_url.sql"
else
  log "skipping t16_completion_url (migrations capped at $MAX_MIG < 080)"
fi
# Concurrent first-time setup (076). MUST RUN LAST: t12_bootstrap_prep
# empties public.users (TRUNCATE ... CASCADE) to recreate a fresh install in
# this throwaway database. Two sessions call bootstrap_first_admin(); A holds
# its transaction open 3 s, B starts 1 s later and must wait and be refused.
if [ "$((10#$MAX_MIG))" -ge 76 ]; then
  run_sql_test "$SQL/t12_bootstrap_prep.sql"
  log "test t12_bootstrap concurrency (two sessions, empty users table, A holds its txn open 3 s)"
  su_psql -At < "$SQL/t12_bootstrap_a.sql" > "$WORK/t12a.out" 2>&1 &
  BPID=$!
  sleep 1
  T0=$(date +%s)
  su_psql -At < "$SQL/t12_bootstrap_b.sql" > "$WORK/t12b.out" 2>&1 || { cat "$WORK/t12b.out"; fail "t12 bootstrap session B"; }
  T1=$(date +%s)
  wait $BPID || { cat "$WORK/t12a.out"; fail "t12 bootstrap session A"; }
  BA_RES="$(tail -n 1 "$WORK/t12a.out")"
  echo "session A: $(echo "$BA_RES" | cut -c1-120)"
  grep -E '^(PASS|FAIL)' "$WORK/t12b.out" | sed 's/^/session B: /'
  echo "session B wall time $((T1 - T0))s"
  if su_psql -At -v ra="$BA_RES" -v bsecs="$((T1 - T0))" < "$SQL/t12_bootstrap_check.sql" > "$WORK/t12c.log" 2>&1; then
    grep -E '^(PASS|FAIL)' "$WORK/t12c.log"
  else
    cat "$WORK/t12c.log"; fail "t12 bootstrap check"
  fi
else
  log "skipping t12 bootstrap concurrency (migrations capped at $MAX_MIG < 076)"
fi

# ------------------------------------------------------------ summary ----
log "summary"
su_psql -c "SELECT seq, CASE WHEN ok THEN 'PASS' WHEN kind = 'FINDING' THEN 'FINDING' ELSE 'FAIL' END AS result, name, CASE WHEN ok THEN NULL ELSE detail END AS detail FROM test.results ORDER BY seq;"
TOTAL="$(su_psql -Atc 'select count(*) from test.results')"
FAILS="$(su_psql -Atc "select count(*) from test.results where not ok and kind <> 'FINDING'")"
FINDINGS="$(su_psql -Atc "select count(*) from test.results where not ok and kind = 'FINDING'")"
FINDING_CHECKS="$(su_psql -Atc "select count(*) from test.results where kind = 'FINDING'")"
echo "assertions: $TOTAL  failed: $FAILS  findings: $FINDINGS of $FINDING_CHECKS isolation checks  aborted steps: $STEP_FAILS  migrations capped at: $MAX_MIG  image: $IMAGE"
if [ "$FAILS" != "0" ] || [ "$STEP_FAILS" != "0" ]; then
  echo "RESULT: FAIL"; exit 1
fi
if [ "$FINDINGS" != "0" ]; then
  if [ "$((10#$MAX_MIG))" -lt "$ORG_FIX_MIG" ]; then
    echo "RESULT: PASS WITH $FINDINGS FINDINGS (expected: migrations capped at $MAX_MIG, before the org-isolation fix 068+)"; exit 0
  fi
  echo "RESULT: FAIL ($FINDINGS isolation findings remain after the fix migrations)"; exit 1
fi
echo "RESULT: PASS"
exit 0
