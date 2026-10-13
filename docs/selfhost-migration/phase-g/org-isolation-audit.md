# Phase G — Organization / shop isolation audit (backend)

**Date:** 2026-10-12 · **Scope:** server-side ORGANIZATION and SHOP isolation of
the Postgres schema in production (`~/shwephala-migration/<ts>/
schema.scrubbed.sql` + migrations 062–067) · **Method:** policy/function
inventory + a second synthetic organization in the Phase D DB harness
(`supabase/tests/phase-d/`, new `t09_org_isolation.sql`), run before and after
the fix · **Status:** fix migrations **068–072 prepared, NOT applied
anywhere** (local throwaway container only). No hosted Supabase or the self-hosted stack
access was used.

**Owner's design under test** (`docs/09-roadmap-todo.md`, "Future Vision —
Multi-Tenant SaaS"): one organization per account; an ADMIN of org A must
never see or act on org B; platform admins are a separate identity
(`platform_admins`, service-role only).

## 1. Headline

The organization boundary does not exist server-side today. Migration 059
added `organizations`, `shops.org_id`, `users.org_id` and `app_org_id()`, but
**no RLS policy and no RPC uses them**:

* every operational policy is `app_role() = 'ADMIN' OR shop_id = app_shop_id()`
  — an ADMIN of *any* org reads every org's sales, inventory, shifts,
  purchase orders, transfers, refund requests, supplier payments, audit log
  and users (56 policies, 29 tables, verified from `pg_policies` in the dump);
* the catalog — products, product_units, product_barcodes,
  product_unit_prices, price_tiers, categories, brands, suppliers,
  supplier_products, unit_types, price_levels — plus `shops`, `organizations`
  and `business_profile` are `USING (true)`: **every authenticated user of
  every org** reads them, and anyone with the catalog permission writes them;
* `app_can_for_shop(perm, shop)` returns true for ADMIN on **any** shop, so an
  org-A ADMIN can call `complete_sale`, `adjust_stock`, `open_shift`,
  `create_purchase_order`, `approve_*`, `receive_*`, `record_supplier_payment`,
  `create_app_user`, `replace_manager`, `delete_product`, … against org B.

Non-admin roles were already org-safe for shop-scoped rows (a shop belongs to
exactly one org) but not for the catalog. The harness demonstrates all of it:
**all 101 isolation checks fail (FINDING) on the current schema and all 101 pass after 068–072; 255 assertions, 0 harness failures in both runs**
(§5).

Collateral defects found on the way (also fixed): `shops.org_id` has been NOT
NULL without a default since 059 while `addShop()` never sends it (adding a
shop through the app fails — same class as the 066 `create_app_user` bug);
`ensure_inventory_rows_*` creates inventory rows for every org's shops ×
every org's products; `complete_sale` picks "the" default price level
globally; `rbac_assignment_violations` runs as the bypass-RLS owner and lists
every org's violating users to any caller (already noted by 065).

## 2. Inventory

### 2.1 Tables and policies (snapshot, 31 tables, 58 policies — all PERMISSIVE, all `TO authenticated`)

| Table | Org dimension today | Policies (cmd: rule) | Classification | Gap |
|---|---|---|---|---|
| organizations | own id | SELECT `true`; INSERT `user:create OR no users` | global | every org listed |
| shops | `org_id` (059) | SELECT `true`; INSERT/UPDATE `shop:create/update` | global | every org's shops listed; ADMIN A can update org B's shop |
| users | `org_id` (059) | SELECT 056 rule (ADMIN all / self / `role='ADMIN'` / same shop); INSERT `user:create` ∨ bootstrap; UPDATE `user:update` | shop-scoped (non-admin) / global (ADMIN) | ADMIN A reads+updates every org's staff; the `role = 'ADMIN'` clause exposes every org's ADMIN row to every user |
| business_profile | singleton `id='default'` | SELECT `true`; UPDATE ADMIN | global | one brand for all orgs; any org's ADMIN rewrites it |
| products, categories, brands, suppliers, unit_types, price_levels | none | SELECT `true`; INSERT/UPDATE by catalog permission | global catalog | all orgs share/see/edit one catalog; global unique indexes (supplier code, unit type name/abbr, price-level code, **one active default price level**) let one org block another |
| product_units, product_unit_prices, price_tiers, supplier_products | none (via product/supplier) | SELECT `true`; writes by permission | global catalog | same |
| product_barcodes | none | SELECT `true`; INSERT/DELETE `barcode:manage` | global catalog | same, plus a **global unique barcode value**: two orgs cannot both sell the same EAN |
| inventory | `shop_id` | SELECT ADMIN ∨ (`inventory:view_stock` ∧ own shop) | shop-scoped | ADMIN branch org-blind; **Realtime `postgres_changes` on inventory uses this policy** |
| inventory_movements, shifts, sales, purchase_orders, supplier_payments, refund_void_requests | `shop_id` | SELECT ADMIN ∨ (perm ∧ own shop) [∨ own rows] | shop-scoped | ADMIN branch org-blind |
| stock_transfers | from/to `shop_id` | SELECT ADMIN ∨ (`transfer:view` ∧ src/dst = own shop) | shop-scoped | ADMIN branch org-blind |
| sale_items, purchase_order_items, stock_transfer_items, reprint_logs | via parent | SELECT iff parent readable | inherits | inherits the parent's gap |
| audit_logs | `shop_id` nullable (NULL for catalog events, 051) | SELECT ADMIN ∨ `audit:view_global` ∨ (`audit:view_shop` ∧ own shop) | shop-scoped | ADMIN/global branch org-blind; shop-less rows have no org at all |
| product_image_upload_sessions | `shop_id`, `created_by` | SELECT owner | owner-scoped | read OK; the *create* RPC accepts any shop/product |
| admin_login_codes, platform_admins, idempotency_keys | — | none (service role only) | locked | none |

### 2.2 SECURITY DEFINER functions (45 of 61 in the current schema)

