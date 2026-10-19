#!/usr/bin/env bash
# backup-base.sh — daily physical base backup of the running supabase-db container.
#
# Method "pg_basebackup" (preferred, needs a `replication` line in pg_hba.conf —
# see WAL-ARCHIVING.md): pg_basebackup -Ft -X fetch --manifest-checksums=SHA256
# streamed out of the container and gzipped; verified with pg_verifybackup.
#
# Method "sqlapi" (fallback, works with the stock pg_hba.conf): non-exclusive
# backup via pg_backup_start()/pg_backup_stop() in one psql session, PGDATA
# tarred by `docker compose exec` while in backup mode, the WAL segments between
# start and stop copied afterwards (a temporary physical replication slot pins
# them meanwhile). Produces base.tar.gz + pg_wal.tar.gz + backup_label and is
# verified structurally (gzip/tar integrity, backup_label, every WAL segment
# present and full size). pg_verifybackup needs a manifest, which only
# pg_basebackup writes.
#
# Output: $BASE_DIR/<UTC ts>/{base.tar.gz,[pg_wal.tar.gz,backup_label,tablespace_map],
#         backup.json,counts.json,[pgsodium_root.key],SHA256SUMS}
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--method auto|pg_basebackup|sqlapi] [--no-prune] [--help]
  --method    override BASE_METHOD (current: $BASE_METHOD)
Output: $BASE_DIR/<ts>/  (keep newest $KEEP_BASE)
EOF
}

PRUNE=1
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --method) BASE_METHOD="$2"; shift ;;
    --no-prune) PRUNE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done
case "$BASE_METHOD" in auto|pg_basebackup|sqlapi) ;; *) die "bad BASE_METHOD $BASE_METHOD" ;; esac

init_logging
acquire_lock
require_dirs

TS="$(ts_now)"
LABEL="sb-base-$TS"
FINAL="$BASE_DIR/$TS"
OUT="$FINAL.partial"
VERIFY_DIR="$RESTORE_TEST_DIR/verify-$TS"
SLOT=""
START=$SECONDS
PSQL_IN=""; PSQL_OUT=""; PSQL_PID=""

# ---------------------------------------------------------------------------
cleanup() {
  local rc=$?
  trap '' TERM INT HUP   # a second signal must not abort the cleanup halfway
  trap - EXIT
  # close the backup session if still open
  if [[ -n "$PSQL_IN" ]]; then exec {PSQL_IN}>&- 2>/dev/null || true; fi
  if [[ -n "$PSQL_PID" ]]; then wait "$PSQL_PID" 2>/dev/null || true; fi
  if [[ -n "$SLOT" ]]; then
    if db_psql postgres -c "select pg_drop_replication_slot('$SLOT') where exists (select 1 from pg_replication_slots where slot_name = '$SLOT');" >/dev/null 2>&1; then
      log "dropped replication slot $SLOT"
    else
      log "WARN: could not drop slot $SLOT (drop it by hand: select pg_drop_replication_slot('$SLOT'))"
    fi
  fi
  [[ -d "$VERIFY_DIR" ]] && rm -rf -- "$VERIFY_DIR"
  if (( rc != 0 )); then
    log "FAILED (rc=$rc) after $(( SECONDS - START ))s"
    [[ -d "$OUT" ]] && rm -rf -- "$OUT"
    (( DRY_RUN )) || status_update base "$(jq -nc --arg t "$(utc_now)" --arg m "exit $rc, see $LOG_FILE" \
      '{last_run:$t,last_result:"fail",message:$m}')"
  fi
  exit "$rc"
}
trap cleanup EXIT
# a kill (TERM/INT/HUP) exits through cleanup too: the partial output is removed and the run recorded as failed
trap 'exit 143' TERM; trap 'exit 130' INT; trap 'exit 129' HUP

