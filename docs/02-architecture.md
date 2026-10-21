# 02 · Architecture

## Tech Stack

- React 19 + TypeScript + Vite
- Zustand for in-memory UI state
- React Router 7 for navigation
- Recharts for analytics
- Tailwind CSS for styling
- Supabase Auth + PostgreSQL for identity + business data

## Folder Layout

```text
src/
  app/
    layout/          AppLayout, Sidebar, Topbar, ShopSwitcher, SmallScreenGuard
    routes/          AppRouter + RequireAuth / RequireRole guards
  components/
    ui/              Button, Card, Modal, Drawer, Badge, Toast, ErrorBoundary, …
    pos/             ProductFinder, CartPanel, PaymentModal, ReceiptPreview
    receipt/         ReceiptDetail (voucher on screen + print-only receipt)
    sales/           SalesTable, SaleVoucher, refund/void modals (SaleDetailDrawer unused)
    shifts/          Shift cards and detail views
    inventory/       Inventory UI
    products/        Reusable ProductPicker and search helpers
    dashboard/       Dashboard charts and summaries
    purchases/       PurchaseOrderCreateModal, PurchaseOrderReceiveModal
    suppliers/       SupplierFormModal, SupplierPaymentModal
    barcodes/        BarcodeSvg, BarcodeLabel, BarcodePrintSheet
  features/
    auth/, admin/, catalog/, pricing/, pos/, reports/
    suppliers/       debt math, getPurchaseOrderActionState, ui primitives
    barcodes/        labels, labelTemplates
  pages/             Page compositions used by routes (incl. SupplierDetailPage)
  hooks/             useAsyncAction, useViewportWidth, useTranslation, …
  stores/
    authStore.ts       Supabase Auth session + current app user id + offline auth cache
    appStore.ts        Selected shop UI state (persisted to localStorage)
    languageStore.ts   Language + Zawgyi/Unicode preference (persisted)
    connectivityStore.ts  Online/offline tracking (navigator.onLine + events)
    toastStore.ts      Toast queue
    data/              Zustand domain slices + Supabase row mappers (mappers.ts)
      outbox.ts        Offline write queue: enqueue, drain/reconcile, conflicts
      deltaSync.ts      Cursor-based incremental pull for tables with updated_at
      localSync.ts, localWrites.ts, tableWrite.ts   Local IndexedDB mirror I/O
  lib/
    permissions.ts     Central permission registry + ROUTE_PERMISSIONS
    supabase.ts        Supabase client, dbWrite / dbExec / dbAudit
    localDb.ts         Dexie (IndexedDB) schema — the local offline mirror
    errors.ts          Central error utility + classifiers + getErrorMessage
    id.ts              Collision-safe id generation for offline-created rows
    print.ts           Receipt printing — Electron silent print, else window.print()
    utils.ts           Formatting, getEffectiveShopId, normalizeAmountInput, …
  types/domain.ts    TypeScript domain model (User, Sale, Inventory, …)
scripts/seed/        Seeding: `npm run seed:service-role` (seedServiceRole.ts); nothing seeds from the browser
supabase/
  schema.sql         Base schema
  migrations/        Ordered SQL migrations (apply in numeric order)
  functions/         Edge Functions: email-sales-report, rotate-audit-log, admin-2fa
```

## Runtime State

| Store | Responsibility | Persisted |
| --- | --- | --- |
| `authStore` | Supabase Auth session + `currentUserId`, `currentRole`, and the admin 2FA state (`adminVerified`, `hasTotp`) + MFA actions (`requestAdminCode`/`verifyAdminCode`, `enrollTotp`/`verifyTotpEnrollment`/`verifyTotpLogin`/`unenrollTotp`/`listTotpFactors`). | Auth session in localStorage; admin-verified flag in sessionStorage (per browser session); last-resolved user cached in IndexedDB for up to 24h so `restoreSession()` doesn't log the user out on a cold boot with no network. |
| `appStore` | Currently selected shop. | `pos-app` in localStorage. |
| `languageStore` | Language / Zawgyi-Unicode toggle. | `pos-language` in localStorage. |
| `connectivityStore` | Online/offline flag, updated live from `window`'s `online`/`offline` events. | — (derived from `navigator.onLine` at init). |
| `toastStore` | Toast queue. | — |
| `dataStore` (`stores/data/`) | In-memory cache of all Supabase domain rows, hydrated by `loadData()`. | **Yes — mirrored to IndexedDB** (Dexie, `lib/localDb.ts`) so the app boots instantly from cache (works offline) and re-persists after every load/sync. |

