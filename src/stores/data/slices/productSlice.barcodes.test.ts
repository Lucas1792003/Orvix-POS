import { describe, it, expect, vi, beforeEach } from "vitest";

// Bug: saving the product form deleted every barcode of the product and
// re-inserted only the ones the form showed. These tests pin the store side
// of the fix: a product update that is not given barcodes leaves
// product_barcodes alone, and the form's barcode save only deletes the rows
// it names.

type Call = { table: string; op: string; args: unknown[] };
const calls: Call[] = [];

function query(table: string) {
  const q: Record<string, unknown> = {};
  const chain = (op: string) => (...args: unknown[]) => {
    calls.push({ table, op, args });
    return q;
  };
  for (const op of ["insert", "update", "delete", "eq", "in"]) q[op] = chain(op);
  q.then = (resolve: (v: { error: null }) => unknown) => resolve({ error: null });
  return q;
}

vi.mock("../../../lib/supabase", () => ({
  supabase: { from: (table: string) => query(table) },
  dbWrite: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbExec: async (q: PromiseLike<{ error: any }>, label: string) => {
    const { error } = await q;
    if (error) throw new Error(error.message ?? `${label} failed.`);
  },
}));

import { createProductSlice } from "./productSlice";
import type { Product, ProductBarcode } from "../../../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStore(seed: Record<string, any>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => {
    state = { ...state, ...(typeof updater === "function" ? updater(state) : updater) };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state = { ...createProductSlice(set, () => state, {} as any), ...seed };
  return { get: () => state };
}

const product: Product = {
  id: "p1", sku: "QA-1", name: "QA Product One", category: "General", unitType: "Piece",
  priceMmk: 1000, lowStockThreshold: 5, isActive: true, createdAt: "2026-01-01T00:00:00.000Z",
} as Product;

const linked: ProductBarcode = { id: "bc-linked", productId: "p1", productUnitId: "u-default", value: "QA-BC-1", type: "CODE128" };
const extra: ProductBarcode = { id: "bc-extra", productId: "p1", productUnitId: "u-case", value: "QA-CASE-2", type: "EAN13" };
const other: ProductBarcode = { id: "bc-other", productId: "p2", value: "OTHER", type: "EAN13" };

beforeEach(() => { calls.length = 0; });

describe("productSlice barcodes on product save", () => {
  it("updateProduct without a barcode list does not touch product_barcodes", async () => {
    const { get } = makeStore({ products: [product], barcodes: [linked, extra, other] });
    await get().updateProduct({ ...product, name: "Renamed" });
    expect(calls.filter((c) => c.table === "product_barcodes")).toEqual([]);
    expect(get().barcodes).toEqual([linked, extra, other]);
    expect(get().products[0].name).toBe("Renamed");
  });

  it("updateProduct with an explicit list (CSV import) still replaces the product's barcodes", async () => {
    const { get } = makeStore({ products: [product], barcodes: [linked, other] });
    const csvRow: ProductBarcode = { id: "bc-csv", productId: "p1", value: "CSV-1", type: "EAN13" };
    await get().updateProduct(product, [csvRow]);
    const ops = calls.filter((c) => c.table === "product_barcodes").map((c) => c.op);
    expect(ops).toEqual(["delete", "eq", "insert"]);
    expect(get().barcodes).toEqual([other, csvRow]);
  });

  it("applyProductBarcodeChanges deletes only the named rows and inserts the new ones", async () => {
    const { get } = makeStore({ products: [product], barcodes: [linked, extra, other] });
    const added: ProductBarcode = { id: "bc-new", productId: "p1", productUnitId: "u-case", value: "QA-CASE-3", type: "EAN13" };
    await get().applyProductBarcodeChanges("p1", { deleteIds: ["bc-extra"], inserts: [added] });
    const writes = calls.filter((c) => c.table === "product_barcodes");
    expect(writes.map((c) => c.op)).toEqual(["delete", "in", "eq", "insert"]);
    expect(writes[1].args).toEqual(["id", ["bc-extra"]]);
    expect(writes[2].args).toEqual(["product_id", "p1"]);
    expect(get().barcodes).toEqual([linked, other, added]);
  });

  it("applyProductBarcodeChanges with an empty plan writes nothing", async () => {
    const { get } = makeStore({ products: [product], barcodes: [linked] });
    await get().applyProductBarcodeChanges("p1", { deleteIds: [], inserts: [] });
    expect(calls).toEqual([]);
    expect(get().barcodes).toEqual([linked]);
  });
});
