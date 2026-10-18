// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// MIGRATION 086 — SQL financial-safety corrections (after 19fe67a), judged in
// PostgreSQL on the disposable loopback stack:
//   FS  cross-organisation fence squat: an organisation must never claim
//       (fence) another organisation's operation key — the ledger identity is
//       per organisation (org_id, key), the organisation from the session;
//   LS  concurrent pay_supplier_lump_sum: never silently records less than
//       the amount entered (purchase orders locked before the balance is
//       computed; an explicit refusal and a full rollback otherwise).
// Expectations are the CORRECTED behaviour: against the 086 committed in
// 19fe67a the FS squat tests and the LS concurrency tests fail (reproduction).
// Deterministic interleavings: a barrier session holds the purchase-order
// row locks while the payments queue behind it. Skipped unless M086_LIVE=1.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createAuthUser, randomPassword, signedInClient } from "./liveHelpers";
import { runSql, runSqlFile } from "../../e2e/helpers/db";
import { buildQaState, liveCfg } from "../../e2e/helpers/env";
import { Psql, parsed, execSql, v7, lit, jlit, sql1, delay } from "./p086-lib";

const enabled = process.env.M086_LIVE === "1";
if (enabled && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("M086_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run tools/m086-verify/run.sh)");
}
const MIGRATION = process.env.M086_MIGRATION ?? "";
const results: { id: string; title: string; status: string; detail: unknown }[] = [];
function T(id: string, title: string, fn: () => Promise<any>, timeout = 180_000) {
  it(`${id} ${title}`, async () => {
    try {
      const d = await fn();
      results.push({ id, title, status: "PASS", detail: d ?? "" });
      console.log(`[m086sql] PASS ${id}`);
    } catch (e: any) {
      results.push({ id, title, status: "FAIL", detail: String(e?.stack ?? e).slice(0, 2000) });
      console.log(`[m086sql] FAIL ${id}: ${String(e?.message ?? e).slice(0, 500)}`);
      throw e;
    }
  }, timeout);
}

type Who = "admin" | "mgr" | "cashA" | "cashB";
type Tenant = { st: ReturnType<typeof buildQaState>; c: Record<Who, any>; auth: Record<Who, string> };

