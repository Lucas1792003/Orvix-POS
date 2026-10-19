# 03 · Database & Security

Business data lives in **Supabase PostgreSQL**. RLS is enabled, operational
writes are RPC-only, and `audit_logs` direct writes are blocked.

## Tables

| Group | Tables |
| --- | --- |
| Core / reference | `shops`, `users`, `categories`, `brands`, `products`, `product_units`, `product_barcodes`, `price_levels`, `product_unit_prices`, `price_tiers`, `suppliers`, `supplier_products`, `product_image_upload_sessions`, `business_profile` |
| Inventory | `inventory` (PK `(shop_id, product_id)`), `inventory_movements` |
| Sales / POS | `shifts`, `sales`, `sale_items`, `refund_void_requests`, `reprint_logs` |
| Purchasing | `purchase_orders`, `purchase_order_items`, `supplier_payments` |
| Transfers | `stock_transfers`, `stock_transfer_items` |
| Audit | `audit_logs` |
| Auth (2FA) | `admin_login_codes` (service-role only — admin email-code step) |

`users.auth_id` links app staff profiles to `auth.users(id)`.
`users.granted_permissions` and `users.revoked_permissions` are the
fine-grained per-user permission overrides. `users.permissions` is a
deprecated legacy field kept only for migration safety.

## Migrations

Apply in numeric order. The current ordered list:

| File | Adds |
| --- | --- |
| `001_identity_linking.sql` | `users.auth_id` link to `auth.users` |
| `002_rbac_permissions.sql` | `granted_permissions`, `revoked_permissions`, role defaults |
| `003_identity_rls_helpers.sql` | `current_app_user()`, `app_role()`, `app_shop_id()`, `app_has_perm()`, `app_can_for_shop()` |
| `004_complete_sale_rpc.sql` | Atomic POS checkout RPC |
| `005_refund_void_rpc.sql` | Refund / void approval RPCs |
| `006_receive_purchase_order_rpc.sql` | Purchase receiving RPC |
| `007_complete_stock_transfer_rpc.sql` | Transfer completion RPC |
| `008_adjust_stock_rpc.sql` | Manual stock adjustment RPC |
| `009_shift_rpc.sql` | `open_shift`, `close_shift` RPCs |
| `010_rls_lockdown_phase_1.sql` | First direct-write lockdown |
| `011_rls_shop_scoped_reads.sql` | Shop-scoped operational reads |
| `012_operational_status_rpcs.sql` | PO / transfer / request / reprint status RPCs |
| `013_audit_write_lockdown.sql` | Final audit + status direct-write lockdown |
| `014_rbac_role_tuning.sql` | Tuned role defaults; split `inventory:read`, `report:shop`, `report:profit` |
| `015_permission_gated_select_rls.sql` | SELECT policies check a permission, not just shop scope |
| `016_product_images_storage.sql` | `product-images` Storage bucket + policies |
| `017_category_icon_key.sql` | `categories.icon_key` for icon-based categories |
| `018_supplier_debt_payments.sql` | `supplier_payments`, PO payment status, `record_supplier_payment` |
| `019_product_image_upload_sessions.sql` | Temporary QR upload sessions for phone product photos |
| `020_rbac_user_assignment_constraints.sql` | One-admin / one-active-manager-per-shop indexes + role/shop/cashier-needs-manager trigger + manager-deactivation safety + `rbac_assignment_violations` diagnostic view |
| `021_shop_id_required_rpc_guards.sql` | Explicit `Shop is required` guards on `create_purchase_order` and `create_stock_transfer` (the other shop-scoped RPCs already had them) |
| `022_unique_normalized_shops.sql` | Preflight duplicate shop name/code detection + unique expression indexes on `lower(trim(name))` and `lower(trim(code))` |
| `023_unique_normalized_product_barcodes.sql` | Preflight duplicate package-barcode detection + partial unique expression index on `product_barcodes(lower(trim(value)))` so a single scanned code cannot resolve to two products at POS |
| `024_delete_product_rpc.sql` | Permission-checked product delete RPC |
| `025_unit_types.sql` | Dynamic Unit Types registry for base stock unit labels |
| `026_product_sellable_units.sql` | `product_units`, unit-linked barcodes, sale item unit snapshots, and `complete_sale` validation/deduction by base units |
| `027_product_unit_prices.sql` | Splits `product_units.price_mmk` into `sale_price_mmk` (NOT NULL, ≥ 0) and `purchase_price_mmk` (nullable, ≥ 0); backfills purchase price for default units from `products.cost_mmk`; updates `complete_sale` to read `sale_price_mmk` |
| `028_unit_aware_stock_workflows.sql` | Unit-aware purchase receiving + stock adjustment. Adds optional `product_unit_id` + snapshot columns to `purchase_order_items`, `stock_transfer_items`, `inventory_movements`. Updates `receive_purchase_order` to accept `{product_unit_id, received_unit_qty}` per line (server multiplies by `base_quantity`). Updates `adjust_stock` to accept optional `p_product_unit_id` + `p_unit_qty`. `complete_stock_transfer` propagates any snapshot already on `stock_transfer_items` into both movement rows. Inventory writes stay in base units. |
| `029_unit_aware_transfer_creation.sql` | Updates `create_stock_transfer` so transfer lines may pass `{product_unit_id, selected_unit_quantity}`. The RPC validates active unit ownership, computes requested base quantity server-side, stores unit snapshots on `stock_transfer_items`, validates combined source stock in base units, and keeps approval responses from dropping snapshots. |
| `030_price_levels.sql` | Manual POS price levels (Retail / Wholesale / Special). Adds `price_levels` registry + `product_unit_prices` (unit × level × optional shop). Backfills Retail rows from `product_units.sale_price_mmk`. Adds price-level snapshot columns (`price_level_id`, `price_level_name_snapshot`, `price_source_snapshot`) to `sale_items`. Updates `complete_sale` to accept `price_level_id` per item and resolve the final price server-side via the chain: shop-specific → global at level → default-level (shop then global) → legacy `sale_price_mmk`. |
| `031_brands.sql` | Adds category-scoped `brands`, product `brand_id`, brand RLS policies, and data-store support for catalog/POS brand filtering. |
| `032_product_quick_fields.sql` | Adds product quick fields: `alias_code`, `short_name`, `max_qty`, `is_open_price`, `is_non_stock`, and `purchase_type`. |
| `033_complete_sale_open_price_non_stock.sql` | Updates `complete_sale` so Open Price items require client `unit_price_mmk`, Non Stock items skip inventory checks/deductions/movements, and price-level snapshots still record the selected level. |
| `034_complete_sale_multiline_stock_fix.sql` | Fixes multi-line checkout stock validation: `complete_sale` runs a running per-product stock tally across all cart lines (advisory lock per shop) so two lines of the same product can't oversell. |
| `035_unique_normalized_suppliers.sql` | Preflight duplicate supplier-code detection + partial unique index `suppliers_unique_normalized_code` on `lower(btrim(code))`. |
| `036_supplier_products.sql` | `supplier_products` join table (supplier ⇄ product many-to-many, both FKs `ON DELETE CASCADE`). Read = any authenticated; write gated `product:create` OR `product:update`. |
| `037_po_received_value.sql` | `receive_purchase_order` bills at **received** value: recomputes line + PO totals from `received × unit_cost` so a short receive doesn't over-count debt. |
| `038_transfer_dispatch_receive.sql` | Splits transfer completion into **dispatch → receive**. Adds `dispatched_by/at`, `received_by/at` to `stock_transfers`; `dispatch_stock_transfer` (APPROVED → IN_TRANSIT, no inventory) and `receive_stock_transfer` (IN_TRANSIT → COMPLETED, moves received ≤ approved, advisory-locks both shops, paired ledger). Supersedes `complete_stock_transfer`. |
| `039_void_supplier_payment.sql` | `void_supplier_payment(p_payment_id, p_reason)`: reverses a payment's `paid_mmk`, recomputes `payment_status`, stamps `voided_*`. Gated ADMIN or shop `supplier:payment_create`. |
| `040_pay_supplier_lump_sum.sql` | `pay_supplier_lump_sum(...)`: allocates one amount across a supplier's RECEIVED unpaid POs oldest-first, one `supplier_payments` row per PO, never overpays. |
| `041_complete_sale_cost_snapshot.sql` | Adds `sale_items.unit_cost_mmk_snapshot`; `complete_sale` captures product cost at sale time so profit/COGS use historical cost, not drifting current cost. |
| `042_admin_login_codes.sql` | `admin_login_codes` table (auth_id, code_hash, expires_at, consumed_at, attempts) for the admin email-code 2FA step. **Service-role only**: RLS on, no policies, privileges revoked from anon/authenticated. |
| `043_business_profile.sql` | `business_profile` singleton (business_name, logo_url, address, phone, email, tagline) for the app-wide brand. Read = any authenticated; UPDATE = ADMIN only; INSERT/DELETE revoked (seeded single row). |
| `048_supplier_rpcs.sql` | `create_supplier`/`update_supplier`: permission check + write + a `SUPPLIER_CREATED`/`SUPPLIER_UPDATED` audit row (with a per-field change list) in one transaction. Global entity, `audit_logs.shop_id` is `NULL`. Replaces the previous direct `suppliers` table writes from `purchaseSlice.ts` (the `suppliers_ins`/`suppliers_upd` RLS policies from migration `010` are unchanged — kept as a fallback, not revoked). |
| `049_user_management_rpcs.sql` | `create_app_user`/`update_app_user`/`deactivate_app_user`: same shape as `048`, wrapping the `users` writes `UsersPage.tsx` did directly. Also `replace_manager(shop_id, new_manager_id)` — atomic manager swap; converts `users_one_active_manager_per_shop` from a plain (partial, non-deferrable) unique index into a `DEFERRABLE INITIALLY DEFERRED` `EXCLUDE` constraint so the swap can happen without a moment of either zero or two active managers tripping migration `020`'s protections. See `09-roadmap-todo.md` for the full verification notes. |
| `050_drop_stale_authenticated_all_policies.sql` | Drops a leftover `authenticated_all FOR ALL TO authenticated USING (true)` policy on 20 tables that was silently defeating the real permission/shop-scoped SELECT policy on each (PostgreSQL ORs permissive policies together). Confirmed live exploit before fixing; re-confirmed closed after. |
| `051_harden_log_audit_event.sql` | `log_audit_event` allow-lists the 7 legitimate global catalog action types, requires the matching UI-gating permission, and hard-codes `shop_id = NULL` regardless of caller input (was forgeable for any shop by any authenticated user). |
| `052_revoke_legacy_complete_stock_transfer.sql` | Revokes `EXECUTE` on the legacy `complete_stock_transfer` RPC from `authenticated` — it bypassed the newer dispatch/receive maker-checker flow (migration `038`). |
| `053_refund_void_no_self_approval.sql` | Adds a `created_by = v_user.id` guard to `approve_refund_request`/`approve_void_request` — previously a manager could approve their own refund/void request, including as ADMIN. |
| `054_product_name_sku_max_length.sql` | `products_name_max_length` (200 chars) and `products_sku_max_length` (64 chars) `CHECK` constraints, matching the client-side zod caps. |
| `055_outbox_actor_stamping.sql` | Adds `p_expected_actor_id text DEFAULT NULL` to the 8 offline-write RPCs (`adjust_stock`, `open_shift`, `close_shift`, `create_refund_void_request`, `dispatch_stock_transfer`, `receive_stock_transfer`, `receive_purchase_order`, `record_supplier_payment`); a mismatch at replay time raises instead of silently executing under whoever is logged in when a queued offline write syncs — fixes a shared-till misattribution gap. |
| `056_users_read_scoping.sql` | Replaces `users_sel USING (true)` — previously any authenticated user could read every other shop's staff roles/permissions. New rule: own row, same-shop rows, any ADMIN row, or everything if ADMIN. |
| `057_manager_approve_po_cancel_transfer.sql` | Grants MANAGER `purchase:approve` (with a `created_by = v_user.id` self-approval guard, same pattern as `053`) and `transfer:cancel` (no guard — canceling is an undo on an internal movement, not an external commitment) — closes the ADMIN-single-point-of-failure gap for both. |
| `058_realtime_inventory.sql` | Adds `inventory` to the `supabase_realtime` publication so stock-level changes push to clients instead of only refreshing on a full `loadData()` — `inventory` has no `updated_at`, so it was entirely outside the existing delta-sync polling. No RLS changes: `postgres_changes` already evaluates against the subscriber's own RLS context. |
| `059_organizations_foundation.sql` | Multi-tenant Phase 1 (see `09-roadmap-todo.md`): `organizations` table (seeded with one row), `shops.org_id`/`users.org_id` (NOT NULL, backfilled), re-scopes `users_only_one_admin` from global to `UNIQUE (org_id) WHERE role = 'ADMIN'`, and adds `app_org_id()` (mirrors `app_shop_id()`). No RLS/RPC changes — deliberately a no-op for current single-org behavior. |
| `060_organizations_rls.sql` | Enables RLS on `organizations` (migration `059` left it disabled — caught before the login flow started inserting into it). SELECT open to authenticated (same as `shops`/`suppliers`); INSERT uses the same bootstrap escape hatch as `users_ins` (`app_has_perm('user:create') OR NOT EXISTS (SELECT 1 FROM users)`); no UPDATE/DELETE policy yet. |
| `061_platform_admins.sql` | `platform_admins` — the internal super-admin identity backing `/console` (see `07-setup-deployment.md`). Locked exactly like `admin_login_codes` (migration `042`): RLS on, **zero policies**, `REVOKE ALL FROM anon, authenticated`. No `org_id`, no overlap with any org role — the only access path is the `platform-console` Edge Function via the service-role key. |
| `062_idempotency_keys.sql` | Phase D (`docs/selfhost-migration/phase-d/idempotency-contract.md`): `idempotency_keys` ledger (RLS on, no policies, service-role only) + `idem_begin`/`idem_finish`/`prune_idempotency_keys` SECURITY DEFINER helpers, executable only by the RPC owner and `service_role`. |
| `063_rpc_idempotency.sql` | Adds a **required** trailing `p_idempotency_key uuid` to all 30 client-callable mutating RPCs (old signatures dropped, no overloads). A replay of a committed request returns the stored response; a different payload under the same key raises `IDEMPOTENCY_MISMATCH`; a failed transaction rolls the key back so a retry executes. Bodies are the production bodies plus the gate only; decision table for all 58 functions in the file header. |
| `064_revoke_anon_execute.sql` | `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, PUBLIC` + default-ACL fix for role `postgres`, then explicit grants: `service_role` everything, `authenticated` everything except `complete_stock_transfer` (052) and the idem helpers, `anon` exactly the two token-scoped phone-upload RPCs from `019`. |
| `065_table_grant_parity.sql` | REVOKE ALL + GRANT per relation so table/view privileges on a fresh install equal the hosted snapshot (`hosted-grants.txt`, 92 rows) instead of whatever default ACL the restore picked up. |
| `066_create_app_user_org_id.sql` | `create_app_user` sets `users.org_id` to the caller's org — the RPC had failed on every call since `059` made the column NOT NULL (found by `supabase/tests/phase-d/run.sh`). |
| `067_app_setup_needed.sql` | Phase G (`docs/selfhost-migration/phase-g/login-signup-fix.md`): `app_setup_needed()` — read-only `SECURITY DEFINER STABLE` boolean, `NOT EXISTS (SELECT 1 FROM users)`, granted to `anon`, `authenticated`, `service_role`. Gates the explicit `/setup` first-admin page; the login flow no longer calls `auth.signUp`. After this, `anon` can execute exactly **three** public functions (the two `019` phone-upload RPCs + this one; two since `083`). Applied on lucashome 2026-10-12; not on hosted. |
| `068`–`073` | Organization isolation: `org_id` everywhere (`068`), org-scoped RLS (`069`), RPC org guards `app_require_org` (`070`), org-scoped storage (`071`), `complete_sale` price level within the caller's org (`072`), `guard_user_privilege_columns()` trusts the service role and counts users without RLS (`073`). Design: `selfhost-migration/phase-g/org-isolation-audit.md`. |
| `074`–`077` | Idempotency replays bound to the caller's org (`074`); completion consistently rejects expired sessions (`075`); `bootstrap_first_admin()` under an install-wide lock is the only first-time setup (`076`); new orgs seeded with Retail/Wholesale/Special price levels (`077`). |
| `078`–`081` | Storage authorized by org path, legacy objects via path→product/session→org (`078`); uploads only at `org/<org>/temp/<session>` (`079`); completion URL derived server-side from the service-role-only `app_config` row, object must exist (`080`, `selfhost-migration/phase-g/migration-080.md`); DB-backed phone-upload rate limits + per-user session limit (`081`, `selfhost-migration/phase-f/rate-limiting.md`). |
| `082_close_auth_id_linking.sql` | `create_app_user` links an auth account only if it was just created by `staff-admin` for the caller's org (`app_metadata.created_via`/`org_id`), never signed in, < 15 min old, same email, unlinked, not a platform admin; the caller needs aal2 (TOTP) or a freshly consumed emailed code. `users.auth_id` cannot be set or changed by client writes. Closes audit gaps G1–G4. `selfhost-migration/phase-f/migration-082.md` |
| `083_product_images_upload_limits.sql` | Bucket `product-images`: `image/jpeg`, `image/png`, `image/webp`, ≤ 5 MiB (guarded: aborts if any existing object would break it; objects fingerprinted unchanged). `complete_product_image_upload_session` becomes **service-role only** — the phone completes through `phone-upload-token` (`action: "complete"`), which checks the bytes first. `selfhost-migration/phase-f/migration-083-g5.md` |
| `084_product_images_validated_writes_only.sql` | **Prepared, not applied** (needs every till on the validated-upload client): drops staff INSERT/UPDATE storage policies on `product-images`, so every write goes through a validated session. `selfhost-migration/phase-f/g5-followups.md` |
| `085_png_completion.sql` | Completion RPC accepts `image/png` as well as WebP/JPEG (both the caller's type and the stored object's); size rule unchanged (1..102400 bytes); grants as `083`. Independent of `084`. `selfhost-migration/phase-f/migration-085-png.md` |
| `086_operation_outcomes.sql` | **Committed, not applied** (2026-10-17/18, `d0390a1`, `21cf820`; branch `g1/batch-2a`): guarded executor `op_execute` / lookup-and-fence `op_status`; definitive refusals recorded in the operation ledger (`idempotency_keys`) and replayed; a fenced key never executes; per-organisation ledger identity. Rollback `supabase/rollbacks/086_operation_outcomes.rollback.sql`. `selfhost-migration/phase-g/migration-086.md` |
| `087_recovery_hold.sql` | **Committed, not applied** (2026-10-19, `e170794`, branch `g1/batch-2a`; needs the v87 till client first): server-wide lease renewed only by an off-host witness authority (`tools/recovery-authority/`); per-organisation holds and server-issued epochs; ALWAYS guards on 32 tables; a hash-chained, delete-proof operation ledger; legacy executor paths closed; till journals + quarantine; owner-only fence approval; every refusal HTTP 429 `PT429`. Installs **held**. Rollback `supabase/rollbacks/087_recovery_hold.rollback.sql`. `selfhost-migration/phase-g/migration-087.md` |

