import { describe, it, expect } from "vitest";
import type { ProductBarcode } from "../../types";
import {
  barcodeBelongsToUnit,
  findUnitBarcode,
  loadUnitBarcodes,
  planProductBarcodeSave,
} from "./productBarcodeForm";

// Reproduces the e2e spec-D bug: QA Product One's barcode is stored with
// product_unit_id = its default unit's id. The form showed an empty barcode
// field for the default unit and the save then deleted the row.

const P = "prod1";
const def = { id: "unit1", isDefault: true };
const box = { id: "unit-box", isDefault: false };

const bc = (id: string, value: string, productUnitId?: string, productId = P): ProductBarcode =>
  ({ id, productId, productUnitId, value, type: "CODE128" });

let seq = 0;
const newId = () => `bc-new-${++seq}`;

const plan = (existing: ProductBarcode[], units: { id: string; isDefault: boolean }[], formValues: Record<string, string>, loadedFrom = existing) =>
  planProductBarcodeSave({ productId: P, units, existing, loaded: loadUnitBarcodes(P, units, loadedFrom), formValues, newId });

describe("loading barcodes into the product form", () => {
  it("shows a default-unit barcode stored with the default unit's id", () => {
    const loaded = loadUnitBarcodes(P, [def, box], [bc("b1", "QA-BC-1", "unit1")]);
    expect(loaded.unit1).toEqual({ value: "QA-BC-1", barcodeId: "b1", productUnitId: "unit1" });
    expect(loaded["unit-box"]).toEqual({ value: "" });
  });

  it("still shows a legacy unit-less default barcode", () => {
    expect(loadUnitBarcodes(P, [def], [bc("b0", "LEGACY")]).unit1.value).toBe("LEGACY");
  });

  it("prefers the exact unit-id row over a unit-less one, and never shows a unit-less row on a non-default unit", () => {
    const rows = [bc("b0", "LEGACY"), bc("b1", "LINKED", "unit1")];
    expect(findUnitBarcode(rows, P, def)?.id).toBe("b1");
    expect(findUnitBarcode(rows, P, box)).toBeUndefined();
    expect(barcodeBelongsToUnit(rows[0], P, def)).toBe(true);
    expect(barcodeBelongsToUnit(rows[0], P, box)).toBe(false);
    expect(barcodeBelongsToUnit(bc("x", "X", "unit1", "other"), P, def)).toBe(false);
  });
});

describe("planning the barcode writes of a product save", () => {
  it("saving without touching the barcode keeps a unit-linked default barcode (spec D bug)", () => {
    const existing = [bc("b1", "QA-BC-1", "unit1")];
    // What the form holds after hydration, unchanged by the user.
    const formValues = { unit1: "QA-BC-1" };
    expect(plan(existing, [def], formValues)).toEqual({ deleteIds: [], inserts: [] });
  });

  it("never touches barcodes the form does not show (extra rows, other products, removed units)", () => {
    const existing = [
      bc("b1", "MAIN", "unit1"),
      bc("b2", "SECOND-ON-DEFAULT", "unit1"),
      bc("b3", "OLD-UNIT", "unit-gone"),
      bc("b4", "OTHER-PRODUCT", undefined, "prod2"),
    ];
    const result = plan(existing, [def], { unit1: "MAIN-NEW" });
    expect(result.deleteIds).toEqual(["b1"]);
    expect(result.inserts).toEqual([{ id: expect.any(String), productId: P, productUnitId: "unit1", value: "MAIN-NEW", type: "EAN13" }]);
  });

  it("an edited field replaces only the row it showed, keeping a legacy row unit-less", () => {
    const result = plan([bc("b0", "LEGACY"), bc("bx", "BOX-1", "unit-box")], [def, box], { unit1: "NEW-DEFAULT", "unit-box": "BOX-1" });
    expect(result.deleteIds).toEqual(["b0"]);
    expect(result.inserts).toEqual([{ id: expect.any(String), productId: P, productUnitId: undefined, value: "NEW-DEFAULT", type: "EAN13" }]);
  });

  it("a cleared field deletes only that row", () => {
    const result = plan([bc("b1", "QA-BC-1", "unit1"), bc("bx", "BOX-1", "unit-box")], [def, box], { unit1: "QA-BC-1", "unit-box": "" });
    expect(result).toEqual({ deleteIds: ["bx"], inserts: [] });
  });

  it("a barcode typed into an empty field is added with the unit convention", () => {
    const result = plan([bc("b1", "QA-BC-1", "unit1")], [def, box], { unit1: "QA-BC-1", "unit-box": " box-9 " });
    expect(result.deleteIds).toEqual([]);
    expect(result.inserts).toEqual([{ id: expect.any(String), productId: P, productUnitId: "unit-box", value: "box-9", type: "EAN13" }]);
  });

  it("moving a value to another unit deletes the row that held it instead of colliding", () => {
    const existing = [bc("b1", "MOVE-ME", "unit1"), bc("hidden", "HIDDEN-DUP", "unit-gone")];
    const result = plan(existing, [def, box], { unit1: "", "unit-box": "hidden-dup" });
    expect(result.deleteIds.sort()).toEqual(["b1", "hidden"]);
    expect(result.inserts.map((r) => [r.value, r.productUnitId])).toEqual([["hidden-dup", "unit-box"]]);
  });

  it("re-links a unit-less default barcode when its unit stops being the default", () => {
    const existing = [bc("b0", "WAS-DEFAULT")];
    const loaded = loadUnitBarcodes(P, [def, box], existing);
    const result = planProductBarcodeSave({
      productId: P,
      units: [{ id: "unit1", isDefault: false }, { id: "unit-box", isDefault: true }],
      existing, loaded, formValues: { unit1: "WAS-DEFAULT", "unit-box": "" }, newId,
    });
    expect(result.deleteIds).toEqual(["b0"]);
    expect(result.inserts).toEqual([{ id: expect.any(String), productId: P, productUnitId: "unit1", value: "WAS-DEFAULT", type: "CODE128" }]);
  });

  it("a new product inserts every filled field", () => {
    const result = planProductBarcodeSave({ productId: P, units: [def, box], existing: [], loaded: {}, formValues: { unit1: "A1", "unit-box": "" }, newId });
    expect(result).toEqual({ deleteIds: [], inserts: [{ id: expect.any(String), productId: P, productUnitId: undefined, value: "A1", type: "EAN13" }] });
  });

  it("a row deleted elsewhere since the form loaded is not deleted again", () => {
    const loadedFrom = [bc("b1", "GONE", "unit1")];
    const result = plan([], [def], { unit1: "NEW" }, loadedFrom);
    expect(result.deleteIds).toEqual([]);
    expect(result.inserts.map((r) => r.value)).toEqual(["NEW"]);
  });
});
