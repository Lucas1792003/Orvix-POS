#!/usr/bin/env bash
# Read-only export of the hosted Supabase project into a private local workspace.
# Run by the OWNER in a terminal (the hosted DB password is prompted once, never stored):
#   MIGRATION_WORKSPACE=<dir> bash tools/selfhost-migration/export_hosted.sh            # new workspace <dir>/<ts>
#   W=<dir>/<ts> bash tools/selfhost-migration/export_hosted.sh                          # resume/complete an existing one
# MIGRATION_WORKSPACE (or W) is required: a private directory outside the repo.
# Every hosted operation is a read (pg_dump / pg_dumpall --roles-only / SELECT / storage download).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
T="$REPO/tools/selfhost-migration"
cd "$REPO"

umask 077
if [ -z "${W:-}" ]; then
  [ -n "${MIGRATION_WORKSPACE:-}" ] || { echo "set MIGRATION_WORKSPACE (private directory outside the repo) or W"; exit 2; }
  W="$MIGRATION_WORKSPACE/$(date -u +%Y%m%dT%H%MZ)"
fi
mkdir -p "$(dirname "$W")" "$W"; chmod 700 "$(dirname "$W")" "$W"
echo "workspace: $W"
case "$W" in "$REPO"*) echo "refusing: workspace inside the repo"; exit 1;; esac

q() { supabase db query --linked "$@" 2>/dev/null | grep -v "new version\|recommend updating\|Initialising"; }
step() { printf '\n== %s ==\n' "$*"; }

# ---------- password-free, read-only ----------
step "linked project"; supabase projects list 2>/dev/null | python3 -c "import sys,json; p=[x for x in json.load(sys.stdin)['projects'] if x['linked']]; print(p[0]['ref'], p[0]['name'], p[0]['status'], p[0]['database']['version'])"

step "manifest + inventories (SELECT only)"
[ -s "$W/manifest-hosted.json" ]    || q -f "$T/sql/manifest.sql"              > "$W/manifest-hosted.json"
[ -s "$W/columns-hosted.json" ]     || q -f "$T/sql/columns_inventory.sql"     > "$W/columns-hosted.json"
[ -s "$W/constraints-hosted.json" ] || q -f "$T/sql/constraints_inventory.sql" > "$W/constraints-hosted.json"
python3 -c "import json,sys; d=json.load(open('$W/manifest-hosted.json')); print('manifest rows:', len(d['rows']))"

step "storage objects (download only)"
mkdir -p "$W/storage"
# the CLI recreates the bucket directory under the destination: files land in $W/storage/product-images/<name>
if [ "$(find "$W/storage/product-images" -type f 2>/dev/null | wc -l | tr -d ' ')" = "0" ]; then
  supabase storage cp --experimental --linked -r ss:///product-images/ "$W/storage/" -j 4 >/dev/null 2>&1 || true
else echo "objects already downloaded; skipping"; fi
[ -s "$W/storage-objects.json" ] || q "select name, metadata->>'mimetype' as mime, (metadata->>'size')::bigint as size, metadata->>'cacheControl' as cc, id, version, created_at from storage.objects where bucket_id='product-images' order by name" > "$W/storage-objects.json"
python3 "$T/verify_objects.py" --make-manifest "$W/storage/product-images" --out "$W/storage-manifest.sha256"
echo "files downloaded: $(find "$W/storage/product-images" -type f | wc -l | tr -d ' ')  objects in metadata: $(python3 -c "import json; print(len(json.load(open('$W/storage-objects.json'))['rows']))")"

# ---------- dumps (need the hosted DB password; prompted, never stored) ----------
step "dumps (pg_dump via the CLI; password prompt)"
if [ -s "$W/data.scrubbed.sql" ]; then echo "already scrubbed; skipping dumps"; else
  printf 'Hosted database password (input hidden): '; read -r -s SUPABASE_DB_PASSWORD; echo; export SUPABASE_DB_PASSWORD
  supabase db dump --linked --role-only -f "$W/roles.sql"
  supabase db dump --linked -f "$W/schema.sql"
  supabase db dump --linked --data-only --use-copy -f "$W/data.sql" \
    -x cron.job_run_details -x net._http_response -x net.http_request_queue \
    -x storage.objects -x storage.buckets -x storage.s3_multipart_uploads -x storage.s3_multipart_uploads_parts \
    -x storage.buckets_analytics -x storage.buckets_vectors -x storage.vector_indexes \
    -x auth.audit_log_entries -x auth.flow_state -x auth.one_time_tokens -x auth.mfa_challenges \
    -x auth.mfa_recovery_code_sets -x auth.mfa_recovery_codes -x auth.scim_tokens -x auth.scim_users
  unset SUPABASE_DB_PASSWORD
  ls -la "$W"/roles.sql "$W"/schema.sql "$W"/data.sql

  step "scrub"
  python3 "$T/scrub_dump.py" "$W/data.sql" --out "$W/data.scrubbed.sql" --roles "$W/roles.sql" --schema "$W/schema.sql" \
      --cron-out "$W/cron-job.redacted.txt" --report "$W/data.scrubbed.sql.report.json"
  step "remove unscrubbed originals"
  rm -P "$W/data.sql" "$W/roles.sql" "$W/schema.sql" 2>/dev/null || rm -f "$W/data.sql" "$W/roles.sql" "$W/schema.sql"
fi

step "secret gate (must be 0 hits)"
python3 "$T/check_secrets.py" "$W"

step "structural checks"
for f in data.scrubbed.sql roles.scrubbed.sql schema.scrubbed.sql; do
  printf '%-22s %9s bytes  COPY blocks=%s  terminators=%s  complete=%s\n' "$f" "$(wc -c < "$W/$f" | tr -d ' ')" \
    "$(grep -c '^COPY ' "$W/$f")" "$(grep -c '^\\\.$' "$W/$f")" "$(grep -c 'PostgreSQL database dump complete' "$W/$f")"
done
echo "auth tables in data dump: $(grep -oE '^COPY "auth"\."[a-z_]+"' "$W/data.scrubbed.sql" | sort -u | sed 's/COPY "auth"\.//' | tr -d '"' | tr '\n' ' ')"
echo "public tables in data dump: $(grep -c '^COPY "public"' "$W/data.scrubbed.sql")"

step "checksums"
( cd "$W" && find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} + | sort -k2 > SHA256SUMS )
chmod -R go-rwx "$W"
echo; echo "DONE. Workspace: $W (owner-only). Next: review, then restore per the approved procedure."
