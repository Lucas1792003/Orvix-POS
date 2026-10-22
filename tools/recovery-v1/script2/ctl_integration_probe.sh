#!/usr/bin/env bash
# Recovery Script 2: POS <-> Control integration probe (static, DB-free, network-free).
# Read-only over both trees. Prints one line per check: <id> PASS|FAIL <detail>.
#   ctl_integration_probe.sh [POS_ROOT] [CONTROL_ROOT]
set -uo pipefail
POS="${1:-$(cd "$(dirname "$0")/../../.." && pwd)}"
CTL="${2:-/Users/waiyan/Projects/personal/Orvix/worktrees/control-script2}"
fails=0
ok()  { echo "$1 PASS $2"; }
bad() { echo "$1 FAIL $2"; fails=$((fails+1)); }
has() { grep -rqE "$1" "${@:2}" 2>/dev/null; }

# I-1 POS hooks 100-102 do not exist (no file, no platform_hooks objects anywhere in POS SQL)
if ls "$POS"/supabase/migrations/10[0-2]_*.sql >/dev/null 2>&1; then bad I-1 "POS 100-102 migration file present"
elif has 'platform_hooks|platform_org_(list|metadata)|platform_set_org_status|app_pre_request' "$POS/supabase"; then bad I-1 "platform hook objects referenced in POS SQL"
else ok I-1 "no POS hook 100-102 files or platform_hooks objects (NOT IMPLEMENTED, as documented)"; fi

# I-2 Control has no path to POS recovery release (087 recovery.* / Recovery V1 unfence)
if has 'recovery_v1|request_unfence|fence_key|recovery\.(continuity|release|open)|orvix_recovery_operator' "$CTL/db" "$CTL/src" "$CTL/app" "$CTL/scripts"; then
  bad I-2 "Control references POS recovery objects"
else ok I-2 "Control code/migrations never reference recovery_v1 / 087 recovery objects / orvix_recovery_operator"; fi

# I-3 Control tenant data is synthetic only (no POS tenant table reference outside the dev fixture)
if has '(public|shwephala)\.(sales|sale_items|organizations|shifts|inventory|users)\b' "$CTL/db/migrations" "$CTL/src" "$CTL/app"; then
  bad I-3 "Control migrations/app reference POS public tables"
else ok I-3 "Control migrations/app reference no POS public.* tables (pos_mock fixture only)"; fi

# I-4 Control holds no Supabase client / service-role path
if has '@supabase/|createClient\(' "$CTL/src" "$CTL/app" "$CTL/scripts" || grep -q '"@supabase/' "$CTL/package.json"; then
  bad I-4 "Supabase client in Control"
else ok I-4 "no @supabase client in Control package.json/src/app/scripts"; fi

# I-5 Owner-key formats are disjoint: POS Recovery V1 owner key = RSA {n,e}; Control = ES256 WebAuthn passkeys
if grep -q 'recovery_v1_owner_public_key=.*"n":' "$POS/supabase/migrations-provisional/RECOVERY_V1_guards.sql" && has 'ES256' "$CTL/db/migrations/205_auth_trust_boundary.sql" \
   && ! grep -rhE 'rsa|RSASSA|PS256|RS256' "$CTL/db/migrations" | grep -qvE '^\s*--'; then
  ok I-5 "POS V1 owner key is offline RSA; Control 205 verifies ES256 passkeys only; no shared owner-statement format"
else bad I-5 "owner-key formats changed; re-review"; fi

# I-6 POS retired the platform-console server function, but the client route/store remain (req. section 6.6)
if [ -d "$POS/supabase/functions/platform-console" ]; then bad I-6 "platform-console function still deployable"
elif has 'path="/console' "$POS/src/app/routes/AppRouter.tsx"; then
  bad I-6 "server function retired, but /console + /console/login routes and platformAuthStore still in POS client (G-PC-1 open)"
else ok I-6 "platform console fully removed"; fi

# I-7 POS client classifies ORG_SUSPENDED / PT503 and the 087 recovery hold as holds (not conflicts)
if grep -q 'code === "PT503"' "$POS/src/lib/failureClass.ts" && grep -q 'RECOVERY_MESSAGE_PREFIX' "$POS/src/lib/failureClass.ts"; then
  ok I-7 "failureClass maps PT503/ORG_SUSPENDED and PT429 recovery prefix to hold classes"
else bad I-7 "suspension/recovery classification missing"; fi

echo "probe: $fails failing check(s)"
exit $(( fails > 0 ))
