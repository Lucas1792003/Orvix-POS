import { localDb } from "../../lib/localDb";
import type {
  AuditLog, Inventory, InventoryMovement, PurchaseOrder, PurchaseOrderItem, Refund, Sale, SaleItem,
  Shift, StockTransfer, StockTransferItem, SupplierPayment,
} from "../../types";

// Provisional (offline-authored) or server-authoritative rows to mirror into
// IndexedDB alongside the Zustand `set()` call that already applies them —
// keeps the local cache consistent with in-memory state so a reload while
// offline (or before the next full loadData()) doesn't lose them. Extend
// this shape as later phases add more offline-capable writes.
export interface LocalRowBatch {
  sales?: Sale[];
  saleItems?: SaleItem[];
  inventory?: Inventory[];
  movements?: InventoryMovement[];
  auditLogs?: AuditLog[];
  shifts?: Shift[];
  refunds?: Refund[];
  purchaseOrders?: PurchaseOrder[];
  purchaseOrderItems?: PurchaseOrderItem[];
  supplierPayments?: SupplierPayment[];
  stockTransfers?: StockTransfer[];
  stockTransferItems?: StockTransferItem[];
}

// ----------------------------------------------------------------------
// Writes that land while a full loadData() is in flight. The load's 27
// reads start before the write and their snapshot is applied after it, so
// without this the write (a shift just opened, a sale just rung up) is
// replaced by the stale server rows in both the store and the local
// mirror — the DB is right, the till's screen is not (Phase E finding).
// loadData() records every put/delete that happens between the start of
// its reads and the moment it applies the snapshot, then re-applies them.
// ----------------------------------------------------------------------
export interface RecordedWrites {
  puts: LocalRowBatch[];
  deletes: { table: string; ids: string[] }[];
}

// One recorder per in-flight load (two loads can overlap — e.g. a mount
// effect and a reconnect — and each must see every write made during ITS
// window); a write is recorded into all of them.
const activeRecorders = new Set<RecordedWrites>();

export function beginWriteRecording(): RecordedWrites {
  const recorder: RecordedWrites = { puts: [], deletes: [] };
  activeRecorders.add(recorder);
  return recorder;
}

export function endWriteRecording(recorder: RecordedWrites): RecordedWrites {
  activeRecorders.delete(recorder);
  return recorder;
}

function recordPut(rows: LocalRowBatch): void {
  for (const r of activeRecorders) r.puts.push(rows);
}

function recordDelete(entries: { table: string; ids: string[] }[]): void {
  for (const r of activeRecorders) r.deletes.push(...entries);
}

type RowTable = keyof LocalRowBatch;
const ROW_TABLES: RowTable[] = [
  "sales", "saleItems", "inventory", "movements", "auditLogs", "shifts", "refunds",
  "purchaseOrders", "purchaseOrderItems", "supplierPayments", "stockTransfers", "stockTransferItems",
];

const rowKey = (table: RowTable, row: unknown): string => {
  const r = row as { id?: string; shopId?: string; productId?: string };
  return table === "inventory" ? `${r.shopId}|${r.productId}` : String(r.id);
};

/** Re-apply recorded writes on top of a freshly loaded snapshot: puts
 *  replace rows with the same key (or are prepended when the snapshot does
 *  not have them), deletes remove rows. Pure; returns a new object. */
export function applyRecordedWrites<T extends Partial<Record<RowTable, unknown[]>>>(snapshot: T, writes: RecordedWrites): T {
  if (writes.puts.length === 0 && writes.deletes.length === 0) return snapshot;
  const out: Record<string, unknown[]> = { ...(snapshot as Record<string, unknown[]>) };
  for (const batch of writes.puts) {
    for (const table of ROW_TABLES) {
      const rows = batch[table] as unknown[] | undefined;
      if (!rows?.length || !Array.isArray(out[table])) continue;
      const byKey = new Map(rows.map((row) => [rowKey(table, row), row]));
      const replaced = (out[table] as unknown[]).map((row) => byKey.get(rowKey(table, row)) ?? row);
      const existing = new Set((out[table] as unknown[]).map((row) => rowKey(table, row)));
      const added = rows.filter((row) => !existing.has(rowKey(table, row)));
      out[table] = [...added, ...replaced];
    }
  }
  for (const { table, ids } of writes.deletes) {
    if (!Array.isArray(out[table])) continue;
    const gone = new Set(ids);
    out[table] = (out[table] as { id?: string }[]).filter((row) => !gone.has(String(row.id)));
  }
  return out as T;
}

// Callers fire these without awaiting (the Zustand `set()` already applied
// the change; this is just mirroring it to the cache). A failure here — no
// IndexedDB in this context, quota exceeded, private-browsing restrictions —
// must never surface as an unhandled rejection or block the write that
// already succeeded; log and move on, same as lib/supabase.ts's dbAudit.
export async function putLocalRows(rows: LocalRowBatch): Promise<void> {
  recordPut(rows);
  try {
    await Promise.all([
      rows.sales?.length ? localDb.sales.bulkPut(rows.sales) : undefined,
      rows.saleItems?.length ? localDb.saleItems.bulkPut(rows.saleItems) : undefined,
      rows.inventory?.length ? localDb.inventory.bulkPut(rows.inventory) : undefined,
      rows.movements?.length ? localDb.movements.bulkPut(rows.movements) : undefined,
      rows.auditLogs?.length ? localDb.auditLogs.bulkPut(rows.auditLogs) : undefined,
      rows.shifts?.length ? localDb.shifts.bulkPut(rows.shifts) : undefined,
      rows.refunds?.length ? localDb.refunds.bulkPut(rows.refunds) : undefined,
      rows.purchaseOrders?.length ? localDb.purchaseOrders.bulkPut(rows.purchaseOrders) : undefined,
      rows.purchaseOrderItems?.length ? localDb.purchaseOrderItems.bulkPut(rows.purchaseOrderItems) : undefined,
      rows.supplierPayments?.length ? localDb.supplierPayments.bulkPut(rows.supplierPayments) : undefined,
      rows.stockTransfers?.length ? localDb.stockTransfers.bulkPut(rows.stockTransfers) : undefined,
      rows.stockTransferItems?.length ? localDb.stockTransferItems.bulkPut(rows.stockTransferItems) : undefined,
    ]);
  } catch (err) {
    console.error("[DB] Failed to mirror rows to the local cache:", err);
  }
}

const TABLES = {
  sales: localDb.sales,
  saleItems: localDb.saleItems,
  movements: localDb.movements,
  auditLogs: localDb.auditLogs,
  shifts: localDb.shifts,
  refunds: localDb.refunds,
  purchaseOrders: localDb.purchaseOrders,
  purchaseOrderItems: localDb.purchaseOrderItems,
  supplierPayments: localDb.supplierPayments,
  stockTransfers: localDb.stockTransfers,
  stockTransferItems: localDb.stockTransferItems,
} as const;

/** Delete provisional rows (by table + id) once they've been superseded by
 *  the server's authoritative rows on sync. Composite-key tables like
 *  `inventory` aren't included here — they're never provisionally created,
 *  just upserted in place, so there's nothing to delete. */
export async function deleteLocalRows(provisional: { table: string; ids: string[] }[] | undefined): Promise<void> {
  if (!provisional?.length) return;
  recordDelete(provisional);
  try {
    await Promise.all(
      provisional.map(({ table, ids }) => {
        const t = TABLES[table as keyof typeof TABLES];
        return t && ids.length ? t.bulkDelete(ids) : undefined;
      }),
    );
  } catch (err) {
    console.error("[DB] Failed to remove provisional rows from the local cache:", err);
  }
}
