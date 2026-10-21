import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// W8/W10 Phase 0 — the till's operation journal, no automatic fencing, and
// the continuity evidence, driven through the REAL sale slice, write-ahead
// engine, outbox and drain against the fake 086 server (testing/fakeSupabase).
// A "restore" puts the fake server's ledger and sales back to an earlier copy.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let actingUser = "user-1";
let actingOrg = "org-1";
let actingRole = "CASHIER";
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: actingUser, currentOrgId: actingOrg, currentRole: actingRole }) } };
});

import { fakeSupabase as fake, type FakeServerState } from "./testing/fakeSupabase";
import { localDb, type SyncOutboxEntry } from "../../lib/localDb";
import { createSaleSlice } from "./slices/saleSlice";
import { drainOutbox, enqueueOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests, stopOnServer } from "./outbox";
import { registerOperationPrompt } from "./operationPrompt";
import { callOnlineOnly, checkOnlineOperation, listUnresolvedOnlineOperations, resetOnlineOnlyForTests } from "./onlineOnly";
import { resetWriteAheadForTests } from "./writeAhead";
import { callRpc, setExecutorCapabilityForTests } from "./idempotentRpc";
import { registerVerifiedReload } from "./verifiedReload";
import {
  acknowledgeContinuity, backfillJournal, categoryOf, continuityWarning, getJournalRecord, journalSummary, listJournal, listVanished,
  vanishedRows, JOURNAL_PREFIX, type JournalRecord,
} from "./opJournal";
import { persistSnapshotToLocal, type LocalSnapshot } from "./localSync";
import { collectQueueExport } from "../../lib/queueExport/collect";

const restart = () => {
  simulateNewAppInstanceForTests();
  resetWriteAheadForTests();
  resetOnlineOnlyForTests();
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSaleStore(seed: Record<string, any> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => { const patch = typeof updater === "function" ? updater(state) : updater; state = { ...state, ...patch }; };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createSaleSlice(set as any, get as any, {} as any);
  state = {
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }],
    products: [{ id: "p1", isNonStock: false }],
    getProductPrice: () => 0,
    getInventoryQty: (shopId: string, productId: string) =>
      state.inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits ?? 0,
    shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 10 }],
    ...slice,
    ...seed,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}
const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can",
  qty: 2, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: "pl-retail", ...over,
});
const saleInput = (over: Record<string, unknown> = {}) => ({
  shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000,
  cartItems: [cartItem()], ...over,
});
const rows = () => localDb.syncOutbox.toArray();
const journal = async (): Promise<JournalRecord[]> => (await listJournal()).records;

/** A copy of the fake server's state (a "backup"), and putting it back (a "restore"). */
const backupServer = (): FakeServerState => ({
  ...fake.server, sales: fake.server.sales.map((s) => ({ ...s })), payments: fake.server.payments.map((p) => ({ ...p })),
  shifts: [...fake.server.shifts], inventory: new Map(fake.server.inventory), purchaseOrders: new Map(fake.server.purchaseOrders),
  idempotency: new Map([...fake.server.idempotency].map(([k, v]) => [k, { ...v }])), executions: { ...fake.server.executions },
});
const restoreServer = (b: FakeServerState) => {
  const s = fake.server;
  s.sales.splice(0, s.sales.length, ...b.sales.map((x) => ({ ...x })));
  s.payments.splice(0, s.payments.length, ...b.payments);
  s.idempotency.clear();
  for (const [k, v] of b.idempotency) s.idempotency.set(k, { ...v });
  s.inventory.clear();
  for (const [k, v] of b.inventory) s.inventory.set(k, v);
};

const emptySnapshot = (over: Partial<LocalSnapshot> = {}): LocalSnapshot => ({
  shops: [{ id: "shop-1", name: "Main" }] as never, users: [], categories: [], brands: [], unitTypes: [], products: [], productUnits: [], barcodes: [],
  priceTiers: [], priceLevels: [], productUnitPrices: [], inventory: [], movements: [], suppliers: [], purchaseOrders: [],
  purchaseOrderItems: [], supplierPayments: [], supplierProducts: [], stockTransfers: [], stockTransferItems: [], shifts: [],
  sales: [], saleItems: [], reprintLogs: [], refunds: [], auditLogs: [], businessProfile: null, ...over,
} as LocalSnapshot);
const scopeA = { userId: "user-1", role: "CASHIER", orgId: "org-1" };
const serverSale = (id: string, createdAt: string, shopId = "shop-1") => ({ id, shopId, shiftId: "shift-1", cashierId: "user-1", receiptNo: `R-${id}`, status: "COMPLETED", totalMmk: 2000, paidMmk: 5000, changeMmk: 3000, createdAt }) as never;

