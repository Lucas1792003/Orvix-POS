#!/usr/bin/env bash
# Local proof of deploy/lucashome/envoy-storage-public-headers.yaml (G5, 083)
# on the production Envoy version, without touching any server.
#
# Builds a minimal Envoy config from the two snippet blocks EXACTLY as they
# are in the file (EDIT 1 filter, EDIT 2 route), next to a basic_auth filter,
# an RBAC filter that requires an apikey (like upstream's), the upstream-style
# catch-all /storage/v1/ route, and a fake storage upstream (node) that serves
# fixed bodies with chosen Content-Types. Then asserts the response headers.
#
#   deploy/lucashome/tests/envoy-storage-headers-test.sh
# Needs docker; images envoyproxy/envoy:v1.39.1 and node:24-slim (pulled if
# missing). Containers/network are named g5-envoy-* and removed on exit.
# Ports: 127.0.0.1 only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SNIPPET="$HERE/../envoy-storage-public-headers.yaml"
ENVOY_IMAGE="${ENVOY_IMAGE:-envoyproxy/envoy:v1.39.1}"
NODE_IMAGE="${NODE_IMAGE:-node:24-slim}"
NET=g5-envoy-net; UP=g5-envoy-up; GW=g5-envoy-gw
TMP="$(mktemp -d)"
down() { docker rm -f "$GW" "$UP" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap 'down; rm -rf "$TMP"' EXIT
down

# --- the two blocks, verbatim, re-indented into the bootstrap ---------------
filter_block=$(awk '/^- name: phf.storage_public_headers/{on=1} /^# --- EDIT 2/{on=0} on' "$SNIPPET" | sed '/^#/d;/^$/d')
route_block=$(awk '/^- name: storage-v1-object-public/{on=1} on' "$SNIPPET")
[ -n "$filter_block" ] && [ -n "$route_block" ] || { echo "could not extract the snippet blocks"; exit 2; }
indent() { sed "s/^/$(printf '%*s' "$1" '')/"; }

# dashboard basic auth user (dummy) - the public route must not ask for it
BA_USER="admin:{SHA}$(printf 'dummy-pw' | openssl dgst -sha1 -binary | openssl base64)"

cat > "$TMP/envoy.yaml" <<EOF
static_resources:
  listeners:
    - name: supabase
      address: { socket_address: { address: 0.0.0.0, port_value: 8000 } }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                '@type': type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_http
                normalize_path: true
                merge_slashes: true
                path_with_escaped_slashes_action: REJECT_REQUEST
                route_config:
                  name: supabase_route
                  virtual_hosts:
                    - name: supabase_host
                      domains: ['*']
                      routes:
$(printf '%s\n' "$route_block" | indent 24)
                        - match: { prefix: /storage/v1/ }
                          route: { cluster: storage, prefix_rewrite: /, timeout: 30s }
                          typed_per_filter_config:
                            envoy.filters.http.basic_auth:
                              '@type': type.googleapis.com/envoy.config.route.v3.FilterConfig
                              disabled: true
                            envoy.filters.http.rbac:
                              '@type': type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBACPerRoute
                              rbac: { rules: { action: ALLOW, policies: { allow_all: { permissions: [ { any: true } ], principals: [ { any: true } ] } } } }
                http_filters:
                  - name: envoy.filters.http.basic_auth
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.basic_auth.v3.BasicAuth
                      users: { inline_string: '$BA_USER' }
                  - name: envoy.filters.http.rbac
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC
                      rules:
                        action: ALLOW
                        policies:
                          apikey_required:
                            permissions: [ { any: true } ]
                            principals: [ { header: { name: apikey, present_match: true } } ]
$(printf '%s\n' "$filter_block" | indent 18)
                  - name: envoy.filters.http.router
                    typed_config:
                      '@type': type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: storage
      type: STRICT_DNS
      connect_timeout: 5s
      load_assignment:
        cluster_name: storage
        endpoints:
          - lb_endpoints:
              - endpoint: { address: { socket_address: { address: $UP, port_value: 5000 } } }
EOF

# --- fake storage upstream ---------------------------------------------------
cat > "$TMP/up.mjs" <<'EOF'
import http from "node:http";
const T = {
  "img.jpg": ["image/jpeg", Buffer.from("ffd8ffe000104a464946ffd9", "hex")],
  "img.png": ["image/png; charset=binary", Buffer.from("89504e470d0a1a0a", "hex")],
  "img.webp": ["IMAGE/WEBP", Buffer.from("RIFF\x04\x00\x00\x00WEBP", "latin1")],
  "page.html": ["text/html; charset=utf-8", Buffer.from("<html><script>document.title=1</script></html>")],
  "vec.svg": ["image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>")],
  "blob.bin": ["application/octet-stream", Buffer.from([1, 2, 3])],
  "disp.jpg": ["image/jpeg", Buffer.from("ffd8ff", "hex"), { "content-disposition": "attachment; filename=x.html", "x-content-type-options": "sniff", "content-security-policy": "default-src *" }],
};
http.createServer((req, res) => {
  const name = req.url.split("?")[0].split("/").pop();
  const t = T[name];
  const base = { "x-upstream-path": req.url, "cache-control": "max-age=3600" };
  if (!t) { res.writeHead(400, { ...base, "content-type": "application/json" }); res.end('{"statusCode":"404","error":"not_found"}'); return; }
  res.writeHead(200, { ...base, "content-type": t[0], ...(t[2] ?? {}) });
  res.end(req.method === "HEAD" ? undefined : t[1]);
}).listen(5000, "0.0.0.0");
EOF

