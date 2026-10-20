import { describe, expect, it } from "vitest";
import { stockValuationRows, stockValuationTotals } from "./stockValuation";

describe("stock valuation (fix 4)", () => {
  const shops = [{ id: "s1" }, { id: "s2" }];
  const inventory = [
    { shopId: "s1", productId: "a", qtyBaseUnits: 10 },
    { shopId: "s2", productId: "a", qtyBaseUnits: 5 },
    { shopId: "s1", productId: "nc", qtyBaseUnits: 4 },
  ];
  const products = [
    { id: "a", name: "A", priceMmk: 1000, costMmk: 600 },
    { id: "nc", name: "No cost", priceMmk: 2000, costMmk: undefined },
    { id: "zero", name: "Not stocked", priceMmk: 100, costMmk: undefined },
  ];

  it("values known cost; a product with no cost on this device is UNAVAILABLE, never 0", () => {
    const rows = stockValuationRows(products, inventory, shops, null);
    expect(rows).toEqual([
      { productId: "a", productName: "A", totalQty: 15, retailValue: 15000, costValue: 9000 },
      { productId: "nc", productName: "No cost", totalQty: 4, retailValue: 8000, costValue: null },
    ]);
    expect(stockValuationTotals(rows)).toEqual({ retail: 23000, cost: null, costMissing: 1 });
  });

  it("one shop: only its stock; complete there -> the cost total is known", () => {
    const rows = stockValuationRows(products, inventory.filter((i) => i.productId === "a"), shops, "s2");
    expect(rows).toEqual([{ productId: "a", productName: "A", totalQty: 5, retailValue: 5000, costValue: 3000 }]);
    expect(stockValuationTotals(rows)).toEqual({ retail: 5000, cost: 3000, costMissing: 0 });
  });

  it("a user who may not see cost (stripped on the device) sees every cost value unavailable", () => {
    const stripped = products.map(({ costMmk: _c, ...p }) => { void _c; return p; });
    const rows = stockValuationRows(stripped, inventory, shops, null);
    expect(rows.every((r) => r.costValue === null)).toBe(true);
    expect(stockValuationTotals(rows).cost).toBeNull();
  });
});
