#!/usr/bin/env bash
# sweep-abandoned-uploads.sh — remove product-images objects left behind by
# upload sessions that never completed (G5 follow-up,
# docs/selfhost-migration/phase-f/g5-followups.md §2).
#
# A phone (or desktop) holding a 60 s signed upload token can PUT an object to
# org/<org>/temp/<session> and never call the validating completion. Such an
# object is served from the public origin until someone removes it. This job
# removes exactly those objects, and nothing else:
#
#   * candidates come from sweep-abandoned-uploads.sql (READ ONLY transaction):
#     server-minted session path org/<org>/temp/pimg-<32 hex>, a matching
#     session row of a creator in that org, the session never completed and is
#     EXPIRED / CANCELED / PENDING past expiry, and session + object older than
#     the grace period (default 24 h);
#   * objects that any products.image_url / business_profile.logo_url /
#     session public_url points at, or whose path another session row also
#     holds, are KEPT (reported as "referenced"; a name referenced on any row
#     is never deleted);
#   * every name whose sha256 is in the allow-list (the 574 objects that
#     existed at the self-host migration, sweep-protected-objects.sha256) is
#     KEPT, whatever the database says;
#   * the candidate query runs twice (before deciding and right before
#     deleting); only names that are "delete" both times are removed;
#   * deletion goes through storage-api with the service role (the row AND
#     the file), in batches; afterwards the names must be gone.
#
# Default is a DRY RUN that prints counts only. Object names are never printed.
#
# Usage:
#   sweep-abandoned-uploads.sh [--dry-run | --apply] [--grace-hours N] [--max-delete N]
#                              [--allow-list FILE]
#   sweep-abandoned-uploads.sh --make-allow-list STORAGE_MANIFEST OUT_FILE
#
# Environment (non-secret; defaults match the server layout of backup-lib.sh):
#   STACK_DIR            /srv/supabase/stack   (compose project; .env holds SERVICE_ROLE_KEY)
#   DB_SERVICE           db                     (compose service of Postgres)
#   DB_ADMIN_USER        supabase_admin
#   SWEEP_DB_CONTAINER   unset                  (docker exec into this container instead of compose; tests)
#   SWEEP_API_URL        http://127.0.0.1:8000  (gateway on loopback)
#   SWEEP_ENV_FILE       $STACK_DIR/.env        (only SERVICE_ROLE_KEY is read, by its exact name; never printed)
#   SWEEP_LOCK_DIR       ${TMPDIR:-/tmp}
#
# NOT scheduled. A cron line can be added later (g5-followups.md §2.5).
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="${STACK_DIR:-/srv/supabase/stack}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_ADMIN_USER="${DB_ADMIN_USER:-supabase_admin}"
SWEEP_API_URL="${SWEEP_API_URL:-http://127.0.0.1:8000}"
SWEEP_ENV_FILE="${SWEEP_ENV_FILE:-$STACK_DIR/.env}"
SWEEP_LOCK_DIR="${SWEEP_LOCK_DIR:-${TMPDIR:-/tmp}}"
SQL_FILE="$HERE/sweep-abandoned-uploads.sql"
ALLOW_LIST="$HERE/sweep-protected-objects.sha256"
MODE=dry-run
GRACE_HOURS=24
MAX_DELETE=500
BATCH=50
NAME_RE='^org/[A-Za-z0-9_-]+/temp/pimg-[0-9a-f]{32}$'

log() { printf '%s [sweep-abandoned-uploads] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
usage() { sed -n 2,44p "$0"; exit 2; }

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi
}

# --make-allow-list MANIFEST OUT: hash every object NAME of a storage manifest
# ("<content sha256>  <name>" per line, tools/selfhost-migration/verify_objects.py
# --make-manifest) into OUT. Names never leave the Mac; OUT holds only hashes.
make_allow_list() {
  local manifest="$1" out="$2" n src
  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  n="$(grep -cE '^[0-9a-f]{64} +' "$manifest" || true)"
  [[ "$n" -gt 0 ]] || die "no '<sha256> <name>' lines in $manifest"
  src="$(sha256_stdin <"$manifest")"
  {
    echo "# sweep-abandoned-uploads allow-list: sha256 of each product-images object NAME that existed at the"
    echo "# self-host migration (2026-10-12). These objects are never deleted by the sweep."
    echo "# source: storage manifest (sha256 of the manifest file: $src)"
    echo "# count: $n"
    sed -E 's/^[0-9a-f]{64} +//' "$manifest" | while IFS= read -r name; do printf '%s' "$name" | sha256_stdin; done | LC_ALL=C sort
  } >"$out"
  chmod 0644 "$out"
  log "allow-list written: $n name hashes"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift;;
    --apply) MODE=apply; shift;;
    --grace-hours) GRACE_HOURS="${2:-}"; shift 2;;
    --max-delete) MAX_DELETE="${2:-}"; shift 2;;
    --allow-list) ALLOW_LIST="${2:-}"; shift 2;;
    --make-allow-list) [[ $# -ge 3 ]] || usage; make_allow_list "$2" "$3"; exit 0;;
    -h|--help) usage;;
    *) log "unknown option $1"; usage;;
  esac
