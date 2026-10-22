import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakePostgrest, type FakePostgrest, type FakeRow } from "./testing/fakePostgrest";

// ----------------------------------------------------------------------
// Batch 1-code (ORV-001) — the real full load (stores/data/index.ts) against
// an in-memory PostgREST that silently caps every response at 1,000 rows.
// Only the network is faked; the store, IndexedDB mirror, provisional-row
// merge and delta-cursor bootstrap are the production code.
// ----------------------------------------------------------------------

const server: { tables: Record<string, FakeRow[]>; fail?: (req: { table: string; index: number }) => boolean; pg?: FakePostgrest } = { tables: {} };
const SERVER_NOW = "2026-03-01T12:00:00.000Z";

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => server.pg!.from(table),
    rpc: (name: string) => Promise.resolve(name === "resolve_event_time"
      ? { data: SERVER_NOW, error: null }
      : { data: null, error: { message: `rpc ${name} not modelled` } }),
    auth: { getSession: async () => ({ data: { session: { user: { id: "auth-1" }, access_token: "jwt" } }, error: null }) },
  },
}));
vi.mock("../authCache", () => ({ refreshAuthCacheSnapshot: vi.fn(async () => undefined), touchAuthCache: vi.fn(async () => undefined) }));
vi.mock("./outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./outbox")>()),
  drainOutbox: vi.fn(async () => undefined),
}));

import { sortedBy, useDataStore } from "./index";
import { localDb } from "../../lib/localDb";
import { persistSnapshotToLocal, type LocalSnapshot } from "./localSync";
import { COMMIT_LAG_MS, deltaSyncCompatibility, resetDeltaSyncCompatibilityForTests } from "./deltaSync";
import { touchAuthCache } from "../authCache";

const emptySnapshot: LocalSnapshot = {
  shops: [], users: [], categories: [], brands: [], unitTypes: [], products: [], productUnits: [],
  barcodes: [], priceTiers: [], priceLevels: [], productUnitPrices: [], inventory: [], movements: [],
  suppliers: [], purchaseOrders: [], purchaseOrderItems: [], supplierPayments: [], supplierProducts: [],
  stockTransfers: [], stockTransferItems: [], shifts: [], sales: [], saleItems: [], reprintLogs: [],
  refunds: [], auditLogs: [], businessProfile: null,
};

const pad = (n: number, w = 5) => String(n).padStart(w, "0");
// Rows shaped like the PRODUCTION schema: no updated_at on products (044 missing).
const product = (i: number): FakeRow => ({ id: `prod-${pad(i)}`, name: `P${i}`, sku: `SKU${i}`, cost_mmk: 1, is_active: true, created_at: "2026-01-01T00:00:00Z" });

// The production schema (lucashome, 2026-10-16): migration 044's updated_at
// is missing on these tables; filtering on it fails like PostgREST does.
const NO_UPDATED_AT = ["products", "categories", "suppliers", "purchase_orders", "stock_transfers", "shifts"];

function serve(
  tables: Record<string, FakeRow[]>,
  fail?: (req: { table: string; index: number }) => boolean,
  hook?: (req: { table: string; index: number }) => void,
) {
  server.tables = tables;
  server.pg = createFakePostgrest({
    tables,
    beforeRequest: (req) => {
      const n = server.pg!.requestsFor(req.table).length - 1; // index within this table
      hook?.({ table: req.table, index: n });
      if (NO_UPDATED_AT.includes(req.table) && req.filters.some((f) => f.includes("updated_at"))) {
        return { message: `column ${req.table}.updated_at does not exist`, code: "42703" };
      }
      return fail?.({ table: req.table, index: n }) ? { message: `${req.table} page ${n} failed` } : undefined;
    },
  });
}

const load = () => useDataStore.getState().loadData({ force: true });

