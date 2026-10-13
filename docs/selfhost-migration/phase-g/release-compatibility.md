# Release compatibility: client × backend, local database, updater, rollback

Status: **analysis + tests, 2026-10-13 (UTC)**. Nothing was pushed, merged, released or deployed. Hosted Supabase was never contacted (no `supabase` CLI command, no `*.supabase.co` request from any client run here; every Electron run counted 0 hosted requests). The only writes were QA rows on `lucashome`, removed afterwards (§9).

Code under test:
- **Old client** = tag `v1.0.15` (`3445d42`), the code inside the published v1.0.15 installers. Note: `main` (`ac2d663`) is **4 commits ahead** of the tag (migrations 056–058 + live stock via Realtime). `main` is what Vercel production serves (§ Part 2 audit). Both have the same Dexie schema (v1), the same RPC payloads and the same outbox, so every old-client finding below applies to both.
- **New client** = branch `feature/selfhost-supabase-migration` head `11cd3d5` (13 commits on `main`).

Both were checked out as detached worktrees **outside** the repo (session scratchpad) and removed at the end.

Related: [canary checklist](../next-phase/electron-1.0.16-canary.md) · [08 cutover/rollback](../08-cutover-rollback.md) · [idempotency contract](../phase-d/idempotency-contract.md) · [offline authorisation](../phase-d/offline-authorization.md) · [deployment automation audit](deployment-automation-audit.md) · [release checklist](../next-phase/release-checklist.md).

## Summary

| | Hosted (schema 001–061) | lucashome (schema 001–079) |
|---|---|---|
| **Old client v1.0.15** | **(a) Works.** Its payloads match hosted; proved on a hosted-schema stand-in (`open_shift` + `complete_sale` → 200, sale `SC-20261013-0001`). Carries two known v1.0.15 defects, now **observed in Electron** (§6): a full load wipes the outbox and the offline auth cache. | **(d) Fails closed for RPCs, NOT for direct table writes.** Every money/stock RPC → `400 22023 IDEMPOTENCY_KEY_REQUIRED`, nothing written; the old outbox marks it `conflict` after one attempt (no loop). All 27 reads work. **Catalogue table writes (`products.update` etc.) succeed.** |
| **New client 1.0.16** | **(c) Fails closed.** Electron build refuses to build against hosted. A forced web build sends `p_idempotency_key` on all 30 mutating RPCs → `404 PGRST202` on hosted for **30/30**; zero rows written; outbox marks the entry `conflict`/`permanent` after one attempt, no retry loop. | **(b) Supported.** Covered by the existing suites (below). |

