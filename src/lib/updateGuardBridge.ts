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
import { supabase } from "./supabase";

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

/** The signed-in session's access token (for main's owner check), or "". */
export async function currentAccessToken(): Promise<string> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  } catch {
    return "";
  }
}

/** True when the renderer believes the owner (ADMIN) is signed in. Only
 *  decides what the UI offers; main verifies with the backend itself
 *  (electron/ownerVerify.cjs) before any recovery install. */
export function ownerSignedIn(): boolean {
  const auth = useAuthStore.getState();
  return Boolean(auth.currentUserId) && auth.currentRole === "ADMIN" && !useSyncStore.getState().needsReauth;
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

  // RC2 (D4): while the owner is signed in and online, let main verify the
  // session with the backend, so "Install anyway" can still be checked by
  // main during a later outage (same token, within its TTL).
  let primedToken = "";
  const prime = () => {
    if (!api.verifyOwnerSession || !ownerSignedIn() || !useConnectivityStore.getState().isOnline) return;
    void currentAccessToken().then((accessToken) => {
      if (!accessToken || accessToken === primedToken) return;
      primedToken = accessToken;
      return api.verifyOwnerSession!({ accessToken }).then((r) => { if (!r?.ok) primedToken = ""; });
    }).catch(() => { primedToken = ""; });
  };
  const { data: authSub } = supabase.auth.onAuthStateChange(() => setTimeout(prime, 0));

  const unsubs = [
    useSyncStore.subscribe(send),
    useAuthStore.subscribe(prime),
    useConnectivityStore.subscribe(prime),
    () => authSub?.subscription?.unsubscribe(),
    useConnectivityStore.subscribe(send),
    useAuthStore.subscribe(send),
    useSaleActivityStore.subscribe(send),
    onQueueExported(send),
  ];
  const heartbeat = setInterval(send, HEARTBEAT_MS);
  void refreshSyncStatus();
  send();
  prime();

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
