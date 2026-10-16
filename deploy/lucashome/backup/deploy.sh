#!/usr/bin/env bash
# deploy.sh — run on the Mac: copy the backup scripts to lucashome:/srv/supabase/backup/bin/
# and (optionally) install the crontab. The repo copy is the source of truth.
#   ./deploy.sh            sync scripts + create backup.env from the example if absent
#   ./deploy.sh --cron     also install crontab.lucario for the SSH user
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${LUCASHOME:-lucashome}"
REMOTE_BASE=/srv/supabase/backup

INSTALL_CRON=0
for a in "$@"; do
  case "$a" in
    --cron) INSTALL_CRON=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 1 ;;
  esac
done

ssh "$HOST" "mkdir -p $REMOTE_BASE/bin && chmod 0700 $REMOTE_BASE $REMOTE_BASE/bin"
# mac-pull.sh runs on the Mac (MAC-TIER.md), not on lucashome
# sweep-abandoned-uploads.{sql,sh} + sweep-protected-objects.sha256: G5 follow-up (not scheduled)
# email tier helpers: email-*.py + gmail-oauth-mint.py (--check on the server; stdlib python) and email-report.sql live next to the scripts; tests/ is never copied
rsync -a --delete --exclude deploy.sh --exclude mac-pull.sh --exclude owner-key-setup.sh --exclude tests/ --include '*.sh' --include 'email-*.py' --include 'gmail-oauth-mint.py' --include 'email-*.sql' --include 'sweep-abandoned-uploads.sql' --include 'sweep-protected-objects.sha256' --exclude '*' "$HERE/" "$HOST:$REMOTE_BASE/bin/"
ssh "$HOST" "chmod 0700 $REMOTE_BASE/bin/*.sh && chmod 0600 $REMOTE_BASE/bin/email-*.py $REMOTE_BASE/bin/gmail-oauth-mint.py $REMOTE_BASE/bin/email-*.sql $REMOTE_BASE/bin/sweep-abandoned-uploads.sql $REMOTE_BASE/bin/sweep-protected-objects.sha256"
# syntax check with the target's bash (macOS ships bash 3.2, the scripts need 4+)
ssh "$HOST" "for f in $REMOTE_BASE/bin/*.sh; do bash -n \"\$f\" || exit 1; done && echo 'remote bash -n: ok'"
# config: never overwrite a live backup.env
rsync -a --ignore-existing "$HERE/backup.env.example" "$HOST:$REMOTE_BASE/backup.env"
ssh "$HOST" "chmod 0600 $REMOTE_BASE/backup.env"
# offsite tier: the rclone.conf TEMPLATE only (the real rclone.conf is written by the owner, never by this script)
rsync -a "$HERE/rclone.conf.example" "$HOST:$REMOTE_BASE/rclone.conf.example"
ssh "$HOST" "chmod 0600 $REMOTE_BASE/rclone.conf.example"
echo "deployed to $HOST:$REMOTE_BASE/bin/"
ssh "$HOST" "ls -l $REMOTE_BASE/bin/ $REMOTE_BASE/backup.env"

if (( INSTALL_CRON )); then
  ssh "$HOST" "crontab -" <"$HERE/crontab.lucario"
  echo "crontab installed:"
  ssh "$HOST" "crontab -l"
fi
