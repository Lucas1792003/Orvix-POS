#!/usr/bin/env bash
# dr-verify-restore.sh — the gate between "PostgreSQL started" and "this restore may serve tills".
# A restore is HEALTHY only when every check passes AND it was compared with an independent
# reference; anything else is FAILED or INCONCLUSIVE (exit 1) and must not be promoted (the API
# stays closed). Read-only; no row content is printed — only counts, md5s and object names.
#
#   dr-verify-restore.sh backup --dir SET --expect-version NNN [--max-age-hours 26] [--accept-stale]
#       a backup set BEFORE it is restored — either layout:
#         logical dump set (backup-logical.sh: meta.json, SHA256SUMS, *.dump, globals.sql, …)
#         unpacked email archive (email-archive.sh: MANIFEST.json, SHA256SUMS, db/…, files/storage.tar.gz)
#       checks: SHA256SUMS verifies; the required components exist and are checksummed; the
#       metadata is complete; age (stale/future refused); EVERY data block of both dumps reads
#       (pg_restore to /dev/null); the schema version inside the dump; no JWT secret in db-settings.
#   dr-verify-restore.sh fingerprint [--container C | --compose-dir D] > ref.txt
#       rows (dr-drill-fingerprint.sql) + schema (dr-schema-fingerprint.sql) of a source.
#   dr-verify-restore.sh preflight --migrations DIR --expect-version NNN
#       BEFORE the database is touched: the gate's SQL files and dr-restore-fixups.sql are next to
#       this script, the tools exist, and DIR holds the repo's migrations up to NNN. Exit 0 or 1.
#   dr-verify-restore.sh restore [--container C | --compose-dir D] --expect-version NNN --migrations DIR
#                        [--held 084] [--reference ref.txt] [--counts counts.json [--count-tolerance N]]
#                        [--storage-dir DIR] [--accept-no-reference]
#       the restored database: fingerprint equal to --reference; counts equal to the backup's own
#       counts.json (--counts); every invariant of dr-drill-consistency.sql + dr-financial-checks.sql 0;
#       migration ledger exactly the repo's versions up to NNN minus the held ones, recorded sha256
#       checksums equal to the repo files; schema version NNN; storage objects' bytes present.
#       Without --reference the result is INCONCLUSIVE (invariants cannot tell an empty or partial
#       restore from a complete one). --accept-no-reference --counts counts.json (the backup's own,
#       WITH per-table row counts) gives at best RESULT: ACCEPTED-WITHOUT-REFERENCE, exit 3 — never
#       HEALTHY: counts, not content, were compared.
#       Counts are compared for EQUALITY. --count-tolerance N (a non-negative integer, else exit 2)
#       applies ONLY to GoTrue's session churn tables ($TOLERANT below: sessions, refresh tokens,
#       auth audit log, flow state, one-time tokens, MFA challenges/claims); every business,
#       financial, ledger, idempotency, migration, user and storage count stays strict.
#       A failed or empty query is a FAIL, never a pass. The gate only reads: it never starts,
#       stops or exposes a service; whatever it answers, reopening the API is a separate, manual,
#       owner-authorised step (README §R).
# Exit: 0 HEALTHY, 3 ACCEPTED-WITHOUT-REFERENCE, 1 FAILED/INCONCLUSIVE, 2 usage (and -h).
#
# Database access: --container (docker exec) or --compose-dir (docker compose exec db). bash 3.2-safe.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="${DR_VERIFY_IMAGE:-supabase/postgres:17.6.1.136}"
MODE="${1:-}"; shift || true
CT=""; COMPOSE=""; DIR=""; MAX_AGE_H=26; ACCEPT_STALE=0; EXPECT=""; MIGDIR=""; HELD="084"; REF=""; STORAGE=""
COUNTS=""; TOL=0; ACCEPT_NOREF=0
# the gate's own SQL + the runbook's post-restore fix-ups: a package without any of them is refused
REQUIRED_SQL="dr-drill-fingerprint.sql dr-schema-fingerprint.sql dr-drill-consistency.sql dr-financial-checks.sql dr-restore-fixups.sql"
# the ONLY tables --count-tolerance applies to: GoTrue's login/session churn, which keeps moving
# between the dump and counts.json (W5) and carries no business state. Everything else is strict.
TOLERANT="auth.sessions auth.refresh_tokens auth.audit_log_entries auth.flow_state auth.one_time_tokens auth.mfa_challenges auth.mfa_amr_claims"
usage() { echo "$*" >&2; echo "usage: see sed -n '2,40p' $0" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in --accept-stale|--accept-no-reference|-h|--help) ;; *) [ $# -ge 2 ] || usage "$1 needs a value";; esac
  case "$1" in
  --container) CT=$2; shift 2;; --compose-dir) COMPOSE=$2; shift 2;; --dir) DIR=$2; shift 2;;
  --max-age-hours) MAX_AGE_H=$2; shift 2;; --accept-stale) ACCEPT_STALE=1; shift;;
  --expect-version) EXPECT=$2; shift 2;; --migrations) MIGDIR=$2; shift 2;; --held) HELD=$2; shift 2;;
  --reference) REF=$2; shift 2;; --storage-dir) STORAGE=$2; shift 2;;
  --counts) COUNTS=$2; shift 2;; --count-tolerance) TOL=$2; shift 2;; --accept-no-reference) ACCEPT_NOREF=1; shift;;
  -h|--help) sed -n '2,40p' "$0"; exit 2;;   # never 0: "gate -h && reopen" must not continue
  *) usage "unknown argument $1";; esac; done
