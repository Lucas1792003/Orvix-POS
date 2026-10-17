import type {
  AuditLog,
  Brand,
  BusinessProfile,
  CartItem,
  Category,
  Inventory,
  InventoryMovement,
  Product,
  ProductBarcode,
  ProductUnit,
  PriceTier,
  PurchaseOrder,
  PurchaseOrderItem,
  Refund,
  Sale,
  SaleItem,
  Shift,
  Shop,
  StockTransfer,
  StockTransferItem,
  StockMovementType,
  PriceLevel,
  ProductUnitPrice,
  Supplier,
  SupplierPayment,
  SupplierPaymentMethod,
  SupplierProduct,
  UnitType,
  User,
} from "../../types";
import type { BarcodeSavePlan } from "../../features/catalog/productBarcodeForm";

// ============================================
// Input Types for Actions
// ============================================

export interface CreateSaleInput {
  shopId: string;
  cashierId: string;
  shiftId: string;
  cartItems: CartItem[];
  cartDiscountPct: number;
  paymentMethod: "CASH" | "OTHER";
  paidMmk: number;
}

export interface RefundItemInput {
  productId: string;
  qtyUnits: number;
  amountMmk: number;
}

export interface CreateTransferInput {
  fromShopId: string;
  toShopId: string;
  items: {
    productId: string;
    /** Legacy base-unit path. New transfer UI sends productUnitId + selectedUnitQuantity. */
    requestedQty?: number;
    productUnitId?: string;
    selectedUnitQuantity?: number;
  }[];
  notes?: string;
  createdBy: string;
}

export interface CreatePurchaseOrderInput {
  shopId: string;
  supplierId: string;
  items: { productId: string; orderedQty: number; unitCostMmk: number }[];
  notes?: string;
  createdBy: string;
}

