#!/usr/bin/env bash
# offsite-lib.sh — helpers shared by the offsite tier (offsite-sync.sh,
# secrets-bundle.sh, offsite-restore-test.sh, offsite-status.sh).
# Sourced AFTER backup-lib.sh; not meant to be executed directly.
# shellcheck shell=bash
#
# Gate: every offsite script calls offsite_gate right after parsing its
# arguments. Unless OFFSITE_ENABLED is exactly "true" it prints
# "offsite disabled" and exits 0, so the scripts can be deployed and even
# wired into cron while the owner has not finished OFFSITE-ENABLE.md.
# Once enabled, offsite_require_config fails CLOSED (exit 1) when rclone,
# the config file or the remote is missing — never silently.

set -euo pipefail

# shellcheck disable=SC2034  # used by the sourcing scripts
OFFSITE_TIERS=(wal dump base storage bundle check)   # remote prefixes: wal/ dump/ base/ storage/ bundle/ .versions/<tier>/<date>/ golden/
# shellcheck disable=SC2034
BUNDLE_RE='^[0-9]{8}T[0-9]{6}Z\.tar\.age$'

offsite_enabled() { [[ "${OFFSITE_ENABLED:-false}" == true ]]; }

# offsite_gate — exit 0 with the canonical message when the tier is disabled.
offsite_gate() {
  if ! offsite_enabled; then
    log "offsite disabled (OFFSITE_ENABLED=${OFFSITE_ENABLED:-unset} in $BACKUP_ENV); nothing to do — see OFFSITE-ENABLE.md"
    exit 0
  fi
}

# offsite_require_config [bundle] — fail closed when enabled but not usable.
# Never prints a line of the rclone config; only its existence, mode and remote names.
# shellcheck disable=SC2120  # the optional argument is used by secrets-bundle.sh only
offsite_require_config() {
  local need_age="${1:-}" mode
  [[ "$OFFSITE_REMOTE" == *: ]] || die "OFFSITE_REMOTE must end with ':' (got '$OFFSITE_REMOTE')"
  command -v rclone >/dev/null 2>&1 || die "rclone not installed (owner: sudo apt install rclone  — or https://rclone.org/install.sh)"
  [[ -f "$RCLONE_CONFIG" ]] || die "rclone config $RCLONE_CONFIG missing (owner creates it with: rclone config --config $RCLONE_CONFIG ; see OFFSITE-ENABLE.md)"
  mode="$(stat -c %a "$RCLONE_CONFIG" 2>/dev/null || echo '?')"
  [[ "$mode" == 600 ]] || warn "$RCLONE_CONFIG mode is $mode (expected 600)"
  rclone --config "$RCLONE_CONFIG" listremotes 2>/dev/null | grep -qx -- "$OFFSITE_REMOTE" \
    || die "remote '$OFFSITE_REMOTE' not defined in $RCLONE_CONFIG (remotes: $(rclone --config "$RCLONE_CONFIG" listremotes 2>/dev/null | tr '\n' ' '))"
  [[ "$(rclone --config "$RCLONE_CONFIG" config show "${OFFSITE_REMOTE%:}" 2>/dev/null | grep -E '^type *=' | awk -F= '{gsub(/ /,"",$2); print $2}')" == crypt ]] \
    || warn "remote '$OFFSITE_REMOTE' is not a crypt remote — objects would land unencrypted (OFFSITE-ENABLE.md §2)"
  if [[ "$need_age" == bundle ]]; then bundle_require_age; fi
}

bundle_require_age() {
  command -v age >/dev/null 2>&1 || die "age not installed (owner: sudo apt install age  — Ubuntu package age 1.2.x); refusing to build an unencrypted bundle"
  [[ -n "$AGE_RECIPIENT" ]] || die "AGE_RECIPIENT is empty in $BACKUP_ENV (the owner's age1... public key; OFFSITE-ENABLE.md §4)"
  local r
  for r in $AGE_RECIPIENT; do
    [[ "$r" =~ ^age1[0-9a-z]{20,}$ ]] || die "AGE_RECIPIENT entry does not look like an age public key (age1...): '${r:0:12}…'"
  done
}

# ---------------------------------------------------------------------------
# rclone wrappers. Common flags come from backup.env; --dry-run is forwarded
# for mutating commands. Output of mutating commands is appended to the job log.
# ---------------------------------------------------------------------------
_rc_common() {
  local -a f=(--config "$RCLONE_CONFIG" --transfers "$OFFSITE_TRANSFERS" --checkers "$OFFSITE_CHECKERS"
    --retries 3 --low-level-retries 10 --stats 60s --stats-one-line --stats-log-level NOTICE --log-level INFO)
  [[ -n "$OFFSITE_BWLIMIT" ]] && f+=(--bwlimit "$OFFSITE_BWLIMIT")
  printf '%s\n' "${f[@]}"
}

# rc_ro CMD ARGS... — read-only rclone command; stdout is returned to the caller.
rc_ro() {
  local -a common; mapfile -t common < <(_rc_common)
  rclone "${common[@]}" --log-level NOTICE "$@"
}

# rc_mut CMD ARGS... — mutating rclone command (sync/copy/delete/purge/rmdirs); logs to the job log; dry-run aware.
rc_mut() {
  local -a common; mapfile -t common < <(_rc_common)
  local -a dry=()
  (( DRY_RUN )) && dry=(--dry-run)
  log "rclone $1 ${dry[*]:-} ${*:2}"
  rclone "${common[@]}" "${dry[@]}" "$@" 2>&1 | tee -a "$LOG_FILE" >&2
  return "${PIPESTATUS[0]}"
}