localStorage holds only the small UI-preference items above (shop
selection, language, admin-verified session flag). The much larger
business-data mirror — and the offline write queue — live in **IndexedDB**,
a separate browser storage mechanism, not localStorage. See
[10-offline-desktop-known-issues.md](./10-offline-desktop-known-issues.md)
for the full offline-first design (local-first boot, the write outbox,
delta sync, and exactly which write flows are offline-capable).

## Data Loading

`stores/data/index.ts` composes the domain slices (shop, category, brand,
unit type, product, inventory, shift, sale, transfer, purchase, pricing,
audit) and exposes:

- `isLoading`, `isLoaded`, `loadError`
- `loadData({ force? })` — full reload (all tables, in parallel)
- `retryLoadData()` for the bootstrap retry surface
- `pullDeltas()` — lightweight incremental refresh (see below)

**Boot is local-first**: before touching the network, `loadData()` hydrates
the store from the IndexedDB mirror (`localSync.ts`'s `readLocalSnapshot()`)
if one exists, so the app renders immediately — offline or on a slow
connection — instead of blocking on a spinner. It then still runs the full
network fetch in the background to refresh it; `isLoading` stays true
during that background refresh so `AppLayout` can show a non-blocking
"Syncing…" badge instead of a full-screen block. If the device is offline
and nothing is cached yet, `loadError` is set and `AppLayout` shows the
"Couldn't load your data" Retry card.

After every full load, `bootstrapDeltaCursors()` seeds a per-table cursor
(`updated_at` of the newest row) for the 11 tables that reliably track it.
`AppLayout`'s routine background refresh (30s-throttled focus regain, 120s
interval) then calls `pullDeltas()` instead of a full reload — cheaper,
since it only fetches rows changed since the cursor. Reconnect-after-offline
and cold boot still do a full `loadData({ force: true })`, since delta pull
can't detect a hard-deleted row (only `products` supports a real hard
delete). See `stores/data/deltaSync.ts` and
[10-offline-desktop-known-issues.md](./10-offline-desktop-known-issues.md).

Each parallel query's `.error` is checked; the first failure becomes
`loadError`.

## Write Model

Writes split cleanly into two paths:

1. **RPC-first (operational, money / stock / status / audit-touching).**
   Atomic `SECURITY DEFINER` functions. The slice action calls the RPC, then
   reconciles local state from the RPC's authoritative result. Lossy
   optimistic state is avoided for these flows.

   | Slice | RPCs |
   | --- | --- |
   | `saleSlice` | `complete_sale`, `create_refund_void_request`, `approve_refund_request`, `approve_void_request`, `reject_refund_void_request` |
   | `inventorySlice` | `adjust_stock` |
   | `shiftSlice` | `open_shift`, `close_shift` |
   | `purchaseSlice` | `create_purchase_order`, `approve_purchase_order`, `receive_purchase_order`, `cancel_purchase_order`, `record_supplier_payment`, `void_supplier_payment`, `pay_supplier_lump_sum` |
   | `transferSlice` | `create_stock_transfer`, `approve_stock_transfer`, `reject_stock_transfer`, `dispatch_stock_transfer`, `receive_stock_transfer`, `cancel_stock_transfer` |
   | `auditSlice` | `log_receipt_reprint`, `log_audit_event` |

   Admin 2FA additionally calls the `admin-2fa` **edge function** (email-code
   path) and Supabase native MFA (`supabase.auth.mfa.*`, authenticator path)
   from `authStore` — these are not table RPCs.

   **Offline-capable subset**: `complete_sale`, `adjust_stock`, `open_shift`/
   `close_shift`, `create_refund_void_request`, `receive_purchase_order`,
   `record_supplier_payment`, `dispatch_stock_transfer`/
   `receive_stock_transfer` each have an `*Online`/`*Offline` pair — offline,
   the action stages a provisional result locally (client-computed, using
   the same math the UI already shows) and queues the exact RPC call via
   `stores/data/outbox.ts`'s `enqueueOutbox()`. A registered `reconcile*`
   function (`registerOutboxReconciler`) swaps the provisional record for
   the server's authoritative one once the queued call actually runs — RPCs
   mint their own ids server-side, so this is a replace, not a merge. The
   rest of this table's RPCs stay online-only (desk/admin operations); see
   [10-offline-desktop-known-issues.md](./10-offline-desktop-known-issues.md)
   for the full scope map and why.

