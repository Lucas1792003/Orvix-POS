#!/usr/bin/env bash
# email-lib.sh — shared helpers for the email tier (Phase F): weekly encrypted
# recovery archive (email-archive.sh), separate secrets file (email-secrets.sh),
# daily business report (email-report.sh), status (email-status.sh).
# Sourced after backup-lib.sh semantics; not meant to be executed directly.
#
# Everything here is inert until EMAIL_ENABLED=true in backup.env. No host
# names, addresses or keys are hard-coded: every value comes from backup.env
# (or the environment) and the defaults below are placeholders.
#
# Credentials (never in git, never in backup.env, never printed):
#   RESEND_KEY_FILE   one line: a Resend API key with permission "sending_access"
#                     restricted to the sender domain (cannot read or delete mail)
#   SMTP_NETRC_FILE   netrc format: "machine <smtp host> login <user> password <pass>"
#                     (only for MAIL_TRANSPORT=smtp; must be a SEND-ONLY credential)
#   GMAIL_OAUTH_FILE  JSON {client_id, client_secret, refresh_token, scope, created} written by
#                     gmail-oauth-mint.py on the owner's Mac (MAIL_TRANSPORT=gmail-api). The refresh
#                     token carries ONLY https://www.googleapis.com/auth/gmail.send: it can send as the
#                     sender Gmail, never read, list, modify or delete mail.
# All must be regular files owned by the backup user with mode 0600 or 0400.
# The owner's OpenPGP PUBLIC key is the only key material on the host.
# shellcheck shell=bash

_EMAIL_VARS=(EMAIL_ENABLED MAIL_TRANSPORT MAIL_FROM ARCHIVE_MAIL_TO ALERT_MAIL_TO RESEND_API_URL RESEND_KEY_FILE
  SMTP_URL SMTP_NETRC_FILE SMTP_REQUIRE_TLS MAIL_TIMEOUT_S MAIL_RETRIES MAIL_RETRY_SLEEP_S MAIL_RETRY_MAX_SLEEP_S
  MAIL_MAX_ENCODED_BYTES MAIL_MAX_BYTES GMAIL_OAUTH_FILE GMAIL_SENDER GMAIL_TOKEN_URL GMAIL_API_BASE
  MAIL_SUBJECT_TAG ARCHIVE_LABEL ARCHIVE_GPG_PUBKEY ARCHIVE_GPG_FPR ARCHIVE_DIR ARCHIVE_TMP_DIR ARCHIVE_PART_BYTES
  ARCHIVE_MAX_PARTS ARCHIVE_WARN_PARTS KEEP_EMAIL_ARCHIVE MAX_AGE_EMAIL_ARCHIVE_S EMAIL_SECRETS_MODE SECRETS_DIR
  KEEP_SECRETS REPORT_TARGETS_FILE REPORT_TZ REPORT_STATE_DIR MAX_AGE_EMAIL_REPORT_S EMAIL_REPORT_ENABLED
  STORAGE_DIR DB_CONFIG_VOLUME BUNDLE_TAR_MODE)
# environment > backup.env > defaults (same precedence as backup-lib.sh)
_email_overrides=()
for _v in "${_EMAIL_VARS[@]}"; do
  if [[ -n "${!_v+x}" ]]; then _email_overrides+=("$_v=${!_v}"); fi
done
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"
for _kv in ${_email_overrides[@]+"${_email_overrides[@]}"}; do declare "$_kv"; done
unset _v _kv _email_overrides

