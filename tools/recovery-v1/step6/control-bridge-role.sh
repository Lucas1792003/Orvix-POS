#!/usr/bin/env bash
# Step 6: create the POS login that Orvix Control uses for its network bridge (Control migration 223), on the DISPOSABLE
# loopback stack (container phf-iso-db), AFTER Recovery V1 is installed. This is the POS owner's deployment step:
#   * LOGIN, no attributes (not superuser / createrole / createdb / replication / bypassrls), at most 8 connections;
#   * a member of orvix_recovery_operator ONLY (inherit, no SET ROLE, no ADMIN), so it can execute the seven
#     recovery_v1.operator_* functions and nothing it would not get from that role (see R4-M3 for that role's extras);
#   * bounded sessions (statement, lock and idle-in-transaction timeouts);
#   * reserved in supautils like orvix_recovery_operator.
# The random password is written to OUT/bridge.env (0600) and never printed. The disposable POS database has no TLS, so the
# bridge is configured as an explicitly INSECURE DEVELOPMENT bridge (recorded by Control; production requires verify-full). Nothing about V1 changes (integrity checked).
#   control-bridge-role.sh OUT_DIR      -> prints {"user":"orvix_control_bridge","integrity":"none","memberships":[...]}
set -euo pipefail
umask 077
DB=phf-iso-db; OUT=$(mkdir -p "$1" && cd "$1" && pwd); U=orvix_control_bridge
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
q() { docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
[ "$(q "select to_regrole('orvix_recovery_operator') is not null")" = t ] || { echo "Recovery V1 is not installed"; exit 1; }
[ "$(q "select to_regrole('$U') is null")" = t ] || { echo "$U already exists"; exit 1; }
cur=$(q "show supautils.reserved_roles")
case ",$(echo "$cur" | tr -d ' ')," in *,$U,*) ;; *)
  q "alter system set supautils.reserved_roles = '$cur, $U'" >/dev/null; q "select pg_reload_conf()" >/dev/null; sleep 2;; esac
PW=$(openssl rand -hex 24)
# the password travels on stdin only (never on a command line)
printf "CREATE ROLE %s LOGIN NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '%s';\n\
GRANT orvix_recovery_operator TO %s WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;\n\
ALTER ROLE %s SET statement_timeout = '4s';\n\
ALTER ROLE %s SET lock_timeout = '3s';\n\
ALTER ROLE %s SET idle_in_transaction_session_timeout = '15s';\n" "$U" "$PW" "$U" "$U" "$U" "$U" \
  | docker exec -i "$DB" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q >/dev/null
printf 'ORVIX_POS_BRIDGE_HOST=phf-iso-db\nORVIX_POS_BRIDGE_PORT=5432\nORVIX_POS_BRIDGE_DBNAME=postgres\nORVIX_POS_BRIDGE_USER=%s\nORVIX_POS_BRIDGE_PASSWORD=%s\nORVIX_POS_BRIDGE_SSLMODE=disable\nORVIX_POS_BRIDGE_INSECURE_DEV=1\n' "$U" "$PW" > "$OUT/bridge.env"
unset PW
MEM=$(q "select coalesce(json_agg(g.rolname order by g.rolname), '[]') from pg_auth_members a join pg_roles g on g.oid = a.roleid join pg_roles r on r.oid = a.member where r.rolname = '$U'")
echo "{\"user\":\"$U\",\"integrity\":\"$(q "select coalesce(recovery_v1.integrity_problem(),'none')")\",\"memberships\":$MEM}"
