import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Migration 086 — post-checkpoint pass (after d0390a1): shared-till delay,
// the 5-minute park, cross-organisation export / verification, storage
// failures failing closed, legacy actor keys.
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
import { localDb, SYNC_STATE_KEYS } from "../../lib/localDb";
import { recordQueueExport, resetQueueExportRecord } from "../../lib/queueExport/exportRecord";
import { blockingEarlierWork, drainOutbox, enqueueOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "./outbox";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { registerVerifiedReload } from "./verifiedReload";
import { callOnlineOnly, listUnresolvedOnlineOperations, markOnlineOperationVerified, resetOnlineOnlyForTests } from "./onlineOnly";
import { collectQueueExport, countQueue } from "../../lib/queueExport/collect";
import { mayDepend } from "./dependencies";

const as = (user: string, role = "CASHIER") => { actingUser = user; actingRole = role; fake.setCaller(user, role === "ADMIN"); };
const sale = (shift: string, product = "p1") => ({
  p_shop_id: "shop-1", p_shift_id: shift, p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0,
  p_items: [{ product_id: product, qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString(),
});
const ctx = { appVersion: "t", tillId: "till", backendHost: "127.0.0.1:54321" };

beforeEach(async () => {
  fake.reset();
  as("user-1");
  actingOrg = "org-1";
  setExecutorCapabilityForTests("available");
  fake.enableExecutor();
  simulateNewAppInstanceForTests();
  resetOnlineOnlyForTests();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  registerOutboxReconciler("complete_sale", () => undefined);
  registerVerifiedReload(null);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Phase 4: shared-till delay — independence PROVEN from a never-sent offline shift", () => {
  const offlineShiftOfA = async () => {
    // the till's own row of B's server shift: whose shift the close is about
    await localDb.shifts.put({ id: "shift-server-b", shopId: "shop-1", cashierId: "cash-b", startedAt: new Date().toISOString(), openingCashMmk: 0 } as never);
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-1", p_opening_cash_mmk: 0 }, shopId: "shop-1", provisional: [{ table: "shifts", ids: ["shift-local-a"] }] });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("shift-local-a"), shopId: "shop-1", refs: [{ field: "p_shift_id", provisionalId: "shift-local-a" }] });
  };

  it("B's close of a server-known shift does NOT wait for A's sales on a shift A opened offline and never sent; A's own close of that shift still waits", async () => {
    await offlineShiftOfA();
    const closeB = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-server-b" }, shopId: "shop-1", actorId: "cash-b" };
    expect(await blockingEarlierWork(closeB)).toHaveLength(0);
    const closeA = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-local-a" }, shopId: "shop-1", actorId: "cash-a", refs: [{ field: "p_shift_id", provisionalId: "shift-local-a" }] };
    expect((await blockingEarlierWork(closeA)).map((r) => r.name)).toEqual(["open_shift", "complete_sale"]);
  });

  it("a close of a shift whose cashier the till does not know still waits for A's offline open (it might be A's shift)", async () => {
    await offlineShiftOfA();
    await localDb.shifts.delete("shift-server-b");
    const closeB = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-server-b" }, shopId: "shop-1", actorId: "cash-b" };
    expect((await blockingEarlierWork(closeB)).map((r) => r.name)).toEqual(["open_shift"]);
  });

  it("once A's open has been SENT (outcome unknown), its offline id may be any server shift again: B's close waits (conservative)", async () => {
    await offlineShiftOfA();
    const open = (await localDb.syncOutbox.toArray()).find((r) => r.name === "open_shift")!;
    await localDb.syncOutbox.update(open.localId, { sentAt: new Date().toISOString(), inDoubt: true, attempts: 1 });
    const closeB = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-server-b" }, shopId: "shop-1", actorId: "cash-b" };
    expect((await blockingEarlierWork(closeB)).map((r) => r.name)).toContain("complete_sale");
  });

  it("review-snapshot-7 (ordering M1): once the queue has been EXPORTED (it may be replayed elsewhere), A's offline shift is no longer provably unsent — B's close waits again; entries queued after the export still prove it", async () => {
    await offlineShiftOfA();
    const closeB = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-server-b" }, shopId: "shop-1", actorId: "cash-b" };
    expect(await blockingEarlierWork(closeB)).toHaveLength(0);
    // durable mark (survives a restart)
    const at = new Date(Date.now() + 1).toISOString();
    await localDb.syncState.put({ key: SYNC_STATE_KEYS.lastQueueExport, value: at, updatedAt: at });
    expect((await blockingEarlierWork(closeB)).map((r) => r.name)).toContain("complete_sale");
    // a second offline shift queued AFTER the export: it proves it again (the first still waits)
    await localDb.syncOutbox.clear();
    await new Promise((r) => setTimeout(r, 5));
    await offlineShiftOfA();
    expect(await blockingEarlierWork(closeB)).toHaveLength(0);
  });

  it("the in-memory export record alone (the durable write failed) has the same effect", async () => {
    await offlineShiftOfA();
    recordQueueExport([], new Date(Date.now() + 1000));
    const closeB = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-server-b" }, shopId: "shop-1", actorId: "cash-b" };
    expect((await blockingEarlierWork(closeB)).map((r) => r.name)).toContain("complete_sale");
    resetQueueExportRecord();
  });

  it.each([
    ["one attempt made", { attempts: 1 }],
    ["stamped as sent", { sentAt: new Date().toISOString() }],
    ["being sent", { status: "syncing" as const }],
    ["in doubt", { inDoubt: true }],
    ["held (fence required)", { fenceRequired: true }],
    ["queued for another backend", { backendOrigin: "https://other.example.test" }],
  ])("each guard on its own keeps the wildcard: A's open %s -> B's close waits", async (_label, over) => {
    await offlineShiftOfA();
    const open = (await localDb.syncOutbox.toArray()).find((r) => r.name === "open_shift")!;
    await localDb.syncOutbox.update(open.localId, over as never);
    const closeB = { kind: "rpc" as const, name: "close_shift", args: { p_shift_id: "shift-server-b" }, shopId: "shop-1", actorId: "cash-b" };
    expect((await blockingEarlierWork(closeB)).map((r) => r.name)).toContain("complete_sale");
  });

  it("alternating sign-ins: B's close is sent in B's session while A's never-sent offline shift waits for A", async () => {
    await offlineShiftOfA();
    as("cash-b");
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: { p_shift_id: "shift-server-b", p_closing_cash_mmk: 0 }, shopId: "shop-1" });
    await drainOutbox();
    expect(fake.callsFor("op_execute").map((c) => c.args.p_rpc)).toEqual(["close_shift"]);
    expect((await localDb.syncOutbox.toArray()).map((r) => r.name).sort()).toEqual(["complete_sale", "open_shift"]);
  });
});

describe("Phase 5: the 5-minute park", () => {
  it("a park set in the creator's OWN session (the server refused it for this user) keeps its backoff — no resend loop", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("shift-1"), shopId: "shop-1" });
    fake.queueReply({ data: null, status: 400, error: { code: "22023", message: "OP_ACTOR_MISMATCH: this operation belongs to another user", details: null, hint: null } });
    await drainOutbox();
    const [row] = await localDb.syncOutbox.toArray();
    expect(row).toMatchObject({ heldReason: "needs-original-user" });
    await drainOutbox();
    await drainOutbox();
    expect(fake.callsFor("op_execute")).toHaveLength(1);                   // not resent on every drain
  });

  it("parked while ANOTHER user was signed in: its creator signing back in makes it due at once", async () => {
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("shift-a"), shopId: "shop-1" });
    as("cash-b");
    await drainOutbox();
    expect((await localDb.syncOutbox.toArray())[0]).toMatchObject({ heldReason: "needs-original-user", parkedWhileSignedIn: "cash-b" });
    as("cash-a");
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(1);
  });
});