| Function(s) | Checks today (auth / role / permission / shop) | Can org A act on org B? |
|---|---|---|
| `complete_sale(p_shop_id, p_shift_id, …, p_items)` | auth; `pos:create_sale`; `app_can_for_shop(shop)`; shift must be caller's open shift in that shop; products looked up globally; default price level looked up globally | **ADMIN yes** (any shop; ADMIN opens the shift first); any role can sell **another org's product** in its own shop (inventory rows exist cross-org — see trigger row) |
| `adjust_stock(p_shop_id, p_product_id, …)` | auth; actor guard; `inventory:adjust/damage` ∧ `app_can_for_shop(shop)` | **ADMIN yes** (any shop); any MANAGER for a foreign product in own shop |
| `open_shift(p_shop_id)` / `close_shift(p_shift_id)` | auth; actor guard; `shift:manage_own/all` ∧ `app_can_for_shop` | **ADMIN yes** (opens/closes shifts in org B) |
| `create_purchase_order(shop, supplier, …, items)` | auth; `purchase:create` ∧ `app_can_for_shop`; shop/supplier/products must exist (globally) | **ADMIN yes**; BUYER/MANAGER can order org B's supplier/products into own shop |
| `approve_/cancel_/receive_purchase_order(po)` | auth; perm ∧ `app_can_for_shop(po.shop_id)`; self-approval guard | **ADMIN yes** |
| `record_supplier_payment(po)`, `pay_supplier_lump_sum(supplier, shop)`, `void_supplier_payment(payment)` | auth; `supplier:payment_create` ∧ `app_can_for_shop` (void also ADMIN) | **ADMIN yes** — pays/voids org B's supplier debt |
| `create_stock_transfer(from, to, …)`, `approve_/reject_/cancel_/dispatch_/receive_stock_transfer(id)` | auth; `transfer:*` ∧ `app_can_for_shop(from/to)` | **ADMIN yes** |
| `create_refund_void_request(sale)`, `approve_refund_request`, `approve_void_request`, `reject_refund_void_request(request)` | auth; perm ∧ `app_can_for_shop(sale/request.shop_id)`; no self-approval | **ADMIN yes** — restocks/voids org B's sales |
| `log_receipt_reprint(sale)` | auth; `receipt:reprint` ∧ `app_can_for_shop` | **ADMIN yes** |
| `log_audit_event(…, p_shop_id)` | auth; action allow-list; perm; shop forced NULL (051) | row attributed by actor only; harmless but org-blind for readers |
| `create_app_user(…, p_shop_id)` | auth; `user:create`; org_id := caller's (066) | **ADMIN yes** — creates an org-A user attached to an org-B shop |
| `update_app_user(id, …, shop)`, `deactivate_app_user(id)` | auth; `user:update` | **ADMIN yes** — renames/deactivates/moves org B's staff |
| `replace_manager(shop, new_manager)` | auth; `user:update`; shop/user exist | **ADMIN yes** — installs an org-A user as org B's manager and deactivates theirs |
| `delete_product(product)` | auth; `product:delete` | **ADMIN yes** — deletes org B's product and its inventory |
| `create_supplier(…)`, `update_supplier(id, …)` | auth; `supplier:create/update` | update: **ADMIN yes**; create: no target (new row gets no org at all) |
| `create_product_image_upload_session(shop, product)` | auth; `product:create/update`; non-admin shop must be own | **ADMIN yes** (session for org B's product) |
| `attach_/cancel_/get_…_status` | owner (`created_by`) | no |
| `get_…_by_token`, `complete_…_session` (anon) | one-time token | no (token-scoped) |
| `app_can_for_shop` | `app_has_perm ∧ (ADMIN ∨ own shop)` | **the root cause** for every ADMIN row above |
| `app_role/app_shop_id/app_user_id/app_org_id/app_has_perm/current_app_user` | own row | no |
| `ensure_inventory_rows_for_product/_shop` (triggers) | none | **creates inventory rows across orgs** (every active shop × every active product) |
| `idem_begin/idem_finish/prune_idempotency_keys` | owner/service role | no |
| `complete_stock_transfer` (legacy) | EXECUTE revoked from authenticated (052) | no |

### 2.3 Storage, Realtime, users/organizations reads

* **Storage** (`product-images`, public bucket, 016): SELECT `TO public USING
  (bucket)` → any role, anon included, can **list** every object (paths carry
  product ids: `products/<productId>/<ts>.<ext>`, `products/brand/…`,
  `temp/<sessionId>`); INSERT/UPDATE/DELETE gated by `product:create/update`
  only → an org-A manager can overwrite (the app uploads with `upsert:true`)
  or delete org B's images. Public URL *reads* of a public bucket bypass
  policies and stay as designed (thumbnails are not sensitive). Upload
  sessions: `create_product_image_upload_session('shop-x','prod-x1')` as an
  org-A ADMIN succeeds today (t09).
* **Realtime**: the publication contains exactly `public.inventory`;
  `postgres_changes` is filtered by `inventory_sel`, which is org-blind for
  ADMIN → an org-A ADMIN subscribed to inventory receives org B's stock
  events. Fixed by the policy rewrite (no Realtime config change).
* **users (056) / organizations (060)**: `users_sel` lets ADMIN read all
  orgs and lets *every* user read every org's ADMIN row; `organizations_sel
  USING (true)` lists all orgs. Both org-scoped by 069.

## 3. Findings

Severity: **H** = cross-org read/write of business data by an ordinary org
account; **M** = cross-org denial/leak via shared global state; **L** =
hygiene. "Fix" = migration that closes it. All are reproduced by
`t09_org_isolation.sql` (§5).

| # | Object | Gap | Sev | Fix |
|---|---|---|---|---|
| F1 | `app_can_for_shop()` | ADMIN passes for any shop of any org — root cause of every ADMIN RPC row in §2.2 | H | 068 (org-aware helper) + 070 (explicit guard in 30 RPCs) |
| F2 | 12 shop-scoped SELECT policies (inventory, inventory_movements, sales, sale_items, shifts, purchase_orders(+items), supplier_payments, stock_transfers(+items), refund_void_requests, reprint_logs) | `app_role()='ADMIN'` branch reads every org | H | 069 |
| F3 | `audit_logs_sel` | ADMIN / `audit:view_global` read every org; shop-less rows carry no org | H | 069 (shop's org, else actor's org) |
| F4 | `users_sel/ins/upd` | ADMIN reads/updates/creates users in any org; `role='ADMIN'` clause exposes every org's ADMIN row to all users | H | 069 |
| F5 | `shops_sel/ins/upd`, `organizations_sel` | all orgs' shops/org rows readable; ADMIN A can update org B's shop | H | 069 |
| F6 | catalog: products, categories, brands, suppliers, unit_types, price_levels, product_units, product_barcodes, product_unit_prices, price_tiers, supplier_products | no org dimension; readable and (with the catalog permission) writable by every org | H | 068 (org_id + triggers) + 069 (policies) |
| F7 | `business_profile` | one singleton for all orgs; any org's ADMIN rewrites the brand every org sees | H | 068 (one row per org, PK org_id, auto-seeded) + 069 |
| F8 | 30 mutating RPCs (§2.2) | no org check on target shop/product/supplier/PO/transfer/sale/shift/request/payment/user | H | 070 |
| F9 | `complete_sale` / `adjust_stock` / `create_purchase_order` / `create_stock_transfer` item products | another org's product accepted by id | H | 070 (`app_require_org_items`) |
| F10 | `ensure_inventory_rows_for_product/_shop` | inventory rows created for every org's shops × products (enables F9; pollutes stock reports) | M | 068 (same-org only; empty cross-org rows removed) |
| F11 | global unique indexes: product_barcodes value, suppliers code, shops name/code, unit_types name/abbr, price_levels code, **one active default price level** | one org blocks another (a second org cannot have a Retail default at all; the same EAN cannot exist twice) and probes existence via unique violations | M | 068 (per-org indexes) |
| F12 | `complete_sale` price-level lookups | default level and `price_level_id` resolved globally → once levels are per-org an org-B sale may be priced through org A's level | M | 072 (two-line body change, separate file) |
| F13 | `storage.objects` policies (016) | listing open to everyone incl. anon; overwrite/delete of any org's objects with the catalog permission | M | 071 (owner's org) — path-based INSERT scoping needs a frontend change (§7) |
| F14 | `create_product_image_upload_session` | ADMIN A opens a session for org B's shop/product | M | 070 |
| F15 | `inventory_sel` → Realtime | org-A ADMIN receives org-B stock events | M | 069 (same policy) |
| F16 | `rbac_assignment_violations` | view runs as bypass-RLS owner; `multiple_admins` counts globally (stale since 059) → lists every org's ADMIN to any caller once 2 orgs exist | L | 068 (`security_invoker`, per-org count) |
| F17 | `shops.org_id` NOT NULL, no default; `addShop()` sends no org_id | shop creation broken since 059 (defect, not isolation) | M (functional) | 068 (fill-from-caller trigger) |
| F18 | 047 `guard_user_privilege_columns` vs platform console | `create_organization` inserts the new org's ADMIN with the service role → `app_role()` is NULL → "Only an ADMIN can create a user with an elevated role" once `users` is non-empty. Not an isolation gap; **not fixed here** — the console needs a service-role exemption in the trigger (`current_setting('request.jwt.claim.role', true) = 'service_role'`) or an RPC. Verify on the self-host before onboarding a second org. | M (functional) | — (flagged) |
| F19 | `idempotency_keys` | keyed by client UUID only; a replay from another org with a guessed key would return the stored response | L | not changed (unguessable v4 keys; 070's guard runs before the gate so a cross-org *new* call never creates a key) |

Not findings (verified): `platform_admins`, `admin_login_codes`,
`idempotency_keys` have zero policies and no client grants; the anon phone
RPCs are token-scoped; `product_image_upload_sessions` reads are owner-only;
non-admin shop scoping was already correct.

## 4. The fix (migrations 068–072, not applied)

| File | What |
|---|---|
| `068_org_isolation_schema.sql` | helpers `app_org_shop_ids()`, `app_org_user_ids()`, `app_shop_in_org()`, `app_require_org(kind,id)`, `app_require_org_items(jsonb)`; **`app_can_for_shop` org-aware for ADMIN** (non-admin branch unchanged); `org_id NOT NULL` on products, categories, brands, suppliers, unit_types, price_levels, business_profile, product_barcodes (+ indexes) with backfill; BEFORE INSERT triggers fill `org_id` from `app_org_id()` (catalog tables **and shops** — F17); barcodes copy the parent product's org; `business_profile` PK → `(org_id)`, one row per org, auto-seeded by an AFTER INSERT trigger on `organizations`; per-org unique indexes (`*_per_org`); `ensure_inventory_rows_*` same-org only + cleanup; `rbac_assignment_violations` security_invoker + per-org admin count |
| `069_org_isolation_rls.sql` | every policy re-created (DROP + CREATE, PERMISSIVE, `TO authenticated`, same permission terms): shop-derived tables use `shop_id IN (SELECT app_org_shop_ids())` in the ADMIN branch; catalog tables `org_id = app_org_id()` in USING **and** WITH CHECK; children via parent EXISTS; users = 056 rule ∧ same org; organizations own row; business_profile own row; audit_logs shop's org or actor's org |
| `070_org_isolation_rpc_guards.sql` | generated (`gen070.py`, same approach as 063): 30 RPC bodies byte-identical to 063/066/snapshot plus one guard block after the auth block — `PERFORM app_require_org('<kind>', <arg>)` per target, `app_require_org_items(p_items)` for item arrays. Raises `<Entity> not found in your organization` only when the row exists in another org (NULL/unknown ids keep the RPC's own messages); before the idempotency gate. `create_supplier` unchanged (no target; org from trigger) |
| `071_org_isolation_storage.sql` | `app_storage_owner_in_org(owner_id, owner)`; `product-images` SELECT/UPDATE/DELETE scoped to objects uploaded by the caller's org, INSERT unchanged; guarded by `to_regclass('storage.objects')` |
| `072_complete_sale_price_level_org.sql` | generated (`gen072.py`): the 070 `complete_sale` body with exactly two lines changed (`AND org_id = v_user.org_id` on both price_levels lookups). **The one body edit beyond the guard**, kept separate so it can be reviewed/deferred on its own |

Design choices: shop-derived operational tables keep **no** `org_id` column
(derivation through `shops.org_id` means no RPC INSERT changes and no
backfill); catalog tables get a physical `org_id` (they have no shop) with
triggers so the frontend's direct inserts need no change; ADMIN keeps "all
shops" semantics inside the org; `platform_admins` untouched; `service_role`
untouched (bypasses RLS as before). Every file is idempotent and was applied
twice by the harness.

### 4.1 Policy changes (069)

| Table | Before (ADMIN / global term) | After |
|---|---|---|
| organizations | `true` | `id = app_org_id()` (INSERT rule unchanged) |
| shops | `true` / perm | `org_id = app_org_id()` / perm ∧ org (USING + WITH CHECK) |
| users | 056 rule / perm | `org_id = app_org_id() ∧ (056 rule)` / perm ∧ org (bootstrap hatch kept) |
| business_profile | `true` / ADMIN | `org_id = app_org_id()` / ADMIN ∧ org |
| products, categories, brands, suppliers, unit_types, price_levels, product_barcodes | `true` / perm | `org_id = app_org_id()` / perm ∧ org |
| product_units, price_tiers | `true` / perm | parent product in org / perm ∧ parent in org |
| product_unit_prices | `true` / perm | parent unit → product in org |
| supplier_products | `true` / perm | supplier in org ∧ product in org |
| inventory, inventory_movements, shifts, sales, purchase_orders, supplier_payments, refund_void_requests | `app_role()='ADMIN' ∨ …` | `(app_role()='ADMIN' ∧ shop_id IN (SELECT app_org_shop_ids())) ∨ …` (other branches verbatim) |
| stock_transfers | ADMIN ∨ … | ADMIN ∧ (from ∨ to shop in org) ∨ … |
| sale_items, purchase_order_items, stock_transfer_items, reprint_logs | parent EXISTS | unchanged (inherit) |
| audit_logs | ADMIN ∨ view_global ∨ (view_shop ∧ shop) | (ADMIN ∨ view_global) ∧ (shop in org ∨ (shop IS NULL ∧ actor in org)) ∨ (view_shop ∧ own shop) |

### 4.2 Function changes

| Function | Change |
|---|---|
| `app_can_for_shop` | ADMIN branch requires `app_shop_in_org(p_shop_id)` (NULL shop keeps the old ADMIN=true behaviour for callers that pass none) |
| 30 RPCs (070) | guard block only; signatures, hashes, responses and all existing error paths unchanged |
| `complete_sale` (072) | two WHERE clauses gain `AND org_id = v_user.org_id` |
| `ensure_inventory_rows_for_product/_shop` | join on `org_id` |
| new | `app_org_shop_ids`, `app_org_user_ids`, `app_shop_in_org`, `app_require_org`, `app_require_org_items`, `set_org_id_from_caller`, `product_barcodes_set_org_id`, `organizations_seed_business_profile`, `app_storage_owner_in_org` |
| grants | read helpers: authenticated + service_role; `app_require_org*`: service_role only (an authenticated caller could otherwise use them as an existence oracle); t01 updated accordingly |

## 5. Harness evidence

Command: `POS_TEST_MAX_MIGRATION=067 ./supabase/tests/phase-d/run.sh` (before:
baseline + 062–067) and `./supabase/tests/phase-d/run.sh` (after: + 068–072).
Both on `supabase/postgres:17.6.1.136`, synthetic data, container removed at
exit. The earlier tests t01–t08 pass in both runs (idempotency, grants,
concurrency, consistency unchanged).

### 5.1 Before (schema 062–067) — findings

```
storage.objects policies: 4
applied 062_idempotency_keys.sql
applied 063_rpc_idempotency.sql
applied 064_revoke_anon_execute.sql
applied 065_table_grant_parity.sql
applied 066_create_app_user_org_id.sql
applied 067_app_setup_needed.sql
re-applied 062_idempotency_keys.sql OK
re-applied 063_rpc_idempotency.sql OK
re-applied 064_revoke_anon_execute.sql OK
re-applied 065_table_grant_parity.sql OK
re-applied 066_create_app_user_org_id.sql OK
re-applied 067_app_setup_needed.sql OK
seeded: 6 users, 3 products, 6 inventory rows, 3 POs

==> test t09_org_isolation
FINDING org B can create its own default RETAIL price level (per-org uniqueness) -- blocked: duplicate key value violates unique constraint "price_levels_code_normalized"
PASS org B ADMIN: sees own 2 shops
PASS org B ADMIN: sees own 2 products
PASS org B ADMIN: sees own 4 users
PASS org B ADMIN: sees shop-x inventory
PASS org B ADMIN: sees own 4 purchase orders
PASS org B ADMIN: sees own supplier + payment
PASS org B ADMIN: sees own audit rows (shop + shop-less)
PASS org B ADMIN: sees exactly one business_profile row
PASS org B MANAGER: sees own catalog + shop inventory + own cashier
PASS org B CASHIER: complete_sale in own shop succeeds
FINDING org B sale is priced through org B's own default price level (not org A's) -- price_level_id=pl-retail
PASS org A ADMIN: still sees own shops / products / inventory / users / POs
PASS org A ADMIN: open_shift on own shop still works (ADMIN all-shops-in-org)
PASS org A ADMIN: close_shift on own shop still works
PASS org A MANAGER: adjust_stock on own shop/product still works
FINDING ADMIN A: organizations - org B row hidden
FINDING ADMIN A: shops - org B rows hidden
FINDING ADMIN A: users - org B rows hidden
FINDING ADMIN A: products - org B rows hidden
FINDING ADMIN A: categories - org B rows hidden
FINDING ADMIN A: brands - org B rows hidden
FINDING ADMIN A: unit_types - org B rows hidden
FINDING ADMIN A: price_levels - org B rows hidden
FINDING ADMIN A: product_units - org B rows hidden
FINDING ADMIN A: product_barcodes - org B rows hidden
FINDING ADMIN A: product_unit_prices - org B rows hidden
FINDING ADMIN A: price_tiers - org B rows hidden
FINDING ADMIN A: suppliers - org B rows hidden
FINDING ADMIN A: supplier_products - org B rows hidden
FINDING ADMIN A: business_profile has an org dimension
FINDING ADMIN A: inventory - org B rows hidden (same policy filters Realtime postgres_changes)
FINDING ADMIN A: inventory_movements - org B rows hidden
FINDING ADMIN A: sales - org B rows hidden
FINDING ADMIN A: sale_items - org B rows hidden
FINDING ADMIN A: shifts - org B rows hidden
FINDING ADMIN A: purchase_orders - org B rows hidden
FINDING ADMIN A: purchase_order_items - org B rows hidden
FINDING ADMIN A: supplier_payments - org B rows hidden
FINDING ADMIN A: stock_transfers - org B rows hidden
FINDING ADMIN A: stock_transfer_items - org B rows hidden
FINDING ADMIN A: refund_void_requests - org B rows hidden
FINDING ADMIN A: reprint_logs - org B rows hidden
FINDING ADMIN A: audit_logs - org B rows hidden (shop + shop-less)
FINDING ADMIN A: rbac_assignment_violations view does not list org B's ADMIN
FINDING MANAGER A: org B catalog hidden (products/categories/brands/suppliers/unit_types/price_levels/units/barcodes)
FINDING MANAGER A: org B shops hidden
FINDING MANAGER A: storage.objects - org B object not listable
PASS MANAGER A: storage.objects - own org object listable
FINDING MANAGER A: storage.objects - cannot overwrite (UPDATE) org B object
FINDING MANAGER A: storage.objects - cannot DELETE org B object
FINDING CASHIER A: org B ADMIN row hidden (056 "any ADMIN row" clause was global)
FINDING CASHIER A: org B organization row hidden
FINDING CASHIER A: org B products hidden
FINDING ADMIN A: UPDATE products of org B affects 0 rows
FINDING ADMIN A: UPDATE shops of org B affects 0 rows
FINDING ADMIN A: UPDATE users of org B affects 0 rows
FINDING ADMIN A: UPDATE suppliers of org B affects 0 rows
FINDING ADMIN A: UPDATE categories / brands / unit_types / price_levels of org B affect 0 rows
FINDING ADMIN A: UPDATE product_units / product_unit_prices / price_tiers of org B affect 0 rows
PASS ADMIN A: UPDATE business_profile touches exactly one row
FINDING ADMIN A: INSERT product_units for an org B product is rejected -- cross-org statement SUCCEEDED
FINDING ADMIN A: INSERT supplier_products linking org B supplier is rejected -- cross-org statement SUCCEEDED
FINDING ADMIN A: INSERT a users row into org B (direct write) is rejected -- cross-org statement SUCCEEDED
FINDING ADMIN A: can create supplier code SUPX although org B uses it (per-org uniqueness) -- blocked: duplicate key value violates unique constraint "suppliers_unique_normalized_code"
FINDING ADMIN A: can create a shop named "Shop X" although org B has one (per-org uniqueness) -- blocked: duplicate key value violates unique constraint "shops_unique_normalized_code"
FINDING ADMIN A: can create unit type "Carton X" although org B has one (per-org uniqueness) -- blocked: duplicate key value violates unique constraint "unit_types_unique_normalized_abbrev"
FINDING ADMIN A: can register barcode 8850000000017 on its own product although org B has it (per-org uniqueness) -- blocked: duplicate key value violates unique constraint "product_barcodes_unique_normalized_value"
FINDING ADMIN A: can add a shop WITHOUT sending org_id (addShop() has failed since 059 made shops.org_id NOT NULL) -- blocked: null value in column "org_id" of relation "shops" violates not-null constraint
FINDING ADMIN A: the new shop landed in org A
FINDING ADMIN A: INSERT product_barcodes for an org B product is rejected -- cross-org statement SUCCEEDED
FINDING ADMIN A: DELETE product_barcodes of org B affects 0 rows
FINDING ADMIN A: INSERT products with org_id = org B is rejected -- products has no org_id column
FINDING org B ADMIN: its business_profile was not changed by org A's update
FINDING CASHIER A2: complete_sale of an org B PRODUCT in own shop (inventory row created cross-org by 046 trigger) -- cross-org statement SUCCEEDED
FINDING MANAGER A: adjust_stock of an org B product in own shop -- cross-org statement SUCCEEDED
PASS MANAGER A: complete_sale on org B shop blocked by shop scope (already true before the fix) -- got: You are not permitted to create sales in this shop
FINDING ADMIN A: open_shift on org B shop -- cross-org statement SUCCEEDED
FINDING ADMIN A: complete_sale in org B shop -- cross-org statement SUCCEEDED
FINDING ADMIN A: adjust_stock in org B shop -- cross-org statement SUCCEEDED
FINDING ADMIN A: create_purchase_order for org B shop -- cross-org statement SUCCEEDED
FINDING ADMIN A: create_purchase_order with org B supplier -- cross-org statement SUCCEEDED
FINDING ADMIN A: create_purchase_order with org B product -- cross-org statement SUCCEEDED
FINDING ADMIN A: approve_purchase_order of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: cancel_purchase_order of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: receive_purchase_order of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: record_supplier_payment on org B purchase order -- cross-org statement SUCCEEDED
FINDING ADMIN A: pay_supplier_lump_sum to org B supplier -- cross-org statement SUCCEEDED
FINDING ADMIN A: void_supplier_payment of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: create_stock_transfer between org B shops -- cross-org statement SUCCEEDED
FINDING ADMIN A: approve_stock_transfer of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: reject_stock_transfer of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: cancel_stock_transfer of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: dispatch_stock_transfer of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: receive_stock_transfer of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: create_refund_void_request on org B sale -- cross-org statement SUCCEEDED
FINDING ADMIN A: approve_refund_request of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: reject_refund_void_request of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: approve_void_request of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: log_receipt_reprint of org B sale -- cross-org statement SUCCEEDED
FINDING ADMIN A: close_shift of org B cashier -- cross-org statement SUCCEEDED
FINDING ADMIN A: create_app_user into org B shop -- cross-org statement SUCCEEDED
FINDING ADMIN A: update_app_user of org B user -- cross-org statement SUCCEEDED
FINDING ADMIN A: deactivate_app_user of org B user -- cross-org statement SUCCEEDED
FINDING ADMIN A: delete_product of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: update_supplier of org B -- cross-org statement SUCCEEDED
FINDING ADMIN A: create_product_image_upload_session for org B shop/product -- cross-org statement SUCCEEDED
FINDING ADMIN A: log_audit_event naming org B shop -- cross-org statement SUCCEEDED
FINDING ADMIN A: replace_manager of org B shop with an org A user -- cross-org statement SUCCEEDED
FINDING inventory_sel policy carries an org term (Realtime postgres_changes uses this policy)
FINDING every public policy except organizations_ins, upload-session owner and the 4 parent-inherit ones carries an org term -- org-aware: 0 of 58
PASS all public policies are PERMISSIVE and TO authenticated
FINDING app_can_for_shop() is org-aware for ADMIN
FINDING 30 mutating RPCs carry the org guard -- guarded: 0
FINDING ensure_inventory_rows_* pair products and shops of the same org only
FINDING no inventory row pairs a shop and a product of different orgs -- products has no org_id; 2 org-B products have rows in org-A shops
FINDING rbac_assignment_violations runs with security_invoker
FINDING storage.objects: read/update/delete policies are org-aware
FINDING business_profile is keyed per organization
PASS sanity: org B rows exist when RLS is bypassed

