#!/usr/bin/env bash
# Step 6: a DISPOSABLE Orvix Control (its own Postgres 17 + `next start`) for the POS <-> Control integration run.
# Separate container, separate database cluster (fresh initdb, never orvix-control-db / orvix-control-pgdata): Control's
# database listens on the container's loopback only; the web server is published on 127.0.0.1:3410 (the passkey origin
# http://localhost:3410). The container joins the POS stack's network (phf-iso-net) so that Control's database can reach
# the POS database (phf-iso-db:5432) through the network bridge of Control migration 223 — and nothing else is shared.
#
# Needs: ORVIX_CONTROL_WT (the Control worktree, with its generated .env.local/.env.host/.env.sentinel/.env.pgpw and
# .env.prep.sh), the runner image orvix-script2-runner:local (postgres:17 + node 24 + docker shim) and a Linux node_modules
# volume ORVIX_CONTROL_NM (default orvix-step6-nm).
#   control-stack.sh up OUT_DIR | bridge BRIDGE_ENV | owner EMAIL NAME | start | stop | partition | heal | sql "SQL" | down
set -euo pipefail
umask 077
C=orvix-step6-ctl-integ
WT=${ORVIX_CONTROL_WT:?ORVIX_CONTROL_WT is required}; NM=${ORVIX_CONTROL_NM:-orvix-step6-nm}
case "$NM" in orvix-step6-*) ;; *) echo "REFUSE: node_modules volume must be named orvix-step6-* (never another Docker volume)"; exit 3;; esac
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
[ -f "$WT/db/migrations/223_pos_recovery_network_bridge.sql" ] || { echo "not a Step 6 Control worktree: $WT"; exit 2; }
health() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:3410/api/healthz 2>/dev/null || true; }
cmd=$1; shift
case "$cmd" in
  up)
    OUT=$(mkdir -p "$1/ctl" && cd "$1/ctl" && pwd)
    docker rm -f "$C" >/dev/null 2>&1 || true
    docker network inspect phf-iso-net >/dev/null 2>&1 || { echo "POS stack network phf-iso-net missing"; exit 1; }
    docker run -d --name "$C" --init --memory 3g -p 127.0.0.1:3410:3410 --label orvix.step6-disposable=1 \
      -v "$WT":/work -v "$NM":/work/node_modules -v "$OUT":/run/step6 \
      -e POSTGRES_DB=orvix_control -e POSTGRES_USER=orvix_control_super -e POSTGRES_PASSWORD_FILE=/work/.env.pgpw \
      -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
      orvix-script2-runner:local '. ./.env.prep.sh > /run/step6/prep.log 2>&1; npx next build > /run/step6/build.log 2>&1; echo $? > /run/step6/build.exit; exec sleep infinity' >/dev/null
    docker network connect phf-iso-net "$C"
    for i in $(seq 1 600); do [ -f "$OUT/build.exit" ] && break; sleep 1; done
    [ "$(cat "$OUT/build.exit" 2>/dev/null)" = 0 ] || { echo "control build failed"; tail -20 "$OUT/build.log" "$OUT/prep.log"; exit 1; }
    echo "control up: $(grep -c '^applied' "$OUT/prep.log" 2>/dev/null || true) migrations noted; $(docker exec "$C" psql -X -U orvix_control_super -d orvix_control -At -c "select control.api_contract_version()")";;
  bridge)
    # the POS login's settings are copied in for the configure step only, then removed
    install -m 600 "$1" "$WT/.env.posbridge"
    trap 'rm -f "$WT/.env.posbridge"' EXIT
    docker exec "$C" npx tsx scripts/pos-bridge.ts --configure
    docker exec "$C" npx tsx scripts/pos-bridge.ts --status;;
  owner)
    docker exec "$C" npx tsx scripts/bootstrap-owner.ts --email "$1" --name "$2" | sed -n 's#.*/enroll/\([0-9a-f]\{64\}\).*#\1#p';;
  start)
    docker exec -d "$C" bash -c 'cd /work && echo $$ > /run/step6/next.pid && exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3410 >> /run/step6/next.log 2>&1'
    for i in $(seq 1 120); do [ "$(health)" = 200 ] && { echo "control web up"; exit 0; }; sleep 1; done
    echo "control web did not come up"; exit 1;;
  stop)
    docker exec "$C" bash -c 'kill "$(cat /run/step6/next.pid)"' || true
    for i in $(seq 1 30); do [ "$(health)" = 200 ] || { echo "control web stopped"; exit 0; }; sleep 1; done
    echo "control web still up"; exit 1;;
  partition) docker network disconnect phf-iso-net "$C"; echo "control cut off from the POS network";;
  heal) docker network connect phf-iso-net "$C"; echo "control reconnected to the POS network";;
  notices)   # an out-of-band file channel the real sentinel accepts (regular single-link file, root-owned 0700 directory)
    docker exec "$C" bash -c 'install -d -m 700 /var/lib/orvix-notices && install -m 600 /dev/null /var/lib/orvix-notices/notices.log'
    docker exec -i "$C" psql -X -U orvix_control_super -d orvix_control -v ON_ERROR_STOP=1 -At \
      -c "SELECT control.host_add_notify_channel('host', NULL, 'file', '/var/lib/orvix-notices/notices.log', NULL)";;
  notices-log) docker exec "$C" cat /var/lib/orvix-notices/notices.log;;
  deliver) docker exec "$C" npx tsx scripts/sentinel.ts --once;;   # the real sentinel: one out-of-band delivery pass
  sql) docker exec -i "$C" psql -X -U orvix_control_super -d orvix_control -v ON_ERROR_STOP=1 -At -c "$1";;
  down) docker rm -f "$C" >/dev/null 2>&1 || true; rm -f "$WT/.env.posbridge"; echo "control down";;
  *) echo "usage: $0 up OUT|bridge ENV|owner EMAIL NAME|start|stop|partition|heal|sql SQL|down"; exit 2;;
esac
