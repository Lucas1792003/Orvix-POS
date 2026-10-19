#!/usr/bin/env bash
# gate-unit-test.sh — dr-verify-restore.sh decisions without a database (seconds, no Docker):
# a fake `docker` (fake-docker.sh) answers the gate's queries from fixtures. Covers the count
# tolerance (validated; strict for business/ledger/migration tables), failed queries never passing,
# empty invariant output, help/usage exit codes, missing SQL failing before any database access
# (preflight + restore), and that a passing gate never touches the API (it only reads).
#   tests/dr/gate-unit-test.sh [GATE_DIR]   default: the repo's deploy/lucashome/backup
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GD="$(cd "${1:-$HERE/../..}" && pwd)"
GATE="$GD/dr-verify-restore.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/phf-gate-unit.XXXXXX"); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/st" "$T/mig"
cp "$HERE/fake-docker.sh" "$T/bin/docker"; chmod 0755 "$T/bin/docker"
for v in 001 002 003; do printf -- '-- %s\n' "$v" >"$T/mig/${v}_m.sql"; done
export PATH="$T/bin:$PATH" FAKE_STATE="$T/st"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }

fixtures() {  # the source as recorded in counts.json, and an identical restored database
  cat >"$T/counts.json" <<'EOF'
{"captured_at":"2026-10-18T00:00:00Z","db_size_bytes":1,"auth_users":2,"storage_objects":0,"storage_buckets":1,
 "sales":5,"products":3,"organizations":2,"app_users":4,"auth_identities":2,"migrations":3,"schema_version":"003",
 "rows":{"public.sales":5,"public.supplier_payments":2,"public.idempotency_keys":7,"public.audit_logs":9,
         "supabase_migrations.schema_migrations":3,"auth.users":2,"auth.sessions":4,"auth.refresh_tokens":6,"auth.audit_log_entries":11}}
EOF
  jq -c 'del(.captured_at, .db_size_bytes, .rows)' "$T/counts.json" >"$T/st/got.json"
  jq -c '.rows' "$T/counts.json" >"$T/st/rows.json"
  printf '001\n002\n003\n' >"$T/st/versions"; echo 003 >"$T/st/top"; : >"$T/st/sums"; : >"$T/st/calls.log"
  unset FAKE_FAIL FAKE_EMPTY_INVARIANTS FAKE_VIOLATE
}
setrow() { jq -c --arg t "$1" --argjson n "$2" '.[$t] = $n' "$T/st/rows.json" >"$T/st/r" && mv "$T/st/r" "$T/st/rows.json"; }
setkey() { jq -c --arg t "$1" --argjson n "$2" '.[$t] = $n' "$T/st/got.json" >"$T/st/g" && mv "$T/st/g" "$T/st/got.json"; }
gate() { "$GATE" restore --container fake --expect-version 003 --migrations "$T/mig" --accept-no-reference --counts "$T/counts.json" "$@" >"$T/out" 2>&1; echo $?; }
expect() {  # LABEL WANT_RC [RESULT-regex] -- GATE ARGS
  local label=$1 want=$2 re=$3; shift 4
  local rc; rc=$(gate "$@")
  if [ "$rc" = "$want" ] && { [ -z "$re" ] || grep -qE "$re" "$T/out"; }; then ok "$label (rc $rc)"
  else bad "$label: want rc $want${re:+ + /$re/}, got rc $rc"; grep -E '^(FAIL|RESULT|unknown|--count|usage)' "$T/out" | head -4 | sed 's/^/      /'; fi
}

echo "== gate under test: $GATE"
fixtures
expect "identical counts, no reference: ACCEPTED-WITHOUT-REFERENCE (exit 3), never HEALTHY" 3 '^RESULT: ACCEPTED' --
setrow public.sales 4
expect "a sale missing (per-table rows, default tolerance): FAILED" 1 '^RESULT: FAILED' --

