#!/usr/bin/env bash
# functions-router.sh — keep the ShwePhaLa allow-list in the self-hosted
# edge-functions router (volumes/functions/main/index.ts) reproducible and
# upgrade-safe.
#
# The upstream router enforces VERIFY_JWT on every non-OPTIONS request. A phone
# opening the QR page is a browser navigation and cannot send Authorization, so
# functions-main-public-page.patch (next to this script) lets GET/HEAD to exactly
# /phone-upload-page through; every other function and method keeps the gate.
# Design and the choice of "patch the upstream file + pin both hashes" over
# "mount a full copy": docs/selfhost-migration/phase-f/phone-qr-origin.md §6.
#
#   status   read-only: upstream / patched / unknown (by sha256) + marker; exit 1 on unknown
#   apply    idempotent: patched -> no-op; upstream -> backup, dry-run, patch, verify sha;
#            unknown -> refuse (re-derive the patch for the new upstream file)
#   revert   patched -> restore the newest upstream backup, verify the upstream sha
#   verify   HTTP probes through the gateway (no data written, no secrets printed)
#
# apply/revert change only main/index.ts (+ a backup next to it). The router is
# loaded when the functions container starts:
#   cd /srv/supabase/stack && docker compose restart functions
# then run `verify`.
#
# Environment:
#   FUNCTIONS_DIR      default /srv/supabase/stack/volumes/functions
#   PATCH_FILE         default <dir of this script>/functions-main-public-page.patch
#   FUNCTIONS_URL      verify: default http://127.0.0.1:8000/functions/v1 (loopback gateway)
#   FUNCTION_NAMES     verify: space-separated names; default = the directories in
#                      FUNCTIONS_DIR except main/ (enumerated at run time)
#   SUPABASE_ANON_KEY  verify, optional: also check that phone-upload-token answers a
#                      bad token with its generic 404 (key passed to curl via stdin)
#
# Usage on lucashome (or from the Mac without copying anything):
#   ssh lucashome 'bash -s' -- status < deploy/lucashome/functions-router.sh
set -euo pipefail

# --- pinned facts (re-derive both when upstream changes main/index.ts) --------
# upstream supabase/supabase self-hosted/v0.8.2 (commit 564eab8ad7840b13324f68b1bfac074ef8d51c21),
# docker/volumes/functions/main/index.ts
UPSTREAM_REF="self-hosted/v0.8.2"
UPSTREAM_SHA=9b7978abd7fd4af39e4f407f8a956137aa99e6ffaeb2190a5e29c8e1787d2da6
# the same file after functions-main-public-page.patch
PATCHED_SHA=d2901ffa9711a82117b0edde7b98cbd999ea5d61fa4536c74b307bb37cd111bc
MARKER="const PUBLIC_PAGE_FUNCTIONS = new Set(['phone-upload-page'])"
PUBLIC_PAGES=(phone-upload-page)
BACKUP_PREFIX="index.ts.pre-phone-page"

FUNCTIONS_DIR="${FUNCTIONS_DIR:-/srv/supabase/stack/volumes/functions}"
ROUTER="$FUNCTIONS_DIR/main/index.ts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || SCRIPT_DIR="$PWD"
PATCH_FILE="${PATCH_FILE:-$SCRIPT_DIR/functions-main-public-page.patch}"
FUNCTIONS_URL="${FUNCTIONS_URL:-http://127.0.0.1:8000/functions/v1}"
FUNCTIONS_URL="${FUNCTIONS_URL%/}"

