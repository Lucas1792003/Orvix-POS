#!/usr/bin/env bash
# email-secrets.sh — the SEPARATE encrypted secrets file that pairs with the weekly archive.
#   stack/.env                     JWT secret, API keys, DB passwords, SMTP settings
#   db-config/                     pgsodium_root.key (+ conf.d) from the db-config volume (docker mode)
#   backup/backup.env              backup configuration
#   backup/report-targets.conf     daily-report routing (if present)
# NOT included: the mail credential files (RESEND_KEY_FILE / SMTP_NETRC_FILE) — a rebuilt host gets a
# fresh send-only key from the owner.
#
# tar | gpg (owner PUBLIC key, same as the archive) -> $SECRETS_DIR/<ts>.tar.gpg (0600). Plaintext is
# never written: tar streams into gpg (docker mode: tar runs in a throwaway container with every
# input mounted read-only, the only way to read the db-config volume without sudo).
#
# EMAIL_SECRETS_MODE: off (do nothing) | local (default: build + keep newest $KEEP_SECRETS on this host;
# the owner copies one off by hand when they choose) | email (also mail it, but only when the
# secret set changed since the last mailed copy, compared by a keyed hash so nothing about the
# content is revealed). --send forces one mail now (still needs EMAIL_ENABLED=true).
set -euo pipefail
# shellcheck source=email-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/email-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--send] [--help]
  --dry-run  list inputs (existence only; no content is read)
  --send     mail this build now even if unchanged (EMAIL_ENABLED must be true)
Mode: $EMAIL_SECRETS_MODE  output: $SECRETS_DIR  tar mode: $BUNDLE_TAR_MODE
EOF
}
SEND_NOW=0
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --send) SEND_NOW=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

# shellcheck disable=SC2034  # read by backup-lib.sh (log prefix, lock + log file names)
JOB_NAME=email-secrets
init_logging
if [[ "$EMAIL_SECRETS_MODE" == off ]] && (( ! SEND_NOW )); then log "EMAIL_SECRETS_MODE=off; nothing to do"; exit 0; fi
acquire_lock
TS="$(ts_now)"; START=$SECONDS
FINAL="$SECRETS_DIR/$TS.tar.gpg"; TMP="$FINAL.tmp"; WORK=""

