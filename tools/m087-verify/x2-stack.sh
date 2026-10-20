#!/usr/bin/env bash
# 087 stack suite: the REAL migration (applied and rolled back through deploy/lucashome/apply-migrations.sh) on the DISPOSABLE
# loopback stack (lib/stack.sh), real HTTP through the audit gateway and the pinned upstream Envoy v1.39.1, the repo's witness
# authority and gate (tools/recovery-authority). Test-only helpers: sql/test-helpers.sql (never part of 087).
#   tools/m087-verify/x2-stack.sh RESULTS_DIR          (expects RESULTS_DIR/stack from lib/stack.sh up)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
RES=$(cd "$1" && pwd); OUT="$RES/x2"; rm -rf "$OUT"; mkdir -p "$OUT/auth" "$OUT/mirror"; STK="$RES/stack"; DB=phf-iso-db
TOOLS="$ROOT/tools/recovery-authority"; OPENSSL=${OPENSSL:-/opt/homebrew/opt/openssl@3/bin/openssl}
SWORK=$(cat "$STK/swork.path"); set -a; . "$SWORK/secrets.env"; set +a
case "$PHF_ISO_URL" in http://127.0.0.1:*) ;; *) echo "REFUSE: non-loopback gateway"; exit 3;; esac
q()    { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
qe()   { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1" 2>&1 | sed -E 's/^(psql:[^E]*)?ERROR: +//' | head -1; }
qerr() { docker exec -i "$DB" psql -X -U "$1" -d postgres -v ON_ERROR_STOP=1 -At -c "$2" 2>&1 | grep -m1 -E 'ERROR|permission' | sed -E 's/^(psql:[^E]*)?ERROR: +//'; }
qpg()  { docker exec -i "$DB" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -At -c "$1" 2>&1 | grep -m1 -E 'ERROR|permission|must be' | sed -E 's/^(psql:[^E]*)?ERROR: +//'; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
mkjwt() { local h p s; h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '{"role":"authenticated","iss":"supabase","aud":"authenticated","exp":%s,"sub":"%s","aal":"%s"}' "$(( $(date +%s) + 7200 ))" "$1" "${2:-aal1}" | b64url)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$PHF_ISO_JWT_SECRET" -binary | b64url); printf '%s.%s.%s' "$h" "$p" "$s"; }
v7at() { python3 -I -c "import os,sys,time; ms=int((time.time()+float(sys.argv[1]))*1000); b=bytearray(ms.to_bytes(6,'big')+os.urandom(10)); b[6]=(b[6]&0x0f)|0x70; b[8]=(b[8]&0x3f)|0x80; h=b.hex(); print(f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}')" "$1"; }
v7() { v7at 0; }
v4() { python3 -I -c "import uuid; print(uuid.uuid4())"; }
AUTH() { AUTH_PGHOST=127.0.0.1 python3 -I "$TOOLS/authority.py" "$1" "$OUT/auth" "$OUT/mirror" $DB 3600 2>&1; }
GATE() { local n; n=$(python3 -I "$TOOLS/gate.py" --issue-nonce --pub "$OUT/auth/authority.pub"); python3 -I "$TOOLS/authority.py" attest "$OUT/auth" "$OUT/mirror" "$n" "$OUT/att.json" >/dev/null 2>&1
  GATE_PGHOST=127.0.0.1 python3 -I "$TOOLS/gate.py" --db $DB --pub "$OUT/auth/authority.pub" --copy authority:"$OUT/mirror/series" --attest "$OUT/att.json" --nonce "$n" 2>&1; }
runner() { ( cd "$ROOT" && APPLY_MIGRATIONS_TEST_CONTAINER=$DB bash deploy/lucashome/apply-migrations.sh "$@" 2>&1 ); }
ST="$STK/state.json"
for i in 0 1; do eval "ORG$i=\$(jq -r '.orgs[$i].org' $ST); SHOP$i=\$(jq -r '.orgs[$i].shop' $ST); CASH$i=\$(jq -r '.orgs[$i].users.cashA' $ST); ADM$i=\$(jq -r '.orgs[$i].users.admin' $ST)"; done
for v in CASH0 CASH1 ADM0 ADM1; do eval "AUTH_$v=\$(q \"select auth_id from users where id = '\$$v'\")"; done
J_CASH0=$(mkjwt "$AUTH_CASH0"); J_CASH1=$(mkjwt "$AUTH_CASH1"); J_ADM0_1=$(mkjwt "$AUTH_ADM0" aal1)
J_ADM0=$(mkjwt "$AUTH_ADM0" aal2); J_ADM1=$(mkjwt "$AUTH_ADM1" aal2)
sale_args() { local i=$1 shop cash prod; eval "shop=\$SHOP$i; cash=\$CASH$i"
  prod=$(jq -r ".orgs[$i].replay.sale.args.p_items[0].product_id" $ST)
  q "update inventory set qty_base_units = 1000000 where shop_id = '$shop' and product_id = '$prod'" >/dev/null
  jq -c --arg s "$(q "select id from shifts where cashier_id = '$cash' and ended_at is null limit 1")" ".orgs[$i].replay.sale.args | .p_shift_id = \$s | .p_created_at = null" $ST; }
ARGS0=$(sale_args 0); ARGS1=$(sale_args 1)

PASS=0; FAIL=0; : > "$OUT/fixtures.jsonl"; GW="$PHF_ISO_URL"
call() {  # JWT METHOD PATH BODY [EPOCH-HEADER]
  local jwt=$1 key=$PHF_ISO_ANON_KEY; [ "$jwt" = SERVICE ] && { jwt=$PHF_ISO_SERVICE_KEY; key=$PHF_ISO_SERVICE_KEY; }
  ST_=$(curl -s -D "$OUT/h.txt" -o "$OUT/b.txt" -w '%{http_code}' -X "$2" "$GW/rest/v1/$3" -H "apikey: $key" -H "Authorization: Bearer $jwt" \
        -H 'Content-Type: application/json' -H 'Prefer: return=representation' ${5:+-H "x-orvix-epoch: $5"} -d "$4")
  BODY_=$(head -c 500 "$OUT/b.txt" | tr '\n' ' '); CT_=$(grep -i '^content-type' "$OUT/h.txt" | tr -d '\r' | cut -d' ' -f2- | cut -d';' -f1); }
cap() { jq -nc --arg id "$1" --arg ct "$CT_" --argjson st "$ST_" --rawfile b "$OUT/b.txt" '{id:$id,status:$st,contentType:$ct,body:$b}' >> "$OUT/fixtures.jsonl"; }
res() { if [ "$1" = ok ]; then PASS=$((PASS+1)); printf 'PASS %-84s %s\n' "$2" "$3"; else FAIL=$((FAIL+1)); printf 'FAIL %-84s %s\n' "$2" "$3"; fi; }
chk()  { if [ "$ST_" = "$2" ] && grep -qE -- "$3" <<<"$BODY_"; then res ok "$1" "HTTP $ST_ $(cut -c1-130 <<<"$BODY_")"; else res no "$1" "HTTP $ST_ $(cut -c1-200 <<<"$BODY_")"; fi; }
# chkv never passes on empty output unless the expectation is exactly '^$'
chkv() { local v; v=$(tr '\n' ' ' <<<"$3" | sed -E 's/ +$//'); if { [ -n "$v" ] || [ "$2" = '^$' ]; } && grep -qE -- "$2" <<<"$v"; then res ok "$1" "$(cut -c1-130 <<<"$v")"; else res no "$1" "[$(cut -c1-200 <<<"$v")]"; fi; }
ctx() { jq -nc --arg t "$1" --arg s "$2" --arg e "$3" --argjson w "${4:-null}" '{till:$t,till_secret:$s,op_epoch:$e,witness:$w}'; }
v87() { call "$1" POST rpc/op_execute_v87 "$(jq -nc --arg k "$2" --argjson a "$3" --arg u "$4" --argjson c "$5" '{p_key:$k,p_rpc:"complete_sale",p_args:$a,p_actor_id:$u,p_ctx:$c}')"; }
fence() { call "$1" POST rpc/op_status_v87 "$(jq -nc --arg k "$2" --arg r "${6:-complete_sale}" --arg u "$4" --argjson a "$3" --argjson c "$5" '{p_key:$k,p_rpc:$r,p_fence:true,p_expected_actor_id:$u,p_args:$a,p_ctx:$c}')"; }
opx() { call "$1" POST rpc/op_execute "$(jq -nc --arg k "$2" --argjson a "$3" --arg u "$4" '{p_key:$k,p_rpc:"complete_sale",p_args:$a,p_actor_id:$u}')"; }
direct() { call "$1" POST rpc/complete_sale "$(jq -c --arg k "$3" '. + {p_idempotency_key: (if $k == "null" then null else $k end)}' <<<"$2")"; }
cat_ins() { call "$1" POST categories "$(jq -nc --arg o "$2" --arg n "$3" '{id:("zz-"+$n),name:$n,color:"#000000",org_id:$o}')" "${4:-}"; }
epoch_of() { call "$1" POST rpc/recovery_epoch "$(jq -nc --argjson c "$2" '{p_ctx:$c}')"; }
journal() { call "$1" POST rpc/recovery_submit_journal "$(jq -nc --argjson c "$2" --argjson n "$3" --argjson p "$4" --argjson f "$5" '{p_ctx:$c,p_chunk_no:$n,p_chunk:$p,p_final:$f}')"; }
propose() { call "$J_ADM0" POST rpc/recovery_propose_decision "$(jq -nc --arg k "$1" --arg u "$CASH0" --argjson a "$2" --arg t "${3:-till-A1}" --arg d "${4:-fence}" \
  '{p_key:$k,p_rpc:"complete_sale",p_args:$a,p_actor_id:$u,p_op_epoch_no:0,p_till:$t,p_decision:$d}')"; }
ledger_has() { q "select count(*) from idempotency_keys where key = '$1'"; }

{
echo "== 087 stack suite: $(q 'select max(version) from supabase_migrations.schema_migrations') before install; orgs A=${ORG0:0:14} B=${ORG1:0:14}"
echo; echo "---- 0 install through the real runner, coverage gate"
bash "$HERE/lib/reserve-recovery-roles.sh" phf-iso-db > "$OUT/reserve-roles.log" || { echo "reserve-recovery-roles failed"; exit 1; }   # the host prerequisite (v87.x)
runner --from 087 --to 087 > "$OUT/apply-087.log"; chkv "I0 apply-migrations.sh --from 087 --to 087: committed + recorded" 'COMMITTED.*newest 087' "$(grep -E 'COMMITTED|ledger now' "$OUT/apply-087.log")"
docker exec -i $DB psql -X -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 < "$HERE/sql/test-helpers.sql" > "$OUT/helpers.log" 2>&1 || { echo "test helpers failed"; exit 1; }
chkv "G1 every public table with an org-scoping column is guarded (not: phone_upload_org_rate, the canary)" '^0$' "$(q "select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname in ('org_id','shop_id','sale_id','product_id','supplier_id','from_shop_id','purchase_order_id','transfer_id') and not a.attisdropped)
  and c.relname not in ('phone_upload_org_rate', 'zz_recovery_canary')
  and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'zz_recovery_guard' and t.tgenabled = 'A')")"
chkv "G1b every guarded table also has an ALWAYS truncate guard; 32 guards; 33 fingerprints (+ canary); 8 functions" '^0\|32\|33\|8$' "$(q "select (select count(*) from pg_trigger g where g.tgname = 'zz_recovery_guard' and not exists (select 1 from pg_trigger t where t.tgrelid = g.tgrelid and t.tgname = 'zz_recovery_truncate' and t.tgenabled = 'A')) || '|' || (select count(*) from pg_trigger where tgname = 'zz_recovery_guard' and tgenabled = 'A') || '|' || (select count(*) from recovery_guard.snapshot) || '|' || (select count(*) from recovery_guard.functions)")"
chkv "G2 recovery.executor_rpcs equals 086's op_spec allow-list" '^29\|0$' "$(q "with s as (select distinct p.proname::text r from pg_proc p where p.pronamespace = 'public'::regnamespace and (select x.v_names from public.op_spec(p.proname) x) is not null) select (select count(*) from s) || '|' || (select count(*) from (select r from s except select rpc from recovery.executor_rpcs union all select rpc from recovery.executor_rpcs except select r from s) d)")"
chkv "G3 no non-ASCII byte in any 087 function body" '^0$' "$(q "select count(*) from pg_proc where (pronamespace = 'recovery'::regnamespace or proname like '%\_v87' or proname like 'recovery\_%') and prosrc ~ '[^[:ascii:]]'")"
chkv "G4 the migration ships no test helper" '^0$' "$(grep -c 'zz_test' "$ROOT/supabase/migrations/087_recovery_hold.sql")"
chkv "G5 every refusal uses the fixed ASCII contract" '^1$' "$(q "select count(*) from pg_proc where oid = 'recovery.refuse(text)'::regprocedure and prosrc like '%PT429%ORG_SUSPENDED: server recovery in progress [%'")"
chkv "G6 installed held: state hold, no valid lease, chain backfilled = ledger" '^hold\|f\|t$' "$(q "select (select state from recovery.continuity) || '|' || recovery.lease_ok()::text || '|' || ((select count(*) from recovery.chain_log) = (select count(*) from idempotency_keys where org_id <> '!unattributed'))::text" | sed 's/false/f/; s/true/t/')"

echo; echo "---- 1 held install: anchor + authority genesis + two-person open"
opx "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0"; chk "I1 right after install: Phase-0 op_execute refused (no lease)" 429 'ORG_SUSPENDED.*LEASE_INVALID'; cap F429_LEASE
call SERVICE POST categories "$(jq -nc --arg o "$ORG0" '{id:"zz-svc-0",name:"svc0",color:"#000000",org_id:$o}')"; chk "I1b service_role write refused too" 429 'LEASE_INVALID'
$OPENSSL genpkey -algorithm ed25519 -out "$OUT/auth/authority.key" 2>/dev/null; chmod 600 "$OUT/auth/authority.key"; $OPENSSL pkey -in "$OUT/auth/authority.key" -pubout -out "$OUT/auth/authority.pub"
chkv "I2 authority genesis before the owner anchor: refused by the DB" 'REFUSED ANCHOR_REQUIRED' "$(AUTH genesis)"; rm -rf "$OUT/auth/series" "$OUT/mirror/series"
chkv "I2b owner anchor needs two different people" 'TWO_PEOPLE_REQUIRED' "$(qe "select recovery.owner_anchor('install', 'alice', 'Alice ')")"
chkv "I2c owner anchor from a non-superuser session" 'permission denied|OWNER_ONLY' "$(qpg "select recovery.owner_anchor('install', 'alice', 'bob')")"
q "select recovery.owner_anchor('install', 'alice', 'bob')" >/dev/null
chkv "I3 genesis after the anchor: signed intent, renewal, confirmation" 'genesis lease=RENEWED' "$(AUTH genesis)"
call SERVICE POST categories "$(jq -nc --arg o "$ORG0" '{id:"zz-svc-1",name:"svc1",color:"#000000",org_id:$o}')"; chk "I3b lease valid but state hold: still refused" 429 'RECOVERY_HOLD'
chkv "I4 open by one person refused" 'TWO_PEOPLE_REQUIRED' "$(qe "select recovery.owner_open('alice', 'alice')")"
chkv "I4b open from a non-superuser session (postgres) refused" 'permission denied|OWNER_ONLY' "$(qpg "select recovery.owner_open('alice', 'bob')")"
q "select recovery.owner_open('alice', 'bob')" >/dev/null
call "$J_ADM0" POST rpc/recovery_approve_decision '{"p_id":1}'; chk "A1 the API has no decision-approval function (M2: approval is owner-only)" 404 'PGRST202|Could not find'
chkv "A1b a minted aal2 JWT session (service tier / JWT_SECRET holder) cannot call the owner approval" 'permission denied' "$(qerr supabase_admin "begin; set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$AUTH_ADM0\",\"role\":\"authenticated\",\"aal\":\"aal2\"}', true); select recovery.owner_approve_decision(1, gen_random_uuid(), 'complete_sale', '{}', 'x', 0, 't', 'a', 'b'); rollback")"
chkv "A1c service_role cannot call it either" 'permission denied' "$(qerr supabase_admin "begin; set local role service_role; select recovery.owner_approve_decision(1, gen_random_uuid(), 'complete_sale', '{}', 'x', 0, 't', 'a', 'b'); rollback")"
chkv "A1d postgres (non-superuser table owner) cannot call it" 'permission denied|OWNER_ONLY' "$(qpg "select recovery.owner_approve_decision(1, gen_random_uuid(), 'complete_sale', '{}', 'x', 0, 't', 'a', 'b')")"
chkv "A1e no API role can write the decisions table" 'permission denied' "$(qerr supabase_admin "begin; set local role service_role; update recovery.decisions set approved_at = now(); rollback")"

echo; echo "---- 2 tills and legacy closure at install"
call "$J_CASH0" POST rpc/recovery_register_till '{"p_till":"till-A1"}'; chk "T1 cashier cannot register a till" 403 'RECOVERY_ADMIN_MFA_REQUIRED'
call "$J_ADM0_1" POST rpc/recovery_register_till '{"p_till":"till-A1"}'; chk "T2 admin without MFA (aal1) cannot register a till" 403 'RECOVERY_ADMIN_MFA_REQUIRED'
call "$J_ADM0" POST rpc/recovery_register_till '{"p_till":"till-A1"}'; chk "T3 MFA admin registers till-A1 (secret shown once)" 200 'till_secret'; SEC_A1=$(jq -r .till_secret "$OUT/b.txt")
call "$J_ADM0" POST rpc/recovery_register_till '{"p_till":"till-A2"}'; SEC_A2=$(jq -r .till_secret "$OUT/b.txt")
call "$J_ADM0" POST rpc/recovery_register_till '{"p_till":"till-A3"}'; SEC_A3=$(jq -r .till_secret "$OUT/b.txt")
call "$J_ADM1" POST rpc/recovery_register_till '{"p_till":"till-B1"}'; SEC_B1=$(jq -r .till_secret "$OUT/b.txt")
chkv "T3b only the secret's hash is stored" '^0\|1$' "$(q "select (select count(*) from recovery.tills where secret_hash = '$SEC_A1') || '|' || (select count(*) from recovery.tills where secret_hash = encode(sha256(convert_to('$SEC_A1', 'UTF8')), 'hex'))")"
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; chk "T4a a NEW till is unreconciled: no epoch yet" 429 'TILL_NOT_RECONCILED'
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 1 '{"records":[]}' true >/dev/null
call "$J_CASH0" POST rpc/recovery_approve_till '{"p_till":"till-A1"}'; chk "T4b the cashier who uploaded cannot approve (not an MFA admin)" 403 'MFA_REQUIRED'
call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A1"}'; chk "T4c the org's MFA ADMIN (not the submitter) approves the new till" 200 'reconciled_epoch_no'
journal "$J_CASH1" "$(ctx till-B1 "$SEC_B1" x)" 1 '{"records":[]}' true >/dev/null; call "$J_ADM1" POST rpc/recovery_approve_till '{"p_till":"till-B1"}' >/dev/null
journal "$J_CASH0" "$(ctx till-A3 "$SEC_A3" x)" 1 '{"records":[]}' true >/dev/null; call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A3"}' >/dev/null
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; chk "T4 reconciled till of an open org gets the current epoch + signed witness" 200 '"epoch".*"witness"|"witness".*"epoch"'
E0A=$(jq -r .epoch "$OUT/b.txt"); W_A=$(jq -c .witness "$OUT/b.txt")
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 2 '{"records":[{"key":"k"}]}' true; chk "T5 a reconciled till's journal is not accepted (a lease-only hold cannot quarantine its sales)" 200 'not_required'
epoch_of "$J_CASH1" "$(ctx till-B1 "$SEC_B1" x)"; E0B=$(jq -r .epoch "$OUT/b.txt"); W_B=$(jq -c .witness "$OUT/b.txt")
K=$(v7); v87 "$J_CASH0" "$K" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W_A")"; chk "O1 v87 sale (till-A1, current epoch, witness): committed + signed reply" 200 '"committed"'
chkv "O1b signed reply binds org, key, rpc, request_hash, actor, epoch_no" 'actor.*epoch_no.*request_hash' "$(jq -c .signed "$OUT/b.txt")"
chkv "O1c reply carries a signed witness" '"mac".*"epoch_no"|"epoch_no".*"mac"' "$(jq -c .witness "$OUT/b.txt")"
chkv "O1d the reply witness already covers THIS operation" '^([0-9]+)\|\1$' "$(jq -r .witness.n "$OUT/b.txt")|$(q "select n from recovery.org_chain where org_id = '$ORG0'")"
K=$(v7); v87 "$J_CASH0" "$K" "$(jq -c '.p_paid_mmk = 1' <<<"$ARGS0")" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W_A")"
chk "O1e an operation the RPC rejects: definitive {outcome: rejected}, signed (a guard refusal is never recorded as rejected)" 200 '"outcome": "rejected".*"sig"|"sig".*"outcome": "rejected"'
chkv "O1f ... recorded once in the ledger and chained" '^rejected\|1$' "$(q "select state || '|' || (select count(*) from recovery.chain_log where org_id = '$ORG0' and p like '%$K%') from idempotency_keys where key = '$K'")"
opx "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0"; chk "O2 Phase 0 / Batch 2A 4-arg op_execute: refused at install" 429 'CLIENT_UPGRADE_REQUIRED'; cap F429_UPGRADE
direct "$J_CASH0" "$ARGS0" "$(v4)"; chk "O3 RC3 direct complete_sale with key: refused" 429 'CLIENT_UPGRADE_REQUIRED'
direct "$J_CASH0" "$ARGS0" null; chk "O4 v1.0.15 keyless complete_sale: refused (by 086)" 400 'IDEMPOTENCY_KEY_REQUIRED'
cat_ins "$J_ADM0" "$ORG0" "legacycat"; chk "O5 legacy catalogue write (no epoch header): refused" 429 'CLIENT_UPGRADE_REQUIRED'; cap F429_TABLE
cat_ins "$J_ADM0" "$ORG0" "v87cat" "$E0A"; chk "O5b same write with the epoch header: allowed" 201 'v87cat'
call SERVICE POST categories "$(jq -nc --arg o "$ORG0" '{id:"zz-svc-2",name:"svc2",color:"#000000",org_id:$o}')"; chk "O6 service_role (edge functions) write without header: allowed while open" 201 'svc2'
call SERVICE PATCH "idempotency_keys?org_id=eq.$ORG0" '{"outcome_message":"tamper"}'; chk "O6b service_role ledger UPDATE: no privilege" 403 '42501|permission denied'
v87 "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0" "$(ctx till-A1 wrong-secret "$E0A" "$W_A")"; chk "O7 wrong till secret" 429 'TILL_UNKNOWN'
v87 "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A")"; chk "O7b no witness" 429 'TILL_NOT_RECONCILED'
v87 "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "" "$W_A")"; chk "O7c no op epoch (a legacy queue entry): never executed" 429 'PRE_EPOCH_OPERATION'
v87 "$J_CASH1" "$(v7)" "$ARGS1" "$CASH1" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W_A")"; chk "O7d org-B user presenting org-A till + witness" 429 'TILL_UNKNOWN|WITNESS_INVALID'

echo; echo "---- 3 multi-tenant: hold B; A and NEW tenants unaffected on every path"
q "select recovery.owner_hold_org('$ORG1', 'tenant isolation test')" >/dev/null
K=$(v7); v87 "$J_CASH0" "$K" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W_A")"; chk "MT1 A: v87 sale while B is held" 200 'committed'
cat_ins "$J_ADM0" "$ORG0" "m1cat" "$E0A"; chk "MT1b A: catalogue write while B is held" 201 'm1cat'
v87 "$J_CASH1" "$(v7)" "$ARGS1" "$CASH1" "$(ctx till-B1 "$SEC_B1" "$E0B" "$W_B")"; chk "MT2 B: v87 refused (held)" 429 'RECOVERY_HOLD'; cap F429_HOLD_V87
call SERVICE POST categories "$(jq -nc --arg o "$ORG1" '{id:"zz-svc-b",name:"svcb",color:"#000000",org_id:$o}')"; chk "MT2b B: service_role write refused" 429 'RECOVERY_HOLD'
cat_ins "$J_ADM1" "$ORG1" "bcat" "$E0B"; chk "MT2c B: admin catalogue write refused" 429 'RECOVERY_HOLD'
q "update recovery.settings set legacy_paths = 'open'" >/dev/null   # TEST KNOB: lets the legacy-path DR seed run (087 installs 'closed')
( cd "$ROOT" && E2E_SUPABASE_URL="$PHF_ISO_URL" E2E_ANON_KEY="$PHF_ISO_ANON_KEY" E2E_SERVICE_KEY="$PHF_ISO_SERVICE_KEY" \
  E2E_DB_CONTAINER=$DB E2E_LOOPBACK_ONLY=1 DR_LIVE=1 DR_STATE="$OUT/seed2.json" npx vitest run src/live/dr-seed.live.test.ts 2>&1 | sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g' ) > "$OUT/seed2.log"
q "update recovery.settings set legacy_paths = 'closed'" >/dev/null
chkv "MT3 full DR seed (2 NEW tenants: shift, sales, stock, POs, supplier payments, void, lump sum, op_execute, fence, storage) while B is held" 'Tests +1 passed' "$(grep -E 'Tests ' "$OUT/seed2.log")"
ORGC=$(jq -r '.orgs[0].org' "$OUT/seed2.json" 2>/dev/null)
UNRES=$(docker exec -i $DB psql -X -U supabase_admin -d postgres -At -c "DO \$c\$ DECLARE t text; n bigint; tot bigint; bad bigint := 0; rows bigint := 0; BEGIN
  FOR t IN SELECT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = 'zz_recovery_guard' AND c.relname NOT IN ('app_config','platform_admins') LOOP
    EXECUTE format('SELECT count(*) FILTER (WHERE cardinality(recovery.org_of(%L, to_jsonb(x))) = 0), count(*) FROM public.%I x', t, t) INTO n, tot;
    bad := bad + n; rows := rows + tot; END LOOP; RAISE NOTICE 'unresolved % of % rows', bad, rows; END \$c\$" 2>&1 | grep -o 'unresolved.*')
chkv "MT4 every row of every guarded table (incl. the new tenants) resolves to an organisation" '^unresolved 0 of [1-9]' "$UNRES"
ISO=$(docker exec -i $DB psql -X -U supabase_admin -d postgres -At -c "BEGIN; DO \$c\$ DECLARE t text; r record; okA bigint := 0; badA bigint := 0; refB bigint := 0; leakB bigint := 0; o text[]; BEGIN
  FOR t IN SELECT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgname = 'zz_recovery_guard' AND c.relname NOT IN ('app_config','platform_admins','idempotency_keys') LOOP
    FOR r IN EXECUTE format('SELECT ctid AS c, to_jsonb(x) AS j FROM public.%I x', t) LOOP
      o := recovery.org_of(t, r.j);
      BEGIN
        EXECUTE format('UPDATE public.%I SET %I = %I WHERE ctid = %L', t, (SELECT attname FROM pg_attribute WHERE attrelid = ('public.' || t)::regclass AND attnum = 1),
                       (SELECT attname FROM pg_attribute WHERE attrelid = ('public.' || t)::regclass AND attnum = 1), r.c);
        IF '$ORG1' = ANY (o) THEN leakB := leakB + 1; ELSE okA := okA + 1; END IF;
      EXCEPTION WHEN SQLSTATE 'PT429' THEN
        IF '$ORG1' = ANY (o) THEN refB := refB + 1; ELSE badA := badA + 1; END IF;
      WHEN OTHERS THEN NULL;   -- unrelated business-rule triggers (e.g. user privilege guards)
      END;
    END LOOP; END LOOP;
  RAISE NOTICE 'other-org rows writable % refused %; held-org rows refused % LEAKED %', okA, badA, refB, leakB; END \$c\$; ROLLBACK;" 2>&1 | grep -o 'other-org.*')
chkv "MT5 row-by-row UPDATE of EVERY guarded row with B held (rolled back): no other-org row refused, no B row writable" 'writable [1-9][0-9]* refused 0; held-org rows refused [1-9][0-9]* LEAKED 0$' "$ISO"

PROD0=$(q "select id from products where org_id = '$ORG0' limit 1")
chkv "MT6 a transfer item on a transfer INTO the held org (from an open org's shop) is refused (rolled back)" 'RECOVERY_HOLD' "$(qerr supabase_admin "begin; alter table public.stock_transfers disable trigger zz_recovery_guard; insert into public.stock_transfers (id, transfer_no, from_shop_id, to_shop_id, status, created_by) values ('zz-mt6', 'ZZ-MT6', '$SHOP0', '$SHOP1', 'pending', '$ADM0'); alter table public.stock_transfers enable always trigger zz_recovery_guard; insert into public.stock_transfer_items (id, transfer_id, product_id, requested_qty) values ('zz-mt6-i', 'zz-mt6', '$PROD0', 1); rollback")"

echo; echo "---- 4 committed hold (till witness ahead) + forged witness"
FORGED=$(jq -c '.n = 999' <<<"$W_A")
v87 "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$FORGED")"; chk "C1 forged witness (field edited): refused, nothing held" 429 'WITNESS_INVALID'
chkv "C1b A not held" '^f$' "$(q "select held from recovery.org_state where org_id = '$ORG0'")"
NA=$(q "select n from recovery.org_chain where org_id = '$ORG0'")
AHEAD=$(q "select recovery.zz_test_witness('$ORG0', $NA + 3, repeat('ab', 32), (select epoch_no from recovery.org_state where org_id = '$ORG0'))")
K=$(v7); v87 "$J_CASH0" "$K" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$AHEAD")"; chk "C2 till witness ahead: HTTP 200 {outcome: held}, signed (v87 functions only)" 200 '"held".*"sig"|"sig".*"held"'; cap F200_HELD_V87
chkv "C2a the held reply carries no epoch" '^false$' "$(jq -c 'has("epoch") or has("epoch_no") or has("witness")' "$OUT/b.txt")"
chkv "C2b A held AND its epoch advanced once (committed, survives the request)" '^t\|1$' "$(q "select held::text || '|' || epoch_no from recovery.org_state where org_id = '$ORG0'" | sed 's/true/t/')"
chkv "C2c the operation did not execute" '^0$' "$(ledger_has "$K")"
K=$(v7); v87 "$J_CASH0" "$K" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$AHEAD")"
chkv "C2d a repeated ahead-witness while held does not advance the epoch again" '^1$' "$(q "select epoch_no from recovery.org_state where org_id = '$ORG0'")"
v87 "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W_A")"; chk "C3 next A write refused" 429 'RECOVERY_HOLD|TILL_NOT_RECONCILED'

echo; echo "---- 5 HIGH-1: no usable epoch while held; offline queues cannot bypass the cutoff"
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; chk "H1a held org: even a till that WAS reconciled gets no epoch" 429 'TILL_NOT_RECONCILED|RECOVERY_HOLD'
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 1 '{"records":[]}' true >/dev/null; call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A1"}' >/dev/null
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; chk "H1b reconciled for the NEW epoch, org still held: refused, no epoch issued" 429 'RECOVERY_HOLD'; cap F429_HELD_EPOCH
chkv "H1c the refusal body carries no epoch" '^false$' "$(jq -c 'has("epoch")' "$OUT/b.txt")"
E1A_REAL=$(q "select epoch from recovery.org_state where org_id = '$ORG0'")
K_OFF1=$(v7); K_OFF2=$(v7); K_OFF3=$(v7)   # sales staged OFFLINE during the hold: stamped with the last epoch the till had, a guess, nothing
q "select recovery.zz_test_release_org('$ORG0')" >/dev/null   # 088 stand-in: release WITHOUT an epoch change
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; chk "H1d after the (088) release the reconciled till gets the epoch" 200 '"epoch"'
E1A=$(jq -r .epoch "$OUT/b.txt"); W1A=$(jq -c .witness "$OUT/b.txt")
chkv "H1e it is the epoch that existed during the hold (release does not change it)" "^$E1A_REAL\$" "$E1A"
v87 "$J_CASH0" "$K_OFF1" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W1A")"; chk "H1f offline sale stamped with the OLD epoch: never executed" 429 'PRE_EPOCH_OPERATION'
v87 "$J_CASH0" "$K_OFF2" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$(v4)" "$W1A")"; chk "H1g offline sale stamped with a GUESSED epoch: never executed" 429 'PRE_EPOCH_OPERATION'
v87 "$J_CASH0" "$K_OFF3" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "" "$W1A")"; chk "H1h offline sale with no epoch: never executed" 429 'PRE_EPOCH_OPERATION'
chkv "H1i none of them is in the ledger" '^0$' "$(q "select count(*) from idempotency_keys where key in ('$K_OFF1', '$K_OFF2', '$K_OFF3')")"
K=$(v7); v87 "$J_CASH0" "$K" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E1A" "$W1A")"; chk "H1j a NEW operation created after the release, with the issued epoch: committed" 200 'committed'

echo; echo "---- 6 M3: ledger evidence cannot be pruned, deleted, truncated or rewritten"
K_PR=$(v7at -$((430*86400)))
q "insert into public.idempotency_keys (key, rpc, actor_id, org_id, request_hash, state, decided_at, created_at) values ('$K_PR', 'zz_m3_rpc', null, '$ORG0', 'm3', 'committed', now() - interval '430 days', now() - interval '430 days')" >/dev/null
chkv "M3a 086 prune_idempotency_keys (owner) on a 14-month-old row: refused, nothing deleted" 'LEDGER_EVIDENCE_PROTECTED' "$(qe "select public.prune_idempotency_keys()")"
chkv "M3b the old row is still there" '^1$' "$(ledger_has "$K_PR")"
chkv "M3c postgres DELETE of a ledger row refused" 'LEDGER_EVIDENCE_PROTECTED' "$(qpg "delete from public.idempotency_keys where key = '$K_PR'")"
chkv "M3d UPDATE of an evidence column (request_hash) refused" 'LEDGER_EVIDENCE_PROTECTED' "$(qe "update public.idempotency_keys set request_hash = request_hash || 'x' where key = '$K_PR'")"
chkv "M3d2 UPDATE of outcome_message (an evidence column) refused" 'LEDGER_EVIDENCE_PROTECTED' "$(qe "update public.idempotency_keys set outcome_message = 'x' where key = '$K_PR'")"
chkv "M3e TRUNCATE of the ledger refused (also for the superuser)" 'LEDGER_EVIDENCE_PROTECTED' "$(qe "truncate public.idempotency_keys")"
K_PR2=$(v7at -$((120*86400)))
q "insert into public.idempotency_keys (key, rpc, actor_id, org_id, request_hash, state, response, decided_at, created_at) values ('$K_PR2', 'zz_m3_rpc', null, '$ORG0', 'm3b', 'committed', '{\"x\":1}', now() - interval '120 days', now() - interval '120 days')" >/dev/null
chkv "M3f 086 response purge still works on an eligible row (response columns only)" '^[1-9][0-9]*\|purged$' "$(qe "select public.op_purge_responses(interval '90 days')")|$(q "select case when response is null and response_purged_at is not null then 'purged' else 'kept' end from idempotency_keys where key = '$K_PR2'")"
chkv "M3g authority after the prune attempt: renews (no outage; ledger = chain)" 'renew lease=RENEWED' "$(AUTH tick)"

echo; echo "---- 7 M1: signed renewal intents; crash recovery; rogue renewals"
chkv "M1a normal tick: intent + renewal + confirmation" 'renew lease=RENEWED' "$(AUTH tick)"
chkv "M1b crash between the renewal and its confirmation" 'simulated crash' "$(AUTH_CRASH_AFTER_RENEW=1 AUTH tick)"
chkv "M1c gate during the crash window: INCONCLUSIVE (lease on an unconfirmed intent)" 'INCONCLUSIVE.*LEASE_ON_UNCONFIRMED_INTENT' "$(GATE)"
chkv "M1d next tick confirms the intent LATE (database unchanged) and renews" 'confirmed LATE.*renew lease=RENEWED' "$(AUTH tick)"
chkv "M1e gate: CONSISTENT" 'VERDICT CONSISTENT' "$(GATE)"
MAXS=$(q "select max_seq from recovery.install")
chkv "M1f the authority credential renews directly (no signed intent): the DB accepts it" '^RENEWED$' "$(docker exec -i $DB psql -X -h 127.0.0.1 -U recovery_authority -d postgres -At -c "select recovery.authority_renew($((MAXS + 1)), 3600, pg_postmaster_start_time(), false, encode(sha256(random()::text::bytea), 'hex'))")"
chkv "M1g gate: CONFLICT ROGUE_RENEWAL" 'CONFLICT.*ROGUE_RENEWAL' "$(GATE)"
chkv "M1h authority: REFUSED ROGUE_RENEWAL, lease revoked, never laundered as a crash" 'REFUSED .*ROGUE_RENEWAL.*lease revoked' "$(AUTH tick)"
call SERVICE POST categories "$(jq -nc --arg o "$ORGC" '{id:"zz-m1",name:"m1",color:"#000000",org_id:$o}')"; chk "M1i writes stop" 429 'LEASE_INVALID'
chkv "M1j it stays refused on the next tick" 'REFUSED .*ROGUE_RENEWAL' "$(AUTH tick)"
q "select recovery.owner_rebaseline('rogue renewal investigated', 'alice', 'bob')" >/dev/null
mv "$OUT/auth/series" "$OUT/auth/series-archived-1"; mv "$OUT/mirror/series" "$OUT/mirror/series-archived-1"
chkv "M1k recovery = two-person re-baseline + archived series + new genesis" 'genesis lease=RENEWED' "$(AUTH genesis)"
call SERVICE POST categories "$(jq -nc --arg o "$ORGC" '{id:"zz-m1b",name:"m1b",color:"#000000",org_id:$o}')"; chk "M1l writes resume" 201 'm1b'
chkv "M1m the authority crashes after signing an intent, before renewing" 'simulated crash before the renewal' "$(AUTH_CRASH_AFTER_INTENT=1 AUTH tick)"
SEQM=$(ls "$OUT/auth/series" | tail -1 | sed 's/^0*//; s/\.json$//')
chkv "M1n the credential holder renews under that SIGNED seq ($SEQM) with its own token: the DB accepts it" '^RENEWED$' "$(docker exec -i $DB psql -X -h 127.0.0.1 -U recovery_authority -d postgres -At -c "select recovery.authority_renew($SEQM, 3600, pg_postmaster_start_time(), false, encode(sha256(random()::text::bytea), 'hex'))")"
chkv "M1o gate: CONFLICT ROGUE_RENEWAL (the lease token is not the intent's)" 'CONFLICT.*ROGUE_RENEWAL.*one-time token' "$(GATE)"
M1P=$(AUTH tick)
chkv "M1p authority: REFUSED ROGUE_RENEWAL, lease revoked; NOT laundered as a late confirmation (DR H1)" 'REFUSED .*ROGUE_RENEWAL.*lease revoked' "$M1P"
chkv "M1q ... no late confirmation was written" '^0$' "$(grep -c 'confirmed LATE' <<<"$M1P")"
q "select recovery.owner_rebaseline('laundering attempt investigated', 'alice', 'bob')" >/dev/null
mv "$OUT/auth/series" "$OUT/auth/series-archived-2"; mv "$OUT/mirror/series" "$OUT/mirror/series-archived-2"
chkv "M1r recovery: re-baseline + new genesis" 'genesis lease=RENEWED' "$(AUTH genesis)"

echo; echo "---- 8 M4: unreadable / unverifiable evidence fails closed"
q "revoke execute on function recovery.authority_observe() from recovery_authority" >/dev/null
chkv "M4a observe unreadable on a reachable DB: signed refusal, lease revoked, no renewal" 'REFUSED EVIDENCE_UNREADABLE.*lease revoked' "$(AUTH tick)"
call SERVICE POST categories "$(jq -nc --arg o "$ORGC" '{id:"zz-m4",name:"m4",color:"#000000",org_id:$o}')"; chk "M4b writes refused" 429 'LEASE_INVALID'
chkv "H1k (HIGH-1) org NOT held, till reconciled, server not writable (lease revoked): no epoch" '^f\|([0-9]+)\|\1$' "$(q "select (select held from recovery.org_state where org_id = '$ORG0')::text || '|' || (select reconciled_epoch_no from recovery.tills where org_id = '$ORG0' and till_id = 'till-A1') || '|' || (select epoch_no from recovery.org_state where org_id = '$ORG0')" | sed 's/false/f/')"
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; chk "H1k2 ... recovery_epoch refuses with LEASE_INVALID and no epoch in the body" 429 'LEASE_INVALID'
q "grant execute on function recovery.authority_observe() to recovery_authority" >/dev/null
chkv "M4c evidence readable again: renews" 'renew lease=RENEWED' "$(AUTH tick)"
q "revoke execute on function recovery.authority_hash_at(text, bigint) from recovery_authority" >/dev/null
chkv "M4d chain lookup fails mid-tick: signed refusal, lease revoked" 'REFUSED AUTHORITY_ERROR.*lease revoked' "$(AUTH tick)"
q "grant execute on function recovery.authority_hash_at(text, bigint) to recovery_authority" >/dev/null
AUTH tick >/dev/null; VU=$(q "select valid_until from recovery.lease")
chkv "M4e database unreachable: 'unreachable' record, no renewal" 'UNREACHABLE' "$(AUTH_PSQL='docker exec -i phf-iso-no-such-container psql' AUTH_PGHOST=127.0.0.1 python3 -I "$TOOLS/authority.py" tick "$OUT/auth" "$OUT/mirror" $DB 3600 2>&1)"
chkv "M4f the valid lease was not extended by that tick (valid_until unchanged)" '^t\|t$' "$(q "select (valid_until = '$VU'::timestamptz)::text || '|' || recovery.lease_ok()::text from recovery.lease" | sed 's/true/t/g')"
chkv "M4g next tick with readable evidence renews" 'renew lease=RENEWED' "$(AUTH tick)"
CL0=$(jq -nc --arg s "$AUTH_CASH0" '{sub:$s,role:"authenticated",aal:"aal1"}')
chkv "H1l (HIGH-1) valid lease, org NOT held, server state 'hold' (rolled back): no epoch" 'RECOVERY_HOLD' "$(qerr supabase_admin "begin; update recovery.continuity set state = 'hold'; set local role authenticated; select set_config('request.jwt.claims', \$j\$$CL0\$j\$, true); select public.recovery_epoch(\$c\$$(ctx till-A1 "$SEC_A1" x)\$c\$::jsonb); rollback")"
chkv "H1m (HIGH-1) valid lease, org NOT held, identity changed (rolled back): no epoch" 'IDENTITY_CHANGED' "$(qerr supabase_admin "begin; update recovery.continuity set timeline = timeline + 1; set local role authenticated; select set_config('request.jwt.claims', \$j\$$CL0\$j\$, true); select public.recovery_epoch(\$c\$$(ctx till-A1 "$SEC_A1" x)\$c\$::jsonb); rollback")"
chkv "M4h gate as recovery_gate without an attestation is never CONSISTENT" 'INCONCLUSIVE.*NO_FRESH_ATTESTATION' "$(GATE_PGHOST=127.0.0.1 python3 -I "$TOOLS/gate.py" --db $DB --pub "$OUT/auth/authority.pub" --copy authority:"$OUT/mirror/series" 2>&1)"

echo; echo "---- 9 privilege boundaries (postgres = table owner, non-superuser)"
chkv "P1 no SECURITY DEFINER 087 function calls a function outside schema recovery" '^0$' "$(q "select count(*) from pg_proc p where (p.pronamespace = 'recovery'::regnamespace or p.proname like '%\_v87' or p.proname like 'recovery\_%') and p.proname not like 'zz\_test\_%' and p.prosecdef and p.prosrc ~ '(^|[^a-z_])(public|extensions|auth|vault|pgsodium)\.[a-z_]+\('")"
chkv "P1x schema recovery and all its objects: recovery_owner; schema recovery_guard and all its objects: supabase_admin (superuser)" '^recovery_owner\|0\|supabase_admin\|0$' "$(q "select (select nspowner::regrole::text from pg_namespace where nspname = 'recovery') || '|' || ((select count(*) from pg_class where relnamespace = 'recovery'::regnamespace and relowner <> 'recovery_owner'::regrole) + (select count(*) from pg_proc where pronamespace = 'recovery'::regnamespace and proowner <> 'recovery_owner'::regrole and proname not like 'zz\_test\_%')) || '|' || (select nspowner::regrole::text from pg_namespace where nspname = 'recovery_guard') || '|' || ((select count(*) from pg_class where relnamespace = 'recovery_guard'::regnamespace and relowner <> 'supabase_admin'::regrole) + (select count(*) from pg_proc where pronamespace = 'recovery_guard'::regnamespace and proowner <> 'supabase_admin'::regrole))")"
chkv "P1b every 087 function pins search_path = pg_catalog, pg_temp" '^0$' "$(q "select count(*) from pg_proc p where (p.pronamespace = 'recovery'::regnamespace or p.proname like '%\_v87' or p.proname like 'recovery\_%') and not coalesce(p.proconfig, '{}') @> '{\"search_path=pg_catalog, pg_temp\"}'")"
chkv "P1c recovery_owner is not a superuser and cannot log in" '^f\|f$' "$(q "select rolsuper::text || '|' || rolcanlogin::text from pg_roles where rolname = 'recovery_owner'" | sed 's/false/f/g')"
OLDDEF=$(q "select pg_get_functiondef('public.op_caller'::regproc)")
docker exec -i $DB psql -X -U postgres -d postgres -q -c "create or replace function public.op_caller(out v_actor text, out v_org text, out v_role text) language plpgsql stable security definer set search_path to 'pg_catalog', 'pg_temp' as \$x\$ begin update recovery.org_state set held = false; select u.id, u.org_id, upper(u.role) into v_actor, v_org, v_role from public.users u where u.auth_id = auth.uid() and u.is_active limit 1; end \$x\$" >/dev/null 2>&1
v87 "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E1A" "$W1A")" ; v87 "$J_CASH1" "$(v7)" "$ARGS1" "$CASH1" "$(ctx till-B1 "$SEC_B1" "$E0B" "$W_B")"
chkv "P2 postgres replaced 086 op_caller with a hold-clearing body: B is still held" '^t$' "$(q "select held from recovery.org_state where org_id = '$ORG1'")"
docker exec -i $DB psql -X -U postgres -d postgres -q -c "$OLDDEF" >/dev/null 2>&1
chkv "P3 postgres: decoy BEFORE trigger on a guarded table" 'RECOVERY_GUARD_PROTECTED' "$(qpg "create trigger zz_decoy before insert on public.categories for each row execute function public.set_org_id_from_caller()")"
chkv "P3b postgres: DISABLE the guard" 'RECOVERY_GUARD_PROTECTED' "$(qpg "alter table public.categories disable trigger zz_recovery_guard")"
chkv "P3c postgres: DISABLE under replica role" 'RECOVERY_GUARD_PROTECTED' "$(qpg "set session_replication_role = replica; alter table public.categories disable trigger zz_recovery_guard")"
chkv "P4 postgres: child table INHERITS a guarded table" 'RECOVERY_GUARD_PROTECTED' "$(qpg "create table public.zz_child () inherits (public.sales)")"
chkv "P5 postgres: rename a guarded table" 'RECOVERY_GUARD_PROTECTED' "$(qpg "alter table public.sales rename to sales_x")"
chkv "P6 postgres: rule on a guarded table" 'RECOVERY_GUARD_PROTECTED' "$(qpg "create rule zz_r as on insert to public.categories do instead nothing")"
chkv "P6b postgres: ALTER COLUMN TYPE ... USING (rewrites data, no row trigger)" 'RECOVERY_GUARD_PROTECTED' "$(qpg "alter table public.categories alter column name type text using name || 'x'")"
chkv "P6c postgres: RENAME COLUMN org_id on shops (redirect org resolution)" 'RECOVERY_GUARD_PROTECTED' "$(qpg "alter table public.shops rename column org_id to org_id_old")"
chkv "P6d postgres: ADD COLUMN" 'RECOVERY_GUARD_PROTECTED' "$(qpg "alter table public.shops add column zz int default 1")"
chkv "P6e postgres: CREATE INDEX on a guarded table" 'RECOVERY_GUARD_PROTECTED' "$(qpg "create index zz_i on public.sales (id)")"
chkv "P6f postgres: ALTER TRIGGER ... RENAME" 'RECOVERY_GUARD_PROTECTED' "$(qpg "alter trigger zz_recovery_guard on public.categories rename to zz_x")"
chkv "P6g postgres: CREATE POLICY on a guarded table" 'RECOVERY_GUARD_PROTECTED' "$(qpg "create policy zz_p on public.categories for select using (true)")"
chkv "P6h postgres: SET SCHEMA" 'RECOVERY_GUARD_PROTECTED' "$(qpg "create schema if not exists zz_s; alter table public.reprint_logs set schema zz_s")"
chkv "P6i postgres: a guarded table becomes an INHERITS child" 'RECOVERY_GUARD_PROTECTED' "$(qpg "create table public.zz_parent (id text); alter table public.reprint_logs inherit public.zz_parent")"
chkv "P6j postgres: GRANT on a guarded table (ACL fingerprint)" 'RECOVERY_GUARD_PROTECTED' "$(qpg "grant update on public.idempotency_keys to service_role")"
chkv "P6k postgres: REVOKE on a guarded table" 'RECOVERY_GUARD_PROTECTED' "$(qpg "revoke select on public.categories from authenticated")"
chkv "P6l postgres: DROP POLICY on a guarded table" 'RECOVERY_GUARD_PROTECTED' "$(qpg "drop policy categories_sel on public.categories")"
IDX=$(q "select indexrelid::regclass::text from pg_index where indrelid = 'public.sales'::regclass and not indisprimary limit 1")
chkv "P6m postgres: DROP INDEX of a guarded table ($IDX)" 'RECOVERY_GUARD_PROTECTED' "$(qpg "drop index $IDX")"
chkv "P7 postgres: disable the event trigger" 'must be owner|permission denied|superuser' "$(qpg "alter event trigger zz_recovery_ddl_guard disable")"
chkv "P8 postgres: write recovery tables" 'permission denied' "$(qpg "update recovery.org_state set held = false")"
chkv "P8b postgres: owner functions" 'permission denied' "$(qpg "select recovery.owner_open('a', 'b')")"
chkv "P8c postgres: UPDATE the public canary" 'permission denied' "$(qpg "update public.zz_recovery_canary set seq = seq")"
chkv "P8d postgres (owner of schema public): DROP the canary" 'RECOVERY_GUARD_PROTECTED' "$(qpg "drop table public.zz_recovery_canary")"
chkv "P8e postgres: DROP + re-CREATE the canary in one transaction" 'RECOVERY_GUARD_PROTECTED' "$(qpg "begin; drop table public.zz_recovery_canary; create table public.zz_recovery_canary (one boolean primary key default true, seq int not null, issued_xid xid8 not null); commit")"
chkv "P8f the canary survived" '^1$' "$(q "select count(*) from pg_class where oid = 'public.zz_recovery_canary'::regclass and relowner = 'recovery_owner'::regrole")"
chkv "P9 postgres: CREATE OR REPLACE op_execute_v87 (owned by recovery_owner)" 'must be owner' "$(qpg "create or replace function public.op_execute_v87(p_key uuid, p_rpc text, p_args jsonb, p_actor_id text, p_ctx jsonb) returns jsonb language sql as 'select null::jsonb'")"
chkv "P9b postgres: DROP recovery_epoch and CREATE its own (would issue epochs while held)" 'RECOVERY_GUARD_PROTECTED' "$(qpg "begin; drop function public.recovery_epoch(jsonb); create function public.recovery_epoch(p_ctx jsonb) returns jsonb language sql as \$x\$ select jsonb_build_object('epoch', epoch) from recovery.org_state limit 1 \$x\$; commit")"
chkv "P9c postgres: DROP op_execute_v87" 'RECOVERY_GUARD_PROTECTED' "$(qpg "drop function public.op_execute_v87(uuid, text, jsonb, text, jsonb)")"
chkv "P9d postgres: an overload of a public 087 name" 'RECOVERY_GUARD_PROTECTED' "$(qpg "create function public.recovery_epoch(p_ctx jsonb, p_x int) returns jsonb language sql as 'select null::jsonb'")"
chkv "P9e the 8 public 087 functions are intact (registered OIDs, owner recovery_owner)" '^8\|8$' "$(q "select (select count(*) from recovery_guard.functions f join pg_proc p on p.oid = f.fnid and p.proowner = 'recovery_owner'::regrole) || '|' || (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like '%\_v87' or proname like 'recovery\_%'))")"
chkv "P9f postgres cannot read or change schema recovery_guard (the guard's snapshot)" 'permission denied' "$(qpg "delete from recovery_guard.snapshot")"
chkv "P10 postgres: insert a held-org row under replica role" 'RECOVERY_HOLD' "$(qpg "set session_replication_role = replica; insert into public.categories (id, name, color, org_id) values ('zz-p10', 'p10', '#000000', '$ORG1')")"
call "$J_CASH0" GET "zz_recovery_canary" ''; chkv "P11 API roles cannot read the public canary" '^(401|403|404)$' "$ST_"
call SERVICE POST "zz_recovery_canary" '{"one":true,"seq":1,"issued_xid":"1"}'; chkv "P11b service_role cannot write the canary" '^(401|403|404)$' "$ST_"
chkv "P12 S3: v87_finish without a token (direct SQL as authenticated)" 'V87_TOKEN_REQUIRED' "$(qerr supabase_admin "begin; set local role authenticated; select recovery.v87_finish(gen_random_uuid(), 'complete_sale', 'x', '{}'::jsonb); rollback")"
chkv "P13 service_role cannot execute the 087 API" 'permission denied' "$(qerr supabase_admin "begin; set local role service_role; select public.recovery_register_till('x'); rollback")"
chkv "P13b service_role cannot run the 086 prune" 'permission denied' "$(qerr supabase_admin "begin; set local role service_role; select public.prune_idempotency_keys(); rollback")"
chkv "P14 authority_hold on an org without a state row creates and holds it" '^t$' "$(docker exec -i $DB psql -X -h 127.0.0.1 -U recovery_authority -d postgres -At -c "select recovery.authority_hold('zz-no-state-org', 'test')" >/dev/null 2>&1; q "select held::text from recovery.org_state where org_id = 'zz-no-state-org'" | sed 's/true/t/')"
chkv "P15 DOCUMENTED RISK: postgres (pg_read_all_data) can read recovery.keys" '^2$' "$(docker exec -i $DB psql -X -U postgres -d postgres -At -c "select count(*) from recovery.keys" 2>&1)"
chkv "P16 superuser sessions may change guards (infrastructure trust)" '^ALTER TABLE$' "$(docker exec -i $DB psql -X -U supabase_admin -d postgres -At -c "begin; alter table public.categories disable trigger zz_recovery_guard; rollback" 2>&1 | grep -vE '^(BEGIN|ROLLBACK)$' | head -1)"

