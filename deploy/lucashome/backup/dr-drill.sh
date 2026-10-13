#!/usr/bin/env bash
# dr-drill.sh — full disaster-recovery drill in a DISPOSABLE environment on the backup host.
#
#   dr-drill.sh run [--phases a,b,c]     run the drill (default: all phases), results in $DRILL_DIR/results
#   dr-drill.sh cleanup                  remove every drill container/network/volume and $DRILL_DIR entirely
#   dr-drill.sh --help
#
# Phases (evidence: docs/selfhost-migration/evidence/G6/):
#   A  encrypted archive path: email-archive.sh --no-send builds the weekly archive from the LIVE
#      database + storage + functions + config, encrypted to a THROWAWAY gpg key (temporary GNUPGHOME
#      in $DRILL_DIR), split into parts; the parts are reassembled with email-unpack.py, verified,
#      decrypted (gpg exit status checked before the output is used), SHA256SUMS checked; a one-byte
#      tamper must be refused by email-unpack.py, and the same tamper with a forged index must be
#      refused by gpg's integrity check. Nothing is mailed (--no-send: no transport is touched).
#   B  restore of that decrypted archive into a fresh disposable Supabase stack (compose project
#      $DRILL_PROJECT: db, rest, auth, storage, functions, gateway; fresh throwaway JWT secret/keys and
#      role passwords, runbook restore-from-email.md §3.2b), then: every public table's row count +
#      md5 equal to live, auth/MFA/storage/migration fingerprints, app_config vs the archive, GoTrue
#      admin API sees the restored users, all storage objects served with the manifest's sha256
#      (verify_objects.py through the disposable gateway), phone-upload-token smoke checks, and the
#      transaction-consistency checks (dr-drill-consistency.sql).
#   C  point-in-time recovery: the base backup that precedes a set of real WAL-recorded events + the
#      WAL archive (mounted read-only) into throwaway postgres containers, one recovery per target
#      (just before the first event, then at each event's commit), each state compared with the
#      expected one; then the NEWEST base + the whole archive (replay to the end) compared with live.
#
# Safety (enforced below): the live stack is only READ — `docker exec` psql sessions run with
# default_transaction_read_only=on, the archive build uses the same read-only `docker compose exec`
# pg_dump the hourly job uses, base backups and the WAL archive are read (the archive is mounted
# :ro). Nothing is written under /srv; no sudo; no image is pulled (pull_policy: never; missing
# images abort the drill). Disposable containers are named $DRILL_PROJECT-*, bound to 127.0.0.1 only,
# memory-limited (sum checked against DRILL_MEM_BUDGET_MB). An EXIT trap removes containers,
# networks, volumes and every plaintext directory; only $DRILL_DIR/results (counts, md5s, timings —
# no row data, no secrets) stays until `cleanup`.
#
# Configuration: environment variables below (no secrets; the drill generates its own throwaway ones).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${DRILL_DIR:=$HOME/phf-drill}"
: "${DRILL_PROJECT:=phf-drill}"
: "${DRILL_PORT:=18000}"                    # disposable gateway, 127.0.0.1 only
: "${DRILL_MIN_AVAIL_MB:=3500}"
: "${DRILL_MEM_BUDGET_MB:=3072}"
: "${DRILL_MEM_DB:=1024m}" "${DRILL_MEM_REST:=128m}" "${DRILL_MEM_AUTH:=128m}" "${DRILL_MEM_STORAGE:=384m}"
: "${DRILL_MEM_FUNCTIONS:=512m}" "${DRILL_MEM_GW:=128m}" "${DRILL_MEM_PITR:=1024m}"
: "${DRILL_ARCHIVE_LABEL:=drill}"
: "${DRILL_PART_BYTES:=4194304}"            # smaller than production's 15 MiB so the split/reassembly is exercised
: "${DRILL_MANIFEST:=$DRILL_DIR/input/storage-manifest.sha256}"   # sha256 manifest of the storage objects (hashes only)
: "${DRILL_BUCKET:=product-images}"
: "${LIVE_STACK_DIR:=/srv/supabase/stack}"
: "${LIVE_COMPOSE_PROJECT:=supabase}"
: "${LIVE_DB_CONTAINER:=supabase-db}"
: "${LIVE_EXPECTED_CONTAINERS:=10}"
: "${LIVE_BASE_DIR:=/srv/supabase/backups/base}"
: "${LIVE_WAL_ARCHIVE:=$LIVE_STACK_DIR/volumes/db/wal_archive}"
: "${UPSTREAM_DOCKER_DIR:=/srv/supabase/upstream/docker}"
: "${IMG_DB:=supabase/postgres:17.6.1.136}" "${IMG_REST:=postgrest/postgrest:v14.17}" "${IMG_AUTH:=supabase/gotrue:v2.196.0}"
: "${IMG_STORAGE:=supabase/storage-api:v1.74.0}" "${IMG_FUNCTIONS:=supabase/edge-runtime:v1.76.2}" "${IMG_GW:=envoyproxy/envoy:v1.39.1}"
# PITR events: rows "label|xid" read from LIVE (read-only); default = the three transactions of the
# 080 rollout (2026-10-13): 080 DDL (creates public.app_config), 080 recorded in the history, the
# app_config row inserted by the operator. pg_type.xmin of the table's row type = the creating xid.
: "${PITR_EVENTS_SQL:=SELECT '080 DDL (creates public.app_config)', xmin FROM pg_type WHERE oid = (SELECT reltype FROM pg_class WHERE oid = 'public.app_config'::regclass) UNION ALL SELECT '080 recorded in supabase_migrations', xmin FROM supabase_migrations.schema_migrations WHERE version = '080' UNION ALL SELECT 'app_config row inserted', xmin FROM public.app_config}"
: "${PITR_PROBE_SQL:=SELECT 'app_config=' || CASE WHEN to_regclass('public.app_config') IS NULL THEN 'absent' ELSE 'rows:' || (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.app_config', false, true, '')))[1]::text || ':md5:' || (xpath('/row/m/text()', query_to_xml('SELECT md5(coalesce(json_agg(c ORDER BY c.key)::text, '''')) AS m FROM public.app_config c', false, true, '')))[1]::text END || '|max_version=' || (SELECT max(version) FROM supabase_migrations.schema_migrations)}"
# expected probe per recovery, ';'-separated: first = just before the first event, then one per event;
# LIVE = the live database's probe value
: "${PITR_EXPECT:=app_config=absent|max_version=079;app_config=rows:0:md5:d41d8cd98f00b204e9800998ecf8427e|max_version=079;app_config=rows:0:md5:d41d8cd98f00b204e9800998ecf8427e|max_version=080;LIVE}"

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }
CMD="${1:-}"; [[ $# -gt 0 ]] && shift
PHASES="a,b,c"
while (( $# )); do
  case "$1" in
    --phases) PHASES="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
case "$CMD" in run|cleanup) ;; -h|--help|"") usage; exit 0 ;; *) usage >&2; exit 2 ;; esac

# ---------------------------------------------------------------------------
# guards: the drill dir and project name can never point at production
[[ "$DRILL_DIR" =~ ^$HOME/phf-drill[A-Za-z0-9_-]*$ ]] || { echo "DRILL_DIR must be \$HOME/phf-drill*" >&2; exit 2; }
[[ "$DRILL_PROJECT" =~ ^phf-drill[a-z0-9-]*$ && "$DRILL_PROJECT" != "$LIVE_COMPOSE_PROJECT" ]] || { echo "DRILL_PROJECT must be phf-drill*" >&2; exit 2; }
[[ "$DRILL_PORT" =~ ^[0-9]+$ ]] || { echo "DRILL_PORT invalid" >&2; exit 2; }

# backup-lib.sh / email-lib.sh get a private state tree; production backup.env/status are never read or written
export BACKUP_ENV="$DRILL_DIR/no-such-backup.env"
export BACKUP_ROOT="$DRILL_DIR/backuproot"
export RESTORE_TEST_DIR="$BACKUP_ROOT/restore-test" STATUS_FILE="$BACKUP_ROOT/status.json"
export LOG_DIR="$BACKUP_ROOT/logs" LOCK_DIR="$BACKUP_ROOT/.locks"
export STACK_DIR="$LIVE_STACK_DIR" BASE_DIR="$LIVE_BASE_DIR" WAL_ARCHIVE_DIR="$LIVE_WAL_ARCHIVE"
export PG_IMAGE="$IMG_DB" THROWAWAY_MEMORY="$DRILL_MEM_PITR" THROWAWAY_READY_TIMEOUT=300
JOB_NAME=dr-drill
# shellcheck source=backup-lib.sh
. "$HERE/backup-lib.sh"
[[ ! -e "$BACKUP_ENV" ]] || die "$BACKUP_ENV must not exist"

