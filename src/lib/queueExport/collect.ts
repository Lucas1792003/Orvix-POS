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
  QUEUE_EXPORT_FORMAT, QUEUE_EXPORT_FORMAT_VERSION, QUEUE_EXPORT_FORMAT_VERSION_EVIDENCE, QUEUE_EXPORT_FORMAT_VERSION_UNREADABLE, inQueueOrder, redactSecrets, summarize,
  type QueueExportEntry, type QueueExportPayload, type QueueExportSummary, type UnreadableOnlineRecordExport,
} from "./format";
import { ONLINE_OP_PREFIX, UNREADABLE_SET_ASIDE_PREFIX, classifyOnlineRecord, setAsideRecord, unreadableInScope } from "../onlineOpRecord";
import { JOURNAL_PREFIX, VANISHED_PREFIX, parseJournal } from "../../stores/data/opJournal";
import { DEVICE_EVIDENCE_PREFIX, WITNESS_RECEIPT_PREFIX } from "../../recovery/journalCapture";
import type { EvidenceRecord } from "../../recovery/evidence";

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
    actorId: row.actorId ?? null,
    inDoubt: row.inDoubt ?? null,
    writeAhead: row.writeAhead ?? null,
    staged: row.staged ?? null,
    fenceRequired: row.fenceRequired ?? null,
    serverOutcome: row.serverOutcome ?? null,
    heldReason: row.heldReason ?? null,
    blocksQueue: row.blocksQueue ?? null,
    dependencySince: row.dependencySince ?? null,
    refWaitSince: row.refWaitSince ?? null,
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
/** A damaged evidence/receipt record is never dropped silently. Its contents are exported
 *  only when it still parses as a JSON object whose organization field (`orgId`,
 *  `envelope.body.orgId` or `body.checkpoint.orgId`) is exactly the exporting organization,
 *  and then with field-based credential redaction. Anything else (unparseable, another or an
 *  unknown organization) is exported as key, size and a fingerprint only; the original stays on the
 *  device. No text matching is used to decide scope. */
function unreadableMarker(row: { key: string; value?: string | null }, reason: string, orgId: string | null) {
  const raw = row.value ?? "";
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* unparseable */ }
  const o = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  const get = (...path: string[]): unknown => path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
  // EVERY organization field present must be exactly this organization (a crafted record with
  // one matching field and a conflicting, null or non-string other one is not exported).
  const fields = [get("orgId"), get("envelope", "body", "orgId"), get("body", "checkpoint", "orgId")].filter((v) => v !== undefined);
  if (o && orgId && fields.length > 0 && fields.every((v) => v === orgId)) {
    const counter = { n: 0 };
    const contents = redactSecrets(o, counter);
    return { unreadable: true, reason, key: row.key, contents, redacted: counter.n > 0 };
  }
  return { unreadable: true, reason, key: row.key, rawLength: raw.length, rawFingerprint: rawFingerprint(raw), scope: "unknown-organization" };
}
/** A non-cryptographic fingerprint (FNV-1a 32) to match the marker to the original kept on the
 *  device; WebCrypto SHA-256 is asynchronous and this runs inside a synchronous mapper. */
const rawFingerprint = (raw: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `fnv1a32:${h.toString(16).padStart(8, "0")}`;
};

