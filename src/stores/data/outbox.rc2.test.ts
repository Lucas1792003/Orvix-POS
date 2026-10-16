// RC2 regression tests for the four RC1 audit defects (D1-D3 here; D4 in
// src/lib/updateGuard.test.ts). See docs/desktop-app/release-1.0.16.md (RC2)
// and docs/selfhost-migration/phase-f/electron-compatibility.md.
//   D1  "Dismiss" hard-deleted unsynced entries -> owner-only, export-first
//       "Set aside" that keeps the row; restore; no delete path.
//   D2  a row left `syncing` was never drained -> returned to `pending` with
//       the same key (startup / stale), and the resend cannot duplicate.
//   D3  the 7-day id-map prune dropped mappings still referenced.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rpc = vi.fn();
vi.mock("../../lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "auth-1" }, expires_at: 9_999_999_999 } }, error: null }) },
  },
  backendHost: "127.0.0.1:54321",
}));

import { localDb, SYNC_STATE_KEYS, type SyncOutboxEntry } from "../../lib/localDb";
import { currentBackendOrigin, prepareLocalStateForBackend, quarantineForeignOutboxEntries } from "../../lib/backendOrigin";
import {
  OutboxActionError, PROVISIONAL_MAP_MAX_AGE_MS, SYNCING_STALE_MS, countPendingOutbox, countUnsyncedOutbox, drainOutbox,
  enqueueOutbox, listSetAsideEntries, pruneProvisionalIdMap, recoverStrandedSyncing, referencedProvisionalIds,
  restoreSetAsideEntry, retryOutboxEntry, setAsideOutboxEntry,
} from "./outbox";
import { useAuthStore } from "../authStore";
import { collectQueueExport } from "../../lib/queueExport/collect";
import { decryptQueueExport, encryptQueueExport } from "../../lib/queueExport/format";
import { recordQueueExport, resetQueueExportRecord, wasExported } from "../../lib/queueExport/exportRecord";
import { createSingleFlight, setAsideBlock } from "../../lib/outboxSetAsidePolicy";
import { buildAppState } from "../../lib/updateGuardBridge";
import { replayExport } from "../../../tools/queue-recovery/replay";
import { TEST_BACKEND_URL } from "../../test/setup";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evaluateInstallGuard, sanitizeAppState } = require("../../../electron/updateGuard.cjs");

const DAY = 24 * 60 * 60 * 1000;
const ctx = () => ({
  appVersion: "1.0.16", tillId: "till-rc2", backendHost: "127.0.0.1:54321",
  session: { userId: null, orgId: null, shopId: null, role: null },
});
const asOwner = () => useAuthStore.setState({ currentUserId: "admin-1", currentRole: "ADMIN" });
const asCashier = () => useAuthStore.setState({ currentUserId: "cashier-1", currentRole: "CASHIER" });

/**
 * The server's idempotency contract (migrations 052/074): the ledger is keyed
 * by (org, key); the first call with a key executes and stores its response;
 * any later call with the same key in the same org returns that stored
 * response and has no new effect (a different payload under the same key is
 * IDEMPOTENCY_MISMATCH). One org here: the till's.
 */
class FakeServer {
  readonly org = "org-1";
  ledger = new Map<string, { hash: string; response: unknown }>();
  sales: string[] = [];
  calls: { name: string; key: unknown }[] = [];
  private n = 0;
  handle(name: string, args: Record<string, unknown>): { data: unknown; error: unknown } {
    const key = args.p_idempotency_key;
    this.calls.push({ name, key });
    const rest = { ...args };
    delete rest.p_idempotency_key;
    const hash = JSON.stringify(rest);
    const slot = `${this.org}:${String(key)}`;
    const hit = this.ledger.get(slot);
    if (hit) {
      if (hit.hash !== hash) return { data: null, error: { message: "IDEMPOTENCY_MISMATCH", code: "P0001" } };
      return { data: hit.response, error: null };
    }
    const id = `sale-${++this.n}`;
    this.sales.push(id);
    const response = { sale: { id }, replayed: false };
    this.ledger.set(slot, { hash, response });
    return { data: response, error: null };
  }
}

const NETWORK_ERROR = { data: null, status: 0, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } };

beforeEach(async () => {
  rpc.mockReset();
  resetQueueExportRecord();
  useAuthStore.setState({ currentUserId: null, currentRole: null });
  await localDb.syncOutbox.clear();
  await localDb.provisionalIdMap.clear();
  await localDb.syncState.delete(SYNC_STATE_KEYS.drainLease);
});
afterEach(() => {
  useAuthStore.setState({ currentUserId: null, currentRole: null });
});

