import type { Product, ProductBarcode, ProductUnit } from "../../types";
import { findUnitBarcode } from "../catalog/productBarcodeForm";

export interface PrintableBarcode {
  /** The scannable string to encode + show under the bars. */
  value: string;
  /** Where the value came from — drives the helper text in the UI. */
  source: "barcode" | "sku";
}

/**
 * The single source of truth for "what barcode would we print for this
 * product?" Used by the Barcode Labels page (and by anything else that
 * needs to render a scannable code for a product).
 *
 * Rule: prefer the product's first registered `product_barcodes.value`
 * (that's what POS scanning resolves against today); fall back to
 * `products.sku` so a freshly created product is still printable as soon
 * as its SKU exists. Return `null` if neither is available — the label
 * cannot be printed.
 *
 * Selecting "first" is intentional: there is no notion of a primary /
 * active barcode in the schema, so order from the store is the only
 * stable signal. If a primary barcode concept is added later, switch the
 * selection here and POS lookup together.
 */
export const getPrintableBarcodeValue = (
  product: Pick<Product, "id" | "sku">,
  barcodes: ProductBarcode[],
  unit?: Pick<ProductUnit, "id" | "isDefault">
): PrintableBarcode | null => {
  // A default-unit barcode may be stored with the default unit's id or with
  // no unit (findUnitBarcode accepts both, exact id first).
  const own = unit
    ? findUnitBarcode(barcodes, product.id, unit)
    : barcodes.find((b) => b.productId === product.id && !!b.value);
  if (own) return { value: own.value, source: "barcode" };
  if ((!unit || unit.isDefault) && product.sku) return { value: product.sku, source: "sku" };
  return null;
};

/**
 * Clamp a quantity-of-labels input to a sensible range. The cashier UI
 * lets the user type a number; this guards against accidental huge
 * prints. 200 is a generous upper bound for one print job.
 */
export const MIN_LABEL_QTY = 1;
export const MAX_LABEL_QTY = 200;

export const clampLabelQty = (raw: number | undefined): number => {
  if (!Number.isFinite(raw ?? NaN)) return MIN_LABEL_QTY;
  return Math.max(MIN_LABEL_QTY, Math.min(MAX_LABEL_QTY, Math.floor(raw as number)));
};
