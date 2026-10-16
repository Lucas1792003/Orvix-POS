# Shwe Pha Lar POS 1.0.16: release candidate

Status: **release candidate, built and tested locally, 2026-10-16 (UTC).** Not published, not installed on any till, not pushed. Hosted Supabase was not contacted. `lucashome` was inspected read-only once (Envoy header rules, see §1). No live test ran against it.

Related: [electron-compatibility.md](../selfhost-migration/phase-f/electron-compatibility.md) · [release-checklist.md](../selfhost-migration/next-phase/release-checklist.md) · [electron-1.0.16-canary.md](../selfhost-migration/next-phase/electron-1.0.16-canary.md) · [queue-export.md](../selfhost-migration/phase-f/queue-export.md) · [g5-followups.md](../selfhost-migration/phase-f/g5-followups.md).

## 0. What is in 1.0.16

| Area | Change | Where |
|---|---|---|
| Backend | Self-hosted backend only (`lucashome.tail8a86e4.ts.net`). Pinned at build time and at startup | `build:electron`, `src/lib/backendConfig.ts` |
| Earlier client fixes | Idempotency keys on all mutating RPCs. Staff created by `staff-admin` (no `auth.signUp`). Phone page on the API origin. Fresh upload token just in time. Upload poll survives errors. Barcode-preserving save. Confirm before cancelling the QR modal | phase F/G docs |
| Uploads | Desktop and logo images go **only** through the validated session flow (no direct Storage writes). Needs nothing from 084. A server without the flow gets a clear error | §2 |
| Identification | Version, backend, capabilities and till id on the login page and sidebar. `X-Client-Info` header on every API request | §1 |
| **Blocker D-d** | Outbox entries record their backend. Entries for another backend, or with no record (v1.0.15), are **quarantined** | §4 |
| Updater | Never installs while sales are unsynced or a sale is in progress | §3 |

No migration. No new server function. Dexie stays at schema version 2. New fields are stored on existing rows, with no index change.

## 1. Version and identification

- `package.json` = **1.0.16**. Vite inlines it as `__APP_VERSION__` (`src/lib/clientInfo.ts`).
- On screen:
  - Login page: `Backend: lucashome…`, then `v1.0.16 · validated uploads: yes · backend-tagged queue: yes · update guard: yes`, then the till id (`till-xxxxxxxxxx`).
  - Sidebar: the same three lines.
  - Sidebar update control: `v1.0.16` from `app.getVersion()`.
  - There is no separate About page in the app.
  - The till id appears **on screen only**. It is never put in a request or header.
- Machine-readable header on every supabase-js request (REST, RPC, auth, storage, functions) and on the raw upload-status poll:
  `X-Client-Info: shwephala-pos/1.0.16 (validated-uploads; idem-v1; outbox-origin-v1; update-guard-v1)`
  - The header replaces supabase-js's default `supabase-js-web/…`. It is set with the exact key `X-Client-Info`, so there is a single value (tested).
  - `deploy/lucashome/verify-till-readiness.sh` parses it with `^shwephala-pos/(\d+\.\d+\.\d+)(?:\s*\(([^)]*)\))?` and `"validated-uploads" in caps`. The format matches.
  - The Electron user agent stays `… retails-shop/1.0.16 Chrome/… Electron/43.4.1 …` (seen in the packaged smoke).
  - Keep both formats stable.
- Pass-through on the gateway, read-only check of `lucashome` `volumes/api/envoy/lds.template.yaml`:
  - CORS `allow_headers: "*"` (×2).
  - The only `request_headers_to_remove` is `authorization` on one route.
  - Every function's CORS list already names `x-client-info`.
  - Nothing logs the header today. It becomes visible when the access-log field prepared by the till-readiness work is applied.
- `updater.log` gets a line on every start: `app start version=1.0.16 packaged=true platform=…`.
- Stale local builds that also said 1.0.15 (`release/` of the main checkout, 2026-10-12/13) were moved unchanged to `/Users/waiyan/Projects/personal/ShwePhaLa-stale-builds/2026-10-16-pre-1.0.16-release/release/`, outside the repo tree.

## 2. Validated uploads only

- `src/lib/validatedUpload.release.test.ts` scans every non-test file under `src/` and finds:
  - no `storage.from(…).upload/update/move/copy`;
  - no `createSignedUploadUrl`;
  - exactly one `uploadToSignedUrl`, the signed PUT for a token from `phone-upload-token`;
  - `ProductImageInput` uses `uploadProductImage` (product images and the `brand` logo).
- At schema 085 without 084 the flow uses only:
  - `create_product_image_upload_session`;
  - `phone-upload-token` (token, then `action:"complete"`, which needs 083);
  - the signed PUT.

  084 only removes the staff INSERT/UPDATE policies, which this build never uses.
- **When the server lacks the flow**, the user sees `ValidatedUploadUnavailableError`: "This server does not support validated image uploads (…). The image was not saved and nothing was written." The session is cancelled. This covers:
  - a hosted 404 `{code:"NOT_FOUND"}`;
  - a self-hosted 500 "worker boot error";
  - a pre-083 function that answers the complete call with a token;
  - a session RPC that returns PGRST202.

  The function's own 404 still reads "Invalid upload link".

## 3. Updater guard

Code: `electron/updateGuard.cjs` (decision, pure) and `electron/updater.cjs` (wiring). The renderer side is `src/lib/updateGuardBridge.ts` and `src/stores/saleActivityStore.ts`.

**The renderer reports** on every change and every 30 s:
- `unsynced`: every outbox row, any status (pending, syncing, failed, conflict, quarantined);
- `online`;
- `authenticated`: a signed-in app user and no "sign in again" flag;
- `saleInProgress`: the cart has lines, payment is open, or checkout is in flight;
- `exportCoversQueue`: every current row was exported in this session.

A missing report, or one older than 2 min, counts as unsafe.

**Settings:**
- `autoInstallOnAppQuit = false`, so electron-updater never installs by itself;
- `allowPrerelease = false`, `allowDowngrade = false`, no `channel`;
- `autoDownload` stays on (downloading is harmless).

| Path | Installs only when |
|---|---|
| "Restart now" (update-downloaded dialog), sidebar Restart | queue empty, online, signed in, no sale in progress |
| Quitting the app (Windows) | same; done by `before-quit`, silent, like electron-updater's own install-on-quit. Otherwise the quit proceeds and the update waits. On macOS the app never installs on quit (unsigned; Squirrel would hold the quit) |
| Owner recovery: "Install anyway (after export)" | no sale in progress, **and** every unsynced row was exported in this session, **and** (RC2) the main process verified the signed-in user as the owner (ADMIN) with the backend (§9, D4), **and** the owner confirms a native dialog in the main process. Offline is allowed only for an owner session main verified online earlier (§9). Rows stay on the till and drain after the update |

