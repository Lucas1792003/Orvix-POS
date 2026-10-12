import type { RealtimePostgresChangesPayload, SupabaseClient } from "@supabase/supabase-js";
import type { Inventory } from "../../types";
import { mapInventory } from "./mappers";
import { useAppStore } from "../appStore";
import { useSyncStore, type InventorySyncState } from "../syncStore";

// ----------------------------------------------------------------------
// Live stock feed with server-authoritative reconciliation (Phase G).
//
// Migration 058 publishes `inventory` on Realtime, and `inventory` has no
// `updated_at`, so the channel is the ONLY thing that keeps stock fresh
// between full reloads (deltaSync.ts cannot see it). A Realtime channel
// delivers nothing for the time it is down — a socket drop, a refused
// rejoin, a JWT that could not be refreshed — and realtime-js's own
// reconnect brings the channel back WITHOUT replaying what was missed
// (Phase E finding F7, B11). This module:
//
//   * tracks the channel's state through the subscribe() callback
//     (SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED);
//   * on every SUBSCRIBED — the first join included, since rows may have
//     changed between the full load's SELECT and the join being acked —
//     runs refreshInventoryFromServer() for the current scope, which
//     REPLACES the local rows with the server's (re-applying the deltas of
//     anything still queued offline, see pendingStock.ts);
//   * while the channel is down, lets the periodic delta pull refresh the
//     rows instead (refreshInventoryIfNotLive), so the data is bounded by
//     the pull interval rather than "until the next event for that row";
//   * publishes a three-state summary for the UI badge (syncStore).
//
// Freshness is tracked per scope (one shop, or "all"): an ADMIN switching
// shops after a gap gets the new shop refreshed too (syncInventoryScope).
//
// Steady-state events still go through applyInventoryRealtimeUpdate, which
// drops an event older than the server time of the last refresh for that
// row (the events carry commit_timestamp; the refresh takes now() from the
// server first), so a late delivery cannot roll a refreshed row back.
// ----------------------------------------------------------------------

export type InventoryChannelStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";

type InventoryRow = Record<string, unknown>;

export interface InventoryRealtimeOptions {
  client: Pick<SupabaseClient, "channel" | "removeChannel">;
  onRow: (row: Inventory, commitTimestamp: string | undefined) => void;
  onDelete: (shopId: string, productId: string, commitTimestamp: string | undefined) => void;
  /** Server-authoritative refresh for `shopId` (null = every readable row).
   *  Resolves true on success. */
  refresh: (shopId: string | null) => Promise<boolean>;
  channelName?: string;
}

export interface InventoryRealtimeHandle {
  stop: () => void;
}

interface Session {
  live: boolean;
  /** Scopes refreshed from the server since the last gap began. */
  freshScopes: Set<string>;
  /** Bumped on every non-SUBSCRIBED status; a refresh that started before
   *  the bump must not mark its scope fresh. */
  gapGeneration: number;
  inFlight: Promise<boolean> | null;
  stopped: boolean;
  refresh: (shopId: string | null) => Promise<boolean>;
}

const ALL_SCOPE = "*";
const scopeKey = (shopId: string | null): string => shopId ?? ALL_SCOPE;
const currentShopId = (): string | null => useAppStore.getState().currentShopId;

let active: Session | null = null;

/** `hadGap`: a non-SUBSCRIBED status has been seen. Before the very first
 *  join completes nothing can have been missed yet (the full load just
 *  ran), so that window reads as "reconnecting", not "stale". */
export function inventorySyncStateOf(live: boolean, fresh: boolean, hadGap: boolean): InventorySyncState {
  if (live && fresh) return "subscribed";
  if (!live && !fresh && hadGap) return "stale";
  return "reconnecting";
}

function publish(session: Session): void {
  const state = inventorySyncStateOf(
    session.live, session.freshScopes.has(scopeKey(currentShopId())), session.gapGeneration > 0,
  );
  if (useSyncStore.getState().inventorySyncState !== state) useSyncStore.getState().setStatus({ inventorySyncState: state });
}

function runRefresh(session: Session): Promise<boolean> {
  if (session.inFlight) return session.inFlight;
  const generation = session.gapGeneration;
  const shopId = currentShopId();
  session.inFlight = (async () => {
    let ok = false;
    try {
      ok = await session.refresh(shopId);
    } catch (err) {
      console.error("[DB] Inventory refresh after a Realtime gap failed:", err);
    }
    session.inFlight = null;
    if (session.stopped) return ok;
    if (ok && generation === session.gapGeneration) session.freshScopes.add(scopeKey(shopId));
    publish(session);
    // The scope may have changed while the refresh ran (shop switch): the
    // new scope is not fresh yet.
    if (ok && scopeKey(currentShopId()) !== scopeKey(shopId) && !session.freshScopes.has(scopeKey(currentShopId()))) {
      void runRefresh(session);
    }
    return ok;
  })();
  return session.inFlight;
}

/** Exported for tests: drive the state machine without a channel. */
export function handleInventoryChannelStatus(session: Session, status: string): void {
  if (session.stopped) return;
  if (status === "SUBSCRIBED") {
    session.live = true;
    publish(session);
    void runRefresh(session);
    return;
  }
  // CHANNEL_ERROR / TIMED_OUT / CLOSED — anything committed from now until
  // the next SUBSCRIBED may be missed.
  session.live = false;
  session.freshScopes.clear();
  session.gapGeneration += 1;
  publish(session);
}

/**
 * Open the `inventory` postgres_changes channel and keep local stock
 * reconciled across gaps. Returns a handle whose stop() removes the channel
 * (AppLayout calls it on unmount, logout and when going offline).
 */
export function subscribeInventoryRealtime(options: InventoryRealtimeOptions): InventoryRealtimeHandle {
  const session: Session = {
    live: false, freshScopes: new Set(), gapGeneration: 0, inFlight: null, stopped: false, refresh: options.refresh,
  };
  if (active) active.stopped = true;
  active = session;
  publish(session);

  const channel = options.client
    .channel(options.channelName ?? "inventory-live")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "inventory" },
      (payload: RealtimePostgresChangesPayload<InventoryRow>) => {
        if (session.stopped) return;
        const commitTimestamp = typeof payload.commit_timestamp === "string" ? payload.commit_timestamp : undefined;
        if (payload.eventType === "DELETE") {
          const old = payload.old as InventoryRow | undefined;
          if (old && typeof old.shop_id === "string" && typeof old.product_id === "string") {
            options.onDelete(old.shop_id, old.product_id, commitTimestamp);
          }
          return;
        }
        const row = payload.new as InventoryRow | undefined;
        if (!row || typeof row.shop_id !== "string" || typeof row.product_id !== "string") return;
        options.onRow(mapInventory(row), commitTimestamp);
      },
    )
    .subscribe((status) => handleInventoryChannelStatus(session, String(status)));

  return {
    stop: () => {
      if (session.stopped) return;
      session.stopped = true;
      if (active === session) {
        active = null;
        // No feed any more: whatever is shown may go stale from here on.
        const state: InventorySyncState = "stale";
        if (useSyncStore.getState().inventorySyncState !== state) useSyncStore.getState().setStatus({ inventorySyncState: state });
      }
      void options.client.removeChannel(channel);
    },
  };
}

/**
 * Periodic path (called from pullDeltas): while the channel is not
 * delivering — or the current scope has not been refreshed since the last
 * gap — pull the authoritative rows now, so stale stock is bounded by the
 * pull interval even if the socket never comes back. No-op when live and
 * fresh, or when no subscription exists (offline / not loaded).
 */
export async function refreshInventoryIfNotLive(): Promise<void> {
  const session = active;
  if (!session) return;
  if (session.live && session.freshScopes.has(scopeKey(currentShopId()))) return;
  await runRefresh(session);
}

/** The current shop changed: re-publish the badge for the new scope and
 *  refresh it if it has not been confirmed since the last gap. */
export function syncInventoryScope(): void {
  const session = active;
  if (!session) return;
  publish(session);
  if (!session.freshScopes.has(scopeKey(currentShopId()))) void runRefresh(session);
}

/** Tests only: the live session's internals. */
export function inventoryRealtimeSessionForTests(): Session | null {
  return active;
}
