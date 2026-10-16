#!/usr/bin/env bash
# READ-ONLY live schema fingerprint of production (public + storage), for the
# parity check. Opens a read-only psql transaction inside the server's db
# container over SSH (BatchMode, no TTY), runs fingerprint.sql, saves the
# normalised output. Never writes, never dumps data, never prints a secret.
#
#   PHF_ISO_PARITY_SSH=<ssh host>  tools/security-audit/parity/live-parity.sh <outdir>
# The SSH host and stack dir are NOT hard-coded (publishable): supply them via
#   PHF_ISO_PARITY_SSH   (required; e.g. an entry in ~/.ssh/config)
#   PHF_ISO_PARITY_STACK (required with PHF_ISO_PARITY_SSH; the stack dir on the server)
#   PHF_ISO_PARITY_DBSVC (default db)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: live-parity.sh <outdir>}"
SSH="${PHF_ISO_PARITY_SSH:-}"
STACK="${PHF_ISO_PARITY_STACK:-}"
DBSVC="${PHF_ISO_PARITY_DBSVC:-db}"
mkdir -p "$OUT"
if [ -z "$SSH" ]; then
  echo "PHF_ISO_PARITY_SSH not set — skipping the live parity read (set it to run --parity)."
  echo "SKIPPED" > "$OUT/live.status"
  exit 0
fi
if [ -z "$STACK" ]; then
  echo "PHF_ISO_PARITY_STACK not set (the compose directory on the server; no default)."
  echo "FAILED" > "$OUT/live.status"
  exit 2
fi
# read-only: wrap in a read-only transaction; the container psql runs as the
# superuser but default_transaction_read_only blocks any accidental write.
ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH" \
  "cd '$STACK' && docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' '$DBSVC' psql -X -U postgres -d postgres -v ON_ERROR_STOP=1" \
  < "$HERE/fingerprint.sql" > "$OUT/live.fingerprint" 2> "$OUT/live.err"
rc=$?
if [ "$rc" != 0 ]; then
  echo "live parity read FAILED (rc=$rc):"; tail -5 "$OUT/live.err"
  echo "FAILED" > "$OUT/live.status"
  exit "$rc"
fi
# scrub any stray host name from the saved artifact (publishable)
sed -i.bak "s/${SSH//\//\\/}/<live-host>/g" "$OUT/live.fingerprint" 2>/dev/null || true
rm -f "$OUT/live.fingerprint.bak"
echo "live fingerprint: $(wc -l < "$OUT/live.fingerprint") lines"
echo "OK" > "$OUT/live.status"