export async function collectQueueExportSnapshot(db: LocalDb, ctx: QueueExportContext): Promise<QueueExportSnapshot> {
  const [rows, idMap, logRows, opRows, journalRows, evidenceRows, witnessRows] = await db.transaction("r", db.syncOutbox, db.provisionalIdMap, db.syncState, async () => [
    (await db.syncOutbox.toArray()) as StoredRow[],
    await db.provisionalIdMap.toArray(),
    await db.syncState.where("key").startsWith(RECONCILE_LOG_PREFIX).toArray(),
    await onlineRows(db),
    [...await db.syncState.where("key").startsWith(JOURNAL_PREFIX).toArray(), ...await db.syncState.where("key").startsWith(VANISHED_PREFIX).toArray()],
    await db.syncState.where("key").startsWith(DEVICE_EVIDENCE_PREFIX).toArray(),
    await db.syncState.where("key").startsWith(WITNESS_RECEIPT_PREFIX).toArray(),
  ] as const);
  const unreadable = parseUnreadableRecords(opRows, ctx.session.orgId);
  const base = buildPayload(rows, idMap, logRows, ctx);
  // The full operation history (the journal) and the continuity evidence go
  // only into an OWNER's export of their own organisation — never from the
  // sign-in screen (no session) and never in a staff export (row-level
  // security would hide most of it from them). Pending work is in `entries`.
  const owner = ctx.session.role === "ADMIN" && Boolean(ctx.session.orgId);
  const { journal, vanished, redacted } = owner ? parseJournalRows(journalRows, ctx.session.orgId) : { journal: [], vanished: [], redacted: 0 };
  const evidenceCounter = { n: 0 };
  const payload: QueueExportPayload = {
    ...base,
    ...(unreadable.length ? { formatVersion: QUEUE_EXPORT_FORMAT_VERSION_UNREADABLE } : {}),
    onlineOperations: parseOnlineOperations(opRows, ctx.session.orgId),
    unreadableOnlineRecords: unreadable,
    journal, vanished,
    deviceEvidence: owner ? evidenceRows.flatMap<unknown>((row) => {
      // Unparseable or malformed records are exported with their raw bytes (never dropped
      // silently); only a well-formed record of ANOTHER organization is left out.
      const unreadable = (reason: string) => [unreadableMarker(row, reason, ctx.session.orgId)];
      let record: EvidenceRecord;
      try { record = JSON.parse(row.value ?? "null") as EvidenceRecord; }
      catch { return unreadable("unparseable"); }
      if (!record?.envelope?.body || typeof record.envelope.body.orgId !== "string") return unreadable("malformed");
      if (record.envelope.body.orgId !== ctx.session.orgId) return [];
      // authorization in this signed envelope contains actor/epoch/tenant
      // context only. Export it byte-equivalent; redact free-form financial
      // snapshots separately and explicitly flag the resulting unverifiability.
      const count = { n: 0 };
      const payload = redactSecrets(record.payload, count);
      const observation = redactSecrets(record.observation, count);
      evidenceCounter.n += count.n;
      return [{ envelope: record.envelope, enrollment: record.enrollment, payload, observation, redacted: count.n > 0 }];
    }) : [],
    witnessReceipts: owner ? witnessRows.flatMap<unknown>((row) => {
      const unreadable = (reason: string) => [unreadableMarker(row, reason, ctx.session.orgId)];
      let receipt: { body?: { checkpoint?: { orgId?: unknown } } };
      try { receipt = JSON.parse(row.value ?? "null"); } catch { return unreadable("unparseable"); }
      if (typeof receipt?.body?.checkpoint?.orgId !== "string") return unreadable("malformed");
      return receipt.body.checkpoint.orgId === ctx.session.orgId ? [receipt] : [];
    }) : [],
    redactedFields: base.redactedFields + redacted + evidenceCounter.n,
  };
  // Signed evidence or receipts present: format 4, so an older reader refuses
  // the file instead of silently dropping them.
  if ((payload.deviceEvidence?.length ?? 0) > 0 || (payload.witnessReceipts?.length ?? 0) > 0) payload.formatVersion = QUEUE_EXPORT_FORMAT_VERSION_EVIDENCE;
  const digests = await Promise.all(rows.map(async (r) => ({ opId: r.localId, digest: await entryDigest(r) })));
  return { payload, digests };
}

export async function collectQueueExport(db: LocalDb, ctx: QueueExportContext): Promise<QueueExportPayload> {
  return (await collectQueueExportSnapshot(db, ctx)).payload;
}

