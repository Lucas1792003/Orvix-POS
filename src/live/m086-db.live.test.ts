// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// MIGRATION 086 STAGE 1 -- database integration against the disposable
// loopback stack (schema 085 without held 084, then the candidate migration
// supabase/migrations/086_operation_outcomes.sql applied there only).
// Effects are judged in PostgreSQL. Skipped unless M086_LIVE=1.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createAuthUser, randomPassword, signedInClient, makeClient } from "./liveHelpers";
import { runSql, runSqlFile } from "../../e2e/helpers/db";
import { buildQaState, liveCfg } from "../../e2e/helpers/env";
import {
  Psql, parsed, execSql, statusSql, snapshot, snapDiff, ledgerRow, ledgerRowText, fingerprint, crashBackend,
  v7, lit, jlit, sql1, delay, rand,
} from "./p086-lib";

const enabled = process.env.M086_LIVE === "1";
// These tests apply and roll back migration 086: ONLY the disposable loopback
// stack (tools/m086-verify/run.sh sets both), never a configured real server.
if (enabled && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("M086_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run tools/m086-verify/run.sh)");
}
const MIGRATION = process.env.M086_MIGRATION ?? "";
const results: { task: string; id: string; title: string; status: string; detail: unknown }[] = [];
const keep: Record<string, any> = {};

function T(task: string, id: string, title: string, fn: () => Promise<any>, timeout = 180_000) {
  it(`${id} ${title}`, async () => {
    try {
      const d = await fn();
      const status = d && typeof d === "object" && d.__status ? d.__status : "PASS";
      results.push({ task, id, title, status, detail: d?.__status ? d.detail : d ?? "" });
      console.log(`[p086] ${status} ${id} ${title}`);
    } catch (e: any) {
      results.push({ task, id, title, status: "FAIL", detail: String(e?.stack ?? e).slice(0, 2500) });
      console.log(`[p086] FAIL ${id} ${title}: ${String(e?.message ?? e).slice(0, 600)}`);
      throw e;
    }
  }, timeout);
}
const OBSERVED = (detail: unknown) => ({ __status: "OBSERVED", detail });

type Tenant = { st: ReturnType<typeof buildQaState>; c: Record<"admin" | "mgr" | "cashA" | "cashB", any>; auth: Record<string, string> };

