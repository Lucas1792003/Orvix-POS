#!/usr/bin/env bash
# Legacy-client classification harness for 087 (read-only on the repo): copies this directory's own files (harness, extracted
# decision code with citations, marked stubs) to a temp dir, adds the VERBATIM legacy source files from git objects at each
# frozen ref (never modified, never written into the repo), and runs every client generation's real error handling, behind the
# real @supabase/postgrest-js, against captured HTTP responses.
#   tools/m087-verify/legacy/run-harness.sh FIXTURES.json OUT.txt
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp -R "$HERE/." "$T/"
v() { mkdir -p "$T/$1/$(dirname "$3")"; git -C "$ROOT" show "$2:$3" > "$T/$1/$3"; }
v V1015 v1.0.15 src/lib/errors.ts
for f in src/lib/errors.ts src/stores/data/idempotentRpc.ts; do v RC3 a722aa3 $f; done
for f in src/lib/errors.ts src/lib/failureClass.ts src/lib/retryAfter.ts src/stores/data/idempotentRpc.ts; do v BATCH2A ae51e69 $f; done
for f in src/lib/errors.ts src/lib/executorRpcs.ts src/lib/failureClass.ts src/lib/retryAfter.ts src/stores/data/idempotentRpc.ts; do v PHASE0 93ad308 $f; done
ORVIX_REPO="$ROOT" "$ROOT/node_modules/.bin/tsx" "$T/classify-harness.mjs" "$1" > "$2" 2>&1