describe("Phase 5: organisations", () => {
  const mkOp = (id: string, orgId: string) => ({
    v: 2, id, name: "pay_supplier_lump_sum", orgId, userId: "user-1", fingerprint: id, scope: `pay#${id}`,
    args: { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 1, p_idempotency_key: `0190a000-0000-7000-8000-00000000000${id.slice(-1)}` },
    status: "unresolved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, backendOrigin: "http://127.0.0.1:54321",
  });

  it("a signed-in export carries only its own organisation's unresolved online operations; the count that enables export is scoped the same way", async () => {
    await localDb.syncState.bulkPut([
      { key: "online-op:op-1", value: JSON.stringify(mkOp("op-1", "org-1")), updatedAt: "x" },
      { key: "online-op:op-2", value: JSON.stringify(mkOp("op-2", "org-2")), updatedAt: "x" },
    ]);
    const mine = await collectQueueExport(localDb, { ...ctx, session: { userId: "user-1", orgId: "org-1", shopId: null, role: "CASHIER" } });
    expect(mine.onlineOperations.map((o) => o.id)).toEqual(["op-1"]);
    expect(mine.onlineOperations[0]).toMatchObject({ orgId: "org-1", backendOrigin: "http://127.0.0.1:54321", userId: "user-1" });
    expect((await countQueue(localDb, "org-1")).total).toBe(1);
    // zero queued operations, one unresolved payment: the export is available
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect((await countQueue(localDb, "org-1")).onlineOperations).toBe(1);
    // the sign-in screen (no session): the whole till, as for the queue itself
    expect((await collectQueueExport(localDb, { ...ctx, session: { userId: null, orgId: null, shopId: null, role: null } })).onlineOperations).toHaveLength(2);
  });

  it("an owner cannot verify (close) another organisation's operation", async () => {
    await localDb.syncState.put({ key: "online-op:op-2", value: JSON.stringify(mkOp("op-2", "org-2")), updatedAt: "x" });
    as("admin-1", "ADMIN");
    await expect(markOnlineOperationVerified("op-2")).rejects.toThrow(/another organisation/);
    expect(JSON.parse((await localDb.syncState.get("online-op:op-2"))!.value!).status).toBe("unresolved");
  });
});

