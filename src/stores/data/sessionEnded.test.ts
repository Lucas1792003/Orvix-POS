import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// Financial-safety fix 3 (security review): a reply that arrives after the
// person who sent it signed out (or another person signed in) is recorded —
// the outbox row acknowledged, the journal written, an online-only record
// settled — but never applied to the next session's screen or local mirror.
// ---------------------------------------------------------------------------

const auth: { currentUserId: string | null } = { currentUserId: "user-1" };
vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => auth, setState: () => undefined } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb } from "../../lib/localDb";
import { createSaleSlice } from "./slices/saleSlice";
import { registerOutboxReconciler, simulateNewAppInstanceForTests } from "./outbox";
import { callOnlineOnly, countUnsettledOnlineOperations, resetOnlineOnlyForTests } from "./onlineOnly";
import { resetWriteAheadForTests } from "./writeAhead";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { getJournalRecord } from "./opJournal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSaleStore(): { get: () => any } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => { state = { ...state, ...(typeof updater === "function" ? updater(state) : updater) }; };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createSaleSlice(set as any, get as any, {} as any);
  state = {
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }], products: [{ id: "p1", isNonStock: false }],
    getProductPrice: () => 0,
    getInventoryQty: () => 10,
    shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    ...slice,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}
const cart = (): CartItem[] => [{
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea", unitName: "Can",
  qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail",
}];

/** The server answers, then — before the reply is handled — the session changes. */
const switchSessionAfterReply = (next: string | null) => {
  const original = fake.rpc.bind(fake);
  vi.spyOn(fake, "rpc").mockImplementation(async (...a: Parameters<typeof fake.rpc>) => {
    const reply = await original(...a);
    if (a[0] !== "resolve_event_time") auth.currentUserId = next;
    return reply;
  });
};

beforeEach(async () => {
  fake.reset();
  setExecutorCapabilityForTests("absent");
  simulateNewAppInstanceForTests();
  resetWriteAheadForTests();
  resetOnlineOnlyForTests();
  auth.currentUserId = "user-1";
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({ authId: "a", userId: "user-1", role: "ADMIN", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("a reply that outlives its session", () => {
  it("SALE: committed on the server and acknowledged with its key (journal), but NOT applied to the next session's store or mirror", async () => {
    const { get } = makeSaleStore();
    switchSessionAfterReply("user-2");
    await expect(get().createSale({
      shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: 5000, cartItems: cart(),
    })).rejects.toMatchObject({ name: "SessionEndedError" });
    expect(fake.server.sales).toHaveLength(1);                     // the sale happened
    expect(get().sales).toHaveLength(0);                           // not shown to user-2
    expect(await localDb.sales.count()).toBe(0);                   // not mirrored
    expect(await localDb.syncOutbox.count()).toBe(0);              // acknowledged: never resent
    const key = fake.server.sales[0].idempotencyKey;
    expect(await getJournalRecord(key)).toMatchObject({ state: "committed" });
  });

  it("ONLINE-ONLY (supplier lump-sum payment): settled on this till, the caller gets SessionEndedError instead of the reply", async () => {
    switchSessionAfterReply(null);                                // signed out while in flight
    await expect(callOnlineOnly("pay_supplier_lump_sum", { p_supplier_id: "sup-1", p_amount_mmk: 1000, p_created_at: new Date().toISOString() }))
      .rejects.toMatchObject({ name: "SessionEndedError" });
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);
    expect(await countUnsettledOnlineOperations()).toBe(0);       // its record is settled, not left unresolved
  });

  it("the same session: replies are applied as before", async () => {
    const { get } = makeSaleStore();
    await get().createSale({
      shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: 5000, cartItems: cart(),
    });
    expect(get().sales).toHaveLength(1);
    const r = await callOnlineOnly("pay_supplier_lump_sum", { p_supplier_id: "sup-1", p_amount_mmk: 1000, p_created_at: new Date().toISOString() });
    expect(r.error).toBeNull();
  });
});
