import type { Shop, User } from "../types";

export const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

/** Plain grouped integer, no currency label (receipt/voucher item rows show
 *  the currency once in the totals block via `formatMmk`). */
export const formatAmount = (value: number) => value.toLocaleString("en-US");

export const formatMmk = (value: number) => `MMK ${formatAmount(value)}`;

export const formatDateTime = (value: string | number | Date) =>
  new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const formatDate = (value: string | number | Date) =>
  new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

// Resolve the shop the current user is acting in.
//
// ADMIN is global: an admin only has a shop context when they have
// explicitly picked one via the shop switcher (or an older session
// persisted one in localStorage). We deliberately DO NOT fall back to
// `shops[0]` for admins — silently operating on "whichever shop happened
// to load first" hides the missing-selection state from shop-scoped
// workflows (POS, shifts, inventory adjustment, purchases, transfers),
// which all then need to render a blocked state instead.
//
// MANAGER / CASHIER / BUYER are bound to their assigned `shopId`; if it
// is missing the trigger in migration 020 has already rejected the row,
// so this branch returning "" should be a vanishingly rare edge case.
//
// Callers must treat an empty string as "no shop selected" and gate the
// shop-scoped UI behind that check. They MUST NOT auto-pick a shop here.
export const getEffectiveShopId = (user: User | null | undefined, appShopId: string | null, shops: Shop[]): string => {
  if (!user) return "";
  if (user.role === "ADMIN") {
    if (appShopId && shops.some((s) => s.id === appShopId)) return appShopId;
    if (user.shopId && shops.some((s) => s.id === user.shopId)) return user.shopId;
    return "";
  }
  return user.shopId ?? "";
};

export const toNumber = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Normalize a free-text amount field to a clean non-negative integer string.
 *
 * - Strips any non-digit (commas, spaces, currency symbols, etc.) so a paste
 *   of "2,900" becomes "2900".
 * - Trims leading zeros so "02900" becomes "2900".
 * - Collapses all-zero input ("000") to a single "0" so the field never sits
 *   on a meaningless padded zero.
 * - Returns "" when the caller's input was empty — the caller decides what to
 *   show: the editing UI may keep "" visible while focused and reset to "0"
 *   on blur.
 *
 * This is the source-of-truth sanitizer for any cashier-facing amount field.
 */
export const normalizeAmountInput = (raw: string): string => {
  const digits = raw.replace(/\D/g, "");
  if (digits === "") return "";
  const trimmed = digits.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
};
