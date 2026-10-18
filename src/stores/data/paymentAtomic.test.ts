import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Migration 086 — post-checkpoint financial safety (d0390a1). Deterministic
// reproductions (replies are held and released by the test; no sleeps) of the
// snapshot-6 review findings on online money operations:
//   M1  a stale in-memory "settled" note hides a reopened, unresolved payment
//       -> a replacement gets a NEW key while the Retry may commit (duplicate);
//   L   a stale copy saved before sending overwrites an owner's decision;
//   L   a read error fails open; a key mismatch on a new payment is "refused".
// Each test checks the server's executions / ledger and the STORED record.
// ---------------------------------------------------------------------------

vi.mock("../../lib/supabase", async () => {
  const { fakeSupabase } = await import("./testing/fakeSupabase");
  return { supabase: fakeSupabase };
});
let actingUser = "user-1";
let actingRole = "CASHIER";
let actingOrg = "org-1";
vi.mock("../authStore", async () => {
  const actual = await vi.importActual<typeof import("../authStore")>("../authStore");
  return { ...actual, useAuthStore: { getState: () => ({ currentUserId: actingUser, currentOrgId: actingOrg, currentRole: actingRole }) } };
});

import { fakeSupabase as fake } from "./testing/fakeSupabase";
import { localDb } from "../../lib/localDb";
import { simulateNewAppInstanceForTests } from "./outbox";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { registerVerifiedReload } from "./verifiedReload";
import {
  callOnlineOnly, listUnresolvedOnlineOperations, markOnlineOperationVerified, resetOnlineOnlyForTests, retryOnlineOperation,
} from "./onlineOnly";
import { registerOperationPrompt } from "./operationPrompt";

const payArgs = { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
const NO_UPSTREAM = { data: null, status: 503, error: { message: "no healthy upstream", code: "", details: "", hint: "" } };
const NOT_FOUND = { data: { status: "not_found" }, status: 200, error: null };
function held<T = unknown>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((r) => { release = r; });
  return { promise: promise as unknown as Record<string, unknown>, release };
}
const stored = async (id: string) => JSON.parse((await localDb.syncState.get(`online-op:${id}`))!.value!);
const executions = () => fake.server.executions.pay_supplier_lump_sum ?? 0;

beforeEach(async () => {
  fake.reset();
  actingUser = "user-1";
  actingRole = "CASHIER";
  actingOrg = "org-1";
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

describe("M1: a stale in-memory 'settled' note never hides an unresolved payment", () => {
  it("A proves 'not delivered' DURING the Retry's lookup; the Retry then sends B (may commit); a replacement payment is NOT sent under a new key -> at most ONE payment", async () => {
    const a = held();
    fake.queueReply(a.promise);                                         // attempt A: held
    const first = callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    await vi.waitFor(async () => expect(await listUnresolvedOnlineOperations()).toHaveLength(1));
    const [op] = await listUnresolvedOnlineOperations();

    const lookup = held();
    fake.queueReply(lookup.promise);                                    // the Retry's lookup (an attempt B would commit by default)
    const retry = retryOnlineOperation(op.id);
    await vi.waitFor(() => expect(fake.callsFor("op_status").length).toBeGreaterThanOrEqual(1));

    a.release(NO_UPSTREAM);                                             // A: provably never arrived
    await first;
    lookup.release(NOT_FOUND);                                          // the Retry goes on with its own decision
    const retried = await retry;
    // The Retry was claimed against the STORED record: it is already settled
    // ("not applied", by A's own first attempt) -> nothing is resent.
    expect(retried.error?.message ?? "").toMatch(/already settled/);
    expect(fake.callsFor("op_execute").filter((c) => c.args.p_key === op.args.p_idempotency_key)).toHaveLength(1);
    expect(await stored(op.id)).toMatchObject({ status: "settled", outcome: "not-applied", decidedBy: "client", attempts: 1 });
    // the cashier enters it again: no earlier payment can commit any more -> one new payment
    const replacement = await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    expect(replacement.error).toBeNull();
    expect(executions()).toBe(1);                                       // ONE financial effect
    expect(fake.server.idempotency.get(op.args.p_idempotency_key)).toBeUndefined();   // the original key never ran
  });

  it("the Retry claims its attempt FIRST; A's late 'not delivered' then decides nothing; while B is in flight the payment stays LISTED and a replacement is refused -> at most ONE payment", async () => {
    const a = held();
    fake.queueReply(a.promise);
    const first = callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    await vi.waitFor(async () => expect(await listUnresolvedOnlineOperations()).toHaveLength(1));
    const [op] = await listUnresolvedOnlineOperations();
    const b = held();
    fake.queueReply(NOT_FOUND, b.promise);                              // lookup, then attempt B (held)
    const retry = retryOnlineOperation(op.id);
    await vi.waitFor(() => expect(fake.callsFor("op_execute").length).toBe(2));
    expect(await stored(op.id)).toMatchObject({ status: "unresolved", attempts: 2 });
    a.release(NO_UPSTREAM);                                             // A: late "not delivered"
    await first;
    expect(await stored(op.id)).toMatchObject({ status: "unresolved", attempts: 2 });   // A decided nothing
    expect(await listUnresolvedOnlineOperations()).toHaveLength(1);    // still listed while B may commit
    // a replacement: the earlier one is asked about first — it is in flight -> refused
    fake.queueReply({ data: { status: "in_flight" }, status: 200, error: null });
    await expect(callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 })).rejects.toThrow(/could not be confirmed or stopped/);
    // B commits on the server
    const { p_idempotency_key: _k, ...origArgs } = op.args as Record<string, unknown>;
    void _k;
    await fake.rpc("op_execute", { p_key: op.args.p_idempotency_key, p_rpc: "pay_supplier_lump_sum", p_args: origArgs, p_actor_id: "user-1" });
    b.release({ data: { outcome: "committed", replayed: true, response: null, withheld: true }, status: 200, error: null });
    await retry;
    expect(executions()).toBe(1);
    expect(await stored(op.id)).toMatchObject({ status: "settled", outcome: "applied", decidedBy: "server" });
  });
});

