# 08 · Testing & QA

The codebase has Vitest unit tests for pure helpers (POS cart-stock,
supplier debt + action matrix, barcode lookup, error mapper, etc.). End-
to-end UI assertions and database-side verification live in checklists.

```bash
npm test             # Vitest (971 tests on the self-host branch, 2026-10-16; was 570)
npx tsc -b           # Type check
npm run build        # Production build
npm run lint         # ESLint
```

## Self-host branch test suites (2026-10-16)

Which suite answers which question, and the last recorded result. Never
point an app or probe at hosted; every harness fails on a `*.supabase.co`
request. Live suites and e2e write QA data to lucashome — run the cleanup
after each and expect `CLEAN`. Run order before a release and full
commands: [`runbooks/README.md`](./runbooks/README.md).

| Suite | Command | Runs against | Last result |
| --- | --- | --- | --- |
| Unit / flow | `npx vitest run` | Mac | 1594 pass / 228 skipped (2026-10-19, branch `g1/batch-2a` + uncommitted v87 client); earlier 971 (after the D300 fix) |
| v87 client against 087 (fake server's 087 emulation; every finding of the 2026-10-19 independent reviews) | `npx vitest run src/stores/data/recovery087.client.test.ts` | Mac | 44/44 (2026-10-19) |
| Migration 087: real migration through the real runner, restores (physical, PITR, logical, reload), witness authority + gate, Chromium CORS, legacy clients, 086 compatibility | `UPSTREAM_ENVOY_DIR=<dir> bash tools/m087-verify/run.sh <tag>` — [`tools/m087-verify/README.md`](../tools/m087-verify/README.md) | Mac, disposable stack `phf-iso-*` | all parts passed (2026-10-19, `e170794`): x2 248/0, browser 6/0, legacy 11/11, compat 19/1 (the one intended FS.10 refusal), x3 23/0, x1 117/0 |
| v87 client e2e: real app in real Chromium (persistent profile, crash + restart) and the real Electron app against the committed 087 | `bash tools/m087-client-verify/run.sh <tag>` | Mac, disposable stack `phf-iso-*` | 5/5 (2026-10-19) |
| Edge functions (mocked email, no network) | `bash supabase/tests/functions/run.sh` | Mac (Deno) | 81 (G10) |
| DB harness: migrations, RLS, idempotency, org isolation, 082–085 guards | `bash supabase/tests/phase-d/run.sh` (`POS_TEST_MAX_MIGRATION=NNN` to cap) | Mac, disposable Postgres | 710/0 (G10) |
| **Org-isolation security audit** (real GoTrue/PostgREST/storage/edge-runtime, two synthetic orgs + attacker/orphan/platform admin, coverage gate) | `tools/security-audit/run.sh [--max-migration NNN]`; production model `PHF_ISO_SKIP_MIGRATIONS=84 … --max-migration 085`; schema parity `PHF_ISO_PARITY_SSH=<alias> … --parity` | Mac, disposable stack (parity = read-only on live) | 083: 446/0/2 low GAP, coverage 120/120, parity PASS ([`org-isolation-security-audit.md`](./selfhost-migration/phase-f/org-isolation-security-audit.md)) |
| Live API suites (phase-d, phase-f-staff, org-isolation, g2–g4) | `npx vitest run src/live/<suite>.live.test.ts` — [`supabase/tests/phase-d/live/README.md`](../supabase/tests/phase-d/live/README.md) | lucashome (QA data) | after 083: 16/16, 9/9, 12/12, 4/4, 9/9, g4 14/15 (test bug, fixed for 085) |
| Electron end-to-end | `npm run e2e` (spec D uses the deployed phone page by default), then `npm run e2e:cleanup` — [`e2e/README.md`](../e2e/README.md) | lucashome | 44/44 ×2 normal + ×1 reverse (2026-10-15/16) |
| Phone QR modal harness | `npm run test:phone-modal` | Mac, headless Chromium + mocked loopback backend | 12/12 |
| Server helper scripts | `deploy/lucashome/tests/{functions-router,envoy-storage-headers,envoy-studio-isolation}-test.sh` | Mac (Docker) | see the phase-f notes |

Re-run **every** live suite after any migration, not only the targeted one
(see [`lucashome-selfhost/incidents.md`](./lucashome-selfhost/incidents.md),
2026-10-16), and run e2e once in reverse order before trusting a green run.

## Vitest Coverage Today

| File | Surface |
| --- | --- |
| `src/lib/errors.test.ts` | Error classifiers + `getErrorMessage` mapping |
| `src/lib/permissions.test.ts` | Effective-permission model |
| `src/lib/utils.test.ts` | Format/parse helpers |
| `src/lib/compressProductImage.test.ts` | Image compression branches |
| `src/lib/productImageStorage.test.ts` | Storage path helper |
| `src/lib/productImagePhoneUpload.test.ts` | Phone-upload helper |
| `src/features/pos/cartStock.test.ts` | Stock guards + clamp, mixed sellable-unit base stock limits, Non Stock bypass |
| `src/features/pos/service.test.ts` | Cart totals use sellable-unit price, not base-unit multiplication |
| `src/features/catalog/productUnits.test.ts` | Product Unit defaults, validation (at least one active, exactly one default, default base_quantity must be 1, duplicate-name rejection, non-negative sale + purchase price), sanitize/normalize, virtual default fallback for legacy products, migration 026 + 027 SQL guards (sale_price_mmk / purchase_price_mmk split, complete_sale uses sale_price_mmk) |
| `src/features/shifts/workHours.test.ts` | Active/closed duration, monthly attribution rule, formatting, group-by-user |
| `src/features/admin/userFormErrors.test.ts` | DB constraint → user-friendly message mapping |
| `src/lib/shopValidation.test.ts` | Shop name/code trimming, duplicate normalized name/code validation, same-row edit allowance, DB unique-index error mapping |
| `src/lib/shopDelete.test.ts` | Shop reference counting across all shop-bearing tables, friendly reference summary, DB foreign-key (`23503`) error mapping |
| `src/lib/barcodeValidation.test.ts` | Package barcode normalization (trim + scanner control-char strip), length + whitespace validation, in-form and cross-product duplicate detection, `checkBarcodeAddable` ruleset shared with the scan modal, DB unique-index (`23505` / `product_barcodes_unique_normalized_value`) error mapping |
| `src/features/dashboard/dashboardMetrics.test.ts` | Scope, net revenue (gross − approved PARTIAL refunds), cost of goods, profit/margin/AOV (no NaN on empty data), Admin daily revenue/cost/profit trend, Sales by Category percentages, inventory value, **per-shop low stock (never sums across shops)**, top products ranking, supplier debt (RECEIVED-only) |
| `src/features/pos/barcodeLookup.test.ts` | Unit-linked barcode lookup, SKU fallback to default unit, and parity with label printer |
| `src/features/suppliers/debt.test.ts` | Debt math (debt starts on RECEIVED only) |
| `src/features/suppliers/actions.test.ts` | `getPurchaseOrderActionState(po, user)` matrix |
| `src/features/inventory/selectors.test.ts` | Per-shop stock isolation + composite PK |
| `src/features/inventory/stockDisplay.test.ts` | `decomposeBaseQuantity` greedy unit picking (214 cans → 8 Package 22 Can), inactive/other-product unit filtering, `formatStockQuantity` fallback when registry is empty, `convertToBaseQuantity` clamps (10 packages × 24 = 240 cans, 2 cases × 24 = 48 cans) |
| `src/features/inventory/unitAwareWorkflows.test.ts` | Migration 028 + 029 SQL guards: snapshot columns on `purchase_order_items` / `stock_transfer_items` / `inventory_movements`; `receive_purchase_order`, `adjust_stock`, and `create_stock_transfer` server-side unit-to-base conversion and unit ownership checks; `complete_stock_transfer` propagates the snapshot into both `TRANSFER_OUT` and `TRANSFER_IN` rows |
| `src/features/transfers/unitTransfer.test.ts` | Transfer-create unit math: 2 Cases = 48 base units, legacy base-unit path, mixed-unit stock totals, max unit qty from remaining base stock |
| `src/components/inventory/MovementsTable.test.tsx` | Movement history renders base-unit delta plus `Entered as X Unit` snapshots |
| `src/features/categories/categoryIcons.test.ts` | Icon resolver |
| `src/features/categories/categoryUsage.test.ts` | Safe-delete block message |
| `src/features/unitTypes/unitTypeValidation.test.ts` | Unit-type name/abbrev normalization, duplicate name/abbrev rejection (case-insensitive), self-row edit exemption, blank-abbrev guard, sort_order ordering, `resolveProductUnit` active/inactive/legacy branches |
| `src/features/barcodes/labels.test.ts` | `getPrintableBarcodeValue` precedence |
| `src/features/barcodes/labelTemplates.test.ts` | Template registry |
| `src/features/pricing/priceTierForm.test.ts` | Validation rules |
| `src/features/suppliers/phoneUploadSession.test.ts` (under productImages) | Session lifecycle |
| `src/components/products/productPickerUtils.test.ts` | ProductPicker search |
| `src/components/barcodes/BarcodePrintSheet.test.tsx` | Print sheet structure |
| `src/features/pos/completeSaleCostSnapshot.test.ts` | Migration 041 SQL guards: `unit_cost_mmk_snapshot` column + `complete_sale` cost capture, checkout safety preserved |
| `src/features/suppliers/poReceiveValue.test.ts` | Migration 037 — receive bills at received value |
| `src/features/transfers/transferDispatchReceive.test.ts` | Migration 038 — dispatch (no inventory) / receive (paired ledger) SQL guards |
| `src/features/suppliers/voidSupplierPayment.test.ts`, `paySupplierLumpSum.test.ts` | Migrations 039 / 040 SQL guards |
| `src/features/auth/adminLoginCodes.test.ts` | Migration 042 — `admin_login_codes` shape + service-role-only RLS lockdown |
| `src/features/admin/businessProfile.test.ts` | Migration 043 — `business_profile` singleton + read-all / ADMIN-update RLS |

### Flow tests (store + mocked Supabase)

Integration-style tests that drive the real data-store actions with the
Supabase client mocked (`vi.mock("…/lib/supabase")`), asserting the RPC
parameter contract, state reconciliation (inventory merge-in-place), and
error/no-data paths:

| File | Flow |
| --- | --- |
| `src/stores/data/slices/saleSlice.checkout.test.ts` | POS checkout — `complete_sale` payload, fixed/override/open-price branches, reconcile |
| `src/stores/data/slices/purchaseSlice.receive.test.ts` | PO receive — base-qty vs unit-aware lines, PO/item/inventory reconcile |
| `src/stores/data/slices/transferSlice.dispatchReceive.test.ts` | Transfer dispatch (no inventory) → receive (both shops merged) |
| `src/stores/data/slices/saleSlice.refund.test.ts` | Refund/void approval — VOID vs PARTIAL routing, sale + inventory reconcile |

> No React Testing Library / DOM tests yet (one SSR-render test exists for
> `ProductFinder`). Modal-behavior assertions ("modal stays open on failure",
> "double-click disabled") live in the manual QA checklists below.

## Live Supabase RLS / RPC Verification

Run against a real Supabase project after applying migrations
`001`–`019`. Full checklist:
[`archive/29-live-supabase-rls-rpc-verification.md`](./archive/29-live-supabase-rls-rpc-verification.md).
Key sections to verify:

- **Identity mapping.** Every active `users` row has `auth_id`. Every
  non-admin user has `shop_id`.
- **RPC happy paths.** POS checkout, refund + void approvals, purchase
  receiving, stock transfer completion, stock adjustment / damage, shift
  open + close, supplier payment.
- **RPC failure paths.** No open shift, insufficient stock, wrong shop,
  override without permission, non-zero variance without reason, supplier
  overpayment, payment on un-received PO.
- **Direct-write blocks.** `INSERT` / `UPDATE` / `DELETE` from the
  authenticated client against `sales`, `sale_items`, `inventory`,
  `inventory_movements`, `shifts`, `purchase_orders`, `purchase_order_items`,
  `supplier_payments`, `stock_transfers`, `stock_transfer_items`,
  `refund_void_requests`, `reprint_logs`, `audit_logs` all must fail.
- **Shop-scoped reads.** Manager from Shop A sees no Shop B data anywhere.
  Cashier sees own-shift sales only.

Permission-gated SELECT RLS specifics:
[`archive/30-rls-permission-gating-checklist.md`](./archive/30-rls-permission-gating-checklist.md).

Per-RPC scripts (archived but still useful):
- `archive/22-script-3a-checkout-rpc-tests.md` — `complete_sale`
- `archive/23-script-3b-refund-void-rpc-tests.md` — refund/void
- `archive/24-script-3c-receive-purchase-order-rpc-tests.md` — receiving
- `archive/24-script-3f-shift-rpc-tests.md` — shift open/close
- `archive/25-script-3d-complete-stock-transfer-rpc-tests.md` — transfers
- `archive/26-script-3e-adjust-stock-rpc-tests.md` — adjust/damage
- `archive/27-script-4a-rls-lockdown-tests.md` — write lockdown
- `archive/28-script-4b-shop-scoped-reads-tests.md` — shop-scoped reads
- `archive/33-supplier-debt-payment-rpc-tests.md` — supplier payments

## Role-Based QA

For each role (ADMIN, MANAGER, CASHIER, BUYER):

- [ ] Sidebar shows only the expected nav entries.
- [ ] Sidebar can be collapsed and reopened; collapsed mode shows only the
      logo, nav icons, logout icon, and toggle button.
- [ ] Hitting a forbidden route by URL bounces / redirects.
- [ ] Action buttons that require missing permissions are hidden (not
      disabled-but-visible).
- [ ] RPCs reject any action the UI would have hidden, with a friendly
      mapped error message in the toast.

## Shops Management QA

`/app/admin/shops`. Shop creation is explicit only; no login, bootstrap,
dashboard, POS, shift, or shop-switcher path should create a shop.

- [ ] Creating `Shop B` when `Shop B` exists is blocked with
      `A shop with this name already exists.`
- [ ] Creating `shop b` when `Shop B` exists is blocked with the same
      message.
- [ ] Creating `  Shop B  ` when `Shop B` exists is blocked after trim.
- [ ] Creating or editing to a duplicate normalized code is blocked with
      `A shop with this code already exists.`
- [ ] Editing the same shop without changing its name/code is allowed.
- [ ] Editing another shop to duplicate a name/code is blocked.
- [ ] Database unique-index errors from
      `shops_unique_normalized_name` / `shops_unique_normalized_code` map
      to the friendly form messages and keep the form open.
- [ ] Migration `022_unique_normalized_shops.sql` fails on existing
      duplicates and lists the affected rows; it does not delete or merge
      shops.
- [ ] Delete button is hidden for users without `shop:delete`.
- [ ] Delete is disabled (with `References: …` hint) when the shop has
      users, inventory, shifts, sales, purchases, payments, transfers,
      price tiers, refund/void requests, or audit logs attached.
- [ ] Deleting an empty shop succeeds and clears `currentShopId` if the
      deleted shop was the currently-selected one.
- [ ] A DB foreign-key violation (`23503`) maps to
      `This shop is still referenced by operational data.` and the row
      stays in the list.

## Thermal Receipt Print QA

Tested on the actual 80mm thermal printer, not just the browser preview.

Browser/driver setup (one-time per workstation):
- [ ] In the print dialog, select the thermal printer (not "Microsoft
      Print to PDF" / not a regular A4 printer).
- [ ] Paper size: 80mm × Receipt / Roll (matches the driver's defined
      80mm roll profile). Avoid custom heights — the CSS uses
      `@page { size: 80mm auto }` so the page ends at content.
- [ ] Margins: None / Minimum.
- [ ] Scale: 100% (do not "Fit to page" — that re-shrinks the receipt).
- [ ] Headers & footers: off (no URL/date strip at the foot of the
      paper).
- [ ] Background graphics: on (so the logo prints).

Receipt content checks (`/app/receipts/:saleId` after a sale):
- [ ] Print preview shows only the receipt (no sidebar, no toolbar, no
      reprint log, no request actions, no modals, no page background).
- [ ] Logo (`/logo1.png`, ~30mm wide) appears at the top, centred,
      above the shop name.
- [ ] If the logo file is missing, the receipt still renders the shop
      name and the rest of the receipt — no broken-image icon, no
      crash.
- [ ] Shop name, shop address, receipt number all visible.
- [ ] Date, cashier, status, payment method, items, subtotal,
      discount, total, paid, change all visible.
- [ ] Money columns are right-aligned and numerals line up
      (tabular-nums).
- [ ] Item qty × unit-price secondary line is smaller than the main
      item name (Tailwind's `text-[10px]` survives the print override).
- [ ] Real printer prints readable text (not microscopic) — the
      receipt fills ~76mm of the 80mm roll.
- [ ] No long blank tail after the last line — the cutter / tear-off
      sits right under the receipt.
- [ ] Reprint button produces the same layout and writes a reprint
      log entry.
- [ ] Opening the same sale from Sales History (drawer + full page)
      prints the same layout.
- [ ] CASHIER, MANAGER, and ADMIN receipt prints all look identical.

## Product Unit / Barcode Linking QA

Current Product form QA targets: `/app/admin/products/new` and
`/app/admin/products/:productId/edit` - **Units & Prices** cards. Confirm
there is no `Pack Size` field and
no duplicate top-level Selling Price / Cost Price block. Product Unit controls
stock deduction; Price Level controls the selling price. Retail (Sale 1) is
required for each active unit, while blank Wholesale/Special fields fall back
to Retail and are not saved as zero.

`/app/admin/products/new` and `/app/admin/products/:productId/edit` -
Units & Prices section.
Confirm there is no `Pack Size` field. Add product units (`Can`, `6 Pack`,
`Case`) with base quantities and Retail/Wholesale/Special prices; save;
reopen product; units should persist with exactly one default. Scan a
barcode into a non-default unit card,
save, then scan it in POS and confirm the matching unit is added.
The product admin page is gated to ADMIN/MANAGER. New product requires
`product:create`; edit requires `product:update`; CASHIER and BUYER never see
the barcode editor by default.

Add / edit flow:
- [ ] Selecting Base Stock Unit `Can` auto-creates a base unit card:
      `Can = 1 Can`, and the base quantity input is read-only.
- [ ] Changing Unit Type from `Piece` to `Can` updates the untouched base
      unit card name/helper, but does not overwrite a manually renamed unit.
- [ ] Retail (Sale 1) is required for each active unit. Blank
      Wholesale/Special fields remain blank after save and fall back to
      Retail; they are not saved as zero.
- [ ] Purchase Cost can be left blank and remains nullable.
- [ ] Deactivating the only active unit or the default base unit is blocked
      by the UI/validation.
- [ ] In the product form, click `Scan barcode` → the scan modal opens
      with `Waiting for scanner...` and the capture input is focused.
- [ ] Scan the physical package barcode → status flashes
      `Captured: <value>` then the modal closes, a chip is added to the
      product form, and the toast `Barcode added` appears.
- [ ] Manually typing a value and clicking `Add manually` does the same.
- [ ] Pressing Enter (or Tab on Tab-terminating scanners) inside the
      scan modal does NOT submit the outer product form.
- [ ] Clicking outside the capture input inside the scan modal refocuses
      it so the next scanner burst still lands there.
- [ ] Cancel and Escape both close the scan modal without adding.
- [ ] Scanning the same barcode twice in the same form shows
      `This barcode is already added to this product.`
- [ ] Scanning a barcode that is already linked to a different product
      shows `This barcode is already linked to another product.`
- [ ] Save the product, then re-open it for edit — the chips show the
      previously saved barcodes.
- [ ] Removing a chip and re-saving deletes that barcode from the DB.
- [ ] Submitting with the DB unique index in place: if local data is
      stale and another tab registered the same code, the form catches
      the `23505` and shows the friendly message; the form stays open
      and the chip list is preserved.
- [ ] Save button shows "Saving..." and is disabled during the write.

POS scan:
- [ ] Open POS, scan the physical package barcode -> the matching
      sellable unit is added to the cart, toast shows
      `Added <product name> - <unit>`.
- [ ] Scan the same barcode again → cart quantity increases by 1 (up
      to the per-shop stock limit).
- [ ] Scanning more than stock allows shows
      `Stock limit reached` and quantity does not exceed stock.
- [ ] Scanning an unknown code shows `Barcode not found`.
- [ ] If a product has only a SKU (no package barcode), scanning the
      SKU still finds it (SKU fallback in `findProductForScan`).
- [ ] An SKU that collides with another product's registered package
      barcode resolves to the barcode-owning product (barcode wins).

Barcode Labels (`/app/admin/barcodes`):
- [ ] Generated labels print the selected sellable unit. Unit-specific
      barcodes use that value; default units without a barcode fall back
      to the SKU; non-default units without a barcode cannot print a
      scannable label.
- [ ] Printing a label for the package-barcode value, then scanning
      that printed label at POS, finds the same product.

Migration:
- [ ] `023_unique_normalized_product_barcodes.sql` aborts on existing
      duplicate barcode values, listing each conflicting `(id, product_id)`
      pair; it does not delete or merge barcodes.

Product CSV import/export:
- [ ] Export Products downloads the visible product data with quick fields,
      brand, active price-level columns, and default-unit barcode.
- [ ] Import Products shows a dry-run preview with create/update/error counts
      before any write.
- [ ] Invalid category, brand, unit type, barcode duplicate, negative price,
      invalid Open Price/Non Stock boolean, or missing required field marks
      the row as an error and blocks applying that row.
- [ ] A valid create row creates the product, default unit, default barcode,
      and active price-level rows.
- [ ] A valid update row updates the product and default unit without deleting
      non-default product units.

## Dashboard QA

`/app/dashboard`. Formulas are pinned in
`src/features/dashboard/dashboardMetrics.ts` and covered by
`dashboardMetrics.test.ts`. Read alongside `04-features-workflows.md` >
Dashboard.

Role & shop scope:

- [ ] **ADMIN** lands on "All Shops" by default; the dropdown lists all
      shops + an All Shops option; Revenue by Shop and Shop Performance
      use all shops; Revenue, Cost & Profit Trend uses all shops when
      `report:shop_profit` is present.
- [ ] **ADMIN selected shop** limits revenue, orders, AOV, recent sales,
      profit trend, Sales by Category, Top Selling Products, Inventory
      Intelligence (stock health / fast / slow / reorder), low stock,
      pending approvals, open shifts, supplier debt, and audit activity
      to the selected shop.
- [ ] **ADMIN Inventory Intelligence** card renders with
      `report:shop_inventory`. Stock Health summary tiles (healthy / low
      / out) match the per-product low/out lists; Fast / Slow Movers
      show `n/a` (never `999d`) for products with no recent sales;
      Reorder Suggestions surface low-stock items projected to run out
      within 7 days or out-of-stock items that had sales.
- [ ] **MANAGER assigned shop** shows the operational layout with locked
      shop selector, compact KPI row, Recent Sales near the top, Top
      Selling Products, Pending Approvals, Inventory Alerts, Pending PO
      Receipts, Pending Transfers, Supplier Debt (if allowed), smaller
      Sales by Category, and Cash vs Other.
- [ ] **MANAGER without `report:shop_profit`** sees no profit, cost,
      margin, profit trend, goal tracker, or profit/cost product columns.
      Sales by Category still renders because it is sales mix only.
- [ ] **CASHIER / BUYER** cannot reach the route by default
      (`report:shop_sales`). If CASHIER is explicitly granted dashboard
      access, only own-shift / own-sales cards render.
- [ ] **Non-admin with no assigned shop** (defensive) renders the
      "No shop assigned" blocked-state card.

Data correctness:

- [ ] **VOID sales** never appear in totals, orders, top products, or
      Recent Sales.
- [ ] **REFUNDED sales** never appear either.
- [ ] **Approved PARTIAL refund** reduces the Revenue card in the same
      shop/range.
- [ ] **Avg Order Value** is rounded to whole MMK; no long decimals.
- [ ] **Date range** Today / Week / Month changes sales KPIs, recent
      sales, top products, category split, payment split, Admin Revenue,
      Cost & Profit Trend, and admin shop performance.
- [ ] **Admin trend chart** excludes VOID/REFUNDED sales, groups by day,
      subtracts approved PARTIAL refunds from revenue, uses current
      product cost as the investment/cost approximation, and renders a
      no-sales empty state when there is no ranged data.
- [ ] **Sales by Category** excludes VOID/REFUNDED sales, respects shop
      scope, uses `sale_items.lineTotalMmk`, and percentage totals are
      approximately 100%. Cart-level discounts are not allocated back to
      categories yet.
- [ ] **Empty DB / no sales for the scope**: every number reads `0`; no
      NaN, no Infinity; charts/lists render clean empty states.
- [ ] **Cost of goods approximation**: a product cost change AFTER a
      sale was rung up changes the profit/cost numbers retroactively —
      this is documented in `04-features-workflows.md` and is the
      current limitation until `sale_items.unit_cost_mmk` is added.
- [ ] **Supplier debt** counts only RECEIVED unpaid or partial POs; DRAFT,
      SUBMITTED, APPROVED, and CANCELED POs do not contribute.
- [ ] **Pending approvals** count only REQUESTED refund/void requests.
- [ ] **Pending PO receipts** count only APPROVED purchase orders.
- [ ] **Pending transfers** count only PENDING transfers where the shop is
      source or destination.

Low stock + inventory:

- [ ] **Per-shop view**: low/out products for that shop appear; shops
      with healthy stock for the same product don't.
- [ ] **All-shops view**: if Shop A is out of `prod-beer-01` while
      Shop B has 100, the Low Stock card shows ONE row (Shop A · 0)
      and the row shows the shop name. **Never** a row that says
      "100 left because we summed across shops."
- [ ] **Inventory metrics** are based on `(shop_id, product_id)` rows,
      not global product quantities.
- [ ] **Slow mover values** never show fake `999d`; no-sales products do
      not get an invented days-of-stock estimate.

## Shifts & Work Hours QA

`/app/shifts` is one unified page for ADMIN, MANAGER, and CASHIER.
Backend reference: `open_shift` / `close_shift` (migration `009`); SELECT
RLS in migration `015`.

Open / close:

- [ ] **ADMIN with no shop selected** → "Select a shop to open a shift."
      message; the StartShift form is hidden.
- [ ] **ADMIN with shop A selected** → can open + close a shift in shop
      A. The opened shift has `cashier_id = admin.id`.
- [ ] **ADMIN / MANAGER View summary** can close a visible open shift in
      scope when they hold `shift:manage_all`.
- [ ] **ADMIN switches to shop B** without closing the open shift in
      shop A → trying to open a second shift fails with `This cashier
      already has an open shift` (advisory lock + unique index).
- [ ] **MANAGER** → can open + close in their assigned shop. Shop is not
      picked from the switcher; the assigned shop is used directly.
- [ ] **CASHIER** → unchanged behaviour: opens + closes own shift in
      their assigned shop.
- [ ] Closing cash is labeled, MMK-only, numeric, and has no leading-zero
      issue after typing/paste.
- [ ] Closing with a non-zero variance shows an inline variance preview and
      requires a written reason; the RPC rejects otherwise.

Shift Records tab:

- [ ] **ADMIN** sees rows from every shop. Month/date, status, shop, and
      user filters narrow the list. CSV export reflects the current filter.
- [ ] **MANAGER** sees only their assigned shop's rows. User filter
      lists only users with a row in that shop.
- [ ] **MANAGER** querying URL params for shop B sees no shop B rows
      (RLS enforces, not just the client).
- [ ] **CASHIER** sees only their own rows; no team-wide shop/user filters
      are shown.
- [ ] Records show cashier, role, shop, start, end/Active, duration, sales
      count, expected cash, closing cash, variance, status, and View.
- [ ] CSV contains cashier, role, shop, started_at, ended_at, duration,
      status, opening_cash, expected_cash, closing_cash, variance,
      sales_count, and variance_reason.

Work Hours tab:

- [ ] Month picker defaults to current local month; switching reloads
      Monthly totals + Daily records.
- [ ] Active shifts cards show `Xh Ym so far` and tick after ~60 s. Durations
      use `0h 12m` / `2h 05m` style and never show NaN/Infinity.
- [ ] A shift that crossed midnight from May 31 into June 1 (local
      time) shows up in May only. Documented in
      `04-features-workflows.md`.
- [ ] **ADMIN** sees per-shop, per-user totals across all shops. Empty months
      show a clear no-work-hours state.
- [ ] **MANAGER** sees only their assigned shop's users.
- [ ] **CASHIER** sees only their own totals.

## POS Smoke Test

- [ ] Cashier scans an existing barcode → product added, toast "Added X".
- [ ] Cashier scans a label printed from SKU only → still adds.
- [ ] Cashier scans an unknown code → "Barcode not found".
- [ ] Out-of-stock product → "Only 0 in stock for this shop."
- [ ] Product card unit buttons stay readable when unavailable: red border
      and red text, not greyed out.
- [ ] Add an Open Price product → POS prompts for a positive unit price
      before adding the cart line.
- [ ] Add a Non Stock product with no inventory row / zero stock → cart add
      succeeds and checkout does not write inventory movements for it.
- [ ] Bills header shows the item count plus `All`; clicking `All` opens a
      modal with every cart line.
- [ ] Cart line product name and unit render on separate lines; delete is an
      icon, not "Remove" text.
- [ ] There is no page-level POS price-level dropdown. A permitted manager
      changes a fixed-price cart line through the pencil selector only.
- [ ] CASHIER does not see the cart-line price-level pencil.
- [ ] Cashier without open shift → checkout disabled with helper.
- [ ] Pay = total → confirm enabled; payment succeeds; receipt number toast shows.
- [ ] Sales list **View voucher** → `/app/sales/:saleId` shows the themed
      Sales Voucher (line-item grid + summary panel), not the 80 mm receipt.
- [ ] **Print** / **Reprint** on the voucher page still output only the
      80 mm receipt (the print-only-host receipt), not the voucher grid.
- [ ] Reprint button writes one `reprint_logs` row even on double-click.
- [ ] Cashier opens another cashier's sale URL → "Receipt not found"
      (RLS hides it).

## Supplier & Payment QA

Full coverage: [`archive/35-supplier-workflow-qa-checklist.md`](./archive/35-supplier-workflow-qa-checklist.md).
Highlights:

- [ ] Row click + "View details" both navigate to
      `/app/suppliers/:supplierId`. Row Action buttons stop propagation.
- [ ] Unknown supplier id shows the friendly "Supplier not found" card.
- [ ] DRAFT PO shows Approve (admin) or "Needs approval" hint.
- [ ] APPROVED PO shows Receive (admin / manager) or "Needs receiving".
- [ ] RECEIVED unpaid PO shows Record payment (admin / manager) or
      "Needs payment".
- [ ] RECEIVED paid PO is terminal; no action button.
- [ ] CANCELED PO is terminal; no Cancel button.
- [ ] Payment > outstanding balance → submit disabled, inline error.
- [ ] BUYER sees Create PO + Cancel-PO; no Receive / Pay buttons.
- [ ] CASHIER does not see the Suppliers menu at all.

## Admin 2FA & Profile QA

Prereqs: migration `042`/`043` applied, `admin-2fa` deployed, TOTP MFA enabled.

- [ ] ADMIN login with no authenticator set up → routed to `/verify`, email
      code arrives, correct code → dashboard; wrong/expired code rejected;
      resend works.
- [ ] Non-admin login → straight in, no `/verify` step.
- [ ] Security page → "Set up an authenticator app" → scan QR → confirm code →
      future logins prompt for the **app** code; "use email code instead" still
      works (lost-phone recovery).
- [ ] Security page → Add a second device → either phone's code logs in.
- [ ] Opening the Security page requires a fresh code; leaving + returning
      asks again.
- [ ] Refresh within a session stays verified; closing the browser re-verifies.
- [ ] Profile → change business name + upload logo → Save → sidebar header and
      a printed receipt show the new brand; non-admins can't reach `/app/profile`.

## Barcode + Print QA

Full coverage: [`archive/18-printing.md`](./archive/18-printing.md) test
checklist. Highlights:

- [ ] Print on `/app/sales/:saleId` outputs only the 80 mm receipt — no
      sidebar, page header, or modals.
- [ ] Reprint logs exactly one `reprint_logs` row per click; double-clicks
      do not duplicate.
- [ ] `/app/barcode-labels` route is blocked for cashier/buyer.
- [ ] Compact / Standard / Price / Large templates each preview and
      print at the matching size.
- [ ] Quantity below 1 or above 200 is clamped to 1–200.
- [ ] Product without barcode rows but with SKU prints with `Using SKU as
      barcode`; product with neither shows the inline "no barcode
      available" state.
- [ ] Scan the printed label back at POS → adds the product.

## Responsive QA

Full coverage: [`archive/32-responsive-testing-checklist.md`](./archive/32-responsive-testing-checklist.md).
Quick spot-checks at the three target sizes:

- [ ] **1024 × 768** — sidebar 220 px; POS product grid 2 cols; cart 320 px;
      Supplier Detail page tabs render without horizontal scroll.
- [ ] **1366 × 768** — sidebar 270 px; POS grid 3 cols; payment modal
      breakdown wraps cleanly.
- [ ] **1920 × 1080** — sidebar 270 px; POS grid 4 cols; Supplier Detail
      summary cards on one row.
- [ ] Collapse sidebar at each desktop size → content remains usable and the
      rail shows only logo/nav/logout/toggle icons. Refresh keeps the chosen
      collapsed/open state.
- [ ] Viewport < 768 px renders `SmallScreenGuard` instead of the app.

## Error Handling QA

Full coverage: [`archive/34-error-handling-qa-checklist.md`](./archive/34-error-handling-qa-checklist.md).
Critical scenarios:

- [ ] **Offline app load** — `loadData` shows "Couldn't load your data" +
      Retry button. After re-enabling the network, Retry succeeds.
- [ ] **RLS denial on bootstrap** — retry screen shows the friendly
      "You do not have permission to perform this action." (not a blank
      app).
- [ ] **Expired session** — friendly "Your session expired. Please log in
      again." toast; route guard bounces to login on next protected
      navigation.
- [ ] **Modal save failure** (any of: product, category, supplier, PO,
      payment, shift close, supplier payment) — modal stays open, form
      values preserved, save button re-enables, friendly toast.
- [ ] **Double-submit prevention** — clicking Save / Confirm / Record
      twice fast triggers only one request.
- [ ] **Render-time crash** — the top-level ErrorBoundary shows
      "Something went wrong" with Try again / Reload. Stack trace visible
      only in dev.

## Recommended Playwright Smoke Tests

Not yet implemented. Recommended coverage when the harness lands:

| Suite | Scenarios |
| --- | --- |
| Auth | First-admin bootstrap; normal login; expired session bounce. |
| POS | Scan + checkout (CASH and OTHER); Print + Reprint logs once; cashier blocked without open shift; out-of-stock blocked. |
| Shifts | ADMIN opens + closes shift after picking a shop (open is blocked without one); MANAGER opens + closes for assigned shop; CASHIER opens + closes own; second-open attempt by same cashier blocked; non-zero variance requires reason. |
| Work Hours | ADMIN sees rows across all shops + filters; MANAGER sees assigned shop only; CASHIER sees own only; live "Active" duration updates after a minute; switching months reloads totals. |
| Purchasing | Create PO → approve → receive → record payment (PARTIAL then full); supplier debt updates after each step. |
| Transfers | Create with default and non-default Product Units, preview base quantity, approve + complete; insufficient source stock blocked by combined base-unit total. |
| Refund/Void | Cashier requests refund + void; manager approves; inventory restock visible. |
| Roles | Cashier cannot reach `/app/suppliers/*`; manager cannot approve a PO; buyer cannot record a payment. |
| Errors | Network drop during `loadData` shows Retry; failed payment keeps cart intact. |
