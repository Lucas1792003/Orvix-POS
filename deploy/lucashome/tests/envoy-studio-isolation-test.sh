#!/usr/bin/env bash
# Local proof of deploy/lucashome/studio-isolation/lds-studio-isolation.patch
# on the production Envoy version, without touching any server.
#
# Uses the REAL upstream gateway files at the pinned commit (lds.template.yaml,
# envoy.yaml, cds.yaml, docker-entrypoint.sh), mounted and started exactly as
# upstream docker-compose.yml does (entrypoint renders the template with sed),
# with dummy keys and dummy dashboard credentials. Upstreams are stubs (node):
# one container answers for auth/rest/storage/functions/meta/realtime, one for
# studio; each echoes its name, port and the path it received.
#
# Three gateways run side by side:
#   control  - the unpatched upstream template (= production today, sha-pinned):
#              reproduces the live probe (/ and /project/default -> 401 Basic);
#   patched  - the template with the patch: Studio, /api/mcp, /mcp and /pg/ -> 404
#              with no basic-auth challenge, Studio never reached, API routes unchanged;
#   optional - patched + both optional prepared rules inserted as their docs say
#              (envoy-storage-public-headers.yaml, envoy-phone-upload-ratelimit.yaml):
#              route ordering still correct.
#
#   deploy/lucashome/tests/envoy-studio-isolation-test.sh
# Needs docker, curl, patch; images envoyproxy/envoy:v1.39.1 and node:24-slim.
# Upstream files are fetched from GitHub unless UPSTREAM_ENVOY_DIR points at a
# directory holding the four files. Containers/network are named
# phf-studio-test-* and removed on exit. Ports: 127.0.0.1 only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LH="$HERE/.."
PATCH_FILE="$LH/studio-isolation/lds-studio-isolation.patch"
STORAGE_SNIPPET="$LH/envoy-storage-public-headers.yaml"
RL_SNIPPET="$LH/envoy-phone-upload-ratelimit.yaml"
ENVOY_IMAGE="${ENVOY_IMAGE:-envoyproxy/envoy:v1.39.1}"
NODE_IMAGE="${NODE_IMAGE:-node:24-slim}"
UPSTREAM_COMMIT=564eab8ad7840b13324f68b1bfac074ef8d51c21
UPSTREAM_LDS_SHA=9d9a6d6ea0a372be99e165d995f012d383d5cc8473b92a06b7aa0bbd73566c3d   # = server copy, 2026-10-16
PATCHED_LDS_SHA=95bd48a7ce7dadaf8129f97563e4cd99dbef7f8ac75ca7884451a6d800064f8f

P=phf-studio-test
NET=$P-net; API=$P-api; STUDIO=$P-studio
GWS="$P-gw-control $P-gw-patched $P-gw-optional"
T="$(mktemp -d)"
down() { for c in $GWS $API $STUDIO; do docker rm -f "$c" >/dev/null 2>&1 || true; done; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap 'down; rm -rf "$T"' EXIT
down

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
PASS=0; FAIL=0
ok() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'PASS  %-78s %s\n' "$1" "$2"; else FAIL=$((FAIL+1)); printf 'FAIL  %-78s got [%s] want [%s]\n' "$1" "$2" "$3"; fi; }

# --- upstream files ---------------------------------------------------------
mkdir -p "$T/up"
for f in lds.template.yaml envoy.yaml cds.yaml docker-entrypoint.sh; do
  if [ -n "${UPSTREAM_ENVOY_DIR:-}" ]; then cp "$UPSTREAM_ENVOY_DIR/$f" "$T/up/$f"
  else curl -sSfL -o "$T/up/$f" "https://raw.githubusercontent.com/supabase/supabase/$UPSTREAM_COMMIT/docker/volumes/api/envoy/$f"; fi
done
ok "upstream lds.template.yaml sha = pinned (= server copy)" "$(sha "$T/up/lds.template.yaml")" "$UPSTREAM_LDS_SHA"

# --- variant: patched -----------------------------------------------------------
mkdir -p "$T/patched/volumes/api/envoy"
cp "$T/up/lds.template.yaml" "$T/patched/volumes/api/envoy/"
( cd "$T/patched" && patch -p1 --dry-run < "$PATCH_FILE" >/dev/null && patch -p1 < "$PATCH_FILE" >/dev/null )
ok "patch applies cleanly; patched sha = pinned" "$(sha "$T/patched/volumes/api/envoy/lds.template.yaml")" "$PATCHED_LDS_SHA"
ok "patched template: no route to the studio cluster left" "$(grep -c 'cluster: studio' "$T/patched/volumes/api/envoy/lds.template.yaml" || true)" "0"
ok "patched template: no /pg/ route left (RBAC policy entry only)" "$(grep -c 'name: pg-protected' "$T/patched/volumes/api/envoy/lds.template.yaml" || true)" "0"

