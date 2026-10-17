import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Product } from "../../types";
import { InventoryTable } from "./InventoryTable";

// Batch 2A correction pass (Priority D): this till's unconfirmed deductions
// are shown next to On-hand with their amount first (readable when the label
// wraps at narrow widths), distinct from the confirmed figure.
const product = { id: "p1", sku: "T-1", name: "Tea Mix", category: "Drinks", unitType: "Can", priceMmk: 1000, lowStockThreshold: 2, isActive: true, createdAt: "2026-01-01T00:00:00Z" } as Product;

describe("InventoryTable pending confirmation", () => {
  it("shows the unconfirmed amount, number first", () => {
    const markup = renderToStaticMarkup(<InventoryTable rows={[{ product, qty: 8, unconfirmed: 2 }]} />);
    expect(markup).toContain("8 Can");
    expect(markup).toMatch(/−2<\/span> · Pending confirmation/);
  });

  it("shows nothing when nothing is unconfirmed", () => {
    const markup = renderToStaticMarkup(<InventoryTable rows={[{ product, qty: 8 }]} />);
    expect(markup).not.toContain("Pending confirmation");
  });
});
