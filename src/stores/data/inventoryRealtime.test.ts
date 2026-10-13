import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// Phase G · Realtime reconciliation (docs/selfhost-migration/phase-g/
// realtime-reconciliation.md). The `inventory` channel delivers nothing
// while it is down and replays nothing on rejoin (Phase E finding F7, B11);
// stores/data/inventoryRealtime.ts tracks the channel's state and re-reads
// the rows from the server after every gap, and inventorySlice's refresh
// replaces the local rows while keeping offline-queued deltas visible.
// Driven here through the fake supabase client's controllable channel.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { createInventorySlice } from "./slices/inventorySlice";
import { createSaleSlice } from "./slices/saleSlice";
import { drainOutbox, registerOutboxReconciler } from "./outbox";
import {
  inventoryRealtimeSessionForTests, inventorySyncStateOf, refreshInventoryIfNotLive, subscribeInventoryRealtime,
  syncInventoryScope, type InventoryRealtimeHandle,
} from "./inventoryRealtime";
import { useSyncStore } from "../syncStore";
import { useAppStore } from "../appStore";
import { localDb } from "../../lib/localDb";

const TEST_AUTH_ID = "auth-test-user";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStore(seed: Record<string, any> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => {
    const patch = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...patch };
  };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inventorySlice = createInventorySlice(set as any, get as any, {} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const saleSlice = createSaleSlice(set as any, get as any, {} as any);
  // Slice defaults first (they carry `inventory: []` / `movements: []`),
  // then the seeded data on top.
  state = {
    ...inventorySlice,
    ...saleSlice,
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
    products: [{ id: "p1", isNonStock: false }, { id: "p2", isNonStock: false }],
    getProductPrice: () => 0,
    shifts: [],
    sales: [],
    saleItems: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    movements: [],
    auditLogs: [],
    ...seed,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  registerOutboxReconciler("adjust_stock", (data, provisional) => get().reconcileAdjustStock(data, provisional ?? []));
  return { get, set };
}

const qty = (get: () => { inventory: { shopId: string; productId: string; qtyBaseUnits: number }[] }, productId: string, shopId = "shop-1") =>
  get().inventory.find((i) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits;

const syncState = () => useSyncStore.getState().inventorySyncState;

function connect(get: () => ReturnType<typeof makeStore>["get"] extends () => infer S ? S : never): InventoryRealtimeHandle {
  return subscribeInventoryRealtime({
    client: fake as unknown as SupabaseClient,
    onRow: (row, ts) => get().applyInventoryRealtimeUpdate(row, ts),
    onDelete: (shopId, productId, ts) => get().applyInventoryRealtimeDelete(shopId, productId, ts),
    refresh: (shopId) => get().refreshInventoryFromServer({ shopId }),
  });
}

const settle = async () => {
  const session = inventoryRealtimeSessionForTests();
  while (session?.inFlight) await session.inFlight;
};

const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can",
  qty: 1, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail",
  ...over,
});
const saleInput = {
  shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1",
  cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000,
};

let handle: InventoryRealtimeHandle | null = null;

beforeEach(async () => {
  fake.reset();
  fake.server.inventory.set("shop-1:p1", 10);
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.inventory.put({ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 });
  await localDb.authCache.put({
    authId: TEST_AUTH_ID, userId: "user-1", role: "CASHIER", shopId: "shop-1",
    isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
  });
  useAppStore.setState({ currentShopId: null });
  useSyncStore.setState({ inventorySyncState: "reconnecting" });
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  handle?.stop();
  handle = null;
  vi.unstubAllGlobals();
});

describe("inventorySyncStateOf", () => {
  it("maps the channel/freshness pair to the badge state", () => {
    expect(inventorySyncStateOf(true, true, true)).toBe("subscribed");
    expect(inventorySyncStateOf(true, false, true)).toBe("reconnecting");
    expect(inventorySyncStateOf(false, true, true)).toBe("reconnecting");
    expect(inventorySyncStateOf(false, false, true)).toBe("stale");
    // before the first join nothing can have been missed yet
    expect(inventorySyncStateOf(false, false, false)).toBe("reconnecting");
  });
});

