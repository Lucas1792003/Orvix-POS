import { formatDateTime, formatMmk } from "../../../lib/utils";
import { unassignedPayouts, type FinPayoutGroup, type FinShiftReconciliation } from "../../reports/finReports";
import { FinStatusNotice } from "../../reports/FinReportStatus";
import type { FinState } from "../../reports/useFinReport";

const Row = ({ label, value, tone }: { label: string; value: string; tone?: "warn" | "muted" }) => (
  <div className="flex items-center justify-between gap-3 text-sm">
    <span className={tone === "muted" ? "text-slate-500" : "text-slate-700"}>{label}</span>
    <span className={`tabular-nums font-medium ${tone === "warn" ? "text-amber-700" : "text-slate-800"}`}>{value}</span>
  </div>
);

const Group = ({ title, note, group }: { title: string; note: string; group: FinPayoutGroup }) =>
  group.count === 0 ? null : (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3" data-payout-group={title}>
      <div className="flex items-center justify-between text-sm font-semibold text-amber-800">
        <span>{title}</span>
        <span className="tabular-nums">{group.count} · {formatMmk(group.amountMmk)}</span>
      </div>
      <div className="mt-1 text-xs text-amber-800">{note}</div>
      {group.items && group.items.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-amber-900">
          {group.items.map((item) => (
            <li key={`${item.kind}-${item.id}`} className="flex justify-between gap-2">
              <span>
                {item.kind === "VOID" ? "Void" : "Refund"} {item.receiptNo ?? item.saleId}
                {item.approvedAt ? ` · approved ${formatDateTime(item.approvedAt)}` : " · approval time not recorded"}
              </span>
              <span className="tabular-nums">{formatMmk(item.amountMmk)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

/**
 * Server reconciliation of one shift (fin_shift_reconciliation). Shows what
 * the evidence supports and nothing more:
 *   - deducted: payouts of this shift's cash sales approved before the close ran;
 *   - UNASSIGNED (requires reconciliation): payouts whose paying drawer is not
 *     recorded — approved after the close, in an unknown close window, or with
 *     no recorded approval time. They are never attributed to a shift here;
 *   - other shifts' payouts approved while this shift was open: candidates
 *     only, never deducted;
 *   - pay-in / pay-out: not recorded by this server (shown as such, not as 0).
 * The stored close figures are never recomputed.
 */
export const ShiftReconciliationPanel = ({
  state,
  onRetry,
}: {
  state: FinState<FinShiftReconciliation>;
  onRetry: () => void;
}) => (
  <div className="space-y-3" data-shift-reconciliation>
    <div className="text-sm font-semibold text-slate-800">Cash reconciliation (server)</div>
    <FinStatusNotice state={state} onRetry={onRetry}>
      {(r) => {
        const closed = r.shift.status === "CLOSED";
        const closedNote = closed
          ? "Approved, but the server has no approval time. If they existed when the shift closed, the stored close figure already deducted them. Not deducted in the evidence figure."
          : "Approved, but the server has no approval time. The close will deduct them; the evidence figure does not.";
        const unassigned = unassignedPayouts(r);
        return (
          <div className="space-y-3">
            <div className="space-y-1.5 rounded-xl border border-slate-200 bg-white p-3">
              <Row label="Opening cash" value={formatMmk(r.shift.openingCashMmk)} />
              <Row label={`Cash sales (${r.cashSales.count})`} value={formatMmk(r.cashSales.amountMmk)} />
              <Row
                label={`Refunds / voids of this shift's cash sales approved before the close (${r.attributedPayouts.count}) — deducted; paying drawer not recorded`}
                value={`− ${formatMmk(r.attributedPayouts.amountMmk)}`}
              />
              <Row label="Pay-in / pay-out" value="not recorded by this server" tone="muted" />
              <Row label="Expected cash (evidence)" value={formatMmk(r.evidenceExpectedCashMmk)} />
              {closed && (
                <>
                  <Row label="Expected cash stored at close" value={r.shift.storedExpectedCashMmk === null ? "—" : formatMmk(r.shift.storedExpectedCashMmk)} />
                  <Row label="Counted at close" value={r.shift.closingCashMmk === null ? "—" : formatMmk(r.shift.closingCashMmk)} />
                  <Row
                    label="Variance (evidence)"
                    value={r.evidenceVarianceMmk === null ? "—" : formatMmk(r.evidenceVarianceMmk)}
                    tone={r.evidenceVarianceMmk ? "warn" : undefined}
                  />
                  {r.shift.closeTimeSource === "ENDED_AT_ONLY" && (
                    <div className="text-xs text-amber-700">
                      The server close time is not on record; payouts after the recorded end time are listed as an unknown close window.
                    </div>
                  )}
                  {r.storedMatchesEvidence === false && (
                    <div role="alert" className="text-xs text-amber-700" data-stored-mismatch>
                      The stored close figure differs from the evidence. It is not rewritten; reconcile by hand.
                      {r.storedMatchesEvidenceIfCloseWindowDeducted === true && " It matches if the close deducted the unknown-close-window items below."}
                      {r.storedMatchesEvidenceIfUnknownTimeDeducted === true && " It matches if the close deducted the items without a recorded approval time below."}
                    </div>
                  )}
                </>
              )}
            </div>
            {unassigned.count > 0 && (
              <div role="alert" className="text-sm font-semibold text-amber-800" data-unassigned={unassigned.count}>
                Unassigned refunds requiring reconciliation: {unassigned.count} · {formatMmk(unassigned.amountMmk)}.
                No payout record says which drawer paid them; they are not attributed to any shift here.
              </div>
            )}
            <Group
              title="Approved after this shift closed — unassigned"
              note="Not deducted here. No payout record says which drawer paid them."
              group={r.afterClosePayouts}
            />
            <Group
              title="Unknown close window — unassigned"
              note="The server close time is not on record: the stored close figure may or may not include these. Not deducted in the evidence figure."
              group={r.closeWindowPayouts}
            />
            <Group
              title="No recorded approval time — unassigned"
              note={closedNote}
              group={r.unknownTimePayouts}
            />
            {r.crossShiftPayoutsDuringShift && (
              <Group
                title="Other shifts' refunds approved while this shift was open"
                note="Candidates that may explain a variance. Not deducted from this shift."
                group={r.crossShiftPayoutsDuringShift}
              />
            )}
            {r.supplierCashPaymentsDuringShift && r.supplierCashPaymentsDuringShift.count > 0 && (
              <Row
                label={`Cash supplier payments while open (${r.supplierCashPaymentsDuringShift.count}) — not deducted`}
                value={formatMmk(r.supplierCashPaymentsDuringShift.amountMmk)}
                tone="muted"
              />
            )}
          </div>
        );
      }}
    </FinStatusNotice>
  </div>
);
