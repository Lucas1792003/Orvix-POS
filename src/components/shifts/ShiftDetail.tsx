import type { ReactNode } from "react";
import type { Role, Sale, Shift } from "../../types";
import { Badge } from "../ui/Badge";
import { formatDateTime, formatMmk } from "../../lib/utils";
import type { ShiftBreakdown } from "../../features/shifts/service";
import { formatDuration, getShiftDurationMs } from "../../features/shifts/workHours";

interface ShiftDetailProps {
  shift: Shift;
  cashierName?: string;
  cashierRole?: Role;
  shopName?: string;
  breakdown: ShiftBreakdown;
  sales?: Sale[];
  now?: Date;
}

const ROLE_TONES: Record<Role, "amber" | "red" | "green" | "blue" | "slate"> = {
  ADMIN: "red",
  MANAGER: "amber",
  CASHIER: "green",
  BUYER: "blue",
};

const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <>
    <div className="text-slate-500">{label}</div>
    <div className="text-right tabular-nums text-slate-800">{value}</div>
  </>
);

export const ShiftDetail = ({
  shift,
  cashierName,
  cashierRole,
  shopName,
  breakdown,
  sales = [],
  now = new Date(),
}: ShiftDetailProps) => {
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
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
        <Row label="Cashier" value={cashierName ?? "Unknown user"} />
        {cashierRole && (
          <Row label="Role" value={<Badge tone={ROLE_TONES[cashierRole]}>{cashierRole}</Badge>} />
        )}
        <Row label="Shop" value={shopName ?? shift.shopId} />
        <Row label="Status" value={isOpen ? "Open" : "Closed"} />
        <Row label="Started" value={formatDateTime(shift.startedAt)} />
        <Row label="Ended" value={shift.endedAt ? formatDateTime(shift.endedAt) : "Active"} />
        <Row label="Duration" value={formatDuration(getShiftDurationMs(shift, now))} />
      </div>

      <div className="rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Payment breakdown</div>
        <div className="mt-2 grid grid-cols-[1fr_max-content] gap-x-6 gap-y-1">
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

      <div className="rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Cash reconciliation</div>
        <div className="mt-2 grid grid-cols-[1fr_max-content] gap-x-6 gap-y-1">
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
      </div>

      {shift.varianceReason && (
        <div className="rounded-2xl border border-slate-200/70 bg-white p-3 text-slate-600">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Variance reason</div>
          <div className="mt-1">{shift.varianceReason}</div>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200/70 bg-white">
        <div className="border-b border-slate-100 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          Sales in this shift
        </div>
        {sales.length === 0 ? (
          <div className="px-3 py-4 text-sm text-slate-500">No sales were recorded in this shift.</div>
        ) : (
          <div className="max-h-72 overflow-auto">
            <table className="w-full min-w-[560px] text-sm text-slate-700">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Receipt</th>
                  <th className="px-3 py-2 font-semibold">Time</th>
                  <th className="px-3 py-2 font-semibold">Payment</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sales
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((sale) => (
                    <tr key={sale.id}>
                      <td className="px-3 py-2 font-medium text-slate-800">#{sale.receiptNo}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">{formatDateTime(sale.createdAt)}</td>
                      <td className="px-3 py-2">{sale.paymentMethod}</td>
                      <td className="px-3 py-2">
                        <Badge tone={sale.status === "VOID" ? "red" : "green"}>{sale.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatMmk(sale.status === "VOID" ? 0 : sale.totalMmk)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