beforeEach(async () => {
  fake.reset();
  fake.enableExecutor();
  setExecutorCapabilityForTests("available");
  restart();
  actingUser = "user-1"; actingOrg = "org-1"; actingRole = "CASHIER";
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  vi.stubGlobal("navigator", { onLine: true });
  registerVerifiedReload(async () => true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  registerOperationPrompt(null);
});

describe("journal coverage: kept after acknowledgement, with the server's own reply", () => {
  it("an online sale: committed reply stored; the queue row is gone, the journal record stays", async () => {
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    expect(await rows()).toHaveLength(0);
    const [j] = await journal();
    expect(j).toMatchObject({ rpc: "complete_sale", source: "outbox", state: "committed", orgId: "org-1", actorId: "user-1", sends: 1 });
    expect(j.evidence).toMatchObject({ source: "reply" });
    expect((j.evidence?.response as { sale: { id: string } }).sale.id).toBe(fake.server.sales[0].id);
    expect(j.args?.p_idempotency_key).toBe(j.key);
    expect(categoryOf(j.state)).toBe("confirmed-committed");
    expect(fake.server.sales).toHaveLength(1);
  });

  it("LOST SERVER ACKNOWLEDGEMENT: committed, reply lost -> unknown; the next drain resends the SAME key -> committed from the ledger (once)", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("commit-then-timeout");
    await expect(get().createSale(saleInput())).rejects.toThrow(/Pending confirmation|confirm/i);
    const [j0] = await journal();
    expect(j0.state).toBe("unknown");
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);                         // never twice
    const [j] = await journal();
    expect(j).toMatchObject({ key: j0.key, state: "committed" });
    expect(j.sends).toBeGreaterThanOrEqual(2);
  });

  it("NEVER-SENT offline sale: journaled as never sent, then sent and committed with its key", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    expect((await journal())[0]).toMatchObject({ state: "never-sent", sends: 0 });
    expect(categoryOf("never-sent")).toBe("never-sent");
    vi.stubGlobal("navigator", { onLine: true });
    await drainOutbox();
    expect((await journal())[0]).toMatchObject({ state: "committed", sends: 1 });
    expect(fake.server.sales).toHaveLength(1);
  });

  it("REJECTED at the counter: the queue row is discarded, the journal keeps the refusal (recorded in the server's ledger)", async () => {
    const { get } = makeSaleStore();
    fake.queueModes("permanent-error");
    await expect(get().createSale(saleInput())).rejects.toThrow(/Insufficient stock/);
    expect(await rows()).toHaveLength(0);
    const [j] = await journal();
    expect(j).toMatchObject({ state: "rejected", evidence: { recordedOnServer: true } });
    expect(j.evidence?.message).toMatch(/Insufficient stock/);
    expect(fake.server.sales).toHaveLength(0);
  });

  it("ABANDONED (stopped on the server) is a confirmed outcome; a later resend of that key never executes", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0, p_items: [{ product_id: "p1", qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString() }, shopId: "shop-1" });
    const [row] = await rows();
    await localDb.syncOutbox.update(row.localId, { status: "conflict", fenceRequired: true, staged: false, inDoubt: true });
    await drainOutbox();
    actingRole = "ADMIN";
    expect(await stopOnServer(row.localId, "owner: the receipt was never printed")).toBe("abandoned");
    const j = await getJournalRecord(row.idempotencyKey!);
    // "stopped by this till" — proves "not on this server", never "it never ran"
    expect(j).toMatchObject({ state: "abandoned", evidence: { source: "lookup", recordedOnServer: true, fencedByTill: true, fencedFor: "owner" } });
    expect(categoryOf("abandoned")).toBe("confirmed-not-applied");
    expect((await callRpc("complete_sale", row.args!)).serverOutcome).toBe("abandoned");
    expect(fake.server.sales).toHaveLength(0);
  });

  it("online-only supplier payment (lump sum): created, attempt, applied — the reply is journaled; never deleted", async () => {
    fake.server.purchaseOrders.set("po-1", { id: "po-1", totalMmk: 10000, paidMmk: 0 });
    const out = await callOnlineOnly("pay_supplier_lump_sum", { p_supplier_id: "sup-1", p_shop_id: "shop-1", p_amount_mmk: 3000, p_payment_method: "CASH" }, { retries: 0 });
    expect(out.error).toBeNull();
    const [j] = await journal();
    expect(j).toMatchObject({ rpc: "pay_supplier_lump_sum", source: "online-only", state: "committed", sends: 1 });
    expect(j.evidence?.response).toBeTruthy();
  });

  it("online-only, outcome unknown, then the server has no record of it: reconciliation required, nothing stopped", async () => {
    fake.queueModes("network-error");
    const out = await callOnlineOnly("pay_supplier_lump_sum", { p_supplier_id: "sup-1", p_shop_id: "shop-1", p_amount_mmk: 3000, p_payment_method: "CASH" }, { retries: 0 });
    expect(out.error?.name).toBe("PendingConfirmationError");
    const [op] = await listUnresolvedOnlineOperations();
    await checkOnlineOperation(op.id);
    const [j] = await journal();
    expect(j.state).toBe("reconciliation-required");
    expect(fake.server.idempotency.size).toBe(0);
  });
});

