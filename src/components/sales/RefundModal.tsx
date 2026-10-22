import type { RefundLine, RefundRequestPlan } from "../../features/sales/refundMath";
import { Modal } from "../ui/Modal";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { formatMmk, toNumber } from "../../lib/utils";
import { useTranslation } from "../../hooks/useTranslation";

/**
 * Step 6 (PFIN-F): the refund as the SERVER plans it (fin_refund_plan): the default amount of each line and the
 * default payout by the original payment methods. A manager (the server's canProposeExceptions) may propose a payout by
 * other methods and / or other line amounts; each needs a separate Shop Admin approval before the refund is approved.
 */
export interface SplitRefundView {
  status: "loading" | "ok" | "error";
  message?: string;
  /** Line key (sale_items id) → the server's default refund amount. */
  defaults: Record<string, number>;
  /** Line key → the most this line can still give back (whole MMK). */
  lineMax: Record<string, number>;
  /** How the money goes back by default (null: as the sale was paid — a single-method sale). */
  defaultPayouts: { method: string; amountMmk: number }[] | null;
  methodLabel: (method: string) => string;
  canPropose: boolean;
  altOn: boolean;
  onToggleAlt: (on: boolean) => void;
  altMethods: string[];
  altAmounts: Record<string, string>;
  onChangeAlt: (method: string, value: string) => void;
  adjustOn: boolean;
  onToggleAdjust: (on: boolean) => void;
  adjusted: Record<string, string>;
  onChangeAdjusted: (lineKey: string, value: string) => void;
  /** The refund total as it would be requested. */
  totalMmk: number;
  /** Why it cannot be submitted as it stands (shown), or null. */
  problem: string | null;
}

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
  /** Step 6 (PFIN-F): when the server plans the refund, it replaces the client's amounts and the payout choice. */
  splitRefund?: SplitRefundView;
}

export const RefundModal = ({
  open, lines, selection, plan, reason, productNames, submitting,
  onChangeSelection, onChangeReason, onClose, onSubmit, lineDetail, splitRefund,
}: RefundModalProps) => {
  const { t } = useTranslation();
  const split = splitRefund;
  const needsPayout = !split && !!lineDetail && lineDetail.payoutMethods.length > 1 && !lineDetail.payoutMethod;
  const splitReady = !split || (split.status === "ok" && !split.problem);
  const canSubmit = !submitting && plan.items.length > 0 && plan.errors.length === 0 && !needsPayout && splitReady;
  const shownTotal = split ? (split.status === "ok" ? split.totalMmk : 0) : plan.totalMmk;
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
            Submit {shownTotal > 0 ? formatMmk(shownTotal) : ""}
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
                {split ? (
                  split.status === "ok" && split.defaults[line.key] !== undefined ? (
                    split.adjustOn && split.canPropose ? (
                      <Input
                        inputMode="numeric"
                        aria-label={`${t("fin6", "adjustAmount")} — ${productNames?.[line.productId] ?? line.productId}`}
                        value={split.adjusted[line.key] ?? String(split.defaults[line.key])}
                        onChange={(event) => split.onChangeAdjusted(line.key, event.target.value.replace(/[^\d]/g, ""))}
                        title={t("fin6", "lineLeft", { max: formatMmk(split.lineMax[line.key] ?? 0) })}
                        className="w-28"
                      />
                    ) : (
                      <span className="text-xs text-slate-600" data-testid={`refund-default-${line.key}`}>{formatMmk(split.defaults[line.key])}</span>
                    )
                  ) : null
                ) : plan.amounts[line.key] !== undefined && (
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
      {split && plan.items.length > 0 && plan.errors.length === 0 ? (
        <div className="mt-3 space-y-2 rounded-xl border border-slate-200 p-3 text-sm" data-testid="split-refund">
          {split.status === "loading" ? (
            <div className="text-xs text-slate-500">{t("fin6", "planLoading")}</div>
          ) : split.status === "error" ? (
            <div className="text-xs text-red-700" role="alert">{t("fin6", "planUnavailable", { message: split.message ?? "" })}</div>
          ) : (
            <>
              <div className="flex items-center justify-between font-medium text-slate-700">
                <span>{t("fin6", "refundTotal")}</span>
                <span>{formatMmk(split.totalMmk)}</span>
              </div>
              {!split.altOn ? (
                <div className="text-xs text-slate-600" data-testid="refund-default-payouts">
                  {split.defaultPayouts && split.defaultPayouts.length > 0
                    ? t("fin6", "payoutDefault", { list: split.defaultPayouts.map((p) => `${split.methodLabel(p.method)} ${formatMmk(p.amountMmk)}`).join(" · ") })
                    : t("fin6", "payoutLegacy")}
                </div>
              ) : null}
              {split.canPropose ? (
                <div className="space-y-2 border-t border-slate-100 pt-2">
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input type="checkbox" checked={split.altOn} onChange={(event) => split.onToggleAlt(event.target.checked)} />
                    <span><span className="font-medium">{t("fin6", "altPayout")}</span> — {t("fin6", "exceptionNote")}</span>
                  </label>
                  {split.altOn ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {split.altMethods.map((m) => (
                        <label key={m} className="block text-xs text-slate-600">
                          <span className="mb-1 block">{split.methodLabel(m)}</span>
                          <Input
                            inputMode="numeric"
                            aria-label={`${t("fin6", "altPayout")} — ${split.methodLabel(m)}`}
                            value={split.altAmounts[m] ?? ""}
                            onChange={(event) => split.onChangeAlt(m, event.target.value.replace(/[^\d]/g, ""))}
                            placeholder="0"
                          />
                        </label>
                      ))}
                    </div>
                  ) : null}
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input type="checkbox" checked={split.adjustOn} onChange={(event) => split.onToggleAdjust(event.target.checked)} />
                    <span><span className="font-medium">{t("fin6", "adjustAmount")}</span> — {t("fin6", "exceptionNote")}</span>
                  </label>
                </div>
              ) : null}
              {split.problem ? <div className="text-xs text-amber-700" role="alert">{split.problem}</div> : null}
            </>
          )}
        </div>
      ) : null}
      {!split && lineDetail && lineDetail.payoutMethods.length > 1 ? (
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
