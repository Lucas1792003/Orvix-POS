import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CartItem } from "../../types";

// ---------------------------------------------------------------------------
// v87 client: recovery compatibility with migration 087, driven through the
// REAL sale slice, write-ahead engine, outbox, journal and recovery state
// against the fake server's 087 emulation (testing/fakeSupabase.ts, enable087).
// Contract: docs/selfhost-migration/phase-g/migration-087.md ("Client contract").
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" };
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => acting } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb, type SyncOutboxEntry } from "../../lib/localDb";
import { createSaleSlice } from "./slices/saleSlice";
import {
  drainOutbox, enqueueOutbox, registerOutboxReconciler, settleBeforeReplacement, simulateNewAppInstanceForTests, OWNER_REVIEW,
} from "./outbox";
import { registerOperationPrompt } from "./operationPrompt";
import { callOnlineOnly, resetOnlineOnlyForTests } from "./onlineOnly";
import { resetWriteAheadForTests } from "./writeAhead";
import { beginOperation, newIdempotencyKey, setExecutorCapabilityForTests } from "./idempotentRpc";
import { getJournalRecord, journalCommitted, journalPrinted, listJournal } from "./opJournal";
import {
  isRecoveryBlocked, loadRecoveryState, recoveryView, resetRecoveryStateForTests, storedEpoch, storeTillCredential, simulatePreV87xClientForTests,
  OFFLINE_FINANCIAL_DISABLED,
} from "./recoveryState";
import {
  approveTill, chunkRecords, currentUploadPlan, refreshRecoveryEpoch, registerThisTill, runRecoveryCheck, uploadRecordOf, uploadTillJournal,
} from "./recovery87";
import { classifyFailure, recoveryCodeOf } from "../../lib/failureClass";
import { resetRecoveryGateForTests } from "./recoveryGate";
import { EPOCH_HEADER, epochHeaderFetch, setEpochHeaderProvider } from "../../lib/epochHeader";

const restart = async () => {
  simulateNewAppInstanceForTests();
  resetWriteAheadForTests();
  resetOnlineOnlyForTests();
  resetRecoveryStateForTests(null);                 // a new process: nothing in memory, state read from disk
  resetRecoveryGateForTests();
  await loadRecoveryState(acting.currentOrgId);
};

function makeSaleStore() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (updater: any) => { const patch = typeof updater === "function" ? updater(state) : updater; state = { ...state, ...patch }; };
  const get = () => state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = createSaleSlice(set as any, get as any, {} as any);
  state = {
    productUnits: [{ id: "u1", isDefault: true, baseQuantity: 1 }], products: [{ id: "p1", isNonStock: false }], getProductPrice: () => 0,
    getInventoryQty: (shopId: string, productId: string) =>
      state.inventory.find((i: { shopId: string; productId: string }) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits ?? 0,
    shifts: [], sales: [], saleItems: [], movements: [], auditLogs: [], refunds: [], refundVoidRequests: [],
    inventory: [{ shopId: "shop-1", productId: "p1", qtyBaseUnits: 100 }],
    ...slice,
  };
  registerOutboxReconciler("complete_sale", (data, provisional) => get().reconcileCompleteSale(data, provisional ?? []));
  return { get };
}
const cartItem = (over: Partial<CartItem> = {}): CartItem => ({
  id: "c1", productId: "p1", productUnitId: "u1", name: "Tea Mix", unitName: "Can", qty: 1, unitPriceMmk: 1000, unitsPerItem: 1,
  unitBaseQuantity: 1, priceLevelId: "pl-retail", ...over,
});
const saleInput = () => ({ shopId: "shop-1", cashierId: "user-1", shiftId: "shift-1", cartDiscountPct: 0, paymentMethod: "CASH" as const, paidMmk: 5000, cartItems: [cartItem()] });
const rows = async () => (await localDb.syncOutbox.toArray()) as (SyncOutboxEntry & { seq?: number })[];
const online = (on: boolean) => vi.stubGlobal("navigator", { onLine: on });
const v87Calls = () => fake.calls.filter((c) => c.name === "op_execute_v87");
const recoveryCodes = () => fake.calls.filter((c) => c.name.startsWith("recovery_")).map((c) => c.name);

/** A registered, reconciled till with a verified epoch (the normal state). */
async function normalTill(): Promise<string> {
  const tillId = recoveryView().tillId;
  const secret = fake.register87Till(tillId, { reconciled: true });
  await storeTillCredential({ orgId: "org-1", secret });
  const r = await refreshRecoveryEpoch({ shopId: "shop-1" });
  expect(r.kind).toBe("issued");
  return secret;
}

