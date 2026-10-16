// RC1 (b777345) release-readiness audit, steps 1(a)-(c): owner update
// override ("Install anyway (after export)") vs. the outbox. These are
// CHARACTERIZATION tests: they pin RC1's behaviour as it is, including the
// findings reported as defects (marked FINDING). No product code is changed.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Dexie from "dexie";

const rpc = vi.fn();
vi.mock("../../src/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "auth-1" }, expires_at: 9_999_999_999 } }, error: null }) },
  },
  backendHost: "127.0.0.1:54321",
}));

import { localDb } from "../../src/lib/localDb";
import { currentBackendOrigin, prepareLocalStateForBackend } from "../../src/lib/backendOrigin";
import {
  countUnsyncedOutbox, dismissOutboxEntry, drainOutbox, enqueueOutbox, retryOutboxEntry,
} from "../../src/stores/data/outbox";
import { collectQueueExport } from "../../src/lib/queueExport/collect";
import { exportCovers, recordQueueExport, resetQueueExportRecord } from "../../src/lib/queueExport/exportRecord";
import { buildAppState } from "../../src/lib/updateGuardBridge";
import { replayExport } from "../../tools/queue-recovery/replay";
import { TEST_BACKEND_URL } from "../../src/test/setup";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evaluateInstallGuard, sanitizeAppState } = require("../../electron/updateGuard.cjs");

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

const DAY = 24 * 60 * 60 * 1000;
const ctx = () => ({
  appVersion: "1.0.16", tillId: "till-audit", backendHost: "127.0.0.1:54321",
  session: { userId: null, orgId: null, shopId: null, role: null },
});

describe("1.0.15 profile, every outbox status, opened by RC1 (audit 1a/1b)", () => {
  it("Dexie v1->v2 upgrade + startup quarantine keep every row and its payload; drain sends none even if the server would accept", async () => {
    localDb.close();
    await Dexie.delete("shwe-phala-local");
    const old = new Dexie("shwe-phala-local");
    old.version(1).stores(V1015_STORES);
    await old.open();
    const statuses = ["pending", "syncing", "failed", "conflict"] as const;
    const originals = statuses.map((status, i) => ({
      localId: `o-${status}`, kind: "rpc", name: "complete_sale", shopId: "s",
      args: { p_shop_id: "s", p_items: [{ productId: "p", qty: i + 1 }] },
      createdAt: `2026-10-1${i}T08:00:00.000Z`, status, attempts: i, lastError: status === "conflict" ? "Insufficient stock" : undefined,
    }));
    await old.table("syncOutbox").bulkPut(originals);
    old.close();

    await localDb.open(); // runs the RC1 v2 upgrade function
    await prepareLocalStateForBackend({ db: localDb, backendUrl: TEST_BACKEND_URL, storage: null });
    rpc.mockResolvedValue({ data: { sale: { id: "x" } }, error: null });
    await drainOutbox();
    await drainOutbox();
    expect(rpc).not.toHaveBeenCalled();

    const rows = await localDb.syncOutbox.toArray();
    expect(rows).toHaveLength(4);
    for (const o of originals) {
      const r = rows.find((x) => x.localId === o.localId)!;
      expect(r.status).toBe("quarantined");
      expect(r.statusBeforeQuarantine).toBe(o.status);
      const { p_idempotency_key, ...rest } = r.args as Record<string, unknown>;
      expect(rest).toEqual(o.args); // payload untouched except the key the v2 upgrade minted
      expect(typeof p_idempotency_key).toBe("string");
      expect(r.idempotencyKey).toBe(p_idempotency_key); // NOTE: minted at upgrade, NOT the 1.0.15 request's key (1.0.15 had none)
    }
  });
});