assertions: 255  failed: 0  findings: 101 of 101 isolation checks  aborted steps: 0  migrations capped at: 067  image: supabase/postgres:17.6.1.136
RESULT: PASS WITH 101 FINDINGS (expected: migrations capped at 067, before the org-isolation fix 068+)
```

### 5.2 After (062–072) — all pass

```
storage.objects policies: 4
applied 062_idempotency_keys.sql
applied 063_rpc_idempotency.sql
applied 064_revoke_anon_execute.sql
applied 065_table_grant_parity.sql
applied 066_create_app_user_org_id.sql
applied 067_app_setup_needed.sql
applied 068_org_isolation_schema.sql
applied 069_org_isolation_rls.sql
applied 070_org_isolation_rpc_guards.sql
applied 071_org_isolation_storage.sql
applied 072_complete_sale_price_level_org.sql
re-applied 062_idempotency_keys.sql OK
re-applied 063_rpc_idempotency.sql OK
re-applied 064_revoke_anon_execute.sql OK
re-applied 065_table_grant_parity.sql OK
re-applied 066_create_app_user_org_id.sql OK
re-applied 067_app_setup_needed.sql OK
re-applied 068_org_isolation_schema.sql OK
re-applied 069_org_isolation_rls.sql OK
re-applied 070_org_isolation_rpc_guards.sql OK
re-applied 071_org_isolation_storage.sql OK
re-applied 072_complete_sale_price_level_org.sql OK
seeded: 6 users, 3 products, 6 inventory rows, 3 POs

