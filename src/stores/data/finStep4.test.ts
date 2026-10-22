// Step 4 (Part A, client): split / mixed payments travel through fin_complete_sale_split on whichever route the server
// needs (085 direct, 086 op_execute, 087 op_execute_v87), never inside complete_sale's own hashed arguments; a server
// without PFIN-D refuses nothing silently (the sale is kept, never converted to a single payment); the PFIN-D keyed
// RPCs that are not on the executor's pinned list use a v4 key (086 runs a v7 key only inside op_execute).
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
import { createShiftSlice } from "./slices/shiftSlice";
import { drainOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "./outbox";
import { resetWriteAheadForTests } from "./writeAhead";
import { callOnlineOnly, resetOnlineOnlyForTests } from "./onlineOnly";
import { callRpc, DIRECT_KEYED_RPCS, idempotencyKeyFor, newIdempotencyKey, setExecutorCapabilityForTests, SPLIT_RPC } from "./idempotentRpc";
import { loadRecoveryState, resetRecoveryStateForTests, storeTillCredential, recoveryView } from "./recoveryState";
import { refreshRecoveryEpoch } from "./recovery87";
import { resetRecoveryGateForTests } from "./recoveryGate";
import { planPayments, type PaymentPart } from "../../features/finance/payments";
import { finCapabilities, resetFinCapabilitiesForTests } from "../../features/finance/finCompletion";
import { OFFLINE_HEADER } from "../../recovery/offlineCapability";

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
const SPLIT: PaymentPart[] = [{ method: "CASH", amountMmk: 400, tenderedMmk: 500 }, { method: "BANK_TRANSFER", amountMmk: 600, reference: "KBZ-1" }];
const splitSale = (parts: PaymentPart[] = SPLIT) => {
  const r = planPayments(parts, 1000);
  if (!r.ok) throw new Error("bad test split");
  return { shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, cartItems: [cartItem()],
    paymentMethod: r.plan.legacyMethod, paidMmk: r.plan.paidMmk, payments: r.plan.payments };
};
const singleSale = () => ({ shopId: "shop-1", cartItems: [cartItem()], cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 1000 });
const splitCalls = () => fake.calls.filter((c) => c.name === SPLIT_RPC);
const isV4 = (k: unknown) => typeof k === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/i.test(k);
const isV7 = (k: unknown) => typeof k === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/i.test(k);

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

describe("payment rules (mirrors fin_payments_canonical)", () => {
  it("derives the legacy method, paid and change; only cash takes change", () => {
    const r = planPayments(SPLIT, 1000);
    expect(r).toMatchObject({ ok: true, plan: { legacyMethod: "CASH", paidMmk: 1100, changeMmk: 100, cashMmk: 400 } });
    expect(planPayments([{ method: "CARD", amountMmk: 1000, tenderedMmk: 1200 }], 1000)).toMatchObject({ ok: false, problem: { code: "NON_CASH_CHANGE" } });
    expect(planPayments([{ method: "CARD", amountMmk: 600 }, { method: "OTHER", amountMmk: 400 }], 1000)).toMatchObject({ ok: true, plan: { legacyMethod: "OTHER", paidMmk: 1000 } });
  });
  it("refuses a wrong total, a repeated method, zero / fractional amounts, short cash and long references", () => {
    expect(planPayments([{ method: "CASH", amountMmk: 999 }], 1000)).toMatchObject({ ok: false, problem: { code: "TOTAL_MISMATCH" } });
    expect(planPayments([{ method: "CASH", amountMmk: 500 }, { method: "CASH", amountMmk: 500 }], 1000)).toMatchObject({ ok: false, problem: { code: "DUPLICATE_METHOD" } });
    expect(planPayments([{ method: "CASH", amountMmk: 0 }, { method: "CARD", amountMmk: 1000 }], 1000)).toMatchObject({ ok: false, problem: { code: "AMOUNT" } });
    expect(planPayments([{ method: "CASH", amountMmk: 999.5 }], 999.5)).toMatchObject({ ok: false, problem: { code: "AMOUNT" } });
    expect(planPayments([{ method: "CASH", amountMmk: 1000, tenderedMmk: 900 }], 1000)).toMatchObject({ ok: false, problem: { code: "TENDER_BELOW_AMOUNT" } });
    expect(planPayments([{ method: "CARD", amountMmk: 1000, reference: "x".repeat(121) }], 1000)).toMatchObject({ ok: false, problem: { code: "REFERENCE_TOO_LONG" } });
    expect(planPayments([], 0)).toMatchObject({ ok: false, problem: { code: "COUNT" } });
  });
});

describe("split sale routing", () => {
  it("085 server with PFIN-D (no executor): fin_complete_sale_split route direct, the split outside the sale's arguments", async () => {
    fake.enableFin(); setExecutorCapabilityForTests("absent"); await restart();
    const { get } = makeSaleStore();
    const id = await get().createSale(splitSale());
    expect(splitCalls()).toHaveLength(1);
    const a = splitCalls()[0].args as Record<string, unknown>;
    expect(a.p_route).toBe("direct");
    expect((a.p_args as Record<string, unknown>).p_payments).toBeUndefined();
    expect(a.p_payments).toEqual([{ method: "CASH", amountMmk: 400, tenderedMmk: 500, reference: null }, { method: "BANK_TRANSFER", amountMmk: 600, tenderedMmk: 600, reference: "KBZ-1" }]);
    expect((a.p_args as Record<string, unknown>).p_payment_method).toBe("CASH");
    expect((a.p_args as Record<string, unknown>).p_paid_mmk).toBe(1100);
    expect(get().sales.find((s: { id: string }) => s.id === id)).toBeTruthy();
    expect(fake.finSplits.size).toBe(1);
  });

  it("086 server: the split goes through op_execute (route op_execute) with the sale's own v7 key", async () => {
    fake.enableFin(); fake.enableExecutor(); setExecutorCapabilityForTests("available"); await restart();
    const { get } = makeSaleStore();
    await get().createSale(splitSale());
    const a = splitCalls()[0].args as Record<string, unknown>;
    expect(a.p_route).toBe("op_execute");
    expect(isV7(a.p_key)).toBe(true);
    expect((a.p_args as Record<string, unknown>).p_idempotency_key).toBeUndefined();
    expect(fake.calls.filter((c) => c.name === "complete_sale" || c.name === "op_execute")).toHaveLength(0);
  });

  it("087 server: the split goes through op_execute_v87 (route v87) with the till context", async () => {
    fake.enableFin(); fake.enable087(); setExecutorCapabilityForTests("available"); await restart();
    const secret = fake.register87Till(recoveryView().tillId, { reconciled: true });
    await storeTillCredential({ orgId: "org-1", secret });
    expect((await refreshRecoveryEpoch({ shopId: "shop-1" })).kind).toBe("issued");
    const { get } = makeSaleStore();
    await get().createSale(splitSale());
    const a = splitCalls()[0].args as Record<string, unknown>;
    expect(a.p_route).toBe("v87");
    expect(a.p_ctx).toBeTruthy();
  });

  it("a server WITHOUT PFIN-D: FIN_SPLIT_UNSUPPORTED, nothing converted to a single payment, the queued sale is never deleted", async () => {
    setExecutorCapabilityForTests("absent"); await restart();
    const { get } = makeSaleStore();
    await expect(get().createSale(splitSale())).rejects.toThrow(/split payment/i);
    expect(fake.calls.filter((c) => c.name === "complete_sale")).toHaveLength(0);
    const rows = await localDb.syncOutbox.toArray();
    // the write-ahead record keeps the split and its key (held for review, never resent as a single payment)
    for (const r of rows) expect((r.args as Record<string, unknown>).p_payments).toBeTruthy();
  });

  it("a single-payment sale is unchanged (complete_sale, no split call)", async () => {
    fake.enableFin(); setExecutorCapabilityForTests("absent"); await restart();
    const { get } = makeSaleStore();
    await get().createSale(singleSale());
    expect(splitCalls()).toHaveLength(0);
    expect(fake.calls.filter((c) => c.name === "complete_sale")).toHaveLength(1);
  });

  it("an inconsistent split is refused before anything is recorded", async () => {
    fake.enableFin(); setExecutorCapabilityForTests("absent"); await restart();
    const { get } = makeSaleStore();
    await expect(get().createSale({ ...splitSale(), paidMmk: 999 })).rejects.toThrow(/not valid/);
    await expect(get().createSale({ ...splitSale(), payments: [{ method: "CASH", amountMmk: 10, tenderedMmk: 10, reference: null }] })).rejects.toThrow(/not valid/);
    expect(fake.calls).toHaveLength(0);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("a lost reply is resent with the same key and the same split (one sale, one split row)", async () => {
    fake.enableFin(); setExecutorCapabilityForTests("absent"); await restart();
    const { get } = makeSaleStore();
    // the first request is the 087 probe (recovery_epoch); the sale's reply is the one lost
    fake.queueModes("succeed", "commit-then-timeout");
    await get().createSale(splitSale()).catch(() => undefined);
    const [queued] = await localDb.syncOutbox.toArray();
    expect((queued.args as Record<string, unknown>).p_payments).toBeTruthy();
    await localDb.syncOutbox.toCollection().modify({ nextAttemptAt: undefined });
    await drainOutbox();
    // the queued entry keeps the split beside its key: the resend names the same split
    expect(fake.server.sales).toHaveLength(1);
    const calls = splitCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(calls.map((c) => String((c.args.p_args as Record<string, unknown>).p_idempotency_key))).size).toBe(1);
    expect(fake.server.sales).toHaveLength(1);
    expect(fake.finSplits.size).toBe(1);
  });

  it("the same key with a DIFFERENT split is refused (FIN_PAYMENTS_MISMATCH), never accepted as the original", async () => {
    fake.enableFin(); setExecutorCapabilityForTests("absent"); await restart();
    const key = newIdempotencyKey();
    const base = { p_shop_id: "shop-1", p_shift_id: "shift-1", p_cart_discount_pct: 0, p_items: [], p_created_at: new Date().toISOString(), p_idempotency_key: key };
    const a = splitSale();
    expect((await callRpc("complete_sale", { ...base, p_payment_method: a.paymentMethod, p_paid_mmk: a.paidMmk, p_payments: a.payments })).error).toBeNull();
    const b = splitSale([{ method: "CASH", amountMmk: 1000 }]);
    const second = await callRpc("complete_sale", { ...base, p_payment_method: b.paymentMethod, p_paid_mmk: b.paidMmk, p_payments: b.payments });
    expect(second.error?.message).toMatch(/FIN_PAYMENTS_MISMATCH|IDEMPOTENCY_MISMATCH/);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("the capability probe: PFIN-D present / absent; a failed probe never upgrades", async () => {
    await restart();
    expect((await finCapabilities({ refresh: true })).splitPayments).toBe(false);
    fake.enableFin();
    expect((await finCapabilities({ refresh: true })).splitPayments).toBe(true);
    fake.enableFin(false);
    expect((await finCapabilities({ refresh: true })).splitPayments).toBe(false);
  });
});

describe("PFIN-D keyed RPCs off the executor list", () => {
  it("use a v4 key (086 refuses a v7 key outside op_execute); every other RPC keeps v7", () => {
    for (const name of DIRECT_KEYED_RPCS) expect(isV4(idempotencyKeyFor(name))).toBe(true);
    expect(isV7(idempotencyKeyFor("complete_sale"))).toBe(true);
    expect(isV7(newIdempotencyKey())).toBe(true);
  });

  it("an 086 server accepts a cash movement and a close sent directly with their v4 keys", async () => {
    fake.enableFin(); fake.enableExecutor(); setExecutorCapabilityForTests("available"); await restart();
    const m = await callOnlineOnly("fin_record_cash_movement", { p_shift_id: "shift-1", p_kind: "PAY_IN", p_amount_mmk: 100, p_reason: "Float", p_reverses_id: null, p_created_at: new Date().toISOString() });
    expect(m.error).toBeNull();
    const c = await callOnlineOnly("fin_close_shift", { p_shift_id: "shift-1", p_closing_cash_mmk: 0, p_variance_reason: null, p_created_at: new Date().toISOString() });
    expect(c.error).toBeNull();
    const sent = fake.calls.filter((x) => x.name.startsWith("fin_"));
    expect(sent.map((x) => x.name)).toEqual(["fin_record_cash_movement", "fin_close_shift"]);
    for (const x of sent) expect(isV4(x.args.p_idempotency_key)).toBe(true);
    // fin_close_shift is actor-stamped like close_shift
    expect(sent[1].args.p_expected_actor_id).toBe("user-1");
    // a v7 key on the same path is refused by the server (the reason for the rule)
    const refused = await callRpc("fin_close_shift", { p_shift_id: "shift-1", p_closing_cash_mmk: 0, p_idempotency_key: newIdempotencyKey() });
    expect(refused.error?.message).toMatch(/OP_EXECUTOR_REQUIRED/);
  });
});

describe("offline header", () => {
  it("an operation recorded under an offline capability carries x-orvix-offline on every attempt (also through the split wrapper)", async () => {
    fake.enableFin(); setExecutorCapabilityForTests("absent"); await restart();
    const auth = { capabilityId: "cap-1", deviceSeq: 7 };
    const args = { p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: 1000, p_cart_discount_pct: 0, p_items: [], p_created_at: new Date().toISOString() };
    await callRpc("complete_sale", { ...args }, { offlineAuth: auth });
    const r = splitSale();
    await callRpc("complete_sale", { ...args, p_paid_mmk: r.paidMmk, p_payments: r.payments }, { offlineAuth: auth });
    const sent = fake.calls.filter((c) => c.name === "complete_sale" || c.name === SPLIT_RPC);
    expect(sent).toHaveLength(2);
    for (const c of sent) expect(JSON.parse(c.headers?.[OFFLINE_HEADER] ?? "null")).toEqual(auth);
    // an online operation carries no header
    await callRpc("complete_sale", { ...args });
    expect(fake.calls.filter((c) => c.name === "complete_sale").at(-1)?.headers?.[OFFLINE_HEADER]).toBeUndefined();
  });
});

describe("shift close and cash movements (PFIN-D)", () => {
  function shiftStore(pendingSync = false) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let state: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const set = (updater: any) => { const patch = typeof updater === "function" ? updater(state) : updater; state = { ...state, ...patch }; };
    const get = () => state;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slice = createShiftSlice(set as any, get as any, {} as any);
    state = { ...slice, sales: [], refunds: [], auditLogs: [], shifts: [{ id: "shift-1", shopId: "shop-1", cashierId: "user-1", startedAt: "t0", openingCashMmk: 0, ...(pendingSync ? { pendingSync: true } : {}) }] };
    return get;
  }

  it("a PFIN-D server: the close goes through fin_close_shift (online, v4 key, actor-stamped); the legacy close_shift is not sent", async () => {
    fake.enableFin(); fake.enableExecutor(); setExecutorCapabilityForTests("available"); await restart();
    const get = shiftStore();
    await get().endShift({ shiftId: "shift-1", closingCashMmk: 0 });
    expect(fake.calls.filter((c) => c.name === "fin_close_shift")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.name === "close_shift" || (c.name === "op_execute" && c.args.p_rpc === "close_shift"))).toHaveLength(0);
  });

  it("a server without PFIN-D: the existing close_shift path, unchanged", async () => {
    fake.enableExecutor(); setExecutorCapabilityForTests("available"); await restart();
    const get = shiftStore();
    await get().endShift({ shiftId: "shift-1", closingCashMmk: 0 });
    expect(fake.calls.filter((c) => c.name === "fin_close_shift")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.name === "op_execute" && c.args.p_rpc === "close_shift")).toHaveLength(1);
  });

  it("cash movements: online-only, keyed, refused locally when the server has no PFIN-D", async () => {
    fake.enableExecutor(); setExecutorCapabilityForTests("available"); await restart();
    const get = shiftStore();
    await expect(get().recordCashMovement({ shiftId: "shift-1", kind: "PAY_IN", amountMmk: 100, reason: "Float" })).rejects.toThrow(/PFIN-D/);
    expect(fake.calls.filter((c) => c.name.startsWith("fin_record"))).toHaveLength(0);
    fake.enableFin(); resetFinCapabilitiesForTests();
    const r = await get().recordCashMovement({ shiftId: "shift-1", kind: "REVERSAL", amountMmk: 999, reason: "Wrong shift", reversesId: "cm-1" });
    expect(r).toEqual({ expectedCashMmk: 0 });
    const [sent] = fake.calls.filter((c) => c.name === "fin_record_cash_movement");
    expect(sent.args).toMatchObject({ p_kind: "REVERSAL", p_amount_mmk: null, p_reverses_id: "cm-1", p_reason: "Wrong shift" });
    expect(isV4(sent.args.p_idempotency_key)).toBe(true);
  });

  it("offline on a PFIN-D server: no close is queued (its figure cannot be known here); on an older server the legacy close is queued as before", async () => {
    fake.enableFin(); setExecutorCapabilityForTests("absent"); await restart();
    resetRecoveryStateForTests();                 // a pre-087 server (the v87.x offline rule does not apply)
    await finCapabilities({ refresh: true });     // learnt while connected
    vi.stubGlobal("navigator", { onLine: false });
    await expect(shiftStore()().endShift({ shiftId: "shift-1", closingCashMmk: 0 })).rejects.toThrow(/connected/);
    expect(await localDb.syncOutbox.count()).toBe(0);
    vi.stubGlobal("navigator", { onLine: true });
    fake.enableFin(false); await restart(); resetRecoveryStateForTests(); await finCapabilities({ refresh: true });
    vi.stubGlobal("navigator", { onLine: false });
    await shiftStore()().endShift({ shiftId: "shift-1", closingCashMmk: 0 });
    expect((await localDb.syncOutbox.toArray()).map((r) => r.name)).toEqual(["close_shift"]);
  });
});

describe("refund lines reach the server (PFIN-E)", () => {
  it("a refund request sends each item's sale line, restock choice and payouts verbatim", async () => {
    fake.enableFin(); fake.enableExecutor(); setExecutorCapabilityForTests("available"); await restart();
    const { get } = makeSaleStore();
    get().sales.push({ id: "sale-9", shopId: "shop-1", shiftId: "shift-1", receiptNo: "R-9", cashierId: "user-1", status: "NORMAL",
      subtotalMmk: 1000, discountMmk: 0, totalMmk: 1000, paymentMethod: "CASH", paidMmk: 1000, changeMmk: 0, createdAt: new Date().toISOString() });
    await get().requestRefund({ saleId: "sale-9", reason: "Damaged", actorId: "user-1", items: [{
      productId: "p1", qtyUnits: 1, amountMmk: 1000,
      lines: [{ saleItemId: "si-9", qtyUnits: 1, amountMmk: 1000, restock: false }],
      payouts: [{ method: "CARD", amountMmk: 1000 }],
    }] });
    const sent = fake.calls.filter((c) => c.name === "op_execute" && c.args.p_rpc === "create_refund_void_request");
    expect(sent).toHaveLength(1);
    expect((sent[0].args.p_args as Record<string, unknown>).p_items).toEqual([{
      productId: "p1", qtyUnits: 1, amountMmk: 1000,
      lines: [{ saleItemId: "si-9", qtyUnits: 1, amountMmk: 1000, restock: false }],
      payouts: [{ method: "CARD", amountMmk: 1000 }],
    }]);
  });
});
