#!/usr/bin/env bash
# studio-isolation.sh — controlled, reversible Studio isolation on the server
# (docs/selfhost-migration/phase-f/studio-isolation.md §7). PREPARED, NOT APPLIED.
#
# Copy this directory to the server (scp -r deploy/lucashome/studio-isolation lucashome:~/),
# then in ~/studio-isolation:
#
#   ./studio-isolation.sh status                 read-only: file states, Studio port, live probe of /
#   ./studio-isolation.sh stage                  writes the edited copies to $STAGE (no stack change)
#   ./studio-isolation.sh validate               envoy --mode validate on the staged template, then a
#                                                TEMPORARY test gateway (container phf-gw-test on
#                                                127.0.0.1:$TEST_PORT, real upstream services) + verify
#                                                --gateway-only against it; removed afterwards
#   ./studio-isolation.sh verify [--base URL] [--gateway-only] [--image-path P]
#                                                read-only HTTP checks (default base: the live gateway)
#   ./studio-isolation.sh apply --yes            backup, install staged files, recreate studio + api-gw, verify
#   ./studio-isolation.sh revert --yes           restore the upstream routes + remove the loopback port, recreate
#
# Edits are made by studio_isolation.py (pinned upstream route block; composes with the
# G5 header rule and the rate-limit rule in any order; idempotent). Prints status codes,
# header names, states and sha prefixes; never keys, file contents or object names.
#
# Environment: STACK_DIR (/srv/supabase/stack), STAGE (~/studio-isolation/stage),
#   TEST_PORT (18001), GW (http://127.0.0.1:8000), SI_ENV_FILE ($STACK_DIR/.env; only
#   SERVICE_ROLE_KEY is read, by exact name, for the signed-URL check), SI_NO_DOCKER (tests).
set -euo pipefail
umask 022
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/studio_isolation.py"
STACK_DIR="${STACK_DIR:-/srv/supabase/stack}"
STAGE="${STAGE:-$HOME/studio-isolation/stage}"
TEST_PORT="${TEST_PORT:-18001}"
GW="${GW:-http://127.0.0.1:8000}"
SI_ENV_FILE="${SI_ENV_FILE:-$STACK_DIR/.env}"
LDS="$STACK_DIR/volumes/api/envoy/lds.template.yaml"
OVR="$STACK_DIR/docker-compose.override.yml"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

die() { echo "studio-isolation: $*" >&2; exit 1; }
tool() { python3 -I "$TOOL" "$@"; }
compose() { (cd "$STACK_DIR" && docker compose "$@"); }

