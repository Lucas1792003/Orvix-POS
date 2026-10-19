// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// DISASTER-RECOVERY drill seed (deploy/lucashome/backup/tests/dr/run.sh): two synthetic
// organisations with real business activity, made through the real RPCs as the real (synthetic)
// users, on the DISPOSABLE loopback stack only — shifts, sales, a stock adjustment, purchase
// orders, single and lump-sum supplier payments, a storage object; on 086 also the operation
// ledger outcomes (committed / rejected / abandoned). Writes the ids and keys the drill checks
// to DR_STATE (git-ignored results). Skipped unless DR_LIVE=1.
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createAuthUser, makeClient, randomPassword, signedInClient } from "./liveHelpers";
import { runSqlFile } from "../../e2e/helpers/db";
import { buildQaState, liveCfg } from "../../e2e/helpers/env";
import { sql1, v7 } from "./p086-lib";

const enabled = process.env.DR_LIVE === "1";
if (enabled && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER || !process.env.DR_STATE)) {
  throw new Error("DR_LIVE needs E2E_LOOPBACK_ONLY=1, E2E_DB_CONTAINER and DR_STATE (run deploy/lucashome/backup/tests/dr/run.sh)");
}
// a 1x1 PNG (synthetic object bytes)
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

describe.skipIf(!enabled)("DR drill seed", () => {
  it("two organisations with sales, stock, purchase orders, supplier payments, objects and (on 086) operation outcomes", async () => {
    const cfg = liveCfg();
    const pw = randomPassword();
    const has086 = sql1("SELECT to_regprocedure('public.op_execute(uuid,text,jsonb,text)') IS NOT NULL") === "t";
    const ok = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.code} ${r.error.message}`); return r.data; };
    const tenant = async (ts: string) => {
      const st0 = buildQaState(ts, { admin: "", mgr: "", cashA: "", cashB: "" });
      const auth = {
        admin: await createAuthUser(cfg, st0.emails.admin, pw), mgr: await createAuthUser(cfg, st0.emails.mgr, pw),
        cashA: await createAuthUser(cfg, st0.emails.cashA, pw), cashB: await createAuthUser(cfg, st0.emails.cashB, pw),
      };
      runSqlFile("supabase/tests/phase-d/live/seed.sql", { ts, auth_admin: auth.admin, auth_mgr: auth.mgr, auth_casha: auth.cashA, auth_cashb: auth.cashB });
      const st = buildQaState(ts, auth);
      const c = {
        admin: await signedInClient(cfg, st.emails.admin, pw), mgr: await signedInClient(cfg, st.emails.mgr, pw),
        cashA: await signedInClient(cfg, st.emails.cashA, pw),
      };
      return { st, c };
    };
    const call = (c: any, rpc: string, args: any, key: string = randomUUID()) => Promise.resolve(c.rpc(rpc, { ...args, p_idempotency_key: key })).then((r: any) => ({ ...r, key }));

    const out: any = { level: sql1("SELECT max(version) FROM supabase_migrations.schema_migrations"), has086, orgs: [] };
    const base = String(Date.now());
    for (const [i, ts] of [base, String(Number(base) + 7)].entries()) {
      const { st, c } = await tenant(ts);
      const ids = st.ids;
      const o: any = { org: ids.org, shop: ids.shop, sup: ids.sup, users: { admin: ids.admin, mgr: ids.mgr, cashA: ids.cashA }, keys: {}, objects: [] };
      const shift = ok(await call(c.cashA, "open_shift", { p_shop_id: ids.shop, p_opening_cash_mmk: 10000, p_created_at: null, p_expected_actor_id: ids.cashA }), "open_shift").shift.id;
      const sale = (qty: number, paid: number) => ({
        p_shop_id: ids.shop, p_shift_id: shift, p_payment_method: "CASH", p_paid_mmk: paid, p_cart_discount_pct: 0,
        p_items: [{ product_id: ids.prod1, qty, units_per_item: 1 }], p_created_at: new Date().toISOString(),
      });
      o.keys.sales = [];
      o.replay = {};
      for (let n = 0; n < 3 + i; n++) {
        const args = sale(1 + (n % 2), 20000);
        const r = await call(c.cashA, "complete_sale", args);
        ok(r, "complete_sale");
        o.keys.sales.push(r.key);
        if (n === 0) o.replay.sale = { key: r.key, args, saleId: r.data.sale.id };   // replayed through the API after the restore
      }
      ok(await call(c.mgr, "adjust_stock", {
        p_shop_id: ids.shop, p_product_id: ids.prod2, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 5, p_reason: "dr seed",
        p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: ids.mgr,
      }), "adjust_stock");
      const pos: string[] = [];
      for (const total of [4000, 3000]) {
        const po = ok(await call(c.admin, "create_purchase_order", { p_shop_id: ids.shop, p_supplier_id: ids.sup, p_notes: "dr seed", p_items: [{ product_id: ids.prod2, ordered_qty: total / 1000, unit_cost_mmk: 1000 }] }), "create PO");
        const id = po.purchaseOrder.id;
        ok(await call(c.mgr, "approve_purchase_order", { p_purchase_order_id: id }), "approve PO");
        ok(await call(c.mgr, "receive_purchase_order", { p_purchase_order_id: id, p_received_items: null, p_created_at: null, p_expected_actor_id: ids.mgr }), "receive PO");
        pos.push(id);
        await new Promise((r) => setTimeout(r, 5));
      }
      o.pos = pos;
      // a payment that is then VOIDED (paid goes back), then the real single payment
      const voided = await call(c.mgr, "record_supplier_payment", { p_purchase_order_id: pos[0], p_amount_mmk: 700, p_payment_method: "CASH", p_reference_no: "dr-void", p_notes: null, p_created_at: null, p_expected_actor_id: ids.mgr });
      const vpid = ok(voided, "record_supplier_payment (to void)").supplierPayment.id;
      ok(await call(c.admin, "void_supplier_payment", { p_payment_id: vpid, p_reason: "dr seed: entered twice" }), "void_supplier_payment");
      const single = await call(c.mgr, "record_supplier_payment", { p_purchase_order_id: pos[0], p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: "dr-1", p_notes: null, p_created_at: null, p_expected_actor_id: ids.mgr });
      ok(single, "record_supplier_payment");
      o.keys.singlePayment = single.key;
      // a lump sum larger than the oldest order's outstanding (3,000): allocated across both orders
      const lump = await call(c.admin, "pay_supplier_lump_sum", { p_supplier_id: ids.sup, p_shop_id: ids.shop, p_amount_mmk: 3500 + i * 100, p_payment_method: "CASH", p_reference_no: null, p_notes: null });
      ok(lump, "pay_supplier_lump_sum");
      o.keys.lumpSum = lump.key;
      // a legacy-path refusal (v4 key): nothing recorded (B2)
      const refused = await call(c.admin, "pay_supplier_lump_sum", { p_supplier_id: ids.sup, p_shop_id: ids.shop, p_amount_mmk: 99999999, p_payment_method: "CASH", p_reference_no: null, p_notes: null });
      expect(refused.error).toBeTruthy();
      if (has086) {
        const X = (key: string, rpc: string, args: any) => Promise.resolve(c.cashA.rpc("op_execute", { p_key: key, p_rpc: rpc, p_args: args, p_actor_id: ids.cashA }));
        const kc = v7(); const ac = sale(1, 20000);
        expect((await X(kc, "complete_sale", ac)).data).toMatchObject({ outcome: "committed" });
        const kr = v7(); const ar = sale(1000000, 2000000000);
        expect((await X(kr, "complete_sale", ar)).data).toMatchObject({ outcome: "rejected" });
        const ka = v7(); const aa = sale(1, 20000);
        const fence = await Promise.resolve(c.cashA.rpc("op_status", { p_key: ka, p_rpc: "complete_sale", p_fence: true, p_expected_actor_id: ids.cashA, p_args: aa }));
        expect(fence.data).toMatchObject({ status: "abandoned" });
        o.keys.v7 = { committed: kc, rejected: kr, abandoned: ka };
        o.replay.v7 = { committed: { key: kc, args: ac }, rejected: { key: kr, args: ar }, abandoned: { key: ka, args: aa } };
      }
      // a storage object of this organisation (synthetic bytes)
      const path = `products/${ids.prod1}/dr-${ts}.png`;
      const up = await makeClient(cfg, cfg.serviceKey).storage.from("product-images").upload(path, PNG, { contentType: "image/png", upsert: false });
      if (up.error) throw new Error(`upload: ${up.error.message}`);
      o.objects.push(path);
      out.orgs.push(o);
    }
    writeFileSync(process.env.DR_STATE!, JSON.stringify(out, null, 2));
    console.log(`[dr-seed] level ${out.level}, 086=${has086}, orgs ${out.orgs.length}`);
  }, 240_000);
});
