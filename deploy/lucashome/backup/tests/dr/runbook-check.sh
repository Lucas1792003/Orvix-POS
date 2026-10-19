#!/usr/bin/env bash
# runbook-check.sh — the restore runbooks keep the API closed until the owner-authorised reopening:
#   - API exposure is closed and confirmed before PostgreSQL is restored, stopped or restarted
#   - before the reopening section, every `docker compose up` uses --no-deps (functions -> api-gw),
#     nothing runs `tailscale serve --bg`/funnel, and no till signs in or syncs
#   - the order: closed -> restored -> fix-ups -> gate -> reviewed -> tills -> owner authorization -> reopen
#   - "restore validation alone never authorizes reopening the API" is stated
#   tests/dr/runbook-check.sh [ROOT]     ROOT = a repo tree (default: this repo) — a snapshot works too
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${1:-$HERE/../../../../..}" && pwd)"
RB="$ROOT/deploy/lucashome/backup/README.md"
EM="$ROOT/docs/selfhost-migration/phase-f/restore-from-email.md"
DR="$ROOT/docs/selfhost-migration/phase-g/disaster-recovery.md"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $*"; }
line_of() { grep -nF -- "$2" "$1" 2>/dev/null | head -1 | cut -d: -f1; }          # FILE TEXT -> first line no.
line_after() { awk -v s="$2" -v e="$3" -v t="$4" 'NR >= s && NR < e && index($0, t) { print NR; exit }' "$1"; }  # FILE START END TEXT (same line = same step)
region() { awk -v a="$2" -v b="$3" 'NR >= a && NR < b' "$1"; }                     # FILE FROM TO(excl)
negated() { grep -qiE "\b(no|not|never|nobody|none)\b"; }   # "before"/"until" are not negations
order() {  # LABEL FILE START END TEXT1 TEXT2 ... — each text found after the previous one, inside [START, END)
  local label=$1 f=$2 at=$3 end=${4:-999999} t n; shift 4
  for t in "$@"; do
    n=$(line_after "$f" "$at" "$end" "$t")
    if [ -z "$n" ]; then bad "$label: '$t' missing or out of order (lines ${at}-${end})"; return; fi
    at=$n
  done
  ok "$label: $(printf '%s → ' "$@" | sed 's/ → $//')"
}
pre_checks() {  # LABEL FILE FROM TO — the part before the reopening
  local label=$1 f=$2 a=$3 b=$4 x
  x=$(region "$f" "$a" "$b" | grep -nE 'docker compose up' | grep -v -- '--no-deps' | grep -viE 'never use a plain|a plain `docker compose up`' || true)   # warnings are not instructions
  [ -z "$x" ] && ok "$label: every 'docker compose up' before the reopening uses --no-deps" || bad "$label: 'docker compose up' without --no-deps before the reopening: $(echo "$x" | head -2 | cut -c1-120)"
  x=$(region "$f" "$a" "$b" | grep -nE 'docker compose (restart|start)\b' || true)
  [ -z "$x" ] && ok "$label: no 'docker compose restart/start' before the reopening (restart can bring dependants back)" || bad "$label: 'docker compose restart/start' before the reopening: $(echo "$x" | head -1 | cut -c1-120)"
  x=$(region "$f" "$a" "$b" | grep -nE 'tailscale +(serve|funnel) +[^[:space:]]' | grep -vE 'tailscale +serve +(reset|status)\b' || true)
  [ -z "$x" ] && ok "$label: no tailscale serve/funnel before the reopening" || bad "$label: tailscale exposure before the reopening: $(echo "$x" | head -1 | cut -c1-120)"
  x=$(region "$f" "$a" "$b" | grep -iE '\btills?\b[^.]*\b(signs? in|syncs?)\b|\bsigns? in and syncs?\b' | while IFS= read -r l; do printf '%s' "$l" | negated || echo "$l"; done)
  [ -z "$x" ] && ok "$label: no till signs in or syncs before the reopening" || bad "$label: early till sign-in/sync: $(echo "$x" | head -1 | cut -c1-120)"
}

