#!/usr/bin/env bash
# sync-functions.sh — the supported way to copy Edge Function source from this repo to
# lucashome (G0-2, 2026-10-16). Every copy goes through functions-guard.sh first.
#
#   deploy/lucashome/sync-functions.sh [--print] NAME...    one or more approved functions
#   deploy/lucashome/sync-functions.sh [--print] --all      every approved function
#
# Before ANY copy (all-or-nothing):
#   1. functions-guard.sh must exist next to this script        -> else exit 2, nothing copied
#   2. canary: the guard must refuse a retired name (exit 3)     -> else exit 2 (guard broken)
#   3. guard check-names on the targets                         -> retired 3 / unknown 4
#   4. guard check-source on supabase/functions                 -> a retired function or an
#      unapproved directory in the source tree refuses even a single approved deploy
# Then one rsync per approved directory, from an explicit name list (never a directory glob),
# so archive/ and anything unapproved can never be included.
# It never restarts containers. Afterwards, separately (see deploy/lucashome/README.md):
# restart functions, functions-router.sh verify, functions-guard.sh check-deployed.
#
# --print   show the rsync commands, run nothing
# Env: REMOTE_FUNCTIONS_DIR (required: the server's functions volume; see the private ops record),
#      LUCASHOME_HOST (default lucashome, the SSH alias), RSYNC (default rsync)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
GUARD="$HERE/functions-guard.sh"
SRC="$REPO/supabase/functions"
HOST="${LUCASHOME_HOST:-lucashome}"
REMOTE="${REMOTE_FUNCTIONS_DIR:-}"
RSYNC="${RSYNC:-rsync}"

refuse() { echo "REFUSED: $1 — nothing was copied." >&2; exit "$2"; }

PRINT=0; ALL=0; NAMES=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) PRINT=1 ;;
    --all)   ALL=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) refuse "unknown option $1" 2 ;;
    *) NAMES+=("$1") ;;
  esac
  shift
done
if [ "$ALL" -eq 1 ] && [ "${#NAMES[@]}" -gt 0 ]; then refuse "use either --all or names, not both" 2; fi
if [ "$ALL" -eq 0 ] && [ "${#NAMES[@]}" -eq 0 ]; then refuse "no function named (use NAME... or --all)" 2; fi

[ -n "$REMOTE" ] || refuse "REMOTE_FUNCTIONS_DIR is not set (the server functions volume)" 2

# 1. guard present
[ -f "$GUARD" ] && [ -r "$GUARD" ] || refuse "deployment guard missing ($GUARD)" 2

# 2. canary: a guard that does not refuse a retired name is broken or neutered
set +e
bash "$GUARD" check-names platform-console >/dev/null 2>&1
canary=$?
set -e
[ "$canary" -eq 3 ] || refuse "deployment guard failed its self-test (expected exit 3 for a retired name, got $canary)" 2

# 3. target names
if [ "$ALL" -eq 1 ]; then
  TARGETS=()
  while IFS= read -r n; do [ -n "$n" ] && TARGETS+=("$n"); done < <(bash "$GUARD" list-approved)
  [ "${#TARGETS[@]}" -gt 0 ] || refuse "guard returned an empty approved list" 2
else
  TARGETS=("${NAMES[@]}")
fi
set +e
bash "$GUARD" check-names "${TARGETS[@]}"
rc=$?
set -e
[ "$rc" -eq 0 ] || refuse "guard check-names failed (exit $rc)" "$rc"

# 4. the whole source tree must be clean, even for a single-function deploy
set +e
bash "$GUARD" check-source "$SRC"
rc=$?
set -e
[ "$rc" -eq 0 ] || refuse "guard check-source failed for $SRC (exit $rc)" "$rc"

for n in "${TARGETS[@]}"; do
  cmd=("$RSYNC" -a --delete --exclude .DS_Store "$SRC/$n/" "$HOST:$REMOTE/$n/")
  if [ "$PRINT" -eq 1 ]; then printf '%q ' "${cmd[@]}"; echo
  else echo "sync $n"; "${cmd[@]}"; fi
done
if [ "$PRINT" -eq 1 ]; then echo "would sync: ${TARGETS[*]} (--print: nothing was run)"
else echo "synced: ${TARGETS[*]}"; fi
echo "next (separately, see deploy/lucashome/README.md): restart functions; functions-router.sh verify; functions-guard.sh check-deployed"