echo; echo "---- 10 M2: owner-only approval and full binding of decisions"
q "select recovery.owner_begin('simulated restore', 'alice', 'bob')" >/dev/null
chkv "L1 begin (two people): every org held, epochs advanced, server state hold" '^0\|hold$' "$(q "select (select count(*) from recovery.org_state where not held) || '|' || (select state from recovery.continuity)")"
chkv "L1b begin by one person refused" 'TWO_PEOPLE_REQUIRED' "$(qerr supabase_admin "begin; select recovery.owner_begin('x', 'alice', 'alice'); rollback")"
K_OLD=$(v7); K_OLD2=$(v7); K_ODD=$(v7)   # minted under the previous epoch, pending on till-A1 when the recovery began
J1=$(jq -nc --arg k "$K_OLD" --arg k2 "$(tr 'a-f' 'A-F' <<<"$K_OLD2")" '{records:[{key:$k,rpc:"complete_sale",state:"sent-no-reply"},{key:$k2,rpc:"complete_sale",state:"queued"}]}')
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 1 "$J1" false; chk "L2 journal upload during the hold" 200 '"stored"'
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 1 "$J1" false; chk "L2b same chunk again: idempotent" 200 'already_stored'
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 1 '{}' false; chk "L2c different content, same chunk: conflict, never overwritten" 200 'conflict'
journal "$J_CASH0" "$(ctx till-A1 wrong x)" 9 '{}' true; chk "L2d upload with a wrong till secret" 429 'TILL_UNKNOWN'
q "insert into recovery.quota values ('$ORG0', 1600)" >/dev/null
for n in 3 4 5 6 7; do journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" $n '{"pad":"'"$(head -c 600 /dev/zero | tr '\0' x)"'"}' false; done
chk "L3 over quota: refused, nothing deleted" 200 'quota_exceeded'
chkv "L3b five refusals -> one quota event; earlier evidence intact" '^1\|[2-9]$' "$(q "select (select count(*) from recovery.events where kind = 'journal_quota_exceeded') || '|' || (select count(*) from recovery.journal where org_id = '$ORG0')")"
q "delete from recovery.quota where org_id = '$ORG0'" >/dev/null
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 8 '{"records":[{"key":"not-a-uuid"}]}' false; chk "L3c a non-UUID key: the upload is refused, nothing stored" 400 '22P02|invalid input syntax for type uuid'
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; chk "L4 till cannot fetch the new epoch before reconciliation" 429 'TILL_NOT_RECONCILED'; cap F429_NOT_RECONCILED
call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A1"}'; chk "L5 approval refused while the journal is not final" 400 'JOURNAL_INCOMPLETE'
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 9 '{"records":[]}' true >/dev/null
call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A1"}'; chk "L5e a final chunk after a gap (chunk 2 never sent, quota-refused chunks missing) does not reconcile the till" 400 'JOURNAL_INCOMPLETE'
for n in 2 3 4 5 6 7 8; do journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" $n '{"records":[]}' false >/dev/null; done
chkv "L5f the journal is now complete: chunks 1..9 stored, 9 final" '^9\|9\|t$' "$(q "select count(*) || '|' || max(chunk_no) || '|' || bool_and(final) filter (where chunk_no = 9)::text from recovery.journal where org_id = '$ORG0' and till_id = 'till-A1' and epoch_no = (select epoch_no from recovery.org_state where org_id = '$ORG0')" | sed 's/true/t/')"
call "$J_ADM0_1" POST rpc/recovery_approve_till '{"p_till":"till-A1"}'; chk "L5b admin without MFA cannot approve" 403 'MFA_REQUIRED'
journal "$J_ADM0" "$(ctx till-A2 "$SEC_A2" x)" 1 '{"records":[]}' true >/dev/null
call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A2"}'; chk "L5c the admin who uploaded a till's journal cannot approve that till" 403 'SELF_APPROVAL'
call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A1"}'; chk "L5d the org's MFA ADMIN (did not submit till-A1's journal) approves it" 200 'reconciled_epoch_no'
journal "$J_CASH0" "$(ctx till-A3 "$SEC_A3" x)" 1 '{"records":[]}' true >/dev/null; call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A3"}' >/dev/null
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; chk "L6 reconciled, org held: no epoch (HIGH-1)" 429 'RECOVERY_HOLD'
propose "$K_ODD" "$ARGS0"; chk "D1 a decision for an operation that is in no journal is refused" 400 'NOT_JOURNALED'
propose "$K_OLD" "$ARGS0" till-A2; chk "D1b a decision naming another till than the one that journaled it is refused" 400 'NOT_JOURNALED'
propose "$K_OLD" "$ARGS0"; chk "D2 the org's MFA admin proposes a fence for till-A1's journaled operation" 200 '^[0-9]+$'; DID=$(cat "$OUT/b.txt")
propose "$(v7)" '{}' till-A1 execute; chk "D2b 'execute' decisions do not exist in 087" 400 'NOT_JOURNALED|check constraint|23514'
OWNAPP() { qe "select recovery.owner_approve_decision($1, '$2', '${3}', \$a\$$4\$a\$::jsonb, '$5', $6, '$7', 'alice', '${8:-bob}')"; }
chkv "D3 owner approval naming one person twice is refused" 'TWO_PEOPLE_REQUIRED' "$(OWNAPP $DID $K_OLD complete_sale "$ARGS0" $CASH0 0 till-A1 ' Alice')"
chkv "D3b owner approval restating different args is refused" 'DECISION_NOT_APPROVABLE' "$(OWNAPP $DID $K_OLD complete_sale '{"other":1}' $CASH0 0 till-A1)"
chkv "D3c ... a different till" 'DECISION_NOT_APPROVABLE' "$(OWNAPP $DID $K_OLD complete_sale "$ARGS0" $CASH0 0 till-A3)"
chkv "D3d ... a different actor" 'DECISION_NOT_APPROVABLE' "$(OWNAPP $DID $K_OLD complete_sale "$ARGS0" $ADM0 0 till-A1)"
chkv "D3e ... a different rpc or op epoch" 'DECISION_NOT_APPROVABLE.*DECISION_NOT_APPROVABLE' "$(OWNAPP $DID $K_OLD adjust_stock "$ARGS0" $CASH0 0 till-A1) $(OWNAPP $DID $K_OLD complete_sale "$ARGS0" $CASH0 1 till-A1)"
chkv "D3f none of them approved it" '^NULL$' "$(q "select coalesce(approved_at::text, 'NULL') from recovery.decisions where id = $DID")"
chkv "D4 the infrastructure owner (superuser session, two names) approves exactly this operation" '^$' "$(OWNAPP $DID $K_OLD complete_sale "$ARGS0" $CASH0 0 till-A1)"
chkv "D4b the approval records both names" '^alice\|bob$' "$(q "select approved_by || '|' || second_approver from recovery.decisions where id = $DID")"
chkv "D4c a second approval of the same decision is refused" 'DECISION_NOT_APPROVABLE' "$(OWNAPP $DID $K_OLD complete_sale "$ARGS0" $CASH0 0 till-A1 carol)"
propose "$K_OLD2" '{"wrong":1}'; chk "D9 a MISTAKEN proposal (wrong args) for a journaled key" 200 '^[0-9]+$'; DIDW=$(cat "$OUT/b.txt")
propose "$K_OLD2" "$ARGS0"; chk "D9b a corrected proposal while the mistaken one is open: refused (one open per key)" 409 '23505|decisions_one_open_per_key'
call "$J_CASH0" POST rpc/recovery_withdraw_decision "{\"p_id\":$DIDW}"; chk "D9c a cashier cannot withdraw it" 403 'MFA_REQUIRED'
call "$J_ADM1" POST rpc/recovery_withdraw_decision "{\"p_id\":$DIDW}"; chk "D9d another org's admin cannot withdraw it" 400 'NOT_WITHDRAWABLE'
call "$J_ADM0" POST rpc/recovery_withdraw_decision "{\"p_id\":$DIDW}"; chk "D9e the org's MFA admin withdraws it" 204 '^$'
chkv "D9f a withdrawn proposal cannot be approved" 'DECISION_NOT_APPROVABLE' "$(OWNAPP $DIDW $K_OLD2 complete_sale '{"wrong":1}' $CASH0 0 till-A1)"
propose "$K_OLD2" "$ARGS0"; chk "D9g the corrected proposal is now accepted" 200 '^[0-9]+$'
q "select recovery.owner_open('alice', 'bob')" >/dev/null; q "select recovery.zz_test_release_org('$ORG0')" >/dev/null   # 088 stand-in
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; E2A=$(jq -r .epoch "$OUT/b.txt"); W2A=$(jq -c .witness "$OUT/b.txt")
epoch_of "$J_CASH0" "$(ctx till-A3 "$SEC_A3" x)"; W2A3=$(jq -c .witness "$OUT/b.txt")
v87 "$J_CASH0" "$K_OLD" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W2A")"; chk "L8 operation queued under the OLD epoch, re-sent after the (088) release: never executed" 429 'PRE_EPOCH_OPERATION'; cap F429_PRE_EPOCH
chkv "L8b ... and not recorded" '^0$' "$(ledger_has "$K_OLD")"
fence "$J_CASH0" "$K_OLD" '{"other":1}' "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W2A")"; chk "D5 decision bound to args: different args refused" 429 'PRE_EPOCH_OPERATION'
fence "$J_CASH0" "$K_OLD" "$ARGS0" "$ADM0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W2A")"; chk "D5b decision bound to actor" 429 'PRE_EPOCH_OPERATION'
fence "$J_CASH0" "$K_OLD" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W2A")" adjust_stock; chk "D5c decision bound to rpc" 429 'PRE_EPOCH_OPERATION'
fence "$J_CASH0" "$K_OLD" "$ARGS0" "$CASH0" "$(ctx till-A3 "$SEC_A3" "$E0A" "$W2A3")"; chk "D5d decision bound to the till: another reconciled till cannot use it" 429 'PRE_EPOCH_OPERATION'
fence "$J_CASH0" "$K_OLD" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E2A" "$W2A")"; chk "D5e decision bound to the op epoch: re-stamped with the new epoch refused" 429 'PRE_EPOCH_OPERATION'
chkv "D5f none of the mismatches consumed the decision" '^1\|NULL$' "$(q "select count(*) || '|' || coalesce(max(consumed_at)::text, 'NULL') from recovery.decisions where id = $DID")"
CLAIMS=$(jq -nc --arg s "$AUTH_CASH0" '{sub:$s,role:"authenticated",aal:"aal1"}')
FCALL="select public.op_status_v87('$K_OLD', 'complete_sale', true, '$CASH0', \$a\$$ARGS0\$a\$::jsonb, \$c\$$(ctx till-A1 "$SEC_A1" "$E0A" "$W2A")\$c\$::jsonb)"
RACE="begin; set local role authenticated; select set_config('request.jwt.claims', \$j\$$CLAIMS\$j\$, true); $FCALL; select pg_sleep(4); commit;"
RACE2="begin; set local role authenticated; select set_config('request.jwt.claims', \$j\$$CLAIMS\$j\$, true); $FCALL; commit;"
( docker exec -i $DB psql -X -U supabase_admin -d postgres -At -c "$RACE" > "$OUT/race1.txt" 2>&1 ) & sleep 1.5
T0=$(python3 -I -c 'import time; print(time.time())')
docker exec -i $DB psql -X -U supabase_admin -d postgres -At -c "$RACE2" > "$OUT/race2.txt" 2>&1
WAITED=$(python3 -I -c 'import sys, time; print(int((time.time() - float(sys.argv[1])) * 1000))' "$T0"); wait
chkv "D6 two sessions race to use ONE decision: the first fences, the second WAITS on its lock (${WAITED} ms) and is then refused" '^"fenced": true\|PRE_EPOCH_OPERATION\|waited$' "$(grep -h -oE '"fenced": true|PRE_EPOCH_OPERATION' "$OUT/race1.txt" | head -1)|$(grep -h -oE '"fenced": true|PRE_EPOCH_OPERATION' "$OUT/race2.txt" | head -1)|$([ "$WAITED" -ge 1500 ] && echo waited || echo "did-not-wait-$WAITED")"
chkv "D6b consumed exactly once" '^1\|1$' "$(q "select (select count(*) from recovery.events where kind = 'decision_consumed' and (detail->>'decision')::bigint = $DID) || '|' || (select count(*) from recovery.decisions where id = $DID and consumed_at is not null)")"
chkv "D6c ledger: the key is abandoned (fenced), never committed" '^abandoned$' "$(q "select state from idempotency_keys where key = '$K_OLD'")"
fence "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W2A")"; chk "D6d the consumed decision cannot be reused for another key" 429 'PRE_EPOCH_OPERATION'
K_EXP=$(v7at -$((430*86400)))
J2=$(jq -nc --arg k "$K_EXP" '{records:[{key:$k,rpc:"complete_sale",state:"sent-no-reply"}]}')
q "update recovery.tills set reconciled_epoch_no = -1 where till_id = 'till-A1'" >/dev/null
journal "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)" 10 "$J2" true; chk "D7a journal chunk with the expired key stored" 200 '"stored"'
call "$J_ADM0" POST rpc/recovery_approve_till '{"p_till":"till-A1"}' >/dev/null
propose "$K_EXP" "$ARGS0"; DID2=$(cat "$OUT/b.txt"); OWNAPP $DID2 $K_EXP complete_sale "$ARGS0" $CASH0 0 till-A1 >/dev/null
fence "$J_CASH0" "$K_EXP" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E0A" "$W2A")"; chk "D7 a fence that does not happen (expired key) is refused" 429 'FENCE_NOT_APPLIED'
chkv "D7b ... and the decision is NOT consumed" '^1\|NULL$' "$(q "select count(*) || '|' || coalesce(max(consumed_at)::text, 'NULL') from recovery.decisions where id = $DID2")"
v87 "$J_CASH0" "$K_OLD2" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E2A" "$W2A")"; chk "D8 a journaled key (stored in upper case) re-stamped with the new epoch: refused" 429 'PRE_EPOCH_OPERATION'
K_PRE=$(v7at -3600)
v87 "$J_CASH0" "$K_PRE" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E2A" "$W2A")"; chk "D8b key minted before the epoch, not journaled, re-stamped: refused (refusal-only clock check)" 429 'PRE_EPOCH_OPERATION'
chkv "D8c none of them executed" '^0$' "$(q "select count(*) from idempotency_keys where key in ('$K_OLD2', '$K_PRE')")"
epoch_of "$J_CASH0" "$(ctx till-A2 "$SEC_A2" x)"; chk "L13 till-A2 (never reconciled) still gets no epoch" 429 'TILL_NOT_RECONCILED'
opx "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0"; chk "L14 Phase 0 / Batch 2A after the release" 429 'CLIENT_UPGRADE_REQUIRED'
direct "$J_CASH0" "$ARGS0" "$(v4)"; chk "L14b RC3 after the release" 429 'CLIENT_UPGRADE_REQUIRED'
cat_ins "$J_ADM0" "$ORG0" "oldepochcat" "$E0A"; chk "L15 catalogue write created under the OLD epoch (stale queued write)" 429 'PRE_EPOCH_OPERATION'
cat_ins "$J_ADM0" "$ORG0" "newepochcat" "$E2A"; chk "L15b created under the current epoch" 201 'newepochcat'
epoch_of "$J_CASH0" "$(ctx till-A1 "$SEC_A1" x)"; W3A=$(jq -c .witness "$OUT/b.txt")
K=$(v7); v87 "$J_CASH0" "$K" "$ARGS0" "$CASH0" "$(ctx till-A1 "$SEC_A1" "$E2A" "$W3A")"; chk "L16 reconciled till, new-epoch operation: committed" 200 'committed'

