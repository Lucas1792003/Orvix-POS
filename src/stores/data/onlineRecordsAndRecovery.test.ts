import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Migration 086 — deployment-blocker correction batch (after 9d37787):
//   2. unreadable / newer-format online-operation records never disappear;
//   3. a non-owner (e.g. a MANAGER) checks only their OWN operations;
//   4. one recovery rule (offlineAuthorisation) for startup classification,
//      stranded attempts, Retry, Restore and Confirm with server; the
//      updater guard counts unresolved online operations.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let actingUser = "user-1";
let actingRole = "CASHIER";
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: actingUser, currentOrgId: "org-1", currentRole: actingRole }) } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb, RECONCILE_LOG_PREFIX } from "../../lib/localDb";
import {
  classifyLegacyQueue, confirmWithServer, enqueueOutbox, recoverStrandedSyncing, restoreSetAsideEntry, retryOutboxEntry, simulateNewAppInstanceForTests,
} from "./outbox";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { registerVerifiedReload } from "./verifiedReload";
import {
  callOnlineOnly, checkOnlineOperation, listUnreadableOnlineRecords, listUnresolvedOnlineOperations, resetOnlineOnlyForTests,
  setAsideUnreadableOnlineRecord, UNREADABLE_SET_ASIDE_PREFIX,
} from "./onlineOnly";
import { registerOperationPrompt } from "./operationPrompt";
import { collectQueueExport, countOnlineRecords, countQueue, onlineRecordKeysBlockingInstall } from "../../lib/queueExport/collect";
import { decryptQueueExport, encryptQueueExport, MIN_KDF_ITERATIONS } from "../../lib/queueExport/format";
import { recordQueueExport, resetQueueExportRecord } from "../../lib/queueExport/exportRecord";
import { currentBackendOrigin } from "../../lib/backendOrigin";

const payArgs = { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
const SCOPE = "pay_supplier_lump_sum#s1|shop-1";
const ctx = { appVersion: "t", tillId: "till", backendHost: "127.0.0.1:54321" };
const sale = (n = 1) => ({
  p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0,
  p_items: [{ product_id: "p1", qty: n, units_per_item: 1 }], p_created_at: new Date().toISOString(),
});
const op = (id: string, over: Record<string, unknown> = {}) => ({
  v: 2, id, name: "pay_supplier_lump_sum", orgId: "org-1", userId: "user-1", fingerprint: id, scope: SCOPE,
  args: { ...payArgs, p_idempotency_key: `0190a000-0000-7000-8000-0000000000${id.slice(-2)}` }, status: "unresolved",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, backendOrigin: currentBackendOrigin(), ...over,
});
const put = (key: string, value: unknown) => localDb.syncState.put({ key, value: typeof value === "string" ? value : JSON.stringify(value), updatedAt: "x" });
const executions = () => fake.server.executions.pay_supplier_lump_sum ?? 0;
const rows = async () => (await localDb.syncOutbox.toArray()).sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));

beforeEach(async () => {
  fake.reset();
  actingUser = "user-1";
  actingRole = "CASHIER";
  fake.setCaller("user-1");
  setExecutorCapabilityForTests("available");
  fake.enableExecutor();
  simulateNewAppInstanceForTests();
  resetOnlineOnlyForTests();
  resetQueueExportRecord();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  registerVerifiedReload(null);
  registerOperationPrompt(async () => "new");
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  registerOperationPrompt(null);
});

