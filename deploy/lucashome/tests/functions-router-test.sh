#!/usr/bin/env bash
# shellcheck disable=SC2015  # `cond && ok || nok`: ok() always returns 0
# functions-router-test.sh — local tests for deploy/lucashome/functions-router.sh and
# functions-main-public-page.patch. Workstation only (bash 3.2-safe); touches no server.
#
#   deploy/lucashome/tests/functions-router-test.sh
#
# Part A (files): the patch applied to the pinned upstream router gives PATCHED_SHA;
#   status/apply/revert on a temp FUNCTIONS_DIR: idempotent apply, timestamped backup,
#   refusal on a modified upstream / merged copy / conflict markers, revert.
# Part B (runtime, needs Docker; SKIP_RUNTIME=1 skips): the patched router in
#   supabase/edge-runtime:v1.76.2 with VERIFY_JWT=true, a throwaway HS256 secret and an
#   empty JWKS, serving EVERY function in supabase/functions/ (read-only mounts).
#   `functions-router.sh verify` runs against it (page public; all others 401 for GET/POST;
#   OPTIONS unchanged; path tricks), plus a positive control with a valid dummy JWT and a
#   negative control: the unpatched upstream router answers the page with 401.
#
# Inputs: UPSTREAM_ROUTER (path to upstream main/index.ts; default: fetched from GitHub at the
#   pinned commit and sha-checked), EDGE_RUNTIME_IMAGE (default supabase/edge-runtime:v1.76.2).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$REPO/deploy/lucashome/functions-router.sh"
PATCH="$REPO/deploy/lucashome/functions-main-public-page.patch"
IMAGE="${EDGE_RUNTIME_IMAGE:-supabase/edge-runtime:v1.76.2}"
UPSTREAM_COMMIT=564eab8ad7840b13324f68b1bfac074ef8d51c21
DENO_JSONC_SHA=a9a29da36c2576f755dd868b9f553a02afdf7d7bccf52e97e65c7f68cf36bfef

UPSTREAM_SHA=$(sed -n 's/^UPSTREAM_SHA=\([0-9a-f]\{64\}\)$/\1/p' "$SCRIPT")
PATCHED_SHA=$(sed -n 's/^PATCHED_SHA=\([0-9a-f]\{64\}\)$/\1/p' "$SCRIPT")
[ -n "$UPSTREAM_SHA" ] && [ -n "$PATCHED_SHA" ] || { echo "cannot read pinned shas from $SCRIPT"; exit 2; }

T="$(mktemp -d)"
CONTAINER=""
cleanup() { [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1; rm -rf "$T"; return 0; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok    $*"; }
nok() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1 (got [$2], want [$3])"; fi; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
gh_raw() { curl -sSfL "https://raw.githubusercontent.com/supabase/supabase/$UPSTREAM_COMMIT/docker/volumes/functions/$1" -o "$2"; }

# --- upstream fixture ----------------------------------------------------------
mkdir -p "$T/upstream"
if [ -n "${UPSTREAM_ROUTER:-}" ]; then cp "$UPSTREAM_ROUTER" "$T/upstream/index.ts"; else gh_raw main/index.ts "$T/upstream/index.ts"; fi
check "upstream fixture sha = UPSTREAM_SHA" "$(sha "$T/upstream/index.ts")" "$UPSTREAM_SHA"

# fresh FUNCTIONS_DIR with the upstream router and fake function dirs
fresh() {
  rm -rf "$T/fd"; mkdir -p "$T/fd/main" "$T/fd/fn-a" "$T/fd/phone-upload-page"
  cp "$T/upstream/index.ts" "$T/fd/main/index.ts"
}
run() { FUNCTIONS_DIR="$T/fd" PATCH_FILE="$PATCH" "$SCRIPT" "$@"; }
nbackups() { find "$T/fd/main" -name 'index.ts.pre-phone-page*' | wc -l | tr -d ' '; }

echo "== Part A: files"
mkdir -p "$T/p/main"; cp "$T/upstream/index.ts" "$T/p/main/index.ts"
( cd "$T/p" && patch -p1 --dry-run < "$PATCH" >/dev/null && patch -p1 < "$PATCH" >/dev/null )
check "patch on upstream gives PATCHED_SHA" "$(sha "$T/p/main/index.ts")" "$PATCHED_SHA"

fresh
out=$(run status); rc=$?
check "status on upstream exits 0" "$rc" 0
case "$out" in *"state:    upstream"*) ok "status reports upstream";; *) nok "status upstream: $out";; esac

