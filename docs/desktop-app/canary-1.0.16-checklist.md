# Real-device canary checklist — POS 1.0.16 (one till + one phone per shop)

Private. Prepared 2026-10-16; **revised 2026-10-16 for RC1 (b777345): non-destructive — no real sales, no real stock, no real staff or product edits.** Run **shop by shop**, never both at once. Record every line as PASS / FAIL with time (UTC), device and initials in the table at the end. **Any FAIL stops the canary** at that shop; nothing else changes until the engineer has looked at it.

Supersedes the acceptance part of [`../selfhost-migration/next-phase/electron-1.0.16-canary.md`](../selfhost-migration/next-phase/electron-1.0.16-canary.md) §R11. Its §R7 ("rollback build 1.0.17 pointing at hosted") is **withdrawn**: a till is never redirected to hosted Supabase (owner rule).

## Test data rule (applies to every line)
Everything the canary writes is tagged and identifiable; nothing else may change.

| What | Exact value | Why |
|---|---|---|
| Product | name `CANARY TEST <yyyymmdd>`, SKU `CNRY-<yyyymmdd>-01`, barcodes `CNRY-<yyyymmdd>-01` and `CNRY-<yyyymmdd>-02` (printed Code 128 labels), price 1 MMK, no category/brand of real goods | the only product the canary sells, adjusts, edits or photographs |
| Cashier | name `CANARY CASHIER <yyyymmdd>`, role CASHIER, the canary shop, an e-mail the owner controls (never a real staff member's) | opens the canary shift and rings up every canary sale |
| Shift | opened by the CANARY cashier, opening cash 0; variance reason `CANARY` | keeps canary cash out of every real shift |
| Refunds | reason `CANARY refund`; requested by the CANARY cashier, approved by the owner (no self-approval) | |
| Receipts | show `CANARY TEST …` as the only line (sales have no free-text note field; the product name is the tag) | |
| Upload sessions / images | only on the CANARY product | |

The POS stores no customer records; the canary must not edit `business_profile` (receipt header), shops, real products, real staff, prices or stock of anything else. **Note:** receipt numbers are a per-shop, per-day count (`complete_sale`, migration 045: `count(*)` of the shop's sales that day + 1). Canary sales take the first numbers of that day at that shop; real sales that day continue after them. That is expected and is one reason the canary rows are kept (§9).

## 0. Preconditions (engineer + owner, before travelling to the shop)
- [ ] 0.1 Server: schema 085, 084 **not** applied, `backup-status.sh` OK, a verified base backup taken the same day and its recovery point recorded.
- [ ] 0.2 Release candidate RC1 from the frozen commit (b777345), hashes as recorded in [`release-1.0.16.md`](release-1.0.16.md) §7; installer copied to a USB stick and its sha256 re-checked on the stick (no public release yet; the RC1 artifacts are never rebuilt).
- [ ] 0.3 The shop's 1.0.15 till is **fully synced** to hosted and closed (sidebar shows no pending actions) — the 1.0.15 updater has no guard. Record `pending_before_upgrade_1015` = 0 in the till register ([`../selfhost-migration/phase-f/till-readiness-084.md`](../selfhost-migration/phase-f/till-readiness-084.md) §2.1). A till with pending > 0 does not start the canary.
- [ ] 0.4 **Tag pre-check + snapshot** (engineer, read-only, the same hour as the canary starts): run [`canary-1.0.16-fingerprint.sql`](canary-1.0.16-fingerprint.sql) with `win_start = win_end = <now>` and keep the output as `canary-<shop>-before.txt` (private evidence). It must show `meta:canary ids|0`, and every `public.*` line `…|<n>|0|…` (zero canary rows): no existing row may already contain `CANARY` or `CNRY-`. If one does, pick another tag and update this table first.
- [ ] 0.5 Remote-access path for this canary agreed (today: Tailscale on the till and phone — see the compliance note in [`../selfhost-migration/phase-f/remote-access-architecture.md`](../selfhost-migration/phase-f/remote-access-architecture.md)).
- [ ] 0.6 Owner has the queue-export passphrase rule ready (≥ 10 characters, written down for this canary only, never in the register).
- [ ] 0.7 Record the canary window start (UTC) in the Record table.

## 1. Install / upgrade and identification
- [ ] 1.1 Install 1.0.16 from the USB stick (or over 1.0.15). Windows SmartScreen warning is expected (unsigned) — "More info → Run anyway".
- [ ] 1.2 First start: login/sidebar shows **version 1.0.16**, backend **the self-hosted origin**, capability **validated uploads: yes**. Photograph it.
- [ ] 1.3 If the till had 1.0.15 data: old entries are shown as **quarantined** (not synced) with an Export prompt. With 0.3 passed there should be none; if any appear, **stop**: export them, record `quarantined_count` and the file name in the register, and do not continue the canary on this till until the owner has reconciled them (register rule §2.1).
- [ ] 1.4 Note the till id exactly as shown (sidebar footer, the line under the version, tooltip "Till id: …"; also the login page) in the till register with `installed_version`, `os`, `updated_utc`, `pending_after_first_start_1016`, `quarantined_count`.

## 2. Authentication and MFA
- [ ] 2.1 Owner (ADMIN) signs in with password + authenticator code (TOTP). Wrong code is refused.
- [ ] 2.2 Owner creates the cashier `CANARY CASHIER <yyyymmdd>` (test data rule) on the Users page → it signs in (no second factor) and lands on Point of Sale.
- [ ] 2.3 Sign out / sign in again works; no "sign up" option exists anywhere. (Deactivation of the CANARY cashier is tested at the end, 5.7.)

## 3. Inventory and barcode scanning
- [ ] 3.1 Product list and stock match what the owner expects for this shop (spot-check 5 products) — **look only**, change nothing.
- [ ] 3.2 Owner creates the `CANARY TEST <yyyymmdd>` product (test data rule) with both `CNRY-` barcodes.
- [ ] 3.3 Scan the two printed `CNRY-` labels with the shop's scanner → `CANARY TEST` is added each time. Optional scanner check on real goods: scan 3 real barcodes into the cart and **remove every line again** (Clear cart) — never take payment for a real product.
- [ ] 3.4 Edit `CANARY TEST` (price 1 → 2 MMK and back to 1) and save → both `CNRY-` barcodes still scan afterwards (regression of the barcode-loss fix). No real product is edited.
- [ ] 3.5 Manager stock adjustment on `CANARY TEST` (+5, reason `CANARY`) → stock shows +5 on the till and on the server.

## 4. Uploads
- [ ] 4.1 Desktop image upload on `CANARY TEST` from the till → image appears; reload shows it. Record `desktop_upload_session_utc` (§2.1 of the register doc).
- [ ] 4.2 Phone: "Use phone camera" QR on `CANARY TEST` → phone opens the page (must start with the self-hosted origin `/functions/v1/phone-upload-page#`) → take a photo → wait > 60 s before uploading once → desktop shows "Upload received" → image saved. Record `phone_upload_utc`.
- [ ] 4.3 Phone: choose a PNG screenshot from the gallery (not a photo of customers or documents) → accepted.
- [ ] 4.4 Phone: try a PDF or a non-image file → refused with a clear message; nothing saved.
- [ ] 4.5 Press Escape / click outside the QR window while waiting → it asks "Stop this phone upload?" → "Keep waiting" keeps it open.

## 5. Offline sales, reconnection, idempotent sync (CANARY sales only)
- [ ] 5.1 Sign in as the CANARY cashier; open a shift (opening cash 0). Online sale: 1 × `CANARY TEST`, cash 1 MMK → receipt prints (only line `CANARY TEST …`); sale visible on the server.
- [ ] 5.2 Unplug network / turn Wi-Fi off. Ring up 2 offline sales, each 1 × `CANARY TEST`, cash 1 MMK. Badge shows "2 actions waiting to sync".
- [ ] 5.3 Close the app while offline, reopen it offline → the 2 entries are still there → **Export pending** produces an `.spqx` file (keep it on the USB stick; it contains only these canary entries).
- [ ] 5.4 Reconnect → both entries drain within ~2 minutes → exactly **2** new canary sales on the server (one sale per idempotency key; `assert:` lines in §7.1), `CANARY TEST` stock reduced by 2. **Do not** press Dismiss on the Sync Conflicts page at any point (it deletes the queued entry with one click, no confirmation — RC1 audit finding).
- [ ] 5.5 The CANARY cashier requests a refund of each of the 3 canary sales (reason `CANARY refund`); the owner approves them.
- [ ] 5.6 Close the CANARY shift with the counted cash (0 net); variance reason `CANARY`.
- [ ] 5.7 Owner deactivates `CANARY CASHIER` → it can no longer sign in. Owner sets `CANARY TEST` inactive (it stays as history, cannot be sold).

## 6. Update guard and recovery
- [ ] 6.1 **Not on a shop till.** A hand-started installer (e.g. a local 1.0.17 test build) does **not** pass through the updater guard (electron-updater only guards updates it downloaded from the release feed), so it proves nothing, and a test 1.0.17 left on a shop till would block the real 1.0.17 auto-update (`allowDowngrade` off, same version). The guard is evidenced by the real-Electron harness (`src/lib/updateGuard.electron.test.ts`) and unit tests ([`release-1.0.16.md`](release-1.0.16.md) §3); its first real exercise is the first published update after 1.0.16. Optional: an engineer-owned spare Windows machine, never a shop till.
- [ ] 6.2 On the till: with the update notice absent, the sidebar Update button shows the current version and "Update" (no false "Restart"). PASS = no update offered.
- [ ] 6.3 Recovery drill (engineer, from the Mac, on the 5.3 file): `npx tsx tools/queue-recovery/cli.ts inspect <file>.spqx` shows the 2 canary entries with their idempotency keys; `replay … --target <self-hosted origin> --dry-run` reports both as **planned** (a dry run never contacts the server, so it cannot say "already applied"). Proof that a real replay would create nothing: the read-only query `SELECT count(*) FROM public.idempotency_keys WHERE key = ANY('{<key1>,<key2>}'::uuid[]);` returns **2**, and §7.1 `canary:sales` is 3. Never run a non-dry replay against production.

## 7. Server-side checks (engineer, read-only, same day)
- [ ] 7.1 **Only CANARY rows changed.** Run [`canary-1.0.16-fingerprint.sql`](canary-1.0.16-fingerprint.sql) with `win_start` = 0.7 and `win_end` = now → `canary-<shop>-after.txt`; `diff canary-<shop>-before.txt canary-<shop>-after.txt`. PASS when all of:
  - every `public.<table>|<real>|<canary>|<md5>` line has the **same real count and md5** as before, except `public.phone_upload_org_rate` (rate counter, volatile by design), `public.idempotency_keys` / `public.admin_login_codes` only if a scheduled prune removed old rows (real count lower, nothing added), and `public.audit_logs` only by the rows listed under `window:real audit_logs by action_type` that are owner/cashier **sign-in** events;
  - every `window:real rows created in …` line is 0 (apart from those audit sign-in rows);
  - `auth.users (real, stable columns)`, `auth.mfa_factors (real, …)`, `storage.objects (real)` unchanged;
  - every `assert:` line is **0** (no canary sale has a real product line, all canary sales refunded, no real-product stock movement by the CANARY cashier, CANARY cashier inactive, CANARY shift closed, one sale per complete_sale key);
  - `canary:` counts as expected: products 1, cashiers 1, shifts 1, sales 3, refund requests 3, stock movements = adjustment + 3 sales + 3 refund restocks, upload sessions ≥ 2, complete_sale keys 3.
  The script prints counts and md5s only (no ids, no e-mails). The second shop's canary runs while the first shop sells for real: there, real rows of the **other** shop may change; compare the canary shop's lines and the assertions, and list the other shop's changes as live activity.
- [ ] 7.2 `deploy/lucashome/verify-till-readiness.sh --register …`: this till shows **PROVEN** (from 4.1) and no direct staff uploads; copy the result into the register (`desktop_upload_result`, `last_seen_utc`).
- [ ] 7.3 Zero requests from the till to `*.supabase.co` (Tailscale/DNS log or the app's network log).
- [ ] 7.4 Backup taken after the canary; recovery point recorded.

## 8. Stop / rollback rules
- Any FAIL → stop; keep the till on 1.0.16 **only if** sales can continue safely; otherwise use paper and export the queue first. **Never** install 1.0.15 on a till that has 1.0.16 data, and never point a till at hosted.
- Server problem → [`../selfhost-migration/phase-g/emergency-recovery-runbook.md`](../selfhost-migration/phase-g/emergency-recovery-runbook.md).
- Real sales start at a shop only after **all** lines pass there, the second shop's canary has passed, and the email off-server backup is live.

## 9. Cleanup decision — default KEEP (flagged)
Default: **keep** every canary row as audit history; the product and cashier are inactive (5.7). Record `canary rows kept (KEEP)` in the register `notes`. Reasons: the rows are part of the audit trail and the shift/refund history; the idempotency ledger references them; and **deleting canary sales would let a later sale of that shop and day reuse a receipt number** (receipt numbers are a per-day count, see the test data rule) — including an offline sale of that day that syncs later.

Removal only on an explicit owner decision, as a guarded manifest like [`../selfhost-migration/phase-f/qa-cleanup-manifest.md`](../selfhost-migration/phase-f/qa-cleanup-manifest.md): ids enumerated read-only from the canary set of §7.1, exact expected counts per table in a single transaction that aborts on any mismatch, fresh verified backup + LSN, dry run on a throwaway restore, after-fingerprint differing only in the canary rows — and never before every till of that shop shows pending 0 for the canary day. Not prepared now.

## Record
| Shop | Device | Line | Result | UTC time | By | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
