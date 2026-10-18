import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Migration 086 — deployment-blocker correction batch (after 9d37787):
//   1. a STALE SCHEMA CACHE ("function not found" from a backend that has
//      already answered 086) never counts as "this server has no 086":
//      no manual close, no direct-path fallback, no replacement;
//   5. a CLIENT-decided "not applied" is never final on an 086 server: the key
//      is fenced there (or the server's decision taken), otherwise held;
//      held as well when whether the server has 086 is unknown.
// Each test checks the stored record and the server's executions / ledger.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let actingRole = "CASHIER";
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: "user-1", currentOrgId: "org-1", currentRole: actingRole }) } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb, SYNC_STATE_KEYS } from "../../lib/localDb";
import { simulateNewAppInstanceForTests } from "./outbox";
import { executorDemonstrated, setExecutorCapabilityForTests } from "./idempotentRpc";
import { registerVerifiedReload } from "./verifiedReload";
import {
  callOnlineOnly, checkOnlineOperation, listUnresolvedOnlineOperations, markOnlineOperationVerified, resetOnlineOnlyForTests, retryOnlineOperation,
} from "./onlineOnly";
import { registerOperationPrompt } from "./operationPrompt";

const payArgs = { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
const NO_UPSTREAM = { data: null, status: 503, error: { message: "no healthy upstream", code: "", details: "", hint: "" } };
const STALE = (fn: string) => ({ data: null, status: 404, error: { message: `Could not find the function public.${fn} in the schema cache`, code: "PGRST202", details: null, hint: null } });
const stored = async (id: string) => JSON.parse((await localDb.syncState.get(`online-op:${id}`))!.value!);
const executions = () => fake.server.executions.pay_supplier_lump_sum ?? 0;
const directCalls = () => fake.callsFor("pay_supplier_lump_sum").length;
const asOwner = async <T>(fn: () => Promise<T>) => { actingRole = "ADMIN"; try { return await fn(); } finally { actingRole = "CASHIER"; } };

beforeEach(async () => {
  fake.reset();
  actingRole = "CASHIER";
  fake.setCaller("user-1");
  setExecutorCapabilityForTests("available");
  fake.enableExecutor();
  simulateNewAppInstanceForTests();
  resetOnlineOnlyForTests();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  registerVerifiedReload(null);
  registerOperationPrompt(async () => "new");
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

/** A payment whose reply was lost (it committed), on a backend that has
 *  answered 086 before (an earlier payment went through). */
async function lostReplyPayment() {
  await callOnlineOnly("pay_supplier_lump_sum", { ...payArgs, p_amount_mmk: 1 }, { retries: 0 });
  fake.queueModes("commit-then-timeout", "network-error", "network-error");
  await callOnlineOnly("pay_supplier_lump_sum", payArgs);
  const [op] = await listUnresolvedOnlineOperations();
  expect(op).toBeTruthy();
  return op;
}

describe("1. stale schema cache: fail CLOSED once the backend has shown 086", () => {
  it("the backend's 086 support is recorded DURABLY (survives a restart)", async () => {
    await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    await vi.waitFor(async () => expect(await localDb.syncState.where("key").startsWith(SYNC_STATE_KEYS.executorDemonstrated).count()).toBe(1));
    setExecutorCapabilityForTests("available");                       // a new app instance: in-memory knowledge gone
    expect(await executorDemonstrated()).toBe(true);
  });

  it("owner 'Mark verified' with op_status reported missing: REFUSED (no manual close); the payment stays unresolved with its key", async () => {
    const op = await lostReplyPayment();
    fake.enableExecutor(false);                                       // stale cache: op_execute / op_status "not found"
    await expect(asOwner(() => markOnlineOperationVerified(op.id))).rejects.toThrow(/could not be confirmed or stopped/);
    expect(await stored(op.id)).toMatchObject({ status: "unresolved", args: { p_idempotency_key: op.args.p_idempotency_key }, backendOrigin: op.backendOrigin });
  });

  it("the same payment entered again ('new') with op_status reported missing: BLOCKED — no second payment under a new key", async () => {
    const op = await lostReplyPayment();
    expect(executions()).toBe(2);                                     // the earlier payment + this one
    fake.enableExecutor(false);
    await expect(callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 })).rejects.toThrow(/could not be confirmed or stopped/);
    expect(executions()).toBe(2);
    expect(directCalls()).toBe(0);                                    // never the direct (085) path
    expect((await listUnresolvedOnlineOperations()).map((o) => o.id)).toEqual([op.id]);
  });

  it("op_execute reported missing on a Retry: never sent on the direct path; held as 'waiting for the server' (nothing decided)", async () => {
    const op = await lostReplyPayment();
    fake.enableExecutor(false);
    const r = await retryOnlineOperation(op.id);
    expect(r.error?.name).toBe("PendingConfirmationError");
    expect(directCalls()).toBe(0);
    expect(executions()).toBe(2);
    expect(await stored(op.id)).toMatchObject({ status: "unresolved" });
  });

  it("Check with op_status reported missing: an error, nothing settled", async () => {
    const op = await lostReplyPayment();
    fake.enableExecutor(false);
    const r = await checkOnlineOperation(op.id);
    expect(r.error?.code).toBe("OP_SCHEMA_UNAVAILABLE");
    expect(r.absent).toBe(false);
    expect(await stored(op.id)).toMatchObject({ status: "unresolved" });
  });

  it("ONE stale reply (a single op_status 'not found' while everything else works): Mark verified refused, nothing decided", async () => {
    const op = await lostReplyPayment();
    fake.queueReply(STALE("op_status"));
    await expect(asOwner(() => markOnlineOperationVerified(op.id))).rejects.toThrow(/could not be confirmed or stopped/);
    expect(await stored(op.id)).toMatchObject({ status: "unresolved" });
  });

  it("the durable record alone (after a restart) keeps it closed", async () => {
    const op = await lostReplyPayment();
    setExecutorCapabilityForTests("available");                       // restart: only IndexedDB remembers
    fake.enableExecutor(false);
    await expect(asOwner(() => markOnlineOperationVerified(op.id))).rejects.toThrow(/could not be confirmed or stopped/);
    expect(await stored(op.id)).toMatchObject({ status: "unresolved" });
  });

  it("the record cannot be read (IndexedDB error): treated as 'has 086' — closed", async () => {
    const op = await lostReplyPayment();
    setExecutorCapabilityForTests("available");
    fake.enableExecutor(false);
    const spy = vi.spyOn(localDb.syncState, "get").mockImplementation(((key: string) =>
      key.startsWith(SYNC_STATE_KEYS.executorDemonstrated) ? Promise.reject(new Error("IDB read failed")) : Promise.resolve(undefined)) as never);
    try {
      expect(await executorDemonstrated()).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(await stored(op.id)).toMatchObject({ status: "unresolved" });
  });

  it("a backend that has NEVER answered 086 (an 085 server): 'not found' still means no 086 — the owner's manual close remains possible", async () => {
    setExecutorCapabilityForTests("absent");
    fake.enableExecutor(false);
    await localDb.syncState.put({ key: "online-op:op-085", updatedAt: "x", value: JSON.stringify({
      v: 2, id: "op-085", name: "pay_supplier_lump_sum", orgId: "org-1", userId: "user-1", fingerprint: "f", scope: "s",
      args: { ...payArgs, p_idempotency_key: "0190a000-0000-7000-8000-0000000000aa" }, status: "unresolved",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, backendOrigin: (await import("../../lib/backendOrigin")).currentBackendOrigin(),
    }) });
    await asOwner(() => markOnlineOperationVerified("op-085"));
    expect(await stored("op-085")).toMatchObject({ status: "settled", outcome: "verified-manually", decidedBy: "owner" });
  });
});

describe("5. a client-decided 'not applied' is never final on an 086 server", () => {
  it("first attempt 'not delivered' (503) on an 086 server: the key is FENCED there — abandoned by the server; a late copy can never run", async () => {
    await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });   // the backend answers 086 once
    fake.queueReply(NO_UPSTREAM);
    const r = await callOnlineOnly("pay_supplier_lump_sum", { ...payArgs, p_amount_mmk: 2000 }, { retries: 0 });
    expect(r.error).toBeTruthy();
    const all = (await localDb.syncState.where("key").startsWith("online-op:").toArray()).map((x) => JSON.parse(x.value!));
    const second = all.find((o) => o.args.p_amount_mmk === 2000);
    expect(second).toMatchObject({ status: "settled", outcome: "abandoned", decidedBy: "server" });
    expect(fake.server.idempotency.get(second.args.p_idempotency_key)).toMatchObject({ state: "abandoned" });
    const { p_idempotency_key: key, ...rest } = second.args;
    await fake.rpc("op_execute", { p_key: key, p_rpc: "pay_supplier_lump_sum", p_args: rest, p_actor_id: "user-1" });
    expect(executions()).toBe(1);                                     // the late copy did not run
  });

  it("…and when the fence cannot be made (the lookup fails): HELD, unresolved — a replacement is not allowed through", async () => {
    await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    fake.queueReply(NO_UPSTREAM, NO_UPSTREAM);                        // the attempt, then its fence lookup
    const r = await callOnlineOnly("pay_supplier_lump_sum", { ...payArgs, p_amount_mmk: 3000 }, { retries: 0 });
    expect(r.error?.name).toBe("PendingConfirmationError");
    const [op] = (await listUnresolvedOnlineOperations()).filter((o) => o.args.p_amount_mmk === 3000);
    expect(op).toMatchObject({ status: "unresolved" });
  });

  it("whether the server has 086 is UNKNOWN (never answered, not known absent): a 'not delivered' is HELD", async () => {
    setExecutorCapabilityForTests("unknown");
    fake.queueReply(NO_UPSTREAM, NO_UPSTREAM);
    const r = await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    expect(r.error?.name).toBe("PendingConfirmationError");
    expect(await listUnresolvedOnlineOperations()).toHaveLength(1);
  });

  it("a server KNOWN to lack 086 (never answered it): the first attempt's own 'not delivered' still settles it (no fence exists there)", async () => {
    setExecutorCapabilityForTests("absent");
    fake.enableExecutor(false);
    fake.queueReply(NO_UPSTREAM);
    await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    const all = (await localDb.syncState.where("key").startsWith("online-op:").toArray()).map((x) => JSON.parse(x.value!));
    expect(all[0]).toMatchObject({ status: "settled", outcome: "not-applied", decidedBy: "client" });
  });
});
