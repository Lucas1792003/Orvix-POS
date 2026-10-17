// RC3 regression tests: owner reconciliation of outbox entries.
// docs/desktop-app/release-1.0.16.md §11. Real Dexie (fake-indexeddb), the
// real main-process authority (electron/reconcileAuthority.cjs) over a fake
// backend, the real export / decrypt / recovery-tool code.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const rpc = vi.fn();
vi.mock("../../lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: "auth-1" }, expires_at: 9_999_999_999 } }, error: null }) },
  },
  backendHost: "127.0.0.1:54321",
}));

import { localDb, RECONCILE_LOG_PREFIX, SYNC_STATE_KEYS, type SyncOutboxEntry } from "../../lib/localDb";
import { currentBackendOrigin, quarantineForeignOutboxEntries } from "../../lib/backendOrigin";
import {
  countUnsyncedOutbox, drainOutbox, enqueueOutbox, pruneProvisionalIdMap, PROVISIONAL_MAP_MAX_AGE_MS, restoreSetAsideEntry,
  retryOutboxEntry, setAsideOutboxEntry,
} from "./outbox";
import {
  ReconcileError, blockingOutboxRows, listReconciliationLog, reconcileOutboxEntry, rowSnapshot, verifyReconciledEntries,
  type ReconcileDeps, type ReconcileInput,
} from "./reconcile";
import { useAuthStore } from "../authStore";
import { collectQueueExportSnapshot } from "../../lib/queueExport/collect";
import { decryptQueueExport, encryptQueueExport, validatePayload } from "../../lib/queueExport/format";
import { exportedEntry, recordQueueExport, resetQueueExportRecord, wasExported } from "../../lib/queueExport/exportRecord";
import { entryDigest } from "../../lib/reconcile/digest";
import { checkServerRecord } from "../../lib/reconcile/serverCheck";
import { reconcileBlock, recordConsistencyProblem, validateResolution } from "../../lib/reconcile/policy";
import type { ReconciliationRecord, ServerCheck } from "../../lib/reconcile/types";
import type { ServerCheck } from "../../lib/reconcile/types";
import { buildAppState } from "../../lib/updateGuardBridge";
import { replayExport, exitCodeFor } from "../../../tools/queue-recovery/replay";
import {
  BACKEND, CASHIER, FakeSalesServer, OWNER_TOKEN, fakeAuthBackend, memoryKeyStore, saleArgs,
} from "../../test/reconcileFakes";

const require = createRequire(import.meta.url);
const { createReconcileAuthority } = require("../../../electron/reconcileAuthority.cjs");
const { evaluateInstallGuard, sanitizeAppState } = require("../../../electron/updateGuard.cjs");

const NOW = new Date("2026-10-16T09:00:00.000Z");
const ctx = () => ({ appVersion: "1.0.16", tillId: "till-rc3", backendHost: "127.0.0.1:54321", session: { userId: null, orgId: null, shopId: null, role: null } });
const PASS = "correct horse battery staple";

let auth: ReturnType<typeof fakeAuthBackend>;
let authority: { attest: (t: string, r: unknown) => Promise<never>; verifySeals: (i: unknown[]) => boolean[] };
let srv: FakeSalesServer;

const deps = (over: Partial<ReconcileDeps> = {}): ReconcileDeps => ({
  attest: (r) => authority.attest(r.accessToken, r),
  accessToken: async () => OWNER_TOKEN,
  exportedEntry,
  now: () => NOW,
  ...over,
});
const verifyDeps = () => ({ verifySeals: async (items: unknown[]) => authority.verifySeals(items), now: () => new Date(NOW.getTime() + 60_000) });

let n = 0;
async function putRow(over: Partial<SyncOutboxEntry> = {}): Promise<SyncOutboxEntry> {
  n++;
  const key = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const args = saleArgs({ p_idempotency_key: key, p_created_at: `2026-10-16T08:00:${String(n).padStart(2, "0")}.123Z` });
  const row: SyncOutboxEntry & { seq: number } = {
    localId: `outbox-${n}`, kind: "rpc", name: "complete_sale", args, shopId: "shop-1",
    createdAt: `2026-10-16T08:00:${String(n).padStart(2, "0")}.500Z`, status: "conflict", attempts: 1, failureKind: "permanent",
    lastError: "Shift is closed", idempotencyKey: key, backendOrigin: currentBackendOrigin(), seq: n, ...over,
  };
  await localDb.syncOutbox.put(row);
  return (await localDb.syncOutbox.get(row.localId))!;
}

async function exportNow(): Promise<void> {
  const { digests } = await collectQueueExportSnapshot(localDb, ctx());
  recordQueueExport(digests, NOW);
}

async function serverCheck(row: SyncOutboxEntry, now = NOW): Promise<ServerCheck> {
  return checkServerRecord(row, { reader: srv, resolveRef: () => null, entryDigest: await entryDigest(row), now });
}

