import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

// UI rules of the server financial reports (no DOM here: rendered markup).
//  - a figure is only ever rendered from a server answer;
//  - every non-ok state is explicit (loading / unavailable / forbidden / error);
//  - with cached sales in the store, the dashboard still shows no cached total
//    while the server has not answered (no silent fallback);
//  - shift payouts without a recorded paying drawer are "unassigned".

const finState: { current: unknown } = { current: { status: "loading" } };
vi.mock("../dashboard/useServerDashboard", async () => {
  const actual = await vi.importActual<typeof import("../dashboard/useServerDashboard")>("../dashboard/useServerDashboard");
  return {
    ...actual,
    useDashboardFinancials: () => {
      const state = finState.current as { status: string; data?: unknown };
      const report = state.status === "ok" ? (state.data as Parameters<typeof actual.kpisOf>[0]) : null;
      return { state, refresh: () => undefined, kpis: report ? actual.kpisOf(report) : null, trend: report ? actual.trendOf(report) : [], report };
    },
    useDashboardShopFinancials: () => ({ state: { status: "loading" }, refresh: () => undefined, byShop: {} }),
  };
});
vi.mock("./useFinReport", async () => {
  const actual = await vi.importActual<typeof import("./useFinReport")>("./useFinReport");
  return {
    ...actual,
    useShiftReconciliations: () => ({ state: { status: "loading" }, refresh: () => undefined }),
    useShiftReconciliation: () => ({ state: { status: "loading" }, refresh: () => undefined }),
  };
});

import { FinStatusNotice, FinWarnings } from "./FinReportStatus";
import { parseFinReportSummary, parseFinShiftReconciliation, type FinResult } from "./finReports";
import { ShiftReconciliationPanel } from "../shifts/components/ShiftReconciliationPanel";
import { useDataStore } from "../../stores/dataStore";
import { AdminDashboard } from "../dashboard/AdminDashboard";
import { ManagerDashboard } from "../dashboard/ManagerDashboard";
import type { Shop, User } from "../../types";

const summary = () => parseFinReportSummary({
  basis: { timezone: "Asia/Yangon", refundBasis: "SALE_DATE", from: "2026-10-20", to: "2026-10-20", asOf: "t", refundMethodAssumption: "ORIGINAL_SALE_METHOD" },
  scope: { level: "ORG", shopIds: ["shop-1"], profitVisible: true },
  totals: { saleCount: 3, grossSalesMmk: 12345, refundCount: 1, refundMmk: 345, voidCount: 0, voidMmk: 0, netRevenueMmk: 12000,
    cogsMmk: 5000, cogsComplete: true, grossProfitMmk: 7000, linesMissingCost: 0, adjustmentsMissingCost: 0 },
  excludedVoids: { count: 0, amountMmk: 0 },
  undatedAdjustments: { count: 1, amountMmk: 500, refundCount: 1, voidCount: 0 },
  pendingRequests: { count: 0, amountMmk: 0, unparseable: 0 },
  byDay: [{ date: "2026-10-20", saleCount: 3, grossSalesMmk: 12345, refundCount: 1, refundMmk: 345, voidCount: 0, voidMmk: 0, netRevenueMmk: 12000, cogsMmk: 5000, cogsComplete: true, grossProfitMmk: 7000 }],
  byPaymentMethod: [{ method: "CASH", grossSalesMmk: 12345, refundMmk: 345, voidMmk: 0, netMmk: 12000 }],
  supplierPayments: null,
  evidence: { refundsAboveNetPaid: 0, salesRefundedAboveTotal: 0, unparseableApprovedRefunds: 0 },
});

const admin: User = {
  id: "u-admin", name: "Admin", email: "a@x", role: "ADMIN", shopId: null, isActive: true,
} as unknown as User;
const manager: User = {
  id: "u-mgr", name: "Manager", email: "m@x", role: "MANAGER", shopId: "shop-1", isActive: true,
} as unknown as User;
const shops: Shop[] = [{ id: "shop-1", code: "S1", name: "Shop One", isActive: true } as unknown as Shop];

// 1,000 cached sales worth 777 MMK each: their client total (777,000) must never appear.
const cachedSales = Array.from({ length: 1000 }, (_, i) => ({
  id: `sale-${i}`, shopId: "shop-1", shiftId: "shift-1", receiptNo: `R${i}`, cashierId: "u-mgr", status: "NORMAL",
  subtotalMmk: 777, discountMmk: 0, totalMmk: 777, paymentMethod: "CASH", paidMmk: 777, changeMmk: 0,
  createdAt: new Date().toISOString(),
}));

beforeEach(() => {
  finState.current = { status: "loading" };
  useDataStore.setState({ sales: cachedSales as never, saleItems: [], refundVoidRequests: [], shifts: [] } as never);
});