echo "== count tolerance: validated, never silently disabling a check"
for v in abc -1 '' 1.5 1e3 ' 1' '0x1' '5abc'; do
  fixtures; setrow public.sales 4
  expect "--count-tolerance '$v' with a sale missing: refused as a usage error (exit 2)" 2 '' -- --count-tolerance "$v"
done
fixtures; setrow public.sales 4
rc=$(gate --count-tolerance); [ "$rc" = 2 ] && ok "--count-tolerance without a value: usage error (rc 2)" || bad "--count-tolerance without a value: rc $rc"

echo "== strict equality for business, financial, ledger and migration tables (tolerance never applies)"
for t in public.sales public.supplier_payments public.idempotency_keys public.audit_logs supabase_migrations.schema_migrations auth.users; do
  fixtures; e=$(jq -r --arg t "$t" '.[$t]' "$T/st/rows.json"); setrow "$t" $((e - 1))
  expect "$t off by one with --count-tolerance 5: FAILED" 1 "^FAIL .*$t" -- --count-tolerance 5
done
for k in sales auth_users products organizations app_users storage_objects migrations; do
  fixtures; e=$(jq -r --arg k "$k" '.[$k]' "$T/st/got.json"); setkey "$k" $((e + 1))
  expect "summary key $k off by one with --count-tolerance 5: FAILED" 1 "^FAIL .*$k" -- --count-tolerance 5
done

fixtures; setrow public.extra_table 0
expect "a table in the restore that counts.json never listed: FAILED (counts compared both ways)" 1 '^FAIL .*public.extra_table\(not-in-counts' --
fixtures; jq -c '.rows["auth.sessions"] = "004"' "$T/counts.json" >"$T/c" && mv "$T/c" "$T/counts.json"; setrow auth.sessions 4
expect "a count with a leading zero ('004'): FAILED, never read as octal" 1 '^FAIL .*auth.sessions' -- --count-tolerance 5
fixtures; jq -c '.rows["auth.sessions"] = "18446744073709551620"' "$T/counts.json" >"$T/c" && mv "$T/c" "$T/counts.json"
expect "an overlong count (64-bit wrap): FAILED, never tolerated" 1 '^FAIL .*auth.sessions' -- --count-tolerance 5
fixtures; jq -c '.rows["auth.sessions"] = null' "$T/counts.json" >"$T/c" && mv "$T/c" "$T/counts.json"
expect "a null count: FAILED" 1 '^FAIL .*auth.sessions' -- --count-tolerance 5

echo "== the documented exception: GoTrue session churn only (auth.sessions, refresh_tokens, audit_log_entries, …)"
fixtures; setrow auth.sessions 7
expect "auth.sessions +3 within --count-tolerance 5: ACCEPTED, reported as tolerated" 3 '^PASS .*tolerated within 5: auth.sessions\(4->7\)' -- --count-tolerance 5
fixtures; setrow auth.refresh_tokens 0
expect "auth.refresh_tokens -6 beyond --count-tolerance 5: FAILED" 1 '^FAIL .*auth.refresh_tokens' -- --count-tolerance 5
fixtures; setrow auth.sessions 5
expect "auth.sessions +1 with the default tolerance 0: FAILED" 1 '^FAIL .*auth.sessions' --

