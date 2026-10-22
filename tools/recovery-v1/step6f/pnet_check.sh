#!/usr/bin/env bash
# Step 6 finalization: PNET-A (pg_net lockdown) on a DISPOSABLE supabase/postgres container (the stack's own image).
# Its own container (zz-s6f-pnet, label orvix.step6-finalization-disposable=1), no published port, local Docker only,
# synthetic only; the container is removed at the end. Nothing outside the container is touched; no request leaves it
# (the only queued request targets 127.0.0.1:9, and the worker is never awaited).
#   tools/recovery-v1/step6f/pnet_check.sh OUT_DIR      -> OUT_DIR/pnet-results.txt, exit 0 only when every check passes
set -u
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PNET_IMAGE:-supabase/postgres:17.6.1.136}"; N=zz-s6f-pnet
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
if docker container inspect "$N" >/dev/null 2>&1; then
  [ "$(docker inspect -f '{{index .Config.Labels "orvix.step6-finalization-disposable"}}' "$N")" = 1 ] || { echo "REFUSE: $N exists and is not ours"; exit 3; }
  docker rm -f "$N" >/dev/null
fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not present locally (never pulled here)"; exit 2; }
trap 'docker rm -f "$N" >/dev/null 2>&1' EXIT
docker run -d --name "$N" --label orvix.step6-finalization-disposable=1 -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" "$IMAGE" >/dev/null
for i in $(seq 1 90); do docker exec "$N" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done; sleep 4
R="$OUT/pnet-results.txt"; : > "$R"; FAILS=0
q()  { docker exec -i "$N" psql -X -U supabase_admin -d postgres -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
qf() { docker exec -i "$N" psql -X -U supabase_admin -d postgres -At -v ON_ERROR_STOP=1 -1 -f - < "$1" 2>&1; }
check() { if [ "$3" = "$4" ]; then echo "PASS $1 $2" >> "$R"; else echo "FAIL $1 $2 -- expected [$3] got [$4]" >> "$R"; FAILS=$((FAILS+1)); fi; }
denied() { # $1 role, $2 sql -> "denied" when the statement fails with a permission error
  out=$(docker exec -i "$N" psql -X -U supabase_admin -d postgres -At -c "SET ROLE $1; $2" 2>&1)
  case "$out" in *"permission denied"*) echo denied;; *) echo "ALLOWED: ${out:0:160}";; esac; }

q "CREATE EXTENSION IF NOT EXISTS pg_net" >/dev/null
q "CREATE ROLE zz_bridge_like LOGIN PASSWORD NULL" >/dev/null     # a direct-SQL login like the Control bridge (PUBLIC rights only)
echo "pg_net $(q "select extversion from pg_extension where extname='pg_net'")" > "$OUT/versions.txt"
check N00 'before PNET-A: the exposure exists (anon has schema usage, PUBLIC can insert into the queue)' 'tt' \
  "$(q "select has_schema_privilege('anon','net','USAGE')::text::char || has_table_privilege('zz_bridge_like','net.http_request_queue','INSERT')::text::char")"
qf "$ROOT/supabase/migrations-provisional/PNET-A_pg_net_lockdown.sql" > "$OUT/apply-1.log"; check N01 'PNET-A applies (superuser, one transaction)' 0 $?
check N02 'net_exposure_problems() is empty after PNET-A' '' "$(q "select string_agg(x, '; ') from orvix_netguard.exposure_problems() x")"
for role in anon authenticated service_role zz_bridge_like; do
  check "N03-$role" "$role cannot queue outgoing HTTP (net.http_post)" denied "$(denied "$role" "SELECT net.http_post('http://127.0.0.1:9/x');")"
  check "N04-$role" "$role cannot write the queue directly" denied "$(denied "$role" "INSERT INTO net.http_request_queue(method,url,headers,body,timeout_milliseconds) VALUES ('GET','http://127.0.0.1:9/',null,null,1000);")"
  check "N05-$role" "$role cannot read or delete other components' responses" denied "$(denied "$role" "DELETE FROM net._http_response;")"
  check "N06-$role" "$role cannot restart the worker" denied "$(denied "$role" "SELECT net.worker_restart();")"
done
check N07 'the authorized service role postgres can still queue a request (legitimate cron / runbook use)' 1 \
  "$(q "SET ROLE postgres; SELECT count(*) FROM (SELECT net.http_post('http://127.0.0.1:9/orvix-pnet-check')) x;" | tail -1)"
q "DELETE FROM net.http_request_queue WHERE url LIKE 'http://127.0.0.1:9/%'" >/dev/null
check N08 'postgres cannot restart the worker (owner only)' denied "$(denied postgres "SELECT net.worker_restart();")"
check N09 'supabase_functions_admin (webhooks) keeps schema usage and http_post' 'tt' \
  "$(q "select has_schema_privilege('supabase_functions_admin','net','USAGE')::text::char || has_function_privilege('supabase_functions_admin','net.http_post(text,jsonb,jsonb,jsonb,integer)','EXECUTE')::text::char")"
