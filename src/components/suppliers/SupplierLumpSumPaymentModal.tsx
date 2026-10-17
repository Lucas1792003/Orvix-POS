import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import { MoneyInput } from "../forms/MoneyInput";
import { formatMmk } from "../../lib/utils";
import { getErrorMessage } from "../../lib/errors";
import { mayAlreadyBeRecorded, outcomeToast } from "../../lib/outcomeToast";
import { useDataStore } from "../../stores/dataStore";
import { useTranslation } from "../../hooks/useTranslation";
import { getPurchaseOrderBalanceMmk } from "../../features/suppliers/debt";
import { supplierPaymentMethods } from "../../features/suppliers/uiConstants";
import type { PurchaseOrder, Supplier, SupplierPaymentMethod } from "../../types";

interface SupplierLumpSumPaymentModalProps {
  open: boolean;
  onClose: () => void;
  supplier: Supplier;
  shopId: string;
  /** Supplier's RECEIVED POs in this shop with an outstanding balance. */
  outstandingPos: PurchaseOrder[];
}

interface FormState {
  amountMmk: number;
  paymentMethod: SupplierPaymentMethod;
  referenceNo: string;
  notes: string;
}

export const SupplierLumpSumPaymentModal = ({
  open,
  onClose,
  supplier,
  shopId,
  outstandingPos,
}: SupplierLumpSumPaymentModalProps) => {
  const paySupplierLumpSum = useDataStore((state) => state.paySupplierLumpSum);
  const toast = useToast();
  const { t } = useTranslation();

  // Oldest-first — mirrors the server's allocation order.
  const orderedPos = useMemo(
    () => [...outstandingPos].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [outstandingPos],
  );
  const totalOutstanding = useMemo(
    () => orderedPos.reduce((sum, po) => sum + getPurchaseOrderBalanceMmk(po), 0),
    [orderedPos],
  );

  const [form, setForm] = useState<FormState>({
    amountMmk: 0,
    paymentMethod: "CASH",
    referenceNo: "",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ amountMmk: totalOutstanding, paymentMethod: "CASH", referenceNo: "", notes: "" });
    setError(null);
    setSubmitting(false);
  }, [open, totalOutstanding]);

  // Preview how the entered amount lands across POs (oldest-first).
  const allocation = useMemo(() => {
    let remaining = form.amountMmk;
    return orderedPos.map((po) => {
      const bal = getPurchaseOrderBalanceMmk(po);
      const apply = Math.max(0, Math.min(remaining, bal));
      remaining -= apply;
      return { po, apply };
    });
  }, [orderedPos, form.amountMmk]);

  const handleSubmit = async () => {
    setError(null);
    if (submitting) return;
    if (form.amountMmk <= 0 || form.amountMmk > totalOutstanding) {
      setError(t("suppliers", "amountRange", { max: formatMmk(totalOutstanding) }));
      return;
    }
    setSubmitting(true);
    try {
      await paySupplierLumpSum({
        supplierId: supplier.id,
        shopId,
        amountMmk: form.amountMmk,
        paymentMethod: form.paymentMethod,
        referenceNo: form.referenceNo || undefined,
        notes: form.notes || undefined,
      });
      toast({
        variant: "success",
        title: t("suppliers", "paymentRecordedShort"),
        description: t("suppliers", "allocatedTo", { amount: formatMmk(form.amountMmk), name: supplier.name }),
      });
      onClose();
    } catch (err) {
      // Unknown outcome → "pending confirmation", never "payment failed";
      // the form closes so the same payment is not entered again.
      toast(outcomeToast(err, t, t("suppliers", "paymentFailed"), t("suppliers", "couldNotRecord")));
      if (mayAlreadyBeRecorded(err)) {
        onClose();
      } else {
        setError(getErrorMessage(err, t("suppliers", "couldNotRecord")));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={() => (submitting ? undefined : onClose())} title={t("suppliers", "paySupplierTitle")} description={supplier.name} size="lg">
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-slate-500">{t("suppliers", "totalOutstanding")}</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-rose-700">{formatMmk(totalOutstanding)}</div>
          <div className="mt-1 text-xs text-slate-500">
            {t("suppliers", "unpaidPosLine", { n: orderedPos.length })}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">{t("suppliers", "amount")}</span>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <MoneyInput value={form.amountMmk} onChange={(value) => setForm((p) => ({ ...p, amountMmk: value ?? 0 }))} />
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setForm((p) => ({ ...p, amountMmk: totalOutstanding }))}
              disabled={totalOutstanding <= 0}
            >
              {t("suppliers", "payAll")}
            </Button>
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">{t("suppliers", "paymentMethod")}</span>
          <Select
            value={form.paymentMethod}
            onChange={(e) => setForm((p) => ({ ...p, paymentMethod: e.target.value as SupplierPaymentMethod }))}
          >
            {supplierPaymentMethods.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">{t("suppliers", "referenceNo")}</span>
          <input
            type="text"
            value={form.referenceNo}
            onChange={(e) => setForm((p) => ({ ...p, referenceNo: e.target.value }))}
            className="min-h-11 w-full rounded-lg border px-3 py-2 text-sm"
            placeholder={t("suppliers", "referencePlaceholder")}
          />
        </label>

        {/* Allocation preview — which invoices this amount settles, oldest-first. */}
        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t("suppliers", "allocation")}
          </div>
          <div className="max-h-48 overflow-y-auto">
            {allocation.map(({ po, apply }) => (
              <div key={po.id} className="flex items-center justify-between gap-3 border-b border-slate-50 px-3 py-2 text-sm last:border-0">
                <span className="min-w-0 truncate text-slate-700">{po.orderNo}</span>
                <span className={`shrink-0 tabular-nums ${apply > 0 ? "font-semibold text-emerald-700" : "text-slate-400"}`}>
                  {formatMmk(apply)}<span className="text-slate-400"> / {formatMmk(getPurchaseOrderBalanceMmk(po))}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>{t("common", "cancel")}</Button>
          <Button onClick={handleSubmit} disabled={submitting || form.amountMmk <= 0 || form.amountMmk > totalOutstanding}>
            {submitting ? t("suppliers", "recording") : t("suppliers", "recordPayment")}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
