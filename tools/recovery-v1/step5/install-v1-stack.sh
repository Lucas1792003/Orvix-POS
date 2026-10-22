#!/usr/bin/env bash
# Step 5: install Recovery V1 on the DISPOSABLE loopback stack (container phf-iso-db) after the e2e global setup seeded the QA
# tenant. Every organization is RESTRICTED by the install and stays so: there is NO ACTIVE fixture here — the spec reopens the
# QA organization through the genuine owner-signed protocol. The SYNTHETIC owner key is generated into OUT/owner-keys on the
# host (0700), never inside the database container. An owner-signed offline policy for the QA organization carries SYNTHETIC
# aggregate budgets (test values, not a policy recommendation).
#   install-v1-stack.sh OUT_DIR QA_ORG_ID    -> prints {"ownerFingerprint":..., "keyId":..., "keydir":...}
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); DB=phf-iso-db; OUT=$(mkdir -p "$1" && cd "$1" && pwd); ORG=$2
[[ "$ORG" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad org id"; exit 2; }
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
q() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
SIM="$ROOT/tools/recovery-v1/owner/owner-sim.mjs"; KD="$OUT/owner-keys"; mkdir -p "$KD"; chmod 700 "$KD"
case "$KD" in /private/tmp/*|/tmp/*|/var/folders/*) ;; *) KD=$(mktemp -d /private/tmp/s5own.XXXX);; esac
if [ "$(q "select to_regnamespace('recovery_v1') is not null")" = t ]; then echo "V1 already installed"; exit 1; fi
cur=$(q "show supautils.reserved_roles")
case ",$(echo "$cur" | tr -d ' ')," in *,orvix_recovery_operator,*) ;; *)
  q "alter system set supautils.reserved_roles = '$cur, orvix_recovery_operator'" >/dev/null; q "select pg_reload_conf()" >/dev/null; sleep 2;; esac
OWNER=$(node "$SIM" keygen "$KD" owner-e2e-1)
docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -v recovery_v1_install_ack=restrict-every-organization \
  -v "recovery_v1_owner_public_key=$OWNER" -f - < "$ROOT/supabase/migrations-provisional/RECOVERY_V1_guards.sql" > "$OUT/install-v1.log" 2>&1
# the owner-signed offline policy (SYNTHETIC): 20,000 MMK and 2 operations per capability; outstanding at once at most
# 20,000 per till, 30,000 per shop, 40,000 per organization
q "select recovery_v1.authorization_target()::text" > "$OUT/target.json"
printf '{"policy":{"scope":"%s","maxLifetimeSeconds":3600,"maxOps":2,"maxAmountMmk":20000,"syncGraceSeconds":86400,"orgBudgetMmk":40000,"shopBudgetMmk":30000,"deviceBudgetMmk":20000}}' "$ORG" > "$OUT/policy.json"
node "$SIM" authorize "$KD/owner-e2e-1.private.pem" owner-e2e-1 offline-policy "$OUT/target.json" "$OUT/policy.json" > "$OUT/policy.signed.json"
node -e '
const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const tag=(s)=>{let t="p"; while(s.includes("$"+t+"$")) t+="x"; return "$"+t+"$";};
const a=tag(d.authorization), s=tag(d.signature);
process.stdout.write(`select recovery_v1.set_offline_policy(${a}${d.authorization}${a}, ${s}${d.signature}${s})::text;`);' "$OUT/policy.signed.json" \
  | docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At > "$OUT/policy.log"
FP=$(q "select fingerprint from recovery_v1.owner_keys where key_id='owner-e2e-1'")
echo "{\"ownerFingerprint\":\"$FP\",\"keyId\":\"owner-e2e-1\",\"keydir\":\"$KD\",\"integrity\":\"$(q "select coalesce(recovery_v1.integrity_problem(),'none')")\",\"qaState\":\"$(q "select state from recovery_v1.org_state where org_id = '$ORG'")\"}"
