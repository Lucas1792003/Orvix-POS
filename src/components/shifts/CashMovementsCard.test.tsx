import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CashMovementsCard } from "./CashMovementsCard";
import type { ShiftCashSummary } from "../../features/finance/finCompletion";

const summary: ShiftCashSummary = {
  shiftId: "shift-1", openingCashMmk: 50000, cashSalesMmk: 12000, cashRefundsMmk: 2000, movementsInMmk: 10000, movementsOutMmk: 2500,
  expectedCashMmk: 67500,
  movements: [{ id: "cm-1", kind: "PAY_OUT", direction: -1, amountMmk: 2500, reason: "Cleaning supplies", createdBy: "u-m", approvedBy: "u-m", reversesId: null, createdAt: "2026-10-21T03:00:00Z" }],
};
const render = (cash: Parameters<typeof CashMovementsCard>[0]["cash"], canManage: boolean) =>
  renderToStaticMarkup(<CashMovementsCard shiftId="shift-1" cash={cash} canManage={canManage} onChanged={() => undefined} />);

describe("CashMovementsCard (Step 4, PFIN-D)", () => {
  it("shows the SERVER's figures and movements; a manager can reverse a movement and take cash out", () => {
    const html = render({ status: "ok", data: summary }, true);
    expect(html).toContain('data-testid="server-expected-cash"');
    expect(html).toContain("67,500");
    expect(html).toContain("Cleaning supplies");
    expect(html).toContain(">Reverse<");
    expect(html).toContain('value="PAY_OUT"');
  });
  it("a cashier sees no outflow kinds and no reverse button (P-8 default)", () => {
    const html = render({ status: "ok", data: summary }, false);
    expect(html).not.toContain('value="PAY_OUT"');
    expect(html).not.toContain(">Reverse<");
    expect(html).toContain('value="PAY_IN"');
  });
  it("server unavailable: no figure is estimated; a server without PFIN-D shows nothing at all", () => {
    const html = render({ status: "unavailable", reason: "OFFLINE", message: "offline" }, true);
    expect(html).not.toContain('data-testid="server-expected-cash"');
    expect(render({ status: "unavailable", reason: "NOT_INSTALLED", message: "x" }, true)).toBe("");
  });
});
