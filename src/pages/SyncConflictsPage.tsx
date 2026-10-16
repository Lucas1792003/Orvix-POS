import { useCallback, useEffect, useRef, useState } from "react";
import { useDataStore } from "../stores/dataStore";
import { useSyncStore } from "../stores/syncStore";
import { useAuthStore } from "../stores/authStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { Table, THead, TBody, TR, TH, TD } from "../components/ui/Table";
import { useToast } from "../components/ui/Toast";
import {
  drainOutbox, listOutboxEntries, restoreSetAsideEntry, retryOutboxEntry, setAsideOutboxEntry,
} from "../stores/data/outbox";
import { onQueueExported, wasExported } from "../lib/queueExport/exportRecord";
import {
  SET_ASIDE_BLOCK_TEXT, SET_ASIDE_DONE_TEXT, createSingleFlight, setAsideBlock, setAsideConfirmText,
} from "../lib/outboxSetAsidePolicy";
import type { SyncOutboxEntry } from "../lib/localDb";
import { ExportQueueDialog } from "../components/sync/ExportQueueDialog";
import { useTranslation } from "../hooks/useTranslation";

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
type EntryKind = "quarantined" | "conflict" | "retrying" | "waiting" | "queued";

const classify = (entry: SyncOutboxEntry): EntryKind => {
  if (entry.status === "quarantined") return "quarantined";
  if (entry.status === "conflict") return "conflict";
  if (entry.failureKind === "transient" && entry.lastError) return "retrying";
  if (entry.refs?.length) return "waiting";
  return "queued";
};

// `now` is captured when the list was loaded (render must stay pure).
const StatusBadge = ({ entry, now }: { entry: SyncOutboxEntry; now: number }) => {
  const kind = classify(entry);
  if (kind === "quarantined") return <Badge tone="red">Other server: not sent, export for the owner</Badge>;
  if (kind === "conflict") return <Badge tone="red">Needs action</Badge>;
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
  const [, setExportTick] = useState(0);
  const { t } = useTranslation();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setEntries(await listOutboxEntries());
      setLoadedAt(Date.now());
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-render after an export so "Set aside" reflects what was exported.
  useEffect(() => onQueueExported(() => setExportTick((n) => n + 1)), []);

  const shopName = (shopId: string | null) => shops.find((s) => s.id === shopId)?.name ?? shopId ?? "—";
  const queueEntries = entries.filter((e) => e.status !== "archived");
  const setAsideEntries = entries.filter((e) => e.status === "archived");
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
        addToast({ variant: "success", title: "Retried", description: "The queued entry was resubmitted." });
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
      (setAsideEntries.length > 0 ? ` · ${setAsideEntries.length} set aside` : "");

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
      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm text-slate-500">{summary}</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)} disabled={entries.length === 0 || busy}>
            {t("queueExport", "buttonLong")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={locked}>
            Refresh
          </Button>
        </div>
      </div>
      <ExportQueueDialog open={exportOpen} onClose={() => setExportOpen(false)} />
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
                        {entry.status !== "quarantined" && (
                          <Button variant="secondary" size="sm" disabled={locked} onClick={() => void handleRetry(entry)}>
                            Retry
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
                    <TD><Badge tone="slate">{entry.statusBeforeArchive ?? "—"}</Badge></TD>
                    <TD>
                      <div className="flex justify-end">
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
      <p className="mt-4 text-xs text-slate-400">
        Retry sends the entry again right away with the same idempotency key, so an action the server already
        applied is never duplicated. Set aside (owner only, after exporting it in this session) stops sending an
        entry without deleting it: it stays on this till and in every export, and can be restored.
      </p>
    </Card>
  );
};
