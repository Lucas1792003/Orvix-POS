#!/usr/bin/env bash
# in-runner.sh — the Linux side of the DR drill (run.sh starts it in the email-tier runner image:
# Ubuntu, bash 5, GNU coreutils, gpg, python3, jq, docker CLI + docker-shim.sh). Synthetic data only.
#   backup   run the REAL backup-logical.sh and email-archive.sh --no-send against the disposable
#            database ($PHF_DB_CONTAINER, through the shim), stage the "offsite" copy (the encrypted
#            mail parts + index ONLY) and the owner's key (a separate directory = the owner's device),
#            and inject backup-side failures (interrupted backup, wrong key, missing part).
#   unpack   owner side, from the offsite copy only: reassemble + verify + decrypt + extract.
# Output: /work (bind-mounted results dir). Prints PASS/FAIL lines; exit 1 on any FAIL.
set -uo pipefail
SRC=/repo/deploy/lucashome/backup
W=/work; BIN=/tmp/bin; SRV=/tmp/srv; STACK="$SRV/stack"; BK="$SRV/backups"; CFG="$SRV/backup"; CRED="$CFG/credentials"
export BACKUP_ENV="$CFG/backup.env"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
fpr_of() { gpg --homedir "$1" --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}'; }
end() { echo "in-runner $1: $PASS passed, $FAIL failed"; [ "$FAIL" = 0 ]; exit $?; }

