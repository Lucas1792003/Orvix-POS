// ----------------------------------------------------------------------
// Read-only server check before an owner reconciles an outbox entry
// (1.0.16 RC3): "is this transaction already on the server?".
//
// The idempotency ledger (062 idempotency_keys) is NOT readable by any app
// user: RLS on, no policies, ALL revoked from anon/authenticated. There is no
// RPC that answers "was key K recorded?" without executing the call, and
// replaying complete_sale to ask would WRITE the sale when it is missing. So
// sales are found by their client operation identity, exactly as the e2e
// sale ledger ties a sale to its operation (e2e/helpers/saleLedger.ts):
//   complete_sale stores the client's ring-up time p_created_at verbatim as
//   sales.created_at (045 resolve_event_time, within -48 h/+5 min), and the
//   client mints that time once per operation and replays it unchanged.
// Exact match = same shop, same shift (when the entry's shift id is known),
// same instant, same payment method / paid amount / cart discount, and the
// same lines (product + base quantity). Read through the owner's normal RLS
// access (069: ADMIN reads every sale and sale item of the org's shops).
//
// A replay that reached the server more than 48 h after ring-up is stamped
// with server time, so a second, looser search (same shop/shift, amounts and
// lines, any time since ring-up) reports such sales as CANDIDATES and makes
// the result "inconclusive" — never "not recorded". "Not recorded" therefore
// means: no sale of that shop (and shift) since ring-up has these amounts
// and lines. This is what makes a lost response safe: the sale the server
// committed is found, so the owner can only choose "matched", never
// "cancelled".
//
// Only SELECTs (`from(t).select(...)` with filters). Never an RPC, insert,
// update or delete (asserted by serverCheck.test.ts with a recording client).
// ----------------------------------------------------------------------
import type { SyncOutboxEntry } from "../localDb";
import type { ServerCheck, ServerSaleRef } from "./types";

export interface ServerSaleRow {
  id: string;
  shop_id: string | null;
  shift_id: string | null;
  receipt_no: string | null;
  created_at: string | null;
  paid_mmk: number | null;
  payment_method: string | null;
  cart_discount_pct: number | string | null;
}

export interface ServerSaleItemRow {
  sale_id: string;
  product_id: string | null;
  base_quantity_sold: number | null;
}

export type ReadResult<T> = { data: T; error: null } | { data: null; error: { message: string } };

/** The few reads the check needs. supabaseSaleReader() is the real one. */
export interface SaleReader {
  salesBetween(q: { shopId: string; shiftId: string | null; from: string; to: string; limit: number }): Promise<ReadResult<ServerSaleRow[]>>;
  salesWithAmounts(q: { shopId: string; shiftId: string | null; from: string; paidMmk: number; paymentMethod: string; limit: number }): Promise<ReadResult<ServerSaleRow[]>>;
  saleItems(saleIds: string[]): Promise<ReadResult<ServerSaleItemRow[]>>;
  saleById(id: string): Promise<ReadResult<ServerSaleRow[]>>;
  saleByReceipt(shopId: string, receiptNo: string): Promise<ReadResult<ServerSaleRow[]>>;
}

const SALE_COLUMNS = "id,shop_id,shift_id,receipt_no,created_at,paid_mmk,payment_method,cart_discount_pct";
export const CANDIDATE_LIMIT = 50;
/** The loose search starts this long before the (client-clock) ring-up
 *  time: a till clock running fast is stamped with server time (045). */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** Minimal shape of the supabase-js query builder used here (select only). */
interface SelectBuilder<T> extends PromiseLike<{ data: T | null; error: { message: string } | null }> {
  eq(column: string, value: unknown): SelectBuilder<T>;
  gte(column: string, value: unknown): SelectBuilder<T>;
  lte(column: string, value: unknown): SelectBuilder<T>;
  in(column: string, values: readonly unknown[]): SelectBuilder<T>;
  order(column: string, opts?: { ascending?: boolean }): SelectBuilder<T>;
  limit(n: number): SelectBuilder<T>;
}
export interface SelectOnlyClient {
  from(table: string): { select(columns: string): SelectBuilder<unknown[]> };
}

