#!/usr/bin/env bash
# Hermetic tests for supabase/functions/* (email-sales-report, admin-2fa,
# phone-upload-token, phone-upload-page). The real function code runs under Deno with
# fetch replaced in-process (Resend + PostgREST + GoTrue mocks) — no database,
# no email provider, no server. See docs/selfhost-migration/phase-e/cron-email-audit.md §7.
#
# Deno: uses a local `deno` if present, else the official npm package via
# `npx --yes deno@latest` (first run downloads ~40 MB into the npm cache;
# `npm:@supabase/supabase-js@2` is fetched into Deno's global cache on the
# first run, after which the tests run offline).
#
# Permissions: --allow-env, and --allow-read limited to supabase/functions (the
# dynamic import of each index.ts). There is deliberately NO --allow-net, so
# any request that escaped the mocks would be refused by Deno itself.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FUNCTIONS="$(cd "$HERE/../../functions" && pwd)"
if command -v deno >/dev/null 2>&1; then DENO=(deno); else DENO=(npx --yes deno@latest); fi
cd "$HERE"
exec "${DENO[@]}" test --config "$HERE/deno.json" --allow-env --allow-read="$FUNCTIONS" --no-prompt "$@" "$HERE"
