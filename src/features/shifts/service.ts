import { cashPartOf } from "../finance/payments";
import type { Refund, Sale, Shift } from "../../types";

/**
 * Single source of truth for the shift summary numbers the manager modal
 * and the cashier card both display. Mirrors the close_shift RPC formula:
 *   expected_cash = opening_cash + CASH sales (status<>VOID) - approved
 *                   PARTIAL refunds against CASH sales of this shift.
 */
export const buildShiftBreakdown = (
  shift: Shift,
  shiftSales: Sale[],
  refundRequests: Refund[] = []
) => {
  const activeSales = shiftSales.filter((sale) => sale.status !== "VOID");
  const cashSales = activeSales.filter((sale) => sale.paymentMethod === "CASH");
  const otherSales = activeSales.filter((sale) => sale.paymentMethod !== "CASH");
  // Step 4: a split sale known to this device counts only its CASH part as cash (cashPartOf)
  const cashTotal = activeSales.reduce((sum, sale) => sum + cashPartOf(sale), 0);
  const otherTotal = activeSales.reduce((sum, sale) => sum + sale.totalMmk, 0) - cashTotal;
  const voidedCount = shiftSales.length - activeSales.length;

  const cashSaleIds = new Set(cashSales.map((sale) => sale.id));
  const approvedCashRefunds = refundRequests
    .filter((r) => r.status === "APPROVED" && r.type === "PARTIAL" && cashSaleIds.has(r.saleId))
    .reduce((sum, r) => sum + (r.items ?? []).reduce((s, item) => s + item.amountMmk, 0), 0);

  const isOpen = !shift.endedAt;
  const liveExpectedCash = shift.openingCashMmk + cashTotal - approvedCashRefunds;
  const expectedCash = isOpen ? liveExpectedCash : shift.expectedCashMmk ?? liveExpectedCash;

  return {
    isOpen,
    cashSaleCount: cashSales.length,
    otherSaleCount: otherSales.length,
    cashTotal,
    otherTotal,
    voidedCount,
    approvedCashRefunds,
    expectedCash,
    salesCount: shiftSales.length,
  };
};

export type ShiftBreakdown = ReturnType<typeof buildShiftBreakdown>;
