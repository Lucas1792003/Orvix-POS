// ----------------------------------------------------------------------
// Financial completion (provisional backend PFIN-D / PFIN-E, Step 4 Part A):
// split and mixed payments, cash movements in / out, the authoritative
// expected cash of a shift, and refund lines.
//
// The server decides. This module mirrors the server's rules only so the
// till can refuse early with a clear message; every figure shown as
// "expected cash" comes from fin_shift_cash_summary, never from the local
// cache. When the server does not have PFIN-D (an 085 / 086 / 087 server
// without it) the probe says so and the till keeps the single-payment,
// legacy flow — nothing is sent that the server cannot verify.
// ----------------------------------------------------------------------
import { supabase } from "../../lib/supabase";
import { localDb } from "../../lib/localDb";
import { currentBackendOrigin } from "../../lib/backendOrigin";
import { runRequest } from "../../stores/data/idempotentRpc";
import { toFinResult, type FinResult } from "../reports/finReports";

export { SPLIT_METHODS, MAX_PAYMENTS, planPayments, cashPartOf } from "./payments";
export type { SplitMethod, PaymentPart, PaymentProblem, PaymentPlan, CanonicalPart } from "./payments";
import { SPLIT_METHODS, type SplitMethod, type CanonicalPart } from "./payments";

// ---------------------------------------------------------------- capabilities
export interface FinCapabilities {
  splitPayments: boolean;
  cashMovements: boolean;
  refundLines: boolean;
  paymentMethods: SplitMethod[];
}
export const NO_FIN_CAPABILITIES: FinCapabilities = { splitPayments: false, cashMovements: false, refundLines: false, paymentMethods: [] };

const capKey = (origin: string) => `fin:capabilities:${origin}`;
let memo: { origin: string; caps: FinCapabilities } | null = null;

/** Tests only. */
export function resetFinCapabilitiesForTests(): void { memo = null; }

function parseCaps(raw: unknown): FinCapabilities {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (d.protocol !== "orvix-fin-capabilities-v1") return NO_FIN_CAPABILITIES;
  const methods = Array.isArray(d.paymentMethods) ? d.paymentMethods.filter((m): m is SplitMethod => SPLIT_METHODS.includes(m as SplitMethod)) : [];
  return { splitPayments: d.splitPayments === true, cashMovements: d.cashMovements === true, refundLines: d.refundLines === true, paymentMethods: methods };
}

/**
 * What this server can do. Asked while connected; the last answer for THIS backend is
 * remembered (a till that goes offline keeps offering what its server supports — the
 * queued sale is verified there anyway). A failed probe never upgrades anything: no
 * answer means the last known answer, or none.
 */
export async function finCapabilities(options: { refresh?: boolean; origin?: string } = {}): Promise<FinCapabilities> {
  const origin = options.origin ?? currentBackendOrigin();
  if (memo?.origin === origin && !options.refresh) return memo.caps;
  let known: FinCapabilities = NO_FIN_CAPABILITIES;
  try {
    const row = await localDb.syncState.get(capKey(origin));
    if (row?.value) known = parseCaps(JSON.parse(row.value));
  } catch { /* unreadable: nothing known */ }
  if (typeof navigator === "undefined" || navigator.onLine !== false) {
    const outcome = await runRequest(supabase.rpc("fin_capabilities"), "fin_capabilities", 10_000);
    const res = toFinResult(outcome, parseCaps);
    if (res.status === "ok") {
      known = res.data;
      await localDb.syncState.put({ key: capKey(origin), value: JSON.stringify({ protocol: "orvix-fin-capabilities-v1", ...known }), updatedAt: new Date().toISOString() }).catch(() => undefined);
    } else if (res.status === "unavailable" && res.reason === "NOT_INSTALLED") {
      // the server answered that it has no PFIN-D: forget an older answer (e.g. a restored backup)
      known = NO_FIN_CAPABILITIES;
      await localDb.syncState.delete(capKey(origin)).catch(() => undefined);
    }
  }
  memo = { origin, caps: known };
  return known;
}

/** The last known answer, without asking (for render paths). */
export function knownFinCapabilities(origin = currentBackendOrigin()): FinCapabilities {
  return memo?.origin === origin ? memo.caps : NO_FIN_CAPABILITIES;
}

