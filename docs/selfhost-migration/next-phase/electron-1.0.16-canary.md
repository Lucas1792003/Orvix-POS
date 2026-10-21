# Electron 1.0.16 release: canary till, then rollout — final checklist and proposal

Status: **proposal, 2026-10-13 (UTC)**. Nothing has been pushed, built for release, tagged or published. Code facts were checked by reading the repo on branch `feature/selfhost-supabase-migration` (11 commits on top of `main` `ac2d663`, head `5e05867`) and `node_modules/electron-updater` **6.8.9** / `app-builder-lib` **26.15.3**. Plan context: [08-cutover-rollback.md](../08-cutover-rollback.md), [10-go-no-go-checklist.md](../10-go-no-go-checklist.md), [desktop-app/roadmap.md](../../desktop-app/roadmap.md).

## Decision summary

Each row is a separate approval; nothing moves to the next row without your OK.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Code freeze on the branch, version **1.0.16** (plain semver, no `-rc` suffix) | yes |
| D2 | Push the branch and open the PR **as `Lucas1792003`**; merge to `main` | yes, **after D2a** |
| D2a | What happens to the web deployments on merge (see R4: GitHub Pages workflow; Vercel) | decide before merging |
| D3 | Build Windows x64 + macOS arm64 with `--publish never`; smoke-test the installer | yes |
| D4 | **Rollback build = v1.0.15 code re-versioned to 1.0.17**, not the 1.0.16 code pointed at hosted (finding F1 below) | yes |
| D5 | Signing: ship **unsigned** for the canary (SmartScreen click-through on manual installs) | yes for canary; revisit before rollout |
| D6 | Publish v1.0.16 as a GitHub **pre-release** | yes, once the prerequisites table is green |
| D7 | Tailscale on the canary till with a tagged key + ACL | yes, after the ACL (hardening H6) is live |
| D8 | Promote to a full release after canary acceptance | your call on the morning after |
| D9 | Hosted keep-alive for 30 days from promotion | yes; decide where it runs |

**Findings that change the earlier plan (verified in code, 2026-10-13):**

