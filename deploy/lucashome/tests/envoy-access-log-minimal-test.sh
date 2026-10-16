#!/usr/bin/env bash
# Local proof of deploy/lucashome/envoy_access_log_minimal.py (PREPARED, NOT APPLIED),
# without touching any server (docs/selfhost-migration/phase-f/gateway-logging-review.md §6).
#
# Part 1 (pure): states, apply/revert identity on the server template (a635a7aa…),
#   idempotency, client-info -> minimal, order independence with the Studio isolation.
# Part 2 (Envoy v1.39.1 + node stubs, loopback ports): two gateways rendered by the upstream
#   entrypoint, "control" = the server's current template, "minimal" = after apply.
#   The same requests carry secret markers in the query string (signed URL token, realtime
#   apikey, PostgREST email filter, auth verify token), in headers (Authorization, apikey,
#   Cookie, Referer), in request and response bodies. Control must log the query markers
#   (reproduces the live finding); minimal must log none of them, no query string at all,
#   and still be readable by verify-till-readiness.sh `reduce`.
#
#   deploy/lucashome/tests/envoy-access-log-minimal-test.sh
# Env: UPSTREAM_ENVOY_DIR (lds.template.yaml envoy.yaml cds.yaml docker-entrypoint.sh at the
#   pinned commit; default: fetched), SERVER_LDS (read-only copy of the server template; must
#   be byte-identical to the derived one). Containers phf-alog-test-*, removed on exit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LH="$HERE/.."
TOOL="$LH/envoy_access_log_minimal.py"
ENVOY_IMAGE="${ENVOY_IMAGE:-envoyproxy/envoy:v1.39.1}"
NODE_IMAGE="${NODE_IMAGE:-node:24-slim}"
UPSTREAM_COMMIT=564eab8ad7840b13324f68b1bfac074ef8d51c21
UPSTREAM_LDS_SHA=9d9a6d6ea0a372be99e165d995f012d383d5cc8473b92a06b7aa0bbd73566c3d
SERVER_LDS_SHA=a635a7aa347115168e15cb5853755d7546f0726a646527792a0109a72190e571

P=phf-alog-test; NET=$P-net; API=$P-api; GWS="$P-gw-control $P-gw-min"
T="$(mktemp -d)"
down() { for c in $GWS $API; do docker rm -f "$c" >/dev/null 2>&1 || true; done; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap 'down; rm -rf "$T"' EXIT
down
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
PASS=0; FAIL=0
ok() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'PASS  %-78s %s\n' "$1" "$2"; else FAIL=$((FAIL+1)); printf 'FAIL  %-78s got [%s] want [%s]\n' "$1" "$2" "$3"; fi; }
tool() { python3 -I "$TOOL" "$@"; }
st() { tool status "$1" | sed -nE 's/^access-log format: ([a-z-]+).*/\1/p'; }

mkdir -p "$T/up"
for f in lds.template.yaml envoy.yaml cds.yaml docker-entrypoint.sh; do
  if [ -n "${UPSTREAM_ENVOY_DIR:-}" ]; then cp "$UPSTREAM_ENVOY_DIR/$f" "$T/up/$f"
  else curl -sSfL -o "$T/up/$f" "https://raw.githubusercontent.com/supabase/supabase/$UPSTREAM_COMMIT/docker/volumes/api/envoy/$f"; fi
done
U="$T/up/lds.template.yaml"
ok "upstream template sha pinned" "$(sha "$U")" "$UPSTREAM_LDS_SHA"
python3 -I "$LH/envoy_storage_headers.py" apply "$U" "$T/server.yaml" >/dev/null
ok "server template = header rule on upstream (a635a7aa…)" "$(sha "$T/server.yaml")" "$SERVER_LDS_SHA"
if [ -n "${SERVER_LDS:-}" ]; then ok "SERVER_LDS copy byte-identical to the derived file" "$(cmp -s "$SERVER_LDS" "$T/server.yaml" && echo same || echo differs)" "same"; fi