async function input(localId: string, over: Partial<ReconcileInput> = {}): Promise<ReconcileInput> {
  const row = (await localDb.syncOutbox.get(localId))!;
  return { resolution: "cancelled", check: await serverCheck(row), reason: "Customer walked out, nothing handed over", expectedRow: rowSnapshot(row), ...over };
}

const expectCode = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ReconcileError);
  expect((err as ReconcileError).code).toBe(code);
};

const logEvents = async () => (await listReconciliationLog()).map((l) => `${l.event}:${l.localId}`);

beforeEach(async () => {
  rpc.mockReset();
  resetQueueExportRecord();
  useAuthStore.setState({ currentUserId: null, currentRole: null });
  await localDb.syncOutbox.clear();
  await localDb.provisionalIdMap.clear();
  await localDb.syncState.clear();
  auth = fakeAuthBackend();
  authority = createReconcileAuthority({ backend: BACKEND, keyStore: memoryKeyStore(), fetchImpl: auth.fetchImpl, now: () => NOW.getTime() });
  srv = new FakeSalesServer();
});
afterEach(() => {
  useAuthStore.setState({ currentUserId: null, currentRole: null });
  vi.restoreAllMocks();
});

// ================================================================ states ==

describe("status transitions", () => {
  it.each(["conflict", "quarantined", "archived"] as const)("%s -> reconciled (cancelled, check 'not recorded'): row, payload and key kept; record complete", async (status) => {
    const row = await putRow({ status, ...(status === "archived" ? { statusBeforeArchive: "conflict", archivedAt: "2026-10-16T08:30:00Z", archivedBy: "admin-1" } : {}), ...(status === "quarantined" ? { statusBeforeQuarantine: "pending", quarantinedAt: "2026-10-16T08:10:00Z", quarantineReason: "other server" } : {}) });
    await exportNow();
    const stored = await reconcileOutboxEntry(row.localId, await input(row.localId), deps());
    expect(stored).toMatchObject({ status: "reconciled", statusBeforeReconcile: status, args: row.args, idempotencyKey: row.idempotencyKey, attempts: row.attempts, lastError: row.lastError });
    if (status === "archived") expect(stored).toMatchObject({ archivedAt: row.archivedAt, statusBeforeArchive: "conflict" });
    const rec = stored.reconciliation!;
    expect(rec).toMatchObject({
      v: 1, localId: row.localId, idempotencyKey: row.idempotencyKey, resolution: "cancelled", serverRef: null, statusBefore: status,
      reason: "Customer walked out, nothing handed over", reconciledAt: NOW.toISOString(),
      check: { result: "not-recorded", method: "sale-client-identity" },
      owner: { userId: "admin-1", name: "Owner One", role: "ADMIN", source: "backend" },
      export: { exportedAt: NOW.toISOString(), digest: await entryDigest(row) },
    });
    expect(rec.entryDigest).toBe(await entryDigest(row));
    expect(rec.statusHistory[0]).toEqual({ status: "queued", at: row.createdAt });
    expect(rec.seal).toMatch(/^[0-9a-f]{64}$/);
    expect(await logEvents()).toEqual([`reconciled:${row.localId}`]);
    expect((await verifyReconciledEntries(verifyDeps())).verified.has(row.localId)).toBe(true);
  });

  it.each(["pending", "syncing", "failed"] as const)("%s -> reconciled is refused (still in the drain: set aside first); nothing changes, no owner check", async (status) => {
    const row = await putRow({ status });
    await exportNow();
    const before = rowSnapshot(row);
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps()), "not-reconcilable");
    expect(rowSnapshot((await localDb.syncOutbox.get(row.localId))!)).toBe(before);
    expect(auth.calls).toHaveLength(0);
    expect(reconcileBlock(row, { isOwner: true, canVerifyOwner: true, exportedDigest: "x", currentDigest: "x" })).toBe("still-syncing");
  });

  it("reconciled -> reconciled is refused (duplicate); retry / set aside / restore / quarantine leave a reconciled row alone", async () => {
    const row = await putRow();
    await exportNow();
    const inp = await input(row.localId);
    const first = await reconcileOutboxEntry(row.localId, inp, deps());
    await expectCode(reconcileOutboxEntry(row.localId, inp, deps()), "already-reconciled");
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps()), "already-reconciled");
    expect(await logEvents()).toEqual([`reconciled:${row.localId}`]); // one record, one log line
    await expect(retryOutboxEntry(row.localId)).rejects.toThrow(/reconciled/);
    useAuthStore.setState({ currentUserId: "admin-1", currentRole: "ADMIN" });
    await expect(setAsideOutboxEntry(row.localId, { wasExported })).rejects.toThrow(/reconciled/);
    await expect(restoreSetAsideEntry(row.localId)).rejects.toThrow(/not set aside/);
    expect(await quarantineForeignOutboxEntries(localDb, "https://another.example")).toBe(0);
    expect(await localDb.syncOutbox.get(row.localId)).toEqual(first);
  });
});

