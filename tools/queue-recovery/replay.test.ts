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
    entries: [sales[2], cat, shift, sales[0], sales[1]], provisionalIdMap: [], redactedFields: 0,
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
    const rpcCalls = b.calls.filter((c) => c.url.includes("/rpc/"));
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

  it("reports permanent rejections, keeps going, and blocks entries that depend on a rejected one", async () => {
    const b = new FakeBackend();
    b.rejectRpc.add("open_shift");
    const r = await replayExport(outageQueue(), opts(b));
    expect(r.ops.map((o) => o.outcome)).toEqual(["rejected", "blocked-unresolved-ref", "blocked-unresolved-ref", "blocked-unresolved-ref", "applied"]);
    expect(r.ops[0].detail).toContain("Insufficient stock");
    expect(r.ops[1].detail).toContain("did not succeed");
    expect(b.sales).toHaveLength(0);
  });

  it("treats IDEMPOTENCY_MISMATCH as a rejection, never a retry", async () => {
    const b = new FakeBackend();
    const p = outageQueue();
    await replayExport(p, opts(b));
    const sale = p.entries.find((x) => x.seq === 2)!;
    sale.payload = { ...sale.payload, p_items: [{ productId: "p1", qty: 9 }] };
    const r = await replayExport(p, opts(b));
    expect(r.ops.find((o) => o.seq === 2)).toMatchObject({ outcome: "rejected", httpStatus: 409 });
    expect(r.stoppedOn).toBeNull();
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
    expect(r.ops.map((o) => o.outcome)).toEqual(["applied", "applied", "rejected", "skipped-redacted", "skipped-conflict"]);
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
