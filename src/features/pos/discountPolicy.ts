// ----------------------------------------------------------------------
// Step 6 (PDISC-A): discount authorization at the till. Mirrors the server's
// rule (fin_discount_authorize) so the cashier is told BEFORE checkout that a
// discount needs a separate approval; the server decides and refuses the sale
// otherwise (DISCOUNT_APPROVAL_REQUIRED / _INVALID / _OFFLINE). Pure.
//
//   reference = Σ unit price × qty before any discount; a manually overridden
//               line counts at the price the server would have resolved for
//               it (price level AND quantity tier — referencePriceOf) when the
//               cart knows it (the server: max(reference price, overridden))
//   discount  = reference − total (line + cart discounts + overrides below
//               the reference price), total rounded as complete_sale does
//   a MANAGER or ADMIN holding pos:apply_discount may apply on their own
//   (ownDiscountAllowed):
//     - an effective discount of at most 5% (discount × 100 ≤ reference × 5), OR
//     - exactly ONE discount layer of at most 5% (absorbs rounding: 1,050 MMK
//       at 5% → 53 MMK): a cart discount ≤ 5% with no line discount and no
//       override below the reference, OR line discounts each ≤ 5% with no
//       cart discount and no override below the reference.
//   Anyone else (a cashier: any discount > 0), and anything beyond that, needs
//   an approval — by a Shop Admin when discount × 100 > reference × 5.
// ----------------------------------------------------------------------
import type { CartItem, PriceLevel, PriceTier, ProductUnit } from "../../types";
import { getDefaultPriceLevel } from "../pricing/priceLevels";
import { calculateCartTotals } from "./service";

/** The discount layers of one sale (what ownDiscountAllowed looks at). */
export interface DiscountLayers {
  referenceMmk: number;
  discountMmk: number;
  /** The cart-wide discount percentage (0 = none). */
  cartPct: number;
  /** Each line's discount percentage (0 = none). */
  linePcts: readonly number[];
  /** Some line was manually overridden BELOW its reference price. */
  hasOverrideReduction: boolean;
}

const OWN_LIMIT_PCT = 5;
const isManagerRole = (role: string | null | undefined): boolean => role === "MANAGER" || role === "ADMIN";

/** Rule (a): may this seller apply this discount without an approval? Pure; mirrors the server exactly. */
export function ownDiscountAllowed(role: string | null | undefined, canApplyDiscount: boolean, layers: DiscountLayers): boolean {
  const reference = Math.max(0, Math.trunc(layers.referenceMmk));
  const discount = Math.max(0, Math.trunc(layers.discountMmk));
  if (discount <= 0) return true;
  if (!isManagerRole(role) || !canApplyDiscount) return false;
  if (discount * 100 <= reference * OWN_LIMIT_PCT) return true;
  if (layers.hasOverrideReduction) return false;
  const cart = Number(layers.cartPct) || 0;
  const lines = layers.linePcts.map((p) => Number(p) || 0);
  const anyLine = lines.some((p) => p > 0);
  const cartOnly = cart > 0 && cart <= OWN_LIMIT_PCT && !anyLine;
  const linesOnly = cart === 0 && anyLine && lines.every((p) => p >= 0 && p <= OWN_LIMIT_PCT);
  return cartOnly || linesOnly;
}

/** Above 5% of the reference (whole MMK, never a rounded percentage): an approval by a Shop Admin. */
export const needsShopAdmin = (referenceMmk: number, discountMmk: number): boolean =>
  Math.max(0, Math.trunc(discountMmk)) * 100 > Math.max(0, Math.trunc(referenceMmk)) * OWN_LIMIT_PCT;

export interface DiscountPolicyInput {
  role: string | null | undefined;
  /** The seller holds pos:apply_discount (role defaults + granted − revoked). */
  canApplyDiscount: boolean;
  referenceSubtotalMmk: number;
  /** The sale total after line and cart discounts (calculateCartTotals). */
  totalMmk: number;
  /** The layers (cart / line percentages, override reduction). Omitted: none known — only the 5% test applies. */
  cartPct?: number;
  linePcts?: readonly number[];
  hasOverrideReduction?: boolean;
}

export interface DiscountPolicy {
  discountMmk: number;
  /** Percentage of the reference subtotal (display only; the rule compares in whole MMK). */
  pct: number;
  needsApproval: boolean;
  needsShopAdmin: boolean;
}

export function discountPolicy({ role, canApplyDiscount, referenceSubtotalMmk, totalMmk, cartPct, linePcts, hasOverrideReduction }: DiscountPolicyInput): DiscountPolicy {
  const reference = Math.max(0, Math.trunc(referenceSubtotalMmk));
  const discountMmk = Math.max(0, reference - Math.trunc(totalMmk));
  // layers unknown: treated as an override reduction (only the effective 5% test can allow it)
  const own = ownDiscountAllowed(role, canApplyDiscount, {
    referenceMmk: reference, discountMmk, cartPct: cartPct ?? 0, linePcts: linePcts ?? [],
    hasOverrideReduction: hasOverrideReduction ?? (cartPct === undefined && linePcts === undefined),
  });
  return {
    discountMmk,
    pct: reference > 0 ? (discountMmk * 100) / reference : 0,
    needsApproval: discountMmk > 0 && !own,
    needsShopAdmin: needsShopAdmin(reference, discountMmk),
  };
}

