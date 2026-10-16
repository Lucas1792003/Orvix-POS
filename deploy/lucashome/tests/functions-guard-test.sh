#!/usr/bin/env bash
# shellcheck disable=SC2015  # `cond && ok || nok`: ok() always returns 0
# functions-guard-test.sh — local tests for G0-2 deployment protection:
#   deploy/lucashome/functions-guard.sh, deploy/lucashome/sync-functions.sh and the
#   retired-function check in deploy/lucashome/functions-router.sh.
# Workstation only (bash 3.2-safe). Touches no server: every sync runs in a throwaway copy
# of the scripts with RSYNC pointed at a fake that only records its arguments; router
# checks run against temporary FUNCTIONS_DIRs and an unroutable URL.
#
#   deploy/lucashome/tests/functions-guard-test.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
GUARD_SRC="$REPO/deploy/lucashome/functions-guard.sh"
SYNC_SRC="$REPO/deploy/lucashome/sync-functions.sh"
ROUTER_SRC="$REPO/deploy/lucashome/functions-router.sh"
APPROVED="admin-2fa email-sales-report phone-upload-page phone-upload-token staff-admin"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok    $*"; }
nok() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1 (got [$2], want [$3])"; fi; }

# --- fixtures -----------------------------------------------------------------
# fake rsync: records one line per call, never copies anything
cat > "$T/fake-rsync" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_RSYNC_LOG:?}"
EOF
chmod +x "$T/fake-rsync"

# mkrepo NAME: a throwaway repo with the real scripts and the approved function dirs
mkrepo() {
  local r="$T/$1" f
  rm -rf "$r"; mkdir -p "$r/deploy/lucashome" "$r/supabase/functions" "$r/archive/deprecated-edge-functions/platform-console"
  cp "$GUARD_SRC" "$SYNC_SRC" "$r/deploy/lucashome/"
  for f in $APPROVED; do mkdir -p "$r/supabase/functions/$f"; echo "// $f" > "$r/supabase/functions/$f/index.ts"; done
  echo "// archived" > "$r/archive/deprecated-edge-functions/platform-console/index.ts"
  echo "$r"
}
# runsync REPO ARGS...: runs the copied sync script with the fake rsync; sets RC, LOGLINES
runsync() {
  local r=$1; shift
  : > "$T/rsync.log"
  set +e
  FAKE_RSYNC_LOG="$T/rsync.log" RSYNC="$T/fake-rsync" LUCASHOME_HOST=test-host REMOTE_FUNCTIONS_DIR=/remote/fn \
    bash "$r/deploy/lucashome/sync-functions.sh" "$@" > "$T/out" 2> "$T/err"
  RC=$?
  set -e
  LOGLINES=$(wc -l < "$T/rsync.log" | tr -d ' ')
}
guard() { set +e; bash "$GUARD_SRC" "$@" > "$T/gout" 2> "$T/gerr"; RC=$?; set -e; }

echo "== security regression"
guard check-names platform-console
check "S1 check-names platform-console -> exit 3" "$RC" 3
grep -q "REFUSED: 'platform-console' is a RETIRED Edge Function" "$T/gerr" && ok "S1 clear error message" || nok "S1 error message: $(cat "$T/gerr")"

R=$(mkrepo r1)
runsync "$R" platform-console
check "S2 sync platform-console -> exit 3" "$RC" 3
check "S2 rsync never called" "$LOGLINES" 0
grep -q "nothing was copied" "$T/err" && ok "S2 says nothing was copied" || nok "S2 message"

for v in "platform-console/" "../platform-console" "PLATFORM-CONSOLE" "supabase/functions/platform-console"; do
  runsync "$R" "$v"
  check "S3 sync name variant [$v] -> exit 3" "$RC" 3
  check "S3 rsync never called for [$v]" "$LOGLINES" 0
done
runsync "$R" staff-admin platform-console
check "S3 mixed list (approved + retired) -> exit 3, all-or-nothing" "$RC" 3
check "S3 mixed list: rsync never called (no partial copy)" "$LOGLINES" 0
for v in rotate-audit-log weekly-sales-report; do
  runsync "$R" "$v"; check "S3 other retired name [$v] -> exit 3" "$RC" 3
done