cleanup() {
  local rc=$?
  trap - EXIT
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf -- "$WORK"
  if (( rc != 0 )); then
    rm -f -- "$TMP"
    log "FAILED (rc=$rc)"
    if (( ! DRY_RUN )); then
      status_update email-secrets "$(jq -nc --arg t "$(utc_now)" --arg m "exit $rc, see $LOG_FILE" '{last_run:$t,last_result:"fail",message:$m}')" || true
      mail_alert email-secrets "secrets file job failed (exit $rc)"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

INPUTS=(
  "stack/.env|$STACK_DIR/.env|required"
  "backup/backup.env|$BACKUP_ENV|optional"
  "backup/report-targets.conf|$REPORT_TARGETS_FILE|optional"
)
PRESENT=()
for e in "${INPUTS[@]}"; do
  IFS='|' read -r ap hp req <<<"$e"
  if [[ -e "$hp" ]]; then PRESENT+=("$ap|$hp"); log "member $ap <- $hp"
  elif [[ "$req" == required ]]; then die "required input missing: $hp"
  else log "absent (skipped): $hp"; fi
done
VOLUME_OK=0
if [[ "$BUNDLE_TAR_MODE" == docker ]]; then
  if docker volume inspect "$DB_CONFIG_VOLUME" >/dev/null 2>&1; then VOLUME_OK=1; log "member db-config/ <- volume $DB_CONFIG_VOLUME (ro)"
  else warn "docker volume $DB_CONFIG_VOLUME not found: pgsodium_root.key NOT included"; fi
else
  warn "BUNDLE_TAR_MODE=$BUNDLE_TAR_MODE: db-config volume (pgsodium_root.key) not included"
fi
gpg_pubkey_check "$ARCHIVE_GPG_PUBKEY" "$ARCHIVE_GPG_FPR" || die "recipient public key check failed"
if (( DRY_RUN )); then log "DRY-RUN: would encrypt the members above to $ARCHIVE_GPG_FPR -> $FINAL"; trap - EXIT; exit 0; fi

mkdir -p "$SECRETS_DIR" && chmod 0700 "$SECRETS_DIR"
WORK="$(mktemp -d "$BACKUP_ROOT/.email-secrets.XXXXXX")"; chmod 0700 "$WORK"

# stream_inputs CMD — runs CMD (a sh snippet) with every member visible under /src (docker: read-only
# mounts in a throwaway container; host: a 0700 dir of symlinks, read in place).
stream_inputs() {
  local cmd="$1" p ap hp
  if [[ "$BUNDLE_TAR_MODE" == docker ]]; then
    local -a m=(--rm --network none --memory 256m)
    for p in "${PRESENT[@]}"; do IFS='|' read -r ap hp <<<"$p"; m+=(-v "$hp:/src/$ap:ro"); done
    (( VOLUME_OK )) && m+=(-v "$DB_CONFIG_VOLUME:/src/db-config:ro")
    docker run "${m[@]}" --entrypoint sh "$PG_IMAGE" -c "cd /src && $cmd"
  else
    local stage="$WORK/stage"
    if [[ ! -d "$stage" ]]; then
      mkdir -p "$stage"
      for p in "${PRESENT[@]}"; do IFS='|' read -r ap hp <<<"$p"; mkdir -p "$stage/$(dirname "$ap")"; ln -s "$(realpath -e -- "$hp")" "$stage/$ap"; done
    fi
    (cd "$stage" && sh -c "$cmd")
  fi
}
SUMS_CMD='find -L . -type f -print0 | sort -z | xargs -0 sha256sum'
TAR_CMD='tar -h -cf - .'

# change detection without revealing anything: HMAC (random per-host key, 0600, next to the bundles)
# over the per-file sha256 list, streamed through a pipe. Only "changed / unchanged" is derived from it.
SALT_FILE="$SECRETS_DIR/.change-salt"
[[ -f "$SALT_FILE" ]] || { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$SALT_FILE"; chmod 0600 "$SALT_FILE"; }
FPRINT="$(stream_inputs "$SUMS_CMD" | python3 -I -c '
import hmac, hashlib, sys
k = open(sys.argv[1]).read().strip().encode()
print(hmac.new(k, sys.stdin.buffer.read(), hashlib.sha256).hexdigest())' "$SALT_FILE")" || die "fingerprint failed"

set +e
stream_inputs "$TAR_CMD" | gpg_encrypt_stream "$ARCHIVE_GPG_PUBKEY" "$TMP"
ps=("${PIPESTATUS[@]}")
set -e
(( ps[0] == 0 )) || die "tar stream failed (rc=${ps[0]})"
(( ps[1] == 0 )) || die "gpg failed (rc=${ps[1]})"
gpg_integrity_ok "$TMP" || die "output is not an integrity-protected public-key OpenPGP message"
chmod 0600 "$TMP"; mv -f "$TMP" "$FINAL"
SIZE="$(stat -c %s "$FINAL")"
log "secrets file $FINAL ($(human "$SIZE"), db_config_included=$VOLUME_OK)"

SENT="no"
LAST_SENT_FP="$(jq -r '.jobs["email-secrets"].last_sent_fingerprint // ""' "$STATUS_FILE" 2>/dev/null || true)"
if (( SEND_NOW )) || [[ "$EMAIL_SECRETS_MODE" == email && "$FPRINT" != "$LAST_SENT_FP" ]]; then
  email_gate
  [[ -n "$ARCHIVE_MAIL_TO" ]] || die "ARCHIVE_MAIL_TO is not set"
  mail_preflight || die "mail transport preflight failed"
  {
    printf 'Encrypted SECRETS file %s for the recovery archive.\n\n' "$(basename "$FINAL")"
    printf 'Contains: stack .env, db-config (pgsodium root key: %s), backup config.\n' "$( (( VOLUME_OK )) && echo included || echo NOT included)"
    printf 'Encrypted to the owner key %s. sha256 %s, %s bytes.\n' "${ARCHIVE_GPG_FPR^^}" "$(sha256sum "$FINAL" | cut -d' ' -f1)" "$SIZE"
    printf 'Store it apart from the weekly archives (e.g. label it secrets). Sent only when the set changes.\n'
  } >"$WORK/body.txt"
  mail_send "$WORK" "$ARCHIVE_MAIL_TO" "$MAIL_SUBJECT_TAG secrets $TS" "$WORK/body.txt" - "secrets-$TS" \
    "$FINAL::$ARCHIVE_LABEL-secrets-$TS.tar.gpg::application/octet-stream" || die "secrets mail NOT accepted: $MAIL_LAST_DETAIL"
  SENT="yes"; log "secrets mail accepted: $MAIL_LAST_DETAIL id=$MAIL_LAST_ID"
fi

FRAG="$(jq -nc --arg t "$(utc_now)" --arg f "$FINAL" --argjson s "$SIZE" --argjson vol "$VOLUME_OK" --arg sent "$SENT" --arg fp "$FPRINT" --arg id "$MAIL_LAST_ID" \
  '{last_run:$t,last_success:$t,last_result:"ok",message:"ok",file:$f,size_bytes:$s,db_config_included:($vol==1),mailed:($sent=="yes")}
   + (if $sent=="yes" then {last_sent:$t,last_sent_fingerprint:$fp,last_message_id:$id} else {} end)')"
status_update email-secrets "$FRAG"

# retention: newest KEEP_SECRETS <ts>.tar.gpg in SECRETS_DIR only
while IFS= read -r f; do
  [[ "$f" =~ ^[0-9]{8}T[0-9]{6}Z\.tar\.gpg$ ]] || continue
  rm -f -- "${SECRETS_DIR:?}/$f"; log "pruned $f"
done < <(find "$SECRETS_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tar.gpg' -printf '%f\n' | LC_ALL=C sort -r | tail -n +$(( KEEP_SECRETS + 1 )))
trap - EXIT
rm -rf -- "$WORK"
log "done (mailed=$SENT, $(( SECONDS - START ))s)"
