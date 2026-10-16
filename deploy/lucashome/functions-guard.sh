#!/usr/bin/env bash
# shellcheck disable=SC2086,SC2048  # the fixed name lists are split into words on purpose (no glob characters)
# functions-guard.sh — single source of truth for which Supabase Edge Functions may be
# deployed to lucashome (G0-2, 2026-10-16). Read-only, no network, fail closed.
#
#   functions-guard.sh list-approved
#   functions-guard.sh list-retired
#   functions-guard.sh check-names NAME...     every NAME must be an approved function
#   functions-guard.sh check-source [DIR]      repo source tree (default: <repo>/supabase/functions)
#   functions-guard.sh check-deployed DIR      server functions volume (DIR or env FUNCTIONS_DIR is
#                                              required; no built-in server path)
#
# Exit codes (worst finding wins):
#   0 ok
#   2 usage error or missing directory
#   3 a RETIRED function was named or is present  (security regression)
#   4 an unknown / unapproved entry, an invalid name or a symlink
#   5 an approved function is missing from a full tree
#
# Used by sync-functions.sh before any copy. On the server (read-only), e.g. after a
# restore and BEFORE the stack is started or made reachable:
#   ssh <server> 'bash -s' -- check-deployed <functions-dir> < deploy/lucashome/functions-guard.sh
# Runs on macOS bash 3.2 and Linux bash 5.
#
# Changing either list needs an owner decision. Never move a retired name to the approved
# list; a reviewed replacement gets a new name.
set -euo pipefail

APPROVED_FUNCTIONS="admin-2fa email-sales-report phone-upload-page phone-upload-token staff-admin"
# platform-console: removed from lucashome 2026-10-16 (G0-1), source archived (G0-2).
# rotate-audit-log, weekly-sales-report: removed 2026-10-13; owner rule: not re-enabled.
RETIRED_FUNCTIONS="platform-console rotate-audit-log weekly-sales-report"
# Entries the server volume may hold besides approved functions (upstream router + config).
SERVER_INFRA_DIRS="main"
SERVER_INFRA_FILES="deno.jsonc"
EVIDENCE="docs/selfhost-migration/evidence/G0-2/2026-10-16-platform-console-deployment-protection.md"
ARCHIVE="archive/deprecated-edge-functions/"

RC=0
worst() { # keep the most severe exit code: 3 > 4 > 5 > 2 > 0
  local new=$1
  case "$RC:$new" in
    3:*) ;;
    *:3) RC=3 ;;
    4:*) ;;
    *:4) RC=4 ;;
    5:*) ;;
    *:5) RC=5 ;;
    *) [ "$RC" -eq 0 ] && RC=$new ;;
  esac
  return 0
}
in_list() { local w=$1 x; shift; for x in $*; do [ "$x" = "$w" ] && return 0; done; return 1; }

refuse_retired() {
  echo "REFUSED: '$1' is a RETIRED Edge Function and must not be deployed or active. $2" >&2
  echo "         Retired source lives in $ARCHIVE (not deployable). See $EVIDENCE." >&2
  worst 3
}
refuse_unknown() { echo "REFUSED: $1" >&2; worst 4; }

check_names() {
  [ "$#" -gt 0 ] || { echo "usage: functions-guard.sh check-names NAME..." >&2; exit 2; }
  local n lower
  for n in "$@"; do
    lower=$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')
    if ! printf '%s' "$n" | grep -Eq '^[a-z0-9][a-z0-9-]*$'; then
      # Path tricks or case variants of a retired name are still a retired-name attempt.
      local base; base=$(printf '%s' "$lower" | sed -e 's#/*$##' -e 's#.*/##')
      if in_list "$base" "$RETIRED_FUNCTIONS"; then refuse_retired "$n" "(name variant)"
      else refuse_unknown "'$n' is not a valid function name (lowercase letters, digits, '-')"; fi
      continue
    fi
    if in_list "$n" "$RETIRED_FUNCTIONS"; then refuse_retired "$n" ""
    elif in_list "$n" "$APPROVED_FUNCTIONS"; then echo "approved: $n"
    else refuse_unknown "'$n' is not on the approved list ($APPROVED_FUNCTIONS)"; fi
  done
}

# check_tree DIR MODE   MODE = source | deployed
check_tree() {
  local dir=$1 mode=$2 path name lower
  [ -d "$dir" ] || { echo "REFUSED: directory not found: $dir" >&2; exit 2; }
  for path in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$path" ] || [ -L "$path" ] || continue
    name=${path##*/}
    lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
    [ "$name" = ".DS_Store" ] && continue
    if in_list "$lower" "$RETIRED_FUNCTIONS"; then
      refuse_retired "$name" "Found in $mode tree: $path"
      continue
    fi
    if [ -L "$path" ]; then refuse_unknown "symlink not allowed in the $mode tree: $path"; continue; fi
    if [ -d "$path" ]; then
      if in_list "$name" "$APPROVED_FUNCTIONS"; then continue; fi
      if [ "$mode" = deployed ] && in_list "$name" "$SERVER_INFRA_DIRS"; then continue; fi
      refuse_unknown "unapproved directory in the $mode tree: $path"
    else
      if [ "$mode" = deployed ] && in_list "$name" "$SERVER_INFRA_FILES"; then continue; fi
      refuse_unknown "unexpected file in the $mode tree: $path"
    fi
  done
  local a
  for a in $APPROVED_FUNCTIONS; do
    [ -d "$dir/$a" ] || { echo "MISSING: approved function '$a' not found in $dir" >&2; worst 5; }
  done
}

default_source_dir() {
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd) || here=""
  [ -n "$here" ] && [ -d "$here/../../supabase/functions" ] || { echo "REFUSED: cannot locate supabase/functions; pass DIR" >&2; exit 2; }
  (cd "$here/../../supabase/functions" && pwd)
}

finish() {
  if [ "$RC" -eq 0 ]; then echo "functions-guard: OK"; else echo "functions-guard: REFUSED (exit $RC)" >&2; fi
  exit "$RC"
}

cmd=${1:-}
[ "$#" -gt 0 ] && shift
case "$cmd" in
  list-approved)  printf '%s\n' $APPROVED_FUNCTIONS ;;
  list-retired)   printf '%s\n' $RETIRED_FUNCTIONS ;;
  check-names)    check_names "$@"; finish ;;
  check-source)   check_tree "${1:-$(default_source_dir)}" source; finish ;;
  check-deployed)
    [ -n "${1:-${FUNCTIONS_DIR:-}}" ] || { echo "usage: functions-guard.sh check-deployed DIR (or set FUNCTIONS_DIR)" >&2; exit 2; }
    check_tree "${1:-$FUNCTIONS_DIR}" deployed; finish ;;
  *) sed -n '3,25p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' >&2 || true; exit 2 ;;
esac