: "${EMAIL_ENABLED:=false}"           # exactly "true" enables sending (archive, report, secrets --send)
: "${EMAIL_REPORT_ENABLED:=$EMAIL_ENABLED}"
: "${MAIL_TRANSPORT:=resend}"         # resend (HTTPS API, send-only key) | smtp (curl, send-only credential) | gmail-api (OAuth gmail.send)
: "${MAIL_FROM:=}"                    # e.g. "POS backups <backups@example.com>" (a verified sender domain)
: "${ARCHIVE_MAIL_TO:=}"              # dedicated backup mailbox(es), comma-separated; NOT a mailbox whose credentials are on this host
: "${ALERT_MAIL_TO:=$ARCHIVE_MAIL_TO}" # failure notifications (small, no data)
: "${RESEND_API_URL:=https://api.resend.com/emails}"
: "${RESEND_KEY_FILE:=/srv/supabase/backup/credentials/resend.key}"
: "${SMTP_URL:=smtps://smtp.example.invalid:465}"
: "${SMTP_NETRC_FILE:=/srv/supabase/backup/credentials/smtp.netrc}"
: "${SMTP_REQUIRE_TLS:=true}"         # false only for a local test catcher
: "${MAIL_TIMEOUT_S:=300}"
: "${MAIL_RETRIES:=3}"
: "${MAIL_RETRY_SLEEP_S:=30}"          # first back-off; doubles per retry (30, 60, 120 ...)
: "${MAIL_RETRY_MAX_SLEEP_S:=300}"      # cap for one back-off sleep (also caps a provider Retry-After)
# MAIL_MAX_BYTES is accepted as the newer name of MAIL_MAX_ENCODED_BYTES (it wins when both are set)
if [[ -n "${MAIL_MAX_BYTES:-}" ]]; then MAIL_MAX_ENCODED_BYTES="$MAIL_MAX_BYTES"; fi
: "${MAIL_MAX_ENCODED_BYTES:=24000000}"  # refuse to hand over a message larger than this (25 MB receiving mailboxes, incl. base64)
# Gmail API transport (MAIL_TRANSPORT=gmail-api). The two URLs are NOT configuration: they may differ
# from Google's only for the local test harness, and then only pointing at 127.0.0.1 (mail_preflight).
_GMAIL_TOKEN_URL_DEFAULT=https://oauth2.googleapis.com/token
_GMAIL_API_BASE_DEFAULT=https://gmail.googleapis.com
GMAIL_SCOPE=https://www.googleapis.com/auth/gmail.send
GMAIL_API_MAX_BYTES=36700160          # users.messages.send media upload maxSize (35 MiB, Gmail API discovery document)
: "${GMAIL_OAUTH_FILE:=/srv/supabase/backup/credentials/gmail-oauth.json}"
: "${GMAIL_SENDER:=}"                 # the sender Gmail address that minted the token, e.g. pos.backup.sender@gmail.com
: "${GMAIL_TOKEN_URL:=$_GMAIL_TOKEN_URL_DEFAULT}"
: "${GMAIL_API_BASE:=$_GMAIL_API_BASE_DEFAULT}"
# Gmail sends as the authenticated account (any other From is replaced), so From defaults to it.
if [[ "$MAIL_TRANSPORT" == gmail-api && -z "$MAIL_FROM" && -n "$GMAIL_SENDER" ]]; then MAIL_FROM="POS backups <$GMAIL_SENDER>"; fi
: "${MAIL_SUBJECT_TAG:=[pos-backup]}"
: "${ARCHIVE_LABEL:=pos}"             # appears in archive ids and file names; keep it free of host/infra names
: "${ARCHIVE_GPG_PUBKEY:=/srv/supabase/backup/credentials/owner-backup.pub.asc}"
: "${ARCHIVE_GPG_FPR:=}"              # expected 40-hex fingerprint of that key (pins it; a swapped file fails closed)
: "${ARCHIVE_DIR:=$BACKUP_ROOT/email-archive}"   # encrypted builds only (parts + index + state)
: "${ARCHIVE_TMP_DIR:=$BACKUP_ROOT/.email-tmp}"  # 0700 plaintext staging, removed on exit
: "${ARCHIVE_PART_BYTES:=15728640}"   # 15 MiB raw per part (~20.5 MB after base64)
: "${ARCHIVE_MAX_PARTS:=12}"          # more parts than this = fail closed (archive outgrew email)
: "${ARCHIVE_WARN_PARTS:=4}"
: "${KEEP_EMAIL_ARCHIVE:=4}"          # local encrypted builds kept on this host
: "${MAX_AGE_EMAIL_ARCHIVE_S:=691200}" # 8 d
: "${EMAIL_SECRETS_MODE:=local}"      # off | local (build, keep on host) | email (also send when the secret set changed)
: "${SECRETS_DIR:=$BACKUP_ROOT/email-secrets}"
: "${KEEP_SECRETS:=4}"
: "${REPORT_TARGETS_FILE:=/srv/supabase/backup/report-targets.conf}"
: "${REPORT_TZ:=Asia/Yangon}"
: "${REPORT_STATE_DIR:=$BACKUP_ROOT/email-report}"
: "${MAX_AGE_EMAIL_REPORT_S:=93600}"  # 26 h
: "${STORAGE_DIR:=$STACK_DIR/volumes/storage}"
: "${DB_CONFIG_VOLUME:=supabase_db-config}"
: "${BUNDLE_TAR_MODE:=docker}"

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIME_PY="$LIB_DIR/email-mime.py"
MAIL_LAST_ID=""        # provider id (resend, gmail-api) or our Message-ID (smtp) of the last accepted message
MAIL_LAST_THREAD=""    # gmail-api: threadId of the last accepted message
MAIL_LAST_DETAIL=""    # short, data-free description of the last result
EMAIL_FAIL_REASON=""   # MAIL_LAST_DETAIL of the last message that was NOT accepted (for status.json)
_MAIL_RETRY_AFTER=0    # provider Retry-After (s) of the last transient failure, 0 = none
_GMAIL_TOKDIR=""       # 0700 dir (inside the caller's 0700 work dir) holding the short-lived access token
_GMAIL_DEAD=""         # set when the refresh token/client is unusable: no further gmail sends this run

email_enabled() { [[ "$EMAIL_ENABLED" == true ]]; }

# email_gate — exit 0 (with a log line) unless sending is enabled.
email_gate() {
  if ! email_enabled; then
    log "email tier disabled (EMAIL_ENABLED=${EMAIL_ENABLED}); nothing to do"
    exit 0
  fi
}

