import type { ProductBarcode, ProductUnit } from "../../types";
import { normalizeBarcodeKey, normalizeBarcodeValue } from "../../lib/barcodeValidation";

// Product form ⇄ product_barcodes, without collateral damage.
//
// A default-unit barcode exists in two shapes in real data:
//   - product_unit_id NULL (what the product form has always written), and
//   - product_unit_id = <default unit id> (seed data, older imports, the CSV
//     path treats both as "default"; POS scan and label printing resolve it).
// The form used to show only the NULL shape and then delete-and-rewrite every
// barcode of the product on save, so a unit-linked default barcode — and any
// second barcode on a unit — was silently deleted whenever staff saved the
// product. The form now shows both shapes and saves a minimal diff: rows the
// user did not edit are never deleted or rewritten.

type UnitRef = Pick<ProductUnit, "id" | "isDefault">;

/** Does this barcode row belong to `unit` (of `productId`)? A default unit
 *  owns rows stored with its own id and rows stored without a unit. */
export const barcodeBelongsToUnit = (barcode: ProductBarcode, productId: string, unit: UnitRef): boolean => {
  if (barcode.productId !== productId) return false;
  if (barcode.productUnitId === unit.id) return true;
  return unit.isDefault && !barcode.productUnitId;
};

/** The barcode row the form shows for `unit`: an exact unit-id match wins
 *  over a unit-less default row, so the choice is stable. */
export const findUnitBarcode = (
  barcodes: ProductBarcode[],
  productId: string,
  unit: UnitRef,
): ProductBarcode | undefined =>
  barcodes.find((b) => b.productId === productId && b.productUnitId === unit.id && !!b.value) ??
  (unit.isDefault ? barcodes.find((b) => b.productId === productId && !b.productUnitId && !!b.value) : undefined);

/** What the form loaded for one unit: the value shown and the row it came from. */
export interface LoadedUnitBarcode {
  value: string;
  barcodeId?: string;
  productUnitId?: string;
}

/** Hydrate the per-unit barcode fields of the product form. */
export const loadUnitBarcodes = (
  productId: string,
  units: UnitRef[],
  barcodes: ProductBarcode[],
): Record<string, LoadedUnitBarcode> =>
  Object.fromEntries(
    units.map((unit) => {
      const row = findUnitBarcode(barcodes, productId, unit);
      return [unit.id, row ? { value: row.value, barcodeId: row.id, productUnitId: row.productUnitId } : { value: "" }];
    }),
  );

export interface BarcodeSavePlan {
  /** Existing product_barcodes ids to delete (all belong to the product). */
  deleteIds: string[];
  /** New rows to insert after the deletes. */
  inserts: ProductBarcode[];
}

/**
 * Minimal set of barcode writes for a product-form save.
 *
 * - A unit whose field still holds the value it was loaded with is left
 *   alone (its row keeps its id, value and product_unit_id) — unless it is
 *   a unit-less default row whose unit is no longer the default, which is
 *   re-linked to that unit so it does not move to the new default.
 * - An edited field replaces only the row that field was showing; a cleared
 *   field deletes only that row.
 * - A typed value that already exists on another row of the same product is
 *   moved (that row is deleted) instead of colliding with the unique index.
 * - Rows the form never showed (extra barcodes, barcodes of units no longer
 *   in the form) are never touched.
 */
export const planProductBarcodeSave = (input: {
  productId: string;
  units: UnitRef[];
  existing: ProductBarcode[];
  loaded: Record<string, LoadedUnitBarcode>;
  formValues: Record<string, string>;
  newId: () => string;
}): BarcodeSavePlan => {
  const { productId, units, existing, loaded, formValues, newId } = input;
  const own = existing.filter((b) => b.productId === productId);
  const ownIds = new Set(own.map((b) => b.id));
  const deleteIds = new Set<string>();
  const inserts: ProductBarcode[] = [];

  for (const unit of units) {
    const before = loaded[unit.id] ?? { value: "" };
    const next = normalizeBarcodeValue(formValues[unit.id] ?? "");
    const shown = before.barcodeId && ownIds.has(before.barcodeId) ? before.barcodeId : undefined;

    if (next === normalizeBarcodeValue(before.value)) {
      if (shown && next && !before.productUnitId && !unit.isDefault) {
        deleteIds.add(shown);
        inserts.push({ id: newId(), productId, productUnitId: unit.id, value: next, type: rowType(own, shown) });
      }
      continue;
    }

    if (shown) deleteIds.add(shown);
    if (!next) continue;
    const productUnitId = shown && before.productUnitId === unit.id
      ? unit.id
      : unit.isDefault ? undefined : unit.id;
    inserts.push({ id: newId(), productId, productUnitId, value: next, type: "EAN13" });
  }

  const insertKeys = new Set(inserts.map((row) => normalizeBarcodeKey(row.value)));
  for (const row of own) {
    if (!deleteIds.has(row.id) && insertKeys.has(normalizeBarcodeKey(row.value))) deleteIds.add(row.id);
  }

  return { deleteIds: [...deleteIds], inserts };
};

const rowType = (rows: ProductBarcode[], id: string): ProductBarcode["type"] =>
  rows.find((row) => row.id === id)?.type ?? "EAN13";
