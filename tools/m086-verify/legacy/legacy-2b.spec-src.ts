// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Batch 2B, Phase 3 — REAL money-RPC integration (isolated copy only).
// The server RPCs of the disposable LOOPBACK stack at migration 085, called
// through PostgREST with real GoTrue sessions. Every scenario is judged on
// the PostgreSQL tables (before/after snapshot), never on HTTP alone.
// Skipped unless B2B_P3=1.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAuthUser, randomPassword, signedInClient } from "./liveHelpers";
import { runSql, runSqlFile } from "../../e2e/helpers/db";
import { buildQaState, liveCfg, type QaState } from "../../e2e/helpers/env";

const enabled = process.env.B2B_P3 === "1";
const uuid = () => randomUUID();

type Status = "PASS" | "FAIL" | "N/A" | "NOT TESTED" | "OBSERVED";
interface Result { rpc: string; scenario: string; status: Status; detail: string }
const results: Result[] = [];
const record = (rpc: string, scenario: string, status: Status, detail: string) => {
  results.push({ rpc, scenario, status, detail });
  console.log(`[p3] ${status.padEnd(10)} ${rpc} ${scenario} — ${detail}`);
};

// ---- tenants ------------------------------------------------------------------
interface Tenant { st: QaState; pw: string; admin: SupabaseClient; mgr: SupabaseClient; cashA: SupabaseClient; cashB: SupabaseClient }
async function seedTenant(ts: string): Promise<Tenant> {
  const cfg = liveCfg();
  const pw = randomPassword();
  const st0 = buildQaState(ts, { admin: "", mgr: "", cashA: "", cashB: "" });
  const authIds = {
    admin: await createAuthUser(cfg, st0.emails.admin, pw),
    mgr: await createAuthUser(cfg, st0.emails.mgr, pw),
    cashA: await createAuthUser(cfg, st0.emails.cashA, pw),
    cashB: await createAuthUser(cfg, st0.emails.cashB, pw),
  };
  runSqlFile("supabase/tests/phase-d/live/seed.sql", { ts, auth_admin: authIds.admin, auth_mgr: authIds.mgr, auth_casha: authIds.cashA, auth_cashb: authIds.cashB });
  runSqlFile("supabase/tests/phase-e/live/seed_extra.sql", { ts });
  const st = buildQaState(ts, authIds);
  return {
    st, pw,
    admin: await signedInClient(cfg, st.emails.admin, pw),
    mgr: await signedInClient(cfg, st.emails.mgr, pw),
    cashA: await signedInClient(cfg, st.emails.cashA, pw),
    cashB: await signedInClient(cfg, st.emails.cashB, pw),
  };
}

// ---- database snapshot (PostgreSQL, the disposable stack) -------------------------
type Snap = Record<string, number> & { inv_rows?: any };
function snap(org: string): Snap {
  const sql = `
select json_build_object(
 'sales',        (select count(*) from sales s join shops h on h.id=s.shop_id where h.org_id=:'org'),
 'sales_voided', (select count(*) from sales s join shops h on h.id=s.shop_id where h.org_id=:'org' and s.status<>'NORMAL'),
 'sales_total',  (select coalesce(sum(total_mmk),0) from sales s join shops h on h.id=s.shop_id where h.org_id=:'org' and s.status='NORMAL'),
 'movements',    (select count(*) from inventory_movements m join shops h on h.id=m.shop_id where h.org_id=:'org'),
 'mv_sum',       (select coalesce(sum(qty_change),0) from inventory_movements m join shops h on h.id=m.shop_id where h.org_id=:'org'),
 'inv',          (select coalesce(sum(qty_base_units),0) from inventory i join shops h on h.id=i.shop_id where h.org_id=:'org'),
 'pos',          (select count(*) from purchase_orders p join shops h on h.id=p.shop_id where h.org_id=:'org'),
 'po_paid',      (select coalesce(sum(paid_mmk),0) from purchase_orders p join shops h on h.id=p.shop_id where h.org_id=:'org'),
 'payments',     (select count(*) from supplier_payments sp join shops h on h.id=sp.shop_id where h.org_id=:'org'),
 'paid_sum',     (select coalesce(sum(amount_mmk),0) from supplier_payments sp join shops h on h.id=sp.shop_id where h.org_id=:'org' and voided_at is null),
 'transfers',    (select count(*) from stock_transfers t join shops h on h.id=t.from_shop_id where h.org_id=:'org'),
 'transfer_items',(select count(*) from stock_transfer_items ti join stock_transfers t on t.id=ti.transfer_id join shops h on h.id=t.from_shop_id where h.org_id=:'org'),
 'rvr',          (select count(*) from refund_void_requests r join shops h on h.id=r.shop_id where h.org_id=:'org'),
 'rvr_approved', (select count(*) from refund_void_requests r join shops h on h.id=r.shop_id where h.org_id=:'org' and r.status='APPROVED'),
 'rvr_rejected', (select count(*) from refund_void_requests r join shops h on h.id=r.shop_id where h.org_id=:'org' and r.status='REJECTED'),
 'keys',         (select count(*) from idempotency_keys where org_id=:'org')
);`;
  return JSON.parse(runSql(sql, { org }).trim());
}
const delta = (a: Snap, b: Snap): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of Object.keys(b)) if (typeof b[k] === "number" && b[k] !== a[k]) out[k] = b[k] - a[k];
  return out;
};
const keyRow = (key: string) => {
  const out = runSql(`select coalesce(json_agg(json_build_object('rpc',rpc,'org',org_id,'actor',actor_id,'has_response',response is not null)),'[]') from idempotency_keys where key=:'k'`, { k: key }).trim();
  return JSON.parse(out) as any[];
};