==> test t09_org_isolation
PASS org B can create its own default RETAIL price level (per-org uniqueness)
PASS org B ADMIN: sees own 2 shops
PASS org B ADMIN: sees own 2 products
PASS org B ADMIN: sees own 4 users
PASS org B ADMIN: sees shop-x inventory
PASS org B ADMIN: sees own 4 purchase orders
PASS org B ADMIN: sees own supplier + payment
PASS org B ADMIN: sees own audit rows (shop + shop-less)
PASS org B ADMIN: sees exactly one business_profile row
PASS org B MANAGER: sees own catalog + shop inventory + own cashier
PASS org B CASHIER: complete_sale in own shop succeeds
PASS org B sale is priced through org B's own default price level (not org A's) -- price_level_id=pl-x-retail
PASS org A ADMIN: still sees own shops / products / inventory / users / POs
PASS org A ADMIN: open_shift on own shop still works (ADMIN all-shops-in-org)
PASS org A ADMIN: close_shift on own shop still works
PASS org A MANAGER: adjust_stock on own shop/product still works
PASS ADMIN A: organizations - org B row hidden
PASS ADMIN A: shops - org B rows hidden
PASS ADMIN A: users - org B rows hidden
PASS ADMIN A: products - org B rows hidden
PASS ADMIN A: categories - org B rows hidden
PASS ADMIN A: brands - org B rows hidden
PASS ADMIN A: unit_types - org B rows hidden
PASS ADMIN A: price_levels - org B rows hidden
PASS ADMIN A: product_units - org B rows hidden
PASS ADMIN A: product_barcodes - org B rows hidden
PASS ADMIN A: product_unit_prices - org B rows hidden
PASS ADMIN A: price_tiers - org B rows hidden
PASS ADMIN A: suppliers - org B rows hidden
PASS ADMIN A: supplier_products - org B rows hidden
PASS ADMIN A: business_profile has an org dimension
PASS ADMIN A: inventory - org B rows hidden (same policy filters Realtime postgres_changes)
PASS ADMIN A: inventory_movements - org B rows hidden
PASS ADMIN A: sales - org B rows hidden
PASS ADMIN A: sale_items - org B rows hidden
PASS ADMIN A: shifts - org B rows hidden
PASS ADMIN A: purchase_orders - org B rows hidden
PASS ADMIN A: purchase_order_items - org B rows hidden
PASS ADMIN A: supplier_payments - org B rows hidden
PASS ADMIN A: stock_transfers - org B rows hidden
PASS ADMIN A: stock_transfer_items - org B rows hidden
PASS ADMIN A: refund_void_requests - org B rows hidden
PASS ADMIN A: reprint_logs - org B rows hidden
PASS ADMIN A: audit_logs - org B rows hidden (shop + shop-less)
PASS ADMIN A: rbac_assignment_violations view does not list org B's ADMIN
PASS MANAGER A: org B catalog hidden (products/categories/brands/suppliers/unit_types/price_levels/units/barcodes)
PASS MANAGER A: org B shops hidden
PASS MANAGER A: storage.objects - org B object not listable
PASS MANAGER A: storage.objects - own org object listable
PASS MANAGER A: storage.objects - cannot overwrite (UPDATE) org B object
PASS MANAGER A: storage.objects - cannot DELETE org B object
PASS CASHIER A: org B ADMIN row hidden (056 "any ADMIN row" clause was global)
PASS CASHIER A: org B organization row hidden
PASS CASHIER A: org B products hidden
PASS ADMIN A: UPDATE products of org B affects 0 rows
PASS ADMIN A: UPDATE shops of org B affects 0 rows
PASS ADMIN A: UPDATE users of org B affects 0 rows
PASS ADMIN A: UPDATE suppliers of org B affects 0 rows
PASS ADMIN A: UPDATE categories / brands / unit_types / price_levels of org B affect 0 rows
PASS ADMIN A: UPDATE product_units / product_unit_prices / price_tiers of org B affect 0 rows
PASS ADMIN A: UPDATE business_profile touches exactly one row
PASS ADMIN A: INSERT product_units for an org B product is rejected
PASS ADMIN A: INSERT supplier_products linking org B supplier is rejected
PASS ADMIN A: INSERT a users row into org B (direct write) is rejected
PASS ADMIN A: can create supplier code SUPX although org B uses it (per-org uniqueness)
PASS ADMIN A: can create a shop named "Shop X" although org B has one (per-org uniqueness)
PASS ADMIN A: can create unit type "Carton X" although org B has one (per-org uniqueness)
PASS ADMIN A: can register barcode 8850000000017 on its own product although org B has it (per-org uniqueness)
PASS ADMIN A: can add a shop WITHOUT sending org_id (addShop() has failed since 059 made shops.org_id NOT NULL)
PASS ADMIN A: the new shop landed in org A
PASS ADMIN A: INSERT product_barcodes for an org B product is rejected
PASS ADMIN A: DELETE product_barcodes of org B affects 0 rows
PASS ADMIN A: INSERT products with org_id = org B is rejected
PASS org B ADMIN: its business_profile was not changed by org A's update
PASS CASHIER A2: complete_sale of an org B PRODUCT in own shop (inventory row created cross-org by 046 trigger)
PASS MANAGER A: adjust_stock of an org B product in own shop
PASS MANAGER A: complete_sale on org B shop blocked by shop scope (already true before the fix) -- got: Shop not found in your organization
PASS ADMIN A: open_shift on org B shop
PASS ADMIN A: complete_sale in org B shop
PASS ADMIN A: adjust_stock in org B shop
PASS ADMIN A: create_purchase_order for org B shop
PASS ADMIN A: create_purchase_order with org B supplier
PASS ADMIN A: create_purchase_order with org B product
PASS ADMIN A: approve_purchase_order of org B
PASS ADMIN A: cancel_purchase_order of org B
PASS ADMIN A: receive_purchase_order of org B
PASS ADMIN A: record_supplier_payment on org B purchase order
PASS ADMIN A: pay_supplier_lump_sum to org B supplier
PASS ADMIN A: void_supplier_payment of org B
PASS ADMIN A: create_stock_transfer between org B shops
PASS ADMIN A: approve_stock_transfer of org B
PASS ADMIN A: reject_stock_transfer of org B
PASS ADMIN A: cancel_stock_transfer of org B
PASS ADMIN A: dispatch_stock_transfer of org B
PASS ADMIN A: receive_stock_transfer of org B
PASS ADMIN A: create_refund_void_request on org B sale
PASS ADMIN A: approve_refund_request of org B
PASS ADMIN A: reject_refund_void_request of org B
PASS ADMIN A: approve_void_request of org B
PASS ADMIN A: log_receipt_reprint of org B sale
PASS ADMIN A: close_shift of org B cashier
PASS ADMIN A: create_app_user into org B shop
PASS ADMIN A: update_app_user of org B user
PASS ADMIN A: deactivate_app_user of org B user
PASS ADMIN A: delete_product of org B
PASS ADMIN A: update_supplier of org B
PASS ADMIN A: create_product_image_upload_session for org B shop/product
PASS ADMIN A: log_audit_event naming org B shop
PASS ADMIN A: replace_manager of org B shop with an org A user
PASS inventory_sel policy carries an org term (Realtime postgres_changes uses this policy)
PASS every public policy except organizations_ins, upload-session owner and the 4 parent-inherit ones carries an org term -- org-aware: 52 of 58
PASS all public policies are PERMISSIVE and TO authenticated
PASS app_can_for_shop() is org-aware for ADMIN
PASS 30 mutating RPCs carry the org guard -- guarded: 30
PASS ensure_inventory_rows_* pair products and shops of the same org only
PASS no inventory row pairs a shop and a product of different orgs
PASS rbac_assignment_violations runs with security_invoker
PASS storage.objects: read/update/delete policies are org-aware
PASS business_profile is keyed per organization
PASS sanity: org B rows exist when RLS is bypassed