/** Unresolved online-only operations (stores/data/onlineOnly.ts records) of
 *  one organisation (`orgId`), or of the whole till when no session is known
 *  (the sign-in screen — the same scope as the queue itself). Records this
 *  build cannot read are NOT here: see parseUnreadableRecords. */
function parseOnlineOperations(rows: readonly { key: string; value?: string }[], orgId: string | null = null): QueueExportPayload["onlineOperations"] {
  const out: QueueExportPayload["onlineOperations"] = [];
  for (const r of rows) {
    try {
      const c = classifyOnlineRecord(r);
      if (!("op" in c)) continue;
      const op = c.op;
      if (op.status !== "unresolved") continue;
      // another organisation's: never in this export (one that names none is kept — it might be this one's)
      if (orgId && typeof op.orgId === "string" && op.orgId && op.orgId !== orgId) continue;
      const args = (op.args ?? {}) as Record<string, unknown>;
      out.push({
        id: String(op.id), name: String(op.name), idempotencyKey: typeof args.p_idempotency_key === "string" ? args.p_idempotency_key : null,
        userId: typeof op.userId === "string" ? op.userId : null, orgId: typeof op.orgId === "string" ? op.orgId : null,
        backendOrigin: typeof op.backendOrigin === "string" ? op.backendOrigin : null,
        createdAt: String(op.createdAt), attempts: typeof op.attempts === "number" ? op.attempts : 0,
        // a stored unresolved operation may always have been applied
        uncertain: true, lastError: typeof op.lastError === "string" ? op.lastError.slice(0, 300) : null, blocksReplacement: true,
      });
    } catch {
      /* counted as unreadable by parseUnreadableRecords */
    }
  }
  return out;
}

/** Records the till cannot read (corrupt, or a newer build's), raw and
 *  verbatim — never dropped (deployment-blocker pass). Scoped like the
 *  operations, except that a record whose organisation cannot be read is
 *  always included (it might be this organisation's). */
function parseUnreadableRecords(rows: readonly { key: string; value?: string }[], orgId: string | null = null): UnreadableOnlineRecordExport[] {
  const out: UnreadableOnlineRecordExport[] = [];
  for (const r of rows) {
    // an owner's set-aside record stays in every export (its outcome is unknown)
    const u = r.key.startsWith(UNREADABLE_SET_ASIDE_PREFIX) ? setAsideRecord(r) : (() => { const c = classifyOnlineRecord(r); return "unreadable" in c ? c.unreadable : null; })();
    if (u && unreadableInScope(u, orgId)) out.push(u);
  }
  return out;
}

/** The operation journal and the continuity evidence, scoped like the
 *  queue: another organisation's records are never exported (one that names
 *  none — e.g. vanished rows, an unreadable record — is kept). Credentials
 *  are blanked like everywhere else in the file. */
