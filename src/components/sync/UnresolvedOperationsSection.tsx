import { useCallback, useEffect, useState } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useTranslation } from "../../hooks/useTranslation";
import { formatDateTime } from "../../lib/utils";
import { outcomeToast } from "../../lib/outcomeToast";
import { useDataStore } from "../../stores/dataStore";
import {
  checkOnlineOperation, listUnreadableOnlineRecords, listUnresolvedOnlineOperations, markOnlineOperationVerified, retryOnlineOperation,
  setAsideUnreadableOnlineRecord, type OnlineOperation, type UnreadableOnlineRecord,
} from "../../stores/data/onlineOnly";

type Row = OnlineOperation & { retryable: boolean; mine: boolean; foreign: boolean };

const LABELS: Record<string, string> = {
  pay_supplier_lump_sum: "Supplier payment", create_purchase_order: "Purchase order", create_stock_transfer: "Stock transfer",
  create_supplier: "New supplier", void_supplier_payment: "Void supplier payment",
};

// Online-only operations the server never confirmed (Batch 2A correction
// pass): listed across restarts, retried only unchanged (original key), or
// — when too old to retry safely — closed by the owner after checking the
// server's records.
//
// Deployment-blocker pass: two scopes. "own" (any signed-in user, e.g. a
// MANAGER who made a supplier payment): only that user's own operations of
// their organisation; Check (a read-only lookup — never a fence) and Retry
// (own, unchanged). "org" (the owner's Sync page): every operation of the
// organisation, plus Mark verified and the unreadable-record set-aside.
// Actions the person cannot take are not offered (another server's
// operation: no Check / Retry; not theirs: no Retry; not the owner: no Verify).
export const UnresolvedOperationsSection = ({ isOwner, mode = "org" }: { isOwner: boolean; mode?: "org" | "own" }) => {
  const { t } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [unreadable, setUnreadable] = useState<UnreadableOnlineRecord[]>([]);
  const [readError, setReadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const ownerActions = isOwner && mode === "org";

  const refresh = useCallback(async () => {
    try {
      const [list, bad] = await Promise.all([listUnresolvedOnlineOperations(Date.now(), { own: mode === "own" }), listUnreadableOnlineRecords()]);
      setRows(list);
      setUnreadable(bad);
      setReadError(false);
    } catch (err) {
      console.error("[sync] could not list unresolved operations:", err);
      setReadError(true);
    }
  }, [mode]);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast({ variant: "error", title: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const retry = (row: Row) => act(async () => {
    const outcome = await retryOnlineOperation(row.id).catch((err) => ({ data: null, error: err }));
    if (outcome.error) {
      toast(outcomeToast(outcome.error, t, LABELS[row.name] ?? row.name, ""));
      return;
    }
    toast({ variant: "success", title: t("unresolved", "retried"), description: LABELS[row.name] ?? row.name });
    // The reply belongs to the earlier operation: reload to show its effect.
    void useDataStore.getState().loadData({ force: true });
  });

  // Ask the server what became of it (086); nothing is sent, nothing fenced.
  const check = (row: Row) => act(async () => {
    const result = await checkOnlineOperation(row.id).catch((err) => ({ absent: false, status: null, error: err }));
    const label = LABELS[row.name] ?? row.name;
    if (result.error) {
      toast(outcomeToast(result.error, t, label, ""));
      return;
    }
    if (result.absent || !result.status) {
      toast({ variant: "info", title: t("unresolved", "checkUnavailable"), description: label });
      return;
    }
    const key = {
      committed: "checkCommitted", rejected: "checkRejected", abandoned: "checkAbandoned", not_found: "checkNotFound",
      in_flight: "checkInFlight", unavailable: "checkUnavailable",
    }[result.status.status] as "checkCommitted";
    // "Applied" only when the till could settle it from the server's answer.
    const settled = !(await listUnresolvedOnlineOperations()).some((o) => o.id === row.id);
    const title = result.status.status === "committed" && !settled ? t("unresolved", "checkUnavailable") : t("unresolved", key);
    toast({ variant: result.status.status === "committed" && settled ? "success" : "info", title, description: label });
    if (result.status.status === "committed" && settled) void useDataStore.getState().loadData({ force: true });
  });

  const verify = (row: Row) => act(async () => {
    await markOnlineOperationVerified(row.id);
    toast({ variant: "info", title: t("unresolved", "verified"), description: LABELS[row.name] ?? row.name });
  });

  const setAside = (r: UnreadableOnlineRecord) => act(async () => {
    await setAsideUnreadableOnlineRecord(r.key);
    toast({ variant: "info", title: t("unresolved", "setAsideDone") });
  });

  return (
    <section className="mt-6" data-testid={`unresolved-section-${mode}`}>
      <h3 className="text-sm font-semibold text-slate-800">{mode === "own" ? t("unresolved", "ownTitle") : t("unresolved", "sectionTitle")}</h3>
      <p className="mt-1 text-xs text-slate-500">{mode === "own" ? t("unresolved", "ownHint") : t("unresolved", "sectionHint")}</p>
      {readError && (
        <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900" data-testid="unresolved-read-error">
          {t("unresolved", "readError")}
        </div>
      )}
      {unreadable.length > 0 && (
        <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900" data-testid="unresolved-unreadable">
          <div className="font-medium">{t("unresolved", "unreadableTitle")} ({unreadable.length})</div>
          <div className="mt-1 text-xs">{t("unresolved", "unreadableHint")}</div>
          {ownerActions && (
            <ul className="mt-2 space-y-1">
              {unreadable.map((r) => (
                <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>{t("unresolved", "unreadableItem")}{r.claimed.name ? ` (${LABELS[r.claimed.name] ?? r.claimed.name}?)` : ""} · {r.reason}</span>
                  <Button size="sm" variant="secondary" onClick={() => void setAside(r)} disabled={busy}>{t("unresolved", "setAside")}</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-dashed border-slate-300/70 bg-slate-50/60 p-4 text-center text-sm text-slate-500">
          {t("unresolved", "none")}
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-testid="unresolved-row">
              <div className="min-w-0">
                <div className="font-medium text-amber-900">
                  {LABELS[row.name] ?? row.name}
                  {typeof row.args.p_amount_mmk === "number" ? ` · ${row.args.p_amount_mmk.toLocaleString("en-US")} MMK` : ""}
                </div>
                <div className="text-xs text-amber-800">{formatDateTime(row.createdAt)}{row.lastError ? ` · ${row.lastError}` : ""}</div>
                {row.foreign && <div className="mt-1 text-xs text-rose-700">{t("unresolved", "foreign")}</div>}
                {!row.foreign && !row.retryable && <div className="mt-1 text-xs text-rose-700">{t("unresolved", "tooOld")}</div>}
                {!row.mine && <Badge tone="slate">{t("unresolved", "notMine")}</Badge>}
              </div>
              <div className="flex gap-2">
                {!row.foreign && (row.mine || ownerActions) && (
                  <Button size="sm" variant="secondary" onClick={() => void check(row)} disabled={busy}>{t("unresolved", "check")}</Button>
                )}
                {!row.foreign && row.mine && row.retryable && (
                  <Button size="sm" onClick={() => void retry(row)} disabled={busy}>{t("unresolved", "retry")}</Button>
                )}
                {ownerActions && (
                  <Button size="sm" variant="secondary" onClick={() => void verify(row)} disabled={busy}>{t("unresolved", "verify")}</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
