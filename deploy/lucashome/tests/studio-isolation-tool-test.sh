#!/usr/bin/env bash
# Local proof of the deploy-ready Studio isolation tooling, without touching any server:
#   deploy/lucashome/studio-isolation/studio_isolation.py   (lds + compose edit, status/apply/revert)
#   deploy/lucashome/studio-isolation/studio-isolation.sh   (its `verify` checks)
#   deploy/lucashome/envoy_access_log_client_info.py        (prepared access-log field)
#
# Inputs: the upstream gateway files + docker-compose.yml at the pinned commit (or
# UPSTREAM_ENVOY_DIR with lds.template.yaml envoy.yaml cds.yaml docker-entrypoint.sh
# docker-compose.yml). The server's current template (G5 header rule applied, sha
# a635a7aa…) is re-derived with envoy_storage_headers.py from upstream; if SERVER_LDS
# points at a read-only copy of the server file it must be byte-identical.
#
# Part 1 (pure): states, pinned shas, idempotency, revert = identity, order independence
#   with the header rule and the access-log edit, refusal on a changed block, compose
#   override edit checked with `docker compose config`.
# Part 2 (Envoy v1.39.1 + node stubs, loopback ports): the final template (header rule +
#   studio isolation + access-log field) passes envoy --mode validate and
#   studio-isolation.sh verify --gateway-only; the server's current template fails the
#   same verify (Studio still on the origin); the access log carries x-client-info and
#   verify-till-readiness.sh `reduce` reads it.
#
#   deploy/lucashome/tests/studio-isolation-tool-test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LH="$HERE/.."
SI="$LH/studio-isolation"
TOOL="$SI/studio_isolation.py"
ENVOY_IMAGE="${ENVOY_IMAGE:-envoyproxy/envoy:v1.39.1}"
NODE_IMAGE="${NODE_IMAGE:-node:24-slim}"
UPSTREAM_COMMIT=564eab8ad7840b13324f68b1bfac074ef8d51c21
UPSTREAM_LDS_SHA=9d9a6d6ea0a372be99e165d995f012d383d5cc8473b92a06b7aa0bbd73566c3d
SERVER_LDS_SHA=a635a7aa347115168e15cb5853755d7546f0726a646527792a0109a72190e571   # 2026-10-16, after the G5 header rule
PATCHED_LDS_SHA=95bd48a7ce7dadaf8129f97563e4cd99dbef7f8ac75ca7884451a6d800064f8f  # = lds-studio-isolation.patch on upstream

P=phf-si-tool-test; NET=$P-net; API=$P-api; STUDIO=$P-studio; GWS="$P-gw-final $P-gw-server"
T="$(mktemp -d)"
down() { for c in $GWS $API $STUDIO; do docker rm -f "$c" >/dev/null 2>&1 || true; done; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap 'down; rm -rf "$T"' EXIT
down
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
PASS=0; FAIL=0
ok() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf 'PASS  %-76s %s\n' "$1" "$2"; else FAIL=$((FAIL+1)); printf 'FAIL  %-76s got [%s] want [%s]\n' "$1" "$2" "$3"; fi; }
tool() { python3 -I "$TOOL" "$@"; }
hdrs() { python3 -I "$LH/envoy_storage_headers.py" apply "$1" "$2" >/dev/null; }
alog() { python3 -I "$LH/envoy_access_log_client_info.py" "$@" >/dev/null; }
st() { tool status "$1" ${2:+"$2"} | sed -nE "s/^${3:-lds}: ([a-z]+).*/\1/p"; }

mkdir -p "$T/up"
for f in lds.template.yaml envoy.yaml cds.yaml docker-entrypoint.sh docker-compose.yml; do
  if [ -n "${UPSTREAM_ENVOY_DIR:-}" ]; then cp "$UPSTREAM_ENVOY_DIR/$f" "$T/up/$f"
  elif [ "$f" = docker-compose.yml ]; then curl -sSfL -o "$T/up/$f" "https://raw.githubusercontent.com/supabase/supabase/$UPSTREAM_COMMIT/docker/$f"
  else curl -sSfL -o "$T/up/$f" "https://raw.githubusercontent.com/supabase/supabase/$UPSTREAM_COMMIT/docker/volumes/api/envoy/$f"; fi