**What staff see** when the guard refuses:
- The dialog "Update waiting". Its detail reads, for example: "3 sales/actions waiting to sync — update will install after they sync." Buttons: OK, **Export pending…** (opens the existing queue export), **Sync now** (runs a drain).
- The sidebar button shows **Waiting**. Clicking it shows the same text with Export pending / Sync now, and, for the owner only (RC2), Install anyway (after export).
- During a sale there is no dialog at all, only the status.

When the queue drains, the button turns back into **Restart**. The next restart, or a quit on Windows, installs the update.

**Tests:**
- `src/lib/updateGuard.test.ts`, 15 tests, pure plus wiring with a fake updater:
  - no install with pending entries on the dialog, button or quit path;
  - no report or a stale report blocks;
  - mid-sale blocks, even on the recovery path;
  - a drained queue installs on quit `(true,false)`, once;
  - recovery is refused before export, Cancel installs nothing, confirm installs;
  - macOS never installs on quit;
  - reports from a foreign sender are ignored.
- `src/lib/updateGuard.electron.test.ts`, 3 tests: a **real Electron 43** process running the real `updater.cjs` and `preload.cjs` with a fake updater (`electron/test/updater-guard.main.cjs`, excluded from the package):
  - 3 pending → no `quitAndInstall`, the notice is shown, the quit proceeds;
  - mid-sale → nothing, and no dialog;
  - clear → silent install on quit.

**Limit:** the guard exists only from 1.0.16 on. The **1.0.15 updater has no guard** (§4.3).

## 4. Upgrade from 1.0.15 (blocker D-d)

### 4.1 What a 1.0.15 till leaves behind

Same app id, same `file://` origin and the same userData (`%APPDATA%\retails-shop`). 1.0.16 therefore opens the same IndexedDB and localStorage.

| Local data | v1.0.15 content | What 1.0.16 would do without the fix |
|---|---|---|
| Outbox (`syncOutbox`) | entries for **hosted**, no backend recorded, no keys | the Dexie v2 upgrade stamps keys, then the drain **replays them against lucashome** (release-compat §5 step 5–6, observed) |
| Snapshot tables + delta cursors | hosted catalogue / sales | shown at boot from cache, then replaced by the first full load |
| `authCache` | hosted auth ids | used only together with a session |
| Session | `sb-gzqiukxnzfdouwaotelx-auth-token` in localStorage | not read: 1.0.16's key is `sb-lucashome-auth-token`. The till already had to sign in again. The stale hosted token was left behind |

In practice v1.0.15 wipes its own outbox on every online full load (A8). Entries survive into 1.0.16 only if the update installs while the till still holds offline sales, for example: downloaded earlier, offline sales, then a quit.

### 4.2 What 1.0.16 does now (`src/lib/backendOrigin.ts`, run in `main.tsx` before supabase-js exists)

1. Every new outbox entry is stamped with `backendOrigin` (`https://lucashome.tail8a86e4.ts.net`).
2. **Quarantine:** at startup, and again at the start of every drain pass and right before each send, any entry whose origin is missing or different gets `status: "quarantined"`, with `statusBeforeQuarantine`, `quarantinedAt` and `quarantineReason`.
   - It is never sent and never retried: `retryOutboxEntry` throws "queued for another server".
   - It is never deleted, automatically or by staff. RC1's Dismiss is gone: since RC2 the owner can only **set it aside** after exporting it in this session (row kept, still exported; §9 D1).
   - Its provisional rows are not merged into new loads.
3. If the profile's recorded origin (`syncState` key `backend-origin`) differs, or was never recorded (every pre-1.0.16 profile):
   - the snapshot tables and `syncMeta` are cleared, so the catalogue is fetched fresh from the new backend and no hosted data is ever rendered;
   - `authCache`, `needs-reauth` and `drain-lease` are cleared;
   - **every** stored `sb-*-auth-token` is removed, so the user must sign in again.

   The outbox, the provisional id map and the till id are kept. The new origin is written last.
4. On every boot, auth tokens of foreign backends are removed.
5. UI:
   - A red banner in the app: "N transactions were recorded on this till by an older app version for a different server. They will NOT be sent from here. Export them and give the file to the owner; nothing has been deleted." It has an Export button.
   - The same notice on the login page.
   - The Sync page badge "Other server: not sent, export for the owner".
   - The updater counts quarantined rows as unsynced.
6. Export: the `.spqx` entries carry `status: "quarantined"`, `backendOrigin` (null = v1.0.15) and `quarantineReason`. These are optional fields, so older files still read.
7. Reconciliation, by the owner, with `tools/queue-recovery`:
   - `inspect` shows them;
   - `replay` skips them as `skipped-quarantined` (exit 4);
   - replaying them needs `--include-quarantined --confirm-host <target host>`.

   Hosted itself is refused by the tool (and by the idempotency contract: hosted is at 061). So the choice is to replay them into **lucashome** deliberately, if the sale belongs there, or to re-key them by hand.

**Tests:**
- `src/lib/backendOrigin.upgrade.test.ts`, 6 tests. It builds a real v1.0.15 Dexie version-1 profile: 2 untagged pending entries, a hosted product/sale/cursors, an `authCache` row, a hosted session plus `pos-till-id`. It opens the profile with 1.0.16 code and checks:
  - quarantine 2/2, kept;
  - snapshot, cursors and `authCache` empty, and `readLocalSnapshot()` returns null (fresh catalogue load);
  - the hosted token is removed, the till id is kept;
  - real supabase-js `getSession()` returns null with **zero fetches** (re-login);
  - `drainOutbox` makes **zero rpc / fetch calls** for them;
  - the export plus decrypt round trip contains both;
  - a second boot keeps the new catalogue and drains only the 1.0.16 entry;
  - a foreign-origin entry is quarantined too.
- Outbox tests: tagging, foreign entries are never sent, retry is refused.
- Recovery tool: quarantined entries are skipped by default.
- Packaged app: §6.

### 4.3 Operational rule (the 1.0.15 updater has no guard)

A 1.0.15 till installs 1.0.16 on its next quit after the download, whatever its queue holds. 1.0.16 then quarantines that queue. Nothing is lost, but sales the owner believes are on hosted would be stuck on the till. So:

1. **Before 1.0.16 is published as *latest*** (pre-release is safe: 1.0.15 tills ignore it), on **every** 1.0.15 till:
   - online, signed in, open the Sync page;
   - wait for **0 pending / 0 conflicts**;
   - then close the app.

   A till that cannot be confirmed: export its queue (1.0.15 has no export; use the cold copy of `%APPDATA%\retails-shop`, emergency runbook §4.3), or update it by hand later.
