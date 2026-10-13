import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// Phase D reliability suite — docs/selfhost-migration/phase-d/
// offline-authorization.md §5 and idempotency-contract.md "Tests".
//
// Failure is modelled the way supabase-js really behaves: a fetch failure
// is a RESOLVED `{ data: null, error: { message: "TypeError: Failed to
// fetch" }, status: 0 }`, not a rejected promise; the in-memory server in
// testing/fakeSupabase.ts implements the idempotency contract so "commit
// then lose the response" and "same key twice" can be exercised end to end
// through the real slices, outbox and reconcilers.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: "user-1" }) } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb, SYNC_STATE_KEYS } from "../../lib/localDb";
import { createSaleSlice } from "./slices/saleSlice";
import { createInventorySlice } from "./slices/inventorySlice";
import { createPurchaseSlice } from "./slices/purchaseSlice";
import {
  BACKOFF_CAP_MS, clearNeedsReauth, computeBackoffMs, drainOutbox, enqueueOutbox, listOutboxConflicts,
  listOutboxEntries, readNeedsReauth, registerOutboxReconciler,
} from "./outbox";
import { callRpc, newIdempotencyKey } from "./idempotentRpc";
import { assertOfflineWriteEligible, OFFLINE_WRITE_TRUST_MS } from "../authStore";
import { useSyncStore } from "../syncStore";

const TEST_AUTH_ID = "auth-test-user";

// Minimal zustand-style harness (same as the per-slice offline tests). Each
// call is an independent "store instance" — a fresh terminal, or the same
// terminal after a restart — sharing the one IndexedDB like a real device.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSaleStore(seed: Record<string, any> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => {
    const patch = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...patch };
  };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createSaleSlice(set as any, get as any, {} as any);
  state = {
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
    products: [{ id: "p1", isNonStock: false }],
    getProductPrice: () => 0,
    getInventoryQty: (shopId: string, productId: string) =>
      state.inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)
        ?.qtyBaseUnits ?? 0,
    shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    ...slice,
    ...seed,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeInventoryStore(seed: Record<string, any> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => {
    const patch = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...patch };
  };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createInventorySlice(set as any, get as any, {} as any);
  state = {
    ...slice,
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    movements: [], auditLogs: [],
    ...seed,
  };
  registerOutboxReconciler("adjust_stock", (data, provisional) => get().reconcileAdjustStock(data, provisional ?? []));
  return { get };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePurchaseStore(seed: Record<string, any> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => {
    const patch = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...patch };
  };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createPurchaseSlice(set as any, get as any, {} as any);
  state = {
    ...slice,
    productUnits: [],
    getInventoryQty: () => 0,
    purchaseOrders: [{ id: "po-1", shopId: "shop-1", supplierId: "sup-1", status: "RECEIVED", totalMmk: 10_000, paidMmk: 0 }],
    purchaseOrderItems: [], inventory: [], movements: [], supplierPayments: [], auditLogs: [],
    ...seed,
  };
  registerOutboxReconciler("record_supplier_payment", (data, provisional) =>
    get().reconcileRecordSupplierPayment(data, provisional ?? []));
  return { get };
}

const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can",
  qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail",
  ...over,
});

const saleInput = (over: Partial<Parameters<ReturnType<typeof makeSaleStore>["get"]>[0]> = {}) => ({
  shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1",
  cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000, cartItems: [cartItem()],
  ...over,
});

const completeSaleArgs = (key: string, paid = 5000) => ({
  p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: paid,
  p_cart_discount_pct: 0, p_items: [{ product_id: "p1", qty: 2, units_per_item: 1 }],
  p_created_at: "2026-10-12T09:00:00.000Z", p_idempotency_key: key,
});

const goOnline = () => vi.stubGlobal("navigator", { onLine: true });
const goOffline = () => vi.stubGlobal("navigator", { onLine: false });

beforeEach(async () => {
  fake.reset();
  fake.server.inventory.set("shop-1:p1", 10);
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({
    authId: TEST_AUTH_ID, userId: "user-1", role: "CASHIER", shopId: "shop-1", orgId: null,
    isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
  });
  useSyncStore.setState({ pendingCount: 0, conflictCount: 0, needsReauth: false, isDraining: false, lastTransientError: null });
  goOnline();
});
afterEach(() => vi.unstubAllGlobals());

