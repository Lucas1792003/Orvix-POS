import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Category, Product, ProductUnit } from "../../types";
import { ProductFinder } from "./ProductFinder";

const product = (overrides: Partial<Product> = {}): Product => ({
  id: "prod-1",
  sku: "TEA-001",
  name: "Tea Mix",
  category: "Drinks",
  unitType: "Sachet",
  priceMmk: 1000,
  lowStockThreshold: 2,
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const category = (overrides: Partial<Category> = {}): Category => ({
  id: "cat-drinks",
  name: "Drinks",
  color: "blue",
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const unit = (overrides: Partial<ProductUnit> = {}): ProductUnit => ({
  id: "unit-prod-1-default",
  productId: "prod-1",
  name: "Sachet",
  baseQuantity: 1,
  salePriceMmk: 1000,
  purchasePriceMmk: undefined,
  isDefault: true,
  isActive: true,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("ProductFinder", () => {
  it("does not render Add Pack from legacy packSize", () => {
    const markup = renderToStaticMarkup(
      <ProductFinder
        products={[product({ packSize: 24 })]}
        categories={[category()]}
        search=""
        category="all"
        onSearch={() => undefined}
        onCategory={() => undefined}
        inventoryById={{ "prod-1": 100 }}
        productUnits={[unit()]}
        onAdd={() => undefined}
      />
    );

    expect(markup).not.toContain("Add Pack");
    expect(markup).not.toContain("pack of");
  });

  it("renders configured sellable units instead of legacy pack controls", () => {
    const markup = renderToStaticMarkup(
      <ProductFinder
        products={[product()]}
        categories={[category()]}
        search=""
        category="all"
        onSearch={() => undefined}
        onCategory={() => undefined}
        inventoryById={{ "prod-1": 100 }}
        productUnits={[unit(), unit({ id: "unit-case", name: "Case", baseQuantity: 24, salePriceMmk: 22000, isDefault: false })]}
        onAdd={() => undefined}
      />
    );

    expect(markup).toContain("Sachet");
    expect(markup).toContain("Case");
    expect(markup).not.toContain("Add Pack");
  });

  // Batch 2A correction pass (Priority D): the unconfirmed amount is visible
  // without hover and never overlays the Low / Out of stock warnings.
  it("shows unconfirmed units as a readable line in the card body, not over the stock warnings", () => {
    const markup = renderToStaticMarkup(
      <ProductFinder
        products={[product({ lowStockThreshold: 5 })]}
        categories={[category()]}
        search=""
        category="all"
        onSearch={() => undefined}
        onCategory={() => undefined}
        inventoryById={{ "prod-1": 3 }}
        pendingConfirmationById={{ "prod-1": 2 }}
        productUnits={[unit()]}
        onAdd={() => undefined}
      />
    );
    expect(markup).toContain("−2 unconfirmed");                 // the amount, without hover
    const imageArea = markup.slice(markup.indexOf("relative h-28"), markup.indexOf("<h3"));
    expect(imageArea).toContain("Low");                          // the warning is still there …
    expect(imageArea).not.toContain("unconfirmed");              // … and not covered by the badge
    expect(markup.indexOf("−2 unconfirmed")).toBeGreaterThan(markup.indexOf("<h3"));
  });

  it("shows nothing extra when nothing is unconfirmed", () => {
    const markup = renderToStaticMarkup(
      <ProductFinder
        products={[product()]} categories={[category()]} search="" category="all"
        onSearch={() => undefined} onCategory={() => undefined}
        inventoryById={{ "prod-1": 30 }} productUnits={[unit()]} onAdd={() => undefined}
      />
    );
    expect(markup).not.toContain("unconfirmed");
  });
});
