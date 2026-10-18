import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useTranslation } from "../../hooks/useTranslation";
import { localDb } from "../../lib/localDb";
import { countQueue } from "../../lib/queueExport/collect";
import { useAuthStore } from "../../stores/authStore";
import { exportPendingQueue, type ExportQueueResult } from "../../lib/queueExport/exportQueue";
import { MIN_PASSPHRASE_LENGTH, type QueueExportSummary } from "../../lib/queueExport/format";

// "Export pending transactions" (docs/selfhost-migration/phase-f/
// queue-export.md). Reachable offline from the sync badge (any signed-in
// role), the Sync Conflicts page and — only while the queue is non-empty —
// the login page. Read-only: it never changes the queue.
export const ExportQueueDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<QueueExportSummary | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportQueueResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSummary(null);
    setPassphrase("");
    setConfirm("");
    setError("");
    setResult(null);
    void countQueue(localDb, useAuthStore.getState().currentOrgId ?? null).then((s) => { if (alive) setSummary(s); }).catch(() => undefined);
    return () => { alive = false; };
  }, [open]);

  const close = () => {
    if (busy) return;
    setPassphrase("");
    setConfirm("");
    onClose();
  };

  const submit = async () => {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(t("queueExport", "errTooShort", { n: MIN_PASSPHRASE_LENGTH }));
      return;
    }
    if (passphrase !== confirm) {
      setError(t("queueExport", "errMismatch"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      setResult(await exportPendingQueue(passphrase));
      setPassphrase("");
      setConfirm("");
    } catch (err) {
      setError(`${t("queueExport", "failed")}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const done = result && result.status !== "canceled";

  return (
    <Modal
      open={open}
      title={done ? t("queueExport", "savedTitle") : t("queueExport", "title")}
      description={done ? undefined : t("queueExport", "description")}
      onClose={close}
      size="sm"
      footer={done ? (
        <Button onClick={close} data-testid="queue-export-close">{t("queueExport", "close")}</Button>
      ) : (
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>{t("queueExport", "cancel")}</Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !summary || summary.total === 0}
            data-testid="queue-export-submit"
          >
            {busy ? t("queueExport", "exporting") : t("queueExport", "export")}
          </Button>
        </>
      )}
    >
      <div data-testid="queue-export-summary" className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        {!summary ? t("queueExport", "loading")
          : summary.total === 0 ? t("queueExport", "summaryNone")
          : (
            <>
              <div className="font-medium" data-testid="queue-export-total" data-total={summary.total}>
                {t("queueExport", "summaryTotal", { n: summary.total })}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {Object.entries(summary.byStatus).map(([s, n]) => `${n} ${t("queueExport", `status_${s}`)}`).join(" · ")}
              </div>
            </>
          )}
      </div>

      {done ? (
        <div className="space-y-2 text-sm text-slate-700" data-testid="queue-export-result">
          <div className="break-all font-mono text-xs" data-testid="queue-export-path">
            {result.status === "saved"
              ? t("queueExport", "savedTo", { path: result.filePath })
              : t("queueExport", "downloaded", { name: result.fileName })}
          </div>
          <div>{t("queueExport", "savedNote", { n: result.summary.total })}</div>
        </div>
      ) : (
        <form
          className="space-y-3"
          autoComplete="off"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          <label className="block text-sm">
            <span className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">{t("queueExport", "passphrase")}</span>
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => { setPassphrase(e.target.value); setError(""); }}
              autoComplete="new-password"
              data-testid="queue-export-passphrase"
              disabled={busy}
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">{t("queueExport", "passphraseConfirm")}</span>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setError(""); }}
              autoComplete="new-password"
              data-testid="queue-export-passphrase-confirm"
              disabled={busy}
            />
          </label>
          <p className="text-xs text-slate-500">{t("queueExport", "passphraseHint", { n: MIN_PASSPHRASE_LENGTH })}</p>
          {result?.status === "canceled" && (
            <p className="text-xs text-slate-500" data-testid="queue-export-canceled">{t("queueExport", "canceled")}</p>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Modal>
  );
};
