# 06 · UI, Printing & Hardware

## Responsive Targets

The app is designed for **tablet landscape and larger**. Viewports below
`768px` render `SmallScreenGuard` instead of the app chrome:
*"This app is optimized for tablet and desktop screens. Please use a
wider screen for POS operations."*

`AppLayout` reads `useViewportWidth()` to switch.

| Width × Height | Role | Tailwind bp | Sidebar |
| --- | --- | --- | --- |
| 1024 × 768 | Tablet landscape / old POS | `lg` | 220 px |
| 1280 × 720–800 | Minimum desktop / POS monitor | `xl` | 270 px |
| 1366 × 768 | Common POS monitor | `xl` | 270 px |
| 1440 × 900 | Laptop | `xl` | 270 px |
| 1536 × 864 | Windows scaling | `2xl` | 270 px |
| 1920 × 1080 | Main desktop target | `2xl` | 270 px |
| 2560 × 1440 | Large desktop sanity | `2xl` | 270 px (content capped at `max-w-1400`) |

Tailwind breakpoints used: `lg` 1024, `xl` 1280, `2xl` 1536.

The sidebar has a persisted open/closed toggle. Open width is 220 px below
`xl` and 270 px at `xl+`; collapsed width is 76 px below `xl` and 84 px at
`xl+`. In collapsed mode only the logo, nav icons, logout icon, and toggle
remain visible.

Per-page expectations and a wide manual checklist live in
[`archive/32-responsive-testing-checklist.md`](./archive/32-responsive-testing-checklist.md).
Highlights:

- **POS** — product grid 2 / 3 / 4 columns at `lg` / `xl` / `2xl`; cart
  width `320px` below `xl`, `380px` at `xl+`. Top bar and category
  filters wrap; no horizontal scroll.
- **POS Bills** — each cart line keeps the product name and unit on
  separate lines, uses icon-only delete, stacks quantity controls, and has an
  `All` button beside the item count to open the full cart modal.
- **Tables** (Sales, Inventory, Movements, Shifts, Audit) — wrappers use
  `overflow-x-auto` with `min-w-*` so they scroll horizontally if needed
  rather than clipping.
- **Supplier Detail Page** — five summary cards, three tabs. No drawer
  horizontal scroll at 1024×768. Expanded PO line-items table is the only
  place horizontal scroll may appear, and only at very narrow widths.

## Theme

The entire app supports **System / Light / Dark**. `src/stores/themeStore.ts`
owns the persisted preference (`pos-theme`); new installs default to
`system`, which resolves `prefers-color-scheme` and follows OS theme changes
while the app is open. The sidebar control cycles System → Light → Dark.
Existing explicit Light/Dark preferences from the older store format are
preserved.

`index.html` resolves the saved/system choice before CSS and React paint so a
dark launch does not flash light first. Tailwind is configured with
`darkMode: "class"`; `src/index.css` maps the legacy literal white/slate
utilities used throughout feature pages onto one cool-slate dark hierarchy,
with emerald as the primary accent. This covers POS, dashboards, tables,
forms, modals, empty/error states, and Recharts labels/grids without changing
their business behavior.

Print accuracy is deliberately independent of the app theme:

- `.receipt` and `.barcode-label` remain black-on-white in Dark mode.
- QR/image paper surfaces remain white.
- `color-scheme: light` is forced on printable roots.
- The existing `@media print` receipt/label styles remain authoritative.

## Receipt Printing

The app does **not** use a PDF generator. It uses the browser's native
print pipeline via `window.print()`, with `src/print/receipt.css` to
isolate the 80 mm `<div class="receipt">`:

- `@media print { body * { visibility: hidden; } .receipt, .receipt * { visibility: visible; } .receipt { position: absolute; top: 0; left: 0; …} }`
- `.print-hidden { display: none !important; }` for Topbar, Sidebar,
  Toasts, etc.
- `@page { size: 80mm auto; margin: 0; }` hints the thermal printer
  roll; A4 fallback works as a narrow band on full paper.

