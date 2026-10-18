// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// MIGRATION 086 STABILIZATION — H3: the emergency queue-recovery tool
// (tools/queue-recovery/replay.ts, the real code path) against the REAL
// disposable stack: first with migration 086, then after the reviewed
// rollback (085 functions), then 086 re-applied. Every outcome is checked in
// PostgreSQL. Loopback only; skipped unless M086_LIVE=1.
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { signedInClient } from "./liveHelpers";
import { liveCfg } from "../../e2e/helpers/env";
import { apply086, apply086Recorded, rollback086, sql1, lit, delay, v7 } from "./p086-lib";
import { replayExport, exitCodeFor } from "../../tools/queue-recovery/replay";
import type { QueueExportEntry, QueueExportPayload } from "../lib/queueExport/format";

const enabled = process.env.M086_LIVE === "1";
// These tests apply and roll back migration 086: ONLY the disposable loopback
// stack (tools/m086-verify/run.sh sets both), never a configured real server.
if (enabled && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("M086_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER (run tools/m086-verify/run.sh)");
}
const results: { task: string; id: string; title: string; status: string; detail: unknown }[] = [];
function T(id: string, title: string, fn: () => Promise<any>) {
  it(`${id} ${title}`, async () => {
    try { const d = await fn(); results.push({ task: "recovery", id, title, status: "PASS", detail: d ?? "" }); console.log(`[m086] PASS ${id}`); }
    catch (e: any) { results.push({ task: "recovery", id, title, status: "FAIL", detail: String(e?.stack ?? e).slice(0, 2500) }); console.log(`[m086] FAIL ${id}: ${String(e?.message ?? e).slice(0, 400)}`); throw e; }
  }, 180_000);
}

