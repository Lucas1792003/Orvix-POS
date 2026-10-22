#!/bin/bash
# Step 5 copy of the Script 2 proof (adds the Step 5 image proofs). Proof on the Supabase PostgreSQL 17 image (DISPOSABLE phf-iso stack, loopback only): 085 + 086 through the real runner,
# financial provisionals, 087 through the real runner as supabase_admin, then the pinned fingerprint, the V1 install with
# the 087 adapter, and the runner's V1 refusals. Tears the stack down at the end.
set -uo pipefail
W=$(cd "$(dirname "$0")/../../.." && pwd); O=$1; mkdir -p "$O"; O=$(cd "$O" && pwd); cd "$W" || exit 2
DB=phf-iso-db
q() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At "$@"; }
say() { echo "$*" | tee -a "$O/summary.txt"; }
trap 'bash tools/m087-verify/lib/stack.sh down "$O/stack" >> "$O/down.log" 2>&1; say "teardown: $(tail -1 "$O/down.log")"' EXIT
bash tools/m087-verify/lib/stack.sh up "$O/stack" > "$O/stack-up.log" 2>&1; say "stack: $(tail -1 "$O/stack-up.log")"
say "server: $(q -c 'show server_version')"
for f in PSAFE-A_no_086_rerun_after_087 PFIN-A_report_indexes PFIN-B_financial_reports PCOST-A_cost_privacy PFIN-D_payments_cash PFIN-E_refund_lines; do
  q --single-transaction -f - < supabase/migrations-provisional/$f.sql > "$O/$f.log" 2>&1; say "$f: exit $?"
