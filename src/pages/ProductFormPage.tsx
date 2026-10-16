import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import type { Brand, ProductUnit } from "../types";
import {
  checkBarcodeAddable,
  findBarcodeOwner,
  normalizeBarcodeValue,
  BARCODE_FORM_MESSAGES,
} from "../lib/barcodeValidation";
import { getErrorMessage } from "../lib/errors";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { ProductImageInput } from "../components/forms/ProductImageInput";
import { MoneyInput } from "../components/forms/MoneyInput";
import { BarcodeScanModal } from "../components/forms/BarcodeScanModal";
import { useToast } from "../components/ui/Toast";
import {
  compareUnitTypes,
  resolveProductUnit,
} from "../features/unitTypes/unitTypeValidation";
import {
  buildProductFromFormValues,
  type ProductFormValues as FormValues,
} from "../features/catalog/productForm";
import {
  makeDefaultProductUnit,
  sanitizeProductUnits,
  validateProductUnits,
} from "../features/catalog/productUnits";
import { getActivePriceLevels } from "../features/pricing/priceLevels";
import {
  loadUnitBarcodes,
  planProductBarcodeSave,
  type LoadedUnitBarcode,
} from "../features/catalog/productBarcodeForm";
import { useTranslation } from "../hooks/useTranslation";
import { newId } from "../lib/id";

const PRODUCTS_ROUTE = "/app/admin/products";

