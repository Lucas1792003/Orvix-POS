import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CartItem, Product, ProductUnit } from "../types";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { useToast } from "../components/ui/Toast";
import { ProductFinder } from "../components/pos/ProductFinder";
import { CartPanel } from "../components/pos/CartPanel";
import { PaymentModal } from "../components/pos/PaymentModal";
import { ReceiptPreview } from "../components/pos/ReceiptPreview";
import { calculateCartTotals } from "../features/pos/service";
import {
  getActivePriceLevels,
  getDefaultPriceLevel,
  resolveProductUnitPrice,
} from "../features/pricing/priceLevels";
import {
  STOCK_OVERRIDE_REQUIRED_MESSAGE,
  STOCK_OVERRIDE_UI_REQUIRED_MESSAGE,
  clampCartItemQuantity,
  getCartAddStockStatus,
  getOnlyInStockMessage,
  getRequestedUnitsByProduct,
  validatePosCart,
} from "../features/pos/cartStock";
import { hasShopPermission } from "../lib/permissions";
import { reportError } from "../lib/errors";
import { printReceipt as triggerPrint } from "../lib/print";
import { getEffectiveShopId } from "../lib/utils";
import { useTranslation } from "../hooks/useTranslation";
import { useSaleActivityStore } from "../stores/saleActivityStore";

