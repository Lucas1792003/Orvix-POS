# Migration 086 verification (disposable loopback stack)

Reproducible verification of migration 086 (`supabase/migrations/086_operation_outcomes.sql`)
and the client that depends on it. Everything runs against a **disposable stack on
127.0.0.1** built from synthetic data; nothing here contacts lucashome, hosted
Supabase, Vercel or any real server, and nothing is ever applied to production.

## What it runs

| Part | What | Where |
|---|---|---|
| `generator` | extracts the 085 inputs from the pristine stack, regenerates 086 and its rollback, compares them byte-for-byte with the committed files | `generator/` |
| `db` | 086 itself on PostgreSQL: guards, executor, lookup / fence, ledger, outcome codes, re-apply | `src/live/m086-db.live.test.ts` |
| `recovery` | the emergency recovery tool against 086 and (after the reviewed rollback) 085 | `src/live/m086-recovery.live.test.ts` |
| `legacy2a` | the Batch 2A client (`LEGACY_COMMIT`, default `ae51e69`) against 086 | `legacy/legacy-2a.spec-src.ts` (copied into the legacy checkout) |
| `legacy2b` | the money-RPC suite on the legacy direct path against 086 | `legacy/legacy-2b.spec-src.ts` (copied into the legacy checkout) |
| `rollback` | the reviewed rollback (functions only; refused without the runner's owner gate; removes the `086` ledger row; operation ledger byte-identical), restart survival, re-apply | `src/live/m086-rollback.live.test.ts` |
| `client` | the real client modules (outbox, online-only payments, recovery) against the real server; financial effects asserted in PostgreSQL (`supplier_payments`, ledger, balances) | `src/live/m086-client.live.test.ts` |
| `e2e` | real Chromium (persistent profile, real IndexedDB / Web Locks, crash + restart, two windows, zero-queue payment export; a refused lump sum stays final) | `e2e/m086-chromium.e2e.ts`, `e2e/m086-lumpsum.e2e.ts`, `playwright.m086.config.ts` |
| `audit` | the organisation-isolation audit at 086 (its own fresh stack), incl. `op_execute` / `op_status` authorization and tenant isolation | `tools/security-audit/suites/ops.ts` |

The live parts apply and roll back 086 the way `deploy/lucashome/apply-migrations.sh`
does (one transaction; the ledger row; the rollback's owner gate — `src/live/p086-lib.ts`
`apply086` / `rollback086`). The runner ITSELF is tested by
`deploy/lucashome/tests/migration-plan-test.py` (planner, no database) and
`deploy/lucashome/tests/apply-migrations-test.sh [--stack]` (the real script against a
local PostgreSQL container, and with `--stack` the real 083 → 085 → 086 → rollback →
re-apply cycle on a fresh audit stack).

## Prerequisites

The same as `tools/security-audit` (see its README): Docker with the pinned
images, host `psql`, `jq`, `node`, `openssl`, `curl`, `python3`, `npm ci` once,
the scrubbed baseline schema snapshot at `BASELINE_SQL`, and Playwright's
Chromium (`npx playwright install chromium`).

## Run

```sh
tools/m086-verify/run.sh                 # fresh stack, every part, teardown
tools/m086-verify/run.sh mytag           # results under tools/m086-verify/results/mytag/
PARTS="db client" tools/m086-verify/run.sh       # `db` applies 086: include it whenever recovery/rollback/client/e2e run
PARTS="db e2e" E2E_GREP=M6 KEEP=1 tools/m086-verify/run.sh   # one Chromium test, keep the stack
```

Each part prints its summary line; logs and JSON evidence land in
`tools/m086-verify/results/<tag>/` (git-ignored). JWTs are redacted from logs.
`state.json` there holds the synthetic QA tenant (incl. a random disposable
password) — local only, never commit or share it.

## Secrets

The stack is built by `tools/security-audit/run.sh --stack-only`, which writes
its generated keys to a mode-0600 `secrets.env` in a temporary directory. The
runner loads that file into the environment only (never printed, never copied)
and refuses to continue unless the gateway is `http://127.0.0.1:<port>`. The
helpers enforce the same: `E2E_LOOPBACK_ONLY=1` (non-loopback backends
refused, non-loopback browser requests aborted), SQL only through
`docker exec` into `E2E_DB_CONTAINER` (never ssh). No key, password or host
name is stored in the repository.

## Cleanup

The runner removes every `phf-iso-*` container, the network and its temporary
directory on exit (also on failure) unless `KEEP=1`. Manual cleanup:

```sh
docker rm -f $(docker ps -aq --filter name=phf-iso-); docker network rm phf-iso-net
tools/m086-verify/clean.sh               # only the QA tenants, stack kept
```

## Regenerating migration 086

`generator/gen086.py` fills `generator/template.sql` from three inputs taken
from the 085 catalog (`generator/inputs/`): the md5 guard map, the allow-listed
dispatch (one typed branch per RPC) and the search_path hardening list. It
refuses to emit an RPC whose own request hash does not cover all its
parameters. The `generator` part proves that the committed inputs equal a fresh
extraction and that the committed migration and rollback are exactly what the
generator emits:

```sh
python3 -I tools/m086-verify/generator/gen086.py \
  tools/m086-verify/generator/inputs/catalog.json tools/m086-verify/generator/inputs/harden.txt \
  tools/m086-verify/generator/template.sql /tmp/086.sql /tmp/report.txt \
  tools/m086-verify/generator/inputs/idem_begin_085.json /tmp/086.rollback.sql \
  tools/m086-verify/generator/inputs/idem_finish_085.json tools/m086-verify/generator/inputs/pay_supplier_lump_sum_085.json
```
