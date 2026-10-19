import { useCallback, useEffect, useRef, useState } from "react";
import { useDataStore } from "../stores/dataStore";
import { useSyncStore } from "../stores/syncStore";
import { useAuthStore } from "../stores/authStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { UnresolvedOperationsSection } from "../components/sync/UnresolvedOperationsSection";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { Table, THead, TBody, TR, TH, TD } from "../components/ui/Table";
import { useToast } from "../components/ui/Toast";
import {
  confirmWithServer, drainOutbox, isUndecided, listOutboxEntries, restoreSetAsideEntry, retryOutboxEntry, setAsideOutboxEntry,
  STOP_STATEMENT_MIN, stopOnServer,
} from "../stores/data/outbox";
import { onQueueExported, wasExported } from "../lib/queueExport/exportRecord";
import {
  SET_ASIDE_BLOCK_TEXT, SET_ASIDE_DONE_TEXT, createSingleFlight, setAsideBlock, setAsideConfirmText,
} from "../lib/outboxSetAsidePolicy";
import type { SyncOutboxEntry } from "../lib/localDb";
import { ExportQueueDialog } from "../components/sync/ExportQueueDialog";
import { ReconcileDialog } from "../components/sync/ReconcileDialog";
import { desktopVerifyDeps, verifyReconciledEntries } from "../stores/data/reconcile";
import { isReconcilableStatus } from "../lib/reconcile/policy";
import { useTranslation } from "../hooks/useTranslation";
import { useUnresolvedOnlineOperations } from "../hooks/useUnresolvedOnlineOperations";
import { acknowledgeContinuity, continuityWarning, journalSummary, type ContinuityWarning, type JournalSummary } from "../stores/data/opJournal";

const RPC_LABELS: Record<string, string> = {
  complete_sale: "POS Sale",
  adjust_stock: "Stock Adjustment",
  open_shift: "Shift Opened",
  close_shift: "Shift Closed",
  create_refund_void_request: "Refund/Void Request",
  receive_purchase_order: "Purchase Order Received",
  record_supplier_payment: "Supplier Payment",
  dispatch_stock_transfer: "Transfer Dispatched",
  receive_stock_transfer: "Transfer Received",
};

// table_write entries (see tableWrite.ts) are named "<table>.<op>" — turn
// that into something readable, e.g. "categories.insert" -> "Category Added".
const TABLE_LABELS: Record<string, string> = {
  categories: "Category",
  brands: "Brand",
  unit_types: "Unit Type",
  price_tiers: "Price Tier",
  shops: "Shop",
  users: "User",
  suppliers: "Supplier",
};

const OP_LABELS: Record<string, string> = {
  insert: "Added",
  update: "Updated",
  delete: "Deleted",
};

const describeEntry = (entry: SyncOutboxEntry): string => {
  if (entry.kind === "table_write" && entry.table && entry.op) {
    const tableLabel = TABLE_LABELS[entry.table] ?? entry.table;
    const opLabel = OP_LABELS[entry.op] ?? entry.op;
    return `${tableLabel} ${opLabel}`;
  }
  return RPC_LABELS[entry.name] ?? entry.name;
};

// Transient (auto-retrying) vs permanent (needs a person) — the two look
// the same in the queue but mean very different things for the operator.
type EntryKind =
  | "quarantined" | "refused-final" | "abandoned" | "conflict" | "not-recorded" | "verifying" | "other-user" | "reply-elsewhere"
  | "unconfirmed" | "retrying" | "waiting" | "queued" | "blocking" | "refused-unrecorded" | "reconcile";