2. Do not run 1.0.15 for selling between that check and promotion.
3. After the first start on 1.0.16, staff sign in again on the new backend. A red banner means quarantined rows: export them and hand the file to the owner.
4. **Hosted-era delta.** The data migration was exported from hosted on **2026-10-11 23:47 UTC** (manifest `~/shwephala-migration/20261011T2347Z/manifest-hosted.json`). Anything written on hosted after that is **not** on lucashome. The owner checks this once, read-only, in the hosted dashboard's SQL editor. That is the owner's action; no code here contacts hosted.

   ```sql
   select 'sales' t, count(*) from public.sales where created_at > '2026-10-11 23:47Z'
   union all select 'shifts', count(*) from public.shifts where coalesce(ended_at, started_at) > '2026-10-11 23:47Z'
   union all select 'refund_void_requests', count(*) from public.refund_void_requests where created_at > '2026-10-11 23:47Z'
   union all select 'inventory_movements', count(*) from public.inventory_movements where created_at > '2026-10-11 23:47Z'
   union all select 'products changed', count(*) from public.products where greatest(created_at, updated_at) > '2026-10-11 23:47Z'
   union all select 'audit_logs', count(*) from public.audit_logs where created_at > '2026-10-11 23:47Z'
   union all select 'users', count(*) from public.users where created_at > '2026-10-11 23:47Z'
   union all select 'auth.users', count(*) from auth.users where created_at > '2026-10-11 23:47Z'
   union all select 'storage.objects', count(*) from storage.objects where greatest(created_at, updated_at) > '2026-10-11 23:47Z';
   ```

   The export baseline was: sales 0, shifts 0, refunds 0, movements 5 (last 2026-06-10), products 539 (last created 2026-08-17), audit_logs 81, users 3, auth.users 10, storage.objects 574.
   - If every row above is 0, no delta migration is needed.
   - If anything is > 0, a **delta migration** is needed before promotion. Use a fresh read-only export of exactly those rows, then a reviewed restore into lucashome (same procedure as 08 T+0:05, owner approval).

   Column names follow the hosted 061 schema. If one is missing there, drop that line.

## 5. Downgrade / rollback

- electron-updater never downgrades: `allowDowngrade = false`, set explicitly and the default. Publishing an older build, or re-marking 1.0.15 as latest, does **nothing** on a 1.0.16 till.
- **Never put v1.0.15 on a till that ran 1.0.16** with pending data. Dexie 4 opens the newer database, and v1.0.15's first online load deletes every pending entry (release-compat §5 step 9). It also writes to hosted, which lacks 062+.
- Recovery path for a till that must go back:
  1. On 1.0.16, sync to **0 pending**. If that is impossible, use **Export pending** and keep the file and its passphrase. Also export quarantined rows.
  2. Close the app. Copy `%APPDATA%\retails-shop` aside (cold copy).
  3. Uninstall, or clear app data, **only after** steps 1–2.
  4. Install a **fix-forward** build by hand (e.g. 1.0.17 = 1.0.16 with the offending change reverted), pinned to the **self-hosted** backend like 1.0.16. **Owner rule (2026-10-13): a till is never redirected to hosted Supabase**, so no rollback build may contain v1.0.15's hosted pin; the earlier "1.0.17 = v1.0.15 code" idea (canary R7) is withdrawn (coordinator correction 2026-10-16).
  5. The owner reconciles the export with `tools/queue-recovery` (`inspect`; replay only to an explicitly named target).
- After the first real sale on lucashome the rule is **fix forward only** (release-compat §8).

## 6. Artifacts (local, unsigned, NOT published)

Built from this worktree's commit with:
- `VITE_SUPABASE_URL=https://lucashome.tail8a86e4.ts.net`
- a **placeholder** anon key (`placeholder-anon-key-local-rc`, so this build cannot sign in)
- `npm run build:electron`, then `npx electron-builder --mac --arm64 --publish never` and `npx electron-builder --win --x64 --publish never`, run with `GH_TOKEN` and `GITHUB_TOKEN` unset

The Windows NSIS build works on macOS here; signtool is a no-op without a certificate. **The coordinator builds the real artifact with the real anon key.** These hashes identify only this test build.

| File | sha256 |
|---|---|
| `release/Shwe-Pha-La-POS-Setup-1.0.16.exe` (110 620 757 B) | `b1ccf79e6ec3845904962a47ca6db033df51442be2d88782a75e939d1734da66` |
| `release/Shwe-Pha-La-POS-1.0.16-arm64.dmg` (130 151 653 B) | `a96361a7f89eef3f1db0d22d2b7a984345da80c70508d014a88de43c03a767e0` |
| `release/Shwe-Pha-La-POS-1.0.16-arm64.zip` (130 284 894 B) | `8e2ed575096d98693da111698970ad35c7e4f92f65b1a9a104ddbaae5e7571e1` |

`latest.yml` / `latest-mac.yml`: `version: 1.0.16`. `app-update.yml`: github `Lucas1792003/ShwePhaLa`, no channel.

**Bundle checks**, the same in the dist and both extracted `app.asar`:

| Check | Result |
|---|---|
| Asset paths | `./assets/` |
| `"1.0.16"` | present; 0 × `1.0.15` |
| Backend host | ×6; https URL ×4; 0 `http://lucashome` |
| Hosted project ref | 0. The only `supabase.co` text is supabase-js's `*.supabase.co` allow-list |
| `.auth.signUp(` | 0 |
| `service_role` | 0 |
| JWTs | 0 |
| `X-Client-Info` with `shwephala-pos` and the capability list | present |
| `phone-upload-page` | present |
| `electron/updater.cjs` | `autoInstallOnAppQuit = false`, `allowPrerelease = false`, `allowDowngrade = false`, no channel |
| `electron/test/` | not packaged |

**Packaged smoke**, macOS arm64 binary through Playwright `_electron`, isolated `SHWE_POS_E2E_USER_DATA`, **every renderer request aborted** (unreachable backend; nothing reached lucashome or hosted), closed before the 5 s update check:
- Login rendered with `Backend: lucashome.tail8a86e4.ts.net`, `v1.0.16 · validated uploads: yes · …`, and the till id.
- `appVersion()` = 1.0.16.
- The guard IPC is present. `installUpdate()` with nothing downloaded returns `{ok:false}`.
- The one API request (`app_setup_needed`) carried the exact `X-Client-Info`.
- 0 `*.supabase.co` requests.
- `updater.log` shows `app start version=1.0.16`.

**Smoke 2:**
- A v1.0.15-style untagged pending entry was written into the packaged app's IndexedDB, and the app was restarted.
- The login page shows the quarantine notice. The row is `quarantined` (was `pending`, origin null). 0 requests for it.

Windows installer and real-till behaviour (install over 1.0.15, SmartScreen, `--updated` keeps userData) remain canary items R6/F5.

## 7. Test results (2026-10-16)