out=$(run apply); rc=$?
check "apply exits 0" "$rc" 0
check "apply -> PATCHED_SHA" "$(sha "$T/fd/main/index.ts")" "$PATCHED_SHA"
check "apply made one backup" "$(nbackups)" 1
bk=$(find "$T/fd/main" -name 'index.ts.pre-phone-page.*' | head -1)
check "backup holds upstream" "$(sha "$bk")" "$UPSTREAM_SHA"
case "$bk" in *.pre-phone-page.20[0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ok "backup name has UTC timestamp";; *) nok "backup name $bk";; esac
case "$out" in *"docker compose restart functions"*) ok "apply reminds to restart functions";; *) nok "no restart reminder";; esac

out=$(run apply); rc=$?
check "second apply exits 0" "$rc" 0
case "$out" in *"already patched"*) ok "second apply is a no-op";; *) nok "second apply: $out";; esac
check "second apply made no backup" "$(nbackups)" 1
check "second apply kept PATCHED_SHA" "$(sha "$T/fd/main/index.ts")" "$PATCHED_SHA"
out=$(run status); rc=$?
check "status on patched exits 0" "$rc" 0
case "$out" in *"state:    patched"*) ok "status reports patched";; *) nok "status patched: $out";; esac
case "$out" in *"allow-list marker: present"*) ok "status sees the marker";; *) nok "marker: $out";; esac

out=$(run revert); rc=$?
check "revert exits 0" "$rc" 0
check "revert -> UPSTREAM_SHA" "$(sha "$T/fd/main/index.ts")" "$UPSTREAM_SHA"
out=$(run revert); rc=$?
case "$out" in *"already upstream"*) ok "second revert is a no-op";; *) nok "second revert: $out";; esac

# modified upstream (e.g. a new upstream release)
fresh; printf '// upstream changed\n' >> "$T/fd/main/index.ts"; before=$(sha "$T/fd/main/index.ts")
set +e
out=$(run status 2>&1); rc=$?
check "status on modified upstream exits 1" "$rc" 1
case "$out" in *"upstream changed"*) ok "status says upstream changed";; *) nok "status modified: $out";; esac
out=$(run apply 2>&1); rc=$?
set -e
[ "$rc" -ne 0 ] && ok "apply refuses a modified upstream (rc $rc)" || nok "apply did not refuse"
case "$out" in *"re-derive"*) ok "refusal explains how to re-derive";; *) nok "no re-derive hint";; esac
check "refused apply left the router unchanged" "$(sha "$T/fd/main/index.ts")" "$before"
check "refused apply made no backup" "$(nbackups)" 0
set +e; run revert >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "revert refuses an unknown router" || nok "revert on unknown did not refuse"

# merged copy (allow-list present, sha differs) and conflict markers
fresh; cp "$T/p/main/index.ts" "$T/fd/main/index.ts"; printf '// merged by update.sh\n' >> "$T/fd/main/index.ts"
set +e; out=$(run status 2>&1); rc=$?; set -e
check "status on merged copy exits 1" "$rc" 1
case "$out" in *"marker present but sha differs"*) ok "status flags a merged copy";; *) nok "merged: $out";; esac
fresh; printf '<<<<<<< yours\n=======\n>>>>>>> new\n' >> "$T/fd/main/index.ts"
set +e; out=$(run status 2>&1); rc=$?; set -e
case "$out" in *"CONFLICT MARKERS"*) ok "status flags conflict markers";; *) nok "conflict: $out";; esac