echo "== part 1: tool"
ok "status upstream" "$(st "$U")" "upstream"
ok "status server" "$(st "$T/server.yaml")" "upstream"
tool apply "$T/server.yaml" "$T/min.yaml" >/dev/null
ok "apply -> minimal" "$(st "$T/min.yaml")" "minimal"
ok "apply changes exactly one line" "$(diff "$T/server.yaml" "$T/min.yaml" | grep -c '^[<>]' || true)" "2"
ok "minimal format: no query-carrying path operator" "$(grep -c 'X-ENVOY-ORIGINAL-PATH?:PATH\|%REQ(:PATH)%\|REQ(REFERER)' "$T/min.yaml" || true)" "0"
tool apply "$T/min.yaml" "$T/min2.yaml" >/dev/null
ok "apply idempotent" "$(cmp -s "$T/min.yaml" "$T/min2.yaml" && echo same || echo differs)" "same"
tool revert "$T/min.yaml" "$T/rev.yaml" >/dev/null
ok "revert(apply(server)) = server (a635a7aa…)" "$(sha "$T/rev.yaml")" "$SERVER_LDS_SHA"
python3 -I "$LH/envoy_access_log_client_info.py" apply "$T/server.yaml" "$T/ci.yaml" >/dev/null
ok "status after the older client-info proposal" "$(st "$T/ci.yaml")" "client-info"
tool apply "$T/ci.yaml" "$T/ci.min.yaml" >/dev/null
ok "client-info -> minimal = same bytes as from upstream" "$(cmp -s "$T/ci.min.yaml" "$T/min.yaml" && echo same || echo differs)" "same"
sed 's/%BYTES_SENT% \\"%REQ(REFERER)%/%BYTES_SENT% %DURATION% \\"%REQ(REFERER)%/' "$T/server.yaml" > "$T/tampered.yaml"
rc=0; tool apply "$T/tampered.yaml" "$T/never.yaml" >/dev/null || rc=$?
ok "hand-edited format: refuses, nothing written" "$rc|$([ -e "$T/never.yaml" ] && echo written || echo none)" "1|none"
SI="$LH/studio-isolation/studio_isolation.py"
python3 -I "$SI" apply "$T/min.yaml" "$T/min.si.yaml" >/dev/null
python3 -I "$SI" apply "$T/server.yaml" "$T/si.yaml" >/dev/null; tool apply "$T/si.yaml" "$T/si.min.yaml" >/dev/null
ok "order: studio(minimal(server)) = minimal(studio(server))" "$(cmp -s "$T/min.si.yaml" "$T/si.min.yaml" && echo same || echo differs)" "same"

echo "== part 2: Envoy"
cat > "$T/stub.mjs" <<'EOF'
import http from "node:http";
for (const port of [9999, 3000, 4000, 5000, 9000, 8080]) {
  http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "sb-session=RESPCOOKIE-MARK" });
      res.end(JSON.stringify({ port, access_token: "RESPBODY-MARK" }));
    });
  }).listen(port, "0.0.0.0");
}
EOF
docker network create "$NET" >/dev/null
docker run -d --name "$API" --network "$NET" \
  --network-alias auth --network-alias rest --network-alias storage --network-alias functions \
  --network-alias meta --network-alias studio --network-alias realtime-dev.supabase-realtime \
  -v "$T/stub.mjs:/stub.mjs:ro" "$NODE_IMAGE" node /stub.mjs >/dev/null
envrun() { # template, then docker args, "--", then envoy args
  local tpl="$1"; shift; local d=()
  while [ "$1" != -- ]; do d+=("$1"); shift; done; shift
  docker run "${d[@]}" --network "$NET" \
    -v "$T/up/envoy.yaml:/etc/envoy/envoy.yaml:ro" -v "$T/up/cds.yaml:/etc/envoy/cds.yaml:ro" \
    -v "$tpl:/etc/envoy/lds.template.yaml:ro" -v "$T/up/docker-entrypoint.sh:/docker-entrypoint.sh:ro" \
    -e ANON_KEY=anon-dummy -e SERVICE_ROLE_KEY=service-dummy -e SUPABASE_PUBLISHABLE_KEY= -e SUPABASE_SECRET_KEY= \
    -e ANON_KEY_ASYMMETRIC= -e SERVICE_ROLE_KEY_ASYMMETRIC= -e SUPABASE_PUBLIC_URL=http://localhost:8000 \
    -e DASHBOARD_USERNAME=admin -e DASHBOARD_PASSWORD=dummy-pw \
    --entrypoint /bin/sh "$ENVOY_IMAGE" /docker-entrypoint.sh "$@"
}
for v in min.yaml min.si.yaml server.yaml; do
  ok "envoy --mode validate $v" "$(envrun "$T/$v" --rm -- --log-level error --mode validate >/dev/null 2>&1 && echo valid || echo invalid)" "valid"
