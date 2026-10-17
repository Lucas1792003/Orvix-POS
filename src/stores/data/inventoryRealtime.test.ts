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
    // one complete read per join; a paged read (ORV-001) is the data page
    // plus the empty page that proves it is complete: 2 joins × 2 requests
    expect(fake.selectCalls).toBe(4);
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

    // A genuinely newer event after the refresh is applied. "Newer" means
    // newer than everything already applied (A's sale committed at t0+2 s):
    // the refresh no longer LOWERS a row's watermark to its own server time
    // (Batch 1-code, G-5), so an event between the refresh and A's commit
    // would be a reordered stale delivery, not a newer state.
    const newer = Math.max(Date.parse(fake.serverNow()), t0 + 2000) + 1000;
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 6, commitTimestamp: new Date(newer).toISOString() });
    expect(qty(get, "p1")).toBe(6);
  });

  it("a refresh never lowers a row's watermark below an event it already applied (reordered delivery cannot roll the row back)", async () => {
    const { get } = makeStore();
    handle = connect(get);
    const ch = fake.realtime.current();
    ch.emitStatus("SUBSCRIBED");
    await settle();
    const t0 = Date.parse(fake.serverNow());
    // Committed after the refresh below reads the server clock.
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 4, commitTimestamp: new Date(t0 + 5000).toISOString() });
    fake.server.inventory.set("shop-1:p1", 4);
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    // An older change (t0+3 s) delivered late must not overwrite qty 4.
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9, commitTimestamp: new Date(t0 + 3000).toISOString() });
    expect(qty(get, "p1")).toBe(4);
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

// ---------------------------------------------------------------------------
// Batch 1-code (ORV-001, G-5): the refresh reads every page past the
// 1,000-row cap, keeps live updates that arrive between its pages, and a
// failed page changes nothing.
// ---------------------------------------------------------------------------
describe("paged inventory refresh", () => {
  const pid = (i: number) => `p-${String(i).padStart(5, "0")}`;
  const seedServer = (n: number, qtyOf = (i: number) => i) => {
    fake.server.inventory.clear();
    for (let i = 0; i < n; i += 1) fake.server.inventory.set(`shop-1:${pid(i)}`, qtyOf(i));
  };

  it("reads all 2,500 rows of a shop (3 pages + end), mirrors them and drops rows the server no longer has", async () => {
    seedServer(2500);
    const { get } = makeStore();
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(get().inventory.filter((r: { shopId: string }) => r.shopId === "shop-1")).toHaveLength(2500);
    expect(qty(get, pid(2499))).toBe(2499);
    expect(qty(get, "p1")).toBeUndefined(); // the seeded local row is gone server-side
    expect(await localDb.inventory.where("shopId").equals("shop-1").count()).toBe(2500);
    expect(fake.selectCalls).toBe(4);
  });

  it("a live update that commits between two pages is kept, not rolled back by the older page", async () => {
    seedServer(1500, () => 10);
    const { get } = makeStore();
    handle = connect(get);
    const ch = fake.realtime.current();
    // Page 1 (rows p-00000..p-00999) has been read when, before page 2, a
    // sale elsewhere moves p-00005 to 3 and its event arrives.
    fake.setSelectHook((request) => {
      if (request !== 1) return;
      fake.server.inventory.set(`shop-1:${pid(5)}`, 3);
      ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: pid(5), qty: 3 });
    });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, pid(5))).toBe(3);
    expect((await localDb.inventory.get(["shop-1", pid(5)]))?.qtyBaseUnits).toBe(3);
    expect(qty(get, pid(6))).toBe(10);
  });

  it("a live DELETE between pages removes the row even though page 1 still had it", async () => {
    seedServer(1500, () => 10);
    const { get } = makeStore();
    handle = connect(get);
    const ch = fake.realtime.current();
    fake.setSelectHook((request) => {
      if (request !== 1) return;
      fake.server.inventory.delete(`shop-1:${pid(7)}`);
      ch.emitChange({ eventType: "DELETE", shopId: "shop-1", productId: pid(7) });
    });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, pid(7))).toBeUndefined();
    expect(get().inventory.filter((r: { shopId: string }) => r.shopId === "shop-1")).toHaveLength(1499);
  });

  it("a page that fails mid-read changes nothing: rows, mirror and the pending-delta view stay as they were", async () => {
    seedServer(1500, () => 50);
    const { get } = makeStore();
    fake.setSelectHook((request) => { if (request === 1) fake.setSelectMode("network-error"); });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(false);
    expect(get().inventory).toEqual([{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }]);
    expect(await localDb.inventory.toArray()).toEqual([{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }]);
  });

  it("a queued offline sale's delta is applied to a row that a live event replaced during the read", async () => {
    seedServer(1200, () => 10);
    fake.server.inventory.set("shop-1:p1", 10);
    const { get } = makeStore({ shifts: [{ id: "shift-1", shopId: "shop-1", cashierId: "user-1", openingCashMmk: 0, startedAt: "t0" }] });
    handle = connect(get);
    const ch = fake.realtime.current();
    vi.stubGlobal("navigator", { onLine: false });
    await get().createSale({ ...saleInput, cartItems: [cartItem({ qty: 2 })] }); // queued: p1 −2 locally
    vi.stubGlobal("navigator", { onLine: true });
    fake.setSelectHook((request) => {
      if (request !== 1) return;
      fake.server.inventory.set("shop-1:p1", 9); // another till sold one
      ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9 });
    });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, "p1")).toBe(7); // server 9 − the 2 still queued
  });
});

// ---------------------------------------------------------------------------
// H2 (ORV-021): a live server row must not "un-sell" a sale still queued on
// this till, must never subtract a sale twice, and older async work must
// never overwrite a newer event. The queue itself is never touched.
// ---------------------------------------------------------------------------
describe("H2: live stock events while offline stock changes are queued", () => {
  const mirrored = async (productId: string) => (await localDb.inventory.get(["shop-1", productId]))?.qtyBaseUnits;
  const queueOfflineSale = async (get: () => { createSale: (i: unknown) => Promise<string> }, qty: number) => {
    vi.stubGlobal("navigator", { onLine: false });
    await get().createSale({ ...saleInput, cartItems: [cartItem({ qty })] });
    vi.stubGlobal("navigator", { onLine: true });
  };
  const live = async (get: ReturnType<typeof makeStore>["get"]) => {
    handle = connect(get);
    const ch = fake.realtime.current();
    ch.emitStatus("SUBSCRIBED");
    await settle();
    return ch;
  };

  it("a real server stock change during an outstanding offline sale shows server − queued, in memory and in the mirror, never the raw row", async () => {
    const { get } = makeStore();
    await queueOfflineSale(get, 2);                     // local 10 → 8, queued
    const ch = await live(get);                          // refresh keeps 8 (server 10 − 2)
    expect(qty(get, "p1")).toBe(8);
    const outbox = await localDb.syncOutbox.toArray();

    fake.server.inventory.set("shop-1:p1", 9);           // another till sold 1
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9 });
    expect(qty(get, "p1")).toBe(8);                      // not the raw 9, even for an instant
    await vi.waitFor(() => expect(qty(get, "p1")).toBe(7));
    await vi.waitFor(async () => expect(await mirrored("p1")).toBe(7));
    expect(await localDb.syncOutbox.toArray()).toEqual(outbox); // queue untouched
    expect(fake.server.inventory.get("shop-1:p1")).toBe(9);     // server value untouched

    // The sale drains: server 7, authoritative row 7, no double subtraction.
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.inventory.get("shop-1:p1")).toBe(7);
    expect(qty(get, "p1")).toBe(7);
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1" }); // its own commit event
    expect(qty(get, "p1")).toBe(7);
    await vi.waitFor(async () => expect(await mirrored("p1")).toBe(7));
  });

  it("with nothing queued the server row is applied synchronously and mirrored", async () => {
    const { get } = makeStore();
    const ch = await live(get);
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 4 });
    expect(qty(get, "p1")).toBe(4);
    await vi.waitFor(async () => expect(await mirrored("p1")).toBe(4));
  });

  it("rapid events: the last one wins, with the queued delta, and an earlier event's async step never overwrites it", async () => {
    const { get } = makeStore();
    await queueOfflineSale(get, 2);
    const ch = await live(get);
    const t = Date.parse(fake.serverNow());
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9, commitTimestamp: new Date(t + 1000).toISOString() });
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 6, commitTimestamp: new Date(t + 2000).toISOString() });
    await vi.waitFor(() => expect(qty(get, "p1")).toBe(4)); // 6 − 2
    await new Promise((r) => setTimeout(r, 20));
    expect(qty(get, "p1")).toBe(4);
    expect(await mirrored("p1")).toBe(4);
  });

  it("a sale acknowledged by the server before its own event arrives is not subtracted twice", async () => {
    const { get } = makeStore();
    await queueOfflineSale(get, 2);
    const ch = await live(get);
    expect(await drainOutbox()).toBe("drained");         // server 8; reconcile wrote 8; nothing pending
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1" }); // server row 8
    expect(qty(get, "p1")).toBe(8);
    await new Promise((r) => setTimeout(r, 20));
    expect(qty(get, "p1")).toBe(8);
  });

  it("a sale acknowledged WHILE an event is being processed: the drain's authoritative row stands, never double-subtracted", async () => {
    const { get } = makeStore();
    await queueOfflineSale(get, 2);
    const ch = await live(get);
    fake.server.inventory.set("shop-1:p1", 9);           // another till sold 1 (server 9)
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9 }); // async step in flight
    expect(await drainOutbox()).toBe("drained");         // our sale lands: server 7
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.server.inventory.get("shop-1:p1")).toBe(7);
    expect(qty(get, "p1")).toBe(7);
  });

  it("a DELETE cancels the pending correction of an earlier update", async () => {
    const { get } = makeStore();
    await queueOfflineSale(get, 2);
    const ch = await live(get);
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9 });
    ch.emitChange({ eventType: "DELETE", shopId: "shop-1", productId: "p1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(qty(get, "p1")).toBeUndefined();
  });

  it("an event whose async step is overtaken by a paged refresh does not overwrite the refresh's rows", async () => {
    const { get } = makeStore();
    await queueOfflineSale(get, 2);
    const ch = await live(get);
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9, commitTimestamp: new Date(Date.parse(fake.serverNow()) - 60_000).toISOString() });
    fake.server.inventory.set("shop-1:p1", 5);
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(qty(get, "p1")).toBe(3); // refresh: 5 − 2
  });
});

// M1: refresh-buffer events WITH commit timestamps (real postgres_changes
// always carry one): committed before the refresh's server time → already in
// the pages, ignored; after it → applied over the older page.
describe("M1: timestamp-aware refresh buffer", () => {
  const pid = (i: number) => `p-${String(i).padStart(5, "0")}`;
  const seed = (n: number) => { fake.server.inventory.clear(); for (let i = 0; i < n; i += 1) fake.server.inventory.set(`shop-1:${pid(i)}`, 10); };

  it("an event committed BEFORE the refresh's server time but delivered between pages is ignored (the pages include it)", async () => {
    seed(1500);
    const { get } = makeStore();
    handle = connect(get);
    const ch = fake.realtime.current();
    fake.setSelectHook((request) => {
      if (request !== 1) return;
      ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: pid(5), qty: 99, commitTimestamp: new Date(Date.parse(fake.serverNow()) - 30_000).toISOString() });
    });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, pid(5))).toBe(10);
  });

  it("an event committed AFTER the refresh's server time is applied over the older page", async () => {
    seed(1500);
    const { get } = makeStore();
    handle = connect(get);
    const ch = fake.realtime.current();
    fake.setSelectHook((request) => {
      if (request !== 1) return;
      fake.server.inventory.set(`shop-1:${pid(5)}`, 3);
      ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: pid(5), qty: 3, commitTimestamp: new Date(Date.parse(fake.serverNow()) + 1_000).toISOString() });
    });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get, pid(5))).toBe(3);
  });
});
