# 04 · Features & Workflows

Every business workflow listed here is an atomic Supabase RPC unless
explicitly noted. See [03-database-security.md](./03-database-security.md)
for the full RPC list.

## POS Sale

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| **F2** | Place Order (saves the sale, no print, stays on POS) |
| **F3** | Print (saves the sale AND fires `window.print()` against an inline hidden receipt — stays on POS) |
| **F4** | Toggle barcode input |
| **Enter** (in payment modal Amount field) | Confirm payment |
| **Esc** | Close any open modal |

The cashier never leaves POS after checkout — both F2 and F3 just clear the
cart and toast the receipt number. F3 additionally renders the receipt into
a hidden React portal (`createPortal` to `document.body`) and triggers the
browser print dialog; the print CSS isolates the `.receipt` subtree so
nothing else from POS lands on paper. See
[06-ui-printing-hardware.md](./06-ui-printing-hardware.md) for the
positioning details and the recommended Chrome `--kiosk-printing` flag for
silent thermal printing.

### Barcode scan

- F4 toggles the barcode input; Escape hides it. The input autofocuses and
  is **refocused after every scan** so the next Enter-terminated burst
  always lands there.
- On Enter, POS calls `findProductForScan(value, products, productUnits, barcodes)` in
  `src/features/pos/barcodeLookup.ts`:
  1. Exact (verbatim, case-sensitive) match against `product_barcodes.value`.
     If the barcode row has `product_unit_id`, POS adds that exact sellable
     unit; otherwise it adds the product's default unit.
  2. Trimmed, case-insensitive match against `products.sku`, which always
     adds the default sellable unit.
  This mirrors the label printer's selection rule so a SKU-source label
  scans back correctly.
- On hit: cart adds 1 selected sellable unit, success toast
  `Added <name> - <unit>`.
- On miss: error toast `Barcode not found`.
- Stock guards apply to stock-tracked products: out of stock / at max cart
  units shows `Only X in stock for this shop.` Non Stock products bypass
  these add-to-cart guards.

### Cart

- Quantity changes via scan, +/-, or direct edit.
- Fixed-price cart lines are unique by `productId + productUnitId +
  priceLevelId`, so a product can appear once as `Can/Retail` and once as
  `Can/Wholesale`. Open Price products may appear as separate lines with
  different cashier-entered prices.
- Stock validation is in base units. Example: 1 Case with `base_quantity=24`
  reserves 24 base units; with 25 base units in stock, only 1 single base
  unit remains available.
- **Cart row UI is minimal by design** (`src/components/pos/CartItemRow.tsx`):
  thumbnail, name on one line, unit name on its own line, price-level label,
  unit price, a price-level pencil when permitted, stacked qty controls, and
  a delete icon. The red over-quantity warning is still rendered inline when
  `stockStatus.exceedsStock` so cashiers see the problem without leaving
  the cart.
- Bills shows the item count plus an `All` button. `All` opens a modal with
  every cart line, useful when the bill panel is scrolled.
- Per-line item discount input is **hidden in the cart**. The cart-level
  Discount % below the bill totals is the only discount input cashiers
  reach. `sale_items.item_discount_pct` is still serialized when present
  on historical rows so old receipts/refunds render unchanged.
- Cart discount % applies after item discounts.
- Changing a fixed-price cart line's price level requires
  `pos:override_price`. The "Adjust price" modal shows the configured
  active price levels as **tabs** (Retail / Wholesale / Special), plus a
  manual price input that's seeded from the level's resolved price.
  Saving with the input differing from the resolved price flags the line
  as a manual override (`priceOverriddenBy = currentUserId`) and
  `complete_sale` records a `PRICE_OVERRIDE` audit row.
- Open Price products prompt for a positive unit price when added to cart.
  That cashier-entered price is sent to `complete_sale` and is required by
  the RPC.
- Selling below stock requires `pos:override_stock`.
- Non Stock products skip stock limits and do not require stock override.
- Tier pricing applies only to the default/base sellable unit. Non-default
  product units use their configured Product Unit price.

### Checkout

1. Cashier must have an open shift (`complete_sale` rejects otherwise).
2. Payment modal opens with `Amount received` defaulted to 0; Confirm is
   disabled until paid ≥ total.
3. Confirm calls `complete_sale(...)` — one atomic, permission-checked RPC.
   It validates auth, shop access, shift, products, price levels, Open Price
   client prices, inventory, stock, and override permissions; then inserts
   sale + sale items, decrements inventory for stock-tracked items, writes
   `SALE_OUT` movements for stock-tracked items, and writes the audit row.
4. On RPC success the cart clears, a success toast shows the receipt
   number, and the cashier stays on POS. F2 stops there; F3 also fires
   `window.print()` against a hidden `<ReceiptPreview>` portaled into
   `document.body` (~500 ms delay so the logo image loads). The
   `/app/sales/:saleId` page is no longer the forced landing route —
   it's still reachable from the Sales list, the receipt header link,
   and refund/void flows.

### Sale voucher + receipt + reprint

- `/app/sales/:saleId` renders the shared `ReceiptDetail` component. From
  the Sales list, the **View voucher** row action navigates here (the
  list no longer opens a slide-over drawer; `SaleDetailDrawer` is retained
  but unused).
- **On-screen the page shows a themed "Sales Voucher"**
  ([src/components/sales/SaleVoucher.tsx](../src/components/sales/SaleVoucher.tsx)),
  not the 80 mm receipt:
  - **Header strip:** receipt no + status badge + Date / Branch / Cashier / Payment.
  - **Line-item grid:** `# · Code · Description · Qty · Unit · Level · Sale Price · Amount`
    (`Code` = product SKU, falling back to alias code).
  - **Summary panel:** Total Amount + Qty, then Subtotal / Discount / Total / Paid / Change.
    Customer / FOC / outstanding-balance columns are intentionally absent —
    the data model has no customer entity and sales are paid in full at checkout.
- The 80 mm `ReceiptPreview` still lives on the page inside a
  `.print-only-host` wrapper (hidden on screen, revealed on print), so
  **Print** / **Reprint** output the thermal receipt exactly as before.
- The `drawer` variant of `ReceiptDetail` still renders the receipt
  inline (kept for any caller that mounts the drawer directly).
- The POS inline print (F3) renders `ReceiptPreview` directly via a
  portal — no navigation required. The print CSS isolates `.receipt`
  globally so the same component covers all contexts.
- **Print** calls `window.print()` directly; it does not log.
- **Reprint** is gated by `receipt:reprint`. It awaits `log_receipt_reprint`,
  then prints. The in-flight flag prevents duplicate log rows on rapid
  clicks. The button shows `Reprinting…` while pending; any RPC failure
  shows a toast and skips the print dialog.
- Receipt layout (see [src/components/pos/ReceiptPreview.tsx](../src/components/pos/ReceiptPreview.tsx)):
  - **Brand header:** logo + `Shwe PhaLar` brand name + per-shop name + address + phone + receipt number
  - **Meta block:** 6 stacked rows (Branch, Date, Cashier, Price level, Payment, Items) with a fixed-width label column so colons align
  - **Items table:** 4 columns — Description · Qty · Price · Amount — with a dashed rule above and below the header. Numbers are plain integers (no `MMK` per row)
  - **Totals:** Subtotal / Discount → dashed rule → **Total** (bumped to `text-sm` + semibold) → dashed rule → Paid / Change
  - **Footer:** Burmese thank-you (`ဝယ်ပြီးပစ္စည်းပြန်မလဲပါ။` + `ဝယ်ယူအားပေးမှုကို…`)
  - **Price level:** shown once in the meta block when every line is at the same level; falls back to a per-line label only for mixed-level receipts