# ---------------------------------------------------------------------------
# Method 1: pg_basebackup (socket first, then TCP with the stack password)
# ---------------------------------------------------------------------------
try_pg_basebackup() {  # returns 0 ok, 2 "pg_hba forbids replication" (fallback allowed), 1 other failure
  local err="$OUT/.pg_basebackup.err" rc
  local -a bb=(pg_basebackup -U "$DB_ADMIN_USER" -D - -Ft -X fetch --checkpoint=fast --manifest-checksums=SHA256 --label="$LABEL")

  log "pg_basebackup over the container's Unix socket"
  db_exec "${bb[@]}" -h /var/run/postgresql 2>"$err" | gzip -"$GZIP_LEVEL" >"$OUT/base.tar.gz"
  rc=${PIPESTATUS[0]}
  if (( rc == 0 )); then return 0; fi
  log "socket attempt failed: $(head -n 1 "$err")"

  log "pg_basebackup over TCP (localhost) with POSTGRES_PASSWORD from $STACK_DIR/.env"
  local pw
  pw="$(grep -E '^POSTGRES_PASSWORD=' "$STACK_DIR/.env" | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
  [[ -n "$pw" ]] || { log "POSTGRES_PASSWORD not found in .env"; return 1; }
  # -e PGPASSWORD (name only) forwards the value from our environment; it never appears in argv or logs.
  PGPASSWORD="$pw" compose exec -T -e PGPASSWORD "$DB_SERVICE" "${bb[@]}" -h localhost </dev/null 2>"$err" \
    | gzip -"$GZIP_LEVEL" >"$OUT/base.tar.gz"
  rc=${PIPESTATUS[0]}
  unset pw
  if (( rc == 0 )); then return 0; fi
  log "TCP attempt failed: $(head -n 1 "$err")"
  rm -f "$OUT/base.tar.gz"
  if grep -q 'no pg_hba.conf entry for replication connection' "$err"; then return 2; fi
  return 1
}

verify_pg_basebackup() {
  mkdir -p "$VERIFY_DIR" && chmod 0700 "$VERIFY_DIR"
  tar -xzf "$OUT/base.tar.gz" -C "$VERIFY_DIR"
  [[ -f "$VERIFY_DIR/backup_manifest" ]] || die "backup_manifest missing from base.tar.gz"
  docker run --rm --network none --memory 512m --name "sb-restore-test-verify-$TS" \
    -v "$VERIFY_DIR:/verify" --entrypoint pg_verifybackup "$PG_IMAGE" /verify 2>&1 | tee -a "$LOG_FILE" >&2
  local -a ps=("${PIPESTATUS[@]}"); local rc=${ps[0]}
  # keep backup_label as a sidecar (prune/PITR read the start segment from it) and the manifest's WAL ranges
  cp "$VERIFY_DIR/backup_label" "$OUT/backup_label"
  WAL_RANGES="$(jq -c '."WAL-Ranges"' "$VERIFY_DIR/backup_manifest")"
  START_LSN="$(jq -r '."WAL-Ranges"[0]."Start-LSN"' "$VERIFY_DIR/backup_manifest")"
  STOP_LSN="$(jq -r '."WAL-Ranges"[-1]."End-LSN"' "$VERIFY_DIR/backup_manifest")"
  WAL_FILES="$(tar -tzf "$OUT/base.tar.gz" | grep -oE '^pg_wal/[0-9A-F]{24}$' | sed 's#pg_wal/##' | tr '\n' ' ' | sed 's/ $//')"
  rm -rf -- "$VERIFY_DIR"
  (( rc == 0 )) || die "pg_verifybackup failed (rc=$rc)"
  VERIFY="pg_verifybackup"
}

# ---------------------------------------------------------------------------
# Method 2: SQL backup API
# ---------------------------------------------------------------------------
psql_send() { printf '%s\n' "$1" >&"$PSQL_IN"; }

# psql_expect PREFIX [TIMEOUT] — reads session output until a line starting with PREFIX; sets REPLY_LINE.
psql_expect() {
  local prefix="$1" timeout="${2:-900}" line
  REPLY_LINE=""
  while IFS= read -r -t "$timeout" -u "$PSQL_OUT" line; do
    if [[ "$line" == "$prefix"* ]]; then REPLY_LINE="${line#"$prefix"}"; return 0; fi
    [[ -n "$line" ]] && log "backup session: ${line:0:200}"
  done
  log "backup session ended while waiting for $prefix"
  return 1
}

