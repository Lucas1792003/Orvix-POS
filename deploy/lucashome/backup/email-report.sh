#!/usr/bin/env bash
# email-report.sh — daily business report by email, one message per configured organization.
#
# Server-side and read-only: email-report.sql runs inside the db container through psql in a
# READ ONLY transaction; no Edge Function, no service-role key, no pg_cron, no Resend key in the
# database. Routing is explicit: REPORT_TARGETS_FILE lists which organization goes to which
# addresses, so one org's figures can never reach another org's admins by accident.
#
#   # report-targets.conf (0600; no secrets, but addresses are personal data)
#   # org_id            recipients (comma-separated)          options
#   org-abc123          owner@example.com                      health
#
# "health" adds the backup-health block (local backups + weekly email archive) — use it only on the
# operator's own organization. Idempotent per (org, day): a sent report is not sent again unless
# --force; the provider idempotency key is report-<org>-<day> as well.
set -euo pipefail
# shellcheck source=email-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/email-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--date YYYY-MM-DD] [--force] [--render-only DIR] [--dry-run] [--help]
  --date D          business day to report (default: yesterday in $REPORT_TZ)
  --force           send again even if this day's report was already sent
  --render-only DIR query + render into DIR/<org>/ and send nothing (works while disabled)
  --dry-run         show targets and what would happen
Targets: $REPORT_TARGETS_FILE   transport: $MAIL_TRANSPORT
EOF
}
DAY=""; FORCE=0; RENDER_ONLY=""
while (( $# )); do
  case "$1" in
    --date) DAY="$2"; shift ;;
    --force) FORCE=1 ;;
    --render-only) RENDER_ONLY="$2"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

# shellcheck disable=SC2034  # read by backup-lib.sh (log prefix, lock + log file names)
JOB_NAME=email-report
init_logging
if [[ -z "$RENDER_ONLY" ]] && (( ! DRY_RUN )); then
  email_gate
  [[ "$EMAIL_REPORT_ENABLED" == true ]] || { log "EMAIL_REPORT_ENABLED != true; nothing to do"; exit 0; }