export interface CreateSupplierInput {
  code: string;
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export interface AdjustStockInput {
  shopId: string;
  productId: string;
  type: StockMovementType;
  /** Signed base-unit delta. Negative for DAMAGE / ADJUSTMENT-out, positive
   *  for stock-in. When `productUnitId` is provided, the server replaces
   *  the magnitude with `unitQty * unit.base_quantity` and keeps the sign
   *  from this field. Pass ±1 as a direction hint in the unit-aware path. */
  qtyChange: number;
  reason: string;
  actorId: string;
  referenceType?: "sale" | "transfer" | "purchase" | "adjustment" | "damage";
  referenceId?: string;
  /** Unit-aware adjustment (migration 028). When set, server computes
   *  base delta from `unitQty * product_unit.base_quantity`. */
  productUnitId?: string;
  unitQty?: number;
}

// ============================================
// State Slices
// ============================================

// Staff creation goes through the staff-admin Edge Function (auth account +
// users row server-side); see src/lib/staffAdmin.ts.
import type { CreateStaffInput } from "../../lib/staffAdmin";
export type { CreateStaffInput };

export interface ShopState {
  shops: Shop[];
  users: User[];
  // Business-wide brand (singleton). Loaded with the rest of the data; null
  // until loaded. Callers fall back to built-in defaults when unset.
  businessProfile: BusinessProfile | null;
  addShop: (shop: Shop) => Promise<void>;
  updateShop: (shop: Shop) => Promise<void>;
  deleteShop: (shopId: string) => Promise<void>;
  createStaffUser: (input: CreateStaffInput) => Promise<User>;
  updateUser: (user: User) => Promise<void>;
  deactivateUser: (userId: string, isActive: boolean) => Promise<void>;
  replaceManager: (shopId: string, newManagerId: string) => Promise<void>;
  updateBusinessProfile: (profile: BusinessProfile) => Promise<void>;
}

export interface CategoryState {
  categories: Category[];
  addCategory: (category: Category) => void;
  updateCategory: (category: Category) => void;
  deleteCategory: (categoryId: string) => void;
}

export interface BrandState {
  brands: Brand[];
  addBrand: (brand: Brand) => Promise<void>;
  updateBrand: (brand: Brand) => Promise<void>;
  /**
   * Soft delete — flips is_active=false. Throws a friendly error if any
   * product still references the brand so callers can surface it inline.
   */
  deactivateBrand: (brandId: string) => Promise<void>;
}

export interface UnitTypeState {
  unitTypes: UnitType[];
  addUnitType: (unitType: UnitType) => void;
  updateUnitType: (unitType: UnitType) => void;
  /** Soft delete — flips is_active to false. Hard delete is not exposed. */
  deactivateUnitType: (unitTypeId: string) => void;
}

export interface PriceLevelState {
  priceLevels: PriceLevel[];
  productUnitPrices: ProductUnitPrice[];
  /**
   * Replace the active per-level prices for a product unit. Inactive
   * legacy rows are flipped to is_active=false. `shopId === undefined`
   * means a global row.
   */
  replaceProductUnitPrices: (
    productUnitId: string,
    prices: { priceLevelId: string; shopId?: string; priceMmk: number }[],
  ) => Promise<void>;
}

export interface ProductState {
  products: Product[];
  productUnits: ProductUnit[];
  barcodes: ProductBarcode[];
  /** Many-to-many supplier⇄product links (which products each supplier sells). */
  supplierProducts: SupplierProduct[];
  addProduct: (product: Product, barcodes: ProductBarcode[]) => Promise<void>;
  /** Omit `barcodes` to leave the product's barcodes untouched (product
   *  form); pass the full list to replace them (CSV import). */
  updateProduct: (product: Product, barcodes?: ProductBarcode[]) => Promise<void>;
  /**
   * Hard delete a product. Removes the row from `products` and any
   * inventory rows for it (the `inventory.product_id` FK has no CASCADE).
   * `product_barcodes` and `price_tiers` cascade-delete automatically.
   * Throws on DB failure so the caller can surface it.
   */
  deleteProduct: (productId: string) => Promise<void>;
  /**
   * Apply the product form's barcode diff (planProductBarcodeSave): delete
   * only the named rows of this product, then insert the new ones. Throws
   * on DB failure (incl. the unique `product_barcodes_unique_normalized_value`
   * index) so the form can surface duplicate-barcode errors inline. Never
   * touches rows the plan does not name.
   */
  applyProductBarcodeChanges: (productId: string, plan: BarcodeSavePlan) => Promise<void>;
  replaceProductUnits: (productId: string, units: ProductUnit[]) => Promise<void>;
  /**
   * Reconcile the supplier links for a product (delete-then-insert). Throws on
   * DB failure so the product form can surface it. Managed from the product
   * form; gated server-side on product:create/product:update.
   */
  replaceProductSuppliers: (productId: string, supplierIds: string[]) => Promise<void>;
  /** Link one or more products to a supplier (supplier-side, skips existing). */
  addSupplierProducts: (supplierId: string, productIds: string[]) => Promise<void>;
  /** Unlink a single product from a supplier. */
  removeSupplierProduct: (supplierId: string, productId: string) => Promise<void>;
  getProductByBarcode: (value: string) => { product: Product; unit: ProductUnit } | undefined;
}

/** Provisional local rows (by table + id) an offline write created — see
 *  stores/data/outbox.ts and localWrites.ts. */
export type ProvisionalRef = { table: string; ids: string[] }[];

/** A Realtime inventory change captured while a paged read is in flight
 *  (row null = DELETE; ts = server commit time in ms, +Infinity if unknown). */
export interface BufferedInventoryEvent {
  row: Inventory | null;
  shopId: string;
  productId: string;
  ts: number;
}

export interface InventoryState {
  inventory: Inventory[];
  movements: InventoryMovement[];
  /** Internal (loadData): collect Realtime inventory events until finish(). */
  captureInventoryEvents: () => { finish: () => BufferedInventoryEvent[] };
  /** Internal (loadData): the unresolved stock effects a full load applied
   *  (per outbox entry — see stockLedger.ts). */
  noteStockLedger: (applied: Map<string, Map<string, number>>, pendingConfirmation: Map<string, number>) => void;
  /** Internal (startup): adopt the ledger for rows rendered from the mirror. */
  adoptStockLedger: () => Promise<void>;
  /** Internal (loadData): a marker taken BEFORE the server reads. */
  beginStockRead: () => number;
  /** Internal (loadData): server inventory rows as they must be displayed
   *  (unresolved effects, acknowledgements during the read, live events).
   *  Null when the queue cannot be read (fail closed). */
  composeServerStock: (
    serverRows: Inventory[], marker: number, events: BufferedInventoryEvent[], sinceTs?: number,
  ) => Promise<{ rows: Inventory[]; applied: Map<string, Map<string, number>>; pendingConfirmation: Record<string, number>; followUp: boolean } | null>;
  /** Base units per "shopId|productId" whose deduction awaits the server's
   *  confirmation (in flight or outcome unknown). Shown as "pending
   *  confirmation"; already subtracted from the displayed stock. */
  stockPendingConfirmation: Record<string, number>;
  /** Recompute the displayed stock against the queue (tests, diagnostics). */
  syncStockWithQueue: () => Promise<void>;
  /** Set when the queue's stock effects could not be read (fail closed):
   *  stock shown is the last known figure and offline stock checks refuse. */
  stockUnverified: boolean;
  adjustStock: (input: AdjustStockInput) => Promise<void>;
  recordDamage: (input: { shopId: string; productId: string; qty: number; reason: string; actorId: string }) => Promise<void>;
  getInventoryQty: (shopId: string, productId: string) => number;
  /** Internal — called by the outbox drain once adjust_stock actually runs
   *  server-side, to replace the provisional local movement with the
   *  authoritative one. Not for direct UI use. */
  reconcileAdjustStock: (data: unknown, provisional: ProvisionalRef, ackId?: string) => void;
  /** Internal — called by the Realtime subscription (stores/data/
   *  inventoryRealtime.ts) when another device changes a stock level.
   *  `commitTimestamp` is the event's server commit time: an event older
   *  than the last server-authoritative state held for that row (a
   *  refresh, or a later event) is ignored. Not for direct UI use. */
  applyInventoryRealtimeUpdate: (row: Inventory, commitTimestamp?: string) => void;
  /** Internal — Realtime DELETE for an inventory row (product removed). */
  applyInventoryRealtimeDelete: (shopId: string, productId: string, commitTimestamp?: string) => void;
  /**
   * Server-authoritative stock refresh (Phase G): re-reads the `inventory`
   * rows for `shopId` (the current shop when omitted; `null` = every row
   * RLS lets this user read, i.e. all shops for an ADMIN with no shop
   * selected) and REPLACES the local rows in that scope — no merge — then
   * re-applies the provisional deltas of operations still queued in the
   * outbox so an offline sale stays visible. Resolves true on success,
   * false when the server could not be reached (nothing is changed then).
   * Run after every Realtime gap and periodically while the channel is
   * down; also safe to call any time.
   */
  refreshInventoryFromServer: (options?: { shopId?: string | null }) => Promise<boolean>;
}

export interface ShiftState {
  shifts: Shift[];
  startShift: (input: { shopId: string; cashierId: string; openingCashMmk: number }) => Promise<string>;
  endShift: (input: { shiftId: string; closingCashMmk: number; varianceReason?: string }) => Promise<void>;
  requireShiftForCashier: (shopId: string, cashierId: string) => Shift | undefined;
  /** Internal — called by the outbox drain once open_shift/close_shift
   *  actually runs server-side. Not for direct UI use. */
  reconcileOpenShift: (data: unknown, provisional: ProvisionalRef) => void;
  reconcileCloseShift: (data: unknown, provisional: ProvisionalRef) => void;
}

export interface SaleState {
  sales: Sale[];
  saleItems: SaleItem[];
  refunds: Refund[];
  refundVoidRequests: Refund[];
  createSale: (input: CreateSaleInput) => Promise<string>;
  voidSale: (input: { saleId: string; reason: string; actorId: string }) => Promise<void>;
  requestVoid: (input: { saleId: string; reason: string; actorId: string }) => Promise<void>;
  requestRefund: (input: { saleId: string; items: RefundItemInput[]; reason: string; actorId: string }) => Promise<void>;
  approveRefund: (input: { refundId: string; approverId: string }) => Promise<void>;
  /** Online only, like approval: reject_refund_void_request (070) with a reason. */
  rejectRefund: (input: { refundId: string; reason: string }) => Promise<void>;
  /** Internal — called by the outbox drain once complete_sale actually runs
   *  server-side, to replace the provisional local sale with the
   *  authoritative one. Not for direct UI use. */
  reconcileCompleteSale: (data: unknown, provisional: ProvisionalRef, ackId?: string) => void;
  /** Internal — called by the outbox drain once a queued
   *  create_refund_void_request actually runs server-side (covers both
   *  requestVoid and requestRefund, which share the RPC). Not for direct
   *  UI use. */
  reconcileCreateRefundVoidRequest: (data: unknown, provisional: ProvisionalRef) => void;
}

export interface TransferState {
  stockTransfers: StockTransfer[];
  stockTransferItems: StockTransferItem[];
  createTransfer: (input: CreateTransferInput) => Promise<string>;
  approveTransfer: (input: { transferId: string; approverId: string; approvedItems?: { productId: string; approvedQty: number }[] }) => Promise<void>;
  rejectTransfer: (input: { transferId: string; actorId: string; reason: string }) => Promise<void>;
  /** Source marks an APPROVED transfer IN_TRANSIT (no inventory change yet). */
  dispatchTransfer: (input: { transferId: string; actorId: string }) => Promise<void>;
  /**
   * Destination confirms receipt of an IN_TRANSIT transfer, moving stock
   * (source → dest) for the received quantities. `receivedItems` lets the
   * destination record a short receipt (per-line base qty ≤ approved); when
   * omitted, the full approved quantity is received.
   */
  receiveTransfer: (input: {
    transferId: string;
    actorId: string;
    receivedItems?: { productId: string; receivedQty: number }[];
  }) => Promise<void>;
  cancelTransfer: (input: { transferId: string; actorId: string; reason: string }) => Promise<void>;
  getTransfersByShop: (shopId: string) => StockTransfer[];
  getPendingTransfersForApproval: (shopId: string) => StockTransfer[];
  /** Internal — called by the outbox drain once a queued dispatch/receive
   *  actually runs server-side. Not for direct UI use. */
  reconcileDispatchTransfer: (data: unknown, provisional: ProvisionalRef) => void;
  reconcileReceiveTransfer: (data: unknown, provisional: ProvisionalRef, ackId?: string) => void;
}

export interface PurchaseState {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  purchaseOrderItems: PurchaseOrderItem[];
  supplierPayments: SupplierPayment[];
  addSupplier: (input: CreateSupplierInput) => Promise<Supplier>;
  updateSupplier: (supplier: Supplier) => Promise<void>;
  createPurchaseOrder: (input: CreatePurchaseOrderInput) => Promise<string>;
  approvePurchaseOrder: (input: { purchaseOrderId: string; approverId: string }) => Promise<void>;
  /**
   * Receive a purchase order. Each item may pass either the legacy
   * `receivedQty` (base units) OR the unit-aware pair
   * `{ productUnitId, receivedUnitQty }`. The RPC computes base qty from
   * the unit pair server-side (migration 028).
   */
  receivePurchaseOrder: (input: {
    purchaseOrderId: string;
    receiverId: string;
    receivedItems: {
      productId: string;
      receivedQty?: number;
      productUnitId?: string;
      receivedUnitQty?: number;
    }[];
  }) => Promise<void>;
  cancelPurchaseOrder: (input: { purchaseOrderId: string; actorId: string }) => Promise<void>;
  recordSupplierPayment: (input: {
    purchaseOrderId: string;
    amountMmk: number;
    paymentMethod: SupplierPaymentMethod;
    referenceNo?: string;
    notes?: string;
  }) => Promise<void>;
  /** Void a recorded supplier payment: reverses the PO balance + stamps the
   *  payment voided. Throws on failure so the caller can surface it. */
  voidSupplierPayment: (input: { paymentId: string; reason: string }) => Promise<void>;
  /** Pay a supplier a single amount, auto-allocated across its outstanding POs
   *  (oldest-first) for the given shop. Throws on failure. */
  paySupplierLumpSum: (input: {
    supplierId: string;
    shopId: string;
    amountMmk: number;
    paymentMethod: SupplierPaymentMethod;
    referenceNo?: string;
    notes?: string;
  }) => Promise<void>;
  /** Internal — called by the outbox drain once a queued receive/payment
   *  actually runs server-side. Not for direct UI use. */
  reconcileReceivePurchaseOrder: (data: unknown, provisional: ProvisionalRef, ackId?: string) => void;
  reconcileRecordSupplierPayment: (data: unknown, provisional: ProvisionalRef) => void;
}

export interface PricingState {
  priceTiers: PriceTier[];
  addPriceTier: (tier: PriceTier) => Promise<void>;
  updatePriceTier: (tier: PriceTier) => Promise<void>;
  deletePriceTier: (tierId: string) => Promise<void>;
  getProductPrice: (productId: string, shopId: string, qty: number) => number;
}

export interface AuditState {
  auditLogs: AuditLog[];
  reprintLogs: { id: string; saleId: string; printedBy: string; printedAt: string }[];
  addAuditLog: (log: AuditLog) => Promise<void>;
  addReprintLog: (input: { saleId: string; actorId: string }) => Promise<void>;
}

// ============================================
// Loading State
// ============================================

export interface LoadingState {
  isLoading: boolean;
  isLoaded: boolean;
  loadError: string | null;
  loadData: (options?: { force?: boolean }) => Promise<void>;
  retryLoadData: () => Promise<void>;
  /** Lightweight incremental refresh for tables with reliable updated_at
   *  tracking (see stores/data/deltaSync.ts) — a cheaper alternative to a
   *  full loadData({force:true}) for routine background refreshes. No-op
   *  before the first full load, or while offline. */
  pullDeltas: () => Promise<void>;
}

// ============================================
// Combined State
// ============================================

export type DataState = ShopState &
  CategoryState &
  BrandState &
  UnitTypeState &
  ProductState &
  PriceLevelState &
  InventoryState &
  ShiftState &
  SaleState &
  TransferState &
  PurchaseState &
  PricingState &
  AuditState &
  LoadingState;
