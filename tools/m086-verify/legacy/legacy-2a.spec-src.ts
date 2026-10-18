// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Batch 2B, Phase 3 K — empty / malformed replies at the CLIENT boundary:
// the real app modules (callOnlineOnly, the outbox drain, the reply checks)
// against the REAL server RPCs of the disposable loopback stack (085). The
// server commits; only the reply body the app sees is replaced. Effects are
// judged in PostgreSQL. (IndexedDB here is fake-indexeddb: the subject is the
// reply handling, real IndexedDB was Phase 2.) Skipped unless B2B_P3=1.
// ---------------------------------------------------------------------------
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createAuthUser, randomPassword, signedInClient } from "./liveHelpers";
import { runSql, runSqlFile } from "../../e2e/helpers/db";
import { buildQaState, liveCfg } from "../../e2e/helpers/env";

const enabled = process.env.B2B_P3 === "1";
const results: { scenario: string; status: string; detail: string }[] = [];

let mangle: { rpc: string; body: string; status: number; contentType?: string } | null = null;
const sentKeys: { rpc: string; key: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const rpcName = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url)?.[1];
  if (rpcName && init?.body) {
    try { sentKeys.push({ rpc: rpcName, key: JSON.parse(String(init.body)).p_idempotency_key }); } catch { /* not JSON */ }
  }
  const m = mangle;
  const res = await realFetch(input, init);
  if (m && url.includes(`/rest/v1/rpc/${m.rpc}`)) {
    mangle = null;                                   // once: the server HAS committed
    await res.text();
    return new Response(m.body, { status: m.status, headers: { "Content-Type": m.contentType ?? "application/json" } });
  }
  return res;
}) as typeof fetch;

const count = (sql: string, vars: Record<string, string>) => Number(runSql(sql, vars).trim());

