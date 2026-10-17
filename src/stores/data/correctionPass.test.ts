import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// Batch 2A correction pass — Priority B (stock safety) and C (checkout crash
// recovery), driven through the real inventory/sale/transfer slices, the
// outbox and the fake server. Each test names the review finding it covers.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { createInventorySlice } from "./slices/inventorySlice";
import { createSaleSlice } from "./slices/saleSlice";
import { createTransferSlice } from "./slices/transferSlice";
import {
  drainOutbox, persistStaged, registerOutboxReconciler, restoreSetAsideEntry, retryOutboxEntry, setAsideOutboxEntry,
  simulateNewAppInstanceForTests,
} from "./outbox";
import { resetWriteAheadForTests } from "./writeAhead";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { resetOnlineOnlyForTests } from "./onlineOnly";
import { registerOperationPrompt, type PromptDecision } from "./operationPrompt";
import { readPersistedLedger, resetStockLedgerForTests } from "./stockLedger";
import { applyRecordedWrites, beginWriteRecording, endWriteRecording } from "./localWrites";
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
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const inventorySlice = createInventorySlice(set as any, get as any, {} as any);
  const saleSlice = createSaleSlice(set as any, get as any, {} as any);
  const transferSlice = createTransferSlice(set as any, get as any, {} as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  state = {
    ...inventorySlice, ...saleSlice, ...transferSlice,
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
    products: [{ id: "p1", isNonStock: false }, { id: "p2", isNonStock: false }],
    getProductPrice: () => 0,
    shifts: [], sales: [], saleItems: [], auditLogs: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    movements: [],
    ...seed,
  };
  registerOutboxReconciler("complete_sale", (data, provisional, ackId) => get().reconcileCompleteSale(data, provisional ?? [], ackId));
  registerOutboxReconciler("adjust_stock", (data, provisional, ackId) => get().reconcileAdjustStock(data, provisional ?? [], ackId));
  registerOutboxReconciler("receive_stock_transfer", (data, provisional, ackId) => get().reconcileReceiveTransfer(data, provisional ?? [], ackId));
  return { get, set };
}
type Store = ReturnType<typeof makeStore>;

const qty = (get: Store["get"], productId = "p1", shopId = "shop-1") =>
  get().inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits;
const mirrored = async (productId = "p1", shopId = "shop-1") => (await localDb.inventory.get([shopId, productId]))?.qtyBaseUnits;

const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can",
  qty: 1, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail",
  ...over,
});
const saleInput = { shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000 };
const sell = (get: Store["get"], n: number) => get().createSale({ ...saleInput, cartItems: [cartItem({ qty: n })] });
const sellOffline = async (get: Store["get"], n: number) => {
  vi.stubGlobal("navigator", { onLine: false });
  await sell(get, n);
  vi.stubGlobal("navigator", { onLine: true });
};
const settle = async (get: Store["get"]) => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    await get().syncStockWithQueue();
  }
};
// Watch the displayed figure for any value above `limit` while `fn` runs.
async function neverAbove(get: Store["get"], limit: number, fn: () => Promise<unknown>): Promise<number[]> {
  const seen: number[] = [];
  const t = setInterval(() => seen.push(qty(get) ?? NaN), 0);
  try {
    await fn();
  } finally {
    clearInterval(t);
  }
  seen.push(qty(get) ?? NaN);
  expect(Math.max(...seen.filter((v) => !Number.isNaN(v)))).toBeLessThanOrEqual(limit);
  return seen;
}

// Hold the next rpc reply until release() — the server has already executed it.
function holdNextReply() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = fake as any;
  const orig = f.rpc;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  f.rpc = (name: string, args: Record<string, unknown>) => {
    f.rpc = orig;
    const b = orig(name, args);
    const held = { abortSignal: () => held, then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => gate.then(() => b).then(ok, bad) };
    return held;
  };
  return () => release();
}

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
const answer = (decision: PromptDecision) => registerOperationPrompt(async () => decision);