describe("2. unreadable financial records never disappear", () => {
  it("a CORRUPT record (not JSON): counted, listed raw, blocks the same payment entered again — nothing sent", async () => {
    await put("online-op:op-bad1", "{\"v\":2,\"id\":\"op-bad1\",\"name\":\"pay_supplier_lu");
    expect(await countOnlineRecords(localDb, "org-1")).toEqual({ unresolved: 0, unreadable: 1, total: 1 });
    const [r] = await listUnreadableOnlineRecords();
    expect(r).toMatchObject({ key: "online-op:op-bad1", reason: "unparseable", raw: "{\"v\":2,\"id\":\"op-bad1\",\"name\":\"pay_supplier_lu" });
    expect(r.claimed).toEqual({ name: null, scope: null, orgId: null, userId: null, backendOrigin: null, version: null });   // nothing invented
    await expect(callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 })).rejects.toThrow(/cannot read/);
    expect(executions()).toBe(0);
  });

  it("a NEWER build's record (format 3) for the same payment blocks it; one that names ANOTHER payment does not", async () => {
    await put("online-op:op-v3", { ...op("op-v3"), v: 3 });
    await expect(callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 })).rejects.toThrow(/cannot read/);
    expect(executions()).toBe(0);
    await localDb.syncState.clear();
    await put("online-op:op-v3b", { ...op("op-v3b"), v: 3, scope: "pay_supplier_lump_sum#s2|shop-1" });
    const r = await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    expect(r.error).toBeNull();
    expect(executions()).toBe(1);
  });

  it("survives a reload / another window (it is the stored record that blocks, not memory)", async () => {
    await put("online-op:op-bad2", "garbage");
    simulateNewAppInstanceForTests();
    resetOnlineOnlyForTests();
    await expect(callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 })).rejects.toThrow(/cannot read/);
  });

  it("an IndexedDB read error: nothing is sent, and the count fails (the UI shows a read error, never 'none')", async () => {
    vi.spyOn(localDb.syncState, "filter").mockImplementation(() => { throw new Error("IDB read failed"); });
    await expect(callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 })).rejects.toThrow(/could not check/);
    expect(executions()).toBe(0);
    vi.restoreAllMocks();
    vi.spyOn(localDb.syncState, "where").mockImplementation(() => { throw new Error("IDB read failed"); });
    await expect(countOnlineRecords(localDb, "org-1")).rejects.toThrow(/IDB read failed/);
    await expect(onlineRecordKeysBlockingInstall(localDb)).rejects.toThrow(/IDB read failed/);
  });

  it("export: the RAW record verbatim, format 3 (older tools refuse the file instead of dropping it); counts include it; org scoping uses only what it claims", async () => {
    await put("online-op:op-bad3", "not json at all");
    await put("online-op:op-v3c", { ...op("op-v3c"), v: 3, orgId: "org-2" });
    const p = await collectQueueExport(localDb, { ...ctx, session: { userId: "user-1", orgId: "org-1", shopId: null, role: "CASHIER" } });
    expect(p.formatVersion).toBe(3);
    expect(p.unreadableOnlineRecords.map((r) => r.key)).toEqual(["online-op:op-bad3"]);   // the org-2 claim is not this export's
    expect(p.unreadableOnlineRecords[0].raw).toBe("not json at all");
    expect((await countQueue(localDb, "org-1"))).toMatchObject({ total: 1, unreadableOnlineRecords: 1 });
    const env = await encryptQueueExport(p, "correct horse battery", { iterations: MIN_KDF_ITERATIONS });
    expect(env.formatVersion).toBe(3);
    expect(env.header.summary).toMatchObject({ total: 1, unreadableOnlineRecords: 1 });
    expect((await decryptQueueExport(JSON.stringify(env), "correct horse battery")).unreadableOnlineRecords[0].raw).toBe("not json at all");
    // the sign-in screen (no session): the whole till
    const all = await collectQueueExport(localDb, { ...ctx, session: { userId: null, orgId: null, shopId: null, role: null } });
    expect(all.unreadableOnlineRecords).toHaveLength(2);
  });

  it("the owner sets one aside only AFTER an export; the raw record is kept and the action audited; then the payment can be entered", async () => {
    await put("online-op:op-bad4", "garbage");
    actingRole = "ADMIN";
    await expect(setAsideUnreadableOnlineRecord("online-op:op-bad4")).rejects.toThrow(/Export the pending data first/);
    recordQueueExport(["online-op:other"]);                            // an export WITHOUT this record is not enough
    await expect(setAsideUnreadableOnlineRecord("online-op:op-bad4")).rejects.toThrow(/Export the pending data first/);
    recordQueueExport(["online-op:op-bad4"]);
    await setAsideUnreadableOnlineRecord("online-op:op-bad4");
    actingRole = "CASHIER";
    expect(await localDb.syncState.get("online-op:op-bad4")).toBeUndefined();
    expect(JSON.parse((await localDb.syncState.get(`${UNREADABLE_SET_ASIDE_PREFIX}op-bad4`))!.value!)).toMatchObject({ raw: "garbage", originalKey: "online-op:op-bad4" });
    const audit = (await localDb.syncState.where("key").startsWith(RECONCILE_LOG_PREFIX).toArray()).map((r) => JSON.parse(r.value!));
    expect(audit.some((l) => l.event === "owner-action" && /outcome is UNKNOWN/.test(l.detail))).toBe(true);
    expect((await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 })).error).toBeNull();
    // the warning clears (it no longer blocks new entries) ...
    expect(await countOnlineRecords(localDb, "org-1")).toMatchObject({ unreadable: 0, total: 0 });
    // ... but it is still exported and still blocks an install (its outcome is unknown)
    expect(await onlineRecordKeysBlockingInstall(localDb)).toContain(`${UNREADABLE_SET_ASIDE_PREFIX}op-bad4`);
    const p = await collectQueueExport(localDb, { ...ctx, session: { userId: null, orgId: null, shopId: null, role: null } });
    expect(p.unreadableOnlineRecords).toEqual([expect.objectContaining({ raw: "garbage", setAside: true })]);
  });

  it("a readable record with a status this build does not know (a newer build's) counts as unreadable", async () => {
    await put("online-op:op-new", op("op-new", { status: "sending" }));
    expect(await countOnlineRecords(localDb, "org-1")).toMatchObject({ unresolved: 0, unreadable: 1 });
    await expect(callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 })).rejects.toThrow(/cannot read/);
  });

  it("a record CLAIMING another organisation is not listed to this organisation's owner and cannot be set aside by them", async () => {
    await put("online-op:op-v3x", { ...op("op-v3x"), v: 3, orgId: "org-2" });
    actingRole = "ADMIN";
    expect(await listUnreadableOnlineRecords()).toHaveLength(0);
    recordQueueExport(["online-op:op-v3x"]);
    await expect(setAsideUnreadableOnlineRecord("online-op:op-v3x")).rejects.toThrow(/another organisation/);
    expect(await localDb.syncState.get("online-op:op-v3x")).toBeTruthy();
  });

  it("a non-owner cannot set an unreadable record aside", async () => {
    await put("online-op:op-bad5", "garbage");
    recordQueueExport(["online-op:op-bad5"]);
    await expect(setAsideUnreadableOnlineRecord("online-op:op-bad5")).rejects.toThrow(/Only the owner/);
    expect(await localDb.syncState.get("online-op:op-bad5")).toBeTruthy();
  });
});