# --- variant: patched + both optional rules (inserted where their docs say) ----
indent() { sed "s/^/$(printf '%*s' "$1" '')/"; }
awk '/^- name: phf.storage_public_headers/{on=1} /^# --- EDIT 2/{on=0} on' "$STORAGE_SNIPPET" | sed '/^#/d;/^$/d' | indent 16 > "$T/f_storage"
awk '/^- name: storage-v1-object-public/{on=1} on' "$STORAGE_SNIPPET" | indent 22 > "$T/r_storage"
awk '/^- name: envoy.filters.http.local_ratelimit/{on=1} /^# --- EDIT 2/{on=0} on' "$RL_SNIPPET" | sed '/^#/d;/^$/d' | indent 16 > "$T/f_rl"
awk '/^- name: functions-v1-phone-upload-token/{on=1} on' "$RL_SNIPPET" | indent 22 > "$T/r_rl"
for f in f_storage r_storage f_rl r_rl; do [ -s "$T/$f" ] || { echo "could not extract $f"; exit 2; }; done
awk -v fs="$T/f_storage" -v rs="$T/r_storage" -v fr="$T/f_rl" -v rr="$T/r_rl" '
  function cat(f,  l) { while ((getline l < f) > 0) print l; close(f) }
  { L[NR] = $0 }
  END {
    for (i = 1; i <= NR; i++) {
      if (L[i] ~ /^                      - match:$/ && L[i+1] ~ /^                          prefix: \/storage\/v1\/$/) cat(rs)
      if (L[i] ~ /^                      - name: functions-v1-all$/) cat(rr)
      if (L[i] ~ /^                - name: envoy.filters.http.router$/) { cat(fs); cat(fr) }
      print L[i]
    }
  }' "$T/patched/volumes/api/envoy/lds.template.yaml" > "$T/optional.lds.template.yaml"
ok "optional variant: both routes and both filters inserted" \
  "$(grep -cE 'name: (storage-v1-object-public|functions-v1-phone-upload-token|phf.storage_public_headers|envoy.filters.http.local_ratelimit)$' "$T/optional.lds.template.yaml")" "4"

