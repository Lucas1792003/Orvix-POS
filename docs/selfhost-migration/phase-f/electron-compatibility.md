# Electron client × backend compatibility at schema 081 (staff-admin, phone page, sign-up off)

Status: **analysis + tests, 2026-10-14 (UTC)**. Nothing released, installed or deployed by this change. Hosted Supabase was not contacted. The self-hosted stack was inspected read-only once (below). Data-path tests used the disposable harness only.

Extends the earlier release-compatibility matrix (schema 079; kept with the private release notes, referred to below as "release-compat") to the current server: 080 + 081, `staff-admin`, `phone-upload-page` and `DISABLE_SIGNUP=true`.

## 0. What exists

| Client | Source | Backend pin | Notes |
|---|---|---|---|
| **v1.0.15 (published)** | tag `v1.0.15` | hosted, through `VITE_SUPABASE_URL` baked in at build time. `src/lib/supabase.ts` at the tag: `createClient(import.meta.env.VITE_SUPABASE_URL, …)`. No runtime override. Packaged `main.cjs` always runs `loadFile(dist/index.html)` (`isDev = !app.isPackaged`), so `VITE_DEV_SERVER_URL` is ignored | No idempotency keys. Uses `auth.signUp` in the Users page and as the login fallback. Its phone QR comes from `window.location.origin` (`file://` when packaged). No Realtime. No queue export |
| Intermediate local build, Windows NSIS (`release/`, 2026-10-12) | branch before Phase F | self-hosted stack (asar: 1 file pinned, 0 hosted refs) | **`package.json` 1.0.15.** Sends keys (39 `p_idempotency_key`). Still has **2 `auth.signUp` calls**. No `staff-admin`, no phone page, no queue export |
| Intermediate local build, macOS arm64 (`release/`, 2026-10-13 18:16) | branch, Phase F | self-hosted stack | **1.0.15.** Has `staff-admin`, the phone page, `phone-upload-token` and export. 0 `auth.signUp` |
| **Current branch (1.0.16 candidate)** | this change | self-hosted stack, pinned at build and at startup (`VITE_SUPABASE_EXPECTED_HOST`) | **`package.json` still says 1.0.15** (release checklist 3.4) |

The only JWT found in each bundle is the anon key: role `anon` (checked by decoding the claim; the key itself was not printed). No `service_role` string appears in any bundle.

**Self-hosted stack read-only check (2026-10-14):**
- `supabase_migrations.schema_migrations`: max `081`, 81 rows.
- `GOTRUE_DISABLE_SIGNUP=true`.
- Function directories: `admin-2fa`, `email-sales-report`, `main`, `phone-upload-page`, `phone-upload-token`, `platform-console`, `staff-admin`.
- 30 public functions take `p_idempotency_key`.

## 1. Matrix

Legend:
- **W**: works.
- **L**: fails loudly (error shown, nothing written).
- **S**: fails silently.
- **X**: writes incompatible data.
- "n/r": not reachable (build pin).

| Operation | v1.0.15 × hosted | v1.0.15 × self-host@081 *(not reachable: hosted pin; simulated)* | current × hosted *(build refuses; forced web build simulated)* | current × self-host@081 |
|---|---|---|---|---|
| Login, password + TOTP / email code | W | Sign-in W. **A failed login falls back to `signUp`, which gets 422 `signup_disabled`**: L, shows "Signups not allowed…" instead of "Invalid email or password"; no write | n/r. Forced build: login W, `app_setup_needed` 404 PGRST202 → no setup offered | W (QA TOTP admin live, G8 F8). **Owner's migrated factor: still pending** (release checklist 1.1) |
| Staff creation | W (`signUp` + `create_app_user`) | L: `signUp` 422, so `create_app_user` is never reached. Even if it were: `IDEMPOTENCY_KEY_REQUIRED` (t19) | n/r. Forced build: `staff-admin` 404 → **now "staff-admin service is not installed. Nothing was created."** (§4 fix; was "Could not create the staff account.") | W (live F2/F7, G8) |
| First-time setup | W (orphan `signUp` + direct `users` insert) | L: `signUp` 422; direct `users` insert refused (t19) | n/r. Forced build: setup not offered; `bootstrap_account` 404 → clear message (§4) | L by design on a populated install (`setup_closed`); empty-install path covered by harness t12 |
| Sales, refunds, shifts, stock, POs, transfers, supplier payments, users (the 30 keyed RPCs) | W (no idempotency) | **L**: all 30 resolve and raise `22023 IDEMPOTENCY_KEY_REQUIRED`; zero rows anywhere (t19). The outbox marks the entry `conflict` after 1 attempt (release-compat §4) | **L**: 30/30 404 PGRST202, 0 rows, no retry loop (release-compat §3) | W (harness t01–t13, live suites, e2e) |
| Catalogue direct writes (products, barcodes, units, prices, categories, brands, unit types, shops, tiers, supplier links, business profile) | W | **W, within the caller's org.** `org_id` comes from the caller (068 triggers). Stale cross-org ids hit 0 rows or are refused. A cashier or an orphan is refused. No NULL `org_id` (t19). Not incompatible data, but it **is** a write path that bypasses the key gate | n/r. Forced build: **W on hosted** (the residual from release-compat §3; only a web build can do this) | W |
| Phone image upload (QR) | Web: W. Packaged: L (QR is `file://…`, the phone cannot open it) | Packaged: L (same QR). If the old phone page reached the self-hosted stack: works only inside the caller's org. Legacy `temp/<id>` refused, foreign `products/<id>/` refused. A client URL with a foreign host is **ignored**; the stored and returned URL comes from the server. Replay refused (t19) | n/r | W (`phone-upload-page`, JIT token, 081 limits; e2e spec D, live G5/G7/G8) |
| Desktop direct image upload | W | W for own products (legacy `products/<id>/` path is accepted by 078); refused for foreign ones (t19) | n/r | W (org-prefixed paths) |
| 081 rate limits | n/a | Session create: 120/user/h → `PT429` **L**. The old page never calls `phone-upload-token` | n/r | W (harness t17, live G7) |
| Queue export | absent | absent | local only; works offline, needs no backend | W (e2e `f-queue-export` 3/3) |
| Realtime (inventory) | absent at the tag | absent | n/r | W (org-aware policy; t10, realtime-reconciliation) |

