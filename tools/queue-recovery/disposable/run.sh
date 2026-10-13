#!/usr/bin/env bash
# Restore drill for a pending-queue export into a DISPOSABLE backend:
# throwaway Postgres (supabase/postgres image, same preparation as
# supabase/tests/phase-d/run.sh: auth shim, baseline schema, migrations > 061)
# + a throwaway PostgREST in front of it, both bound to 127.0.0.1, both
# removed on exit. The QA tenant the export came from is re-seeded there
# from the Phase D/E live seeds (same ids), then the recovery tool replays
# the export twice with its normal code path and the database is checked.
#
# QA exports only: refuses unless the export's org id is qa-org-<digits>.
#
# usage:
#   BASELINE_SQL=/path/to/schema.scrubbed.sql QUEUE_RECOVERY_PASSPHRASE=... \
#     bash tools/queue-recovery/disposable/run.sh <export.spqx>
# env: BASELINE_SQL (required), QUEUE_RECOVERY_PASSPHRASE (required),
#      PHF_QX_DB_IMAGE, PHF_QX_REST_IMAGE, PHF_QX_KEEP=1 (leave containers up)
# Containers: phf-qx-db, phf-qx-rest; network phf-qx-net. Nothing secret is printed.
set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PHD="$REPO/supabase/tests/phase-d"
EXPORT="${1:-}"
DB_IMAGE="${PHF_QX_DB_IMAGE:-supabase/postgres:17.6.1.136}"
REST_IMAGE="${PHF_QX_REST_IMAGE:-postgrest/postgrest:v14.17}"
DB=phf-qx-db
REST=phf-qx-rest
NET=phf-qx-net
KEEP="${PHF_QX_KEEP:-0}"
WORK="$(mktemp -d)"
FAILS=0

log()  { printf '\n==> %s\n' "$*"; }
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILS=$((FAILS + 1)); }

cleanup() {
  rc=$?
  if [ "$KEEP" != "1" ]; then
    docker rm -f "$REST" "$DB" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
  else
    echo "PHF_QX_KEEP=1: leaving $DB / $REST running"
  fi
  rm -rf "$WORK"
  exit $rc
}
trap cleanup EXIT INT TERM

[ -n "$EXPORT" ] && [ -f "$EXPORT" ] || { echo "usage: $0 <export.spqx>"; exit 2; }
[ -n "${BASELINE_SQL:-}" ] && [ -f "$BASELINE_SQL" ] || { echo "BASELINE_SQL must point at the scrubbed baseline schema dump"; exit 2; }
[ -n "${QUEUE_RECOVERY_PASSPHRASE:-}" ] || { echo "QUEUE_RECOVERY_PASSPHRASE is required"; exit 2; }
command -v docker >/dev/null && command -v psql >/dev/null && command -v jq >/dev/null || { echo "needs docker, psql, jq"; exit 2; }

tool() { (cd "$REPO" && npx tsx tools/queue-recovery/cli.ts "$@"); }

# ------------------------------------------------------------ the export --
log "reading the export (counts and ids only)"
tool inspect "$EXPORT" --json > "$WORK/inspect.out" 2>&1 || { tail -5 "$WORK/inspect.out"; exit 3; }
sed -n '/^{/,$p' "$WORK/inspect.out" > "$WORK/inspect.json"
ORG="$(jq -r '.session.orgId // ""' "$WORK/inspect.json")"
USER_ID="$(jq -r '.session.userId // ""' "$WORK/inspect.json")"
case "$ORG" in qa-org-*) TS="${ORG#qa-org-}";; *) TS="";; esac
case "$TS" in ''|*[!0-9]*) echo "refusing: the export's org ($ORG) is not a QA org (qa-org-<digits>)"; exit 2;; esac
N_RPC="$(jq '[.entries[] | select(.status != "conflict")] | length' "$WORK/inspect.json")"
N_SALES="$(jq '[.entries[] | select(.status != "conflict" and .opType == "complete_sale")] | length' "$WORK/inspect.json")"
echo "export: org $ORG, user $USER_ID, $N_RPC replayable entries ($N_SALES sales)"