done
envrun "$T/server.yaml" -d --name $P-gw-control -p 127.0.0.1::8000 -- --log-level warn >/dev/null
envrun "$T/min.yaml" -d --name $P-gw-min -p 127.0.0.1::8000 -- --log-level warn >/dev/null
url() { local u; u="http://$(docker port "$1" 8000/tcp | head -1)"; case "$u" in http://127.0.0.1:*) echo "$u";; *) echo "not loopback: $u" >&2; exit 2;; esac; }
C=$(url $P-gw-control); M=$(url $P-gw-min)
for u in "$C" "$M"; do for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$u/storage/v1/version" || true)" = 200 ] && break; sleep 1; done; done

# secret markers, built at run time
JWT="eyJ$(openssl rand -hex 12).eyJ$(openssl rand -hex 16).$(openssl rand -hex 16)"
UA='Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) retails-shop/1.0.16 Chrome/138.0 Electron/37.10.3 Safari/537.36'
XCI='shwephala-pos/1.0.16 (validated-uploads; idem-v1; outbox-origin-v1; update-guard-v1)'
send() { # base
  local b="$1" c=(-s -o /dev/null -m 10 -A "$UA" -H "x-client-info: $XCI")
  curl "${c[@]}" "$b/storage/v1/object/sign/product-images/org/o/a.jpg?token=$JWT"
  curl "${c[@]}" -X PUT --data-binary 'REQBODY-MARK' "$b/storage/v1/object/upload/sign/product-images/org/o/temp/pimg-1.jpg?token=$JWT"
  curl "${c[@]}" "$b/realtime/v1/websocket?apikey=$JWT&vsn=1.0.0"
  curl "${c[@]}" -H "apikey: APIKEYHDR-MARK" -H "Authorization: Bearer AUTHHDR-MARK" "$b/rest/v1/users?select=id&email=eq.owner-mark%40example.com"
  curl "${c[@]}" -H "apikey: APIKEYHDR-MARK" "$b/rest/v1/users?select=id&email=ilike.*owner-mark*"
  curl "${c[@]}" "$b/auth/v1/verify?token=$JWT&type=recovery&redirect_to=https%3A%2F%2Fx"
  curl "${c[@]}" -X POST -H 'content-type: application/json' -H 'Cookie: sb-access-token=COOKIE-MARK' \
       -d '{"password":"REQBODY-MARK"}' "$b/auth/v1/token?grant_type=password"
  curl "${c[@]}" -H 'Referer: https://h.example/functions/v1/phone-upload-page?t=REFERER-MARK' "$b/functions/v1/phone-upload-page?token=$JWT#frag"
  curl "${c[@]}" "$b/rest/v1/products?image_url=eq.https://h/storage/v1/object/sign/x?token=$JWT"
}
send "$C"; send "$M"
N=9
# access-log lines of the requests above (the readiness probe /storage/v1/version is left out)
logs() { docker logs "$1" 2>/dev/null | grep -E '^[0-9a-f.:]+ - - \[' | grep -v '"GET /storage/v1/version ' || true; }
for g in $P-gw-control $P-gw-min; do for _ in $(seq 1 20); do [ "$(logs $g | wc -l | tr -d ' ')" -ge $N ] && break; sleep 1; done; done
logs $P-gw-control > "$T/control.log"; logs $P-gw-min > "$T/min.log"
ok "control: all $N requests logged" "$(wc -l < "$T/control.log" | tr -d ' ')" "$N"
ok "minimal: all $N requests logged" "$(wc -l < "$T/min.log" | tr -d ' ')" "$N"

