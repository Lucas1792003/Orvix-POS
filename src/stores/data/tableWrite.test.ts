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
    fromMock.mockReturnValue({ insert: () => ({ select: () => Promise.reject(new TypeError("Failed to fetch")) }) });

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
    fromMock.mockReturnValue({ insert: () => ({ select: () => Promise.resolve({ error: { message: "duplicate key value" }, status: 409 }) }) });

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
    // Since Batch 2A every write asks for the affected row back (.select("id")).
    const eq = vi.fn(() => ({ select: () => Promise.resolve({ data: [{ id: "ut-1" }], error: null, status: 200 }) }));
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
    const eq = vi.fn(() => ({ select: () => Promise.resolve({ data: [{ id: "pt-1" }], error: null, status: 200 }) }));
    fromMock.mockReturnValue({ delete: () => ({ eq }) });
    await drainOutbox();

    expect(eq).toHaveBeenCalledWith("id", "pt-1");
    expect(await localDb.syncOutbox.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Batch 2A (P0-E / Q-H1, Q-H2): a write is acknowledged only when the server
// reports exactly the target row; nothing else deletes the queue entry.
// ---------------------------------------------------------------------------
describe("table write acknowledgement", () => {
  const queueUpdate = async () => {
    await writeTableRow({ table: "brands", op: "update", row: { name: "X" }, appRow: { id: "b1", name: "X" }, id: "b1" });
    vi.stubGlobal("navigator", { onLine: true });
  };
  const answerUpdate = (reply: unknown) => fromMock.mockReturnValue({ update: () => ({ eq: () => ({ select: () => Promise.resolve(reply) }) }) });

  it("a queued update that matched NO row (deleted elsewhere / not permitted) becomes a conflict, kept with its payload", async () => {
    await queueUpdate();
    answerUpdate({ data: [], error: null, status: 200 });
    await drainOutbox();
    const [entry] = await localDb.syncOutbox.toArray();
    expect(entry).toMatchObject({ status: "conflict", failureKind: "permanent", row: { name: "X" } });
    expect(entry.lastError).toMatch(/matched no row/);
  });

  it("an empty-bodied 404 (postgrest-js turns it into a 204 success) is NOT an acknowledgement: kept, in doubt", async () => {
    await queueUpdate();
    answerUpdate({ data: null, error: null, status: 204 });
    await drainOutbox();
    const [entry] = await localDb.syncOutbox.toArray();
    expect(entry).toMatchObject({ status: "pending", inDoubt: true, heldReason: "unrecognised-reply" });
  });

  it("an insert answered by a duplicate on ANOTHER unique index (e.g. shop name) is a conflict, never 'already applied'", async () => {
    await writeTableRow({ table: "shops", op: "insert", row: { id: "shop-new", name: "Main" }, appRow: { id: "shop-new", name: "Main" }, id: "shop-new" });
    vi.stubGlobal("navigator", { onLine: true });
    fromMock.mockReturnValue({ insert: () => ({ select: () => Promise.resolve({
      data: null, status: 409, error: { code: "23505", message: 'duplicate key value violates unique constraint "shops_org_name_key"' },
    }) }) });
    await drainOutbox();
    const [entry] = await localDb.syncOutbox.toArray();
    expect(entry.status).toBe("conflict");
  });

  it("an insert answered by a duplicate on its PRIMARY KEY is an earlier attempt that committed: acknowledged", async () => {
    await writeTableRow({ table: "shops", op: "insert", row: { id: "shop-new", name: "Main" }, appRow: { id: "shop-new", name: "Main" }, id: "shop-new" });
    vi.stubGlobal("navigator", { onLine: true });
    fromMock.mockReturnValue({ insert: () => ({ select: () => Promise.resolve({
      data: null, status: 409, error: { code: "23505", message: 'duplicate key value violates unique constraint "shops_pkey"' },
    }) }) });
    await drainOutbox();
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("an HTML 403 from an edge is held (not delivered), never a conflict", async () => {
    await queueUpdate();
    answerUpdate({ data: null, status: 403, error: { message: "<html><body>Access denied</body></html>" } });
    await drainOutbox();
    const [entry] = await localDb.syncOutbox.toArray();
    expect(entry).toMatchObject({ status: "pending", heldReason: "edge" });
  });

  it("online: an update that matched no row is returned as an error and nothing is queued or mirrored", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    answerUpdate({ data: [], error: null, status: 200 });
    const { error } = await writeTableRow({ table: "brands", op: "update", row: { name: "Y" }, appRow: { id: "b9", name: "Y" }, id: "b9" });
    expect(error?.message).toMatch(/matched no row/);
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(await localDb.brands.get("b9")).toBeUndefined();
  });
});
