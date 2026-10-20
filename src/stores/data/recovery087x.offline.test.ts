import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// v87.x emergency safeguard: NO new offline financial operations on a server with migration 087 (or one whose 087
// status is not established). Driven through the REAL sale slice, write-ahead engine, outbox, table writes, online-only
// operations and recovery state against the fake server's 087 emulation (testing/fakeSupabase.ts).
// Contract: docs/selfhost-migration/phase-g/v87-client.md ("Offline financial operations (v87.x)").
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" };
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => acting } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb, type SyncOutboxEntry } from "../../lib/localDb";
import { createSaleSlice } from "./slices/saleSlice";
import { drainOutbox, enqueueOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "./outbox";
import { registerOperationPrompt } from "./operationPrompt";
import { callOnlineOnly, resetOnlineOnlyForTests } from "./onlineOnly";
import { resetWriteAheadForTests, submitOfflineCapable, PendingConfirmationError } from "./writeAhead";
import { beginOperation, setExecutorCapabilityForTests } from "./idempotentRpc";
import { getJournalRecord, listJournal } from "./opJournal";
import {
  isRecoveryBlocked, loadRecoveryState, recoveryView, resetRecoveryStateForTests, storeTillCredential, simulatePreV87xClientForTests,
  OFFLINE_FINANCIAL_DISABLED, recoveryCapability, ageAuthorizationForTests, verifiedWithin, ABSENT_OFFLINE_TRUST_MS,
} from "./recoveryState";
import { refreshRecoveryEpoch } from "./recovery87";
import { FRESH_AUTHORIZATION_MS, resetRecoveryGateForTests } from "./recoveryGate";
import { writeTableRow } from "./tableWrite";

const restart = async () => {
  simulateNewAppInstanceForTests();
  resetWriteAheadForTests();
  resetOnlineOnlyForTests();
  resetRecoveryStateForTests(null);                 // a new process / window: nothing in memory, state read from disk
  resetRecoveryGateForTests();
  await loadRecoveryState(acting.currentOrgId);
};

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
    getInventoryQty: (shopId: string, productId: string) =>
      state.inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits ?? 0,
    shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 100 }],
    ...slice,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}
const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can", qty: 1, unitPriceMmk: 1000, unitsPerItem: 1,
  unitBaseQuantity: 1, priceLevelId: "pl-retail", ...over,
});
const saleInput = (shiftId = "shift-1") => ({ shopId: "shop-1", cashierId: "user-1", shiftId, cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000, cartItems: [cartItem()] });
const rows = async () => (await localDb.syncOutbox.toArray()) as (SyncOutboxEntry & { seq?: number })[];
const online = (on: boolean) => vi.stubGlobal("navigator", { onLine: on });
const v87Calls = () => fake.calls.filter((c) => c.name === "op_execute_v87");
const blockedOffline = (err: unknown) => isRecoveryBlocked(err) && (err as { code: string }).code === OFFLINE_FINANCIAL_DISABLED;

async function normalTill(): Promise<void> {
  const tillId = recoveryView().tillId;
  const secret = fake.register87Till(tillId, { reconciled: true });
  await storeTillCredential({ orgId: "org-1", secret });
  expect((await refreshRecoveryEpoch({ shopId: "shop-1" })).kind).toBe("issued");
}
async function nothingCreated(): Promise<void> {
  expect(await rows()).toHaveLength(0);
  expect(await localDb.sales.count()).toBe(0);
  expect((await listJournal({ orgId: "org-1" })).records).toHaveLength(0);
}