// =================================================================== D2 ==

describe("D2: stranded `syncing` entries", () => {
  it("DUPLICATE PROOF: server committed, the connection dropped and the app died mid-request -> after restart the same key is resent, the server replays, exactly one sale", async () => {
    const server = new FakeServer();
    let releaseHung: (v: unknown) => void = () => undefined;
    rpc.mockImplementationOnce((name: string, args: Record<string, unknown>) => {
      server.handle(name, args); // the server COMMITS ...
      return new Promise((resolve) => { releaseHung = resolve; }); // ... and the reply never arrives
    });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "s", p_items: [{ productId: "p", qty: 1 }] }, shopId: "s" });
    const [queued] = await localDb.syncOutbox.toArray();

    const firstInstance = drainOutbox(); // not awaited: this "process" dies mid-request
    await vi.waitFor(async () => expect((await localDb.syncOutbox.get(queued.localId))?.status).toBe("syncing"));
    expect(server.sales).toHaveLength(1);
    expect(await countPendingOutbox()).toBe(1); // the guard sees it as pending ...

    // "Restart": a fresh JS context (module state reset) on the same
    // database; the dead instance's drain lease has expired.
    vi.resetModules();
    await localDb.syncState.delete(SYNC_STATE_KEYS.drainLease);
    const fresh = await import("./outbox");
    rpc.mockImplementation((name: string, args: Record<string, unknown>) => Promise.resolve(server.handle(name, args)));

    await expect(fresh.drainOutbox()).resolves.toBe("drained");

    expect(server.calls).toHaveLength(2);
    expect(server.calls[1].key).toBe(queued.idempotencyKey); // the SAME key
    expect(server.calls[0].key).toBe(queued.idempotencyKey);
    expect(server.sales).toHaveLength(1); // ... one sale, not two
    expect(await localDb.syncOutbox.count()).toBe(0); // synced: the guard clears

    releaseHung(NETWORK_ERROR); // let the dead instance's promise settle
    await firstInstance;
    expect(server.sales).toHaveLength(1);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("DUPLICATE PROOF: server committed, then the connection dropped with an error reply -> pending (same key, attempts 1) -> retry replays, one sale", async () => {
    const server = new FakeServer();
    rpc.mockImplementationOnce((name: string, args: Record<string, unknown>) => {
      server.handle(name, args);
      return Promise.resolve(NETWORK_ERROR);
    });
    rpc.mockImplementation((name: string, args: Record<string, unknown>) => Promise.resolve(server.handle(name, args)));
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "s" }, shopId: "s" });
    const [queued] = await localDb.syncOutbox.toArray();

    await expect(drainOutbox()).resolves.toBe("network");
    expect(await localDb.syncOutbox.get(queued.localId)).toMatchObject({ status: "pending", attempts: 1, idempotencyKey: queued.idempotencyKey });
    expect((await localDb.syncOutbox.get(queued.localId))?.syncingSince).toBeUndefined();
    await retryOutboxEntry(queued.localId); // clears the backoff window
    await expect(drainOutbox()).resolves.toBe("drained");

    expect(server.calls.map((c) => c.key)).toEqual([queued.idempotencyKey, queued.idempotencyKey]);
    expect(server.sales).toHaveLength(1);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("recoverStrandedSyncing: all at startup; afterwards only rows past the stale threshold; same key, attempts + 1", async () => {
    const now = Date.parse("2026-10-16T10:00:00.000Z");
    const row = (localId: string, since: number | null, attempts = 2): SyncOutboxEntry => ({
      localId, kind: "rpc", name: "complete_sale", args: { p_idempotency_key: `key-${localId}` }, idempotencyKey: `key-${localId}`,
      shopId: "s", createdAt: new Date(now - DAY).toISOString(), status: "syncing", attempts, backendOrigin: currentBackendOrigin(),
      ...(since === null ? {} : { syncingSince: new Date(since).toISOString() }),
    });
    await localDb.syncOutbox.bulkPut([row("fresh", now - 10_000), row("stale", now - SYNCING_STALE_MS - 1), row("legacy", null)]);

    expect(await recoverStrandedSyncing(SYNCING_STALE_MS, now)).toBe(2); // loop resumed after an error/offline
    expect(await localDb.syncOutbox.get("fresh")).toMatchObject({ status: "syncing", attempts: 2 });
    for (const id of ["stale", "legacy"]) {
      const r = await localDb.syncOutbox.get(id);
      expect(r).toMatchObject({ status: "pending", attempts: 3, idempotencyKey: `key-${id}`, args: { p_idempotency_key: `key-${id}` }, failureKind: "transient" });
      expect(r?.syncingSince).toBeUndefined();
    }
    expect(await recoverStrandedSyncing(0, now)).toBe(1); // startup: every one
    expect(await localDb.syncOutbox.get("fresh")).toMatchObject({ status: "pending", attempts: 3 });
  });

  it("update guard: a stranded `syncing` row counts as pending (normal install refused), then syncs and the guard allows", async () => {
    await localDb.syncOutbox.put({
      localId: "o-s", kind: "rpc", name: "complete_sale", args: { p_idempotency_key: "k-s" }, idempotencyKey: "k-s",
      shopId: "s", createdAt: new Date().toISOString(), status: "syncing", attempts: 0, backendOrigin: currentBackendOrigin(),
      syncingSince: new Date(Date.now() - 2 * SYNCING_STALE_MS).toISOString(),
    });
    const guardNow = async () => {
      const rows = await localDb.syncOutbox.toArray();
      return evaluateInstallGuard(sanitizeAppState(buildAppState({
        outboxIds: rows.map((r) => r.localId), statuses: rows.map((r) => r.status),
        online: true, authenticated: true, saleInProgress: false, exportCoversQueue: false,
      })));
    };
    expect(await guardNow()).toMatchObject({ allowed: false, code: "unsynced", unsynced: 1 });
    rpc.mockResolvedValue({ data: { sale: { id: "x" } }, error: null });
    await drainOutbox();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await guardNow()).toMatchObject({ allowed: true, code: "ok" });
  });
});

