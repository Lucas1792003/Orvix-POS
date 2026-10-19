#!/usr/bin/env bash
# 086 compatibility with 087 installed: 086's own live SQL suite (src/live/m086-sql.live.test.ts: executor, races, lump sum,
# fences, tenant isolation, as the 086 verification runs it) against the disposable stack with 087 INSTALLED and OPEN. The suite
# drives the legacy direct path and the 4-argument executor, which 087 closes at install, so the run sets the owner's
# legacy_paths switch to 'open' for its duration (an owner SQL decision, D7) and closes it again afterwards.
#   tools/m087-verify/compat.sh RESULTS_DIR
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
RES=$(cd "$1" && pwd); OUT="$RES/compat"; rm -rf "$OUT"; mkdir -p "$OUT/auth" "$OUT/mirror"; DB=phf-iso-db
TOOLS="$ROOT/tools/recovery-authority"; OPENSSL=${OPENSSL:-/opt/homebrew/opt/openssl@3/bin/openssl}
SWORK=$(cat "$RES/stack/swork.path"); set -a; . "$SWORK/secrets.env"; set +a
q() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
$OPENSSL genpkey -algorithm ed25519 -out "$OUT/auth/authority.key" 2>/dev/null; chmod 600 "$OUT/auth/authority.key"; $OPENSSL pkey -in "$OUT/auth/authority.key" -pubout -out "$OUT/auth/authority.pub"
q "select recovery.owner_rebaseline('compat: new series', 'alice', 'bob')" >/dev/null
q "select recovery.owner_anchor('compat', 'alice', 'bob')" >/dev/null 2>&1
AUTH_PGHOST=127.0.0.1 python3 -I "$TOOLS/authority.py" genesis "$OUT/auth" "$OUT/mirror" $DB 3600 > "$OUT/genesis.log" 2>&1
q "select recovery.owner_open('alice', 'bob')" >/dev/null
q "update recovery.settings set legacy_paths = 'open'" >/dev/null
echo "087: $(q "select state || ' lease=' || recovery.lease_ok()::text || ' legacy=' || (select legacy_paths from recovery.settings) from recovery.continuity")"
( cd "$ROOT" && export E2E_SUPABASE_URL="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY" \
    B2B_JWT_SECRET="$PHF_ISO_JWT_SECRET" E2E_DB_CONTAINER=$DB E2E_LOOPBACK_ONLY=1 M086_LIVE=1 B2B_P3=1 \
    M086_MIGRATION="$ROOT/supabase/migrations/086_operation_outcomes.sql" M086_ROLLBACK="$ROOT/supabase/rollbacks/086_operation_outcomes.rollback.sql" \
    P086_STATE="$OUT/state.json" P086_EVIDENCE="$OUT/m086-sql.json" \
  && npx vitest run src/live/m086-sql.live.test.ts 2>&1 | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g' ) > "$OUT/m086-sql.log"
q "update recovery.settings set legacy_paths = 'closed'" >/dev/null
echo "m086-sql with 087 installed: $(grep -E '^ +Tests ' "$OUT/m086-sql.log" || echo 'no summary')"
echo "ledger = chain after the suite: $(q "select ((select count(*) from recovery.chain_log) = (select count(*) from idempotency_keys where org_id <> '!unattributed'))::text")"
echo "authority after the suite: $(AUTH_PGHOST=127.0.0.1 python3 -I "$TOOLS/authority.py" tick "$OUT/auth" "$OUT/mirror" $DB 3600 2>&1 | tail -1)"
# Known, by design: FS.10's own cleanup (src/live/m086-sql.live.test.ts:305) DELETEs a ledger row directly, which 087 forbids
# (LEDGER_EVIDENCE_PROTECTED, M3) after all of FS.10's behavioural assertions have passed. Any OTHER failure fails this part.
if grep -qE '^ +Tests .*failed' "$OUT/m086-sql.log"; then
  FAILS=$(grep -cE '^ +× ' "$OUT/m086-sql.log")
  if [ "$FAILS" = 1 ] && grep -qE '× FS\.10 ' "$OUT/m086-sql.log" && grep -q 'm086-sql.live.test.ts:305:' "$OUT/m086-sql.log" && grep -q 'LEDGER_EVIDENCE_PROTECTED' "$OUT/m086-sql.log"; then
    echo "m086-sql: the only failure is FS.10's cleanup DELETE of a ledger row, refused by 087 (M3) after its assertions passed: compatible by design"
    exit 0
  fi
  exit 1
fi
grep -qE '^ +Tests +[0-9]+ passed' "$OUT/m086-sql.log"