assertions: 255  failed: 0  findings: 0 of 101 isolation checks  aborted steps: 0  migrations capped at: 999  image: supabase/postgres:17.6.1.136
RESULT: PASS
```

## 6. Data-migration impact (production)

* **Backfill:** 068 assigns every existing catalog row (products, categories,
  brands, suppliers, unit_types, price_levels, business_profile,
  product_barcodes) to one organization. With exactly one org this is
  trivial and automatic. If console-created test orgs exist, the org that
  owns the shops is chosen (ties or no shops → the migration **raises** and
  asks for `SET phase_g.backfill_org = '<org id>'`). Verify first:
  `SELECT o.id, (SELECT count(*) FROM shops s WHERE s.org_id=o.id) FROM organizations o;`
* **business_profile:** primary key moves from `id` to `org_id`; the existing
  row keeps `id='default'` and gets the org. Every other org gets an empty row
  (name/logo NULL) — the console or the org's ADMIN fills it in.
* **Inventory:** cross-org rows with zero stock and no movements are deleted
  (none expected on a single-org install); anything else is reported in a
  NOTICE and left alone.
* **Unique indexes** are dropped and re-created per org — strictly relaxing,
  no data can violate them. Index rebuild on tables of this size is
  sub-second.
* **No RPC signature changes**, no table grant changes (065 parity holds —
  verified by t01), no Realtime config change, no change for `service_role`.
* **Rollback** is documented in each file header; order: 072 → 071 → 070 →
  069 → 068.

## 7. What the frontend must change

Nothing is *required* for the current single-org deployment to keep working —
every change is server-side and the org is derived from the caller:

* Catalog loads (`loadData`, delta sync, Dexie snapshot) are now org-scoped
  automatically; no query change.
* Direct catalog inserts (`products`, `product_barcodes`, `product_units`,
  `supplier_products`, `product_unit_prices`, `shops`) need no `org_id` —
  triggers fill it. `addShop()` starts working again (F17).
* `business_profile` is still read/updated with `.eq("id","default")`; RLS
  returns the caller's org row.
* New error text clients may see from RPCs: `<Entity> not found in your
  organization` (SQLSTATE P0001) — only reachable with foreign ids, i.e. only
  by a tampered client. `src/features/admin/userFormErrors.ts` needs no new
  mapping; generic error display covers it.
* Barcode/SKU/supplier-code uniqueness is now per org: client-side duplicate
  checks that filter the local store already behave this way.

Recommended follow-ups (not blocking):

1. **Storage paths:** prefix uploads with the org (`<orgId>/products/…`,
   `<orgId>/temp/…`) in `src/lib/productImageStorage.ts` /
   `productImagePhoneUpload.ts` and add `(storage.foldername(name))[1] =
   app_org_id()` to the INSERT policy; existing objects must then be moved
   with the Storage API (not a DB update). Until then INSERT is permission-only
   (F13 residual: a new object can be written under another org's product
   id; it does not affect that org's rows).
2. **Platform console:** fix F18 (service-role exemption in
   `guard_user_privilege_columns` or an RPC) and, optionally, let
   `create_organization` fill the new org's `business_profile`.
3. **Admin 2FA** (`admin_login_codes`) has no org dimension; it is keyed by
   `auth_id` so it is per account, which is sufficient under one-org-per-
   account — noted for completeness.
4. `rbac_assignment_violations` is now `security_invoker`; the Users page
   (ADMIN) sees its own org only.

## 8. Apply procedure (after owner approval)

1. Review 068–072 and this document; decide on 072 (recommended with the rest).
2. Pre-check on the self-host (read-only):
   `SELECT o.id, (SELECT count(*) FROM shops s WHERE s.org_id=o.id) shops, (SELECT count(*) FROM users u WHERE u.org_id=o.id) users FROM organizations o ORDER BY created_at;`
   Exactly one org should own shops. If not, set `phase_g.backfill_org`
   in the apply session (needs a one-line change to `apply-migrations.sh`'s
   psql call: `-c "SET phase_g.backfill_org = '<org>'"` before `--file`).
3. `<deployment>/apply-migrations.sh --from 068 --to 072 --dry-run`
4. `<deployment>/apply-migrations.sh --from 068 --to 072`
   (single transaction, pre/post backups, versions recorded; 067 goes in the
   same window or before — it is independent).
5. Verify (the script's generic checks plus): the VERIFICATION queries in each
   file header; `SELECT count(*) FROM pg_policies WHERE schemaname='public' AND (qual LIKE '%app_org%' OR qual LIKE '%org_id%' OR with_check LIKE '%app_org%' OR with_check LIKE '%org_id%');` → 58;
   `SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects';` → 4 rows.
