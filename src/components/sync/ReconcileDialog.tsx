// ----------------------------------------------------------------------
// Owner reconciliation dialog (1.0.16 RC3), opened from the Sync Conflicts
// page for one conflict / quarantined / set-aside entry. Steps:
//   1. export in this session must contain this exact entry (digest);
//   2. read-only server check (lib/reconcile/serverCheck.ts) -> recorded /
//      not recorded / inconclusive, with the sale id and receipt number;
//   3. the owner documents the resolution (matched / recreated / cancelled)
//      and a reason;
//   4. "Reconcile": the app's main process verifies the owner with the
//      server right now (refused offline) and the change is written in one
//      transaction (stores/data/reconcile.ts). Nothing is sent or deleted;
//      no stock, payment or sale is written.
// ----------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Input } from "../ui/Input";
import { localDb, type SyncOutboxEntry } from "../../lib/localDb";
import { supabase } from "../../lib/supabase";
import { exportedEntry, onQueueExported } from "../../lib/queueExport/exportRecord";
import { entryDigest } from "../../lib/reconcile/digest";
import { RECONCILE_BLOCK_TEXT, reconcileBlock } from "../../lib/reconcile/policy";
import { checkServerRecord, supabaseSaleReader, verifyRecreatedSale, type SelectOnlyClient } from "../../lib/reconcile/serverCheck";
import { REASON_MAX_LENGTH } from "../../lib/reconcile/constants";
import type { ReconcileResolution, ServerCheck, ServerSaleRef } from "../../lib/reconcile/types";
import { createSingleFlight } from "../../lib/outboxSetAsidePolicy";
import { currentAccessToken } from "../../lib/updateGuardBridge";
import { ReconcileError, reconcileOutboxEntry, rowSnapshot } from "../../stores/data/reconcile";

const saleText = (s: ServerSaleRef) =>
  `${s.receiptNo ? `receipt ${s.receiptNo}` : "no receipt no."} · sale ${s.saleId}${s.createdAt ? ` · ${new Date(s.createdAt).toLocaleString()}` : ""}`;

const RESULT_TEXT: Record<ServerCheck["result"], string> = {
  recorded: "Recorded on the server",
  "not-recorded": "Not recorded on the server",
  inconclusive: "Inconclusive",
};

