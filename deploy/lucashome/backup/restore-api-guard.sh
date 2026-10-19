#!/usr/bin/env bash
# restore-api-guard.sh — keep every API entry point CLOSED while a database is restored, validated and
# the tills are reconciled (README §A/§B/§B2, restore-from-email.md). Run on lucashome with sudo.
#   restore-api-guard.sh close      Tailscale Serve/Funnel reset; every stack service except the
#                                   database stopped (api-gw first); then `verify`
#   restore-api-guard.sh verify     exit 0 ONLY when closure is confirmed, else 1 (fail closed):
#                                   - no stack service but the database is running
#                                   - nothing answers on the gateway (127.0.0.1:8000) or Studio (54323)
#                                   - no container publishes those ports; no stack container publishes any
#                                   - Tailscale has no serve/funnel config (tailscale missing = FAIL)
#                                   - no foreign container is attached to the stack's networks
#                                   - no enabled boot unit (supabase-stack.service) would `compose up` it
#   restore-api-guard.sh start-db   start ONLY the database: `docker compose up -d --no-deps db`
#                                   (no dependency can start api-gw), wait healthy, then `verify`
# There is NO reopen command: reopening is a separate, manual, owner-authorised step (README §R),
# never a consequence of a passing gate. Nothing here starts api-gw, Studio or Tailscale Serve.
# Test seams (local disposable stacks only): GUARD_STACK_DIR, GUARD_API_PORT, GUARD_STUDIO_PORT,
# GUARD_DB_SERVICE, TAILSCALE (command), GUARD_BOOT_UNIT.
set -uo pipefail
STACK="${GUARD_STACK_DIR:-/srv/supabase/stack}"
API_PORT="${GUARD_API_PORT:-8000}"; STUDIO_PORT="${GUARD_STUDIO_PORT:-54323}"
DBSVC="${GUARD_DB_SERVICE:-db}"; TS="${TAILSCALE:-tailscale}"; BOOT_UNIT="${GUARD_BOOT_UNIT:-supabase-stack.service}"
MODE="${1:-}"
FAILS=0
ok()  { echo "PASS  $*"; }
bad() { FAILS=$((FAILS+1)); echo "FAIL  $*"; }
dc()  { (cd "$STACK" && docker compose "$@"); }

