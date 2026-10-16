// Shared infrastructure for the org-isolation audit suites.
// Talks ONLY to the disposable phf-iso stack on 127.0.0.1 (refuses anything
// else) and never prints a key, token, password or TOTP secret.
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { installHostedBackendGuard } from "../../../src/test/hostedGuard";

installHostedBackendGuard();

export const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
export const URL_BASE = env("PHF_ISO_URL").replace(/\/$/, "");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(URL_BASE)) throw new Error("refusing: PHF_ISO_URL is not a 127.0.0.1 URL");
export const ANON = env("PHF_ISO_ANON_KEY");
export const SERVICE = env("PHF_ISO_SERVICE_KEY");
export const DB = env("PHF_ISO_DB");
if (!DB.startsWith("phf-iso-")) throw new Error("refusing: PHF_ISO_DB is not a phf-iso-* container");
export const MAX_MIG = Number(env("PHF_ISO_MAX_MIG"));
export const OUT = env("PHF_ISO_OUT");

// ------------------------------------------------------------------ results
export type Status = "PASS" | "FAIL" | "GAP" | "SKIP" | "INFO";
export interface Result {
  id: string; area: string; name: string; status: Status; detail?: string;
  covers: string[]; severity?: string; expectedAt?: string;
}
export const results: Result[] = [];
let seq = 0;
export function record(area: string, name: string, status: Status, covers: string[] = [], detail = "", extra: Partial<Result> = {}) {
  const id = `${area}-${String(++seq).padStart(4, "0")}`;
  const r: Result = { id, area, name, status, covers, ...(detail ? { detail: redact(detail).slice(0, 600) } : {}), ...extra };
  results.push(r);
  console.log(`${status} [${id}] ${name}${detail && status !== "PASS" ? " :: " + r.detail : ""}`);
  return r;
}
export const check = (area: string, name: string, ok: boolean, covers: string[] = [], detail = "") =>
  record(area, name, ok ? "PASS" : "FAIL", covers, ok ? "" : detail);
/** A known/expected isolation gap: GAP when present, PASS when closed. */
export const gap = (area: string, name: string, closed: boolean, covers: string[], severity: string, detail = "") =>
  record(area, name, closed ? "PASS" : "GAP", covers, closed ? "" : detail, closed ? {} : { severity });

export function writeResults(extra: Record<string, unknown> = {}) {
  const counts: Record<string, Record<Status, number>> = {};
  for (const r of results) {
    counts[r.area] ??= { PASS: 0, FAIL: 0, GAP: 0, SKIP: 0, INFO: 0 };
    counts[r.area][r.status]++;
  }
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ migration: MAX_MIG, generated: new Date().toISOString(), counts, results, ...extra }, null, 1));
  return counts;
}

// ------------------------------------------------------------------ redaction / leaks
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
export const redact = (s: string) => s.replace(JWT_RE, "<jwt>").replace(ANON, "<anon>").replace(SERVICE, "<service>");

/** Values of org B a caller in another org must never receive (canaries, ids it did not supply). */
export const canaries = new Set<string>();
export interface Captured { ctx: string; text: string; supplied: string[] }
export const captured: Captured[] = [];
/** Remember a refusal/response body for the leak scan (area "errors"). */
export function capture(ctx: string, text: string, supplied: string[] = []) {
  if (text) captured.push({ ctx, text, supplied });
}
export function scanLeaks(): { scanned: number; leaks: { ctx: string; value: string; snippet: string }[] } {
  const leaks: { ctx: string; value: string; snippet: string }[] = [];
  for (const c of captured) {
    const lower = c.text.toLowerCase();
    for (const v of canaries) {
      if (!v || c.supplied.includes(v)) continue;
      const i = lower.indexOf(v.toLowerCase());
      if (i >= 0) leaks.push({ ctx: c.ctx, value: v, snippet: redact(c.text.slice(Math.max(0, i - 60), i + 60)) });
    }
  }
  return { scanned: captured.length, leaks };
}

