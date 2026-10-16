# G0-2: `platform-console` deployment protection (repo-side) — 2026-10-16

| | |
|---|---|
| Approval | Owner, 2026-10-16: G0-2, local repository work only |
| Relation to other work | **G0-1** (server-side containment, done 20:19 UTC, [evidence](../G0-1/2026-10-16-platform-console-containment.md)) · **G0-2** (this: repo-side protection) · **Orvix Control** (separate future project, `docs/plans/orvix-platform-control-plane-architecture.md`) |
| Result | **PASS** (repo-side). Nothing in this change was deployed to lucashome. |
| Production changes | **NONE.** No SSH, no server or production contact, no container restart, no database, migration, Supabase, Cloudflare, Tailscale, web-server or firewall change. No commit, push, merge, tag or publish. |

## 1. Executive summary

- **Archive.** The source of the retired `platform-console` Edge Function moved from `supabase/functions/platform-console/` to `archive/deprecated-edge-functions/platform-console/`, unchanged (tree sha256 `0f650c9e…a7bff`, identical to the server rollback copy).
- **Guard and sync.** A single fail-closed guard (`deploy/lucashome/functions-guard.sh`) holds the approved and retired function lists. A guarded sync script (`deploy/lucashome/sync-functions.sh`) is now the documented way to copy function source to lucashome. Before any copy it refuses:
  - a retired name and its path or case variants;
  - a retired, unapproved or symlinked entry in the source tree;
  - a missing, broken or neutered guard.
- **Router script.** `functions-router.sh status/verify` now fail when a retired function is present.
- **Audit suite.** The security audit asserts the function is retired.
- **Tests.** 80/80 new guard tests (bash 3.2 and bash 5.2), the existing router suite 62/0, and the security audit at production level 456 PASS / 0 FAIL / 2 low GAP (pre-existing) with the coverage gate 120/120.
- **Organisation ADMIN features** (`staff-admin`, `admin-2fa`, user RPCs, shops) are unchanged and permitted.
- **Remaining bypasses** (§9) are manual copies outside the script, old backups, and the frozen hosted project. The post-restore check covers the first two on lucashome.

## 2. Files inspected

| Area | Files |
|---|---|
| Function sources | `supabase/functions/*`; no shared module exists (each function is self-contained; `platform-console` = one `index.ts`, imports only `npm:@supabase/supabase-js@2`) |
| Deployment | `deploy/lucashome/README.md` (per-name `rsync`, rebuild-step `rsync`), `functions-router.sh`, `functions-main-public-page.patch`, `docker-compose.override.yml` (functions volume), `apply-migrations.sh` |
| Backups and restore | `deploy/lucashome/backup/email-archive.sh` (tars `volumes/functions`), `secrets-bundle.sh` (bundles `volumes/functions`), `OFFSITE-ENABLE.md` (§8.2 restore copies `stack/volumes/functions`), `MAC-TIER.md` |
| CI / release | `.github/workflows/deploy.yml` (GitHub Pages web build only), `vercel.json`, `package.json` `build` (Electron packages `dist/**`, `electron/**`; no functions) |
| Test harnesses | `tools/security-audit/stack/up.sh` (mounts every `supabase/functions/*/`), `suites/functions.ts`, `suites/authz.ts`, `coverage/static-map.json`; `deploy/lucashome/tests/functions-router-test.sh` (serves every `supabase/functions/*/`); `deploy/lucashome/backup/tests/email/suite.sh` (copies `supabase/functions/.`); `supabase/tests/functions/run.sh` (Deno; no `platform-console` test); `supabase/tests/rate-limit-local/run.sh` and `e2e/helpers/edgeRuntime.ts` (named functions only) |
| References | `grep -rIl platform-console` over the repo: app `src/app/routes/AppRouter.tsx`, `src/stores/platformAuthStore.ts`, `src/pages/PlatformConsole*.tsx`; live test `src/live/phase-g.org-isolation.live.test.ts` (has a documented service-role fallback when the function is absent); migrations 061/066/073/077 and harness SQL t11/t13 (comments only); docs |
| Automation on the server | none re-syncs functions (crontab and systemd timers, read-only check during G0-1) |