// ======================================================== preconditions ==

describe("preconditions: export of this exact entry, fresh server check, documented resolution", () => {
  it("no export in this session -> refused; export of an older version (digest differs) -> refused", async () => {
    const row = await putRow();
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps()), "export-first");
    await exportNow();
    await localDb.syncOutbox.update(row.localId, { args: { ...row.args, p_paid_mmk: 999 } }); // entry changed after the export
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps()), "export-stale");
    // an id-only export record (no digest) is not enough either
    resetQueueExportRecord();
    recordQueueExport([row.localId]);
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps()), "export-stale");
    expect(auth.calls).toHaveLength(0);
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("conflict");
  });

  it("resolution rules: cancelled needs 'not recorded'; matched must reference a sale the check found; recreated needs a verified new sale and no recorded original; reason; a fresh check for this entry", async () => {
    const row = await putRow();
    await exportNow();
    const d = await entryDigest(row);
    const notRec = await serverCheck(row);
    const committed = srv.commitSale(row.args!);
    const rec = await serverCheck(row);
    expect(rec.result).toBe("recorded");
    const v = (over: Parameters<typeof validateResolution>[0], now = NOW.getTime()) => validateResolution(over, { entryDigest: d, now });
    expect(v({ resolution: "cancelled", check: rec, reason: "valid reason" })).toMatchObject({ ok: false });
    expect(v({ resolution: "cancelled", check: notRec, reason: "valid reason" })).toMatchObject({ ok: true, serverRef: null });
    expect(v({ resolution: "matched", check: notRec, reason: "valid reason" })).toMatchObject({ ok: false });
    expect(v({ resolution: "matched", check: rec, reason: "valid reason" })).toMatchObject({ ok: true, serverRef: { saleId: committed.id } });
    expect(v({ resolution: "matched", check: rec, matchedSaleId: "sale-other", reason: "valid reason" })).toMatchObject({ ok: false });
    expect(v({ resolution: "recreated", check: rec, recreatedSale: { saleId: "x", receiptNo: null, shopId: null, shiftId: null, createdAt: null }, reason: "valid reason" })).toMatchObject({ ok: false });
    expect(v({ resolution: "recreated", check: notRec, reason: "valid reason" })).toMatchObject({ ok: false });
    expect(v({ resolution: "cancelled", check: notRec, reason: "  no " })).toMatchObject({ ok: false });
    expect(v({ resolution: "cancelled", check: null, reason: "valid reason" })).toMatchObject({ ok: false });
    expect(v({ resolution: "cancelled", check: { ...notRec, entryDigest: "e".repeat(64) }, reason: "valid reason" })).toMatchObject({ ok: false });
    expect(v({ resolution: "cancelled", check: notRec, reason: "valid reason" }, NOW.getTime() + 11 * 60_000)).toMatchObject({ ok: false, message: expect.stringMatching(/too old/) });
    // the store enforces it too: cancelled with a "recorded" check is refused before any owner check
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId, { check: rec }), deps()), "invalid");
    expect(auth.calls).toHaveLength(0);
  });

  it("matched / recreated need an UNAMBIGUOUS server result: an inconclusive check (several plausible sales, an exact match plus candidates, a read error) can never be matched by picking one, nor re-entered", async () => {
    const row = await putRow();
    await exportNow();
    const d = await entryDigest(row);
    const v = (over: Parameters<typeof validateResolution>[0]) => validateResolution(over, { entryDigest: d, now: NOW.getTime() });
    const ref = (id: string) => ({ saleId: id, receiptNo: id, shopId: "shop-1", shiftId: "shift-1", createdAt: "2026-10-16T09:00:00Z" });
    const base = { entryDigest: d, checkedAt: NOW.toISOString(), method: "sale-client-identity" } as const;
    const twoExact = { ...base, result: "inconclusive", matches: [ref("s1"), ref("s2")], candidates: [], detail: "2 exact" } as unknown as ServerCheck;
    const exactPlusCandidate = { ...base, result: "inconclusive", matches: [ref("s1")], candidates: [ref("s3")], detail: "1 + 1" } as unknown as ServerCheck;
    const readError = { ...base, result: "inconclusive", matches: [], candidates: [], detail: "The server could not be read" } as unknown as ServerCheck;
    const reentered = ref("s9");
    for (const check of [twoExact, exactPlusCandidate, readError]) {
      expect(v({ resolution: "matched", check, reason: "valid reason" })).toMatchObject({ ok: false });
      expect(v({ resolution: "matched", check, matchedSaleId: "s1", reason: "valid reason" })).toMatchObject({ ok: false });
      expect(v({ resolution: "recreated", check, recreatedSale: reentered, reason: "valid reason" })).toMatchObject({ ok: false });
      expect(v({ resolution: "cancelled", check, reason: "valid reason" })).toMatchObject({ ok: false });
    }
    // a stored record that matched from an ambiguous check is treated as unresolved on load
    const forged = { v: 1, localId: row.localId, idempotencyKey: row.idempotencyKey, statusBefore: "archived", owner: { userId: "u", role: "ADMIN" }, reason: "valid reason", entryDigest: d, check: exactPlusCandidate, resolution: "matched", serverRef: ref("s1") } as unknown as ReconciliationRecord;
    expect(recordConsistencyProblem({ ...row, statusBeforeReconcile: "archived" } as unknown as SyncOutboxEntry, forged)).toMatch(/unambiguous/);
  });

  it("recreated: links the owner's re-entered sale (verified on the server); the same server sale cannot close two entries", async () => {
    const a = await putRow();
    const b = await putRow();
    await exportNow();
    const reentered = srv.commitSale(saleArgs({ p_created_at: "2026-10-16T08:55:00Z", p_paid_mmk: 1000, p_idempotency_key: "new-key" }));
    const ref = { saleId: reentered.id, receiptNo: reentered.receipt_no, shopId: "shop-1", shiftId: "shift-1", createdAt: reentered.created_at };
    // a's own check: the re-entered sale has the same basket but another time -> it is a CANDIDATE; recreated must not be one of them
    const checkA = await serverCheck(a);
    expect(checkA.result).toBe("inconclusive");
    await expectCode(reconcileOutboxEntry(a.localId, await input(a.localId, { resolution: "recreated", check: checkA, recreatedSale: ref }), deps()), "invalid");
    // with a different basket the new sale is not a candidate: recreated is accepted
    await localDb.syncOutbox.update(a.localId, { args: { ...a.args, p_paid_mmk: 1500 } });
    await localDb.syncOutbox.update(b.localId, { args: { ...b.args, p_paid_mmk: 1500 } });
    await exportNow();
    const s1 = await reconcileOutboxEntry(a.localId, await input(a.localId, { resolution: "recreated", recreatedSale: ref }), deps());
    expect(s1.reconciliation).toMatchObject({ resolution: "recreated", serverRef: { saleId: reentered.id, receiptNo: reentered.receipt_no } });
    await expectCode(reconcileOutboxEntry(b.localId, await input(b.localId, { resolution: "recreated", recreatedSale: ref }), deps()), "sale-already-linked");
    expect((await localDb.syncOutbox.get(b.localId))!.status).toBe("conflict");
  });
});

