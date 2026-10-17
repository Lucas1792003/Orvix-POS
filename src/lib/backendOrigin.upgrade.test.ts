// Release 1.0.16, blocker D-d: a till auto-updated from v1.0.15 (hosted
// Supabase) to 1.0.16 (self-hosted) opens the SAME app profile. Simulates
// that profile — the v1.0.15 Dexie schema (version 1) with untagged pending
// outbox entries, a hosted catalogue snapshot, an offline auth cache row and
// the hosted auth session in localStorage — and opens it with this build:
//   * the entries are quarantined (kept, never sent: zero requests to either
//     backend for them), the export still contains them;
//   * the hosted catalogue / cursors / auth cache are discarded, so the
//     catalogue is fetched fresh from the new backend;
//   * the hosted session is removed and no session exists for the new
//     backend: sign-in required.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeAll } from "vitest";
import Dexie from "dexie";
import { createClient } from "@supabase/supabase-js";

const rpc = vi.fn();
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "auth-1" }, expires_at: 9_999_999_999 } }, error: null }) },
  },
}));

import { localDb, SYNC_STATE_KEYS } from "./localDb";
import { authStorageKeyFor, currentBackendOrigin, prepareLocalStateForBackend } from "./backendOrigin";
import { drainOutbox, enqueueOutbox, refreshSyncStatus } from "../stores/data/outbox";
import { readLocalSnapshot } from "../stores/data/localSync";
import { useSyncStore } from "../stores/syncStore";
import { collectQueueExport } from "./queueExport/collect";
import { decryptQueueExport, encryptQueueExport } from "./queueExport/format";
import { TEST_BACKEND_URL, TEST_BACKEND_ANON_KEY } from "../test/setup";
import { validReply } from "../stores/data/testing/validReplies";

// v1.0.15's `shwe-phala-local` schema (git show v1.0.15:src/lib/localDb.ts).
const V1015_STORES = {
  shops: "id", users: "id", categories: "id", brands: "id, categoryId", unitTypes: "id",
  products: "id, category, brandId", productUnits: "id, productId", barcodes: "id, productId",
  priceTiers: "id, productId", priceLevels: "id", productUnitPrices: "id, productUnitId",
  inventory: "[shopId+productId], shopId, productId", movements: "id, shopId, productId, createdAt",
  suppliers: "id", purchaseOrders: "id, shopId, supplierId", purchaseOrderItems: "id, purchaseOrderId",
  supplierPayments: "id, supplierId, purchaseOrderId", supplierProducts: "[supplierId+productId], supplierId, productId",
  stockTransfers: "id, fromShopId, toShopId", stockTransferItems: "id, transferId", shifts: "id, shopId, cashierId",
  sales: "id, shopId, shiftId, createdAt", saleItems: "id, saleId", reprintLogs: "id, saleId", refunds: "id, saleId",
  auditLogs: "id, shopId, createdAt", businessProfile: "key", syncOutbox: "localId, status, shopId, createdAt",
  syncMeta: "table", provisionalIdMap: "provisionalId", authCache: "authId",
};

const HOSTED_REF = "gzqiukxnzfdouwaotelx";
const HOSTED_KEY = `sb-${HOSTED_REF}-auth-token`;

class MemoryStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const storage = new MemoryStorage();
const fetchSpy = vi.fn(async () => { throw new Error("no network in this test"); });