## 3. Deployment paths discovered

| # | Path | Could restore `platform-console`? | Allowlist or copy-all? | Fails closed? | Status after G0-2 |
|---|---|---|---|---|---|
| P1 | README per-function `rsync supabase/functions/<name>/` | yes (any name) | per name | no | **Replaced** by `sync-functions.sh NAME` (guarded); the source is no longer in `supabase/functions/` |
| P2 | README rebuild step `rsync supabase/functions → volumes/functions` | yes (copy-all) | copy-all (G0-1 had only a README `--exclude`) | no | **Replaced** by `sync-functions.sh --all` (explicit approved list, never a glob) |
| P3 | `supabase functions deploy <name>` (Supabase CLI, hosted project) | yes, if run against hosted | per name / all dirs | no | **Source gone** from `supabase/functions/`: the CLI finds nothing to deploy. Hosted itself: see §9 R3 |
| P4 | Restore of `volumes/functions` from the email archive / secrets bundle (`OFFSITE-ENABLE.md` §8.2) | yes, from any backup taken before 2026-10-16 20:19 UTC | copy-all | no | **Detected**, not prevented: `functions-guard.sh check-deployed` (exit 3) is the documented post-restore, pre-exposure check; `functions-router.sh status/verify` also fail. Restore scripts unchanged (out of scope) |
| P5 | Upstream `update.sh` / stack reinstall | no (upstream has no such function; it re-adds `hello/`) | — | — | `check-deployed` flags `hello` (exit 4) |
| P6 | Manual `scp`/`cp`/`rsync` by an operator outside the script | yes | — | no | **Bypass** (§9 R1); detected afterwards by `check-deployed` and router `status/verify` |
| P7 | Security-audit disposable stack (`up.sh`) | it mounted it while in `supabase/functions/` | copy-all | n/a (local test) | now mounts only approved dirs; suites assert the function is retired |
| P8 | Router runtime test, email backup test suite | mounted/copied it | copy-all | n/a (local tests) | no longer present in the source tree |
| P9 | CI (`.github/workflows/deploy.yml`), Vercel, Electron packaging | no (web/desktop builds only) | — | — | unaffected |

## 4. Security weaknesses found

1. G0-1 left the protection **procedural**: a README line and a single `--exclude` on one of two `rsync` commands.
2. The per-function command accepted any name, including `platform-console`, and path variants.
3. Copy-all paths (the rebuild step and test harnesses) included every directory under `supabase/functions/`.
4. Restores from backups made before G0-1 contain the function, and nothing checked for it.
5. The router `verify` enumerated whatever directories existed, so a restored retired function would have been **probed and reported as "gated"** (PASS), hiding the regression.
6. The security audit still expected `platform-console` to work for a platform admin.
7. The hosted fallback project may still run `platform-console` (§9 R3); not verifiable without contacting it.

## 5. Files modified (all uncommitted)

| File | Change |
|---|---|
| `supabase/functions/platform-console/index.ts` | **moved** (not deleted) to `archive/deprecated-edge-functions/platform-console/index.ts`; content identical |
| `archive/deprecated-edge-functions/README.md` | **new**: deprecation notice, original path, G0-1 date, reason, server rollback location, evidence links |
| `deploy/lucashome/functions-guard.sh` | **new**: shared guard (approved list, retired list, `check-names`, `check-source`, `check-deployed`) |
| `deploy/lucashome/sync-functions.sh` | **new**: guarded sync (guard present + canary + names + source tree, before any `rsync`; `--print`; `--all` from the explicit list) |
| `deploy/lucashome/tests/functions-guard-test.sh` | **new**: 80 local tests (fake rsync, temp dirs) |
| `deploy/lucashome/functions-router.sh` | `RETIRED_FUNCTIONS` + `retired_check`: `status` and `verify` fail if a retired function dir exists or is named; `ALLOW_RETIRED_FUNCTIONS=1` only for an owner-approved rollback verification. No other behaviour changed |
| `deploy/lucashome/README.md` | approved and retired tables, guarded sync usage, error text, server check, router behaviour, bypass warning; rebuild step uses `sync-functions.sh --all`; file-table row (also carries the earlier G0-1 edits) |
| `tools/security-audit/suites/functions.ts` | the `platform-console` block now asserts **non-execution** for every persona (incl. platform admin) and every action |
| `tools/security-audit/suites/authz.ts` | platform-admin expectation for `platform-console whoami` flipped to denied |
| `tools/security-audit/stack/up.sh` | removed `platform-console` from the warm-up list |
| `tools/security-audit/README.md` | suite description notes retirement |
| `docs/07-setup-deployment.md` | "Platform Admin Console" section marked **RETIRED**, kept for history |
| `docs/lucashome-selfhost/status.md` | Edge-functions row points to the archive and the repo-side guard ("nothing deployed to this server") |
| `docs/selfhost-migration/evidence/G0-2/…` | this file |