// =================================================================== D3 ==

describe("D3: provisional id map prune", () => {
  it("referencedProvisionalIds: refs plus any string in the payload", () => {
    const ids = referencedProvisionalIds([
      { refs: [{ field: "p_shift_id", provisionalId: "a" }], args: { x: ["b", { y: "c" }] } } as unknown as SyncOutboxEntry,
      { kind: "table_write", row: { parent: "d" } } as unknown as SyncOutboxEntry,
    ]);
    for (const id of ["a", "b", "c", "d"]) expect(ids.has(id)).toBe(true);
  });

  it("historical queue (entries > 7 days, quarantined 1.0.15 leftovers, conflict, failed, set aside): after the prune, export + replay dry-run resolve every reference", async () => {
    const old = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    await localDb.provisionalIdMap.bulkPut([
      { provisionalId: "shift-1015", realId: "shift-real-1015", createdAt: old(20) }, // 1.0.15 entries (quarantined)
      { provisionalId: "shift-conf", realId: "shift-real-conf", createdAt: old(12) }, // conflict entry
      { provisionalId: "shift-aside", realId: "shift-real-aside", createdAt: old(10) }, // set-aside entry
      { provisionalId: "sale-payload", realId: "sale-real-payload", createdAt: old(9) }, // payload-only reference (failed refund)
      { provisionalId: "shift-gone", realId: "shift-real-gone", createdAt: old(30) }, // nobody needs it
      { provisionalId: "shift-new", realId: "shift-real-new", createdAt: old(1) }, // recent
    ]);
    const base = { kind: "rpc" as const, shopId: "s", attempts: 1 };
    await localDb.syncOutbox.bulkPut([
      // v1.0.15 rows: no backendOrigin -> quarantined at startup below
      { ...base, localId: "q1", name: "complete_sale", status: "pending", createdAt: old(15), idempotencyKey: "kq1",
        args: { p_shift_id: "shift-1015", p_idempotency_key: "kq1" }, refs: [{ field: "p_shift_id", provisionalId: "shift-1015" }] },
      { ...base, localId: "q2", name: "complete_sale", status: "conflict", createdAt: old(14), idempotencyKey: "kq2",
        args: { p_shift_id: "shift-1015", p_idempotency_key: "kq2" }, refs: [{ field: "p_shift_id", provisionalId: "shift-1015" }] },
      // this backend's rows
      { ...base, localId: "c1", name: "complete_sale", status: "conflict", createdAt: old(11), idempotencyKey: "kc1", backendOrigin: currentBackendOrigin(),
        args: { p_shift_id: "shift-conf", p_idempotency_key: "kc1" }, refs: [{ field: "p_shift_id", provisionalId: "shift-conf" }] },
      { ...base, localId: "a1", name: "complete_sale", status: "archived", statusBeforeArchive: "conflict", archivedAt: old(8), createdAt: old(10),
        idempotencyKey: "ka1", backendOrigin: currentBackendOrigin(),
        args: { p_shift_id: "shift-aside", p_idempotency_key: "ka1" }, refs: [{ field: "p_shift_id", provisionalId: "shift-aside" }] },
      { ...base, localId: "f1", name: "create_refund_void_request", status: "failed", createdAt: old(9), idempotencyKey: "kf1",
        backendOrigin: currentBackendOrigin(), args: { p_sale_id: "sale-payload", p_idempotency_key: "kf1" } },
    ] as SyncOutboxEntry[]);
    await prepareLocalStateForBackend({ db: localDb, backendUrl: TEST_BACKEND_URL, storage: null });
    expect((await localDb.syncOutbox.get("q1"))?.status).toBe("quarantined");

    rpc.mockResolvedValue(NETWORK_ERROR); // the failed entry is tried, nothing reaches the server
    await drainOutbox();
    await drainOutbox();

    const kept = (await localDb.provisionalIdMap.toArray()).map((m) => m.provisionalId).sort();
    expect(kept).toEqual(["sale-payload", "shift-1015", "shift-aside", "shift-conf", "shift-new"]); // only shift-gone pruned
    expect(await localDb.syncOutbox.count()).toBe(5);

    const payload = await collectQueueExport(localDb, ctx());
    const back = await decryptQueueExport(JSON.stringify(await encryptQueueExport(payload, "correct horse battery", { iterations: 100_000 })), "correct horse battery");
    const noNet = (async () => { throw new Error("no network"); }) as unknown as typeof fetch;
    const report = await replayExport(back, {
      target: "http://127.0.0.1:54321", anonKey: null, accessToken: "x", dryRun: true,
      includeQuarantined: true, includeConflicts: true, includeSetAside: true, fetchImpl: noNet,
    });
    expect(report.counts["blocked-unresolved-ref"]).toBe(0);
    expect(report.counts.planned).toBe(5);
    expect(report.ops.map((o) => o.detail ?? "").join("\n")).not.toMatch(/unknown provisional id/);
  });

  it("a mapping becomes prunable once nothing references it any more (after the entry synced)", async () => {
    await localDb.provisionalIdMap.put({ provisionalId: "shift-p", realId: "shift-r", createdAt: new Date(Date.now() - 8 * DAY).toISOString() });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shift_id: "shift-p" }, shopId: "s", refs: [{ field: "p_shift_id", provisionalId: "shift-p" }] });
    expect(await pruneProvisionalIdMap()).toBe(0);
    rpc.mockResolvedValue({ data: { sale: { id: "x" } }, error: null });
    await drainOutbox(); // sends it (ref resolved to shift-r); the pass's prune ran first
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_shift_id: "shift-r" });
    expect(await pruneProvisionalIdMap()).toBe(1);
    expect(await pruneProvisionalIdMap(Date.now() + PROVISIONAL_MAP_MAX_AGE_MS)).toBe(0);
  });
});

