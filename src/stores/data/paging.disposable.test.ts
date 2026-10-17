import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";

// ----------------------------------------------------------------------
// G-OFF-2 evidence on REAL PostgREST (v14.17, PGRST_DB_MAX_ROWS=1000) —
// the throwaway security-audit stack (tools/security-audit/run.sh
// --stack-only), seeded with synthetic rows. Proves what the in-memory
// emulator cannot: that PostgREST accepts the double-quoted keyset or()
// filters, compares microsecond timestamps exactly, and pages a composite
// key. Skipped unless DISPOSABLE_PG_URL/DISPOSABLE_PG_KEY are set, and
// refuses any host other than loopback: it can never touch lucashome.
// ----------------------------------------------------------------------

const URL_ = process.env.DISPOSABLE_PG_URL ?? "";
const KEY = process.env.DISPOSABLE_PG_KEY ?? "";
const loopback = (() => {
  try { return ["127.0.0.1", "localhost"].includes(new URL(URL_).hostname); } catch { return false; }
})();
const enabled = Boolean(URL_ && KEY);
if (enabled && !loopback) throw new Error("paging.disposable.test: DISPOSABLE_PG_URL must be a loopback address");

vi.mock("../../lib/supabase", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.DISPOSABLE_PG_URL || "http://127.0.0.1:9";
  const key = process.env.DISPOSABLE_PG_KEY || "unset";
  return { supabase: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) };
});

import { fetchAllRows, fetchAllRowsIn } from "./fetchAll";
import { deltaSyncCompatibility, isMissingUpdatedAtColumn, pullDeltaChanges, resetDeltaSyncCompatibilityForTests } from "./deltaSync";
import { localDb } from "../../lib/localDb";
import type { LocalSnapshot } from "./localSync";

const emptySnapshot = {
  categories: [], brands: [], unitTypes: [], products: [], productUnits: [], priceLevels: [],
  productUnitPrices: [], suppliers: [], purchaseOrders: [], stockTransfers: [], shifts: [],
} as unknown as LocalSnapshot;

describe.skipIf(!enabled)("paging on real PostgREST (disposable stack)", () => {
  it("reads all seeded products (> 1,000) with the keyset, each once", async () => {
    const res = await fetchAllRows({ table: "products", keys: ["id"], columns: "id", filter: (q) => q.gte("id", "zz-paging-") });
    expect(res.error).toBeNull();
    const ids = res.data!.map((r) => r.id as string).filter((id) => id.startsWith("zz-paging-"));
    expect(ids).toHaveLength(2500);
    expect(new Set(ids).size).toBe(2500);
  });

  it("pages the composite inventory key across two shops", async () => {
    const res = await fetchAllRows({ table: "inventory", keys: ["shop_id", "product_id"], filter: (q) => q.in("shop_id", ["zz-paging-shop-a", "zz-paging-shop-b"]) });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2600);
    expect(new Set(res.data!.map((r) => `${r.shop_id}|${r.product_id}`)).size).toBe(2600);
  });

  it("scoped child reads: chunked IN + paging", async () => {
    const res = await fetchAllRowsIn({
      table: "inventory", keys: ["shop_id", "product_id"], column: "shop_id",
      values: ["zz-paging-shop-a", "zz-paging-shop-b"], chunkSize: 1,
    });
    expect(res.data).toHaveLength(2600);
  });

  it("delta keyset: 2,500 rows sharing one microsecond updated_at are pulled completely and the cursor stops on (T, last id)", async () => {
    // unit_types: a delta table that has updated_at on this schema
    // (products/categories/suppliers/purchase_orders/stock_transfers/shifts
    // lack it: migration 044 is recorded but its columns do not exist — same
    // as production, verified read-only on lucashome 2026-10-16).
    const T = process.env.DISPOSABLE_PG_T ?? "";
    expect(T).not.toBe("");
    await Promise.all(localDb.tables.map((t) => t.clear()));
    await localDb.syncMeta.put({ table: "unit_types", lastPulledAt: new Date(Date.parse(T) - 60_000).toISOString(), lastPulledId: "" });
    const first = await pullDeltaChanges(emptySnapshot);
    const pulled = (first.changes.unitTypes ?? []).filter((u) => u.id.startsWith("zz-paging-"));
    expect(pulled).toHaveLength(2500);
    expect(new Set(pulled.map((u) => u.id)).size).toBe(2500);
    const cursor = await localDb.syncMeta.get("unit_types");
    expect(cursor!.lastPulledAt).toBe(T.replace("Z", "+00:00"));
    expect(cursor!.lastPulledId).toBe("zz-paging-02499");
    // nothing new: the next pull returns no seeded rows (exact µs equality held)
    const second = await pullDeltaChanges(emptySnapshot);
    expect((second.changes.unitTypes ?? []).filter((u) => u.id.startsWith("zz-paging-"))).toHaveLength(0);
  });

  it("H1 on the real schema: the six tables without updated_at answer 42703 for exactly that column, and the pull treats them as full-load-only — not as an error", async () => {
    // Before Batch 1-code the client never queried these tables by updated_at
    // (no cursor was seeded from rows without the column). Batch 1-code's
    // first version seeded them from server time, so every pull failed; this
    // pins the corrected behaviour against real PostgREST.
    const { supabase } = await import("../../lib/supabase");
    const probe = await supabase.from("products").select("id").gt("updated_at", "2026-01-01T00:00:00Z").limit(1);
    expect(probe.error?.code).toBe("42703");
    expect(isMissingUpdatedAtColumn("products", probe.error)).toBe(true);

    await Promise.all(localDb.tables.map((t) => t.clear()));
    resetDeltaSyncCompatibilityForTests();
    for (const t of ["products", "categories", "suppliers", "purchase_orders", "stock_transfers", "shifts"]) {
      await localDb.syncMeta.put({ table: t, lastPulledAt: "2026-01-01T00:00:00Z", lastPulledId: "" });
    }
    const res = await pullDeltaChanges(emptySnapshot);
    expect(res.hadErrors).toBe(false);
    expect(res.changes.products).toBeUndefined();
    expect(deltaSyncCompatibility().map((c) => c.table).sort()).toEqual(
      ["categories", "products", "purchase_orders", "shifts", "stock_transfers", "suppliers"],
    );
  });
});