describe("3. own-scope view: a non-owner sees and checks only their OWN operations", () => {
  beforeEach(async () => {
    await put("online-op:op-m01", op("op-m01", { userId: "mgr-1" }));
    await put("online-op:op-c02", op("op-c02", { userId: "cash-2" }));
    await put("online-op:op-x03", op("op-x03", { userId: "mgr-1", orgId: "org-2" }));
  });

  it("the own list holds only the signed-in user's operations of their organisation (and the own badge counts only those)", async () => {
    actingUser = "mgr-1"; actingRole = "MANAGER";
    expect((await listUnresolvedOnlineOperations(Date.now(), { own: true })).map((o) => o.id)).toEqual(["op-m01"]);
    expect((await countOnlineRecords(localDb, "org-1", "mgr-1")).unresolved).toBe(1);
    expect((await countOnlineRecords(localDb, "org-1")).unresolved).toBe(2);
  });

  it("a MANAGER's Check is a read-only lookup (never a fence) of their own operation; another user's or organisation's is refused before anything is asked", async () => {
    actingUser = "mgr-1"; actingRole = "MANAGER"; fake.setCaller("mgr-1");
    await checkOnlineOperation("op-m01");
    expect(fake.callsFor("op_status").map((c) => c.args.p_fence)).toEqual([false]);
    await expect(checkOnlineOperation("op-c02")).rejects.toThrow(/Only the person who entered it/);
    await expect(checkOnlineOperation("op-x03")).rejects.toThrow(/another organisation/);
    expect(fake.callsFor("op_status")).toHaveLength(1);
  });

  it("the owner may check another user's operation of the same organisation (never another organisation's)", async () => {
    actingUser = "admin-1"; actingRole = "ADMIN"; fake.setCaller("admin-1", true);
    await checkOnlineOperation("op-c02");
    await expect(checkOnlineOperation("op-x03")).rejects.toThrow(/another organisation/);
  });

  it("'Confirm with server' is an owner action, enforced in the function (not only the UI)", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(), shopId: "shop-1" });
    const [r] = await rows();
    actingRole = "MANAGER";
    await expect(confirmWithServer(r.localId)).rejects.toThrow(/Only the owner/);
  });
});

