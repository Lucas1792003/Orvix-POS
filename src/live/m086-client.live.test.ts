// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// MIGRATION 086 STAGE 1 — the REAL client modules (data store, sale slice,
// write-ahead, outbox drain, online-only operations, verified reload) against
// the REAL PostgREST/PostgreSQL of the disposable loopback stack. One
// process (IndexedDB = fake-indexeddb, kept for the whole run):
//   part A: the server WITHOUT 086 functions (documented functions-only
//           rollback applied first) — the new client falls back / holds;
//   part B: 086 re-applied — held operations are resolved safely.
// Every scenario is judged in PostgreSQL. Skipped unless M086_LIVE=1.
// ---------------------------------------------------------------------------
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createAuthUser, randomPassword, signedInClient } from "./liveHelpers";
import { runSql, runSqlFile } from "../../e2e/helpers/db";
import { buildQaState, liveCfg } from "../../e2e/helpers/env";

const enabled = process.env.M086_LIVE === "1";
// These tests apply and roll back migration 086: ONLY the disposable loopback
// stack (tools/m086-verify/run.sh sets both), never a configured real server.
if (enabled && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("M086_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run tools/m086-verify/run.sh)");
}
const results: { task: string; id: string; title: string; status: string; detail: unknown }[] = [];
const sql1 = (q: string) => runSql(q).trim();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- network fault injection at the fetch boundary (the app's supabase-js) ----
type Fault = { rpc: string; mode: "drop-before" | "drop-after" | "401" | "503" | "hang-after" | "hold-503" | "gate-503" | "gate-forward" | "commit-gate" | "pgrst202"; key?: string; gate?: string };
/** Named gates (post-checkpoint pass): a request waits at its gate until the test opens it. */
const gates = new Map<string, () => void>();
const waitGate = (name: string) => new Promise<void>((resolve) => { gates.set(name, resolve); });
const openGate = (name: string) => { const g = gates.get(name); if (!g) throw new Error(`gate ${name} not reached`); gates.delete(name); g(); };
/** A held request: never forwarded; answered 503 "no healthy upstream" when the test releases it. */
let releaseHeld: (() => void) | null = null;
let fault: Fault | null = null;
/** Further faults, consumed in order per RPC (after `fault`). */
const faults: Fault[] = [];
const log: { rpc: string; key?: string; fence?: boolean; status?: number }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url)?.[1];
  let body: any = null;
  if (rpc && init?.body) { try { body = JSON.parse(String(init.body)); } catch { /* not json */ } }
  const entry = { rpc: rpc ?? "", key: body?.p_key ?? body?.p_idempotency_key, fence: body?.p_fence };
  if (rpc) log.push(entry);
  let f = fault && fault.rpc === rpc ? fault : null;
  if (f) fault = null;
  else if (rpc) {
    const i = faults.findIndex((x) => x.rpc === rpc && (!x.key || x.key === entry.key));
    if (i >= 0) f = faults.splice(i, 1)[0];
  }
  if (rpc && f) {
    if (f.mode === "hold-503") {
      return new Promise<Response>((resolve) => {
        releaseHeld = () => resolve(new Response("no healthy upstream", { status: 503, headers: { "Content-Type": "text/plain" } }));
      });
    }
    if (f.mode === "pgrst202") {
      // a stale PostgREST schema cache: "function not found" (nothing ran)
      (entry as any).status = 404;
      return new Response(JSON.stringify({ code: "PGRST202", message: `Could not find the function public.${rpc} in the schema cache`, details: null, hint: null }),
        { status: 404, headers: { "Content-Type": "application/json" } });
    }
    if (f.mode === "gate-503") {
      await waitGate(f.gate!);
      (entry as any).status = 503;
      return new Response("no healthy upstream", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
    if (f.mode === "gate-forward") {
      await waitGate(f.gate!);
      const res = await realFetch(input, init);
      (entry as any).status = res.status;
      return res;
    }
    if (f.mode === "commit-gate") {
      const res = await realFetch(input, init);   // reaches the server and commits; the reply waits at the gate
      const text = await res.text();
      await waitGate(f.gate!);
      (entry as any).status = res.status;
      return new Response(text, { status: res.status, headers: res.headers });
    }
    if (f.mode === "503") {
      (entry as any).status = 503;
      return new Response("no healthy upstream", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
    if (f.mode === "hang-after") {
      const res = await realFetch(input, init);   // reaches the server and commits ...
      await res.text();
      return new Promise<Response>(() => undefined); // ... and the process "dies" before the reply
    }
    if (f.mode === "401") {
      (entry as any).status = 401;
      return new Response(JSON.stringify({ code: "PGRST301", message: "JWT expired", details: null, hint: null }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (f.mode === "drop-before") throw new TypeError("Failed to fetch");
    const res = await realFetch(input, init);
    await res.text();
    throw new TypeError("Failed to fetch"); // the server answered; the reply is lost
  }
  const res = await realFetch(input, init);
  if (rpc) (entry as any).status = res.status;
  return res;
}) as typeof fetch;

function T(task: string, id: string, title: string, fn: () => Promise<any>, timeout = 180_000) {
  it(`${id} ${title}`, async () => {
    try { const d = await fn(); results.push({ task, id, title, status: "PASS", detail: d ?? "" }); console.log(`[m086c] PASS ${id}`); }
    catch (e: any) { results.push({ task, id, title, status: "FAIL", detail: String(e?.stack ?? e).slice(0, 2500) }); console.log(`[m086c] FAIL ${id}: ${String(e?.message ?? e).slice(0, 500)}`); throw e; }
  }, timeout);
}

describe.skipIf(!enabled)("086 Stage 1 client (real modules, real server)", () => {
  const cfg = enabled ? liveCfg() : (null as any);
  const pw = randomPassword();
  let st: ReturnType<typeof buildQaState>;
  let app: any;
  let shiftId = "";
  const held: Record<string, any> = {};

  const sales = () => Number(sql1(`SELECT count(*) FROM sales WHERE shift_id = ${lit(shiftId)}`));
  const ledger = (key: string) => sql1(`SELECT coalesce((SELECT state || '/' || coalesce(outcome_code,'') FROM idempotency_keys WHERE key = ${lit(key)}::uuid), '<none>')`);
  const rowsOf = async () => app.localDb.syncOutbox.toArray();
  /** A drain pass of our own, after any pass the app started itself has finished. */
  const drain = async (): Promise<string> => {
    for (let i = 0; i < 300; i++) {
      const r = await app.outbox.drainOutbox();
      if (r !== "already-running" && r !== "locked") return r;
      await delay(100);
    }
    throw new Error("the app's own drain never finished");
  };
  const cart = (prod: string, unit: string, qty: number, price: number) => [{
    id: randomUUID(), productId: prod, productUnitId: unit, name: "QA", unitName: "pcs", qty, unitPriceMmk: price,
    unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: `qa-pl-retail-${st.ts}`,
  }];
  /** complete_sale arguments as the 2A/086 clients build them (no key). */
  const saleInputArgs = (prod: string, qty: number, price: number) => ({
    p_shop_id: st.ids.shop, p_shift_id: shiftId, p_payment_method: "CASH", p_paid_mmk: qty * price, p_cart_discount_pct: 0,
    p_items: [{ product_id: prod, qty, units_per_item: 1 }], p_created_at: new Date().toISOString(),
  });
  const saleInput = (prod: string, unit: string, qty: number, price: number) => ({
    shopId: st.ids.shop, cashierId: st.ids.cashA, shiftId, cartItems: cart(prod, unit, qty, price), cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: qty * price,
  });
  const online = (on: boolean) => vi.stubGlobal("navigator", { onLine: on });
  const offlineAuth = async (valid: boolean) => {
    await app.localDb.authCache.clear();
    if (valid) {
      await app.localDb.authCache.put({
        authId: st.authIds.cashA, userId: st.ids.cashA, role: "CASHIER", shopId: st.ids.shop, orgId: st.ids.org,
        isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
      });
    }
  };
  const signInApp = async (who: "cashA" | "cashB" | "admin", role = "CASHIER") => {
    const r = await app.supabase.auth.signInWithPassword({ email: st.emails[who], password: pw });
    if (r.error) throw new Error(r.error.message);
    app.useAuthStore.setState({ currentUserId: st.ids[who], currentOrgId: st.ids.org, currentRole: role, currentAuthId: st.authIds[who] });
  };
  const mgrAdjust = async (prod: string, delta: number) => {
    const c = await signedInClient(cfg, st.emails.mgr, pw);
    const r = await c.rpc("adjust_stock", {
      p_shop_id: st.ids.shop, p_product_id: prod, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: delta, p_reason: "m086 client",
      p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID(),
    });
    if (r.error) throw new Error(`adjust: ${r.error.message}`);
  };
  const serverQty = (prod: string) => Number(sql1(`SELECT qty_base_units FROM inventory WHERE shop_id=${lit(st.ids.shop)} AND product_id=${lit(prod)}`));

  beforeAll(async () => {
    vi.stubEnv("VITE_SUPABASE_URL", cfg.url);
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", cfg.anonKey);
    const ts = String(Date.now() + 101);
    const st0 = buildQaState(ts, { admin: "", mgr: "", cashA: "", cashB: "" });
    const ids = {
      admin: await createAuthUser(cfg, st0.emails.admin, pw), mgr: await createAuthUser(cfg, st0.emails.mgr, pw),
      cashA: await createAuthUser(cfg, st0.emails.cashA, pw), cashB: await createAuthUser(cfg, st0.emails.cashB, pw),
    };
    runSqlFile("supabase/tests/phase-d/live/seed.sql", { ts, auth_admin: ids.admin, auth_mgr: ids.mgr, auth_casha: ids.cashA, auth_cashb: ids.cashB });
    st = buildQaState(ts, ids);
    // Part A: the server WITHOUT the 086 functions (documented rollback).
    runSql(readFileSync(process.env.M086_ROLLBACK!, "utf8"));
    const c = await signedInClient(cfg, st.emails.cashA, pw);
    const os = await c.rpc("open_shift", { p_shop_id: st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: st.ids.cashA, p_idempotency_key: randomUUID() });
    if (os.error) throw new Error(os.error.message);
    shiftId = (os.data as any).shift.id;
    online(true);
    const idem = await import("../stores/data/idempotentRpc");
    idem.setExecutorCapabilityForTests("unknown", false);
    app = {
      idem,
      supabase: (await import("../lib/supabase")).supabase,
      localDb: (await import("../lib/localDb")).localDb,
      useAuthStore: (await import("../stores/authStore")).useAuthStore,
      useDataStore: (await import("../stores/data/index")).useDataStore,
      outbox: await import("../stores/data/outbox"),
      onlineOnly: await import("../stores/data/onlineOnly"),
      prompt: await import("../stores/data/operationPrompt"),
    };
    app.prompt.registerOperationPrompt(async () => "new");
    await signInApp("cashA");
    await app.useDataStore.getState().loadData({ force: true });
    if (!app.useDataStore.getState().isLoaded) throw new Error(`initial load failed: ${app.useDataStore.getState().loadError}`);
  }, 300_000);

  afterAll(() => {
    writeFileSync(process.env.P086_EVIDENCE ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), results, requestLog: log.slice(-200) }, null, 2));
  });

  // ============================ PART A: server without 086 ============================
  T("A", "A1", "server without 086: an eligible queued sale -> op_execute absent (PGRST202) -> direct RPC, same key; one sale", async () => {
    online(false);
    await offlineAuth(true);
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 1, 1000));
    online(true);
    const [row] = await rowsOf();
    const n0 = sales();
    await drain();
    expect(sales()).toBe(n0 + 1);
    expect(log.filter((l) => l.rpc === "op_execute" && l.key === row.idempotencyKey).map((l) => l.status)).toEqual([404]);
    expect(log.filter((l) => l.rpc === "complete_sale" && l.key === row.idempotencyKey)).toHaveLength(1);
    expect(ledger(row.idempotencyKey)).toBe("committed/");
    expect(app.idem.executorCapability()).toBe("absent");
    expect(await app.localDb.syncOutbox.count()).toBe(0);
    return { path: "op_execute 404 PGRST202 -> complete_sale (same key)", sales: "+1", capability: "absent" };
  });

  T("A", "A2", "server without 086: unknown outcome + NOT authorised offline -> 'Not recorded on this till'; held, NEVER sent again", async () => {
    await offlineAuth(false);               // the offline window has lapsed
    fault = { rpc: "complete_sale", mode: "drop-before" };
    const n0 = sales();
    let msg = "";
    try { await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 2, 1000)); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/Not recorded on this till/);
    const [row] = await rowsOf();
    expect(row).toMatchObject({ fenceRequired: true, staged: false, inDoubt: true });
    app.idem.setExecutorCapabilityForTests("unknown", false);
    await drain();
    const [after] = await rowsOf();
    expect(after).toMatchObject({ heldReason: "needs-server-086", status: "conflict" });
    expect(after.lastError).toMatch(/NOT recorded on this till/);
    expect(log.filter((l) => l.rpc === "complete_sale" && l.key === row.idempotencyKey)).toHaveLength(1); // the dropped one only
    expect(sales()).toBe(n0);
    expect(ledger(row.idempotencyKey)).toBe("<none>");
    held.a2 = row;
    return { message: msg.slice(0, 120), held: after.heldReason, resent: 0, server: "no sale, no ledger row" };
  });

  // ============================ PART B: 086 re-applied ============================
  T("B", "B0", "086 re-applied (forward recovery after the rollback)", async () => {
    runSql(`BEGIN;\n${readFileSync(process.env.M086_MIGRATION!, "utf8")}\nCOMMIT;`);
    for (let i = 0; i < 80; i++) {
      const r = await app.idem.lookupOperation("complete_sale", randomUUID());
      if (!r.absent && !r.error) return "op_status reachable";
      await delay(250);
    }
    throw new Error("PostgREST never exposed op_status");
  });

  T("B", "B1", "C1: the held operation is now looked up and FENCED (abandoned) — never executed; the late copy is refused", async () => {
    app.idem.setExecutorCapabilityForTests("unknown", false);
    await app.localDb.syncOutbox.update(held.a2.localId, { nextAttemptAt: undefined });
    const n0 = sales();
    await drain();
    const row = (await rowsOf()).find((r: any) => r.localId === held.a2.localId);
    expect(row).toMatchObject({ status: "conflict", serverOutcome: "abandoned" });
    expect(ledger(held.a2.idempotencyKey)).toBe("abandoned/FENCED");
    expect(log.filter((l) => l.rpc === "op_status" && l.key === held.a2.idempotencyKey && l.fence === true).length).toBeGreaterThanOrEqual(1);
    const c = await signedInClient(cfg, st.emails.cashA, pw);
    const { p_idempotency_key: k, ...args } = held.a2.args;
    const late = await c.rpc("op_execute", { p_key: k, p_rpc: "complete_sale", p_args: args, p_actor_id: st.ids.cashA });
    const legacy = await c.rpc("complete_sale", held.a2.args);
    expect(late.data).toEqual({ outcome: "abandoned", replayed: true });
    expect(legacy.error?.message).toMatch(/^OP_EXECUTOR_REQUIRED/);   // a UUIDv7 key never runs through a legacy RPC on 086
    expect(sales()).toBe(n0);
    return { outcome: "abandoned (fenced by its own actor)", lateExecutor: late.data, lateLegacy: "OP_EXECUTOR_REQUIRED", sales: "unchanged" };
  });

  T("B", "B2", "B2 through the real drain: offline sale, server stock gone -> refused & recorded FINAL; restock -> never executes", async () => {
    await offlineAuth(true);
    online(false);
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod2, st.ids.unit2, 3, 2000));
    online(true);
    const row = (await rowsOf()).find((r: any) => r.status === "pending" && r.name === "complete_sale");
    await mgrAdjust(st.ids.prod2, -serverQty(st.ids.prod2));
    const n0 = sales();
    await drain();
    const after = (await rowsOf()).find((r: any) => r.localId === row.localId);
    expect(after).toMatchObject({ status: "conflict", serverOutcome: "rejected" });
    expect(ledger(row.idempotencyKey)).toBe("rejected/P0001");
    await mgrAdjust(st.ids.prod2, 50);
    await drain();
    await expect(app.outbox.retryOutboxEntry(row.localId)).rejects.toThrow(/refused this operation for good/);
    expect(sales()).toBe(n0);
    expect(log.filter((l) => l.rpc === "op_execute" && l.key === row.idempotencyKey)).toHaveLength(1);
    const pending = await (await import("../stores/data/pendingStock")).pendingStockDeltas();
    expect(pending.get(`${st.ids.shop}|${st.ids.prod2}`) ?? 0).toBe(0);
    return { refusal: after.lastError.slice(0, 100), ledger: "rejected/P0001", afterRestock: "no sale; Retry refused; stock effect released" };
  });

  T("B", "B3", "lost reply after commit (authorised offline): kept in doubt; the drain's replay reconciles it once", async () => {
    await offlineAuth(true);
    fault = { rpc: "op_execute", mode: "drop-after" };
    const n0 = sales();
    let msg = "";
    try { await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 1, 1000)); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/Pending confirmation/);
    expect(sales()).toBe(n0 + 1);
    const row = (await rowsOf()).find((r: any) => r.status === "pending" && r.inDoubt === true && r.fenceRequired !== true);
    expect(row).toMatchObject({ staged: true });
    await drain();
    expect((await rowsOf()).some((r: any) => r.localId === row.localId)).toBe(false);
    expect(sales()).toBe(n0 + 1);
    const serverSaleId = sql1(`SELECT response->'sale'->>'id' FROM idempotency_keys WHERE key = ${lit(row.idempotencyKey)}::uuid`);
    expect(app.useDataStore.getState().sales.some((s: any) => s.id === serverSaleId)).toBe(true);
    return { serverSales: "+1 exactly", reconciled: "local sale = server sale id", outbox: "acknowledged" };
  });

  T("B", "B4", "finding 1: cashier A's queued sale (committed, reply lost) is NOT executed or refused in cashier B's session; cashier A then reconciles it once", async () => {
    await offlineAuth(true);
    online(false);
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 1, 1000));
    online(true);
    const row = (await rowsOf()).find((r: any) => r.status === "pending" && r.name === "complete_sale");
    expect(row.actorId).toBe(st.ids.cashA);
    // cashier A's request DID reach the server (committed), reply lost
    const ca = await signedInClient(cfg, st.emails.cashA, pw);
    const { p_idempotency_key: k, ...args } = row.args;
    const first = await ca.rpc("op_execute", { p_key: k, p_rpc: "complete_sale", p_args: args, p_actor_id: st.ids.cashA });
    expect((first.data as any).outcome).toBe("committed");
    const n0 = sales();
    const before = log.length;
    await signInApp("cashB");
    await drain();
    const parked = (await rowsOf()).find((r: any) => r.localId === row.localId);
    expect(parked).toMatchObject({ status: "pending", heldReason: "needs-original-user" });
    expect(log.slice(before).filter((l) => l.key === k)).toHaveLength(0);      // never even sent in B's session
    await signInApp("cashA");
    await app.localDb.syncOutbox.update(row.localId, { nextAttemptAt: undefined });
    await drain();
    expect((await rowsOf()).some((r: any) => r.localId === row.localId)).toBe(false);
    expect(sales()).toBe(n0);                                                   // replayed, not re-sold
    const serverSaleId = (first.data as any).response.sale.id;
    expect(app.useDataStore.getState().sales.some((s: any) => s.id === serverSaleId)).toBe(true);
    return { cashBSession: "parked 'needs-original-user', 0 requests", cashASession: "replay -> reconciled once", serverSales: "unchanged (no second sale)" };
  });

  T("B", "B4b", "finding 4+5: legacy (Batch 2A) rows — a write-ahead row in doubt with nothing staged and no actor is HELD; a cashier cannot resolve it; an ADMIN resolves it with server-verified org evidence (committed -> reconciled once; never arrived -> fenced)", async () => {
    // Two rows exactly as the Batch 2A build left them: v4 keys, no actorId / staged / fenceRequired.
    const committedKey = randomUUID();
    const neverKey = randomUUID();
    const a1 = { ...saleInputArgs(st.ids.prod1, 1, 1000), p_idempotency_key: committedKey };
    const a2 = { ...saleInputArgs(st.ids.prod1, 2, 1000), p_idempotency_key: neverKey };
    const ca = await signedInClient(cfg, st.emails.cashA, pw);
    const direct1 = await ca.rpc("complete_sale", a1);                         // it DID reach the server (085 path, v4)
    expect(direct1.error).toBeNull();
    const base = { kind: "rpc", name: "complete_sale", shopId: st.ids.shop, status: "pending", attempts: 1, writeAhead: true, inDoubt: true,
      backendOrigin: (await rowsOf())[0]?.backendOrigin ?? new URL(cfg.url).origin, createdAt: new Date().toISOString() };
    await app.localDb.syncOutbox.bulkPut([
      { ...base, localId: `legacy-${committedKey}`, args: a1, idempotencyKey: committedKey, seq: 9001 },
      { ...base, localId: `legacy-${neverKey}`, args: a2, idempotencyKey: neverKey, seq: 9002 },
    ]);
    const n0 = sales();
    const logFrom = log.length;
    await signInApp("cashA");
    await drain();
    // the committed one: the server's own record names cashier A, so her lookup reconciles it (once, nothing resent)
    expect((await rowsOf()).some((x: any) => x.idempotencyKey === committedKey)).toBe(false);
    // the never-arrived one: no actor anywhere -> held for an administrator
    expect((await rowsOf()).find((x: any) => x.idempotencyKey === neverKey))
      .toMatchObject({ status: "conflict", fenceRequired: true, heldReason: "needs-administrator" });
    expect(log.slice(logFrom).filter((l) => (l.rpc === "op_execute" || l.rpc === "complete_sale") && (l.key === neverKey || l.key === committedKey))).toHaveLength(0);
    await signInApp("admin", "ADMIN");
    await app.localDb.syncOutbox.update(`legacy-${neverKey}`, { nextAttemptAt: undefined });
    await drain();
    expect((await rowsOf()).find((x: any) => x.idempotencyKey === neverKey)).toMatchObject({ serverOutcome: "abandoned" });
    expect(ledger(neverKey)).toBe("abandoned/FENCED");
    expect(sql1(`SELECT coalesce(actor_id, '<null>') FROM idempotency_keys WHERE key = ${lit(neverKey)}::uuid`)).toBe("<null>");
    expect(sales()).toBe(n0);
    const late = await ca.rpc("complete_sale", a2);                              // the delayed v4 copy
    expect(late.error?.message).toMatch(/^IDEMPOTENCY_MISMATCH/);
    expect(sales()).toBe(n0);
    await signInApp("cashA");
    return { cashierSession: "committed one reconciled by its recorded actor (no resend, no second sale); never-arrived one held 'needs-administrator'", admin: "fenced it (actor NULL, organisation verified from the shop/shift)", lateV4Copy: "IDEMPOTENCY_MISMATCH" };
  });

  T("B", "B4c", "finding 7: 'new sale' while the earlier one is unresolved — committed earlier: recorded instead, nothing new; never arrived: fenced, then the new sale goes through", async () => {
    await offlineAuth(true);
    app.prompt.registerOperationPrompt(async () => "new");
    // (a) the earlier attempt DID commit (reply lost) -> staged in doubt
    fault = { rpc: "op_execute", mode: "drop-after" };
    const n0 = sales();
    await expect(app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 1, 1000))).rejects.toThrow(/Pending confirmation/);
    expect(sales()).toBe(n0 + 1);
    const execBefore = log.filter((l) => l.rpc === "op_execute").length;
    await expect(app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 1, 1000))).rejects.toThrow(/has now been recorded/);
    expect(sales()).toBe(n0 + 1);                                             // nothing new rung up
    expect(log.filter((l) => l.rpc === "op_execute").length).toBe(execBefore);
    // (b) the earlier attempt never arrived -> staged in doubt
    fault = { rpc: "op_execute", mode: "drop-before" };
    await expect(app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 2, 1000))).rejects.toThrow(/Pending confirmation/);
    const earlier = (await rowsOf()).find((r: any) => r.inDoubt === true && r.status === "pending" && (r.args.p_items[0].qty === 2));
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 2, 1000));   // "new" -> fence, then sell
    expect(ledger(earlier.idempotencyKey)).toBe("abandoned/FENCED");
    expect(sales()).toBe(n0 + 2);                                             // exactly the new one
    return { committedEarlier: "recorded; no new sale", neverArrived: "fenced (abandoned), then the new sale committed", serverSales: "+2 exactly" };
  });

  T("D", "D1", "finding 3 (downgrade): the OLD Batch 2A drain code on the same IndexedDB never executes a held operation or a stranded UUIDv7 write-ahead row (086 server)", async () => {
    // State the new build can leave behind: a held (conflict + fenceRequired) v7 operation, and a v7
    // write-ahead row stranded in 'syncing' by a crash.
    const kHeld = app.idem.newIdempotencyKey();
    const kSync = app.idem.newIdempotencyKey();
    const mk = (k: string, qty: number) => ({ ...saleInputArgs(st.ids.prod1, qty, 1000), p_idempotency_key: k });
    const origin = new URL(cfg.url).origin;
    const common = { kind: "rpc", name: "complete_sale", shopId: st.ids.shop, writeAhead: true, inDoubt: true, actorId: st.ids.cashA,
      backendOrigin: origin, createdAt: new Date().toISOString() };
    await app.localDb.syncOutbox.bulkPut([
      { ...common, localId: `held-${kHeld}`, args: mk(kHeld, 1), idempotencyKey: kHeld, status: "conflict", fenceRequired: true, staged: false, attempts: 1, seq: 9101 },
      { ...common, localId: `sync-${kSync}`, args: mk(kSync, 1), idempotencyKey: kSync, status: "syncing", attempts: 0, syncingSince: new Date(0).toISOString(), seq: 9102 },
    ]);
    const n0 = sales();
    // The OLD build (ae51e69), its own modules, the same IndexedDB.
    const OLD = process.env.M086_OLD_APP!;
    const oldSupabase = (await import(`${OLD}/src/lib/supabase.ts`)).supabase;
    const oldAuth = (await import(`${OLD}/src/stores/authStore.ts`)).useAuthStore;
    const oldOutbox = await import(`${OLD}/src/stores/data/outbox.ts`);
    const r = await oldSupabase.auth.signInWithPassword({ email: st.emails.cashA, password: pw });
    if (r.error) throw new Error(r.error.message);
    oldAuth.setState({ currentUserId: st.ids.cashA, currentOrgId: st.ids.org, currentRole: "CASHIER" });
    oldOutbox.registerOutboxReconciler("complete_sale", () => undefined);
    oldOutbox.simulateNewAppInstanceForTests();
    for (let i = 0; i < 3; i++) {
      let res = await oldOutbox.drainOutbox();
      for (let j = 0; j < 100 && (res === "already-running" || res === "locked"); j++) { await delay(100); res = await oldOutbox.drainOutbox(); }
      for (const x of await app.localDb.syncOutbox.toArray()) if (x.status === "pending") await app.localDb.syncOutbox.update(x.localId, { nextAttemptAt: undefined });
    }
    expect(sales()).toBe(n0);
    expect(ledger(kHeld)).toBe("<none>");
    expect(ledger(kSync)).toBe("<none>");
    const after = await app.localDb.syncOutbox.toArray();
    const held = after.find((x: any) => x.idempotencyKey === kHeld);
    const sync = after.find((x: any) => x.idempotencyKey === kSync);
    expect(held.status).toBe("conflict");                                       // never picked up by the old drain
    expect(log.filter((l) => l.key === kHeld)).toHaveLength(0);
    const syncSends = log.filter((l) => l.rpc === "complete_sale" && l.key === kSync);
    expect(syncSends.length).toBeGreaterThanOrEqual(1);                          // the old build DID resend it...
    expect(syncSends.every((l) => l.status === 400)).toBe(true);                 // ...and the 086 server refused it
    // tidy up so later tests see a clean queue
    await app.localDb.syncOutbox.bulkDelete([`held-${kHeld}`, `sync-${kSync}`]);
    return { heldOperation: "not sent by the old drain (status conflict)", strandedV7Row: `resent ${syncSends.length}x by the old build, refused (OP_EXECUTOR_REQUIRED) — never executed`, oldRowStatus: sync?.status, serverSales: "unchanged" };
  });

  T("B", "B5", "online-only money operation: refusal recorded and settled; a committed lost reply is settled by Check without resending", async () => {
    await signInApp("admin" as any, "ADMIN");
    const payArgs = (amount: number) => ({ p_supplier_id: st.ids.sup, p_shop_id: st.ids.shop, p_amount_mmk: amount, p_payment_method: "CASH", p_reference_no: null, p_notes: null });
    const pays = () => Number(sql1(`SELECT count(*) FROM supplier_payments WHERE supplier_id = ${lit(st.ids.sup)}`));
    const p0 = pays();
    const refused = await app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgs(1000)); // no outstanding balance
    expect(refused.serverOutcome).toBe("rejected");
    const refusedKey = log.filter((l) => l.rpc === "op_execute").at(-1)!.key!;
    expect(ledger(refusedKey)).toMatch(/^rejected\//);
    expect(await app.onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(0);
    // an outstanding balance, then a payment whose reply is lost
    const admin = await signedInClient(cfg, st.emails.admin, pw);
    const mgr = await signedInClient(cfg, st.emails.mgr, pw);
    const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: st.ids.sup, p_notes: "m086", p_items: [{ product_id: st.ids.prod3, ordered_qty: 5, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
    const poId = (po.data as any).purchaseOrder.id;
    await mgr.rpc("approve_purchase_order", { p_purchase_order_id: poId, p_idempotency_key: randomUUID() });
    await mgr.rpc("receive_purchase_order", { p_purchase_order_id: poId, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID() });
    fault = { rpc: "op_execute", mode: "drop-after" };
    const lost = await app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgs(2000), { retries: 0 });
    expect(lost.error?.name).toBe("PendingConfirmationError");
    const [op] = await app.onlineOnly.listUnresolvedOnlineOperations();
    const executes = log.filter((l) => l.rpc === "op_execute").length;
    const checked = await app.onlineOnly.checkOnlineOperation(op.id);
    expect(checked.status?.status).toBe("committed");
    expect(log.filter((l) => l.rpc === "op_execute").length).toBe(executes);
    expect(await app.onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(0);
    expect(pays()).toBe(p0 + 1);
    return { refusal: refused.error?.message?.slice(0, 80), ledger: "rejected", lostReply: "Check -> committed, settled, nothing resent", payments: "+1 exactly" };
  });

  // ===================== STABILIZATION PASS (client, real server) =====================
  /** An offline-queued sale, turned into a HELD row (as the till leaves one whose outcome it never learned). */
  const heldSale = async (qty: number, over: Record<string, unknown> = {}) => {
    online(false);
    await offlineAuth(true);
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, qty, 1000));
    const row = (await rowsOf()).find((r: any) => r.name === "complete_sale" && r.status === "pending" && r.args.p_items[0].qty === qty);
    await app.localDb.syncOutbox.update(row.localId, {
      status: "conflict", fenceRequired: true, inDoubt: true, writeAhead: true, staged: false, heldReason: "status-unreachable",
      nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString(), ...over,
    });
    return row;
  };
  const execAsCashA = async (row: any) => {
    const ca = await signedInClient(cfg, st.emails.cashA, pw);
    const { p_idempotency_key: k, ...args } = row.args;
    return (await ca.rpc("op_execute", { p_key: k, p_rpc: "complete_sale", p_args: args, p_actor_id: st.ids.cashA })).data as any;
  };

  T("S", "S1", "H1: a HELD earlier attempt that DID commit stays visible — the same sale again ('new') records the original; no second sale", async () => {
    await signInApp("cashA");
    const row = await heldSale(3);
    expect((await execAsCashA(row)).outcome).toBe("committed");      // it reached the server; the till never learned it
    const n0 = sales();
    online(true);
    app.prompt.registerOperationPrompt(async () => "new");
    const execBefore = log.filter((l) => l.rpc === "op_execute").length;
    await expect(app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 3, 1000))).rejects.toThrow(/has now been recorded/);
    expect(sales()).toBe(n0);
    expect(log.filter((l) => l.rpc === "op_execute").length).toBe(execBefore);
    expect(log.some((l) => l.rpc === "op_status" && l.key === row.idempotencyKey && l.fence === true)).toBe(true);
    expect(await app.localDb.syncOutbox.get(row.localId)).toBeUndefined();
    return { heldCommitted: "seen by duplicate-sale prevention", replacement: "refused: the original is recorded", serverSales: "unchanged" };
  });

  T("S", "S2", "H1: a SET-ASIDE undecided attempt stays visible — 'new' fences it first (it never ran), then exactly one new sale", async () => {
    const row = await heldSale(4);
    await app.localDb.syncOutbox.update(row.localId, { status: "archived", statusBeforeArchive: "conflict", archivedAt: new Date().toISOString() });
    online(true);
    const n0 = sales();
    let asked = 0;
    app.prompt.registerOperationPrompt(async () => { asked += 1; return "new"; });
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 4, 1000));
    expect(asked).toBe(1);
    expect(ledger(row.idempotencyKey)).toBe("abandoned/FENCED");
    expect(sales()).toBe(n0 + 1);
    expect(await app.localDb.syncOutbox.get(row.localId)).toMatchObject({ status: "archived", serverOutcome: "abandoned" });
    app.prompt.registerOperationPrompt(async () => "new");
    return { setAside: "asked about; fenced (abandoned) before the replacement", serverSales: "+1 exactly", row: "stays set aside, decided" };
  });

  T("S", "S3", "H2 restock -> sale through the real drain: the manager's queued restock heads the queue; the cashier's sale never overtakes it", async () => {
    online(false);
    const kR = app.idem.newIdempotencyKey();
    app.useAuthStore.setState({ currentUserId: st.ids.mgr, currentRole: "MANAGER" });
    await app.outbox.enqueueOutbox({ kind: "rpc", name: "adjust_stock", shopId: st.ids.shop, args: {
      p_shop_id: st.ids.shop, p_product_id: st.ids.prod1, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 5, p_reason: "m086 restock",
      p_product_unit_id: null, p_unit_qty: null, p_created_at: new Date().toISOString(), p_expected_actor_id: st.ids.mgr, p_idempotency_key: kR,
    } });
    await signInApp("cashA");
    await offlineAuth(true);
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 1, 1000));
    const saleRow = (await rowsOf()).find((r: any) => r.name === "complete_sale" && r.status === "pending");
    online(true);
    const n0 = sales();
    expect(await drain()).toBe("backoff");
    expect(log.filter((l) => l.key === saleRow.idempotencyKey)).toHaveLength(0);
    expect(ledger(kR)).toBe("<none>");
    // the manager on this till: restock goes; the cashier's sale is not run in the manager's session
    const mgrAuth = await app.supabase.auth.signInWithPassword({ email: st.emails.mgr, password: pw });
    if (mgrAuth.error) throw new Error(mgrAuth.error.message);
    app.useAuthStore.setState({ currentUserId: st.ids.mgr, currentRole: "MANAGER", currentAuthId: st.authIds.mgr });
    for (const r of await rowsOf()) await app.localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drain();
    expect(ledger(kR)).toBe("committed/");
    expect(ledger(saleRow.idempotencyKey)).toBe("<none>");
    await signInApp("cashA");
    for (const r of await rowsOf()) await app.localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drain();
    expect(ledger(saleRow.idempotencyKey)).toBe("committed/");
    expect(sql1(`SELECT ((SELECT created_at FROM idempotency_keys WHERE key = ${lit(saleRow.idempotencyKey)}::uuid) > (SELECT created_at FROM idempotency_keys WHERE key = ${lit(kR)}::uuid))::text`)).toBe("true");
    expect(sales()).toBe(n0 + 1);
    return { cashierFirst: "backoff at the manager's restock; sale not sent", manager: "restock committed; sale held for its cashier", cashier: "sale committed after the restock" };
  });

  T("S", "S4", "M4: a Batch 2A close_shift staged offline keeps its proof across a FULL LOAD (classified before the load replaces the local shift row)", async () => {
    online(true);
    const k = randomUUID();
    const local = await app.localDb.shifts.get(shiftId);
    await app.localDb.shifts.put({ ...local, endedAt: new Date().toISOString(), pendingSync: true, idempotencyKey: k });
    await app.localDb.syncOutbox.put({
      localId: `legacy-close-${k}`, seq: 99001, kind: "rpc", name: "close_shift", shopId: st.ids.shop, status: "pending", attempts: 1,
      writeAhead: true, inDoubt: true, backendOrigin: new URL(cfg.url).origin, createdAt: new Date().toISOString(), idempotencyKey: k,
      args: { p_shift_id: shiftId, p_closing_cash_mmk: 0, p_idempotency_key: k },
    });
    await app.useDataStore.getState().loadData({ force: true });
    const row = await app.localDb.syncOutbox.get(`legacy-close-${k}`);
    expect(row).toMatchObject({ staged: true, status: "pending" });
    expect(row.fenceRequired).not.toBe(true);
    expect((await app.localDb.shifts.get(shiftId))?.idempotencyKey).not.toBe(k);  // the load replaced the local row
    await app.localDb.syncOutbox.delete(`legacy-close-${k}`);                      // not sent: the shift stays open for S5
    return { classifiedBeforeLoad: "staged (proof: the local shift row carried the key)", afterLoad: "local row replaced by the server's; classification kept" };
  });

  // ===================== FINAL FINANCIAL-SAFETY PASS (real server) =====================
  T("F", "F1", "A: the earlier sale COMMITS and the drain acknowledges it (queue row deleted) WHILE the cashier is asked -> 'new' records nothing new", async () => {
    await signInApp("cashA");
    await offlineAuth(true);
    online(true);
    fault = { rpc: "op_execute", mode: "drop-after" };              // committed, reply lost
    const n0 = sales();
    await expect(app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 5, 1000))).rejects.toThrow(/Pending confirmation/);
    expect(sales()).toBe(n0 + 1);
    const row = (await rowsOf()).find((r: any) => r.inDoubt === true && r.args.p_items[0].qty === 5);
    let rowGoneDuringPrompt = false;
    app.prompt.registerOperationPrompt(async () => {
      await drain();                                               // another worker acknowledges it meanwhile
      rowGoneDuringPrompt = !(await app.localDb.syncOutbox.get(row.localId));
      return "new";
    });
    const execBefore = log.filter((l) => l.rpc === "op_execute").length;
    await expect(app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 5, 1000))).rejects.toThrow(/has now been recorded/);
    app.prompt.registerOperationPrompt(async () => "new");
    expect(rowGoneDuringPrompt).toBe(true);
    expect(sales()).toBe(n0 + 1);                                  // never a second sale
    expect(log.filter((l) => l.rpc === "op_execute").length - execBefore).toBe(1); // only the drain's replay of the ORIGINAL key
    expect(log.filter((l) => l.rpc === "op_status" && l.key === row.idempotencyKey && l.fence === true).length).toBeGreaterThanOrEqual(1);
    expect(ledger(row.idempotencyKey)).toBe("committed/");
    return { duringPrompt: "drain replayed the original and deleted its row", replacement: "re-asked the server by the ORIGINAL key -> committed -> nothing new", serverSales: "+1 exactly" };
  });

  T("F", "F2", "B: an unresolved sale queued for ANOTHER backend blocks the replacement; this server is never asked or fenced; Confirm refuses", async () => {
    online(false);
    await offlineAuth(true);
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 6, 1000));
    const row = (await rowsOf()).find((r: any) => r.status === "pending" && r.args.p_items[0].qty === 6);
    // an ONLINE attempt whose outcome is unknown (write-ahead, in doubt), queued for the old backend
    await app.localDb.syncOutbox.update(row.localId, { status: "quarantined", inDoubt: true, writeAhead: true, backendOrigin: "https://old-backend.example.invalid", quarantineReason: "queued for another server" });
    online(true);
    const n0 = sales();
    const logFrom = log.length;
    await expect(app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 6, 1000))).rejects.toThrow(/another server/);
    await signInApp("admin", "ADMIN");
    await expect(app.outbox.confirmWithServer(row.localId)).rejects.toThrow(/another server/);
    await signInApp("cashA");
    expect(log.slice(logFrom).filter((l) => l.key === row.idempotencyKey)).toHaveLength(0);
    expect(ledger(row.idempotencyKey)).toBe("<none>");             // never fenced here
    expect(sales()).toBe(n0);
    expect(await app.localDb.syncOutbox.get(row.localId)).toMatchObject({ status: "quarantined", idempotencyKey: row.idempotencyKey });
    await app.localDb.syncOutbox.delete(row.localId);               // (tidy for the next tests)
    return { replacement: "refused (another server)", confirm: "refused", thisServer: "never asked, never fenced", original: "kept quarantined with its key" };
  });

  T("F", "F3", "C: a supplier payment's reply is lost and its retries then get 401 -> stays UNRESOLVED (never 'not applied'); a 'new' payment is refused because the server shows it committed", async () => {
    await signInApp("admin", "ADMIN");
    const payArgs = { p_supplier_id: st.ids.sup, p_shop_id: st.ids.shop, p_amount_mmk: 500, p_payment_method: "CASH", p_reference_no: "m086-F3", p_notes: null };
    const pays = () => Number(sql1(`SELECT count(*) FROM supplier_payments WHERE supplier_id = ${lit(st.ids.sup)}`));
    const p0 = pays();
    fault = { rpc: "op_execute", mode: "drop-after" };
    faults.push({ rpc: "op_execute", mode: "401" }, { rpc: "op_execute", mode: "401" });
    const lost = await app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgs, { retries: 2 });
    faults.length = 0;
    expect(lost.error?.name).toBe("PendingConfirmationError");
    expect(pays()).toBe(p0 + 1);
    const [op] = await app.onlineOnly.listUnresolvedOnlineOperations();
    expect(op).toMatchObject({ name: "pay_supplier_lump_sum", status: "unresolved", uncertain: true });
    app.prompt.registerOperationPrompt(async () => "new");
    await expect(app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgs)).rejects.toThrow(/has now been recorded/);
    expect(pays()).toBe(p0 + 1);                                    // one payment, never two
    expect(await app.onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(0);
    await signInApp("cashA");
    return { afterLostReplyAnd401s: "unresolved (uncertain)", replacement: "refused: committed on the server", payments: "+1 exactly" };
  });

  T("F", "F4", "D: a real dependency refusal on an entry queued 3 days ago gets its 24 h grace from the FIRST refusal; then it blocks later entries as a conflict", async () => {
    online(false);
    await offlineAuth(true);
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 7, 1000));
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 8, 1000));
    const all = (await rowsOf()).filter((r: any) => r.status === "pending").sort((a: any, b: any) => a.seq - b.seq);
    const [dep, later] = all.slice(-2);
    await app.localDb.syncOutbox.update(dep.localId, {
      args: { ...dep.args, p_shift_id: "qa-shift-not-synced-yet" }, createdAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
    });
    online(true);
    const n0 = sales();
    expect(await drain()).toBe("backoff");
    expect(await app.localDb.syncOutbox.get(dep.localId)).toMatchObject({ status: "pending", heldReason: "dependency" });
    expect(ledger(dep.idempotencyKey)).toBe("<none>");                // not recorded on the server
    expect(log.filter((l) => l.key === later.idempotencyKey)).toHaveLength(0);
    await app.localDb.syncOutbox.update(dep.localId, { dependencySince: new Date(Date.now() - 25 * 3_600_000).toISOString(), nextAttemptAt: undefined });
    expect(await drain()).toBe("backoff");
    expect(await app.localDb.syncOutbox.get(dep.localId)).toMatchObject({ status: "conflict", blocksQueue: true });
    expect(await drain()).toBe("backoff");
    expect(log.filter((l) => l.key === later.idempotencyKey)).toHaveLength(0);   // still behind it
    expect(sales()).toBe(n0);
    await app.localDb.syncOutbox.bulkDelete([dep.localId, later.localId]);
    return { firstRefusal: "parked 'dependency' (grace period from the first refusal, not from creation)", after24h: "conflict that keeps blocking", laterEntry: "never sent" };
  });

  T("F", "F5", "E: restoring a set-aside entry that was being sent (never authorised offline) -> looked up and FENCED on the real server, never resent", async () => {
    online(false);
    await offlineAuth(true);
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 9, 1000));
    const row = (await rowsOf()).find((r: any) => r.status === "pending" && r.args.p_items[0].qty === 9);
    await app.localDb.syncOutbox.update(row.localId, { status: "archived", statusBeforeArchive: "syncing", writeAhead: true, staged: false, archivedAt: new Date().toISOString() });
    await signInApp("admin", "ADMIN");
    const restored = await app.outbox.restoreSetAsideEntry(row.localId);
    expect(restored).toMatchObject({ status: "conflict", fenceRequired: true, inDoubt: true });
    await signInApp("cashA");
    online(true);
    const n0 = sales();
    const logFrom = log.length;
    await drain();
    expect(log.slice(logFrom).filter((l) => (l.rpc === "op_execute" || l.rpc === "complete_sale") && l.key === row.idempotencyKey)).toHaveLength(0);
    expect(ledger(row.idempotencyKey)).toBe("abandoned/FENCED");
    expect(sales()).toBe(n0);
    return { restored: "held (conflict + fenceRequired)", server: "abandoned/FENCED, never executed", serverSales: "unchanged" };
  });

  // ===================== PAYMENT-SAFETY AND SHARED-TILL PASS (real server) =====================
  const payArgsP = (ref: string) => ({ p_supplier_id: st.ids.sup, p_shop_id: st.ids.shop, p_amount_mmk: 100, p_payment_method: "CASH", p_reference_no: ref, p_notes: null });
  const paysP = () => Number(sql1(`SELECT count(*) FROM supplier_payments WHERE supplier_id = ${lit(st.ids.sup)}`));

  T("P", "P1", "HIGH-1: a supplier payment interrupted during its FIRST attempt (it committed), retried after a restart into 503s, is never 'not applied'; a replacement is refused; exactly one payment", async () => {
    await signInApp("admin", "ADMIN");
    const p0 = paysP();
    fault = { rpc: "op_execute", mode: "hang-after" };
    void app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-P1"), { retries: 0 });
    for (let i = 0; i < 100 && paysP() === p0; i++) await delay(100);
    expect(paysP()).toBe(p0 + 1);                                   // committed on the server
    app.onlineOnly.resetOnlineOnlyForTests();                       // the process restarts
    const [op] = await app.onlineOnly.listUnresolvedOnlineOperations();
    expect(op).toMatchObject({ name: "pay_supplier_lump_sum", backendOrigin: new URL(cfg.url).origin });
    faults.push({ rpc: "op_status", mode: "503" }, { rpc: "op_execute", mode: "503" }, { rpc: "op_execute", mode: "503" }, { rpc: "op_execute", mode: "503" });
    const retried = await app.onlineOnly.retryOnlineOperation(op.id);
    faults.length = 0;
    expect(retried.error?.name).toBe("PendingConfirmationError");   // never "not applied"
    expect(await app.onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(1);
    app.prompt.registerOperationPrompt(async () => "new");
    await expect(app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-P1"))).rejects.toThrow(/has now been recorded/);
    expect(paysP()).toBe(p0 + 1);                                   // one payment, never two
    expect(ledger(op.args.p_idempotency_key)).toBe("committed/");
    return { firstAttempt: "committed, process died before the reply", retryInto503s: "still unresolved", replacement: "refused (server shows it committed)", payments: "+1 exactly" };
  });

  T("P", "P2", "backend binding: a payment recorded for ANOTHER backend (or by an older build without one) is never fenced, retried or replaced here", async () => {
    const p0 = paysP();
    expect(await app.onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(0);
    // an unresolved one recorded for another backend, and an older one without its backend
    const mk = (id: string, origin: string | undefined) => ({
      v: 2, id, name: "pay_supplier_lump_sum", orgId: st.ids.org, userId: st.ids.admin, fingerprint: id,
      scope: `pay_supplier_lump_sum#${st.ids.sup}|${st.ids.shop}`, args: { ...payArgsP(id), p_idempotency_key: app.idem.newIdempotencyKey(), p_expected_actor_id: st.ids.admin },
      status: "unresolved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, ...(origin ? { backendOrigin: origin } : {}),
    });
    const other = mk("op-other-backend", "https://old-backend.example.invalid");
    await app.localDb.syncState.put({ key: `online-op:${other.id}`, value: JSON.stringify(other), updatedAt: other.updatedAt });
    const logFrom = log.length;
    await expect(app.onlineOnly.retryOnlineOperation(other.id)).rejects.toThrow(/another server/);
    await expect(app.onlineOnly.checkOnlineOperation(other.id)).rejects.toThrow(/another server/);
    await expect(app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-P2b"))).rejects.toThrow(/another server/);
    expect(log.slice(logFrom).filter((l) => l.key === other.args.p_idempotency_key)).toHaveLength(0);   // never asked here
    expect(ledger(other.args.p_idempotency_key)).toBe("<none>");                                       // never fenced
    await app.localDb.syncState.delete(`online-op:${other.id}`);
    const legacy = mk("op-legacy", undefined);
    await app.localDb.syncState.put({ key: `online-op:${legacy.id}`, value: JSON.stringify(legacy), updatedAt: legacy.updatedAt });
    await expect(app.onlineOnly.retryOnlineOperation(legacy.id)).rejects.toThrow(/older version/);
    await expect(app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-P2c"))).rejects.toThrow(/older version|another server/);
    await app.onlineOnly.checkOnlineOperation(legacy.id);                    // read-only lookup: not found proves nothing
    expect(ledger(legacy.args.p_idempotency_key)).toBe("<none>");            // no fence
    expect(await app.onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(1);
    await app.onlineOnly.markOnlineOperationVerified(legacy.id);             // owner decision
    expect(paysP()).toBe(p0);
    await signInApp("cashA");
    return { otherBackend: "retry / check / replacement refused; never asked or fenced here", legacy: "retry and replacement refused; read-only Check settles nothing on 'not found'; owner verifies", payments: "unchanged" };
  });

  T("P", "P3", "HIGH-2 (alternating cashiers on one till): B's independent sale reaches the server in B's session past A's waiting sale; A's goes in A's session; a sale that may depend on a queued restock waits", async () => {
    // cashier B needs an open shift of her own
    const cb = await signedInClient(cfg, st.emails.cashB, pw);
    const osB = await cb.rpc("open_shift", { p_shop_id: st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: st.ids.cashB, p_idempotency_key: randomUUID() });
    if (osB.error) throw new Error(osB.error.message);
    const shiftB = (osB.data as any).shift.id;
    const salesB = () => Number(sql1(`SELECT count(*) FROM sales WHERE shift_id = ${lit(shiftB)}`));
    // A rings a sale offline and signs out with it unsent
    online(false);
    await offlineAuth(true);
    await signInApp("cashA");
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 1, 1000));
    const rowA = (await rowsOf()).find((r: any) => r.status === "pending" && r.actorId === st.ids.cashA);
    // B signs in on the same till and enqueues her own sale (another shift) — as the app would, offline
    await signInApp("cashB");
    await app.outbox.enqueueOutbox({ kind: "rpc", name: "complete_sale", shopId: st.ids.shop, args: {
      p_shop_id: st.ids.shop, p_shift_id: shiftB, p_payment_method: "CASH", p_paid_mmk: 2000000000, p_cart_discount_pct: 0,
      p_items: [{ product_id: st.ids.prod1, qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString(),
    } });
    online(true);
    const nA = sales();
    const nB = salesB();
    await drain();
    expect(salesB()).toBe(nB + 1);                                 // B's own sale, now — not behind A's
    expect(sales()).toBe(nA);                                      // A's not run in B's session
    expect(log.filter((l) => l.key === rowA.idempotencyKey)).toHaveLength(0);
    expect(await app.localDb.syncOutbox.get(rowA.localId)).toMatchObject({ heldReason: "needs-original-user" });
    await signInApp("cashA");
    await app.localDb.syncOutbox.update(rowA.localId, { nextAttemptAt: undefined });
    await drain();
    expect(sales()).toBe(nA + 1);
    expect(ledger(rowA.idempotencyKey)).toBe("committed/");
    await cb.rpc("close_shift", { p_shift_id: shiftB, p_closing_cash_mmk: 0, p_variance_reason: "m086", p_created_at: null, p_expected_actor_id: st.ids.cashB, p_idempotency_key: randomUUID() });
    return { cashierB: "own sale committed in her session past A's waiting one", cashierA: "his sale committed later, in his own session", neverCrossed: "no request for A's key in B's session" };
  });

  T("P", "P4", "shared till: an ADMIN's 'Confirm with server' on another cashier's AUTHORISED queued sale looks it up but never fences it (it still goes later); audited", async () => {
    online(false);
    await offlineAuth(true);
    await signInApp("cashA");
    await app.useDataStore.getState().createSale(saleInput(st.ids.prod1, st.ids.unit1, 2, 1000));
    const row = (await rowsOf()).find((r: any) => r.status === "pending" && r.args.p_items[0].qty === 2 && r.actorId === st.ids.cashA);
    online(true);
    await signInApp("admin", "ADMIN");
    expect(await app.outbox.confirmWithServer(row.localId)).toBe("undecided");
    expect(ledger(row.idempotencyKey)).toBe("<none>");             // NOT fenced (it was authorised offline)
    const audit = (await app.localDb.syncState.toArray()).map((r: any) => { try { return JSON.parse(r.value); } catch { return {}; } })
      .filter((l: any) => l.event === "owner-action" && l.localId === row.localId);
    expect(audit.some((l: any) => /never fenced/.test(l.detail))).toBe(true);
    await signInApp("cashA");
    const n0 = sales();
    await drain();
    expect(sales()).toBe(n0 + 1);                                  // its cashier sends it later: it was never cancelled
    return { adminConfirm: "looked up, not fenced", audit: "owner-action logged", later: "sent by its cashier, committed once" };
  });

  // ===================== FINAL ORDERING AND RECOVERY PASS (real server) =====================
  T("O", "O1", "H1: a shift opened OFFLINE, its sales still queued under the offline id; once the open synced, a close made with the SERVER id is queued BEHIND those sales — the server closes the shift with every sale in it", async () => {
    await signInApp("cashA");
    // close cashier A's current shift first (the test opens a fresh one offline)
    const ca = await signedInClient(cfg, st.emails.cashA, pw);
    await ca.rpc("close_shift", { p_shift_id: shiftId, p_closing_cash_mmk: 0, p_variance_reason: "m086 O1 prep", p_created_at: null, p_expected_actor_id: st.ids.cashA, p_idempotency_key: randomUUID() });
    const ended = new Date().toISOString();
    app.useDataStore.setState((s: any) => ({ shifts: s.shifts.map((x: any) => (x.id === shiftId ? { ...x, endedAt: ended } : x)) }));
    online(false);
    await offlineAuth(true);
    await app.useDataStore.getState().startShift({ shopId: st.ids.shop, cashierId: st.ids.cashA, openingCashMmk: 0 });
    const openRow = (await rowsOf()).find((r: any) => r.name === "open_shift" && r.status === "pending");
    if (!openRow) throw new Error("the app did not queue an offline open_shift");
    const localShift = openRow.provisional.find((p: any) => p.table === "shifts").ids[0];
    for (const qty of [1, 2]) {
      await app.useDataStore.getState().createSale({ ...saleInput(st.ids.prod1, st.ids.unit1, qty, 1000), shiftId: localShift });
    }
    online(true);
    // the open syncs; the sales cannot (the server cannot be reached for the first; the second waits behind it)
    const firstSale = (await rowsOf()).filter((r: any) => r.name === "complete_sale" && r.args.p_shift_id === localShift).sort((x: any, y: any) => x.seq - y.seq)[0];
    faults.push({ rpc: "op_execute", mode: "drop-before", key: firstSale.idempotencyKey });
    const openKey = openRow.idempotencyKey;
    await drain();
    expect(ledger(openKey)).toBe("committed/");
    const realShift = (await app.localDb.provisionalIdMap.get(localShift))?.realId;
    expect(realShift).toBeTruthy();
    const queuedSales = (await rowsOf()).filter((r: any) => r.name === "complete_sale" && r.args.p_shift_id === localShift);
    expect(queuedSales).toHaveLength(2);
    // the cashier ends the shift ONLINE: it carries the server id
    const blocking = await app.outbox.blockingEarlierWork({ kind: "rpc", name: "close_shift", args: { p_shift_id: realShift }, shopId: st.ids.shop, actorId: st.ids.cashA });
    expect(blocking.map((r: any) => r.name)).toEqual(["complete_sale", "complete_sale"]);
    await app.outbox.enqueueOutbox({ kind: "rpc", name: "close_shift", shopId: st.ids.shop, args: { p_shift_id: realShift, p_closing_cash_mmk: 3000, p_variance_reason: "m086 O1", p_created_at: new Date().toISOString(), p_expected_actor_id: st.ids.cashA } });
    for (const r of await rowsOf()) await app.localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drain();
    expect(Number(sql1(`SELECT count(*) FROM sales WHERE shift_id = ${lit(realShift)}`))).toBe(2);
    expect(sql1(`SELECT (ended_at IS NOT NULL)::text FROM shifts WHERE id = ${lit(realShift)}`)).toBe("true");
    const order = sql1(`SELECT string_agg(rpc, ',' ORDER BY created_at) FROM idempotency_keys WHERE key IN (${queuedSales.map((r: any) => `${lit(r.idempotencyKey)}::uuid`).join(",")}) OR (rpc = 'close_shift' AND actor_id = ${lit(st.ids.cashA)} AND created_at > now() - interval '5 minutes')`);
    expect(order.split(",").at(-1)).toBe("close_shift");
    // re-open a shift for the remaining tests
    const os = await ca.rpc("open_shift", { p_shop_id: st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: st.ids.cashA, p_idempotency_key: randomUUID() });
    shiftId = (os.data as any).shift.id;
    return { offlineShift: "2 sales queued under the offline id", afterOpenSynced: "close (server id) blocked by both sales", server: "shift closed with both sales; close recorded last" };
  });

  T("O", "O2", "payment Retry race (deterministic): the first attempt is held, a Retry commits, the held attempt then answers 503 — the payment stays APPLIED, exactly one", async () => {
    await signInApp("admin", "ADMIN");
    const p0 = paysP();
    fault = { rpc: "op_execute", mode: "hold-503" };
    const a = app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-O2"), { retries: 0 });
    for (let i = 0; i < 100 && !releaseHeld; i++) await delay(20);
    const [op] = await app.onlineOnly.listUnresolvedOnlineOperations();
    const b = await app.onlineOnly.retryOnlineOperation(op.id);
    expect(b.error).toBeNull();
    expect(paysP()).toBe(p0 + 1);
    releaseHeld!();
    releaseHeld = null;
    await a;
    const stored = JSON.parse((await app.localDb.syncState.get(`online-op:${op.id}`)).value);
    expect(stored).toMatchObject({ status: "settled", outcome: "applied" });
    expect(paysP()).toBe(p0 + 1);
    expect(ledger(op.args.p_idempotency_key)).toBe("committed/");
    await signInApp("cashA");
    return { held: "first attempt never forwarded", retry: "committed", lateAnswer: "503 ignored (a newer outcome stands)", payments: "+1 exactly" };
  });

  T("O", "O3", "manager closes a cashier's shift (queued); the cashier's new OPEN waits behind it — never refused for 'already has an open shift'", async () => {
    const ca = await signedInClient(cfg, st.emails.cashA, pw);
    // the manager closes cashier A's shift on this till while the server is unreachable
    const local = await app.localDb.shifts.get(shiftId);
    if (!local) await app.localDb.shifts.put({ id: shiftId, shopId: st.ids.shop, cashierId: st.ids.cashA, startedAt: new Date().toISOString(), openingCashMmk: 0 });
    const mgrAuth = await app.supabase.auth.signInWithPassword({ email: st.emails.mgr, password: pw });
    if (mgrAuth.error) throw new Error(mgrAuth.error.message);
    app.useAuthStore.setState({ currentUserId: st.ids.mgr, currentRole: "MANAGER", currentAuthId: st.authIds.mgr });
    await app.outbox.enqueueOutbox({ kind: "rpc", name: "close_shift", shopId: st.ids.shop, args: { p_shift_id: shiftId, p_closing_cash_mmk: 0, p_variance_reason: "m086 O3", p_created_at: new Date().toISOString(), p_expected_actor_id: st.ids.mgr } });
    // cashier A signs in and opens a new shift ONLINE: it may depend on the queued close
    await signInApp("cashA");
    const blocking = await app.outbox.blockingEarlierWork({ kind: "rpc", name: "open_shift", args: { p_shop_id: st.ids.shop }, shopId: st.ids.shop, actorId: st.ids.cashA });
    expect(blocking.map((r: any) => r.name)).toEqual(["close_shift"]);
    // the manager's close goes in the manager's session, then the cashier can open
    await app.supabase.auth.signInWithPassword({ email: st.emails.mgr, password: pw });
    app.useAuthStore.setState({ currentUserId: st.ids.mgr, currentRole: "MANAGER", currentAuthId: st.authIds.mgr });
    for (const r of await rowsOf()) await app.localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drain();
    expect(sql1(`SELECT (ended_at IS NOT NULL)::text FROM shifts WHERE id = ${lit(shiftId)}`)).toBe("true");
    const os = await ca.rpc("open_shift", { p_shop_id: st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: st.ids.cashA, p_idempotency_key: randomUUID() });
    expect(os.error).toBeNull();
    shiftId = (os.data as any).shift.id;
    await signInApp("cashA");
    return { managersClose: "queued", cashiersOpen: "blocked behind it (not refused)", afterwards: "close committed, new shift opened" };
  });

  T("S", "S5", "H2 sale -> close_shift through the real drain: an UNDECIDED held sale keeps the close behind it; once fenced, the close follows", async () => {
    const row = await heldSale(2, { nextAttemptAt: undefined });
    online(false);
    await app.outbox.enqueueOutbox({ kind: "rpc", name: "close_shift", shopId: st.ids.shop, args: { p_shift_id: shiftId, p_closing_cash_mmk: 0, p_variance_reason: "m086 QA close", p_created_at: new Date().toISOString(), p_expected_actor_id: st.ids.cashA } });
    const close = (await rowsOf()).find((r: any) => r.name === "close_shift");
    online(true);
    fault = { rpc: "op_status", mode: "drop-before" };             // the server cannot be asked yet
    await drain();
    expect(log.filter((l) => l.key === close.idempotencyKey)).toHaveLength(0);
    expect(sql1(`SELECT (ended_at IS NULL)::text FROM shifts WHERE id = ${lit(shiftId)}`)).toBe("true");
    for (const r of await rowsOf()) await app.localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drain();
    expect(ledger(row.idempotencyKey)).toBe("abandoned/FENCED");
    expect(ledger(close.idempotencyKey)).toBe("committed/");
    expect(sql1(`SELECT (ended_at IS NOT NULL)::text FROM shifts WHERE id = ${lit(shiftId)}`)).toBe("true");
    return { whileUndecided: "close not sent; shift still open", afterFence: "sale abandoned (never ran), then the close committed" };
  });
  // ===================== POST-CHECKPOINT FINANCIAL SAFETY (after d0390a1, real server) =====================
  const gateReached = async (name: string) => { for (let i = 0; i < 300 && !gates.has(name); i++) await delay(20); if (!gates.has(name)) throw new Error(`gate ${name} never reached`); };
  const storedOp = async (id: string) => JSON.parse((await app.localDb.syncState.get(`online-op:${id}`)).value);
  const poPaid = () => Number(sql1(`SELECT coalesce(sum(paid_mmk), 0) FROM purchase_orders WHERE supplier_id = ${lit(st.ids.sup)}`));
  /** An outstanding balance for the supplier (admin creates, manager approves and receives). */
  const outstanding = async (qty: number) => {
    const admin = await signedInClient(cfg, st.emails.admin, pw);
    const mgr = await signedInClient(cfg, st.emails.mgr, pw);
    const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: st.ids.sup, p_notes: "m086-X", p_items: [{ product_id: st.ids.prod3, ordered_qty: qty, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
    const poId = (po.data as any).purchaseOrder.id;
    await mgr.rpc("approve_purchase_order", { p_purchase_order_id: poId, p_idempotency_key: randomUUID() });
    const rc = await mgr.rpc("receive_purchase_order", { p_purchase_order_id: poId, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr, p_idempotency_key: randomUUID() });
    if (rc.error) throw new Error(rc.error.message);
  };

  T("X", "X1", "M1 race 1 (stale settled note): A proves 'not delivered' DURING the Retry's lookup -> the Retry is refused against the STORED record (nothing resent); the replacement is the ONLY payment", async () => {
    await outstanding(5);
    await signInApp("admin", "ADMIN");
    app.prompt.registerOperationPrompt(async () => "new");
    const p0 = paysP(); const paid0 = poPaid();
    fault = { rpc: "op_execute", mode: "gate-503", gate: "A" };
    const first = app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X1"), { retries: 0 });
    await gateReached("A");
    const [op] = await app.onlineOnly.listUnresolvedOnlineOperations();
    faults.push({ rpc: "op_status", mode: "gate-forward", gate: "L" });
    const retry = app.onlineOnly.retryOnlineOperation(op.id);
    await gateReached("L");
    openGate("A");                                                  // A: 503 "no healthy upstream" -> not delivered
    await first;
    // deployment-blocker pass: A (still the latest attempt) FENCES its key on the server — never the client's word alone
    expect(await storedOp(op.id)).toMatchObject({ status: "settled", outcome: "abandoned", decidedBy: "server", attempts: 1 });
    openGate("L");                                                  // the Retry's lookup answers (not found)
    const r = await retry;
    expect(r.error?.message ?? "").toMatch(/already settled/);
    expect(log.filter((l) => l.rpc === "op_execute" && l.key === op.args.p_idempotency_key)).toHaveLength(1);   // never resent
    expect(ledger(op.args.p_idempotency_key)).toBe("abandoned/FENCED");
    const repl = await app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X1"), { retries: 0 });
    expect(repl.error).toBeNull();
    expect(paysP()).toBe(p0 + 1);                                   // ONE supplier_payments row
    expect(poPaid()).toBe(paid0 + 100);                             // the balance moved once
    expect(ledger(op.args.p_idempotency_key)).toBe("abandoned/FENCED");   // the original key can never run
    expect(await app.onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(0);
    return { attemptA: "503 -> fenced on the server (abandoned, server)", retry: "refused: already settled, nothing resent", replacement: "committed", supplierPayments: "+1 exactly", paidOnPos: "+100 once", originalKey: "abandoned/FENCED (never runs)" };
  });

  T("X", "X2", "M1 race 2: the Retry claims attempt 2 FIRST (B commits, reply delayed); A's late 503 decides nothing; the payment stays LISTED; a replacement is refused; ONE payment", async () => {
    await signInApp("admin", "ADMIN");
    app.prompt.registerOperationPrompt(async () => "new");
    const p0 = paysP(); const paid0 = poPaid();
    fault = { rpc: "op_execute", mode: "gate-503", gate: "A" };
    const first = app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X2"), { retries: 0 });
    await gateReached("A");
    const [op] = await app.onlineOnly.listUnresolvedOnlineOperations();
    faults.push({ rpc: "op_execute", mode: "commit-gate", gate: "B", key: op.args.p_idempotency_key });
    const retry = app.onlineOnly.retryOnlineOperation(op.id);
    await gateReached("B");                                         // B has COMMITTED on the server; its reply waits
    expect(paysP()).toBe(p0 + 1);
    expect(await storedOp(op.id)).toMatchObject({ status: "unresolved", attempts: 2 });
    openGate("A");
    await first;
    expect(await storedOp(op.id)).toMatchObject({ status: "unresolved", attempts: 2 });   // A's late answer decided nothing
    expect(await app.onlineOnly.listUnresolvedOnlineOperations()).toHaveLength(1);
    await expect(app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X2"), { retries: 0 })).rejects.toThrow(/has now been recorded|could not be confirmed/);
    expect(paysP()).toBe(p0 + 1);
    openGate("B");
    await retry;
    expect(await storedOp(op.id)).toMatchObject({ status: "settled", outcome: "applied", decidedBy: "server" });
    expect(paysP()).toBe(p0 + 1);
    expect(poPaid()).toBe(paid0 + 100);
    expect(ledger(op.args.p_idempotency_key)).toBe("committed/");
    return { attemptB: "committed (reply delayed)", lateA: "503 ignored (attempt 1 is not the latest)", replacement: "refused", stored: "settled applied by server", supplierPayments: "+1 exactly", paidOnPos: "+100 once" };
  });

  T("X", "X3", "cross-organisation: the export carries only this organisation's operations; an owner cannot close another organisation's operation; nothing is asked or fenced for it", async () => {
    await signInApp("admin", "ADMIN");
    const { collectQueueExport, countQueue } = await import("../lib/queueExport/collect");
    const foreign = {
      v: 2, id: "op-foreign-org", name: "pay_supplier_lump_sum", orgId: "00000000-0000-4000-8000-0000000000ff", userId: st.ids.admin, fingerprint: "f", scope: "f",
      args: { ...payArgsP("m086-X3"), p_idempotency_key: app.idem.newIdempotencyKey() }, status: "unresolved",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, backendOrigin: new URL(cfg.url).origin,
    };
    await app.localDb.syncState.put({ key: `online-op:${foreign.id}`, value: JSON.stringify(foreign), updatedAt: foreign.updatedAt });
    const logFrom = log.length;
    const mine = await collectQueueExport(app.localDb, { appVersion: "live", tillId: "till", backendHost: new URL(cfg.url).host, session: { userId: st.ids.admin, orgId: st.ids.org, shopId: null, role: "ADMIN" } });
    expect(mine.onlineOperations.map((o: any) => o.id)).not.toContain(foreign.id);
    expect((await countQueue(app.localDb, st.ids.org)).onlineOperations ?? 0).toBe(0);   // the summary omits a zero count
    await expect(app.onlineOnly.markOnlineOperationVerified(foreign.id)).rejects.toThrow(/another organisation/);
    expect((await storedOp(foreign.id)).status).toBe("unresolved");
    expect(log.slice(logFrom).filter((l) => l.key === foreign.args.p_idempotency_key)).toHaveLength(0);
    expect(ledger(foreign.args.p_idempotency_key)).toBe("<none>");
    await app.localDb.syncState.delete(`online-op:${foreign.id}`);
    return { export: "own organisation only", count: 0, ownerVerify: "refused for another organisation", server: "never asked, never fenced" };
  });

  T("X", "X4", "shared-till delay, alternating cashiers: A opens a shift OFFLINE and rings a sale (never sent); B's close of HER server shift goes in B's session; A's shift + sale then go in A's session", async () => {
    const cb = await signedInClient(cfg, st.emails.cashB, pw);
    const osB = await cb.rpc("open_shift", { p_shop_id: st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: st.ids.cashB, p_idempotency_key: randomUUID() });
    if (osB.error) throw new Error(osB.error.message);
    const shiftB = (osB.data as any).shift.id;
    await app.localDb.shifts.put({ id: shiftB, shopId: st.ids.shop, cashierId: st.ids.cashB, startedAt: new Date().toISOString(), openingCashMmk: 0 });
    expect(sql1(`SELECT count(*) FROM shifts WHERE cashier_id = ${lit(st.ids.cashA)} AND ended_at IS NULL`)).toBe("0");
    online(false);
    await offlineAuth(true);
    await signInApp("cashA");
    const localShift = `local-shift-${randomUUID()}`;
    await app.outbox.enqueueOutbox({ kind: "rpc", name: "open_shift", shopId: st.ids.shop, args: { p_shop_id: st.ids.shop, p_opening_cash_mmk: 0, p_created_at: new Date().toISOString() }, provisional: [{ table: "shifts", ids: [localShift] }] });
    await app.outbox.enqueueOutbox({ kind: "rpc", name: "complete_sale", shopId: st.ids.shop, args: { ...saleInputArgs(st.ids.prod1, 1, 1000), p_shift_id: localShift }, refs: [{ field: "p_shift_id", provisionalId: localShift }] });
    await signInApp("cashB");
    await app.outbox.enqueueOutbox({ kind: "rpc", name: "close_shift", shopId: st.ids.shop, args: { p_shift_id: shiftB, p_closing_cash_mmk: 0, p_variance_reason: "m086 X4", p_created_at: new Date().toISOString() } });
    const closeB = (await rowsOf()).find((r: any) => r.name === "close_shift" && r.args.p_shift_id === shiftB);
    online(true);
    await drain();
    expect(ledger(closeB.idempotencyKey)).toBe("committed/");                        // B's close was NOT delayed
    expect(sql1(`SELECT (ended_at IS NOT NULL)::text FROM shifts WHERE id = ${lit(shiftB)}`)).toBe("true");
    const aRows = (await rowsOf()).filter((r: any) => r.actorId === st.ids.cashA && (r.name === "open_shift" || (r.name === "complete_sale" && r.args.p_shift_id === localShift)));
    expect(aRows).toHaveLength(2);
    for (const r of aRows) expect(log.filter((l) => l.key === r.idempotencyKey)).toHaveLength(0);   // never sent in B's session
    await signInApp("cashA");
    for (const r of await rowsOf()) await app.localDb.syncOutbox.update(r.localId, { nextAttemptAt: undefined });
    await drain();
    for (const r of aRows) expect(ledger(r.idempotencyKey)).toBe("committed/");
    const serverShiftA = sql1(`SELECT id FROM shifts WHERE cashier_id = ${lit(st.ids.cashA)} AND ended_at IS NULL`);
    expect(Number(sql1(`SELECT count(*) FROM sales WHERE shift_id = ${lit(serverShiftA)}`))).toBe(1);
    const ca = await signedInClient(cfg, st.emails.cashA, pw);
    await ca.rpc("close_shift", { p_shift_id: serverShiftA, p_closing_cash_mmk: 1000, p_variance_reason: "m086", p_created_at: null, p_expected_actor_id: st.ids.cashA, p_idempotency_key: randomUUID() });
    return { cashierB: "close of her server shift committed in her session, not delayed", cashierA: "offline open + sale never sent in B's session; both committed later in A's session", saleOnAShift: 1 };
  });
  // ===================== DEPLOYMENT-BLOCKER PASS (after 9d37787, real server) =====================
  T("X", "X5", "stale schema cache on a backend that has answered 086: owner Verify is refused, the same payment entered again is blocked (never the direct path), the key is kept; once the cache is back, ONE payment", async () => {
    await outstanding(5);
    await signInApp("admin", "ADMIN");
    app.prompt.registerOperationPrompt(async () => "new");
    const p0 = paysP(); const paid0 = poPaid();
    expect((await app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X5a"), { retries: 0 })).error).toBeNull();   // 086 demonstrated
    fault = { rpc: "op_execute", mode: "hang-after" };                // commits; the reply never comes
    void app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X5"), { retries: 0 });
    for (let i = 0; i < 100 && paysP() === p0 + 1; i++) await delay(100);
    expect(paysP()).toBe(p0 + 2);
    app.onlineOnly.resetOnlineOnlyForTests();
    const [op] = (await app.onlineOnly.listUnresolvedOnlineOperations()).filter((o: any) => o.args.p_reference_no === "m086-X5");
    const logFrom = log.length;
    faults.push({ rpc: "op_status", mode: "pgrst202" }, { rpc: "op_status", mode: "pgrst202" }, { rpc: "op_execute", mode: "pgrst202" });
    await expect(app.onlineOnly.markOnlineOperationVerified(op.id)).rejects.toThrow(/could not be confirmed or stopped/);
    await expect(app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X5"), { retries: 0 })).rejects.toThrow(/could not be confirmed or stopped/);
    faults.length = 0;
    expect(log.slice(logFrom).filter((l) => l.rpc === "pay_supplier_lump_sum")).toHaveLength(0);   // never the direct path
    expect(await storedOp(op.id)).toMatchObject({ status: "unresolved", args: { p_idempotency_key: op.args.p_idempotency_key } });
    expect(paysP()).toBe(p0 + 2);
    // the cache is back: Check settles it from the server (applied); nothing new
    await app.onlineOnly.checkOnlineOperation(op.id);
    expect(await storedOp(op.id)).toMatchObject({ status: "settled", outcome: "applied", decidedBy: "server" });
    expect(paysP()).toBe(p0 + 2);
    expect(poPaid()).toBe(paid0 + 200);
    expect(ledger(op.args.p_idempotency_key)).toBe("committed/");
    return { staleCache: "Verify refused, replacement blocked, no direct call", afterCache: "Check -> applied (server)", supplierPayments: "+2 (two real payments), never a third" };
  });

  T("X", "X6", "a first attempt's 503 on an 086 server is FENCED there (abandoned) before it can be replaced; a late copy of the request is refused — ONE payment after the cashier enters it again", async () => {
    await signInApp("admin", "ADMIN");
    app.prompt.registerOperationPrompt(async () => "new");
    const p0 = paysP(); const paid0 = poPaid();
    faults.push({ rpc: "op_execute", mode: "503" });
    const first = await app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X6"), { retries: 0 });
    expect(first.error).toBeTruthy();
    faults.length = 0;
    const all = (await app.localDb.syncState.where("key").startsWith("online-op:").toArray()).map((x: any) => JSON.parse(x.value));
    const op = all.find((o: any) => o.args.p_reference_no === "m086-X6");
    expect(op).toMatchObject({ status: "settled", outcome: "abandoned", decidedBy: "server" });
    expect(ledger(op.args.p_idempotency_key)).toBe("abandoned/FENCED");
    const { p_idempotency_key: key, ...rest } = op.args;
    const ca = await signedInClient(cfg, st.emails.admin, pw);
    const late = await ca.rpc("op_execute", { p_key: key, p_rpc: "pay_supplier_lump_sum", p_args: rest, p_actor_id: st.ids.admin });
    expect((late.data as any)?.outcome).toBe("abandoned");
    expect(paysP()).toBe(p0);
    expect((await app.onlineOnly.callOnlineOnly("pay_supplier_lump_sum", payArgsP("m086-X6"), { retries: 0 })).error).toBeNull();
    expect(paysP()).toBe(p0 + 1);
    expect(poPaid()).toBe(paid0 + 100);
    await signInApp("cashA");
    return { firstAttempt: "503 -> fenced on the server (abandoned/FENCED)", lateCopy: "refused (abandoned)", reentered: "one payment", supplierPayments: "+1 exactly" };
  });
});