**Not changed:**
- `supabase/functions/{admin-2fa,email-sales-report,phone-upload-page,phone-upload-token,staff-admin}`
- `supabase/migrations`, `src/`, `electron/`, `package.json`, `vite.config.ts`, `.github/`
- the frozen RC artifacts
- backup and restore scripts

## 6. Archive location

`archive/deprecated-edge-functions/platform-console/index.ts`. Its tree sha256 `0f650c9e9e3a338d8b75eb085fcc56e4c5935080d08ddea7ea73b821036a7bff` equals the pre-move repo copy and the server rollback copy `lucashome:~/removed-edge-functions-20261016T2019Z/platform-console`, which is untouched.

The archive contains no secrets: it reads `SUPABASE_SERVICE_ROLE_KEY` by name from its runtime environment.

## 7. Guard design

**Approved:** `admin-2fa email-sales-report phone-upload-page phone-upload-token staff-admin`.

**Retired:**
- `platform-console`;
- `rotate-audit-log` and `weekly-sales-report` (removed 2026-10-13; owner rule).

The lists live **only** in `functions-guard.sh`. The router script repeats the retired list (it is piped to the server standalone), and test S12 asserts equality.

**Enforcement points** (all before any copy, sync or restart):

| Point | What it refuses | Exit |
|---|---|---|
| `sync-functions.sh` step 1 | missing guard | 2 |
| step 2 (canary) | a guard that does not refuse `platform-console` with exit 3 (neutered, edited or broken) | 2 |
| step 3 `check-names` | retired names and variants (`platform-console/`, `../platform-console`, `PLATFORM-CONSOLE`, `supabase/functions/platform-console`); unknown or invalid names; a mixed list (all-or-nothing) | 3 / 4 |
| step 4 `check-source` | a retired or case-variant directory, an unapproved directory (e.g. a renamed copy), a symlink, or a missing approved function anywhere in `supabase/functions/`, even for a single-function deploy | 3 / 4 / 5 |
| copy | one `rsync -a --delete` per approved name from an explicit list, so `archive/` and unknown directories can never be included | — |
| server, read-only | `functions-guard.sh check-deployed` (post-sync / post-upgrade / **post-restore, before the stack is reachable**) | 3 / 4 / 5 |
| server, existing checklist | `functions-router.sh status` / `verify` fail while a retired function is present | ≠ 0 |

**Expected refusal text:**

```
REFUSED: 'platform-console' is a RETIRED Edge Function and must not be deployed or active.
         Retired source lives in archive/deprecated-edge-functions/ (not deployable). See docs/selfhost-migration/evidence/G0-2/2026-10-16-platform-console-deployment-protection.md.
REFUSED: guard check-names failed (exit 3) — nothing was copied.
```

**No silent skipping.** Nothing is dropped quietly: a retired or unknown entry stops the whole operation with a non-zero exit.

## 8. Tests performed (exact results; all local)

