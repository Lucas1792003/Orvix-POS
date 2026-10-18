/* eslint-disable @typescript-eslint/no-explicit-any */
// 086 PoC harness helpers. DISPOSABLE loopback stack only (container
// phf-iso-db). Never imported by the app.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { runSql } from "../../e2e/helpers/db";

export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const jlit = (v: unknown) => `${lit(JSON.stringify(v))}::jsonb`;
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const rand = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

/** RFC 9562 UUIDv7 with a chosen millisecond time (client side). */
export function v7(ms = Date.now(), versionNibble = 7): string {
  const b = randomBytes(16);
  const t = BigInt(ms);
  for (let i = 0; i < 6; i++) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | (versionNibble << 4);
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function sql1(q: string): string {
  return runSql(q).trim();
}

/** As `apply-migrations.sh --from 086 --to 086` runs it: one transaction,
 *  the migration and its ledger row (the disposable stack's ledger has only
 *  `version`). Fails if 086 is already recorded, as the runner refuses. */
export function apply086(sql: string): string {
  return runSql(`BEGIN;\n${sql}\nINSERT INTO supabase_migrations.schema_migrations (version) VALUES ('086');\nCOMMIT;`);
}

/** The db part applied 086 directly; the runner would have recorded it. */
export function apply086Recorded(): void {
  runSql("INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('086') ON CONFLICT DO NOTHING");
}

/** As `apply-migrations.sh --rollback 086 --owner-confirmed-till-queues-empty`
 *  runs the reviewed rollback: one transaction, the owner gate set first.
 *  The rollback removes the 086 ledger row itself (it must be recorded). */
export function rollback086(sql: string): string {
  return runSql(`BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '120s';\nSELECT set_config('orvix.runner_txid', txid_current()::text, true);\nSELECT set_config('orvix.rollback_gate', 'till-queues-empty-confirmed-by-owner', true);\n${sql}\nCOMMIT;`);
}

/** A long-lived psql session (needed for open transactions, held locks,
 *  session settings and backend pids). Errors are returned, not thrown. */
export class Psql {
  private p;
  private out = "";
  private err = "";
  private n = 0;
  dead = false;
  constructor() {
    this.p = spawn("docker", ["exec", "-i", "phf-iso-db", "psql", "-X", "-U", "supabase_admin", "-d", "postgres",
      "-At", "-q", "-v", "ON_ERROR_STOP=0", "-v", "VERBOSITY=verbose"], { stdio: ["pipe", "pipe", "pipe"] });
    this.p.stdout.on("data", (d) => { this.out += d; });
    this.p.stderr.on("data", (d) => { this.err += d; });
    this.p.on("exit", () => { this.dead = true; });
    this.p.stdin.on("error", () => { this.dead = true; });
  }
  q(sql: string, timeoutMs = 60_000): Promise<{ out: string; err: string }> {
    const m = `__M${++this.n}x${process.pid}__`;
    try { this.p.stdin.write(`${sql}\n\\echo ${m}\n\\warn ${m}\n`); } catch { this.dead = true; }
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const io = this.out.indexOf(m);
        const ie = this.err.indexOf(m);
        if (io >= 0 && ie >= 0) {
          const r = { out: this.out.slice(0, io).trim(), err: this.err.slice(0, ie).trim() };
          this.out = this.out.slice(io + m.length + 1);
          this.err = this.err.slice(ie + m.length + 1);
          resolve(r);
          return;
        }
        if (this.dead) { resolve({ out: this.out.trim(), err: `${this.err.trim()}\n<session died>` }); return; }
        if (Date.now() - t0 > timeoutMs) { reject(new Error(`psql timeout: ${sql.slice(0, 120)}`)); return; }
        setTimeout(tick, 5);
      };
      tick();
    });
  }
  async as(authId: string): Promise<this> {
    await this.q(`SET ROLE authenticated;\nSELECT set_config('request.jwt.claims', '{"sub":"${authId}","role":"authenticated"}', false) \\g /dev/null`);
    return this;
  }
  async pid(): Promise<number> { return Number((await this.q("SELECT pg_backend_pid();")).out); }
  close() { try { this.p.stdin.end(); } catch { /* gone */ } }
}

