// Hermetic harness for the Deno edge functions in supabase/functions/.
//
// It executes the REAL function code (index.ts, unchanged) by capturing the
// handler passed to `Deno.serve`, then drives it with synthetic `Request`s
// while `globalThis.fetch` is replaced by an in-process router:
//   * https://api.resend.com/emails         -> MockResend (records, returns 200/429/500)
//   * <SUPABASE_URL>/rest/v1/<table>?...     -> MockPostgrest (in-memory tables; parses the
//                                               exact filters supabase-js emits)
//   * <SUPABASE_URL>/auth/v1/user            -> MockAuth (bearer -> user, or 401)
//   * <SUPABASE_URL>/rest/v1/rpc/<fn>        -> MockPostgrest.rpcs[fn] when registered
//                                               (otherwise an error, as before)
//   * <SUPABASE_URL>/storage/v1/object/...   -> MockStorage (HEAD object, POST upload/sign)
// Anything else throws. The tests are run WITHOUT --allow-net, so a request
// that escaped the mock would be denied by Deno as well. No database, no
// email provider, no server is involved.
import { assert } from "jsr:@std/assert@1";

export const SUPABASE_URL = "http://api-gw:8000"; // same shape as the self-hosted internal URL
export const SERVICE_ROLE_KEY = "test-service-role-key.not-a-real-jwt";
export const RESEND_API_KEY = "re_test_000000000000000000000000";
export const REPORT_EMAIL_FROM = "Shwe PhaLar <reports@example.test>";

// ---------------------------------------------------------------- env
export const setEnv = (overrides: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    RESEND_API_KEY,
    REPORT_EMAIL_FROM,
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
};

// ---------------------------------------------------------------- Deno.serve capture
type Handler = (req: Request) => Response | Promise<Response>;
const handlers = new Map<string, Handler>();
let pendingCapture: ((h: Handler) => void) | null = null;

const serveStub = (...args: unknown[]) => {
  const h = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
  if (!pendingCapture) throw new Error("Deno.serve called outside loadHandler()");
  pendingCapture(h);
  return {
    finished: new Promise<void>(() => {}),
    addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
    ref() {},
    unref() {},
    shutdown: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
};
Object.defineProperty(Deno, "serve", { value: serveStub, configurable: true, writable: true });

/** Import a function's index.ts once and return the handler it registered. */
export const loadHandler = async (name: string): Promise<Handler> => {
  const cached = handlers.get(name);
  if (cached) return cached;
  let captured: Handler | null = null;
  pendingCapture = (h) => (captured = h);
  try {
    await import(new URL(`../../functions/${name}/index.ts`, import.meta.url).href);
  } finally {
    pendingCapture = null;
  }
  if (!captured) throw new Error(`${name}/index.ts did not call Deno.serve`);
  handlers.set(name, captured);
  return captured;
};

// ---------------------------------------------------------------- call log
export interface LoggedCall {
  seq: number;
  kind: "resend" | "postgrest" | "auth" | "storage";
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
}

// ---------------------------------------------------------------- Resend mock
export class MockResend {
  mode: 200 | 429 | 500 | 422 = 200;
  calls: LoggedCall[] = [];
  nextId = 1;
  handle(call: LoggedCall): Response {
    if (call.headers["authorization"] !== `Bearer ${RESEND_API_KEY}`) {
      call.status = 401;
      return json({ statusCode: 401, name: "missing_api_key", message: "API key is invalid" }, 401);
    }
    this.calls.push(call);
    switch (this.mode) {
      case 200:
        call.status = 200;
        return json({ id: `mock-email-${this.nextId++}` }, 200);
      case 429:
        call.status = 429;
        return json({ statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests. You can only make 2 requests per second." }, 429);
      case 422:
        call.status = 422;
        return json({ statusCode: 422, name: "validation_error", message: "The from address is not verified" }, 422);
      default:
        call.status = 500;
        return json({ statusCode: 500, name: "internal_server_error", message: "Simulated Resend outage" }, 500);
    }
  }
}

// ---------------------------------------------------------------- Auth mock (GET /auth/v1/user)
export interface MockAuthUser { id: string; email: string | null }
export class MockAuth {
  users = new Map<string, MockAuthUser>(); // bearer token -> user
  calls: LoggedCall[] = [];
  handle(call: LoggedCall): Response {
    this.calls.push(call);
    const token = (call.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    const u = this.users.get(token);
    if (!u) {
      call.status = 401;
      return json({ code: 401, msg: "invalid JWT: unable to parse or verify signature", error_code: "bad_jwt" }, 401);
    }
    call.status = 200;
    return json({
      id: u.id,
      aud: "authenticated",
      role: "authenticated",
      email: u.email,
      app_metadata: { provider: "email" },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      identities: [],
    }, 200);
  }
}

// ---------------------------------------------------------------- PostgREST mock
type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

const parseInList = (raw: string): string[] => {
  // in.(a,b,"c,d")
  const inner = raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")"));
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of inner) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.length || inner.endsWith(",")) out.push(cur);
  return out.map(unquote);
};