describe("W10: no automatic fence when prior execution cannot be disproved", () => {
  it("BACKUP RESTORED BEFORE A COMMITTED SALE: the till keeps the committed evidence; an in-doubt sale lost by the restore is never fenced", async () => {
    fake.server.inventory.set("shop-1:p1", 100);                       // real stock on the server
    const { get } = makeSaleStore();
    const backup = backupServer();                                     // the backup is taken
    await get().createSale(saleInput());                               // sale A: committed, acknowledged
    fake.queueModes("commit-then-timeout");
    await expect(get().createSale(saleInput({ cartItems: [cartItem({ qty: 1 })] }))).rejects.toThrow();   // sale B: committed, reply lost
    expect(fake.server.sales).toHaveLength(2);
    const [a, b] = await journal();
    restoreServer(backup);                                             // the server is restored: both are gone
    expect(fake.server.sales).toHaveLength(0);
    // W8: A's evidence survives (the queue row was deleted long ago)
    expect(await getJournalRecord(a.key)).toMatchObject({ state: "committed" });
    // B: authorised offline (staged) — resent with its key; on THIS server it
    // executes again under the same key (one sale), never with a new key
    restart();
    makeSaleStore();
    await drainOutbox();
    expect(await getJournalRecord(b.key)).toMatchObject({ state: "committed" });
    expect(fake.server.sales.filter((s) => s.idempotencyKey === b.key)).toHaveLength(1);
    expect(fake.server.sales.filter((s) => s.idempotencyKey === a.key)).toHaveLength(0);   // never re-sent by the till
    expect(fake.calls.filter((c) => c.name === "op_status" && c.args.p_fence === true)).toHaveLength(0);
  });

  it("an attempt NEVER authorised offline, lost by a restore: looked up, NOT fenced, held for an owner — a late copy can still record it (once)", async () => {
    const { get } = makeSaleStore({ inventory: [] });                   // offline rules refuse it -> held, never staged
    const backup = backupServer();
    fake.queueModes("commit-then-timeout");
    await expect(get().createSale(saleInput())).rejects.toThrow();
    const [row] = await rows();
    expect(row).toMatchObject({ fenceRequired: true });
    restoreServer(backup);                                             // the commit is lost
    restart();
    makeSaleStore({ inventory: [] });
    expect(await drainOutbox()).toBe("backoff");
    expect(fake.calls.filter((c) => c.name === "op_status").every((c) => c.args.p_fence === false)).toBe(true);
    expect(fake.server.idempotency.has(row.idempotencyKey!)).toBe(false);
    expect((await rows())[0]).toMatchObject({ heldReason: "reconciliation-required" });
    expect(await getJournalRecord(row.idempotencyKey!)).toMatchObject({ state: "reconciliation-required" });
    expect(fake.server.sales).toHaveLength(0);
  });

  it("MULTIPLE TILLS: each till keeps its own evidence; one till's held entry never stops another till's sale", async () => {
    // till A
    const tillA = makeSaleStore();
    await tillA.get().createSale(saleInput());
    // the operation history goes only into the OWNER's export (a staff export carries pending work only)
    const staffA = await collectQueueExport(localDb, { appVersion: "t", tillId: "till-a", backendHost: "h", session: { userId: "user-1", orgId: "org-1", shopId: null, role: "CASHIER" } });
    expect(staffA.journal).toHaveLength(0);
    const exportA = await collectQueueExport(localDb, { appVersion: "t", tillId: "till-a", backendHost: "h", session: { userId: "admin-1", orgId: "org-1", shopId: null, role: "ADMIN" } });
    expect(exportA.journal).toHaveLength(1);
    // till B (another device: its own database)
    await Promise.all(localDb.tables.map((t) => t.clear()));
    restart();
    actingUser = "user-2"; fake.setCaller("user-2");
    const tillB = makeSaleStore();
    await tillB.get().createSale(saleInput({ cashierId: "user-2" }));
    const j = await journal();
    expect(j).toHaveLength(1);
    expect(j[0].actorId).toBe("user-2");
    expect(fake.server.sales).toHaveLength(2);
    expect(new Set(fake.server.sales.map((s) => s.idempotencyKey)).size).toBe(2);
  });

  it("APP RESTART during reconciliation: the held entry and its journal record survive; the next pass looks it up again, read-only", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0, p_items: [{ product_id: "p1", qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString() }, shopId: "shop-1" });
    const [row] = await rows();
    await localDb.syncOutbox.update(row.localId, { status: "syncing", writeAhead: true, attempts: 0, syncingSince: new Date(0).toISOString() });
    restart();
    await drainOutbox();
    restart();
    await localDb.syncOutbox.update(row.localId, { nextAttemptAt: undefined });
    await drainOutbox();
    expect(fake.calls.filter((c) => c.name === "op_status").map((c) => c.args.p_fence)).toEqual([false, false]);
    expect(await getJournalRecord(row.idempotencyKey!)).toMatchObject({ state: "reconciliation-required" });
    expect(fake.calls.filter((c) => c.name === "op_execute")).toHaveLength(0);
  });
});