beforeEach(async () => {
  setExecutorCapabilityForTests("absent");
  fake.reset();
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
  resetStockLedgerForTests();
  registerOperationPrompt(null);
  useAppStore.setState({ currentShopId: null });
  useSyncStore.setState({ inventorySyncState: "reconnecting" });
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  handle?.stop();
  handle = null;
  registerOperationPrompt(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ===========================================================================
describe("B: replies never raise stock above a newer live value (review P1/P2)", () => {
  it("a FIRST-attempt online reply older than a live event cannot raise stock; a refresh restores the exact figure", async () => {
    const { get } = makeStore();
    const ch = await live(get);
    const release = holdNextReply();
    const sale = sell(get, 2);                                  // server 10 → 8, reply held
    await vi.waitFor(() => expect(fake.server.inventory.get("shop-1:p1")).toBe(8));
    fake.server.inventory.set("shop-1:p1", 7);                  // another till sells 1: truth 7
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 7 });
    await neverAbove(get, 7, async () => {
      release();
      await sale;
      await settle(get);
      await new Promise((r) => setTimeout(r, 300));             // the requested refresh runs
      await settle(get);
    });
    expect(qty(get)).toBe(7);
    expect(await mirrored()).toBe(7);
  });

  it("the same for a drained (never-sent) offline sale", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);
    const ch = await live(get);
    const release = holdNextReply();
    const draining = drainOutbox();
    await vi.waitFor(() => expect(fake.server.inventory.get("shop-1:p1")).toBe(8));
    fake.server.inventory.set("shop-1:p1", 7);
    ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1", qty: 7 });
    await neverAbove(get, 7, async () => {
      release();
      await draining;
      await settle(get);
      await new Promise((r) => setTimeout(r, 300));
      await settle(get);
    });
    expect(qty(get)).toBe(7);
  });
});

// ===========================================================================
describe("B: acknowledgements during a refresh or a full load", () => {
  it("refresh crossing the server commit WITHOUT realtime: the older page cannot resurrect the sold units", async () => {
    // 1,500 rows: two pages; p1 sorts first, so it is on the first page.
    fake.server.inventory.clear();
    for (let i = 0; i < 1500; i += 1) fake.server.inventory.set(`shop-1:z-${String(i).padStart(5, "0")}`, 5);
    fake.server.inventory.set("shop-1:p1", 10);
    const { get } = makeStore();
    await sellOffline(get, 2);                                  // shown 8, queued
    const [entry] = await localDb.syncOutbox.toArray();
    fake.setSelectHook((request) => {
      if (request !== 1) return;
      // Between the pages: the sale reaches the server (10 → 8) and is
      // acknowledged — its reply applied, its entry removed.
      fake.server.inventory.set("shop-1:p1", 8);
      get().reconcileCompleteSale({
        sale: { id: "sale-srv" }, items: [], movements: [], auditLogs: [],
        inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 8 }],
      }, entry.provisional ?? [], entry.localId);
      void localDb.syncOutbox.delete(entry.localId);
    });
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(true);
    // The page said 10 (read before the commit) and the queue no longer has
    // the sale: without the correction this showed 10.
    expect(qty(get)).toBeLessThanOrEqual(8);
    fake.setSelectHook(null);
    await new Promise((r) => setTimeout(r, 700));               // the follow-up refresh
    expect(qty(get)).toBe(8);
  });

  it("acknowledgement during a FULL LOAD: the composed rows never exceed what is shown, and the released entry is not resurrected", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);                                  // shown 8
    const marker = get().beginStockRead();                      // the load starts its reads
    const pages = [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }]; // read before the commit
    expect(await drainOutbox()).toBe("drained");                // acknowledged during the load
    expect(qty(get)).toBe(8);
    const composed = await get().composeServerStock(pages, marker, [], Number.NEGATIVE_INFINITY);
    expect(composed!.rows[0].qtyBaseUnits).toBe(8);
    expect(composed!.followUp).toBe(true);
    expect(composed!.applied.size).toBe(0);                     // not resurrected
    get().noteStockLedger(composed!.applied, new Map());
    await settle(get);
    expect(qty(get)).toBe(8);                                   // a recompute does not add it back
  });

  it("staging during a full load with stale cached stock: the load neither drops it nor re-applies the stale absolute figure", async () => {
    const { get } = makeStore();
    const recorder = beginWriteRecording();
    const marker = get().beginStockRead();
    await sellOffline(get, 2);                                  // cached 10 → shown 8 (server is really 7)
    const pages = [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 7 }];
    const recorded = applyRecordedWrites({ inventory: pages, sales: [] }, endWriteRecording(recorder));
    expect(recorded.inventory).toEqual(pages);                  // the stale absolute 8 is NOT re-applied
    expect(recorded.sales).toHaveLength(1);                      // the staged sale is
    const composed = await get().composeServerStock(recorded.inventory, marker, [], Number.NEGATIVE_INFINITY);
    expect(composed!.rows[0].qtyBaseUnits).toBe(5);             // 7 − the 2 just staged
    expect(composed!.applied.size).toBe(1);
  });

  it("multiple queued sales and concurrent acknowledgement with live events: never above the truth, exact at the end", async () => {
    const { get } = makeStore();
    await sellOffline(get, 1);
    await sellOffline(get, 2);
    await sellOffline(get, 3);
    const ch = await live(get);
    expect(qty(get)).toBe(4);
    await neverAbove(get, 4, async () => {
      const a = drainOutbox();
      const b = drainOutbox();                                   // a concurrent call is refused, not doubled
      ch.emitChange({ eventType: "UPDATE", shopId: "shop-1", productId: "p1" });
      await Promise.all([a, b]);
      await settle(get);
      await new Promise((r) => setTimeout(r, 300));
      await settle(get);
    });
    expect(fake.server.executions.complete_sale).toBe(3);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(4);
    expect(qty(get)).toBe(4);
    expect(await mirrored()).toBe(4);
  });
});

