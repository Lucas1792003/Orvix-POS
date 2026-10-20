import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakePostgrest, type FakePostgrest, type FakeRow } from "./testing/fakePostgrest";

// ----------------------------------------------------------------------
// P-4 through the real stores: full load, start-up hydrate (account switch /
// offline restart), delta pull and logout, against an in-memory PostgREST.
// Two server shapes: an OLD server (cost in the legacy columns, readable by
// everyone) and a PCOST-A server (legacy columns NULL, cost only in the gated
// tables, which RLS answers with no rows for a user without the permission).
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
  { id: "u-mgr-p", name: "Manager+", role: "MANAGER", shop_id: "shop-1", is_active: true, created_at: "t0", granted_permissions: ["report:shop_profit"] },
];

/** Old server: cost readable in the legacy columns. */
const oldServer = (): Record<string, FakeRow[]> => ({
  users: USERS,
  products: [{ id: "p1", name: "Tea", sku: "T", cost_mmk: 600, is_active: true, created_at: "t0" }],
  product_units: [{ id: "pu1", product_id: "p1", unit_type_id: "ut", qty_base_units: 1, purchase_price_mmk: 550, is_active: true, updated_at: "2026-01-01T00:00:00Z" }],
  sales: [{ id: "s1", shop_id: "shop-1", status: "NORMAL", total_mmk: 1000, created_at: "2026-02-01T00:00:00Z" }],
  sale_items: [{ id: "i1", sale_id: "s1", product_id: "p1", qty_units: 1, line_total_mmk: 1000, unit_cost_mmk_snapshot: 600 }],
});
/** PCOST-A server, as seen by a user WITH report:shop_profit. */
const pcostServer = (rlsAllows: boolean): Record<string, FakeRow[]> => {
  const t = oldServer();
  t.products = t.products.map((r) => ({ ...r, cost_mmk: null }));
  t.product_units = t.product_units.map((r) => ({ ...r, purchase_price_mmk: null }));
  t.sale_items = t.sale_items.map((r) => ({ ...r, unit_cost_mmk_snapshot: null }));
  t.product_costs = rlsAllows ? [{ product_id: "p1", cost_mmk: 600 }] : [];
  t.product_unit_costs = rlsAllows ? [{ product_unit_id: "pu1", purchase_price_mmk: 550 }] : [];
  t.sale_item_costs = rlsAllows ? [{ sale_item_id: "i1", sale_id: "s1", shop_id: "shop-1", unit_cost_mmk: 600 }] : [];
  return t;
};

const MISSING = ["product_costs", "product_unit_costs", "sale_item_costs"];
function serve(tables: Record<string, FakeRow[]>) {
  server.tables = tables;
  server.pg = createFakePostgrest({
    tables,
    // an old server has no cost tables: PostgREST answers PGRST205
    beforeRequest: (req) => (MISSING.includes(req.table) && !(req.table in tables)
      ? { message: `Could not find the table 'public.${req.table}' in the schema cache`, code: "PGRST205" }
      : undefined),
  });
}

const signedInAs = (userId: string | null) => useAuthStore.setState({ currentUserId: userId });
const load = () => useDataStore.getState().loadData({ force: true });
const reset = () => useDataStore.setState({ ...emptySnapshot, refundVoidRequests: [], isLoaded: false, isLoading: false, loadError: null });

const memCost = () => {
  const s = useDataStore.getState();
  return { product: s.products[0]?.costMmk, unit: s.productUnits[0]?.purchasePriceMmk, line: s.saleItems[0]?.unitCostMmkSnapshot };
};
const mirrorCost = async () => ({
  product: (await localDb.products.get("p1"))?.costMmk,
  unit: (await localDb.productUnits.get("pu1"))?.purchasePriceMmk,
  line: (await localDb.saleItems.get("i1"))?.unitCostMmkSnapshot,
});
const NONE = { product: undefined, unit: undefined, line: undefined };
const ALL = { product: 600, unit: 550, line: 600 };