// =================================================================== D1 ==

describe("D1: set aside instead of delete", () => {
  const queueSale = async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "s", p_items: [{ productId: "p", qty: 2 }] }, shopId: "s" });
    const rows = await localDb.syncOutbox.toArray();
    return rows[rows.length - 1];
  };

  it("owner only, and only for an entry exported in this session; refusals change nothing", async () => {
    const row = await queueSale();
    const before = JSON.stringify(await localDb.syncOutbox.toArray());
    await expect(setAsideOutboxEntry(row.localId, { wasExported: () => true })).rejects.toMatchObject({ code: "not-owner" }); // signed out
    asCashier();
    recordQueueExport([row.localId]);
    await expect(setAsideOutboxEntry(row.localId, { wasExported })).rejects.toMatchObject({ code: "not-owner" });
    useAuthStore.setState({ currentUserId: "mgr-1", currentRole: "MANAGER" });
    await expect(setAsideOutboxEntry(row.localId, { wasExported })).rejects.toMatchObject({ code: "not-owner" });
    asOwner();
    resetQueueExportRecord();
    await expect(setAsideOutboxEntry(row.localId, { wasExported })).rejects.toMatchObject({ code: "export-first" });
    expect(JSON.stringify(await localDb.syncOutbox.toArray())).toBe(before);
  });

  it("keeps the row (payload + key), excludes it from sync, keeps it in the export and the guard count; restore puts it back with the same key and it syncs once", async () => {
    const row = await queueSale();
    asOwner();
    recordQueueExport([row.localId]);
    const aside = await setAsideOutboxEntry(row.localId, { wasExported, reason: "rung up twice by mistake" });
    expect(aside).toMatchObject({ status: "archived", statusBeforeArchive: "pending", archivedBy: "admin-1", archiveReason: "rung up twice by mistake" });
    const stored = await localDb.syncOutbox.get(row.localId);
    expect(stored).toMatchObject({ args: row.args, idempotencyKey: row.idempotencyKey, seq: (row as { seq?: number }).seq });
    expect(await listSetAsideEntries()).toHaveLength(1);

    rpc.mockResolvedValue({ data: { sale: { id: "x" } }, error: null });
    await drainOutbox();
    expect(rpc).not.toHaveBeenCalled(); // never sent while set aside
    expect(await countPendingOutbox()).toBe(0);
    expect(await countUnsyncedOutbox()).toBe(1); // still blocks a normal update install
    await quarantineForeignOutboxEntries(localDb, "https://another.example.test");
    expect((await localDb.syncOutbox.get(row.localId))?.status).toBe("archived"); // quarantine does not overwrite it
    await expect(retryOutboxEntry(row.localId)).rejects.toThrow(/set aside/);
    await expect(setAsideOutboxEntry(row.localId, { wasExported })).rejects.toMatchObject({ code: "already-set-aside" });

    const exp = await collectQueueExport(localDb, ctx());
    const back = await decryptQueueExport(JSON.stringify(await encryptQueueExport(exp, "correct horse battery", { iterations: 100_000 })), "correct horse battery");
    expect(back.entries).toEqual([expect.objectContaining({
      opId: row.localId, status: "archived", statusBeforeArchive: "pending", idempotencyKey: row.idempotencyKey,
      archivedBy: "admin-1", payload: expect.objectContaining({ p_idempotency_key: row.idempotencyKey }),
    })]);

    asCashier();
    await expect(restoreSetAsideEntry(row.localId)).rejects.toMatchObject({ code: "not-owner" });
    asOwner();
    const restored = await restoreSetAsideEntry(row.localId);
    expect(restored).toMatchObject({ status: "pending", idempotencyKey: row.idempotencyKey });
    expect(restored.archivedAt).toBeUndefined();
    await drainOutbox();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_idempotency_key: row.idempotencyKey });
    expect(await localDb.syncOutbox.count()).toBe(0);
  });

  it("restore keeps a former quarantined entry quarantined (never sent here); a former syncing one comes back pending", async () => {
    asOwner();
    await localDb.syncOutbox.bulkPut([
      { localId: "was-q", kind: "rpc", name: "complete_sale", args: { p_idempotency_key: "kq" }, idempotencyKey: "kq", shopId: "s",
        createdAt: new Date().toISOString(), status: "quarantined", attempts: 0 },
      { localId: "was-s", kind: "rpc", name: "complete_sale", args: { p_idempotency_key: "ks" }, idempotencyKey: "ks", shopId: "s",
        createdAt: new Date().toISOString(), status: "syncing", attempts: 0, backendOrigin: currentBackendOrigin() },
    ]);
    recordQueueExport(["was-q", "was-s"]);
    await setAsideOutboxEntry("was-q", { wasExported });
    await setAsideOutboxEntry("was-s", { wasExported });
    expect((await restoreSetAsideEntry("was-q")).status).toBe("quarantined");
    expect((await restoreSetAsideEntry("was-s")).status).toBe("pending");
    await expect(restoreSetAsideEntry("was-s")).rejects.toBeInstanceOf(OutboxActionError);
  });

  it("no unsynced status can be deleted through the outbox API", async () => {
    const mod = await import("./outbox");
    const names = Object.keys(mod).filter((k) => /dismiss|delete|remove|purge|discard/i.test(k));
    expect(names).toEqual([]);
  });

  it("page rules: Set aside is owner-only and export-first; one action at a time (a double click acts once)", async () => {
    const e = { localId: "x", status: "conflict" as const };
    expect(setAsideBlock(e, { isOwner: false, wasExported: () => true })).toBe("not-owner");
    expect(setAsideBlock(e, { isOwner: true, wasExported: () => false })).toBe("export-first");
    expect(setAsideBlock(e, { isOwner: true, wasExported: () => true })).toBeNull();
    expect(setAsideBlock({ localId: "x", status: "archived" }, { isOwner: true, wasExported: () => true })).toBe("already-set-aside");

    const flight = createSingleFlight();
    let release: () => void = () => undefined;
    const acted: string[] = [];
    const first = flight.run(() => new Promise<void>((r) => { acted.push("row-1"); release = r; }));
    const second = await flight.run(async () => { acted.push("row-2"); }); // the second click, on the row that moved up
    expect(second).toBeNull();
    release();
    await first;
    expect(acted).toEqual(["row-1"]);
    expect(flight.running).toBe(false);
  });
});