sqlapi_backup() {
  local start_lsn stop_lsn stop_hex spc_hex wal_list tar_rc gz_rc
  local -a ps
  local tar_err="$OUT/.tar.err"

  # one psql session for the whole backup (pg_backup_start/stop must share a session)
  coproc PSQL { compose exec -T "$DB_SERVICE" psql -X -U "$DB_ADMIN_USER" -d postgres -Atq -v ON_ERROR_STOP=1 2>&1; }
  PSQL_IN=${PSQL[1]}; PSQL_OUT=${PSQL[0]}   # bash sets PSQL_PID for a named coproc

  SLOT="sb_backup_$(tr '[:upper:]' '[:lower:]' <<<"$TS")"
  psql_send "select 'SLOT:' || slot_name from pg_create_physical_replication_slot('$SLOT', true);"
  psql_expect "SLOT:" 60 || die "could not create replication slot"
  log "WAL pinned by temporary slot $SLOT"

  psql_send "select 'START:' || pg_backup_start('$LABEL', true);"
  psql_expect "START:" 600 || die "pg_backup_start failed"
  start_lsn="$REPLY_LINE"
  log "backup started at LSN $start_lsn (checkpoint done)"

  # PGDATA while in backup mode. Excluded: WAL (copied separately), runtime files
  # Postgres recreates, and anything pg_basebackup itself excludes.
  set +e   # tar may exit 1 (file changed while read) on a live cluster; inspect PIPESTATUS ourselves
  # NB: the image's tar is BusyBox: only -C/-c/-f/--exclude are available (no GNU --warning flags)
  db_exec tar -C "$PGDATA_IN_CONTAINER" \
    --exclude='./pg_wal/*' --exclude='./pg_replslot/*' --exclude='./pg_dynshmem/*' \
    --exclude='./pg_notify/*' --exclude='./pg_serial/*' --exclude='./pg_snapshots/*' \
    --exclude='./pg_stat_tmp/*' --exclude='./pg_subtrans/*' --exclude='./postmaster.pid' \
    --exclude='./postmaster.opts' --exclude='pg_internal.init' --exclude='./log/*' \
    -cf - . 2>"$tar_err" | gzip -"$GZIP_LEVEL" >"$OUT/base.tar.gz"
  ps=("${PIPESTATUS[@]}"); tar_rc=${ps[0]}; gz_rc=${ps[1]}
  set -e
  # GNU tar exits 1 when a file changed while being read — expected on a live cluster, harmless under backup mode.
  (( tar_rc == 0 || tar_rc == 1 )) || { cat "$tar_err" >&2; die "tar of PGDATA failed (rc=$tar_rc)"; }
  (( gz_rc == 0 )) || die "gzip failed"
  [[ -s "$tar_err" ]] && log "tar notes: $(tr '\n' ' ' <"$tar_err" | cut -c1-300)"
  log "base.tar.gz written ($(human "$(stat -c %s "$OUT/base.tar.gz")"))"

  psql_send "select 'STOP:' || lsn || '|' || encode(convert_to(labelfile, 'UTF8'), 'hex') || '|' || encode(convert_to(coalesce(spcmapfile, ''), 'UTF8'), 'hex') from pg_backup_stop(false);"
  psql_expect "STOP:" 600 || die "pg_backup_stop failed"
  IFS='|' read -r stop_lsn stop_hex spc_hex <<<"$REPLY_LINE"
  python3 -I -c 'import sys; sys.stdout.buffer.write(bytes.fromhex(sys.argv[1]))' "$stop_hex" >"$OUT/backup_label"
  if [[ -n "$spc_hex" ]]; then
    python3 -I -c 'import sys; sys.stdout.buffer.write(bytes.fromhex(sys.argv[1]))' "$spc_hex" >"$OUT/tablespace_map"
  fi
  log "backup stopped at LSN $stop_lsn"

  # finish the segment holding the stop record so every needed segment is a complete file
  psql_send "select 'SWITCH:' || pg_switch_wal();"
  psql_expect "SWITCH:" 60 || die "pg_switch_wal failed"

  psql_send "select 'WAL:' || coalesce(string_agg(name, ' ' order by name), '') from pg_ls_waldir()
    where (name ~ '^[0-9A-F]{24}\$' and name >= pg_walfile_name('$start_lsn') and name <= pg_walfile_name('$stop_lsn'))
       or name ~ '\\.history\$';"
  psql_expect "WAL:" 60 || die "could not list WAL segments"
  wal_list="$REPLY_LINE"
  [[ -n "$wal_list" ]] || die "no WAL segments found between $start_lsn and $stop_lsn"
  log "WAL segments needed: $wal_list"

  set +e
  # shellcheck disable=SC2086  # wal_list is a space-separated list of validated file names
  db_exec tar -C "$PGDATA_IN_CONTAINER/pg_wal" -cf - $wal_list 2>"$tar_err" | gzip -"$GZIP_LEVEL" >"$OUT/pg_wal.tar.gz"
  ps=("${PIPESTATUS[@]}"); tar_rc=${ps[0]}; gz_rc=${ps[1]}
  set -e
  (( tar_rc == 0 && gz_rc == 0 )) || { cat "$tar_err" >&2; die "copying WAL segments failed"; }
  log "pg_wal.tar.gz written ($(human "$(stat -c %s "$OUT/pg_wal.tar.gz")"))"

  psql_send "select pg_drop_replication_slot('$SLOT');"
  psql_send "select 'DROP:ok';"
  psql_expect "DROP:" 60 || die "could not drop slot $SLOT"
  SLOT=""
  psql_send '\q'
  exec {PSQL_IN}>&-; PSQL_IN=""
  wait "$PSQL_PID" || true; PSQL_PID=""
  rm -f "$tar_err"

  START_LSN="$start_lsn"; STOP_LSN="$stop_lsn"; WAL_FILES="$wal_list"
}

