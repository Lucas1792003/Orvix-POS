#!/usr/bin/env bash
# Migration 087 verification on DISPOSABLE local resources only (README.md in this directory).
#   tools/m087-verify/run.sh [TAG]                 every part
#   PARTS="x2 legacy" tools/m087-verify/run.sh TAG  selected parts (x2 creates the 087 state the later stack parts use)
#   KEEP=1 ...                                      leave the stack up
# Parts: stack (lib/stack.sh), x2 (stack suite: the real migration through the real runner), browser (Chromium), legacy
# (client-generation harness on the captured responses), compat (086's live SQL suite with 087 installed), x3 (restores of
# the real migration on the real database image), x1 (restore matrix on plain PostgreSQL), archive (the rolled-back archive
# allow-list; last: it rolls 087 back and re-installs it). Nothing here contacts lucashome, hosted Supabase or any real backup.
# Upstream Envoy files: UPSTREAM_ENVOY_DIR, else fetched from the pinned commit.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
TAG=${1:-run-$(date +%Y%m%dT%H%M%S)}; RES="$HERE/results/$TAG"; mkdir -p "$RES"; RES=$(cd "$RES" && pwd)
PARTS="${PARTS:-stack x2 browser legacy compat x3 x1 archive}"
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
FAILED=0; say() { echo "$*" | tee -a "$RES/summary.txt"; }
cleanup() {
  docker rm -f -v phf-iso-envoy phf-iso-envoy-maint phf-iso-envoy-wild zz-m087-r1 zz-m087-r2 >/dev/null 2>&1
  docker volume rm zz-m087-r1 zz-m087-r2 >/dev/null 2>&1
  [ "${KEEP:-0}" = 1 ] || bash "$HERE/lib/stack.sh" down "$RES/stack" >/dev/null 2>&1
}
trap cleanup EXIT
result() { local f=$1 n; n=$(grep -E '^== RESULT' "$f" 2>/dev/null | tail -1); say "$2: ${n:-no result line}"; grep -qE 'RESULT: [0-9]+ passed, 0 failed' <<<"$n" || FAILED=1; }
for part in $PARTS; do
  case $part in
    stack)  bash "$HERE/lib/stack.sh" up "$RES/stack" | tee -a "$RES/summary.txt" | tail -1 | grep -q 'stack up' || { say "stack: FAILED"; exit 1; } ;;
    x2)     bash "$HERE/x2-stack.sh" "$RES" > "$RES/x2.log" 2>&1; result "$RES/x2/X2.txt" "x2 stack suite" ;;
    browser)
      SWORK=$(cat "$RES/stack/swork.path"); set -a; . "$SWORK/secrets.env"; set +a
      sed "s/value: 'authorization,apikey,content-type,x-client-info,x-orvix-epoch,prefer,accept-profile,content-profile,range,x-retry-count,x-supabase-api-version,x-upsert,cache-control'/value: '*'/" \
        "$ROOT/deploy/lucashome/envoy-recovery-maintenance.yaml" > "$RES/maint-wildcard.yaml"
      docker rm -f phf-iso-envoy-wild >/dev/null 2>&1
      docker run -d --name phf-iso-envoy-wild -p 127.0.0.1::8000 -v "$RES/maint-wildcard.yaml:/etc/envoy/envoy.yaml:ro" envoyproxy/envoy:v1.39.1 >/dev/null; sleep 4
      b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
      CASH=$(jq -r '.orgs[0].users.cashA' "$RES/stack/state.json"); SUB=$(docker exec phf-iso-db psql -X -U supabase_admin -d postgres -Atc "select auth_id from users where id = '$CASH'")
      H=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url); P=$(printf '{"role":"authenticated","iss":"supabase","aud":"authenticated","exp":%s,"sub":"%s"}' "$(( $(date +%s) + 3600 ))" "$SUB" | b64url)
      JWT="$H.$P.$(printf '%s.%s' "$H" "$P" | openssl dgst -sha256 -hmac "$PHF_ISO_JWT_SECRET" -binary | b64url)"
      ( cd "$HERE/browser" && M087_MAINT_URL=$(cat "$RES/x2/maint.url") M087_ENVOY_URL=$(cat "$RES/x2/envoy.url") \
          M087_WILDCARD_URL="http://127.0.0.1:$(docker port phf-iso-envoy-wild 8000/tcp | head -1 | sed 's/.*://')" M087_ANON_KEY="$PHF_ISO_ANON_KEY" M087_SERVICE_KEY="$PHF_ISO_SERVICE_KEY" M087_JWT="$JWT" M087_ORG="$(jq -r '.orgs[1].org' "$RES/stack/state.json")" \
          "$ROOT/node_modules/.bin/playwright" test -c playwright.config.ts 2>&1 | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g' ) > "$RES/browser.log"
      say "browser (Chromium): $(grep -E '[0-9]+ (passed|failed)' "$RES/browser.log" | tr '\n' ' ')$(grep -o 'wildcard allow-headers.*' "$RES/browser.log" | head -1 | sed 's/^/; /')"; grep -qE '[0-9]+ failed' "$RES/browser.log" && FAILED=1
      grep -qE '[0-9]+ passed' "$RES/browser.log" || FAILED=1 ;;
    legacy) # fails closed: a harness error, an empty table or fewer rows than captured 429 fixtures is a failure
      bash "$HERE/legacy/run-harness.sh" "$RES/x2/fixtures-429.json" "$RES/legacy.txt"; HX=$?
      NF=$(jq '[.[] | select(.status == 429)] | length' "$RES/x2/fixtures-429.json" 2>/dev/null || echo 0)
      NR=$(awk '/1. ONLINE CHECKOUT/,/classifier class/' "$RES/legacy.txt" | grep -cE '^  F429')
      E=$(awk '/1. ONLINE CHECKOUT/,/classifier class/' "$RES/legacy.txt" | grep -E '^  F429' | grep -cvE 'ERROR_SHOWN.*ERROR_SHOWN.*ERROR_SHOWN.*ERROR_SHOWN.*ERROR_SHOWN')
      say "legacy harness (exit $HX): $NR of $NF captured 429 responses classified at online checkout; rows where some version does NOT show an error at the counter: $E"
      { [ "$HX" = 0 ] && [ "$NF" -gt 0 ] && [ "$NR" = "$NF" ] && [ "$E" = 0 ]; } || FAILED=1 ;;
    compat) bash "$HERE/compat.sh" "$RES" > "$RES/compat.log" 2>&1 && say "compat: $(grep -E 'm086-sql' "$RES/compat.log")" || { say "compat: FAILED ($(grep -E 'm086-sql' "$RES/compat.log"))"; FAILED=1; } ;;
    x3)     bash "$HERE/x3-restores.sh" "$RES" > "$RES/x3.log" 2>&1; result "$RES/x3/X3.txt" "x3 restores (real migration, real image)" ;;
    x1)     bash "$HERE/x1/x1-plainpg.sh" "$RES" > "$RES/x1.log" 2>&1; result "$RES/x1/X1.txt" "x1 restore matrix (plain PostgreSQL)" ;;
    archive) python3 -I "$HERE/archive/archive-allowlist.py" "$RES" > "$RES/archive.log" 2>&1; result "$RES/archive/ARCHIVE.txt" "archive allow-list (rolled-back 087)" ;;
    *) say "unknown part $part"; FAILED=1 ;;
  esac
done
[ "$FAILED" = 0 ] && say "ALL PARTS PASSED ($TAG)" || say "SOME PARTS FAILED ($TAG) — see $RES"
exit $FAILED
