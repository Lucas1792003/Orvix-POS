# 05 · Roles & Permissions

Granular permission strings (e.g. `pos:create_sale`) are the **single source
of truth**. The old coarse permissions are gone.

- Frontend registry: `src/lib/permissions.ts` (+ `ALL_PERMISSIONS` and
  `DEFAULT_ROLE_PERMISSIONS` in `src/types/domain.ts`).
- SQL contract: `role_default_permissions()` in
  `014_rbac_role_tuning.sql`. The two **must be kept in sync**.

## Roles

| Role | Description | Shop scope |
| --- | --- | --- |
| **ADMIN** | Full system access, every permission, all shops | Multi-shop |
| **MANAGER** | Shop management + operations | Assigned shop only |
| **CASHIER** | POS + own shift only | Assigned shop only |
| **BUYER** | Catalog browse + purchase-order creation | Assigned shop only |

> **BUYER is per-shop.** A shopless BUYER is a misconfiguration. The Users
> page requires a `shopId` for every non-admin role.

### How accounts come to exist

| Who | How | Notes |
| --- | --- | --- |
| The first **ADMIN** on an empty install | the explicit **`/setup`** page (Phase G): server confirms `users` is empty via `app_setup_needed()` (migration `067`), operator types the e-mail twice + password + acknowledgement → auth account + organization + ADMIN row linked by `auth_id` | the login page never creates accounts; a failed sign-in just reports GoTrue's message. See `docs/selfhost-migration/phase-g/login-signup-fix.md` |
| MANAGER / CASHIER / BUYER (and any later user) | Users page, by an ADMIN: `auth.signUp` + `create_app_user` RPC | unchanged |
| Platform admins (`/console`) | manual service-role step, see `07-setup-deployment.md` | separate identity, no org role |

## User-Assignment Rules (DB-enforced)

Enforced by `020_rbac_user_assignment_constraints.sql` — a frontend bug or
direct SQL session cannot bypass them.

| Rule | How it's enforced |
| --- | --- |
| Exactly one row with `role = 'ADMIN'` may exist | Partial unique index `users_only_one_admin` |
| At most one **active** MANAGER per shop | Partial unique index `users_one_active_manager_per_shop` |
| MANAGER / CASHIER / BUYER must have `shop_id` | `enforce_user_assignment_rules()` trigger |
| ADMIN must have `shop_id = NULL` (auto-normalized) | Same trigger |
| Active CASHIER's shop must already have an active MANAGER | Same trigger |
| Removing the only active MANAGER of a shop while active cashiers remain | Same trigger — blocked unless a replacement manager is in place |

The trigger emits short, end-user-facing strings (e.g. `Manager must be
assigned to a shop.`). `src/features/admin/userFormErrors.ts` maps these
plus the two unique-index violations to the canonical UI messages.

### Manager replacement

Migration `049` added `replace_manager(p_shop_id, p_new_manager_id)` — a
`SECURITY DEFINER` RPC that swaps a shop's manager atomically, including
when the shop has active cashiers. It activates the new manager, then
deactivates the old one, as two separate statements inside one
transaction; `users_one_active_manager_per_shop` was converted from a
plain unique index to a `DEFERRABLE INITIALLY DEFERRED` `EXCLUDE`
constraint specifically so this works (see `09-roadmap-todo.md` and
`03-database-security.md` for the full mechanics). In the app, this is
the "Replace manager" button on the Users page — it appears when editing
an existing user into MANAGER for a shop that already has a different
active manager.

The old manual two-step dance (deactivate cashiers, swap, re-enable; or
briefly running two managers) is no longer necessary, but still works as
a fallback via direct create/update/deactivate if `replace_manager` isn't
used.

### Preflight diagnostic view

`rbac_assignment_violations` (created by migration 020) lists any rows
that would violate the rules. Useful when planning a data clean-up or
debugging a stuck migration. Sample queries:

```sql
SELECT * FROM rbac_assignment_violations;
SELECT count(*) FROM users WHERE role = 'ADMIN';
SELECT shop_id, count(*) FROM users
 WHERE role = 'MANAGER' AND is_active GROUP BY shop_id HAVING count(*) > 1;
```

