import { useState } from "react";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Input } from "../ui/Input";
import { MoneyInput } from "../forms/MoneyInput";
import { ReasonDialog } from "../ui/ReasonDialog";
import { useToast } from "../ui/Toast";
import { formatDateTime, formatMmk } from "../../lib/utils";
import { getErrorMessage } from "../../lib/errors";
import { useTranslation } from "../../hooks/useTranslation";
import { useDataStore } from "../../stores/dataStore";
import {
  CASH_MOVEMENT_KINDS, MANAGER_ONLY_KINDS, type CashMovement, type CashMovementKind, type ShiftCashSummary,
} from "../../features/finance/finCompletion";
import type { FinState } from "../../features/reports/useFinReport";

interface CashMovementsCardProps {
  shiftId: string;
  /** The server's figures (fin_shift_cash_summary); never a local estimate. */
  cash: FinState<ShiftCashSummary>;
  /** shift:manage_all for the shift's shop (P-8 default: outflows, corrections and reversals). */
  canManage: boolean;
  onChanged: () => void;
}

const KIND_KEY: Record<CashMovementKind, string> = {
  FLOAT_IN: "kindFloatIn", PAY_IN: "kindPayIn", PAY_OUT: "kindPayOut", DEPOSIT_OUT: "kindDepositOut",
  CORRECTION_IN: "kindCorrectionIn", CORRECTION_OUT: "kindCorrectionOut", REVERSAL: "kindReversal",
};

/**
 * Step 4 (PFIN-D): cash put in or taken out of the drawer during a shift. Online only — every movement is keyed,
 * audited and never edited; a mistake is corrected by a REVERSAL of the whole movement. The figures shown are the
 * server's; when it cannot answer, they are shown as unavailable (no local figure is substituted).
 */
