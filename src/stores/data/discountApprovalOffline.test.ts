// Step 6 (PDISC-A, client): a sale whose discount needs an approval (or that names one) is SENT NOW or not at all —
// never staged, queued or recorded offline, and never parked behind earlier queued work of this till. Refused before
// anything is saved or sent; the online path is unchanged. Also (PFIN-F): a refund request an older build queued
// offline is held for an owner's review on drain, never sent; a queued VOID request is sent as before.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CartItem } from "../../types";

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
const acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" };
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => acting } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb } from "../../lib/localDb";
import { createSaleSlice, DISCOUNT_APPROVAL_BACKLOG_MESSAGE, DISCOUNT_APPROVAL_OFFLINE_MESSAGE } from "./slices/saleSlice";
import {
  buildOutboxRow, drainOutbox, LEGACY_OFFLINE_REFUND_TEXT, OWNER_REVIEW, registerOutboxReconciler, simulateNewAppInstanceForTests,
} from "./outbox";
import { MustSendNowError, resetWriteAheadForTests } from "./writeAhead";
import { resetOnlineOnlyForTests } from "./onlineOnly";
import { DISCOUNT_APPROVAL_HEADER, setExecutorCapabilityForTests } from "./idempotentRpc";
import { loadRecoveryState, resetRecoveryStateForTests } from "./recoveryState";
import { resetRecoveryGateForTests } from "./recoveryGate";
import { resetFinCapabilitiesForTests } from "../../features/finance/finCompletion";
import { useConnectivityStore } from "../connectivityStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSaleStore(extra: Record<string, any> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => { const patch = typeof updater === "function" ? updater(state) : updater; state = { ...state, ...patch }; };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createSaleSlice(set as any, get as any, {} as any);
  state = {
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }], products: [{ id: "p1", isNonStock: false }], getProductPrice: () => 0,
    getInventoryQty: () => 100, shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 100 }], users: [],
    ...extra,
    ...slice,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}
const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can", qty: 1, unitPriceMmk: 1000, unitsPerItem: 1,
  unitBaseQuantity: 1, priceLevelId: "pl-retail", ...over,
} as CartItem);
const sale = (cartDiscountPct: number, discountApprovalId?: string) => ({
  shopId: "shop-1", cartItems: [cartItem()], cashierId: "user-1", shiftId: "shift-1", cartDiscountPct,
  paymentMethod: "CASH" as const, paidMmk: 1000, ...(discountApprovalId ? { discountApprovalId } : {}),
});
const saleCalls = () => fake.calls.filter((c) => c.name === "complete_sale" || (c.name === "op_execute" && c.args.p_rpc === "complete_sale"));
const nothingRecorded = async (get: () => { sales: unknown[] }) => {
  expect(await localDb.syncOutbox.count()).toBe(0);
  expect(await localDb.sales.count()).toBe(0);
  expect(get().sales).toHaveLength(0);
  expect(saleCalls()).toHaveLength(0);
};

const restart = async () => {
  simulateNewAppInstanceForTests(); resetWriteAheadForTests(); resetOnlineOnlyForTests();
  resetRecoveryStateForTests(null); resetRecoveryGateForTests(); resetFinCapabilitiesForTests();
  await loadRecoveryState(acting.currentOrgId);
};

beforeEach(async () => {
  fake.reset();
  fake.setCaller("user-1", false, "org-1");
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  vi.stubGlobal("navigator", { onLine: true });
  useConnectivityStore.getState().setOnline(true);
  setExecutorCapabilityForTests("absent"); await restart();
  resetRecoveryStateForTests();                 // a pre-087 server (the v87.x "no offline entries" rule does not apply)
});
afterEach(() => { vi.unstubAllGlobals(); useConnectivityStore.getState().setOnline(true); });