R=$(mkrepo r2); mkdir -p "$R/supabase/functions/platform-console"; echo "// back" > "$R/supabase/functions/platform-console/index.ts"
guard check-source "$R/supabase/functions"
check "S4 reintroduced supabase/functions/platform-console -> check-source exit 3" "$RC" 3
runsync "$R" staff-admin
check "S4 even a single approved deploy is refused while it is present" "$RC" 3
check "S4 rsync never called" "$LOGLINES" 0
runsync "$R" --all
check "S4 --all refused while it is present" "$RC" 3
check "S4 --all rsync never called" "$LOGLINES" 0

R=$(mkrepo r3)
runsync "$R" --all
check "S5 --all on a clean tree -> exit 0" "$RC" 0
check "S5 --all calls rsync once per approved function" "$LOGLINES" 5
grep -q "platform-console" "$T/rsync.log" && nok "S5 full sync mentions platform-console" || ok "S5 full sync never includes platform-console"
grep -q "archive" "$T/rsync.log" && nok "S5 full sync includes archive/" || ok "S5 archived functions excluded from deployment"

R=$(mkrepo r4); mkdir -p "$R/supabase/functions/console2"; cp "$R/archive/deprecated-edge-functions/platform-console/index.ts" "$R/supabase/functions/console2/"
guard check-source "$R/supabase/functions"
check "S6 renamed copy (unapproved dir console2) -> exit 4" "$RC" 4
runsync "$R" --all; check "S6 --all refused" "$RC" 4; check "S6 rsync never called" "$LOGLINES" 0
mkdir -p "$R/supabase/functions/Platform-Console"; rm -rf "$R/supabase/functions/console2"
guard check-source "$R/supabase/functions"; check "S6 case variant directory Platform-Console -> exit 3" "$RC" 3

R=$(mkrepo r5); rm -rf "$R/supabase/functions/staff-admin"; ln -s "$R/archive/deprecated-edge-functions/platform-console" "$R/supabase/functions/staff-admin"
guard check-source "$R/supabase/functions"
check "S7 symlink in the source tree -> exit 4" "$RC" 4
runsync "$R" staff-admin; check "S7 sync refused" "$RC" 4; check "S7 rsync never called" "$LOGLINES" 0

S="$T/server"; mkdir -p "$S/main"; echo '{}' > "$S/deno.jsonc"
for f in $APPROVED; do mkdir -p "$S/$f"; done
guard check-deployed "$S"
check "S8/C3 restored volume, clean (main + deno.jsonc + approved) -> exit 0" "$RC" 0
mkdir -p "$S/platform-console"
guard check-deployed "$S"
check "S8 restore containing platform-console detected -> exit 3" "$RC" 3
rm -rf "$S/platform-console"; mkdir -p "$S/hello"
guard check-deployed "$S"; check "S8 unexpected upstream 'hello' dir -> exit 4" "$RC" 4
rm -rf "$S/hello" "$S/staff-admin"
guard check-deployed "$S"; check "S8 approved function missing after restore -> exit 5" "$RC" 5
mkdir -p "$S/staff-admin"
guard check-deployed "$T/does-not-exist"; check "S8 missing directory -> exit 2" "$RC" 2
guard check-deployed; check "S8 no directory given (no built-in server path) -> exit 2" "$RC" 2
R=$(mkrepo r10); : > "$T/rsync.log"; set +e; FAKE_RSYNC_LOG="$T/rsync.log" RSYNC="$T/fake-rsync" REMOTE_FUNCTIONS_DIR='' bash "$R/deploy/lucashome/sync-functions.sh" staff-admin >/dev/null 2>&1; RC=$?; set -e
check "S9 REMOTE_FUNCTIONS_DIR unset -> exit 2" "$RC" 2; check "S9 REMOTE_FUNCTIONS_DIR unset: rsync never called" "$(wc -l < "$T/rsync.log" | tr -d " ")" 0

R=$(mkrepo r6); rm "$R/deploy/lucashome/functions-guard.sh"
runsync "$R" staff-admin
check "S9 guard missing -> exit 2" "$RC" 2
check "S9 guard missing: rsync never called" "$LOGLINES" 0
R=$(mkrepo r7); printf '#!/usr/bin/env bash\nexit 0\n' > "$R/deploy/lucashome/functions-guard.sh"
runsync "$R" staff-admin
check "S10 neutered guard (always exit 0) -> refused by canary, exit 2" "$RC" 2
check "S10 neutered guard: rsync never called" "$LOGLINES" 0
R=$(mkrepo r8); printf '#!/usr/bin/env bash\nif [ \n' > "$R/deploy/lucashome/functions-guard.sh"
runsync "$R" staff-admin
check "S10 broken guard (syntax error) -> exit 2" "$RC" 2
check "S10 broken guard: rsync never called" "$LOGLINES" 0