setup() {
  mkdir -p "$BIN" "$STACK/volumes/functions" "$STACK/volumes/db/custom-conf.d" "$STACK/volumes/db/wal_archive" \
    "$BK/dump/hourly" "$BK/dump/daily" "$BK/dump/weekly" "$BK/base" "$BK/restore-test" "$CRED"
  cp "$SRC"/*.sh "$SRC"/email-*.py "$SRC"/email-*.sql "$BIN/"; chmod 0755 "$BIN"/*.sh; chmod 0700 "$CRED"
  # the server's storage tree is the disposable stack's storage volume, mounted read-only
  ln -sfn /stack-storage "$STACK/volumes/storage"
  cp -r /repo/supabase/functions/. "$STACK/volumes/functions/"
  printf 'ref=self-hosted/disposable-drill\n' >"$STACK/.supabase-version"
  printf 'services:\n  db:\n    mem_limit: 2g\n' >"$STACK/docker-compose.override.yml"
  printf 'archive_mode = on\n' >"$STACK/volumes/db/custom-conf.d/10-wal-archive.conf"
  printf 'synthetic' | gzip >"$STACK/volumes/db/wal_archive/000000010000000000000001.gz"
  printf 'local all all trust\n' >"$STACK/volumes/db/pg_hba.conf"
}

case "${1:-}" in
backup)
  setup
  # throwaway OpenPGP keys in tmpfs: the owner's key and an unrelated one
  export GNUPGHOME=/keys/owner; mkdir -p /keys/owner /keys/other; chmod 0700 /keys/owner /keys/other
  gpg --batch --passphrase '' --quick-gen-key 'DR Drill Owner <owner@example.invalid>' default default never >/dev/null 2>&1 || { echo "gpg keygen"; exit 2; }
  gpg --homedir /keys/other --batch --passphrase '' --quick-gen-key 'Someone Else <other@example.invalid>' default default never >/dev/null 2>&1
  FPR="$(fpr_of /keys/owner)"
  gpg --armor --export "$FPR" >"$CRED/owner.pub.asc"; chmod 0600 "$CRED/owner.pub.asc"
  cat >"$BACKUP_ENV" <<EOF
STACK_DIR=$STACK
BACKUP_ROOT=$BK
PG_IMAGE=${PHF_PG_IMAGE:-supabase/postgres:17.6.1.136}
DB_ADMIN_USER=supabase_admin
WAL_ARCHIVE_DIR=$STACK/volumes/db/wal_archive
STORAGE_DIR=$STACK/volumes/storage
EMAIL_ENABLED=false
MAIL_TRANSPORT=smtp
MAIL_FROM="POS backups <backups@example.invalid>"
ARCHIVE_MAIL_TO=backup-box@example.invalid
ALERT_MAIL_TO=alerts@example.invalid
SMTP_URL=smtp://127.0.0.1:1
SMTP_NETRC_FILE=none
ARCHIVE_GPG_PUBKEY=$CRED/owner.pub.asc
ARCHIVE_GPG_FPR=$FPR
ARCHIVE_LABEL=pos
ARCHIVE_PART_BYTES=131072
EMAIL_SECRETS_MODE=local
EOF
  chmod 0600 "$BACKUP_ENV"
  echo '{"jobs":{}}' >"$BK/status.json"

  echo "== the real logical backup (backup-logical.sh)"
  "$BIN/backup-logical.sh" --no-prune >"$W/backup-logical.log" 2>&1; rc=$?
  check "backup-logical.sh exit 0" test "$rc" -eq 0
  D=$(ls -d "$BK"/dump/hourly/2*Z 2>/dev/null | tail -1)
  if [ -z "$D" ] || [ ! -d "$D" ]; then bad "a final dump set was written"; end backup; fi
  ok "a final dump set was written ($(basename "$D"))"
  mkdir -p "$W/local-backup"; cp -a "$D"/. "$W/local-backup/"
  check "dump set copied for the restore (local tier)" test -s "$W/local-backup/postgres.dump"

  echo "== interrupted backup (killed while dumping)"
  ( "$BIN/backup-logical.sh" --no-prune >"$W/backup-interrupted.log" 2>&1 ) &
  bp=$!
  for _ in $(seq 1 200); do ls "$BK"/dump/hourly/*.partial/postgres.dump >/dev/null 2>&1 && break; sleep 0.05; done
  pkill -TERM -P "$bp" 2>/dev/null; kill -TERM "$bp" 2>/dev/null; wait "$bp" 2>/dev/null
  sleep 1
  n_final=$(ls -d "$BK"/dump/hourly/2*Z 2>/dev/null | wc -l)
  check "interrupted backup: no new final dump set (only the earlier one)" test "$n_final" -eq 1
  check "interrupted backup: its .partial directory was removed" test -z "$(ls -d "$BK"/dump/hourly/*.partial 2>/dev/null)"
  check "interrupted backup: recorded as failed in status.json" test "$(jq -r '.jobs.logical.last_result' "$BK/status.json")" = fail

  echo "== the weekly encrypted archive (email-archive.sh --no-send: built and split exactly as sent)"
  NS="$W/email-build"; WK=2026-W42; ID="pos-$WK"
  "$BIN/email-archive.sh" --no-send --output-dir "$NS" --week "$WK" >"$W/email-archive.log" 2>&1; rc=$?
  check "email-archive.sh --no-send exit 0" test "$rc" -eq 0 -a -f "$NS/$ID/index.json"
  check "no plaintext staging left behind" test -z "$(find "$NS/.tmp" -mindepth 1 2>/dev/null)"
  check "archive split into several parts (so a missing part is a real test)" test "$(jq -r .part_count "$NS/$ID/index.json")" -ge 3
  # the OFFSITE copy: what the mailbox holds — the encrypted parts + the index, nothing else
  mkdir -p "$W/offsite"; cp "$NS/$ID/$ID".tar.gpg.[0-9][0-9][0-9] "$W/offsite/"; cp "$NS/$ID/index.json" "$W/offsite/$ID.index.json"
  rm -rf "$NS"
  check "offsite copy holds only ciphertext parts + index" test -z "$(find "$W/offsite" -type f ! -name "$ID.tar.gpg.*" ! -name "$ID.index.json")"
  check "offsite copy carries no plaintext dump marker" bash -c "! grep -rqa 'PGDMP' $W/offsite"
  # the owner's device: the private key, kept apart from the server and the offsite copy
  mkdir -p "$W/owner"; gpg --armor --export-secret-keys "$FPR" >"$W/owner/owner.SECRET.asc" 2>/dev/null; chmod 0600 "$W/owner/owner.SECRET.asc"
  gpg --homedir /keys/other --armor --export-secret-keys "$(fpr_of /keys/other)" >"$W/owner/wrong.SECRET.asc" 2>/dev/null
  echo "$ID" >"$W/offsite-id"
  end backup ;;

unpack)
  # owner side, from the offsite copy only (the server, its disk and its backups are gone)
  ID=$(cat "$W/offsite-id"); U="$W/s2-unpack"; rm -rf "$U"; mkdir -p "$U"
  export GNUPGHOME=/keys/restore; mkdir -p "$GNUPGHOME"; chmod 0700 "$GNUPGHOME"
  echo "== failure injection on the offsite copy"
  mkdir -p /tmp/missing; cp "$W/offsite"/* /tmp/missing/
  check "the part to remove exists" test -f /tmp/missing/"$ID".tar.gpg.002
  rm -f /tmp/missing/"$ID".tar.gpg.002
  python3 -I "$SRC/email-unpack.py" --out /tmp/missing-out /tmp/missing >/tmp/missing.log 2>&1; rc=$?
  check "a missing mail part is detected (unpack refuses)" test "$rc" -ne 0
  mkdir -p /tmp/trunc; cp "$W/offsite"/* /tmp/trunc/; f=$(ls /tmp/trunc/"$ID".tar.gpg.[0-9]* | head -1); head -c 1000 "$f" > "$f.x" && mv "$f.x" "$f"
  python3 -I "$SRC/email-unpack.py" --out /tmp/trunc-out /tmp/trunc >/tmp/trunc.log 2>&1; rc=$?
  check "a truncated mail part is detected (sha256 mismatch)" test "$rc" -ne 0
  python3 -I "$SRC/email-unpack.py" --out "$U" "$W/offsite" >"$W/unpack.log" 2>&1; rc=$?
  check "offsite copy reassembles and every part + the whole verify" test "$rc" -eq 0 -a -f "$U/$ID.tar.gpg"
  mkdir -p /keys/wrong; chmod 0700 /keys/wrong
  gpg --homedir /keys/wrong --batch --import "$W/owner/wrong.SECRET.asc" >/dev/null 2>&1
  gpg --homedir /keys/wrong --batch --output /tmp/wrong.tar --decrypt "$U/$ID.tar.gpg" >/dev/null 2>&1; rc=$?
  check "the wrong private key cannot decrypt it" test "$rc" -ne 0 -a ! -s /tmp/wrong.tar
  gpg --batch --import "$W/owner/owner.SECRET.asc" >/dev/null 2>&1
  gpg --batch --output "$U/archive.tar" --decrypt "$U/$ID.tar.gpg" >/dev/null 2>"$W/decrypt.err"; rc=$?
  check "the owner's key decrypts it" test "$rc" -eq 0
  X="$U/x"; mkdir -p "$X"; tar -C "$X" -xf "$U/archive.tar"; rm -f "$U/archive.tar"
  check "archive SHA256SUMS verifies every payload file" bash -c "cd $X && sha256sum --quiet -c SHA256SUMS"
  for f in db/postgres.dump db/_supabase.dump db/globals.sql db/db-settings.sql files/storage.tar.gz files/functions.tar.gz; do
    check "archive contains $f" test -s "$X/$f"
  done
  check "archive does NOT contain the .env or the pgsodium key" test -z "$(find "$X" -name '.env*' -o -name '*pgsodium*')"
  mkdir -p "$U/storage"; tar -C "$U/storage" -xzf "$X/files/storage.tar.gz"
  echo "storage files restored from the archive: $(find "$U/storage" -type f | wc -l)"
  end unpack ;;
*) echo "usage: in-runner.sh backup|unpack"; exit 2 ;;
esac
