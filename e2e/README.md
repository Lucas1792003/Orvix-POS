# End-to-end suite (Phase E)

Playwright drives the real Electron app (terminal A) and a Chromium page on
the same Vite dev server (terminal B) against the self-hosted Supabase stack.
Results and defects: `docs/selfhost-migration/phase-e/e2e-results.md`.

## Run

```sh
# keys into the shell only — never into files, never echoed
export E2E_SUPABASE_URL=https://lucashome.tail8a86e4.ts.net
export E2E_ANON_KEY="$(ssh -o BatchMode=yes lucashome 'grep "^ANON_KEY=" /srv/supabase/stack/.env | cut -d= -f2-')"
export E2E_SERVICE_KEY="$(ssh -o BatchMode=yes lucashome 'grep "^SERVICE_ROLE_KEY=" /srv/supabase/stack/.env | cut -d= -f2-')"
unset ELECTRON_RUN_AS_NODE          # set by some shells; it turns the Electron binary into plain Node

npx playwright install chromium     # once
npm run e2e                         # all specs, in order: a-workflows, b-failures, c-offline-auth, d-phone-upload, e-consistency-gate
npx playwright test e2e/d-phone-upload.e2e.ts   # only the phone-upload spec (docs/selfhost-migration/phase-g/phone-upload-jit.md)
E2E_PHONE_FN=local npx playwright test e2e/d-phone-upload.e2e.ts   # same, function from this repo in a local container (needs Docker)
npm run e2e:cleanup                 # cleanup.sql -> audit_purge.sql -> verify_clean.sql (+ storage file count)
```

| Variable | Meaning |
|---|---|
| `E2E_SUPABASE_URL`, `E2E_ANON_KEY`, `E2E_SERVICE_KEY` | the stack (the dev server is started with these as `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`; global-setup refuses to run if the served bundle does not embed this URL) |
| `E2E_SSH_HOST`, `E2E_STACK_DIR` | ssh host / compose dir for `psql` (default `lucashome`, `/srv/supabase/stack`) |
| `E2E_QA_TS` | re-use an existing QA tenant instead of seeding (the admin's TOTP secret is read back from `auth.mfa_factors`) |
| `E2E_QA_PASSWORD` | password for the QA accounts (random per run when unset; required with `E2E_QA_TS`) |
| `E2E_DEV_PORT` | dev-server port (default 5179) |
| `E2E_PHONE_FN` | spec D only: `deployed` (default) = the phone page calls the stack's own `/functions/v1/phone-upload-token` (no container, no request routing; the answers are only observed); `local` = run `supabase/functions/phone-upload-token` from this repo in a disposable local edge-runtime container and route the phone's function request to it (for testing an undeployed change) |

`global-setup` creates the QA tenant (Phase D `seed.sql` + `supabase/tests/phase-e/live/seed_extra.sql`)
and enrols a TOTP factor for the QA admin through the auth API. The tenant is
left in place after the run so failures can be inspected; cleanup is the
explicit `npm run e2e:cleanup` step. Outputs: `e2e/.results/evidence.jsonl`
(one line per DB-side check) and screenshots of failures under
`e2e/.results/artifacts/` (git-ignored). Traces and the JSON reporter are off
on purpose: both would write the anon key / QA bearer tokens to disk
(`--trace on` is fine for a one-off debug run — delete the artifacts after).

## Layout

| Path | Role |
|---|---|
| `playwright.config.ts` | serial, one worker, dev server + global setup/teardown |
| `helpers/terminal.ts` | the terminal abstraction: launch Electron (`SHWE_POS_E2E=1`, isolated `userData`) or Chromium; login / TOTP / shift / POS / toast helpers; failure injection (origin cut, 503 routes, commit-then-abort, Realtime proxy); IndexedDB/localStorage access |
| `helpers/consistency.ts` | `assertConsistency()` — the data-consistency gate run after every spec (duplicate sales via `helpers/saleLedger.ts`) |
| `helpers/db.ts` | service-role reads and `psql` over ssh (re-uses `src/live/liveHelpers.ts`) |
| `helpers/totp.ts`, `helpers/evidence.ts`, `helpers/env.ts` | TOTP generator, evidence ledger, environment |
| `seed/cleanup.ts` | the cleanup step |
| `a-workflows.e2e.ts`, `b-failures.e2e.ts`, `c-offline-auth.e2e.ts` | the specs (`*.e2e.ts` so vitest ignores them) |
| `d-phone-upload.e2e.ts` | phone QR upload with the just-in-time token (`phone-upload-token`), Electron desktop + iPhone-profile Chromium phone, real timing (30/65/120/300 s, stale token, double tap, race, lost response, expired, cancelled); each success also saves the product and checks `products.image_url` = the server-derived URL (080: `public.app_config` origin + `/storage/v1/object/public/product-images/<session path>`); ~14 min |
| `helpers/edgeRuntime.ts` | `E2E_PHONE_FN=local` only: runs `supabase/functions/phone-upload-token` in a disposable local `supabase/edge-runtime:v1.76.2` container (127.0.0.1 only, keys passed as env names only) and the phone's function request is routed to it |
| `helpers/saleLedger.ts` (+ `.test.ts`) | duplicate/lost-sale detection used by the consistency gate: sale ↔ committed `complete_sale` idempotency key (exactly one each way), one client operation (cashier + shift + client event time) → one sale, receipt numbers unique per shop, and the terminals' own request ledger (one operation → one key) |
| `e-consistency-gate.e2e.ts` | proves the gate: two distinct identical-basket queued sales PASS; a forged second sale row and one UI operation re-sent under a new key FAIL; both forgeries reverted |

Hard guards: every terminal aborts and records any request to `*.supabase.co`
(the hosted project must never be touched); the dev-server target is checked
before anything runs. Since Phase G an aborted hosted request is a **failure
of the run**, not just a log line: `helpers/hostedGuard.ts` writes a FAIL
evidence row, `assertConsistency()` (after every spec) throws on it, and
`global-teardown` re-scans the ledger and throws so `playwright test` exits
non-zero either way; `E2E_SUPABASE_URL` itself is refused if it is a hosted
URL. B12 keeps the explicit per-terminal assertion. The same guard protects
the vitest suite (`src/test/setup.ts`) and the live suite (`src/live/`).

New in Phase G: `B11b` (Realtime gap reconciled on rejoin — a service-role
`UPDATE` made while B's socket is blocked appears on the card after the
unblock with no reload and no further event; the edit is reverted live so
the ledger gate holds). Not yet run against the stack.