# bare address of MAIL_FROM ("Name <a@b>" -> a@b)
mail_from_addr() {
  local f="$MAIL_FROM"
  if [[ "$f" =~ \<([^>]+)\> ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf '%s' "$f"; fi
}
mail_from_domain() { local a; a="$(mail_from_addr)"; printf '%s' "${a##*@}"; }

# credential_file_ok PATH — regular file, owned by us, mode 0600/0400, non-empty. Never reads the content.
credential_file_ok() {
  local f="$1" mode owner
  [[ -f "$f" && ! -L "$f" ]] || { log "credential file missing or not a regular file: $f"; return 1; }
  [[ -s "$f" ]] || { log "credential file empty: $f"; return 1; }
  mode="$(stat -c %a "$f")"; owner="$(stat -c %u "$f")"
  [[ "$owner" == "$(id -u)" ]] || { log "credential file $f not owned by $(id -un)"; return 1; }
  [[ "$mode" == 600 || "$mode" == 400 ]] || { log "credential file $f has mode $mode (need 600 or 400)"; return 1; }
}

# mail_preflight — config + credential checks shared by every sender. Returns 1 with a log line on problems.
mail_preflight() {
  [[ -n "$MAIL_FROM" ]] || { log "MAIL_FROM is not set"; return 1; }
  [[ "$(mail_from_addr)" == *@* ]] || { log "MAIL_FROM has no address"; return 1; }
  command -v curl >/dev/null || { log "curl not found"; return 1; }
  command -v python3 >/dev/null || { log "python3 not found"; return 1; }
  [[ -f "$MIME_PY" ]] || { log "missing $MIME_PY"; return 1; }
  case "$MAIL_TRANSPORT" in
    resend) credential_file_ok "$RESEND_KEY_FILE" || return 1 ;;
    smtp)
      [[ "$SMTP_URL" =~ ^smtps?:// ]] || { log "SMTP_URL must start with smtp:// or smtps://"; return 1; }
      if [[ -n "$SMTP_NETRC_FILE" && "$SMTP_NETRC_FILE" != none ]]; then credential_file_ok "$SMTP_NETRC_FILE" || return 1; fi ;;
    gmail-api) gmail_preflight || return 1 ;;
    *) log "MAIL_TRANSPORT must be resend, smtp or gmail-api (is '$MAIL_TRANSPORT')"; return 1 ;;
  esac
}

_curl_transient() {  # curl exit codes worth a retry: resolve/connect/timeout/TLS/empty reply/recv/send
  case "$1" in 5|6|7|28|35|52|55|56) return 0 ;; *) return 1 ;; esac
}

# mail_send WORKDIR TO_CSV SUBJECT TEXT_FILE HTML_FILE|- IDEMPOTENCY_KEY [ATTACHMENT...]
# Builds the message in WORKDIR, refuses it if larger than MAIL_MAX_ENCODED_BYTES, and hands it to the
# provider. Returns 0 ONLY when the provider accepted it (resend: HTTP 200 + id; smtp: curl exit 0 and
# final reply 250; gmail-api: HTTP 200 + id). Sets MAIL_LAST_ID / MAIL_LAST_THREAD / MAIL_LAST_DETAIL,
# and EMAIL_FAIL_REASON when not accepted. Attachments: PATH[::NAME[::MIME]].
mail_send() {
  local work="$1" to="$2" subject="$3" text="$4" html="$5" ikey="$6"; shift 6
  local -a att=() args=()
  local a msgid kind out size attempt=0 rc delay
  for a in "$@"; do att+=(--attach "$a"); done
  MAIL_LAST_ID=""; MAIL_LAST_THREAD=""; MAIL_LAST_DETAIL=""
  [[ -n "$to" ]] || { MAIL_LAST_DETAIL="no recipient configured"; EMAIL_FAIL_REASON="$MAIL_LAST_DETAIL"; return 1; }
  msgid="<${ikey//[^A-Za-z0-9._-]/-}.$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')@$(mail_from_domain)>"
  if [[ "$MAIL_TRANSPORT" == resend ]]; then kind=resend-json; out="$work/message.json"; else kind=eml; out="$work/message.eml"; fi
  args=(--from "$MAIL_FROM" --to "$to" --subject "$subject" --text-file "$text" --message-id "$msgid" --out "$out")
  [[ "$html" != - ]] && args+=(--html-file "$html")
  python3 -I "$MIME_PY" "$kind" "${args[@]}" ${att[@]+"${att[@]}"} || { MAIL_LAST_DETAIL="could not build the message"; EMAIL_FAIL_REASON="$MAIL_LAST_DETAIL"; return 1; }
  size="$(stat -c %s "$out")"
  if (( size > MAIL_MAX_ENCODED_BYTES )); then
    MAIL_LAST_DETAIL="message is $size bytes encoded, over MAIL_MAX_ENCODED_BYTES=$MAIL_MAX_ENCODED_BYTES; not sent"
    EMAIL_FAIL_REASON="$MAIL_LAST_DETAIL"; rm -f -- "$out"; return 1
  fi
  while :; do
    attempt=$(( attempt + 1 ))
    _MAIL_RETRY_AFTER=0
    case "$MAIL_TRANSPORT" in
      resend) _send_resend "$work" "$out" "$ikey"; rc=$? ;;
      gmail-api) _send_gmail "$work" "$out"; rc=$? ;;
      *) _send_smtp "$work" "$out" "$to" "$msgid"; rc=$? ;;
    esac
    (( rc == 0 )) && break
    if (( rc == 2 && attempt < MAIL_RETRIES )); then
      # bounded exponential back-off: SLEEP, 2*SLEEP, 4*SLEEP ... capped; a longer Retry-After wins (capped too)
      delay=$(( MAIL_RETRY_SLEEP_S * (1 << (attempt - 1)) ))
      if (( _MAIL_RETRY_AFTER > delay )); then delay=$_MAIL_RETRY_AFTER; fi
      if (( delay > MAIL_RETRY_MAX_SLEEP_S )); then delay=$MAIL_RETRY_MAX_SLEEP_S; fi
      log "send attempt $attempt failed (${MAIL_LAST_DETAIL}); retrying in ${delay}s"
      sleep "$delay"; continue
    fi
    # shellcheck disable=SC2034  # read by the sourcing scripts (status message)
    EMAIL_FAIL_REASON="$MAIL_LAST_DETAIL"
    rm -f -- "$out"; return 1
  done
  rm -f -- "$out"
  if [[ "$MAIL_TRANSPORT" == smtp ]]; then MAIL_LAST_ID="$msgid"; fi
  return 0
}

