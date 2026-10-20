import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  parseFinReportSummary,
  parseFinShiftReconciliation,
  profitOf,
  reportWarnings,
  toFinResult,
  unassignedPayouts,
} from "./finReports";
import { kpisOf, trendOf } from "../dashboard/useServerDashboard";
import { toRpcError } from "../../stores/data/idempotentRpc";

// ---------------------------------------------------------------------------
// Client <-> backend CONTRACT. The fixtures are REAL replies of the
// provisional PFIN-B functions, captured from a disposable database by
//   FIN_EXPORT_DIR=src/features/reports/__fixtures__/fin-contract supabase/tests/fin/run.sh
// after the hand-computed fixtures of supabase/tests/fin/sql/f01..f04
// (synthetic data). Each reply is read AS the named user through the API role.
// Regenerate them whenever PFIN-B's reply shape changes; this test then
// proves the client still parses and presents them exactly.
// ---------------------------------------------------------------------------

const dir = join(__dirname, "__fixtures__", "fin-contract");
const load = (name: string): { data?: unknown; error?: { code: string; message: string } } =>
  JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
const summary = (name: string) => parseFinReportSummary(load(name).data);
const recon = (name: string) => parseFinShiftReconciliation(load(name).data);
const days = JSON.parse(readFileSync(join(dir, "days.json"), "utf8")) as { D1: string; D2: string };

describe("fixtures belong to this PFIN-B", () => {
  it("the captured replies were exported from exactly the provisional PFIN-B in this tree (re-export after any change)", () => {
    const pfinB = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations-provisional", "PFIN-B_financial_reports.sql"));
    expect(createHash("sha256").update(pfinB).digest("hex")).toBe(readFileSync(join(dir, "pfin-b.sha256"), "utf8").trim());
  });
});

describe("fin_report_summary replies (f01 fixtures, shop F, D1..D2 around Yangon midnight)", () => {
  it("sales performance (SALE_DATE): partial + discounted refunds netted, void excluded, cost incomplete -> no profit", () => {
    const r = summary("summary_admin_shop_sale");
    expect(r.basis).toMatchObject({ timezone: "Asia/Yangon", refundBasis: "SALE_DATE", from: days.D1, to: days.D2 });
    expect(r.totals).toMatchObject({ saleCount: 5, grossSalesMmk: 15700, refundCount: 4, refundMmk: 4300, netRevenueMmk: 11400, cogsMmk: 2400 });
    expect(r.excludedVoids).toEqual({ count: 1, amountMmk: 2000 });
    // a line without a cost snapshot: COGS incomplete, profit NOT shown (it would be 9,000 and overstated)
    expect(profitOf(r.totals)).toEqual({ profit: null, marginPct: null });
    expect(kpisOf(r)).toMatchObject({ revenue: 11400, orders: 5, profit: null, costIncomplete: true });
    expect(reportWarnings(r).map((w) => w.key)).toContain("COST_INCOMPLETE");
    // Yangon midnight: the 23:59:59 sale is on D1, the 00:00:01 sale on D2
    const d1 = r.byDay.find((d) => d.date === days.D1)!;
    const d2 = r.byDay.find((d) => d.date === days.D2)!;
    expect([d1.grossSalesMmk, d1.refundMmk, d1.netRevenueMmk]).toEqual([4700, 2800, 1900]);
    expect([d2.grossSalesMmk, d2.refundMmk, d2.netRevenueMmk]).toEqual([11000, 1500, 9500]);
    // per-day profit: D1 fully costed (shown), D2 has the cost-less line (not shown)
    const trend = trendOf(r);
    expect(trend.find((t) => t.date === days.D1)?.profit).toBe(700);
    expect(trend.find((t) => t.date === days.D2)?.profit).toBeNull();
  });

  it("cash flow (APPROVAL_DATE): refunds/voids on the approval day; the refund with no approval record is undated, not guessed", () => {
    const r = summary("summary_admin_shop_approval");
    expect(r.basis.refundBasis).toBe("APPROVAL_DATE");
    expect(r.totals).toMatchObject({ saleCount: 6, grossSalesMmk: 17700, refundMmk: 3800, voidMmk: 2000, netRevenueMmk: 11900 });
    expect(r.undatedAdjustments).toMatchObject({ count: 1, amountMmk: 500 });
    expect(reportWarnings(r).find((w) => w.key === "UNDATED")).toMatchObject({ count: 1, amountMmk: 500 });
    expect(r.byDay.find((d) => d.date === days.D1)?.netRevenueMmk).toBe(4700);
  });

  it("a fully costed day shows profit (D1: 1,900 net - 1,200 cost = 700)", () => {
    const r = summary("summary_admin_shop_sale_d1");
    expect(profitOf(r.totals).profit).toBe(700);
    expect(r.totals.cogsComplete).toBe(true);
  });

  it("manager scope: own shop, net includes every refund, cost hidden without report:shop_profit", () => {
    const r = summary("summary_manager_own_shop");
    expect(r.scope).toMatchObject({ level: "SHOP", shopIds: ["shop-f"], profitVisible: false });
    expect(r.totals.netRevenueMmk).toBe(11400);
    expect(r.totals.cogsMmk).toBeNull();
    expect(kpisOf(r).profit).toBeNull();
  });

  it("cashier scope: own sales only, net of a refund a MANAGER entered on them (P-5), no cost", () => {
    const r = summary("summary_cashier_own");
    expect(r.scope.level).toBe("OWN");
    expect(r.totals).toMatchObject({ saleCount: 4, netRevenueMmk: 9400, cogsMmk: null, grossProfitMmk: null });
    expect(JSON.stringify(load("summary_cashier_own"))).not.toContain("secret-reason-r1");
  });

  it("cross-tenant: another organisation's ADMIN sees only its own shops", () => {
    const r = summary("summary_other_org_admin");
    expect(r.scope.level).toBe("ORG");
    expect(r.scope.shopIds).not.toContain("shop-f");
    expect(r.scope.shopIds.every((id) => !["shop-a", "shop-b", "shop-v"].includes(id))).toBe(true);
  });

  it("high volume: a year of shop V (> 1,000 sales, 367 days) parses in full", () => {
    const r = summary("summary_volume_year");
    expect(r.totals.saleCount).toBeGreaterThan(1000);
    expect(r.byDay).toHaveLength(367);
    expect(r.byDay.reduce((s, d) => s + d.netRevenueMmk, 0)).toBe(r.totals.netRevenueMmk);
  });
});

