#!/usr/bin/env bash
# restore-test.sh — weekly proof that the backups restore.
#  (a) logical:  throwaway supabase/postgres container with a *vanilla* initdb
#                (no supabase init scripts), restore globals.sql + postgres.dump
#                + _supabase.dump + db-settings.sql, compare counts with the
#                counts.json captured at backup time.
#  (b) physical: extract the newest base backup into a temp PGDATA, start a
#                throwaway container on it, wait for recovery, compare counts.
# Throwaway containers: --rm, no published ports, --network none, --memory 1g,
# removed together with their temp dirs by an EXIT trap, also on failure.
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--logical-only|--physical-only] [--dump DIR] [--base DIR] [--keep-on-failure] [--dry-run] [--help]
  --dump DIR          hourly dump directory to test (default: newest in $DUMP_DIR/hourly)
  --base DIR          base backup directory to test (default: newest in $BASE_DIR)
  --keep-on-failure   leave the throwaway container + temp dir in place for inspection (manual cleanup!)
Results go to $STATUS_FILE (job "restore-test") and $LOG_DIR/restore-test.log. Exit 1 if any test fails.
EOF
}

DO_LOGICAL=1; DO_PHYSICAL=1; DUMP_SRC=""; BASE_SRC=""; KEEP_ON_FAILURE=0
while (( $# )); do
  case "$1" in
    --logical-only) DO_PHYSICAL=0 ;;
    --physical-only) DO_LOGICAL=0 ;;
    --dump) DUMP_SRC="$2"; shift ;;
    --base) BASE_SRC="$2"; shift ;;
    --keep-on-failure) KEEP_ON_FAILURE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

init_logging
acquire_lock
require_dirs

TS="$(ts_now)"
START=$SECONDS
L_RESULT="skipped"; L_DETAIL=""; L_SRC=""; L_DUR=0
P_RESULT="skipped"; P_DETAIL=""; P_SRC=""; P_DUR=0

# Errors that are expected when restoring into a vanilla cluster; anything else fails the test.
ALLOWED_ERRORS=(
  'role "[^"]+" already exists'
  'extension "[^"]+" already exists'
  'schema "public" already exists'
)

# shellcheck disable=SC2329  # invoked by the EXIT trap
finish() {
  local rc=$?
  trap - EXIT
  if (( KEEP_ON_FAILURE && rc != 0 )); then
    log "keeping $TW_NAME / $TW_DIR for inspection (remove by hand)"
  else
    tw_cleanup || true
  fi
  local overall="ok"
  [[ "$L_RESULT" == fail || "$P_RESULT" == fail ]] && overall="fail"
  (( rc != 0 )) && overall="fail"
  if (( ! DRY_RUN )); then
    local frag
    frag="$(jq -nc --arg t "$(utc_now)" --arg overall "$overall" \
      --arg lr "$L_RESULT" --arg ld "$L_DETAIL" --arg ls "$L_SRC" --argjson ldur "$L_DUR" \
      --arg pr "$P_RESULT" --arg pd "$P_DETAIL" --arg ps "$P_SRC" --argjson pdur "$P_DUR" \
      --argjson dur "$(( SECONDS - START ))" --argjson warnings "$(warnings_json)" \
      '{last_run:$t, last_result:$overall, duration_s:$dur, warnings:$warnings,
        logical:{result:$lr, detail:$ld, source:$ls, duration_s:$ldur},
        physical:{result:$pr, detail:$pd, source:$ps, duration_s:$pdur}}
       + (if $overall=="ok" then {last_success:$t, message:"ok"} else {message:("failure, see restore-test.log")} end)')"
    status_update restore-test "$frag"
  fi
  log "restore-test finished: overall=$overall logical=$L_RESULT physical=$P_RESULT ($(( SECONDS - START ))s)"
  if docker ps -a --format '{{.Names}}' | grep -q '^sb-restore-test'; then
    warn "leftover sb-restore-test containers present: $(docker ps -a --format '{{.Names}}' | grep '^sb-restore-test' | tr '\n' ' ')"
  fi
  [[ "$overall" == ok ]] && exit 0 || exit 1
}
trap finish EXIT

# filter_errors FILE LABEL — logs every ERROR line, returns 1 if any is not allow-listed.
filter_errors() {
  local file="$1" label="$2" line ok=0 allowed
  while IFS= read -r line; do
    allowed=0
    for re in "${ALLOWED_ERRORS[@]}"; do
      if [[ "$line" =~ $re ]]; then allowed=1; break; fi
    done
    if (( allowed )); then
      log "$label: allowed: ${line:0:200}"
    else
      log "$label: UNEXPECTED: ${line:0:300}"; ok=1
    fi
  done < <(grep -E 'ERROR:|FATAL:|PANIC:|^pg_restore: error' "$file" || true)
  return $ok
}

