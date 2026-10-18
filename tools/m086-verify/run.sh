#!/usr/bin/env bash
# Migration 086 verification on a DISPOSABLE loopback stack (never a real server).
#
#   tools/m086-verify/run.sh [TAG]            fresh stack (085, 084 skipped), every part, then teardown
#   PARTS="db client" tools/m086-verify/run.sh TAG     selected parts
#   KEEP=1 ...                                 leave the stack up (debugging)
#   E2E_GREP="M6" PARTS=e2e ...                one Chromium test
#
# Parts, in order: generator db recovery legacy2a legacy2b rollback client e2e audit
# (generator must run while the stack is still pristine 085; `db` applies 086, which
#  recovery / rollback / client / e2e expect — select them together with `db`;
#  audit builds its own 086 stack).
# Keys come from the stack's secrets file into the environment ONLY: never
# printed, never written anywhere else; logs have JWTs redacted.
set -u
umask 077                                          # results (state.json holds a disposable password) owner-only
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TAG="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
PARTS="${PARTS:-generator db recovery legacy2a legacy2b rollback client e2e audit}"
OUT="$HERE/results/$TAG"; mkdir -p "$OUT"
LEGACY_COMMIT="${LEGACY_COMMIT:-ae51e69}"         # the Batch 2A client (compatibility parts)
redact() { sed -E 's/eyJ[A-Za-z0-9_.-]+/<jwt>/g'; }
say() { echo "== $*"; }
FAILED=0
fail() { FAILED=1; echo "  FAILED: $*"; }
iso_containers() { docker ps -aq --filter 'name=^phf-iso-'; }