export const PosPage = () => {
  const toast = useToast();
  const { t } = useTranslation();
  const [barcodeInput, setBarcodeInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  // Brand sub-filter, scoped to whichever category is currently selected.
  // Reset to empty whenever the category changes — see the effect below.
  const [brandId, setBrandId] = useState<string>("");
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [cartDiscountPct, setCartDiscountPct] = useState(0);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [overrideItem, setOverrideItem] = useState<CartItem | null>(null);
  const [overridePriceLevelId, setOverridePriceLevelId] = useState("");
  // Manual price input on the "Adjust price" modal. Seeded from the
  // resolved price each time the cashier picks a price-level tab; only
  // counts as an override if the saved value differs from the level's
  // resolved price for the current shop.
  const [overridePriceInput, setOverridePriceInput] = useState<string>("");
  // Open Price prompt — fires when an Open-Price product is added to the
  // cart. Holds the product + selected unit until the cashier confirms
  // the price, then completes the add. The prompt is the only entry path
  // for Open Price items; we never accept the resolved price for them.
  const [openPricePrompt, setOpenPricePrompt] = useState<{ product: Product; unit: ProductUnit } | null>(null);
  const [openPriceInput, setOpenPriceInput] = useState<string>("");
  const [showBarcodeInput, setShowBarcodeInput] = useState(false);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  // Selected POS price level. Newly added cart lines use this level.
  // Existing lines keep whatever level they were rung up at (per spec
  // — switching POS-level should not silently re-price a started cart).
  const [activePriceLevelId, setActivePriceLevelId] = useState<string>("");

  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const { currentShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const products = useDataStore((state) => state.products);
  const productUnits = useDataStore((state) => state.productUnits);
  // Subscriptions used only to render the print receipt inline after a
  // successful "Print (F3)" sale. Cheap because we read from the same
  // store the rest of POS already depends on.
  const sales = useDataStore((state) => state.sales);
  const saleItems = useDataStore((state) => state.saleItems);
  const users = useDataStore((state) => state.users);
  const priceLevels = useDataStore((state) => state.priceLevels);
  const productUnitPrices = useDataStore((state) => state.productUnitPrices);
  const categories = useDataStore((state) => state.categories);
  const brands = useDataStore((state) => state.brands);
  // Subscribe to the inventory array directly so the stock badges recompute
  // after a sale decrements stock. Reading via the (stable) getInventoryQty
  // selector instead left the inventoryById memo with a stale closure that
  // only refreshed on a full reload.
  const inventory = useDataStore((state) => state.inventory);
  const getProductByBarcode = useDataStore((state) => state.getProductByBarcode);
  const createSale = useDataStore((state) => state.createSale);
  const shifts = useDataStore((state) => state.shifts);

  const activePriceLevels = useMemo(() => getActivePriceLevels(priceLevels), [priceLevels]);
  // Pin the dropdown to the default (Retail) level whenever it loads /
  // becomes available. Cashier can still switch it manually.
  useEffect(() => {
    if (activePriceLevelId) return;
    const next = getDefaultPriceLevel(priceLevels) ?? activePriceLevels[0];
    if (next) setActivePriceLevelId(next.id);
  }, [activePriceLevelId, activePriceLevels, priceLevels]);

  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  const currentShop = shops.find((s) => s.id === shopId);
  const hasShop = !!shopId;
  // Cart safety: if the operator switches the selected shop, drop the cart
  // so items rung up against shop A never check out against shop B. The
  // discount and override modal also reset for the same reason.
  useEffect(() => {
    setCartItems([]);
    setCartDiscountPct(0);
    setOverrideItem(null);
    setPaymentOpen(false);
  }, [shopId]);
  // A sale is "in progress" while the cart has lines, the payment dialog is
  // open or a checkout is in flight: the desktop updater never installs then.
  const setSaleInProgress = useSaleActivityStore((state) => state.setSaleInProgress);
  useEffect(() => {
    setSaleInProgress(cartItems.length > 0 || paymentOpen || submitting);
  }, [cartItems.length, paymentOpen, submitting, setSaleInProgress]);
  useEffect(() => () => setSaleInProgress(false), [setSaleInProgress]);
  const openShift = shifts.find((shift) => shift.shopId === shopId && shift.cashierId === currentUserId && !shift.endedAt);
  const canOverridePrice = hasShopPermission(currentUser, "pos:override_price", shopId);
  const canOverrideStock = hasShopPermission(currentUser, "pos:override_stock", shopId);

  // Reset the brand sub-filter whenever the category changes so a stale
  // brand never silently constrains a different category's results.
  useEffect(() => {
    setBrandId("");
  }, [category]);

  const filteredProducts = useMemo(() => {
    return products
      .filter((product) => product.isActive)
      .filter((product) => {
        const matchesSearch = product.name.toLowerCase().includes(search.toLowerCase());
        const matchesCategory = category === "all" || product.category === category;
        const matchesBrand = !brandId || product.brandId === brandId;
        return matchesSearch && matchesCategory && matchesBrand;
      });
  }, [products, search, category, brandId]);

  const inventoryById = useMemo(() => {
    // Build the per-product stock map from the current shop's inventory rows.
    // Products without a row default to 0 at every read site (`?? 0`), so we
    // only need to copy the rows that exist for this shop.
    const map: Record<string, number> = {};
    for (const record of inventory) {
      if (record.shopId === shopId) map[record.productId] = record.qtyBaseUnits;
    }
    return map;
  }, [inventory, shopId]);

  const cartUnitsByProductId = useMemo(() => getRequestedUnitsByProduct(cartItems), [cartItems]);

  const cartValidation = useMemo(
    () =>
      validatePosCart(cartItems, inventoryById, {
        hasOpenShift: Boolean(openShift),
        canOverrideStock,
      }),
    [cartItems, canOverrideStock, inventoryById, openShift]
  );

  const { subtotal, itemDiscount, cartDiscount, total } = calculateCartTotals(cartItems, cartDiscountPct);
  const stockOverrideUnavailableMessage = `${STOCK_OVERRIDE_REQUIRED_MESSAGE} ${STOCK_OVERRIDE_UI_REQUIRED_MESSAGE}`;
  const translateCartMessage = useCallback(
    (message?: string) => {
      if (!message) return undefined;

      const stockMatch = message.match(/^Only (\d+) in stock for this shop\.$/);
      if (stockMatch) {
        return t("pos", "onlyInStockShop", { n: stockMatch[1] });
      }

      if (message === "Cart is empty.") return t("pos", "cartEmpty");
      if (message === "Open a shift before checkout.") return t("pos", "openShiftFirst");
      if (message === "Each cart item needs a valid quantity.") return t("pos", "eachCartItemValidQty");
      if (message === STOCK_OVERRIDE_REQUIRED_MESSAGE) return t("pos", "stockOverrideRequired");
      if (message === stockOverrideUnavailableMessage) {
        return `${t("pos", "stockOverrideRequired")} ${t("pos", "stockOverrideUiRequired")}`;
      }

      return message;
    },
    [stockOverrideUnavailableMessage, t]
  );
  const firstCartError = translateCartMessage(cartValidation.errors[0]);
  const checkoutHelper = !openShift ? t("pos", "openShiftFirst") : firstCartError;
  const paymentValidationError = paymentOpen && !cartValidation.canCheckout ? firstCartError : undefined;
  const localizedCartItemStatuses = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(cartValidation.itemStatuses).map(([id, status]) => [
          id,
          { ...status, message: translateCartMessage(status.message) },
        ])
      ),
    [cartValidation.itemStatuses, translateCartMessage]
  );

  const getStockBlockDescription = useCallback(
    (stockQty: number) =>
      canOverrideStock
        ? translateCartMessage(stockOverrideUnavailableMessage)
        : translateCartMessage(getOnlyInStockMessage(stockQty)),
    [canOverrideStock, stockOverrideUnavailableMessage, translateCartMessage]
  );

  const showCartValidationToast = useCallback(
    (title?: string) => {
      toast({
        title: title ?? t("pos", "checkoutBlocked"),
        description: firstCartError ?? t("pos", "reviewCart"),
        variant: "error",
      });
    },
    [firstCartError, toast, t]
  );

  // Inner helper: actually push the row into the cart. Split out so the
  // Open Price prompt can call it with the cashier-supplied price after
  // confirmation, without the prompt being part of the public callable
  // surface for barcode scans and the product-grid Add button.
  const addLineToCart = (
    product: Product,
    unit: ProductUnit,
    unitPriceMmk: number,
    options: {
      priceLevelId: string;
      priceLevelName: string;
      unitsPerItem: number;
      isOpenPrice: boolean;
      isNonStock: boolean;
    },
  ) => {
    setCartItems((items) => {
      // Cart uniqueness is `productId + productUnitId + priceLevelId` for
      // fixed-price items so the same product+unit can appear once at
      // Retail and once at Wholesale. Open Price items get a unique id
      // every time so two cashier-entered prices for the same product
      // don't merge into one line.
      const sharedKey = options.isOpenPrice
        ? `${product.id}-${unit.id}-open-${Date.now()}`
        : `${product.id}-${unit.id}-${options.priceLevelId}`;
      if (!options.isOpenPrice) {
        const existing = items.find(
          (item) =>
            item.productId === product.id &&
            item.productUnitId === unit.id &&
            item.priceLevelId === options.priceLevelId,
        );
        if (existing) {
          return items.map((item) =>
            item.id === existing.id ? { ...item, qty: item.qty + 1 } : item,
          );
        }
      }
      return [
        ...items,
        {
          id: sharedKey,
          productId: product.id,
          productUnitId: unit.id,
          name: product.name,
          unitName: unit.name,
          qty: 1,
          unitPriceMmk,
          priceLevelId: options.priceLevelId,
          priceLevelName: options.priceLevelName,
          unitBaseQuantity: unit.baseQuantity,
          unitsPerItem: options.unitsPerItem,
          unitLabel: unit.name,
          isOpenPrice: options.isOpenPrice,
          isNonStock: options.isNonStock,
          imageUrl: product.imageUrl,
          category: product.category,
        },
      ];
    });
  };

  const handleAddToCart = (product: Product, unit: ProductUnit): boolean => {
    const isNonStock = Boolean(product.isNonStock);
    const isOpenPrice = Boolean(product.isOpenPrice);

    // Non-stock items skip stock checks entirely. Stock-tracked items go
    // through the usual stock-availability gate before we even ask the
    // cashier for a price (no point prompting if it can't be added).
    const addStatus = getCartAddStockStatus(product, unit, cartItems, inventoryById, {
      isNonStock,
    });
    const unitsPerItem = addStatus.unitsPerItem;
    if (!addStatus.canAdd) {
      toast({
        title: addStatus.stockQty <= 0 ? t("pos", "outOfStock") : t("pos", "stockLimitReached"),
        description: getStockBlockDescription(addStatus.stockQty),
        variant: "error",
      });
      return false;
    }

    // Open Price branch — defer the add until the cashier confirms the
    // price in the modal. The actual cart push happens in
    // `handleOpenPriceConfirm`. The default level metadata is used for
    // labelling only; the server treats Open Price as its own source.
    if (isOpenPrice) {
      setOpenPricePrompt({ product, unit });
      setOpenPriceInput("");
      return true;
    }

    // Standard path: resolve the price for the current POS price level.
    // The server re-resolves in `complete_sale` so a stale value here
    // can't cause an under- or over-charge.
    const resolved = resolveProductUnitPrice({
      unit,
      priceLevelId: activePriceLevelId,
      shopId: shopId ?? undefined,
      priceLevels,
      productUnitPrices,
    });
    addLineToCart(product, unit, resolved.priceMmk, {
      priceLevelId: resolved.priceLevelId,
      priceLevelName: resolved.priceLevelName,
      unitsPerItem,
      isOpenPrice: false,
      isNonStock,
    });
    return true;
  };

  const handleOpenPriceConfirm = () => {
    if (!openPricePrompt) return;
    const value = Number(openPriceInput.replace(/[^\d]/g, ""));
    if (!Number.isFinite(value) || value <= 0) {
      toast({
        title: t("pos", "invalidPrice"),
        description: t("pos", "enterPriceGt0"),
        variant: "error",
      });
      return;
    }
    const { product, unit } = openPricePrompt;
    // For labelling only. The price level snapshot keeps a sensible
    // default-level name on the receipt; complete_sale never resolves a
    // fallback price for is_open_price items.
    const defaultLevel = getDefaultPriceLevel(priceLevels) ?? priceLevels[0];
    addLineToCart(product, unit, Math.trunc(value), {
      priceLevelId: defaultLevel?.id ?? "",
      priceLevelName: defaultLevel?.name ?? "Open",
      unitsPerItem: unit.baseQuantity,
      isOpenPrice: true,
      isNonStock: Boolean(product.isNonStock),
    });
    setOpenPricePrompt(null);
    setOpenPriceInput("");
  };

  // Keep the scan input ready for the next scan: clear value and refocus so
  // a scanner's next Enter-terminated burst still lands here even if a click
  // (e.g. the "Add" button) briefly stole focus.
  const resetBarcodeInputForNextScan = () => {
    setBarcodeInput("");
    barcodeInputRef.current?.focus();
  };

  const handleBarcodeSubmit = () => {
    const value = barcodeInput.trim();
    if (!value) return;
    const match = getProductByBarcode(value);
    if (!match) {
      toast({ title: t("pos", "barcodeNotFound"), description: value, variant: "error" });
      resetBarcodeInputForNextScan();
      return;
    }
    const added = handleAddToCart(match.product, match.unit);
    if (added) {
      toast({ title: t("pos", "addedToCart", { name: match.product.name, unit: match.unit.name }), variant: "success" });
    }
    resetBarcodeInputForNextScan();
  };

  const applyCartQuantity = (id: string, requestedQty: number) => {
    const currentItem = cartItems.find((item) => item.id === id);
    if (!currentItem) return;
    const result = clampCartItemQuantity(currentItem, cartItems, inventoryById, requestedQty);
    if (result.blockedByStock && requestedQty > result.qty) {
      toast({
        title: t("pos", "stockLimitReached"),
        description: getStockBlockDescription(inventoryById[currentItem.productId] ?? 0),
        variant: "error",
      });
    }
    setCartItems((items) =>
      items.map((item) => (item.id === id ? { ...item, qty: result.qty } : item))
    );
  };

  const handleQtyChange = (id: string, delta: number) => {
    const currentItem = cartItems.find((item) => item.id === id);
    if (!currentItem) return;
    applyCartQuantity(id, currentItem.qty + delta);
  };

  const handleQtySet = (id: string, qty: number) => {
    applyCartQuantity(id, qty);
  };

  // Tracks whether the just-opened payment modal should auto-print the
  // receipt after a successful sale. Captured at checkout-start time
  // (F2 = false, F3 = true) and consumed by `handlePaymentConfirm`.
  const [printAfterSave, setPrintAfterSave] = useState(false);
  // After a print-requested sale, this holds the sale id so the hidden
  // ReceiptPreview can render inline (using the store snapshot) and
  // window.print() can fire without navigating off the POS page.
  const [printSaleId, setPrintSaleId] = useState<string | null>(null);
  const printedSaleIdsRef = useRef<Set<string>>(new Set());

  const handleCheckout = useCallback((printOnSuccess: boolean) => {
    if (submitting) return;
    if (!currentUser) {
      toast({ title: t("pos", "checkoutBlocked"), description: t("pos", "signInFirst"), variant: "error" });
      return;
    }
    if (!cartValidation.canCheckout) {
      showCartValidationToast();
      return;
    }
    setPrintAfterSave(printOnSuccess);
    setPaymentOpen(true);
  }, [cartValidation.canCheckout, currentUser, showCartValidationToast, submitting, toast, t]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // F2 = save only; F3 = save + auto-print. Barcode toggle moves to
      // F4 so F3 can be the print-receipt shortcut the cashier asked for.
      if (event.key === "F2") {
        event.preventDefault();
        handleCheckout(false);
      }
      if (event.key === "F3") {
        event.preventDefault();
        handleCheckout(true);
      }
      if (event.key === "Escape") {
        setPaymentOpen(false);
        setOverrideItem(null);
        setShowBarcodeInput(false);
      }
      if (event.key === "F4") {
        event.preventDefault();
        setShowBarcodeInput((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleCheckout]);

  const handlePaymentConfirm = async (paymentMethod: "CASH" | "OTHER", paidMmk: number) => {
    if (!currentUser || submitting) return;
    if (!cartValidation.canCheckout || !openShift) {
      showCartValidationToast(t("pos", "paymentBlocked"));
      return;
    }
    setSubmitting(true);
    try {
      const saleId = await createSale({
        shopId,
        cashierId: currentUser.id,
        shiftId: openShift.id,
        cartItems,
        cartDiscountPct,
        paymentMethod,
        paidMmk,
      });
      // Clear the cart and stay on POS so the cashier can ring up the
      // next sale immediately. When "Print (F3)" was picked we render a
      // hidden ReceiptPreview below and trigger window.print() in an
      // effect — the print CSS already isolates `.receipt` so the rest
      // of the POS page is invisible during printing.
      setCartItems([]);
      setCartDiscountPct(0);
      setPaymentOpen(false);
      // Pull the saved sale from the store so the toast can show the
      // human-friendly receipt number instead of the internal id.
      const savedSale = useDataStore.getState().sales.find((s) => s.id === saleId);
      toast({
        title: printAfterSave ? t("pos", "saleRecordedPrinting") : t("pos", "saleRecorded"),
        description: savedSale ? t("pos", "receiptLine", { no: savedSale.receiptNo }) : undefined,
        variant: "success",
      });
      if (printAfterSave) {
        setPrintSaleId(saleId);
      }
    } catch (error) {
      toast({
        title: t("pos", "checkoutFailed"),
        description: reportError("PosPage.checkout", error, t("pos", "couldNotComplete")),
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Build the props needed to render the hidden receipt for printing.
  // Mirrors the logic in ReceiptDetail so the printed output matches
  // what the cashier sees on the dedicated receipt page exactly.
  const printReceipt = useMemo(() => {
    if (!printSaleId) return null;
    const sale = sales.find((s) => s.id === printSaleId);
    if (!sale) return null;
    const shop = shops.find((s) => s.id === sale.shopId);
    if (!shop) return null;
    const cashier = users.find((u) => u.id === sale.cashierId);
    const itemsForSale = saleItems.filter((item) => item.saleId === printSaleId);
    const lines = itemsForSale.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      const unitName = item.unitNameSnapshot ?? item.unitLabel ?? "Unit";
      const baseQuantity = item.unitBaseQuantitySnapshot ?? item.unitsPerItem ?? 1;
      const soldBaseQuantity = item.baseQuantitySold ?? item.qtyUnits;
      const soldUnitQty = baseQuantity > 0 ? soldBaseQuantity / baseQuantity : item.qtyUnits;
      return {
        name: product?.name ?? item.productId,
        qty: soldUnitQty,
        unitLabel: unitName,
        unitPriceMmk: item.unitPriceMmkSnapshot ?? item.unitPriceMmk,
        lineTotalMmk: item.lineTotalMmk,
        priceLevelName: item.priceLevelNameSnapshot,
      };
    });
    return { sale, shop, cashier, lines };
  }, [printSaleId, sales, saleItems, shops, users, products]);

  // Trigger window.print() once the hidden receipt has rendered. The
  // 500 ms delay lets the brand logo finish loading so the printed
  // output isn't missing it. The sale-id guard prevents duplicate print
  // jobs if React/store updates re-run this effect for the same sale.
  useEffect(() => {
    if (!printReceipt) return;
    const saleId = printReceipt.sale.id;
    const timeout = window.setTimeout(() => {
      if (printedSaleIdsRef.current.has(saleId)) {
        setPrintSaleId(null);
        return;
      }
      printedSaleIdsRef.current.add(saleId);
      void triggerPrint();
      setPrintSaleId(null);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [printReceipt]);

  // Resolve the price for the override modal's currently picked level.
  // Returns null while the modal is closed or the cart's product unit
  // is gone (e.g. the unit was deactivated between add and override).
  const overrideResolved = useMemo(() => {
    if (!overrideItem) return null;
    const unit = productUnits.find((u) => u.id === overrideItem.productUnitId);
    if (!unit) return null;
    return resolveProductUnitPrice({
      unit,
      priceLevelId: overridePriceLevelId || overrideItem.priceLevelId || activePriceLevelId,
      shopId: shopId ?? undefined,
      priceLevels,
      productUnitPrices,
    });
  }, [overrideItem, overridePriceLevelId, productUnits, priceLevels, productUnitPrices, shopId, activePriceLevelId]);

  // Switching the price-level tab also reseeds the manual price input to
  // that level's resolved price. The cashier can then leave it (uses the
  // resolved price) or edit (flagged as a manual override on save).
  const handlePickOverrideLevel = (levelId: string) => {
    if (!overrideItem) return;
    setOverridePriceLevelId(levelId);
    const unit = productUnits.find((u) => u.id === overrideItem.productUnitId);
    if (!unit) return;
    const resolved = resolveProductUnitPrice({
      unit,
      priceLevelId: levelId,
      shopId: shopId ?? undefined,
      priceLevels,
      productUnitPrices,
    });
    setOverridePriceInput(String(resolved.priceMmk));
  };

  const closeOverrideModal = () => {
    setOverrideItem(null);
    setOverridePriceLevelId("");
    setOverridePriceInput("");
  };

  const handleOverrideSave = () => {
    if (!overrideItem) return;
    if (!overrideResolved) {
      toast({
        title: t("pos", "priceLevelUnavailable"),
        description: t("pos", "unitGone"),
        variant: "error",
      });
      return;
    }

    // Parse the input. Empty / non-numeric falls back to the resolved
    // price (i.e. "no manual override"). A value that differs is the
    // override path and must carry priceOverriddenBy.
    const parsedInput = Number(overridePriceInput.replace(/[^\d]/g, ""));
    const manualPrice = Number.isFinite(parsedInput) && parsedInput > 0
      ? Math.trunc(parsedInput)
      : null;
    const finalPrice = manualPrice ?? overrideResolved.priceMmk;
    const isManualOverride = manualPrice !== null && manualPrice !== overrideResolved.priceMmk;
    const overrideBy = isManualOverride ? currentUserId ?? "" : undefined;

    setCartItems((items) => {
      // Only merge with an existing line when the price is the level's
      // resolved price AND a duplicate exists. A manual override stays
      // on its own line — merging would silently average prices.
      const duplicate = !isManualOverride
        ? items.find(
            (item) =>
              item.id !== overrideItem.id &&
              !item.isOpenPrice &&
              !item.priceOverriddenBy &&
              item.productId === overrideItem.productId &&
              item.productUnitId === overrideItem.productUnitId &&
              item.priceLevelId === overrideResolved.priceLevelId,
          )
        : undefined;

      if (duplicate) {
        return items
          .filter((item) => item.id !== overrideItem.id)
          .map((item) =>
            item.id === duplicate.id
              ? {
                  ...item,
                  qty: item.qty + overrideItem.qty,
                  unitPriceMmk: overrideResolved.priceMmk,
                  priceLevelId: overrideResolved.priceLevelId,
                  priceLevelName: overrideResolved.priceLevelName,
                  priceOverriddenBy: undefined,
                }
              : item,
          );
      }

      return items.map((item) =>
        item.id === overrideItem.id
          ? {
              ...item,
              unitPriceMmk: finalPrice,
              priceLevelId: overrideResolved.priceLevelId,
              priceLevelName: overrideResolved.priceLevelName,
              priceOverriddenBy: overrideBy,
            }
          : item,
      );
    });
    closeOverrideModal();
  };

  if (!hasShop) {
    return (
      <Card className="mt-6">
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <span className="material-symbols-rounded text-4xl text-slate-400">store</span>
          <h2 className="text-lg font-semibold text-slate-700">{t("pos", "noShopSelected")}</h2>
          <p className="text-sm text-slate-500 max-w-md">
            {t("pos", "noShopBody")}
            {currentUser?.role === "ADMIN"
              ? t("pos", "noShopAdmin")
              : t("pos", "noShopUser")}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-1.5rem)] min-h-0 flex-col gap-3 lg:h-[calc(100dvh-2rem)] lg:gap-4">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm lg:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-slate-800">{t("pos", "title")}</h1>
          <Badge tone={openShift ? "green" : "amber"}>
            {openShift ? t("pos", "shiftOpen") : t("pos", "noShift")}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:gap-4">
          {/* Barcode Toggle */}
          <button
            type="button"
            onClick={() => setShowBarcodeInput(!showBarcodeInput)}
            className={`flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              showBarcodeInput
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            <span className="material-symbols-rounded text-lg">qr_code_scanner</span>
            {t("pos", "barcodeToggle")}
          </button>
          {/* Shop Info */}
          <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg bg-slate-100 px-3 py-2">
            <span className="material-symbols-rounded text-lg text-slate-500">store</span>
            <span className="truncate text-sm font-medium text-slate-700">{currentShop?.name || t("pos", "noShop")}</span>
          </div>
        </div>
      </div>

      {/* Barcode Input (Collapsible) */}
      {showBarcodeInput && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-sm lg:px-5">
          <span className="material-symbols-rounded text-2xl text-slate-400">qr_code_scanner</span>
          <Input
            ref={barcodeInputRef}
            value={barcodeInput}
            onChange={(e) => setBarcodeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleBarcodeSubmit();
              }
            }}
            placeholder={t("pos", "scanPlaceholder")}
            className="min-w-64 flex-1"
            autoFocus
          />
          <Button onClick={handleBarcodeSubmit}>{t("common", "add")}</Button>
        </div>
      )}

      {/* Main Content */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,34%)] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Products Section */}
        <Card className="min-h-0 flex-1 overflow-hidden p-3 md:p-4 xl:p-5">
          <ProductFinder
            products={filteredProducts}
            categories={categories.filter((c) => c.isActive)}
            brands={brands}
            search={search}
            category={category}
            brandId={brandId}
            onSearch={setSearch}
            onCategory={setCategory}
            onBrand={setBrandId}
            inventoryById={inventoryById}
            cartUnitsByProductId={cartUnitsByProductId}
            productUnits={productUnits}
            onAdd={handleAddToCart}
          />
        </Card>

        {/* Cart Section */}
        <Card className="min-h-[280px] max-h-[42vh] shrink-0 overflow-hidden p-3 md:p-4 lg:max-h-none lg:min-h-0 xl:p-5">
          <CartPanel
            items={cartItems}
            subtotal={subtotal}
            itemDiscount={itemDiscount}
            cartDiscount={cartDiscount}
            total={total}
            cartDiscountPct={cartDiscountPct}
            onDiscountChange={(id, value) =>
              setCartItems((items) => items.map((item) => (item.id === id ? { ...item, itemDiscountPct: value } : item)))
            }
            onQtyChange={handleQtyChange}
            onQtySet={handleQtySet}
            onRemove={(id) => setCartItems((items) => items.filter((item) => item.id !== id))}
            onCartDiscountChange={setCartDiscountPct}
            onCheckout={handleCheckout}
            onOverridePrice={
              canOverridePrice
                ? (item) => {
                    setOverrideItem(item);
                    const startLevelId = item.priceLevelId || activePriceLevelId;
                    setOverridePriceLevelId(startLevelId);
                    setOverridePriceInput(String(item.unitPriceMmk ?? 0));
                  }
                : undefined
            }
            stockStatuses={localizedCartItemStatuses}
            checkoutDisabled={!cartValidation.canCheckout || submitting}
            checkoutHelper={checkoutHelper}
          />
        </Card>
      </div>

      <PaymentModal
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        totalMmk={total}
        onConfirm={handlePaymentConfirm}
        loading={submitting}
        validationError={paymentValidationError}
      />

      <Modal
        open={!!overrideItem}
        onClose={closeOverrideModal}
        title={t("pos", "adjustPrice")}
        description={t("pos", "adjustPriceDesc")}
        footer={
          <>
            <Button variant="secondary" onClick={closeOverrideModal}>
              {t("common", "cancel")}
            </Button>
            <Button onClick={handleOverrideSave} disabled={activePriceLevels.length === 0}>
              {t("pos", "apply")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">{t("pos", "priceLevel")}</label>
            {/* Tabs replace the Select per UX request. flex-1 on each
                button keeps the row evenly distributed regardless of how
                many levels admins have configured. */}
            <div className="flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
              {activePriceLevels.map((level) => {
                const selected = overridePriceLevelId === level.id;
                return (
                  <button
                    key={level.id}
                    type="button"
                    onClick={() => handlePickOverrideLevel(level.id)}
                    className={`min-h-10 min-w-32 flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      selected
                        ? "bg-white text-emerald-700 shadow-sm"
                        : "text-slate-600 hover:text-slate-800"
                    }`}
                  >
                    {level.name}
                    {level.isDefault && (
                      <span className="ml-1 text-[10px] font-normal text-slate-400">
                        {t("pos", "defaultLabel")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              {t("pos", "unitPrice")}
            </label>
            <Input
              inputMode="numeric"
              value={overridePriceInput}
              onChange={(event) =>
                setOverridePriceInput(event.target.value.replace(/[^\d]/g, ""))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleOverrideSave();
                }
              }}
              placeholder={t("pos", "enterPriceMmk")}
            />
            <p className="mt-1 text-xs text-slate-500">
              {overrideResolved
                ? t("pos", "levelPriceHint", { price: overrideResolved.priceMmk.toLocaleString("en-US") })
                : t("pos", "pickLevelHint")}
            </p>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!openPricePrompt}
        onClose={() => {
          setOpenPricePrompt(null);
          setOpenPriceInput("");
        }}
        title={t("pos", "enterPriceTitle")}
        description={
          openPricePrompt
            ? t("pos", "openPriceDesc", {
                name: openPricePrompt.product.name,
                unit: openPricePrompt.unit.name,
              })
            : ""
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setOpenPricePrompt(null);
                setOpenPriceInput("");
              }}
            >
              {t("common", "cancel")}
            </Button>
            <Button onClick={handleOpenPriceConfirm}>{t("pos", "addToCart")}</Button>
          </>
        }
      >
        <Input
          autoFocus
          inputMode="numeric"
          value={openPriceInput}
          onChange={(event) =>
            setOpenPriceInput(event.target.value.replace(/[^\d]/g, ""))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleOpenPriceConfirm();
            }
          }}
          placeholder={t("pos", "unitPriceMmkPlaceholder")}
        />
      </Modal>

      {/* Hidden print host portaled directly into <body> — bypasses any
          positioned ancestor in the POS page tree. The print CSS makes
          `.receipt` `position: absolute; top: 0; left: 0` against its
          nearest positioned ancestor; any wrapper here was causing
          that to land off the printable area. As the wrapper now sits
          as a direct child of <body> with `position: static`, the
          receipt prints correctly at the top of the page. On screen
          the wrapper is hidden via the print-only-host CSS. */}
      {printReceipt && createPortal(
        <div className="print-only-host">
          <ReceiptPreview
            sale={printReceipt.sale}
            lines={printReceipt.lines}
            shop={printReceipt.shop}
            cashier={printReceipt.cashier}
          />
        </div>,
        document.body,
      )}
    </div>
  );
};
