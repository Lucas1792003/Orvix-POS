// ----------------------------------------------------------------------
// Server financial reports (provisional backend PFIN-B:
// fin_report_summary / fin_shift_reconciliation).
//
// These are the authoritative money figures. They are computed on the
// server over the whole history (never the 1,000-sale client cache), on
// Asia/Yangon business days, net of every approved refund that affects the
// caller's sales scope, with COGS from the sale's own cost snapshot only.
//
// There is deliberately NO client fallback: when the server cannot answer
// (offline, timeout, recovery hold, reports not installed) the caller gets
// an explicit `unavailable` state and must show it, never a cached total.
// ----------------------------------------------------------------------
import { supabase } from "../../lib/supabase";
import { runRequest, type RpcOutcome } from "../../stores/data/idempotentRpc";

/** Sale date: sales performance / cohorts. Approval date: cash flow. */
export type RefundBasis = "SALE_DATE" | "APPROVAL_DATE";

export const REPORT_TIMEOUT_MS = 35_000;

export const BASIS_LABEL: Record<RefundBasis, string> = {
  SALE_DATE: "Sales performance — refunds and voids counted on the day of the original sale",
  APPROVAL_DATE: "Cash flow — refunds and voids counted on the day they were approved",
};

export const BASIS_SHORT: Record<RefundBasis, string> = {
  SALE_DATE: "by sale date",
  APPROVAL_DATE: "by approval date",
};
/** Server limits (PFIN-B): one shop up to 367 days, all shops up to 93. */
export const MAX_SHOP_RANGE_DAYS = 367;
export const MAX_ORG_RANGE_DAYS = 93;

export interface FinDay {
  date: string;
  saleCount: number;
  grossSalesMmk: number;
  refundCount: number;
  refundMmk: number;
  voidCount: number;
  voidMmk: number;
  netRevenueMmk: number;
  /** null: cost not visible to the caller (report:shop_profit). */
  cogsMmk: number | null;
  cogsComplete: boolean | null;
  /** null: not visible, or cost incomplete for that day. */
  grossProfitMmk: number | null;
}

export interface FinMethod {
  method: string;
  grossSalesMmk: number;
  refundMmk: number;
  voidMmk: number;
  netMmk: number;
}

export interface FinReportSummary {
  basis: {
    timezone: string;
    refundBasis: RefundBasis;
    from: string;
    to: string;
    asOf: string;
    refundMethodAssumption: string;
  };
  scope: { level: "ORG" | "SHOP" | "OWN"; shopIds: string[]; profitVisible: boolean };
  totals: {
    saleCount: number;
    grossSalesMmk: number;
    refundCount: number;
    refundMmk: number;
    voidCount: number;
    voidMmk: number;
    netRevenueMmk: number;
    cogsMmk: number | null;
    cogsComplete: boolean | null;
    grossProfitMmk: number | null;
    linesMissingCost: number | null;
    adjustmentsMissingCost: number | null;
  };
  excludedVoids: { count: number; amountMmk: number } | null;
  undatedAdjustments: { count: number; amountMmk: number; refundCount: number; voidCount: number };
  pendingRequests: { count: number; amountMmk: number; unparseable: number };
  byDay: FinDay[];
  byPaymentMethod: FinMethod[];
  supplierPayments: { count: number; paidMmk: number; cashPaidMmk: number; voidedMmk: number } | null;
  evidence: { refundsAboveNetPaid: number; salesRefundedAboveTotal: number; unparseableApprovedRefunds: number };
}

export interface FinPayoutItem {
  kind: "REFUND" | "VOID";
  id: string;
  saleId: string;
  receiptNo: string | null;
  approvedAt: string | null;
  amountMmk: number;
  saleShiftId?: string;
}

export interface FinPayoutGroup {
  count: number;
  amountMmk: number;
  /** null when withheld from the caller (other cashiers' details). */
  items: FinPayoutItem[] | null;
}