export const CashMovementsCard = ({ shiftId, cash, canManage, onChanged }: CashMovementsCardProps) => {
  const { t } = useTranslation();
  const toast = useToast();
  const recordCashMovement = useDataStore((s) => s.recordCashMovement);
  const kinds = CASH_MOVEMENT_KINDS.filter((k) => canManage || !MANAGER_ONLY_KINDS.has(k));
  const [kind, setKind] = useState<CashMovementKind>(kinds[0] ?? "PAY_IN");
  const [amount, setAmount] = useState<number | undefined>(undefined);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // (every hook above the early return below: a hook after it changes the hook count when PFIN-D appears or disappears)
  const [reversing, setReversing] = useState<CashMovement | null>(null);

  if (cash.status === "unavailable" && cash.reason === "NOT_INSTALLED") return null;

  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 300;
  const canSubmit = !busy && cash.status === "ok" && reasonOk && (amount ?? 0) > 0;

  // resolves true when the movement was recorded (a refusal is reported here, as a toast)
  const submit = async (input: { kind: CashMovementKind; amountMmk: number | null; reason: string; reversesId?: string }): Promise<boolean> => {
    setBusy(true);
    try {
      const { expectedCashMmk } = await recordCashMovement({ shiftId, ...input });
      toast({
        title: t("fin", "movementRecorded"),
        description: expectedCashMmk !== null ? t("fin", "expectedNow", { amount: formatMmk(expectedCashMmk) }) : undefined,
        variant: "success",
      });
      if (!input.reversesId) { setAmount(undefined); setReason(""); }   // a reversal leaves a half-typed new movement alone
      onChanged();
      return true;
    } catch (error) {
      toast({ title: t("fin", "movementFailed"), description: getErrorMessage(error, t("fin", "movementFailed")), variant: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // The reason comes from a ReasonDialog, never window.prompt(): Electron has no prompt() (it returns null at once), so a
  // reversal silently did nothing on the desktop app (ORV-013; found again in Step 6, W09).
  const reverse = (m: CashMovement) => { if (!busy && !reversing) setReversing(m); };
  const confirmReverse = async (why: string) => {
    const m = reversing;
    if (!m) return;
    if (why.trim().length < 3 || why.trim().length > 300) {   // the server's rule (3–300); the dialog itself allows 500
      toast({ title: t("fin", "movementFailed"), description: t("fin", "reversePrompt"), variant: "error" });
      throw new Error("reason too short");   // keeps the dialog open with the typed reason
    }
    // a refusal keeps the dialog open with the typed reason (ReasonDialog closes only when onConfirm resolves)
    if (!(await submit({ kind: "REVERSAL", amountMmk: null, reason: why.trim(), reversesId: m.id }))) throw new Error("reversal refused");
  };

  const reversed = new Set(cash.status === "ok" ? cash.data.movements.map((m) => m.reversesId).filter(Boolean) : []);

  return (
    <div className="space-y-3 rounded-xl border border-slate-200/70 p-3" data-testid="cash-movements">
      <div className="text-sm font-medium text-slate-700">{t("fin", "cashMovements")}</div>
      {cash.status === "loading" || cash.status === "idle" ? (
        <div className="text-xs text-slate-500">{t("fin", "loadingCash")}</div>
      ) : cash.status !== "ok" ? (
        <div className="text-xs text-amber-700">{t("fin", "cashUnavailable")}</div>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_max-content] gap-x-4 gap-y-1 text-sm">
            <div className="text-slate-500">{t("fin", "openingCash")}</div><div className="tabular-nums">{formatMmk(cash.data.openingCashMmk)}</div>
            <div className="text-slate-500">{t("fin", "cashSales")}</div><div className="tabular-nums">{formatMmk(cash.data.cashSalesMmk)}</div>
            <div className="text-slate-500">{t("fin", "cashRefunds")}</div><div className="tabular-nums">- {formatMmk(cash.data.cashRefundsMmk)}</div>
            <div className="text-slate-500">{t("fin", "movementsIn")}</div><div className="tabular-nums">{formatMmk(cash.data.movementsInMmk)}</div>
            <div className="text-slate-500">{t("fin", "movementsOut")}</div><div className="tabular-nums">- {formatMmk(cash.data.movementsOutMmk)}</div>
            <div className="font-medium text-slate-700">{t("fin", "expectedCash")}</div>
            <div className="tabular-nums font-semibold" data-testid="server-expected-cash">{formatMmk(cash.data.expectedCashMmk)}</div>
          </div>
          {cash.data.movements.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {cash.data.movements.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span>
                    {t("fin", KIND_KEY[m.kind] ?? "kindPayIn")} {m.direction === 1 ? "+" : "-"}{formatMmk(m.amountMmk)} · {m.reason} · {formatDateTime(m.createdAt)}
                  </span>
                  {canManage && m.kind !== "REVERSAL" && !reversed.has(m.id) ? (
                    <Button variant="secondary" onClick={() => reverse(m)} disabled={busy}>{t("fin", "reverse")}</Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <Select aria-label={t("fin", "movementKind")} value={kind} onChange={(e) => setKind(e.target.value as CashMovementKind)}>
          {kinds.map((k) => <option key={k} value={k}>{t("fin", KIND_KEY[k])}</option>)}
        </Select>
        <MoneyInput id={`cash-movement-${shiftId}`} value={amount} allowEmpty onChange={setAmount} placeholder={t("fin", "amountPart")} />
        <Input aria-label={t("fin", "movementReason")} placeholder={t("fin", "movementReason")} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button onClick={() => void submit({ kind, amountMmk: amount ?? 0, reason })} disabled={!canSubmit}>
        {busy ? t("pos", "processing") : t("fin", "recordMovement")}
      </Button>
      {!canManage ? <p className="text-xs text-slate-500">{t("fin", "managerOnlyNote")}</p> : null}
      <ReasonDialog
        key={reversing ? `reverse:${reversing.id}` : "closed"}
        open={reversing !== null}
        title={t("fin", "reverse")}
        label={t("fin", "reversePrompt")}
        confirmLabel={t("fin", "reverse")}
        cancelLabel={t("common", "back")}
        requiredMessage={t("transfers", "reasonRequired")}
        destructive
        onConfirm={confirmReverse}
        onClose={() => setReversing(null)}
      />
    </div>
  );
};
