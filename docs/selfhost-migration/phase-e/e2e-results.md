# Phase E · End-to-end verification against the self-hosted stack

Date: 2026-10-12 05:00–07:05 UTC. Target: `https://lucashome.tail8a86e4.ts.net`
(schema 066, idempotent RPCs). Hosted Supabase: never used by the suite (see
§6 for the one incident outside the suite). No lucashome container was
stopped or restarted; Tailscale untouched; no `.env*` or auth setting changed;
no cron, no email. Nothing committed.

Final run: `npx playwright test` — **24/24 passed in 6.3 min** on a fresh QA
seed (`ts=1791787957300`); Playwright's own stats for the run were
`expected: 24, unexpected: 0, flaky: 0, skipped: 0` (start 06:52:36 UTC,
380 s). Evidence ledger: `e2e/.results/evidence.jsonl` (one JSON line per
DB-side check; quoted below). The JSON report and failure traces were deleted
and are now disabled by default because Playwright serialises the dev-server
env (anon key) and request headers (QA bearer tokens) into them.

## 1. How it was driven

| Piece | What |
|---|---|
| Terminal A | the real Electron app (`electron/main.cjs`) launched by Playwright's `_electron.launch({ args: ['.'] })` with `SHWE_POS_E2E=1` + `SHWE_POS_E2E_USER_DATA=<isolated dir>` (new env hooks: no detached DevTools, isolated `userData`/`sessionData`; verified the real `~/Library/Application Support/retails-shop` profile was never opened — last modified in August). HashRouter, `window.electronAPI` present. Loads the dev server over http (the packaged app loads `file://` — the only difference; storage, outbox and auth code paths are identical). |
| Terminal B | a Chromium page on the same Vite dev server (`chromium.launch()`), BrowserRouter, no `electronAPI`. Separate IndexedDB/localStorage. |
| Dev server | `vite --port 5179` started by Playwright's `webServer` with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` from the shell only. `global-setup` refuses to run unless the transformed `src/lib/supabase.ts` embeds the lucashome URL and no `*.supabase.co` host. Every terminal additionally aborts any request to `*.supabase.co` and records it (`B12`: 0 such requests). |
| QA tenant | Phase D `seed.sql` (4 GoTrue sign-ups → `qa-org/qa-shop/qa-shop2`, ADMIN/MANAGER/2 CASHIERs, 3 products, 100 units each, supplier) + `supabase/tests/phase-e/live/seed_extra.sql` (barcode `QABC1<ts>` on product one's unit, inventory for shop 2). Admin TOTP factor enrolled through the auth API (enroll → challenge → verify); secret kept in process memory only. |
| Failure injection | Playwright request interception on the Supabase origin only (`route.abort`, `route.fulfill(503)`, `route.fetch()` then `abort`), `navigator.onLine` override + `online`/`offline` events, a pass-through WebSocket proxy for Realtime, localStorage/IndexedDB edits, SQL on QA rows (auth.sessions, users.is_active, shifts). |
| DB evidence | service-role REST (bypasses RLS) and `psql` over ssh for `auth.*`. |
| Consistency gate | `e2e/helpers/consistency.ts` `assertConsistency()` after every spec: see §4. |

Known UI quirk met while automating (not a defect): the toast viewport
re-arms every toast's 3.2 s timer whenever a new toast arrives, so an old
toast with the same text can still be on screen; the helpers tag toasts
already visible before an action.

## 2. Coverage table

Receipt numbers below are from the final run; `shop = qa-shop-1791787957300`, code `QA1791787957300`.

### A. Application workflows

| Area | Test | Result | DB evidence |
|---|---|---|---|
| A1 | Admin login: password + TOTP, wrong code refused, shop selection, logout | PASS | wrong code → GoTrue 422 "Invalid TOTP code entered", `auth.sessions` stayed aal1; correct code → `auth.sessions` row aal2 with `factor_id`; `pos-app.currentShopId` persisted = QA shop (ADMIN starts with "No shop selected"); logout → the terminal's session row deleted (`scope=global`). |
| A2 | Manager and cashier permissions | PASS | manager nav has no Users/Sync Conflicts; `/app/admin/users` → `/app/pos`; `create_app_user` with the manager's own JWT → HTTP 400 "You are not permitted to create users", no `users` row. Cashier nav has no Purchases; `/app/purchases` → `/app/pos`; Inventory page has 0 Adjust buttons; `adjust_stock` with the cashier's JWT → 400 "You are not permitted to make this inventory adjustment", stock unchanged (100), 0 movements. |
| A3 | Open shift, barcode scan (F4, keyboard-wedge), checkout (F2), receipt | PASS | `shifts` row open (opening 0); unknown code → "Barcode not found"; scan `QABC1…` → cart line; receipt `QA…-20261012-0001`; `sales` row total 1000 / shift / cashier, 1 `sale_items`, 1 `SALE_OUT` movement, inventory 100→99. |
| A3 | F3 print preview / silent print with no printer | PASS | `listPrinters()=[]`; `electronAPI.printReceipt()` → `{ok:false, error:"No printers available on the network"}` (clean error, app responsive); the 80 mm receipt was rendered in the `.print-only-host` portal and `window.print()` fallback fired once (stubbed — the native dialog would block automation); `sales` row `…-0002` qty 2 total 2000, inventory → 97. *Before the fix in §5 this returned `{ok:true}` and never fell back.* |
| A4 | Inventory adjust (manager) → movement; Realtime on terminal B | PASS | `inventory_movements` ADJUSTMENT +5 (100→105) `created_by` manager, `audit_logs` STOCK_ADJUSTMENT=1, inventory 105; terminal B (cashier B, no reload — JS marker kept) showed "105 in stock" 783 ms after save. |
| A5 | PO create → self-approval blocked → approve → receive → supplier payment | PASS | `purchase_orders` PO-20261012-0001 DRAFT total 48000 created_by manager; manager Approve → "You cannot approve your own purchase order" (still DRAFT); cashier `approve_purchase_order` (API) → "not permitted"; admin approve → APPROVED `approved_by` admin; manager receive → RECEIVED `received_by` manager, inventory 105→145, 1 PURCHASE_IN; "Record payment" 20000 → `paid_mmk` 20000 PARTIAL, 1 `supplier_payments` row. |
| A6 | Staff creation via Users page | PASS | `users` row `user-qa-staff-ui-…` with `org_id = qa-org-…`, role CASHIER, QA shop, `auth_id` linked (`auth.users` row exists); `audit_logs` USER_CREATED=1; admin session intact after the sign-up detour; the new cashier can sign in and read its own row. |
| A7 | Realtime across two terminals | PASS | sale `…-0003` on A; B's card 97→96 in 1417 ms without reload; `inventory` 96. |
| A8 | Sync badges + Sync Conflicts page: transient (503) → Retry | PASS | offline sale → receipt PENDING, badge "1 action waiting to sync", page "0 conflicts · 1 entry still syncing"/Queued; reconnect behind a 503 → entry transient, attempts=1, "Retrying automatically"; Retry → "Still unreachable", no `idempotency_keys` row; gateway restored → Retry → "Retried", exactly 1 sale `…-0004` (key row actor admin), stock 99, PENDING record replaced. |
| A8 | Permanent conflict → Needs action → Dismiss | PASS | second offline sale; its shift closed by SQL; reconnect → "1 sync conflict needs attention", page "1 conflict · 0 entries still syncing", last error "No open shift for this cashier and shop", no key row, DB still 1 sale; Dismiss → outbox empty, local PENDING record kept flagged, stock unchanged. |
| A9 | Close shift with variance-reason gate | PASS | expected cash 4000; closing 4500 without reason → "Enter a variance reason before ending the shift." (DB still open); with reason → `shifts` closing 4500 / expected 4000 / variance 500 / reason stored. |

### B. Failure injection

| Area | Test | Result | DB evidence |
|---|---|---|---|
| B1 | Network disconnected before checkout → queued → reconnect → drained once | PASS | queued (PENDING, badge, provisional stock 96→95, DB unchanged); reconnect → drained in 1350 ms with exactly 1 `complete_sale` call; `sales` 4→5, stock 95, key row actor cashier A; sale `…-0005`. |
| B2 | Network cut after commit, before response | PASS | interceptor let `complete_sale` reach the server (HTTP 200 seen) then dropped the reply; app queued a provisional sale while the key row already existed; replay (1 extra call, same key) returned the original: exactly 1 sale `…-0006`, stock 99→98, 1 SALE_OUT, provisional reconciled. |
| B3 | Prolonged disconnection: 3 sales + shift close queued | PASS | outbox seq [1..4] = 3× `complete_sale` + `close_shift`; replayed in that order (request log + key-row `created_at` order); `sales` 2→5 on the shift; shift closed closing 9000 / variance 0; prod1 95→92, prod2 145→144; receipts unique. Till's expected cash (9000) = server's (0 + 4000 committed + 5000 queued); 0 duplicate rows in the UI list (*failed before the fix in §5*). |
| B4 | Terminated with pending operations → relaunch | PASS | outbox row survived app close + relaunch (same profile), session restored without re-login, drained on boot: `sales` 9→10, key row present, stock 92→91. |
| B5 | Restarted while offline | PASS | relaunched with the Supabase origin cut from the first request: `navigator.onLine=false`, booted from the local mirror (542 products, 10 sales) as cashier A, badges "Offline" + "1 action waiting to sync", POS usable; 4 aborted API attempts during boot; reconnect → drained, `sales` 10→11, stock 90. |
| B6 | Expired/tampered JWT during sync | PASS | access token signature tampered + `expires_at` in the past with a sale queued; reconnect → 1 `grant_type=refresh_token` call, new token (same `session_id`, later `iat`), `complete_sale` sent once with the new token; `sales` 11→12, stock 89, no needs-reauth flag. |
| B7 | Revoked refresh token | PASS | `auth.sessions` deleted (2); reconnect → refresh refused HTTP 400; needs-reauth banner "Your sign-in has expired on the server… (1 waiting)… Sign in again"; `syncState.needs-reauth=true`; queue intact (no sale, no key row); sign in again → drained, `sales` 12→13, flag cleared. *Before the fix in §5 the till bounced to /login and overwrote its local mirror with empty tables.* |
| B8 | Two terminals submit the last unit simultaneously | PASS | prod3 brought to 1 by a manager adjustment (movement); A and B confirmed at the same moment: 1 "Sale recorded", 1 "Checkout failed — Not enough stock available"; `inventory` 0 (never negative), `sales` 13→14; both cards converged on 0 via Realtime; no queued entries. |
| B9 | API temporarily unavailable (503) → backoff → recovery | PASS | `complete_sale` answered 503 twice (online attempt + 1 replay); entry pending/transient attempts=1 with `nextAttemptAt` (backoff); release → drained in 44 s, 3 calls total; exactly 1 sale (14→15), stock 87, 1 key row. |
| B10 | Database unavailable then restored — **SIMULATED** | PASS | every `/rest/v1` request answered 503 with PostgREST's `PGRST001 "Database connection error. Retrying the connection."` body; **lucashome's `db` container was not stopped**; sale queued, entry transient with that `lastError`; release → drained once, `sales` 15→16, stock 86, 1 key row (59 s end to end). |
| B11 | Realtime disconnected and reconnected | PASS | B's socket cut ~9 s (3 reconnect attempts refused by the proxy): a +2 adjustment during the cut was not shown (card 144, DB 146); socket released → realtime-js reconnected and `postgres_changes` re-confirmed after 8.9 s without reload; the next +3 arrived live in 1413 ms carrying the full row → card 149 = DB. See finding F7. |
| B12 | Hosted project untouched | PASS | 0 requests to `*.supabase.co` from either terminal. |

### C. Offline authorisation (details in `offline-authorization-verification.md`)

| Area | Test | Result | DB evidence |
|---|---|---|---|
| C1 | Writes allowed at 11 h, refused at 13 h | PASS | `authCache.cachedAt` 11 h old → offline sale queued; 13 h → checkout refused with the documented message, close-shift refused with the same; queue still 1 entry, PENDING record and cart kept; DB untouched (sales 16, stock 86). *Before the fix in §5 the message shown was the generic "Network error".* |
| C2 | Reads allowed at 23 h, logged out at 25 h; re-auth drains | PASS | 23 h → offline boot signed in, POS visible, badge shows the queued action; 25 h → offline boot lands on `/login`, queue kept; offline sign-in → "Failed to fetch", queue kept; online sign-in → drained (`sales` 16→17, key row, stock 85), `cachedAt` refreshed. |
| C3 | Cashier deactivated while offline → replay rejected | PASS | `users.is_active=false` by SQL; reconnect → replay rejected "Not authenticated" → entry conflict/permanent; no sale, no key row, stock 85; local PENDING sale kept; till logged out; direct replay with the same token → 400. Re-activated; admin on the same till sees "1 sync conflict needs attention" / Needs action, dismisses; cashier signs in again. |

### D. Consistency gate (after each spec)

| After | Result | Evidence |
|---|---|---|
| spec A | PASS | sales=4, payments=1, movements=6; inventory = initial + Σmovements for all 6 QA rows; shifts 2 (0 open); receipt sequence contiguous per shop/day; 0 cross rows real↔QA; shop2 untouched; both outboxes empty. |
| spec B | PASS | sales=16, payments=1, movements=21; ledger balanced; shifts 5 (2 open); receipts contiguous; 0 cross rows; outboxes empty. |
| spec C | PASS | sales=17, movements=22; ledger balanced; receipts contiguous; 0 cross rows; outbox empty. |

Checks: no duplicate sales (same shift + total + identical item lines within 2 s — two different baskets with the same total rung up back to back are legitimate), no duplicate payments/movements (reference+product+type), every sale has one SALE_OUT per line, inventory = seeded + Σ`qty_change`, no negative stock, sale cashier/shop = shift cashier/shop, ≤1 open shift per cashier, receipt `NNNN` unique and 1..n per shop/day, no QA shop × real product (or vice versa) rows, no QA actor rows in real shops, outbox has no pending entry.

## 3. Cleanup (after the final run)

`npm run e2e:cleanup` = `cleanup.sql` → `audit_purge.sql` → `verify_clean.sql`:

```
cleanup.sql: refund_void_requests 0 · reprint_logs 0 · sale_items 17 · sales 17 · shifts 5 ·
  inventory_movements 22 · stock_transfer(_items) 0 · inventory 6 · supplier_payments 1 ·
  purchase_order_items 1 · purchase_orders 1 · supplier_products 0 · suppliers 1 ·
  product_image_upload_sessions 0 · product_unit_prices 0 · product_barcodes 1 · price_tiers 0 ·
  product_units 3 · products 3 · audit_logs 33 · idempotency_keys 33 · users 5 · shops 2 ·
  organizations 1 · auth.users 5
audit_purge.sql: auth.audit_log_entries before total=74 qa=74 other=0 → deleted 74 → after total=0
verify_clean.sql: CLEAN  (now also checks auth.mfa_challenges orphans and @qa.invalid audit rows)
storage files on disk: 575 before, 575 after (574 storage.objects + .gitkeep); no flow uploads an image
```

Post-cleanup sweep: `auth.users` 10 (all real), `auth.audit_log_entries` 0,
`auth.flow_state` 0, `auth.one_time_tokens` 0, `auth.mfa_challenges` 0,
`auth.mfa_factors` 2 (real users'; 0 for @qa.invalid), `auth.sessions` 0,
`realtime.subscription` 0, `idempotency_keys` 0, `users` 3, `organizations` 1;
10/10 containers healthy; `/tmp` on the host and in the `db` container holds no
`qa-*`/SQL files (a stale `/tmp/verify_clean.sql` from the Phase D run was
removed). Three intermediate tenants used while developing the suite were
removed the same way (each run ended `CLEAN`).

## 4. Gate (final state of the working tree)

```
npx tsc -b                      → OK (no output)
npm run build                   → ✓ built in 2.29s (chunk-size warnings only, pre-existing)
npm test                        → Test Files 66 passed | 1 skipped · Tests 685 passed | 16 skipped
                                  (682 before; +3: localWrites.test.ts, errors.test.ts, saleSlice.offline.test.ts)
npx eslint e2e playwright.config.ts electron/main.cjs src/stores src/lib/errors.ts
  src/lib/errors.test.ts src/pages/UsersPage.tsx src/app/routes
                                → 0 errors, 1 warning (pre-existing unused eslint-disable in src/lib/errors.ts)
npm run lint (whole repo)       → fails on src/lib/zawgyi.ts (24 pre-existing no-misleading-character-class
                                  errors, untouched by this work; confirmed failing on the stashed baseline)
```

No TypeScript strictness was weakened; no `ts-ignore`/`eslint-disable` was added to silence anything.

## 5. App defects found (all fixed, tests/tsc/lint green)

| # | Defect | Where | Fix |
|---|---|---|---|
| F1 | **Silent print never reported failure.** `webContents.print()` is callback-based and returns `void`; `await`-ing it made `printReceipt` reply `{ok:true}` with no printer, so the documented fallback to the print dialog never fired and the cashier got "printing…" with nothing printed. | `electron/main.cjs:332-347` | resolve from the `(success, failureReason)` callback → `{ok:false, error:"No printers available on the network"}` → `src/lib/print.ts` falls back to `window.print()` (A3 evidence). |
| F2 | **A write made during an in-flight full load was lost from the UI.** With the cache fast path the shell is usable ~1.5 s after login while the 27-table load is still running; a shift opened / sale rung up in that window was replaced by the stale snapshot (and persisted over in the mirror). Reproduced: "No Shift" on the POS although `shifts` had the row. Sales are not delta-synced, so such a sale would stay hidden until the next full reload. | `src/stores/data/localWrites.ts:31-105`, `src/stores/data/index.ts:85-95,125,197` | every `putLocalRows`/`deleteLocalRows` during a load is recorded (per in-flight load) and re-applied on top of the snapshot; unit test `localWrites.test.ts`. |
| F3 | **Two full loads ran concurrently at login** (StrictMode double effect in dev; in general any two callers in the same tick), because `isLoading` is only raised after the cache read `await`; the second load's stale snapshot won. | `src/stores/data/index.ts:85-96,284` | concurrent `loadData()` calls share one in-flight promise. |
| F4 | **Revoked session during a full load emptied the till.** supabase-js drops the session on a refused refresh; the 27 reads then went out anonymously, RLS returned empty tables, the store rendered them (bounce to `/login`) and `persistSnapshotToLocal` overwrote the offline mirror with empty data. The documented needs-reauth banner never appeared on this path. | `src/stores/data/index.ts:127-139,189-194,286-296`, `src/stores/data/outbox.ts` (`setNeedsReauth` exported) | the load checks `getSession()` before and after the reads; with no session it applies nothing and sets the needs-reauth flag → banner (B7 evidence). |
| F5 | **Offline-window refusal shown as "Network error".** `getErrorMessage()` maps any error to the generic network text while `navigator.onLine` is false, hiding the documented "offline for more than 12 hours…" message. | `src/lib/errors.ts:27,298-300`, `src/stores/authStore.ts:293-316` | the gate throws `OfflineAuthorizationError` (named), which the mapper shows verbatim; unit test in `errors.test.ts` (C1 evidence). |
| F6 | **Replayed commit-then-lost sale listed twice in the UI**, inflating the shift's expected cash. The reconnect reload already contained the committed sale plus the still-queued provisional row; `reconcileCompleteSale` removed the provisional and prepended the server row again (no de-dupe by id; the mirror is keyed so it was unaffected). Same pattern in the adjust-stock / receive-PO / supplier-payment reconcilers. | `src/stores/data/slices/saleSlice.ts:343-358`, `inventorySlice.ts:151-158`, `purchaseSlice.ts:390-395,440-446` | drop existing rows with the authoritative ids too; regression test in `saleSlice.offline.test.ts` (B3 evidence: till 9000 = server 9000, 0 duplicates). |
| F8 | **Route guards bounced a valid sign-in to `/login`.** The store renders the previous user's cached `users` view first; if the new user is not in it (another shop's cashier, or an account re-activated after being hidden by RLS), `RequireRole`/`DefaultAppRoute` redirected before the network load landed (first sign-in attempt "did nothing"). | `src/app/routes/guards/RequireRole.tsx:17-24`, `src/app/routes/AppRouter.tsx:81-85` | show the loading fallback while a load is in flight instead of redirecting (C3 evidence). |
| F9 | **Users page never showed its success message** — `resetForm()` cleared the feedback it had just set. | `src/pages/UsersPage.tsx:202-208` | reset first, then show "… created. They can now log in with …" (A6 evidence). |

Observations (not fixed, documented):

| # | Observation |
|---|---|
| F7 | A Realtime-only outage (socket down, HTTP fine) is not caught up on rejoin: changes made while the channel was down stay stale until the next event for that row or the next full reload (`pullDeltas` does not cover `inventory`). B11 shows the +2 missed during the cut and the +3 arriving afterwards with the full row. **Fixed in Phase G** (`../phase-g/realtime-reconciliation.md`): the client re-reads the shop's rows on every rejoin and on the periodic pull while the channel is down; new scenario B11b (not yet run). |
| F10 | Multi-tenant scoping is not enforced (known, Phase D §"Residual facts"): the QA ADMIN's shop switcher lists the real shop and the POS grid shows real products; `users` rows with role ADMIN are readable by every authenticated user. The suite never selected the real shop (consistency gate: 0 cross rows). |
| F11 | The sidebar's logout navigates to `/login` without awaiting the async sign-out; the harness waits for the stored session to disappear before the next sign-in (a human cannot sign in within the ~100 ms window). |

## 6. Incident outside the suite (hosted project)

While debugging, two throwaway probe scripts were run against a Vite instance I
had started by hand **without** the key-loading wrapper; it fell back to the
repo's `.env.local` and the probes signed in to the **hosted** project with the
QA admin e-mail. The app's login code calls `auth.signUp()` when a password
sign-in fails, so the hosted project most likely gained one auth user
`qa-admin-1791782177708@qa.invalid` (two `login` audit rows; no `users` row —
the app signed it out as an orphan; no data written). I did not touch the
hosted project to undo it; **the owner should delete that auth user in the
hosted dashboard.** Afterwards the suite got two hard guards (dev-server target
check in `global-setup`, `*.supabase.co` abort in every terminal) so this
cannot recur from the suite.

## 7. Not automated / done instead

- Printing on real hardware: no printer exists here; the IPC result and the
  fallback are verified (A3), the native dialog is stubbed.
- Database outage: simulated at the PostgREST boundary (B10); lucashome's
  database was not stopped, by rule.
- Lint of the whole repo is red on `src/lib/zawgyi.ts` (pre-existing).

## 8. Running it again

See `e2e/README.md`: keys into the shell only, `npx playwright test`, then
`npm run e2e:cleanup`. `E2E_QA_TS=<ts>` re-uses a seed (the admin's TOTP secret
is read back from `auth.mfa_factors`).
