#!/usr/bin/env bash
# offsite-restore-test.sh — weekly proof that the OFFSITE copy restores
# (proposal §7.1). Everything is pulled from the rclone remote, never from the
# local backup tree:
#  (a) physical+WAL: newest base/<ts>/ from offsite:base/ + every WAL segment
#      >= the first one that base needs from offsite:wal/ -> throwaway container
#      with recovery.signal, restore_command from the pulled archive, target
#      "latest" (replay everything, then promote); counts compared with the
#      newest hourly dump's counts.json (also pulled from offsite).
#  (b) logical: that pulled dump set restored into a vanilla initdb throwaway,
#      counts compared with its own counts.json (same drill as restore-test.sh).
# Wall times (download_s, recovery_s, logical_s, total_s) go to status.json job
# "offsite-restore-test" — the measured offsite RTO. Throwaways: --rm, no
# ports, --network none, --memory $THROWAWAY_MEMORY, removed by trap.
# Exits 0 with "offsite disabled" unless OFFSITE_ENABLED=true.
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"
# shellcheck source=offsite-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/offsite-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--physical-only|--logical-only] [--base TS] [--keep-on-failure] [--dry-run] [--help]
  --base TS           base backup <ts> on the remote to test (default: newest in ${OFFSITE_REMOTE}base/)
  --keep-on-failure   leave the throwaway container + temp dir in place for inspection (manual cleanup!)
  --dry-run           list what would be pulled (remote listings only); no download, no container
Results: $STATUS_FILE job "offsite-restore-test", $LOG_DIR/offsite-restore-test.log; pings HEALTHCHECKS_OFFSITE_RESTORE_URL.
EOF
}

DO_PHYSICAL=1; DO_LOGICAL=1; BASE_TS=""; KEEP_ON_FAILURE=0
while (( $# )); do
  case "$1" in
    --physical-only) DO_LOGICAL=0 ;;
    --logical-only) DO_PHYSICAL=0 ;;
    --base) BASE_TS="$2"; shift ;;
    --keep-on-failure) KEEP_ON_FAILURE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

init_logging
offsite_gate
acquire_lock
# shellcheck disable=SC2119
offsite_require_config
require_dirs
(( DRY_RUN )) || command -v docker >/dev/null 2>&1 || die "docker not found"

TS="$(ts_now)"
START=$SECONDS
P_RESULT=skipped; P_DETAIL=""; P_DUR=0; L_RESULT=skipped; L_DETAIL=""; L_DUR=0
DL_DUR=0; DL_BYTES=0; WAL_N=0; BASE_SRC=""; DUMP_SRC=""
PULL="$RESTORE_TEST_DIR/offsite-$TS"   # under RESTORE_TEST_DIR so tw_cleanup may remove it

ALLOWED_ERRORS=('role "[^"]+" already exists' 'extension "[^"]+" already exists' 'schema "public" already exists')

hc_ping "$HEALTHCHECKS_OFFSITE_RESTORE_URL" start

# shellcheck disable=SC2317,SC2329  # invoked by the EXIT trap
finish() {
  local rc=$?
  trap - EXIT
  local overall=ok
  [[ "$P_RESULT" == fail || "$L_RESULT" == fail ]] && overall=fail
  (( rc != 0 )) && overall=fail
  if (( KEEP_ON_FAILURE && rc != 0 )); then
    log "keeping $TW_NAME / $TW_DIR / $PULL for inspection (remove by hand)"
  else
    tw_cleanup || true
    if [[ -d "$PULL" ]]; then TW_DIR="$PULL"; TW_NAME=""; tw_cleanup || true; fi
  fi
  if (( ! DRY_RUN )); then
    status_update offsite-restore-test "$(jq -nc --arg t "$(utc_now)" --arg overall "$overall" \
      --arg pr "$P_RESULT" --arg pd "$P_DETAIL" --argjson pdur "$P_DUR" --arg lr "$L_RESULT" --arg ld "$L_DETAIL" --argjson ldur "$L_DUR" \
      --argjson dl "$DL_DUR" --argjson dlb "$DL_BYTES" --argjson waln "$WAL_N" --arg base "$BASE_SRC" --arg dump "$DUMP_SRC" \
      --argjson dur "$(( SECONDS - START ))" --argjson warnings "$(warnings_json)" --arg remote "$OFFSITE_REMOTE" \
      '{last_run:$t, last_result:$overall, duration_s:$dur, total_s:$dur, download_s:$dl, bytes_downloaded:$dlb, wal_segments:$waln,
        recovery_s:$pdur, logical_s:$ldur, remote:$remote, base:$base, dump:$dump, warnings:$warnings,
        physical:{result:$pr, detail:$pd, duration_s:$pdur}, logical:{result:$lr, detail:$ld, duration_s:$ldur}}
       + (if $overall=="ok" then {last_success:$t, message:"ok"} else {message:"failure, see offsite-restore-test.log"} end)')"
  fi
  log "offsite-restore-test finished: overall=$overall physical=$P_RESULT logical=$L_RESULT download=${DL_DUR}s total=$(( SECONDS - START ))s"
  if [[ "$overall" == ok ]]; then hc_ping "$HEALTHCHECKS_OFFSITE_RESTORE_URL" "" "$LOG_FILE"; exit 0
  else hc_ping "$HEALTHCHECKS_OFFSITE_RESTORE_URL" fail "$LOG_FILE"; exit 1; fi
}
trap finish EXIT