verify_sqlapi() {
  local seg_bytes f n missing=0
  gzip -t "$OUT/base.tar.gz" || die "base.tar.gz failed gzip -t"
  gzip -t "$OUT/pg_wal.tar.gz" || die "pg_wal.tar.gz failed gzip -t"
  tar -tzf "$OUT/base.tar.gz" >"$OUT/.base.list"
  for f in ./PG_VERSION ./global/pg_control ./pg_wal/; do
    grep -qx "$f" "$OUT/.base.list" || die "base.tar.gz is missing $f"
  done
  n="$(wc -l <"$OUT/.base.list")"
  grep -q '^START WAL LOCATION:' "$OUT/backup_label" || die "backup_label malformed"
  grep -q '^BACKUP METHOD: streamed' "$OUT/backup_label" || die "backup_label is not a non-exclusive (streamed) backup label"
  seg_bytes="$(db_psql postgres -c "select setting from pg_settings where name = 'wal_segment_size'")"
  tar -tzvf "$OUT/pg_wal.tar.gz" >"$OUT/.wal.list"
  # shellcheck disable=SC2086  # validated space-separated file names
  for f in $WAL_FILES; do
    if [[ "$f" =~ ^[0-9A-F]{24}$ ]]; then
      grep -qE " $seg_bytes [0-9-]+ [0-9:]+ $f\$" "$OUT/.wal.list" || { log "WAL segment $f missing or not $seg_bytes bytes"; missing=1; }
    else
      grep -qE " $f\$" "$OUT/.wal.list" || { log "WAL file $f missing"; missing=1; }
    fi
  done
  (( missing == 0 )) || die "WAL coverage check failed"
  rm -f "$OUT/.base.list" "$OUT/.wal.list"
  log "structural verification ok: $n members in base.tar.gz, WAL $(wc -w <<<"$WAL_FILES") file(s) complete, backup_label present"
  VERIFY="structural (gzip/tar integrity, backup_label, WAL coverage); pg_verifybackup not applicable without a manifest"
}

# ---------------------------------------------------------------------------
log "start base backup -> $FINAL (method=$BASE_METHOD)"
if (( DRY_RUN )); then
  log "DRY-RUN: would record counts, run method '$BASE_METHOD' (pg_basebackup socket -> TCP -> sqlapi fallback when auto),"
  log "DRY-RUN: verify (pg_verifybackup or structural), copy pgsodium_root.key=$INCLUDE_PGSODIUM_KEY, write backup.json + SHA256SUMS, prune (keep $KEEP_BASE)"
  exit 0
fi

mkdir -p "$OUT" && chmod 0700 "$OUT"
db_psql postgres -c "$COUNTS_SQL" >"$OUT/counts.json"
jq -e . "$OUT/counts.json" >/dev/null || die "counts.json invalid"
log "counts: $(jq -c 'del(.captured_at)' "$OUT/counts.json")"