CLEANUP=()
cleanup() { if (( ${#CLEANUP[@]} )); then rm -rf "${CLEANUP[@]}"; fi; return 0; }
trap cleanup EXIT
die() { echo "ERROR: $*" >&2; exit 1; }
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
utc_stamp() { date -u +%Y%m%dT%H%M%SZ; }

# state_of FILE -> upstream | patched | unknown | missing
state_of() {
  [[ -f "$1" ]] || { echo missing; return; }
  case "$(sha_of "$1")" in
    "$UPSTREAM_SHA") echo upstream ;;
    "$PATCHED_SHA") echo patched ;;
    *) echo unknown ;;
  esac
}

# newest backup whose content is the pinned upstream file (empty if none)
upstream_backup() {
  local f best="" best_m=0 m
  shopt -s nullglob
  for f in "$FUNCTIONS_DIR/main/$BACKUP_PREFIX"*; do
    [[ "$(sha_of "$f")" == "$UPSTREAM_SHA" ]] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")
    if [[ -z "$best" || "$m" -ge "$best_m" ]]; then best="$f"; best_m="$m"; fi
  done
  shopt -u nullglob
  echo "$best"
}

rederive_help() {
  cat >&2 <<EOF
The router is neither the pinned upstream file ($UPSTREAM_REF) nor its patched
form. Most likely an upstream upgrade replaced or 3-way merged main/index.ts
(update.sh merges this file). Nothing was changed. To re-derive:
  1. Get the NEW pristine upstream file:
       git -C /srv/supabase/upstream show <new-tag>:docker/volumes/functions/main/index.ts
     (if the current file has conflict markers or a merged allow-list, start from that, not from it).
  2. Re-apply the two hunks of functions-main-public-page.patch by hand (the
     PUBLIC_PAGE_FUNCTIONS allow-list + "&& !isPublicPageRequest(req)" on the
     VERIFY_JWT condition), regenerate the patch with diff -u, and update
     UPSTREAM_REF / UPSTREAM_SHA / PATCHED_SHA in this script.
  3. Run deploy/lucashome/tests/functions-router-test.sh against the new upstream
     file (UPSTREAM_ROUTER=...), commit, then status -> apply -> restart -> verify.
Until then the phone page answers 401 (fail-closed); no other function is affected.
EOF
}

cmd_status() {
  local st sha marker="absent" bk
  echo "router:   $ROUTER"
  st=$(state_of "$ROUTER")
  if [[ "$st" == missing ]]; then echo "state:    missing"; return 1; fi
  sha=$(sha_of "$ROUTER")
  grep -qF "$MARKER" "$ROUTER" && marker="present"
  echo "sha256:   $sha"
  echo "allow-list marker: $marker (${PUBLIC_PAGES[*]})"
  bk=$(upstream_backup)
  echo "upstream backup: ${bk:-none}"
  case "$st" in
    patched)  echo "state:    patched ($UPSTREAM_REF + functions-main-public-page.patch)" ;;
    upstream) echo "state:    upstream ($UPSTREAM_REF, NOT patched: the phone page answers 401; run apply)" ;;
    unknown)
      if grep -qE '^(<<<<<<<|>>>>>>>|=======)' "$ROUTER"; then
        echo "state:    unknown (CONFLICT MARKERS present: the router will not start)"
      elif [[ "$marker" == present ]]; then
        echo "state:    unknown (allow-list marker present but sha differs: merged/edited copy)"
      else
        echo "state:    unknown (upstream changed: re-derive the patch)"
      fi
      return 1 ;;
  esac
}

cmd_apply() {
  local st tmp bk
  [[ -f "$PATCH_FILE" ]] || die "patch not found: $PATCH_FILE (set PATCH_FILE)"
  st=$(state_of "$ROUTER")
  case "$st" in
    patched) echo "already patched (sha $PATCHED_SHA): nothing to do"; return 0 ;;
    missing) die "router not found: $ROUTER" ;;
    unknown) rederive_help; die "refusing to patch an unknown router (sha $(sha_of "$ROUTER"))" ;;
  esac
  tmp=$(mktemp -d); CLEANUP+=("$tmp")
  mkdir -p "$tmp/main"
  cp -p "$ROUTER" "$tmp/main/index.ts"
  ( cd "$tmp" && patch --dry-run -p1 < "$PATCH_FILE" >/dev/null ) || die "patch --dry-run failed; nothing changed"
  ( cd "$tmp" && patch -p1 < "$PATCH_FILE" >/dev/null ) || die "patch failed on the temp copy; nothing changed"
  [[ "$(sha_of "$tmp/main/index.ts")" == "$PATCHED_SHA" ]] \
    || die "patched temp copy has sha $(sha_of "$tmp/main/index.ts"), expected $PATCHED_SHA; nothing changed"
  bk="$FUNCTIONS_DIR/main/$BACKUP_PREFIX.$(utc_stamp)"
  cp -p "$ROUTER" "$bk"
  [[ "$(sha_of "$bk")" == "$UPSTREAM_SHA" ]] || die "backup $bk does not match the upstream sha; router unchanged"
  cp "$tmp/main/index.ts" "$ROUTER"   # in place: keeps owner and mode
  [[ "$(state_of "$ROUTER")" == patched ]] || { cp "$bk" "$ROUTER"; die "post-apply sha mismatch; restored the backup"; }
  echo "patched: $ROUTER (sha $PATCHED_SHA)"
  echo "backup:  $bk"
  echo "NEXT: cd /srv/supabase/stack && docker compose restart functions   # all functions unavailable for a few seconds"
  echo "      then: $0 verify"
}

