import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// P-4 client side: cost reaches memory / IndexedDB only for report:shop_profit,
// is laid on from the gated tables, and is scrubbed on logout / account
// switch / start-up WITHOUT deleting any row (offline sales and the outbox stay).

const from = vi.fn();
vi.mock("../../lib/supabase", () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));

import { localDb } from "../../lib/localDb";
import {
  applyCostOverlay,
  fetchCostOverlay,
  fetchProductCosts,
  scrubLocalCostCache,
  stripLineCost,
  stripProductCost,
  stripUnitCost,
  userMayViewCost,
} from "./costPrivacy";
import type { Product, ProductUnit, SaleItem, User } from "../../types";

let seq = 0;
const user = (role: string, granted: string[] = [], revoked: string[] = []) =>
  ({ id: `u-${role}-${++seq}`, name: role, role, isActive: true, grantedPermissions: granted, revokedPermissions: revoked }) as unknown as User;

/** A chainable PostgREST stub answering every query of `table` with `reply`. */
function stub(replies: Record<string, { data: unknown; error: unknown }>) {
  const served = new Set<string>();
  from.mockImplementation((table: string) => {
    // first page: the reply; later pages: empty (fetchAllRows pages until an empty page)
    const first = !served.has(table) || (replies[table]?.error ?? null) !== null;
    served.add(table);
    const reply = first ? (replies[table] ?? { data: [], error: null }) : { data: [], error: null };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "in", "gt", "or", "order", "eq", "filter"]) q[m] = () => q;
    q.limit = () => Promise.resolve(reply);
    q.then = (res: (v: unknown) => unknown) => Promise.resolve(reply).then(res);
    return q;
  });
}

beforeEach(async () => {
  from.mockReset();
  await Promise.all(localDb.tables.map((t) => t.clear()));
});

describe("who may see cost", () => {
  it("only report:shop_profit (ADMIN by default; a granted manager; never a cashier)", () => {
    const admin = user("ADMIN"), mgr = user("MANAGER"), mgrP = user("MANAGER", ["report:shop_profit"]), cash = user("CASHIER");
    const revokedAdmin = user("ADMIN", [], ["report:shop_profit"]);
    const all = [admin, mgr, mgrP, cash, revokedAdmin];
    expect(userMayViewCost(all, admin.id)).toBe(true);
    expect(userMayViewCost(all, mgr.id)).toBe(false);
    expect(userMayViewCost(all, mgrP.id)).toBe(true);
    expect(userMayViewCost(all, cash.id)).toBe(false);
    expect(userMayViewCost([revokedAdmin], revokedAdmin.id)).toBe(false);
    expect(userMayViewCost(all, null)).toBe(false);
    expect(userMayViewCost(all, "nobody")).toBe(false);
  });
});

describe("applyCostOverlay", () => {
  const snap = () => ({
    products: [{ id: "p1", costMmk: 600 } as Product, { id: "p2" } as Product],
    productUnits: [{ id: "u1", purchasePriceMmk: 550 } as ProductUnit],
    saleItems: [{ id: "i1", unitCostMmkSnapshot: 600 } as SaleItem, { id: "i2" } as SaleItem],
  });
  it("a user without the permission gets every cost field removed (even if an older server sent them)", () => {
    const r = applyCostOverlay(snap(), { products: new Map([["p2", 1]]), units: new Map(), lines: new Map() }, false);
    expect(r.products.every((p) => !("costMmk" in p))).toBe(true);
    expect(r.productUnits.every((u) => !("purchasePriceMmk" in u))).toBe(true);
    expect(r.saleItems.every((i) => !("unitCostMmkSnapshot" in i))).toBe(true);
  });
  it("a permitted user gets the gated tables' values laid on", () => {
    const r = applyCostOverlay(
      { products: [{ id: "p1" } as Product], productUnits: [{ id: "u1" } as ProductUnit], saleItems: [{ id: "i1" } as SaleItem] },
      { products: new Map([["p1", 600]]), units: new Map([["u1", 550]]), lines: new Map([["i1", 600]]) },
      true,
    );
    expect(r.products[0].costMmk).toBe(600);
    expect(r.productUnits[0].purchasePriceMmk).toBe(550);
    expect(r.saleItems[0].unitCostMmkSnapshot).toBe(600);
  });
  it("a permitted user on a server without the cost tables keeps the legacy column values", () => {
    expect(applyCostOverlay(snap(), null, true).products[0].costMmk).toBe(600);
  });
  it("strip helpers do not mutate their input", () => {
    const p = { id: "p", costMmk: 1 } as Product;
    expect(stripProductCost(p)).not.toHaveProperty("costMmk");
    expect(p.costMmk).toBe(1);
    expect(stripUnitCost({ id: "u", purchasePriceMmk: 1 } as ProductUnit)).not.toHaveProperty("purchasePriceMmk");
    expect(stripLineCost({ id: "i", unitCostMmkSnapshot: 1 } as SaleItem)).not.toHaveProperty("unitCostMmkSnapshot");
  });
});