Applied state per environment: hosted stops at `061`; lucashome is at `085`
without `084` (2026-10-16) — see
[`lucashome-selfhost/status.md`](./lucashome-selfhost/status.md).

> **Migration order warning.** Some later migrations depend on identity
> helpers from `003` and the audit-write lockdown from `013`. Always apply
> migrations in numeric order. After `018`, payment-related reads also need
> `015` (which `018` extends with the `supplier_payments` SELECT policy).

Live verification:
[`archive/29-live-supabase-rls-rpc-verification.md`](./archive/29-live-supabase-rls-rpc-verification.md)
and [`archive/30-rls-permission-gating-checklist.md`](./archive/30-rls-permission-gating-checklist.md).

Shop duplicate preflight SQL before migration `022`:

```sql
select lower(trim(name)) as normalized_name, count(*) as row_count,
       string_agg(id || ' (' || name || ')', ', ' order by id) as rows
from shops
group by lower(trim(name))
having count(*) > 1;

select lower(trim(code)) as normalized_code, count(*) as row_count,
       string_agg(id || ' (' || code || ')', ', ' order by id) as rows
from shops
where nullif(trim(code), '') is not null
group by lower(trim(code))
having count(*) > 1;
```

Fix duplicates by renaming the duplicate shop name/code first. Do not
delete a shop with existing sales, inventory, shifts, users, purchases,
or transfers unless a deliberate data migration has been planned.