cmd_revert() {
  local st bk
  st=$(state_of "$ROUTER")
  case "$st" in
    upstream) echo "already upstream (sha $UPSTREAM_SHA): nothing to do"; return 0 ;;
    missing) die "router not found: $ROUTER" ;;
    unknown) die "router sha $(sha_of "$ROUTER") is neither patched nor upstream; refusing to overwrite it with an older upstream copy" ;;
  esac
  bk=$(upstream_backup)
  [[ -n "$bk" ]] || die "no backup matching the upstream sha under $FUNCTIONS_DIR/main/$BACKUP_PREFIX*"
  cp "$bk" "$ROUTER"
  [[ "$(state_of "$ROUTER")" == upstream ]] || die "post-revert sha mismatch: $(sha_of "$ROUTER")"
  echo "reverted to upstream from $bk (sha $UPSTREAM_SHA)"
  echo "NEXT: cd /srv/supabase/stack && docker compose restart functions"
  echo "      (the phone page then answers 401; every other function is unchanged)"
}

# --- verify -------------------------------------------------------------------
PASS=0; FAIL=0; VTMP=""
R_CODE=""
req() {  # METHOD PATH [curl args...] -> R_CODE, $VTMP/hdrs, $VTMP/body
  local m="$1" p="$2"; shift 2
  local a=(-sS --path-as-is --max-time 20 -o "$VTMP/body" -D "$VTMP/hdrs" -w '%{http_code}')
  if [[ "$m" == HEAD ]]; then a+=(-I); else a+=(-X "$m"); fi
  : >"$VTMP/hdrs"; : >"$VTMP/body"
  R_CODE=$(curl "${a[@]}" "$@" "$FUNCTIONS_URL$p" 2>/dev/null) || R_CODE="${R_CODE:-000}"
}
hdr() { { grep -i "^$1:" "$VTMP/hdrs" || true; } | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
ok()  { PASS=$((PASS+1)); printf 'PASS  %-58s %s\n' "$1" "$2"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %-58s %s\n' "$1" "$2"; }
expect_code() {  # DESC WANT -> uses R_CODE
  if [[ "$R_CODE" == "$2" ]]; then ok "$1" "$R_CODE"; else bad "$1" "got $R_CODE, want $2"; fi
}
expect_gate() {  # DESC: 401 from the router's JWT gate (sb-error-code), i.e. no function ran
  local code; code=$(hdr sb-error-code)
  if [[ "$R_CODE" == 401 && -n "$code" ]]; then ok "$1" "401 $code"
  else bad "$1" "got $R_CODE${code:+ $code}, want 401 from the JWT gate"; fi
}
is_page() {  # last response is the public page itself
  [[ "$R_CODE" == 200 && "$(hdr content-type)" == text/html* && "$(hdr content-security-policy)" == *"default-src 'none'"* ]]
}
# Path tricks: through the gateway Envoy may answer first (empty-body 400 for an
# escaped slash, merged // -> the page itself); straight at the router (local
# test) it is always the JWT gate. Either way no other function runs unauthenticated.
expect_blocked() {  # DESC [page-ok]
  local code; code=$(hdr sb-error-code)
  if [[ "$R_CODE" == 401 && -n "$code" ]]; then ok "$1" "401 $code"
  elif [[ "$R_CODE" == 400 && ! -s "$VTMP/body" && "$(hdr server)" == envoy* ]]; then ok "$1" "400 (rejected by Envoy)"
  elif [[ "${2:-}" == page-ok ]] && is_page; then ok "$1" "200 = the public page itself"
  else bad "$1" "got $R_CODE${code:+ $code}: may have reached a function without auth"; fi
}

function_names() {
  if [[ -n "${FUNCTION_NAMES:-}" ]]; then tr -s ' ' '\n' <<<"$FUNCTION_NAMES"; return; fi
  [[ -d "$FUNCTIONS_DIR" ]] || die "FUNCTIONS_DIR $FUNCTIONS_DIR not found; set FUNCTION_NAMES"
  local d
  for d in "$FUNCTIONS_DIR"/*/; do
    d="${d%/}"; d="${d##*/}"
    [[ "$d" == main || "$d" == .* ]] && continue
    echo "$d"
  done
}

cmd_verify() {
  command -v curl >/dev/null || die "curl required"
  VTMP=$(mktemp -d); CLEANUP+=("$VTMP")
  local names=() n p gated=() pub
  while IFS= read -r n; do [[ -n "$n" ]] && names+=("$n"); done < <(function_names)
  (( ${#names[@]} )) || die "no functions found"
  echo "functions URL: $FUNCTIONS_URL"
  echo "functions:     ${names[*]}"
  echo
  for n in "${names[@]}"; do
    pub=0
    for p in "${PUBLIC_PAGES[@]}"; do if [[ "$n" == "$p" ]]; then pub=1; fi; done
    (( pub )) || gated+=("$n")
  done

  for p in "${PUBLIC_PAGES[@]}"; do
    req GET "/$p"
    if is_page && grep -q '<script nonce=' "$VTMP/body"; then
      ok "GET  /$p (no auth)" "200 $(hdr content-type), CSP default-src 'none'"
    else bad "GET  /$p (no auth)" "got $R_CODE ctype=[$(hdr content-type)]"; fi
    req HEAD "/$p"
    if is_page; then ok "HEAD /$p (no auth)" "200 $(hdr content-type), CSP"
    else bad "HEAD /$p (no auth)" "got $R_CODE ctype=[$(hdr content-type)]"; fi
    req GET "/$p?x=1"
    if is_page; then ok "GET  /$p?x=1 (same page)" 200; else bad "GET  /$p?x=1" "got $R_CODE"; fi
    req GET "/$p/"
    if is_page; then ok "GET  /$p/ (same page)" 200; else bad "GET  /$p/" "got $R_CODE"; fi
    req POST "/$p" -H 'content-type: application/json' --data '{}'; expect_gate "POST /$p (no auth)"
    req GET "/$p/x";     expect_gate "GET  /$p/x (sub-path)"
    req GET "//$p";      expect_blocked "GET  //$p" page-ok
    req GET "/$(tr '[:lower:]' '[:upper:]' <<<"$p")"; expect_blocked "GET  /$(tr '[:lower:]' '[:upper:]' <<<"$p")"
    req OPTIONS "/$p"
    if [[ "$R_CODE" != 401 && "$R_CODE" != 000 ]]; then ok "OPTIONS /$p (gate skipped, as upstream)" "$R_CODE"
    else bad "OPTIONS /$p" "got $R_CODE"; fi
    for n in ${gated[@]+"${gated[@]}"}; do
      req GET "/$p/../$n";        expect_blocked "GET  /$p/../$n"
      req GET "/$p%2F..%2F$n";    expect_blocked "GET  /$p%2F..%2F$n"
      req GET "/$p/%2e%2e/$n";    expect_blocked "GET  /$p/%2e%2e/$n"
    done
  done

  for n in ${gated[@]+"${gated[@]}"}; do
    req GET "/$n";  expect_gate "GET  /$n (no auth)"
    req POST "/$n" -H 'content-type: application/json' --data '{}'; expect_gate "POST /$n (no auth)"
    req GET "/$n?x=/${PUBLIC_PAGES[0]}"; expect_gate "GET  /$n?x=/${PUBLIC_PAGES[0]}"
    req OPTIONS "/$n"
    if [[ "$R_CODE" != 401 && "$R_CODE" != 000 ]]; then ok "OPTIONS /$n (gate skipped, as upstream)" "$R_CODE"
    else bad "OPTIONS /$n" "got $R_CODE"; fi
  done

  if [[ -n "${SUPABASE_ANON_KEY:-}" ]]; then
    local found=0
    for n in "${names[@]}"; do if [[ "$n" == phone-upload-token ]]; then found=1; fi; done
    if (( found )); then
      # the key reaches curl through a pipe (-K <(...)): never argv, a file or output
      req POST /phone-upload-token -H 'content-type: application/json' --data '{"token":"short"}' \
        -K <(printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' "$SUPABASE_ANON_KEY" "$SUPABASE_ANON_KEY")
      if [[ "$R_CODE" == 404 ]] && grep -q '"code":"invalid"' "$VTMP/body"; then ok "POST /phone-upload-token bad token (anon key)" "404 invalid"
      else bad "POST /phone-upload-token bad token (anon key)" "got $R_CODE"; fi
    fi
  else
    echo "SKIP  anon-key probe of phone-upload-token (SUPABASE_ANON_KEY not set)"
  fi

  echo
  echo "verify: $PASS passed, $FAIL failed"
  (( FAIL == 0 ))
}

usage() { sed -n '2,36p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

case "${1:-}" in
  status) cmd_status ;;
  apply)  cmd_apply ;;
  revert) cmd_revert ;;
  verify) cmd_verify ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