beforeEach(async () => {
  fake.reset();
  fake.enable087();
  fake.setCaller("user-1", false, "org-1");
  setExecutorCapabilityForTests("available");
  acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" };
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await localDb.authCache.put({ authId: "auth-test-user", userId: "user-1", role: "CASHIER", shopId: "shop-1", isActive: true, hasTotp: false, cachedAt: new Date().toISOString() });
  online(true);
  await restart();
});
afterEach(() => {
  simulatePreV87xClientForTests(false);
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

describe("refusal contract (classifier)", () => {
  it("PT429 / the fixed recovery message is RECOVERY: nothing ran, held, never a network failure", () => {
    const f = classifyFailure({ status: 429, code: "PT429", message: "ORG_SUSPENDED: server recovery in progress [RECOVERY_HOLD]" });
    expect(f).toMatchObject({ klass: "RECOVERY", mayHaveCommitted: false, hold: "recovery" });
    // the Envoy maintenance listener (API_GUARD) too
    expect(classifyFailure({ status: 429, code: "PT429", message: "ORG_SUSPENDED: server recovery in progress [API_GUARD]" }).klass).toBe("RECOVERY");
    expect(recoveryCodeOf("ORG_SUSPENDED: server recovery in progress [TILL_NOT_RECONCILED]")).toBe("TILL_NOT_RECONCILED");
    // a plain 429 (rate limit) and the 086-era suspension keep their meaning
    expect(classifyFailure({ status: 429, message: "Too many requests" }).klass).toBe("TEMPORARY_SERVER");
    expect(classifyFailure({ status: 503, code: "PT503", message: "ORG_SUSPENDED" }).klass).toBe("ORG_SUSPENDED");
  });
});

describe("epoch management", () => {
  it("a server without 087 (PGRST202): pre-087 behaviour, no epoch required", async () => {
    fake.enable087(false);
    await restart();
    const r = await refreshRecoveryEpoch();
    expect(r.kind).toBe("legacy-server");
    expect(recoveryView()).toMatchObject({ mode: "legacy-server", allowed: true });
  });

  it("an unknown server while offline: new sales are blocked (nothing saved)", async () => {
    online(false);
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    expect(await rows()).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("no usable epoch (till not registered): blocked before anything is saved or sent", async () => {
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    expect(recoveryView().mode).toBe("till-unregistered");
    expect(await rows()).toHaveLength(0);
    expect(v87Calls()).toHaveLength(0);
  });

  it("the epoch is persisted with organisation, shop, till and backend; only the server's value", async () => {
    await normalTill();
    const e = storedEpoch()!;
    expect(e).toMatchObject({ orgId: "org-1", shopId: "shop-1", tillId: recoveryView().tillId, backendOrigin: "http://127.0.0.1:54321" });
    expect(e.epoch).toBe(fake.r87.orgs.get("org-1")!.epoch);
    expect(e.witness).toMatchObject({ org: "org-1", epoch_no: 0 });
  });
});

describe("normal and offline sales", () => {
  it("normal sale: op_execute_v87 with the till context and the epoch stamped at creation; journal keeps epoch + signed reply", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    const [call] = v87Calls();
    const ctx = call.args.p_ctx as Record<string, unknown>;
    expect(ctx).toMatchObject({ till: recoveryView().tillId, op_epoch: storedEpoch()!.epoch });
    expect(ctx.till_secret).toMatch(/^secret-/);
    expect(fake.server.sales).toHaveLength(1);                     // executed once, through the 086 executor inside 087
    expect(fake.callsFor("complete_sale")).toHaveLength(0);       // never a direct path
    const { records } = await listJournal({ orgId: "org-1" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: "committed", opEpoch: storedEpoch()!.epoch });
    expect(records[0].signedReply?.sig).toMatch(/^fake-reply-sig:/);
    // the reply's newer witness replaced the stored one (n advanced)
    expect(storedEpoch()!.witness!.n).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  it("v87.x: an offline sale on an 087 server is REFUSED — nothing staged, queued, journaled or sent; online it goes through", async () => {
    await normalTill();
    online(false);
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(err.code).toBe(OFFLINE_FINANCIAL_DISABLED);
    expect(String(err.message)).toMatch(/^Not recorded — nothing was saved\. This till is offline\./);
    expect(await rows()).toHaveLength(0);
    expect(await localDb.sales.count()).toBe(0);
    expect((await listJournal({ orgId: "org-1" })).records).toHaveLength(0);
    expect(fake.calls.filter((c) => c.name !== "recovery_epoch")).toHaveLength(0);
    online(true);
    await get().createSale(saleInput());
    expect(fake.server.sales).toHaveLength(1);
    expect(await rows()).toHaveLength(0);
  });

  it("(pre-v87.x queue) an offline sale queued by the previous build keeps its epoch and is sent later with the same one", async () => {
    await normalTill();
    const epoch = storedEpoch()!.epoch;
    online(false);
    simulatePreV87xClientForTests(true);
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    simulatePreV87xClientForTests(false);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", opEpoch: epoch });
    online(true);
    expect(await drainOutbox()).toBe("drained");
    expect((v87Calls()[0].args.p_ctx as Record<string, unknown>).op_epoch).toBe(epoch);
    expect(await rows()).toHaveLength(0);
    expect((await getJournalRecord(row.idempotencyKey!))).toMatchObject({ state: "committed", opEpoch: epoch });
  });
});

describe("recovery hold received while online", () => {
  it("the refused sale is NOT turned into an offline sale; the till enters a durable hold; later sales blocked online and offline", async () => {
    await normalTill();
    fake.hold87Org("org-1");
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(String(err.message)).toMatch(/Recovery hold active \[RECOVERY_HOLD\]/);
    expect(await rows()).toHaveLength(0);                                   // write-ahead discarded: nothing ran
    expect(await localDb.sales.count()).toBe(0);                             // never staged offline
    const { records } = await listJournal({ orgId: "org-1" });
    expect(records[0]).toMatchObject({ state: "not-applied" });              // the evidence stays
    expect(recoveryView()).toMatchObject({ mode: "hold", allowed: false, code: "RECOVERY_HOLD" });
    const before = v87Calls().length;
    // online again: refused before anything is saved or sent
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    // offline: refused too
    online(false);
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    expect(v87Calls()).toHaveLength(before);
    expect(await rows()).toHaveLength(0);
  });

  it("the committed {outcome:'held'} reply (till witness ahead) is a hold, never an 'unrecognised reply'", async () => {
    await normalTill();
    // the server lost history this till witnessed (a restore): its chain is shorter
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    fake.r87.orgs.get("org-1")!.chain.length = 0;                            // restored without that sale
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(String(err.message)).toMatch(/CONTINUITY_ROLLBACK/);
    expect(recoveryView().mode).toBe("hold");
    expect(fake.r87.orgs.get("org-1")!.held).toBe(true);                      // the server committed the hold
    expect(await rows()).toHaveLength(0);
  });
});

describe("restart, network loss and resuming", () => {
  it("recovery mode survives a restart and a network loss; reconnecting does not clear it; only a verified epoch does", async () => {
    await normalTill();
    // a sale queued offline BEFORE the till learns of the hold (by the previous build: v87.x refuses new ones)
    online(false);
    const { get } = makeSaleStore();
    simulatePreV87xClientForTests(true);
    await get().createSale(saleInput());
    simulatePreV87xClientForTests(false);
    online(true);
    fake.hold87Org("org-1");
    fake.release87Org("org-1");               // (released again WITHOUT an epoch change below)
    fake.hold87Org("org-1");                  // ... a real hold: new epoch, held
    await drainOutbox();
    expect(recoveryView().mode).toBe("hold");
    const [row] = await rows();
    expect(row).toMatchObject({ status: "pending", heldReason: "recovery" });   // kept, same key and epoch
    // restart (app / Electron): the state is read back from disk
    await restart();
    expect(recoveryView()).toMatchObject({ mode: "hold", allowed: false });
    // network loss, then back online: still held (the server still holds it)
    online(false);
    online(true);
    const sent = v87Calls().length;
    expect(await drainOutbox()).toBe("backoff");
    expect(v87Calls()).toHaveLength(sent);                                   // nothing sent automatically
    expect(recoveryCodes()).toContain("recovery_epoch");                     // only asked
    // the server releases the organisation; the till is reconciled for the new epoch
    fake.release87Org("org-1");
    fake.reconcile87Till(recoveryView().tillId);
    const v = await runRecoveryCheck();
    expect(v).toMatchObject({ mode: "normal", allowed: true });
    // the queued sale was created under the OLD epoch: never executed; awaits an owner
    await drainOutbox();
    const [held] = await rows();
    expect(held).toMatchObject({ heldReason: OWNER_REVIEW, opEpoch: row.opEpoch, idempotencyKey: row.idempotencyKey, args: row.args });
    expect(fake.server.sales).toHaveLength(0);
  });
});

describe("stale epoch after a restore", () => {
  it("an operation stamped with a stale epoch is never executed; the till fetches the new epoch; new sales use it", async () => {
    await normalTill();
    const old = storedEpoch()!.epoch;
    // the server was restored and an owner re-opened the organisation under a new epoch (088 stand-in)
    fake.hold87Org("org-1");
    fake.release87Org("org-1");
    fake.reconcile87Till(recoveryView().tillId);
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    // (087 checks the till's witness before the operation: a stale witness is TILL_NOT_RECONCILED)
    expect(String(err.message)).toMatch(/PRE_EPOCH_OPERATION|TILL_NOT_RECONCILED/);
    expect(recoveryView().allowed).toBe(false);
    expect(fake.server.sales).toHaveLength(0);
    // the next sale asks for the epoch first, then succeeds under the NEW one
    await get().createSale(saleInput());
    expect(storedEpoch()!.epoch).not.toBe(old);
    expect((v87Calls().at(-1)!.args.p_ctx as Record<string, unknown>).op_epoch).toBe(storedEpoch()!.epoch);
    expect(fake.server.sales).toHaveLength(1);
    expect(storedEpoch()!.previous?.[0]?.epoch).toBe(old);                   // the old epoch is kept as history
  });
});

describe("legacy queue", () => {
  it("an entry queued without an epoch (older build) is never sent, re-stamped, re-keyed or fenced on an 087 server", async () => {
    await normalTill();
    const key = newIdempotencyKey();
    await localDb.syncOutbox.put({
      localId: "outbox-legacy", kind: "rpc", name: "complete_sale", args: { ...saleInputArgs(), p_idempotency_key: key }, idempotencyKey: key,
      shopId: "shop-1", createdAt: new Date().toISOString(), status: "pending", attempts: 0, backendOrigin: "http://127.0.0.1:54321",
      actorId: "user-1", orgId: "org-1", staged: true,
    } as SyncOutboxEntry);
    await drainOutbox();
    expect(v87Calls()).toHaveLength(0);
    expect(fake.calls.filter((c) => c.name === "op_status_v87" || c.name === "op_status")).toHaveLength(0);
    const [row] = await rows();
    expect(row).toMatchObject({ heldReason: OWNER_REVIEW, idempotencyKey: key });
    expect(row.opEpoch).toBeUndefined();
    expect(row.args?.p_idempotency_key).toBe(key);
    // a replacement never fences it automatically
    expect(await settleBeforeReplacement(["outbox-legacy"])).toBe("blocked");
    expect(fake.calls.filter((c) => c.name === "op_status_v87")).toHaveLength(0);
    // later drains do not resend it either
    await drainOutbox();
    expect(v87Calls()).toHaveLength(0);
  });

  it("a till that had not learnt of 087 yet: the legacy executor is refused (CLIENT_UPGRADE_REQUIRED) and the till learns 087", async () => {
    fake.enable087(false);
    await restart();
    await refreshRecoveryEpoch();                                           // pre-087 server: allowed without epoch
    online(false);
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    const [row] = await rows();
    expect(row.opEpoch).toBeNull();
    fake.enable087(true);                                                    // 087 installed meanwhile
    online(true);
    await drainOutbox();
    expect(recoveryView().capability).toBe("present");
    const [held] = await rows();
    expect(held).toMatchObject({ heldReason: OWNER_REVIEW });
    expect(fake.server.sales).toHaveLength(0);
  });
});

describe("journal evidence", () => {
  it("storage that cannot hold the journal record: nothing is saved or sent (fail closed)", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    const put = vi.spyOn(localDb.syncState, "put").mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    await expect(get().createSale(saleInput())).rejects.toThrow(/Not saved and nothing was sent/);
    put.mockRestore();
    expect(v87Calls()).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("duplicate acknowledgements keep the first evidence; a different second reply is a contradiction, never applied", async () => {
    const row = { localId: "x", kind: "rpc", name: "complete_sale", idempotencyKey: newIdempotencyKey(), args: {}, shopId: null, createdAt: new Date().toISOString(), status: "pending", attempts: 0 } as SyncOutboxEntry;
    await localDb.transaction("rw", localDb.syncState, () => journalCommitted(row, { source: "reply", response: { sale: { receiptNo: "R-1" } } }));
    await localDb.transaction("rw", localDb.syncState, () => journalCommitted(row, { source: "lookup", response: { sale: { receiptNo: "R-1" } } }));
    let rec = (await getJournalRecord(row.idempotencyKey!))!;
    expect(rec).toMatchObject({ state: "committed", acks: 2, evidence: { source: "reply" } });
    expect(rec.contradiction).toBeUndefined();
    await localDb.transaction("rw", localDb.syncState, () => journalCommitted(row, { source: "reply", response: { sale: { receiptNo: "R-9" } } }));
    rec = (await getJournalRecord(row.idempotencyKey!))!;
    expect(rec.evidence?.response).toEqual({ sale: { receiptNo: "R-1" } });
    expect(rec.contradiction).toMatch(/different reply/);
  });

  it("the printed receipt number is journaled (first print kept, reprints as events) and goes into the upload", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    const saleId = await get().createSale(saleInput());
    const { records } = await listJournal({ orgId: "org-1" });
    const key = records[0].key;
    await journalPrinted(key, "R-1");
    await journalPrinted(key, "R-1");
    const rec = (await getJournalRecord(key))!;
    expect(rec.printedReceiptNo).toBe("R-1");
    expect(rec.events.filter((e) => e.event === "reprinted")).toHaveLength(1);
    const up = uploadRecordOf(rec);
    expect(up).toMatchObject({ key, receipt_printed: "R-1", op_epoch: storedEpoch()!.epoch, legacy: false, state: "committed" });
    expect(up.reply).toBeTruthy();
    expect(saleId).toBeTruthy();
  });
});

describe("till reconciliation: journal upload, retry, conflict, quota, approval", () => {
  it("TILL_NOT_RECONCILED: the cashier's till uploads its whole journal; retries resend identical parts; an admin approves; the server issues the epoch", async () => {
    await normalTill();
    fake.server.inventory.set("shop-1:p1", 100);
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    online(false);
    simulatePreV87xClientForTests(true);                      // a queued, never-sent sale (left by the previous build)
    await get().createSale(saleInput());
    simulatePreV87xClientForTests(false);
    online(true);
    fake.hold87Org("org-1");                                  // recovery: new epoch, till unreconciled
    expect((await refreshRecoveryEpoch()).kind).toBe("refused");
    fake.release87Org("org-1");
    expect(await refreshRecoveryEpoch()).toMatchObject({ kind: "refused", code: "TILL_NOT_RECONCILED" });
    expect(recoveryView().mode).toBe("not-reconciled");
    // first upload attempt: the network fails on the request
    fake.queueModes("network-error");
    expect((await uploadTillJournal()).kind).toBe("unreachable");
    const plan1 = await currentUploadPlan();
    // retry: the same plan, identical bytes (the server answers stored / already_stored)
    expect(await uploadTillJournal()).toMatchObject({ kind: "stored", records: 2 });
    expect((await currentUploadPlan())!.planId).toBe(plan1!.planId);
    expect(await uploadTillJournal()).toMatchObject({ kind: "stored" });
    const submits = fake.callsFor("recovery_submit_journal");
    expect(submits.at(-1)!.args.p_chunk).toEqual(submits.at(-2)!.args.p_chunk);
    // every key in the journal is quarantined on the server
    for (const r of (await listJournal({ orgId: "org-1" })).records) expect(fake.r87.quarantine.has(`org-1|${r.key}`)).toBe(true);
    // the administrator (MFA) approves; the cashier's next check gets the epoch
    fake.setCaller("admin-1", true, "org-1", true);
    acting = { currentUserId: "admin-1", currentOrgId: "org-1", currentRole: "ADMIN" };
    await approveTill(recoveryView().tillId);
    fake.setCaller("user-1", false, "org-1");
    acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" };
    expect(await runRecoveryCheck()).toMatchObject({ mode: "normal", allowed: true });
    // the queued sale is old (created before the incident): it waits for an owner, never executes
    await drainOutbox();
    expect((await rows())[0]).toMatchObject({ heldReason: OWNER_REVIEW });
  });

  it("conflict: the server holds different content for a part; nothing is overwritten", async () => {
    await normalTill();
    fake.hold87Org("org-1"); fake.release87Org("org-1");
    await refreshRecoveryEpoch();
    const tillId = recoveryView().tillId;
    fake.r87.journal.set(`org-1|${tillId}|1|1`, { payload: "something else", final: false, submittedBy: "user-2", bytes: 10 });
    expect(await uploadTillJournal()).toMatchObject({ kind: "conflict", chunk: 1 });
  });

  it("server journal quota exhausted: refused, nothing deleted on the till or the server", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    fake.hold87Org("org-1"); fake.release87Org("org-1");
    await refreshRecoveryEpoch();
    fake.set087Server({ quotaBytes: 10 });
    expect(await uploadTillJournal()).toMatchObject({ kind: "quota-exceeded", chunk: 1 });
    expect((await listJournal({ orgId: "org-1" })).records).toHaveLength(1);
    expect(recoveryView().mode).toBe("not-reconciled");
  });

  it("an administrator's session never uploads (087 forbids approving one's own upload)", async () => {
    await normalTill();
    fake.hold87Org("org-1"); fake.release87Org("org-1");
    await refreshRecoveryEpoch();
    acting = { currentUserId: "admin-1", currentOrgId: "org-1", currentRole: "ADMIN" };
    expect(await uploadTillJournal()).toMatchObject({ kind: "refused", code: "ADMIN_SESSION" });
    expect(fake.callsFor("recovery_submit_journal")).toHaveLength(0);
  });

  it("registering a till needs an MFA (aal2) administrator; the secret is stored once", async () => {
    acting = { currentUserId: "admin-1", currentOrgId: "org-1", currentRole: "ADMIN" };
    fake.setCaller("admin-1", true, "org-1", false);
    await expect(registerThisTill()).rejects.toThrow(/authenticator app/);
    fake.setCaller("admin-1", true, "org-1", true);
    const { tillId } = await registerThisTill();
    expect(tillId).toBe(recoveryView().tillId);
    expect(recoveryView()).toMatchObject({ tillRegistered: true, mode: "not-reconciled" });
    await expect(registerThisTill()).rejects.toThrow(/already registered/);
  });

  it("chunks stay under the server limit and never drop a record's key", () => {
    const big = Array.from({ length: 300 }, (_, i) => ({ key: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, args: { pad: "x".repeat(2000) } }));
    const chunks = chunkRecords("plan", "till", "org-1", big) as { records: { key: string }[] }[];
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThan(200_000);
    expect(chunks.flatMap((c) => c.records.map((r) => r.key))).toEqual(big.map((b) => b.key));
  });
});

describe("multiple organisations and tills on one device", () => {
  it("a hold in one organisation never blocks another; each keeps its own epoch and till credential", async () => {
    await normalTill();
    fake.hold87Org("org-1");
    await refreshRecoveryEpoch();
    // (087 answers TILL_NOT_RECONCILED first: the hold advanced the epoch past the till's reconciliation)
    expect(recoveryView()).toMatchObject({ mode: "not-reconciled", allowed: false });
    // another organisation signs in on the same till
    acting = { currentUserId: "user-2", currentOrgId: "org-2", currentRole: "CASHIER" };
    fake.setCaller("user-2", false, "org-2");
    await restart();
    expect(recoveryView().mode).toBe("till-unregistered");                  // org-1's credential is not org-2's
    const secret2 = fake.register87Till(recoveryView().tillId, { org: "org-2", reconciled: true });
    await storeTillCredential({ orgId: "org-2", secret: secret2 });
    expect((await refreshRecoveryEpoch()).kind).toBe("issued");
    expect(recoveryView()).toMatchObject({ mode: "normal", allowed: true });
    expect(storedEpoch()!.orgId).toBe("org-2");
    // back to org-1: still held
    acting = { currentUserId: "user-1", currentOrgId: "org-1", currentRole: "CASHIER" };
    fake.setCaller("user-1", false, "org-1");
    await restart();
    expect(recoveryView()).toMatchObject({ mode: "not-reconciled", allowed: false });
  });

  it("a credential stored for another till id is never used (two tills sharing a profile copy)", async () => {
    await normalTill();
    const store = new Map<string, string>([["pos-till-id", "till-bbbbbb"]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    await restart();
    expect(recoveryView()).toMatchObject({ tillId: "till-bbbbbb", tillRegistered: false, mode: "till-unregistered" });
  });
});

describe("no automatic fencing, replay or replacement during recovery", () => {
  it("a replacement of an in-doubt sale is blocked while held (no op_status_v87 fence)", async () => {
    await normalTill();
    const op = beginOperation();
    simulatePreV87xClientForTests(true);                      // an in-doubt row as the previous build queued it
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: saleInputArgs(), idempotencyKey: op.idempotencyKey, shopId: "shop-1", opEpoch: op.opEpoch });
    simulatePreV87xClientForTests(false);
    const [row] = await rows();
    await localDb.syncOutbox.update(row.localId, { inDoubt: true });
    fake.hold87Org("org-1");
    await refreshRecoveryEpoch();
    expect(await settleBeforeReplacement([row.localId])).toBe("blocked");
    expect(fake.calls.filter((c) => c.name === "op_status_v87")).toHaveLength(0);
  });

  it("an online-only payment refused by the hold stays unresolved with its key and epoch (never fenced)", async () => {
    await normalTill();
    fake.hold87Org("org-1");
    const out = await callOnlineOnly("record_supplier_payment", { p_purchase_order_id: "po-1", p_amount_mmk: 100 });
    expect(out.error?.failure.klass).toBe("RECOVERY");
    expect(fake.calls.filter((c) => c.name === "op_status_v87" || c.name === "op_status")).toHaveLength(0);
    // and while held a new one is refused before anything is saved
    await expect(callOnlineOnly("record_supplier_payment", { p_purchase_order_id: "po-2", p_amount_mmk: 100 })).rejects.toSatisfy(isRecoveryBlocked);
  });
});

describe("x-orvix-epoch on PostgREST writes", () => {
  it("added from the current epoch to /rest/v1 writes; an explicit (queued) value is never overridden; reads untouched", async () => {
    const seen: (Headers | Record<string, string> | undefined)[] = [];
    const inner = (async (_i: RequestInfo | URL, init?: RequestInit) => { seen.push(init?.headers as Record<string, string>); return new Response("[]"); }) as typeof fetch;
    setEpochHeaderProvider(() => "epoch-now");
    const f = epochHeaderFetch(inner);
    await f("http://127.0.0.1:54321/rest/v1/categories", { method: "POST", headers: { apikey: "k" } });
    await f("http://127.0.0.1:54321/rest/v1/categories", { method: "PATCH", headers: { apikey: "k", [EPOCH_HEADER]: "epoch-created" } });
    await f("http://127.0.0.1:54321/rest/v1/categories", { method: "GET", headers: { apikey: "k" } });
    expect((seen[0] as Record<string, string>)[EPOCH_HEADER]).toBe("epoch-now");
    expect((seen[1] as Record<string, string>)[EPOCH_HEADER]).toBe("epoch-created");
    expect((seen[2] as Record<string, string>)[EPOCH_HEADER]).toBeUndefined();
  });
});

function saleInputArgs(): Record<string, unknown> {
  return { p_shop_id: "shop-1", p_shift_id: "shift-1", p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0, p_items: [{ product_id: "p1", qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString() };
}

// ---- independent-review findings (each pinned by a test) --------------------------------------------------------
describe("review findings", () => {
  it("[DR C1] a server witness BEHIND the till's (restore inside the tail) never returns the till to normal; its witness is kept", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    const mine = storedEpoch()!.witness!;
    expect(mine.n).toBe(1);
    fake.r87.orgs.get("org-1")!.chain.length = 0;                          // restored: the server lost that sale
    const r = await refreshRecoveryEpoch();                                 // (the server itself sees nothing wrong)
    expect(r).toMatchObject({ kind: "refused", code: "WITNESS_BEHIND" });
    expect(recoveryView()).toMatchObject({ mode: "uncertain", code: "WITNESS_BEHIND", allowed: false });
    expect(storedEpoch()!.witness).toEqual(mine);
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    await restart();
    expect(recoveryView()).toMatchObject({ mode: "uncertain", code: "WITNESS_BEHIND" });
    expect(fake.server.sales).toHaveLength(1);
  });

  it("[security H2 / DR C2] a second incident builds a NEW upload plan with the operations since the first one", async () => {
    await normalTill();
    fake.server.inventory.set("shop-1:p1", 100);
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    fake.hold87Org("org-1"); fake.release87Org("org-1");
    await refreshRecoveryEpoch();
    expect(await uploadTillJournal()).toMatchObject({ kind: "stored", records: 1 });
    const first = (await currentUploadPlan())!.planId;
    fake.reconcile87Till(recoveryView().tillId);
    expect((await refreshRecoveryEpoch()).kind).toBe("issued");
    expect((await currentUploadPlan())!.completedAt).toBeTruthy();         // closed by the issued epoch
    await get().createSale(saleInput());                                     // after the first incident
    fake.hold87Org("org-1"); fake.release87Org("org-1");
    await refreshRecoveryEpoch();
    const up = await uploadTillJournal();
    expect(up).toMatchObject({ kind: "stored", records: 2 });
    expect((await currentUploadPlan())!.planId).not.toBe(first);
  });

  it("[DR H1] committed sales far older than the last witness are uploaded (within the restore horizon)", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    const [rec] = (await listJournal({ orgId: "org-1" })).records;
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    await localDb.syncState.put({ key: `opj:${rec.key}`, value: JSON.stringify({ ...rec, createdAt: old, updatedAt: old }), updatedAt: old });
    fake.hold87Org("org-1"); fake.release87Org("org-1");
    await refreshRecoveryEpoch();
    expect(await uploadTillJournal()).toMatchObject({ kind: "stored", records: 1 });
    expect(fake.r87.quarantine.has(`org-1|${rec.key}`)).toBe(true);
    const chunk = fake.callsFor("recovery_submit_journal")[0].args.p_chunk as Record<string, unknown>;
    expect(chunk).toMatchObject({ till_witness: { org: "org-1" }, epoch_no: 0, horizon_days: 200 });
  });

  it("[security H1] a till registered under a suffix keeps its credential across a restart", async () => {
    const tillId = recoveryView().tillId;
    fake.register87Till(tillId, { reconciled: false });                     // the base id is taken (a lost reply)
    acting = { currentUserId: "admin-1", currentOrgId: "org-1", currentRole: "ADMIN" };
    fake.setCaller("admin-1", true, "org-1", true);
    const { tillId: registered } = await registerThisTill();
    expect(registered).toBe(`${tillId}.r2`);
    await restart();
    expect(recoveryView()).toMatchObject({ tillRegistered: true, serverTillId: `${tillId}.r2` });
  });

  it("[DR H2] a till the server no longer knows (TILL_UNKNOWN, e.g. 087 re-applied) can be registered again by an MFA admin", async () => {
    await normalTill();
    fake.r87.tills.clear();                                                  // the server's registration is gone
    await refreshRecoveryEpoch();
    expect(recoveryView()).toMatchObject({ mode: "till-unregistered", code: "TILL_UNKNOWN", tillRegistered: true });
    acting = { currentUserId: "admin-1", currentOrgId: "org-1", currentRole: "ADMIN" };
    fake.setCaller("admin-1", true, "org-1", true);
    await expect(registerThisTill()).rejects.toThrow(/already registered/);
    await registerThisTill({ replaceUnknown: true });
    expect(recoveryView()).toMatchObject({ tillRegistered: true, mode: "not-reconciled" });
    expect((await localDb.syncState.where("key").startsWith("r87:till-archived:").count())).toBe(1);   // the old one kept
  });

  it("[security M1] a session of another organisation never uses the loaded organisation's credential or epoch", async () => {
    await normalTill();
    acting = { currentUserId: "user-2", currentOrgId: "org-2", currentRole: "CASHIER" };   // no reload yet
    expect(recoveryView()).toMatchObject({ orgId: "org-2", tillRegistered: false, allowed: false });
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    expect(v87Calls()).toHaveLength(0);
  });

  it("[offline-sync H1] the maintenance listener (API_GUARD) on a server never seen with 087 stores no recovery state", async () => {
    fake.enable087(false);
    await restart();
    await refreshRecoveryEpoch();
    fake.queueReply({ data: null, status: 429, error: { code: "PT429", message: "ORG_SUSPENDED: server recovery in progress [API_GUARD]", details: null, hint: null } });
    online(false);
    const { get } = makeSaleStore();
    await get().createSale(saleInput());                                     // offline: ordinary staging
    online(true);
    await drainOutbox();
    expect(recoveryView().mode).toBe("legacy-server");
    await restart();
    expect(recoveryView()).toMatchObject({ mode: "legacy-server", allowed: true });
  });

  it("[offline-sync H1] after the owner confirms a rollback of 087 (server confirms, twice) the till works as before 087", async () => {
    await normalTill();
    fake.hold87Org("org-1");
    await refreshRecoveryEpoch();
    fake.enable087(false);                                                    // 087 rolled back on the server
    acting = { currentUserId: "admin-1", currentOrgId: "org-1", currentRole: "ADMIN" };
    const { ownerConfirmRollback } = await import("./recovery87");
    await expect(ownerConfirmRollback("short")).rejects.toThrow(/15 characters/);
    await ownerConfirmRollback("087 rolled back by the owner on 2026-10-19 after the test window");
    expect(recoveryView()).toMatchObject({ mode: "legacy-server", allowed: true, capability: "absent" });
    expect(await localDb.syncState.where("key").startsWith("r87:archived:").count()).toBeGreaterThan(0);
  });

  it("[offline-sync M3] a hold another window persisted is honoured by this window's next sale (state re-read from disk)", async () => {
    await normalTill();
    const origin = "http://127.0.0.1:54321";
    const at = new Date().toISOString();
    await localDb.syncState.put({ key: `r87:mode:${origin}:org-1`, value: JSON.stringify({ mode: "hold", code: "RECOVERY_HOLD", detail: null, since: at, updatedAt: at }), updatedAt: at });
    online(false);
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    expect(await rows()).toHaveLength(0);
  });

  it("[financial H1] an earlier entry waiting for owner review: a new sale is refused at the counter (never staged behind it)", async () => {
    await normalTill();
    await localDb.syncOutbox.put({
      localId: "outbox-review", kind: "table_write", name: "categories.update", table: "categories", op: "update", row: { name: "x" }, id: "cat-1",
      shopId: null, createdAt: new Date().toISOString(), status: "pending", attempts: 1, backendOrigin: "http://127.0.0.1:54321",
      orgId: "org-1", opEpoch: "epoch-org-1-old", heldReason: OWNER_REVIEW,
    } as SyncOutboxEntry);
    const { get } = makeSaleStore();
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(String(err.message)).toMatch(/awaiting owner review/);
    expect(await rows()).toHaveLength(1);
    expect(v87Calls()).toHaveLength(0);
  });

  it("[financial M3] a pre-Phase-D legacy entry without a key is held, never re-keyed, on an 087 server", async () => {
    await normalTill();
    await localDb.syncOutbox.put({
      localId: "outbox-nokey", kind: "rpc", name: "complete_sale", args: saleInputArgs(), shopId: "shop-1", createdAt: new Date().toISOString(),
      status: "pending", attempts: 0, backendOrigin: "http://127.0.0.1:54321", staged: true,
    } as SyncOutboxEntry);
    await drainOutbox();
    const [row] = await rows();
    expect(row).toMatchObject({ heldReason: OWNER_REVIEW });
    expect(row.idempotencyKey).toBeUndefined();
    expect(row.args?.p_idempotency_key).toBeUndefined();
  });

  it("[financial M1] after a restart a reprint still finds the sale's journal record (by the server's reply) and records the number first", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    const saleId = await get().createSale(saleInput());
    const sale = get().sales.find((s: { id: string }) => s.id === saleId);
    const { journalReceiptPrint, getJournalRecord: rec, forgetSaleOperationsForTests } = await import("./opJournal");
    forgetSaleOperationsForTests();                                          // a restarted process: no in-memory map
    // (no key on the sale object either: found only through the server's recorded reply)
    expect(await journalReceiptPrint({ id: sale.id, receiptNo: sale.receiptNo })).toBe("journaled");
    const key = (await listJournal({ orgId: "org-1" })).records[0].key;
    expect((await rec(key))!.printedReceiptNo).toBe(sale.receiptNo);
    expect(await journalReceiptPrint({ id: "sale-of-another-till", receiptNo: "X-1" })).toBe("not-this-till");
  });
});

describe("re-verification findings", () => {
  it("[N1] WITNESS_BEHIND is sticky: the restored server moving past the till's position (other tills) does not clear it; only the owner does", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    await get().createSale(saleInput());
    const mine = storedEpoch()!.witness!;                                     // n=2
    fake.r87.orgs.get("org-1")!.chain.length = 1;                             // restored to n=1
    await refreshRecoveryEpoch();
    expect(recoveryView().code).toBe("WITNESS_BEHIND");
    const c = fake.r87.orgs.get("org-1")!.chain;
    c.push("h-other-till-2", "h-other-till-3");                               // other tills sell on the restored server: n=3, forked
    await refreshRecoveryEpoch();
    expect(recoveryView()).toMatchObject({ code: "WITNESS_BEHIND", allowed: false });
    expect(storedEpoch()!.witness).toEqual(mine);
    acting = { currentUserId: "admin-1", currentOrgId: "org-1", currentRole: "ADMIN" };
    const { ownerClearWitnessBehind } = await import("./recovery87");
    await expect(ownerClearWitnessBehind("short")).rejects.toThrow(/15 characters/);
    expect((await ownerClearWitnessBehind("checked the backups with the owner on 2026-10-19")).kind).toBe("issued");
    expect(recoveryView()).toMatchObject({ mode: "normal", allowed: true });
    expect(await localDb.syncState.where("key").startsWith("r87:witness-archived:").count()).toBe(1);
  });

  it("[N1] a server AHEAD in the same epoch: the till keeps its witness; its next operation lets the SERVER detect a fork", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    const mine = storedEpoch()!.witness!;                                     // n=1, h = this sale
    const c = fake.r87.orgs.get("org-1")!.chain;
    c.length = 0; c.push("h-forked-1", "h-forked-2");                         // restored, then other sales: n=2, different history
    expect((await refreshRecoveryEpoch()).kind).toBe("issued");
    expect(storedEpoch()!.witness).toEqual(mine);                              // not overwritten by the server's
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(String(err.message)).toMatch(/CONTINUITY_ROLLBACK/);                // the server committed the hold
    expect(fake.r87.orgs.get("org-1")!.held).toBe(true);
  });

  it("[N3] an epoch answered for one organisation is never stored for another signed in meanwhile", async () => {
    await normalTill();
    const p = refreshRecoveryEpoch();
    acting = { currentUserId: "user-2", currentOrgId: "org-2", currentRole: "CASHIER" };
    const r = await p;
    expect(["error", "issued"]).toContain(r.kind);
    await loadRecoveryState("org-2");
    expect(recoveryView()).toMatchObject({ orgId: "org-2", allowed: false, epochNo: null });
  });
});

describe("re-verification 2 findings", () => {
  it("[R1] a server answer that only LOOKS behind (another window's sale committed after the snapshot) is re-asked, not declared", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    // the stored witness moves ahead behind this window's back (another window's sale), the server is consistent
    const e = storedEpoch()!;
    const origin = "http://127.0.0.1:54321";
    const ahead = { ...fake.witness87("org-1") };
    await localDb.syncState.put({ key: `r87:epoch:${origin}:org-1:${e.tillId}`, value: JSON.stringify({ ...e, witness: ahead }), updatedAt: new Date().toISOString() });
    // the first answer is an older snapshot (n=0), the second one is current
    fake.queueReply({ data: { epoch: e.epoch, epoch_no: 0, witness: { org: "org-1", epoch_no: 0, n: 0, h: "00".repeat(32), mac: "fake-mac:org-1:0:0:" + "00".repeat(32) } }, error: null, status: 200 });
    expect((await refreshRecoveryEpoch()).kind).toBe("issued");
    expect(recoveryView()).toMatchObject({ mode: "normal", allowed: true });
  });

  it("[R2] a later refusal never overwrites WITNESS_BEHIND (only the owner clears it)", async () => {
    await normalTill();
    const { get } = makeSaleStore();
    await get().createSale(saleInput());
    fake.r87.orgs.get("org-1")!.chain.length = 0;
    await refreshRecoveryEpoch();
    expect(recoveryView().code).toBe("WITNESS_BEHIND");
    fake.set087Server({ lease: false });
    await refreshRecoveryEpoch().catch(() => undefined);
    fake.set087Server({ lease: true });
    await restart();
    expect(recoveryView()).toMatchObject({ code: "WITNESS_BEHIND", allowed: false });
  });
});

