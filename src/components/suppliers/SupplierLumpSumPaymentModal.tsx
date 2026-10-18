import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import { MoneyInput } from "../forms/MoneyInput";
import { formatDateTime, formatMmk } from "../../lib/utils";
import { getErrorMessage } from "../../lib/errors";
import { mayAlreadyBeRecorded, outcomeToast } from "../../lib/outcomeToast";
import { isUnresolvedOperation } from "../../stores/data/operationPrompt";
import { useDataStore } from "../../stores/dataStore";
import { useTranslation } from "../../hooks/useTranslation";
import { getPurchaseOrderBalanceMmk } from "../../features/suppliers/debt";
import {
  clearLumpSumRefusal, isLumpSumBalanceRefusal, markLumpSumRefusal, readLumpSumRefusal,
} from "../../features/suppliers/lumpSumRefusal";
import {
  checkPendingLumpSum, pendingLumpSumState, resendPendingLumpSum, type PendingLumpSum, type PendingState, type Resolution,
} from "../../features/suppliers/lumpSumOutcome";
import { useAuthStore } from "../../stores/authStore";
import { verifiedReload } from "../../stores/data/verifiedReload";
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
  const orgId = useAuthStore((state) => state.currentOrgId);
  const userId = useAuthStore((state) => state.currentUserId);
  const allPos = useDataStore((state) => state.purchaseOrders);
  // every purchase order of this supplier and shop: an in-doubt single-PO
  // payment of any of them blocks a lump sum too
  const supplierPoIds = useMemo(
    () => allPos.filter((po) => po.supplierId === supplier.id && po.shopId === shopId).map((po) => po.id).sort(),
    [allPos, supplier.id, shopId],
  );
  const poIdsRef = useRef<string[]>(supplierPoIds);
  poIdsRef.current = supplierPoIds;
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
  // A definitive balance refusal (owner decision: final, never retried):
  // the refused amount, and the server balance re-check that must complete
  // — and be confirmed by the cashier — before a NEW payment can be sent.
  // The refusal is kept on the till (lumpSumRefusal.ts): re-opening the
  // dialog, a restart or another window start from it again.
  const [refusal, setRefusal] = useState<{ amountMmk: number } | null>(null);
  const [recheck, setRecheck] = useState<"loading" | "done" | "failed" | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  // false until this opening has read the till's refusal record
  const [gateRead, setGateRead] = useState(false);
  const refusalRef = useRef(false);
  // An earlier lump sum of this supplier and shop whose outcome is UNKNOWN
  // (lumpSumOutcome.ts): nothing new is entered until the server answers for
  // its own key. null until this opening has read the till's records.
  const [pending, setPending] = useState<PendingState | null>(null);
  const [resolving, setResolving] = useState(false);
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  // each opening has its own number: an answer that arrives after the dialog
  // was closed (and maybe re-opened) never acts on the new opening
  const openingRef = useRef(0);
  const refreshPending = async (): Promise<PendingState> => {
    const state = await pendingLumpSumState(supplier.id, shopId, poIdsRef.current);
    setPending(state);
    return state;
  };
  // after a recorded payment: the server's balance, or a warning that it could not be reloaded
  const reloadAfterRecorded = async () => {
    if (!(await verifiedReload())) {
      toast({ variant: "warning", title: t("suppliers", "paymentRecordedShort"), description: t("suppliers", "lumpReloadFailed") });
    }
  };

  const recheckSeq = useRef(0);
  const recheckBalance = async () => {
    const mine = ++recheckSeq.current;            // only the latest re-check decides
    setRecheck("loading");
    setConfirmNew(false);
    const ok = await verifiedReload();
    if (mine === recheckSeq.current) setRecheck(ok ? "done" : "failed");
  };
  const enterRefusal = (amountMmk: number) => {
    refusalRef.current = true;
    setRefusal({ amountMmk });
    // the cashier enters the amount again against the refreshed balance
    setForm((p) => ({ ...p, amountMmk: 0 }));
    void recheckBalance();
  };

  useEffect(() => {
    // reset on CLOSE as well: a re-opened dialog never shows the previous
    // opening's state, even for one frame (it stays mounted while closed)
    refusalRef.current = false;
    setRefusal(null);
    setRecheck(null);
    setConfirmNew(false);
    setGateRead(false);
    setPending(null);
    setPendingNote(null);
    setResolving(false);
    const opening = ++openingRef.current;
    if (!open) return;
    let live = true;
    void readLumpSumRefusal(orgId, supplier.id, shopId).then((mark) => {
      if (!live) return;
      if (mark) enterRefusal(mark.amountMmk);
      setGateRead(true);
    });
    void pendingLumpSumState(supplier.id, shopId, poIdsRef.current).then((state) => { if (live && opening === openingRef.current) setPending(state); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening (and per signed-in user)
  }, [open, orgId, userId, supplier.id, shopId]);

  useEffect(() => {
    if (!open) return;
    // after a refusal the amount is never filled in for the cashier
    if (refusalRef.current) return;
    setForm({ amountMmk: totalOutstanding, paymentMethod: "CASH", referenceNo: "", notes: "" });
    setError(null);
    setSubmitting(false);
  }, [open, totalOutstanding]);

  const blockedByPending = pending === null || pending.kind !== "none";
  const blockedByRefusal = !gateRead || blockedByPending || (refusal !== null && (recheck !== "done" || !confirmNew));

  // The SERVER's answer for the earlier key decides; never a changed balance.
  const applyResolution = async (op: PendingLumpSum, res: Resolution, opening: number) => {
    if (opening !== openingRef.current) return;              // closed meanwhile: the next opening reads afresh
    if (res.kind === "recorded") {
      await clearLumpSumRefusal(orgId, supplier.id, shopId).catch(() => undefined);
      toast({ variant: "success", title: t("suppliers", "paymentRecordedShort"), description: t("suppliers", "lumpRecordedReloaded") });
      void reloadAfterRecorded();
      const state = await refreshPending();
      if (state.kind === "none" && opening === openingRef.current) onClose();
      return;
    }
    if (res.kind === "refused") {
      if (res.balanceRefusal) {
        const refused = op.amountMmk ?? 0;
        await markLumpSumRefusal(orgId, supplier.id, shopId, refused).catch(() => undefined);
        enterRefusal(refused);
        toast({ variant: "error", title: t("suppliers", "lumpRefusedTitle"), description: t("suppliers", "lumpRefusedBody", { amount: formatMmk(refused), name: supplier.name }) });
      } else {
        setError(t("suppliers", "lumpRejectedBody", { message: res.message }));
        toast({ variant: "error", title: t("suppliers", "lumpRefusedTitle"), description: res.message });
      }
      setPendingNote(null);
      await refreshPending();
      return;
    }
    if (res.kind === "stopped") {
      setPendingNote(t("suppliers", "lumpStopped"));
      await refreshPending();
      return;
    }
    setPendingNote(t("suppliers", "lumpStillUnknown", { reason: res.reason }));
    await refreshPending();
  };
  const resolvePending = async (op: PendingLumpSum, how: "check" | "resend") => {
    if (resolving) return;
    const opening = openingRef.current;
    setResolving(true);
    setPendingNote(null);
    try {
      await applyResolution(op, how === "check" ? await checkPendingLumpSum(op.id) : await resendPendingLumpSum(op.id), opening);
    } finally {
      if (opening === openingRef.current) setResolving(false);
    }
  };

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
    if (submitting || blockedByRefusal) return;
    if (form.amountMmk <= 0 || form.amountMmk > totalOutstanding) {
      setError(t("suppliers", "amountRange", { max: formatMmk(totalOutstanding) }));
      return;
    }
    setSubmitting(true);
    try {
      // a refusal recorded meanwhile (e.g. in another window of this till) gates this dialog too
      if (refusal === null) {
        const mark = await readLumpSumRefusal(orgId, supplier.id, shopId);
        if (mark) {
          enterRefusal(mark.amountMmk);
          return;
        }
      }
      // an unconfirmed payment recorded meanwhile (another window, a restart) blocks this one too
      if ((await refreshPending()).kind !== "none") return;
      const opening = openingRef.current;
      const recorded = await paySupplierLumpSum({
        supplierId: supplier.id,
        shopId,
        amountMmk: form.amountMmk,
        paymentMethod: form.paymentMethod,
        referenceNo: form.referenceNo || undefined,
        notes: form.notes || undefined,
      });
      // a NEW payment was recorded: the refusal no longer gates this supplier
      await clearLumpSumRefusal(orgId, supplier.id, shopId).catch(() => undefined);
      toast({
        variant: "success",
        title: t("suppliers", "paymentRecordedShort"),
        description: recorded.replyAvailable
          ? t("suppliers", "allocatedTo", { amount: formatMmk(form.amountMmk), name: supplier.name })
          : t("suppliers", "lumpRecordedReloaded"),
      });
      if (!recorded.replyAvailable) void reloadAfterRecorded();
      if (opening === openingRef.current) onClose();
    } catch (err) {
      if (isLumpSumBalanceRefusal(err)) {
        // Final: nothing recorded, and this attempt is never sent again.
        const refused = form.amountMmk;
        await markLumpSumRefusal(orgId, supplier.id, shopId, refused).catch(() => undefined);
        enterRefusal(refused);
        toast({
          variant: "error",
          title: t("suppliers", "lumpRefusedTitle"),
          description: t("suppliers", "lumpRefusedBody", { amount: formatMmk(refused), name: supplier.name }),
        });
        return;
      }
      // any other failure: a further attempt is confirmed again
      setConfirmNew(false);
      if (mayAlreadyBeRecorded(err) || isUnresolvedOperation(err)) {
        // Unknown outcome (or an earlier attempt still undecided): never
        // "payment failed". The dialog stays and shows what is unconfirmed;
        // nothing new can be entered until the server answers for its key.
        // If nothing is unconfirmed any more (decided meanwhile, e.g. in
        // another window), the dialog closes and reloads: it is never left
        // with a filled, sendable form after an unknown outcome.
        toast(mayAlreadyBeRecorded(err)
          ? { variant: "warning", title: t("suppliers", "lumpUnknownTitle"), description: getErrorMessage(err, t("suppliers", "couldNotRecord")) }
          : outcomeToast(err, t, t("suppliers", "paymentFailed"), t("suppliers", "couldNotRecord")));
        const state = await refreshPending();
        if (state.kind === "none") {
          void verifiedReload();
          onClose();
        }
        return;
      }
      toast(outcomeToast(err, t, t("suppliers", "paymentFailed"), t("suppliers", "couldNotRecord")));
      setError(getErrorMessage(err, t("suppliers", "couldNotRecord")));
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

        {pending?.kind === "pending" && (
          <div role="alert" data-testid="lump-unknown" className="space-y-2 rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <div className="font-semibold">{t("suppliers", "lumpUnknownTitle")}</div>
            {pending.ops.map((op) => (
              <div key={op.id} className="space-y-1">
                <div>{t("suppliers", "lumpUnknownBody", { amount: op.amountMmk === null ? "?" : formatMmk(op.amountMmk), name: supplier.name, time: formatDateTime(op.createdAt) })}</div>
                {!op.mine && <div>{t("suppliers", "lumpUnknownOther")}</div>}
                <div className="flex flex-wrap gap-2">
                  {op.checkable && (
                    <Button size="sm" variant="secondary" disabled={resolving} onClick={() => void resolvePending(op, "check")}>
                      {resolving ? t("suppliers", "lumpChecking") : t("suppliers", "lumpCheckServer")}
                    </Button>
                  )}
                  {op.mine && op.retryable && (
                    <Button size="sm" variant="secondary" disabled={resolving} onClick={() => void resolvePending(op, "resend")}>{t("suppliers", "lumpResendSame")}</Button>
                  )}
                </div>
              </div>
            ))}
            {pendingNote && <div>{pendingNote}</div>}
            <div className="text-xs">{t("suppliers", "lumpOwnerHint")}</div>
          </div>
        )}
        {pending?.kind === "po-pending" && (
          <div role="alert" data-testid="lump-blocked-by-po" className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <div className="font-semibold">{t("suppliers", "lumpUnknownTitle")}</div>
            <div>{t("suppliers", "lumpBlockedByPoPayment")}</div>
          </div>
        )}
        {pending?.kind === "unreadable" && (
          <div role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <div className="font-semibold">{t("suppliers", "lumpUnknownTitle")}</div>
            <div>{t("suppliers", "lumpPendingUnreadable")}</div>
          </div>
        )}
        {pending?.kind === "none" && pendingNote && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{pendingNote}</div>
        )}

        {refusal && (
          <div role="alert" className="space-y-2 rounded-2xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            <div className="font-semibold">{t("suppliers", "lumpRefusedTitle")}</div>
            <div>{t("suppliers", "lumpRefusedBody", { amount: formatMmk(refusal.amountMmk), name: supplier.name })}</div>
            {recheck === "loading" && <div>{t("suppliers", "lumpRecheckLoading")}</div>}
            {recheck === "failed" && (
              <div className="flex flex-wrap items-center gap-2">
                <span>{t("suppliers", "lumpRecheckFailed")}</span>
                <Button size="sm" variant="secondary" onClick={() => void recheckBalance()}>{t("suppliers", "lumpRecheckAgain")}</Button>
              </div>
            )}
            {recheck === "done" && (
              <>
                <div>{t("suppliers", "lumpRecheckDone", { amount: formatMmk(totalOutstanding) })}</div>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={confirmNew} onChange={(e) => setConfirmNew(e.target.checked)} />
                  <span>{t("suppliers", "lumpConfirmNew")}</span>
                </label>
              </>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>{t("common", "cancel")}</Button>
          <Button onClick={handleSubmit} disabled={submitting || blockedByRefusal || form.amountMmk <= 0 || form.amountMmk > totalOutstanding}>
            {submitting ? t("suppliers", "recording") : t("suppliers", "recordPayment")}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
