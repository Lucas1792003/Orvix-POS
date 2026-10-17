import { useCallback, useEffect, useState } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useTranslation } from "../../hooks/useTranslation";
import { formatDateTime } from "../../lib/utils";
import { outcomeToast } from "../../lib/outcomeToast";
import { useDataStore } from "../../stores/dataStore";
import {
  checkOnlineOperation, listUnresolvedOnlineOperations, markOnlineOperationVerified, retryOnlineOperation, type OnlineOperation,
} from "../../stores/data/onlineOnly";

type Row = OnlineOperation & { retryable: boolean; mine: boolean };

const LABELS: Record<string, string> = {
  pay_supplier_lump_sum: "Supplier payment", create_purchase_order: "Purchase order", create_stock_transfer: "Stock transfer",
  create_supplier: "New supplier", void_supplier_payment: "Void supplier payment",
};

// Online-only operations the server never confirmed (Batch 2A correction
// pass): listed across restarts, retried only unchanged (original key), or
// — when too old to retry safely — closed by the owner after checking the
// server's records.
export const UnresolvedOperationsSection = ({ isOwner }: { isOwner: boolean }) => {
  const { t } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRows(await listUnresolvedOnlineOperations());
    } catch (err) {
      console.error("[sync] could not list unresolved operations:", err);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
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

  // Ask the server what became of it (086); nothing is sent.
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

  return (
    <section className="mt-6">
      <h3 className="text-sm font-semibold text-slate-800">{t("unresolved", "sectionTitle")}</h3>
      <p className="mt-1 text-xs text-slate-500">{t("unresolved", "sectionHint")}</p>
      {rows.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-dashed border-slate-300/70 bg-slate-50/60 p-4 text-center text-sm text-slate-500">
          {t("unresolved", "none")}
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-amber-900">
                  {LABELS[row.name] ?? row.name}
                  {typeof row.args.p_amount_mmk === "number" ? ` · ${row.args.p_amount_mmk.toLocaleString("en-US")} MMK` : ""}
                </div>
                <div className="text-xs text-amber-800">{formatDateTime(row.createdAt)}{row.lastError ? ` · ${row.lastError}` : ""}</div>
                {!row.retryable && <div className="mt-1 text-xs text-rose-700">{t("unresolved", "tooOld")}</div>}
                {!row.mine && <Badge tone="slate">{t("unresolved", "notMine")}</Badge>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void check(row)} disabled={busy}>{t("unresolved", "check")}</Button>
                {row.mine && row.retryable && (
                  <Button size="sm" onClick={() => void retry(row)} disabled={busy}>{t("unresolved", "retry")}</Button>
                )}
                {isOwner && (
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