describe("error replies -> explicit client states", () => {
  const map = (name: string, status: number) => {
    const e = load(name).error!;
    return toFinResult({ data: null, error: toRpcError({ message: e.message, code: e.code }, status), status }, parseFinReportSummary);
  };
  it("cashier asking for another shop -> forbidden", () => expect(map("error_cashier_other_shop", 400).status).toBe("forbidden"));
  it("another organisation's shop -> forbidden (same answer as no such shop)", () => expect(map("error_other_org_shop", 400).status).toBe("forbidden"));
  it("all shops beyond 93 days -> invalid (P-7)", () => expect(map("error_org_range", 400).status).toBe("invalid"));
  it("anon -> refused (not a figure)", () => expect(map("error_anon", 401).status).not.toBe("ok"));
  it("cashier opening another cashier's shift -> forbidden", () => expect(map("error_recon_other_cashier", 400).status).toBe("forbidden"));
});

describe("fin_shift_reconciliation replies (f02 fixtures)", () => {
  it("S1: refunds approved after the close are UNASSIGNED (P-3: no paying shift recorded), not deducted; stored = evidence", () => {
    const r = recon("recon_s1_manager");
    expect(r.shift.status).toBe("CLOSED");
    expect(r.shift.closeTimeSource).toBe("SERVER_LEDGER");
    expect(r.afterClosePayouts).toMatchObject({ count: 2, amountMmk: 2800 });
    expect(r.attributedPayouts.amountMmk).toBe(0);
    expect(unassignedPayouts(r)).toMatchObject({ count: 2, amountMmk: 2800 });
    expect(r.evidenceExpectedCashMmk).toBe(59700);
    expect(r.storedMatchesEvidence).toBe(true);
    expect(r.cashMovements.recorded).toBe(false);
  });

  it("S2: own refund + void deducted; other shifts' refunds listed as candidates only; legacy refund has unknown time", () => {
    const r = recon("recon_s2_manager");
    expect(r.attributedPayouts).toMatchObject({ refundMmk: 1000, voidMmk: 2000 });
    expect(r.crossShiftPayoutsDuringShift).toMatchObject({ count: 2, amountMmk: 2800 });
    expect(r.unknownTimePayouts).toMatchObject({ count: 1, amountMmk: 1000 });
    expect(r.evidenceExpectedCashMmk).toBe(22000);
    expect(r.evidenceVarianceMmk).toBe(-2800);
  });

  it("S2 seen by its own cashier: other cashiers' refunds withheld entirely", () => {
    const r = recon("recon_s2_cashier_own");
    expect(r.crossShiftPayoutsDuringShift).toBeNull();
    expect(r.supplierCashPaymentsDuringShift).toBeNull();
    expect(r.evidenceExpectedCashMmk).toBe(22000);
  });

  it("an OPEN shift (the close form's input): live evidence expected cash, nothing stored, no close time yet", () => {
    const r = recon("recon_s3_manager");
    expect(r.shift.status).toBe("OPEN");
    expect(r.shift.closeTimeSource).toBeNull();
    expect(r.storedMatchesEvidence).toBeNull();
    expect(r.evidenceExpectedCashMmk).toBe(r.shift.openingCashMmk + r.cashSales.amountMmk - r.attributedPayouts.amountMmk);
  });

  it("S4 (offline-stamped close, server close time on record): the refund approved before close_shift ran is deducted", () => {
    const r = recon("recon_s4_manager");
    expect(r.shift.closeTimeSource).toBe("SERVER_LEDGER");
    expect(r.attributedPayouts.amountMmk).toBe(1000);
    expect(r.storedMatchesEvidence).toBe(true);
  });

  it("S5 (till clock fast): a refund approved after close_shift ran is after-close/unassigned, not deducted", () => {
    const r = recon("recon_s5_manager");
    expect(r.afterClosePayouts.amountMmk).toBe(1000);
    expect(r.attributedPayouts.amountMmk).toBe(0);
    expect(r.storedMatchesEvidence).toBe(true);
  });
});