describe("storage failures and damaged records never let a financial operation continue silently", () => {
  const quota = () => Object.assign(new Error("QuotaExceededError: the quota has been exceeded"), { name: "QuotaExceededError" });

  it("IndexedDB QUOTA when the journal record is written: nothing is saved and NOTHING is sent", async () => {
    const put = IDBObjectStore.prototype.put;
    let failures = 0;
    // Fault the actual storage boundary, including transaction-bound Dexie tables.
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "syncState" && (value as { key?: string }).key?.startsWith(JOURNAL_PREFIX)) {
        failures += 1;
        throw quota();
      }
      return put.call(this, value, key);
    });
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toThrow(/Not saved and nothing was sent|quota/i);
    expect(fake.calls.filter((c) => c.name === "op_execute" || c.name === "complete_sale")).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    expect(failures).toBe(1);
    // offline: the staging fails as a whole (nothing queued)
    vi.stubGlobal("navigator", { onLine: false });
    await expect(get().createSale(saleInput())).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    expect(failures).toBe(2);
  });

  it("QUOTA when a COMMITTED sale is acknowledged: the queue row is kept (not deleted), the sale is not reported failed, and it is confirmed later with its key — once", async () => {
    const { get } = makeSaleStore();
    const put = IDBObjectStore.prototype.put;
    let fail = false;
    let failures = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const row = value as { key?: string; value?: string };
      if (fail && this.name === "syncState" && row.key?.startsWith(JOURNAL_PREFIX) && (row.value ?? "").includes('"committed"')) {
        failures += 1;
        throw quota();
      }
      return put.call(this, value, key);
    });
    fail = true;
    await get().createSale(saleInput());                               // resolves: the server committed it
    expect(await rows()).toHaveLength(1);                              // kept for confirmation
    expect(failures).toBeGreaterThan(0);
    fail = false;
    restart();
    makeSaleStore();
    await drainOutbox();
    expect(await rows()).toHaveLength(0);
    expect((await journal())[0].state).toBe("committed");
    expect(fake.server.sales).toHaveLength(1);
  });

  it("a DAMAGED journal record is never overwritten (kept beside), never acted on; a MISSING one is rebuilt from the queue row (backfilled)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    const [row] = await rows();
    await localDb.syncState.put({ key: JOURNAL_PREFIX + row.idempotencyKey, value: "{not json", updatedAt: new Date().toISOString() });
    vi.stubGlobal("navigator", { onLine: true });
    await drainOutbox();
    const { records, damaged } = await listJournal();
    expect(damaged.some((k) => k.startsWith(`${JOURNAL_PREFIX}damaged:${row.idempotencyKey}`))).toBe(true);
    expect(records.find((r) => r.key === row.idempotencyKey)).toMatchObject({ state: "committed", backfilled: true });
    expect(fake.server.sales).toHaveLength(1);
    // missing: rebuilt by the startup backfill from what is still queued
    vi.stubGlobal("navigator", { onLine: false });
    await makeSaleStore().get().createSale(saleInput({ cartItems: [cartItem({ qty: 1 })] }));
    const pending = (await rows())[0];
    await localDb.syncState.delete(JOURNAL_PREFIX + pending.idempotencyKey);
    expect(await backfillJournal(async () => [])).toBe(1);
    expect(await getJournalRecord(pending.idempotencyKey!)).toMatchObject({ state: "never-sent", backfilled: true });
    expect(await backfillJournal(async () => [])).toBe(0);            // idempotent
  });

  it("MULTI-WINDOW: concurrent updates of one record (two windows) lose nothing (one transaction each)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    const [row] = await rows();
    const { journalOwner } = await import("./opJournal");
    await Promise.all(Array.from({ length: 12 }, (_, i) => localDb.transaction("rw", localDb.syncState, () => journalOwner(row as SyncOutboxEntry, `window-${i}`))));
    const j = await getJournalRecord(row.idempotencyKey!);
    expect(new Set(j!.events.filter((e) => e.event.startsWith("window-")).map((e) => e.event)).size).toBe(12);
  });
});