### POS inline print (F3) — portal trick

After F3 checkout, POS stays on the page and prints inline. The receipt
is **not** rendered in the POS tree — it's portaled directly into
`<body>` via `createPortal` so no POS ancestor establishes a positioning
context for the absolute receipt:

```jsx
{printReceipt && createPortal(
  <div className="print-only-host">
    <ReceiptPreview … />
  </div>,
  document.body,
)}
```

The `print-only-host` rule (also in `receipt.css`) uses
`display: contents` on screen so the host establishes no layout box,
and the inner `.receipt` is sized to 0×0 + `visibility: hidden` so it
takes no screen space. On print, the existing visibility cascade
reveals only the receipt subtree and the `@media print`
`position: absolute; top: 0; left: 0` rule positions it against
`<body>` (now the only positioned ancestor).

**Without the portal**, an earlier version placed the receipt host
inside POS with `position: fixed; left: -10000px` to keep it off
screen. That made the wrapper a positioned ancestor, so the
absolute receipt printed at `-10000px` off the paper edge — blank
output. The portal sidesteps this entirely.

### Silent printing (skip the print preview dialog)

`window.print()` always shows the browser preview by default. For
production tills, launch Chrome/Edge with `--kiosk-printing` so prints
go straight to the default printer with no dialog. Windows shortcut:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing
```

Set the thermal printer as the system default and F3 will print silently
on every sale. Firefox equivalent: `print.always_print_silent = true` in
`about:config`.

### Print vs Reprint (Sales voucher page)

`ReceiptDetail` (the `/app/sales/:saleId` page) shows the on-screen
**Sales Voucher** and keeps the 80 mm `ReceiptPreview` mounted inside a
`.print-only-host` wrapper so the buttons below still print the thermal
receipt, not the voucher. It exposes two buttons:

| Button | Behavior |
| --- | --- |
| **Print** | Calls `window.print()` directly. Does NOT log. Disabled when the sale has no loaded items. |
| **Reprint** | Gated by `receipt:reprint`. Sets an in-flight flag, awaits `log_receipt_reprint`, then calls `window.print()`. Double-clicks can't create duplicate log rows. RPC failure shows a toast and skips printing. |

Cancelling the print dialog after **Reprint** does not roll back the log
row — by design, a logged reprint is a reprint *intent*.

### Receipt layout

| Block | Content |
| --- | --- |
| Brand header | Logo + business name from the editable `business_profile` (Profile page), falling back to `/logo_real.png` + `Shwe PhaLar` (`mix-blend-multiply` so a white PNG bg blends out) → shop name → address + phone → receipt no |
| Meta | Stacked grid rows: Branch · Date · Cashier · Price · Payment · Items. Fixed-width label column so colons align |
| Items table | 4 columns: Description / Qty / Price / Amount. Plain integers in numeric columns (no `MMK` per row). Dashed rule above and below the header |
| Totals | Subtotal / Discount → dashed rule → **Total** (sm + semibold) → dashed rule → Paid / Change |
| Footer | Burmese thank-you: `ဝယ်ပြီးပစ္စည်းပြန်မလဲပါ။` and `ဝယ်ယူအားပေးမှုကိုအထူးကျေးဇူးတင်ပါသည်။` |

## Barcode Labels

- Route: `/app/barcode-labels`. Gated by `product:read` + role gate
  ADMIN/MANAGER.
- Flow: select active product → preview modal → set quantity (1–200) →
  pick template → **Print labels** mounts `BarcodePrintSheet` and calls
  `window.print()`. The browser print only opens from the final button.
- Barcode value resolution (single source of truth in
  `src/features/barcodes/labels.ts`):
  1. selected Product Unit barcode (`product_barcodes.product_unit_id`)
  2. for the default unit only, fall back to `products.sku`
  3. otherwise: the selected unit cannot print a scannable label
- Labels print product name, sellable unit name, selected unit price, and
  barcode/SKU. Legacy `products.pack_size` is not printed.
- Renderer: CODE128 via
  [`src/components/barcodes/BarcodeSvg.tsx`](../src/components/barcodes/BarcodeSvg.tsx).

### Templates

`src/features/barcodes/labelTemplates.ts`:

| Key | Name | Size | Use |
| --- | --- | --- | --- |
| `compact` | Compact | 50mm × 25mm | Small stickers with a large barcode |
| `standard` | Standard | 60mm × 30mm | Default — name, barcode, price, code |
| `price` | Price focused | 60mm × 30mm | Shelf labels with larger price text |
| `large` | Large | 70mm × 40mm | Bigger packaging labels |

Print isolation: `src/print/labels.css` follows the same pattern as the
receipt CSS, sizing labels through `--label-width` / `--label-height` and
named `@page` hints per template. Browser support for dynamic `@page`
varies; operators may still need to choose the matching label stock in
the print dialog.

## Barcode Scanner Behavior

- The scanner is a keyboard-emulating HID device. The barcode input
  receives keystrokes and an Enter at the end of each scan.
- POS resolves the scanned code via the **same** rule the label printer
  uses: unit-linked `product_barcodes.value` first, then `products.sku`
  fallback to the default Product Unit. A package barcode adds that exact
  Product Unit; a SKU-source label scans back as the default unit. See
  [04-features-workflows.md](./04-features-workflows.md).
- The input refocuses after every scan (success or failure), so the next
  Enter-terminated burst always lands there even if a click stole focus.
- A toast confirms each successful add: `Added <product name> - <unit>`.
  Misses show `Barcode not found`. Stock guards show
  `Only X in stock for this shop.`

## Product Image Upload / Storage

- Compressed to **`<= 100 KB`** via `compressProductImage` (WebP/JPEG).
- Uploaded to the public Supabase Storage bucket **`product-images`**.
- The row stores only the public URL in `products.image_url` — never
  base64.
- Display is a plain `<img src={imageUrl}>`. Timestamped path means
  replacing an image always creates a fresh object, so a changed image is
  never hidden by browser/CDN caching.

### Current flow on the self-host branch (2026-10-16)

The steps below this section describe **v1.0.15 / hosted**. The branch
client (ships as 1.0.16) and lucashome work like this; design notes in
`selfhost-migration/phase-f/` (`phone-qr-origin.md`, `migration-083-g5.md`,
`migration-085-png.md`, `g5-followups.md`):

1. Desktop (file picker *or* QR) calls
   `create_product_image_upload_session(p_shop_id, p_product_id)`; the
   server mints the path `org/<org>/temp/<session>` (client sends no path).
2. QR = `https://<api origin>/functions/v1/phone-upload-page#<token>` —
   the page is served by the `phone-upload-page` function on the backend
   origin (works from the packaged app); the token stays in the fragment.
