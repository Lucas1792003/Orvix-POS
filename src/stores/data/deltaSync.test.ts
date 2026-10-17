import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import {
  bootstrapDeltaCursors, COMMIT_LAG_MS, deltaSyncCompatibility, isMissingUpdatedAtColumn, pullDeltaChanges,
  resetDeltaSyncCompatibilityForTests,
} from "./deltaSync";
import { createFakePostgrest } from "./testing/fakePostgrest";
import { localDb } from "../../lib/localDb";
import type { LocalSnapshot } from "./localSync";

const emptySnapshot: LocalSnapshot = {
  shops: [], users: [], categories: [], brands: [], unitTypes: [], products: [], productUnits: [],
  barcodes: [], priceTiers: [], priceLevels: [], productUnitPrices: [], inventory: [], movements: [],
  suppliers: [], purchaseOrders: [], purchaseOrderItems: [], supplierPayments: [], supplierProducts: [],
  stockTransfers: [], stockTransferItems: [], shifts: [], sales: [], saleItems: [], reprintLogs: [],
  refunds: [], auditLogs: [], businessProfile: null,
};

// A PostgREST table (fakePostgrest.ts: keyset or(), order, limit, the
// silent 1,000-row cap) holding `result.data`, or failing every request.
function queryReturning(result: { data?: unknown[]; error?: { message: string } | null }) {
  const pg = createFakePostgrest({
    tables: { t: (result.data ?? []) as Record<string, unknown>[] },
    beforeRequest: () => (result.error ? { message: result.error.message } : undefined),
  });
  return pg.from("t");
}

beforeEach(async () => {
  resetDeltaSyncCompatibilityForTests();
  fromMock.mockReset();
  rpcMock.mockReset();
  // No server clock by default (older behaviour: cursor = last row).
  rpcMock.mockReturnValue(Promise.resolve({ data: null, error: { message: "not modelled" } }));
  await Promise.all(localDb.tables.map((t) => t.clear()));
});

describe("bootstrapDeltaCursors", () => {
  it("seeds a cursor from the max updatedAt per delta-capable table", async () => {
    await bootstrapDeltaCursors({
      ...emptySnapshot,
      categories: [
        { id: "c1", name: "A", color: "blue", isActive: true, createdAt: "t0", updatedAt: "2026-01-01T00:00:00Z" },
        { id: "c2", name: "B", color: "red", isActive: true, createdAt: "t0", updatedAt: "2026-01-03T00:00:00Z" },
        { id: "c3", name: "C", color: "red", isActive: true, createdAt: "t0", updatedAt: "2026-01-02T00:00:00Z" },
      ],
    });

    const cursor = await localDb.syncMeta.get("categories");
    expect(cursor?.lastPulledAt).toBe("2026-01-03T00:00:00Z");
  });

  it("does not set a cursor for a table with no rows (nothing to bootstrap from)", async () => {
    await bootstrapDeltaCursors(emptySnapshot);
    expect(await localDb.syncMeta.get("categories")).toBeUndefined();
  });
});