# numbers are validated, never coerced: a malformed value must not disable a comparison
case "$TOL" in ''|*[!0-9]*) usage "--count-tolerance must be a non-negative integer (got '$TOL')";; esac
[ ${#TOL} -le 6 ] || usage "--count-tolerance too large ($TOL)"
case "$MAX_AGE_H" in ''|*[!0-9]*) usage "--max-age-hours must be a non-negative integer (got '$MAX_AGE_H')";; esac
[ -z "$EXPECT" ] || printf '%s' "$EXPECT" | grep -qxE '[0-9]{3}' || usage "--expect-version must be NNN (got '$EXPECT')"

FAILS=0; PASSES=0; INCONCLUSIVE=""; ACCEPTED=""; CFAILS=0; CLOST=""
pass() { PASSES=$((PASSES+1)); echo "PASS  $*"; }
fail() { FAILS=$((FAILS+1)); echo "FAIL  $*"; }
cfail() { CFAILS=$((CFAILS+1)); fail "$@"; }   # a count DIFFERENCE (or counts the backup lacks), not a failed query
finish() {
  echo "---"
  # COUNTS-ONLY (the one overridable FAILED): only count differences, a full no-reference run (not
  # INCONCLUSIVE), and no table emptied — a table that had rows and has none is lost data, not timing
  if [ "$FAILS" -gt 0 ] && [ "$FAILS" -eq "$CFAILS" ] && [ -z "$INCONCLUSIVE" ] && [ -z "$CLOST" ]; then
    echo "NOTE  COUNTS-ONLY: every failure above is the per-table counts comparison; every other check that ran passed."
    echo "NOTE  Still FAILED. Reopening needs the investigation of disaster-recovery.md §5.3 and an explicit owner override (README §R) — never automatic."
  fi
  if [ "$FAILS" -gt 0 ]; then echo "RESULT: FAILED ($FAILS failed, $PASSES passed) — do NOT promote this restore; keep the API closed"; exit 1; fi
  if [ -n "$INCONCLUSIVE" ]; then echo "RESULT: INCONCLUSIVE ($INCONCLUSIVE) — do NOT promote this restore; keep the API closed"; exit 1; fi
  if [ -n "$ACCEPTED" ]; then echo "RESULT: ACCEPTED-WITHOUT-REFERENCE ($PASSES checks passed; $ACCEPTED) — an owner decision, not a proof"; exit 3; fi
  echo "RESULT: HEALTHY ($PASSES checks passed)"; exit 0
}
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
epoch_of() {  # ISO-8601 UTC (YYYY-MM-DDTHH:MM:SS[.fff]Z) -> epoch seconds; empty when unparseable
  local t; t=$(printf '%s' "$1" | sed -E 's/\.[0-9]+//; s/Z$//')
  printf '%s' "$t" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$' || return 0
  date -u -j -f '%Y-%m-%dT%H:%M:%S' "$t" +%s 2>/dev/null || date -u -d "${t}Z" +%s 2>/dev/null || true
}
psql_db() {
  if [ -n "$CT" ]; then docker exec -i "$CT" psql -X -U supabase_admin -d postgres -At -F '|' -v ON_ERROR_STOP=1 "$@"
  elif [ -n "$COMPOSE" ]; then (cd "$COMPOSE" && docker compose exec -T db psql -X -U supabase_admin -d postgres -At -F '|' -v ON_ERROR_STOP=1 "$@")
  else echo "need --container or --compose-dir" >&2; return 2; fi
}
fingerprint() { cat "$HERE/dr-drill-fingerprint.sql" "$HERE/dr-schema-fingerprint.sql" | psql_db -q -f - 2>&1; }
repo_versions() {
  local f b
  for f in "$MIGDIR"/[0-9][0-9][0-9]_*.sql; do
    b=$(basename "$f")
    if printf '%s' "$b" | grep -qE '^[0-9]{3}_[a-z0-9_]+\.sql$'; then printf '%s\n' "${b:0:3}"; fi
  done
}
package_ok() {  # the files + tools the gate and the runbook need, checked before any database access
  local f t ok=0
  for f in $REQUIRED_SQL; do
    if [ -s "$HERE/$f" ] && [ -r "$HERE/$f" ]; then pass "package: $f present"; else fail "package: $f MISSING next to $0 (redeploy with deploy.sh; see README §P)"; ok=1; fi
  done
  for t in jq diff comm awk sed docker; do
    if command -v "$t" >/dev/null 2>&1; then :; else fail "tool missing: $t"; ok=1; fi
  done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || { fail "tool missing: sha256sum/shasum"; ok=1; }
  # the list is captured first: `repo_versions | grep -q` would die of SIGPIPE under pipefail and read as "absent"
  local vers=""; [ -n "$MIGDIR" ] && [ -d "$MIGDIR" ] && vers=$(repo_versions | sort)
  if [ -z "$MIGDIR" ] || [ ! -d "$MIGDIR" ]; then fail "migration source '${MIGDIR:-}' is not a directory (the repo's supabase/migrations at the deployed commit)"; ok=1
  elif [ -z "$vers" ]; then fail "migration source $MIGDIR holds no NNN_name.sql file"; ok=1
  elif [ -n "$EXPECT" ] && ! grep -qxF "$EXPECT" <<<"$vers"; then fail "migration source $MIGDIR has no $EXPECT migration (older checkout than the backup)"; ok=1
  else pass "migration source: $(grep -c . <<<"$vers") migrations, latest $(tail -1 <<<"$vers")"; fi
  return $ok
}

case "$MODE" in
backup)
  [ -n "$DIR" ] && [ -d "$DIR" ] || { echo "--dir SET required"; exit 2; }
  [ -n "$EXPECT" ] || { echo "--expect-version NNN required (the schema version this restore must have)"; exit 2; }
  if [ -f "$DIR/MANIFEST.json" ]; then LAYOUT=archive; DB="$DIR/db"; P="db/"; CREATED=$(jq -r '.created_at // empty' "$DIR/MANIFEST.json" 2>/dev/null)
  elif [ -f "$DIR/meta.json" ]; then LAYOUT=logical; DB="$DIR"; P=""; CREATED=$(jq -r '.completed_at // empty' "$DIR/meta.json" 2>/dev/null)
  else LAYOUT=unknown; DB="$DIR"; P=""; CREATED=""; fi
  echo "== backup set $(basename "$DIR") (layout: $LAYOUT)"
  [ "$LAYOUT" = unknown ] && fail "neither meta.json (dump set) nor MANIFEST.json (archive): incomplete or interrupted backup"
  if [ -f "$DIR/SHA256SUMS" ]; then
    if (cd "$DIR" && sha -c SHA256SUMS >/dev/null 2>&1); then pass "SHA256SUMS: every listed file intact ($(grep -c . "$DIR/SHA256SUMS") files)"; else fail "SHA256SUMS: a file is missing or damaged"; fi
  else fail "SHA256SUMS missing (incomplete or interrupted backup)"; fi
  REQ="${P}postgres.dump ${P}_supabase.dump ${P}globals.sql ${P}db-settings.sql ${P}counts.json"
  [ "$LAYOUT" = archive ] && REQ="$REQ files/storage.tar.gz"
  for rel in $REQ; do
    if [ -s "$DIR/$rel" ] && grep -qE "[ *](\./)?$rel\$" "$DIR/SHA256SUMS" 2>/dev/null; then pass "component $rel present and checksummed"
    else fail "component $rel missing, empty or not checksummed"; fi
  done
  if [ -n "$CREATED" ]; then
    ce=$(epoch_of "$CREATED")
    if [ -z "$ce" ]; then fail "backup time '$CREATED' unreadable"
    else
      age_s=$(( $(date -u +%s) - ce ))
      if [ "$age_s" -lt -300 ]; then fail "backup time is in the future ($CREATED): clock or metadata wrong"
      elif [ "$age_s" -le $((MAX_AGE_H * 3600)) ]; then pass "age $((age_s / 60)) min (<= ${MAX_AGE_H} h)"
      elif [ "$ACCEPT_STALE" = 1 ]; then echo "WARN  STALE backup: $((age_s / 3600)) h old — accepted explicitly (--accept-stale); every operation after it is lost"; PASSES=$((PASSES+1))
      else fail "STALE backup: $((age_s / 3600)) h old (> ${MAX_AGE_H} h) — pass --accept-stale only after deciding to lose everything after it"; fi
    fi
  else fail "no completion time in the metadata (interrupted backup)"; fi
  for db in postgres _supabase; do
    if [ -s "$DB/$db.dump" ]; then
      # every data block, not only the table of contents (a truncation inside the data is caught)
      if docker run --rm -i --network none --entrypoint sh "$IMG" -c 'cat > /tmp/d && pg_restore -l /tmp/d >/dev/null && pg_restore -f /dev/null /tmp/d' < "$DB/$db.dump" >/dev/null 2>&1
      then pass "$db.dump: every block readable"; else fail "$db.dump: unreadable (truncated or corrupt)"; fi
    fi
  done
  if [ -s "$DB/postgres.dump" ]; then
    v=$(docker run --rm -i --network none --entrypoint sh "$IMG" -c 'cat > /tmp/d && pg_restore -a -t schema_migrations -n supabase_migrations -f - /tmp/d' < "$DB/postgres.dump" 2>/dev/null \
        | awk -F'\t' '/^COPY supabase_migrations.schema_migrations/{c=1; next} c && /^\\\.$/{c=0} c{print $1}' | sort | tail -1)
    if [ "$v" = "$EXPECT" ]; then pass "schema version inside the dump: $v"; else fail "schema version inside the dump is '${v:-unknown}', expected $EXPECT"; fi
  fi
  if [ -s "$DB/db-settings.sql" ] && grep -qi 'jwt_secret' "$DB/db-settings.sql"; then fail "db-settings.sql carries a JWT secret (app.settings.jwt_secret): every copy of this backup leaks it"
  else pass "no JWT secret in the database-level settings"; fi
  finish ;;

