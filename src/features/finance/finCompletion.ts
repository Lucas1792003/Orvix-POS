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
import { runRequest, toRpcError, type RpcError } from "../../stores/data/idempotentRpc";
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

// ---------------------------------------------------------------- Step 6 (PFIN-F / PDISC-A) capabilities
// Split-payment refunds (fin_refund_plan, exception approvals, payout confirmation) and discount authorization are
// provisional migrations that do not change fin_capabilities. Each is detected by PROBING one of its functions with
// arguments the server refuses before anything is read or written: "function not found" (PGRST202 / 42883) = absent;
// any other answer from the server (a refusal) = present. A failed probe (offline, timeout) never upgrades anything:
// the last answer for THIS backend is kept, like finCapabilities.
export interface FinStep6Capabilities {
  /** PFIN-F: fin_refund_plan / fin_refund_payout_state / fin_decide_approval / fin_confirm_refund_payout. */
  splitRefunds: boolean;
  /** PDISC-A: discounts above the seller's own limit need an approved DISCOUNT approval (fin_request_discount_approval). */
  discountApprovals: boolean;
}
export const NO_STEP6_CAPABILITIES: FinStep6Capabilities = { splitRefunds: false, discountApprovals: false };
const cap6Key = (origin: string) => `fin:step6-capabilities:${origin}`;
let memo6: { origin: string; caps: FinStep6Capabilities } | null = null;

/** Tests only. */
export function resetFinStep6CapabilitiesForTests(): void { memo6 = null; }

type ProbeAnswer = "present" | "absent" | "unknown";
async function probe(fn: string, args: Record<string, unknown>): Promise<ProbeAnswer> {
  const outcome = await runRequest(supabase.rpc(fn, args), `${fn} probe`, 10_000);
  if (!outcome.error) return "present";
  const res = toFinResult(outcome, () => null);
  if (res.status === "unavailable") return res.reason === "NOT_INSTALLED" ? "absent" : "unknown";
  return "present";                                       // the server ran the function and refused the probe
}

export async function finStep6Capabilities(options: { refresh?: boolean; origin?: string } = {}): Promise<FinStep6Capabilities> {
  const origin = options.origin ?? currentBackendOrigin();
  if (memo6?.origin === origin && !options.refresh) return memo6.caps;
  let known: FinStep6Capabilities = NO_STEP6_CAPABILITIES;
  try {
    const row = await localDb.syncState.get(cap6Key(origin));
    if (row?.value) {
      const d = JSON.parse(row.value) as Record<string, unknown>;
      known = { splitRefunds: d.splitRefunds === true, discountApprovals: d.discountApprovals === true };
    }
  } catch { /* unreadable: nothing known */ }
  if (typeof navigator === "undefined" || navigator.onLine !== false) {
    // fin_refund_payout_state(''): read only; refused (no such sale) before anything is read
    // fin_request_discount_approval(…, p_key NULL): refused (IDEMPOTENCY_KEY_REQUIRED) before anything is written
    const [refunds, discounts] = await Promise.all([
      probe("fin_refund_payout_state", { p_sale_id: "" }),
      probe("fin_request_discount_approval", { p_shop_id: "", p_reference_subtotal_mmk: 0, p_discount_mmk: 0, p_reason: "", p_key: null }),
    ]);
    const next = {
      splitRefunds: refunds === "unknown" ? known.splitRefunds : refunds === "present",
      discountApprovals: discounts === "unknown" ? known.discountApprovals : discounts === "present",
    };
    if (refunds !== "unknown" || discounts !== "unknown") {
      known = next;
      await localDb.syncState.put({ key: cap6Key(origin), value: JSON.stringify(known), updatedAt: new Date().toISOString() }).catch(() => undefined);
    }
  }
  memo6 = { origin, caps: known };
  return known;
}

/** The last known answer, without asking (for render paths). */
export function knownFinStep6Capabilities(origin = currentBackendOrigin()): FinStep6Capabilities {
  return memo6?.origin === origin ? memo6.caps : NO_STEP6_CAPABILITIES;
}

// ---------------------------------------------------------------- Step 6: online-only keyed writes
const deviceOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;

/** Raised before anything is sent: these operations are never queued. */
export class FinOnlineOnlyError extends Error {
  constructor(what: string) {
    super(`${what} only while this till is connected to the server. Nothing was sent.`);
    this.name = "FinOnlineOnlyError";
  }
}

