#!/usr/bin/env bash
# fake-docker.sh — stands in for `docker` in gate-unit-test.sh: answers the psql calls that
# dr-verify-restore.sh makes (docker exec -i CT psql ... -c QUERY | -f -) from fixture files in
# $FAKE_STATE. No database, no container. Every call is appended to $FAKE_STATE/calls.log.
#   got.json   the json_build_object counts      rows.json  the per-table row counts
#   versions   the migration ledger versions      top        max(version)
#   FAKE_FAIL=counts|rows|versions|sums|top|all   that query exits 1 (all: every query, "unreachable")
#   FAKE_EMPTY_INVARIANTS=1                       a SQL file on stdin yields no rows
#   FAKE_VIOLATE=<label substring>                that invariant reports 1 instead of 0
set -u
st=${FAKE_STATE:?FAKE_STATE}
q=""; prev=""
for a in "$@"; do [ "$prev" = "-c" ] && q=$a; prev=$a; done
printf '%s' "$*" | tr '\n' ' ' | cut -c1-200 >>"$st/calls.log"; echo >>"$st/calls.log"
[ "${1:-}" = exec ] || { echo "fake-docker: only 'exec' is modelled ($1)" >&2; exit 125; }
[ "${FAKE_FAIL:-}" = all ] && { echo "psql: error: connection refused" >&2; exit 2; }
failing() { [ "${FAKE_FAIL:-}" = "$1" ] && { echo "ERROR:  simulated failure ($1)" >&2; exit 1; }; return 0; }
if [ -z "$q" ]; then
  # a SQL file on stdin: one "<label>|0" row per static check (fingerprint output is unused here)
  sql=$(cat)
  [ "${FAKE_EMPTY_INVARIANTS:-0}" = 1 ] && exit 0
  printf '%s\n' "$sql" | sed -nE "s/^SELECT '([^']*)'.*/\1/p" | while IFS= read -r l; do
    if [ -n "${FAKE_VIOLATE:-}" ] && printf '%s' "$l" | grep -qF -- "$FAKE_VIOLATE"; then echo "$l|1"; else echo "$l|0"; fi
  done
  exit 0
fi
case "$q" in
  "select 1") echo 1 ;;
  *json_build_object*) failing counts; cat "$st/got.json" ;;
  *json_object_agg*) failing rows; cat "$st/rows.json" ;;
  *"like 'sha256:%'"*) failing sums; cat "$st/sums" 2>/dev/null ;;
  "select version from supabase_migrations.schema_migrations order by 1") failing versions; cat "$st/versions" ;;
  "select max(version) from supabase_migrations.schema_migrations") failing top; cat "$st/top" ;;
  *storage.objects*) : ;;
  *) echo "fake-docker: unmodelled query: $(printf '%s' "$q" | cut -c1-80)" >&2; exit 1 ;;
esac