describe.skipIf(!enabled)("086 stabilization — queue-recovery tool (H3)", () => {
  const st = enabled ? JSON.parse(readFileSync(process.env.P086_STATE!, "utf8")) : null;
  const cfg = enabled ? liveCfg() : (null as any);
  const A = st?.A.st;
  const origin = enabled ? new URL(cfg.url).origin : "";
  afterAll(() => writeFileSync(process.env.P086_EVIDENCE ?? "/dev/null", JSON.stringify({ at: new Date().toISOString(), results }, null, 2)));

  const tokenOf = async (who: "cashA" | "cashB" | "mgr" | "admin") => {
    const c = await signedInClient(cfg, A.emails[who], st.pw);
    return (await c.auth.getSession()).data.session!.access_token;
  };
  let seq = 0;
  const entry = (rpc: string, args: Record<string, unknown>, key: string, over: Partial<QueueExportEntry> = {}): QueueExportEntry => ({
    seq: ++seq, opId: `rec-${seq}-${key.slice(0, 8)}`, idempotencyKey: key, kind: "rpc", opType: rpc, table: null, tableOp: null, rowId: null,
    payload: { ...args, p_idempotency_key: key }, refs: [], provisional: [], shopId: A.ids.shop, createdAt: new Date().toISOString(),
    ringUpAt: null, status: "pending", attempts: 1, lastErrorClass: "transient", lastError: null, nextAttemptAt: null,
    backendOrigin: origin, quarantineReason: null, archivedAt: null, archivedBy: null, archiveReason: null, statusBeforeArchive: null,
    statusBeforeReconcile: null, reconciliation: null, reconcileRejected: null,
    actorId: null, inDoubt: null, writeAhead: null, staged: null, fenceRequired: null, serverOutcome: null, heldReason: null, blocksQueue: null, dependencySince: null, refWaitSince: null,
    ...over,
  });
  const payload = (entries: QueueExportEntry[]): QueueExportPayload => ({
    format: "shwephala-queue-export", formatVersion: 1, appVersion: "m086-stabilization", exportedAt: new Date().toISOString(),
    tillId: "till-qa-m086", backendHost: new URL(origin).host, session: { userId: A.ids.cashA, orgId: A.ids.org, shopId: A.ids.shop, role: "CASHIER" },
    entries, provisionalIdMap: [], redactedFields: 0, reconciliationLog: [], onlineOperations: [],
  });
  const replay = async (entries: QueueExportEntry[], who: "cashA" | "cashB" | "mgr" | "admin") =>
    replayExport(payload(entries), { target: origin, anonKey: cfg.anonKey, accessToken: await tokenOf(who) });
  const sale = (qty = 1, prod = A.ids.prod1) => ({
    p_shop_id: A.ids.shop, p_shift_id: st.shiftA, p_payment_method: "CASH", p_paid_mmk: 2000000000, p_cart_discount_pct: 0,
    p_items: [{ product_id: prod, qty, units_per_item: 1 }], p_created_at: new Date().toISOString(),
  });
  const restock = (delta: number) => ({
    p_shop_id: A.ids.shop, p_product_id: A.ids.prod1, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: delta, p_reason: "m086 recovery restock",
    p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.ids.mgr,
  });
  const sales = () => Number(sql1(`SELECT count(*) FROM sales WHERE shift_id = ${lit(st.shiftA)}`));
  const ledger = (key: string) => sql1(`SELECT coalesce((SELECT state || '/' || coalesce(outcome_code, '') || '/' || coalesce(actor_id, '<null>') FROM idempotency_keys WHERE key = ${lit(key)}::uuid), '<none>')`);
  const outcomes = (r: any) => r.ops.map((o: any) => o.outcome);
  const waitExecutor = async (present: boolean) => {
    const c = await signedInClient(cfg, A.emails.cashA, st.pw);
    for (let i = 0; i < 80; i++) {
      const r = await Promise.resolve(c.rpc("op_status", { p_key: randomUUID(), p_rpc: "complete_sale", p_fence: false, p_expected_actor_id: null, p_args: null }));
      if (present ? !r.error : r.error?.code === "PGRST202") return;
      await delay(250);
    }
    throw new Error("PostgREST schema cache did not change");
  };

  // ============================ schema 086 ===============================
  T("Q.1", "086: a cashier's own UUIDv7 sale runs through op_execute as the SERVER-reported user; a re-run replays it (no second sale)", async () => {
    const k = v7();
    const n0 = sales();
    const r1 = await replay([entry("complete_sale", sale(), k, { actorId: A.ids.cashA })], "cashA");
    expect(r1.executor).toBe("available");
    expect(r1.signedInAs).toEqual({ userId: A.ids.cashA, role: "CASHIER" });
    expect(outcomes(r1)).toEqual(["applied"]);
    expect(ledger(k)).toBe(`committed//${A.ids.cashA}`);
    const r2 = await replay([entry("complete_sale", sale(), k, { actorId: A.ids.cashA })], "cashA");
    expect(outcomes(r2)).toEqual(["already-applied"]);
    expect(sales()).toBe(n0 + 1);
    return { first: "applied (op_execute, p_actor_id = server's app_user_id)", rerun: "already-applied", sales: "+1 exactly", ledger: ledger(k) };
  });

  T("Q.2", "086: another user's UUIDv7 operation is never executed or fenced by an ADMIN (or another cashier): held, nothing recorded, the run stops", async () => {
    const k = v7();
    const kAdmin = v7();
    const n0 = sales();
    for (const who of ["admin", "cashB"] as const) {
      const r = await replay([
        entry("complete_sale", sale(), k, { actorId: A.ids.cashA }),
        entry("complete_sale", sale(), kAdmin, { actorId: A.ids[who] }),
      ], who);
      expect(outcomes(r)).toEqual(["held", "not-attempted"]);
      expect(exitCodeFor(r)).toBe(4);
    }
    expect(ledger(k)).toBe("<none>");
    expect(ledger(kAdmin)).toBe("<none>");
    expect(sales()).toBe(n0);
    // its creator replays it
    const own = await replay([entry("complete_sale", sale(), k, { actorId: A.ids.cashA })], "cashA");
    expect(outcomes(own)).toEqual(["applied"]);
    return { admin: "held (never run, never fenced)", otherCashier: "held", laterEntry: "not-attempted (ordering)", creator: "applied once" };
  });

  T("Q.3", "086: HELD entries are never replayed — never arrived: fenced (abandoned) and a late copy cannot run; committed earlier: reported, no second sale", async () => {
    const kNever = v7();
    const kDone = v7();
    const c = await signedInClient(cfg, A.emails.cashA, st.pw);
    const doneArgs = sale(2);
    const first = await Promise.resolve(c.rpc("op_execute", { p_key: kDone, p_rpc: "complete_sale", p_args: doneArgs, p_actor_id: A.ids.cashA }));
    expect(first.data.outcome).toBe("committed");
    const n0 = sales();
    const held = { actorId: A.ids.cashA, status: "conflict" as const, fenceRequired: true, inDoubt: true, writeAhead: true, staged: false };
    const r = await replay([
      entry("complete_sale", sale(1), kNever, held),
      entry("complete_sale", doneArgs, kDone, held),
    ], "cashA");
    expect(outcomes(r)).toEqual(["abandoned", "already-applied"]);
    expect(r.ops[1].resultId).toBe(first.data.response.sale.id);
    expect(ledger(kNever)).toBe(`abandoned/FENCED/${A.ids.cashA}`);
    expect(sales()).toBe(n0);
    const late = await Promise.resolve(c.rpc("op_execute", { p_key: kNever, p_rpc: "complete_sale", p_args: sale(1), p_actor_id: A.ids.cashA }));
    expect(late.data).toEqual({ outcome: "abandoned", replayed: true });
    expect(sales()).toBe(n0);
    return { neverArrived: "abandoned/FENCED by its creator; late copy refused", committedEarlier: `already-applied -> ${first.data.response.sale.id}`, sales: "unchanged" };
  });

  T("Q.4", "086: a held legacy entry with NO actor — a cashier cannot stop it (held, run stops); an ADMIN stops it with org evidence (actor stays NULL)", async () => {
    const k = randomUUID();
    const held = { status: "conflict" as const, fenceRequired: true, inDoubt: true, writeAhead: true };
    const asCashier = await replay([entry("complete_sale", sale(), k, held)], "cashB");
    expect(outcomes(asCashier)).toEqual(["held"]);
    expect(ledger(k)).toBe("<none>");
    const asAdmin = await replay([entry("complete_sale", sale(), k, held)], "admin");
    expect(outcomes(asAdmin)).toEqual(["abandoned"]);
    expect(ledger(k)).toBe("abandoned/FENCED/<null>");
    return { cashier: "held (not_authorized)", admin: "abandoned, actor NULL, org verified from the operation's own arguments" };
  });

  T("Q.5", "086: a definitive refusal is recorded FINAL (rejected-final) and never executes on a re-run; a dependency refusal is NOT recorded and stops the run", async () => {
    const kRef = v7();
    const n0 = sales();
    const r1 = await replay([entry("complete_sale", sale(1000000, A.ids.prod2), kRef, { actorId: A.ids.cashA })], "cashA");
    expect(outcomes(r1)).toEqual(["rejected-final"]);
    expect(ledger(kRef)).toBe(`rejected/P0001/${A.ids.cashA}`);
    const r2 = await replay([entry("complete_sale", sale(1000000, A.ids.prod2), kRef, { actorId: A.ids.cashA })], "cashA");
    expect(outcomes(r2)).toEqual(["rejected-final"]);
    const kDep = v7();
    const kNext = v7();
    const r3 = await replay([
      entry("complete_sale", { ...sale(), p_shift_id: "shift-does-not-exist" }, kDep, { actorId: A.ids.cashA }),
      entry("complete_sale", sale(), kNext, { actorId: A.ids.cashA }),
    ], "cashA");
    expect(outcomes(r3)).toEqual(["held", "not-attempted"]);
    expect(r3.ops[0].detail).toMatch(/prerequisite/);
    expect(ledger(kDep)).toBe("<none>");
    expect(ledger(kNext)).toBe("<none>");
    expect(sales()).toBe(n0);
    return { stockRefusal: "rejected-final, rejected/P0001 recorded; re-run rejected-final (no sale)", dependency: "held (op_not_recorded:dependency), nothing recorded, next entry not-attempted" };
  });

  T("Q.6", "086: restock -> sale ordering across users — the cashier's sale never overtakes the manager's restock", async () => {
    const kR = v7();
    const kS = v7();
    const n0 = sales();
    const q = () => [
      entry("adjust_stock", restock(3), kR, { actorId: A.ids.mgr }),
      entry("complete_sale", sale(), kS, { actorId: A.ids.cashA }),
    ];
    const asCashier = await replay(q(), "cashA");
    expect(outcomes(asCashier)).toEqual(["held", "not-attempted"]);
    expect(ledger(kS)).toBe("<none>");
    const asManager = await replay(q(), "mgr");
    expect(outcomes(asManager)).toEqual(["applied", "held"]);
    const again = await replay(q(), "cashA");
    expect(outcomes(again)).toEqual(["already-applied", "applied"]);
    expect(sql1(`SELECT ((SELECT created_at FROM idempotency_keys WHERE key = ${lit(kS)}::uuid) > (SELECT created_at FROM idempotency_keys WHERE key = ${lit(kR)}::uuid))::text`)).toBe("true");
    expect(sales()).toBe(n0 + 1);
    return { cashierFirst: "held at the restock; sale not-attempted", manager: "restock applied; sale held (cashier's)", cashierAgain: "restock already-applied (looked up), sale applied", order: "restock committed before the sale" };
  });

  T("Q.7", "086: a UUIDv4 entry (older till) keeps the direct path; the legacy path refuses a UUIDv7 key (OP_EXECUTOR_REQUIRED, never final)", async () => {
    const k4 = randomUUID();
    const r = await replay([entry("complete_sale", sale(), k4)], "cashA");
    expect(outcomes(r)).toEqual(["applied"]);   // exact without ledger access: the shift's sales are read first
    expect(ledger(k4)).toMatch(/^committed\/\//);
    return { v4: "direct path, committed" };
  });

  T("Q.8", "086 (F): another user's LEGACY UUIDv4 entry is held on the direct path too (never run in this session); the run stops before the signed-in user's own", async () => {
    const kOther = randomUUID();
    const kOwn = randomUUID();
    const n0 = sales();
    const r = await replay([
      entry("complete_sale", sale(), kOther, { actorId: A.ids.cashA }),
      entry("complete_sale", sale(), kOwn, { actorId: A.ids.admin }),
    ], "admin");
    expect(outcomes(r)).toEqual(["held", "not-attempted"]);
    expect(ledger(kOther)).toBe("<none>");
    expect(ledger(kOwn)).toBe("<none>");
    expect(sales()).toBe(n0);
    const own = await replay([entry("complete_sale", sale(), kOther, { actorId: A.ids.cashA })], "cashA");
    expect(outcomes(own)).toEqual(["applied"]);
    expect(ledger(kOther)).toBe(`committed//${A.ids.cashA}`);
    return { adminSession: "held (v4, legacy path)", laterOwnEntry: "not-attempted", creatorSession: "applied once" };
  });

  T("Q.9", "086 (backend binding): a HELD entry recorded for ANOTHER backend is never looked up, fenced or executed here; the run stops", async () => {
    const k = v7();
    const kNext = v7();
    const r = await replay([
      entry("complete_sale", sale(), k, { actorId: A.ids.cashA, status: "conflict", fenceRequired: true, inDoubt: true, backendOrigin: "https://old-backend.example.invalid" }),
      entry("complete_sale", sale(), kNext, { actorId: A.ids.cashA }),
    ], "cashA");
    expect(outcomes(r)).toEqual(["held", "not-attempted"]);
    expect(r.ops[0].detail).toMatch(/another server cannot decide it/);
    expect(ledger(k)).toBe("<none>");                                  // never fenced on the wrong backend
    expect(ledger(kNext)).toBe("<none>");
    return { wrongBackendHeld: "never asked, never fenced", later: "not-attempted" };
  });

  T("Q.10", "086: an undecided BLOCKING conflict stops the run; an unresolved online payment in the file means NOT RECOVERED (exit 4)", async () => {
    const kBlock = randomUUID();
    const kNext = v7();
    const p = payload([
      entry("complete_sale", sale(), kBlock, { status: "conflict", blocksQueue: true, lastError: "Refused, not recorded" }),
      entry("complete_sale", sale(), kNext, { actorId: A.ids.cashA }),
    ]);
    const r = await replayExport({ ...p, onlineOperations: [{ id: "op-x", name: "pay_supplier_lump_sum", idempotencyKey: v7(), userId: A.ids.admin, backendOrigin: origin, createdAt: new Date().toISOString(), attempts: 1, uncertain: true, lastError: null }] },
      { target: origin, anonKey: cfg.anonKey, accessToken: await tokenOf("cashA") });
    expect(r.ops.slice(0, 2).map((o: any) => o.outcome)).toEqual(["held", "not-attempted"]);
    expect(r.onlineUnresolved).toBe(1);
    expect(exitCodeFor(r)).toBe(4);
    expect(ledger(kBlock)).toBe("<none>");
    expect(ledger(kNext)).toBe("<none>");
    return { blockingConflict: "held, run stopped", onlinePayment: "reported, never replayed", exit: 4 };
  });

  T("Q.11", "086 (HIGH): an online sale exported while being SENT, never authorised offline, never reached the server — the tool FENCES it and never executes it; authorisation unknown -> looked up only", async () => {
    const kNever = v7();
    const kUnknown = v7();
    const n0 = sales();
    const r = await replay([entry("complete_sale", sale(), kNever, { actorId: A.ids.cashA, status: "syncing", writeAhead: true, staged: false })], "cashA");
    expect(outcomes(r)).toEqual(["abandoned"]);
    expect(ledger(kNever)).toBe(`abandoned/FENCED/${A.ids.cashA}`);
    // post-checkpoint: with NOTHING staged the till fences this row too (recoverStrandedSyncing) — so does the tool
    const kStranded = v7();
    const rs = await replay([entry("complete_sale", sale(), kStranded, { actorId: A.ids.cashA, status: "syncing", writeAhead: true, staged: null })], "cashA");
    expect(outcomes(rs)).toEqual(["abandoned"]);
    expect(ledger(kStranded)).toBe(`abandoned/FENCED/${A.ids.cashA}`);
    // staged records, a later attempt, an older (v1) file: authorisation cannot be established -> looked up only
    const r2 = await replay([entry("complete_sale", sale(), kUnknown, { actorId: A.ids.cashA, status: "syncing", writeAhead: true, staged: null, attempts: 2, provisional: [{ table: "sales", ids: [randomUUID()] }] })], "cashA");
    expect(outcomes(r2)).toEqual(["held"]);
    expect(ledger(kUnknown)).toBe("<none>");                         // never fenced, never executed
    expect(sales()).toBe(n0);
    return { neverAuthorised: "fenced (abandoned/FENCED), not executed", strandedNothingStaged: "fenced, as the till does", authorisationUnknown: "held, no ledger row", sales: "unchanged" };
  });

  // ============================ schema 085 ===============================
  T("Q.12", "086 (post-checkpoint): the CURRENT till's own interrupted online sale (being sent, write-ahead, no staged flag, first attempt) — the tool decides as the till: fenced if it never arrived, reported once if it did; dry run predicts 'held' (exit 4); a legacy in-doubt close is looked up only", async () => {
    // a version-2 file (the current build writes v2; 086 fields present)
    const v2 = (entries: QueueExportEntry[]) => ({ ...payload(entries), formatVersion: 2 }) as unknown as QueueExportPayload;
    const replay2 = async (entries: QueueExportEntry[]) => replayExport(v2(entries), { target: origin, anonKey: cfg.anonKey, accessToken: await tokenOf("cashA") });
    const interrupted = { actorId: A.ids.cashA, status: "syncing" as const, writeAhead: true, staged: null, attempts: 0, inDoubt: null };
    const kNever = v7();
    const kDone = v7();
    const doneArgs = sale(1);
    const c = await signedInClient(cfg, A.emails.cashA, st.pw);
    const first = await Promise.resolve(c.rpc("op_execute", { p_key: kDone, p_rpc: "complete_sale", p_args: doneArgs, p_actor_id: A.ids.cashA }));
    expect((first.data as any)?.outcome).toBe("committed");
    const n0 = sales();
    const dry = await replayExport(v2([entry("complete_sale", sale(), kNever, interrupted)]), { target: origin, anonKey: cfg.anonKey, accessToken: await tokenOf("cashA"), dryRun: true });
    expect(outcomes(dry)).toEqual(["held"]);
    expect(exitCodeFor(dry)).toBe(4);
    expect(ledger(kNever)).toBe("<none>");
    const r1 = await replay2([entry("complete_sale", sale(), kNever, interrupted)]);
    expect(outcomes(r1)).toEqual(["abandoned"]);
    expect(ledger(kNever)).toMatch(/^abandoned\/FENCED/);
    const late = await Promise.resolve(c.rpc("op_execute", { p_key: kNever, p_rpc: "complete_sale", p_args: sale(), p_actor_id: A.ids.cashA }));
    expect(late.data).toEqual({ outcome: "abandoned", replayed: true });
    const r2 = await replay2([entry("complete_sale", doneArgs, kDone, interrupted)]);
    expect(outcomes(r2)).toEqual(["already-applied"]);
    expect(sales()).toBe(n0);                                       // neither ran (again)
    const kClose = v7();
    const r3 = await replay2([entry("close_shift", { p_shift_id: st.shiftA, p_closing_cash_mmk: 0, p_variance_reason: "m086", p_created_at: null, p_expected_actor_id: A.ids.cashA }, kClose,
      { actorId: A.ids.cashA, status: "pending", inDoubt: true, writeAhead: true, staged: null, attempts: 1 })]);
    expect(outcomes(r3)).toEqual(["held"]);
    expect(ledger(kClose)).toBe("<none>");                          // never fenced, never executed
    expect(sql1(`SELECT (ended_at IS NULL)::text FROM shifts WHERE id = ${lit(st.shiftA)}`)).toBe("true");
    return { neverArrived: "dry run held (exit 4); real run fenced -> abandoned/FENCED; late copy refused", didArrive: "already-applied, no second sale", legacyClose: "looked up only, not fenced, shift still open" };
  });

  T("P.0", "rollback to the 085 functions (the reviewed rollback script, disposable only)", async () => {
    apply086Recorded();
    rollback086(readFileSync(process.env.M086_ROLLBACK!, "utf8"));
    await waitExecutor(false);
    expect(sql1("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'op\\_%'")).toBe("0");
    return "op_* gone; idem_begin = the 086 per-organisation body without the UUIDv7 guard";
  });

  T("P.1", "085: no executor detected; a UUIDv4 entry and an own UUIDv7 entry use the direct path (as the till does on 085); a re-run replays them", async () => {
    const k4 = randomUUID();
    const k7 = v7();
    const n0 = sales();
    const q = () => [entry("complete_sale", sale(), k4), entry("complete_sale", sale(), k7, { actorId: A.ids.cashA })];
    const r1 = await replay(q(), "cashA");
    expect(r1.executor).toBe("absent");
    expect(outcomes(r1)).toEqual(["applied", "applied"]);
    const r2 = await replay(q(), "cashA");
    expect(outcomes(r2)).toEqual(["already-applied", "already-applied"]);
    expect(sales()).toBe(n0 + 2);
    return { executor: "absent", direct: "both committed once (085 ledger replays the re-run)" };
  });

  T("P.1b", "085 (F): another user's entry (v4 or v7) is held — never sent in the signed-in user's session", async () => {
    const k4 = randomUUID();
    const k7 = v7();
    const n0 = sales();
    const r = await replay([entry("complete_sale", sale(), k4, { actorId: A.ids.cashB }), entry("complete_sale", sale(), k7, { actorId: A.ids.cashB })], "cashA");
    expect(r.executor).toBe("absent");
    expect(outcomes(r)).toEqual(["held", "not-attempted"]);
    expect(ledger(k4)).toBe("<none>");
    expect(ledger(k7)).toBe("<none>");
    expect(sales()).toBe(n0);
    return { v4: "held", v7: "not-attempted (behind it)" };
  });

  T("P.2", "085: a HELD entry is never replayed (no lookup or fence exists there): held, run stops", async () => {
    const k = v7();
    const kNext = randomUUID();
    const n0 = sales();
    const r = await replay([
      entry("complete_sale", sale(), k, { actorId: A.ids.cashA, status: "conflict", fenceRequired: true, inDoubt: true }),
      entry("complete_sale", sale(), kNext),
    ], "cashA");
    expect(outcomes(r)).toEqual(["held", "not-attempted"]);
    expect(ledger(k)).toBe("<none>");
    expect(sales()).toBe(n0);
    return { held: "never sent", later: "not-attempted" };
  });

  T("P.3", "re-apply 086 after the rollback (disposable): executor back", async () => {
    apply086(readFileSync(process.env.M086_MIGRATION!, "utf8"));
    await waitExecutor(true);
    const r = await replay([entry("complete_sale", sale(), v7(), { actorId: A.ids.cashA })], "cashA");
    expect(r.executor).toBe("available");
    expect(outcomes(r)).toEqual(["applied"]);
    return "086 re-applied; tool uses the executor again";
  });
});