echo "-- control = today's production format (live finding reproduced)"
ok "control logs the signed-URL / apikey / verify JWT" "$( [ "$(grep -c "$JWT" "$T/control.log")" -ge 5 ] && echo yes || echo no)" "yes"
ok "control logs the PostgREST e-mail filter value" "$(grep -c 'owner-mark' "$T/control.log")" "2"
ok "control logs the referer query" "$(grep -c 'REFERER-MARK' "$T/control.log")" "1"
ok "control: header / body / cookie markers NOT logged (already true today)" \
  "$(grep -cE 'APIKEYHDR-MARK|AUTHHDR-MARK|COOKIE-MARK|REQBODY-MARK|RESPBODY-MARK|RESPCOOKIE-MARK' "$T/control.log" || true)" "0"

echo "-- minimal"
ok "minimal: no JWT anywhere" "$(grep -c "$JWT" "$T/min.log" || true)" "0"
ok "minimal: no eyJ token prefix at all" "$(grep -c 'eyJ' "$T/min.log" || true)" "0"
ok "minimal: no e-mail filter value" "$(grep -c 'owner-mark' "$T/min.log" || true)" "0"
ok "minimal: no referer" "$(grep -c 'REFERER-MARK\|h.example' "$T/min.log" || true)" "0"
ok "minimal: no header / body / cookie marker" \
  "$(grep -cE 'APIKEYHDR-MARK|AUTHHDR-MARK|COOKIE-MARK|REQBODY-MARK|RESPBODY-MARK|RESPCOOKIE-MARK' "$T/min.log" || true)" "0"
ok "minimal: no '?' in any logged request path" \
  "$(sed -nE 's/^[^"]*"[A-Z]+ ([^ ]*) [^"]*".*/\1/p' "$T/min.log" | grep -c '?' || true)" "0"
ok "minimal: no query parameter names (token= apikey= email= grant_type=)" "$(grep -cE 'token=|apikey=|email=|grant_type=' "$T/min.log" || true)" "0"
ok "minimal: paths kept (signed PUT path present)" "$(grep -c '"PUT /storage/v1/object/upload/sign/product-images/org/o/temp/pimg-1.jpg HTTP/1.1"' "$T/min.log")" "1"
ok "minimal: duration + upstream cluster + flags field on every line" "$(grep -cE '"rt=[0-9]+ up=[a-z_-]+ rf=[A-Z,-]+"' "$T/min.log")" "$N"
ok "minimal: upstream cluster recorded (storage, rest, auth, functions, realtime)" \
  "$(grep -oE 'up=[a-z_-]+' "$T/min.log" | sort -u | tr '\n' ' ' | sed 's/ $//')" "up=auth up=functions up=realtime up=rest up=storage"
ok "minimal: x-client-info logged" "$(grep -c "\"$XCI\"\$" "$T/min.log")" "$N"
sed -n '/^cat >"\$WORK\/r.py" <</,/^PY$/p' "$LH/verify-till-readiness.sh" | sed '1d;$d' > "$T/r.py"
python3 -I "$T/r.py" reduce < "$T/min.log" > "$T/min.tsv"
ok "verify-till-readiness reduce reads every minimal line" "$(grep -vc '^#' "$T/min.tsv")" "$N"
ok "reduce: desktop|1.0.16|yes" "$(awk -F'\t' '!/^#/{print $2"|"$3"|"$4}' "$T/min.tsv" | sort -u)" "desktop|1.0.16|yes"
ok "reduce: signed PUT classified (path without query is enough)" "$(awk -F'\t' '$5=="signed_put"' "$T/min.tsv" | wc -l | tr -d ' ')" "1"
echo "sample minimal line (markers only):"; sed -n '2p' "$T/min.log" | sed 's/^/    /'

echo
echo "envoy-access-log-minimal: $PASS passed, $FAIL failed ($ENVOY_IMAGE)"
[ "$FAIL" = 0 ]
