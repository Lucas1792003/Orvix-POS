import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fromMock = vi.fn();
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    // The drain verifies the session before replaying (see outbox.ts).
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "auth-1" } } }, error: null }) },
  },
}));

import { writeTableRow } from "./tableWrite";
import { drainOutbox } from "./outbox";
import { localDb } from "../../lib/localDb";

beforeEach(async () => {
  fromMock.mockReset();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  vi.stubGlobal("navigator", { onLine: false });
});
afterEach(() => vi.unstubAllGlobals());

describe("writeTableRow offline", () => {
  it("queues an insert and mirrors the app-shape row locally, without touching the network", async () => {
    const { error } = await writeTableRow({
      table: "categories",
      op: "insert",
      row: { id: "cat-1", name: "Drinks", color: "blue", is_active: true, created_at: "t0" },
      appRow: { id: "cat-1", name: "Drinks", color: "blue", isActive: true, createdAt: "t0" },
      id: "cat-1",
    });

    expect(error).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
    expect((await localDb.categories.get("cat-1"))?.name).toBe("Drinks");
    const queued = await localDb.syncOutbox.toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "table_write", table: "categories", op: "insert", id: "cat-1" });
  });

  it("falls back to queueing when the live insert fails as a network error", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    fromMock.mockReturnValue({ insert: () => Promise.reject(new TypeError("Failed to fetch")) });

    const { error } = await writeTableRow({
      table: "brands", op: "insert",
      row: { id: "b1", category_id: "c1", name: "Grand Royal", is_active: true, sort_order: 0 },
      appRow: { id: "b1", categoryId: "c1", name: "Grand Royal", isActive: true, sortOrder: 0 },
      id: "b1",
    });

    expect(error).toBeNull();
    expect(await localDb.syncOutbox.count()).toBe(1);
  });

  it("surfaces a genuine (non-network) error without queueing anything", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    fromMock.mockReturnValue({ insert: () => Promise.resolve({ error: { message: "duplicate key value" } }) });

    const { error } = await writeTableRow({
      table: "suppliers", op: "insert",
      row: { id: "s1", code: "SUP1", name: "Acme", is_active: true, created_at: "t0" },
      appRow: { id: "s1", code: "SUP1", name: "Acme", isActive: true, createdAt: "t0" },
      id: "s1",
    });

    expect(error).toEqual({ message: "duplicate key value" });
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(await localDb.suppliers.get("s1")).toBeUndefined();
  });

  it("replays a queued update against Supabase on drain and clears the outbox — no reconciliation needed", async () => {
    await writeTableRow({
      table: "unit_types", op: "update",
      row: { name: "Carton", is_active: true, sort_order: 1 },
      appRow: { id: "ut-1", name: "Carton", isActive: true, sortOrder: 1 },
      id: "ut-1",
    });
    expect(await localDb.unitTypes.get("ut-1")).toMatchObject({ name: "Carton" });

    vi.stubGlobal("navigator", { onLine: true });
    const eq = vi.fn(() => Promise.resolve({ error: null }));
    fromMock.mockReturnValue({ update: () => ({ eq }) });

    await drainOutbox();

    expect(fromMock).toHaveBeenCalledWith("unit_types");
    expect(eq).toHaveBeenCalledWith("id", "ut-1");
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("deletes the local mirror row for a queued delete replayed on drain", async () => {
    await localDb.priceTiers.put({ id: "pt-1", productId: "p1", minQty: 1, priceMmk: 100, isActive: true, createdAt: "t0", createdBy: "u1" });
    await writeTableRow({ table: "price_tiers", op: "delete", row: {}, id: "pt-1" });
    expect(await localDb.priceTiers.get("pt-1")).toBeUndefined();

    vi.stubGlobal("navigator", { onLine: true });
    const eq = vi.fn(() => Promise.resolve({ error: null }));
    fromMock.mockReturnValue({ delete: () => ({ eq }) });
    await drainOutbox();

    expect(eq).toHaveBeenCalledWith("id", "pt-1");
    expect(await localDb.syncOutbox.count()).toBe(0);
  });
});