- **F1: the branch client cannot run against hosted.** Every mutating RPC goes through `callRpc()` with a `p_idempotency_key` argument ([`src/stores/data/idempotentRpc.ts`](../../../src/stores/data/idempotentRpc.ts)) and there is no fallback. Hosted is at schema 001–061 ([hosted status](../../hosted-supabase/status.md)) and has no such parameter, so PostgREST would reject every sale, stock and payment call. A "1.0.16 code → hosted URL" rollback build (the original P3 in 08) would log in but fail on the first sale. The rollback must be the **v1.0.15 code** (tag `v1.0.15` = `3445d42`, known-good on hosted) with the version raised to 1.0.17.
- **F2 — corrected 2026-10-13 by test, see [release-compatibility §5](../phase-g/release-compatibility.md#5-e-local-database-upgrade-and-downgrade-tested-in-electron): no VersionError (Dexie 4.4.5 reopens the newer DB); the real risk is that v1.0.15 deletes all pending outbox entries on its first online load. Option (a) below does not prevent that.** Original text: **F2: local-database downgrade.** The branch raises the Dexie schema of `shwe-phala-local` to version **2** (outbox idempotency keys + `syncState`); v1.0.15 declares version **1**. A till that ran 1.0.16 and is then given v1.0.15 code will hit an IndexedDB VersionError when opening its local database. The rollback build therefore needs one small code change, or a documented "clear app data" step (R7).
- **F3: rollback tier B in 08 §4 assumes hosted and `lucashome` have identical schemas.** That stopped being true at migration 062. Restoring `lucashome` data (079) into hosted (061) is no longer "the forward runbook pointed the other way". Tier B must be re-planned before **G13** (full rollout). It does not block the canary, which only needs tier A.
- **F4: the pre-release canary mechanism is confirmed by code reading** (R9). It still needs one live proof after publishing.
- **F5: merging to `main` triggers `.github/workflows/deploy.yml`** (GitHub Pages, `npm run build` with no Supabase env in CI). Separately, the Vercel web build points at hosted. A new client there would fail every mutating call (F1) if Vercel deploys `main` automatically.

## Prerequisites before the pre-release (D6)

| # | Item | State 2026-10-13 | Source |
|---|---|---|---|
| P-a | Server migrations the client needs | **079 applied** (client needs ≥ 076 for `/setup`, 078–079 for org-scoped upload paths) | [lucashome status](../../lucashome-selfhost/status.md) |
| P-b | Owner TOTP verified (G5) | open | [owner-totp-test.md](owner-totp-test.md) |
| P-c | Reboot + G3 done (no pending kernel during the canary) | open | [reboot-and-hardening.md](reboot-and-hardening.md) |
| P-d | Offsite backups live and one restore from R2 green | open | [offsite-backup-enable.md](offsite-backup-enable.md) |
| P-e | Monitoring: at least the healthchecks dead-man for backups + host. The overnight canary validation assumes alerts exist; [09](../09-monitoring-alerting.md) layers A/B are **not built yet** | open | 09 |
| P-f | Tailscale ACL with `tag:till` live (H6); key-expiry policy (H8) | open | reboot-and-hardening H6/H8 |
| P-g | Hosted has not changed since the 2026-10-11 23:47 export (no catalogue edits via v1.0.15). Otherwise a fresh read-only export + restore is needed first (08 T+0:05) | owner to confirm | 08 §3 |
| P-h | A non-production Windows machine for the installer smoke test, and the canary till identified (O11) | owner | 10 |
| P-i | Rollback build (R7) built and tested, not published | open | — |

## R1. Code freeze

```
mac$ cd /Users/waiyan/Projects/personal/ShwePhaLa
mac$ git switch feature/selfhost-supabase-migration
mac$ git status --porcelain            # must be empty. Today it is not: docs edits from the 077–079 session are uncommitted; commit or set aside first
mac$ git log --oneline main..HEAD      # record the list; freeze = only the version bump (R3) and docs after this point
mac$ git rev-parse HEAD                # record as the release candidate commit
```

Any code change after the freeze restarts R2.

## R2. Gates (local on the Mac; the repo has no CI test workflow)

Keys are read into shell variables only, as in [`e2e/README.md`](../../../e2e/README.md). Never echo them.

| Gate | Command | Pass |
|---|---|---|
| Types | `npx tsc -b` | exit 0 |
| Unit | `npm test` | **744 passed**, 0 failed (the hosted-request guard is active in every file) |
| Lint | `npx eslint .` | only the 24 known errors in `src/lib/zawgyi.ts`; no new ones |
| DB harness | `bash supabase/tests/phase-d/run.sh` | **467/0** at max migration 079 |
| Edge functions | `bash supabase/tests/functions/run.sh` | all pass (mocked email) |
| Live suites (QA data on `lucashome`) | `src/live/phase-d.live.test.ts` (16/16), `phase-g.org-isolation.live.test.ts` (12/12), `phase-g2.live.test.ts`, per [live README](../../../supabase/tests/phase-d/live/README.md) | all pass; then `cleanup.sql` → audit purge → `verify_clean.sql` prints **CLEAN** |
| E2E | `npm run e2e` | **25/25**, zero hosted requests in `e2e/.results/evidence.jsonl`; then `npm run e2e:cleanup` → CLEAN |

Record the outputs in `docs/selfhost-migration/evidence/G12/<date>-release-gates.md`.

## R3. Version bump

```
mac$ npm version 1.0.16 --no-git-tag-version      # package.json + package-lock.json
mac$ git commit -am "Release 1.0.16"               # no Co-Authored-By / "Generated with" lines
```

Not `1.0.16-rc.1`. electron-updater turns `allowPrerelease` on for any running version with a prerelease component (`AppUpdater.js`: `this.allowPrerelease = hasPrereleaseComponents(currentVersion)`), and electron-builder derives an update channel from the suffix. Both would break the canary mechanism in R9.

## R4. Push, PR, merge (as `Lucas1792003`; owner approval for each)

```
mac$ gh auth status                                  # active account must be Lucas1792003 (it is, 2026-10-13)
mac$ git push -u origin feature/selfhost-supabase-migration      # never to main
mac$ gh pr create --base main --head feature/selfhost-supabase-migration \
       --title "Self-hosted Supabase backend: client hardening, migrations 059-079, release 1.0.16" --body-file <file>
```

The PR body lists the migrations, the gate results from R2, and the release plan. It carries **no** "Generated with Claude Code" line and no Claude co-author (standing owner rule).

**Before merging (D2a):**
- `.github/workflows/deploy.yml` runs on every push to `main`: `npm ci && npm run build`, then deploys `dist` to GitHub Pages. CI has no `VITE_SUPABASE_*` values. Since the fail-closed change, that bundle renders "The app cannot start" (before the change it was broken in a different way). Decide: is the Pages site used? If not, disable the workflow in the same PR. If yes, decide which backend it should point at.
- Vercel: the web build "still points at hosted; usage unknown" ([desktop-app risks](../../desktop-app/risks.md)). If the Vercel project auto-deploys `main`, the merged client goes live against hosted and fails every mutating call (F1). Pause auto-deploy for `main` in the Vercel dashboard first, or confirm nobody uses it.

Merge: `gh pr merge --merge` as `Lucas1792003`, or you in the GitHub UI. Then `git switch main && git pull` and build from the merge commit.

## R5. Build (Mac; Windows x64 + macOS arm64, never published from here)

```
mac$ git status --porcelain                                    # empty
mac$ rm -rf dist release
mac$ npm ci                                                     # postinstall patch-package applies patches/app-builder-lib+26.15.3.patch
mac$ grep -l old-uninstaller.exe node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh   # the v1.0.14 uninstaller fix is present
mac$ export VITE_SUPABASE_URL=https://lucashome.tail8a86e4.ts.net
mac$ export VITE_SUPABASE_ANON_KEY="$(ssh -o BatchMode=yes lucashome 'grep "^ANON_KEY=" /srv/supabase/stack/.env | cut -d= -f2-')"
mac$ npm run build:electron                                     # host-pinned: VITE_SUPABASE_EXPECTED_HOST=lucashome.tail8a86e4.ts.net
mac$ grep -o 'src="[^"]*"' dist/index.html                      # ./assets/...  (not /assets/...; the v1.0.2 white-screen lesson)
mac$ grep -l 'lucashome.tail8a86e4.ts.net' dist/assets/*.js | wc -l     # >= 1
mac$ grep -l 'gzqiukxnzfdouwaotelx' dist/assets/*.js | wc -l            # 0 (no hosted project ref)
mac$ npx electron-builder --win --x64 --publish never
mac$ npx electron-builder --mac --arm64 --publish never
mac$ grep -E '^version:' release/latest.yml release/latest-mac.yml      # 1.0.16 in both
mac$ shasum -a 256 release/*.exe release/*.dmg release/*.zip | tee ~/release-1.0.16.sha256
```

Use `npx electron-builder … --publish never` directly, **immediately after** `build:electron` with nothing in between that touches `dist/`. The `electron:build:*` npm scripts do not pass `--publish never`; with a `GH_TOKEN` in the environment, electron-builder can create a draft release on its own.

Expected assets for the release (Windows + macOS arm64): `Shwe-Pha-La-POS-Setup-1.0.16.exe`, `.exe.blockmap`, `latest.yml`, `Shwe-Pha-La-POS-1.0.16-arm64.dmg`, `.dmg.blockmap`, `Shwe-Pha-La-POS-1.0.16-arm64.zip`, `.zip.blockmap`, `latest-mac.yml` = **8**. Earlier releases had 12 (they also carried macOS x64). If any Intel Mac runs the app, build `--mac --x64 --arm64` instead. Otherwise `latest-mac.yml` lists arm64 only. (macOS auto-update does not apply anyway: ad-hoc signature, see [doc 10](../../10-offline-desktop-known-issues.md).)

## R6. Installer smoke test (before any publish)

**Static (Mac):** extract `app.asar` from the packaged app into a scratch dir (`@electron/asar`, an electron-builder dependency, or 7-Zip on Windows). `grep -rl gzqiukxnzfdouwaotelx` → none; `grep -rl lucashome.tail8a86e4.ts.net` → present.

**Packaged boot + no hosted requests (Mac, arm64 build):** launch the packaged binary through Playwright's `_electron.launch({ executablePath: "release/mac-arm64/Shwe Pha La POS.app/Contents/MacOS/Shwe Pha La POS" })`, the same way as the 2026-10-12 smoke. Set `ORVIX_POS_E2E=1` and `ORVIX_POS_E2E_USER_DATA=<scratch dir>` (named `SHWE_POS_E2E*` in builds up to 1.0.16). [`electron/main.cjs`](../../../electron/main.cjs) honours these in packaged builds too; they only redirect `userData` and skip DevTools, so the run never touches a real install's local database. Record every request host. Pass: window renders (no blank screen), login footer `Backend: lucashome.tail8a86e4.ts.net`, **zero** `*.supabase.co` requests, QA cashier login reaches the POS (QA tenant from an E2E seed, cleaned up afterwards).

**Windows (P-h machine, on the tailnet):** run the NSIS installer over an existing v1.0.15 install. That also exercises the v1.0.14 old-uninstaller fix on real hardware, which [doc 10](../../10-offline-desktop-known-issues.md) still lists as unconfirmed. SmartScreen → "More info" → "Run anyway" (unsigned). Pass: installs without "cannot be closed"; app starts; sidebar shows **1.0.16**; footer shows `lucashome`; QA login works; `%APPDATA%\retails-shop\logs\updater.log` shows `update not available` (latest published is still 1.0.15, and `allowDowngrade` is false). If it hangs: the recovery commands in doc 10 "Current Windows release and recovery".

## R7. Rollback build: version 1.0.17 pointing at hosted (prepared, tested, **not** published)

**Source:** a separate worktree from tag `v1.0.15`, so the main checkout and its `dist/` are not touched:

```
mac$ git worktree add ../ShwePhaLa-1.0.17-rollback v1.0.15
mac$ cd ../ShwePhaLa-1.0.17-rollback && git switch -c release/1.0.17-rollback
mac$ npm version 1.0.17 --no-git-tag-version
```

**Version string:** plain `1.0.17`, release title "v1.0.17 — rollback to hosted". `1.0.17-rollback` is a semver prerelease, so tills that installed it would start following pre-releases (R3). Because `allowDowngrade` is false, the rollback must be numerically higher than 1.0.16. If it is ever published, the next forward release is 1.0.18.

**Local-database downgrade (F2), choose one (owner decision):**
- (a) **Recommended:** a small change on `release/1.0.17-rollback`: in `src/lib/localDb.ts` declare `version(3)` that restates the v1 tables, so an existing v2 database opens. The outbox keeps entries but they must be empty anyway (see the rollback rule below). Tested by installing 1.0.17 over 1.0.16 on the P-h machine.
- (b) No code change; the rollback procedure clears the till's app data (`%APPDATA%\retails-shop`) before installing 1.0.17. Simple, and fine for tier A (one canary till). Painful for a fleet.

**Rollback rule regardless of (a)/(b):** a till may only be rolled back with an **empty outbox** (Sync page: 0 pending). 1.0.16 outbox entries carry `p_idempotency_key` and must never replay against hosted.

**The host pin, overridden deliberately without weakening it:**
- v1.0.15 code predates the pin (`build:electron` there is `tsc -b && cross-env ELECTRON_BUILD=true vite build`). It takes whatever `VITE_SUPABASE_URL` is in the environment or `.env.local`. Make the target explicit and assert it after the build:
  ```
  mac$ export VITE_SUPABASE_URL=https://gzqiukxnzfdouwaotelx.supabase.co
  mac$ export VITE_SUPABASE_ANON_KEY="<read into the shell from: supabase projects api-keys --project-ref gzqiukxnzfdouwaotelx — a read of hosted, needs your approval; never echoed>"
  mac$ npm ci && npm run build:electron
  mac$ grep -l gzqiukxnzfdouwaotelx dist/assets/*.js | wc -l                # >= 1
  mac$ grep -l lucashome.tail8a86e4.ts.net dist/assets/*.js | wc -l         # 0
  mac$ npx electron-builder --win --x64 --publish never   # (+ --mac --arm64 if wanted)
  ```
- If you ever build hosted from **pinned** code (not recommended, F1), do not edit `package.json` or remove the guard. `build:electron` sets `VITE_SUPABASE_EXPECTED_HOST` itself through `cross-env`, which overrides the shell, so a hosted URL fails with "Backend host mismatch" by design. Run the same steps by hand with the pin naming the other host explicitly:
  `npx tsc -b && npx cross-env ELECTRON_BUILD=true VITE_SUPABASE_EXPECTED_HOST=gzqiukxnzfdouwaotelx.supabase.co vite build`.
  The pin stays enforced (URL host must equal the named host); it is pointed at a different, deliberately named host. A committed `build:electron:hosted` script would be the reviewable form of the same thing (separate code change).

**Smoke test of the rollback build:** static grep as above; install on the P-h machine **over 1.0.16** (proves F2 handling); launch to the **login page only**. Signing in would create sessions on hosted, which is a hosted write and needs your separate approval.

## R8. Signing decision (D5)

| Option | Cost | Effect |
|---|---|---|
| Unsigned (today, v1.0.1–1.0.15) | $0 | SmartScreen "Windows protected your PC" on manual installs; electron-updater on Windows still installs unsigned updates (no `publisherName` configured, so no signature check), as every release so far |
| Windows OV certificate | ~US$200–400/yr + token/HSM | removes most SmartScreen friction after reputation builds |
| Azure Trusted Signing | ~US$10/month; identity validation, regional availability | same, cheaper; eligibility to check |
| Apple Developer ID + notarization | US$99/yr | fixes macOS Gatekeeper and Squirrel.Mac auto-update; Mac is not a till |

Recommendation: unsigned for the canary (owner-controlled tills, staff guided). Decide before G13 whether tills will ever see manual installs.

## R9. GitHub pre-release and why tills ignore it (D6; owner approval)

```
mac$ gh release create v1.0.16 --repo Lucas1792003/ShwePhaLa --target <merge-commit-sha> --prerelease \
       --title "v1.0.16 (canary — self-hosted backend)" --notes-file <notes> \
       release/Shwe-Pha-La-POS-Setup-1.0.16.exe release/Shwe-Pha-La-POS-Setup-1.0.16.exe.blockmap release/latest.yml \
       release/Shwe-Pha-La-POS-1.0.16-arm64.dmg release/Shwe-Pha-La-POS-1.0.16-arm64.dmg.blockmap \
       release/Shwe-Pha-La-POS-1.0.16-arm64.zip release/Shwe-Pha-La-POS-1.0.16-arm64.zip.blockmap release/latest-mac.yml
mac$ gh release view v1.0.16 --repo Lucas1792003/ShwePhaLa --json isPrerelease,assets --jq '.isPrerelease, (.assets|length)'   # true, 8
mac$ curl -sI https://github.com/Lucas1792003/ShwePhaLa/releases/latest | grep -i '^location'                                  # .../tag/v1.0.15
```

**Behaviour, verified in code:**
- `electron/main.cjs` sets `autoDownload`, `autoInstallOnAppQuit`, `autoRunAppAfterInstall`, `disableWebInstaller`. It **never** sets `allowPrerelease`, `allowDowngrade` or `channel`. It checks 5 s after launch and every 4 h, in packaged builds only.
- `electron-updater` 6.8.9 `AppUpdater.js`: `allowPrerelease` defaults to `false` and becomes `true` only if the running version has a prerelease component; `allowDowngrade` defaults to `false`. Setting `channel` would force `allowDowngrade = true`, which is one more reason not to use channels.
- `providers/GitHubProvider.js`: with `allowPrerelease = false` it asks `github.com/<owner>/<repo>/releases/latest` for the tag. GitHub never returns a pre-release or a draft there. A v1.0.15 till therefore keeps seeing **1.0.15** as latest while v1.0.16 is a pre-release.
- `isUpdateAvailable` installs only when the latest version is **greater** than the running one (downgrade off). Re-publishing an older build never rolls a till back.

Live proof after publishing (closes "canary mechanism unproven" in [desktop-app risks](../../desktop-app/risks.md)): on a machine still on 1.0.15, "Check for Updates" → "up to date"; `updater.log` → `update not available … latest version: 1.0.15`. The `curl -sI …/releases/latest` line above is the server-side half of the same proof.

## R10. Tailscale on the canary till (D7; owner + shop staff)

1. ACL with `tag:till` saved (hardening H6). The till will reach `lucashome:443` and nothing else.
2. You generate an auth key: admin console → Settings → Keys → **Generate auth key**: not reusable, not ephemeral, **pre-approved**, tags `tag:till`, key valid 1–7 days. Tagged devices get node-key expiry disabled automatically. Type it into the till yourself; it never goes through chat.
3. On the till (Windows, admin PowerShell): install Tailscale from tailscale.com/download, then
   `tailscale up --auth-key=<key> --unattended --hostname=till-<shop>-1` (`--unattended` keeps it connected without a logged-in user). MagicDNS on (default).
4. Verify on the till:
   ```
   tailscale status                                   # lucashome listed
   tailscale ping lucashome                           # record: direct or DERP (which region), latency
   curl.exe -s -o NUL -w "%{http_code}" https://lucashome.tail8a86e4.ts.net/auth/v1/health    # any 3-digit code = TLS + routing OK; 000 = fail
   Test-NetConnection lucashome.tail8a86e4.ts.net -Port 22      # TcpTestSucceeded : False (ACL denies)
   w32tm /query /status                               # time source set, recent sync (F19 clock skew)
   ```
5. Then the G10 measurements from [06 §5](../06-rehearsal-test-plan.md): 20× ping, 100× GET p50/p95, scripted QA `complete_sale`, 24 h `mtr`. The owner accepts the numbers against the thresholds (checkout p95 ≤ 1.5 s, login ≤ 4 s, `loadData` ≤ 8 s).

## R11. Canary install and acceptance (08 §3 T+1:35 → §5; gate G12)

Install `Shwe-Pha-La-POS-Setup-1.0.16.exe` by hand on the canary till, downloaded from the pre-release page. Everyone signs in again: a new JWT secret means the hosted sessions are invalid.

| # | Acceptance criterion | How checked | Fail → |
|---|---|---|---|
| C1 | Sidebar shows 1.0.16, footer `backend: lucashome.tail8a86e4.ts.net` | screen | tier A |
| C2 | ADMIN login with the migrated TOTP factor; cashier password login | screen + `auth.sessions.aal` | tier A |
| C3 | Open shift → **3 sales** of low-value stock (you on the phone) → receipts printed and correct → 1 refund → shift close | receipts; `sales`/`sale_items`/`refunds`/`shifts` rows on `lucashome` | tier A |
| C4 | Stock correct: `inventory` deltas equal the sold quantities, once | SQL before/after | tier A |
| C5 | Zero duplicates (the duplicate-sale query in [09](../09-monitoring-alerting.md)) | SQL | tier A |
| C6 | Outbox empty: Sync page 0 pending, no conflicts | screen | tier A |
| C7 | Overnight validation 8–10 h: zero critical alerts, backups green (`backup-status.sh` OK, offsite OK), Realtime not flapping (`RestartCount` unchanged) | monitoring + status | tier A before opening |
| C8 | Zero requests to `*.supabase.co` from the till | Tailscale/DNS logs or a hosted-side check of no new sessions (read-only, approval) | investigate |

Pre-production note: the hosted DB holds no sales (08 §1). Decide whether the 3 canary sales are **real** (the business's first recorded sales) or go to a QA shop. With a QA shop, C3 proves the mechanics but not the real shop's catalogue and price levels.

Evidence: `docs/selfhost-migration/evidence/G12/<date>-canary.md`.

## R12. Promotion to full release (D8; owner approval)

```
mac$ gh release edit v1.0.16 --repo Lucas1792003/ShwePhaLa --prerelease=false --latest
mac$ curl -sI https://github.com/Lucas1792003/ShwePhaLa/releases/latest | grep -i '^location'      # .../tag/v1.0.16
```

Tills update on next launch (check after 5 s) or within 4 h. Staff restart the app and sign in. Confirm each till's sidebar version. A till that cannot update gets the installer by hand. **Do not run mixed versions in one shop**: v1.0.15 fails every mutating call against `lucashome`. G13: 3 consecutive trading days with zero duplicates, zero stuck outbox entries, backups green, p95 within acceptance, zero critical alerts.

## R13. Rollback tiers (updated for F1–F3)

| Tier | When | Procedure | Status |
|---|---|---|---|
| Single till | one till misbehaves on 1.0.16 | reinstall the 1.0.16 installer; if local data is corrupt, empty outbox first, then clear app data | ready |
| **A** | before real trading on `lucashome` (canary, validation window) | 1) every 1.0.16 till: outbox empty; 2) publish **1.0.17** (v1.0.15 code, hosted) as a full release (approval); 3) tills update on restart (needs R7 option a, or clear app data with b); 4) re-key the canary sales on hosted by hand (a hosted write: approval); 5) `lucashome` frozen | needs R7 built and tested |
| **B** | after real trading on `lucashome` | **must be re-planned (F3)**: hosted lacks 062–079 (idempotency ledger, org columns, upload paths). Options: apply 062–079 to hosted at rollback time and then reverse-restore; or tier C to a new host; or fix forward. Decision needed before G13 | **not ready** |
| C | `lucashome` lost | restore from offsite to a replacement host (OFFSITE-ENABLE §8.2), same hostname and JWT secret, so tills reconnect | needs offsite (P-d) |

## R14. 30-day hosted keep-alive (D9)

Hosted stays unchanged as the fallback for ≥ 30 days after promotion (G14, [hosted roadmap](../../hosted-supabase/roadmap.md)). The Free plan pauses after ~7 idle days. Start a daily **read-only** ping on promotion day:
- What: `supabase db query --linked "select 1"` (Management API, CLI login in the macOS keychain), or an anon REST `GET` on a table. Whether an anon REST call counts as "activity" for the pause rule is **unknown**; the SQL query through the Management API is the safer signal.
- Where (your decision): the Mac (launchd, daily; only when the Mac is awake), `lucashome` cron (always on, but dies with the host it is the fallback for), or `cyfro-staging` (always on, but it is a work server; 08 P8 assumed it). Recommendation: Mac launchd daily plus a weekly manual look at the hosted dashboard.
- Stop: at G14, when you decide to pause or delete hosted. Keep the 2026-10-11 golden export permanently (offsite `golden/`).

## Risks

| Risk | Mitigation |
|---|---|
| A mixed-version shop (1.0.15 + 1.0.16) | rollout rule: whole shop or nothing; manual installer for stragglers |
| Pre-release accidentally marked "latest" | `--prerelease` + the `releases/latest` curl check right after publishing |
| electron-builder auto-publishing a draft | `--publish never` on every build |
| Rollback build fails on hosted | v1.0.15 code (F1); tested over 1.0.16 (F2) |
| Merge breaks a web deployment | D2a before merge (F5) |
| No alerts during the overnight validation | P-e |
| SmartScreen blocks staff | owner installs the canary in person/remote session; signing decision before G13 |
| Old-uninstaller hang on Windows (v1.0.9 history) | R6 upgrade-over-1.0.15 test; recovery commands in doc 10 |

## Time and approvals

| Step | Time | Approval | Sudo / account |
|---|---|---|---|
| R1–R3 freeze, gates, bump | ½ day (E2E + live suites ≈ 1 h) | live suites + E2E write QA data on `lucashome`: yes | no |
| R4 push / PR / merge | 30 min + review | **yes** (each) | GitHub `Lucas1792003` |
| R5–R6 build + smoke | 1–2 h | yes (Windows test machine) | no |
| R7 rollback build | 1–2 h (+ code change for option a) | **yes** (hosted key read; code change) | no |
| R9 pre-release | 15 min | **yes** | `Lucas1792003` |
| R10 Tailscale on till | 30 min + 24 h `mtr` | **yes** (shop device) | till admin; Tailscale admin |
| R11 canary + overnight | evening + night | **yes** | — |
| R12 promotion | 15 min + morning restarts | **yes** | `Lucas1792003` |
| R14 keep-alive | 15 min | **yes** (recurring hosted read) | Supabase CLI login |

No backend downtime is expected anywhere in this checklist. The customer-visible cost is the staff restart and sign-in on rollout morning.
