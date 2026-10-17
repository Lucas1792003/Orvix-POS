import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// Batch 2A, Checkpoint C — stock inclusion under owner decision D-NEW-1.
// Displayed stock = confirmed server row + this till's unresolved effects:
// whole effects of entries not yet sent, only DECREASES of entries being
// sent or in doubt (flagged "pending confirmation"). Driven end to end
// through the real inventory + sale slices, the outbox and the fake server.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { createInventorySlice } from "./slices/inventorySlice";
import { createSaleSlice } from "./slices/saleSlice";
import { drainOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "./outbox";
import { resetWriteAheadForTests } from "./writeAhead";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { resetOnlineOnlyForTests } from "./onlineOnly";
import { inventoryRealtimeSessionForTests, subscribeInventoryRealtime, type InventoryRealtimeHandle } from "./inventoryRealtime";
import { useSyncStore } from "../syncStore";
import { useAppStore } from "../appStore";
import { useAuthStore } from "../authStore";
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
type Store = ReturnType<typeof makeStore>;

const qty = (get: Store["get"], productId = "p1", shopId = "shop-1") =>
  get().inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits;
const mirrored = async (productId = "p1") => (await localDb.inventory.get(["shop-1", productId]))?.qtyBaseUnits;
const unconfirmed = (get: Store["get"]) => get().stockPendingConfirmation;

const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can",
  qty: 1, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail",
  ...over,
});
const saleInput = {
  shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1",
  cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000,
};
const sell = (get: Store["get"], n: number) => get().createSale({ ...saleInput, cartItems: [cartItem({ qty: n })] });
// An unknown outcome is reported as "pending confirmation" (never recorded, never failed).
const sellInDoubt = (get: Store["get"], n: number) =>
  expect(sell(get, n)).rejects.toMatchObject({ name: "PendingConfirmationError" });
const sellOffline = async (get: Store["get"], n: number) => {
  vi.stubGlobal("navigator", { onLine: false });
  await sell(get, n);
  vi.stubGlobal("navigator", { onLine: true });
};
// Let queued recomputes and requested refreshes run.
const settleStock = async (get: Store["get"]) => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    await get().syncStockWithQueue();
  }
};

let handle: InventoryRealtimeHandle | null = null;
const live = async (get: Store["get"]) => {
  handle = subscribeInventoryRealtime({
    client: fake as unknown as SupabaseClient,
    onRow: (row, ts) => get().applyInventoryRealtimeUpdate(row, ts),
    onDelete: (shopId, productId, ts) => get().applyInventoryRealtimeDelete(shopId, productId, ts),
    refresh: (shopId) => get().refreshInventoryFromServer({ shopId }),
  });
  const ch = fake.realtime.current();
  ch.emitStatus("SUBSCRIBED");
  const session = inventoryRealtimeSessionForTests();
  while (session?.inFlight) await session.inFlight;
  return ch;
};

beforeEach(async () => {
  fake.reset();
  setExecutorCapabilityForTests("absent");
  fake.server.inventory.set("shop-1:p1", 10);
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.inventory.put({ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 });
  await localDb.authCache.put({
    authId: TEST_AUTH_ID, userId: "user-1", role: "CASHIER", shopId: "shop-1",
    isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
  });
  simulateNewAppInstanceForTests();
  resetWriteAheadForTests();
  resetOnlineOnlyForTests();
  useAppStore.setState({ currentShopId: null });
  useSyncStore.setState({ inventorySyncState: "reconnecting" });
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  handle?.stop();
  handle = null;
  vi.unstubAllGlobals();
});