describe("FinStatusNotice", () => {
  const render = (state: unknown) =>
    renderToStaticMarkup(<FinStatusNotice state={state as FinResult<number>} onRetry={() => undefined}>{(n) => <b>figure {n}</b>}</FinStatusNotice>);
  it("renders the figure only for a server answer", () => {
    expect(render({ status: "ok", data: 42 })).toContain("figure 42");
  });
  it.each([
    [{ status: "loading" }, "Loading server report"],
    [{ status: "unavailable", reason: "OFFLINE", message: "x" }, "You are offline"],
    [{ status: "unavailable", reason: "TIMEOUT", message: "x" }, "did not answer in time"],
    [{ status: "unavailable", reason: "NOT_INSTALLED", message: "x" }, "does not provide financial reports"],
    [{ status: "unavailable", reason: "RECOVERY", message: "x" }, "in recovery"],
    [{ status: "forbidden", message: "x" }, "not permitted"],
    [{ status: "error", message: "boom" }, "could not be read: boom"],
  ])("%j -> explicit notice, no figure", (state, text) => {
    const html = render(state);
    expect(html).toContain(text);
    expect(html).not.toContain("figure");
  });
  it("timeouts and offline offer a manual retry (never an automatic one)", () => {
    expect(render({ status: "unavailable", reason: "TIMEOUT", message: "x" })).toContain("Try again");
    expect(render({ status: "unavailable", reason: "NOT_INSTALLED", message: "x" })).not.toContain("Try again");
  });
});

describe("FinWarnings", () => {
  it("states undated adjustments instead of placing them on a day", () => {
    expect(renderToStaticMarkup(<FinWarnings report={summary()} />)).toContain("have no recorded approval time");
  });
});

describe("dashboards: no silent fallback to the client cache", () => {
  it("ADMIN dashboard with 1,000 cached sales and no server answer shows no cached revenue", () => {
    finState.current = { status: "unavailable", reason: "OFFLINE", message: "offline" };
    const html = renderToStaticMarkup(<AdminDashboard currentUser={admin} shops={shops} />);
    expect(html).toContain("Server figures unavailable");
    expect(html).not.toMatch(/777,000|777000/);
  });
  it("ADMIN dashboard shows the server's figures when it answers", () => {
    finState.current = { status: "ok", data: summary() };
    const html = renderToStaticMarkup(<AdminDashboard currentUser={admin} shops={shops} />);
    expect(html).toMatch(/12,000/);
    expect(html).toContain("Server-verified");
    expect(html).not.toMatch(/777,000|777000/);
  });
  it("MANAGER dashboard while loading shows loading, not cached totals", () => {
    const html = renderToStaticMarkup(<ManagerDashboard currentUser={manager} shopId="shop-1" shops={shops} />);
    expect(html).toContain("Loading…");
    expect(html).not.toMatch(/777,000|777000/);
  });
});

describe("ShiftReconciliationPanel", () => {
  const recon = parseFinShiftReconciliation({
    shift: { id: "s1", shopId: "shop-1", cashierId: "c", status: "CLOSED", startedAt: "2026-10-20T01:00:00Z", endedAt: "2026-10-20T09:00:00Z",
      closeRecordedAt: "2026-10-20T09:00:01Z", closeTimeSource: "SERVER_LEDGER", openingCashMmk: 50000, closingCashMmk: 59700,
      storedExpectedCashMmk: 59700, storedVarianceMmk: 0, varianceReason: null },
    cashSales: { count: 3, amountMmk: 9700 }, nonCashSales: [],
    attributedPayouts: { count: 0, amountMmk: 0, refundMmk: 0, voidMmk: 0 },
    afterClosePayouts: { count: 2, amountMmk: 2800, items: [
      { kind: "REFUND", id: "r1", saleId: "sale-1", receiptNo: "R1", approvedAt: "2026-10-20T10:00:00Z", amountMmk: 1000 },
      { kind: "REFUND", id: "r2", saleId: "sale-2", receiptNo: "R2", approvedAt: "2026-10-20T10:01:00Z", amountMmk: 1800 }] },
    closeWindowPayouts: { count: 0, amountMmk: 0, items: [] },
    unknownTimePayouts: { count: 0, amountMmk: 0, items: [] },
    crossShiftPayoutsDuringShift: null, supplierCashPaymentsDuringShift: null,
    cashMovements: { recorded: false, reason: "NOT_RECORDED_BEFORE_CASH_MOVEMENTS" },
    evidenceExpectedCashMmk: 59700, evidenceVarianceMmk: 0, storedMatchesEvidence: true, asOf: "t",
  });
  it("a refund approved after the shift closed is UNASSIGNED and not deducted; pay-in/out is 'not recorded', never 0", () => {
    const html = renderToStaticMarkup(<ShiftReconciliationPanel state={{ status: "ok", data: recon }} onRetry={() => undefined} />);
    expect(html).toContain("Unassigned refunds requiring reconciliation: 2");
    expect(html).toContain("Approved after this shift closed — unassigned");
    expect(html).toContain("paying drawer not recorded");
    expect(html).not.toContain("paid from this shift");
    expect(html).toContain("not recorded by this server");
    expect(html).not.toContain("data-stored-mismatch");
  });
  it("a stored figure that differs from the evidence is flagged, not rewritten", () => {
    const html = renderToStaticMarkup(<ShiftReconciliationPanel state={{ status: "ok", data: { ...recon, storedMatchesEvidence: false } }} onRetry={() => undefined} />);
    expect(html).toContain("data-stored-mismatch");
  });
  it("unavailable server: no reconciliation figures", () => {
    const html = renderToStaticMarkup(<ShiftReconciliationPanel state={{ status: "unavailable", reason: "TIMEOUT", message: "x" }} onRetry={() => undefined} />);
    expect(html).toContain("did not answer in time");
    expect(html).not.toContain("Expected cash (evidence)");
  });
});