describe("override install path never touches rows (audit 1b)", () => {
  beforeEach(async () => {
    rpc.mockReset();
    resetQueueExportRecord();
    await localDb.syncOutbox.clear();
    await localDb.provisionalIdMap.clear();
  });

  it("export -> guard allows recovery; rows unchanged; a sale queued after the export revokes the allowance", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "s" }, shopId: "s" });
    await enqueueOutbox({ kind: "rpc", name: "adjust_stock", args: { p_shop_id: "s" }, shopId: "s" });
    const before = JSON.stringify(await localDb.syncOutbox.toArray());
    const p = await collectQueueExport(localDb, ctx());
    recordQueueExport(p.entries.map((e) => e.opId));

    const rows = await localDb.syncOutbox.toArray();
    const state = (covers: boolean) => sanitizeAppState(buildAppState({
      outboxIds: rows.map((r) => r.localId), statuses: rows.map((r) => r.status),
      online: false, authenticated: true, saleInProgress: false, exportCoversQueue: covers,
    }));
    expect(evaluateInstallGuard(state(exportCovers(rows.map((r) => r.localId))), { recovery: true }).allowed).toBe(true);
    expect(evaluateInstallGuard(state(true), { recovery: false }).allowed).toBe(false);
    expect(JSON.stringify(await localDb.syncOutbox.toArray())).toBe(before);

    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "s" }, shopId: "s" });
    const ids = (await localDb.syncOutbox.toArray()).map((r) => r.localId);
    expect(exportCovers(ids)).toBe(false);
  });

  it("FINDING (low): the recovery guard does not require a signed-in owner; the 'Owner only' rule is text only", () => {
    const s = sanitizeAppState({ unsynced: 3, pending: 3, online: false, authenticated: false, saleInProgress: false, exportCoversQueue: true });
    expect(evaluateInstallGuard(s, { recovery: true })).toMatchObject({ allowed: true, code: "recovery" });
  });
});

describe("findings in the outbox (audit 1a/1b)", () => {
  beforeEach(async () => {
    rpc.mockReset();
    resetQueueExportRecord();
    await localDb.syncOutbox.clear();
    await localDb.provisionalIdMap.clear();
  });

  it("FINDING (medium): a row left 'syncing' by a quit mid-request (e.g. recovery install during a drain) is never drained again and blocks every normal install", async () => {
    await localDb.syncOutbox.put({
      localId: "o-stranded", kind: "rpc", name: "complete_sale", args: { p_idempotency_key: "k1" }, idempotencyKey: "k1",
      shopId: "s", createdAt: new Date().toISOString(), status: "syncing", attempts: 0, backendOrigin: currentBackendOrigin(),
    });
    rpc.mockResolvedValue({ data: { sale: { id: "x" } }, error: null });
    await expect(drainOutbox()).resolves.toBe("drained");
    expect(rpc).not.toHaveBeenCalled();
    expect(await localDb.syncOutbox.get("o-stranded")).toMatchObject({ status: "syncing" }); // kept (not lost) ...
    expect(await countUnsyncedOutbox()).toBe(1); // ... but the guard sees it unsynced forever
    // only a manual Retry (Sync Conflicts page, audit:view_global) frees it; replay is idempotent (same key)
    await retryOutboxEntry("o-stranded");
    await drainOutbox();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await localDb.syncOutbox.get("o-stranded")).toBeUndefined();
  });

  it("FINDING (medium): the 7-day provisionalIdMap prune deletes mappings that a quarantined entry still needs; a later export cannot resolve its refs", async () => {
    await localDb.provisionalIdMap.put({ provisionalId: "shift-prov", realId: "shift-real", createdAt: new Date(Date.now() - 8 * DAY).toISOString() });
    await localDb.syncOutbox.put({
      localId: "o-q", kind: "rpc", name: "complete_sale", args: { p_shift_id: "shift-prov", p_idempotency_key: "k2" }, idempotencyKey: "k2",
      refs: [{ field: "p_shift_id", provisionalId: "shift-prov" }], provisional: [{ table: "sales", ids: ["sale-prov"] }],
      shopId: "s", createdAt: new Date(Date.now() - 8 * DAY).toISOString(), status: "quarantined", attempts: 0,
    });
    const early = await collectQueueExport(localDb, ctx());
    expect(early.provisionalIdMap).toHaveLength(1);

    await drainOutbox(); // any drain pass (reconnect, 'Sync now', periodic) prunes
    expect(await localDb.syncOutbox.get("o-q")).toMatchObject({ status: "quarantined" }); // the row itself survives
    const late = await collectQueueExport(localDb, ctx());
    expect(late.provisionalIdMap).toHaveLength(0); // the mapping is gone from the device

    const noNet = (async () => { throw new Error("no network"); }) as unknown as typeof fetch;
    const report = await replayExport(late, { target: "http://127.0.0.1:54321", anonKey: null, accessToken: "x", dryRun: true, includeQuarantined: true, fetchImpl: noNet });
    expect(report.ops[0].outcome).toBe("blocked-unresolved-ref");
  });

  it("FINDING (medium): dismissOutboxEntry hard-deletes any row; the only guard (export-first) is in the page and covers quarantined rows only", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "s" }, shopId: "s" });
    const [row] = await localDb.syncOutbox.toArray();
    await dismissOutboxEntry(row.localId); // a pending, never-exported sale
    expect(await localDb.syncOutbox.count()).toBe(0);
  });
});