// ================================================================= owner ==

describe("owner authorization: verified by the main process with the server at the moment of reconciling", () => {
  it("non-owner (server says CASHIER) -> refused, nothing written, refusal logged", async () => {
    auth.state.user = CASHIER;
    const row = await putRow();
    await exportNow();
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps()), "owner-refused");
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("conflict");
    expect(await logEvents()).toEqual([`refused:${row.localId}`]);
    expect((await listReconciliationLog())[0].detail).toMatch(/not-owner/);
  });

  it("TAMPERED RENDERER CLAIM: the renderer believes it is the owner (authStore ADMIN), the server says CASHIER -> refused", async () => {
    useAuthStore.setState({ currentUserId: "admin-1", currentRole: "ADMIN" });
    auth.state.user = CASHIER;
    const row = await putRow();
    await exportNow();
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps()), "owner-refused");
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("conflict");
  });

  it("OFFLINE -> refused, even though the same owner token was verified a moment earlier (no cached verification)", async () => {
    const a = await putRow();
    const b = await putRow();
    await exportNow();
    await reconcileOutboxEntry(a.localId, await input(a.localId), deps());
    auth.state.down = true;
    const err = await reconcileOutboxEntry(b.localId, await input(b.localId), deps()).then(() => null, (e: ReconcileError) => e);
    expect(err?.code).toBe("offline");
    expect(err?.message).toMatch(/live owner check/);
    expect((await localDb.syncOutbox.get(b.localId))!.status).toBe("conflict");
  });

  it("no main process (plain browser / older preload) -> refused; a session the server rejects -> refused", async () => {
    const row = await putRow();
    await exportNow();
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps({ attest: undefined })), "no-desktop");
    auth.state.status = 401;
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId), deps()), "owner-refused");
    expect(reconcileBlock(row, { isOwner: true, canVerifyOwner: false, exportedDigest: "x", currentDigest: "x" })).toBe("no-desktop");
  });

  it("FORGED ATTESTATION from the renderer (fake owner + made-up seal) is written but rejected on the next integrity check and blocks again", async () => {
    const row = await putRow();
    await exportNow();
    const forged = deps({ attest: async () => ({ ok: true, code: "owner", owner: { userId: "admin-1", name: "Owner One", orgId: "org-1", role: "ADMIN", verifiedAt: NOW.toISOString(), source: "backend" }, seal: "f".repeat(64) }) });
    await reconcileOutboxEntry(row.localId, await input(row.localId), forged);
    const v = await verifyReconciledEntries(verifyDeps());
    expect(v.reverted).toEqual([row.localId]);
    expect((await localDb.syncOutbox.get(row.localId))).toMatchObject({ status: "archived", reconcileRejected: { reason: expect.stringMatching(/seal/) } });
    expect((await blockingOutboxRows(verifyDeps())).map((r) => r.localId)).toEqual([row.localId]);
  });
});