echo; echo "---- 11 restart survival: no automatic reopening; anchored restart keeps a held org held, healthy orgs renewed"
docker restart $DB >/dev/null; for _ in $(seq 1 60); do docker exec $DB pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; docker restart phf-iso-rest >/dev/null; sleep 6
call SERVICE POST categories "$(jq -nc --arg o "$ORG0" '{id:"zz-c-2",name:"c2",color:"#000000",org_id:$o}')"; chk "R1 after a DB restart: an unheld tenant's write refused (lease pre-start)" 429 'LEASE_INVALID'
chkv "R2 authority: restart not anchored" 'REFUSED RESTART_NOT_ANCHORED' "$(AUTH tick)"
q "select recovery.owner_anchor('restart test', 'alice', 'bob')" >/dev/null
chkv "R3 after the two-person anchor: renewed" 'renew lease=RENEWED' "$(AUTH tick)"
call SERVICE POST categories "$(jq -nc --arg o "$ORG0" '{id:"zz-c-3",name:"c3",color:"#000000",org_id:$o}')"; chk "R4 unheld tenant writes again" 201 'c3'
call SERVICE POST categories "$(jq -nc --arg o "$ORGC" '{id:"zz-c-4",name:"c4",color:"#000000",org_id:$o}')"; chk "R4b a tenant held by the recovery stays held after the restart" 429 'RECOVERY_HOLD'
chkv "R5 holds survived the restart (B and the authority-held test org)" '^t\|t$' "$(q "select (select held from recovery.org_state where org_id = '$ORG1')::text || '|' || (select held from recovery.org_state where org_id = 'zz-no-state-org')::text" | sed 's/true/t/g')"

