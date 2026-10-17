import { supabase } from "../../lib/supabase";
import { localDb } from "../../lib/localDb";
import type { LocalSnapshot } from "./localSync";
import { fetchServerTime, PAGE_SIZE, quoteFilterValue } from "./fetchAll";
import {
  mapBrand, mapCategory, mapPriceLevel, mapProduct, mapProductUnit, mapProductUnitPrice,
  mapPurchaseOrder, mapShift, mapStockTransfer, mapSupplier, mapUnitType,
} from "./mappers";

// ----------------------------------------------------------------------
// Delta pull-sync: for tables that reliably bump `updated_at` on every
// UPDATE (see migration 044 and the earlier per-table migrations it
// followed the pattern of), pull only rows changed since the last cursor
// instead of re-fetching the whole table. Every other table (shops, users,
// inventory, movements, sales, sale_items, purchase_order_items,
// stock_transfer_items, supplier_payments, supplier_products, price_tiers,
// product_barcodes, refund_void_requests, reprint_logs, audit_logs,
// business_profile) has no reliable change-tracking column and keeps being
// fully reloaded by loadData() — see docs/10-offline-desktop-known-issues.md
// for why (mostly: no updated_at, or genuinely append-only + small enough
// that a full reload is cheap anyway).
//
// IMPORTANT LIMITATION: `updated_at > cursor` can only ever tell you about
// rows that still exist. `products` supports a real hard DELETE
// (`delete_product` RPC) — a product deleted on another device will never
// be removed from a delta-only client; it's only caught by the next FULL
// loadData() (cold boot, or the reconnect-after-offline path in
// AppLayout.tsx, both of which stay on the full reload). Soft-deletes
// (is_active flips) ARE just an UPDATE and delta-sync catches those fine.
interface DeltaTable<T extends { id: string; updatedAt?: string }> {
  table: string;
  stateKey: keyof LocalSnapshot;
  localTable: { bulkPut: (rows: T[]) => Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapper: (row: any) => T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DELTA_TABLES: DeltaTable<any>[] = [
  { table: "categories", stateKey: "categories", localTable: localDb.categories, mapper: mapCategory },
  { table: "brands", stateKey: "brands", localTable: localDb.brands, mapper: mapBrand },
  { table: "unit_types", stateKey: "unitTypes", localTable: localDb.unitTypes, mapper: mapUnitType },
  { table: "products", stateKey: "products", localTable: localDb.products, mapper: mapProduct },
  { table: "product_units", stateKey: "productUnits", localTable: localDb.productUnits, mapper: mapProductUnit },
  { table: "price_levels", stateKey: "priceLevels", localTable: localDb.priceLevels, mapper: mapPriceLevel },
  { table: "product_unit_prices", stateKey: "productUnitPrices", localTable: localDb.productUnitPrices, mapper: mapProductUnitPrice },
  { table: "suppliers", stateKey: "suppliers", localTable: localDb.suppliers, mapper: mapSupplier },
  { table: "purchase_orders", stateKey: "purchaseOrders", localTable: localDb.purchaseOrders, mapper: mapPurchaseOrder },
  { table: "stock_transfers", stateKey: "stockTransfers", localTable: localDb.stockTransfers, mapper: mapStockTransfer },
  { table: "shifts", stateKey: "shifts", localTable: localDb.shifts, mapper: mapShift },
];

// ----------------------------------------------------------------------
// Schema compatibility (Batch 1-code H1). Migration 044 adds `updated_at`
// to these six tables, but the production database (lucashome, verified
// read-only 2026-10-16) and the hosted export it came from do NOT have the
// columns, although 044 is recorded in the migration ledger. On such a
// schema the tables cannot be delta-pulled: they stay "full-load only" —
// refreshed by loadData(), exactly what the pre-Batch-1 code did (it never
// created a cursor for them because their rows carry no updatedAt).
//
// A table enters full-load-only mode for the rest of the session when
//  (a) a full load returned rows for it and none carries updatedAt (no
//      request is ever sent), or
//  (b) its pull fails with SQLSTATE 42703 naming `<table>.updated_at` —
//      the only error treated this way, and only for these six tables.
// Every other failure still reports hadErrors. Once 044 is applied the
// rows carry updatedAt and the next session pulls deltas again.
// ----------------------------------------------------------------------
export const TABLES_ADDED_BY_044 = new Set([
  "products", "categories", "suppliers", "purchase_orders", "stock_transfers", "shifts",
]);
const fullLoadOnly = new Map<string, string>(); // table → reason

function enterFullLoadOnly(table: string, reason: string): void {
  if (fullLoadOnly.has(table)) return;
  fullLoadOnly.set(table, reason);
  console.warn(`[DB] Delta sync: "${table}" runs in full-load-only compatibility mode (${reason}). It is refreshed by full loads only until migration 044's updated_at column exists.`);
}

/** True only for the "column <table>.updated_at does not exist" error. */
export function isMissingUpdatedAtColumn(table: string, error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error || error.code !== "42703" || !TABLES_ADDED_BY_044.has(table)) return false;
  const message = String(error.message ?? "");
  return new RegExp(`(^|[^a-z_])(${table}\\.)?updated_at([^a-z_]|$)`).test(message) && message.includes(table);
}

/** Diagnostics: tables running without delta sync this session, and why. */
export function deltaSyncCompatibility(): { table: string; reason: string }[] {
  return [...fullLoadOnly].map(([table, reason]) => ({ table, reason }));
}

/** Tests only. */
export function resetDeltaSyncCompatibilityForTests(): void {
  fullLoadOnly.clear();
}

/** Replace-or-append by id — a delta pull only ever returns rows that
 *  changed, not the full table, so (unlike loadData()'s full replace) this
 *  must merge into what's already loaded rather than overwrite it. */
function mergeById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  if (updates.length === 0) return current;
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of updates) byId.set(row.id, row);
  return Array.from(byId.values());
}

