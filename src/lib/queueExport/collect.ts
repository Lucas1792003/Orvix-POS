// ----------------------------------------------------------------------
// Pending-queue export, read side: builds the export payload from the
// till's local database. READ-ONLY by construction:
//   * one Dexie transaction in mode "r" over syncOutbox + provisionalIdMap
//     (Dexie refuses any write inside it), so the snapshot is consistent
//     with a drain running in another tick and nothing can be modified;
//   * rows are copied field by field into new objects (an allowlist — no
//     spread of the stored row), so nothing in the result aliases Dexie's
//     objects and unknown future fields are not exported by accident.
// It never touches status/attempts/seq, never deletes, and never takes the
// drain lock — exporting cannot mark anything synced. Proven by
// collect.test.ts (queue byte-identical before/after; drain still works).
// ----------------------------------------------------------------------
import type { LocalDb, SyncOutboxEntry } from "../localDb";
import { RECONCILE_LOG_PREFIX } from "../reconcile/constants";
import { entryDigest } from "../reconcile/digest";
import {
  QUEUE_EXPORT_FORMAT, QUEUE_EXPORT_FORMAT_VERSION, inQueueOrder, redactSecrets, summarize,
  type QueueExportEntry, type QueueExportPayload, type QueueExportSummary,
} from "./format";

export interface QueueExportContext {
  appVersion: string;
  tillId: string;
  backendHost: string;
  session: { userId: string | null; orgId: string | null; shopId: string | null; role: string | null };
  now?: Date;
}

type StoredRow = SyncOutboxEntry & { seq?: number };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toEntry(row: StoredRow, counter: { n: number }): QueueExportEntry {
  const payload = row.kind === "rpc" ? row.args ?? null : row.row ?? null;
  return {
    seq: typeof row.seq === "number" ? row.seq : null,
    opId: row.localId,
    idempotencyKey: row.idempotencyKey ?? str(row.args?.p_idempotency_key),
    kind: row.kind,
    opType: row.name,
    table: row.table ?? null,
    tableOp: row.op ?? null,
    rowId: row.id ?? null,
    payload: payload ? redactSecrets(payload, counter) : null,
    refs: (row.refs ?? []).map((r) => ({ field: r.field, provisionalId: r.provisionalId })),
    provisional: (row.provisional ?? []).map((p) => ({ table: p.table, ids: [...p.ids] })),
    shopId: row.shopId ?? null,
    createdAt: row.createdAt,
    ringUpAt: str(row.args?.p_created_at),
    status: row.status,
    attempts: row.attempts ?? 0,
    lastErrorClass: row.failureKind ?? null,
    lastError: row.lastError ? row.lastError.slice(0, 500) : null,
    nextAttemptAt: row.nextAttemptAt ?? null,
    backendOrigin: row.backendOrigin ?? null,
    quarantineReason: row.quarantineReason ?? null,
    archivedAt: row.archivedAt ?? null,
    archivedBy: row.archivedBy ?? null,
    archiveReason: row.archiveReason ?? null,
    statusBeforeArchive: row.statusBeforeArchive ?? null,
    statusBeforeReconcile: row.statusBeforeReconcile ?? null,
    reconciliation: row.reconciliation ? redactSecrets(JSON.parse(JSON.stringify(row.reconciliation)), counter) : null,
    reconcileRejected: row.reconcileRejected
      ? { detectedAt: row.reconcileRejected.detectedAt, reason: row.reconcileRejected.reason, record: JSON.parse(JSON.stringify(row.reconcileRejected.record ?? null)) }
      : null,
  };
}

export interface QueueExportSnapshot {
  payload: QueueExportPayload;
  /** entryDigest (lib/reconcile/digest.ts) of every exported row, computed
   *  from the very rows of this snapshot — recorded per entry once the file
   *  is saved, so a reconciliation can prove the file holds this version. */
  digests: { opId: string; digest: string }[];
}

/** Snapshot of everything not yet on the server (every outbox row, any
 *  status), in queue order, plus the id map needed to resolve `refs` and
 *  (RC3) the local reconciliation log. */
export async function collectQueueExportSnapshot(db: LocalDb, ctx: QueueExportContext): Promise<QueueExportSnapshot> {
  const [rows, idMap, logRows] = await db.transaction("r", db.syncOutbox, db.provisionalIdMap, db.syncState, async () => [
    (await db.syncOutbox.toArray()) as StoredRow[],
    await db.provisionalIdMap.toArray(),
    await db.syncState.where("key").startsWith(RECONCILE_LOG_PREFIX).toArray(),
  ] as const);
  const payload = buildPayload(rows, idMap, logRows, ctx);
  const digests = await Promise.all(rows.map(async (r) => ({ opId: r.localId, digest: await entryDigest(r) })));
  return { payload, digests };
}

export async function collectQueueExport(db: LocalDb, ctx: QueueExportContext): Promise<QueueExportPayload> {
  return (await collectQueueExportSnapshot(db, ctx)).payload;
}

function parseLog(rows: readonly { value?: string }[]): QueueExportPayload["reconciliationLog"] {
  const out: QueueExportPayload["reconciliationLog"] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value ?? "null") as QueueExportPayload["reconciliationLog"][number] | null;
      if (v && typeof v.id === "string" && typeof v.at === "string" && typeof v.localId === "string") out.push(v);
    } catch {
      /* unreadable line: skipped */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.localeCompare(b.id)));
}

function buildPayload(
  rows: StoredRow[],
  idMap: { provisionalId: string; realId: string; createdAt: string }[],
  logRows: { value?: string }[],
  ctx: QueueExportContext,
): QueueExportPayload {
  const counter = { n: 0 };
  const entries = inQueueOrder(rows.map((r) => toEntry(r, counter)));
  return {
    format: QUEUE_EXPORT_FORMAT,
    formatVersion: QUEUE_EXPORT_FORMAT_VERSION,
    appVersion: ctx.appVersion,
    exportedAt: (ctx.now ?? new Date()).toISOString(),
    tillId: ctx.tillId,
    backendHost: ctx.backendHost,
    session: { ...ctx.session },
    entries,
    provisionalIdMap: idMap.map((m) => ({ provisionalId: m.provisionalId, realId: m.realId, createdAt: m.createdAt })),
    redactedFields: counter.n,
    reconciliationLog: parseLog(logRows),
  };
}

/** Counts only (for the dialog, before anything is decrypted or written). */
export async function countQueue(db: LocalDb): Promise<QueueExportSummary> {
  const rows = await db.transaction("r", db.syncOutbox, () => db.syncOutbox.toArray());
  return summarize(rows.map((r) => ({ status: r.status, opType: r.name })));
}
