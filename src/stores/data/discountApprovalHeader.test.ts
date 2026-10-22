// Step 6 (PDISC-A, client): a sale whose discount needs an approval names it in the x-orvix-discount-approval header.
// The approval id travels with the OPERATION (the write-ahead / outbox entry), never inside complete_sale's hashed
// arguments: every attempt of the same key carries it (a resend after a lost reply included), and no other operation
// ever carries it.
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
import { createSaleSlice } from "./slices/saleSlice";
import { drainOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "./outbox";
import { resetWriteAheadForTests } from "./writeAhead";
import { resetOnlineOnlyForTests } from "./onlineOnly";
import { callRpc, DISCOUNT_APPROVAL_HEADER, setExecutorCapabilityForTests } from "./idempotentRpc";
import { loadRecoveryState, resetRecoveryStateForTests } from "./recoveryState";
import { resetRecoveryGateForTests } from "./recoveryGate";
import { resetFinCapabilitiesForTests } from "../../features/finance/finCompletion";

function makeSaleStore() {
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
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 100 }],
    ...slice,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}
const cartItem = (): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can", qty: 1, unitPriceMmk: 1000, unitsPerItem: 1,
  unitBaseQuantity: 1, priceLevelId: "pl-retail",
} as CartItem);
const sale = (discountApprovalId?: string) => ({
  shopId: "shop-1", cartItems: [cartItem()], cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 10,
  paymentMethod: "CASH" as const, paidMmk: 900, ...(discountApprovalId ? { discountApprovalId } : {}),
});
const saleCalls = () => fake.calls.filter((c) => c.name === "complete_sale" || (c.name === "op_execute" && c.args.p_rpc === "complete_sale"));
const keyOf = (c: { name: string; args: Record<string, unknown> }) =>
  String(c.name === "op_execute" ? c.args.p_key : c.args.p_idempotency_key);

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
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("x-orvix-discount-approval (PDISC-A)", () => {
  it("a sale with an approval sends the header; the id is never part of the sale's arguments", async () => {
    setExecutorCapabilityForTests("absent"); await restart();
    const { get } = makeSaleStore();
    await get().createSale(sale("fa-approved-1"));
    const [call] = saleCalls();
    expect(call.headers?.[DISCOUNT_APPROVAL_HEADER]).toBe("fa-approved-1");
    expect(JSON.stringify(call.args)).not.toContain("fa-approved-1");
  });

  it("through the 086 executor too (op_execute carries the header, not the arguments)", async () => {
    fake.enableExecutor(); setExecutorCapabilityForTests("available"); await restart();
    const { get } = makeSaleStore();
    await get().createSale(sale("fa-approved-2"));
    const [call] = saleCalls();
    expect(call.name).toBe("op_execute");
    expect(call.headers?.[DISCOUNT_APPROVAL_HEADER]).toBe("fa-approved-2");
    expect(JSON.stringify(call.args)).not.toContain("fa-approved-2");
  });

  it("a sale without an approval sends no header", async () => {
    setExecutorCapabilityForTests("absent"); await restart();
    const { get } = makeSaleStore();
    await get().createSale(sale());
    const [call] = saleCalls();
    expect(call.headers?.[DISCOUNT_APPROVAL_HEADER]).toBeUndefined();
  });

  it("a resend of the same operation (lost reply, same key) carries the same approval", async () => {
    setExecutorCapabilityForTests("absent"); await restart();
    const { get } = makeSaleStore();
    // the first request is the 087 probe (recovery_epoch); the sale's reply is the one lost
    fake.queueModes("succeed", "commit-then-timeout");
    await get().createSale(sale("fa-approved-3")).catch(() => undefined);
    const [queued] = await localDb.syncOutbox.toArray();
    expect(queued.discountApprovalId).toBe("fa-approved-3");
    expect(JSON.stringify(queued.args)).not.toContain("fa-approved-3");
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    const calls = saleCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(calls.map(keyOf)).size).toBe(1);
    for (const c of calls) expect(c.headers?.[DISCOUNT_APPROVAL_HEADER]).toBe("fa-approved-3");
    expect(fake.server.sales).toHaveLength(1);
  });

  it("is never attached to any other operation, even if asked to", async () => {
    setExecutorCapabilityForTests("absent"); await restart();
    await callRpc("open_shift", { p_shop_id: "shop-1", p_opening_cash_mmk: 0 }, { discountApprovalId: "fa-approved-4" });
    const [call] = fake.calls.filter((c) => c.name === "open_shift");
    expect(call).toBeTruthy();
    expect(call.headers?.[DISCOUNT_APPROVAL_HEADER]).toBeUndefined();
  });
});
