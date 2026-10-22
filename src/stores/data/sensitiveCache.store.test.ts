import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakePostgrest, type FakePostgrest, type FakeRow } from "./testing/fakePostgrest";

// ----------------------------------------------------------------------
// Financial-safety fix 3: purchase-order prices, supplier-payment amounts,
// audit messages (and P-4 cost) must not stay readable on a shared device
// after logout or an account switch — in memory or in IndexedDB — and a
// request still running for the previous session must not write them back.
// Queued operations, their provisional rows, the outbox and the journal stay.
// Real stores, real logout, real mirror; only the network is faked.
// ----------------------------------------------------------------------

const server: { pg?: FakePostgrest; tables: Record<string, FakeRow[]> } = { tables: {} };
const SERVER_NOW = "2026-03-01T12:00:00.000Z";

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => server.pg!.from(table),
    rpc: (name: string) => Promise.resolve(name === "resolve_event_time"
      ? { data: SERVER_NOW, error: null }
      : { data: null, error: { message: `rpc ${name} not modelled` } }),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "auth-1" }, access_token: "jwt" } }, error: null }),
      signOut: async () => ({ error: null }),
    },
  },
}));
vi.mock("../authCache", () => ({
  refreshAuthCacheSnapshot: vi.fn(async () => undefined),
  touchAuthCache: vi.fn(async () => undefined),
  setActiveAuthId: vi.fn(),
}));
vi.mock("./outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./outbox")>()),
  drainOutbox: vi.fn(async () => undefined),
}));

import { useDataStore } from "./index";
import { useAuthStore } from "../authStore";
import { localDb } from "../../lib/localDb";
import { persistSnapshotToLocal, type LocalSnapshot } from "./localSync";
import { resetDeltaSyncCompatibilityForTests } from "./deltaSync";
import { viewerFor } from "./sensitiveCache";
import type { User } from "../../types";

const emptySnapshot: LocalSnapshot = {
  shops: [], users: [], categories: [], brands: [], unitTypes: [], products: [], productUnits: [],
  barcodes: [], priceTiers: [], priceLevels: [], productUnitPrices: [], inventory: [], movements: [],
  suppliers: [], purchaseOrders: [], purchaseOrderItems: [], supplierPayments: [], supplierProducts: [],
  stockTransfers: [], stockTransferItems: [], shifts: [], sales: [], saleItems: [], reprintLogs: [],
  refunds: [], auditLogs: [], businessProfile: null,
};

const USERS: FakeRow[] = [
  { id: "u-admin", name: "Owner", role: "ADMIN", is_active: true, created_at: "t0" },
  { id: "u-cash", name: "Cashier", role: "CASHIER", shop_id: "shop-1", is_active: true, created_at: "t0" },
  { id: "u-mgr", name: "Manager", role: "MANAGER", shop_id: "shop-1", is_active: true, created_at: "t0" },
];
const T = "2026-02-01T00:00:00Z";
/** The ADMIN's view (every shop of the organisation). */
const adminServer = (): Record<string, FakeRow[]> => ({
  users: USERS,
  purchase_orders: [
    { id: "po-1", order_no: "PO-1", shop_id: "shop-1", supplier_id: "sup-1", status: "RECEIVED", subtotal_mmk: 55000, total_mmk: 55000, paid_mmk: 20000, created_by: "u-admin", created_at: T, updated_at: T },
    { id: "po-2", order_no: "PO-2", shop_id: "shop-2", supplier_id: "sup-1", status: "APPROVED", subtotal_mmk: 99000, total_mmk: 99000, paid_mmk: 0, created_by: "u-admin", created_at: T, updated_at: T },
  ],
  purchase_order_items: [
    { id: "poi-1", purchase_order_id: "po-1", product_id: "p1", ordered_qty: 100, received_qty: 100, unit_cost_mmk: 550, line_total_mmk: 55000, unit_purchase_price_snapshot: 550 },
    { id: "poi-2", purchase_order_id: "po-2", product_id: "p1", ordered_qty: 180, unit_cost_mmk: 550, line_total_mmk: 99000 },
  ],
  supplier_payments: [
    { id: "pay-1", supplier_id: "sup-1", purchase_order_id: "po-1", shop_id: "shop-1", amount_mmk: 20000, payment_method: "CASH", paid_at: T, created_by: "u-admin", created_at: T },
    { id: "pay-2", supplier_id: "sup-1", purchase_order_id: "po-2", shop_id: "shop-2", amount_mmk: 5000, payment_method: "CASH", paid_at: T, created_by: "u-admin", created_at: T },
  ],
  audit_logs: [
    { id: "au-1", shop_id: "shop-1", actor_id: "u-admin", action_type: "SUPPLIER_PAYMENT", message: "Supplier payment for PO-1: MMK 20,000", entity_type: "purchase_order", entity_id: "po-1", created_at: T },
  ],
});