function parseJournalRows(rows: readonly { key: string; value?: string }[], orgId: string | null): Pick<QueueExportPayload, "journal" | "vanished"> & { redacted: number } {
  const journal: QueueExportPayload["journal"] = [];
  const vanished: QueueExportPayload["vanished"] = [];
  const counter = { n: 0 };
  for (const r of rows) {
    let v: Record<string, unknown> | null = null;
    try { v = JSON.parse(r.value ?? "null"); } catch { v = null; }
    if (r.key.startsWith(VANISHED_PREFIX)) {
      // only this organisation's evidence (rows recorded without one stay on the till)
      if (!v || v.orgId !== orgId) continue;
      if (v && typeof v.table === "string" && typeof v.detectedAt === "string") vanished.push(redactSecrets({ ...v, key: r.key }, counter) as QueueExportPayload["vanished"][number]);
      continue;
    }
    const rec = parseJournal(r);
    if (!rec) {
      // a damaged record: exported only when it parses as this organisation's
      // (redacted, without its fingerprint); one naming another organisation is
      // theirs; anything else is exported as key, size and fingerprint
      const d = v as (Record<string, unknown> & { orgId?: unknown; fingerprint?: unknown }) | null;
      if (d && typeof d === "object" && d.orgId === orgId) {
        const { fingerprint: _f, ...rest } = d;
        void _f;
        journal.push({ key: r.key, rpc: String(d.rpc ?? ""), state: "unreadable", orgId, createdAt: String(d.createdAt ?? ""), raw: redactSecrets(rest, counter) });
      } else if (d && typeof d === "object" && typeof d.orgId === "string") {
        // a damaged record that still names ANOTHER organization: theirs, not exported (as for well-formed ones)
      } else {
        // unparseable, or parseable without a usable organization: never dropped silently
        journal.push({ key: r.key, rpc: "", state: "unreadable", orgId: null, createdAt: "", rawLength: (r.value ?? "").length, rawFingerprint: rawFingerprint(r.value ?? "") });
      }
      continue;
    }
    // this organisation's records, plus unattributed ones (older builds' rows) for its owner
    if (rec.orgId !== orgId && rec.orgId !== null) continue;
    // `fingerprint` is a free-text canonical form of the request: it would
    // carry what redaction blanks in `args`. Never exported (it is derived
    // from `args`, which is exported redacted).
    const { fingerprint: _fp, ...exported } = JSON.parse(JSON.stringify(rec)) as typeof rec;
    void _fp;
    journal.push(redactSecrets(exported, counter) as QueueExportPayload["journal"][number]);
  }
  return { journal, vanished, redacted: counter.n };
}

/** Every online-operation record row, the owner's set-aside ones included. */
const onlineRows = (db: LocalDb) => Promise.all([
  db.syncState.where("key").startsWith(ONLINE_OP_PREFIX).toArray(),
  db.syncState.where("key").startsWith(UNREADABLE_SET_ASIDE_PREFIX).toArray(),
]).then(([a, b]) => [...a, ...b]);

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
    onlineOperations: [],
    unreadableOnlineRecords: [],
    journal: [],
    vanished: [],
  };
}

/** The syncState keys of every unresolved online operation and unreadable
 *  record on the till (any organisation) — the updater guard counts them as
 *  unsynced work. Throws when the store cannot be read (the guard then
 *  reports nothing and the install stays blocked). */
export async function onlineRecordKeysBlockingInstall(db: LocalDb): Promise<string[]> {
  const rows = await onlineRows(db);
  return rows.filter((r) => {
    if (r.key.startsWith(UNREADABLE_SET_ASIDE_PREFIX)) return true;   // outcome unknown: like a set-aside entry
    const c = classifyOnlineRecord(r);
    return "unreadable" in c || c.op.status === "unresolved";
  }).map((r) => r.key);
}

/** Unresolved operations and unreadable records (of `orgId`, or the whole
 *  till). Throws when the store cannot be read (callers fail closed). */
export async function countOnlineRecords(db: LocalDb, orgId: string | null = null, userId: string | null = null): Promise<{ unresolved: number; unreadable: number; total: number }> {
  const rows = await onlineRows(db);
  // `userId`: only that user's own operations (the own-scope view's badge)
  const unresolved = parseOnlineOperations(rows, orgId).filter((o) => !userId || o.userId === userId).length;
  // the owner's set-aside records are exported and block an install, but no
  // longer block new entries: the badge / sign-in warning does not count them
  const unreadable = parseUnreadableRecords(rows, orgId).filter((r) => !r.setAside).length;
  return { unresolved, unreadable, total: unresolved + unreadable };
}

export async function countQueue(db: LocalDb, orgId: string | null = null): Promise<QueueExportSummary> {
  // Unresolved online-only operations count too: a till whose only open item
  // is a supplier payment of unknown outcome can still export it.
  const [rows, opRows] = await db.transaction("r", db.syncOutbox, db.syncState, async () => [
    await db.syncOutbox.toArray(),
    await onlineRows(db),
  ] as const);
  return summarize(rows.map((r) => ({ status: r.status, opType: r.name })), parseOnlineOperations(opRows, orgId).length, parseUnreadableRecords(opRows, orgId).length);
}