**No cell is "X".** The only "S" class still open is v1.0.15's own outbox wipe on a full load (release-compat §6). That is a hosted-today defect, not a cross-backend write.

## 2. "Older builds cannot silently write incompatible data": the proof

**(a) v1.0.15 cannot be redirected.** Four facts close every path:
- The URL is a build-time constant (tag source, §0).
- The packaged app ignores `VITE_DEV_SERVER_URL`.
- TLS to `*.supabase.co` cannot be spoofed to the self-hosted stack.
- electron-updater 6.8.9: `allowDowngrade = false`, `allowPrerelease = false` (`AppUpdater.js` l.125/138). The flag only turns on when the running version has a prerelease tag (l.218). `channel` is never set in `main.cjs` (tag or branch; a set channel would force `allowDowngrade`, l.44). `isUpdateAvailable` returns older only with `allowDowngrade` (l.362).

So a till moves only forward, and only to a full release. Re-publishing an older build never rolls a till back.

**(b) If its requests reached the self-hosted stack anyway**: harness `t19_old_client_compat.sql`, 37 assertions. The argument names are the exact ones in the tag's source, extracted from every `.rpc(` call.

- **RPCs: the premise "PGRST202" is wrong for the old client.** `p_idempotency_key` is `uuid DEFAULT NULL` and every old argument name still exists, so PostgREST *resolves* the call. The 063 gate then raises `22023 IDEMPOTENCY_KEY_REQUIRED` for 30/30 calls as ADMIN, and for realistic checkout payloads (`open_shift`, `complete_sale`, `adjust_stock`) as a cashier. The row count of **every public table and the total stock are unchanged**. (PGRST202 is what the *new* client gets from *hosted*.)
- **Direct writes**: every insert without `org_id` gets the caller's org (products, barcodes, categories, brands, unit types, shops). Inventory rows are created only for the caller's shops. The `business_profile` `.eq('id','default')` update hits exactly the caller's row. Stale foreign ids:

  | Old write with a foreign target | Result |
  |---|---|
  | `products.update` | 0 rows |
  | barcode delete | 0 rows |
  | `product_units` upsert | `42501` RLS |
  | barcode insert | `P0001 Product not found in your organization` |
  | `price_tiers` | `P0001 Shop not found…` |
  | `supplier_products` | `P0001 Supplier or product not found…` |
  | cashier product insert | `42501` |
  | orphan's old setup `users` insert | `P0001 Only an ADMIN can create…` |
  | orphan's product insert | `42501` |

  Counts are unchanged and no NULL `org_id` exists anywhere.
- **Phone flow**:
  - Old `attach` works on the caller's own live session.
  - A foreign admin gets `Upload session not found`; anon gets `permission denied`.
  - Legacy `temp/<id>` writes and completions are refused (`Upload path does not match this session`).
  - A completion with a `…supabase.co` URL stores `https://<trusted base>/storage/v1/object/public/product-images/org/org-test/temp/<id>`; the desktop poll returns only that URL.
  - A replay gets `Upload link is no longer active`.