| Test | Command | Result |
|---|---|---|
| Guard suite, bash 3.2 (macOS) | `bash deploy/lucashome/tests/functions-guard-test.sh` | **80 passed, 0 failed** |
| Guard suite, bash 5.2 (server-like) | `docker run --rm -v "$PWD":/repo:ro bash:5.2 bash /repo/deploy/lucashome/tests/functions-guard-test.sh` | **80 passed, 0 failed** |
| shellcheck | new scripts and the test | clean (one documented file-level directive for intentional word splitting); `functions-router.sh` 0 findings before and after |
| Router suite (existing) | `bash deploy/lucashome/tests/functions-router-test.sh` (Docker, pinned upstream router from GitHub raw, local edge-runtime) | **62 passed, 0 failed**; runtime `verify` enumerated the 5 approved functions: 38/0 |
| Security audit (disposable loopback stack, synthetic data, no `--parity`) | `PHF_ISO_SKIP_MIGRATIONS=84 tools/security-audit/run.sh --max-migration 085` → `results/20261016T203322Z` | **456 PASS / 0 FAIL / 2 GAP (low, pre-existing G5 desktop byte check) / 8 INFO**; coverage gate **PASS 120/120**; all 21 `platform-console` checks PASS (12 non-execution + 9 authz personas); `staff-admin` positive create PASS; the stack was torn down (0 `phf-iso-*` containers) |
| eslint (changed TS) | `npx eslint` on `suites/functions.ts`, `suites/authz.ts`, the archived file | 1 / 1 / 0 errors; identical to HEAD (pre-existing) |
| Safety | `git diff --quiet HEAD --` per path; `shasum -c SHA256SUMS` in each frozen folder | 5 active functions, migrations, `src`, `electron`, `package.json`, `vite.config.ts`, `.github` unchanged; RC1/RC2/RC3 13/13 OK each |

**Coverage of the requested cases:**

| Requested case | Tests |
|---|---|
| explicit deploy of `platform-console` rejected | S1, S2 |
| reintroduction into `supabase/functions` detected | S4, S6 |
| full sync cannot include it | S4, S5 |
| archived functions excluded | S5 |
| restore containing it detected before activation | S8 (+ S11 for the router) |
| missing or failed guard prevents deployment | S9, S10 |
| `staff-admin`, `admin-2fa`, `email-sales-report`, `phone-upload-page`, `phone-upload-token` permitted | C1, C2 |
| router `main` permitted | C3 (`check-deployed` accepts `main/` + `deno.jsonc`), C2 (sync never touches `main`) |

**NOT RUN**, with reasons:
- Deno function tests, full Vitest, and `tsc`: the five active function sources and `src/` are byte-identical to HEAD.
- The email-backup test suite: it copies `supabase/functions/.`, which now simply lacks the retired dir.
- Playwright e2e: it needs the production QA tenant, which is out of scope.

No real `rsync`, sync or deployment command was run. Every sync test used a fake `rsync` that only records its arguments.

## 9. Remaining bypasses and exposure

| # | Risk | Status / mitigation |
|---|---|---|
| R1 | An operator copies files by hand (`scp`, `cp`, raw `rsync`), or moves the archive back | **Not preventable repo-side.** Detected by `check-deployed` and router `status/verify`. README warns. A server-side tripwire (e.g. a read-only check in the daily status script) needs separate approval. |
| R2 | Server restore from a backup made before 2026-10-16 20:19 UTC | Restore scripts unchanged (out of scope). The documented post-restore check `ssh <server> 'bash -s' -- check-deployed <functions-dir> < deploy/lucashome/functions-guard.sh` must pass **before** the restored stack is started or reachable. Adding it to `OFFSITE-ENABLE.md` §8.2 / `restore-from-email.md` needs approval. |
| R3 | **Hosted Supabase project** (frozen fallback, public `*.supabase.co`) may still have `platform-console` deployed from the v1.0.15 era | **Not verified** (no contact allowed). Owner action: check *Edge Functions* in the hosted dashboard and, if present, delete it there or confirm `platform_admins` is empty. Recommended before anything else uses hosted. |
| R4 | The `/console` and `/console/login` routes, `platformAuthStore.ts` and `PlatformConsole*.tsx` still ship in the app bundle | Calls now fail (function absent). Removal belongs to the 1.0.17 UI workstream (plan v2 Phase 1, "`/console` compiled out"). Not changed here. |
| R5 | The guard lists could be edited to approve the name | Code review; the sync canary refuses any guard that no longer rejects `platform-console`; test S12. |
| R6 | Server copy of the router script | Not present on lucashome (`~/functions-router/` absent, G0-0). The documented usage pipes the repo copy, so the new check applies the next time it runs. |
| R7 | Working-tree only | Until committed (owner G1-git approval), a `git checkout HEAD -- supabase/functions/platform-console` restores the source. The guard then refuses every sync (exit 3). |
| R8 | Other, non-POS services with public exposure on the same host | Unrelated to this function; details in the private ops repository; plan decision D-27. |