describe("fetchCostOverlay", () => {
  it("reads the three gated tables", async () => {
    stub({
      product_costs: { data: [{ product_id: "p1", cost_mmk: 600 }], error: null },
      product_unit_costs: { data: [{ product_unit_id: "u1", purchase_price_mmk: 550 }], error: null },
      sale_item_costs: { data: [{ sale_item_id: "i1", unit_cost_mmk: 600 }], error: null },
    });
    const o = await fetchCostOverlay(["s1"]);
    expect(o?.products.get("p1")).toBe(600);
    expect(o?.units.get("u1")).toBe(550);
    expect(o?.lines.get("i1")).toBe(600);
  });
  it("a server without the cost tables -> null (legacy columns stay the source), never a thrown error", async () => {
    stub({ product_costs: { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.product_costs'" } } });
    await expect(fetchCostOverlay([])).resolves.toBeNull();
    stub({ product_costs: { data: null, error: { code: "PGRST205", message: "x" } } });
    await expect(fetchProductCosts(["p1"])).resolves.toBeNull();
  });
  it("any other failure throws (the caller keeps the cost it holds; never a silent empty map = cost 0)", async () => {
    stub({ product_unit_costs: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } });
    await expect(fetchCostOverlay(["s1"])).rejects.toThrow(/cost rows unavailable/);
    stub({ product_costs: { data: null, error: { code: "08006", message: "connection failure" } } });
    await expect(fetchProductCosts(["p1"])).rejects.toThrow(/unavailable/);
  });
  it("a user RLS gives no rows (cashier on a PCOST server) -> empty maps", async () => {
    stub({});
    const o = await fetchCostOverlay(["s1"]);
    expect(o?.products.size).toBe(0);
    expect(o?.lines.size).toBe(0);
  });
});

describe("scrubLocalCostCache", () => {
  it("removes only the cost fields: every row (incl. an offline, provisional sale line) and the outbox stay", async () => {
    await localDb.products.bulkPut([{ id: "p1", name: "Tea", costMmk: 600 } as unknown as Product]);
    await localDb.productUnits.bulkPut([{ id: "u1", productId: "p1", purchasePriceMmk: 550 } as unknown as ProductUnit]);
    await localDb.saleItems.bulkPut([
      { id: "i1", saleId: "s1", unitCostMmkSnapshot: 600 } as unknown as SaleItem,
      { id: "i-provisional", saleId: "sale-offline-1", qtyUnits: 2 } as unknown as SaleItem,
    ]);
    await localDb.syncOutbox.put({
      localId: "outbox-1", kind: "rpc", name: "complete_sale", args: { p_items: [] }, status: "pending",
      createdAt: new Date().toISOString(), attempts: 0, idempotencyKey: "k-1",
    } as never);

    await scrubLocalCostCache();

    const p = await localDb.products.get("p1");
    const u = await localDb.productUnits.get("u1");
    const items = await localDb.saleItems.toArray();
    expect(p).toMatchObject({ id: "p1", name: "Tea" });
    expect(p).not.toHaveProperty("costMmk");
    expect(u).not.toHaveProperty("purchasePriceMmk");
    expect(items.map((i) => i.id).sort()).toEqual(["i-provisional", "i1"]);
    expect(items.every((i) => !("unitCostMmkSnapshot" in i))).toBe(true);
    expect(await localDb.syncOutbox.count()).toBe(1);
  });
});