/** A row may commit up to this long after the `updated_at` it carries
 *  (now() is the transaction start). Cursors never move closer than this to
 *  the server's clock, so a slow transaction is re-read, never skipped; the
 *  overlap only re-fetches rows that are merged by id anyway. */
export const COMMIT_LAG_MS = 5_000;

const minusLag = (serverTime: string): string | null => {
  const ms = Date.parse(serverTime);
  return Number.isNaN(ms) ? null : new Date(ms - COMMIT_LAG_MS).toISOString();
};

/**
 * Seed every delta table's cursor from a just-completed full load, so the
 * next background refresh can pull deltas instead of everything again.
 *
 * With `serverTimeBeforeLoad` (the server clock read before the first page),
 * every table starts at that instant minus COMMIT_LAG_MS: anything changed
 * while the load was paging is pulled again. Without it (no server time),
 * the old behaviour: the newest `updatedAt` in the snapshot.
 */
export async function bootstrapDeltaCursors(snapshot: LocalSnapshot, serverTimeBeforeLoad?: string | null): Promise<void> {
  const fromServer = serverTimeBeforeLoad ? minusLag(serverTimeBeforeLoad) : null;
  await Promise.all(
    DELTA_TABLES.map(async ({ table, stateKey }) => {
      const rows = snapshot[stateKey] as unknown as { updatedAt?: string }[];
      // Rows without updatedAt: this schema has no such column (044 not
      // applied). Never seed a cursor that could only produce failing pulls.
      if (rows.length > 0 && rows.every((row) => !row.updatedAt)) {
        enterFullLoadOnly(table, "the loaded rows carry no updated_at");
        await localDb.syncMeta.delete(table);
        return;
      }
      if (fullLoadOnly.has(table)) {
        await localDb.syncMeta.delete(table);
        return;
      }
      if (fromServer) {
        await localDb.syncMeta.put({ table, lastPulledAt: fromServer, lastPulledId: "" });
        return;
      }
      const latest = rows.reduce<string | undefined>(
        (max, row) => (row.updatedAt && (!max || row.updatedAt > max) ? row.updatedAt : max),
        undefined,
      );
      if (latest) await localDb.syncMeta.put({ table, lastPulledAt: latest });
    }),
  );
}