done
U="$T/up/lds.template.yaml"
ok "upstream template sha pinned" "$(sha "$U")" "$UPSTREAM_LDS_SHA"
hdrs "$U" "$T/server.yaml"
ok "server template = header rule on upstream (sha a635a7aa…)" "$(sha "$T/server.yaml")" "$SERVER_LDS_SHA"
if [ -n "${SERVER_LDS:-}" ]; then ok "SERVER_LDS copy byte-identical to the derived file" "$(cmp -s "$SERVER_LDS" "$T/server.yaml" && echo same || echo differs)" "same"; fi
ok "server copy: no secret-looking values (only \${...} placeholders)" "$(grep -cE 'eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/=_-]{40,}' "$T/server.yaml" || true)" "0"

echo "== part 1: lds edit"
ok "status upstream template" "$(st "$U")" "upstream"
ok "status server template" "$(st "$T/server.yaml")" "upstream"
tool apply "$U" "$T/u.iso.yaml" >/dev/null
ok "apply on upstream = the reviewed patch (sha 95bd48a7…)" "$(sha "$T/u.iso.yaml")" "$PATCHED_LDS_SHA"
ok "isolated: no studio cluster route" "$(grep -c 'cluster: studio' "$T/u.iso.yaml" || true)" "0"
ok "isolated: no pg-protected route" "$(grep -c 'name: pg-protected' "$T/u.iso.yaml" || true)" "0"
ok "isolated: phf-not-found is the last route (next line http_filters:)" \
  "$(awk '/name: phf-not-found/{f=1} f&&/^              http_filters:/{print "yes"; exit} f&&/^                      - /&&!/phf-not-found/{print "no"; exit}' "$T/u.iso.yaml")" "yes"
ok "status isolated" "$(st "$T/u.iso.yaml")" "isolated"
tool apply "$T/u.iso.yaml" "$T/u.iso2.yaml" >/dev/null
ok "apply is idempotent (byte-identical)" "$(cmp -s "$T/u.iso.yaml" "$T/u.iso2.yaml" && echo same || echo differs)" "same"
tool revert "$T/u.iso.yaml" "$T/u.rev.yaml" >/dev/null
ok "revert(apply(upstream)) = upstream" "$(sha "$T/u.rev.yaml")" "$UPSTREAM_LDS_SHA"
tool revert "$U" "$T/u.rev2.yaml" >/dev/null
ok "revert on upstream is a no-op" "$(sha "$T/u.rev2.yaml")" "$UPSTREAM_LDS_SHA"
tool apply "$T/server.yaml" "$T/s.iso.yaml" >/dev/null
tool revert "$T/s.iso.yaml" "$T/s.rev.yaml" >/dev/null
ok "revert(apply(server)) = server (a635a7aa…)" "$(sha "$T/s.rev.yaml")" "$SERVER_LDS_SHA"
hdrs "$T/u.iso.yaml" "$T/iso.then.hdr.yaml"
ok "order: header(studio(up)) = studio(header(up))" "$(cmp -s "$T/iso.then.hdr.yaml" "$T/s.iso.yaml" && echo same || echo differs)" "same"
ok "header tool sees the isolated template as applied-capable (status ok)" "$(python3 -I "$LH/envoy_storage_headers.py" status "$T/s.iso.yaml" >/dev/null && echo ok || echo fail)" "ok"
tool status "$T/s.iso.yaml" >/dev/null; ok "combined template: studio status isolated" "$(st "$T/s.iso.yaml")" "isolated"
cp "$U" "$T/inplace.yaml"; tool apply "$T/inplace.yaml" "$T/inplace.yaml" >/dev/null
ok "in-place apply works" "$(sha "$T/inplace.yaml")" "$PATCHED_LDS_SHA"
# a changed upstream block must be refused, nothing written
sed 's/prefix: \/api\/mcp$/prefix: \/api\/mcp2/' "$U" > "$T/tampered.yaml"
rc=0; tool apply "$T/tampered.yaml" "$T/never.yaml" >/dev/null || rc=$?
ok "changed route block: apply refuses (exit 1), no output" "$rc|$([ -e "$T/never.yaml" ] && echo written || echo none)" "1|none"
ok "changed route block: status unknown" "$(st "$T/tampered.yaml")" "unknown"
sed 's/inline_string: "not found\\n"/inline_string: "gone\\n"/' "$T/u.iso.yaml" > "$T/tampered2.yaml"
rc=0; tool revert "$T/tampered2.yaml" "$T/never2.yaml" >/dev/null || rc=$?
ok "changed not-found block: revert refuses" "$rc|$([ -e "$T/never2.yaml" ] && echo written || echo none)" "1|none"
ok "upstream-studio-routes.yaml has no secret-looking value" "$(grep -cE '[A-Za-z0-9+/=_-]{40,}' "$SI/upstream-studio-routes.yaml" || true)" "0"