check N10 'SECURITY DEFINER safety: no net.* function is SECURITY DEFINER; every PNET-A helper lives in orvix_netguard, pins search_path and is superuser-owned' '0|0|5' \
  "$(q "select (select count(*) from pg_proc where pronamespace='net'::regnamespace and prosecdef) || '|' || (select count(*) from pg_proc p where p.pronamespace='orvix_netguard'::regnamespace and (p.proconfig is null or not (select rolsuper from pg_roles where oid=p.proowner))) || '|' || (select count(*) from pg_proc where pronamespace='orvix_netguard'::regnamespace)")"
check N11 'helpers: no schema USAGE for anon / authenticated / service_role; postgres sees the schema only through pg_read_all_data (read-only, on this image), and has no CREATE and no EXECUTE' 'ffft|ff' \
  "$(q "select has_schema_privilege('anon','orvix_netguard','USAGE')::text::char || has_schema_privilege('authenticated','orvix_netguard','USAGE')::text::char || has_schema_privilege('service_role','orvix_netguard','USAGE')::text::char || has_schema_privilege('postgres','orvix_netguard','USAGE')::text::char || '|' || has_schema_privilege('postgres','orvix_netguard','CREATE')::text::char || has_function_privilege('postgres','orvix_netguard.lockdown_apply()','EXECUTE')::text::char")"
# review 3, C1: postgres (owner of schema public on Supabase) must not be able to swap, drop or call a helper the superuser event trigger runs
for stmt in "DROP FUNCTION orvix_netguard.lockdown_apply()" \
            "CREATE OR REPLACE FUNCTION orvix_netguard.lockdown_apply() RETURNS void LANGUAGE sql AS 'SELECT 1'" \
            "ALTER FUNCTION orvix_netguard.lockdown_apply() RENAME TO x" "SELECT orvix_netguard.lockdown_apply()" \
            "DROP EVENT TRIGGER zz_orvix_net_lockdown" "ALTER EVENT TRIGGER zz_orvix_net_lockdown DISABLE"; do
  out=$(docker exec -i "$N" psql -X -U supabase_admin -d postgres -At -c "SET ROLE postgres; $stmt" 2>&1)
  case "$out" in *"permission denied"*|*"must be owner"*|*"must be superuser"*) v=denied;; *) v="ALLOWED: ${out:0:120}";; esac
  check N22 "C1: postgres cannot: $stmt" denied "$v"
done
check N22b 'C1: the helpers and the event trigger are intact afterwards (exposure check clean)' '' "$(q "select string_agg(x, '; ') from orvix_netguard.exposure_problems() x")"
# re-grant protection: Supabase's grant_pg_net_access re-grants on CREATE EXTENSION; an update may recreate objects
q "DROP EXTENSION pg_net" >/dev/null; q "CREATE EXTENSION pg_net" >/dev/null
check N12 'DROP + CREATE EXTENSION pg_net (Supabase re-grants to anon/authenticated/service_role): the event trigger re-locks it in the same transaction' '' \
  "$(q "select string_agg(x, '; ') from orvix_netguard.exposure_problems() x")"
q "GRANT ALL ON net.http_request_queue TO PUBLIC; GRANT USAGE ON SCHEMA net TO anon" >/dev/null
upd=$(q "ALTER EXTENSION pg_net UPDATE" 2>&1)
check N13 "ALTER EXTENSION pg_net UPDATE (here: same version, \"${upd:0:60}\") re-applies the lockdown over drifted grants" '' \
  "$(q "select string_agg(x, '; ') from orvix_netguard.exposure_problems() x")"
q "GRANT ALL ON net.http_request_queue TO PUBLIC" >/dev/null
check N14 'drift outside an extension change is DETECTED by net_exposure_problems() (for audits; re-run PNET-A to fix)' 'net.http_request_queue: PUBLIC' \
  "$(q "select x from orvix_netguard.exposure_problems() x limit 1" | cut -d' ' -f1-2)"
q "SELECT orvix_netguard.lockdown_apply()" >/dev/null
check N15 'net_lockdown_apply() repairs the drift' '' "$(q "select string_agg(x, '; ') from orvix_netguard.exposure_problems() x")"
# review 3, M1: Supabase's webhook wrapper (simulated as Supabase creates it: SECURITY DEFINER, owned by supabase_functions_admin, granted to API roles)
q "CREATE SCHEMA IF NOT EXISTS supabase_functions AUTHORIZATION supabase_admin; GRANT USAGE ON SCHEMA supabase_functions TO anon, authenticated, service_role, supabase_functions_admin;
   CREATE OR REPLACE FUNCTION supabase_functions.http_request() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = supabase_functions AS \$f\$ BEGIN RETURN NEW; END \$f\$;
   ALTER FUNCTION supabase_functions.http_request() OWNER TO supabase_functions_admin; GRANT EXECUTE ON FUNCTION supabase_functions.http_request() TO anon, authenticated, service_role;" >/dev/null