describe("idempotent checkout", () => {
  it("normal checkout: one server sale, the key is sent, local state reconciled from the reply", async () => {
    const { get } = makeSaleStore();

    const saleId = await get().createSale(saleInput());

    expect(saleId).toBe("sale-server-1");
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.server.executions.complete_sale).toBe(1);
    const [call] = fake.callsFor("complete_sale");
    expect(call.args.p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.replayed).toBe(false);
    expect(get().sales[0]).toMatchObject({ id: "sale-server-1", receiptNo: "R-1" });
    expect(get().inventory.find((i: { productId: string }) => i.productId === "p1")?.qtyBaseUnits).toBe(8);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("duplicate submission: the same operation sent twice with the same key yields one server sale and identical responses", async () => {
    const key = newIdempotencyKey();

    const first = await callRpc("complete_sale", completeSaleArgs(key));
    const second = await callRpc("complete_sale", completeSaleArgs(key));

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toEqual(first.data);
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.server.executions.complete_sale).toBe(1);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(8); // deducted once
    expect(fake.calls[1].replayed).toBe(true);
  });

  it("same key, different payload: permanent IDEMPOTENCY_MISMATCH conflict, no second sale, nothing retried", async () => {
    const key = newIdempotencyKey();
    await callRpc("complete_sale", completeSaleArgs(key, 5000));
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(key, 9999), shopId: "shop-1", idempotencyKey: key });

    await expect(drainOutbox()).resolves.toBe("drained");

    const [entry] = await localDb.syncOutbox.toArray();
    expect(entry.status).toBe("conflict");
    expect(entry.failureKind).toBe("permanent");
    expect(entry.lastError).toContain("IDEMPOTENCY_MISMATCH");
    expect(fake.server.sales).toHaveLength(1);
    expect(await listOutboxConflicts()).toHaveLength(1);
    // A second drain must not touch a conflict.
    await drainOutbox();
    expect(fake.callsFor("complete_sale")).toHaveLength(2);
  });

  it("commit-then-timeout: the replay returns the original response, one sale, provisional reconciled", async () => {
    goOffline();
    const { get } = makeSaleStore();
    const provisionalId = await get().createSale(saleInput());
    expect(get().sales[0]).toMatchObject({ id: provisionalId, pendingSync: true, receiptNo: "PENDING" });
    const [queued] = await localDb.syncOutbox.toArray();
    expect(queued.idempotencyKey).toBe(get().sales[0].idempotencyKey);

    goOnline();
    // The server commits, then the response is lost on the way back.
    fake.queueModes("commit-then-timeout");
    await expect(drainOutbox()).resolves.toBe("network");
    expect(fake.server.sales).toHaveLength(1);
    const [afterFirst] = await localDb.syncOutbox.toArray();
    expect(afterFirst).toMatchObject({ status: "pending", attempts: 1, failureKind: "transient" });
    expect(get().sales[0].pendingSync).toBe(true); // still provisional locally

    // Next pass (backoff cleared as the periodic trigger would see it later).
    await localDb.syncOutbox.update(afterFirst.localId, { nextAttemptAt: undefined });
    await expect(drainOutbox()).resolves.toBe("drained");

    const calls = fake.callsFor("complete_sale");
    expect(calls).toHaveLength(2);
    expect(calls[1].args.p_idempotency_key).toBe(calls[0].args.p_idempotency_key);
    expect(calls[1].replayed).toBe(true);
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.server.executions.complete_sale).toBe(1);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(8);
    // Provisional rows swapped for the server's — in state and in the mirror.
    expect(get().sales.map((s: { id: string }) => s.id)).toEqual(["sale-server-1"]);
    expect(get().sales[0].pendingSync).toBeUndefined();
    expect(await localDb.sales.get(provisionalId)).toBeUndefined();
    expect((await localDb.sales.get("sale-server-1"))?.receiptNo).toBe("R-1");
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("offline checkout then reconnect: drained exactly once", async () => {
    goOffline();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    expect(fake.calls).toHaveLength(0);

    goOnline();
    await drainOutbox();
    await drainOutbox(); // a second trigger (periodic / pullDeltas) finds nothing to send

    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    expect(fake.server.sales).toHaveLength(1);
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(get().sales[0].id).toBe("sale-server-1");
  });

  it("online path that fails on the network reuses the same key when it falls back to the queue", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("gateway-502"); // a 502 from the gateway — classified as network

    const provisionalId = await get().createSale(saleInput());

    expect(get().sales[0]).toMatchObject({ id: provisionalId, pendingSync: true });
    const [queued] = await localDb.syncOutbox.toArray();
    const [firstAttempt] = fake.callsFor("complete_sale");
    expect(queued.idempotencyKey).toBe(firstAttempt.args.p_idempotency_key);
    expect(queued.args?.p_idempotency_key).toBe(firstAttempt.args.p_idempotency_key);

    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.callsFor("complete_sale")[1].args.p_idempotency_key).toBe(firstAttempt.args.p_idempotency_key);
  });

  it("application restart with pending operations: a new store instance drains them once", async () => {
    goOffline();
    const terminalBeforeRestart = makeSaleStore();
    await terminalBeforeRestart.get().createSale(saleInput());
    expect(await localDb.syncOutbox.count()).toBe(1); // persisted in IndexedDB

    // "Restart": a fresh store instance hydrates nothing from the old one; the
    // queue lives in IndexedDB, and the reconciler now points at the new store.
    const terminalAfterRestart = makeSaleStore();
    goOnline();
    await drainOutbox();

    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    expect(fake.server.sales).toHaveLength(1);
    expect(terminalAfterRestart.get().sales[0]).toMatchObject({ id: "sale-server-1" });
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("multiple terminals, interleaved: every sale lands exactly once even with racing drains", async () => {
    goOffline();
    const terminalA = makeSaleStore();
    const terminalB = makeSaleStore();
    await terminalA.get().createSale(saleInput({ paidMmk: 2000 }));
    await terminalB.get().createSale(saleInput({ paidMmk: 3000 }));
    await terminalA.get().createSale(saleInput({ paidMmk: 4000 }));
    const keys = (await localDb.syncOutbox.toArray()).map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(3);

    goOnline();
    await Promise.all([drainOutbox(), drainOutbox(), drainOutbox()]);

    expect(fake.callsFor("complete_sale")).toHaveLength(3);
    expect(fake.server.sales).toHaveLength(3);
    expect(new Set(fake.server.sales.map((s) => s.idempotencyKey))).toEqual(new Set(keys));
    expect(fake.server.inventory.get("shop-1:p1")).toBe(4); // 10 - 3 sales × 2
    expect(await localDb.syncOutbox.count()).toBe(0);
  });
});

