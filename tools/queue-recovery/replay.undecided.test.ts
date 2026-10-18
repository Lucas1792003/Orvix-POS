import { describe, expect, it } from "vitest";
import type { QueueExportEntry, QueueExportPayload } from "../../src/lib/queueExport/format";
import { exitCodeFor, replayExport } from "./replay";

// ---------------------------------------------------------------------------
// Final ordering and recovery pass — HIGH: the recovery tool must classify an
// online attempt exactly as the till does. A write-ahead sale exported while
// it was being SENT ("syncing", no in-doubt flag yet — e.g. exported from the
// sign-in screen right after a crash) and never authorised offline is never
// executed: it is looked up and fenced; one whose authorisation is unknown
// (an older build's row) is looked up only. Reproduces on review-snapshot-5.
// ---------------------------------------------------------------------------

const ORIGIN = "https://pos.example.test";
const KEY = "0190a000-0000-7000-8000-000000000001";

/** Minimal 086 server: op_execute runs a v7 key for the caller; op_status looks up / fences. */
class Server {
  ledger = new Map<string, { state: string; response: unknown }>();
  executed = 0;
  calls: { rpc: string; body: Record<string, unknown> }[] = [];
  fetch: typeof fetch = async (input, init) => {
    const rpc = /\/rpc\/(\w+)$/.exec(new URL(String(input)).pathname)?.[1] ?? "";
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    this.calls.push({ rpc, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (rpc === "app_user_id") return json(200, "cash-a");
    if (rpc === "app_role") return json(200, "CASHIER");
    if (rpc === "op_status") {
      const hit = this.ledger.get(String(body.p_key));
      if (hit) return json(200, { status: hit.state, response: hit.response });
      if (body.p_fence === true) { this.ledger.set(String(body.p_key), { state: "abandoned", response: null }); return json(200, { status: "abandoned", fenced: true }); }
      return json(200, { status: "not_found" });
    }
    if (rpc === "op_execute") {
      const hit = this.ledger.get(String(body.p_key));
      if (hit) return json(200, { outcome: hit.state, replayed: true, response: hit.response });
      this.executed++;
      const response = { sale: { id: `sale-${this.executed}` } };
      this.ledger.set(String(body.p_key), { state: "committed", response });
      return json(200, { outcome: "committed", replayed: false, response });
    }
    return json(404, { message: "not found" });
  };
}

function exportOf(over: Partial<QueueExportEntry>): QueueExportPayload {
  const entry = {
    seq: 1, opId: "outbox-1", idempotencyKey: KEY, kind: "rpc", opType: "complete_sale", table: null, tableOp: null, rowId: null,
    payload: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_items: [{ product_id: "p1", qty: 1 }], p_idempotency_key: KEY },
    refs: [], provisional: [], shopId: "shop-1", createdAt: "2026-10-17T01:00:00.000Z", ringUpAt: null, status: "syncing", attempts: 0,
    lastErrorClass: null, lastError: null, nextAttemptAt: null, backendOrigin: ORIGIN, quarantineReason: null, archivedAt: null,
    archivedBy: null, archiveReason: null, statusBeforeArchive: null, statusBeforeReconcile: null, reconciliation: null, reconcileRejected: null,
    actorId: "cash-a", inDoubt: null, writeAhead: true, staged: false, fenceRequired: null, serverOutcome: null, heldReason: null,
    blocksQueue: null, dependencySince: null, refWaitSince: null,
    ...over,
  } as QueueExportEntry;
  return {
    format: "shwephala-queue-export", formatVersion: 2, appVersion: "t", exportedAt: "2026-10-17T02:00:00Z", tillId: "till",
    backendHost: "pos.example.test", session: { userId: "cash-a", orgId: "o", shopId: "shop-1", role: "CASHIER" },
    entries: [entry], provisionalIdMap: [], redactedFields: 0, reconciliationLog: [], onlineOperations: [],
  } as unknown as QueueExportPayload;
}
const run = (s: Server, p: QueueExportPayload) => replayExport(p, { target: ORIGIN, anonKey: "anon", accessToken: "t", fetchImpl: s.fetch });

describe("recovery tool: an online attempt being SENT when exported is classified as the till classifies it", () => {
  it("never authorised offline (staged: false), never reached the server: FENCED, never executed", async () => {
    const s = new Server();
    const r = await run(s, exportOf({}));
    expect(s.executed).toBe(0);
    expect(s.calls.filter((c) => c.rpc === "op_execute")).toHaveLength(0);
    expect(s.ledger.get(KEY)).toMatchObject({ state: "abandoned" });
    expect(r.ops[0].outcome).toBe("abandoned");
  });

  it("never authorised offline, it DID reach the server: reported already-applied, executed exactly once (by the till), never again", async () => {
    const s = new Server();
    s.ledger.set(KEY, { state: "committed", response: { sale: { id: "sale-till" } } });
    const r = await run(s, exportOf({}));
    expect(r.ops[0]).toMatchObject({ outcome: "already-applied", resultId: "sale-till" });
    expect(s.executed).toBe(0);
  });

  it("the CURRENT till's own interrupted online sale (write-ahead, being sent, no staged flag, first attempt): fenced like the till does — never executed", async () => {
    const s = new Server();
    const r = await run(s, exportOf({ staged: null, attempts: 0 }));
    expect(s.executed).toBe(0);
    expect(s.ledger.get(KEY)).toMatchObject({ state: "abandoned" });
    expect(r.ops[0].outcome).toBe("abandoned");
  });

  it("authorisation that only the till could prove (an older close with nothing staged, in doubt): looked up only — never fenced, never executed; the run stops, exit 4", async () => {
    const s = new Server();
    const r = await run(s, exportOf({ opType: "close_shift", status: "pending", inDoubt: true, staged: null, attempts: 1,
      payload: { p_shift_id: "shift-1", p_closing_cash_mmk: 0, p_idempotency_key: KEY } }));
    expect(s.executed).toBe(0);
    expect(s.ledger.has(KEY)).toBe(false);
    expect(s.calls.filter((c) => c.rpc === "op_status").every((c) => c.body.p_fence === false)).toBe(true);
    expect(r.ops[0].outcome).toBe("held");
    expect(exitCodeFor(r)).toBe(4);
  });

  it("a VERSION-1 file (no 086 fields) with an entry being sent: looked up only, never replayed blindly", async () => {
    const s = new Server();
    const p = exportOf({ writeAhead: null, staged: null, inDoubt: null, attempts: 1 });
    const r = await run(s, { ...p, formatVersion: 1 } as QueueExportPayload);
    expect(s.executed).toBe(0);
    expect(s.ledger.has(KEY)).toBe(false);
    expect(r.ops[0].outcome).toBe("held");
  });

  it("dry run predicts the hold (never 'planned' for an entry the real run would not replay)", async () => {
    const s = new Server();
    const r = await replayExport(exportOf({ staged: null, attempts: 0 }), { target: ORIGIN, anonKey: "anon", accessToken: "t", fetchImpl: s.fetch, dryRun: true });
    expect(r.ops[0].outcome).toBe("held");
    expect(exitCodeFor(r)).toBe(4);
    expect(s.calls).toHaveLength(0);
  });

  it("dry run against ANOTHER backend predicts what the real run does: a UUIDv7 executor sale is held even with --confirm-host; a UUIDv4 one is held without it, planned with it (never sent either way)", async () => {
    const s = new Server();
    const opts = { target: ORIGIN, anonKey: "anon", accessToken: "t", fetchImpl: s.fetch, dryRun: true };
    const v7 = exportOf({ status: "pending", staged: true, backendOrigin: "https://old.example.test" });
    expect((await replayExport(v7, opts)).ops[0].outcome).toBe("held");
    expect((await replayExport(v7, { ...opts, otherBackendConfirmed: true })).ops[0].outcome).toBe("held");
    const V4 = "11111111-1111-4111-8111-111111111111";
    const v4 = exportOf({ status: "pending", staged: true, backendOrigin: "https://old.example.test", idempotencyKey: V4,
      payload: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_items: [{ product_id: "p1", qty: 1 }], p_idempotency_key: V4 } });
    expect((await replayExport(v4, opts)).ops[0].outcome).toBe("held");
    const planned = (await replayExport(v4, { ...opts, otherBackendConfirmed: true })).ops[0];
    expect(planned.outcome).toBe("planned");
    expect(planned.detail).toMatch(/only if signed in as cash-a/);              // the creator, known only to the real run's server
    expect(s.calls).toHaveLength(0);
  });

  it("a Batch 2A close caught mid-send on a LATER attempt with nothing staged: its proof (the local shift row) is not in the file — looked up only, never fenced (the till would send it)", async () => {
    const s = new Server();
    const r = await run(s, exportOf({ opType: "close_shift", status: "syncing", staged: null, attempts: 2,
      payload: { p_shift_id: "shift-1", p_closing_cash_mmk: 0, p_idempotency_key: KEY } }));
    expect(r.ops[0].outcome).toBe("held");
    expect(s.ledger.has(KEY)).toBe(false);
    expect(s.calls.filter((c) => c.rpc === "op_status").every((c) => c.body.p_fence === false)).toBe(true);
    expect(s.executed).toBe(0);
  });

  it("review-10 H1: a first online attempt already moved to 'pending' (write-ahead, no staged flag, no attempt recorded) is fenced like the till holds it — never replayed", async () => {
    const s = new Server();
    const r = await run(s, exportOf({ status: "pending", staged: null, attempts: 0, inDoubt: null }));
    expect(r.ops[0].outcome).toBe("abandoned");
    expect(s.executed).toBe(0);
  });

  it("the ledger check (service key) is scoped to the export's own organisation — another organisation's use of the same key never makes a fresh run look 'already applied'", async () => {
    const s = new Server();
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => { urls.push(String(input)); return s.fetch(input, init); };
    const V4 = "22222222-2222-4222-8222-222222222222";
    await replayExport(exportOf({ status: "pending", staged: true, idempotencyKey: V4,
      payload: { p_shop_id: "shop-1", p_shift_id: "shift-1", p_items: [{ product_id: "p1", qty: 1 }], p_idempotency_key: V4 } }),
    { target: ORIGIN, anonKey: "anon", accessToken: "t", ledgerToken: "svc", fetchImpl });
    const ledger = urls.filter((u) => u.includes("/rest/v1/idempotency_keys"));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((u) => u.includes("org_id=eq.o"))).toBe(true);
  });

  it("set aside while being sent (no in-doubt flag): a skipped entry that is NOT decided keeps the recovery from succeeding", async () => {
    const s = new Server();
    const r = await run(s, exportOf({ status: "archived", statusBeforeArchive: "syncing", staged: true, writeAhead: true }));
    expect(r.ops[0].outcome).toBe("skipped-set-aside");
    expect(exitCodeFor(r)).toBe(4);
    expect(s.executed).toBe(0);
  });
});