beforeEach(async () => {
  resetDeltaSyncCompatibilityForTests();
  vi.mocked(touchAuthCache).mockClear();
  vi.stubGlobal("navigator", { onLine: true });
  await Promise.all(localDb.tables.map((t) => t.clear()));
  useDataStore.setState({ ...emptySnapshot, refundVoidRequests: [], isLoaded: false, isLoading: false, loadError: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("loadData — complete reads (G-OFF-2)", () => {
  it("loads every row of every complete table past the 1,000-row cap and mirrors them", async () => {
    const inventory: FakeRow[] = [];
    for (const shop of ["shop-1", "shop-2"]) for (let i = 0; i < 1300; i += 1) inventory.push({ shop_id: shop, product_id: `prod-${pad(i)}`, qty_base_units: i });
    serve({
      products: Array.from({ length: 2500 }, (_, i) => product(i)),
      product_unit_prices: Array.from({ length: 1800 }, (_, i) => ({ id: `pup-${pad(i)}`, product_unit_id: "u", price_level_id: "l", price_mmk: i, updated_at: "2026-01-01T00:00:00Z" })),
      inventory,
      supplier_products: Array.from({ length: 1100 }, (_, i) => ({ supplier_id: `sup-${i % 3}`, product_id: `prod-${pad(i)}` })),
    });
    await load();
    const s = useDataStore.getState();
    expect(s.loadError).toBeNull();
    expect(s.products).toHaveLength(2500);
    expect(s.productUnitPrices).toHaveLength(1800);
    expect(s.inventory).toHaveLength(2600);
    expect(s.supplierProducts).toHaveLength(1100);
    expect(await localDb.products.count()).toBe(2500);
    expect(await localDb.inventory.count()).toBe(2600);
    // delta cursors start just before the server clock read BEFORE the load —
    // for tables whose rows carry updated_at; products (production schema,
    // no updated_at) is full-load-only and gets none (H1)
    const cursor = await localDb.syncMeta.get("product_unit_prices");
    expect(cursor?.lastPulledAt).toBe(new Date(Date.parse(SERVER_NOW) - COMMIT_LAG_MS).toISOString());
    expect(await localDb.syncMeta.get("products")).toBeUndefined();
  });

  it("loads the 1,000 newest sales and exactly their line items (all of them, past the cap)", async () => {
    const sales = Array.from({ length: 1200 }, (_, i) => ({ id: `sale-${pad(i)}`, shop_id: "shop-1", status: "NORMAL", total_mmk: 100, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    const items = sales.flatMap((sale) => [0, 1, 2].map((j) => ({ id: `${sale.id}-i${j}`, sale_id: sale.id, product_id: "prod-00001", qty_units: 1, line_total_mmk: 100 })));
    serve({ sales, sale_items: items });
    await load();
    const s = useDataStore.getState();
    expect(s.sales).toHaveLength(1000);
    expect(s.sales[0].id).toBe("sale-01199"); // newest first
    expect(s.saleItems).toHaveLength(3000);
    const loaded = new Set(s.sales.map((x) => x.id));
    expect(s.saleItems.every((it) => loaded.has(it.saleId))).toBe(true);
  });

  it("a failed page anywhere leaves the rendered data AND the local mirror exactly as they were", async () => {
    await persistSnapshotToLocal({ ...emptySnapshot, products: [{ id: "cached-1", name: "Cached" } as never] });
    serve({ products: Array.from({ length: 2500 }, (_, i) => product(i)) }, ({ table, index }) => table === "products" && index === 1);
    await load(); // renders the cache, then the network read fails on products page 2
    const s = useDataStore.getState();
    expect(s.loadError).toBeTruthy();
    expect(s.products.map((p) => p.id)).toEqual(["cached-1"]);
    expect((await localDb.products.toArray()).map((p) => p.id)).toEqual(["cached-1"]);
  });

  it("re-applies the stock effect of an offline operation still queued (pending) on top of the server rows", async () => {
    await localDb.movements.put({ id: "mv-local", shopId: "shop-1", productId: "prod-00001", type: "SALE", qtyChange: -2, qtyBefore: 10, qtyAfter: 8, createdBy: "u", createdAt: "t", pendingSync: true } as never);
    await localDb.syncOutbox.put({
      localId: "ob-1", kind: "rpc", name: "complete_sale", args: {}, shopId: "shop-1", createdAt: "t", status: "pending",
      attempts: 0, provisional: [{ table: "movements", ids: ["mv-local"] }],
    } as never);
    serve({ inventory: [{ shop_id: "shop-1", product_id: "prod-00001", qty_base_units: 10 }, { shop_id: "shop-1", product_id: "prod-00002", qty_base_units: 5 }] });
    await load();
    const inv = useDataStore.getState().inventory;
    expect(inv.find((r) => r.productId === "prod-00001")?.qtyBaseUnits).toBe(8);
    expect(inv.find((r) => r.productId === "prod-00002")?.qtyBaseUnits).toBe(5);
    expect(await localDb.syncOutbox.count()).toBe(1); // the queue is untouched
  });
});

describe("H1: background pull after a full load on the production schema", () => {
  it("is not an error: the offline sign-in window is refreshed, the 044 tables run full-load-only, brands are still delta-pulled", async () => {
    serve({
      products: Array.from({ length: 3 }, (_, i) => product(i)),
      shifts: [], stock_transfers: [], // empty at load time: get a cursor, then 42703 on the first pull
      brands: [{ id: "b1", category_id: "c1", name: "B", is_active: true, sort_order: 0, created_at: "t0", updated_at: "2026-01-01T00:00:00Z" }],
    });
    await load();
    expect(await localDb.syncMeta.get("products")).toBeUndefined(); // never seeded
    vi.mocked(touchAuthCache).mockClear();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    server.tables.brands.push({ id: "b2", category_id: "c1", name: "B2", is_active: true, sort_order: 1, created_at: "t0", updated_at: "2026-03-01T12:30:00Z" });
    await useDataStore.getState().pullDeltas();

    expect(touchAuthCache).toHaveBeenCalledTimes(1); // only after an error-free pull
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("Delta pull failed"))).toEqual([]);
    expect(useDataStore.getState().brands.map((b) => b.id).sort()).toEqual(["b1", "b2"]);
    expect(deltaSyncCompatibility().map((c) => c.table)).toEqual(expect.arrayContaining(["products", "shifts", "stock_transfers"]));
    errors.mockRestore();
  });

  it("a genuine failure of a compatible table still blocks the sign-in-window refresh", async () => {
    serve({ brands: [{ id: "b1", category_id: "c1", name: "B", is_active: true, sort_order: 0, created_at: "t0", updated_at: "2026-01-01T00:00:00Z" }] },
      ({ table }) => table === "brands" && server.pg!.requestsFor("brands").length > 2);
    await load();
    vi.mocked(touchAuthCache).mockClear();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await useDataStore.getState().pullDeltas();
    expect(touchAuthCache).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("H2: live stock events during a full load", () => {
  const inv = (n: number, qty = 10): FakeRow[] => Array.from({ length: n }, (_, i) => ({ shop_id: "shop-1", product_id: `prod-${pad(i)}`, qty_base_units: qty }));
  const after = (ms: number) => new Date(Date.parse(SERVER_NOW) + ms).toISOString();

  it("an event committed after the load began wins over the older page, with the queued offline delta applied", async () => {
    await localDb.movements.put({ id: "mv-q", shopId: "shop-1", productId: "prod-00005", type: "SALE", qtyChange: -2, qtyBefore: 10, qtyAfter: 8, createdBy: "u", createdAt: "t", pendingSync: true } as never);
    await localDb.syncOutbox.put({ localId: "ob-q", kind: "rpc", name: "complete_sale", args: {}, shopId: "shop-1", createdAt: "t", status: "pending", attempts: 0, provisional: [{ table: "movements", ids: ["mv-q"] }] } as never);
    const rows = inv(1500);
    serve({ inventory: rows }, undefined, ({ table, index }) => {
      if (table !== "inventory" || index !== 1) return;
      // Page 1 (prod-00000..00999) is read; another till now sells 1 of prod-00005.
      rows[5] = { ...rows[5], qty_base_units: 9 };
      useDataStore.getState().applyInventoryRealtimeUpdate({ shopId: "shop-1", productId: "prod-00005", qtyBaseUnits: 9 }, after(1000));
    });
    await load();
    const q = (pid: string) => useDataStore.getState().inventory.find((r) => r.productId === pid)?.qtyBaseUnits;
    expect(q("prod-00005")).toBe(7); // server 9 − the 2 still queued — not 9, not 8
    expect(q("prod-00006")).toBe(10);
    await vi.waitFor(async () => expect((await localDb.inventory.get(["shop-1", "prod-00005"]))?.qtyBaseUnits).toBe(7));
  });

  it("an event committed BEFORE the load began is not re-applied over the pages (they already include it)", async () => {
    const rows = inv(1200);
    serve({ inventory: rows }, undefined, ({ table, index }) => {
      if (table !== "inventory" || index !== 1) return;
      useDataStore.getState().applyInventoryRealtimeUpdate({ shopId: "shop-1", productId: "prod-01100", qtyBaseUnits: 99 }, after(-60_000));
    });
    await load();
    expect(useDataStore.getState().inventory.find((r) => r.productId === "prod-01100")?.qtyBaseUnits).toBe(10);
  });
});

describe("M2: list order after complete (key-ordered) reads", () => {
  it("tables the UI showed in creation order come back oldest first, whatever their ids", async () => {
    serve({
      shops: [
        { id: "shop-ffff", code: "C", name: "Third", address: "", is_active: true, created_at: "2026-03-01T00:00:00Z" },
        { id: "shop-0000", code: "B", name: "Second", address: "", is_active: true, created_at: "2026-02-01T00:00:00.500+00:00" },
        { id: "shop-8888", code: "A", name: "First", address: "", is_active: true, created_at: "2026-01-01T00:00:00Z" },
      ],
      shifts: [
        { id: "shift-a", shop_id: "s", cashier_id: "u", started_at: "2026-02-01T00:00:00Z", opening_cash_mmk: 0, created_at: "x" },
        { id: "shift-b", shop_id: "s", cashier_id: "u", started_at: "2026-01-01T00:00:00Z", opening_cash_mmk: 0, created_at: "x" },
      ],
    });
    await load();
    expect(useDataStore.getState().shops.map((s) => s.name)).toEqual(["First", "Second", "Third"]);
    expect(useDataStore.getState().shifts.map((s) => s.id)).toEqual(["shift-b", "shift-a"]);
  });

  it("sortedBy: Postgres NULL placement, instants not strings, numbers as numbers, ties by key", () => {
    const rows = [
      { id: "c", v: null }, { id: "b", v: "2026-01-01T00:00:01Z" }, { id: "a", v: "2026-01-01T00:00:00.999+00:00" }, { id: "d", v: "2026-01-01T00:00:01.000Z" },
    ];
    const asc = sortedBy("v")({ data: rows, error: null }).data!.map((r) => r.id);
    expect(asc).toEqual(["a", "b", "d", "c"]); // b and d are the same instant → by id; NULL last
    const desc = sortedBy("v", "desc")({ data: rows, error: null }).data!.map((r) => r.id);
    expect(desc).toEqual(["c", "b", "d", "a"]); // NULL first descending
    const nums = sortedBy("n")({ data: [{ id: "x", n: 10 }, { id: "y", n: 9 }, { id: "z", n: 9 }], error: null }).data!.map((r) => r.id);
    expect(nums).toEqual(["y", "z", "x"]);
    const err = { data: null, error: { message: "boom" } } as const;
    expect(sortedBy("v")(err)).toBe(err);
  });
});

describe("cache fast path: the route guards never see 'loaded, not loading' before the server answers", () => {
  // e2e C3 (2026-10-22): the mirror held the previous account's RLS view (a just-deactivated cashier: no users rows).
  // An admin signed in, login() reset isLoaded, and the load rendered that mirror with isLoaded=true while isLoading was
  // still false (raised only after the queue classification awaits). RequireRole read "loaded, and the signed-in user is
  // not in users" and bounced a valid sign-in to /login. Online, isLoading must already be true when the cache is shown.
  it("online: every state with the cached rows shown is still 'loading' until the server load lands", async () => {
    await persistSnapshotToLocal({ ...emptySnapshot, products: [{ id: "cached-1", name: "Cached" } as never] });
    serve({ products: [product(1)] });
    const seen: { isLoaded: boolean; isLoading: boolean; ids: string }[] = [];
    const unsub = useDataStore.subscribe((s) => seen.push({ isLoaded: s.isLoaded, isLoading: s.isLoading, ids: s.products.map((p) => p.id).join(",") }));
    try {
      await load();
    } finally {
      unsub();
    }
    const cachedShown = seen.filter((s) => s.ids === "cached-1" && s.isLoaded);
    expect(cachedShown.length).toBeGreaterThan(0);
    expect(cachedShown.every((s) => s.isLoading)).toBe(true);
    const end = useDataStore.getState();
    expect(end).toMatchObject({ isLoaded: true, isLoading: false });
    expect(end.products.map((p) => p.id)).toEqual(["prod-00001"]);
  });

  it("offline: the cache is shown as loaded and NOT loading (no server load follows)", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await persistSnapshotToLocal({ ...emptySnapshot, products: [{ id: "cached-1", name: "Cached" } as never] });
    serve({});
    await load();
    const s = useDataStore.getState();
    expect(s).toMatchObject({ isLoaded: true, isLoading: false });
    expect(s.products.map((p) => p.id)).toEqual(["cached-1"]);
  });
});