// ---- final safety gate: recovery-mode persistence failures -------------------------------------------------
describe("recovery state that could not be persisted", () => {
  const ls = () => {
    const store = new Map<string, string>([["pos-till-id", "till-aaaaaa"]]);
    return { store, api: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } };
  };
  const failModeWrites = () => {
    const real = localDb.syncState.put.bind(localDb.syncState);
    return vi.spyOn(localDb.syncState, "put").mockImplementation(((row: { key: string }) => {
      if (row.key.startsWith("r87:mode:")) throw new DOMException("disk full", "QuotaExceededError");
      return real(row as never);
    }) as never);
  };

  it("an IndexedDB write failure while entering a hold: the block survives a restart (backup record), online and offline", async () => {
    const { store, api } = ls();
    vi.stubGlobal("localStorage", api);
    await restart();
    await normalTill();
    const spy = failModeWrites();
    fake.hold87Org("org-1");
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    spy.mockRestore();
    // on disk (IndexedDB) the till still looks "normal"
    expect(JSON.parse((await localDb.syncState.get("r87:mode:http://127.0.0.1:54321:org-1"))!.value!).mode).toBe("normal");
    expect([...store.keys()].some((k) => k.startsWith("r87:block:"))).toBe(true);
    await restart();
    expect(recoveryView()).toMatchObject({ allowed: false });
    online(false);
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    online(true);
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    expect(await rows()).toHaveLength(0);
    // only fresh, valid server authorization lifts it
    fake.release87Org("org-1"); fake.reconcile87Till(recoveryView().tillId);
    expect((await refreshRecoveryEpoch()).kind).toBe("issued");
    expect([...store.keys()].some((k) => k.startsWith("r87:block:"))).toBe(false);
    await restart();
    expect(recoveryView().allowed).toBe(true);
  });

  it("BOTH stores failed (state lost): after an ONLINE restart nothing is sold before the server authorises the till again", async () => {
    await normalTill();
    const spy = failModeWrites();
    fake.hold87Org("org-1");
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    spy.mockRestore();
    await restart();                                                         // persisted state says "normal"
    const before = v87Calls().length;
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    expect(v87Calls()).toHaveLength(before);                                 // asked the server first, sent nothing
    expect(recoveryView().allowed).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  it("v87.x: BOTH stores failed and the till restarts OFFLINE: a new sale is REFUSED (the gap of v87 is closed) — nothing queued", async () => {
    await normalTill();
    const spy = failModeWrites();
    fake.hold87Org("org-1");
    const { get } = makeSaleStore();
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    spy.mockRestore();
    online(false);
    await restart();
    expect(recoveryView().mode).toBe("normal");                              // the hold was never persisted: the old epoch looks valid
    const err = await get().createSale(saleInput()).catch((e) => e);
    expect(isRecoveryBlocked(err)).toBe(true);
    expect(err.code).toBe(OFFLINE_FINANCIAL_DISABLED);                        // ... but offline nothing is created on an 087 server
    expect(await rows()).toHaveLength(0);
    expect(await localDb.sales.count()).toBe(0);
    online(true);
    const sent = v87Calls().length;
    await drainOutbox();
    expect(v87Calls()).toHaveLength(sent);
    expect(fake.server.sales).toHaveLength(0);
    // online: the server is asked first and refuses (the hold) — still nothing saved
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
    expect(await rows()).toHaveLength(0);
  });

  it("pending operations and a stale epoch after an online restart: nothing is sent until the server authorises the till", async () => {
    await normalTill();
    online(false);
    const { get } = makeSaleStore();
    simulatePreV87xClientForTests(true);                      // queued by the previous build
    await get().createSale(saleInput());
    simulatePreV87xClientForTests(false);
    online(true);
    fake.hold87Org("org-1"); fake.release87Org("org-1");                     // a recovery happened while the till was away
    await restart();
    const sent = v87Calls().length;
    await drainOutbox();
    expect(v87Calls()).toHaveLength(sent);
    expect(recoveryView()).toMatchObject({ allowed: false, mode: "not-reconciled" });
    await expect(get().createSale(saleInput())).rejects.toSatisfy(isRecoveryBlocked);
  });
});