## Effective Permissions: Grant / Revoke Model

```
effective = roleDefaults  ∪  grantedPermissions  −  revokedPermissions
```

A revoke always wins over a role default and over a grant.

```ts
interface User {
  role: Role;
  grantedPermissions?: Permission[]; // additive
  revokedPermissions?: Permission[]; // explicit denials
  permissions?: Permission[];        // @deprecated legacy replacement list
}
```

This lets you, for example, grant one cashier `transfer:approve` without
changing their role, or grant a specific manager `report:shop_profit`.

> The deprecated `permissions` field used replacement semantics. It is
> kept only for migration safety — `002_rbac_permissions.sql` converts
> existing values into `grantedPermissions` / `revokedPermissions`, and
> `014_rbac_role_tuning.sql` remaps renamed permissions inside those
> arrays.

## Shop Scope

A matching permission is **not sufficient** for a shop-scoped action. The
user must also be allowed to act within the target shop. The helper
`hasShopPermission(user, perm, shopId)` checks both. ADMIN spans all
shops; MANAGER / CASHIER / BUYER are locked to their assigned `shopId`.

## Permission Matrix (defaults)

ADMIN holds every permission. Per-role defaults for the others below; see
the legacy detail in
[`archive/01-roles-permissions.md`](./archive/01-roles-permissions.md) for
column-by-column coverage.

### Shop / User / Audit

| Permission | M | C | B |
| --- | :-: | :-: | :-: |
| `shop:read` | ✅ | ❌ | ❌ |
| `user:read` | ✅ | ❌ | ❌ |
| `audit:view_shop` | ✅ | ❌ | ❌ |

### Products / Barcodes / Pricing

| Permission | M | C | B |
| --- | :-: | :-: | :-: |
| `product:read` | ✅ | ✅ | ✅ |
| `product:update` | ✅ | ❌ | ❌ |
| `product:delete` | ❌ | ❌ | ❌ |
| `product:edit_price` | ✅ | ❌ | ❌ |
| `barcode:manage` | ❌ | ❌ | ❌ |
| `pricing:manage` | ❌ | ❌ | ❌ |

Product Units use the same catalog permissions as products: read access is
part of `product:read`, and create/update/deactivate is gated by
`product:create` or `product:update` plus barcode writes by `barcode:manage`.
POS uses Product Units read-only to select sellable units and deduct base
inventory.

`/app/admin/products` is reachable for ADMIN and MANAGER with
`product:read`, so managers can reach their product-edit workflow. The Add
Product route/action requires `product:create`; the edit route/action requires
`product:update`; delete buttons require `product:delete`. CASHIER and BUYER
use `/app/catalog` for read-only product browsing.

**Hard-deleting a product** is ADMIN-only — gated by `product:delete` and
performed via the `delete_product` RPC (migration `024`). Direct client
deletes against `products` and `inventory` are blocked at the DB layer
(no DELETE policy on `products`; all writes revoked on `inventory`).

### Inventory & Transfers

| Permission | M | C | B |
| --- | :-: | :-: | :-: |
| `inventory:view_stock` | ✅ | ✅ | ❌ |
| `inventory:view_movements` | ✅ | ❌ | ❌ |
| `inventory:adjust` | ✅ | ❌ | ❌ |
| `inventory:damage` | ✅ | ❌ | ❌ |
| `inventory:override_negative` | ✅ | ❌ | ❌ |
| `transfer:view` | ✅ | ❌ | ❌ |
| `transfer:create` | ✅ | ❌ | ❌ |
| `transfer:approve` | ✅ | ❌ | ❌ |
| `transfer:cancel` | ❌ | ❌ | ❌ |

### POS, Sales, Receipts

| Permission | M | C | B |
| --- | :-: | :-: | :-: |
| `pos:create_sale` | ✅ | ✅ | ❌ |
| `pos:apply_discount` | ✅ | ✅ | ❌ |
| `pos:override_price` | ✅ | ❌ | ❌ |
| `pos:override_stock` | ✅ | ❌ | ❌ |
| `pos:request_refund` / `pos:request_void` | ✅ | ✅ | ❌ |
| `pos:refund` / `pos:void_sale` | ✅ | ❌ | ❌ |
| `sale:view` | ✅ | ❌ | ❌ |
| `sales:view_own_shift` | ✅ | ✅ | ❌ |
| `receipt:reprint` | ✅ | ✅ | ❌ |

