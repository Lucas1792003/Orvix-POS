import { describe, expect, it } from "vitest";
import type { CartItem } from "../../types";
import {
  approvalCovers, cartDiscountPolicy, discountPolicy, needsShopAdmin, ownDiscountAllowed, referenceSubtotalOf, requestDescribesCart, tierReferencePrice,
  type DiscountApprovalView,
} from "./discountPolicy";

const manager = { role: "MANAGER", canApplyDiscount: true };
const item = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea", unitName: "Can", qty: 2, unitPriceMmk: 5000, unitsPerItem: 1, unitBaseQuantity: 1,
  ...over,
} as CartItem);

describe("discountPolicy (mirrors PDISC-A fin_discount_authorize)", () => {
  it("no discount never needs approval", () => {
    expect(discountPolicy({ role: "CASHIER", canApplyDiscount: true, referenceSubtotalMmk: 10_000, totalMmk: 10_000 }))
      .toEqual({ discountMmk: 0, pct: 0, needsApproval: false, needsShopAdmin: false });
  });
  it("a cashier needs approval for ANY discount > 0", () => {
    expect(discountPolicy({ role: "CASHIER", canApplyDiscount: true, referenceSubtotalMmk: 10_000, totalMmk: 9_999 }))
      .toMatchObject({ discountMmk: 1, needsApproval: true, needsShopAdmin: false });
  });
  it("a manager / admin with pos:apply_discount may give up to AND including 5% on their own", () => {
    expect(discountPolicy({ ...manager, referenceSubtotalMmk: 10_000, totalMmk: 9_500 })).toMatchObject({ discountMmk: 500, pct: 5, needsApproval: false, needsShopAdmin: false });
    expect(discountPolicy({ role: "ADMIN", canApplyDiscount: true, referenceSubtotalMmk: 10_000, totalMmk: 9_500 }).needsApproval).toBe(false);
    expect(discountPolicy({ ...manager, referenceSubtotalMmk: 10_000, totalMmk: 9_499 })).toMatchObject({ discountMmk: 501, needsApproval: true, needsShopAdmin: true });
  });
  it("the 5% line is compared in whole MMK (discount × 100 ≤ reference × 5), never by a rounded percentage", () => {
    // 5.0049…% of 9,991: 500.0 would be 5.0045%: 500 × 100 = 50,000 > 49,955 → needs approval
    expect(discountPolicy({ ...manager, referenceSubtotalMmk: 9_991, totalMmk: 9_491 }).needsApproval).toBe(true);
    expect(discountPolicy({ ...manager, referenceSubtotalMmk: 9_991, totalMmk: 9_492 }).needsApproval).toBe(false);
  });
  it("a manager without pos:apply_discount (revoked) needs approval for any discount", () => {
    expect(discountPolicy({ role: "MANAGER", canApplyDiscount: false, referenceSubtotalMmk: 10_000, totalMmk: 9_900 }).needsApproval).toBe(true);
  });
  it("a BUYER / unknown role is treated like a cashier", () => {
    expect(discountPolicy({ role: "BUYER", canApplyDiscount: true, referenceSubtotalMmk: 10_000, totalMmk: 9_900 }).needsApproval).toBe(true);
    expect(discountPolicy({ role: null, canApplyDiscount: true, referenceSubtotalMmk: 10_000, totalMmk: 9_900 }).needsApproval).toBe(true);
  });
});

