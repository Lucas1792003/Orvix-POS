// ============================================================
// Row Mappers: DB snake_case → TypeScript camelCase
//
// Shared by loadData() (full snapshot) and deltaSync.ts (incremental
// pull) — kept in one place so the two paths can never map a row
// differently.
// ============================================================
import type {
  AuditLog, Brand, BusinessProfile, Category, Inventory, InventoryMovement, PriceLevel, PriceTier,
  Product, ProductBarcode, ProductUnit, ProductUnitPrice, PurchaseOrder, PurchaseOrderItem,
  Refund, Sale, SaleItem, Shift, Shop, StockTransfer, StockTransferItem,
  Supplier, SupplierPayment, SupplierProduct, UnitType, User,
} from "../../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapShop = (r: any): Shop => ({
  id: r.id, code: r.code, name: r.name, address: r.address,
  phone: r.phone ?? undefined, email: r.email ?? undefined,
  isActive: r.is_active, createdAt: r.created_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapBusinessProfile = (r: any): BusinessProfile => ({
  businessName: r.business_name ?? undefined,
  logoUrl: r.logo_url ?? undefined,
  address: r.address ?? undefined,
  phone: r.phone ?? undefined,
  email: r.email ?? undefined,
  tagline: r.tagline ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapUser = (r: any): User => ({
  id: r.id, name: r.name, email: r.email ?? undefined, role: r.role,
  shopId: r.shop_id ?? undefined, orgId: r.org_id ?? undefined, authId: r.auth_id ?? undefined,
  permissions: r.permissions ?? undefined,
  grantedPermissions: r.granted_permissions ?? undefined,
  revokedPermissions: r.revoked_permissions ?? undefined,
  isActive: r.is_active, createdAt: r.created_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapCategory = (r: any): Category => ({
  id: r.id, name: r.name, color: r.color, iconKey: r.icon_key ?? undefined,
  isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapBrand = (r: any): Brand => ({
  id: r.id,
  categoryId: r.category_id,
  name: r.name,
  color: r.color ?? undefined,
  isActive: r.is_active,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapUnitType = (r: any): UnitType => ({
  id: r.id, name: r.name,
  abbreviation: r.abbreviation ?? undefined,
  description: r.description ?? undefined,
  isActive: r.is_active, sortOrder: r.sort_order,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapProduct = (r: any): Product => ({
  id: r.id, sku: r.sku ?? undefined,
  aliasCode: r.alias_code ?? undefined,
  name: r.name,
  shortName: r.short_name ?? undefined,
  category: r.category,
  brandId: r.brand_id ?? undefined,
  unitType: r.unit_type, priceMmk: r.price_mmk, costMmk: r.cost_mmk ?? undefined,
  packSize: r.pack_size ?? undefined, lowStockThreshold: r.low_stock_threshold,
  maxQty: r.max_qty ?? undefined,
  isOpenPrice: r.is_open_price ?? false,
  isNonStock: r.is_non_stock ?? false,
  purchaseType: r.purchase_type ?? undefined,
  expiryDate: r.expiry_date ?? undefined, imageUrl: r.image_url ?? undefined,
  isActive: r.is_active, createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapBarcode = (r: any): ProductBarcode => ({
  id: r.id, productId: r.product_id, productUnitId: r.product_unit_id ?? undefined,
  value: r.value, type: r.type,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapProductUnit = (r: any): ProductUnit => ({
  id: r.id,
  productId: r.product_id,
  name: r.name,
  baseQuantity: r.base_quantity,
  // `price_mmk` is the legacy column read once after migration 027 ships
  // (kept here only to survive a partial deploy where the column briefly
  // overlaps both names). After the migration runs everywhere, the
  // `price_mmk` branch never matches.
  salePriceMmk: r.sale_price_mmk ?? r.price_mmk,
  purchasePriceMmk: r.purchase_price_mmk ?? undefined,
  isDefault: r.is_default,
  isActive: r.is_active,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapPriceLevel = (r: any): PriceLevel => ({
  id: r.id,
  code: r.code,
  name: r.name,
  isDefault: r.is_default,
  isActive: r.is_active,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapProductUnitPrice = (r: any): ProductUnitPrice => ({
  id: r.id,
  productUnitId: r.product_unit_id,
  priceLevelId: r.price_level_id,
  shopId: r.shop_id ?? undefined,
  priceMmk: r.price_mmk,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapPriceTier = (r: any): PriceTier => ({
  id: r.id, productId: r.product_id, shopId: r.shop_id ?? undefined,
  minQty: r.min_qty, maxQty: r.max_qty ?? undefined, priceMmk: r.price_mmk,
  isActive: r.is_active, createdAt: r.created_at, createdBy: r.created_by,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapInventory = (r: any): Inventory => ({
  shopId: r.shop_id, productId: r.product_id, qtyBaseUnits: r.qty_base_units,
  storageLocation: r.storage_location ?? undefined, lastCountedAt: r.last_counted_at ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapMovement = (r: any): InventoryMovement => ({
  id: r.id, shopId: r.shop_id, productId: r.product_id, type: r.type,
  qtyChange: r.qty_change, qtyBefore: r.qty_before, qtyAfter: r.qty_after,
  reason: r.reason, referenceType: r.reference_type ?? undefined,
  referenceId: r.reference_id ?? undefined, createdBy: r.created_by, createdAt: r.created_at,
  productUnitId: r.product_unit_id ?? undefined,
  unitNameSnapshot: r.unit_name_snapshot ?? undefined,
  unitBaseQuantitySnapshot: r.unit_base_quantity_snapshot ?? undefined,
  selectedUnitQuantity: r.selected_unit_quantity ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapSupplier = (r: any): Supplier => ({
  id: r.id, code: r.code, name: r.name, contactPerson: r.contact_person ?? undefined,
  phone: r.phone ?? undefined, email: r.email ?? undefined, address: r.address ?? undefined,
  notes: r.notes ?? undefined, isActive: r.is_active, createdAt: r.created_at,
  updatedAt: r.updated_at ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapPurchaseOrder = (r: any): PurchaseOrder => ({
  id: r.id, orderNo: r.order_no, shopId: r.shop_id, supplierId: r.supplier_id,
  status: r.status, subtotalMmk: r.subtotal_mmk, taxMmk: r.tax_mmk ?? undefined,
  totalMmk: r.total_mmk, paidMmk: r.paid_mmk ?? undefined,
  paymentStatus: r.payment_status ?? undefined,
  supplierInvoiceNo: r.supplier_invoice_no ?? undefined,
  deliveryNoteNo: r.delivery_note_no ?? undefined,
  notes: r.notes ?? undefined, createdBy: r.created_by,
  createdAt: r.created_at, approvedBy: r.approved_by ?? undefined,
  approvedAt: r.approved_at ?? undefined, receivedBy: r.received_by ?? undefined,
  receivedAt: r.received_at ?? undefined, updatedAt: r.updated_at ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapPurchaseOrderItem = (r: any): PurchaseOrderItem => ({
  id: r.id, purchaseOrderId: r.purchase_order_id, productId: r.product_id,
  orderedQty: r.ordered_qty, receivedQty: r.received_qty ?? undefined,
  unitCostMmk: r.unit_cost_mmk, lineTotalMmk: r.line_total_mmk,
  productUnitId: r.product_unit_id ?? undefined,
  unitNameSnapshot: r.unit_name_snapshot ?? undefined,
  unitBaseQuantitySnapshot: r.unit_base_quantity_snapshot ?? undefined,
  selectedUnitQuantity: r.selected_unit_quantity ?? undefined,
  unitPurchasePriceSnapshot: r.unit_purchase_price_snapshot ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapSupplierPayment = (r: any): SupplierPayment => ({
  id: r.id, supplierId: r.supplier_id, purchaseOrderId: r.purchase_order_id,
  shopId: r.shop_id, amountMmk: r.amount_mmk, paymentMethod: r.payment_method,
  referenceNo: r.reference_no ?? undefined, notes: r.notes ?? undefined,
  paidAt: r.paid_at, createdBy: r.created_by, createdAt: r.created_at,
  voidedAt: r.voided_at ?? undefined, voidedBy: r.voided_by ?? undefined,
  voidReason: r.void_reason ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapSupplierProduct = (r: any): SupplierProduct => ({
  supplierId: r.supplier_id, productId: r.product_id,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapStockTransfer = (r: any): StockTransfer => ({
  id: r.id, transferNo: r.transfer_no, fromShopId: r.from_shop_id, toShopId: r.to_shop_id,
  status: r.status, notes: r.notes ?? undefined, createdBy: r.created_by, createdAt: r.created_at,
  approvedBy: r.approved_by ?? undefined, approvedAt: r.approved_at ?? undefined,
  dispatchedBy: r.dispatched_by ?? undefined, dispatchedAt: r.dispatched_at ?? undefined,
  receivedBy: r.received_by ?? undefined, receivedAt: r.received_at ?? undefined,
  completedAt: r.completed_at ?? undefined, canceledBy: r.canceled_by ?? undefined,
  canceledAt: r.canceled_at ?? undefined, cancelReason: r.cancel_reason ?? undefined,
  updatedAt: r.updated_at ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapStockTransferItem = (r: any): StockTransferItem => ({
  id: r.id, transferId: r.transfer_id, productId: r.product_id,
  requestedQty: r.requested_qty, approvedQty: r.approved_qty ?? undefined,
  transferredQty: r.transferred_qty ?? undefined,
  productUnitId: r.product_unit_id ?? undefined,
  unitNameSnapshot: r.unit_name_snapshot ?? undefined,
  unitBaseQuantitySnapshot: r.unit_base_quantity_snapshot ?? undefined,
  selectedUnitQuantity: r.selected_unit_quantity ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapShift = (r: any): Shift => ({
  id: r.id, shopId: r.shop_id, cashierId: r.cashier_id, startedAt: r.started_at,
  endedAt: r.ended_at ?? undefined, openingCashMmk: r.opening_cash_mmk,
  closingCashMmk: r.closing_cash_mmk ?? undefined, expectedCashMmk: r.expected_cash_mmk ?? undefined,
  varianceMmk: r.variance_mmk ?? undefined, varianceReason: r.variance_reason ?? undefined,
  updatedAt: r.updated_at ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapSale = (r: any): Sale => ({
  id: r.id, shopId: r.shop_id, shiftId: r.shift_id, receiptNo: r.receipt_no,
  cashierId: r.cashier_id, status: r.status, subtotalMmk: r.subtotal_mmk,
  discountMmk: r.discount_mmk, cartDiscountPct: r.cart_discount_pct ?? undefined,
  totalMmk: r.total_mmk, paymentMethod: r.payment_method,
  paidMmk: r.paid_mmk, changeMmk: r.change_mmk, createdAt: r.created_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapSaleItem = (r: any): SaleItem => ({
  id: r.id ?? undefined,
  saleId: r.sale_id, productId: r.product_id, qtyUnits: r.qty_units,
  unitPriceMmk: r.unit_price_mmk, itemDiscountPct: r.item_discount_pct ?? undefined,
  lineTotalMmk: r.line_total_mmk, priceOverriddenBy: r.price_overridden_by ?? undefined,
  unitLabel: r.unit_label ?? undefined, unitsPerItem: r.units_per_item ?? undefined,
  productUnitId: r.product_unit_id ?? undefined,
  unitNameSnapshot: r.unit_name_snapshot ?? undefined,
  unitBaseQuantitySnapshot: r.unit_base_quantity_snapshot ?? undefined,
  unitPriceMmkSnapshot: r.unit_price_mmk_snapshot ?? undefined,
  baseQuantitySold: r.base_quantity_sold ?? undefined,
  unitCostMmkSnapshot: r.unit_cost_mmk_snapshot ?? undefined,
  stockOverrideBy: r.stock_override_by ?? undefined,
  priceLevelId: r.price_level_id ?? undefined,
  priceLevelNameSnapshot: r.price_level_name_snapshot ?? undefined,
  priceSourceSnapshot: r.price_source_snapshot ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapReprintLog = (r: any) => ({
  id: r.id, saleId: r.sale_id, printedBy: r.printed_by, printedAt: r.printed_at,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapRefund = (r: any): Refund => ({
  id: r.id, saleId: r.sale_id, shopId: r.shop_id, type: r.type,
  reason: r.reason, createdBy: r.created_by, createdAt: r.created_at,
  items: r.items ?? undefined, status: r.status ?? undefined,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mapAuditLog = (r: any): AuditLog => ({
  id: r.id, shopId: r.shop_id ?? undefined, actorId: r.actor_id,
  actionType: r.action_type, message: r.message, entityType: r.entity_type,
  entityId: r.entity_id, createdAt: r.created_at,
});