# _send_resend WORK PAYLOAD IKEY — 0 accepted, 2 transient (retry), 1 permanent.
# The API key is passed to curl through --config on stdin (never in argv or the environment).
_send_resend() {
  local work="$1" payload="$2" ikey="$3" resp="$1/resend-response.json" http rc key
  : >"$resp"
  key="$(<"$RESEND_KEY_FILE")"; key="${key//[$'\r\n\t ']/}"
  set +e
  http="$(printf 'header = "Authorization: Bearer %s"\n' "$key" | curl -sS --config - \
    --max-time "$MAIL_TIMEOUT_S" -X POST -H 'Content-Type: application/json' -H "Idempotency-Key: $ikey" \
    --data-binary "@$payload" -o "$resp" -w '%{http_code}' "$RESEND_API_URL" 2>"$work/curl.err")"
  rc=$?
  set -e
  key=""
  if (( rc != 0 )); then
    MAIL_LAST_DETAIL="curl exit $rc ($(head -c 200 "$work/curl.err" | tr '\n' ' '))"
    _curl_transient "$rc" && return 2 || return 1
  fi
  if [[ "$http" == 200 ]]; then
    MAIL_LAST_ID="$(jq -r '.id // empty' "$resp" 2>/dev/null || true)"
    if [[ -n "$MAIL_LAST_ID" ]]; then MAIL_LAST_DETAIL="http 200"; return 0; fi
    MAIL_LAST_DETAIL="http 200 without an id"; return 1
  fi
  # error bodies from the API carry no message content; keep them short in the log
  MAIL_LAST_DETAIL="http $http: $(jq -r '(.name // "") + " " + (.message // "")' "$resp" 2>/dev/null | head -c 200)"
  case "$http" in 429|500|502|503|504) return 2 ;; *) return 1 ;; esac
}

# _send_smtp WORK EML TO_CSV MSGID — 0 accepted (exit 0 and final reply 250), 2 transient, 1 permanent.
# The credential comes from a netrc file (never in argv).
_send_smtp() {
  local work="$1" eml="$2" to="$3" rc code r
  local -a args=(-sS --max-time "$MAIL_TIMEOUT_S" --url "$SMTP_URL" --mail-from "$(mail_from_addr)" --upload-file "$eml" -o /dev/null -w '%{response_code}')
  [[ "$SMTP_REQUIRE_TLS" == true ]] && args+=(--ssl-reqd)
  if [[ -n "$SMTP_NETRC_FILE" && "$SMTP_NETRC_FILE" != none ]]; then args+=(--netrc-file "$SMTP_NETRC_FILE"); fi
  IFS=',' read -r -a _rcpts <<<"$to"
  for r in "${_rcpts[@]}"; do r="${r// /}"; [[ -n "$r" ]] && args+=(--mail-rcpt "$r"); done
  set +e
  code="$(curl "${args[@]}" 2>"$work/curl.err")"
  rc=$?
  set -e
  if (( rc != 0 )); then
    MAIL_LAST_DETAIL="curl exit $rc, smtp reply ${code:-none} ($(head -c 200 "$work/curl.err" | tr '\n' ' '))"
    _curl_transient "$rc" && return 2 || return 1
  fi
  if [[ "$code" != 250 ]]; then MAIL_LAST_DETAIL="smtp final reply $code (expected 250)"; return 1; fi
  MAIL_LAST_DETAIL="smtp 250"
  return 0
}

