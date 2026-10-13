import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { localDb } from "../../lib/localDb";
import { persistSnapshotToLocal, readLocalSnapshot, type LocalSnapshot } from "./localSync";
import type { Shop } from "../../types";

const shop = (id: string): Shop => ({
  id, code: id, name: `Shop ${id}`, address: "1 Main St", isActive: true, createdAt: "2026-01-01T00:00:00Z",
});

const emptySnapshot: LocalSnapshot = {
  shops: [], users: [], categories: [], brands: [], unitTypes: [], products: [], productUnits: [],
  barcodes: [], priceTiers: [], priceLevels: [], productUnitPrices: [], inventory: [], movements: [],
  suppliers: [], purchaseOrders: [], purchaseOrderItems: [], supplierPayments: [], supplierProducts: [],
  stockTransfers: [], stockTransferItems: [], shifts: [], sales: [], saleItems: [], reprintLogs: [],
  refunds: [], auditLogs: [], businessProfile: null,
};

describe("localSync", () => {
  beforeEach(async () => {
    await Promise.all(localDb.tables.map((table) => table.clear()));
  });

  it("returns null before any snapshot has ever been persisted", async () => {
    expect(await readLocalSnapshot()).toBeNull();
  });

  it("round-trips a full snapshot through IndexedDB", async () => {
    const snapshot: LocalSnapshot = {
      ...emptySnapshot,
      shops: [shop("shop-1"), shop("shop-2")],
      businessProfile: { businessName: "Shwe Pha La" },
    };

    await persistSnapshotToLocal(snapshot);
    const restored = await readLocalSnapshot();

    expect(restored).not.toBeNull();
    expect(restored?.shops.map((s) => s.id).sort()).toEqual(["shop-1", "shop-2"]);
    expect(restored?.businessProfile).toEqual({ businessName: "Shwe Pha La" });
  });

  // Phase D (production-dependencies audit §8, private ops notes, A8): a full load used to
  // clear EVERY Dexie table — a sale queued while offline could be wiped by
  // the reload that happens on reconnect, before it was ever replayed.
  it("does not clear the outbox, id map, cursors, auth cache or sync state", async () => {
    await localDb.syncOutbox.put({
      localId: "outbox-1", kind: "rpc", name: "complete_sale", args: { p_idempotency_key: "k1" },
      idempotencyKey: "k1", shopId: "shop-1", createdAt: "2026-01-01T00:00:00Z", status: "pending", attempts: 0,
    });
    await localDb.provisionalIdMap.put({ provisionalId: "shift-local-1", realId: "shift-1", createdAt: "2026-01-01T00:00:00Z" });
    await localDb.syncMeta.put({ table: "categories", lastPulledAt: "2026-01-01T00:00:00Z" });
    await localDb.authCache.put({
      authId: "auth-1", userId: "user-1", role: "CASHIER", shopId: "shop-1", orgId: null,
      isActive: true, hasTotp: false, cachedAt: "2026-01-01T00:00:00Z",
    });
    await localDb.syncState.put({ key: "needs-reauth", flag: true, updatedAt: "2026-01-01T00:00:00Z" });

    await persistSnapshotToLocal({ ...emptySnapshot, shops: [shop("shop-1")] });

    expect(await localDb.syncOutbox.get("outbox-1")).toMatchObject({ status: "pending", idempotencyKey: "k1" });
    expect(await localDb.provisionalIdMap.get("shift-local-1")).toBeDefined();
    expect((await localDb.syncMeta.get("categories"))?.lastPulledAt).toBe("2026-01-01T00:00:00Z");
    expect(await localDb.authCache.get("auth-1")).toBeDefined();
    expect((await localDb.syncState.get("needs-reauth"))?.flag).toBe(true);
    // ...while the snapshot tables themselves are still fully replaced.
    expect((await readLocalSnapshot())?.shops.map((s) => s.id)).toEqual(["shop-1"]);
  });

  it("replaces stale rows instead of accumulating them across syncs", async () => {
    await persistSnapshotToLocal({ ...emptySnapshot, shops: [shop("shop-1")] });
    await persistSnapshotToLocal({ ...emptySnapshot, shops: [shop("shop-2")] });

    const restored = await readLocalSnapshot();
    // shop-1 must be gone — a full sync fully replaces the mirror so a shop
    // deleted/renamed on the server doesn't linger in the local cache forever.
    expect(restored?.shops.map((s) => s.id)).toEqual(["shop-2"]);
  });
});
