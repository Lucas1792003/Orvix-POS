#!/usr/bin/env bash
# offsite-sync.sh — copy the local backup tiers to the encrypted offsite remote
# (rclone crypt remote "offsite", see OFFSITE-ENABLE.md). One tier per
# invocation so each cadence gets its own cron line, lock and log:
#
#   wal      */15 min   rclone copy --no-traverse of new segments (last $OFFSITE_WAL_COPY_MAX_AGE);
#                       once per $OFFSITE_WAL_FULL_EVERY_S (or --full) a full sync that applies the
#                       local WAL prune remotely.           -> offsite:wal/
#   dump     hourly     rclone sync of dump/{hourly,daily,weekly}   -> offsite:dump/   (no versioning)
#   base     daily      rclone sync --backup-dir .versions/base/<date>    -> offsite:base/
#   storage  6-hourly   rclone sync --backup-dir .versions/storage/<date> -> offsite:storage/
#   bundle   daily      secrets-bundle.sh, then sync --backup-dir .versions/bundle/<date> -> offsite:bundle/
#   check    daily      cryptcheck of every prefix, rclone size, prune .versions/ older than
#                       $OFFSITE_VERSIONS_KEEP_DAYS
#   all      by hand    every tier above in order (first sync)
#
# After every sync/copy the same prefix is verified with rclone cryptcheck
# (OFFSITE_CHECK). Results go to offsite.json (jobs.<tier>), the log to
# logs/offsite-<tier>.log, and healthchecks pings to HEALTHCHECKS_OFFSITE_URL
# (/start, then / or /fail). Exits 0 with "offsite disabled" unless
# OFFSITE_ENABLED=true in backup.env.
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"
# shellcheck source=offsite-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/offsite-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") TIER [--dry-run] [--full] [--no-check] [--no-build] [--help]
  TIER        wal | dump | base | storage | bundle | check | all
  --dry-run   rclone --dry-run everywhere; nothing is uploaded, deleted, pinged or recorded
  --full      wal: force the full sync (apply the local prune remotely) instead of the incremental copy
  --no-check  skip the post-sync cryptcheck
  --no-build  bundle: sync the existing bundles without building a new one
Config ($BACKUP_ENV): OFFSITE_ENABLED=$OFFSITE_ENABLED  OFFSITE_REMOTE=$OFFSITE_REMOTE  RCLONE_CONFIG=$RCLONE_CONFIG
  bwlimit=${OFFSITE_BWLIMIT:-off} transfers=$OFFSITE_TRANSFERS checkers=$OFFSITE_CHECKERS check=$OFFSITE_CHECK versions=${OFFSITE_VERSIONS_KEEP_DAYS}d
Sources: $BASE_DIR  $DUMP_DIR  $WAL_ARCHIVE_DIR  $STORAGE_DIR  $BUNDLE_DIR
EOF
}

TIER=""; FULL=0; DO_CHECK=1; BUILD=1
while (( $# )); do
  case "$1" in
    wal|dump|base|storage|bundle|check|all) [[ -z "$TIER" ]] || die "only one TIER"; TIER="$1" ;;
    --dry-run) DRY_RUN=1 ;;
    --full) FULL=1 ;;
    --no-check) DO_CHECK=0 ;;
    --no-build) BUILD=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done
[[ -n "$TIER" ]] || { usage >&2; die "TIER required"; }

JOB_NAME="offsite-$TIER"
init_logging
offsite_gate
acquire_lock
# shellcheck disable=SC2119
offsite_require_config
mkdir -p "$BUNDLE_DIR" && chmod 0700 "$BUNDLE_DIR"

START=$SECONDS
TODAY="$(date_utc)"
FAILED_TIERS=()
hc_ping "$HEALTHCHECKS_OFFSITE_URL" start

finish() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 || ${#FAILED_TIERS[@]} )); then
    log "FAILED (rc=$rc, failed tiers: ${FAILED_TIERS[*]:-none}) after $(( SECONDS - START ))s"
    hc_ping "$HEALTHCHECKS_OFFSITE_URL" fail "$LOG_FILE"
    exit 1
  fi
  log "done ($(( SECONDS - START ))s)"
  hc_ping "$HEALTHCHECKS_OFFSITE_URL" "" "$LOG_FILE"
}
trap finish EXIT

