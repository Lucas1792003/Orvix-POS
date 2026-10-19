#!/usr/bin/env bash
# deploy.sh — run on the Mac: copy the backup scripts to lucashome:/srv/supabase/backup/bin/
# and (optionally) install the crontab. The repo copy is the source of truth.
#   ./deploy.sh                    stage + verify the package locally, sync it, create backup.env if absent
#   ./deploy.sh --cron             also install crontab.lucario for the SSH user
#   ./deploy.sh --package-to DIR   LOCAL ONLY (no ssh): stage + verify the package into DIR (new or empty)
# The package is checked against deploy-manifest.txt BEFORE anything is copied: a missing or empty
# required file (e.g. a dr-*.sql the restore gate needs) or an unlisted file stops the deploy.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
HOST="${LUCASHOME:-lucashome}"
REMOTE_BASE=/srv/supabase/backup

INSTALL_CRON=0; PKG_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cron) INSTALL_CRON=1; shift ;;
    # an empty value must never fall through to a real deploy
    --package-to) [ -n "${2:-}" ] || { echo "--package-to needs a non-empty directory" >&2; exit 1; }; PKG_DIR=$2; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# mac-pull.sh runs on the Mac (MAC-TIER.md), not on lucashome
# sweep-abandoned-uploads.{sql,sh} + sweep-protected-objects.sha256: G5 follow-up (not scheduled)
# email tier helpers: email-*.py + gmail-oauth-mint.py (--check on the server; stdlib python) and email-report.sql live next to the scripts; tests/ is never copied
# disaster recovery: dr-*.sql (the restore gate's checks + the post-restore fix-ups) next to dr-verify-restore.sh
# MANIFEST.sha256 + PACKAGE: written into the stage by this script. Files on the server that match no
# --include stay untouched (rsync never deletes an excluded path), as before.
FILTER=(--exclude deploy.sh --exclude mac-pull.sh --exclude owner-key-setup.sh --exclude tests/
  --include '*.sh' --include 'email-*.py' --include 'gmail-oauth-mint.py' --include 'email-*.sql' --include 'dr-*.sql'
  --include 'sweep-abandoned-uploads.sql' --include 'sweep-protected-objects.sha256'
  --include MANIFEST.sha256 --include PACKAGE --exclude '*')
SECRET_MODE_FILES="email-*.py gmail-oauth-mint.py email-*.sql dr-*.sql sweep-abandoned-uploads.sql sweep-protected-objects.sha256 MANIFEST.sha256 PACKAGE"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
die() { echo "DEPLOY REFUSED: $*" >&2; exit 1; }

