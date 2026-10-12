#!/usr/bin/env bash
# secrets-bundle.sh — daily age-encrypted bundle of everything a rebuild needs
# besides the database: stack/.env, docker-compose.override.yml,
# .supabase-version, volumes/db/{custom-conf.d,pg_hba.conf}, volumes/functions,
# volumes/api, the db-config named volume (pgsodium_root.key, conf.d), the
# backup config (backup.env, rclone.conf), `crontab -l`, `tailscale serve
# status --json` and a MANIFEST.sha256 of every member.
#
# Plaintext never touches the disk: tar writes to a pipe that age encrypts
# straight into $BUNDLE_DIR/<ts>.tar.age (0600). In the default mode
# (BUNDLE_TAR_MODE=docker) tar runs in a throwaway container with every input
# bind-mounted read-only — the only way to read the db-config volume without
# sudo. BUNDLE_TAR_MODE=host uses GNU tar on the host (no docker; the volume is
# skipped with a warning). The manifest is computed in memory (tmpfs) in
# docker mode. Retention: newest $KEEP_BUNDLE bundles. The age PRIVATE key is
# never on this host; decrypt on the Mac (OFFSITE-ENABLE.md §6).
set -euo pipefail
# shellcheck source=backup-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/backup-lib.sh"
# shellcheck source=offsite-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/offsite-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--force] [--no-prune] [--help]
  --dry-run   list what would be bundled (existence/size only; no file content is read), encrypt nothing
  --force     build even while OFFSITE_ENABLED != true (the bundle is useful for the Mac tier alone)
  --no-prune  keep more than $KEEP_BUNDLE bundles
Output: $BUNDLE_DIR/<ts>.tar.age   recipient(s): ${AGE_RECIPIENT:-<unset>}   mode: $BUNDLE_TAR_MODE
EOF
}

FORCE=0; PRUNE=1
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --no-prune) PRUNE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

init_logging
if ! offsite_enabled && (( ! FORCE )); then
  if (( DRY_RUN )); then
    log "offsite disabled (OFFSITE_ENABLED=${OFFSITE_ENABLED}); dry-run listing only"
  else
    offsite_gate
  fi
fi
acquire_lock

TS="$(ts_now)"
START=$SECONDS
FINAL="$BUNDLE_DIR/$TS.tar.age"
TMP="$FINAL.tmp"
META=""      # host tmpdir with generated, non-secret files (crontab, serve json, bundle.json)
STAGE=""     # host mode: 0700 dir of symlinks (tar -h dereferences; nothing is copied)