function serve(tables: Record<string, FakeRow[]>, hook?: (table: string) => void) {
  server.tables = tables;
  server.pg = createFakePostgrest({ tables, beforeRequest: (req) => { hook?.(req.table); return undefined; } });
}
const offline = () => { server.pg = createFakePostgrest({ tables: {}, beforeRequest: () => "throw" }); };
const signedInAs = (userId: string | null) => useAuthStore.setState({ currentUserId: userId });
const load = () => useDataStore.getState().loadData({ force: true });
const reset = () => useDataStore.setState({ ...emptySnapshot, refundVoidRequests: [], isLoaded: false, isLoading: false, loadError: null });

const memMoney = () => {
  const s = useDataStore.getState();
  return {
    pos: s.purchaseOrders.map((p) => `${p.id}:${p.totalMmk ?? "-"}`),
    items: s.purchaseOrderItems.map((i) => `${i.id}:${i.unitCostMmk ?? "-"}`),
    payments: s.supplierPayments.map((p) => `${p.id}:${p.amountMmk ?? "-"}`),
    audit: s.auditLogs.map((a) => a.message),
  };
};
const diskMoney = async () => ({
  pos: (await localDb.purchaseOrders.orderBy("id").toArray()).map((p) => `${p.id}:${p.totalMmk ?? "-"}:${p.paidMmk ?? "-"}`),
  items: (await localDb.purchaseOrderItems.orderBy("id").toArray()).map((i) => `${i.id}:${i.unitCostMmk ?? "-"}:${i.lineTotalMmk ?? "-"}:${i.unitPurchasePriceSnapshot ?? "-"}`),
  payments: (await localDb.supplierPayments.orderBy("id").toArray()).map((p) => `${p.id}:${p.amountMmk ?? "-"}`),
  audit: (await localDb.auditLogs.toArray()).map((a) => a.message),
});

/** An offline-recorded supplier payment still queued, with its provisional rows. */
const queueOfflinePayment = async () => {
  await localDb.supplierPayments.put({ id: "pay-offline", supplierId: "sup-1", purchaseOrderId: "po-1", shopId: "shop-1", amountMmk: 7000, paymentMethod: "CASH", paidAt: T, createdBy: "u-admin", createdAt: T, pendingSync: true, idempotencyKey: "k-pay" } as never);
  await localDb.syncOutbox.put({ localId: "ob-pay", kind: "rpc", name: "record_supplier_payment", args: { p_purchase_order_id: "po-1", p_amount_mmk: 7000, p_idempotency_key: "k-pay" }, createdAt: T, status: "pending", attempts: 0, idempotencyKey: "k-pay", shopId: "shop-1", provisional: [{ table: "supplierPayments", ids: ["pay-offline"] }] } as never);
};

