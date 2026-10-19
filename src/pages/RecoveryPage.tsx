import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { useAuthStore } from "../stores/authStore";
import { recoveryMessage, useRecoveryStore } from "../stores/data/recoveryState";
import {
  approveTill, currentUploadPlan, ownerClearWitnessBehind, ownerConfirmRollback, registerThisTill, runRecoveryCheck, uploadTillJournal, type UploadPlan, type UploadResult,
} from "../stores/data/recovery87";

// Migration 087 recovery actions (any signed-in user; each action checks its
// own role and the server checks it again): see the state, ask the server
// again, upload this till's journal (cashier / manager), register this till
// and approve a till's journal (administrator with an authenticator app).
// docs/selfhost-migration/phase-g/migration-087.md ("Tills and reconciliation").

const describeUpload = (r: UploadResult): string => {
  switch (r.kind) {
    case "stored": return `Journal uploaded: ${r.records} operation record(s) in ${r.chunks} part(s). The administrator approves it next.`;
    case "not-required": return "The server does not need this till's journal (the till is already reconciled).";
    case "conflict": return `The server already holds different content for part ${r.chunk}. Nothing was overwritten; tell the owner.`;
    case "quota-exceeded": return `The server's journal storage for this organisation is full (part ${r.chunk}). Nothing was deleted; the owner must raise the quota.`;
    case "refused": return r.message;
    case "unreachable": return `The server could not be reached (${r.message}). Nothing is lost; try again.`;
  }
};

