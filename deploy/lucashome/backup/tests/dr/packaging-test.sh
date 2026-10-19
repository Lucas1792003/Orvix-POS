#!/usr/bin/env bash
# packaging-test.sh — deploy.sh's package, built LOCALLY (--package-to) and never sent anywhere: a fake
# `ssh` on PATH records any call and fails, and LUCASHOME points at an .invalid host.
#   - every file the restore gate opens next to itself (and dr-restore-fixups.sql) is in the package,
#     under the name the gate expects; the gate's preflight passes from the package
#   - the migration source the gate needs is packaged and checksummed
#   - a missing or empty required file, or an unlisted file, stops the deploy BEFORE any ssh/rsync
#   - compatibility: every file the previous filter delivered is still delivered
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BK="$(cd "$HERE/../.." && pwd)"; REPO="$(cd "$BK/../../.." && pwd)"
T=$(mktemp -d "${TMPDIR:-/tmp}/phf-pkg.XXXXXX"); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat >"$T/bin/ssh" <<EOF
#!/usr/bin/env bash
echo "ssh \$*" >>"$T/ssh.log"; exit 1
EOF
chmod 0755 "$T/bin/ssh"; : >"$T/ssh.log"
export PATH="$T/bin:$PATH" LUCASHOME=phf-packaging-test.invalid
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }

echo "== BEFORE: the previous deploy.sh filter (HEAD) against the gate's needs"
OLD="$T/old"; mkdir -p "$OLD"
rsync -a --delete --exclude deploy.sh --exclude mac-pull.sh --exclude owner-key-setup.sh --exclude tests/ --include '*.sh' --include 'email-*.py' --include 'gmail-oauth-mint.py' --include 'email-*.sql' --include 'sweep-abandoned-uploads.sql' --include 'sweep-protected-objects.sha256' --exclude '*' "$BK/" "$OLD/"
miss=""; for f in $(grep -oE 'dr-[a-z-]+\.sql' "$BK/dr-verify-restore.sh" | sort -u); do [ -f "$OLD/$f" ] || miss="$miss $f"; done
[ -n "$miss" ] && ok "REPRODUCED: the previous filter leaves out the gate's SQL:$miss" || bad "previous filter unexpectedly complete"

echo "== AFTER: deploy.sh --package-to (local only)"
PKG="$T/pkg"
"$BK/deploy.sh" --package-to "$PKG" >"$T/pkg.log" 2>&1; rc=$?
[ $rc -eq 0 ] && ok "package built (rc 0): $(grep 'package verified' "$T/pkg.log")" || { bad "package build rc $rc"; cat "$T/pkg.log"; }
need=$(sed -nE 's/^REQUIRED_SQL="([^"]*)"/\1/p' "$BK/dr-verify-restore.sh")
[ -n "$need" ] && ok "gate declares its required SQL: $need" || bad "gate REQUIRED_SQL not found"
for f in $need; do cmp -s "$BK/$f" "$PKG/bin/$f" && ok "package has $f (same bytes, the name the gate opens)" || bad "package lacks $f"; done
# every file the gate opens via \$HERE must be packaged (catches a new check file not added to REQUIRED_SQL)
for f in $(grep -oE '\$HERE/[A-Za-z0-9_.-]+' "$BK/dr-verify-restore.sh" | sed 's#\$HERE/##' | sort -u); do
  [ -f "$PKG/bin/$f" ] && ok "gate opens \$HERE/$f: packaged" || bad "gate opens \$HERE/$f: NOT packaged"
done
for f in $(grep -vE '^[[:space:]]*(#|$)' "$BK/deploy-manifest.txt"); do [ -s "$PKG/bin/$f" ] || bad "manifest entry $f not packaged"; done
ok "every deploy-manifest.txt entry packaged ($(grep -vcE '^[[:space:]]*(#|$)' "$BK/deploy-manifest.txt") files)"
for f in $(cd "$OLD" && ls); do [ -f "$PKG/bin/$f" ] || bad "compatibility: $f was deployed before and is not now"; done
ok "compatibility: all $(ls "$OLD" | wc -l | tr -d ' ') files of the previous filter still delivered"
[ ! -e "$PKG/bin/deploy-manifest.txt" ] && [ ! -e "$PKG/bin/tests" ] && [ ! -e "$PKG/bin/mac-pull.sh" ] && [ ! -e "$PKG/bin/owner-key-setup.sh" ] && ! ls "$PKG/bin" | grep -qE '\.example$|\.env' \
  && ok "nothing extra: no tests/, mac-pull.sh, owner-key-setup.sh, templates or env files" || bad "package carries files it must not"
(cd "$PKG/bin" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1) && ok "bin/MANIFEST.sha256 verifies" || bad "MANIFEST.sha256"
(cd "$PKG/migrations" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1) && ok "migrations/SHA256SUMS verifies" || bad "migrations SHA256SUMS"
n_repo=$(ls "$REPO/supabase/migrations" | grep -cE '^[0-9]{3}_.*\.sql$'); n_pkg=$(ls "$PKG/migrations" | grep -cE '^[0-9]{3}_.*\.sql$')
[ "$n_repo" = "$n_pkg" ] && ok "migration source packaged: $n_pkg files (= repo)" || bad "migrations: repo $n_repo, package $n_pkg"
top=$(ls "$PKG/migrations" | grep -E '^[0-9]{3}_' | sort | tail -1 | cut -c1-3)
"$PKG/bin/dr-verify-restore.sh" preflight --migrations "$PKG/migrations" --expect-version "$top" >"$T/pre.log" 2>&1 \
  && ok "gate preflight from the package (its own migrations, $top): rc 0" || { bad "preflight from the package"; cat "$T/pre.log"; }