# ---------------------------------------------------------------------------
# Gmail API transport (send-only OAuth scope gmail.send)
# ---------------------------------------------------------------------------
# Secrets handling:
#  * client_id / client_secret / refresh_token stay in GMAIL_OAUTH_FILE. To refresh, python turns them
#    into an x-www-form-urlencoded body in a 0600 file inside a 0700 temp dir; curl reads it with
#    --data-binary @file and the file is deleted right after. Nothing secret is in argv or the env.
#  * The access token (about 1 h) lives in a 0600 file in that same 0700 dir, which sits inside the
#    caller's 0700 work dir and is removed with it by the caller's EXIT trap. It is cached only for the
#    rest of this run, and reaches curl as a header line through `--config -` on stdin.
#  * Logs and status only ever get HTTP codes, Google's error codes/reasons and message/thread ids.

_gmail_url_ok() {  # URL DEFAULT — Google's URL, or (test harness only) http(s)://127.0.0.1[:port]/...
  local u="$1" d="$2"
  [[ "$u" == "$d" ]] && return 0
  [[ "$u" =~ ^https?://127\.0\.0\.1(:[0-9]{1,5})?(/[^[:space:]]*)?$ ]]
}
_gmail_proto() {  # URL -> value for curl --proto (plain http only ever for 127.0.0.1 test URLs)
  if [[ "$1" == http://127.0.0.1* ]]; then printf '=http'; else printf '=https'; fi
}

# _gmail_creds_py check|form FILE [OUT] — validate the credentials JSON (never prints a value);
# "form" also writes the refresh request body to OUT (created 0600, must not exist yet).
_gmail_creds_py() {
  python3 -I - "$GMAIL_SCOPE" "$@" <<'PY'
import json, os, sys, urllib.parse
scope, mode, path = sys.argv[1:4]
try:
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
except Exception as e:  # the text of a JSON error can quote content: report the type only
    sys.exit(f"gmail oauth file unreadable or not JSON ({type(e).__name__})")
if not isinstance(d, dict):
    sys.exit("gmail oauth file is not a JSON object")
for k in ("client_id", "client_secret", "refresh_token"):
    v = d.get(k)
    if not isinstance(v, str) or not v.strip() or any(c.isspace() for c in v.strip()):
        sys.exit(f"gmail oauth file: '{k}' missing, empty or malformed")
if not isinstance(d.get("scope"), str) or d["scope"].split() != [scope]:
    sys.exit("gmail oauth file: 'scope' must be exactly gmail.send; re-mint with gmail-oauth-mint.py")
if mode == "form":
    body = urllib.parse.urlencode({"grant_type": "refresh_token", "client_id": d["client_id"].strip(),
                                   "client_secret": d["client_secret"].strip(),
                                   "refresh_token": d["refresh_token"].strip()})
    fd = os.open(sys.argv[4], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(body)
PY
}

# _gmail_token_py RESPONSE OUT — copy access_token from a 200 token response into OUT (0600) and print
# expires_in. Exit 3 when the granted scope is not exactly gmail.send, 1 when malformed.
_gmail_token_py() {
  python3 -I - "$GMAIL_SCOPE" "$@" <<'PY'
import json, os, sys
scope, resp, out = sys.argv[1:4]
try:
    with open(resp, encoding="utf-8") as fh:
        d = json.load(fh)
except Exception:
    sys.exit(1)
tok = d.get("access_token")
# the token goes into a curl config line between double quotes: plain visible ASCII, no quote/backslash
if not isinstance(tok, str) or not tok or any(ord(c) < 33 or ord(c) > 126 or c in '"\\' for c in tok):
    sys.exit(1)
if str(d.get("token_type", "Bearer")).lower() != "bearer":
    sys.exit(1)
if "scope" in d and str(d["scope"]).split() != [scope]:
    sys.exit(3)
try:
    exp = int(d.get("expires_in", 0))
except (TypeError, ValueError):
    exp = 0
if exp <= 60:
    exp = 120
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as fh:
    fh.write(tok)
print(exp)
PY
}

# gmail_preflight — configuration + credential file checks for MAIL_TRANSPORT=gmail-api
gmail_preflight() {
  local err from sender
  command -v jq >/dev/null || { log "jq not found"; return 1; }
  _gmail_url_ok "$GMAIL_TOKEN_URL" "$_GMAIL_TOKEN_URL_DEFAULT" \
    || { log "GMAIL_TOKEN_URL must be $_GMAIL_TOKEN_URL_DEFAULT (a test override may only point at 127.0.0.1)"; return 1; }
  _gmail_url_ok "$GMAIL_API_BASE" "$_GMAIL_API_BASE_DEFAULT" \
    || { log "GMAIL_API_BASE must be $_GMAIL_API_BASE_DEFAULT (a test override may only point at 127.0.0.1)"; return 1; }
  [[ "$GMAIL_SENDER" =~ ^[^[:space:]@\<\>]+@[^[:space:]@\<\>]+$ ]] \
    || { log "GMAIL_SENDER (the sender Gmail address the token was minted for) is not set"; return 1; }
  from="$(mail_from_addr)"; from="${from,,}"; sender="${GMAIL_SENDER,,}"
  [[ "$from" == "$sender" ]] \
    || { log "MAIL_FROM must use the GMAIL_SENDER address: Gmail sends as the authenticated account (or a verified send-as alias)"; return 1; }
  (( MAIL_MAX_ENCODED_BYTES <= GMAIL_API_MAX_BYTES )) \
    || { log "MAIL_MAX_ENCODED_BYTES=$MAIL_MAX_ENCODED_BYTES is above the Gmail API upload limit ($GMAIL_API_MAX_BYTES)"; return 1; }
  credential_file_ok "$GMAIL_OAUTH_FILE" || return 1
  err="$(_gmail_creds_py check "$GMAIL_OAUTH_FILE" 2>&1)" || { log "${err:0:200}"; return 1; }
}

_gmail_tokdir() {  # WORK — make sure the 0700 token dir exists (inside the caller's work dir)
  if [[ -z "$_GMAIL_TOKDIR" || ! -d "$_GMAIL_TOKDIR" ]]; then
    _GMAIL_TOKDIR="$(mktemp -d "$1/.gmail-oauth.XXXXXX")" || return 1
    chmod 0700 "$_GMAIL_TOKDIR" || return 1
  fi
}
gmail_forget_token() {  # drop the cached access token now (the caller's trap removes it anyway)
  if [[ -n "$_GMAIL_TOKDIR" && -d "$_GMAIL_TOKDIR" ]]; then rm -rf -- "$_GMAIL_TOKDIR"; fi
  _GMAIL_TOKDIR=""
}
_gmail_token_valid() {
  local d="$_GMAIL_TOKDIR" exp
  [[ -s "$d/access_token" && -s "$d/expires_at" ]] || return 1
  exp="$(<"$d/expires_at")"
  [[ "$exp" =~ ^[0-9]+$ ]] && (( $(date +%s) < exp ))
}

# _gmail_refresh — POST grant_type=refresh_token; new access token into the token dir.
# 0 ok · 1 permanent · 2 transient (429/5xx) · 3 refresh token/client unusable (_GMAIL_DEAD set)
_gmail_refresh() {
  local d="$_GMAIL_TOKDIR" http rc err exp
  rm -f -- "$d/access_token" "$d/expires_at" "$d/form" "$d/token.json"
  if ! err="$(_gmail_creds_py form "$GMAIL_OAUTH_FILE" "$d/form" 2>&1)"; then
    rm -f -- "$d/form"; MAIL_LAST_DETAIL="${err:0:200}"; return 1
  fi
  set +e
  http="$(curl -sS --proto "$(_gmail_proto "$GMAIL_TOKEN_URL")" --max-time 60 -X POST \
    -H 'Content-Type: application/x-www-form-urlencoded' --data-binary "@$d/form" \
    -o "$d/token.json" -w '%{http_code}' "$GMAIL_TOKEN_URL" 2>"$d/curl.err")"
  rc=$?
  set -e
  rm -f -- "$d/form"
  if (( rc != 0 )); then
    rm -f -- "$d/token.json"
    MAIL_LAST_DETAIL="gmail token endpoint: network error, curl exit $rc ($(head -c 160 "$d/curl.err" | tr '\n' ' '))"
    return 1
  fi
  if [[ "$http" == 200 ]]; then
    exp="$(_gmail_token_py "$d/token.json" "$d/access_token" 2>/dev/null)"; rc=$?
    rm -f -- "$d/token.json"
    if (( rc == 3 )); then
      rm -f -- "$d/access_token"
      MAIL_LAST_DETAIL="gmail oauth token grants more than gmail.send; refusing it — owner must re-mint with gmail.send only"
      _GMAIL_DEAD="$MAIL_LAST_DETAIL"; return 3
    fi
    if (( rc != 0 )) || [[ ! "$exp" =~ ^[0-9]+$ ]]; then
      rm -f -- "$d/access_token"; MAIL_LAST_DETAIL="gmail token endpoint: malformed 200 response"; return 1
    fi
    printf '%s\n' $(( $(date +%s) + exp - 60 )) >"$d/expires_at"   # renew a minute early
    return 0
  fi
  # error bodies are {"error": "...", "error_description": "..."}: keep the code only
  err="$(jq -r '.error // empty' "$d/token.json" 2>/dev/null | head -c 64 | tr -cd 'A-Za-z0-9_.-')"
  rm -f -- "$d/token.json"
  case "$err" in
    invalid_grant)
      MAIL_LAST_DETAIL="gmail oauth token invalid — owner must re-mint (invalid_grant: refresh token revoked or expired)"
      _GMAIL_DEAD="$MAIL_LAST_DETAIL"; return 3 ;;
    invalid_client|unauthorized_client|deleted_client|invalid_scope)
      MAIL_LAST_DETAIL="gmail oauth client invalid — owner must re-mint ($err, http $http)"
      _GMAIL_DEAD="$MAIL_LAST_DETAIL"; return 3 ;;
  esac
  MAIL_LAST_DETAIL="gmail token endpoint http $http${err:+ ($err)}"
  case "$http" in 429|5[0-9][0-9]) return 2 ;; *) return 1 ;; esac
}

# _send_gmail WORK EML — POST the RFC 822 message to the media upload endpoint of users.messages.send.
# 0 accepted (HTTP 200 + id) · 2 transient (429/5xx/rate limit: mail_send backs off) · 1 permanent.
# 401 -> one token refresh and one retry. Network errors are NOT retried here (the message may already
# have been accepted); the run fails and the next run (resume) re-sends only the parts without an id.
_send_gmail() {
  local work="$1" eml="$2" d resp http rc tok reason detail id thread ra tries=0
  if [[ -n "$_GMAIL_DEAD" ]]; then MAIL_LAST_DETAIL="$_GMAIL_DEAD; not sending"; return 1; fi
  _gmail_tokdir "$work" || { MAIL_LAST_DETAIL="cannot create the 0700 token dir"; return 1; }
  d="$_GMAIL_TOKDIR"; resp="$d/send.json"
  while :; do
    tries=$(( tries + 1 ))
    if ! _gmail_token_valid; then
      _gmail_refresh; rc=$?
      case "$rc" in 0) ;; 2) return 2 ;; *) return 1 ;; esac
    fi
    tok="$(<"$d/access_token")"
    : >"$resp"; : >"$d/send.hdr"
    set +e
    http="$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -sS --config - \
      --proto "$(_gmail_proto "$GMAIL_API_BASE")" --max-time "$MAIL_TIMEOUT_S" -X POST \
      -H 'Content-Type: message/rfc822' --data-binary "@$eml" -D "$d/send.hdr" -o "$resp" -w '%{http_code}' \
      "$GMAIL_API_BASE/upload/gmail/v1/users/me/messages/send?uploadType=media" 2>"$d/curl.err")"
    rc=$?
    set -e
    tok=""
    if (( rc != 0 )); then
      MAIL_LAST_DETAIL="gmail api: network error, curl exit $rc ($(head -c 160 "$d/curl.err" | tr '\n' ' ')); not retried in this run (it may have been accepted), the next run re-sends parts without an id"
      return 1
    fi
    if [[ "$http" == 200 ]]; then
      id="$(jq -r '.id // empty' "$resp" 2>/dev/null | tr -cd 'A-Za-z0-9_-')"
      thread="$(jq -r '.threadId // empty' "$resp" 2>/dev/null | tr -cd 'A-Za-z0-9_-')"
      # shellcheck disable=SC2034  # MAIL_LAST_THREAD is read by the sourcing scripts
      if [[ -n "$id" ]]; then MAIL_LAST_ID="$id"; MAIL_LAST_THREAD="$thread"; MAIL_LAST_DETAIL="gmail http 200"; return 0; fi
      MAIL_LAST_DETAIL="gmail http 200 without an id"; return 1
    fi
    if [[ "$http" == 401 ]]; then
      rm -f -- "$d/access_token" "$d/expires_at"
      if (( tries == 1 )); then log "gmail api 401: access token rejected; refreshing it once"; continue; fi
      MAIL_LAST_DETAIL="gmail api http 401 again after a token refresh"; return 1
    fi
    reason="$(jq -r '[(.error.errors[]?.reason), (.error.details[]?.reason), (.error.status)] | map(select(type=="string")) | unique | join(",")' "$resp" 2>/dev/null | head -c 160 | tr -cd 'A-Za-z0-9_,.-')"
    detail="gmail api http $http${reason:+ ($reason)}"
    ra="$(tr -d '\r' <"$d/send.hdr" | awk -F': *' 'tolower($1)=="retry-after" && $2 ~ /^[0-9]+$/ {print $2; exit}')"
    case "$http:$reason" in
      403:*insufficientPermissions*|403:*ACCESS_TOKEN_SCOPE_INSUFFICIENT*)
        MAIL_LAST_DETAIL="$detail: the token lacks the gmail.send scope — owner must re-mint"; return 1 ;;
      403:*dailyLimitExceeded*|403:*quotaExceeded*)
        MAIL_LAST_DETAIL="$detail: daily limit reached"; return 1 ;;
      403:*ateLimitExceeded*|429:*|5[0-9][0-9]:*)
        MAIL_LAST_DETAIL="$detail"; _MAIL_RETRY_AFTER="${ra:-0}"; return 2 ;;
    esac
    MAIL_LAST_DETAIL="$detail"; return 1
  done
}

