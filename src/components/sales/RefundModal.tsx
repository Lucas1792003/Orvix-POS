import type { RefundLine, RefundRequestPlan } from "../../features/sales/refundMath";
import { Modal } from "../ui/Modal";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { formatMmk, toNumber } from "../../lib/utils";

interface RefundModalProps {
  open: boolean;
  lines: RefundLine[];
  /** Line key → whole sold units to refund. */
  selection: Record<string, number>;
  plan: RefundRequestPlan;
  reason: string;
  productNames?: Record<string, string>;
  submitting?: boolean;
  onChangeSelection: (lineKey: string, units: number) => void;
  onChangeReason: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  /** Step 4 (PFIN-E): offered only when the server records refund lines. */
  lineDetail?: {
    noRestock: Record<string, boolean>;
    onToggleRestock: (lineKey: string, noRestock: boolean) => void;
    /** The sale's payment methods (a split sale); the refund is paid back with the chosen one. */
    payoutMethods: { method: string; label: string }[];
    payoutMethod: string | null;
    onChangePayout: (method: string) => void;
  };
}

export const RefundModal = ({
  open, lines, selection, plan, reason, productNames, submitting,
  onChangeSelection, onChangeReason, onClose, onSubmit, lineDetail,
}: RefundModalProps) => {
  const needsPayout = !!lineDetail && lineDetail.payoutMethods.length > 1 && !lineDetail.payoutMethod;
  const canSubmit = !submitting && plan.items.length > 0 && plan.errors.length === 0 && !needsPayout;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Partial refund"
      description="Choose how many of each line to refund. Amounts are what the customer paid, after discounts."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            Submit {plan.totalMmk > 0 ? formatMmk(plan.totalMmk) : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {lines.map((line) => {
          const soldUnits = line.soldBaseQty / line.unitsPerItem;
          const disabled = line.ambiguous || line.remainingSoldUnits === 0;
          return (
            <div key={line.key} className="flex items-center justify-between gap-3" data-testid={`refund-line-${line.key}`}>
              <div className="min-w-0 text-sm">
                <div className="truncate">{productNames?.[line.productId] ?? line.productId}</div>
                <div className="text-xs text-slate-500">
                  Sold {soldUnits} {line.unitLabel} · paid {formatMmk(line.netMmk)}
                  {line.claimedBaseQty > 0 && ` · ${line.remainingSoldUnits} ${line.unitLabel} left to refund`}
                </div>
                {line.ambiguous && (
                  <div className="text-xs text-amber-700">
                    This product is on more than one line of the sale; it cannot be partially refunded yet.
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {plan.amounts[line.key] !== undefined && (
                  <span className="text-xs text-slate-600">{formatMmk(plan.amounts[line.key])}</span>
                )}
                <Input
                  type="number"
                  min={0}
                  max={line.remainingSoldUnits}
                  step={1}
                  disabled={disabled}
                  aria-label={`Refund quantity for ${productNames?.[line.productId] ?? line.productId}`}
                  value={selection[line.key] ?? 0}
                  onChange={(event) =>
                    onChangeSelection(line.key, Math.max(0, Math.min(line.remainingSoldUnits, Math.trunc(toNumber(event.target.value)))))
                  }
                  className="w-24"
                />
                {lineDetail && (selection[line.key] ?? 0) > 0 && !line.key.includes("#") ? (
                  <label className="flex items-center gap-1 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={lineDetail.noRestock[line.key] === true}
                      onChange={(event) => lineDetail.onToggleRestock(line.key, event.target.checked)}
                      aria-label={`Do not return ${productNames?.[line.productId] ?? line.productId} to stock`}
                    />
                    Not back to stock
                  </label>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {plan.errors.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-red-700" role="alert">
          {plan.errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      )}
      {lineDetail && lineDetail.payoutMethods.length > 1 ? (
        <label className="mt-2 block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-600">Paid back as</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
            value={lineDetail.payoutMethod ?? ""}
            onChange={(event) => lineDetail.onChangePayout(event.target.value)}
            aria-label="Refund paid back as"
          >
            <option value="" disabled>Choose how the money goes back</option>
            {lineDetail.payoutMethods.map((m) => <option key={m.method} value={m.method}>{m.label}</option>)}
          </select>
          {needsPayout ? <span className="text-xs text-amber-700">This sale was paid in more than one way: choose how the refund is paid back.</span> : null}
        </label>
      ) : null}
      <Input value={reason} onChange={(event) => onChangeReason(event.target.value)} placeholder="Reason" />
    </Modal>
  );
};