cleanup() {
  local rc=$?
  trap - EXIT
  [[ -n "$META" && -d "$META" ]] && rm -rf -- "$META"
  [[ -n "$STAGE" && -d "$STAGE" ]] && rm -rf -- "$STAGE"
  if (( rc != 0 )); then
    rm -f -- "$TMP"
    log "FAILED (rc=$rc) after $(( SECONDS - START ))s"
    (( DRY_RUN )) || status_update bundle "$(jq -nc --arg t "$(utc_now)" --arg m "exit $rc, see $LOG_FILE" '{last_run:$t,last_result:"fail",message:$m}')"
  fi
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Inputs: "archive path|host path|required"
# ---------------------------------------------------------------------------
INPUTS=(
  "stack/.env|$STACK_DIR/.env|required"
  "stack/docker-compose.override.yml|$STACK_DIR/docker-compose.override.yml|required"
  "stack/.supabase-version|$STACK_DIR/.supabase-version|required"
  "stack/volumes/db/custom-conf.d|$STACK_DIR/volumes/db/custom-conf.d|optional"
  "stack/volumes/db/pg_hba.conf|$STACK_DIR/volumes/db/pg_hba.conf|optional"
  "stack/volumes/functions|$STACK_DIR/volumes/functions|optional"
  "stack/volumes/api|$STACK_DIR/volumes/api|optional"
  "backup/backup.env|$BACKUP_ENV|optional"
  "backup/rclone.conf|$RCLONE_CONFIG|optional"
)

PRESENT=()      # "archive path|host path" of inputs that exist
MISSING=()
for e in "${INPUTS[@]}"; do
  IFS='|' read -r ap hp req <<<"$e"
  if [[ -e "$hp" ]]; then PRESENT+=("$ap|$hp")
  elif [[ "$req" == required ]]; then die "required input missing: $hp"
  else MISSING+=("$ap ($hp)"); fi
done

VOLUME_OK=0
if [[ "$BUNDLE_TAR_MODE" == docker ]]; then
  command -v docker >/dev/null 2>&1 || die "docker not found and BUNDLE_TAR_MODE=docker"
  if docker volume inspect "$DB_CONFIG_VOLUME" >/dev/null 2>&1; then VOLUME_OK=1; else warn "docker volume $DB_CONFIG_VOLUME not found; db-config/ will be missing (pgsodium_root.key!)"; fi
elif [[ "$BUNDLE_TAR_MODE" == host ]]; then
  warn "BUNDLE_TAR_MODE=host: the db-config volume ($DB_CONFIG_VOLUME, pgsodium_root.key) is NOT included"
else
  die "BUNDLE_TAR_MODE must be docker|host"
fi

# ---------------------------------------------------------------------------
log "bundle $TS -> $FINAL (mode=$BUNDLE_TAR_MODE, keep $KEEP_BUNDLE)"
log "members:"
for p in "${PRESENT[@]}"; do
  IFS='|' read -r ap hp <<<"$p"
  log "  $ap  <- $hp ($(human "$(dir_bytes "$hp")"))"
done
(( VOLUME_OK )) && log "  db-config/  <- docker volume $DB_CONFIG_VOLUME (read-only mount)"
log "  meta/crontab.txt meta/tailscale-serve.json meta/bundle.json manifest/MANIFEST.sha256  <- generated"
for m in ${MISSING[@]+"${MISSING[@]}"}; do log "  (absent, skipped) $m"; done

if (( DRY_RUN )); then
  log "DRY-RUN: would tar the members above | age -r ${AGE_RECIPIENT:-<AGE_RECIPIENT unset>} > $FINAL (0600), then keep the newest $KEEP_BUNDLE bundles"
  command -v age >/dev/null 2>&1 || log "DRY-RUN: NOTE age is not installed — the real run fails closed (sudo apt install age)"
  exit 0
fi

bundle_require_age
mkdir -p "$BUNDLE_DIR" && chmod 0700 "$BUNDLE_DIR"
[[ -w "$BUNDLE_DIR" ]] || die "$BUNDLE_DIR not writable"

# generated, non-secret meta files
META="$(mktemp -d "$BACKUP_ROOT/.bundle-meta.XXXXXX")"; chmod 0700 "$META"
{ crontab -l 2>/dev/null || echo "# crontab -l failed or empty"; } >"$META/crontab.txt"
if command -v tailscale >/dev/null 2>&1; then tailscale serve status --json >"$META/tailscale-serve.json" 2>/dev/null || echo '{"error":"tailscale serve status failed"}' >"$META/tailscale-serve.json"
else echo '{"error":"tailscale not installed"}' >"$META/tailscale-serve.json"; fi
jq -n --arg ts "$TS" --arg host "$(hostname)" --arg mode "$BUNDLE_TAR_MODE" --arg vol "$DB_CONFIG_VOLUME" --argjson volok "$VOLUME_OK" \
  --arg img "$PG_IMAGE" --arg stack "$STACK_DIR" --arg recips "$AGE_RECIPIENT" \
  --argjson members "$(printf '%s\n' "${PRESENT[@]}" | cut -d'|' -f1 | jq -R . | jq -sc .)" \
  --argjson missing "$(printf '%s\n' ${MISSING[@]+"${MISSING[@]}"} | grep -v '^$' | jq -R . | jq -sc .)" \
  '{ts:$ts, host:$host, mode:$mode, db_config_volume:$vol, db_config_included:($volok==1), pg_image:$img, stack_dir:$stack,
    recipients:($recips|split(" ")|map(select(.!=""))), members:$members, missing:$missing,
    restore_hint:"age -d -i <private key> <ts>.tar.age | tar -x ; sha256sum -c manifest/MANIFEST.sha256 ; see OFFSITE-ENABLE.md §8"}' >"$META/bundle.json"
