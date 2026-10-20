import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("../../lib/supabase", () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  fetchFinReportSummary,
  fetchFinShiftReconciliation,
  parseFinReportSummary,
  profitOf,
  reportWarnings,
  toFinResult,
  unassignedPayouts,
  parseFinShiftReconciliation,
} from "./finReports";
import { toRpcError } from "../../stores/data/idempotentRpc";

const summaryFixture = (over: Record<string, unknown> = {}) => ({
  basis: { timezone: "Asia/Yangon", refundBasis: "SALE_DATE", from: "2026-10-19", to: "2026-10-20", asOf: "2026-10-20T08:00:00Z",
    refundMethodAssumption: "ORIGINAL_SALE_METHOD", pendingRequestsBasis: "SALES_RUNG_UP_IN_RANGE" },
  scope: { level: "SHOP", shopIds: ["shop-f"], profitVisible: true },
  totals: { saleCount: 5, grossSalesMmk: 15700, refundCount: 4, refundMmk: 4300, voidCount: 0, voidMmk: 0, netRevenueMmk: 11400,
    cogsMmk: 2400, cogsComplete: false, grossProfitMmk: null, linesMissingCost: 1, adjustmentsMissingCost: 0 },
  excludedVoids: { count: 1, amountMmk: 2000 },
  undatedAdjustments: { count: 0, amountMmk: 0, refundCount: 0, voidCount: 0 },
  pendingRequests: { count: 0, amountMmk: 0, unparseable: 0 },
  byDay: [
    { date: "2026-10-19", saleCount: 2, grossSalesMmk: 4700, refundCount: 2, refundMmk: 2800, voidCount: 0, voidMmk: 0,
      netRevenueMmk: 1900, cogsMmk: 1200, cogsComplete: true, grossProfitMmk: 700 },
    { date: "2026-10-20", saleCount: 3, grossSalesMmk: 11000, refundCount: 2, refundMmk: 1500, voidCount: 0, voidMmk: 0,
      netRevenueMmk: 9500, cogsMmk: 1200, cogsComplete: false, grossProfitMmk: null },
  ],
  byPaymentMethod: [{ method: "CASH", grossSalesMmk: 12700, refundMmk: 3800, voidMmk: 0, netMmk: 8900 }],
  supplierPayments: null,
  evidence: { refundsAboveNetPaid: 0, salesRefundedAboveTotal: 0, unparseableApprovedRefunds: 0 },
  ...over,
});

const ok = (data: unknown) => ({ data, error: null, status: 200 });
const fail = (error: Record<string, unknown>, status: number) => ({ data: null, error, status });

beforeEach(() => rpc.mockReset());

describe("parseFinReportSummary", () => {
  it("keeps the server's figures, nulls and basis exactly", () => {
    const r = parseFinReportSummary(summaryFixture());
    expect(r.totals.netRevenueMmk).toBe(11400);
    expect(r.totals.grossProfitMmk).toBeNull();
    expect(r.totals.cogsComplete).toBe(false);
    expect(r.basis.refundBasis).toBe("SALE_DATE");
    expect(r.basis.timezone).toBe("Asia/Yangon");
    expect(r.byDay[0].grossProfitMmk).toBe(700);
    expect(r.byDay[1].grossProfitMmk).toBeNull();
  });
  it("refuses a malformed reply instead of showing partial numbers", () => {
    expect(() => parseFinReportSummary({ basis: {}, scope: {}, totals: {} })).toThrow(/malformed/);
    expect(() => parseFinReportSummary(summaryFixture({ totals: { ...summaryFixture().totals, netRevenueMmk: "11400" } }))).toThrow(/netRevenueMmk/);
    expect(() => parseFinReportSummary(null)).toThrow();
  });
});

describe("toFinResult (no fallback: every failure is an explicit state)", () => {
  const map = (raw: Record<string, unknown>, status: number) =>
    toFinResult({ data: null, error: toRpcError(raw, status), status }, parseFinReportSummary);

  it("timeout -> unavailable TIMEOUT", () => {
    const r = toFinResult({ data: null, status: 0, error: toRpcError({ message: "fin_report_summary timed out after 35s", code: "TIMEOUT" }, 0) }, parseFinReportSummary);
    expect(r).toMatchObject({ status: "unavailable", reason: "TIMEOUT" });
  });
  it("network failure -> unavailable OFFLINE", () => {
    expect(map({ message: "TypeError: Failed to fetch" }, 0)).toMatchObject({ status: "unavailable", reason: "OFFLINE" });
  });
  it("reports not installed (PGRST202) -> unavailable NOT_INSTALLED", () => {
    expect(map({ message: "Could not find the function public.fin_report_summary", code: "PGRST202" }, 404))
      .toMatchObject({ status: "unavailable", reason: "NOT_INSTALLED" });
  });
  it("087 recovery hold -> unavailable RECOVERY", () => {
    expect(map({ message: "ORG_SUSPENDED: server recovery in progress [LEASE_INVALID]", code: "PT429" }, 429))
      .toMatchObject({ status: "unavailable", reason: "RECOVERY" });
  });
  it("gateway / temporary server failure -> unavailable SERVER", () => {
    expect(map({ message: "Bad gateway" }, 502)).toMatchObject({ status: "unavailable" });
  });
  it("permission and tenant refusals -> forbidden", () => {
    expect(map({ message: "You are not permitted to view reports for this shop", code: "P0001" }, 400)).toMatchObject({ status: "forbidden" });
    expect(map({ message: "Shop not found in your organization", code: "P0001" }, 400)).toMatchObject({ status: "forbidden" });
  });
  it("range refusals -> invalid (shown to the person, never retried)", () => {
    expect(map({ message: "An all-shops report covers at most 93 days; report per shop for longer ranges", code: "P0001" }, 400))
      .toMatchObject({ status: "invalid" });
  });
  it("a 200 with a malformed body -> error, not partial figures", () => {
    expect(toFinResult(ok({ nope: true }), parseFinReportSummary)).toMatchObject({ status: "error" });
  });
});