echo "== README (local backups) §0/A/B/B2/R"
if [ ! -f "$RB" ]; then bad "missing $RB"; else
  s0=$(line_of "$RB" '### 0. Before any restore'); sA=$(line_of "$RB" '### A. Logical restore'); sB=$(line_of "$RB" '### B. Physical restore')
  sB2=$(line_of "$RB" '### B2. Point-in-time'); sR=$(line_of "$RB" '### R. Reopening the API'); sC=$(line_of "$RB" '### C. Inspect'); sP=$(line_of "$RB" '### P. Packaging')
  if [ -z "$s0" ] || [ -z "$sR" ]; then bad "README has no §0 (close the API) / §R (reopening) — closure and reopening are not defined"
    sR=${sR:-$sC}; s0=${s0:-$(line_of "$RB" '## Restore manually')}
  else ok "README defines §0 (close the API first) and §R (manual reopening)"; fi
  sExp=$(line_after "$RB" "$sR" "${sP:-999999}" 'tailscale serve --bg'); sExp=${sExp:-$sR}
  pre_checks "README §0 to the exposure step of §R" "$RB" "$s0" "$sExp"
  order "README §0 closes and confirms before §A touches the database" "$RB" "$s0" "$sB" 'restore-api-guard.sh close' 'API CLOSED (confirmed)' 'Disconnect every till from the network' 'pg_restore'
  order "README §A order" "$RB" "$sA" "$sB" '§0' 'pg_restore' 'dr-restore-fixups.sql' 'restore-api-guard.sh verify' 'dr-verify-restore.sh restore' 'Review the results' 'reconciled or quarantined' 'Separate owner authorization'
  order "README §B closes before stopping PostgreSQL, starts it with --no-deps" "$RB" "$sB" "$sB2" '§0' 'docker compose stop db' 'restore-api-guard.sh verify' 'restore-api-guard.sh start-db' 'The gate' 'reconciled or quarantined' 'owner authorization'
  order "README §B2 = §B incl. closure and start-db" "$RB" "$sB2" "$sR" '§0 first' 'start-db' 'owner authorization' 'recovery.signal'
  order "README §R preconditions then exposure last" "$RB" "$sR" "${sP:-$sC}" 'never automatic' 'reconciled or quarantined' 'every till still disconnected' 'separate' 'restore-api-guard.sh verify' '--no-deps' 'tailscale serve --bg' 'one at a time'
  grep -qiF 'Restore validation alone never authorizes reopening the API' "$RB" && ok "README states: restore validation alone never authorizes reopening" || bad "README lacks 'restore validation alone never authorizes reopening the API'"
fi

echo "== restore-from-email.md (server lost)"
if [ ! -f "$EM" ]; then bad "missing $EM"; else
  s3=$(line_of "$EM" '## 3. Rebuild'); s5=$(line_of "$EM" '## 5. '); sRe=$(grep -nE '^[0-9]+\. \*\*Reopening' "$EM" | head -1 | cut -d: -f1)
  [ -n "$sRe" ] && ok "email runbook has an explicit reopening step" || { bad "email runbook has no explicit, separately authorised reopening step"; sRe=${s5:-99999}; }
  eExp=$(line_after "$EM" "$sRe" "${s5:-999999}" 'tailscale serve --bg'); eExp=${eExp:-$sRe}
  pre_checks "email runbook §3 to the exposure step" "$EM" "${s3:-1}" "$eExp"
  grep -qF 'One till signs in and syncs' "$EM" && bad "email runbook still says 'One till signs in and syncs'" || ok "the early 'One till signs in and syncs' is gone"
  order "email runbook order" "$EM" "${s3:-1}" "${s5:-999999}" 'restore-api-guard.sh close' 'disconnected from the network' 'restore-api-guard.sh start-db' 'pg_restore' 'dr-restore-fixups.sql' 'dr-verify-restore.sh restore' 'Results reviewed' 'Tills reconciled or quarantined' 'Separate owner authorization' 'tailscale serve --bg' 'one at a time'
  grep -qiF 'Restore validation alone never authorizes reopening the API' "$EM" && ok "email runbook states: restore validation alone never authorizes reopening" || bad "email runbook lacks the statement"
fi

echo "== disaster-recovery.md"
if [ ! -f "$DR" ]; then bad "missing $DR"; else
  # this document describes; it prescribes only in command lines (code), which must use --no-deps
  x=$(grep -nE '^[[:space:]]*([a-z]+\$ )?(cd [^&]*&& *)?docker compose up' "$DR" | grep -v -- '--no-deps' || true)
  [ -z "$x" ] && ok "disaster-recovery.md prescribes no 'docker compose up' without --no-deps" || bad "disaster-recovery.md: $(echo "$x" | head -1 | cut -c1-120)"
  d4=$(line_of "$DR" '### 5.4 '); d5=$(line_of "$DR" '### 5.5 ')
  order "disaster-recovery.md §5.4 order" "$DR" "${d4:-1}" "${d5:-999999}" 'confirmed' 'disconnected from the network' 'Database restored' 'Fix-ups' 'The gate' 'results reviewed' 'reconciled or quarantined' 'separate owner authorization' 'Reopening by hand'
  grep -qiF 'Restore validation alone never authorizes reopening the API' "$DR" && ok "disaster-recovery.md states: restore validation alone never authorizes reopening" || bad "disaster-recovery.md lacks the statement"
fi

echo; echo "runbook check: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