// ===========================================================================
describe("B: fail closed", () => {
  it("an IndexedDB read failure is an error, not zero pending stock: rows kept, offline sales refused, refresh changes nothing", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);                                  // shown 8
    const where = vi.spyOn(localDb.syncOutbox, "where").mockImplementation(() => { throw new Error("IDB broken"); });
    await get().syncStockWithQueue();
    expect(get().stockUnverified).toBe(true);
    expect(qty(get)).toBe(8);                                   // NOT 10 ("nothing pending")
    expect(await get().refreshInventoryFromServer({ shopId: "shop-1" })).toBe(false);
    expect(qty(get)).toBe(8);
    where.mockRestore();
    vi.spyOn(localDb.syncOutbox, "where").mockImplementation(() => { throw new Error("IDB broken"); });
    await get().syncStockWithQueue();
    vi.restoreAllMocks();
    vi.stubGlobal("navigator", { onLine: false });
    // assertStockKnown is checked before the stock math: refused offline.
    vi.spyOn(localDb.syncOutbox, "where").mockImplementationOnce(() => { throw new Error("IDB broken"); });
    await get().syncStockWithQueue();
    await expect(sell(get, 1)).rejects.toThrow(/cannot be verified/);
    vi.restoreAllMocks();
    vi.stubGlobal("navigator", { onLine: true });
    await get().syncStockWithQueue();                           // readable again
    expect(get().stockUnverified).toBe(false);
    expect(qty(get)).toBe(8);
  });

  it("a queued movement that can no longer be read falls back to the operation's arguments (never zero)", async () => {
    const { get } = makeStore();
    await sellOffline(get, 2);
    await localDb.movements.clear();                            // the provisional movement is gone
    const ledger = await (await import("./pendingStock")).pendingStockLedger([], { products: get().products, productUnits: get().productUnits });
    expect([...ledger.byEntry.values()][0].get("shop-1|p1")).toBe(-2);
  });
});

// ===========================================================================
describe("B: recompute racing staging; aborted staging", () => {
  it("a recompute that read the queue before a new staging never undoes the new deduction (no upward step)", async () => {
    const { get } = makeStore();
    await neverAbove(get, 10, async () => {
      for (let i = 0; i < 5; i += 1) {
        const sync = get().syncStockWithQueue();                // reads the queue …
        await sellOffline(get, 1);                              // … while a sale is staged
        await sync;
        expect(qty(get)).toBe(9 - i);                            // never back up
      }
    });
    await settle(get);
    expect(qty(get)).toBe(5);
  });

  it("an aborted staging transaction leaves nothing: no phantom rows for a running full load, mirror and ledger unchanged", async () => {
    makeStore();
    const before = await readPersistedLedger();
    const recorder = beginWriteRecording();
    await expect(persistStaged(
      [{ sales: [{ id: "sale-phantom" } as never], inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 3 }], movements: [{ id: "mv-x", shopId: "shop-1", productId: "p1", qtyChange: -7 } as never] }],
      { update: { localId: "outbox-missing", changes: {} } },
    )).rejects.toThrow(/queue record is missing/);
    const writes = endWriteRecording(recorder);
    expect(writes.puts).toHaveLength(0);                         // nothing for the load to re-apply
    expect(await localDb.sales.get("sale-phantom")).toBeUndefined();
    expect(await mirrored()).toBe(10);
    expect(await readPersistedLedger()).toEqual(before);
  });

  it("upgrade after an older version drained the queue: a stale persisted ledger never RAISES the mirror's stock", async () => {
    const first = makeStore();
    await sellOffline(first.get, 2);                             // mirror 8, ledger {entry: −2}
    // v1.0.16 runs: it drains the sale, writes the server row (8) and
    // deletes the entry — without knowing about the ledger.
    await localDb.syncOutbox.clear();
    await localDb.inventory.put({ shopId: "shop-1", productId: "p1", qtyBaseUnits: 8 });
    simulateNewAppInstanceForTests();
    resetStockLedgerForTests();
    const { get } = makeStore({ inventory: await localDb.inventory.toArray() });
    await get().adoptStockLedger();
    await settle(get);
    expect(qty(get)).toBe(8);                                    // not raised back to 10
  });

  it("the mirror's rows and the persisted ledger always describe each other (restart offline: exact)", async () => {
    const first = makeStore();
    await sellOffline(first.get, 2);
    expect(await mirrored()).toBe(8);
    expect([...(await readPersistedLedger())!.values()][0].get("shop-1|p1")).toBe(-2);
    // Restart from the mirror.
    simulateNewAppInstanceForTests();
    resetWriteAheadForTests();
    const { get } = makeStore({ inventory: await localDb.inventory.toArray(), movements: await localDb.movements.toArray() });
    await get().adoptStockLedger();
    await settle(get);
    expect(qty(get)).toBe(8);
  });
});

