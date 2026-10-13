/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Phase D LIVE integration suite — runs against the self-hosted Supabase
// stack (lucashome) with the real @supabase/supabase-js client and, for the
// offline-queue tests, the real app store modules on fake-indexeddb.
//
// Skipped unless LIVE_SUPABASE_URL is set. Required env:
//   LIVE_SUPABASE_URL, LIVE_ANON_KEY, LIVE_SERVICE_KEY
// Optional: LIVE_SSH_HOST (lucashome), LIVE_QA_TS + LIVE_QA_PASSWORD to reuse
// an existing seed instead of creating one.
//
// Every record the run creates is identifiable (qa- ids, @qa.invalid emails,
// "QA " names) and is removed afterwards by supabase/tests/phase-d/live/
// cleanup.sql (verified by verify_clean.sql). See README.md there.
// ---------------------------------------------------------------------------
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Evidence, liveConfig, makeClient, randomPassword, rawRpc, runSql, runSqlFile, signUpUser, signedInClient,
  sleep, uuid, waitFor, type LiveConfig,
} from "./liveHelpers";

const LIVE = Boolean(process.env.LIVE_SUPABASE_URL);
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const SEED_SQL = new URL("../../supabase/tests/phase-d/live/seed.sql", import.meta.url).pathname;

type Rpc = { data: any; error: any; status: number };
const rpc = async (client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<Rpc> => {
  const res = await client.rpc(name, args);
  return { data: res.data, error: res.error, status: res.status };
};

describe.skipIf(!LIVE)("Phase D live integration (self-hosted stack)", () => {
  const ev = new Evidence();
  let cfg: LiveConfig;
  const ts = process.env.LIVE_QA_TS ?? String(Date.now());
  const password = process.env.LIVE_QA_PASSWORD ?? randomPassword();

  const ids = {
    org: `qa-org-${ts}`, shop: `qa-shop-${ts}`, shop2: `qa-shop2-${ts}`, shopCode: `QA${ts}`,
    admin: `qa-user-admin-${ts}`, mgr: `qa-user-manager-${ts}`,
    cashA: `qa-user-cashier-a-${ts}`, cashB: `qa-user-cashier-b-${ts}`,
    prod1: `qa-prod-1-${ts}`, prod2: `qa-prod-2-${ts}`, prod3: `qa-prod-3-${ts}`,
    unit1: `qa-unit-1-${ts}`, unit2: `qa-unit-2-${ts}`, unit3: `qa-unit-3-${ts}`,
    sup: `qa-sup-${ts}`,
  };
  const emails = {
    admin: `qa-admin-${ts}@qa.invalid`, mgr: `qa-manager-${ts}@qa.invalid`,
    cashA: `qa-cashier-a-${ts}@qa.invalid`, cashB: `qa-cashier-b-${ts}@qa.invalid`,
  };
  const authIds: Record<string, string> = {};

  let svc: SupabaseClient;
  let anon: SupabaseClient;
  let admin: SupabaseClient;
  let mgr: SupabaseClient;
  let cashA: SupabaseClient;
  let cashB: SupabaseClient;

  // Shared across tests (created in order).
  let poReceived = "";
  let poDraft = "";
  let shiftA = "";
  let shiftB = "";

  // ---- DB-side readers (service role bypasses RLS) ------------------------
  const inv = async (productId: string, shopId = ids.shop): Promise<number> => {
    const { data, error } = await svc.from("inventory").select("qty_base_units").eq("shop_id", shopId).eq("product_id", productId).single();
    if (error) throw new Error(`inventory read failed: ${error.message}`);
    return data.qty_base_units as number;
  };
  const count = async (table: string, match: Record<string, unknown>, extra?: (q: any) => any): Promise<number> => {
    let q = svc.from(table).select("*", { count: "exact", head: true }).match(match);
    if (extra) q = extra(q);
    const { count: n, error } = await q;
    if (error) throw new Error(`count ${table} failed: ${error.message}`);
    return n ?? 0;
  };
  const row = async (table: string, match: Record<string, unknown>): Promise<any> => {
    const { data, error } = await svc.from(table).select("*").match(match).maybeSingle();
    if (error) throw new Error(`row ${table} failed: ${error.message}`);
    return data;
  };
  const keyRows = async (keys: string[]): Promise<any[]> => {
    const { data, error } = await svc.from("idempotency_keys").select("key, rpc, actor_id, created_at, response").in("key", keys);
    if (error) throw new Error(`idempotency_keys read failed: ${error.message}`);
    return data ?? [];
  };

  const saleArgs = (shiftId: string, productId: string, qty: number, paid: number, key: string, createdAt: string) => ({
    p_shop_id: ids.shop, p_shift_id: shiftId, p_payment_method: "CASH", p_paid_mmk: paid, p_cart_discount_pct: 0,
    p_items: [{ product_id: productId, qty, units_per_item: 1 }], p_created_at: createdAt, p_idempotency_key: key,
  });
  const sale = (client: SupabaseClient, shiftId: string, productId: string, qty: number, paid: number, key: string, createdAt = new Date().toISOString()) =>
    rpc(client, "complete_sale", saleArgs(shiftId, productId, qty, paid, key, createdAt));

  // =========================================================================
  beforeAll(async () => {
    cfg = liveConfig();
    svc = makeClient(cfg, cfg.serviceKey);
    anon = makeClient(cfg, cfg.anonKey);

    if (!process.env.LIVE_QA_TS) {
      // Auth side first (GoTrue signup, autoconfirm on), then the SQL seed.
      authIds.admin = await signUpUser(cfg, emails.admin, password);
      authIds.mgr = await signUpUser(cfg, emails.mgr, password);
      authIds.cashA = await signUpUser(cfg, emails.cashA, password);
      authIds.cashB = await signUpUser(cfg, emails.cashB, password);
      const out = runSqlFile(cfg, SEED_SQL, {
        ts, auth_admin: authIds.admin, auth_mgr: authIds.mgr, auth_casha: authIds.cashA, auth_cashb: authIds.cashB,
      });
      process.stdout.write(`[seed] ${out.trim()}\n`);
      ev.info("seed", out.trim());
    } else {
      const { data } = await svc.from("users").select("id, auth_id").like("id", `qa-user-%-${ts}`);
      for (const u of data ?? []) {
        if (u.id === ids.admin) authIds.admin = u.auth_id;
        if (u.id === ids.mgr) authIds.mgr = u.auth_id;
        if (u.id === ids.cashA) authIds.cashA = u.auth_id;
        if (u.id === ids.cashB) authIds.cashB = u.auth_id;
      }
    }

    admin = await signedInClient(cfg, emails.admin, password);
    mgr = await signedInClient(cfg, emails.mgr, password);
    cashA = await signedInClient(cfg, emails.cashA, password);
    cashB = await signedInClient(cfg, emails.cashB, password);

    // Sanity: the four public.users rows resolve for their JWTs.
    const me = await cashA.from("users").select("id, role, shop_id, org_id").eq("id", ids.cashA).single();
    expect(me.error).toBeNull();
    expect(me.data).toMatchObject({ id: ids.cashA, role: "CASHIER", shop_id: ids.shop, org_id: ids.org });
    process.stdout.write(`[seed] ts=${ts} shop=${ids.shop} cashierA=${ids.cashA}\n`);
  });

  afterAll(async () => {
    process.stdout.write(`\n[results ts=${ts}]\n${ev.table()}\n\n`);
    for (const c of [admin, mgr, cashA, cashB]) {
      try { await c?.removeAllChannels(); await c?.auth.signOut(); } catch { /* ignore */ }
    }
  });

  // =========================================================================
  it("0. purchase-order workflow: create (admin) -> approve (manager) -> receive (manager), each key replayed once", async () => {
    const kpo = uuid();
    const poArgs = {
      p_shop_id: ids.shop, p_supplier_id: ids.sup, p_notes: "QA weekly order",
      p_items: [{ product_id: ids.prod2, ordered_qty: 50, unit_cost_mmk: 2000 }], p_idempotency_key: kpo,
    };
    const c1 = await rpc(admin, "create_purchase_order", poArgs);
    expect(c1.error).toBeNull();
    const c2 = await rpc(admin, "create_purchase_order", poArgs);
    expect(c2.data).toEqual(c1.data);
    poReceived = c1.data.purchaseOrder.id;
    expect(poReceived).toMatch(/^po-/);

    // self-approval guard: the creator (admin) cannot approve its own PO
    const self = await rpc(admin, "approve_purchase_order", { p_purchase_order_id: poReceived, p_idempotency_key: uuid() });
    expect(self.error?.message).toMatch(/cannot approve your own/i);

    const kap = uuid();
    const a1 = await rpc(mgr, "approve_purchase_order", { p_purchase_order_id: poReceived, p_idempotency_key: kap });
    expect(a1.error).toBeNull();
    expect(a1.data.purchaseOrder.status).toBe("APPROVED");
    const a2 = await rpc(mgr, "approve_purchase_order", { p_purchase_order_id: poReceived, p_idempotency_key: kap });
    expect(a2.data).toEqual(a1.data);

    const before = await inv(ids.prod2);
    const krc = uuid();
    const rcArgs = { p_purchase_order_id: poReceived, p_received_items: null, p_created_at: null, p_expected_actor_id: ids.mgr, p_idempotency_key: krc };
    const r1 = await rpc(mgr, "receive_purchase_order", rcArgs);
    expect(r1.error).toBeNull();
    expect(r1.data.purchaseOrder.status).toBe("RECEIVED");
    const r2 = await rpc(mgr, "receive_purchase_order", rcArgs);
    expect(r2.data).toEqual(r1.data);

    const po = await row("purchase_orders", { id: poReceived });
    expect(po).toMatchObject({ status: "RECEIVED", total_mmk: 100000, shop_id: ids.shop, supplier_id: ids.sup, created_by: ids.admin, approved_by: ids.mgr, received_by: ids.mgr });
    expect(po.paid_mmk ?? 0).toBe(0);
    expect(await inv(ids.prod2)).toBe(before + 50);
    expect(await count("inventory_movements", { reference_id: poReceived, type: "PURCHASE_IN" })).toBe(1);
    expect(await count("purchase_orders", { shop_id: ids.shop })).toBe(1);

    // a DRAFT PO for the cashier-approval permission test (12)
    const d = await rpc(admin, "create_purchase_order", {
      p_shop_id: ids.shop, p_supplier_id: ids.sup, p_notes: "QA draft", p_items: [{ product_id: ids.prod3, ordered_qty: 1, unit_cost_mmk: 1800 }], p_idempotency_key: uuid(),
    });
    expect(d.error).toBeNull();
    poDraft = d.data.purchaseOrder.id;

    ev.pass("0 PO create/approve/receive + replays", `po=${poReceived} RECEIVED total=100000 paid=0; prod2 ${before}->${before + 50}; 1 PURCHASE_IN movement; 3 keys replayed byte-equal; self-approval blocked; draft=${poDraft}`);
  });

  it("1. normal checkout: open_shift + complete_sale (1 item) -> sale row, stock -1, receipt assigned", async () => {
    const kos = uuid();
    const os = await rpc(cashA, "open_shift", { p_shop_id: ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: ids.cashA, p_idempotency_key: kos });
    expect(os.error).toBeNull();
    shiftA = os.data.shift.id;
    expect(shiftA).toMatch(/^shift-/);
    const os2 = await rpc(cashA, "open_shift", { p_shop_id: ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: ids.cashA, p_idempotency_key: kos });
    expect(os2.data).toEqual(os.data);
    expect(await count("shifts", { cashier_id: ids.cashA })).toBe(1);

    const q0 = await inv(ids.prod1);
    const salesBefore = await count("sales", { shop_id: ids.shop });
    const ks = uuid();
    const r = await sale(cashA, shiftA, ids.prod1, 1, 1000, ks);
    expect(r.error).toBeNull();
    expect(r.status).toBe(200);
    const s = r.data.sale;
    expect(s.id).toMatch(/^sale-/);
    expect(s.receiptNo).toMatch(new RegExp(`^${ids.shopCode}-\\d{8}-\\d{4}$`));
    expect(s.totalMmk).toBe(1000);
    expect(r.data.inventory[0].qtyBaseUnits).toBe(q0 - 1);

    const dbSale = await row("sales", { id: s.id });
    expect(dbSale).toMatchObject({ receipt_no: s.receiptNo, shop_id: ids.shop, shift_id: shiftA, cashier_id: ids.cashA, total_mmk: 1000, status: "NORMAL" });
    expect(await count("sale_items", { sale_id: s.id })).toBe(1);
    expect(await count("inventory_movements", { reference_id: s.id, type: "SALE_OUT" })).toBe(1);
    expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
    expect(await inv(ids.prod1)).toBe(q0 - 1);
    const [k] = await keyRows([ks]);
    expect(k).toMatchObject({ rpc: "complete_sale", actor_id: ids.cashA });
    expect(k.response).toEqual(r.data);
    ev.pass("1 normal checkout", `shift=${shiftA} sale=${s.id} receipt=${s.receiptNo} prod1 ${q0}->${q0 - 1} (DB ${await inv(ids.prod1)}); 1 sale_item, 1 SALE_OUT movement; key row stores the response`);
  });

  it("2. duplicate submission: same args + same key twice -> identical response, 1 sale, stock -1", async () => {
    const q0 = await inv(ids.prod1);
    const before = await count("sales", { shop_id: ids.shop });
    const ks = uuid();
    const created = new Date().toISOString();
    const r1 = await sale(cashA, shiftA, ids.prod1, 1, 1000, ks, created);
    const r2 = await sale(cashA, shiftA, ids.prod1, 1, 1000, ks, created);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r2.data).toEqual(r1.data);
    expect(await count("sales", { shop_id: ids.shop })).toBe(before + 1);
    expect(await count("sales", { id: r1.data.sale.id })).toBe(1);
    expect(await inv(ids.prod1)).toBe(q0 - 1);
    expect((await keyRows([ks])).length).toBe(1);
    ev.pass("2 duplicate submission", `key=${ks.slice(0, 8)}… both responses deep-equal, sale=${r1.data.sale.id}, sales ${before}->${before + 1}, prod1 ${q0}->${q0 - 1}`);
  });

  it("3. commit-then-timeout: discard the first response, retry with the same key -> same sale; plus an aborted fetch retried", async () => {
    // (a) response discarded
    const q0 = await inv(ids.prod1);
    const before = await count("sales", { shop_id: ids.shop });
    const ks = uuid();
    const created = new Date().toISOString();
    await sale(cashA, shiftA, ids.prod1, 1, 1000, ks, created); // "lost"
    const retry = await sale(cashA, shiftA, ids.prod1, 1, 1000, ks, created);
    expect(retry.error).toBeNull();
    const dbRow = await row("sales", { id: retry.data.sale.id });
    expect(dbRow.receipt_no).toBe(retry.data.sale.receiptNo);
    expect(await count("sales", { shop_id: ids.shop })).toBe(before + 1);
    expect(await inv(ids.prod1)).toBe(q0 - 1);

    // (b) abort ~1 ms after sending, then retry with the same key
    const { data: sess } = await cashA.auth.getSession();
    const kab = uuid();
    const args = saleArgs(shiftA, ids.prod1, 1, 1000, kab, new Date().toISOString());
    const ctrl = new AbortController();
    const p = rawRpc(cfg, sess!.session!.access_token, "complete_sale", args, ctrl.signal);
    setTimeout(() => ctrl.abort(), 1);
    let firstOutcome = "";
    try {
      const res = await p;
      firstOutcome = `completed status ${res.status}`;
    } catch (err: any) {
      firstOutcome = `aborted (${err?.name})`;
    }
    // Did the aborted request reach Postgres? (key row present => it committed)
    const reachedBefore = (await keyRows([kab])).length;
    const r2 = await rpc(cashA, "complete_sale", args);
    expect(r2.error).toBeNull();
    const dbRow2 = await row("sales", { id: r2.data.sale.id });
    expect(dbRow2).toMatchObject({ receipt_no: r2.data.sale.receiptNo, total_mmk: r2.data.sale.totalMmk, shift_id: shiftA });
    expect(await count("sales", { shop_id: ids.shop })).toBe(before + 2);
    expect(await inv(ids.prod1)).toBe(q0 - 2);
    expect((await keyRows([kab])).length).toBe(1);
    ev.pass("3 commit-then-timeout", `(a) discarded+retry: sale=${retry.data.sale.id} once, prod1 ${q0}->${q0 - 1}; (b) first request ${firstOutcome}, key row before retry=${reachedBefore}, after retry=1, sale=${r2.data.sale.id} matches DB row, prod1 -> ${q0 - 2}; sales ${before}->${before + 2}`);
  });

  it("4. concurrent duplicates: Promise.all of 2 identical calls with the same key -> equal responses, 1 sale, stock -1", async () => {
    const q0 = await inv(ids.prod1);
    const before = await count("sales", { shop_id: ids.shop });
    const ks = uuid();
    const created = new Date().toISOString();
    const [r1, r2] = await Promise.all([
      sale(cashA, shiftA, ids.prod1, 1, 1000, ks, created),
      sale(cashA, shiftA, ids.prod1, 1, 1000, ks, created),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    expect(r2.data).toEqual(r1.data);
    expect(await count("sales", { shop_id: ids.shop })).toBe(before + 1);
    expect(await inv(ids.prod1)).toBe(q0 - 1);
    expect(await count("inventory_movements", { reference_id: r1.data.sale.id })).toBe(1);
    ev.pass("4 concurrent duplicates", `both responses equal (sale=${r1.data.sale.id}), sales ${before}->${before + 1}, prod1 ${q0}->${q0 - 1}, 1 movement`);
  });

  it("5. same key, different payload -> IDEMPOTENCY_MISMATCH (23505/409), no new sale", async () => {
    const q0 = await inv(ids.prod1);
    const before = await count("sales", { shop_id: ids.shop });
    const ks = uuid();
    const ok = await sale(cashA, shiftA, ids.prod1, 1, 1000, ks);
    expect(ok.error).toBeNull();
    const bad = await sale(cashA, shiftA, ids.prod1, 2, 2000, ks);
    expect(bad.error).not.toBeNull();
    expect(bad.error.message).toContain("IDEMPOTENCY_MISMATCH");
    expect(bad.error.code).toBe("23505");
    expect(bad.status).toBe(409);
    expect(await count("sales", { shop_id: ids.shop })).toBe(before + 1);
    expect(await inv(ids.prod1)).toBe(q0 - 1);
    ev.pass("5 key reuse mismatch", `status=${bad.status} code=${bad.error.code} message="${String(bad.error.message).slice(0, 60)}…"; sales ${before}->${before + 1} (only the first), prod1 ${q0}->${q0 - 1}`);
  });

  it("6. adjust_stock by the manager, same key twice -> qty changed once, one inventory_movements row", async () => {
    const q0 = await inv(ids.prod2);
    const ka = uuid();
    const reason = `QA count correction ${ka.slice(0, 8)}`;
    const args = { p_shop_id: ids.shop, p_product_id: ids.prod2, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 5, p_reason: reason, p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: ids.mgr, p_idempotency_key: ka };
    const a1 = await rpc(mgr, "adjust_stock", args);
    const a2 = await rpc(mgr, "adjust_stock", args);
    expect(a1.error).toBeNull();
    expect(a2.data).toEqual(a1.data);
    expect(a1.data.inventory.qtyBaseUnits).toBe(q0 + 5);
    expect(await inv(ids.prod2)).toBe(q0 + 5);
    expect(await count("inventory_movements", { product_id: ids.prod2, reason })).toBe(1);
    expect(await count("audit_logs", { entity_id: ids.prod2, action_type: "STOCK_ADJUSTMENT", actor_id: ids.mgr })).toBe(1);
    ev.pass("6 adjust_stock replay", `prod2 ${q0}->${q0 + 5} once; 1 movement (${a1.data.movement.id}); 1 STOCK_ADJUSTMENT audit row; replay equal`);
  });

  it("7. supplier payments: record_supplier_payment and pay_supplier_lump_sum each replayed -> applied once", async () => {
    const kp = uuid();
    const pArgs = { p_purchase_order_id: poReceived, p_amount_mmk: 30000, p_payment_method: "CASH", p_reference_no: "QA-REF-1", p_notes: null, p_created_at: null, p_expected_actor_id: ids.mgr, p_idempotency_key: kp };
    const p1 = await rpc(mgr, "record_supplier_payment", pArgs);
    const p2 = await rpc(mgr, "record_supplier_payment", pArgs);
    expect(p1.error).toBeNull();
    expect(p2.data).toEqual(p1.data);
    let po = await row("purchase_orders", { id: poReceived });
    expect(po).toMatchObject({ paid_mmk: 30000, payment_status: "PARTIAL" });
    expect(await count("supplier_payments", { purchase_order_id: poReceived })).toBe(1);

    const kl = uuid();
    const lArgs = { p_supplier_id: ids.sup, p_shop_id: ids.shop, p_amount_mmk: 20000, p_payment_method: "BANK", p_reference_no: "QA-REF-2", p_notes: "QA lump", p_idempotency_key: kl };
    const l1 = await rpc(mgr, "pay_supplier_lump_sum", lArgs);
    const l2 = await rpc(mgr, "pay_supplier_lump_sum", lArgs);
    expect(l1.error).toBeNull();
    expect(l2.data).toEqual(l1.data);
    expect(l1.data.supplierPayments).toHaveLength(1);
    po = await row("purchase_orders", { id: poReceived });
    expect(po).toMatchObject({ paid_mmk: 50000, payment_status: "PARTIAL", total_mmk: 100000 });
    expect(await count("supplier_payments", { purchase_order_id: poReceived })).toBe(2);
    expect(await count("audit_logs", { entity_type: "SupplierPayment", action_type: "SUPPLIER_PAYMENT_RECORDED", actor_id: ids.mgr })).toBe(2);
    ev.pass("7 supplier payment replays", `record 30000 once -> paid 30000 PARTIAL, 1 row; lump 20000 once -> paid 50000, 2 rows total; outstanding 50000; both replays equal`);
  });

  it("8. multi-terminal: cashier A and B, 15 concurrent sales each of 1 unit -> stock -30, 30 sales, receipts unique", async () => {
    const kob = uuid();
    const ob = await rpc(cashB, "open_shift", { p_shop_id: ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: ids.cashB, p_idempotency_key: kob });
    expect(ob.error).toBeNull();
    shiftB = ob.data.shift.id;

    const q0 = await inv(ids.prod3);
    const before = await count("sales", { shop_id: ids.shop });
    const jobs = [
      ...Array.from({ length: 15 }, () => ({ client: cashA, shift: shiftA, key: uuid() })),
      ...Array.from({ length: 15 }, () => ({ client: cashB, shift: shiftB, key: uuid() })),
    ];
    const t0 = Date.now();
    const results = await Promise.all(jobs.map((j) => sale(j.client, j.shift, ids.prod3, 1, 3000, j.key)));
    const elapsed = Date.now() - t0;
    const errors = results.filter((r) => r.error).map((r) => r.error.message);
    expect(errors).toEqual([]);
    const saleIds = new Set(results.map((r) => r.data.sale.id));
    const receipts = new Set(results.map((r) => r.data.sale.receiptNo));
    expect(saleIds.size).toBe(30);
    expect(receipts.size).toBe(30);
    expect(results.filter((r) => r.data.sale.cashierId === ids.cashA)).toHaveLength(15);
    expect(results.filter((r) => r.data.sale.cashierId === ids.cashB)).toHaveLength(15);

    expect(await inv(ids.prod3)).toBe(q0 - 30);
    expect(await count("sales", { shop_id: ids.shop })).toBe(before + 30);
    expect(await count("sales", { shift_id: shiftA, cashier_id: ids.cashA }, (q) => q.in("id", [...saleIds]))).toBe(15);
    expect(await count("sales", { shift_id: shiftB, cashier_id: ids.cashB }, (q) => q.in("id", [...saleIds]))).toBe(15);
    const { data: all } = await svc.from("sales").select("receipt_no, created_at").eq("shop_id", ids.shop);
    const perDay = new Map<string, string[]>();
    for (const s of all ?? []) {
      const day = String(s.created_at).slice(0, 10);
      perDay.set(day, [...(perDay.get(day) ?? []), s.receipt_no]);
    }
    for (const [, list] of perDay) expect(new Set(list).size).toBe(list.length);
    expect((await keyRows(jobs.map((j) => j.key))).length).toBe(30);
    expect(await count("inventory_movements", { product_id: ids.prod3, type: "SALE_OUT" })).toBe(30);

    // Close both shifts (replay-safe) so the offline-store tests can open a new one for cashier A.
    for (const [client, shift, actor] of [[cashA, shiftA, ids.cashA], [cashB, shiftB, ids.cashB]] as const) {
      const kc = uuid();
      const cArgs = { p_shift_id: shift, p_closing_cash_mmk: 0, p_variance_reason: "QA close (counted 0)", p_created_at: null, p_expected_actor_id: actor, p_idempotency_key: kc };
      const c1 = await rpc(client, "close_shift", cArgs);
      expect(c1.error).toBeNull();
      const c2 = await rpc(client, "close_shift", cArgs);
      expect(c2.data).toEqual(c1.data);
      expect((await row("shifts", { id: shift })).ended_at).not.toBeNull();
    }
    ev.pass("8 multi-terminal", `30 concurrent sales (A15/B15) in ${elapsed} ms, 0 errors; prod3 ${q0}->${q0 - 30}; sales ${before}->${before + 30}; 30 distinct receipts (unique per shop/day over ${all?.length} rows); 30 key rows; 30 SALE_OUT; shifts A/B closed (close_shift replay equal)`);
  });

  // =========================================================================
  // Offline queue tests with the REAL app store modules.
  // =========================================================================
  let store: any;
  let outbox: typeof import("../stores/data/outbox");
  let localDb: typeof import("../lib/localDb").localDb;
  let appClient: SupabaseClient;
  let authStore: typeof import("../stores/authStore").useAuthStore;
  const fetchSpy = { refreshCalls: 0, rpcBearers: [] as string[] };
  const goOffline = () => vi.stubGlobal("navigator", { onLine: false });
  const goOnline = () => vi.stubGlobal("navigator", { onLine: true });
  const cartItem = () => ({
    id: "c1", productId: ids.prod1, productUnitId: ids.unit1, name: "QA Product One", unitName: "pcs",
    qty: 1, unitPriceMmk: 1000, unitsPerItem: 1, unitBaseQuantity: 1,
  });
  const storedSession = async (): Promise<any> => {
    const auth = appClient.auth as any;
    const raw = await auth.storage.getItem(auth.storageKey);
    return raw ? JSON.parse(raw) : null;
  };
  const writeStoredSession = async (session: any): Promise<void> => {
    const auth = appClient.auth as any;
    await auth.storage.setItem(auth.storageKey, JSON.stringify(session));
  };

  it("9. offline queue replay (real store): open_shift + complete_sale queued offline, drained in order exactly once", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", cfg.url);
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", cfg.anonKey);
    // Fetch spy installed BEFORE the app client is created (supabase-js
    // captures `fetch` at construction): counts token refreshes and records
    // the bearer used on each RPC call.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("grant_type=refresh_token")) fetchSpy.refreshCalls++;
      if (url.includes("/rest/v1/rpc/")) {
        const h = init?.headers ?? {};
        const bearer = typeof h.get === "function" ? h.get("Authorization") : h.Authorization ?? h.authorization;
        if (bearer) fetchSpy.rpcBearers.push(String(bearer).replace(/^Bearer /, ""));
      }
      return realFetch(input, init);
    });
    goOnline();

    ({ supabase: appClient } = await import("../lib/supabase"));
    ({ useDataStore: store } = await import("../stores/data"));
    ({ useAuthStore: authStore } = await import("../stores/authStore"));
    outbox = await import("../stores/data/outbox");
    ({ localDb } = await import("../lib/localDb"));
    const mappers = await import("../stores/data/mappers");
    await Promise.all(localDb.tables.map((t) => t.clear()));

    const login = await authStore.getState().login(emails.cashA, password);
    expect(login.error).toBeNull();
    expect(authStore.getState().currentUserId).toBe(ids.cashA);
    expect(await waitFor(() => localDb.authCache.get(authIds.cashA), 5000)).toBeTruthy();

    // Seed the store with the QA catalogue (what loadData would have pulled).
    const [products, units, inventory] = await Promise.all([
      svc.from("products").select("*").in("id", [ids.prod1, ids.prod2, ids.prod3]),
      svc.from("product_units").select("*").in("id", [ids.unit1, ids.unit2, ids.unit3]),
      svc.from("inventory").select("*").eq("shop_id", ids.shop),
    ]);
    store.setState({
      products: products.data!.map(mappers.mapProduct), productUnits: units.data!.map(mappers.mapProductUnit),
      inventory: inventory.data!.map(mappers.mapInventory), shifts: [], sales: [], saleItems: [], movements: [],
      auditLogs: [], refunds: [], refundVoidRequests: [], priceTiers: [], priceLevels: [], productUnitPrices: [],
    });
    const q0 = await inv(ids.prod1);

    goOffline();
    const provisionalShift = await store.getState().startShift({ shopId: ids.shop, cashierId: ids.cashA, openingCashMmk: 0 });
    expect(store.getState().shifts[0]).toMatchObject({ id: provisionalShift, pendingSync: true });
    const provisionalSale = await store.getState().createSale({
      shopId: ids.shop, cashierId: ids.cashA, shiftId: provisionalShift, cartItems: [cartItem()], cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: 1000,
    });
    expect(store.getState().sales[0]).toMatchObject({ id: provisionalSale, pendingSync: true, receiptNo: "PENDING" });
    const queued = await outbox.listOutboxEntries();
    expect(queued.map((e) => e.name)).toEqual(["open_shift", "complete_sale"]);
    expect(queued.map((e) => (e as any).seq)).toEqual([1, 2]);
    expect(queued[1].refs).toEqual([{ field: "p_shift_id", provisionalId: provisionalShift }]);
    const shiftKey = queued[0].idempotencyKey!;
    const saleKey = queued[1].idempotencyKey!;
    expect(queued[0].args?.p_expected_actor_id).toBe(ids.cashA);

    goOnline();
    const result = await outbox.drainOutbox();
    expect(result).toBe("drained");
    expect(await localDb.syncOutbox.count()).toBe(0);
    const realShift = store.getState().shifts[0];
    const realSale = store.getState().sales[0];
    expect(realShift.id).toMatch(/^shift-/);
    expect(realShift.id).not.toBe(provisionalShift);
    expect(realShift.pendingSync).toBeUndefined();
    expect(realSale.id).toMatch(/^sale-/);
    expect(realSale.shiftId).toBe(realShift.id);
    expect(realSale.receiptNo).toMatch(new RegExp(`^${ids.shopCode}-`));

    const dbShift = await row("shifts", { id: realShift.id });
    expect(dbShift).toMatchObject({ cashier_id: ids.cashA, shop_id: ids.shop, ended_at: null });
    const dbSale = await row("sales", { id: realSale.id });
    expect(dbSale).toMatchObject({ shift_id: realShift.id, cashier_id: ids.cashA, receipt_no: realSale.receiptNo });
    const keys = await keyRows([shiftKey, saleKey]);
    const kShift = keys.find((k) => k.key === shiftKey)!;
    const kSale = keys.find((k) => k.key === saleKey)!;
    expect(kShift.rpc).toBe("open_shift");
    expect(kSale.rpc).toBe("complete_sale");
    expect(new Date(kShift.created_at).getTime()).toBeLessThan(new Date(kSale.created_at).getTime());
    expect(await inv(ids.prod1)).toBe(q0 - 1);
    expect(await count("sales", { shift_id: realShift.id })).toBe(1);
    ev.pass("9 offline queue replay (real store)", `outbox seq [1,2] = [open_shift, complete_sale] (sale refs provisional shift); drain=${result}; shift ${provisionalShift.slice(0, 14)}…->${realShift.id}; sale ->${realSale.id} ${realSale.receiptNo}; server order shift_key ${kShift.created_at} < sale_key ${kSale.created_at}; prod1 ${q0}->${q0 - 1}; outbox empty`);
  });

  it("10a. tampered access token + valid refresh token: the drain refreshes and continues", async () => {
    goOffline();
    const q0 = await inv(ids.prod1);
    const provisionalSale = await store.getState().createSale({
      shopId: ids.shop, cashierId: ids.cashA, shiftId: store.getState().shifts[0].id, cartItems: [cartItem()], cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: 1000,
    });
    expect(await localDb.syncOutbox.count()).toBe(1);
    goOnline();

    const stored = await storedSession();
    expect(stored?.access_token).toBeTruthy();
    const claims = (jwt: string): any => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    // GoTrue access tokens carry no jti: a token refreshed within the same
    // second as the original is byte-identical. Wait so `iat` must advance.
    await sleep(1100);
    const [h, p, sig] = stored.access_token.split(".");
    const tamperedSig = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    const tampered = `${h}.${p}.${tamperedSig}`;
    // The server rejects the tampered token outright.
    const probe = await fetch(`${cfg.url}/rest/v1/shops?select=id&limit=1`, { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${tampered}` } });
    expect(probe.status).toBe(401);
    // Persist it as the device's session (expired, so the drain's preflight refreshes).
    await writeStoredSession({ ...stored, access_token: tampered, expires_at: Math.floor(Date.now() / 1000) - 120, expires_in: 0 });
    const refreshBefore = fetchSpy.refreshCalls;
    const bearersBefore = fetchSpy.rpcBearers.length;

    const result = await outbox.drainOutbox();
    expect(result).toBe("drained");
    expect(fetchSpy.refreshCalls).toBeGreaterThan(refreshBefore);
    const after = await storedSession();
    expect(after.access_token).not.toBe(tampered);
    expect(claims(after.access_token).iat).toBeGreaterThan(claims(stored.access_token).iat);
    expect(claims(after.access_token).session_id).toBe(claims(stored.access_token).session_id);
    expect(after.expires_at * 1000).toBeGreaterThan(Date.now());
    const probeAfter = await fetch(`${cfg.url}/rest/v1/shops?select=id&limit=1`, { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${after.access_token}` } });
    expect(probeAfter.status).toBe(200);
    const usedBearers = fetchSpy.rpcBearers.slice(bearersBefore);
    expect(usedBearers).not.toContain(tampered);
    expect(usedBearers).toContain(after.access_token);
    expect(await localDb.syncOutbox.count()).toBe(0);
    const realSale = store.getState().sales.find((s: any) => !s.pendingSync && s.id !== provisionalSale && s.shiftId === store.getState().shifts[0].id && s.id.startsWith("sale-"));
    expect(realSale).toBeTruthy();
    expect(await count("sales", { shift_id: store.getState().shifts[0].id })).toBe(2);
    expect(await inv(ids.prod1)).toBe(q0 - 1);
    expect(await outbox.readNeedsReauth()).toBe(false);
    ev.pass("10a tampered JWT + refresh", `tampered bearer -> HTTP ${probe.status}; drain=${result}; refresh calls +${fetchSpy.refreshCalls - refreshBefore}; new token iat ${claims(stored.access_token).iat}->${claims(after.access_token).iat} (same session_id), accepted by server (HTTP ${probeAfter.status}); RPC sent with the NEW token, tampered token never sent; sale synced, prod1 ${q0}->${q0 - 1}`);
  });

  it("10b. refresh tokens revoked server-side: drain reports needs-reauth, nothing lost; sign in again -> drains", async () => {
    goOffline();
    const q0 = await inv(ids.prod1);
    const shiftId = store.getState().shifts[0].id;
    const salesBefore = await count("sales", { shift_id: shiftId });
    await store.getState().createSale({
      shopId: ids.shop, cashierId: ids.cashA, shiftId, cartItems: [cartItem()], cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: 1000,
    });
    const [entry] = await outbox.listOutboxEntries();
    expect(entry.name).toBe("complete_sale");
    goOnline();

    // Revoke: delete this auth user's sessions (refresh_tokens cascade).
    const deleted = runSql(cfg, `WITH d AS (DELETE FROM auth.sessions WHERE user_id = '${authIds.cashA}' RETURNING 1) SELECT count(*) FROM d;`).trim();
    expect(Number(deleted)).toBeGreaterThan(0);
    // Force the next drain to need a refresh (access token expired locally).
    const stored = await storedSession();
    await writeStoredSession({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 120, expires_in: 0 });
    const refreshBefore = fetchSpy.refreshCalls;

    const result = await outbox.drainOutbox();
    expect(result).toBe("needs-reauth");
    expect(fetchSpy.refreshCalls).toBeGreaterThan(refreshBefore);
    expect(await outbox.readNeedsReauth()).toBe(true);
    const pending = await outbox.listOutboxEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ localId: entry.localId, status: "pending" });
    expect((await keyRows([entry.idempotencyKey!])).length).toBe(0);
    expect(await count("sales", { shift_id: shiftId })).toBe(salesBefore);
    const again = await outbox.drainOutbox();
    expect(again).toBe("needs-reauth");

    // Sign in again (what the login page + AppLayout's SIGNED_IN listener do).
    const login = await authStore.getState().login(emails.cashA, password);
    expect(login.error).toBeNull();
    await outbox.clearNeedsReauth();
    const drained = await outbox.drainOutbox();
    expect(drained).toBe("drained");
    expect(await localDb.syncOutbox.count()).toBe(0);
    expect(await count("sales", { shift_id: shiftId })).toBe(salesBefore + 1);
    expect((await keyRows([entry.idempotencyKey!])).length).toBe(1);
    expect(await inv(ids.prod1)).toBe(q0 - 1);
    ev.pass("10b revoked refresh token", `auth.sessions deleted=${deleted}; drain=${result} (refresh attempted +${fetchSpy.refreshCalls - refreshBefore}); entry kept pending, no sale/key row; after sign-in drain=${drained}; sale committed once, prod1 ${q0}->${q0 - 1}`);
  });

  it("11. staff-user creation: admin create_app_user (+replay), cashier denied, p_org_id rejected", async () => {
    const staffEmail = `qa-staff-${ts}@qa.invalid`;
    const staffAuth = await signUpUser(cfg, staffEmail, password);
    const staffId = `qa-user-staff-${ts}`;
    const ku = uuid();
    const args = { p_id: staffId, p_name: "QA Staff", p_email: staffEmail, p_role: "CASHIER", p_shop_id: ids.shop, p_auth_id: staffAuth, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: ku };
    const u1 = await rpc(admin, "create_app_user", args);
    expect(u1.error).toBeNull();
    expect(u1.data).toMatchObject({ id: staffId, orgId: ids.org, role: "CASHIER", shopId: ids.shop });
    const u2 = await rpc(admin, "create_app_user", args);
    expect(u2.data).toEqual(u1.data);
    const dbUser = await row("users", { id: staffId });
    expect(dbUser).toMatchObject({ org_id: ids.org, role: "CASHIER", shop_id: ids.shop, auth_id: staffAuth, is_active: true });
    expect(await count("users", { id: staffId })).toBe(1);
    expect(await count("audit_logs", { entity_id: staffId, action_type: "USER_CREATED", actor_id: ids.admin })).toBe(1);
    // The new staff member can actually sign in and resolve their own row.
    const staffClient = await signedInClient(cfg, staffEmail, password);
    const meRow = await staffClient.from("users").select("id, org_id").eq("auth_id", staffAuth).single();
    expect(meRow.data).toMatchObject({ id: staffId, org_id: ids.org });
    await staffClient.auth.signOut();

    // Unauthorized: a cashier
    const denied = await rpc(cashA, "create_app_user", { ...args, p_id: `qa-user-staff2-${ts}`, p_email: `qa-staff2-${ts}@qa.invalid`, p_auth_id: null, p_idempotency_key: uuid() });
    expect(denied.error?.message).toMatch(/not permitted/i);
    expect(await count("users", { id: `qa-user-staff2-${ts}` })).toBe(0);

    // Attempt to pass p_org_id -> PostgREST cannot resolve the function
    const orgAttempt = await rpc(admin, "create_app_user", { ...args, p_id: `qa-user-staff3-${ts}`, p_org_id: "qa-org-other", p_idempotency_key: uuid() });
    expect(orgAttempt.error?.code).toBe("PGRST202");
    expect(await count("users", { id: `qa-user-staff3-${ts}` })).toBe(0);
    ev.pass("11 staff-user creation", `created ${staffId} org_id=${ids.org}, USER_CREATED audit=1, replay equal, 1 row, new staff can sign in; cashier -> "${denied.error?.message}"; p_org_id -> ${orgAttempt.error?.code} (${String(orgAttempt.error?.message).slice(0, 70)}…), no row`);
  });

  it("12. RLS/RPC authorization: cross-shop reads empty, cashier cannot approve, anon denied, service role reads all", async () => {
    const { data: realShops } = await svc.from("shops").select("id").not("id", "like", "qa-%").limit(1);
    const realShop = realShops?.[0]?.id;
    expect(realShop).toBeTruthy();
    const xsSales = await cashA.from("sales").select("id").eq("shop_id", realShop);
    const xsInv = await cashA.from("inventory").select("product_id").eq("shop_id", realShop);
    expect(xsSales.error).toBeNull();
    expect(xsSales.data).toEqual([]);
    expect(xsInv.error).toBeNull();
    expect(xsInv.data).toEqual([]);
    const realSalesSvc = await count("sales", { shop_id: realShop });
    const realInvSvc = await count("inventory", { shop_id: realShop });
    // own shop is readable (sanity, so the empty result above is RLS, not an empty table)
    const own = await cashA.from("inventory").select("product_id").eq("shop_id", ids.shop);
    expect(own.data!.length).toBe(3);

    const appr = await rpc(cashA, "approve_purchase_order", { p_purchase_order_id: poDraft, p_idempotency_key: uuid() });
    expect(appr.error?.message).toMatch(/not permitted/i);
    expect((await row("purchase_orders", { id: poDraft })).status).toBe("DRAFT");

    const anonSale = await rpc(anon, "complete_sale", saleArgs(shiftA, ids.prod1, 1, 1000, uuid(), new Date().toISOString()));
    expect(anonSale.error?.code).toBe("42501");
    expect(anonSale.error?.message).toMatch(/permission denied/i);
    const anonProducts = await anon.from("products").select("id").limit(5);
    expect(anonProducts.error).toBeNull();
    expect(anonProducts.data).toEqual([]);

    const svcProducts = await count("products", {});
    const svcUsers = await count("users", {});
    const svcKeys = await count("idempotency_keys", {});
    const svcQaSales = await count("sales", { shop_id: ids.shop });
    expect(svcProducts).toBeGreaterThanOrEqual(542);
    expect(svcUsers).toBeGreaterThanOrEqual(5);
    expect(svcKeys).toBeGreaterThan(30);
    expect(svcQaSales).toBeGreaterThanOrEqual(35);
    ev.pass("12 RLS/RPC authorization", `cashier A: real-shop sales=[] inventory=[] (service role sees ${realSalesSvc}/${realInvSvc} rows there), own shop inventory 3 rows; cashier approve -> "${appr.error?.message}"; anon complete_sale -> ${anonSale.error?.code}; anon products -> []; service role: products=${svcProducts} users=${svcUsers} idempotency_keys=${svcKeys} qa sales=${svcQaSales}`);
  });

  it("13. anonymous phone-upload token security", async () => {
    const notes: string[] = [];
    const check = (name: string, ok: boolean, detail: string) => {
      notes.push(`${name}: ${ok ? "PASS" : "FAIL"} (${detail})`);
      expect(ok, `${name}: ${detail}`).toBe(true);
    };
    const publicUrl = (p: string) => `${cfg.url}/storage/v1/object/public/product-images/${p}`;

    const c = await rpc(admin, "create_product_image_upload_session", { p_shop_id: ids.shop, p_product_id: ids.prod1 });
    expect(c.error).toBeNull();
    const token: string = c.data.token;
    check("token shape", /^[0-9a-f]{128}$/.test(token), `${token.length} hex chars (4 x gen_random_uuid)`);
    const sessRow = await row("product_image_upload_sessions", { id: c.data.sessionId });
    check("stored hash only", sessRow.token_hash.length === 64 && sessRow.token_hash !== token && !JSON.stringify(sessRow).includes(token), "token_hash is 64 hex (sha256), raw token absent from the row");
    check("expiry ~10 min", Math.abs(new Date(sessRow.expires_at).getTime() - new Date(sessRow.created_at).getTime() - 600_000) < 5_000, `expires_at - created_at = ${(new Date(sessRow.expires_at).getTime() - new Date(sessRow.created_at).getTime()) / 1000}s`);
    check("scope columns", sessRow.product_id === ids.prod1 && sessRow.shop_id === ids.shop && sessRow.created_by === ids.admin && (sessRow.storage_path === `temp/${c.data.sessionId}` || sessRow.storage_path === `org/${sessRow.storage_path.split("/")[1]}/temp/${c.data.sessionId}`), `product_id=${sessRow.product_id} shop_id=${sessRow.shop_id} created_by=${sessRow.created_by} storage_path=${sessRow.storage_path}`);

    const g = await rpc(anon, "get_product_image_upload_session_by_token", { p_token: token });
    check("anon get by token", g.error === null && g.data.sessionId === c.data.sessionId && g.data.status === "PENDING", `keys=${Object.keys(g.data ?? {}).sort().join(",")}`);
    const exposed = Object.keys(g.data ?? {}).sort();
    check("exposes only phone fields", exposed.join(",") === "bytes,expiresAt,mimeType,publicUrl,sessionId,status,storagePath,uploadToken" && !("token" in g.data) && !("createdBy" in g.data) && !("productId" in g.data) && !("shopId" in g.data), `no token/hash/created_by/product_id/shop_id; uploadToken=${g.data.uploadToken}`);

    const wrong = await rpc(anon, "get_product_image_upload_session_by_token", { p_token: token.slice(0, -4) + (token.endsWith("0000") ? "1111" : "0000") });
    check("wrong token", wrong.error !== null && /invalid upload link/i.test(wrong.error.message), wrong.error?.message ?? "no error");
    const short = await rpc(anon, "get_product_image_upload_session_by_token", { p_token: "abc" });
    check("short token", short.error !== null && /invalid upload link/i.test(short.error.message), short.error?.message ?? "no error");
    const wrongComplete = await rpc(anon, "complete_product_image_upload_session", { p_token: token.slice(0, -4) + "ffff", p_storage_path: sessRow.storage_path, p_public_url: publicUrl(sessRow.storage_path), p_bytes: 1000, p_mime_type: "image/webp" });
    check("complete with wrong token", wrongComplete.error !== null, wrongComplete.error?.message ?? "no error");

    // Expired session (expires_at set in the past via service role)
    const upd = await svc.from("product_image_upload_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", c.data.sessionId).select("id");
    expect(upd.error).toBeNull();
    const gExp = await rpc(anon, "get_product_image_upload_session_by_token", { p_token: token });
    const compExp = await rpc(anon, "complete_product_image_upload_session", { p_token: token, p_storage_path: sessRow.storage_path, p_public_url: publicUrl(sessRow.storage_path), p_bytes: 1000, p_mime_type: "image/webp" });
    const expRow = await row("product_image_upload_sessions", { id: c.data.sessionId });
    check("expired: get returns EXPIRED w/o upload token, complete rejected", gExp.data?.status === "EXPIRED" && gExp.data?.uploadToken === null && compExp.error !== null && expRow.status === "EXPIRED", `get.status=${gExp.data?.status} complete="${compExp.error?.message}" db.status=${expRow.status}`);

    // Canceled session
    const c2 = await rpc(admin, "create_product_image_upload_session", { p_shop_id: ids.shop, p_product_id: ids.prod1 });
    const cancel = await rpc(admin, "cancel_product_image_upload_session", { p_session_id: c2.data.sessionId });
    expect(cancel.error).toBeNull();
    const gCan = await rpc(anon, "get_product_image_upload_session_by_token", { p_token: c2.data.token });
    const compCan = await rpc(anon, "complete_product_image_upload_session", { p_token: c2.data.token, p_storage_path: c2.data.storagePath, p_public_url: publicUrl(c2.data.storagePath), p_bytes: 1000, p_mime_type: "image/webp" });
    check("canceled: get shows CANCELED, complete rejected", gCan.data?.status === "CANCELED" && compCan.error !== null, `get.status=${gCan.data?.status} complete="${compCan.error?.message}"`);

    // Complete twice with a valid token
    const c3 = await rpc(admin, "create_product_image_upload_session", { p_shop_id: ids.shop, p_product_id: ids.prod1 });
    const compArgs = { p_token: c3.data.token, p_storage_path: c3.data.storagePath, p_public_url: publicUrl(c3.data.storagePath), p_bytes: 1234, p_mime_type: "image/webp" };
    const comp1 = await rpc(anon, "complete_product_image_upload_session", compArgs);
    const comp2 = await rpc(anon, "complete_product_image_upload_session", compArgs);
    const c3Row = await row("product_image_upload_sessions", { id: c3.data.sessionId });
    check("complete once", comp1.error === null && comp1.data.status === "COMPLETED" && c3Row.status === "COMPLETED" && c3Row.bytes === 1234, `status=${comp1.data?.status} db.bytes=${c3Row.bytes}`);
    notes.push(`second complete: ${comp2.error ? `REJECTED ("${comp2.error.message}") - not idempotent, by design (PENDING guard)` : "ACCEPTED (idempotent replay)"}`);
    check("complete twice -> second rejected or identical", comp2.error !== null || JSON.stringify(comp2.data) === JSON.stringify(comp1.data), comp2.error?.message ?? "identical");
    // bad inputs on a fresh session: wrong path, oversized, bad mime, data: URL
    const c4 = await rpc(admin, "create_product_image_upload_session", { p_shop_id: ids.shop, p_product_id: ids.prod1 });
    const badPath = await rpc(anon, "complete_product_image_upload_session", { ...compArgs, p_token: c4.data.token, p_storage_path: "temp/other" });
    const badSize = await rpc(anon, "complete_product_image_upload_session", { ...compArgs, p_token: c4.data.token, p_storage_path: c4.data.storagePath, p_public_url: publicUrl(c4.data.storagePath), p_bytes: 200_000 });
    const badMime = await rpc(anon, "complete_product_image_upload_session", { ...compArgs, p_token: c4.data.token, p_storage_path: c4.data.storagePath, p_public_url: publicUrl(c4.data.storagePath), p_mime_type: "image/png" });
    const badUrl = await rpc(anon, "complete_product_image_upload_session", { ...compArgs, p_token: c4.data.token, p_storage_path: c4.data.storagePath, p_public_url: "data:image/webp;base64,AAAA" });
    check("complete validates path/size/mime/url", [badPath, badSize, badMime, badUrl].every((r) => r.error !== null) && (await row("product_image_upload_sessions", { id: c4.data.sessionId })).status === "PENDING", `"${badPath.error?.message}" / "${badSize.error?.message}" / "${badMime.error?.message}" / "${badUrl.error?.message}"`);

    // anon cannot call anything else
    // Real parameter names so PostgREST resolves the function and Postgres
    // answers with the EXECUTE denial (42501), not a PGRST202 lookup miss.
    const others: Record<string, Record<string, unknown>> = {
      create_product_image_upload_session: { p_shop_id: ids.shop, p_product_id: ids.prod1 },
      get_product_image_upload_session_status: { p_session_id: c.data.sessionId },
      attach_product_image_upload_session_token: { p_session_id: c.data.sessionId, p_signed_upload_token: "x" },
      cancel_product_image_upload_session: { p_session_id: c.data.sessionId },
      open_shift: { p_shop_id: ids.shop, p_opening_cash_mmk: 0, p_idempotency_key: uuid() },
      adjust_stock: { p_shop_id: ids.shop, p_product_id: ids.prod1, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "x", p_idempotency_key: uuid() },
      create_app_user: { p_id: "qa-user-anon", p_name: "QA Anon", p_email: "qa-anon@qa.invalid", p_role: "CASHIER", p_shop_id: ids.shop, p_auth_id: null, p_idempotency_key: uuid() },
    };
    const codes: string[] = [];
    for (const [fn, args] of Object.entries(others)) {
      const r = await rpc(anon, fn, args);
      codes.push(`${fn}=${r.error?.code}`);
    }
    expect(await count("users", { id: "qa-user-anon" })).toBe(0);
    check("anon other RPCs -> 42501", codes.every((x) => x.endsWith("=42501")), codes.join(" "));
    // anon cannot read the sessions table either
    const anonSessions = await anon.from("product_image_upload_sessions").select("id").limit(1);
    check("anon select sessions -> []", anonSessions.error === null && anonSessions.data?.length === 0, `rows=${anonSessions.data?.length}`);
    // scoping: all QA sessions point at QA product/shop only
    const qaSessions = await svc.from("product_image_upload_sessions").select("id, product_id, shop_id, created_by, storage_path").eq("created_by", ids.admin);
    check("session scoping", (qaSessions.data ?? []).length >= 4 && qaSessions.data!.every((s) => s.product_id === ids.prod1 && s.shop_id === ids.shop), `${qaSessions.data?.length} sessions, all product_id=${ids.prod1} shop_id=${ids.shop}`);
    // No upload is performed in this suite (the RPC validates the URL string
    // only), so no QA storage object must exist for any QA session path.
    // (PostgREST does not expose the storage schema here, so this goes over SQL.)
    // the session's own path: temp/<id> before migration 079, org/<org>/temp/<id> after
    const qaPaths = (qaSessions.data ?? []).map((s) => s.storage_path as string);
    const qaObjs = runSql(cfg, `SELECT count(*) FROM storage.objects WHERE name = ANY(ARRAY[${qaPaths.map((p) => `'${p}'`).join(",")}]::text[]);`).trim();
    check("no QA storage object created", qaObjs === "0", `storage.objects rows for ${qaPaths.length} QA session paths = ${qaObjs}`);

    ev.pass("13 phone-upload token security", notes.join("; "));
    process.stdout.write(`[13 phone-upload]\n - ${notes.join("\n - ")}\n`);
  });

  it("14. Realtime: cashier A receives the inventory UPDATE for its shop, not for another shop", async () => {
    const events: any[] = [];
    const systemMsgs: any[] = [];
    const channel = cashA.channel(`qa-inv-${ts}`);
    channel.on("postgres_changes", { event: "UPDATE", schema: "public", table: "inventory" }, (payload) => events.push(payload));
    // "SUBSCRIBED" only acknowledges the channel join. The postgres_changes
    // subscription is live once Realtime confirms it with a system message
    // ("Subscribed to PostgreSQL") - on this stack the first subscriber also
    // starts the tenant's CDC poller, which can take a few seconds.
    (channel as any).on("system", {}, (payload: any) => systemMsgs.push(payload));
    const tSub = Date.now();
    const status = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("TIMEOUT(20s)"), 20_000);
      channel.subscribe((s, err) => {
        if (s === "SUBSCRIBED") { clearTimeout(timer); resolve(s); }
        if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") { clearTimeout(timer); resolve(`${s}${err ? `: ${err.message}` : ""}`); }
      });
    });
    expect(status).toBe("SUBSCRIBED");
    const ready = await waitFor(() => Promise.resolve(systemMsgs.find((m) => m.extension === "postgres_changes" && m.status === "ok")), 20_000, 100);
    const readyMs = Date.now() - tSub;
    expect(ready, `postgres_changes never confirmed; system messages: ${JSON.stringify(systemMsgs)}`).toBeTruthy();
    await sleep(500);

    const q0 = await inv(ids.prod1);
    const adj = await rpc(mgr, "adjust_stock", { p_shop_id: ids.shop, p_product_id: ids.prod1, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA realtime own shop", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: ids.mgr, p_idempotency_key: uuid() });
    expect(adj.error).toBeNull();
    const t0 = Date.now();
    const own = await waitFor(() => Promise.resolve(events.find((e) => e.new?.shop_id === ids.shop && e.new?.product_id === ids.prod1)), 10_000, 100);
    const latency = Date.now() - t0;
    expect(own, "no UPDATE event for own shop within 10 s").toBeTruthy();
    expect(own!.new.qty_base_units).toBe(q0 + 1);
    expect(own!.eventType).toBe("UPDATE");
    expect(await inv(ids.prod1)).toBe(q0 + 1);

    // Other shop (second QA shop; admin may adjust any shop)
    const q20 = await inv(ids.prod1, ids.shop2);
    const before = events.length;
    const adj2 = await rpc(admin, "adjust_stock", { p_shop_id: ids.shop2, p_product_id: ids.prod1, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA realtime other shop", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: ids.admin, p_idempotency_key: uuid() });
    expect(adj2.error).toBeNull();
    expect(await inv(ids.prod1, ids.shop2)).toBe(q20 + 1);
    await sleep(6000);
    const leaked = events.slice(before).filter((e) => e.new?.shop_id === ids.shop2);
    expect(leaked).toEqual([]);
    await cashA.removeChannel(channel);
    ev.pass("14 realtime inventory", `subscribe=${status}, postgres_changes confirmed after ${readyMs} ms; own-shop UPDATE received in ${latency} ms with qty ${own!.new.qty_base_units} (DB ${q0}->${q0 + 1}); other-shop update (${ids.shop2} ${q20}->${q20 + 1}) delivered 0 events in 6 s; total events seen=${events.length}`);
  });
});