// ============================================== crash / duplicate / race ==

describe("crash consistency, duplicates and concurrent updates", () => {
  it("CRASH between the status write and the log write: one Dexie transaction -> neither is written; a retry then succeeds once", async () => {
    const row = await putRow();
    await exportNow();
    const inp = await input(row.localId);
    const spy = vi.spyOn(localDb.syncState, "put").mockImplementationOnce(() => { throw new Error("power cut"); });
    await expect(reconcileOutboxEntry(row.localId, inp, deps())).rejects.toThrow(/power cut/);
    spy.mockRestore();
    expect((await localDb.syncOutbox.get(row.localId))).toEqual(row); // status write rolled back
    expect(await listReconciliationLog()).toEqual([]);
    // "restart": the row is still conflict, the export record is still valid, reconcile works
    const stored = await reconcileOutboxEntry(row.localId, inp, deps());
    expect(stored.status).toBe("reconciled");
    expect(await logEvents()).toEqual([`reconciled:${row.localId}`]);
  });

  it("two windows reconcile the same entry at once -> exactly one succeeds", async () => {
    const row = await putRow();
    await exportNow();
    const inp = await input(row.localId);
    const results = await Promise.allSettled([
      reconcileOutboxEntry(row.localId, inp, deps()),
      reconcileOutboxEntry(row.localId, { ...inp, resolution: "cancelled", reason: "second window reason" }, deps()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["already-reconciled", "changed"]).toContain((rejected.reason as ReconcileError).code);
    expect((await listReconciliationLog()).filter((l) => l.event === "reconciled")).toHaveLength(1);
  });

  it("COMPARE-AND-SET: the entry changed after the owner opened it (another window restored it / a retry) -> refused, nothing written", async () => {
    useAuthStore.setState({ currentUserId: "admin-1", currentRole: "ADMIN" });
    const row = await putRow({ status: "archived", statusBeforeArchive: "conflict" });
    await exportNow();
    const inp = await input(row.localId);
    await restoreSetAsideEntry(row.localId); // another window: back to conflict (reconcilable, but not the row the owner saw)
    await expectCode(reconcileOutboxEntry(row.localId, inp, deps()), "changed");
    await setAsideOutboxEntry(row.localId, { wasExported }); // set aside again: same status, different row
    await expectCode(reconcileOutboxEntry(row.localId, inp, deps()), "changed");
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("archived");
    // the change can also land while the owner check is running
    const inp2 = await input(row.localId);
    const slow = deps({
      attest: async (r) => {
        await localDb.syncOutbox.update(row.localId, { archiveReason: "edited meanwhile" });
        return authority.attest(r.accessToken, r);
      },
    });
    await expectCode(reconcileOutboxEntry(row.localId, inp2, slow), "changed");
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("archived");
    expect((await listReconciliationLog()).filter((l) => l.event === "reconciled")).toHaveLength(0);
  });
});

// ======================================================== response lost ==

describe("server committed but the response was lost", () => {
  it("the drain gets a network error after the server committed; the owner sets it aside; the check finds the sale -> 'cancelled' refused, 'matched' references it; no second sale, no write", async () => {
    rpc.mockImplementationOnce((_name: string, args: Record<string, unknown>) => {
      srv.commitSale(args); // committed ...
      return Promise.resolve({ data: null, status: 0, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } }); // ... reply lost
    });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: saleArgs({ p_idempotency_key: undefined }), shopId: "shop-1" });
    await expect(drainOutbox()).resolves.toBe("network");
    const [queued] = await localDb.syncOutbox.toArray();
    expect(queued.status).toBe("pending");
    expect(srv.sales).toHaveLength(1);

    useAuthStore.setState({ currentUserId: "admin-1", currentRole: "ADMIN" });
    await exportNow();
    await setAsideOutboxEntry(queued.localId, { wasExported });
    const rpcCalls = rpc.mock.calls.length;

    const row = (await localDb.syncOutbox.get(queued.localId))!;
    const check = await serverCheck(row);
    expect(check).toMatchObject({ result: "recorded", matches: [{ saleId: srv.sales[0].id, receiptNo: srv.sales[0].receipt_no }] });
    // cancelled: refused — the server has not decided it (M3: "Confirm with server" first)
    await expectCode(reconcileOutboxEntry(row.localId, await input(row.localId, { check }), deps()), "undecided");
    const stored = await reconcileOutboxEntry(row.localId, await input(row.localId, { resolution: "matched", check, reason: "Server has it: receipt matches the export" }), deps());
    expect(stored.reconciliation).toMatchObject({ resolution: "matched", serverRef: { saleId: srv.sales[0].id } });

    expect(rpc.mock.calls.length).toBe(rpcCalls); // reconciling sent no RPC
    expect(srv.sales).toHaveLength(1); // and created nothing
    expect(auth.calls.every((c) => /\/rpc\/app_role$|\/rpc\/app_user_id$|\/users\?/.test(c.url))).toBe(true);
    expect(await localDb.sales.count()).toBe(0);
    expect(await localDb.inventory.count()).toBe(0);
    expect(await localDb.movements.count()).toBe(0);
    // and the drain never sends it again
    rpc.mockImplementation(() => { throw new Error("must not be called"); });
    await expect(drainOutbox()).resolves.toBe("drained");
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("reconciled");
  });
});