done
bash tools/m087-verify/lib/reserve-recovery-roles.sh $DB > "$O/reserve.log" 2>&1; say "reserve 087 roles: $(tail -1 "$O/reserve.log")"
APPLY_MIGRATIONS_TEST_CONTAINER=$DB bash deploy/lucashome/apply-migrations.sh --from 087 --to 087 > "$O/apply-087.log" 2>&1; say "087 via runner: exit $? :: $(grep -E 'COMMITTED|ledger now' "$O/apply-087.log" | tr '\n' ' ')"
R() { APPLY_MIGRATIONS_TEST_CONTAINER=$DB bash deploy/lucashome/apply-migrations.sh "$@"; }
R --from 088 --to 088 > "$O/a088.log" 2>&1; say "088 via runner (before V1): exit $? $(grep -E 'ledger now' "$O/a088.log")"
R --rollback 088 --owner-confirmed-till-queues-empty > "$O/rb088.log" 2>&1; say "rollback 088: exit $? $(grep -E 'ledger now|REFUSE' "$O/rb088.log" | head -1)"
R --rollback 087 --owner-confirmed-till-queues-empty > "$O/rb087.log" 2>&1; say "rollback 087 after 088 rolled back: exit $? $(grep -E 'ledger now|REFUSE' "$O/rb087.log" | head -1) recovery schema: $(q -c "select to_regnamespace('recovery') is not null")"
R --from 087 --to 088 > "$O/re087.log" 2>&1; say "re-apply 087+088: exit $? $(grep -E 'ledger now' "$O/re087.log")"
say "087 event trigger owner: $(q -c "select evtowner::regrole from pg_event_trigger where evtname='zz_recovery_ddl_guard'")"
python3 -I tools/migration-sequence/verify.py facts-sql > "$O/facts.sql"
q -f - < "$O/facts.sql" | grep orvix-migration-facts-v1 > "$O/facts-087.json"; say "facts after 087: $(cat "$O/facts-087.json")"
python3 -I tools/migration-sequence/verify.py plan --facts "$O/facts-087.json" > "$O/plan-087.log"; say "plan after 087: exit $? $(grep -c VIOLATION "$O/plan-087.log") violations"
# Step 4: a SYNTHETIC owner key (system temp directory only), given to the installer
KD=$(mktemp -d /private/tmp/s4own.XXXX); OWNER=$(node tools/recovery-v1/owner/owner-sim.mjs keygen "$KD" owner-img-1); say "synthetic owner key: $(echo "$OWNER" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["keyId"], len(d["n"])*4, "bits")')"
V1ARGS=(-v recovery_v1_install_ack=restrict-every-organization -v "recovery_v1_owner_public_key=$OWNER")
# installer refuses while orvix_recovery_operator is not reserved (supautils loaded)
docker exec -i $DB psql -X -U supabase_admin -d postgres "${V1ARGS[@]}" -f - < supabase/migrations-provisional/RECOVERY_V1_guards.sql > "$O/v1-unreserved.log" 2>&1
say "V1 install without reserved operator role: exit $? $(grep -o 'RECOVERY_V1_[A-Z_]*' "$O/v1-unreserved.log" | head -1); recovery_v1 schema: $(q -c "select to_regnamespace('recovery_v1') is not null")"
cur=$(q -c "show supautils.reserved_roles"); q -c "alter system set supautils.reserved_roles = '$cur, orvix_recovery_operator'" >/dev/null; q -c "select pg_reload_conf()" >/dev/null; sleep 2
say "reserved roles now include orvix_recovery_operator: $(q -c 'show supautils.reserved_roles' | grep -c orvix_recovery_operator)"
docker exec -i $DB psql -X -U supabase_admin -d postgres "${V1ARGS[@]}" -f - < supabase/migrations-provisional/RECOVERY_V1_guards.sql > "$O/v1-install.log" 2>&1
say "V1 install with 087 adapter: exit $? $(grep -o 'RECOVERY_V1_[A-Z_]*[^;]\{0,80\}' "$O/v1-install.log" | head -1)"
say "adapter: $(q -c "select fingerprint||' full='||left(full_fingerprint,8) from recovery_v1.adapter_087") integrity=$(q -c "select coalesce(recovery_v1.integrity_problem(),'none')") states=$(q -c "select string_agg(distinct state,',') from recovery_v1.org_state")"
say "guarded write: $(q -c "update public.shops set address=address where id=(select id from public.shops limit 1)" 2>&1 | grep -o 'ORG_SUSPENDED[^]]*]' | head -1)"
say "087 change as superuser: $(q -c "alter function recovery.refuse(text) set work_mem='1MB'" 2>&1 | grep -o 'RECOVERY_V1_[A-Z_0-9]*' | head -1)"
say "new public table: $(q -c "create table public.zz_probe(id int)" 2>&1 | grep -o 'RECOVERY_V1_[A-Z_0-9]*' | head -1)"
q -f - < "$O/facts.sql" | grep orvix-migration-facts-v1 > "$O/facts-v1.json"; python3 -I tools/migration-sequence/verify.py plan --facts "$O/facts-v1.json" > "$O/plan-v1.log"; say "plan after V1: exit $? $(grep -c VIOLATION "$O/plan-v1.log") violations; installed $(head -1 "$O/plan-v1.log")"
R --rollback 088 --owner-confirmed-till-queues-empty > "$O/apply-088.log" 2>&1; say "runner rollback 088 with V1: exit $? $(grep -o 'REFUSE: Recovery V1[^—]\{0,60\}' "$O/apply-088.log" | head -1)"
APPLY_MIGRATIONS_TEST_CONTAINER=$DB bash deploy/lucashome/apply-migrations.sh --rollback 087 --owner-confirmed-till-queues-empty > "$O/rb-087.log" 2>&1; say "runner rollback 087: exit $? $(grep -o 'REFUSE: [^(]\{0,90\}' "$O/rb-087.log" | head -2 | tr '\n' ' ')"
printf '%s\n' "BEGIN;" "SET LOCAL event_triggers = off;" "CREATE OR REPLACE TRIGGER zz_recovery_v1_write BEFORE INSERT OR UPDATE OR DELETE ON public.shops FOR EACH ROW WHEN (false) EXECUTE FUNCTION recovery_v1.guard_write();" "ALTER TABLE public.shops ENABLE ALWAYS TRIGGER zz_recovery_v1_write;" "SELECT 'evtoff integrity=' || coalesce(recovery_v1.integrity_problem(),'none');" "ROLLBACK;" | q -f - > "$O/evtoff.log" 2>&1; say "PG17 SET event_triggers=off + guard trigger replaced: $(grep -o 'evtoff integrity=[a-z_0-9]*' "$O/evtoff.log")"
say "integrity after 088: $(q -c "select coalesce(recovery_v1.integrity_problem(),'none')")"

