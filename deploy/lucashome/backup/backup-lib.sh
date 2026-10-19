#!/usr/bin/env bash
# backup-lib.sh — shared helpers for the lucashome Supabase backup jobs.
# Sourced by the job scripts; not meant to be executed directly.
# shellcheck shell=bash

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (non-secret). Overridable from $BACKUP_ENV (default
# /srv/supabase/backup/backup.env) or the environment.
# ---------------------------------------------------------------------------
BACKUP_ENV="${BACKUP_ENV:-/srv/supabase/backup/backup.env}"
_CONFIG_VARS=(STACK_DIR BACKUP_ROOT DUMP_DIR BASE_DIR LOG_DIR RESTORE_TEST_DIR STATUS_FILE LOCK_DIR DB_SERVICE
  DB_ADMIN_USER PG_IMAGE PGDATA_IN_CONTAINER KEEP_HOURLY KEEP_DAILY KEEP_WEEKLY KEEP_BASE SIZE_WARN_PCT BASE_METHOD
  INCLUDE_PGSODIUM_KEY GZIP_LEVEL THROWAWAY_MEMORY THROWAWAY_READY_TIMEOUT RESTORE_COUNT_TOLERANCE MAX_AGE_LOGICAL_S
  MAX_AGE_BASE_S MAX_AGE_RESTORE_S MIN_FREE_GB HEALTHCHECKS_URL LOG_MAX_BYTES WAL_ARCHIVE_DIR MAX_ARCHIVE_LAG_S
  # offsite tier (Phase F; see OFFSITE-ENABLE.md). Everything below is inert while OFFSITE_ENABLED != true.
  OFFSITE_ENABLED RCLONE_CONFIG OFFSITE_REMOTE OFFSITE_STATUS_FILE STORAGE_DIR BUNDLE_DIR KEEP_BUNDLE AGE_RECIPIENT
  DB_CONFIG_VOLUME BUNDLE_TAR_MODE OFFSITE_BWLIMIT OFFSITE_TRANSFERS OFFSITE_CHECKERS OFFSITE_CHECK OFFSITE_VERSIONS_KEEP_DAYS
  OFFSITE_SIZE_WARN_GB OFFSITE_SIZE_HIGH_GB OFFSITE_WAL_FULL_EVERY_S OFFSITE_WAL_COPY_MAX_AGE R2_TOKEN_EXPIRES
  MAX_AGE_OFFSITE_WAL_S MAX_AGE_OFFSITE_DUMP_S MAX_AGE_OFFSITE_BASE_S MAX_AGE_OFFSITE_STORAGE_S MAX_AGE_OFFSITE_BUNDLE_S
  MAX_AGE_OFFSITE_CHECK_S MAX_AGE_OFFSITE_RESTORE_S HEALTHCHECKS_OFFSITE_URL HEALTHCHECKS_OFFSITE_RESTORE_URL)
# precedence: environment > backup.env > defaults below
_env_overrides=()
for _v in "${_CONFIG_VARS[@]}"; do
  if [[ -n "${!_v+x}" ]]; then _env_overrides+=("$_v=${!_v}"); fi
done
if [[ -f "$BACKUP_ENV" ]]; then
  # shellcheck source=/dev/null
  . "$BACKUP_ENV"
fi
for _kv in "${_env_overrides[@]}"; do declare "$_kv"; done
unset _v _kv _env_overrides

: "${STACK_DIR:=/srv/supabase/stack}"
: "${BACKUP_ROOT:=/srv/supabase/backups}"
: "${DUMP_DIR:=$BACKUP_ROOT/dump}"
: "${BASE_DIR:=$BACKUP_ROOT/base}"
: "${LOG_DIR:=$BACKUP_ROOT/logs}"
: "${RESTORE_TEST_DIR:=$BACKUP_ROOT/restore-test}"
: "${STATUS_FILE:=$BACKUP_ROOT/status.json}"
: "${LOCK_DIR:=$BACKUP_ROOT/.locks}"
: "${DB_SERVICE:=db}"
: "${DB_ADMIN_USER:=supabase_admin}"
: "${PG_IMAGE:=supabase/postgres:17.6.1.136}"
: "${PGDATA_IN_CONTAINER:=/var/lib/postgresql/data}"
: "${KEEP_HOURLY:=48}"
: "${KEEP_DAILY:=14}"
: "${KEEP_WEEKLY:=8}"
: "${KEEP_BASE:=14}"
: "${SIZE_WARN_PCT:=50}"
: "${BASE_METHOD:=auto}"            # auto | pg_basebackup | sqlapi
: "${INCLUDE_PGSODIUM_KEY:=true}"   # copy /etc/postgresql-custom/pgsodium_root.key next to each base backup
: "${GZIP_LEVEL:=6}"
: "${THROWAWAY_MEMORY:=1g}"
: "${THROWAWAY_READY_TIMEOUT:=240}"
: "${RESTORE_COUNT_TOLERANCE:=0}"   # allowed absolute difference for row counts (auth.users, storage.*)
: "${MAX_AGE_LOGICAL_S:=7200}"      # 2 h
: "${MAX_AGE_BASE_S:=93600}"        # 26 h
: "${MAX_AGE_RESTORE_S:=691200}"    # 8 d
: "${MIN_FREE_GB:=20}"
: "${HEALTHCHECKS_URL:=}"
: "${LOG_MAX_BYTES:=10485760}"
: "${WAL_ARCHIVE_DIR:=$STACK_DIR/volumes/db/wal_archive}"   # bind-mounted at /var/lib/postgresql/wal_archive in the db container
: "${MAX_ARCHIVE_LAG_S:=600}"       # 10 min: oldest unarchived segment / last_archived_time age

# --- offsite tier (Phase F). Defaults keep everything disabled; offsite-lib.sh enforces them. ---
: "${OFFSITE_ENABLED:=false}"       # exactly "true" enables offsite-sync.sh / offsite-restore-test.sh / offsite-status.sh
: "${RCLONE_CONFIG:=/srv/supabase/backup/rclone.conf}"   # created by the owner with `rclone config` (0600); never in git
: "${OFFSITE_REMOTE:=offsite:}"     # rclone crypt remote (name + colon); prefixes base/ wal/ dump/ storage/ bundle/ .versions/ live under it
: "${OFFSITE_STATUS_FILE:=$BACKUP_ROOT/offsite.json}"
: "${STORAGE_DIR:=$STACK_DIR/volumes/storage}"
: "${BUNDLE_DIR:=$BACKUP_ROOT/bundle}"
: "${KEEP_BUNDLE:=14}"
: "${AGE_RECIPIENT:=}"              # age1... public key(s), space-separated; the private key never lives on this host
: "${DB_CONFIG_VOLUME:=supabase_db-config}"
: "${BUNDLE_TAR_MODE:=docker}"      # docker: tar runs in a throwaway container with every input mounted ro (needed for the db-config volume) | host
: "${OFFSITE_BWLIMIT:=}"            # rclone --bwlimit, e.g. "4M" or "08:00,2M 22:00,off"; empty = unlimited
: "${OFFSITE_TRANSFERS:=4}"
: "${OFFSITE_CHECKERS:=8}"
: "${OFFSITE_CHECK:=cryptcheck}"    # verification after each sync: cryptcheck (plaintext hash vs remote, crypt remotes) | check (size only on crypt) | none
: "${OFFSITE_VERSIONS_KEEP_DAYS:=30}"
: "${OFFSITE_SIZE_WARN_GB:=8}"
: "${OFFSITE_SIZE_HIGH_GB:=9}"      # doc 09: 8 GB warn; R2 free tier ends at 10 GB
: "${OFFSITE_WAL_FULL_EVERY_S:=86400}"   # how often the wal tier does a full sync (applies the local prune remotely) instead of a copy
: "${OFFSITE_WAL_COPY_MAX_AGE:=24h}"     # rclone --max-age for the incremental wal copy
: "${R2_TOKEN_EXPIRES:=}"           # optional YYYY-MM-DD; offsite-status warns 14 d before
: "${MAX_AGE_OFFSITE_WAL_S:=1800}"       # 30 min
: "${MAX_AGE_OFFSITE_DUMP_S:=7200}"      # 2 h
: "${MAX_AGE_OFFSITE_BASE_S:=93600}"     # 26 h
: "${MAX_AGE_OFFSITE_STORAGE_S:=25200}"  # 7 h
: "${MAX_AGE_OFFSITE_BUNDLE_S:=93600}"   # 26 h
: "${MAX_AGE_OFFSITE_CHECK_S:=180000}"   # 50 h (daily job, one missed run tolerated)
: "${MAX_AGE_OFFSITE_RESTORE_S:=691200}" # 8 d
: "${HEALTHCHECKS_OFFSITE_URL:=}"        # healthchecks.io check "offsite" (every sync job pings /start, then / or /fail)
: "${HEALTHCHECKS_OFFSITE_RESTORE_URL:=}"   # check "restore-test-offsite" (weekly)

DRY_RUN="${DRY_RUN:-0}"
JOB_NAME="${JOB_NAME:-$(basename "${BASH_SOURCE[-1]}" .sh)}"
LOG_FILE=""
WARNINGS=()
# shellcheck disable=SC2034  # used by the sourcing scripts
TS_RE='^[0-9]{8}T[0-9]{6}Z$'
# shellcheck disable=SC2034
WEEK_RE='^[0-9]{4}-W[0-9]{2}_[0-9]{8}T[0-9]{6}Z$'

umask 077

# ---------------------------------------------------------------------------
# Logging / errors
# ---------------------------------------------------------------------------
utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ts_now()  { date -u +%Y%m%dT%H%M%SZ; }

log() {
  local line
  line="$(utc_now) [$JOB_NAME] $*"
  printf '%s\n' "$line" >&2
  if [[ -n "$LOG_FILE" ]]; then
    printf '%s\n' "$line" >>"$LOG_FILE" || true
  fi
}
warn() { WARNINGS+=("$*"); log "WARN: $*"; }
die()  { log "ERROR: $*"; exit 1; }

init_logging() {
  mkdir -p "$LOG_DIR" && chmod 0700 "$LOG_DIR"
  LOG_FILE="$LOG_DIR/$JOB_NAME.log"
  if [[ -f "$LOG_FILE" ]] && (( $(stat -c %s "$LOG_FILE") > LOG_MAX_BYTES )); then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
  : >>"$LOG_FILE"
}

acquire_lock() {
  mkdir -p "$LOCK_DIR" && chmod 0700 "$LOCK_DIR"
  exec 9>"$LOCK_DIR/$JOB_NAME.lock"
  flock -n 9 || die "another $JOB_NAME run holds $LOCK_DIR/$JOB_NAME.lock"
}

# run CMD... — executes, or only logs it in --dry-run mode.
run() {
  if (( DRY_RUN )); then
    log "DRY-RUN: $*"
  else
    "$@"
  fi
}

require_dirs() {
  [[ -d "$STACK_DIR" ]] || die "stack dir $STACK_DIR not found"
  [[ -d "$BACKUP_ROOT" ]] || die "backup root $BACKUP_ROOT not found (create it 0700 as the backup user)"
  for d in "$DUMP_DIR" "$DUMP_DIR/hourly" "$DUMP_DIR/daily" "$DUMP_DIR/weekly" "$BASE_DIR" "$RESTORE_TEST_DIR"; do
    [[ -d "$d" ]] || run mkdir -p "$d"
    [[ -d "$d" ]] && chmod 0700 "$d" || true
  done
}

human() {  # bytes -> human readable
  numfmt --to=iec --suffix=B "${1:-0}" 2>/dev/null || printf '%sB' "${1:-0}"
}

dir_bytes() { du -sb "$1" 2>/dev/null | cut -f1; }

# write_sha256sums DIR — writes DIR/SHA256SUMS over every regular file in DIR.
write_sha256sums() {
  local dir="$1"
  local tmp="$dir/.SHA256SUMS.tmp"
  (cd "$dir" && find . -maxdepth 1 -type f ! -name 'SHA256SUMS' ! -name '.*' -printf '%P\n' | LC_ALL=C sort | xargs -r sha256sum -b >"$tmp")
  mv -f "$tmp" "$dir/SHA256SUMS"
  chmod 0600 "$dir/SHA256SUMS"
}

verify_sha256sums() {
  local dir="$1"
  [[ -f "$dir/SHA256SUMS" ]] || return 1
  (cd "$dir" && sha256sum --quiet -c SHA256SUMS)
}

# ---------------------------------------------------------------------------
# Docker / Postgres access to the running stack
# ---------------------------------------------------------------------------
# COMPOSE_FILE in the stack's .env holds relative paths, which compose resolves against the cwd.
compose() { (cd "$STACK_DIR" && docker compose "$@"); }

# db_exec CMD... — run CMD in the db container, stdin closed (never consume our stdin).
db_exec() { compose exec -T "$DB_SERVICE" "$@" </dev/null; }

# db_exec_stdin CMD... — same but stdin is passed through (caller redirects).
db_exec_stdin() { compose exec -T "$DB_SERVICE" "$@"; }

# db_psql DB ARGS... — psql as the admin role over the container's Unix socket.
db_psql() {
  local db="$1"; shift
  db_exec psql -X -U "$DB_ADMIN_USER" -d "$db" -v ON_ERROR_STOP=1 -Atq "$@"
}

# ---------------------------------------------------------------------------
# Consistency counts recorded at backup time and re-checked after restores.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2034
COUNTS_SQL="select json_build_object(
  'auth_users',      (select count(*) from auth.users),
  'storage_buckets', (select count(*) from storage.buckets),
  'storage_objects', (select count(*) from storage.objects),
  'tables_public',   (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'  and c.relkind in ('r','p')),
  'tables_auth',     (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth'    and c.relkind in ('r','p')),
  'tables_storage',  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'storage' and c.relkind in ('r','p')),
  'roles',           (select count(*) from pg_roles where rolname not like 'pg\\_%'),
  'extensions',      (select count(*) from pg_extension),
  'rows',            (select json_object_agg(n.nspname || '.' || c.relname,
                        (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint)
                        from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where n.nspname in ('public','auth','storage','supabase_migrations') and c.relkind in ('r','p')),
  'db_size_bytes',   pg_database_size(current_database()),
  'captured_at',     to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
);"
COMPARE_EXACT_KEYS=(tables_public tables_auth tables_storage)
COMPARE_TOLERANT_KEYS=(auth_users storage_buckets storage_objects)

# compare_counts EXPECTED_JSON ACTUAL_JSON — prints a per-key table; returns 1 on mismatch.
compare_counts() {
  local expected="$1" actual="$2" key e a ok=0 diff
  printf '%-18s %12s %12s  %s\n' key expected restored result
  for key in "${COMPARE_EXACT_KEYS[@]}"; do
    e="$(jq -r --arg k "$key" '.[$k]' <<<"$expected")"
    a="$(jq -r --arg k "$key" '.[$k]' <<<"$actual")"
    if [[ "$e" == "$a" ]]; then
      printf '%-18s %12s %12s  OK\n' "$key" "$e" "$a"
    else
      printf '%-18s %12s %12s  MISMATCH\n' "$key" "$e" "$a"; ok=1
    fi
  done
  for key in "${COMPARE_TOLERANT_KEYS[@]}"; do
    e="$(jq -r --arg k "$key" '.[$k]' <<<"$expected")"
    a="$(jq -r --arg k "$key" '.[$k]' <<<"$actual")"
    diff=$(( e > a ? e - a : a - e ))
    if (( diff <= RESTORE_COUNT_TOLERANCE )); then
      printf '%-18s %12s %12s  OK\n' "$key" "$e" "$a"
    else
      printf '%-18s %12s %12s  MISMATCH (diff %s > tolerance %s)\n' "$key" "$e" "$a" "$diff" "$RESTORE_COUNT_TOLERANCE"; ok=1
    fi
  done
  return $ok
}

# ---------------------------------------------------------------------------
# status.json — one object per job, merged atomically.
# ---------------------------------------------------------------------------
status_update() {  # JOB JSON_FRAGMENT
  json_update "$STATUS_FILE" "$1" "$2"
}

# json_update FILE JOB JSON_FRAGMENT — merge FRAGMENT into FILE.jobs[JOB] atomically (status.json, offsite.json).
json_update() {
  local file="$1" job="$2" frag="$3" tmp
  if (( DRY_RUN )); then log "DRY-RUN: $(basename "$file")[$job] <- $frag"; return 0; fi
  tmp="$(mktemp "$BACKUP_ROOT/.status.XXXXXX")"
  python3 -I - "$file" "$job" "$frag" >"$tmp" <<'PY'
import json, sys, datetime
path, job, frag = sys.argv[1:4]
try:
    with open(path) as fh:
        data = json.load(fh)
except Exception:
    data = {}
jobs = data.setdefault("jobs", {})
jobs.setdefault(job, {}).update(json.loads(frag))
data["updated_at"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(data, sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
PY
  chmod 0600 "$tmp" && mv -f "$tmp" "$file"
}

warnings_json() {
  if (( ${#WARNINGS[@]} )); then printf '%s\n' "${WARNINGS[@]}" | jq -R . | jq -sc .; else echo '[]'; fi
}

# ---------------------------------------------------------------------------
# Throwaway restore containers (never the running stack).
# ---------------------------------------------------------------------------
TW_NAME=""
TW_DIR=""
TW_EXTRA_ARGS=()   # extra `docker run` arguments for the next tw_start (e.g. an archive mount)

# Wrapper run as PID 1 in the throwaway: installs the pgsodium key copy (if the
# backup carried one) and tees postgres output into /restore/postgres.log so the
# host can read it even after the container is gone.
read -r -d '' TW_WRAPPER <<'EOS' || true
set -e
if [ -f /restore/pgsodium_root.key ]; then
  cp /restore/pgsodium_root.key /etc/postgresql-custom/pgsodium_root.key
  chown postgres:postgres /etc/postgresql-custom/pgsodium_root.key
  chmod 0600 /etc/postgresql-custom/pgsodium_root.key
fi
exec docker-entrypoint.sh "$@" > >(tee -a /restore/postgres.log) 2>&1
EOS

tw_assert_dir() {
  case "$TW_DIR" in
    "$RESTORE_TEST_DIR"/*) ;;
    *) die "refusing to touch $TW_DIR: not under $RESTORE_TEST_DIR" ;;
  esac
}

tw_cleanup() {
  local rc=$?
  if [[ -n "$TW_NAME" ]] && docker container inspect "$TW_NAME" >/dev/null 2>&1; then
    log "removing throwaway container $TW_NAME"
    docker rm -f "$TW_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$TW_DIR" && -d "$TW_DIR" ]]; then
    tw_assert_dir
    # the image entrypoint chowns PGDATA to uid 100; give it back before rm -rf (no sudo on the host)
    docker run --rm --network none --memory 256m --name "${TW_NAME:-sb-restore-test}-chown" \
      -v "$TW_DIR:/cleanup" --entrypoint chown "$PG_IMAGE" -R "$(id -u):$(id -g)" /cleanup >/dev/null 2>&1 || true
    rm -rf "$TW_DIR"
    log "removed $TW_DIR"
  fi
  TW_NAME=""; TW_DIR=""
  return $rc
}

# tw_start MODE  (MODE = logical: fresh vanilla initdb, no supabase init scripts;
#                 MODE = physical: $TW_DIR/pgdata mounted as PGDATA)
tw_start() {
  local mode="$1" pw
  tw_assert_dir
  pw="$(head -c 24 /dev/urandom | base64 | tr -d '\n')"   # throwaway bootstrap password, never reused
  local -a args=(
    -d --rm --name "$TW_NAME" --memory "$THROWAWAY_MEMORY" --network none
    --label sb-restore-test=1
    -v "$TW_DIR:/restore"
    -e POSTGRES_PASSWORD="$pw" -e POSTGRES_USER="$DB_ADMIN_USER" -e POSTGRES_DB=postgres
  )
  case "$mode" in
    logical)  args+=(--mount "type=tmpfs,destination=/docker-entrypoint-initdb.d") ;;
    physical) args+=(-v "$TW_DIR/pgdata:$PGDATA_IN_CONTAINER") ;;
    *) die "tw_start: unknown mode $mode" ;;
  esac
  : >"$TW_DIR/postgres.log"; chmod 0644 "$TW_DIR/postgres.log"
  docker run "${args[@]}" ${TW_EXTRA_ARGS[@]+"${TW_EXTRA_ARGS[@]}"} --entrypoint bash "$PG_IMAGE" -c "$TW_WRAPPER" -- \
    postgres -c config_file=/etc/postgresql/postgresql.conf -c listen_addresses=localhost >/dev/null
}

# tw_wait_ready MODE — waits for the final (not the init-time temporary) server.
tw_wait_ready() {
  local mode="$1" deadline=$(( SECONDS + THROWAWAY_READY_TIMEOUT ))
  while (( SECONDS < deadline )); do
    if ! docker container inspect -f '{{.State.Running}}' "$TW_NAME" 2>/dev/null | grep -q true; then
      log "throwaway container exited early; last log lines:"
      tail -n 40 "$TW_DIR/postgres.log" >&2 || true
      return 1
    fi
    if [[ "$mode" == logical ]] && ! grep -q 'PostgreSQL init process complete' "$TW_DIR/postgres.log"; then
      sleep 2; continue
    fi
    if grep -q 'database system is ready to accept connections' "$TW_DIR/postgres.log" \
       && docker exec "$TW_NAME" pg_isready -q -U "$DB_ADMIN_USER" -h /var/run/postgresql; then
      return 0
    fi
    sleep 2
  done
  log "throwaway did not become ready within ${THROWAWAY_READY_TIMEOUT}s; last log lines:"
  tail -n 40 "$TW_DIR/postgres.log" >&2 || true
  return 1
}

tw_psql() {  # DB ARGS...
  local db="$1"; shift
  docker exec "$TW_NAME" psql -X -U "$DB_ADMIN_USER" -d "$db" -v ON_ERROR_STOP=1 -Atq "$@"
}

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------
latest_dir() {  # PARENT REGEX — newest matching subdirectory (by name), empty if none
  local parent="$1" re="$2"
  find "$parent" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' 2>/dev/null | { grep -E "$re" || true; } | LC_ALL=C sort | tail -n 1
}

bin_dir() { cd "$(dirname "${BASH_SOURCE[0]}")" && pwd; }

# base_start_wal_file BASE_DIR — first WAL segment a base backup needs (from backup.json, else backup_label).
base_start_wal_file() {
  local dir="$1" f=""
  [[ -f "$dir/backup.json" ]] && f="$(jq -r '.start_wal_file // empty' "$dir/backup.json")"
  if [[ -z "$f" && -f "$dir/backup_label" ]]; then
    f="$(grep -oE '\(file [0-9A-F]{24}\)' "$dir/backup_label" | grep -oE '[0-9A-F]{24}' || true)"
  fi
  if [[ -z "$f" && -f "$dir/base.tar.gz" ]]; then
    f="$(tar -xzOf "$dir/base.tar.gz" backup_label 2>/dev/null | grep -oE '\(file [0-9A-F]{24}\)' | grep -oE '[0-9A-F]{24}' || true)"
  fi
  printf '%s' "$f"
}

# next_wal_segment NAME — the segment after NAME (16 MB segments: 256 per 4 GB log file).
next_wal_segment() {
  python3 -I -c '
import sys
n = sys.argv[1]; tli, log, seg = n[:8], int(n[8:16], 16), int(n[16:24], 16)
seg += 1
if seg == 256: seg = 0; log += 1
print(f"{tli}{log:08X}{seg:08X}")' "$1"
}

# first_archive_segment_needed BASE_DIR — first segment the ARCHIVE must hold for this base:
# the one after the WAL the base carries itself (pg_basebackup -X fetch / sqlapi pg_wal.tar.gz),
# else its start segment.
first_archive_segment_needed() {
  local dir="$1" last=""
  [[ -f "$dir/backup.json" ]] && last="$(jq -r '.wal_files // [] | map(select(test("^[0-9A-F]{24}$"))) | sort | last // empty' "$dir/backup.json")"
  if [[ -n "$last" ]]; then next_wal_segment "$last"; else base_start_wal_file "$dir"; fi
}

# archiver_json — pg_stat_archiver + pending .ready files as one JSON object (empty on query failure).
archiver_json() {
  db_psql postgres -c "select json_build_object(
    'archive_mode', current_setting('archive_mode'),
    'archive_timeout', current_setting('archive_timeout'),
    'last_archived_wal', last_archived_wal,
    'last_archived_time', to_char(last_archived_time at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
    'last_archived_age_s', coalesce(extract(epoch from now() - last_archived_time)::int, -1),
    'last_failed_wal', last_failed_wal,
    'last_failed_time', to_char(last_failed_time at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
    'failed_after_success', (last_failed_time is not null and (last_archived_time is null or last_failed_time > last_archived_time)),
    'archived_count', archived_count, 'failed_count', failed_count,
    'pending', (select count(*) from pg_ls_archive_statusdir() where name ~ '\\.ready\$'),
    'oldest_pending_age_s', (select coalesce(extract(epoch from now() - min(modification)), 0)::int from pg_ls_archive_statusdir() where name ~ '\\.ready\$'),
    'current_wal', pg_walfile_name(pg_current_wal_lsn()),
    'timeline', (select timeline_id from pg_control_checkpoint())
  ) from pg_stat_archiver" 2>/dev/null || true
}