6. App smoke test as the ADMIN: login, catalog visible, POS sale, product
   image upload (desktop + phone QR), logo upload, add a shop (F17), Users
   page. As a MANAGER/CASHIER: POS sale, inventory, shifts.
7. Re-run the harness (`./supabase/tests/phase-d/run.sh`) against the
   updated baseline when `supabase/baseline/schema-baseline.sql` is refreshed.

## 9. Files

* `supabase/migrations/068_org_isolation_schema.sql`, `069_org_isolation_rls.sql`,
  `070_org_isolation_rpc_guards.sql` (generated), `071_org_isolation_storage.sql`,
  `072_complete_sale_price_level_org.sql` (generated)
* `supabase/tests/phase-d/sql/t09_org_isolation.sql`, harness changes in
  `run.sh` (`POS_TEST_MAX_MIGRATION`, storage baseline, FINDING summary),
  `00_prep.sql` (storage shim), `01_test_schema.sql` (`test.finding*`,
  `test.col_exists`), `02_seed.sql` (ADMIN claims during catalog seed),
  `t01_permissions_rls.sql` (counts aware of 067/068/071), `README.md`
* Generators (scratchpad, not in the repo): `gen070.py`, `gen072.py` — the
  inputs are 063/066/the snapshot and 070 respectively.