describe.skipIf(!enabled)("086 Stage 1 DB", () => {
  const cfg = enabled ? liveCfg() : (null as any);
  const pw = randomPassword();
  let A: Tenant, B: Tenant;
  let shiftA = "", shiftB = "", poId = "";
  let fp085: { md5: string; lines: number };
  const L: { name: string; who: "admin" | "mgr" | "cashA" | "cashB"; rpc: string; args: any; key: string; response: any }[] = [];
  const hash085: Record<string, string> = {};
  let b2baseline: any;
  let s1baseline: any;

  // Promise.resolve: a postgrest-js builder is a lazy thenable that sends the
  // request again on every .then() -- each call here is sent exactly once.
  // The operation's creator = the caller (as the 086 client sends it) unless a test overrides it.
  const actorOfClient = new Map<any, string>();
  const X = (c: any, key: string, rpc: string, args: any, actor: string | null | undefined = undefined): Promise<any> =>
    Promise.resolve(c.rpc("op_execute", { p_key: key, p_rpc: rpc, p_args: args, p_actor_id: actor === undefined ? actorOfClient.get(c) ?? null : actor }));
  const S = (c: any, key: string, rpc: string, fence: boolean | null = false, actor: string | null = null, args: any = null): Promise<any> =>
    Promise.resolve(c.rpc("op_status", { p_key: key, p_rpc: rpc, p_fence: fence, p_expected_actor_id: actor, p_args: args }));
  const direct = (c: any, rpc: string, args: any, key: string = randomUUID()) =>
    c.rpc(rpc, { ...args, p_idempotency_key: key }).then((r: any) => ({ key, ...r }));
  const saleArgs = (prod: string, qty: number, paid: number, t = A) => ({
    p_shop_id: t.st.ids.shop, p_shift_id: t === A ? shiftA : shiftB, p_payment_method: "CASH", p_paid_mmk: paid,
    p_cart_discount_pct: 0, p_items: [{ product_id: prod, qty, units_per_item: 1 }], p_created_at: new Date().toISOString(),
  });
  const salesCount = (shift = shiftA) => Number(sql1(`SELECT count(*) FROM sales WHERE shift_id = ${lit(shift)}`));
  const inv = (prod: string, shop = A.st.ids.shop) => Number(sql1(`SELECT qty_base_units FROM inventory WHERE shop_id=${lit(shop)} AND product_id=${lit(prod)}`));
  const setPerms = (userId: string, granted: string[] | null) =>
    runSql(`SET ROLE service_role; UPDATE public.users SET granted_permissions = ${granted ? `ARRAY[${granted.map(lit).join(",")}]::text[]` : "NULL"} WHERE id = ${lit(userId)};`);
  const as = async (authId: string) => (await new Psql().as(authId));
  const waitLockWaiters = async (n = 1, p?: Promise<any>) => {
    let settled: any;
    p?.then((v) => { settled = v ?? "settled"; }, (e) => { settled = `rejected: ${e}`; });
    for (let i = 0; i < 400; i++) {
      if (settled !== undefined) throw new Error(`request finished instead of waiting: ${JSON.stringify(settled).slice(0, 400)}`);
      if (Number(sql1("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'")) >= n) return;
      await delay(25);
    }
    throw new Error(`no backend started waiting on the lock; activity: ${sql1("SELECT string_agg(coalesce(wait_event_type,'-')||'/'||state||'/'||left(query,50), ' ; ') FROM pg_stat_activity WHERE datname='postgres' AND state <> 'idle'")}`);
  };
  const holdInventory = async (prod: string) => {
    const s = new Psql();
    await s.q(`BEGIN; SELECT qty_base_units FROM inventory WHERE shop_id=${lit(A.st.ids.shop)} AND product_id=${lit(prod)} FOR UPDATE;`);
    return s;
  };
  const mustOk = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.code} ${r.error.message}`); return r.data; };

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
    for (const who of ["admin", "mgr", "cashA", "cashB"] as const) actorOfClient.set(c[who], st.ids[who]);
    return { st, c, auth };
  }

  beforeAll(async () => {
    // ---- schema 085, no prototype: tenants + REAL 085 ledger entries ----
    const ts = String(Date.now());
    A = await tenant(ts);
    B = await tenant(String(Number(ts) + 7));
    fp085 = fingerprint();
    const push = async (name: string, who: "admin" | "mgr" | "cashA" | "cashB", rpc: string, args: any) => {
      const r = await direct(A.c[who], rpc, args);
      mustOk(r, `085 ${name}`);
      L.push({ name, who, rpc, args, key: r.key, response: r.data });
      return r.data;
    };
    const os = await push("open_shift", "cashA", "open_shift", { p_shop_id: A.st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: A.st.ids.cashA });
    shiftA = os.shift.id;
    await push("complete_sale", "cashA", "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000));
    const po = await push("create_purchase_order", "admin", "create_purchase_order", { p_shop_id: A.st.ids.shop, p_supplier_id: A.st.ids.sup, p_notes: "p086", p_items: [{ product_id: A.st.ids.prod2, ordered_qty: 10, unit_cost_mmk: 1000 }] });
    poId = po.purchaseOrder.id;
    await push("approve_purchase_order", "mgr", "approve_purchase_order", { p_purchase_order_id: poId });
    await push("receive_purchase_order", "mgr", "receive_purchase_order", { p_purchase_order_id: poId, p_received_items: null, p_created_at: null, p_expected_actor_id: A.st.ids.mgr });
    await push("pay_supplier_lump_sum", "admin", "pay_supplier_lump_sum", { p_supplier_id: A.st.ids.sup, p_shop_id: A.st.ids.shop, p_amount_mmk: 3000, p_payment_method: "CASH", p_reference_no: null, p_notes: null });
    for (const prod of [A.st.ids.prod1, A.st.ids.prod3]) {
      await push(`adjust_stock ${prod}`, "mgr", "adjust_stock", { p_shop_id: A.st.ids.shop, p_product_id: prod, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 400, p_reason: "p086 top-up", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.st.ids.mgr });
    }
    // B2 baseline at 085: a refused direct call leaves NO ledger row.
    const before = snapshot(A.st.ids.org);
    const b2 = await direct(A.c.cashA, "complete_sale", saleArgs(A.st.ids.prod2, 150, 300000));
    b2baseline = { error: b2.error && { code: b2.error.code, message: b2.error.message }, ledgerRow: ledgerRowText(b2.key), effects: snapDiff(before, snapshot(A.st.ids.org)) };
    // S1 baseline at 085: a SQL session with TEMP privilege shadows `users`
    // (cashier row with role ADMIN) and runs an ADMIN-only payment. In an
    // explicit transaction, rolled back.
    {
      const s = await as(A.auth.cashA);
      const row = JSON.parse(sql1(`SELECT row_to_json(u)::text FROM public.users u WHERE id = ${lit(A.st.ids.cashA)}`));
      const call = `SELECT (public.pay_supplier_lump_sum(p_supplier_id=>${lit(A.st.ids.sup)}, p_shop_id=>${lit(A.st.ids.shop)}, p_amount_mmk=>1, p_payment_method=>'CASH', p_idempotency_key=>${lit(randomUUID())}))::text IS NOT NULL;`;
      const control = parsed(await s.q(`BEGIN;\n${call}`)); await s.q("ROLLBACK;");
      await s.q("CREATE TEMP TABLE users (LIKE public.users);");
      await s.q(`INSERT INTO pg_temp.users SELECT * FROM json_populate_record(NULL::pg_temp.users, ${lit(JSON.stringify({ ...row, role: "ADMIN" }))}::json);`);
      const escalated = parsed(await s.q(`BEGIN;\n${call}`)); await s.q("ROLLBACK;");
      s.close();
      s1baseline = { control: control.error?.message ?? control.data, withTempUsersAdminRow: escalated.error?.message ?? (escalated.data === "t" ? "COMMITTED (escalated)" : escalated.data) };
    }
    const osb = mustOk(await direct(B.c.cashA, "open_shift", { p_shop_id: B.st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: B.st.ids.cashA }), "B open_shift");
    shiftB = osb.shift.id;
    for (const l of L) hash085[l.key] = sql1(`SELECT request_hash FROM idempotency_keys WHERE key = ${lit(l.key)}::uuid`);
  }, 300_000);

  afterAll(() => {
    writeFileSync(process.env.P086_EVIDENCE ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), b2baseline, s1baseline, results }, null, 2));
    writeFileSync(process.env.P086_STATE ?? "/dev/null", JSON.stringify({
      pw, fp085, A: { st: A?.st }, B: { st: B?.st }, shiftA, keep, L: L.map(({ name, who, rpc, args, key, response }) => ({ name, who, rpc, args, key, response })),
    }, null, 2));
  });

  // ======================================================================
  T("setup", "P0", "085 baseline: real ledger entries; a refused direct call leaves no row (B2 root cause)", async () => {
    expect(L.length).toBe(8);
    expect(b2baseline.error?.code).toBe("P0001");
    expect(b2baseline.ledgerRow).toBe("<none>");
    expect(b2baseline.effects).toEqual([]);
    expect(s1baseline.withTempUsersAdminRow).toBe("COMMITTED (escalated)");
    return { ledgerEntries: L.map((l) => `${l.name} by ${l.who}`), b2baseline, s1baseline, fp085 };
  });

  T("setup", "P1", "migration 086 applies cleanly in ONE transaction (as production: --single-transaction), then again (idempotent)", async () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const t0 = Date.now();
    runSql(`BEGIN;\n${sql}\nCOMMIT;`);
    const firstMs = Date.now() - t0;
    const afterFirst = fingerprint();
    runSql(`BEGIN;\n${sql}\nCOMMIT;`);
    const afterSecond = fingerprint();
    expect(afterSecond).toEqual(afterFirst);
    keep.fp086 = afterSecond;
    for (let i = 0; i < 80; i++) {
      const r = await S(A.c.cashA, randomUUID(), "complete_sale");
      if (!r.error) {
        return {
          firstApplyMs: firstMs, secondApply: "no-op, identical fingerprint", postgrestSees: r.data,
          grants: sql1(`SELECT string_agg(p.proname || ':' || coalesce(p.proacl::text,''), ' ' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('op_execute','op_status','op_dispatch','op_caller','op_purge_responses','prune_idempotency_keys')`),
          hardened: sql1(`SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proconfig = '{"search_path=public, pg_temp"}'`),
          leftWithSearchPathPublic: sql1(`SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proconfig = '{search_path=public}'`),
        };
      }
      await delay(250);
    }
    throw new Error("PostgREST never exposed op_status");
  });

  // ============================ TASK 1 ===================================
  T("1", "1.1", "pre-086 rows: state committed, decided_at = created_at, request_hash unchanged", async () => {
    const rows = L.map((l) => ledgerRow(l.key));
    for (const [i, r] of rows.entries()) {
      expect(r.state).toBe("committed");
      expect(new Date(r.decided_at).getTime()).toBe(new Date(r.created_at).getTime());
      expect(r.request_hash).toBe(hash085[L[i].key]);
      expect(r.response_purged_at).toBeNull();
    }
    return `${rows.length} rows`;
  });

  T("1", "1.2", "the executor computes a byte-identical request hash for every pre-086 row", async () => {
    const out = L.map((l) => `${l.rpc}=${sql1(`SELECT public.op_request_hash(${lit(l.rpc)}, ${jlit(l.args)}) = ${lit(hash085[l.key])}`)}`);
    expect(out.every((s) => s.endsWith("=t"))).toBe(true);
    return out;
  });

  T("1", "1.3", "executor replays each pre-086 row to its own actor: identical response, no effect", async () => {
    const s0 = snapshot(A.st.ids.org);
    const out: string[] = [];
    for (const l of L) {
      const r = await X(A.c[l.who], l.key, l.rpc, l.args);
      const d = mustOk(r, l.name);
      expect(d.outcome).toBe("committed");
      expect(d.replayed).toBe(true);
      expect(d.withheld).toBe(false);
      expect(d.response).toEqual(l.response);
      out.push(`${l.name}: replayed, identical`);
    }
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    return out;
  });

  T("1", "1.4", "same org, other actor: decision visible, response WITHHELD; ADMIN (server role) sees it; MANAGER only with sync:resolve", async () => {
    const sale = L.find((l) => l.name === "complete_sale")!;
    const pay = L.find((l) => l.name === "pay_supplier_lump_sum")!;
    const r1 = mustOk(await X(A.c.cashB, sale.key, sale.rpc, sale.args), "cashB");
    const r2 = mustOk(await X(A.c.mgr, pay.key, pay.rpc, pay.args), "mgr");
    const r3 = mustOk(await S(A.c.cashB, sale.key, sale.rpc), "cashB status");
    const mgrSale = mustOk(await X(A.c.mgr, sale.key, sale.rpc, sale.args), "manager, no grant");
    for (const r of [r1, r2, mgrSale]) { expect(r).toMatchObject({ outcome: "committed", withheld: true, response: null }); }
    expect(r3).toMatchObject({ status: "committed", withheld: true, response: null });
    const r5 = mustOk(await X(A.c.admin, sale.key, sale.rpc, sale.args), "admin (role)");
    expect(r5).toMatchObject({ outcome: "committed", withheld: false });
    expect(r5.response).toEqual(sale.response);
    setPerms(A.st.ids.mgr, ["sync:resolve"]);
    try {
      const r6 = mustOk(await X(A.c.mgr, sale.key, sale.rpc, sale.args), "manager with explicit sync:resolve");
      expect(r6).toMatchObject({ outcome: "committed", withheld: false });
    } finally { setPerms(A.st.ids.mgr, null); }
    return { cashB: "withheld", managerOnAdminsPayment: "withheld", managerWithoutGrant: "withheld", cashBStatus: "committed, withheld",
      adminByRole: "response visible, identical", managerWithExplicitSyncResolve: "visible" };
  });

  T("1", "1.5", "other organization: executor 'mismatch', status 'unavailable', no write", async () => {
    const sale = L.find((l) => l.name === "complete_sale")!;
    const before = ledgerRowText(sale.key);
    const x = mustOk(await X(B.c.cashA, sale.key, sale.rpc, sale.args), "B exec");
    const s = mustOk(await S(B.c.cashA, sale.key, sale.rpc, true, B.st.ids.cashA), "B status+fence");
    expect(x).toEqual({ outcome: "mismatch" });
    expect(s).toEqual({ status: "unavailable" });
    expect(ledgerRowText(sale.key)).toBe(before);
    return { exec: x, statusWithFence: s };
  });

  T("1", "1.6", "changed arguments / other RPC with the same key: mismatch, no write, no effect", async () => {
    const sale = L.find((l) => l.name === "complete_sale")!;
    const s0 = snapshot(A.st.ids.org);
    const before = ledgerRowText(sale.key);
    const a = mustOk(await X(A.c.cashA, sale.key, sale.rpc, { ...sale.args, p_paid_mmk: 6000 }), "changed");
    const b = mustOk(await X(A.c.mgr, sale.key, "adjust_stock", L.find((l) => l.rpc === "adjust_stock")!.args), "other rpc");
    expect(a).toEqual({ outcome: "mismatch" });
    expect(b).toEqual({ outcome: "mismatch" });
    expect(ledgerRowText(sale.key)).toBe(before);
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    return { changedArgs: a, otherRpc: b };
  });

  T("1", "1.7", "LEGACY direct path (stage 1, unchanged idem_begin): same-org other actor still gets the response", async () => {
    const sale = L.find((l) => l.name === "complete_sale")!;
    const r = await direct(A.c.cashB, sale.rpc, sale.args, sale.key);
    const disclosed = !r.error && JSON.stringify(r.data) === JSON.stringify(sale.response);
    return OBSERVED({ cashBDirectReplayOfCashAsKey: disclosed ? "full response returned (085 behaviour)" : r.error, residual: "closed only by stage 2 or an idem_begin actor check" });
  });

  // ============================ TASK 2 ===================================
  T("2", "2.1", "B2: a business refusal through the executor is recorded as REJECTED; no effect survives", async () => {
    const s0 = snapshot(A.st.ids.org);
    const key = v7();
    const args = saleArgs(A.st.ids.prod2, 150, 300000);
    const d = mustOk(await X(A.c.cashA, key, "complete_sale", args), "b2");
    expect(d).toMatchObject({ outcome: "rejected", replayed: false, code: "P0001" });
    const row = ledgerRow(key);
    expect(row).toMatchObject({ state: "rejected", response: null, outcome_code: "P0001", actor_id: A.st.ids.cashA, org_id: A.st.ids.org });
    expect(row.request_hash).toBe(`R:${sql1(`SELECT public.op_request_hash('complete_sale', ${jlit(args)})`)}`);
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    keep.b2 = { key, args, message: d.message };
    return { refusal: d.message, ledger: { state: row.state, hash: row.request_hash.slice(0, 10) + "…" }, effects: "none (all 23 org tables identical)" };
  });

  T("2", "2.2", "lost reply: op_status tells the client it was rejected (code + message)", async () => {
    const d = mustOk(await S(A.c.cashA, keep.b2.key, "complete_sale"), "status");
    expect(d).toMatchObject({ status: "rejected", code: "P0001", message: keep.b2.message, withheld: false });
    return d;
  });

  T("2", "2.3", "restock, then replay: STILL rejected, no sale, no stock change (B2 eliminated)", async () => {
    mustOk(await direct(A.c.mgr, "adjust_stock", { p_shop_id: A.st.ids.shop, p_product_id: A.st.ids.prod2, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 200, p_reason: "p086 restock", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.st.ids.mgr }), "restock");
    const s1 = snapshot(A.st.ids.org);
    const stock = inv(A.st.ids.prod2);
    expect(stock).toBeGreaterThanOrEqual(150);
    const d = mustOk(await X(A.c.cashA, keep.b2.key, "complete_sale", keep.b2.args), "replay");
    expect(d).toMatchObject({ outcome: "rejected", replayed: true, code: "P0001" });
    expect(snapDiff(s1, snapshot(A.st.ids.org))).toEqual([]);
    return { stockAfterRestock: stock, replay: d.outcome, sales: "unchanged" };
  });

  T("2", "2.4", "legacy direct call with the rejected (UUIDv7) key: refused on the legacy path (OP_EXECUTOR_REQUIRED), nothing executes", async () => {
    const s0 = snapshot(A.st.ids.org);
    const r = await direct(A.c.cashA, "complete_sale", keep.b2.args, keep.b2.key);
    expect(r.error?.code).toBe("22023");
    expect(r.error?.message).toMatch(/^OP_EXECUTOR_REQUIRED/);
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    return r.error;
  });

  T("2", "2.5", "control: the same sale under a NEW key succeeds now (the refusal was stock-based)", async () => {
    const n0 = salesCount();
    const d = mustOk(await X(A.c.cashA, v7(), "complete_sale", keep.b2.args), "fresh");
    expect(d.outcome).toBe("committed");
    expect(salesCount()).toBe(n0 + 1);
    return "committed under a new key";
  });

  T("2", "2.6", "permission refusal stays rejected after the permission is granted", async () => {
    const key = v7();
    const args = { p_shop_id: A.st.ids.shop, p_product_id: A.st.ids.prod1, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: -1, p_reason: "p086 perm", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.st.ids.cashA };
    const s0 = snapshot(A.st.ids.org);
    const d1 = mustOk(await X(A.c.cashA, key, "adjust_stock", args), "refused");
    expect(d1.outcome).toBe("rejected");
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    setPerms(A.st.ids.cashA, ["inventory:adjust"]);
    try {
      const s1 = snapshot(A.st.ids.org);
      const d2 = mustOk(await X(A.c.cashA, key, "adjust_stock", args), "replay");
      expect(d2).toMatchObject({ outcome: "rejected", replayed: true });
      expect(snapDiff(s1, snapshot(A.st.ids.org))).toEqual([]);
      const d3 = mustOk(await X(A.c.cashA, v7(), "adjust_stock", args), "fresh");
      expect(d3.outcome).toBe("committed");
      return { refusal: d1.message, afterGrantReplay: d2.outcome, freshKeyAfterGrant: d3.outcome };
    } finally {
      setPerms(A.st.ids.cashA, null);
    }
  });

  T("2", "2.7", "error classification matrix (injected at INSERT INTO sales, nested inside the unchanged RPC)", async () => {
    runSql(`
      CREATE SCHEMA IF NOT EXISTS qa_scaffold;
      CREATE TABLE IF NOT EXISTS qa_scaffold.probe(at timestamptz DEFAULT clock_timestamp(), cu text, su text, uid text, sp text);
      GRANT USAGE ON SCHEMA qa_scaffold TO postgres, authenticated; GRANT ALL ON qa_scaffold.probe TO postgres;
      CREATE OR REPLACE FUNCTION qa_scaffold.inject() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE c text := current_setting('qa.inject_sqlstate', true);
              m text := coalesce(nullif(current_setting('qa.inject_message', true), ''), 'QA injected failure');
              k text := coalesce(nullif(current_setting('qa.inject_constraint', true), ''), '');
      BEGIN
        IF current_setting('qa.probe', true) = 'on' THEN
          INSERT INTO qa_scaffold.probe(cu, su, uid, sp) VALUES (current_user, session_user, auth.uid()::text, current_setting('search_path'));
        END IF;
        IF c IS NOT NULL AND c <> '' AND k <> '' THEN RAISE EXCEPTION USING ERRCODE = c, MESSAGE = m, CONSTRAINT = k; END IF;
        IF c IS NOT NULL AND c <> '' THEN RAISE EXCEPTION USING ERRCODE = c, MESSAGE = m; END IF;
        RETURN NEW;
      END $$;
      GRANT EXECUTE ON FUNCTION qa_scaffold.inject() TO postgres;
      DROP TRIGGER IF EXISTS qa_inject ON public.sales;
      CREATE TRIGGER qa_inject BEFORE INSERT ON public.sales FOR EACH ROW EXECUTE FUNCTION qa_scaffold.inject();`);
    // [sqlstate, message, expected class]: recorded only when definitive.
    const cases: [string, string, string, string?][] = [
      ["P0001", "Insufficient stock for QA: have 0, need 1", "rejected"],
      ["P0001", "You are not permitted to create sales", "rejected"],
      ["42501", "AUTH_ID_READ_ONLY: the login link of a staff profile cannot be set or changed directly", "rejected"],
      ["23505", "duplicate key value violates unique constraint", "rejected", "suppliers_unique_normalized_code_per_org"],
      ["23514", "new row violates check constraint", "rejected", "purchase_orders_paid_mmk_not_over_total"],
      ["42501", "You are not permitted to create sales", "unclassified"],
      ["22012", "division by zero", "unclassified"],
      ["22P02", "invalid input syntax for type integer", "unclassified"],
      ["23514", "new row violates check constraint", "unclassified", "products_name_max_length"],
      ["23505", "duplicate key value violates unique constraint", "unclassified", "sales_shop_receipt_no_unique"],
      ["23502", "null value violates not-null constraint", "unclassified"],
      ["42501", "new row violates row-level security policy", "unclassified"],
      ["P0001", "Shift not found", "dependency"],
      ["P0001", "Transfer cannot be received from status APPROVED", "dependency"],
      ["23503", "insert or update violates foreign key constraint", "dependency"],
      ["23505", "duplicate key value violates unique constraint", "dependency", "shifts_one_open_per_cashier_shop"],
      ["P0001", "Not authenticated", "auth"],
      ["P0001", "This offline action was queued by a different user - reconnect as them", "actor"],
      ["42501", "permission denied for table sales", "internal"],
      ["P0001", "app_require_org: unknown kind x", "internal"],
      ["P0001", "QA injected failure (no audited rule)", "unclassified"],
    ];
    const transient = ["40001", "40P01", "53200", "53300", "55P03", "57014", "57P01", "08006", "42883", "42703", "42P01", "XX000", "P0002", "0A000", "PT429", "PT503"];
    const s = await as(A.auth.cashA);
    const out: string[] = [];
    try {
      for (const [code, message, cls, constraint] of cases) {
        const key = v7();
        const s0 = snapshot(A.st.ids.org);
        const r = parsed(await s.q(`SET qa.inject_sqlstate = '${code}'; SET qa.inject_message = ${lit(message)}; SET qa.inject_constraint = ${lit(constraint ?? "")};\n${execSql(key, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000))}`));
        await s.q("RESET qa.inject_sqlstate; RESET qa.inject_message; RESET qa.inject_constraint;");
        expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
        if (cls === "rejected") {
          expect(r.data).toMatchObject({ outcome: "rejected", code });
          expect(ledgerRow(key)).toMatchObject({ state: "rejected", outcome_code: code });
          const again = parsed(await s.q(execSql(key, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000))));
          expect(again.data).toMatchObject({ outcome: "rejected", replayed: true });
          out.push(`${code} "${message.slice(0, 40)}"${constraint ? ` [${constraint}]` : ""}: REJECTED, recorded, stays rejected`);
        } else {
          expect(r.error?.code).toBe(code);
          expect(ledgerRow(key)).toBeNull();
          const n0 = salesCount();
          const retry = parsed(await s.q(execSql(key, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000))));
          expect(retry.data).toMatchObject({ outcome: "committed", replayed: false });
          expect(salesCount()).toBe(n0 + 1);
          out.push(`${code} "${message.slice(0, 40)}"${constraint ? ` [${constraint}]` : ""}: ${cls} - NOT recorded, re-raised; same-key retry committed once`);
        }
      }
      for (const code of [...transient, "IDEM"]) {
        const key = v7();
        const s0 = snapshot(A.st.ids.org);
        const set = code === "IDEM" ? "SET qa.inject_sqlstate = 'P0001'; SET qa.inject_message = 'IDEMPOTENCY_INJECTED';" : `SET qa.inject_sqlstate = '${code}'; SET qa.inject_message = '';`;
        const r = parsed(await s.q(`${set}\n${execSql(key, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000))}`));
        await s.q("RESET qa.inject_sqlstate; RESET qa.inject_message;");
        const row = ledgerRow(key);
        expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
        if (code === "IDEM") {
          expect(r.data).toEqual({ outcome: "mismatch" });
          expect(row).toBeNull();
          out.push("P0001 'IDEMPOTENCY_…': mismatch, not recorded");
        } else {
          expect(r.error?.code).toBe(code);
          expect(row).toBeNull();
          const n0 = salesCount();
          const retry = parsed(await s.q(execSql(key, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000))));
          expect(retry.data).toMatchObject({ outcome: "committed", replayed: false });
          expect(salesCount()).toBe(n0 + 1);
          out.push(`${code}: propagated, NOT recorded, same-key retry committed once`);
        }
      }
    } finally { s.close(); }
    return out;
  }, 300_000);

  T("2", "2.8", "real temporary errors (lock_timeout, statement_timeout, terminated backend): unresolved, retryable", async () => {
    const out: string[] = [];
    for (const kind of ["lock_timeout", "statement_timeout", "terminate"] as const) {
      const key = v7();
      const args = saleArgs(A.st.ids.prod1, 1, 5000);
      const x = await holdInventory(A.st.ids.prod1);
      const y = await as(A.auth.cashA);
      const s0 = snapshot(A.st.ids.org);
      let r;
      if (kind === "terminate") {
        const pid = await y.pid();
        const p = y.q(execSql(key, "complete_sale", args));
        await waitLockWaiters();
        sql1(`SELECT pg_terminate_backend(${pid})`);
        r = parsed(await p);
      } else {
        r = parsed(await y.q(`SET ${kind} = '400ms';\n${execSql(key, "complete_sale", args)}`));
      }
      expect(r.error).toBeTruthy();
      expect(ledgerRow(key)).toBeNull();
      await x.q("ROLLBACK;"); x.close(); y.close();
      expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
      const n0 = salesCount();
      const d = mustOk(await X(A.c.cashA, key, "complete_sale", args), "retry");
      expect(d).toMatchObject({ outcome: "committed", replayed: false });
      expect(salesCount()).toBe(n0 + 1);
      out.push(`${kind}: ${r.error!.code} — not recorded; retry with the same key committed once`);
    }
    return out;
  });

  T("2", "2.9", "documented allow-list is exactly the handler in the deployed op_execute", async () => {
    const def = sql1("SELECT pg_get_functiondef('public.op_execute'::regproc)");
    const handler = /WHEN raise_exception OR insufficient_privilege OR data_exception OR integrity_constraint_violation THEN/.test(def);
    expect(handler).toBe(true);
    expect((def.match(/\bWHEN [a-z_]+( OR [a-z_]+)* THEN/g) ?? []).filter((w) => /exception|privilege|violation|others/.test(w))).toHaveLength(1);
    expect(def).not.toMatch(/WHEN OTHERS/i);
    return "P0001 · 42501 · class 22 · class 23 (minus IDEMPOTENCY_*); no WHEN OTHERS";
  });

  T("2", "2.10", "audited classification covers EVERY RAISE in the 29 RPCs and the helpers/triggers they reach (none unclassified)", async () => {
    const funcs = JSON.parse(sql1(`
      SELECT json_agg(json_build_object('n', p.proname, 's', p.prosrc)) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT LIKE 'op\\_%' AND p.proname NOT IN ('idem_begin', 'idem_finish')
         AND (p.prosrc ~ 'idem_begin\\(' OR p.oid IN (SELECT tgfoid FROM pg_trigger WHERE NOT tgisinternal)
              OR p.proname ~ '^(app_|enforce_|resolve_event_time|current_app_user|guard_|role_default)')`)) as { n: string; s: string }[];
    const found = new Map<string, { code: string; msg: string }>();
    for (const f of funcs) {
      for (const m of f.s.matchAll(/RAISE\s+EXCEPTION\s+((?:'(?:[^']|'')*'\s*)+)([^;]*);/g)) {
        const msg = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")).join("").replace(/%/g, "X");
        const code = /ERRCODE\s*=\s*'([0-9A-Z]{5})'/.exec(m[2])?.[1] ?? "P0001";
        found.set(`${code}|${msg}`, { code, msg });
      }
    }
    const list = [...found.values()];
    const values = list.map((x) => `(${lit(x.code)}, ${lit(x.msg)})`).join(",");
    const classes = JSON.parse(sql1(`SELECT json_agg(json_build_object('code', c, 'msg', m, 'cls', public.op_classify_refusal(c, m)) ORDER BY m) FROM (VALUES ${values}) v(c, m)`)) as { code: string; msg: string; cls: string }[];
    const tally = classes.reduce((a: Record<string, number>, x) => ({ ...a, [x.cls]: (a[x.cls] ?? 0) + 1 }), {});
    expect(classes.length).toBeGreaterThan(150);
    expect(classes.filter((x) => x.cls === "unclassified")).toEqual([]);
    keep.classification = classes;
    return { functionsScanned: funcs.length, distinctMessages: classes.length, tally };
  });

  T("2", "2.11", "dependency refusal is NOT recorded (re-raised with its reason); the queued prerequisite arrives -> the SAME key executes", async () => {
    // A transfer approved but not yet dispatched: the receipt (queued on the
    // destination till) arrives first.
    const tr = mustOk(await direct(A.c.mgr, "create_stock_transfer", { p_from_shop_id: A.st.ids.shop, p_to_shop_id: A.st.ids.shop2, p_notes: "m086", p_items: [{ product_id: A.st.ids.prod1, requested_qty: 2 }] }), "create transfer");
    const tid = tr.stockTransfer.id;
    mustOk(await direct(A.c.admin, "approve_stock_transfer", { p_transfer_id: tid }), "approve");
    const key = v7();
    const recv = { p_transfer_id: tid, p_received_items: null, p_created_at: null, p_expected_actor_id: A.st.ids.admin };
    const s0 = snapshot(A.st.ids.org);
    const early = await X(A.c.admin, key, "receive_stock_transfer", recv);
    expect(early.error?.code).toBe("P0001");
    expect(early.error?.message).toMatch(/Transfer cannot be received from status/);
    expect(early.error?.hint).toBe("op_not_recorded:dependency");
    expect(ledgerRow(key)).toBeNull();
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    mustOk(await direct(A.c.mgr, "dispatch_stock_transfer", { p_transfer_id: tid, p_created_at: null, p_expected_actor_id: A.st.ids.mgr }), "dispatch");
    const later = mustOk(await X(A.c.admin, key, "receive_stock_transfer", recv), "receive after dispatch");
    expect(later).toMatchObject({ outcome: "committed", replayed: false });
    // a "not found" dependency the same way
    const k2 = v7();
    const nf = await X(A.c.cashA, k2, "complete_sale", { ...saleArgs(A.st.ids.prod1, 1, 5000), p_shift_id: "shift-does-not-exist-yet" });
    expect(nf.error?.hint).toBe("op_not_recorded:dependency");
    expect(ledgerRow(k2)).toBeNull();
    return {
      beforeDispatch: `${early.error.code} ${early.error.message} [hint ${early.error.hint}]; nothing recorded; no effect`,
      afterDispatch: "same key committed", missingShift: `${nf.error.message} [${nf.error.hint}]`,
    };
  });

  // ============================ TASK 3 ===================================
  T("3", "3.1", "never-delivered operation: its own actor fences it (abandoned)", async () => {
    const key = v7();
    const d = mustOk(await S(A.c.cashA, key, "complete_sale", true, A.st.ids.cashA), "fence");
    expect(d).toEqual({ status: "abandoned", fenced: true });
    expect(ledgerRow(key)).toMatchObject({ state: "abandoned", request_hash: "A:", actor_id: A.st.ids.cashA, org_id: A.st.ids.org, outcome_code: "FENCED" });
    keep.fenced = { key, args: saleArgs(A.st.ids.prod1, 1, 5000) };
    return d;
  });

  T("3", "3.2", "C1: the delayed request after the fence cannot execute (executor nor legacy direct)", async () => {
    const s0 = snapshot(A.st.ids.org);
    const x = mustOk(await X(A.c.cashA, keep.fenced.key, "complete_sale", keep.fenced.args), "exec");
    const d = await direct(A.c.cashA, "complete_sale", keep.fenced.args, keep.fenced.key);
    const again = mustOk(await S(A.c.cashA, keep.fenced.key, "complete_sale", true, A.st.ids.cashA), "refence");
    expect(x).toEqual({ outcome: "abandoned", replayed: true });
    expect(d.error?.message).toMatch(/^(OP_EXECUTOR_REQUIRED|IDEMPOTENCY_MISMATCH)/);
    expect(again).toMatchObject({ status: "abandoned" });
    expect(Number(sql1(`SELECT count(*) FROM idempotency_keys WHERE key=${lit(keep.fenced.key)}::uuid`))).toBe(1);
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    return { executor: x, legacyDirect: d.error.message.slice(0, 40), refence: again };
  });

  T("3", "3.3", "fence while the request is executing: 'in_flight', no write; after commit the fence reports committed", async () => {
    const key = v7();
    const args = saleArgs(A.st.ids.prod1, 1, 5000);
    const x = await holdInventory(A.st.ids.prod1);
    const p = X(A.c.cashA, key, "complete_sale", args);
    try { await waitLockWaiters(1, p); } catch (e) { await x.q("ROLLBACK;"); x.close(); throw e; }
    const f1 = mustOk(await S(A.c.cashA, key, "complete_sale", true, A.st.ids.cashA), "fence in flight");
    const l1 = mustOk(await S(A.c.cashA, key, "complete_sale"), "lookup in flight");
    const rowDuring = ledgerRow(key);
    await x.q("COMMIT;"); x.close();
    const ex = mustOk(await p, "exec");
    const f2 = mustOk(await S(A.c.cashA, key, "complete_sale", true, A.st.ids.cashA), "fence after");
    expect(f1).toEqual({ status: "in_flight" });
    expect(l1).toEqual({ status: "in_flight" });
    expect(rowDuring).toBeNull();
    expect(ex).toMatchObject({ outcome: "committed", replayed: false });
    expect(f2).toMatchObject({ status: "committed" });
    expect(f2.response).toEqual(ex.response);
    return { fenceDuring: f1, lookupDuring: l1, execution: "committed", fenceAfter: f2.status };
  });

  T("3", "3.4", "a committed (or rejected) operation cannot be fenced", async () => {
    const sale = L.find((l) => l.name === "complete_sale")!;
    const b1 = ledgerRowText(sale.key), b2 = ledgerRowText(keep.b2.key);
    const f1 = mustOk(await S(A.c.cashA, sale.key, "complete_sale", true, A.st.ids.cashA), "c");
    const f2 = mustOk(await S(A.c.cashA, keep.b2.key, "complete_sale", true, A.st.ids.cashA), "r");
    expect(f1.status).toBe("committed");
    expect(f2.status).toBe("rejected");
    expect(ledgerRowText(sale.key)).toBe(b1);
    expect(ledgerRowText(keep.b2.key)).toBe(b2);
    return { committed: f1.status, rejected: f2.status, rows: "unchanged" };
  });

  T("3", "3.5", "lookups polled during an execution never misreport (monotonic: not_found* in_flight* committed+)", async () => {
    const key = v7();
    const seq: string[] = [];
    seq.push(mustOk(await S(A.c.cashA, key, "complete_sale"), "pre").status);
    const x = await holdInventory(A.st.ids.prod1);
    const p = X(A.c.cashA, key, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000));
    try { await waitLockWaiters(1, p); } catch (e) { await x.q("ROLLBACK;"); x.close(); throw e; }
    for (let i = 0; i < 12; i++) { seq.push(mustOk(await S(A.c.cashA, key, "complete_sale"), "poll").status); await delay(15); }
    const rel = (async () => { await delay(rand(0, 60)); await x.q("COMMIT;"); x.close(); })();
    for (let i = 0; i < 25; i++) { seq.push(mustOk(await S(A.c.cashA, key, "complete_sale"), "poll").status); await delay(5); }
    await rel;
    const ex = mustOk(await p, "exec");
    seq.push(mustOk(await S(A.c.cashA, key, "complete_sale"), "post").status);
    expect(ex.outcome).toBe("committed");
    expect(seq.join(" ")).toMatch(/^(not_found )*(in_flight )*committed( committed)*$/);
    expect(seq).toContain("in_flight");
    return seq.join(" ").replace(/(\w+)( \1)+/g, (m, w) => `${w}×${m.split(" ").length}`);
  });

  T("3", "3.6", "race stress: executor vs fence (40×) and LEGACY direct vs fence (20×), random timing", async () => {
    const tally: Record<string, number> = {};
    for (let i = 0; i < 60; i++) {
      const legacy = i >= 40;
      const key = legacy ? randomUUID() : v7();
      const args = saleArgs(A.st.ids.prod3, 1, 5000);
      const n0 = salesCount();
      const [e, f] = await Promise.all([
        delay(rand(0, 25)).then(() => (legacy ? direct(A.c.cashA, "complete_sale", args, key) : X(A.c.cashA, key, "complete_sale", args))),
        delay(rand(0, 25)).then(() => S(A.c.cashA, key, "complete_sale", true, A.st.ids.cashA)),
      ]);
      const fs = mustOk(f, "fence").status;
      const row = ledgerRow(key);
      const dn = salesCount() - n0;
      const executed = legacy ? !e.error : e.data?.outcome === "committed";
      if (executed) {
        expect(dn).toBe(1); expect(row.state).toBe("committed"); expect(["in_flight", "committed"]).toContain(fs);
        if (!legacy) expect(e.data.replayed).toBe(false);
      } else {
        expect(dn).toBe(0); expect(row.state).toBe("abandoned"); expect(fs).toBe("abandoned");
        if (legacy) expect(e.error.message).toMatch(/^IDEMPOTENCY_MISMATCH/); else expect(e.data).toEqual({ outcome: "abandoned", replayed: true });
      }
      const t = `${legacy ? "legacy" : "executor"}: ${executed ? "executed" : "fenced first"} / fence saw ${fs}`;
      tally[t] = (tally[t] ?? 0) + 1;
    }
    return tally;
  }, 300_000);

  T("3", "3.7", "fence authority: own actor or sync:resolve (same org) only", async () => {
    const k = () => v7();
    const k1 = k(), k2 = k(), k3 = k(), k4 = k(), k5 = k();
    const cashBforA = mustOk(await S(A.c.cashB, k1, "complete_sale", true, A.st.ids.cashA), "cashB for A");
    const cashBnull = mustOk(await S(A.c.cashB, k1, "complete_sale", true, null), "cashB null");
    const mgrForA = mustOk(await S(A.c.mgr, k1, "complete_sale", true, A.st.ids.cashA), "mgr for A");
    expect([cashBforA, cashBnull, mgrForA].every((d) => d.fenced === false && d.reason === "not_authorized")).toBe(true);
    expect(ledgerRow(k1)).toBeNull();
    const adminForA = mustOk(await S(A.c.admin, k2, "complete_sale", true, A.st.ids.cashA), "admin (role)");
    expect(adminForA).toEqual({ status: "abandoned", fenced: true });
    expect(ledgerRow(k2).actor_id).toBe(A.st.ids.cashA);
    const adminForeign = mustOk(await S(A.c.admin, k3, "complete_sale", true, B.st.ids.cashA), "admin foreign actor");
    expect(adminForeign.fenced).toBe(false);
    expect(ledgerRow(k3)).toBeNull();
    const anon = await S(makeClient(cfg, cfg.anonKey), k4, "complete_sale", true, A.st.ids.cashA);
    const svcr = await S(makeClient(cfg, cfg.serviceKey), k4, "complete_sale", true, A.st.ids.cashA);
    expect(anon.error).toBeTruthy(); expect(svcr.error).toBeTruthy();
    expect(ledgerRow(k4)).toBeNull();
    const cashBself = mustOk(await S(A.c.cashB, k5, "complete_sale", true, A.st.ids.cashB), "cashB as self");
    const k6 = v7();
    setPerms(A.st.ids.mgr, ["sync:resolve"]);
    let mgrGranted: any;
    try { mgrGranted = mustOk(await S(A.c.mgr, k6, "complete_sale", true, A.st.ids.cashA), "manager with grant"); } finally { setPerms(A.st.ids.mgr, null); }
    expect(mgrGranted).toEqual({ status: "abandoned", fenced: true });
    const adminNull = mustOk(await S(A.c.admin, v7(), "complete_sale", true, null), "admin, no actor");
    expect(adminNull.fenced).toBe(false);
    return {
      cashB_for_cashA: "not_authorized", cashB_no_actor: "not_authorized", manager_for_cashA_without_grant: "not_authorized",
      admin_by_role: "fenced (actor recorded = cashA)", manager_with_explicit_sync_resolve: "fenced", admin_without_actor: "not_authorized (actor required)",
      admin_for_other_org_actor: "not_authorized",
      anon: anon.error.code, service_role: svcr.error.code,
      residual_cashB_claiming_unknown_key_as_own: cashBself.status,
    };
  });

  T("3", "3.8", "cross-tenant: one fixed answer for every state, no write, no enumeration beyond key possession", async () => {
    setPerms(B.st.ids.admin, ["sync:resolve"]);
    const sale = L.find((l) => l.name === "complete_sale")!;
    const targets = { committed: sale.key, rejected: keep.b2.key, abandoned: keep.fenced.key };
    const before = Object.fromEntries(Object.entries(targets).map(([n, kk]) => [n, ledgerRowText(kk)]));
    const seen: string[] = [];
    for (const who of [B.c.cashA, B.c.admin]) {
      for (const [n, kk] of Object.entries(targets)) {
        for (const fence of [false, true]) {
          const s = mustOk(await S(who, kk, "complete_sale", fence, B.st.ids.cashA), "s");
          expect(s).toEqual({ status: "unavailable" });
          seen.push(`${n}/${fence ? "fence" : "lookup"}=${s.status}`);
        }
        const x = mustOk(await X(who, kk, "complete_sale", sale.args), "x");
        expect(x).toEqual({ outcome: "mismatch" });
      }
    }
    for (const [n, kk] of Object.entries(targets)) expect(ledgerRowText(kk)).toBe(before[n]);
    const own = mustOk(await S(A.c.cashA, sale.key, "adjust_stock"), "own other rpc");
    expect(own).toEqual({ status: "unavailable" });
    const unknown = mustOk(await S(B.c.cashA, v7(), "complete_sale"), "unknown");
    expect(unknown).toMatchObject({ status: "not_found" });
    setPerms(B.st.ids.admin, null);
    return { foreignStates: "committed/rejected/abandoned → identical {status:'unavailable'} / {outcome:'mismatch'}", unknownKey: unknown.status, ownKeyOtherRpc: own.status };
  });

  T("1", "1.8", "old direct RPC calls cannot execute rejected or abandoned keys (both a cashier and the admin)", async () => {
    const s0 = snapshot(A.st.ids.org);
    const out: string[] = [];
    for (const [n, kk] of [["rejected", keep.b2], ["abandoned", keep.fenced]] as const) {
      for (const who of ["cashA", "admin"] as const) {
        const r = await direct(A.c[who], "complete_sale", kk.args, kk.key);
        expect(r.error?.code).toBe("22023");   // UUIDv7 keys: refused on the legacy path before the ledger is even read
        out.push(`${n} key, direct by ${who}: ${r.error.code} ${r.error.message.slice(0, 21)}`);
      }
    }
    // v4 keys (085-era identity) decided by 086 stay refused through their R:/A: prefix
    const v4r = randomUUID();
    mustOk(await X(A.c.cashA, v4r, "complete_sale", saleArgs(A.st.ids.prod2, 1000000, 2000000000)), "v4 rejected");
    const v4a = randomUUID();
    mustOk(await S(A.c.cashA, v4a, "complete_sale", true, A.st.ids.cashA), "v4 fenced");
    for (const [n, k, a] of [["v4 rejected", v4r, saleArgs(A.st.ids.prod2, 1000000, 2000000000)], ["v4 abandoned", v4a, saleArgs(A.st.ids.prod1, 1, 5000)]] as const) {
      const r = await direct(A.c.cashA, "complete_sale", a, k);
      expect(r.error?.code).toBe("23505");
      expect(r.error?.message).toMatch(/^IDEMPOTENCY_MISMATCH/);
      out.push(`${n} key, direct by cashA: ${r.error.code} ${r.error.message.slice(0, 21)}`);
    }
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    return out;
  });

  // ============================ TASK 4 ===================================
  T("4", "4.1", "actor context: anon, service_role, inactive user, auth account without a staff row", async () => {
    const k = v7();
    const args = saleArgs(A.st.ids.prod1, 1, 5000);
    const anon = await X(makeClient(cfg, cfg.anonKey), k, "complete_sale", args);
    const svcr = await X(makeClient(cfg, cfg.serviceKey), k, "complete_sale", args);
    runSql(`UPDATE users SET is_active=false WHERE id=${lit(A.st.ids.cashB)}`);
    const inactive = await X(A.c.cashB, k, "complete_sale", args);
    runSql(`UPDATE users SET is_active=true WHERE id=${lit(A.st.ids.cashB)}`);
    const email = `qa-p086-nostaff-${Date.now()}@qa.invalid`;
    await createAuthUser(cfg, email, pw);
    const ghost = await X(await signedInClient(cfg, email, pw), k, "complete_sale", args);
    for (const r of [anon, svcr, inactive, ghost]) expect(r.error).toBeTruthy();
    expect(inactive.error.message).toBe("OP_NOT_AUTHENTICATED");
    expect(ghost.error.message).toBe("OP_NOT_AUTHENTICATED");
    expect(ledgerRow(k)).toBeNull();
    sql1(`DELETE FROM auth.users WHERE email = ${lit(email)} RETURNING 1`);
    return { anon: `${anon.error.code} ${anon.error.message}`, service_role: `${svcr.error.code} ${svcr.error.message}`, inactive: `${inactive.error.code} ${inactive.error.message}`, noStaffRow: `${ghost.error.code} ${ghost.error.message}`, recorded: "nothing" };
  });

  T("4", "4.2", "org binding: org-B cashier on org-A shop is refused by the RPC ('not found in your organization': not recorded); org A untouched", async () => {
    const sa = snapshot(A.st.ids.org);
    const sb = snapshot(B.st.ids.org);
    const k = v7();
    const d = await X(B.c.cashA, k, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000));
    expect(d.error?.code).toBe("P0001");
    expect(d.error?.message).toMatch(/not found in your organization/);
    expect(d.error?.hint).toBe("op_not_recorded:dependency");
    expect(ledgerRow(k)).toBeNull();
    expect(snapDiff(sa, snapshot(A.st.ids.org))).toEqual([]);
    expect(snapDiff(sb, snapshot(B.st.ids.org))).toEqual([]);
    const fromA = mustOk(await S(A.c.admin, k, "complete_sale"), "A sees?");
    expect(fromA).toMatchObject({ status: "not_found" });
    return { refusal: `${d.error.message} [${d.error.hint}]`, ledger: "nothing recorded", orgA: "unchanged", orgB: "unchanged" };
  });

  T("4", "4.3", "role parity: the executor never grants more than the direct call (same refusal text)", async () => {
    const cases: [keyof Tenant["c"], string, any][] = [
      ["cashA", "pay_supplier_lump_sum", { p_supplier_id: A.st.ids.sup, p_shop_id: A.st.ids.shop, p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: null, p_notes: null }],
      ["cashA", "create_supplier", { p_code: `P86${Date.now()}`, p_name: "p086", p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null }],
      ["cashA", "approve_purchase_order", { p_purchase_order_id: poId }],
      ["cashA", "delete_product", { p_product_id: A.st.ids.prod3 }],
      ["mgr", "create_supplier", { p_code: `P87${Date.now()}`, p_name: "p086", p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null }],
      ["mgr", "update_supplier", { p_id: A.st.ids.sup, p_code: "X", p_name: "X", p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_is_active: null }],
      ["cashB", "void_supplier_payment", { p_payment_id: "nope", p_reason: "x" }],
    ];
    const out: string[] = [];
    for (const [who, rpc, args] of cases) {
      const s0 = snapshot(A.st.ids.org);
      const dr = await direct(A.c[who], rpc, args);
      const key = v7();
      const exr = await X(A.c[who], key, rpc, args);
      expect(dr.error).toBeTruthy();
      const exMessage = exr.data?.message ?? exr.error?.message;
      expect(exr.data?.outcome === "rejected" || exr.error?.hint?.startsWith("op_not_recorded:")).toBe(true);
      expect(exMessage).toBe(dr.error.message);
      expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
      out.push(`${who} ${rpc}: both refused — "${String(exMessage).slice(0, 60)}" (${exr.data ? "recorded" : exr.error.hint})`);
    }
    const ok = mustOk(await X(A.c.admin, v7(), "create_supplier", { p_code: `P88${Date.now()}`, p_name: "p086 ok", p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null }), "admin");
    expect(ok.outcome).toBe("committed");
    out.push("admin create_supplier via executor: committed (positive control)");
    return out;
  });

  T("4", "4.4", "search_path: caller temp tables and shadow schemas cannot redirect the executor", async () => {
    runSql(`
      DROP SCHEMA IF EXISTS qa_evil CASCADE; CREATE SCHEMA qa_evil;
      CREATE TABLE qa_evil.calls(fn text, at timestamptz DEFAULT clock_timestamp());
      GRANT USAGE ON SCHEMA qa_evil TO authenticated, postgres; GRANT INSERT ON qa_evil.calls TO authenticated, postgres;
      CREATE FUNCTION qa_evil.md5(text) RETURNS text LANGUAGE sql AS $$ INSERT INTO qa_evil.calls(fn) VALUES ('md5') RETURNING 'forged' $$;
      CREATE FUNCTION qa_evil.hashtext(text) RETURNS integer LANGUAGE sql AS $$ INSERT INTO qa_evil.calls(fn) VALUES ('hashtext') RETURNING 1 $$;
      CREATE FUNCTION qa_evil.app_has_perm(text) RETURNS boolean LANGUAGE sql AS $$ INSERT INTO qa_evil.calls(fn) VALUES ('app_has_perm') RETURNING true $$;
      CREATE FUNCTION qa_evil.op_arg_text(jsonb, text) RETURNS text LANGUAGE sql AS $$ INSERT INTO qa_evil.calls(fn) VALUES ('op_arg_text') RETURNING 'forged' $$;
      CREATE FUNCTION qa_evil.jsonb_typeof(jsonb) RETURNS text LANGUAGE sql AS $$ INSERT INTO qa_evil.calls(fn) VALUES ('jsonb_typeof') RETURNING 'string' $$;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA qa_evil TO authenticated, postgres;`);
    const s = await as(A.auth.cashA);
    const key = v7();
    const args = saleArgs(A.st.ids.prod1, 1, 5000);
    try {
      const h = sql1(`SELECT public.op_request_hash('complete_sale', ${jlit(args)})`);
      const t1 = await s.q(`CREATE TEMP TABLE idempotency_keys (key uuid, rpc text, actor_id text, request_hash text, response jsonb, created_at timestamptz, org_id text, state text, outcome_code text, outcome_message text, decided_at timestamptz, response_purged_at timestamptz);`);
      const tempAllowed = !/ERROR/.test(t1.err);
      if (tempAllowed) {
        await s.q(`INSERT INTO pg_temp.idempotency_keys (key, rpc, actor_id, org_id, request_hash, response, state, decided_at, created_at)
          VALUES (${lit(key)}, 'complete_sale', ${lit(A.st.ids.cashA)}, ${lit(A.st.ids.org)}, ${lit(h)}, '{"forged":true}', 'committed', now(), now());`);
      }
      await s.q("SET search_path = qa_evil, public, pg_catalog;");
      const r = parsed(await s.q(execSql(key, "complete_sale", args)));
      const calls = sql1("SELECT count(*) FROM qa_evil.calls");
      expect(r.data).toMatchObject({ outcome: "committed", replayed: false });
      expect(r.data.response?.forged).toBeUndefined();
      expect(ledgerRow(key)).toMatchObject({ org_id: A.st.ids.org, actor_id: A.st.ids.cashA, state: "committed" });
      expect(ledgerRow(key).request_hash).toBe(sql1(`SELECT public.op_request_hash('complete_sale', ${jlit(args)})`));
      expect(calls).toBe("0");
      return { tempTablesAllowedForAuthenticated: tempAllowed, forgedTempLedgerRowIgnored: true, shadowSchemaCalls: Number(calls), result: "real execution, real org A ledger row, real hash" };
    } finally { s.close(); }
  });

  T("4", "4.4b", "S1: TEMP-table shadowing of `users` escalated a cashier at 085; refused after 086's search_path hardening", async () => {
    // Reachable only from a SQL session as `authenticated` (TEMP privilege);
    // no PostgREST/API path creates temp tables. Every probe is rolled back.
    const s = await as(A.auth.cashA);
    const s0 = snapshot(A.st.ids.org);
    const row = JSON.parse(sql1(`SELECT row_to_json(u)::text FROM public.users u WHERE id = ${lit(A.st.ids.cashA)}`));
    const args = { p_supplier_id: A.st.ids.sup, p_shop_id: A.st.ids.shop, p_amount_mmk: 1, p_payment_method: "CASH", p_reference_no: null, p_notes: null };
    const f = (r: any) => (r.data ? `${r.data.outcome}${r.data.message ? `: ${r.data.message}` : ""}` : `${r.error?.code} ${r.error?.message}`);
    const probe = async () => {
      const r = parsed(await s.q(`BEGIN;\n${execSql(v7(), "pay_supplier_lump_sum", args)}`));
      await s.q("ROLLBACK;");
      return f(r);
    };
    const HARDEN = "ALTER FUNCTION %s SET search_path = public, pg_temp";
    const RESTORE = "ALTER FUNCTION %s SET search_path TO ''public''";
    void HARDEN; void RESTORE;
    const harden = (on: boolean) => on || runSql(`DO $$ DECLARE f regprocedure; BEGIN
      FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prosecdef
               AND ${on ? "'search_path=public'" : "'search_path=public, pg_temp'"} = ANY(p.proconfig) LOOP
        EXECUTE format('${on ? HARDEN : RESTORE}', f);
      END LOOP; END $$;`);
    try {
      const control = await probe();
      await s.q("CREATE TEMP TABLE users (LIKE public.users);");
      const empty = await probe();
      await s.q(`INSERT INTO pg_temp.users SELECT * FROM json_populate_record(NULL::pg_temp.users, ${lit(JSON.stringify({ ...row, role: "ADMIN" }))}::json);`);
      const escalated = await probe();
      const n = Number(sql1("SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prosecdef AND 'search_path=public' = ANY(p.proconfig)"));
      const hardened = escalated; // 086 already hardened every function: nothing to toggle
      void harden;
      expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
      expect(control).toMatch(/^rejected/);
      expect(escalated).toMatch(/^rejected/);
      expect(empty).toMatch(/^rejected: You are not permitted/);
      expect(n).toBe(0);
      void hardened;
      return {
        at085_beforeMigration: s1baseline,
        after086_cashierControl: control,
        after086_withEmptyTempUsers: empty,
        after086_withTempUsersRowRoleADMIN: escalated,
        functionsLeftWithSearchPathPublic: n,
      };
    } finally { s.close(); }
  });

  T("4", "4.5", "unknown / excluded / malformed RPC names: OP_UNKNOWN_RPC, nothing recorded", async () => {
    const names = ["drop_table", "create_app_user", "idem_begin", "idem_finish", "op_execute", "op_status", "op_dispatch", "prune_idempotency_keys", "Complete_Sale", "complete_sale ", "complete_sale;--", "public.complete_sale", "", "pg_sleep"];
    const out: string[] = [];
    for (const n of names) {
      const k = v7();
      const r = await X(A.c.cashA, k, n, {});
      expect(r.error?.message).toBe("OP_UNKNOWN_RPC");
      expect(ledgerRow(k)).toBeNull();
      out.push(`${JSON.stringify(n)} → ${r.error.code}`);
    }
    return out;
  });

  T("4", "4.6", "unknown / missing / smuggled arguments are refused before execution", async () => {
    const base = saleArgs(A.st.ids.prod1, 1, 5000);
    const { p_items: _drop, ...noItems } = base;
    void _drop;
    const cases: [string, any, RegExp][] = [
      ["key smuggled in p_args", { ...base, p_idempotency_key: randomUUID() }, /^OP_UNKNOWN_ARGUMENT: p_idempotency_key/],
      ["extra argument", { ...base, p_evil: 1 }, /^OP_UNKNOWN_ARGUMENT: p_evil/],
      ["missing required", noItems, /^OP_MISSING_ARGUMENT: p_items/],
      ["args is an array", [base], /^OP_INVALID_ARGUMENTS/],
      ["args is null", null, /^OP_INVALID_ARGUMENTS/],
    ];
    const out: string[] = [];
    const s0 = snapshot(A.st.ids.org);
    for (const [n, a, re] of cases) {
      const k = v7();
      const r = await X(A.c.cashA, k, "complete_sale", a);
      expect(r.error?.message).toMatch(re);
      expect(ledgerRow(k)).toBeNull();
      out.push(`${n}: ${r.error.code} ${r.error.message}`);
    }
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    return out;
  });

  T("4", "4.7", "invalid argument types are refused before execution (incl. un-hashed p_created_at)", async () => {
    const base = saleArgs(A.st.ids.prod1, 1, 5000);
    const cases: [string, string, any][] = [
      ["complete_sale", "p_paid_mmk string", { ...base, p_paid_mmk: "5000" }],
      ["complete_sale", "p_paid_mmk fractional", { ...base, p_paid_mmk: 5000.5 }],
      ["complete_sale", "p_paid_mmk > int4", { ...base, p_paid_mmk: 3e9 }],
      ["complete_sale", "p_cart_discount_pct string", { ...base, p_cart_discount_pct: "0" }],
      ["complete_sale", "p_shop_id number", { ...base, p_shop_id: 123 }],
      ["complete_sale", "p_created_at garbage", { ...base, p_created_at: "not-a-date" }],
      ["complete_sale", "p_created_at number", { ...base, p_created_at: 12345 }],
      ["deactivate_app_user", "boolean as string", { p_id: A.st.ids.cashB, p_is_active: "false" }],
      ["update_app_user", "text[] of numbers", { p_id: A.st.ids.cashB, p_name: "x", p_role: "CASHIER", p_shop_id: A.st.ids.shop, p_granted_permissions: [1, 2], p_revoked_permissions: null }],
    ];
    const out: string[] = [];
    const s0 = snapshot(A.st.ids.org);
    for (const [rpc, n, a] of cases) {
      const k = v7();
      const who = rpc === "complete_sale" ? A.c.cashA : A.c.admin;
      const r = await X(who, k, rpc, a);
      expect(r.error?.code).toBe("22023");
      expect(r.error?.message).toMatch(/^OP_INVALID_ARGUMENT/);
      expect(ledgerRow(k)).toBeNull();
      out.push(`${n}: ${r.error.message}`);
    }
    const badKey = await A.c.cashA.rpc("op_execute", { p_key: "not-a-uuid", p_rpc: "complete_sale", p_args: base });
    expect(badKey.error).toBeTruthy();
    out.push(`p_key not a uuid: ${badKey.error.code} (refused by PostgreSQL before the executor runs)`);
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    return out;
  });

  T("4", "4.8", "same key, different request on executor-created rows: mismatch, no write", async () => {
    const k = v7();
    const args = saleArgs(A.st.ids.prod1, 1, 5000);
    mustOk(await X(A.c.cashA, k, "complete_sale", args), "first");
    const b = ledgerRowText(k), bb = ledgerRowText(keep.b2.key);
    const m1 = mustOk(await X(A.c.cashA, k, "complete_sale", { ...args, p_paid_mmk: 7000 }), "m1");
    const m2 = mustOk(await X(A.c.cashA, keep.b2.key, "complete_sale", { ...keep.b2.args, p_paid_mmk: 300001 }), "m2");
    const same = mustOk(await X(A.c.cashA, k, "complete_sale", { ...args, p_created_at: "2020-01-01T00:00:00Z" }), "created_at only");
    expect(m1).toEqual({ outcome: "mismatch" }); expect(m2).toEqual({ outcome: "mismatch" });
    expect(same).toMatchObject({ outcome: "committed", replayed: true });
    expect(ledgerRowText(k)).toBe(b); expect(ledgerRowText(keep.b2.key)).toBe(bb);
    return { committedKeyChangedArgs: "mismatch", rejectedKeyChangedArgs: "mismatch", onlyCreatedAtDiffers: "replay (p_created_at is not part of the request, as in 085)" };
  });

  T("4", "4.9", "concurrent same-key execution: 12× commit, 12× refusal, 12× mixed legacy+executor", async () => {
    const run = async (args: any, mixed = false) => {
      const k = mixed ? randomUUID() : v7();
      const n0 = salesCount();
      const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => (mixed && i % 2 ? direct(A.c.cashA, "complete_sale", args, k) : X(A.c.cashA, k, "complete_sale", args))));
      return { k, rs, dn: salesCount() - n0 };
    };
    const c = await run(saleArgs(A.st.ids.prod1, 1, 5000));
    const fresh = c.rs.filter((r: any) => r.data?.replayed === false);
    expect(fresh).toHaveLength(1);
    expect(c.rs.every((r: any) => r.data?.outcome === "committed")).toBe(true);
    expect(new Set(c.rs.map((r: any) => JSON.stringify(r.data.response))).size).toBe(1);
    expect(c.dn).toBe(1);
    const f = await run(saleArgs(A.st.ids.prod2, 100000, 2000000000));
    expect(f.rs.filter((r: any) => r.data?.outcome === "rejected" && r.data.replayed === false)).toHaveLength(1);
    expect(f.rs.every((r: any) => r.data?.outcome === "rejected")).toBe(true);
    expect(f.dn).toBe(0);
    expect(Number(sql1(`SELECT count(*) FROM idempotency_keys WHERE key=${lit(f.k)}::uuid`))).toBe(1);
    const m = await run(saleArgs(A.st.ids.prod1, 1, 5000), true);
    expect(m.dn).toBe(1);
    expect(m.rs.every((r: any) => !r.error)).toBe(true);
    return { commit: "1 fresh + 11 replays, identical response, 1 sale", refusal: "1 fresh rejection + 11 replayed rejections, 1 row, 0 sales", mixedLegacyAndExecutor: "12 successes, 1 sale" };
  });

  T("4", "4.10", "nested SECURITY DEFINER: caller identity preserved; advisory lock survives the savepoint rollback", async () => {
    const s = await as(A.auth.cashA);
    const spid = await s.pid();
    try {
      await s.q("SET qa.probe = 'on';");
      const k1 = v7();
      parsed(await s.q(execSql(k1, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000))));
      await s.q("SET qa.probe = 'off';");
      const probe = sql1("SELECT cu || '|' || su || '|' || uid || '|' || sp FROM qa_scaffold.probe ORDER BY at DESC LIMIT 1");
      expect(probe.split("|")[2]).toBe(A.auth.cashA);
      expect(ledgerRow(k1).actor_id).toBe(A.st.ids.cashA);
      // lock retention: refusal inside the executor, transaction still open
      const k2 = v7();
      await s.q("BEGIN;");
      const r = parsed(await s.q(execSql(k2, "complete_sale", saleArgs(A.st.ids.prod2, 100000, 2000000000))));
      expect(r.data.outcome).toBe("rejected");
      const held = Number(sql1(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid=${spid}`));
      const st = mustOk(await S(A.c.cashA, k2, "complete_sale", true, A.st.ids.cashA), "fence during open txn");
      await s.q("COMMIT;");
      expect(held).toBeGreaterThanOrEqual(1);
      expect(st).toEqual({ status: "in_flight" });
      expect(ledgerRow(k2).state).toBe("rejected");
      // contrast: the same refusal in a plain savepoint WITHOUT the outer lock
      const k3 = randomUUID();
      await s.q("BEGIN; SAVEPOINT a;");
      await s.q(`SELECT public.complete_sale(p_shop_id=>${lit(A.st.ids.shop)}, p_shift_id=>${lit(shiftA)}, p_payment_method=>'CASH', p_paid_mmk=>2000000000, p_cart_discount_pct=>0, p_items=>'[{"product_id":"${A.st.ids.prod2}","qty":100000,"units_per_item":1}]'::jsonb, p_idempotency_key=>${lit(k3)});`);
      await s.q("ROLLBACK TO SAVEPOINT a;");
      const heldAfterSp = Number(sql1(`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid=${spid}`));
      await s.q("ROLLBACK;");
      expect(heldAfterSp).toBe(0);
      return { insideRpc_currentUser_sessionUser_authUid_searchPath: probe.replace(A.auth.cashA, "<cashA auth uid>"), ledgerActor: "cashA", lockHeldAfterRejectionUntilCommit: held, fenceDuringThatWindow: st.status, lockHeldAfterPlainSavepointRollback: heldAfterSp };
    } finally { s.close(); }
  });

  // ============================ TASK 5 ===================================
  T("5", "5.1", "key identity helpers agree with PostgreSQL 17's uuid_extract_version/timestamp (2000 keys)", async () => {
    const v7s = Array.from({ length: 1000 }, () => { const ms = rand(0, 2 ** 47); return [v7(ms), ms] as const; });
    const v4s = Array.from({ length: 1000 }, () => [randomUUID(), -1] as const);
    const bad = runSql(`CREATE TEMP TABLE kk(k uuid, ms bigint); INSERT INTO kk VALUES ${[...v7s, ...v4s].map(([k, ms]) => `('${k}', ${ms})`).join(",")};
      SELECT count(*) FROM kk WHERE public.op_key_version(k) IS DISTINCT FROM uuid_extract_version(k)
         OR public.op_key_time(k) IS DISTINCT FROM CASE WHEN ms >= 0 THEN 'epoch'::timestamptz + ms * interval '1 millisecond' END;`).trim();
    expect(bad).toBe("0");
    return "0 disagreements: version vs uuid_extract_version (2000 keys); time vs the client-side millisecond value (1000 v7). PG17's uuid_extract_timestamp supports v1 only (v7 from PG18), so it cannot be the reference here.";
  });

  T("5", "5.2", "execution window (server clock) for v7; v4/derived keys have none", async () => {
    const now = Date.now();
    const M = 30.44 * 24 * 3600e3;
    const cases: [string, string, boolean][] = [
      ["v7 now", v7(now), true],
      ["v7 now+2min", v7(now + 120e3), true],
      ["v7 now+10min (till clock ahead)", v7(now + 600e3), true],
      ["v7 now+29 days (till clock far ahead)", v7(now + 29 * 864e5), true],
      ["v7 now+31 days", v7(now + 31 * 864e5), false],
      ["v7 now-11.9 months", v7(now - 11.9 * M), true],
      ["v7 now-12.1 months", v7(now - 12.1 * M), false],
      ["v7-shaped derived key, year 2200", v7(Date.UTC(2200, 0, 1)), false],
      ["v7-shaped derived key, 1970", v7(1000), false],
      ["v4 (085 client)", randomUUID(), true],
      ["v5-style derived key", v7(now, 5), true],
      ["v8-style derived key", v7(now, 8), true],
    ];
    const out: string[] = [];
    for (const [n, k, ok] of cases) {
      const r = await X(A.c.cashA, k, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000));
      if (ok) expect(r.data?.outcome, `${n}: ${JSON.stringify(r.error)}`).toBe("committed");
      else { expect(r.error?.message).toBe("OP_KEY_OUTSIDE_WINDOW"); expect(ledgerRow(k)).toBeNull(); }
      out.push(`${n}: ${ok ? "executed" : `${r.error.code} ${r.error.message}, not recorded`}`);
    }
    return out;
  });

  T("5", "5.3", "client timestamps are not trusted: decided_at is the server clock; p_created_at is clamped by the RPC", async () => {
    const k = v7();
    const d = mustOk(await X(A.c.cashA, k, "complete_sale", { ...saleArgs(A.st.ids.prod1, 1, 5000), p_created_at: "2020-01-01T00:00:00Z" }), "x");
    const row = ledgerRow(k);
    const skew = Math.abs(new Date(row.decided_at).getTime() - Date.now());
    const saleAt = sql1(`SELECT extract(epoch FROM now() - created_at)::int FROM sales WHERE id = ${lit(d.response.sale.id)}`);
    expect(skew).toBeLessThan(60_000);
    expect(Number(saleAt)).toBeLessThanOrEqual(48 * 3600 + 60);
    return { decidedAtMinusNowMs: skew, saleCreatedAtAgeSeconds: Number(saleAt), clientSent: "2020-01-01" };
  });

  T("5", "5.4", "tombstone pruning: only v7 decisions with key AND decision older than 13 months; never v4/derived/pre-086", async () => {
    const now = Date.now();
    const M = 30.44 * 24 * 3600e3;
    const ago = (m: number) => `now() - interval '${m} months'`;
    const rows: [string, string, string, string, boolean][] = [
      ["v7 rejected, key -14m, decided -14m", v7(now - 14 * M), "rejected", ago(14), true],
      ["v7 abandoned, key -14m, decided -14m", v7(now - 14 * M), "abandoned", ago(14), true],
      ["v7 committed, key -14m, decided -14m", v7(now - 14 * M), "committed", ago(14), true],
      ["v7 abandoned, key -14m, fenced -11m", v7(now - 14 * M), "abandoned", ago(11), false],
      ["v7 rejected, key -11m, decided -14m", v7(now - 11 * M), "rejected", ago(14), false],
      ["v4 rejected, decided -60m", randomUUID(), "rejected", ago(60), false],
      ["v4 abandoned, decided -60m", randomUUID(), "abandoned", ago(60), false],
      ["v4 committed (pre-086), decided -60m", randomUUID(), "committed", ago(60), false],
      ["v5-style derived, decided -60m", v7(now - 60 * M, 5), "rejected", ago(60), false],
    ];
    const ins = rows.map(([, k, st, at]) => `(${lit(k)}::uuid, 'complete_sale', ${lit(A.st.ids.cashA)}, ${lit(A.st.ids.org)}, ${st === "rejected" ? "'R:' || md5(random()::text)" : st === "abandoned" ? "'A:'" : "md5(random()::text)"}, ${st === "committed" ? "'{}'::jsonb" : "NULL"}, ${lit(st)}, ${st === "rejected" ? "'P0001'" : st === "abandoned" ? "'FENCED'" : "NULL"}, ${at}, ${at})`).join(",\n");
    runSql(`INSERT INTO public.idempotency_keys (key, rpc, actor_id, org_id, request_hash, response, state, outcome_code, decided_at, created_at) VALUES ${ins};`);
    const would062 = Number(sql1(`SELECT count(*) FROM public.idempotency_keys WHERE created_at < now() - interval '30 days' AND key IN (${rows.map((r) => `${lit(r[1])}::uuid`).join(",")})`));
    const anon = await makeClient(cfg, cfg.anonKey).rpc("prune_idempotency_keys");
    const auth = await A.c.admin.rpc("prune_idempotency_keys");
    const pruned = await makeClient(cfg, cfg.serviceKey).rpc("prune_idempotency_keys");
    const out: string[] = [];
    for (const [n, k, , , gone] of rows) {
      const exists = ledgerRow(k) !== null;
      expect(exists).toBe(!gone);
      out.push(`${n}: ${exists ? "kept" : "pruned"}`);
    }
    keep.pruned = rows[0][1];
    return { out, prunedCount: pruned.data, the062RuleWouldDelete: `${would062}/${rows.length} of these (all of them)`, anonCall: anon.error?.code, authenticatedCall: auth.error?.code };
  });

  T("5", "5.5", "a delayed copy of a PRUNED v7 key cannot execute — neither through the executor (window) nor the legacy path (executor-only guard)", async () => {
    const s0 = snapshot(A.st.ids.org);
    const r = await X(A.c.cashA, keep.pruned, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000));
    expect(r.error?.message).toBe("OP_KEY_OUTSIDE_WINDOW");
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    const legacy = await direct(A.c.cashA, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000), keep.pruned);
    expect(legacy.error?.message).toMatch(/^OP_EXECUTOR_REQUIRED/);
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    return { executor: `${r.error.code} ${r.error.message}`, legacyDirectPath: `${legacy.error.code} ${legacy.error.message.slice(0, 40)} (086 idem_begin guard)` };
  });

  T("5", "5.6", "062's 30-day prune would re-open a refused key (why it must not run after 086)", async () => {
    const k = v7();
    const args = saleArgs(A.st.ids.prod2, 150, 300000);
    mustOk(await X(A.c.cashA, k, "complete_sale", { ...args, p_items: [{ product_id: A.st.ids.prod2, qty: 1000000, units_per_item: 1 }], p_paid_mmk: 2000000000 }), "refuse");
    // a refusal that later becomes satisfiable: stock (prod2 qty 150 refused earlier is covered by 2.3)
    const k2 = v7();
    runSql(`UPDATE inventory SET qty_base_units = 0 WHERE shop_id=${lit(A.st.ids.shop)} AND product_id=${lit(A.st.ids.prod2)};`);
    const ref = mustOk(await X(A.c.cashA, k2, "complete_sale", args), "refuse2");
    expect(ref.outcome).toBe("rejected");
    runSql(`UPDATE inventory SET qty_base_units = 1000 WHERE shop_id=${lit(A.st.ids.shop)} AND product_id=${lit(A.st.ids.prod2)};`);
    runSql(`UPDATE idempotency_keys SET created_at = now() - interval '31 days', decided_at = now() - interval '31 days' WHERE key=${lit(k2)}::uuid;`);
    const safe = await makeClient(cfg, cfg.serviceKey).rpc("prune_idempotency_keys");
    expect(ledgerRow(k2)).not.toBeNull();
    runSql(`DELETE FROM public.idempotency_keys WHERE created_at < now() - interval '30 days' AND key=${lit(k2)}::uuid;`); // = the 062 rule
    const n0 = salesCount();
    const again = mustOk(await X(A.c.cashA, k2, "complete_sale", args), "after 062 rule");
    const executed = again.outcome === "committed" && salesCount() === n0 + 1;
    expect(executed).toBe(true);
    return { prune086: `kept the 31-day-old rejection (pruned ${safe.data})`, after062RuleDeletedIt: "the refused sale EXECUTED on a delayed copy (B2 again)", conclusion: "the 062 body must never run after 086 (never restore it)" };
  });

  T("5", "5.7", "response purge after 90 days: decision kept; executor reports purged; legacy replay degrades to {}", async () => {
    const pay = L.find((l) => l.name === "pay_supplier_lump_sum")!;
    const k = v7();
    const args = saleArgs(A.st.ids.prod1, 1, 5000);
    mustOk(await X(A.c.cashA, k, "complete_sale", args), "x");
    runSql(`UPDATE idempotency_keys SET decided_at = now() - interval '91 days' WHERE key IN (${lit(k)}::uuid, ${lit(pay.key)}::uuid);
            INSERT INTO idempotency_keys (key, rpc, actor_id, org_id, request_hash, response, decided_at) SELECT gen_random_uuid(), 'complete_sale', ${lit(A.st.ids.cashA)}, ${lit(A.st.ids.org)}, md5('p086-89d-' || ${lit(A.st.ts)}), '{"x":1}', now() - interval '89 days' RETURNING 1;`);
    const svcPurge = await makeClient(cfg, cfg.serviceKey).rpc("op_purge_responses", { p_older_than: "90 days" });
    expect(svcPurge.error).toBeTruthy();
    let tooShort = "";
    try { runSql("SELECT public.op_purge_responses(interval '30 days')"); } catch (e: any) { tooShort = /minimum age is 90 days/.exec(String(e.message))?.[0] ?? String(e.message).slice(0, 80); }
    expect(tooShort).toBe("minimum age is 90 days");
    await makeClient(cfg, cfg.serviceKey).rpc("prune_idempotency_keys");
    expect(Number(sql1(`SELECT count(*) FROM idempotency_keys WHERE key=${lit(k)}::uuid AND response IS NOT NULL`))).toBe(1);
    const n = { data: sql1("SELECT public.op_purge_responses(interval '90 days')") };
    const purged = Number(sql1(`SELECT count(*) FROM idempotency_keys WHERE key IN (${lit(k)}::uuid, ${lit(pay.key)}::uuid) AND response IS NULL AND response_purged_at IS NOT NULL AND state='committed'`));
    const fresh89 = Number(sql1(`SELECT count(*) FROM idempotency_keys WHERE request_hash = md5('p086-89d-' || ${lit(A.st.ts)}) AND response IS NOT NULL`));
    const x = mustOk(await X(A.c.cashA, k, "complete_sale", args), "replay");
    const xp = mustOk(await X(A.c.admin, pay.key, pay.rpc, pay.args), "pre-086 replay");
    const st = mustOk(await S(A.c.cashA, k, "complete_sale"), "status");
    const legacy = await direct(A.c.admin, pay.rpc, pay.args, pay.key);
    expect(purged).toBe(2); expect(fresh89).toBe(1);
    expect(x).toMatchObject({ outcome: "committed", replayed: true, response: null, response_purged: true });
    expect(xp).toMatchObject({ outcome: "committed", response: null, response_purged: true });
    expect(st).toMatchObject({ status: "committed", response_purged: true });
    return OBSERVED({ serviceRolePurge: svcPurge.error?.code, under90DaysRefused: true, scheduledPruneDoesNotPurge: true, ownerPurgeReturned: n.data, purgedRows: purged, untouched89DayRow: fresh89, executorReplay: "committed, response_purged:true", legacy085ReplayBody: legacy.data, note: "INACTIVE in Stage 1. A v1.0.16/085 client replaying a purged entry gets {} and holds it as an unrecognised reply" });
  });

  // ===================== CORRECTION PASS (review findings) =====================
  T("C", "C.1", "finding 1: op_execute runs only for the operation's own actor — another user's session is refused before anything runs (nothing recorded)", async () => {
    const s0 = snapshot(A.st.ids.org);
    const k = v7();
    const args = saleArgs(A.st.ids.prod2, 1000000, 2000000000);   // would be a definitive stock refusal
    const other = await X(A.c.cashB, k, "complete_sale", args, A.st.ids.cashA);
    expect(other.error?.message).toMatch(/^OP_ACTOR_MISMATCH/);
    expect(ledgerRow(k)).toBeNull();
    const admin = await X(A.c.admin, k, "complete_sale", args, A.st.ids.cashA);
    expect(admin.error?.message).toMatch(/^OP_ACTOR_MISMATCH/);         // ADMIN never executes on someone's behalf
    const none = await X(A.c.cashA, k, "complete_sale", args, null);
    expect(none.error?.message).toBe("OP_ACTOR_REQUIRED");               // a UUIDv7 operation needs its actor
    expect(ledgerRow(k)).toBeNull();
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    const own = mustOk(await X(A.c.cashA, k, "complete_sale", args, A.st.ids.cashA), "own");
    expect(own).toMatchObject({ outcome: "rejected" });                    // recorded only in its own actor's session
    expect(ledgerRow(k)).toMatchObject({ state: "rejected", actor_id: A.st.ids.cashA });
    return { otherCashier: other.error.message.slice(0, 40), admin: admin.error.message.slice(0, 40), noActor: none.error.message, ownActor: "rejected, recorded" };
  });

  T("C", "C.2", "finding 1 (legacy): a v4 entry with NO recorded actor still runs, but its refusal is never recorded (op_not_recorded:actor_unverified)", async () => {
    const k = randomUUID();
    const r = await X(A.c.cashA, k, "complete_sale", saleArgs(A.st.ids.prod2, 1000000, 2000000000), null);
    expect(r.error?.code).toBe("P0001");
    expect(r.error?.hint).toBe("op_not_recorded:actor_unverified");
    expect(ledgerRow(k)).toBeNull();
    const ok = mustOk(await X(A.c.cashA, randomUUID(), "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000), null), "v4 no actor commits");
    expect(ok.outcome).toBe("committed");
    return { refusal: `${r.error.message.slice(0, 50)} [${r.error.hint}]`, success: "committed (as at 085)" };
  });

  T("C", "C.3", "findings 3/8/9: on an 086 server a UUIDv7 key never runs through a legacy direct RPC (OP_EXECUTOR_REQUIRED, nothing runs); v4 keys are unaffected; create_app_user is exempt", async () => {
    const s0 = snapshot(A.st.ids.org);
    const k = v7();
    const d = await direct(A.c.cashA, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000), k);
    expect(d.error?.code).toBe("22023");
    expect(d.error?.message).toMatch(/^OP_EXECUTOR_REQUIRED/);
    expect(ledgerRow(k)).toBeNull();
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    const pay = await direct(A.c.admin, "pay_supplier_lump_sum", { p_supplier_id: A.st.ids.sup, p_shop_id: A.st.ids.shop, p_amount_mmk: 1, p_payment_method: "CASH", p_reference_no: null, p_notes: null }, v7());
    expect(pay.error?.message).toMatch(/^OP_EXECUTOR_REQUIRED/);
    const v4 = await direct(A.c.cashA, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000), randomUUID());
    expect(v4.error).toBeNull();
    const cau = await direct(A.c.admin, "create_app_user", { p_id: `qa-x-${Date.now()}`, p_name: "x", p_email: `x-${Date.now()}@qa.invalid`, p_role: "CASHIER", p_shop_id: A.st.ids.shop, p_auth_id: randomUUID(), p_granted_permissions: null, p_revoked_permissions: null }, v7());
    expect(cau.error?.message ?? "").not.toMatch(/OP_EXECUTOR_REQUIRED/);
    return { saleV7Direct: d.error.message.slice(0, 40), paymentV7Direct: "refused", saleV4Direct: "committed (085 behaviour)", createAppUserV7: cau.error ? `refused for its own reason: ${cau.error.message.slice(0, 60)}` : "ran" };
  });

  T("C", "C.4", "finding 5: an actor-less legacy entry — a cashier cannot fence it; an ADMIN can only with server-side organisation evidence (p_args); other-org evidence refuses", async () => {
    const args = saleArgs(A.st.ids.prod1, 1, 5000);
    const k1 = randomUUID();
    const cashier = mustOk(await S(A.c.cashB, k1, "complete_sale", true, null, args), "cashier");
    expect(cashier).toMatchObject({ fenced: false, reason: "not_authorized" });
    const noEvidence = mustOk(await S(A.c.admin, k1, "complete_sale", true, null, null), "admin, no args");
    expect(noEvidence).toMatchObject({ fenced: false });
    const otherOrg = mustOk(await S(A.c.admin, k1, "complete_sale", true, null, { ...args, p_shop_id: B.st.ids.shop, p_shift_id: shiftB }), "admin, other org args");
    expect(otherOrg).toMatchObject({ fenced: false });
    const unknown = mustOk(await S(A.c.admin, k1, "complete_sale", true, null, { ...args, p_shop_id: "shop-does-not-exist" }), "admin, unknown shop");
    expect(unknown).toMatchObject({ fenced: false });
    expect(ledgerRow(k1)).toBeNull();
    const ok = mustOk(await S(A.c.admin, k1, "complete_sale", true, null, args), "admin with evidence");
    expect(ok).toEqual({ status: "abandoned", fenced: true });
    expect(ledgerRow(k1)).toMatchObject({ state: "abandoned", actor_id: null, org_id: A.st.ids.org });
    // own-actor fence with arguments of ANOTHER org is refused too (no cross-tenant squatting with real args)
    const k2 = v7();
    const squat = mustOk(await S(B.c.cashA, k2, "complete_sale", true, B.st.ids.cashA, args), "org B with org A args");
    expect(squat).toMatchObject({ fenced: false, reason: "not_authorized" });
    expect(ledgerRow(k2)).toBeNull();
    return { cashier: "not_authorized", adminNoEvidence: "not_authorized", adminOtherOrgEvidence: "not_authorized", adminUnknownShop: "not_authorized", adminOwnOrgEvidence: "abandoned (actor stays NULL)", crossOrgOwnActorWithForeignArgs: "not_authorized" };
  });

  T("C", "C.5", "low findings: p_fence NULL is a lookup (no write); an expired UUIDv7 key is never fenced; concurrent lookups share the lock, a fence does not", async () => {
    const k = v7();
    const nul = mustOk(await S(A.c.cashA, k, "complete_sale", null, A.st.ids.cashA), "null fence");
    expect(nul).toMatchObject({ status: "not_found" });
    expect(ledgerRow(k)).toBeNull();
    const old = v7(Date.now() - 13 * 30.44 * 864e5);
    const exp = mustOk(await S(A.c.cashA, old, "complete_sale", true, A.st.ids.cashA), "expired");
    expect(exp).toMatchObject({ fenced: false, reason: "expired", executable: false });
    expect(ledgerRow(old)).toBeNull();
    // one lookup holds the key's lock (shared) in an open transaction
    const s = await as(A.auth.cashA);
    const k2 = v7();
    try {
      await s.q(`BEGIN;\n${statusSql(k2, "complete_sale")}`);
      const second = mustOk(await S(A.c.cashA, k2, "complete_sale"), "second lookup");
      const fence = mustOk(await S(A.c.cashA, k2, "complete_sale", true, A.st.ids.cashA), "fence while a lookup holds it");
      await s.q("COMMIT;");
      expect(second).toMatchObject({ status: "not_found" });
      expect(fence).toEqual({ status: "in_flight" });
      expect(ledgerRow(k2)).toBeNull();
      return { nullFence: "lookup, no write", expired: "not fenced (reason expired)", concurrentLookup: second.status, fenceDuringLookup: fence.status };
    } finally { s.close(); }
  });

  T("C", "C.6", "foreign decided key: 'unavailable' comes first — no in_flight signal for another org's key", async () => {
    const sale = L.find((l) => l.name === "complete_sale")!;
    const s = await as(A.auth.cashA);
    try {
      await s.q(`BEGIN;\nSELECT pg_advisory_xact_lock(hashtext('idem:' || ${lit(sale.key)}));`);
      const foreign = mustOk(await S(B.c.cashA, sale.key, "complete_sale"), "foreign lookup while locked");
      await s.q("ROLLBACK;");
      expect(foreign).toEqual({ status: "unavailable" });
      return { foreignWhileLocked: foreign.status };
    } finally { s.close(); }
  });

  // ===================== STABILIZATION PASS (DB side) =====================
  T("S", "S.1", "future-dated UUIDv7 keys: beyond +30 days never execute (OUTSIDE_WINDOW, nothing recorded); any future key can be fenced by its own actor and then never runs", async () => {
    const far = v7(Date.now() + 40 * 864e5);
    const near = v7(Date.now() + 3 * 864e5);
    const s0 = snapshot(A.st.ids.org);
    const run = await X(A.c.cashA, far, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000));
    expect(run.error?.message).toMatch(/^OP_KEY_OUTSIDE_WINDOW/);
    expect(ledgerRow(far)).toBeNull();
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    const out: Record<string, unknown> = { farExecute: run.error.message.slice(0, 40) };
    for (const [name, k] of [["far", far], ["near", near]] as const) {
      const f = mustOk(await S(A.c.cashA, k, "complete_sale", true, A.st.ids.cashA), `fence ${name}`);
      expect(f).toEqual({ status: "abandoned", fenced: true });
      expect(ledgerRow(k)).toMatchObject({ state: "abandoned", actor_id: A.st.ids.cashA });
      const late = mustOk(await X(A.c.cashA, k, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000)), `late ${name}`);
      expect(late).toEqual({ outcome: "abandoned", replayed: true });
      out[`${name}Fence`] = "abandoned (own actor); late copy refused";
    }
    expect(snapDiff(s0, snapshot(A.st.ids.org)).filter((d: string) => !/idempotency/.test(d))).toEqual([]);
    return out;
  });

  T("S", "S.2", "privilege parity: an RPC the caller's role may not EXECUTE directly is refused by op_execute too (OP_RPC_DISABLED, nothing runs or is recorded)", async () => {
    const k = v7();
    const s0 = snapshot(A.st.ids.org);
    runSql("DO $$ DECLARE f regprocedure; BEGIN FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'complete_sale' LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', f); END LOOP; END $$;");
    try {
      const r = await X(A.c.cashA, k, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000));
      expect(r.error?.code).toBe("42501");
      expect(r.error?.message).toMatch(/^OP_RPC_DISABLED/);
      expect(ledgerRow(k)).toBeNull();
      expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
      return { revoked: "complete_sale from authenticated", executor: `${r.error.code} ${r.error.message.slice(0, 30)}` };
    } finally {
      runSql("DO $$ DECLARE f regprocedure; BEGIN FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'complete_sale' LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f); END LOOP; END $$;");
    }
  });

  T("S", "S.3", "retention: prune removes a 14-month-old UUIDv7 decision but never a create_app_user row or a UUIDv4 (legacy) one", async () => {
    const old = Date.now() - 14 * 30.44 * 864e5;
    const kSale = v7(old);
    const kUser = v7(old);
    const kV4 = randomUUID();
    for (const [k, rpc] of [[kSale, "complete_sale"], [kUser, "create_app_user"], [kV4, "complete_sale"]] as const) {
      runSql(`INSERT INTO idempotency_keys (key, rpc, actor_id, org_id, request_hash, state, outcome_code, decided_at, created_at)
              VALUES (${lit(k)}::uuid, ${lit(rpc)}, ${lit(A.st.ids.cashA)}, ${lit(A.st.ids.org)}, 'R:' || md5(${lit(k)}), 'rejected', 'P0001', now() - interval '14 months', now() - interval '14 months')`);
    }
    const pruned = Number(sql1("SELECT public.prune_idempotency_keys()"));
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(ledgerRow(kSale)).toBeNull();
    expect(ledgerRow(kUser)).not.toBeNull();
    expect(ledgerRow(kV4)).not.toBeNull();
    runSql(`DELETE FROM idempotency_keys WHERE key IN (${lit(kUser)}::uuid, ${lit(kV4)}::uuid)`);
    return { v7Sale14Months: "pruned", createAppUser: "kept", legacyV4: "kept" };
  });

  T("S", "S.4", "a DECIDED key replays from the ledger even while another session holds its lock (read before the lock: no false in_flight, no wait)", async () => {
    const k = v7();
    const args = saleArgs(A.st.ids.prod2, 1000000, 2000000000);
    expect(mustOk(await X(A.c.cashA, k, "complete_sale", args), "decide")).toMatchObject({ outcome: "rejected" });
    const s = await as(A.auth.cashA);
    try {
      await s.q(`BEGIN;\nSELECT pg_advisory_xact_lock(hashtext('idem:' || ${lit(k)}));`);
      const t0 = Date.now();
      const replay = mustOk(await X(A.c.cashA, k, "complete_sale", args), "replay under lock");
      const lookup = mustOk(await S(A.c.cashA, k, "complete_sale"), "lookup under lock");
      const ms = Date.now() - t0;
      await s.q("ROLLBACK;");
      expect(replay).toMatchObject({ outcome: "rejected", replayed: true });
      expect(lookup).toMatchObject({ status: "rejected" });
      expect(ms).toBeLessThan(5000);
      return { replayUnderLock: "rejected (replayed)", lookupUnderLock: "rejected", ms };
    } finally { s.close(); }
  });

  // ============================ TASK 6 ===================================
  T("6", "6.1", "DB crash before commit (executor blocked inside the RPC): nothing survives; same key then commits once", async () => {
    const key = v7();
    const args = saleArgs(A.st.ids.prod1, 1, 5000);
    const x = await holdInventory(A.st.ids.prod1);
    const y = await as(A.auth.cashA);
    const pid = await y.pid();
    const s0 = snapshot(A.st.ids.org);
    const p = y.q(execSql(key, "complete_sale", args));
    await waitLockWaiters();
    const crash = await crashBackend(pid);
    await p.catch(() => undefined); x.close(); y.close();
    expect(ledgerRow(key)).toBeNull();
    expect(snapDiff(s0, snapshot(A.st.ids.org))).toEqual([]);
    let st: any;
    for (let i = 0; i < 360; i++) { st = await S(A.c.cashA, key, "complete_sale"); if (!st.error) break; await delay(500); }
    expect(st.data).toMatchObject({ status: "not_found" });
    const n0 = salesCount();
    const d = mustOk(await X(A.c.cashA, key, "complete_sale", args), "retry");
    expect(d).toMatchObject({ outcome: "committed", replayed: false });
    expect(salesCount()).toBe(n0 + 1);
    return { recoveredMs: crash.recoveredMs, postgresLog: crash.log.split("\n").map((l) => l.replace(/^.*?(LOG|WARNING):\s*/, "")).slice(-5), afterRecovery: "no row, no effect, status not_found", retry: "committed once" };
  });

  T("6", "6.2", "crash after the rejection row was written but before COMMIT: no rejection survives; retry rejects again", async () => {
    const key = v7();
    const args = saleArgs(A.st.ids.prod2, 100000, 2000000000);
    const y = await as(A.auth.cashA);
    const pid = await y.pid();
    await y.q("BEGIN;");
    const r = parsed(await y.q(execSql(key, "complete_sale", args)));
    expect(r.data.outcome).toBe("rejected");
    await crashBackend(pid); y.close();
    expect(ledgerRow(key)).toBeNull();
    let d: any;
    for (let i = 0; i < 360; i++) { d = await X(A.c.cashA, key, "complete_sale", args); if (!d.error) break; await delay(500); }
    expect(d.data).toMatchObject({ outcome: "rejected", replayed: false });
    return "uncommitted rejection lost with the crash (correct); deterministic refusal recorded on retry";
  });

  T("6", "6.3", "crash during an uncommitted fence: no fence survives; the key is still undecided", async () => {
    const key = v7();
    const y = await as(A.auth.cashA);
    const pid = await y.pid();
    await y.q("BEGIN;");
    const r = parsed(await y.q(statusSql(key, "complete_sale", true, A.st.ids.cashA)));
    expect(r.data).toEqual({ status: "abandoned", fenced: true });
    await crashBackend(pid); y.close();
    expect(ledgerRow(key)).toBeNull();
    let st: any;
    for (let i = 0; i < 360; i++) { st = await S(A.c.cashA, key, "complete_sale"); if (!st.error) break; await delay(500); }
    expect(st.data).toMatchObject({ status: "not_found" });
    return "fence not durable until committed; status after recovery: not_found (client must re-fence)";
  });

  T("6", "6.4", "lost response after commit: lookup returns the committed response; re-execute replays it; one effect", async () => {
    const key = v7();
    const args = saleArgs(A.st.ids.prod1, 1, 5000);
    const n0 = salesCount();
    const committed = mustOk(await X(A.c.cashA, key, "complete_sale", args), "x");   // reply "lost": the client never used it
    const st = mustOk(await S(A.c.cashA, key, "complete_sale", true, A.st.ids.cashA), "lookup+fence");
    const re = mustOk(await X(A.c.cashA, key, "complete_sale", args), "re-exec");
    expect(st).toMatchObject({ status: "committed" });
    expect(st.response).toEqual(committed.response);
    expect(re).toMatchObject({ outcome: "committed", replayed: true });
    expect(re.response).toEqual(committed.response);
    expect(salesCount()).toBe(n0 + 1);
    keep.execCommitted = { key, args, response: committed.response };
    return "lookup (even with fence) → committed + identical response; re-execute → replay; 1 sale";
  });

  T("6", "6.5", "085 clients against the prototype: direct calls work, replay executor-created rows, B2 persists for them", async () => {
    const n0 = salesCount();
    const k = randomUUID();
    const d1 = await direct(A.c.cashA, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000), k);
    expect(d1.error).toBeNull();
    expect(ledgerRow(k)).toMatchObject({ state: "committed" });
    // a UUIDv7 operation (086 client) never runs through the legacy path — not even as a replay
    const d2 = await direct(A.c.cashA, "complete_sale", keep.execCommitted.args, keep.execCommitted.key);
    expect(d2.error?.message).toMatch(/^OP_EXECUTOR_REQUIRED/);
    // a v4 key executed through op_execute replays identically on the legacy path (085 clients' keys are v4)
    const k4 = randomUUID();
    const ex4 = mustOk(await X(A.c.cashA, k4, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000)), "v4 via executor");
    const d4 = await direct(A.c.cashA, "complete_sale", saleArgs(A.st.ids.prod1, 1, 5000), k4);
    expect(d4.data).toEqual(ex4.response);
    const k3 = randomUUID();
    const d3 = await direct(A.c.cashA, "complete_sale", saleArgs(A.st.ids.prod2, 1000000, 2000000000), k3);
    expect(d3.error?.code).toBe("P0001");
    expect(ledgerRow(k3)).toBeNull();
    expect(salesCount()).toBe(n0 + 2);   // the direct sale + the v4 control sale
    return OBSERVED({ newDirectCall: "committed, row state default 'committed' (CHECK accepts)", directReplayOfExecutorCommittedKey: "identical response", directRefusal: "still leaves no row → B2 remains for 085 clients until they upgrade (stage 2 closes it)" });
  });

  T("6", "6.6", "cleanup of test scaffolding (fault injector, shadow schema) before the rollback phase", async () => {
    runSql("DROP TRIGGER IF EXISTS qa_inject ON public.sales; DROP SCHEMA IF EXISTS qa_scaffold CASCADE; DROP SCHEMA IF EXISTS qa_evil CASCADE;");
    expect(sql1("SELECT count(*) FROM pg_trigger WHERE tgname='qa_inject'")).toBe("0");
    return "removed";
  });
});
