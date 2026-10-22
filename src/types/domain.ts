export type Role = "ADMIN" | "MANAGER" | "CASHIER" | "BUYER";
export type ProductCategory = string; // Dynamic categories
export type BarcodeType = "EAN13" | "CODE128" | "QR";

// Category entity for dynamic category management
export interface Category {
  id: string;
  name: string;
  color: "amber" | "red" | "green" | "blue" | "purple" | "slate" | "pink" | "teal" | "indigo" | "yellow" | "orange" | "cyan" | "lime" | "emerald" | "sky" | "violet" | "fuchsia" | "rose";
  /**
   * Category icon registry key (see src/features/categories/categoryIcons.ts).
   * Optional — older categories without it fall back to a name-based match.
   */
  iconKey?: string;
  isActive: boolean;
  createdAt: string;
  /** Auto-touched on every UPDATE (migration 044) — drives delta pull-sync,
   *  see stores/data/deltaSync.ts. */
  updatedAt?: string;
}

/**
 * Brand entity — child of Category (see migration 031). A Brand groups
 * products under a Category (e.g. WHISKY → GRAND ROYAL, ROYAL CLUB).
 * `color` is optional; brands without one inherit their category color
 * in the UI.
 */
export interface Brand {
  id: string;
  categoryId: string;
  name: string;
  color?: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
export type PaymentMethod = "CASH" | "OTHER";
export type SaleStatus = "NORMAL" | "VOID" | "REFUNDED";
export type ApprovalStatus = "REQUESTED" | "APPROVED" | "REJECTED";

// Stock Movement Types (Ledger-Based)
export type StockMovementType =
  | "PURCHASE_IN"    // Stock received from supplier
  | "SALE_OUT"       // Stock sold to customer
  | "TRANSFER_OUT"   // Stock sent to another shop
  | "TRANSFER_IN"    // Stock received from another shop
  | "ADJUSTMENT"     // Manual stock correction
  | "DAMAGE"         // Damaged/expired stock write-off
  | "RETURN_IN"      // Customer return
  | "RETURN_OUT";    // Return to supplier

// Stock Transfer Status
export type TransferStatus = "PENDING" | "APPROVED" | "IN_TRANSIT" | "COMPLETED" | "CANCELED" | "REJECTED";

// Purchase Order Status
export type PurchaseOrderStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "RECEIVED" | "CANCELED";
export type PurchasePaymentStatus = "UNPAID" | "PARTIAL" | "PAID";
export type SupplierPaymentMethod = "CASH" | "BANK" | "MOBILE" | "OTHER";

// ============================================
// Granular Permissions — single central registry.
// `Permission` is derived from ALL_PERMISSIONS so the runtime list and the
// type can never drift. Add new permissions here only.
// ============================================
export const ALL_PERMISSIONS = [
  // Shop Management
  "shop:create", "shop:read", "shop:update", "shop:delete",
  // User Management
  "user:create", "user:read", "user:update", "user:delete",
  // Product Management
  "product:create", "product:read", "product:update", "product:delete", "product:edit_price",
  "barcode:manage",
  // Inventory Management
  //   view_stock       = current on-hand availability (POS + stock list)
  //   view_movements   = stock movement / ledger history
  //   adjust / damage  = manual stock corrections / damage write-off
  //   override_negative = allow a manual adjustment to drive stock negative
  "inventory:view_stock", "inventory:view_movements", "inventory:adjust", "inventory:damage",
  "inventory:override_negative",
  // Stock Transfers
  "transfer:create", "transfer:approve", "transfer:cancel", "transfer:view",
  // POS / Sales
  //   request_refund / request_void = raise an approval request (cashier-level)
  //   refund / void_sale            = approve those requests (manager-level)
  //   sale:view          = full shop sales history
  //   sales:view_own_shift = the caller's own-shift sales (receipt access)
  "pos:create_sale", "pos:apply_discount", "pos:override_price", "pos:override_stock",
  "pos:void_sale", "pos:refund", "pos:request_refund", "pos:request_void",
  "sale:view", "sales:view_own_shift", "receipt:reprint",
  // Suppliers & Purchasing
  "supplier:create", "supplier:read", "supplier:update", "supplier:delete",
  "supplier:debt_view", "supplier:payment_create",
  "purchase:create", "purchase:approve", "purchase:receive", "purchase:view",
  // Pricing
  "pricing:manage",
  // Approvals
  "approval:view",
  // Shifts
  "shift:manage_own", "shift:manage_all", "shift:verify",
  // Reports
  //   own_shift   = a cashier's own shift summary
  //   shop_*      = assigned-shop reports (sales / inventory / profit)
  //   global      = cross-shop reporting. Profit/cost stays isolated in shop_profit.
  "report:own_shift", "report:shop_sales", "report:shop_inventory", "report:shop_profit",
  "report:global",
  // Audit
  "audit:view_shop", "audit:view_global",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export interface Shop {
  id: string;
  code: string;
  name: string;
  address: string;
  phone?: string;
  email?: string;
  isActive: boolean;
  createdAt: string;
}

// Business-wide brand (singleton). Edited on the Profile page; shown in the
// sidebar header and on receipts. All fields optional — fall back to the
// built-in default business name / static logo defaults when unset.
export interface BusinessProfile {
  businessName?: string;
  logoUrl?: string;
  address?: string;
  phone?: string;
  email?: string;
  tagline?: string;
}

export interface User {
  id: string;
  name: string;
  email?: string;
  role: Role;
  shopId?: string;
  /** Migration 059 — every real user row has one; optional here (not
   *  required) since plenty of call sites (tests, ad-hoc User construction)
   *  don't know or care about org scoping yet — nothing enforces it. */
  orgId?: string;
  authId?: string; // Supabase Auth account link (auth.users.id)
  /**
   * @deprecated Legacy replacement-model permissions. Superseded by
   * grantedPermissions / revokedPermissions. Retained only so pre-migration
   * users keep their access until migration 002 backfills the new fields.
   */
  permissions?: Permission[];
  grantedPermissions?: Permission[]; // additive — granted on top of role defaults
  revokedPermissions?: Permission[]; // explicit denials — win over role default and grant
  isActive: boolean;
  createdAt: string;
}

/**
 * Admin-managed unit registry (see migration 025). Each row defines a base
 * stock unit (Piece, Can, Sachet, Kilogram, ...). The Product form pulls
 * its dropdown from active rows here.
 */
export interface UnitType {
  id: string;
  name: string;
  abbreviation?: string;
  description?: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Default purchase terms recorded against a product (migration 032).
 * Carried through to new purchase orders as the supplier-default term.
 * `null` / undefined means "ask each time" — never assume a default.
 */
export type ProductPurchaseType = "COD" | "CREDIT";

export interface Product {
  id: string;
  sku?: string;
  /** Optional secondary identifier (e.g. supplier code, barcode-as-text). */
  aliasCode?: string;
  name: string;
  /** Compact display name for tight UI (POS tile, receipt). */
  shortName?: string;
  category: ProductCategory;
  /**
   * Optional brand FK (migration 031). Required for products created
   * after the brand rollout — enforced at the form layer, NOT the DB,
   * so legacy products keep working without a backfill.
   */
  brandId?: string;
  /**
   * Base stock unit name. Free-form string for backward compatibility with
   * pre-registry products. New products select from `UnitType.name` values;
   * legacy products keep their original string ("piece" / "box" / ...).
   */
  unitType: string;
  priceMmk: number;
  costMmk?: number;
  /**
   * @deprecated Legacy single-pack quantity. The product form no longer
   * collects this value; future package selling should use Product Units /
   * Sellable Units instead.
   */
  packSize?: number;
  lowStockThreshold: number;
  /** Reorder ceiling (migration 032). NULL = no ceiling. */
  maxQty?: number;
  /** When true, POS prompts cashier for price at cart-add. */
  isOpenPrice?: boolean;
  /** When true, sales of this product skip inventory deduction. */
  isNonStock?: boolean;
  /** Default purchase terms used when creating a new PO. */
  purchaseType?: ProductPurchaseType;
  expiryDate?: string; // Optional expiry tracking
  imageUrl?: string; // Product image URL
  isActive: boolean;
  createdAt: string;
  /** Auto-touched on every UPDATE (migration 044) — drives delta pull-sync,
   *  see stores/data/deltaSync.ts. Optional only for rows read before the
   *  migration ran; always present afterward. */
  updatedAt?: string;
}

/**
 * Product-specific sellable unit. Inventory is still stored in the product's
 * base `unitType`; `baseQuantity` is how many base units one sellable unit
 * deducts in POS.
 *
 * `salePriceMmk` is what cashiers ring — required, non-negative integer.
 * `purchasePriceMmk` is the per-unit cost paid to the supplier — optional,
 * non-negative integer. Both columns enter the DB in migration 027.
 */
export interface ProductUnit {
  id: string;
  productId: string;
  name: string;
  baseQuantity: number;
  salePriceMmk: number;
  purchasePriceMmk?: number;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Manual POS price level (Retail / Wholesale / Special). Cashiers pick
 * the level at the top of POS; the price for `(product_unit, price_level,
 * shop)` comes from `product_unit_prices` with the fallback chain
 * documented in migration 030 + the `resolveProductUnitPrice` helper.
 */
export interface PriceLevel {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-unit, per-level price row. `shopId` null = global price; non-null
 * = shop-specific override that wins over the global row for the same
 * unit + level.
 */
export interface ProductUnitPrice {
  id: string;
  productUnitId: string;
  priceLevelId: string;
  shopId?: string;
  priceMmk: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Tier-Based Pricing (quantity-based price breaks)
export interface PriceTier {
  id: string;
  productId: string;
  shopId?: string; // null = applies to all shops
  minQty: number;  // Minimum quantity for this tier
  maxQty?: number; // Maximum quantity (null = unlimited)
  priceMmk: number;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
}

// Supplier Management
export interface Supplier {
  id: string;
  code: string;
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  /** Auto-touched on every UPDATE (migration 044) — drives delta pull-sync,
   *  see stores/data/deltaSync.ts. */
  updatedAt?: string;
}

// Many-to-many link between a supplier and the products it can supply.
export interface SupplierProduct {
  supplierId: string;
  productId: string;
}

// Purchase Order
export interface PurchaseOrder {
  id: string;
  orderNo: string;
  shopId: string;
  supplierId: string;
  status: PurchaseOrderStatus;
  subtotalMmk: number;
  taxMmk?: number;
  totalMmk: number;
  paidMmk?: number;
  paymentStatus?: PurchasePaymentStatus;
  supplierInvoiceNo?: string;
  deliveryNoteNo?: string;
  notes?: string;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  receivedBy?: string;
  receivedAt?: string;
  /** Set on a PO received locally while offline, cleared once the outbox
   *  entry that produced it has synced. See stores/data/outbox.ts. */
  pendingSync?: boolean;
  /** Idempotency key of the operation that created/changed this row while
   *  offline — the same UUID the queued RPC sends as `p_idempotency_key`.
   *  Lets a provisional record be matched to its outbox entry. */
  idempotencyKey?: string;
  /** Auto-touched on every UPDATE (migration 044) — drives delta pull-sync,
   *  see stores/data/deltaSync.ts. */
  updatedAt?: string;
}

export interface PurchaseOrderItem {
  id: string;
  purchaseOrderId: string;
  productId: string;
  /** Always stored in base units. The selected-unit qty (e.g. "10 Package")
   *  lives in `selectedUnitQuantity` with its `productUnitId` + snapshot. */
  orderedQty: number;
  receivedQty?: number;
  unitCostMmk: number;
  lineTotalMmk: number;
  // Unit snapshot from migration 028 — populated when the receive UI
  // picked a sellable unit. `null`/`undefined` on legacy rows received
  // before the unit-aware RPC was deployed.
  productUnitId?: string;
  unitNameSnapshot?: string;
  unitBaseQuantitySnapshot?: number;
  selectedUnitQuantity?: number;
  unitPurchasePriceSnapshot?: number;
}

export interface SupplierPayment {
  id: string;
  supplierId: string;
  purchaseOrderId: string;
  shopId: string;
  amountMmk: number;
  paymentMethod: SupplierPaymentMethod;
  referenceNo?: string;
  notes?: string;
  paidAt: string;
  createdBy: string;
  createdAt: string;
  voidedAt?: string;
  voidedBy?: string;
  voidReason?: string;
  /** Set on a payment recorded locally while offline, cleared once the
   *  outbox entry that produced it has synced. See stores/data/outbox.ts. */
  pendingSync?: boolean;
  /** Idempotency key of the operation that created/changed this row while
   *  offline — the same UUID the queued RPC sends as `p_idempotency_key`.
   *  Lets a provisional record be matched to its outbox entry. */
  idempotencyKey?: string;
}

// Stock Transfer Between Shops
export interface StockTransfer {
  id: string;
  transferNo: string;
  fromShopId: string;
  toShopId: string;
  status: TransferStatus;
  notes?: string;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  dispatchedBy?: string;
  dispatchedAt?: string;
  receivedBy?: string;
  receivedAt?: string;
  completedAt?: string;
  canceledBy?: string;
  canceledAt?: string;
  cancelReason?: string;
  /** Set on a transfer dispatched/received locally while offline, cleared
   *  once the outbox entry that produced it has synced. See
   *  stores/data/outbox.ts. */
  pendingSync?: boolean;
  /** Idempotency key of the operation that created/changed this row while
   *  offline — the same UUID the queued RPC sends as `p_idempotency_key`.
   *  Lets a provisional record be matched to its outbox entry. */
  idempotencyKey?: string;
  /** Auto-touched on every UPDATE (migration 044) — drives delta pull-sync,
   *  see stores/data/deltaSync.ts. */
  updatedAt?: string;
}

export interface StockTransferItem {
  id: string;
  transferId: string;
  productId: string;
  requestedQty: number;
  approvedQty?: number;
  transferredQty?: number;
  // Reserved for the next phase — `complete_stock_transfer` (migration 028)
  // already propagates these into the movement rows when they are set on
  // the item, so the transfer-create UI can start populating them without
  // another migration.
  productUnitId?: string;
  unitNameSnapshot?: string;
  unitBaseQuantitySnapshot?: number;
  selectedUnitQuantity?: number;
}

export interface ProductBarcode {
  id: string;
  productId: string;
  /** Optional sellable-unit mapping; null/undefined means product/default unit. */
  productUnitId?: string;
  value: string;
  type: BarcodeType;
}

export interface Inventory {
  shopId: string;
  productId: string;
  qtyBaseUnits: number;
  storageLocation?: string;
  lastCountedAt?: string;
}

// Ledger-Based Stock Movement - Every stock change MUST create a movement record
export interface InventoryMovement {
  id: string;
  shopId: string;
  productId: string;
  type: StockMovementType;
  qtyChange: number; // Positive = IN, Negative = OUT — always in base units
  qtyBefore: number; // Stock level before this movement
  qtyAfter: number;  // Stock level after this movement
  reason: string;
  referenceType?: "sale" | "transfer" | "purchase" | "adjustment" | "damage";
  referenceId?: string; // ID of related sale/transfer/purchase
  createdBy: string;
  createdAt: string;
  // Unit snapshot from migration 028 — present when the action came from
  // a unit-aware workflow (e.g. "received 10 Package", "damaged 1 Case").
  // The base-unit total is still on `qtyChange`; these fields are
  // additional UI context so the ledger can render
  // "+240 Can (entered as 10 Package)".
  productUnitId?: string;
  unitNameSnapshot?: string;
  unitBaseQuantitySnapshot?: number;
  selectedUnitQuantity?: number;
  /** Set on a movement created locally while offline, cleared once the
   *  outbox entry that produced it has synced. See stores/data/outbox.ts. */
  pendingSync?: boolean;
  /** Idempotency key of the operation that created/changed this row while
   *  offline — the same UUID the queued RPC sends as `p_idempotency_key`.
   *  Lets a provisional record be matched to its outbox entry. */
  idempotencyKey?: string;
}

export interface Shift {
  id: string;
  shopId: string;
  cashierId: string;
  startedAt: string;
  endedAt?: string;
  openingCashMmk: number;
  closingCashMmk?: number;
  expectedCashMmk?: number;
  varianceMmk?: number;
  varianceReason?: string;
  /** Set on a shift opened/closed locally while offline, cleared once the
   *  outbox entry that produced it has synced. See stores/data/outbox.ts. */
  pendingSync?: boolean;
  /** Idempotency key of the operation that created/changed this row while
   *  offline — the same UUID the queued RPC sends as `p_idempotency_key`.
   *  Lets a provisional record be matched to its outbox entry. */
  idempotencyKey?: string;
  /** Auto-touched on every UPDATE (migration 044) — drives delta pull-sync,
   *  see stores/data/deltaSync.ts. */
  updatedAt?: string;
}

export interface Sale {
  id: string;
  shopId: string;
  shiftId: string;
  receiptNo: string;
  cashierId: string;
  status: SaleStatus;
  subtotalMmk: number;
  discountMmk: number;
  cartDiscountPct?: number;
  totalMmk: number;
  paymentMethod: PaymentMethod;
  paidMmk: number;
  changeMmk: number;
  createdAt: string;
  /** Step 4 (PFIN-D): the payment lines, when this till knows them (a sale rung up here with a split).
   *  Otherwise the single legacy method applies (paymentMethod, totalMmk). Never used as an authoritative
   *  figure: expected cash comes from the server (fin_shift_cash_summary). */
  payments?: { method: string; amountMmk: number; tenderedMmk: number; reference: string | null }[];
  /** Set on a sale completed locally while offline (a provisional record —
   *  receiptNo is a placeholder until the real complete_sale RPC runs).
   *  Cleared once the outbox entry syncs. See stores/data/outbox.ts. */
  pendingSync?: boolean;
  /** The server may or may not have this sale (its reply was lost): it is
   *  shown as UNCONFIRMED — never as a recorded sale, no final receipt —
   *  until the queued resend (same key) settles it. Local only. */
  pendingConfirmation?: boolean;
  /** Idempotency key of the operation that created/changed this row while
   *  offline — the same UUID the queued RPC sends as `p_idempotency_key`.
   *  Lets a provisional record be matched to its outbox entry. */
  idempotencyKey?: string;
}

export interface SaleItem {
  id?: string;
  saleId: string;
  productId: string;
  qtyUnits: number;
  unitPriceMmk: number;
  itemDiscountPct?: number;
  lineTotalMmk: number;
  priceOverriddenBy?: string;
  unitLabel?: string;
  unitsPerItem?: number;
  productUnitId?: string;
  unitNameSnapshot?: string;
  unitBaseQuantitySnapshot?: number;
  unitPriceMmkSnapshot?: number;
  baseQuantitySold?: number;
  /** Product base-unit cost captured at sale time (migration 041) for true
   *  COGS. NULL on rows sold before the snapshot shipped. */
  unitCostMmkSnapshot?: number;
  stockOverrideBy?: string;
  // Price-level snapshot (migration 030). NULL on pre-030 rows.
  priceLevelId?: string;
  priceLevelNameSnapshot?: string;
  priceSourceSnapshot?: string;
}

export interface ReprintLog {
  id: string;
  saleId: string;
  printedBy: string;
  printedAt: string;
}

export interface RefundVoidRequest {
  id: string;
  saleId: string;
  shopId: string;
  type: "VOID" | "PARTIAL";
  reason: string;
  createdBy: string;
  createdAt: string;
  items?: { productId: string; qtyUnits: number; amountMmk: number }[];
  status?: ApprovalStatus;
  /** Set on a request created locally while offline, cleared once the
   *  outbox entry that produced it has synced. See stores/data/outbox.ts. */
  pendingSync?: boolean;
  /** Idempotency key of the operation that created/changed this row while
   *  offline — the same UUID the queued RPC sends as `p_idempotency_key`.
   *  Lets a provisional record be matched to its outbox entry. */
  idempotencyKey?: string;
}

export interface AuditLog {
  id: string;
  shopId?: string;
  actorId: string;
  actionType: string;
  message: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export interface CartItem {
  id: string;
  productId: string;
  productUnitId: string;
  name: string;
  unitName: string;
  qty: number;
  /** Price for one selected sellable unit (resolved from the active
   *  price level — see resolveProductUnitPrice). */
  unitPriceMmk: number;
  itemDiscountPct?: number;
  /** Legacy display alias kept for older components/tests. */
  unitLabel?: string;
  /** Legacy base-quantity alias; equal to `unitBaseQuantity`. */
  unitsPerItem: number;
  unitBaseQuantity: number;
  priceOverriddenBy?: string;
  stockOverrideBy?: string;
  // Price-level selection (migration 030). Cart uniqueness key widened
  // to `productId + productUnitId + priceLevelId` so the same product
  // can appear as Retail + Wholesale on the same receipt.
  priceLevelId?: string;
  priceLevelName?: string;
  /** Snapshot of `products.is_open_price` at add-time. Skips the cashier
   *  price-override audit log because the cashier was the price source
   *  from the start, not overriding a fixed price. */
  isOpenPrice?: boolean;
  /** Snapshot of `products.is_non_stock`. The cart stock helpers, the
   *  checkout validator, and `complete_sale` all bypass inventory
   *  checks / movements for items carrying this flag. */
  isNonStock?: boolean;
  // Display fields
  imageUrl?: string;
  category?: ProductCategory;
}

export type Refund = RefundVoidRequest;

// ============================================
// Role-Permission Mapping (Default Permissions)
// MUST be kept in sync with role_default_permissions() in
// supabase/migrations/014_rbac_role_tuning.sql — the SQL function is the
// source of truth for RLS / RPC checks and this object for the frontend.
// Any change here requires a matching change there (and a new migration).
// ============================================
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // ADMIN always has every permission in the registry.
  ADMIN: [...ALL_PERMISSIONS],
  MANAGER: [
    // Shop-scoped management & operations for the assigned shop only.
    "shop:read",
    "user:read",
    "product:read", "product:update", "product:edit_price",
    "inventory:view_stock", "inventory:view_movements", "inventory:adjust", "inventory:damage",
    "inventory:override_negative",
    "transfer:create", "transfer:approve", "transfer:cancel", "transfer:view",
    "pos:create_sale", "pos:apply_discount", "pos:override_price", "pos:override_stock",
    "pos:void_sale", "pos:refund", "pos:request_refund", "pos:request_void",
    "sale:view", "sales:view_own_shift", "receipt:reprint",
    "supplier:read",
    "supplier:debt_view", "supplier:payment_create",
    "purchase:create", "purchase:approve", "purchase:receive", "purchase:view",
    "approval:view",
    "shift:manage_own", "shift:manage_all", "shift:verify",
    // Operational shop reports only — profit/global stay ADMIN-only.
    "report:own_shift", "report:shop_sales", "report:shop_inventory",
    "audit:view_shop",
  ],
  CASHIER: [
    // POS-only: ring up sales, run own shift, raise (not approve) requests.
    "product:read",
    "inventory:view_stock",
    "pos:create_sale", "pos:apply_discount", "pos:request_refund", "pos:request_void",
    "sales:view_own_shift", "receipt:reprint",
    "shift:manage_own",
    "report:own_shift",
  ],
  BUYER: [
    // Limited catalog + purchasing role: browse catalog/suppliers and
    // create/view purchase orders. No approving, receiving or stock writes.
    "product:read",
    "supplier:read", "supplier:debt_view",
    "purchase:view", "purchase:create",
  ],
};

// Permission helper functions live in src/lib/permissions.ts (the central
// registry). They are kept out of this types file deliberately.
