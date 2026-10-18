#!/usr/bin/env bash
# Remove every QA tenant from the DISPOSABLE loopback stack (container phf-iso-db).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL=(docker exec -i phf-iso-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -q)
# Quiesce first: a request of an earlier part may still be finishing on the
# server (its client is gone); cleaning before it commits leaves its rows.
for _ in $(seq 1 60); do
  busy=$("${PSQL[@]}" -c "select count(*) from pg_stat_activity where backend_type = 'client backend' and state <> 'idle' and pid <> pg_backend_pid()")
  [ "$busy" = 0 ] && break
  sleep 0.5
done
for ts in $("${PSQL[@]}" -c "select substring(id from 'qa-org-(\d+)') from organizations where id like 'qa-org-%'"); do
  "${PSQL[@]}" -v ts="$ts" < "$ROOT/supabase/tests/phase-d/live/cleanup.sql" >/dev/null
done
"${PSQL[@]}" < "$ROOT/supabase/tests/phase-e/live/audit_purge.sql" >/dev/null
"${PSQL[@]}" < "$ROOT/supabase/tests/phase-d/live/verify_clean.sql" | tail -1 | cut -c1-40