verify() {
  echo "== API closure ($STACK)"
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then bad "docker unavailable: closure cannot be confirmed"; return; fi
  local svcs running ids id nets n others ports p rc ts
  if ! svcs=$(dc config --services 2>/dev/null) || [ -z "$svcs" ]; then bad "compose project in $STACK unreadable: closure cannot be confirmed"; return; fi
  # restarting/paused count as running: a crash-looping gateway serves the moment it comes up
  running=$(dc ps --status running --status restarting --status paused --services 2>/dev/null | sort -u); rc=$?
  if [ $rc -ne 0 ]; then bad "compose ps failed"; else
    others=$(printf '%s\n' "$running" | grep -vxF "$DBSVC" | grep . | tr '\n' ' ')
    if [ -n "$others" ]; then bad "stack services running besides $DBSVC: $others"; else ok "only '$DBSVC' may run; running: ${running:-none}"; fi
  fi
  for p in "$API_PORT" "$STUDIO_PORT"; do
    curl -sS -m 3 --noproxy '*' -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null; rc=$?
    if [ $rc -eq 7 ]; then ok "127.0.0.1:$p refuses connections"
    else bad "127.0.0.1:$p is not refused (curl rc $rc): something still listens or the probe could not tell"; fi
  done
  ports=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null) || { bad "docker ps failed"; ports=""; }
  p=$(printf '%s\n' "$ports" | grep -E ":($API_PORT|$STUDIO_PORT)->" || true)
  if [ -n "$p" ]; then bad "a container publishes the gateway/Studio port: $(echo $p)"; else ok "no container publishes $API_PORT or $STUDIO_PORT"; fi
  ids=$(dc ps -q 2>/dev/null)
  for id in $ids; do
    [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = true ] || continue
    p=$(docker port "$id" 2>/dev/null)
    [ -z "$p" ] || bad "stack container $(docker inspect -f '{{.Name}}' "$id") publishes ports: $(echo $p)"
  done
  nets=$(for id in $ids; do docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$id" 2>/dev/null; done | tr ' ' '\n' | grep . | sort -u)
  n=0
  for net in $nets; do
    for c in $(docker network inspect -f '{{range $k, $v := .Containers}}{{$k}} {{end}}' "$net" 2>/dev/null); do
      printf '%s\n' "$ids" | grep -q "^${c:0:12}" || { bad "foreign container ${c:0:12} attached to the stack network $net"; n=$((n+1)); }
    done
  done
  [ "$n" -eq 0 ] && ok "no foreign container on the stack network(s)${nets:+: $(echo $nets)}"
  if ! command -v "${TS%% *}" >/dev/null 2>&1; then bad "tailscale CLI not found: Serve exposure cannot be confirmed disabled"
  else
    ts=$($TS serve status --json 2>/dev/null); rc=$?
    if [ $rc -ne 0 ] || ! printf '%s' "$ts" | jq -e 'type == "object" or type == "null"' >/dev/null 2>&1; then bad "tailscale serve status unreadable (rc $rc): exposure cannot be confirmed"
    # empty = null or an object whose every member is empty (TCP, Web, AllowFunnel, Services, Foreground, any future key)
    elif printf '%s' "$ts" | jq -e '(. // {}) | to_entries | map(select(.value != null and .value != {} and .value != [] and .value != false and .value != "")) | length == 0' >/dev/null 2>&1
    then ok "tailscale: no serve or funnel configuration"
    else bad "tailscale still serves something: $(printf '%s' "$ts" | jq -c '{TCP, Web: ((.Web // {}) | keys), AllowFunnel}' 2>/dev/null | cut -c1-200)"; fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    case "$(systemctl is-enabled "$BOOT_UNIT" 2>/dev/null)" in
      enabled|enabled-runtime|static|alias|indirect|generated) bad "$BOOT_UNIT is enabled: a reboot would 'compose up' the API — sudo systemctl disable $BOOT_UNIT for the restore";;
      *) ok "no enabled boot unit ($BOOT_UNIT) restarts the stack";;
    esac
  else ok "no systemd here: no boot unit can restart the stack"; fi
}
finish() {
  echo "---"
  if [ "$FAILS" -gt 0 ]; then echo "API CLOSURE NOT CONFIRMED ($FAILS problem(s)) — do NOT restore or restart PostgreSQL; fix the above and run verify again"; exit 1; fi
  echo "API CLOSED (confirmed). It stays closed until the owner-authorised reopening (README §R)."; exit 0
}

case "$MODE" in
close)
  echo "== closing every API entry point"
  if command -v "${TS%% *}" >/dev/null 2>&1; then $TS serve reset && echo "tailscale serve reset" || echo "tailscale serve reset FAILED (verify will report it)"
  else echo "tailscale CLI not found (verify will fail)"; fi
  svcs=$(dc config --services 2>/dev/null)
  if [ -n "$svcs" ]; then
    # the gateway and Studio first (the entry points), then everything that is not the database
    for s in api-gw studio; do printf '%s\n' "$svcs" | grep -qxF "$s" && dc stop "$s"; done
    rest=$(printf '%s\n' "$svcs" | grep -vxF "$DBSVC" | grep -vxE 'api-gw|studio' | tr '\n' ' ')
    [ -n "${rest// }" ] && dc stop $rest
  fi
  verify; finish ;;
verify) verify; finish ;;
start-db)
  # --no-deps: nothing that depends_on db is started, and nothing db depends on — api-gw can never
  # come up as a dependency (functions -> api-gw, api-gw -> studio)
  dc up -d --no-deps "$DBSVC" || { echo "FAIL  could not start $DBSVC"; exit 1; }
  for _ in $(seq 1 90); do
    h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$(dc ps -q "$DBSVC")" 2>/dev/null)
    [ "$h" = healthy ] || [ "$h" = running ] && break; sleep 2
  done
  echo "database: ${h:-unknown}"
  verify; finish ;;
*) sed -n '2,20p' "$0"; exit 2 ;;
esac
