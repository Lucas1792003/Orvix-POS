# Phase F · App bug fixes found by the e2e suite

Status 2026-10-15: fixed, not yet released. No schema change, no server
change.

## Bug 1 · Product save deleted barcodes the user never touched

**Symptom.** Spec D saves QA Product One through the product edit form; its
seeded barcode disappeared. Every scanning spec restored it as a workaround.
In a real shop, staff editing a product (price, name, photo) could silently
delete its barcode, so the next scan says `Barcode not found`.

**Cause.** Two things combined:

1. The form loaded a default-unit barcode only when it was stored with
   `product_unit_id = NULL`. A barcode bound to the default unit by id (the
   seed, older imports; POS scan, CSV import and the label page's docs treat
   it as the default unit's barcode) showed as an empty field.
2. The save deleted *every* barcode of the product and re-inserted what the
   form showed: `updateProduct(product, [])` deleted all rows, then
   `replaceProductBarcodes` deleted all again and inserted the form's values.
   So any barcode the form did not show was lost, including a second
   barcode on one unit.

**Fix.**

- `src/features/catalog/productBarcodeForm.ts`: `loadUnitBarcodes` shows a
  default-unit barcode in either shape (exact unit-id match first);
  `planProductBarcodeSave` diffs the form against what it loaded. Unchanged
  fields write nothing; an edited or cleared field replaces or deletes only
  the row it showed; a value moved from another row of the same product
  deletes that row first (no unique-index clash). Rows the form never showed
  are never touched. One exception: when the user changes which unit is the
  default, a unit-less row is re-linked to its old unit so the barcode does
  not move to the new default.
- `productSlice`: `updateProduct(product)` with no barcode list leaves
  `product_barcodes` alone. The CSV import still passes its full list.
  `replaceProductBarcodes` is replaced by `applyProductBarcodeChanges(productId,
  {deleteIds, inserts})`, which deletes only the named ids (and only for this
  product), then inserts.
- `src/features/barcodes/labels.ts`: the label for a default unit uses a
  unit-linked default barcode instead of falling back to the SKU.

**Tests.** `productBarcodeForm.test.ts` (12),
`productSlice.barcodes.test.ts` (4; 3 fail on the old code, including
"updateProduct without a barcode list does not touch product_barcodes"),
`labels.test.ts` +1 (fails on the old code). In e2e, `ensureQaBarcode`
(restore) became `assertQaBarcode` (check only) in A, B, C and F. Spec D
asserts before each product save that the form shows the barcode, and after
it that the row is unchanged (same id, unit, value and type). D's `afterAll`
restore is gone.

## Bug 2 · Desktop QR modal stopped polling after one failed request

**Symptom.** With the QR open, one failed status request (network blip,
proxy 502, 429) switched the modal to "Upload failed / expired" and polling
stopped for good. A phone upload that then succeeded was never shown. This is
the likely cause of the unexplained D65 failure.

**Cause.** `ProductImagePhoneUploadModal` set phase `FAILED` in the poll's
`catch`, and the polling effect only ran while phase was `PENDING`. It also
used `setInterval`, so slow requests could overlap.

**Fix.** `src/lib/uploadStatusPoller.ts` (`startUploadStatusPolling`):

- One request at a time, every 2 s while `PENDING`.
- Transient errors are retried with backoff (2, 4, 8 s, then capped at
  15 s). Transient means: no response or a timeout (15 s per request), 5xx,
  408, 425, 429, 401, or "Not authenticated"/JWT expired while the auth
  session refreshes. Retry-After is honoured, capped at 60 s.
- Retries end at the session's `expiresAt` + 10 s grace, with one last
  attempt at that point. If that attempt fails too, the modal shows
  "Upload failed / expired" with "The upload link expired while the
  connection was lost."
- Polling stops on `COMPLETED`, `EXPIRED` and `CANCELED`, and on permanent
  errors: the RPC's `Upload session not found` (400), 404, and any other 4xx.
- While retrying, the modal shows a small "Connection problem,
  reconnecting..." line. It never stalls without saying so.
- `getProductImageUploadSessionStatus` is now a plain `fetch` to the same
  `/rest/v1/rpc/get_product_image_upload_session_status` endpoint, with the
  user's JWT. supabase-js does not expose the HTTP status or the Retry-After
  header, and the poller needs both. Every failure is an
  `UploadStatusRequestError` (`httpStatus` 0 means no response).
- The effect depends only on `[open, session]`. `onUploaded` goes through a
  ref, so a parent re-render no longer restarts polling.

**Tests.** `uploadStatusPoller.test.ts` (20, fake timers). It covers the
normal cadence, each terminal status, network error then recovery, each
retried 5xx/408, the backoff cap, 429 with and without Retry-After,
not-found (400 and 404) stopping, auth refresh retried, the expiry deadline
with its last attempt, Retry-After cut to the deadline, and stop.
`productImagePhoneUpload.statusPoll.test.ts` (7) covers the transport: the
request shape, network error, timeout, a 502 HTML page, 429 + Retry-After,
the not-found RPC error, and unreadable vs `null` bodies. The spec-D failure
diagnostic now also reports whether "reconnecting" was showing.

## Suite stability (2026-10-15/16, self-hosted stack, `E2E_PHONE_PAGE=deployed`)

| Run | Order | Result | Duration | Cleanup |
|---|---|---|---|---|
| final 1 | normal | 44/44 | 24.7 m | CLEAN, 574 objects (575 files incl. `.gitkeep`) |
| final 2 | normal | 44/44 | 24.3 m | CLEAN, same |
| final 3 | reverse | 44/44 | 24.7 m | CLEAN, same |

Earlier attempts that failed, and what was done (each one restarted the count):

- **D300** (normal order): at +300 s the phone was told "cancelled on the
  computer". The session row was CANCELED, and only the desktop's cancel RPC
  sets that (it runs when the modal is closed while PENDING: Close, X,
  Escape or a backdrop click). No test step does any of these. External
  input to the visible Electron window is the likely cause, but this is not
  proven. Spec D now records the phone message, session row, desktop modal
  status, its create / cancel / status requests and a desktop screenshot
  whenever the phone does not finish. 7 later D300 runs passed.
- **A3** (reverse order): the receipt was `…-20261016-0023`, not `-0026`.
  Receipt numbers restart per shop per receipt day. The run crossed 00:00
  UTC with F/C/B sales before it, and A3 had assumed "all shop sales + 1".
  It now checks the receipt against its own day bucket. Test bug.
- **D-race** (reverse order): 3 PUTs, not 2, all 200 or duplicate, with
  every invariant intact (one object, one completion, both calls
  COMPLETED). The phone client retries a PUT once with a fresh token after
  a transport failure, by design. The test now asserts that contract
  (invariants first, 2 to 4 PUTs, no unexplained PUT failure, no more PUTs
  than issued tokens) and records every PUT. Isolated, it passed 6 of 6
  (200+200 three times, 200+409 three times).

## D300 analysis · "cancelled on the computer" with no desktop step (2026-10-16)

Local investigation only: code reading, unit tests and a real-browser harness
against a mocked loopback backend. Nothing was run against the self-hosted
stack or the hosted project.

### Every path that cancels a phone-upload session

The server sets `CANCELED` in one place only: `cancel_product_image_upload_session`
(019; `created_by = caller AND status = 'PENDING'`). No later migration, edge
function or sweep writes `CANCELED` to `product_image_upload_sessions`. The
phone page shows "cancelled on the computer" for any status other than
PENDING, COMPLETED or EXPIRED (`phaseForStatus` in `client.js`), but the D300
row really was `CANCELED`. Client callers of the RPC:

1. `ProductImagePhoneUploadModal`: the only caller for a QR session. Before
   this fix it cancelled from `handleClose` whenever the session was PENDING.
   `handleClose` was reached from:
   - the footer **Close** button;
   - the header **X** button;
   - **Escape**: a `keydown` listener on `window` (`Modal.tsx`), with any
     focus target, trusted or synthetic, and no IME check;
   - a **backdrop click**: `onClick` with `target === currentTarget`. A click
     event targets the common ancestor of mousedown and mouseup, so pressing
     inside the dialog and releasing outside it (a text-selection drag) also
     counted.
2. `uploadProductImage` (`productImageStorage.ts`, the desktop file-picker
   path). It cancels only the session it created itself, after a bad path or
   a failed upload. It never knows a QR session's id.

There was **no** cancel on unmount, in an effect cleanup, on route change, on
blur, focus or visibility change, in the status poller, on auth refresh or in
the realtime handlers. The session id lives only in the modal's state, and the
phone page has no cancel call.

### Remount and timing paths checked (none can cancel)

- `AppLayout`: a refresh on focus or visibility and every 120 s (`pullDeltas`),
  an outbox tick every 30 s, `onAuthStateChange` (SIGNED_IN /
  TOKEN_REFRESHED, which only drains the outbox), realtime inventory rows
  (store updates). These re-render the product form but do not remount it.
  `isLoaded` going false ("Loading data…") or a viewport under 768 px would
  unmount the modal. That loses the modal but cancels nothing, and the phone
  still finishes.
- The modal is keyed on nothing. Polling is keyed on `[open, session]` and
  `onUploaded` goes through a ref, so a new parent callback restarts nothing.
  The create effect re-runs if `productId` or `currentShopId` changes. That
  makes a new QR and leaves the old session PENDING (not cancelled). It is a
  minor issue of its own: the desktop then polls the new session.
- Time: `getSecondsLeft` is display only. The poller ends at expiry (10 min)
  with EXPIRED, not CANCELED. Nothing changes at 300 s.
- StrictMode double effects: the create effect's cleanup only sets
  `active = false`.

Harness evidence (`npm run test:phone-modal`, i.e.
`tools/phone-modal-harness/run.mjs`): the real `ProductImageInput` and modal
under StrictMode in headless Chromium, with Playwright's fake clock and every
backend request answered by a mock on `127.0.0.1:59999` (any other host fails
the run). On the **unfixed** code:

| Scenario | cancel RPCs |
|---|---|
| 300 s, re-render every 1 s, blur/focus/visibilitychange every 20 s, mouse moves and wheel every 30 s | 0 |
| 300 s, re-render every 50 ms | 0 |
| unmount at +100 s, remount, re-key | 0 |
| Close / X | 1 (expected) |
| Escape (trusted) | 1 |
| Escape dispatched by script (`isTrusted=false`) | 1 |
| click on the backdrop | 1 |
| press inside the dialog, release on the backdrop | 1 |

### Root cause (most likely), and what is still uncertain

App-internal causes are ruled out: no re-render, remount, timer, focus or
auth path can call the RPC. So the cancel came from a real input event in the
visible Electron window (1366x768, shown and focused by `main.cjs`, not
headless; the phone browser is headless and takes no focus). That was an
Escape key, a click anywhere on the dimmed area outside the dialog, or a drag
that ended there, during the 5-minute idle wait of a 25-minute run on a
workstation in use. Playwright sends no input to the desktop during that
wait. The modal made each of these an immediate, silent cancel. Not proven:
the original run kept no cancel timestamp or trigger, and the 7 later D300
runs passed.

### Fix (UX hardening, server and security unchanged)

- `lib/phoneUploadClose.ts`: `decidePhoneUploadClose`. While a session is
  PENDING, the explicit buttons (footer Close, header X, and "Stop upload")
  cancel and close as before. **Escape and a backdrop click now only show
  "Stop this phone upload?"** with "Keep waiting" (focused) and "Stop upload".
  With nothing pending, every trigger just closes. Unmounting never cancels:
  the server expires the session.
- `Modal.tsx` (all modals): the backdrop closes only when the press also
  started on the backdrop (`isBackdropDismiss`), so a drag out of the dialog
  no longer closes anything. Escape is ignored during an IME composition.
  `onClose` now receives the reason (`escape` / `backdrop` / `x-button`) and
  `isTrusted`. Existing callers ignore them.
- The cancel RPC, its rules and the session lifetime are untouched. The user
  can still cancel at any time. An abandoned QR expires on the server as
  before.

### Diagnostics

- Every close request while PENDING logs one console line:
  `[phone-upload] close requested trigger=<close-button|x-button|confirm-stop|escape|backdrop|unmount> decision=<cancel+close|confirm|close|none> phase=… session=...<last 6> shown=+Ns left=Ns trusted=… visibility=… focus=…`
- `Terminal.phoneUploadMarkers` / `phoneUploadMarkersSince()` (e2e) collects
  these lines. Spec D puts them in the "phone did not finish" and "desktop
  did not show the upload" diagnostics, with whether the stop confirmation is
  showing. It records them as INFO on a passing D30–D300 case too, and
  D-cancelled asserts `trigger=close-button decision=cancel+close`. A
  recurrence now names its trigger and its timing. An Escape or a stray
  click no longer fails D300; it shows up as an INFO line.

### Tests

- `src/lib/phoneUploadClose.test.ts` (10 tests): the decision table, 300 s
  of repeated implicit dismissals under fake timers (never a cancel), the
  marker format, the backdrop and Escape rules, and a source guard. The guard
  checks that the modal calls the RPC in exactly one place, inside
  `requestClose` behind `decision.cancel`, and that all `Modal` close reasons
  go through it. The repo has no jsdom or Testing Library and none was added,
  so component behaviour is covered by the harness.
- Harness on the fixed code: 12/12 PASS. That covers the scenarios above (0
  cancels; Escape, synthetic Escape and backdrop raise the confirmation; the
  drag does nothing), plus Close and X (1 cancel each), Escape then "Stop
  upload" (1), Escape then "Keep waiting" then 270 s (0), unmount (0, with an
  `unmount` marker), and "COMPLETED then Escape" (closes, 0).
- `npx tsc -b`, `npx tsc -p e2e/tsconfig.json`: clean. `npx vitest run`:
  971 passed (baseline 961). Spec D was not run here (it is a live suite).
