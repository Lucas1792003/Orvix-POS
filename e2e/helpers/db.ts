/* eslint-disable @typescript-eslint/no-explicit-any */
// DB-side readers for evidence: service-role REST (bypasses RLS) and SQL
// over ssh for schemas PostgREST does not expose (auth.*). Nothing here is
// ever imported by the app.
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