// ===========================================================================
describe("B: queue-state transitions and transfers", () => {
  it("set aside keeps the deduction (pending confirmation), restore and retry recompute; a refusal releases it", async () => {
    useAuthStore.setState({ currentUserId: "admin-1", currentRole: "ADMIN" });
    const { get } = makeStore();
    await sellOffline(get, 2);
    const [entry] = await localDb.syncOutbox.toArray();
    await setAsideOutboxEntry(entry.localId, { wasExported: () => true });
    await settle(get);
    expect(qty(get)).toBe(8);                                    // still deducted
    expect(get().stockPendingConfirmation).toEqual({ "shop-1|p1": 2 });
    await restoreSetAsideEntry(entry.localId);
    await settle(get);
    expect(qty(get)).toBe(8);
    expect(get().stockPendingConfirmation).toEqual({});
    fake.setDefaultMode("permanent-error");
    await drainOutbox();
    await settle(get);
    // refused by a server WITHOUT 086: the refusal is not recorded there, so
    // the sale could still run if retried — the deduction stays reserved
    expect(qty(get)).toBe(8);
    fake.setDefaultMode("succeed");
    await retryOutboxEntry(entry.localId);
    await settle(get);
    expect(qty(get)).toBe(8);                                    // queued again: counted again
  });

  it("transfer receipt in flight (no local rows yet): the SOURCE deduction is derived from its arguments; the increase is not shown", async () => {
    const transfer = { id: "tr-1", transferNo: "T-1", fromShopId: "shop-1", toShopId: "shop-2", status: "IN_TRANSIT" };
    const { get } = makeStore({
      stockTransfers: [transfer],
      stockTransferItems: [{ id: "ti-1", transferId: "tr-1", productId: "p1", requestedQty: 3, approvedQty: 3 }],
      inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }, { shopId: "shop-2", productId: "p1", qtyBaseUnits: 0 }],
    });
    fake.queueModes("hang");
    void get().receiveTransfer({ transferId: "tr-1", actorId: "user-1" });
    await vi.waitFor(async () => expect(await localDb.syncOutbox.count()).toBe(1));
    await settle(get);
    expect(qty(get, "p1", "shop-1")).toBe(7);                    // source −3, pending confirmation
    expect(qty(get, "p1", "shop-2")).toBe(0);                    // destination not raised
    expect(get().stockPendingConfirmation).toEqual({ "shop-1|p1": 3 });
  });

  it("transfer dispatch moves no stock (hold at source)", async () => {
    const transfer = { id: "tr-2", transferNo: "T-2", fromShopId: "shop-1", toShopId: "shop-2", status: "APPROVED" };
    const { get } = makeStore({ stockTransfers: [transfer], stockTransferItems: [] });
    vi.stubGlobal("navigator", { onLine: false });
    await get().dispatchTransfer({ transferId: "tr-2", actorId: "user-1" });
    await settle(get);
    expect(qty(get)).toBe(10);
  });
});

