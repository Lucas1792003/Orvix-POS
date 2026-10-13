#!/usr/bin/env bash
# email-archive.sh — weekly encrypted recovery archive, delivered by email.
#
# Builds one archive per ISO week (id "<ARCHIVE_LABEL>-<YYYY>-W<ww>"):
#   db/postgres.dump      pg_dump -Fc --create of `postgres` (public, auth incl. users + mfa_factors,
#                         storage, supabase_migrations, vault, cron, ... — every schema)
#   db/_supabase.dump     pg_dump -Fc --create of `_supabase`
#   db/globals.sql        pg_dumpall --roles-only        db/db-settings.sql  ALTER DATABASE/ROLE ... SET
#   db/counts.json        consistency counts (+ products, users, MFA factors, objects, schema version)
#   db/app_config.json    rows of public.app_config
#   files/storage.tar.gz  the storage-api file tree (object bytes)
#   files/functions.tar.gz  Edge Functions source as deployed
#   config/...            docker-compose.override.yml, .supabase-version, custom-conf.d, pg_hba.conf (non-secret)
#   MANIFEST.json + SHA256SUMS   sha256/size of every file above, counts, versions
# tar | gpg (owner's PUBLIC key only, AES256, no compression, MDC/AEAD integrity checked) is split
# into ARCHIVE_PART_BYTES parts; every part is mailed separately with the full index (INDEX.txt:
# sha256 per part + of the whole) attached. Secrets (.env, pgsodium key) are NOT in this archive
# (email-secrets.sh).
#
# Fail closed: any error -> exit 1, status.json email-archive.last_result=fail, a small failure mail
# (no data). Success is recorded only when EVERY part was accepted by the provider.
# Idempotent per week: a completed week is not sent again (unless --force, which builds a new
# archive id); an interrupted week resumes by sending only the parts not yet accepted, from the
# same encrypted build. Plaintext only exists in a 0700 staging dir that is removed on exit.
set -euo pipefail
# shellcheck source=email-lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/email-lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--force] [--build-only] [--no-send] [--output-dir DIR] [--week YYYY-Www] [--no-prune]
       $(basename "$0") --selftest [--selftest-parts N] [--selftest-mib M]
  --dry-run      check configuration and list what would be archived; build and send nothing
  --force        build and send a NEW archive even if this week's was already sent (id gets a -r<ts> suffix)
  --build-only   build + encrypt + split, do not send (state stays "built"; a later run sends it)
  --no-send      drills/tests: build + encrypt + split exactly as a real run, but NEVER send anything
                 (no archive mail, no failure alert), not gated by EMAIL_ENABLED, recorded as job
                 "email-archive-nosend" so the real job's status is untouched. Implies --build-only.
  --output-dir D with --no-send: write the encrypted build (and the 0700 plaintext staging) under D
                 instead of ARCHIVE_DIR / ARCHIVE_TMP_DIR
  --week W       archive id week label (default: current ISO week, UTC)
  --no-prune     keep more than $KEEP_EMAIL_ARCHIVE local encrypted builds
  --selftest     end-to-end check with SYNTHETIC content only (random bytes + a note; no database, no
                 files): encrypt to the owner key, mail it, record job "email-selftest". The owner then
                 unpacks + decrypts it on their device. Use for the first send and after key changes.
  --selftest-parts N  selftest only: split the synthetic archive into exactly N parts (1-$ARCHIVE_MAX_PARTS)
                 so multipart delivery can be tested with zero business data (default 1)
  --selftest-mib M    selftest only: M MiB of random bytes as payload (default 64 KiB for 1 part,
                 256 KiB per part otherwise); each part must stay <= ARCHIVE_PART_BYTES
Transport: $MAIL_TRANSPORT  to: ${ARCHIVE_MAIL_TO:-<unset>}  parts: ${ARCHIVE_PART_BYTES} bytes, max $ARCHIVE_MAX_PARTS
EOF
}

FORCE=0; BUILD_ONLY=0; PRUNE=1; WEEK=""; SELFTEST=0; NO_SEND=0; OUTPUT_DIR=""; SELFTEST_PARTS=""; SELFTEST_MIB=""
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --selftest) SELFTEST=1 ;;
    --selftest-parts) SELFTEST_PARTS="${2:-}"; shift ;;
    --selftest-mib) SELFTEST_MIB="${2:-}"; shift ;;
    --force) FORCE=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --no-send) NO_SEND=1; BUILD_ONLY=1 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift ;;
    --week) WEEK="$2"; shift ;;
    --no-prune) PRUNE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