// ---------------------------------------------------------------- shift cash
export const CASH_MOVEMENT_KINDS = ["FLOAT_IN", "PAY_IN", "PAY_OUT", "DEPOSIT_OUT", "CORRECTION_IN", "CORRECTION_OUT"] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number] | "REVERSAL";
/** P-8 default (owner decision pending): every outflow, correction and reversal needs shift:manage_all. */
export const MANAGER_ONLY_KINDS = new Set<CashMovementKind>(["PAY_OUT", "DEPOSIT_OUT", "CORRECTION_IN", "CORRECTION_OUT", "REVERSAL"]);

export interface CashMovement {
  id: string;
  kind: CashMovementKind;
  direction: 1 | -1;
  amountMmk: number;
  reason: string;
  createdBy: string;
  approvedBy: string | null;
  reversesId: string | null;
  createdAt: string;
}

export interface ShiftCashSummary {
  shiftId: string;
  openingCashMmk: number;
  cashSalesMmk: number;
  cashRefundsMmk: number;
  movementsInMmk: number;
  movementsOutMmk: number;
  expectedCashMmk: number;
  movements: CashMovement[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`malformed shift cash: ${what}`);
  return v;
};

export function parseShiftCashSummary(raw: unknown): ShiftCashSummary {
  if (!isObj(raw) || typeof raw.shiftId !== "string") throw new Error("malformed shift cash");
  const movements = Array.isArray(raw.movements) ? raw.movements.filter(isObj).map((m): CashMovement => ({
    id: String(m.id), kind: String(m.kind) as CashMovementKind, direction: m.direction === -1 ? -1 : 1,
    amountMmk: n(m.amountMmk, "movement.amountMmk"), reason: String(m.reason ?? ""), createdBy: String(m.createdBy ?? ""),
    approvedBy: typeof m.approvedBy === "string" ? m.approvedBy : null, reversesId: typeof m.reversesId === "string" ? m.reversesId : null,
    createdAt: String(m.createdAt ?? ""),
  })) : [];
  return {
    shiftId: raw.shiftId,
    openingCashMmk: n(raw.openingCashMmk, "openingCashMmk"),
    cashSalesMmk: n(raw.cashSalesMmk, "cashSalesMmk"),
    cashRefundsMmk: n(raw.cashRefundsMmk, "cashRefundsMmk"),
    movementsInMmk: n(raw.movementsInMmk, "movementsInMmk"),
    movementsOutMmk: n(raw.movementsOutMmk, "movementsOutMmk"),
    expectedCashMmk: n(raw.expectedCashMmk, "expectedCashMmk"),
    movements,
  };
}

/** Authoritative expected cash (server). No local fallback: unavailable is shown as unavailable. */
export async function fetchShiftCashSummary(shiftId: string, timeoutMs = 20_000): Promise<FinResult<ShiftCashSummary>> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { status: "unavailable", reason: "OFFLINE", message: "offline" };
  const outcome = await runRequest(supabase.rpc("fin_shift_cash_summary", { p_shift_id: shiftId }), "fin_shift_cash_summary", timeoutMs);
  return toFinResult(outcome, parseShiftCashSummary);
}

/** Payment lines of one sale as the server recorded them (online read; RLS = the sale's visibility). */
export async function fetchSalePayments(saleId: string, timeoutMs = 15_000): Promise<FinResult<CanonicalPart[]>> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { status: "unavailable", reason: "OFFLINE", message: "offline" };
  const outcome = await runRequest(
    supabase.from("sale_payments").select("method,amount_mmk,tendered_mmk,reference,seq").eq("sale_id", saleId).order("seq"),
    "sale_payments", timeoutMs,
  );
  if (outcome.error && /sale_payments|PGRST205|42P01/.test(`${outcome.error.code ?? ""} ${outcome.error.message}`)) {
    return { status: "unavailable", reason: "NOT_INSTALLED", message: outcome.error.message };
  }
  return toFinResult(outcome, (raw) => {
    if (!Array.isArray(raw)) throw new Error("malformed payments");
    return raw.filter(isObj).map((r) => ({
      method: String(r.method) as SplitMethod, amountMmk: n(r.amount_mmk, "amount"), tenderedMmk: n(r.tendered_mmk, "tendered"),
      reference: typeof r.reference === "string" ? r.reference : null,
    }));
  });
}