| Suite | Result |
|---|---|
| `npx tsc -b`, `npx tsc -p e2e/tsconfig.json`, `npx tsc -p tools/queue-recovery/tsconfig.json` | clean |
| `npx vitest run --exclude '.claude/**'` | **1010 passed**, 66 skipped (baseline 972 + 38: clientInfo 3, backendOrigin upgrade 6, outbox 3, validated upload 7, update guard 15, Electron guard 3, replay 1) |
| Deno functions `supabase/tests/functions/run.sh` | **94 passed**, 0 failed (unchanged) |
| eslint on every changed file | clean (pre-existing errors elsewhere untouched) |

## 8. Owner actions before promotion

1. Run the hosted delta check (§4.3 step 4). Decide on a delta migration if anything is > 0.
2. Confirm every 1.0.15 till is at 0 pending and closed before 1.0.16 becomes *latest* (§4.3).
3. The coordinator builds the real artifact (real anon key), records the hashes, and runs the live regression.
4. Canary F5 on real devices: the version / backend / till id lines; an offline sale, then the updater notice (a local 1.0.17 test installer stays "Waiting" until synced); Export pending; zero `*.supabase.co`.
5. Decide whether to pre-build a 1.0.17 fix-forward build (self-hosted pin; §5) before the first real sale.

## 7. Release candidate RC1 (coordinator, 2026-10-16 09:44 UTC) — built, NOT published
Built from commit `b777345` (clean tree) with the real anon key and the self-hosted origin; `npx electron-builder --mac --arm64 --win --x64 --publish never` into `release/rc-1.0.16/` (git-ignored). Unsigned.

| Artifact | sha256 |
|---|---|
| `Shwe-Pha-La-POS-Setup-1.0.16.exe` | `b72bf9c38f0d1e922f38fd281c2ffac1fcc0d448d9bf93603a8c8e2c2e17f734` |
| `Shwe-Pha-La-POS-1.0.16-arm64.dmg` | `447d710969d34256987924159229dda32f76f5229989dba97c6c5017d8bf901c` |
| `Shwe-Pha-La-POS-1.0.16-x64.dmg` | `2c3bc7e9af33d719a3a8e1340f90796ae6062247744dfb33d47acff50ce1b659` |
| `Shwe-Pha-La-POS-1.0.16-arm64.zip` | `fe8cbe32ab55232a211e8232469bf1644346cfb48cc14111b7d9f31f69c6add3` |
| `Shwe-Pha-La-POS-1.0.16-x64.zip` | `bf43e31a5be78824b4102181171ed0e0a542e6bf6cf53cc8134dcd39ec0027ab` |

`latest.yml` / `latest-mac.yml`: version 1.0.16. Bundle: only the self-hosted origin (4 refs), 0 hosted refs, 0 `signUp` refs, 0 service-key matches, `X-Client-Info` + `shwephala-pos` + `validated-uploads` present, version string 1.0.16.

Final regression on RC1 (same commit): tsc clean; vitest 1010; Deno 94; harness 747/0 (capped 083: 672/0); isolation audit modelling production (083+085, 084 skipped) 454/0/2 low with **schema parity PASS**; live suites phase-f-staff 9/9, phase-g4 15+1 skip, phase-d 16/16, org-isolation 12/12, g2 4/4, g3 9/9; e2e **49 passed, 1 skipped** (084-only); cleanup CLEAN; 574/574 images; production fingerprint identical before/after. Till readiness for 084: **NO-GO** (expected: no till on 1.0.16 yet, 3.1 h of gateway log, no register).

## 8. RC1 frozen (2026-10-16)
Read-only copy (files 0444, folder 0555) at `/Users/waiyan/Projects/personal/ShwePhaLa-artifacts/rc1-1.0.16-b777345/` with `SHA256SUMS` (13 entries incl. blockmaps, both update manifests and `FROZEN.txt`); `shasum -a 256 -c SHA256SUMS` → 13 OK; the five installer hashes equal §7. Rule: RC1 is never rebuilt or replaced; any rebuild is **RC2** in its own folder with its own hashes. `release/rc-1.0.16/` in the checkout is a working copy only — install from the frozen folder.

## 9. Release candidate RC2 (developer, 2026-10-16) — code only, NOT built

Same version **1.0.16**; the RC2 build is identified by its artifact folder (`ShwePhaLa-artifacts/rc2-1.0.16-<commit>/`, built by the coordinator after the full regression, never over RC1) and, optionally, by a build label: `VITE_BUILD_LABEL=rc2` at build time shows `v1.0.16 rc2` on the login page, sidebar footer and update button (default empty; not part of the version or of `X-Client-Info`; `src/lib/clientInfo.ts` `BUILD_LABEL`). RC1 (`b777345`, frozen folder) is unchanged.

Fixes the four RC1 audit defects (`docs/desktop-app/risks.md`, "Found 2026-10-16"):