const classify = (entry: SyncOutboxEntry): EntryKind => {
  if (entry.status === "quarantined") return "quarantined";
  // 086: the server's final decision on this key — never sent again.
  if (entry.serverOutcome === "rejected") return "refused-final";
  if (entry.serverOutcome === "abandoned") return "abandoned";
  if (entry.heldReason === "committed-verifying") return "verifying";
  // W10 Phase 0: the server has no record of it; never stopped automatically.
  if (entry.heldReason === "reconciliation-required") return "reconcile";
  // Never authorised offline, outcome unknown: asked about, never resent.
  if (entry.fenceRequired === true) return "not-recorded";
  if (entry.heldReason === "committed-reply-unavailable") return "reply-elsewhere";
  if (entry.heldReason === "needs-original-user") return "other-user";
  // A refusal the server did not record: not final, a person decides.
  if (entry.heldReason === "not-recorded") return "refused-unrecorded";
  if (entry.status === "conflict" && entry.blocksQueue === true) return "blocking";
  if (entry.status === "conflict") return "conflict";
  // Sent, outcome unknown: resent with the same key, never applied twice.
  if (entry.inDoubt === true || (entry.writeAhead === true && entry.status === "syncing")) return "unconfirmed";
  if (entry.failureKind === "transient" && entry.lastError) return "retrying";
  if (entry.refs?.length) return "waiting";
  return "queued";
};

// `now` is captured when the list was loaded (render must stay pure).
const StatusBadge = ({ entry, now }: { entry: SyncOutboxEntry; now: number }) => {
  const kind = classify(entry);
  if (kind === "quarantined") return <Badge tone="red">Other server: not sent, export for the owner</Badge>;
  if (kind === "refused-final") return <Badge tone="red">Refused by the server — final, never resent</Badge>;
  if (kind === "abandoned") return <Badge tone="red">Not applied — stopped on the server before it ran</Badge>;
  if (kind === "conflict") return <Badge tone="red">Needs action</Badge>;
  if (kind === "blocking") return <Badge tone="red">Needs action — not decided on the server; later entries that may depend on it wait behind it</Badge>;
  if (kind === "refused-unrecorded") return <Badge tone="red">Refused, but not recorded on the server — not final; needs a person (asked again later)</Badge>;
  if (kind === "reconcile") return <Badge tone="red">Reconciliation required — the server has no record of it; an owner decides (never stopped automatically)</Badge>;
  if (kind === "not-recorded") return <Badge tone="amber">Not recorded on this till — being confirmed with the server, never resent</Badge>;
  if (kind === "verifying") return <Badge tone="sky">Applied on the server — confirming</Badge>;
  if (kind === "reply-elsewhere") return <Badge tone="sky">Applied on the server — its user or an administrator must confirm it here</Badge>;
  if (kind === "other-user") return <Badge tone="slate">Entered by another user — sent when they sign in on this till</Badge>;
  if (kind === "unconfirmed") return <Badge tone="sky">Awaiting confirmation — resent with its original key</Badge>;
  if (kind === "retrying") {
    const next = entry.nextAttemptAt ? new Date(entry.nextAttemptAt) : null;
    const due = next && next.getTime() > now ? `next try ${next.toLocaleTimeString()}` : "retrying now";
    return <Badge tone="amber">Retrying automatically — {due}</Badge>;
  }
  if (kind === "waiting") return <Badge tone="slate">Waiting on an earlier entry</Badge>;
  return <Badge tone="slate">Queued</Badge>;
};