/** Parse a psql result into { data } or { error: { code, message } }. */
export function parsed(r: { out: string; err: string }): { data?: any; error?: { code: string; message: string } } {
  const m = /ERROR:\s+([0-9A-Z]{5}):\s*([^\n]*)/.exec(r.err) ?? /FATAL:\s+([0-9A-Z]{5}):\s*([^\n]*)/.exec(r.err);
  if (m) return { error: { code: m[1], message: m[2] } };
  if (/<session died>|server closed the connection|terminating connection/.test(r.err)) return { error: { code: "CONN", message: r.err.split("\n").slice(-3).join(" ") } };
  const line = r.out.split("\n").filter(Boolean).pop() ?? "";
  try { return { data: JSON.parse(line) }; } catch { return { data: line }; }
}

/** op_execute as the session's own user (the operation's creator). */
export const execSql = (key: string, rpc: string, args: unknown) =>
  `SELECT public.op_execute(${lit(key)}::uuid, ${lit(rpc)}, ${jlit(args)}, (SELECT u.id FROM public.users u WHERE u.auth_id = auth.uid()));`;
export const statusSql = (key: string, rpc: string, fence = false, actor: string | null = null, args: unknown = null) =>
  `SELECT public.op_status(${lit(key)}::uuid, ${lit(rpc)}, ${fence}, ${actor === null ? "NULL" : lit(actor)}, ${args === null ? "NULL" : jlit(args)});`;

/** Content snapshot of everything an organization's operations can touch:
 *  per table, row count + md5 of all rows (any insert/update/delete shows). */
