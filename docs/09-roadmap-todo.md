# 09 · Roadmap & TODO

Open work, grouped by area.

## High Priority

- [x] **Admin 2FA — shipped (different design than originally scoped).**
      After the password check, ADMIN sign-in requires a second factor on a
      `/verify` page: an **authenticator-app (TOTP) code** if one is enrolled,
      otherwise a **6-digit emailed code** (10-min expiry). Built on Supabase
      native TOTP MFA (`supabase.auth.mfa.*`) for the app path and a service-
      role `admin-2fa` edge function + `admin_login_codes` table (migration
      `042`) for the email path. **No backup codes** — the email path is the
      recovery route ("Use email code instead"). Verified once per browser
      session (`adminVerified` = session `aal2` OR email flag). Admins manage
      devices (enroll / add a second phone / remove) on the in-app **Security**
      page, which is itself behind a fresh re-verify gate. `verifyTotpLogin`
      accepts **any** enrolled factor, so multiple phones work. Enrolled
      issuer is set to the brand. **Remaining (optional):** if session-level
      MFA enforcement on sensitive RLS writes is ever needed, add an `aal`
      claim check (today the gate is UI-level; the Supabase session is still
      live for an unverified admin).
- [x] **Auto-create inventory rows.** Migration `046` adds `AFTER INSERT OR
      UPDATE OF is_active` triggers on `products` and `shops` that
      SECURITY DEFINER-insert a qty-0 `inventory` row (`ON CONFLICT DO
      NOTHING`, so real stock is never touched) for every active
      product × active shop combination — covers new-product creation,
      new-shop creation, AND reactivation of either, uniformly for every
      insert path (UI, CSV import, seed script) since it lives at the DB
      level, not one call site. Verified live in a rolled-back transaction:
      inserting a test shop created rows for all 540 existing active
      products; inserting a test product created rows for every active
      shop with no duplicate for the pair reachable via both triggers.
      One-off backfill for pre-existing gaps:
      [`supabase/backfill_inventory_rows.sql`](../supabase/backfill_inventory_rows.sql)
      (run separately if not already done).