echo; echo "---- 12 HTTP 429 through the pinned upstream Envoy v1.39.1 + the prepared maintenance listener"
EV="$OUT/envoy"; mkdir -p "$EV"
if [ -n "${UPSTREAM_ENVOY_DIR:-}" ]; then for f in lds.template.yaml envoy.yaml cds.yaml docker-entrypoint.sh; do cp "$UPSTREAM_ENVOY_DIR/$f" "$EV/$f"; done
else for f in lds.template.yaml envoy.yaml cds.yaml docker-entrypoint.sh; do curl -sSfL -o "$EV/$f" "https://raw.githubusercontent.com/supabase/supabase/564eab8ad7840b13324f68b1bfac074ef8d51c21/docker/volumes/api/envoy/$f"; done; fi
chkv "E0 upstream lds.template.yaml = the pinned server copy" '^9d9a6d6ea0a372be99e165d995f012d383d5cc8473b92a06b7aa0bbd73566c3d$' "$(shasum -a 256 "$EV/lds.template.yaml" | cut -d' ' -f1)"
sed -e 's/address: auth$/address: phf-iso-auth/' -e 's/address: rest$/address: phf-iso-rest/' -e 's/address: storage$/address: phf-iso-storage/' -e 's/address: functions$/address: phf-iso-fn/' "$EV/cds.yaml" > "$EV/cds.local.yaml"
docker rm -f phf-iso-envoy >/dev/null 2>&1
docker run -d --name phf-iso-envoy --network phf-iso-net -p 127.0.0.1::8000 -e ANON_KEY="$PHF_ISO_ANON_KEY" -e SERVICE_ROLE_KEY="$PHF_ISO_SERVICE_KEY" \
  -e DASHBOARD_USERNAME=x -e DASHBOARD_PASSWORD=x-not-a-secret -e SUPABASE_PUBLIC_URL=http://127.0.0.1 \
  -v "$EV/lds.template.yaml:/etc/envoy/lds.template.yaml:ro" -v "$EV/envoy.yaml:/etc/envoy/envoy.yaml:ro" \
  -v "$EV/cds.local.yaml:/etc/envoy/cds.yaml:ro" -v "$EV/docker-entrypoint.sh:/docker-entrypoint.sh:ro" \
  --entrypoint /bin/sh envoyproxy/envoy:v1.39.1 /docker-entrypoint.sh >/dev/null