## Transactional RPCs

All money / stock / status / audit-touching writes are `SECURITY DEFINER`
RPCs. Each validates `auth.uid()`, resolves the app user, checks granular
permissions + shop scope, performs the related table writes, and writes
the audit row — all in one transaction.

| RPC | Purpose |
| --- | --- |
| `complete_sale(...)` | POS checkout: validates product units/prices/stock (running per-product tally across lines, migration `034`), requires cashier-supplied prices for Open Price items, skips inventory writes for Non Stock items, captures `unit_cost_mmk_snapshot` per line for historical COGS (migration `041`), writes sale + items + inventory + movements + audit |
| `create_refund_void_request(...)` | Cashier raises a refund or void request |
| `approve_refund_request(p_request_id)` | Manager approves a refund; restores stock, writes movements + audit |
| `approve_void_request(p_request_id)` | Manager approves a void; restocks all items |
| `reject_refund_void_request(p_request_id, p_reason)` | Reject a pending request |
| `receive_purchase_order(p_purchase_order_id, p_received_items)` | Receive a PO: PO status, received qty, inventory, `PURCHASE_IN` movements, audit |
| `dispatch_stock_transfer(p_transfer_id)` | Source releases the goods: APPROVED → IN_TRANSIT, audit only, **no inventory change** (hold-at-source). Migration `038` |
| `receive_stock_transfer(p_transfer_id, p_received_items)` | Destination confirms receipt: IN_TRANSIT → COMPLETED, moves received ≤ approved base units, advisory-locks both shops, writes paired `TRANSFER_OUT`/`TRANSFER_IN` + audit. Migration `038`, supersedes `complete_stock_transfer` |
| `adjust_stock(...)` | Manual adjustment / damage; checks `inventory:override_negative` if delta drives stock negative |
| `open_shift(p_shop_id, p_opening_cash_mmk)` | Open a shift; rejects concurrent open shifts per cashier |
| `close_shift(p_shift_id, p_closing_cash_mmk, p_variance_reason)` | Close a shift; recomputes expected cash; requires reason on non-zero variance |
| `create_purchase_order(...)`, `approve_purchase_order(p_purchase_order_id)`, `cancel_purchase_order(p_purchase_order_id, p_reason)` | PO lifecycle (non-receiving steps) |
| `create_stock_transfer(...)`, `approve_stock_transfer(p_transfer_id)`, `reject_stock_transfer(p_transfer_id, p_reason)`, `cancel_stock_transfer(p_transfer_id, p_reason)` | Transfer lifecycle (non-completion steps). Create accepts unit-aware lines but stores requested/approved quantity as base units. |
| `record_supplier_payment(p_purchase_order_id, p_amount_mmk, p_payment_method, p_reference_no, p_notes)` | Supplier payment against a RECEIVED PO; updates `paid_mmk` + `payment_status` |
| `void_supplier_payment(p_payment_id, p_reason)` | Reverse a supplier payment; recompute `payment_status`, stamp `voided_*`. ADMIN or shop `supplier:payment_create`. Migration `039` |
| `pay_supplier_lump_sum(...)` | Allocate one amount across a supplier's RECEIVED unpaid POs oldest-first (one payment row per PO, no overpay). Migration `040` |
| `log_receipt_reprint(p_sale_id)` | Reprint log + audit row |
| `log_audit_event(...)` | Generic audit writer for admin/reference events; forces `actor_id` to `current_app_user()` |
| `create_product_image_upload_session(...)` + family | QR-based phone product image uploads (see migration 019) |
| `create_supplier(...)`, `update_supplier(...)` | Supplier create/update; permission-gated, writes a per-field-change audit row. Global entity, no shop scope. Migration `048` |
| `create_app_user(...)`, `update_app_user(...)`, `deactivate_app_user(p_id, p_is_active)` | User create/update/status change; permission-gated, writes an audit row per call. Does not create the Supabase Auth account. Migration `049`. **Since Phase F** the auth account is created server-side by the `staff-admin` Edge Function (GoTrue admin API, then `create_app_user` as the caller, compensated on failure; the client never calls `auth.signUp`, and lucashome runs with `DISABLE_SIGNUP=true`); `082` restricts which account `p_auth_id` may link (see above). `selfhost-migration/phase-f/staff-creation.md` |
| `replace_manager(p_shop_id, p_new_manager_id)` | Atomically swaps a shop's active manager — activates the new one, then deactivates the old one, as two statements inside one transaction, relying on `users_one_active_manager_per_shop` being deferred to transaction end. Migration `049` |