describe("pullDeltaChanges", () => {
  it("skips a table that was never bootstrapped (no cursor yet)", async () => {
    const { changes } = await pullDeltaChanges(emptySnapshot);
    expect(changes.categories).toBeUndefined();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("fetches rows newer than the cursor, merges by id, and advances the cursor", async () => {
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-01-01T00:00:00Z" });
    fromMock.mockImplementation((table: string) =>
      table === "categories"
        ? queryReturning({
            data: [{ id: "c2", name: "Beverages (renamed)", color: "blue", is_active: true, created_at: "t0", updated_at: "2026-01-05T00:00:00Z" }],
          })
        : queryReturning({ data: [] }),
    );

    const current = {
      ...emptySnapshot,
      categories: [
        { id: "c1", name: "A", color: "blue", isActive: true, createdAt: "t0" },
        { id: "c2", name: "Beverages", color: "blue", isActive: true, createdAt: "t0" },
      ],
    };
    const { changes, hadErrors } = await pullDeltaChanges(current);

    expect(hadErrors).toBe(false);
    expect(changes.categories).toHaveLength(2); // c1 untouched + c2 replaced, not duplicated
    expect(changes.categories?.find((c) => c.id === "c2")?.name).toBe("Beverages (renamed)");
    expect((await localDb.syncMeta.get("categories"))?.lastPulledAt).toBe("2026-01-05T00:00:00Z");
    expect((await localDb.categories.get("c2"))?.name).toBe("Beverages (renamed)");
  });

  it("appends a genuinely new row rather than requiring it to already exist locally", async () => {
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-01-01T00:00:00Z" });
    fromMock.mockImplementation((table: string) =>
      table === "categories"
        ? queryReturning({ data: [{ id: "c-new", name: "New Category", color: "green", is_active: true, created_at: "t0", updated_at: "2026-01-02T00:00:00Z" }] })
        : queryReturning({ data: [] }),
    );

    const { changes } = await pullDeltaChanges(emptySnapshot);
    expect(changes.categories).toEqual([
      expect.objectContaining({ id: "c-new", name: "New Category" }),
    ]);
  });

  it("leaves the cursor untouched and reports no error when nothing changed", async () => {
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-01-01T00:00:00Z" });
    fromMock.mockReturnValue(queryReturning({ data: [] }));

    const { changes, hadErrors } = await pullDeltaChanges(emptySnapshot);

    expect(changes.categories).toBeUndefined();
    expect(hadErrors).toBe(false);
    expect((await localDb.syncMeta.get("categories"))?.lastPulledAt).toBe("2026-01-01T00:00:00Z");
  });

  it("reports an error for one failed table without throwing or blocking the others", async () => {
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-01-01T00:00:00Z" });
    await localDb.syncMeta.put({ table: "brands", lastPulledAt: "2026-01-01T00:00:00Z" });
    fromMock.mockImplementation((table: string) =>
      table === "categories"
        ? queryReturning({ error: { message: "permission denied" } })
        : queryReturning({ data: [{ id: "b1", category_id: "c1", name: "Grand Royal", is_active: true, sort_order: 0, created_at: "t0", updated_at: "2026-01-02T00:00:00Z" }] }),
    );

    const { changes, hadErrors } = await pullDeltaChanges(emptySnapshot);

    expect(hadErrors).toBe(true);
    expect(changes.categories).toBeUndefined();
    expect(changes.brands).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------
// Batch 1-code (ORV-001): keyset paging on (updated_at, id) past the
// server's silent 1,000-row cap.
// ----------------------------------------------------------------------
const cat = (id: string, updatedAt: string, name = id) =>
  ({ id, name, color: "blue", is_active: true, created_at: "t0", updated_at: updatedAt });
const ids = (n: number, prefix = "c") => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, "0")}`);

function serveCategories(rows: Record<string, unknown>[], beforeRequest?: Parameters<typeof createFakePostgrest>[0]["beforeRequest"]) {
  const tables = { categories: rows };
  const pg = createFakePostgrest({ tables, beforeRequest });
  fromMock.mockImplementation((table: string) => (table === "categories" ? pg.from("categories") : queryReturning({ data: [] })));
  return { pg, tables };
}

describe("pullDeltaChanges — paging past the 1,000-row cap", () => {
  const T = "2026-03-01T10:00:00.000Z";

  it("RG-11: pulls all 2,500 rows that share ONE updated_at, in pages, and ends on (T, last id)", async () => {
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-03-01T00:00:00.000Z", lastPulledId: "" });
    const all = ids(2500).map((id) => cat(id, T));
    const { pg } = serveCategories(all);

    const { changes, hadErrors } = await pullDeltaChanges(emptySnapshot);

    expect(hadErrors).toBe(false);
    expect(changes.categories).toHaveLength(2500);
    expect(new Set(changes.categories!.map((c) => c.id)).size).toBe(2500);
    expect(await localDb.categories.count()).toBe(2500);
    // 3 full pages + the empty page that proves the end
    expect(pg.requestsFor("categories")).toHaveLength(4);
    const cursor = await localDb.syncMeta.get("categories");
    expect(cursor?.lastPulledAt).toBe(T);
    expect(cursor?.lastPulledId).toBe("c02499");
  });

  it("a cursor written before ids were stored re-reads rows AT its timestamp instead of skipping them", async () => {
    // Old cursor: page 1 of a same-timestamp burst ended at T, rest unread.
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: T });
    serveCategories(ids(1500).map((id) => cat(id, T)));
    const { changes } = await pullDeltaChanges(emptySnapshot);
    expect(changes.categories).toHaveLength(1500);
  });

  it("an interrupted pull keeps the pages already applied, reports the error, and the next pull completes with no duplicates", async () => {
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-03-01T00:00:00.000Z", lastPulledId: "" });
    let fail = true;
    serveCategories(ids(2500).map((id) => cat(id, T)), (req) =>
      fail && req.index === 1 ? { message: "connection reset" } : undefined);

    const first = await pullDeltaChanges(emptySnapshot);
    expect(first.hadErrors).toBe(true);
    expect(first.changes.categories).toHaveLength(1000);
    expect((await localDb.syncMeta.get("categories"))?.lastPulledId).toBe("c00999");

    fail = false;
    const second = await pullDeltaChanges({ ...emptySnapshot, categories: first.changes.categories! });
    expect(second.hadErrors).toBe(false);
    expect(second.changes.categories).toHaveLength(2500);
    expect(new Set(second.changes.categories!.map((c) => c.id)).size).toBe(2500);
  });

  it("a thrown request (dropped connection) is an error, not an empty table", async () => {
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-03-01T00:00:00.000Z", lastPulledId: "" });
    serveCategories(ids(10).map((id) => cat(id, T)), () => "throw");
    const { changes, hadErrors } = await pullDeltaChanges(emptySnapshot);
    expect(hadErrors).toBe(true);
    expect(changes.categories).toBeUndefined();
    expect((await localDb.syncMeta.get("categories"))?.lastPulledAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("a row updated while the pages are being read is not lost (pulled now or by the next pull)", async () => {
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-03-01T00:00:00.000Z", lastPulledId: "" });
    const rows = ids(1500).map((id) => cat(id, T));
    const { tables } = serveCategories(rows, (req) => {
      // Between page 1 and page 2: c00010 (already read) is renamed.
      if (req.index === 1) {
        tables.categories = tables.categories.map((r) =>
          r.id === "c00010" ? cat("c00010", "2026-03-01T10:00:01.000Z", "renamed") : r);
      }
      return undefined;
    });
    const first = await pullDeltaChanges(emptySnapshot);
    const second = await pullDeltaChanges({ ...emptySnapshot, categories: first.changes.categories! });
    const final = second.changes.categories ?? first.changes.categories!;
    expect(final.find((c) => c.id === "c00010")?.name).toBe("renamed");
    expect(final).toHaveLength(1500);
  });

  it("never leaves the cursor inside the commit-lag window of the server clock", async () => {
    const serverNow = "2026-03-01T10:00:02.000Z"; // rows at T are 2 s old: inside the window
    rpcMock.mockReturnValue(Promise.resolve({ data: serverNow, error: null }));
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-03-01T00:00:00.000Z", lastPulledId: "" });
    serveCategories(ids(3).map((id) => cat(id, T)));
    await pullDeltaChanges(emptySnapshot);
    const cursor = await localDb.syncMeta.get("categories");
    expect(cursor?.lastPulledAt).toBe(new Date(Date.parse(serverNow) - COMMIT_LAG_MS).toISOString());
    expect(cursor?.lastPulledId).toBe("");
  });
});

describe("bootstrapDeltaCursors with the server clock", () => {
  it("starts every delta table just before the load's server time, rows or not", async () => {
    const before = "2026-03-01T10:00:00.000Z";
    await bootstrapDeltaCursors(emptySnapshot, before);
    const expected = new Date(Date.parse(before) - COMMIT_LAG_MS).toISOString();
    for (const table of ["categories", "brands", "products", "shifts"]) {
      const cursor = await localDb.syncMeta.get(table);
      expect(cursor).toEqual({ table, lastPulledAt: expected, lastPulledId: "" });
    }
  });
});

// ----------------------------------------------------------------------
// H1 — schema compatibility. On the production schema (lucashome, verified
// read-only 2026-10-16) migration 044 is recorded but its updated_at columns
// do not exist on products, categories, suppliers, purchase_orders,
// stock_transfers, shifts. Those tables must stay full-load-only without
// turning every pull into an error; every other failure must still count.
// ----------------------------------------------------------------------
const MISSING_044 = ["products", "categories", "suppliers", "purchase_orders", "stock_transfers", "shifts"];
const missingColumn = (table: string) => ({ message: `column ${table}.updated_at does not exist`, code: "42703" });

/** A server where `tables` exist with the given rows; tables in `noUpdatedAt` fail any updated_at filter like PostgREST does. */
function serveSchema(rows: Record<string, Record<string, unknown>[]>, noUpdatedAt: string[]) {
  const pg = createFakePostgrest({
    tables: rows,
    beforeRequest: (req) =>
      noUpdatedAt.includes(req.table) && req.filters.some((f) => f.includes("updated_at")) ? missingColumn(req.table) : undefined,
  });
  fromMock.mockImplementation((table: string) => pg.from(table));
  return pg;
}
const brandRow = (id: string, updatedAt: string) => ({ id, category_id: "c1", name: id, is_active: true, sort_order: 0, created_at: "t0", updated_at: updatedAt });

describe("H1: delta sync on a schema without migration 044's updated_at", () => {
  const SERVER = "2026-03-01T12:00:00.000Z";
  const legacyProduct = { id: "p1", name: "Tea", sku: "S", created_at: "t0" }; // no updatedAt after mapping

  it("current schema: loaded rows without updatedAt get NO cursor (no request is ever sent); compatible tables still get one", async () => {
    await bootstrapDeltaCursors({
      ...emptySnapshot,
      products: [{ id: "p1", name: "Tea" } as never],
      brands: [{ id: "b1", categoryId: "c1", name: "B", isActive: true, sortOrder: 0, createdAt: "t0", updatedAt: "2026-02-01T00:00:00Z" } as never],
    }, SERVER);
    expect(await localDb.syncMeta.get("products")).toBeUndefined();
    expect(await localDb.syncMeta.get("brands")).toMatchObject({ lastPulledAt: new Date(Date.parse(SERVER) - COMMIT_LAG_MS).toISOString() });
    expect(deltaSyncCompatibility()).toEqual([{ table: "products", reason: "the loaded rows carry no updated_at" }]);
  });

  it("current schema: the six tables answer 42703 — the pull is NOT an error, their cursors are dropped, compatible tables are still delta-pulled", async () => {
    // Empty tables at load time get a cursor (nothing showed the column is missing).
    for (const t of MISSING_044) await localDb.syncMeta.put({ table: t, lastPulledAt: "2026-01-01T00:00:00Z", lastPulledId: "" });
    await localDb.syncMeta.put({ table: "brands", lastPulledAt: "2026-01-01T00:00:00Z", lastPulledId: "" });
    const pg = serveSchema({ products: [legacyProduct], brands: [brandRow("b-new", "2026-02-01T00:00:00Z")] }, MISSING_044);

    const first = await pullDeltaChanges(emptySnapshot);
    expect(first.hadErrors).toBe(false);
    expect(first.changes.brands?.map((b) => b.id)).toEqual(["b-new"]);
    for (const t of MISSING_044) expect(await localDb.syncMeta.get(t)).toBeUndefined();
    expect(deltaSyncCompatibility().map((c) => c.table).sort()).toEqual([...MISSING_044].sort());

    // Later pulls send nothing for them: no repeated failing requests.
    const before = pg.requests.length;
    const second = await pullDeltaChanges(emptySnapshot);
    expect(second.hadErrors).toBe(false);
    expect(pg.requests.slice(before).map((r) => r.table)).not.toEqual(expect.arrayContaining(["products"]));
  });

  it("a later full load does not re-seed a table already in compatibility mode", async () => {
    await localDb.syncMeta.put({ table: "shifts", lastPulledAt: "2026-01-01T00:00:00Z", lastPulledId: "" });
    serveSchema({}, ["shifts"]);
    await pullDeltaChanges(emptySnapshot);
    await bootstrapDeltaCursors(emptySnapshot, SERVER); // shifts empty: would otherwise be seeded
    expect(await localDb.syncMeta.get("shifts")).toBeUndefined();
  });

  it("does not hide unrelated failures: 42703 on another column, on a compatible table, or another error code", async () => {
    expect(isMissingUpdatedAtColumn("products", missingColumn("products"))).toBe(true);
    expect(isMissingUpdatedAtColumn("products", { code: "42703", message: "column products.is_active does not exist" })).toBe(false);
    expect(isMissingUpdatedAtColumn("products", { code: "42703", message: "column categories.updated_at does not exist" })).toBe(false);
    expect(isMissingUpdatedAtColumn("brands", missingColumn("brands"))).toBe(false); // brands is not a 044 table
    expect(isMissingUpdatedAtColumn("products", { code: "42P01", message: "relation products.updated_at does not exist" })).toBe(false);
    expect(isMissingUpdatedAtColumn("products", { code: "PGRST301", message: "JWT expired" })).toBe(false);

    await localDb.syncMeta.put({ table: "brands", lastPulledAt: "2026-01-01T00:00:00Z", lastPulledId: "" });
    serveSchema({}, ["brands"]); // a compatible table failing the same way is a real fault
    const res = await pullDeltaChanges(emptySnapshot);
    expect(res.hadErrors).toBe(true);
    expect(await localDb.syncMeta.get("brands")).toBeDefined(); // cursor kept: nothing marked synced
    expect(deltaSyncCompatibility()).toEqual([]);
  });

  it("a genuine failure on one of the six tables (not a missing column) is still an error and keeps its cursor", async () => {
    await localDb.syncMeta.put({ table: "products", lastPulledAt: "2026-01-01T00:00:00Z", lastPulledId: "" });
    fromMock.mockImplementation(() => queryReturning({ error: { message: "permission denied for table products" } }));
    const res = await pullDeltaChanges(emptySnapshot);
    expect(res.hadErrors).toBe(true);
    expect((await localDb.syncMeta.get("products"))?.lastPulledAt).toBe("2026-01-01T00:00:00Z");
  });

  it("future schema (044 applied): products carry updated_at, get a server-time cursor and are delta-pulled", async () => {
    await bootstrapDeltaCursors({ ...emptySnapshot, products: [{ id: "p1", name: "Tea", updatedAt: "2026-02-01T00:00:00Z" } as never] }, SERVER);
    expect(await localDb.syncMeta.get("products")).toMatchObject({ lastPulledAt: new Date(Date.parse(SERVER) - COMMIT_LAG_MS).toISOString() });
    serveSchema({ products: [{ ...legacyProduct, id: "p2", updated_at: "2026-03-01T12:30:00Z" }] }, []);
    const res = await pullDeltaChanges(emptySnapshot);
    expect(res.hadErrors).toBe(false);
    expect(res.changes.products?.map((p) => p.id)).toEqual(["p2"]);
    expect(deltaSyncCompatibility()).toEqual([]);
  });
});
