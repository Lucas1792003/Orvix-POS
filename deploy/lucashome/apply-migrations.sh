#!/usr/bin/env bash
# Apply repo migrations to the self-hosted Supabase database on lucashome, safely and verifiably.
#   mac$ deploy/lucashome/apply-migrations.sh --from 062 --to 066 --dry-run     # show what would run
#   mac$ deploy/lucashome/apply-migrations.sh --from 062 --to 066               # needs owner approval first
# Steps: pre-flight → fresh logical + base backup → record LSN → copy files → ONE psql transaction for all
# migrations (ON_ERROR_STOP; a failure applies nothing) → record versions in supabase_migrations → supabase_admin
# default-ACL hardening → verification queries → post logical backup. Never prints secrets.
set -euo pipefail
HOST=${HOST:-lucashome}; STACK=/srv/supabase/stack; BK=/srv/supabase/backup/bin
REPO=$(cd "$(dirname "$0")/../.." && pwd); MIG="$REPO/supabase/migrations"
FROM=""; TO=""; DRY=0
while [ $# -gt 0 ]; do case "$1" in --from) FROM=$2; shift 2;; --to) TO=$2; shift 2;; --dry-run) DRY=1; shift;; *) echo "unknown arg $1"; exit 2;; esac; done
[ -n "$FROM" ] && [ -n "$TO" ] || { echo "usage: --from NNN --to NNN [--dry-run]"; exit 2; }
FILES=$(ls "$MIG" | grep -E '^[0-9]{3}_.*\.sql$' | awk -v f="$FROM" -v t="$TO" '{v=substr($0,1,3); if (v>=f && v<=t) print}')
[ -n "$FILES" ] || { echo "no migrations in range"; exit 2; }
echo "migrations to apply (in order):"; echo "$FILES" | sed 's/^/  /'
rs() { ssh -o BatchMode=yes "$HOST" "$@"; }
dbx() { rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At $*"; }

echo "== pre-flight =="
rs "cd $STACK && docker compose ps --format '{{.Status}}' | grep -c healthy" | xargs -I{} echo "healthy containers: {}"
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -Atc \"select 'applied: '||string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '$FROM'\" </dev/null"
rs "$BK/backup-status.sh >/dev/null 2>&1 && echo 'backup status: OK' || { echo 'backup status: PROBLEMS - stop'; exit 1; }"
if [ "$DRY" = 1 ]; then echo "dry-run: stopping before any change"; exit 0; fi

echo "== pre-migration backups + LSN =="
rs "$BK/backup-logical.sh >/dev/null && $BK/backup-base.sh >/dev/null && echo 'backups ok'"
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -Atc 'select pg_current_wal_lsn(), now()' </dev/null | tee -a /srv/supabase/backups/migration-checkpoints.txt"

echo "== copy files =="
TMP=$(rs 'mktemp -d /tmp/mig.XXXXXX'); for f in $FILES; do scp -q "$MIG/$f" "$HOST:$TMP/$f"; done
rs "cd $STACK && docker compose cp $TMP db:/tmp/mig >/dev/null && rm -rf $TMP"

echo "== apply (single transaction) =="
ARGS=""; for f in $FILES; do ARGS="$ARGS --file /tmp/mig/$f"; done
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction $ARGS </dev/null" 2>&1 | grep -vE '^(CREATE|ALTER|GRANT|REVOKE|DROP|INSERT|COMMENT|NOTIFY|DO|SET|BEGIN|COMMIT|UPDATE|DELETE)( |$)' | grep -v '^$' || true

echo "== record versions =="
VALS=$(echo "$FILES" | awk '{v=substr($0,1,3); n=substr($0,5); sub(/\.sql$/,"",n); printf "(%s%s%s, ARRAY[]::text[], %s%s%s),", "\047", v, "\047", "\047", n, "\047"}' | sed 's/,$//')
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -Atc \"insert into supabase_migrations.schema_migrations(version, statements, name) values $VALS on conflict (version) do nothing; select 'migrations now: '||count(*)||' max '||max(version) from supabase_migrations.schema_migrations\" </dev/null"

echo "== supabase_admin default-ACL hardening (self-host image only; see supabase/baseline/README.md) =="
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -Atc 'alter default privileges for role supabase_admin in schema public revoke execute on functions from anon, public; alter default privileges for role supabase_admin in schema public revoke all on tables from anon' </dev/null"

echo "== verification =="
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -At -F '|' -c \"select r.rolname, count(*) filter (where has_function_privilege(r.rolname, p.oid, 'EXECUTE')) as can_exec, count(*) as total from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join (values ('anon'),('authenticated'),('service_role')) r(rolname) where n.nspname = 'public' group by 1 order by 1\" </dev/null"
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -Atc \"select 'anon-executable: '||coalesce(string_agg(p.proname, ','),'none') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and has_function_privilege('anon', p.oid, 'EXECUTE')\" </dev/null"
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -Atc \"select 'idempotency_keys: rls='||relrowsecurity||' policies='||(select count(*) from pg_policies where tablename='idempotency_keys') from pg_class where oid='public.idempotency_keys'::regclass\" </dev/null"
rs "cd $STACK && docker compose exec -T db psql -U supabase_admin -d postgres -Atc \"select 'rpcs with p_idempotency_key: '||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and pg_get_function_identity_arguments(p.oid) like '%p_idempotency_key%'\" </dev/null"
rs "cd $STACK && docker compose exec -T db rm -rf /tmp/mig </dev/null"

echo "== post-migration backup =="
rs "$BK/backup-logical.sh >/dev/null && echo 'post-migration logical backup ok'"
echo "done"
