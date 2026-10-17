import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Batch 2A, checkpoint A — the drain's reaction to every failure class, reply
// validation and atomic acknowledgement. Network is a plain rpc mock; the
// queue is the real outbox on fake IndexedDB.

const rpc = vi.fn();
const refreshSession = vi.fn();
vi.mock("../../lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: { id: "auth-1" } } }, error: null }),
      refreshSession: (...a: unknown[]) => refreshSession(...a),
    },
  },
}));

import { localDb } from "../../lib/localDb";
import { drainOutbox, enqueueOutbox, readNeedsReauth, registerOutboxReconciler, recordIdMapping, clearNeedsReauth } from "./outbox";
import { validReply } from "./testing/validReplies";
import { noteResponseForRetryAfter, resetRetryAfterForTests } from "../../lib/retryAfter";

const answer = (reply: unknown) => rpc.mockResolvedValue(reply);
const one = async () => (await localDb.syncOutbox.toArray())[0];

beforeEach(async () => {
  rpc.mockReset();
  refreshSession.mockReset();
  resetRetryAfterForTests();
  await Promise.all(localDb.tables.map((t) => t.clear()));
  await clearNeedsReauth();
  registerOutboxReconciler("complete_sale", () => undefined);
});

describe("drain: failure classes", () => {
  it("PT503 (organisation suspended) is held — pending, never a conflict, ≥ 5 min back-off", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
    answer({ data: null, status: 503, error: { code: "PT503", message: "ORG_SUSPENDED: service unavailable" } });
    expect(await drainOutbox()).toBe("backoff");
    const e = await one();
    expect(e).toMatchObject({ status: "pending", heldReason: "suspended", failureKind: "transient" });
    expect(e.inDoubt).toBe(false);
    expect(Date.parse(e.nextAttemptAt!) - Date.now()).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
  });

  it("invalid JWT: the session is refreshed once; a second rejection asks the till to sign in again; the entry is kept", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
    answer({ data: null, status: 401, error: { code: "PGRST301", message: "JWSError JWSInvalidSignature" } });
    refreshSession.mockResolvedValue({ data: { session: { user: { id: "auth-1" } } }, error: null });
    expect(await drainOutbox()).toBe("backoff");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(await readNeedsReauth()).toBe(false);
    await localDb.syncOutbox.update((await one()).localId, { nextAttemptAt: undefined });
    expect(await drainOutbox()).toBe("needs-reauth");
    expect(await readNeedsReauth()).toBe(true);
    expect(await one()).toMatchObject({ status: "pending", authFailures: 2, heldReason: "reauth" });
  });

  it("invalid JWT and the refresh itself is refused: sign in again at once", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
    answer({ data: null, status: 401, error: { message: "" } });
    refreshSession.mockResolvedValue({ data: { session: null }, error: { message: "Invalid Refresh Token" } });
    expect(await drainOutbox()).toBe("needs-reauth");
    expect(await localDb.syncOutbox.count()).toBe(1);
  });

  it("Cloudflare 524 (timeout after the origin accepted it): kept, in doubt, same key", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
    const key = (await one()).idempotencyKey;
    answer({ data: null, status: 524, error: { message: "<html>A timeout occurred</html>" } });
    expect(await drainOutbox()).toBe("network");
    expect(await one()).toMatchObject({ status: "pending", inDoubt: true, idempotencyKey: key });
  });

  it("HTML 403 from an edge: held, never a conflict", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
    answer({ data: null, status: 403, error: { message: "<html>Access denied</html>" } });
    await drainOutbox();
    expect(await one()).toMatchObject({ status: "pending", heldReason: "edge" });
  });

  it("'in doubt' sticks: a later definite non-commit (429) does not clear it", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
    answer({ data: null, status: 504, error: { message: "upstream request timeout" } });
    await drainOutbox();
    await localDb.syncOutbox.update((await one()).localId, { nextAttemptAt: undefined });
    answer({ data: null, status: 429, error: { message: "Too Many Requests" } });
    await drainOutbox();
    expect((await one()).inDoubt).toBe(true);
  });

  it("Retry-After from the server is honoured in the back-off", async () => {
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
    noteResponseForRetryAfter(429, "120");
    answer({ data: null, status: 429, error: { message: "Too Many Requests" } });
    await drainOutbox();
    expect(Date.parse((await one()).nextAttemptAt!) - Date.now()).toBeGreaterThan(110_000);
  });
});

describe("drain: replies are validated, reconcilers cannot crash the queue", () => {
  for (const [label, data] of [["empty object", {}], ["null", null], ["missing items", { sale: { id: "s" } }]] as const) {
    it(`a 2xx with ${label} for complete_sale is an unknown outcome: kept, in doubt, never reconciled or deleted`, async () => {
      const reconciled = vi.fn();
      registerOutboxReconciler("complete_sale", reconciled);
      await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
      answer({ data, error: null, status: 200 });
      await expect(drainOutbox()).resolves.toBe("backoff");
      expect(reconciled).not.toHaveBeenCalled();
      expect(await one()).toMatchObject({ status: "pending", inDoubt: true, heldReason: "unrecognised-reply" });
    });
  }

  it("a reconciler that throws: the drain survives, the entry is kept (server has it; resend returns the stored reply)", async () => {
    registerOutboxReconciler("complete_sale", () => { throw new TypeError("boom"); });
    await enqueueOutbox({ kind: "rpc", name: "complete_sale", args: { n: 1 }, shopId: "shop-1" });
    answer({ data: validReply("complete_sale"), error: null });
    await expect(drainOutbox()).resolves.toBe("network");
    expect(await one()).toMatchObject({ status: "pending", heldReason: "reconcile-failed", inDoubt: true });
  });
});

describe("drain: id mappings commit with the acknowledgement (item 7)", () => {
  it("the mapping is written in the same transaction that removes the entry", async () => {
    registerOutboxReconciler("open_shift", () => { void recordIdMapping("shift-local", "shift-server"); });
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { n: 1 }, shopId: "shop-1" });
    answer({ data: validReply("open_shift"), error: null });
    await drainOutbox();
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect((await localDb.provisionalIdMap.get("shift-local"))?.realId).toBe("shift-server");
  });

  it("if the acknowledgement fails, neither the mapping nor the removal happens; the next drain completes both", async () => {
    registerOutboxReconciler("open_shift", () => { void recordIdMapping("shift-local", "shift-server"); });
    await enqueueOutbox({ kind: "rpc", name: "open_shift", args: { n: 1 }, shopId: "shop-1" });
    answer({ data: validReply("open_shift"), error: null });
    const del = vi.spyOn(localDb.syncOutbox, "delete").mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(drainOutbox()).rejects.toThrow(/disk full/);
    del.mockRestore();
    expect(await localDb.provisionalIdMap.get("shift-local")).toBeUndefined(); // rolled back together
    await localDb.syncOutbox.update((await one()).localId, { status: "pending" });
    await drainOutbox();
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect((await localDb.provisionalIdMap.get("shift-local"))?.realId).toBe("shift-server");
  });
});