## RLS Model

RLS is enabled on all listed tables.

**Writes.**

- Protected operational tables (sales, sale items, inventory, movements,
  shifts, purchase orders + items, supplier payments, stock transfers +
  items, refund/void requests, reprint logs, audit logs) **block direct
  authenticated writes** after migrations `010`–`013`. The only way to
  modify them is via the RPCs above.
- Admin / reference tables (`shops`, `users`, `categories`, `products`,
  `product_units`, `product_barcodes`, `price_tiers`, `suppliers`,
  `supplier_products`, `business_profile`) accept direct writes
  gated by RLS that checks the relevant granular permission. `supplier_products`
  writes need `product:create` OR `product:update`; `business_profile` UPDATE is
  ADMIN-only (single seeded row; INSERT/DELETE revoked).
- `admin_login_codes` (admin email-code 2FA) is **service-role only**: RLS is
  enabled with no policies and all privileges revoked from anon/authenticated,
  so only the `admin-2fa` edge function (service role) can read/write codes.
- `shops` additionally enforces normalized uniqueness at the DB layer:
  `shops_unique_normalized_name` on `lower(trim(name))` and
  `shops_unique_normalized_code` on `lower(trim(code))` for non-empty
  codes. Shop creation is explicit through Shops management only; there
  is no fallback auto-created shop.
