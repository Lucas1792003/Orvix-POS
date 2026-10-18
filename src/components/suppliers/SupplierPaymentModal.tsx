import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import { MoneyInput } from "../forms/MoneyInput";
import { formatMmk } from "../../lib/utils";
import { getErrorMessage } from "../../lib/errors";
import { mayAlreadyBeRecorded, outcomeToast } from "../../lib/outcomeToast";
import { isUnresolvedOperation } from "../../stores/data/operationPrompt";
import { useDataStore } from "../../stores/dataStore";
import { useTranslation } from "../../hooks/useTranslation";
import { getPurchaseOrderBalanceMmk } from "../../features/suppliers/debt";
import { supplierPaymentMethods } from "../../features/suppliers/uiConstants";
import { inDoubtPoPayments, pendingLumpSumState, type PendingState } from "../../features/suppliers/lumpSumOutcome";
import type { PurchaseOrder, SupplierPaymentMethod } from "../../types";

interface SupplierPaymentModalProps {
  // PO to record a payment against. When null, the modal is closed.
  purchaseOrder: PurchaseOrder | null;
  onClose: () => void;
}

interface FormState {
  amountMmk: number;
  paymentMethod: SupplierPaymentMethod;
  referenceNo: string;
  notes: string;
}

export const SupplierPaymentModal = ({ purchaseOrder, onClose }: SupplierPaymentModalProps) => {
  const recordSupplierPayment = useDataStore((state) => state.recordSupplierPayment);
  const toast = useToast();
  const { t } = useTranslation();

  const balance = purchaseOrder ? getPurchaseOrderBalanceMmk(purchaseOrder) : 0;

  const [form, setForm] = useState<FormState>({
    amountMmk: 0,
    paymentMethod: "CASH",
    referenceNo: "",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed every time a new PO is selected. Default to outstanding balance
  // because paying a PO in full is the common case; the user can adjust down.
  useEffect(() => {
    if (!purchaseOrder) return;
    setForm({
      amountMmk: balance,
      paymentMethod: "CASH",
      referenceNo: "",
      notes: "",
    });
    setError(null);
    setSubmitting(false);
    // We re-seed only when the *target* PO changes — balance recalculates from
    // it. Including `balance` in deps would re-seed after each successful
    // payment update, which is what we want anyway since the modal closes.
  }, [purchaseOrder, balance]);

  // A lump sum to this supplier whose outcome is unknown may already have paid
  // this PO: no payment here until the server has answered for it (it is
  // checked in the lump-sum dialog or on the Sync page). Read on every
  // opening and again at submit; an unreadable store blocks too.
  // Likewise an earlier payment of THIS purchase order whose outcome is
  // unknown (in doubt in the queue, any amount): it may have paid what is
  // shown as owed.
  const [lumpPending, setLumpPending] = useState<PendingState | null>(null);
  const [poInDoubt, setPoInDoubt] = useState<number | null>(null);
  const poId = purchaseOrder?.id ?? null;
  const poSupplierId = purchaseOrder?.supplierId ?? null;
  const poShopId = purchaseOrder?.shopId ?? null;
  const readGuards = async (id: string, supplierId: string, shopId: string) => {
    const [lump, own] = await Promise.all([
      pendingLumpSumState(supplierId, shopId),
      inDoubtPoPayments([id]).catch(() => 1),                // unreadable queue: fail closed
    ]);
    return { lump, own };
  };
  useEffect(() => {
    setLumpPending(null);
    setPoInDoubt(null);
    if (!poId || !poSupplierId || !poShopId) return;
    let live = true;
    void readGuards(poId, poSupplierId, poShopId).then(({ lump, own }) => {
      if (!live) return;
      setLumpPending(lump);
      setPoInDoubt(own);
    });
    return () => { live = false; };
  }, [poId, poSupplierId, poShopId]);
  const blockedByLumpSum = lumpPending === null || lumpPending.kind !== "none" || poInDoubt === null || poInDoubt > 0;

  const requestClose = () => {
    if (submitting) return;
    setError(null);
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);
    if (!purchaseOrder) return;
    if (submitting) return;
    if (purchaseOrder.status !== "RECEIVED") {
      setError(t("suppliers", "onlyReceivedPaid"));
      return;
    }
    if (form.amountMmk <= 0 || form.amountMmk > balance) {
      setError(t("suppliers", "amountRange", { max: formatMmk(balance) }));
      return;
    }
    if (blockedByLumpSum) return;
    setSubmitting(true);
    try {
      const { lump, own } = await readGuards(purchaseOrder.id, purchaseOrder.supplierId, purchaseOrder.shopId);
      setLumpPending(lump);
      setPoInDoubt(own);
      if (lump.kind !== "none" || own > 0) return;
      await recordSupplierPayment({
        purchaseOrderId: purchaseOrder.id,
        amountMmk: form.amountMmk,
        paymentMethod: form.paymentMethod,
        referenceNo: form.referenceNo || undefined,
        notes: form.notes || undefined,
      });
      toast({
        variant: "success",
        title: t("suppliers", "paymentRecorded"),
        description: t("suppliers", "poUpdated", { orderNo: purchaseOrder.orderNo }),
      });
      onClose();
    } catch (err) {
      if (mayAlreadyBeRecorded(err) || isUnresolvedOperation(err)) {
        // Unknown outcome / an earlier attempt still undecided / recorded
        // meanwhile: never "payment failed", and the form is not left filled
        // in — the dialog closes; re-opened, it is blocked while a payment of
        // this purchase order is in doubt.
        toast(outcomeToast(err, t, t("suppliers", "paymentFailed"), t("suppliers", "couldNotRecord")));
        onClose();
        return;
      }
      const message = getErrorMessage(err, t("suppliers", "couldNotRecord"));
      setError(message);
      toast({ variant: "error", title: t("suppliers", "paymentFailed"), description: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={Boolean(purchaseOrder)}
      onClose={requestClose}
      title={t("suppliers", "payTitle")}
      description={purchaseOrder?.orderNo}
    >
      {purchaseOrder && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">{t("suppliers", "total")}</div>
                <div className="mt-0.5 font-semibold">{formatMmk(purchaseOrder.totalMmk)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">{t("suppliers", "outstanding")}</div>
                <div className="mt-0.5 font-semibold text-rose-700">{formatMmk(balance)}</div>
              </div>
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">{t("suppliers", "amount")}</span>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <MoneyInput
                  value={form.amountMmk}
                  onChange={(value) => setForm((prev) => ({ ...prev, amountMmk: value ?? 0 }))}
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setForm((prev) => ({ ...prev, amountMmk: balance }))}
                disabled={balance <= 0}
              >
                {t("suppliers", "payOutstanding")}
              </Button>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {t("suppliers", "outstandingBalanceLine", { amount: formatMmk(balance) })}
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">{t("suppliers", "paymentMethod")}</span>
            <Select
              value={form.paymentMethod}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, paymentMethod: event.target.value as SupplierPaymentMethod }))
              }
            >
              {supplierPaymentMethods.map((method) => (
                <option key={method.value} value={method.value}>
                  {method.label}
                </option>
              ))}
            </Select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">{t("suppliers", "referenceNo")}</span>
            <input
              type="text"
              value={form.referenceNo}
              onChange={(event) => setForm((prev) => ({ ...prev, referenceNo: event.target.value }))}
                className="min-h-11 w-full rounded-lg border px-3 py-2 text-sm"
              placeholder={t("suppliers", "referencePlaceholder")}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">{t("suppliers", "notes")}</span>
            <textarea
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              className="min-h-24 w-full rounded-lg border px-3 py-2 text-sm"
              rows={2}
              placeholder={t("suppliers", "notesPlaceholder")}
            />
          </label>

          {lumpPending !== null && lumpPending.kind !== "none" && lumpPending.kind !== "po-pending" && (
            <div role="alert" data-testid="po-blocked-by-lump-sum" className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {t("suppliers", "poBlockedByLumpSum")}
            </div>
          )}
          {poInDoubt !== null && poInDoubt > 0 && (
            <div role="alert" data-testid="po-payment-unknown" className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <div className="font-semibold">{t("suppliers", "lumpUnknownTitle")}</div>
              <div>{t("suppliers", "poPaymentUnknown")}</div>
            </div>
          )}
          {error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="secondary" disabled={submitting} onClick={requestClose}>
              {t("common", "cancel")}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || blockedByLumpSum || form.amountMmk <= 0 || form.amountMmk > balance}
            >
              {submitting ? t("suppliers", "recording") : t("suppliers", "recordPayment")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
};