describe("MULTIPLE ORGANISATIONS on one till: records and exports stay scoped", () => {
  it("org-2's records are never listed or exported in org-1's session", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    actingOrg = "org-2"; actingUser = "user-9";
    await get().createSale(saleInput({ cashierId: "user-9", cartItems: [cartItem({ qty: 1 })] }));
    expect((await listJournal({ orgId: "org-1" })).records.map((r) => r.orgId)).toEqual(["org-1"]);
    expect((await journalSummary("org-2")).total).toBe(1);
    const exp = await collectQueueExport(localDb, { appVersion: "t", tillId: "till", backendHost: "h", session: { userId: "user-1", orgId: "org-1", shopId: null, role: "ADMIN" } });
    expect(exp.journal.map((r) => r.orgId)).toEqual(["org-1"]);
    // the sign-in screen (no session) exports no operation history at all
    const signIn = await collectQueueExport(localDb, { appVersion: "t", tillId: "till", backendHost: "h", session: { userId: null, orgId: null, shopId: null, role: null } });
    expect(signIn.journal).toHaveLength(0);
    expect(signIn.vanished).toHaveLength(0);
    // a record is labelled with the operation's own organisation, never the current session's
    expect((await listJournal()).records.map((r) => r.orgId).sort()).toEqual(["org-1", "org-2"]);
  });

  it("an owner of another organisation cannot stop an operation of this one, nor acknowledge its continuity warning", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0, p_items: [{ product_id: "p1", qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString() }, shopId: "shop-1" });
    const [row] = await rows();
    await localDb.syncOutbox.update(row.localId, { status: "conflict", fenceRequired: true, staged: false, inDoubt: true });
    actingOrg = "org-2"; actingRole = "ADMIN";
    await expect(stopOnServer(row.localId, "an owner of org-2 tries to decide this")).rejects.toThrow(/another organisation/);
    expect(fake.server.idempotency.size).toBe(0);
    actingOrg = "org-1";
    await persistSnapshotToLocal(emptySnapshot({ sales: [serverSale("x-1", "2026-10-18T01:00:00Z"), serverSale("x-2", "2026-10-18T02:00:00Z")] }), undefined, scopeA);
    await persistSnapshotToLocal(emptySnapshot({ sales: [serverSale("x-1", "2026-10-18T01:00:00Z")] }), undefined, scopeA);
    expect(await continuityWarning()).toBeTruthy();
    actingOrg = "org-2";
    await expect(acknowledgeContinuity("admin-2", "org-2 owner acknowledges another org's warning")).rejects.toThrow(/another organisation/);
    expect(await continuityWarning()).toBeTruthy();
  });
});