export function ReconcileDialog(props: {
  localId: string | null;
  label: string;
  shop: string;
  isOwner: boolean;
  onClose: () => void;
  onDone: (row: SyncOutboxEntry) => void;
  onError: (message: string) => void;
}) {
  const { localId, isOwner } = props;
  const [row, setRow] = useState<SyncOutboxEntry | null>(null);
  const [snapshot, setSnapshot] = useState("");
  const [digest, setDigest] = useState<string | null>(null);
  const [, setExportTick] = useState(0);
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [resolution, setResolution] = useState<ReconcileResolution | null>(null);
  const [recreatedRef, setRecreatedRef] = useState("");
  const [recreatedSale, setRecreatedSale] = useState<ServerSaleRef | null>(null);
  const [recreatedError, setRecreatedError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(createSingleFlight());
  const api = typeof window === "undefined" ? undefined : window.electronAPI;
  const reader = useMemo(() => supabaseSaleReader(supabase as unknown as SelectOnlyClient), []);

  // Load the row as it is NOW (the compare-and-set token is taken here).
  useEffect(() => {
    let alive = true;
    setRow(null); setSnapshot(""); setDigest(null); setCheck(null); setResolution(null);
    setRecreatedRef(""); setRecreatedSale(null); setRecreatedError(null); setReason(""); setError(null);
    if (!localId) return;
    void (async () => {
      const r = await localDb.syncOutbox.get(localId);
      if (!alive) return;
      setRow(r ?? null);
      if (r) {
        setSnapshot(rowSnapshot(r));
        setDigest(await entryDigest(r));
      }
    })();
    return () => { alive = false; };
  }, [localId]);
  useEffect(() => onQueueExported(() => setExportTick((n) => n + 1)), []);

  if (!localId) return null;
  const exp = exportedEntry(localId);
  const block = row
    ? reconcileBlock(row, { isOwner, canVerifyOwner: Boolean(api?.reconcileAttest), exportedDigest: exp ? exp.digest : undefined, currentDigest: digest })
    : null;
  const found = check ? [...check.matches, ...check.candidates] : [];

  const run = (fn: () => Promise<void>) => flight.current.run(async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  });

  const runCheck = () => run(async () => {
    if (!row || !digest) return;
    const ids = (row.refs ?? []).map((r) => r.provisionalId);
    const maps = await localDb.provisionalIdMap.bulkGet(ids);
    const resolved = new Map(ids.map((id, i) => [id, maps[i]?.realId ?? null]));
    const c = await checkServerRecord(row, { reader, resolveRef: (id) => resolved.get(id) ?? null, entryDigest: digest });
    setCheck(c);
    setResolution(null);
    setRecreatedSale(null);
  });

  const verifyRecreated = () => run(async () => {
    if (!row) return;
    setRecreatedError(null);
    const v = await verifyRecreatedSale(reader, {
      saleIdOrReceipt: recreatedRef, shopId: row.shopId, queuedAt: row.createdAt, exclude: found.map((s) => s.saleId),
    });
    if (v.ok) setRecreatedSale(v.sale);
    else { setRecreatedSale(null); setRecreatedError(v.message); }
  });

  const submit = () => run(async () => {
    if (!row || !resolution) return;
    try {
      const stored = await reconcileOutboxEntry(row.localId, {
        resolution, check, matchedSaleId: null, recreatedSale, reason, expectedRow: snapshot,
      }, {
        attest: api?.reconcileAttest ? (req) => api.reconcileAttest!(req) : undefined,
        accessToken: currentAccessToken,
        exportedEntry,
      });
      props.onDone(stored);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Nothing was reconciled.";
      setError(message);
      if (err instanceof ReconcileError && (err.code === "changed" || err.code === "already-reconciled" || err.code === "not-found")) props.onError(message);
    }
  });

  const canSubmit = !busy && !block && check !== null && resolution !== null && reason.trim().length > 0
    && (resolution !== "matched" || check?.result === "recorded")
    && (resolution !== "recreated" || recreatedSale !== null)
    && (resolution !== "cancelled" || check.result === "not-recorded");

  return (
    <Modal
      open
      title="Reconcile this entry"
      description="Documents what happened to it. Nothing is sent, deleted, or written to stock, payments or sales."
      onClose={() => { if (!busy) props.onClose(); }}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={props.onClose}>Cancel</Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()} data-testid="reconcile-submit">
            Reconcile (owner check)
          </Button>
        </div>
      }
    >
      {!row ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="space-y-4 text-sm" data-testid="reconcile-dialog">
          <p className="font-semibold text-slate-800" data-testid="reconcile-entry">
            {props.label} · {props.shop} · queued {new Date(row.createdAt).toLocaleString()} · status {row.status}
            {row.idempotencyKey ? ` · key ${row.idempotencyKey.slice(0, 8)}` : ""}
          </p>
          {block && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900" data-testid="reconcile-block" data-block={block}>
              {RECONCILE_BLOCK_TEXT[block]}
            </div>
          )}
          {row.status === "quarantined" && (
            <p className="text-xs text-amber-800">
              This entry was queued for another server. The check below looks only at this server: a sale recorded on the
              other server is not visible here.
            </p>
          )}

          <section>
            <h4 className="font-semibold text-slate-700">1. Server check (read-only)</h4>
            <p className="text-xs text-slate-500">Looks the sale up by shop, shift, ring-up time, amounts and lines. Nothing is written.</p>
            <div className="mt-2 flex items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy || block !== null} onClick={() => void runCheck()} data-testid="reconcile-check">
                {check ? "Check again" : "Check server"}
              </Button>
              {check && (
                <Badge tone={check.result === "recorded" ? "green" : check.result === "not-recorded" ? "slate" : "amber"}>
                  <span data-testid="reconcile-check-result" data-result={check.result}>{RESULT_TEXT[check.result]}</span>
                </Badge>
              )}
            </div>
            {check && (
              <div className="mt-2 text-xs text-slate-600">
                <p data-testid="reconcile-check-detail">{check.detail}</p>
                {found.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {found.map((s) => <li key={s.saleId} data-testid="reconcile-found-sale">{saleText(s)}</li>)}
                  </ul>
                )}
              </div>
            )}
          </section>

          {check && (
            <section>
              <h4 className="font-semibold text-slate-700">2. Resolution</h4>
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2">
                  <input type="radio" name="resolution" disabled={busy || check.result !== "recorded"}
                    checked={resolution === "matched"} onChange={() => setResolution("matched")} data-testid="reconcile-resolution-matched" />
                  <span><b>Matched</b>: the server already has it (the sale found above).</span>
                </label>
                {check.result === "inconclusive" && (
                  <p className="ml-6 text-xs text-amber-700" data-testid="reconcile-inconclusive-note">
                    The server check is inconclusive, so this entry cannot be matched or re-entered. Keep it set aside and compare it with the export.
                  </p>
                )}
                <label className="flex items-start gap-2">
                  <input type="radio" name="resolution" disabled={busy || check.result !== "not-recorded"}
                    checked={resolution === "recreated"} onChange={() => setResolution("recreated")} data-testid="reconcile-resolution-recreated" />
                  <span><b>Recreated</b>: you rang it up again through the normal POS flow. Enter the new receipt number.</span>
                </label>
                {resolution === "recreated" && (
                  <div className="ml-6 flex items-center gap-2">
                    <Input value={recreatedRef} onChange={(e) => { setRecreatedRef(e.target.value); setRecreatedSale(null); }}
                      placeholder="Receipt no. or sale id" className="max-w-xs" data-testid="reconcile-recreated-input" />
                    <Button variant="secondary" size="sm" disabled={busy || !recreatedRef.trim()} onClick={() => void verifyRecreated()} data-testid="reconcile-recreated-verify">
                      Verify on server
                    </Button>
                    {recreatedSale && <Badge tone="green">{saleText(recreatedSale)}</Badge>}
                    {recreatedError && <span className="text-xs text-rose-700">{recreatedError}</span>}
                  </div>
                )}
                <label className="flex items-start gap-2">
                  <input type="radio" name="resolution" disabled={busy || check.result !== "not-recorded"}
                    checked={resolution === "cancelled"} onChange={() => setResolution("cancelled")} data-testid="reconcile-resolution-cancelled" />
                  <span><b>Cancelled</b>: it did not happen / was called off. Only when the server check says "not recorded".</span>
                </label>
              </div>
            </section>
          )}

          {check && (
            <section>
              <h4 className="font-semibold text-slate-700">3. Reason</h4>
              <textarea
                className="mt-1 w-full rounded-xl border border-slate-200 p-2 text-sm"
                rows={3} maxLength={REASON_MAX_LENGTH} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="What happened and how you checked it" data-testid="reconcile-reason"
              />
            </section>
          )}

          <p className="text-xs text-slate-500">
            On "Reconcile" the app asks the server, right now, whether you are the owner (it does not work offline). The
            entry stays on this till with its payload and key, is included in every export, and no longer holds back
            updates. A correction (refund, re-entry) goes through the normal POS screens.
          </p>
          {error && <p className="text-sm text-rose-700" data-testid="reconcile-error">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
