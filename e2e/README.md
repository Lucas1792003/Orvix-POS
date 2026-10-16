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
npm run e2e                         # all specs, in order: a-workflows, b-failures, c-offline-auth, d-phone-upload, e-consistency-gate, f-queue-export
npx playwright test e2e/f-queue-export.e2e.ts  # only the queue export + recovery replay spec (docs/selfhost-migration/phase-f/queue-export.md)
npx playwright test e2e/d-phone-upload.e2e.ts   # only the phone-upload spec (docs/selfhost-migration/phase-g/phone-upload-jit.md)
E2E_PHONE_FN=local npx playwright test e2e/d-phone-upload.e2e.ts   # same, function from this repo in a local container (needs Docker)
E2E_PHONE_PAGE=deployed npx playwright test e2e/d-phone-upload.e2e.ts   # phone page served by the stack (after phone-qr-origin.md §6)
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
| `E2E_PHONE_PAGE` | spec D only: where the phone page (`phone-upload-page`, docs/selfhost-migration/phase-f/phone-qr-origin.md) comes from. The phone always opens the URL the desktop QR encodes, `<E2E_SUPABASE_URL>/functions/v1/phone-upload-page#<token>`; the spec asserts that the QR encodes exactly that (the configured https origin, not the dev server). `local` = the phone's navigation to that URL is answered by `supabase/functions/phone-upload-page` from this repo in the local edge-runtime container (the page stays on the stack origin, so its API calls go to the real stack; needs Docker); `deployed` (**default since 2026-10-13**, after the function and router patch were deployed) = no routing, served by the stack |

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
| `d-phone-upload.e2e.ts` | phone QR upload with the just-in-time token (`phone-upload-token`), Electron desktop + iPhone-profile Chromium phone, real timing (30/65/120/300 s, stale token, double tap, race, lost response, expired, cancelled; plus `D-ratelimit-wait` / `D-ratelimit-used-up`, which run only when the stack schema is >= 081, docs/selfhost-migration/phase-f/rate-limiting.md); each success also saves the product and checks `products.image_url` = the server-derived URL (080: `public.app_config` origin + `/storage/v1/object/public/product-images/<session path>`); ~14 min |
| `helpers/edgeRuntime.ts` | `E2E_PHONE_FN=local` / `E2E_PHONE_PAGE=local`: runs `supabase/functions/phone-upload-token` and/or `phone-upload-page` in one disposable local `supabase/edge-runtime:v1.76.2` container (127.0.0.1 only, keys passed as env names only); the phone's function request / page navigation is routed to it |
| `helpers/saleLedger.ts` (+ `.test.ts`) | duplicate/lost-sale detection used by the consistency gate: sale ↔ committed `complete_sale` idempotency key (exactly one each way), one client operation (cashier + shift + client event time) → one sale, receipt numbers unique per shop, and the terminals' own request ledger (one operation → one key) |
| `h-set-aside.e2e.ts` | RC2 (audit D1): owner on a till with a queued offline shift + sale (API held at 503): Set aside refused before an export; after the export the confirmation names the sale, a double click sets aside exactly one row, the row stays (same key/payload) in the Set aside list; Restore; API back + cashier sign-in → drains once (1 sale, 1 key row); consistency gate. Needs `E2E_QA_TOTP_SECRET` |
| `f-queue-export.e2e.ts` | Phase F: offline queue (shift opened offline + 3 sales) survives an offline restart, is exported through the UI (save dialog stubbed in the main process) and checked (encrypted, every entry, no secrets, queue byte-identical); the real recovery CLI replays it into the QA org (target rules, dry run, replay x3 → no duplicates) while the till drains the same keys after a B13-style outage; consistency gate. `E2E_QX_PASSPHRASE` fixes the export passphrase (else random) |
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
