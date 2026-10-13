#!/usr/bin/env bash
# Local check of the OPTIONAL Envoy layer (docs/selfhost-migration/phase-f/rate-limiting.md §7).
# The snippet itself is deployment-specific and not part of this repository:
# point ENVOY_SNIPPET at it (two blocks: a "- name: envoy.filters.http.local_ratelimit"
# filter entry, a blank line, then a "- name: functions-v1-phone-upload-token" route).
# Without ENVOY_SNIPPET the check is skipped (exit 0).
# embeds the snippet's two blocks verbatim in a minimal bootstrap (build.py),
# validates it with the same Envoy version as the stack (--mode validate), then
# runs it in front of a dummy upstream and fires concurrent requests.
# Containers phf-rl-envoy / phf-rl-up on network phf-rl-envnet, removed on exit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${ENVOY_SNIPPET:-}" ]; then echo "SKIP: ENVOY_SNIPPET is not set (path to the Envoy rate-limit snippet)"; exit 0; fi
[ -f "$ENVOY_SNIPPET" ] || { echo "ENVOY_SNIPPET not found: $ENVOY_SNIPPET"; exit 2; }
IMAGE=envoyproxy/envoy:v1.39.1
W="$(mktemp -d)"
cleanup() { docker rm -f phf-rl-envoy phf-rl-up >/dev/null 2>&1 || true; docker network rm phf-rl-envnet >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT
python3 "$HERE/build.py" "$ENVOY_SNIPPET" "$W/envoy.yaml"
docker run --rm -v "$W/envoy.yaml:/etc/envoy/envoy.yaml:ro" "$IMAGE" --mode validate -c /etc/envoy/envoy.yaml 2>&1 | tail -1
docker network create phf-rl-envnet >/dev/null
docker run -d --name phf-rl-up --network phf-rl-envnet -v "$HERE/up.mjs:/up.mjs:ro" node:24-slim node /up.mjs >/dev/null
docker run -d --name phf-rl-envoy --network phf-rl-envnet -p 127.0.0.1::8000 -v "$W/envoy.yaml:/etc/envoy/envoy.yaml:ro" "$IMAGE" -c /etc/envoy/envoy.yaml >/dev/null
U="http://$(docker port phf-rl-envoy 8000/tcp | head -1)"
for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$U/functions/v1/x" || true)" = "200" ] && break; sleep 1; done
echo "route rewrite: $(curl -s -X POST "$U/functions/v1/phone-upload-token")"
sleep 3   # let the bucket refill to its 20-token burst
for i in $(seq 1 40); do curl -s -o /dev/null -D "$W/h$i" -w '%{http_code}\n' -X POST "$U/functions/v1/phone-upload-token" > "$W/s$i" & done; wait
echo "phone-upload-token, 40 concurrent: $(cat "$W"/s* | sort | uniq -c | tr -s ' ' | tr '\n' ' ')"
echo "Retry-After on the 429s: $(grep -ih '^retry-after' "$W"/h* | tr -d '\r' | sort | uniq -c | tr -s ' ' | tr '\n' ' ')"
for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code}\n' -X POST "$U/functions/v1/other-fn" > "$W/o$i" & done; wait
echo "another function, 40 concurrent: $(cat "$W"/o* | sort | uniq -c | tr -s ' ' | tr '\n' ' ')"
sleep 2
echo "phone-upload-token after a 2 s refill: $(curl -s -o /dev/null -w '%{http_code}' -X POST "$U/functions/v1/phone-upload-token")"