R="$DRILL_DIR/results"
S="$DRILL_DIR/stack"
X="$DRILL_DIR/plain/x"            # decrypted + extracted archive payload (plaintext; removed by the trap)
GNUPG="$DRILL_DIR/gnupg"           # throwaway key (removed by the trap)
GW="http://127.0.0.1:$DRILL_PORT"
FAILS=0

# ---------------------------------------------------------------------------
# results + timings (no row data, no secrets)
result() {  # PHASE CHECK EXPECTED ACTUAL  -> PASS when equal
  local st=PASS; [[ "$3" == "$4" ]] || { st=FAIL; FAILS=$(( FAILS + 1 )); }
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$st" >>"$R/results.tsv"
  log "[$1] $st $2: expected=$3 actual=$4"
}
result_ok() {  # PHASE CHECK OK(0/1) DETAIL
  local st=PASS; [[ "$3" == 1 ]] || { st=FAIL; FAILS=$(( FAILS + 1 )); }
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "-" "$4" "$st" >>"$R/results.tsv"
  log "[$1] $st $2: $4"
}
info() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "-" "$3" "INFO" >>"$R/results.tsv"; log "[$1] INFO $2: $3"; }
declare -A T0
t_start() { T0[$1]=$(date +%s.%N); }
t_end() {  # NAME [PHASE]
  local d; d="$(awk -v a="$(date +%s.%N)" -v b="${T0[$1]}" 'BEGIN { printf "%.1f", a - b }')"
  printf '%s\t%s\t%s\n' "${2:-}" "$1" "$d" >>"$R/timings.tsv"; log "timing $1: ${d}s"
}

# ---------------------------------------------------------------------------
# database access
live_sql() {  # ARGS...  read-only session on the LIVE database (stdin passed through)
  docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$LIVE_DB_CONTAINER" \
    psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -Atq "$@"
}
drill_sql() {  # DB ARGS...  (stdin passed through)
  local db="$1"; shift
  docker exec -i "$DRILL_PROJECT-db" psql -X -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 -Atq "$@"
}
tw_sql_file() { docker exec -i "$TW_NAME" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -Atq <"$1"; }

dc() {  # docker compose for the DISPOSABLE project only
  [[ "$DRILL_PROJECT" != "$LIVE_COMPOSE_PROJECT" ]] || die "refusing compose on the live project"
  env -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME docker compose -p "$DRILL_PROJECT" --project-directory "$S" \
    -f "$S/docker-compose.yml" --env-file "$S/.env" "$@"
}

