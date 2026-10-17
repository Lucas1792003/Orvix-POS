import { supabase } from "../../lib/supabase";

// ----------------------------------------------------------------------
// Complete, deterministic reads past PostgREST's row cap (ORV-001).
//
// PostgREST returns at most `PGRST_DB_MAX_ROWS` rows (1,000 on lucashome,
// deploy/lucashome/env.settings.md) and says nothing when it truncates, so
// an unpaged `select("*")` silently loses every row past the cap — and the
// full load then persisted that short list over the local mirror.
//
// fetchAllRows() pages with a KEYSET on the table's unique key (never an
// offset): each page asks for rows strictly after the last key seen, in
// key order. That is stable while rows are inserted or deleted between
// pages (an offset would skip or repeat rows), and it does not depend on
// knowing the server's cap: the loop advances by whatever the server
// returned and stops only on an EMPTY page, so a cap lower than PAGE_SIZE
// costs requests, never rows.
//
// All-or-nothing: if any page fails (HTTP/RLS error, a thrown fetch, a key
// that does not advance) the whole read returns an error and NO rows, so a
// caller can never mistake a partial read for the complete table.
// ----------------------------------------------------------------------

export const PAGE_SIZE = 1000;
/** Hard stop against a runaway loop: 10,000 pages = 10 M rows. */
const MAX_PAGES = 10_000;

export type Row = Record<string, unknown>;

export interface ReadOk { data: Row[]; error: null }
export interface ReadFailed { data: null; error: { message: string; code?: string } }
export type ReadResult = ReadOk | ReadFailed;

/** Narrow structural type of a supabase-js filter builder (the parts used here). */
export interface FilterBuilder extends PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> {
  eq(column: string, value: unknown): FilterBuilder;
  in(column: string, values: readonly unknown[]): FilterBuilder;
  gt(column: string, value: unknown): FilterBuilder;
  gte(column: string, value: unknown): FilterBuilder;
  lte(column: string, value: unknown): FilterBuilder;
  or(filters: string): FilterBuilder;
  order(column: string, options?: { ascending?: boolean }): FilterBuilder;
  limit(count: number): FilterBuilder;
}

export interface ReadClient {
  from(table: string): { select(columns?: string): FilterBuilder };
}

export interface FetchAllOptions {
  table: string;
  /** Columns that together are unique and non-null (the primary key), in
   *  the order to page by. One or two columns. */
  keys: readonly [string] | readonly [string, string];
  columns?: string;
  /** Extra filters (eq / in / ranges), applied to every page. */
  filter?: (query: FilterBuilder) => FilterBuilder;
  pageSize?: number;
  client?: ReadClient;
}

/** PostgREST logic-tree value: always double-quoted so ids containing
 *  `,` `.` `(` `)` cannot break the filter (backslash-escape `"` and `\`). */
export const quoteFilterValue = (value: unknown): string =>
  `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Filter selecting rows strictly after `last` in (k1[, k2]) order. */
export function keysetAfter(query: FilterBuilder, keys: FetchAllOptions["keys"], last: Row): FilterBuilder {
  if (keys.length === 1) return query.gt(keys[0], last[keys[0]]);
  const [k1, k2] = keys;
  const v1 = quoteFilterValue(last[k1]);
  return query.or(`${k1}.gt.${v1},and(${k1}.eq.${v1},${k2}.gt.${quoteFilterValue(last[k2])})`);
}

// Equality only: the server orders text by the database collation, which
// need not match JavaScript's code-point order, so the client never
// compares keys for "greater than" itself.
const sameKey = (keys: FetchAllOptions["keys"], a: Row, b: Row): boolean =>
  keys.every((k) => String(a[k]) === String(b[k]));

const failure = (message: string, code?: string): ReadFailed => ({ data: null, error: { message, ...(code ? { code } : {}) } });

/**
 * Read every row matching `filter`, in key order, across as many pages as
 * the server needs. Resolves (never rejects) to all rows or an error.
 */
export async function fetchAllRows(options: FetchAllOptions): Promise<ReadResult> {
  const { table, keys, columns = "*", filter, pageSize = PAGE_SIZE } = options;
  const client = options.client ?? (supabase as unknown as ReadClient);
  const rows: Row[] = [];
  let last: Row | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let query = client.from(table).select(columns);
      if (filter) query = filter(query);
      if (last) query = keysetAfter(query, keys, last);
      for (const k of keys) query = query.order(k, { ascending: true });
      const { data, error } = await query.limit(pageSize);
      if (error) return failure(error.message, error.code);
      const batch = (data ?? []) as Row[];
      if (batch.length === 0) return { data: rows, error: null };
      for (const k of keys) {
        if (batch.some((r) => r[k] === null || r[k] === undefined)) {
          return failure(`fetchAllRows(${table}): page has rows without key column "${k}"`);
        }
      }
      const next = batch[batch.length - 1];
      // A page that ends on the key the previous page ended on means the
      // server ignored the keyset filter — stop instead of looping.
      if (last && (sameKey(keys, next, last) || batch.some((r) => sameKey(keys, r, last as Row)))) {
        return failure(`fetchAllRows(${table}): keyset did not advance`);
      }
      rows.push(...batch);
      last = next;
    }
    return failure(`fetchAllRows(${table}): more than ${MAX_PAGES} pages`);
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}

/** Split `values` into chunks of `size`. */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * fetchAllRows for rows whose `column` is in `values`, chunked (URL length)
 * and at most `concurrency` chunks in flight. Each chunk is itself paged, so
 * a chunk with more than PAGE_SIZE matches is still complete.
 */
export async function fetchAllRowsIn(
  options: Omit<FetchAllOptions, "filter"> & {
    column: string;
    values: readonly string[];
    chunkSize?: number;
    concurrency?: number;
    filter?: (query: FilterBuilder) => FilterBuilder;
  },
): Promise<ReadResult> {
  const { column, values, chunkSize = 100, concurrency = 4, filter, ...rest } = options;
  const unique = [...new Set(values)];
  const batches = chunk(unique, chunkSize);
  const results: Row[][] = new Array(batches.length);
  let failed: ReadFailed | null = null;
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < batches.length) {
      const index = nextIndex++;
      const res = await fetchAllRows({
        ...rest,
        filter: (q) => {
          const scoped = q.in(column, batches[index]);
          return filter ? filter(scoped) : scoped;
        },
      });
      if (res.error) { failed = res; return; }
      results[index] = res.data;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (failed) return failed;
  return { data: results.flat(), error: null };
}

/** Server clock (resolve_event_time(NULL) = now(), migration 045), or null. */
export async function fetchServerTime(): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("resolve_event_time", { p_client_time: null });
    if (error || typeof data !== "string" || Number.isNaN(Date.parse(data))) return null;
    return data;
  } catch {
    return null;
  }
}