beforeEach(async () => {
  resetDeltaSyncCompatibilityForTests();
  vi.stubGlobal("navigator", { onLine: true });
  await Promise.all(localDb.tables.map((t) => t.clear()));
  reset();
  signedInAs(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("viewerFor mirrors the server's row security (069)", () => {
  const u = (o: Partial<User>) => ({ id: "x", name: "x", isActive: true, ...o }) as User;
  it("ADMIN: organisation; manager: own shop (purchase:view by default); cashier: nothing; unknown / inactive: nothing", () => {
    expect(viewerFor([u({ role: "ADMIN" })], "x")).toMatchObject({ cost: true, purchases: "org", supplierPayments: "org", audit: "org" });
    expect(viewerFor([u({ role: "MANAGER", shopId: "s1" })], "x").purchases).toEqual({ shopId: "s1" });
    expect(viewerFor([u({ role: "CASHIER", shopId: "s1" })], "x")).toMatchObject({ cost: false, purchases: null, supplierPayments: null });
    expect(viewerFor([u({ role: "ADMIN", isActive: false })], "x").purchases).toBeNull();
    expect(viewerFor([], "x").purchases).toBeNull();
    expect(viewerFor([u({ role: "MANAGER", shopId: "s1", revokedPermissions: ["purchase:view", "supplier:debt_view"] as never })], "x"))
      .toMatchObject({ purchases: null, supplierPayments: null });
  });
});

describe("logout", () => {
  it("the owner's purchase prices, supplier payments and audit messages leave memory and disk; rows, the queued payment and the outbox stay", async () => {
    serve(adminServer());
    signedInAs("u-admin");
    await load();
    expect(memMoney().pos).toEqual(["po-1:55000", "po-2:99000"]);
    await vi.waitFor(async () => expect((await diskMoney()).pos).toEqual(["po-1:55000:20000", "po-2:99000:0"]));
    await queueOfflinePayment();

    await useAuthStore.getState().logout();

    expect(memMoney()).toEqual({ pos: [], items: [], payments: [], audit: [] });
    expect(await diskMoney()).toEqual({
      pos: ["po-1:-:-", "po-2:-:-"],
      items: ["poi-1:-:-:-", "poi-2:-:-:-"],
      payments: ["pay-1:-", "pay-2:-", "pay-offline:7000"],   // the queued one is the operation itself: untouched
      audit: [""],
    });
    expect(await localDb.syncOutbox.get("ob-pay")).toMatchObject({ args: { p_amount_mmk: 7000 } });
  });

  it("a load still in flight at logout cannot write the previous session's money back", async () => {
    let logoutPromise: Promise<void> | null = null;
    serve(adminServer(), (table) => {
      if (table === "supplier_payments" && !logoutPromise) logoutPromise = useAuthStore.getState().logout();
    });
    signedInAs("u-admin");
    await load();
    await logoutPromise;
    await new Promise((r) => setTimeout(r, 20));
    expect(memMoney()).toEqual({ pos: [], items: [], payments: [], audit: [] });
    const d = await diskMoney();
    expect([...d.pos, ...d.items, ...d.payments].every((x) => /:-(:-)*$/.test(x))).toBe(true);
    expect(useDataStore.getState().isLoaded).toBe(false);   // nothing shown for nobody
  });
});

describe("account switch on the same device", () => {
  const ownerMirror = async () => {
    serve(adminServer());
    signedInAs("u-admin");
    await load();
    await vi.waitFor(async () => expect((await diskMoney()).payments).toEqual(["pay-1:20000", "pay-2:5000"]));
    await queueOfflinePayment();
    reset(); // app restart, no logout (crash / session restore of another account)
  };

  it("OWNER -> CASHIER, offline restart: nothing of purchasing or supplier money in memory; scrubbed on disk; queue kept", async () => {
    await ownerMirror();
    offline();
    signedInAs("u-cash");
    await load().catch(() => undefined);
    expect(useDataStore.getState().isLoaded).toBe(true);           // the till still opens offline
    expect(memMoney()).toEqual({ pos: [], items: [], payments: [], audit: [] });
    const d = await diskMoney();
    expect(d.pos).toEqual(["po-1:-:-", "po-2:-:-"]);
    expect(d.payments).toEqual(["pay-1:-", "pay-2:-", "pay-offline:7000"]);
    expect(d.audit).toEqual([""]);
    expect(await localDb.syncOutbox.count()).toBe(1);
  });

  it("OWNER -> CASHIER, then RECONNECT: the cashier's own server view (none) replaces it; nothing comes back", async () => {
    await ownerMirror();
    offline();
    signedInAs("u-cash");
    await load().catch(() => undefined);
    serve({ users: USERS });                                          // RLS: a cashier reads no POs / payments / audit
    await load();
    expect(memMoney()).toEqual({ pos: [], items: [], payments: ["pay-offline:7000"], audit: [] });
    expect(await localDb.syncOutbox.count()).toBe(1);
  });

  it("OWNER -> MANAGER of shop-1: shop-1 purchasing stays visible with its prices; shop-2 is hidden and scrubbed on disk", async () => {
    await ownerMirror();
    offline();
    signedInAs("u-mgr");
    await load().catch(() => undefined);
    expect(memMoney().pos).toEqual(["po-1:55000"]);
    expect(memMoney().items).toEqual(["poi-1:550"]);
    expect(memMoney().payments.sort()).toEqual(["pay-1:20000", "pay-offline:7000"]);
    const d = await diskMoney();
    expect(d.pos).toEqual(["po-1:55000:20000", "po-2:-:-"]);
    expect(d.items).toEqual(["poi-1:550:55000:550", "poi-2:-:-:-"]);
    expect(d.payments).toEqual(["pay-1:20000", "pay-2:-", "pay-offline:7000"]);
  });

  it("OWNER logs out -> MANAGER of shop-1 signs in: rows whose money the logout scrubbed are not shown from the cache (no undefined amounts); the server load brings them back", async () => {
    // e2e A5 (2026-10-22): the Purchases page crashed on po.totalMmk.toLocaleString() of a scrubbed cached row.
    await ownerMirror();
    signedInAs("u-admin");
    await useAuthStore.getState().logout();
    expect((await diskMoney()).pos).toEqual(["po-1:-:-", "po-2:-:-"]);
    offline();
    signedInAs("u-mgr");
    await load().catch(() => undefined);
    const s = useDataStore.getState();
    expect(s.purchaseOrders.every((po) => typeof po.totalMmk === "number")).toBe(true);
    expect(s.purchaseOrderItems.every((i) => typeof i.lineTotalMmk === "number")).toBe(true);
    expect(s.supplierPayments.every((p) => typeof p.amountMmk === "number")).toBe(true);
    expect(memMoney().payments).toEqual(["pay-offline:7000"]);          // the queued operation is never hidden
    expect((await diskMoney()).pos).toEqual(["po-1:-:-", "po-2:-:-"]);   // rows kept on disk (ids for continuity)
    serve({ ...adminServer(), purchase_orders: adminServer().purchase_orders.filter((p) => p.shop_id === "shop-1"),
      purchase_order_items: adminServer().purchase_order_items.filter((i) => i.purchase_order_id === "po-1"),
      supplier_payments: adminServer().supplier_payments.filter((p) => p.shop_id === "shop-1") });
    await load();
    expect(memMoney().pos).toEqual(["po-1:55000"]);
  });

  it("the SAME owner restarting offline keeps everything (no needless scrub)", async () => {
    await ownerMirror();
    offline();
    signedInAs("u-admin");
    await load().catch(() => undefined);
    expect(memMoney().pos).toEqual(["po-1:55000", "po-2:99000"]);
    expect((await diskMoney()).payments).toEqual(["pay-1:20000", "pay-2:5000", "pay-offline:7000"]);
  });

  it("a full load overtaken by an account switch is discarded, and the new person's own load runs", async () => {
    let switched = false;
    serve(adminServer(), (table) => {
      if (table === "supplier_payments" && !switched) { switched = true; signedInAs("u-cash"); }
    });
    signedInAs("u-admin");
    await load();
    // the owner's pages were never shown or mirrored; the cashier's load then ran
    // (the fake server has no RLS, so only "not the discarded load" is asserted)
    await vi.waitFor(() => expect(useDataStore.getState().isLoaded).toBe(true));
    expect(server.pg!.requestsFor("purchase_orders").length).toBeGreaterThanOrEqual(2);
  });
});

describe("delta pull overtaken by a sign-out", () => {
  it("a page arriving after the switch is neither mirrored nor shown, and its cursor does not advance", async () => {
    const tables = adminServer();
    serve(tables);
    signedInAs("u-admin");
    await load();
    const cursorBefore = await localDb.syncMeta.get("purchase_orders");
    tables.purchase_orders.push({ id: "po-3", order_no: "PO-3", shop_id: "shop-1", supplier_id: "sup-1", status: "DRAFT", subtotal_mmk: 777, total_mmk: 777, created_by: "u-admin", created_at: SERVER_NOW, updated_at: "2026-03-01T12:30:00Z" });
    serve(tables, (table) => { if (table === "purchase_orders") signedInAs("u-cash"); });
    await useDataStore.getState().pullDeltas();
    expect(await localDb.purchaseOrders.get("po-3")).toBeUndefined();
    expect(useDataStore.getState().purchaseOrders.find((p) => p.id === "po-3")).toBeUndefined();
    expect(await localDb.syncMeta.get("purchase_orders")).toEqual(cursorBefore);
  });
});

describe("persisted evidence and queued work are never deleted", () => {
  it("vanished-row detection still works after a logout scrub (ids kept)", async () => {
    await persistSnapshotToLocal({ ...emptySnapshot, supplierPayments: [{ id: "pay-x", shopId: "shop-1", amountMmk: 1 } as never] });
    signedInAs("u-admin");
    await useAuthStore.getState().logout();
    expect(await localDb.supplierPayments.get("pay-x")).toMatchObject({ id: "pay-x", shopId: "shop-1" });
  });
});
