/* eslint-disable @typescript-eslint/no-explicit-any */
// DB-side readers for evidence: service-role REST (bypasses RLS) and SQL
// over ssh for schemas PostgREST does not expose (auth.*). Nothing here is
// ever imported by the app.
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makeClient, runSql as liveRunSql, runSqlFile as liveRunSqlFile, signedInClient } from "../../src/live/liveHelpers";
import { liveCfg } from "./env";

let svcClient: SupabaseClient | null = null;

export function svc(): SupabaseClient {
  if (!svcClient) svcClient = makeClient(liveCfg(), liveCfg().serviceKey);
  return svcClient;
}

export function anonClient(): SupabaseClient {
  return makeClient(liveCfg(), liveCfg().anonKey);
}

export async function userClient(email: string, password: string): Promise<SupabaseClient> {
  return signedInClient(liveCfg(), email, password);
}

export function runSql(sql: string, vars: Record<string, string> = {}): string {
  return liveRunSql(liveCfg(), sql, vars);
}

export function runSqlFile(file: string, vars: Record<string, string> = {}): string {
  return liveRunSqlFile(liveCfg(), file, vars);
}

// `.match()` cannot express IS NULL; split null-valued keys into `.is()`.
function applyMatch(q: any, match: Record<string, unknown>): any {
  const eq: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(match)) {
    if (v === null) q = q.is(k, null);
    else eq[k] = v;
  }
  return Object.keys(eq).length ? q.match(eq) : q;
}

export async function count(table: string, match: Record<string, unknown>, extra?: (q: any) => any): Promise<number> {
  let q = applyMatch(svc().from(table).select("*", { count: "exact", head: true }), match);
  if (extra) q = extra(q);
  const { count: n, error } = await q;
  if (error) throw new Error(`count ${table} failed: ${error.message}`);
  return n ?? 0;
}

export async function row(table: string, match: Record<string, unknown>): Promise<any> {
  const { data, error } = await applyMatch(svc().from(table).select("*"), match).maybeSingle();
  if (error) throw new Error(`row ${table} failed: ${error.message}`);
  return data;
}

export async function rows(table: string, match: Record<string, unknown>, extra?: (q: any) => any): Promise<any[]> {
  let q = applyMatch(svc().from(table).select("*"), match);
  if (extra) q = extra(q);
  const { data, error } = await q;
  if (error) throw new Error(`rows ${table} failed: ${error.message}`);
  return data ?? [];
}

export async function inv(shopId: string, productId: string): Promise<number> {
  const r = await row("inventory", { shop_id: shopId, product_id: productId });
  if (!r) throw new Error(`no inventory row for ${shopId}/${productId}`);
  return r.qty_base_units as number;
}

/** Newest sale of a cashier in a shop (service role). */
export async function latestSale(shopId: string, cashierId: string): Promise<any> {
  const { data, error } = await svc().from("sales").select("*").eq("shop_id", shopId).eq("cashier_id", cashierId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`latestSale failed: ${error.message}`);
  return data;
}

export async function keyRows(keys: string[]): Promise<any[]> {
  if (keys.length === 0) return [];
  const { data, error } = await svc().from("idempotency_keys").select("key, rpc, actor_id, created_at").in("key", keys);
  if (error) throw new Error(`idempotency_keys read failed: ${error.message}`);
  return data ?? [];
}

/** auth.sessions rows for an auth user (aal + factor), via SQL. */
export function authSessions(authId: string): { id: string; aal: string | null; factorId: string | null }[] {
  const out = runSql(`SELECT id, coalesce(aal::text,''), coalesce(factor_id::text,'') FROM auth.sessions WHERE user_id = '${authId}';`).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [id, aal, factorId] = line.split("|");
    return { id, aal: aal || null, factorId: factorId || null };
  });
}

export function deleteAuthSessions(authId: string): number {
  return Number(runSql(`WITH d AS (DELETE FROM auth.sessions WHERE user_id = '${authId}' RETURNING 1) SELECT count(*) FROM d;`).trim());
}

export function setUserActive(userId: string, isActive: boolean): string {
  return runSql(`UPDATE users SET is_active = ${isActive ? "true" : "false"} WHERE id = '${userId}' RETURNING id || ':' || is_active;`).trim();
}

/** Expected cash of a shift, computed on the server's own data with the
 *  close_shift RPC formula (migration 055): opening + CASH sales (not VOID)
 *  - approved PARTIAL refunds against this shift's CASH sales. */
export async function serverExpectedCash(shiftId: string): Promise<number> {
  const shift = await row("shifts", { id: shiftId });
  if (!shift) throw new Error(`no shift ${shiftId}`);
  const sales = await rows("sales", { shift_id: shiftId, payment_method: "CASH" }, (q) => q.neq("status", "VOID"));
  const cash = sales.reduce((n: number, s: any) => n + Number(s.total_mmk), 0);
  const saleIds = sales.map((s: any) => s.id);
  const refunds = saleIds.length
    ? await rows("refund_void_requests", { type: "PARTIAL", status: "APPROVED" }, (q) => q.in("sale_id", saleIds))
    : [];
  const refunded = refunds.reduce((n: number, r: any) =>
    n + (Array.isArray(r.items) ? r.items : []).reduce((m: number, i: any) => m + Number(i.amountMmk ?? i.amount_mmk ?? 0), 0), 0);
  return Number(shift.opening_cash_mmk) + cash - refunded;
}