if [[ -n "$OUTPUT_DIR" ]]; then
  (( NO_SEND )) || die "--output-dir is only allowed together with --no-send"
  [[ "$OUTPUT_DIR" == /* ]] || die "--output-dir must be an absolute path"
  ARCHIVE_DIR="$OUTPUT_DIR"; ARCHIVE_TMP_DIR="$OUTPUT_DIR/.tmp"
fi
(( NO_SEND && SELFTEST )) && die "--no-send and --selftest are mutually exclusive"
if [[ -n "$SELFTEST_PARTS$SELFTEST_MIB" ]]; then
  (( SELFTEST )) || die "--selftest-parts / --selftest-mib need --selftest"
  [[ -z "$SELFTEST_PARTS" ]] || { [[ "$SELFTEST_PARTS" =~ ^[0-9]+$ ]] && (( SELFTEST_PARTS >= 1 && SELFTEST_PARTS <= ARCHIVE_MAX_PARTS )); } \
    || die "--selftest-parts must be 1-$ARCHIVE_MAX_PARTS"
  [[ -z "$SELFTEST_MIB" ]] || { [[ "$SELFTEST_MIB" =~ ^[0-9]+$ ]] && (( SELFTEST_MIB >= 1 && SELFTEST_MIB <= 200 )); } \
    || die "--selftest-mib must be 1-200"
fi
: "${SELFTEST_PARTS:=1}"
# shellcheck disable=SC2034  # read by backup-lib.sh (log prefix, lock + log file names)
JOB_NAME=email-archive
# shellcheck disable=SC2034
(( NO_SEND )) && JOB_NAME=email-archive-nosend
init_logging
if (( NO_SEND )); then
  # shellcheck disable=SC2034  # read by email_enabled() in email-lib.sh
  EMAIL_ENABLED=false   # makes mail_alert inert; nothing below may send
  log "--no-send: build + encrypt + split only; no mail of any kind is sent"
elif (( ! DRY_RUN )); then
  email_gate
fi
acquire_lock

START=$SECONDS
[[ -n "$WEEK" ]] || WEEK="$(date -u +%G-W%V)"
[[ "$WEEK" =~ ^[0-9]{4}-W[0-9]{2}$ ]] || die "--week must look like 2026-W42"
[[ "$ARCHIVE_LABEL" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || die "ARCHIVE_LABEL must be 1-32 of [A-Za-z0-9_-]"
ID="$ARCHIVE_LABEL-$WEEK"
STATUS_JOB=email-archive
(( NO_SEND )) && STATUS_JOB=email-archive-nosend
if (( SELFTEST )); then ID="$ARCHIVE_LABEL-selftest-$WEEK-r$(ts_now)"; STATUS_JOB=email-selftest
elif (( FORCE )); then ID="$ID-r$(ts_now)"; fi
BUILD="$ARCHIVE_DIR/$ID"
STAGE=""
PHASE="preflight"
SENT_IDS=()

fail_record() {  # MESSAGE — status + alert (no data in either)
  local msg="$1"
  (( DRY_RUN )) && return 0
  status_update "$STATUS_JOB" "$(jq -nc --arg t "$(utc_now)" --arg m "$msg" --arg id "$ID" \
    '{last_run:$t,last_result:"fail",message:$m,last_archive_id:$id}')" || true
  mail_alert "$STATUS_JOB" "$msg (archive $ID)"
}

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ -n "$STAGE" && -d "$STAGE" ]]; then rm -rf -- "$STAGE"; fi
  [[ -d "$BUILD.partial" ]] && rm -rf -- "$BUILD.partial"
  if (( rc != 0 )); then
    log "FAILED in phase '$PHASE' (rc=$rc) after $(( SECONDS - START ))s"
    fail_record "failed during $PHASE (exit $rc)${EMAIL_FAIL_REASON:+: $EMAIL_FAIL_REASON}"
  fi
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# preflight: recipient key, transport, recipients, inputs
# ---------------------------------------------------------------------------
gpg_pubkey_check "$ARCHIVE_GPG_PUBKEY" "$ARCHIVE_GPG_FPR" || die "recipient public key check failed"
if (( ! BUILD_ONLY )); then
  [[ -n "$ARCHIVE_MAIL_TO" ]] || die "ARCHIVE_MAIL_TO is not set"
  mail_preflight || die "mail transport preflight failed"
fi
[[ -d "$STACK_DIR" ]] || die "stack dir $STACK_DIR not found"
[[ -d "$STORAGE_DIR" ]] || die "storage dir $STORAGE_DIR not found"
[[ "$ARCHIVE_PART_BYTES" =~ ^[0-9]+$ ]] && (( ARCHIVE_PART_BYTES >= 1024 )) || die "ARCHIVE_PART_BYTES invalid"

CONFIG_INPUTS=(
  "config/docker-compose.override.yml|$STACK_DIR/docker-compose.override.yml"
  "config/.supabase-version|$STACK_DIR/.supabase-version"
  "config/custom-conf.d|$STACK_DIR/volumes/db/custom-conf.d"
  "config/pg_hba.conf|$STACK_DIR/volumes/db/pg_hba.conf"
)

if (( DRY_RUN )); then
  log "DRY-RUN: archive id $ID -> $BUILD (state: $( [[ -f $BUILD/state.json ]] && jq -r .state "$BUILD/state.json" || echo none))"
  log "DRY-RUN: would dump postgres + _supabase + globals + db-settings + counts + app_config"
  log "DRY-RUN: storage $STORAGE_DIR ($(human "$(dir_bytes "$STORAGE_DIR")")), functions $STACK_DIR/volumes/functions"
  for e in "${CONFIG_INPUTS[@]}"; do IFS='|' read -r ap hp <<<"$e"; log "DRY-RUN: $ap <- $hp $( [[ -e $hp ]] && echo present || echo ABSENT)"; done
  log "DRY-RUN: encrypt to $ARCHIVE_GPG_FPR, split at $ARCHIVE_PART_BYTES bytes, send via $MAIL_TRANSPORT to ${ARCHIVE_MAIL_TO:-<unset>}"
  exit 0
fi

mkdir -p "$ARCHIVE_DIR" "$ARCHIVE_TMP_DIR" && chmod 0700 "$ARCHIVE_DIR" "$ARCHIVE_TMP_DIR"

state_get() { jq -r "$1" "$BUILD/state.json"; }

if [[ -f "$BUILD/state.json" && "$(state_get .state)" == sent ]]; then
  log "archive $ID was already sent completely at $(state_get .sent_at); nothing to do (use --force for a new one)"
  trap - EXIT
  exit 0
fi

# ---------------------------------------------------------------------------
# build (skipped when an encrypted build of this id already exists: resume)
# ---------------------------------------------------------------------------
build_archive() {
  PHASE="staging"
  STAGE="$(mktemp -d "$ARCHIVE_TMP_DIR/build.XXXXXX")"; chmod 0700 "$STAGE"
  local P="$STAGE/payload"
  mkdir -p "$P/db" "$P/files" "$P/config"

  if (( SELFTEST )); then
  PHASE="selftest payload"
  local rnd=65536
  if [[ -n "$SELFTEST_MIB" ]]; then rnd=$(( SELFTEST_MIB * 1048576 )); elif (( SELFTEST_PARTS > 1 )); then rnd=$(( SELFTEST_PARTS * 262144 )); fi
  head -c "$rnd" /dev/urandom >"$P/files/random.bin"
  printf 'Self-test archive %s, created %s (UTC).\nSynthetic content only: random bytes, no business data.\nIf you can read this after decrypting, the owner key, the mail path and the unpack tool all work.\n' \
    "$ID" "$(utc_now)" >"$P/SELFTEST.txt"
  echo '{"selftest":true}' >"$P/db/counts.json"
  else
  PHASE="database dump"
  db_psql postgres -c "$COUNTS_SQL" >"$P/db/counts.base.json"
  db_psql postgres -c "select json_build_object(
      'products',          (select count(*) from public.products),
      'organizations',     (select count(*) from public.organizations),
      'app_users',         (select count(*) from public.users),
      'auth_mfa_factors',  (select count(*) from auth.mfa_factors),
      'auth_identities',   (select count(*) from auth.identities),
      'migrations',        (select count(*) from supabase_migrations.schema_migrations),
      'schema_version',    (select max(version) from supabase_migrations.schema_migrations),
      'sales',             (select count(*) from public.sales))" >"$P/db/counts.extra.json"
  jq -s '.[0] + .[1]' "$P/db/counts.base.json" "$P/db/counts.extra.json" >"$P/db/counts.json"
  rm -f "$P/db/counts.base.json" "$P/db/counts.extra.json"
  db_psql postgres -c "select coalesce(json_agg(c order by c.key), '[]'::json) from public.app_config c" >"$P/db/app_config.json" \
    || { warn "public.app_config not readable; app_config.json is empty"; echo '[]' >"$P/db/app_config.json"; }
  db_exec pg_dumpall -U "$DB_ADMIN_USER" --roles-only >"$P/db/globals.sql"
  db_psql postgres -c "select coalesce(string_agg(stmt, E'\n' order by stmt), '-- (no database-level settings)') from (
    select case when s.setrole = 0
      then format('ALTER DATABASE %I SET %I = %L;', d.datname, split_part(c, '=', 1), substr(c, strpos(c, '=') + 1))
      else format('ALTER ROLE %I IN DATABASE %I SET %I = %L;', r.rolname, d.datname, split_part(c, '=', 1), substr(c, strpos(c, '=') + 1)) end as stmt
    from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase left join pg_roles r on r.oid = s.setrole,
    unnest(s.setconfig) c where s.setdatabase <> 0) x;" >"$P/db/db-settings.sql"
  local db n
  for db in postgres _supabase; do
    db_exec pg_dump -U "$DB_ADMIN_USER" -Fc --create -d "$db" >"$P/db/$db.dump"
    [[ -s "$P/db/$db.dump" ]] || die "empty dump for $db"
    n="$(db_exec_stdin pg_restore -l <"$P/db/$db.dump" | grep -cE '^[0-9]+;' || true)"
    (( n > 0 )) || die "pg_restore -l listed no TOC entries for $db.dump"
    log "$db.dump: $(human "$(stat -c %s "$P/db/$db.dump")"), $n TOC entries"
  done

  PHASE="file trees"
  tar -C "$STORAGE_DIR" -czf "$P/files/storage.tar.gz" .
  if [[ -d "$STACK_DIR/volumes/functions" ]]; then tar -C "$STACK_DIR/volumes/functions" -czf "$P/files/functions.tar.gz" .
  else warn "no $STACK_DIR/volumes/functions"; fi
  local e ap hp
  for e in "${CONFIG_INPUTS[@]}"; do
    IFS='|' read -r ap hp <<<"$e"
    if [[ -e "$hp" ]]; then mkdir -p "$P/$(dirname "$ap")"; cp -a -- "$hp" "$P/$ap"; else warn "absent: $hp"; fi
  done
  # app_config + counts are already under db/; the .env, keys and credentials are deliberately absent.
  fi

  PHASE="manifest"
  (cd "$P" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.json -printf '%P\n' | LC_ALL=C sort | xargs -r -d '\n' sha256sum -b >SHA256SUMS)
  jq -n --arg id "$ID" --arg at "$(utc_now)" --arg img "$PG_IMAGE" --arg label "$ARCHIVE_LABEL" \
    --argjson counts "$(cat "$P/db/counts.json")" \
    --argjson files "$(cd "$P" && find . -type f ! -name MANIFEST.json -printf '%P\t%s\n' | LC_ALL=C sort | jq -R 'split("\t") | {path:.[0], bytes:(.[1]|tonumber)}' | jq -s .)" \
    --argjson sums "$(jq -R 'capture("^(?<sha256>[0-9a-f]{64}) \\*(?<path>.+)$")' <"$P/SHA256SUMS" | jq -s 'map({(.path): .sha256}) | add // {}')" \
    --arg version "$(cat "$STACK_DIR/.supabase-version" 2>/dev/null || echo unknown)" \
    '{archive_id:$id, created_at:$at, label:$label, pg_image:$img, stack_version:$version, counts:$counts,
      files: ($files | map(. + {sha256: ($sums[.path] // null)})),
      restore:"see the restore-from-email runbook; verify SHA256SUMS before restoring"}' >"$P/MANIFEST.json"
  local raw; raw="$(du -sb "$P" | cut -f1)"
  log "payload: $(human "$raw") ($(jq -c 'del(.captured_at)' "$P/db/counts.json"))"

  PHASE="encrypt"
  mkdir -p "$BUILD.partial" && chmod 0700 "$BUILD.partial"
  local enc="$BUILD.partial/$ID.tar.gpg"
  set +e
  tar -C "$P" -cf - . | gpg_encrypt_stream "$ARCHIVE_GPG_PUBKEY" "$enc"
  local ps=("${PIPESTATUS[@]}")
  set -e
  (( ps[0] == 0 )) || die "tar failed (rc=${ps[0]})"
  (( ps[1] == 0 )) || die "gpg encryption failed (rc=${ps[1]})"
  gpg_integrity_ok "$enc" || die "encrypted output is not a public-key, integrity-protected OpenPGP message"
  rm -rf -- "$STAGE"; STAGE=""          # plaintext gone as soon as the ciphertext exists
  local total total_sha
  total="$(stat -c %s "$enc")"; total_sha="$(sha256sum "$enc" | cut -d' ' -f1)"

  PHASE="split"
  if (( SELFTEST )); then
    # exactly SELFTEST_PARTS parts: part size = ceil(total / N) (payload >= 64 KiB per part, so N is met)
    local want=$(( (total + SELFTEST_PARTS - 1) / SELFTEST_PARTS ))
    (( want <= ARCHIVE_PART_BYTES )) || die "selftest parts of $want bytes would exceed ARCHIVE_PART_BYTES=$ARCHIVE_PART_BYTES; use more parts or fewer MiB"
    ARCHIVE_PART_BYTES=$want
  fi
  local nparts=$(( (total + ARCHIVE_PART_BYTES - 1) / ARCHIVE_PART_BYTES ))
  (( ! SELFTEST || nparts == SELFTEST_PARTS )) || die "selftest split gives $nparts parts, expected $SELFTEST_PARTS"
  if (( nparts > ARCHIVE_MAX_PARTS )); then
    die "archive is $(human "$total") = $nparts parts of $(human "$ARCHIVE_PART_BYTES"), over ARCHIVE_MAX_PARTS=$ARCHIVE_MAX_PARTS: email is no longer a suitable channel (see email-backup-design.md §growth)"
  fi
  (cd "$BUILD.partial" && split -b "$ARCHIVE_PART_BYTES" -a 3 --numeric-suffixes=1 "$ID.tar.gpg" "$ID.tar.gpg.")
  rm -f -- "$enc"
  local -a parts; mapfile -t parts < <(cd "$BUILD.partial" && find . -maxdepth 1 -name "$ID.tar.gpg.[0-9][0-9][0-9]" -printf '%f\n' | LC_ALL=C sort)
  (( ${#parts[@]} == nparts )) || die "split produced ${#parts[@]} parts, expected $nparts"
  local plist="[]" i=0 f
  for f in "${parts[@]}"; do
    i=$(( i + 1 ))
    plist="$(jq -c --arg f "$f" --argjson n "$i" --argjson b "$(stat -c %s "$BUILD.partial/$f")" \
      --arg s "$(sha256sum "$BUILD.partial/$f" | cut -d' ' -f1)" '. + [{n:$n, file:$f, bytes:$b, sha256:$s}]' <<<"$plist")"
  done
  jq -n --arg id "$ID" --arg at "$(utc_now)" --arg fpr "${ARCHIVE_GPG_FPR^^}" --argjson total "$total" --arg tsha "$total_sha" \
    --argjson parts "$plist" --argjson raw "$raw" \
    '{archive_id:$id, created_at:$at, format:"tar | OpenPGP public-key encryption (AES256, integrity-protected, no compression) | split", recipient_fingerprint:$fpr,
      payload_bytes:$raw, total_bytes:$total, total_sha256:$tsha, part_count:($parts|length), parts:$parts}' >"$BUILD.partial/index.json"
  {
    printf 'Encrypted recovery archive %s\n' "$ID"
    printf 'created:     %s\n' "$(jq -r .created_at "$BUILD.partial/index.json")"
    printf 'format:      tar | OpenPGP (public-key, AES256, integrity-protected) | split into %d part(s)\n' "$nparts"
    printf 'recipient:   %s\n' "${ARCHIVE_GPG_FPR^^}"
    printf 'total bytes: %s\n' "$total"
    printf 'total sha256 (of the concatenated parts): %s\n\n' "$total_sha"
    printf 'parts (n, bytes, sha256, file):\n'
    jq -r '.parts[] | "  \(.n)  \(.bytes)  \(.sha256)  \(.file)"' "$BUILD.partial/index.json"
    printf '\nRestore: save every part, run email-unpack.py (verifies each part and the total),\n'
    printf 'then decrypt to a FILE with the owner key and check gpg exits 0 before extracting.\n'
    printf 'Never pipe gpg straight into tar. Runbook: restore-from-email.\n'
  } >"$BUILD.partial/INDEX.txt"
  json_state_write "$BUILD.partial/state.json" "$(jq -nc --arg id "$ID" --arg at "$(utc_now)" --argjson n "$nparts" \
    '{archive_id:$id, state:"built", built_at:$at, part_count:$n, sent:{}}')"
  chmod 0600 "$BUILD.partial"/*
  mv "$BUILD.partial" "$BUILD"
  (( nparts >= ARCHIVE_WARN_PARTS )) && warn "archive needs $nparts emails (warn at $ARCHIVE_WARN_PARTS)"
  log "built $ID: $(human "$total") encrypted, $nparts part(s), sha256 $total_sha"
}

verify_build() {  # every part still matches the index (resume safety)
  local f s
  while IFS=$'\t' read -r f s; do
    [[ -f "$BUILD/$f" ]] || return 1
    [[ "$(sha256sum "$BUILD/$f" | cut -d' ' -f1)" == "$s" ]] || return 1
  done < <(jq -r '.parts[] | "\(.file)\t\(.sha256)"' "$BUILD/index.json")
}

if [[ -f "$BUILD/index.json" && -f "$BUILD/state.json" ]]; then
  PHASE="resume"
  verify_build || die "existing build $BUILD does not match its index; move it aside or use --force"
  log "resuming $ID: $(jq -r '.sent | length' "$BUILD/state.json")/$(jq -r .part_count "$BUILD/index.json") part(s) already accepted"
else
  [[ -e "$BUILD" ]] && die "$BUILD exists but is not a complete build; move it aside or use --force"
  build_archive
fi

NPARTS="$(jq -r .part_count "$BUILD/index.json")"
TOTAL_BYTES="$(jq -r .total_bytes "$BUILD/index.json")"
if (( BUILD_ONLY )); then
  log "--build-only: $ID built ($NPARTS part(s)) in $BUILD, not sent"
  status_update "$STATUS_JOB" "$(jq -nc --arg t "$(utc_now)" --arg id "$ID" --argjson n "$NPARTS" --arg dir "$BUILD" \
    --argjson dur "$(( SECONDS - START ))" \
    '{last_run:$t,last_result:"built",message:"built, not sent (--build-only/--no-send)",last_archive_id:$id,parts:$n,build_dir:$dir,duration_s:$dur}')"
  trap - EXIT; exit 0
fi

# ---------------------------------------------------------------------------
# send: one message per part, each with INDEX.txt + index.json; resume-aware
# ---------------------------------------------------------------------------
PHASE="send"
WORK="$(mktemp -d "$ARCHIVE_TMP_DIR/send.XXXXXX")"; chmod 0700 "$WORK"
STAGE="$WORK"   # removed by the EXIT trap
while IFS=$'\t' read -r n f bytes sha; do
  if [[ "$(jq -r --arg n "$n" '.sent[$n].id // empty' "$BUILD/state.json")" != "" ]]; then
    log "part $n/$NPARTS already accepted earlier ($(jq -r --arg n "$n" '.sent[$n].id' "$BUILD/state.json")); skipping"
    continue
  fi
  {
    printf 'Encrypted recovery archive %s — part %s of %s\n\n' "$ID" "$n" "$NPARTS"
    printf 'This part:  %s\n  bytes:   %s\n  sha256:  %s\n\n' "$f" "$bytes" "$sha"
    printf 'Keep ALL %s part(s) of %s. Every part carries the same INDEX.txt.\n' "$NPARTS" "$ID"
    printf 'The attachment is OpenPGP ciphertext for the owner key %s;\n' "${ARCHIVE_GPG_FPR^^}"
    printf 'it is useless without the private key, which never touches the backup host.\n\n'
    cat "$BUILD/INDEX.txt"
  } >"$WORK/body.txt"
  subject="$MAIL_SUBJECT_TAG archive $ID part $n/$NPARTS"
  (( SELFTEST )) && subject="$MAIL_SUBJECT_TAG SELFTEST (synthetic, no data) $ID part $n/$NPARTS"
  if mail_send "$WORK" "$ARCHIVE_MAIL_TO" "$subject" "$WORK/body.txt" - "$ID-p$n-${sha:0:16}" \
       "$BUILD/$f::$f::application/octet-stream" "$BUILD/INDEX.txt::$ID.INDEX.txt::text/plain" "$BUILD/index.json::$ID.index.json::application/json"; then
    json_state_write "$BUILD/state.json" "$(jq -c --arg n "$n" --arg id "$MAIL_LAST_ID" --arg at "$(utc_now)" --arg d "$MAIL_LAST_DETAIL" \
      --arg th "$MAIL_LAST_THREAD" '.sent[$n] = ({id:$id, at:$at, result:$d} + (if $th == "" then {} else {thread_id:$th} end))' "$BUILD/state.json")"
    SENT_IDS+=("$MAIL_LAST_ID")
    log "part $n/$NPARTS accepted: $MAIL_LAST_DETAIL id=$MAIL_LAST_ID${MAIL_LAST_THREAD:+ thread=$MAIL_LAST_THREAD}"
  else
    die "part $n/$NPARTS NOT accepted: $MAIL_LAST_DETAIL"
  fi
done < <(jq -r '.parts[] | "\(.n)\t\(.file)\t\(.bytes)\t\(.sha256)"' "$BUILD/index.json")

SENT_COUNT="$(jq -r '.sent | length' "$BUILD/state.json")"
(( SENT_COUNT == NPARTS )) || die "only $SENT_COUNT of $NPARTS parts accepted"
json_state_write "$BUILD/state.json" "$(jq -c --arg at "$(utc_now)" '.state = "sent" | .sent_at = $at' "$BUILD/state.json")"
DURATION=$(( SECONDS - START ))
status_update "$STATUS_JOB" "$(jq -nc --arg t "$(utc_now)" --arg id "$ID" --argjson n "$NPARTS" --argjson b "$TOTAL_BYTES" \
  --argjson dur "$DURATION" --arg tr "$MAIL_TRANSPORT" --argjson warnings "$(warnings_json)" \
  --argjson ids "$(jq -c '[.sent | to_entries | sort_by(.key|tonumber)[] | .value.id]' "$BUILD/state.json")" \
  '{last_run:$t,last_success:$t,last_result:"ok",message:"ok",last_archive_id:$id,parts:$n,size_bytes:$b,duration_s:$dur,transport:$tr,message_ids:$ids,warnings:$warnings}')"
log "archive $ID sent: $NPARTS part(s), $(human "$TOTAL_BYTES"), ${DURATION}s"
if (( SELFTEST )); then
  rm -rf -- "${BUILD:?}"; PRUNE=0
  log "selftest build removed locally; the owner now unpacks + decrypts the mail on their device"
fi

# ---------------------------------------------------------------------------
# local retention: newest KEEP_EMAIL_ARCHIVE builds that were sent completely; never anything else
# ---------------------------------------------------------------------------
if (( PRUNE )); then
  PHASE="prune"
  n=0
  while IFS= read -r d; do
    [[ "$d" =~ ^$ARCHIVE_LABEL-[0-9]{4}-W[0-9]{2}(-r[0-9]{8}T[0-9]{6}Z)?$ ]] || continue
    [[ -f "$ARCHIVE_DIR/$d/state.json" && "$(jq -r .state "$ARCHIVE_DIR/$d/state.json")" == sent ]] || continue
    real="$(realpath -e -- "$ARCHIVE_DIR/$d")"
    [[ "$(dirname "$real")" == "$(realpath -e -- "$ARCHIVE_DIR")" ]] || die "refusing to delete $real"
    rm -rf -- "$real"; n=$(( n + 1 )); log "pruned local build $d"
  done < <(find "$ARCHIVE_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2- | tail -n +$(( KEEP_EMAIL_ARCHIVE + 1 )))
  log "local builds: keep=$KEEP_EMAIL_ARCHIVE removed=$n"
fi
trap - EXIT
rm -rf -- "$WORK"
log "done"
