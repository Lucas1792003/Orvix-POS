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