// ---- calls --------------------------------------------------------------------------
async function call(c: SupabaseClient, rpc: string, args: Record<string, unknown>) {
  const res = await c.rpc(rpc, args);
  return { data: res.data as any, error: res.error as any, status: res.status };
}
async function rawCall(token: string, rpc: string, args: Record<string, unknown>) {
  const cfg = liveCfg();
  const res = await fetch(`${cfg.url}/rest/v1/rpc/${rpc}`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.text() };
}
const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
function signJwt(payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", process.env.B2B_JWT_SECRET ?? "").update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

// ---- the matrix -------------------------------------------------------------------------
interface Op {
  rpc: string;
  actor: () => SupabaseClient;
  /** Base arguments of a FRESH logical operation (creates its preconditions). */
  prepare: () => Promise<Record<string, unknown>>;
  /** A business change of the same operation (for "same key, changed arguments"). */
  change: (a: Record<string, unknown>) => Record<string, unknown>;
  /** Expected table changes for ONE execution (keys:+1 is checked separately). */
  effect: Record<string, number>;
  /** New key, identical arguments: a new effect, or a definitive refusal. */
  repeat: "new-effect" | "refused";
  stamped?: { otherActor: () => string };
  unprivileged?: () => SupabaseClient;
  foreign: () => SupabaseClient;           // a user of ANOTHER organization
  insufficient?: () => Promise<Record<string, unknown>>;
  insufficientNote?: string;
  /** The server permits it by design for this actor (recorded as OBSERVED). */
  insufficientAllowedBy?: string;
}

let A: Tenant;
let B: Tenant;
let shiftA = "";
let shiftB = "";
const org = () => A.st.ids.org;

async function check(rpc: string, scenario: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    if (detail !== "__observed__") record(rpc, scenario, "PASS", detail);
  } catch (err) {
    record(rpc, scenario, "FAIL", err instanceof Error ? err.message.split("\n")[0] : String(err));
  }
}
const expectEffect = (d: Record<string, number>, effect: Record<string, number>, keys: number) => {
  const want = { ...effect, ...(keys ? { keys } : {}) };
  for (const [k, v] of Object.entries(want)) expect(d[k] ?? 0, `${k}`).toBe(v);
  for (const k of Object.keys(d)) if (!(k in want)) expect(d[k], `unexpected change in ${k}`).toBe(0);
};
const expectNoEffect = (d: Record<string, number>) => expect(d).toEqual({});