echo "== part 1: access-log field (prepared)"
alog apply "$T/s.iso.yaml" "$T/final.yaml"
ok "access-log apply: x-client-info field added once" "$(grep -c 'REQ(X-CLIENT-INFO)' "$T/final.yaml")" "1"
alog apply "$T/final.yaml" "$T/final2.yaml"; ok "access-log apply idempotent" "$(cmp -s "$T/final.yaml" "$T/final2.yaml" && echo same || echo differs)" "same"
alog revert "$T/final.yaml" "$T/final.rev.yaml"; ok "access-log revert = before" "$(cmp -s "$T/final.rev.yaml" "$T/s.iso.yaml" && echo same || echo differs)" "same"
alog apply "$U" "$T/a.yaml"; hdrs "$T/a.yaml" "$T/a.h.yaml"; tool apply "$T/a.h.yaml" "$T/a.h.s.yaml" >/dev/null
ok "order: studio(header(alog(up))) = alog(studio(header(up)))" "$(cmp -s "$T/a.h.s.yaml" "$T/final.yaml" && echo same || echo differs)" "same"

echo "== part 1: compose override"
O="$LH/docker-compose.override.yml"
ok "status repo override (= server copy f3d56b05…)" "$(st "$U" "$O" override)" "upstream"
tool apply "$U" "$T/x.yaml" "$O" "$T/ovr.yml" >/dev/null
ok "override apply -> isolated" "$(st "$U" "$T/ovr.yml" override)" "isolated"
tool apply "$U" "$T/x.yaml" "$T/ovr.yml" "$T/ovr2.yml" >/dev/null
ok "override apply idempotent" "$(cmp -s "$T/ovr.yml" "$T/ovr2.yml" && echo same || echo differs)" "same"
tool revert "$U" "$T/x.yaml" "$T/ovr.yml" "$T/ovr.rev.yml" >/dev/null
ok "override revert = original" "$(cmp -s "$O" "$T/ovr.rev.yml" && echo same || echo differs)" "same"
ok "override diff: only the 4 added lines" "$(diff "$O" "$T/ovr.yml" | grep -c '^>' || true)|$(diff "$O" "$T/ovr.yml" | grep -c '^<' || true)" "4|0"
cfg() { (cd "$T/up" && cp "$1" ./docker-compose.override.yml && docker compose -f docker-compose.yml -f docker-compose.override.yml config --format json 2>/dev/null); }
ok "compose config (upstream + edited override): studio 127.0.0.1:54323 -> 3000" \
  "$(cfg "$T/ovr.yml" | python3 -I -c 'import json,sys; s=json.load(sys.stdin)["services"]; print(*[(p.get("host_ip"),p.get("published"),p.get("target")) for p in s["studio"].get("ports",[])], s["api-gw"]["ports"][0].get("host_ip"))')" \
  "('127.0.0.1', '54323', 3000) 127.0.0.1"
ok "compose config (upstream + current override): studio unpublished" \
  "$(cfg "$O" | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)["services"]["studio"].get("ports",[])))')" "0"

