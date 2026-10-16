#!/usr/bin/env bash
# Same fingerprint, taken from the disposable phf-iso-db (local), for comparison
# against the live one. Called by run.sh at the 081 level.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: local-dump.sh <outdir>}"
DB="${PHF_ISO_DB:-phf-iso-db}"
mkdir -p "$OUT"
docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < "$HERE/fingerprint.sql" > "$OUT/local.fingerprint" 2> "$OUT/local.err"
rc=$?
[ "$rc" = 0 ] || { echo "local fingerprint FAILED:"; tail -5 "$OUT/local.err"; exit "$rc"; }
echo "local fingerprint: $(wc -l < "$OUT/local.fingerprint") lines"