describe("other money/stock RPCs", () => {
  it("stock adjustment retry after a lost response is applied once", async () => {
    goOffline();
    const { get } = makeInventoryStore();
    await get().adjustStock({ shopId: "shop-1", productId: "p1", type: "ADJUSTMENT", qtyChange: -3, reason: "Recount", actorId: "user-1" });

    goOnline();
    fake.queueModes("commit-then-timeout");
    await expect(drainOutbox()).resolves.toBe("network");
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await expect(drainOutbox()).resolves.toBe("drained");

    expect(fake.callsFor("adjust_stock")).toHaveLength(2);
    expect(fake.server.executions.adjust_stock).toBe(1);
    expect(fake.server.inventory.get("shop-1:p1")).toBe(7);
    expect(get().inventory.find((i: { productId: string }) => i.productId === "p1")?.qtyBaseUnits).toBe(7);
    expect(get().movements.map((m: { id: string }) => m.id)).toEqual(["mv-server-1"]);
  });

  it("supplier payment retry after a lost response is applied once", async () => {
    goOffline();
    const { get } = makePurchaseStore();
    await get().recordSupplierPayment({ purchaseOrderId: "po-1", amountMmk: 4000, paymentMethod: "CASH" });

    goOnline();
    fake.queueModes("commit-then-timeout");
    await drainOutbox();
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();

    expect(fake.callsFor("record_supplier_payment")).toHaveLength(2);
    expect(fake.server.executions.record_supplier_payment).toBe(1);
    expect(fake.server.payments).toHaveLength(1);
    expect(fake.server.purchaseOrders.get("po-1")?.paidMmk).toBe(4000);
    expect(get().supplierPayments.map((p: { id: string }) => p.id)).toEqual(["suppay-server-1"]);
    expect(get().purchaseOrders[0].paidMmk).toBe(4000);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });
});

