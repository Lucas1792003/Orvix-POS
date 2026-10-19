#!/usr/bin/env bash
# Install migration 087 on the DISPOSABLE loopback stack (container phf-iso-db) for the v87 client e2e, AFTER the e2e
# global setup seeded the QA tenant: through the real runner (one transaction + ledger row), then the owner anchor,
# a witness-authority genesis (the repo's tools/recovery-authority, its own key and series under OUT) and the two-person
# open. Test helper (never part of 087): tools/m087-verify/sql/test-helpers.sql (zz_test_release_org = the 088 stand-in).
#   install-087.sh OUT_DIR
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); DB=phf-iso-db; OUT=$(mkdir -p "$1" && cd "$1" && pwd)
OPENSSL=${OPENSSL:-/opt/homebrew/opt/openssl@3/bin/openssl}
q() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
[ "$(q "select to_regnamespace('recovery') is null")" = t ] || { echo "087 already installed here"; exit 0; }
( cd "$ROOT" && APPLY_MIGRATIONS_TEST_CONTAINER=$DB bash deploy/lucashome/apply-migrations.sh --from 087 --to 087 ) > "$OUT/apply-087.log" 2>&1
grep -q 'COMMITTED' "$OUT/apply-087.log" || { tail -5 "$OUT/apply-087.log"; exit 1; }
docker exec -i "$DB" psql -X -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 < "$ROOT/tools/m087-verify/sql/test-helpers.sql" > /dev/null
q "select recovery.owner_anchor('v87 client e2e', 'alice', 'bob')" > /dev/null
rm -rf "$OUT/auth" "$OUT/mirror"; mkdir -p "$OUT/auth" "$OUT/mirror"
"$OPENSSL" genpkey -algorithm ed25519 -out "$OUT/auth/authority.key" 2>/dev/null; chmod 600 "$OUT/auth/authority.key"
"$OPENSSL" pkey -in "$OUT/auth/authority.key" -pubout -out "$OUT/auth/authority.pub"
AUTH_PGHOST=127.0.0.1 python3 -I "$ROOT/tools/recovery-authority/authority.py" genesis "$OUT/auth" "$OUT/mirror" "$DB" 3600 > "$OUT/genesis.log" 2>&1
grep -q 'genesis lease=RENEWED' "$OUT/genesis.log" || { cat "$OUT/genesis.log"; exit 1; }
q "select recovery.owner_open('alice', 'bob')" > /dev/null
echo "087 installed and open: $(q "select state || ' lease=' || recovery.lease_ok()::text || ' legacy=' || (select legacy_paths from recovery.settings) from recovery.continuity")"