async function run<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<ReadResult<T>> {
  try {
    const { data, error } = await q;
    if (error) return { data: null, error: { message: error.message } };
    return { data: (data ?? []) as T, error: null };
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

/** SaleReader over a supabase-js client: SELECTs only. */
export function supabaseSaleReader(client: SelectOnlyClient): SaleReader {
  const sales = () => client.from("sales").select(SALE_COLUMNS);
  return {
    salesBetween: ({ shopId, shiftId, from, to, limit }) => {
      let q = sales().eq("shop_id", shopId).gte("created_at", from).lte("created_at", to);
      if (shiftId) q = q.eq("shift_id", shiftId);
      return run(q.order("created_at").limit(limit));
    },
    salesWithAmounts: ({ shopId, shiftId, from, paidMmk, paymentMethod, limit }) => {
      let q = sales().eq("shop_id", shopId).eq("paid_mmk", paidMmk).eq("payment_method", paymentMethod).gte("created_at", from);
      if (shiftId) q = q.eq("shift_id", shiftId);
      return run(q.order("created_at").limit(limit));
    },
    saleItems: (saleIds) => run(client.from("sale_items").select("sale_id,product_id,base_quantity_sold").in("sale_id", saleIds).limit(5000)),
    saleById: (id) => run(sales().eq("id", id).limit(2)),
    saleByReceipt: (shopId, receiptNo) => run(sales().eq("shop_id", shopId).eq("receipt_no", receiptNo).limit(2)),
  };
}

const toRef = (s: ServerSaleRow): ServerSaleRef => ({
  saleId: s.id, receiptNo: s.receipt_no ?? null, shopId: s.shop_id ?? null, shiftId: s.shift_id ?? null, createdAt: s.created_at ?? null,
});

/** Multiset of (product, base quantity) — what a sale's lines amount to. */
export function lineSignature(lines: readonly { productId: string; baseQty: number }[]): string {
  return lines.map((l) => `${l.productId}|${l.baseQty}`).sort().join(";");
}

interface SaleIdentity {
  shopId: string;
  shiftId: string | null;
  ringUpAt: string | null;
  paidMmk: number;
  paymentMethod: string;
  cartDiscountPct: number;
  lines: string;
}

/** The client operation identity of a queued complete_sale, or why there is none. */
export function saleIdentity(
  entry: Pick<SyncOutboxEntry, "kind" | "name" | "args" | "refs">,
  resolveRef: (provisionalId: string) => string | null,
): SaleIdentity | string {
  if (entry.kind !== "rpc" || entry.name !== "complete_sale") return `no read-only server check exists for "${entry.name}"`;
  const a = entry.args ?? {};
  if (typeof a.p_shop_id !== "string" || !a.p_shop_id) return "the queued sale has no shop id";
  if (!Array.isArray(a.p_items) || a.p_items.length === 0) return "the queued sale has no lines";
  if (typeof a.p_paid_mmk !== "number" || typeof a.p_payment_method !== "string") return "the queued sale has no payment";
  const lines: { productId: string; baseQty: number }[] = [];
  for (const it of a.p_items as Record<string, unknown>[]) {
    const qty = Number(it?.qty);
    const per = Number(it?.units_per_item ?? 1);
    if (typeof it?.product_id !== "string" || !Number.isFinite(qty) || !Number.isFinite(per)) return "a queued sale line is malformed";
    lines.push({ productId: it.product_id, baseQty: qty * per });
  }
  let shiftId: string | null = typeof a.p_shift_id === "string" ? a.p_shift_id : null;
  const ref = (entry.refs ?? []).find((r) => r.field === "p_shift_id");
  if (ref) shiftId = resolveRef(ref.provisionalId);
  const ringUp = typeof a.p_created_at === "string" && Number.isFinite(Date.parse(a.p_created_at)) ? a.p_created_at : null;
  return {
    shopId: a.p_shop_id, shiftId, ringUpAt: ringUp, paidMmk: a.p_paid_mmk, paymentMethod: a.p_payment_method,
    cartDiscountPct: Number(a.p_cart_discount_pct ?? 0), lines: lineSignature(lines),
  };
}

const sameInstant = (a: string | null, b: string): boolean => a != null && Date.parse(a) === Date.parse(b);

/**
 * Look the entry up on the server, read-only. Never throws: a failed read
 * is an "inconclusive" result with the reason.
 */
export async function checkServerRecord(
  entry: Pick<SyncOutboxEntry, "kind" | "name" | "args" | "refs" | "createdAt">,
  deps: { reader: SaleReader; resolveRef: (provisionalId: string) => string | null; entryDigest: string; now?: Date },
): Promise<ServerCheck> {
  const checkedAt = (deps.now ?? new Date()).toISOString();
  const base = { checkedAt, entryDigest: deps.entryDigest };
  const id = saleIdentity(entry, deps.resolveRef);
  if (typeof id === "string") {
    return { ...base, result: "inconclusive", method: "unsupported", matches: [], candidates: [], detail: `Cannot check: ${id}. Reconcile it from the export (tools/queue-recovery).` };
  }
  const inconclusive = (detail: string, matches: ServerSaleRef[] = [], candidates: ServerSaleRef[] = []): ServerCheck =>
    ({ ...base, result: "inconclusive", method: "sale-client-identity", matches, candidates, detail });

  const fits = async (rows: ServerSaleRow[]): Promise<ServerSaleRow[] | { error: string }> => {
    const amountOk = rows.filter((s) => s.payment_method === id.paymentMethod && Number(s.paid_mmk) === id.paidMmk
      && Number(s.cart_discount_pct ?? 0) === id.cartDiscountPct && (!id.shiftId || s.shift_id === id.shiftId));
    if (amountOk.length === 0) return [];
    const items = await deps.reader.saleItems(amountOk.map((s) => s.id));
    if (items.error) return { error: items.error.message };
    const bySale = new Map<string, { productId: string; baseQty: number }[]>();
    for (const it of items.data) {
      if (!it.product_id) continue;
      bySale.set(it.sale_id, [...(bySale.get(it.sale_id) ?? []), { productId: it.product_id, baseQty: Number(it.base_quantity_sold ?? 0) }]);
    }
    return amountOk.filter((s) => lineSignature(bySale.get(s.id) ?? []) === id.lines);
  };

  // 1. exact: the ring-up instant (±1 ms window, then exact compare)
  let exact: ServerSaleRow[] = [];
  // Same instant (same shop/shift) but different amounts or lines: never
  // proof of absence — reported as candidates.
  let sameTimeOther: ServerSaleRow[] = [];
  if (id.ringUpAt) {
    const t = Date.parse(id.ringUpAt);
    const r = await deps.reader.salesBetween({
      shopId: id.shopId, shiftId: id.shiftId, from: new Date(t - 1).toISOString(), to: new Date(t + 1).toISOString(), limit: CANDIDATE_LIMIT,
    });
    if (r.error) return inconclusive(`The server could not be read (${r.error.message}). Nothing is known; try again online.`);
    const atInstant = r.data.filter((s) => sameInstant(s.created_at, id.ringUpAt!) && (!id.shiftId || s.shift_id === id.shiftId));
    const f = await fits(atInstant);
    if ("error" in f) return inconclusive(`The server could not be read (${f.error}). Try again online.`);
    exact = f;
    const exactSet = new Set(f.map((s) => s.id));
    sameTimeOther = atInstant.filter((s) => !exactSet.has(s.id));
  }

  // 2. loose: same amounts + lines, any time since ring-up (minus clock skew)
  const since = Math.min(id.ringUpAt ? Date.parse(id.ringUpAt) : Number.POSITIVE_INFINITY, Date.parse(entry.createdAt)) - CLOCK_SKEW_MS;
  const loose = await deps.reader.salesWithAmounts({
    shopId: id.shopId, shiftId: id.shiftId, from: new Date(Number.isFinite(since) ? since : 0).toISOString(),
    paidMmk: id.paidMmk, paymentMethod: id.paymentMethod, limit: CANDIDATE_LIMIT,
  });
  if (loose.error) return inconclusive(`The server could not be read (${loose.error.message}). Try again online.`, exact.map(toRef));
  const lf = await fits(loose.data);
  if ("error" in lf) return inconclusive(`The server could not be read (${lf.error}). Try again online.`, exact.map(toRef));
  const exactIds = new Set(exact.map((s) => s.id));
  const candidateRows = [...sameTimeOther, ...lf.filter((s) => !exactIds.has(s.id) && !sameTimeOther.some((o) => o.id === s.id))];
  const candidates = candidateRows.map(toRef);
  const matches = exact.map(toRef);
  const scope = `shop ${id.shopId}${id.shiftId ? `, shift ${id.shiftId}` : " (shift not known on this till)"}`;

  if (loose.data.length >= CANDIDATE_LIMIT) {
    return inconclusive(`Too many sales with the same amounts in ${scope} to decide (${CANDIDATE_LIMIT}+).`, matches, candidates);
  }
  if (matches.length === 1 && candidates.length === 0) {
    return {
      ...base, result: "recorded", method: "sale-client-identity", matches, candidates,
      detail: `Recorded: sale ${matches[0].saleId}${matches[0].receiptNo ? ` (receipt ${matches[0].receiptNo})` : ""} in ${scope}, same ring-up time, amounts and lines.`,
    };
  }
  if (matches.length > 1) return inconclusive(`${matches.length} sales in ${scope} match exactly. Compare them with the export before deciding.`, matches, candidates);
  if (matches.length === 1) {
    return inconclusive(`Sale ${matches[0].saleId} matches exactly, and ${candidates.length} more sale(s) have the same amounts and lines at another time.`, matches, candidates);
  }
  if (candidates.length > 0) {
    return inconclusive(`No exact match, but ${candidates.length} sale(s) in ${scope} could be it (the same ring-up time with other details, or the same amounts and lines at another time: a late replay is stamped with server time). Compare them with the export.`, matches, candidates);
  }
  if (!id.ringUpAt) return inconclusive(`The queued sale has no ring-up time, so an exact check is impossible; no sale with these amounts and lines was found in ${scope}.`);
  return {
    ...base, result: "not-recorded", method: "sale-client-identity", matches, candidates,
    detail: `Not recorded: no sale in ${scope} since ring-up has these amounts and lines.`,
  };
}

/** For "recreated": the new sale the owner entered through the normal POS
 *  flow must exist on the server, in the entry's shop, rung up after the
 *  entry was queued, and not be one of the sales the check found. */
export async function verifyRecreatedSale(
  reader: SaleReader,
  input: { saleIdOrReceipt: string; shopId: string | null; queuedAt: string; exclude: readonly string[] },
): Promise<{ ok: true; sale: ServerSaleRef } | { ok: false; message: string }> {
  const ref = input.saleIdOrReceipt.trim();
  if (!ref) return { ok: false, message: "Enter the receipt number (or sale id) of the sale you re-entered." };
  let r = await reader.saleById(ref);
  if (!r.error && r.data.length === 0 && input.shopId) r = await reader.saleByReceipt(input.shopId, ref);
  if (r.error) return { ok: false, message: `The server could not be read (${r.error.message}). Try again online.` };
  if (r.data.length !== 1) return { ok: false, message: `No single server sale "${ref}" was found${input.shopId ? " in this entry's shop" : ""}.` };
  const s = r.data[0];
  if (input.shopId && s.shop_id !== input.shopId) return { ok: false, message: "That sale belongs to another shop." };
  if (!s.created_at || Date.parse(s.created_at) < Date.parse(input.queuedAt)) {
    return { ok: false, message: "That sale is older than this entry, so it cannot be its re-entry. Use \"matched\" if it is the same sale." };
  }
  if (input.exclude.includes(s.id)) return { ok: false, message: "That sale is the one the server check found: choose \"matched\" instead." };
  return { ok: true, sale: toRef(s) };
}