fi
acquire_lock
START=$SECONDS
[[ -n "$DAY" ]] || DAY="$(TZ="$REPORT_TZ" date -d 'yesterday' +%F)"
[[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && date -d "$DAY" >/dev/null 2>&1 || die "--date must be YYYY-MM-DD"
[[ -f "$REPORT_TARGETS_FILE" ]] || die "no targets file $REPORT_TARGETS_FILE"
SQL="$LIB_DIR/email-report.sql"; PY="$LIB_DIR/email-report.py"
[[ -f "$SQL" && -f "$PY" ]] || die "missing email-report.sql / email-report.py next to this script"

FAILED=()
WORK=""
cleanup() {
  local rc=$?
  trap - EXIT
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf -- "$WORK"
  if (( rc != 0 )) && [[ -z "$RENDER_ONLY" ]] && (( ! DRY_RUN )); then
    status_update email-report "$(jq -nc --arg t "$(utc_now)" --arg d "$DAY" --arg m "exit $rc: ${FAILED[*]:-error}" \
      '{last_run:$t,last_result:"fail",day:$d,message:$m}')" || true
    mail_alert email-report "daily report for $DAY failed: ${FAILED[*]:-exit $rc}"
  fi
  exit "$rc"
}
trap cleanup EXIT

if [[ -z "$RENDER_ONLY" ]] && (( ! DRY_RUN )); then mail_preflight || die "mail transport preflight failed"; fi
WORK="$(mktemp -d)"; chmod 0700 "$WORK"
mkdir -p "$REPORT_STATE_DIR/$DAY" && chmod 0700 "$REPORT_STATE_DIR" "$REPORT_STATE_DIR/$DAY"

SENT=0; SKIPPED=0; N=0
while read -r ORG RCPTS OPTS || [[ -n "${ORG:-}" ]]; do
  [[ -z "${ORG:-}" || "$ORG" == \#* ]] && continue
  [[ "$ORG" =~ ^[A-Za-z0-9_.:-]{1,100}$ ]] || { FAILED+=("bad org id in targets file"); continue; }
  [[ -n "${RCPTS:-}" ]] || { FAILED+=("$ORG: no recipients"); continue; }
  N=$(( N + 1 ))
  STATE="$REPORT_STATE_DIR/$DAY/$ORG.json"
  if [[ -z "$RENDER_ONLY" ]] && (( ! FORCE )) && [[ -f "$STATE" ]] && [[ "$(jq -r .result "$STATE")" == sent ]]; then
    log "$ORG $DAY: already sent at $(jq -r .sent_at "$STATE"); skipping"; SKIPPED=$(( SKIPPED + 1 )); continue
  fi
  if (( DRY_RUN )); then log "DRY-RUN: $ORG $DAY -> $RCPTS (${OPTS:-no options})"; continue; fi
  OUT="$WORK/$ORG"; mkdir -p "$OUT"
  # read-only query, the SQL file goes to psql on stdin; ON_ERROR_STOP aborts on any error
  if ! db_exec_stdin psql -X -U "$DB_ADMIN_USER" -d postgres -v ON_ERROR_STOP=1 -Atq \
        -v org="$ORG" -v day="$DAY" -v tz="$REPORT_TZ" -f - <"$SQL" >"$OUT/report.raw" 2>"$OUT/psql.err"; then
    FAILED+=("$ORG: query failed ($(head -c 200 "$OUT/psql.err" | tr '\n' ' '))"); continue
  fi
  grep -v '^\(BEGIN\|SET\|COMMIT\)$' "$OUT/report.raw" >"$OUT/report.json" || true
  if ! jq -e '.org.id' "$OUT/report.json" >/dev/null 2>&1; then
    FAILED+=("$ORG: organization not found or empty result"); continue
  fi
  HEALTH=(); [[ " ${OPTS:-} " == *" health "* ]] && HEALTH=(--health)
  email_enabled && [[ ${#HEALTH[@]} -gt 0 ]] && HEALTH+=(--archive-expected)
  python3 -I "$PY" --report "$OUT/report.json" --status "$STATUS_FILE" --out "$OUT" ${HEALTH[@]+"${HEALTH[@]}"} >/dev/null \
    || { FAILED+=("$ORG: render failed"); continue; }
  if [[ -n "$RENDER_ONLY" ]]; then
    mkdir -p "$RENDER_ONLY/$ORG"; cp "$OUT"/{subject.txt,body.txt,body.html,report.json} "$RENDER_ONLY/$ORG/"
    log "$ORG $DAY rendered to $RENDER_ONLY/$ORG"; continue
  fi
  SUBJ="$MAIL_SUBJECT_TAG $(head -n1 "$OUT/subject.txt")"
  IKEY="report-$ORG-$DAY"; (( FORCE )) && IKEY="$IKEY-$(ts_now)"
  if mail_send "$OUT" "$RCPTS" "$SUBJ" "$OUT/body.txt" "$OUT/body.html" "$IKEY"; then
    json_state_write "$STATE" "$(jq -nc --arg at "$(utc_now)" --arg id "$MAIL_LAST_ID" --arg d "$MAIL_LAST_DETAIL" '{result:"sent",sent_at:$at,id:$id,detail:$d}')"
    SENT=$(( SENT + 1 )); log "$ORG $DAY sent ($MAIL_LAST_DETAIL id=$MAIL_LAST_ID)"
  else
    FAILED+=("$ORG: not accepted: $MAIL_LAST_DETAIL")
  fi
done <"$REPORT_TARGETS_FILE"

(( N > 0 )) || die "no targets in $REPORT_TARGETS_FILE"
if (( ${#FAILED[@]} )); then
  for f in "${FAILED[@]}"; do log "FAILED: $f"; done
  die "${#FAILED[@]} target(s) failed"
fi
if [[ -z "$RENDER_ONLY" ]] && (( ! DRY_RUN )); then
  status_update email-report "$(jq -nc --arg t "$(utc_now)" --arg d "$DAY" --argjson s "$SENT" --argjson k "$SKIPPED" --argjson dur "$(( SECONDS - START ))" \
    '{last_run:$t,last_success:$t,last_result:"ok",message:"ok",day:$d,sent:$s,skipped:$k,duration_s:$dur}')"
fi
log "done: day=$DAY targets=$N sent=$SENT skipped=$SKIPPED"