- `users` additionally enforces user-assignment business rules at the DB
  layer (one admin globally, one active manager per shop, cashier requires
  active manager in its shop, manager-deactivation safety) via partial
  unique indexes and the `enforce_user_assignment_rules()` trigger from
  migration `020`. See `05-roles-permissions.md` for the full list.
- **First administrator (bootstrap).** `users_ins` (`010`) and
  `organizations_ins` (`060`) allow an INSERT while `users` is empty — the
  server-side authority for the one-time bootstrap. Since Phase G the
  client only exercises it from the explicit `/setup` page, after
  `app_setup_needed()` (`067`) confirmed the table is empty; a plain sign-in
  never creates an auth account or a `users` row
  (`docs/selfhost-migration/phase-g/login-signup-fix.md`).

**Reads.** Permission-gated SELECT (migration `015` + extensions in `018`):

| Table | Read rule |
| --- | --- |
| `sales` | ADMIN; `sale:view` + shop; or `sales:view_own_shift` for own sales/shift |
| `sale_items` | iff parent sale is readable |
| `inventory` | ADMIN; `inventory:view_stock` + shop |
| `inventory_movements` | ADMIN; `inventory:view_movements` + shop |
| `shifts` | ADMIN; `shift:manage_all` / `report:shop_sales` + shop; or own shifts |
| `purchase_orders` | ADMIN; `purchase:view` + shop |
| `purchase_order_items` | iff parent PO is readable |
| `supplier_payments` | ADMIN; `supplier:debt_view` or `purchase:view` + shop |
| `stock_transfers` | ADMIN; `transfer:view` + source or destination shop |
| `stock_transfer_items` | iff parent transfer is readable |
| `refund_void_requests` | ADMIN; `pos:refund` / `pos:void_sale` + shop; or own (`created_by`) |
| `reprint_logs` | iff parent sale is readable, or `printed_by` self |
| `audit_logs` | ADMIN; `audit:view_global`; or `audit:view_shop` + shop |