// ===========================================================================
describe("C: checkout crash recovery", () => {
  const crashMidCheckout = async () => {
    const first = makeStore();
    fake.queueModes("commit-then-hang");                        // the server commits; this till never hears back
    void sell(first.get, 2);
    await vi.waitFor(() => expect(fake.server.executions.complete_sale).toBe(1));
    simulateNewAppInstanceForTests();                           // the till restarts
    resetWriteAheadForTests();
    return makeStore();
  };

  it("crash mid-checkout, restart, re-ring: the cashier is asked; by default NOTHING is sent", async () => {
    const { get } = await crashMidCheckout();
    await expect(sell(get, 2)).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    expect(fake.callsFor("complete_sale")).toHaveLength(1);    // no second request, no new key
  });

  // G1 Stage 1: the crashed attempt was never evaluated offline, so WAIT
  // never resends it. Without 086 it is held; with 086 the server is asked.
  it("…choosing WAIT, server WITHOUT 086: the earlier sale is held (never resent) — one sale on the server, nothing more sent", async () => {
    const { get } = await crashMidCheckout();
    answer("retry");
    await expect(sell(get, 2)).rejects.toMatchObject({ name: "PendingConfirmationError" });
    await vi.waitFor(async () => expect((await localDb.syncOutbox.toArray())[0]).toMatchObject({ heldReason: "needs-server-086" }));
    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    expect(fake.server.executions.complete_sale).toBe(1);
  });

  it("…choosing WAIT, server WITH 086: the lookup finds the committed sale and reconciles it — one sale, nothing resent", async () => {
    useAuthStore.setState({ currentUserId: "user-1" });
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const { get } = await crashMidCheckout();
    answer("retry");
    await expect(sell(get, 2)).rejects.toMatchObject({ name: "PendingConfirmationError" });
    await vi.waitFor(async () => expect(await localDb.syncOutbox.count()).toBe(0));
    expect(fake.callsFor("op_execute")).toHaveLength(1);
    expect(fake.callsFor("op_status")).toHaveLength(1);
    expect(fake.server.executions.complete_sale).toBe(1);
    expect(get().sales.map((s: { id: string }) => s.id)).toEqual(["sale-server-1"]);
  });

  // G1 Stage 1 (finding 7): a replacement only once the earlier attempt is
  // known not to have happened.
  it("…choosing NEW SALE, server WITHOUT 086: refused — the earlier sale cannot be confirmed or stopped; no new key", async () => {
    const { get } = await crashMidCheckout();
    answer("new");
    await expect(sell(get, 2)).rejects.toMatchObject({ name: "UnresolvedOperationError" });
    expect(new Set(fake.callsFor("complete_sale").map((c) => c.args.p_idempotency_key)).size).toBe(1);
    expect(fake.server.executions.complete_sale).toBe(1);
  });

  it("…choosing NEW SALE, server WITH 086: the earlier sale DID commit — it is recorded instead and nothing new is rung up", async () => {
    useAuthStore.setState({ currentUserId: "user-1" });
    fake.enableExecutor();
    setExecutorCapabilityForTests("available");
    const { get } = await crashMidCheckout();
    answer("new");
    await expect(sell(get, 2)).rejects.toMatchObject({ name: "PendingConfirmationError", message: expect.stringMatching(/has now been recorded/) });
    expect(fake.server.executions.complete_sale).toBe(1);
    expect(new Set(fake.callsFor("op_execute").map((c) => c.args.p_key)).size).toBe(1);
    expect(get().sales.map((s: { id: string }) => s.id)).toEqual(["sale-server-1"]);
  });

  it("failed local staging after an unknown outcome keeps the original operation (same key, in doubt); stock is still deducted", async () => {
    const { get } = makeStore();
    fake.queueModes("commit-then-timeout");
    vi.spyOn(localDb.sales, "bulkPut").mockRejectedValueOnce(new Error("disk full"));
    await expect(sell(get, 2)).rejects.toThrow(/Not recorded on this till/);
    const [row] = await localDb.syncOutbox.toArray();
    const [sent] = fake.callsFor("complete_sale");
    expect(row).toMatchObject({
      status: "conflict", inDoubt: true, writeAhead: true, idempotencyKey: sent.args.p_idempotency_key, fenceRequired: true,
    });
    expect(get().sales).toHaveLength(0);
    await settle(get);
    expect(qty(get)).toBe(8);                                    // derived from its arguments
    expect(get().stockPendingConfirmation).toEqual({ "shop-1|p1": 2 });
  });

  it("backend unreachable with an EXPIRED offline authorisation: not traded locally, kept for confirmation", async () => {
    const { get } = makeStore();
    await localDb.authCache.clear();                            // the 12 h window lapsed
    fake.queueModes("network-error");                            // "Failed to fetch": unknown, not proof of a commit
    await expect(sell(get, 2)).rejects.toThrow(/Not recorded on this till/);
    expect(get().sales).toHaveLength(0);
    expect((await localDb.syncOutbox.toArray())[0]).toMatchObject({ inDoubt: true, writeAhead: true, fenceRequired: true });
  });

  it("backend unreachable at the gateway (not delivered) with an expired authorisation: refused, nothing kept", async () => {
    const { get } = makeStore();
    await localDb.authCache.clear();
    fake.queueReply({ data: null, status: 503, error: { message: "no healthy upstream", code: "", details: "", hint: "" } });
    await expect(sell(get, 2)).rejects.toThrow();
    expect(get().sales).toHaveLength(0);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("insufficient stock during ambiguous connectivity: not staged (no oversell), kept for confirmation", async () => {
    const { get } = makeStore({ inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 1 }] });
    fake.queueModes("network-error");
    await expect(sell(get, 2)).rejects.toThrow(/Not recorded on this till.*Only 1 in stock/);
    expect(get().sales).toHaveLength(0);
  });

  it("an in-doubt sale with enough stock IS staged: its own in-flight deduction is not counted twice by the check", async () => {
    const { get } = makeStore({ inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 3 }] });
    await localDb.inventory.put({ shopId: "shop-1", productId: "p1", qtyBaseUnits: 3 });
    const release = holdNextReply();
    fake.queueModes("network-error");
    const sale = sell(get, 2).then(() => "ok", (e) => e.message as string);
    await vi.waitFor(async () => expect(await localDb.syncOutbox.count()).toBe(1));
    await settle(get);
    expect(qty(get)).toBe(1);                                    // counted while being sent (D-NEW-1)
    release();
    expect(await sale).toMatch(/^Pending confirmation: the server's reply was lost/); // staged, not refused
    expect(get().sales[0]).toMatchObject({ pendingConfirmation: true });
    await settle(get);
    expect(qty(get)).toBe(1);                                    // and not deducted twice
  });

  it("an unresolved sale is never a confirmed sale: flagged unconfirmed, no final receipt (see ReceiptDetail)", async () => {
    const { get } = makeStore();
    fake.queueModes("commit-then-timeout");
    await expect(sell(get, 2)).rejects.toMatchObject({ name: "PendingConfirmationError" });
    expect(get().sales[0]).toMatchObject({ pendingSync: true, pendingConfirmation: true, receiptNo: "PENDING" });
    await drainOutbox();                                         // confirmed with the same key
    expect(get().sales[0].pendingConfirmation).toBeUndefined();
    expect(fake.server.executions.complete_sale).toBe(1);
  });
});