done
[[ "$GRACE_HOURS" =~ ^[0-9]+$ ]] && (( GRACE_HOURS >= 1 && GRACE_HOURS <= 8760 )) || die "--grace-hours must be an integer 1..8760 (sessions live 10 minutes; 24 is the default)"
[[ "$MAX_DELETE" =~ ^[0-9]+$ ]] && (( MAX_DELETE >= 1 )) || die "--max-delete must be a positive integer"
[[ -f "$SQL_FILE" ]] || die "candidate query not found: $SQL_FILE"

# ---- allow-list: present, well-formed, count matches its header ----
[[ -f "$ALLOW_LIST" ]] || die "allow-list not found: $ALLOW_LIST (refusing to run without it)"
want="$(sed -nE 's/^# count: ([0-9]+)$/\1/p' "$ALLOW_LIST" | head -1)"
have="$(grep -cE '^[0-9a-f]{64}$' "$ALLOW_LIST" || true)"
bad="$( { grep -vE '^#|^[0-9a-f]{64}$|^$' "$ALLOW_LIST" || true; } | wc -l | tr -d ' ')"
[[ -n "$want" && "$want" == "$have" && "$bad" == 0 ]] || die "allow-list malformed (header count '${want:-?}', hashes $have, other lines $bad)"

# ---- lock ----
LOCK="$SWEEP_LOCK_DIR/sweep-abandoned-uploads.lock"
mkdir "$LOCK" 2>/dev/null || die "another run holds $LOCK"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sweep.XXXXXX")"
cleanup() { rm -rf "$WORK"; rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

psql_admin() {
  if [[ -n "${SWEEP_DB_CONTAINER:-}" ]]; then
    docker exec -i "$SWEEP_DB_CONTAINER" psql -X -q -At -U "$DB_ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 "$@"
  else
    (cd "$STACK_DIR" && docker compose exec -T "$DB_SERVICE" psql -X -q -At -U "$DB_ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 "$@")
  fi
}
candidates() { psql_admin -F $'\t' -v grace_hours="$GRACE_HOURS" <"$SQL_FILE"; }

# filter.py: drop allow-listed names, re-check the name pattern, count.
filter_candidates() {  # IN OUT_DELETE OUT_SUMMARY
  python3 -I - "$1" "$ALLOW_LIST" "$2" "$3" "$NAME_RE" <<'PY'
import hashlib, re, sys
src, allow_path, out_delete, out_summary, name_re = sys.argv[1:6]
allowed = {l.strip() for l in open(allow_path) if re.fullmatch(r"[0-9a-f]{64}", l.strip())}
pat = re.compile(name_re)
c = {"rows": 0, "delete": 0, "delete_bytes": 0, "referenced": 0, "allow_listed": 0, "bad_name": 0}
by_status = {}
keep = []
referenced = set()
for line in open(src):
    line = line.rstrip("\n")
    if not line:
        continue
    verdict, name, status, _age, size = line.split("\t")
    c["rows"] += 1
    if not pat.fullmatch(name):
        c["bad_name"] += 1
        continue
    if hashlib.sha256(name.encode()).hexdigest() in allowed:
        c["allow_listed"] += 1
        continue
    if verdict != "delete":
        c["referenced"] += 1
        referenced.add(name)
        continue
    keep.append((name, status, int(size or 0)))
# a name that is "referenced" on ANY row (e.g. two sessions holding one path)
# is never deleted, and a name is deleted at most once
seen = set()
final = []
for name, status, size in keep:
    if name in referenced or name in seen:
        continue
    seen.add(name)
    c["delete"] += 1
    c["delete_bytes"] += size
    by_status[status] = by_status.get(status, 0) + 1
    final.append(name)
open(out_delete, "w").write("".join(n + "\n" for n in sorted(final)))
statuses = ",".join(f"{k}={v}" for k, v in sorted(by_status.items())) or "-"
open(out_summary, "w").write(
    f"candidates={c['rows']} delete={c['delete']} delete_bytes={c['delete_bytes']} by_status={statuses} "
    f"kept_referenced={c['referenced']} kept_allow_listed={c['allow_listed']} kept_bad_name={c['bad_name']}\n")
PY
}

log "mode=$MODE grace=${GRACE_HOURS}h max_delete=$MAX_DELETE allow_list=$(basename "$ALLOW_LIST") ($have names)"
total_before="$(psql_admin -c "SELECT count(*) FROM storage.objects WHERE bucket_id = 'product-images'")" || die "cannot query the database"
candidates >"$WORK/c1.tsv" || die "candidate query failed"
filter_candidates "$WORK/c1.tsv" "$WORK/d1.txt" "$WORK/s1.txt"
summary="$(cat "$WORK/s1.txt")"
log "objects in product-images: $total_before; $summary"
n_delete="$(grep -c . "$WORK/d1.txt" || true)"

if [[ "$MODE" == dry-run ]]; then
  log "DRY RUN: nothing deleted (re-run with --apply to delete $n_delete object(s))"
  echo "RESULT dry-run objects=$total_before $summary"
  exit 0
fi

(( n_delete <= MAX_DELETE )) || die "$n_delete objects to delete exceeds --max-delete $MAX_DELETE; nothing deleted (investigate, then raise the limit)"
if (( n_delete == 0 )); then
  echo "RESULT apply deleted=0 objects=$total_before $summary"
  exit 0
fi

# ---- second look right before deleting: a name must be "delete" in both runs ----
candidates >"$WORK/c2.tsv" || die "second candidate query failed"
filter_candidates "$WORK/c2.tsv" "$WORK/d2.txt" "$WORK/s2.txt"
LC_ALL=C comm -12 "$WORK/d1.txt" "$WORK/d2.txt" >"$WORK/final.txt"
n_final="$(grep -c . "$WORK/final.txt" || true)"
while IFS= read -r name; do [[ "$name" =~ $NAME_RE ]] || die "refusing: unexpected name shape in the delete set"; done <"$WORK/final.txt"

# ---- service key: read by its exact name, kept in this shell, sent via curl -K on stdin ----
[[ -r "$SWEEP_ENV_FILE" ]] || die "cannot read $SWEEP_ENV_FILE"
SRV="$(grep -E '^SERVICE_ROLE_KEY=' "$SWEEP_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
[[ -n "$SRV" ]] || die "SERVICE_ROLE_KEY not found in $SWEEP_ENV_FILE"

deleted=0; failed=0
split -l "$BATCH" "$WORK/final.txt" "$WORK/batch."
for f in "$WORK"/batch.*; do
  body="$(python3 -I -c 'import json,sys; print(json.dumps({"prefixes": [l.strip() for l in open(sys.argv[1]) if l.strip()]}))' "$f")"
  code="$(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$SRV" "$SRV" \
    | curl -sS -K - -o "$WORK/resp.json" -w '%{http_code}' -X DELETE -H 'Content-Type: application/json' \
        --data-binary "$body" "$SWEEP_API_URL/storage/v1/object/product-images")" || code=000
  n="$(grep -c . "$f")"
  if [[ "$code" == 200 ]]; then deleted=$((deleted + n)); else failed=$((failed + n)); log "batch of $n failed: HTTP $code"; fi
done
unset SRV

# ---- verify: none of the deleted names is still present ----
arr="{$(paste -sd, "$WORK/final.txt")}"
left="$(psql_admin -v names="$arr" <<'SQL'
SELECT count(*) FROM storage.objects WHERE bucket_id = 'product-images' AND name = ANY (:'names'::text[]);
SQL
)"
total_after="$(psql_admin -c "SELECT count(*) FROM storage.objects WHERE bucket_id = 'product-images'")"
log "deleted=$deleted failed=$failed still_present=$left objects $total_before -> $total_after (first look $n_delete, both looks $n_final)"
echo "RESULT apply deleted=$deleted failed=$failed still_present=$left objects_before=$total_before objects_after=$total_after $summary"
[[ "$failed" == 0 && "$left" == 0 ]] || exit 1