# ---------------------------------------------------------------------------
logical_test() {
  local t0=$SECONDS src expected actual stderr
  src="${DUMP_SRC:-}"
  if [[ -z "$src" ]]; then
    src="$(latest_dir "$DUMP_DIR/hourly" "$TS_RE")"
    [[ -n "$src" ]] || { L_RESULT=fail; L_DETAIL="no hourly dump found"; return 1; }
    src="$DUMP_DIR/hourly/$src"
  fi
  L_SRC="$src"
  log "logical restore test from $src"
  verify_sha256sums "$src" || { L_RESULT=fail; L_DETAIL="SHA256SUMS mismatch in $src"; return 1; }
  log "checksums ok"
  if (( DRY_RUN )); then log "DRY-RUN: would start a throwaway container, restore, compare counts"; return 0; fi

  TW_NAME="sb-restore-test-logical-$TS"
  TW_DIR="$RESTORE_TEST_DIR/logical-$TS"
  mkdir -p "$TW_DIR" && chmod 0700 "$TW_DIR"
  cp "$src"/{globals.sql,db-settings.sql,postgres.dump,_supabase.dump} "$TW_DIR/"
  [[ "$INCLUDE_PGSODIUM_KEY" == true ]] && { local b; b="$(latest_dir "$BASE_DIR" "$TS_RE")"; [[ -n "$b" && -f "$BASE_DIR/$b/pgsodium_root.key" ]] && cp "$BASE_DIR/$b/pgsodium_root.key" "$TW_DIR/"; }
  chmod 0600 "$TW_DIR"/*
  expected="$(cat "$src/counts.json")"

  tw_start logical
  tw_wait_ready logical || { L_RESULT=fail; L_DETAIL="throwaway (vanilla initdb) did not start"; return 1; }
  log "throwaway ready after $(( SECONDS - t0 ))s (vanilla initdb)"

  stderr="$TW_DIR/restore.err"
  : >"$stderr"
  log "restoring globals.sql"
  docker exec "$TW_NAME" psql -X -U "$DB_ADMIN_USER" -d postgres -q -f /restore/globals.sql >/dev/null 2>>"$stderr" || true
  log "restoring postgres.dump"
  docker exec "$TW_NAME" pg_restore -U "$DB_ADMIN_USER" -d postgres /restore/postgres.dump 2>>"$stderr" || true
  log "restoring _supabase.dump (--create)"
  docker exec "$TW_NAME" pg_restore -U "$DB_ADMIN_USER" -d postgres --create /restore/_supabase.dump 2>>"$stderr" || true
  log "applying db-settings.sql"
  docker exec "$TW_NAME" psql -X -U "$DB_ADMIN_USER" -d postgres -q -f /restore/db-settings.sql >/dev/null 2>>"$stderr" || true
  if ! filter_errors "$stderr" logical; then
    L_RESULT=fail; L_DETAIL="unexpected restore errors (see log)"; return 1
  fi

  actual="$(tw_psql postgres -c "$COUNTS_SQL")" || { L_RESULT=fail; L_DETAIL="count query failed on restored db"; return 1; }
  log "restored counts: $(jq -c 'del(.captured_at)' <<<"$actual")"
  local table
  if table="$(compare_counts "$expected" "$actual")"; then
    log "count comparison:"$'\n'"$table"
  else
    log "count comparison:"$'\n'"$table"
    L_RESULT=fail; L_DETAIL="count mismatch"; return 1
  fi
  local sb_ok
  sb_ok="$(tw_psql _supabase -c "select count(*) from pg_namespace where nspname in ('_analytics','_supavisor')")"
  log "_supabase schemas restored: $sb_ok/2"
  (( sb_ok == 2 )) || { L_RESULT=fail; L_DETAIL="_supabase schemas missing"; return 1; }
  L_RESULT=ok; L_DETAIL="counts match; all restore errors allow-listed"
  L_DUR=$(( SECONDS - t0 ))
  log "logical restore test OK (${L_DUR}s)"
  tw_cleanup
}

# ---------------------------------------------------------------------------
physical_test() {
  local t0=$SECONDS src method expected actual pgdata
  src="${BASE_SRC:-}"
  if [[ -z "$src" ]]; then
    src="$(latest_dir "$BASE_DIR" "$TS_RE")"
    [[ -n "$src" ]] || { P_RESULT=fail; P_DETAIL="no base backup found"; return 1; }
    src="$BASE_DIR/$src"
  fi
  P_SRC="$src"
  log "physical restore test from $src"
  verify_sha256sums "$src" || { P_RESULT=fail; P_DETAIL="SHA256SUMS mismatch in $src"; return 1; }
  method="$(jq -r .method "$src/backup.json")"
  log "checksums ok, method=$method"
  if (( DRY_RUN )); then log "DRY-RUN: would extract, start throwaway on the PGDATA, wait for recovery, compare counts"; return 0; fi

  TW_NAME="sb-restore-test-physical-$TS"
  TW_DIR="$RESTORE_TEST_DIR/physical-$TS"
  pgdata="$TW_DIR/pgdata"
  mkdir -p "$pgdata" && chmod 0700 "$TW_DIR" "$pgdata"
  tar -xzf "$src/base.tar.gz" -C "$pgdata"
  if [[ "$method" == sqlapi ]]; then
    mkdir -p "$pgdata/pg_wal/archive_status" "$pgdata/pg_wal/summaries"
    tar -xzf "$src/pg_wal.tar.gz" -C "$pgdata/pg_wal"
    cp "$src/backup_label" "$pgdata/backup_label"
    [[ -f "$src/tablespace_map" ]] && cp "$src/tablespace_map" "$pgdata/tablespace_map"
  fi
  [[ -f "$pgdata/backup_label" ]] || { P_RESULT=fail; P_DETAIL="no backup_label in extracted PGDATA"; return 1; }
  rm -f "$pgdata/postmaster.pid" "$pgdata/postmaster.opts"
  [[ -f "$src/pgsodium_root.key" ]] && cp "$src/pgsodium_root.key" "$TW_DIR/pgsodium_root.key"
  chmod 0700 "$pgdata"
  log "PGDATA extracted ($(human "$(dir_bytes "$pgdata")"))"
  expected="$(cat "$src/counts.json")"

  tw_start physical
  tw_wait_ready physical || { P_RESULT=fail; P_DETAIL="restored cluster did not start"; return 1; }
  log "throwaway ready after $(( SECONDS - t0 ))s"
  grep -E 'backup recovery|redo (starts|done)|consistent recovery state|archive recovery' "$TW_DIR/postgres.log" | sed 's/^/  pg: /' | tee -a "$LOG_FILE" >&2 || true
  if ! grep -q 'completed backup recovery' "$TW_DIR/postgres.log"; then
    P_RESULT=fail; P_DETAIL="postgres did not report 'completed backup recovery' (backup_label/WAL not applied)"; return 1
  fi

  actual="$(tw_psql postgres -c "$COUNTS_SQL")" || { P_RESULT=fail; P_DETAIL="count query failed on restored cluster"; return 1; }
  log "restored counts: $(jq -c 'del(.captured_at)' <<<"$actual")"
  local table
  if table="$(compare_counts "$expected" "$actual")"; then
    log "count comparison:"$'\n'"$table"
  else
    log "count comparison:"$'\n'"$table"
    P_RESULT=fail; P_DETAIL="count mismatch"; return 1
  fi
  local sb_ok
  sb_ok="$(tw_psql _supabase -c "select count(*) from pg_namespace where nspname in ('_analytics','_supavisor')")"
  log "_supabase schemas present: $sb_ok/2"
  (( sb_ok == 2 )) || { P_RESULT=fail; P_DETAIL="_supabase schemas missing"; return 1; }
  if [[ -f "$TW_DIR/pgsodium_root.key" ]]; then
    local vault
    vault="$(tw_psql postgres -c "select count(*) from vault.decrypted_secrets" 2>/dev/null || echo "n/a")"
    log "vault.decrypted_secrets readable with the backed-up pgsodium key: $vault"
  fi
  P_RESULT=ok; P_DETAIL="backup recovery completed, counts match"
  P_DUR=$(( SECONDS - t0 ))
  log "physical restore test OK (${P_DUR}s)"
  tw_cleanup
}

# ---------------------------------------------------------------------------
RC=0
if (( DO_LOGICAL )); then
  logical_test || { RC=1; L_DUR=$(( L_DUR == 0 ? SECONDS - START : L_DUR )); log "logical restore test FAILED: $L_DETAIL"; tw_cleanup || true; }
fi
if (( DO_PHYSICAL )); then
  physical_test || { RC=1; log "physical restore test FAILED: $P_DETAIL"; (( KEEP_ON_FAILURE )) || tw_cleanup || true; }
fi
exit $RC
