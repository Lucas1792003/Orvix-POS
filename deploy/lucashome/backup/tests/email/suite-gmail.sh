# suite-gmail.sh — T16: MAIL_TRANSPORT=gmail-api against a mock Google (fake-google.py) on 127.0.0.1.
# Sourced by suite.sh (needs its helpers, the seeded source database and the throwaway owner key).
# Synthetic only: random client id/secret/refresh token generated here, no network beyond 127.0.0.1.
# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034  # W, BK, CRED, BIN, SRC, T, STATUS ... come from suite.sh; checkx evals read rc2/LAST_OK

GM="$W/gm"; GMD="$GM/mockg"; GPORT=18443
GM_RESTORE=phf-gm-e2e-restore
mkdir -p "$GM/shim" "$GMD" "$CRED/mint"
cp "$T/curl-shim.sh" "$GM/shim/curl"; chmod 0755 "$GM/shim/curl"
hexr() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
GCID="phfgm-cid-$(hexr 6).apps.googleusercontent.com"
GCSEC="GOCSPX-phfgmsecret$(hexr 12)"
GRTOK="1//phfgmrefresh$(hexr 16)"
GSCOPE=https://www.googleapis.com/auth/gmail.send
GCRED="$CRED/gmail-oauth.json"
# printf is a builtin: the values never appear in any process's argv
gm_write_creds() {  # FILE SCOPE
  ( umask 077; printf '{"client_id":"%s","client_secret":"%s","refresh_token":"%s","scope":"%s","created":"2026-10-13T00:00:00Z"}\n' \
      "$GCID" "$GCSEC" "$GRTOK" "$2" >"$1" )
}
gm_write_creds "$GCRED" "$GSCOPE"
( umask 077; printf '{"installed":{"client_id":"%s","project_id":"phf-test","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","client_secret":"%s","redirect_uris":["http://localhost"]}}\n' \
    "$GCID" "$GCSEC" >"$CRED/client.json" )

GMENV=(MAIL_TRANSPORT=gmail-api MAIL_FROM= GMAIL_SENDER=pos.sender@example.invalid GMAIL_OAUTH_FILE="$GCRED"
  GMAIL_TOKEN_URL="http://127.0.0.1:$GPORT/token" GMAIL_API_BASE="http://127.0.0.1:$GPORT"
  PATH="$GM/shim:$PATH" CURL_ARGV_LOG="$GM/curl-argv.log" CURL_TOKDIR_LOG="$GM/tokdir.log"
  CURL_LEAK_LOG="$GM/leak.log" CURL_LEAK_MARK_FILE="$CRED/.leak-mark" CURL_SCAN_DIRS="$BK /tmp $W" CURL_SCAN_EXCLUDE=mockg
  MAIL_RETRIES=3 MAIL_RETRY_SLEEP_S=1)