describe("4. one recovery rule for every path", () => {
  /** A Batch 2A write-ahead row: no staged flag; one attempt recorded (as
   *  every build records when an online attempt falls back to the queue). */
  const legacyRow = async (over: Record<string, unknown>) => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale(), shopId: "shop-1" });
    const [r] = await rows();
    await localDb.syncOutbox.update(r.localId, { writeAhead: true, staged: undefined, fenceRequired: undefined, attempts: 1, ...over } as never);
    return (await localDb.syncOutbox.get(r.localId))!;
  };
  const legacyClose = async (over: Record<string, unknown>, withLocalProof: boolean) => {
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: { p_shift_id: "shift-9", p_closing_cash_mmk: 0 }, shopId: "shop-1" });
    const [r] = await rows();
    await localDb.syncOutbox.update(r.localId, { writeAhead: true, staged: undefined, fenceRequired: undefined, ...over } as never);
    if (withLocalProof) {
      await localDb.shifts.put({ id: "shift-9", shopId: "shop-1", cashierId: "user-1", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), openingCashMmk: 0, idempotencyKey: r.idempotencyKey } as never);
    }
    return (await localDb.syncOutbox.get(r.localId))!;
  };

  it("RETRY of an in-doubt Batch 2A row WITH staged records: authorised offline — resent with its key (never fenced), proof kept", async () => {
    const r = await legacyRow({ inDoubt: true, provisional: [{ table: "sales", ids: ["sale-local-1"] }], status: "conflict" });
    await retryOutboxEntry(r.localId);
    expect(await localDb.syncOutbox.get(r.localId)).toMatchObject({ status: "pending", staged: true });
    expect((await localDb.syncOutbox.get(r.localId))!.fenceRequired).toBeUndefined();
  });

  it("review-10 H1: RETRY of a first online attempt (write-ahead, no staged flag, no attempt recorded) is held, never made 'authorised' and resent — also once moved off 'syncing'; a row being sent is refused", async () => {
    const a = await legacyRow({ status: "syncing", attempts: 0, inDoubt: undefined, provisional: [{ table: "sales", ids: ["sale-local-9"] }] });
    await expect(retryOutboxEntry(a.localId)).rejects.toThrow(/being sent right now/);
    await localDb.syncOutbox.update(a.localId, { status: "pending" });     // e.g. moved by an older build's Retry
    await retryOutboxEntry(a.localId);
    expect(await localDb.syncOutbox.get(a.localId)).toMatchObject({ status: "conflict", fenceRequired: true, staged: false });
    expect(await classifyLegacyQueue()).toBe(0);
    expect((await localDb.syncOutbox.get(a.localId))!.staged).toBe(false);
  });

  it("RETRY of an in-doubt Batch 2A row with NOTHING staged: held (lookup + fence), never resent", async () => {
    const r = await legacyRow({ inDoubt: true, provisional: [], status: "conflict" });
    await retryOutboxEntry(r.localId);
    expect(await localDb.syncOutbox.get(r.localId)).toMatchObject({ status: "conflict", fenceRequired: true, staged: false });
  });

  it("RESTORE of a set-aside Batch 2A row (being sent, staged records): in doubt, staged — not fenced; the same row with nothing staged: held", async () => {
    actingRole = "ADMIN";
    const a = await legacyRow({ status: "archived", statusBeforeArchive: "syncing", inDoubt: true, attempts: 2, provisional: [{ table: "sales", ids: ["sale-local-2"] }] });
    expect(await restoreSetAsideEntry(a.localId)).toMatchObject({ status: "pending", inDoubt: true, staged: true });
    await localDb.syncOutbox.clear();
    const b = await legacyRow({ status: "archived", statusBeforeArchive: "syncing", inDoubt: true, attempts: 2, provisional: [] });
    expect(await restoreSetAsideEntry(b.localId)).toMatchObject({ status: "conflict", fenceRequired: true });
  });

  it("RESTORE of the CURRENT build's interrupted FIRST attempt (being sent, attempts 0) is held even with staged records — exactly as a restart does", async () => {
    actingRole = "ADMIN";
    const r = await legacyRow({ status: "archived", statusBeforeArchive: "syncing", attempts: 0, provisional: [{ table: "sales", ids: ["sale-local-3"] }] });
    expect(await restoreSetAsideEntry(r.localId)).toMatchObject({ status: "conflict", fenceRequired: true });
  });

  it("CONFIRM WITH SERVER on an authorised Batch 2A row (staged records): looked up, NEVER fenced; on one never authorised: fenced", async () => {
    actingRole = "ADMIN";
    const a = await legacyRow({ status: "archived", statusBeforeArchive: "conflict", inDoubt: true, provisional: [{ table: "sales", ids: ["sale-local-4"] }] });
    expect(await confirmWithServer(a.localId)).toBe("undecided");
    expect(fake.server.idempotency.get(a.idempotencyKey!)).toBeUndefined();
    await localDb.syncOutbox.clear();
    const b = await legacyRow({ status: "archived", statusBeforeArchive: "conflict", inDoubt: true, provisional: [] });
    expect(await confirmWithServer(b.localId)).toBe("abandoned");
  });

  it("a STRANDED Batch 2A close (being sent, a later attempt, nothing staged) with the local shift row carrying its key: authorised — resent, not fenced; without that proof: held", async () => {
    const a = await legacyClose({ status: "syncing", attempts: 1, provisional: [] }, true);
    expect(await recoverStrandedSyncing(0)).toBe(1);
    expect(await localDb.syncOutbox.get(a.localId)).toMatchObject({ status: "pending", inDoubt: true, staged: true });
    await localDb.syncOutbox.clear();
    await localDb.shifts.clear();
    const b = await legacyClose({ status: "syncing", attempts: 1, provisional: [] }, false);
    await recoverStrandedSyncing(0);
    expect(await localDb.syncOutbox.get(b.localId)).toMatchObject({ status: "conflict", fenceRequired: true });
  });

  it("startup classification, restore and retry agree on the same Batch 2A row (staged records, in doubt): all authorised", async () => {
    const r = await legacyRow({ inDoubt: true, provisional: [{ table: "sales", ids: ["sale-local-5"] }] });
    expect(await classifyLegacyQueue()).toBe(0);
    expect(await localDb.syncOutbox.get(r.localId)).toMatchObject({ staged: true });
  });

  it("the updater guard counts unresolved online operations and unreadable records (and nothing settled)", async () => {
    await put("online-op:op-u01", op("op-u01"));
    await put("online-op:op-s02", op("op-s02", { status: "settled", outcome: "applied", decidedBy: "server" }));
    await put("online-op:op-bad", "garbage");
    expect((await onlineRecordKeysBlockingInstall(localDb)).sort()).toEqual(["online-op:op-bad", "online-op:op-u01"]);
  });
});