# mail_alert JOB SUMMARY — best-effort failure notification: a small plain-text mail, no data, no
# attachments. Never fails the caller (the job is already failing and status.json says so).
mail_alert() {
  local job="$1" summary="$2" w
  email_enabled || return 0
  [[ -n "$ALERT_MAIL_TO" ]] || { log "no ALERT_MAIL_TO; alert not sent"; return 0; }
  w="$(mktemp -d)" || return 0
  {
    printf 'The %s job FAILED at %s (UTC).\n\n' "$job" "$(utc_now)"
    printf 'Reason: %s\n\n' "$summary"
    printf 'Nothing was reported as successful. Check the job log on the backup host:\n'
    printf '  %s/%s.log  and  backup-status.sh\n' "$LOG_DIR" "$job"
    printf '\nThis message contains no backup data.\n'
  } >"$w/body.txt"
  if mail_preflight 2>/dev/null && mail_send "$w" "$ALERT_MAIL_TO" "$MAIL_SUBJECT_TAG FAILED: $job $(date -u +%F)" "$w/body.txt" - "alert-$job-$(ts_now)"; then
    log "failure notification sent (${MAIL_LAST_DETAIL})"
  else
    log "failure notification could not be sent (${MAIL_LAST_DETAIL:-preflight failed})"
  fi
  gmail_forget_token
  rm -rf -- "$w"
  return 0
}

