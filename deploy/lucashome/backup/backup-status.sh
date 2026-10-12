#!/usr/bin/env bash
# backup-status.sh — one-screen backup health summary and the failure-detection hook.
# Exit 1 when any job's last success is older than its threshold (logical 2 h,
# base 26 h, restore-test 8 d), when the last run of a job failed, when free
# space is low, when leftovers (throwaway containers, sb_backup_* slots) exist,
# or when WAL archiving is off / failing / lagging (> 10 min) / has gaps.
# Pings $HEALTHCHECKS_URL (success) or $HEALTHCHECKS_URL/fail when configured.
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--quiet] [--no-db] [--help]
  --quiet   print nothing on stdout; the summary still goes to $LOG_DIR/backup-status.log
  --no-db   skip the replication-slot check (does not touch the db container)
Thresholds: logical ${MAX_AGE_LOGICAL_S}s, base ${MAX_AGE_BASE_S}s, restore-test ${MAX_AGE_RESTORE_S}s, archive lag ${MAX_ARCHIVE_LAG_S}s, min free ${MIN_FREE_GB} GB
EOF
}

QUIET=0; CHECK_DB=1
while (( $# )); do
  case "$1" in
    --quiet) QUIET=1 ;;
    --no-db) CHECK_DB=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

init_logging
PROBLEMS=()
OUTPUT=()
say() { OUTPUT+=("$*"); }

epoch() { date -u -d "$1" +%s 2>/dev/null || echo 0; }
age_str() {  # seconds -> "1h02m" / "3d04h"
  local s="$1"
  if (( s >= 86400 )); then printf '%dd%02dh' $(( s / 86400 )) $(( (s % 86400) / 3600 ))
  elif (( s >= 3600 )); then printf '%dh%02dm' $(( s / 3600 )) $(( (s % 3600) / 60 ))
  else printf '%dm' $(( s / 60 )); fi
}

NOW=$(date -u +%s)
say "Supabase backups on $(hostname) — $(utc_now)"
say "root: $BACKUP_ROOT   status: $STATUS_FILE"
say ""
printf -v hdr '%-13s %-9s %-20s %-8s %-10s %-9s %s' job result last_success age size dur note
say "$hdr"

check_job() {  # NAME THRESHOLD_S
  local job="$1" max="$2" j last result size dur age note="" warnings
  j="$(jq -c --arg j "$job" '.jobs[$j] // {}' "$STATUS_FILE" 2>/dev/null || echo '{}')"
  last="$(jq -r '.last_success // ""' <<<"$j")"
  result="$(jq -r '.last_result // "never"' <<<"$j")"
  size="$(jq -r '.size_bytes // empty' <<<"$j")"
  dur="$(jq -r '.duration_s // empty' <<<"$j")"
  warnings="$(jq -r '(.warnings // []) | length' <<<"$j")"
  if [[ -z "$last" ]]; then
    age="-"; note="no successful run recorded"; PROBLEMS+=("$job: no successful run")
  else
    age=$(( NOW - $(epoch "$last") ))
    if (( age > max )); then PROBLEMS+=("$job: last success $(age_str "$age") ago (limit $(age_str "$max"))"); note="STALE"; fi
    age="$(age_str "$age")"
  fi
  if [[ "$result" == fail ]]; then PROBLEMS+=("$job: last run failed: $(jq -r '.message // ""' <<<"$j")"); note="${note:+$note, }last run FAILED"; fi
  (( warnings > 0 )) && note="${note:+$note, }$warnings warning(s)"
  if [[ "$job" == restore-test ]]; then
    note="${note:+$note, }logical=$(jq -r '.logical.result // "-"' <<<"$j") physical=$(jq -r '.physical.result // "-"' <<<"$j")"
  elif [[ "$job" == base ]]; then
    note="${note:+$note, }method=$(jq -r '.method // "-"' <<<"$j")"
  fi
  printf -v line '%-13s %-9s %-20s %-8s %-10s %-9s %s' "$job" "$result" "${last:--}" "$age" "$(human "${size:-0}")" "${dur:+${dur}s}" "$note"
  say "$line"
}

check_job logical "$MAX_AGE_LOGICAL_S"
check_job base "$MAX_AGE_BASE_S"
check_job restore-test "$MAX_AGE_RESTORE_S"
say ""

# on-disk inventory
count_dirs() { find "$1" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l; }
say "dump/hourly: $(count_dirs "$DUMP_DIR/hourly")/$KEEP_HOURLY  daily: $(count_dirs "$DUMP_DIR/daily")/$KEEP_DAILY  weekly: $(count_dirs "$DUMP_DIR/weekly")/$KEEP_WEEKLY  base: $(count_dirs "$BASE_DIR")/$KEEP_BASE"
say "disk used: dump $(human "$(dir_bytes "$DUMP_DIR")")  base $(human "$(dir_bytes "$BASE_DIR")")  total $(human "$(dir_bytes "$BACKUP_ROOT")")"
FREE_KB="$(df -Pk "$BACKUP_ROOT" | awk 'NR==2 {print $4}')"
FREE_GB=$(( FREE_KB / 1024 / 1024 ))
say "free space on $BACKUP_ROOT: ${FREE_GB} GB (min ${MIN_FREE_GB} GB)"
(( FREE_GB >= MIN_FREE_GB )) || PROBLEMS+=("free space ${FREE_GB} GB < ${MIN_FREE_GB} GB")

