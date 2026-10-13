#!/usr/bin/env bash
# run.sh — email-tier test harness (Phase F). Runs on a workstation with Docker; bash 3.2-safe.
#   ./deploy/lucashome/backup/tests/email/run.sh
# Builds the Linux runner image, creates an isolated docker network, and runs suite.sh inside the
# runner. suite.sh starts its own disposable containers (all named $PHF_PREFIX-*, default phf-mail-*,
# plus phf-gm-e2e-restore for the Gmail API end-to-end restore): a supabase/postgres
# source DB with synthetic data, a fresh one for the restore, and a mailpit SMTP catcher. Synthetic
# data only; no real provider, mailbox, server or database is contacted. Everything is removed at
# the end (containers, network, the tmpfs holding the throwaway gpg keys).
#
# Inputs: BASELINE_SQL (schema-only hosted baseline, as for supabase/tests/phase-d/run.sh),
#         PHF_PG_IMAGE (default supabase/postgres:17.6.1.136), PHF_MAILPIT_IMAGE (default
#         axllent/mailpit:latest unless a local supabase mailpit image exists), PHF_PREFIX (container +
#         network name prefix, default phf-mail; e.g. PHF_PREFIX=phf-gm for a parallel run).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../../.." && pwd)"
BASELINE_SQL="${BASELINE_SQL:-$HOME/shwephala-migration/20261011T2347Z/schema.scrubbed.sql}"
PG_IMAGE="${PHF_PG_IMAGE:-supabase/postgres:17.6.1.136}"
PFX="${PHF_PREFIX:-phf-mail}"
case "$PFX" in phf-[a-z0-9]*) ;; *) echo "PHF_PREFIX must start with phf-"; exit 2 ;; esac
NET="$PFX-net"
RUNNER_IMAGE=phf-mail-runner:1
if [ -z "${PHF_MAILPIT_IMAGE:-}" ]; then
  if docker image inspect public.ecr.aws/supabase/mailpit:v1.30.2 >/dev/null 2>&1; then
    PHF_MAILPIT_IMAGE=public.ecr.aws/supabase/mailpit:v1.30.2
  else
    PHF_MAILPIT_IMAGE=axllent/mailpit:latest
  fi
fi

[ -f "$BASELINE_SQL" ] || { echo "BASELINE_SQL not found: $BASELINE_SQL"; exit 2; }
command -v docker >/dev/null || { echo "docker not found"; exit 2; }

teardown() {
  for c in "$PFX-runner" "$PFX-db" "$PFX-restore" "$PFX-smtp" phf-gm-e2e-restore; do docker rm -f "$c" >/dev/null 2>&1; done
  docker network rm "$NET" >/dev/null 2>&1
  return 0
}
trap teardown EXIT INT TERM

if command -v shellcheck >/dev/null; then
  echo "==> shellcheck (email tier scripts)"
  if shellcheck -x -S warning -e SC1091 "$REPO"/deploy/lucashome/backup/email-*.sh "$HERE"/suite.sh "$HERE"/suite-gmail.sh "$HERE"/docker-shim.sh "$HERE"/curl-shim.sh; then
    echo "shellcheck: clean"
  else
    echo "shellcheck: findings above"; SC_FAIL=1
  fi
fi

echo "==> runner image"
docker build -q -t "$RUNNER_IMAGE" -f "$HERE/Dockerfile.runner" "$HERE" >/dev/null || { echo "runner build failed"; exit 2; }
docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || docker pull "$PG_IMAGE" || exit 2
docker image inspect "$PHF_MAILPIT_IMAGE" >/dev/null 2>&1 || docker pull "$PHF_MAILPIT_IMAGE" || exit 2

teardown
docker network create "$NET" >/dev/null || exit 2
echo "==> suite (runner $PFX-runner, network $NET, mailpit $PHF_MAILPIT_IMAGE)"
docker run --rm --name "$PFX-runner" --network "$NET" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$REPO:/repo:ro" \
  -v "$BASELINE_SQL:/baseline/schema.sql:ro" \
  -v "$HERE/docker-shim.sh:/usr/local/bin/docker:ro" \
  --mount type=tmpfs,destination=/keys,tmpfs-size=16m \
  --mount type=tmpfs,destination=/tiny,tmpfs-size=512k \
  -e PHF_NET="$NET" -e PHF_PREFIX="$PFX" -e PHF_PG_IMAGE="$PG_IMAGE" -e PHF_MAILPIT_IMAGE="$PHF_MAILPIT_IMAGE" \
  "$RUNNER_IMAGE" bash /repo/deploy/lucashome/backup/tests/email/suite.sh
RC=$?
[ "${SC_FAIL:-0}" = 1 ] && [ "$RC" = 0 ] && RC=1
echo "==> exit $RC"
exit $RC