describe("requests", () => {
  it("fin_report_summary is called with exactly the four arguments", async () => {
    rpc.mockResolvedValueOnce(ok(summaryFixture()));
    const r = await fetchFinReportSummary({ shopId: null, from: "2026-10-01", to: "2026-10-20", basis: "APPROVAL_DATE" });
    expect(rpc).toHaveBeenCalledWith("fin_report_summary", { p_shop_id: null, p_from: "2026-10-01", p_to: "2026-10-20", p_refund_basis: "APPROVAL_DATE" });
    expect(r.status).toBe("ok");
  });
  it("a server error reply is mapped, never thrown", async () => {
    rpc.mockResolvedValueOnce(fail({ message: "You are not permitted to view financial reports", code: "P0001" }, 400));
    await expect(fetchFinReportSummary({ shopId: "s", from: "2026-10-01", to: "2026-10-01", basis: "SALE_DATE" }))
      .resolves.toMatchObject({ status: "forbidden" });
  });
  it("a hung request ends as TIMEOUT within the given budget", async () => {
    rpc.mockReturnValueOnce(new Promise(() => undefined));
    const r = await fetchFinShiftReconciliation("shift-1", 20);
    expect(r).toMatchObject({ status: "unavailable", reason: "TIMEOUT" });
  });
});

describe("derived figures", () => {
  it("profit is null when the server says so (hidden or incomplete), never estimated", () => {
    expect(profitOf(parseFinReportSummary(summaryFixture()).totals)).toEqual({ profit: null, marginPct: null });
    const t = parseFinReportSummary(summaryFixture({ totals: { ...summaryFixture().totals, cogsComplete: true, grossProfitMmk: 9000 } })).totals;
    expect(profitOf(t).profit).toBe(9000);
    expect(profitOf(t).marginPct).toBeCloseTo((9000 / 11400) * 100);
  });
  it("warnings: undated, cost incomplete, over-refund, unparseable, pending", () => {
    const r = parseFinReportSummary(summaryFixture({
      undatedAdjustments: { count: 1, amountMmk: 500, refundCount: 1, voidCount: 0 },
      pendingRequests: { count: 2, amountMmk: 3000, unparseable: 1 },
      evidence: { refundsAboveNetPaid: 1, salesRefundedAboveTotal: 1, unparseableApprovedRefunds: 0 },
    }));
    expect(reportWarnings(r).map((w) => w.key)).toEqual(["UNDATED", "COST_INCOMPLETE", "OVER_REFUND", "UNPARSEABLE", "PENDING"]);
  });
  it("unassigned payouts = after close + close window + unknown time (cross-shift candidates are separate)", () => {
    const g = (count: number, amountMmk: number) => ({ count, amountMmk, items: [] });
    const r = parseFinShiftReconciliation({
      shift: { id: "s", shopId: "shop", cashierId: "c", status: "CLOSED", startedAt: "t", endedAt: "t", closeRecordedAt: null,
        closeTimeSource: "ENDED_AT_ONLY", openingCashMmk: 0, closingCashMmk: 0, storedExpectedCashMmk: 0, storedVarianceMmk: 0, varianceReason: null },
      cashSales: { count: 0, amountMmk: 0 }, nonCashSales: [],
      attributedPayouts: { count: 0, amountMmk: 0, refundMmk: 0, voidMmk: 0 },
      afterClosePayouts: g(1, 1000), closeWindowPayouts: g(1, 500), unknownTimePayouts: g(2, 300),
      crossShiftPayoutsDuringShift: g(5, 9999), supplierCashPaymentsDuringShift: null,
      cashMovements: { recorded: false, reason: "NOT_RECORDED_BEFORE_CASH_MOVEMENTS" },
      evidenceExpectedCashMmk: 0, evidenceVarianceMmk: 0, storedMatchesEvidence: true, asOf: "t",
    });
    expect(unassignedPayouts(r)).toEqual({ count: 4, amountMmk: 1800 });
  });
});

describe("request concurrency", () => {
  it("mapLimited never runs more than the limit at once and keeps the order", async () => {
    const { mapLimited } = await import("./useFinReport");
    let running = 0, peak = 0;
    const out = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });
});

describe("expired sign-in", () => {
  it("maps to an explicit AUTH state, not a generic error", () => {
    const r = toFinResult({ data: null, status: 401, error: toRpcError({ message: "JWT expired", code: "PGRST301" }, 401) }, parseFinReportSummary);
    expect(r.status === "unavailable" && ["AUTH", "SERVER"].includes(r.reason)).toBe(true);
  });
});