# leftovers
LEFT="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^sb-restore-test' | tr '\n' ' ' || true)"
[[ -n "$LEFT" ]] && PROBLEMS+=("leftover throwaway containers: $LEFT")
LEFT_DIRS="$(find "$RESTORE_TEST_DIR" -mindepth 1 -maxdepth 1 -type d -mmin +360 -printf '%P ' 2>/dev/null || true)"
[[ -n "$LEFT_DIRS" ]] && PROBLEMS+=("stale restore-test dirs (>6 h): $LEFT_DIRS")
if (( CHECK_DB )); then
  SLOTS="$(db_psql postgres -c "select string_agg(slot_name, ' ') from pg_replication_slots where slot_name like 'sb\\_backup\\_%'" 2>/dev/null || echo "query-failed")"
  if [[ "$SLOTS" == query-failed ]]; then PROBLEMS+=("could not query the db container for leftover replication slots")
  elif [[ -n "$SLOTS" ]]; then PROBLEMS+=("leftover replication slots pinning WAL: $SLOTS"); fi
fi

# WAL archive: archiver health (lag, failures), on-disk inventory, sequence gaps
say ""
ARCH="$(archiver_json)"
if [[ -z "$ARCH" ]]; then
  (( CHECK_DB )) && PROBLEMS+=("could not query pg_stat_archiver")
  say "wal archive: (db not queried)"
else
  a_mode="$(jq -r .archive_mode <<<"$ARCH")"; a_last="$(jq -r '.last_archived_wal // "-"' <<<"$ARCH")"
  a_age="$(jq -r .last_archived_age_s <<<"$ARCH")"; a_pending="$(jq -r .pending <<<"$ARCH")"
  a_pend_age="$(jq -r .oldest_pending_age_s <<<"$ARCH")"; a_fail="$(jq -r '.last_failed_wal // ""' <<<"$ARCH")"
  a_fail_after="$(jq -r .failed_after_success <<<"$ARCH")"; a_cur="$(jq -r .current_wal <<<"$ARCH")"
  a_cnt="$(jq -r .archived_count <<<"$ARCH")"; a_fcnt="$(jq -r .failed_count <<<"$ARCH")"
  a_note=""
  if [[ "$a_mode" != on ]]; then
    PROBLEMS+=("archive_mode is '$a_mode' (expected on)")
  else
    if [[ "$a_fail_after" == true ]]; then
      PROBLEMS+=("WAL archiving failing: last_failed_wal=$a_fail (failed_count=$a_fcnt) newer than the last success")
    elif [[ -n "$a_fail" ]]; then
      a_note="old failure on record ($a_fail; later successes) - reset with pg_stat_reset_shared('archiver')"
    fi
    if (( a_pending > 0 && a_pend_age > MAX_ARCHIVE_LAG_S )); then
      PROBLEMS+=("archive lag: $a_pending segment(s) waiting, oldest ${a_pend_age}s > ${MAX_ARCHIVE_LAG_S}s")
    elif (( a_age >= 0 && a_age > MAX_ARCHIVE_LAG_S )); then
      if (( a_pending > 0 )); then PROBLEMS+=("archive lag: last_archived_time $(age_str "$a_age") ago with $a_pending pending")
      else a_note="${a_note:+$a_note; }idle: last archive $(age_str "$a_age") ago, nothing pending (archive_timeout only switches after activity)"; fi
    elif (( a_age < 0 )); then
      PROBLEMS+=("archive_mode on but nothing archived yet")
    fi
  fi
  say "wal archive: mode=$a_mode last=$a_last ($( (( a_age >= 0 )) && age_str "$a_age" || echo never) ago) current=$a_cur pending=$a_pending archived=$a_cnt failed=$a_fcnt${a_note:+  [$a_note]}"
fi
if [[ -d "$WAL_ARCHIVE_DIR" ]]; then
  W_COUNT="$(find "$WAL_ARCHIVE_DIR" -maxdepth 1 -name '*.gz' | wc -l)"
  W_FIRST="$(find "$WAL_ARCHIVE_DIR" -maxdepth 1 -name '*.gz' -printf '%f\n' | grep -E '^[0-9A-F]{24}\.gz$' | LC_ALL=C sort | head -n 1)"
  W_LAST="$(find "$WAL_ARCHIVE_DIR" -maxdepth 1 -name '*.gz' -printf '%f\n' | grep -E '^[0-9A-F]{24}\.gz$' | LC_ALL=C sort | tail -n 1)"
  say "wal archive dir: $WAL_ARCHIVE_DIR  files=$W_COUNT  size=$(human "$(dir_bytes "$WAL_ARCHIVE_DIR")")  range=${W_FIRST%.gz}..${W_LAST%.gz}"
  GAPS="$(find "$WAL_ARCHIVE_DIR" -maxdepth 1 -name '*.gz' -printf '%f\n' | grep -E '^[0-9A-F]{24}\.gz$' | python3 -I -c '