Price-level changes in POS happen from the Bills cart line pencil and require
`pos:override_price`. The modal is selector-only: Retail / Wholesale / Special
or whatever active price levels exist. Open Price products are different:
they prompt for a cashier-entered price because the product itself opts into
manual pricing.

### Suppliers & Purchasing

| Permission | M | C | B |
| --- | :-: | :-: | :-: |
| `supplier:read` | ✅ | ❌ | ✅ |
| `supplier:update` / `supplier:create` / `supplier:delete` | ❌ | ❌ | ❌ |
| `supplier:debt_view` | ✅ | ❌ | ✅ |
| `supplier:payment_create` | ✅ | ❌ | ❌ |
| `purchase:view` | ✅ | ❌ | ✅ |
| `purchase:create` | ✅ | ❌ | ✅ |
| `purchase:receive` | ✅ | ❌ | ❌ |
| `purchase:approve` | ❌ | ❌ | ❌ |

### Shifts & Reports

| Permission | M | C | B |
| --- | :-: | :-: | :-: |
| `shift:manage_own` | ✅ | ✅ | ❌ |
| `shift:manage_all` / `shift:verify` | ✅ | ❌ | ❌ |
| `report:own_shift` | ✅ | ✅ | ❌ |
| `report:shop_sales` / `report:shop_inventory` | ✅ | ❌ | ❌ |
| `report:shop_profit` | ❌ | ❌ | ❌ |
| `report:global` | ❌ | ❌ | ❌ |