/** Spec precondition: none of `cashierIds` has an open shift. Every open
 *  shift they hold (left by an earlier spec, or a failed run) is closed
 *  through the real close_shift RPC by `closer` (the QA shop manager —
 *  shift:manage_all), counted at the server-computed expected cash. Must
 *  run BEFORE a terminal signs in as one of these cashiers, so the till's
 *  first full load already sees no open shift. Returns one line per shift. */
export async function closeOpenShifts(cashierIds: string[], closer: { email: string; password: string }, tag: string): Promise<string[]> {
  const open = await rows("shifts", { ended_at: null }, (q) => q.in("cashier_id", cashierIds));
  if (open.length === 0) return [];
  const client = await userClient(closer.email, closer.password);
  const out: string[] = [];
  try {
    for (const s of open) {
      const expected = await serverExpectedCash(s.id);
      const { data, error } = await client.rpc("close_shift", {
        p_shift_id: s.id, p_closing_cash_mmk: expected,
        p_variance_reason: `e2e ${tag}: close shift left open by an earlier spec`,
        p_created_at: null, p_expected_actor_id: null, p_idempotency_key: randomUUID(),
      });
      if (error) throw new Error(`closing leftover shift ${s.id} of ${s.cashier_id} failed: ${error.message}`);
      const variance = (data as any)?.shift?.varianceMmk ?? (data as any)?.varianceMmk;
      out.push(`${s.cashier_id}: ${s.id} closed at ${expected}${variance ? ` (variance ${variance})` : ""}`);
    }
  } finally {
    await client.auth.signOut().catch(() => undefined);
  }
  const still = await count("shifts", { ended_at: null }, (q) => q.in("cashier_id", cashierIds));
  if (still !== 0) throw new Error(`${still} shift(s) still open for ${cashierIds.join(",")} after the precondition close`);
  return out;
}

/** Spec precondition: at least `min` units of a product on hand in a shop.
 *  Tops up through the real adjust_stock RPC as `manager` (a real ADJUSTMENT
 *  movement, so inventory = initial + movements still holds). Returns the
 *  delta applied (0 when already enough). */
export async function ensureStockAtLeast(
  shopId: string, productId: string, min: number, manager: { id: string; email: string; password: string }, reason: string,
): Promise<number> {
  const current = await inv(shopId, productId);
  if (current >= min) return 0;
  const client = await userClient(manager.email, manager.password);
  try {
    const { error } = await client.rpc("adjust_stock", {
      p_shop_id: shopId, p_product_id: productId, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: min - current,
      p_reason: reason, p_product_unit_id: null, p_unit_qty: null, p_created_at: null,
      p_expected_actor_id: manager.id, p_idempotency_key: randomUUID(),
    });
    if (error) throw new Error(`adjust_stock top-up of ${productId} failed: ${error.message}`);
  } finally {
    await client.auth.signOut().catch(() => undefined);
  }
  const after = await inv(shopId, productId);
  if (after !== min) throw new Error(`stock top-up of ${productId}: expected ${min}, found ${after}`);
  return min - current;
}

/** Spec precondition: QA Product One's seeded barcode (seed_extra.sql) is
 *  present, exactly as seeded. Spec D saves QA Product One through the
 *  product form, which rewrites the product's barcodes from what the form
 *  shows — and the form only shows a default-unit barcode stored with
 *  product_unit_id NULL, so the seeded row (bound to the default unit's id)
 *  is dropped by that save. Every spec that scans the barcode re-establishes
 *  it (service role, before its till loads) instead of relying on D not
 *  having run yet. Returns "present" or "restored". */
export async function ensureQaBarcode(st: { ts: string; barcodeValue: string; ids: { org: string; prod1: string; unit1: string; barcode1: string } }): Promise<string> {
  const existing = await rows("product_barcodes", { value: st.barcodeValue });
  if (existing.some((b: any) => b.product_id === st.ids.prod1)) return "present";
  if (existing.length) throw new Error(`barcode ${st.barcodeValue} is owned by another product: ${existing.map((b: any) => b.product_id).join(",")}`);
  const { error } = await svc().from("product_barcodes").insert({
    id: st.ids.barcode1, product_id: st.ids.prod1, product_unit_id: st.ids.unit1,
    value: st.barcodeValue, type: "CODE128", org_id: st.ids.org,
  });
  if (error) throw new Error(`restoring the QA barcode failed: ${error.message}`);
  if (!(await row("product_barcodes", { id: st.ids.barcode1 }))) throw new Error("QA barcode not present after restore");
  return "restored";
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

export { createClient };
