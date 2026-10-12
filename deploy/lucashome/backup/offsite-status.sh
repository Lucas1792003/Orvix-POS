#!/usr/bin/env bash
# offsite-status.sh — health of the offsite tier from offsite.json / status.json
# (no rclone calls: cheap enough for every 30 min). Problems: sync age per
# cadence (wal 30 min, dump 2 h, base 26 h, storage 7 h, bundle 26 h, check
# 50 h), failed last run, cryptcheck mismatches/errors, remote size vs
# OFFSITE_SIZE_WARN_GB / _HIGH_GB, offsite restore-test age (8 d) / failure,
# R2_TOKEN_EXPIRES within 14 d, rclone.conf presence/mode. Exit 1 on problems.
# backup-status.sh embeds this via --json; while OFFSITE_ENABLED != true the
# only output is "offsite: disabled" and the exit code is 0.
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"
# shellcheck source=offsite-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/offsite-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--json] [--quiet] [--help]
  --json    print {"enabled":bool,"lines":[...],"problems":[...]} (for backup-status.sh); exit code as usual
  --quiet   print nothing; summary still goes to $LOG_DIR/offsite-status.log
Thresholds (s): wal $MAX_AGE_OFFSITE_WAL_S  dump $MAX_AGE_OFFSITE_DUMP_S  base $MAX_AGE_OFFSITE_BASE_S  storage $MAX_AGE_OFFSITE_STORAGE_S  bundle $MAX_AGE_OFFSITE_BUNDLE_S  check $MAX_AGE_OFFSITE_CHECK_S  restore $MAX_AGE_OFFSITE_RESTORE_S
Size: warn > ${OFFSITE_SIZE_WARN_GB} GB, high > ${OFFSITE_SIZE_HIGH_GB} GB
EOF
}