- [x] **Weekly sales report (auto-email) — shipped.** New
      `weekly-sales-report` Edge Function (mirrors `rotate-audit-log`'s
      cron-auth pattern and `dailySalesReport.ts`'s CSV column shape) plus
      a `pg_cron` job (`supabase/schedule_weekly_sales_report.sql`) firing
      Sunday 17:30 UTC == Monday 00:00 Asia/Yangon, matching what
      `WeeklyReportCountdown` already promised. Recomputes the exact MMT
      week boundary from a real calendar Monday every run (not "7 days
      before whenever cron happened to fire"), so a few minutes of cron
      jitter can't shift sales into the wrong week. Email-only, no delete.
      **Also found and fixed while wiring this up**: the *existing*
      `rotate-audit-log` cron job had never actually worked —
      `schedule_audit_rotation.sql` was run with its `<SERVICE_ROLE_KEY>`
      and `<PROJECT_REF>` placeholders never filled in, so every 5-minute
      run had been failing silently since it was first scheduled. Fixed
      and confirmed succeeding on its next real run.
- [x] **Live Supabase RLS/RPC verification — done 2026-08-25, found and
      fixed a critical bug.** Ran the full
      [`archive/29-live-supabase-rls-rpc-verification.md`](./archive/29-live-supabase-rls-rpc-verification.md)
      checklist against the live production project (throwaway QA
      fixtures for scenarios real data couldn't cover, deleted after —
      see that doc's Manual Result Log for the full method). **Found: 20
      tables (`sales`, `shifts`, `purchase_orders`, `supplier_payments`,
      `audit_logs`, `inventory_movements`, `users`, `suppliers`,
      `stock_transfers`, `refund_void_requests`, `reprint_logs`, and 9
      more) still had a leftover `authenticated_all USING (true)` policy
      alongside the real permission/shop-scoped policy, silently
      defeating it for reads — confirmed live, a plain CASHIER test
      account could read the entire `supplier_payments` table.** Fixed by
      migration `050` (applied to production, re-confirmed closed
      live). Also found and since fixed (see below): MANAGER lacked
      `purchase:approve`/`transfer:cancel` by default, making the single
      ADMIN account a bottleneck for both.
- [x] **Fixed (2026-08-27) — ADMIN bottleneck on PO approval / transfer
      cancellation.** Confirmed with a concrete example first: a PO's
      goods can physically arrive, but nothing could log them as received
      stock until the PO moved `DRAFT`→`APPROVED`, which only the ADMIN
      login could do — a real "business stalls until ADMIN is reachable"
      gap, not just a permissions nitpick. Migration `057` grants MANAGER
      both permissions, but not identically: `purchase:approve` ships
      with a self-approval guard (`IF v_po.created_by = v_user.id THEN
      RAISE EXCEPTION` — same pattern as migration `053`'s refund/void
      fix, full function body copied from migration `012` with just that
      one guard added) since approving a purchase is a real financial
      commitment worth a second person's eyes; `transfer:cancel` ships
      with **no** guard, since canceling is an undo on an internal stock
      movement the manager already fully owns, not an external
      commitment — requiring a second person to undo your own mistake is
      pure friction there. `src/types/domain.ts`'s
      `DEFAULT_ROLE_PERMISSIONS` mirror updated to match. No frontend
      code changes needed beyond that: `PurchasesPage.tsx`'s Approve
      button already gates on `canApprovePurchaseOrder()` (a real
      permission check, not a hardcoded role check) and
      `TransfersPage.tsx`'s Cancel button was already shown
      unconditionally, relying on the RPC to gate it — both automatically
      picked up the new grant with zero UI edits. Verified against a
      rolled-back production transaction first (a MANAGER approving a
      *different* creator's PO succeeds; approving their *own* PO is
      correctly rejected; canceling their own transfer succeeds), applied
      to production, confirmed live.
- [x] **Permission-gated SELECT verification — done 2026-08-25, same
      pass as above.** Ran
      [`archive/30-rls-permission-gating-checklist.md`](./archive/30-rls-permission-gating-checklist.md)
      against production; this is the checklist that specifically caught
      the finding above (the CASHIER/`supplier_payments` check). See that
      doc for the per-role checklist results.
- [x] **System-wide error-handling polish.** Central utility is in place
      (`src/lib/errors.ts`, ErrorBoundary, `loadData` Retry). **Note:**
      `useAsyncAction` never actually existed as a hook — it was only
      mentioned in two code comments as an aspirational pattern. The real
      remaining gap was blocking `alert()` popups for async-action errors
      in `InventoryPage.tsx`, `TransfersPage.tsx` (5 sites),
      `PricingPage.tsx` (2 sites), and `ProductsManagePage.tsx` (3 sites) —
      all now route through the same `useToast()` + `getErrorMessage()`
      pattern already used in `SupplierDetailPage.tsx`/`ProductFormPage.tsx`.
      Also fixed a genuine leftover raw-error leak the earlier security
      pass missed: `ProductsManagePage.tsx`'s delete-category handler was
      showing `e.message` directly instead of routing through
      `getErrorMessage()`. Synchronous validation `alert()`s (duplicate
      name, no-stock, delete-blocked, etc.) were left as-is — not part of
      this item. Checked the two named detail-page fetch-error gaps and
      neither exists today: `SaleDetailPage.tsx` has no separate fetch (all
      data comes from the bootstrap-loaded store), and
      `SupplierDetailPage.tsx`'s action handlers already used
      `toast()`/`getErrorMessage()`, not `alert()`.
- [x] **Supplier workflow polish.** `create_supplier`/`update_supplier`
      (migration `048`, applied to production) are now `SECURITY DEFINER`
      RPCs — permission check, the write, and a `SUPPLIER_CREATED`/
      `SUPPLIER_UPDATED` audit row (with a per-field change list, e.g.
      "Changed: name, notes, deactivated") all in one transaction, global
      entity so `shop_id` is `NULL`. `purchaseSlice.ts`/
      `SupplierFormModal.tsx` call the RPCs directly (server now mints the
      id). Verified end-to-end against a rolled-back production
      transaction before applying — caught and fixed two real bugs in the
      process: a `text[] || 'literal'` operator-ambiguity crash in the
      change-tracking logic (fixed with `array_append`), and a reference to
      `suppliers.updated_at`, a column migration `044` was supposed to add
      but was never actually applied to this production project (the
      column doesn't exist yet — flagged separately, not fixed here to
      keep this migration scoped). `SuppliersPage.tsx`'s deactivate flow
      now warns with the outstanding balance/PO count
      (`getSupplierPurchaseOrders`/`getPurchaseOrderBalanceMmk` from
      `debt.ts`) before deactivating a supplier with unpaid RECEIVED POs;
      reactivating never prompts.
- [x] **User-management RPCs + atomic manager replacement.** Migration
      `049` (applied to production) adds `create_app_user`/
      `update_app_user`/`deactivate_app_user` as `SECURITY DEFINER` RPCs
      — permission check, the write, and a `USER_CREATED`/`USER_UPDATED`
      (with a per-field change list)/`USER_ACTIVATED`/`USER_DEACTIVATED`
      audit row, mirroring migration `048`'s supplier RPCs. These do
      **not** touch Supabase Auth signup (`supabase.auth.signUp` stays
      client-side in `UsersPage.tsx` — a SQL function can't call the
      GoTrue API); `create_app_user` is called after signup succeeds,
      same as the old `addUser()` was.
      Also ships `replace_manager(shop_id, new_manager_id)`, closing the
      gap `05-roles-permissions.md` flagged. The real blocker turned out
      deeper than expected — verified empirically against a rolled-back
      production transaction before writing the migration: (1)
      `users_one_active_manager_per_shop` was a **partial** unique index,
      which Postgres won't let you convert straight to a deferrable
      constraint (`ADD CONSTRAINT ... USING INDEX` rejects partial
      indexes) — fixed by replacing it with an equivalent `DEFERRABLE
      INITIALLY DEFERRED` `EXCLUDE` constraint instead, which does support
      a `WHERE` predicate; (2) a single multi-row `UPDATE` that swaps both
      the old and new manager in one statement does **not** work, because
      migration `020`'s safety trigger does a live `EXISTS` check that
      can't see another row's change from later in the *same* statement —
      `replace_manager()` does it as two separate statements instead (new
      manager first, old manager second), which a real test confirmed
      works correctly. The pre-existing protection (blocking a *plain*
      deactivate of a shop's sole manager while active cashiers remain,
      outside of `replace_manager`) was re-verified unchanged.
      `users_one_active_manager_per_shop`'s violation code changed from
      `23505` to `23P01` (unique → exclusion constraint) —
      `userFormErrors.ts` updated to still map it.
      `UsersPage.tsx` gained a "Replace manager" button, shown when
      editing an existing user into MANAGER for a shop that already has a
      different active manager.
- [x] **Seed tooling cleanup.** `src/data/seed.ts`/`seedSupabase.ts` (both
      previously unreferenced anywhere in the app) moved to `scripts/seed/`
      — outside `tsconfig.app.json`'s `src` include, so they can never be
      pulled into the browser bundle even by an accidental future import.
      Split into `seedData.ts` (data), `seedRun.ts` (shared insert
      sequence, parameterized on the Supabase client), `seedBrowser.ts`
      (the original guarded anon-key variant), and a new
      `seedServiceRole.ts` (`npm run seed:service-role`) that seeds via a
      service-role key from the environment — no dev server or browser
      opt-in flag needed. Added `tsx` as a devDependency to run it.
- [x] **Code splitting.** `src/app/routes/AppRouter.tsx`'s admin pages
      (Shops, Users, Products, UnitTypes, Barcodes, Suppliers, Pricing,
      AuditLog, SyncConflicts), reports (Shop/Global/Profit), and the
      Product Form page now load via `React.lazy` + a single `<Suspense>`
      wrapper around the route tree. Main entry chunk dropped from
      1,768 KB to ~1,566 KB (gzip ~432 KB), with 12 routes split into
      their own on-demand chunks. POS, Dashboard, and Login stay eager.

## Security (from 2026-08-24 full-codebase audit)

Findings from a defensive security pass across the Supabase backend, client
auth/session/offline layer, general app hygiene, and the Electron desktop
app. Ordered by severity; each was independently verified with a concrete
exploit/failure path, not speculative. See the audit conversation for full
per-area detail if more context is needed before fixing.

**2026-08-25 status:** every item below, including the `users` table
read-scoping question, is now implemented, committed, pushed to `main`,
and **live in production**.
Migrations `051`–`055` were applied via `supabase db push` and confirmed
applied (`supabase migration list` shows all five with a matching `remote`
timestamp), then spot-checked live: `authenticated` can no longer execute
the legacy `complete_stock_transfer`; `products_name_max_length`/
`products_sku_max_length` CHECK constraints exist; `approve_refund_request`/
`approve_void_request` both carry the self-approval guard; `log_audit_event`
hard-codes `shop_id = NULL` regardless of caller input and enforces the
action-type allow-list; all 8 affected offline-write RPCs accept
`p_expected_actor_id`.

- [x] **Fixed — read-scoping silently defeated on 20 tables via a
      leftover permissive RLS policy.** Found during the 2026-08-25 live
      RLS/RPC verification pass (not the 2026-08-24 audit that seeded the
      rest of this list — added here since it belongs with the other
      RLS findings). `sales`, `shifts`, `purchase_orders`,
      `supplier_payments`, `audit_logs`, `inventory_movements`, `users`,
      `suppliers`, `stock_transfers`, `refund_void_requests`,
      `reprint_logs`, `sale_items`, `stock_transfer_items`,
      `purchase_order_items`, `categories`, `products`, `inventory`,
      `price_tiers`, `product_barcodes`, `shops` each still carried a
      leftover `authenticated_all FOR ALL TO authenticated USING (true)`
      policy alongside the real permission/shop-scoped policy —
      PostgreSQL ORs multiple permissive policies together, so the
      unconditional one silently made the real one a no-op for every
      read. Confirmed live: a test CASHIER account with no
      `purchase:view`/`supplier:debt_view` could read the full
      `supplier_payments` table (real debt/payment amounts); a test
      MANAGER could read another shop's `audit_logs`/
      `inventory_movements`. Writes were unaffected (already blocked by
      table-level `REVOKE`, confirmed separately). Root cause: migration
      `010` already contains the correct `DROP POLICY IF EXISTS
      "authenticated_all"` cleanup for a few tables, but that cleanup
      evidently never fully landed on this production project for the
      other 20 — same class of gap as the `suppliers.updated_at`/
      migration `044` discrepancy found while building migration `048`.
      Fixed by migration `050` — drops the stale policy on all 20
      tables, verified against a rolled-back production transaction
      before applying (confirmed the leak closes while every role's
      legitimate access is unchanged), applied to production, and
      re-confirmed closed live. See
      [`archive/29-live-supabase-rls-rpc-verification.md`](./archive/29-live-supabase-rls-rpc-verification.md)'s
      Manual Result Log for the full writeup.
- [x] **Implemented (2026-08-25) — deactivated/revoked staff could keep
      completing real offline sales for up to 24h.** `authStore.ts`'s
      24h `OFFLINE_SESSION_TRUST_MS` (read-only session continuity) is now
      split from a much shorter `OFFLINE_WRITE_TRUST_MS` (2h) that
      specifically gates *new* offline writes. A new
      `assertOfflineWriteEligible()` throws "Reconnect to the internet..."
      if the device hasn't confirmed its identity against the live server
      within that 2h window; it's called as the very first line — before
      any local optimistic write — in all 9 offline-write functions
      (`createSaleOffline`, `createRefundVoidRequestOffline`,
      `adjustStockOffline`, `startShiftOffline`, `endShiftOffline`,
      `dispatchTransferOffline`, `receiveTransferOffline`,
      `receivePurchaseOrderOffline`, `recordSupplierPaymentOffline`).
      Read-only cached-data browsing is unaffected — only new writes are
      gated. Purely client-side, no migration. Full test suite (652)
      updated and passing. **Committed and pushed (commit `49f238e`);
      shipped in the Electron v1.0.14 release.**
- [x] **Implemented (2026-08-25) — offline outbox could misattribute
      actions on a shared till.** `stores/data/outbox.ts`'s
      `enqueueOutbox()` now automatically stamps the queuing user's app id
      onto every outbox entry for the 8 affected RPCs (`adjust_stock`,
      `receive_purchase_order`, `record_supplier_payment`, `open_shift`,
      `close_shift`, `create_refund_void_request`,
      `dispatch_stock_transfer`, `receive_stock_transfer` —
      `complete_sale` excluded, already safe via its own shift-ownership
      check). Migration `055` adds a `p_expected_actor_id text DEFAULT
      NULL` param to each; a mismatch at replay time raises, and the entry
      lands on the existing Sync Conflicts page instead of silently
      executing under whoever is now logged in. Dry-run verified against
      a rolled-back production transaction (all 5 new migrations applied
      cleanly together). **Applied to production and confirmed live**:
      `adjust_stock`, `open_shift`, `dispatch_stock_transfer`,
      `record_supplier_payment`, `receive_purchase_order`, `close_shift`,
      `create_refund_void_request`, and `receive_stock_transfer` all
      accept `p_expected_actor_id`.
- [x] **Fixed — `users_upd`/`users_ins` privilege-escalation gap.**
      Migration `047` adds a `BEFORE INSERT OR UPDATE ON users` trigger
      (`guard_user_privilege_columns()`) that rejects any change to
      `role`, `granted_permissions`, `revoked_permissions`, or the
      deprecated legacy `permissions` column unless the caller is
      genuinely ADMIN (`app_role()`) — covers both the originally-flagged
      UPDATE path (a delegated `user:update` holder self-escalating) and a
      second vector found while fixing it: `users_ins`'s `WITH CHECK` has
      the same shape, so a delegated `user:create` holder (a much more
      plausible grant — "let this manager onboard staff") could otherwise
      INSERT a brand new row with `role='ADMIN'` outright. `is_active` is
      deliberately NOT guarded — deactivating/reactivating doesn't grant
      capability, and a deactivated caller's own permission checks already
      fail immediately (see the migration's own comment for the full
      reasoning). The first-ever user (bootstrap) is exempted, mirroring
      `users_ins`'s existing escape hatch. A genuine ADMIN is unaffected
      either way. Verified live in a rolled-back transaction: an UPDATE
      attempting `role='ADMIN'` from a non-admin context raised "Only an
      ADMIN can change role or permission overrides." exactly as designed.
- [x] **Implemented (2026-08-25) — `log_audit_event` RPC let any
      authenticated user forge audit entries for any shop**
      (`supabase/migrations/012_operational_status_rpcs.sql:586-611`).
      Migration `051` allow-lists the 7 legitimate action types (the
      global product/category/unit-type catalog actions — the only real
      callers, in `auditSlice.ts`), maps each to the same permission that
      already gates the corresponding UI action, and ignores any
      caller-supplied `p_shop_id` (forces `NULL`, since every legitimate
      use is global/unscoped anyway). **Applied to production and
      confirmed live**: the deployed function body no longer even
      references the caller-supplied `p_shop_id` — it hard-codes `NULL`
      in the `INSERT` unconditionally.
- [x] **Implemented (2026-08-25) — `logout()` didn't clear the shared
      Zustand/Dexie data mirror.** `authStore.ts`'s `logout()` now resets
      the data store (`isLoaded: false, isLoading: false, loadError:
      null`) via a dynamic import of `dataStore` (static import would
      create a module cycle — `purchaseSlice.ts` already imports
      `authStore.ts`). `AppLayout.tsx`'s existing `loadData` effect
      re-fires automatically on the next render since it depends on
      `isLoaded`, so a different user logging in right after gets a fresh
      fetch instead of a stale render. Purely client-side, no migration.
      **Committed and pushed (commit `49f238e`); shipped in the Electron
      v1.0.14 release.**
- [x] **Fixed — raw Postgres/Supabase error text shown to cashier-level
      users.** `PosPage.tsx` checkout, `InventoryPage.tsx` stock
      adjustment, `TransfersPage.tsx` (create/approve/reject/dispatch/
      cancel), `PricingPage.tsx` (save/delete/toggle), and
      `PhoneProductImageUploadPage.tsx` (session load + upload) all now
      route through `reportError()`/`getErrorMessage()` from
      `src/lib/errors.ts` instead of dumping `error.message` straight
      into an alert/toast — schema/constraint details stay in the
      console; the user sees a friendly mapped message, or the original
      text only when it already reads like a clean business-rule message
      (e.g. an RPC's own "Open a shift before checkout.").
- [x] **Fixed — Electron's `shell.openExternal` now scheme-restricted to
      `https:`** (`electron/main.cjs`'s `setWindowOpenHandler`). A
      malformed URL is caught and simply not opened rather than passed to
      the OS opener.
- [x] **Fixed — CSV export formula injection.** `src/lib/csv.ts`'s
      `toCsv()` (and the equivalent `csvCell()` helpers duplicated in the
      `rotate-audit-log` and `weekly-sales-report` Edge Functions — Deno
      functions can't import from `src/`) now prefix a **string** cell
      starting with `=`/`+`/`-`/`@`/tab/CR with a `'`, forcing Excel/Sheets
      to treat it as text instead of a formula. Scoped to `typeof value
      === "string"` specifically so real negative numbers (prices,
      quantity deltas) are never touched. Tests: `src/lib/csv.test.ts`.
- [x] **Implemented (2026-08-25) — no max-length on product name/SKU**
      (`ProductFormPage.tsx:173`). Client-side: zod schema caps `name` at
      200 chars / `sku` at 64 chars (with matching English/Burmese error
      strings), plus a `maxLength={200}` on the name input. Migration
      `054` adds matching DB `CHECK` constraints (`products_name_max_length`,
      `products_sku_max_length`) — confirmed no existing row would violate
      them (`max(length(name))=21`, `max(length(sku))=7` in production
      today) before writing the migration. **Applied to production and
      confirmed live**: both `products_name_max_length` and
      `products_sku_max_length` CHECK constraints exist on `products`.
- [x] **Implemented (2026-08-25) — `printers:print-receipt`'s `deviceName`
      wasn't validated against the real printer list** before being passed
      to `webContents.print()` (`electron/main.cjs`). Now cross-checked
      against `getPrintersAsync()` output first; an unknown/disconnected
      printer name returns a clean error instead of being passed through.
      **Committed and pushed (commit `49f238e`); shipped in the Electron
      v1.0.14 release.**
- [x] **Implemented (2026-08-25) — no Content-Security-Policy for the
      Electron-loaded content.** Added a meta-tag CSP to `index.html`
      (`script-src 'self'` — no `unsafe-inline`; `style-src` keeps
      `unsafe-inline` since Tailwind/inline styles need it, much lower risk
      than script injection; `connect-src 'self' https: wss:` since the
      Supabase project URL is deployment-specific and can't be hardcoded).
      Required moving the theme-resolution inline `<script>` to an external
      `public/theme-init.js`, since an inline script can't run under
      `script-src 'self'`. Verified in a real headless-browser pass (both
      light and dark `prefers-color-scheme`) against a production build —
      zero console errors, zero CSP violations, fonts/JS/dark-mode all
      render correctly. Same `index.html` serves both the web build and
      the Electron-loaded content, so one change covers both.
      **Committed and pushed (commit `49f238e`); shipped in the Electron
      v1.0.14 release. Live on the web build once Vercel deploys from
      `main` — not independently verified from this session.**
- [x] **Implemented (2026-08-25) — legacy `complete_stock_transfer` RPC
      was still executable**, bypassing the newer two-step
      `dispatch_stock_transfer` → `receive_stock_transfer` maker-checker
      flow it was meant to replace (migration `038`). Migration `052`
      revokes `EXECUTE` from `authenticated`. **Applied to production and
      confirmed live**: `has_function_privilege('authenticated', ...,
      'EXECUTE')` returns `false` for `complete_stock_transfer`.
- [x] **Implemented (2026-08-25) — a manager could approve their own
      refund/void request** — no independent second-approver check in
      `approve_refund_request` / `approve_void_request`
      (`supabase/migrations/005_refund_void_rpc.sql`). Migration `053`
      adds `IF v_request.created_by = v_user.id THEN RAISE EXCEPTION...`
      to both (applied uniformly, including ADMIN — no role is exempted).
      Full function bodies re-created byte-for-byte from migration 005
      with just the one guard added, following the same
      DROP-then-CREATE-OR-REPLACE pattern established migrations already
      use for signature-compatible redefinitions. **Applied to production
      and confirmed live**: both deployed functions' source contains the
      `created_by = v_user.id` self-approval check.
- [x] **Decided and fixed (2026-08-25) — `users` table reads scoped to
      same-shop + self.** Was `users_sel USING (true)` (migrations
      `010`/`015`) — any authenticated CASHIER/BUYER with devtools could
      read every other shop's staff roles, active flags, and permission
      overrides. Product decision: restrict rather than keep global.
      Migration `056` replaces the policy: a user can read their own row,
      any row in their own shop, any ADMIN row (there's normally exactly
      one, per migration `020`'s `users_only_one_admin` constraint), or
      everything if they're ADMIN themselves. The "always see ADMIN rows"
      clause was added beyond the original ask to avoid a real regression:
      ADMIN acts across every shop, so without it any UI resolving an
      actor id to a display name (audit log, "approved by") would show a
      blank name whenever the actor was the ADMIN and the viewer was a
      non-admin in a different shop. Verified no leftover permissive
      policy existed on `users` before applying (the same class of bug
      migration `050` fixed elsewhere), dry-run verified in a rolled-back
      production transaction, applied, and confirmed live via
      `pg_policies`. Full test suite (652) still passing.

## Medium Priority

- [x] **Flexible sellable units (per-product).** Migration 026 adds
      `product_units`, unit-linked barcodes, sale item unit snapshots, and
      POS deduction by base units. `products.pack_size` remains legacy-only.
      Follow-up: deeper refund UX for mixed units of the same product and
      full browser/real-scanner QA.
- [x] **Unit-aware purchase receiving + stock adjustment.** Migration
      `028` extends `receive_purchase_order` and `adjust_stock` to accept
      `{product_unit_id, unit_qty}`; server validates the unit belongs to
      the product, computes `base_qty = unit_qty × unit.base_quantity`,
      and writes a snapshot (`product_unit_id`, `unit_name_snapshot`,
      `unit_base_quantity_snapshot`, `selected_unit_quantity`) onto the
      `*_items` row and the `inventory_movements` row. Inventory writes
      remain in base units. UI: Purchase Receive modal + Adjust Stock
      modal both render a Unit dropdown with a base-quantity preview.
- [x] **Unit-aware stock transfer creation.** Migration `029` updates
      `create_stock_transfer` to accept `{product_unit_id,
      selected_unit_quantity}` per line, validate active unit ownership,
      compute base requested quantity server-side, store unit snapshots on
      `stock_transfer_items`, and validate combined source stock in base
      units. Transfer completion from migration `028` propagates those
      snapshots into both movement rows.
- [x] **Unit-aware barcode label printing.** Barcode Labels can select a
      Product Unit, print unit name + price, use unit-specific barcodes,
      and fall back to SKU for default-unit labels only.
- [x] **Product Units & Prices form UX.** Product create/edit no longer
      exposes duplicate top-level Selling Price / Cost Price inputs. Pricing
      lives on unit cards: Purchase Cost, Retail (Sale 1), Wholesale
      (Sale 2), Special (Sale 3), barcode, and base-unit conversion.
      Legacy `products.price_mmk` / `cost_mmk` stay synced from the default
      unit for fallback compatibility.
- [x] **Brands + product quick fields.** Brands are category-scoped catalog
      rows; products now carry alias code, short name, max quantity,
      Open Price, Non Stock, and purchase type.
- [x] **Open Price + Non Stock POS behavior.** POS prompts for Open Price
      unit prices, bypasses stock guards for Non Stock products, and
      `complete_sale` enforces both flags server-side.
- [x] **Product CSV import/export.** Product Management exports the current
      product data with active price-level columns and imports through a
      validation + dry-run preview before writes.
- [x] **POS Bills polish.** Bills has line-level price-level selection,
      icon-only delete, stacked quantity controls, separate name/unit lines,
      and an `All` modal for the full cart.
- [~] **Flow tests (store + mocked Supabase) added; Playwright still open.**
      Critical flows now have integration-style tests that drive the data-store
      actions with the Supabase client mocked: POS checkout (`complete_sale`
      payload/price branches/reconcile), PO receive, transfer
      dispatch/receive, and refund/void approval. A full browser-level
      Playwright suite for the workflows in
      [08-testing-qa.md](./08-testing-qa.md) is still the remaining piece.
- [ ] **Print + barcode hardware QA.** Test ESC/POS thermal printers at
      80 mm; test CODE128 labels at each of the four template sizes on
      real label paper.
- [ ] **Storage object orphan cleanup.** Scheduled job that prunes
      `product-images` objects with no referencing `products.image_url`
      and `product-images/temp/*` from expired/canceled QR sessions.
- [ ] **Customer management module** + loyalty/points.
- [ ] **Credit sales tracking** (customer-side payable).
- [x] **Live stock updates via Supabase Realtime — done 2026-08-27.**
      Scoped to `inventory` specifically, not sales — the concrete problem
      was two registers in the same shop showing different stock, which
      turned out to be worse than first assumed: `inventory` has no
      `updated_at` column, so it's entirely outside the existing 30-120s
      delta-sync refresh in `AppLayout.tsx` (`deltaSync.ts` excludes it by
      design — see that file's header comment). Staleness was unbounded
      between full reloads, not capped at ~2 minutes. Migration `058` adds
      `inventory` to the `supabase_realtime` publication; no RLS changes
      needed since Realtime's `postgres_changes` already evaluates each
      change against the subscribing user's own RLS context (a CASHIER
      still only ever receives rows `inventory_sel` already lets them
      SELECT). `AppLayout.tsx` subscribes while online+loaded and merges
      each change into the store via a new
      `applyInventoryRealtimeUpdate` action (`inventorySlice.ts`), same
      shop+product merge shape already used by `reconcileAdjustStock`.
      Verified with a real end-to-end test (a Node script subscribing via
      `@supabase/supabase-js` against production, then a real committed
      `UPDATE` to a throwaway QA row) — confirmed the exact new
      `qty_base_units` value arrives over the wire, not just that the
      migration applied. Cost: negligible at this business's actual scale
      (1 shop, a handful of staff) — Realtime connection/message volume
      here is a tiny fraction of what's included free on any Supabase
      plan tier.

## Low Priority

- [x] **Desktop wrapper (Electron) + offline POS with sync.** Shipped —
      native Windows/Mac app (installers via a sidebar Download button,
      GitHub Releases + auto-update), silent ESC/POS-compatible printing,
      and a full offline-first sync layer (local IndexedDB mirror, write
      outbox, delta sync) covering the floor-critical flows — POS
      checkout, stock adjustments, shift open/close, refund/void requests,
      PO receiving, supplier payments, transfer dispatch/receive, and
      simple catalog edits. See
      [06-ui-printing-hardware.md](./06-ui-printing-hardware.md#desktop-wrapper-electron)
      and [10-offline-desktop-known-issues.md](./10-offline-desktop-known-issues.md)
      for the full scope map (what's still online-only and why), known
      gaps (no cash-drawer support, no code signing), and verification
      status. OPOS/JavaPOS native hardware drivers remain undone — no
      hardware available to build against.
- [ ] **Email / SMS notifications** (e.g. low stock, shift variance,
      pending approvals).
- [ ] **Public API** for third-party integrations.
- [ ] **Mobile app** (read-only catalog + receipts initially).
- [ ] **Audit row prune / archive** for very long-lived deployments.

## Future Vision — Multi-Tenant SaaS (2026-08-25, not scheduled)

Long-term direction, not a scoped project — captured here so the
architectural implications are on record before any part of it gets
built. Today the product is single-tenant: one business, with `shops`
as the only scoping boundary (`shop_id` on operational tables, RLS
scoped per shop, one global ADMIN). The vision is to support **many
independent organizations** on one deployment, each with its own
shops/users/data, plus a platform-level team that can monitor all of
them — while an organization's own ADMIN (the business owner) must
never be able to see another organization, or the platform-monitoring
view itself.

**Phase 1 — organization foundation (done, 2026-09-02).** Migrations
`059_organizations_foundation.sql` and `060_organizations_rls.sql`:
the `organizations` table (RLS enabled — SELECT open to authenticated,
INSERT gated the same way as `users_ins`'s bootstrap escape hatch),
`shops.org_id`/`users.org_id` (NOT NULL, backfilled to one seeded org),
the re-scoped `users_only_one_admin` constraint (`UNIQUE (org_id) WHERE
role = 'ADMIN'`), and the `app_org_id()` helper (mirrors `app_shop_id()`,
not yet wired into any other RLS policy or RPC). `authStore.ts` now
resolves and stores `org_id`/`currentOrgId` on login, restore, and the
first-admin bootstrap path (which also creates its own org via
`newId("org")`), matching the decided "one org per account, no
org-picker" login shape below. **Also done (2026-09-03):** the platform
admin console (`/console`, migration `061`) closes the "no way to
create a second org" gap — see the "Platform-level admin access" item
further down for the full writeup. **Still not done, and not started:**
no RLS policy or RPC besides `app_org_id()` itself actually checks
`org_id` yet (still only a couple of orgs in production today, so
nothing meaningful is exposed by that gap yet), there's still no
*self-serve* signup (org creation is operator-driven via `/console`,
by design), and the full RLS/RPC org-scoping audit hasn't started.

- [ ] **Sign-in/auth needs real redesign, not just a schema add.**
      Confirmed by reading `authStore.ts`: today's login is a single
      flat `supabase.auth.signInWithPassword({ email, password })`
      against one global Supabase Auth pool for the whole project —
      no organization concept anywhere in that path. Decided: **one
      org per account** (not one login shared across multiple
      organizations) — so sign-in stays close to today's shape, the
      app just looks up the authenticated user's single `org_id`
      alongside their existing `shop_id`/role (no org-picker/switcher
      UI needed; the org is a fact about the account, not a choice
      made at login). Someone who genuinely needs access to two
      organizations would use two separate accounts/emails. Two
      pieces of net-new work this still requires that aren't schema
      changes: (1) a real **organization signup/onboarding flow** —
      today's only "create the first user" path is a literal
      bootstrap-the-whole-project ADMIN case, which doesn't generalize
      to "create the Nth organization"; (2) the **platform-admin login
      needs a deliberately harder boundary** than "just another role"
      sharing the same login surface as every org's ADMIN — a bug in
      one role-check should not be a cross-tenant breach of everything
      at once. Admin 2FA (`admin-2fa` edge function,
      `admin_login_codes`) also needs an org dimension added.
- [ ] **Add an `organizations` table above `shops`.** Every
      shop-scoped table today would gain an `org_id` (directly, or
      derived via `shops.org_id`) — the same shape as the existing
      shop-scoping, just one level up. Direction chosen: a single
      shared Supabase project/database with `org_id` row-scoping
      (not a separate database per organization) — cheapest to run
      and consistent with how shop isolation already works via RLS,
      at the cost of every RLS policy and RPC needing an org check
      added alongside its existing shop check. Migration path from
      the current single-tenant data (one implicit organization) needs
      its own plan when this is picked up.
- [ ] **RBAC rules stay the same shape, just re-scoped by org.**
      Confirmed direction: no new rules, no per-org customization —
      every organization plays by the same constraints. The existing
      uniqueness rules from migration `020` ("RBAC user-assignment
      constraints — one admin globally, one active manager per shop,
      cashier-needs-manager, manager-deactivation safety") carry
      forward as-is, except **"one ADMIN globally" becomes "one ADMIN
      per organization"** — that constraint's boundary was the whole
      project because there was only one org; it needs to move to
      `org_id`. "One active manager per shop" and
      "cashier-needs-manager" don't change at all, since a shop
      already belongs to exactly one org once `shops.org_id` exists —
      they're already correctly scoped by construction.
- [x] **Platform-level admin access — org creation (done, 2026-09-03).**
      Decided: neither pure option (a) nor (b) from the original
      framing below — a **new identity (`platform_admins`, migration
      `061`), reachable at its own unlinked route (`/console/login`,
      `/console`), but living in this same codebase/deployment**.
      Structurally separate from `users`/`ADMIN` (no `org_id`, no role
      overlap), and locked down harder than any RLS-policy-based role
      ever could be: `platform_admins` has RLS on with **zero
      policies** and `REVOKE ALL FROM anon, authenticated` (same
      pattern as `admin_login_codes`, migration `042`) — no client call
      can read or write it under any circumstance, so a bug in some
      other RLS policy can't leak into platform access. The only way in
      is the `platform-console` Edge Function (service-role key),
      mirroring `admin-2fa`'s exact auth pattern. See
      `07-setup-deployment.md`'s "Platform Admin Console" section for
      the full setup/deploy writeup.
      **Built:** creating a new organization + its first ADMIN
      (`create_organization`), listing all organizations
      (`list_organizations`), and provisioning additional operator
      accounts (`create_platform_admin`). **Not built:** platform-level
      *monitoring* (health/usage/support views across orgs) — this
      pass only solved the "no way to create a second org" gap, not the
      broader monitoring surface the item below still describes. Also
      still true: an organization's own `ADMIN` has no path to `/console`
      (gated by `platform_admins` membership, which they aren't in), but
      today's `users_sel USING (true)` global-read pattern (Security
      section's last open item) is unrelated and still open.
- [ ] **Everything currently assuming single-tenant needs an audit
      once this is scheduled** — every RLS policy, every RPC that
      trusts `shop_id` alone, `current_app_user()`/`app_role()` helpers,
      the offline sync/outbox layer (delta sync, actor stamping), CSV
      import/export, and reporting/dashboards would all need an
      `org_id` dimension added, not just `shop_id`. Not detailed here
      since this is pre-scoping; revisit this list item-by-item when
      the project actually starts.

## Completed Backend Hardening (for reference)

These were the headline backend hardening milestones; details are in
[03-database-security.md](./03-database-security.md) and
[`archive/21-recent-changes.md`](./archive/21-recent-changes.md).

- [x] Identity linking via `users.auth_id` (migration `001`).
- [x] Granular RBAC with `granted_permissions` / `revoked_permissions`
      (migration `002`).
- [x] SQL identity / permission helpers (migration `003`).
- [x] Atomic POS checkout RPC `complete_sale` (migration `004`).
- [x] Atomic refund / void approval RPCs (migration `005`).
- [x] Atomic purchase receiving RPC `receive_purchase_order`
      (migration `006`).
- [x] Atomic transfer completion RPC `complete_stock_transfer`
      (migration `007`).
- [x] Atomic stock adjustment / damage RPC `adjust_stock`
      (migration `008`).
- [x] Atomic shift lifecycle RPCs `open_shift` + `close_shift`
      (migration `009`).
- [x] RLS write lockdown on operational tables (migrations `010`, `011`,
      `013`).
- [x] PO / transfer / request / reprint status RPCs (migration `012`).
- [x] RBAC role tuning + permission split (migration `014`).
- [x] Permission-gated SELECT RLS (migrations `015`, `018`).
- [x] Product images in Supabase Storage (migration `016`); icon-based
      categories (migration `017`).
- [x] Supplier debt + `record_supplier_payment` (migration `018`).
- [x] QR phone product image uploads (migration `019`).
- [x] RBAC user-assignment constraints — one admin globally, one active
      manager per shop, cashier-needs-manager, manager-deactivation
      safety (migration `020`).
- [x] Brand registry (migration `031`), product quick fields
      (migration `032`), and Open Price / Non Stock `complete_sale`
      enforcement (migration `033`).
- [x] Multi-line checkout stock fix (running per-product tally, migration
      `034`).
- [x] Unique supplier code + supplier⇄product catalog (migrations `035`,
      `036`).
- [x] Receive-at-received-value PO billing (migration `037`).
- [x] Two-step transfers — `dispatch_stock_transfer` →
      `receive_stock_transfer` (migration `038`, supersedes
      `complete_stock_transfer`).
- [x] Void supplier payment + lump-sum supplier payment (migrations `039`,
      `040`).
- [x] Captured COGS — `sale_items.unit_cost_mmk_snapshot` written by
      `complete_sale` so profit uses historical cost (migration `041`).
- [x] Admin email-code 2FA table + `admin-2fa` edge function (migration
      `042`); authenticator-app TOTP via Supabase native MFA.
- [x] Business profile (brand name/logo/contacts) singleton (migration
      `043`).
- [x] `updated_at` + triggers on the 6 tables offline delta-sync needed
      (migration `044`).
- [x] `resolve_event_time()` + `p_created_at` param on every
      offline-eligible RPC, so a write queued offline keeps its real
      timestamp instead of recording as whenever it happened to sync
      (migration `045` — see
      [10-offline-desktop-known-issues.md](./10-offline-desktop-known-issues.md)).
- [x] Auto-create qty-0 inventory rows for every active product × active
      shop, via triggers on `products`/`shops` (migration `046`).
- [x] `guard_user_privilege_columns()` trigger blocks a non-admin from
      changing `role`/`granted_permissions`/`revoked_permissions`/
      `permissions` on any `users` row, closing a privilege-escalation
      gap in `users_upd`/`users_ins` (migration `047`).

## Completed Frontend Hardening (for reference)

- [x] **Full-app theme system.** System / Light / Dark covers POS,
      dashboards, tables, forms, modals, semantic status surfaces, and chart
      labels/grids. System is the persisted default and follows live OS
      changes; `index.html` resolves it before first paint. Receipts, barcode
      labels, and QR paper surfaces remain print-safe on white.
- [x] **Windows updater "cannot be closed" — real root cause found and
      fixed (v1.0.14).** Longer story than originally scoped, kept
      fully in document 10, not duplicated here since it kept changing as
      real-hardware evidence came in: v1.0.7/v1.0.9's app-running
      pre-check hardening fixed the wrong code path; v1.0.10's file-
      writability probe closed one real gap but only covered 2 of the
      many files a real update touches; the actual root cause, confirmed
      on real hardware in v1.0.12–v1.0.13's diagnostic passes, turned out
      to be that the OLD version's own uninstaller.exe genuinely hangs —
      reproducible independently of updating at all, and reportedly
      present since v1.0.3. v1.0.14 fixes this for real via a
      `patch-package` patch to electron-builder's own
      `uninstallOldVersion`: bounded non-blocking wait instead of an
      indefinite blocking one, force-kill + automatic self-heal cleanup
      if it hangs — automating the manual `taskkill`+`rmdir`+`reg delete`
      recovery already confirmed to work by hand. See document 10's
      "Current Windows release and recovery" section for full detail.
      Real-hardware confirmation of an actual v1.0.9 → v1.0.14 update
      (the exact scenario that was failing) remains in document 10's
      testing gaps.
- [x] **Sidebar footer action layout (v1.0.8).** Update and logout controls now
      use full-width stacked rows so labels and dynamic updater states cannot
      overlap in the expanded desktop sidebar.
- [x] Receipt + Sales drawer unified through `ReceiptDetail`.
- [x] Shift summary parity (cashier card + manager modal) via
      `buildShiftBreakdown`.
- [x] Cashier sales history scope.
- [x] Tablet/desktop responsive overhaul + `SmallScreenGuard`.
- [x] Barcode label preview + template registry.
- [x] POS barcode scan SKU fallback + scan UX (success toast, refocus).
- [x] Collapsible sidebar with persisted icon-only rail.
- [x] Supplier detail moved to full-page route at
      `/app/suppliers/:supplierId`.
- [x] System-wide error utility + `useAsyncAction` + top-level
      ErrorBoundary + `loadData` retry surface.
- [x] **Product CRUD moved to dedicated routes.** `/app/admin/products/new`
      and `/app/admin/products/:productId/edit` replace the cramped modal
      with a 2-column page (Identity / Classification / Stock & Status on
      the left, Units & Prices on the right). Manager Products gate fixed
      (`adminProducts` route now `product:read`; Add / Delete / Add
      Category / Add Brand buttons gated individually).
- [x] **Shift detail moved to a dedicated page.** `/app/shifts/:shiftId`
      renders the breakdown, an items-sold rollup (NORMAL sales only),
      an iStock-style per-sale table with expandable line items, and
      the inline Close-shift card. Replaces the previous modal.
- [x] **POS checkout split into F2 (Place Order) / F3 (Print).** After
      checkout the cashier stays on POS; F3 prints inline via a
      hidden React portal to `<body>` so no POS ancestor breaks the
      absolute-receipt positioning. Barcode toggle moved to F4. Enter
      on the payment Amount field confirms.
- [x] **POS Adjust Price tabs.** Per-line price-level picker is now
      tab buttons (Retail / Wholesale / Special) plus a manual price
      input; editing the input flags the line as a manual override.
- [x] **Receipt redesign.** 4-column items table (Description / Qty /
      Price / Amount), grid meta block with aligned colons, brand line
      `Shwe PhaLar` above the per-shop name, single-level price moved
      to the meta block when every line shares a level, Burmese
      thank-you footer.
- [x] **Inventory admin shop picker.** Pill row above the
      Stock/Movements tabs (emerald active state) so admins can switch
      shops without leaving the page. Inventory Product + Category
      cells now match the Products admin styling.
- [x] **Category UX improvements.** Brand list moved to a popup modal
      per category card; icon+color uniqueness surfaced in the colour
      picker (greys out conflicting swatches in real time). POS
      category row is horizontally scrollable with click-and-drag
      support and a hidden scrollbar.
- [x] **Daily sales email report** for admins. `Email today's CSV`
      button on Sales calls the `email-sales-report` Supabase edge
      function which emails per-shop CSVs via Resend. Open shifts are
      surfaced as an in-email "data may be incomplete" notice instead
      of blocking the send. See
      [04-features-workflows.md](./04-features-workflows.md#daily-sales-email-report)
      and [07-setup-deployment.md](./07-setup-deployment.md#daily-sales-email-function).
- [x] **Full English / Myanmar i18n** across the app (sidebar already had it;
      now suppliers, supplier detail, POS + cart/payment/finder, products
      management + form, login, inventory, purchases, transfers, profile,
      security). `useTranslation().t(section, key, vars?)` gained
      `{placeholder}` interpolation.
- [x] **Reports uncapped to the selected range.** Profit/COGS reports use
      `useRangedSales` to fetch sales + items for the chosen `[from, to]`
      straight from Supabase (id-batched), bypassing the 1000-row store cache
      cap, and prefer `unit_cost_mmk_snapshot` for cost.
- [x] **Admin Profile + Security sidebar pages** (under Administration);
      Products moved to "Inventory & Catalog". Sidebar header + receipts now
      render the editable business brand.
- [x] **Convenience-store category icon set** + smarter name→icon aliases.
- [x] **Dashboard cards** — unified Low Stock (single + all-shops) with
      "View all", and a Transfers-status card in the admin Action Queue.
