import { useCallback, useEffect, useState } from "react";
import { useDataStore } from "../stores/dataStore";
import { useSyncStore } from "../stores/syncStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Table, THead, TBody, TR, TH, TD } from "../components/ui/Table";
import { useToast } from "../components/ui/Toast";
import { dismissOutboxEntry, drainOutbox, listOutboxEntries, retryOutboxEntry } from "../stores/data/outbox";
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
type EntryKind = "conflict" | "retrying" | "waiting" | "queued";

const classify = (entry: SyncOutboxEntry): EntryKind => {
  if (entry.status === "conflict") return "conflict";
  if (entry.failureKind === "transient" && entry.lastError) return "retrying";
  if (entry.refs?.length) return "waiting";
  return "queued";
};

// `now` is captured when the list was loaded (render must stay pure).
const StatusBadge = ({ entry, now }: { entry: SyncOutboxEntry; now: number }) => {
  const kind = classify(entry);
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
  const addToast = useToast();
  const [entries, setEntries] = useState<SyncOutboxEntry[]>([]);
  const [loadedAt, setLoadedAt] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
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

  const shopName = (shopId: string | null) => shops.find((s) => s.id === shopId)?.name ?? shopId ?? "—";
  const conflictCount = entries.filter((e) => e.status === "conflict").length;
  const pendingCount = entries.length - conflictCount;

  const handleRetry = async (entry: SyncOutboxEntry) => {
    setBusyId(entry.localId);
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
    } finally {
      setBusyId(null);
    }
  };

  const handleDismiss = async (entry: SyncOutboxEntry) => {
    setBusyId(entry.localId);
    try {
      await dismissOutboxEntry(entry.localId);
      await refresh();
      addToast({ variant: "success", title: "Dismissed", description: "The queued entry will no longer be retried. Its local record is kept." });
    } finally {
      setBusyId(null);
    }
  };

  const summary = isLoading
    ? "Loading…"
    : `${conflictCount} ${conflictCount === 1 ? "conflict" : "conflicts"} · ${pendingCount} ${pendingCount === 1 ? "entry" : "entries"} still syncing`;

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
          <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)} disabled={entries.length === 0}>
            {t("queueExport", "buttonLong")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={isLoading}>
            Refresh
          </Button>
        </div>
      </div>
      <ExportQueueDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <div className="mt-4">
        {!isLoading && entries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300/70 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
            Nothing waiting. Everything recorded on this device has synced cleanly.
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
              {entries.map((entry) => (
                <TR key={entry.localId}>
                  <TD>{describeEntry(entry)}</TD>
                  <TD>{shopName(entry.shopId)}</TD>
                  <TD>{new Date(entry.createdAt).toLocaleString()}</TD>
                  <TD><StatusBadge entry={entry} now={loadedAt} /></TD>
                  <TD>
                    <span className="text-xs text-slate-600 break-words" title={entry.lastError}>
                      {entry.lastError ?? "—"}
                    </span>
                  </TD>
                  <TD>{entry.attempts}</TD>
                  <TD>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary" size="sm"
                        disabled={busyId === entry.localId}
                        onClick={() => void handleRetry(entry)}
                      >
                        Retry
                      </Button>
                      <Button
                        variant="danger" size="sm"
                        disabled={busyId === entry.localId}
                        onClick={() => void handleDismiss(entry)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
      <p className="mt-4 text-xs text-slate-400">
        Retry sends the entry again right away with the same idempotency key, so an action the server already
        applied is never duplicated. Dismissing stops retrying the queued server call but leaves the original
        record (e.g. the sale) in place, flagged as not synced — reconcile stock or the customer's receipt
        manually before dismissing.
      </p>
    </Card>
  );
};