# gpg_pubkey_check FILE FPR — the file holds exactly one primary key with fingerprint FPR, not expired
# or revoked, with an encryption-capable (sub)key. Uses a throwaway homedir; imports nothing.
gpg_pubkey_check() {
  local file="$1" fpr="$2" h out pubs
  command -v gpg >/dev/null || { log "gpg not found"; return 1; }
  [[ -f "$file" ]] || { log "public key file $file missing"; return 1; }
  [[ "$fpr" =~ ^[0-9A-Fa-f]{40}$ ]] || { log "ARCHIVE_GPG_FPR must be a 40-hex fingerprint"; return 1; }
  h="$(mktemp -d)"; chmod 0700 "$h"
  out="$(gpg --homedir "$h" --batch --no-tty --with-colons --show-keys "$file" 2>/dev/null)" || { rm -rf -- "$h"; log "cannot parse $file"; return 1; }
  rm -rf -- "$h"
  pubs="$(grep -c '^pub:' <<<"$out" || true)"
  (( pubs == 1 )) || { log "$file must contain exactly one public key (has $pubs)"; return 1; }
  grep -q '^sec:' <<<"$out" && { log "$file contains SECRET key material; refusing"; return 1; }
  [[ "$(awk -F: '/^fpr:/{print $10; exit}' <<<"$out")" == "${fpr^^}" ]] || { log "fingerprint of $file does not match ARCHIVE_GPG_FPR"; return 1; }
  # usable encryption key: pub/sub line with validity not e(xpired)/r(evoked) and capability e
  awk -F: '($1=="pub"||$1=="sub") && $2!="e" && $2!="r" && $12 ~ /e/ {ok=1} END{exit !ok}' <<<"$out" \
    || { log "$file has no valid encryption-capable key (expired/revoked?)"; return 1; }
}