**Verified live against production 2026-08-25** (see
[`09-roadmap-todo.md`](./09-roadmap-todo.md) and
[`archive/29-live-supabase-rls-rpc-verification.md`](./archive/29-live-supabase-rls-rpc-verification.md)).
Found and fixed a real gap: 20 tables (including every one in the table
above) still carried a leftover `authenticated_all FOR ALL TO
authenticated USING (true)` policy left over from before migrations
`010`/`015` locked things down — PostgreSQL ORs multiple permissive
policies together, so that unconditional policy silently made the real
rule above a no-op for reads on those tables. Migration `050` dropped it;
the rules in the table above are now actually enforced, confirmed live.
**When adding a new table's SELECT policy, check `pg_policies` for that
table afterward** (`SELECT policyname, qual FROM pg_policies WHERE
tablename = '<table>'`) — a correct new policy sitting next to a stale
`USING (true)` one from an earlier lockdown pass is exactly this bug
again, and it fails silently (no error, just an unintended wide-open read).

Reference / catalog tables (`shops`, `categories`, `products`,
`product_barcodes`, `price_tiers`, `suppliers`) stay globally readable —
the POS and shared UI need them. `users` is the one exception: since
migration `056` it's scoped to own row + same shop + any ADMIN row
(everything if the caller is ADMIN) — see the migration table above.