3. Right before the upload the phone (or the desktop, acting as its own
   "phone") asks `phone-upload-token` for a fresh 60 s signed URL
   (rate-limited, migration 081), then PUTs the compressed image.
4. `phone-upload-token {token, action: "complete"}` reads the bytes back
   (magic number, ≤ 100 KB, no HTML/SVG), then completes as service role.
   Refused objects are deleted. Accepted: JPEG, PNG, WebP (085); both apps
   re-encode to WebP/JPEG anyway.
5. The client accepts only a COMPLETED answer whose URL is exactly the
   server-derived public URL of that path.
6. The desktop modal polls status every 2 s, one request at a time, and
   retries transient errors with backoff. While a session is pending,
   Escape or a backdrop click asks "Stop this phone upload?"; only
   Close / X / "Stop upload" cancel.

Limits: app compression ≤ 100 KB; bucket ≤ 5 MiB, JPEG/PNG/WebP (083);
public image responses carry `nosniff` + sandbox CSP (lucashome).

### Phone QR upload (v1.0.15 / hosted)

A QR-based phone upload flow exists for desktop product forms (when the
desktop user does not have a webcam image):

1. Desktop clicks **Upload from phone**.
2. `create_product_image_upload_session(...)` creates a session.
3. Desktop attaches a pre-scoped signed upload token to that session's
   storage path via `attach_product_image_upload_session_token(...)`.