# the 2026-10-13 manual deploy's backup name (no timestamp) is found by revert
fresh; cp "$T/upstream/index.ts" "$T/fd/main/index.ts.pre-phone-page"; cp "$T/p/main/index.ts" "$T/fd/main/index.ts"
out=$(run status)
case "$out" in *"upstream backup: $T/fd/main/index.ts.pre-phone-page"*) ok "status lists the legacy backup";; *) nok "legacy backup: $out";; esac
run revert >/dev/null
check "revert from the legacy backup -> UPSTREAM_SHA" "$(sha "$T/fd/main/index.ts")" "$UPSTREAM_SHA"

# missing patch file
fresh; set +e; FUNCTIONS_DIR="$T/fd" PATCH_FILE="$T/nope.patch" "$SCRIPT" apply >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "apply without the patch file fails" || nok "apply without patch succeeded"
check "... and left the router upstream" "$(sha "$T/fd/main/index.ts")" "$UPSTREAM_SHA"

# --- Part B: runtime ---------------------------------------------------------------
if [ "${SKIP_RUNTIME:-0}" = 1 ] || ! docker info >/dev/null 2>&1; then
  echo "== Part B skipped (SKIP_RUNTIME=1 or no Docker)"
else
  echo "== Part B: patched router in $IMAGE, VERIFY_JWT=true"
  R="$T/rt"; mkdir -p "$R/main"
  cp "$T/upstream/index.ts" "$R/main/index.ts"
  gh_raw deno.jsonc "$R/deno.jsonc"
  check "deno.jsonc sha (pinned upstream)" "$(sha "$R/deno.jsonc")" "$DENO_JSONC_SHA"
  FUNCTIONS_DIR="$R" PATCH_FILE="$PATCH" "$SCRIPT" apply >/dev/null
  check "runtime router is the patched file" "$(sha "$R/main/index.ts")" "$PATCHED_SHA"

  # throwaway secrets for this container only (never real keys)
  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  JWT_SECRET="$(openssl rand -hex 32)"
  mkjwt() {
    local h p s
    h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
    p=$(printf '{"role":"%s","iss":"supabase","exp":%s}' "$1" "$(( $(date +%s) + 3600 ))" | b64url)
    s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -mac HMAC -macopt "key:$JWT_SECRET" -binary | b64url)
    printf '%s.%s.%s' "$h" "$p" "$s"
  }
  SUPABASE_ANON_KEY="$(mkjwt anon)"; SUPABASE_SERVICE_ROLE_KEY="$(mkjwt service_role)"
  export JWT_SECRET SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY
  export SUPABASE_URL=http://127.0.0.1:9 SUPABASE_JWKS='{"keys":[]}'

  mounts=(); names=""
  for d in "$REPO"/supabase/functions/*/; do
    n="$(basename "$d")"; mounts+=(-v "$d:/home/deno/functions/$n:ro"); names="$names $n"
    mkdir -p "$R/$n"   # so verify enumerates the same set as on the server
  done
  CONTAINER="spl-router-test-$$"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -p 127.0.0.1::9000 \
    -v "$R/main:/home/deno/functions/main:ro" -v "$R/deno.jsonc:/home/deno/functions/deno.jsonc:ro" \
    "${mounts[@]}" \
    -e JWT_SECRET -e SUPABASE_JWKS -e SUPABASE_URL -e SUPABASE_ANON_KEY -e SUPABASE_SERVICE_ROLE_KEY \
    -e VERIFY_JWT=true "$IMAGE" start --main-service /home/deno/functions/main >/dev/null
  PORT=$(docker port "$CONTAINER" 9000/tcp | head -1 | sed 's/.*://')
  BASE="http://127.0.0.1:$PORT"
  wait_for() {  # URL WANT_CODE [curl args]
    local u="$1" want="$2" i=0 c; shift 2
    while [ $i -lt 180 ]; do
      c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" "$u" || true)
      [ "$c" = "$want" ] && return 0
      sleep 1; i=$((i+1))
    done
    echo "timeout waiting for $u -> $want (last $c)"; docker logs "$CONTAINER" 2>&1 | tail -20; return 1
  }
  wait_for "$BASE/phone-upload-page" 200
  # phone-upload-token boots npm:@supabase/supabase-js on first use: warm it with a valid JWT
  wait_for "$BASE/phone-upload-token" 404 -X POST -H 'content-type: application/json' --data '{"token":"short"}' \
    -K <(printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ANON_KEY")

  echo "-- functions-router.sh verify (FUNCTIONS_DIR enumerates:$names)"
  set +e
  FUNCTIONS_DIR="$R" FUNCTIONS_URL="$BASE" "$SCRIPT" verify | tee "$T/verify.out"
  rc=${PIPESTATUS[0]}
  set -e
  check "verify against the local patched router exits 0" "$rc" 0
  for n in $names; do
    [ "$n" = phone-upload-page ] && continue
    grep -q "^PASS  GET  /$n (no auth)" "$T/verify.out" && grep -q "^PASS  POST /$n (no auth)" "$T/verify.out" \
      && ok "verify covered $n (GET+POST 401)" || nok "verify did not cover $n"
  done

  echo "-- extra path tricks (router sees the raw path; 401 = JWT gate, no function ran)"
  trick() {  # PATH WANT
    local c e
    c=$(curl -sS --path-as-is -o /dev/null -D "$T/h" -w '%{http_code}' "$BASE$1")
    e=$(grep -i '^sb-error-code:' "$T/h" | tr -d '\r' | cut -d' ' -f2 || true)
    check "GET $1 -> $2${e:+ ($e)}" "$c" "$2"
  }
  trick "/phone-upload-page/" 200
  trick "/phone-upload-page?next=/staff-admin" 200
  trick "/phone-upload-page/../staff-admin" 401
  trick "/phone-upload-page/..%2Fstaff-admin" 401
  trick "/phone-upload-page%2F..%2Fstaff-admin" 401
  trick "/phone-upload-page%2f..%2fstaff-admin" 401
  trick "/phone-upload-page%252F..%252Fstaff-admin" 401
  trick "/PHONE-UPLOAD-PAGE" 401
  trick "/Phone-Upload-Page" 401
  trick "//phone-upload-page" 401
  trick "/phone-upload-page//" 401
  trick "/phone-upload-page/staff-admin" 401
  trick "/./phone-upload-page" 200
  trick "/staff-admin?x=/phone-upload-page" 401
  trick "/staff-admin#/phone-upload-page" 401
  trick "/phone-upload-page%00" 401
  c=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/phone-upload-page?x=1")
  check "POST /phone-upload-page?x=1 -> 401" "$c" 401
  c=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$BASE/phone-upload-page")
  check "PUT /phone-upload-page -> 401" "$c" 401

  echo "-- controls"
  c=$(curl -sS -o /dev/null -D "$T/h" -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' \
      -K <(printf 'header = "Authorization: Bearer %s"\n' "$SUPABASE_ANON_KEY") "$BASE/staff-admin")
  if [ "$c" != 401 ] || ! grep -qi '^sb-error-code:' "$T/h"; then ok "valid dummy JWT passes the gate to staff-admin (function's own answer $c, no sb-error-code)"
  else nok "valid JWT still blocked by the gate"; fi
  c=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer not-a-jwt' "$BASE/staff-admin")
  check "garbage bearer -> 401" "$c" 401

  FUNCTIONS_DIR="$R" "$SCRIPT" revert >/dev/null
  docker restart "$CONTAINER" >/dev/null
  PORT=$(docker port "$CONTAINER" 9000/tcp | head -1 | sed 's/.*://'); BASE="http://127.0.0.1:$PORT"   # new port after restart
  wait_for "$BASE/phone-upload-page" 401 && ok "unpatched upstream router: page GET -> 401 (the patch is what opens it)" \
    || nok "unpatched router did not gate the page"
fi

echo
echo "functions-router tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
