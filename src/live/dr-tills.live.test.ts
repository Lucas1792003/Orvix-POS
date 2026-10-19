// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// DISASTER RECOVERY — offline tills vs a server RESTORED TO AN OLDER BACKUP at the same URL.
// The REAL client modules (data store, write-ahead, outbox drain, online-only operations) in one
// process (fake-indexeddb) against the disposable loopback stack at 086. A backup is taken, the
// till keeps working (an online sale, a sale whose reply is lost, an offline sale, a lump sum whose
// reply is lost, a refused lump sum), then the server is restored to the backup and the till goes
// on. Every scenario is judged in PostgreSQL and in the till's IndexedDB.
//
// This test RECORDS what the current code does. W8/W10 Phase 0 (client-side safeguards): the till
// keeps a journal of every financial operation (kept after acknowledgement), never fences an
// operation the server has no record of without an owner's decision, and keeps the rows a restored
// server no longer has as evidence (automatic sync pauses until an owner acknowledges). What Phase 0
// still cannot do is named "GAP" and asserted as it is (the remaining blockers in
// docs/selfhost-migration/phase-g/disaster-recovery.md). Skipped unless DR_TILLS=1.
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createAuthUser, randomPassword, signedInClient } from "./liveHelpers";
import { runSql, runSqlFile } from "../../e2e/helpers/db";
import { buildQaState, liveCfg } from "../../e2e/helpers/env";

const enabled = process.env.DR_TILLS === "1";
if (enabled && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("DR_TILLS needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run deploy/lucashome/backup/tests/dr/run.sh tills)");
}
const DB = process.env.E2E_DB_CONTAINER ?? "";
const sql1 = (q: string) => runSql(q).trim();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { id: string; title: string; status: string; detail: unknown }[] = [];

// network: a request for a key in `lost` reaches the server once (and commits); every reply for
// that key is lost (the till sees a dropped connection) until the key is released
const lost = new Set<string>();
const forwarded = new Set<string>();
const log: { rpc: string; key?: string; rpcName?: string }[] = [];
let captureNext: { rpc: string; target: string } | null = null;
let restoreMark = 0;
const realFetch = globalThis.fetch;
// installed only when this test runs: a skipped file has no side effects
if (enabled) globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url)?.[1];
  let body: any = null;
  if (rpc && init?.body) { try { body = JSON.parse(String(init.body)); } catch { /* not json */ } }
  const key = body?.p_key ?? body?.p_idempotency_key;
  if (rpc) log.push({ rpc, key, rpcName: body?.p_rpc });
  if (rpc === "op_execute" && captureNext && body?.p_rpc === captureNext.target && key) { lost.add(key); captureNext = null; }
  if (rpc && key && lost.has(key)) {
    if (!forwarded.has(key)) { forwarded.add(key); const r = await realFetch(input, init); await r.text(); }
    throw new TypeError("Failed to fetch");
  }
  return realFetch(input, init);
}) as typeof fetch;

function T(id: string, title: string, fn: () => Promise<any>, timeout = 180_000) {
  it(`${id} ${title}`, async () => {
    try { const d = await fn(); results.push({ id, title, status: "PASS", detail: d ?? "" }); console.log(`[dr-tills] PASS ${id}`); }
    catch (e: any) { results.push({ id, title, status: "FAIL", detail: String(e?.stack ?? e).slice(0, 2000) }); console.log(`[dr-tills] FAIL ${id}: ${String(e?.message ?? e).slice(0, 400)}`); throw e; }
  }, timeout);
}