/** What the server would resolve for an overridden line before the override (price level AND quantity tier).
 *  undefined = not known here (the line counts at its recorded price before the override, else its own price). */
export type ReferencePriceOf = (item: CartItem) => number | undefined;

/**
 * complete_sale's tier rule, for an overridden line's reference price: a non-open-price line of the product's DEFAULT
 * unit at the DEFAULT price level takes the active quantity tier for its base quantity (a shop tier before a global
 * one, then the highest minimum), else the level price it resolved to.
 */
export function tierReferencePrice(
  ctx: { shopId: string | null | undefined; productUnits?: readonly Pick<ProductUnit, "id" | "isDefault">[]; priceLevels?: readonly PriceLevel[]; priceTiers?: readonly PriceTier[] },
): ReferencePriceOf {
  const defaultLevelId = getDefaultPriceLevel([...(ctx.priceLevels ?? [])])?.id ?? null;
  return (item) => {
    if (!item.priceOverriddenBy || typeof item.priceBeforeOverrideMmk !== "number" || item.isOpenPrice) return undefined;
    const unit = ctx.productUnits?.find((u) => u.id === item.productUnitId);
    if (!unit?.isDefault || !defaultLevelId || item.priceLevelId !== defaultLevelId) return item.priceBeforeOverrideMmk;
    const baseQty = item.qty * (item.unitBaseQuantity || 1);
    const tier = (ctx.priceTiers ?? [])
      .filter((t) => t.productId === item.productId && t.isActive && (!t.shopId || t.shopId === ctx.shopId))
      .filter((t) => baseQty >= t.minQty && (t.maxQty == null || baseQty <= t.maxQty))
      .sort((a, b) => (a.shopId === ctx.shopId && a.shopId ? 0 : 1) - (b.shopId === ctx.shopId && b.shopId ? 0 : 1) || b.minQty - a.minQty)[0];
    return tier ? tier.priceMmk : item.priceBeforeOverrideMmk;
  };
}

/** One cart line at its reference price: a manual override below the price before it counts as a discount. */
export const referenceUnitPrice = (item: CartItem, referencePriceOf?: ReferencePriceOf): number => {
  if (!item.priceOverriddenBy) return item.unitPriceMmk;
  const before = referencePriceOf?.(item) ?? item.priceBeforeOverrideMmk;
  return typeof before === "number" ? Math.max(before, item.unitPriceMmk) : item.unitPriceMmk;
};

/** The cart's reference subtotal (before any discount or manual price reduction). */
export const referenceSubtotalOf = (items: readonly CartItem[], referencePriceOf?: ReferencePriceOf): number =>
  items.reduce((sum, item) => sum + referenceUnitPrice(item, referencePriceOf) * item.qty, 0);

/** Everything the till needs for one cart. */
export function cartDiscountPolicy(
  items: CartItem[], cartDiscountPct: number, seller: { role: string | null | undefined; canApplyDiscount: boolean },
  referencePriceOf?: ReferencePriceOf,
): DiscountPolicy & { referenceSubtotalMmk: number; totalMmk: number } {
  const referenceSubtotalMmk = referenceSubtotalOf(items, referencePriceOf);
  const { total } = calculateCartTotals(items, cartDiscountPct);
  return {
    ...discountPolicy({
      ...seller, referenceSubtotalMmk, totalMmk: total,
      cartPct: cartDiscountPct || 0,
      linePcts: items.map((i) => i.itemDiscountPct ?? 0),
      hasOverrideReduction: items.some((i) => referenceUnitPrice(i, referencePriceOf) > i.unitPriceMmk),
    }),
    referenceSubtotalMmk, totalMmk: total,
  };
}

/** What the till knows about its discount request. */
export interface DiscountApprovalView {
  id: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  referenceSubtotalMmk: number;
  discountMmk: number;
  expiresAt: string | null;
  consumedSaleId: string | null;
}

/**
 * Does this approval cover the cart as it is now? The server's rule: APPROVED, unexpired, unused, for EXACTLY this
 * reference subtotal and at least this discount (the seller and shop are checked by the server).
 */
export function approvalCovers(approval: DiscountApprovalView | null | undefined, referenceSubtotalMmk: number, discountMmk: number, now = Date.now()): boolean {
  if (!approval || approval.status !== "APPROVED" || approval.consumedSaleId) return false;
  if (approval.expiresAt && Date.parse(approval.expiresAt) <= now) return false;
  return approval.referenceSubtotalMmk === referenceSubtotalMmk && approval.discountMmk >= discountMmk;
}

/** The request still describes this cart (polling continues only while it does). */
export const requestDescribesCart = (approval: DiscountApprovalView | null | undefined, referenceSubtotalMmk: number, discountMmk: number): boolean =>
  !!approval && approval.referenceSubtotalMmk === referenceSubtotalMmk && approval.discountMmk === discountMmk;
