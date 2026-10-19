import { supabase } from "../../lib/supabase";
import { localDb } from "../../lib/localDb";
import { classifyFailure } from "../../lib/failureClass";
import { enqueueOutbox } from "./outbox";
import { RpcError, runRequest, toRpcError, type RpcOutcome } from "./idempotentRpc";
import { EPOCH_HEADER } from "../../lib/epochHeader";
import { assertNewOperationAllowed, currentOpEpoch, isRecoveryBlocked } from "./recoveryState";

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
  // 087: created now, under the current epoch — or not at all (recovery mode).
  const opEpoch = currentOpEpoch();
  try {
    assertNewOperationAllowed(opEpoch);
  } catch (err) {
    if (isRecoveryBlocked(err)) return { error: { message: err.message } };
    throw err;
  }
  const queueForLater = async () => {
    await enqueueOutbox({ kind: "table_write", name: `${table}.${op}`, table, op, row, id, shopId: null, opEpoch });
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
  // One request, bounded, classified like every RPC (lib/failureClass.ts).
  // Anything that may not have reached the database, or whose outcome is
  // unknown, is queued and resent; a definitive refusal — including an
  // update/delete that matched no row — is returned to the caller.
  const outcome = await runTableWrite(table, op, row, id, opEpoch);
  if (outcome.error) {
    const { failure } = outcome.error;
    // (a recovery refusal holds — it is never queued for later)
    if (failure.retryable && failure.hold === null) return queueForLater();
    return { error: { message: outcome.error.message } };
  }
  await mirrorLocally(table, op, appRow, id);
  return { error: null };
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

/** The request for a table write. Every op returns the affected ids
 *  (`.select("id")`), so "matched no row" is visible instead of a silent
 *  204 (P0-E, until migration 087's apply_catalog_write). `row` is always
 *  the snake_case payload, never the app-shape mirror copy. */
export function replayTableWrite(
  table: string, op: "insert" | "update" | "delete", row: Record<string, unknown> | undefined, id: string, opEpoch: string | null = null,
) {
  const q = op === "insert" ? supabase.from(table).insert(row ?? {}).select("id")
    : op === "update" ? supabase.from(table).update(row ?? {}).eq("id", id).select("id")
    : supabase.from(table).delete().eq("id", id).select("id");
  // 087: the write carries the epoch it was CREATED under (lib/epochHeader.ts never overrides it)
  return opEpoch && typeof (q as { setHeader?: unknown }).setHeader === "function" ? q.setHeader(EPOCH_HEADER, opEpoch) : q;
}

const rejected = (message: string, code: string): RpcError =>
  new RpcError(message, { status: 409, code, failure: classifyFailure({ status: 409, code: "P0001", message }) });

/**
 * Judge a table write's reply. Success requires exactly one affected row
 * whose id is the target. Zero rows on update/delete is a definitive
 * conflict (the row is gone, or this user may not change it — the client
 * cannot tell which before 087). A reply with no row list at all (e.g. a
 * 404 with an empty body, which postgrest-js reports as a 204 success) is
 * an unrecognised reply: the outcome is unknown and the entry is kept.
 */
export function evaluateTableWrite(op: "insert" | "update" | "delete", id: string, outcome: RpcOutcome): RpcOutcome {
  if (outcome.error) return outcome;
  const rows = outcome.data;
  if (!Array.isArray(rows)) {
    return {
      data: null, status: outcome.status,
      error: new RpcError(`Unrecognised reply to a ${op} (status ${outcome.status ?? "?"}, no row list) — outcome unknown, kept for resend.`, {
        status: outcome.status, code: "MALFORMED_REPLY", failure: { ...classifyFailure({ status: 200 }), klass: "MALFORMED_SUCCESS" },
      }),
    };
  }
  if (rows.length === 0 && op !== "insert") {
    return { data: null, status: outcome.status, error: rejected(`The ${op} matched no row (it no longer exists, or you may not change it).`, "ZERO_ROWS") };
  }
  if (rows.length !== 1 || (rows[0] as { id?: unknown })?.id !== id) {
    return { data: null, status: outcome.status, error: rejected(`The ${op} affected ${rows.length} rows, expected exactly the target row.`, "UNEXPECTED_ROWS") };
  }
  return outcome;
}

/** Send one table write, bounded and classified; never rejects. */
export async function runTableWrite(
  table: string, op: "insert" | "update" | "delete", row: Record<string, unknown> | undefined, id: string, opEpoch: string | null = null,
): Promise<RpcOutcome> {
  let outcome: RpcOutcome;
  try {
    outcome = await runRequest(replayTableWrite(table, op, row, id, opEpoch), `${table}.${op}`);
  } catch (err) {
    outcome = { data: null, error: toRpcError(err) };
  }
  return evaluateTableWrite(op, id, outcome);
}

/** A duplicate-key error on THIS table's primary key: for an insert with a
 *  client-minted id, proof that an earlier attempt already committed. A
 *  duplicate on any other unique index (shop name/code, unit-type name, …)
 *  is a real conflict and is never treated as applied. */
export function isPrimaryKeyDuplicate(table: string, error: { code?: string; message?: string; details?: string } | null | undefined): boolean {
  if (!error || error.code !== "23505") return false;
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  return text.includes(`"${table}_pkey"`) || text.includes(` ${table}_pkey`);
}
