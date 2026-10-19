#!/usr/bin/env bash
# api-isolation-test.sh — restore-api-guard.sh against a DISPOSABLE local compose project that models the
# lucashome stack's service names, depends_on graph (host-reboot-hardening.md D4) and loopback port
# publishing, with a fake `tailscale` (state file) and a fake `systemctl`. Local Docker only; local images
# only (alpine, node:22-alpine, postgres:16-alpine; pull_policy never); no network access, no lucashome.
#   1 reproduces the old runbook commands (README §B step 1, §A step 6) leaving / bringing the API up
#   2 close + verify; PostgreSQL stopped, started (--no-deps) and restarted while the API stays closed
#   3 compose dependency startup: --no-deps never starts api-gw; plain `up` of functions does
#   4 fail-closed: every unconfirmable or open state makes verify exit 1
#   5 a gate run (any verdict) leaves the API closed; nothing in the backup scripts reopens it
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BK="$(cd "$HERE/../.." && pwd)"
GUARD="$BK/restore-api-guard.sh"
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker socket only"; exit 3;; esac
P=phf-guard-test
T=$(mktemp -d "${TMPDIR:-/tmp}/phf-guard.XXXXXX")
API_PORT=$((18700 + RANDOM % 200)); STUDIO_PORT=$((API_PORT + 300))
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
say() { echo; echo "== $*"; }
cleanup() {
  (cd "$T/stack" 2>/dev/null && docker compose down -v --remove-orphans >/dev/null 2>&1)
  docker rm -f phf-guard-foreign phf-guard-squatter >/dev/null 2>&1
  case "$T" in /tmp/*|/private/tmp/*|/var/folders/*) rm -rf "$T";; esac
}
trap cleanup EXIT

mkdir -p "$T/stack" "$T/bin"
NODE_SRV='["node","-e","require(\"http\").createServer((q,r)=>r.end(\"up\")).listen(Number(process.argv[1]))"'
cat >"$T/stack/docker-compose.yml" <<EOF
name: $P
x-sleeper: &sleeper
  image: alpine:latest
  pull_policy: never
  command: ["sleep", "infinity"]
  restart: unless-stopped
  init: true
services:
  db:
    image: postgres:16-alpine
    pull_policy: never
    environment: { POSTGRES_PASSWORD: drill-only-not-a-secret }
    healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres"], interval: 1s, timeout: 3s, retries: 60 }
    restart: unless-stopped
  studio:
    image: node:22-alpine
    pull_policy: never
    command: $NODE_SRV, "3000"]
    ports: ["127.0.0.1:$STUDIO_PORT:3000/tcp"]
    healthcheck: { test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/"], interval: 1s, timeout: 3s, retries: 60 }
    restart: unless-stopped
  api-gw:
    image: node:22-alpine
    pull_policy: never
    command: $NODE_SRV, "8000"]
    ports: ["127.0.0.1:$API_PORT:8000/tcp"]
    depends_on: { studio: { condition: service_healthy } }
    healthcheck: { test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8000/"], interval: 1s, timeout: 3s, retries: 60 }
    restart: unless-stopped
  auth:     { <<: *sleeper, depends_on: { db: { condition: service_healthy } } }
  rest:     { <<: *sleeper, depends_on: { db: { condition: service_healthy } } }
  meta:     { <<: *sleeper, depends_on: { db: { condition: service_healthy } } }
  realtime: { <<: *sleeper, depends_on: { db: { condition: service_healthy } } }
  imgproxy: { <<: *sleeper }
  storage:  { <<: *sleeper, depends_on: { db: { condition: service_healthy }, imgproxy: { condition: service_started }, rest: { condition: service_started } } }
  functions: { <<: *sleeper, depends_on: { api-gw: { condition: service_healthy } } }
  crashloop:
    image: alpine:latest
    pull_policy: never
    command: ["sh", "-c", "sleep 1; exit 1"]
    restart: always
    profiles: ["fault"]
EOF
cat >"$T/bin/tailscale" <<'EOF'
#!/usr/bin/env bash
# fake tailscale: serve state in $FAKE_TS_STATE
f=${FAKE_TS_STATE:?}
case "$1" in
  serve)
    case "${2:-}" in
      reset) if [ "${FAKE_TS_NULL:-0}" = 1 ]; then echo null >"$f"; else echo '{}' >"$f"; fi ;;
      status) [ "${FAKE_TS_BROKEN:-0}" = 1 ] && { echo "failed to connect to local tailscaled" >&2; exit 1; }
              [ "${FAKE_TS_GARBAGE:-0}" = 1 ] && { echo "No serve config"; exit 0; }
              cat "$f" 2>/dev/null || echo '{}' ;;
      fg) echo '{"Foreground":{"session-1":{"TCP":{"443":{"TCPForward":"127.0.0.1:5432"}}}}}' >"$f" ;;
      *) echo '{"TCP":{"443":{"HTTPS":true}},"Web":{"lucashome.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8000"}}}}}' >"$f" ;;
    esac ;;
  funnel) echo '{"TCP":{"443":{"HTTPS":true}},"AllowFunnel":{"lucashome.example.ts.net:443":true}}' >"$f" ;;
  *) exit 1 ;;
esac
EOF
cat >"$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
# fake systemctl: is-enabled answers $FAKE_UNIT_STATE (default: not-found)
[ "$1" = is-enabled ] && { echo "${FAKE_UNIT_STATE:-not-found}"; [ "${FAKE_UNIT_STATE:-}" = enabled ]; exit $?; }
exit 1
EOF
chmod 0755 "$T/bin/tailscale" "$T/bin/systemctl"
export PATH="$T/bin:$PATH" FAKE_TS_STATE="$T/ts.json" GUARD_STACK_DIR="$T/stack" GUARD_API_PORT=$API_PORT GUARD_STUDIO_PORT=$STUDIO_PORT
dc() { (cd "$T/stack" && docker compose "$@"); }
running() { dc ps --status running --services 2>/dev/null | sort | tr '\n' ' '; }
is_running() { dc ps --status running --services 2>/dev/null | grep -qxF "$1"; }
answers() { curl -s -m 3 -o /dev/null "http://127.0.0.1:$1/"; }
guard() { "$GUARD" "$@" >"$T/guard.out" 2>&1; echo $?; }
expect_guard() {  # LABEL WANT_RC MODE [GREP]
  local rc; rc=$(guard "$3")
  if [ "$rc" = "$2" ] && { [ -z "${4:-}" ] || grep -qE -- "$4" "$T/guard.out"; }; then ok "$1 (verify rc $rc)"
  else bad "$1: want rc $2${4:+ + /$4/}, got $rc"; grep -E '^(FAIL|API)' "$T/guard.out" | head -6 | sed 's/^/      /'; fi
}
production_up() {  # the stack as it runs in production: everything up, the API served on the tailnet
  dc up -d --wait >/dev/null 2>&1 || { dc ps; echo "model stack failed"; exit 1; }
  tailscale serve --bg --https=443 "http://127.0.0.1:$API_PORT" >/dev/null
}

say "0 the model stack (production state)"
production_up
answers "$API_PORT" && ok "model: gateway answers on 127.0.0.1:$API_PORT; tailscale serves it; running: $(running)" || bad "model gateway"
expect_guard "verify on a running production stack: NOT confirmed" 1 verify 'stack services running besides db'

say "1 BEFORE: the old runbook commands (reproductions of the HIGH findings)"
# H1 — README §B step 1 (PITR) was only `docker compose stop db`
dc stop db >/dev/null 2>&1
if answers "$API_PORT" && is_running api-gw; then ok "REPRODUCED H1: after the old §B step 1 (stop db) the gateway still runs and answers — tills could write into the restore"
else bad "H1 not reproduced"; fi
dc up -d --wait db >/dev/null 2>&1
# H2 — README §A step 6: `docker compose up -d $(docker compose config --services | grep -vx api-gw)`
dc stop api-gw functions >/dev/null 2>&1
is_running api-gw && bad "setup: api-gw still running" || ok "setup: api-gw stopped by hand (old §A step 1)"
dc up -d $(dc config --services | grep -vx api-gw) >/dev/null 2>&1
if is_running api-gw && answers "$API_PORT"; then ok "REPRODUCED H2: the old §A step 6 (up -d every service but api-gw, no --no-deps) STARTS api-gw through functions -> api-gw"
else bad "H2 not reproduced (running: $(running))"; fi

say "2 AFTER: restore-api-guard.sh close / verify / start-db"
expect_guard "close: every entry point closed and confirmed" 0 close 'API CLOSED'
[ "$(running)" = "db " ] && ok "only the database runs after close" || bad "after close running: $(running)"
answers "$API_PORT" && bad "gateway still answers" || ok "gateway port refused"
answers "$STUDIO_PORT" && bad "Studio still answers" || ok "Studio port refused"
[ "$(jq -c . "$FAKE_TS_STATE")" = '{}' ] && ok "tailscale serve configuration reset" || bad "tailscale config: $(cat "$FAKE_TS_STATE")"
dc stop db >/dev/null 2>&1
expect_guard "PostgreSQL stopped for the restore (physical/PITR): still closed" 0 verify
expect_guard "start-db: PostgreSQL started with --no-deps, API still closed" 0 start-db 'API CLOSED'
is_running db && ! is_running api-gw && ok "database running, api-gw not running (start-db)" || bad "start-db running: $(running)"
dc restart db >/dev/null 2>&1; sleep 2
expect_guard "PostgreSQL restarted (restart db): API still closed" 0 verify
dc stop db >/dev/null 2>&1; dc up -d --no-deps --wait db >/dev/null 2>&1
expect_guard "PostgreSQL stop + up --no-deps db again: API still closed" 0 verify
answers "$API_PORT" && bad "gateway answers after the database restarts" || ok "gateway refused through every database restart"

say "3 compose dependency startup"
dc up -d --no-deps auth rest storage functions >/dev/null 2>&1
is_running api-gw && bad "--no-deps started api-gw" || ok "up -d --no-deps auth rest storage functions: api-gw NOT started"
expect_guard "support services running is not a confirmed closure (only db may run)" 1 verify 'besides db'
"$GUARD" close >/dev/null 2>&1
dc up -d functions >/dev/null 2>&1
is_running api-gw && ok "REPRODUCED: plain 'up -d functions' (no --no-deps) starts api-gw — the runbooks never do this before §R" || bad "functions dependency did not start api-gw"
expect_guard "api-gw back up via a dependency: verify catches it" 1 verify 'api-gw'
"$GUARD" close >/dev/null 2>&1

say "4 fail closed"
expect_guard "baseline: closed" 0 verify
tailscale serve --bg --https=443 "http://127.0.0.1:$API_PORT" >/dev/null
expect_guard "tailscale serve re-enabled: NOT confirmed" 1 verify 'tailscale still serves'
tailscale funnel 443 on >/dev/null
expect_guard "tailscale funnel enabled: NOT confirmed" 1 verify 'tailscale still serves'
tailscale serve reset
tailscale serve fg >/dev/null
expect_guard "a foreground tailscale serve session (not --bg): NOT confirmed" 1 verify 'tailscale still serves'
FAKE_TS_NULL=1 tailscale serve reset
expect_guard "tailscale status 'null' (no configuration on a fresh node): confirmed closed" 0 verify 'no serve or funnel'
tailscale serve reset
(cd "$T/stack" && docker compose --profile fault up -d --no-deps crashloop) >/dev/null 2>&1
# sample until Docker reports it between two crashes ("restarting"): the state `ps --status running` alone missed
st=""; for _ in $(seq 1 60); do st=$(docker inspect -f '{{.State.Status}}' "$(dc --profile fault ps -a -q crashloop)" 2>/dev/null); [ "$st" = restarting ] && break; sleep 0.25; done
[ "$st" = restarting ] && ok "model: a stack service caught in state 'restarting'" || bad "could not observe the crash loop as 'restarting' (last: $st)"
expect_guard "a crash-looping stack service (state now '$st'): NOT confirmed" 1 verify 'besides db'
(cd "$T/stack" && docker compose --profile fault stop crashloop && docker compose --profile fault rm -f crashloop) >/dev/null 2>&1
FAKE_TS_BROKEN=1 expect_guard "tailscale status unreadable: NOT confirmed" 1 verify 'unreadable'
FAKE_TS_GARBAGE=1 expect_guard "tailscale status not JSON: NOT confirmed" 1 verify 'unreadable'
TAILSCALE=/nonexistent/tailscale expect_guard "tailscale CLI missing: NOT confirmed" 1 verify 'tailscale CLI not found'
FAKE_UNIT_STATE=enabled expect_guard "boot unit that runs 'compose up' enabled: NOT confirmed" 1 verify 'supabase-stack.service is enabled'
dc start studio >/dev/null 2>&1
expect_guard "Studio running alone: NOT confirmed" 1 verify 'studio'
"$GUARD" close >/dev/null 2>&1
docker run -d --name phf-guard-squatter -p "127.0.0.1:$API_PORT:80" node:22-alpine node -e 'require("http").createServer((q,r)=>r.end("x")).listen(80)' >/dev/null
sleep 1
expect_guard "another container answering on the gateway port: NOT confirmed" 1 verify "publishes the gateway/Studio port|$API_PORT is not refused"
docker rm -f phf-guard-squatter >/dev/null 2>&1
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(dc ps -q db)")
docker run -d --name phf-guard-foreign --network "$NET" alpine:latest sleep 300 >/dev/null
expect_guard "a foreign container on the stack network: NOT confirmed" 1 verify 'foreign container'
docker rm -f phf-guard-foreign >/dev/null 2>&1
GUARD_STACK_DIR="$T/nope" expect_guard "stack directory unreadable: NOT confirmed" 1 verify 'unreadable'
DOCKER_HOST=unix:///nonexistent.sock expect_guard "docker unavailable: NOT confirmed" 1 verify 'docker unavailable'
expect_guard "back to closed" 0 verify

say "5 a gate run never reopens the API"
"$BK/dr-verify-restore.sh" restore --compose-dir "$T/stack" --expect-version 086 --migrations "$BK/../../../supabase/migrations" >"$T/gate.out" 2>&1; grc=$?
expect_guard "after a gate run (rc $grc, any verdict): still closed" 0 verify
answers "$API_PORT" && bad "gateway answers after the gate" || ok "gateway refused after the gate"
hits=$(grep -nE 'restore-api-guard\.sh +reopen|tailscale serve +--bg|tailscale funnel|compose[^#]*up[^#]*api-gw' "$BK"/*.sh 2>/dev/null | grep -v '^[^:]*:[0-9]*:[[:space:]]*#' || true)
[ -z "$hits" ] && ok "no backup/DR script reopens the API (no serve --bg, funnel, or up api-gw)" || { bad "a script reopens the API:"; echo "$hits" | head -5; }
grep -qE '^ *(reopen|open)\)' "$GUARD" && bad "the guard has a reopen command" || ok "the guard has no reopen command (reopening is the manual §R)"

echo; echo "api isolation: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