Local database (e): **Dexie 4.4.5 does not raise `VersionError` on downgrade** — it reopens the newer database. v1.0.15 boots on a 1.0.16 database. The danger is different and worse: on its first online full load v1.0.15 **silently deletes every pending outbox entry** (its own and 1.0.16's) and never sends them. Finding F2 in the canary checklist (VersionError) is **wrong**; its R7 option (a) does not prevent loss (§5, §7).

Upgrade (1.0.15 → 1.0.16): v1 outbox entries survive, get an idempotency key in the Dexie v2 upgrade, and are **replayed against whatever backend 1.0.16 is pinned to** (lucashome). Nothing records which backend an entry was queued for (§5).

Updater (g): latest-only, pre-releases ignored, downgrades blocked; a published **1.0.17 = v1.0.15 code** would auto-install on every 1.0.16 and 1.0.15 till and its first online load would discard any un-synced 1.0.16 sales (§7).

Recommendation (§8): fix forward once real sales begin; before that, rollback to hosted only with the v1.0.15-based build **after** every till's outbox is empty (or exported), never by publishing it blind.

---

## 1. (a) Old client × hosted — today's state

Read from the code plus one stand-in test (no live hosted access):
- v1.0.15 reads `import.meta.env.VITE_SUPABASE_URL` with no validation (`src/lib/supabase.ts` at `v1.0.15`). The published installers point at the hosted project.
- Mutating RPCs are called without a key. Hosted (001–061) has no idempotency ledger, so a lost response + retry can duplicate a sale (the reason Phase D exists; [contract](../phase-d/idempotency-contract.md)).
- **Stand-in proof that hosted accepts the old payloads:** `supabase/postgres:17.6.1.136` + `postgrest/postgrest:v14.17` on `127.0.0.1`, loaded with `~/shwephala-migration/20261011T2347Z/schema.scrubbed.sql` (58 functions, 31 tables, no `idempotency_keys`), plus a 1-shop synthetic tenant. With the exact v1.0.15 payloads, `open_shift` → 200 and `complete_sale` → 200 (receipt `SC-20261013-0001`, stock 100 → 98). (The bare image's `auth.uid()` only reads `request.jwt.claim.sub`; it was redefined to the GoTrue form that also reads `request.jwt.claims`, as on a real project.)
- Offline behaviour of v1.0.15 is unreliable (§6): any full load clears every Dexie table, including the outbox and the auth cache.

## 2. (b) New client × lucashome — existing evidence (not re-run here)

| Suite | Result | Where |
|---|---|---|
| Unit (incl. outbox reliability, idempotent RPC, backend pin) | 744/0 | `npm test`; [canary R2](../next-phase/electron-1.0.16-canary.md#r2-gates-local-on-the-mac-the-repo-has-no-ci-test-workflow) |
| DB harness at max migration 079 | 467/0 | `supabase/tests/phase-d/run.sh` |
| Live suites on lucashome (QA data) | phase-d 16/16, org isolation 12/12, phase-g2 | [live README](../../../supabase/tests/phase-d/live/README.md), [077–079 live verification](upload-security-and-077.md) |
| Electron E2E against lucashome | 25/25, zero hosted requests | [phase-e results](../phase-e/e2e-results.md) |

Not re-run in this session (the phase-d harness and `npm run e2e` were in use by other sessions).

## 3. (c) New client × hosted — fails closed (TESTED, no hosted contact)

**3.1 Electron build refuses.** In the branch worktree:
```
VITE_SUPABASE_URL=https://gzqiukxnzfdouwaotelx.supabase.co VITE_SUPABASE_ANON_KEY=not-a-real-key npm run build:electron
→ exit 1: [build] Backend host mismatch: this build expects "lucashome.tail8a86e4.ts.net"
  (VITE_SUPABASE_EXPECTED_HOST) but VITE_SUPABASE_URL points at "gzqiukxnzfdouwaotelx.supabase.co".
  Refusing to start against an unexpected backend.      (no dist/ written)
```
**The web build is NOT pinned:** `vite build` with the same hosted URL → exit 0, bundle contains the hosted host. So does a build with no env at all (the GitHub Pages CI case; that bundle shows "The app cannot start" at runtime). This is what Vercel would build (Part 2).

**3.2 Every mutating RPC is rejected by hosted's PostgREST.** Against the stand-in of §1, for each of the 30 in-scope RPCs, a body containing all of hosted's own parameter names plus `p_idempotency_key`:

| Result | Count |
|---|---|
| `404 PGRST202` "Could not find the function public.<rpc>(…, p_idempotency_key, …) in the schema cache" | **30/30** |
| Rows written (`pg_stat_user_tables` ins/upd/del and row counts before vs after) | **0** (10/0/0 → 10/0/0; shifts 0, sales 0, movements 0, audit 0, stock 100) |

PostgREST resolves the function by argument names before any SQL runs, so nothing can execute. `app_setup_needed` (067, used by the new login page) is also `PGRST202` on hosted.

**3.3 What the new client does with it** — the real branch code (`callRpc`, `saleSlice`, `outbox`) in a vitest run whose `supabase` module was a `PostgrestClient` pointed at the stand-in:

| Case | Observed |
|---|---|
| Online `open_shift`, exact client args, `retries: 2` | `status 404, code PGRST202, transient false`; **1 request** (no retry) |
| Online checkout (`createSale`) | rejected with `PGRST202`; 0 outbox entries; 0 local sales (no provisional record) |
| Offline-queued sale, then reconnect, `drainOutbox()` ×3 | **1 request** in total; entry `status: conflict, failureKind: permanent, attempts: 1`, `lastError: "Could not find the function public.complete_sale(p_cart_discount_pct, p_created_at, p_idempotency_key, …)"`; local sale kept with `pendingSync: true` |
| Stand-in after all of the above | unchanged (1 shift + 1 sale = only the §1 old-payload contrast) |

Why: `isTransientError` (`src/lib/errors.ts`) treats only status 0/401/408/425/429/5xx, network phrases, `PGRST301` and expired-JWT phrases as transient; 404 is permanent. So a mis-pointed 1.0.16 fails safe: no writes via RPC, no retry storm, but every sale is refused or parked as a conflict. The till is unusable, which is the intended "fail closed".

Residual risk: the new client still performs **direct table writes** for catalogue edits (`tableWrite.ts`); against hosted these would not be blocked by the idempotency mismatch. Only relevant if a hosted-pointed web build of the branch is used (Vercel preview/production; Part 2).

## 4. (d) Old client × lucashome (TESTED, QA tenant)

v1.0.15 code from the tag worktree, signed in as a QA cashier (seed `supabase/tests/phase-d/live/seed.sql`, run stamp `1791859890000`), all calls through its exact payloads.

| Probe | Result |
|---|---|
| The 27 `loadData` reads (26 tables + `business_profile` `.eq("id","default").maybeSingle()`) | **0 errors**; RLS scopes to the QA org (shops 2, users 4, products 3, inventory 3, price_levels 1, business_profile 1 row) |
| Online `open_shift` (v1.0.15 args) | `400`, code `22023`, `IDEMPOTENCY_KEY_REQUIRED` |
| Online `complete_sale` (v1.0.15 args) | `400`, `22023`, `IDEMPOTENCY_KEY_REQUIRED` (gate runs after auth, before validation) |
| v1.0.15 outbox: queued `open_shift` + `adjust_stock`, `drainOutbox()` ×3 | **2 requests total**; both `conflict`, `attempts 1`, `lastError IDEMPOTENCY_KEY_REQUIRED`; no loop (v1.0.15 marks *any* resolved error as conflict) |
| Rows written by the RPCs | **0** (QA shifts 0, sales 0, movements 0, idempotency keys 0, audit 0, stock 100/100/100) |
| **Direct table write**, as v1.0.15's product form does (`products.update`) as QA ADMIN and as QA MANAGER | **200, 1 row updated each** |

So an old client pointed at lucashome cannot sell, but **can change the catalogue** (products, units, prices, barcodes, supplier links, users — the tables v1.0.15 writes directly). That is the realistic hazard of a mis-built rollback or a stray old build against the new backend: half-working, with catalogue edits landing. It also means "v1.0.15 fails against lucashome" in [desktop-app risks](../../desktop-app/risks.md) is true for sales/stock/payments only.

## 5. (e) Local database: upgrade and downgrade (TESTED in Electron)

**Versions.** `shwe-phala-local`: v1.0.15 declares Dexie `version(1)` (IndexedDB version **10**, 31 stores). The branch declares `version(2)` (IndexedDB **20**, adds `syncState`, indexes `syncOutbox.idempotencyKey`; the upgrade stamps a key on every queued RPC entry).

**Method.** Each worktree's own `electron/main.cjs` was started (unpackaged, Electron 43.4.1) through a 4-line wrapper that calls `app.setPath("userData", <scratch dir>)` before requiring it (v1.0.15's main has no `SHWE_POS_E2E_USER_DATA`). The renderer was that worktree's **production bundle** (`ELECTRON_BUILD=true` build against lucashome) served by `vite preview` on `http://localhost:5191`. Both builds used the **same origin and userData**, so they opened the same IndexedDB, exactly as a till does across an auto-update (same `file://` origin). Offline = Playwright aborts every request to the lucashome origin + `navigator.onLine=false` + `offline` event (the e2e suite's method). Driven by Playwright `_electron`; raw IndexedDB read in the page after each step. QA cashier A, QA shop.

| Step | Build | What happened (observed) |
|---|---|---|
| 1 | v1.0.15, online | Login OK, full load OK. IDB version 10. **`authCache` rows after the full load: 0** (wiped by the snapshot replace) |
| 2 | v1.0.15, offline | With `authCache` empty, "Start shift" is refused ("Reconnect to the internet to verify your session…", shown as "Network error"). The test re-created the row `cacheAppUser()` writes at login; then the real v1.0.15 code queued `open_shift` + `complete_sale` (receipt PENDING). Outbox: 2 entries, no idempotency key |
| 3 | v1.0.15, reconnect | `loadData({force:true})` → **0 RPCs sent**; outbox **0**, provisional sale and shift **gone**. The offline sale was **silently discarded** (the `persistSnapshotToLocal` clear-all race, A8 in [02](../02-production-dependencies.md), until now "unknown at runtime") |
| 4 | v1.0.15, offline again | Same as 2 → 2 pending entries; app closed while offline |
| 5 | **1.0.16, boots offline on the same userData (upgrade)** | Boots straight into the app (session + auth cache reused). IDB **20**, 32 stores, `syncState` present. Both v1.0.15 entries **kept and stamped** (`idempotencyKey` set, `p_idempotency_key` in args) |
| 6 | 1.0.16, reconnect | Sent `resolve_event_time`, **`open_shift`, `complete_sale`** → outbox 0, local sale `QA1791859890000-20261013-0001`, shift synced. On lucashome: QA shifts 1, sales 1, stock 100/**99**/100, idempotency keys 2. No duplicate |
| 7 | 1.0.16, offline | New sale queued (PENDING, key set, `seq 1`); app closed offline |
| 8 | **v1.0.15 on the 1.0.16 database (downgrade), offline** | **No VersionError.** Boots into the app; IDB stays 20; the 1.0.16 entry is visible. An offline sale is queued next to it (no key) |
| 9 | v1.0.15 (downgraded), reconnect | **0 RPCs sent**; outbox **0**; both pending sales (the 1.0.16 one with its key and the v1.0.15 one) and their provisional rows **silently deleted**; only the already-synced sale remains |

Hosted requests in all phases: **0**.

**Why no VersionError:** Dexie 4.4.5 `dexie.js` (open path, `case 'VersionError'`): when the installed database is newer, Dexie reopens it without a version and uses the installed schema. The old code then works on the newer database as long as the tables it uses exist (they do).

**Evaluation against the rule** ("a rollback must never silently discard pending transactions or replay them against the wrong backend"):

| Scenario | Discards? | Wrong backend? |
|---|---|---|
| v1.0.15 till reconnects after offline sales (today, hosted) | **Yes** (step 3) | no |
| 1.0.15 → 1.0.16 auto-update with v1.0.15 entries pending (only possible if the update installs while the till is still offline; v1.0.15 wipes its queue on every reconnect) | no | **Yes**: entries queued for hosted are replayed on lucashome with fresh keys. Ids in them (shift, product) were minted on hosted; if they don't exist on lucashome → permanent conflict; if they do (pre-export catalogue) → the sale lands on lucashome |
| 1.0.16 → 1.0.17 (= v1.0.15 code, hosted) with entries pending | **Yes** (step 9) | would also replay against hosted with `p_idempotency_key` → `PGRST202` conflict, but the wipe happens first |
| 1.0.16 → "clear app data" → 1.0.17 | **Yes**, explicitly | no |

**Proposed safeguards** (code changes, not made; each is small):
1. **Backend stamp on every outbox entry** (1.0.16): `backendHost` (from `backendConfig.host`) and `contract: "idem-v1"` at enqueue; the Dexie upgrade stamps legacy entries `backendHost: null`. The drain sends only entries whose stamp equals the running build's host; others become `conflict` with "queued for another backend (X); export or dismiss". Legacy (`null`) entries are held as conflicts for review instead of replayed.
2. **Rollback build = v1.0.15 + two guards, not the bare tag:** (i) A8 fix (clear only snapshot tables, await the persist before draining; one function in `localSync.ts` + the call in `index.ts`); (ii) a boot guard: if `syncOutbox` holds any entry with an `idempotencyKey` or the IDB version is > 10 with a non-empty outbox, skip `loadData` and show a blocking "pending 1.0.16 transactions — do not continue, call the engineer" screen.
3. **Export pending queue** (1.0.16, Sync page): "Export queue" writes the outbox + provisional sales/shifts as JSON through the main process (`dialog.showSaveDialog`), so a till can be rolled back or wiped without losing evidence of un-synced sales.
4. **Version gate in the rollback procedure** (no code): the owner checks Sync page "0 pending, 0 conflicts" on every till before 1.0.17 is published; tills that cannot be checked stay on 1.0.16.

## 6. Two v1.0.15 defects observed live (relevant to any v1.0.15-based rollback)

- **Outbox wiped on reconnect / any online full load** (step 3, 9). `persistSnapshotToLocal` clears every Dexie table and is not awaited before `drainOutbox()`; the drain then finds nothing. Fixed on the branch ([G9 evidence](../evidence/G9/2026-10-12-phase-d.md), A8).
- **Offline writes refused after the first full load** (step 1–2): the same clear wipes `authCache`, so `assertOfflineWriteEligible` sees no cached user. On v1.0.15 offline selling therefore works only between a boot/login and the first completed load — in practice almost never. Fixed on the branch (auth cache is device-local, never cleared).

A rollback to the bare v1.0.15 code reintroduces both.

## 7. (f) Pending offline transactions during rollback, (g) automatic updater

**(g) electron-updater 6.8.9, verified in `node_modules/electron-updater/out`:**
- `AppUpdater.js`: `allowPrerelease = false` and `allowDowngrade = false` by default; `allowPrerelease` becomes true only when the running version has a prerelease component (line 218); setting `channel` forces `allowDowngrade = true` (line 44).
- `isUpdateAvailable` (lines 339–362): equal → no; newer → yes; older → only if `allowDowngrade`. It also honours `isUserWithinRollout` (a `stagingPercentage` in `latest.yml`), an option for a staged rollout.
- `providers/GitHubProvider.js`: with `allowPrerelease` false it reads `github.com/<owner>/<repo>/releases/latest`, which never returns a pre-release or draft.
- `electron/main.cjs` (both versions): sets only `autoDownload`, `autoInstallOnAppQuit`, `autoRunAppAfterInstall`, `disableWebInstaller`; checks 5 s after start and every 4 h, packaged builds only. Never sets `allowPrerelease`, `allowDowngrade`, `channel`.
- Live state: `releases/latest` = **v1.0.15** (12 assets, 2026-08-26).

**What a published "1.0.17 = v1.0.15 code (hosted)" release does:**

| Till on | Published as full release | Published as pre-release |
|---|---|---|
| 1.0.16 | Downloads, installs on quit. Next start: v1.0.15 code on the 1.0.16 database (opens, §5). Login needed (hosted session key differs). **First online load deletes every pending 1.0.16 entry** without sending it. Then works against hosted. Catalogue/sales recorded on lucashome since go-live are **absent** on hosted | Nothing (latest stays as is) |
| 1.0.15 | Updates to an identical build; harmless | Nothing |
| 1.0.17 later superseded | only by ≥ 1.0.18; re-publishing 1.0.16 never rolls a till back | — |

**(f) Rule for pending offline transactions:** a till may move between backends only with **Sync page 0 pending / 0 conflicts** (or after "Export queue", safeguard 3). The updater cannot enforce this; publishing 1.0.17 as a full release hands control to each till's next restart. So: publish only after the owner has confirmed every till's queue, or install 1.0.17 by hand per till.

## 8. Recommended strategy

**Before the first real sale on lucashome (canary + validation window) — tier A, hosted is a valid fallback for the old client only:**
1. Stop selling on the 1.0.16 till(s). On each: Sync page → wait for 0 pending; resolve or export conflicts. A till that cannot reach lucashome stays on 1.0.16 until it can.
2. Record the canary sales from lucashome (receipts, `sales`/`sale_items`) for re-keying.
3. Install the **rollback build** (v1.0.15 + the two guards of §5.2, version **1.0.17**, hosted URL, tested over 1.0.16 on the P-h machine) by hand on those tills — or publish it as a full release only once step 1 is confirmed for **every** till that ever ran 1.0.16.
4. Local DB: no "clear app data" is needed for the database to open (Dexie 4). Clear it anyway on the canary till (`%APPDATA%\retails-shop`) **after** step 1 and after exporting the queue, so no lucashome-era snapshot rows or `syncState` linger. Everyone signs in again (different session key).
5. Re-key the canary sales on hosted by hand (hosted write, owner approval). Freeze lucashome (no writes; keep it running for comparison).
6. Do not use the bare `v1.0.15` tag as the rollback build: it discards offline sales on reconnect (§6).

**After the first real sale: forward-fix only.** Hosted lacks 062–079 (idempotency ledger, org isolation, upload paths) and has no copy of anything written since; tier B in [08 §4](../08-cutover-rollback.md) is obsolete (canary F3). "Switch back to hosted" is not an option.

### EMERGENCY procedure — lucashome fails after go-live

Decision: owner. Execution: engineer. Log every step with time in `evidence/G13/cutover-log.md`.

1. **Keep selling offline on 1.0.16 (0–12 h).** Tills keep working offline-first: sales, refunds requests, shift open/close queue locally for **12 h from the till's last successful server contact** ([offline authorisation](../phase-d/offline-authorization.md)); read-only after that up to 24 h. Tell staff: do not sign out, do not restart Windows unless needed, do not clear app data, do not install anything. Do **not** publish any release.
2. **Diagnose (≤ 30 min):** `tailscale status` / `ping lucashome`, `backup-status.sh`, `docker compose ps`; disk/power/WAN at the house. Most outages (WAN, power, a container) end here: restore service, tills drain on their own (idempotent, no duplicates).
3. **If the database is damaged but the host lives:** stop app writes, restore from local backup — PITR from base backup + WAL to just before the fault ([backup README](../../../deploy/lucashome/backup/README.md), [WAL-ARCHIVING](../../../deploy/lucashome/backup/WAL-ARCHIVING.md)). Same hostname, same JWT secret: tills reconnect and replay their queues; idempotency keys make replays of already-restored operations return the stored result instead of applying twice (only keys inside the restored range; operations after the restore point execute fresh — which is the desired outcome).
4. **If the host is lost:** stand up a replacement host from the offsite copy ([OFFSITE-ENABLE §8.2](../../../deploy/lucashome/backup/OFFSITE-ENABLE.md); [offsite proposal](../next-phase/offsite-backup-enable.md)) with the **same Tailscale hostname** (`lucashome`; retire the old node first so MagicDNS hands the name over), the same TLS name, and the same JWT secret/anon key from the secrets bundle, so the pinned 1.0.16 builds reconnect without a new release. Verify row counts against the last `counts.json`, then let one till drain first.
5. **If tills approach the 12 h window before service returns:** the owner decides to close the shops or to continue on paper; do not extend the window by editing tills.
6. **Never:** switch tills to hosted, publish a v1.0.15-based build, or clear a till's app data while it has pending entries.
7. Afterwards: compare duplicate-sale and stuck-outbox queries ([09](../09-monitoring-alerting.md)), close the incident in `docs/lucashome-selfhost/incidents.md`.

Prerequisites this procedure depends on, all still open: offsite backups + one restore from R2 (P-d), healthchecks alerts (P-e), the secrets bundle with JWT secret/anon key offsite.

## 9. Test data and cleanup

| Item | Value |
|---|---|
| QA tenant | stamp `1791859890000`: 1 org, 2 shops, 4 users, 3 products, 1 supplier; 4 auth users via GoTrue signup; seeded with `seed.sql` |
| Created by tests | 1 shift + 1 sale + 1 movement + 2 idempotency keys (step 6), 2 product name edits (§4), audit rows |
| Cleanup | `cleanup.sql` (one transaction) → GoTrue audit purge (14 `auth.audit_log_entries` with `@qa.invalid`) → `verify_clean.sql` = **CLEAN** |
| Real data after | orgs **1**, products **539**, inventory **18**, users **3**, auth users **10**, storage objects **574** (files on disk 575, unchanged); max migration 079 |
| Stand-in | containers `relcompat-db`/`relcompat-rest` and network removed |
| Worktrees | both removed (`git worktree list` shows the main checkout only) |