describe.skipIf(!enabled)("Batch 2B Phase 3 K — client boundary vs real RPCs", () => {
  let ts = "";
  let st: ReturnType<typeof buildQaState>;
  let app: any;
  let shiftId = "";

  beforeAll(async () => {
    const cfg = liveCfg();
    vi.stubEnv("VITE_SUPABASE_URL", cfg.url);
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", cfg.anonKey);
    ts = String(Date.now());
    const pw = randomPassword();
    const st0 = buildQaState(ts, { admin: "", mgr: "", cashA: "", cashB: "" });
    const ids = {
      admin: await createAuthUser(cfg, st0.emails.admin, pw), mgr: await createAuthUser(cfg, st0.emails.mgr, pw),
      cashA: await createAuthUser(cfg, st0.emails.cashA, pw), cashB: await createAuthUser(cfg, st0.emails.cashB, pw),
    };
    runSqlFile("supabase/tests/phase-d/live/seed.sql", { ts, auth_admin: ids.admin, auth_mgr: ids.mgr, auth_casha: ids.cashA, auth_cashb: ids.cashB });
    st = buildQaState(ts, ids);
    // Outstanding supplier balance (admin creates, manager approves + receives).
    const admin = await signedInClient(cfg, st.emails.admin, pw);
    const mgr = await signedInClient(cfg, st.emails.mgr, pw);
    const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: st.ids.sup, p_notes: "k", p_items: [{ product_id: st.ids.prod2, ordered_qty: 10, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
    const poId = (po.data as any).purchaseOrder.id;
    await mgr.rpc("approve_purchase_order", { p_purchase_order_id: poId, p_idempotency_key: randomUUID() });
    await mgr.rpc("receive_purchase_order", { p_purchase_order_id: poId, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID() });

    // The REAL app modules, configured for the loopback stack.
    const { supabase } = await import("../lib/supabase");
    const { useAuthStore } = await import("../stores/authStore");
    app = {
      supabase, useAuthStore,
      onlineOnly: await import("../stores/data/onlineOnly"),
      outbox: await import("../stores/data/outbox"),
    };
    app.outbox.registerOutboxReconciler("complete_sale", () => undefined);
    const signIn = async (email: string) => {
      const r = await supabase.auth.signInWithPassword({ email, password: pw });
      if (r.error) throw new Error(r.error.message);
    };
    // admin for the payment, then the cashier (own shift) for the sale
    await signIn(st.emails.admin);
    useAuthStore.setState({ currentUserId: st.ids.admin, currentOrgId: st.ids.org, currentRole: "ADMIN" });
    (app as any).signIn = signIn;
    (app as any).pw = pw;
  }, 120_000);

  const payments = () => count(`select count(*) from supplier_payments where supplier_id=:'s'`, { s: st.ids.sup });
  const paid = () => count(`select coalesce(sum(amount_mmk),0) from supplier_payments where supplier_id=:'s' and voided_at is null`, { s: st.ids.sup });
  const keysFor = (rpc: string) => count(`select count(*) from idempotency_keys where org_id=:'o' and rpc=:'r'`, { o: st.ids.org, r: rpc });
  const payArgs = (amount: number) => ({ p_supplier_id: st.ids.sup, p_shop_id: st.ids.shop, p_amount_mmk: amount, p_payment_method: "CASH", p_reference_no: null, p_notes: null, p_idempotency_key: "x" });

  const cases: [string, { body: string; status: number; contentType?: string }][] = [
    ["empty 200 body", { body: "", status: 200 }],
    ["malformed JSON", { body: "{\"supplierPayments\": [", status: 200 }],
    ["JSON of the wrong shape", { body: "{\"ok\":true}", status: 200 }],
    ["empty 404 (proxy/edge)", { body: "", status: 404, contentType: "text/plain" }],
  ];
  for (const [label, reply] of cases) {
    it(`K pay_supplier_lump_sum — ${label}: never reported as success; retried with the same key; ONE payment in PostgreSQL`, async () => {
      const { onlineOnly } = app;
      onlineOnly.resetOnlineOnlyForTests();
      const amount = 100 + results.length;                 // a distinct logical operation per case
      const p0 = payments(); const s0 = paid(); const k0 = keysFor("pay_supplier_lump_sum");
      mangle = { rpc: "pay_supplier_lump_sum", ...reply };
      const first = await onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgs(amount));
      const serverAfterFirst = payments() - p0;
      const sent = sentKeys.filter((k) => k.rpc === "pay_supplier_lump_sum").slice(-4);
      const { replyProblem } = await import("../stores/data/replyShapes");
      if (!first.error) {
        // Accepted ONLY as the server's own replayed result: a later same-key
        // attempt inside the same call, with a reply of the expected shape.
        expect(replyProblem("pay_supplier_lump_sum", first.data)).toBeNull();
        const attempts = sentKeys.filter((k) => k.rpc === "pay_supplier_lump_sum" && k.key === sent[sent.length - 1].key);
        expect(attempts.length).toBeGreaterThanOrEqual(2);
      }
      const listed = await onlineOnly.listUnresolvedOnlineOperations();
      const op = listed.find((o: any) => o.args.p_amount_mmk === amount);
      // an unknown outcome is kept (pending confirmation); a proven refusal is not
      if (first.error?.name === "PendingConfirmationError") expect(op).toBeTruthy();
      let retried = "no retry needed";
      if (op) {
        const r2 = await onlineOnly.retryOnlineOperation(op.id);
        expect(r2.error).toBeNull();
        retried = "retried unchanged → replay";
      }
      const dP = payments() - p0; const dS = paid() - s0; const dK = keysFor("pay_supplier_lump_sum") - k0;
      expect(dP).toBe(1); expect(dS).toBe(amount); expect(dK).toBe(1);
      expect(await onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(0);
      const lastKey = sent[sent.length - 1]?.key;
      const sameKeyAttempts = sentKeys.filter((k) => k.key === lastKey).length;
      const how = first.error
        ? `first: ${first.error.name}/${first.error.failure?.klass ?? "?"} ("${String(first.error.message).slice(0, 50)}")`
        : `the bad reply was retried automatically with the SAME key (${sameKeyAttempts} attempts) and the server's replayed original result (valid shape) was returned`;
      const detail = `${how}; server had it after the call: ${serverAfterFirst}; ${retried}; PostgreSQL: +${dP} payment, +${dS} MMK, +${dK} key`;
      results.push({ scenario: `K pay_supplier_lump_sum ${label}`, status: "PASS", detail });
      console.log(`[p3k] PASS ${label}: ${detail}`);
    }, 60_000);
  }

  it("K complete_sale through the outbox drain — reply of the wrong shape: kept in doubt, resent with the same key, ONE sale", async () => {
    const { outbox, supabase, useAuthStore } = app;
    await (app as any).signIn(st.emails.cashA);
    useAuthStore.setState({ currentUserId: st.ids.cashA, currentOrgId: st.ids.org, currentRole: "CASHIER" });
    const os = await supabase.rpc("open_shift", { p_shop_id: st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: st.ids.cashA, p_idempotency_key: randomUUID() });
    shiftId = (os.data as any).shift.id;
    const sales = () => count(`select count(*) from sales where shift_id=:'s'`, { s: shiftId });
    const key = randomUUID();
    await outbox.enqueueOutbox({
      kind: "rpc", name: "complete_sale", shopId: st.ids.shop, idempotencyKey: key,
      args: { p_shop_id: st.ids.shop, p_shift_id: shiftId, p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0, p_items: [{ product_id: st.ids.prod1, qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString(), p_idempotency_key: key },
    });
    mangle = { rpc: "complete_sale", body: "{\"sale\":null}", status: 200 };
    const r1 = await outbox.drainOutbox();
    const rows = await outbox.listOutboxEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", inDoubt: true, heldReason: "unrecognised-reply", idempotencyKey: key });
    expect(sales()).toBe(1);                              // the server committed it
    const { localDb } = await import("../lib/localDb");
    await localDb.syncOutbox.update(rows[0].localId, { nextAttemptAt: undefined });
    const r2 = await outbox.drainOutbox();
    expect(await outbox.listOutboxEntries()).toHaveLength(0);
    expect(sales()).toBe(1);                              // ONE sale
    expect(count(`select count(*) from idempotency_keys where key=:'k'`, { k: key })).toBe(1);
    const detail = `drain 1: ${r1} (kept, in doubt, unrecognised reply); drain 2: ${r2} (replay, acknowledged); PostgreSQL: 1 sale, 1 key`;
    results.push({ scenario: "K complete_sale (drain) wrong-shape reply", status: "PASS", detail });
    console.log(`[p3k] PASS complete_sale drain: ${detail}`);
  }, 60_000);

  it("write evidence", () => {
    writeFileSync(process.env.B2B_EVIDENCE_K ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  });
});