# ---- 1. the disposable stack (085; 084 deliberately not applied) ---------------
needs_stack=0; for p in $PARTS; do [ "$p" != audit ] && needs_stack=1; done
WORK=""
teardown() {
  local rc=$?
  [ "${KEEP:-0}" = 1 ] && { say "KEEP=1: stack left up (secrets in ${WORK:-?}/secrets.env)"; return; }
  ids=$(iso_containers); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  docker network rm phf-iso-net >/dev/null 2>&1
  # only a temp directory the stack builder created (it holds secrets.env)
  case "$WORK" in /tmp/*|/private/tmp/*|/var/folders/*) [ -f "$WORK/secrets.env" ] && rm -rf "$WORK";; esac
  [ -d "$OUT/legacy-app" ] && rm -rf "$OUT/legacy-app"
  return $rc
}
if [ "$needs_stack" = 1 ]; then
  ids=$(iso_containers); [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1; docker network rm phf-iso-net >/dev/null 2>&1
  trap teardown EXIT                                 # also when the stack build itself fails
  say "stack (085, 084 skipped)"
  PHF_ISO_SKIP_MIGRATIONS=084 bash "$ROOT/tools/security-audit/run.sh" --max-migration 085 --stack-only > "$OUT/stack.log" 2>&1 \
    || { echo "stack failed (see $OUT/stack.log)"; exit 1; }
  SECRETS=$(grep -o 'secrets in [^,;]*secrets.env' "$OUT/stack.log" | head -1 | sed 's/^secrets in //')
  [ -n "$SECRETS" ] && [ -f "$SECRETS" ] || { echo "stack secrets file not found (see $OUT/stack.log)"; exit 1; }
  WORK=$(dirname "$SECRETS")
  set -a; . "$SECRETS"; set +a
  case "$PHF_ISO_URL" in http://127.0.0.1:*) ;; *) echo "REFUSE: not loopback"; exit 3;; esac
  say "stack: $(docker exec phf-iso-db psql -U supabase_admin -d postgres -Atc "select max(version)||' has084='||bool_or(version='084') from supabase_migrations.schema_migrations")"
fi
unset ELECTRON_RUN_AS_NODE
export E2E_SUPABASE_URL="${PHF_ISO_URL:-}" E2E_ANON_KEY="${PHF_ISO_ANON_KEY:-}" E2E_SERVICE_KEY="${PHF_ISO_SERVICE_KEY:-}"
export B2B_JWT_SECRET="${PHF_ISO_JWT_SECRET:-}" E2E_DB_CONTAINER=phf-iso-db E2E_LOOPBACK_ONLY=1 M086_LIVE=1 B2B_P3=1
export M086_MIGRATION="$ROOT/supabase/migrations/086_operation_outcomes.sql"
export M086_ROLLBACK="$ROOT/supabase/rollbacks/086_operation_outcomes.rollback.sql"
export P086_STATE="$OUT/state.json"   # QA tenant state incl. a disposable password: local results only, git-ignored

# ---- 2. the legacy (Batch 2A) client, built from git ---------------------------
legacy_app() {
  [ -d "$OUT/legacy-app" ] && return 0
  mkdir -p "$OUT/legacy-app"
  git -C "$ROOT" archive "$LEGACY_COMMIT" | tar -x -C "$OUT/legacy-app"
  ln -s "$ROOT/node_modules" "$OUT/legacy-app/node_modules"
  cp "$ROOT/e2e/helpers/db.ts" "$ROOT/e2e/helpers/env.ts" "$OUT/legacy-app/e2e/helpers/"
  # (kept as *.spec-src.ts in the repo: they run only inside the legacy checkout)
  cp "$HERE/legacy/legacy-2a.spec-src.ts" "$OUT/legacy-app/src/live/legacy-2a.live.test.ts"
  cp "$HERE/legacy/legacy-2b.spec-src.ts" "$OUT/legacy-app/src/live/legacy-2b.live.test.ts"
}

# a vitest part passes only with a summary line and no failed test
vt_ok() { grep -qE '^ +Tests +[0-9]+ passed' "$1" && ! grep -qE '^ +Tests .*failed' "$1"; }
vt() { local name=$1; shift; ( cd "$ROOT" && P086_EVIDENCE="$OUT/$name.json" npx vitest run "$@" 2>&1 | redact ) > "$OUT/$name.log"; echo "$name: $(grep -E '^ +Tests ' "$OUT/$name.log" || echo 'no summary — see log')"; vt_ok "$OUT/$name.log" || fail "$name"; }

for part in $PARTS; do
  case $part in
    generator)
      say "generator: extract the 085 inputs, regenerate 086 + rollback, compare with the committed files"
      python3 -I "$HERE/generator/extract-inputs.py" phf-iso-db "$OUT/inputs" > "$OUT/generator.log" 2>&1
      for f in catalog.json harden.txt idem_begin_085.json; do
        python3 -I "$HERE/generator/same-input.py" "$HERE/generator/inputs/$f" "$OUT/inputs/$f" >> "$OUT/generator.log" 2>&1 && echo "  input $f: identical" || { echo "  input $f: DIFFERS"; fail "generator input $f"; }
      done
      python3 -I "$HERE/generator/gen086.py" "$HERE/generator/inputs/catalog.json" "$HERE/generator/inputs/harden.txt" "$HERE/generator/template.sql" \
        "$OUT/086.sql" "$OUT/gen-report.txt" "$HERE/generator/inputs/idem_begin_085.json" "$OUT/086.rollback.sql" >> "$OUT/generator.log" 2>&1
      { cmp -s "$OUT/086.sql" "$M086_MIGRATION" && echo "  migration: byte-identical" || { echo "  migration: DIFFERS"; fail "generated migration"; }; } | tee -a "$OUT/generator.log"
      { cmp -s "$OUT/086.rollback.sql" "$M086_ROLLBACK" && echo "  rollback: byte-identical" || { echo "  rollback: DIFFERS"; fail "generated rollback"; }; } | tee -a "$OUT/generator.log"
      grep -q "DIFFERS" "$OUT/generator.log" && FAILED=1 ;;
    db) vt db src/live/m086-db.live.test.ts ;;
    recovery) vt recovery src/live/m086-recovery.live.test.ts ;;
    legacy2a) legacy_app; ( cd "$OUT/legacy-app" && B2B_EVIDENCE_K="$OUT/legacy2a.json" npx vitest run src/live/legacy-2a.live.test.ts 2>&1 | redact ) > "$OUT/legacy2a.log"
      echo "legacy2a ($LEGACY_COMMIT client vs 086): $(grep -E '^ +Tests ' "$OUT/legacy2a.log")"; vt_ok "$OUT/legacy2a.log" || fail legacy2a ;;
    legacy2b) legacy_app; ( cd "$OUT/legacy-app" && B2B_EVIDENCE="$OUT/legacy2b.json" npx vitest run src/live/legacy-2b.live.test.ts 2>&1 | redact ) > "$OUT/legacy2b.log"
      echo "legacy2b ($LEGACY_COMMIT money-RPC suite, legacy direct path, vs 086): $(grep -E '^ +Tests ' "$OUT/legacy2b.log")"; vt_ok "$OUT/legacy2b.log" || fail legacy2b ;;
    rollback) vt rollback src/live/m086-rollback.live.test.ts ;;
    client) legacy_app; M086_OLD_APP="$OUT/legacy-app" vt client src/live/m086-client.live.test.ts ;;
    e2e)
      bash "$HERE/clean.sh" > "$OUT/e2e-clean.log" 2>&1
      ( cd "$ROOT" && export E2E_API_GATEWAY="$PHF_ISO_URL" E2E_DEV_PORT=5181 E2E_SUPABASE_URL="http://localhost:5181" E2E_NO_CAFFEINATE=1 M086_E2E_EVIDENCE="$OUT/e2e.json" \
        && npx playwright test -c playwright.m086.config.ts ${E2E_GREP:+-g "$E2E_GREP"} 2>&1 | redact ) > "$OUT/e2e.log"
      echo "e2e: $(grep -E '[0-9]+ (passed|failed|flaky)' "$OUT/e2e.log" | tr '\n' ' ')"
      { grep -qE '[0-9]+ passed' "$OUT/e2e.log" && ! grep -qE '[0-9]+ (failed|flaky)' "$OUT/e2e.log"; } || fail e2e ;;
    audit)
      # its own fresh stack at 086 (084 skipped); tears it down itself
      ( cd "$ROOT" && PHF_ISO_SKIP_MIGRATIONS=084 bash tools/security-audit/run.sh --max-migration 086 2>&1 | redact ) > "$OUT/audit.log"
      echo "audit (org isolation at 086, incl. op_execute/op_status): $(grep -E 'summary|coverage gate|PASS|FAIL' "$OUT/audit.log" | tail -3 | tr '\n' ' ')"
      L=$(ls -t "$ROOT/tools/security-audit/results" | head -1)
      { grep -q 'Coverage gate: \*\*PASS' "$ROOT/tools/security-audit/results/$L/SUMMARY.md" && grep -qE '^\| \*\*total\*\* \| \*\*[0-9]+\*\* \| \*\*0\*\* \|' "$ROOT/tools/security-audit/results/$L/SUMMARY.md"; } || fail audit ;;
    *) echo "unknown part $part" ;;
  esac
done

[ "$FAILED" = 0 ] && say "ALL PARTS PASSED ($TAG)" || say "SOME PARTS FAILED ($TAG) — see $OUT"
exit "$FAILED"