METHOD=""; VERIFY=""; START_LSN=""; STOP_LSN=""; WAL_FILES=""; WAL_RANGES="[]"; START_WAL_FILE=""
if [[ "$BASE_METHOD" == auto || "$BASE_METHOD" == pg_basebackup ]]; then
  set +e; try_pg_basebackup; rc=$?; set -e
  case $rc in
    0) METHOD=pg_basebackup ;;
    2) if [[ "$BASE_METHOD" == auto ]]; then
         warn "pg_hba.conf has no replication entry for $DB_ADMIN_USER; falling back to the SQL backup API (see WAL-ARCHIVING.md to enable pg_basebackup)"
       else
         die "pg_basebackup refused: pg_hba.conf has no replication entry (see WAL-ARCHIVING.md)"
       fi ;;
    *) die "pg_basebackup failed (rc=$rc)" ;;
  esac
fi
if [[ -z "$METHOD" ]]; then
  sqlapi_backup
  METHOD=sqlapi
fi
rm -f "$OUT/.pg_basebackup.err"
chmod 0600 "$OUT"/*

case "$METHOD" in
  pg_basebackup) verify_pg_basebackup ;;
  sqlapi) verify_sqlapi ;;
esac

START_WAL_FILE="$(grep -oE '\(file [0-9A-F]{24}\)' "$OUT/backup_label" | grep -oE '[0-9A-F]{24}' || true)"
[[ -n "$START_WAL_FILE" ]] || die "could not read the start WAL segment from backup_label"
log "first WAL segment this backup needs: $START_WAL_FILE (the WAL archive must keep it and everything after)"

if [[ "$INCLUDE_PGSODIUM_KEY" == true ]]; then
  if compose cp "$DB_SERVICE:/etc/postgresql-custom/pgsodium_root.key" "$OUT/pgsodium_root.key" >/dev/null 2>&1; then
    chmod 0600 "$OUT/pgsodium_root.key"; log "pgsodium_root.key copied (needed to decrypt vault secrets after a restore)"
  else
    warn "could not copy pgsodium_root.key from the db container"
  fi
fi

DURATION=$(( SECONDS - START ))
SIZE="$(dir_bytes "$OUT")"
jq -n --arg ts "$TS" --arg at "$(utc_now)" --arg method "$METHOD" --arg verify "$VERIFY" --arg label "$LABEL" \
  --arg start "$START_LSN" --arg stop "$STOP_LSN" --arg wal "$WAL_FILES" --arg image "$PG_IMAGE" \
  --arg startwal "$START_WAL_FILE" --argjson ranges "$WAL_RANGES" \
  --argjson size "$SIZE" --argjson dur "$DURATION" --argjson warnings "$(warnings_json)" \
  '{ts:$ts, completed_at:$at, method:$method, verification:$verify, label:$label, image:$image,
    start_lsn:$start, stop_lsn:$stop, start_wal_file:$startwal, wal_ranges:$ranges,
    wal_files:($wal|split(" ")|map(select(.!=""))),
    size_bytes:$size, duration_s:$dur, warnings:$warnings,
    restore_hint:(if $method=="sqlapi" then "extract base.tar.gz into PGDATA, extract pg_wal.tar.gz into PGDATA/pg_wal, copy backup_label into PGDATA, mkdir pg_wal/archive_status, start postgres" else "extract base.tar.gz into PGDATA and start postgres" end)}' \
  >"$OUT/backup.json"
chmod 0600 "$OUT/backup.json"
write_sha256sums "$OUT"
mv "$OUT" "$FINAL"
log "base backup complete: $FINAL method=$METHOD $(human "$SIZE") ${DURATION}s verify=$VERIFY"

status_update base "$(jq -nc --arg t "$(utc_now)" --arg dir "$FINAL" --arg method "$METHOD" --arg verify "$VERIFY" \
  --argjson size "$SIZE" --argjson dur "$DURATION" --argjson warnings "$(warnings_json)" \
  '{last_run:$t,last_success:$t,last_result:"ok",dir:$dir,method:$method,verification:$verify,size_bytes:$size,duration_s:$dur,warnings:$warnings,message:"ok"}')"

if (( PRUNE )); then
  "$(bin_dir)/backup-prune.sh" --job base || warn "prune failed"
fi
log "done"
