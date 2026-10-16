import { useEffect, useRef, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { SmallScreenGuard } from "./SmallScreenGuard";
import { Button } from "../../components/ui/Button";
import { useDataStore } from "../../stores/dataStore";
import { useConnectivityStore } from "../../stores/connectivityStore";
import { useSyncStore } from "../../stores/syncStore";
import { useAuthStore } from "../../stores/authStore";
import { useAppStore } from "../../stores/appStore";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { supabase } from "../../lib/supabase";
import { clearNeedsReauth, countPendingOutbox, drainOutbox, refreshSyncStatus } from "../../stores/data/outbox";
import { subscribeInventoryRealtime, syncInventoryScope } from "../../stores/data/inventoryRealtime";
import { ExportQueueDialog } from "../../components/sync/ExportQueueDialog";
import { useTranslation } from "../../hooks/useTranslation";

const MIN_SUPPORTED_WIDTH = 768;

// The live-stock badge only appears once the feed has been away for this
// long: the catch-up refresh after every (re)join takes well under a second
// and must not flash a warning on each load.
const INVENTORY_BADGE_DELAY_MS = 1_500;

export const AppLayout = () => {
  const isLoaded = useDataStore((state) => state.isLoaded);
  const isLoading = useDataStore((state) => state.isLoading);
  const loadError = useDataStore((state) => state.loadError);
  const loadData = useDataStore((state) => state.loadData);
  const retryLoadData = useDataStore((state) => state.retryLoadData);
  const pullDeltas = useDataStore((state) => state.pullDeltas);
  const applyInventoryRealtimeUpdate = useDataStore((state) => state.applyInventoryRealtimeUpdate);
  const applyInventoryRealtimeDelete = useDataStore((state) => state.applyInventoryRealtimeDelete);
  const refreshInventoryFromServer = useDataStore((state) => state.refreshInventoryFromServer);
  const isOnline = useConnectivityStore((state) => state.isOnline);
  const pendingCount = useSyncStore((state) => state.pendingCount);
  const conflictCount = useSyncStore((state) => state.conflictCount);
  const quarantinedCount = useSyncStore((state) => state.quarantinedCount);
  const needsReauth = useSyncStore((state) => state.needsReauth);
  const isDraining = useSyncStore((state) => state.isDraining);
  const inventorySyncState = useSyncStore((state) => state.inventorySyncState);
  const logout = useAuthStore((state) => state.logout);
  const setShopId = useAppStore((state) => state.setShopId);
  const currentShopId = useAppStore((state) => state.currentShopId);
  const navigate = useNavigate();
  const viewportWidth = useViewportWidth();
  const [showInventoryBadge, setShowInventoryBadge] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const { t } = useTranslation();

  // The desktop update notice's "Export pending" button (updateGuardBridge).
  // Only requests made while this screen is mounted open the dialog.
  useEffect(() => useSyncStore.subscribe((state, prev) => {
    if (state.exportRequestedAt > prev.exportRequestedAt) setExportOpen(true);
  }), []);

  useEffect(() => {
    if (!isLoaded && !isLoading && !loadError) {
      void loadData();
    }
  }, [isLoaded, isLoading, loadError, loadData]);

  // loadData() bails out immediately while offline (see stores/data/index.ts)
  // rather than firing requests doomed to fail, so nothing else re-triggers
  // it once connectivity returns — do that here. The full reload drains the
  // outbox once it has proved the server reachable.
  const wasOnlineRef = useRef(isOnline);
  useEffect(() => {
    if (isOnline && !wasOnlineRef.current) {
      void loadData({ force: true });
    }
    wasOnlineRef.current = isOnline;
  }, [isOnline, loadData]);

  // Keep the cached data fresh: re-sync when the tab regains focus/visibility
  // and on a slow interval while open. The client store is loaded once, so
  // without this a returning user would see stale debt/transfers/etc. that
  // another device changed. Throttled so rapid focus changes don't hammer the
  // backend. Uses pullDeltas() (cursor-based, only tables that support it —
  // see stores/data/deltaSync.ts) rather than a full loadData({force:true}):
  // this fires often (every 30-120s), so keeping it cheap matters. It does
  // NOT catch a hard-deleted product (delta pull can't see a row that no
  // longer exists) — that's still caught by the full reload on reconnect
  // (below) or the next cold boot. It also does NOT cover stock levels —
  // `inventory` has no `updated_at` so it's outside delta-sync entirely —
  // see the Realtime subscription effect right below for how that's kept
  // fresh instead. A successful pull also drains the outbox when anything
  // is queued (see pullDeltas in stores/data/index.ts).
  const lastRefreshRef = useRef(0);
  useEffect(() => {
    const THROTTLE_MS = 30_000;
    const INTERVAL_MS = 120_000;
    // Seed on mount so a focus right after the initial load doesn't double-fetch.
    lastRefreshRef.current = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (!useDataStore.getState().isLoaded) return;
      const now = Date.now();
      if (now - lastRefreshRef.current < THROTTLE_MS) return;
      lastRefreshRef.current = now;
      void pullDeltas();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(refresh, INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [pullDeltas]);

  // Outbox drain triggers beyond the full load (stores/data/index.ts):
  //  - every 30 s while anything is queued (a sale queued because one
  //    request timed out while navigator.onLine stayed true must not wait
  //    for a restart or the next delta pull);
  //  - after a successful sign-in or token refresh — the session is known
  //    good at that moment, and a queue parked on "needs sign-in" resumes.
  // Both are no-ops while a pass is already running or another window
  // holds the drain lock (see drainOutbox).
  useEffect(() => {
    const DRAIN_INTERVAL_MS = 30_000;
    void refreshSyncStatus();
    const tick = async () => {
      if (!useConnectivityStore.getState().isOnline) return;
      if (useSyncStore.getState().needsReauth) return;
      if ((await countPendingOutbox()) > 0) {
        drainOutbox().catch((err) => console.error("[DB] Failed to drain the sync outbox:", err));
      } else {
        void refreshSyncStatus();
      }
    };
    const interval = window.setInterval(() => void tick(), DRAIN_INTERVAL_MS);
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "TOKEN_REFRESHED") return;
      void clearNeedsReauth().then(() => drainOutbox()).catch((err) => {
        console.error("[DB] Failed to drain the sync outbox after auth change:", err);
      });
    });
    return () => {
      window.clearInterval(interval);
      authListener.subscription.unsubscribe();
    };
  }, []);

  // Live stock updates (migration 058 adds `inventory` to the Realtime
  // publication). `inventory` has no `updated_at`, so it's the one thing
  // pullDeltas() above can never catch — without this, two registers in
  // the same shop could show different stock for an unbounded window
  // (until the next full reload), not just the 30-120s the comment above
  // covers for everything else. RLS still applies: a subscriber only ever
  // receives rows `inventory_sel` (migration 015) already lets them SELECT.
  //
  // Phase G: the subscription lives in stores/data/inventoryRealtime.ts,
  // which also re-reads the shop's rows from the server after every gap
  // (socket drop, refused rejoin, this effect re-running after an offline
  // spell) — a Realtime channel replays nothing it missed on its own.
  useEffect(() => {
    if (!isLoaded || !isOnline) return;
    const handle = subscribeInventoryRealtime({
      client: supabase,
      onRow: applyInventoryRealtimeUpdate,
      onDelete: applyInventoryRealtimeDelete,
      refresh: (shopId) => refreshInventoryFromServer({ shopId }),
    });
    return () => handle.stop();
  }, [isLoaded, isOnline, applyInventoryRealtimeUpdate, applyInventoryRealtimeDelete, refreshInventoryFromServer]);

  // An ADMIN switching shops after a gap needs the new shop's rows confirmed too.
  useEffect(() => {
    syncInventoryScope();
  }, [currentShopId]);

  // Debounce the live-stock badge (see INVENTORY_BADGE_DELAY_MS): shown
  // only after the feed has been away for a moment, hidden on the next tick.
  useEffect(() => {
    const show = isOnline && inventorySyncState !== "subscribed";
    const timer = window.setTimeout(() => setShowInventoryBadge(show), show ? INVENTORY_BADGE_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [isOnline, inventorySyncState]);

  // The server rejected this device's session (refresh token invalid or
  // revoked). supabase-js has already dropped it; the queue is kept and
  // resumes after the next sign-in. Same steps as the sidebar's logout.
  const handleSignInAgain = async () => {
    await logout();
    setShopId(null);
    navigate("/login");
  };

  if (viewportWidth < MIN_SUPPORTED_WIDTH) {
    return <SmallScreenGuard />;
  }

  // Error must be checked before isLoaded so a failed initial load shows an
  // actionable Retry instead of perpetual "Loading data…".
  if (loadError && !isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center px-4">
        <div className="max-w-md text-center">
          <div className="mb-2 text-base font-semibold text-slate-800">Couldn't load your data</div>
          <p className="mb-4 text-sm text-slate-500">{loadError}</p>
          <Button onClick={() => void retryLoadData()} disabled={isLoading}>
            {isLoading ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="text-slate-500 text-sm">Loading data…</div>
        </div>
      </div>
    );
  }

  const queuedLabel =
    pendingCount > 0
      ? `${pendingCount} ${pendingCount === 1 ? "action" : "actions"} waiting to sync`
      : null;

  return (
    <div className="buyer-container">
      <Sidebar />
      <main className="main">
        {needsReauth && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 print-hidden"
          >
            <span>
              Your sign-in has expired on the server. Sales and other actions recorded on this device are saved
              {pendingCount > 0 ? ` (${pendingCount} waiting)` : ""} and will sync after you sign in again.
            </span>
            <Button size="sm" onClick={() => void handleSignInAgain()}>Sign in again</Button>
          </div>
        )}
        {quarantinedCount > 0 && (
          <div
            role="alert"
            data-testid="quarantine-banner"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900 print-hidden"
          >
            <span>
              {quarantinedCount} {quarantinedCount === 1 ? "transaction was" : "transactions were"} recorded on this till by an
              older app version for a different server. {quarantinedCount === 1 ? "It" : "They"} will NOT be sent from here.
              Export {quarantinedCount === 1 ? "it" : "them"} and give the file to the owner; nothing has been deleted.
            </span>
            <Button size="sm" onClick={() => setExportOpen(true)} data-testid="quarantine-export">
              {t("queueExport", "button")}
            </Button>
          </div>
        )}
        <div className="app-content">
          <Outlet />
        </div>
      </main>
      <div className="fixed bottom-3 right-3 z-50 flex flex-col items-end gap-2 print-hidden">
        {queuedLabel && (
          <div
            className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800 shadow-lg border border-amber-200"
            title={isOnline ? "Retrying automatically." : "Will sync when the connection returns."}
          >
            {isDraining ? "Syncing — " : ""}{queuedLabel}
          </div>
        )}
        {(pendingCount > 0 || conflictCount > 0 || quarantinedCount > 0) && (
          // Outage recovery: any signed-in role can save an encrypted copy of
          // the queue, offline too (docs/selfhost-migration/phase-f/queue-export.md).
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            data-testid="export-queue-open"
            className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-lg hover:bg-slate-50"
            title={t("queueExport", "buttonLong")}
          >
            <span className="material-symbols-rounded text-sm leading-none">download</span>
            {t("queueExport", "button")}
          </button>
        )}
        {conflictCount > 0 && (
          <div className="rounded-full bg-rose-100 px-3 py-1 text-xs text-rose-800 shadow-lg border border-rose-200">
            {conflictCount} sync {conflictCount === 1 ? "conflict needs" : "conflicts need"} attention
          </div>
        )}
        {!isOnline && (
          <div className="rounded-full bg-slate-800 px-3 py-1 text-xs text-white shadow-lg">
            Offline — showing cached data
          </div>
        )}
        {showInventoryBadge && inventorySyncState === "stale" && (
          <div
            className="rounded-full bg-rose-100 px-3 py-1 text-xs text-rose-800 shadow-lg border border-rose-200"
            data-testid="inventory-sync-badge"
            data-state="stale"
            title="The live stock feed is down and the stock shown has not been confirmed with the server since. It is re-read from the server every couple of minutes and as soon as the feed returns."
          >
            Live stock paused — stock may be out of date
          </div>
        )}
        {showInventoryBadge && inventorySyncState === "reconnecting" && (
          <div
            className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800 shadow-lg border border-amber-200"
            data-testid="inventory-sync-badge"
            data-state="reconnecting"
            title="Stock was re-read from the server; the live feed is still reconnecting."
          >
            Reconnecting live stock…
          </div>
        )}
        {isOnline && isLoading && (
          <div className="rounded-full bg-white px-3 py-1 text-xs text-slate-500 shadow-lg border border-slate-200">
            Syncing…
          </div>
        )}
      </div>
      <ExportQueueDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
};