fingerprint)
  out=$(fingerprint); rc=$?
  [ $rc -eq 0 ] || { echo "$out" >&2; exit 1; }
  printf '%s\n' "$out"; exit 0 ;;

preflight)
  [ -n "$EXPECT" ] && [ -n "$MIGDIR" ] || usage "--expect-version and --migrations required"
  echo "== preflight (no database access)"
  package_ok; finish ;;

restore)
  [ -n "$EXPECT" ] && [ -n "$MIGDIR" ] || usage "--expect-version and --migrations required"
  echo "== package"
  if ! package_ok; then echo "      (nothing was queried: the package is incomplete)"; finish; fi
  echo "== restored database"
  if ! psql_db -c "select 1" >/dev/null 2>&1; then fail "database not reachable"; finish; fi
  FP=$(fingerprint); rc=$?
  if [ $rc -ne 0 ]; then fail "fingerprint query failed: $(printf '%s' "$FP" | tail -1)"
  elif [ -n "$REF" ]; then
    if [ ! -s "$REF" ]; then fail "reference fingerprint $REF missing or empty"
    else
      d=$(diff <(sort "$REF") <(printf '%s\n' "$FP" | sort) | grep -E '^[<>]' || true)
      if [ -z "$d" ]; then pass "fingerprint identical to the reference ($(wc -l < "$REF" | tr -d ' ') items: every public table, auth, storage, migrations, roles, functions, grants, policies, constraints)"
      else
        fail "fingerprint differs from the reference in $(printf '%s\n' "$d" | sed 's/^[<>] //' | cut -d'|' -f1 | sort -u | grep -c .) item(s):"
        printf '%s\n' "$d" | sed 's/^[<>] //' | cut -d'|' -f1 | sort -u | head -20 | sed 's/^/        /'
      fi
    fi
  elif [ "$ACCEPT_NOREF" = 1 ]; then
    [ -n "$COUNTS" ] || fail "--accept-no-reference needs --counts (the backup's own counts.json)"
    [ -n "$COUNTS" ] && ! jq -e '.rows | type == "object" and length > 0' "$COUNTS" >/dev/null 2>&1 \
      && cfail "--accept-no-reference needs per-table row counts in counts.json (.rows; backups before 2026-10-18 lack them)"
    ACCEPTED="no reference: content NOT compared; per-table row counts and invariants were"
    echo "NOTE  no reference: equality with the source is NOT checked; the backup's counts and the invariants are"
  else INCONCLUSIVE="no --reference: an empty or partial restore satisfies every invariant"; fi
  if [ -n "$COUNTS" ]; then
    if [ ! -s "$COUNTS" ] || ! jq -e . "$COUNTS" >/dev/null 2>&1; then fail "counts file $COUNTS missing or not JSON"
    else
      got=$(psql_db -c "select json_build_object(
        'auth_users', (select count(*) from auth.users), 'storage_buckets', (select count(*) from storage.buckets),
        'storage_objects', (select count(*) from storage.objects),
        'tables_public', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')),
        'tables_auth', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and c.relkind in ('r','p')),
        'tables_storage', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'storage' and c.relkind in ('r','p')),
        'roles', (select count(*) from pg_roles where rolname not like 'pg\_%'), 'extensions', (select count(*) from pg_extension),
        'products', (select count(*) from public.products), 'organizations', (select count(*) from public.organizations),
        'app_users', (select count(*) from public.users), 'auth_mfa_factors', (select count(*) from auth.mfa_factors),
        'auth_identities', (select count(*) from auth.identities), 'migrations', (select count(*) from supabase_migrations.schema_migrations),
        'schema_version', (select max(version) from supabase_migrations.schema_migrations), 'sales', (select count(*) from public.sales))" 2>/dev/null)
      if [ -z "$got" ] || ! printf '%s' "$got" | jq -e 'type == "object" and length > 0' >/dev/null 2>&1; then fail "counts query failed or returned no JSON object"
      else
        isnum() { printf '%s' "$1" | grep -qxE '0|[1-9][0-9]{0,17}'; }   # no octal (leading 0), no overflow
        bad=""; n=0; tolerated=""
        # summary keys: always strict (sales, users, storage, migrations, roles, … — no tolerance)
        for k in $(jq -r 'keys[]' "$COUNTS"); do
          case "$k" in captured_at|db_size_bytes|rows) continue;; esac
          e=$(jq -r --arg k "$k" '.[$k]' "$COUNTS"); a=$(printf '%s' "$got" | jq -r --arg k "$k" '.[$k] // "missing"')
          n=$((n+1))
          [ -n "$e" ] && [ "$a" = "$e" ] || bad="$bad $k($e->$a)"
          if isnum "$e" && [ "$e" -gt 0 ] && [ "$a" = 0 ]; then CLOST="$CLOST $k"; fi
        done
        # per-table row counts (recorded since 2026-10-18): every table of public/auth/storage/migrations
        if jq -e '.rows | type == "object"' "$COUNTS" >/dev/null 2>&1; then
          rows_now=$(psql_db -c "select coalesce(json_object_agg(n.nspname || '.' || c.relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint), '{}') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','auth','storage','supabase_migrations') and c.relkind in ('r','p')" 2>/dev/null); rrc=$?
          if [ $rrc -ne 0 ] || ! printf '%s' "$rows_now" | jq -e 'type == "object" and length > 0' >/dev/null 2>&1; then
            fail "per-table rows query failed or returned nothing"   # a failed query is never "counts only"
          else
            for t in $(jq -r '.rows | keys[]' "$COUNTS"); do
              e=$(jq -r --arg t "$t" '.rows[$t]' "$COUNTS"); a=$(printf '%s' "$rows_now" | jq -r --arg t "$t" '.[$t] // "missing"')
              n=$((n+1))
              if [ "$a" = "$e" ] && isnum "$e"; then continue; fi
              if [ "$TOL" -gt 0 ] && isnum "$e" && isnum "$a" && printf ' %s ' "$TOLERANT" | grep -qF " $t " \
                 && [ $(( a > e ? a - e : e - a )) -le "$TOL" ]; then tolerated="$tolerated $t($e->$a)"; continue; fi
              bad="$bad $t($e->$a)"
              if isnum "$e" && [ "$e" -gt 0 ] && [ "$a" = 0 ]; then CLOST="$CLOST $t"; fi
            done
            # both ways: a table in the restore that the backup never counted is not "equal"
            for t in $(printf '%s' "$rows_now" | jq -r 'keys[]'); do
              jq -e --arg t "$t" '.rows | has($t)' "$COUNTS" >/dev/null 2>&1 || bad="$bad $t(not-in-counts->$(printf '%s' "$rows_now" | jq -r --arg t "$t" '.[$t]'))"
            done
          fi
        fi
        if [ -n "$bad" ]; then cfail "counts differ from the backup's counts.json:$(printf '%s' "$bad" | cut -c1-600)"
          [ -z "$CLOST" ] || echo "NOTE  emptied (had rows, now none):$(printf '%s' "$CLOST" | cut -c1-300) — lost data, never COUNTS-ONLY"
        elif [ -n "$tolerated" ]; then pass "counts equal to the backup's own counts.json ($n keys incl. per-table rows; session churn tolerated within $TOL:$tolerated)"
        else pass "counts equal to the backup's own counts.json ($n keys incl. per-table rows, all exact)"; fi
      fi
    fi
  fi
  for f in dr-drill-consistency.sql dr-financial-checks.sql; do
    res=$(psql_db -q -f - < "$HERE/$f" 2>&1); rc=$?
    if [ $rc -ne 0 ]; then fail "$f did not run: $(printf '%s' "$res" | tail -1)"; continue; fi
    bad=$(printf '%s\n' "$res" | awk -F'|' 'NF>=2 && $1 !~ /^info:/ && $2 != "0"')
    # every static check returns exactly one row: fewer rows means a check did not run
    nmin=$(grep -E "^SELECT '" "$HERE/$f" | grep -vc "^SELECT 'info:")
    nchk=$(printf '%s\n' "$res" | awk -F'|' 'NF>=2 && $1 !~ /^info:/' | wc -l | tr -d ' ')
    if [ -n "$bad" ]; then fail "$f: invariant(s) violated:"; printf '%s\n' "$bad" | sed 's/^/        /'
    elif [ "$nchk" -lt "$nmin" ] || [ "$nchk" -eq 0 ]; then fail "$f: fewer checks than the file holds ($nchk returned, at least $nmin expected): output incomplete"
    else pass "$f: every invariant 0 ($nchk checks)"; fi
  done
  want=$(repo_versions | awk -v e="$EXPECT" '$1 <= e' | grep -vxF -f <(printf '%s\n' $HELD) | sort -u)
  have=$(psql_db -c "select version from supabase_migrations.schema_migrations order by 1" 2>/dev/null); vrc=$?
  missing=$(comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$have") | tr '\n' ' ')
  extra=$(comm -13 <(printf '%s\n' "$want") <(printf '%s\n' "$have") | tr '\n' ' ')
  if [ $vrc -ne 0 ] || [ -z "$have" ]; then fail "migration ledger query failed or returned nothing"
  elif [ -z "${missing// }" ] && [ -z "${extra// }" ]; then pass "migration ledger: exactly the repo's $(printf '%s\n' "$want" | wc -l | tr -d ' ') versions up to $EXPECT (held: $HELD)"
  else fail "migration ledger differs from the repo: missing [${missing% }] unexpected [${extra% }]"; fi
  # recorded checksums (rows written by apply-migrations.sh) must equal the repo files
  sums=$(psql_db -c "select version || '|' || s from supabase_migrations.schema_migrations m, jsonb_array_elements_text(case when jsonb_typeof(to_jsonb(m)->'statements') = 'array' then to_jsonb(m)->'statements' else '[]' end) s where s like 'sha256:%' order by 1" 2>/dev/null); src=$?; nsum=0; badsum=""
  while IFS='|' read -r v s; do
    [ -z "$v" ] && continue; nsum=$((nsum+1))
    f=""; for c in "$MIGDIR"/"$v"_*.sql; do [ -f "$c" ] && { f=$c; break; }; done
    if [ -z "$f" ] || [ "sha256:$(sha "$f" | cut -c1-64)" != "$s" ]; then badsum="$badsum $v"; fi
  done <<EOF
$sums
EOF
  if [ $src -ne 0 ]; then fail "migration ledger checksum query failed"
  elif [ -z "$badsum" ]; then pass "migration ledger checksums: $nsum recorded, all equal to the repo files"; else fail "migration ledger checksum mismatch:$badsum"; fi
  top=$(psql_db -c "select max(version) from supabase_migrations.schema_migrations" 2>/dev/null)
  if [ "$top" = "$EXPECT" ]; then pass "schema version $top"; else fail "schema version is '${top}', expected $EXPECT (wrong backup or wrong target)"; fi
  if [ -n "$STORAGE" ]; then
    rows=$(psql_db -c "select bucket_id || '/' || name || '/' || coalesce(version, '') || '|' || coalesce(metadata->>'size', '') from storage.objects order by 1"); qrc=$?
    if [ $qrc -ne 0 ]; then fail "storage: objects query failed"
    else
      files=$(cd "$STORAGE" && find . -type f | sed 's#^\./##')
      n=0; miss=0; sz=0
      while IFS='|' read -r p size; do
        [ -z "$p" ] && continue
        n=$((n+1))
        f=$(printf '%s\n' "$files" | grep -F -- "/$p" | head -1)
        if [ -z "$f" ] && printf '%s\n' "$files" | grep -qxF -- "$p"; then f=$p; fi
        if [ -z "$f" ]; then miss=$((miss+1)); continue; fi
        if [ -n "$size" ] && [ "$(wc -c < "$STORAGE/$f" | tr -d ' ')" != "$size" ]; then sz=$((sz+1)); fi
      done <<EOF
$rows
EOF
      want_n=""
      [ -n "$COUNTS" ] && want_n=$(jq -r '.storage_objects // empty' "$COUNTS" 2>/dev/null)
      if [ -n "$want_n" ] && [ "$n" != "$want_n" ]; then fail "storage: $n object rows, the backup recorded $want_n"
      elif [ "$miss" -eq 0 ] && [ "$sz" -eq 0 ]; then pass "storage: all $n object(s) present with their recorded size"
      else fail "storage: $miss of $n object(s) missing, $sz with a wrong size"; fi
    fi
  fi
  finish ;;

*) sed -n '2,40p' "$0"; exit 2 ;;
esac