beforeAll(async () => {
  // ---- what a v1.0.15 till leaves behind -----------------------------
  const old = new Dexie("shwe-phala-local");
  old.version(1).stores(V1015_STORES);
  await old.open();
  await old.table("syncOutbox").bulkPut([
    { localId: "outbox-1015-shift", kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-h", p_opening_cash_mmk: 0, p_expected_actor_id: "u-h" },
      shopId: "shop-h", createdAt: "2026-10-12T08:00:00.000Z", status: "pending", attempts: 0,
      provisional: [{ table: "shifts", ids: ["shift-prov-h"] }] },
    { localId: "outbox-1015-sale", kind: "rpc", name: "complete_sale", args: { p_shop_id: "shop-h", p_shift_id: "shift-prov-h", p_items: [{ productId: "prod-h", qty: 1 }] },
      shopId: "shop-h", createdAt: "2026-10-12T08:05:00.000Z", status: "pending", attempts: 0,
      refs: [{ field: "p_shift_id", provisionalId: "shift-prov-h" }], provisional: [{ table: "sales", ids: ["sale-prov-h"] }] },
  ]);
  await old.table("products").put({ id: "prod-h", name: "Hosted-era product" });
  await old.table("sales").put({ id: "sale-prov-h", shopId: "shop-h", pendingSync: true, createdAt: "2026-10-12T08:05:00.000Z" });
  await old.table("syncMeta").bulkPut([{ table: "__snapshot__", lastPulledAt: "2026-10-12T07:00:00.000Z" }, { table: "products", lastPulledAt: "2026-10-12T07:00:00.000Z" }]);
  await old.table("authCache").put({ authId: "auth-h", userId: "u-h", role: "CASHIER", shopId: "shop-h", orgId: "org-h", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  old.close();
  storage.setItem(HOSTED_KEY, JSON.stringify({ access_token: "hosted-access", refresh_token: "hosted-refresh", expires_at: 9_999_999_999, user: { id: "auth-h" } }));
  storage.setItem("pos-till-id", "till-keep-me");
  vi.stubGlobal("fetch", fetchSpy);
});

describe("v1.0.15 profile opened by 1.0.16", () => {
  it("quarantines the untagged entries and discards the hosted caches and session", async () => {
    const result = await prepareLocalStateForBackend({ db: localDb, backendUrl: TEST_BACKEND_URL, storage });
    expect(result).toMatchObject({ originChanged: true, previousOrigin: null, quarantined: 2, removedAuthSessions: 1 });

    const rows = await localDb.syncOutbox.toArray();
    expect(rows).toHaveLength(2); // kept, not deleted
    expect(rows.every((r) => r.status === "quarantined" && r.statusBeforeQuarantine === "pending")).toBe(true);
    expect(rows.every((r) => r.backendOrigin === undefined && /older app version/.test(r.quarantineReason ?? ""))).toBe(true);

    // hosted catalogue + cursors gone: the next load is a fresh full load
    expect(await localDb.products.count()).toBe(0);
    expect(await localDb.sales.count()).toBe(0);
    expect(await localDb.syncMeta.count()).toBe(0);
    expect(await readLocalSnapshot()).toBeNull();
    expect(await localDb.authCache.count()).toBe(0);
    // sessions: the hosted one removed, unrelated keys kept
    expect(storage.getItem(HOSTED_KEY)).toBeNull();
    expect(storage.getItem("pos-till-id")).toBe("till-keep-me");
    expect((await localDb.syncState.get(SYNC_STATE_KEYS.backendOrigin))?.value).toBe(currentBackendOrigin());
  });

  it("re-login is required: supabase-js finds no session for the new backend (and makes no request)", async () => {
    const client = createClient(TEST_BACKEND_URL, TEST_BACKEND_ANON_KEY, {
      auth: { storage, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
    });
    expect(authStorageKeyFor(TEST_BACKEND_URL)).toBe("sb-127-auth-token");
    const { data } = await client.auth.getSession();
    expect(data.session).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never sends the quarantined entries to any backend", async () => {
    await expect(drainOutbox()).resolves.toBe("drained");
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await refreshSyncStatus();
    expect(useSyncStore.getState()).toMatchObject({ quarantinedCount: 2, pendingCount: 0 });
  });

  it("the queue export still contains them, with their status and (missing) backend", async () => {
    const payload = await collectQueueExport(localDb, {
      appVersion: "1.0.16", tillId: "till-keep-me", backendHost: new URL(TEST_BACKEND_URL).host,
      session: { userId: null, orgId: null, shopId: null, role: null },
    });
    expect(payload.entries.map((e) => [e.opType, e.status, e.backendOrigin])).toEqual([
      ["open_shift", "quarantined", null], ["complete_sale", "quarantined", null],
    ]);
    const envelope = await encryptQueueExport(payload, "correct horse battery");
    const back = await decryptQueueExport(JSON.stringify(envelope), "correct horse battery");
    expect(back.entries).toHaveLength(2);
    expect(back.entries[1].quarantineReason).toMatch(/older app version/);
  });

  it("a later boot on the same backend keeps the new catalogue and drains only 1.0.16 entries", async () => {
    await localDb.products.put({ id: "prod-new", name: "From the new backend" } as never);
    await enqueueOutbox({ kind: "rpc", name: "adjust_stock", args: { p_shop_id: "shop-n" }, shopId: "shop-n" });
    const again = await prepareLocalStateForBackend({ db: localDb, backendUrl: TEST_BACKEND_URL, storage });
    expect(again).toMatchObject({ originChanged: false, quarantined: 0 });
    expect(await localDb.products.count()).toBe(1);

    rpc.mockImplementation(async (name: string) => ({ data: validReply(name), error: null }));
    await drainOutbox();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("adjust_stock");
    const left = await localDb.syncOutbox.toArray();
    expect(left.map((r) => r.localId).sort()).toEqual(["outbox-1015-sale", "outbox-1015-shift"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an entry tagged for a different backend is quarantined too", async () => {
    await localDb.syncOutbox.put({
      localId: "outbox-other", kind: "rpc", name: "close_shift", args: {}, shopId: "s", createdAt: new Date().toISOString(),
      status: "failed", attempts: 2, backendOrigin: `https://${HOSTED_REF}.supabase.co`,
    });
    rpc.mockClear();
    await drainOutbox();
    expect(rpc).not.toHaveBeenCalled();
    const row = await localDb.syncOutbox.get("outbox-other");
    expect(row).toMatchObject({ status: "quarantined", statusBeforeQuarantine: "failed" });
    expect(row?.quarantineReason).toContain(`${HOSTED_REF}.supabase.co`);
  });
});