## Audit Model

- Every operational RPC writes its own `audit_logs` row inside the
  transaction. Audit row and operational row commit or roll back together.
- Direct authenticated INSERT/UPDATE/DELETE on `audit_logs` is revoked by
  migration `013`.
- `log_audit_event(...)` is the only RPC that exists specifically to log
  admin/reference events; it forces `actor_id` to `current_app_user()` so
  authorship cannot be spoofed.
- Reads gated as in the table above.

## Storage

| Bucket | Public read | Writes gated by |
| --- | --- | --- |
| `product-images` | yes (thumbnails are not sensitive) | `app_has_perm('product:create' OR 'product:update')` |

- Migration `016_product_images_storage.sql` creates the bucket and four
  `storage.objects` policies scoped to `bucket_id = 'product-images'`.
- App-side image cap is **100 KB** (compressed to WebP/JPEG). Bucket
  limits as of migration `083` (lucashome, 2026-10-16): `image/jpeg`,
  `image/png`, `image/webp`, ≤ 5 MiB. (Migration `016` on a fresh install
  sets `image/webp,image/jpeg`; the production bucket restored from hosted
  had **no** type or size limit until `083` — audit finding G5.) Completion
  accepts 1..102400 bytes and WebP/JPEG/PNG (`085`).
- Paths: legacy `temp/<id>` and `products/<id>/…` (authorized by
  path→product/session→org, `078`); new uploads only at
  `org/<org>/temp/<session>` (`079`). Phone uploads use a 60 s signed token
  issued just in time by `phone-upload-token`; the phone never logs in.
  Completion runs as service role inside that function after a byte check;
  a refused object is deleted (lucashome since 2026-10-16).
- Public reads on lucashome carry `nosniff`, `CSP: default-src 'none';
  sandbox` and `content-disposition: inline` (Envoy rule, 2026-10-16).
- Staff direct writes are still allowed by policy until `084` is applied
  (prepared; the branch client already uploads through the validated
  session flow). Abandoned uploads: `sweep-abandoned-uploads.sh`,
  prepared, not scheduled.
- The **business logo** (Profile page) reuses this same public bucket
  (path `products/brand/...`) via the shared `uploadProductImage` pipeline;
  `business_profile.logo_url` stores the resulting public URL.

If `CREATE POLICY ON storage.objects` fails from the SQL editor, see the
dashboard fallback in
[`archive/31-product-images-storage-setup.md`](./archive/31-product-images-storage-setup.md).

## Permission columns on `users`

| Column | Notes |
| --- | --- |
| `auth_id` | UUID link to `auth.users(id)` |
| `granted_permissions` | additive permission grants |
| `revoked_permissions` | explicit denials; wins over defaults and grants |
| `permissions` | deprecated legacy replacement list |

The frontend registry (`src/lib/permissions.ts`) and the SQL contract
(`role_default_permissions()` in `014_rbac_role_tuning.sql`) **must be kept
in sync** — any change to one requires a matching change to the other.
