import { useCallback, useEffect, useState } from "react";
import { currentBackendOrigin } from "../../lib/backendOrigin";
import { attestTill, refreshTill, requestEnrollment, tillView, type TillView } from "../../recovery/deviceTrust";
import { onRecoveryV1Change, recoveryV1View, type RecoveryV1Status } from "../../recovery/client";
import { uploadRecoveryEvidence } from "../../recovery/sync";

// Recovery V1, Step 5: this till's owner-approved device identity (docs/recovery-v1/STEP5-DESIGN.md §1).
// Shown while the server runs Recovery V1. Sales stay refused (by the till AND by the server) until the owner approves this
// till and the approval verifies against the owner key provisioned on it. Nothing here can approve a till.

const RE_ENROLL = new Set(["revoked", "replaced", "expired", "invalid", "unverified", "damaged"]);

export function DeviceTrustPanel({ orgId, shopId }: { orgId: string; shopId: string }) {
  const origin = currentBackendOrigin();
  const [view, setView] = useState<TillView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (ask: boolean) => {
    try {
      const online = typeof navigator === "undefined" || navigator.onLine !== false;
      setView(ask && online ? await refreshTill(origin, orgId, shopId) : await tillView(origin, orgId, shopId));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setView(await tillView(origin, orgId, shopId).catch(() => null)); }
  }, [origin, orgId, shopId]);
  // Step 5: while the organization is restricted or reconciling, a trusted till reports to the owner's reconciliation: a signed
  // statement for the current incident (journal head, operations it still holds) and its evidence journal (best effort)
  useEffect(() => {
    if (view?.phase !== "trusted") return;
    let alive = true;
    const report = async () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      const marker = await recoveryV1View(orgId).catch(() => null);
      const s = marker?.status as (RecoveryV1Status & { incident_id?: string; recovery_epoch?: number }) | null | undefined;
      if (!alive || !s || (s.state !== "RESTRICTED" && s.state !== "RECONCILING") || !s.incident_id || !s.recovery_epoch) return;
      await attestTill(origin, orgId, shopId, { incidentId: s.incident_id, recoveryEpoch: s.recovery_epoch }).catch(() => undefined);
      await uploadRecoveryEvidence(orgId, shopId).catch(() => undefined);
    };
    void report();
    const off = onRecoveryV1Change(() => void report());
    const timer = window.setInterval(() => void report(), 60_000);
    return () => { alive = false; off(); window.clearInterval(timer); };
  }, [view?.phase, origin, orgId, shopId]);
  useEffect(() => {
    let alive = true;
    void load(true);
    // while an approval is awaited, ask the server again now and then (never while offline)
    const timer = window.setInterval(() => { if (alive) void load(true); }, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [load]);
  const act = async (fn: () => Promise<TillView>) => {
    setBusy(true); setError(null);
    try { setView(await fn()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (!view) return null;
  const trusted = view.phase === "trusted";
  return (
    <div role={trusted ? "status" : "alert"} data-testid="device-trust-panel" data-phase={view.phase}
      className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-sm print-hidden ${trusted
        ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-indigo-300 bg-indigo-50 text-indigo-900"}`}>
      <span>
        <strong>{trusted ? "Trusted till." : "Device enrollment."}</strong> {view.message}
        {view.shortCode && !trusted ? <> Code: <code data-testid="device-trust-code" className="font-mono">{view.shortCode}</code>.</> : null}
        {trusted && view.notAfter ? <> Approved until {new Date(view.notAfter).toLocaleDateString()}.</> : null}
        {error ? <span data-testid="device-trust-error" className="ml-2 text-rose-700">{error}</span> : null}
      </span>
      <span className="flex gap-2">
        {view.phase === "none" && (
          <button type="button" data-testid="device-trust-request" disabled={busy} className="rounded border px-2 py-1 text-xs font-medium"
            onClick={() => void act(() => requestEnrollment(origin, orgId, shopId))}>Request enrollment</button>
        )}
        {view.phase === "pending" && (
          <button type="button" data-testid="device-trust-check" disabled={busy} className="rounded border px-2 py-1 text-xs font-medium"
            onClick={() => void act(() => refreshTill(origin, orgId, shopId))}>Check approval</button>
        )}
        {RE_ENROLL.has(view.phase) && (
          <button type="button" data-testid="device-trust-reenroll" disabled={busy} className="rounded border px-2 py-1 text-xs font-medium"
            onClick={() => void act(() => requestEnrollment(origin, orgId, shopId, { replace: true }))}>Re-enroll this till</button>
        )}
      </span>
    </div>
  );
}