// Collapsible card used for every section on this page. Mirrors the
// sidebar's own collapsible-group pattern (chevron rotates -90deg when
// closed) so the interaction feels consistent app-wide. Defaults open so
// nothing is hidden — and no validation error can go unnoticed — on load;
// collapsing is purely a "I'm done with this" convenience.
const FormSection = ({
  icon,
  title,
  description,
  complete,
  headerExtra,
  children,
}: {
  icon: string;
  title: string;
  description?: React.ReactNode;
  complete?: boolean;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) => {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            <button
              type="button"
              onClick={() => setIsOpen((v) => !v)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-1.5 text-left"
            >
              <span className="material-symbols-rounded text-base text-emerald-600">{icon}</span>
              <span>{title}</span>
              {complete && (
                <span className="material-symbols-rounded text-base text-emerald-500" title="Complete">
                  check_circle
                </span>
              )}
              <span
                className={`material-symbols-rounded ml-auto text-xl text-slate-400 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
              >
                expand_more
              </span>
            </button>
          </h3>
          {description}
        </div>
        {headerExtra}
      </div>
      {isOpen && <div className="mt-4">{children}</div>}
    </div>
  );
};

export const ProductFormPage = () => {
  const navigate = useNavigate();
  const { productId: routeProductId } = useParams<{ productId?: string }>();
  const toast = useToast();
  const { t } = useTranslation();

  // Price-level field label: "<name> Price (Sale 1/2/3)" by well-known code,
  // else a generic "<name> Price". Translated, name kept verbatim.
  const getPriceLevelFormLabel = (code: string, name: string): string => {
    const normalized = code.toLowerCase();
    if (normalized === "retail") return t("productForm", "priceSale1", { name });
    if (normalized === "wholesale") return t("productForm", "priceSale2", { name });
    if (normalized === "special") return t("productForm", "priceSale3", { name });
    return t("productForm", "priceGeneric", { name });
  };
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentShopId = useAppStore((state) => state.currentShopId);

  const products = useDataStore((state) => state.products);
  const productUnits = useDataStore((state) => state.productUnits);
  const barcodes = useDataStore((state) => state.barcodes);
  const categories = useDataStore((state) => state.categories);
  const brands = useDataStore((state) => state.brands);
  const unitTypes = useDataStore((state) => state.unitTypes);
  const purchaseOrders = useDataStore((state) => state.purchaseOrders);
  const purchaseOrderItems = useDataStore((state) => state.purchaseOrderItems);
  const suppliers = useDataStore((state) => state.suppliers);
  const supplierProducts = useDataStore((state) => state.supplierProducts);
  const replaceProductSuppliers = useDataStore((state) => state.replaceProductSuppliers);
  const loadError = useDataStore((state) => state.loadError);
  const addProduct = useDataStore((state) => state.addProduct);
  const updateProduct = useDataStore((state) => state.updateProduct);
  const replaceProductUnits = useDataStore((state) => state.replaceProductUnits);
  const priceLevels = useDataStore((state) => state.priceLevels);
  const productUnitPrices = useDataStore((state) => state.productUnitPrices);
  const replaceProductUnitPrices = useDataStore((state) => state.replaceProductUnitPrices);
  const applyProductBarcodeChanges = useDataStore((state) => state.applyProductBarcodeChanges);
  const addAuditLog = useDataStore((state) => state.addAuditLog);

  const editingProduct = useMemo(
    () => (routeProductId ? products.find((p) => p.id === routeProductId) : undefined),
    [products, routeProductId],
  );
  const isEditing = Boolean(routeProductId);

  const activeCategories = useMemo(() => categories.filter((c) => c.isActive), [categories]);
  const activeUnitTypes = useMemo(
    () => unitTypes.filter((u) => u.isActive).sort(compareUnitTypes),
    [unitTypes],
  );
  const activeBrands = useMemo(
    () => brands.filter((b) => b.isActive).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    ),
    [brands],
  );
  const brandsByCategory = useMemo(() => {
    const map = new Map<string, Brand[]>();
    for (const brand of activeBrands) {
      const list = map.get(brand.categoryId) ?? [];
      list.push(brand);
      map.set(brand.categoryId, list);
    }
    return map;
  }, [activeBrands]);
  const activePriceLevels = useMemo(() => getActivePriceLevels(priceLevels), [priceLevels]);
  const defaultPriceLevel = useMemo(
    () => activePriceLevels.find((level) => level.isDefault) ?? activePriceLevels[0],
    [activePriceLevels],
  );

  // Last supplier for the editing product. Reads the newest non-CANCELED
  // purchase order line that referenced this product and returns the
  // supplier on that PO. Read-only display; never written back.
  const lastSupplierForProduct = useMemo(() => {
    if (!routeProductId) return null;
    // Map productId → most-recent PO datestamp + supplier id. POs sorted
    // newest-first so the first hit per product wins.
    const sortedOrders = [...purchaseOrders]
      .filter((po) => po.status !== "CANCELED")
      .sort((a, b) => {
        const aDate = a.receivedAt ?? a.approvedAt ?? a.createdAt;
        const bDate = b.receivedAt ?? b.approvedAt ?? b.createdAt;
        return bDate.localeCompare(aDate);
      });
    for (const po of sortedOrders) {
      const item = purchaseOrderItems.find(
        (it) => it.purchaseOrderId === po.id && it.productId === routeProductId,
      );
      if (!item) continue;
      const supplier = suppliers.find((s) => s.id === po.supplierId);
      if (!supplier) continue;
      return {
        supplier,
        orderNo: po.orderNo,
        when: po.receivedAt ?? po.approvedAt ?? po.createdAt,
      };
    }
    return null;
  }, [routeProductId, purchaseOrders, purchaseOrderItems, suppliers]);

  // Stable productId for the storage image path. Edit mode reuses the
  // existing id; create mode mints one up-front so the image upload can
  // happen before submit lands the row.
  const [formProductId, setFormProductId] = useState<string>(
    () => routeProductId ?? newId("prod"),
  );

  const previousUnitTypeRef = useRef<string>("");
  const [formUnits, setFormUnits] = useState<ProductUnit[]>([]);
  const [unitBarcodes, setUnitBarcodes] = useState<Record<string, string>>({});
  // Barcode rows the form showed per unit when it was hydrated; the save
  // diffs against this so untouched barcodes are never deleted or rewritten.
  const loadedUnitBarcodesRef = useRef<Record<string, LoadedUnitBarcode>>({});
  const [formUnitLevelPrices, setFormUnitLevelPrices] = useState<Record<string, Record<string, string>>>({});
  const [scanUnitId, setScanUnitId] = useState<string | null>(null);
  const [scanModalOpen, setScanModalOpen] = useState(false);
  // Suppliers this product can be bought from (many-to-many). Seeded on hydrate.
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<string[]>([]);
  const [productSaveError, setProductSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Marker so the URL-driven `routeProductId → formProductId` hydration
  // only runs once per mount. Without this, re-renders of `products` on
  // the same edit page would constantly reset state.
  const hydratedRef = useRef<string | null>(null);

  const schema = useMemo(() => {
    return z.object({
      sku: z.string().min(1, t("productForm", "skuRequired")).max(64, t("productForm", "skuMax")),
      aliasCode: z.string().optional(),
      name: z.string().min(2, t("productForm", "nameMin")).max(200, t("productForm", "nameMax")),
      shortName: z.string().optional(),
      category: z.string().min(1, t("productForm", "categoryRequired")),
      brandId: z.string().optional(),
      unitType: z.string().min(1, t("productForm", "unitTypeRequired")),
      priceMmk: z.number().min(0, t("productForm", "priceMin")),
      costMmk: z.number().optional(),
      lowStockThreshold: z.number().min(0, t("productForm", "thresholdMin")),
      maxQty: z.number().min(0, t("productForm", "maxQtyMin")).optional(),
      isOpenPrice: z.boolean(),
      isNonStock: z.boolean(),
      // Empty string maps to "unspecified" — keeps the <select> controlled.
      purchaseType: z.union([z.literal("COD"), z.literal("CREDIT"), z.literal("")]).optional(),
      expiryDate: z.string().optional(),
      imageUrl: z.string().optional(),
      isActive: z.boolean(),
    });
  }, [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      sku: "",
      aliasCode: "",
      name: "",
      shortName: "",
      category: activeCategories[0]?.name ?? "",
      brandId: undefined,
      unitType: activeUnitTypes[0]?.name ?? "",
      priceMmk: 0,
      costMmk: undefined,
      lowStockThreshold: 10,
      maxQty: undefined,
      isOpenPrice: false,
      isNonStock: false,
      purchaseType: "",
      expiryDate: undefined,
      imageUrl: undefined,
      isActive: true,
    },
  });

  const buildInitialUnit = (
    productId: string,
    unitType: string,
    salePriceMmk: number,
    purchasePriceMmk?: number,
  ) =>
    makeDefaultProductUnit(
      productId,
      unitType || activeUnitTypes[0]?.name || "Piece",
      salePriceMmk,
      purchasePriceMmk,
    );

  // Hydrate form/units from the route on mount. Edit mode waits for the
  // store to have loaded the product; create mode seeds an empty form.
  useEffect(() => {
    const hydrationKey = routeProductId ?? "__new__";
    if (hydratedRef.current === hydrationKey) return;

    if (routeProductId) {
      if (!editingProduct) {
        // Store still loading; skip until the product appears.
        return;
      }
      hydratedRef.current = hydrationKey;
      form.reset({
        id: editingProduct.id,
        sku: editingProduct.sku || "",
        aliasCode: editingProduct.aliasCode ?? "",
        name: editingProduct.name,
        shortName: editingProduct.shortName ?? "",
        category: editingProduct.category,
        brandId: editingProduct.brandId,
        unitType: editingProduct.unitType,
        priceMmk: editingProduct.priceMmk,
        costMmk: editingProduct.costMmk,
        lowStockThreshold: editingProduct.lowStockThreshold,
        maxQty: editingProduct.maxQty,
        isOpenPrice: editingProduct.isOpenPrice ?? false,
        isNonStock: editingProduct.isNonStock ?? false,
        purchaseType: editingProduct.purchaseType ?? "",
        expiryDate: editingProduct.expiryDate,
        imageUrl: editingProduct.imageUrl,
        isActive: editingProduct.isActive,
      });
      setFormProductId(editingProduct.id);
      previousUnitTypeRef.current = editingProduct.unitType;
      const savedUnits = productUnits
        .filter((unit) => unit.productId === editingProduct.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      const units = savedUnits.length > 0
        ? savedUnits
        : [buildInitialUnit(editingProduct.id, editingProduct.unitType, editingProduct.priceMmk, editingProduct.costMmk)];
      setFormUnits(units);
      // A default-unit barcode may be stored with or without the unit id;
      // show both, and remember what was loaded so the save only writes the
      // fields the user changed.
      const loaded = loadUnitBarcodes(editingProduct.id, units, barcodes);
      loadedUnitBarcodesRef.current = loaded;
      setUnitBarcodes(Object.fromEntries(Object.entries(loaded).map(([unitId, row]) => [unitId, row.value])));
      const nextLevelPrices: Record<string, Record<string, string>> = {};
      for (const unit of units) {
        const perLevel: Record<string, string> = {};
        for (const level of priceLevels) {
          const row = productUnitPrices.find(
            (p) =>
              p.productUnitId === unit.id &&
              p.priceLevelId === level.id &&
              p.shopId == null &&
              p.isActive,
          );
          perLevel[level.id] = row ? String(row.priceMmk) : level.isDefault ? String(unit.salePriceMmk || "") : "";
        }
        nextLevelPrices[unit.id] = perLevel;
      }
      setFormUnitLevelPrices(nextLevelPrices);
      setSelectedSupplierIds(
        supplierProducts
          .filter((link) => link.productId === editingProduct.id)
          .map((link) => link.supplierId),
      );
    } else {
      hydratedRef.current = hydrationKey;
      const initialUnitType = activeUnitTypes[0]?.name ?? "Piece";
      const seedProductId = newId("prod");
      form.reset({
        sku: "",
        aliasCode: "",
        name: "",
        shortName: "",
        category: activeCategories[0]?.name ?? "",
        brandId: undefined,
        unitType: initialUnitType,
        priceMmk: 0,
        costMmk: undefined,
        lowStockThreshold: 10,
        maxQty: undefined,
        isOpenPrice: false,
        isNonStock: false,
        purchaseType: "",
        expiryDate: undefined,
        imageUrl: undefined,
        isActive: true,
      });
      setFormProductId(seedProductId);
      previousUnitTypeRef.current = initialUnitType;
      const seedUnit = buildInitialUnit(seedProductId, initialUnitType, 0, undefined);
      setFormUnits([seedUnit]);
      setFormUnitLevelPrices({
        [seedUnit.id]: Object.fromEntries(activePriceLevels.map((level) => [level.id, ""])),
      });
      loadedUnitBarcodesRef.current = {};
      setUnitBarcodes({});
      setSelectedSupplierIds([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeProductId, editingProduct]);

  // Editing a product that doesn't exist in the store → bounce back to the
  // list. Happens if the user lands here via a stale URL or after deletion.
  useEffect(() => {
    if (!routeProductId) return;
    if (editingProduct) return;
    if (loadError) return; // wait for retry; don't bounce on transient error
    // Allow the store one tick to populate before declaring it missing.
    const timeout = window.setTimeout(() => {
      if (!useDataStore.getState().products.find((p) => p.id === routeProductId)) {
        navigate(PRODUCTS_ROUTE, { replace: true });
      }
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [routeProductId, editingProduct, loadError, navigate]);

  // ============================================================
  // Form sub-handlers
  // ============================================================

  const handleScannedBarcode = (value: string): string | null => {
    if (!scanUnitId) return t("productForm", "chooseUnitBeforeScan");
    const normalized = normalizeBarcodeValue(value);
    const currentValues = Object.entries(unitBarcodes)
      .filter(([unitId]) => unitId !== scanUnitId)
      .map(([, barcode]) => barcode)
      .filter(Boolean);
    const error = checkBarcodeAddable(normalized, currentValues, barcodes, routeProductId ?? null);
    if (error) return error;
    setUnitBarcodes((list) => ({ ...list, [scanUnitId]: normalized }));
    toast({ title: t("productForm", "barcodeAdded"), description: normalized, variant: "success" });
    return null;
  };

  const handleRemoveBarcode = (unitId: string) => {
    setUnitBarcodes((list) => ({ ...list, [unitId]: "" }));
  };

  const updateFormUnit = (unitId: string, patch: Partial<ProductUnit>) => {
    setFormUnits((units) =>
      units.map((unit) => (unit.id === unitId ? { ...unit, ...patch } : unit))
    );
  };

  const updateUnitLevelPrice = (unitId: string, priceLevelId: string, rawValue: string) => {
    const next = rawValue.replace(/[^\d]/g, "");
    const isDefaultLevel = defaultPriceLevel?.id === priceLevelId;
    const unit = formUnits.find((row) => row.id === unitId);

    setFormUnitLevelPrices((prev) => ({
      ...prev,
      [unitId]: { ...(prev[unitId] ?? {}), [priceLevelId]: next },
    }));

    if (!isDefaultLevel) return;

    const parsed = Number(next || 0);
    const salePriceMmk = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    updateFormUnit(unitId, { salePriceMmk });
    if (unit?.isDefault) {
      form.setValue("priceMmk", salePriceMmk, { shouldValidate: true });
    }
  };

  const updateUnitPurchaseCost = (unitId: string, value: number | undefined) => {
    const unit = formUnits.find((row) => row.id === unitId);
    const purchasePriceMmk =
      value === undefined || value === null || !Number.isFinite(value)
        ? undefined
        : Math.max(0, Math.trunc(value));
    updateFormUnit(unitId, { purchasePriceMmk });
    if (unit?.isDefault) {
      form.setValue("costMmk", purchasePriceMmk, { shouldValidate: true });
    }
  };

  const addSellableUnit = () => {
    const id = newId("unit");
    const now = new Date().toISOString();
    setFormUnits((units) => [
      ...units,
      {
        id,
        productId: formProductId,
        name: "",
        baseQuantity: 1,
        salePriceMmk: 0,
        purchasePriceMmk: undefined,
        isDefault: false,
        isActive: true,
        sortOrder: units.length,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    setFormUnitLevelPrices((prev) => ({
      ...prev,
      [id]: Object.fromEntries(activePriceLevels.map((level) => [level.id, ""])),
    }));
  };

  const deactivateSellableUnit = (unitId: string) => {
    setFormUnits((units) => {
      const next = units.map((unit) => (unit.id === unitId ? { ...unit, isActive: false, isDefault: false } : unit));
      if (!next.some((unit) => unit.isActive && unit.isDefault)) {
        const firstActive = next.find((unit) => unit.isActive);
        return firstActive
          ? next.map((unit) => ({ ...unit, isDefault: unit.id === firstActive.id }))
          : next;
      }
      return next;
    });
  };

  const setDefaultSellableUnit = (unitId: string) => {
    setFormUnits((units) =>
      units.map((unit) => ({
        ...unit,
        isDefault: unit.id === unitId,
        isActive: unit.id === unitId ? true : unit.isActive,
        baseQuantity: unit.id === unitId ? 1 : unit.baseQuantity,
      }))
    );
    const nextDefault = formUnits.find((unit) => unit.id === unitId);
    if (nextDefault) {
      form.setValue("priceMmk", nextDefault.salePriceMmk, { shouldValidate: true });
      form.setValue("costMmk", nextDefault.purchasePriceMmk, { shouldValidate: true });
    }
  };

  const openUnitScanModal = (unitId: string) => {
    setScanUnitId(unitId);
    setScanModalOpen(true);
  };

  const generateSku = (categoryName?: string) => {
    const cat = categoryName ?? form.getValues("category");
    if (!cat) return;
    const prefix = cat.substring(0, 3).toUpperCase();
    const existing = products
      .map((p) => p.sku ?? "")
      .filter((s) => s.startsWith(prefix + "-"))
      .map((s) => parseInt(s.slice(prefix.length + 1), 10))
      .filter((n) => !isNaN(n));
    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
    form.setValue("sku", `${prefix}-${String(next).padStart(3, "0")}`);
  };

  const watchedCategory = form.watch("category");
  const watchedUnitType = form.watch("unitType");
  const watchedBrandId = form.watch("brandId");
  const watchedName = form.watch("name");
  const identityComplete = watchedName.trim().length >= 2;

  useEffect(() => {
    if (isEditing) return;
    if (watchedCategory) generateSku(watchedCategory);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedCategory, isEditing]);

  useEffect(() => {
    if (!watchedBrandId) return;
    const cat = activeCategories.find((c) => c.name === watchedCategory);
    if (!cat) return;
    const allowed = brandsByCategory.get(cat.id) ?? [];
    if (!allowed.some((b) => b.id === watchedBrandId)) {
      form.setValue("brandId", undefined);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedCategory, watchedBrandId]);

  const brandsForFormCategory = useMemo(() => {
    const cat = activeCategories.find((c) => c.name === watchedCategory);
    if (!cat) return [] as Brand[];
    return brandsByCategory.get(cat.id) ?? [];
  }, [activeCategories, brandsByCategory, watchedCategory]);
  const classificationComplete = Boolean(
    watchedCategory && (brandsForFormCategory.length === 0 || watchedBrandId),
  );

  // Active suppliers, plus any already-linked inactive ones (so an existing
  // link stays visible/removable on edit). Sorted by name.
  const selectableSuppliers = useMemo(() => {
    const selected = new Set(selectedSupplierIds);
    return suppliers
      .filter((supplier) => supplier.isActive || selected.has(supplier.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [suppliers, selectedSupplierIds]);

  const toggleSupplier = (supplierId: string) => {
    setSelectedSupplierIds((prev) =>
      prev.includes(supplierId)
        ? prev.filter((id) => id !== supplierId)
        : [...prev, supplierId],
    );
  };

  useEffect(() => {
    const nextUnitType = watchedUnitType || "";
    const previousUnitType = previousUnitTypeRef.current;
    previousUnitTypeRef.current = nextUnitType || previousUnitType;
    if (!nextUnitType) return;

    setFormUnits((units) =>
      units.map((unit, index) => {
        if (!unit.isDefault) return unit;
        const nameWasUntouched =
          !unit.name ||
          unit.name === previousUnitType ||
          (!previousUnitType && index === 0);
        if (!nameWasUntouched) return unit;
        return { ...unit, name: nextUnitType, baseQuantity: 1 };
      })
    );
  }, [watchedUnitType]);

  // ============================================================
  // Submit
  // ============================================================

  const handleSubmit = form.handleSubmit(async (values) => {
    const editingId = routeProductId ?? null;
    const existingSku = products.find((p) => p.sku === values.sku && p.id !== editingId);
    if (existingSku) {
      form.setError("sku", { message: t("productForm", "skuExists") });
      return;
    }

    // Alias code is optional but must be unique across products when set.
    // Case + whitespace insensitive — matches the DB lookup index.
    const aliasTrimmed = values.aliasCode?.trim() ?? "";
    if (aliasTrimmed) {
      const aliasClash = products.find(
        (p) =>
          p.id !== editingId &&
          (p.aliasCode ?? "").trim().toLowerCase() === aliasTrimmed.toLowerCase(),
      );
      if (aliasClash) {
        form.setError("aliasCode", { message: t("productForm", "aliasUsed") });
        return;
      }
    }

    // Sanity check on the reorder ceiling. The DB allows max < threshold
    // (legitimate when admins are mid-change), but warn at submit so the
    // typical mistake (swapped values) gets caught.
    if (
      typeof values.maxQty === "number" &&
      Number.isFinite(values.maxQty) &&
      values.maxQty < values.lowStockThreshold
    ) {
      form.setError("maxQty", {
        message: t("productForm", "maxQtyGteThreshold", { threshold: values.lowStockThreshold }),
      });
      return;
    }

    const categoryRow = activeCategories.find((c) => c.name === values.category);
    const brandsForCategory = categoryRow ? brandsByCategory.get(categoryRow.id) ?? [] : [];
    if (!editingId && brandsForCategory.length > 0 && !values.brandId) {
      form.setError("brandId", { message: t("productForm", "brandRequiredForCategory") });
      return;
    }
    if (values.brandId && !brandsForCategory.some((b) => b.id === values.brandId)) {
      form.setError("brandId", { message: t("productForm", "brandNotInCategory") });
      return;
    }

    const productId = editingId || formProductId || newId("prod");
    const existingProduct = editingId ? products.find((p) => p.id === editingId) : null;
    const rawUnits = sanitizeProductUnits(formUnits.length > 0
      ? formUnits
      : [buildInitialUnit(productId, values.unitType, values.priceMmk, values.costMmk)], productId);
    const nextUnits = defaultPriceLevel
      ? rawUnits.map((unit) => {
          const raw = formUnitLevelPrices[unit.id]?.[defaultPriceLevel.id];
          if (raw === undefined || raw === "") return unit;
          const retailPrice = Number(raw);
          return Number.isFinite(retailPrice)
            ? { ...unit, salePriceMmk: Math.max(0, Math.trunc(retailPrice)) }
            : unit;
        })
      : rawUnits;
    const unitValidation = validateProductUnits(nextUnits);
    if (!unitValidation.valid) {
      setProductSaveError(unitValidation.error ?? t("productForm", "unitsInvalid"));
      return;
    }
    const defaultUnit = nextUnits.find((unit) => unit.isActive && unit.isDefault) ?? nextUnits[0];

    if (defaultPriceLevel) {
      for (const unit of nextUnits.filter((row) => row.isActive)) {
        const raw = formUnitLevelPrices[unit.id]?.[defaultPriceLevel.id];
        const retailPrice = raw === undefined || raw === "" ? unit.salePriceMmk : Number(raw);
        if (!Number.isFinite(retailPrice) || retailPrice <= 0) {
          setProductSaveError(t("productForm", "levelRequiredForUnit", {
            label: getPriceLevelFormLabel(defaultPriceLevel.code, defaultPriceLevel.name),
            unit: unit.name || t("productForm", "eachActiveUnit"),
          }));
          return;
        }
      }
    }

    const product = buildProductFromFormValues(
      {
        ...values,
        priceMmk: defaultUnit?.salePriceMmk ?? values.priceMmk,
        costMmk: defaultUnit?.purchasePriceMmk,
      },
      productId,
      existingProduct,
    );

    const barcodeValues = nextUnits
      .map((unit) => normalizeBarcodeValue(unitBarcodes[unit.id] ?? ""))
      .filter(Boolean);
    if (new Set(barcodeValues.map((value) => value.toLowerCase())).size !== barcodeValues.length) {
      setProductSaveError(BARCODE_FORM_MESSAGES.duplicateInForm);
      return;
    }
    for (const value of barcodeValues) {
      const owner = findBarcodeOwner(value, barcodes, editingId);
      if (owner) {
        setProductSaveError(
          `${BARCODE_FORM_MESSAGES.duplicateOtherProduct} (${value})`
        );
        return;
      }
    }

    setIsSaving(true);
    setProductSaveError(null);
    try {
      // No barcode list: updateProduct must not touch product_barcodes —
      // the barcode diff below is the only barcode write of this save.
      if (editingId) await updateProduct(product);
      else await addProduct(product, []);

      await replaceProductUnits(productId, nextUnits);

      const defaultLevel = activePriceLevels.find((pl) => pl.isDefault) ?? activePriceLevels[0];
      for (const unit of nextUnits) {
        const perLevel = formUnitLevelPrices[unit.id] ?? {};
        const rows: { priceLevelId: string; shopId?: string; priceMmk: number }[] = [];
        for (const level of activePriceLevels) {
          const raw = perLevel[level.id];
          const isDefault = defaultLevel && level.id === defaultLevel.id;
          if (raw === undefined || raw === "") {
            if (isDefault) rows.push({ priceLevelId: level.id, priceMmk: unit.salePriceMmk });
            continue;
          }
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            setProductSaveError(t("productForm", "invalidLevelPrice", { level: level.name, unit: unit.name }));
            throw new Error("invalid price-level input");
          }
          rows.push({ priceLevelId: level.id, priceMmk: Math.trunc(n) });
        }
        await replaceProductUnitPrices(unit.id, rows);
      }

      await applyProductBarcodeChanges(productId, planProductBarcodeSave({
        productId,
        units: nextUnits,
        existing: useDataStore.getState().barcodes,
        loaded: editingId ? loadedUnitBarcodesRef.current : {},
        formValues: unitBarcodes,
        newId: () => newId("bc"),
      }));

      await replaceProductSuppliers(productId, selectedSupplierIds);

      void addAuditLog({
        id: newId("audit"),
        actorId: currentUserId ?? "system",
        actionType: editingId ? "PRODUCT_EDIT" : "PRODUCT_CREATE",
        message: `${editingId ? "Updated" : "Created"} product ${values.name}.`,
        entityType: "Product",
        entityId: productId,
        createdAt: new Date().toISOString(),
      });

      navigate(PRODUCTS_ROUTE);
    } catch (error) {
      setProductSaveError(getErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  });

  const handleCancel = () => navigate(PRODUCTS_ROUTE);

  // Enter should advance to the next field, not submit the whole form — a
  // long unit/pricing form is easy to submit by accident otherwise. Only the
  // Save button (type="submit") creates the product. Textareas keep newline
  // behaviour; buttons keep their click. The next focusable control is found
  // in DOM order, skipping disabled / read-only / hidden ones.
  const handleFormKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter") return;
    const target = event.target as HTMLElement;
    if (target.tagName !== "INPUT" || (target as HTMLInputElement).type === "submit") return;
    event.preventDefault();
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLInputElement>("input, select, textarea"),
    ).filter(
      (el) => !el.disabled && !el.readOnly && el.tabIndex !== -1 && el.offsetParent !== null,
    );
    const index = controls.indexOf(target as HTMLInputElement);
    const next = index > -1 ? controls[index + 1] : undefined;
    if (next) {
      next.focus();
      if (typeof next.select === "function") next.select();
    }
  };

  // ============================================================
  // Render
  // ============================================================

  return (
    <Card>
      <PageHeader
        title={isEditing ? t("productForm", "editTitle") : t("productForm", "addTitle")}
        subtitle={
          isEditing
            ? t("productForm", "editSubtitle")
            : t("productForm", "addSubtitle")
        }
        actions={
          <Button type="button" variant="secondary" onClick={handleCancel}>
            <span className="material-symbols-rounded mr-1 text-sm">arrow_back</span>
            {t("productForm", "backToProducts")}
          </Button>
        }
      />

      <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Left column — Identity & stock */}
        <div className="space-y-5">
          <FormSection icon="badge" title={t("productForm", "identity")} complete={identityComplete}>
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "sku")}</label>
                  <Input
                    placeholder={t("productForm", "skuPlaceholder")}
                    {...form.register("sku")}
                    readOnly
                    className="bg-slate-50 text-slate-500 cursor-not-allowed"
                  />
                  {form.formState.errors.sku && (
                    <p className="mt-1 text-xs text-red-500">
                      {form.formState.errors.sku.message}
                    </p>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "aliasCode")}</label>
                  <Input
                    placeholder={t("productForm", "aliasPlaceholder")}
                    {...form.register("aliasCode")}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "nameLabel")}</label>
                  <Input
                    placeholder={t("productForm", "namePlaceholder")}
                    maxLength={200}
                    {...form.register("name")}
                  />
                  {form.formState.errors.name && (
                    <p className="mt-1 text-xs text-red-500">{form.formState.errors.name.message}</p>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "shortName")}</label>
                  <Input
                    placeholder={t("productForm", "shortNamePlaceholder")}
                    {...form.register("shortName")}
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    {t("productForm", "shortNameHint")}
                  </p>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "productImage")}</label>
                <ProductImageInput
                  productId={formProductId}
                  shopId={currentShopId}
                  value={form.watch("imageUrl")}
                  onChange={(value) => form.setValue("imageUrl", value)}
                />
              </div>
            </div>
          </FormSection>

          <FormSection icon="category" title={t("productForm", "classification")} complete={classificationComplete}>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "categoryLabel")}</label>
                <Select {...form.register("category")}>
                  {activeCategories.map((cat) => (
                    <option key={cat.id} value={cat.name}>
                      {cat.name.charAt(0).toUpperCase() + cat.name.slice(1)}
                    </option>
                  ))}
                </Select>
              </div>

              {brandsForFormCategory.length > 0 && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">
                    {t("productForm", "brand")} {isEditing ? "" : "*"}
                  </label>
                  <Select
                    value={form.watch("brandId") ?? ""}
                    onChange={(event) =>
                      form.setValue(
                        "brandId",
                        event.target.value || undefined,
                        { shouldValidate: true },
                      )
                    }
                  >
                    <option value="">{t("productForm", "selectBrand")}</option>
                    {brandsForFormCategory.map((brand) => (
                      <option key={brand.id} value={brand.id}>
                        {brand.name}
                      </option>
                    ))}
                  </Select>
                  {form.formState.errors.brandId && (
                    <p className="mt-1 text-xs text-red-500">
                      {form.formState.errors.brandId.message}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "baseStockUnit")}</label>
                {(() => {
                  const currentValue = form.watch("unitType");
                  const resolved = resolveProductUnit(currentValue, unitTypes);

                  if (activeUnitTypes.length === 0 && resolved.kind !== "inactive" && resolved.kind !== "legacy") {
                    return (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {loadError ? (
                          <>{t("productForm", "unitTypesLoadError", { error: loadError })}</>
                        ) : (
                          <>
                            {t("productForm", "noUnitTypesPrefix")}
                            <a className="font-medium underline" href="/app/admin/unit-types">
                              {t("productForm", "addUnitTypesLink")}
                            </a>
                            {t("productForm", "noUnitTypesSuffix")}
                          </>
                        )}
                      </div>
                    );
                  }

                  return (
                    <>
                      <Select {...form.register("unitType")}>
                        {resolved.kind === "legacy" && resolved.value.length > 0 && (
                          <option value={resolved.value}>
                            {t("productForm", "currentLegacy", { value: resolved.value })}
                          </option>
                        )}
                        {resolved.kind === "inactive" && (
                          <option value={resolved.unitType.name}>
                            {t("productForm", "currentInactive", { value: resolved.unitType.name })}
                          </option>
                        )}
                        {activeUnitTypes.map((unit) => (
                          <option key={unit.id} value={unit.name}>
                            {unit.name}
                            {unit.abbreviation ? ` (${unit.abbreviation})` : ""}
                          </option>
                        ))}
                      </Select>
                      {form.formState.errors.unitType && (
                        <p className="mt-1 text-xs text-red-500">
                          {form.formState.errors.unitType.message}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-slate-500">
                        {t("productForm", "baseUnitHint")}
                      </p>
                    </>
                  );
                })()}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "defaultPurchaseTerms")}</label>
                <Select {...form.register("purchaseType")}>
                  <option value="">{t("productForm", "askEachTime")}</option>
                  <option value="COD">{t("productForm", "cod")}</option>
                  <option value="CREDIT">{t("productForm", "credit")}</option>
                </Select>
                <p className="mt-1 text-xs text-slate-500">
                  {t("productForm", "purchaseTermsHint")}
                </p>
              </div>
            </div>
          </FormSection>

          <FormSection icon="inventory_2" title={t("productForm", "stockStatus")}>
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "lowStockThreshold")}</label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    placeholder="10"
                    {...form.register("lowStockThreshold", { valueAsNumber: true })}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "maxQty")}</label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    placeholder={t("productForm", "optional")}
                    {...form.register("maxQty", {
                      setValueAs: (v) => {
                        if (v === "" || v === null || v === undefined) return undefined;
                        const n = Number(v);
                        return Number.isFinite(n) ? n : undefined;
                      },
                    })}
                  />
                  {form.formState.errors.maxQty && (
                    <p className="mt-1 text-xs text-red-500">
                      {form.formState.errors.maxQty.message}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">{t("productForm", "expiryDate")}</label>
                <Input type="date" {...form.register("expiryDate")} />
              </div>

              {/* Behaviour flags. "Open Price" was removed from this
                  form because the POS "Adjust price" modal already lets
                  the cashier set a custom price per line. The
                  `is_open_price` column + RPC handling remain in place
                  so a future re-introduction is a single checkbox add. */}
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {t("productForm", "behaviourFlags")}
                </span>
                <div className="mt-2 space-y-2">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      {...form.register("isNonStock")}
                    />
                    <span className="text-sm text-slate-700">
                      <span className="font-medium">{t("productForm", "nonStockItem")}</span>
                      <span className="block text-xs text-slate-500">
                        {t("productForm", "nonStockDesc")}
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <label className="relative inline-flex cursor-pointer items-center">
                  <input type="checkbox" className="peer sr-only" {...form.register("isActive")} />
                  <div className="peer h-6 w-11 rounded-full bg-slate-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-slate-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-500 peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:ring-2 peer-focus:ring-emerald-300"></div>
                </label>
                <span className="text-sm font-medium text-slate-700">
                  {form.watch("isActive") ? t("common", "active") : t("common", "inactive")}
                </span>
              </div>

              {isEditing && (
                <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
                  <div className="font-semibold uppercase tracking-wide text-slate-500">
                    {t("productForm", "lastSupplier")}
                  </div>
                  {lastSupplierForProduct ? (
                    <>
                      <div className="mt-1 text-sm font-medium text-slate-800">
                        {lastSupplierForProduct.supplier.name}
                      </div>
                      <div className="text-xs text-slate-500">
                        {t("productForm", "lastSupplierPo", {
                          orderNo: lastSupplierForProduct.orderNo,
                          date: new Date(lastSupplierForProduct.when).toLocaleDateString(),
                        })}
                      </div>
                    </>
                  ) : (
                    <p className="mt-1 italic text-slate-400">
                      {t("productForm", "noPoYet")}
                    </p>
                  )}
                </div>
              )}
            </div>
          </FormSection>

          <FormSection
            icon="local_shipping"
            title={t("productForm", "suppliers")}
            description={
              <p className="mt-2 text-xs text-slate-500">
                {t("productForm", "suppliersHint")}
              </p>
            }
          >
            {selectableSuppliers.length === 0 ? (
              <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-3 py-3 text-xs text-slate-500">
                {t("productForm", "noSuppliersPrefix")}
                <a className="font-medium underline" href="/app/suppliers">
                  {t("productForm", "addSupplierLink")}
                </a>
                {t("productForm", "noSuppliersSuffix")}
              </div>
            ) : (
              <div className="mt-4 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {selectableSuppliers.map((supplier) => (
                  <label
                    key={supplier.id}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      checked={selectedSupplierIds.includes(supplier.id)}
                      onChange={() => toggleSupplier(supplier.id)}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                      {supplier.name}
                      <span className="ml-1 font-mono text-xs text-slate-400">{supplier.code}</span>
                      {!supplier.isActive && (
                        <span className="ml-1 text-xs text-slate-400">{t("productForm", "inactiveTag")}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {selectedSupplierIds.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">
                {t("productForm", "suppliersSelected", { n: selectedSupplierIds.length })}
              </p>
            )}
          </FormSection>
        </div>

        {/* Right column — Units & Prices */}
        <div className="space-y-5">
          <FormSection
            icon="sell"
            title={t("productForm", "unitsPrices")}
            description={
              <>
                <p className="mt-2 text-xs text-slate-500">
                  {t("productForm", "unitsHint")}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {t("productForm", "baseUnitLine", {
                    base: form.watch("unitType") || t("productForm", "baseUnitFallback"),
                    base2: form.watch("unitType") || t("productForm", "baseUnitFallback"),
                  })}
                </p>
              </>
            }
            headerExtra={
              <Button type="button" onClick={addSellableUnit} className="min-h-10">
                <span className="material-symbols-rounded mr-1 text-sm">add</span>
                {t("productForm", "addUnit")}
              </Button>
            }
          >
            <div className="space-y-3">
              {formUnits.map((unit, index) => {
                const baseUnitName = form.watch("unitType") || t("productForm", "baseUnitFallback");
                const unitName = unit.name.trim() || t("productForm", "newUnit");
                const isBaseUnit = unit.isDefault;
                const activeUnitCount = formUnits.filter((row) => row.isActive).length;
                const canDeactivate = !unit.isDefault && (!unit.isActive || activeUnitCount > 1);
                const duplicateBaseName =
                  !unit.isDefault &&
                  unit.name.trim().toLowerCase() === baseUnitName.trim().toLowerCase() &&
                  unit.baseQuantity !== 1;

                return (
                  <div
                    key={unit.id}
                    className={`rounded-xl border bg-white p-4 shadow-sm ${
                      unit.isActive ? "border-slate-200" : "border-slate-200 opacity-75"
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-semibold text-slate-800">{unitName}</h4>
                          {unit.isDefault && <Badge tone="green">{t("productForm", "defaultPosUnit")}</Badge>}
                          {unit.isActive ? <Badge tone="blue">{t("common", "active")}</Badge> : <Badge tone="slate">{t("common", "inactive")}</Badge>}
                          {isBaseUnit && <Badge tone="slate">{t("productForm", "baseUnitBadge")}</Badge>}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {t("productForm", "unitEquals", { unit: unitName, n: isBaseUnit ? 1 : unit.baseQuantity || 1, base: baseUnitName })}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={!unit.isActive || unit.isDefault}
                          onClick={() => setDefaultSellableUnit(unit.id)}
                        >
                          {t("productForm", "setDefault")}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={!canDeactivate}
                          onClick={() => {
                            if (unit.isActive) deactivateSellableUnit(unit.id);
                            else updateFormUnit(unit.id, { isActive: true });
                          }}
                        >
                          {unit.isActive ? t("productForm", "deactivate") : t("productForm", "reactivate")}
                        </Button>
                      </div>
                    </div>

                    <div className="mt-4 space-y-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-slate-500">{t("productForm", "unitName")}</span>
                          <Input
                            value={unit.name}
                            onChange={(event) => updateFormUnit(unit.id, { name: event.target.value })}
                            placeholder={index === 0 ? baseUnitName : t("productForm", "unitNamePlaceholder")}
                          />
                        </label>

                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-slate-500">{t("productForm", "baseQuantity")}</span>
                          <Input
                            type="text"
                            inputMode="numeric"
                            value={isBaseUnit ? 1 : unit.baseQuantity}
                            readOnly={isBaseUnit}
                            className={isBaseUnit ? "bg-slate-50 text-slate-500 cursor-not-allowed" : undefined}
                            onChange={(event) => {
                              if (isBaseUnit) return;
                              updateFormUnit(unit.id, {
                                baseQuantity: Math.max(1, Number(event.target.value.replace(/\D/g, "") || 1)),
                              });
                            }}
                            placeholder="1"
                          />
                          <p className="mt-1 text-xs text-slate-500">
                            {isBaseUnit
                              ? t("productForm", "baseUnitEquals1", { base: baseUnitName })
                              : t("productForm", "posDeducts", { n: unit.baseQuantity || 1, base: baseUnitName, unit: unitName })}
                          </p>
                        </label>
                      </div>

                      {duplicateBaseName && (
                        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          {t("productForm", "duplicateBaseName", { base: baseUnitName })}
                        </p>
                      )}

                      <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            {t("productForm", "pricing")}
                          </span>
                          <span className="text-xs text-slate-500">
                            {t("productForm", "blankUsesDefault", { name: defaultPriceLevel?.name ?? "Retail" })}
                          </span>
                        </div>
                        {/* `items-end` aligns inputs to the bottom of
                            each row so a wrapping label (e.g. "Wholesale
                            Price (Sale 2)") doesn't drop its input
                            below the rest. `leading-tight` keeps the
                            two-line label compact enough that the row
                            doesn't grow taller than needed. */}
                        <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
                          <label className="block">
                            <span className="mb-1 block text-xs font-medium leading-tight text-slate-500">{t("productForm", "purchaseCost")}</span>
                            <MoneyInput
                              value={unit.purchasePriceMmk}
                              onChange={(next) => updateUnitPurchaseCost(unit.id, next ?? undefined)}
                              allowEmpty
                              placeholder={t("productForm", "optional")}
                            />
                          </label>

                          {activePriceLevels.length > 0 ? (
                            activePriceLevels.map((level) => {
                              const raw = formUnitLevelPrices[unit.id]?.[level.id] ?? "";
                              const isDefaultLevel = defaultPriceLevel?.id === level.id;
                              return (
                                <label key={level.id} className="block">
                                  <span className="mb-1 block text-xs font-medium leading-tight text-slate-500">
                                    {getPriceLevelFormLabel(level.code, level.name)}
                                  </span>
                                  <Input
                                    type="text"
                                    inputMode="numeric"
                                    placeholder={isDefaultLevel ? t("productForm", "required") : t("productForm", "useRetail")}
                                    value={raw}
                                    onChange={(event) => updateUnitLevelPrice(unit.id, level.id, event.target.value)}
                                  />
                                </label>
                              );
                            })
                          ) : (
                            <label className="block">
                              <span className="mb-1 block text-xs font-medium leading-tight text-slate-500">{t("productForm", "retailPriceSale1")}</span>
                              <MoneyInput
                                value={unit.salePriceMmk}
                                onChange={(next) => {
                                  const salePriceMmk = next ?? 0;
                                  updateFormUnit(unit.id, { salePriceMmk });
                                  if (unit.isDefault) form.setValue("priceMmk", salePriceMmk, { shouldValidate: true });
                                }}
                                placeholder={t("productForm", "required")}
                              />
                            </label>
                          )}
                        </div>
                      </div>

                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-500">{t("productForm", "barcodeForUnit")}</span>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            className="min-w-0 flex-1"
                            value={unitBarcodes[unit.id] ?? ""}
                            onChange={(event) => setUnitBarcodes((rows) => ({
                              ...rows,
                              [unit.id]: normalizeBarcodeValue(event.target.value),
                            }))}
                            placeholder={unit.isDefault ? t("productForm", "barcodeDefaultPlaceholder") : t("productForm", "barcodeUnitPlaceholder")}
                          />
                          <Button type="button" variant="secondary" onClick={() => openUnitScanModal(unit.id)} className="min-h-10">
                            <span className="material-symbols-rounded mr-1 text-sm">qr_code_scanner</span>
                            {t("productForm", "scan")}
                          </Button>
                          {unitBarcodes[unit.id] && (
                            <Button type="button" variant="secondary" onClick={() => handleRemoveBarcode(unit.id)} className="min-h-10">
                              {t("productForm", "clear")}
                            </Button>
                          )}
                        </div>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </FormSection>
        </div>

        {/* Footer spans both columns */}
        <div className="lg:col-span-2">
          {productSaveError && (
            <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {productSaveError}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={handleCancel} disabled={isSaving}>
              {t("common", "cancel")}
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving
                ? t("productForm", "saving")
                : isEditing
                  ? t("productForm", "updateProduct")
                  : t("productForm", "createProduct")}
            </Button>
          </div>
        </div>
      </form>

      <BarcodeScanModal
        open={scanModalOpen}
        onClose={() => {
          setScanModalOpen(false);
          setScanUnitId(null);
        }}
        onScan={handleScannedBarcode}
      />
    </Card>
  );
};
