// RC3: the read-only server check before a reconciliation (recorded / not
// recorded / inconclusive), and that it only ever SELECTs.
import { describe, it, expect } from "vitest";
import { checkServerRecord, lineSignature, saleIdentity, supabaseSaleReader, verifyRecreatedSale, type SelectOnlyClient } from "./serverCheck";
import { FakeSalesServer, saleArgs } from "../../test/reconcileFakes";
import type { SyncOutboxEntry } from "../localDb";

const DIGEST = "d".repeat(64);
const entry = (args = saleArgs(), over: Partial<SyncOutboxEntry> = {}): SyncOutboxEntry => ({
  localId: "outbox-1", kind: "rpc", name: "complete_sale", args, shopId: "shop-1",
  createdAt: "2026-10-16T08:00:00.200Z", status: "conflict", attempts: 1, idempotencyKey: String(args.p_idempotency_key), ...over,
});
const noRefs = () => null;
const check = (srv: FakeSalesServer, e = entry(), resolveRef: (id: string) => string | null = noRefs) =>
  checkServerRecord(e, { reader: srv, resolveRef, entryDigest: DIGEST, now: new Date("2026-10-16T09:00:00Z") });

describe("checkServerRecord (read-only; client operation identity like e2e/helpers/saleLedger.ts)", () => {
  it("recorded: same shop + shift + ring-up instant + amounts + lines -> the sale id and receipt number", async () => {
    const srv = new FakeSalesServer();
    srv.commitSale(saleArgs({ p_created_at: "2026-10-16T07:00:00Z", p_idempotency_key: "other" })); // another sale, same basket, other time
    const sale = srv.commitSale(saleArgs());
    srv.sales.pop(); srv.sales.push(sale); // order irrelevant
    const c = await check(srv);
    // the 07:00 sale has the same amounts + lines -> it is a candidate, so not "recorded" outright
    expect(c.result).toBe("inconclusive");
    expect(c.matches.map((m) => m.saleId)).toEqual([sale.id]);

    const only = new FakeSalesServer();
    const s1 = only.commitSale(saleArgs());
    const c1 = await check(only);
    expect(c1).toMatchObject({ result: "recorded", method: "sale-client-identity", entryDigest: DIGEST, matches: [{ saleId: s1.id, receiptNo: s1.receipt_no }] });
    expect(c1.detail).toContain(s1.receipt_no!);
  });

  it("not recorded: no sale of that shop/shift since ring-up with these amounts and lines", async () => {
    const srv = new FakeSalesServer();
    srv.commitSale(saleArgs({ p_paid_mmk: 2000 })); // same time, different amount -> a candidate (same instant)
    expect((await check(srv)).result).toBe("inconclusive");
    const empty = new FakeSalesServer();
    empty.commitSale(saleArgs({ p_paid_mmk: 2000, p_created_at: "2026-10-16T08:30:00Z" })); // different amount, different time
    empty.commitSale(saleArgs({ p_shop_id: "shop-2" })); // other shop
    const c = await check(empty);
    expect(c.result).toBe("not-recorded");
    expect(c.matches).toEqual([]);
    expect(c.candidates).toEqual([]);
  });

  it("RESPONSE LOST: the server committed, the till never heard back -> the check finds it (recorded), never 'not recorded'", async () => {
    const srv = new FakeSalesServer();
    const committed = srv.commitSale(saleArgs()); // the request that "timed out"
    const c = await check(srv, entry(saleArgs(), { status: "conflict", lastError: "timeout" }));
    expect(c.result).toBe("recorded");
    expect(c.matches[0].saleId).toBe(committed.id);
  });

  it("a replay stamped with server time (> 48 h after ring-up) is a candidate -> inconclusive, never 'not recorded'", async () => {
    const srv = new FakeSalesServer();
    srv.commitSale(saleArgs(), { createdAt: "2026-10-18T10:00:00+00:00" });
    const c = await check(srv);
    expect(c.result).toBe("inconclusive");
    expect(c.candidates).toHaveLength(1);
  });

  it("same instant but other lines -> candidate (inconclusive), not absence", async () => {
    const srv = new FakeSalesServer();
    srv.commitSale(saleArgs({ p_items: [{ product_id: "p9", qty: 1, units_per_item: 1 }] }));
    const c = await check(srv);
    expect(c.result).toBe("inconclusive");
    expect(c.candidates).toHaveLength(1);
  });

  it("the shift: a known shift narrows the search; an offline shift resolves through the id map; unresolved = shop-wide", async () => {
    const srv = new FakeSalesServer();
    const s = srv.commitSale(saleArgs({ p_shift_id: "shift-real" }));
    const prov = entry(saleArgs({ p_shift_id: "shift-prov" }), { refs: [{ field: "p_shift_id", provisionalId: "shift-prov" }] });
    expect((await check(srv, prov, (id) => (id === "shift-prov" ? "shift-real" : null))).matches[0].saleId).toBe(s.id);
    expect((await check(srv, prov, () => "shift-other")).result).toBe("not-recorded");
    const shopWide = await check(srv, prov, noRefs);
    expect(shopWide.result).toBe("recorded");
    expect(shopWide.detail).toContain("shift not known");
  });

  it("two exact matches -> inconclusive; a read error -> inconclusive (nothing assumed)", async () => {
    const srv = new FakeSalesServer();
    srv.commitSale(saleArgs());
    srv.commitSale(saleArgs());
    expect(await check(srv)).toMatchObject({ result: "inconclusive" });
    const down = new FakeSalesServer();
    down.failReads = true;
    const c = await check(down);
    expect(c.result).toBe("inconclusive");
    expect(c.detail).toMatch(/could not be read/);
  });

  it("not a sale (or a malformed one) -> inconclusive, method unsupported, no read at all", async () => {
    const srv = new FakeSalesServer();
    const c = await check(srv, entry(saleArgs(), { name: "adjust_stock" }));
    expect(c).toMatchObject({ result: "inconclusive", method: "unsupported" });
    expect(srv.reads).toBe(0);
    expect(saleIdentity({ kind: "rpc", name: "complete_sale", args: { p_shop_id: "s" } }, noRefs)).toMatch(/no lines/);
    expect(lineSignature([{ productId: "b", baseQty: 1 }, { productId: "a", baseQty: 2 }])).toBe("a|2;b|1");
  });

  it("supabaseSaleReader issues SELECTs on sales / sale_items only (no rpc, insert, update, upsert, delete)", async () => {
    const ops: string[] = [];
    const builder = (table: string): unknown => {
      const b: Record<string, unknown> = {};
      for (const m of ["eq", "gte", "lte", "in", "order", "limit"]) b[m] = (...a: unknown[]) => { ops.push(`${table}.${m}(${String(a[0])})`); return b; };
      b.then = (res: (v: unknown) => void) => res({ data: [], error: null });
      return b;
    };
    const client = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === "from") return (table: string) => ({
          select: (cols: string) => { ops.push(`${table}.select(${cols})`); return builder(table); },
          insert: () => { throw new Error("insert"); }, update: () => { throw new Error("update"); },
          upsert: () => { throw new Error("upsert"); }, delete: () => { throw new Error("delete"); },
        });
        throw new Error(`unexpected client.${String(prop)}`);
      },
    }) as unknown as SelectOnlyClient;
    const r = supabaseSaleReader(client);
    await check(r as unknown as FakeSalesServer);
    await r.saleById("x");
    await r.saleByReceipt("shop-1", "R-1");
    expect(ops.filter((o) => o.includes(".select(")).length).toBeGreaterThanOrEqual(3);
    expect(ops.every((o) => /^(sales|sale_items)\.(select|eq|gte|lte|in|order|limit)\(/.test(o))).toBe(true);
  });
});

