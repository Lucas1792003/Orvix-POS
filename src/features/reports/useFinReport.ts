import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchFinReportSummary,
  fetchFinShiftReconciliation,
  type FinReportParams,
  type FinReportSummary,
  type FinResult,
  type FinShiftReconciliation,
} from "./finReports";

export type FinState<T> = { status: "idle" } | { status: "loading" } | FinResult<T>;

/** At most this many report requests of one view run at once (a shop or shift
 *  list must not tie up the server that the tills write to). */
export const REPORT_CONCURRENCY = 3;

export async function mapLimited<I, O>(items: I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Load one server report. Read-only: a failure is shown, never retried
 * automatically and never replaced by client-computed totals. `refresh`
 * re-asks the server on demand. A reply that arrives after the inputs
 * changed is ignored.
 */
function useFinRequest<T>(key: string | null, run: () => Promise<FinResult<T>>): { state: FinState<T>; refresh: () => void } {
  // The answer is stored with the request it belongs to; the visible state is
  // derived, so a change of inputs shows "loading" at once and a late reply
  // for an older request can never be shown.
  const [answer, setAnswer] = useState<{ token: string; result: FinResult<T> } | null>(null);
  const [nonce, setNonce] = useState(0);
  const runRef = useRef(run);
  // Keep the latest request builder; declared before the fetching effect, so
  // it has run by the time that effect reads it.
  useEffect(() => {
    runRef.current = run;
  });
  const token = key === null ? null : `${nonce}|${key}`;

  useEffect(() => {
    if (token === null) return;
    let live = true;
    runRef.current().then(
      (result) => { if (live) setAnswer({ token, result }); },
      (e: unknown) => { if (live) setAnswer({ token, result: { status: "error", message: e instanceof Error ? e.message : String(e) } }); },
    );
    return () => { live = false; };
  }, [token]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const state: FinState<T> = token === null ? { status: "idle" }
    : answer && answer.token === token ? answer.result
    : { status: "loading" };
  return { state, refresh };
}

/** `params` null = do not ask (e.g. no shop resolved yet). */
export function useFinReport(params: FinReportParams | null) {
  const key = params ? `${params.shopId ?? "*"}|${params.from}|${params.to}|${params.basis}` : null;
  return useFinRequest<FinReportSummary>(key, () => fetchFinReportSummary(params as FinReportParams));
}

/** One report per shop (the all-shops view of a shop table). Each shop's
 *  state is independent: one unavailable shop never zeroes the others. */
export function useFinReportsByShop(shopIds: string[] | null, from: string, to: string, basis: FinReportParams["basis"]) {
  const key = shopIds ? `${shopIds.join(",")}|${from}|${to}|${basis}` : null;
  return useFinRequest<Record<string, FinResult<FinReportSummary>>>(key, async () => {
    const ids = shopIds ?? [];
    const results = await mapLimited(ids, REPORT_CONCURRENCY, (shopId) => fetchFinReportSummary({ shopId, from, to, basis }));
    return { status: "ok", data: Object.fromEntries(ids.map((id, i) => [id, results[i]])) };
  });
}

export function useShiftReconciliation(shiftId: string | null) {
  return useFinRequest<FinShiftReconciliation>(shiftId, () => fetchFinShiftReconciliation(shiftId as string));
}

/** Reconciliation of several shifts (e.g. every open shift of a shop). Each
 *  shift's state is independent. */
export function useShiftReconciliations(shiftIds: string[] | null) {
  const key = shiftIds ? shiftIds.join(",") : null;
  return useFinRequest<Record<string, FinResult<FinShiftReconciliation>>>(key, async () => {
    const ids = shiftIds ?? [];
    const results = await mapLimited(ids, REPORT_CONCURRENCY, (id) => fetchFinShiftReconciliation(id));
    return { status: "ok", data: Object.fromEntries(ids.map((id, i) => [id, results[i]])) };
  });
}
