#!/usr/bin/env bash
# Script 2: install Recovery V1 on the DISPOSABLE loopback stack (container phf-iso-db) AFTER the e2e global setup
# seeded the QA tenant. Synthetic owner key (temp dir), unapproved TEST offline defaults. Every organization is
# RESTRICTED by the install; the QA organization is then set ACTIVE as a SYNTHETIC TEST FIXTURE (a superuser update:
# Recovery V1 has no reopen path — this is never a recovery).
#   install-v1-stack.sh OUT_DIR QA_ORG_ID
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); DB=phf-iso-db; OUT=$(mkdir -p "$1" && cd "$1" && pwd); ORG=$2
[[ "$ORG" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad org id"; exit 2; }
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
q() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
if [ "$(q "select to_regnamespace('recovery_v1') is not null")" = t ]; then echo "V1 already installed"; exit 0; fi
cur=$(q "show supautils.reserved_roles")
case ",$(echo "$cur" | tr -d ' ')," in *,orvix_recovery_operator,*) ;; *)
  q "alter system set supautils.reserved_roles = '$cur, orvix_recovery_operator'" >/dev/null; q "select pg_reload_conf()" >/dev/null; sleep 2;; esac
KD=$(mktemp -d /private/tmp/s2own.XXXX)
OWNER=$(node "$ROOT/tools/recovery-v1/owner/owner-sim.mjs" keygen "$KD" owner-e2e-1)
docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -v recovery_v1_install_ack=restrict-every-organization \
  -v "recovery_v1_owner_public_key=$OWNER" -v recovery_v1_offline_defaults=allow-unapproved-test-defaults -f - \
  < "$ROOT/supabase/migrations-provisional/RECOVERY_V1_guards.sql" > "$OUT/install-v1.log" 2>&1
rm -rf "$KD"
q "update recovery_v1.org_state set state = 'ACTIVE' where org_id = '$ORG'" >/dev/null   # SYNTHETIC FIXTURE
echo "V1 installed; integrity=$(q "select coalesce(recovery_v1.integrity_problem(),'none')") qa_org=$(q "select state from recovery_v1.org_state where org_id = '$ORG'")"