async function runMatrix(op: Op) {
  const { rpc } = op;
  // A — successful first execution
  await check(rpc, "A first execution", async () => {
    const base = await op.prepare();
    const s0 = snap(org());
    const k = uuid();
    const r = await call(op.actor(), rpc, { ...base, p_idempotency_key: k });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const d = delta(s0, snap(org()));
    expectEffect(d, op.effect, 1);
    expect(keyRow(k)).toEqual([expect.objectContaining({ rpc, org: org(), has_response: true })]);
    return `effect ${JSON.stringify(d)}; 1 key row with stored response`;
  });

  // B/C/D — commit with the response lost; retry same key; same key changed
  const base = await op.prepare();
  const kB = uuid();
  const frozen = Object.freeze({ ...base, p_idempotency_key: kB });
  let original: any = null;
  await check(rpc, "B commit, response lost", async () => {
    const s0 = snap(org());
    original = (await call(op.actor(), rpc, frozen)).data;          // the reply is discarded by the "client"
    const d = delta(s0, snap(org()));
    expectEffect(d, op.effect, 1);
    return `server committed once: ${JSON.stringify(d)}`;
  });
  await check(rpc, "C retry original key + frozen args", async () => {
    const s0 = snap(org());
    const r = await call(op.actor(), rpc, frozen);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.data).toEqual(original);
    expectNoEffect(delta(s0, snap(org())));
    return "replayed the stored original result; no table changed";
  });
  await check(rpc, "D same key, changed args", async () => {
    const s0 = snap(org());
    const r = await call(op.actor(), rpc, op.change({ ...frozen }));
    expect(r.error?.message ?? "").toMatch(/IDEMPOTENCY_MISMATCH/);
    expectNoEffect(delta(s0, snap(org())));
    return `refused: ${r.error.message.slice(0, 60)}; no table changed`;
  });
  // E — new logical operation with identical arguments, different key
  await check(rpc, "E identical args, NEW key", async () => {
    const s0 = snap(org());
    const r = await call(op.actor(), rpc, { ...base, p_idempotency_key: uuid() });
    const d = delta(s0, snap(org()));
    if (op.repeat === "new-effect") {
      expect(r.error, JSON.stringify(r.error)).toBeNull();
      expectEffect(d, op.effect, 1);
      return `a second, separate effect: ${JSON.stringify(d)}`;
    }
    expect(r.error).not.toBeNull();
    expectNoEffect(d);
    return `refused (the operation already happened): ${r.error.message.slice(0, 70)}; no table changed`;
  });

  // F — concurrent same-key submissions; G — restart (new session) between attempts
  const baseF = await op.prepare();
  const kF = uuid();
  const argsF = { ...baseF, p_idempotency_key: kF };
  await check(rpc, "F 6 concurrent same-key submissions", async () => {
    const s0 = snap(org());
    const rs = await Promise.all(Array.from({ length: 6 }, () => call(op.actor(), rpc, argsF)));
    const ok = rs.filter((r) => !r.error);
    const d = delta(s0, snap(org()));
    expectEffect(d, op.effect, 1);
    expect(ok.length).toBe(6);
    for (const r of ok) expect(r.data).toEqual(ok[0].data);
    return `6/6 answered with the same result; exactly one effect ${JSON.stringify(d)}`;
  });
  await check(rpc, "G restart (new sign-in session) then retry", async () => {
    const cfg = liveCfg();
    const who = op.actor() === A.mgr ? A.st.emails.mgr : op.actor() === A.admin ? A.st.emails.admin : op.actor() === A.cashB ? A.st.emails.cashB : A.st.emails.cashA;
    const fresh = await signedInClient(cfg, who, A.pw);
    const s0 = snap(org());
    const r = await call(fresh, rpc, argsF);
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expectNoEffect(delta(s0, snap(org())));
    return "new session, same key: replayed; no table changed";
  });

  // H — wrong organization / actor / permission
  await check(rpc, "H other organization (its own key)", async () => {
    const base2 = await op.prepare();
    const s0 = snap(org());
    const s0b = snap(B.st.ids.org);
    const r = await call(op.foreign(), rpc, { ...base2, p_idempotency_key: uuid() });
    expect(r.error).not.toBeNull();
    expectNoEffect(delta(s0, snap(org())));
    expectNoEffect(delta(s0b, snap(B.st.ids.org)));
    return `refused: ${r.error.message.slice(0, 60)}; neither org changed`;
  });
  await check(rpc, "H other organization replaying THIS org's key", async () => {
    const s0 = snap(org());
    const r = await call(op.foreign(), rpc, argsF);
    expect(r.error?.message ?? "").toMatch(/IDEMPOTENCY_MISMATCH|not found|not permitted|Not authenticated|shift/i);
    expect(r.data).toBeNull();                                         // no stored result leaked
    expectNoEffect(delta(s0, snap(org())));
    return `refused, nothing leaked: ${r.error.message.slice(0, 60)}`;
  });
  if (op.stamped) {
    await check(rpc, "H wrong actor (p_expected_actor_id)", async () => {
      const base2 = await op.prepare();
      const s0 = snap(org());
      const r = await call(op.actor(), rpc, { ...base2, p_expected_actor_id: op.stamped!.otherActor(), p_idempotency_key: uuid() });
      expect(r.error).not.toBeNull();
      expectNoEffect(delta(s0, snap(org())));
      return `refused: ${r.error.message.slice(0, 60)}`;
    });
  } else {
    record(rpc, "H wrong actor (p_expected_actor_id)", "N/A", "the RPC takes no actor argument (the caller is the actor)");
  }
  if (op.unprivileged) {
    await check(rpc, "H actor without permission", async () => {
      const base2 = await op.prepare();
      const s0 = snap(org());
      const r = await call(op.unprivileged!(), rpc, { ...base2, p_idempotency_key: uuid() });
      expect(r.error).not.toBeNull();
      expectNoEffect(delta(s0, snap(org())));
      return `refused: ${r.error.message.slice(0, 60)}`;
    });
  }

  // I — invalid / expired / missing authorization
  await check(rpc, "I tampered, expired and missing JWT", async () => {
    const base2 = await op.prepare();
    const s0 = snap(org());
    const session = (await op.actor().auth.getSession()).data.session!;
    const tampered = session.access_token.slice(0, -4) + (session.access_token.endsWith("AAAA") ? "BBBB" : "AAAA");
    const now = Math.floor(Date.now() / 1000);
    const expired = signJwt({ aud: "authenticated", role: "authenticated", sub: session.user.id, iat: now - 7200, exp: now - 3600 });
    const out: string[] = [];
    for (const [label, token] of [["tampered", tampered], ["expired", expired], ["anon only", liveCfg().anonKey]] as const) {
      const r = await rawCall(token, rpc, { ...base2, p_idempotency_key: uuid() });
      expect(r.status, `${label} → ${r.body.slice(0, 80)}`).toBeGreaterThanOrEqual(400);
      out.push(`${label}:${r.status}`);
    }
    expectNoEffect(delta(s0, snap(org())));
    return `${out.join(" ")}; no table changed`;
  });

  // J — insufficient stock
  if (op.insufficient) {
    await check(rpc, "J insufficient stock", async () => {
      const a = await op.insufficient!();
      const s0 = snap(org());
      const r = await call(op.actor(), rpc, { ...a, p_idempotency_key: uuid() });
      const d = delta(s0, snap(org()));
      if (r.error) {
        expectNoEffect(d);
        return `refused: ${r.error.message.slice(0, 70)}; no table changed`;
      }
      if (op.insufficientAllowedBy) {
        record(rpc, "J insufficient stock", "OBSERVED", `ACCEPTED by design (${op.insufficientAllowedBy}): ${JSON.stringify(d)}`);
        return "__observed__";
      }
      throw new Error(`ACCEPTED (${JSON.stringify(d)}) — ${op.insufficientNote ?? ""}`);
    });
  } else {
    record(rpc, "J insufficient stock", "N/A", op.insufficientNote ?? "the operation does not take stock");
  }
}