- Printing isolates the 80 mm `.receipt` DOM via `src/print/receipt.css`
  (`@media print` hides everything else). See
  [06-ui-printing-hardware.md](./06-ui-printing-hardware.md) for the
  print-host portal trick, `display: contents` rule, and the
  `--kiosk-printing` Chrome flag.

### Sales history

- `/app/sales` is gated by `sales:view_own_shift` (cashiers have this).
- RLS narrows rows: a caller without `sale:view` only sees sales they rang
  up or sales in shifts they own.
- The client mirrors RLS: cashier filter hidden, "Void sale" swapped for
  "Request void", approve buttons hidden unless the caller has the
  corresponding `pos:refund` / `pos:void_sale`.
- **Scoped to the current month.** The list shows only the current calendar
  month (`This month · <Month Year>`); older months are not browsed here.
  Helpers in [src/features/sales/monthCycle.ts](../src/features/sales/monthCycle.ts).
- **Grouped by day, defaults to today.** Sales render in per-day sections,
  each with a header (date · sale count · NORMAL-sales total). The page opens
  on **today** (so it isn't one mixed blob); a **Filter by date** button
  opens a calendar (limited to the current month) to switch days or **show
  all days**.
- **Filters:** Search (receipt / product / cashier / amount) · Status · Cashier
  · the date-filter button. (The old free-form date-range picker was removed —
  the month scope + calendar replace it.)
- **Admin weekly-report countdown** (`WeeklyReportCountdown`) shows time to
  next Monday 00:00 Myanmar Time, when the all-shops weekly CSV auto-emails
  to every active admin. **Live** — a `pg_cron` job + `weekly-sales-report`
  Edge Function actually sends it now (see *Weekly Sales Report* in
  [07-setup-deployment.md](./07-setup-deployment.md#weekly-sales-report)).

## Shifts

### Who can open / close

`/app/shifts` is a single unified page for every role that holds
`shift:manage_own`. Both `open_shift` and `close_shift` (migration 009)
accept callers who hold `shift:manage_own` OR `shift:manage_all` for the
target shop — ADMIN and MANAGER hold both by default, CASHIER holds only
`manage_own`. Whoever opens the shift becomes its `cashier_id` (admin /
manager / cashier may all act as the cashier of record).

| Role | Open / close workflow | Target shop comes from |
| --- | --- | --- |
| ADMIN | Opens their own shift in the selected shop; can close visible open shifts when authorized by `shift:manage_all` | the shop switcher (explicit pick required for opening) |
| MANAGER | Opens their own shift in the assigned shop; can close visible open shifts in that shop when authorized by `shift:manage_all` | `users.shop_id` |
| CASHIER | Opens and closes only their own shift | `users.shop_id` |

ADMIN with no shop selected sees `Select a shop to open a shift. Pick one
from the shop switcher at the top of the page.` and the open-shift form
is hidden. The `open_shift` RPC also rejects a blank `shop_id` with
`Shop is required` (009:65). There is no auto-created fallback shop.

Backend enforces "one open shift per cashier globally" via the partial
unique index `shifts_one_open_per_cashier_shop` plus an advisory lock —
the same admin cannot have two open shifts in two different shops.

### Open

- `open_shift(p_shop_id, p_opening_cash_mmk)` writes `opening_cash_mmk`
  and `started_at`. `expected_cash_mmk`, `closing_cash_mmk`, and
  `variance_mmk` remain `NULL` until close.
- A shift is required for POS checkout.

### Close

- `close_shift(p_shift_id, p_closing_cash_mmk, p_variance_reason)`
  recomputes server-side:
  - `expected_cash = opening_cash + CASH sales (status<>VOID) − approved
    PARTIAL cash refunds against this shift's sales`
  - `variance = closing_cash − expected_cash`
- Closing cash is required by the UI and must be zero or greater. The input is
  a MMK numeric text field; pasted commas/currency symbols are stripped and
  leading zeroes are normalized.
- The UI previews variance before submit using `buildShiftBreakdown`. A
  non-zero variance opens an inline `Variance reason` field and the RPC also
  rejects if the reason is blank.
- MANAGER / ADMIN closing on behalf of someone else still has to satisfy
  `app_can_for_shop('shift:manage_all', shift.shop_id)` — `manage_own`
  alone is not enough.

### Active shift and summary UI

The active shift card shows cashier name, shop, opened date/time, live
duration, opening cash, cash sales, other sales, sales count, approved cash
refunds, expected cash, closing cash input, variance preview, variance reason
when needed, and the end-shift action. Live duration is `now - startedAt` and
ticks every 60 seconds.

Active card (`ShiftSummary`) and View summary modal (`ShiftDetail`) share two
cards, computed once by `buildShiftBreakdown(shift, shiftSales,
refundRequests)` in `features/shifts/service.ts`. The helper mirrors the
`close_shift` formula exactly, so the live preview converges with whatever
the RPC will write at close time.

- **Payment breakdown** — cash sales count + total, other sales count +
  total, approved cash refunds (when > 0), voided count (when > 0), total
  sales count.
- **Cash reconciliation** — opening, expected (live label
  `Expected cash (live)` while open), closing, variance. Closing and
  variance render as `Active` while open.

**View opens a dedicated page** at `/app/shifts/:shiftId`
([src/features/shifts/pages/ShiftDetailPage.tsx](../src/features/shifts/pages/ShiftDetailPage.tsx)) —
no modal. The page renders:

- The same `ShiftDetail` summary card (payment breakdown, cash reconciliation)
- **Items rollup** — aggregated product / qty / revenue across NORMAL
  sales in this shift (voided/refunded sales excluded so the totals match
  the cash drawer)
- **Sales table** — iStock-style columns: Time · Receipt · User · Payment ·
  Qty · Discount · Paid · Change · Total · Status · Actions. Each row
  has a chevron that expands a sub-table of line items
  (Product · Unit · Qty · Unit Price · Discount % · Line Total) so
  managers can drill into any receipt without leaving the page
- **Open-receipt icon** on each row → links to `/app/sales/:id` for the
  full sale voucher / receipt / refund / void flow
- **Close-shift card** at the bottom (only when the viewer can close
  this shift) — same `EndShiftCard` component that used to live in the
  modal

A hint appears for open shifts with non-cash-only sales:
*"Non-cash sales don't increase expected cash. Closing cash should match
opening cash."*

### Shift Records tab

Default tab of `/app/shifts`. Lists shifts the operator is allowed to
see — RLS (migration 015) is the authority, the client filter just
mirrors it:

| Role | Rows | Filters |
| --- | --- | --- |
| ADMIN | All shifts in all shops | Month/date, status, shop, user |
| MANAGER | Shifts in `users.shop_id` | Month/date, status, user |
| CASHIER | Own shifts (`cashier_id = self`) | Month/date, status |

Each row shows cashier, role, shop, start time, end time or `Active`, duration,
sales count, expected cash, closing cash, variance, status, and View. CSV export
uses the currently visible filter-applied records and includes: cashier, role,
shop, started_at, ended_at, duration, status, opening_cash, expected_cash,
closing_cash, variance, sales_count, and variance_reason. Hidden or out-of-scope
records are never exported.

### Work Hours tab

Driven by helpers in `src/features/shifts/workHours.ts`. Same
row-visibility scope as Records (RLS, mirrored by the client).

Sections:

1. **Active shifts** — cards for every currently-open shift visible to
   this operator, with a live `Xh Ym so far` calculated from
   `now - startedAt`. Ticks every 60 s.
2. **Monthly totals** — per `(user, shop)` for the picked month: shift
   count, open count, total hours.
3. **Daily records in <month>** — every shift in the picked month with
   started/ended/duration/status.

A `Total this month` chip in the filter row shows the sum of all visible
hours for the picked month.

**Attribution rule (MVP).** A shift is attributed to the local calendar
month its `startedAt` falls in. A shift that crosses midnight into a new
month still counts entirely for its starting month. This matches the way
`close_shift` anchors cash reconciliation on `opening_cash` captured at
`startedAt`. If you ever need to split duration across calendar months,
update `isShiftInMonth` / `getMonthlyShiftHoursMs` together with their
tests in `workHours.test.ts`.

**Durations.** Closed shift = `endedAt - startedAt`. Open shift =
`now - startedAt`. Negative / invalid dates clamp to `0`. Format is rounded
DOWN to the minute, with padded minutes once hours are present (`0h 12m`,
`2h 05m`). Invalid, negative, NaN, and Infinity values clamp to `0h 0m`.

## Inventory

- Stock is per-shop. The `inventory` table has composite PK
  `(shop_id, product_id)` — exactly one row per shop per product.
- **The DB stores base units only.** `inventory.qty_base_units` is an integer
  count of the smallest configured unit (Can, Sachet, Piece, ...) — never
  packages or cases. RPCs `complete_sale`, `receive_purchase_order`,
  `complete_stock_transfer`, and `adjust_stock` all write base units.
- **Display layer decomposes** to a human-friendly multi-tier label.
  `src/features/inventory/stockDisplay.ts` provides
  `decomposeBaseQuantity(baseQty, productUnits, productId)`,
  `formatStockQuantity(...)`, and `convertToBaseQuantity(qty, unit)`.
  Headline example: with units `[Package=24, Can=1]` and 214 base units in
  stock, `formatStockQuantity` returns `"8 Package 22 Can"`. The Inventory
  page renders the raw base-unit count as the primary line (`214 Can`) and
  the decomposed label as a faint secondary line — both come from the same
  214 in the DB. If the registry is empty for a product, the helper falls
  back to `<n> <product.unitType>`.
- Every stock change writes an `inventory_movements` row with
  `qty_before`, `qty_change`, `qty_after`. Movements are immutable.

Movement types:

| Type | Direction | Source |
| --- | --- | --- |
| `SALE_OUT` | − | `complete_sale` |
| `PURCHASE_IN` | + | `receive_purchase_order` |
| `TRANSFER_OUT` / `TRANSFER_IN` | − / + | `complete_stock_transfer` |
| `RETURN_IN` | + | refund / void approval |
| `ADJUSTMENT` | ± | `adjust_stock` (manual) |
| `DAMAGE` | − | `adjust_stock` (damage write-off) |

### Adjustment / damage

- Inventory page → Adjust Stock / Record Damage.
- `adjust_stock(...)` validates type, non-blank reason, non-zero delta,
  sign-vs-type consistency, permission (`inventory:adjust` or
  `inventory:damage`), and shop scope. It blocks negative stock unless the
  caller holds `inventory:override_negative` (NOT `pos:override_stock` —
  that's the POS-side override).
- **Unit-aware adjustment** (migration `028`). The RPC accepts optional
  `p_product_unit_id` + `p_unit_qty`; when set, server resolves the
  unit (must belong to the product and be active), computes
  `base_delta = sign(p_quantity_delta) × p_unit_qty × unit.base_quantity`,
  and writes that base delta to inventory plus the unit snapshot
  (`product_unit_id`, `unit_name_snapshot`, `unit_base_quantity_snapshot`,
  `selected_unit_quantity`) onto the `inventory_movements` row. Legacy
  callers that pass only the base-unit delta still work. The Adjust
  Stock modal renders a Unit dropdown when product_units are configured.
- Low-stock badge: `qtyBaseUnits <= lowStockThreshold`.
- Out-of-stock: `qtyBaseUnits <= 0` blocks POS sale unless
  `pos:override_stock`.

### Movement history

- `/app/inventory` Movements tab requires `inventory:view_movements`. A
  cashier with only `inventory:view_stock` sees current stock but not
  movement history. The SELECT RLS enforces this server-side as well.
- Movement rows render the base-unit delta as the primary line
  (`+240 Can`) and the snapshot as a faint sub-line (`Entered as 10
  Package`) when migration 028's snapshot columns are populated. Pre-028
  rows render just the base line — never recomputed from the live
  `product_units` registry, so old history stays accurate even if a
  unit's `base_quantity` is later edited.

## Purchase Orders + Supplier Debt

PO lifecycle: `DRAFT → SUBMITTED → APPROVED → RECEIVED`, with `CANCELED`
available from non-terminal states.

### Workflow

1. **Create.** `create_purchase_order(...)` — gated by `purchase:create`.
2. **Approve.** `approve_purchase_order(...)` — gated by
   `purchase:approve` (ADMIN by default; MANAGER does not approve).
3. **Receive.** `receive_purchase_order(p_purchase_order_id,
   p_received_items)` — gated by `purchase:receive`. Records received qty
   (partial supported), increases inventory, writes `PURCHASE_IN`
   movements, writes audit, sets PO `RECEIVED`. All in one transaction.
   **Unit-aware path** (migration `028`): each item in `p_received_items`
   may pass either `received_qty` (legacy base) or
   `{product_unit_id, received_unit_qty}` — the server resolves the
   sellable unit, validates it belongs to the product and is active,
   then computes `received_qty = received_unit_qty × unit.base_quantity`.
   The chosen unit + selected qty + base_quantity snapshot is persisted
   on `purchase_order_items` and `inventory_movements` so the ledger can
   render `+240 Can (entered as 10 Package)`. Inventory writes stay in
   base units.
4. **Cancel.** `cancel_purchase_order(...)` — non-terminal POs only.

### Supplier debt rule

**Supplier debt starts only when the PO is RECEIVED.** Draft / submitted /
approved / canceled POs add no debt.

- Outstanding balance = `purchase_orders.total_mmk − purchase_orders.paid_mmk`
  for RECEIVED POs only.
- Supplier debt = sum of outstanding balances across the supplier's
  RECEIVED POs.

### Payments

- `record_supplier_payment(p_purchase_order_id, p_amount_mmk,
  p_payment_method, p_reference_no, p_notes)` — gated by
  `supplier:payment_create` + shop scope.
- Validates: PO status `RECEIVED`, amount `> 0`, no overpayment.
- Inserts a `supplier_payments` row, updates `purchase_orders.paid_mmk` /
  `payment_status` (`UNPAID` / `PARTIAL` / `PAID`), writes audit.
- **Does not affect cashier shift cash, POS, sales, inventory movements,
  or shifts.**
- `void_supplier_payment(p_payment_id, p_reason)` (migration `039`) reverses a
  payment: subtracts it from the PO's `paid_mmk` (floored at 0), recomputes
  `payment_status`, and stamps `voided_at/by/reason`. Gated ADMIN or shop
  `supplier:payment_create`. Voided rows show struck-through on the Payments
  tab.
- `pay_supplier_lump_sum(...)` (migration `040`) takes one amount and a shop and
  allocates it across that supplier's RECEIVED unpaid POs **oldest-first**
  (`LEAST(remaining, balance)` per PO), writing one `supplier_payments` row per
  PO and never overpaying. Surfaced as the **Pay supplier** action with an
  allocation preview.
- PO debt is billed at **received value** (migration `037`): a short receive
  recomputes the PO total from `received × unit_cost`, so partial deliveries
  don't over-count debt.

### Supplier UI

- `/app/suppliers` — list with search, financial summary columns, and a
  "View details" navigation per row.
- `/app/suppliers/:supplierId` — full detail page. Header (Back / Edit
  supplier / **Pay supplier** lump-sum / Create purchase order), five summary
  cards (Outstanding debt, Received purchases, Paid, Unpaid/partial POs, Last
  purchase), and four tabs:
  - **Overview** — profile card + notes.
  - **Products** — the supplier⇄product links (migration `036`): add/remove
    which products this supplier supplies (gated `product:create`/`update`).
  - **Purchase Orders** — one card per PO with status / received /
    payment / next-step hint badges, Total / Paid / Balance money grid,
    and per-PO actions. Inline expand shows ordered/received qty, unit
    cost, line total, supplier invoice no, delivery note no, approved
    at/by, and the receiving-confirmation banner.
  - **Payments** — full-width table (date, PO #, amount, method,
    reference, notes, recorded by, status) with a **Void** action per
    non-voided row (`void_supplier_payment`).
- Per-PO actions follow `getPurchaseOrderActionState(po, user)`:

  | PO state | Next action button | Hint when user lacks permission |
  | --- | --- | --- |
  | DRAFT / SUBMITTED | **Approve** | "Needs approval" |
  | APPROVED | **Receive** | "Needs receiving" |
  | RECEIVED + balance > 0 | **Record payment** | "Needs payment" |
  | RECEIVED + paid | terminal | — |
  | CANCELED | terminal | — |
  | Non-terminal + has `purchase:create` | **Cancel PO** | hidden |

- Payment modal: amount defaults to outstanding balance; "Pay outstanding"
  quick-fill button; validates `0 < amount ≤ balance`; inline rose error
  banner on failure; modal refuses to close mid-submit.

## Stock Transfers

Lifecycle: `PENDING → APPROVED → IN_TRANSIT → COMPLETED`, with `CANCELED`
and `REJECTED` exits. Migration `038` split the old one-shot completion into
a **dispatch → receive** handshake so stock is held at the source until the
destination confirms what actually arrived.

Transfer creation is unit-aware. The UI lets the user choose a Product
Unit (`Can`, `Case`, `Package`, ...) and enter a quantity in that unit.
The preview shows the resulting base-unit quantity, but
`create_stock_transfer` (migration `029`) is the source of truth: it
validates the unit belongs to the product and is active, computes
`requested_qty = selected_unit_quantity x product_units.base_quantity`,
stores that base quantity, and snapshots `product_unit_id`,
`unit_name_snapshot`, `unit_base_quantity_snapshot`, and
`selected_unit_quantity` on `stock_transfer_items`.

Creation validates source stock in base units, aggregated by product
across all transfer lines. Example: with 25 cans available, `1 Case`
(`24`) plus `1 Can` is allowed, but `2 Case` (`48`) is rejected.

- **Create** at the source shop — `transfer:create`.
- **Approve / reject** at the destination shop — `transfer:approve`. Can
  adjust quantities (partial approval).
- **Dispatch** at the source shop — `dispatch_stock_transfer(...)`
  (`transfer:approve` on the source). Marks the transfer `IN_TRANSIT` and
  writes audit only; **inventory does not move yet** (hold-at-source), so a
  cancel before receipt needs no reversal.
- **Receive** at the destination shop — `receive_stock_transfer(p_transfer_id,
  p_received_items)` (`transfer:approve` on the destination). Moves the
  received quantity (≤ approved), advisory-locks both shops, rejects
  insufficient source stock, writes paired `TRANSFER_OUT` + `TRANSFER_IN`
  movements, updates both shops' stock, writes audit — all atomically.
  Receiving less than dispatched is allowed (short receive).
- **Cancel** pending transfers — `transfer:cancel`.

Receiving moves the stored base quantities and propagates the stored unit
snapshots into movement history, so the ledger can show `-48 Can` with
`Entered as 2 Case`. (`complete_stock_transfer` from migration `007` is
superseded by this two-step flow.)

## Refund / Void

- Cashier raises a request from the receipt screen
  (`create_refund_void_request`); gated by `pos:request_refund` /
  `pos:request_void`.
- Manager approves via `approve_refund_request` /
  `approve_void_request`; gated by `pos:refund` / `pos:void_sale`.
- Inventory restock + movements (`RETURN_IN`) + sale status update +
  audit row commit together.
- Reject via `reject_refund_void_request`.
- VOID restocks all items. PARTIAL restocks selected items by qty.

## Barcode Labels

- Route `/app/barcode-labels`, ADMIN + MANAGER only.
- The preview supports sellable-unit selection. Labels show product name,
  unit name, unit price, and barcode/SKU code.
- Default units may fall back to SKU when no barcode exists. Non-default
  units need their own barcode to print a scannable package label.
- Flow: select product → preview modal → confirm quantity (1–200) →
  choose template → live preview → **Print labels** mounts
  `BarcodePrintSheet` and calls `window.print()`.
- Templates: Compact 50×25mm, Standard 60×30mm (default), Price-focused
  60×30mm, Large 70×40mm — see `src/features/barcodes/labelTemplates.ts`.
- Barcode value: selected Product Unit barcode first; for the default unit
  only, fall back to `product.sku`; otherwise the selected unit cannot
  print a scannable label. Same rule as the POS scanner (see POS Barcode
  Scan above).
- Renderer: CODE128 via `BarcodeSvg`.

## Products / Categories / Pricing

### Products

- `/app/admin/products` is gated by `product:read` plus an ADMIN/MANAGER
  role gate. MANAGER can reach the page and edit products by default; Add
  Product is hidden without `product:create`, and Delete is hidden without
  `product:delete`.
- Product create/edit uses the full page form routes
  `/app/admin/products/new` (`product:create`) and
  `/app/admin/products/:productId/edit` (`product:update`).
- `products.sku` is required in the admin UI and is generated from the
  category prefix + sequential number (e.g. `BEE-001`) and read-only.
- Product quick fields include alias code, short name, max quantity, Open
  Price, Non Stock, and purchase type. Purchase type is surfaced as the
  default term hint in the PO create form.
- Product CSV export downloads the current product list with the active price
  level columns. Product CSV import parses the file, validates references and
  duplicates, shows a dry-run preview with create/update/error counts, then
  applies only valid rows.
- Sellable-unit barcodes are managed in the Product Unit rows via a dedicated
  `Scan barcode` button that opens `BarcodeScanModal`
  (`src/components/forms/BarcodeScanModal.tsx`). The scan modal auto-
  focuses a single input, refocuses on any blur, captures both Enter
  and Tab as scan terminators (event default + propagation stopped so
  the outer product form never accidentally submits), and offers an
  `Add manually` fallback for keyboard entry. On a successful capture
  it returns the normalized value to the page handler, which runs
  `checkBarcodeAddable` (in-form duplicate → cross-product duplicate)
  and either rejects (modal stays open, inline error) or appends to
  the target unit barcode field and toasts `Barcode added`. On save the
  page writes only what changed (`planProductBarcodeSave` →
  `applyProductBarcodeChanges`, `src/features/catalog/productBarcodeForm.ts`):
  the row behind an edited or cleared field is replaced or deleted; rows the
  user did not edit (including extra barcodes the form does not show) are
  never deleted or rewritten. The write still throws on the
  DB unique index
  `product_barcodes_unique_normalized_value` (migration 023) and shows
  `A barcode with this value is already linked to another product.`
  inline. Validation is normalize → trim + scanner control-char strip,
  length 4–64, no internal whitespace, case-insensitive uniqueness.
  The Product admin page is reachable with `product:read` plus the
  ADMIN/MANAGER role gate; save actions still require `product:create` or
  `product:update`, so CASHIER / BUYER use the catalog route instead.
- Product Units now replace fixed package-size behavior. Each product must
  have one active default sellable unit and may have more active units such
  as `6 Pack`, `Case`, or `Package`. Each unit stores base quantity,
  `sale_price_mmk` (Retail/default fallback, required to be positive in
  the form), an optional `purchase_price_mmk`
  (nullable, ≥ 0; used for per-unit cost / supplier debt as soon as the
  unit-aware purchase flow ships), default/active flags, and an optional
  barcode. The form writes new default-unit barcodes with
  `product_unit_id = null`; a default-unit barcode stored with the default
  unit's id (seed data, older imports) is equally valid and is shown, scanned
  and printed as the default unit's barcode. Non-default barcodes store the
  unit id. The default unit must always have
  `base_quantity = 1` — that's what makes it the "smallest" stock unit
  every other tier converts to. `validateProductUnits` enforces this on
  the form. Migration `027` is what split prices into two columns and
  backfilled `purchase_price_mmk` for default units from the legacy
  `products.cost_mmk`.
- Product images compressed `<= 100 KB` and uploaded to the
  `product-images` Storage bucket; the row stores only the public URL.
- A phone QR upload flow uses temporary one-time tokens — see
  [06-ui-printing-hardware.md](./06-ui-printing-hardware.md) and
  [`archive/31-product-images-storage-setup.md`](./archive/31-product-images-storage-setup.md).
- Replacing an image always creates a fresh Storage object (timestamped
  path) so cache invalidation is automatic. Orphan cleanup is a known
  follow-up.
- The old single `Pack Size` field is no longer shown in the Product
  create/edit form. Existing `products.pack_size` / `Product.packSize`
  data is legacy-only; new package selling uses Product Units.
- The Product create/edit form now groups product-specific unit conversion,
  purchase cost, Retail (Sale 1), Wholesale (Sale 2), Special (Sale 3),
  and barcode fields inside **Units & Prices** cards. The top-level
  product section no longer shows separate Selling Price / Cost Price
  inputs; legacy `products.price_mmk` and `products.cost_mmk` are synced
  from the default unit's Retail price and Purchase Cost for backward
  compatibility.
- The base/default unit card is locked to `base_quantity = 1` and explains
  `Base unit always equals 1 <unit type>`. Retail/default price is required
  for every active unit. Blank Wholesale/Special fields are intentionally
  not saved as `0`; they fall back to Retail during price resolution.
- **Hard delete** for products goes through the `delete_product(p_product_id)`
  RPC (migration `024`). Direct client deletes are blocked: `products`
  has no DELETE RLS policy, and `inventory` has all writes revoked
  from `authenticated` (see migration `010`). The RPC runs
  `SECURITY DEFINER`, checks `app_has_perm('product:delete')` (ADMIN
  by default), clears inventory rows for the product (the FK has no
  CASCADE), then deletes the product. `product_barcodes`, `price_tiers`,
  and `product_units` cascade automatically. The delete button is shown
  only to callers with `product:delete` and appears for both active and
  inactive rows in the admin Products page. Sale
  history (`sale_items`) keeps the loose `product_id` reference; historical
  reports still render the saved name/price snapshot.

### Categories

- Icon-based via `src/features/categories/categoryIcons.ts` (18 Material
  Symbols). `Category.iconKey` is persisted in `categories.icon_key`
  (migration `017`).
- **Safe delete.** A category cannot be deleted while products reference
  it. Both the UI and the `deleteCategory` store action enforce the rule
  via `getCategoryDeleteBlockMessage`. Products are never deleted or
  auto-reassigned.
- **Duplicate look check.** Creating or editing a category is blocked
  when another active category already uses the **same icon and the
  same color**. The check compares the *effective* icon key
  (`resolveCategoryIcon(iconKey, name)`), so an icon-less category that
  resolves its icon from its name still participates in the rule. The
  duplicate-name check still runs first. See
  `handleSaveCategory` in `src/pages/ProductsManagePage.tsx`.
- POS filter buttons and other selectors are store-driven; no hardcoded
  category list anywhere.

### Brands

- Brands are category-scoped rows from migration `031`. The Product admin
  page manages brands alongside categories.
- Products can store `brand_id`; product forms only show active brands for
  the selected category.
- Product Management, Catalog, and POS support brand sub-filters after a
  category is selected.

### Unit Types

- Admin-managed registry — Settings → **Unit Types**
  (`/app/admin/unit-types`, gated by `product:create`). Defines the
  **base stock unit** for a product (Piece, Can, Bottle, Sachet,
  Kilogram, Liter, ...). Backed by the `unit_types` table
  introduced in migration `025`.
- The Product create/edit Unit Type dropdown is dynamic and reads from
  `useDataStore().unitTypes` filtered to `isActive`, sorted by
  `sort_order` then `name`. Pre-registry products with a legacy value
  (`"piece"`, `"box"`, ...) still load: the form renders them as
  `Current: <value> (legacy)` or `Current: <name> (inactive)` so editing
  never silently changes a product's unit.
- Soft delete only. Deactivating a unit just flips `is_active`; products
  that still reference the name keep displaying it, but new products
  cannot pick it. Hard delete is intentionally not exposed.
- Validation mirrors the DB constraints (migration 025): case-insensitive
  unique name, case-insensitive unique abbreviation when present, name
  required. Shared helpers live in
  `src/features/unitTypes/unitTypeValidation.ts` (`validateUnitTypeForm`,
  `resolveProductUnit`).
- Unit type is the base stock unit label. Product Units are separate,
  product-specific sellable units. Inventory, purchases, transfers, and
  adjustments continue to use base units.

### Price Levels

- Product Unit controls stock deduction; Price Level controls the selling
  price for that unit. Example: selling `1 Package` at `Wholesale` deducts
  the package's base quantity but charges the Package / Wholesale price.
- Migration `030` adds `price_levels` and `product_unit_prices`. Seeded
  active levels are Retail (Sale 1, default), Wholesale (Sale 2), and
  Special (Sale 3). Product Unit cards render active levels dynamically as
  price columns.
- Retail/default price is required for every active unit. Wholesale and
  Special are optional; a blank optional price is not saved as `0` and
  falls back to Retail during price resolution.
- POS previews use the frontend resolver, but `complete_sale` is the final
  source of truth. It resolves shop-specific price, global price, default
  Retail fallback, then legacy `product_units.sale_price_mmk`, and writes
  price-level snapshots to `sale_items` for receipts/history.
- POS no longer has a page-level price-level selector. New cart lines start
  at the default level, and authorized users change a line from Bills with
  the pencil selector.

### Price tiers

- Quantity-based price breaks per product (and optionally per shop).
- Applies only to the default/base sellable unit. Non-default Product Units
  use their configured unit price until tier pricing is redesigned for
  product-specific units.
- Admin via `/app/admin/pricing` (gated by `pricing:manage`).
- Add / Edit modal uses the shared `ProductPicker` (image thumbnail,
  category icon fallback, SKU, category badge, base price, current shop
  stock; search matches name / SKU / barcode value / category, ignores
  punctuation).
- Validation rules: tiers cannot overlap for the same product/shop;
  `minQty >= 1`; `maxQty > minQty` (or null for unlimited); `priceMmk > 0`.
- Shop-specific tiers override global tiers for the same quantity range.
- Selecting an inactive product shows the inline error
  `Selected product is no longer available.` and keeps the modal open.

## No-Shop-Selected Policy (ADMIN)

The app never auto-creates a shop and never silently picks one for an
admin. Shop creation lives **only** in the Shops management page
(`/app/admin/shops` → `addShop` slice → direct `shops` INSERT gated by
`shop:create`). No login, bootstrap, `loadData`, dashboard, POS, shift,
or shop-switcher path creates a shop.

Shop names and shop codes are unique at the database level after
`lower(trim(...))` normalization. The Shops management form trims name,
code, and address before saving, blocks duplicate normalized names/codes
before submit, and maps database unique-index failures to friendly form
errors. Existing duplicate rows must be renamed manually before migration
`022_unique_normalized_shops.sql` can be applied; the app must not delete
or merge shop rows automatically because operational data may reference
those shop IDs.

Shop deletion is supported only for shops with no operational data. The
Delete button on `/app/admin/shops` is gated on `shop:delete` (ADMIN by
default) and pre-checks references across `users`, `inventory`, `shifts`,
`sales`, `purchase_orders`, `supplier_payments`, `stock_transfers`,
`price_tiers`, `refund_void_requests`, and `audit_logs` using the loaded
store data. If any references exist the button is disabled and a
`References: …` summary is shown. The DB FK constraints on `users`,
`inventory`, `supplier_payments`, and `price_tiers` are the final guard:
any leftover reference triggers Postgres `23503`, which the slice maps to
`This shop is still referenced by operational data.` and the form keeps
the row. The `currentShopId` is cleared if the deleted shop was selected.

`getEffectiveShopId(user, currentShopId, shops)` returns the admin's
explicitly-picked shop (or, for non-admins, their assigned `shopId`).
It returns **`""` when an admin has not picked a shop** — no `shops[0]`
fallback. Shop-scoped pages key off that:

| Page | No-shop behavior |
| --- | --- |
| POS (`/app/pos`) | Renders only `Select a shop to use POS. Sales and inventory are shop-specific.` |
| Shift (`/app/shifts`) | Renders only `Select a shop before opening a shift.` |
| Inventory (`/app/inventory`) | Shows a banner `Select a shop before adjusting inventory.` and disables the per-row Adjust action |
| Dashboard | Continues to render — admin uses its own "all / per-shop" toggle |
| Shop switcher | Shows `Select a shop` placeholder option (disabled once chosen) |

Backend RPCs reject blank shop_id explicitly so a frontend regression
never produces a corrupt row. The guard is in:

- `complete_sale` (`004`), `open_shift` (`009`), `adjust_stock` (`008`/`014`).
- `create_purchase_order` and `create_stock_transfer` (added in `021`).

POS cart safety: if the selected shop changes mid-session, the cart,
discount, payment modal, and price-override modal are all cleared. A
cart rung up against shop A can never check out against shop B.

## Dashboard

`/app/dashboard` is gated by `report:shop_sales`. ADMIN gets an all-shop
business dashboard with an All Shops / single-shop selector. MANAGER is
locked to the assigned shop and sees operational cards first. CASHIER
still has no default route access, but if `report:shop_sales` is granted
explicitly the page shows only own-shift data. BUYER has no dashboard by
default; if sales reporting is explicitly granted, the view remains
assigned-shop scoped and profit still requires `report:shop_profit`.

### Single source of truth for formulas

Every dashboard card/chart/table reads from pure helpers in
`src/features/dashboard/dashboardMetrics.ts` (covered by
`dashboardMetrics.test.ts`). The page does not inline KPI arithmetic.
The date range selector (`Today`, `Week`, `Month`) filters sales-based
cards/lists/charts; current-state action cards such as low stock,
approved PO receipts, open shifts, transfers, and supplier debt stay
visible until resolved.

### Card formulas

| Card / chart | Formula | Scope / gate |
| --- | --- | --- |
| Revenue / Today Revenue | `calculateNetRevenue = sum(sale.totalMmk) - approved PARTIAL refund amounts` for `NORMAL` sales in range | ADMIN all/selected shop; MANAGER assigned shop; CASHIER own shift only |
| Total Orders / Today Orders | `calculateSalesCount` of ranged `NORMAL` sales | VOID and REFUNDED excluded by `scopeSales` |
| Avg Order Value | `round(net revenue / order count)` | Returns 0 for empty data; whole MMK only |
| Profit / Margin | `revenue - calculateCostOfGoods`; margin = `profit / revenue * 100` | Requires `report:shop_profit`; ADMIN by default |
| Cost of goods | `calculateCostOfGoods` = `sum((sale item unit_cost_mmk_snapshot ?? current product.costMmk) * qty)` | Prefers the per-line cost captured at sale time (migration `041`); falls back to current product cost only for legacy rows |
| Revenue, Cost & Profit Trend | `calculateDailyRevenueCostProfitTrend`, grouped by day; revenue is net revenue, cost is current product-cost approximation, profit = revenue - cost | ADMIN analytics; requires `report:shop_profit`; All Shops aggregates, selected shop filters. Rendered as a 3-series smooth LineChart with compact chip legend top-right and MMK-formatted Y-axis ticks (`MMK 60k`); ranges with fewer than 2 grouped days show the data as dots with the hint `More days of sales are needed to show a trend.` (e.g. a single-day Today range with sales). Cost prefers the per-line `unit_cost_mmk_snapshot` (migration `041`), falling back to current `product.costMmk` for legacy rows. |
| Active Shift / Expected Cash | open shifts in scope; `opening cash + CASH sales(status != VOID) - approved PARTIAL cash refunds` | MANAGER assigned shop; ADMIN selected/all; CASHIER own shift |
| Action Needed | low stock + out of stock + requested approvals + approved PO receipts + pending transfers | Each sub-count is only rendered when the matching permission exists |
| Sales by Category | `calculateSalesByCategoryPercent`; `sum(sale_items.lineTotalMmk)` by `product.category`, then percent of category total | ADMIN all/selected shop; MANAGER assigned shop; line basis does not allocate cart-level discounts yet |
| Top Selling Products | `calculateTopProducts`, ranked by line revenue, limit 5 | Cost/profit columns are not shown unless `report:shop_profit` |
| Inventory Intelligence (Admin) | `useDashboardInsights` → stock health summary (healthy / low / out), fast / slow movers (last-7-day avg-daily-sales velocity), reorder suggestions (low + <=7d to stockout, OR out + had sales). Sales velocity window is fixed at 7 days regardless of the page range so "fast mover" stays comparable across range changes. Days-of-stock returns `null` for products with no recent sales (rendered as `n/a`, never a fake `999d`). Scope respects ADMIN All Shops vs selected shop via `metricShopId`. | Requires `report:shop_inventory`. Overlaps in spirit with the Action Queue counts (out / low) but kept because the card stands on its own and adds Fast/Slow Movers + Reorder Suggestions that aren't surfaced anywhere else. |
| Low Stock / Inventory Alerts | `calculateLowStock` per `(shop_id, product_id)` | Requires `report:shop_inventory`; all-shops never sums quantities across shops. **Fixed** — the *all-shops* path iterates existing `inventory` rows only, so a product with no row for a shop used to be invisible to it even though POS showed it "0 in stock" (POS defaults a missing row to 0). Migration `046` now auto-creates a qty-0 row for every active product × active shop combo via triggers on `products`/`shops` (covers creation and reactivation of either, for every insert path), so this gap can no longer recur. Pre-existing gaps: run [`supabase/backfill_inventory_rows.sql`](../supabase/backfill_inventory_rows.sql) once if you haven't already. |
| Pending Refund/Void Approvals | `refund_void_requests.status = REQUESTED` | Requires `approval:view` |
| Pending PO Receipts | `purchase_orders.status = APPROVED` | Requires `purchase:view`; receiving action still requires `purchase:receive` elsewhere |
| Pending Transfers | `stock_transfers.status = PENDING` where shop is source or destination | Requires `transfer:view` |
| Supplier Debt | RECEIVED POs only; `sum(totalMmk) - sum(paidMmk)`, floored at 0 | Requires `supplier:debt_view`; unpaid and partial received POs only |
| Cash vs Other Sales | ranged valid sales split by `paymentMethod` | Manager assigned shop |
| Shop Performance | per-shop revenue, orders, AOV, open shifts, debt; profit/margin if allowed | ADMIN dashboard |
| Revenue by Shop | Shop Performance revenue by shop | ADMIN dashboard |
| Active Staff / Open Shifts | open shifts decorated with user and shop | ADMIN dashboard |
| Recent Audit Activity | recent `audit_logs` in selected range/scope | Requires `audit:view_global` |
| Recent Sales | newest ranged valid sales in scope | No profit shown unless a profit-gated card explicitly renders it |

The Admin trend chart is profit-sensitive: revenue uses `sale.totalMmk`
for `NORMAL` sales, approved PARTIAL refunds are subtracted when present,
cost/investment uses the per-line `unit_cost_mmk_snapshot` captured at sale
time (falling back to current `products.costMmk` only for legacy rows), and
profit is `revenue - cost`. The dedicated **Profit report** fetches sales +
items for the full selected `[from, to]` range via `useRangedSales` (id-batched
direct query), so it isn't limited by the data store's most-recent-1000-sales
cache. Sales by Category is safe for managers because
it is sales mix only; it uses line totals and does not allocate cart-level
discounts back to categories yet.

### Shop scope per role

| Role | Sees |
| --- | --- |
| ADMIN | All Shops aggregate by default, or one selected shop |
| MANAGER | Assigned shop only; shop selector is disabled |
| CASHIER | No default access; if explicitly granted dashboard access, own shift / own sales only |
| BUYER | No default access; sales/profit remain hidden unless matching report permissions are explicitly granted |

### Sensitive card gating (mirrors RLS)

| Permission | Cards / columns gated |
| --- | --- |
| `report:shop_profit` | Profit, margin, cost, and any profit/cost columns |
| `report:shop_inventory` | Inventory Alerts / Low Stock |
| `supplier:debt_view` | Supplier Debt cards and debt groupings |
| `approval:view` | Pending refund/void approvals |
| `purchase:view` | Pending PO receipts |
| `transfer:view` | Pending transfers |
| `audit:view_global` | Recent Audit Activity |
| `report:shop_sales` | Route guard (entire dashboard) |

## User Management

`/app/admin/users` (ADMIN-only by route, gated by `user:create` /
`user:update` permissions in RLS). The form enforces, in this order, the
rules baked into migration `020`:

- **ADMIN role hidden once an admin exists.** Editing the existing admin
  is the only place ADMIN stays selectable.
- **MANAGER picker:** the shop dropdown disables any shop that already has
  an active manager *other than the row being edited* and shows the hint
  `This shop already has a manager. Deactivate or reassign the existing
  manager first.` next to it.
- **CASHIER picker:** the shop dropdown enables only shops with an active
  manager and shows `Manager: <name>` inline. Shops without a manager
  carry the hint `No active manager assigned`. If no shop has a manager
  yet, the picker shows `No shop has an active manager yet. Create a
  manager first.`
- **BUYER:** shop selection is required (shopless BUYER cannot do anything
  because the purchase permissions are shop-scoped).
- **Submit:** preflight validation runs first and shows a single inline
  error. If the DB still rejects the write (race conditions, stale UI),
  `mapUserFormError` from `src/features/admin/userFormErrors.ts`
  translates the Postgres / trigger error to the same canonical message
  set. The modal stays open on failure so the operator can fix the input
  and retry.
- **Deactivate / demote a manager:** the trigger blocks the change when
  the shop still has active cashiers (without another active manager to
  replace them). Friendly error: `Cannot remove the only manager of this
  shop while active cashiers remain. Reassign or deactivate the cashiers
  first, or assign another manager.`

## Admin Login Verification (2FA)

After an ADMIN passes `signInWithPassword`, they finish on a `/verify` page
before reaching the app. Non-admins are unaffected. `authStore` exposes
`adminVerified` (true when the Supabase session is `aal2` **or** an emailed
code was confirmed this browser session) and `hasTotp`; `RequireAuth` redirects
an unverified admin to `/verify`.

Two methods, **either** is sufficient:

- **Authenticator app (TOTP)** — Supabase native MFA (`supabase.auth.mfa.*`).
  Preferred when a factor is enrolled: enter the app's 6-digit code
  (`verifyTotpLogin`, which accepts **any** enrolled factor, so multiple phones
  work).
- **Emailed code** — when no app is set up (or via "Use email code instead"):
  the `admin-2fa` edge function generates a 6-digit code, stores only its
  SHA-256 hash in `admin_login_codes` (migration `042`) with a 10-minute
  expiry, and emails the plaintext via Resend. The page shows a live countdown
  + resend. Verified with `verifyAdminCode`.

The code input is a segmented 6-box field (`CodeCells`). Recovery for a lost
phone is the email path (no separate backup codes). Verified state persists per
browser session (sessionStorage) — a refresh stays in, a new session
re-verifies.

### Security page (device management)

`/app/security` (ADMIN) manages authenticator devices: list factors, **Add
device** (enroll → scan QR → confirm), and **Remove**. The page is itself
behind a fresh **re-verify gate** — opening it requires a current code (app or
email); leaving and returning re-locks it. Enrollment sets the issuer to the
business brand so the entry reads sensibly in the authenticator app.

## Business Profile (brand)

`/app/profile` (ADMIN) edits the app-wide business brand — logo (uploaded via
the shared product-image pipeline), business name, tagline, address, phone,
email — stored in the `business_profile` singleton (migration `043`, ADMIN-only
UPDATE). The **sidebar header** and **printed receipts** render the brand,
falling back to the built-in "Shwe PhaLar" name + static `/logo_real.png` when
unset. The login page stays on defaults (it renders pre-auth).

## Internationalization (English / Myanmar)

Every page renders through `useTranslation().t(section, key, vars?)` backed by
`src/i18n/translations.ts` (nested `en` / `my` objects). `t()` substitutes
`{placeholder}` vars, and Myanmar text is converted to Zawgyi on the fly when
the user picks that script (`unicodeToZawgyi`). The language + script toggle
lives in the sidebar footer and is persisted (`languageStore`).

## Daily Sales Email Report

Admin-only email button on `/app/sales`. Calls the `email-sales-report`
Supabase edge function which builds **one CSV per shop** for the report date
and emails them as attachments via Resend.

**Date-aware button.** The button targets the day the admin is viewing:
- Default (viewing today) → **"Email today's CSV"** → reports today.
- A different day picked in the calendar filter → **"Email \<date\> CSV"** →
  reports that day. Same flow, only `reportDate` changes
  (`buildDailySalesReportsByShop({ reportDate })`).

### Weekly sales report — shipped

The Sales page shows an admin countdown to next Monday for an **automatic
weekly** all-shops CSV email — and it actually sends now. **Email-only, no
delete** — sales are kept (so the monthly view and the dashboard stay
complete; the data is small, ~8–15 MB/month). A `pg_cron` job fires Sunday
17:30 UTC (== Monday 00:00 Myanmar Time) and calls the
`weekly-sales-report` Edge Function, which emails the previous week's
(Mon–Sun) per-shop CSVs to every active admin — same pattern as audit-log
rotation, minus the delete. It recomputes the exact week boundary from a
real Myanmar-time calendar Monday on every run, so a few minutes of cron
scheduling jitter can't shift sales into the wrong week's report. Setup
details in
[07-setup-deployment.md](./07-setup-deployment.md#weekly-sales-report).

### What the email contains

- Subject: `Shwe PhaLar daily sales report - <date>`
- One attachment per shop with sales on the date, filename pattern
  `daily-sales-{shopcode}-{YYYY-MM-DD}.csv`. Shops with zero sales are
  skipped (empty CSVs would just be noise)
- HTML body with a **Per-shop breakdown** table: Shop · Sales · CSV rows ·
  Attachment filename, plus a totals header
- **Incomplete-data notice** (amber banner) when any cashier shift is
  still open at send time — lists the cashier and branch for each open
  shift. The send is NOT blocked; the notice is informational so the
  admin sees the figures may not be the final end-of-day numbers
- A plain-text mirror of the same body for clients that prefer
  `text/plain`

### CSV columns (per attachment)

`Report Date`, `Branch`, `Branch Code`, `Receipt No`, `Sale Date Time`,
`Cashier Name`, `Cashier Email`, `Payment Method`, `Sale Status`,
`Receipt Line`, `Price Level`, `Product Name`, `Product SKU`,
`Product Alias`, `Unit`, `Quantity`, `Unit Price MMK`,
`Item Discount %`, `Line Total MMK`, `Subtotal MMK`, `Sale Discount MMK`,
`Cart Discount %`, `Total MMK`, `Paid MMK`, `Change MMK`.

### Code layout

- `src/features/sales/dailySalesReport.ts`:
  - `buildDailySalesReportsByShop(input)` → returns
    `{ reportDate, reportDateLabel, subject, shopReports, totalSaleCount, totalRowCount }`
  - `buildDailySalesReport(input)` — legacy single-CSV builder kept for
    other callers
  - `getOpenShiftReportNotice(shifts, users, shops)` — returns
    `{ openShiftCount, entries, summary }` or `null`. Pure informational;
    the edge function renders it as a banner
- `src/pages/SalesPage.tsx` — admin-only button calls
  `supabase.functions.invoke("email-sales-report", { body: { attachments, shopSummaries, openShiftNotice, ... } })`
- `supabase/functions/email-sales-report/index.ts` — Deno edge function:
  1. Validates the caller's auth token + looks them up in `users`
  2. Rejects unless `role = 'ADMIN'` AND `is_active = true`
  3. Renders text + HTML bodies, base64-encodes each CSV
  4. Posts to Resend's `/emails` endpoint
  5. Accepts both the new (`attachments` array) and legacy (`csv` + `filename`) payload shapes for back-compat

### Configuration

The edge function needs these Supabase secrets:

| Secret | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key (sender) |
| `REPORT_EMAIL_FROM` | "From" address — e.g. `Shwe PhaLar <onboarding@resend.dev>` on the Resend free tier, or a verified-domain address in production |

Plus the automatically-injected `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` (the function uses the service-role key to
read the `users` table past RLS).

See [07-setup-deployment.md](./07-setup-deployment.md) for the deploy
sequence (Resend signup → secrets → function deploy).

## Audit

- Every operational RPC writes its own `audit_logs` row in the same
  transaction.
- Direct INSERT/UPDATE/DELETE on `audit_logs` is revoked (migration `013`).
- Reads gated by RLS (see [03-database-security.md](./03-database-security.md)).
- `log_audit_event(...)` is the only RPC dedicated to logging
  admin/reference events; it forces `actor_id` to the authenticated user
  so authorship can't be spoofed.

### Audit log rotation (archive + auto-delete)

To keep the table bounded, the audit log self-rotates:

- A `pg_cron` job (every 5 min — see
  [`supabase/schedule_audit_rotation.sql`](../supabase/schedule_audit_rotation.sql))
  calls the `rotate-audit-log` Edge Function
  ([`supabase/functions/rotate-audit-log/index.ts`](../supabase/functions/rotate-audit-log/index.ts)).
- When `audit_logs` holds **≥ 200** rows, the function archives the **oldest
  200** to a CSV, emails it (via Resend) to **every active ADMIN with an
  email**, and **only then permanently deletes those exact rows**. Newer rows
  are kept, so the table stays under ~200 between runs.
- **Safety:** the delete runs strictly after Resend confirms the send and
  targets only the archived ids — a failed email (or no admin email on file)
  skips the delete, so nothing is ever lost; it retries next run.
- Auth: the function only accepts calls bearing the service-role key (the
  cron job supplies it). The delete works because migration `013` revokes
  audit writes from `authenticated` only, not `service_role`.
- Setup: deploy the function, set `RESEND_API_KEY` + `REPORT_EMAIL_FROM`, then
  run the schedule script — details in
  [07-setup-deployment.md](./07-setup-deployment.md#audit-log-rotation).
