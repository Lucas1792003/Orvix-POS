import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/supabase", () => ({ supabase: {} }));

import { fetchAllRows, fetchAllRowsIn, quoteFilterValue, type ReadClient } from "./fetchAll";
import { createFakePostgrest, type FakeRow } from "./testing/fakePostgrest";

const asClient = (pg: { from: (t: string) => unknown }) => pg as unknown as ReadClient;
const rowsWithIds = (n: number, prefix = "p") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(5, "0")}`, n: i }));

describe("fetchAllRows (ORV-001)", () => {
  it("returns every row past the server's silent 1,000-row cap, each exactly once, in key order", async () => {
    const pg = createFakePostgrest({ tables: { products: rowsWithIds(2500) } });
    const res = await fetchAllRows({ table: "products", keys: ["id"], client: asClient(pg) });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2500);
    expect(new Set(res.data!.map((r) => r.id)).size).toBe(2500);
    expect(res.data![0].id).toBe("p-00000");
    expect(res.data![2499].id).toBe("p-02499");
    expect(pg.requests).toHaveLength(4); // 3 pages + the empty page
  });

  it("stays complete when the server cap is LOWER than the page size (stops only on an empty page)", async () => {
    const pg = createFakePostgrest({ tables: { products: rowsWithIds(1234) }, maxRows: 300 });
    const res = await fetchAllRows({ table: "products", keys: ["id"], client: asClient(pg) });
    expect(res.data).toHaveLength(1234);
  });

  it("pages a two-column key (inventory: shop_id, product_id) across shops", async () => {
    const inventory: FakeRow[] = [];
    for (const shop of ["shop-a", "shop-b", "shop-c"]) {
      for (let i = 0; i < 900; i += 1) inventory.push({ shop_id: shop, product_id: `p-${String(i).padStart(4, "0")}`, qty_base_units: i });
    }
    const pg = createFakePostgrest({ tables: { inventory } });
    const res = await fetchAllRows({ table: "inventory", keys: ["shop_id", "product_id"], client: asClient(pg) });
    expect(res.data).toHaveLength(2700);
    expect(new Set(res.data!.map((r) => `${r.shop_id}|${r.product_id}`)).size).toBe(2700);
  });

  it("applies the caller's filter on every page", async () => {
    const inventory = Array.from({ length: 2500 }, (_, i) => ({ shop_id: i % 2 ? "s1" : "s2", product_id: `p${String(i).padStart(5, "0")}` }));
    const pg = createFakePostgrest({ tables: { inventory } });
    const res = await fetchAllRows({ table: "inventory", keys: ["shop_id", "product_id"], filter: (q) => q.eq("shop_id", "s1"), client: asClient(pg) });
    expect(res.data).toHaveLength(1250);
    expect(res.data!.every((r) => r.shop_id === "s1")).toBe(true);
  });

  it("keys containing , . ( ) and quotes cannot break the keyset filter", async () => {
    const odd = ['a,b', 'a.b', 'a(b)', 'a"b', 'a\\b', "plain"];
    const inventory = odd.flatMap((shop) => Array.from({ length: 400 }, (_, i) => ({ shop_id: shop, product_id: `p${String(i).padStart(3, "0")}` })));
    const pg = createFakePostgrest({ tables: { inventory } });
    const res = await fetchAllRows({ table: "inventory", keys: ["shop_id", "product_id"], client: asClient(pg) });
    expect(res.data).toHaveLength(2400);
    expect(quoteFilterValue('a"b')).toBe('"a\\"b"');
  });

  it("all-or-nothing: a failed page returns an error and NO rows", async () => {
    const pg = createFakePostgrest({
      tables: { products: rowsWithIds(2500) },
      beforeRequest: (req) => (req.index === 2 ? { message: "JWT expired", code: "PGRST301" } : undefined),
    });
    const res = await fetchAllRows({ table: "products", keys: ["id"], client: asClient(pg) });
    expect(res.data).toBeNull();
    expect(res.error).toEqual({ message: "JWT expired", code: "PGRST301" });
  });

  it("all-or-nothing: an interrupted request (rejected fetch) returns an error, never a short list", async () => {
    const pg = createFakePostgrest({ tables: { products: rowsWithIds(2500) }, beforeRequest: (req) => (req.index === 1 ? "throw" : undefined) });
    const res = await fetchAllRows({ table: "products", keys: ["id"], client: asClient(pg) });
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/Failed to fetch/);
  });

  it("rows present for the whole read are returned exactly once even when others are inserted/deleted between pages", async () => {
    const tables = { products: rowsWithIds(2500) as FakeRow[] };
    const pg = createFakePostgrest({
      tables,
      beforeRequest: (req) => {
        if (req.index === 1) {
          // Insert rows sorting BEFORE the cursor and delete one already read
          // — an offset pager would now skip or repeat rows.
          tables.products = [{ id: "a-new-1", n: -1 }, { id: "a-new-2", n: -2 }, ...tables.products.filter((r) => r.id !== "p-00003")];
        }
        return undefined;
      },
    });
    const res = await fetchAllRows({ table: "products", keys: ["id"], client: asClient(pg) });
    const got = res.data!.map((r) => r.id as string);
    expect(new Set(got).size).toBe(got.length); // no duplicates
    for (let i = 4; i < 2500; i += 1) expect(got).toContain(`p-${String(i).padStart(5, "0")}`);
  });

  it("refuses to loop when the server ignores the keyset filter", async () => {
    const rows = rowsWithIds(1500);
    const ignoring: ReadClient = {
      from: () => {
        const b = {
          select: () => b, eq: () => b, in: () => b, gt: () => b, gte: () => b, lte: () => b, or: () => b, order: () => b,
          limit: () => b,
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows.slice(0, 1000), error: null }).then(ok),
        };
        return b as never;
      },
    };
    const res = await fetchAllRows({ table: "products", keys: ["id"], client: ignoring });
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/did not advance/);
  });
});

describe("fetchAllRowsIn", () => {
  it("chunks the ids and pages each chunk: 120 sales × 12 items = 1,440 items, complete", async () => {
    const saleIds = Array.from({ length: 120 }, (_, i) => `sale-${String(i).padStart(3, "0")}`);
    const items = saleIds.flatMap((sid) => Array.from({ length: 12 }, (_, j) => ({ id: `${sid}-item-${String(j).padStart(2, "0")}`, sale_id: sid })));
    items.push({ id: "other-item", sale_id: "sale-not-loaded" });
    const pg = createFakePostgrest({ tables: { sale_items: items } });
    const res = await fetchAllRowsIn({ table: "sale_items", keys: ["id"], column: "sale_id", values: saleIds, client: asClient(pg) });
    expect(res.data).toHaveLength(1440);
    expect(res.data!.some((r) => r.sale_id === "sale-not-loaded")).toBe(false);
    // 2 chunks of ≤ 100 ids; the first chunk (1,200 items) needed 2 pages + end
    expect(pg.requests.every((r) => r.filters.some((f) => /^sale_id=in\.\((\d+)\)$/.test(f) && Number(f.match(/\d+/)![0]) <= 100))).toBe(true);
  });

  it("fails as a whole when any chunk fails", async () => {
    const saleIds = Array.from({ length: 250 }, (_, i) => `s${i}`);
    const items = saleIds.map((sid) => ({ id: `${sid}-i`, sale_id: sid }));
    const pg = createFakePostgrest({ tables: { sale_items: items }, beforeRequest: (req) => (req.index === 2 ? { message: "timeout" } : undefined) });
    const res = await fetchAllRowsIn({ table: "sale_items", keys: ["id"], column: "sale_id", values: saleIds, client: asClient(pg) });
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe("timeout");
  });

  it("returns an empty list for no ids without any request", async () => {
    const pg = createFakePostgrest({ tables: { sale_items: [] } });
    const res = await fetchAllRowsIn({ table: "sale_items", keys: ["id"], column: "sale_id", values: [], client: asClient(pg) });
    expect(res).toEqual({ data: [], error: null });
    expect(pg.requests).toHaveLength(0);
  });
});
