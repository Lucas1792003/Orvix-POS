import type { StateCreator } from "zustand";
import type { DataState, ProductState } from "../types";
import type { Product, ProductBarcode, ProductUnit } from "../../../types";
import { supabase, dbExec } from "../../../lib/supabase";
import { findProductForScan } from "../../../features/pos/barcodeLookup";
import { mapBarcodeWriteError, normalizeBarcodeValue } from "../../../lib/barcodeValidation";
import { sanitizeProductUnits } from "../../../features/catalog/productUnits";
import type { BarcodeSavePlan } from "../../../features/catalog/productBarcodeForm";
import { newIdempotencyKey, ONLINE_ONLY_RETRIES } from "../idempotentRpc";
import { callOnlineOnly } from "../onlineOnly";

export const createProductSlice: StateCreator<DataState, [], [], ProductState> = (set, get) => ({
  products: [],
  productUnits: [],
  barcodes: [],
  supplierProducts: [],

  addProduct: async (product: Product, barcodes: ProductBarcode[]) => {
    await dbExec(supabase.from("products").insert({
      id: product.id, sku: product.sku,
      alias_code: product.aliasCode ?? null,
      name: product.name,
      short_name: product.shortName ?? null,
      category: product.category,
      brand_id: product.brandId ?? null,
      unit_type: product.unitType, price_mmk: product.priceMmk, cost_mmk: product.costMmk,
      pack_size: product.packSize, low_stock_threshold: product.lowStockThreshold,
      max_qty: product.maxQty ?? null,
      is_open_price: product.isOpenPrice ?? false,
      is_non_stock: product.isNonStock ?? false,
      purchase_type: product.purchaseType ?? null,
      expiry_date: product.expiryDate, image_url: product.imageUrl,
      is_active: product.isActive, created_at: product.createdAt,
    }), "addProduct");
    if (barcodes.length > 0) {
      await dbExec(supabase.from("product_barcodes").insert(
        barcodes.map((b) => ({
          id: b.id,
          product_id: b.productId,
          product_unit_id: b.productUnitId ?? null,
          value: b.value,
          type: b.type,
        }))
      ), "addProduct barcodes");
    }
    set((state) => ({
      products: [...state.products, product],
      barcodes: [...state.barcodes, ...barcodes],
    }));
  },

  updateProduct: async (product: Product, barcodes?: ProductBarcode[]) => {
    await dbExec(supabase.from("products").update({
      sku: product.sku,
      alias_code: product.aliasCode ?? null,
      name: product.name,
      short_name: product.shortName ?? null,
      category: product.category,
      brand_id: product.brandId ?? null,
      unit_type: product.unitType, price_mmk: product.priceMmk, cost_mmk: product.costMmk,
      pack_size: product.packSize, low_stock_threshold: product.lowStockThreshold,
      max_qty: product.maxQty ?? null,
      is_open_price: product.isOpenPrice ?? false,
      is_non_stock: product.isNonStock ?? false,
      purchase_type: product.purchaseType ?? null,
      expiry_date: product.expiryDate, image_url: product.imageUrl, is_active: product.isActive,
    }).eq("id", product.id), "updateProduct");
    // Only a caller that passes the product's full barcode list (CSV import)
    // replaces the barcodes. The product form saves barcodes separately as a
    // diff (applyProductBarcodeChanges); deleting here dropped every barcode
    // the form does not show.
    if (!barcodes) {
      set((state) => ({
        products: state.products.map((item) => (item.id === product.id ? product : item)),
      }));
      return;
    }
    await dbExec(supabase.from("product_barcodes").delete().eq("product_id", product.id), "updateProduct delete barcodes");
    if (barcodes.length > 0) {
      await dbExec(supabase.from("product_barcodes").insert(
        barcodes.map((b) => ({
          id: b.id,
          product_id: b.productId,
          product_unit_id: b.productUnitId ?? null,
          value: b.value,
          type: b.type,
        }))
      ), "updateProduct barcodes");
    }
    set((state) => ({
      products: state.products.map((item) => (item.id === product.id ? product : item)),
      barcodes: state.barcodes.filter((item) => item.productId !== product.id).concat(barcodes),
    }));
  },

  deleteProduct: async (productId: string) => {
    // Direct deletes against `products` and `inventory` are blocked by
    // RLS (no DELETE policy on products; inventory writes revoked from
    // authenticated). The SECURITY DEFINER RPC checks `product:delete`,
    // clears inventory rows, then deletes the product — barcodes and
    // price tiers cascade automatically.
    const { error } = await callOnlineOnly(
      "delete_product",
      { p_product_id: productId, p_idempotency_key: newIdempotencyKey() },
      { retries: ONLINE_ONLY_RETRIES },
    );
    if (error) {
      console.error("[DB] deleteProduct failed:", error);
      throw error;
    }

    set((state) => ({
      products: state.products.filter((p) => p.id !== productId),
      productUnits: state.productUnits.filter((u) => u.productId !== productId),
      barcodes: state.barcodes.filter((b) => b.productId !== productId),
      inventory: state.inventory.filter((i) => i.productId !== productId),
    }));
  },

  applyProductBarcodeChanges: async (productId: string, plan: BarcodeSavePlan) => {
    const inserts = plan.inserts
      .map((b) => ({ ...b, productId, value: normalizeBarcodeValue(b.value) }))
      .filter((b) => b.value.length > 0);
    const deleteIds = [...new Set(plan.deleteIds)];

    // Deletes first so a value moved between units of this product does not
    // collide with product_barcodes_unique_normalized_value. Scoped to the
    // product as well as the ids, so a stale id can never hit another product.
    // Rows not named in the plan are never touched.
    if (deleteIds.length > 0) {
      const { error: delError } = await supabase
        .from("product_barcodes")
        .delete()
        .in("id", deleteIds)
        .eq("product_id", productId);
      if (delError) {
        console.error("[DB] applyProductBarcodeChanges delete failed:", delError);
        throw new Error(mapBarcodeWriteError(delError));
      }
      set((state) => ({
        barcodes: state.barcodes.filter((item) => !(item.productId === productId && deleteIds.includes(item.id))),
      }));
    }

    if (inserts.length > 0) {
      const { error: insError } = await supabase.from("product_barcodes").insert(
        inserts.map((b) => ({
          id: b.id,
          product_id: productId,
          product_unit_id: b.productUnitId ?? null,
          value: b.value,
          type: b.type,
        }))
      );
      if (insError) {
        console.error("[DB] applyProductBarcodeChanges insert failed:", insError);
        throw new Error(mapBarcodeWriteError(insError));
      }
      set((state) => ({ barcodes: state.barcodes.concat(inserts) }));
    }
  },

  replaceProductUnits: async (productId: string, units: ProductUnit[]) => {
    const normalized = sanitizeProductUnits(units, productId);
    const existing = get().productUnits.filter((unit) => unit.productId === productId);
    const normalizedIds = new Set(normalized.map((unit) => unit.id));
    const deactivated = existing
      .filter((unit) => !normalizedIds.has(unit.id) && unit.isActive)
      .map((unit) => ({ ...unit, isActive: false, updatedAt: new Date().toISOString() }));

    const rows = [...normalized, ...deactivated].map((unit) => ({
      id: unit.id,
      product_id: productId,
      name: unit.name,
      base_quantity: unit.baseQuantity,
      sale_price_mmk: unit.salePriceMmk,
      purchase_price_mmk: unit.purchasePriceMmk ?? null,
      is_default: unit.isDefault,
      is_active: unit.isActive,
      sort_order: unit.sortOrder,
      created_at: unit.createdAt,
      updated_at: unit.updatedAt,
    }));

    if (rows.length > 0) {
      const { error } = await supabase.from("product_units").upsert(rows, { onConflict: "id" });
      if (error) {
        console.error("[DB] replaceProductUnits failed:", error);
        throw new Error(error.message);
      }
    }

    set((state) => ({
      productUnits: state.productUnits
        .filter((unit) => unit.productId !== productId)
        .concat(normalized, deactivated),
    }));
  },

  // Reconcile the supplier links for a product. Delete-then-insert mirrors
  // `replaceProductBarcodes`: the join table has no FKs pointing INTO it, so
  // dropped rows are safe to recreate, and this always converges to the
  // chosen set. Throws on DB failure so the product form can surface it.
  replaceProductSuppliers: async (productId: string, supplierIds: string[]) => {
    const uniqueIds = [...new Set(supplierIds.filter(Boolean))];

    const { error: delError } = await supabase
      .from("supplier_products")
      .delete()
      .eq("product_id", productId);
    if (delError) {
      console.error("[DB] replaceProductSuppliers delete failed:", delError);
      throw new Error(delError.message);
    }

    if (uniqueIds.length > 0) {
      const { error: insError } = await supabase.from("supplier_products").insert(
        uniqueIds.map((supplierId) => ({ supplier_id: supplierId, product_id: productId }))
      );
      if (insError) {
        console.error("[DB] replaceProductSuppliers insert failed:", insError);
        throw new Error(insError.message);
      }
    }

    set((state) => ({
      supplierProducts: state.supplierProducts
        .filter((link) => link.productId !== productId)
        .concat(uniqueIds.map((supplierId) => ({ supplierId, productId }))),
    }));
  },

  // Supplier-side link management (the product form uses replaceProductSuppliers
  // instead). Both write the same supplier_products table under the same RLS.
  addSupplierProducts: async (supplierId: string, productIds: string[]) => {
    const existing = new Set(
      get().supplierProducts.filter((l) => l.supplierId === supplierId).map((l) => l.productId)
    );
    const toAdd = [...new Set(productIds.filter(Boolean))].filter((id) => !existing.has(id));
    if (toAdd.length === 0) return;

    const { error } = await supabase.from("supplier_products").insert(
      toAdd.map((productId) => ({ supplier_id: supplierId, product_id: productId }))
    );
    if (error) {
      console.error("[DB] addSupplierProducts failed:", error);
      throw new Error(error.message);
    }

    set((state) => ({
      supplierProducts: [
        ...state.supplierProducts,
        ...toAdd.map((productId) => ({ supplierId, productId })),
      ],
    }));
  },

  removeSupplierProduct: async (supplierId: string, productId: string) => {
    const { error } = await supabase
      .from("supplier_products")
      .delete()
      .eq("supplier_id", supplierId)
      .eq("product_id", productId);
    if (error) {
      console.error("[DB] removeSupplierProduct failed:", error);
      throw new Error(error.message);
    }

    set((state) => ({
      supplierProducts: state.supplierProducts.filter(
        (l) => !(l.supplierId === supplierId && l.productId === productId)
      ),
    }));
  },

  getProductByBarcode: (value: string) => {
    const state = get();
    return findProductForScan(value, state.products, state.productUnits, state.barcodes);
  },
});