// ================================================================ tamper ==

describe("tamper detection (record bound to payload + key + localId, sealed by main)", () => {
  async function reconciledRow(): Promise<SyncOutboxEntry> {
    const row = await putRow();
    await exportNow();
    return reconcileOutboxEntry(row.localId, await input(row.localId), deps());
  }

  it.each([
    ["the payload", (r: SyncOutboxEntry) => ({ args: { ...r.args, p_paid_mmk: 1 } }), /entry/],
    ["the idempotency key", (r: SyncOutboxEntry) => ({ idempotencyKey: "99999999-9999-4999-8999-999999999999", args: { ...r.args, p_idempotency_key: "99999999-9999-4999-8999-999999999999" } }), /key|entry/],
    ["the record's reason", (r: SyncOutboxEntry) => ({ reconciliation: { ...r.reconciliation!, reason: "something else entirely" } }), /record/],
    ["the record's resolution", (r: SyncOutboxEntry) => ({ reconciliation: { ...r.reconciliation!, resolution: "matched" as const } }), /matched|record/],
    ["the owner", (r: SyncOutboxEntry) => ({ reconciliation: { ...r.reconciliation!, owner: { ...r.reconciliation!.owner, name: "Someone" } } }), /seal/],
  ])("editing %s -> back to Set aside (needs attention), blocks updates, logged", async (_what, patch, reason) => {
    const r = await reconciledRow();
    await localDb.syncOutbox.update(r.localId, patch(r));
    const v = await verifyReconciledEntries(verifyDeps());
    expect(v.reverted).toEqual([r.localId]);
    const back = (await localDb.syncOutbox.get(r.localId))!;
    expect(back).toMatchObject({ status: "archived", statusBeforeArchive: "conflict", reconcileRejected: { reason: expect.stringMatching(reason) } });
    expect(back.reconciliation).toBeUndefined();
    expect(back.statusBeforeReconcile).toBeUndefined();
    expect(await logEvents()).toEqual([`reconciled:${r.localId}`, `tamper-detected:${r.localId}`]);
    expect((await blockingOutboxRows(verifyDeps())).map((x) => x.localId)).toEqual([r.localId]);
  });

  it("a row forged to 'reconciled' (copied record) is rejected and never becomes sendable", async () => {
    const r = await reconciledRow();
    const victim = await putRow({ status: "pending" });
    await localDb.syncOutbox.update(victim.localId, { status: "reconciled", statusBeforeReconcile: "conflict", reconciliation: r.reconciliation });
    const v = await verifyReconciledEntries(verifyDeps());
    expect(v.reverted).toEqual([victim.localId]);
    expect(v.verified.has(r.localId)).toBe(true);
    expect((await localDb.syncOutbox.get(victim.localId))).toMatchObject({ status: "archived", statusBeforeArchive: "conflict" });
  });

  it("without a main process to check seals: not reverted, but still blocks updates (unverifiable)", async () => {
    const r = await reconciledRow();
    const v = await verifyReconciledEntries({});
    expect(v).toMatchObject({ reverted: [], unverifiable: [r.localId] });
    expect((await blockingOutboxRows({})).map((x) => x.localId)).toEqual([r.localId]);
    expect((await blockingOutboxRows(verifyDeps())).map((x) => x.localId)).toEqual([]);
  });
});

// =========================================================== update guard ==

describe("update guard", () => {
  const report = async (vd = verifyDeps()) => {
    const rows = await blockingOutboxRows(vd);
    return sanitizeAppState(buildAppState({
      outboxIds: rows.map((r) => r.localId), statuses: rows.map((r) => r.status),
      online: true, authenticated: true, saleInProgress: false, exportCoversQueue: false,
    }), NOW.getTime());
  };

  it("a reconciled entry does not block an ordinary install; pending, syncing, failed, conflict, quarantined and set-aside entries still do", async () => {
    const row = await putRow();
    await exportNow();
    await reconcileOutboxEntry(row.localId, await input(row.localId), deps());
    expect(evaluateInstallGuard(await report(), { now: NOW.getTime() })).toMatchObject({ allowed: true, code: "ok" });
    expect(await countUnsyncedOutbox()).toBe(0);
    for (const status of ["pending", "syncing", "failed", "conflict", "quarantined", "archived"] as const) {
      const blocker = await putRow({ status });
      const d = evaluateInstallGuard(await report(), { now: NOW.getTime() });
      expect(d).toMatchObject({ allowed: false, code: "unsynced", unsynced: 1 });
      await localDb.syncOutbox.delete(blocker.localId);
    }
  });
});