describe.skipIf(!enabled)("offline tills vs a server restored to an older backup", () => {
  const cfg = enabled ? liveCfg() : (null as any);
  const pw = randomPassword();
  let st: ReturnType<typeof buildQaState>;
  let app: any;
  let shiftId = "";
  const k: Record<string, string> = {};
  const saleIds: Record<string, string> = {};
  const online = (on: boolean) => vi.stubGlobal("navigator", { onLine: on });
  const drain = async () => { for (let i = 0; i < 300; i++) { const r = await app.outbox.drainOutbox(); if (r !== "already-running" && r !== "locked") return r; await delay(100); } throw new Error("drain never finished"); };
  const cart = (qty: number, price: number) => [{
    id: randomUUID(), productId: st.ids.prod1, productUnitId: st.ids.unit1, name: "QA", unitName: "pcs", qty, unitPriceMmk: price,
    unitsPerItem: 1, unitBaseQuantity: 1, priceLevelId: `qa-pl-retail-${st.ts}`,
  }];
  const sale = (qty: number, price: number) => ({ shopId: st.ids.shop, cashierId: st.ids.cashA, shiftId, cartItems: cart(qty, price), cartDiscountPct: 0, paymentMethod: "CASH", paidMmk: qty * price });
  const signInApp = async (who: "cashA" | "mgr", role: string) => {
    const r = await app.supabase.auth.signInWithPassword({ email: st.emails[who], password: pw });
    if (r.error) throw new Error(r.error.message);
    app.useAuthStore.setState({ currentUserId: st.ids[who], currentOrgId: st.ids.org, currentRole: role, currentAuthId: st.authIds[who] });
  };
  const ledger = (key: string) => sql1(`SELECT coalesce((SELECT state || '/' || coalesce(outcome_code, '') FROM idempotency_keys WHERE key = ${lit(key)}::uuid), '<none>')`);
  const salesOfShift = () => Number(sql1(`SELECT count(*) FROM sales WHERE shift_id = ${lit(shiftId)}`));
  const lumpRows = () => sql1(`SELECT count(*) || ':' || coalesce(sum(amount_mmk), 0) FROM supplier_payments WHERE supplier_id = ${lit(st.ids.sup)} AND voided_at IS NULL`);

  beforeAll(async () => {
    vi.stubEnv("VITE_SUPABASE_URL", cfg.url);
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", cfg.anonKey);
    const ts = String(Date.now() + 303);
    const st0 = buildQaState(ts, { admin: "", mgr: "", cashA: "", cashB: "" });
    const ids = {
      admin: await createAuthUser(cfg, st0.emails.admin, pw), mgr: await createAuthUser(cfg, st0.emails.mgr, pw),
      cashA: await createAuthUser(cfg, st0.emails.cashA, pw), cashB: await createAuthUser(cfg, st0.emails.cashB, pw),
    };
    runSqlFile("supabase/tests/phase-d/live/seed.sql", { ts, auth_admin: ids.admin, auth_mgr: ids.mgr, auth_casha: ids.cashA, auth_cashb: ids.cashB });
    st = buildQaState(ts, ids);
    const admin = await signedInClient(cfg, st.emails.admin, pw);
    const mgr = await signedInClient(cfg, st.emails.mgr, pw);
    const c = await signedInClient(cfg, st.emails.cashA, pw);
    const os = await c.rpc("open_shift", { p_shop_id: st.ids.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: st.ids.cashA, p_idempotency_key: randomUUID() });
    if (os.error) throw new Error(os.error.message);
    shiftId = (os.data as any).shift.id;
    // a received purchase order of 5,000 for the supplier payments
    const po = await admin.rpc("create_purchase_order", { p_shop_id: st.ids.shop, p_supplier_id: st.ids.sup, p_notes: "dr tills", p_items: [{ product_id: st.ids.prod2, ordered_qty: 5, unit_cost_mmk: 1000 }], p_idempotency_key: randomUUID() });
    if (po.error) throw new Error(po.error.message);
    const poId = (po.data as any).purchaseOrder.id;
    for (const [rpc, args] of [["approve_purchase_order", { p_purchase_order_id: poId }], ["receive_purchase_order", { p_purchase_order_id: poId, p_received_items: null, p_created_at: null, p_expected_actor_id: st.ids.mgr }]] as const) {
      const r = await mgr.rpc(rpc, { ...args, p_idempotency_key: randomUUID() });
      if (r.error) throw new Error(`${rpc}: ${r.error.message}`);
    }
    online(true);
    const idem = await import("../stores/data/idempotentRpc");
    // the production path: the executor's capability is discovered, not pinned (vitest pins "absent")
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
      origin: await import("../lib/backendOrigin"),
      lump: await import("../features/suppliers/lumpSumOutcome"),
      journal: await import("../stores/data/opJournal"),
    };
    app.prompt.registerOperationPrompt(async () => "cancel");
    await signInApp("cashA", "CASHIER");
    await app.useDataStore.getState().loadData({ force: true });
    if (!app.useDataStore.getState().isLoaded) throw new Error(`initial load failed: ${app.useDataStore.getState().loadError}`);
  }, 300_000);
  afterAll(() => writeFileSync(process.env.DR_EVIDENCE ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), results, requestLog: log.slice(-120) }, null, 2)));

  T("R0", "before the backup: an online sale is recorded", async () => {
    const n0 = salesOfShift();
    await app.useDataStore.getState().createSale(sale(1, 1000));
    expect(salesOfShift()).toBe(n0 + 1);
    // the server's backup (logical, as backup-logical.sh takes it), kept outside the database
    execFileSync("sh", ["-c", `docker exec ${DB} pg_dump -U supabase_admin -Fc -d postgres > ${process.env.DR_DUMP}`]);
    return { sales: salesOfShift(), backup: "taken" };
  });

  T("R1", "after the backup: an online sale (recorded, reply received); a sale whose reply is LOST (committed); an offline sale (queued, never sent)", async () => {
    await app.useDataStore.getState().createSale(sale(1, 1100));
    // the server prices the sale itself (price levels): identify S1 as the newest sale of the shift
    saleIds.s1 = sql1(`SELECT id FROM sales WHERE shift_id = ${lit(shiftId)} ORDER BY created_at DESC, id DESC LIMIT 1`);
    expect(saleIds.s1).toMatch(/^sale-/);                           // never an empty id (the checks below would pass vacuously)
    captureNext = { rpc: "op_execute", target: "complete_sale" };
    await app.useDataStore.getState().createSale(sale(1, 1200)).catch(() => undefined);
    k.s2 = [...lost][0];
    expect(ledger(k.s2)).toBe("committed/");                       // it committed on the server ...
    const row = (await app.localDb.syncOutbox.toArray()).find((r: any) => r.idempotencyKey === k.s2);
    expect(row).toBeTruthy();                                       // ... the till holds it in doubt
    online(false);
    await app.localDb.authCache.put({
      authId: st.authIds.cashA, userId: st.ids.cashA, role: "CASHIER", shopId: st.ids.shop, orgId: st.ids.org,
      isActive: true, hasTotp: false, cachedAt: new Date().toISOString(),
    });
    await app.useDataStore.getState().createSale(sale(1, 1300));
    online(true);
    k.s3 = (await app.localDb.syncOutbox.toArray()).find((r: any) => r.idempotencyKey !== k.s2)?.idempotencyKey;
    expect(k.s3).toBeTruthy();
    return { s1: "recorded", s2: `committed on the server, in doubt on the till (${row.status})`, s3: "queued offline" };
  });

  T("R2", "after the backup: a lump sum REFUSED (more than owed), then a lump sum whose reply is LOST (committed)", async () => {
    await signInApp("mgr", "MANAGER");
    const r = await app.useDataStore.getState().paySupplierLumpSum({ supplierId: st.ids.sup, shopId: st.ids.shop, amountMmk: 999999, paymentMethod: "CASH" }).then(() => null, (e: any) => e);
    expect(String(r?.message ?? "")).toMatch(/exceeds total outstanding balance/);
    k.l2 = (await app.localDb.syncState.toArray()).filter((x: any) => x.key.startsWith("online-op:")).map((x: any) => JSON.parse(x.value))
      .find((o: any) => o.outcome === "refused")?.args?.p_idempotency_key;
    expect(ledger(k.l2)).toMatch(/^rejected\//);                   // the refusal is recorded on the server (tombstone)
    captureNext = { rpc: "op_execute", target: "pay_supplier_lump_sum" };
    await app.useDataStore.getState().paySupplierLumpSum({ supplierId: st.ids.sup, shopId: st.ids.shop, amountMmk: 2000, paymentMethod: "CASH" }).catch(() => undefined);
    k.l1 = [...lost].find((x) => x !== k.s2)!;
    expect(ledger(k.l1)).toBe("committed/");
    expect((await app.lump.pendingLumpSumState(st.ids.sup, st.ids.shop)).kind).toBe("pending");
    expect(lumpRows()).toBe("1:2000");
    return { l1: "committed on the server, unknown on the till", l2: "refused, settled on the till" };
  });

  T("R3", "the server is RESTORED to the backup (same URL; every write after the backup is gone)", async () => {
    execFileSync("sh", ["-c", `docker exec -i ${DB} psql -X -U supabase_admin -d template1 -v ON_ERROR_STOP=1 -q -c "ALTER DATABASE postgres ALLOW_CONNECTIONS false" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid()" -c "ALTER DATABASE postgres RENAME TO postgres_lost" && docker exec -i ${DB} pg_restore -U supabase_admin -d template1 --create --exit-on-error < ${process.env.DR_DUMP}`]);
    execFileSync("sh", ["-c", `docker restart phf-iso-rest phf-iso-auth phf-iso-storage >/dev/null`]);
    restoreMark = log.length;
    for (let i = 0; i < 120; i++) { try { if (sql1("SELECT 1") === "1") break; } catch { /* starting */ } await delay(500); }
    await delay(4000);
    expect(sql1(`SELECT count(*) FROM sales WHERE id = ${lit(saleIds.s1)}`)).toBe("0");
    expect(ledger(k.s2)).toBe("<none>");
    expect(ledger(k.l1)).toBe("<none>");
    expect(ledger(k.l2)).toBe("<none>");                           // the refusal's tombstone is gone too
    expect(lumpRows()).toBe("0:0");
    return { restored: "to the backup", lost: "sale S1, sale S2, lump sum L1 (and the L2 refusal) are gone from the server" };
  });

  T("R4", "PARTIAL (Phase 0): the origin still looks identical, but the first full load from the restored server sees that a sale it had loaded is gone — kept as evidence; automatic sync pauses", async () => {
    await signInApp("cashA", "CASHIER");
    expect(app.origin.currentBackendOrigin()).toBe(new URL(cfg.url).origin);
    await app.useDataStore.getState().loadData({ force: true });
    const vanished = await app.journal.listVanished();
    expect(vanished.some((v: any) => v.table === "sales" && v.row?.id === saleIds.s1)).toBe(true);
    const warning = await app.journal.continuityWarning();
    expect(warning).toBeTruthy();
    const mark = log.length;
    expect(await drain()).toBe("backoff");                                                  // nothing sent or looked up
    expect(log.slice(mark).filter((l) => l.rpc === "op_execute" || l.rpc === "op_status")).toHaveLength(0);
    return { detection: `continuity warning: ${warning.reason}`, gap: "a restore that loses nothing this till had LOADED is still invisible to Phase 0" };
  });

  T("R5", "W8 Phase 0: the sale recorded after the backup is still lost on the server — but the till's journal keeps its key, its request and the server's reply (receipt, total) as evidence", async () => {
    expect(sql1(`SELECT count(*) FROM sales WHERE id = ${lit(saleIds.s1)}`)).toBe("0");                     // the server lost it
    const { records } = await app.journal.listJournal();
    const j = records.find((r: any) => r.rpc === "complete_sale" && (r.evidence?.response as any)?.sale?.id === saleIds.s1);
    expect(j).toBeTruthy();
    expect(j.state).toBe("committed");
    expect(j.args?.p_idempotency_key).toBe(j.key);
    const queued = (await app.localDb.syncOutbox.toArray()).filter((r: any) => r.status !== "reconciled");
    expect(queued.some((r: any) => r.idempotencyKey === j.key)).toBe(false);              // not resent: an owner reconciles it
    return { server: "absent", till: `journal: committed, receipt ${(j.evidence.response as any).sale?.receiptNo ?? "?"}, key kept`, gap: "restoring it on the server is not automated (Phase 1)" };
  });

  T("R6", "W10 Phase 0: after the owner acknowledges the warning, the in-doubt sale is looked up READ-ONLY and held for an owner — never fenced, never resent; the offline sale is sent", async () => {
    lost.clear();
    const n0 = salesOfShift();
    await signInApp("cashA", "ADMIN");                                                     // the owner reviews the warning
    await app.journal.acknowledgeContinuity(st.ids.cashA, "dr drill: server restored to the backup; reconciliation pending");
    await signInApp("cashA", "CASHIER");
    const mark = log.length;
    await drain();
    const after = log.slice(mark);
    expect(after.filter((l) => l.key === k.s2 && l.rpc === "op_execute")).toHaveLength(0);   // never resent
    expect(after.some((l) => l.key === k.s2 && l.rpc === "op_status")).toBe(true);           // asked (read-only)
    expect(ledger(k.s2)).toBe("<none>");                                                    // NOT fenced
    const row = (await app.localDb.syncOutbox.toArray()).find((r: any) => r.idempotencyKey === k.s2);
    const j2 = await app.journal.getJournalRecord(k.s2);
    expect(row?.heldReason).toBe("reconciliation-required");
    expect(j2?.state).toBe("reconciliation-required");
    expect(ledger(k.s3)).toBe("committed/");
    expect(salesOfShift()).toBe(n0 + 1);
    return {
      s2: `not resent, not fenced; till row: ${row ? `${row.status}/${row.heldReason ?? "-"}` : "gone"}; journal: ${j2?.state}`,
      s3: "sent once (never reached the server before)",
      gap: "the owner still decides by hand (re-enter it, or Stop on server); nothing restores it automatically",
    };
  });

  T("R7", "the unknown lump sum (online-only; never part of the queue drain) stays unknown and blocks new supplier payments; Check with server answers 'no decision' (the restored server never saw it)", async () => {
    await signInApp("mgr", "MANAGER");
    const mark = log.length;
    await drain();
    expect(log.slice(mark).filter((l) => l.key === k.l1 && l.rpc === "op_execute")).toHaveLength(0);
    const state = await app.lump.pendingLumpSumState(st.ids.sup, st.ids.shop);
    expect(state.kind).toBe("pending");
    const res = await app.lump.checkPendingLumpSum(state.ops[0].id);
    expect(res.kind).toBe("unknown");
    expect(lumpRows()).toBe("0:0");
    expect(ledger(k.l1)).toBe("<none>");                                                    // a Check never fences
    const j = await app.journal.getJournalRecord(k.l1);
    expect(j?.state).toBe("reconciliation-required");
    return { l1: `still unknown and blocking (${res.reason}); journal: ${j?.state}`, server: "no payment", note: "'Send the same payment again' (same key) would execute it on the restored server — the correct recovery for a payment the restore lost, now an owner's reconciled decision (journal + continuity warning)" };
  });

  T("R8", "the refused lump sum stays final on the till (never resent) although the server no longer holds its refusal", async () => {
    const refused = (await app.localDb.syncState.toArray()).filter((r: any) => r.key.startsWith("online-op:")).map((r: any) => JSON.parse(r.value)).filter((o: any) => o.outcome === "refused");
    expect(refused.length).toBeGreaterThan(0);
    for (const o of refused) expect(log.slice(restoreMark).filter((l) => l.key === o.args.p_idempotency_key && l.rpc === "op_execute")).toHaveLength(0);
    const j = await app.journal.getJournalRecord(k.l2);
    expect(j).toMatchObject({ state: "rejected", evidence: { recordedOnServer: true } });
    return { l2: "settled refused on the till; never sent again after the restore; the journal keeps the refusal the server no longer has", gap: "re-recording the lost tombstone on the server is Phase 1" };
  });
});
