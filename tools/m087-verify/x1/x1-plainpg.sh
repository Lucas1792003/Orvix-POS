#!/usr/bin/env bash
# 087 restore matrix on PLAIN PostgreSQL 17 (pg_basebackup + WAL archive are available here, unlike in the Supabase image):
# plain physical, PITR, logical into a NEW server, same-server logical reload, restart, rolled-back / re-created / empty-mirror
# authority, rogue renewal, crash between renewal and confirmation, missing / tampered / gapped / stale / forked / email-only
# witnesses, till witnesses. The REAL tools/recovery-authority/{authority,gate}.py run against x1/fixture.sql: the 087 lease,
# chain, canary, authority and gate functions on a stand-in ledger table (public.ledger) instead of the Supabase schema.
# DISPOSABLE: containers/volumes zz-m087x1-* (--network none for restores), synthetic data, removed by exact name on exit.
#   tools/m087-verify/x1/x1-plainpg.sh RESULTS_DIR
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; ROOT=$(cd "$D/../../.." && pwd); TOOLS="$ROOT/tools/recovery-authority"
OUT="$(cd "$1" && pwd)/x1"; rm -rf "$OUT"; mkdir -p "$OUT/auth" "$OUT/mirror" "$OUT/w"
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
N=zz-m087x1; PW=x1-not-a-secret; A=org-a; B=org-b; LEASE=1800
ALL="$N-src $N-plain $N-pitr $N-fork $N-logical"
cleanup() { docker rm -f -v $ALL >/dev/null 2>&1; docker volume rm $N-arch $N-src $N-plain $N-pitr $N-fork >/dev/null 2>&1; }
trap cleanup EXIT; cleanup
q()  { docker exec "$1" psql -X -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c "$2"; }
qe() { docker exec "$1" psql -X -U "${3:-postgres}" -d postgres -At -v ON_ERROR_STOP=1 -c "$2" 2>&1 | sed -E 's/^(psql:[^E]*)?ERROR: +//' | grep -vE '^(SET|INSERT|DELETE|BEGIN|ROLLBACK|SAVEPOINT|RELEASE)' | head -1; }
waitpg() { for _ in $(seq 1 90); do docker exec "$1" pg_isready -U postgres >/dev/null 2>&1 && q "$1" "select 1" >/dev/null 2>&1 && return 0; sleep 1; done; docker logs "$1" 2>&1 | tail -15; return 1; }
AU() { python3 -I "$TOOLS/authority.py" "$1" "${4:-$OUT/auth}" "${5:-$OUT/mirror}" "$2" ${3:-$LEASE} 2>&1; }      # CMD CONTAINER [LEASE] [STATE] [MIRROR]
ATT() { python3 -I "$TOOLS/authority.py" attest "${2:-$OUT/auth}" "${3:-$OUT/mirror}" "$1" "$OUT/att.json" >/dev/null 2>&1; }
G()  { local db=$1; shift; python3 -I "$TOOLS/gate.py" --db "$db" --pub "$OUT/auth/authority.pub" "$@"; echo "  (exit $?)"; }
NONCE() { python3 -I "$TOOLS/gate.py" --issue-nonce --pub "$OUT/auth/authority.pub"; }                    # issued by the gate
GA() { local db=$1; shift; local n; n=$(NONCE); ATT "$n"; G "$db" --attest "$OUT/att.json" --nonce "$n" "$@"; }   # gate with a fresh attestation
ROGUE() { docker exec -i "$1" psql -X -U recovery_authority -d postgres -At -c "select recovery.authority_renew($2, 600, pg_postmaster_start_time(), ${3:-false}, encode(sha256(random()::text::bytea), 'hex'))" 2>&1; }   # a credential holder
T()  { q "$1" "select recovery.till_witness('$2', '$3')" > "$OUT/w/$4.json"; }
PASS=0; FAIL=0
chk() { local v; v=$(tr '\n' ' ' <<<"$3" | sed -E 's/ +$//'); if grep -qE -- "$2" <<<"$v"; then PASS=$((PASS+1)); r=PASS; else FAIL=$((FAIL+1)); r=FAIL; fi; printf '%-4s %-76s %s\n' "$r" "$1" "$(cut -c1-170 <<<"$v")"; }
heads() { q "$1" "select string_agg(org_id||':n='||n, ' ' order by org_id) from recovery.org_chain"; }
$OPENSSL genpkey -algorithm ed25519 -out "$OUT/auth/authority.key" 2>/dev/null; chmod 600 "$OUT/auth/authority.key"
$OPENSSL pkey -in "$OUT/auth/authority.key" -pubout -out "$OUT/auth/authority.pub"

