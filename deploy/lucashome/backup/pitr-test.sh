#!/usr/bin/env bash
# pitr-test.sh — real point-in-time-recovery drill (WAL-ARCHIVING.md §4).
#
# TOUCHES THE LIVE DATABASE (creates and drops public.pitr_marker). Run by hand
# with the owner's knowledge; not scheduled.
#
#  1. live db: create public.pitr_marker, insert 3 "before" rows, sleep 2 s,
#     T1 = clock_timestamp(), sleep 2 s, insert 3 "after" rows, pg_switch_wal(),
#     wait until the switched segment is in the archive (measures archive lag)
#  2. throwaway: newest base backup + the archive (read-only) with
#     recovery_target_time = T1, recovery_target_action = promote
#  3. prove only the 3 pre-T1 rows exist, timeline advanced; clean up; drop the
#     marker table from the live db (also on failure, via trap)
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--base DIR] [--keep-on-failure] [--dry-run] [--help]
  --base DIR          base backup to start from (default: newest in $BASE_DIR); must predate the test rows
  --keep-on-failure   leave the throwaway + temp dir for inspection (manual cleanup!)
Creates/drops public.pitr_marker in the LIVE database. Writes job "pitr-test" to $STATUS_FILE.
EOF
}

BASE_SRC=""; KEEP_ON_FAILURE=0
while (( $# )); do
  case "$1" in
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
RESULT=fail; DETAIL="not started"; LAG_MS=-1; ROWS_RESTORED=-1; ROWS_EXPECTED=3; T1=""; SRC=""
MARKER_CREATED=0

finish() {
  local rc=$?
  trap - EXIT
  if (( MARKER_CREATED )); then
    if db_psql postgres -c "drop table if exists public.pitr_marker" >/dev/null 2>&1; then
      log "dropped public.pitr_marker from the live database"
    else
      log "WARN: could not drop public.pitr_marker from the live database - drop it by hand"
    fi
  fi
  if (( KEEP_ON_FAILURE && rc != 0 )); then
    log "keeping $TW_NAME / $TW_DIR for inspection (remove by hand)"
  else
    tw_cleanup || true
  fi
  (( rc != 0 && RESULT == 0 )) || true
  [[ "$RESULT" == ok ]] || RESULT=fail
  if (( ! DRY_RUN )); then
    status_update pitr-test "$(jq -nc --arg t "$(utc_now)" --arg r "$RESULT" --arg d "$DETAIL" --arg t1 "$T1" --arg base "$SRC" \
      --argjson lag "$LAG_MS" --argjson rows "$ROWS_RESTORED" --argjson exp "$ROWS_EXPECTED" --argjson dur "$(( SECONDS - START ))" \
      '{last_run:$t, last_result:$r, detail:$d, target_time:$t1, base:$base, archive_lag_ms:$lag,
        rows_restored:$rows, rows_expected:$exp, duration_s:$dur} + (if $r=="ok" then {last_success:$t} else {} end)')"
  fi
  log "pitr-test finished: $RESULT - $DETAIL ($(( SECONDS - START ))s)"
  [[ "$RESULT" == ok ]] && exit 0 || exit 1
}
trap finish EXIT

# ---------------------------------------------------------------------------
# preconditions
ARCH="$(archiver_json)"
[[ -n "$ARCH" ]] || die "cannot query pg_stat_archiver"
[[ "$(jq -r .archive_mode <<<"$ARCH")" == on ]] || die "archive_mode is not on"
[[ -d "$WAL_ARCHIVE_DIR" ]] || die "WAL archive dir $WAL_ARCHIVE_DIR missing"

SRC="${BASE_SRC:-}"
if [[ -z "$SRC" ]]; then
  b="$(latest_dir "$BASE_DIR" "$TS_RE")"; [[ -n "$b" ]] || die "no base backup found"
  SRC="$BASE_DIR/$b"
fi
verify_sha256sums "$SRC" || die "SHA256SUMS mismatch in $SRC"
METHOD="$(jq -r .method "$SRC/backup.json")"
NEED="$(base_start_wal_file "$SRC")"
[[ -n "$NEED" ]] || die "cannot determine the start WAL segment of $SRC"
[[ -f "$WAL_ARCHIVE_DIR/$NEED.gz" ]] || die "archive lacks $NEED.gz, the first segment $SRC needs"
log "base backup: $SRC (method=$METHOD, needs WAL from $NEED; archive has it)"

if (( DRY_RUN )); then
  log "DRY-RUN: would create public.pitr_marker, insert 3+3 rows around T1, switch WAL, restore $SRC + archive to T1 in a throwaway"
  RESULT=ok; DETAIL="dry-run"; exit 0
fi

# ---------------------------------------------------------------------------
# 1. live database: marker rows around T1
db_psql postgres -c "drop table if exists public.pitr_marker;
  create table public.pitr_marker(id int primary key, phase text not null, inserted_at timestamptz not null default clock_timestamp());" >/dev/null
MARKER_CREATED=1
db_psql postgres -c "insert into public.pitr_marker(id, phase) select g, 'before' from generate_series(1, 3) g" >/dev/null
T1="$(db_psql postgres -c "select clock_timestamp() from pg_sleep(2)")"
db_psql postgres -c "select pg_sleep(2)" >/dev/null
db_psql postgres -c "insert into public.pitr_marker(id, phase) select g, 'after' from generate_series(4, 6) g" >/dev/null
T2="$(db_psql postgres -c "select clock_timestamp()")"
log "live rows:"$'\n'"$(db_psql postgres -c "select id||' '||phase||' '||inserted_at from public.pitr_marker order by id")"
log "T1 (recovery target) = $T1 ; after-rows committed by $T2"

SEG="$(db_psql postgres -c "select pg_walfile_name(pg_switch_wal())")"
S0=$(date +%s%N)
while [[ ! -f "$WAL_ARCHIVE_DIR/$SEG.gz" ]]; do
  sleep 0.1
  (( ( $(date +%s%N) - S0 ) / 1000000000 < 120 )) || die "segment $SEG not archived within 120 s"
done
LAG_MS=$(( ( $(date +%s%N) - S0 ) / 1000000 ))
log "pg_switch_wal -> $SEG archived after ${LAG_MS} ms ($(stat -c %s "$WAL_ARCHIVE_DIR/$SEG.gz") bytes gz)"

# ---------------------------------------------------------------------------
# 2. throwaway: base + archive, recover to T1
TW_NAME="sb-restore-test-pitr-$TS"
TW_DIR="$RESTORE_TEST_DIR/pitr-$TS"
PGDATA="$TW_DIR/pgdata"
mkdir -p "$PGDATA" && chmod 0700 "$TW_DIR" "$PGDATA"
tar -xzf "$SRC/base.tar.gz" -C "$PGDATA"
if [[ "$METHOD" == sqlapi ]]; then
  mkdir -p "$PGDATA/pg_wal/archive_status" "$PGDATA/pg_wal/summaries"
  tar -xzf "$SRC/pg_wal.tar.gz" -C "$PGDATA/pg_wal"
  cp "$SRC/backup_label" "$PGDATA/backup_label"
  [[ -f "$SRC/tablespace_map" ]] && cp "$SRC/tablespace_map" "$PGDATA/tablespace_map"
fi
[[ -f "$PGDATA/backup_label" ]] || die "no backup_label in the extracted base"
rm -f "$PGDATA/postmaster.pid" "$PGDATA/postmaster.opts"
: >"$PGDATA/recovery.signal"
cat >>"$PGDATA/postgresql.auto.conf" <<EOF
# --- pitr-test.sh $TS
restore_command = 'gzip -dc /wal_archive/%f.gz > %p'
recovery_target_time = '$T1'
recovery_target_action = 'promote'
EOF
[[ -f "$SRC/pgsodium_root.key" ]] && cp "$SRC/pgsodium_root.key" "$TW_DIR/pgsodium_root.key"
chmod 0700 "$PGDATA"
log "PGDATA prepared ($(human "$(dir_bytes "$PGDATA")")), recovery_target_time='$T1'"

TW_EXTRA_ARGS=(-v "$WAL_ARCHIVE_DIR:/wal_archive:ro")
tw_start physical
tw_wait_ready physical || { DETAIL="restored cluster did not start"; exit 1; }
log "throwaway ready after $(( SECONDS - START ))s; recovery log lines:"
grep -E 'backup recovery|restored log file|recovery stopping|recovery target|selected new timeline|archive recovery complete|redo done|ready to accept' "$TW_DIR/postgres.log" | sed 's/^/  pg: /' | tee -a "$LOG_FILE" >&2 || true
grep -q 'recovery stopping before commit of transaction' "$TW_DIR/postgres.log" || { DETAIL="no 'recovery stopping before commit' line: target not applied"; exit 1; }

# ---------------------------------------------------------------------------
# 3. evidence
ROWS="$(tw_psql postgres -c "select id||' '||phase||' '||inserted_at from public.pitr_marker order by id")" || { DETAIL="public.pitr_marker missing in the restored cluster"; exit 1; }
ROWS_RESTORED="$(tw_psql postgres -c "select count(*) from public.pitr_marker")"
AFTER_ROWS="$(tw_psql postgres -c "select count(*) from public.pitr_marker where phase = 'after' or inserted_at > '$T1'::timestamptz")"
TLI="$(tw_psql postgres -c "select timeline_id from pg_control_checkpoint()")"
IN_RECOVERY="$(tw_psql postgres -c "select pg_is_in_recovery()")"
log "restored rows at target:"$'\n'"$ROWS"
log "restored count=$ROWS_RESTORED (expected $ROWS_EXPECTED), rows after T1=$AFTER_ROWS (expected 0), timeline=$TLI, in_recovery=$IN_RECOVERY"
if (( ROWS_RESTORED == ROWS_EXPECTED && AFTER_ROWS == 0 )) && [[ "$IN_RECOVERY" == f ]] && (( TLI > 1 )); then
  RESULT=ok; DETAIL="recovered to T1: $ROWS_RESTORED pre-T1 rows present, 0 post-T1 rows, promoted to timeline $TLI, archive lag ${LAG_MS} ms"
  log "PITR drill OK"
else
  DETAIL="mismatch: rows=$ROWS_RESTORED/$ROWS_EXPECTED after=$AFTER_ROWS timeline=$TLI in_recovery=$IN_RECOVERY"
  exit 1
fi