echo "== a count check never passes because its query failed"
fixtures; FAKE_FAIL=counts expect "summary counts query fails: FAILED" 1 '^FAIL .*counts query failed' --
fixtures; FAKE_FAIL=rows expect "per-table rows query fails: FAILED" 1 '^FAIL .*(rows query failed|counts differ)' --
fixtures; echo '{}' >"$T/st/rows.json"
expect "per-table rows query returns nothing: FAILED" 1 '^FAIL' --
fixtures; FAKE_FAIL=sums expect "migration checksum query fails: FAILED (was: '0 recorded' PASS)" 1 '^FAIL .*checksum' --
fixtures; FAKE_FAIL=versions expect "migration ledger query fails: FAILED" 1 '^FAIL .*migration ledger' --
fixtures; FAKE_FAIL=all expect "database unreachable: FAILED" 1 '^FAIL .*not reachable' --
fixtures; FAKE_EMPTY_INVARIANTS=1 expect "invariant files return no rows: FAILED (was: '0 checks' PASS)" 1 '^FAIL .*(fewer|no) (invariant )?checks' --
fixtures; FAKE_VIOLATE='po paid_mmk differs' expect "a financial invariant violated: FAILED" 1 '^FAIL .*dr-financial-checks.sql' --
fixtures; jq -c 'del(.rows)' "$T/counts.json" >"$T/c" && mv "$T/c" "$T/counts.json"
expect "counts.json without per-table rows (backups before 2026-10-18): not accepted" 1 '^RESULT: FAILED' --

echo "== COUNTS-ONLY: marked only when the counts comparison is the sole failure (still exit 1)"
co() {  # LABEL WANT(yes|no) -- GATE ARGS
  local label=$1 want=$2 rc; shift 3; rc=$(gate "$@")
  local got=no; grep -q '^NOTE  COUNTS-ONLY' "$T/out" && got=yes
  if [ "$rc" = 1 ] && [ "$got" = "$want" ]; then ok "$label (rc 1, COUNTS-ONLY $want)"; else bad "$label: rc $rc, want COUNTS-ONLY $want"; grep -E '^(FAIL|NOTE)' "$T/out" | head -4 | sed 's/^/      /'; fi
}
fixtures; setrow public.sales 4;                              co "only a sale count differs" yes --
fixtures; jq -c 'del(.rows)' "$T/counts.json" >"$T/c" && mv "$T/c" "$T/counts.json"; co "backup without per-table counts, all else passes" yes --
fixtures; setrow public.sales 4; FAKE_VIOLATE='po paid_mmk differs' co "a count differs AND a financial invariant fails" no --
fixtures; setrow public.sales 4; echo 002 >"$T/st/top";       co "a count differs AND the schema version is wrong" no --
fixtures; FAKE_FAIL=rows                                       co "the per-table rows query fails" no --
fixtures; FAKE_FAIL=counts                                     co "the summary counts query fails" no --
fixtures; FAKE_FAIL=sums                                       co "the checksum query fails" no --
fixtures; FAKE_FAIL=all                                        co "the database is unreachable" no --
fixtures; setrow public.sales 0;                              co "a table emptied (sales 5 -> 0): lost data" no --
fixtures; setrow public.sales 0; grep -q '^NOTE  emptied.*public.sales' "$T/out" && ok "the emptied table is named" || bad "emptied table not named"
fixtures; echo '{}' >"$T/st/got.json";                        co "the summary counts query returns an empty object" no --
fixtures; echo 'garbage' >"$T/st/got.json";                   co "the summary counts query returns non-JSON" no --
fixtures; setrow public.sales 4
"$GATE" restore --container fake --expect-version 003 --migrations "$T/mig" --counts "$T/counts.json" >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && ! grep -q 'COUNTS-ONLY' "$T/out" && ok "no reference and no --accept-no-reference (INCONCLUSIVE) + a count difference: never COUNTS-ONLY" || bad "inconclusive + count diff: rc $rc, $(grep -c COUNTS-ONLY "$T/out") COUNTS-ONLY"

echo "== usage and help never look like success"
"$GATE" -h >/dev/null 2>&1; rc=$?; [ "$rc" = 2 ] && ok "-h exits 2, never 0 (a '&&' chain cannot continue)" || bad "-h exits $rc"
"$GATE" restore --container fake --expect-version 003 --migrations "$T/mig" -h >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "-h after other arguments exits 2" || bad "-h after arguments exits $rc"
"$GATE" >/dev/null 2>&1; rc=$?; [ "$rc" = 2 ] && ok "no mode: exit 2" || bad "no mode: exit $rc"

