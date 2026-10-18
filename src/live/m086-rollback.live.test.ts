// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// MIGRATION 086 STAGE 1 -- rollback phase: the DOCUMENTED functions-only
// rollback, legacy safety afterwards, then forward re-apply. Disposable
// loopback stack only. Skipped unless M086_LIVE=1.
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { signedInClient, makeClient } from "./liveHelpers";
import { runSql } from "../../e2e/helpers/db";
import { liveCfg } from "../../e2e/helpers/env";
import { apply086, apply086Recorded, fingerprint, ledgerRowText, rollback086, snapshot, snapDiff, sql1, lit, delay } from "./p086-lib";

const enabled = process.env.M086_LIVE === "1";
// These tests apply and roll back migration 086: ONLY the disposable loopback
// stack (tools/m086-verify/run.sh sets both), never a configured real server.
if (enabled && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("M086_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run tools/m086-verify/run.sh)");
}
const results: { task: string; id: string; title: string; status: string; detail: unknown }[] = [];
function T(id: string, title: string, fn: () => Promise<any>) {
  it(`${id} ${title}`, async () => {
    try { const d = await fn(); results.push({ task: "rollback", id, title, status: "PASS", detail: d ?? "" }); console.log(`[m086] PASS ${id}`); }
    catch (e: any) { results.push({ task: "rollback", id, title, status: "FAIL", detail: String(e?.stack ?? e).slice(0, 2500) }); console.log(`[m086] FAIL ${id}: ${String(e?.message ?? e).slice(0, 400)}`); throw e; }
  }, 180_000);
}