2. **Direct, permission-gated writes (admin / reference).** Direct
   `supabase.from(...).insert / update` writes via `dbWrite` (fire-and-forget
   + friendly toast on failure) or `dbExec` (awaited; throws a friendly
   `Error` on failure). Applies to: `shops`, `users`, `categories`,
   `brands`, `products`, `product_units`, `product_barcodes`,
   `product_unit_prices`, `price_tiers`, `suppliers`, `supplier_products`,
   `business_profile`. RLS still gates by permission server-side
   (`business_profile` UPDATE is ADMIN-only).

   **Offline-capable subset**: `shops`, `users`, `categories`, `brands`,
   `unit_types`, `price_tiers`, `suppliers` go through
   `stores/data/tableWrite.ts`'s `writeTableRow()` — a drop-in replacement
   for the raw `supabase.from(...)` call that queues a `table_write` outbox
   entry when offline (same `enqueueOutbox()`/outbox as above, replayed by
   `tableWrite.ts`'s `replayTableWrite()`). These are last-write-wins with
   no server invariant to reconcile, so a synced write just clears the
   queue entry — no id-swap needed, since the row's id was already
   client-chosen. `products` (+ its barcodes/units/supplier links) and
   `product_unit_prices` are multi-row batch writes that don't fit this
   single-row helper and stay online-only; `business_profile` is a
   singleton keyed `"default"` rather than `id`, same reason.

## Multi-Shop Model

- The `inventory` table has a composite primary key `(shop_id, product_id)`
  — stock is per-shop. Products, barcodes, categories, suppliers, and
  pricing are global / catalog-level. Brands are category-scoped catalog
  metadata used by product management, catalog browse, and POS filters.
- Every stock lookup is keyed by `(shopId, productId)` — never `productId`
  alone. The Product Management "Stock" column shows on-hand units for the
  **selected shop only**.
- Cross-shop stock aggregation only happens when an ADMIN explicitly
  chooses "All Shops" on the Dashboard / Profit reports — that's the
  intended admin aggregate, not a leak. RLS enforces this server-side.
- Admin spans all shops; MANAGER / CASHIER / BUYER are locked to their
  assigned `shop_id`.

## Identity & Permissions

- `users.auth_id` links each active staff profile to a Supabase Auth user.
- Effective permissions: `roleDefaults ∪ grantedPermissions − revokedPermissions`
  (a revoke always wins).
- Frontend helpers in `src/lib/permissions.ts`:
  `hasPermission`, `hasShopPermission`, `canAccessShop`,
  workflow helpers (`canVoidSale`, `canRefundSale`, `canAdjustInventory`,
  `canCompleteTransfer`, `canReceivePurchaseOrder`,
  `canApprovePurchaseOrder`, `canRecordSupplierPayment`).
- SQL helpers used by RLS and RPCs: `current_app_user()`, `app_role()`,
  `app_shop_id()`, `app_user_id()`, `app_has_perm(perm)`,
  `app_can_for_shop(perm, shop_id)`.

Details and per-role tables: [05-roles-permissions.md](./05-roles-permissions.md).

## Product / Inventory / Image Model

- `products.sku` is the primary catalog code (required in the admin UI).
- Product quick fields include `alias_code`, `short_name`, `max_qty`,
  `is_open_price`, `is_non_stock`, and `purchase_type`. `is_open_price`
  makes POS prompt for a cashier-entered unit price; `is_non_stock`
  bypasses inventory deduction and movement writes in `complete_sale`.
- `products.brand_id` links to `brands.id`; brands are active/inactive and
  category-scoped.
- `products.unit_type` is the base stock unit label from the Unit Types
  registry. Inventory stays in base units.
- `product_units` are product-specific sellable units (`Can`, `6 Pack`,
  `Case`) with `base_quantity`, `sale_price_mmk` (required, ≥ 0),
  `purchase_price_mmk` (nullable, ≥ 0), default/active flags, and sort
  order. POS deducts `cart qty * product_units.base_quantity`. The
  default unit always has `base_quantity = 1` — it is the smallest unit
  that other tiers convert to and the unit `inventory.qty_base_units`
  counts. Tier pricing applies only to the default unit (server enforces
  in `complete_sale`).
- `product_barcodes.product_unit_id` maps a barcode to an exact sellable
  unit; null means product/default unit.
- `product_barcodes.value` is the optional scan-code mapping used by POS.
- `product_unit_prices` stores active price-level values by
  `(product_unit_id, price_level_id, optional shop_id)`. The POS cart line
  stores the chosen price level and `complete_sale` resolves the final
  server-authoritative price.
- POS barcode scan resolves: trim → exact `product_barcodes.value` match →
  case-insensitive `products.sku` fallback. This mirrors the label
  printer's selection rule, so a SKU-source label scans back correctly.
  If a barcode row has `product_unit_id`, POS adds that exact sellable unit;
  SKU fallback always adds the default unit.
- Product images compress to `<= 100 KB` and upload to the **public
  Supabase Storage bucket `product-images`**. The `products.image_url`
  column holds only the public URL — never base64.
- A QR-based phone upload flow uses temporary one-time tokens
  (`product_image_upload_sessions`) with `sha256` storage; the phone never
  needs to log in. Expiry is 10 minutes.

## Error Handling

Friendly user-facing messages route through a single utility:

- [`src/lib/errors.ts`](../src/lib/errors.ts) — `getErrorMessage(err, fallback?)`
  plus classifiers (`isPermissionError`, `isNetworkError`,
  `isDuplicateError`, `isStorageError`, `isExpiredSessionError`,
  `isInsufficientStockError`, `isNoOpenShiftError`). Maps Postgres
  SQLSTATE codes (`42501`, `23505`, `PGRST301`), Supabase storage
  phrasing, JWT expiry, and common business-domain phrases to canonical
  friendly strings.
- `dbWrite` / `dbExec` route through the mapper, so RLS / duplicate /
  network errors never leak raw Postgres text into the UI.
- `src/hooks/useAsyncAction.ts` standardizes the save/submit pattern:
  loading state, double-submit guard, friendly toast on failure, returns
  `undefined` so callers naturally keep modals open on failure.
- Top-level [`ErrorBoundary`](../src/components/ui/ErrorBoundary.tsx)
  wraps `<AppRouter>`. "Try again" / "Reload" fallback; stack trace only
  in dev.
- `loadData` exposes `loadError` + `retryLoadData`; bootstrap shows a
  retry card instead of an infinite spinner on RLS / network failure.

QA scenarios: [08-testing-qa.md](./08-testing-qa.md) and
[`archive/34-error-handling-qa-checklist.md`](./archive/34-error-handling-qa-checklist.md).

## Routing

Routes are scoped under `/app` and protected by `RequireAuth` and
`RequireRole`. The route → permission map (`ROUTE_PERMISSIONS`) is the
single source of truth used by both the router guard and the sidebar.

| Route | Required permission |
| --- | --- |
| `/app/dashboard` | `report:shop_sales` |
| `/app/pos` | `pos:create_sale` |
| `/app/sales`, `/app/sales/:saleId` | `sales:view_own_shift` |
| `/app/shifts` | `shift:manage_own` |
| `/app/inventory` | `inventory:view_stock` |
| `/app/transfers` | `transfer:view` |
| `/app/purchases` | `purchase:view` |
| `/app/suppliers` | `supplier:read` |
| `/app/suppliers/:supplierId` | `supplier:read` |
| `/app/approvals` | `approval:view` |
| `/app/reports`, `/app/reports/profit` | `report:shop_sales` / `report:shop_profit` |
| `/app/catalog` | `product:read` |
| `/app/barcode-labels` | `product:read` + role gate (ADMIN/MANAGER) |
| `/app/profile` | `user:update` (ADMIN) — business brand editor |
| `/app/security` | `user:update` (ADMIN) — authenticator devices, behind a re-verify gate |
| `/app/admin/*` | each gated by the relevant admin permission |
| `/verify` | post-password admin 2FA step (session present, not yet verified) |
| `/phone-upload/product-image/:token` | unauthenticated (token-gated) |

## Deployment

Static SPA build (`vite build`) deployed to Vercel. `vercel.json` rewrites
all routes to `index.html` for client-side routing. The browser bundle
contains the Supabase URL + anon key only — never a service-role key.

See [07-setup-deployment.md](./07-setup-deployment.md).
