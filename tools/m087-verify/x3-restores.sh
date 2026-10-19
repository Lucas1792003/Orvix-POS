#!/usr/bin/env bash
# 087 restore suite on the REAL migration and the REAL database image (supabase/postgres:17.6.1.136, as the stack runs it):
# a cold physical copy of the disposable stack's database restored plainly, the same copy + WAL replay (PITR to the end), and
# same-server data-only reloads; the repo's witness authority and gate judge each. Disposable containers/volumes zz-m087-*
# (--network none), removed by exact name. Expects lib/stack.sh up + 087 installed (x2 leaves it re-applied, held, no lease).
#   tools/m087-verify/x3-restores.sh RESULTS_DIR
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
RES=$(cd "$1" && pwd); OUT="$RES/x3"; rm -rf "$OUT"; mkdir -p "$OUT/auth" "$OUT/mirror"; DB=phf-iso-db
TOOLS="$ROOT/tools/recovery-authority"; OPENSSL=${OPENSSL:-/opt/homebrew/opt/openssl@3/bin/openssl}
IMG=$(docker inspect -f '{{.Config.Image}}' $DB); N=zz-m087
cleanup() { docker rm -f -v $N-r1 $N-r2 >/dev/null 2>&1; docker volume rm $N-r1 $N-r2 >/dev/null 2>&1; }
trap cleanup EXIT; cleanup
q()  { docker exec -i "$1" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$2"; }
qe() { docker exec -i "$1" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$2" 2>&1 | grep -m1 -E 'ERROR' | sed -E 's/^(psql:[^E]*)?ERROR: +//'; }
waitdb() { for _ in $(seq 1 120); do docker exec "$1" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && q "$1" "select 1" >/dev/null 2>&1 && return 0; sleep 1; done; docker logs "$1" 2>&1 | tail -10; return 1; }
AU() { AUTH_PGHOST=127.0.0.1 python3 -I "$TOOLS/authority.py" tick "${2:-$OUT/auth}" "${3:-$OUT/mirror}" "$1" 3600 2>&1; }
GATE() { local db=$1 n; n=$(python3 -I "$TOOLS/gate.py" --issue-nonce --pub "$OUT/auth/authority.pub"); python3 -I "$TOOLS/authority.py" attest "$OUT/auth" "$OUT/mirror" "$n" "$OUT/att.json" >/dev/null 2>&1
  GATE_PGHOST=127.0.0.1 python3 -I "$TOOLS/gate.py" --db "$db" --pub "$OUT/auth/authority.pub" --copy authority:"$OUT/mirror/series" --attest "$OUT/att.json" --nonce "$n" 2>&1; }
ST="$RES/stack/state.json"; A=$(jq -r '.orgs[0].org' $ST); B=$(jq -r '.orgs[1].org' $ST)
ops() { q "$1" "insert into public.idempotency_keys (key, rpc, actor_id, org_id, request_hash, state) select gen_random_uuid(), 'zz_x3_rpc', null, '$2', 'x3', 'committed' from generate_series(1, $3)" >/dev/null; }
heads() { q "$1" "select string_agg(substr(org_id, 1, 20) || ':' || n, ' ' order by org_id) from recovery.org_chain where org_id in ('$A', '$B')"; }
ident() { q "$1" "select (select system_identifier from pg_control_system()) || '|' || (select timeline_id from pg_control_checkpoint()) || '|' || (select oid from pg_database where datname = current_database())"; }
PASS=0; FAIL=0
chk() { local v; v=$(tr '\n' ' ' <<<"$3" | sed -E 's/ +$//'); if { [ -n "$v" ] || [ "$2" = '^$' ]; } && grep -qE -- "$2" <<<"$v"; then PASS=$((PASS+1)); r=PASS; else FAIL=$((FAIL+1)); r=FAIL; fi; printf '%-4s %-84s %s\n' "$r" "$1" "$(cut -c1-170 <<<"$v")"; }
cold_copy() {  # TAR-FILE [SUBPATH]: stop the database, stream the data directory out, start it again (a clean cold copy)
  docker stop -t 60 $DB >/dev/null; docker cp "$DB:/var/lib/postgresql/data${2:-}" - > "$1"; docker start $DB >/dev/null; waitdb $DB
}
restore() {  # NAME TAR [pitr WALTAR]
  docker volume create $1 >/dev/null
  docker run --rm -i -v $1:/d --entrypoint sh "$IMG" -c 'mkdir -p /d && tar -C /d -xf - && chown -R postgres:postgres /d' < "$2"
  docker run --rm -v $1:/d --entrypoint sh "$IMG" -c 'if [ -d /d/data ]; then mv /d/data/* /d/ && rmdir /d/data; fi; rm -f /d/postmaster.pid; chmod 700 /d' >/dev/null
  if [ "${3:-}" = pitr ]; then
    docker run --rm -i -v $1:/d --entrypoint sh "$IMG" -c 'mkdir -p /d/zz_archive && tar -C /d/zz_archive -xf - && mv /d/zz_archive/pg_wal/* /d/zz_archive/ 2>/dev/null; rm -rf /d/zz_archive/pg_wal /d/zz_archive/archive_status
      touch /d/recovery.signal; printf "%s\n" "restore_command = '"'"'cp /var/lib/postgresql/data/zz_archive/%f %p'"'"'" "recovery_target_action = '"'"'promote'"'"'" >> /d/postgresql.auto.conf
      chown -R postgres:postgres /d' < "$4"
  fi
  docker run -d --name $1 --network none -e POSTGRES_PASSWORD=x-not-a-secret -v $1:/var/lib/postgresql/data "$IMG" postgres -D /etc/postgresql >/dev/null
  waitdb $1
}

{
echo "== 087 restore suite on $IMG; orgs A=${A:0:16} B=${B:0:16}"
$OPENSSL genpkey -algorithm ed25519 -out "$OUT/auth/authority.key" 2>/dev/null; chmod 600 "$OUT/auth/authority.key"; $OPENSSL pkey -in "$OUT/auth/authority.key" -pubout -out "$OUT/auth/authority.pub"
q $DB "select recovery.owner_rebaseline('x3: new series for this part', 'alice', 'bob')" >/dev/null
q $DB "select recovery.owner_anchor('x3 install', 'alice', 'bob')" >/dev/null 2>&1   # (a permit for this server start may already exist)
chk "S0 genesis on the freshly re-applied 087" 'genesis lease=RENEWED' "$(AUTH_PGHOST=127.0.0.1 python3 -I "$TOOLS/authority.py" genesis "$OUT/auth" "$OUT/mirror" $DB 3600 2>&1)"
q $DB "select recovery.owner_open('alice', 'bob')" >/dev/null
ops $DB "$A" 10; ops $DB "$B" 5; AU $DB >/dev/null
echo "cold copy 1 at: $(heads $DB)"
cold_copy "$OUT/c1.tar"
q $DB "select recovery.owner_anchor('cold copy restart 1', 'alice', 'bob')" >/dev/null
chk "S1 after the cold-copy restart: anchored, renewed" 'renew lease=RENEWED' "$(AU $DB)"
PROD_B=$(q $DB "select id from products where org_id = '$B' limit 1"); P_BEFORE=$(q $DB "select price_mmk from products where id = '$PROD_B'")
ops $DB "$A" 7; ops $DB "$B" 3; q $DB "update products set price_mmk = price_mmk + 111 where id = '$PROD_B'" >/dev/null
chk "S2 renewed after 10 more operations and a price change" 'renew lease=RENEWED' "$(AU $DB)"
echo "source now: $(heads $DB); identity $(ident $DB)"
cold_copy "$OUT/wal.tar" /pg_wal
q $DB "select recovery.owner_anchor('cold copy restart 2', 'alice', 'bob')" >/dev/null
chk "S3 renewed after the second restart" 'renew lease=RENEWED' "$(AU $DB)"

echo; echo "---- R1 plain physical restore of cold copy 1 (same system id, timeline and OID; 10 operations + a price change lost)"
restore $N-r1 "$OUT/c1.tar"
chk "R1a identity unchanged (the identity check alone is blind here)" "^$(ident $DB)\$" "$(ident $N-r1)"
chk "R1b first write on the restore refused" 'LEASE_INVALID' "$(qe $N-r1 "insert into public.idempotency_keys (key, rpc, org_id, request_hash, state) values (gen_random_uuid(), 'zz_x3_rpc', '$A', 'x', 'committed')")"
chk "R1c lease row present and unexpired but issued before this server start" '^t\|t$' "$(q $N-r1 "select (valid_until > now())::text || '|' || (issued_at < pg_postmaster_start_time())::text from recovery.lease" | sed 's/true/t/g')"
cp -r "$OUT/auth" "$OUT/auth-r1"; cp -r "$OUT/mirror" "$OUT/mirror-r1"
chk "R1d authority pointed at the restore: refuses (server-wide), revokes" 'REFUSED .*(RESTART_NOT_ANCHORED|WAL_BEHIND|LEASE_SEQ_MISMATCH).*lease revoked' "$(AU $N-r1 "$OUT/auth-r1" "$OUT/mirror-r1")"
q $N-r1 "select recovery.owner_anchor('operator believes it is a restart', 'alice', 'bob')" >/dev/null
q $N-r1 "create table public.zz_junk (x text); insert into public.zz_junk select repeat('w', 200) from generate_series(1, 400000); checkpoint; select pg_switch_wal()" >/dev/null
R1E=$(AU $N-r1 "$OUT/auth-r1" "$OUT/mirror-r1")
chk "R1e anchored + WAL pushed past the high-water mark: still refused server-wide" 'REFUSED .*(LEASE_SEQ_MISMATCH|ROLLBACK_SCOPE_UNPROVEN|LOSS).*lease revoked' "$R1E"
chk "R1f ... and NOT renewed for the other organisation" '^0$' "$(grep -c 'lease=RENEWED' <<<"$R1E")"
chk "R1g org B (rolled-back price) cannot write on the restore" 'LEASE_INVALID' "$(qe $N-r1 "update products set price_mmk = price_mmk where id = '$PROD_B'")"
chk "R1h the restore really lost the price change (evidence of a silent catalogue rollback)" "^$P_BEFORE\$" "$(q $N-r1 "select price_mmk from products where id = '$PROD_B'")"
AU $DB >/dev/null
chk "G1 gate on the plain restore: LOSS_DETECTED" 'LOSS_DETECTED.*(WAL_BEHIND|LOSS)' "$(GATE $N-r1)"
docker rm -f -v $N-r1 >/dev/null; docker volume rm $N-r1 >/dev/null

echo; echo "---- R2 the same cold copy + WAL replay to the end (PITR, promoted to a new timeline)"
restore $N-r2 "$OUT/c1.tar" pitr "$OUT/wal.tar"
chk "R2a timeline advanced, system id unchanged" "^$(ident $DB | cut -d'|' -f1)\|2\|" "$(ident $N-r2)"
chk "R2b first write refused" 'IDENTITY_CHANGED|LEASE_INVALID' "$(qe $N-r2 "insert into public.idempotency_keys (key, rpc, org_id, request_hash, state) values (gen_random_uuid(), 'zz_x3_rpc', '$A', 'x', 'committed')")"
chk "R2c nothing lost: the replayed heads equal the source" "^$(heads $DB)\$" "$(heads $N-r2)"
AU $DB >/dev/null
chk "G2 gate on the full replay: CONSISTENT with a timeline note (does not reopen anything)" 'VERDICT CONSISTENT.*NOTE_TIMELINE_CHANGED' "$(GATE $N-r2)"
cp -r "$OUT/auth" "$OUT/auth-r2"; cp -r "$OUT/mirror" "$OUT/mirror-r2"
chk "G2b the authority still refuses it (identity changed: owner_begin / re-baseline required)" 'REFUSED .*IDENTITY_CHANGED' "$(AU $N-r2 "$OUT/auth-r2" "$OUT/mirror-r2")"
docker rm -f -v $N-r2 >/dev/null; docker volume rm $N-r2 >/dev/null

echo; echo "---- R3 same server: data-only reload of the ledger only (canary and recovery schema untouched)"
docker exec $DB pg_dump -U supabase_admin -d postgres -Fc -a -t public.idempotency_keys -f /tmp/zz-ledger.dump
ops $DB "$A" 3; chk "R3a renewed after 3 more operations" 'renew lease=RENEWED' "$(AU $DB)"
q $DB "alter table public.idempotency_keys disable trigger all; truncate public.idempotency_keys" >/dev/null
docker exec $DB pg_restore -U supabase_admin -d postgres -a --disable-triggers /tmp/zz-ledger.dump 2>&1 | head -2
q $DB "alter table public.idempotency_keys enable always trigger zz_recovery_guard, enable always trigger zz_recovery_truncate, enable always trigger zz_recovery_chain; alter table public.idempotency_keys enable trigger user" >/dev/null 2>&1
R3=$(AU $DB)
chk "R3b ledger rows vanished under an intact chain: REFUSED server-wide, lease revoked" 'REFUSED .*LEDGER_ROWS_VANISHED.*lease revoked' "$R3"
chk "R3c not renewed for the other organisation" '^0$' "$(grep -c 'lease=RENEWED' <<<"$R3")"
chk "R3d org B refused" 'LEASE_INVALID' "$(qe $DB "update products set price_mmk = price_mmk where id = '$PROD_B'")"
chk "G3 gate: CONFLICT (ledger rows != chained rows)" 'CONFLICT.*LEDGER_UNCHAINED_ROWS' "$(GATE $DB)"

echo; echo "== RESULT: $PASS passed, $FAIL failed"
} 2>&1 | tee "$OUT/X3.txt"
docker exec $DB rm -f /tmp/zz-ledger.dump >/dev/null 2>&1