beforeEach(async () => {
  fake.reset();
  fake.enable087();
  fake.enableExecutor();   // 086 (op_status lookups) — a prerequisite of every real 087 server
  fake.setCaller("user-1", false, "org-1");
  setExecutorCapabilityForTests("available");
  acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" };
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  online(true);
  await restart();
});
afterEach(() => {
  simulatePreV87xClientForTests(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

describe("v87.x: which servers", () => {
  it("a server WITHOUT 087 (explicit PGRST202 answer): the pre-087 offline rules are unchanged — an offline sale is queued", async () => {
    fake.enable087(false);
    await restart();
    expect((await refreshRecoveryEpoch()).kind).toBe("legacy-server");
    online(false);
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", name: "complete_sale" });
  });

  it("a server whose 087 status was never established (fresh install / upgrade from a pre-087 client) and the till offline: refused (fail closed)", async () => {
    expect(recoveryCapability()).toBe("unknown");
    online(false);
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    await nothingCreated();
  });

  it("review fix: an OLD 'no 087' answer (the till has not reached the server for longer than ABSENT_OFFLINE_TRUST_MS — 087 may have been installed meanwhile): offline refused", async () => {
    fake.enable087(false);
    resetRecoveryStateForTests(null);
    await restart();
    expect((await refreshRecoveryEpoch()).kind).toBe("legacy-server");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ABSENT_OFFLINE_TRUST_MS + 60_000);
    online(false);
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(blockedOffline(err)).toBe(true);
    await nothingCreated();
    online(true);                                                            // back online: the server says again "no 087" -> pre-087 rules
    await get().createSale(saleInput());
    expect(fake.callsFor("recovery_epoch").length).toBeGreaterThan(1);
  });

  it("review fix: a fresh authorisation is bound to the organisation (another organisation signed in within the window is NOT authorised by it)", async () => {
    await normalTill();
    expect(verifiedWithin(FRESH_AUTHORIZATION_MS)).toBe(true);
    acting = { currentUserId: "user-2", currentOrgId: "org-2", currentRole: "CASHIER" };
    await loadRecoveryState("org-2");
    expect(verifiedWithin(FRESH_AUTHORIZATION_MS)).toBe(false);
    acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" };
    await loadRecoveryState("org-1");
    expect(verifiedWithin(FRESH_AUTHORIZATION_MS)).toBe(true);
  });

  it("unknown status, online, but the server cannot be reached: refused (an unreachable server is never taken for a pre-087 one)", async () => {
    fake.queueModes("network-error", "network-error", "network-error");   // every request of this attempt fails
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(recoveryCapability()).toBe("unknown");
    await nothingCreated();
  });

  it("087 rolled back / removed on the server after the till saw it: the capability stays 'present' — offline still refused, online the server cannot confirm the till", async () => {
    await normalTill();
    fake.enable087(false);
    await restart();
    expect(recoveryCapability()).toBe("present");
    online(false);
    const { get } = makeSaleStore();
    expect(blockedOffline(await get().createSale(saleInput()).catch((e) => e))).toBe(true);
    online(true);
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    await nothingCreated();
  });
});

describe("v87.x: fresh server authorisation before every new financial operation", () => {
  it("authorised less than FRESH_AUTHORIZATION_MS ago: the sale goes straight through; older: the server is asked first", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    const asked0 = fake.callsFor("recovery_epoch").length;
    await get().createSale(saleInput());
    expect(fake.callsFor("recovery_epoch")).toHaveLength(asked0);
    ageAuthorizationForTests(FRESH_AUTHORIZATION_MS + 1_000);   // monotonic clock: the authorisation is now too old
    await get().createSale(saleInput());
    const names = fake.calls.map((c) => c.name);
    expect(names.lastIndexOf("recovery_epoch")).toBeLessThan(names.lastIndexOf("op_execute_v87"));
    expect(fake.callsFor("recovery_epoch")).toHaveLength(asked0 + 1);
    expect(fake.server.sales).toHaveLength(2);
  });

  it("a stale authorisation and the server unreachable (navigator says online): refused, nothing saved — a temporary network failure authorises nothing", async () => {
    await normalTill();
    ageAuthorizationForTests(FRESH_AUTHORIZATION_MS + 1_000);   // monotonic clock: the authorisation is now too old
    fake.queueModes("network-error");
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(blockedOffline(err)).toBe(true);
    expect(String(err.message)).toMatch(/The server could not be reached\./);
    await nothingCreated();
    expect(v87Calls()).toHaveLength(0);
  });

  it("a restart (Electron relaunch / reload) with a valid epoch on disk and the till OFFLINE: refused — a stale epoch never authorises an offline sale", async () => {
    await normalTill();
    online(false);
    await restart();
    expect(recoveryView().mode).toBe("normal");                              // the stored state looks fine ...
    const { get } = makeSaleStore();
    expect(blockedOffline(await get().createSale(saleInput()).catch((e) => e))).toBe(true);   // ... but nothing is created
    await nothingCreated();
  });

  it("a restart ONLINE: the server is asked before the first sale (then it goes through)", async () => {
    await normalTill();
    await restart();
    const asked0 = fake.callsFor("recovery_epoch").length;
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    expect(fake.callsFor("recovery_epoch").length).toBeGreaterThan(asked0);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("a second window (separate process memory, same storage): offline refused; online it needs its OWN authorisation", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());                                     // window 1 is authorised and sells
    await restart();                                                         // window 2: nothing in memory
    online(false);
    expect(blockedOffline(await get().createSale(saleInput()).catch((e) => e))).toBe(true);
    online(true);
    const asked0 = fake.callsFor("recovery_epoch").length;
    await get().createSale(saleInput());
    expect(fake.callsFor("recovery_epoch").length).toBeGreaterThan(asked0);
  });
});

describe("v87.x: a sale that cannot reach the server is never turned into an offline sale", () => {
  it("the request definitely did not arrive (connection refused): the attempt is discarded, nothing queued, the cashier told 'not recorded'", async () => {
    await normalTill();
    fake.queueModes("not-delivered");
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(blockedOffline(err)).toBe(true);
    expect(String(err.message)).toMatch(/did not arrive/);
    expect(await rows()).toHaveLength(0);
    expect(await localDb.sales.count()).toBe(0);
    const { records } = await listJournal({ orgId: "org-1" });
    expect(records.every((r) => r.state !== "committed" && r.state !== "never-sent")).toBe(true);   // evidence kept, never "recorded"
    expect(fake.server.sales).toHaveLength(0);
  });

  it("the reply was lost (outcome unknown): 'pending confirmation' — never 'recorded' — kept with its ORIGINAL key, confirmed later", async () => {
    await normalTill();
    fake.queueModes("commit-then-timeout");
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(err).toBeInstanceOf(PendingConfirmationError);
    expect(String(err.message)).toMatch(/^Not recorded on this till: the server did not answer/);   // never "Sale recorded"
    expect(String(err.message)).not.toMatch(/Sale recorded/i);
    const [row] = await rows();
    expect(row.inDoubt).toBe(true);
    const key = row.idempotencyKey!;
    expect((await getJournalRecord(key))?.state).not.toBe("committed");
    expect(row.fenceRequired).toBe(true);                                    // v87.x: HELD — never staged, never resent automatically
    expect(row.status).toBe("conflict");
    await drainOutbox();                                                     // the server is ASKED (same key): it has it
    expect(fake.server.sales).toHaveLength(1);
    expect((await getJournalRecord(key))?.state).toBe("committed");
  });

  it("review fix: 'Failed to fetch' (outcome unknown) INSIDE the fresh-authorisation window, navigator online: held for confirmation — never staged, never shown, never resent; the next sale must reach the server first", async () => {
    await normalTill();
    fake.queueModes("network-error");                                        // Chromium: TypeError: Failed to fetch -> UNKNOWN_OUTCOME
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(err).toBeInstanceOf(PendingConfirmationError);
    expect(String(err.message)).not.toMatch(/Sale recorded/i);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "conflict", fenceRequired: true, staged: false, inDoubt: true });
    expect(await localDb.sales.count()).toBe(0);                             // not applied to the till's local state
    expect(verifiedWithin(FRESH_AUTHORIZATION_MS)).toBe(false);
    const asked = fake.callsFor("recovery_epoch").length;
    fake.queueModes("network-error");                                        // the server still unreachable: the next sale is refused
    const err2 = await get().createSale(saleInput()).catch((e) => e);
    expect(blockedOffline(err2)).toBe(true);
    expect(fake.callsFor("recovery_epoch").length).toBe(asked + 1);
    expect(await rows()).toHaveLength(1);                                    // only the held one
    expect(fake.server.sales).toHaveLength(0);
  });

  it("a sale that depends on an entry the previous build queued offline (a shift opened offline): refused, nothing saved", async () => {
    await normalTill();
    online(false);
    simulatePreV87xClientForTests(true);
    const op = beginOperation();
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-1", p_opening_cash_mmk: 0 }, idempotencyKey: op.idempotencyKey,
      shopId: "shop-1", opEpoch: op.opEpoch, provisional: [{ table: "shifts", ids: ["shift-local-1"] }] });
    simulatePreV87xClientForTests(false);
    online(true);
    const before = (await rows()).length;
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput("shift-local-1")).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect((await rows()).length).toBe(before);                              // the earlier entry kept, nothing added
  });

  it("an operation that would have to queue behind earlier unsent entries: refused (never queued on an 087 server)", async () => {
    await normalTill();
    online(false);
    simulatePreV87xClientForTests(true);
    const { get } = makeSaleStore();
    await get().createSale(saleInput());                                     // the previous build's queued sale on shift-1
    simulatePreV87xClientForTests(false);
    online(true);
    fake.queueModes("network-error");                                        // keep it unsent while the close is attempted
    const op = beginOperation();
    const err = await submitOfflineCapable({
      set: () => undefined, name: "close_shift", shopId: "shop-1", op, args: { p_shift_id: "shift-1", p_closing_cash_mmk: 0 },
      applyOnline: () => "applied", stage: async () => "staged",
    }).catch((e) => e);
    expect(blockedOffline(err)).toBe(true);
    expect((await rows()).map((r) => r.name)).toEqual(["complete_sale"]);   // the earlier one kept unchanged; nothing added
  });
});