describe("an approval-requiring discount is never recorded offline (Review 4 HIGH-1)", () => {
  it("offline (browser): a cashier's discount is refused before anything is saved or sent", async () => {
    const { get } = makeSaleStore();
    vi.stubGlobal("navigator", { onLine: false });
    const attempt = get().createSale(sale(10));
    await expect(attempt).rejects.toBeInstanceOf(MustSendNowError);
    await expect(attempt).rejects.toThrow(DISCOUNT_APPROVAL_OFFLINE_MESSAGE);
    await nothingRecorded(get);
  });

  it("offline per the connectivity store (the till's banner) — refused the same way", async () => {
    const { get } = makeSaleStore();
    useConnectivityStore.getState().setOnline(false);
    await expect(get().createSale(sale(10))).rejects.toThrow(DISCOUNT_APPROVAL_OFFLINE_MESSAGE);
    await nothingRecorded(get);
  });

  it("a sale that names an approval is refused offline too", async () => {
    const { get } = makeSaleStore();
    vi.stubGlobal("navigator", { onLine: false });
    await expect(get().createSale(sale(10, "fa-1"))).rejects.toThrow(DISCOUNT_APPROVAL_OFFLINE_MESSAGE);
    await nothingRecorded(get);
  });

  it("the server was definitely not reached: the attempt is discarded, never turned into an offline sale", async () => {
    await restart();                                 // 087 status unknown: the gate asks the server first
    const { get } = makeSaleStore();
    fake.queueModes("succeed", "not-delivered");     // the 087 probe answers; the sale itself never arrives
    await expect(get().createSale(sale(10, "fa-2"))).rejects.toThrow(DISCOUNT_APPROVAL_OFFLINE_MESSAGE);
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(await localDb.sales.count()).toBe(0);
    expect(get().sales).toHaveLength(0);
  });

  it("offline: a sale with no discount is still recorded offline as before", async () => {
    const { get } = makeSaleStore();
    vi.stubGlobal("navigator", { onLine: false });
    await get().createSale(sale(0));
    expect((await localDb.syncOutbox.toArray()).map((r) => r.name)).toEqual(["complete_sale"]);
    expect(saleCalls()).toHaveLength(0);
  });

  it("offline: a manager's own discount within rule (a) is still recorded offline", async () => {
    const { get } = makeSaleStore({ users: [{ id: "user-1", role: "MANAGER", isActive: true }] });
    vi.stubGlobal("navigator", { onLine: false });
    await get().createSale(sale(5));
    expect((await localDb.syncOutbox.toArray()).map((r) => r.name)).toEqual(["complete_sale"]);
  });

  it("offline: a manager's discount above the limit is refused", async () => {
    const { get } = makeSaleStore({ users: [{ id: "user-1", role: "MANAGER", isActive: true }] });
    vi.stubGlobal("navigator", { onLine: false });
    await expect(get().createSale(sale(6))).rejects.toThrow(DISCOUNT_APPROVAL_OFFLINE_MESSAGE);
    await nothingRecorded(get);
  });

  it("online: unchanged — a cashier's discount is sent at once (the server decides), with its approval header", async () => {
    const { get } = makeSaleStore();
    await get().createSale(sale(10, "fa-3"));
    const [call] = saleCalls();
    expect(call.headers?.[DISCOUNT_APPROVAL_HEADER]).toBe("fa-3");
    expect(fake.server.sales).toHaveLength(1);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });
});

describe("a sale naming an approval is never parked behind a backlog (Review 4 MEDIUM-3)", () => {
  it("an earlier unsent entry it may depend on (a queued restock of the same product): refused before staging", async () => {
    const { get } = makeSaleStore();
    const restock = buildOutboxRow({
      kind: "rpc", name: "adjust_stock", shopId: "shop-1", idempotencyKey: "0192f3a0-0000-7000-8000-0000000000aa",
      args: { p_shop_id: "shop-1", p_product_id: "p1", p_quantity_delta: 5, p_reason: "restock", p_idempotency_key: "0192f3a0-0000-7000-8000-0000000000aa" },
    }, { staged: true, nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    await localDb.syncOutbox.put(restock);
    await expect(get().createSale(sale(10, "fa-4"))).rejects.toThrow(DISCOUNT_APPROVAL_BACKLOG_MESSAGE);
    expect((await localDb.syncOutbox.toArray()).map((r) => r.localId)).toEqual([restock.localId]);
    expect(saleCalls()).toHaveLength(0);
    expect(get().sales).toHaveLength(0);
    expect(await localDb.sales.count()).toBe(0);
  });

  it("an earlier queued sale it is proven independent of does not hold it: sent at once, as before", async () => {
    const { get } = makeSaleStore();
    vi.stubGlobal("navigator", { onLine: false });
    await get().createSale(sale(0));                               // an earlier sale queued offline (sales commute)
    vi.stubGlobal("navigator", { onLine: true });
    await get().createSale(sale(10, "fa-5"));
    const sent = saleCalls().filter((c) => c.headers?.[DISCOUNT_APPROVAL_HEADER] === "fa-5");
    expect(sent).toHaveLength(1);
  });
});

describe("refund requests an older build queued offline (Review 4 MEDIUM-4)", () => {
  const queued = (type: "PARTIAL" | "VOID", key: string) => buildOutboxRow({
    kind: "rpc", name: "create_refund_void_request", shopId: "shop-1", idempotencyKey: key,
    args: { p_sale_id: "sale-1", p_type: type, p_reason: "Damaged", p_items: type === "PARTIAL" ? [{ productId: "p1", qtyUnits: 1, amountMmk: 1000 }] : null,
      p_idempotency_key: key },
  }, { staged: true });

  it("a queued PARTIAL request is held for an owner's review on drain, never sent", async () => {
    const row = queued("PARTIAL", "0192f3a0-0000-7000-8000-000000000001");
    await localDb.syncOutbox.put(row);
    await drainOutbox();
    const held = await localDb.syncOutbox.get(row.localId);
    expect(held?.heldReason).toBe(OWNER_REVIEW);
    expect(held?.lastError).toBe(LEGACY_OFFLINE_REFUND_TEXT);
    expect(fake.calls.filter((c) => c.name === "create_refund_void_request" || c.args.p_rpc === "create_refund_void_request")).toHaveLength(0);
    // a second pass leaves it held, still unsent
    await drainOutbox();
    expect((await localDb.syncOutbox.get(row.localId))?.heldReason).toBe(OWNER_REVIEW);
    expect(fake.calls.filter((c) => c.name === "create_refund_void_request" || c.args.p_rpc === "create_refund_void_request")).toHaveLength(0);
  });

  it("a queued VOID request is left alone (sent as before)", async () => {
    const row = queued("VOID", "0192f3a0-0000-7000-8000-000000000002");
    await localDb.syncOutbox.put(row);
    await drainOutbox();
    expect(fake.calls.filter((c) => c.name === "create_refund_void_request" || c.args.p_rpc === "create_refund_void_request")).toHaveLength(1);
    expect((await localDb.syncOutbox.get(row.localId))?.heldReason).not.toBe(OWNER_REVIEW);
  });
});