PASS=0; FAIL=0
ok() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'PASS  %-66s %s\n' "$1" "$2"; else FAIL=$((FAIL+1)); printf 'FAIL  %-66s got [%s] want [%s]\n' "$1" "$2" "$3"; fi; }
H="$(mktemp)"; B="$(mktemp)"; trap 'rm -f "$H" "$B"' EXIT
req() { curl -s -m 10 -o "$B" -D "$H" -w '%{http_code}' "$@" || true; }
hdr() { { grep -i "^$1:" "$H" || true; } | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
challenge() { grep -ci '^www-authenticate:' "$H" || true; }

verify() {
  local base="$GW" gwonly=0 img=""
  while (($#)); do case "$1" in
    --base) base="$2"; shift 2;; --gateway-only) gwonly=1; shift;; --image-path) img="$2"; shift 2;;
    *) die "verify: unknown option $1";; esac; done
  echo "== Studio paths on the shared origin ($base): 404, no basic-auth challenge"
  for p in / /project/default /project/default/editor /api/platform/profile /api/platform/pg-meta/default/query \
           /api/mcp /mcp /pg/ /pg/tables /favicon.ico /_next/static/x.js /nonexistent; do
    ok "GET $p" "$(req "$base$p")|$(challenge)" "404|0"
  done
  ok "POST /api/platform/pg-meta/default/query" "$(req -X POST -H 'content-type: application/json' -d '{"query":"select 1"}' "$base/api/platform/pg-meta/default/query")" "404"
  ok "dot-dot from /rest/v1/ to Studio" "$(req --path-as-is "$base/rest/v1/../project/default")" "404"

  echo "== API routes unchanged (no credentials)"
  ok "/auth/v1/health without key -> 401, no challenge" "$(req "$base/auth/v1/health")|$(challenge)" "401|0"
  ok "/rest/v1/ without key -> 401" "$(req "$base/rest/v1/")" "401"
  ok "/storage/v1/version -> 200" "$(req "$base/storage/v1/version")" "200"
  ok "/functions/v1/phone-upload-page -> 200 (phone page)" "$(req "$base/functions/v1/phone-upload-page")" "200"
  ok "/functions/v1/phone-upload-token GET -> not 404 (routed to functions)" "$( [ "$(req "$base/functions/v1/phone-upload-token")" != 404 ] && echo routed || echo 404)" "routed"

  echo "== public image + headers"
  if [ -z "$img" ] && [ -z "${SI_NO_DOCKER:-}" ]; then
    img="$(compose exec -T db psql -X -q -At -U supabase_admin -d postgres -c \
      "SELECT substring(image_url from '/storage/v1/object/public/(product-images/[^?#]+)$') FROM products
        WHERE image_url ~ '/storage/v1/object/public/product-images/[^?#]+$' ORDER BY id LIMIT 1" 2>/dev/null || true)"
  fi
  if [ -n "$img" ]; then
    ok "public product image -> 200" "$(req "$base/storage/v1/object/public/$img")" "200"
    ok "public product image content-type image/*" "$(hdr content-type | cut -d/ -f1)" "image"
    if grep -q 'name: storage-v1-object-public' "${SI_LDS_FOR_HEADERS:-$LDS}" 2>/dev/null; then
      ok "G5 header rule intact: nosniff" "$(hdr x-content-type-options)" "nosniff"
      ok "G5 header rule intact: CSP sandbox present" "$(hdr content-security-policy | grep -c sandbox || true)" "1"
    fi
  else
    echo "SKIP  no public product image found (path never printed)"
  fi

  echo "== signed URL (service key read by exact name, never printed)"
  if [ -n "$img" ] && [ -r "$SI_ENV_FILE" ]; then
    local srv signed
    srv="$(grep -E '^SERVICE_ROLE_KEY=' "$SI_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
    if [ -n "$srv" ]; then
      signed="$(printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$srv" "$srv" \
        | curl -s -m 10 -K - -X POST -H 'content-type: application/json' -d '{"expiresIn":60}' \
            "$base/storage/v1/object/sign/$img" | python3 -I -c 'import json,sys
try: print(json.load(sys.stdin).get("signedURL", ""))
except Exception: print("")')"
      unset srv
      ok "signed URL issued" "$([ -n "$signed" ] && echo yes || echo no)" "yes"
      [ -n "$signed" ] && ok "signed URL download -> 200" "$(req "$base/storage/v1$signed")" "200"
    else echo "SKIP  SERVICE_ROLE_KEY not found"; fi
  else
    echo "SKIP  no image or env file"
  fi

  if [ "$gwonly" = 0 ] && [ -z "${SI_NO_DOCKER:-}" ]; then
    echo "== Studio only on the server loopback"
    ok "docker port supabase-studio" "$(docker port supabase-studio 3000/tcp 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "127.0.0.1:54323"
    ok "listener 54323 bound to loopback only" "$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':54323$' | sort -u | tr '\n' ' ' | sed 's/ $//')" "127.0.0.1:54323"
    ok "Studio answers on 127.0.0.1:54323" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:54323/api/platform/profile || true)" "200"
  fi
  echo; echo "verify: $PASS passed, $FAIL failed"
  [ "$FAIL" = 0 ]
}

