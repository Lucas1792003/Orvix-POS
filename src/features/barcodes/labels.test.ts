import { describe, it, expect } from "vitest";
import {
  clampLabelQty,
  getPrintableBarcodeValue,
  MAX_LABEL_QTY,
  MIN_LABEL_QTY,
} from "./labels";
import type { ProductBarcode, ProductUnit } from "../../types";

const barcode = (productId: string, value: string): ProductBarcode => ({
  id: `${productId}-${value}`,
  productId,
  value,
  type: "EAN13",
});

const unit = (overrides: Partial<ProductUnit> = {}): ProductUnit => ({
  id: "unit-default",
  productId: "p1",
  name: "Can",
  baseQuantity: 1,
  priceMmk: 1000,
  isDefault: true,
  isActive: true,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("getPrintableBarcodeValue", () => {
  it("prefers the first product_barcodes row for the product", () => {
    const result = getPrintableBarcodeValue(
      { id: "p1", sku: "ALT-001" },
      [barcode("p1", "8801001"), barcode("p1", "9999")]
    );
    expect(result).toEqual({ value: "8801001", source: "barcode" });
  });

  it("ignores barcodes for other products", () => {
    const result = getPrintableBarcodeValue(
      { id: "p1", sku: "ALT-001" },
      [barcode("p2", "wrong"), barcode("p3", "alsowrong")]
    );
    expect(result).toEqual({ value: "ALT-001", source: "sku" });
  });

  it("falls back to SKU when the product has no barcodes", () => {
    const result = getPrintableBarcodeValue({ id: "p1", sku: "BEE-001" }, []);
    expect(result).toEqual({ value: "BEE-001", source: "sku" });
  });

  it("returns null when neither a barcode nor an SKU exists", () => {
    const result = getPrintableBarcodeValue({ id: "p1", sku: "" }, []);
    expect(result).toBeNull();
  });

  it("ignores empty barcode values", () => {
    const result = getPrintableBarcodeValue(
      { id: "p1", sku: "BEE-001" },
      [{ id: "x", productId: "p1", value: "", type: "EAN13" }]
    );
    expect(result).toEqual({ value: "BEE-001", source: "sku" });
  });

  it("uses a unit-specific barcode for non-default sellable units", () => {
    const result = getPrintableBarcodeValue(
      { id: "p1", sku: "BEE-001" },
      [{ ...barcode("p1", "CASE-001"), productUnitId: "unit-case" }],
      unit({ id: "unit-case", name: "Case", isDefault: false })
    );
    expect(result).toEqual({ value: "CASE-001", source: "barcode" });
  });

  it("does not use SKU fallback for non-default sellable units", () => {
    const result = getPrintableBarcodeValue(
      { id: "p1", sku: "BEE-001" },
      [],
      unit({ id: "unit-case", name: "Case", isDefault: false })
    );
    expect(result).toBeNull();
  });

  it("prints a default-unit barcode stored with the default unit's id (not the SKU)", () => {
    const result = getPrintableBarcodeValue(
      { id: "p1", sku: "BEE-001" },
      [{ ...barcode("p1", "QA-BC-1"), productUnitId: "unit-default" }],
      unit()
    );
    expect(result).toEqual({ value: "QA-BC-1", source: "barcode" });
  });
});

describe("clampLabelQty", () => {
  it("returns the minimum for non-numeric / undefined", () => {
    expect(clampLabelQty(undefined)).toBe(MIN_LABEL_QTY);
    expect(clampLabelQty(Number.NaN)).toBe(MIN_LABEL_QTY);
  });

  it("clamps below the minimum", () => {
    expect(clampLabelQty(0)).toBe(MIN_LABEL_QTY);
    expect(clampLabelQty(-12)).toBe(MIN_LABEL_QTY);
  });

  it("clamps above the maximum", () => {
    expect(clampLabelQty(500)).toBe(MAX_LABEL_QTY);
    expect(clampLabelQty(MAX_LABEL_QTY + 1)).toBe(MAX_LABEL_QTY);
  });

  it("floors fractional input (cashier shouldn't print 1.5 labels)", () => {
    expect(clampLabelQty(3.9)).toBe(3);
  });

  it("passes through valid integers", () => {
    expect(clampLabelQty(1)).toBe(1);
    expect(clampLabelQty(24)).toBe(24);
    expect(clampLabelQty(MAX_LABEL_QTY)).toBe(MAX_LABEL_QTY);
  });
});
