#!/usr/bin/env bash
# backup-prune.sh — apply retention to /srv/supabase/backups/{dump,base} and the WAL archive.
# Never deletes anything outside those trees. Called by the backup jobs after a
# successful run; can also be run by hand.
#
# WAL rule: every archived segment from the START WAL LOCATION of the OLDEST
# RETAINED base backup onwards is kept, so any retained base can be rolled
# forward to any later point (PITR). Only segments older than that are removed.
# With no base backup on disk nothing in the archive is touched.
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--job dump|base|wal|all] [--help]

Retention (from $BACKUP_ENV, env overrides):
  dump/hourly  keep newest $KEEP_HOURLY
  dump/daily   keep newest $KEEP_DAILY
  dump/weekly  keep newest $KEEP_WEEKLY
  base/        keep newest $KEEP_BASE
  wal archive  keep every segment >= the first segment the oldest retained base needs
               ($WAL_ARCHIVE_DIR; *.history always kept; stale *.tmp > 1 h removed)
Also removes *.partial directories older than 1 day (aborted runs).
Only paths under $DUMP_DIR, $BASE_DIR and $WAL_ARCHIVE_DIR are ever removed.
EOF
}

JOB=all
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --job) JOB="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

init_logging
require_dirs

# safe_rm PATH — refuses anything that does not resolve under DUMP_DIR/<class>/ or BASE_DIR/.
safe_rm() {
  local target real
  target="$1"
  real="$(realpath -e -- "$target")" || { warn "skip (cannot resolve) $target"; return 0; }
  case "$real" in
    "$DUMP_DIR"/*/*|"$BASE_DIR"/*) ;;
    *) die "refusing to delete $real: outside $DUMP_DIR/<class>/ and $BASE_DIR/" ;;
  esac
  [[ -d "$real" ]] || { warn "skip (not a directory) $real"; return 0; }
  log "delete $real ($(human "$(dir_bytes "$real")"))"
  run rm -rf -- "$real"
}

# prune_class DIR REGEX KEEP — keeps the KEEP newest (name-sorted) matching dirs.
prune_class() {
  local dir="$1" re="$2" keep="$3" n=0 d
  [[ -d "$dir" ]] || return 0
  mapfile -t victims < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' | { grep -E "$re" || true; } | LC_ALL=C sort -r | tail -n +$(( keep + 1 )))
  for d in "${victims[@]}"; do safe_rm "$dir/$d"; n=$(( n + 1 )); done
  # aborted runs: <ts>.partial older than a day
  mapfile -t stale < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mmin +1440 -printf '%P\n')
  for d in "${stale[@]}"; do safe_rm "$dir/$d"; n=$(( n + 1 )); done
  log "$dir: keep=$keep removed=$n remaining=$(find "$dir" -mindepth 1 -maxdepth 1 -type d | wc -l)"
}

# safe_rm_wal FILE — only regular files directly inside WAL_ARCHIVE_DIR with an archive file name.
safe_rm_wal() {
  local real
  real="$(realpath -e -- "$1")" || return 0
  case "$real" in
    "$WAL_ARCHIVE_DIR"/*) ;;
    *) die "refusing to delete $real: outside $WAL_ARCHIVE_DIR" ;;
  esac
  [[ "$(dirname "$real")" == "$WAL_ARCHIVE_DIR" && -f "$real" ]] || die "refusing to delete $real: not a file directly in the archive"
  [[ "$(basename "$real")" =~ ^[0-9A-F]{24}(\.[0-9A-F]{8}\.backup)?\.gz(\.tmp)?$ ]] || die "refusing to delete $real: unexpected name"
  run rm -f -- "$real"
}

prune_wal() {
  local oldest cutoff f name n=0 kept=0 b
  if [[ ! -d "$WAL_ARCHIVE_DIR" ]]; then log "wal archive $WAL_ARCHIVE_DIR not present; nothing to prune"; return 0; fi
  # the oldest RETAINED base backup (newest KEEP_BASE by name; identical in --dry-run, where victims still exist) decides the cutoff
  cutoff=""
  while read -r b; do
    [[ -n "$b" ]] || continue
    cutoff="$(base_start_wal_file "$BASE_DIR/$b")"
    if [[ -n "$cutoff" ]]; then oldest="$b"; break; fi
    warn "base $b has no readable start WAL segment; skipped when computing the WAL cutoff"
  done < <(find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' | { grep -E "$TS_RE" || true; } | LC_ALL=C sort -r | head -n "$KEEP_BASE" | LC_ALL=C sort)
  if [[ -z "$cutoff" ]]; then
    log "no base backup with a start segment on disk: WAL archive left untouched"
    return 0
  fi
  log "wal cutoff: keep >= $cutoff (first segment needed by the oldest retained base $oldest)"
  while IFS= read -r f; do
    name="$(basename "$f")"
    case "$name" in
      *.history.gz|*.history) kept=$(( kept + 1 )); continue ;;   # timeline history: tiny, always keep
      *.gz.tmp)
        if [[ -n "$(find "$f" -mmin +60)" ]]; then log "delete stale $name"; safe_rm_wal "$f"; n=$(( n + 1 )); fi
        continue ;;
    esac
    if [[ "$name" =~ ^([0-9A-F]{24})(\.[0-9A-F]{8}\.backup)?\.gz$ ]]; then
      if [[ "${BASH_REMATCH[1]}" < "$cutoff" ]]; then
        safe_rm_wal "$f"; n=$(( n + 1 ))
      else
        kept=$(( kept + 1 ))
      fi
    else
      warn "unexpected file in wal archive left alone: $name"
    fi
  done < <(find "$WAL_ARCHIVE_DIR" -mindepth 1 -maxdepth 1 -type f | LC_ALL=C sort)
  log "$WAL_ARCHIVE_DIR: removed=$n kept=$kept size=$(human "$(dir_bytes "$WAL_ARCHIVE_DIR")")"
}

case "$JOB" in dump|base|wal|all) ;; *) die "unknown --job $JOB" ;; esac
if [[ "$JOB" == dump || "$JOB" == all ]]; then
  prune_class "$DUMP_DIR/hourly" "$TS_RE" "$KEEP_HOURLY"
  prune_class "$DUMP_DIR/daily"  "$TS_RE" "$KEEP_DAILY"
  prune_class "$DUMP_DIR/weekly" "$WEEK_RE" "$KEEP_WEEKLY"
fi
if [[ "$JOB" == base || "$JOB" == all ]]; then
  prune_class "$BASE_DIR" "$TS_RE" "$KEEP_BASE"
  prune_wal     # the WAL cutoff follows the base retention, so always run it after base pruning
fi
if [[ "$JOB" == wal ]]; then
  prune_wal
fi