describe("Phase 5: storage failures fail CLOSED", () => {
  it("the payment's record cannot be read before sending: nothing is sent, it is reported pending", async () => {
    fake.queueModes("commit-then-timeout", "network-error", "network-error");
    await callOnlineOnly("pay_supplier_lump_sum", { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 5, p_payment_method: "CASH", p_reference_no: null, p_notes: null });
    const [op] = await listUnresolvedOnlineOperations();
    const sent = fake.callsFor("op_execute").length;
    const spy = vi.spyOn(localDb.syncState, "get").mockRejectedValue(new Error("IDB read failed"));
    const { retryOnlineOperation } = await import("./onlineOnly");
    const r = await retryOnlineOperation(op.id).catch((e: Error) => ({ error: e }));
    spy.mockRestore();
    expect((r as { error: Error }).error).toBeTruthy();
    expect(fake.callsFor("op_execute")).toHaveLength(sent);                // nothing sent
    expect(await listUnresolvedOnlineOperations()).toHaveLength(1);        // still unresolved
  });
});

describe("Phase 5: legacy actor key", () => {
  it("a row carrying its actor only in p_expected_actor_id is ordered before a deactivation of that user", () => {
    const legacy = { kind: "rpc" as const, name: "complete_sale", shopId: "shop-1", args: { ...sale("s"), p_expected_actor_id: "cash-z" } };
    expect(mayDepend({ name: "deactivate_app_user", args: { p_id: "cash-z" } }, legacy)).toBe(true);
    expect(mayDepend({ name: "deactivate_app_user", args: { p_id: "cash-y" } }, legacy)).toBe(false);
  });
});