export interface FinShiftReconciliation {
  shift: {
    id: string;
    shopId: string;
    cashierId: string;
    status: "OPEN" | "CLOSED";
    startedAt: string;
    endedAt: string | null;
    closeRecordedAt: string | null;
    closeTimeSource: "SERVER_LEDGER" | "ENDED_AT_ONLY" | null;
    openingCashMmk: number;
    closingCashMmk: number | null;
    storedExpectedCashMmk: number | null;
    storedVarianceMmk: number | null;
    varianceReason: string | null;
  };
  cashSales: { count: number; amountMmk: number };
  nonCashSales: { method: string; count: number; amountMmk: number }[];
  /** Deducted: payouts of this shift's cash sales approved before the close ran. */
  attributedPayouts: { count: number; amountMmk: number; refundMmk: number; voidMmk: number };
  /** Not deducted, unassigned: close time unknown, may or may not have been deducted. */
  closeWindowPayouts: FinPayoutGroup;
  /** Not deducted, unassigned: approved after the close; the paying drawer is not recorded. */
  afterClosePayouts: FinPayoutGroup;
  /** Not deducted, unassigned: no server approval time exists. */
  unknownTimePayouts: FinPayoutGroup;
  /** Other shifts' cash payouts approved while this shift was open (candidates; null when withheld). */
  crossShiftPayoutsDuringShift: FinPayoutGroup | null;
  supplierCashPaymentsDuringShift: { count: number; amountMmk: number } | null;
  cashMovements: { recorded: boolean; reason: string };
  evidenceExpectedCashMmk: number;
  evidenceVarianceMmk: number | null;
  storedMatchesEvidence: boolean | null;
  storedMatchesEvidenceIfCloseWindowDeducted: boolean | null;
  storedMatchesEvidenceIfUnknownTimeDeducted: boolean | null;
  asOf: string;
}

/** Why the server cannot answer right now. Never a reason to show cached figures. */
export type UnavailableReason =
  | "OFFLINE"         // nothing reached the server
  | "TIMEOUT"         // no answer in time
  | "NOT_INSTALLED"   // the server does not have the report functions yet
  | "RECOVERY"        // 087 recovery hold / maintenance listener
  | "AUTH"            // the sign-in expired or was refused: sign in again
  | "SERVER";         // a temporary server or gateway failure

export type FinResult<T> =
  | { status: "ok"; data: T }
  | { status: "unavailable"; reason: UnavailableReason; message: string }
  | { status: "forbidden"; message: string }
  | { status: "invalid"; message: string }      // range / argument refused by the server
  | { status: "error"; message: string };       // anything else, incl. a malformed reply

// ---------------------------------------------------------------- parsing
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const req = (v: unknown, what: string): number => {
  const n = num(v);
  if (n === null) throw new Error(`malformed report: ${what}`);
  return n;
};
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const optBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new Error(`malformed report: ${what}`);
  return v;
};
const optStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

const parseDay = (d: unknown): FinDay => {
  if (!isObj(d)) throw new Error("malformed report: byDay");
  return {
    date: str(d.date, "byDay.date"),
    saleCount: req(d.saleCount, "byDay.saleCount"),
    grossSalesMmk: req(d.grossSalesMmk, "byDay.grossSalesMmk"),
    refundCount: num(d.refundCount) ?? 0,
    refundMmk: req(d.refundMmk, "byDay.refundMmk"),
    voidCount: num(d.voidCount) ?? 0,
    voidMmk: req(d.voidMmk, "byDay.voidMmk"),
    netRevenueMmk: req(d.netRevenueMmk, "byDay.netRevenueMmk"),
    cogsMmk: optNum(d.cogsMmk),
    cogsComplete: optBool(d.cogsComplete),
    grossProfitMmk: optNum(d.grossProfitMmk),
  };
};

export function parseFinReportSummary(raw: unknown): FinReportSummary {
  if (!isObj(raw) || !isObj(raw.basis) || !isObj(raw.scope) || !isObj(raw.totals)) {
    throw new Error("malformed report: missing sections");
  }
  const b = raw.basis, s = raw.scope, t = raw.totals;
  const basis = str(b.refundBasis, "basis.refundBasis");
  if (basis !== "SALE_DATE" && basis !== "APPROVAL_DATE") throw new Error("malformed report: refundBasis");
  const level = str(s.level, "scope.level");
  if (level !== "ORG" && level !== "SHOP" && level !== "OWN") throw new Error("malformed report: scope.level");
  const und = isObj(raw.undatedAdjustments) ? raw.undatedAdjustments : {};
  const pend = isObj(raw.pendingRequests) ? raw.pendingRequests : {};
  const ev = isObj(raw.evidence) ? raw.evidence : {};
  const sup = isObj(raw.supplierPayments) ? raw.supplierPayments : null;
  const exv = isObj(raw.excludedVoids) ? raw.excludedVoids : null;
  if (!Array.isArray(raw.byDay) || !Array.isArray(raw.byPaymentMethod)) throw new Error("malformed report: series");
  return {
    basis: {
      timezone: str(b.timezone, "basis.timezone"),
      refundBasis: basis,
      from: str(b.from, "basis.from"),
      to: str(b.to, "basis.to"),
      asOf: str(b.asOf, "basis.asOf"),
      refundMethodAssumption: optStr(b.refundMethodAssumption) ?? "ORIGINAL_SALE_METHOD",
    },
    scope: {
      level,
      shopIds: Array.isArray(s.shopIds) ? s.shopIds.filter((x): x is string => typeof x === "string") : [],
      profitVisible: s.profitVisible === true,
    },
    totals: {
      saleCount: req(t.saleCount, "totals.saleCount"),
      grossSalesMmk: req(t.grossSalesMmk, "totals.grossSalesMmk"),
      refundCount: req(t.refundCount, "totals.refundCount"),
      refundMmk: req(t.refundMmk, "totals.refundMmk"),
      voidCount: req(t.voidCount, "totals.voidCount"),
      voidMmk: req(t.voidMmk, "totals.voidMmk"),
      netRevenueMmk: req(t.netRevenueMmk, "totals.netRevenueMmk"),
      cogsMmk: optNum(t.cogsMmk),
      cogsComplete: optBool(t.cogsComplete),
      grossProfitMmk: optNum(t.grossProfitMmk),
      linesMissingCost: optNum(t.linesMissingCost),
      adjustmentsMissingCost: optNum(t.adjustmentsMissingCost),
    },
    excludedVoids: exv ? { count: num(exv.count) ?? 0, amountMmk: num(exv.amountMmk) ?? 0 } : null,
    undatedAdjustments: {
      count: num(und.count) ?? 0,
      amountMmk: num(und.amountMmk) ?? 0,
      refundCount: num(und.refundCount) ?? 0,
      voidCount: num(und.voidCount) ?? 0,
    },
    pendingRequests: { count: num(pend.count) ?? 0, amountMmk: num(pend.amountMmk) ?? 0, unparseable: num(pend.unparseable) ?? 0 },
    byDay: raw.byDay.map(parseDay),
    byPaymentMethod: raw.byPaymentMethod.map((m) => {
      if (!isObj(m)) throw new Error("malformed report: byPaymentMethod");
      return {
        method: str(m.method, "method"),
        grossSalesMmk: req(m.grossSalesMmk, "method.gross"),
        refundMmk: req(m.refundMmk, "method.refund"),
        voidMmk: req(m.voidMmk, "method.void"),
        netMmk: req(m.netMmk, "method.net"),
      };
    }),
    supplierPayments: sup
      ? { count: num(sup.count) ?? 0, paidMmk: num(sup.paidMmk) ?? 0, cashPaidMmk: num(sup.cashPaidMmk) ?? 0, voidedMmk: num(sup.voidedMmk) ?? 0 }
      : null,
    evidence: {
      refundsAboveNetPaid: num(ev.refundsAboveNetPaid) ?? 0,
      salesRefundedAboveTotal: num(ev.salesRefundedAboveTotal) ?? 0,
      unparseableApprovedRefunds: num(ev.unparseableApprovedRefunds) ?? 0,
    },
  };
}

const parseGroup = (g: unknown, what: string): FinPayoutGroup => {
  if (!isObj(g)) throw new Error(`malformed reconciliation: ${what}`);
  const items = Array.isArray(g.items)
    ? g.items.filter(isObj).map((i) => ({
        kind: (i.kind === "VOID" ? "VOID" : "REFUND") as FinPayoutItem["kind"],
        id: str(i.id, `${what}.id`),
        saleId: str(i.saleId, `${what}.saleId`),
        receiptNo: optStr(i.receiptNo),
        approvedAt: optStr(i.approvedAt),
        amountMmk: req(i.amountMmk, `${what}.amountMmk`),
        ...(typeof i.saleShiftId === "string" ? { saleShiftId: i.saleShiftId } : {}),
      }))
    : null;
  return { count: req(g.count, `${what}.count`), amountMmk: req(g.amountMmk, `${what}.amountMmk`), items };
};

export function parseFinShiftReconciliation(raw: unknown): FinShiftReconciliation {
  if (!isObj(raw) || !isObj(raw.shift) || !isObj(raw.cashSales) || !isObj(raw.attributedPayouts)) {
    throw new Error("malformed reconciliation: missing sections");
  }
  const sh = raw.shift, a = raw.attributedPayouts;
  const status = str(sh.status, "shift.status");
  if (status !== "OPEN" && status !== "CLOSED") throw new Error("malformed reconciliation: status");
  const src = optStr(sh.closeTimeSource);
  return {
    shift: {
      id: str(sh.id, "shift.id"),
      shopId: str(sh.shopId, "shift.shopId"),
      cashierId: str(sh.cashierId, "shift.cashierId"),
      status,
      startedAt: str(sh.startedAt, "shift.startedAt"),
      endedAt: optStr(sh.endedAt),
      closeRecordedAt: optStr(sh.closeRecordedAt),
      closeTimeSource: src === "SERVER_LEDGER" || src === "ENDED_AT_ONLY" ? src : null,
      openingCashMmk: req(sh.openingCashMmk, "shift.openingCashMmk"),
      closingCashMmk: optNum(sh.closingCashMmk),
      storedExpectedCashMmk: optNum(sh.storedExpectedCashMmk),
      storedVarianceMmk: optNum(sh.storedVarianceMmk),
      varianceReason: optStr(sh.varianceReason),
    },
    cashSales: { count: req(raw.cashSales.count, "cashSales.count"), amountMmk: req(raw.cashSales.amountMmk, "cashSales.amountMmk") },
    nonCashSales: Array.isArray(raw.nonCashSales)
      ? raw.nonCashSales.filter(isObj).map((m) => ({ method: str(m.method, "nonCash.method"), count: num(m.count) ?? 0, amountMmk: num(m.amountMmk) ?? 0 }))
      : [],
    attributedPayouts: {
      count: req(a.count, "attributed.count"),
      amountMmk: req(a.amountMmk, "attributed.amountMmk"),
      refundMmk: num(a.refundMmk) ?? 0,
      voidMmk: num(a.voidMmk) ?? 0,
    },
    closeWindowPayouts: parseGroup(raw.closeWindowPayouts, "closeWindowPayouts"),
    afterClosePayouts: parseGroup(raw.afterClosePayouts, "afterClosePayouts"),
    unknownTimePayouts: parseGroup(raw.unknownTimePayouts, "unknownTimePayouts"),
    crossShiftPayoutsDuringShift: isObj(raw.crossShiftPayoutsDuringShift)
      ? parseGroup(raw.crossShiftPayoutsDuringShift, "crossShiftPayoutsDuringShift")
      : null,
    supplierCashPaymentsDuringShift: isObj(raw.supplierCashPaymentsDuringShift)
      ? { count: num(raw.supplierCashPaymentsDuringShift.count) ?? 0, amountMmk: num(raw.supplierCashPaymentsDuringShift.amountMmk) ?? 0 }
      : null,
    cashMovements: isObj(raw.cashMovements)
      ? { recorded: raw.cashMovements.recorded === true, reason: optStr(raw.cashMovements.reason) ?? "" }
      : { recorded: false, reason: "NOT_RECORDED_BEFORE_CASH_MOVEMENTS" },
    evidenceExpectedCashMmk: req(raw.evidenceExpectedCashMmk, "evidenceExpectedCashMmk"),
    evidenceVarianceMmk: optNum(raw.evidenceVarianceMmk),
    storedMatchesEvidence: optBool(raw.storedMatchesEvidence),
    storedMatchesEvidenceIfCloseWindowDeducted: optBool(raw.storedMatchesEvidenceIfCloseWindowDeducted),
    storedMatchesEvidenceIfUnknownTimeDeducted: optBool(raw.storedMatchesEvidenceIfUnknownTimeDeducted),
    asOf: str(raw.asOf, "asOf"),
  };
}

// ---------------------------------------------------------------- outcome mapping
/** Map a request outcome to a report state. Read-only: nothing is queued or retried. */
export function toFinResult<T>(outcome: RpcOutcome, parse: (raw: unknown) => T): FinResult<T> {
  const err = outcome.error;
  if (!err) {
    try {
      return { status: "ok", data: parse(outcome.data) };
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : "malformed report" };
    }
  }
  const msg = err.message;
  const klass = err.failure.klass;
  if (err.code === "TIMEOUT") return { status: "unavailable", reason: "TIMEOUT", message: msg };
  if (klass === "WAITING_BACKEND" || err.code === "PGRST202" || err.code === "42883") {
    return { status: "unavailable", reason: "NOT_INSTALLED", message: msg };
  }
  if (klass === "RECOVERY" || klass === "ORG_SUSPENDED") return { status: "unavailable", reason: "RECOVERY", message: msg };
  if (klass === "AUTH_REFRESH" || klass === "AUTH_REAUTH") return { status: "unavailable", reason: "AUTH", message: msg };
  if (klass === "NOT_SENT" || (outcome.status === 0 && klass !== "REJECTED")) {
    return { status: "unavailable", reason: "OFFLINE", message: msg };
  }
  if (klass === "UNKNOWN_OUTCOME" || klass === "NOT_DELIVERED" || klass === "TEMPORARY_SERVER" || klass === "EDGE_BLOCKED") {
    return { status: "unavailable", reason: "SERVER", message: msg };
  }
  if (/not permitted|Not authenticated|not found in your organization|Shift not found/i.test(msg)) {
    return { status: "forbidden", message: msg };
  }
  if (/at most \d+ days|Invalid report date range|Refund basis must be/i.test(msg)) {
    return { status: "invalid", message: msg };
  }
  return { status: "error", message: msg };
}