// ------------------------------------------------------------------ SQL (superuser, disposable DB only)
export function sql(query: string, vars: Record<string, string> = {}): string {
  const args = ["exec", "-i", DB, "psql", "-X", "-q", "-At", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  return execFileSync("docker", args, { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
export const sqlFile = (path: string, vars: Record<string, string>) => sql(readFileSync(path, "utf8"), vars);
export const sqlJson = <T = unknown>(query: string): T => JSON.parse(sql(query) || "null") as T;
export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ------------------------------------------------------------------ HTTP
export interface Res { status: number; headers: Headers; text: string; json: any }
export async function http(method: string, path: string, opts: { token?: string | null; body?: unknown; headers?: Record<string, string>; raw?: BodyInit; apikey?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { apikey: opts.apikey ?? ANON, ...(opts.headers ?? {}) };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? ANON}`;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers["Content-Type"] ??= "application/json"; }
  const r = await fetch(URL_BASE + path, { method, headers, body });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, headers: r.headers, text, json };
}
export const rest = (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  http(method, `/rest/v1/${path}`, { token, body, headers });
export const rpc = (token: string | null, fn: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  http("POST", `/rest/v1/rpc/${fn}`, { token, body: args, headers });
export const fn = (token: string | null, name: string, body: unknown, headers: Record<string, string> = {}) =>
  http("POST", `/functions/v1/${name}`, { token, body, headers });

// ------------------------------------------------------------------ GoTrue
export const randomPassword = () => `Iso${randomBytes(15).toString("base64url")}9!`;
export async function adminCreateUser(email: string, password: string, appMetadata?: Record<string, unknown>): Promise<string> {
  const r = await http("POST", "/auth/v1/admin/users", { token: SERVICE, apikey: SERVICE,
    body: { email, password, email_confirm: true, ...(appMetadata ? { app_metadata: appMetadata } : {}) } });
  if (r.status !== 200 || !r.json?.id) throw new Error(`createUser ${email}: ${r.status} ${redact(r.text).slice(0, 200)}`);
  return r.json.id as string;
}
export interface Session { access_token: string; refresh_token: string; user: { id: string } }
export async function signIn(email: string, password: string): Promise<Session> {
  const r = await http("POST", "/auth/v1/token?grant_type=password", { token: null, body: { email, password } });
  if (r.status !== 200) throw new Error(`signIn ${email}: ${r.status} ${redact(r.text).slice(0, 200)}`);
  return r.json as Session;
}
export function claims(token: string): any {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what authenticator apps compute
function base32(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    val = (val << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secret: string, at = Date.now()): string {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", base32(secret)).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}
/** Enrol + verify a TOTP factor on an aal1 session; returns the factor id and secret (kept in memory only). */
export async function enrollTotp(aal1: string): Promise<{ factorId: string; secret: string }> {
  const e = await http("POST", "/auth/v1/factors", { token: aal1, body: { factor_type: "totp", friendly_name: `iso-${randomUUID().slice(0, 8)}` } });
  if (e.status !== 200) throw new Error(`enroll: ${e.status} ${redact(e.text).slice(0, 200)}`);
  const factorId = e.json.id as string, secret = e.json.totp.secret as string;
  await stepUp(aal1, factorId, secret);
  return { factorId, secret };
}
/** challenge + verify -> an aal2 session. */
export async function stepUp(aal1: string, factorId: string, secret: string): Promise<Session> {
  const c = await http("POST", `/auth/v1/factors/${factorId}/challenge`, { token: aal1, body: {} });
  if (c.status !== 200) throw new Error(`challenge: ${c.status} ${redact(c.text).slice(0, 200)}`);
  const v = await http("POST", `/auth/v1/factors/${factorId}/verify`, { token: aal1, body: { challenge_id: c.json.id, code: totp(secret) } });
  if (v.status !== 200) throw new Error(`verify: ${v.status} ${redact(v.text).slice(0, 200)}`);
  return v.json as Session;
}

export const uuid = () => randomUUID();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