describe("LOW: a stale copy never overwrites an owner's decision", () => {
  // (review-snapshot-7 M-1: Verify first decides / fences the key on its own backend)
  it("a Retry that loaded the payment before an owner verified it does not reopen and resend it", async () => {
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    await callOnlineOnly("pay_supplier_lump_sum", payArgs);
    const [op] = await listUnresolvedOnlineOperations();
    const sentBefore = fake.callsFor("op_execute").filter((c) => c.args.p_key === op.args.p_idempotency_key).length;
    const lookup = held();
    fake.queueReply(lookup.promise);
    const retry = retryOnlineOperation(op.id);                          // loaded "unresolved", waits on its lookup
    await vi.waitFor(() => expect(fake.callsFor("op_status").length).toBeGreaterThanOrEqual(1));
    actingRole = "ADMIN";
    await markOnlineOperationVerified(op.id);                           // owner closes it meanwhile (decided on the server first)
    actingRole = "CASHIER";
    lookup.release(NOT_FOUND);
    await retry.catch(() => undefined);
    expect(await stored(op.id)).toMatchObject({ status: "settled", outcome: "applied", decidedBy: "server" });
    expect(fake.callsFor("op_execute").filter((c) => c.args.p_key === op.args.p_idempotency_key)).toHaveLength(sentBefore);   // never resent
  });
});

describe("review-snapshot-7 M-1: an owner's 'Mark verified' never lets a replacement run beside the original", () => {
  it("never arrived: Verify FENCES the key on the server, then the payment entered again is the ONLY one; a late copy of the original cannot run", async () => {
    fake.queueModes("network-error", "network-error", "network-error");
    await callOnlineOnly("pay_supplier_lump_sum", payArgs);
    const [op] = await listUnresolvedOnlineOperations();
    expect(op).toBeTruthy();
    actingRole = "ADMIN";
    await markOnlineOperationVerified(op.id);
    actingRole = "CASHIER";
    expect(await stored(op.id)).toMatchObject({ status: "settled", outcome: "abandoned", decidedBy: "server" });
    expect(fake.server.idempotency.get(op.args.p_idempotency_key)).toMatchObject({ state: "abandoned" });
    const replacement = await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    expect(replacement.error).toBeNull();
    const { p_idempotency_key: _k, ...origArgs } = op.args as Record<string, unknown>;
    void _k;
    await fake.rpc("op_execute", { p_key: op.args.p_idempotency_key, p_rpc: "pay_supplier_lump_sum", p_args: origArgs, p_actor_id: "user-1" });
    expect(executions()).toBe(1);                                       // ONE payment
  });

  it("too old to execute (the server: not found, expired, never executable): the owner can still close it manually", async () => {
    fake.queueModes("network-error", "network-error", "network-error");
    await callOnlineOnly("pay_supplier_lump_sum", payArgs);
    const [op] = await listUnresolvedOnlineOperations();
    fake.queueReply({ data: { status: "not_found", reason: "expired", executable: false }, status: 200, error: null });
    actingRole = "ADMIN";
    await markOnlineOperationVerified(op.id);
    actingRole = "CASHIER";
    expect(await stored(op.id)).toMatchObject({ status: "settled", outcome: "verified-manually", decidedBy: "owner" });
  });

  it("not found but NOT proven unable to run (e.g. not authorised to fence): Verify is refused", async () => {
    fake.queueModes("network-error", "network-error", "network-error");
    await callOnlineOnly("pay_supplier_lump_sum", payArgs);
    const [op] = await listUnresolvedOnlineOperations();
    fake.queueReply({ data: { status: "not_found", reason: "not_authorized" }, status: 200, error: null });
    actingRole = "ADMIN";
    await expect(markOnlineOperationVerified(op.id)).rejects.toThrow(/could not be confirmed or stopped/);
    actingRole = "CASHIER";
    expect(await stored(op.id)).toMatchObject({ status: "unresolved" });
  });

  it("still in flight on the server: Verify is refused and changes nothing (no replacement can pass it)", async () => {
    fake.queueModes("network-error", "network-error", "network-error");
    await callOnlineOnly("pay_supplier_lump_sum", payArgs);
    const [op] = await listUnresolvedOnlineOperations();
    fake.queueReply({ data: { status: "in_flight" }, status: 200, error: null });
    actingRole = "ADMIN";
    await expect(markOnlineOperationVerified(op.id)).rejects.toThrow(/could not be confirmed or stopped/);
    actingRole = "CASHIER";
    expect(await stored(op.id)).toMatchObject({ status: "unresolved" });
    expect(await listUnresolvedOnlineOperations()).toHaveLength(1);
  });
});

describe("LOW: failures of the till's own storage fail CLOSED", () => {
  it("a key mismatch on a brand-new payment keeps it unresolved (the server holds a decision under that key)", async () => {
    fake.queueReply({ data: { outcome: "mismatch", replayed: true }, status: 200, error: null });
    const r = await callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 0 });
    expect(r.error?.name).toBe("PendingConfirmationError");
    const [op] = await listUnresolvedOnlineOperations();
    expect(op).toBeTruthy();
  });
});