gm_job() {  # [VAR=value ...] SCRIPT [ARGS...] — one gmail-api run; output -> $W/last.log (+ appended to all-runs.log)
  env "${GMENV[@]}" "$@" >"$W/last.log" 2>&1; local rc=$?
  { echo "### $*"; cat "$W/last.log"; } >>"$GM/all-runs.log"
  return $rc
}
gm_scn() { printf '%s\n' "$1" >"$GMD/SCENARIO"; }
gm_mark() { GM_MARK="$(wc -l <"$GMD/requests.log" 2>/dev/null || echo 0)"; GM_SENT_MARK="$(find "$GMD/sent" -name '*.eml' 2>/dev/null | wc -l)"; }
gm_since() { tail -n +$(( GM_MARK + 1 )) "$GMD/requests.log" 2>/dev/null; }
gm_count() { gm_since | grep -c -- "$1"; }   # PATTERN — requests since the mark
gm_collect() {  # DIR — copy the messages the mock accepted since the mark
  mkdir -p "$1"
  find "$GMD/sent" -name '*.eml' 2>/dev/null | LC_ALL=C sort | tail -n +$(( GM_SENT_MARK + 1 )) | while read -r f; do cp "$f" "$1/"; done
}
gm_status() { jq -r "$1" "$STATUS" 2>/dev/null; }
checkx() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }   # DESC 'shell expression'
ps_start() { ( while :; do ps -eo args= >>"$GM/ps.log" 2>/dev/null; sleep 0.05; done ) & PSS=$!; }
ps_stop() { kill "$PSS" 2>/dev/null; wait "$PSS" 2>/dev/null; }
# e2e ARCHIVE_ID MAILDIR LABEL — unpack the mails the mock received, verify, decrypt, compare, restore
gm_e2e() {
  local id="$1" md="$2" lb="$3" u x rc
  u="$GM/unpack/$id"; x="$u/x"; mkdir -p "$u"
  python3 -I "$BIN/email-unpack.py" --out "$u" "$md" >"$GM/unpack-$id.log" 2>&1; rc=$?
  check "${lb}email-unpack verifies every part + total of the received mails" test "$rc" -eq 0 -a -f "$u/$id.tar.gpg"
  check "${lb}reassembled ciphertext == built ciphertext (sha256)" test "$(sha256sum "$u/$id.tar.gpg" 2>/dev/null | cut -d' ' -f1)" == "$(jq -r .total_sha256 "$BK/email-archive/$id/index.json" 2>/dev/null)"
  gpg --batch --output "$u/archive.tar" --decrypt "$u/$id.tar.gpg" 2>/dev/null; rc=$?
  check "${lb}decrypts with the throwaway owner key (gpg exit 0)" test "$rc" -eq 0
  mkdir -p "$x"; tar -C "$x" -xf "$u/archive.tar" 2>/dev/null
  check "${lb}SHA256SUMS inside the archive verifies" bash -c "cd '$x' && sha256sum --quiet -c SHA256SUMS"
  mkdir -p "$u/storage"; tar -C "$u/storage" -xzf "$x/files/storage.tar.gz" 2>/dev/null
  check "${lb}storage files byte-identical to the source tree" diff -r "$u/storage" "$STACK/volumes/storage"
  restore_check "$GM_RESTORE" "$x" "$lb"
}