# router: retired-function check (no network: status is file-only; verify fails before curl)
F="$T/rfd"; mkdir -p "$F/main" "$F/staff-admin" "$F/platform-console"
set +e
FUNCTIONS_DIR="$F" bash "$ROUTER_SRC" status > "$T/rout" 2> "$T/rerr"; RC=$?
set -e
check "S11 router status with platform-console present -> nonzero" "$([ "$RC" -ne 0 ] && echo nonzero || echo zero)" nonzero
grep -q "RETIRED FUNCTION PRESENT" "$T/rerr" && ok "S11 router status names the retired function" || nok "S11 router message"
set +e
FUNCTIONS_DIR="$F" FUNCTIONS_URL="http://127.0.0.1:9/functions/v1" bash "$ROUTER_SRC" verify > "$T/rout" 2> "$T/rerr"; RC=$?
set -e
check "S11 router verify refuses before any request -> nonzero" "$([ "$RC" -ne 0 ] && echo nonzero || echo zero)" nonzero
grep -q "refusing to verify" "$T/rerr" && ok "S11 router verify refusal message" || nok "S11 router verify message: $(cat "$T/rerr")"
set +e
FUNCTIONS_DIR="$T/none" FUNCTION_NAMES="staff-admin platform-console" FUNCTIONS_URL="http://127.0.0.1:9/functions/v1" bash "$ROUTER_SRC" verify > "$T/rout" 2> "$T/rerr"; RC=$?
set -e
check "S11 router verify refuses an explicitly named retired function" "$([ "$RC" -ne 0 ] && echo nonzero || echo zero)" nonzero

GL=$(sed -n 's/^RETIRED_FUNCTIONS="\(.*\)"$/\1/p' "$GUARD_SRC")
RL=$(sed -n 's/^RETIRED_FUNCTIONS="\(.*\)"$/\1/p' "$ROUTER_SRC")
check "S12 router RETIRED_FUNCTIONS equals guard RETIRED_FUNCTIONS" "$RL" "$GL"
case " $GL " in *" platform-console "*) ok "S12 platform-console is on the retired list" ;; *) nok "S12 platform-console not retired" ;; esac
AL=$(sed -n 's/^APPROVED_FUNCTIONS="\(.*\)"$/\1/p' "$GUARD_SRC")
case " $AL " in *" platform-console "*) nok "S12 platform-console on the approved list" ;; *) ok "S12 platform-console not approved" ;; esac

echo "== compatibility"
for f in $APPROVED; do
  guard check-names "$f"; check "C1 $f permitted by check-names" "$RC" 0
done
R=$(mkrepo r9)
for f in $APPROVED; do
  runsync "$R" "$f"
  check "C2 sync $f -> exit 0" "$RC" 0
  check "C2 sync $f -> exactly one rsync" "$LOGLINES" 1
  check "C2 sync $f -> exact rsync arguments" "$(cat "$T/rsync.log")" "-a --delete --exclude .DS_Store $R/supabase/functions/$f/ test-host:/remote/fn/$f/"
done
runsync "$R" --print --all
check "C2 --print -> exit 0" "$RC" 0
check "C2 --print runs nothing" "$LOGLINES" 0
grep -q "main" "$T/out" && nok "C2 router main is never synced from the repo" || ok "C2 router main untouched by sync (upstream-managed; allowed by check-deployed)"
guard check-source
check "C4 real repo supabase/functions passes check-source" "$RC" 0
check "C5 real repo supabase/functions holds exactly the approved functions" \
  "$(cd "$REPO/supabase/functions" && find . -mindepth 1 -maxdepth 1 -type d | sed 's#./##' | sort | tr '\n' ' ' | sed 's/ $//')" "$APPROVED"
[ -f "$REPO/archive/deprecated-edge-functions/platform-console/index.ts" ] && ok "C6 archived source present" || nok "C6 archived source missing"
[ -e "$REPO/supabase/functions/platform-console" ] && nok "C6 platform-console still in supabase/functions" || ok "C6 platform-console absent from supabase/functions"
guard nonsense; check "C7 unknown guard command -> exit 2" "$RC" 2

echo
echo "functions-guard-test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