# ------------------------------------------------------------- database --
PW="$(openssl rand -hex 16)"
AUTH_PW="$(openssl rand -hex 16)"
JWT_SECRET="$(openssl rand -hex 32)"
docker rm -f "$REST" "$DB" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null || exit 2
log "starting $DB ($DB_IMAGE), 127.0.0.1 only"
docker run -d --name "$DB" --network "$NET" -p "127.0.0.1::5432" --memory 1g -e POSTGRES_PASSWORD="$PW" "$DB_IMAGE" >/dev/null || exit 2
DBPORT="$(docker port "$DB" 5432/tcp | head -1 | sed 's/.*://')"
pg_psql() { PGPASSWORD="$PW" psql -X -h 127.0.0.1 -p "$DBPORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
su_psql() { docker exec -i -e PGPASSWORD="$PW" "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
for _ in $(seq 1 90); do pg_psql -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
sleep 3
su_psql -Atc 'select 1' >/dev/null 2>&1 || { echo "database did not come up"; exit 2; }

log "schema: prep shim, baseline, storage 016, migrations > 061"
su_psql -At < "$PHD/sql/00_prep.sql" > "$WORK/prep.log" 2>&1 || { tail -5 "$WORK/prep.log"; exit 1; }
su_psql < "$BASELINE_SQL" > "$WORK/baseline.log" 2>&1 || { tail -10 "$WORK/baseline.log"; exit 1; }
su_psql < "$REPO/supabase/migrations/016_product_images_storage.sql" > "$WORK/016.log" 2>&1 || { tail -5 "$WORK/016.log"; exit 1; }
for f in "$REPO"/supabase/migrations/*.sql; do
  n="$(basename "$f" | cut -d_ -f1)"
  case "$n" in ''|*[!0-9]*) continue;; esac
  if [ "$((10#$n))" -gt 61 ]; then
    pg_psql -f "$f" > "$WORK/mig_$n.log" 2>&1 || { tail -10 "$WORK/mig_$n.log"; echo "migration $n failed"; exit 1; }
  fi
done
echo "migrations applied up to $(ls "$REPO"/supabase/migrations/*.sql | tail -1 | xargs basename)"

log "seeding the QA tenant ts=$TS (Phase D + E live seeds, synthetic auth ids)"
A_ADMIN="$(uuidgen | tr A-Z a-z)"; A_MGR="$(uuidgen | tr A-Z a-z)"; A_CA="$(uuidgen | tr A-Z a-z)"; A_CB="$(uuidgen | tr A-Z a-z)"
su_psql -c "INSERT INTO auth.users (id, email) VALUES
  ('$A_ADMIN','qa-admin-$TS@qa.invalid'), ('$A_MGR','qa-manager-$TS@qa.invalid'),
  ('$A_CA','qa-cashier-a-$TS@qa.invalid'), ('$A_CB','qa-cashier-b-$TS@qa.invalid');" >/dev/null || exit 1
su_psql -At -v ts="$TS" -v auth_admin="$A_ADMIN" -v auth_mgr="$A_MGR" -v auth_casha="$A_CA" -v auth_cashb="$A_CB" \
  < "$PHD/live/seed.sql" | tail -1
su_psql -At -v ts="$TS" < "$REPO/supabase/tests/phase-e/live/seed_extra.sql" | tail -1
case "$USER_ID" in
  "qa-user-cashier-a-$TS") SUB="$A_CA";; "qa-user-cashier-b-$TS") SUB="$A_CB";;
  "qa-user-manager-$TS") SUB="$A_MGR";; "qa-user-admin-$TS") SUB="$A_ADMIN";;
  *) echo "export user $USER_ID is not a seeded QA user"; exit 2;;
esac
su_psql -c "ALTER ROLE authenticator WITH LOGIN PASSWORD '$AUTH_PW';" >/dev/null || exit 1
# This image's auth.uid() reads only the legacy per-claim GUC; PostgREST >= 10
# sets request.jwt.claims. Use the definition current stacks ship (both).
su_psql >/dev/null <<'SQL' || exit 1
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
SQL

# ------------------------------------------------------------- PostgREST --
log "starting $REST ($REST_IMAGE), 127.0.0.1 only"
docker run -d --name "$REST" --network "$NET" -p "127.0.0.1::3000" \
  -e PGRST_DB_URI="postgres://authenticator:$AUTH_PW@$DB:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" \
  "$REST_IMAGE" >/dev/null || exit 2
RESTPORT="$(docker port "$REST" 3000/tcp | head -1 | sed 's/.*://')"
TARGET="http://127.0.0.1:$RESTPORT"
for _ in $(seq 1 60); do curl -fsS -o /dev/null "$TARGET/" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "$TARGET/" || { docker logs "$REST" 2>&1 | tail -20; echo "PostgREST did not come up"; exit 2; }

mint() {  # mint <role> [sub]: HS256 JWT for this throwaway stack (secret in env only)
  JWT_SECRET="$JWT_SECRET" node -e '
    const c = require("node:crypto");
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const claims = { role: process.argv[1], aud: "authenticated", iat: now, exp: now + 3600 };
    if (process.argv[2]) claims.sub = process.argv[2];
    const head = b({ alg: "HS256", typ: "JWT" }) + "." + b(claims);
    process.stdout.write(head + "." + c.createHmac("sha256", process.env.JWT_SECRET).update(head).digest("base64url"));
  ' "$@"
}
QUEUE_RECOVERY_ACCESS_TOKEN="$(mint authenticated "$SUB")"
QUEUE_RECOVERY_SERVICE_KEY="$(mint service_role)"
export QUEUE_RECOVERY_ACCESS_TOKEN QUEUE_RECOVERY_SERVICE_KEY
unset QUEUE_RECOVERY_ANON_KEY

COMMON=(--target "$TARGET" --confirm-host "127.0.0.1:$RESTPORT" --rest-prefix "")
sql() { su_psql -Atc "$1"; }

# ----------------------------------------------------------------- drill --
log "refusals"
tool replay "$EXPORT" > "$WORK/r0.out" 2>&1; rc=$?
[ "$rc" = 2 ] && grep -q -- "--target <url> is required" "$WORK/r0.out" && pass "no --target -> exit 2" || fail "no --target (rc=$rc)"
tool replay "$EXPORT" --target "$TARGET" --rest-prefix "" > "$WORK/r0b.out" 2>&1; rc=$?
[ "$rc" = 2 ] && grep -q -- "--confirm-host" "$WORK/r0b.out" && pass "different host without --confirm-host -> exit 2" || fail "confirm-host (rc=$rc)"

log "dry run"
tool replay "$EXPORT" "${COMMON[@]}" --dry-run --report "$WORK/dry.json" > "$WORK/dry.out" 2>&1; rc=$?
[ "$rc" = 0 ] && [ "$(jq .counts.planned "$WORK/dry.json")" = "$N_RPC" ] && [ "$(sql "select count(*) from idempotency_keys")" = 0 ] \
  && pass "dry run: $N_RPC planned, 0 keys written" || fail "dry run (rc=$rc)"

SALES0="$(sql "select count(*) from sales where shop_id like 'qa-shop%-$TS'")"
log "replay #1"
tool replay "$EXPORT" "${COMMON[@]}" --report "$WORK/r1.json" > "$WORK/r1.out" 2>&1; rc=$?
sed -n '/seq  op/,$p' "$WORK/r1.out"
[ "$rc" = 0 ] && [ "$(jq .counts.applied "$WORK/r1.json")" = "$N_RPC" ] && pass "replay #1: $N_RPC applied" || fail "replay #1 (rc=$rc)"
SALES1="$(sql "select count(*) from sales where shop_id like 'qa-shop%-$TS'")"
KEYS1="$(sql "select count(*) from idempotency_keys")"
[ "$((SALES1 - SALES0))" = "$N_SALES" ] && pass "sales +$N_SALES" || fail "sales $SALES0 -> $SALES1, expected +$N_SALES"
[ "$KEYS1" = "$N_RPC" ] && pass "idempotency keys = $N_RPC" || fail "keys $KEYS1"

log "replay #2 (must create nothing)"
tool replay "$EXPORT" "${COMMON[@]}" --report "$WORK/r2.json" > "$WORK/r2.out" 2>&1; rc=$?
[ "$rc" = 0 ] && [ "$(jq '.counts["already-applied"]' "$WORK/r2.json")" = "$N_RPC" ] && pass "replay #2: $N_RPC already-applied" || fail "replay #2 (rc=$rc)"
[ "$(sql "select count(*) from sales where shop_id like 'qa-shop%-$TS'")" = "$SALES1" ] && [ "$(sql "select count(*) from idempotency_keys")" = "$KEYS1" ] \
  && pass "replay #2: 0 new sales, 0 new keys" || fail "replay #2 created rows"
same_ids="$(jq -r '[.ops[].resultId] | join(",")' "$WORK/r1.json")"
[ "$same_ids" = "$(jq -r '[.ops[].resultId] | join(",")' "$WORK/r2.json")" ] && pass "replay #2 returned the original result ids" || fail "result ids differ"

log "replay #3 without ledger access (probe classification)"
QUEUE_RECOVERY_SERVICE_KEY="" tool replay "$EXPORT" "${COMMON[@]}" --report "$WORK/r3.json" > "$WORK/r3.out" 2>&1; rc=$?
[ "$rc" = 0 ] && [ "$(jq '.counts["already-applied"]' "$WORK/r3.json")" = "$N_SALES" ] && pass "replay #3 (probe): $N_SALES sales already-applied" || fail "replay #3 (rc=$rc)"

log "consistency (duplicate/lost-sale queries + stock ledger)"
q() { v="$(sql "$2")"; [ "$v" = "$3" ] && pass "$1 = $v" || fail "$1 = $v (expected $3)"; }
q "sales without a complete_sale key" "SELECT count(*) FROM sales s WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys k WHERE k.rpc='complete_sale' AND k.response->'sale'->>'id' = s.id)" 0
q "keys without their sale" "SELECT count(*) FROM idempotency_keys k WHERE k.rpc='complete_sale' AND k.response IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = k.response->'sale'->>'id')" 0
q "same operation twice" "SELECT count(*) FROM (SELECT 1 FROM sales GROUP BY cashier_id, shift_id, created_at HAVING count(*) > 1) x" 0
q "duplicate receipt numbers" "SELECT count(*) FROM (SELECT 1 FROM sales GROUP BY shop_id, receipt_no HAVING count(*) > 1) x" 0
q "negative stock" "SELECT count(*) FROM inventory WHERE qty_base_units < 0" 0
q "SALE_OUT movements != sale items" "SELECT abs((SELECT count(*) FROM inventory_movements WHERE type='SALE_OUT') - (SELECT count(*) FROM sale_items))" 0
q "inventory != seed + movements" "SELECT count(*) FROM inventory i WHERE i.shop_id = 'qa-shop-$TS' AND i.qty_base_units <> 100 + coalesce((SELECT sum(qty_change) FROM inventory_movements m WHERE m.shop_id = i.shop_id AND m.product_id = i.product_id), 0)" 0
echo "INFO sale times (ring-up time kept when within 48 h): $(sql "SELECT string_agg(to_char(created_at, 'HH24:MI:SS'), ' ' ORDER BY created_at) FROM sales")"

log "result: $FAILS failure(s)"
[ "$FAILS" = 0 ]
