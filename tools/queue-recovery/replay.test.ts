import { describe, expect, it } from "vitest";
import type { QueueExportEntry, QueueExportPayload } from "../../src/lib/queueExport/format";
import { REDACTED } from "../../src/lib/queueExport/format";
import { TargetError, confinedFetch, exitCodeFor, replayExport, resolveTarget } from "./replay";

const ORIGIN = "https://pos.example.test";

/** In-memory backend with the server's idempotency semantics: same key +
 *  same request -> the stored response, no new effect. */
class FakeBackend {
  ledger = new Map<string, { rpc: string; hash: string; response: unknown }>();
  sales: { id: string; shift_id: string }[] = [];
  shifts: string[] = [];
  categories = new Set<string>();
  calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  failNext: { status: number; body: unknown } | null = null;
  rejectRpc = new Set<string>();
  private n = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.calls.push({ method: init?.method ?? "GET", url, body, auth: headers.Authorization ?? null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    const u = new URL(url);
    if (u.pathname.endsWith("/idempotency_keys")) {
      const key = u.searchParams.get("key")!.replace(/^eq\./, "");
      return json(200, this.ledger.has(key) ? [{ key }] : []);
    }
    if (u.pathname.endsWith("/sales") && (init?.method ?? "GET") === "GET") {
      const shift = u.searchParams.get("shift_id")!.replace(/^eq\./, "");
      return json(200, this.sales.filter((s) => s.shift_id === shift).map((s) => ({ id: s.id })));
    }
    // identity (as the server reports it) and the 086 probe: an 085 server
    if (u.pathname.endsWith("/rpc/app_user_id")) return json(200, "user-1");
    if (u.pathname.endsWith("/rpc/app_role")) return json(200, "CASHIER");
    if (/\/rpc\/op_(status|execute)$/.test(u.pathname)) return json(404, { code: "PGRST202", message: "Could not find the function" });
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return json(f.status, f.body);
    }
    const rpc = /\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname)?.[1];
    if (rpc) {
      const { p_idempotency_key: key, p_created_at: _t, ...rest } = body as Record<string, unknown>;
      void _t;
      const hash = JSON.stringify(rest);
      const hit = this.ledger.get(key as string);
      if (hit) {
        if (hit.rpc !== rpc || hit.hash !== hash) return json(409, { code: "23505", message: `IDEMPOTENCY_MISMATCH: key ${key} was used for a different request` });
        return json(200, hit.response);
      }
      if (this.rejectRpc.has(rpc)) return json(400, { code: "P0001", message: "Insufficient stock" });
      let response: unknown;
      if (rpc === "open_shift") {
        const id = `shift-real-${++this.n}`;
        this.shifts.push(id);
        response = { shift: { id }, auditLogs: [] };
      } else if (rpc === "complete_sale") {
        if (!this.shifts.includes(rest.p_shift_id as string)) return json(400, { code: "P0001", message: "Shift not found" });
        const id = `sale-real-${++this.n}`;
        this.sales.push({ id, shift_id: rest.p_shift_id as string });
        response = { sale: { id }, items: [] };
      } else response = { ok: true };
      this.ledger.set(key as string, { rpc, hash, response });
      return json(200, response);
    }
    const table = /\/rest\/v1\/(\w+)$/.exec(u.pathname)?.[1];
    if (table === "categories" && init?.method === "POST") {
      const id = (body as { id: string }).id;
      if (this.categories.has(id)) return json(409, { code: "23505", message: "duplicate key value violates unique constraint" });
      this.categories.add(id);
      return new Response(null, { status: 201 });
    }
    return json(404, { message: "not found" });
  };
}