check N23a 'M1: the webhook wrapper executable by anon is reported' 't' "$(q "select exists(select 1 from orvix_netguard.exposure_problems() x where x like 'supabase_functions.http_request(): anon%')")"
q "ALTER EXTENSION pg_net UPDATE" >/dev/null 2>&1
check N23b 'M1: the next extension change (or lockdown_apply) revokes the wrapper from anon/authenticated/service_role' 'fff' \
  "$(q "select has_function_privilege('anon','supabase_functions.http_request()','EXECUTE')::text::char || has_function_privilege('authenticated','supabase_functions.http_request()','EXECUTE')::text::char || has_function_privilege('service_role','supabase_functions.http_request()','EXECUTE')::text::char")"
# review 3, M2: grant options, memberships and default privileges are part of the rule
q "GRANT INSERT ON net.http_request_queue TO postgres WITH GRANT OPTION" >/dev/null
check N24a 'M2: a grant option held by an authorized role is reported' 't' "$(q "select exists(select 1 from orvix_netguard.exposure_problems() x where x like '%WITH GRANT OPTION%')")"
q "SELECT orvix_netguard.lockdown_apply()" >/dev/null
check N24b 'M2: lockdown_apply removes the grant option' '' "$(q "select string_agg(x, '; ') from orvix_netguard.exposure_problems() x")"
q "CREATE ROLE zz_member NOLOGIN; GRANT postgres TO zz_member" >/dev/null
check N25 'M2: a role that inherits from an authorized role (member of postgres) is reported' 't' "$(q "select exists(select 1 from orvix_netguard.exposure_problems() x where x = 'member of postgres: zz_member')")"
q "REVOKE postgres FROM zz_member; DROP ROLE zz_member" >/dev/null
q "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA net GRANT EXECUTE ON FUNCTIONS TO anon" >/dev/null
check N26 'M2: default privileges in schema net are reported' 't' "$(q "select exists(select 1 from orvix_netguard.exposure_problems() x where x like 'default privileges in schema net%')")"
q "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA net REVOKE EXECUTE ON FUNCTIONS FROM anon" >/dev/null
# review 3, M3: the post-V1 revoke-only file restores the matrix on drifted grants (here applied directly; through V1's
# authorized-migration path in tools/recovery-v1/step6f/pnet_v1_post.py)
q "GRANT ALL ON net.http_request_queue TO PUBLIC; GRANT USAGE ON SCHEMA net TO anon, authenticated; GRANT EXECUTE ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,integer) TO service_role" >/dev/null
qf "$ROOT/supabase/migrations-provisional/PNET-A_post_v1_revoke.sql" > "$OUT/post-v1.log"; check N27a 'M3: PNET-A_post_v1_revoke.sql applies (GRANT/REVOKE only)' 0 $?
check N27b 'M3: after it, nothing outside the rule remains' '' "$(q "select string_agg(x, '; ') from orvix_netguard.exposure_problems() x")"
qf "$ROOT/supabase/migrations-provisional/PNET-A.rollback.sql" > "$OUT/rollback.log"; check N16 'PNET-A.rollback.sql applies' 0 $?
check N17 'after the rollback: no event trigger, anon schema usage as Supabase grants it, PUBLIC table rights NOT restored' 'f|t|f' \
  "$(q "select exists(select 1 from pg_event_trigger where evtname='zz_orvix_net_lockdown')::text::char || '|' || has_schema_privilege('anon','net','USAGE')::text::char || '|' || has_table_privilege('zz_bridge_like','net.http_request_queue','INSERT')::text::char")"
qf "$ROOT/supabase/migrations-provisional/PNET-A_pg_net_lockdown.sql" > "$OUT/apply-2.log"; check N18 'PNET-A re-applies after a rollback (idempotent)' 0 $?
qf "$ROOT/supabase/migrations-provisional/PNET-A_pg_net_lockdown.sql" > "$OUT/apply-3.log"; check N19 'PNET-A applies twice (idempotent)' 0 $?
q "CREATE SCHEMA recovery_v1" >/dev/null
out=$(qf "$ROOT/supabase/migrations-provisional/PNET-A_pg_net_lockdown.sql"); case "$out" in *"Recovery V1 is installed"*) v=refused;; *) v="applied: ${out:0:120}";; esac
check N20 'PNET-A refuses once Recovery V1 is installed (post-V1 changes only through an owner-authorized migration)' refused "$v"
q "DROP SCHEMA recovery_v1" >/dev/null
out=$(docker exec -i "$N" psql -X -U postgres -d postgres -At -v ON_ERROR_STOP=1 -1 -f - < "$ROOT/supabase/migrations-provisional/PNET-A_pg_net_lockdown.sql" 2>&1)
case "$out" in *"run as the superuser"*) v=refused;; *) v="applied: ${out:0:120}";; esac
check N21 'PNET-A refuses a non-superuser runner (postgres on Supabase)' refused "$v"
echo "== $(grep -c '^PASS' "$R") passed, $FAILS failed" >> "$R"
cat "$R"
[ "$FAILS" = 0 ]