describe("D-NEW-1: queued (not sent) operations", () => {
  it("two queued sales for one product: both count, across a refresh, and each drains exactly once", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);
    await sellOffline(get, 3);
    expect(qty(get)).toBe(5);
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get)).toBe(5); // server 10 − 2 − 3
    expect(unconfirmed(get)).toEqual({}); // not sent: not "pending confirmation"

    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.executions.complete_sale).toBe(2);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(5);
    await settleStock(get);
    expect(qty(get)).toBe(5);
    expect(await mirrored()).toBe(5);
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get)).toBe(5);
  });

  it("acknowledging the FIRST of two queued sales keeps the second one's deduction on the server row", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);
    await sellOffline(get, 3);
    // Only the first entry gets through; the second fails without reaching the server.
    fake.queueModes("succeed", "network-error");
    await drainOutbox();
    expect(fake.server.inventory.get("shop-1:p1")).toBe(8);
    await settleStock(get);
    expect(qty(get)).toBe(5); // server 8 − the 3 still queued
    expect(await localDb.syncOutbox.count()).toBe(1);
  });

  it("a refusal the server RECORDED (086) releases the deduction (the server moved no stock and never will)", async () => {
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    useAuthStore.setState({ currentUserId: "user-1" });     // a UUIDv7 operation runs only for its actor
    fake.setCaller("user-1");
    onTestFinished(() => useAuthStore.setState({ currentUserId: null }));
    const { get } = makeStore();
    await sellOffline(get, 2);
    expect(qty(get)).toBe(8);
    fake.setDefaultMode("permanent-error");
    await drainOutbox();
    const [entry] = await localDb.syncOutbox.toArray();
    expect(entry).toMatchObject({ status: "conflict", serverOutcome: "rejected" });
    await settleStock(get);
    expect(qty(get)).toBe(10);
    expect(await mirrored()).toBe(10);
  });

  it("a refusal the server did NOT record (server without 086) keeps the deduction reserved — it could still run if retried", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);
    fake.setDefaultMode("permanent-error");
    expect(await drainOutbox()).toBe("backoff");
    const [entry] = await localDb.syncOutbox.toArray();
    expect(entry).toMatchObject({ status: "conflict", blocksQueue: true });
    expect(entry.serverOutcome).toBeUndefined();
    await settleStock(get);
    expect(qty(get)).toBe(8);
  });
});

describe("D-NEW-1: outcome unknown (in doubt)", () => {
  it("a lost reply: the deduction stays, flagged pending confirmation; the same key settles it", async () => {
    const { get } = makeStore();
    fake.queueModes("commit-then-timeout"); // server commits (10 → 8), reply lost
    await sellInDoubt(get, 2);
    await settleStock(get);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(8);
    expect(qty(get)).toBe(8);
    expect(unconfirmed(get)).toEqual({ "shop-1|p1": 2 });

    // A refresh shows the CONFIRMED server row minus the unconfirmed
    // deduction: temporarily understated (6), never overstated.
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get)).toBe(6);
    expect(unconfirmed(get)).toEqual({ "shop-1|p1": 2 });

    // The resend (same key) is answered from the server's ledger: no second sale.
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.executions.complete_sale).toBe(1);
    expect(fake.calls.filter((c) => c.name === "complete_sale").map((c) => c.args.p_idempotency_key))
      .toEqual(Array(2).fill(fake.calls.find((c) => c.name === "complete_sale")!.args.p_idempotency_key));
    await settleStock(get);
    expect(unconfirmed(get)).toEqual({});
    expect(qty(get)).toBe(8); // the authoritative refresh restored the exact figure
    expect(await mirrored()).toBe(8);
  });

  it("a stored (older) reply never overwrites a newer live event: stock is not raised", async () => {
    const { get } = makeStore();
    const ch = await live(get);
    fake.queueModes("commit-then-timeout");
    await sellInDoubt(get, 2); // server 8, reply lost
    await settleStock(get);
    // Another till sells 1: server 7, delivered live.
    fake.server.inventory.set("shop-1:p1", 7);
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 7 });
    expect(qty(get)).toBe(5); // 7 − our unconfirmed 2 (understated, safe)

    // The replay returns the STORED reply (qty 8 — older than the event).
    const seen: number[] = [];
    const stop = setInterval(() => seen.push(qty(get) ?? NaN), 0);
    expect(await drainOutbox()).toBe("drained");
    seen.push(qty(get) ?? NaN);
    await settleStock(get);
    clearInterval(stop);
    expect(Math.max(...seen)).toBeLessThanOrEqual(7); // never the stale 8
    expect(qty(get)).toBe(7);
    expect(unconfirmed(get)).toEqual({});
  });

  it("restart with an in-doubt sale: the mirror's rows keep the deduction and the indicator comes back", async () => {
    const first = makeStore();
    fake.queueModes("commit-then-timeout");
    await sellInDoubt(first.get, 2);
    await settleStock(first.get);
    expect(await mirrored()).toBe(8);

    // New app instance, rendered from the local mirror.
    simulateNewAppInstanceForTests();
    resetWriteAheadForTests();
    const { get } = makeStore({ inventory: await localDb.inventory.toArray(), movements: await localDb.movements.toArray() });
    await get().adoptStockLedger();
    expect(qty(get)).toBe(8);
    expect(unconfirmed(get)).toEqual({ "shop-1|p1": 2 });
    await settleStock(get);
    expect(qty(get)).toBe(8); // adopting moved nothing

    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.executions.complete_sale).toBe(1);
    await settleStock(get);
    expect(qty(get)).toBe(8);
    expect(unconfirmed(get)).toEqual({});
  });

  it("crash after the server commit, before any local staging: the effect is derived from the queued arguments (086: settled by lookup)", async () => {
    (await import("../authStore")).useAuthStore.setState({ currentUserId: "user-1" });
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const first = makeStore();
    fake.queueModes("commit-then-hang");
    void sell(first.get, 2); // committed on the server; this instance never hears back
    await vi.waitFor(async () => expect(await localDb.syncOutbox.count()).toBe(1));
    await vi.waitFor(() => expect(fake.server.executions.complete_sale).toBe(1));

    simulateNewAppInstanceForTests(); // the till restarts
    resetWriteAheadForTests();
    const { get } = makeStore();
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    expect(qty(get)).toBe(6); // server 8 − the unconfirmed 2 (no local rows exist)
    expect(unconfirmed(get)).toEqual({ "shop-1|p1": 2 });

    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.executions.complete_sale).toBe(1); // looked up, not re-sold
    expect(fake.callsFor("op_execute")).toHaveLength(1);
    await settleStock(get);
    expect(qty(get)).toBe(8);
    expect(unconfirmed(get)).toEqual({});
  });
});