describe.skipIf(!enabled)("086 SQL corrections: fence squat and lump-sum shortfall", () => {
  const cfg = enabled ? liveCfg() : (null as any);
  const pw = randomPassword();
  let A: Tenant, B: Tenant;

  const X = (t: Tenant, who: Who, key: string, rpc: string, args: any, actor: string | null = t.st.ids[who]): Promise<any> =>
    Promise.resolve(t.c[who].rpc("op_execute", { p_key: key, p_rpc: rpc, p_args: args, p_actor_id: actor }));
  const S = (t: Tenant, who: Who, key: string, rpc: string, fence = false, actor: string | null = null, args: any = null): Promise<any> =>
    Promise.resolve(t.c[who].rpc("op_status", { p_key: key, p_rpc: rpc, p_fence: fence, p_expected_actor_id: actor, p_args: args }));
  const direct = (t: Tenant, who: Who, rpc: string, args: any, key: string = randomUUID()) =>
    Promise.resolve(t.c[who].rpc(rpc, { ...args, p_idempotency_key: key }));
  const rows = (key: string) => sql1(`SELECT coalesce(string_agg(org_id || '=' || state, ',' ORDER BY org_id), '<none>') FROM public.idempotency_keys WHERE key = ${lit(key)}::uuid`);
  const movements = (t: Tenant) => Number(sql1(`SELECT count(*) FROM inventory_movements WHERE shop_id IN (SELECT id FROM shops WHERE org_id = ${lit(t.st.ids.org)})`));
  const adjust = (t: Tenant, delta = 1) => ({
    p_shop_id: t.st.ids.shop, p_product_id: t.st.ids.prod1, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: delta, p_reason: "m086-sql",
    p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: t.st.ids.mgr,
  });
  const as = async (authId: string) => (await new Psql().as(authId));
  const waitLockWaiters = async (n: number, ps: Promise<any>[] = []) => {
    let settled: any;
    for (const p of ps) p.then((v) => { settled = settled ?? v ?? "settled"; }, (e) => { settled = settled ?? `rejected: ${e}`; });
    for (let i = 0; i < 600; i++) {
      if (Number(sql1("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'")) >= n) return;
      if (settled !== undefined) throw new Error(`a request finished instead of waiting: ${JSON.stringify(settled).slice(0, 300)}`);
      await delay(25);
    }
    throw new Error("the requests never queued behind the barrier");
  };

  async function tenant(ts: string): Promise<Tenant> {
    const st0 = buildQaState(ts, { admin: "", mgr: "", cashA: "", cashB: "" });
    const auth = {
      admin: await createAuthUser(cfg, st0.emails.admin, pw), mgr: await createAuthUser(cfg, st0.emails.mgr, pw),
      cashA: await createAuthUser(cfg, st0.emails.cashA, pw), cashB: await createAuthUser(cfg, st0.emails.cashB, pw),
    };
    runSqlFile("supabase/tests/phase-d/live/seed.sql", { ts, auth_admin: auth.admin, auth_mgr: auth.mgr, auth_casha: auth.cashA, auth_cashb: auth.cashB });
    const st = buildQaState(ts, auth);
    const c = {
      admin: await signedInClient(cfg, st.emails.admin, pw), mgr: await signedInClient(cfg, st.emails.mgr, pw),
      cashA: await signedInClient(cfg, st.emails.cashA, pw), cashB: await signedInClient(cfg, st.emails.cashB, pw),
    };
    return { st, c, auth };
  }

  // ---- supplier-payment fixtures: a fresh supplier with received POs ----
  let supSeq = 0;
  async function supplierWithPos(t: Tenant, totals: number[]): Promise<{ sup: string; pos: string[] }> {
    const code = `SQL${Date.now()}${++supSeq}`;
    const sup = await direct(t, "admin", "create_supplier", { p_code: code, p_name: `m086-sql ${code}`, p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null });
    if (sup.error) throw new Error(`create_supplier: ${sup.error.message}`);
    const supId = sup.data.supplier?.id ?? sup.data.id;
    const pos: string[] = [];
    for (const total of totals) pos.push(await addPo(t, supId, total));
    return { sup: supId, pos };
  }
  async function addPo(t: Tenant, supId: string, total: number): Promise<string> {
    const po = await direct(t, "admin", "create_purchase_order", { p_shop_id: t.st.ids.shop, p_supplier_id: supId, p_notes: "m086-sql", p_items: [{ product_id: t.st.ids.prod2, ordered_qty: total / 1000, unit_cost_mmk: 1000 }] });
    if (po.error) throw new Error(`create_purchase_order: ${po.error.message}`);
    const poId = po.data.purchaseOrder.id;
    const ap = await direct(t, "mgr", "approve_purchase_order", { p_purchase_order_id: poId });
    if (ap.error) throw new Error(`approve: ${ap.error.message}`);
    const rc = await direct(t, "mgr", "receive_purchase_order", { p_purchase_order_id: poId, p_received_items: null, p_created_at: null, p_expected_actor_id: t.st.ids.mgr });
    if (rc.error) throw new Error(`receive: ${rc.error.message}`);
    await delay(5);                                                  // distinct created_at: deterministic allocation order
    return poId;
  }
  const payArgs = (t: Tenant, sup: string, amount: number) => ({ p_supplier_id: sup, p_shop_id: t.st.ids.shop, p_amount_mmk: amount, p_payment_method: "CASH", p_reference_no: null, p_notes: null });
  const payState = (sup: string) => JSON.parse(sql1(`SELECT json_build_object(
      'rows', (SELECT count(*) FROM supplier_payments WHERE supplier_id = ${lit(sup)}),
      'paidRows', (SELECT coalesce(sum(amount_mmk), 0) FROM supplier_payments WHERE supplier_id = ${lit(sup)} AND voided_at IS NULL),
      'paidPos', (SELECT coalesce(sum(paid_mmk), 0) FROM purchase_orders WHERE supplier_id = ${lit(sup)}),
      'amounts', (SELECT coalesce(json_agg(amount_mmk ORDER BY amount_mmk), '[]') FROM supplier_payments WHERE supplier_id = ${lit(sup)}))::text`));
  /** A barrier: holds every purchase-order row of the supplier FOR UPDATE until released. */
  const barrier = async (sup: string) => {
    const s = new Psql();
    await s.q(`BEGIN; SELECT id FROM purchase_orders WHERE supplier_id = ${lit(sup)} ORDER BY created_at, id FOR UPDATE;`);
    return { release: () => s.q("COMMIT;").then(() => s.close()) };
  };
  const lumpSql = (t: Tenant, sup: string, amount: number, key: string) =>
    `SELECT public.pay_supplier_lump_sum(p_supplier_id=>${lit(sup)}, p_shop_id=>${lit(t.st.ids.shop)}, p_amount_mmk=>${amount}, p_payment_method=>'CASH', p_idempotency_key=>${lit(key)}::uuid);`;
  const execPaySql = (t: Tenant, sup: string, amount: number, key: string) => execSql(key, "pay_supplier_lump_sum", payArgs(t, sup, amount));
  const SHORT = /Payment amount exceeds total outstanding balance/;

  beforeAll(async () => {
    const ts = String(Date.now());
    A = await tenant(ts);
    B = await tenant(String(Number(ts) + 11));
    if (sql1("SELECT to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NULL") === "t") {
      runSql(`BEGIN;\n${readFileSync(MIGRATION, "utf8")}\nCOMMIT;`);
    }
    for (let i = 0; i < 80; i++) {                                   // PostgREST sees the executor
      const r = await S(A, "admin", v7(), "adjust_stock");
      if (!r.error) break;
      await delay(250);
    }
  }, 300_000);
  afterAll(() => {
    writeFileSync(process.env.P086_EVIDENCE ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), migration: MIGRATION, results }, null, 2));
  });

  // ============================ FENCE SQUAT ==============================
  const squat = (label: string, args: (t: Tenant) => any) =>
    T(`FS.${label.split(" ")[0]}`, `${label}: B fences a key A minted but never delivered — A's operation still runs, exactly once; nothing in B`, async () => {
      const k = v7();
      const a0 = movements(A); const b0 = movements(B);
      const fence = (await S(B, "admin", k, "adjust_stock", true, B.st.ids.admin, args(B))).data;
      const a = await X(A, "mgr", k, "adjust_stock", adjust(A));
      expect(a.error).toBeNull();
      expect(a.data).toMatchObject({ outcome: "committed", replayed: false });
      expect(movements(A)).toBe(a0 + 1);
      expect(movements(B)).toBe(b0);
      // B's fence decided only B's own namespace; A's row is A's
      expect(rows(k)).toBe([`${A.st.ids.org}=committed`, ...(fence?.fenced ? [`${B.st.ids.org}=abandoned`] : [])].sort().join(","));
      // A's own lookups never see B's row
      expect((await S(A, "mgr", k, "adjust_stock")).data).toMatchObject({ status: "committed" });
      return { bFence: fence, aExecution: a.data.outcome, ledger: rows(k) };
    });
  squat("1 no arguments", () => null);
  squat("2 empty arguments", () => ({}));
  squat("3 B's own rows as arguments", (t) => adjust(t));

  T("FS.4", "the same key used independently by two organisations: two operations, each answered only in its own organisation; no reply crosses", async () => {
    const k = v7();
    const ra = await X(A, "mgr", k, "adjust_stock", adjust(A));
    const rb = await X(B, "mgr", k, "adjust_stock", adjust(B, 2));
    expect(ra.data).toMatchObject({ outcome: "committed", replayed: false });
    expect(rb.data).toMatchObject({ outcome: "committed", replayed: false });
    expect(rows(k)).toBe([`${A.st.ids.org}=committed`, `${B.st.ids.org}=committed`].sort().join(","));
    // each replay returns its OWN organisation's reply
    const reA = await X(A, "mgr", k, "adjust_stock", adjust(A));
    const reB = await X(B, "mgr", k, "adjust_stock", adjust(B, 2));
    expect(reA.data).toMatchObject({ outcome: "committed", replayed: true });
    expect(reB.data).toMatchObject({ outcome: "committed", replayed: true });
    // each organisation's reply was stored on ITS row (idem_finish per organisation)
    expect(reA.data.response).toEqual(ra.data.response);
    expect(reB.data.response).toEqual(rb.data.response);
    expect(JSON.stringify(reA.data.response)).toContain(A.st.ids.shop);
    expect(JSON.stringify(reB.data.response)).toContain(B.st.ids.shop);
    expect(JSON.stringify(reA.data.response)).not.toContain(B.st.ids.shop);
    expect(JSON.stringify(reB.data.response)).not.toContain(A.st.ids.shop);
    return { ledger: rows(k) };
  });

  T("FS.5", "no information crosses organisations: B's lookup of A's committed key says nothing about it; B replaying A's key with A's arguments runs nothing in A and returns no A data", async () => {
    const k = v7();
    expect((await X(A, "mgr", k, "adjust_stock", adjust(A))).data.outcome).toBe("committed");
    const look = (await S(B, "admin", k, "adjust_stock")).data;
    expect(look).toMatchObject({ status: "not_found" });               // as if never seen (no state, actor or time)
    expect(look.response ?? null).toBeNull();
    const a0 = movements(A);
    const steal = await X(B, "admin", k, "adjust_stock", adjust(A));
    expect(movements(A)).toBe(a0);
    expect(JSON.stringify(steal.data ?? steal.error ?? {})).not.toContain(A.st.ids.shop);
    expect(steal.data?.outcome === "committed" && steal.data?.replayed === true).toBe(false);
    expect(rows(k).split(",").find((r) => r.startsWith(A.st.ids.org))).toBe(`${A.st.ids.org}=committed`);
    return { bLookup: look, bReplayOfA: steal.error ? `${steal.error.code} ${steal.error.message}`.slice(0, 120) : steal.data };
  });

  T("FS.6", "one organisation, different actors: one key = one operation; another actor's replay never re-executes (reply withheld) and different arguments are a mismatch", async () => {
    const k = v7();
    const a0 = movements(A);
    expect((await X(A, "mgr", k, "adjust_stock", adjust(A))).data.outcome).toBe("committed");
    const peer = (await X(A, "cashB", k, "adjust_stock", adjust(A))).data;
    expect(peer).toMatchObject({ outcome: "committed", replayed: true, withheld: true, response: null });
    const conflicting = (await X(A, "admin", k, "adjust_stock", adjust(A, 5))).data;
    expect(conflicting).toEqual({ outcome: "mismatch" });
    expect(movements(A)).toBe(a0 + 1);
    expect(rows(k)).toBe(`${A.st.ids.org}=committed`);
    return { peer, conflicting };
  });

  T("FS.7", "concurrent first claims of one key in one organisation: exactly one execution; the other is answered from the ledger", async () => {
    const k = v7();
    const a0 = movements(A);
    const hold = new Psql();
    await hold.q(`BEGIN; SELECT 1 FROM inventory WHERE shop_id=${lit(A.st.ids.shop)} AND product_id=${lit(A.st.ids.prod1)} FOR UPDATE;`);
    const s1 = await as(A.auth.mgr); const s2 = await as(A.auth.mgr);
    const p1 = s1.q(execSql(k, "adjust_stock", adjust(A)));
    await waitLockWaiters(1, [p1]);
    const p2 = s2.q(execSql(k, "adjust_stock", adjust(A)));
    await waitLockWaiters(2, [p2]);
    await hold.q("COMMIT;"); hold.close();
    const [r1, r2] = [parsed(await p1), parsed(await p2)];
    s1.close(); s2.close();
    const outs = [r1.data?.outcome, r2.data?.outcome].sort();
    expect(outs).toEqual(["committed", "committed"]);
    expect([r1.data?.replayed, r2.data?.replayed].sort()).toEqual([false, true]);
    expect(movements(A)).toBe(a0 + 1);
    expect(rows(k)).toBe(`${A.st.ids.org}=committed`);
    return { r1: r1.data, r2: r2.data };
  });

  T("FS.8", "concurrent claims of one key by two organisations: both run, independently (no cross-organisation wait or refusal)", async () => {
    const k = v7();
    const a0 = movements(A); const b0 = movements(B);
    // A's per-organisation lock is HELD while B executes the same key: B never waits on it
    const hold = new Psql();
    await hold.q(`BEGIN; SELECT pg_advisory_xact_lock(hashtext('idem:' || ${lit(A.st.ids.org)} || ':' || ${lit(k)}));`);
    const t0 = Date.now();
    const rb = await X(B, "mgr", k, "adjust_stock", adjust(B));
    const bMs = Date.now() - t0;
    await hold.q("COMMIT;"); hold.close();
    expect(rb.data?.outcome).toBe("committed");
    expect(bMs).toBeLessThan(10_000);
    const ra = await X(A, "mgr", k, "adjust_stock", adjust(A));
    expect(ra.data?.outcome).toBe("committed");
    expect(movements(A)).toBe(a0 + 1);
    expect(movements(B)).toBe(b0 + 1);
    expect(rows(k)).toBe([`${A.st.ids.org}=committed`, `${B.st.ids.org}=committed`].sort().join(","));
    return { ledger: rows(k), bWhileALockedMs: bMs };
  });

  T("FS.9", "rejected and abandoned outcomes are per organisation: A's refusal / A's own fence never decide B's use of the same key", async () => {
    const kr = v7();
    // a definitive refusal: a damage write-off must reduce stock (+1 is refused)
    const damage = { ...adjust(A), p_adjustment_type: "DAMAGE", p_quantity_delta: 1 };
    const rej = (await X(A, "mgr", kr, "adjust_stock", damage)).data;
    expect(rej.outcome).toBe("rejected");
    expect((await X(A, "mgr", kr, "adjust_stock", damage)).data).toMatchObject({ outcome: "rejected", replayed: true });
    expect((await X(B, "mgr", kr, "adjust_stock", adjust(B))).data).toMatchObject({ outcome: "committed", replayed: false });
    const ka = v7();
    expect((await S(A, "mgr", ka, "adjust_stock", true, A.st.ids.mgr, adjust(A))).data).toMatchObject({ status: "abandoned", fenced: true });
    expect((await X(A, "mgr", ka, "adjust_stock", adjust(A))).data).toMatchObject({ outcome: "abandoned" });
    expect((await X(B, "mgr", ka, "adjust_stock", adjust(B))).data).toMatchObject({ outcome: "committed" });
    return { rejected: rows(kr), abandoned: rows(ka) };
  });

  T("FS.10", "legacy UUIDv4 keys on the direct path: replay in their own organisation; another organisation's use of the same key is its own operation; a pre-074 row with no organisation still refuses the key everywhere", async () => {
    const k4 = randomUUID();
    const r1 = await direct(A, "mgr", "adjust_stock", adjust(A), k4);
    expect(r1.error).toBeNull();
    const a1 = movements(A);
    const r2 = await direct(A, "mgr", "adjust_stock", adjust(A), k4);       // replay
    expect(r2.error).toBeNull();
    expect(movements(A)).toBe(a1);
    const r3 = await direct(A, "mgr", "adjust_stock", adjust(A, 3), k4);    // changed arguments
    expect(r3.error?.message ?? "").toMatch(/^IDEMPOTENCY_MISMATCH/);
    const b0 = movements(B);
    const rb = await direct(B, "mgr", "adjust_stock", adjust(B), k4);
    expect(rb.error).toBeNull();
    expect(movements(B)).toBe(b0 + 1);
    expect(JSON.stringify(rb.data)).not.toContain(A.st.ids.org);
    // a pre-074 row whose organisation was never recorded (simulated)
    const ku = randomUUID();
    runSql(`INSERT INTO public.idempotency_keys (key, rpc, actor_id, org_id, request_hash, response)
            SELECT ${lit(ku)}::uuid, 'adjust_stock', NULL, ${sql1("SELECT to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='idempotency_keys_pkey' AND array_length(conkey,1)=2)") === "t" ? "'!unattributed'" : "NULL"}, 'h', '{}'::jsonb;`);
    try {
      const a2 = movements(A);
      const ru = await direct(A, "mgr", "adjust_stock", adjust(A), ku);
      expect(ru.error?.message ?? "").toMatch(/^IDEMPOTENCY_MISMATCH/);
      expect(movements(A)).toBe(a2);
      // the executor and the status lookup refuse it as well (one fixed answer)
      expect((await X(A, "mgr", ku, "adjust_stock", adjust(A))).data).toEqual({ outcome: "mismatch" });
      expect((await S(A, "mgr", ku, "adjust_stock")).data).toEqual({ status: "unavailable" });
      expect((await S(B, "admin", ku, "adjust_stock", true, B.st.ids.admin, null)).data).toEqual({ status: "unavailable" });
      expect(movements(A)).toBe(a2);
      const xu = await X(A, "mgr", v7(), "adjust_stock", adjust(A));        // (a fresh v7 key is unaffected)
      expect(xu.data?.outcome).toBe("committed");
    } finally {
      runSql(`DELETE FROM public.idempotency_keys WHERE key = ${lit(ku)}::uuid AND actor_id IS NULL;`);   // the simulated row has no QA actor: remove it here
    }
    // UUIDv7 never through the direct path (unchanged)
    const r7 = await direct(A, "mgr", "adjust_stock", adjust(A), v7());
    expect(r7.error?.message ?? "").toMatch(/^OP_EXECUTOR_REQUIRED/);
    return { v4: rows(k4), unattributed: "refused (IDEMPOTENCY_MISMATCH)", v7Direct: "OP_EXECUTOR_REQUIRED" };
  });

  // ========================= LUMP-SUM SHORTFALL ==========================
  T("LS.1", "two simultaneous payments against ONE purchase order (3000 due; 2000 + 2000, two users, different keys): one applies in full, the other is REFUSED — never a silent 1000", async () => {
    const { sup, pos } = await supplierWithPos(A, [3000]);
    const gate = await barrier(sup);
    const s1 = await as(A.auth.mgr); const s2 = await as(A.auth.admin);
    const p1 = s1.q(lumpSql(A, sup, 2000, randomUUID()));
    const k1exec = v7();
    const p2 = s2.q(execPaySql(A, sup, 2000, k1exec));
    await waitLockWaiters(2, [p1, p2]);
    await gate.release();
    const [r1, r2] = [parsed(await p1), parsed(await p2)];
    s1.close(); s2.close();
    const st = payState(sup);
    const refused = [r1.error?.message ?? "", r2.data?.message ?? r2.error?.message ?? ""].filter((m) => SHORT.test(m)).length;
    expect(st).toMatchObject({ rows: 1, paidRows: 2000, paidPos: 2000, amounts: [2000] });
    expect(refused).toBe(1);
    if (r2.data?.outcome === "rejected") expect(rows(k1exec)).toBe(`${A.st.ids.org}=rejected`);   // the executor's refusal is recorded
    expect(sql1(`SELECT paid_mmk FROM purchase_orders WHERE id = ${lit(pos[0])}`)).toBe("2000");
    return { state: st, direct: r1.error?.message ?? "applied", executor: r2.data?.outcome ?? r2.error?.message };
  });

  T("LS.2", "two simultaneous payments spanning TWO purchase orders (1000 + 2000 due; 2000 + 2000): one applies in full across both, the other is refused; no partial rows", async () => {
    const { sup, pos } = await supplierWithPos(A, [1000, 2000]);
    const gate = await barrier(sup);
    const s1 = await as(A.auth.mgr); const s2 = await as(A.auth.admin);
    const p1 = s1.q(lumpSql(A, sup, 2000, randomUUID()));
    const p2 = s2.q(lumpSql(A, sup, 2000, randomUUID()));
    await waitLockWaiters(2, [p1, p2]);
    await gate.release();
    const [r1, r2] = [parsed(await p1), parsed(await p2)];
    s1.close(); s2.close();
    const st = payState(sup);
    expect(st).toMatchObject({ paidRows: 2000, paidPos: 2000 });
    expect([r1.error?.message ?? "ok", r2.error?.message ?? "ok"].filter((m) => SHORT.test(m))).toHaveLength(1);
    expect(sql1(`SELECT string_agg(paid_mmk::text, ',' ORDER BY created_at) FROM purchase_orders WHERE id IN (${pos.map(lit).join(",")})`)).toBe("1000,1000");
    return { state: st };
  });

  T("LS.3", "two organisations paying at the same time: B's payment is not delayed or reduced by A's contention", async () => {
    const a = await supplierWithPos(A, [3000]);
    const b = await supplierWithPos(B, [3000]);
    const gate = await barrier(a.sup);
    const sa = await as(A.auth.mgr);
    const pa = sa.q(lumpSql(A, a.sup, 2000, randomUUID()));
    await waitLockWaiters(1, [pa]);
    const rb = await direct(B, "mgr", "pay_supplier_lump_sum", payArgs(B, b.sup, 2500));
    expect(rb.error).toBeNull();
    expect(payState(b.sup)).toMatchObject({ rows: 1, paidRows: 2500, paidPos: 2500 });
    await gate.release();
    expect(parsed(await pa).error).toBeUndefined();
    sa.close();
    expect(payState(a.sup)).toMatchObject({ rows: 1, paidRows: 2000, paidPos: 2000 });
    return { a: payState(a.sup), b: payState(b.sup) };
  });

  T("LS.4", "insufficient balance (sequential): refused before anything is written", async () => {
    const { sup } = await supplierWithPos(A, [1000]);
    const r = await direct(A, "mgr", "pay_supplier_lump_sum", payArgs(A, sup, 1500));
    expect(r.error?.message ?? "").toMatch(SHORT);
    expect(payState(sup)).toMatchObject({ rows: 0, paidRows: 0, paidPos: 0 });
    return payState(sup);
  });

  T("LS.5", "valid sequential payments across POs apply in full, oldest PO first", async () => {
    const { sup, pos } = await supplierWithPos(A, [1000, 2000]);
    expect((await direct(A, "mgr", "pay_supplier_lump_sum", payArgs(A, sup, 1500))).error).toBeNull();
    expect((await direct(A, "admin", "pay_supplier_lump_sum", payArgs(A, sup, 1500))).error).toBeNull();
    expect(payState(sup)).toMatchObject({ paidRows: 3000, paidPos: 3000 });
    expect(sql1(`SELECT string_agg(paid_mmk::text, ',' ORDER BY created_at) FROM purchase_orders WHERE id IN (${pos.map(lit).join(",")})`)).toBe("1000,2000");
    return payState(sup);
  });

  T("LS.6", "same-key retry through the executor (reply lost): replayed from the ledger, never applied twice", async () => {
    const { sup } = await supplierWithPos(A, [3000]);
    const k = v7();
    const r1 = await X(A, "mgr", k, "pay_supplier_lump_sum", payArgs(A, sup, 1000));
    expect(r1.data).toMatchObject({ outcome: "committed", replayed: false });
    // the reply was lost: the till asks, then resends the same key
    expect((await S(A, "mgr", k, "pay_supplier_lump_sum")).data).toMatchObject({ status: "committed" });
    const r2 = await X(A, "mgr", k, "pay_supplier_lump_sum", payArgs(A, sup, 1000));
    expect(r2.data).toMatchObject({ outcome: "committed", replayed: true });
    expect(payState(sup)).toMatchObject({ rows: 1, paidRows: 1000, paidPos: 1000 });
    expect(rows(k)).toBe(`${A.st.ids.org}=committed`);
    return payState(sup);
  });

  T("LS.7", "a payment refused for the shortfall is RECORDED as rejected (executor): no rows, no paid total; resending the same key later is answered 'rejected' even once the balance would allow it", async () => {
    const { sup } = await supplierWithPos(A, [3000]);
    const gate = await barrier(sup);
    const s1 = await as(A.auth.mgr); const s2 = await as(A.auth.admin);
    const k2 = v7();
    const p1 = s1.q(lumpSql(A, sup, 2500, randomUUID()));
    const p2 = s2.q(execPaySql(A, sup, 1000, k2));
    await waitLockWaiters(2, [p1, p2]);
    await gate.release();
    const [r1, r2] = [parsed(await p1), parsed(await p2)];
    s1.close(); s2.close();
    // whichever ran second was refused; if the executor's was, it is recorded
    const st = payState(sup);
    expect(st.paidRows).toBe(st.paidPos);
    expect([2500, 1000]).toContain(st.paidRows);                       // exactly one applied (2500 + 1000 > 3000)
    expect(st.paidRows).not.toBe(3000);                                // never a silent 500 remainder
    if (r2.data?.outcome === "rejected") {
      expect(rows(k2)).toBe(`${A.st.ids.org}=rejected`);
      // more balance arrives; the same key is still refused, never executed
      await addPo(A, sup, 5000);
      const again = await X(A, "admin", k2, "pay_supplier_lump_sum", payArgs(A, sup, 1000));
      expect(again.data).toMatchObject({ outcome: "rejected", replayed: true });
      expect(payState(sup).paidRows).toBe(st.paidRows);
    }
    return { state: st, direct: r1.error?.message ?? "applied", executor: r2.data?.outcome ?? r2.error?.message };
  });

  T("LS.8", "deterministic locking under contention: three concurrent payments that fit exactly (1000 x 3 on 1000 + 2000) all apply; no deadlock, no shortfall", async () => {
    const { sup } = await supplierWithPos(A, [1000, 2000]);
    const gate = await barrier(sup);
    const ss = [await as(A.auth.mgr), await as(A.auth.admin), await as(A.auth.mgr)];
    const ps = ss.map((s, i) => s.q(i === 1 ? execPaySql(A, sup, 1000, v7()) : lumpSql(A, sup, 1000, randomUUID())));
    await waitLockWaiters(3, ps);
    await gate.release();
    const rs = (await Promise.all(ps)).map(parsed);
    for (const s of ss) s.close();
    expect(rs.map((r) => r.error?.code ?? r.data?.outcome ?? "ok").filter((x) => x === "40P01")).toHaveLength(0);   // no deadlock
    expect(rs.every((r) => !r.error && (r.data?.outcome ?? "committed") === "committed")).toBe(true);
    expect(payState(sup)).toMatchObject({ paidRows: 3000, paidPos: 3000 });
    return payState(sup);
  });

  T("LS.9", "record_supplier_payment (single PO) already checks the balance under the PO's row lock: two simultaneous payments never exceed it and are never reduced", async () => {
    const { sup, pos } = await supplierWithPos(A, [3000]);
    const gate = await barrier(sup);
    const call = (key: string) => `SELECT public.record_supplier_payment(p_purchase_order_id=>${lit(pos[0])}, p_amount_mmk=>2000, p_payment_method=>'CASH', p_expected_actor_id=>NULL, p_idempotency_key=>${lit(key)}::uuid);`;
    const s1 = await as(A.auth.mgr); const s2 = await as(A.auth.admin);
    const p1 = s1.q(call(randomUUID())); const p2 = s2.q(call(randomUUID()));
    await waitLockWaiters(2, [p1, p2]);
    await gate.release();
    const [r1, r2] = [parsed(await p1), parsed(await p2)];
    s1.close(); s2.close();
    expect(payState(sup)).toMatchObject({ rows: 1, paidRows: 2000, paidPos: 2000, amounts: [2000] });
    expect([r1.error?.message ?? "", r2.error?.message ?? ""].filter((m) => /exceeds outstanding balance/.test(m))).toHaveLength(1);
    return payState(sup);
  });

  T("LS.10", "the payment RPC's own organisation guard: B cannot pay A's supplier (with or without the executor)", async () => {
    const { sup } = await supplierWithPos(A, [1000]);
    const kb = v7();
    const r1 = await direct(B, "admin", "pay_supplier_lump_sum", { ...payArgs(B, sup, 500) });
    const r2 = await X(B, "admin", kb, "pay_supplier_lump_sum", { ...payArgs(B, sup, 500) });
    expect(r1.error).toBeTruthy();
    expect(r2.data?.outcome === "committed").toBe(false);
    expect(payState(sup)).toMatchObject({ rows: 0, paidPos: 0 });
    expect(rows(kb).includes(A.st.ids.org)).toBe(false);              // nothing written in A's namespace
    return { direct: r1.error?.message?.slice(0, 80), executor: r2.data ?? r2.error?.message };
  });

  // keep jlit referenced for helpers shared with other suites
  void jlit;
});
