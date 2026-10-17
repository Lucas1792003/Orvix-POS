// ----------------------------------------------------------------------
// In-memory PostgREST table for tests (ORV-001 paging): a supabase-js-shaped
// select builder over an array of rows, with the behaviour that matters for
// complete reads:
//
//  - every response is cut to `maxRows` rows WITHOUT any error or flag —
//    exactly like PGRST_DB_MAX_ROWS (1,000 on lucashome);
//  - filters eq / in / gt / gte / lte, and the keyset `or()` shapes the app
//    sends (`a.gt."x",and(a.eq."x",b.gt."y")`), with PostgREST's
//    double-quoted values;
//  - multi-column order, limit;
//  - per-call hooks so a test can fail a request, run code between pages
//    (concurrent writes, live events) or count requests.
//
// Values compare as ISO timestamps when both sides parse as one (so
// "…00Z" and "…00.000Z" are equal), otherwise by code point. Unsupported
// filter syntax throws, so a test can never pass against a filter the
// emulator silently ignored. No vitest imports: type-checks in the app build.
// ----------------------------------------------------------------------

export type FakeRow = Record<string, unknown>;

export interface FakeRequest {
  table: string;
  index: number;
  filters: string[];
}

export interface FakePostgrestOptions {
  /** Rows per table; read at request time, so a test may mutate it between pages. */
  tables: Record<string, FakeRow[]>;
  maxRows?: number;
  /** Called before each request is answered; return an error to fail it,
   *  or "throw" to make the awaited builder reject (a dropped connection). */
  beforeRequest?: (req: FakeRequest) => void | { message: string; code?: string } | "throw" | Promise<void | { message: string; code?: string } | "throw">;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  const x = String(a);
  const y = String(b);
  if (ISO.test(x) && ISO.test(y)) {
    const dx = Date.parse(x);
    const dy = Date.parse(y);
    if (!Number.isNaN(dx) && !Number.isNaN(dy)) return dx === dy ? 0 : dx < dy ? -1 : 1;
  }
  return x === y ? 0 : x < y ? -1 : 1;
}

const unquote = (v: string): string => {
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  return v;
};

const Q = String.raw`("(?:[^"\\]|\\.)*"|[^,()"]*)`;
const KEYSET = new RegExp(String.raw`^(\w+)\.gt\.${Q},and\((\w+)\.eq\.${Q},(\w+)\.gt\.${Q}\)$`);

type Pred = (row: FakeRow) => boolean;

function parseOr(expr: string): Pred {
  const m = KEYSET.exec(expr);
  if (!m || m[1] !== m[3]) throw new Error(`fakePostgrest: unsupported or() filter: ${expr}`);
  const [, k1, v1, , v1b, k2, v2] = m;
  const a = unquote(v1);
  const b = unquote(v1b);
  const c = unquote(v2);
  return (row) => compareValues(row[k1], a) > 0 || (compareValues(row[k1], b) === 0 && compareValues(row[k2], c) > 0);
}

export function createFakePostgrest(options: FakePostgrestOptions) {
  const maxRows = options.maxRows ?? 1000;
  const requests: FakeRequest[] = [];

  const from = (table: string) => {
    const preds: Pred[] = [];
    const filters: string[] = [];
    const orders: { column: string; ascending: boolean }[] = [];
    let limit: number | undefined;
    let columns = "*";
    let single = false;

    const run = async () => {
      const req: FakeRequest = { table, index: requests.length, filters: [...filters] };
      requests.push(req);
      const hook = await options.beforeRequest?.(req);
      if (hook === "throw") throw new TypeError("Failed to fetch");
      if (hook) return { data: null, error: { message: hook.message, code: hook.code ?? "" }, status: 500, statusText: "" };
      const rows = (options.tables[table] ?? []).filter((row) => preds.every((p) => p(row)));
      if (orders.length) {
        rows.sort((r1, r2) => {
          for (const o of orders) {
            const c = compareValues(r1[o.column], r2[o.column]);
            if (c !== 0) return o.ascending ? c : -c;
          }
          return 0;
        });
      }
      const n = Math.min(limit ?? Number.POSITIVE_INFINITY, maxRows);
      const page = rows.slice(0, n).map((row) => {
        if (columns === "*") return { ...row };
        const picked: FakeRow = {};
        for (const col of columns.split(",").map((c) => c.trim())) picked[col] = row[col];
        return picked;
      });
      if (single) return { data: page[0] ?? null, error: null, status: 200, statusText: "OK" };
      return { data: page, error: null, status: 200, statusText: "OK" };
    };

    const builder = {
      select(cols?: string) { columns = cols ?? "*"; return builder; },
      eq(column: string, value: unknown) { filters.push(`${column}=eq.${value}`); preds.push((r) => compareValues(r[column], value) === 0); return builder; },
      in(column: string, values: readonly unknown[]) { filters.push(`${column}=in.(${values.length})`); const set = new Set(values.map(String)); preds.push((r) => set.has(String(r[column]))); return builder; },
      gt(column: string, value: unknown) { filters.push(`${column}=gt.${value}`); preds.push((r) => compareValues(r[column], value) > 0); return builder; },
      gte(column: string, value: unknown) { filters.push(`${column}=gte.${value}`); preds.push((r) => compareValues(r[column], value) >= 0); return builder; },
      lte(column: string, value: unknown) { filters.push(`${column}=lte.${value}`); preds.push((r) => compareValues(r[column], value) <= 0); return builder; },
      or(expr: string) { filters.push(`or=(${expr})`); preds.push(parseOr(expr)); return builder; },
      order(column: string, opts?: { ascending?: boolean }) { orders.push({ column, ascending: opts?.ascending !== false }); return builder; },
      limit(count: number) { limit = count; return builder; },
      maybeSingle() { single = true; return builder; },
      then<T1 = unknown, T2 = never>(
        onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
        onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
      ): Promise<T1 | T2> {
        return run().then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  return {
    from,
    get requests() { return requests; },
    requestsFor: (table: string) => requests.filter((r) => r.table === table),
  };
}

export type FakePostgrest = ReturnType<typeof createFakePostgrest>;