describe("D-NEW-1: acknowledgements racing live events", () => {
  it("the sale's own commit event arriving while the drain is acknowledging it never double-subtracts", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);
    const ch = await live(get);
    expect(qty(get)).toBe(8);
    const draining = drainOutbox();
    // Its commit event (server row 8) lands before the reply is applied.
    await vi.waitFor(() => expect(fake.server.inventory.get("shop-1:p1")).toBe(8));
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1" });
    expect(qty(get)).toBeLessThanOrEqual(8); // understated for an instant at most
    expect(await draining).toBe("drained");
    await settleStock(get);
    expect(qty(get)).toBe(8);
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1" }); // a late duplicate
    expect(qty(get)).toBe(8);
    expect(await mirrored()).toBe(8);
  });

  it("another till's sale delivered during the drain is kept, and ours is subtracted once", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);
    const ch = await live(get);
    fake.server.inventory.set("shop-1:p1", 9); // another till sold 1
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 9 });
    expect(qty(get)).toBe(7);
    expect(await drainOutbox()).toBe("drained"); // server 7
    await settleStock(get);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(7);
    expect(qty(get)).toBe(7);
  });
});

describe("queue data stays readable by v1.0.16", () => {
  // The fields and statuses v1.0.16 (RC3, 0e29236) reads. Batch 2A only ADDS
  // optional fields (writeAhead, sentAt, inDoubt, heldReason, authFailures);
  // a v1.0.16 drain of these rows is exercised against the RC3 tree itself
  // (see the Batch 2A report).
  const V1016_STATUSES = ["pending", "syncing", "failed", "conflict", "quarantined", "archived", "reconciled"];
  const V1016_REQUIRED = ["kind", "name", "args", "idempotencyKey", "localId", "createdAt", "status", "attempts"];

  it("every row the new lifecycle writes has the v1.0.16 shape and a v1.0.16 status", async () => {
    const { get } = makeStore();
    // (an online sale queues behind unsent entries, so the online ones first)
    fake.queueModes("commit-then-hang");
    void sell(get, 3);                         // syncing write-ahead
    await vi.waitFor(async () => expect(await localDb.syncOutbox.count()).toBe(1));
    fake.queueModes("commit-then-timeout");
    await sellInDoubt(get, 2);                 // pending + inDoubt
    await sellOffline(get, 1);                 // pending
    await vi.waitFor(async () => expect(await localDb.syncOutbox.count()).toBe(3));
    for (const row of await localDb.syncOutbox.toArray()) {
      expect(V1016_STATUSES).toContain(row.status);
      for (const field of V1016_REQUIRED) expect(row).toHaveProperty(field);
      expect(row.args.p_idempotency_key).toBe(row.idempotencyKey);
    }
  });
});
