# Release checklist: lucashome go-live with desktop 1.0.16 — one ordered list

Status: **proposal, 2026-10-13 (UTC)**, not approved. Merges the four next-phase proposals and the two phase-g release analyses into one order of work. Nothing here has been executed unless the State column says so. Each **Gate** row needs the owner's explicit approval at the time it is run (standing rule: confirm before every push, merge, release, deploy or host change; GitHub actions only as `Lucas1792003`; never `git push origin main`; no Claude co-author lines).

Sources (read these for the detail of each step):
- [owner-totp-test.md](owner-totp-test.md) — G5
- [reboot-and-hardening.md](reboot-and-hardening.md) — G3 + H1–H10
- [offsite-backup-enable.md](offsite-backup-enable.md) — G8 offsite part
- [electron-1.0.16-canary.md](electron-1.0.16-canary.md) — R1–R14 (build, canary, promotion, keep-alive)
- [../phase-g/release-compatibility.md](../phase-g/release-compatibility.md) — client × backend matrix, local DB, updater, rollback, **emergency procedure**
- [../phase-g/deployment-automation-audit.md](../phase-g/deployment-automation-audit.md) — Vercel / GitHub Pages guards, safe push→merge procedure
- [../phase-g/migration-080.md](../phase-g/migration-080.md) — 080 upload completion URL; [../phase-g/phone-upload-jit.md](../phase-g/phone-upload-jit.md) — JIT signed upload token; [../../lucashome-selfhost/risks.md](../../lucashome-selfhost/risks.md) — 60 s phone-upload token
- [../10-go-no-go-checklist.md](../10-go-no-go-checklist.md) — gate definitions G0–G14; [../08-cutover-rollback.md](../08-cutover-rollback.md)

Legend: **O** = owner (dashboards, sudo, devices, decisions), **E** = engineer, **O+E** = owner acts, engineer verifies read-only.

## Corrections to the earlier proposals (from the 2026-10-13 compatibility tests)

1. **Canary F2 / R7 option (a) is wrong.** Dexie 4.4.5 does not raise `VersionError`; v1.0.15 opens the 1.0.16 database. The real hazard: v1.0.15 code **silently deletes every pending outbox entry on its first online full load** (observed in Electron). A `version(3)` restatement does not help. → Rollback build = v1.0.15 + A8 fix + "pending 1.0.16 queue" boot guard (compatibility §5.2), and the empty-queue rule stays mandatory.
2. **Vercel deploys more than "maybe main".** Every non-main branch push creates a Preview; every `main` push deploys Production on the public domain, built against hosted. Guards must be in place **before the first push**, not just before merge (audit §6).
3. **`main` ≠ v1.0.15.** `main` (`ac2d663`) is 4 commits ahead of tag `v1.0.15` (`3445d42`). Build any rollback from the tag (canary R7 already says so).
4. **Old client × lucashome is not fully closed:** RPCs fail (`IDEMPOTENCY_KEY_REQUIRED`), but catalogue table writes succeed. Never point a v1.0.15-based build at lucashome.

## Phase 1 — Host readiness (no client change yet)

| # | Step | Who | Gate | Evidence / done when | Source |
|---|---|---|---|---|---|
| 1.1 | Owner TOTP login on lucashome with the migrated factor (dev server pinned to lucashome) | O+E | yes (10 min) | engineer V1–V6: new `aal2` session, `totp` AMR claim, factor ids unchanged, `auth.users` = 10 → **G5** | owner-totp-test |
| 1.2 | Maintenance window W: pre-checks → reboot (owner at the keyboard) → G3 checks C1–C14 | O+E | yes (sudo, physical presence) | all containers/serve/cert back ≤ 5 min, backups + WAL resume, counts SAME → **G3** | reboot-and-hardening A–C |
| 1.3 | Hardening H0 → H1 (ufw, after port answers) → H2 sshd → H4 docker daemon → H5 memory limits → **H6 Tailscale ACL with `tag:till`** → H7 second admin → H8 key expiry → H9 SMART (H3/H10 optional) | O (+E verify) | yes, **each step separately** | per-step verify lines; H6 must be live before any till joins | reboot-and-hardening H |
| 1.4 | Offsite backups: O1–O10 (owner secrets), dry runs, enable + first sync, **first restore from R2**, cron lines, Mac pull tier, bundle decrypt on the Mac | O+E | yes (data leaves host; crontab change) | `offsite-restore-test.sh` green twice, S1–S8, healthchecks green → **G8** offsite part | offsite-backup-enable |
| 1.5 | Monitoring minimum: healthchecks dead-man for local backups (`HEALTHCHECKS_URL`) + host; alerts reach the owner's phone (test alert) | O+E | yes | test alert received (canary P-e) | offsite §6, [09](../09-monitoring-alerting.md) |
| 1.6 | Secrets bundle (JWT secret, anon/service keys, `.env`) stored offsite and decryptable on the Mac — needed for the "replacement host" emergency path | O+E | yes | decrypt test logged | 07, offsite §5 |

## Phase 2 — Server changes the 1.0.16 client should ship with

| # | Step | Who | Gate | Evidence | Source |
|---|---|---|---|---|---|
| 2.1 | Apply **080** (upload completion stores a server-derived URL): read-only pre-checks, `apply-migrations.sh --from 080 --to 080 --dry-run`, then apply | E | yes | harness green at 080; post-apply verification; `verify_clean` CLEAN after any live test | migration-080 §5 |
| 2.2 | JIT phone upload: deploy Edge Function `phone-upload-token` to lucashome; client change (fresh token right before upload) reviewed and committed; decide `UPLOAD_SIGNED_URL_EXPIRATION_TIME` (owner chose: keep 60 s, use JIT) | O decides, E deploys | yes (stack change) | live phone upload > 60 s after QR succeeds; 080 completion accepts it | [phone-upload-jit](../phase-g/phone-upload-jit.md), lucashome risks, migration-080 §3 |
| 2.3 | Re-run all gates after 2.1/2.2: `tsc -b`, `npm test`, DB harness at 080, live suites + cleanup, `npm run e2e` + cleanup | E | QA writes on lucashome: yes | numbers recorded in `evidence/G12/<date>-release-gates.md`; `verify_clean` CLEAN; real counts unchanged | canary R2 |

## Phase 3 — Code freeze, safeguards, version

| # | Step | Who | Gate | Evidence | Source |
|---|---|---|---|---|---|
| 3.1 | Recommended client safeguards before freeze: outbox entries stamped with `backendHost` + contract and refused on mismatch; Sync page "Export queue" | E | code review | unit tests for both | compatibility §5 |
| 3.2 | Deployment guards committed on the branch: `vercel.json` `git.deploymentEnabled` false for `main` + branch; Pages workflow → `workflow_dispatch` (or removed); optional unpinned-web-build refusal; `--publish never` release scripts | E | owner reviews diff | diff | audit §4 |
| 3.3 | Code freeze; `git status` clean; record RC commit | E | — | `git log main..HEAD` | canary R1 |
| 3.4 | `npm version 1.0.16 --no-git-tag-version`; commit (plain `1.0.16`, never `-rc`) | E | yes | `package.json` 1.0.16 | canary R3 |
| 3.5 | **Signing decision** (D5): unsigned for canary (SmartScreen click-through) vs Windows OV / Azure Trusted Signing before G13 | O | decision | note | canary R8 |

## Phase 4 — Deployment automation guards (dashboards) and push / PR / merge

| # | Step | Who | Gate | Evidence | Source |
|---|---|---|---|---|---|
| 4.1 | Vercel: record Production branch, env var names × environments × host, Deployment Protection; **pause builds** (Ignored Build Step `exit 0` or disconnect repo); decide the web app's future (V4) | **O (dashboard)** | yes | notes V1–V4 | audit §5 |
| 4.2 | GitHub: disable "Deploy to GitHub Pages" workflow; unpublish Pages; optional branch protection on `main` | **O (dashboard)** | yes | workflow `disabled_manually`; Pages off | audit §5 G1–G3 |
| 4.3 | `gh auth status` = `Lucas1792003`; push the branch | E | **yes** | — | audit S3–S4 |
| 4.4 | Verify: no new Preview deployment, no Actions run for the branch sha | E (read-only) | — | `gh api …/deployments`, `…/actions/runs` | audit S5 |
| 4.5 | Open PR (body: migrations 059–080, gate results, release plan; no Claude lines) | E | **yes** | PR URL; 4.4 repeated | canary R4 |
| 4.6 | Merge (owner UI or `gh pr merge --merge`) | O / E | **yes** | merge sha | canary R4 |
| 4.7 | Verify after merge: no Production deployment for the merge sha, no Pages run, `shwe-pha-la.vercel.app` still the old bundle | E (read-only) | — | outputs | audit S9 |

## Phase 5 — Build, rollback build, publish as pre-release

| # | Step | Who | Gate | Evidence | Source |
|---|---|---|---|---|---|
| 5.1 | Build from the merge commit: `npm ci`, pinned `build:electron`, asset greps (lucashome ≥ 1, hosted ref 0, `./assets/`), `electron-builder --win --x64 --publish never` (+ mac arm64), sha256 | E | — | `latest.yml` 1.0.16; checksums | canary R5 |
| 5.2 | Installer smoke: static asar grep; packaged boot with isolated userData (0 hosted requests, footer lucashome); Windows install **over v1.0.15** on the P-h machine | O+E | yes (test machine) | updater.log "update not available" | canary R6 |
| 5.3 | Rollback build **1.0.17** from tag `v1.0.15` + A8 fix + pending-queue boot guard, hosted URL (hosted anon key read = approval), asset greps; install over 1.0.16 on P-h, login page only. **Not published** | E | yes (hosted key read; code change) | static greps; boot-guard screen shown when a 1.0.16 queue exists | canary R7 + compatibility §5.2, §8 |
| 5.4 | Publish v1.0.16 as GitHub **pre-release** (8 assets); `releases/latest` still v1.0.15 | E | **yes** | `isPrerelease true`, latest = v1.0.15 | canary R9 |
| 5.5 | Live proof: a 1.0.15 machine "Check for Updates" → up to date | O | — | updater.log | canary R9 |

## Phase 6 — Canary and monitoring

| # | Step | Who | Gate | Evidence | Source |
|---|---|---|---|---|---|
| 6.1 | Tailscale on the canary till: tagged pre-approved key (`tag:till`), `--unattended`; verify health 3-digit, SSH denied, time sync; G10 measurements (ping, p50/p95, scripted checkout, 24 h mtr) | O (+shop staff), E verify | **yes** (shop device) | owner accepts numbers → **G10** | canary R10 |
| 6.2 | P-g: hosted unchanged since the 2026-10-11 export, or fresh export first | O | confirm | note | canary P-g |
| 6.3 | Install 1.0.16 by hand on the canary till; acceptance C1–C8 (incl. migrated-ADMIN TOTP login on the till, 3 sales, refund, shift close, stock, zero duplicates, outbox empty, zero hosted requests) | O+E | **yes** | `evidence/G12/<date>-canary.md` → **G12** | canary R11 |
| 6.4 | Overnight validation 8–10 h: zero criticals, backups + offsite green, Realtime stable | E (+alerts to O) | — | status outputs | canary C7 |
| 6.5 | Decide whether the canary sales are the business's first real sales (if yes, phase 7's pre-sales rollback no longer applies after this point) | O | decision | note | canary R11 note |

## Phase 7 — Promotion, rollout, recovery

| # | Step | Who | Gate | Evidence | Source |
|---|---|---|---|---|---|
| 7.1 | Promote v1.0.16 to full release; `releases/latest` = v1.0.16; tills update on restart; confirm each till's version; whole shop or nothing | E + O | **yes** | per-till version list | canary R12 |
| 7.2 | First trading days watched: 3 consecutive days zero duplicates, zero stuck outbox, backups green, p95 within acceptance → **G13** | E + O | — | monitoring export | 10, 08 |
| 7.3 | Hosted keep-alive (daily read-only) for ≥ 30 days; then G14 decision on hosted | O decides where, E sets up | **yes** (recurring hosted read) | ping log | canary R14 |
| 7.4 | **Pre-sales rollback (tier A)** — only before the first real sale: empty/export every 1.0.16 queue → hand-install the 1.0.17 rollback build (or publish it only after every till is confirmed empty) → clear app data on the canary till after export → re-key canary sales on hosted (approval) → freeze lucashome | O decides, E executes | **yes** | per-till "0 pending" confirmation | compatibility §8 |
| 7.5 | **After the first real sale: forward-fix only.** EMERGENCY procedure if lucashome fails: keep tills selling offline on 1.0.16 (12 h write window) → diagnose → restore from local backup/PITR → or stand up a replacement host from offsite with the same Tailscale name, TLS name and JWT secret → let tills drain. Never switch to hosted, never publish a v1.0.15-based build, never clear app data with pending entries | O decides, E executes | — | `evidence/G13/cutover-log.md` | compatibility §8 "EMERGENCY procedure" |

## Open decisions for the owner (one line each)

D-a signing (3.5) · D-b web app future / Vercel (4.1) · D-c Pages off (4.2) · D-d client safeguards 3.1 in 1.0.16 or later · D-e canary sales real or QA shop (6.5) · D-f keep-alive location (7.3) · D-g whether to build the rollback build at all once real sales are planned for the canary night.
