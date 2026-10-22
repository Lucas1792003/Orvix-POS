#!/usr/bin/env bash
# Apply repo migrations to the self-hosted Supabase database on lucashome, safely and verifiably.
#   mac$ deploy/lucashome/apply-migrations.sh --from 086 --to 086 --dry-run     # plan only: checks, no change
#   mac$ deploy/lucashome/apply-migrations.sh --from 086 --to 086               # needs owner approval first
#   mac$ deploy/lucashome/apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty [--dry-run]
# Steps: pre-flight → snapshot of the ledger + 086 lineage facts → plan (migration_plan.py: refuses gaps,
# re-runs, out-of-order and held versions, checksum mismatches, unknown ledger states and statements that
# cannot run in one transaction) → fresh logical + base backup → record LSN → copy the bundle (sha256-verified)
# → ONE psql --single-transaction: runner guard (one runner at a time, bounded lock_timeout, ledger locked
# and re-checked) + the migrations + their ledger rows with each file's sha256 (a failure applies and records
# nothing) → supabase_admin default-ACL hardening → verification queries → post logical backup.
# A rollback runs the same way with supabase/rollbacks/NNN_*.rollback.sql, which removes its own ledger row
# only after its post-checks pass. Held versions (084) are never applied implicitly; --allow-skipped applies
# a held version only while nothing newer is recorded — 084 now needs a new version number.
# Never prints secrets. Never edits ledger history and never applies a migration that was not selected.
set -euo pipefail
HOST=${HOST:-lucashome}; STACK=/srv/supabase/stack; BK=/srv/supabase/backup/bin
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
MIG="$REPO/supabase/migrations"; RB="$REPO/supabase/rollbacks"; HELD=084; DB_USER=supabase_admin
FROM=""; TO=""; DRY=0; ROLLBACK=""; CONFIRM=0; ALLOW_SKIPPED=0; RV1_REVIEWED=0
while [ $# -gt 0 ]; do case "$1" in
  --from) FROM=$2; shift 2;; --to) TO=$2; shift 2;; --dry-run) DRY=1; shift;;
  --rollback) ROLLBACK=$2; shift 2;; --owner-confirmed-till-queues-empty) CONFIRM=1; shift;;
  --allow-skipped) ALLOW_SKIPPED=1; shift;;
  --recovery-v1-reviewed) RV1_REVIEWED=1; shift;;   # only with Recovery V1 installed; never for 086/087
  *) echo "unknown arg $1"; exit 2;; esac; done
if [ -n "$ROLLBACK" ]; then [ -z "$FROM$TO" ] || { echo "--rollback takes no --from/--to"; exit 2; }
else [ -n "$FROM" ] && [ -n "$TO" ] || { echo "usage: --from NNN --to NNN [--dry-run] | --rollback NNN --owner-confirmed-till-queues-empty [--dry-run]"; exit 2; }; fi

# Test target (deploy/lucashome/tests/apply-migrations-test.sh): a LOCAL disposable container instead of
# lucashome — no ssh, no backups, no ACL step. Only orvix-migtest-* or the phf-iso-db audit stack.
TEST_CT=${APPLY_MIGRATIONS_TEST_CONTAINER:-}
if [ -n "$TEST_CT" ]; then
  [[ "$TEST_CT" =~ ^(orvix-migtest-[a-z0-9-]+|phf-iso-db)$ ]] || { echo "REFUSE: test container must be orvix-migtest-* or phf-iso-db"; exit 3; }
  case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: test mode needs the local docker socket"; exit 3;; esac
  MIG=${APPLY_MIGRATIONS_TEST_MIGRATIONS:-$MIG}; RB=${APPLY_MIGRATIONS_TEST_ROLLBACKS:-$RB}
  DB_USER=${APPLY_MIGRATIONS_TEST_DB_USER:-$DB_USER}; HELD=${APPLY_MIGRATIONS_TEST_HELD-$HELD}
  echo "TEST TARGET: local container $TEST_CT (no backups)"
  in_db() { docker exec -i "$TEST_CT" "$@"; }
  put_dir() { docker cp "$1" "$TEST_CT:$2" >/dev/null; }