describe("protecting local evidence from a server snapshot (continuity)", () => {
  it("vanishedRows: a covered row the server no longer has; not a row outside the load window, a provisional row, or another shop/org view", () => {
    const newRows = [{ id: "s3", shopId: "shop-1", createdAt: "2026-10-10T03:00:00Z" }];
    const old = [
      { id: "s1", shopId: "shop-1", createdAt: "2026-10-10T01:00:00Z" },
      { id: "s2", shopId: "shop-1", createdAt: "2026-10-10T02:00:00Z" },
      { id: "s4", shopId: "shop-1", createdAt: "2026-10-10T04:00:00Z", pendingSync: true, idempotencyKey: "k" },
      { id: "s5", shopId: "shop-2", createdAt: "2026-10-10T05:00:00Z" },
      { id: "s6", shopId: "shop-x", createdAt: "2026-10-10T06:00:00Z" },
    ];
    expect(vanishedRows(old, newRows, { visibleShops: new Set(["shop-1", "shop-2"]) }).map((r) => r.id)).toEqual(["s1", "s2"]);
    // a capped load (newest N) does not cover rows older than its oldest
    expect(vanishedRows(old, newRows, { cap: 1, visibleShops: new Set(["shop-1"]) })).toEqual([]);
  });

  it("P-4: vanished sale evidence keeps the line but never its cost snapshot (it outlives the logout scrub)", async () => {
    await persistSnapshotToLocal(emptySnapshot({ sales: [serverSale("sale-1", "2026-10-18T01:00:00Z"), serverSale("sale-2", "2026-10-18T02:00:00Z")], saleItems: [{ id: "si-2", saleId: "sale-2", qtyUnits: 1, unitCostMmkSnapshot: 600 }] as never }), undefined, scopeA);
    await persistSnapshotToLocal(emptySnapshot({ sales: [serverSale("sale-1", "2026-10-18T01:00:00Z")] }), undefined, scopeA);
    const v = await listVanished();
    expect(v[0]).toMatchObject({ table: "sales", related: [{ id: "si-2", qtyUnits: 1 }] });
    expect((v[0].related as object[])[0]).not.toHaveProperty("unitCostMmkSnapshot");
  });

  it("a full load from a RESTORED server keeps the vanished sale as evidence, pauses automatic sync, and an owner resumes it", async () => {
    await persistSnapshotToLocal(emptySnapshot({ sales: [serverSale("sale-1", "2026-10-18T01:00:00Z"), serverSale("sale-2", "2026-10-18T02:00:00Z")], saleItems: [{ id: "si-2", saleId: "sale-2" }] as never }), undefined, scopeA);
    // the server was restored to before sale-2 (the same user's next load)
    await persistSnapshotToLocal(emptySnapshot({ sales: [serverSale("sale-1", "2026-10-18T01:00:00Z")] }), undefined, scopeA);
    expect(await localDb.sales.count()).toBe(1);                       // the mirror shows the server
    const v = await listVanished();
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ table: "sales", row: { id: "sale-2", receiptNo: "R-sale-2" }, related: [{ id: "si-2" }] });
    expect(await continuityWarning()).toMatchObject({ count: 1 });
    // automatic sync is paused: nothing queued is sent or looked up
    vi.stubGlobal("navigator", { onLine: false });
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    vi.stubGlobal("navigator", { onLine: true });
    expect(await drainOutbox()).toBe("backoff");
    expect(fake.calls.filter((c) => c.name === "op_execute" || c.name === "op_status")).toHaveLength(0);
    // while it is raised, a replacement never stops anything on this server
    const { settleBeforeReplacement } = await import("./outbox");
    const [queued] = await rows();
    expect(await settleBeforeReplacement([queued.localId])).toBe("blocked");
    expect(fake.calls.filter((c) => c.name === "op_status")).toHaveLength(0);
    // a cashier cannot resume; an owner can, with a statement; the evidence stays
    await expect(acknowledgeContinuity("user-1", "it is fine, resume the sync")).rejects.toThrow(/owner/);
    actingRole = "ADMIN";
    await expect(acknowledgeContinuity("admin-1", "ok")).rejects.toThrow(/at least/);
    await acknowledgeContinuity("admin-1", "restored from backup; sale-2 reconciled by hand");
    expect(await continuityWarning()).toBeNull();
    expect(await listVanished()).toHaveLength(1);
    actingRole = "CASHIER";
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);
  });

  it("a narrower view is not a loss: another user/role signing in (a cashier sees only own sales), other shops, another organisation", async () => {
    // an ADMIN's load: every cashier's sales of shop-1
    await persistSnapshotToLocal(emptySnapshot({ shops: [{ id: "shop-1" }, { id: "shop-2" }] as never, sales: [serverSale("a-1", "2026-10-18T01:00:00Z", "shop-2"), serverSale("a-2", "2026-10-18T01:00:00Z", "shop-1"), serverSale("a-3", "2026-10-18T01:30:00Z", "shop-1")] }), undefined, { userId: "admin-1", role: "ADMIN", orgId: "org-1" });
    // a CASHIER signs in: own sales only (RLS) — same shop, fewer rows
    await persistSnapshotToLocal(emptySnapshot({ shops: [{ id: "shop-1" }, { id: "shop-2" }] as never, sales: [serverSale("a-2", "2026-10-18T01:00:00Z", "shop-1")] }), undefined, { userId: "user-1", role: "CASHIER", orgId: "org-1" });
    // another organisation entirely
    await persistSnapshotToLocal(emptySnapshot({ shops: [{ id: "shop-9" }] as never, sales: [serverSale("b-1", "2026-10-18T01:00:00Z", "shop-9")] }), undefined, { userId: "user-9", role: "CASHIER", orgId: "org-2" });
    expect(await listVanished()).toHaveLength(0);
    expect(await continuityWarning()).toBeNull();
  });

  it("the same user with narrower permissions (or moved to another shop) is not compared either", async () => {
    const base = { userId: "mgr-1", role: "MANAGER", orgId: "org-1" };
    await persistSnapshotToLocal(emptySnapshot({ sales: [serverSale("m-1", "2026-10-18T01:00:00Z"), serverSale("m-2", "2026-10-18T02:00:00Z")] }), undefined, { ...base, shopId: "shop-1", permissions: '[["sale:view"],[]]' });
    await persistSnapshotToLocal(emptySnapshot({ sales: [serverSale("m-1", "2026-10-18T01:00:00Z")] }), undefined, { ...base, shopId: "shop-1", permissions: "[[],[]]" });
    expect(await listVanished()).toHaveLength(0);
    expect(await continuityWarning()).toBeNull();
  });

  it("queued offline sales merged into the snapshot never lower the load window's floor", () => {
    const serverRows = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, shopId: "shop-1", createdAt: `2026-10-10T1${i}:00:00Z` }));
    const provisional = { id: "p1", shopId: "shop-1", createdAt: "2026-10-01T00:00:00Z", pendingSync: true, idempotencyKey: "k" };
    const old = [{ id: "old-1", shopId: "shop-1", createdAt: "2026-10-05T00:00:00Z" }];   // older than the server window
    expect(vanishedRows(old, [...serverRows, provisional], { cap: 3, visibleShops: new Set(["shop-1"]) })).toEqual([]);
  });
});

describe("existing client compatibility", () => {
  it("no IndexedDB schema change: an older build still opens the database (version 2), and the journal lives in syncState", () => {
    expect(localDb.verno).toBe(2);
    expect(JOURNAL_PREFIX).toBe("opj:");
  });

  it("an older build's queued entry (no journal record) is backfilled once, and its later commit is journaled", async () => {
    await localDb.syncOutbox.put({
      localId: "old-1", kind: "rpc", name: "complete_sale", shopId: "shop-1", createdAt: new Date().toISOString(), status: "pending", attempts: 0,
      idempotencyKey: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", backendOrigin: "http://127.0.0.1:54321",
      args: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0, p_items: [{ product_id: "p1", qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString(), p_idempotency_key: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" },
    } as SyncOutboxEntry);
    expect(await backfillJournal(async () => [])).toBe(1);
    makeSaleStore();
    await drainOutbox();
    expect(await getJournalRecord("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b")).toMatchObject({ state: "committed", backfilled: true });
    expect(fake.server.sales).toHaveLength(1);
  });
});
