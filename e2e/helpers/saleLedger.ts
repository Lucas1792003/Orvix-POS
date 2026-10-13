// Duplicate-sale detection for the consistency gate (helpers/consistency.ts).
//
// Replaces the old heuristic "same shift + same total (+ same lines) with
// created_at within 2 s", which both flagged legitimate back-to-back sales of
// the same basket (two distinct queued operations) and could miss a genuine
// duplicate created more than 2 s apart. Instead every sale is tied to the
// operation that produced it:
//
//   1. Key ledger. Since migration 062/063 complete_sale cannot run without
//      an idempotency key, and the key row stores the RPC's response (the
//      sale id) in the same transaction as the sale. So every committed sale
//      maps to EXACTLY ONE committed complete_sale key:
//        - a sale no key claims          -> written outside complete_sale
//                                           (or a second row for one key);
//        - a sale claimed by 2+ keys     -> ledger corrupted;
//        - a committed key whose sale is gone -> a lost sale.
//   2. Client operation identity. The client mints (idempotency key,
//      createdAt) once per operation (beginOperation()) and replays both
//      verbatim (outbox args); complete_sale stores createdAt as
//      sales.created_at (resolve_event_time keeps any time within -48 h/+5 min).
//      Two sales of one cashier+shift with the SAME created_at are therefore
//      one client operation applied twice (e.g. replayed under a fresh key).
//      Two distinct operations never share it: each checkout mints its own
//      millisecond timestamp, and a server-stamped time (NULL / out-of-range
//      p_created_at) is the transaction's now().
//   3. Receipt numbers: unique per shop across all sales.
//   4. Terminal request ledger (what the tills actually sent): one client
//      operation (p_created_at) must travel under one key, and one key must
//      never carry two different operations.
//
// Pure functions so the detection is unit-tested (saleLedger.test.ts) with a
// forced duplicate and with two distinct identical-basket sales.

export interface Violation { check: string; detail: string }

export interface LedgerSale {
  id: string;
  shop_id: string;
  shift_id: string;
  cashier_id: string;
  receipt_no: string;
  created_at: string;
}

export interface LedgerKey {
  key: string;
  rpc: string;
  response: { sale?: { id?: string; shopId?: string } } | null;
}

/** One complete_sale request observed on a terminal (request body). */
export interface ClientSaleCall {
  terminal: string;
  key: string | null;
  createdAt: string | null;
}

/** Postgres and the client spell the same instant differently (+00:00 vs Z, µs vs ms). */
export const instant = (ts: string): string => {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return ts;
  const frac = /\.(\d+)/.exec(ts)?.[1] ?? "";
  // keep sub-millisecond digits when present so µs-distinct server times stay distinct
  return `${new Date(ms).toISOString().slice(0, 19)}.${(frac + "000000").slice(0, 6)}Z`;
};

export function saleLedgerViolations(input: {
  sales: LedgerSale[];
  keys: LedgerKey[];
  clientCalls?: ClientSaleCall[];
}): { violations: Violation[]; notes: string[] } {
  const violations: Violation[] = [];
  const notes: string[] = [];
  const saleIds = new Set(input.sales.map((s) => s.id));

  // 1. key ledger
  const keysBySale = new Map<string, string[]>();
  let inFlight = 0;
  for (const k of input.keys) {
    if (k.rpc !== "complete_sale") continue;
    const id = k.response?.sale?.id;
    if (!id) { inFlight++; continue; }
    keysBySale.set(id, [...(keysBySale.get(id) ?? []), k.key]);
    if (!saleIds.has(id)) violations.push({ check: "committed key without its sale (lost sale)", detail: `key ${k.key} -> sale ${id}` });
  }
  for (const s of input.sales) {
    const ks = keysBySale.get(s.id) ?? [];
    if (ks.length === 0) violations.push({ check: "sale without a committed idempotency key", detail: `${s.id} (${s.receipt_no}, shift ${s.shift_id})` });
    else if (ks.length > 1) violations.push({ check: "sale claimed by several keys", detail: `${s.id}: ${ks.join(",")}` });
  }
  notes.push(`sales=${input.sales.length} complete_sale keys=${[...keysBySale.values()].reduce((n, k) => n + k.length, 0)}${inFlight ? ` (+${inFlight} without response)` : ""}`);

  // 2. one client operation -> one sale
  const byOp = new Map<string, LedgerSale[]>();
  for (const s of input.sales) {
    const op = `${s.cashier_id}|${s.shift_id}|${instant(s.created_at)}`;
    byOp.set(op, [...(byOp.get(op) ?? []), s]);
  }
  for (const [op, group] of byOp) {
    if (group.length > 1) {
      const keys = group.map((s) => (keysBySale.get(s.id) ?? ["<no key>"]).join("+"));
      violations.push({ check: "duplicate sale: one client operation applied more than once", detail: `${op}: ${group.map((s, i) => `${s.id} (${s.receipt_no}, key ${keys[i]})`).join(" / ")}` });
    }
  }

  // 3. receipt numbers unique per shop
  const receipts = new Map<string, string[]>();
  for (const s of input.sales) {
    const k = `${s.shop_id}|${s.receipt_no}`;
    receipts.set(k, [...(receipts.get(k) ?? []), s.id]);
  }
  for (const [k, ids] of receipts) if (ids.length > 1) violations.push({ check: "duplicate receipt number", detail: `${k}: ${ids.join(",")}` });

  // 4. terminal request ledger
  const calls = input.clientCalls ?? [];
  if (calls.length) {
    const keysByOp = new Map<string, Set<string>>();
    const opsByKey = new Map<string, Set<string>>();
    for (const c of calls) {
      if (!c.key || !c.createdAt) continue;
      const op = `${c.terminal}|${instant(c.createdAt)}`;
      keysByOp.set(op, (keysByOp.get(op) ?? new Set()).add(c.key));
      opsByKey.set(c.key, (opsByKey.get(c.key) ?? new Set()).add(instant(c.createdAt)));
    }
    for (const [op, ks] of keysByOp) if (ks.size > 1) violations.push({ check: "client replayed one operation under a new key", detail: `${op}: keys ${[...ks].join(",")}` });
    for (const [k, ops] of opsByKey) if (ops.size > 1) violations.push({ check: "one key sent for different operations", detail: `${k}: ${[...ops].join(",")}` });
    notes.push(`terminal ledger: ${calls.length} complete_sale request(s), ${keysByOp.size} client operation(s), ${opsByKey.size} key(s)`);
  }
  return { violations, notes };
}