JSON=0; QUIET=0
while (( $# )); do
  case "$1" in
    --json) JSON=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

init_logging
PROBLEMS=(); OUTPUT=()
say() { OUTPUT+=("$*"); }
epoch() { date -u -d "$1" +%s 2>/dev/null || echo 0; }
age_str() {
  local s="$1"
  if (( s >= 86400 )); then printf '%dd%02dh' $(( s / 86400 )) $(( (s % 86400) / 3600 ))
  elif (( s >= 3600 )); then printf '%dh%02dm' $(( s / 3600 )) $(( (s % 3600) / 60 ))
  else printf '%dm' $(( s / 60 )); fi
}
NOW=$(date -u +%s)

emit() {
  local rc="$1"
  if (( JSON )); then
    jq -nc --argjson en "$( offsite_enabled && echo true || echo false )" \
      --argjson lines "$(printf '%s\n' "${OUTPUT[@]}" | jq -R . | jq -sc .)" \
      --argjson problems "$(printf '%s\n' ${PROBLEMS[@]+"${PROBLEMS[@]}"} | grep -v '^$' | jq -R . | jq -sc .)" \
      '{enabled:$en, lines:$lines, problems:$problems}'
  elif (( ! QUIET )); then
    printf '%s\n' "${OUTPUT[@]}"
  fi
  printf '%s\n' "${OUTPUT[@]}" >>"$LOG_FILE"
  exit "$rc"
}

if ! offsite_enabled; then
  say "offsite: disabled (OFFSITE_ENABLED=${OFFSITE_ENABLED} in $BACKUP_ENV) — enable per OFFSITE-ENABLE.md"
  emit 0
fi

say "offsite: enabled  remote=$OFFSITE_REMOTE  config=$RCLONE_CONFIG  status=$OFFSITE_STATUS_FILE"
if [[ ! -f "$RCLONE_CONFIG" ]]; then PROBLEMS+=("offsite: rclone config $RCLONE_CONFIG missing")
elif [[ "$(stat -c %a "$RCLONE_CONFIG" 2>/dev/null)" != 600 ]]; then PROBLEMS+=("offsite: $RCLONE_CONFIG mode is not 600"); fi
command -v rclone >/dev/null 2>&1 || PROBLEMS+=("offsite: rclone not installed")
command -v age >/dev/null 2>&1 || PROBLEMS+=("offsite: age not installed (bundle job will fail closed)")
[[ -n "$AGE_RECIPIENT" ]] || PROBLEMS+=("offsite: AGE_RECIPIENT empty (bundle job will fail closed)")

printf -v hdr '%-9s %-7s %-20s %-8s %-8s %-10s %-6s %s' tier result last_success age objects bytes mism note
say "$hdr"
check_tier() {  # TIER MAX_S
  local tier="$1" max="$2" j last result objs bytes mism errs age note=""
  j="$(jq -c --arg t "$tier" '.jobs[$t] // {}' "$OFFSITE_STATUS_FILE" 2>/dev/null || echo '{}')"
  last="$(jq -r '.last_success // ""' <<<"$j")"; result="$(jq -r '.last_result // "never"' <<<"$j")"
  objs="$(jq -r '.objects // .total_objects // "-"' <<<"$j")"; bytes="$(jq -r '.bytes // .size_bytes // 0' <<<"$j")"
  mism="$(jq -r '.mismatches // 0' <<<"$j")"; errs="$(jq -r '.check_errors // 0' <<<"$j")"
  if [[ -z "$last" ]]; then
    age="-"; note="no successful run"; PROBLEMS+=("offsite $tier: no successful run recorded")
  else
    age=$(( NOW - $(epoch "$last") ))
    if (( age > max )); then PROBLEMS+=("offsite $tier: last success $(age_str "$age") ago (limit $(age_str "$max"))"); note="STALE"; fi
    age="$(age_str "$age")"
  fi
  [[ "$result" == fail ]] && { PROBLEMS+=("offsite $tier: last run failed: $(jq -r '.message // ""' <<<"$j")"); note="${note:+$note, }last run FAILED"; }
  if (( mism > 0 || errs > 0 )); then PROBLEMS+=("offsite $tier: verification mismatches=$mism errors=$errs (re-sync the prefix)"); note="${note:+$note, }CHECK"; fi
  [[ "$tier" == wal ]] && note="${note:+$note, }mode=$(jq -r '.mode // "-"' <<<"$j")"
  [[ "$tier" == check ]] && note="${note:+$note, }$(jq -r '(.prefixes // []) | join(" ")' <<<"$j") versions_pruned=$(jq -r '.versions_pruned // 0' <<<"$j")"
  printf -v line '%-9s %-7s %-20s %-8s %-8s %-10s %-6s %s' "$tier" "$result" "${last:--}" "$age" "$objs" "$(human "$bytes")" "$mism" "$note"
  say "$line"
}
check_tier wal "$MAX_AGE_OFFSITE_WAL_S"
check_tier dump "$MAX_AGE_OFFSITE_DUMP_S"
check_tier base "$MAX_AGE_OFFSITE_BASE_S"
check_tier storage "$MAX_AGE_OFFSITE_STORAGE_S"
check_tier bundle "$MAX_AGE_OFFSITE_BUNDLE_S"
check_tier check "$MAX_AGE_OFFSITE_CHECK_S"

# remote size (from the daily check job)
SIZE="$(jq -r '.jobs.check.size_bytes // 0' "$OFFSITE_STATUS_FILE" 2>/dev/null || echo 0)"
SIZE_GB=$(( SIZE / 1073741824 ))
WARN_B=$(( OFFSITE_SIZE_WARN_GB * 1073741824 )); HIGH_B=$(( OFFSITE_SIZE_HIGH_GB * 1073741824 ))
if (( SIZE > HIGH_B )); then PROBLEMS+=("offsite: remote size $(human "$SIZE") > ${OFFSITE_SIZE_HIGH_GB} GB (R2 free tier is 10 GB): shorten OFFSITE_VERSIONS_KEEP_DAYS / check WAL growth")
elif (( SIZE > WARN_B )); then PROBLEMS+=("offsite: remote size $(human "$SIZE") > ${OFFSITE_SIZE_WARN_GB} GB warning (doc 09)"); fi
say "remote size: $(human "$SIZE") (~${SIZE_GB} GB; warn ${OFFSITE_SIZE_WARN_GB} GB, high ${OFFSITE_SIZE_HIGH_GB} GB)  local bundles: $(find "$BUNDLE_DIR" -maxdepth 1 -name '*.tar.age' 2>/dev/null | wc -l)/$KEEP_BUNDLE"

# weekly restore from the remote
RT="$(jq -c '.jobs["offsite-restore-test"] // {}' "$STATUS_FILE" 2>/dev/null || echo '{}')"
RT_LAST="$(jq -r '.last_success // ""' <<<"$RT")"
if [[ -z "$RT_LAST" ]]; then
  PROBLEMS+=("offsite restore-test: no successful run recorded (run offsite-restore-test.sh by hand once)")
  say "offsite restore-test: never succeeded"
else
  RT_AGE=$(( NOW - $(epoch "$RT_LAST") ))
  (( RT_AGE > MAX_AGE_OFFSITE_RESTORE_S )) && PROBLEMS+=("offsite restore-test: last success $(age_str "$RT_AGE") ago (limit $(age_str "$MAX_AGE_OFFSITE_RESTORE_S"))")
  [[ "$(jq -r '.last_result // ""' <<<"$RT")" == fail ]] && PROBLEMS+=("offsite restore-test: last run failed")
  say "offsite restore-test: $(jq -r '"\(.last_run) result=\(.last_result) physical=\(.physical.result) logical=\(.logical.result) download=\(.download_s)s recovery=\(.recovery_s)s total=\(.total_s)s wal=\(.wal_segments) base=\(.base)"' <<<"$RT")"
fi

# optional token expiry
if [[ -n "$R2_TOKEN_EXPIRES" ]]; then
  EXP=$(epoch "$R2_TOKEN_EXPIRES")
  if (( EXP == 0 )); then PROBLEMS+=("offsite: R2_TOKEN_EXPIRES '$R2_TOKEN_EXPIRES' is not a date")
  elif (( EXP - NOW < 14 * 86400 )); then PROBLEMS+=("offsite: R2 token expires in $(( (EXP - NOW) / 86400 )) d ($R2_TOKEN_EXPIRES) — rotate (OFFSITE-ENABLE.md §9)"); fi
  say "r2 token expires: $R2_TOKEN_EXPIRES"
fi

if (( ${#PROBLEMS[@]} == 0 )); then say "offsite: OK"; emit 0; fi
say "offsite: PROBLEMS (${#PROBLEMS[@]})"
for p in "${PROBLEMS[@]}"; do say "  - $p"; done
emit 1