import sys
names = sorted(l.strip()[:24] for l in sys.stdin if l.strip())
if names:
    tl = names[-1][:8]
    segs = [n for n in names if n.startswith(tl)]
    idx = [int(n[8:16], 16) * 256 + int(n[16:24], 16) for n in segs]   # 256 segments per 4 GB log at wal_segment_size=16MB
    gaps = [f"{segs[i]}..{segs[i+1]}" for i in range(len(idx) - 1) if idx[i+1] - idx[i] != 1]
    print(" ".join(gaps))
')"
  [[ -n "$GAPS" ]] && PROBLEMS+=("WAL archive has gaps (PITR chain broken): $GAPS")
  OLDEST_BASE="$(find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' | grep -E "$TS_RE" | LC_ALL=C sort | head -n 1 || true)"
  if [[ -n "$OLDEST_BASE" ]]; then
    NEED="$(first_archive_segment_needed "$BASE_DIR/$OLDEST_BASE")"
    if [[ -n "$NEED" && ! -f "$WAL_ARCHIVE_DIR/$NEED.gz" ]]; then
      if [[ "$NEED" > "${W_LAST%.gz}" ]]; then
        say "oldest retained base $OLDEST_BASE carries its own WAL up to $(jq -r '.wal_files|last' "$BASE_DIR/$OLDEST_BASE/backup.json"); archive continues from $NEED (not produced yet)"
      else
        PROBLEMS+=("archive does not contain $NEED, the first segment the oldest retained base ($OLDEST_BASE) needs from it (PITR chain broken)")
      fi
    else
      say "oldest retained base $OLDEST_BASE needs the archive from ${NEED:-?} -> present (prune keeps >= $(base_start_wal_file "$BASE_DIR/$OLDEST_BASE"))"
    fi
  fi
else
  say "wal archive dir: $WAL_ARCHIVE_DIR missing"
fi
PITR="$(jq -c '.jobs["pitr-test"] // empty' "$STATUS_FILE" 2>/dev/null || true)"
if [[ -n "$PITR" ]]; then
  say "last PITR drill: $(jq -r '"\(.last_run) result=\(.last_result) rows_at_target=\(.rows_restored)/\(.rows_expected) archive_lag_ms=\(.archive_lag_ms) base=\(.base)"' <<<"$PITR")"
  [[ "$(jq -r .last_result <<<"$PITR")" == fail ]] && PROBLEMS+=("last PITR drill failed")
fi

# offsite tier (Phase F): lines + problems from offsite-status.sh; one "disabled" line while OFFSITE_ENABLED != true
if [[ -x "$(bin_dir)/offsite-status.sh" ]]; then
  say ""
  OFF="$("$(bin_dir)/offsite-status.sh" --json 2>/dev/null || true)"
  if [[ -n "$OFF" ]] && jq -e . <<<"$OFF" >/dev/null 2>&1; then
    while IFS= read -r l; do say "$l"; done < <(jq -r '.lines[]' <<<"$OFF")
    while IFS= read -r p; do [[ -n "$p" ]] && PROBLEMS+=("$p"); done < <(jq -r '.problems[]' <<<"$OFF")
  else
    say "offsite: offsite-status.sh --json produced no output"
    PROBLEMS+=("offsite-status.sh --json failed (see $LOG_DIR/offsite-status.log)")
  fi
fi

say ""
if (( ${#PROBLEMS[@]} == 0 )); then
  say "STATUS: OK"
  RC=0
else
  say "STATUS: PROBLEMS (${#PROBLEMS[@]})"
  for p in "${PROBLEMS[@]}"; do say "  - $p"; done
  RC=1
fi

printf '%s\n' "${OUTPUT[@]}" >>"$LOG_FILE"
(( QUIET )) || printf '%s\n' "${OUTPUT[@]}"

status_update status "$(jq -nc --arg t "$(utc_now)" --argjson rc "$RC" --argjson problems "$(printf '%s\n' "${PROBLEMS[@]:-}" | grep -v '^$' | jq -R . | jq -sc .)" \
  '{last_run:$t, last_result:(if $rc==0 then "ok" else "fail" end), problems:$problems}')"

if [[ -n "$HEALTHCHECKS_URL" ]]; then
  url="$HEALTHCHECKS_URL"; (( RC == 0 )) || url="$HEALTHCHECKS_URL/fail"
  curl -fsS -m 10 --retry 3 -o /dev/null --data-binary "$(printf '%s\n' "${OUTPUT[@]}" | tail -n 20)" "$url" \
    || log "healthchecks ping failed"
fi
exit $RC
