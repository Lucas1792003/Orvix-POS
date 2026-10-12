#!/usr/bin/env bash
# Produce supabase/baseline/schema-baseline.sql from a KNOWN-GOOD database.
#
# This script is documentation-as-code: it is NOT run by anything automatically
# and this repository does not decide which database is "known good" - you do.
# It never connects anywhere unless you pass it a connection URL explicitly.
#
# Usage:
#   BASELINE_DB_URL='postgresql://postgres:***@HOST:5432/postgres' \
#   ./supabase/baseline/make_baseline.sh --level 066
#
#   --level NNN   the highest migration number already applied to that database
#                 (recorded in the file header; the fresh-install path applies
#                 every migration numbered ABOVE it). Required.
#   --out PATH    output file (default: supabase/baseline/schema-baseline.sql)
#
# What it dumps: pg_dump --schema-only of the application schema only, the
# same shape as `supabase db dump` (public objects, extensions, policies,
# grants, publication membership), excluding every Supabase-internal schema
# (auth, storage, realtime, vault, net, cron, graphql, supabase_* ...). Those
# are owned by the platform services (GoTrue, Storage, Realtime) and are
# created by them on first boot - restoring them from a dump would collide.
#
# What it does NOT contain: data (no rows, no secrets), roles (the platform
# image ships anon/authenticated/service_role/postgres/supabase_admin),
# auth.users (GoTrue creates it; the public FKs to it require GoTrue to have
# booted first - see README.md "Fresh install").
#
# Safety: the output is grepped for secret-looking material (JWTs, Bearer
# tokens, API keys, connection strings with passwords) and the script refuses
# to write the file if anything matches. pg_dump >= 17.6 emits
# \restrict/\unrestrict guard lines that older psql cannot parse; they are
# stripped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/schema-baseline.sql"
LEVEL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --level) LEVEL="$2"; shift 2;;
    --out)   OUT="$2";   shift 2;;
    -h|--help) sed -n '2,32p' "$0"; exit 0;;
    *) echo "unknown argument: $1"; exit 2;;
  esac
done

[ -n "${BASELINE_DB_URL:-}" ] || { echo "BASELINE_DB_URL is not set (refusing to guess a database)"; exit 2; }
[ -n "$LEVEL" ] || { echo "--level NNN is required (highest migration applied to the source database)"; exit 2; }
command -v pg_dump >/dev/null || { echo "pg_dump not found (brew install libpq)"; exit 2; }

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Mirror of the schema exclusion list the Supabase CLI uses for `db dump`.
EXCLUDES=(
  auth storage realtime vault net cron extensions graphql graphql_public
  pgsodium pgsodium_masks pgbouncer _realtime _analytics
  supabase_functions supabase_migrations
  'information_schema' 'pg_*'
)
ARGS=()
for s in "${EXCLUDES[@]}"; do ARGS+=(--exclude-schema="$s"); done

pg_dump "$BASELINE_DB_URL" \
  --schema-only --quote-all-identifiers --no-tablespaces \
  "${ARGS[@]}" \
  | grep -vE '^\\(un)?restrict ' > "$TMP"

# Refuse to keep anything that looks like a secret.
if grep -nEi 'eyJ[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{16,}|sb_(secret|publishable)_|service_role_key|password=|postgres(ql)?://[^ ]*:[^ ]*@' "$TMP" >/dev/null; then
  echo "REFUSING: secret-looking material found in the dump (see matches below); fix the source and retry"
  grep -nEi 'eyJ[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{16,}|sb_(secret|publishable)_|service_role_key|password=|postgres(ql)?://[^ ]*:[^ ]*@' "$TMP" | cut -c1-120
  exit 3
fi

{
  echo "-- supabase/baseline/schema-baseline.sql"
  echo "-- baseline-migration-level: $LEVEL"
  echo "-- generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) by make_baseline.sh (pg_dump --schema-only, app schema only)"
  echo "-- Fresh install: restore this file, then apply supabase/migrations/*.sql numbered > $LEVEL in order."
  echo "-- Contains no data and no secrets (checked). See supabase/baseline/README.md."
  echo
  cat "$TMP"
} > "$OUT"

echo "wrote $OUT ($(wc -l < "$OUT") lines, level $LEVEL)"
echo "functions: $(grep -c '^CREATE OR REPLACE FUNCTION' "$OUT")  tables: $(grep -c '^CREATE TABLE' "$OUT")  policies: $(grep -c '^CREATE POLICY' "$OUT")"
echo "next: review the diff, run supabase/tests/phase-d/run.sh with BASELINE_SQL=$OUT, then commit."