gm_main() {
section "T16 Gmail API transport (mock Google on 127.0.0.1; no real Google, no real mail)"
python3 -I "$T/fake-google.py" --port "$GPORT" --dir "$GMD" --creds "$GCRED" & GFP=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$GPORT/" && break; sleep 0.1; done
gm_scn ok
: >"$GMD/requests.log"
printf 'ya29.phfgm\n' >"$CRED/.leak-mark"     # prefix of every access token the mock issues
# positive control: the curl shim's leak scan does find a planted token outside a token dir
printf 'ya29.phfgmPLANTED\n' >"$W/planted.txt"
env CURL_LEAK_LOG="$GM/leak-control.log" CURL_LEAK_MARK_FILE="$CRED/.leak-mark" CURL_SCAN_DIRS="$W" CURL_SCAN_EXCLUDE=mockg \
  "$GM/shim/curl" --version >/dev/null 2>&1
rm -f "$W/planted.txt"
check "leak scan positive control: a planted token file is detected by the shim" grep -q 'planted.txt' "$GM/leak-control.log"
ps_start

# ---- preflight: nothing reaches Google when configuration or credentials are wrong
gm_mark
gm_job GMAIL_TOKEN_URL=http://oauth.example.invalid/token "$BIN/email-archive.sh" --selftest; rc=$?
check "gmail preflight: non-127.0.0.1 http token URL refused (exit != 0)" test "$rc" -ne 0
check "gmail preflight: ...log explains the 127.0.0.1-only override" grep -q 'may only point at 127.0.0.1' "$W/last.log"
gm_job GMAIL_API_BASE=https://gmail.example.invalid "$BIN/email-archive.sh" --selftest; rc=$?
check "gmail preflight: non-Google https API base refused" test "$rc" -ne 0
cp "$GCRED" "$CRED/gm.loose"; chmod 0644 "$CRED/gm.loose"
gm_job GMAIL_OAUTH_FILE="$CRED/gm.loose" "$BIN/email-archive.sh" --selftest; rc=$?
checkx "gmail preflight: credential file mode 0644 refused" '[[ $rc -ne 0 ]] && grep -q "has mode 644" "$W/last.log"'
cp "$GCRED" "$CRED/gm.other"; chmod 0600 "$CRED/gm.other"; chown 65534 "$CRED/gm.other"
gm_job GMAIL_OAUTH_FILE="$CRED/gm.other" "$BIN/email-archive.sh" --selftest; rc=$?
checkx "gmail preflight: credential file owned by another user refused" '[[ $rc -ne 0 ]] && grep -q "not owned by" "$W/last.log"'
gm_write_creds "$CRED/gm.broad" "https://mail.google.com/"
gm_job GMAIL_OAUTH_FILE="$CRED/gm.broad" "$BIN/email-archive.sh" --selftest; rc=$?
checkx "gmail preflight: credential file with a scope other than gmail.send refused" '[[ $rc -ne 0 ]] && grep -q "must be exactly gmail.send" "$W/last.log"'
gm_job MAIL_FROM="POS <someone.else@example.invalid>" "$BIN/email-archive.sh" --selftest; rc=$?
checkx "gmail preflight: From other than the sender account refused" '[[ $rc -ne 0 ]] && grep -q "MAIL_FROM must use the GMAIL_SENDER" "$W/last.log"'
gm_job MAIL_MAX_ENCODED_BYTES=40000000 "$BIN/email-archive.sh" --selftest; rc=$?
checkx "gmail preflight: size limit above the 35 MiB API upload maximum refused" '[[ $rc -ne 0 ]] && grep -q "above the Gmail API upload limit" "$W/last.log"'
check "gmail preflight: no request reached the mock for any of the above" test "$(gm_since | wc -l)" -eq 0

# ---- selftest, single part
gm_mark
gm_job "$BIN/email-archive.sh" --selftest; rc=$?
[[ $rc -eq 0 ]] || tail -20 "$W/last.log"
check "gmail selftest (1 part): exit 0" test "$rc" -eq 0
check "gmail selftest (1 part): one refresh, one accepted send" test "$(gm_count 'token 200 grant=refresh_token')" -eq 1 -a "$(gm_count 'send 200')" -eq 1
check "gmail selftest (1 part): status ok, transport gmail-api, Gmail message id recorded" \
  jq -e '.jobs["email-selftest"] | .last_result=="ok" and .transport=="gmail-api" and (.message_ids|length)==1 and (.message_ids[0]|test("^[0-9a-f]{16}$"))' "$STATUS"
check "gmail selftest: the recorded id is the one the mock returned" grep -q "id=$(gm_status '.jobs["email-selftest"].message_ids[0]')" "$GMD/requests.log"
gm_collect "$GM/st1"
check "gmail selftest: From is the sender account (MAIL_FROM default)" grep -q '^From: POS backups <pos.sender@example.invalid>' "$GM/st1/"*.eml
python3 -I "$BIN/email-unpack.py" --out "$GM/st1-out" "$GM/st1" >/dev/null 2>&1; rc=$?
gpg --batch --output "$GM/st1-out/st.tar" --decrypt "$GM/st1-out/"*.tar.gpg 2>/dev/null; rc2=$?
checkx "gmail selftest (1 part): received mail unpacks + decrypts to the synthetic note" '[[ $rc -eq 0 && $rc2 -eq 0 ]] && tar -xOf "$GM/st1-out/st.tar" ./SELFTEST.txt | grep -q "Synthetic content only"'

# ---- selftest, forced multipart
gm_mark
gm_job "$BIN/email-archive.sh" --selftest --selftest-parts 3; rc=$?
[[ $rc -eq 0 ]] || tail -20 "$W/last.log"
check "gmail selftest --selftest-parts 3: exit 0, 3 mails" test "$rc" -eq 0 -a "$(gm_count 'send 200')" -eq 3
check "gmail selftest --selftest-parts 3: access token cached for the run (1 refresh for 3 sends)" test "$(gm_count 'token 200 grant=refresh_token')" -eq 1
gm_collect "$GM/st3"
python3 -I "$BIN/email-unpack.py" --out "$GM/st3-out" "$GM/st3" >"$GM/st3.log" 2>&1; rc=$?
gpg --batch --output "$GM/st3-out/st.tar" --decrypt "$GM/st3-out/"*.tar.gpg 2>/dev/null; rc2=$?
checkx "gmail selftest (3 parts): unpack verifies 3 parts, decrypts" '[[ $rc -eq 0 && $rc2 -eq 0 ]] && grep -q "part 3/3" "$GM/st3.log"'
checkx "gmail selftest: --selftest-parts without --selftest is refused" '! env "${GMENV[@]}" "$BIN/email-archive.sh" --selftest-parts 2'
checkx "gmail selftest: --selftest-parts out of range is refused" '! env "${GMENV[@]}" "$BIN/email-archive.sh" --selftest --selftest-parts 99'

# ---- real (synthetic-data) archive, single part -> unpack -> decrypt -> restore into a fresh database
gm_mark
gm_job ARCHIVE_PART_BYTES=16777216 "$BIN/email-archive.sh" --week 2026-W45; rc=$?
[[ $rc -eq 0 ]] || tail -20 "$W/last.log"
check "gmail archive (single part): exit 0, 1 part" test "$rc" -eq 0 -a "$(jq -r .part_count "$BK/email-archive/pos-2026-W45/index.json" 2>/dev/null)" == 1
check "gmail archive: state.json records Gmail id + threadId per part" jq -e '.state=="sent" and (.sent["1"].id|test("^[0-9a-f]{16}$")) and (.sent["1"].thread_id|test("^[0-9a-f]{16}$"))' "$BK/email-archive/pos-2026-W45/state.json"
check "gmail archive: status.json email-archive ok via gmail-api" jq -e '.jobs["email-archive"] | .last_result=="ok" and .transport=="gmail-api" and .last_archive_id=="pos-2026-W45"' "$STATUS"
gm_collect "$GM/w45"
TOT45="$(jq -r .total_bytes "$BK/email-archive/pos-2026-W45/index.json" 2>/dev/null || echo 3000000)"
gm_e2e pos-2026-W45 "$GM/w45" "gmail e2e single-part: "

# ---- real archive, exactly 3 parts
PB3=$(( (TOT45 + 2) / 3 + 2048 ))
gm_mark
gm_job ARCHIVE_PART_BYTES="$PB3" "$BIN/email-archive.sh" --week 2026-W46; rc=$?
[[ $rc -eq 0 ]] || tail -20 "$W/last.log"
check "gmail archive (3 parts): exit 0, exactly 3 parts, 3 accepted sends" test "$rc" -eq 0 -a "$(jq -r .part_count "$BK/email-archive/pos-2026-W46/index.json" 2>/dev/null)" == 3 -a "$(gm_count 'send 200')" -eq 3
gm_collect "$GM/w46"
gm_e2e pos-2026-W46 "$GM/w46" "gmail e2e 3-part: "

# ---- access token expires mid-run: 401 -> one refresh -> success
gm_scn "expire-after:1"; gm_mark
gm_job ARCHIVE_PART_BYTES="$PB3" "$BIN/email-archive.sh" --week 2026-W47; rc=$?
checkx "gmail 401 mid-run: exit 0, all 3 parts accepted" '[[ $rc -eq 0 ]] && jq -e ".state==\"sent\" and (.sent|length)==3" "$BK/email-archive/pos-2026-W47/state.json"'
check "gmail 401 mid-run: exactly one 401, then a second refresh" test "$(gm_count 'send 401')" -eq 1 -a "$(gm_count 'token 200 grant=refresh_token')" -eq 2
check "gmail 401 mid-run: log says the token was refreshed once" grep -q 'refreshing it once' "$W/last.log"

# ---- invalid_grant: fail closed, clear reason, no further sends (not even the alert)
gm_scn invalid-grant; gm_mark
LAST_OK="$(gm_status '.jobs["email-archive"].last_success')"
gm_job ARCHIVE_PART_BYTES="$PB3" "$BIN/email-archive.sh" --week 2026-W48; rc=$?
check "gmail invalid_grant: exit != 0" test "$rc" -ne 0
check "gmail invalid_grant: status fail with 'gmail oauth token invalid — owner must re-mint'" jq -e '.jobs["email-archive"] | .last_result=="fail" and (.message|contains("gmail oauth token invalid — owner must re-mint"))' "$STATUS"
checkx "gmail invalid_grant: last_success unchanged, no success line" '[[ "$(gm_status ".jobs[\"email-archive\"].last_success")" == "$LAST_OK" ]] && ! grep -q "archive pos-2026-W48 sent" "$W/last.log"'
check "gmail invalid_grant: one token request, zero send requests (alert not attempted)" test "$(gm_count 'token 400 grant=refresh_token invalid_grant')" -eq 1 -a "$(gm_count '^.* send ')" -eq 0
check "gmail invalid_grant: log says the alert could not be sent" grep -q 'failure notification could not be sent (gmail oauth token invalid' "$W/last.log"
check "gmail invalid_grant: build kept for resume, 0 parts recorded" jq -e '.state=="built" and (.sent|length)==0' "$BK/email-archive/pos-2026-W48/state.json"
env "${GMENV[@]}" "$BIN/email-status.sh" --json >"$GM/es.json" 2>/dev/null
check "gmail invalid_grant: email-status reports the re-mint problem" jq -e '[.problems[]|select(contains("owner must re-mint"))]|length>=1' "$GM/es.json"
env "${GMENV[@]}" "$BIN/backup-status.sh" --no-db >"$GM/bs.txt" 2>/dev/null
check "gmail invalid_grant: backup-status shows it as a problem" grep -q 'email-archive: last run failed.*owner must re-mint' "$GM/bs.txt"

# ---- 403 insufficientPermissions: permanent, no retry
gm_scn insufficient; gm_mark
gm_job "$BIN/email-archive.sh" --selftest; rc=$?
check "gmail 403 insufficientPermissions: exit != 0, status fail" test "$rc" -ne 0 -a "$(gm_status '.jobs["email-selftest"].last_result')" == fail
checkx "gmail 403 insufficientPermissions: not retried (part 1 attempt + alert 1 attempt)" '[[ $(gm_count "send 403 insufficientPermissions") -eq 2 ]] && ! grep -q retrying "$W/last.log"'
check "gmail 403 insufficientPermissions: reason names the missing gmail.send scope" grep -q 'lacks the gmail.send scope' "$W/last.log"

# ---- 429 / 403 userRateLimitExceeded once, then success (back-off)
gm_scn "rate429:1"; gm_mark
gm_job "$BIN/email-archive.sh" --selftest; rc=$?
checkx "gmail 429 then 200: exit 0 after one back-off" '[[ $rc -eq 0 && $(gm_count "send 429") -eq 1 && $(gm_count "send 200") -eq 1 ]] && grep -q "retrying in 1s" "$W/last.log"'
gm_scn "rate403:1"; gm_mark
gm_job "$BIN/email-archive.sh" --selftest; rc=$?
check "gmail 403 userRateLimitExceeded then 200: exit 0 after one back-off" test "$rc" -eq 0 -a "$(gm_count 'send 403 userRateLimitExceeded')" -eq 1 -a "$(gm_count 'send 200')" -eq 1

# ---- persistent 5xx: bounded exponential back-off, then FAIL
gm_scn 5xx; gm_mark
gm_job "$BIN/email-archive.sh" --selftest; rc=$?
check "gmail persistent 503: exit != 0, status fail" test "$rc" -ne 0 -a "$(gm_status '.jobs["email-selftest"].last_result')" == fail
check "gmail persistent 503: exactly MAIL_RETRIES=3 attempts for the part (+3 for the alert)" test "$(gm_count 'send 503')" -eq 6
checkx "gmail persistent 503: exponential back-off 1s then 2s" 'grep -q "retrying in 1s" "$W/last.log" && grep -q "retrying in 2s" "$W/last.log"'
checkx "gmail persistent 503: never reported ok" '! grep -q "sent: 1 part" "$W/last.log"'

# ---- oversize: local guard (nothing handed over) and provider 413 (permanent)
gm_scn ok; gm_mark
gm_job MAIL_MAX_ENCODED_BYTES=200000 "$BIN/email-archive.sh" --selftest --selftest-parts 2 --selftest-mib 1; rc=$?
checkx "gmail local size guard: exit != 0, refused before upload" '[[ $rc -ne 0 ]] && grep -q "over MAIL_MAX_ENCODED_BYTES" "$W/last.log"'
check "gmail local size guard: only the small alert reached the mock" test "$(gm_count 'send 200')" -eq 1 -a "$(gm_since | grep -c 'send ' )" -eq 1
echo 400000 >"$GMD/MAX_BYTES"; gm_mark
gm_job "$BIN/email-archive.sh" --selftest --selftest-parts 2 --selftest-mib 1; rc=$?
rm -f "$GMD/MAX_BYTES"
checkx "gmail provider 413: exit != 0, permanent (no retry)" '[[ $rc -ne 0 && $(gm_count "send 413") -eq 1 ]] && ! grep -q retrying "$W/last.log"'

# ---- connection dropped mid-upload: FAIL, then the next run sends only the missing parts
gm_scn "drop-after:1"; gm_mark
gm_job ARCHIVE_PART_BYTES="$PB3" "$BIN/email-archive.sh" --week 2026-W50; rc=$?
check "gmail drop mid-upload: exit != 0, status fail" test "$rc" -ne 0 -a "$(gm_status '.jobs["email-archive"].last_result')" == fail
checkx "gmail drop mid-upload: curl network error reported, not retried in-run" 'grep -q "gmail api: network error, curl exit" "$W/last.log" && [[ $(gm_count "send DROP") -eq 1 ]]'
check "gmail drop mid-upload: state keeps exactly part 1" jq -e '.state=="built" and (.sent|length)==1 and .sent["1"].id!=null' "$BK/email-archive/pos-2026-W50/state.json"
gm_collect "$GM/w50a"
gm_scn ok; gm_mark
gm_job ARCHIVE_PART_BYTES="$PB3" "$BIN/email-archive.sh" --week 2026-W50; rc=$?
checkx "gmail resume: exit 0, only the 2 missing parts sent" '[[ $rc -eq 0 && $(gm_count "send 200") -eq 2 ]] && grep -q "part 1/3 already accepted earlier" "$W/last.log"'
gm_collect "$GM/w50b"
python3 -I "$BIN/email-unpack.py" --out "$GM/w50-out" "$GM/w50a" "$GM/w50b" >/dev/null 2>&1
check "gmail resume: parts from the failed + resumed runs reassemble and verify" test "$?" -eq 0

# ---- owner token-mint helper against the mock consent + token endpoints
MINT="$SRC/gmail-oauth-mint.py"
MENV=(GMAIL_MINT_AUTH_URL="http://127.0.0.1:$GPORT/auth" GMAIL_TOKEN_URL="http://127.0.0.1:$GPORT/token")
mint_run() {  # OUTFILE [extra env...] — mint with --no-browser; the "browser" is curl following the redirect
  local out="$1"; shift
  rm -f "$GM/mint.err" "$GM/mint.out"
  env "${MENV[@]}" "$@" python3 -I "$MINT" --no-browser --timeout 20 "$CRED/client.json" "$out" >"$GM/mint.out" 2>"$GM/mint.err" & local mp=$!
  local url=""
  for _ in $(seq 1 100); do
    url="$(sed -n 's/^URL: //p' "$GM/mint.err" 2>/dev/null)"
    [[ -n "$url" ]] && break
    kill -0 "$mp" 2>/dev/null || break
    sleep 0.1
  done
  # the "browser": follow the consent redirect back to the helper's loopback listener (URL via stdin config)
  [[ -n "$url" ]] && printf 'url = "%s"\n' "$url" | curl -s -L -o /dev/null --config -
  wait "$mp"
}
gm_scn ok
mint_run "$CRED/mint/gmail-oauth.json"; rc=$?
cp "$GM/mint.out" "$GM/mint-ok.out"; cp "$GM/mint.err" "$GM/mint-ok.err"
check "mint: exit 0 and writes the file" test "$rc" -eq 0 -a -f "$CRED/mint/gmail-oauth.json"
check "mint: file mode 0600" test "$(stat -c %a "$CRED/mint/gmail-oauth.json" 2>/dev/null)" == 600
check "mint: file holds client_id, client_secret, refresh_token, scope=gmail.send, created" jq -e --arg s "$GSCOPE" '(.client_id|length)>0 and (.client_secret|length)>0 and (.refresh_token|startswith("1//")) and .scope==$s and (.created|test("Z$"))' "$CRED/mint/gmail-oauth.json"
check "mint: the auth request asked for gmail.send only, offline, consent, PKCE S256 (mock validated)" grep -q 'auth 302' "$GMD/requests.log"
cp "$CRED/mint/gmail-oauth.json" "$GM/minted-copy.json"   # (never printed; used for the leak patterns below)
env "${MENV[@]}" python3 -I "$MINT" --check "$CRED/mint/gmail-oauth.json" >"$GM/check.out" 2>&1; rc=$?
checkx "mint --check: prints only ok, scope=..., expires_in=..." '[[ $rc -eq 0 ]] && grep -qx "ok, scope=$GSCOPE, expires_in=3599" "$GM/check.out"'
gm_mark
gm_job GMAIL_OAUTH_FILE="$CRED/mint/gmail-oauth.json" "$BIN/email-archive.sh" --selftest; rc=$?
check "mint: the minted file works for a gmail-api selftest" test "$rc" -eq 0 -a "$(gm_count 'send 200')" -eq 1
chmod 0644 "$CRED/mint/gmail-oauth.json"
env "${MENV[@]}" python3 -I "$MINT" --check "$CRED/mint/gmail-oauth.json" >"$GM/check2.out" 2>&1; rc=$?
checkx "mint --check: refuses a 0644 file" '[[ $rc -ne 0 ]] && grep -q "mode 644" "$GM/check2.out"'
chmod 0600 "$CRED/mint/gmail-oauth.json"
gm_scn invalid-grant
env "${MENV[@]}" python3 -I "$MINT" --check "$CRED/mint/gmail-oauth.json" >"$GM/check3.out" 2>&1; rc=$?
checkx "mint --check: invalid_grant -> exit 1, owner must re-mint" '[[ $rc -eq 1 ]] && grep -q "owner must re-mint" "$GM/check3.out"'
gm_scn broad-scope
mint_run "$CRED/mint/broad.json"; rc=$?
check "mint: a granted scope other than exactly gmail.send is refused, nothing written" test "$rc" -ne 0 -a ! -e "$CRED/mint/broad.json"
gm_scn badstate
mint_run "$CRED/mint/state.json"; rc=$?
checkx "mint: state mismatch on the redirect is refused, nothing written" '[[ $rc -ne 0 && ! -e "$CRED/mint/state.json" ]] && grep -q "state mismatch" "$GM/mint.err"'
gm_scn ok
mkdir -p "$GM/home/Desktop" "$GM/home/Library/Mobile Documents/com~apple~CloudDocs"
mint_run "$GM/home/Desktop/gmail-oauth.json" HOME="$GM/home"; rc=$?
check "mint: refuses to write to ~/Desktop" test "$rc" -ne 0 -a ! -e "$GM/home/Desktop/gmail-oauth.json"
mint_run "$GM/home/Library/Mobile Documents/com~apple~CloudDocs/g.json" HOME="$GM/home"; rc=$?
check "mint: refuses to write to iCloud Drive" test "$rc" -ne 0
env GMAIL_TOKEN_URL=http://oauth.example.invalid/token python3 -I "$MINT" --check "$GCRED" >/dev/null 2>&1; rc=$?
check "mint: non-127.0.0.1 endpoint override refused" test "$rc" -ne 0
mint_run "$CRED/mint/gmail-oauth.json"; rc=$?
check "mint: will not overwrite an existing file without --force" test "$rc" -ne 0

ps_stop
kill "$GFP" 2>/dev/null; wait "$GFP" 2>/dev/null

# ---- secrets never leak: argv of every curl, sampled process list, logs, status, state, mails, files
PAT="$GM/.patterns"   # test-side only: the generated secrets + every token the mock issued
( umask 077
  printf '%s\n' "$GCSEC" "$GRTOK" >"$PAT"
  cat "$GMD/issued.txt" >>"$PAT"
  jq -r '.refresh_token' "$GM/minted-copy.json" >>"$PAT" 2>/dev/null )
rm -f "$GM/minted-copy.json"
echo "leak scan: $(sort -u "$PAT" | wc -l) secret values (client secret, $(grep -c '^1//' "$PAT") refresh tokens, $(grep -c '^ya29' "$PAT") issued access tokens)"
# the client id is not a secret (it is part of the consent URL by design), but it still must not show
# up in argv, process lists, logs, status/state or mails
CIDF="$GM/.cid"; ( umask 077; printf '%s\n' "$GCID" >"$CIDF" )
checkx "leak scan: client id not in any curl argv, process list, job log, status/state or sent mail" \
  '! grep -rqF -f "$CIDF" "$GM/curl-argv.log" "$GM/ps.log" "$BK/logs" "$GM/all-runs.log" "$STATUS" "$GMD/sent" && ! find "$BK/email-archive" -name state.json -exec cat {} + | grep -qF -f "$CIDF"'
check "leak scan: curl argv was recorded for every Gmail call ($(wc -l <"$GM/curl-argv.log") calls)" test "$(wc -l <"$GM/curl-argv.log")" -ge 20
checkx "leak scan: no secret in the argv of any curl call" '! grep -qF -f "$PAT" "$GM/curl-argv.log"'
check "leak scan: process list was sampled during the sends ($(wc -l <"$GM/ps.log") lines)" test "$(grep -c 'curl' "$GM/ps.log")" -ge 1
checkx "leak scan: no secret in any sampled process argv (ps -eo args)" '! grep -qF -f "$PAT" "$GM/ps.log"'
checkx "leak scan: no secret in any job log" '! grep -rqF -f "$PAT" "$BK/logs" "$GM/all-runs.log"'
checkx "leak scan: no secret in status.json or any state.json" '! grep -qF -f "$PAT" "$STATUS" && ! find "$BK/email-archive" -name state.json -exec cat {} + | grep -qF -f "$PAT"'
checkx "leak scan: no secret in any message the mock received" '! grep -rqF -f "$PAT" "$GMD/sent"'
checkx "leak scan: no secret in the mint helper output (stdout + stderr)" '! grep -qF -f "$PAT" "$GM/mint-ok.out" "$GM/mint-ok.err" "$GM/check.out"'
checkx "leak scan: no data canary in any Gmail-sent message" '! grep -rqiE "phfcanary|not-a-real-password|BEGIN PGP PRIVATE" "$GMD/sent"'
check "leak scan: the access token was never in a file outside the 0700 token dir (checked at every curl call)" test ! -s "$GM/leak.log"
checkx "leak scan: token dirs seen at curl time ($(grep -c '^dir ' "$GM/tokdir.log")) were all 0700, their files all 0600" \
  'grep -q "^dir 700 " "$GM/tokdir.log" && ! grep -vqE "^(dir 700|file 600) " "$GM/tokdir.log"'
check "leak scan: no token dir left after the runs" test -z "$(find "$BK" /tmp "$W" -xdev -name '.gmail-oauth.*' 2>/dev/null)"
checkx "leak scan: no secret in any file left under backups, /tmp or the work dir" \
  '! grep -rlF --exclude-dir=mockg -f "$PAT" "$BK" /tmp "$W" 2>/dev/null | grep -v "/\.patterns$" | grep -q .'
rm -f "$CIDF"
docker rm -f "$GM_RESTORE" >/dev/null 2>&1
}

gm_main >"$W/gm-section.out" 2>&1
cat "$W/gm-section.out"
checkx "leak scan: no secret in this section test output" '! grep -qF -f "$GM/.patterns" "$W/gm-section.out"'
rm -f "$GM/.patterns"
