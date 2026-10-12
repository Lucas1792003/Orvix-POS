import { supabase } from "../../lib/supabase";
import { isGatewayStatus, isNetworkError } from "../../lib/errors";
import { localDb } from "../../lib/localDb";
import { enqueueOutbox } from "./outbox";

// Tables this helper knows how to mirror locally. Deliberately narrow — the
// multi-row/batch catalog writes (product barcodes, product units, supplier
// links, product_unit_prices) stay online-only; see the Phase 4 note in
// purchaseSlice.ts / brandSlice.ts etc. for why.
const LOCAL_TABLES = {
  categories: localDb.categories,
  brands: localDb.brands,
  unit_types: localDb.unitTypes,
  price_tiers: localDb.priceTiers,
  shops: localDb.shops,
  users: localDb.users,
  suppliers: localDb.suppliers,
} as const;

type WritableTable = keyof typeof LOCAL_TABLES;

interface WriteTableRowInput {
  table: WritableTable;
  op: "insert" | "update" | "delete";
  /** snake_case payload sent to Supabase — full row for insert, changed
   *  columns only for update, ignored for delete. */
  row: Record<string, unknown>;
  /** The app-shape (camelCase) object matching the Zustand state — e.g. the
   *  same `Brand`/`Category`/... the caller already passed to `set()`. Used
   *  to mirror a FULL row into the local cache (a partial `update` payload
   *  would otherwise blank out the columns it doesn't include). Not needed
   *  for delete. */
  appRow?: object;
  /** Primary key — used for .eq("id", id) on update/delete and to key the
   *  local mirror (every table here uses plain `id text primary key`). */
  id: string;
}

/**
 * Drop-in replacement for a direct `supabase.from(table)...` call, used by
 * the simple single-row admin/catalog writes (categories, brands, unit
 * types, price tiers, shops, users, suppliers). Returns the same
 * `{ error }` shape a raw Postgrest call would, so every existing call
 * site's error handling/rollback logic works unchanged — callers just swap
 * what they call, not how they handle it.
 *
 * These are last-write-wins direct table writes with no server-side
 * invariants to replicate (unlike the RPC-backed flows in saleSlice.ts etc.)
 * — the row content the caller already built IS the final state, so a
 * queued write needs no reconciliation once it syncs, just removal from the
 * outbox (see outbox.ts's "table_write" branch).
 */
export async function writeTableRow(
  { table, op, row, appRow, id }: WriteTableRowInput,
): Promise<{ error: { message: string } | null }> {
  const queueForLater = async () => {
    await enqueueOutbox({ kind: "table_write", name: `${table}.${op}`, table, op, row, id, shopId: null });
    await mirrorLocally(table, op, appRow, id);
    return { error: null };
  };

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return queueForLater();
  }

  // supabase-js normally resolves with `{ error }` rather than rejecting
  // (it catches fetch-level failures internally) — but don't bet on that:
  // wrap the call so a genuine rejection is classified the same way as a
  // resolved network error, instead of escaping as an unhandled throw.
  try {
    const query =
      op === "insert" ? supabase.from(table).insert(row)
      : op === "update" ? supabase.from(table).update(row).eq("id", id)
      : supabase.from(table).delete().eq("id", id);

    const { error, status } = await query;
    // postgrest-js reports the HTTP status beside `error`, not inside it —
    // a gateway failure (502/503/504, or 0 for a fetch failure) means the
    // write may not have reached Postgres, so queue it like a network error.
    if (error && (isNetworkError(error) || isGatewayStatus(status))) {
      return queueForLater();
    }
    if (!error) await mirrorLocally(table, op, appRow, id);
    return { error };
  } catch (err) {
    if (isNetworkError(err)) return queueForLater();
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

async function mirrorLocally(
  table: WritableTable, op: "insert" | "update" | "delete", appRow: object | undefined, id: string,
): Promise<void> {
  try {
    const t = LOCAL_TABLES[table];
    if (op === "delete") {
      await t.delete(id);
    } else if (appRow) {
      await t.put(appRow as never);
    }
  } catch (err) {
    console.error(`[DB] Failed to mirror ${table} write to the local cache:`, err);
  }
}

/** Replays a queued table_write against Supabase. Called from outbox.ts's
 *  drain loop — returns the same shape supabase would so the drain loop's
 *  network-vs-rejection handling applies identically to RPC and table
 *  writes. `row` here is always the snake_case Supabase payload that was
 *  queued, never the app-shape mirror copy. */
export async function replayTableWrite(
  table: string, op: "insert" | "update" | "delete", row: Record<string, unknown> | undefined, id: string,
) {
  return op === "insert" ? supabase.from(table).insert(row ?? {})
    : op === "update" ? supabase.from(table).update(row ?? {}).eq("id", id)
    : supabase.from(table).delete().eq("id", id);
}