// ==================================================== export / import ==

describe("export / import round trip and the recovery tool", () => {
  it("reconciled rows and the log are exported (additive, format v1); the recovery tool never replays them unless --include-reconciled", async () => {
    const rec = await putRow();
    const aside = await putRow({ status: "archived", statusBeforeArchive: "conflict" });
    const conflict = await putRow();
    await exportNow();
    await reconcileOutboxEntry(rec.localId, await input(rec.localId), deps());
    const payload = (await collectQueueExportSnapshot(localDb, ctx())).payload;
    const env = await encryptQueueExport(payload, PASS, { iterations: 100_000 });
    expect(env.formatVersion).toBe(2);
    expect(env.header.summary.byStatus).toEqual({ reconciled: 1, archived: 1, conflict: 1 });
    const back = await decryptQueueExport(JSON.stringify(env), PASS);
    const e = back.entries.find((x) => x.opId === rec.localId)!;
    expect(e).toMatchObject({ status: "reconciled", statusBeforeReconcile: "conflict", idempotencyKey: rec.idempotencyKey, payload: rec.args });
    expect(e.reconciliation).toMatchObject({ resolution: "cancelled", owner: { userId: "admin-1", name: "Owner One" }, check: { result: "not-recorded" } });
    expect(back.reconciliationLog.map((l) => `${l.event}:${l.localId}`)).toEqual([`reconciled:${rec.localId}`]);

    const dry = await replayExport(back, { target: "https://pos.example.test", anonKey: null, accessToken: "t", dryRun: true });
    expect(Object.fromEntries(dry.ops.map((o) => [o.opId, o.outcome]))).toEqual({
      [rec.localId]: "skipped-reconciled", [aside.localId]: "skipped-set-aside", [conflict.localId]: "skipped-conflict",
    });
    expect(dry.ops.find((o) => o.opId === rec.localId)!.detail).toMatch(/Owner One.*cancelled/);
    expect(exitCodeFor(dry)).toBe(0);
    const forced = await replayExport(back, { target: "https://pos.example.test", anonKey: null, accessToken: "t", dryRun: true, includeReconciled: true, includeConflicts: true });
    expect(forced.ops.find((o) => o.opId === rec.localId)!.outcome).toBe("planned");
    const fetchSpy = vi.fn();
    await replayExport(back, { target: "https://pos.example.test", anonKey: null, accessToken: "t", fetchImpl: fetchSpy as unknown as typeof fetch, includeConflicts: false });
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing replayable without the flags
  });

  it("the export records, per entry, the digest of exactly what was exported", async () => {
    const a = await putRow();
    const { payload, digests } = await collectQueueExportSnapshot(localDb, ctx());
    expect(digests).toEqual([{ opId: a.localId, digest: await entryDigest(a) }]);
    expect(payload.entries.map((x) => x.opId)).toEqual([a.localId]);
    recordQueueExport(digests, NOW);
    expect(exportedEntry(a.localId)).toEqual({ digest: await entryDigest(a), at: NOW.toISOString() });
  });
});

// ============================================================ historical ==