filter_errors() {  # FILE LABEL
  local file="$1" label="$2" line ok=0 allowed re
  while IFS= read -r line; do
    allowed=0
    for re in "${ALLOWED_ERRORS[@]}"; do [[ "$line" =~ $re ]] && { allowed=1; break; }; done
    if (( allowed )); then log "$label: allowed: ${line:0:200}"; else log "$label: UNEXPECTED: ${line:0:300}"; ok=1; fi
  done < <(grep -E 'ERROR:|FATAL:|PANIC:|^pg_restore: error' "$file" || true)
  return $ok
}

# ---------------------------------------------------------------------------
# 1. what is on the remote
# ---------------------------------------------------------------------------
newest_remote_dir() {  # PREFIX REGEX
  rc_ro lsf --dirs-only "${OFFSITE_REMOTE}$1" 2>/dev/null | sed 's#/$##' | { grep -E "$2" || true; } | LC_ALL=C sort | tail -n 1
}
if [[ -z "$BASE_TS" ]]; then BASE_TS="$(newest_remote_dir base/ "$TS_RE")"; fi
[[ -n "$BASE_TS" ]] || die "no base backup found under ${OFFSITE_REMOTE}base/"
DUMP_TS="$(newest_remote_dir dump/hourly/ "$TS_RE")"
[[ -n "$DUMP_TS" ]] || warn "no hourly dump under ${OFFSITE_REMOTE}dump/hourly/ — physical counts will be compared with the base's own counts.json; logical test skipped"
BASE_SRC="${OFFSITE_REMOTE}base/$BASE_TS"; [[ -n "$DUMP_TS" ]] && DUMP_SRC="${OFFSITE_REMOTE}dump/hourly/$DUMP_TS"
log "remote: base=$BASE_SRC dump=${DUMP_SRC:--}"

mkdir -p "$PULL" && chmod 0700 "$PULL"
T_DL=$SECONDS
rc_mut copy "$BASE_SRC" "$PULL/base" --size-only || die "could not pull $BASE_SRC"
if (( DRY_RUN )); then
  log "DRY-RUN: would pull $BASE_SRC, then every segment >= the base's first needed one from ${OFFSITE_REMOTE}wal/ ($(rc_ro lsf "${OFFSITE_REMOTE}wal/" 2>/dev/null | wc -l) objects there), then $DUMP_SRC"
  log "DRY-RUN: would restore base+WAL (target latest) and the dump into throwaways and compare counts"
  rm -rf -- "$PULL"; PULL=""
  P_RESULT=skipped; L_RESULT=skipped; exit 0
fi
verify_sha256sums "$PULL/base" || die "SHA256SUMS mismatch in the pulled base $BASE_TS"
NEED="$(first_archive_segment_needed "$PULL/base")"
[[ -n "$NEED" ]] || die "cannot determine the first WAL segment $BASE_TS needs"
log "base pulled and verified; archive needed from $NEED (method=$(jq -r .method "$PULL/base/backup.json"))"

# WAL: names >= NEED on the remote (+ timeline history files), pulled with --files-from-raw
mkdir -p "$PULL/wal"
rc_ro lsf "${OFFSITE_REMOTE}wal/" 2>/dev/null | LC_ALL=C sort >"$PULL/wal.list"
awk -v need="$NEED" '
  /^[0-9A-F]{8}\.history\.gz$/ {print; next}
  /^[0-9A-F]{24}(\.[0-9A-F]{8}\.backup)?\.gz$/ { if (substr($0,1,24) >= need) print }' "$PULL/wal.list" >"$PULL/wal.pull"