# --- stub upstreams ------------------------------------------------------------
cat > "$T/stub.mjs" <<'EOF'
import http from "node:http";
const name = process.env.NAME;
for (const port of process.env.PORTS.split(",").map(Number)) {
  http.createServer((req, res) => {
    console.log(`HIT ${name} ${port} ${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json", "x-upstream-name": name,
      "x-upstream-port": String(port), "x-upstream-path": req.url });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify({ name, port }));
  }).listen(port, "0.0.0.0");
}
EOF
docker network create "$NET" >/dev/null
docker run -d --name "$API" --network "$NET" \
  --network-alias auth --network-alias rest --network-alias storage --network-alias functions \
  --network-alias meta --network-alias realtime-dev.supabase-realtime \
  -e NAME=api -e PORTS=9999,3000,4000,5000,9000,8080 -v "$T/stub.mjs:/stub.mjs:ro" "$NODE_IMAGE" node /stub.mjs >/dev/null
docker run -d --name "$STUDIO" --network "$NET" --network-alias studio \
  -e NAME=studio -e PORTS=3000 -v "$T/stub.mjs:/stub.mjs:ro" "$NODE_IMAGE" node /stub.mjs >/dev/null

# --- gateways (same mounts, env and entrypoint as upstream compose) ------------
ANON=anon-dummy-key; SERVICE=service-dummy-key; BA_USER=admin; BA_PASS=dummy-pw
gw() { # name lds-template-file
  docker run -d --name "$1" --network "$NET" -p 127.0.0.1::8000 \
    -v "$T/up/envoy.yaml:/etc/envoy/envoy.yaml:ro" -v "$T/up/cds.yaml:/etc/envoy/cds.yaml:ro" \
    -v "$2:/etc/envoy/lds.template.yaml:ro" -v "$T/up/docker-entrypoint.sh:/docker-entrypoint.sh:ro" \
    -e ANON_KEY=$ANON -e SERVICE_ROLE_KEY=$SERVICE -e SUPABASE_PUBLISHABLE_KEY= -e SUPABASE_SECRET_KEY= \
    -e ANON_KEY_ASYMMETRIC= -e SERVICE_ROLE_KEY_ASYMMETRIC= -e SUPABASE_PUBLIC_URL=http://localhost:8000 \
    -e DASHBOARD_USERNAME=$BA_USER -e DASHBOARD_PASSWORD=$BA_PASS \
    --entrypoint /bin/sh "$ENVOY_IMAGE" /docker-entrypoint.sh --log-level warn >/dev/null
}
gw $P-gw-control  "$T/up/lds.template.yaml"
gw $P-gw-patched  "$T/patched/volumes/api/envoy/lds.template.yaml"
gw $P-gw-optional "$T/optional.lds.template.yaml"
url() { local u; u="http://$(docker port "$1" 8000/tcp | head -1)"; case "$u" in http://127.0.0.1:*) echo "$u";; *) echo "gateway not on loopback: $u" >&2; exit 2;; esac; }
C=$(url $P-gw-control); PT=$(url $P-gw-patched); O=$(url $P-gw-optional)
for u in "$C" "$PT" "$O"; do
  for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$u/storage/v1/version" || true)" = 200 ] && break; sleep 1; done
done

H="$T/h"; B="$T/b"
req() { curl -s -o "$B" -D "$H" -w '%{http_code}' "$@" || true; }
hdr() { { grep -i "^$1:" "$H" || true; } | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
challenge() { { grep -ci '^www-authenticate:' "$H" || true; }; }
studio_hits() { docker logs "$STUDIO" 2>/dev/null | grep -c '^HIT studio' || true; }

echo "== control: unpatched upstream template (production today)"
ok "control /                      401 + Basic challenge" "$(req "$C/")|$(hdr www-authenticate | cut -d' ' -f1)" "401|Basic"
ok "control /project/default       401 + Basic challenge" "$(req "$C/project/default")|$(hdr www-authenticate | cut -d' ' -f1)" "401|Basic"
ok "control /api/platform/profile  401 + Basic challenge" "$(req "$C/api/platform/profile")|$(hdr www-authenticate | cut -d' ' -f1)" "401|Basic"
ok "control / with dashboard credentials reaches Studio" "$(req -u "$BA_USER:$BA_PASS" "$C/project/default")|$(hdr x-upstream-name)" "200|studio"
ok "control /api/mcp               403" "$(req "$C/api/mcp")" "403"
ok "control /pg/                   401 (no service key)" "$(req "$C/pg/")" "401"
ok "control /pg/tables with service key reaches meta" "$(req -H "apikey: $SERVICE" "$C/pg/tables")|$(hdr x-upstream-port)" "200|8080"

echo "== patched: Studio paths"
before=$(studio_hits)
for p in / /project/default /project/default/editor /api/platform/profile /api/platform/pg-meta/default/query \
         /api/mcp /mcp /pg/ /pg/tables /_next/static/chunks/main.js /favicon.ico /dashboard /nonexistent; do
  ok "patched GET $p  -> 404, no challenge" "$(req "$PT$p")|$(challenge)" "404|0"
done
ok "patched / body is the plain 404" "$(req "$PT/"; tr -d '\n' < "$B")" "404not found"
ok "patched / with dashboard credentials -> 404" "$(req -u "$BA_USER:$BA_PASS" "$PT/project/default")" "404"
ok "patched /pg/tables with service key -> 404" "$(req -H "apikey: $SERVICE" "$PT/pg/tables")" "404"
ok "patched POST /api/platform/pg-meta/default/query -> 404" "$(req -X POST -H 'content-type: application/json' -d '{"query":"select 1"}' "$PT/api/platform/pg-meta/default/query")" "404"
ok "patched HEAD / -> 404" "$(req -I "$PT/")" "404"
ok "patched dot-dot from an API prefix (/rest/v1/../project/default) -> 404" "$(req --path-as-is "$PT/rest/v1/../project/default")" "404"
ok "patched dot-dot from functions (/functions/v1/../../api/platform/profile) -> 404" "$(req --path-as-is "$PT/functions/v1/../../api/platform/profile")" "404"
ok "patched escaped slash rejected (/functions/v1%2F..%2Fproject) -> 400" "$(req --path-as-is "$PT/functions/v1%2F..%2Fproject")" "400"
ok "patched: Studio stub received no request" "$(studio_hits)" "$before"

echo "== patched: API routes unchanged"
ok "auth /auth/v1/health + apikey -> auth:9999 /health" "$(req -H "apikey: $ANON" "$PT/auth/v1/health")|$(hdr x-upstream-port)|$(hdr x-upstream-path)" "200|9999|/health"
ok "auth /auth/v1/health without apikey -> 401, no Basic challenge" "$(req "$PT/auth/v1/health")|$(challenge)" "401|0"
ok "auth /auth/v1/verify (public) -> auth:9999 /verify" "$(req "$PT/auth/v1/verify?token=x")|$(hdr x-upstream-path)" "200|/verify?token=x"
ok "auth /.well-known/oauth-authorization-server -> auth:9999" "$(req "$PT/.well-known/oauth-authorization-server")|$(hdr x-upstream-port)" "200|9999"
ok "rest /rest/v1/products + apikey -> rest:3000 (api stub, not studio)" "$(req -H "apikey: $ANON" "$PT/rest/v1/products?select=id")|$(hdr x-upstream-name)|$(hdr x-upstream-path)" "200|api|/products?select=id"
ok "rest /rest/v1/products?apikey= (query key) -> rest:3000" "$(req "$PT/rest/v1/products?apikey=$ANON")|$(hdr x-upstream-name)" "200|api"
ok "rest /rest/v1/products without apikey -> 401" "$(req "$PT/rest/v1/products")" "401"
ok "rest /rest/v1/ (openapi) with anon key -> 403 (service key only, unchanged)" "$(req -H "apikey: $ANON" "$PT/rest/v1/")" "403"
ok "graphql /graphql/v1 + apikey -> rest /rpc/graphql" "$(req -X POST -H "apikey: $ANON" "$PT/graphql/v1")|$(hdr x-upstream-path)" "200|/rpc/graphql"
ok "storage /storage/v1/version -> storage:5000 /version" "$(req "$PT/storage/v1/version")|$(hdr x-upstream-port)|$(hdr x-upstream-path)" "200|5000|/version"
ok "storage public object -> storage:5000" "$(req "$PT/storage/v1/object/public/product-images/a.jpg")|$(hdr x-upstream-path)" "200|/object/public/product-images/a.jpg"
ok "functions phone-upload-page -> functions:9000" "$(req "$PT/functions/v1/phone-upload-page")|$(hdr x-upstream-port)|$(hdr x-upstream-path)" "200|9000|/phone-upload-page"
ok "functions POST phone-upload-token -> functions:9000" "$(req -X POST "$PT/functions/v1/phone-upload-token")|$(hdr x-upstream-path)" "200|/phone-upload-token"
ok "realtime websocket path + apikey -> realtime:4000 /socket/..." "$(req -H "apikey: $ANON" "$PT/realtime/v1/websocket?vsn=1.0.0")|$(hdr x-upstream-port)|$(hdr x-upstream-path)" "200|4000|/socket/websocket?vsn=1.0.0"
ok "realtime /realtime/v1/api/tenants still blocked (403)" "$(req -H "apikey: $SERVICE" "$PT/realtime/v1/api/tenants")" "403"

echo "== optional: patched + 083 storage header rule + phone-upload rate limit"
ok "optional / -> 404" "$(req "$O/")|$(challenge)" "404|0"
ok "optional /project/default -> 404" "$(req "$O/project/default")" "404"
ok "optional /pg/ -> 404" "$(req "$O/pg/")" "404"
ok "optional storage public route: 200 + nosniff (rule active)" "$(req "$O/storage/v1/object/public/product-images/a.jpg")|$(hdr x-content-type-options)" "200|nosniff"
ok "optional storage other route: no rule headers" "$(req -H "apikey: $ANON" "$O/storage/v1/object/sign/product-images/a.jpg")|$(hdr x-content-type-options)" "200|"
ok "optional phone-upload-token -> functions:9000 /phone-upload-token" "$(req -X POST "$O/functions/v1/phone-upload-token")|$(hdr x-upstream-path)" "200|/phone-upload-token"
n429=0; for _ in $(seq 1 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$O/functions/v1/phone-upload-token")" = 429 ] && n429=$((n429+1)); done
ok "optional rate limit active on phone-upload-token (some 429 in a 40-request burst)" "$([ "$n429" -gt 0 ] && echo yes || echo "no ($n429)")" "yes"
ok "optional phone-upload-page unaffected -> 200" "$(req "$O/functions/v1/phone-upload-page")|$(hdr x-upstream-path)" "200|/phone-upload-page"
ok "optional: Studio stub still received no request" "$(studio_hits)" "$before"

echo
echo "envoy-studio-isolation: $PASS passed, $FAIL failed ($ENVOY_IMAGE)"
[ "$FAIL" = 0 ]