echo "== part 2: Envoy"
cat > "$T/stub.mjs" <<'EOF'
import http from "node:http";
const name = process.env.NAME;
for (const port of process.env.PORTS.split(",").map(Number)) {
  http.createServer((req, res) => {
    console.log(`HIT ${name} ${port} ${req.method} ${req.url}`);
    const h = { "x-upstream-name": name, "x-upstream-port": String(port) };
    if (req.url.startsWith("/object/public/") || (req.method === "GET" && req.url.startsWith("/object/sign/") && req.url.includes("token="))) {
      res.writeHead(200, { ...h, "content-type": "image/jpeg" }); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    }
    if (req.method === "POST" && req.url.startsWith("/object/sign/")) {
      res.writeHead(200, { ...h, "content-type": "application/json" });
      return res.end(JSON.stringify({ signedURL: req.url.replace(/^\/object\/sign\//, "/object/sign/") + "?token=stub" }));
    }
    res.writeHead(200, { ...h, "content-type": "application/json" });
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
for v in u.iso.yaml s.iso.yaml final.yaml server.yaml; do
  ok "envoy --mode validate $v" "$(envrun "$T/$v" --rm -- --log-level error --mode validate >/dev/null 2>&1 && echo valid || echo invalid)" "valid"
done
envrun "$T/final.yaml" -d --name $P-gw-final -p 127.0.0.1::8000 -- --log-level warn >/dev/null
envrun "$T/server.yaml" -d --name $P-gw-server -p 127.0.0.1::8000 -- --log-level warn >/dev/null
url() { local u; u="http://$(docker port "$1" 8000/tcp | head -1)"; case "$u" in http://127.0.0.1:*) echo "$u";; *) echo "not loopback: $u" >&2; exit 2;; esac; }
F=$(url $P-gw-final); S=$(url $P-gw-server)
for u in "$F" "$S"; do for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$u/storage/v1/version" || true)" = 200 ] && break; sleep 1; done; done
printf 'SERVICE_ROLE_KEY=service-dummy\n' > "$T/env"
studio_hits() { docker logs "$STUDIO" 2>/dev/null | grep -c '^HIT studio' || true; }
before=$(studio_hits)
rc=0; SI_NO_DOCKER=1 SI_ENV_FILE="$T/env" SI_LDS_FOR_HEADERS="$T/final.yaml" \
  bash "$SI/studio-isolation.sh" verify --base "$F" --gateway-only --image-path product-images/org/o/temp/a.jpg >"$T/verify.final" 2>&1 || rc=$?
ok "studio-isolation.sh verify on the final template: exit 0" "$rc" "0"
ok "verify output: 0 failed" "$(grep -c '^FAIL' "$T/verify.final" || true)" "0"
ok "verify checked the header rule (nosniff + sandbox)" "$(grep -cE '^PASS  G5 header rule' "$T/verify.final")" "2"
ok "verify checked the signed URL" "$(grep -cE '^PASS  signed URL' "$T/verify.final")" "2"
ok "verify output carries no key" "$(grep -c 'service-dummy' "$T/verify.final" || true)" "0"
ok "Studio stub received no request through the final gateway" "$(studio_hits)" "$before"
rc=0; SI_NO_DOCKER=1 SI_ENV_FILE="$T/env" SI_LDS_FOR_HEADERS="$T/server.yaml" \
  bash "$SI/studio-isolation.sh" verify --base "$S" --gateway-only --image-path product-images/org/o/temp/a.jpg >"$T/verify.server" 2>&1 || rc=$?
ok "same verify on the server's current template FAILS (Studio still there)" "$rc|$(grep -c '^FAIL  GET / ' "$T/verify.server" || true)" "1|1"
ok "server template: API/header/signed checks still pass (only Studio lines fail)" \
  "$(grep '^FAIL' "$T/verify.server" | grep -vcE 'GET /|POST /api/platform|dot-dot' || true)" "0"

echo "== part 2: access log with x-client-info"
curl -s -o /dev/null -H 'x-client-info: shwephala-pos/1.0.16 (validated-uploads)' \
  -A 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) retails-shop/1.0.16 Chrome/138.0 Electron/37.10.3 Safari/537.36' "$F/storage/v1/version"
curl -s -o /dev/null "$F/storage/v1/version"
# Envoy flushes the stdout access log periodically; wait for the line
for _ in $(seq 1 20); do docker logs $P-gw-final 2>/dev/null | grep -q '"shwephala-pos/1.0.16' && break; sleep 1; done
ok "access log ends with the x-client-info field" "$(docker logs $P-gw-final 2>/dev/null | grep -c '"shwephala-pos/1.0.16 (validated-uploads)"$' || true)" "1"
ok "missing header logs \"-\"" "$(docker logs $P-gw-final 2>/dev/null | grep '"GET /storage/v1/version' | grep -c '"curl/[^"]*" "-"$' || true)" "$(docker logs $P-gw-final 2>/dev/null | grep '"GET /storage/v1/version' | grep -c '"curl/' || true)"
sed -n '/^cat >"\$WORK\/r.py" <</,/^PY$/p' "$LH/verify-till-readiness.sh" | sed '1d;$d' > "$T/r.py"
ok "verify-till-readiness reduce parses version + capability" \
  "$(docker logs $P-gw-final 2>/dev/null | python3 -I "$T/r.py" reduce | awk -F'\t' '$2=="desktop"{print $2"|"$3"|"$4}' | sort -u)" "desktop|1.0.16|yes"

echo
echo "studio-isolation-tool: $PASS passed, $FAIL failed ($ENVOY_IMAGE)"
[ "$FAIL" = 0 ]