wait_healthy() {  # CONTAINER TIMEOUT_S
  local c="$1" deadline=$(( SECONDS + $2 )) h
  while (( SECONDS < deadline )); do
    h="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)"
    [[ "$h" == healthy ]] && return 0
    [[ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" =~ ^(exited|dead)$ ]] && break
    sleep 2
  done
  log "$c not healthy after $2 s (state: $h); last log lines:"; docker logs --tail 30 "$c" 2>&1 | sed 's/^/  /' >&2 || true
  return 1
}

fp_get() { awk -F'|' -v k="$2" '$1 == k { sub(/^[^|]*\|/, ""); print; exit }' "$1"; }
# fp_diff A B [counts] -> comma-separated items whose value differs (counts: compare the count column only)
fp_diff() {
  awk -F'|' -v mode="${3:-full}" 'NR == FNR { a[$1] = (mode == "counts" ? $2 : $2 "|" $3); next }
    { v = (mode == "counts" ? $2 : $2 "|" $3); if (!($1 in a) || a[$1] != v) d = d (d ? "," : "") $1; seen[$1] = 1 }
    END { for (k in a) if (!(k in seen)) d = d (d ? "," : "") k; print d }' "$1" "$2"
}
# compare two fingerprint files (item|count|md5) -> one result per item
compare_fp() {  # PHASE LABEL EXPECTED_FILE ACTUAL_FILE [ALT_EXPECTED_FILE]
  local ph="$1" label="$2" exp="$3" act="$4" alt="${5:-}" item e a e2
  while IFS='|' read -r item _; do
    e="$(fp_get "$exp" "$item")"; a="$(fp_get "$act" "$item")"
    if [[ -n "$alt" && "$e" != "$a" ]]; then
      e2="$(fp_get "$alt" "$item")"
      if [[ "$e2" == "$a" ]]; then e="$e2"; fi   # live changed during the dump window; the restore matches the other side
    fi
    result "$ph" "$label $item (count|md5)" "$e" "$a"
  done <"$exp"
}

# ---------------------------------------------------------------------------
# cleanup: containers, networks, volumes, plaintext; results stay until `cleanup`
force_rm() {  # DIR... — rm -rf, falling back to a container chown for files a container created
  local d
  for d in "$@"; do
    [[ -e "$d" ]] || continue
    case "$d" in "$DRILL_DIR"/*|"$DRILL_DIR") ;; *) die "force_rm: $d is outside $DRILL_DIR" ;; esac
    rm -rf -- "$d" 2>/dev/null || {
      docker run --rm --network none --memory 128m -v "$d:/x" --entrypoint chown "$IMG_DB" -R "$(id -u):$(id -g)" /x >/dev/null 2>&1 || true
      rm -rf -- "$d"
    }
  done
}
teardown() {
  local c
  if [[ -f "$S/docker-compose.yml" && -f "$S/.env" ]]; then dc down -v --remove-orphans --timeout 20 >/dev/null 2>&1 || true; fi
  for c in $(docker ps -a --format '{{.Names}}' | grep -E "^$DRILL_PROJECT-" || true); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for c in $(docker network ls --format '{{.Name}}' | grep -E "^${DRILL_PROJECT}_" || true); do docker network rm "$c" >/dev/null 2>&1 || true; done
  for c in $(docker volume ls --format '{{.Name}}' | grep -E "^${DRILL_PROJECT}_" || true); do docker volume rm -f "$c" >/dev/null 2>&1 || true; done
  tw_cleanup >/dev/null 2>&1 || true
  force_rm "$DRILL_DIR/plain" "$DRILL_DIR/unpacked" "$DRILL_DIR/mailbox" "$DRILL_DIR/tamper1" "$DRILL_DIR/tamper2" \
    "$DRILL_DIR/restore" "$DRILL_DIR/waldump" "$DRILL_DIR/archive" "$GNUPG" "$DRILL_DIR/cred" "$S" "$BACKUP_ROOT/restore-test" \
    "$BACKUP_ROOT/.tmp" "$DRILL_DIR/verify"
}

if [[ "$CMD" == cleanup ]]; then
  teardown
  force_rm "$DRILL_DIR"
  left="$(docker ps -a --format '{{.Names}}' | grep -cE "^$DRILL_PROJECT-" || true)"
  echo "cleanup: drill containers left=$left networks left=$(docker network ls --format '{{.Name}}' | grep -cE "^${DRILL_PROJECT}_" || true) volumes left=$(docker volume ls --format '{{.Name}}' | grep -cE "^${DRILL_PROJECT}_" || true) dir present=$( [[ -e $DRILL_DIR ]] && echo yes || echo no)"
  exit 0
fi

# ===========================================================================
# run
# ===========================================================================
mkdir -p "$DRILL_DIR" "$R" "$BACKUP_ROOT" && chmod 0700 "$DRILL_DIR" "$BACKUP_ROOT"
: >"$R/results.tsv"; : >"$R/timings.tsv"
init_logging
LOG_FILE="$R/dr-drill.log"; : >"$LOG_FILE"
on_exit() {
  local rc=$?
  trap - EXIT
  log "teardown (rc=$rc)"
  teardown
  log "drill finished: $FAILS failed check(s); results in $R"
  exit "$rc"
}
trap on_exit EXIT
t_start total

# ---------------------------------------------------------------------------
# preflight
avail="$(free -m | awk '/^Mem:/{print $7}')"
log "preflight: available memory ${avail} MB (need >= $DRILL_MIN_AVAIL_MB)"
(( avail >= DRILL_MIN_AVAIL_MB )) || die "not enough available memory"
to_mb() { local v="${1%m}"; echo "$v"; }
budget=$(( $(to_mb "$DRILL_MEM_DB") + $(to_mb "$DRILL_MEM_REST") + $(to_mb "$DRILL_MEM_AUTH") + $(to_mb "$DRILL_MEM_STORAGE") + $(to_mb "$DRILL_MEM_FUNCTIONS") + $(to_mb "$DRILL_MEM_GW") ))
(( budget <= DRILL_MEM_BUDGET_MB && $(to_mb "$DRILL_MEM_PITR") <= DRILL_MEM_BUDGET_MB )) || die "memory limits ($budget MB) exceed DRILL_MEM_BUDGET_MB"
if ss -tlnH | awk '{print $4}' | grep -qE "[:.]$DRILL_PORT\$"; then die "port $DRILL_PORT is in use"; fi
for img in "$IMG_DB" "$IMG_REST" "$IMG_AUTH" "$IMG_STORAGE" "$IMG_FUNCTIONS" "$IMG_GW"; do
  docker image inspect "$img" >/dev/null 2>&1 || die "image $img not present (the drill never pulls)"
done
[[ -z "$(docker ps -a --format '{{.Names}}' | grep -E "^$DRILL_PROJECT-" || true)" ]] || die "leftover $DRILL_PROJECT-* containers; run cleanup first"
docker container inspect "$LIVE_DB_CONTAINER" >/dev/null || die "live db container $LIVE_DB_CONTAINER not found"
info pre "memory available (MB)" "$avail"
info pre "disposable memory limits (MB): stack / pitr" "$budget / $(to_mb "$DRILL_MEM_PITR")"

live_state() {  # PREFIX — container health + identity (start time, restarts) + fingerprint + archiver
  local p="$1"
  docker ps -a --filter "label=com.docker.compose.project=$LIVE_COMPOSE_PROJECT" --format '{{.Names}}' | LC_ALL=C sort | while read -r c; do
    docker inspect -f '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.Id}}' "$c"
  done >"$R/$p.containers"
  live_sql <"$HERE/dr-drill-fingerprint.sql" >"$R/$p.fp"
  live_sql <"$HERE/dr-drill-consistency.sql" >"$R/$p.consistency"
  live_sql -c "SELECT current_setting('archive_mode'), current_setting('archive_timeout'), last_archived_wal,
      to_char(last_archived_time AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), failed_count,
      to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM pg_stat_archiver" >"$R/$p.archiver"
}
t_start live-before; live_state live-before; t_end live-before pre
healthy="$(grep -c '|running|healthy|' "$R/live-before.containers" || true)"
result pre "live stack containers running+healthy" "$LIVE_EXPECTED_CONTAINERS/$LIVE_EXPECTED_CONTAINERS" "$healthy/$(wc -l <"$R/live-before.containers")"
info pre "live archiver (mode|timeout|last wal|last archived|failed|now)" "$(cat "$R/live-before.archiver")"
(( healthy == LIVE_EXPECTED_CONTAINERS )) || die "live stack is not fully healthy; not starting a drill"

has_phase() { [[ ",$PHASES," == *",$1,"* ]]; }

# ===========================================================================
# A. encrypted archive path
# ===========================================================================
ID=""
phase_a() {
  log "=== phase A: encrypted archive (build, split, reassemble, verify, tamper, decrypt) ==="
  t_start A-keygen
  mkdir -p "$GNUPG" "$DRILL_DIR/cred" && chmod 0700 "$GNUPG" "$DRILL_DIR/cred"
  gpg --homedir "$GNUPG" --batch --no-tty --passphrase '' --quick-gen-key \
    "DR drill throwaway $(ts_now) <dr-drill@example.invalid>" default default 2d >/dev/null 2>&1 || die "throwaway key generation failed"
  local fpr; fpr="$(gpg --homedir "$GNUPG" --batch --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')"
  gpg --homedir "$GNUPG" --batch --armor --export "$fpr" >"$DRILL_DIR/cred/drill.pub.asc"
  info A "throwaway recipient key (temporary GNUPGHOME, destroyed at teardown)" "$fpr"
  t_end A-keygen A

  # build from LIVE data. Every mail setting points nowhere; --no-send never reaches the transport.
  local week; week="$(date -u +%G-W%V)"
  live_sql <"$HERE/dr-drill-fingerprint.sql" >"$R/live-before-dump.fp"
  t_start A-build
  if ! env EMAIL_ENABLED=false MAIL_TRANSPORT=smtp SMTP_URL=smtp://127.0.0.1:9 SMTP_NETRC_FILE=none \
      RESEND_API_URL=http://127.0.0.1:9/ RESEND_KEY_FILE=/nonexistent MAIL_FROM= ARCHIVE_MAIL_TO= ALERT_MAIL_TO= \
      ARCHIVE_GPG_PUBKEY="$DRILL_DIR/cred/drill.pub.asc" ARCHIVE_GPG_FPR="$fpr" ARCHIVE_LABEL="$DRILL_ARCHIVE_LABEL" \
      ARCHIVE_PART_BYTES="$DRILL_PART_BYTES" STORAGE_DIR="$LIVE_STACK_DIR/volumes/storage" \
      "$HERE/email-archive.sh" --no-send --output-dir "$DRILL_DIR/archive" --week "$week" >"$R/email-archive.log" 2>&1; then
    tail -20 "$R/email-archive.log" >&2; die "archive build failed"
  fi
  t_end A-build A
  live_sql <"$HERE/dr-drill-fingerprint.sql" >"$R/live-after-dump.fp"
  info A "live fingerprint before vs after the dump (items differing)" "$(fp_diff "$R/live-before-dump.fp" "$R/live-after-dump.fp" | sed 's/^$/none: static during the dump window/')"
  ID="$DRILL_ARCHIVE_LABEL-$week"
  local B="$DRILL_DIR/archive/$ID"
  [[ -f "$B/index.json" ]] || die "no build at $B"
  local nparts; nparts="$(jq -r .part_count "$B/index.json")"
  info A "archive id / parts / encrypted bytes / payload bytes" "$ID / $nparts / $(jq -r .total_bytes "$B/index.json") / $(jq -r .payload_bytes "$B/index.json")"
  result_ok A "archive split into more than one part (part size $DRILL_PART_BYTES)" "$(( nparts > 1 ))" "$nparts parts"
  result A "no mail sent: build log has no send/accepted lines" "0" "$(grep -cE 'accepted|part [0-9]+/[0-9]+ NOT|sent:' "$R/email-archive.log" || true)"
  result A "plaintext staging removed by email-archive.sh" "0" "$(find "$DRILL_DIR/archive/.tmp" -mindepth 1 2>/dev/null | wc -l)"
  result_ok A "OpenPGP packets: public-key, integrity-protected (gpg_integrity_ok)" "$(bash -c ". '$HERE/email-lib.sh' >/dev/null 2>&1; gpg_integrity_ok '$B/$ID.tar.gpg.001'" && echo 1 || echo 0)" "part 001 checked"

  # the mailbox: what the owner downloads (parts + <id>.index.json from any part mail)
  local MB="$DRILL_DIR/mailbox"; mkdir -p "$MB"
  cp "$B/$ID".tar.gpg.[0-9][0-9][0-9] "$MB/"; cp "$B/index.json" "$MB/$ID.index.json"
  t_start A-unpack
  python3 -I "$HERE/email-unpack.py" --list "$MB" >"$R/unpack-list.txt" 2>&1 || true
  local rc=0
  python3 -I "$HERE/email-unpack.py" --out "$DRILL_DIR/unpacked" "$MB" >"$R/unpack.txt" 2>&1 || rc=$?
  t_end A-unpack A
  result A "email-unpack.py reassembles + verifies every part and the total (exit)" 0 "$rc"
  result A "email-unpack.py: parts ok" "$nparts" "$(grep -c '^ok   part' "$R/unpack.txt" || true)"

  # tamper 1: one byte flipped in the middle of the last part -> unpack refuses
  local T1="$DRILL_DIR/tamper1" last; mkdir -p "$T1"; cp "$MB"/* "$T1/"
  last="$(cd "$T1" && find . -maxdepth 1 -name "$ID.tar.gpg.[0-9][0-9][0-9]" -printf '%f\n' | LC_ALL=C sort | tail -1)"
  python3 -I -c 'import sys; p=sys.argv[1]; b=bytearray(open(p,"rb").read()); b[len(b)//2]^=1; open(p,"wb").write(b)' "$T1/$last"
  rc=0; python3 -I "$HERE/email-unpack.py" --out "$T1/out" "$T1" >"$R/tamper1.txt" 2>&1 || rc=$?
  result_ok A "one-byte tamper in $last: email-unpack.py refuses (exit 1, MISMATCH, nothing written)" \
    "$( (( rc == 1 )) && grep -q 'MISMATCH' "$R/tamper1.txt" && [[ ! -e "$T1/out/$ID.tar.gpg" ]] && echo 1 || echo 0)" "exit $rc: $(grep -m1 FAIL "$R/tamper1.txt" | cut -c1-90)"
  # tamper 2: same flip, index forged to match -> unpack passes, gpg's MDC/AEAD check must fail
  local T2="$DRILL_DIR/tamper2"; mkdir -p "$T2/in"; cp "$T1/$ID".tar.gpg.[0-9][0-9][0-9] "$T2/in/"
  python3 -I - "$MB/$ID.index.json" "$T2/in" "$T2/in/$ID.index.json" <<'PY'
import hashlib, json, os, sys
src, d, out = sys.argv[1:4]
ix = json.load(open(src)); whole = b""
for p in ix["parts"]:
    b = open(os.path.join(d, p["file"]), "rb").read(); p["sha256"] = hashlib.sha256(b).hexdigest(); p["bytes"] = len(b); whole += b
ix["total_sha256"] = hashlib.sha256(whole).hexdigest(); ix["total_bytes"] = len(whole)
json.dump(ix, open(out, "w"))
PY
  rc=0; python3 -I "$HERE/email-unpack.py" --out "$T2/out" "$T2/in" >"$R/tamper2-unpack.txt" 2>&1 || rc=$?
  info A "forged index (hashes recomputed by an attacker): email-unpack.py exit" "$rc (expected 0: the index is not authenticated; gpg is the last line)"
  local grc=0
  gpg --homedir "$GNUPG" --batch --no-tty --yes --output "$T2/out/forged.tar" --decrypt "$T2/out/$ID.tar.gpg" >"$R/tamper2-gpg.txt" 2>&1 || grc=$?
  rm -f "$T2/out/forged.tar"     # untrusted output is deleted whatever gpg said
  result_ok A "forged index + tampered byte: gpg decryption fails (exit != 0, integrity error)" "$( (( rc == 0 && grc != 0 )) && echo 1 || echo 0)" \
    "gpg exit $grc: $(grep -m1 -iE 'manipulated|mdc|integrity|authentication|decryption failed|invalid packet' "$R/tamper2-gpg.txt" | sed 's/^gpg: //' | cut -c1-90)"
  force_rm "$T1" "$T2"

  # decrypt to a FILE, check gpg's exit status BEFORE using the output
  t_start A-decrypt
  mkdir -p "$DRILL_DIR/plain" && chmod 0700 "$DRILL_DIR/plain"
  grc=0; gpg --homedir "$GNUPG" --batch --no-tty --output "$DRILL_DIR/plain/archive.tar" --decrypt "$DRILL_DIR/unpacked/$ID.tar.gpg" >"$R/decrypt.txt" 2>&1 || grc=$?
  result A "gpg decrypt of the reassembled archive (exit, checked before extracting)" 0 "$grc"
  (( grc == 0 )) || { rm -f "$DRILL_DIR/plain/archive.tar"; die "decryption failed; plaintext deleted"; }
  mkdir -p "$X" && tar -C "$X" -xf "$DRILL_DIR/plain/archive.tar" && rm -f "$DRILL_DIR/plain/archive.tar"
  rc=0; (cd "$X" && sha256sum --quiet -c SHA256SUMS) >"$R/sha256sums.txt" 2>&1 || rc=$?
  t_end A-decrypt A
  result A "payload SHA256SUMS (sha256sum -c, exit)" 0 "$rc"
  result A "payload files covered by SHA256SUMS" "$(cd "$X" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.json | wc -l)" "$(wc -l <"$X/SHA256SUMS")"
  local f missing=""
  for f in db/postgres.dump db/_supabase.dump db/globals.sql db/db-settings.sql db/counts.json db/app_config.json \
           files/storage.tar.gz files/functions.tar.gz config/docker-compose.override.yml config/.supabase-version \
           config/custom-conf.d/10-wal-archive.conf config/pg_hba.conf MANIFEST.json; do
    [[ -s "$X/$f" ]] || missing+="$f "
  done
  result A "payload has dumps, roles, settings, counts, app_config, storage, functions, config, manifest" "none missing" "${missing:-none missing}"
  result A "payload carries no .env / key material (file names)" "0" "$(tar -tzf "$X/files/functions.tar.gz" | cat - <(cd "$X" && find . -type f) | grep -ciE '(^|/)\.env|pgsodium_root\.key|\.pem$|SECRET' || true)"
  result A "storage files in the archive = files in the live storage tree" "$(find "$LIVE_STACK_DIR/volumes/storage" -type f ! -name .gitkeep | wc -l)" "$(tar -tzf "$X/files/storage.tar.gz" | grep -v '/$' | grep -vc '\.gitkeep$')"
  # MANIFEST counts vs live
  local key lv
  for key in auth_users auth_mfa_factors storage_objects schema_version migrations products organizations sales tables_public; do
    case "$key" in
      auth_users) lv="$(live_sql -c 'select count(*) from auth.users')" ;;
      auth_mfa_factors) lv="$(live_sql -c 'select count(*) from auth.mfa_factors')" ;;
      storage_objects) lv="$(live_sql -c 'select count(*) from storage.objects')" ;;
      schema_version) lv="$(live_sql -c 'select max(version) from supabase_migrations.schema_migrations')" ;;
      migrations) lv="$(live_sql -c 'select count(*) from supabase_migrations.schema_migrations')" ;;
      products) lv="$(live_sql -c 'select count(*) from public.products')" ;;
      organizations) lv="$(live_sql -c 'select count(*) from public.organizations')" ;;
      sales) lv="$(live_sql -c 'select count(*) from public.sales')" ;;
      tables_public) lv="$(live_sql -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')")" ;;
    esac
    result A "MANIFEST.json counts.$key = live" "$lv" "$(jq -r --arg k "$key" '.counts[$k]' "$X/MANIFEST.json")"
  done
}

# ===========================================================================
# B. restore into a fresh disposable stack
# ===========================================================================
write_stack() {
  mkdir -p "$S/initdb" "$S/envoy" "$DRILL_DIR/restore/storage" "$DRILL_DIR/restore/functions"
  local f
  for f in realtime webhooks roles jwt _supabase logs pooler; do cp "$UPSTREAM_DOCKER_DIR/volumes/db/$f.sql" "$S/initdb/"; done
  for f in envoy.yaml cds.yaml lds.template.yaml docker-entrypoint.sh; do cp "$UPSTREAM_DOCKER_DIR/volumes/api/envoy/$f" "$S/envoy/"; done
  tar -C "$DRILL_DIR/restore/storage" -xzf "$X/files/storage.tar.gz"
  tar -C "$DRILL_DIR/restore/functions" -xzf "$X/files/functions.tar.gz"
  # backup-lib.sh sets umask 077; the containers' own users (postgres, envoy, deno) must read these
  # bind mounts. $DRILL_DIR itself stays 0700, so nothing becomes readable for other host users.
  chmod -R a+rX "$S/initdb" "$S/envoy" "$DRILL_DIR/restore" "$X/db"
  # fresh throwaway secrets (runbook §3.2b); never the live ones
  ( umask 077; python3 -I - "$DRILL_PORT" >"$S/.env" <<'PY'
import base64, hashlib, hmac, json, secrets, sys, time
port = sys.argv[1]; jwt = secrets.token_hex(32); now = int(time.time())
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def tok(role):
    h = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    p = b64(json.dumps({"role": role, "iss": "supabase", "iat": now, "exp": now + 2 * 86400}, separators=(",", ":")).encode())
    return f"{h}.{p}." + b64(hmac.new(jwt.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
print(f"POSTGRES_PASSWORD={secrets.token_hex(24)}")
print(f"JWT_SECRET={jwt}")
print(f"ANON_KEY={tok('anon')}")
print(f"SERVICE_ROLE_KEY={tok('service_role')}")
print(f"DASHBOARD_PASSWORD={secrets.token_hex(16)}")
print(f"DRILL_PUBLIC_URL=http://127.0.0.1:{port}")
PY
  )
  printf 'DRILL_PORT=%s\nIMG_DB=%s\nIMG_REST=%s\nIMG_AUTH=%s\nIMG_STORAGE=%s\nIMG_FUNCTIONS=%s\nIMG_GW=%s\n' \
    "$DRILL_PORT" "$IMG_DB" "$IMG_REST" "$IMG_AUTH" "$IMG_STORAGE" "$IMG_FUNCTIONS" "$IMG_GW" >>"$S/.env"
  printf 'MEM_DB=%s\nMEM_REST=%s\nMEM_AUTH=%s\nMEM_STORAGE=%s\nMEM_FUNCTIONS=%s\nMEM_GW=%s\nP=%s\n' \
    "$DRILL_MEM_DB" "$DRILL_MEM_REST" "$DRILL_MEM_AUTH" "$DRILL_MEM_STORAGE" "$DRILL_MEM_FUNCTIONS" "$DRILL_MEM_GW" "$DRILL_PROJECT" >>"$S/.env"
  chmod 0600 "$S/.env"
  # Disposable stack: upstream v0.8.2 service definitions (docker-compose.yml) reduced to what the
  # restore needs, renamed, memory-limited, gateway on 127.0.0.1:$DRILL_PORT, no pulls, no SMTP.
  cat >"$S/docker-compose.yml" <<'YAML'
services:
  db:
    container_name: ${P}-db
    image: ${IMG_DB}
    pull_policy: never
    mem_limit: ${MEM_DB}
    volumes:
      - ./initdb/realtime.sql:/docker-entrypoint-initdb.d/migrations/99-realtime.sql:ro
      - ./initdb/webhooks.sql:/docker-entrypoint-initdb.d/init-scripts/98-webhooks.sql:ro
      - ./initdb/roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro
      - ./initdb/jwt.sql:/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:ro
      - ./initdb/_supabase.sql:/docker-entrypoint-initdb.d/migrations/97-_supabase.sql:ro
      - ./initdb/logs.sql:/docker-entrypoint-initdb.d/migrations/99-logs.sql:ro
      - ./initdb/pooler.sql:/docker-entrypoint-initdb.d/migrations/99-pooler.sql:ro
      - ../plain/x/db:/restore:ro
      - db-data:/var/lib/postgresql/data
      - db-config:/etc/postgresql-custom
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres", "-h", "localhost"]
      interval: 5s
      timeout: 5s
      retries: 20
    environment:
      POSTGRES_HOST: /var/run/postgresql
      PGPORT: "5432"
      POSTGRES_PORT: "5432"
      PGPASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      PGDATABASE: postgres
      POSTGRES_DB: postgres
      JWT_EXP: "3600"
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "log_min_messages=fatal"]

  rest:
    container_name: ${P}-rest
    image: ${IMG_REST}
    pull_policy: never
    mem_limit: ${MEM_REST}
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "postgrest", "--ready"]
      interval: 5s
      timeout: 5s
      retries: 10
    environment:
      PGRST_DB_URI: postgres://authenticator:${POSTGRES_PASSWORD}@db:5432/postgres
      PGRST_DB_SCHEMAS: public,graphql_public
      PGRST_DB_MAX_ROWS: "1000"
      PGRST_DB_EXTRA_SEARCH_PATH: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_ADMIN_SERVER_PORT: "3001"
      PGRST_ADMIN_SERVER_HOST: localhost
      PGRST_JWT_SECRET: ${JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: "false"
      PGRST_APP_SETTINGS_JWT_EXP: "3600"
    command: ["postgrest"]

  auth:
    container_name: ${P}-auth
    image: ${IMG_AUTH}
    pull_policy: never
    mem_limit: ${MEM_AUTH}
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:9999/health"]
      interval: 5s
      timeout: 5s
      retries: 10
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: "9999"
      API_EXTERNAL_URL: ${DRILL_PUBLIC_URL}/auth/v1
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:${POSTGRES_PASSWORD}@db:5432/postgres
      GOTRUE_SITE_URL: ${DRILL_PUBLIC_URL}
      GOTRUE_DISABLE_SIGNUP: "true"
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_EXP: "3600"
      GOTRUE_JWT_SECRET: ${JWT_SECRET}
      GOTRUE_JWT_ISSUER: ${DRILL_PUBLIC_URL}/auth/v1
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"
      GOTRUE_MAILER_AUTOCONFIRM: "true"
      GOTRUE_EXTERNAL_PHONE_ENABLED: "false"
      GOTRUE_SMS_AUTOCONFIRM: "false"
      GOTRUE_MFA_TOTP_ENROLL_ENABLED: "true"
      GOTRUE_MFA_TOTP_VERIFY_ENABLED: "true"
      GOTRUE_MFA_MAX_ENROLLED_FACTORS: "10"
      GOTRUE_PASSWORD_MIN_LENGTH: "6"

  storage:
    container_name: ${P}-storage
    image: ${IMG_STORAGE}
    pull_policy: never
    mem_limit: ${MEM_STORAGE}
    depends_on:
      db:
        condition: service_healthy
      rest:
        condition: service_started
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://storage:5000/status"]
      interval: 5s
      timeout: 5s
      retries: 10
    environment:
      ANON_KEY: ${ANON_KEY}
      SERVICE_KEY: ${SERVICE_ROLE_KEY}
      POSTGREST_URL: http://rest:3000
      AUTH_JWT_SECRET: ${JWT_SECRET}
      DATABASE_URL: postgres://supabase_storage_admin:${POSTGRES_PASSWORD}@db:5432/postgres
      STORAGE_PUBLIC_URL: ${DRILL_PUBLIC_URL}
      REQUEST_ALLOW_X_FORWARDED_PATH: "true"
      FILE_SIZE_LIMIT: "52428800"
      STORAGE_BACKEND: file
      GLOBAL_S3_BUCKET: stub
      FILE_STORAGE_BACKEND_PATH: /var/lib/storage
      TENANT_ID: stub
      REGION: stub
      ENABLE_IMAGE_TRANSFORMATION: "false"
    volumes:
      - ../restore/storage:/var/lib/storage:ro

  functions:
    container_name: ${P}-functions
    image: ${IMG_FUNCTIONS}
    pull_policy: never
    mem_limit: ${MEM_FUNCTIONS}
    depends_on:
      api-gw:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "timeout 1 bash -c '</dev/tcp/127.0.0.1/9000'"]
      interval: 5s
      timeout: 5s
      retries: 10
    volumes:
      - ../restore/functions:/home/deno/functions:ro
      - deno-cache:/root/.cache/deno
    environment:
      JWT_SECRET: ${JWT_SECRET}
      SUPABASE_URL: http://api-gw:8000
      SUPABASE_PUBLIC_URL: ${DRILL_PUBLIC_URL}
      SUPABASE_ANON_KEY: ${ANON_KEY}
      SUPABASE_SERVICE_ROLE_KEY: ${SERVICE_ROLE_KEY}
      SUPABASE_PUBLISHABLE_KEYS: '{"default":""}'
      SUPABASE_SECRET_KEYS: '{"default":""}'
      SUPABASE_DB_URL: postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres
      VERIFY_JWT: "true"
    command: ["start", "--main-service", "/home/deno/functions/main"]

  api-gw:
    container_name: ${P}-gw
    image: ${IMG_GW}
    pull_policy: never
    mem_limit: ${MEM_GW}
    networks:
      default:
        aliases: [envoy, kong]
    ports:
      - "127.0.0.1:${DRILL_PORT}:8000/tcp"
    healthcheck:
      test: ["CMD-SHELL", "timeout 1 bash -c '</dev/tcp/127.0.0.1/8000'"]
      interval: 5s
      timeout: 5s
      retries: 10
    volumes:
      - ./envoy/envoy.yaml:/etc/envoy/envoy.yaml:ro
      - ./envoy/cds.yaml:/etc/envoy/cds.yaml:ro
      - ./envoy/lds.template.yaml:/etc/envoy/lds.template.yaml:ro
      - ./envoy/docker-entrypoint.sh:/docker-entrypoint.sh:ro
    environment:
      ANON_KEY: ${ANON_KEY}
      SERVICE_ROLE_KEY: ${SERVICE_ROLE_KEY}
      SUPABASE_PUBLISHABLE_KEY: ""
      SUPABASE_SECRET_KEY: ""
      ANON_KEY_ASYMMETRIC: ""
      SERVICE_ROLE_KEY_ASYMMETRIC: ""
      SUPABASE_PUBLIC_URL: ${DRILL_PUBLIC_URL}
      DASHBOARD_USERNAME: drill
      DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}
    entrypoint: ["/bin/sh", "/docker-entrypoint.sh"]

volumes:
  db-data:
  db-config:
  deno-cache:
YAML
}

envval() { grep -E "^$1=" "$S/.env" | head -1 | cut -d= -f2-; }   # value stays in shell variables, never printed

phase_b() {
  log "=== phase B: restore the decrypted archive into a fresh disposable stack ==="
  [[ -f "$X/db/postgres.dump" ]] || die "phase B needs phase A's decrypted payload"
  t_start B-restore-to-serving
  t_start B-prepare; write_stack; dc config --quiet; t_end B-prepare B
  result B "disposable compose project validates; gateway bound to" "127.0.0.1:$DRILL_PORT" "$(dc config --format json | jq -r '.services["api-gw"].ports[0] | "\(.host_ip):\(.published)"')"

  t_start B-db-init
  dc up -d db >"$R/compose-db.log" 2>&1
  wait_healthy "$DRILL_PROJECT-db" 300 || die "disposable db did not become healthy"
  # the image's init runs a temporary server first; wait for the final one
  local i; for i in $(seq 1 60); do docker logs "$DRILL_PROJECT-db" 2>&1 | grep -q 'PostgreSQL init process complete' && break; sleep 2; done
  sleep 3; wait_healthy "$DRILL_PROJECT-db" 120
  t_end B-db-init B

  # ---- restore (runbook restore-from-email.md §3.4) ----
  t_start B-db-restore
  # like the runbook: no ON_ERROR_STOP here, the bootstrap roles already exist and every other statement must still run
  docker exec "$DRILL_PROJECT-db" psql -X -U supabase_admin -d postgres -q -f /restore/globals.sql >/dev/null 2>"$R/restore-globals.err" </dev/null || true
  info B "globals.sql: 'role already exists' errors (expected for the image's bootstrap roles)" "$(grep -cE 'role "[^"]+" already exists' "$R/restore-globals.err" || true)"
  local unexpected; unexpected="$(grep -E 'ERROR' "$R/restore-globals.err" | grep -vcE 'role "[^"]+" already exists' || true)"
  result B "globals.sql: errors other than 'role already exists'" 0 "$unexpected"
  drill_sql template1 -c "ALTER DATABASE postgres ALLOW_CONNECTIONS false" \
    -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid()" \
    -c "ALTER DATABASE postgres RENAME TO postgres_fresh" >/dev/null
  local rc=0
  docker exec "$DRILL_PROJECT-db" pg_restore -U supabase_admin -d template1 --create --exit-on-error /restore/postgres.dump >"$R/pg_restore.log" 2>&1 || rc=$?
  result B "pg_restore --create --exit-on-error postgres.dump (exit)" 0 "$rc"
  (( rc == 0 )) || die "pg_restore failed"
  drill_sql postgres -f /restore/db-settings.sql >/dev/null
  # throwaway passwords for every login role (globals.sql carried the live hashes; they are replaced)
  local pw; pw="$(envval POSTGRES_PASSWORD)"
  { printf "\\set pw '%s'\n" "$pw"
    drill_sql postgres -c "select rolname from pg_authid where rolcanlogin and rolpassword is not null order by 1" </dev/null \
      | while read -r r; do printf 'ALTER ROLE "%s" WITH PASSWORD :'"'"'pw'"'"';\n' "$r"; done
  } | drill_sql postgres >/dev/null
  pw=""
  info B "login roles given throwaway passwords" "$(drill_sql postgres -c "select string_agg(rolname, ',' order by rolname) from pg_authid where rolcanlogin and rolpassword is not null" </dev/null)"
  info B "cron jobs deactivated in the disposable db (defensive)" "$(drill_sql postgres -c "with u as (update cron.job set active = false returning 1) select count(*) from u" </dev/null)"
  t_end B-db-restore B

  # ---- database-level verification against live ----
  t_start B-verify-sql
  drill_sql postgres <"$HERE/dr-drill-fingerprint.sql" >"$R/drill-restored.fp"
  compare_fp B "restored = live:" "$R/live-before-dump.fp" "$R/drill-restored.fp" "$R/live-after-dump.fp"
  result B "auth.users count" "$(live_sql -c 'select count(*) from auth.users')" "$(drill_sql postgres -c 'select count(*) from auth.users' </dev/null)"
  result B "auth.mfa_factors rows / verified" "$(live_sql -c "select count(*)||'/'||count(*) filter (where status='verified') from auth.mfa_factors")" \
    "$(drill_sql postgres -c "select count(*)||'/'||count(*) filter (where status='verified') from auth.mfa_factors" </dev/null)"
  result B "schema version" "$(live_sql -c 'select max(version) from supabase_migrations.schema_migrations')" "$(drill_sql postgres -c 'select max(version) from supabase_migrations.schema_migrations' </dev/null)"
  result B "storage.objects rows" "$(live_sql -c 'select count(*) from storage.objects')" "$(drill_sql postgres -c 'select count(*) from storage.objects' </dev/null)"
  local appcfg_sql="select coalesce(json_agg(c order by c.key), '[]'::json) from public.app_config c"
  result B "public.app_config rows" "$(live_sql -c 'select count(*) from public.app_config')" "$(drill_sql postgres -c 'select count(*) from public.app_config' </dev/null)"
  result B "public.app_config restored = db/app_config.json in the archive" "$(jq -S -c . "$X/db/app_config.json" | md5sum | cut -c1-32)" "$(drill_sql postgres -c "$appcfg_sql" </dev/null | jq -S -c . | md5sum | cut -c1-32)"
  result B "public.app_config restored = live" "$(live_sql -c "$appcfg_sql" | jq -S -c . | md5sum | cut -c1-32)" "$(drill_sql postgres -c "$appcfg_sql" </dev/null | jq -S -c . | md5sum | cut -c1-32)"
  drill_sql postgres <"$HERE/dr-drill-consistency.sql" >"$R/drill-restored.consistency"
  local chk val nfk=0 fkbad=0
  while IFS='|' read -r chk val; do
    case "$chk" in
      info:*) info B "${chk#info: }" "$val (live: $(grep -F -- "$chk|" "$R/live-before.consistency" | cut -d'|' -f2))" ;;
      fk\ *) nfk=$(( nfk + 1 )); (( val == 0 )) || { fkbad=$(( fkbad + 1 )); result B "$chk violating rows" 0 "$val"; } ;;
      *) result B "consistency: $chk" 0 "$val" ;;
    esac
  done <"$R/drill-restored.consistency"
  result B "foreign keys with violating rows (of $nfk checked: public/auth/storage)" 0 "$fkbad"
  t_end B-verify-sql B

  # ---- services ----
  t_start B-services
  dc up -d rest auth storage api-gw functions >"$R/compose-up.log" 2>&1 || { tail -20 "$R/compose-up.log" >&2; die "compose up failed"; }
  local c ok=1
  for c in rest auth storage gw functions; do wait_healthy "$DRILL_PROJECT-$c" 240 || ok=0; done
  t_end B-services B
  result_ok B "disposable services healthy: db rest auth storage gw functions" "$ok" "$(docker ps --filter "name=^$DRILL_PROJECT-" --format '{{.Names}}={{.Status}}' | sed "s/$DRILL_PROJECT-//" | LC_ALL=C sort | tr '\n' ' ')"
  t_end B-restore-to-serving B
  info B "RTO email tier, data steps (unpack + decrypt + db init + restore + services up; excludes host setup)" \
    "$(awk -F'\t' '$2 ~ /^(A-unpack|A-decrypt|B-prepare|B-db-init|B-db-restore|B-services)$/ {s+=$3} END {printf "%.0f s", s}' "$R/timings.tsv")"

  local anon srv; anon="$(envval ANON_KEY)"; srv="$(envval SERVICE_ROLE_KEY)"
  t_start B-verify-api
  # GoTrue: health + admin API (service key of the drill); no logins with real passwords
  result B "GoTrue /auth/v1/health via the disposable gateway" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $anon" "$GW/auth/v1/health")"
  curl -s -H "apikey: $srv" -H "Authorization: Bearer $srv" "$GW/auth/v1/admin/users?page=1&per_page=1000" >"$DRILL_DIR/plain/admin-users.json"
  result B "GoTrue admin API: users listed" "$(live_sql -c 'select count(*) from auth.users')" "$(jq -r '.users | length' "$DRILL_DIR/plain/admin-users.json" 2>/dev/null || echo error)"
  result B "GoTrue admin API: user ids = live auth.users ids (md5 of sorted ids)" \
    "$(live_sql -c "select md5(string_agg(id::text, ',' order by id::text)) from auth.users")" \
    "$(jq -r '[.users[].id] | sort | join(",")' "$DRILL_DIR/plain/admin-users.json" | tr -d '\n' | md5sum | cut -c1-32)"
  local uid nver=0
  for uid in $(jq -r '.users[].id' "$DRILL_DIR/plain/admin-users.json"); do
    nver=$(( nver + $(curl -s -H "apikey: $srv" -H "Authorization: Bearer $srv" "$GW/auth/v1/admin/users/$uid/factors" | jq -r '[.[]? | select(.status == "verified")] | length') ))
  done
  result B "GoTrue admin API (/admin/users/{id}/factors): verified TOTP factors" "$(live_sql -c "select count(*) from auth.mfa_factors where status='verified'")" "$nver"
  rm -f "$DRILL_DIR/plain/admin-users.json"
  # PostgREST
  result B "PostgREST: products total via the gateway (service key)" "$(live_sql -c 'select count(*) from public.products')" \
    "$(curl -s -o /dev/null -D - -H "apikey: $srv" -H "Authorization: Bearer $srv" -H 'Prefer: count=exact' -H 'Range: 0-0' "$GW/rest/v1/products?select=id" | tr -d '\r' | awk -F/ 'tolower($0) ~ /^content-range:/ {print $2}')"
  result B "PostgREST: anon cannot read app_config (RLS/grants restored)" "401 or 403 or 42501" \
    "$(code="$(curl -s -o "$DRILL_DIR/plain/anon.json" -w '%{http_code}' -H "apikey: $anon" "$GW/rest/v1/app_config?select=key")"; if [[ "$code" =~ ^(401|403)$ ]] || grep -q 42501 "$DRILL_DIR/plain/anon.json"; then echo "401 or 403 or 42501"; else echo "$code"; fi)"
  rm -f "$DRILL_DIR/plain/anon.json"
  t_end B-verify-api B

  # storage: every object through the disposable gateway vs the manifest (sha256), plus the files on disk
  t_start B-verify-storage
  if [[ -f "$DRILL_MANIFEST" ]]; then
    mkdir -p "$DRILL_DIR/verify"
    rc=0; python3 -I "$HERE/verify_objects.py" "$DRILL_MANIFEST" "$GW" --bucket "$DRILL_BUCKET" --threads 4 \
      --report "$DRILL_DIR/verify/report.json" >"$R/verify-objects.txt" 2>&1 || rc=$?
    local n; n="$(wc -l <"$DRILL_MANIFEST")"
    result B "verify_objects.py: objects served with the manifest sha256 via the disposable gateway" "$n/$n ok" "$(tail -1 "$R/verify-objects.txt")"
    result B "manifest entries = live storage.objects rows" "$(live_sql -c "select count(*) from storage.objects where bucket_id = '$DRILL_BUCKET'")" "$n"
    jq -c '{ok, total}' "$DRILL_DIR/verify/report.json" >"$R/verify-objects-summary.json" 2>/dev/null || true
  else
    result B "storage manifest present at DRILL_MANIFEST" present missing
  fi
  result B "restored storage files on disk = live storage files" "$(find "$LIVE_STACK_DIR/volumes/storage" -type f ! -name .gitkeep | wc -l)" "$(find "$DRILL_DIR/restore/storage" -type f ! -name .gitkeep | wc -l)"
  t_end B-verify-storage B

  # phone-upload-token (restored from functions.tar.gz) — smoke checks as in evidence G5
  t_start B-verify-functions
  local fn="$GW/functions/v1/phone-upload-token" tok; tok="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  result B "phone-upload-token: POST without auth" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 90 -X POST -H 'content-type: application/json' -d '{"token":"x"}' "$fn")"
  local body; body="$(curl -s --max-time 90 -w '\n%{http_code}' -X POST -H "Authorization: Bearer $anon" -H "apikey: $anon" -H 'content-type: application/json' -d "{\"token\":\"$tok\"}" "$fn")"
  result B "phone-upload-token: well-formed unknown token -> 404 generic (DB lookup via gateway+rest)" '404 {"code":"invalid","error":"Invalid upload link."}' \
    "$(tail -1 <<<"$body") $(head -n -1 <<<"$body" | jq -S -c . 2>/dev/null || echo unparsable)"
  result B "phone-upload-token: GET -> 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -H "Authorization: Bearer $anon" -H "apikey: $anon" "$fn")"
  t_end B-verify-functions B
  anon=""; srv=""

  # after the services ran: the data is still identical (GoTrue/storage startup changed nothing)
  drill_sql postgres <"$HERE/dr-drill-fingerprint.sql" >"$R/drill-after-services.fp"
  result B "fingerprint unchanged after services started (items differing)" "" "$(fp_diff "$R/drill-restored.fp" "$R/drill-after-services.fp")"

  t_start B-teardown
  dc down -v --remove-orphans --timeout 20 >"$R/compose-down.log" 2>&1
  force_rm "$DRILL_DIR/restore" "$DRILL_DIR/verify"
  t_end B-teardown B
  result B "disposable stack removed (containers/volumes left)" "0/0" \
    "$(docker ps -a --format '{{.Names}}' | grep -cE "^$DRILL_PROJECT-" || true)/$(docker volume ls --format '{{.Name}}' | grep -cE "^${DRILL_PROJECT}_" || true)"
}

# ===========================================================================
# C. point-in-time recovery from base backup + WAL archive
# ===========================================================================
# waldump_commits START_SEG XIDS... -> "xid|commit time|lsn" for the COMMIT records of XIDS in the
# archive from START_SEG on (segments decompressed into $DRILL_DIR/waldump by a --network none container)
waldump_commits() {
  local start="$1"; shift
  local out="$DRILL_DIR/waldump"; mkdir -p "$out"
  local -a segs
  mapfile -t segs < <(find "$WAL_ARCHIVE_DIR" -maxdepth 1 -name '[0-9A-F]*.gz' -printf '%f\n' | sed -n 's/^\([0-9A-F]\{24\}\)\.gz$/\1/p' \
    | awk -v s="$start" '$0 >= s && substr($0, 1, 8) == substr(s, 1, 8)' | LC_ALL=C sort)
  (( ${#segs[@]} )) || return 0
  docker run --rm --network none --memory 256m --name "$DRILL_PROJECT-waldump" --user "$(id -u):$(id -g)" \
    --group-add "$(stat -c %g "$WAL_ARCHIVE_DIR")" -v "$WAL_ARCHIVE_DIR:/wal:ro" -v "$out:/out" --entrypoint sh "$IMG_DB" -c '
      for s in "$@"; do [ -s "/out/$s" ] || gzip -dc "/wal/$s.gz" > "/out/$s"; done
      pg_waldump -p /out -r Transaction "$1" "$(eval echo \${$#})" 2>/dev/null; exit 0' sh "${segs[@]}" >"$out/dump.txt"
  local x
  for x in "$@"; do
    sed -nE "s/.*tx: +$x, lsn: ([0-9A-F]+\/[0-9A-F]+),.*desc: COMMIT ([0-9-]+ [0-9:.]+) UTC.*/$x|\2|\1/p" "$out/dump.txt" | head -1
  done
}

pitr_prepare() {  # BASE_DIR TW_DIR [recovery settings lines...]
  local src="$1" dir="$2"; shift 2
  local pgdata="$dir/pgdata" method
  mkdir -p "$pgdata" && chmod 0700 "$dir" "$pgdata"
  method="$(jq -r .method "$src/backup.json")"
  tar -xzf "$src/base.tar.gz" -C "$pgdata"
  if [[ "$method" == sqlapi ]]; then
    mkdir -p "$pgdata/pg_wal/archive_status" "$pgdata/pg_wal/summaries"
    tar -xzf "$src/pg_wal.tar.gz" -C "$pgdata/pg_wal"; cp "$src/backup_label" "$pgdata/backup_label"
    [[ -f "$src/tablespace_map" ]] && cp "$src/tablespace_map" "$pgdata/tablespace_map"
  fi
  rm -f "$pgdata/postmaster.pid" "$pgdata/postmaster.opts"
  : >"$pgdata/recovery.signal"
  { echo "# --- dr-drill.sh"; echo "archive_mode = off"; echo "restore_command = 'gzip -dc /wal_archive/%f.gz > %p'"; printf '%s\n' "$@"; } >>"$pgdata/postgresql.auto.conf"
  chmod 0700 "$pgdata"
}

phase_c() {
  log "=== phase C: point-in-time recovery (base + WAL archive) ==="
  local -a labels=() xids=()
  local l x
  while IFS='|' read -r l x; do labels+=("$l"); xids+=("$x"); done < <(live_sql -c "$PITR_EVENTS_SQL")
  (( ${#xids[@]} )) || die "PITR_EVENTS_SQL returned no events"
  for x in "${xids[@]}"; do [[ "$x" =~ ^[0-9]+$ ]] && (( x > 2 )) || die "event xid '$x' is not a normal transaction id"; done
  local live_probe; live_probe="$(live_sql -c "SET timezone = 'UTC'" -c "$PITR_PROBE_SQL")"
  info C "live probe now" "$live_probe"

  # newest base backup that starts before the first event; commit times from the archived WAL
  t_start C-waldump
  local base="" b start commits=""
  while read -r b; do
    [[ -f "$BASE_DIR/$b/backup.json" ]] || continue
    start="$(base_start_wal_file "$BASE_DIR/$b")"; [[ -n "$start" ]] || continue
    commits="$(waldump_commits "$start" "${xids[@]}")"
    if grep -q "^${xids[0]}|" <<<"$commits"; then base="$b"; break; fi
  done < <(find "$BASE_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E "$TS_RE" | LC_ALL=C sort -r)
  t_end C-waldump C
  [[ -n "$base" ]] || die "no retained base backup precedes the first event (or its commit is not in the archive)"
  local SRC="$BASE_DIR/$base"
  verify_sha256sums "$SRC" || die "SHA256SUMS mismatch in $SRC"
  info C "base backup used (newest that precedes the events; SHA256SUMS ok)" "$base (method $(jq -r .method "$SRC/backup.json"), start WAL $(base_start_wal_file "$SRC"))"
  local -a ts=() lsns=()
  local i line
  for i in "${!xids[@]}"; do
    line="$(grep "^${xids[$i]}|" <<<"$commits" || true)"
    [[ -n "$line" ]] || die "no COMMIT record for xid ${xids[$i]} (${labels[$i]}) in the archive"
    ts+=("$(cut -d'|' -f2 <<<"$line")"); lsns+=("$(cut -d'|' -f3 <<<"$line")")
    info C "event $(( i + 1 )): ${labels[$i]}" "xid ${xids[$i]} committed $(cut -d'|' -f2 <<<"$line") UTC at LSN $(cut -d'|' -f3 <<<"$line")"
  done
  force_rm "$DRILL_DIR/waldump"

  # recoveries: just before event 1, then at each event (inclusive)
  local -a exp; IFS=';' read -r -a exp <<<"$PITR_EXPECT"
  (( ${#exp[@]} == ${#xids[@]} + 1 )) || die "PITR_EXPECT needs $(( ${#xids[@]} + 1 )) entries"
  local n target incl want stopline probe tli inrec dur_ready
  for (( n = 0; n <= ${#xids[@]}; n++ )); do
    if (( n == 0 )); then
      target="$(python3 -I -c 'import datetime,sys; t=datetime.datetime.fromisoformat(sys.argv[1]); print((t-datetime.timedelta(milliseconds=1)).isoformat(sep=" "))' "${ts[0]}")+00"
      incl=true; want="the event's own commit (xid ${xids[0]})"
    else
      # a time target stops BEFORE the first commit later than the target (inclusive), i.e. right after the event
      target="${ts[$(( n - 1 ))]}+00"; incl=true; want="the first commit after xid ${xids[$(( n - 1 ))]}"
    fi
    TW_NAME="$DRILL_PROJECT-pitr-$n"; TW_DIR="$RESTORE_TEST_DIR/pitr-$n"
    t_start "C-pitr-$n"
    pitr_prepare "$SRC" "$TW_DIR" "recovery_target_time = '$target'" "recovery_target_inclusive = $incl" "recovery_target_action = 'promote'"
    TW_EXTRA_ARGS=(-v "$WAL_ARCHIVE_DIR:/wal_archive:ro")
    tw_start physical
    tw_wait_ready physical || die "PITR throwaway $n did not start"
    dur_ready="$(awk -v a="$(date +%s.%N)" -v b="${T0[C-pitr-$n]}" 'BEGIN { printf "%.1f", a - b }')"
    stopline="$(grep -oE 'recovery stopping (before|after) commit of transaction [0-9]+, time [0-9: .+-]+' "$TW_DIR/postgres.log" | head -1)"
    probe="$(tw_psql postgres -c "SET timezone = 'UTC'" -c "$PITR_PROBE_SQL")"
    tli="$(tw_psql postgres -c 'select timeline_id from pg_control_checkpoint()')"; inrec="$(tw_psql postgres -c 'select pg_is_in_recovery()')"
    local e="${exp[$n]}"; [[ "$e" == LIVE ]] && e="$live_probe"
    local sx; sx="$(sed -nE 's/.*before commit of transaction ([0-9]+).*/\1/p' <<<"$stopline")"
    local sok=0
    if (( n == 0 )); then [[ "$sx" == "${xids[0]}" ]] && sok=1
    else [[ -n "$sx" && "$sx" != "${xids[$(( n - 1 ))]}" ]] && sok=1; fi
    result_ok C "PITR $n target '$target': recovery stopped before $want" "$sok" "${stopline:-no 'recovery stopping' line}"
    result C "PITR $n target '$target': state" "$e" "$probe"
    result_ok C "PITR $n: promoted to a new timeline, accepting writes" "$( (( tli > 1 )) && [[ "$inrec" == f ]] && echo 1 || echo 0)" "timeline $tli, in_recovery=$inrec, ready after ${dur_ready%.*} s"
    tw_cleanup
    TW_EXTRA_ARGS=()
    t_end "C-pitr-$n" C
  done

  # newest base + the whole archive (replay to the end) vs live now = local-tier RPO
  local newest; newest="$(latest_dir "$BASE_DIR" "$TS_RE")"
  verify_sha256sums "$BASE_DIR/$newest" || die "SHA256SUMS mismatch in newest base $newest"
  TW_NAME="$DRILL_PROJECT-pitr-latest"; TW_DIR="$RESTORE_TEST_DIR/pitr-latest"
  t_start C-latest
  live_sql <"$HERE/dr-drill-fingerprint.sql" >"$R/live-at-pitr-latest.fp"
  local live_arch; live_arch="$(live_sql -c "select last_archived_wal || ' at ' || to_char(last_archived_time at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') || ' UTC' from pg_stat_archiver")"
  pitr_prepare "$BASE_DIR/$newest" "$TW_DIR"
  TW_EXTRA_ARGS=(-v "$WAL_ARCHIVE_DIR:/wal_archive:ro")
  tw_start physical
  tw_wait_ready physical || die "latest-base throwaway did not start"
  t_end C-latest C
  info C "newest base + whole archive: base / last archived segment (live)" "$newest / $live_arch"
  info C "newest base + whole archive: recovery end" "$(grep -oE '(last completed transaction was at log time [0-9: .+-]+|archive recovery complete|selected new timeline ID: [0-9]+)' "$TW_DIR/postgres.log" | tr '\n' ';')"
  tw_sql_file "$HERE/dr-drill-fingerprint.sql" >"$R/pitr-latest.fp"
  result C "newest base + WAL replayed to the end = live now: row counts (items differing)" "" "$(fp_diff "$R/live-at-pitr-latest.fp" "$R/pitr-latest.fp" counts)"
  info C "newest base + WAL replayed to the end = live now: counts+md5 (items differing; writes after the last archived segment = RPO)" "$(fp_diff "$R/live-at-pitr-latest.fp" "$R/pitr-latest.fp" | sed 's/^$/none/')"
  tw_cleanup; TW_EXTRA_ARGS=()
}

# ===========================================================================
if has_phase a; then phase_a; fi
if has_phase b; then phase_b; fi
if has_phase c; then phase_c; fi

# live stack after: same containers (no restart), healthy, data unchanged
t_start live-after; live_state live-after; t_end live-after post
result post "live stack containers running+healthy after the drill" "$LIVE_EXPECTED_CONTAINERS/$LIVE_EXPECTED_CONTAINERS" "$(grep -c '|running|healthy|' "$R/live-after.containers" || true)/$(wc -l <"$R/live-after.containers")"
result post "live containers unchanged (same ids, start times, restart counts)" "$(md5sum <"$R/live-before.containers" | cut -c1-32)" "$(md5sum <"$R/live-after.containers" | cut -c1-32)"
result post "live row counts before vs after the drill (items differing)" "" "$(fp_diff "$R/live-before.fp" "$R/live-after.fp" counts)"
info post "live counts+md5 before vs after the drill (items differing; normal app use may change content)" "$(fp_diff "$R/live-before.fp" "$R/live-after.fp" | sed 's/^$/none/')"
info post "live archiver after (mode|timeout|last wal|last archived|failed|now)" "$(cat "$R/live-after.archiver")"
t_end total post
log "checks: $(grep -c $'\tPASS$' "$R/results.tsv") PASS, $(grep -c $'\tFAIL$' "$R/results.tsv") FAIL, $(grep -c $'\tINFO$' "$R/results.tsv") INFO"
(( FAILS == 0 ))
