#!/bin/bash
# mac-pull.sh — second backup tier (proposal §1, §3.2): the owner's Mac PULLS the
# lucashome backups over Tailscale SSH with keys that lucashome restricts to
# `rrsync -ro ...` (read-only, no shell). Nothing on lucashome can write to or
# delete this copy. Runs from launchd every 6 h (MAC-TIER.md) or by hand.
#
#   backups key  (rrsync -ro /srv/supabase/backups)      base/ dump/daily/ dump/weekly/ bundle/
#   volumes key  (rrsync -ro /srv/supabase/stack/volumes) db/wal_archive/ storage/
#   -> $DEST (default ~/shwephala-backups), rsync -a --ignore-existing, never --delete
#
# Prune on the Mac only (its own policy, nothing on lucashome can shorten it):
# base/dump/bundle by the timestamp in their names, WAL by mtime.
# Written for the stock macOS bash 3.2 and openrsync. Config: $CONFIG (KEY=VALUE).
set -eu

CONFIG="${SHWEPHALA_PULL_CONFIG:-$HOME/.config/shwephala-backup/pull.env}"
DRY_RUN=0; PRUNE=1; SNAPSHOT=0; CHECK_ONLY=0
usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--no-prune] [--snapshot] [--check] [--config FILE] [--help]
  --dry-run   rsync --dry-run; no files written, nothing pruned, no ping
  --no-prune  skip the local retention pass
  --snapshot  take an APFS local snapshot (tmutil localsnapshot) after a successful pull
  --check     only verify the config, keys, FileVault and that lucashome answers; no transfer
  --config    config file (default $CONFIG), keys:
                LUCASHOME_HOST=lucashome              ssh host alias or lucashome.tail8a86e4.ts.net
                PULL_KEY_BACKUPS=~/.ssh/shwephala-pull-backups
                PULL_KEY_VOLUMES=~/.ssh/shwephala-pull-volumes
                DEST=~/shwephala-backups
                KEEP_DAYS=90  KEEP_BUNDLE_DAYS=30  BWLIMIT_KBPS=   (empty = unlimited)
                HEALTHCHECKS_MAC_PULL_URL=            healthchecks.io "mac-pull" check (optional)
                TAILSCALE_BIN=/usr/local/bin/tailscale (optional; used only for the online check)
EOF
}
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-prune) PRUNE=0 ;;
    --snapshot) SNAPSHOT=1 ;;
    --check) CHECK_ONLY=1 ;;
    --config) CONFIG="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

