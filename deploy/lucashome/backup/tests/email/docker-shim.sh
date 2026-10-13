#!/usr/bin/env bash
# docker-shim.sh — installed as /usr/local/bin/docker inside the test runner (ahead of /usr/bin/docker).
# The backup scripts reach the database with `docker compose exec -T db <cmd>` (backup-lib.sh db_exec).
# In the test there is no compose project: map that one form onto `docker exec -i <test db container>`.
# Everything else passes through to the real CLI unchanged.
real=/usr/bin/docker
if [[ "${1:-}" == compose ]]; then
  shift
  while [[ $# -gt 0 && "$1" != exec ]]; do shift; done
  [[ "${1:-}" == exec ]] || { echo "docker-shim: only 'docker compose exec' is supported in tests" >&2; exit 2; }
  shift
  [[ "${1:-}" == -T ]] && shift
  svc="${1:-}"; shift || true
  [[ "$svc" == db ]] || { echo "docker-shim: unknown compose service '$svc'" >&2; exit 2; }
  exec "$real" exec -i -e PGPASSWORD="${PHF_DB_PW:-}" "${PHF_DB_CONTAINER:?}" "$@"
fi
exec "$real" "$@"