beforeEach(async () => {
  resetDeltaSyncCompatibilityForTests();
  vi.stubGlobal("navigator", { onLine: true });
  await Promise.all(localDb.tables.map((t) => t.clear()));
  reset();
  signedInAs(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("full load", () => {
  it.each([
    ["u-cash", "cashier"], ["u-mgr", "manager without report:shop_profit"],
  ])("%s (%s) on an OLD server: cost never reaches memory or IndexedDB", async (id) => {
    serve(oldServer());
    signedInAs(id);
    await load();
    expect(useDataStore.getState().loadError).toBeNull();
    expect(useDataStore.getState().products).toHaveLength(1); // selling still works
    expect(memCost()).toEqual(NONE);
    await vi.waitFor(async () => expect(await localDb.products.count()).toBe(1));
    expect(await mirrorCost()).toEqual(NONE);
  });

  it.each([["u-admin"], ["u-mgr-p"]])("%s on a PCOST-A server gets cost from the gated tables", async (id) => {
    serve(pcostServer(true));
    signedInAs(id);
    await load();
    expect(useDataStore.getState().loadError).toBeNull();
    expect(memCost()).toEqual(ALL);
  });

  it("owner on an OLD server (no cost tables): the legacy columns stay the source, the load does not fail", async () => {
    serve(oldServer());
    signedInAs("u-admin");
    await load();
    expect(useDataStore.getState().loadError).toBeNull();
    expect(memCost()).toEqual(ALL);
  });

  it("cashier on a PCOST-A server: no cost tables are read at all, nothing to show", async () => {
    serve(pcostServer(false));
    signedInAs("u-cash");
    await load();
    expect(useDataStore.getState().loadError).toBeNull();
    expect(memCost()).toEqual(NONE);
    for (const t of MISSING) expect(server.pg!.requestsFor(t)).toHaveLength(0);
  });
});

describe("session change during a full load (review M1)", () => {
  it("the owner logs out while the cost rows are being read: nothing with cost reaches memory or the mirror", async () => {
    const tables = pcostServer(true);
    server.tables = tables;
    server.pg = createFakePostgrest({
      tables,
      beforeRequest: (req) => { if (req.table === "product_costs") signedInAs("u-cash"); }, // logout + cashier sign-in mid-load
    });
    signedInAs("u-admin");
    await load();
    // fix 3: the overtaken load is discarded entirely and the cashier's own
    // load runs (it reads no cost table); wait for that one to finish
    await vi.waitFor(() => expect(useDataStore.getState().isLoaded && !useDataStore.getState().isLoading).toBe(true));
    await useDataStore.getState().loadData(); // joins nothing left in flight
    expect(useDataStore.getState().products).toHaveLength(1);
    expect(memCost()).toEqual(NONE);
    await vi.waitFor(async () => expect(await localDb.products.count()).toBe(1));
    expect(await mirrorCost()).toEqual(NONE);
  });
});

describe("start-up hydrate (account switch, offline restart)", () => {
  const seedMirrorWithCost = async () => {
    await persistSnapshotToLocal({
      ...emptySnapshot,
      users: USERS.map((u) => ({ id: u.id, name: u.name, role: u.role, isActive: true, grantedPermissions: u.granted_permissions })) as never,
      products: [{ id: "p1", name: "Tea", costMmk: 600 } as never],
      productUnits: [{ id: "pu1", productId: "p1", purchasePriceMmk: 550 } as never],
      sales: [{ id: "s1", shopId: "shop-1" } as never, { id: "sale-offline-1", shopId: "shop-1", pendingSync: true } as never],
      saleItems: [{ id: "i1", saleId: "s1", unitCostMmkSnapshot: 600 } as never, { id: "i-off", saleId: "sale-offline-1", qtyUnits: 2 } as never],
    });
    await localDb.syncOutbox.put({
      localId: "ob-1", kind: "rpc", name: "complete_sale", args: { p_items: [] }, shopId: "shop-1",
      createdAt: "t", status: "pending", attempts: 0, idempotencyKey: "k-1",
    } as never);
  };

  it("offline restart as a cashier over a mirror an owner left with cost: stripped and scrubbed; offline sale and outbox kept", async () => {
    await seedMirrorWithCost();
    vi.stubGlobal("navigator", { onLine: false });
    serve({}); // network reads fail/empty; the hydrate is what matters
    server.pg = createFakePostgrest({ tables: {}, beforeRequest: () => "throw" });
    signedInAs("u-cash");
    await load().catch(() => undefined);
    const s = useDataStore.getState();
    expect(s.isLoaded).toBe(true); // offline still renders from the mirror
    expect(s.products.map((p) => p.id)).toEqual(["p1"]);
    expect(memCost()).toEqual(NONE);
    expect(await mirrorCost()).toEqual(NONE);
    expect((await localDb.saleItems.toArray()).map((i) => i.id).sort()).toEqual(["i-off", "i1"]);
    expect(await localDb.sales.get("sale-offline-1")).toBeTruthy();
    expect(await localDb.syncOutbox.count()).toBe(1);
  });

  it("restart as the owner keeps the owner's own cached cost (no needless scrub)", async () => {
    await seedMirrorWithCost();
    server.pg = createFakePostgrest({ tables: {}, beforeRequest: () => "throw" });
    signedInAs("u-admin");
    await load().catch(() => undefined);
    expect(useDataStore.getState().products[0].costMmk).toBe(600);
    expect((await mirrorCost()).product).toBe(600);
  });

  it("reconnect after an offline restart as a cashier: the full load still brings no cost", async () => {
    await seedMirrorWithCost();
    server.pg = createFakePostgrest({ tables: {}, beforeRequest: () => "throw" });
    signedInAs("u-cash");
    await load().catch(() => undefined);
    serve(oldServer()); // back online, worst case: an old server
    await load();
    expect(useDataStore.getState().loadError).toBeNull();
    expect(memCost()).toEqual(NONE);
    expect(await mirrorCost()).toEqual(NONE);
    expect(await localDb.syncOutbox.count()).toBe(1);
  });
});

describe("delta pull", () => {
  it("a cashier's product_units pages from an OLD server are stripped; the owner's are overlaid on PCOST-A", async () => {
    serve(oldServer());
    signedInAs("u-cash");
    await load();
    server.tables.product_units.push({ id: "pu2", product_id: "p1", unit_type_id: "ut", qty_base_units: 6, purchase_price_mmk: 3000, is_active: true, updated_at: "2026-03-01T12:30:00Z" });
    await useDataStore.getState().pullDeltas();
    const pu2 = useDataStore.getState().productUnits.find((u) => u.id === "pu2");
    expect(pu2).toBeTruthy();
    expect(pu2).not.toHaveProperty("purchasePriceMmk");

    await Promise.all(localDb.tables.map((t) => t.clear()));
    reset();
    resetDeltaSyncCompatibilityForTests();
    serve(pcostServer(true));
    signedInAs("u-admin");
    await load();
    server.tables.product_units.push({ id: "pu2", product_id: "p1", unit_type_id: "ut", qty_base_units: 6, purchase_price_mmk: null, is_active: true, updated_at: "2026-03-01T12:30:00Z" });
    server.tables.product_unit_costs.push({ product_unit_id: "pu2", purchase_price_mmk: 3000 });
    await useDataStore.getState().pullDeltas();
    expect(useDataStore.getState().productUnits.find((u) => u.id === "pu2")?.purchasePriceMmk).toBe(3000);
  });
});

describe("cost tables unreadable for a moment (review: never show a known cost as 0)", () => {
  const failCostTables = (tables: Record<string, FakeRow[]>) => {
    server.tables = tables;
    server.pg = createFakePostgrest({
      tables,
      beforeRequest: (req) => (MISSING.includes(req.table) ? { message: "canceling statement due to statement timeout", code: "57014" } : undefined),
    });
  };
  it("full load: the owner keeps the cost cached from the last session", async () => {
    serve(pcostServer(true));
    signedInAs("u-admin");
    await load();
    expect(memCost()).toEqual(ALL);
    reset(); // app restart: hydrate from the mirror, then the full load
    failCostTables(pcostServer(true));
    await load();
    expect(useDataStore.getState().loadError).toBeNull();
    expect(memCost()).toEqual(ALL);
    expect(await mirrorCost()).toEqual(ALL);
  });
  it("delta pull: a unit page whose cost rows fail keeps the unit's known price", async () => {
    serve(pcostServer(true));
    signedInAs("u-admin");
    await load();
    const tables = server.tables;
    tables.product_units[0] = { ...tables.product_units[0], sale_price_mmk: 1100, updated_at: "2026-03-01T12:30:00Z" };
    failCostTables(tables);
    await useDataStore.getState().pullDeltas();
    expect(useDataStore.getState().productUnits.find((u) => u.id === "pu1")?.purchasePriceMmk).toBe(550);
  });
});

describe("logout", () => {
  it("removes cost from memory and IndexedDB, keeps every row and the outbox", async () => {
    serve(pcostServer(true));
    signedInAs("u-admin");
    await load();
    expect(memCost()).toEqual(ALL);
    await vi.waitFor(async () => expect((await mirrorCost()).product).toBe(600));
    await localDb.syncOutbox.put({ localId: "ob-1", kind: "rpc", name: "complete_sale", args: {}, createdAt: "t", status: "pending", attempts: 0 } as never);

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().currentUserId).toBeNull();
    expect(memCost()).toEqual(NONE);
    expect(await mirrorCost()).toEqual(NONE);
    expect(await localDb.products.count()).toBe(1);
    expect(await localDb.saleItems.count()).toBe(1);
    expect(await localDb.syncOutbox.count()).toBe(1);
  });
});