WAL_N="$(grep -cE '^[0-9A-F]{24}\.gz$' "$PULL/wal.pull" || true)"
(( WAL_N > 0 )) || warn "no archived segment >= $NEED on the remote yet (base carries its own WAL; recovery ends at the base's stop point)"
if [[ -s "$PULL/wal.pull" ]]; then
  rc_mut copy "${OFFSITE_REMOTE}wal/" "$PULL/wal" --size-only --files-from-raw "$PULL/wal.pull" --no-traverse || die "could not pull WAL from ${OFFSITE_REMOTE}wal/"
fi
GAPS="$(grep -E '^[0-9A-F]{24}\.gz$' "$PULL/wal.pull" | sed 's/\.gz$//' | wal_gaps)"
[[ -z "$GAPS" ]] || { P_RESULT=fail; P_DETAIL="WAL gaps on the remote: $GAPS"; die "WAL sequence on the remote has gaps: $GAPS"; }
if (( WAL_N > 0 )) && [[ ! -f "$PULL/wal/$NEED.gz" ]]; then
  P_RESULT=fail; P_DETAIL="remote archive lacks $NEED"; die "remote archive lacks $NEED, the first segment $BASE_TS needs (PITR chain broken offsite)"
fi
if [[ -n "$DUMP_SRC" ]]; then
  rc_mut copy "$DUMP_SRC" "$PULL/dump" --size-only || die "could not pull $DUMP_SRC"
  verify_sha256sums "$PULL/dump" || die "SHA256SUMS mismatch in the pulled dump $DUMP_TS"
fi
DL_DUR=$(( SECONDS - T_DL )); DL_BYTES="$(dir_bytes "$PULL")"
chmod -R u+rwX,go-rwx "$PULL" 2>/dev/null || true
log "download done: $(human "$DL_BYTES") in ${DL_DUR}s (base $BASE_TS, $WAL_N WAL segments$( [[ -n "$GAPS" ]] || echo ', no gaps'), dump ${DUMP_TS:--})"

# ---------------------------------------------------------------------------
# 2. physical + WAL replay to "latest"
# ---------------------------------------------------------------------------
physical_test() {
  local t0=$SECONDS src="$PULL/base" method expected actual pgdata table
  method="$(jq -r .method "$src/backup.json")"
  TW_NAME="sb-restore-test-offsite-physical-$TS"; TW_DIR="$RESTORE_TEST_DIR/offsite-physical-$TS"
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
  : >"$pgdata/recovery.signal"
  cat >>"$pgdata/postgresql.auto.conf" <<EOF
# --- offsite-restore-test.sh $TS (target: latest = end of the pulled archive)
restore_command = 'gzip -dc /wal_archive/%f.gz > %p'
recovery_target_action = 'promote'
EOF
  [[ -f "$src/pgsodium_root.key" ]] && cp "$src/pgsodium_root.key" "$TW_DIR/pgsodium_root.key"
  chmod 0700 "$pgdata"
  log "PGDATA extracted ($(human "$(dir_bytes "$pgdata")")), archive mounted read-only from $PULL/wal"
  TW_EXTRA_ARGS=(-v "$PULL/wal:/wal_archive:ro")
  tw_start physical
  tw_wait_ready physical || { P_RESULT=fail; P_DETAIL="restored cluster did not start"; return 1; }
  TW_EXTRA_ARGS=()
  log "throwaway ready after $(( SECONDS - t0 ))s; recovery lines:"
  grep -E 'backup recovery|restored log file|archive recovery complete|selected new timeline|redo done|consistent recovery state|ready to accept' "$TW_DIR/postgres.log" | sed 's/^/  pg: /' | tee -a "$LOG_FILE" >&2 || true
  grep -q 'completed backup recovery' "$TW_DIR/postgres.log" || { P_RESULT=fail; P_DETAIL="no 'completed backup recovery' line"; return 1; }
  local restored
  restored="$(grep -c 'restored log file' "$TW_DIR/postgres.log" || true)"
  if (( WAL_N > 0 )) && (( restored == 0 )); then warn "no segment was restored from the pulled archive (restore_command never succeeded?)"; fi
  if (( WAL_N > 0 )) && ! grep -q 'archive recovery complete' "$TW_DIR/postgres.log"; then
    P_RESULT=fail; P_DETAIL="no 'archive recovery complete' line (WAL replay from the offsite archive did not finish)"; return 1
  fi
  if [[ -n "$DUMP_SRC" ]]; then expected="$(cat "$PULL/dump/counts.json")"; log "comparing with the newest hourly dump's counts ($DUMP_TS)"
  else expected="$(cat "$src/counts.json")"; log "comparing with the base's own counts"; fi
  actual="$(tw_psql postgres -c "$COUNTS_SQL")" || { P_RESULT=fail; P_DETAIL="count query failed"; return 1; }
  log "restored counts: $(jq -c 'del(.captured_at)' <<<"$actual")"
  if table="$(compare_counts "$expected" "$actual")"; then log "count comparison:"$'\n'"$table"
  else log "count comparison:"$'\n'"$table"; P_RESULT=fail; P_DETAIL="count mismatch vs ${DUMP_TS:-base}"; return 1; fi
  local tli
  tli="$(tw_psql postgres -c "select timeline_id from pg_control_checkpoint()")"
  P_RESULT=ok; P_DETAIL="backup recovery + $restored archived segment(s) replayed from offsite, promoted to timeline $tli, counts match"
  P_DUR=$(( SECONDS - t0 ))
  log "physical restore from offsite OK (${P_DUR}s)"
  tw_cleanup
}

