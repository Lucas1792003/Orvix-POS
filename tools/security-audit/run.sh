#!/usr/bin/env bash
# Organization-isolation security audit — one command.
#
#   tools/security-audit/run.sh [--max-migration NNN]... [--parity] [--keep] [--stack-only]
#
# Default: audit at 081 (production level), then at 082 (prepared fix).
# Each level: build the disposable phf-iso-* stack on 127.0.0.1, seed two
# synthetic orgs with real GoTrue users/JWTs, run every suite, write results,
# tear everything down (trap, also on failure). --parity additionally runs the
# READ-ONLY live schema-parity check (needs PHF_ISO_PARITY_SSH; see README).
# Exit 0 only if parity (when requested) and the coverage gate pass and no
# suite has an unexpected FAIL. Expected gaps are reported as GAP, not FAIL.
set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BASELINE_SQL="${BASELINE_SQL:-$HOME/shwephala-migration/20261011T2347Z/schema.scrubbed.sql}"
LEVELS=(); KEEP=0; PARITY=0; STACK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-migration) LEVELS+=("$2"); shift 2;;
    --keep) KEEP=1; shift;;
    --parity) PARITY=1; shift;;
    --stack-only) STACK_ONLY=1; KEEP=1; shift;;
    -h|--help) sed -n 2,14p "$0"; exit 0;;
    *) echo "unknown option $1"; exit 2;;
  esac
done
[ ${#LEVELS[@]} -gt 0 ] || LEVELS=(081 082)

TS="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS="$HERE/results/$TS"
mkdir -p "$RESULTS"
WORK=""
log() { printf '\n==> %s\n' "$*"; }
die() { echo "ABORT: $*"; exit 3; }

. "$HERE/stack/up.sh"

cleanup() {
  rc=$?
  if [ "$KEEP" = 1 ]; then
    echo "--keep: stack left running; secrets in $WORK/secrets.env; remove with: docker rm -f \$(docker ps -aq --filter name=phf-iso-) && docker network rm phf-iso-net"
  else
    stack_down
    [ -n "$WORK" ] && rm -rf "$WORK"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

[ -f "$BASELINE_SQL" ] || die "BASELINE_SQL not found: $BASELINE_SQL"
for t in docker psql node jq openssl curl; do command -v "$t" >/dev/null || die "$t not found"; done
[ -d "$REPO/node_modules/@supabase/supabase-js" ] || die "run 'npm ci' in $REPO first"
TSX="$REPO/node_modules/.bin/tsx"

OVERALL=0
if [ "$PARITY" = 1 ]; then
  log "live schema parity (READ-ONLY)"
  bash "$HERE/parity/live-parity.sh" "$RESULTS/parity" || OVERALL=1
fi

for MAX_MIG in "${LEVELS[@]}"; do
  [ -n "$WORK" ] && rm -rf "$WORK"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/phf-iso.XXXXXX")"; chmod 700 "$WORK"
  OUT="$RESULTS/m$MAX_MIG"; mkdir -p "$OUT"
  log "=== audit at migration $MAX_MIG ==="
  stack_up 2>&1 | tee "$OUT/stack.log" | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'
  [ "${PIPESTATUS[0]}" = 0 ] || die "stack_up failed at $MAX_MIG"
  if [ "$STACK_ONLY" = 1 ]; then echo "stack-only: up at $MAX_MIG"; exit 0; fi

  log "catalog inventory"
  su_psql -At < "$HERE/sql/inventory.sql" > "$OUT/inventory.json" || die "inventory"
  # Parity is proven at 081 only (= production level); at 082 the disposable
  # carries the not-yet-deployed migration, so it legitimately differs.
  if [ "$PARITY" = 1 ] && [ -d "$RESULTS/parity" ] && [ "$((10#$MAX_MIG))" -eq 81 ]; then
    bash "$HERE/parity/local-dump.sh" "$OUT/parity-local"
    if node "$HERE/parity/compare.mjs" "$RESULTS/parity" "$OUT/parity-local" "$MAX_MIG" > "$OUT/parity.txt"; then
      echo "parity 081: PASS"
    else
      echo "parity 081: FAIL (see $OUT/parity-081.md)"; OVERALL=1
    fi
    head -3 "$OUT/parity.txt" 2>/dev/null
  fi

  log "seed (two orgs, real GoTrue users, TOTP, RPC-made records, storage objects)"
  set -a; . "$WORK/secrets.env"; set +a
  PHF_ISO_MAX_MIG="$MAX_MIG" PHF_ISO_OUT="$OUT" PHF_ISO_DB="$DB" "$TSX" "$HERE/suites/main.ts" 2>&1 | tee "$OUT/suites.log" \
    | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g' | grep -E '^(==|PASS|FAIL|GAP|SKIP|INFO|summary)' | tail -400
  [ "${PIPESTATUS[0]}" = 0 ] || OVERALL=1

  log "coverage gate ($MAX_MIG)"
  node "$HERE/coverage/gate.mjs" "$OUT/inventory.json" "$OUT/results.json" "$HERE/coverage/static-map.json" "$OUT" || OVERALL=1
  stack_down
done

node "$HERE/coverage/summarise.mjs" "$RESULTS" > "$RESULTS/SUMMARY.md" || OVERALL=1
cat "$RESULTS/SUMMARY.md"
exit $OVERALL