describe("historical queues: 1.0.15 rows, RC1/RC2 rows and files, id mappings", () => {
  it("a 1.0.15 untagged row (quarantined at startup) and an RC2 set-aside row can be reconciled; their history is kept", async () => {
    const legacy = await putRow({ status: "pending", backendOrigin: undefined, seq: undefined });
    await quarantineForeignOutboxEntries(localDb, currentBackendOrigin());
    const rc2 = await putRow({ status: "archived", statusBeforeArchive: "quarantined", archivedAt: "2026-10-16T07:00:00Z", archivedBy: "admin-1", archiveReason: "RC2 set aside" });
    await exportNow();
    const q = (await localDb.syncOutbox.get(legacy.localId))!;
    expect(q.status).toBe("quarantined");
    const s1 = await reconcileOutboxEntry(legacy.localId, await input(legacy.localId), deps());
    expect(s1.reconciliation!.statusHistory.map((h) => h.status)).toEqual(["queued", "quarantined"]);
    const s2 = await reconcileOutboxEntry(rc2.localId, await input(rc2.localId), deps());
    expect(s2.reconciliation!.statusHistory.map((h) => h.status)).toEqual(["queued", "archived"]);
    expect(s2).toMatchObject({ archiveReason: "RC2 set aside", statusBeforeArchive: "quarantined" });
  });

  it("an RC2 export payload (no reconciliation fields) still validates and replays as before", () => {
    const rc2 = {
      format: "shwephala-queue-export", formatVersion: 1, appVersion: "1.0.16", exportedAt: "2026-10-16T10:00:00Z", tillId: "t", backendHost: "h",
      session: { userId: null, orgId: null, shopId: null, role: null }, provisionalIdMap: [], redactedFields: 0,
      entries: [{
        seq: 1, opId: "o1", idempotencyKey: "k", kind: "rpc", opType: "complete_sale", table: null, tableOp: null, rowId: null, payload: {}, refs: [], provisional: [],
        shopId: null, createdAt: "2026-10-16T09:00:00Z", ringUpAt: null, status: "archived", attempts: 1, lastErrorClass: "permanent", lastError: "x", nextAttemptAt: null,
        backendOrigin: "https://h", quarantineReason: null, archivedAt: "2026-10-16T09:30:00Z", archivedBy: "a", archiveReason: null, statusBeforeArchive: "conflict",
      }],
    };
    const p = validatePayload(rc2);
    expect(p.entries[0]).toMatchObject({ status: "archived", reconciliation: null, statusBeforeReconcile: null });
    expect(p.reconciliationLog).toEqual([]);
  });

  it("id map: a mapping only a reconciled row references may be pruned (its record keeps the resolved ref); one a set-aside row references is kept", async () => {
    const old = new Date(NOW.getTime() - PROVISIONAL_MAP_MAX_AGE_MS - 86_400_000).toISOString();
    await localDb.provisionalIdMap.bulkPut([
      { provisionalId: "shift-prov-a", realId: "shift-real-a", createdAt: old },
      { provisionalId: "shift-prov-b", realId: "shift-real-b", createdAt: old },
    ]);
    const a = await putRow({ refs: [{ field: "p_shift_id", provisionalId: "shift-prov-a" }], args: saleArgs({ p_shift_id: "shift-prov-a", p_idempotency_key: "ka" }), idempotencyKey: "ka" });
    await putRow({ status: "archived", statusBeforeArchive: "conflict", refs: [{ field: "p_shift_id", provisionalId: "shift-prov-b" }], args: saleArgs({ p_shift_id: "shift-prov-b", p_idempotency_key: "kb" }), idempotencyKey: "kb" });
    await exportNow();
    const stored = await reconcileOutboxEntry(a.localId, await input(a.localId), deps());
    expect(stored.reconciliation!.resolvedRefs).toEqual([{ field: "p_shift_id", provisionalId: "shift-prov-a", realId: "shift-real-a" }]);
    expect(await pruneProvisionalIdMap(NOW.getTime())).toBe(1);
    expect((await localDb.provisionalIdMap.toArray()).map((m) => m.provisionalId)).toEqual(["shift-prov-b"]);
  });
});

// sanity: the log rows live in syncState under their own prefix and survive the drain-lease / needs-reauth housekeeping
it("the reconciliation log lives in syncState rows of its own prefix", async () => {
  const row = await putRow();
  await exportNow();
  await reconcileOutboxEntry(row.localId, await input(row.localId), deps());
  await localDb.syncState.delete(SYNC_STATE_KEYS.drainLease);
  await localDb.syncState.delete(SYNC_STATE_KEYS.needsReauth);
  const keys = (await localDb.syncState.toArray()).map((r) => r.key);
  expect(keys.filter((k) => k.startsWith(RECONCILE_LOG_PREFIX))).toHaveLength(1);
});

// ======================================================== never automatic ==

describe("never automatic", () => {
  it("a permanent rejection, a timeout, a retry failure and an export leave the entry unreconciled", async () => {
    rpc.mockResolvedValueOnce({ data: null, status: 400, error: { message: "Shift is closed", details: "", hint: "", code: "P0001" } });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: saleArgs({ p_idempotency_key: undefined }), shopId: "shop-1" });
    await drainOutbox();
    const [row] = await localDb.syncOutbox.toArray();
    expect(row.status).toBe("conflict");
    await exportNow();
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("conflict");
    rpc.mockResolvedValueOnce({ data: null, status: 0, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } });
    await retryOutboxEntry(row.localId);
    await drainOutbox();
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("pending");
    rpc.mockResolvedValueOnce({ data: null, status: 400, error: { message: "Shift is closed", details: "", hint: "", code: "P0001" } });
    await retryOutboxEntry(row.localId);
    await drainOutbox();
    expect((await localDb.syncOutbox.get(row.localId))!.status).toBe("conflict");
    expect(await listReconciliationLog()).toEqual([]);
  });

  it("no code outside stores/data/reconcile.ts writes the status 'reconciled'", () => {
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk(root);
    const writers = files.filter((f) => /status:\s*"reconciled"/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
    expect(writers).toEqual([path.join("stores", "data", "reconcile.ts")]);
  });
});
