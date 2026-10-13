#!/usr/bin/env bash
# email-status.sh — health of the email tier from status.json (no network, no mail).
# Problems (only while EMAIL_ENABLED=true): weekly archive never sent / older than
# MAX_AGE_EMAIL_ARCHIVE_S (8 d) / last run failed; daily report older than MAX_AGE_EMAIL_REPORT_S
# (26 h) / failed (only when EMAIL_REPORT_ENABLED=true); secrets job failed; credential or public key
# file missing. While disabled: one "email tier: disabled" line, no problems, exit 0.
# backup-status.sh embeds this via --json, like offsite-status.sh.
set -euo pipefail
# shellcheck source=email-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/email-lib.sh"

JSON=0
while (( $# )); do
  case "$1" in
    --json) JSON=1 ;;
    -h|--help) echo "Usage: $(basename "$0") [--json]"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
LINES=(); PROBLEMS=()
NOW=$(date -u +%s)
epoch() { date -u -d "$1" +%s 2>/dev/null || echo 0; }
ago() { local s=$1; if (( s >= 86400 )); then printf '%dd%02dh' $(( s/86400 )) $(( (s%86400)/3600 )); elif (( s >= 3600 )); then printf '%dh%02dm' $(( s/3600 )) $(( (s%3600)/60 )); else printf '%dm' $(( s/60 )); fi; }
job() { jq -c --arg j "$1" '.jobs[$j] // {}' "$STATUS_FILE" 2>/dev/null || echo '{}'; }

if ! email_enabled; then
  LINES+=("email tier: disabled (EMAIL_ENABLED=$EMAIL_ENABLED)")
else
  j="$(job email-archive)"; last="$(jq -r '.last_success // ""' <<<"$j")"; res="$(jq -r '.last_result // "never"' <<<"$j")"
  if [[ -z "$last" ]]; then PROBLEMS+=("email-archive: never sent"); a="-"
  else s=$(( NOW - $(epoch "$last") )); a="$(ago "$s")"; (( s > MAX_AGE_EMAIL_ARCHIVE_S )) && PROBLEMS+=("email-archive: last sent $a ago (limit $(ago "$MAX_AGE_EMAIL_ARCHIVE_S"))"); fi
  [[ "$res" == fail ]] && PROBLEMS+=("email-archive: last run failed: $(jq -r '.message // ""' <<<"$j")")
  LINES+=("email archive: result=$res last=$(jq -r '.last_archive_id // "-"' <<<"$j") parts=$(jq -r '.parts // "-"' <<<"$j") size=$(human "$(jq -r '.size_bytes // 0' <<<"$j")") sent $a ago via $(jq -r '.transport // "-"' <<<"$j")")
  if [[ "$EMAIL_REPORT_ENABLED" == true ]]; then
    j="$(job email-report)"; last="$(jq -r '.last_success // ""' <<<"$j")"; res="$(jq -r '.last_result // "never"' <<<"$j")"
    if [[ -z "$last" ]]; then PROBLEMS+=("email-report: never sent"); a="-"
    else s=$(( NOW - $(epoch "$last") )); a="$(ago "$s")"; (( s > MAX_AGE_EMAIL_REPORT_S )) && PROBLEMS+=("email-report: last success $a ago"); fi
    [[ "$res" == fail ]] && PROBLEMS+=("email-report: last run failed: $(jq -r '.message // ""' <<<"$j")")
    LINES+=("daily report: result=$res day=$(jq -r '.day // "-"' <<<"$j") $a ago")
  fi
  j="$(job email-secrets)"
  [[ "$(jq -r '.last_result // ""' <<<"$j")" == fail ]] && PROBLEMS+=("email-secrets: last run failed")
  [[ "$j" != '{}' ]] && LINES+=("secrets file: result=$(jq -r '.last_result' <<<"$j") mailed_last=$(jq -r '.last_sent // "never"' <<<"$j")")
  [[ -f "$ARCHIVE_GPG_PUBKEY" ]] || PROBLEMS+=("email tier: owner public key $ARCHIVE_GPG_PUBKEY missing")
  case "$MAIL_TRANSPORT" in
    resend) [[ -f "$RESEND_KEY_FILE" ]] || PROBLEMS+=("email tier: $RESEND_KEY_FILE missing") ;;
    smtp) [[ "$SMTP_NETRC_FILE" == none || -f "$SMTP_NETRC_FILE" ]] || PROBLEMS+=("email tier: $SMTP_NETRC_FILE missing") ;;
  esac
fi

if (( JSON )); then
  jq -nc --argjson en "$(email_enabled && echo true || echo false)" \
    --argjson lines "$(printf '%s\n' "${LINES[@]}" | jq -R . | jq -sc .)" \
    --argjson problems "$(printf '%s\n' ${PROBLEMS[@]+"${PROBLEMS[@]}"} | grep -v '^$' | jq -R . | jq -sc .)" \
    '{enabled:$en, lines:$lines, problems:$problems}'
else
  printf '%s\n' "${LINES[@]}"
  for p in ${PROBLEMS[@]+"${PROBLEMS[@]}"}; do printf 'PROBLEM: %s\n' "$p"; done
fi
(( ${#PROBLEMS[@]} == 0 ))