else
  rs() { ssh -o BatchMode=yes "$HOST" "$@"; }
  in_db() { rs "cd $STACK && docker compose exec -T db $*"; }
  put_dir() { local t; t=$(rs 'mktemp -d /tmp/mig.XXXXXX'); scp -q "$1"/* "$HOST:$t/"; rs "cd $STACK && docker compose cp $t db:$2 >/dev/null && rm -rf $t"; }
fi
# every query goes in on stdin: no shell quoting of SQL across ssh
q() { in_db psql -X -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -At; }

echo "== pre-flight =="
if [ -z "$TEST_CT" ]; then
  rs "cd $STACK && docker compose ps --format '{{.Status}}' | grep -c healthy" | xargs -I{} echo "healthy containers: {}"
  rs "$BK/backup-status.sh >/dev/null 2>&1 && echo 'backup status: OK' || { echo 'backup status: PROBLEMS - stop'; exit 1; }"
fi
W=$(mktemp -d); RUN="mig-$(date +%Y%m%dT%H%M%S)-$$"; CT_DIR="/tmp/$RUN"
cleanup() { rm -rf "$W"; in_db rm -rf "$CT_DIR" </dev/null >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Snapshot: ledger rows (version, the sha256 entries of statements only — never statement text) and the
# facts the guard re-checks under its lock. to_jsonb keeps the query valid if a column is missing.
q > "$W/snapshot.txt" <<'SQL'
SELECT 'F' || E'\t' || 'ledger_md5' || E'\t' || (SELECT md5(coalesce(string_agg(version || ':' || coalesce(to_jsonb(m)->>'statements', ''), '|' ORDER BY version), '')) FROM supabase_migrations.schema_migrations m);
SELECT 'F' || E'\t' || 'ledger_cols' || E'\t' || (SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = 'supabase_migrations.schema_migrations'::regclass AND attnum > 0 AND NOT attisdropped);
SELECT 'F' || E'\t' || 'has_op_execute' || E'\t' || CASE WHEN to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NOT NULL THEN 't' ELSE 'f' END;
SELECT 'F' || E'\t' || 'has_recovery_v1' || E'\t' || CASE WHEN to_regnamespace('recovery_v1') IS NOT NULL THEN 't' ELSE 'f' END;
SELECT 'F' || E'\t' || 'has_v87' || E'\t' || CASE WHEN to_regnamespace('recovery') IS NOT NULL OR to_regprocedure('public.op_execute_v87(uuid,text,jsonb,text,jsonb)') IS NOT NULL THEN 't' ELSE 'f' END;
SELECT 'F' || E'\t' || 'idem_pk' || E'\t' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum WHERE c.conrelid = to_regclass('public.idempotency_keys') AND c.contype = 'p'), '');
SELECT 'L' || E'\t' || version || E'\t' || coalesce((SELECT string_agg(s, ',') FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(to_jsonb(m)->'statements') = 'array' THEN to_jsonb(m)->'statements' ELSE '[]' END) s WHERE s LIKE 'sha256:%'), '') || E'\t' || coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(to_jsonb(m)->'statements') = 'array' THEN to_jsonb(m)->'statements' ELSE '[]' END), 0) FROM supabase_migrations.schema_migrations m ORDER BY version;
SQL
grep '^F' "$W/snapshot.txt" | cut -f2- > "$W/facts.tsv" || true
grep '^L' "$W/snapshot.txt" | cut -f2- > "$W/ledger.tsv" || true
echo "recorded: $(wc -l < "$W/ledger.tsv" | tr -d ' ') versions, newest $(tail -1 "$W/ledger.tsv" | cut -f1)"

echo "== plan =="
FLAGS=()
[ "$CONFIRM" = 1 ] && FLAGS+=(--owner-confirmed-till-queues-empty)
[ "$ALLOW_SKIPPED" = 1 ] && FLAGS+=(--allow-skipped)
if [ -n "$ROLLBACK" ]; then
  python3 -I "$HERE/migration_plan.py" rollback --migrations "$MIG" --rollbacks "$RB" --ledger "$W/ledger.tsv" --facts "$W/facts.tsv" \
    --version "$ROLLBACK" ${FLAGS[@]+"${FLAGS[@]}"} --out "$W/plan" || exit 2
else
  python3 -I "$HERE/migration_plan.py" forward --migrations "$MIG" --ledger "$W/ledger.tsv" --facts "$W/facts.tsv" \
    --from "$FROM" --to "$TO" --held "$HELD" ${FLAGS[@]+"${FLAGS[@]}"} $([ "$RV1_REVIEWED" = 1 ] && echo --recovery-v1-reviewed) --out "$W/plan" || exit 2
fi
mkdir "$W/bundle"
while read -r f; do
  if [ -f "$W/plan/$f" ]; then cp "$W/plan/$f" "$W/bundle/$f"
  elif [ -n "$ROLLBACK" ]; then cp "$RB/$f" "$W/bundle/$f"
  else cp "$MIG/$f" "$W/bundle/$f"; fi
done < "$W/plan/files.txt"
if [ "$DRY" = 1 ]; then echo "dry-run: stopping before any change"; exit 0; fi

if [ -z "$TEST_CT" ]; then
  echo "== pre-migration backups + LSN =="
  rs "$BK/backup-logical.sh >/dev/null && $BK/backup-base.sh >/dev/null && echo 'backups ok'"
  rs "cd $STACK && docker compose exec -T db psql -X -U supabase_admin -d postgres -Atc 'select pg_current_wal_lsn(), now()' </dev/null | tee -a /srv/supabase/backups/migration-checkpoints.txt"
fi

echo "== copy bundle =="
# A per-run directory: never an earlier run's files, never another runner's.
put_dir "$W/bundle" "$CT_DIR"
while read -r f; do
  want=$(shasum -a 256 "$W/bundle/$f" | cut -c1-64)
  got=$(in_db sha256sum "$CT_DIR/$f" </dev/null | cut -c1-64)
  [ "$want" = "$got" ] || { echo "COPY MISMATCH for $f: the file in the container is not the planned file; nothing applied."; exit 1; }
done < "$W/plan/files.txt"

echo "== apply (single transaction: guard + $([ -n "$ROLLBACK" ] && echo "rollback $ROLLBACK" || echo "migrations + ledger record")) =="
ARGS=""; while read -r f; do ARGS="$ARGS --file $CT_DIR/$f"; done < "$W/plan/files.txt"
# psql's exit status decides (ON_ERROR_STOP + --single-transaction: any error rolls everything back and
# exits non-zero). The ledger rows are written in the SAME transaction: applied <=> recorded.
interrupted() {
  echo "INTERRUPTED during the apply: the transaction may still COMMIT on the server. The ledger rows are in the same"
  echo "transaction, so the ledger tells: re-run with --dry-run and read 'recorded:'. Never re-run blindly."
  exit 130
}
trap interrupted INT TERM
set +e
OUT=$(in_db psql -X -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 --single-transaction $ARGS </dev/null 2>&1)
RC=$?
set -e
trap - INT TERM
printf '%s\n' "$OUT" | grep -vE '^(CREATE|ALTER|GRANT|REVOKE|DROP|INSERT|COMMENT|NOTIFY|DO|SET|BEGIN|COMMIT|UPDATE|DELETE|LOCK)( |$)' | grep -v '^$' || true
if [ "$RC" -ne 0 ]; then
  if printf '%s\n' "$OUT" | grep -q RUNNER_TRANSACTION_BROKEN; then
    # a migration ended the runner's transaction: what ran before that point may be COMMITTED
    echo "PARTIALLY COMMITTED (psql exit $RC): a migration ended the runner's transaction. Statements before that point may be"
    echo "committed; NOTHING is recorded in the ledger. Owner review — do NOT re-run this migration as it is."
    exit 4
  elif [ "$RC" -eq 3 ] || [ "$RC" -eq 1 ]; then
    # psql: 3 = an SQL error under ON_ERROR_STOP (rolled back), 1 = psql refused to start (e.g. a missing file).
    echo "FAILED (psql exit $RC): the transaction was rolled back; nothing was applied or recorded, the ledger is unchanged."
  else
    # 2 = connection lost, 255 = ssh failed: the COMMIT may or may not have happened.
    echo "OUTCOME UNKNOWN (exit $RC): the connection was lost. The ledger rows were in the same transaction, so the"
    echo "ledger tells: re-run with --dry-run and read 'recorded:'. Never re-run blindly."
  fi
  exit 1
fi
echo "COMMITTED: applied and recorded in one transaction."
echo "ledger now: $(echo "select count(*) || ' versions, newest ' || max(version) from supabase_migrations.schema_migrations" | q || echo '(could not read it back — check by hand)')"
post_fail() { echo "POST-STEP FAILED: the migrations above ARE committed and recorded; only this follow-up step failed — run it by hand."; }
set -E   # the ERR trap also fires inside q()/rs()
trap post_fail ERR
[ -n "$TEST_CT" ] && { echo "done (test target)"; exit 0; }

echo "== supabase_admin default-ACL hardening (self-host image only; see supabase/baseline/README.md) =="
q <<'SQL'
alter default privileges for role supabase_admin in schema public revoke execute on functions from anon, public;
alter default privileges for role supabase_admin in schema public revoke all on tables from anon;
SQL

echo "== verification =="
q <<'SQL'
select r.rolname || '|' || count(*) filter (where has_function_privilege(r.rolname, p.oid, 'EXECUTE')) || '|' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join (values ('anon'),('authenticated'),('service_role')) r(rolname) where n.nspname = 'public' group by r.rolname order by 1;
select 'anon-executable: ' || coalesce(string_agg(p.proname, ','), 'none') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');
select 'idempotency_keys: rls=' || relrowsecurity || ' policies=' || (select count(*) from pg_policies where tablename = 'idempotency_keys') from pg_class where oid = 'public.idempotency_keys'::regclass;
select 'rpcs with p_idempotency_key: ' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and pg_get_function_identity_arguments(p.oid) like '%p_idempotency_key%';
SQL

echo "== post-migration backup =="
rs "$BK/backup-logical.sh >/dev/null && echo 'post-migration logical backup ok'"
echo "done"