describe("v87.x: the other entry points", () => {
  it("a table write (category / price tier / shop / user / supplier) offline on an 087 server: not saved, not queued", async () => {
    await normalTill();
    online(false);
    const { error } = await writeTableRow({ table: "categories", op: "insert", row: { id: "cat-1", name: "X" }, appRow: { id: "cat-1", name: "X" }, id: "cat-1" });
    expect(String(error?.message)).toMatch(/^Not recorded — nothing was saved\./);
    expect(await rows()).toHaveLength(0);
    expect(await localDb.categories.count()).toBe(0);
  });

  it("review fix: a table write whose reply was lost (timeout / 'Failed to fetch') on an 087 server is NOT reported as 'nothing was saved' — and never queued", async () => {
    await normalTill();
    const { supabase } = await import("../../lib/supabase");
    const lost = { data: null, status: 0, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } };
    const chain = { select: () => chain, eq: () => chain, then: (ok: (v: unknown) => unknown) => Promise.resolve(lost).then(ok) };
    const spy = vi.spyOn(supabase, "from").mockImplementation(((table: string) => {
      if (table !== "categories") throw new Error("unexpected table");
      return { insert: () => chain, update: () => chain, delete: () => chain };
    }) as never);
    const { error } = await writeTableRow({ table: "categories", op: "insert", row: { id: "cat-1", name: "X" }, appRow: { id: "cat-1", name: "X" }, id: "cat-1" });
    spy.mockRestore();
    expect(String(error?.message)).toMatch(/^Not confirmed — the server did not answer, so this change may or may not have been saved\./);
    expect(String(error?.message)).not.toMatch(/nothing was saved/);
    expect(await rows()).toHaveLength(0);
    expect(verifiedWithin(FRESH_AUTHORIZATION_MS)).toBe(false);              // the next operation must reach the server first
  });

  it("the generic queue refuses a NEW entry on an 087 server (shared layer, whoever calls it)", async () => {
    await normalTill();
    const op = beginOperation();
    const err = await enqueueOutbox({ kind: "rpc", name: "adjust_stock", args: {}, idempotencyKey: op.idempotencyKey, shopId: "shop-1", opEpoch: op.opEpoch })
      .catch((e) => e);
    expect(blockedOffline(err)).toBe(true);
    expect(await rows()).toHaveLength(0);
  });

  it("an online-only operation (refund approval, supplier payment, lump sum, ...) offline: refused before anything is saved", async () => {
    await normalTill();
    online(false);
    const err = await callOnlineOnly("record_supplier_payment", { p_purchase_order_id: "po-1", p_amount_mmk: 100 }).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(fake.calls.filter((c) => c.name === "op_execute_v87")).toHaveLength(0);
  });

  it("another organisation on the same 087 backend: offline refused for it as well", async () => {
    await normalTill();
    acting = { currentUserId: "user-2", currentOrgId: "org-2", currentRole: "CASHIER" };
    fake.setCaller("user-2", false, "org-2");
    await restart();
    online(false);
    const { get } = makeSaleStore();
    const err = await get().createSale({ ...saleInput(), cashierId: "user-2" }).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(await rows()).toHaveLength(0);
  });
});

describe("v87.x: queues the previous build left are preserved", () => {
  it("existing queued sales keep their key, epoch and arguments; they are sent automatically only after a fresh authorisation", async () => {
    await normalTill();
    online(false);
    simulatePreV87xClientForTests(true);
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    simulatePreV87xClientForTests(false);
    const [before] = await rows();
    await restart();                                                         // the patched build starts
    online(true);
    const [after] = await rows();
    expect(after).toMatchObject({ idempotencyKey: before.idempotencyKey, opEpoch: before.opEpoch, args: before.args });
    expect(await drainOutbox()).toBe("drained");
    expect(fake.server.sales).toHaveLength(1);
    expect((v87Calls()[0].args.p_ctx as Record<string, unknown>).op_epoch).toBe(before.opEpoch);
  });
});