// ---------------------------------------------------------------- requests
export interface FinReportParams {
  /** null: every shop the caller may see (ADMIN only; at most 93 days). */
  shopId: string | null;
  from: string;   // business day YYYY-MM-DD (Asia/Yangon)
  to: string;
  basis: RefundBasis;
}

const OFFLINE_RESULT = { status: "unavailable", reason: "OFFLINE", message: "offline" } as const;
/** The device says it is offline: nothing is sent (no 35 s spinner on a dead link). */
const deviceOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;

export async function fetchFinReportSummary(p: FinReportParams, timeoutMs = REPORT_TIMEOUT_MS): Promise<FinResult<FinReportSummary>> {
  if (deviceOffline()) return OFFLINE_RESULT;
  const outcome = await runRequest(
    supabase.rpc("fin_report_summary", { p_shop_id: p.shopId, p_from: p.from, p_to: p.to, p_refund_basis: p.basis }),
    "fin_report_summary",
    timeoutMs,
  );
  return toFinResult(outcome, parseFinReportSummary);
}

export async function fetchFinShiftReconciliation(shiftId: string, timeoutMs = REPORT_TIMEOUT_MS): Promise<FinResult<FinShiftReconciliation>> {
  if (deviceOffline()) return OFFLINE_RESULT;
  const outcome = await runRequest(
    supabase.rpc("fin_shift_reconciliation", { p_shift_id: shiftId }),
    "fin_shift_reconciliation",
    timeoutMs,
  );
  return toFinResult(outcome, parseFinShiftReconciliation);
}

// ---------------------------------------------------------------- derived figures
/** Gross profit and margin exactly as the server states them: null when cost is
 *  hidden from the caller or incomplete (never estimated from today's cost). */
export const profitOf = (t: FinReportSummary["totals"]): { profit: number | null; marginPct: number | null } => {
  if (t.grossProfitMmk === null) return { profit: null, marginPct: null };
  return { profit: t.grossProfitMmk, marginPct: t.netRevenueMmk > 0 ? (t.grossProfitMmk / t.netRevenueMmk) * 100 : null };
};

/** Every reason the figures need a second look, worded for staff. */
export interface FinWarning {
  key: "UNDATED" | "COST_INCOMPLETE" | "OVER_REFUND" | "UNPARSEABLE" | "PENDING";
  count: number;
  amountMmk?: number;
}

export const reportWarnings = (r: FinReportSummary): FinWarning[] => {
  const out: FinWarning[] = [];
  if (r.undatedAdjustments.count > 0) out.push({ key: "UNDATED", count: r.undatedAdjustments.count, amountMmk: r.undatedAdjustments.amountMmk });
  if (r.totals.cogsComplete === false) {
    out.push({ key: "COST_INCOMPLETE", count: (r.totals.linesMissingCost ?? 0) + (r.totals.adjustmentsMissingCost ?? 0) });
  }
  const over = r.evidence.refundsAboveNetPaid + r.evidence.salesRefundedAboveTotal;
  if (over > 0) out.push({ key: "OVER_REFUND", count: over });
  const bad = r.evidence.unparseableApprovedRefunds + r.pendingRequests.unparseable;
  if (bad > 0) out.push({ key: "UNPARSEABLE", count: bad });
  if (r.pendingRequests.count > 0) out.push({ key: "PENDING", count: r.pendingRequests.count, amountMmk: r.pendingRequests.amountMmk });
  return out;
};

/** For an OPEN shift: the expected cash close_shift will compute when it runs
 *  now. It deducts every approved refund / void of the shift's cash sales,
 *  including those without a recorded approval time (which the evidence
 *  figure does not deduct). null for a closed shift. */
export const closeWouldExpect = (r: FinShiftReconciliation): number | null =>
  r.shift.status === "OPEN" ? r.evidenceExpectedCashMmk - r.unknownTimePayouts.amountMmk : null;

/** Payouts of a shift that are NOT assigned to any drawer and need reconciliation. */
export const unassignedPayouts = (r: FinShiftReconciliation): { count: number; amountMmk: number } => {
  const groups = [r.afterClosePayouts, r.closeWindowPayouts, r.unknownTimePayouts];
  return {
    count: groups.reduce((s, g) => s + g.count, 0),
    amountMmk: groups.reduce((s, g) => s + g.amountMmk, 0),
  };
};
