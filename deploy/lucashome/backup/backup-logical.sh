#!/usr/bin/env bash
# backup-logical.sh — hourly logical backup of the self-hosted Supabase database.
#   globals.sql      pg_dumpall --roles-only (roles, memberships, role settings)
#   db-settings.sql  ALTER DATABASE ... SET statements (database-level GUCs)
#   postgres.dump    pg_dump -Fc --create of the `postgres` database (all schemas)
#   _supabase.dump   pg_dump -Fc --create of the `_supabase` database
#   counts.json      consistency counts captured just before the dump
#   meta.json        timings, sizes, TOC entry counts, warnings
#   SHA256SUMS
# Written to $DUMP_DIR/hourly/<UTC ts>/ (0600 files in 0700 dirs). The first
# successful run of a UTC day is hard-linked into dump/daily/, the first of an
# ISO week into dump/weekly/. Retention is applied by backup-prune.sh.
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--no-prune] [--help]
  --dry-run   show what would be done; nothing is written
  --no-prune  skip the retention pass at the end
Output: $DUMP_DIR/hourly/<ts>/  (promoted to daily/ and weekly/ when first of the period)
EOF
}

PRUNE=1
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-prune) PRUNE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

init_logging
acquire_lock
require_dirs

TS="$(ts_now)"
FINAL="$DUMP_DIR/hourly/$TS"
OUT="$FINAL.partial"
START=$SECONDS

cleanup() {
  local rc=$?
  if (( rc != 0 )); then
    log "FAILED (rc=$rc) after $(( SECONDS - START ))s"
    [[ -d "$OUT" ]] && rm -rf -- "$OUT"
    (( DRY_RUN )) || status_update logical "$(jq -nc --arg t "$(utc_now)" --arg m "exit $rc, see $LOG_FILE" \
      '{last_run:$t,last_result:"fail",message:$m}')"
  fi
}
trap cleanup EXIT

log "start logical backup -> $FINAL"
if (( DRY_RUN )); then
  log "DRY-RUN: would run pg_dumpall --roles-only, pg_dump -Fc --create postgres, pg_dump -Fc --create _supabase"
  log "DRY-RUN: would verify with pg_restore -l, write SHA256SUMS, promote to daily/weekly if first of period"
  exit 0
fi

mkdir -p "$OUT" && chmod 0700 "$OUT"

# 1. counts recorded at backup time (compared after restores)
db_psql postgres -c "$COUNTS_SQL" >"$OUT/counts.json"
jq -e . "$OUT/counts.json" >/dev/null || die "counts.json is not valid JSON"
log "counts: $(jq -c 'del(.captured_at)' "$OUT/counts.json")"

# 2. globals (roles) and database-level settings
db_exec pg_dumpall -U "$DB_ADMIN_USER" --roles-only >"$OUT/globals.sql"
db_psql postgres -c "select coalesce(string_agg(stmt, E'\n' order by stmt), '-- (no database-level settings)') from (
  select case when s.setrole = 0
    then format('ALTER DATABASE %I SET %I = %L;', d.datname, split_part(c, '=', 1), substr(c, strpos(c, '=') + 1))
    else format('ALTER ROLE %I IN DATABASE %I SET %I = %L;', r.rolname, d.datname, split_part(c, '=', 1), substr(c, strpos(c, '=') + 1)) end as stmt
  from pg_db_role_setting s
  join pg_database d on d.oid = s.setdatabase
  left join pg_roles r on r.oid = s.setrole,
  unnest(s.setconfig) c
  where s.setdatabase <> 0) x;" >"$OUT/db-settings.sql"

# 3. custom-format dumps
for db in postgres _supabase; do
  f="$OUT/$db.dump"
  db_exec pg_dump -U "$DB_ADMIN_USER" -Fc --create -d "$db" >"$f"
  [[ -s "$f" ]] || die "empty dump for $db"
done
chmod 0600 "$OUT"/*

# 4. integrity: pg_restore --list (inside the db container, archive on stdin) must list >0 TOC entries
declare -A TOC
for db in postgres _supabase; do
  f="$OUT/$db.dump"
  n="$(db_exec_stdin pg_restore -l <"$f" | grep -cE '^[0-9]+;' || true)"
  (( n > 0 )) || die "pg_restore -l listed no TOC entries for $f"
  TOC[$db]=$n
  log "$db.dump: $(human "$(stat -c %s "$f")"), $n TOC entries"
done

# 5. size sanity vs previous run
SIZE="$(dir_bytes "$OUT")"
PREV="$(latest_dir "$DUMP_DIR/hourly" "$TS_RE")"
if [[ -n "$PREV" && -f "$DUMP_DIR/hourly/$PREV/meta.json" ]]; then
  PREV_SIZE="$(jq -r '.size_bytes // 0' "$DUMP_DIR/hourly/$PREV/meta.json")"
  if (( PREV_SIZE > 0 )); then
    PCT=$(( (SIZE - PREV_SIZE) * 100 / PREV_SIZE ))
    if (( PCT > SIZE_WARN_PCT || PCT < -SIZE_WARN_PCT )); then
      warn "size changed ${PCT}% vs previous run $PREV ($(human "$PREV_SIZE") -> $(human "$SIZE"))"
    fi
  fi
fi

# 6. metadata + checksums, then make the directory final
DURATION=$(( SECONDS - START ))
jq -n --arg ts "$TS" --arg at "$(utc_now)" --argjson size "$SIZE" --argjson dur "$DURATION" \
  --argjson toc_pg "${TOC[postgres]}" --argjson toc_sb "${TOC[_supabase]}" --argjson warnings "$(warnings_json)" \
  '{ts:$ts, completed_at:$at, size_bytes:$size, duration_s:$dur,
    toc_entries:{postgres:$toc_pg, _supabase:$toc_sb}, warnings:$warnings,
    files:["globals.sql","db-settings.sql","postgres.dump","_supabase.dump","counts.json"]}' >"$OUT/meta.json"
chmod 0600 "$OUT/meta.json"
write_sha256sums "$OUT"
mv "$OUT" "$FINAL"
log "hourly backup complete: $FINAL ($(human "$SIZE"), ${DURATION}s)"

# 7. promotion (hard links: no extra space, independent directory lifetimes)
DAY="${TS:0:8}"
if ! compgen -G "$DUMP_DIR/daily/${DAY}T*" >/dev/null; then
  cp -al "$FINAL" "$DUMP_DIR/daily/$TS" && log "promoted to daily/$TS"
fi
WEEK="$(date -u -d "${DAY:0:4}-${DAY:4:2}-${DAY:6:2}" +%G-W%V)"
if ! compgen -G "$DUMP_DIR/weekly/${WEEK}_*" >/dev/null; then
  cp -al "$FINAL" "$DUMP_DIR/weekly/${WEEK}_$TS" && log "promoted to weekly/${WEEK}_$TS"
fi

status_update logical "$(jq -nc --arg t "$(utc_now)" --arg dir "$FINAL" --argjson size "$SIZE" --argjson dur "$DURATION" \
  --argjson warnings "$(warnings_json)" \
  '{last_run:$t,last_success:$t,last_result:"ok",dir:$dir,size_bytes:$size,duration_s:$dur,warnings:$warnings,message:"ok"}')"

if (( PRUNE )); then
  "$(bin_dir)/backup-prune.sh" --job dump || warn "prune failed"
fi
trap - EXIT
log "done"