# remote_size PREFIX — {"count":N,"bytes":B} of OFFSITE_REMOTE/PREFIX (one listing); "{}" on failure.
remote_size() {
  rc_ro size --json "${OFFSITE_REMOTE}$1" 2>/dev/null || echo '{}'
}

# offsite_check SRC_DIR PREFIX ONE_WAY [rclone filter flags...] — verify SRC against OFFSITE_REMOTE/PREFIX
# with cryptcheck (crypt remotes: plaintext md5 vs the hash of the encrypted object), check (size only
# on crypt) or none. ONE_WAY is "one-way" or "". Sync-only flags (--backup-dir X, --size-only) in the
# list are dropped. Sets CHECK_MISMATCHES / CHECK_ERRORS; returns 1 when anything differs.
CHECK_MISMATCHES=0; CHECK_ERRORS=0
offsite_check() {
  local src="$1" prefix="$2" one="$3" cmd rc out a skip=0
  shift 3
  local -a filt=()
  for a in "$@"; do
    if (( skip )); then skip=0; continue; fi
    case "$a" in --backup-dir) skip=1; continue ;; --size-only) continue ;; esac
    filt+=("$a")
  done
  set -- ${filt[@]+"${filt[@]}"}
  CHECK_MISMATCHES=0; CHECK_ERRORS=0
  case "$OFFSITE_CHECK" in
    none) log "check skipped (OFFSITE_CHECK=none) for $prefix"; return 0 ;;
    check) cmd=check ;;
    cryptcheck) cmd=cryptcheck ;;
    *) die "OFFSITE_CHECK must be cryptcheck|check|none (got $OFFSITE_CHECK)" ;;
  esac
  local -a flags=()
  [[ "$one" == one-way ]] && flags+=(--one-way)
  if (( DRY_RUN )); then log "DRY-RUN: rclone $cmd ${flags[*]:-} $src ${OFFSITE_REMOTE}$prefix $*"; return 0; fi
  log "rclone $cmd ${flags[*]:-} $src -> ${OFFSITE_REMOTE}$prefix $*"
  out="$(mktemp "$BACKUP_ROOT/.check.XXXXXX")"
  set +e
  rc_ro "$cmd" "${flags[@]}" "$src" "${OFFSITE_REMOTE}$prefix" "$@" >"$out" 2>&1
  rc=$?
  set -e
  CHECK_MISMATCHES="$(grep -oE '[0-9]+ differences found' "$out" | tail -n 1 | awk '{print $1}')"; : "${CHECK_MISMATCHES:=0}"
  CHECK_ERRORS="$(grep -oE '[0-9]+ errors while checking' "$out" | tail -n 1 | awk '{print $1}')"; : "${CHECK_ERRORS:=0}"
  if (( rc != 0 )); then
    (( CHECK_MISMATCHES == 0 && CHECK_ERRORS == 0 )) && CHECK_ERRORS=1   # listing/connection failure
    log "$cmd $prefix: rc=$rc differences=$CHECK_MISMATCHES errors=$CHECK_ERRORS"
    grep -E 'ERROR|NOTICE' "$out" | tail -n 20 | sed 's/^/  check: /' | tee -a "$LOG_FILE" >&2 || true
    rm -f "$out"; return 1
  fi
  log "$cmd $prefix: ok ($(grep -oE '[0-9]+ matching files' "$out" | tail -n 1 || echo 'summary n/a'))"
  rm -f "$out"
  return 0
}

# ---------------------------------------------------------------------------
# offsite.json — same shape as status.json: {"jobs": {<tier>: {...}}, "updated_at": ...}
# ---------------------------------------------------------------------------
offsite_update() { json_update "$OFFSITE_STATUS_FILE" "$1" "$2"; }

# ---------------------------------------------------------------------------
# healthchecks.io: hc_ping URL [start|fail|''] [BODY_FILE]. No-op when URL is empty or in --dry-run.
# ---------------------------------------------------------------------------
hc_ping() {
  local url="$1" kind="${2:-}" body="${3:-}"
  [[ -n "$url" ]] || return 0
  if (( DRY_RUN )); then log "DRY-RUN: healthchecks ping ${kind:-ok}"; return 0; fi
  case "$kind" in start) url="$url/start" ;; fail) url="$url/fail" ;; esac
  if [[ -n "$body" && -f "$body" ]]; then
    curl -fsS -m 10 --retry 3 -o /dev/null --data-binary "$(tail -n 20 "$body")" "$url" || log "healthchecks ping (${kind:-ok}) failed"
  else
    curl -fsS -m 10 --retry 3 -o /dev/null "$url" || log "healthchecks ping (${kind:-ok}) failed"
  fi
}

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------
date_utc() { date -u +%Y%m%d; }

# days_before N — YYYYMMDD of N days ago (UTC)
days_before() { date -u -d "$1 days ago" +%Y%m%d; }

# wal_gaps < names — prints "A..B" gaps in a list of 24-hex segment names (current timeline only)
wal_gaps() {
  python3 -I -c '
import sys
names = sorted(l.strip()[:24] for l in sys.stdin if len(l.strip()) >= 24)
if names:
    tl = names[-1][:8]
    segs = [n for n in names if n.startswith(tl)]
    idx = [int(n[8:16], 16) * 256 + int(n[16:24], 16) for n in segs]
    print(" ".join(f"{segs[i]}..{segs[i+1]}" for i in range(len(idx) - 1) if idx[i+1] - idx[i] != 1))
'
}