export function RecoveryPage() {
  const view = useRecoveryStore((s) => s.view);
  const role = useAuthStore((s) => s.currentRole);
  const isAdmin = role === "ADMIN";
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [plan, setPlan] = useState<UploadPlan | null>(null);
  const [tillToApprove, setTillToApprove] = useState(view.serverTillId ?? view.tillId);
  const [rollbackNote, setRollbackNote] = useState("");

  useEffect(() => { void currentUploadPlan().then(setPlan, () => setPlan(null)); }, [view.mode, message]);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const shown = view.mode === "legacy-server" ? null : view.mode;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="recovery-page">
      <h1 className="text-lg font-semibold text-slate-900">Server recovery</h1>
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <div data-testid="recovery-state" data-mode={view.mode}>
          {view.mode === "legacy-server"
            ? "This server does not use recovery epochs (it has no migration 087). Sales follow the ordinary offline rules."
            : recoveryMessage(shown!, view.code)}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
          <dt>Till</dt><dd data-testid="recovery-till">{view.tillId}{view.tillRegistered ? " (registered)" : " (not registered)"}</dd>
          <dt>Epoch</dt><dd>{view.epochNo ?? "—"}</dd>
          <dt>Since</dt><dd>{view.since ?? "—"}</dd>
          <dt>Last verified by the server</dt><dd>{view.verifiedAt ?? "—"}</dd>
          <dt>Journal upload</dt><dd>{plan ? `${plan.recordCount} record(s), ${plan.chunks.length} part(s)${plan.completedAt ? ", done" : ""}` : "—"}</dd>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} data-testid="recovery-check"
            onClick={() => void act(async () => { const v = await runRecoveryCheck({ upload: false }); return v.allowed ? "The server verified this till." : recoveryMessage(v.mode === "legacy-server" ? "normal" : v.mode, v.code); })}>
            Check with the server now
          </Button>
          {!isAdmin && view.tillRegistered && (view.mode === "not-reconciled") && (
            <Button size="sm" variant="secondary" disabled={busy} data-testid="recovery-upload"
              onClick={() => void act(async () => describeUpload(await uploadTillJournal()))}>
              Upload this till's journal
            </Button>
          )}
          {isAdmin && view.tillRegistered && view.mode === "till-unregistered" && view.code === "TILL_UNKNOWN" && (
            <Button size="sm" variant="secondary" disabled={busy} data-testid="recovery-reregister"
              onClick={() => void act(async () => { const r = await registerThisTill({ replaceUnknown: true }); return `The server no longer knew this till; it is registered again as ${r.tillId} (the old registration is kept on this till as evidence).`; })}>
              Register this till again
            </Button>
          )}
          {isAdmin && !view.tillRegistered && view.capability !== "absent" && (
            <Button size="sm" variant="secondary" disabled={busy} data-testid="recovery-register"
              onClick={() => void act(async () => { const r = await registerThisTill(); return `Till ${r.tillId} registered. A cashier uploads its journal on this till; then you approve it here.`; })}>
              Register this till
            </Button>
          )}
        </div>
      </section>
      {isAdmin && view.capability !== "absent" && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <h2 className="mb-2 font-medium text-slate-800">Approve a till's journal</h2>
          <p className="mb-2 text-xs text-slate-600">
            Approve only after checking the till's uploaded journal. You cannot approve a journal you uploaded yourself.
            Approval does not reopen anything: sales resume only when the server issues the till its epoch.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input className="rounded border border-slate-300 px-2 py-1 text-sm" value={tillToApprove} data-testid="recovery-approve-till"
              onChange={(e) => setTillToApprove(e.target.value.trim())} aria-label="Till id" />
            <Button size="sm" variant="secondary" disabled={busy || !tillToApprove} data-testid="recovery-approve"
              onClick={() => void act(async () => { const r = await approveTill(tillToApprove); return `Till ${tillToApprove} approved for epoch ${r.reconciledEpochNo}.`; })}>
              Approve
            </Button>
          </div>
        </section>
      )}
      {isAdmin && view.code === "WITNESS_BEHIND" && (
        <section className="rounded-lg border border-rose-200 bg-white p-4 text-sm" data-testid="recovery-witness-behind">
          <h2 className="mb-2 font-medium text-slate-800">The server is behind what this till saw</h2>
          <p className="mb-2 text-xs text-slate-600">
            Check the server against its backups and this till's records first (export the queue and journal). Clearing keeps this
            till's record as evidence and asks the server again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input className="min-w-[20rem] flex-1 rounded border border-slate-300 px-2 py-1 text-sm" value={rollbackNote}
              onChange={(e) => setRollbackNote(e.target.value)} placeholder="What you checked and found" aria-label="Statement" />
            <Button size="sm" variant="secondary" disabled={busy || rollbackNote.trim().length < 15} data-testid="recovery-clear-witness"
              onClick={() => void act(async () => { const r = await ownerClearWitnessBehind(rollbackNote); return r.kind === "issued" ? "Cleared; the server verified this till." : `Cleared; the server answered: ${"message" in r ? r.message : r.kind}`; })}>
              Clear after checking
            </Button>
          </div>
        </section>
      )}
      {isAdmin && view.capability === "present" && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <h2 className="mb-2 font-medium text-slate-800">The server was rolled back to before the recovery update</h2>
          <p className="mb-2 text-xs text-slate-600">
            Only if migration 087 was removed from the server on purpose. The till checks with the server first (twice) and changes
            nothing unless the server confirms it. This till's recovery records are kept as evidence; queued operations keep their keys.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input className="min-w-[20rem] flex-1 rounded border border-slate-300 px-2 py-1 text-sm" value={rollbackNote}
              onChange={(e) => setRollbackNote(e.target.value)} placeholder="What was rolled back, when, and by whom" aria-label="Rollback statement" />
            <Button size="sm" variant="secondary" disabled={busy || rollbackNote.trim().length < 15} data-testid="recovery-rollback"
              onClick={() => void act(async () => { await ownerConfirmRollback(rollbackNote); return "Confirmed with the server: it no longer has the recovery update. This till works as before it."; })}>
              Confirm rollback
            </Button>
          </div>
        </section>
      )}
      {message && <p role="status" className="text-sm text-slate-800" data-testid="recovery-message">{message}</p>}
    </div>
  );
}

export default RecoveryPage;