---

## Independent review corrections (2026-10-12) — supersedes conflicting statements above

An independent line-by-line review of 067–072 found four FAILs; all are fixed in the (still unapplied) files. Where this document disagrees with the list below, the list is correct.

1. **Critical — bootstrap hatch reopened by 069.** `users_ins`/`organizations_ins` tested "first user" with `NOT EXISTS (SELECT 1 FROM users)`, evaluated under the caller's RLS; after 069 scoped `users_sel` by org, an orphan or deactivated account saw zero users and could insert itself as MANAGER in another org or create a new org with itself as ADMIN (reproduced). Fix: both policies now use `app_setup_needed()` (counts all users, RLS-independent); `organizations_ins` allows inserts only on an empty install, so an org ADMIN can no longer create organizations. The "bootstrap hatch kept" statement above is wrong.
2. **Backfill.** 068 picked "the org with most shops" and its tie check could not fire. It now refuses when more than one org exists unless `phase_g.backfill_org` is set explicitly. The "ties resolve to the oldest org" statement above is wrong. Production has exactly one org.
3. **Cross-org catalog references.** Foreign keys alone let org A reference org B's brands, categories, price levels and shops. 068 §5b adds `enforce_same_org_refs()` triggers (also binding service_role).
4. **Second-org creation (console).** Confirmed: the 047 trigger rejected the service-role ADMIN insert once any user existed. Fixed in **073** (`current_user = 'service_role'` bypass; first-user test via `app_setup_needed()`). 073 must be applied with 067–072, otherwise onboarding a second org stays broken (harness at cap 072: RESULT FAIL).

Also: 068 `business_profile.org_id … ON DELETE CASCADE` (console rollback), 071 UPDATE WITH CHECK owner-in-org.

Harness on the final files: all migrations 327 assertions / 0 failed / 0 of 103 findings; cap 067: 101/101 findings (expected); cap 072: 1 failed (the console defect) — reproduced independently by the coordinator.

Open (not fixed): idempotency replay not bound to caller org for `create_supplier`/shop-less `log_audit_event`; client reads of `users` for first-run UX should use `isAppSetupNeeded()`; fresh-install setup race; `complete_product_image_upload_session` completes an expired session (pre-existing).