let seq = 0;
const e = (over: Partial<QueueExportEntry> & { opType: string }): QueueExportEntry => {
  seq++;
  const key = over.idempotencyKey !== undefined ? over.idempotencyKey : `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    seq, opId: `outbox-${seq}`, idempotencyKey: key, kind: "rpc", table: null, tableOp: null, rowId: null,
    refs: [], provisional: [], shopId: "shop-1", createdAt: `2026-10-13T01:00:${String(seq).padStart(2, "0")}.000Z`,
    ringUpAt: null, status: "pending", attempts: 2, lastErrorClass: "transient", lastError: "Failed to fetch", nextAttemptAt: null,
    backendOrigin: ORIGIN, quarantineReason: null, archivedAt: null, archivedBy: null, archiveReason: null, statusBeforeArchive: null,
    statusBeforeReconcile: null, reconciliation: null, reconcileRejected: null,
    actorId: null, inDoubt: null, writeAhead: null, staged: null, fenceRequired: null, serverOutcome: null, heldReason: null, blocksQueue: null, dependencySince: null, refWaitSince: null,
    ...over,
    payload: over.payload !== undefined ? over.payload : { ...(over.kind === "table_write" ? {} : { p_idempotency_key: key }) },
  };
};

function outageQueue(): QueueExportPayload {
  seq = 0;
  const shift = e({ opType: "open_shift", provisional: [{ table: "shifts", ids: ["shift-prov"] }] });
  shift.payload = { p_shop_id: "shop-1", p_opening_cash_mmk: 0, p_created_at: "2026-10-13T01:00:00Z", p_idempotency_key: shift.idempotencyKey };
  const sales = [1, 2, 3].map((i) => {
    const s = e({ opType: "complete_sale", refs: [{ field: "p_shift_id", provisionalId: "shift-prov" }], provisional: [{ table: "sales", ids: [`sale-prov-${i}`] }] });
    s.payload = { p_shop_id: "shop-1", p_shift_id: "shift-prov", p_items: [{ productId: "p1", qty: 1 }], p_created_at: `2026-10-13T01:0${i}:00Z`, p_idempotency_key: s.idempotencyKey };
    return s;
  });
  const cat = e({ opType: "categories.insert", kind: "table_write", table: "categories", tableOp: "insert", rowId: "cat-1", idempotencyKey: null, payload: { id: "cat-1", name: "Tea" } });
  return {
    format: "shwephala-queue-export", formatVersion: 1, appVersion: "1.0.16", exportedAt: "2026-10-13T02:00:00Z",
    tillId: "till-abc", backendHost: "pos.example.test", session: { userId: "u", orgId: "o", shopId: "shop-1", role: "CASHIER" },
    // shuffled on purpose: the replay must follow seq, not array order
    entries: [sales[2], cat, shift, sales[0], sales[1]], provisionalIdMap: [], redactedFields: 0, reconciliationLog: [], onlineOperations: [],
  };
}

const opts = (b: FakeBackend, over: Record<string, unknown> = {}) => ({
  target: ORIGIN, anonKey: "anon", accessToken: "user-token", ledgerToken: "svc-token", fetchImpl: b.fetch, ...over,
});

describe("replayExport", () => {
  it("replays in seq order with the original keys, resolving refs from earlier responses", async () => {
    const b = new FakeBackend();
    const p = outageQueue();
    const r = await replayExport(p, opts(b));
    expect(r.ops.map((o) => [o.seq, o.opType, o.outcome])).toEqual([
      [1, "open_shift", "applied"], [2, "complete_sale", "applied"], [3, "complete_sale", "applied"],
      [4, "complete_sale", "applied"], [5, "categories.insert", "applied"],
    ]);
    const rpcCalls = b.calls.filter((c) => c.url.includes("/rpc/") && !/\/rpc\/(app_user_id|app_role|op_status)$/.test(c.url));
    expect(rpcCalls.map((c) => (c.body as Record<string, unknown>).p_idempotency_key))
      .toEqual(p.entries.filter((x) => x.kind === "rpc").sort((x, y) => x.seq! - y.seq!).map((x) => x.idempotencyKey));
    expect(rpcCalls.slice(1).every((c) => (c.body as Record<string, unknown>).p_shift_id === "shift-real-1")).toBe(true);
    // RPCs run as the user; only ledger GETs use the service token
    expect(b.calls.filter((c) => c.auth === "Bearer svc-token").every((c) => c.method === "GET" && c.url.includes("/idempotency_keys"))).toBe(true);
    expect(rpcCalls.every((c) => c.auth === "Bearer user-token")).toBe(true);
    expect(b.sales).toHaveLength(3);
    expect(exitCodeFor(r)).toBe(0);
  });

  it("a second replay (or the till syncing the same entries) creates nothing new", async () => {
    const b = new FakeBackend();
    await replayExport(outageQueue(), opts(b));
    const again = await replayExport(outageQueue(), opts(b));
    expect(again.ops.map((o) => o.outcome)).toEqual(["already-applied", "already-applied", "already-applied", "already-applied", "already-applied"]);
    expect(b.sales).toHaveLength(3);
    expect(b.shifts).toHaveLength(1);
    expect(b.ledger.size).toBe(4);
  });

  it("without ledger access classifies complete_sale by its shift's sales and the rest as accepted", async () => {
    const b = new FakeBackend();
    const first = await replayExport(outageQueue(), opts(b, { ledgerToken: null }));
    expect(first.classification).toBe("probe");
    expect(first.ops.map((o) => o.outcome)).toEqual(["accepted", "applied", "applied", "applied", "applied"]);
    const second = await replayExport(outageQueue(), opts(b, { ledgerToken: null }));
    expect(second.ops.map((o) => o.outcome)).toEqual(["accepted", "already-applied", "already-applied", "already-applied", "already-applied"]);
    expect(b.calls.some((c) => c.url.includes("idempotency_keys"))).toBe(false);
  });

  it("stops on a transient failure and resumes cleanly on the next run", async () => {
    const b = new FakeBackend();
    b.failNext = { status: 503, body: { message: "Service Unavailable" } };
    const r = await replayExport(outageQueue(), opts(b));
    expect(r.stoppedOn).toBe("1");
    expect(r.ops.map((o) => o.outcome)).toEqual(["not-attempted", "not-attempted", "not-attempted", "not-attempted", "not-attempted"]);
    expect(exitCodeFor(r)).toBe(4);
    const r2 = await replayExport(outageQueue(), opts(b));
    expect(r2.counts.applied).toBe(5);
    expect(b.sales).toHaveLength(3);
  });

  it("a refusal the server did not record (legacy direct path) STOPS the run like the till's queue: nothing later is replayed past it", async () => {
    const b = new FakeBackend();
    b.rejectRpc.add("open_shift");
    const r = await replayExport(outageQueue(), opts(b));
    expect(r.ops.map((o) => o.outcome)).toEqual(["rejected", "not-attempted", "not-attempted", "not-attempted", "not-attempted"]);
    expect(r.ops[0].detail).toContain("Insufficient stock");
    expect(r.stoppedOn).toBe("1");
    expect(b.sales).toHaveLength(0);
    expect(b.categories.size).toBe(0);                                  // the later, unrelated write is not replayed past it either
    expect(exitCodeFor(r)).toBe(4);
  });

  it("treats IDEMPOTENCY_MISMATCH as UNKNOWN (the server holds a decision under that key, possibly committed): never a retry, and the run stops", async () => {
    const b = new FakeBackend();
    const p = outageQueue();
    await replayExport(p, opts(b));
    const sale = p.entries.find((x) => x.seq === 2)!;
    sale.payload = { ...sale.payload, p_items: [{ productId: "p1", qty: 9 }] };
    const r = await replayExport(p, opts(b));
    expect(r.ops.find((o) => o.seq === 2)).toMatchObject({ outcome: "unknown", httpStatus: 409 });
    expect(r.stoppedOn).toBe("2");
  });

  it("skips conflicts (unless asked), redacted payloads and entries without their original key", async () => {
    const b = new FakeBackend();
    const p = outageQueue();
    p.entries.find((x) => x.seq === 5)!.status = "conflict";
    const s4 = p.entries.find((x) => x.seq === 4)!;
    s4.payload = { ...s4.payload, access_token: REDACTED };
    const s3 = p.entries.find((x) => x.seq === 3)!;
    s3.payload = { ...s3.payload, p_idempotency_key: undefined };
    const r = await replayExport(p, opts(b));
    // an entry without its original key cannot be replayed: the run stops there
    expect(r.ops.map((o) => o.outcome)).toEqual(["applied", "applied", "rejected", "not-attempted", "not-attempted"]);
    expect(r.ops[2].detail).toContain("no original idempotency key");
    const p2 = outageQueue();
    p2.entries.find((x) => x.seq === 5)!.status = "conflict";
    const withConflicts = await replayExport(p2, opts(b, { includeConflicts: true }));
    expect(withConflicts.ops[4]).toMatchObject({ opType: "categories.insert", outcome: "applied" });
  });

  it("skips entries the till quarantined (another backend) unless explicitly included", async () => {
    const b = new FakeBackend();
    const p = outageQueue();
    // v1.0.15-era entries: no recorded backend, quarantined by the 1.0.16 till
    for (const x of p.entries) {
      x.status = "quarantined";
      x.backendOrigin = null;
      x.quarantineReason = "Queued by an older app version";
    }
    const r = await replayExport(p, opts(b));
    expect(r.counts["skipped-quarantined"]).toBe(5);
    expect(b.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(exitCodeFor(r)).toBe(4);

    const forced = await replayExport(outageQueue(), opts(b, { includeQuarantined: true }));
    expect(forced.counts["skipped-quarantined"]).toBe(0);
    expect(b.sales).toHaveLength(3);
  });

  it("RC2: skips entries an owner set aside on the till unless --include-set-aside; then judged by their former status", async () => {
    const b = new FakeBackend();
    const p = outageQueue();
    for (const x of p.entries) {
      x.statusBeforeArchive = x.status as "pending";
      x.status = "archived";
      x.archivedAt = "2026-10-16T09:00:00.000Z";
    }
    const r = await replayExport(p, opts(b));
    expect(r.counts["skipped-set-aside"]).toBe(5);
    expect(b.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(r.ops[0].detail).toContain("set aside on the till");

    const p2 = outageQueue();
    for (const x of p2.entries) { x.statusBeforeArchive = "pending"; x.status = "archived"; }
    p2.entries.find((x) => x.opType === "categories.insert")!.statusBeforeArchive = "quarantined";
    const forced = await replayExport(p2, opts(b, { includeSetAside: true }));
    expect(forced.counts["skipped-set-aside"]).toBe(0);
    expect(forced.ops[4].outcome).toBe("skipped-quarantined"); // a former quarantined entry still needs its own flag
    expect(b.sales).toHaveLength(3);
    // replaying the same set-aside entries again never duplicates
    await replayExport(p2, opts(b, { includeSetAside: true }));
    expect(b.sales).toHaveLength(3);
  });

  it("--dry-run sends nothing", async () => {
    const b = new FakeBackend();
    const r = await replayExport(outageQueue(), opts(b, { dryRun: true }));
    expect(b.calls).toHaveLength(0);
    expect(r.ops.map((o) => o.outcome)).toEqual(["planned", "planned", "planned", "planned", "planned"]);
    expect(r.ops[1].detail).toContain("ref resolves from an earlier entry");
  });
});

describe("target safety", () => {
  it("requires an explicit http(s) origin", () => {
    expect(() => resolveTarget(undefined, "pos.example.test")).toThrow(TargetError);
    expect(() => resolveTarget("", "pos.example.test")).toThrow(/required/);
    expect(() => resolveTarget("ftp://pos.example.test", "pos.example.test")).toThrow(/http/);
    expect(() => resolveTarget("https://pos.example.test/rest/v1", "pos.example.test")).toThrow(/origin only/);
    expect(() => resolveTarget("https://u:p@pos.example.test", "pos.example.test")).toThrow(/credentials/);
    expect(resolveTarget("https://pos.example.test", "pos.example.test").origin).toBe(ORIGIN);
  });

  it("always refuses the hosted project", () => {
    expect(() => resolveTarget("https://abcdefgh.supabase.co", "abcdefgh.supabase.co")).toThrow(/hosted/i);
  });

  it("needs --confirm-host for a backend other than the till's", () => {
    expect(() => resolveTarget("http://127.0.0.1:55999", "pos.example.test")).toThrow(/--confirm-host 127\.0\.0\.1:55999/);
    expect(() => resolveTarget("http://127.0.0.1:55999", "pos.example.test", "127.0.0.1:1")).toThrow(TargetError);
    expect(resolveTarget("http://127.0.0.1:55999", "pos.example.test", "127.0.0.1:55999").host).toBe("127.0.0.1:55999");
  });

  it("confines every request to the target origin", async () => {
    const b = new FakeBackend();
    const f = confinedFetch(b.fetch, ORIGIN);
    expect(() => f("https://elsewhere.example.test/rest/v1/rpc/x")).toThrow(/outside the target origin/);
    await expect(f(`${ORIGIN}/rest/v1/sales?shift_id=eq.x`)).resolves.toBeInstanceOf(Response);
  });
});

// ------------------------------------------------------------ migration 086 --
/** An 086 server: op_execute runs a UUIDv7 key only for its own actor (the
 *  caller), op_status looks up / fences, the legacy path refuses UUIDv7 keys. */
class Fake086 {
  me = "cash-a";
  role = "CASHIER";
  ledger = new Map<string, { state: "committed" | "rejected" | "abandoned"; response: unknown; actor: string | null }>();
  sales = 0;
  calls: { url: string; body: Record<string, unknown> }[] = [];
  next: { status: number; body: unknown } | null = null;
  fetch: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    this.calls.push({ url: u.pathname, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    const rpc = /\/rpc\/(\w+)$/.exec(u.pathname)?.[1];
    if (rpc === "app_user_id") return json(200, this.me);
    if (rpc === "app_role") return json(200, this.role);
    if (rpc === "op_status") {
      const key = String(body.p_key);
      const hit = this.ledger.get(key);
      if (hit) return json(200, { status: hit.state, response: hit.response });
      if (body.p_fence === true && (body.p_expected_actor_id === this.me || this.role === "ADMIN")) {
        this.ledger.set(key, { state: "abandoned", response: null, actor: (body.p_expected_actor_id as string) ?? null });
        return json(200, { status: "abandoned", fenced: true });
      }
      return json(200, body.p_fence === true ? { status: "not_found", fenced: false, reason: "not_authorized" } : { status: "not_found" });
    }
    if (rpc === "op_execute") {
      if (body.p_actor_id !== this.me) return json(400, { code: "22023", message: "OP_ACTOR_MISMATCH: this operation belongs to another user" });
      const key = String(body.p_key);
      const hit = this.ledger.get(key);
      if (hit) return json(200, { outcome: hit.state, replayed: true, response: hit.response });
      if (this.next) { const n = this.next; this.next = null; return json(n.status, n.body); }
      const response = { sale: { id: `sale-${++this.sales}` } };
      this.ledger.set(key, { state: "committed", response, actor: this.me });
      return json(200, { outcome: "committed", replayed: false, response });
    }
    if (rpc) {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(String(body.p_idempotency_key))) return json(400, { code: "22023", message: "OP_EXECUTOR_REQUIRED: this operation key must be executed through op_execute" });
      this.sales++;
      return json(200, { sale: { id: `sale-${this.sales}` } });
    }
    return json(404, { message: "not found" });
  };
}

const v7 = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
function q086(entries: Partial<QueueExportEntry>[]): QueueExportPayload {
  seq = 0;
  return {
    format: "shwephala-queue-export", formatVersion: 1, appVersion: "1.0.17", exportedAt: "2026-10-17T02:00:00Z",
    tillId: "till-086", backendHost: "pos.example.test", session: { userId: "cash-a", orgId: "o", shopId: "shop-1", role: "CASHIER" },
    entries: entries.map((over, i) => {
      const key = over.idempotencyKey ?? v7(i + 1);
      const x = e({ opType: "complete_sale", ...over, idempotencyKey: key });
      x.payload = { p_shop_id: "shop-1", p_shift_id: "shift-1", p_items: [{ product_id: "p1", qty: i + 1 }], p_idempotency_key: key, ...(over.payload ?? {}) };
      return x;
    }),
    provisionalIdMap: [], redactedFields: 0, reconciliationLog: [], onlineOperations: [],
  };
}
const o086 = (b: Fake086, over: Record<string, unknown> = {}) => ({ target: ORIGIN, anonKey: "anon", accessToken: "t", fetchImpl: b.fetch, ...over });
const sent = (b: Fake086, rpc: string) => b.calls.filter((c) => c.url.endsWith(`/rpc/${rpc}`));

describe("replayExport against an 086 server (H3)", () => {
  it("a UUIDv7 operation of the signed-in user runs through op_execute with the SERVER-reported actor; a re-run is replayed, never re-executed", async () => {
    const b = new Fake086();
    const p = q086([{ actorId: "cash-a" }]);
    const r = await replayExport(p, o086(b));
    expect(r.ops[0]).toMatchObject({ outcome: "applied", resultId: "sale-1" });
    expect(r.signedInAs).toEqual({ userId: "cash-a", role: "CASHIER" });
    expect(sent(b, "op_execute")[0].body).toMatchObject({ p_key: v7(1), p_rpc: "complete_sale", p_actor_id: "cash-a" });
    expect(sent(b, "op_execute")[0].body.p_args).not.toHaveProperty("p_idempotency_key");
    expect(sent(b, "complete_sale")).toHaveLength(0);
    const again = await replayExport(q086([{ actorId: "cash-a" }]), o086(b));
    expect(again.ops[0].outcome).toBe("already-applied");
    expect(b.sales).toBe(1);
  });

  it("another user's UUIDv7 operation is never run or fenced in this session: looked up, HELD, and the run stops (ordering)", async () => {
    const b = new Fake086();
    b.me = "admin-1";
    b.role = "ADMIN";
    const r = await replayExport(q086([{ actorId: "cash-a" }, { actorId: "admin-1" }]), o086(b));
    expect(r.ops.map((o) => o.outcome)).toEqual(["held", "not-attempted"]);
    expect(r.stoppedOn).toBe("1");
    expect(sent(b, "op_execute")).toHaveLength(0);
    expect(sent(b, "op_status").filter((c) => c.body.p_fence === true)).toHaveLength(0);
    expect(b.ledger.size).toBe(0);
    expect(exitCodeFor(r)).toBe(4);
  });

  it("a HELD entry (fenceRequired) is never replayed: looked up only (W10 Phase 0) — held, the run stops; with --fence-unfound fenced, and an earlier commit is reported instead", async () => {
    const b = new Fake086();
    b.ledger.set(v7(2), { state: "committed", response: { sale: { id: "sale-earlier" } }, actor: "cash-a" });
    const held = await replayExport(q086([
      { actorId: "cash-a", status: "conflict", fenceRequired: true },
      { actorId: "cash-a", status: "conflict", fenceRequired: true },
    ]), o086(b));
    expect(held.ops[0].outcome).toBe("held");
    expect(b.ledger.has(v7(1))).toBe(false);
    expect(sent(b, "op_execute")).toHaveLength(0);
    const r = await replayExport(q086([
      { actorId: "cash-a", status: "conflict", fenceRequired: true },
      { actorId: "cash-a", status: "conflict", fenceRequired: true },
    ]), o086(b, { fenceUnfound: true }));
    expect(r.ops.map((o) => o.outcome)).toEqual(["abandoned", "already-applied"]);
    expect(r.ops[1].resultId).toBe("sale-earlier");
    expect(sent(b, "op_execute")).toHaveLength(0);
    expect(sent(b, "complete_sale")).toHaveLength(0);
    expect(b.ledger.get(v7(1))!.state).toBe("abandoned");
  });

  it("a held entry on a server WITHOUT 086 is held (never replayed) and stops the run", async () => {
    const b = new FakeBackend();
    seq = 0;
    const held = e({ opType: "complete_sale", status: "conflict", fenceRequired: true, actorId: "u" });
    const later = e({ opType: "complete_sale" });
    const r = await replayExport({ ...outageQueue(), entries: [held, later] }, opts(b));
    expect(r.ops.map((o) => o.outcome)).toEqual(["held", "not-attempted"]);
    expect(b.calls.filter((c) => /\/rpc\/complete_sale$/.test(c.url))).toHaveLength(0);
  });

  it("an entry the server already decided is reported from the till's record and never sent", async () => {
    const b = new Fake086();
    const r = await replayExport(q086([{ actorId: "cash-a", status: "conflict", serverOutcome: "rejected", lastError: "Refused by the server (final): Insufficient stock" }]), o086(b));
    expect(r.ops[0]).toMatchObject({ outcome: "rejected-final" });
    expect(b.calls).toHaveLength(0);
  });

  it("a refusal the server did NOT record (dependency / unclassified) is never final and stops the run", async () => {
    const b = new Fake086();
    b.next = { status: 400, body: { code: "P0001", message: "Shift not found", hint: "op_not_recorded:dependency" } };
    const r1 = await replayExport(q086([{ actorId: "cash-a" }, { actorId: "cash-a" }]), o086(b));
    expect(r1.ops.map((o) => o.outcome)).toEqual(["held", "not-attempted"]);
    b.next = { status: 400, body: { code: "22012", message: "division by zero", hint: "op_not_recorded:unclassified" } };
    const r2 = await replayExport(q086([{ actorId: "cash-a" }]), o086(b));
    expect(r2.ops[0].outcome).toBe("unknown");
    expect(r2.stoppedOn).toBe("1");
    // the same key later commits once
    const r3 = await replayExport(q086([{ actorId: "cash-a" }]), o086(b));
    expect(r3.ops[0].outcome).toBe("applied");
  });

  it("OP_EXECUTOR_REQUIRED on the legacy path is never a final refusal", async () => {
    const b = new Fake086();
    const f: typeof fetch = async (input, init) => (/\/rpc\/op_status$/.test(new URL(String(input)).pathname)
      ? new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), { status: 404 })
      : b.fetch(input, init));
    const r = await replayExport(q086([{ actorId: "cash-a" }]), o086(b, { fetchImpl: f }));
    expect(r.ops[0].outcome).toBe("unknown");
    expect(r.ops[0].detail).toMatch(/executor/);
    expect(b.sales).toBe(0);
  });

  it("a UUIDv4 (older till) operation keeps the direct path on an 086 server", async () => {
    const b = new Fake086();
    const r = await replayExport(q086([{ idempotencyKey: "00000000-0000-4000-8000-000000000001" }]), o086(b));
    expect(r.ops[0].outcome).toBe("accepted");
    expect(sent(b, "complete_sale")).toHaveLength(1);
    expect(sent(b, "op_execute")).toHaveLength(0);
  });
});

describe("recovery tool actor safety on the legacy path (F)", () => {
  it("another user's UUIDv4 entry is HELD on an 086 server (never run in this session) and the run stops", async () => {
    const b = new Fake086();
    const p = q086([
      { idempotencyKey: "00000000-0000-4000-8000-000000000011", actorId: "cash-b" },
      { idempotencyKey: "00000000-0000-4000-8000-000000000012", actorId: "cash-a" },
    ]);
    const r = await replayExport(p, o086(b));
    expect(r.ops.map((o) => o.outcome)).toEqual(["held", "not-attempted"]);
    expect(sent(b, "complete_sale")).toHaveLength(0);
    expect(b.sales).toBe(0);
  });

  it("on an 085 server too: another user's entry (v4 or v7) is held; the signed-in user's own runs", async () => {
    const b = new FakeBackend();
    seq = 0;
    const own = e({ opType: "categories.insert", kind: "table_write", table: "categories", tableOp: "insert", rowId: "c-own", idempotencyKey: null, payload: { id: "c-own", name: "x" } });
    const other = e({ opType: "complete_sale", actorId: "someone-else" });
    other.payload = { p_shop_id: "shop-1", p_shift_id: "s", p_items: [], p_idempotency_key: other.idempotencyKey };
    const r = await replayExport({ ...outageQueue(), entries: [own, other] }, opts(b));
    expect(r.executor).toBe("absent");
    expect(r.ops.map((o) => o.outcome)).toEqual(["applied", "held"]);
    expect(b.calls.filter((c) => /\/rpc\/complete_sale$/.test(c.url))).toHaveLength(0);
  });

  it("the server's own 'queued by a different user' refusal (055) is reported held and stops the run — never a final rejection", async () => {
    const b = new FakeBackend();
    seq = 0;
    const x = e({ opType: "complete_sale" });
    x.payload = { p_shop_id: "shop-1", p_shift_id: "s", p_items: [], p_idempotency_key: x.idempotencyKey };
    const y = e({ opType: "complete_sale" });
    b.failNext = { status: 400, body: { code: "P0001", message: "This offline action was queued by a different user — reconnect as them to sync it" } };
    const r = await replayExport({ ...outageQueue(), entries: [x, y] }, opts(b));
    expect(r.ops.map((o) => o.outcome)).toEqual(["held", "not-attempted"]);
  });
});

describe("recovery tool: blocking conflicts, undecided skips, backend binding, online operations (payment-safety pass)", () => {
  it("a conflict the server never decided (blocksQueue) stops the run — later entries are not replayed past it", async () => {
    const b = new FakeBackend();
    const p = outageQueue();
    const first = p.entries.find((x) => x.seq === 1)!;
    Object.assign(first, { status: "conflict", blocksQueue: true, lastError: "Refused, not recorded" });
    const r = await replayExport(p, opts(b));
    expect(r.ops[0]).toMatchObject({ seq: 1, outcome: "held" });
    expect(r.ops.slice(1).every((o) => o.outcome === "not-attempted")).toBe(true);
    expect(b.calls.filter((c) => c.method === "POST" && /\/rpc\/(open_shift|complete_sale)$/.test(c.url))).toHaveLength(0);
    expect(exitCodeFor(r)).toBe(4);
  });

  it("a SKIPPED entry whose outcome is not decided (set aside, in doubt) means the recovery is NOT done (exit 4)", async () => {
    const b = new FakeBackend();
    const p = outageQueue();
    const cat = p.entries.find((x) => x.opType === "categories.insert")!;
    Object.assign(cat, { status: "archived", statusBeforeArchive: "syncing", inDoubt: true });
    const r = await replayExport(p, opts(b));
    expect(r.undecidedSkipped).toBe(1);
    expect(exitCodeFor(r)).toBe(4);
  });

  it("an entry queued for ANOTHER backend is never looked up, fenced or executed against the target; a never-doubted one is replayed only with --confirm-host", async () => {
    const b = new Fake086();
    const p = q086([{ actorId: "cash-a", status: "conflict", fenceRequired: true, backendOrigin: "https://old.example.test" }]);
    const r = await replayExport(p, o086(b));
    expect(r.ops[0]).toMatchObject({ outcome: "held" });
    expect(b.calls.filter((c) => /op_status|op_execute/.test(c.url) && (c.body as Record<string, unknown>).p_key === p.entries[0].idempotencyKey)).toHaveLength(0);
    const b2 = new FakeBackend();
    seq = 0;
    const clean = e({ opType: "categories.insert", kind: "table_write", table: "categories", tableOp: "insert", rowId: "c9", idempotencyKey: null, payload: { id: "c9", name: "x" }, backendOrigin: "https://old.example.test" });
    expect((await replayExport({ ...outageQueue(), entries: [clean] }, opts(b2))).ops[0].outcome).toBe("held");
    expect((await replayExport({ ...outageQueue(), entries: [clean] }, opts(b2, { otherBackendConfirmed: true }))).ops[0].outcome).toBe("applied");
    const doubted = { ...clean, opId: "x2", rowId: "c10", payload: { id: "c10", name: "y" }, inDoubt: true };
    expect((await replayExport({ ...outageQueue(), entries: [doubted] }, opts(b2, { otherBackendConfirmed: true }))).ops[0].outcome).toBe("held");
  });

  it("unresolved online-only operations in the file are reported (never replayed) and the recovery is not done", async () => {
    const b = new FakeBackend();
    const p = { ...outageQueue(), onlineOperations: [{ id: "op-1", name: "pay_supplier_lump_sum", idempotencyKey: "k1", userId: "u", backendOrigin: ORIGIN, createdAt: "2026-10-17T00:00:00Z", attempts: 1, uncertain: true, lastError: null }] };
    const r = await replayExport(p, opts(b));
    expect(r.onlineUnresolved).toBe(1);
    expect(r.ops.at(-1)).toMatchObject({ opType: "pay_supplier_lump_sum", outcome: "held" });
    expect(b.calls.some((c) => /pay_supplier_lump_sum/.test(c.url))).toBe(false);
    expect(exitCodeFor(r)).toBe(4);
  });
});
