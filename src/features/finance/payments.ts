// ----------------------------------------------------------------------
// Split / mixed payments (provisional backend PFIN-D): the server's rules,
// mirrored so the till can refuse early with a clear message. Pure (no I/O):
// the server checks every one of them again (fin_payments_canonical and the
// sales trigger) and is the only authority.
// ----------------------------------------------------------------------
export const SPLIT_METHODS = ["CASH", "BANK_TRANSFER", "MOBILE_WALLET", "CARD", "OTHER"] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];
export const MAX_PAYMENTS = 10;

export interface PaymentPart {
  method: SplitMethod;
  /** What this method pays towards the total. */
  amountMmk: number;
  /** Handed over; above amountMmk only for cash (the change). Defaults to amountMmk. */
  tenderedMmk?: number;
  /** Transfer / wallet / card reference (up to 120 characters). */
  reference?: string | null;
}

export type PaymentProblem =
  | { code: "COUNT" }
  | { code: "DUPLICATE_METHOD"; method: SplitMethod }
  | { code: "AMOUNT"; method: SplitMethod }
  | { code: "TENDER_BELOW_AMOUNT"; method: SplitMethod }
  | { code: "NON_CASH_CHANGE"; method: SplitMethod }
  | { code: "REFERENCE_TOO_LONG"; method: SplitMethod }
  | { code: "TOTAL_MISMATCH"; sumMmk: number; totalMmk: number };

export interface PaymentPlan {
  /** Canonical parts as sent (tenderedMmk always present). */
  payments: CanonicalPart[];
  /** complete_sale's own arguments must say exactly this (the server checks). */
  legacyMethod: "CASH" | "OTHER";
  paidMmk: number;
  changeMmk: number;
  cashMmk: number;
}
export interface CanonicalPart { method: SplitMethod; amountMmk: number; tenderedMmk: number; reference: string | null }

const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** The server's rules (fin_payments_canonical + the sales trigger), checked locally. */
export function planPayments(parts: PaymentPart[], totalMmk: number): { ok: true; plan: PaymentPlan } | { ok: false; problem: PaymentProblem } {
  if (parts.length < 1 || parts.length > MAX_PAYMENTS) return { ok: false, problem: { code: "COUNT" } };
  const seen = new Set<SplitMethod>();
  const payments: CanonicalPart[] = [];
  let sum = 0, paid = 0, cash = 0;
  for (const p of parts) {
    if (!SPLIT_METHODS.includes(p.method)) return { ok: false, problem: { code: "COUNT" } };
    if (seen.has(p.method)) return { ok: false, problem: { code: "DUPLICATE_METHOD", method: p.method } };
    seen.add(p.method);
    const tendered = p.tenderedMmk ?? p.amountMmk;
    if (!whole(p.amountMmk) || p.amountMmk <= 0 || !whole(tendered)) return { ok: false, problem: { code: "AMOUNT", method: p.method } };
    if (tendered < p.amountMmk) return { ok: false, problem: { code: "TENDER_BELOW_AMOUNT", method: p.method } };
    if (p.method !== "CASH" && tendered !== p.amountMmk) return { ok: false, problem: { code: "NON_CASH_CHANGE", method: p.method } };
    const reference = p.reference?.trim() ? p.reference.trim() : null;
    if (reference && reference.length > 120) return { ok: false, problem: { code: "REFERENCE_TOO_LONG", method: p.method } };
    payments.push({ method: p.method, amountMmk: p.amountMmk, tenderedMmk: tendered, reference });
    sum += p.amountMmk; paid += tendered;
    if (p.method === "CASH") cash += p.amountMmk;
  }
  if (sum !== totalMmk) return { ok: false, problem: { code: "TOTAL_MISMATCH", sumMmk: sum, totalMmk } };
  return {
    ok: true,
    plan: { payments, legacyMethod: seen.has("CASH") ? "CASH" : "OTHER", paidMmk: paid, changeMmk: paid - totalMmk, cashMmk: cash },
  };
}

/** Cash a sale put in the drawer: its CASH part when the split is known, the legacy rule otherwise. */
export function cashPartOf(sale: { paymentMethod: string; totalMmk: number; payments?: { method: string; amountMmk: number }[] }): number {
  if (sale.payments && sale.payments.length > 0) return sale.payments.filter((p) => p.method === "CASH").reduce((s, p) => s + p.amountMmk, 0);
  return sale.paymentMethod === "CASH" ? sale.totalMmk : 0;
}

/**
 * Step 6 (PFIN-F, f10): one payment by one method. Cash may be received above the total (the change); a non-cash
 * payment (OTHER) is recorded for EXACTLY the amount due — no change is ever given from a non-cash payment (the server
 * refuses it with FIN_NON_CASH_CHANGE).
 */
export function singlePayment(method: "CASH" | "OTHER", receivedMmk: number, totalMmk: number): { paidMmk: number; changeMmk: number; ok: boolean } {
  if (method !== "CASH") return { paidMmk: totalMmk, changeMmk: 0, ok: true };
  return { paidMmk: receivedMmk, changeMmk: Math.max(0, receivedMmk - totalMmk), ok: receivedMmk >= totalMmk };
}