describe("verifyRecreatedSale", () => {
  it("accepts the new sale (by receipt or id) in the entry's shop, rung up after the entry was queued", async () => {
    const srv = new FakeSalesServer();
    const old = srv.commitSale(saleArgs({ p_created_at: "2026-10-15T08:00:00Z" }));
    const other = srv.commitSale(saleArgs({ p_shop_id: "shop-2", p_created_at: "2026-10-16T10:00:00Z" }));
    const fresh = srv.commitSale(saleArgs({ p_created_at: "2026-10-16T10:00:00Z" }));
    const base = { shopId: "shop-1", queuedAt: "2026-10-16T08:00:00Z", exclude: [] as string[] };
    expect(await verifyRecreatedSale(srv, { ...base, saleIdOrReceipt: fresh.receipt_no! })).toMatchObject({ ok: true, sale: { saleId: fresh.id } });
    expect(await verifyRecreatedSale(srv, { ...base, saleIdOrReceipt: fresh.id })).toMatchObject({ ok: true });
    expect(await verifyRecreatedSale(srv, { ...base, saleIdOrReceipt: old.id })).toMatchObject({ ok: false });
    expect(await verifyRecreatedSale(srv, { ...base, saleIdOrReceipt: other.id })).toMatchObject({ ok: false, message: expect.stringMatching(/another shop/) });
    expect(await verifyRecreatedSale(srv, { ...base, saleIdOrReceipt: fresh.id, exclude: [fresh.id] })).toMatchObject({ ok: false, message: expect.stringMatching(/matched/) });
    expect(await verifyRecreatedSale(srv, { ...base, saleIdOrReceipt: "R-9999" })).toMatchObject({ ok: false });
    expect(await verifyRecreatedSale(srv, { ...base, saleIdOrReceipt: " " })).toMatchObject({ ok: false });
  });
});
