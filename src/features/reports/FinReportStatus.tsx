import type { ReactNode } from "react";
import { formatMmk } from "../../lib/utils";
import { BASIS_LABEL, BASIS_SHORT, reportWarnings, type FinReportSummary, type RefundBasis, type UnavailableReason } from "./finReports";
import type { FinState } from "./useFinReport";

const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  OFFLINE: "You are offline. Server financial reports need a connection; no cached totals are shown.",
  TIMEOUT: "The server did not answer in time. No cached totals are shown — try again.",
  NOT_INSTALLED: "This server does not provide financial reports yet. No cached totals are shown.",
  RECOVERY: "The server is in recovery. Financial reports are unavailable until it reopens.",
  AUTH: "Your sign-in has expired. Sign in again to load financial reports.",
  SERVER: "The server is temporarily unavailable. No cached totals are shown — try again.",
};

/**
 * Renders every non-ok state of a server report. Returns null when the
 * report is ready (`children` are not rendered for non-ok states, so no
 * figure can appear without a server answer).
 */
export const FinStatusNotice = <T,>({
  state,
  onRetry,
  compact = false,
  children,
}: {
  state: FinState<T>;
  onRetry?: () => void;
  compact?: boolean;
  children?: (data: T) => ReactNode;
}) => {
  if (state.status === "ok") return children ? <>{children(state.data)}</> : null;
  const box = (tone: "info" | "warn" | "error", text: string, retry: boolean) => (
    <div
      role={tone === "info" ? "status" : "alert"}
      data-fin-state={state.status}
      className={`rounded-2xl border px-3 py-2 text-sm ${
        tone === "info" ? "border-dashed border-slate-300/70 bg-slate-50/60 text-slate-500"
        : tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-rose-200 bg-rose-50 text-rose-700"} ${compact ? "text-xs" : ""}`}
    >
      {text}
      {retry && onRetry && (
        <button type="button" onClick={onRetry} className="ml-2 font-semibold underline">Try again</button>
      )}
    </div>
  );
  switch (state.status) {
    case "idle":
      return null;
    case "loading":
      return box("info", "Loading server report…", false);
    case "unavailable":
      return box("warn", UNAVAILABLE_TEXT[state.reason], state.reason !== "NOT_INSTALLED");
    case "forbidden":
      return box("error", "You are not permitted to view this report.", false);
    case "invalid":
      return box("error", state.message, false);
    case "error":
    default:
      return box("error", `The server report could not be read: ${state.message}`, true);
  }
};

export const BasisBadge = ({ basis }: { basis: RefundBasis }) => (
  <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600" title={BASIS_LABEL[basis]}>
    {BASIS_SHORT[basis]} · Asia/Yangon
  </span>
);

/** Evidence and reconciliation warnings of one report, worded for staff. */
export const FinWarnings = ({ report }: { report: FinReportSummary }) => {
  const warnings = reportWarnings(report);
  if (warnings.length === 0) return null;
  const text = (w: (typeof warnings)[number]): string => {
    switch (w.key) {
      case "UNDATED":
        return `${w.count} approved refund(s)/void(s) (${formatMmk(w.amountMmk ?? 0)}) have no recorded approval time. They are not placed on any day here; reconcile them by hand.`;
      case "COST_INCOMPLETE":
        return `Cost is incomplete (${w.count} line(s) or adjustment(s) without a cost snapshot or approval date). Profit is not shown rather than overstated.`;
      case "OVER_REFUND":
        return `${w.count} refund(s) exceed what the customer paid after discounts. Amounts are shown as approved; review them.`;
      case "UNPARSEABLE":
        return `${w.count} refund request(s) have unreadable items and are not counted. Review them.`;
      case "PENDING":
      default:
        return `${w.count} refund/void request(s) (${formatMmk(w.amountMmk ?? 0)}) await approval and are not deducted yet.`;
    }
  };
  return (
    <ul className="space-y-1 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-fin-warnings>
      {warnings.map((w) => <li key={w.key} data-warning={w.key}>{text(w)}</li>)}
    </ul>
  );
};