const cmp = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
};

const makePred = (col: string, expr: string): Pred => {
  const negate = expr.startsWith("not.");
  const body = negate ? expr.slice(4) : expr;
  const dot = body.indexOf(".");
  const op = body.slice(0, dot);
  const val = body.slice(dot + 1);
  let p: Pred;
  switch (op) {
    case "eq": p = (r) => String(r[col]) === val; break;
    case "neq": p = (r) => String(r[col]) !== val; break;
    case "gt": p = (r) => cmp(r[col], coerce(r[col], val)) > 0; break;
    case "gte": p = (r) => cmp(r[col], coerce(r[col], val)) >= 0; break;
    case "lt": p = (r) => cmp(r[col], coerce(r[col], val)) < 0; break;
    case "lte": p = (r) => cmp(r[col], coerce(r[col], val)) <= 0; break;
    case "is": p = (r) => (val === "null" ? r[col] === null || r[col] === undefined : String(r[col]) === val); break;
    case "in": { const set = new Set(parseInList(val)); p = (r) => set.has(String(r[col])); break; }
    case "ilike": {
      const re = new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/\*/g, ".*") + "$", "i");
      p = (r) => typeof r[col] === "string" && re.test(r[col] as string);
      break;
    }
    default: throw new Error(`MockPostgrest: unsupported operator '${op}' in ${col}=${expr}`);
  }
  return negate ? (r) => !p(r) : p;
};
const coerce = (sample: unknown, v: string): unknown => (typeof sample === "number" ? Number(v) : v);

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

export class MockPostgrest {
  tables: Record<string, Row[]> = {};
  calls: LoggedCall[] = [];
  /** Registered RPC handlers (fn name -> JSON body -> [status, body]). Unregistered RPCs throw. */
  rpcs: Record<string, (args: Record<string, unknown>) => [number, unknown]> = {};
  /** Force an error for a method+table, e.g. failDelete("audit_logs"). */
  failures: { method: string; table: string; status: number; message: string }[] = [];
  idCounter = 1;

  seed(tables: Record<string, Row[]>) {
    for (const [t, rows] of Object.entries(tables)) this.tables[t] = rows.map((r) => ({ ...r }));
  }