echo "== missing restore SQL fails before any database access"
for f in dr-financial-checks.sql dr-drill-consistency.sql dr-drill-fingerprint.sql dr-schema-fingerprint.sql dr-restore-fixups.sql; do
  P="$T/pkg"; rm -rf "$P"; mkdir -p "$P"; cp "$GD"/dr-*.sh "$GD"/dr-*.sql "$P/"; rm -f "$P/$f"
  fixtures
  "$P/dr-verify-restore.sh" preflight --migrations "$T/mig" --expect-version 003 >"$T/out" 2>&1; rc=$?
  [ "$rc" = 1 ] && grep -qF "$f" "$T/out" && ok "preflight without $f: exit 1, names it" || bad "preflight without $f: rc $rc"
  "$P/dr-verify-restore.sh" restore --container fake --expect-version 003 --migrations "$T/mig" --accept-no-reference --counts "$T/counts.json" >"$T/out" 2>&1; rc=$?
  if [ "$rc" = 1 ] && grep -q '^RESULT: FAILED' "$T/out" && [ ! -s "$T/st/calls.log" ]; then ok "restore without $f: FAILED with no database query"
  else bad "restore without $f: rc $rc, $(wc -l <"$T/st/calls.log" | tr -d ' ') database call(s)"; fi
done
fixtures
"$GATE" preflight --migrations "$T/mig" --expect-version 003 >"$T/out" 2>&1; rc=$?
[ "$rc" = 0 ] && ok "preflight with the full package: exit 0" || { bad "preflight full package: rc $rc"; head -5 "$T/out"; }
# a realistic migration source (90 files) with the expected version NOT the newest: `list | grep -q`
# under pipefail died of SIGPIPE and reported the version absent (found by the 085 drill, snapshot 24)
mkdir -p "$T/mig90"; for i in $(seq 1 90); do printf -- '--\n' >"$T/mig90/$(printf '%03d' "$i")_m.sql"; done
for v in 001 045 085 090; do
  "$GATE" preflight --migrations "$T/mig90" --expect-version "$v" >"$T/out" 2>&1; rc=$?
  [ "$rc" = 0 ] && ok "preflight with 90 migrations, expecting $v (not necessarily the newest): exit 0" || { bad "preflight 90 migrations, $v: rc $rc"; grep FAIL "$T/out"; }
done
"$GATE" preflight --migrations "$T/nope" --expect-version 003 >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && ok "preflight with no migration source: exit 1" || bad "preflight with no migration source: rc $rc"
"$GATE" preflight --migrations "$T/mig" --expect-version 004 >"$T/out" 2>&1; rc=$?
[ "$rc" = 1 ] && ok "preflight with a migration source older than the expected version: exit 1" || bad "preflight old migration source: rc $rc"

echo "== a passing gate reads only: it never starts, stops or exposes anything"
fixtures; rc=$(gate)
if [ "$rc" = 3 ] && ! grep -vE '^exec -i fake psql ' "$T/st/calls.log" | grep -q .; then ok "every docker call of a passing gate is 'exec -i <db> psql' (no compose up/start/run)"
else bad "a passing gate made a non-psql docker call (rc $rc)"; grep -vE '^exec -i fake psql ' "$T/st/calls.log" | head -3; fi
if grep -nE 'compose[^|]*\b(up|start|restart|run)\b|tailscale|docker (start|run -d)|\bfunnel\b' "$GATE" | grep -v '^[0-9]*:#' | grep -q .; then
  bad "the gate script contains a start/expose command"; grep -nE 'compose[^|]*\b(up|start|restart|run)\b|tailscale|docker (start|run -d)' "$GATE" | head -3
else ok "the gate script contains no compose up/start/restart, docker start, or tailscale command"; fi

echo; echo "gate unit: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