describe("session handling during sync", () => {
  it("expired JWT with a successful refresh: the pass refreshes first and continues", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    fake.setAuth("expired", "ok");

    await expect(drainOutbox()).resolves.toBe("drained");

    expect(fake.refreshCalls).toBe(1);
    expect(fake.server.sales).toHaveLength(1);
    expect(await readNeedsReauth()).toBe(false);
  });

  it("a 401 JWT-expired reply mid-pass is transient: kept pending, sent once the next pass refreshes", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    fake.queueModes("jwt-expired");

    await expect(drainOutbox()).resolves.toBe("network");
    const [entry] = await localDb.syncOutbox.toArray();
    expect(entry).toMatchObject({ status: "pending", failureKind: "transient", attempts: 1 });
    expect(entry.lastError).toContain("JWT expired");

    await localDb.syncOutbox.update(entry.localId, { nextAttemptAt: undefined });
    await expect(drainOutbox()).resolves.toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
  });

  it("expired JWT with a failed refresh (auth error): needs-reauth, nothing lost or sent, drains after sign-in", async () => {
    goOffline();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    goOnline();
    fake.setAuth("none-auth-error", "invalid"); // refresh token revoked server-side

    await expect(drainOutbox()).resolves.toBe("needs-reauth");

    expect(fake.calls).toHaveLength(0); // nothing sent
    expect(await localDb.syncOutbox.count()).toBe(1); // nothing lost
    expect((await localDb.syncOutbox.toArray())[0].status).toBe("pending");
    expect(await readNeedsReauth()).toBe(true);
    expect((await localDb.syncState.get(SYNC_STATE_KEYS.needsReauth))?.flag).toBe(true);
    expect(useSyncStore.getState().needsReauth).toBe(true);
    // New offline writes are refused while the server has rejected the session…
    await expect(assertOfflineWriteEligible()).rejects.toThrow(/sign in again/i);
    // …and repeated triggers keep refusing without sending.
    await expect(drainOutbox()).resolves.toBe("needs-reauth");
    expect(fake.calls).toHaveLength(0);

    // The user signs in again — what AppLayout's onAuthStateChange listener does.
    fake.setAuth("valid");
    await clearNeedsReauth();
    await expect(drainOutbox()).resolves.toBe("drained");

    expect(fake.server.sales).toHaveLength(1);
    expect(await readNeedsReauth()).toBe(false);
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(get().sales[0].id).toBe("sale-server-1");
  });

  it("a refresh that fails on the network keeps everything pending without flagging needs-reauth", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    fake.setAuth("none-network-error", "network");

    await expect(drainOutbox()).resolves.toBe("network");

    expect(fake.calls).toHaveLength(0);
    expect(await readNeedsReauth()).toBe(false);
    expect((await localDb.syncOutbox.toArray())[0].status).toBe("pending");
  });
});

describe("concurrency and locking", () => {
  it("concurrent duplicate: two drains racing in one context send the entry once", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });

    const [first, second] = await Promise.all([drainOutbox(), drainOutbox()]);

    expect([first, second].sort()).toEqual(["already-running", "drained"]);
    expect(fake.callsFor("complete_sale")).toHaveLength(1);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("another instance holding the Dexie drain lease blocks this one; an expired lease does not", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    await localDb.syncState.put({
      key: SYNC_STATE_KEYS.drainLease, ownerId: "drain-other-window",
      expiresAt: new Date(Date.now() + 30_000).toISOString(), updatedAt: new Date().toISOString(),
    });

    await expect(drainOutbox()).resolves.toBe("locked");
    expect(fake.calls).toHaveLength(0);

    // The other window died: its lease lapses after the 60 s TTL.
    await localDb.syncState.update(SYNC_STATE_KEYS.drainLease, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(drainOutbox()).resolves.toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
    expect(await localDb.syncState.get(SYNC_STATE_KEYS.drainLease)).toBeUndefined(); // released
  });

  it("uses navigator.locks (ifAvailable) when the platform provides it", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    const request = vi.fn(async (_name: string, _opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => cb(null));
    vi.stubGlobal("navigator", { onLine: true, locks: { request } });

    await expect(drainOutbox()).resolves.toBe("locked"); // the lock was held elsewhere
    expect(request).toHaveBeenCalledWith("pos-outbox-drain", { ifAvailable: true }, expect.any(Function));
    expect(fake.calls).toHaveLength(0);

    request.mockImplementation(async (_n, _o, cb) => cb({ name: "pos-outbox-drain" }));
    await expect(drainOutbox()).resolves.toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
  });
});

