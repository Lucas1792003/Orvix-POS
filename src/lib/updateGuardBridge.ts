// ----------------------------------------------------------------------
// Renderer half of the desktop updater guard (electron/updateGuard.cjs).
// Reports the facts the main process needs before it may install an
// update: how many outbox entries are unsynced (any status, quarantined
// included), online, signed in, a sale in progress, and whether the
// current queue was exported in this session. Reports on every change of
// those stores and every 30 s (main distrusts a report older than 2 min).
// Also handles the notice's buttons: "Export pending" opens the export
// dialog, "Sync now" runs a drain.
// No-op outside Electron or with an older preload script.
// ----------------------------------------------------------------------
import type { ElectronAppState } from "../types/electron";
import { localDb } from "./localDb";
import { exportCovers, onQueueExported } from "./queueExport/exportRecord";
import { useSyncStore } from "../stores/syncStore";
import { useConnectivityStore } from "../stores/connectivityStore";
import { useAuthStore } from "../stores/authStore";
import { useSaleActivityStore } from "../stores/saleActivityStore";
import { drainOutbox, refreshSyncStatus } from "../stores/data/outbox";

export const HEARTBEAT_MS = 30_000;

/** Pure: the report for the given facts (exported for tests). */
export function buildAppState(input: {
  outboxIds: readonly string[];
  statuses: readonly string[];
  online: boolean;
  authenticated: boolean;
  saleInProgress: boolean;
  exportCoversQueue: boolean;
}): ElectronAppState {
  const count = (s: string) => input.statuses.filter((x) => x === s).length;
  return {
    unsynced: input.outboxIds.length,
    pending: count("pending") + count("syncing") + count("failed"),
    conflict: count("conflict"),
    quarantined: count("quarantined"),
    online: input.online,
    authenticated: input.authenticated,
    saleInProgress: input.saleInProgress,
    exportCoversQueue: input.exportCoversQueue,
  };
}

export async function collectAppState(): Promise<ElectronAppState> {
  const rows = await localDb.syncOutbox.toArray();
  const ids = rows.map((r) => r.localId);
  const auth = useAuthStore.getState();
  return buildAppState({
    outboxIds: ids,
    statuses: rows.map((r) => r.status),
    online: useConnectivityStore.getState().isOnline,
    authenticated: Boolean(auth.currentUserId) && !useSyncStore.getState().needsReauth,
    saleInProgress: useSaleActivityStore.getState().saleInProgress,
    exportCoversQueue: ids.length > 0 && exportCovers(ids),
  });
}

export function startUpdateGuardBridge(): () => void {
  const api = typeof window === "undefined" ? undefined : window.electronAPI;
  if (!api?.reportAppState) return () => undefined;
  const report = api.reportAppState;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      collectAppState().then(report).catch((err) => console.error("[update] could not report app state:", err));
    }, 150);
  };

  const unsubs = [
    useSyncStore.subscribe(send),
    useConnectivityStore.subscribe(send),
    useAuthStore.subscribe(send),
    useSaleActivityStore.subscribe(send),
    onQueueExported(send),
  ];
  const heartbeat = setInterval(send, HEARTBEAT_MS);
  void refreshSyncStatus();
  send();

  const offRequest = api.onUpdateRequest?.((request) => {
    if (request?.action === "open-export") useSyncStore.getState().setStatus({ exportRequestedAt: Date.now() });
    if (request?.action === "sync-now") {
      drainOutbox().catch((err) => console.error("[update] sync-now drain failed:", err)).finally(send);
    }
  });

  return () => {
    for (const u of unsubs) u();
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    offRequest?.();
  };
}
