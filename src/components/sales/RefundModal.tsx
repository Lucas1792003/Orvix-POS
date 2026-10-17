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
}

export const RefundModal = ({
  open, lines, selection, plan, reason, productNames, submitting,
  onChangeSelection, onChangeReason, onClose, onSubmit,
}: RefundModalProps) => {
  const canSubmit = !submitting && plan.items.length > 0 && plan.errors.length === 0;
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
      <Input value={reason} onChange={(event) => onChangeReason(event.target.value)} placeholder="Reason" />
    </Modal>
  );
};