describe("ordering, backoff and classification", () => {
  it("backoff schedule is exponential, jittered and capped at 5 minutes", () => {
    const noJitter = () => 0.5;
    expect(computeBackoffMs(1, noJitter)).toBe(1_000);
    expect(computeBackoffMs(2, noJitter)).toBe(2_000);
    expect(computeBackoffMs(3, noJitter)).toBe(4_000);
    expect(computeBackoffMs(9, noJitter)).toBe(256_000);
    expect(computeBackoffMs(10, noJitter)).toBe(BACKOFF_CAP_MS);
    expect(computeBackoffMs(60, noJitter)).toBe(BACKOFF_CAP_MS);
    expect(computeBackoffMs(2, () => 0)).toBe(1_600); // -20 %
    expect(computeBackoffMs(2, () => 1)).toBe(2_400); // +20 %
    for (let attempts = 1; attempts <= 40; attempts++) {
      const ms = computeBackoffMs(attempts);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    }
  });

  it("drains in enqueue order even when two entries share the same createdAt millisecond", async () => {
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-1", p_opening_cash_mmk: 1 }, shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: { p_shift_id: "s" }, shopId: "shop-1" });
    // Same clock reading for all three — the clock must not decide the order.
    await localDb.syncOutbox.toCollection().modify({ createdAt: "2026-10-12T09:00:00.000Z" });

    const listed = await listOutboxEntries();
    expect(listed.map((e) => e.name)).toEqual(["open_shift", "complete_sale", "close_shift"]);
    expect(listed.map((e) => (e as { seq?: number }).seq)).toEqual([1, 2, 3]);

    await expect(drainOutbox()).resolves.toBe("drained");
    expect(fake.calls.map((c) => c.name)).toEqual(["open_shift", "complete_sale", "close_shift"]);
  });

  it("legacy entries without a seq (pre-Phase-D rows) drain before new ones, by createdAt", async () => {
    await localDb.syncOutbox.put({
      localId: "outbox-legacy-b", kind: "rpc", name: "adjust_stock", args: {}, shopId: "shop-1",
      createdAt: "2026-01-02T00:00:00.000Z", status: "pending", attempts: 0,
    });
    await localDb.syncOutbox.put({
      localId: "outbox-legacy-a", kind: "rpc", name: "open_shift", args: {}, shopId: "shop-1",
      createdAt: "2026-01-01T00:00:00.000Z", status: "pending", attempts: 0,
    });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });

    await drainOutbox();

    expect(fake.calls.map((c) => c.name)).toEqual(["open_shift", "adjust_stock", "complete_sale"]);
  });

  it("a transient failure stops the pass so later entries do not run ahead", async () => {
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-1", p_opening_cash_mmk: 1 }, shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    // Deterministic: identical createdAt, so only the enqueue sequence can order them.
    await localDb.syncOutbox.toCollection().modify({ createdAt: "2026-10-12T09:00:00.000Z" });
    fake.queueModes("server-500");

    await expect(drainOutbox()).resolves.toBe("network");

    expect(fake.calls.map((c) => c.name)).toEqual(["open_shift"]);
    const entries = await listOutboxEntries();
    expect(entries[0]).toMatchObject({ name: "open_shift", status: "pending", attempts: 1, failureKind: "transient" });
    expect(entries[1]).toMatchObject({ name: "complete_sale", status: "pending", attempts: 0 });

    // While the head entry is still in its backoff window nothing overtakes it…
    await expect(drainOutbox()).resolves.toBe("backoff");
    expect(fake.calls).toHaveLength(1);
    // …and once the window has passed the whole queue drains in order.
    await localDb.syncOutbox.update(entries[0].localId, { nextAttemptAt: undefined });
    await expect(drainOutbox()).resolves.toBe("drained");
    expect(fake.calls.map((c) => c.name)).toEqual(["open_shift", "open_shift", "complete_sale"]);
  });

  it("a permanent failure becomes a conflict and does not block later independent entries", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: completeSaleArgs(newIdempotencyKey()), shopId: "shop-1" });
    fake.queueModes("permanent-error");

    await expect(drainOutbox()).resolves.toBe("drained");

    expect(fake.calls).toHaveLength(2);
    const entries = await localDb.syncOutbox.toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "conflict", failureKind: "permanent", lastError: "Insufficient stock for Tea Mix" });
    expect(fake.server.sales).toHaveLength(1);
    expect(useSyncStore.getState().conflictCount).toBe(1);
  });

  it("a hung request is cut off by the timeout and treated as transient", async () => {
    fake.queueModes("hang");

    const outcome = await callRpc("complete_sale", completeSaleArgs(newIdempotencyKey()), { timeoutMs: 20 });

    expect(outcome.error?.transient).toBe(true);
    expect(outcome.error?.code).toBe("TIMEOUT");
    expect(outcome.error?.message).toMatch(/timed out/);
  });

  it("refuses new offline writes once the authorisation window has lapsed, keeping the queue", async () => {
    goOffline();
    const { get } = makeSaleStore();
    await get().createSale(saleInput()); // inside the window → queued
    await localDb.authCache.update(TEST_AUTH_ID, {
      cachedAt: new Date(Date.now() - OFFLINE_WRITE_TRUST_MS - 60_000).toISOString(),
    });

    await expect(get().createSale(saleInput())).rejects.toThrow(/offline for more than 12 hours/);

    expect(await localDb.syncOutbox.count()).toBe(1); // the earlier sale is untouched
    expect(get().sales).toHaveLength(1);
  });
});