# ---- Step 4 on the image: owner authorization (RSA in PL/pgSQL), offline policy, authorized migration, refusals
say "owner keys: $(q -c "select string_agg(key_id||':'||bits,',') from recovery_v1.owner_keys")"
say "split / cash / refund-line objects: $(q -c "select to_regclass('public.sale_payments') is not null and to_regclass('public.cash_movements') is not null and to_regclass('public.refund_lines') is not null and to_regclass('public.refund_payouts') is not null")"
say "PFIN-D/E tables guarded by V1: $(q -c "select count(*) from pg_trigger where tgname='zz_recovery_v1_write' and tgrelid in ('public.sale_payments'::regclass,'public.cash_movements'::regclass,'public.refund_lines'::regclass,'public.refund_payouts'::regclass)")/4"
q -c "select recovery_v1.authorization_target()" > "$O/target.json"
echo '{"policy":{"scope":"*","maxLifetimeSeconds":3600,"maxOps":5,"maxAmountMmk":50000,"syncGraceSeconds":86400,"orgBudgetMmk":200000,"shopBudgetMmk":100000,"deviceBudgetMmk":50000}}' > "$O/policy.json"
A=$(node tools/recovery-v1/owner/owner-sim.mjs authorize "$KD/owner-img-1.private.pem" owner-img-1 offline-policy "$O/target.json" "$O/policy.json")
AU=$(echo "$A" | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorization"])'); SG=$(echo "$A" | python3 -c 'import json,sys;print(json.load(sys.stdin)["signature"])')
printf '%s
' "select recovery_v1.set_offline_policy(:'a', :'s');" | docker exec -i $DB psql -X -U supabase_admin -d postgres -At -v "a=$AU" -v "s=$SG" -f - > "$O/policy.log" 2>&1; say "owner-signed offline policy: exit $? $(cut -c1-80 "$O/policy.log")"
printf '%s
' "select recovery_v1.set_offline_policy(:'a', :'s');" | docker exec -i $DB psql -X -U supabase_admin -d postgres -At -v "a=$AU" -v "s=$SG" -f - > "$O/policy-replay.log" 2>&1; say "replayed authorization: exit $? $(grep -o 'RECOVERY_V1_[A-Z_]*' "$O/policy-replay.log" | head -1)"
SG2=$(printf '%s' "$SG" | sed 's/^./0/'); [ "$SG2" = "$SG" ] && SG2=$(printf '%s' "$SG" | sed 's/^./1/')
printf '%s
' "select recovery_v1.set_offline_policy(:'a', :'s');" | docker exec -i $DB psql -X -U supabase_admin -d postgres -At -v "a=$AU" -v "s=$SG2" -f - > "$O/policy-badsig.log" 2>&1; say "tampered signature: exit $? $(grep -o 'signature does not verify\|REPLAY' "$O/policy-badsig.log" | head -1)"
MSQL="CREATE TABLE public.loyalty_probe (id bigint PRIMARY KEY, org_id text NOT NULL, points int NOT NULL DEFAULT 0); ALTER TABLE public.loyalty_probe ENABLE ROW LEVEL SECURITY;"
HEAD=$(q -c "select recovery_v1.migration_chain_head()")
python3 -c "import json,hashlib,sys;q=sys.argv[1];print(json.dumps({'migration':{'id':'IMG-0001-loyalty','sqlSha256':hashlib.sha256(q.encode()).hexdigest(),'predecessor':sys.argv[2],'allowedCommands':['CREATE TABLE','CREATE INDEX','ALTER TABLE'],'newTables':['loyalty_probe']}}))" "$MSQL" "$HEAD" > "$O/mig.json"
q -c "select recovery_v1.authorization_target()" > "$O/target2.json"
A=$(node tools/recovery-v1/owner/owner-sim.mjs authorize "$KD/owner-img-1.private.pem" owner-img-1 migration "$O/target2.json" "$O/mig.json")
AU=$(echo "$A" | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorization"])'); SG=$(echo "$A" | python3 -c 'import json,sys;print(json.load(sys.stdin)["signature"])')
printf '%s
' "select recovery_v1.apply_authorized_migration(:'a', :'s', :'q');" | docker exec -i $DB psql -X -U supabase_admin -d postgres -At -v "a=$AU" -v "s=$SG" -v "q=$MSQL x" -f - > "$O/mig-wrongsql.log" 2>&1; say "authorized migration with different SQL: exit $? $(grep -o 'RECOVERY_V1_[A-Z_]*' "$O/mig-wrongsql.log" | head -1)"
printf '%s
' "select recovery_v1.apply_authorized_migration(:'a', :'s', :'q');" | docker exec -i $DB psql -X -U supabase_admin -d postgres -At -v "a=$AU" -v "s=$SG" -v "q=$MSQL" -f - > "$O/mig.log" 2>&1; say "authorized migration: exit $? $(cut -c1-120 "$O/mig.log")"
say "new table guarded: $(q -c "select count(*) from pg_trigger where tgrelid='public.loyalty_probe'::regclass and tgname like 'zz_recovery_v1_%'") triggers; registered: $(q -c "select count(*) from recovery_v1.guarded_tables where relname='loyalty_probe'"); chain: $(q -c "select count(*) from recovery_v1.applied_migrations")"
say "write to the new table while restricted: $(q -c "insert into public.loyalty_probe values (1, (select org_id from public.shops limit 1), 1)" 2>&1 | grep -o 'ORG_SUSPENDED[^]]*]' | head -1)"
say "unauthorized table after the migration: $(q -c "create table public.zz_probe2(id int)" 2>&1 | grep -o 'RECOVERY_V1_[A-Z_0-9]*' | head -1)"
say "integrity after the authorized migration: $(q -c "select coalesce(recovery_v1.integrity_problem(),'none')")"
say "087 fingerprint still the pin: $(q -c "select fingerprint from recovery_v1.adapter_087")"
# ---- Step 5 on the image: device enrollment, forged rows, the ACTIVE gate, owner-signed reopening (synthetic signers)
python3 -I tools/recovery-v1/step5/image_proof.py "$O/step5" "$KD" owner-img-1 > "$O/step5.log" 2>&1; say "step5 image proof: exit $?"; while read -r l; do say "$l"; done < <(grep '^step5 ' "$O/step5.log")
rm -rf "$KD"
# ---- Step 4 review hardening on PostgreSQL 17 (event triggers can be switched off here)
printf '%s\n' "BEGIN;" "SET LOCAL event_triggers = off;" "CREATE OR REPLACE FUNCTION recovery_v1.v1_catalog_state() RETURNS text LANGUAGE sql AS \$f\$ SELECT 'x' \$f\$;" "SELECT 'catalog integrity=' || coalesce(recovery_v1.integrity_problem(),'none');" "ROLLBACK;" | q -f - > "$O/evtoff-v1.log" 2>&1
say "PG17 event_triggers=off + V1 function replaced: $(grep -o 'catalog integrity=[a-z_0-9]*' "$O/evtoff-v1.log")"
say "V1 function replaced with event triggers on: $(q -c "create or replace function recovery_v1.v1_catalog_state() returns text language sql as \$f\$ select 'x' \$f\$" 2>&1 | grep -o 'RECOVERY_V1_[A-Z_]*' | head -1)"
say "integrity after the refusals: $(q -c "select coalesce(recovery_v1.integrity_problem(),'none')")"
