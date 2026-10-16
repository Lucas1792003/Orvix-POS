# Desktop app — incidents and defects fixed

Newest at the top. All on branch `feature/selfhost-supabase-migration`. None of these fixes is released yet (they ship with 1.0.16). Details: [`../selfhost-migration/phase-f/app-bugfixes.md`](../selfhost-migration/phase-f/app-bugfixes.md).

## 2026-10-16 — D300: phone told "cancelled on the computer" with no desktop step (near-miss, e2e)
- **Symptom:** one e2e run, phone upload at +300 s; the session row was CANCELED, which only the desktop's cancel RPC sets.
- **Root cause (most likely, not proven):** a real input event in the visible Electron window (Escape, a backdrop click or a drag ending outside the dialog) — the modal turned each into an immediate, silent cancel. App-internal causes ruled out by the phone-modal harness.
- **Fix:** Escape / backdrop now ask "Stop this phone upload?"; backdrop closes only if the press started on it; every close while PENDING logs a `[phone-upload] close requested trigger=…` line collected by spec D (commit `e467d21`, merged `967a941`); vitest 971, harness 12/12; 7 later D300 runs passed.
- **Lesson:** destructive actions must not hang off implicit dismiss gestures; keep a trigger log for anything that changes server state.

## 2026-10-15 — Product save deleted barcodes the user never touched
- **Symptom:** e2e spec D's product edit removed the seeded barcode; in a shop, editing price/name/photo could silently delete a barcode.
- **Root cause:** the form showed a default-unit barcode only when stored with `product_unit_id = NULL`, and the save deleted every barcode then re-inserted what the form showed.
- **Fix:** load both shapes, save as a diff of what was loaded (`productBarcodeForm.ts`, commit `3034889`).

## 2026-10-15 — Desktop QR modal stopped polling after one failed request
- **Symptom:** one failed status poll (blip, 502, 429) showed "Upload failed / expired" and stopped; a later successful phone upload was never shown (likely cause of the earlier D65 failure).
- **Fix:** `uploadStatusPoller.ts`: one request at a time, transient errors retried with backoff (commit `664c371`). e2e then 44/44 ×3 (`f8b1281`).

## 2026-10-14 — e2e specs depended on run order
- **Symptom:** specs passed only in the default order (shared shifts, stock, barcode state; non-deterministic `closeShift`).
- **Fix:** each spec owns its shift/stock/barcode, deterministic close (commit `3da7ddb`); later order-related test bugs (A3 receipt day bucket, D-race PUT count) fixed in `ddad081`, `909f146`; verified with a reverse-order run 44/44.
- **Lesson:** run the suite in reverse order before trusting a green run.

## 2026-10-12 — Failed login created an account (root cause of the hosted incident)
`login()` called `signUp()` after any failed password sign-in. Removed; first-admin setup is the explicit `/setup` page. See [`../hosted-supabase/incidents.md`](../hosted-supabase/incidents.md).

## 2026-10-12 — Realtime gap left stock stale
After a socket drop the channel rejoined but missed changes were never fetched. Fixed: server-authoritative inventory refresh after any gap; E2E B11b.

## 2026-10-12 — Defects found by the Electron E2E run (Phase E)
Silent print always reported success with no printer; a write during an in-flight load was overwritten; two concurrent full loads at login; revoked session mid-load overwrote the offline mirror; 12-hour offline refusal shown as "Network error"; commit-then-lost-response replay listed the sale twice; route guards bounced a fresh sign-in; Users page success message cleared. All fixed with tests (commit `293fdf4`).

## 2026-10-12 — Duplicate sale on commit-then-timeout; queue stranded on flaky links (Phase D)
No idempotency key; resolved fetch errors marked as permanent conflicts; offline window measured from boot; snapshot persistence cleared the outbox; queue ordering ties. Fixed with server idempotency (062–063) and client outbox rework; live suite 16/16.

## 2026-10-12 — Type-check failed at baseline
Dexie 4.4.5 type wrapper self-reference under `moduleResolution: bundler`, plus three typing errors. Fixed via `tsconfig.app.json` `paths` and typed rows; builds were blocked before this.