describe("cart reference subtotal and discount", () => {
  it("line + cart discounts are measured against the price before any discount, totals rounded like complete_sale", () => {
    const p = cartDiscountPolicy([item({ itemDiscountPct: 3 })], 3, manager);
    // 10,000 → line 9,700 → cart 3% of 9,700 = 291 → total 9,409; discount 591 = 5.91%
    expect(p).toMatchObject({ referenceSubtotalMmk: 10_000, totalMmk: 9_409, discountMmk: 591, needsApproval: true, needsShopAdmin: true });
  });
  it("a manual override below the price before it counts as a discount", () => {
    const overridden = item({ unitPriceMmk: 4_000, priceOverriddenBy: "user-1", priceBeforeOverrideMmk: 5_000 });
    expect(referenceSubtotalOf([overridden])).toBe(10_000);
    expect(cartDiscountPolicy([overridden], 0, { role: "CASHIER", canApplyDiscount: true })).toMatchObject({ discountMmk: 2_000, needsApproval: true });
  });
  it("an override ABOVE the price before it is no discount (the server takes the higher price as reference)", () => {
    const overridden = item({ unitPriceMmk: 6_000, priceOverriddenBy: "user-1", priceBeforeOverrideMmk: 5_000 });
    expect(cartDiscountPolicy([overridden], 0, { role: "CASHIER", canApplyDiscount: true })).toMatchObject({ referenceSubtotalMmk: 12_000, discountMmk: 0, needsApproval: false });
  });
  it("an override whose earlier price the cart does not know counts at the overridden price", () => {
    expect(referenceSubtotalOf([item({ unitPriceMmk: 4_000, priceOverriddenBy: "user-1" })])).toBe(8_000);
  });
});

describe("ownDiscountAllowed — rule (a): effective ≤ 5%, or exactly one layer of at most 5%", () => {
  const layers = (over: Partial<Parameters<typeof ownDiscountAllowed>[2]> = {}) =>
    ({ referenceMmk: 10_000, discountMmk: 0, cartPct: 0, linePcts: [], hasOverrideReduction: false, ...over });
  it("1,050 MMK at a 5% cart discount → 53 MMK (5.05% after rounding) is allowed for a manager", () => {
    const p = cartDiscountPolicy([item({ qty: 1, unitPriceMmk: 1_050 })], 5, manager);
    expect(p).toMatchObject({ referenceSubtotalMmk: 1_050, totalMmk: 997, discountMmk: 53, needsApproval: false, needsShopAdmin: true });
    expect(ownDiscountAllowed("MANAGER", true, layers({ referenceMmk: 1_050, discountMmk: 53, cartPct: 5 }))).toBe(true);
    // the same for a cashier: any discount needs approval
    expect(cartDiscountPolicy([item({ qty: 1, unitPriceMmk: 1_050 })], 5, { role: "CASHIER", canApplyDiscount: true }).needsApproval).toBe(true);
  });
  it("a 3% line + 3% cart discount (two layers, 5.91% effective) needs approval", () => {
    expect(cartDiscountPolicy([item({ itemDiscountPct: 3 })], 3, manager)).toMatchObject({ discountMmk: 591, needsApproval: true });
    expect(ownDiscountAllowed("MANAGER", true, layers({ discountMmk: 591, cartPct: 3, linePcts: [3] }))).toBe(false);
  });
  it("two lines at 5% each and no cart discount are allowed (one layer)", () => {
    const lines = [item({ id: "a", qty: 1, unitPriceMmk: 1_050, itemDiscountPct: 5 }), item({ id: "b", productId: "p2", qty: 1, unitPriceMmk: 1_050, itemDiscountPct: 5 })];
    const p = cartDiscountPolicy(lines, 0, manager);
    expect(p).toMatchObject({ referenceSubtotalMmk: 2_100, discountMmk: 104, needsApproval: false });
    // even where rounding takes the effective discount above 5% (106 of 2,100 = 5.05%), one layer stays allowed
    expect(ownDiscountAllowed("ADMIN", true, layers({ referenceMmk: 2_100, discountMmk: 106, linePcts: [5, 5] }))).toBe(true);
  });
  it("one layer above 5%, a line above 5%, or an override reduction beside a layer needs approval", () => {
    expect(ownDiscountAllowed("MANAGER", true, layers({ discountMmk: 600, cartPct: 6 }))).toBe(false);
    expect(ownDiscountAllowed("MANAGER", true, layers({ discountMmk: 600, linePcts: [5, 6] }))).toBe(false);
    expect(ownDiscountAllowed("MANAGER", true, layers({ referenceMmk: 1_050, discountMmk: 53, cartPct: 5, hasOverrideReduction: true }))).toBe(false);
    // an override reduction alone within 5% effective is fine
    expect(ownDiscountAllowed("MANAGER", true, layers({ discountMmk: 500, hasOverrideReduction: true }))).toBe(true);
  });
  it("never for a cashier or a manager without pos:apply_discount; no discount is always allowed", () => {
    expect(ownDiscountAllowed("CASHIER", true, layers({ discountMmk: 10, cartPct: 1 }))).toBe(false);
    expect(ownDiscountAllowed("MANAGER", false, layers({ discountMmk: 10, cartPct: 1 }))).toBe(false);
    expect(ownDiscountAllowed("CASHIER", false, layers())).toBe(true);
  });
  it("needsShopAdmin is the exact whole-MMK test", () => {
    expect(needsShopAdmin(10_000, 500)).toBe(false);
    expect(needsShopAdmin(10_000, 501)).toBe(true);
    expect(needsShopAdmin(1_050, 53)).toBe(true);
  });
});

