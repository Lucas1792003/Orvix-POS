import { create } from "zustand";

/** Live-stock feed state for the UI badge (stores/data/inventoryRealtime.ts):
 *   - subscribed:   the Realtime channel is delivering AND the local rows
 *                   were refreshed from the server since the last gap;
 *   - reconnecting: either the channel is down but a server refresh has
 *                   landed since the gap began (data fresh as of then), or
 *                   the channel just (re)joined and its catch-up refresh is
 *                   still running;
 *   - stale:        the channel is down and nothing has confirmed the local
 *                   stock since — changes made elsewhere may be missing. */
export type InventorySyncState = "subscribed" | "reconnecting" | "stale";

// UI-facing view of the sync outbox. Written only by stores/data/outbox.ts
// (refreshSyncStatus / drain lifecycle) and stores/data/inventoryRealtime.ts
// — components read it to show the pending-sync badge, the live-stock badge
// and the "sign in again" banner in AppLayout. Kept dumb (state + setters)
// so outbox.ts can import it without a cycle.
export interface SyncStatusState {
  inventorySyncState: InventorySyncState;
  /** Entries still waiting to reach the server (pending / syncing / failed). */
  pendingCount: number;
  /** Entries the server rejected permanently — need a person. */
  conflictCount: number;
  /** Entries queued for ANOTHER backend (e.g. by v1.0.15 for hosted
   *  Supabase): never sent; must be exported for the owner. */
  quarantinedCount: number;
  /** Bumped when something (the desktop updater notice) asks the app to
   *  open the "Export pending" dialog. */
  exportRequestedAt: number;
  /** The server rejected this device's session (refresh token invalid or
   *  revoked). Queued work is kept; the user must sign in again. */
  needsReauth: boolean;
  isDraining: boolean;
  /** Last transient error message, for the badge tooltip. */
  lastTransientError: string | null;
  setStatus: (patch: Partial<Omit<SyncStatusState, "setStatus">>) => void;
}

export const useSyncStore = create<SyncStatusState>()((set) => ({
  inventorySyncState: "reconnecting",
  pendingCount: 0,
  conflictCount: 0,
  quarantinedCount: 0,
  exportRequestedAt: 0,
  needsReauth: false,
  isDraining: false,
  lastTransientError: null,
  setStatus: (patch) => set(patch),
}));