| | RC1 | RC2 |
|---|---|---|
| **D1** Dismiss | one click, any status, hard `delete` of the outbox row (`dismissOutboxEntry`); misleading toast | **Removed.** "Set aside" (`setAsideOutboxEntry`, `src/stores/data/outbox.ts`): owner (ADMIN) only, only for an entry exported in this app session, after a confirmation dialog naming the entry (action, shop, queued time, status, attempts, key prefix). The row is kept with payload, idempotency key and `seq`; status `archived` + `statusBeforeArchive`/`archivedAt`/`archivedBy`/`archiveReason`. Never sent, not re-quarantined, **included in every export**, still counted by the updater guard (`unsynced`), listed under "Set aside" with **Restore** (owner; a former `syncing` row returns as `pending`, a former quarantined one stays quarantined). One action at a time for the whole list (all buttons disabled during an action/refresh + single-flight guard), so a double click cannot act on the row that moved up. No UI path deletes an unsynced entry; no `dismiss/delete/remove` function exists in the outbox API (test). Permanent removal does not exist in the app: the owner reconciles from the export file; `tools/queue-recovery` reports set-aside entries as `skipped-set-aside` unless `--include-set-aside` (then judged by their former status) |
| **D2** stuck `syncing` | a row left `syncing` (quit/crash mid-request) was never drained and blocked every normal install | `recoverStrandedSyncing` runs at the start of every drain pass under the drain lock: the first pass of an app instance returns **every** `syncing` row to `pending`, later passes (loop resuming after an error/offline/backoff) those older than `SYNCING_STALE_MS` (2 x RPC timeout + 2 min; rows without `syncingSince` count as old). Same payload and idempotency key, `attempts + 1`. The server's idempotency ledger (074, bound to the org) answers the resend with the original result: proven by a test where the server commits and the reply never arrives, the app "restarts" (fresh module state) and resends: **2 calls, same key, 1 sale**. The guard counts such rows as pending; after recovery they sync and a normal install is allowed |
| **D3** id-map prune | mappings > 7 days deleted on every drain pass, also those a quarantined entry needs → export replay `blocked-unresolved-ref` | `pruneProvisionalIdMap` (one transaction over outbox + map) never deletes a mapping referenced by any remaining outbox row, any status (pending, syncing, failed, conflict, quarantined, set aside): its `refs` (the replay's own resolution) plus any string in its payload. Historical-queue test (1.0.15 quarantined rows, conflict, failed, set aside, all 9-20 days old): after two drain passes only the unreferenced old mapping is gone; export → decrypt → replay dry-run with every include flag: 5 planned, **0 blocked-unresolved-ref** |
| **D4** override not owner-only | `evaluateInstallGuard(…, {recovery:true})` needed no owner; any user could "Install anyway" | The recovery guard needs `ownerVerified`, decided by the **main process**: `electron/ownerVerify.cjs` calls `POST <backend>/rest/v1/rpc/app_role` (migration 003, active user behind `auth.uid()`) with the session's access token, using the backend origin + anon key from `dist/backend.json` (emitted by the Electron Vite build from the pinned config, never taken from the renderer). Only `ADMIN` passes. Server unreachable: passes only for the exact token main itself verified online as ADMIN within 12 h (the bridge primes this while the owner is signed in and online); 401/403/another role clears it. Checked before the native confirmation and again after it; IPC from anything but the app window is refused; no verifier / no `backend.json` = refused (fail closed). The renderer shows "Install anyway (after export)" only to ADMIN. Export-in-this-session is still required; nothing is discarded or marked synced; every check is logged (`recovery owner check step=… result=… source=…`, never the token) |

Behaviour notes:
- Export format stays **v1** (additive fields `archivedAt`, `archivedBy`, `archiveReason`, `statusBeforeArchive`, status value `archived`). Old files (3c00aeb, RC1 golden) still decrypt and replay (`audit/rc1/export-format-stability.audit.test.ts`). A file **with set-aside entries** must be read with the RC2 recovery tool (an RC1 tool rejects the `archived` status as `bad-format`).
- No server change, no migration, no Dexie schema version change (`status` is already indexed; new fields are unindexed).
- Owner recovery offline: works only if the owner was signed in and verified by main while the server was reachable in this app session (same token). Otherwise "Install anyway" is refused with "The server could not confirm that you are the owner…": wait, or sign in again once the server answers.

Tests (developer run, 2026-10-16, no live runs): `npx tsc -b` clean; `npx tsc -p e2e/tsconfig.json` clean; vitest **1040 passed** (baseline 1018 = 1010 + 8 audit; +22: `src/stores/data/outbox.rc2.test.ts` 12, `src/lib/updateGuard.test.ts` +10 (D4 guard/updater/ownerVerify), `tools/queue-recovery/replay.test.ts` +1; the 5 audit FINDING tests now assert the fixed behaviour; RC1 `dismiss` test in `outbox.test.ts` now covers set aside + restore); Deno functions 94/94; SQL harness not affected (no `supabase/` change).
E2E prepared, not run: `e2e/h-set-aside.e2e.ts` (H1: offline shift + sale, API 503, owner on the same till: set aside refused before export → export → confirm names the sale → double click sets aside exactly one row → kept with the same key → restore → API back, cashier signs in → drains, 1 sale, 1 key row; consistency gate). Needs `E2E_QA_TOTP_SECRET` like spec A/C/D/G.

For the coordinator (before building RC2):
1. Live check of `POST /rest/v1/rpc/app_role` through the gateway with an ADMIN and a CASHIER token (expects `"ADMIN"` / `"CASHIER"`; a route allow-list in Envoy that blocks it would make "Install anyway" always refuse — fail closed).
2. The Electron build now ships `dist/backend.json` (backend URL + public anon key, the same values already inlined in the JS bundle); include it in the artifact secret scan expectations.
3. Run spec H (and F) live; then build with `VITE_BUILD_LABEL=rc2` into `ShwePhaLa-artifacts/rc2-1.0.16-<commit>/`.
4. Open decision: set-aside rows keep blocking a normal update install (they are unsynced by design); the owner uses "Install anyway (after export)". If that is too strict, decide explicitly — the app never deletes them.

## 10. RC2 built and frozen (coordinator, 2026-10-16 11:52 UTC) — NOT published
Built from commit **`adbaf1b`** (clean tree; RC2 fixes D1–D4) with `VITE_BUILD_LABEL=rc2` (on-screen `v1.0.16 rc2`), the real anon key and the self-hosted origin; `--mac --arm64 --win --x64 --publish never`. Frozen read-only at `/Users/waiyan/Projects/personal/ShwePhaLa-artifacts/rc2-1.0.16-adbaf1b/` (`SHA256SUMS`, 13 entries, 13 OK). RC1 folder untouched (13 OK).

| Artifact | sha256 |
|---|---|
| `Shwe-Pha-La-POS-Setup-1.0.16.exe` | `0ca75628fb8bc22a27991143320ccd9a334341b0097452acbcd6bd8920f639be` |
| `Shwe-Pha-La-POS-1.0.16-arm64.dmg` | `1c7b650edc86a261181922eae4f82d4382a7bda048fe403f258d7a89e6ebe964` |
| `Shwe-Pha-La-POS-1.0.16-x64.dmg` | `4de021443d01b778a61933bc1d2878474cc2a43d4d759d83e919f4ef0b31ca4f` |
| `Shwe-Pha-La-POS-1.0.16-arm64.zip` | `195b096700065fa33cf53d05e2b8a74155648460b70a75cdaf601566521a63fa` |
| `Shwe-Pha-La-POS-1.0.16-x64.zip` | `b03bceca98da148d45337fd95f1c37acde80cd00d97925efac7f00601e2cc83a` |

Bundle: only the self-hosted origin (4 refs), 0 hosted refs, 0 `signUp`, 0 service-key matches in `dist/assets/*.js` and `dist/*.json`; `dist/backend.json` holds only `url` + `anonKey` (public, same values as the bundle) for the main-process owner check. `app_role()` reachable through the gateway (anon refused 42501, `authenticated` has EXECUTE, SECURITY DEFINER).

Regression on `adbaf1b`: tsc clean; vitest 1040; Deno 94; harness 747/0 (capped 083: 672/0); isolation audit (083+085) 454/0/2 low, parity PASS; live suites all pass, CLEAN; e2e first run 47 passed / 2 failed (A8, C3 still clicked the removed Dismiss button — test-only), after updating those two specs to export + Set aside (commit after `adbaf1b`, **no product code changed**): **50 passed, 1 skipped (084-only)**, CLEAN; 574/574 images; production fingerprint identical.

Open design decision: set-aside rows (including server-rejected "permanent conflict" sales) stay on the till forever and keep blocking a normal update install, so each later update on such a till needs the owner's "Install anyway (after export)". Nothing can permanently remove a set-aside row (by design). → Addressed by RC3 (§11): the owner can reconcile such a row; it then stops blocking ordinary updates and is still never removed.

## 11. Release candidate RC3 (developer, 2026-10-16) — owner reconciliation, code only, NOT built

Same version **1.0.16**; RC3 is identified by its artifact folder (`ShwePhaLa-artifacts/rc3-1.0.16-<commit>/`, built by the coordinator after the full regression) and optionally `VITE_BUILD_LABEL=rc3`. RC1 (`b777345`) and RC2 (`adbaf1b`) and their frozen folders are untouched.

**Why.** RC2 left set-aside rows on the till forever, and every later update needed the owner's "Install anyway (after export)" (§10, open decision). RC3 lets the owner **document** what happened to such an entry. A documented ("reconciled") entry stays on the till and in every export but no longer holds back an ordinary update.

**No migration. No server change. No Dexie schema change** (`status` is already indexed; the new fields are unindexed; the log uses the existing `syncState` table).

### 11.1 State machine

```
                 enqueue
                    |
                    v
   +---------> pending <------------------------------+
   |              |  ^                                 |
   |   drain      |  | transient error / stranded      | Retry (staff)
   |              v  | (RC2 D2)                        |
   |           syncing ----- success -----> (row deleted: synced)
   |              |
   |              | permanent rejection
   |              v
   |           conflict ----------------------+        quarantined  (other backend / 1.0.15;
   |              |                           |             |         startup + every drain)
   |    Set aside (owner, export first; RC2)  |             |
   |              v                           |             |
   +-- Restore -- archived ("Set aside") <----+-------------+  (Set aside from any status)
                  |        ^                  |             |
                  |        | integrity check  |             |
                  |        | fails on load    |             |
                  v        |                  v             v
              +--------------------------------------------------+
              |  reconciled  (owner; terminal; never sent;       |
              |  in every export; does NOT block updates while   |
              |  its record, digests and seal check out)         |
              +--------------------------------------------------+

  Reconcile allowed FROM:   conflict, quarantined, archived
  Reconcile refused FROM:   pending, syncing, failed (still in the drain: set aside first),
                            reconciled (duplicate)
  reconciled -> anything:   only the integrity check (-> archived + reconcileRejected, "needs attention")
  Never automatic:          no code path except stores/data/reconcile.ts writes "reconciled" (a test scans src/);
                            permanent rejection, export, timeout and retry failure leave the row as it was (test)
```

### 11.2 Flow (owner, Sync Conflicts page → "Reconcile")

1. **Export first.** The export of this session must contain *this exact entry*. At export time the app records, per entry, `entryDigest` = SHA-256 over localId + idempotency key + kind/name/table/op/row id + payload (`src/lib/reconcile/digest.ts`, `collectQueueExportSnapshot`). An entry changed since needs a new export ("export-stale").
2. **Server check (read-only)**, §11.3. Result shown: *recorded* (sale id + receipt no.), *not recorded*, *inconclusive* (with the candidate sales).
3. **Resolution** (`src/lib/reconcile/policy.ts`):
   - `matched`: references the sale the check found (recorded: that one; inconclusive: one of the listed candidates);
   - `recreated`: the owner re-entered it through the normal, idempotent POS flow. The app verifies the **new** sale on the server: same shop, rung up after the entry was queued, not one of the check's sales. Refused when the check says *recorded*. One server sale can close only one entry;
   - `cancelled`: only when the check says *not recorded*.
4. **Reason** (5–500 characters). The check must be at most 10 minutes old and made for this entry's digest.
5. **Owner, verified now** (§11.4). Then **one Dexie transaction** over `syncOutbox` + `syncState`: compare-and-set on the whole row as the owner saw it (canonical JSON); status → `reconciled`, `statusBeforeReconcile`, the `reconciliation` record, plus one log line `reconcile-log:<id>`.

The record (`src/lib/reconcile/types.ts`) holds:
- the resolution and the server sale (id, receipt, shop, shift, time);
- the full check;
- the reason and `reconciledAt`;
- `statusBefore` and the earlier status history (queued / quarantined / set aside, from the row's own fields);
- the export (time + digest);
- the entry's `refs` as resolved now;
- the owner: `userId` from `app_user_id()`, `name` from the owner's own `users` row, org, `verifiedAt`, `source: "backend"`;
- `entryDigest`, `recordDigest` and main's `seal`.

Payload, idempotency key, attempts, last error and the RC2 set-aside fields stay on the row.

Reconciling **never** sends the entry, never calls an RPC, and never writes stock, payments or sales. Tests: the RPC mock is not called; the local sales/inventory/movement tables are unchanged; the fake server gets no write; the server check uses `from().select()` only. A correction goes through the normal POS sale/refund screens; the record only links to it.

### 11.3 Server check method (`src/lib/reconcile/serverCheck.ts`)

- **By idempotency key: impossible without a migration.** `idempotency_keys` (062) has RLS on, no policies, and ALL revoked from `anon`/`authenticated`. No RPC answers "was key K recorded?" without executing the call, and re-sending `complete_sale` would **write** the sale when it is missing.
- **So: by the client operation identity**, the same rule as `e2e/helpers/saleLedger.ts`. `complete_sale` stores the client's ring-up time `p_created_at` verbatim as `sales.created_at` (045, within −48 h/+5 min), and the client mints it once per operation. The check reads through the owner's normal RLS (069 `sales_sel`: ADMIN reads every sale of the org's shops; `sale_items_sel` inherits it):
  - *exact*: same shop, same shift (resolved through the id map when the shift was opened offline; unknown = shop-wide), same instant, same payment method / paid amount / cart discount, same lines (product + base quantity);
  - *loose*: same shop/shift, same amounts and lines, any time from ring-up − 24 h. This catches a replay stamped with server time (more than 48 h late, or a fast till clock);
  - a sale at the same instant with other details is also a candidate.
- Results:
  - *recorded* = exactly one exact match and no candidate;
  - *not recorded* = nothing exact, no candidate, a ring-up time present, fewer than 50 same-amount sales;
  - anything else (several matches, candidates, a read error, a non-sale entry) = *inconclusive*.
- Non-sale entries (`open_shift`, `adjust_stock`, table writes …) are *inconclusive / unsupported*. `matched` and `cancelled` are then impossible, and `recreated` needs a sale, so in practice they stay set aside and are reconciled from the export (`tools/queue-recovery`). This is a documented limitation.
- A quarantined (other backend) entry is checked against **this** server only; the dialog says so.

### 11.4 Owner verification (`electron/reconcileAuthority.cjs`, main process)

IPC `reconcile:attest`, from the app window only. Main uses the session's access token and the build's own backend config (`dist/backend.json`, never from the renderer) and calls:
- `rpc/app_role` (must be `ADMIN`);
- `rpc/app_user_id`;
- `users?id=eq.<id>` (own row: name, role ADMIN, active, org).

This happens **every time, with no cache**. A network failure, timeout or 5xx is refused with "Reconciling needs a live owner check: try again when the till is online". The updater's recovery path (§9 D4) accepts an owner cached for 12 h during an outage; reconciliation has no such shortcut. Reconciling is a judgement against the server's data, which cannot be checked offline anyway, and a cached owner would let a stolen or left-open session close entries without the server's confirmation.

On success main returns the owner identity and `seal = HMAC-SHA-256(key, {localId, entryDigest, recordDigest, owner id, owner name, verifiedAt})`:
- the key is 32 random bytes in `userData/reconcile-seal.key` (mode 0600), created on first use, never sent to the renderer;
- `reconcile:verify-seals` checks stored seals;
- `updater.log` gets `reconcile owner check result=<code> step=<…>` (never the token);
- without a main process (plain browser, older preload) reconciling is refused ("needs the desktop app");
- unpackaged with `SHWE_POS_E2E=1` only, the backend config comes from `E2E_SUPABASE_URL`/`E2E_ANON_KEY` (for spec I). A packaged build never reads them.

### 11.5 Update guard, integrity check, exports

- `collectAppState()` (`src/lib/updateGuardBridge.ts`) now reports `blockingOutboxRows()`: every row except a **reconciled row whose record checks out** (structure; `entryDigest` recomputed from the row; `recordDigest`; main's seal). Pending, syncing, failed, conflict, quarantined and **unresolved set-aside** rows still block. `electron/updateGuard.cjs` is unchanged.
- The same check runs before every guard report (at most every 30 s) and when the Sync page loads. A failing reconciled row:
  - goes back to **Set aside** (`archived`; `statusBeforeArchive` = its earlier conflict/quarantined status, never a sendable one);
  - keeps the rejected record under `reconcileRejected` and logs `tamper-detected`;
  - shows "Reconciliation rejected: needs attention" and **blocks updates again**.

  Without a main process to check seals, a reconciled row is not reverted but still blocks.
- **Export format stays v1**, additive: status `reconciled`, `statusBeforeReconcile`, `reconciliation` (passthrough schema), `reconcileRejected`, and a top-level `reconciliationLog`. RC1/RC2 files still read (defaults; `audit/rc1/export-format-stability` passes). A file with reconciled entries needs the RC3 recovery tool; older tools reject the status as `bad-format`.
- **`tools/queue-recovery`**: reconciled entries are `skipped-reconciled`, with the owner's record in the detail; `inspect` prints the record and the log. Only `--include-reconciled` replays them, judged by their former status (a former conflict still needs `--include-conflicts`, a former set-aside entry `--include-set-aside`). `skipped-reconciled` does not fail the exit code.
- **Id map (D3 decision):** a reconciled row no longer pins its provisional-id mappings: the till never replays it, and the record keeps `resolvedRefs`. Mappings referenced by any non-reconciled row are kept as in RC2.
- 1.0.15 rows (quarantined at startup) and RC1/RC2 rows (conflict, archived) reconcile like any other; their history fields stay. `quarantineForeignOutboxEntries` never touches a reconciled row; Retry and Set aside refuse it.

### 11.6 Owner procedure (on the till, online)

1. Sync Conflicts → **Export pending**. Keep the file and the passphrase.
2. On the row (conflict / other server) or under "Set aside": **Reconcile** → **Check server**.
3. Decide:
   - *Recorded* → `matched`: the sale is already there. A refund, if any, goes through the normal refund flow.
   - *Not recorded* → `cancelled` if it did not happen. Or ring it up again through the POS and choose `recreated` with the new receipt no. (**Verify on server**).
   - *Inconclusive* → compare the listed sales with the export; `matched` to one of them, or leave it set aside.
4. Write the reason → **Reconcile (owner check)**. Offline it is refused; try again online.
5. A pending or retrying sale must be **set aside** first (that stops the drain from sending it).

### 11.7 Security evidence (requirement 8)

| Threat | Protection | Test |
|---|---|---|
| Duplicate reconciliation | Status check before and inside the transaction. A second attempt gets `already-reconciled`; one record, one log line | rc3 "reconciled -> reconciled is refused" |
| Concurrent updates / two windows | One Dexie rw transaction with compare-and-set on the whole row as the owner saw it (`expectedRow`). A restore, set aside or edit between opening and committing (also during the owner check) → `changed`. Two parallel reconciles → exactly one succeeds. One server sale cannot close two entries | rc3 "two windows…", "COMPARE-AND-SET…", "recreated… same server sale" |
| Server committed, response lost | The check reads by client operation identity, so the committed sale is found → *recorded* → `cancelled` refused, `matched` to that sale. Late replays (server time) are candidates → never *not recorded* | rc3 "server committed but the response was lost" (real drain: commit + network error → pending → set aside → check → matched; no RPC sent, no sale created, the drain never resends); serverCheck "RESPONSE LOST", "> 48 h" |
| Offline authorization | Main verifies with the server every time, no cache. Offline/5xx is refused even right after a success | authority "OFFLINE is refused…"; rc3 "OFFLINE -> refused…" |
| Non-owner / tampered renderer claim | Authorization is main's server answer only; `authStore` is not consulted. CASHIER / inactive / no profile / 401 are refused (logged `refused`). A renderer that forges an attestation (fake owner + seal) has its row reverted at the next integrity check | authority tests; rc3 "TAMPERED RENDERER CLAIM", "FORGED ATTESTATION" |
| Tampered local queue data | The record is bound to `entryDigest` (payload + key + localId …) and `recordDigest`, sealed with main's HMAC key. On load a mismatch (payload, key, reason, resolution, owner, a row forged to `reconciled`) reverts to Set aside + `reconcileRejected` + log, and blocks updates again | rc3 "tamper detection" (7 cases) |
| Crash between status write and log write | Both in one Dexie transaction. A failure in the log write rolls the status back; a retry then succeeds once | rc3 "CRASH between…" |

**Residual risk.** An administrator of the till machine can read `reconcile-seal.key` and the IndexedDB and forge both the row and its seal. They could equally delete rows, and the updater guard trusts the renderer's report. True tamper evidence needs a server-side record.

**Proposal (not written, not applied; separate deployment approval):**
- **086** `record_outbox_reconciliation(p_local_id, p_entry_digest, p_record_digest, p_resolution, p_sale_id, p_reason, p_idempotency_key)`: SECURITY DEFINER, `app_role() = 'ADMIN'`, org-bound, append-only table + an `audit_logs` row, idempotent by `(org, local_id)`;
- **087** a read-only, owner-only, org-bound `idempotency_key_recorded(p_key uuid) → {recorded, rpc, sale_id}` for an exact key lookup.

RC3 needs neither.

**Server audit entry: not written.** The only client-callable audit RPC (`log_audit_event`, 070) allow-lists catalogue actions (`PRODUCT_*`, `CATEGORY_*`), and `audit_logs` has no INSERT grant for `authenticated` (065). Writing a reconciliation under a catalogue action type would be misleading. The audit trail today is:
- the local log (`syncState` `reconcile-log:*`), included in every export and in `inspect`;
- the record on the row;
- the `updater.log` lines of main's owner checks.

### 11.8 Tests (developer run, 2026-10-16, no live runs)

| Suite | Result |
|---|---|
| `npx tsc -b`, `npx tsc -p e2e/tsconfig.json`, `npx tsc -p tools/queue-recovery/tsconfig.json` | clean |
| `npx vitest run --exclude '.claude/**'` | **1091 passed**, 66 skipped (baseline 1040 + 51: `src/stores/data/reconcile.rc3.test.ts` 35, `src/lib/reconcile/serverCheck.test.ts` 10, `src/lib/reconcile/authority.test.ts` 6; the fixtures of `format.test.ts` / `replay.test.ts` gained the additive fields) |
| Deno functions | **94 passed**, 0 failed |
| SQL harness | not run: no `supabase/` change, no migration |
| eslint on every changed file | clean |

E2E prepared, not run: `e2e/i-reconcile.e2e.ts`. Needs `E2E_QA_TOTP_SECRET`. Consistency gate after the spec.
- **I1**, a server-rejected (conflict) sale: Reconcile blocked before export → export → check *not recorded* → `cancelled` + reason → reconciled (same key/payload; owner = QA admin, from the server); guard report unsynced 1 → 0; no sale and no key row on the server.
- **I2**, response lost (the server commits, the reply is reset, later sends get 503): export + set aside (guard still 1) → check *recorded* with the receipt no. → `cancelled` disabled → `matched` → guard 0. After the routes are removed the row is never resent; 1 sale, 1 key row.

### 11.9 For the coordinator (before building RC3)

1. Live check through the gateway with an ADMIN token: `POST /rest/v1/rpc/app_user_id` (expects the app user id) and `GET /rest/v1/users?select=id,name,role,is_active,org_id&id=eq.<id>` (own row). Main's owner check needs both, besides `app_role`. All are existing grants (015/064, RLS 056). A blocked route makes Reconcile refuse (fail closed).
2. Run spec I (and H, A8/C3 for the unchanged set-aside flow) live. Then build with `VITE_BUILD_LABEL=rc3` into `ShwePhaLa-artifacts/rc3-1.0.16-<commit>/`.
3. Artifact scan: expectations unchanged (`dist/backend.json` as in RC2). The seal key is created on the till at the first reconciliation and never shipped.
4. Decide whether to schedule the optional 086/087 (§11.7) for server-side tamper evidence. RC3 does not need them.

## 12. RC3 built and frozen (coordinator, 2026-10-16 ~15:05 UTC) — NOT published
Built from commit **`a722aa3`** (RC3 reconciliation `579ece5` + strict-resolution fix `c8a8c88` + e2e test fixes) with `VITE_BUILD_LABEL=rc3`, real anon key, self-hosted origin, `--mac --arm64 --win --x64 --publish never`. Frozen read-only at `/Users/waiyan/Projects/personal/ShwePhaLa-artifacts/rc3-1.0.16-a722aa3/` (`SHA256SUMS`, 13 OK). RC1 (13 OK) and RC2 (13 OK) unchanged. An untracked `docs/audits/orvix-pos-completeness-audit.md` (not created by this work, not in the bundle) was present in the checkout and left untouched.

| Artifact | sha256 |
|---|---|
| `Shwe-Pha-La-POS-Setup-1.0.16.exe` | `0730ac9aec2a47ce3ab14dfa9b7fc3ee83e00ef73af38e02b816251fd5154599` |
| `Shwe-Pha-La-POS-1.0.16-arm64.dmg` | `fe85d9be587da35baa2888ece3ca5e15e5050d75eab4f6f658eef64a5942cc17` |
| `Shwe-Pha-La-POS-1.0.16-x64.dmg` | `63fa2de3acaa7d538dec7c9baeacc42fde9eafc887a0fade603e1936167c67fb` |
| `Shwe-Pha-La-POS-1.0.16-arm64.zip` | `be9d45b7fe598fecf4a1a1d27b8d06c7b0cd22fbc38b0a554765e70453237fff` |
| `Shwe-Pha-La-POS-1.0.16-x64.zip` | `4e1ae0782eeac6e09a929965c721ecea0affc51d3fab460f9a8b4c2336468160` |

**Pre-freeze verification (owner's six checks)**
1. Live reconciliation e2e executed (not skipped): I1 (rejected sale → `cancelled`) and I2 (response lost → `matched`) passed 3× standalone and in the full suite.
2. Full suite: on `579ece5` — tsc, vitest 1091, Deno 94, harness 747/0 (083-capped 672/0), isolation audit (083+085) 454/0/2 low + parity PASS, live suites all pass, e2e 51/1 failed (I2: test-only setup assumption); on the final `a722aa3` — tsc, vitest **1092**, Deno **94**, e2e **52 passed, 1 skipped (084-only)**, CLEAN. Server-side suites unchanged since `579ece5` (only client policy + tests changed afterwards); production fingerprint identical.
3. **Fixed before build (`c8a8c88`)**: RC3 as merged let the owner pick a candidate and mark `matched` after an INCONCLUSIVE check. Now `matched` requires an unambiguous result (`recorded`: exactly one exact match, no other candidates); the dialog disables it otherwise and the stored-record check treats a matched-from-ambiguous record as unresolved (blocks updates). Regression test covers two exact matches, exact + candidate, and read error.
4. A server lookup failure is always `inconclusive`, never `not recorded` (every read path returns inconclusive on error; tested).
5. No silent suppression: `cancelled` requires a definite `not recorded` check (both exact and time-shifted searches succeeded and empty), an export containing the entry, the server-verified owner, a reason; `recreated` now also requires `not recorded` (prevents double counting after an inconclusive check); inconclusive entries cannot be reconciled at all and keep blocking updates; reconciled rows stay on the till with payload + key + record and in every export; reconciliation never writes stock, payments or sales.
6. Installer archives (`app.asar` of the Windows and macOS builds, extracted): hosted project ref **0**; service key **0**; JWT secret **0**; the only JWT is the anon key; no `@qa.invalid`, TOTP test secrets, export test passphrases, `sb_secret_`, `.env` or PEM files; none of our tests ship. The 45 `supabase.co` mentions are inside `node_modules/@supabase` and one bundled copy of supabase-js's default tracing targets (`"*.supabase.co"`, a host pattern, not an endpoint).
