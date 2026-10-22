import { useEffect, useMemo, useState } from "react";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { formatMmk, normalizeAmountInput, toNumber } from "../../lib/utils";
import { useTranslation } from "../../hooks/useTranslation";
import {
  finCapabilities, knownFinCapabilities, MAX_PAYMENTS, planPayments, SPLIT_METHODS,
  type CanonicalPart, type PaymentProblem, type SplitMethod,
} from "../../features/finance/finCompletion";

interface PaymentModalProps {
  open: boolean;
  totalMmk: number;
  loading?: boolean;
  validationError?: string;
  onClose: () => void;
  /** `payments` only for a split / mixed payment (Step 4, PFIN-D); method and paid are then derived from it. */
  onConfirm: (method: "CASH" | "OTHER", paid: number, payments?: CanonicalPart[]) => void | Promise<void>;
}

interface SplitRow { method: SplitMethod; amount: string; tendered: string; reference: string }

const METHOD_KEY: Record<SplitMethod, string> = {
  CASH: "methodCash", BANK_TRANSFER: "methodBank", MOBILE_WALLET: "methodWallet", CARD: "methodCard", OTHER: "methodOther",
};

export const PaymentModal = ({
  open,
  totalMmk,
  loading = false,
  validationError,
  onClose,
  onConfirm,
}: PaymentModalProps) => {
  const { t } = useTranslation();
  const [method, setMethod] = useState<"CASH" | "OTHER">("CASH");
  // String-backed input so we can keep the field empty while editing and
  // never sit on a padded "02900". toNumber("") -> 0 for calculations.
  const [paidInput, setPaidInput] = useState("0");
  // Step 4: split / mixed payment — offered only when this server supports it (fin_capabilities)
  const [splitAvailable, setSplitAvailable] = useState(() => knownFinCapabilities().splitPayments);
  const [split, setSplit] = useState(false);
  const [rows, setRows] = useState<SplitRow[]>([]);

  const paid = toNumber(paidInput);
  const change = Math.max(0, paid - totalMmk);
  const isUnderpaid = paid < totalMmk;

  const splitParts = useMemo(() => rows.map((r) => ({
    method: r.method,
    amountMmk: toNumber(r.amount),
    tenderedMmk: r.method === "CASH" && r.tendered !== "" ? toNumber(r.tendered) : toNumber(r.amount),
    reference: r.reference.trim() || null,
  })), [rows]);
  const splitPlan = useMemo(() => (split ? planPayments(splitParts, totalMmk) : null), [split, splitParts, totalMmk]);
  const allocated = splitParts.reduce((s, p) => s + p.amountMmk, 0);

  const canConfirm = !loading && !validationError && (split ? splitPlan?.ok === true : paid >= totalMmk);

  const handleClose = () => {
    if (!loading) onClose();
  };

  useEffect(() => {
    if (open) {
      setPaidInput("0");
      setSplit(false);
      setRows([]);
    }
  }, [open, totalMmk]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void finCapabilities().then((caps) => { if (live) setSplitAvailable(caps.splitPayments); }).catch(() => undefined);
    return () => { live = false; };
  }, [open]);

  const confirm = () => {
    if (!canConfirm) return;
    if (split && splitPlan?.ok) {
      void onConfirm(splitPlan.plan.legacyMethod, splitPlan.plan.paidMmk, splitPlan.plan.payments);
    } else {
      void onConfirm(method, paid);
    }
  };

  const startSplit = () => {
    setSplit(true);
    setRows([
      { method: "CASH", amount: "", tendered: "", reference: "" },
      { method: "BANK_TRANSFER", amount: String(totalMmk), tendered: "", reference: "" },
    ]);
  };
  const unusedMethod = (): SplitMethod | null => SPLIT_METHODS.find((m) => !rows.some((r) => r.method === m)) ?? null;
  const addRow = () => {
    const m = unusedMethod();
    if (!m || rows.length >= MAX_PAYMENTS) return;
    setRows([...rows, { method: m, amount: String(Math.max(0, totalMmk - allocated)), tendered: "", reference: "" }]);
  };
  const updateRow = (i: number, patch: Partial<SplitRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows(rows.filter((_, j) => j !== i));

  const problemText = (p: PaymentProblem): string => {
    switch (p.code) {
      case "TOTAL_MISMATCH": return t("fin", "splitTotalMismatch", { sum: formatMmk(p.sumMmk), total: formatMmk(p.totalMmk) });
      case "DUPLICATE_METHOD": return t("fin", "splitDuplicate", { method: t("fin", METHOD_KEY[p.method]) });
      case "TENDER_BELOW_AMOUNT": return t("fin", "splitTenderBelow");
      case "NON_CASH_CHANGE": return t("fin", "splitNonCashChange");
      case "REFERENCE_TOO_LONG": return t("fin", "splitReferenceLong");
      case "AMOUNT": return t("fin", "splitAmount");
      default: return t("fin", "splitCount");
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("pos", "paymentTitle")}
      description={t("pos", "paymentDesc")}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={loading}>
            {t("common", "cancel")}
          </Button>
          <Button onClick={confirm} disabled={!canConfirm}>
            {loading ? t("pos", "processing") : t("pos", "confirmPayment")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                {t("pos", "totalDue")}
              </div>
              <div className="mt-1 text-2xl font-bold text-slate-950">
                {formatMmk(totalMmk)}
              </div>
            </div>
            <div className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-emerald-700 shadow-sm">
              {split ? t("fin", "splitPayment") : method === "CASH" ? t("pos", "cashPayment") : t("pos", "otherPayment")}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-white p-3 shadow-sm">
              <div className="text-xs text-slate-500">{split ? t("fin", "allocated") : t("pos", "amountReceived")}</div>
              <div className="mt-1 text-base font-semibold text-slate-900">
                {formatMmk(split ? allocated : paid)}
              </div>
            </div>
            <div className="rounded-xl bg-white p-3 shadow-sm">
              <div className="text-xs text-slate-500">{t("pos", "change")}</div>
              <div className="mt-1 text-base font-semibold text-emerald-700">
                {formatMmk(split ? (splitPlan?.ok ? splitPlan.plan.changeMmk : 0) : change)}
              </div>
            </div>
          </div>
        </div>

        {!split ? (
          <div className="grid gap-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">{t("pos", "paymentMethod")}</span>
              <Select value={method} onChange={(event) => setMethod(event.target.value as "CASH" | "OTHER")}>
                <option value="CASH">{t("pos", "cash")}</option>
                <option value="OTHER">{t("pos", "other")}</option>
              </Select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">{t("pos", "amountReceived")}</span>
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                value={paidInput}
                onChange={(event) => setPaidInput(normalizeAmountInput(event.target.value))}
                onKeyDown={(event) => {
                  // Enter on the amount field is the natural "I'm done"
                  // signal for cashiers — let it confirm the payment when
                  // the modal is in a valid state, instead of forcing a
                  // mouse hop to the Confirm button.
                  if (event.key === "Enter" && canConfirm) {
                    event.preventDefault();
                    confirm();
                  }
                }}
                onBlur={() => {
                  if (paidInput === "") setPaidInput("0");
                }}
                className="text-base font-semibold"
              />
            </label>
            {splitAvailable ? (
              <Button variant="secondary" onClick={startSplit} disabled={loading}>
                {t("fin", "splitStart")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3" data-testid="split-payment">
            {rows.map((row, i) => (
              <div key={i} className="grid gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Select
                  aria-label={t("pos", "paymentMethod")}
                  value={row.method}
                  onChange={(e) => updateRow(i, { method: e.target.value as SplitMethod, tendered: "" })}
                >
                  {SPLIT_METHODS.map((m) => (
                    <option key={m} value={m} disabled={m !== row.method && rows.some((r) => r.method === m)}>
                      {t("fin", METHOD_KEY[m])}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label={t("fin", "amountPart")}
                  placeholder={t("fin", "amountPart")}
                  inputMode="numeric"
                  value={row.amount}
                  onChange={(e) => updateRow(i, { amount: normalizeAmountInput(e.target.value) })}
                />
                {row.method === "CASH" ? (
                  <Input
                    aria-label={t("fin", "cashTendered")}
                    placeholder={t("fin", "cashTendered")}
                    inputMode="numeric"
                    value={row.tendered}
                    onChange={(e) => updateRow(i, { tendered: normalizeAmountInput(e.target.value) })}
                  />
                ) : (
                  <Input
                    aria-label={t("fin", "reference")}
                    placeholder={t("fin", "reference")}
                    maxLength={120}
                    value={row.reference}
                    onChange={(e) => updateRow(i, { reference: e.target.value })}
                  />
                )}
                <Button variant="secondary" onClick={() => removeRow(i)} disabled={rows.length <= 1 || loading}>
                  {t("fin", "remove")}
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={addRow} disabled={!unusedMethod() || rows.length >= MAX_PAYMENTS || loading}>
                {t("fin", "addPayment")}
              </Button>
              <Button variant="secondary" onClick={() => { setSplit(false); setRows([]); }} disabled={loading}>
                {t("fin", "splitCancel")}
              </Button>
            </div>
          </div>
        )}

        {validationError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
            {validationError}
          </div>
        ) : split ? (
          splitPlan && !splitPlan.ok ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
              {problemText(splitPlan.problem)}
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-slate-600">{t("pos", "changeToReturn")}</span>
                <span className="text-lg font-bold text-emerald-700">{formatMmk(splitPlan?.ok ? splitPlan.plan.changeMmk : 0)}</span>
              </div>
            </div>
          )
        ) : isUnderpaid ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
            {t("pos", "underpaid")}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-slate-600">{t("pos", "changeToReturn")}</span>
              <span className="text-lg font-bold text-emerald-700">{formatMmk(change)}</span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
