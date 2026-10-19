#!/usr/bin/env bash
# runbook-check-selftest.sh — runbook-check.sh must FAIL on runbooks that violate the restore order.
# Each case copies the three documents into a temp tree, applies one violation (the counterexamples of
# the snapshot-24 review among them) and expects runbook-check.sh to exit 1. The unmodified copy must pass.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../../.." && pwd)"
CHECK="$HERE/runbook-check.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/phf-rbself.XXXXXX"); trap 'rm -rf "$T"' EXIT
RB=deploy/lucashome/backup/README.md; EM=docs/selfhost-migration/phase-f/restore-from-email.md; DR=docs/selfhost-migration/phase-g/disaster-recovery.md
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
fresh() { rm -rf "$T/r"; for f in $RB $EM $DR; do mkdir -p "$T/r/$(dirname "$f")"; cp "$REPO/$f" "$T/r/$f"; done; }
# mutate FILE MODE ANCHOR TEXT — insert TEXT after (MODE=after) the first line containing ANCHOR, or
# replace (MODE=replace) that line with TEXT, or delete it (MODE=delete)
mutate() {
  python3 -I - "$T/r/$1" "$2" "$3" "${4:-}" <<'EOF'
import sys
p, mode, anchor, text = sys.argv[1:5]
lines = open(p).read().split('\n')
i = next((k for k, l in enumerate(lines) if anchor in l), None)
if i is None: sys.exit("anchor not found: " + anchor)
if mode == 'after': lines.insert(i + 1, text)
elif mode == 'replace': lines[i] = text
elif mode == 'delete': del lines[i]
open(p, 'w').write('\n'.join(lines))
EOF
}
expect_fail() {  # LABEL
  # caught = exit 1 with a real FAIL verdict and a summary line (a crash is not a detection)
  bash "$CHECK" "$T/r" >"$T/out" 2>&1; local rc=$?
  if [ $rc -eq 1 ] && grep -q '^FAIL' "$T/out" && grep -qE '^runbook check: [0-9]+ passed, [1-9][0-9]* failed' "$T/out"; then ok "caught: $1 ($(grep -m1 '^FAIL' "$T/out" | cut -c7-90))"
  else bad "not caught: $1 (rc $rc)"; tail -2 "$T/out" | sed 's/^/      /'; fi
}

fresh
bash "$CHECK" "$T/r" >"$T/out" 2>&1 && ok "the unmodified runbooks pass" || { bad "unmodified runbooks fail"; grep '^FAIL' "$T/out"; }

fresh; mutate $EM after '### 3.4 ' 'Sign in on one till and let the tills sync before the gate runs.'
expect_fail "email: a till signs in and syncs 'before the gate' (ce2)"
fresh; mutate $RB after '### A. Logical restore' 'Let the till sign in and sync until its queue is empty.'
expect_fail "README §A: a till signs in and syncs 'until …' (ce9)"
fresh; mutate $RB after '   docker compose stop db' '   docker compose restart db && docker compose start'
expect_fail "README §B: compose restart/start (ce3)"
fresh; mutate $RB after '5. Post-restore fix-ups' '   `docker compose start` then `sudo tailscale serve 8000`; tills may now reconnect.'
expect_fail "README §A: compose start + tailscale serve without --bg (ce4b)"
fresh; mutate $RB after 'Steps:' '0. Every till signs in and syncs now.'
expect_fail "README §R: tills sign in before the exposure step (ce5)"
fresh; mutate $DR replace '4. The gate.' '4. Reopening by hand (README §R), then the gate.'; mutate $DR delete '8. Reopening by hand'
expect_fail "disaster-recovery.md §5.4: reopening before the gate (ce7)"
fresh; mutate $RB replace '10. Separate owner authorization, then §R.' '10. Then §R.'
expect_fail "README §A: owner authorization removed (must not be found in a later section, ce1)"
fresh; mutate $EM after '1. **Results reviewed (owner).**' '   One till signs in and syncs.'
expect_fail "email: the old 'One till signs in and syncs'"
fresh; mutate $EM after '### 3.5 ' 'docker compose up -d && docker compose ps'
expect_fail "email: plain docker compose up before reopening"
fresh; mutate $RB after '6. Still closed:' '   sudo tailscale serve --bg --https=443 http://127.0.0.1:8000'
expect_fail "README §A: tailscale serve --bg before the gate"
fresh; mutate $RB replace '### 0. Before any restore' '### 0. Before any restore (removed)'; mutate $RB delete 'restore-api-guard.sh close'
expect_fail "README: §0 closure removed"
fresh; mutate $EM delete 'restore-api-guard.sh close'
expect_fail "email: closure removed"
fresh; sed -i.bak 's/Restore validation alone never authorizes reopening the API/Restore validation authorizes reopening the API/g' "$T/r/$DR"
expect_fail "disaster-recovery.md: the statement weakened"

fresh; mutate $RB replace '3. **Disconnect every till from the network now**' '3. The tills keep selling offline.'
expect_fail "README §0: the till disconnection removed (review-25 LOW)"
fresh; sed -i.bak 's/disconnected from the network/offline/g' "$T/r/$EM"
expect_fail "email §3.3: the till disconnection removed"
fresh; sed -i.bak 's/one at a time/all together/g' "$T/r/$RB"
expect_fail "README §R: tills reconnected all together"
fresh; sed -i.bak 's/one at a time/all together/g' "$T/r/$EM"
expect_fail "email §4: tills reconnected all together"

echo; echo "runbook-check selftest: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
