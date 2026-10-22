import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SaleItem } from "../../types";
import { buildRefundState, planRefundRequest } from "../../features/sales/refundMath";
import { RefundModal } from "./RefundModal";

const items: SaleItem[] = [
  { id: "i1", saleId: "sale-1", productId: "p1", qtyUnits: 2, unitPriceMmk: 5000, lineTotalMmk: 10000 },
  { id: "i2", saleId: "sale-1", productId: "p2", qtyUnits: 1, unitPriceMmk: 1000, lineTotalMmk: 1000 },
  { id: "i3", saleId: "sale-1", productId: "p2", qtyUnits: 12, unitPriceMmk: 900, lineTotalMmk: 900, unitsPerItem: 12, unitBaseQuantitySnapshot: 12 },
];
const state = buildRefundState({ id: "sale-1", status: "NORMAL", totalMmk: 9520 }, items, []); // 20% off 11,900
const render = (selection: Record<string, number>) =>
  renderToStaticMarkup(
    <RefundModal
      open lines={state.lines} selection={selection} plan={planRefundRequest(state, selection)} reason=""
      productNames={{ p1: "Tea", p2: "Rice" }}
      onChangeSelection={() => undefined} onChangeReason={() => undefined} onClose={() => undefined} onSubmit={() => undefined}
    />,
  );

describe("RefundModal", () => {
  it("shows the net amount per line and the request total, and enables Submit for a valid request", () => {
    const html = render({ i1: 1 });
    expect(html).toContain("MMK 8,000"); // Tea's line after the cart discount
    expect(html).toMatch(/<button[^>]*>Submit MMK 4,000<\/button>/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Submit/);
  });

  it("disables the inputs of a product that is on two lines, with the reason", () => {
    const html = render({});
    expect(html).toContain("cannot be partially refunded yet");
    expect(html.match(/aria-label="Refund quantity for Rice"[^>]*\sdisabled=""|\sdisabled=""[^>]*aria-label="Refund quantity for Rice"/g)?.length).toBe(2);
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Submit/); // nothing selected
  });
});

describe("RefundModal line detail (Step 4, PFIN-E)", () => {
  const renderDetail = (selection: Record<string, number>, payoutMethods: { method: string; label: string }[], payoutMethod: string | null) =>
    renderToStaticMarkup(
      <RefundModal
        open lines={state.lines} selection={selection} plan={planRefundRequest(state, selection)} reason=""
        productNames={{ p1: "Tea", p2: "Rice" }}
        onChangeSelection={() => undefined} onChangeReason={() => undefined} onClose={() => undefined} onSubmit={() => undefined}
        lineDetail={{ noRestock: {}, onToggleRestock: () => undefined, payoutMethods, payoutMethod, onChangePayout: () => undefined }}
      />,
    );
  it("offers 'not back to stock' only for a selected line", () => {
    const html = renderDetail({ i1: 1 }, [], null);
    expect(html).toContain('aria-label="Do not return Tea to stock"');
    expect(html).not.toContain('aria-label="Do not return Rice to stock"');
  });
  it("a split sale must name how the refund is paid back before it can be submitted", () => {
    const methods = [{ method: "CASH", label: "Cash" }, { method: "CARD", label: "Card" }];
    expect(renderDetail({ i1: 1 }, methods, null)).toMatch(/<button[^>]*\sdisabled=""[^>]*>Submit/);
    expect(renderDetail({ i1: 1 }, methods, "CARD")).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Submit/);
    // a single-method sale keeps the legacy rule: no payout choice is shown
    expect(renderDetail({ i1: 1 }, [{ method: "CASH", label: "Cash" }], null)).not.toContain("Paid back as");
  });
});
