#!/usr/bin/env bash
# curl-shim.sh — TEST ONLY. suite-gmail.sh puts a copy named `curl` first in PATH for the Gmail API runs.
# Before handing over to the real curl it records, for the leak assertions:
#   CURL_ARGV_LOG    the complete argv of this curl call (must never contain a secret)
#   CURL_TOKDIR_LOG  mode/owner of every .gmail-oauth.* token dir and file under CURL_SCAN_DIRS
#   CURL_LEAK_LOG    files under CURL_SCAN_DIRS (outside token dirs and CURL_SCAN_EXCLUDE) that contain
#                    an access token issued by the mock (prefix read from the file CURL_LEAK_MARK_FILE,
#                    so the marker itself never shows up in a process list) at this moment
# stdin is passed through untouched (the scripts feed curl its --config on stdin).
if [[ -n "${CURL_ARGV_LOG:-}" ]]; then
  { printf 'pid=%s' "$$"; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >>"$CURL_ARGV_LOG"
fi
if [[ -n "${CURL_TOKDIR_LOG:-}" ]]; then
  for root in ${CURL_SCAN_DIRS:-}; do
    find "$root" -xdev -type d -name '.gmail-oauth.*' -printf 'dir %m %u %p\n' -exec find {} -mindepth 1 -printf 'file %m %u %p\n' \; 2>/dev/null
  done >>"$CURL_TOKDIR_LOG"
fi
if [[ -n "${CURL_LEAK_LOG:-}" && -s "${CURL_LEAK_MARK_FILE:-}" ]]; then
  for root in ${CURL_SCAN_DIRS:-}; do
    grep -rlF --exclude-dir='.gmail-oauth.*' --exclude-dir="${CURL_SCAN_EXCLUDE:-none}" -f "$CURL_LEAK_MARK_FILE" "$root" 2>/dev/null
  done >>"$CURL_LEAK_LOG"
fi
exec /usr/bin/curl "$@"