case "${1:-}" in
  status)
    tool status "$LDS" "$OVR" || true
    echo "studio port: $(docker port supabase-studio 3000/tcp 2>/dev/null | tr '\n' ' ' || true)"
    echo "live probe $GW/: $(req "$GW/")|challenge=$(challenge)   (upstream: 401|1, isolated: 404|0)"
    ls -1 "$STACK_DIR"/volumes/api/envoy/lds.template.yaml.pre-studio-isolation.* "$OVR".pre-studio-isolation.* 2>/dev/null | sed 's/^/backup: /' || true
    ;;
  stage)
    mkdir -p "$STAGE"
    tool apply "$LDS" "$STAGE/lds.template.yaml" "$OVR" "$STAGE/docker-compose.override.yml"
    tool status "$STAGE/lds.template.yaml" "$STAGE/docker-compose.override.yml"
    sha256sum "$LDS" "$STAGE/lds.template.yaml" "$OVR" "$STAGE/docker-compose.override.yml" | sed -E 's/^(.{8})[0-9a-f]+/\1…/'
    ;;
  validate)
    [ -f "$STAGE/lds.template.yaml" ] || die "run stage first"
    ss -ltnH | awk '{print $4}' | grep -qE ":$TEST_PORT\$" && die "port $TEST_PORT is in use"
    docker ps -a --format '{{.Names}}' | grep -qx phf-gw-test && die "container phf-gw-test exists (another test running?)"
    echo "== envoy --mode validate (staged template)"
    compose run --rm --no-deps -v "$STAGE/lds.template.yaml:/etc/envoy/lds.template.yaml:ro" api-gw --mode validate 2>&1 | tail -3
    echo "== staged override: docker compose config"
    (cd "$STACK_DIR" && docker compose -f docker-compose.yml -f "$STAGE/docker-compose.override.yml" config --format json 2>/dev/null) \
      | python3 -I -c 'import json,sys; s=json.load(sys.stdin)["services"]["studio"].get("ports",[]); print("studio ports:", [(p.get("host_ip"),p.get("published"),p.get("target")) for p in s])'
    echo "== temporary test gateway phf-gw-test on 127.0.0.1:$TEST_PORT"
    compose run --rm --no-deps -d --name phf-gw-test -p "127.0.0.1:$TEST_PORT:8000" \
      -v "$STAGE/lds.template.yaml:/etc/envoy/lds.template.yaml:ro" api-gw >/dev/null
    trap 'docker rm -f phf-gw-test >/dev/null 2>&1 || true; rm -f "$H" "$B"' EXIT
    for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$TEST_PORT/storage/v1/version" || true)" = 200 ] && break; sleep 1; done
    rc=0; SI_LDS_FOR_HEADERS="$STAGE/lds.template.yaml" verify --base "http://127.0.0.1:$TEST_PORT" --gateway-only || rc=$?
    docker rm -f phf-gw-test >/dev/null 2>&1 || true
    echo "test gateway removed"; exit "$rc"
    ;;
  verify) shift; verify "$@";;
  apply)
    [ "${2:-}" = --yes ] || die "apply changes the server: owner approval, outside shop hours, then: apply --yes"
    tool status "$LDS" "$OVR"
    mkdir -p "$STAGE"
    tool apply "$LDS" "$STAGE/lds.check.yaml" "$OVR" "$STAGE/override.check.yml" >/dev/null
    cmp -s "$STAGE/lds.check.yaml" "$STAGE/lds.template.yaml" && cmp -s "$STAGE/override.check.yml" "$STAGE/docker-compose.override.yml" \
      || die "staged files are stale (live files changed since stage/validate) - run stage + validate again"
    cp -p "$LDS" "$LDS.pre-studio-isolation.$TS"; cp -p "$OVR" "$OVR.pre-studio-isolation.$TS"
    cat "$STAGE/lds.template.yaml" >"$LDS.new" && mv "$LDS.new" "$LDS"
    cat "$STAGE/docker-compose.override.yml" >"$OVR.new" && mv "$OVR.new" "$OVR"
    compose config --quiet
    compose up -d studio
    compose up -d --force-recreate api-gw     # single-file bind mount: a new inode needs a recreate
    for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$GW/storage/v1/version" || true)" = 200 ] && break; sleep 1; done
    tool status "$LDS" "$OVR"
    verify
    ;;
  revert)
    [ "${2:-}" = --yes ] || die "revert changes the server: revert --yes"
    cp -p "$LDS" "$LDS.pre-studio-revert.$TS"; cp -p "$OVR" "$OVR.pre-studio-revert.$TS"
    tool revert "$LDS" "$LDS.new" "$OVR" "$OVR.new"
    mv "$LDS.new" "$LDS"; mv "$OVR.new" "$OVR"
    compose config --quiet
    compose up -d studio
    compose up -d --force-recreate api-gw
    for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$GW/storage/v1/version" || true)" = 200 ] && break; sleep 1; done
    tool status "$LDS" "$OVR"
    ok "after revert: / -> 401 + Basic (Studio behind basic auth again)" "$(req "$GW/")|$(hdr www-authenticate | cut -d' ' -f1)" "401|Basic"
    [ "$FAIL" = 0 ]
    ;;
  *) sed -n '2,24p' "$0"; exit 2;;
esac