{
echo "== setup: postgres:17 + WAL archive; core31.sql (pg_catalog-only HMAC, installs without lease); authority + mirror + key on the HOST"
docker volume create $N-arch >/dev/null; docker volume create $N-src >/dev/null
docker run -d --name $N-src -e POSTGRES_PASSWORD=$PW -e POSTGRES_HOST_AUTH_METHOD=trust -v $N-arch:/archive -v $N-src:/var/lib/postgresql/data postgres:17 \
  -c wal_level=replica -c archive_mode=on -c "archive_command=test ! -f /archive/%f && cp %p /archive/%f" >/dev/null
waitpg $N-src || exit 1; docker exec $N-src sh -c 'chown postgres /archive'
docker exec -i $N-src psql -X -U postgres -d postgres -q -v ON_ERROR_STOP=1 < "$D/fixture.sql" > "$OUT/core.log" 2>&1 || { tail -5 "$OUT/core.log"; exit 1; }
chk "H0 pg_catalog HMAC = RFC 2104 HMAC-SHA256 (python hmac)" "^$(python3 -I -c 'import hmac,hashlib;print(hmac.new(b"k"*40,b"msg",hashlib.sha256).hexdigest())')\$" "$(q $N-src "select encode(recovery.hmac_sha256('msg'::bytea, convert_to(repeat('k',40),'UTF8')),'hex')")"
chk "H0b no function in schema recovery references a non-pg_catalog schema function" '^0$' "$(q $N-src "select count(*) from pg_proc where pronamespace='recovery'::regnamespace and prosrc ~ '(public|extensions)\.[a-z_]+\('")"

echo; echo "---- install, anchor, genesis-once, monotonic seq"
chk "R1 fresh install: commit refused" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
q $N-src "select recovery.owner_anchor('install', 'alice', 'bob')" >/dev/null
chk "R3 genesis" 'genesis lease=RENEWED' "$(AU genesis $N-src)"
for i in 1 2 3 4; do q $N-src "select commit_ops('$A', 10)" >/dev/null; done; for i in 1 2; do q $N-src "select commit_ops('$B', 10)" >/dev/null; done
chk "R3b commits with a valid lease" "$A:n=40 $B:n=20" "$(heads $N-src)"
chk "D3 second genesis with a NEW empty state dir + same key: refused (mirror exists)" 'genesis refused|REFUSED AUTHORITY_ROLLED_BACK' "$(mkdir -p "$OUT/fresh"; cp "$OUT/auth/authority.key" "$OUT/auth/authority.pub" "$OUT/fresh/"; AU genesis $N-src $LEASE "$OUT/fresh")"
chk "D3b ... and with a new empty mirror too: refused by the DATABASE (one genesis per install)" 'REFUSED GENESIS_ALREADY_DONE' "$(mkdir -p "$OUT/fresh2" "$OUT/fresh2m"; cp "$OUT/auth/authority.key" "$OUT/auth/authority.pub" "$OUT/fresh2/"; AU genesis $N-src $LEASE "$OUT/fresh2" "$OUT/fresh2m")"
chk "D3c ... and that refusal revoked the lease (fail closed, re-renewed next tick)" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "R5c real authority renews again" 'renew lease=RENEWED' "$(AU tick $N-src)"
chk "D2b DB refuses a huge seq jump (one stolen-credential call cannot block renewals forever)" 'SEQ_JUMP_TOO_LARGE' "$(qe $N-src "select recovery.authority_renew(2147483647, 600, pg_postmaster_start_time(), false, repeat('a', 64))" recovery_authority)"
chk "D2 DB refuses a non-increasing seq (replayed / rolled-back authority)" 'SEQ_NOT_INCREASING' "$(qe $N-src "select recovery.authority_renew(1, 600, pg_postmaster_start_time(), false, repeat('a', 64))" recovery_authority)"
chk "D1 renewal inside a savepoint is never reported RENEWED" 'LEASE_NOT_EFFECTIVE' "$(qe $N-src "begin; savepoint s; select recovery.authority_renew(9999, 600, pg_postmaster_start_time(), false, repeat('a', 64)); rollback" recovery_authority)"
chk "R4 application role cannot touch / renew / revoke" 'permission denied' "$(qe $N-src "select recovery.authority_revoke()" app)"
chk "R4b gate role cannot renew" 'permission denied' "$(qe $N-src "select recovery.authority_renew(99999, 600, pg_postmaster_start_time(), false, repeat('a', 64))" recovery_gate)"
chk "R4c gate role reads evidence without superuser" '"chain"' "$(qe $N-src "select left(recovery.gate_evidence()::text, 40)" recovery_gate)"

echo; echo "---- history, backups, 35 operations a restore will lose; one REFUSED tick observes them (HIGH-2)"
T $N-src $A till-A1 T_A_n40
cp -r "$OUT/mirror/series" "$OUT/email1"
docker exec $N-src sh -c 'rm -rf /tmp/bb && pg_basebackup -U postgres -D /tmp/bb -Ft -X fetch -c fast >/dev/null 2>&1'
AU tick $N-src >/dev/null
for i in 1 2 3; do q $N-src "select commit_ops('$A', 10)" >/dev/null; done; q $N-src "select commit_ops('$B', 5)" >/dev/null
chk "D7 a tick that refuses (test hook) still signs what it observed, and revokes" 'REFUSED TEST_FORCED.*lease revoked' "$(AUTH_FORCE_REFUSE=x AU tick $N-src)"
chk "D7b writes stop immediately after the refusal (no 10-minute tail)" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
T $N-src $A till-A1 T_A_n70; T $N-src $B till-B1 T_B_n25
q $N-src "select pg_switch_wal()" >/dev/null; q $N-src "checkpoint" >/dev/null; sleep 2
docker cp $N-src:/tmp/bb/base.tar "$OUT/base.tar" >/dev/null
echo "source: $(heads $N-src) (last ACCEPTED record saw $A:40 $B:20; the REFUSED record saw $A:70 $B:25)"

restore_into() {
  docker volume create $1 >/dev/null
  docker run --rm -v $1:/d -v "$OUT":/in:ro --entrypoint sh postgres:17 -c 'mkdir -p /d/pgdata && cd /d/pgdata && tar -xf /in/base.tar && rm -f postmaster.pid && chown -R postgres:postgres /d && chmod 0700 /d/pgdata' >/dev/null
  [ "$2" = pitr ] && docker run --rm -v $1:/d --entrypoint sh postgres:17 -c '
      touch /d/pgdata/recovery.signal
      printf "%s\n" "restore_command = '"'"'cp /archive/%f %p'"'"'" "recovery_target_action = '"'"'promote'"'"'" >> /d/pgdata/postgresql.auto.conf
      chown postgres:postgres /d/pgdata/recovery.signal /d/pgdata/postgresql.auto.conf' >/dev/null
  docker run -d --name $1 --network none -e PGDATA=/d/pgdata -v $1:/d -v $N-arch:/archive:ro postgres:17 >/dev/null; waitpg $1
}

echo; echo "---- plain physical restore"
restore_into $N-plain plain
chk "R6 immediately after start: refused" 'LEASE_INVALID' "$(qe $N-plain "select commit_ops('$A', 1)")"
chk "G1 gate: LOSS proven by the REFUSED record (HIGH-2), not only accepted ones" 'LOSS_DETECTED.*refuse.*org-a.*missing|LOSS_DETECTED.*org-a.*refuse' "$(GA $N-plain --copy authority:"$OUT/mirror/series")"
cp -r "$OUT/auth" "$OUT/auth-rolled"; cp -r "$OUT/mirror" "$OUT/mirror-keep"
rm -f "$OUT/auth-rolled/series/"$(ls "$OUT/auth-rolled/series" | tail -2 | head -1) "$OUT/auth-rolled/series/"$(ls "$OUT/auth-rolled/series" | tail -1)
q $N-plain "select recovery.owner_anchor('routine', 'alice', 'bob')" >/dev/null
mkdir -p "$OUT/empty-mirror"
chk "D4e EMPTY mirror (deleted / unreadable) is a failure, not a pass (review r31 NEW-1)" 'REFUSED AUTHORITY_ROLLED_BACK' "$(cp -r "$OUT/auth" "$OUT/auth-em"; AU tick $N-plain $LEASE "$OUT/auth-em" "$OUT/empty-mirror")"
chk "D4 authority state ROLLED BACK (device restore) + routine anchor: refuses (mirror ahead), no renewal" 'REFUSED AUTHORITY_ROLLED_BACK' "$(AU tick $N-plain $LEASE "$OUT/auth-rolled" "$OUT/mirror-keep")"
chk "D4b restore still refused" 'LEASE_INVALID' "$(qe $N-plain "select commit_ops('$A', 1)")"
cp -r "$OUT/auth" "$OUT/auth-plain"; cp -r "$OUT/mirror" "$OUT/mirror-plain"
chk "R7 true authority vs the restore (anchored): refuses WAL_BEHIND + LOSS, holds" 'REFUSED .*WAL_BEHIND.*LOSS:org-a' "$(AU tick $N-plain $LEASE "$OUT/auth-plain" "$OUT/mirror-plain")"
chk "G2 no series" 'INCONCLUSIVE.*NO_VERIFIED_SERIES' "$(G $N-plain)"
chk "G3 email copy only" 'INCONCLUSIVE.*EMAIL_ONLY_NOT_PROOF' "$(G $N-plain --copy email:"$OUT/email1")"
chk "G5 OLD prefix presented as the authority copy + fresh attestation of the real head" 'CONFLICT.*ATTESTED_HEAD_MISMATCH' "$(GA $N-plain --copy authority:"$OUT/email1")"
chk "G5b same, generous --max-gap-s cannot loosen the rule; no attestation" 'INCONCLUSIVE.*NO_FRESH_ATTESTATION' "$(G $N-plain --copy authority:"$OUT/email1" --max-gap-s 100000000)"
chk "G6 attestation for a different nonce than the one the gate issued" 'ATTESTATION_INVALID' "$(n=$(NONCE); ATT othernonce; G $N-plain --copy authority:"$OUT/mirror/series" --attest "$OUT/att.json" --nonce "$n")"
chk "G6b a nonce the gate never issued (operator-chosen) is not accepted" '\[NONCE_NOT_ISSUED\].*\[NO_FRESH_ATTESTATION\]|\[NO_FRESH_ATTESTATION\].*\[NONCE_NOT_ISSUED\]' "$(ATT mynonce; G $N-plain --copy authority:"$OUT/mirror/series" --attest "$OUT/att.json" --nonce mynonce)"
chk "G7 copies diverge" 'CONFLICT.*SERIES_FORK' "$(AU tick $N-src >/dev/null; GA $N-plain --copy authority:"$OUT/mirror/series" --copy email:"$OUT/mirror-plain/series")"
chk "G9 email copy + a till that synced after the backup" 'LOSS_DETECTED.*till witness T_A_n70' "$(G $N-plain --copy email:"$OUT/email1" --till "$OUT/w/T_A_n70.json")"

echo; echo "---- PITR, restart, control"
restore_into $N-pitr pitr
chk "R8 PITR refused" 'IDENTITY_CHANGED|LEASE_INVALID' "$(qe $N-pitr "select commit_ops('$A', 1)")"
docker restart $N-src >/dev/null; waitpg $N-src
chk "R10 restart: refused" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "R10b authority: restart not anchored (and the earlier forced refusal does not block)" 'REFUSED RESTART_NOT_ANCHORED' "$(AU tick $N-src)"
q $N-src "select recovery.owner_anchor('planned restart', 'alice', 'bob')" >/dev/null
chk "R10c anchored: renewed" 'renew lease=RENEWED' "$(AU tick $N-src)"
chk "G13 control: live source, authority copy + email prefix, fresh attestation" 'VERDICT CONSISTENT' "$(AU tick $N-src >/dev/null; GA $N-src --copy authority:"$OUT/mirror/series" --copy email:"$OUT/email1")"
chk "G13b control without attestation is never CONSISTENT" 'INCONCLUSIVE.*NO_FRESH_ATTESTATION' "$(G $N-src --copy authority:"$OUT/mirror/series")"

echo; echo "---- authority robustness"
q $N-src "select commit_ops('o''q', 3)" >/dev/null
AU tick $N-src >/dev/null
chk "D9 org id containing a quote (now in the accepted heads): parameterised SQL, renew continues" "renew lease=RENEWED.*o'q:3" "$(AU tick $N-src)"
q $N-src "alter table ledger disable trigger all; insert into ledger values ('$B', gen_random_uuid(), 'committed', 'x'); alter table ledger enable always trigger zz_recovery_guard, enable always trigger zz_recovery_chain" >/dev/null
chk "D10 unchained ledger row in ONE org on an open server: that org held, lease still renewed (review r31 NEW-2)" 'renew lease=RENEWED HELD LEDGER_UNCHAINED:org-b' "$(AU tick $N-src)"
chk "D10b org-b writes refused" 'RECOVERY_HOLD' "$(qe $N-src "select commit_ops('$B', 1)")"
chk "D10c org-a (healthy) keeps writing" '^$' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "D10d next tick: still renews, org-b's epoch advanced once (idempotent hold)" 'renew lease=RENEWED HELD.* [|] 1$' "$(AU tick $N-src) | $(q $N-src "select epoch_no from recovery.org_state where org_id = 'org-b'")"
chk "D11 re-baseline needs two people" 'TWO_PEOPLE_REQUIRED' "$(qe $N-src "select recovery.owner_rebaseline('x', 'alice', 'alice')")"
chk "G15 attestation nonce is single use" 'NONCE_REUSED' "$(n=$(NONCE); ATT $n; G $N-src --copy authority:"$OUT/mirror/series" --attest "$OUT/att.json" --nonce $n >/dev/null; ATT $n; G $N-src --copy authority:"$OUT/mirror/series" --attest "$OUT/att.json" --nonce $n)"

echo; echo "---- review r32 R32-3: an authority error mid-tick refuses + revokes (never crashes silently)"
q $N-src "revoke execute on function recovery.authority_hash_at(text, bigint) from recovery_authority" >/dev/null
chk "C3 hash lookup fails: REFUSED AUTHORITY_ERROR, lease revoked" 'REFUSED .*AUTHORITY_ERROR.*lease revoked' "$(AU tick $N-src)"
q $N-src "grant execute on function recovery.authority_hash_at(text, bigint) to recovery_authority" >/dev/null
chk "C3b writes stop" 'LEASE_INVALID|RECOVERY_HOLD' "$(qe $N-src "select commit_ops('$A', 1)")"

echo; echo "---- review r32 R32-1 (a): plain restore + anchored restart + WAL pushed past the high-water mark: must stay SERVER-WIDE"
restore_into $N-fork plain
q $N-fork "select recovery.owner_anchor('operator thinks it is a restart', 'alice', 'bob')" >/dev/null
q $N-fork "create table public.zz_junk (x text); insert into public.zz_junk select repeat('w', 200) from generate_series(1, 300000); checkpoint; select pg_switch_wal()" >/dev/null
cp -r "$OUT/auth" "$OUT/auth-c1"; cp -r "$OUT/mirror" "$OUT/mirror-c1"
C1=$(AU tick $N-fork $LEASE "$OUT/auth-c1" "$OUT/mirror-c1")
chk "C1a WAL no longer behind, restart anchored: still REFUSED server-wide (lease seq / scope unproven)" 'REFUSED .*(LEASE_SEQ_MISMATCH|ROLLBACK_SCOPE_UNPROVEN).*lease revoked' "$C1"
chk "C1b ... and NOT renewed for the other org" '^0$' "$(grep -c 'lease=RENEWED' <<<"$C1")"
chk "C1c org-b (no ledger loss of its own) cannot write on the rolled-back server" 'LEASE_INVALID' "$(qe $N-fork "select commit_ops('$B', 1)")"

echo; echo "---- carried over from Revision 3 on the 3.1 code: tamper / gap, logical restore + chainless org, same-server reload"
mkdir -p "$OUT/tamper" "$OUT/gap" && cp "$OUT/mirror/series/"*.json "$OUT/tamper/" && cp "$OUT/mirror/series/"*.json "$OUT/gap/"
LASTF=$(ls "$OUT/tamper" | tail -1); python3 -I -c "
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['body']['generated_at']='2020-01-01T00:00:00+00:00'; json.dump(d,open(p,'w'))" "$OUT/tamper/$LASTF"
chk "G4 tampered record" 'INCONCLUSIVE.*RECORD_SIGNATURE_INVALID' "$(G $N-plain --copy authority:"$OUT/tamper")"
rm "$OUT/gap/$(ls "$OUT/gap" | sed -n 2p)"
chk "G4b record deleted from the middle" 'INCONCLUSIVE.*SERIES_GAP' "$(G $N-plain --copy authority:"$OUT/gap")"
docker exec $N-src pg_dump -U postgres -d postgres -Fc -f /tmp/new.dump; docker cp $N-src:/tmp/new.dump "$OUT/new.dump" >/dev/null
docker run -d --name $N-logical --network none -e POSTGRES_PASSWORD=$PW postgres:17 >/dev/null; waitpg $N-logical
docker exec -i $N-logical psql -X -U postgres -q -c "create role recovery_owner nologin; create role recovery_authority login; create role recovery_gate login; create role app login" >/dev/null
docker cp "$OUT/new.dump" $N-logical:/tmp/n.dump >/dev/null; docker exec $N-logical pg_restore -U postgres -d postgres /tmp/n.dump 2>&1 | grep -v 'already exists' | head -2
chk "R9 logical restore into a new server: refused" 'IDENTITY_CHANGED|LEASE_INVALID' "$(qe $N-logical "select commit_ops('$A', 1)")"
chk "R9b superuser replica mode: ALWAYS guard refuses" 'IDENTITY_CHANGED|LEASE_INVALID' "$(qe $N-logical "set session_replication_role = replica; insert into ledger values ('$A', gen_random_uuid(), 'committed', 'x')")"
q $N-logical "alter table ledger disable trigger all; insert into ledger values ('org-new', gen_random_uuid(), 'committed', 'x'); alter table ledger enable always trigger zz_recovery_guard, enable always trigger zz_recovery_chain" >/dev/null
chk "G12 gate: org with ledger rows and NO chain at all" 'CONFLICT.*LEDGER_UNCHAINED_ROWS.*org-new' "$(GA $N-logical --copy authority:"$OUT/mirror/series")"
q $N-src "select recovery.authority_hold('org-b', 'x')" >/dev/null 2>&1
q $N-src "delete from recovery.lease" >/dev/null; q $N-src "select recovery.owner_anchor('reload test', 'carol', 'dave')" >/dev/null 2>&1
q $N-src "alter table ledger disable trigger all; delete from ledger where request_hash = 'x'; alter table ledger enable always trigger zz_recovery_guard, enable always trigger zz_recovery_chain" >/dev/null
q $N-src "update recovery.org_state set held = false" >/dev/null
chk "R12 source back to consistent; authority renews" 'renew lease=RENEWED' "$(AU tick $N-src)"
echo "---- implementation review (DR M-b, M-d): unreadable series / mirror revokes; a one-record mirror hole is repaired"
cp -r "$OUT/auth" "$OUT/auth-mb"; cp -r "$OUT/mirror" "$OUT/mirror-mb"; echo '{"body": {"seq": ' > "$OUT/mirror-mb/series/$(ls "$OUT/mirror-mb/series" | tail -1)"
chk "MB1 corrupt mirror record: REFUSED AUTHORITY_FAILED, lease revoked (no traceback, no renewal)" '^REFUSED AUTHORITY_FAILED:JSONDecodeError.*lease revoked$' "$(AU tick $N-src $LEASE "$OUT/auth-mb" "$OUT/mirror-mb")"
chk "MB1b writes stop" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "MB2 missing signing tool: REFUSED AUTHORITY_FAILED, lease revoked" 'REFUSED AUTHORITY_FAILED.*lease revoked' "$(AU tick $N-src >/dev/null; OPENSSL=/nonexistent/openssl AU tick $N-src)"
chk "MB2b writes stop" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
AU tick $N-src >/dev/null; rm "$OUT/mirror/series/$(ls "$OUT/mirror/series" | tail -1)"   # a crash between the local and the mirror write
chk "MD1 mirror one record behind: repaired, then renewed" 'mirror repaired: seq [0-9]+ copied.*renew lease=RENEWED' "$(AU tick $N-src)"
chk "MD1b the gate on the mirror copy has no gap" 'VERDICT CONSISTENT' "$(GA $N-src --copy authority:"$OUT/mirror/series")"

docker exec $N-src pg_dump -U postgres -d postgres -Fc -f /tmp/recent.dump
q $N-src "select commit_ops('$A', 5)" >/dev/null; AU tick $N-src >/dev/null
q $N-src "drop schema public cascade; drop schema recovery cascade; create schema public; grant usage on schema public to public" >/dev/null 2>&1
docker exec $N-src pg_restore -U postgres -d postgres /tmp/recent.dump 2>&1 | grep -v 'already exists' | head -2
chk "R11 reloaded lease: unexpired, after server start, same server start" '^t\|t\|t$' "$(q $N-src "select (valid_until > now())::text||'|'||(issued_at > pg_postmaster_start_time())::text||'|'||(postmaster_start = pg_postmaster_start_time())::text from recovery.lease" | sed 's/true/t/g')"
chk "R11b ... but a COPY (xmin): refused" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "R11c authority: a copied lease row is a SERVER-WIDE reason -> refuses + revokes (not a per-org hold)" 'REFUSED .*LEASE_ROW_REPLACED.*lease revoked' "$(AU tick $N-src)"
chk "G14 gate: same-server reload (copied lease + canary, lost operations)" 'VERDICT CONFLICT.*LEASE_ROW_REPLACED.*\[LOSS\]|VERDICT CONFLICT.*\[LOSS\].*LEASE_ROW_REPLACED' "$(GA $N-src --copy authority:"$OUT/mirror/series")"
echo; echo "---- re-baseline (review r31 MED-6): two people -> archived old series -> new genesis -> writable"
q $N-src "select recovery.owner_rebaseline('accepted reload, reconciled offline', 'alice', 'bob')" >/dev/null
chk "RB1 after re-baseline: writes refused (no lease)" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
mv "$OUT/auth/series" "$OUT/auth/series-archived-1"; mv "$OUT/mirror/series" "$OUT/mirror/series-archived-1"
q $N-src "update recovery.org_state set held = false" >/dev/null
chk "RB2 new genesis on the new series (DB permits exactly one)" 'genesis lease=RENEWED' "$(AU genesis $N-src)"
chk "RB3 writes accepted again" '^$' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "RB4 a second genesis is refused again" 'GENESIS_ALREADY_DONE|genesis refused' "$(mkdir -p "$OUT/g2" "$OUT/g2m"; cp "$OUT/auth/authority.key" "$OUT/auth/authority.pub" "$OUT/g2/"; AU genesis $N-src $LEASE "$OUT/g2" "$OUT/g2m")"

echo; echo "---- review r33 R33-2: crash between the renewal commit and the record append"
MAXS=$(q $N-src "select max_seq from recovery.install")
chk "S5 crash between the renewal and its confirmation (test hook)" 'simulated crash' "$(AUTH_CRASH_AFTER_RENEW=1 AU tick $N-src)"
chk "S5a gate in the crash window: INCONCLUSIVE (lease on an unconfirmed intent)" 'INCONCLUSIVE.*LEASE_ON_UNCONFIRMED_INTENT' "$(GA $N-src --copy authority:"$OUT/mirror/series")"
chk "S5b next tick confirms the intent LATE (database unchanged) and renews" 'confirmed LATE.*renew lease=RENEWED' "$(AU tick $N-src)"
chk "S5c the series has no gap: gate CONSISTENT with a fresh attestation" 'VERDICT CONSISTENT' "$(GA $N-src --copy authority:"$OUT/mirror/series")"
MAXS=$(q $N-src "select max_seq from recovery.install")
chk "S6 the authority credential renews directly, without a signed intent (rogue)" '^RENEWED$' "$(docker exec -i $N-src psql -X -U recovery_authority -d postgres -At -c "select recovery.authority_renew($((MAXS + 1)), 600, pg_postmaster_start_time(), false, repeat('a', 64))")"
chk "S6a gate: CONFLICT ROGUE_RENEWAL" 'CONFLICT.*ROGUE_RENEWAL' "$(GA $N-src --copy authority:"$OUT/mirror/series")"
chk "S6b authority: REFUSED ROGUE_RENEWAL, revoked — never laundered as a crash" 'REFUSED .*ROGUE_RENEWAL.*lease revoked' "$(AU tick $N-src)"
q $N-src "select recovery.owner_rebaseline('rogue renewal investigated', 'alice', 'bob')" >/dev/null
mv "$OUT/auth/series" "$OUT/auth/series-archived-r"; mv "$OUT/mirror/series" "$OUT/mirror/series-archived-r"
chk "S6c recovery: two-person re-baseline + new series + genesis" 'genesis lease=RENEWED' "$(AU genesis $N-src)"
rebase() { q $N-src "select recovery.owner_rebaseline('$1', 'alice', 'bob')" >/dev/null; mv "$OUT/auth/series" "$OUT/auth/series-archived-$1"; mv "$OUT/mirror/series" "$OUT/mirror/series-archived-$1"; AU genesis $N-src; }

echo; echo "---- implementation review (DR H1): a credential holder cannot launder a renewal through one of OUR intents"
chk "S7 the authority crashes after signing an intent, before renewing" 'simulated crash before the renewal' "$(AUTH_CRASH_AFTER_INTENT=1 AU tick $N-src)"
SEQ7=$(ls "$OUT/auth/series" | tail -1 | sed 's/^0*//; s/\.json$//')
chk "S7a the credential holder renews under that signed seq ($SEQ7), with its own token: the DB accepts it" '^RENEWED$' "$(ROGUE $N-src $SEQ7)"
chk "S7b gate: CONFLICT ROGUE_RENEWAL (token does not match the intent)" 'CONFLICT.*ROGUE_RENEWAL.*one-time token' "$(GA $N-src --copy authority:"$OUT/mirror/series")"
S7C=$(AU tick $N-src)
chk "S7c authority: REFUSED ROGUE_RENEWAL, lease revoked, NOT confirmed late" 'REFUSED .*ROGUE_RENEWAL.*lease revoked' "$S7C"
chk "S7d ... no late confirmation was written" '^0$' "$(grep -c 'confirmed LATE' <<<"$S7C")"
chk "S7e recovery: re-baseline + genesis" 'genesis lease=RENEWED' "$(rebase s7)"
S8=$(AUTH_TEST_BEFORE_RENEW="docker exec -i $N-src psql -X -U recovery_authority -d postgres -At -c \"select recovery.authority_renew(\$AUTH_TEST_SEQ, 600, pg_postmaster_start_time(), false, encode(sha256(random()::text::bytea), 'hex'))\" >/dev/null" AU tick $N-src)
chk "S8 race: the credential holder renews under the authority's next seq between its intent and its renewal" 'REFUSED SEQ_NOT_INCREASING.*lease revoked' "$S8"
S8B=$(AU tick $N-src)
chk "S8b next tick: REFUSED ROGUE_RENEWAL, not confirmed late (the head is a refusal, the token is foreign)" 'REFUSED .*ROGUE_RENEWAL' "$S8B"
chk "S8c ... and it stays refused" 'REFUSED .*ROGUE_RENEWAL' "$(AU tick $N-src)"
chk "S8d gate: CONFLICT ROGUE_RENEWAL" 'CONFLICT.*ROGUE_RENEWAL' "$(GA $N-src --copy authority:"$OUT/mirror/series")"
q $N-src "select recovery.owner_rebaseline('s9', 'alice', 'bob')" >/dev/null; mv "$OUT/auth/series" "$OUT/auth/series-archived-s8"; mv "$OUT/mirror/series" "$OUT/mirror/series-archived-s8"
chk "S9 after a re-baseline the credential holder takes the genesis first" '^RENEWED$' "$(ROGUE $N-src 1 true)"
chk "S9a the authority's genesis is refused by the DB" 'REFUSED GENESIS_ALREADY_DONE.*lease revoked' "$(AU genesis $N-src)"
S9B=$(AU tick $N-src)
chk "S9b next tick: refused, never confirmed late" 'REFUSED (NO_GENESIS|.*ROGUE_RENEWAL)' "$S9B"
chk "S9c ... no late confirmation" '^0$' "$(grep -c 'confirmed LATE' <<<"$S9B")"
chk "S9d writes stay refused" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "S9e recovery: re-baseline + genesis" 'genesis lease=RENEWED' "$(rebase s9b)"
echo "  (re-verification HIGH-N1: even a STOLEN token cannot be laundered; a held lock never makes a renewal wait)"
S10=$(AUTH_TEST_BEFORE_RENEW="docker exec -i $N-src psql -X -U recovery_authority -d postgres -At -c \"select recovery.authority_renew(\$AUTH_TEST_SEQ, 3600, pg_postmaster_start_time(), false, '\$AUTH_TEST_TOKEN')\" >/dev/null" AU tick $N-src)
chk "S10 a credential holder with the STOLEN one-time token renews first: the authority's own renewal is refused" 'REFUSED SEQ_NOT_INCREASING.*lease revoked' "$S10"
chk "S10a the stolen renewal really carries the intent's token hash (lease seq = that intent)" '^t$' "$(q $N-src "select (authority_seq = (select max_seq from recovery.install))::text from recovery.lease" | sed 's/true/t/')"
S10B=$(AU tick $N-src)
chk "S10b next tick: REFUSED ROGUE_RENEWAL (the DB refused our renewal of that seq), never confirmed late" 'REFUSED .*ROGUE_RENEWAL' "$S10B"
chk "S10c ... no late confirmation" '^0$' "$(grep -c 'confirmed LATE' <<<"$S10B")"
chk "S10d gate: CONFLICT ROGUE_RENEWAL (own renewal of that intent was refused)" 'CONFLICT.*ROGUE_RENEWAL.*was refused' "$(GA $N-src --copy authority:"$OUT/mirror/series")"
chk "S10e recovery: re-baseline + genesis" 'genesis lease=RENEWED' "$(rebase s10)"
( docker exec -i $N-src psql -X -U recovery_authority -d postgres -At -c "begin; select recovery.authority_renew(1, 600, pg_postmaster_start_time(), true, repeat('b', 64)); select pg_sleep(12); commit" >/dev/null 2>&1 ) & sleep 2
S11=$(AU tick $N-src); wait
chk "S11 a credential holder holds the install row lock: the authority does not wait; signed refusal, lease revoked" 'REFUSED AUTHORITY_ERROR.*(lock|55P03).*lease revoked' "$S11"
chk "S11b after the lock is released no renewal appears late: writes refused" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "S11c next tick renews normally" 'renew lease=RENEWED' "$(AU tick $N-src)"

echo; echo "---- review r33 R33-3: an org held for a genuine single-org issue + a PLANNED anchored restart"
q $N-src "alter table ledger disable trigger all; insert into ledger values ('$B', gen_random_uuid(), 'committed', 'y'); alter table ledger enable always trigger zz_recovery_guard, enable always trigger zz_recovery_chain" >/dev/null
chk "D10r-1 single-org finding: org-b held, lease renewed" 'renew lease=RENEWED HELD LEDGER_UNCHAINED:org-b' "$(AU tick $N-src)"
docker restart $N-src >/dev/null; waitpg $N-src
q $N-src "select recovery.owner_anchor('planned restart with org-b held', 'alice', 'bob')" >/dev/null
chk "D10r-2 after the anchored restart: unchanged known finding stays per-org, lease renewed" 'renew lease=RENEWED HELD LEDGER_UNCHAINED:org-b' "$(AU tick $N-src)"
chk "D10r-3 healthy org-a writes" '^$' "$(qe $N-src "select commit_ops('$A', 1)")"
chk "D10r-4 org-b still held" 'RECOVERY_HOLD' "$(qe $N-src "select commit_ops('$B', 1)")"
chk "D10r-5 crash in the confirmation window while org-b is held (DR M-a)" 'simulated crash' "$(AUTH_CRASH_AFTER_RENEW=1 AU tick $N-src)"
chk "D10r-6 next tick: the known held-org finding does not block the late confirmation; renewed, org-b still held" 'confirmed LATE.*renew lease=RENEWED HELD LEDGER_UNCHAINED:org-b' "$(AU tick $N-src)"
chk "D10r-7 healthy org-a writes (no server-wide outage)" '^$' "$(qe $N-src "select commit_ops('$A', 1)")"
q $N-src "alter table ledger disable trigger all; delete from ledger where request_hash = 'y'; alter table ledger enable always trigger zz_recovery_guard, enable always trigger zz_recovery_chain; update recovery.org_state set held = false" >/dev/null
AU tick $N-src >/dev/null

echo; echo "---- review r33 R33-1: SELECTIVE restore of public.ledger only (canary untouched)"
docker exec $N-src pg_dump -U postgres -d postgres -Fc -a -t public.ledger -f /tmp/ledger-only.dump
q $N-src "select commit_ops('$A', 3)" >/dev/null; AU tick $N-src >/dev/null
q $N-src "truncate public.ledger" >/dev/null
docker exec $N-src pg_restore -U postgres -d postgres -a --disable-triggers /tmp/ledger-only.dump 2>&1 | head -2
S3=$(AU tick $N-src)
chk "S3a ledger rows vanished under an intact chain: SERVER-WIDE refusal, lease revoked" 'REFUSED .*LEDGER_ROWS_VANISHED:org-a.*lease revoked' "$S3"
chk "S3b not renewed for org-b" '^0$' "$(grep -c 'lease=RENEWED' <<<"$S3")"
chk "S3c org-b refused" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$B', 1)")"
echo "  repair for the next test: owner re-baseline (two people) + new series"
q $N-src "select recovery.owner_rebaseline('test repair', 'alice', 'bob')" >/dev/null
mv "$OUT/auth/series" "$OUT/auth/series-archived-2"; mv "$OUT/mirror/series" "$OUT/mirror/series-archived-2"
q $N-src "update recovery.org_state set held = false" >/dev/null
q $N-src "alter table ledger disable trigger all; delete from recovery.chain_log; delete from recovery.org_chain; alter table ledger enable always trigger zz_recovery_guard, enable always trigger zz_recovery_chain" >/dev/null 2>&1
docker exec -i $N-src psql -X -U postgres -d postgres -q -c "set role recovery_owner; delete from recovery.chain_log; delete from recovery.org_chain; reset role; alter table ledger disable trigger all; create temp table t as select * from ledger; truncate ledger; alter table ledger enable always trigger zz_recovery_guard, enable always trigger zz_recovery_chain" >/dev/null 2>&1
chk "S3d re-baselined genesis" 'genesis lease=RENEWED' "$(AU genesis $N-src)"

echo; echo "---- review r32 R32-1 (b): data-only reload of ONLY the public schema (recovery schema untouched)"
AU tick $N-src >/dev/null
docker exec $N-src pg_dump -U postgres -d postgres -Fc -a -n public -f /tmp/public-data.dump
q $N-src "select commit_ops('$A', 3)" >/dev/null; q $N-src "select commit_ops('$B', 2)" >/dev/null
chk "C1d renew before the reload" 'renew lease=RENEWED' "$(AU tick $N-src)"
q $N-src "truncate public.ledger, public.zz_recovery_canary" >/dev/null
docker exec $N-src pg_restore -U postgres -d postgres -a --disable-triggers -n public /tmp/public-data.dump 2>&1 | head -2
C1E=$(AU tick $N-src)
chk "C1e public-only reload: canary copied/old -> REFUSED server-wide, lease revoked" 'REFUSED .*PUBLIC_CANARY_ROLLED_BACK.*lease revoked' "$C1E"
chk "C1f org-b (whose own ledger also rolled back) and org-a both refused" 'LEASE_INVALID' "$(qe $N-src "select commit_ops('$B', 1)")"
chk "C1g gate on the public-only reload: CONFLICT (copied canary), never CONSISTENT (DR M-c)" 'VERDICT CONFLICT.*PUBLIC_CANARY_ROLLED_BACK' "$(GA $N-src --copy authority:"$OUT/mirror/series")"

echo; echo "== RESULT: $PASS passed, $FAIL failed"
} 2>&1 | tee "$OUT/X1.txt"