# record TIER RESULT MODE MESSAGE [extra json] — offsite.json jobs.<tier>
record() {
  local tier="$1" result="$2" mode="$3" msg="$4" extra="${5:-}" t sz
  [[ -n "$extra" ]] || extra='{}'
  t="$(utc_now)"
  sz="$(remote_size "$tier")"
  offsite_update "$tier" "$(jq -nc --arg t "$t" --arg r "$result" --arg mode "$mode" --arg m "$msg" \
      --argjson sz "$sz" --argjson extra "$extra" --argjson mism "$CHECK_MISMATCHES" --argjson errs "$CHECK_ERRORS" \
      --argjson dur "$(( SECONDS - T0 ))" --argjson warnings "$(warnings_json)" \
      '{last_run:$t, last_result:$r, mode:$mode, message:$m, duration_s:$dur, warnings:$warnings,
        objects:($sz.count // null), bytes:($sz.bytes // null), mismatches:$mism, check_errors:$errs}
       + $extra + (if $r=="ok" then {last_success:$t} else {} end)')"
}

# sync_prefix TIER SRC PREFIX [rclone flags...] — rclone sync + verify + record. Returns 1 on failure (caller collects).
sync_prefix() {
  local tier="$1" src="$2" prefix="$3"; shift 3
  T0=$SECONDS; CHECK_MISMATCHES=0; CHECK_ERRORS=0
  [[ -d "$src" ]] || { warn "$tier: source $src missing"; record "$tier" fail sync "source dir missing"; return 1; }
  log "$tier: sync $src -> ${OFFSITE_REMOTE}$prefix ($*)"
  if ! rc_mut sync "$src" "${OFFSITE_REMOTE}$prefix" "$@"; then
    record "$tier" fail sync "rclone sync failed (see $LOG_FILE)"; return 1
  fi
  # verify with the same filters the sync used (sync-only flags are dropped by offsite_check)
  if (( DO_CHECK )) && ! offsite_check "$src" "$prefix" "" "$@"; then
    record "$tier" fail sync "verification: $CHECK_MISMATCHES differences, $CHECK_ERRORS errors"; return 1
  fi
  record "$tier" ok sync "ok"
  log "$tier: ok ($(( SECONDS - T0 ))s)"
}

T0=$SECONDS

# ---------------------------------------------------------------------------
tier_wal() {
  local stamp="$LOCK_DIR/offsite-wal-full.stamp" mode=copy rc=0
  T0=$SECONDS; CHECK_MISMATCHES=0; CHECK_ERRORS=0
  [[ -d "$WAL_ARCHIVE_DIR" ]] || { record wal fail none "WAL archive $WAL_ARCHIVE_DIR missing"; return 1; }
  if (( FULL )) || [[ ! -f "$stamp" ]] || (( $(date +%s) - $(stat -c %Y "$stamp") > OFFSITE_WAL_FULL_EVERY_S )); then mode=sync; fi
  # Segments are immutable (archive_command never overwrites): --size-only + --use-server-modtime keep R2 to
  # LIST/PUT only (no per-object HEAD for modtimes). *.tmp are in-flight archive writes.
  local -a common=(--size-only --use-server-modtime --exclude '*.tmp' --exclude '*.partial')
  if [[ "$mode" == copy ]]; then
    log "wal: incremental copy (segments newer than $OFFSITE_WAL_COPY_MAX_AGE) -> ${OFFSITE_REMOTE}wal"
    rc_mut copy "$WAL_ARCHIVE_DIR" "${OFFSITE_REMOTE}wal" "${common[@]}" --no-traverse --ignore-existing --max-age "$OFFSITE_WAL_COPY_MAX_AGE" || rc=1
    if (( rc == 0 && DO_CHECK )); then
      offsite_check "$WAL_ARCHIVE_DIR" wal one-way --use-server-modtime --max-age "$OFFSITE_WAL_COPY_MAX_AGE" --exclude '*.tmp' --exclude '*.partial' || rc=1
    fi
  else
    log "wal: full sync (applies the local prune remotely; --min-age 10m leaves in-flight segments alone)"
    rc_mut sync "$WAL_ARCHIVE_DIR" "${OFFSITE_REMOTE}wal" "${common[@]}" --min-age 10m || rc=1
    if (( rc == 0 && DO_CHECK )); then
      offsite_check "$WAL_ARCHIVE_DIR" wal one-way --use-server-modtime --min-age 10m --exclude '*.tmp' --exclude '*.partial' || rc=1
    fi
    (( rc == 0 && ! DRY_RUN )) && touch "$stamp"
  fi
  if (( rc != 0 )); then record wal fail "$mode" "rclone $mode or verification failed ($CHECK_MISMATCHES differences, $CHECK_ERRORS errors)"; return 1; fi
  record wal ok "$mode" "ok" "$(jq -nc --arg s "$(find "$WAL_ARCHIVE_DIR" -maxdepth 1 -name '*.gz' | wc -l)" '{local_segments:($s|tonumber)}')"
  log "wal: ok mode=$mode ($(( SECONDS - T0 ))s)"
}

tier_dump() {
  # hard links in daily/weekly become separate objects; no --backup-dir (proposal §3.3)
  sync_prefix dump "$DUMP_DIR" dump --size-only --exclude '*.partial/**' --exclude '.*'
}

tier_base() {
  sync_prefix base "$BASE_DIR" base --size-only --exclude '*.partial/**' --exclude '.*' \
    --backup-dir "${OFFSITE_REMOTE}.versions/base/$TODAY"
}

tier_storage() {
  # live files, can change in place: default size+modtime comparison (one HEAD per same-size object on S3)
  sync_prefix storage "$STORAGE_DIR" storage --exclude '.gitkeep' \
    --backup-dir "${OFFSITE_REMOTE}.versions/storage/$TODAY"
}

tier_bundle() {
  if (( BUILD )); then
    log "bundle: building a fresh secrets bundle"
    if (( DRY_RUN )); then "$(bin_dir)/secrets-bundle.sh" --dry-run || { warn "secrets-bundle.sh --dry-run failed"; }
    else "$(bin_dir)/secrets-bundle.sh" || { T0=$SECONDS; record bundle fail build "secrets-bundle.sh failed (see $LOG_DIR/secrets-bundle.log)"; return 1; }
    fi
  fi
  sync_prefix bundle "$BUNDLE_DIR" bundle --size-only --include '*.tar.age' --exclude '*' \
    --backup-dir "${OFFSITE_REMOTE}.versions/bundle/$TODAY"
}

tier_check() {
  local rc=0 p mism=0 errs=0 pruned=0 cutoff sz d tier
  T0=$SECONDS
  local -a results=()
  for p in "base:$BASE_DIR:" "dump/daily:$DUMP_DIR/daily:" "dump/weekly:$DUMP_DIR/weekly:" "dump/hourly:$DUMP_DIR/hourly:" \
           "storage:$STORAGE_DIR:" "bundle:$BUNDLE_DIR:" "wal:$WAL_ARCHIVE_DIR:one-way"; do
    local prefix="${p%%:*}" rest="${p#*:}" src one
    src="${rest%:*}"; one="${rest##*:}"
    [[ -d "$src" ]] || { results+=("$prefix=skipped(no source)"); continue; }
    local -a f=(--exclude '*.partial/**' --exclude '.*' --exclude '*.tmp')
    [[ "$prefix" == wal ]] && f+=(--use-server-modtime --min-age 10m)
    [[ "$prefix" == storage ]] && f=(--exclude '.gitkeep')
    [[ "$prefix" == bundle ]] && f=(--include '*.tar.age' --exclude '*')
    if offsite_check "$src" "$prefix" "$one" "${f[@]}"; then results+=("$prefix=ok")
    else results+=("$prefix=DIFF($CHECK_MISMATCHES/$CHECK_ERRORS)"); mism=$(( mism + CHECK_MISMATCHES )); errs=$(( errs + CHECK_ERRORS )); rc=1; fi
  done
  # total size of the remote (one listing of everything)
  sz="$(remote_size "")"
  log "remote size: $(jq -r '"\(.count // "?") objects, \(.bytes // 0) bytes"' <<<"$sz") ($(human "$(jq -r '.bytes // 0' <<<"$sz")"))"
  # prune .versions/<tier>/<YYYYMMDD> older than OFFSITE_VERSIONS_KEEP_DAYS (by directory name: cheap, no HEADs)
  cutoff="$(days_before "$OFFSITE_VERSIONS_KEEP_DAYS")"
  for tier in base storage bundle; do
    while IFS= read -r d; do
      d="${d%/}"; [[ "$d" =~ ^[0-9]{8}$ ]] || continue
      if [[ "$d" < "$cutoff" ]]; then
        log "versions: purge ${OFFSITE_REMOTE}.versions/$tier/$d (older than $cutoff)"
        rc_mut purge "${OFFSITE_REMOTE}.versions/$tier/$d" || { warn "purge of .versions/$tier/$d failed"; rc=1; }
        pruned=$(( pruned + 1 ))
      fi
    done < <(rc_ro lsf --dirs-only "${OFFSITE_REMOTE}.versions/$tier/" 2>/dev/null || true)
  done
  CHECK_MISMATCHES=$mism; CHECK_ERRORS=$errs
  local extra
  extra="$(jq -nc --argjson sz "$sz" --argjson pruned "$pruned" --arg res "${results[*]}" \
    '{size_bytes:($sz.bytes // null), total_objects:($sz.count // null), versions_pruned:$pruned, prefixes:($res|split(" "))}')"
  if (( rc != 0 )); then record check fail check "verification differences=$mism errors=$errs (${results[*]})" "$extra"; return 1; fi
  record check ok check "ok (${results[*]})" "$extra"
  log "check: ok ($(( SECONDS - T0 ))s)"
}

# ---------------------------------------------------------------------------
run_tier() {
  local t="$1"
  "tier_$t" || FAILED_TIERS+=("$t")
}
log "start tier=$TIER remote=$OFFSITE_REMOTE dry_run=$DRY_RUN"
case "$TIER" in
  all) for t in "${OFFSITE_TIERS[@]}"; do run_tier "$t"; done ;;
  *) run_tier "$TIER" ;;
esac
(( ${#FAILED_TIERS[@]} == 0 )) || exit 1