# ---------------------------------------------------------------------------
# 3. logical: the pulled dump set into a vanilla initdb
# ---------------------------------------------------------------------------
logical_test() {
  local t0=$SECONDS src="$PULL/dump" expected actual stderr table sb_ok
  TW_NAME="sb-restore-test-offsite-logical-$TS"; TW_DIR="$RESTORE_TEST_DIR/offsite-logical-$TS"
  mkdir -p "$TW_DIR" && chmod 0700 "$TW_DIR"
  cp "$src"/{globals.sql,db-settings.sql,postgres.dump,_supabase.dump} "$TW_DIR/"
  [[ -f "$PULL/base/pgsodium_root.key" ]] && cp "$PULL/base/pgsodium_root.key" "$TW_DIR/"
  chmod 0600 "$TW_DIR"/*
  expected="$(cat "$src/counts.json")"
  tw_start logical
  tw_wait_ready logical || { L_RESULT=fail; L_DETAIL="throwaway (vanilla initdb) did not start"; return 1; }
  stderr="$TW_DIR/restore.err"; : >"$stderr"
  docker exec "$TW_NAME" psql -X -U "$DB_ADMIN_USER" -d postgres -q -f /restore/globals.sql >/dev/null 2>>"$stderr" || true
  docker exec "$TW_NAME" pg_restore -U "$DB_ADMIN_USER" -d postgres /restore/postgres.dump 2>>"$stderr" || true
  docker exec "$TW_NAME" pg_restore -U "$DB_ADMIN_USER" -d postgres --create /restore/_supabase.dump 2>>"$stderr" || true
  docker exec "$TW_NAME" psql -X -U "$DB_ADMIN_USER" -d postgres -q -f /restore/db-settings.sql >/dev/null 2>>"$stderr" || true
  filter_errors "$stderr" logical || { L_RESULT=fail; L_DETAIL="unexpected restore errors (see log)"; return 1; }
  actual="$(tw_psql postgres -c "$COUNTS_SQL")" || { L_RESULT=fail; L_DETAIL="count query failed"; return 1; }
  if table="$(compare_counts "$expected" "$actual")"; then log "count comparison:"$'\n'"$table"
  else log "count comparison:"$'\n'"$table"; L_RESULT=fail; L_DETAIL="count mismatch"; return 1; fi
  sb_ok="$(tw_psql _supabase -c "select count(*) from pg_namespace where nspname in ('_analytics','_supavisor')")"
  (( sb_ok == 2 )) || { L_RESULT=fail; L_DETAIL="_supabase schemas missing"; return 1; }
  L_RESULT=ok; L_DETAIL="counts match; all restore errors allow-listed"
  L_DUR=$(( SECONDS - t0 ))
  log "logical restore from offsite OK (${L_DUR}s)"
  tw_cleanup
}

RC=0
if (( DO_PHYSICAL )); then
  physical_test || { RC=1; log "physical restore from offsite FAILED: $P_DETAIL"; (( KEEP_ON_FAILURE )) || tw_cleanup || true; }
fi
if (( DO_LOGICAL )); then
  if [[ -n "$DUMP_SRC" ]]; then
    logical_test || { RC=1; log "logical restore from offsite FAILED: $L_DETAIL"; (( KEEP_ON_FAILURE )) || tw_cleanup || true; }
  else
    L_RESULT=skipped; L_DETAIL="no hourly dump on the remote"
  fi
fi
exit $RC
