import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { localDb } from "../../lib/localDb";
import { recoveryMessage, useRecoveryStore } from "../../stores/data/recoveryState";
import { OWNER_REVIEW, onQueueChanged } from "../../stores/data/outbox";

// Migration 087: the till's recovery state, shown on every screen
// (docs/selfhost-migration/phase-g/migration-087.md, "Client contract").
// One line per state; no POS redesign. The state itself is durable
// (stores/data/recoveryState.ts) and is cleared only by the server.

const TITLE: Record<string, string> = {
  hold: "Recovery hold active",
  uncertain: "Server continuity uncertain",
  "till-unregistered": "Till reconciliation required",
  "not-reconciled": "Till reconciliation required",
  "no-epoch": "Waiting for the server",
  "unknown-server": "Server check required",
};

/** Queue entries that wait for an owner's review (087). */
function useOwnerReviewCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const count = () => {
      void localDb.syncOutbox.filter((e) => e.heldReason === OWNER_REVIEW && !e.serverOutcome).count()
        .then((c) => { if (alive) setN(c); }, () => undefined);
    };
    count();
    const off = onQueueChanged(() => count());
    return () => { alive = false; off(); };
  }, []);
  return n;
}

export function RecoveryBanner() {
  const view = useRecoveryStore((s) => s.view);
  const review = useOwnerReviewCount();
  const blocked = !view.allowed && view.orgId !== null;
  const [shownResume, setShownResume] = useState<string | null>(null);
  // "Safe to resume": shown after a blocked till was verified by the server again
  useEffect(() => {
    let timer: number | undefined;
    const off = useRecoveryStore.subscribe((next, prev) => {
      const was = prev.view.mode;
      // only a FRESH verification by the server, in the same organisation (not a state read from disk)
      if (next.view.mode !== "normal" || was === "normal" || was === "legacy-server" || was === "unknown-server"
          || next.view.orgId !== prev.view.orgId || !next.view.verifiedAt || next.view.verifiedAt === prev.view.verifiedAt) return;
      setShownResume(next.view.verifiedAt ?? "now");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShownResume(null), 60_000);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, []);

  return (
    <>
      {blocked && view.mode !== "normal" && view.mode !== "legacy-server" && (
        <div role="alert" data-testid="recovery-banner" data-mode={view.mode}
          className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-300 bg-rose-50 px-4 py-2 text-sm text-rose-900 print-hidden">
          <span>
            <strong>{TITLE[view.mode] ?? "Recovery"}.</strong> {recoveryMessage(view.mode, view.code)}
          </span>
          <Link to="/app/sync/recovery" className="text-xs font-medium underline" data-testid="recovery-banner-open">Recovery details</Link>
        </div>
      )}
      {review > 0 && (
        <div role="status" data-testid="recovery-review-banner"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 print-hidden">
          <span>
            <strong>Operation awaiting owner review.</strong> {review} {review === 1 ? "operation was" : "operations were"} created before the
            server's current recovery epoch. {review === 1 ? "It is" : "They are"} kept with the original key and data, never resent or
            stopped automatically; the owner reviews {review === 1 ? "it" : "them"}.
          </span>
        </div>
      )}
      {!blocked && shownResume && view.mode === "normal" && (
        <div role="status" data-testid="recovery-resumed"
          className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 print-hidden">
          <strong>Safe to resume.</strong> The server verified this till (epoch {view.epochNo}); new sales are allowed again.
        </div>
      )}
    </>
  );
}
