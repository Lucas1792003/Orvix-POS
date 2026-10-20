import type { Shift } from "../../types";
import { formatMmk } from "../../lib/utils";
import type { ShiftBreakdown } from "../../features/shifts/service";

interface ShiftSummaryProps {
  shift: Shift;
  breakdown: ShiftBreakdown;
}

export const ShiftSummary = ({ shift, breakdown }: ShiftSummaryProps) => {
  const {
    isOpen,
    cashSaleCount,
    otherSaleCount,
    cashTotal,
    otherTotal,
    voidedCount,
    approvedCashRefunds,
    expectedCash,
    salesCount,
  } = breakdown;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-2xl border border-slate-200/70 bg-slate-50/60 p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Payment breakdown</div>
        <div className="mt-2 grid grid-cols-[1fr_max-content] gap-x-6 gap-y-1 text-sm">
          <div>Cash sales ({cashSaleCount})</div>
          <div className="text-right tabular-nums">{formatMmk(cashTotal)}</div>
          <div>Other sales ({otherSaleCount})</div>
          <div className="text-right tabular-nums">{formatMmk(otherTotal)}</div>
          {approvedCashRefunds > 0 && (
            <>
              <div>Approved cash refunds</div>
              <div className="text-right tabular-nums">- {formatMmk(approvedCashRefunds)}</div>
            </>
          )}
          {voidedCount > 0 && (
            <>
              <div>Voided sales</div>
              <div className="text-right tabular-nums">{voidedCount}</div>
            </>
          )}
          <div className="font-medium">Sales count</div>
          <div className="text-right tabular-nums font-medium">{salesCount}</div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200/70 bg-slate-50/60 p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Cash reconciliation</div>
        <div className="mt-2 grid grid-cols-[1fr_max-content] gap-x-6 gap-y-1 text-sm">
          <div>Opening cash</div>
          <div className="text-right tabular-nums">{formatMmk(shift.openingCashMmk)}</div>
          <div>{isOpen ? "Expected cash (device estimate)" : "Expected cash"}</div>
          <div className="text-right tabular-nums">{formatMmk(expectedCash)}</div>
          <div>Closing cash</div>
          <div className="text-right tabular-nums">
            {isOpen ? "Active" : formatMmk(shift.closingCashMmk ?? 0)}
          </div>
          <div>Variance</div>
          <div className="text-right tabular-nums">
            {isOpen ? "Active" : formatMmk(shift.varianceMmk ?? 0)}
          </div>
        </div>
        {cashSaleCount === 0 && otherSaleCount > 0 && isOpen && (
          <div className="mt-2 text-xs text-slate-500">
            Non-cash sales do not increase expected cash. Closing cash should match opening cash.
          </div>
        )}
      </div>
    </div>
  );
};