sleep 6; GW="http://127.0.0.1:$(docker port phf-iso-envoy 8000/tcp | head -1 | sed 's/.*://')"; echo "$GW" > "$OUT/envoy.url"
v87 "$J_CASH1" "$(v7)" "$ARGS1" "$CASH1" "$(ctx till-B1 "$SEC_B1" "$E0B" "$W_B")"; chk "E1 Envoy: held org v87 -> 429 JSON" 429 'PT429.*ORG_SUSPENDED|ORG_SUSPENDED.*PT429'; cap F429_ENVOY_HOLD
chkv "E1b Envoy: content-type application/json" '^application/json$' "$CT_"
opx "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0"; chk "E2 Envoy: legacy executor -> 429" 429 'CLIENT_UPGRADE_REQUIRED'; cap F429_ENVOY_UPGRADE
direct "$J_CASH0" "$ARGS0" "$(v4)"; chk "E2b Envoy: RC3 direct path -> 429" 429 'CLIENT_UPGRADE_REQUIRED'; cap F429_ENVOY_RC3
cat_ins "$J_ADM0" "$ORG0" "envoycat" "$E2A"; chk "E3 Envoy passes x-orvix-epoch to PostgREST (write allowed)" 201 'envoycat'
PF=$(curl -s -o /dev/null -D - -X OPTIONS "$GW/rest/v1/categories" -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: x-orvix-epoch,apikey,authorization,content-type' | tr -d '\r' | tr 'A-Z' 'a-z')
chkv "E4 upstream CORS preflight allows x-orvix-epoch" '^http/1.1 200.*access-control-allow-headers: (\*|[^ ]*x-orvix-epoch)' "$(grep -E '^http|access-control-allow-headers' <<<"$PF" | tr '\n' ' ')"
docker rm -f phf-iso-envoy-maint >/dev/null 2>&1
docker run -d --name phf-iso-envoy-maint -p 127.0.0.1::8000 -v "$ROOT/deploy/lucashome/envoy-recovery-maintenance.yaml:/etc/envoy/envoy.yaml:ro" envoyproxy/envoy:v1.39.1 >/dev/null; sleep 4
GW="http://127.0.0.1:$(docker port phf-iso-envoy-maint 8000/tcp | head -1 | sed 's/.*://')"; echo "$GW" > "$OUT/maint.url"
opx "$J_CASH0" "$(v7)" "$ARGS0" "$CASH0"; chk "E5 API guard during a restore (deploy/lucashome/envoy-recovery-maintenance.yaml): same 429 contract" 429 'API_GUARD'; cap F429_API_GUARD
chkv "E5b maintenance listener sends CORS on the 429" 'access-control-allow-origin' "$(tr 'A-Z' 'a-z' < "$OUT/h.txt")"
PF=$(curl -s -o /dev/null -D - -X OPTIONS "$GW/rest/v1/rpc/op_execute_v87" -H 'Origin: file://' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: x-orvix-epoch,apikey,authorization,content-type,x-retry-count,x-upsert,cache-control' | tr -d '\r' | tr 'A-Z' 'a-z')
chkv "E5c maintenance preflight 204 + explicit allow-headers incl. authorization, x-retry-count, x-upsert, cache-control" '^http/1.1 204.*access-control-allow-headers: [^ ]*authorization[^ ]*' "$(grep -E '^http|access-control-allow-headers' <<<"$PF" | tr '\n' ' ')"
MISS=""; for h in authorization apikey content-type x-client-info x-orvix-epoch prefer accept-profile content-profile range x-retry-count x-supabase-api-version x-upsert cache-control; do grep -q "access-control-allow-headers: .*$h" <<<"$PF" || MISS="$MISS $h"; done
chkv "E5d every header the clients send is in the maintenance allow-list (missing: none)" '^none$' "${MISS:-none}"
GW="$PHF_ISO_URL"   # the Envoy containers stay up for the browser part; run.sh removes them

echo; echo "---- 13 rollback through the real runner keeps evidence; 086 restored exactly; re-apply; second rollback"
docker exec $DB pg_dump -U supabase_admin -d postgres -n recovery -Fc -f /tmp/recovery-evidence.dump && docker cp $DB:/tmp/recovery-evidence.dump "$OUT/" >/dev/null
EVID=$(q "select (select count(*) from recovery.journal) || '|' || (select count(*) from recovery.events) || '|' || (select count(*) from recovery.chain_log) || '|' || (select count(*) from recovery.decisions)")
runner --rollback 087 > "$OUT/rollback-refused.log"; chkv "B0 rollback without the owner's till-queue confirmation: refused" 'owner has not confirmed|nothing planned' "$(cat "$OUT/rollback-refused.log")"
runner --rollback 087 --owner-confirmed-till-queues-empty > "$OUT/rollback.log"; chkv "B1 apply-migrations.sh --rollback 087: committed" 'COMMITTED' "$(cat "$OUT/rollback.log")"
ARCH=$(q "select nspname from pg_namespace where nspname like 'recovery\_archived\_087\_%' order by nspname desc limit 1")
chkv "B2 evidence exported before the rollback" '[0-9]{4,}' "$(wc -c < "$OUT/recovery-evidence.dump" | tr -d ' ')"
chkv "B3 evidence kept in $ARCH (journal|events|chain|decisions identical)" "^$EVID\$" "$(q "select (select count(*) from $ARCH.journal) || '|' || (select count(*) from $ARCH.events) || '|' || (select count(*) from $ARCH.chain_log) || '|' || (select count(*) from $ARCH.decisions)")"
chkv "B4 no 087 trigger, function, event trigger, guard schema or ledger row left; canary archived" '^0\|0\|0\|0\|t\|t$' "$(q "select (select count(*) from pg_trigger where tgname like 'zz\_recovery\_%') || '|' || (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like '%\_v87' or proname like 'recovery\_%')) || '|' || (select count(*) from pg_event_trigger where evtname like 'zz\_recovery%') || '|' || (select count(*) from supabase_migrations.schema_migrations where version = '087') || '|' || (to_regclass('$ARCH.zz_recovery_canary') is not null)::text || '|' || (to_regnamespace('recovery_guard') is null)::text" | sed 's/true/t/g')"
chkv "B5 recovery_authority / recovery_gate cannot log in after the rollback" '^f\|f$' "$(q "select (select rolcanlogin from pg_roles where rolname = 'recovery_authority')::text || '|' || (select rolcanlogin from pg_roles where rolname = 'recovery_gate')::text" | sed 's/false/f/g')"
K=$(v7); opx "$J_CASH0" "$K" "$ARGS0" "$CASH0"; chk "B6 after the rollback: 086 op_execute works again (Phase 0 path)" 200 'committed'
runner --from 087 --to 087 > "$OUT/reapply.log"; chkv "B7 re-apply through the runner" 'COMMITTED' "$(cat "$OUT/reapply.log")"
chkv "B7b re-applied 087 starts held; both roles can log in again; archived evidence untouched" "^t\|t\|t\|$EVID\$" "$(q "select (not recovery.lease_ok())::text || '|' || (select rolcanlogin from pg_roles where rolname = 'recovery_authority')::text || '|' || (select rolcanlogin from pg_roles where rolname = 'recovery_gate')::text || '|' || (select count(*) from $ARCH.journal) || '|' || (select count(*) from $ARCH.events) || '|' || (select count(*) from $ARCH.chain_log) || '|' || (select count(*) from $ARCH.decisions)" | sed 's/true/t/g')"
sleep 1
runner --rollback 087 --owner-confirmed-till-queues-empty > "$OUT/rollback2.log"; chkv "B8 a second rollback after the re-apply (no archive-name collision)" 'COMMITTED' "$(cat "$OUT/rollback2.log")"
chkv "B8b two archived schemas now" '^2$' "$(q "select count(*) from pg_namespace where nspname like 'recovery\_archived\_087\_%'")"
runner --from 087 --to 087 > "$OUT/reapply2.log"; chkv "B9 final re-apply (left installed for the other parts)" 'COMMITTED' "$(cat "$OUT/reapply2.log")"

echo; echo "== RESULT: $PASS passed, $FAIL failed"
} 2>&1 | tee "$OUT/X2.txt"
jq -s '.' "$OUT/fixtures.jsonl" > "$OUT/fixtures-429.json"