describe.skipIf(!enabled)("Batch 2B Phase 3 — real money RPCs (disposable 085)", () => {
  beforeAll(async () => {
    const t = Date.now();
    A = await seedTenant(String(t));
    B = await seedTenant(String(t + 1));
    const os = async (c: SupabaseClient, shop: string, actor: string) =>
      (await call(c, "open_shift", { p_shop_id: shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: actor, p_idempotency_key: uuid() })).data.shift.id;
    shiftA = await os(A.cashA, A.st.ids.shop, A.st.ids.cashA);
    shiftB = await os(B.cashA, B.st.ids.shop, B.st.ids.cashA);
    void shiftB;
    // An outstanding supplier balance in org A: create (admin) → approve (manager) → receive (manager).
    for (let i = 0; i < 2; i += 1) {
      const po = await call(A.admin, "create_purchase_order", {
        p_shop_id: A.st.ids.shop, p_supplier_id: A.st.ids.sup, p_notes: "b2b setup",
        p_items: [{ product_id: A.st.ids.prod2, ordered_qty: 50, unit_cost_mmk: 2000 }], p_idempotency_key: uuid(),
      });
      const id = po.data.purchaseOrder.id;
      await call(A.mgr, "approve_purchase_order", { p_purchase_order_id: id, p_idempotency_key: uuid() });
      await call(A.mgr, "receive_purchase_order", { p_purchase_order_id: id, p_received_items: null, p_created_at: null, p_expected_actor_id: A.st.ids.mgr, p_idempotency_key: uuid() });
    }
  }, 120_000);

  afterAll(() => {
    writeFileSync(process.env.B2B_EVIDENCE ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    const tally = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    console.log(`[p3] TALLY ${JSON.stringify(tally)}`);
  });

  const saleArgs = (shop: string, shift: string, product: string, qty: number) => ({
    p_shop_id: shop, p_shift_id: shift, p_payment_method: "CASH", p_paid_mmk: 1_000_000, p_cart_discount_pct: 0,
    p_items: [{ product_id: product, qty, units_per_item: 1 }], p_created_at: new Date().toISOString(),
  });
  // A NORMAL sale of `qty` in org A, for the refund / void operations.
  const newSale = async (qty: number) => (await call(A.cashA, "complete_sale", { ...saleArgs(A.st.ids.shop, shiftA, A.st.ids.prod1, qty), p_idempotency_key: uuid() })).data.sale.id as string;
  const newRequest = async (type: "VOID" | "PARTIAL") => {
    const saleId = await newSale(2);
    const r = await call(A.cashA, "create_refund_void_request", {
      p_sale_id: saleId, p_type: type, p_reason: "b2b", p_created_at: null, p_expected_actor_id: A.st.ids.cashA,
      p_items: type === "PARTIAL" ? [{ productId: A.st.ids.prod1, qtyUnits: 1, amountMmk: 1000 }] : null, p_idempotency_key: uuid(),
    });
    if (r.error) throw new Error(`setup request: ${r.error.message}`);
    return r.data.request.id as string;
  };

  it("complete_sale", async () => {
    await runMatrix({
      rpc: "complete_sale", actor: () => A.cashA, foreign: () => B.cashA, unprivileged: () => A.cashB,
      prepare: async () => saleArgs(A.st.ids.shop, shiftA, A.st.ids.prod1, 1),
      change: (a) => ({ ...a, p_items: [{ product_id: A.st.ids.prod1, qty: 2, units_per_item: 1 }] }),
      effect: { sales: 1, movements: 1, mv_sum: -1, inv: -1, sales_total: 1000 }, repeat: "new-effect",
      insufficient: async () => saleArgs(A.st.ids.shop, shiftA, A.st.ids.prod1, 100_000),
    });
  }, 300_000);

  it("adjust_stock", async () => {
    await runMatrix({
      rpc: "adjust_stock", actor: () => A.mgr, foreign: () => B.mgr, unprivileged: () => A.cashA,
      stamped: { otherActor: () => A.st.ids.cashA },
      prepare: async () => ({
        p_shop_id: A.st.ids.shop, p_product_id: A.st.ids.prod3, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: -1,
        p_reason: "b2b count", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.st.ids.mgr,
      }),
      change: (a) => ({ ...a, p_quantity_delta: -2 }),
      effect: { movements: 1, mv_sum: -1, inv: -1 }, repeat: "new-effect",
      insufficient: async () => ({
        p_shop_id: A.st.ids.shop, p_product_id: A.st.ids.prod3, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: -100_000,
        p_reason: "b2b below zero", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.st.ids.mgr,
      }),
      insufficientNote: "a manager adjustment below zero",
      insufficientAllowedBy: "MANAGER/ADMIN hold pos:override_stock by default; the offline client path refuses it",
    });
  }, 300_000);

  it("create_purchase_order", async () => {
    await runMatrix({
      rpc: "create_purchase_order", actor: () => A.admin, foreign: () => B.admin, unprivileged: () => A.cashA,
      prepare: async () => ({ p_shop_id: A.st.ids.shop, p_supplier_id: A.st.ids.sup, p_notes: "b2b", p_items: [{ product_id: A.st.ids.prod3, ordered_qty: 1, unit_cost_mmk: 100 }] }),
      change: (a) => ({ ...a, p_notes: "b2b changed" }),
      effect: { pos: 1 }, repeat: "new-effect", insufficientNote: "a purchase order adds stock only on receipt",
    });
  }, 300_000);

  it("pay_supplier_lump_sum", async () => {
    await runMatrix({
      rpc: "pay_supplier_lump_sum", actor: () => A.admin, foreign: () => B.admin, unprivileged: () => A.cashA,
      prepare: async () => ({ p_supplier_id: A.st.ids.sup, p_shop_id: A.st.ids.shop, p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null }),
      change: (a) => ({ ...a, p_amount_mmk: 2000 }),
      effect: { payments: 1, paid_sum: 1000, po_paid: 1000 }, repeat: "new-effect", insufficientNote: "a payment takes no stock (overpayment checked below)",
    });
    await check("pay_supplier_lump_sum", "J' payment above the outstanding balance", async () => {
      const s0 = snap(org());
      const r = await call(A.admin, "pay_supplier_lump_sum", { p_supplier_id: A.st.ids.sup, p_shop_id: A.st.ids.shop, p_amount_mmk: 10_000_000, p_payment_method: "CASH", p_reference_no: null, p_notes: null, p_idempotency_key: uuid() });
      expect(r.error).not.toBeNull();
      expectNoEffect(delta(s0, snap(org())));
      return `refused: ${r.error.message.slice(0, 70)}; no table changed`;
    });
  }, 300_000);

  it("create_stock_transfer", async () => {
    await runMatrix({
      rpc: "create_stock_transfer", actor: () => A.mgr, foreign: () => B.mgr, unprivileged: () => A.cashA,
      prepare: async () => ({ p_from_shop_id: A.st.ids.shop, p_to_shop_id: A.st.ids.shop2, p_notes: "b2b", p_items: [{ product_id: A.st.ids.prod1, requested_qty: 1, product_unit_id: null, selected_unit_quantity: null }] }),
      change: (a) => ({ ...a, p_items: [{ product_id: A.st.ids.prod1, requested_qty: 2, product_unit_id: null, selected_unit_quantity: null }] }),
      effect: { transfers: 1, transfer_items: 1 }, repeat: "new-effect",
      insufficient: async () => ({ p_from_shop_id: A.st.ids.shop, p_to_shop_id: A.st.ids.shop2, p_notes: "b2b", p_items: [{ product_id: A.st.ids.prod1, requested_qty: 100_000, product_unit_id: null, selected_unit_quantity: null }] }),
      insufficientNote: "a transfer request above the source stock",
    });
  }, 300_000);

  it("create_refund_void_request", async () => {
    await runMatrix({
      rpc: "create_refund_void_request", actor: () => A.cashA, foreign: () => B.cashA,
      stamped: { otherActor: () => A.st.ids.cashB },
      prepare: async () => ({ p_sale_id: await newSale(1), p_type: "VOID", p_reason: "b2b", p_items: null, p_created_at: null, p_expected_actor_id: A.st.ids.cashA }),
      change: (a) => ({ ...a, p_reason: "b2b changed" }),
      effect: { rvr: 1 }, repeat: "refused", insufficientNote: "a request moves no stock until approved",
    });
  }, 300_000);

  it("approve_void_request", async () => {
    await runMatrix({
      rpc: "approve_void_request", actor: () => A.mgr, foreign: () => B.mgr, unprivileged: () => A.cashA,
      prepare: async () => ({ p_request_id: await newRequest("VOID") }),
      change: (a) => ({ ...a, p_request_id: "qa-not-this-request" }),
      effect: { sales_voided: 1, rvr_approved: 1, movements: 1, mv_sum: 2, inv: 2, sales_total: -2000 }, repeat: "refused",
      insufficientNote: "a void returns stock",
    });
  }, 300_000);

  it("approve_refund_request", async () => {
    await runMatrix({
      rpc: "approve_refund_request", actor: () => A.mgr, foreign: () => B.mgr, unprivileged: () => A.cashA,
      prepare: async () => ({ p_request_id: await newRequest("PARTIAL") }),
      change: (a) => ({ ...a, p_request_id: "qa-not-this-request" }),
      // Server semantics (085): approving a PARTIAL refund marks the whole sale REFUNDED.
      effect: { rvr_approved: 1, movements: 1, mv_sum: 1, inv: 1, sales_voided: 1, sales_total: -2000 }, repeat: "refused",
      insufficientNote: "a refund returns stock",
    });
  }, 300_000);

  it("reject_refund_void_request", async () => {
    await runMatrix({
      rpc: "reject_refund_void_request", actor: () => A.mgr, foreign: () => B.mgr, unprivileged: () => A.cashA,
      prepare: async () => ({ p_request_id: await newRequest("VOID"), p_reason: "b2b no" }),
      change: (a) => ({ ...a, p_reason: "b2b changed" }),
      effect: { rvr_rejected: 1 }, repeat: "refused", insufficientNote: "a rejection moves no stock",
    });
  }, 300_000);

  it("no FAIL recorded", () => {
    const failed = results.filter((r) => r.status === "FAIL");
    expect(failed.map((f) => `${f.rpc} ${f.scenario}: ${f.detail}`)).toEqual([]);
  });
});
