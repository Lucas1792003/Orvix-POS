import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// Batch 2A correction pass (Priority C): an UNCONFIRMED sale (its outcome
// is unknown — the server may not have it) never prints as a final receipt.
// Server rendering reads a store's initial state, so the data store is a
// plain selector over a fixed state here.
const sale = {
  id: "sale-1", shopId: "shop-1", shiftId: "shift-1", receiptNo: "PENDING", cashierId: "user-1", status: "NORMAL",
  subtotalMmk: 1000, discountMmk: 0, cartDiscountPct: 0, totalMmk: 1000, paymentMethod: "CASH", paidMmk: 1000, changeMmk: 0,
  createdAt: "2026-10-16T10:00:00Z", pendingSync: true,
};
const state: Record<string, unknown> = {};
vi.mock("../../stores/dataStore", () => ({
  useDataStore: (selector: (s: Record<string, unknown>) => unknown) => selector(state),
}));

import { ReceiptDetail } from "./ReceiptDetail";

const render = (over: Record<string, unknown>) => {
  Object.assign(state, {
    sales: [{ ...sale, ...over }],
    saleItems: [{ id: "si-1", saleId: "sale-1", productId: "p1", qtyUnits: 1, unitPriceMmk: 1000, lineTotalMmk: 1000 }],
    products: [], shops: [{ id: "shop-1", name: "Shop" }], users: [], reprintLogs: [], refunds: [],
    addReprintLog: async () => undefined, requestVoid: async () => undefined, requestRefund: async () => undefined,
    approveRefund: async () => undefined,
  });
  return renderToStaticMarkup(<MemoryRouter><ReceiptDetail saleId="sale-1" /></MemoryRouter>);
};
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)].map((m) => m[0]);
const printButtons = (markup: string) => buttons(markup).filter((b) => /Print|Reprint/.test(b));
// The HTML attribute, not the `disabled:` CSS variants in the class list.
const isDisabled = (button: string) => /\sdisabled=""/.test(button);

describe("ReceiptDetail for an unconfirmed sale", () => {
  it("printing is disabled and the cashier is told it is pending confirmation", () => {
    const markup = render({ pendingConfirmation: true });
    expect(markup).toContain("Pending confirmation");
    expect(printButtons(markup).length).toBeGreaterThan(0);
    for (const b of printButtons(markup)) expect(isDisabled(b)).toBe(true);
  });

  it("an ordinary offline (pending sync) sale still prints", () => {
    const markup = render({ pendingConfirmation: undefined });
    expect(markup).not.toContain("Pending confirmation");
    expect(printButtons(markup).length).toBeGreaterThan(0);
    expect(printButtons(markup).every((b) => !isDisabled(b))).toBe(true);
  });
});