export const SyncConflictsPage = () => {
  const shops = useDataStore((state) => state.shops);
  const needsReauth = useSyncStore((state) => state.needsReauth);
  // Owner = ADMIN from the server-verified app user (authStore); the outbox
  // functions check it again.
  const isOwner = useAuthStore((state) => Boolean(state.currentUserId) && state.currentRole === "ADMIN");
  const unresolvedMoneyOps = useUnresolvedOnlineOperations(useAuthStore((state) => state.currentOrgId));
  const addToast = useToast();
  const [entries, setEntries] = useState<SyncOutboxEntry[]>([]);
  const [loadedAt, setLoadedAt] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  // One action at a time for the whole list (RC2, D1): every action button
  // is disabled while an action runs or the list reloads, and the
  // single-flight guard refuses a second call that slips in before React
  // re-renders — a double click cannot act on the row that moved up.
  const [busy, setBusy] = useState(false);
  const flight = useRef(createSingleFlight());
  const [exportOpen, setExportOpen] = useState(false);
  // The entry the confirmation dialog is about, fixed when it opens.
  const [confirmEntry, setConfirmEntry] = useState<SyncOutboxEntry | null>(null);
  // W10 Phase 0: the entry the "Stop on server" dialog is about, and the owner's statement.
  const [stopEntry, setStopEntry] = useState<SyncOutboxEntry | null>(null);
  const [stopStatement, setStopStatement] = useState("");
  // W8 Phase 0: the server-continuity warning and the till's operation journal.
  const [continuity, setContinuity] = useState<ContinuityWarning | null>(null);
  const [journal, setJournal] = useState<JournalSummary | null>(null);
  const [ackOpen, setAckOpen] = useState(false);
  const [ackStatement, setAckStatement] = useState("");
  const orgId = useAuthStore((state) => state.currentOrgId);
  // RC3: the entry the reconcile dialog is about.
  const [reconcileEntry, setReconcileEntry] = useState<SyncOutboxEntry | null>(null);
  const [, setExportTick] = useState(0);
  const { t } = useTranslation();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      // RC3: a reconciled row whose record no longer checks out goes back to
      // Set aside (needs attention) before the list is shown.
      await verifyReconciledEntries(desktopVerifyDeps()).catch((err) => console.error("[sync] reconciliation check failed:", err));
      setEntries(await listOutboxEntries());
      setContinuity(await continuityWarning());
      setJournal(await journalSummary(orgId ?? null).catch(() => null));
      setLoadedAt(Date.now());
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-render after an export so "Set aside" reflects what was exported.
  useEffect(() => onQueueExported(() => setExportTick((n) => n + 1)), []);

  const shopName = (shopId: string | null) => shops.find((s) => s.id === shopId)?.name ?? shopId ?? "—";
  const queueEntries = entries.filter((e) => e.status !== "archived" && e.status !== "reconciled");
  const setAsideEntries = entries.filter((e) => e.status === "archived");
  const reconciledEntries = entries.filter((e) => e.status === "reconciled");
  const conflictCount = queueEntries.filter((e) => e.status === "conflict").length;
  const pendingCount = queueEntries.length - conflictCount;
  const locked = busy || isLoading;

  const runAction = async (fn: () => Promise<void>) => {
    await flight.current.run(async () => {
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
      }
    });
  };

  const handleRetry = (entry: SyncOutboxEntry) => runAction(async () => {
    try {
      await retryOutboxEntry(entry.localId);
      const result = await drainOutbox();
      await refresh();
      if (result === "needs-reauth") {
        addToast({ variant: "error", title: "Sign in required", description: "The server rejected this device's sign-in. Sign in again to resume syncing." });
      } else if (result === "network") {
        addToast({ variant: "error", title: "Still unreachable", description: "The server could not be reached. The entry stays queued and will be retried automatically." });
      } else {
        addToast(entry.fenceRequired
          ? { variant: "success", title: "Checked again", description: "The server was asked about this entry again. It is never resent; its status above shows the answer." }
          : { variant: "success", title: "Retried", description: "The queued entry was resubmitted." });
      }
    } catch (err) {
      addToast({ variant: "error", title: "Retry failed", description: err instanceof Error ? err.message : "Please try again." });
    }
  });

  // Opens the confirmation dialog; nothing changes until it is confirmed.
  const askSetAside = (entry: SyncOutboxEntry) => {
    if (locked || flight.current.running) return;
    const block = setAsideBlock(entry, { isOwner, wasExported });
    if (block) {
      addToast({ variant: "error", title: block === "export-first" ? "Export first" : "Not allowed", description: SET_ASIDE_BLOCK_TEXT[block] });
      return;
    }
    setConfirmEntry(entry);
  };

  const confirmSetAside = () => runAction(async () => {
    const entry = confirmEntry;
    if (!entry) return;
    try {
      await setAsideOutboxEntry(entry.localId, { wasExported });
      addToast({ variant: "success", title: "Set aside (not deleted)", description: SET_ASIDE_DONE_TEXT });
    } catch (err) {
      addToast({ variant: "error", title: "Not set aside", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setConfirmEntry(null);
      await refresh();
    }
  });

  // M3 / W10 Phase 0: ask the server (read-only; "not found" stops nothing —
  // the owner decides with "Stop on server")
  // before an owner documents it as "recreated" / "cancelled".
  const handleConfirm = (entry: SyncOutboxEntry) => runAction(async () => {
    try {
      const r = await confirmWithServer(entry.localId);
      const text = {
        committed: "It reached the server and has now been recorded on this till.",
        rejected: "The server refused it (final). It never ran.",
        abandoned: "The server records it as stopped before it ran; it can never be applied. Export again, then reconcile it.",
        "not-found": "The server has no record of it. Nothing was stopped: it may never have arrived, or it may have been applied on a server that was later restored. Check your records (receipts, cash, the daily report), then decide — Stop on server, or reconcile.",
        undecided: "The server could not decide it right now (unreachable, still running, or another user's). Nothing changed; try again later.",
      }[r];
      addToast({ variant: r === "undecided" || r === "not-found" ? "error" : "success", title: "Confirm with server", description: text });
    } catch (err) {
      addToast({ variant: "error", title: "Confirm with server", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      await refresh();
    }
  });

  const confirmStop = () => runAction(async () => {
    const entry = stopEntry;
    if (!entry) return;
    try {
      const r = await stopOnServer(entry.localId, stopStatement);
      const text = {
        committed: "It HAD been applied on the server: it is now recorded on this till, and nothing was stopped.",
        rejected: "The server had refused it (final). Nothing else changed.",
        abandoned: "Stopped on the server: it can never run under its key. Your statement is in the till's journal. Export again, then reconcile it.",
        undecided: "The server could not decide it right now. Nothing changed; try again later.",
      }[r];
      addToast({ variant: r === "undecided" ? "error" : "success", title: "Stop on server", description: text });
      setStopEntry(null);
      setStopStatement("");
    } catch (err) {
      addToast({ variant: "error", title: "Stop on server", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      await refresh();
    }
  });

  const confirmAcknowledge = () => runAction(async () => {
    try {
      await acknowledgeContinuity(useAuthStore.getState().currentUserId ?? null, ackStatement);
      addToast({ variant: "success", title: "Acknowledged", description: "Automatic sync resumes. The records the server no longer has are kept on this till as evidence." });
      setAckOpen(false);
      setAckStatement("");
      void drainOutbox().catch(() => undefined);
    } catch (err) {
      addToast({ variant: "error", title: "Not acknowledged", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      await refresh();
    }
  });

  const handleRestore = (entry: SyncOutboxEntry) => runAction(async () => {
    try {
      const restored = await restoreSetAsideEntry(entry.localId);
      addToast({ variant: "success", title: "Restored", description: `Back in the queue (${restored.status}) with its original idempotency key.` });
    } catch (err) {
      addToast({ variant: "error", title: "Not restored", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      await refresh();
    }
  });

  const summary = isLoading
    ? "Loading…"
    : `${conflictCount} ${conflictCount === 1 ? "conflict" : "conflicts"} · ${pendingCount} ${pendingCount === 1 ? "entry" : "entries"} still syncing` +
      (setAsideEntries.length > 0 ? ` · ${setAsideEntries.length} set aside` : "") +
      (reconciledEntries.length > 0 ? ` · ${reconciledEntries.length} reconciled` : "");

  return (
    <Card>
      <PageHeader
        title="Sync Conflicts"
        subtitle="Everything recorded on this device that has not reached the server yet. Entries the server rejected need a manual look; the rest are retried automatically."
      />
      {needsReauth && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          The server rejected this device's sign-in, so nothing is being sent. Sign in again (sidebar → Logout, then
          log in) — every entry below is kept and will sync afterwards.
        </div>
      )}
      {continuity && (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900" data-testid="continuity-warning">
          <p className="font-semibold">Automatic sync is paused: the server may have been restored from an older backup.</p>
          <p className="mt-1">{continuity.reason} (since {new Date(continuity.since).toLocaleString()}). Those records are kept on this till.
            Nothing queued is sent or stopped automatically until an owner has checked what happened (export first).</p>
          {isOwner && (
            <Button className="mt-2" variant="danger" size="sm" disabled={locked} onClick={() => { setAckStatement(""); setAckOpen(true); }} data-testid="continuity-ack">
              Acknowledge and resume…
            </Button>
          )}
        </div>
      )}
      {journal && journal.total > 0 && (
        <p className="mt-3 text-xs text-slate-500" data-testid="journal-summary">
          Operation journal on this till: {journal.total} — {journal.byCategory["confirmed-committed"]} confirmed committed ·{" "}
          {journal.byCategory["confirmed-not-applied"]} confirmed not applied · {journal.byCategory["never-sent"]} never sent ·{" "}
          {journal.byCategory["unknown-outcome"]} outcome unknown · {journal.byCategory["reconciliation-required"]} reconciliation required ·{" "}
          {journal.byCategory["owner-decided"]} decided by an owner{journal.contradictions ? ` · ${journal.contradictions} contradicting the server` : ""}{journal.damaged ? ` · ${journal.damaged} unreadable` : ""}. Kept after sync; included in every export.
        </p>
      )}
      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm text-slate-500">{summary}</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)} disabled={(entries.length === 0 && unresolvedMoneyOps.total === 0 && !unresolvedMoneyOps.readError) || busy} data-testid="sync-export-open">
            {t("queueExport", "buttonLong")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={locked}>
            Refresh
          </Button>
        </div>
      </div>
      <ExportQueueDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <UnresolvedOperationsSection isOwner={isOwner} />
      <div className="mt-4">
        {!isLoading && queueEntries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300/70 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
            {setAsideEntries.length === 0
              ? "Nothing waiting. Everything recorded on this device has synced cleanly."
              : "Nothing waiting to sync. Entries the owner set aside are listed below."}
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Action</TH>
                <TH>Shop</TH>
                <TH>Queued at</TH>
                <TH>Status</TH>
                <TH>Last error</TH>
                <TH>Attempts</TH>
                <TH>&nbsp;</TH>
              </TR>
            </THead>
            <TBody>
              {queueEntries.map((entry) => {
                const block = setAsideBlock(entry, { isOwner, wasExported });
                return (
                  <TR key={entry.localId} data-testid="outbox-row" data-status={entry.status}>
                    <TD>{describeEntry(entry)}</TD>
                    <TD>{shopName(entry.shopId)}</TD>
                    <TD>{new Date(entry.createdAt).toLocaleString()}</TD>
                    <TD><StatusBadge entry={entry} now={loadedAt} /></TD>
                    <TD>
                      <span className="text-xs text-slate-600 break-words" title={entry.quarantineReason ?? entry.lastError}>
                        {entry.status === "quarantined" ? entry.quarantineReason ?? "Queued for another server." : entry.lastError ?? "—"}
                      </span>
                    </TD>
                    <TD>{entry.attempts}</TD>
                    <TD>
                      <div className="flex justify-end gap-2">
                        {entry.status !== "quarantined" && !entry.serverOutcome && (
                          <Button variant="secondary" size="sm" disabled={locked} onClick={() => void handleRetry(entry)}>
                            Retry
                          </Button>
                        )}
{isOwner && isUndecided(entry) && (
                          <Button variant="secondary" size="sm" disabled={locked} onClick={() => void handleConfirm(entry)} data-testid="outbox-confirm"
                            title="Ask the server what happened to it (read-only; never resent, never stopped)">
                            Confirm with server
                          </Button>
                        )}
                        {isOwner && entry.heldReason === "reconciliation-required" && entry.fenceRequired === true && (
                          <Button variant="danger" size="sm" disabled={locked} onClick={() => { setStopStatement(""); setStopEntry(entry); }} data-testid="outbox-stop"
                            title="Owner decision: stop it on the server so it can never run (only after establishing it did not happen)">
                            Stop on server…
                          </Button>
                        )}
                        {isOwner && (
                          <Button
                            variant="secondary" size="sm"
                            disabled={locked || !isReconcilableStatus(entry.status)}
                            title={isReconcilableStatus(entry.status) ? "Document what happened to it (owner)" : "Still in the sync queue: set it aside first, then reconcile it."}
                            onClick={() => setReconcileEntry(entry)}
                            data-testid="outbox-reconcile"
                          >
                            Reconcile
                          </Button>
                        )}
                        <Button
                          variant="danger" size="sm"
                          disabled={locked || block === "not-owner"}
                          title={block ? SET_ASIDE_BLOCK_TEXT[block] : "Stop sending it, without deleting it (owner)"}
                          onClick={() => askSetAside(entry)}
                          data-testid="outbox-set-aside"
                        >
                          Set aside
                        </Button>
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>
      {setAsideEntries.length > 0 && (
        <div className="mt-6" data-testid="set-aside-list">
          <h3 className="text-sm font-semibold text-slate-700">Set aside ({setAsideEntries.length})</h3>
          <p className="mt-1 text-xs text-slate-500">
            Not sent to the server and not deleted. Included in every export and still counted as not synced by the
            updater. The owner can put an entry back in the queue.
          </p>
          <div className="mt-2">
            <Table>
              <THead>
                <TR>
                  <TH>Action</TH>
                  <TH>Shop</TH>
                  <TH>Queued at</TH>
                  <TH>Set aside at</TH>
                  <TH>Was</TH>
                  <TH>&nbsp;</TH>
                </TR>
              </THead>
              <TBody>
                {setAsideEntries.map((entry) => (
                  <TR key={entry.localId} data-testid="set-aside-row">
                    <TD>{describeEntry(entry)}</TD>
                    <TD>{shopName(entry.shopId)}</TD>
                    <TD>{new Date(entry.createdAt).toLocaleString()}</TD>
                    <TD>{entry.archivedAt ? new Date(entry.archivedAt).toLocaleString() : "—"}</TD>
                    <TD>
                      <Badge tone="slate">{entry.statusBeforeArchive ?? "—"}</Badge>
                      {entry.reconcileRejected && (
                        <span className="ml-1" data-testid="reconcile-rejected" title={entry.reconcileRejected.reason}>
                          <Badge tone="red">Reconciliation rejected: needs attention</Badge>
                        </span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex justify-end gap-2">
{isOwner && isUndecided(entry) && (
                          <Button variant="secondary" size="sm" disabled={locked} onClick={() => void handleConfirm(entry)} data-testid="set-aside-confirm"
                            title="Ask the server what happened to it (read-only; never resent, never stopped)">
                            Confirm with server
                          </Button>
                        )}
                        {isOwner && (
                          <Button variant="secondary" size="sm" disabled={locked} onClick={() => setReconcileEntry(entry)} data-testid="set-aside-reconcile">
                            Reconcile
                          </Button>
                        )}
                        <Button
                          variant="secondary" size="sm"
                          disabled={locked || !isOwner}
                          title={isOwner ? "Put it back in the sync queue" : SET_ASIDE_BLOCK_TEXT["not-owner"]}
                          onClick={() => void handleRestore(entry)}
                          data-testid="set-aside-restore"
                        >
                          Restore
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </div>
      )}
      {reconciledEntries.length > 0 && (
        <div className="mt-6" data-testid="reconciled-list">
          <h3 className="text-sm font-semibold text-slate-700">Reconciled ({reconciledEntries.length})</h3>
          <p className="mt-1 text-xs text-slate-500">
            The owner documented what happened to these. They are never sent, stay on this till and in every export, and no
            longer hold back updates while their record checks out.
          </p>
          <div className="mt-2">
            <Table>
              <THead>
                <TR>
                  <TH>Action</TH>
                  <TH>Shop</TH>
                  <TH>Resolution</TH>
                  <TH>Server sale</TH>
                  <TH>Owner</TH>
                  <TH>Reconciled at</TH>
                  <TH>Reason</TH>
                </TR>
              </THead>
              <TBody>
                {reconciledEntries.map((entry) => {
                  const r = entry.reconciliation;
                  return (
                    <TR key={entry.localId} data-testid="reconciled-row" data-resolution={r?.resolution ?? ""}>
                      <TD>{describeEntry(entry)}</TD>
                      <TD>{shopName(entry.shopId)}</TD>
                      <TD><Badge tone={r?.resolution === "cancelled" ? "slate" : "green"}>{r?.resolution ?? "—"}</Badge></TD>
                      <TD>{r?.serverRef ? (r.serverRef.receiptNo ?? r.serverRef.saleId) : "—"}</TD>
                      <TD>{r?.owner?.name ?? "—"}</TD>
                      <TD>{r ? new Date(r.reconciledAt).toLocaleString() : "—"}</TD>
                      <TD><span className="text-xs text-slate-600 break-words">{r?.reason ?? ""}</span></TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        </div>
      )}
      <ReconcileDialog
        localId={reconcileEntry?.localId ?? null}
        label={reconcileEntry ? describeEntry(reconcileEntry) : ""}
        shop={reconcileEntry ? shopName(reconcileEntry.shopId) : ""}
        isOwner={isOwner}
        onClose={() => setReconcileEntry(null)}
        onDone={(row) => {
          setReconcileEntry(null);
          addToast({ variant: "success", title: "Reconciled", description: `Recorded as ${row.reconciliation?.resolution ?? "reconciled"}. The entry stays on this till and in every export; it no longer holds back updates.` });
          void refresh();
        }}
        onError={(message) => {
          addToast({ variant: "error", title: "Not reconciled", description: message });
          void refresh();
        }}
      />
      <Modal
        open={confirmEntry !== null}
        title="Set this entry aside?"
        description="It stops syncing. Nothing is deleted."
        onClose={() => { if (!busy) setConfirmEntry(null); }}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmEntry(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void confirmSetAside()} data-testid="set-aside-confirm">
              Set aside
            </Button>
          </div>
        }
      >
        {confirmEntry && (
          <>
            <p className="text-sm font-semibold text-slate-800" data-testid="set-aside-confirm-entry">
              {setAsideConfirmText(confirmEntry, describeEntry(confirmEntry), shopName(confirmEntry.shopId))}
            </p>
            <p className="mt-3 text-xs text-slate-600">{SET_ASIDE_DONE_TEXT}</p>
            <p className="mt-2 text-xs text-slate-600">
              The record on this till (e.g. the sale) stays as it is. If it was rung up for a customer, reconcile
              stock or the receipt manually.
            </p>
          </>
        )}
      </Modal>
      <Modal
        open={ackOpen}
        title="Acknowledge the server-continuity warning?"
        description="Automatic sync resumes. The evidence stays on this till."
        onClose={() => { if (!busy) setAckOpen(false); }}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setAckOpen(false)}>Cancel</Button>
            <Button variant="danger" size="sm" disabled={busy || ackStatement.trim().length < STOP_STATEMENT_MIN} onClick={() => void confirmAcknowledge()} data-testid="continuity-ack-confirm">
              Acknowledge and resume
            </Button>
          </div>
        }
      >
        <p className="text-xs text-slate-600">
          Resume only once you know why the server no longer has these records (for example: the server was restored and
          the lost operations have been reconciled, or the rows were removed on purpose). Queued operations will be sent
          again with their original keys.
        </p>
        <label className="mt-3 block text-xs font-medium text-slate-700" htmlFor="ack-statement">What you established (kept on this till)</label>
        <textarea id="ack-statement" data-testid="continuity-ack-statement" className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm" rows={3} maxLength={500}
          value={ackStatement} onChange={(e) => setAckStatement(e.target.value)} />
      </Modal>
      <Modal
        open={stopEntry !== null}
        title="Stop this operation on the server?"
        description="An owner decision. It cannot be undone."
        onClose={() => { if (!busy) setStopEntry(null); }}
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setStopEntry(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" disabled={busy || stopStatement.trim().length < STOP_STATEMENT_MIN} onClick={() => void confirmStop()} data-testid="outbox-stop-confirm">
              Stop on server
            </Button>
          </div>
        }
      >
        {stopEntry && (
          <>
            <p className="text-sm font-semibold text-slate-800">{describeEntry(stopEntry)} · {shopName(stopEntry.shopId)} · {new Date(stopEntry.createdAt).toLocaleString()}</p>
            <p className="mt-3 text-xs text-slate-600">
              The server has no record of this operation. That does not prove it never happened: if the server was
              restored from an older backup, it may have been applied and then lost. Once stopped, it can never be
              recorded under its key. Stop it only after checking receipts, cash and the daily report — and enter it
              again as a new operation if it did happen.
            </p>
            <label className="mt-3 block text-xs font-medium text-slate-700" htmlFor="stop-statement">What you established (kept in the till's journal)</label>
            <textarea
              id="stop-statement" data-testid="outbox-stop-statement"
              className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm" rows={3} maxLength={500}
              value={stopStatement} onChange={(e) => setStopStatement(e.target.value)}
            />
          </>
        )}
      </Modal>
      <p className="mt-4 text-xs text-slate-400">
        Retry sends the entry again right away with the same idempotency key, so an action the server already
        applied is never duplicated. Set aside (owner only, after exporting it in this session) stops sending an
        entry without deleting it: it stays on this till and in every export, and can be restored.
      </p>
    </Card>
  );
};