export interface DeltaPullResult {
  changes: Partial<LocalSnapshot>;
  hadErrors: boolean;
}

/**
 * Pull just what changed since the last cursor for every delta-capable
 * table. Returns the changed rows per table (already merged with what's
 * currently loaded is the CALLER's job — see AppLayout.tsx / index.ts — this
 * only fetches + upserts the local mirror). A table with no cursor yet
 * (never been through a full load) is skipped, not treated as an error.
 */
export async function pullDeltaChanges(
  currentState: Pick<LocalSnapshot, (typeof DELTA_TABLES)[number]["stateKey"]>,
): Promise<DeltaPullResult> {
  const changes: Partial<LocalSnapshot> = {};
  let hadErrors = false;

  // Server clock before any page: the upper bound for every cursor (see
  // COMMIT_LAG_MS). Unavailable → cursors advance to the last row as before.
  const serverNow = await fetchServerTime();
  const ceiling = serverNow ? minusLag(serverNow) : null;

  await Promise.all(
    DELTA_TABLES.map(async ({ table, stateKey, localTable, mapper }) => {
      if (fullLoadOnly.has(table)) return; // no updated_at on this schema
      const cursor = await localDb.syncMeta.get(table);
      if (!cursor) return; // never bootstrapped — wait for a full load first

      // Keyset on (updated_at, id), page by page. A cursor saved before the
      // id was stored ("") re-reads the rows AT lastPulledAt — harmless, they
      // are merged by id — instead of skipping same-timestamp rows past a
      // page boundary (RG-11).
      let at = cursor.lastPulledAt;
      let afterId = cursor.lastPulledId ?? "";
      let merged = (currentState[stateKey] as { id: string }[] | undefined) ?? [];
      let pulled = 0;
      for (let page = 0; page < MAX_DELTA_PAGES; page += 1) {
        const ts = quoteFilterValue(at);
        let res;
        try {
          res = await supabase
            .from(table)
            .select("*")
            .or(`updated_at.gt.${ts},and(updated_at.eq.${ts},id.gt.${quoteFilterValue(afterId)})`)
            .order("updated_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(PAGE_SIZE);
        } catch (err) {
          res = { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
        }
        if (res.error) {
          // The schema has no updated_at on this table (H1): not a sync
          // failure — the table is simply not delta-capable here. Only on
          // the first page (a column cannot vanish between pages).
          if (page === 0 && isMissingUpdatedAtColumn(table, res.error as { code?: string; message?: string })) {
            enterFullLoadOnly(table, "the server reports no updated_at column");
            await localDb.syncMeta.delete(table);
            return;
          }
          console.error(`[DB] Delta pull failed for ${table}:`, res.error.message);
          hadErrors = true;
          break; // pages already applied stay applied; the cursor marks where they ended
        }
        const raw = (res.data ?? []) as { id: string; updated_at: string }[];
        if (raw.length === 0) break;
        const last = raw[raw.length - 1];
        if (last.updated_at === at && last.id === afterId) {
          console.error(`[DB] Delta pull for ${table}: keyset did not advance`);
          hadErrors = true;
          break;
        }
        const rows = raw.map(mapper);
        merged = mergeById(merged, rows);
        pulled += rows.length;
        // Mirror first, cursor second: a crash in between re-reads this page.
        await localTable.bulkPut(rows);
        at = last.updated_at;
        afterId = last.id;
        await localDb.syncMeta.put({ table, lastPulledAt: at, lastPulledId: afterId });
      }

      // Never leave the cursor inside the commit-lag window.
      if (ceiling && pulled > 0 && Date.parse(at) > Date.parse(ceiling)) {
        await localDb.syncMeta.put({ table, lastPulledAt: ceiling, lastPulledId: "" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (pulled > 0) (changes as any)[stateKey] = merged;
    }),
  );

  return { changes, hadErrors };
}

/** 1,000 pages × 1,000 rows per table per pull; beyond that the next pull continues. */
const MAX_DELTA_PAGES = 1_000;