chmod 0600 "$META"/*

AGE_ARGS=()
for r in $AGE_RECIPIENT; do AGE_ARGS+=(-r "$r"); done

tar_stream_docker() {
  # every input mounted read-only; manifest on a tmpfs; nothing is written to the host
  local -a m=(--rm --network none --memory 256m --name "sb-bundle-$TS" --mount "type=tmpfs,destination=/src/manifest")
  local p ap hp
  for p in "${PRESENT[@]}"; do
    IFS='|' read -r ap hp <<<"$p"
    m+=(-v "$hp:/src/$ap:ro")
  done
  (( VOLUME_OK )) && m+=(-v "$DB_CONFIG_VOLUME:/src/db-config:ro")
  m+=(-v "$META:/src/meta:ro")
  docker run "${m[@]}" --entrypoint sh "$PG_IMAGE" -c \
    'set -e; cd /src && find . -type f ! -path "./manifest/*" -print0 | sort -z | xargs -0 sha256sum >/src/manifest/MANIFEST.sha256 && tar -C /src -cf - .'
}

tar_stream_host() {
  # staging dir of symlinks; tar -h dereferences them, so sources are read in place
  STAGE="$(mktemp -d "$BACKUP_ROOT/.bundle-stage.XXXXXX")"; chmod 0700 "$STAGE"
  local p ap hp
  for p in "${PRESENT[@]}"; do
    IFS='|' read -r ap hp <<<"$p"
    mkdir -p "$STAGE/$(dirname "$ap")"
    ln -s "$(realpath -e -- "$hp")" "$STAGE/$ap"
  done
  ln -s "$META" "$STAGE/meta"
  mkdir -p "$STAGE/manifest"
  (cd "$STAGE" && find -L . -type f ! -path './manifest/*' -print0 | sort -z | xargs -0 sha256sum >"$STAGE/manifest/MANIFEST.sha256")
  tar -h -C "$STAGE" -cf - .
}

tar_stream() {
  case "$BUNDLE_TAR_MODE" in
    docker) tar_stream_docker ;;
    host)   tar_stream_host ;;
  esac
}

log "encrypting to $TMP (age, $(( ${#AGE_ARGS[@]} / 2 )) recipient(s))"
set +e
tar_stream | age "${AGE_ARGS[@]}" -o "$TMP"
ps=("${PIPESTATUS[@]}")
set -e
(( ps[0] == 0 )) || die "tar stream failed (rc=${ps[0]})"
(( ps[1] == 0 )) || die "age failed (rc=${ps[1]})"
chmod 0600 "$TMP"
[[ "$(head -c 21 "$TMP")" == "age-encryption.org/v1" ]] || die "output is not an age file"
SIZE="$(stat -c %s "$TMP")"
(( SIZE > 1024 )) || die "bundle suspiciously small ($SIZE bytes)"
mv -f "$TMP" "$FINAL"
DURATION=$(( SECONDS - START ))
log "bundle complete: $FINAL ($(human "$SIZE"), ${DURATION}s, db_config_included=$VOLUME_OK)"

status_update bundle "$(jq -nc --arg t "$(utc_now)" --arg f "$FINAL" --argjson size "$SIZE" --argjson dur "$DURATION" \
  --argjson volok "$VOLUME_OK" --argjson warnings "$(warnings_json)" --arg mode "$BUNDLE_TAR_MODE" \
  '{last_run:$t,last_success:$t,last_result:"ok",file:$f,size_bytes:$size,duration_s:$dur,mode:$mode,db_config_included:($volok==1),warnings:$warnings,message:"ok"}')"

# retention: newest KEEP_BUNDLE by name; only <ts>.tar.age directly in BUNDLE_DIR is ever removed
if (( PRUNE )); then
  n=0
  while IFS= read -r f; do
    [[ "$f" =~ $BUNDLE_RE ]] || continue
    real="$(realpath -e -- "$BUNDLE_DIR/$f")" || continue
    [[ "$(dirname "$real")" == "$(realpath -e -- "$BUNDLE_DIR")" && -f "$real" ]] || die "refusing to delete $real"
    log "prune $real"; rm -f -- "$real"; n=$(( n + 1 ))
  done < <(find "$BUNDLE_DIR" -mindepth 1 -maxdepth 1 -type f -name '*.tar.age' -printf '%f\n' | LC_ALL=C sort -r | tail -n +$(( KEEP_BUNDLE + 1 )))
  log "bundle/: keep=$KEEP_BUNDLE removed=$n remaining=$(find "$BUNDLE_DIR" -maxdepth 1 -name '*.tar.age' | wc -l)"
fi
find "$BUNDLE_DIR" -maxdepth 1 -name '*.tar.age.tmp' -mmin +120 -delete 2>/dev/null || true
log "done"