- **Sign-up**: GoTrue setting, not testable in the harness (no GoTrue; t19 asserts no public function writes `auth.users`). Live evidence: G8 `public signup → 422 signup_disabled`, live F1 "signup refused".

**(c) Current build × hosted fails closed.**
- `build:electron` with the hosted URL → exit 1 `Backend host mismatch…`, no `dist/` (re-run today).
- The RPCs give 30/30 PGRST202 with 0 rows (release-compat §3.2).
- **Staff creation** against a backend without `staff-admin` used to say only "Could not create the staff account." Now it shows a specific message (§4). The function never runs there, so no account is created at all. There is no client-side half-step: no `signUp`, no `setSession`, no `users` write (asserted).

## 3. Packaged-app checks (local, placeholder env; there is no `.env.example`, env given inline)

| Build | Result |
|---|---|
| hosted URL | exit 1, host-mismatch guard, no `dist/` |
| no env | exit 1 `VITE_SUPABASE_URL is not set…` |
| `http://<pinned host>` | exit 1 `Electron build: Phone upload is not available… only https://` |
| `https://your-backend.example.ts.net` (= the pinned host) + placeholder key | exit 0 |

Bundle checks:
- The host appears 2× (URL + expected host); 0 hosted project refs (the only `supabase.co` text is supabase-js's `*.supabase.co` allow-list).
- `./assets/` paths.
- 0 `.auth.signUp(` calls (only the library's method definition).
- No service key; the only JWT-shaped string is the placeholder.
- `"staff-admin"` with `create_staff`/`bootstrap_account`; `phone-upload-page` (QR = API origin + `/functions/v1/phone-upload-page#token`).
- "Export pending transactions" and `shwephala-queue-export`.

Version string: the app shows `app.getVersion()` = `package.json` **1.0.15**.

The bundle also hard-codes `v1.0.11` download links in a landing component. That is cosmetic and was left alone.

**Updater and the unsynced queue:**
- The outbox lives in IndexedDB under userData (`%APPDATA%\retails-shop`).
- `deleteAppDataOnUninstall` is not set, so `DELETE_APP_DATA_ON_UNINSTALL` is undefined (app-builder-lib `uninstaller.nsh` l.223). Updates also pass `--updated` (`installUtil.nsh` l.205), which preserves userData.
- On the branch, a full load clears only the snapshot tables (`localSync.test.ts` "does not clear the outbox, id map, cursors, auth cache or sync state").
- Dexie v2 upgrade stamps keys on queued v1 entries.
- Export entry points: badge, Sync page, login page.

## 4. Fix in this change

`src/lib/staffAdmin.ts`: a response that did not come from `staff-admin` itself now produces a clear message:

| Response | Reason | Message |
|---|---|---|
| hosted 404 `{code:"NOT_FOUND"}` | `function_missing` | "This server cannot create staff accounts: its staff-admin service is not installed. Nothing was created…" |
| self-hosted 500 `{msg:"…worker boot error…"}` | `function_missing` | same |
| gateway or other non-function error | `unconfirmed` | "The server did not confirm… Check the user list, then try again (a retry will not create a duplicate)". The form keeps its idempotency key, so a retry replays |

The function's own `{error, code}` answers pass through unchanged. `createBootstrapAccount` applies the same mapping.

The message choice moved to `staffCreateErrorMessage()` (`features/admin/staffForm.ts`), which `UsersPage` uses.

Tests: +5 in `createStaffUser.test.ts`, +3 in `staffForm.test.ts`.

## 5. Gaps and proposals (need approval; none applied)

1. **No backend version handshake.** Today safety relies on the key gate (old→new) and PGRST202 (new→old). **Proposed migration 083, not written:**

   ```sql
   app_backend_info() RETURNS jsonb STABLE SECURITY DEFINER
     → {schema: 83, minClient: "1.0.16", features: ["idem-v1","staff-admin","phone-page"]}
   ```

   - EXECUTE for `authenticated` only (anon learns nothing).
   - The client calls it after sign-in and before every outbox drain. On PGRST202 (an older backend), or when `schema` is below the build's required minimum, or the client version is below `minClient`, it blocks writes and the drain and shows a "this till needs an update / wrong server" screen.
   - Harness test: grants, shape, and the anon refusal.
   - It is not trivial in effect (it changes boot behaviour), so it is left as a proposal. Do not number-clash with 082.
2. **Outbox entries carry no backend stamp** (release-compat §5.1 safeguard 1, still open). Owner decision D-d.
3. **Version still 1.0.15** on the branch and in both intermediate builds, the same as the published hosted build. Bump at release step 3.4.
   - **Delete or quarantine `release/`** before building 1.0.16. The 2026-10-12 Windows installer still calls `auth.signUp` and has no phone page; installed on a till it would fail loudly at staff creation (422) and phone upload.
4. **The updater installs on quit even with a pending queue.** This is safe for forward versions (outbox kept and upgraded). It is unsafe only for a v1.0.15-based rollback build (release-compat §5/§7: an empty queue is mandatory). A main-process guard could ask the renderer for the pending count and defer `autoInstallOnAppQuit`; proposal only.
5. **v1.0.15 catalogue writes bypass the key gate.** They are org-correct (t19) and unreachable through the pin. They only matter if someone rebuilds v1.0.15 against the self-hosted stack: never do that (release checklist correction 4).
6. Web build not pinned (known: deployment-automation audit).

## 6. Canary requirements on real devices (add to canary R6/R11)

1. On the till: Sidebar/login shows `Backend: <your backend host>`; About/updater log shows **1.0.16** (not 1.0.15).
2. Owner TOTP login on the till (migrated factor). Then create a throwaway CASHIER on the Users page. Expect success; sign in as it; deactivate it.
3. Temporarily point a *web dev build* (never the till) at a stack without `staff-admin`, or use the unit tests: confirm the "service is not installed" message renders in the Users modal and the modal stays open.
4. Phone upload from the till: scan the QR (it must start `https://<your backend host>/functions/v1/phone-upload-page#`), upload after > 60 s, and check the image appears with the server-derived URL.
5. Offline sale → close the app → reopen offline → the queue is still there → "Export pending" produces an `.spqx` → reconnect → it drains, with no duplicate.
6. On a test machine only, with one pending entry on 1.0.16, run a locally built 1.0.17 test installer by hand (it takes the same NSIS `--updated` path as an auto-update; nothing is published). The entry must survive and drain after restart.
7. updater.log on a v1.0.15 machine during the pre-release: "update not available" (latest = 1.0.15, prerelease ignored).
8. Zero requests to `*.supabase.co` during all of the above (proxy/firewall log).

## 7. Test results

| Suite | Result |
|---|---|
| `npx tsc -b`, `npx tsc -p e2e/tsconfig.json` | clean |
| `npx vitest run --exclude '.claude/**'` | **892 passed**, 63 skipped (baseline 884 + 8) |
| Harness `supabase/tests/phase-d/run.sh` (container `pos-test-db-compat`, port 55491) | **601 / 0**, 0 findings, 0 aborted (baseline 564 + 37 `t19`) |
| `build:electron` guard runs | 3 refusals + 1 pass (§3) |

## 8. Update 2026-10-16: release candidate 1.0.16

Release notes and the canary checklist are kept with the private ops notes. Local only. Nothing published, hosted not contacted, no live test on the self-hosted stack.

**Gaps from §5:**

| §5 item | State |
|---|---|
| 2. Outbox entries carry no backend stamp (D-d) | **fixed.** Entries record `backendOrigin`. Untagged (v1.0.15) or foreign entries are quarantined at startup and before every send: never sent, never retried, never auto-deleted, exported with their origin. A backend change also discards the cached catalogue, cursors, auth cache and every stored session (re-login) |
| 3. Version still 1.0.15; stale `release/` | **fixed.** `package.json` 1.0.16. The old `release/` output was moved out of the repository |
| 4. Updater installs on quit with a pending queue | **fixed.** `autoInstallOnAppQuit` is off. A guarded install happens only with the queue empty, online, signed in and no sale in progress, or through the owner's export-first recovery path |
| 1. Version handshake (`app_backend_info()`) | open (needs a migration; not a release blocker now that entries carry their backend) |

The client also identifies itself on every request:
`X-Client-Info: shwephala-pos/1.0.16 (validated-uploads; idem-v1; outbox-origin-v1; update-guard-v1)`.

**Matrix rows changed for the current build × the self-hosted stack:**

| Row | State |
|---|---|
| Desktop direct image upload | removed. The validated session flow only; clear error on a server without it |
| Queue export | includes quarantined entries |
| Upgrade 1.0.15 → 1.0.16 with pending entries | now **L**: quarantined, export required, no replay. It was **X** in release-compat §5, which replayed hosted-era entries on the self-hosted stack |

**Operational rule (the 1.0.15 updater has no guard):** every 1.0.15 till is at 0 pending and closed before 1.0.16 is published as latest. The owner also runs a read-only hosted delta check for rows written after the migration export.

**Tests:**

| Suite | Result |
|---|---|
| vitest | **1010 passed** / 66 skipped (baseline 972 + 38) |
| Deno functions | 94 |
| tsc | app, e2e, tools clean |
| Electron-level updater-guard test | 3/3 |
| Packaged arm64 smoke, all requests aborted | version / backend / till id shown; 0 hosted requests; quarantine shown for a v1.0.15-style entry |