# gpg_encrypt_stream PUBFILE OUTFILE — stdin -> OpenPGP public-key encryption, AES256 preferred,
# compression off (inputs are already compressed). Integrity protection is verified afterwards.
gpg_encrypt_stream() {
  local pub="$1" outf="$2" h rc
  h="$(mktemp -d)"; chmod 0700 "$h"
  set +e
  gpg --homedir "$h" --batch --no-tty --quiet --trust-model always --no-auto-key-locate \
    --recipient-file "$pub" --compress-algo none --personal-cipher-preferences 'AES256 AES192 AES' \
    --encrypt --output "$outf"
  rc=$?
  set -e
  rm -rf -- "$h"
  return $rc
}

# gpg_integrity_ok FILE — the encrypted payload is integrity-protected: SEIPD with MDC (tag 18,
# mdc_method 2) or AEAD (tag 20 / v2 SEIPD). Reads packet headers only; no key needed.
gpg_integrity_ok() {
  local f="$1" h listing
  h="$(mktemp -d)"; chmod 0700 "$h"
  listing="$(gpg --homedir "$h" --batch --no-tty --list-packets "$f" 2>/dev/null || true)"
  rm -rf -- "$h"
  grep -q '^:pubkey enc packet:' <<<"$listing" || return 1
  grep -qE '^:aead encrypted packet:|^:encrypted data packet:' <<<"$listing" || return 1
  if grep -q '^:encrypted data packet:' <<<"$listing"; then
    grep -qE 'mdc_method: 2|aead' <<<"$listing" || return 1
  fi
  grep -q '^:symkey enc packet:' <<<"$listing" && return 1   # no passphrase (symmetric) recipients
  return 0
}

# json_state_write FILE JSON — atomic write of a small state file (0600).
json_state_write() {
  local f="$1" tmp
  tmp="$(mktemp "$(dirname "$f")/.state.XXXXXX")"
  printf '%s\n' "$2" >"$tmp" && chmod 0600 "$tmp" && mv -f "$tmp" "$f"
}