describe("overridden line reference price applies the quantity tier (as complete_sale does)", () => {
  const ctx = {
    shopId: "shop-1",
    productUnits: [{ id: "u1", isDefault: true }, { id: "u2", isDefault: false }],
    priceLevels: [{ id: "pl-retail", name: "Retail", isActive: true, isDefault: true, sortOrder: 0 }] as never,
    priceTiers: [
      { id: "t1", productId: "p1", minQty: 10, priceMmk: 4_500, isActive: true, createdAt: "", createdBy: "" },
      { id: "t2", productId: "p1", shopId: "shop-1", minQty: 10, priceMmk: 4_400, isActive: true, createdAt: "", createdBy: "" },
    ],
  };
  const overridden = (over: Partial<CartItem> = {}) =>
    item({ qty: 10, unitPriceMmk: 4_000, priceOverriddenBy: "m-1", priceBeforeOverrideMmk: 5_000, priceLevelId: "pl-retail", ...over });
  it("default unit at the default level: the shop tier for the base quantity", () => {
    expect(tierReferencePrice(ctx)(overridden())).toBe(4_400);
    expect(referenceSubtotalOf([overridden()], tierReferencePrice(ctx))).toBe(44_000);
  });
  it("below the tier minimum, another unit or another level: the recorded price before the override", () => {
    expect(tierReferencePrice(ctx)(overridden({ qty: 9 }))).toBe(5_000);
    expect(tierReferencePrice(ctx)(overridden({ productUnitId: "u2" }))).toBe(5_000);
    expect(tierReferencePrice(ctx)(overridden({ priceLevelId: "pl-wholesale" }))).toBe(5_000);
  });
  it("a line that is not overridden is never re-priced", () => {
    expect(tierReferencePrice(ctx)(item({ qty: 10 }))).toBeUndefined();
  });
});

describe("approvalCovers", () => {
  const approved: DiscountApprovalView = { id: "fa-1", status: "APPROVED", referenceSubtotalMmk: 10_000, discountMmk: 600, expiresAt: null, consumedSaleId: null };
  it("covers exactly this reference and at most its discount", () => {
    expect(approvalCovers(approved, 10_000, 600)).toBe(true);
    expect(approvalCovers(approved, 10_000, 500)).toBe(true);
    expect(approvalCovers(approved, 10_000, 601)).toBe(false);
    expect(approvalCovers(approved, 10_001, 600)).toBe(false);
  });
  it("never a request, a rejection, a used or an expired approval", () => {
    expect(approvalCovers({ ...approved, status: "REQUESTED" }, 10_000, 600)).toBe(false);
    expect(approvalCovers({ ...approved, status: "REJECTED" }, 10_000, 600)).toBe(false);
    expect(approvalCovers({ ...approved, consumedSaleId: "sale-1" }, 10_000, 600)).toBe(false);
    expect(approvalCovers({ ...approved, expiresAt: "2026-10-22T10:00:00Z" }, 10_000, 600, Date.parse("2026-10-22T10:00:01Z"))).toBe(false);
    expect(approvalCovers({ ...approved, expiresAt: "2026-10-22T10:00:00Z" }, 10_000, 600, Date.parse("2026-10-22T09:59:00Z"))).toBe(true);
    expect(approvalCovers(null, 10_000, 600)).toBe(false);
  });
  it("a request describes the cart only while reference and discount are unchanged", () => {
    expect(requestDescribesCart(approved, 10_000, 600)).toBe(true);
    expect(requestDescribesCart(approved, 10_000, 500)).toBe(false);
  });
});