> **Dashboard.** `/app/dashboard` is gated by `report:shop_sales`. ADMIN
> sees the all-shop business dashboard and can select a single shop.
> MANAGER is pinned to the assigned-shop operational dashboard. CASHIER
> and BUYER do not reach the route by default; if sales reporting is
> explicitly granted, CASHIER sees only own-shift data and BUYER remains
> assigned-shop scoped. Profit, margin, cost, and profit/cost columns
> require `report:shop_profit`, including the Admin Revenue, Cost &
> Profit Trend. MANAGER can see assigned-shop Sales by Category because
> it is a sales mix chart, but does not see cost/profit/investment trend
> data unless `report:shop_profit` is granted. Inventory alert cards and
> the Admin Inventory Intelligence card (stock health summary, fast/slow
> movers, reorder suggestions) require `report:shop_inventory`; supplier
> debt requires `supplier:debt_view`;
> audit activity requires `audit:view_global`. See
> [`04-features-workflows.md` > Dashboard](./04-features-workflows.md#dashboard)
> for formulas, the cost-of-goods approximation caveat, and the
> "never sum stock across shops" rule.
>
> **Shifts (open / close / view).** `/app/shifts` is one unified page
> for ADMIN, MANAGER, and CASHIER. Anyone holding `shift:manage_own` can
> open / close their own shift (admin / manager / cashier all become the
> `cashier_id` of record). ADMIN must explicitly pick a shop before opening.
> ADMIN+MANAGER additionally hold `shift:manage_all`, so the View summary
> can close someone else's open shift in their scope. CASHIER only sees and
> closes their own records. BUYER has no shift access. See
> [`04-features-workflows.md` > Shifts](./04-features-workflows.md#shifts)
> for the full table.
>
> **Work Hours visibility** mirrors RLS (`015_permission_gated_select_rls.sql`):
> ADMIN sees all shifts; MANAGER sees the assigned shop only; CASHIER
> sees their own only. Monthly totals are attributed to the local
> calendar month of `startedAt`. BUYER does not hold `shift:manage_own`
> and never reaches `/app/shifts`.
> Shift CSV export uses only the same visible, filter-applied records.

### Approvals

| Permission | M | C | B |
| --- | :-: | :-: | :-: |
| `approval:view` | ✅ | ❌ | ❌ |

## Permission count

| Role | Count |
| --- | --- |
| ADMIN | 56 (full access) |
| MANAGER | 38 |
| CASHIER | 10 |
| BUYER | 5 |

## Route / Sidebar Access (summary)

The router and sidebar both consult `ROUTE_PERMISSIONS`. Sidebar entries
are filtered by the same permission plus any route-specific role gate; a user
with no `supplier:read` will not see the Suppliers nav item.

The sidebar itself can be opened or collapsed at will. The collapsed state is
stored in localStorage and renders an icon-only rail with the shop logo,
navigation icons, logout icon, and toggle button.

| Route | Permission |
| --- | --- |
| `/app/dashboard` | `report:shop_sales` |
| `/app/pos` | `pos:create_sale` |
| `/app/sales`, `/app/sales/:saleId` | `sales:view_own_shift` |
| `/app/shifts` | `shift:manage_own` |
| `/app/inventory` | `inventory:view_stock` |
| `/app/transfers` | `transfer:view` |
| `/app/purchases` | `purchase:view` |
| `/app/suppliers`, `/app/suppliers/:supplierId` | `supplier:read` |
| `/app/approvals` | `approval:view` |
| `/app/reports`, `/app/reports/profit` | `report:shop_sales` / `report:shop_profit` |
| `/app/catalog` | `product:read` |
| `/app/barcode-labels` | `product:read` + ADMIN/MANAGER role gate |
| `/app/admin/products` | `product:read` + ADMIN/MANAGER role gate (`ROUTE_PERMISSIONS.adminProducts`) |
| `/app/admin/products/new` | `product:create` (`ROUTE_PERMISSIONS.adminProductCreate`) |
| `/app/admin/products/:productId/edit` | `product:update` + ADMIN/MANAGER role gate (`ROUTE_PERMISSIONS.adminProductEdit`) |
| `/app/admin/unit-types` | `product:create` (`ROUTE_PERMISSIONS.adminUnitTypes`) |
| `/app/profile` | `user:update` + ADMIN role gate (`ROUTE_PERMISSIONS.adminSecurity`) — business brand |
| `/app/security` | `user:update` + ADMIN role gate — authenticator devices (re-verify gated) |
| `/app/admin/*` | each gated by its admin permission |

Under the **Administration** sidebar group: Shops, Users, Audit Log, Profile,
Security. Products moved to the **Inventory & Catalog** group. ADMIN sign-in
additionally requires a second factor (`/verify`) before any `/app` route loads
— see [04-features-workflows.md](./04-features-workflows.md#admin-login-verification-2fa).

## Helpers

```ts
import {
  hasPermission, hasAnyPermission, hasAllPermissions,
  hasShopPermission, canAccessShop,
  canVoidSale, canRefundSale, canAdjustInventory, canCompleteTransfer,
  canReceivePurchaseOrder, canApprovePurchaseOrder, canRecordSupplierPayment,
  canManagePriceTier,
  getEffectivePermissions, getRolePermissions,
  ALL_PERMISSIONS, ROUTE_PERMISSIONS,
} from "@/lib/permissions";
```

SQL counterparts (used by RLS and RPCs):
`current_app_user()`, `app_role()`, `app_shop_id()`, `app_user_id()`,
`app_has_perm(perm)`, `app_can_for_shop(perm, shop_id)`.

## What CASHIER specifically cannot do

This is a frequent source of bugs in role-based UIs. CASHIER's narrowed
defaults (post `014`) explicitly **lack**:

- `inventory:view_movements` (Movements tab + ledger reads)
- `inventory:adjust`, `inventory:damage`, `inventory:override_negative`
- `transfer:*`, `purchase:*`, `supplier:*`
- `pos:override_price`, `pos:override_stock`
- `pos:refund`, `pos:void_sale` (can only *request*)
- `sale:view` (only `sales:view_own_shift`)
- `report:shop_sales`, `report:shop_profit`, `report:shop_inventory`,
  `report:global`
- `audit:view_shop`, `audit:view_global`
- `pricing:manage`, `barcode:manage`, `approval:view`
- `shift:manage_all`, `shift:verify`