docker network create "$NET" >/dev/null
docker run -d --name "$UP" --network "$NET" -v "$TMP/up.mjs:/up.mjs:ro" "$NODE_IMAGE" node /up.mjs >/dev/null
docker run -d --name "$GW" --network "$NET" -p 127.0.0.1::8000 -v "$TMP/envoy.yaml:/etc/envoy/envoy.yaml:ro" "$ENVOY_IMAGE" \
  envoy -c /etc/envoy/envoy.yaml --log-level warn >/dev/null
URL="http://$(docker port "$GW" 8000/tcp | head -1)"
case "$URL" in http://127.0.0.1:*) ;; *) echo "gateway not on loopback: $URL"; exit 2;; esac
for _ in $(seq 1 60); do curl -s -o /dev/null "$URL/storage/v1/object/public/product-images/img.jpg" && break; sleep 1; done

PASS=0; FAIL=0
H="$TMP/h"
get() { curl -s -o /dev/null -D "$H" -w '%{http_code}' "$@" || true; }
hdr() { { grep -i "^$1:" "$H" || true; } | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
nh()  { grep -ic "^$1:" "$H" || true; }
ok()  { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'PASS  %-70s %s\n' "$1" "$2"; else FAIL=$((FAIL+1)); printf 'FAIL  %-70s got [%s] want [%s]\n' "$1" "$2" "$3"; fi; }
P="$URL/storage/v1/object/public/product-images"

code=$(get "$P/img.jpg")
ok "public JPEG: 200 without apikey / basic auth" "$code" 200
ok "public JPEG: prefix rewritten like the upstream storage route" "$(hdr x-upstream-path)" "/object/public/product-images/img.jpg"
ok "public JPEG: content-type unchanged" "$(hdr content-type)" "image/jpeg"
ok "public JPEG: X-Content-Type-Options" "$(hdr x-content-type-options)" "nosniff"
ok "public JPEG: Content-Security-Policy" "$(hdr content-security-policy)" "default-src 'none'; sandbox"
ok "public JPEG: Content-Disposition inline" "$(hdr content-disposition)" "inline"
ok "public JPEG: cache-control passed through" "$(hdr cache-control)" "max-age=3600"
get "$P/img.png" >/dev/null; ok "public PNG (with ; charset): inline" "$(hdr content-disposition)" "inline"
get "$P/img.webp" >/dev/null; ok "public WebP (upper-case type): inline" "$(hdr content-disposition)" "inline"
for f in page.html vec.svg blob.bin; do
  get "$P/$f" >/dev/null
  ok "public $f: Content-Disposition attachment" "$(hdr content-disposition)" "attachment"
  ok "public $f: served as application/octet-stream" "$(hdr content-type)" "application/octet-stream"
  ok "public $f: nosniff + CSP sandbox" "$(hdr x-content-type-options)|$(hdr content-security-policy)" "nosniff|default-src 'none'; sandbox"
done
get "$P/disp.jpg" >/dev/null
ok "upstream headers cannot weaken it: one nosniff" "$(nh x-content-type-options)|$(hdr x-content-type-options)" "1|nosniff"
ok "upstream headers cannot weaken it: one CSP (ours)" "$(nh content-security-policy)|$(hdr content-security-policy)" "1|default-src 'none'; sandbox"
ok "upstream headers cannot weaken it: Content-Disposition inline (image)" "$(nh content-disposition)|$(hdr content-disposition)" "1|inline"
code=$(get -I "$P/img.jpg")
ok "HEAD public JPEG: 200 + nosniff + inline" "$code|$(hdr x-content-type-options)|$(hdr content-disposition)" "200|nosniff|inline"
code=$(get "$P/missing.jpg")
ok "missing object: upstream status and JSON type kept, no disposition" "$code|$(hdr content-type)|$(nh content-disposition)" "400|application/json|0"
ok "missing object: nosniff + CSP still set" "$(hdr x-content-type-options)" "nosniff"
code=$(get "$URL/storage/v1/object/sign/product-images/page.html?token=x")
ok "other storage route (sign): untouched by the rule" "$code|$(hdr content-type)|$(nh x-content-type-options)|$(nh content-disposition)" "200|text/html; charset=utf-8|0|0"
code=$(get "$URL/storage/v1/object/authenticated/product-images/page.html")
ok "other storage route (authenticated): untouched by the rule" "$(nh content-security-policy)" "0"
code=$(get --path-as-is "$URL/storage/v1/object/public/../sign/product-images/page.html")
ok "dot-dot from public normalises to the sign route (no header, no bypass of anything)" "$(hdr x-upstream-path)|$(nh content-security-policy)" "/object/sign/product-images/page.html|0"
code=$(get --path-as-is "$URL/storage/v1/object/public%2Fproduct-images/page.html")
ok "escaped slash is rejected by the connection manager" "$code" 400

echo
echo "envoy-storage-headers: $PASS passed, $FAIL failed ($ENVOY_IMAGE)"
[ "$FAIL" = 0 ]
