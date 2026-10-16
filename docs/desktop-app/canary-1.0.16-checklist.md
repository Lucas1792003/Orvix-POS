# Real-device canary checklist — POS 1.0.16 (one till + one phone per shop)

Private. Prepared 2026-10-16. Run **shop by shop**, never both at once. Record every line as PASS / FAIL with time (UTC), device and initials in the table at the end. **Any FAIL stops the canary** at that shop; nothing else changes until the engineer has looked at it.

Supersedes the acceptance part of [`../selfhost-migration/next-phase/electron-1.0.16-canary.md`](../selfhost-migration/next-phase/electron-1.0.16-canary.md) §R11. Its §R7 ("rollback build 1.0.17 pointing at hosted") is **withdrawn**: a till is never redirected to hosted Supabase (owner rule).

## 0. Preconditions (engineer + owner, before travelling to the shop)
- [ ] Server: schema 085, 084 **not** applied, `backup-status.sh` OK, a verified base backup taken the same day and its recovery point recorded.
- [ ] Release candidate built from the frozen commit, hashes recorded in [`release-1.0.16.md`](release-1.0.16.md); installer copied to a USB stick (no public release yet).
- [ ] The shop's 1.0.15 till is **fully synced** to hosted and closed (sidebar shows no pending actions) — the 1.0.15 updater has no guard.
- [ ] Owner decides how canary sales are recorded (recommended: a product named `CANARY TEST` priced 1 MMK, every canary sale refunded the same day through the normal refund flow, noted in the shift).
- [ ] Remote-access path for this canary agreed (today: Tailscale on the till and phone — see the compliance note in [`../selfhost-migration/phase-f/remote-access-architecture.md`](../selfhost-migration/phase-f/remote-access-architecture.md)).
- [ ] Owner has the queue-export passphrase rule ready (≥ 10 characters, written down for this canary only).

## 1. Install / upgrade and identification
- [ ] 1.1 Install 1.0.16 from the USB stick (or over 1.0.15). Windows SmartScreen warning is expected (unsigned) — "More info → Run anyway".
- [ ] 1.2 First start: login/sidebar shows **version 1.0.16**, backend **the self-hosted origin**, capability **validated uploads: yes**. Photograph it.
- [ ] 1.3 If the till had 1.0.15 data: any old pending entries are shown as **quarantined** (not synced) with an Export prompt — export them before continuing; cached hosted sign-in is gone (re-login required).
- [ ] 1.4 Note the till id (About screen) in the till register ([`../selfhost-migration/phase-f/till-readiness-084.md`](../selfhost-migration/phase-f/till-readiness-084.md)).

## 2. Authentication and MFA
- [ ] 2.1 Owner (ADMIN) signs in with password + authenticator code (TOTP). Wrong code is refused.
- [ ] 2.2 Cashier signs in (no second factor) and lands on Point of Sale.
- [ ] 2.3 Owner creates a throwaway CASHIER on the Users page → it signs in → owner deactivates it → it can no longer sign in.
- [ ] 2.4 Sign out / sign in again works; no "sign up" option exists anywhere.

## 3. Inventory and barcode scanning
- [ ] 3.1 Product list and stock match what the owner expects for this shop (spot-check 5 products).
- [ ] 3.2 Scan 3 real barcodes with the shop's scanner → correct product added each time.
- [ ] 3.3 Edit one product (price only) and save → its barcode still works afterwards (regression of the barcode-loss fix).
- [ ] 3.4 Manager stock adjustment on `CANARY TEST` (+5) → stock shows +5 on the till and on the server.

## 4. Uploads
- [ ] 4.1 Desktop image upload on `CANARY TEST` from the till → image appears; reload shows it.
- [ ] 4.2 Phone: "Use phone camera" QR → phone opens the page (must start with the self-hosted origin `/functions/v1/phone-upload-page#`) → take a photo → wait > 60 s before uploading once → desktop shows "Upload received" → image saved.
- [ ] 4.3 Phone: choose a PNG screenshot from the gallery → accepted.
- [ ] 4.4 Phone: try a PDF or a non-image file → refused with a clear message; nothing saved.
- [ ] 4.5 Press Escape / click outside the QR window while waiting → it asks "Stop this phone upload?" → "Keep waiting" keeps it open.

## 5. Offline sales, reconnection, idempotent sync
- [ ] 5.1 Open a shift. Online sale of `CANARY TEST` → receipt prints; sale visible on the server.
- [ ] 5.2 Unplug network / turn Wi-Fi off. Ring up 2 offline sales (same basket twice). Badge shows "2 actions waiting to sync".
- [ ] 5.3 Close the app while offline, reopen it offline → the 2 entries are still there → **Export pending** produces an `.spqx` file (keep it on the USB stick).
- [ ] 5.4 Reconnect → both entries drain within ~2 minutes → exactly **2** new sales on the server (engineer checks the ledger: one sale per idempotency key, no duplicates), stock reduced by 2.
- [ ] 5.5 Refund all canary sales through the normal refund flow; close the shift with the counted cash.

## 6. Update guard and recovery
- [ ] 6.1 With 1 pending offline entry, start the provided 1.0.16-test-update installer (engineer-built, never published) → the update is **not** installed; the app says sales are waiting; Export is offered.
- [ ] 6.2 Reconnect → entry syncs → the update then installs → the entry is not duplicated.
- [ ] 6.3 Recovery drill (engineer, from the Mac): `tools/queue-recovery` `inspect` on the exported file from 5.3 shows the 2 entries with their original idempotency keys; a `replay --dry-run` against the self-hosted origin reports them as **already applied** (no new sales).

## 7. Server-side checks (engineer, read-only, same day)
- [ ] 7.1 Business-data fingerprint: only the canary rows changed (sales/refunds/stock movements/upload sessions/audit entries for `CANARY TEST`, the throwaway cashier).
- [ ] 7.2 `deploy/lucashome/verify-till-readiness.sh`: this till shows **validated uploads seen** (from 4.1) and no direct staff uploads.
- [ ] 7.3 Zero requests from the till to `*.supabase.co` (Tailscale/DNS log or the app's network log).
- [ ] 7.4 Backup taken after the canary; recovery point recorded.

## 8. Stop / rollback rules
- Any FAIL → stop; keep the till on 1.0.16 **only if** sales can continue safely; otherwise use paper and export the queue first. **Never** install 1.0.15 on a till that has 1.0.16 data, and never point a till at hosted.
- Server problem → [`../selfhost-migration/phase-g/emergency-recovery-runbook.md`](../selfhost-migration/phase-g/emergency-recovery-runbook.md).
- Real sales start at a shop only after **all** lines pass there, the second shop's canary has passed, and the email off-server backup is live.

## Record
| Shop | Device | Line | Result | UTC time | By | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
