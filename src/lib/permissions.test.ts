import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { User, Sale, StockTransfer, PurchaseOrder, PriceTier, Permission } from "../types";
import {
  ALL_PERMISSIONS,
  ROUTE_PERMISSIONS,
  getRolePermissions,
  getEffectivePermissions,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  canAccessShop,
  hasShopPermission,
  canVoidSale,
  canRefundSale,
  canAdjustInventory,
  canCompleteTransfer,
  canReceivePurchaseOrder,
  canApprovePurchaseOrder,
  canRecordSupplierPayment,
  canManagePriceTier,
} from "./permissions";

// ---- builders -------------------------------------------------------------

const makeUser = (over: Partial<User> = {}): User => ({
  id: "u-1",
  name: "Test User",
  role: "CASHIER",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const makeSale = (shopId: string): Sale => ({
  id: "sale-1", shopId, shiftId: "shift-1", receiptNo: "R-1", cashierId: "c-1",
  status: "NORMAL", subtotalMmk: 0, discountMmk: 0, totalMmk: 0,
  paymentMethod: "CASH", paidMmk: 0, changeMmk: 0, createdAt: "2026-01-01T00:00:00Z",
});

const makeTransfer = (fromShopId: string): StockTransfer => ({
  id: "t-1", transferNo: "TRF-1", fromShopId, toShopId: "shop-other",
  status: "APPROVED", createdBy: "u", createdAt: "2026-01-01T00:00:00Z",
});

const makePO = (shopId: string): PurchaseOrder => ({
  id: "po-1", orderNo: "PO-1", shopId, supplierId: "sup-1", status: "APPROVED",
  subtotalMmk: 0, totalMmk: 0, createdBy: "u", createdAt: "2026-01-01T00:00:00Z",
});

// ---- role defaults --------------------------------------------------------

describe("role default permissions", () => {
  it("ADMIN holds every permission in the registry", () => {
    const admin = makeUser({ role: "ADMIN" });
    for (const p of ALL_PERMISSIONS) {
      expect(hasPermission(admin, p)).toBe(true);
    }
    expect(getRolePermissions("ADMIN")).toHaveLength(ALL_PERMISSIONS.length);
  });

  it("MANAGER has shop-level permissions but not admin-only ones", () => {
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    expect(hasPermission(manager, "inventory:adjust")).toBe(true);
    expect(hasPermission(manager, "transfer:approve")).toBe(true);
    expect(hasPermission(manager, "sale:view")).toBe(true);
    expect(hasPermission(manager, "shop:create")).toBe(false);
    expect(hasPermission(manager, "report:global")).toBe(false);
    expect(hasPermission(manager, "pricing:manage")).toBe(false);
    // Migration 057: MANAGER gained purchase:approve/transfer:cancel to
    // close the ADMIN-single-point-of-failure gap on PO approval and
    // transfer cancellation — approve_purchase_order got a self-approval
    // guard in the same migration (see actions.test.ts).
    expect(hasPermission(manager, "purchase:approve")).toBe(true);
    expect(hasPermission(manager, "transfer:cancel")).toBe(true);
    expect(hasPermission(manager, "supplier:debt_view")).toBe(true);
    expect(hasPermission(manager, "supplier:payment_create")).toBe(true);
  });

  it("CASHIER has POS permissions but not management ones", () => {
    const cashier = makeUser({ role: "CASHIER", shopId: "shop-a" });
    expect(hasPermission(cashier, "pos:create_sale")).toBe(true);
    expect(hasPermission(cashier, "sales:view_own_shift")).toBe(true);
    expect(hasPermission(cashier, "report:own_shift")).toBe(true);
    expect(hasPermission(cashier, "inventory:view_stock")).toBe(true);
    expect(hasPermission(cashier, "sale:view")).toBe(false);
    expect(hasPermission(cashier, "pos:void_sale")).toBe(false);
    expect(hasPermission(cashier, "inventory:adjust")).toBe(false);
  });

  it("BUYER is a limited catalog + purchasing role", () => {
    const buyer = makeUser({ role: "BUYER" });
    expect(hasPermission(buyer, "product:read")).toBe(true);
    expect(hasPermission(buyer, "supplier:read")).toBe(true);
    expect(hasPermission(buyer, "supplier:debt_view")).toBe(true);
    expect(hasPermission(buyer, "purchase:view")).toBe(true);
    expect(hasPermission(buyer, "purchase:create")).toBe(true);
    expect(hasPermission(buyer, "supplier:payment_create")).toBe(false);
    expect(hasPermission(buyer, "pos:create_sale")).toBe(false);
    expect(getRolePermissions("BUYER")).toEqual([
      "product:read", "supplier:read", "supplier:debt_view", "purchase:view", "purchase:create",
    ]);
  });
});

// ---- grant / revoke model -------------------------------------------------

describe("grant / revoke model", () => {
  it("a granted permission adds access beyond the role default", () => {
    const cashier = makeUser({ role: "CASHIER", grantedPermissions: ["inventory:adjust"] });
    expect(hasPermission(cashier, "inventory:adjust")).toBe(true);
  });

  it("a revoked permission removes a role default", () => {
    const manager = makeUser({ role: "MANAGER", revokedPermissions: ["pos:void_sale"] });
    expect(hasPermission(manager, "pos:void_sale")).toBe(false);
  });

  it("revoke wins over grant", () => {
    const user = makeUser({
      role: "CASHIER",
      grantedPermissions: ["inventory:adjust"],
      revokedPermissions: ["inventory:adjust"],
    });
    expect(hasPermission(user, "inventory:adjust")).toBe(false);
  });

  it("revoke wins over a role default", () => {
    const manager = makeUser({ role: "MANAGER", revokedPermissions: ["transfer:approve"] });
    expect(getEffectivePermissions(manager)).not.toContain("transfer:approve");
  });

  it("effective set = roleDefaults ∪ granted − revoked", () => {
    const cashier = makeUser({
      role: "CASHIER",
      grantedPermissions: ["pos:void_sale"],
      revokedPermissions: ["report:own_shift"],
    });
    const eff = getEffectivePermissions(cashier);
    expect(eff).toContain("pos:create_sale");      // role default kept
    expect(eff).toContain("pos:void_sale");        // granted
    expect(eff).not.toContain("report:own_shift"); // revoked
  });
});

// ---- legacy compatibility -------------------------------------------------

describe("legacy permissions fallback", () => {
  it("a pre-migration user with replacement `permissions` keeps exactly that set", () => {
    const legacy = makeUser({ role: "CASHIER", permissions: ["product:read"] });
    expect(getEffectivePermissions(legacy)).toEqual(["product:read"]);
    expect(hasPermission(legacy, "pos:create_sale")).toBe(false); // role default NOT re-added
  });

  it("once grant/deny data exists, legacy `permissions` is ignored", () => {
    const migrated = makeUser({
      role: "CASHIER",
      permissions: ["product:read"],
      grantedPermissions: [],
      revokedPermissions: [],
    });
    expect(hasPermission(migrated, "pos:create_sale")).toBe(true); // role default applies
  });
});

// ---- inactive / missing user ---------------------------------------------

describe("inactive and missing users", () => {
  it("an inactive user has no permissions", () => {
    const admin = makeUser({ role: "ADMIN", isActive: false });
    expect(hasPermission(admin, "pos:create_sale")).toBe(false);
  });

  it("null / undefined user is denied", () => {
    expect(hasPermission(null, "pos:create_sale")).toBe(false);
    expect(hasPermission(undefined, "pos:create_sale")).toBe(false);
    expect(hasAnyPermission(null, ["pos:create_sale"])).toBe(false);
  });
});

// ---- hasAny / hasAll ------------------------------------------------------

describe("hasAnyPermission / hasAllPermissions", () => {
  it("hasAnyPermission is true when at least one matches", () => {
    const cashier = makeUser({ role: "CASHIER" });
    expect(hasAnyPermission(cashier, ["pos:void_sale", "pos:create_sale"])).toBe(true);
  });

  it("hasAllPermissions is false when one is missing", () => {
    const cashier = makeUser({ role: "CASHIER" });
    expect(hasAllPermissions(cashier, ["pos:create_sale", "pos:void_sale"])).toBe(false);
  });
});

// ---- shop-aware checks ----------------------------------------------------

describe("shop-aware access", () => {
  it("a manager can access only their assigned shop", () => {
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    expect(canAccessShop(manager, "shop-a")).toBe(true);
    expect(canAccessShop(manager, "shop-b")).toBe(false);
  });

  it("an ADMIN can access every shop", () => {
    const admin = makeUser({ role: "ADMIN" });
    expect(canAccessShop(admin, "shop-a")).toBe(true);
    expect(canAccessShop(admin, "shop-zzz")).toBe(true);
  });

  it("hasShopPermission requires both the permission and shop access", () => {
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    expect(hasShopPermission(manager, "inventory:adjust", "shop-a")).toBe(true);
    expect(hasShopPermission(manager, "inventory:adjust", "shop-b")).toBe(false);
  });

  it("permission alone is not enough without shop access", () => {
    const cashier = makeUser({ role: "CASHIER", shopId: "shop-a" });
    // cashier has no inventory:adjust at all
    expect(hasShopPermission(cashier, "inventory:adjust", "shop-a")).toBe(false);
  });
});

// ---- workflow helpers -----------------------------------------------------

describe("workflow helpers", () => {
  it("canVoidSale: manager only for sales in their shop", () => {
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    expect(canVoidSale(manager, makeSale("shop-a"))).toBe(true);
    expect(canVoidSale(manager, makeSale("shop-b"))).toBe(false);
  });

  it("canVoidSale / canRefundSale: cashier never can", () => {
    const cashier = makeUser({ role: "CASHIER", shopId: "shop-a" });
    expect(canVoidSale(cashier, makeSale("shop-a"))).toBe(false);
    expect(canRefundSale(cashier, makeSale("shop-a"))).toBe(false);
  });

  it("canVoidSale: admin can for any shop", () => {
    const admin = makeUser({ role: "ADMIN" });
    expect(canVoidSale(admin, makeSale("shop-anything"))).toBe(true);
  });

  it("canAdjustInventory respects shop scope", () => {
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    expect(canAdjustInventory(manager, "shop-a")).toBe(true);
    expect(canAdjustInventory(manager, "shop-b")).toBe(false);
  });

  it("canCompleteTransfer checks the source shop", () => {
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    expect(canCompleteTransfer(manager, makeTransfer("shop-a"))).toBe(true);
    expect(canCompleteTransfer(manager, makeTransfer("shop-b"))).toBe(false);
  });

  it("canReceivePurchaseOrder checks the PO shop", () => {
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    expect(canReceivePurchaseOrder(manager, makePO("shop-a"))).toBe(true);
    expect(canReceivePurchaseOrder(manager, makePO("shop-b"))).toBe(false);
  });

  it("canApprovePurchaseOrder: manager (own shop) and admin both can, wrong shop cannot", () => {
    // Migration 057 granted MANAGER purchase:approve. This is a pure
    // permission+shop check — it has no createdBy, so it can't express
    // the self-approval guard the RPC itself enforces server-side (see
    // suppliers/actions.test.ts's DRAFT self-approval-hint test).
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    const admin = makeUser({ role: "ADMIN" });
    expect(canApprovePurchaseOrder(manager, makePO("shop-a"))).toBe(true);
    expect(canApprovePurchaseOrder(manager, makePO("shop-b"))).toBe(false);
    expect(canApprovePurchaseOrder(admin, makePO("shop-a"))).toBe(true);
  });

  it("canRecordSupplierPayment checks permission and PO shop", () => {
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    const buyer = makeUser({ role: "BUYER", shopId: "shop-a" });
    expect(canRecordSupplierPayment(manager, makePO("shop-a"))).toBe(true);
    expect(canRecordSupplierPayment(manager, makePO("shop-b"))).toBe(false);
    expect(canRecordSupplierPayment(buyer, makePO("shop-a"))).toBe(false);
  });

  it("canManagePriceTier: admin yes, manager no", () => {
    const admin = makeUser({ role: "ADMIN" });
    const manager = makeUser({ role: "MANAGER", shopId: "shop-a" });
    const globalTier = { shopId: undefined } as PriceTier;
    const shopTier = { shopId: "shop-a" } as PriceTier;
    expect(canManagePriceTier(admin, globalTier)).toBe(true);
    expect(canManagePriceTier(admin, shopTier)).toBe(true);
    expect(canManagePriceTier(manager, shopTier)).toBe(false);
  });
});

// ---- registry / coarse system removed ------------------------------------

describe("permission registry", () => {
  it("old coarse permission names are not part of the registry", () => {
    const coarse = ["VIEW_POS", "VIEW_SALES", "MANAGE_PRODUCTS", "VIEW_REPORTS", "MANAGE_SHOPS"];
    for (const name of coarse) {
      expect((ALL_PERMISSIONS as readonly string[]).includes(name)).toBe(false);
    }
  });

  it("every route guard maps to a real granular permission", () => {
    for (const perm of Object.values(ROUTE_PERMISSIONS)) {
      expect((ALL_PERMISSIONS as readonly Permission[]).includes(perm)).toBe(true);
    }
  });

  it("route guards resolve through the granular permission system", () => {
    const cashier = makeUser({ role: "CASHIER", shopId: "shop-a" });
    const admin = makeUser({ role: "ADMIN" });
    // POS route — cashier allowed
    expect(hasPermission(cashier, ROUTE_PERMISSIONS.pos)).toBe(true);
    // Admin-only route — cashier denied, admin allowed
    expect(hasPermission(cashier, ROUTE_PERMISSIONS.adminShops)).toBe(false);
    expect(hasPermission(admin, ROUTE_PERMISSIONS.adminShops)).toBe(true);
  });
});

// ---- RBAC role tuning (migration 014) ------------------------------------

describe("RBAC role tuning", () => {
  const cashier = () => makeUser({ role: "CASHIER", shopId: "shop-a" });
  const manager = () => makeUser({ role: "MANAGER", shopId: "shop-a" });
  const admin = () => makeUser({ role: "ADMIN" });
  const buyer = () => makeUser({ role: "BUYER", shopId: "shop-a" });

  it("CASHIER cannot access any shop or global report", () => {
    const c = cashier();
    expect(hasPermission(c, "report:shop_sales")).toBe(false);
    expect(hasPermission(c, "report:shop_inventory")).toBe(false);
    expect(hasPermission(c, "report:shop_profit")).toBe(false);
    expect(hasPermission(c, "report:global")).toBe(false);
  });

  it("CASHIER can view its own shift report", () => {
    expect(hasPermission(cashier(), "report:own_shift")).toBe(true);
  });

  it("CASHIER can complete a POS sale", () => {
    expect(hasPermission(cashier(), "pos:create_sale")).toBe(true);
  });

  it("CASHIER can request a refund/void but cannot approve one", () => {
    const c = cashier();
    expect(hasPermission(c, "pos:request_refund")).toBe(true);
    expect(hasPermission(c, "pos:request_void")).toBe(true);
    expect(hasPermission(c, "pos:refund")).toBe(false);
    expect(hasPermission(c, "pos:void_sale")).toBe(false);
    expect(canRefundSale(c, makeSale("shop-a"))).toBe(false);
    expect(canVoidSale(c, makeSale("shop-a"))).toBe(false);
  });

  it("CASHIER can view stock availability but not movement history", () => {
    const c = cashier();
    expect(hasPermission(c, "inventory:view_stock")).toBe(true);
    expect(hasPermission(c, "inventory:view_movements")).toBe(false);
  });

  it("CASHIER can reprint a receipt and see its own-shift sales only", () => {
    const c = cashier();
    expect(hasPermission(c, "receipt:reprint")).toBe(true);
    expect(hasPermission(c, "sales:view_own_shift")).toBe(true);
    expect(hasPermission(c, "sale:view")).toBe(false); // not the full history
  });

  it("CASHIER no longer has broad transfer / purchase / audit visibility", () => {
    const c = cashier();
    expect(hasPermission(c, "transfer:view")).toBe(false);
    expect(hasPermission(c, "purchase:view")).toBe(false);
    expect(hasPermission(c, "audit:view_shop")).toBe(false);
  });

  it("MANAGER can access assigned-shop operational data", () => {
    const m = manager();
    expect(hasShopPermission(m, "report:shop_sales", "shop-a")).toBe(true);
    expect(hasShopPermission(m, "report:shop_inventory", "shop-a")).toBe(true);
    expect(hasShopPermission(m, "inventory:view_movements", "shop-a")).toBe(true);
    expect(hasShopPermission(m, "inventory:adjust", "shop-a")).toBe(true);
    expect(hasShopPermission(m, "transfer:approve", "shop-a")).toBe(true);
    expect(hasShopPermission(m, "purchase:create", "shop-a")).toBe(true);
    expect(hasShopPermission(m, "supplier:payment_create", "shop-a")).toBe(true);
    expect(hasShopPermission(m, "supplier:debt_view", "shop-a")).toBe(true);
    expect(hasShopPermission(m, "pos:refund", "shop-a")).toBe(true);
    // ...but only for the assigned shop
    expect(hasShopPermission(m, "inventory:adjust", "shop-b")).toBe(false);
  });

  it("MANAGER cannot access global / profit / admin-only data", () => {
    const m = manager();
    expect(hasPermission(m, "report:global")).toBe(false);
    expect(hasPermission(m, "report:shop_profit")).toBe(false);
    expect(hasPermission(m, "shop:create")).toBe(false);
    expect(hasPermission(m, "user:create")).toBe(false);
    expect(hasPermission(m, "pricing:manage")).toBe(false);
    expect(hasPermission(m, "audit:view_global")).toBe(false);
  });

  it("MANAGER profit access can still be granted explicitly", () => {
    const m = makeUser({
      role: "MANAGER",
      shopId: "shop-a",
      grantedPermissions: ["report:shop_profit"],
    });
    expect(hasPermission(m, "report:shop_profit")).toBe(true);
  });

  it("BUYER can create and view purchase orders", () => {
    const b = buyer();
    expect(hasPermission(b, "purchase:create")).toBe(true);
    expect(hasPermission(b, "purchase:view")).toBe(true);
    expect(hasPermission(b, "product:read")).toBe(true);
    expect(hasPermission(b, "supplier:read")).toBe(true);
    expect(hasPermission(b, "supplier:debt_view")).toBe(true);
  });

  it("BUYER cannot receive/approve purchase orders, record payments, or adjust stock", () => {
    const b = buyer();
    expect(hasPermission(b, "purchase:receive")).toBe(false);
    expect(hasPermission(b, "purchase:approve")).toBe(false);
    expect(hasPermission(b, "supplier:payment_create")).toBe(false);
    expect(hasPermission(b, "inventory:adjust")).toBe(false);
    expect(hasPermission(b, "inventory:override_negative")).toBe(false);
    expect(hasPermission(b, "user:create")).toBe(false);
    expect(canReceivePurchaseOrder(b, makePO("shop-a"))).toBe(false);
  });

  it("ADMIN holds every tuned permission", () => {
    const a = admin();
    for (const p of ALL_PERMISSIONS) expect(hasPermission(a, p)).toBe(true);
  });

  it("granted_permissions can add report access for a cashier", () => {
    const c = makeUser({ role: "CASHIER", grantedPermissions: ["report:shop_sales"] });
    expect(hasPermission(c, "report:shop_sales")).toBe(true);
  });

  it("revoked_permissions can remove a cashier role default", () => {
    const c = makeUser({ role: "CASHIER", revokedPermissions: ["pos:request_refund"] });
    expect(hasPermission(c, "pos:request_refund")).toBe(false);
  });

  it("the negative-stock override is its own inventory permission", () => {
    // adjust_stock (migration 014) checks inventory:override_negative — no
    // longer reuses pos:override_stock. They are independent grants now.
    expect((ALL_PERMISSIONS as readonly string[]).includes("inventory:override_negative")).toBe(true);
    expect(hasPermission(manager(), "inventory:override_negative")).toBe(true);
    expect(hasPermission(cashier(), "inventory:override_negative")).toBe(false);
  });
});

// ---- SQL / TypeScript sync contract --------------------------------------

describe("SQL / TypeScript role-default sync", () => {
  // DEFAULT_ROLE_PERMISSIONS (src/types/domain.ts) and the SQL function
  // role_default_permissions() in the latest RBAC migration
  // are TWO HALVES OF ONE CONTRACT. This block is a tripwire: if a role's
  // default set changes, SQL role defaults must change in the same commit
  // (and a follow-up migration shipped). The counts are the migration-014
  // contract after supplier-debt permissions were added.
  it("each role has the documented number of default permissions", () => {
    expect(getRolePermissions("ADMIN")).toHaveLength(ALL_PERMISSIONS.length);
    // 56 + fin:approve_exception (Shop Admin, provisional PFIN-F: role_default_permissions ADMIN gains it there).
    expect(getRolePermissions("ADMIN").length).toBe(57);
    // 38 + purchase:approve + transfer:cancel (migration 057).
    expect(getRolePermissions("MANAGER")).toHaveLength(40);
    expect(getRolePermissions("CASHIER")).toHaveLength(10);
    expect(getRolePermissions("BUYER")).toHaveLength(5);
  });

  it("permissions removed by migration 014 are gone from the registry", () => {
    const removed = ["inventory:read", "report:shop", "report:profit"];
    for (const name of removed) {
      expect((ALL_PERMISSIONS as readonly string[]).includes(name)).toBe(false);
    }
  });
});

// ---- RBAC follow-up: permission-gated RLS read contract ------------------
//
// Migration 015 makes operational SELECT policies permission-gated. RLS itself
// runs in Postgres and cannot be exercised by vitest, but the *read model*
// depends on these role facts. If a role default drifts, the RLS reads drift
// silently — this block is the tripwire. The live behaviour is verified by
// docs/30-rls-permission-gating-checklist.md.

describe("RBAC follow-up — permission-gated RLS read contract", () => {
  const cashier = () => makeUser({ role: "CASHIER", shopId: "shop-a" });
  const manager = () => makeUser({ role: "MANAGER", shopId: "shop-a" });
  const buyer = () => makeUser({ role: "BUYER", shopId: "shop-a" });
  const admin = () => makeUser({ role: "ADMIN" });

  it("CASHIER reads only own sales — has sales:view_own_shift, not sale:view", () => {
    const c = cashier();
    expect(hasPermission(c, "sales:view_own_shift")).toBe(true); // own-sale / receipt reads
    expect(hasPermission(c, "sale:view")).toBe(false);           // no full shop history
  });

  it("CASHIER cannot read movements / audit / purchases through RLS", () => {
    const c = cashier();
    // The migration-015 policies require these permissions; a cashier lacks
    // them, so those SELECTs return zero rows.
    expect(hasPermission(c, "inventory:view_movements")).toBe(false);
    expect(hasPermission(c, "audit:view_shop")).toBe(false);
    expect(hasPermission(c, "audit:view_global")).toBe(false);
    expect(hasPermission(c, "purchase:view")).toBe(false);
    expect(hasPermission(c, "transfer:view")).toBe(false);
    // ...but keeps current stock visibility for the POS.
    expect(hasPermission(c, "inventory:view_stock")).toBe(true);
  });

  it("MANAGER keeps assigned-shop operational reads", () => {
    const m = manager();
    expect(hasPermission(m, "sale:view")).toBe(true);
    expect(hasPermission(m, "inventory:view_stock")).toBe(true);
    expect(hasPermission(m, "inventory:view_movements")).toBe(true);
    expect(hasPermission(m, "purchase:view")).toBe(true);
    expect(hasPermission(m, "transfer:view")).toBe(true);
    expect(hasPermission(m, "audit:view_shop")).toBe(true);
  });

  it("MANAGER cannot see the profit dashboard unless granted report:shop_profit", () => {
    expect(hasPermission(manager(), "report:shop_profit")).toBe(false);
    const granted = makeUser({
      role: "MANAGER",
      shopId: "shop-a",
      grantedPermissions: ["report:shop_profit"],
    });
    expect(hasPermission(granted, "report:shop_profit")).toBe(true);
    // ADMIN always sees profit.
    expect(hasPermission(admin(), "report:shop_profit")).toBe(true);
  });

  it("MANAGER keeps operational dashboard/report access", () => {
    const m = manager();
    expect(hasPermission(m, "report:shop_sales")).toBe(true);
    expect(hasPermission(m, "report:shop_inventory")).toBe(true);
  });

  it("BUYER (with a shop) reads & creates purchase orders", () => {
    const b = buyer();
    expect(b.shopId).toBeDefined(); // a shopless BUYER is a misconfiguration
    expect(hasPermission(b, "purchase:view")).toBe(true);
    expect(hasPermission(b, "purchase:create")).toBe(true);
    expect(hasPermission(b, "supplier:debt_view")).toBe(true);
    expect(hasShopPermission(b, "purchase:create", "shop-a")).toBe(true);
    expect(hasShopPermission(b, "purchase:create", "shop-b")).toBe(false);
  });

  it("BUYER cannot read sales / audit / movements through RLS", () => {
    const b = buyer();
    expect(hasPermission(b, "sale:view")).toBe(false);
    expect(hasPermission(b, "sales:view_own_shift")).toBe(false);
    expect(hasPermission(b, "inventory:view_movements")).toBe(false);
    expect(hasPermission(b, "audit:view_shop")).toBe(false);
  });

  it("ADMIN reads everything", () => {
    const a = admin();
    for (const p of ALL_PERMISSIONS) expect(hasPermission(a, p)).toBe(true);
  });
});

// ---- migration 015 SQL: every sensitive SELECT policy is permission-gated --

describe("migration 015 — permission-gated SELECT RLS policies", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/015_permission_gated_select_rls.sql", import.meta.url)),
    "utf8",
  );

  const policyBody = (table: string): string => {
    const marker = `CREATE POLICY "${table}_sel"`;
    const start = sql.indexOf(marker);
    expect(start, `${table}_sel policy must exist`).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf(";", start));
  };

  it("adds the app_user_id() identity helper", () => {
    expect(sql).toContain("FUNCTION app_user_id()");
  });

  // Directly-gated tables must check a permission (app_has_perm), not just shop.
  const directGated: Record<string, string> = {
    sales: "sale:view",
    inventory: "inventory:view_stock",
    inventory_movements: "inventory:view_movements",
    shifts: "report:own_shift",
    purchase_orders: "purchase:view",
    stock_transfers: "transfer:view",
    refund_void_requests: "pos:refund",
    audit_logs: "audit:view_shop",
  };
  for (const [table, perm] of Object.entries(directGated)) {
    it(`${table}_sel checks a permission, not only shop scope`, () => {
      const body = policyBody(table);
      expect(body).toContain("app_has_perm(");
      expect(body).toContain(perm);
    });
  }

  // Child tables must be readable only via their parent row.
  const childTables = ["sale_items", "purchase_order_items", "stock_transfer_items", "reprint_logs"];
  for (const table of childTables) {
    it(`${table}_sel is gated by parent-row visibility`, () => {
      // the policy delegates to an EXISTS sub-select on the parent table
      const body = policyBody(table);
      expect(body).toContain("EXISTS");
      expect(body).toContain("SELECT 1 FROM");
    });
  }

  it("does not modify write policies or grants", () => {
    expect(sql).not.toContain("FOR INSERT");
    expect(sql).not.toContain("FOR UPDATE");
    expect(sql).not.toContain("FOR DELETE");
  });
});

describe("migration 018 — supplier debt/payments security contract", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../supabase/migrations/018_supplier_debt_payments.sql", import.meta.url)),
    "utf8",
  );

  it("adds supplier debt/payment permissions to SQL role defaults", () => {
    expect(sql).toContain("supplier:debt_view");
    expect(sql).toContain("supplier:payment_create");
  });

  it("creates supplier_payments with RPC-only writes", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS supplier_payments");
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE ON supplier_payments FROM authenticated");
    expect(sql).not.toContain('CREATE POLICY "supplier_payments_ins"');
  });

  it("supplier_payments SELECT is shop and permission scoped", () => {
    const marker = 'CREATE POLICY "supplier_payments_sel"';
    const start = sql.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf(";", start));
    expect(body).toContain("shop_id = app_shop_id()");
    expect(body).toContain("app_has_perm('supplier:debt_view')");
    expect(body).toContain("app_has_perm('purchase:view')");
  });

  it("adds the record_supplier_payment RPC and grants execute only", () => {
    expect(sql).toContain("FUNCTION record_supplier_payment");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION record_supplier_payment");
  });
});