"$BK/deploy.sh" --package-to "$PKG" >"$T/again.log" 2>&1 && bad "packaging into a non-empty directory allowed" || ok "refuses to package into a non-empty directory"

echo "== missing, empty or unlisted files stop the deploy before anything is sent"
mkrepo() {  # a throwaway copy of the repo parts deploy.sh reads
  rm -rf "$T/r"; mkdir -p "$T/r/deploy/lucashome" "$T/r/supabase"
  cp -a "$BK" "$T/r/deploy/lucashome/backup"; rm -rf "$T/r/deploy/lucashome/backup/tests/dr/results"
  cp -a "$REPO/supabase/migrations" "$T/r/supabase/migrations"
}
for f in dr-financial-checks.sql dr-restore-fixups.sql dr-drill-fingerprint.sql dr-schema-fingerprint.sql dr-drill-consistency.sql dr-verify-restore.sh restore-api-guard.sh; do
  mkrepo; rm -f "$T/r/deploy/lucashome/backup/$f"; : >"$T/ssh.log"
  "$T/r/deploy/lucashome/backup/deploy.sh" >"$T/d.log" 2>&1; rc=$?
  if [ $rc -ne 0 ] && grep -q "DEPLOY REFUSED: required component $f" "$T/d.log" && [ ! -s "$T/ssh.log" ]; then ok "deploy without $f: refused before any ssh (rc $rc)"
  else bad "deploy without $f: rc $rc, ssh calls $(wc -l <"$T/ssh.log" | tr -d ' ')"; tail -2 "$T/d.log"; fi
  "$T/r/deploy/lucashome/backup/deploy.sh" --package-to "$T/p2-$f" >"$T/d.log" 2>&1 && bad "--package-to without $f succeeded" || ok "--package-to without $f: refused"
done
mkrepo; : >"$T/r/deploy/lucashome/backup/dr-financial-checks.sql"; : >"$T/ssh.log"
"$T/r/deploy/lucashome/backup/deploy.sh" >"$T/d.log" 2>&1; rc=$?
[ $rc -ne 0 ] && grep -q 'missing or empty' "$T/d.log" && [ ! -s "$T/ssh.log" ] && ok "empty dr-financial-checks.sql: refused before any ssh" || bad "empty SQL: rc $rc"
mkrepo; echo 'select 1;' >"$T/r/deploy/lucashome/backup/dr-new-check.sql"; : >"$T/ssh.log"
"$T/r/deploy/lucashome/backup/deploy.sh" >"$T/d.log" 2>&1; rc=$?
[ $rc -ne 0 ] && grep -q 'not in deploy-manifest.txt' "$T/d.log" && [ ! -s "$T/ssh.log" ] && ok "an unlisted dr-*.sql: refused until it is in the manifest" || bad "unlisted file: rc $rc"
mkrepo; rm -f "$T/r/supabase/migrations/"*.sql; : >"$T/ssh.log"
"$T/r/deploy/lucashome/backup/deploy.sh" >"$T/d.log" 2>&1; rc=$?
[ $rc -ne 0 ] && grep -q 'no migrations' "$T/d.log" && [ ! -s "$T/ssh.log" ] && ok "no migration source: refused before any ssh" || bad "no migrations: rc $rc"
: >"$T/ssh.log"
"$BK/deploy.sh" --package-to "" >"$T/d.log" 2>&1; rc=$?
[ $rc -ne 0 ] && [ ! -s "$T/ssh.log" ] && ok "--package-to with an EMPTY value: refused, never falls through to a real deploy" || bad "empty --package-to: rc $rc, ssh calls $(wc -l <"$T/ssh.log" | tr -d ' ')"
"$BK/deploy.sh" --package-to >"$T/d.log" 2>&1; rc=$?
[ $rc -ne 0 ] && [ ! -s "$T/ssh.log" ] && ok "--package-to without a value: refused before any ssh" || bad "--package-to without value: rc $rc"
mkrepo; ( cd "$T/r" && git init -q && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm t ) >/dev/null 2>&1
f=$(ls "$T/r/supabase/migrations" | grep -E '^085_' | head -1); echo '-- edited' >>"$T/r/supabase/migrations/$f"; : >"$T/ssh.log"
"$T/r/deploy/lucashome/backup/deploy.sh" >"$T/d.log" 2>&1; rc=$?
[ $rc -ne 0 ] && grep -q 'uncommitted changes' "$T/d.log" && [ ! -s "$T/ssh.log" ] && ok "an uncommitted edit to a migration: refused before any ssh" || { bad "uncommitted migration: rc $rc"; tail -2 "$T/d.log"; }
( cd "$T/r" && git checkout -q -- supabase/migrations )
"$T/r/deploy/lucashome/backup/deploy.sh" --package-to "$T/p-clean" >"$T/d.log" 2>&1 && ok "the same repo with committed migrations packages (rc 0)" || { bad "clean git repo package"; tail -2 "$T/d.log"; }
[ ! -s "$T/ssh.log" ] && ok "no ssh call was attempted by any refused run" || bad "ssh was called"

echo; echo "packaging: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