// ===========================================================================
describe("web build: a second window cannot take over an in-flight sale (review P5)", () => {
  it("with Web Locks, another window's startup recovery and drain skip a row this window is still sending", async () => {
    // A minimal shared lock manager (both "windows" are this process).
    const held = new Set<string>();
    const locks = {
      request: (name: string, a: unknown, b?: unknown) => {
        const cb = (typeof a === "function" ? a : b) as (lock: unknown) => Promise<unknown>;
        const opts = (typeof a === "function" ? {} : a) as { ifAvailable?: boolean };
        if (held.has(name) && opts.ifAvailable) return Promise.resolve(cb(null));
        held.add(name);
        return Promise.resolve(cb({ name })).finally(() => held.delete(name));
      },
      query: async () => ({ held: [...held].map((name) => ({ name })) }),
    };
    vi.stubGlobal("navigator", { onLine: true, locks });
    const { get } = makeStore();
    const release = holdNextReply();
    const sale = sell(get, 2).then(() => "ok", (e) => e.name);
    await vi.waitFor(async () => expect(await localDb.syncOutbox.count()).toBe(1));
    // "Window B" starts: its own in-flight set is empty.
    const inFlight = new Set(held);
    simulateNewAppInstanceForTests();
    for (const n of inFlight) held.add(n);                      // window A still holds its lock
    expect(await drainOutbox()).toBe("drained");                 // nothing pending for B to send
    const [row] = await localDb.syncOutbox.toArray();
    expect(row.status).toBe("syncing");                          // not taken over
    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    release();
    expect(await sale).toBe("ok");
    expect(fake.server.executions.complete_sale).toBe(1);
  });
});
