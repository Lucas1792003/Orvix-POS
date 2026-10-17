import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Migration 086 — payment-safety and shared-till pass. Deterministic
// reproductions of the two HIGH review findings (they FAIL on the code of
// review-snapshot-4 and pass after the fix), through public APIs only:
//   HIGH-1  an unresolved online money operation that was never marked
//           uncertain (crash during its first attempt / unreadable reply)
//           is settled "not applied" by a later 503/401 -> a duplicate
//           payment is possible;
//   HIGH-2  on a shared till, another cashier's unsent entry stops every
//           later entry of this cashier, related or not.
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
import { localDb } from "../../lib/localDb";
import { drainOutbox, enqueueOutbox, registerOutboxReconciler, simulateNewAppInstanceForTests } from "./outbox";
import { setExecutorCapabilityForTests } from "./idempotentRpc";
import { registerVerifiedReload } from "./verifiedReload";
import { callOnlineOnly, listUnresolvedOnlineOperations, resetOnlineOnlyForTests, retryOnlineOperation } from "./onlineOnly";
import { registerOperationPrompt } from "./operationPrompt";

const payArgs = { p_supplier_id: "s1", p_shop_id: "shop-1", p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
const pay = () => callOnlineOnly("pay_supplier_lump_sum", payArgs);
const NO_UPSTREAM = { data: null, status: 503, error: { message: "no healthy upstream", code: "", details: "", hint: "" } };
const sale = (product: string, qty = 1, shift = "shift-1") => ({
  p_shop_id: "shop-1", p_shift_id: shift, p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0,
  p_items: [{ product_id: product, qty, units_per_item: 1 }], p_created_at: new Date().toISOString(),
});
const as = (user: string) => { actingUser = user; fake.setCaller(user); };
const sent = (key?: string) => fake.callsFor("op_execute").filter((c) => !key || c.args.p_key === key);
const rowsInOrder = async () => (await localDb.syncOutbox.toArray()).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

beforeEach(async () => {
  fake.reset();
  as("user-1");
  actingRole = "CASHIER";
  setExecutorCapabilityForTests("available");
  fake.enableExecutor();
  simulateNewAppInstanceForTests();
  resetOnlineOnlyForTests();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  registerOutboxReconciler("complete_sale", () => undefined);
  registerOutboxReconciler("adjust_stock", () => undefined);
  registerVerifiedReload(null);
  registerOperationPrompt(async () => "new");
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerOperationPrompt(null);
});

describe("HIGH-1: an unresolved online money operation is never 'not applied' without a server decision", () => {
  it("crash DURING the first attempt (it reached the server), retried after the restart: a 503 never settles it — and a 'new' payment is refused (no duplicate)", async () => {
    fake.queueModes("commit-then-hang");                 // committed; the process dies before the reply
    void pay();
    await vi.waitFor(() => expect(fake.server.executions.pay_supplier_lump_sum).toBe(1));
    resetOnlineOnlyForTests();                           // restart
    const [op] = await listUnresolvedOnlineOperations();
    expect(op).toBeTruthy();
    fake.queueReply(NO_UPSTREAM, NO_UPSTREAM, NO_UPSTREAM, NO_UPSTREAM);   // the lookup and every attempt
    const retried = await retryOnlineOperation(op.id);
    expect(retried.error?.name).toBe("PendingConfirmationError");          // NOT "not applied"
    expect(await listUnresolvedOnlineOperations()).toHaveLength(1);
    await expect(pay()).rejects.toThrow(/has now been recorded/);          // replacement settles it first
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(1);          // exactly one payment
  });

  it("an UNREADABLE reply (it committed), then a retry that only gets 401s: still unresolved; a replacement is refused", async () => {
    // a committed envelope whose reply the till cannot read
    fake.queueReply({ data: { outcome: "committed", replayed: false, response: { unexpected: true } }, status: 200, error: null });
    const first = await pay();
    expect(first.error?.name).toBe("PendingConfirmationError");
    // the server really committed it (the reply was just unreadable)
    const [op] = await listUnresolvedOnlineOperations();
    const opArgs = { ...op.args };
    delete opArgs.p_idempotency_key;
    await fake.rpc("op_execute", { p_key: op.args.p_idempotency_key, p_rpc: "pay_supplier_lump_sum", p_args: opArgs, p_actor_id: "user-1" });
    const executions = fake.server.executions.pay_supplier_lump_sum;
    fake.setDefaultMode("jwt-expired");                   // every request of the retry gets 401
    const retried = await retryOnlineOperation(op.id);
    fake.setDefaultMode("succeed");
    expect(retried.error?.name).toBe("PendingConfirmationError");
    expect(await listUnresolvedOnlineOperations()).toHaveLength(1);
    await expect(pay()).rejects.toThrow(/has now been recorded/);
    expect(fake.server.executions.pay_supplier_lump_sum).toBe(executions);
  });

  it("an older record (no backend recorded) is never retried or replaced here: a new payment is refused until an owner verifies it", async () => {
    await localDb.syncState.put({
      key: "online-op:legacy-1", updatedAt: new Date().toISOString(),
      value: JSON.stringify({
        v: 2, id: "legacy-1", name: "pay_supplier_lump_sum", orgId: "org-1", userId: "user-1", fingerprint: "x",
        scope: "pay_supplier_lump_sum#s1|shop-1", args: { ...payArgs, p_idempotency_key: "11111111-1111-4111-8111-111111111111" },
        status: "unresolved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0,
      }),
    });
    await expect(retryOnlineOperation("legacy-1")).rejects.toThrow(/another server|older version/);
    await expect(pay()).rejects.toThrow(/another server|older version/);
    expect(fake.callsFor("op_status").filter((c) => c.args.p_fence === true)).toHaveLength(0);   // never fenced
    expect(fake.server.executions.pay_supplier_lump_sum ?? 0).toBe(0);
  });
});

describe("HIGH-2: another cashier's unsent entries do not stop unrelated work on a shared till", () => {
  it("cashier B's sale of ANOTHER product on ANOTHER shift passes cashier A's parked sale; it is never run in B's session", async () => {
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1", 1, "shift-a"), shopId: "shop-1" });
    as("cash-b");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p2", 1, "shift-b"), shopId: "shop-1" });
    await drainOutbox();
    const [a, b] = await rowsInOrder();
    expect(a).toMatchObject({ status: "pending", heldReason: "needs-original-user" });
    expect(sent(a.idempotencyKey)).toHaveLength(0);                          // never in B's session
    expect(b).toBeUndefined();                                               // B's own sale went through
    expect(fake.server.sales).toHaveLength(1);
  });

  it("alternating sign-ins on one till: each cashier's independent sale reaches the server IN THEIR OWN SESSION, while the other's waits", async () => {
    // A's first sale is stuck (the server cannot be reached for it) when A signs out
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1", 1, "shift-a"), shopId: "shop-1" });
    fake.queueModes("network-error");
    await drainOutbox();
    for (let round = 0; round < 3; round++) {
      as("cash-b");
      await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p2", 1, "shift-b"), shopId: "shop-1" });
      const before = fake.server.sales.length;
      await drainOutbox();
      expect(fake.server.sales.length).toBe(before + 1);            // B's own sale, now — not behind A's
      as("cash-a");
      for (const r of await localDb.syncOutbox.toArray()) await localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
      await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1", 1, "shift-a"), shopId: "shop-1" });
      await drainOutbox();
      for (const r of await localDb.syncOutbox.toArray()) await localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    }
    as("cash-a");
    await drainOutbox();
    expect(fake.server.sales).toHaveLength(7);
    expect(await localDb.syncOutbox.count()).toBe(0);
  });
});

describe("shared till: what stays blocked, owner recovery, entries being sent", () => {
  it("B's sale of the product A RESTOCKED (still queued) waits behind it — dependent work never passes", async () => {
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "adjust_stock", args: { p_shop_id: "shop-1", p_product_id: "p1", p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 5, p_reason: "restock" }, shopId: "shop-1" });
    as("cash-b");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1", 1, "shift-b"), shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p2", 1, "shift-b"), shopId: "shop-1" });
    await drainOutbox();
    const left = await rowsInOrder();
    expect(left.map((r) => [r.name, (r.args?.p_items as { product_id: string }[] | undefined)?.[0]?.product_id ?? r.args?.p_product_id])).toEqual([
      ["adjust_stock", "p1"], ["complete_sale", "p1"],                                    // the p2 sale went
    ]);
    expect(fake.server.sales).toHaveLength(1);
  });

  it("A's close of A's shift waits for A's sale; B's unrelated sale passes both", async () => {
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1", 1, "shift-a"), shopId: "shop-1" });
    as("cash-b");
    await enqueueOutbox({ kind: "rpc", name: "close_shift", args: { p_shift_id: "shift-a", p_closing_cash_mmk: 0 }, shopId: "shop-1" });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p2", 1, "shift-b"), shopId: "shop-1" });
    await drainOutbox();
    expect((await rowsInOrder()).map((r) => r.name)).toEqual(["complete_sale", "close_shift"]);   // the close waits for A's sale
    expect(fake.server.sales).toHaveLength(1);
  });

  it("owner recovery: an ADMIN's 'Confirm with server' on another cashier's AUTHORISED entry looks it up but never fences it; the action is audited", async () => {
    const { confirmWithServer } = await import("./outbox");
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1"), shopId: "shop-1" });
    const [row] = await rowsInOrder();
    await localDb.syncOutbox.update(row.localId, { staged: true, inDoubt: true });
    as("admin-1");
    fake.setCaller("admin-1", true);
    actingRole = "ADMIN";
    expect(await confirmWithServer(row.localId)).toBe("undecided");
    expect(fake.server.idempotency.get(row.idempotencyKey!)).toBeUndefined();               // not fenced
    expect(fake.callsFor("op_status").at(-1)?.args).toMatchObject({ p_key: row.idempotencyKey, p_fence: false });
    expect(await localDb.syncOutbox.get(row.localId)).toMatchObject({ status: "pending", staged: true });
    const audit = (await localDb.syncState.toArray()).filter((r) => r.key.startsWith("reconcile-log:") || /rlog/.test(r.key)).map((r) => JSON.parse(r.value ?? "{}"));
    expect(audit.some((l) => l.event === "owner-action" && /confirm-with-server/.test(l.detail) && /never fenced/.test(l.detail))).toBe(true);
  });

  it("owner recovery: setting aside another cashier's unknown sale is audited as NOT cancelled and keeps its stock reservation", async () => {
    const { setAsideOutboxEntry } = await import("./outbox");
    const { pendingStockDeltas } = await import("./pendingStock");
    as("cash-a");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1", 3), shopId: "shop-1" });
    const [row] = await rowsInOrder();
    await localDb.syncOutbox.update(row.localId, { inDoubt: true, writeAhead: true, staged: true });
    as("admin-1");
    actingRole = "ADMIN";
    await setAsideOutboxEntry(row.localId, { wasExported: () => true });
    expect([...(await pendingStockDeltas()).values()]).toEqual([-3]);
    const audit = (await localDb.syncState.toArray()).map((r) => { try { return JSON.parse(r.value ?? "{}"); } catch { return {}; } });
    expect(audit.some((l) => l.event === "owner-action" && /set-aside/.test(l.detail) && /not cancelled/.test(l.detail) && /UNKNOWN/.test(l.detail))).toBe(true);
  });

  it("an entry being SENT right now counts: an online operation that depends on it is not sent past it", async () => {
    const { blockingEarlierWork } = await import("./outbox");
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1", 1, "shift-1"), shopId: "shop-1" });
    const [row] = await rowsInOrder();
    await localDb.syncOutbox.update(row.localId, { status: "syncing", syncingSince: new Date().toISOString() });
    expect(await blockingEarlierWork({ kind: "rpc", name: "close_shift", args: { p_shift_id: "shift-1" }, shopId: "shop-1", actorId: "user-1" })).toHaveLength(1);
    expect(await blockingEarlierWork({ kind: "rpc", name: "complete_sale", args: sale("p9", 1, "shift-1") })).toHaveLength(0);   // two sales commute
  });

  it("an online-only operation outside the money set never overtakes what it depends on (cancel of a PO whose receipt is still queued)", async () => {
    await enqueueOutbox({ kind: "rpc", name: "receive_purchase_order", args: { p_purchase_order_id: "po-1", p_received_items: null }, shopId: "shop-1" });
    fake.setDefaultMode("network-error");
    await expect(callOnlineOnly("cancel_purchase_order", { p_purchase_order_id: "po-1" })).rejects.toThrow(/must not overtake/);
    fake.setDefaultMode("succeed");
    expect(fake.callsFor("op_execute").filter((c) => c.args.p_rpc === "cancel_purchase_order")).toHaveLength(0);
  });

  it("a dead parent (set aside) makes its waiting child a blocking conflict at once — no 24 h wait", async () => {
    actingRole = "ADMIN";
    const { setAsideOutboxEntry } = await import("./outbox");
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { p_shop_id: "shop-1", p_opening_cash_mmk: 0 }, shopId: "shop-1", provisional: [{ table: "shifts", ids: ["shift-local"] }] });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: sale("p1", 1, "shift-local"), shopId: "shop-1", refs: [{ field: "p_shift_id", provisionalId: "shift-local" }] });
    const [parent, child] = await rowsInOrder();
    await setAsideOutboxEntry(parent.localId, { wasExported: () => true });
    actingRole = "CASHIER";
    expect(await drainOutbox()).toBe("backoff");
    expect(await localDb.syncOutbox.get(child.localId)).toMatchObject({ status: "conflict", blocksQueue: true });
    expect((await localDb.syncOutbox.get(child.localId))!.lastError).toMatch(/set aside, refused or stopped/);
  });
});
