#!/usr/bin/env bash
# DISPOSABLE test stacks only: the host prerequisite of migration 087 (docs/selfhost-migration/phase-g/
# recovery-roles-prerequisite.md) — the recovery roles added to supautils.reserved_roles of a local test container
# (orvix-migtest-* / phf-iso-db / zz-m087*), by ALTER SYSTEM + reload. On lucashome this is a host config file instead.
#   lib/reserve-recovery-roles.sh CONTAINER
set -euo pipefail
CT=$1
[[ "$CT" =~ ^(orvix-migtest-[a-z0-9-]+|phf-iso-db|zz-m087[a-z0-9-]*)$ ]] || { echo "REFUSE: test containers only"; exit 3; }
case "${DOCKER_HOST:-unix://}" in unix://*) ;; *) echo "REFUSE: local docker only"; exit 3;; esac
q() { docker exec -i "$CT" psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
cur=$(q "show supautils.reserved_roles")
case ",$(echo "$cur" | tr -d ' ')," in *,recovery_owner,*recovery_authority,*recovery_gate,*) echo "already reserved"; exit 0;; esac
q "alter system set supautils.reserved_roles = '$cur, recovery_owner, recovery_authority, recovery_gate'" >/dev/null
q "select pg_reload_conf()" >/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do
  case ",$(q "show supautils.reserved_roles" | tr -d ' ')," in *,recovery_gate,*) echo "recovery roles reserved"; exit 0;; esac; sleep 1
done
echo "reserved roles not effective"; exit 1
