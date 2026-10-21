# 01 · Overview

Orvix POS is a multi-shop point-of-sale and inventory system. It is a
React 19 + TypeScript + Vite frontend on top of **Supabase Auth + PostgreSQL**.
Business data lives in Supabase; localStorage holds only UI preferences and
the Supabase Auth session.

## Purpose

- Run a multi-shop retail business: ring up sales, manage shifts, transfer
  stock between shops, raise purchase orders, receive supplier deliveries,
  pay suppliers, and report on the result.
- Provide role-aware operations (ADMIN / MANAGER / CASHIER / BUYER) with
  shop-scoped access and an auditable history of every operational write.

## Core Modules

| Area | Highlights |
| --- | --- |
| POS | Sellable-unit selection, unit-linked barcode scan with SKU fallback, cart stock guards, line-level price levels from Bills, Open Price prompts, Non Stock sales, payment modal, atomic checkout via `complete_sale` RPC. |
| Shifts | Open/close with server-side expected cash, live breakdown, variance reason gate. |
| Inventory | One row per `(shop_id, product_id)`. Adjustments and damage via `adjust_stock` RPC. Movement ledger with before/after qty. |
| Purchases | Create / approve / receive / cancel POs. `receive_purchase_order` writes inventory, movements, audit, and PO status atomically. |
| Suppliers | Supplier list + full detail page (`/app/suppliers/:supplierId`) with Overview / Products / Purchase Orders / Payments tabs. Debt starts only when a PO is RECEIVED (billed at received value); payments via `record_supplier_payment`, plus `void_supplier_payment` and oldest-first `pay_supplier_lump_sum`. Supplier⇄product catalog links. |
| Transfers | Two-step inter-shop transfers: `dispatch_stock_transfer` (hold at source) → `receive_stock_transfer` (move received qty). Paired ledger rows + audit per step. |
| Refund / Void | Cashier requests, manager approves via `approve_refund_request` / `approve_void_request`. Inventory restocked atomically. |
| Catalog | Products, categories (convenience-store icon set), brands, barcodes, product CSV import/export with dry-run preview, pricing tiers, price levels, product images in Supabase Storage. |
| Reports | Dashboard, shop sales, profit (ADMIN by default, date-range fetch that bypasses the 1000-row cache), captured COGS via per-line cost snapshot, inventory health, supplier debt. |
| Auth / 2FA | Supabase password login + an admin second factor: authenticator-app (TOTP) code, or an emailed 6-digit code (10-min expiry). Managed on the Security page; gated re-verify to view it. |
| Profile / Branding | Admin-editable business brand (name, logo, contacts) shown in the sidebar header and on receipts. |
| UI / Theme | Full-app Light / Dark / System theme support. System is the default and follows live OS changes; the preference persists locally. Receipt, barcode-label, and QR paper surfaces stay black-on-white. |
| Audit | Every operational write inserts an `audit_logs` row through an RPC; direct authenticated writes to `audit_logs` are blocked. |
| i18n | Full English / Myanmar (Unicode + Zawgyi) across every page via `useTranslation`. |

## Current Readiness

- ✅ Supabase Auth with `users.auth_id` identity link.
- ✅ Granular permission model with `granted_permissions` / `revoked_permissions`.
- ✅ All critical operational writes are `SECURITY DEFINER` RPCs.
- ✅ RLS enabled: write lockdown on operational tables; permission-gated reads.
- ✅ Product images compressed `<= 100 KB` and uploaded to the Supabase
  Storage bucket `product-images` (no base64 in the row).
- ✅ Supplier detail moved from drawer to full page with action workspace.
- ✅ POS barcode scan resolves unit-linked `product_barcodes.value` before
  `products.sku` fallback; package barcodes add the configured Product Unit
  and SKU fallback adds the default unit.
- ✅ POS enforces Open Price and Non Stock product flags in both the cart UI
  and `complete_sale`.
- ✅ Sidebar can be toggled between the full navigation and an icon-only rail;
  the collapsed state is persisted in localStorage.
- ✅ Full-app Light / Dark / System themes across POS, dashboards, tables,
  forms, and modals. System is the default; OS changes are followed live and
  the theme is resolved before first paint to prevent a light flash.
- ✅ Electron desktop release **v1.0.10** is public. v1.0.7 and v1.0.9 both
  targeted the wrong NSIS check for the Windows "cannot be closed" updater
  error — a real v1.0.7 → v1.0.9 test still reproduced it. v1.0.10 fixes the
  actual root cause (a separate, non-customizable 5-second file-copy retry
  loop — see `10-offline-desktop-known-issues.md`); still needs real-Windows
  confirmation.
- ✅ Central error utility (`src/lib/errors.ts`) maps Postgres / network /
  storage / domain errors to friendly user-facing strings; bootstrap has a
  retry surface; top-level `ErrorBoundary` is in place.
- ✅ Admin 2FA: authenticator-app (TOTP, Supabase native MFA) or emailed code
  (`admin-2fa` edge function + `admin_login_codes`); Security page manages
  devices behind a re-verify gate.
- ✅ Full English / Myanmar i18n across all pages.
- ✅ Editable business brand (`business_profile`) in the sidebar + receipts.
- ✅ Captured COGS (`sale_items.unit_cost_mmk_snapshot`) so profit uses
  historical cost; profit reports fetch the full selected date range.
- ✅ Integration-style flow tests (store + mocked Supabase) for checkout,
  PO receive, transfer dispatch/receive, refund/void approval.
- ⏳ Live RPC / RLS verification still required against the production project
  (checklist preserved in [`archive/29-live-supabase-rls-rpc-verification.md`](./archive/29-live-supabase-rls-rpc-verification.md)).
- ⏳ Apply migrations through `047` and deploy the `admin-2fa` edge function on
  the target project; enable TOTP MFA in Supabase Auth.

## High-Priority Next Steps

See [09-roadmap-todo.md](./09-roadmap-todo.md) for the full list. Current
priorities:

- Run the live Supabase RLS / RPC verification against the target project.
- Apply migrations through `047`; deploy `admin-2fa`; enable TOTP MFA.
- Seeding is done with `npm run seed:service-role` (`scripts/seed/seedServiceRole.ts`); no browser seed exists.
- Add browser-level Playwright smoke tests (store + mocked-Supabase flow
  tests already cover checkout / receive / transfer / refund logic).
- Add Vite manualChunks / dynamic import for the main bundle (~1.5 MB).
- Orphan cleanup for `product-images` storage objects.

## Where To Read More

| Topic | Doc |
| --- | --- |
| Architecture, stores, RPC-first writes, error handling | [02-architecture.md](./02-architecture.md) |
| Tables, RPCs, RLS, migrations | [03-database-security.md](./03-database-security.md) |
| Per-feature workflows (POS, shifts, inventory, etc.) | [04-features-workflows.md](./04-features-workflows.md) |
| Roles and granular permissions | [05-roles-permissions.md](./05-roles-permissions.md) |
| Responsive layout, printing, barcodes, hardware | [06-ui-printing-hardware.md](./06-ui-printing-hardware.md) |
| Local setup, env vars, Supabase, Vercel | [07-setup-deployment.md](./07-setup-deployment.md) |
| Verification checklists and QA scenarios | [08-testing-qa.md](./08-testing-qa.md) |
| Outstanding work | [09-roadmap-todo.md](./09-roadmap-todo.md) |

Original long-form docs and per-migration test scripts live in
[`archive/`](./archive/) — see [`archive/ARCHIVE_MAP.md`](./archive/ARCHIVE_MAP.md).