LOG_DIR="$HOME/Library/Logs"; mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/shwephala-pull.log"
log() { printf '%s [mac-pull] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2; }
die() { log "ERROR: $*"; hc fail; exit 1; }

# ---------------------------------------------------------------------------
# config (defaults, then the file)
LUCASHOME_HOST=lucashome
PULL_KEY_BACKUPS="$HOME/.ssh/shwephala-pull-backups"
PULL_KEY_VOLUMES="$HOME/.ssh/shwephala-pull-volumes"
DEST="$HOME/shwephala-backups"
KEEP_DAYS=90
KEEP_BUNDLE_DAYS=30
BWLIMIT_KBPS=""
HEALTHCHECKS_MAC_PULL_URL=""
TAILSCALE_BIN=""
if [ -f "$CONFIG" ]; then
  # shellcheck source=/dev/null
  . "$CONFIG"
else
  log "config $CONFIG not found; using defaults (see MAC-TIER.md §2)"
fi
# expand a leading ~ written in the config file
untilde() { case "$1" in \~/*) printf '%s/%s' "$HOME" "${1#\~/}" ;; *) printf '%s' "$1" ;; esac; }
DEST="$(untilde "$DEST")"; PULL_KEY_BACKUPS="$(untilde "$PULL_KEY_BACKUPS")"; PULL_KEY_VOLUMES="$(untilde "$PULL_KEY_VOLUMES")"

hc() {  # healthchecks ping: start|fail|''
  [ -n "$HEALTHCHECKS_MAC_PULL_URL" ] || return 0
  [ "$DRY_RUN" -eq 0 ] || return 0
  local url="$HEALTHCHECKS_MAC_PULL_URL"
  case "${1:-}" in start) url="$url/start" ;; fail) url="$url/fail" ;; esac
  curl -fsS -m 10 --retry 3 -o /dev/null "$url" || log "healthchecks ping (${1:-ok}) failed"
}

# ---------------------------------------------------------------------------
# preconditions
case "$DEST" in "$HOME"/*) ;; *) log "ERROR: DEST=$DEST must be under $HOME (prune safety)"; exit 1 ;; esac
[ -f "$PULL_KEY_BACKUPS" ] || { log "ERROR: key $PULL_KEY_BACKUPS missing (MAC-TIER.md §1)"; exit 1; }
[ -f "$PULL_KEY_VOLUMES" ] || { log "ERROR: key $PULL_KEY_VOLUMES missing (MAC-TIER.md §1)"; exit 1; }
command -v rsync >/dev/null 2>&1 || { log "ERROR: rsync missing"; exit 1; }

ssh_opts() {  # KEY -> the -e argument for rsync
  printf 'ssh -i %s -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30' "$1"
}

# online check: tailscale (if available) then a harmless rsync listing through the restricted key
online() {
  local ts="$TAILSCALE_BIN"
  [ -n "$ts" ] || for c in /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do [ -x "$c" ] && { ts="$c"; break; }; done
  if [ -n "$ts" ] && [ -x "$ts" ]; then
    if ! "$ts" status 2>/dev/null | awk '{print $2}' | grep -qx "${LUCASHOME_HOST%%.*}"; then
      log "tailscale status does not list ${LUCASHOME_HOST%%.*}; skipping (not an error)"; return 1
    fi
  fi
  rsync --list-only -e "$(ssh_opts "$PULL_KEY_BACKUPS")" "$LUCASHOME_HOST:" >/dev/null 2>&1
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  log "config: host=$LUCASHOME_HOST dest=$DEST keep=${KEEP_DAYS}d bundles=${KEEP_BUNDLE_DAYS}d bwlimit=${BWLIMIT_KBPS:-off} ping=$([ -n "$HEALTHCHECKS_MAC_PULL_URL" ] && echo set || echo unset)"
  log "FileVault: $(fdesetup status 2>/dev/null || echo unknown)"
  log "rsync: $(rsync --version 2>/dev/null | head -n 1)"
  if online; then
    log "lucashome reachable through the backups key; listing:"
    rsync --list-only -e "$(ssh_opts "$PULL_KEY_BACKUPS")" "$LUCASHOME_HOST:" 2>&1 | tee -a "$LOG_FILE" >&2
    rsync --list-only -e "$(ssh_opts "$PULL_KEY_VOLUMES")" "$LUCASHOME_HOST:" 2>&1 | tee -a "$LOG_FILE" >&2
  else
    log "lucashome NOT reachable (offline, or the authorized_keys lines are missing)"
  fi
  exit 0
fi

if ! online; then
  log "lucashome offline or not reachable through the restricted key; nothing pulled"
  exit 0   # expected while travelling; healthchecks' grace period (48 h) catches a long outage
fi

hc start
START=$(date +%s)
mkdir -p "$DEST/base" "$DEST/dump/daily" "$DEST/dump/weekly" "$DEST/bundle" "$DEST/wal_archive" "$DEST/storage"
chmod 700 "$DEST"

RSYNC_FLAGS="-a --ignore-existing --partial --timeout=120 --itemize-changes"
[ -n "$BWLIMIT_KBPS" ] && RSYNC_FLAGS="$RSYNC_FLAGS --bwlimit=$BWLIMIT_KBPS"
[ "$DRY_RUN" -eq 1 ] && RSYNC_FLAGS="$RSYNC_FLAGS --dry-run"

pull() {  # KEY REMOTE_SUBDIR LOCAL_SUBDIR
  local key="$1" src="$2" dst="$3" out n
  # shellcheck disable=SC2086  # RSYNC_FLAGS is a deliberate word list
  if out="$(rsync $RSYNC_FLAGS --exclude '*.partial' --exclude '*.partial/' --exclude '*.tmp' --exclude '.*' \
          -e "$(ssh_opts "$key")" "$LUCASHOME_HOST:$src/" "$DEST/$dst/" 2>>"$LOG_FILE")"; then
    n="$(printf '%s\n' "$out" | grep -c '^>f' || true)"
    log "pulled $src -> $DEST/$dst: $n new file(s)"
  else
    log "rsync of $src failed (rc=$?)"; return 1
  fi
}

RC=0
pull "$PULL_KEY_BACKUPS" base base            || RC=1
pull "$PULL_KEY_BACKUPS" dump/daily dump/daily   || RC=1
pull "$PULL_KEY_BACKUPS" dump/weekly dump/weekly || RC=1
pull "$PULL_KEY_BACKUPS" bundle bundle        || RC=1
pull "$PULL_KEY_VOLUMES" db/wal_archive wal_archive || RC=1
pull "$PULL_KEY_VOLUMES" storage storage      || RC=1
[ "$RC" -eq 0 ] || die "one or more pulls failed (see $LOG_FILE)"

# ---------------------------------------------------------------------------
# local retention: timestamps in names for base/dump/bundle, mtime for WAL. Only under $DEST.
if [ "$PRUNE" -eq 1 ]; then
  CUT="$(date -u -v-"${KEEP_DAYS}"d +%Y%m%dT%H%M%SZ)"
  CUT_B="$(date -u -v-"${KEEP_BUNDLE_DAYS}"d +%Y%m%dT%H%M%SZ)"
  n=0
  for d in "$DEST"/base/* "$DEST"/dump/daily/* "$DEST"/dump/weekly/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"; ts="${name##*_}"   # weekly dirs are <ISO week>_<ts>
    case "$ts" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) continue ;; esac
    if [ "$ts" \< "$CUT" ]; then
      log "prune $d"; [ "$DRY_RUN" -eq 1 ] || rm -rf "$d"; n=$((n + 1))
    fi
  done
  for f in "$DEST"/bundle/*.tar.age; do
    [ -f "$f" ] || continue
    ts="$(basename "$f" .tar.age)"
    if [ "$ts" \< "$CUT_B" ]; then log "prune $f"; [ "$DRY_RUN" -eq 1 ] || rm -f "$f"; n=$((n + 1)); fi
  done
  # WAL: by mtime (rsync -a preserves it); never *.history
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    log "prune $f"; [ "$DRY_RUN" -eq 1 ] || rm -f "$f"; n=$((n + 1))
  done <<EOF
$(find "$DEST/wal_archive" -type f -name '*.gz' ! -name '*.history*' -mtime +"$KEEP_DAYS" 2>/dev/null)
EOF
  log "prune: removed $n item(s) older than ${KEEP_DAYS} d (bundles ${KEEP_BUNDLE_DAYS} d)"
fi

if [ "$SNAPSHOT" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  if tmutil localsnapshot >>"$LOG_FILE" 2>&1; then log "APFS local snapshot taken (tmutil localsnapshot)"
  else log "tmutil localsnapshot failed (Time Machine not configured?) — see MAC-TIER.md §4"; fi
fi

cnt() { find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' '; }
log "done in $(( $(date +%s) - START ))s: $(du -sh "$DEST" 2>/dev/null | cut -f1) in $DEST (base $(cnt "$DEST/base"), daily $(cnt "$DEST/dump/daily"), weekly $(cnt "$DEST/dump/weekly"), bundles $(cnt "$DEST/bundle"), wal $(cnt "$DEST/wal_archive"))"
hc