## 10. Organisation ADMIN compatibility

| Operation | Implementation | After G0-2 |
|---|---|---|
| Create managers and staff | `staff-admin` | source unchanged; guard approves it (C1/C2); audit positive create PASS |
| Edit roles, deactivate accounts | RPCs `update_app_user`, `deactivate_app_user` | untouched (database, `src` unchanged) |
| Manage shops | `shops` table writes | untouched |
| Admin MFA | `admin-2fa` | source unchanged; guard approves it |

Only platform-wide administration (create organisation, create platform admin) is retired.

## 11. Production changes made

**NONE.** G0-2 is repository-side only and has not been deployed to lucashome. The server state is exactly as left by G0-1.

## 12. Git status (uncommitted)

```
 M deploy/lucashome/README.md
 M deploy/lucashome/functions-router.sh
 M docs/07-setup-deployment.md
 M docs/lucashome-selfhost/status.md
 D supabase/functions/platform-console/index.ts        (moved to archive/, not staged)
 M tools/security-audit/README.md
 M tools/security-audit/stack/up.sh
 M tools/security-audit/suites/authz.ts
 M tools/security-audit/suites/functions.ts
?? archive/
?? deploy/lucashome/functions-guard.sh
?? deploy/lucashome/sync-functions.sh
?? deploy/lucashome/tests/functions-guard-test.sh
?? docs/selfhost-migration/evidence/G0-2/
(also untracked from earlier work: docs/audits/, docs/plans/, docs/selfhost-migration/evidence/G0-1/)
```

No commit, branch, push, tag or publish.

## 13. Next owner approvals

1. **Commit G0-1 + G0-2** on a feature branch and open a PR as `Lucas1792003` (G1-git). Until then the protection exists only in this working tree.
2. **Hosted project check (R3):** look for `platform-console` in the hosted dashboard and remove it there if present.
3. **Optional server-side follow-ups**, each a separate production approval:
   - add `functions-guard.sh check-deployed` to the restore runbooks (R2);
   - a read-only tripwire in the daily status script (R1);
   - run `check-deployed` once on lucashome now, which is read-only (expected exit 0).
4. **`/console` removal** in the 1.0.17 UI work (R4). This is part of G1, not G0.

## 14. Addendum (same day): public-repository sanitisation

- **Evidence files sanitised** before the local commit: the tailnet hostname, server user and home paths, the stack path, and co-tenant service details were replaced with placeholders or generalised. The unsanitised detail belongs in the private ops repository (`ShwePhaLa-private`); copying it there needs separate approval.
- **No built-in server path in the scripts.** `sync-functions.sh` now requires `REMOTE_FUNCTIONS_DIR` and refuses with exit 2 if it is unset. `functions-guard.sh check-deployed` requires the directory as an argument or `FUNCTIONS_DIR`, and also exits 2 without it. The private README carries the actual value.
- Two tests were added: S8 (no directory given → exit 2) and S9 (`REMOTE_FUNCTIONS_DIR` unset → exit 2, no rsync). Results are recorded in the reconciliation report of this step.
- **Read-only `check-deployed` run on lucashome** (owner-approved action D, 2026-10-16 20:50:55 UTC): `functions-guard: OK`, exit 0. `functions-router.sh status` reported `patched`, with no retired function present.