/**
 * One online-only keyed write (fin_decide_approval, fin_request_discount_approval, fin_confirm_refund_payout). A fresh
 * random key is minted ONCE per user action; a transient failure is retried with the SAME key (the server answers a
 * replay from its own record). Never queued. Throws the server's error (its message is shown verbatim).
 */
async function finKeyedWrite(fn: string, args: Record<string, unknown>, what: string): Promise<unknown> {
  if (deviceOffline()) throw new FinOnlineOnlyError(what);
  const params = { ...args, p_key: crypto.randomUUID() };
  let lastError: RpcError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      if (deviceOffline()) break;
      await new Promise((r) => setTimeout(r, attempt === 1 ? 500 : 1500));
    }
    const outcome = await runRequest(supabase.rpc(fn, params), fn, 20_000);
    if (!outcome.error) {
      if (outcome.data == null) throw new Error(`${fn} returned no data.`);
      return outcome.data;
    }
    lastError = outcome.error;
    if (!outcome.error.transient) break;
  }
  throw lastError ?? toRpcError(`${fn} failed`);
}

// ---------------------------------------------------------------- Step 6: exception approvals (fin_approvals)
export type FinApprovalKind = "DISCOUNT" | "REFUND_ALT_PAYOUT" | "REFUND_PRICE_ADJUST";
export type FinApprovalStatus = "REQUESTED" | "APPROVED" | "REJECTED";
export interface MethodAmount { method: string; amountMmk: number }
export interface DiscountApprovalDetails { referenceSubtotalMmk: number; discountMmk: number; pct: number; needsShopAdmin: boolean }
export interface AltPayoutDetails { saleId: string; original: MethodAmount[]; proposed: MethodAmount[] }
export interface PriceAdjustDetails { saleId: string; lines: { saleItemId: string; qtyUnits: number; defaultMmk: number; proposedMmk: number }[] }
export interface FinApproval {
  id: string;
  shopId: string;
  kind: FinApprovalKind;
  subjectId: string | null;
  details: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  status: FinApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  expiresAt: string | null;
  consumedSaleId: string | null;
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const methodAmounts = (v: unknown): MethodAmount[] =>
  Array.isArray(v) ? v.filter(isObj).map((m) => ({ method: String(m.method), amountMmk: num(m.amountMmk) })) : [];

/** A fin_approvals row (snake_case, from the table) or a fin_approval_json reply (camelCase). */
export function parseFinApproval(raw: unknown): FinApproval {
  if (!isObj(raw) || typeof raw.id !== "string") throw new Error("malformed approval");
  const g = (camel: string, snake: string): unknown => (camel in raw ? raw[camel] : raw[snake]);
  const kind = String(raw.kind) as FinApprovalKind;
  const status = String(raw.status) as FinApprovalStatus;
  if (!["DISCOUNT", "REFUND_ALT_PAYOUT", "REFUND_PRICE_ADJUST"].includes(kind)) throw new Error("malformed approval kind");
  if (!["REQUESTED", "APPROVED", "REJECTED"].includes(status)) throw new Error("malformed approval status");
  return {
    id: raw.id, shopId: String(g("shopId", "shop_id") ?? ""), kind, subjectId: strOrNull(g("subjectId", "subject_id")),
    details: isObj(raw.details) ? raw.details : {}, reason: String(raw.reason ?? ""),
    requestedBy: String(g("requestedBy", "requested_by") ?? ""), requestedAt: String(g("requestedAt", "requested_at") ?? ""),
    status, decidedBy: strOrNull(g("decidedBy", "decided_by")), decidedAt: strOrNull(g("decidedAt", "decided_at")),
    decisionReason: strOrNull(g("decisionReason", "decision_reason")), expiresAt: strOrNull(g("expiresAt", "expires_at")),
    consumedSaleId: strOrNull(g("consumedSaleId", "consumed_sale_id")),
  };
}

export const discountDetails = (a: FinApproval): DiscountApprovalDetails => ({
  referenceSubtotalMmk: num(a.details.referenceSubtotalMmk), discountMmk: num(a.details.discountMmk),
  pct: num(a.details.pct), needsShopAdmin: a.details.needsShopAdmin === true,
});
export const altPayoutDetails = (a: FinApproval): AltPayoutDetails => ({
  saleId: String(a.details.saleId ?? ""), original: methodAmounts(a.details.original), proposed: methodAmounts(a.details.proposed),
});
export const priceAdjustDetails = (a: FinApproval): PriceAdjustDetails => ({
  saleId: String(a.details.saleId ?? ""),
  lines: Array.isArray(a.details.lines) ? a.details.lines.filter(isObj).map((l) => ({
    saleItemId: String(l.saleItemId), qtyUnits: num(l.qtyUnits), defaultMmk: num(l.defaultMmk), proposedMmk: num(l.proposedMmk),
  })) : [],
});

const APPROVAL_COLUMNS = "id,shop_id,kind,subject_id,details,reason,requested_by,requested_at,status,decided_by,decided_at,decision_reason,expires_at,consumed_sale_id";
const parseApprovals = (raw: unknown): FinApproval[] => {
  if (!Array.isArray(raw)) throw new Error("malformed approvals");
  return raw.map(parseFinApproval);
};

/**
 * Exception approvals visible to this user (RLS: the organisation's; a shop-bound user only its shop): those still
 * REQUESTED, newest first, plus every approval (any status) of the given refund requests. Online read only.
 */
export async function fetchFinApprovals(opts: { shopId?: string | null; subjectIds?: string[] } = {}, timeoutMs = 15_000): Promise<FinResult<FinApproval[]>> {
  if (deviceOffline()) return { status: "unavailable", reason: "OFFLINE", message: "offline" };
  let q = supabase.from("fin_approvals").select(APPROVAL_COLUMNS).eq("status", "REQUESTED");
  if (opts.shopId) q = q.eq("shop_id", opts.shopId);
  const pending = toFinResult(await runRequest(q.order("requested_at", { ascending: false }).limit(200), "fin_approvals", timeoutMs), parseApprovals);
  if (pending.status !== "ok" || !opts.subjectIds?.length) return pending;
  const subj = toFinResult(await runRequest(
    supabase.from("fin_approvals").select(APPROVAL_COLUMNS).in("subject_id", opts.subjectIds.slice(0, 200)), "fin_approvals", timeoutMs,
  ), parseApprovals);
  if (subj.status !== "ok") return subj;
  const byId = new Map<string, FinApproval>();
  for (const a of [...pending.data, ...subj.data]) byId.set(a.id, a);
  return { status: "ok", data: [...byId.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)) };
}