describe("Realtime gap reconciliation", () => {
  it("re-reads the shop's stock from the server on the first join and after every gap (missed update recovered)", async () => {
    const { get } = makeStore();
    handle = connect(get);
    const ch = fake.realtime.current();
    expect(syncState()).toBe("reconnecting");

    // A change that happened between the full load and the join being acked.
    fake.server.inventory.set("shop-1:p1", 11);
    ch.emitStatus("SUBSCRIBED");
    await settle();
    expect(syncState()).toBe("subscribed");
    expect(qty(get, "p1")).toBe(11);

    // Gap: the socket dropped. Nothing arrives for what changes meanwhile.
    ch.emitStatus("CHANNEL_ERROR", new Error("socket closed"));
    expect(syncState()).toBe("stale");
    fake.server.inventory.set("shop-1:p1", 13);
    expect(qty(get, "p1")).toBe(11);

    // realtime-js rejoins: the server value is pulled, no event needed.
    ch.emitStatus("SUBSCRIBED");
    await settle();
    expect(syncState()).toBe("subscribed");
    expect(qty(get, "p1")).toBe(13);
    expect((await localDb.inventory.get(["shop-1", "p1"]))?.qtyBaseUnits).toBe(13);
    // one select per join
    expect(fake.selectCalls).toBe(2);
    // and no write RPC was ever sent by a refresh
    expect(fake.calls.filter((c) => c.name !== "resolve_event_time")).toHaveLength(0);
  });

  it("reconciles concurrent updates from two terminals to the server value, by commit order, whatever the delivery order or client clock", async () => {
    const { get } = makeStore();
    // The client's clock is 10 minutes AHEAD of the server's — ordering must
    // use server time only.
    fake.setServerClockOffset(-10 * 60_000);
    handle = connect(get);
    const ch = fake.realtime.current();
    ch.emitStatus("SUBSCRIBED");
    await settle();
    expect(qty(get, "p1")).toBe(10);
    const t0 = Date.parse(fake.serverNow());

    // Terminal A sold one (commit +2 s, qty 8 — it also saw B's sale),
    // terminal B sold one (commit +1 s, qty 9). B's event is delivered late.
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 8, commitTimestamp: new Date(t0 + 2000).toISOString() });
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9, commitTimestamp: new Date(t0 + 1000).toISOString() });
    expect(qty(get, "p1")).toBe(8);

    // An event that pre-dates the join's authoritative refresh is a stale
    // delivery and must not roll the row back either.
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 7, commitTimestamp: new Date(t0 - 5000).toISOString() });
    expect(qty(get, "p1")).toBe(8);

    // The server agrees; a later refresh keeps it.
    fake.server.inventory.set("shop-1:p1", 8);
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, "p1")).toBe(8);

    // A genuinely newer event after the refresh is applied.
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 6, commitTimestamp: new Date(Date.parse(fake.serverNow()) + 1000).toISOString() });
    expect(qty(get, "p1")).toBe(6);
  });

  it("clears the stale state through the periodic refresh while the channel stays down, and bounds it when the refresh fails", async () => {
    const { get } = makeStore();
    handle = connect(get);
    const ch = fake.realtime.current();
    ch.emitStatus("SUBSCRIBED");
    await settle();

    ch.emitStatus("CLOSED");
    expect(syncState()).toBe("stale");
    fake.server.inventory.set("shop-1:p1", 15);

    // The periodic delta pull (pullDeltas → refreshInventoryIfNotLive).
    await refreshInventoryIfNotLive();
    expect(qty(get, "p1")).toBe(15);
    expect(syncState()).toBe("reconnecting"); // fresh as of now, feed still down

    // Another failed rejoin: freshness cannot be assumed any more.
    ch.emitStatus("CHANNEL_ERROR");
    expect(syncState()).toBe("stale");

    // Server unreachable for the pull: nothing changes, still stale.
    fake.server.inventory.set("shop-1:p1", 16);
    fake.setSelectMode("network-error");
    await refreshInventoryIfNotLive();
    expect(qty(get, "p1")).toBe(15);
    expect(syncState()).toBe("stale");

    // Back: the next pull catches up, then the rejoin confirms.
    fake.setSelectMode("succeed");
    await refreshInventoryIfNotLive();
    expect(qty(get, "p1")).toBe(16);
    expect(syncState()).toBe("reconnecting");
    ch.emitStatus("SUBSCRIBED");
    await settle();
    expect(syncState()).toBe("subscribed");
    // live and fresh: the periodic path is a no-op (no extra select)
    const selects = fake.selectCalls;
    await refreshInventoryIfNotLive();
    expect(fake.selectCalls).toBe(selects);
  });

  it("keeps a pending offline sale visible across a refresh, and the sale drains exactly once with no duplicate writes", async () => {
    const { get } = makeStore();
    fake.server.inventory.set("shop-1:p2", 5);
    get().inventory.push({ shopId: "shop-1", productId: "p2", qtyBaseUnits: 5 });

    // Offline sale: 1 x p1 → provisional stock 9, queued for replay.
    vi.stubGlobal("navigator", { onLine: false });
    await get().createSale({ ...saleInput, cartItems: [cartItem()] });
    expect(qty(get, "p1")).toBe(9);
    expect(await localDb.syncOutbox.count()).toBe(1);

    // Back online; the channel joins and the authoritative refresh runs.
    // The server still says 10 (the sale has not been replayed yet) — the
    // provisional deduction must survive the replace.
    vi.stubGlobal("navigator", { onLine: true });
    handle = connect(get);
    const ch = fake.realtime.current();
    ch.emitStatus("SUBSCRIBED");
    await settle();
    expect(syncState()).toBe("subscribed");
    expect(fake.server.inventory.get("shop-1:p1")).toBe(10);
    expect(qty(get, "p1")).toBe(9);
    expect(qty(get, "p2")).toBe(5);

    // Drain: exactly one complete_sale reaches the server.
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.executions.complete_sale).toBe(1);
    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(9);
    expect(qty(get, "p1")).toBe(9);
    expect(await localDb.syncOutbox.count()).toBe(0);

    // The server's own Realtime event for that commit, and a later refresh:
    // neither double-applies the deduction.
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1" });
    expect(qty(get, "p1")).toBe(9);
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, "p1")).toBe(9);
    expect(get().movements.filter((m: { pendingSync?: boolean }) => m.pendingSync)).toHaveLength(0);
    // still exactly one write RPC over the whole scenario
    expect(fake.calls.filter((c) => c.name !== "resolve_event_time")).toHaveLength(1);
  });

  it("re-applies a pending adjustment on top of the server rows and never counts an entry that is being sent", async () => {
    const { get } = makeStore();
    vi.stubGlobal("navigator", { onLine: false });
    await get().adjustStock({ shopId: "shop-1", productId: "p1", type: "ADJUSTMENT", qtyChange: -3, reason: "Recount", actorId: "user-1" });
    expect(qty(get, "p1")).toBe(7);
    vi.stubGlobal("navigator", { onLine: true });

    fake.server.inventory.set("shop-1:p1", 12); // someone else restocked meanwhile
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, "p1")).toBe(9); // 12 - 3 pending

    // An entry mid-flight (status "syncing") is not re-applied: its effect
    // may already be on the server and the reply reconciles it in ms.
    const [entry] = await localDb.syncOutbox.toArray();
    await localDb.syncOutbox.update(entry.localId, { status: "syncing" });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, "p1")).toBe(12);
    await localDb.syncOutbox.update(entry.localId, { status: "pending" });

    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.executions.adjust_stock).toBe(1);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(9);
    expect(qty(get, "p1")).toBe(9);
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, "p1")).toBe(9);
  });

  it("replaces the scope rather than merging: rows the server no longer has go away, other shops are untouched", async () => {
    const { get } = makeStore({
      inventory: [
        { shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 },
        { shopId: "shop-1", productId: "p-deleted", qtyBaseUnits: 4 },
        { shopId: "shop-2", productId: "p1", qtyBaseUnits: 99 },
      ],
    });
    await localDb.inventory.put({ shopId: "shop-1", productId: "p-deleted", qtyBaseUnits: 4 });
    await localDb.inventory.put({ shopId: "shop-2", productId: "p1", qtyBaseUnits: 99 });
    fake.server.inventory.set("shop-2:p1", 50);

    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, "p-deleted")).toBeUndefined();
    expect(qty(get, "p1", "shop-2")).toBe(99); // not in scope: untouched
    expect(await localDb.inventory.get(["shop-1", "p-deleted"])).toBeUndefined();
    expect((await localDb.inventory.get(["shop-2", "p1"]))?.qtyBaseUnits).toBe(99);

    // null scope = every readable row (ADMIN, no shop selected)
    expect(await get().refreshInventoryFromServer({ shopId: null })).toBe(true);
    expect(qty(get, "p1", "shop-2")).toBe(50);
  });

  it("refreshes a newly selected shop after a gap (ADMIN shop switch)", async () => {
    const { get } = makeStore({
      inventory: [
        { shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 },
        { shopId: "shop-2", productId: "p1", qtyBaseUnits: 50 },
      ],
    });
    fake.server.inventory.set("shop-2:p1", 50);
    useAppStore.setState({ currentShopId: "shop-1" });
    handle = connect(get);
    const ch = fake.realtime.current();
    ch.emitStatus("SUBSCRIBED");
    await settle();
    expect(syncState()).toBe("subscribed");

    ch.emitStatus("CHANNEL_ERROR");
    fake.server.inventory.set("shop-2:p1", 40);
    ch.emitStatus("SUBSCRIBED");
    await settle();
    expect(syncState()).toBe("subscribed");
    expect(qty(get, "p1", "shop-2")).toBe(50); // shop-2 was not in scope

    useAppStore.setState({ currentShopId: "shop-2" });
    syncInventoryScope();
    expect(syncState()).toBe("reconnecting"); // this scope not confirmed since the gap
    await settle();
    expect(syncState()).toBe("subscribed");
    expect(qty(get, "p1", "shop-2")).toBe(40);
  });

  it("applies steady-state INSERT/DELETE events and stops cleanly", async () => {
    const { get } = makeStore();
    handle = connect(get);
    const ch = fake.realtime.current();
    ch.emitStatus("SUBSCRIBED");
    await settle();

    ch.emitChange({ eventType: "INSERT", shopId: "shop-1", productId: "p-new", qty: 3 });
    expect(qty(get, "p-new")).toBe(3);
    ch.emitChange({ eventType: "DELETE", shopId: "shop-1", productId: "p-new" });
    expect(qty(get, "p-new")).toBeUndefined();

    handle.stop();
    handle = null;
    expect(ch.removed).toBe(true);
    expect(syncState()).toBe("stale");
    // a late callback from the removed channel is ignored
    ch.subscribeCalls = 0;
  });

  it("does nothing while offline (the reconnect path runs a full load instead)", async () => {
    const { get } = makeStore();
    vi.stubGlobal("navigator", { onLine: false });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(false);
    expect(fake.selectCalls).toBe(0);
  });
});