stage() {  # DIR — the exact package, verified against the manifest; nothing leaves the Mac here
  local S=$1 f req extra n
  mkdir -p "$S/bin" "$S/migrations"
  rsync -a --delete "${FILTER[@]}" "$HERE/" "$S/bin/"
  rm -f "$S/bin/MANIFEST.sha256" "$S/bin/PACKAGE"
  req=$(grep -vE '^[[:space:]]*(#|$)' "$HERE/deploy-manifest.txt" | sort -u)
  [ -n "$req" ] || die "deploy-manifest.txt lists nothing"
  for f in $req; do
    [ -s "$S/bin/$f" ] || die "required component $f is missing or empty in the package (deploy-manifest.txt)"
  done
  extra=$(cd "$S/bin" && find . -type f | sed 's#^\./##' | sort | comm -23 - <(printf '%s\n' "$req"))
  [ -z "$extra" ] || die "file(s) not in deploy-manifest.txt would be deployed: $(echo $extra) — list them first"
  # the migration source dr-verify-restore.sh --migrations reads (the server has no repo checkout)
  # the gate compares the ledger's sha256 with these files: an uncommitted edit would ship a source production never ran
  if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 && [ -n "$(git -C "$REPO" status --porcelain -- supabase/migrations)" ]; then
    die "supabase/migrations has uncommitted changes: commit or stash them first (the gate's migration source must be a commit)"
  fi
  rsync -a --delete --include '[0-9][0-9][0-9]_*.sql' --exclude '*' "$REPO/supabase/migrations/" "$S/migrations/"
  n=$(find "$S/migrations" -name '[0-9][0-9][0-9]_*.sql' | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] || die "no migrations found in $REPO/supabase/migrations"
  (cd "$S/migrations" && sha ./*.sql > SHA256SUMS)
  { echo "commit $(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)$( [ -n "$(git -C "$REPO" status --porcelain -- deploy/lucashome/backup supabase/migrations 2>/dev/null)" ] && echo ' +uncommitted changes')"
    echo "staged $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "migrations $n, latest $(find "$S/migrations" -name '[0-9][0-9][0-9]_*.sql' | sed 's#.*/##' | sort | tail -1 | cut -c1-3)"; } > "$S/bin/PACKAGE"
  (cd "$S/bin" && sha $req PACKAGE > MANIFEST.sha256)
  echo "package verified: $(printf '%s\n' "$req" | wc -l | tr -d ' ') required components (deploy-manifest.txt) + $n migrations"
}

if [ -n "$PKG_DIR" ]; then
  if [ -e "$PKG_DIR" ] && [ -n "$(ls -A "$PKG_DIR" 2>/dev/null)" ]; then die "--package-to $PKG_DIR exists and is not empty"; fi
  stage "$PKG_DIR"
  echo "packaged to $PKG_DIR (local only: nothing was sent to $HOST)"
  exit 0
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/phf-backup-deploy.XXXXXX"); trap 'rm -rf "$STAGE"' EXIT
stage "$STAGE"

ssh "$HOST" "mkdir -p $REMOTE_BASE/bin $REMOTE_BASE/migrations && chmod 0700 $REMOTE_BASE $REMOTE_BASE/bin $REMOTE_BASE/migrations"
rsync -a --delete "${FILTER[@]}" "$STAGE/bin/" "$HOST:$REMOTE_BASE/bin/"
rsync -a --delete --include '[0-9][0-9][0-9]_*.sql' --include SHA256SUMS --exclude '*' "$STAGE/migrations/" "$HOST:$REMOTE_BASE/migrations/"
ssh "$HOST" "cd $REMOTE_BASE/bin && chmod 0700 *.sh && chmod 0600 $SECRET_MODE_FILES && chmod 0600 $REMOTE_BASE/migrations/*"
# what arrived is exactly what was staged, and the gate finds its SQL + migration source
ssh "$HOST" "cd $REMOTE_BASE/bin && sha256sum --quiet -c MANIFEST.sha256 && cd $REMOTE_BASE/migrations && sha256sum --quiet -c SHA256SUMS && echo 'remote manifest: ok'" \
  || die "the server's copy does not match the staged manifest"
ssh "$HOST" "$REMOTE_BASE/bin/dr-verify-restore.sh preflight --migrations $REMOTE_BASE/migrations --expect-version \$(ls $REMOTE_BASE/migrations | grep -E '^[0-9]{3}_' | sort | tail -1 | cut -c1-3)" \
  || die "restore gate preflight failed on the server"
# syntax check with the target's bash (macOS ships bash 3.2, the scripts need 4+)
ssh "$HOST" "for f in $REMOTE_BASE/bin/*.sh; do bash -n \"\$f\" || exit 1; done && echo 'remote bash -n: ok'"
# config: never overwrite a live backup.env
rsync -a --ignore-existing "$HERE/backup.env.example" "$HOST:$REMOTE_BASE/backup.env"
ssh "$HOST" "chmod 0600 $REMOTE_BASE/backup.env"
# offsite tier: the rclone.conf TEMPLATE only (the real rclone.conf is written by the owner, never by this script)
rsync -a "$HERE/rclone.conf.example" "$HOST:$REMOTE_BASE/rclone.conf.example"
ssh "$HOST" "chmod 0600 $REMOTE_BASE/rclone.conf.example"
echo "deployed to $HOST:$REMOTE_BASE/bin/ (+ migrations/ for the restore gate)"
ssh "$HOST" "ls -l $REMOTE_BASE/bin/ $REMOTE_BASE/backup.env; cat $REMOTE_BASE/bin/PACKAGE"

if (( INSTALL_CRON )); then
  ssh "$HOST" "crontab -" <"$HERE/crontab.lucario"
  echo "crontab installed:"
  ssh "$HOST" "crontab -l"
fi