4. The QR modal shows a QR for `/phone-upload/product-image/:token` (the
   route is unauthenticated but token-gated).
5. The phone validates the raw token via
   `get_product_image_upload_session_by_token(...)`, takes/picks a photo,
   compresses to `<= 100 KB`, uploads to
   `product-images/temp/<sessionId>/...`, then calls
   `complete_product_image_upload_session(...)`.
6. The desktop polls `get_product_image_upload_session_status(...)`,
   receives the public URL, updates the preview.

Security:

- Sessions expire after 10 minutes.
- The raw token is returned only once (the QR URL).
- The database stores only `sha256(token)`.
- A session can be completed only once.
- The phone can upload only to the session's pre-created path.
- Completion rejects wrong storage paths, > 100 KB files, unsupported
  MIME types, `data:` URLs, or URLs outside `product-images`.

## Known Storage Follow-ups

- Replacing or removing a product image does not delete the previous
  Storage object yet. Same for cancelled phone uploads. Orphan cleanup is
  a recommended follow-up (scheduled job listing `product-images` and
  deleting objects with no referencing `products.image_url` + old
  `product-images/temp/*` whose sessions are expired/canceled).
  **2026-10-16:** `deploy/lucashome/backup/sweep-abandoned-uploads.sh`
  covers the abandoned-session part (never the 574 migrated objects);
  prepared, dry run 0 candidates, not scheduled. Replaced images are
  still not deleted.

## Desktop Wrapper (Electron)

The app now also ships as a native Windows/Mac desktop app — an Electron
shell (`electron/main.cjs`, `electron/preload.cjs`) around the exact same
React app, distributed as a `.dmg` (Mac, Apple Silicon + Intel) / `.exe`
(Windows) via a **Download App** button in the sidebar footer
(`DownloadAppModal.tsx`), which links to installers published as GitHub
Releases on this repo.

What it adds over the browser version:
- **Silent receipt printing** — `webContents.print({ silent: true, ... })`
  to a system printer, no print-preview dialog and no need for the
  `--kiosk-printing` browser flag described above. Works with the existing
  80mm receipt HTML/CSS unchanged; most ESC/POS thermal printers install as
  a normal OS printer via the manufacturer's driver, so no raw ESC/POS byte
  protocol was needed. `src/lib/print.ts` feature-detects
  `window.electronAPI` and falls back to `window.print()` in the browser.
- **Offline POS mode with sync** — this is the bigger piece; see
  [`10-offline-desktop-known-issues.md`](./10-offline-desktop-known-issues.md)
  for the full design (local IndexedDB mirror, write outbox, delta sync)
  and exactly which flows are offline-capable vs. still online-only. This
  part works identically in the browser and in the desktop app — it's not
  Electron-specific.
- **Auto-update** — the desktop app checks this repo's GitHub Releases on
  launch and periodically, downloading and prompting to install updates.
  The Windows "cannot be closed" updater failure went through three
  attempted fixes (v1.0.7, v1.0.9) that targeted the app-running
  pre-check and were confirmed on real hardware to not fix it — the
  actual cause was a separate, non-customizable file-copy retry loop
  elsewhere in electron-builder's NSIS templates. v1.0.10 fixes that
  directly. See document 10 for the full diagnosis, the recovery path,
  and the remaining real-Windows verification item.

Still not implemented: talking to OPOS/JavaPOS cash drawers or barcode
scanners with native drivers (scanners still work today via HID keyboard
emulation, same as the browser version; drawers need a printer-model-
specific ESC/POS kick command or direct USB/serial access, neither
wired up yet — no hardware available to build/verify it against). Full
gap list, including code-signing status and the release/publish process,
is in [`10-offline-desktop-known-issues.md`](./10-offline-desktop-known-issues.md).
