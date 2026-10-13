#!/usr/bin/env bash
# suite.sh — email-tier tests; runs INSIDE the <prefix>-runner container (started by run.sh; prefix
# PHF_PREFIX, default phf-mail, so parallel runs on one Docker host do not collide).
# Synthetic data only: a disposable supabase/postgres seeded with fake rows, a fake server tree,
# a throwaway gpg key in a tmpfs, a local SMTP catcher (mailpit), an SMTP fault stub and a fake
# Resend endpoint. Nothing leaves the docker network; no real provider, mailbox or database.
set -uo pipefail
REPO=/repo
SRC="$REPO/deploy/lucashome/backup"
T="$SRC/tests/email"
IMG="${PHF_PG_IMAGE:-supabase/postgres:17.6.1.136}"
NET="${PHF_NET:?}"
MP_IMG="${PHF_MAILPIT_IMAGE:?}"
BASELINE=/baseline/schema.sql
PFX="${PHF_PREFIX:-phf-mail}"
export PHF_DB_CONTAINER="${PFX}-db"
export PHF_DB_PW; PHF_DB_PW="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PW="$PHF_DB_PW"
MP=http://${PFX}-smtp:8025
PASS=0; FAIL=0; FAILED_NAMES=()
ok()  { PASS=$(( PASS + 1 )); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$(( FAIL + 1 )); FAILED_NAMES+=("$*"); printf 'FAIL  %s\n' "$*"; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
section() { printf '\n=== %s ===\n' "$*"; }
die() { echo "SETUP ERROR: $*"; exit 2; }

W=/work; mkdir -p "$W"
BIN="$W/bin"; SRV=/srv-test; STACK="$SRV/stack"; BK="$SRV/backups"; CFG="$SRV/backup"; CRED="$CFG/credentials"
export BACKUP_ENV="$CFG/backup.env"
STATUS="$BK/status.json"

# ------------------------------------------------------------------ helpers ----
su_psql() { local c="$1"; shift; docker exec -i -e PGPASSWORD="$PW" "$c" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
pg_psql() { local c="$1"; shift; docker exec -i -e PGPASSWORD="$PW" "$c" psql -X -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
wait_pg() {
  local c="$1"
  for _ in $(seq 1 120); do
    if docker exec -e PGPASSWORD="$PW" "$c" psql -X -h 127.0.0.1 -U postgres -d postgres -Atc 'select 1' >/dev/null 2>&1; then
      sleep 4
      docker exec -e PGPASSWORD="$PW" "$c" psql -X -U supabase_admin -d postgres -Atc 'select 1' >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  docker logs "$c" 2>&1 | tail -20; return 1
}
st() { jq -r "$1" "$STATUS" 2>/dev/null; }
mp_total() { curl -s "$MP/api/v1/messages?limit=1" | jq -r '.total // 0'; }
mp_dump() {  # DIR [subject-substring] — raw .eml of matching messages
  local dir="$1" filt="${2:-}" id
  mkdir -p "$dir"
  curl -s "$MP/api/v1/messages?limit=1000" | jq -r --arg f "$filt" '.messages[] | select(.Subject | contains($f)) | .ID' | while read -r id; do
    curl -s "$MP/api/v1/message/$id/raw" >"$dir/$id.eml"
  done
}
mp_count_subj() { curl -s "$MP/api/v1/messages?limit=1000" | jq -r --arg f "$1" '[.messages[] | select(.Subject | contains($f))] | length'; }
run_job() {  # SCRIPT ARGS... (env overrides via `env` prefix by the caller); output to $W/last.log
  "$BIN/$1" "${@:2}" >"$W/last.log" 2>&1
}
fpr_of() { gpg --homedir "$1" --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}'; }

# ---------------------------------------------------------------- setup -------
section "setup"
[[ -f "$BASELINE" ]] || die "baseline schema not mounted at $BASELINE"
mkdir -p "$BIN" "$STACK/volumes/storage" "$STACK/volumes/functions" "$STACK/volumes/db/custom-conf.d" "$STACK/volumes/db/wal_archive" \
  "$BK/dump/hourly" "$BK/dump/daily" "$BK/dump/weekly" "$BK/base" "$BK/restore-test" "$CRED"
cp "$SRC"/*.sh "$SRC"/email-*.py "$SRC"/email-*.sql "$BIN/"; chmod 0755 "$BIN"/*.sh
chmod 0700 "$CRED"

# throwaway OpenPGP keys (tmpfs /keys): the owner key and an unrelated "wrong" key
export GNUPGHOME=/keys/owner; mkdir -p /keys/owner /keys/other; chmod 0700 /keys/owner /keys/other
gpg --batch --passphrase '' --quick-gen-key 'Test Owner <owner@example.invalid>' default default never >/dev/null 2>&1 || die "gpg keygen"
gpg --homedir /keys/other --batch --passphrase '' --quick-gen-key 'Someone Else <other@example.invalid>' default default never >/dev/null 2>&1 || die "gpg keygen 2"
FPR="$(fpr_of /keys/owner)"; FPR_OTHER="$(fpr_of /keys/other)"
gpg --armor --export "$FPR" >"$CRED/owner.pub.asc"
gpg --homedir /keys/other --armor --export "$FPR_OTHER" >"$CRED/other.pub.asc"
gpg --armor --export-secret-keys "$FPR" >"$CRED/owner.SECRET.asc" 2>/dev/null; chmod 0600 "$CRED"/*.asc
printf 'machine %s-smtp login test-sender password not-a-real-password\n' "$PFX" >"$CRED/smtp.netrc"
printf 're_test_%s\n' "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$CRED/resend.key"
printf 're_wrong_key\n' >"$CRED/resend.wrong.key"
chmod 0600 "$CRED"/*
echo "owner key $FPR (test only)"

# fake server tree (synthetic; canaries mark data that must never be visible in a mail)
cat >"$STACK/.env" <<EOF
POSTGRES_PASSWORD=phfcanary-env-secret-91aa-pg
JWT_SECRET=phfcanary-env-secret-91aa
ANON_KEY=phfcanary-env-anon
SERVICE_ROLE_KEY=phfcanary-env-secret-91aa-service
EOF
chmod 0600 "$STACK/.env"
echo "ref=self-hosted/v0.8.2" >"$STACK/.supabase-version"
cp "$REPO/deploy/lucashome/docker-compose.override.yml" "$STACK/docker-compose.override.yml" 2>/dev/null \
  || printf 'services:\n  db:\n    mem_limit: 2g\n' >"$STACK/docker-compose.override.yml"
cp -r "$REPO/supabase/functions/." "$STACK/volumes/functions/"
printf 'archive_mode = on\n' >"$STACK/volumes/db/custom-conf.d/10-wal-archive.conf"
# backup-status.sh exits silently (set -e + pipefail on an empty grep) when the WAL archive dir is
# EMPTY — never the case on the real host; give the fake tree one synthetic segment name
printf 'synthetic' | gzip >"$STACK/volumes/db/wal_archive/000000010000000000000001.gz"
printf 'local all all trust\n' >"$STACK/volumes/db/pg_hba.conf"
for g in $(seq 1 30); do
  d="$STACK/volumes/storage/stub/stub/product-images/org-a/products/p-a$g/img.bin"; mkdir -p "$d"
  head -c $(( 100000 + g )) /dev/urandom >"$d/v$g"
done
mkdir -p "$STACK/volumes/storage/stub/stub/product-images/org-a/notes"
printf 'phfcanary-storage-bytes: synthetic object body\n' >"$STACK/volumes/storage/stub/stub/product-images/org-a/notes/canary.txt"
echo "storage tree: $(find "$STACK/volumes/storage" -type f | wc -l) files, $(du -sb "$STACK/volumes/storage" | cut -f1) bytes"

NOW_Z="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg t "$NOW_Z" '{jobs:{logical:{last_run:$t,last_success:$t,last_result:"ok"},base:{last_run:$t,last_success:$t,last_result:"ok"},
  "restore-test":{last_run:$t,last_success:$t,last_result:"ok"},status:{last_run:$t,last_result:"ok",problems:[]}}}' >"$STATUS"

cat >"$BACKUP_ENV" <<EOF
STACK_DIR=$STACK
BACKUP_ROOT=$BK
PG_IMAGE=$IMG
DB_ADMIN_USER=supabase_admin
WAL_ARCHIVE_DIR=$STACK/volumes/db/wal_archive
STORAGE_DIR=$STACK/volumes/storage
EMAIL_ENABLED=true
EMAIL_REPORT_ENABLED=true
MAIL_TRANSPORT=smtp
MAIL_FROM="POS backups <backups@example.invalid>"
ARCHIVE_MAIL_TO=backup-box@example.invalid
ALERT_MAIL_TO=alerts@example.invalid
SMTP_URL=smtp://${PFX}-smtp:1025
SMTP_REQUIRE_TLS=false
SMTP_NETRC_FILE=$CRED/smtp.netrc
RESEND_API_URL=http://127.0.0.1:18025/emails
RESEND_KEY_FILE=$CRED/resend.key
ARCHIVE_GPG_PUBKEY=$CRED/owner.pub.asc
ARCHIVE_GPG_FPR=$FPR
ARCHIVE_LABEL=pos
ARCHIVE_PART_BYTES=1048576
MAIL_RETRIES=2
MAIL_RETRY_SLEEP_S=1
MAIL_TIMEOUT_S=60
REPORT_TARGETS_FILE=$CFG/report-targets.conf
REPORT_TZ=Asia/Yangon
BUNDLE_TAR_MODE=host
EMAIL_SECRETS_MODE=local
EOF
chmod 0600 "$BACKUP_ENV"

# local mail catcher (3 MB message limit to exercise a provider-side rejection)
docker rm -f ${PFX}-smtp >/dev/null 2>&1
docker run -d --name ${PFX}-smtp --network "$NET" "$MP_IMG" --max-message-size 3 \
  --smtp-auth-accept-any --smtp-auth-allow-insecure >/dev/null || die "mailpit"

# disposable source database: baseline schema + migrations + synthetic seed
docker rm -f ${PFX}-db >/dev/null 2>&1
docker run -d --name ${PFX}-db --network "$NET" --memory 1g -e POSTGRES_PASSWORD="$PW" "$IMG" >/dev/null || die "db run"
wait_pg ${PFX}-db || die "db did not start"
su_psql ${PFX}-db <"$T/prep.sql" >"$W/prep.log" 2>&1 || { cat "$W/prep.log"; die "prep"; }
# the stack's compose init creates _supabase (analytics/supavisor metadata); the bare image does not
su_psql ${PFX}-db -c 'CREATE DATABASE _supabase' >/dev/null 2>&1
docker exec -i -e PGPASSWORD="$PW" ${PFX}-db psql -X -U supabase_admin -d _supabase -q -c 'CREATE SCHEMA _analytics; CREATE SCHEMA _supavisor;' >/dev/null || die "_supabase"
su_psql ${PFX}-db <"$BASELINE" >"$W/baseline.log" 2>&1 || { tail -20 "$W/baseline.log"; die "baseline"; }
su_psql ${PFX}-db <"$REPO/supabase/migrations/016_product_images_storage.sql" >"$W/m016.log" 2>&1 || { tail "$W/m016.log"; die "016"; }
for f in "$REPO"/supabase/migrations/*.sql; do
  n="$(basename "$f" | cut -d_ -f1)"; [[ "$n" =~ ^[0-9]+$ ]] || continue
  (( 10#$n > 61 )) || continue
  pg_psql ${PFX}-db <"$f" >"$W/mig_$n.log" 2>&1 || { tail -20 "$W/mig_$n.log"; die "migration $n"; }
done
su_psql ${PFX}-db -At <"$T/seed.sql" >"$W/seed.log" 2>&1 || { cat "$W/seed.log"; die "seed"; }
grep '^seeded' "$W/seed.log"
until curl -sf "$MP/api/v1/messages" >/dev/null; do sleep 1; done
mp_clear() { curl -s -X DELETE "$MP/api/v1/messages" >/dev/null; }
mp_clear

# ============================================================ T1 disabled gate ====
section "T1 disabled gate"
EMAIL_ENABLED=false run_job email-archive.sh; rc=$?
check "archive exits 0 while EMAIL_ENABLED=false" test "$rc" -eq 0
check "...and logs 'email tier disabled'" grep -q 'email tier disabled' "$W/last.log"
check "...and sends nothing" test "$(mp_total)" -eq 0
check "...and builds nothing" test ! -d "$BK/email-archive"
EMAIL_ENABLED=false run_job email-report.sh --date 2026-10-12; check "report exits 0 while disabled and sends nothing" test "$?" -eq 0 -a "$(mp_total)" -eq 0
run_job email-archive.sh --dry-run; check "dry-run lists inputs and exits 0" test "$?" -eq 0
check "dry-run built nothing" test ! -d "$BK/email-archive/pos-$(date -u +%G-W%V)"

# ============================================================ T2 happy path SMTP ===
section "T2 build + encrypt + split + send (SMTP catcher)"
WEEK=2026-W42; ID="pos-$WEEK"
run_job email-archive.sh --week "$WEEK"; rc=$?
[[ $rc -eq 0 ]] || tail -30 "$W/last.log"
check "archive run exits 0" test "$rc" -eq 0
NP="$(jq -r .part_count "$BK/email-archive/$ID/index.json" 2>/dev/null || echo 0)"
echo "parts: $NP, total $(jq -r .total_bytes "$BK/email-archive/$ID/index.json") bytes encrypted, payload $(jq -r .payload_bytes "$BK/email-archive/$ID/index.json") bytes"
check "archive was split into >= 3 parts at 1 MiB" test "$NP" -ge 3
check "catcher received exactly one mail per part" test "$(mp_count_subj "archive $ID part")" -eq "$NP"
check "state.json says sent with an id per part" jq -e --argjson n "$NP" '.state=="sent" and (.sent|length)==$n and ([.sent[].id|select(test("^<.+@example.invalid>$"))]|length)==$n' "$BK/email-archive/$ID/state.json"
check "status.json email-archive ok with message ids" jq -e --arg id "$ID" --argjson n "$NP" '.jobs["email-archive"] | .last_result=="ok" and .last_archive_id==$id and (.message_ids|length)==$n' "$STATUS"
check "no plaintext staging left behind" test -z "$(find "$BK/.email-tmp" -mindepth 1 2>/dev/null)"
check "local build holds only ciphertext parts + index/state" test -z "$(find "$BK/email-archive/$ID" -type f ! -name "$ID.tar.gpg.[0-9][0-9][0-9]" ! -name index.json ! -name INDEX.txt ! -name state.json)"
P1="$BK/email-archive/$ID/$ID.tar.gpg.001"
gpg --batch --list-packets "$P1" >"$W/packets.txt" 2>&1 || true
check "OpenPGP: public-key packet to the owner subkey" grep -q ':pubkey enc packet:' "$W/packets.txt"
check "OpenPGP: integrity-protected (SEIPD mdc_method 2 or AEAD)" grep -qE 'mdc_method: 2|aead encrypted packet' "$W/packets.txt"
check "OpenPGP: no symmetric/passphrase packet" bash -c "! grep -q ':symkey enc packet:' $W/packets.txt"

# ======================================================= T3 retrieve + restore =====
section "T3 retrieve from catcher, reassemble, verify, decrypt, restore into a FRESH database"
M="$W/mails/$ID"; mp_dump "$M" "archive $ID part"
U="$W/unpack/$ID"; mkdir -p "$U"
python3 -I "$BIN/email-unpack.py" --out "$U" "$M" >"$W/unpack.log" 2>&1; rc=$?
cat "$W/unpack.log" | tail -3
check "email-unpack verifies every part + total and writes the archive" test "$rc" -eq 0 -a -f "$U/$ID.tar.gpg"
check "reassembled ciphertext == built ciphertext (sha256)" test "$(sha256sum "$U/$ID.tar.gpg" | cut -d' ' -f1)" == "$(jq -r .total_sha256 "$BK/email-archive/$ID/index.json")"
gpg --batch --output "$U/archive.tar" --decrypt "$U/$ID.tar.gpg" 2>"$W/decrypt.err"; rc=$?
check "decrypts with the owner's private key (gpg exit 0)" test "$rc" -eq 0
gpg --batch --list-packets "$U/$ID.tar.gpg" 2>/dev/null >"$W/packets-full.txt"
check "no compression layer inside (pre-compressed data)" bash -c "! grep -q ':compressed packet:' $W/packets-full.txt"
X="$U/x"; mkdir -p "$X"; tar -C "$X" -xf "$U/archive.tar"
check "manifest SHA256SUMS verifies every payload file" bash -c "cd $X && sha256sum --quiet -c SHA256SUMS"
check "MANIFEST.json lists counts incl. auth users, MFA factors, schema version" jq -e '.counts.auth_users==3 and .counts.auth_mfa_factors==2 and .counts.schema_version=="080" and .counts.products==4 and .counts.storage_objects==30' "$X/MANIFEST.json"
for f in db/postgres.dump db/_supabase.dump db/globals.sql db/db-settings.sql db/app_config.json files/storage.tar.gz files/functions.tar.gz config/docker-compose.override.yml config/.supabase-version config/pg_hba.conf config/custom-conf.d/10-wal-archive.conf; do
  check "archive contains $f" test -s "$X/$f"
done
check "archive does NOT contain the .env" test -z "$(find "$X" -name '.env*')"
check "app_config.json carries the public URL row" jq -e '.[0].key=="supabase_public_url"' "$X/db/app_config.json"
mkdir -p "$U/storage"; tar -C "$U/storage" -xzf "$X/files/storage.tar.gz"
check "storage files byte-identical to the source tree" diff -r "$U/storage" "$STACK/volumes/storage"
mkdir -p "$U/functions"; tar -C "$U/functions" -xzf "$X/files/functions.tar.gz"
check "functions source identical" diff -r "$U/functions" "$STACK/volumes/functions"

# restore exactly as the runbook says: fresh stack db -> globals -> rename -> pg_restore --create
# restore_check CONTAINER XDIR [LABEL] — restores XDIR/db/* into a NEW disposable container and compares
# row checksums with the source database; LABEL prefixes the check names (T3 uses none). Reused by T16.
CHK_SQL="select json_build_object(
 'auth_users',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from auth.users t),
 'auth_mfa_factors',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from auth.mfa_factors t),
 'auth_identities',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from auth.identities t),
 'migrations',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.version),'')) from supabase_migrations.schema_migrations t),
 'organizations',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.organizations t),
 'products',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.products t),
 'sales',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.sales t),
 'sale_items',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.sale_items t),
 'inventory',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.shop_id,t.product_id),'')) from public.inventory t),
 'audit_logs',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.audit_logs t),
 'storage_buckets',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from storage.buckets t),
 'storage_objects',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from storage.objects t),
 'app_config',(select count(*)||':'||md5(coalesce(string_agg(t::text,'|' order by t.key),'')) from public.app_config t),
 'public_tables',(select count(*) from pg_tables where schemaname='public'),
 'public_functions',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
 'policies',(select count(*) from pg_policies))"
restore_check() {
  local c="$1" x="$2" lb="${3:-}" rc k src dst
  docker rm -f "$c" >/dev/null 2>&1
  docker run -d --name "$c" --network "$NET" --memory 1g -e POSTGRES_PASSWORD="$PW" "$IMG" >/dev/null
  wait_pg "$c" || bad "${lb}restore db did not start"
  R() { docker exec -i -e PGPASSWORD="$PW" "$c" "$@"; }
  R psql -X -U supabase_admin -d postgres -q -f - <"$x/db/globals.sql" >"$W/r-globals.log" 2>&1
  R psql -X -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q >"$W/r-rename.log" 2>&1 <<'SQL'
ALTER DATABASE postgres ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid();
ALTER DATABASE postgres RENAME TO postgres_fresh;
SQL
  check "${lb}runbook step: fresh 'postgres' database moved aside" test "$?" -eq 0
  R pg_restore -U supabase_admin -d template1 --create --exit-on-error <"$x/db/postgres.dump" >"$W/r-restore.log" 2>&1; rc=$?
  [[ $rc -eq 0 ]] || tail -15 "$W/r-restore.log"
  check "${lb}pg_restore --create --exit-on-error of postgres.dump succeeds" test "$rc" -eq 0
  R pg_restore -U supabase_admin -d template1 --create <"$x/db/_supabase.dump" >"$W/r-restore2.log" 2>&1
  R psql -X -U supabase_admin -d postgres -q -f - <"$x/db/db-settings.sql" >"$W/r-settings.log" 2>&1
  src="$(su_psql "${PFX}-db" -At -c "$CHK_SQL")"
  dst="$(R psql -X -U supabase_admin -d postgres -At -c "$CHK_SQL" 2>/dev/null)"
  for k in auth_users auth_mfa_factors auth_identities migrations organizations products sales sale_items inventory audit_logs storage_buckets storage_objects app_config public_tables public_functions policies; do
    check "${lb}restored $k matches source (count + row checksum)" test "$(jq -r --arg k "$k" '.[$k]' <<<"$src")" == "$(jq -r --arg k "$k" '.[$k]' <<<"$dst")"
  done
  check "${lb}restored MFA factor secret intact (TOTP keeps working)" test "$(R psql -X -U supabase_admin -d postgres -At -c "select count(*) from auth.mfa_factors where secret like 'PHFCANARYTOTPSECRET%' and status='verified'")" == 1
  docker rm -f "$c" >/dev/null 2>&1
}
restore_check "${PFX}-restore" "$X"

# ============================================================ T5 tamper ==========
section "T5 tampering is detected"
PD="$W/parts/$ID"; mkdir -p "$PD"
python3 -I - "$M" "$PD" <<'PY'
import email, email.policy, os, sys
src, dst = sys.argv[1:3]
for f in sorted(os.listdir(src)):
    m = email.message_from_binary_file(open(os.path.join(src, f), "rb"), policy=email.policy.default)
    for p in m.walk():
        fn = p.get_filename()
        if fn and (".tar.gpg." in fn or fn.endswith(".index.json")):
            open(os.path.join(dst, fn), "wb").write(p.get_payload(decode=True))
PY
check "raw parts + index extracted from mails" test -f "$PD/$ID.tar.gpg.002" -a -f "$PD/$ID.index.json"
python3 -I "$BIN/email-unpack.py" "$PD" >/dev/null 2>&1; check "unpack accepts the untouched raw parts" test "$?" -eq 0
python3 -I -c 'import sys; p=sys.argv[1]; d=bytearray(open(p,"rb").read()); d[len(d)//2]^=0x01; open(p,"wb").write(d)' "$PD/$ID.tar.gpg.002"
python3 -I "$BIN/email-unpack.py" --out "$W/tamper-out" "$PD" >"$W/tamper.log" 2>&1; rc=$?
check "unpack refuses: exit != 0" test "$rc" -ne 0
check "unpack names the tampered part (2)" grep -q 'part 2/.*MISMATCH' "$W/tamper.log"
check "unpack wrote no archive" test ! -e "$W/tamper-out/$ID.tar.gpg"
cat "$PD/$ID.tar.gpg."[0-9][0-9][0-9] >"$W/tampered.tar.gpg"
gpg --batch --output "$W/tampered.tar" --decrypt "$W/tampered.tar.gpg" 2>"$W/tamper-gpg.err"; rc=$?
check "bypassing the hashes: gpg decryption fails (exit != 0)" test "$rc" -ne 0
check "...with an integrity error (MDC/AEAD)" grep -qiE 'manipulated|integrity|authentication|decryption failed' "$W/tamper-gpg.err"
if [[ -s "$W/tampered.tar" ]]; then
  echo "NOTE  gpg still wrote $(stat -c %s "$W/tampered.tar") bytes of unverified plaintext before failing -> runbook: decrypt to a file, use it only if gpg exits 0"
fi
python3 -I - "$PD/$ID.index.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["parts"][0]["sha256"] = "0" * 64; open(p, "w").write(json.dumps(d))
PY
cp "$P1" "$PD/$ID.tar.gpg.001"
python3 -I "$BIN/email-unpack.py" "$PD" "$M" >"$W/tamper2.log" 2>&1
check "conflicting index copies (forged index) are refused" grep -q 'index copies differ' "$W/tamper2.log"

# ============================================================ T6 idempotency =====
section "T6 idempotency"
BEFORE="$(mp_total)"
run_job email-archive.sh --week "$WEEK"; rc=$?
check "rerun of a completed week exits 0" test "$rc" -eq 0
check "...logs already sent" grep -q 'already sent completely' "$W/last.log"
check "...and sends nothing" test "$(mp_total)" -eq "$BEFORE"
run_job email-archive.sh --week "$WEEK" --force; rc=$?
check "--force builds and sends a new archive id" test "$rc" -eq 0 -a "$(mp_count_subj "archive $ID-r")" -ge 3

# ============================================================ T7 resume ===========
section "T7 SMTP fails mid-way, rerun resumes without re-sending accepted parts"
python3 -I "$T/smtp-stub.py" --port 12525 --dir "$W/stub1" --accept 1 & STUB=$!
sleep 1
WK=2026-W30; RID="pos-$WK"
SMTP_URL=smtp://127.0.0.1:12525 SMTP_NETRC_FILE=none run_job email-archive.sh --week "$WK"; rc=$?
check "mid-way failure: exit != 0" test "$rc" -ne 0
check "mid-way failure: status FAIL" test "$(st '.jobs["email-archive"].last_result')" == fail
check "mid-way failure: state not 'sent', exactly 1 part recorded" jq -e '.state=="built" and (.sent|length)==1' "$BK/email-archive/$RID/state.json"
check "mid-way failure: log says NOT accepted" grep -q 'NOT accepted' "$W/last.log"
check "mid-way failure: no success line" bash -c "! grep -q 'archive $RID sent' $W/last.log"
kill $STUB 2>/dev/null; wait $STUB 2>/dev/null
NP2="$(jq -r .part_count "$BK/email-archive/$RID/index.json")"
run_job email-archive.sh --week "$WK"; rc=$?
check "resume run exits 0" test "$rc" -eq 0
check "resume sent only the missing parts ($(( NP2 - 1 )))" test "$(mp_count_subj "archive $RID part")" -eq $(( NP2 - 1 ))
check "resume logs the skipped part" grep -q 'part 1/.* already accepted earlier' "$W/last.log"
mp_dump "$W/mails/$RID" "archive $RID part"
python3 -I "$BIN/email-unpack.py" "$W/stub1" "$W/mails/$RID" >/dev/null 2>&1
check "parts from the failed + resumed runs reassemble and verify" test "$?" -eq 0

# ============================================================ T8 fail closed =====
section "T8 fail closed"
LAST_OK="$(st '.jobs["email-archive"].last_success')"
expect_fail() {  # NAME WEEK [env...] — run, then assert nonzero + FAIL status + no new last_success
  local name="$1" wk="$2"; shift 2
  env "$@" "$BIN/email-archive.sh" --week "$wk" >"$W/last.log" 2>&1; local rc=$?
  check "$name: exit != 0" test "$rc" -ne 0
  check "$name: status.json last_result=fail" test "$(st '.jobs["email-archive"].last_result')" == fail
  check "$name: last_success unchanged" test "$(st '.jobs["email-archive"].last_success')" == "$LAST_OK"
  check "$name: never reported success" bash -c "! grep -q 'archive pos-$wk sent' $W/last.log"
}
A0="$(mp_count_subj 'FAILED: email-archive')"
expect_fail "SMTP unreachable" 2026-W31 SMTP_URL=smtp://127.0.0.1:1
expect_fail "provider rejects oversize part (552)" 2026-W32 ARCHIVE_PART_BYTES=4194304
check "oversize: log shows the SMTP rejection" grep -qiE 'NOT accepted.*(552|curl exit)' "$W/last.log"
expect_fail "local size guard" 2026-W33 MAIL_MAX_ENCODED_BYTES=500000
check "size guard: refused before handing over" grep -q 'over MAIL_MAX_ENCODED_BYTES' "$W/last.log"
check "size guard: nothing of W33 reached the catcher" test "$(mp_count_subj 'archive pos-2026-W33 part')" -eq 0
expect_fail "recipient key fingerprint mismatch" 2026-W34 ARCHIVE_GPG_FPR="$FPR_OTHER"
check "fingerprint mismatch: nothing was built" test ! -e "$BK/email-archive/pos-2026-W34"
expect_fail "recipient key file missing" 2026-W35 ARCHIVE_GPG_PUBKEY="$CRED/nope.asc"
expect_fail "key file holds SECRET key material" 2026-W36 ARCHIVE_GPG_PUBKEY="$CRED/owner.SECRET.asc"
check "secret-key file: refused explicitly" grep -qE 'SECRET key material|exactly one public key' "$W/last.log"
mkdir -p /tiny/t /tiny/a
expect_fail "disk full in the staging dir" 2026-W37 ARCHIVE_TMP_DIR=/tiny/t
check "disk full (staging): no plaintext left in /tiny" test -z "$(find /tiny/t -mindepth 1)"
expect_fail "disk full in the archive dir (encrypt output)" 2026-W38 ARCHIVE_DIR=/tiny/a
check "disk full (output): no partial build left" test -z "$(find /tiny/a -mindepth 1 -name '*.partial')"
cp "$CRED/smtp.netrc" "$CRED/smtp.loose"; chmod 0644 "$CRED/smtp.loose"
expect_fail "credential file with loose permissions" 2026-W39 SMTP_NETRC_FILE="$CRED/smtp.loose"
check "loose credential: preflight names the mode" grep -q 'has mode 644' "$W/last.log"
check "failure notifications reached the alert address" test "$(mp_count_subj 'FAILED: email-archive')" -gt "$A0"

# ============================================================ T9 Resend transport =
section "T9 Resend API transport (fake endpoint)"
python3 -I "$T/fake-resend.py" --port 18025 --dir "$W/resend" --key-file "$CRED/resend.key" --max-bytes 40000000 & FR=$!
sleep 1
WR=2026-W40; RS="pos-$WR"
MAIL_TRANSPORT=resend run_job email-archive.sh --week "$WR"; rc=$?
[[ $rc -eq 0 ]] || tail -20 "$W/last.log"
check "resend transport: exit 0" test "$rc" -eq 0
NR="$(jq -r .part_count "$BK/email-archive/$RS/index.json" 2>/dev/null || echo 0)"
check "resend transport: one API call per part" test "$(ls "$W/resend"/*.json 2>/dev/null | wc -l)" -eq "$NR"
check "resend transport: every call carried an Idempotency-Key" test "$(jq -r '.idempotency_key' "$W/resend"/*.json | grep -c "^$RS-p")" -eq "$NR"
check "resend transport: provider ids recorded" jq -e --argjson n "$NR" '[.sent[].id | select(test("^[0-9a-f-]{36}$"))] | length == $n' "$BK/email-archive/$RS/state.json"
RP="$W/resend-parts"; mkdir -p "$RP"
for j in "$W/resend"/*.json; do
  jq -r '.body.attachments[] | select(.filename|test("tar.gpg|index.json")) | "\(.filename)\t\(.content)"' "$j" | while IFS=$'\t' read -r fn c; do printf '%s' "$c" | base64 -d >"$RP/$fn"; done
done
python3 -I "$BIN/email-unpack.py" "$RP" >/dev/null 2>&1; check "resend transport: attachments reassemble + verify" test "$?" -eq 0
MAIL_TRANSPORT=resend run_job email-archive.sh --week "$WR"; check "resend transport: rerun sends nothing" test "$(ls "$W/resend"/*.json | wc -l)" -eq "$NR"
LAST_OK="$(st '.jobs["email-archive"].last_success')"
expect_fail "resend: wrong API key (401)" 2026-W41 MAIL_TRANSPORT=resend RESEND_KEY_FILE="$CRED/resend.wrong.key"
echo 500 >"$W/resend/MODE"
expect_fail "resend: provider 500 (retried, then fail)" 2026-W43 MAIL_TRANSPORT=resend
check "resend 500: retried before failing" grep -q 'retrying' "$W/last.log"
echo 422 >"$W/resend/MODE"
expect_fail "resend: provider 422 (permanent)" 2026-W44 MAIL_TRANSPORT=resend
echo ok >"$W/resend/MODE"

# ============================================================ T10 daily report ====
section "T10 daily report"
cat >"$CFG/report-targets.conf" <<EOF
# org_id   recipients                     options
org-a      backup-box@example.invalid     health
org-b      admin-b@example.invalid
EOF
chmod 0600 "$CFG/report-targets.conf"
run_job email-report.sh --date 2026-10-12 --render-only "$W/render"; rc=$?
[[ $rc -eq 0 ]] || tail -20 "$W/last.log"
check "render-only works and sends nothing" test "$rc" -eq 0 -a "$(mp_count_subj 'Daily report')" -eq 0
RA="$W/render/org-a/report.json"
check "org A: 2 completed, 1 refunded, 1 void (700)" jq -e '.sales.completed_count==2 and .sales.refunded_count==1 and .sales.void_count==1 and .sales.void_total_mmk==700' "$RA"
check "org A: revenue 7500 (Yangon day boundaries, voids excluded)" jq -e '.sales.revenue_mmk==7500 and .sales.discount_mmk==100 and .sales.units_sold==6' "$RA"
check "org A: estimated COGS 4500 (snapshot, fallback to product cost)" jq -e '.sales.cogs_est_mmk==4500' "$RA"
check "org A: payments CASH 5000 / KBZPAY 2500" jq -e '[.sales.by_payment[]|"\(.method)=\(.total_mmk)"]|sort==["CASH=5000","KBZPAY=2500"]' "$RA"
check "org A: refund/void requests + pending" jq -e '.refund_void_requests.pending_total==1 and ([.refund_void_requests.created[].count]|add)==2' "$RA"
check "org A: inventory low 2, value 76800 cost / 128000 retail" jq -e '.inventory.low_stock_count==2 and .inventory.valuation_cost_mmk==76800 and .inventory.valuation_retail_mmk==128000' "$RA"
check "org A: purchases + supplier debt 30000 + payments 20000 (voided excluded)" jq -e '.purchases.created_count==1 and .purchases.received_total_mmk==50000 and .purchases.supplier_debt_mmk==30000 and .purchases.supplier_payments_mmk==20000' "$RA"
check "org A: shifts opened 2 closed 1 open 1 variance -500" jq -e '.shifts.opened==2 and .shifts.closed==1 and .shifts.open_now==1 and .shifts.variance_total_mmk==-500' "$RA"
check "org A: audit events 3; expenses marked unsupported" jq -e '.audit_events==3 and .expenses.supported==false' "$RA"
check "org A report has no org B data" bash -c "! grep -qE 'phfcanary-orgb|77777|77,777' $W/render/org-a/*"
check "org B report has no org A data" bash -c "! grep -qE 'phfcanary-product|7,500 MMK' $W/render/org-b/*"
check "org B report: its own sale" jq -e '.sales.revenue_mmk==77777' "$W/render/org-b/report.json"
check "health block only for the operator target" bash -c "grep -q 'BACKUP HEALTH' $W/render/org-a/body.txt && ! grep -q 'BACKUP HEALTH' $W/render/org-b/body.txt"
check "health block shows the last weekly archive" grep -q 'weekly email archive: last' "$W/render/org-a/body.txt"
check "report text carries no secrets/credentials" bash -c "! grep -rqE 'phfcanary-env|re_test_|not-a-real-password|BEGIN PGP' $W/render"
run_job email-report.sh --date 2026-10-12; rc=$?
check "report send exits 0" test "$rc" -eq 0
check "one mail per target" test "$(mp_count_subj 'Daily report 2026-10-12')" -eq 2
mp_dump "$W/mails/report" "Daily report 2026-10-12"
check "org A mail went only to its recipient" python3 -I - "$W/mails/report" <<'PY'
import email, email.policy, os, sys
d = sys.argv[1]; seen = {}
for f in os.listdir(d):
    m = email.message_from_binary_file(open(os.path.join(d, f), "rb"), policy=email.policy.default)
    org = "A" if "Org A" in str(m["Subject"]) else "B"
    seen.setdefault(org, set()).add(str(m["To"]).strip())
sys.exit(0 if seen == {"A": {"backup-box@example.invalid"}, "B": {"admin-b@example.invalid"}} else 1)
PY
run_job email-report.sh --date 2026-10-12; check "rerun same day: nothing sent again" test "$(mp_count_subj 'Daily report 2026-10-12')" -eq 2
check "rerun same day: status ok with skipped=2" jq -e '.jobs["email-report"].last_result=="ok" and .jobs["email-report"].skipped==2' "$STATUS"
run_job email-report.sh --date 2026-10-12 --force; check "--force sends again" test "$(mp_count_subj 'Daily report 2026-10-12')" -eq 4
printf 'org-missing  x@example.invalid\n' >"$CFG/report-targets.bad"
REPORT_TARGETS_FILE="$CFG/report-targets.bad" run_job email-report.sh --date 2026-10-12; rc=$?
check "unknown organization: exit != 0 and status fail" test "$rc" -ne 0 -a "$(st '.jobs["email-report"].last_result')" == fail
SALES_BEFORE="$(su_psql ${PFX}-db -At -c 'select count(*) from sales')"
check "report is read-only (row counts unchanged)" test "$SALES_BEFORE" -eq 7
check "report SQL runs in a READ ONLY transaction" grep -q 'READ ONLY' "$BIN/email-report.sql"

# ============================================================ T11 secrets file ====
section "T11 separate secrets file"
run_job email-secrets.sh; rc=$?
[[ $rc -eq 0 ]] || tail -10 "$W/last.log"
SF="$(ls "$BK/email-secrets/"*.tar.gpg 2>/dev/null | tail -1)"
check "secrets file built (local mode, nothing mailed)" test "$rc" -eq 0 -a -n "$SF" -a "$(mp_count_subj ' secrets ')" -eq 0
gpg --batch --decrypt "$SF" 2>/dev/null >"$W/secrets.tar"
check "secrets file decrypts and holds the .env" bash -c "tar -xOf $W/secrets.tar ./stack/.env | grep -q 'phfcanary-env-secret-91aa'"
check "secrets file is integrity-protected public-key OpenPGP" bash -c "gpg --batch --list-packets $SF 2>/dev/null | grep -q 'mdc_method: 2'"
EMAIL_SECRETS_MODE=email run_job email-secrets.sh; check "email mode: first run mails it" test "$(mp_count_subj ' secrets ')" -eq 1
EMAIL_SECRETS_MODE=email run_job email-secrets.sh; check "email mode: unchanged set is not mailed again" test "$(mp_count_subj ' secrets ')" -eq 1
echo "EXTRA=1" >>"$STACK/.env"
EMAIL_SECRETS_MODE=email run_job email-secrets.sh; check "email mode: changed set is mailed" test "$(mp_count_subj ' secrets ')" -eq 2

# ============================================================ T14 selftest ========
section "T14 --selftest: synthetic end-to-end check for the owner's first live send"
ARCH_BEFORE="$(jq -c '.jobs["email-archive"]' "$STATUS")"
run_job email-archive.sh --selftest; rc=$?
[[ $rc -eq 0 ]] || tail -10 "$W/last.log"
check "selftest exits 0" test "$rc" -eq 0
check "selftest mail delivered (subject marks it synthetic)" test "$(mp_count_subj 'SELFTEST (synthetic, no data)')" -eq 1
mp_dump "$W/mails/selftest" "SELFTEST"
python3 -I "$BIN/email-unpack.py" --out "$W/st" "$W/mails/selftest" >/dev/null 2>&1; check "selftest mail unpacks + verifies" test "$?" -eq 0
gpg --batch --output "$W/st/st.tar" --decrypt "$W/st/"*.tar.gpg 2>/dev/null; check "selftest decrypts with the owner key" test "$?" -eq 0
check "selftest payload is the synthetic note" bash -c "tar -xOf $W/st/st.tar ./SELFTEST.txt | grep -q 'Synthetic content only'"
check "selftest payload holds no database dump or storage" bash -c "! tar -tf $W/st/st.tar | grep -qE 'postgres.dump|storage.tar.gz|globals.sql'"
check "selftest recorded as job email-selftest" test "$(st '.jobs["email-selftest"].last_result')" == ok
check "selftest left the weekly archive status untouched" test "$(jq -c '.jobs["email-archive"]' "$STATUS")" == "$ARCH_BEFORE"
check "selftest left no local build" test -z "$(find "$BK/email-archive" -maxdepth 1 -name '*selftest*')"
# ============================================================ T4 canary scan ======
section "T4 no plaintext data or secret in any outgoing mail"
ALL="$W/mails/all"; mp_dump "$ALL" ""
cp "$W/stub1"/*.eml "$ALL/" 2>/dev/null
echo "scanning $(ls "$ALL" | wc -l) mails from the catcher/stub + $(ls "$W/resend"/*.json | wc -l) Resend payloads"
python3 -I - "$ALL" "$W/resend" "$CRED/resend.key" >"$W/scan.log" 2>&1 <<'PY'
import base64, email, email.policy, json, os, sys
mails, resend, keyfile = sys.argv[1:4]
canaries = [b"phfcanary", b"not-a-real-password", open(keyfile, "rb").read().strip(), b"BEGIN PGP PRIVATE"]
hits = []
def scan(label, blob):
    low = blob.lower()
    for c in canaries:
        if c.lower() in low:
            hits.append(f"{label}: {c[:12]!r}")
n = 0
for f in sorted(os.listdir(mails)):
    raw = open(os.path.join(mails, f), "rb").read(); n += 1
    m = email.message_from_bytes(raw, policy=email.policy.default)
    subj = str(m["Subject"])
    if "Daily report" in subj:
        continue  # the business report is plaintext by design (checked separately: no secrets, org-scoped)
    scan(f, raw)
    for p in m.walk():
        b = p.get_payload(decode=True)
        if b:
            scan(f + ":" + str(p.get_filename()), b)
for f in sorted(os.listdir(resend)):
    if not f.endswith(".json"):
        continue
    d = json.load(open(os.path.join(resend, f))); n += 1
    scan(f, json.dumps(d).encode())
    for a in d["body"].get("attachments", []):
        scan(f + ":" + a["filename"], base64.b64decode(a["content"]))
print(f"scanned {n} messages; hits: {len(hits)}")
for h in hits:
    print("HIT", h)
sys.exit(1 if hits else 0)
PY
rc=$?; cat "$W/scan.log" | head -5
check "no canary/secret in any archive, secrets or alert mail (raw + decoded parts)" test "$rc" -eq 0
check "positive control: the canary IS inside the decrypted payload" grep -rq 'phfcanary-storage-bytes' "$U/storage"

# ============================================================ T12 status ==========
section "T12 backup-status integration"
EMAIL_ENABLED=false "$BIN/email-status.sh" --json >"$W/es.json"; rc=$?
check "email-status disabled: exit 0, enabled=false, no problems" jq -e '.enabled==false and (.problems|length)==0' "$W/es.json"
"$BIN/email-status.sh" --json >"$W/es2.json"
check "email-status enabled: lines for archive + report, JSON valid" jq -e '.enabled==true and (.lines|length)>=2' "$W/es2.json"
check "email-status enabled: recent failures from the fail-closed tests are reported" jq -e '[.problems[]|select(test("email-archive: last run failed|email-report: last run failed"))]|length>=1' "$W/es2.json"
# backup-status.sh sources backup.env itself (backup-lib.sh does not know the email variables), so the
# disabled state is set the way production sets it: EMAIL_ENABLED=false in backup.env
sed 's/^EMAIL_ENABLED=true$/EMAIL_ENABLED=false/' "$BACKUP_ENV" >"$CFG/backup.disabled.env"
BACKUP_ENV="$CFG/backup.disabled.env" "$BIN/backup-status.sh" --no-db >"$W/bs-with.txt" 2>"$W/bs-with.err"; rc1=$?
mkdir -p "$W/bin-old"; cp "$BIN"/*.sh "$W/bin-old/"; rm -f "$W/bin-old/email-"*.sh
cp "$REPO/deploy/lucashome/backup/backup-status.sh" "$W/bin-old/backup-status.sh"
BACKUP_ENV="$CFG/backup.disabled.env" "$W/bin-old/backup-status.sh" --no-db >"$W/bs-without.txt" 2>"$W/bs-without.err"; rc2=$?
"$BIN/backup-status.sh" --no-db >"$W/bs-enabled.txt" 2>/dev/null
check "backup-status: with the tier ENABLED, email failures become backup problems" grep -q 'email-archive: last run failed' "$W/bs-enabled.txt"
grep -q '^STATUS:' "$W/bs-with.txt" || { echo "backup-status produced no summary; stderr:"; tail -5 "$W/bs-with.err"; }
check "backup-status: runs to its summary in the test tree" grep -q '^STATUS:' "$W/bs-with.txt"
check "backup-status: same exit code with the email tier disabled" test "$rc1" -eq "$rc2"
check "backup-status: identical problem list with the tier disabled" bash -c "diff <(sed -n '/^STATUS:/,\$p' $W/bs-with.txt) <(sed -n '/^STATUS:/,\$p' $W/bs-without.txt)"
check "backup-status: shows 'email tier: disabled'" grep -q 'email tier: disabled' "$W/bs-with.txt"
grep -q 'email tier: disabled' "$W/bs-with.txt" || { echo "--- with:"; sed -n '/^offsite/,$p' "$W/bs-with.txt"; echo "--- without:"; sed -n '/^offsite/,$p' "$W/bs-without.txt"; }
check "backup-status: without email-status.sh there is no email line" bash -c "! grep -q 'email tier' $W/bs-without.txt"

# ============================================================ T13 renderer units ==
section "T13 report renderer unit tests"
python3 -I "$T/test_email_report.py" "$BIN/email-report.py" >"$W/unit.log" 2>&1; rc=$?
tail -3 "$W/unit.log"
check "renderer unit tests ($(grep -c ' ... ok' "$W/unit.log") ok)" test "$rc" -eq 0

# ============================================================ T15 --no-send =======
section "T15 --no-send / --output-dir: build for a drill, never send"
MP_BEFORE="$(mp_total)"; ARCH_BEFORE="$(jq -c '.jobs["email-archive"]' "$STATUS")"
NS="$W/nosend"; NWK=2026-W25; NID="pos-$NWK"
EMAIL_ENABLED=false run_job email-archive.sh --no-send --output-dir "$NS" --week "$NWK"; rc=$?
[[ $rc -eq 0 ]] || tail -10 "$W/last.log"
check "--no-send builds while EMAIL_ENABLED=false (not gated)" test "$rc" -eq 0 -a -f "$NS/$NID/index.json"
check "--no-send: encrypted parts are in --output-dir" test "$(jq -r .part_count "$NS/$NID/index.json" 2>/dev/null || echo 0)" -ge 3
check "--no-send: nothing in the regular ARCHIVE_DIR for that id" test ! -e "$BK/email-archive/$NID"
check "--no-send: no plaintext staging left in --output-dir" test -z "$(find "$NS/.tmp" -mindepth 1 2>/dev/null)"
check "--no-send: no mail sent" test "$(mp_total)" -eq "$MP_BEFORE"
check "--no-send: recorded as job email-archive-nosend (built)" test "$(st '.jobs["email-archive-nosend"].last_result')" == built
check "--no-send: real email-archive status untouched" test "$(jq -c '.jobs["email-archive"]' "$STATUS")" == "$ARCH_BEFORE"
# stage the files under the names the mails carry them (parts + <id>.index.json), as a drill does
mkdir -p "$W/ns-mail"; cp "$NS/$NID/$NID".tar.gpg.[0-9][0-9][0-9] "$W/ns-mail/" 2>/dev/null; cp "$NS/$NID/index.json" "$W/ns-mail/$NID.index.json" 2>/dev/null
python3 -I "$BIN/email-unpack.py" --out "$W/ns-out" "$W/ns-mail" >/dev/null 2>&1; check "--no-send build unpacks + verifies" test "$?" -eq 0
gpg --batch --output "$W/ns-out/x.tar" --decrypt "$W/ns-out/$NID.tar.gpg" 2>/dev/null; check "--no-send build decrypts (owner key)" test "$?" -eq 0
check "--no-send payload holds the database dump" bash -c "tar -tf $W/ns-out/x.tar | grep -q 'db/postgres.dump'"
EMAIL_ENABLED=true run_job email-archive.sh --no-send --output-dir "$NS" --week 2026-W24; rc=$?
check "--no-send with EMAIL_ENABLED=true still sends nothing" test "$rc" -eq 0 -a "$(mp_total)" -eq "$MP_BEFORE"
EMAIL_ENABLED=true ARCHIVE_GPG_FPR="$FPR_OTHER" run_job email-archive.sh --no-send --output-dir "$NS" --week 2026-W23; rc=$?
check "--no-send failure (key pin mismatch): exit != 0" test "$rc" -ne 0
check "--no-send failure: no alert mail" test "$(mp_total)" -eq "$MP_BEFORE"
check "--no-send failure: recorded on email-archive-nosend only" bash -c "test \"\$(jq -r '.jobs[\"email-archive-nosend\"].last_result' $STATUS)\" = fail && test '$(jq -c '.jobs["email-archive"]' "$STATUS")' = \"\$(jq -c '.jobs[\"email-archive\"]' $STATUS)\""
run_job email-archive.sh --output-dir "$NS" --week 2026-W29; rc=$?
check "--output-dir without --no-send is refused" test "$rc" -ne 0 -a ! -e "$NS/pos-2026-W29" -a ! -e "$BK/email-archive/pos-2026-W29"
run_job email-archive.sh --no-send --output-dir relative/dir --week 2026-W29; rc=$?
check "--output-dir must be absolute" test "$rc" -ne 0
rm -rf "$NS" "$W/ns-out" "$W/ns-mail"

# ============================================================ T16 Gmail API ======
# shellcheck source=suite-gmail.sh
. "$T/suite-gmail.sh"

# ------------------------------------------------------------------ teardown ----
kill "$FR" 2>/dev/null
docker rm -f ${PFX}-db ${PFX}-smtp ${PFX}-restore phf-gm-e2e-restore >/dev/null 2>&1
rm -rf /keys/owner /keys/other
printf '\n==== RESULT: %d passed, %d failed ====\n' "$PASS" "$FAIL"
for n in ${FAILED_NAMES[@]+"${FAILED_NAMES[@]}"}; do echo "  failed: $n"; done
(( FAIL == 0 ))
