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
| Owner recovery: "Install anyway (after export)" | no sale in progress, **and** every unsynced row was exported in this session, **and** the owner confirms a native dialog in the main process. Offline is allowed. Rows stay on the till and drain after the update |

**What staff see** when the guard refuses:
- The dialog "Update waiting". Its detail reads, for example: "3 sales/actions waiting to sync — update will install after they sync." Buttons: OK, **Export pending…** (opens the existing queue export), **Sync now** (runs a drain).
- The sidebar button shows **Waiting**. Clicking it shows the same text with Export pending / Sync now / Install anyway (after export).
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
   - It is never deleted automatically. The Sync page allows Dismiss only after the entry was exported in this session.
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
  4. Install a **fix-forward** build by hand (e.g. 1.0.17 = 1.0.16 with the offending change reverted), pinned to the **self-hosted** backend like 1.0.16. **Owner rule (2026-10-13): a till is never redirected to hosted Supabase**, so no rollback build may contain v1.0.15's hosted pin; the earlier "1.0.17 = v1.0.15 code" idea (canary R7) is withdrawn (coordinator correction 2026-10-16). Before the first real sale on the self-hosted backend, the only situation where a till would go back to hosted is the pre-cutover period, and then only with zero pending entries on 1.0.16 and an owner decision.
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