/** One approval (e.g. the till polling its discount request). */
export async function fetchFinApproval(id: string, timeoutMs = 10_000): Promise<FinResult<FinApproval | null>> {
  if (deviceOffline()) return { status: "unavailable", reason: "OFFLINE", message: "offline" };
  const outcome = await runRequest(supabase.from("fin_approvals").select(APPROVAL_COLUMNS).eq("id", id).limit(1), "fin_approvals", timeoutMs);
  return toFinResult(outcome, (raw) => {
    const rows = parseApprovals(raw);
    return rows[0] ?? null;
  });
}

const approvalOfReply = (data: unknown): FinApproval => parseFinApproval(isObj(data) ? data.approval : null);

/** A Shop Admin (never the requester) decides an exception. Online only; a rejection needs a reason (3–300). */
export async function decideFinApproval(approvalId: string, decision: "APPROVE" | "REJECT", reason: string | null): Promise<FinApproval> {
  const data = await finKeyedWrite("fin_decide_approval",
    { p_approval_id: approvalId, p_decision: decision, p_reason: reason?.trim() ? reason.trim() : null }, "Approvals are decided");
  return approvalOfReply(data);
}

/** The seller asks for a discount approval for the cart being rung up. Online only. */
export async function requestDiscountApproval(shopId: string, referenceSubtotalMmk: number, discountMmk: number, reason: string): Promise<FinApproval> {
  const data = await finKeyedWrite("fin_request_discount_approval", {
    p_shop_id: shopId, p_reference_subtotal_mmk: referenceSubtotalMmk, p_discount_mmk: discountMmk, p_reason: reason.trim(),
  }, "Discount approvals are requested");
  return approvalOfReply(data);
}

// ---------------------------------------------------------------- Step 6: refund plan and payouts
export interface RefundPlanLine { saleItemId: string; qtyUnits: number; defaultMmk: number }
export interface RefundPlanMethod { method: string; paidMmk: number; attributedRefundedMmk: number; leftMmk: number }
export interface ServerRefundPlan {
  lines: RefundPlanLine[];
  totalMmk: number;
  /** null: the server could not allocate it by the original methods (more than what is left, or no payment lines). */
  defaultPayouts: MethodAmount[] | null;
  methods: RefundPlanMethod[];
  canProposeExceptions: boolean;
}

export function parseRefundPlan(raw: unknown): ServerRefundPlan {
  if (!isObj(raw) || !Array.isArray(raw.lines)) throw new Error("malformed refund plan");
  return {
    lines: raw.lines.filter(isObj).map((l) => ({ saleItemId: String(l.saleItemId), qtyUnits: n(num(l.qtyUnits), "qtyUnits"), defaultMmk: n(num(l.defaultMmk), "defaultMmk") })),
    totalMmk: n(num(raw.totalMmk), "totalMmk"),
    defaultPayouts: Array.isArray(raw.defaultPayouts) ? methodAmounts(raw.defaultPayouts) : null,
    methods: Array.isArray(raw.methods) ? raw.methods.filter(isObj).map((m) => ({
      method: String(m.method), paidMmk: n(num(m.paidMmk), "paidMmk"),
      attributedRefundedMmk: n(num(m.attributedRefundedMmk), "attributedRefundedMmk"), leftMmk: n(num(m.leftMmk), "leftMmk"),
    })) : [],
    canProposeExceptions: raw.canProposeExceptions === true,
  };
}

/** The default amount of each chosen line and its default payout by the original methods (read only, online). */
export async function fetchRefundPlan(saleId: string, lines: { saleItemId: string; qtyUnits: number }[], timeoutMs = 15_000): Promise<FinResult<ServerRefundPlan>> {
  if (deviceOffline()) return { status: "unavailable", reason: "OFFLINE", message: "offline" };
  const outcome = await runRequest(supabase.rpc("fin_refund_plan", { p_sale_id: saleId, p_lines: lines }), "fin_refund_plan", timeoutMs);
  return toFinResult(outcome, parseRefundPlan);
}

export type RefundPayoutStatus = "PAID" | "PENDING_CONFIRMATION" | "CONFIRMED";
export interface RefundPayoutState {
  id: string; requestId: string; method: string; amountMmk: number; approvedAt: string; status: RefundPayoutStatus;
  reference: string | null; confirmedBy: string | null; confirmedAt: string | null; alternative: boolean;
}
export function parseRefundPayoutState(raw: unknown): RefundPayoutState[] {
  if (!Array.isArray(raw)) throw new Error("malformed payouts");
  return raw.filter(isObj).map((p) => {
    const status = String(p.status) as RefundPayoutStatus;
    if (!["PAID", "PENDING_CONFIRMATION", "CONFIRMED"].includes(status)) throw new Error("malformed payout status");
    return {
      id: String(p.id), requestId: String(p.requestId ?? ""), method: String(p.method), amountMmk: n(num(p.amountMmk), "amountMmk"),
      approvedAt: String(p.approvedAt ?? ""), status, reference: strOrNull(p.reference), confirmedBy: strOrNull(p.confirmedBy),
      confirmedAt: strOrNull(p.confirmedAt), alternative: p.alternative === true,
    };
  });
}

/** The refund payouts of one sale and whether each was actually paid (online read). */
export async function fetchRefundPayoutState(saleId: string, timeoutMs = 15_000): Promise<FinResult<RefundPayoutState[]>> {
  if (deviceOffline()) return { status: "unavailable", reason: "OFFLINE", message: "offline" };
  const outcome = await runRequest(supabase.rpc("fin_refund_payout_state", { p_sale_id: saleId }), "fin_refund_payout_state", timeoutMs);
  return toFinResult(outcome, parseRefundPayoutState);
}

/** Record that a non-cash refund payout was actually transferred (reference 1–120 characters). Online only. */
export async function confirmRefundPayout(payoutId: string, reference: string): Promise<void> {
  await finKeyedWrite("fin_confirm_refund_payout", { p_payout_id: payoutId, p_reference: reference.trim() }, "Refund payouts are confirmed");
}