describe.skipIf(!enabled)("086 Stage 1 rollback", () => {
  const st = enabled ? JSON.parse(readFileSync(process.env.P086_STATE!, "utf8")) : null;
  const cfg = enabled ? liveCfg() : (null as any);
  const A = st?.A.st;
  let cashA: any;
  const direct = (c: any, rpc: string, args: any, key: string): Promise<any> => Promise.resolve(c.rpc(rpc, { ...args, p_idempotency_key: key }));
  // every executor call here is cashier A's own operation
  const X = (c: any, key: string, rpc: string, args: any): Promise<any> =>
    Promise.resolve(c.rpc("op_execute", { p_key: key, p_rpc: rpc, p_args: args, p_actor_id: A.ids.cashA }));
  const sales = () => Number(sql1(`SELECT count(*) FROM sales WHERE shift_id = ${lit(st.shiftA)}`));
  const waitPgrst = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 80; i++) { if (await fn()) return; await delay(250); } throw new Error("PostgREST schema cache did not change"); };
  // organisation A's row (R.5 uses some of A's keys in organisation B: their own operations)
  const stateOf = (key: string) => sql1(`SELECT state || '/' || coalesce(outcome_code, '') FROM idempotency_keys WHERE key = ${lit(key)}::uuid AND org_id = ${lit(A.ids.org)}`);

  afterAll(() => writeFileSync(process.env.P086_EVIDENCE ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), results }, null, 2)));

  T("R.0", "database RESTART (container restart, clean shutdown): every outcome survives; executor and lookup work afterwards", async () => {
    cashA = await signedInClient(cfg, A.emails.cashA, st.pw);
    const before = sql1("SELECT md5(string_agg(k::text, '|' ORDER BY org_id, key)) || ' ' || count(*) FROM idempotency_keys k");
    execFileSync("docker", ["restart", "phf-iso-db"], { stdio: "ignore" });
    for (let i = 0; i < 120; i++) { try { if (sql1("SELECT 'up'") === "up") break; } catch { /* starting */ } await delay(500); }
    expect(sql1("SELECT md5(string_agg(k::text, '|' ORDER BY org_id, key)) || ' ' || count(*) FROM idempotency_keys k")).toBe(before);
    let st1: any;
    for (let i = 0; i < 120; i++) { st1 = await Promise.resolve(cashA.rpc("op_status", { p_key: st.keep.b2.key, p_rpc: "complete_sale", p_fence: false, p_expected_actor_id: null })); if (!st1.error) break; await delay(500); }
    expect(st1.data).toMatchObject({ status: "rejected", code: "P0001" });
    const x = (await X(cashA, st.keep.fenced.key, "complete_sale", st.keep.fenced.args)).data;
    expect(x).toEqual({ outcome: "abandoned", replayed: true });
    return { ledger: `identical after restart (${before.split(" ")[1]} rows)`, lookupAfterRestart: "rejected/P0001", executorAfterRestart: "abandoned replay" };
  });

  T("R.1", "functions-only rollback: op_* gone; columns, tombstones, safe prune and search_path hardening KEPT", async () => {
    cashA = cashA ?? await signedInClient(cfg, A.emails.cashA, st.pw);
    const tombstones = Number(sql1("SELECT count(*) FROM idempotency_keys WHERE state IN ('rejected','abandoned')"));
    const rb = readFileSync(process.env.M086_ROLLBACK!, "utf8");
    const ops = () => sql1("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'op\\_%'");
    const ops0 = ops();
    // the runner records 086 (this stack's db part applied it directly)
    apply086Recorded();
    // without the runner's owner gate (or outside a transaction) the preflight refuses; nothing changes
    expect(() => runSql(rb)).toThrow(/no owner confirmation/);
    expect(() => runSql(`BEGIN;\n${rb}\nCOMMIT;`)).toThrow(/no owner confirmation/);
    // a gate set by hand for the session is not the runner's transaction
    expect(() => runSql(`SET orvix.rollback_gate = 'till-queues-empty-confirmed-by-owner';\n${rb}`)).toThrow(/not inside the runner's transaction/);
    expect(() => runSql(`BEGIN;\nSET LOCAL orvix.rollback_gate = 'till-queues-empty-confirmed-by-owner';\n${rb}\nCOMMIT;`)).toThrow(/not inside the runner's transaction/);
    expect(ops()).toBe(ops0);
    expect(sql1("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '086'")).toBe("1");
    // as apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty runs it: one transaction, gate set
    const ledger0 = sql1("SELECT count(*) || ' ' || md5(string_agg(k::text, '|' ORDER BY org_id, key)) FROM idempotency_keys k");
    rollback086(rb);
    expect(sql1("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '086'")).toBe("0");
    expect(sql1("SELECT count(*) || ' ' || md5(string_agg(k::text, '|' ORDER BY org_id, key)) FROM idempotency_keys k")).toBe(ledger0);
    // a second rollback refuses in its preflight (086 is no longer applied)
    expect(() => rollback086(rb)).toThrow(/086 is not applied here/);
    expect(sql1("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'op\\_%'")).toBe("0");
    expect(Number(sql1("SELECT count(*) FROM idempotency_keys WHERE state IN ('rejected','abandoned')"))).toBe(tombstones);
    expect(sql1("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proconfig = '{search_path=public}'")).toBe("0");
    const hardened = sql1(`SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proconfig = '{"search_path=public, pg_temp"}'`);
    // idem_begin is the 085 behaviour on the per-organisation ledger: the 086
    // body WITHOUT the UUIDv7 guard (the 085 key-only body would read another
    // organisation's row); its md5 is the one the generated rollback checks
    // (the post-check's md5; the preflight's is the 086 body)
    const rollbackMd5 = /<> '([0-9a-f]{32})' THEN\n {4}RAISE EXCEPTION 'rollback post-check: idem_begin is not the per-organisation body/.exec(readFileSync(process.env.M086_ROLLBACK!, "utf8"))![1];
    expect(sql1("SELECT md5(prosrc) || ' ' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure"))
      .toBe(`${rollbackMd5} search_path=public, pg_temp`);
    expect(sql1("SELECT prosrc LIKE '%OP_EXECUTOR_REQUIRED%' FROM pg_proc WHERE oid = 'public.idem_begin(uuid,text,text)'::regprocedure")).toBe("f");
    expect(sql1("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'idempotency_keys_pkey'")).toBe("PRIMARY KEY (org_id, key)");
    // the kept prune is INERT without the executor and its guard: even a 14-month-old v7 tombstone stays
    const oldKey = sql1("SELECT overlay(replace(gen_random_uuid()::text, '-', '') placing lpad(to_hex((extract(epoch FROM now() - interval '14 months') * 1000)::bigint), 12, '0') from 1 for 12)");
    const k14 = `${oldKey.slice(0, 8)}-${oldKey.slice(8, 12)}-7${oldKey.slice(13, 16)}-8${oldKey.slice(17, 20)}-${oldKey.slice(20, 32)}`;
    runSql(`INSERT INTO idempotency_keys (key, rpc, actor_id, org_id, request_hash, state, outcome_code, decided_at, created_at)
            VALUES ('${k14}', 'complete_sale', ${lit(A.ids.cashA)}, ${lit(A.ids.org)}, 'R:' || md5('old'), 'rejected', 'P0001', now() - interval '14 months', now() - interval '14 months')`);
    const svc = makeClient(cfg, cfg.serviceKey);
    const pruned = await svc.rpc("prune_idempotency_keys");
    expect(pruned.error).toBeNull();
    expect(pruned.data).toBe(0);
    expect(ledgerRowText(k14)).not.toBe("<none>");
    expect(Number(sql1("SELECT count(*) FROM idempotency_keys WHERE state IN ('rejected','abandoned')"))).toBe(tombstones + 1);
    await waitPgrst(async () => (await X(cashA, randomUUID(), "complete_sale", {})).error?.code === "PGRST202");
    const gone = await X(cashA, randomUUID(), "complete_sale", {});
    return { gate: "refused without the owner gate / outside the runner transaction", ledgerRow086: "removed by the rollback", operationLedger: "byte-identical", secondRollback: "refused (086 not applied)", tombstonesKept: tombstones, hardenedKept: Number(hardened), idemBegin: "086 per-organisation body without the UUIDv7 guard (not the 085 key-only body)", pruneAfterRollback: `inert: ${pruned.data} deleted (a 14-month-old v7 tombstone kept)`, executorCall: `${gone.error.code} (an 086 client falls back / holds)` };
  });

  T("R.2", "after rollback: rejected and abandoned keys still cannot execute through the 085 direct path", async () => {
    const s0 = snapshot(A.ids.org);
    const out: string[] = [];
    for (const [n, k] of [["rejected (B2)", st.keep.b2], ["abandoned (fenced)", st.keep.fenced]] as const) {
      const before = ledgerRowText(k.key);
      const r = await direct(cashA, "complete_sale", k.args, k.key);
      expect(r.error?.code).toBe("23505");
      expect(r.error?.message).toMatch(/^IDEMPOTENCY_MISMATCH/);
      expect(ledgerRowText(k.key)).toBe(before);
      out.push(`${n}: ${r.error.code} ${r.error.message.slice(0, 21)}`);
    }
    expect(snapDiff(s0, snapshot(A.ids.org))).toEqual([]);
    return out;
  });

  T("R.3", "after rollback: committed keys replay identically; new direct sales work; a direct refusal leaves no row (085 semantics)", async () => {
    const sale = st.L.find((l: any) => l.name === "complete_sale");
    const r1 = await direct(cashA, sale.rpc, sale.args, sale.key);
    const r2 = await direct(cashA, "complete_sale", st.keep.execCommitted.args, st.keep.execCommitted.key);
    expect(r1.data).toEqual(sale.response);
    expect(r2.data).toEqual(st.keep.execCommitted.response);
    const n0 = sales();
    const r3 = await direct(cashA, "complete_sale", { ...sale.args, p_created_at: new Date().toISOString() }, randomUUID());
    expect(r3.error).toBeNull();
    expect(sales()).toBe(n0 + 1);
    expect(stateOf(r3.data ? sql1(`SELECT key::text FROM idempotency_keys WHERE response->'sale'->>'id' = ${lit(r3.data.sale.id)}`) : "")).toBe("committed/");
    const k4 = randomUUID();
    const r4 = await direct(cashA, "complete_sale", { ...sale.args, p_items: [{ product_id: A.ids.prod2, qty: 1000000, units_per_item: 1 }], p_paid_mmk: 2000000000 }, k4);
    expect(r4.error?.code).toBe("P0001");
    expect(ledgerRowText(k4)).toBe("<none>");
    return { preReplay: "identical", executorCommittedReplay: "identical", newDirectSale: "committed (state default committed)", directRefusal: "no row (B2 for legacy path, as at 085)" };
  });

  T("R.5", "after rollback: organisations stay separate on the rolled-back idem_begin — one key in two organisations is two operations, each replayed only in its own; a refused key of A runs nothing in A; a pre-074 key stays refused everywhere", async () => {
    const B = st.B.st;
    const mgrA = await signedInClient(cfg, A.emails.mgr, st.pw);
    const mgrB = await signedInClient(cfg, B.emails.mgr, st.pw);
    const adj = (t: any, delta = 1) => ({
      p_shop_id: t.ids.shop, p_product_id: t.ids.prod1, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: delta, p_reason: "m086 R.5",
      p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: t.ids.mgr,
    });
    const moves = (org: string) => Number(sql1(`SELECT count(*) FROM inventory_movements WHERE shop_id IN (SELECT id FROM shops WHERE org_id = ${lit(org)})`));
    const rowsOf = (key: string) => sql1(`SELECT coalesce(string_agg(org_id || '=' || state, ',' ORDER BY org_id), '<none>') FROM idempotency_keys WHERE key = ${lit(key)}::uuid`);
    // one key, two organisations
    const k = randomUUID();
    const a0 = moves(A.ids.org), b0 = moves(B.ids.org);
    const ra = await direct(mgrA, "adjust_stock", adj(A), k);
    const rb = await direct(mgrB, "adjust_stock", adj(B, 2), k);
    expect(ra.error).toBeNull();
    expect(rb.error).toBeNull();
    expect(moves(A.ids.org)).toBe(a0 + 1);
    expect(moves(B.ids.org)).toBe(b0 + 1);
    expect(rowsOf(k)).toBe([`${A.ids.org}=committed`, `${B.ids.org}=committed`].sort().join(","));
    const reA = await direct(mgrA, "adjust_stock", adj(A), k);
    const reB = await direct(mgrB, "adjust_stock", adj(B, 2), k);
    expect(reA.data).toEqual(ra.data);
    expect(reB.data).toEqual(rb.data);
    expect(JSON.stringify(reB.data)).not.toContain(A.ids.shop);
    expect(moves(A.ids.org)).toBe(a0 + 1);
    expect(moves(B.ids.org)).toBe(b0 + 1);
    // B using A's REJECTED key: B's own operation at most — nothing runs in A, A's tombstone unchanged, no A data
    const tomb = ledgerRowText(st.keep.b2.key, A.ids.org);
    const a1 = moves(A.ids.org);
    const steal = await direct(mgrB, "adjust_stock", adj(B), st.keep.b2.key);
    expect(moves(A.ids.org)).toBe(a1);
    expect(ledgerRowText(st.keep.b2.key, A.ids.org)).toBe(tomb);
    expect(JSON.stringify(steal.data ?? steal.error ?? {})).not.toContain(A.ids.shop);
    // a pre-074 key (no organisation) stays refused in every organisation
    const k0 = randomUUID();
    runSql(`INSERT INTO idempotency_keys (key, rpc, actor_id, org_id, request_hash) VALUES (${lit(k0)}, 'adjust_stock', NULL, '!unattributed', md5('pre-074'))`);
    try {
      const u1 = await direct(mgrA, "adjust_stock", adj(A), k0);
      const u2 = await direct(mgrB, "adjust_stock", adj(B), k0);
      expect(u1.error?.message ?? "").toMatch(/^IDEMPOTENCY_MISMATCH/);
      expect(u2.error?.message ?? "").toMatch(/^IDEMPOTENCY_MISMATCH/);
      expect(rowsOf(k0)).toBe("!unattributed=committed");
    } finally {
      runSql(`DELETE FROM idempotency_keys WHERE org_id = '!unattributed' AND key = ${lit(k0)}::uuid`);
    }
    return { sameKeyTwoOrgs: "two operations, each replayed in its own organisation", bWithARejectedKey: steal.error ? `refused: ${steal.error.code}` : "B's own operation; nothing in A", pre074: "refused in A and B" };
  });

  T("R.4", "forward re-apply after the rollback: preflight accepts the kept columns; outcomes intact (codes kept); executor serves them", async () => {
    const sql = readFileSync(process.env.M086_MIGRATION!, "utf8");
    apply086(sql);
    await waitPgrst(async () => !(await X(cashA, randomUUID(), "complete_sale", {})).error?.code?.startsWith("PGRST"));
    expect(fingerprint()).toEqual(st.keep.fp086);
    expect(stateOf(st.keep.b2.key)).toBe("rejected/P0001");
    expect(stateOf(st.keep.fenced.key)).toBe("abandoned/FENCED");
    const x1 = (await X(cashA, st.keep.b2.key, "complete_sale", st.keep.b2.args)).data;
    const x2 = (await X(cashA, st.keep.fenced.key, "complete_sale", st.keep.fenced.args)).data;
    const x3 = (await X(cashA, st.keep.execCommitted.key, "complete_sale", st.keep.execCommitted.args)).data;
    expect(x1).toMatchObject({ outcome: "rejected", replayed: true, code: "P0001" });
    expect(x2).toEqual({ outcome: "abandoned", replayed: true });
    expect(x3).toMatchObject({ outcome: "committed", replayed: true });
    expect(x3.response).toEqual(st.keep.execCommitted.response);
    return { fingerprint: "identical to the first 086 apply", rejected: "rejected/P0001 (code kept)", abandoned: "abandoned/FENCED", committed: "replayed identical" };
  });
});