export function snapshot(org: string): Record<string, string> {
  const o = lit(org);
  const S = `(SELECT id FROM shops WHERE org_id=${o})`;
  const parts: [string, string][] = [
    ["sales", `sales t WHERE shop_id IN ${S}`],
    ["sale_items", `sale_items t WHERE sale_id IN (SELECT id FROM sales WHERE shop_id IN ${S})`],
    ["inventory", `inventory t WHERE shop_id IN ${S}`],
    ["inventory_movements", `inventory_movements t WHERE shop_id IN ${S}`],
    ["shifts", `shifts t WHERE shop_id IN ${S}`],
    ["supplier_payments", `supplier_payments t WHERE shop_id IN ${S}`],
    ["purchase_orders", `purchase_orders t WHERE shop_id IN ${S}`],
    ["purchase_order_items", `purchase_order_items t WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE shop_id IN ${S})`],
    ["stock_transfers", `stock_transfers t WHERE from_shop_id IN ${S}`],
    ["stock_transfer_items", `stock_transfer_items t WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE from_shop_id IN ${S})`],
    ["refund_void_requests", `refund_void_requests t WHERE shop_id IN ${S}`],
    ["audit_logs", `audit_logs t WHERE shop_id IN ${S} OR actor_id IN (SELECT id FROM users WHERE org_id=${o})`],
    ["reprint_logs", `reprint_logs t WHERE sale_id IN (SELECT id FROM sales WHERE shop_id IN ${S})`],
    ["suppliers", `suppliers t WHERE org_id=${o}`],
    ["supplier_products", `supplier_products t WHERE supplier_id IN (SELECT id FROM suppliers WHERE org_id=${o})`],
    ["products", `products t WHERE org_id=${o}`],
    ["product_units", `product_units t WHERE product_id IN (SELECT id FROM products WHERE org_id=${o})`],
    ["users", `users t WHERE org_id=${o}`],
    ["shops", `shops t WHERE org_id=${o}`],
    ["price_levels", `price_levels t WHERE org_id=${o}`],
    ["price_tiers", `price_tiers t WHERE shop_id IN ${S}`],
    ["product_unit_prices", `product_unit_prices t WHERE shop_id IN ${S}`],
    ["product_barcodes", `product_barcodes t WHERE org_id=${o}`],
  ];
  const q = parts.map(([n, f]) => `SELECT ${lit(n)} || '=' || count(*) || ':' || md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM ${f}`).join("\nUNION ALL\n");
  const out = runSql(`${q};`).trim().split("\n");
  return Object.fromEntries(out.map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
}

export function snapDiff(a: Record<string, string>, b: Record<string, string>): string[] {
  return Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k].split(":")[0]}→${b[k]?.split(":")[0]}`);
}

// The ledger is per organisation (org_id, key). Without `org` these expect at
// most ONE row for the key (a second organisation's row makes them throw —
// tests that use a key in two organisations pass the organisation).
const orgFilter = (org?: string) => (org ? ` AND org_id = ${lit(org)}` : "");
export const ledgerRow = (key: string, org?: string): any => {
  const out = sql1(`SELECT row_to_json(k) FROM public.idempotency_keys k WHERE key = ${lit(key)}::uuid${orgFilter(org)};`);
  return out ? JSON.parse(out) : null;
};
export const ledgerRowText = (key: string, org?: string): string =>
  sql1(`SELECT coalesce((SELECT k::text FROM public.idempotency_keys k WHERE key = ${lit(key)}::uuid${orgFilter(org)}), '<none>');`);

/** Schema fingerprint of what 086 touches (public functions, the ledger
 *  table, public triggers, schemas). Equal before install and after rollback
 *  proves the rollback restores the 085 shape. */
export function fingerprint(): { md5: string; lines: number } {
  const out = sql1(`
    WITH z(x) AS (
      SELECT 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
             || ' ' || p.prosecdef || ' ' || p.provolatile::text || ' ' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      UNION ALL SELECT 'col ' || attname || ' ' || format_type(atttypid, atttypmod) || ' ' || attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'public.idempotency_keys'::regclass AND attnum > 0 AND NOT attisdropped
      UNION ALL SELECT 'con ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.idempotency_keys'::regclass
      UNION ALL SELECT 'trg ' || tgrelid::regclass || ' ' || tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
      UNION ALL SELECT 'acl ' || coalesce(relacl::text, '') || ' rls ' || relrowsecurity FROM pg_class WHERE oid = 'public.idempotency_keys'::regclass
      UNION ALL SELECT 'pol ' || polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), '') FROM pg_policy WHERE polrelid = 'public.idempotency_keys'::regclass
      UNION ALL SELECT 'ns ' || nspname FROM pg_namespace WHERE nspname !~ '^pg_(toast_)?temp_'
    ) SELECT md5(string_agg(x, E'\\n' ORDER BY x)) || ' ' || count(*) FROM z;`);
  const [md5, n] = out.split(" ");
  return { md5, lines: Number(n) };
}

/** kill -9 one backend: the postmaster treats it as a crash, terminates
 *  every backend and runs crash recovery. Waits until SQL works again. */
export async function crashBackend(pid: number): Promise<{ recoveredMs: number; log: string }> {
  const t0 = Date.now();
  execFileSync("docker", ["exec", "phf-iso-db", "kill", "-9", String(pid)]);
  await delay(500);
  for (;;) {
    try { if (sql1("SELECT 'up'") === "up") break; } catch { /* recovering */ }
    if (Date.now() - t0 > 90_000) throw new Error("database did not come back after the crash");
    await delay(300);
  }
  const lr = spawnSync("docker", ["logs", "--since", "2m", "phf-iso-db"], { encoding: "utf8" });
  const log = `${lr.stdout}\n${lr.stderr}`
    .split("\n").filter((l) => /terminated by signal 9|crash|recovery|redo|ready to accept/i.test(l)).slice(-8).join("\n");
  return { recoveredMs: Date.now() - t0, log };
}