  async handle(call: LoggedCall, req: Request): Promise<Response> {
    this.calls.push(call);
    const url = new URL(call.url);
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    assert(call.headers["apikey"] === SERVICE_ROLE_KEY, `PostgREST call without the service-role apikey header (${table})`);
    assert(call.headers["authorization"] === `Bearer ${SERVICE_ROLE_KEY}`, `PostgREST call without the service-role bearer (${table})`);
    if (table.startsWith("rpc/")) {
      const fn = this.rpcs[table.slice(4)];
      if (!fn) throw new Error(`MockPostgrest: rpc not expected: ${table}`);
      const [status, body] = fn((call.body ?? {}) as Record<string, unknown>);
      call.status = status;
      return json(body, status);
    }
    const rows = this.tables[table];
    if (!rows) {
      call.status = 404;
      return json({ code: "42P01", message: `relation "public.${table}" does not exist`, details: null, hint: null }, 404);
    }
    const forced = this.failures.find((f) => f.method === call.method && f.table === table);
    if (forced) {
      call.status = forced.status;
      return json({ code: "XX000", message: forced.message, details: null, hint: null }, forced.status);
    }

    const preds: Pred[] = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (RESERVED.has(k)) continue;
      preds.push(makePred(k, v));
    }
    const matches = (r: Row) => preds.every((p) => p(r));
    const prefer = call.headers["prefer"] ?? "";
    const accept = call.headers["accept"] ?? "";
    const wantObject = accept.includes("vnd.pgrst.object");
    const selectCols = (url.searchParams.get("select") ?? "*").split(",").map((s) => s.trim());
    const project = (r: Row) => (selectCols[0] === "*" ? { ...r } : Object.fromEntries(selectCols.map((c) => [c, r[c] ?? null])));
    const shape = (list: Row[]): Response => {
      if (wantObject) {
        if (list.length !== 1) {
          call.status = 406;
          return json({ code: "PGRST116", details: `The result contains ${list.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" }, 406);
        }
        call.status = 200;
        return json(list[0], 200);
      }
      call.status = 200;
      return json(list, 200);
    };

    switch (call.method) {
      case "HEAD":
      case "GET": {
        let result = rows.filter(matches);
        const order = url.searchParams.get("order");
        if (order) {
          const [col, dir] = order.split(".");
          result = [...result].sort((a, b) => (dir === "desc" ? -1 : 1) * cmp(a[col], b[col]));
        }
        const total = result.length;
        const limit = url.searchParams.get("limit");
        if (limit) result = result.slice(0, Number(limit));
        const headers: Record<string, string> = {};
        if (prefer.includes("count=exact")) headers["Content-Range"] = `0-${Math.max(0, result.length - 1)}/${total}`;
        else headers["Content-Range"] = `0-${Math.max(0, result.length - 1)}/*`;
        if (call.method === "HEAD") {
          call.status = 200;
          return new Response(null, { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
        }
        const res = shape(result.map(project));
        for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
        return res;
      }
      case "POST": {
        const body = call.body as Row | Row[];
        const list = Array.isArray(body) ? body : [body];
        const inserted = list.map((r) => ({ id: `gen-${this.idCounter++}`, created_at: new Date().toISOString(), ...r }));
        rows.push(...inserted);
        if (prefer.includes("return=representation")) return shape(inserted.map(project));
        call.status = 201;
        return new Response(null, { status: 201 });
      }
      case "PATCH": {
        const patch = call.body as Row;
        const touched: Row[] = [];
        for (const r of rows) if (matches(r)) { Object.assign(r, patch); touched.push(r); }
        if (prefer.includes("return=representation")) return shape(touched.map(project));
        call.status = 204;
        return new Response(null, { status: 204 });
      }
      case "DELETE": {
        const keep = rows.filter((r) => !matches(r));
        const removed = rows.filter(matches);
        this.tables[table] = keep;
        if (prefer.includes("return=representation")) return shape(removed.map(project));
        call.status = 204;
        return new Response(null, { status: 204 });
      }
      default:
        throw new Error(`MockPostgrest: unsupported method ${call.method} (${req.url})`);
    }
  }
}

// ---------------------------------------------------------------- Storage mock
/** storage-api v1.74 shapes for the two object routes the functions use:
 *  HEAD /storage/v1/object/<bucket>/<path>          -> 200 | 400 (not found)
 *  POST /storage/v1/object/upload/sign/<bucket>/<path> -> { url: "/object/upload/sign/<bucket>/<path>?token=<jwt>" }
 *  Every call must carry the service-role key. Signed tokens are fake JWTs
 *  whose payload records the path, so tests can check what was signed. */
export class MockStorage {
  objects = new Set<string>(); // "<bucket>/<path>"
  calls: LoggedCall[] = [];
  signed: { bucket: string; path: string; upsert: boolean; token: string }[] = [];
  lifetimeSeconds = 60;
  failSign: number | null = null;
  handle(call: LoggedCall): Response {
    this.calls.push(call);
    assert(call.headers["apikey"] === SERVICE_ROLE_KEY, "storage call without the service-role apikey header");
    assert(call.headers["authorization"] === `Bearer ${SERVICE_ROLE_KEY}`, "storage call without the service-role bearer");
    const rest = decodeURIComponent(call.path.replace(/^\/storage\/v1\/object\//, ""));
    if (call.method === "HEAD") {
      const exists = this.objects.has(rest);
      call.status = exists ? 200 : 400;
      return new Response(null, { status: call.status });
    }
    if (call.method === "POST" && rest.startsWith("upload/sign/")) {
      const full = rest.slice("upload/sign/".length);
      const bucket = full.slice(0, full.indexOf("/"));
      const path = full.slice(full.indexOf("/") + 1);
      if (this.failSign) {
        call.status = this.failSign;
        return json({ statusCode: String(this.failSign), error: "Error", message: "simulated storage failure" }, this.failSign);
      }
      const now = Math.floor(Date.now() / 1000);
      const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
      const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ url: `${bucket}/${path}`, upsert: call.headers["x-upsert"] === "true", iat: now, exp: now + this.lifetimeSeconds })}.mock-signature-${this.signed.length}`;
      this.signed.push({ bucket, path, upsert: call.headers["x-upsert"] === "true", token });
      call.status = 200;
      return json({ url: `/object/upload/sign/${bucket}/${path}?token=${token}` }, 200);
    }
    throw new Error(`MockStorage: unsupported ${call.method} ${call.path}`);
  }
}

// ---------------------------------------------------------------- fetch router
export interface World {
  resend: MockResend;
  db: MockPostgrest;
  auth: MockAuth;
  storage: MockStorage;
  calls: LoggedCall[];
  /** Calls in order, kind + method + table/path only — for ordering assertions. */
  trace(): string[];
  restore(): void;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const headerObj = (h: Headers) => {
  const o: Record<string, string> = {};
  h.forEach((v, k) => (o[k.toLowerCase()] = v));
  return o;
};

/** Install the in-process fetch router. Call `restore()` when done. */
export const makeWorld = (): World => {
  const resend = new MockResend();
  const db = new MockPostgrest();
  const auth = new MockAuth();
  const storage = new MockStorage();
  const calls: LoggedCall[] = [];
  let seq = 0;
  const realFetch = globalThis.fetch;

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(req.url);
    const headers = headerObj(req.headers);
    let body: unknown = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const text = await req.text();
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
    }
    const call: LoggedCall = { seq: seq++, kind: "postgrest", method: req.method, url: req.url, path: url.pathname, headers, body, status: 0 };
    if (url.origin === "https://api.resend.com" && url.pathname === "/emails") {
      call.kind = "resend";
      calls.push(call);
      return resend.handle(call);
    }
    if (req.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      call.kind = "auth";
      calls.push(call);
      return auth.handle(call);
    }
    if (req.url.startsWith(`${SUPABASE_URL}/storage/v1/object/`)) {
      call.kind = "storage";
      calls.push(call);
      return storage.handle(call);
    }
    if (req.url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      calls.push(call);
      return await db.handle(call, req);
    }
    throw new Error(`HERMETIC VIOLATION: unexpected network call ${req.method} ${req.url}`);
  };
  globalThis.fetch = mockFetch as typeof fetch;

  return {
    resend,
    db,
    auth,
    storage,
    calls,
    trace: () =>
      calls.map((c) => {
        if (c.kind === "resend") return `resend:POST`;
        if (c.kind === "auth") return `auth:GET user`;
        if (c.kind === "storage") return `storage:${c.method} ${c.path.replace("/storage/v1/object/", "").startsWith("upload/sign/") ? "sign" : "object"}`;
        return `db:${c.method} ${c.path.replace("/rest/v1/", "")}`;
      }),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
};

// ---------------------------------------------------------------- request helpers
export const post = (bearer: string | null, body: unknown = {}) =>
  new Request("http://functions.local/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });

export const readJson = async (res: Response) => ({ status: res.status, body: await res.json() });

export const fromBase64 = (b64: string) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

/** Minimal CSV parse (handles quoted cells with "" escapes). */
export const parseCsv = (csv: string): string[][] =>
  csv.split("\n").map((line) => {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  });

/** Run `fn` with Date.now() pinned to `iso`. */
export const withClock = async <T>(iso: string, fn: () => Promise<T>): Promise<T> => {
  const fixed = Date.parse(iso);
  const realNow = Date.now;
  Date.now = () => fixed;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
};

export const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });
