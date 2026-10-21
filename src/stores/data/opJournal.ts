import { localDb, type SyncOutboxEntry, type SyncStateEntry } from "../../lib/localDb";
import Dexie from "dexie";
import { getTillId } from "../../lib/tillId";
import { useAuthStore } from "../authStore";
import { captureJournal } from "../../recovery/journalCapture";
import { independentTrustSource } from "../../recovery/trust";

// ----------------------------------------------------------------------
// Till operation journal (W8/W10 Phase 0, disaster-recovery.md W8).
//
// One durable record per financially significant operation, keyed by its
// idempotency key, from the moment the operation exists on this till — and
// KEPT after the server acknowledges it. The outbox row of an acknowledged
// operation is deleted and the local sales mirror is replaced by every full
// load; this record is neither: it is the till's own evidence of what it
// submitted and what the server answered, for a reconciliation after the
// server was restored from an older backup.
//
// Rules:
//  - Records live in `syncState` under "opj:<key>" (no Dexie schema change, so
//    an older build still opens the database; syncState is never cleared by a
//    snapshot load). Every write runs INSIDE the caller's transaction (the one
//    that creates / acknowledges / decides the operation): either both are on
//    disk or neither. A journal write that fails aborts that transaction.
//  - Nothing here deletes a record. Retention is an owner decision (Phase 0
//    keeps everything).
//  - Only what this till observed is stored: the server's own replies, as
//    received. No server sequence number, continuity epoch or receipt is
//    ever invented; `fingerprint` is the CLIENT's canonical form of the
//    request, not the server's request hash.
//  - A server decision is never moved backwards: committed / rejected /
//    abandoned / not-applied are not overwritten by a weaker state; a
//    CONTRADICTING later answer (e.g. "abandoned" after "committed") is
//    recorded as a contradiction and the record keeps its earlier decision.
// ----------------------------------------------------------------------

export const JOURNAL_PREFIX = "opj:";
const MAX_EVENTS = 60;

/** What this till knows about the operation. */
export type JournalState =
  | "never-sent"               // created; no request has left the till (queued offline)
  | "unknown"                  // a request was sent (or may have been) and no decision is known
  | "not-applied"              // a reply proved nothing ran and nothing was recorded on the server
  | "committed"                // the server said it committed (its reply, a lookup, or a verified reload)
  | "rejected"                 // the server refused it (recorded refusal, or a definitive refusal reply)
  | "abandoned"                // the server says the key was stopped (fenced): it never ran
  | "reconciliation-required"  // the server has no record of a sent operation: it may have run on a server
                               // that was later restored — a person decides (never fenced automatically)
  | "owner-closed";            // an owner closed it after checking the records by hand

/** The five distinctions the till shows (plus the owner's closing). */
export type JournalCategory =
  | "confirmed-committed" | "confirmed-not-applied" | "never-sent" | "unknown-outcome" | "reconciliation-required" | "owner-decided";

export const categoryOf = (s: JournalState): JournalCategory =>
  s === "committed" ? "confirmed-committed"
    : s === "rejected" || s === "abandoned" || s === "not-applied" ? "confirmed-not-applied"
      : s === "never-sent" ? "never-sent"
        : s === "unknown" ? "unknown-outcome"
          : s === "reconciliation-required" ? "reconciliation-required" : "owner-decided";

const SERVER_DECIDED: ReadonlySet<JournalState> = new Set(["committed", "rejected", "abandoned", "not-applied"]);

export interface JournalEvidence {
  /** Where the decision came from. */
  source: "reply" | "lookup" | "verified-reload" | "owner" | "client";
  at: string;
  /** The server's reply as received (committed operations): the outcome rows
   *  the server created (ids, receipt numbers, amounts) — the evidence a
   *  reconciliation needs. Absent when the reply was not readable here. */
  response?: unknown;
  /** Committed, but the reply was not readable on this till. */
  responseUnavailable?: "withheld" | "purged" | "unreadable";
  code?: string | null;
  message?: string | null;
  /** The refusal / stop is recorded in the server's ledger (086) — a resend
   *  is answered from it. False: the reply said so, but nothing was recorded. */
  recordedOnServer?: boolean;
  /** THIS till stopped (fenced) the key after the server had no record of it
   *  (a replacement, an owner's decision): proves "not on this server", NOT
   *  "never ran" — it may have been lost by a restore. */
  fencedByTill?: boolean;
  /** Why this till stopped it. */
  fencedFor?: "replacement" | "owner" | "new-separate-operation" | "owner-verified";
}

export interface JournalEvent {
  at: string;
  event: string;
  detail?: string;
}

export interface JournalRecord {
  v: 1;
  key: string;
  rpc: string;
  /** "outbox": an offline-capable operation (syncOutbox row `ref`);
   *  "online-only": an online-only operation (online-op record `ref`). */
  source: "outbox" | "online-only";
  ref: string;
  orgId: string | null;
  actorId: string | null;
  tillId: string | null;
  backendOrigin: string | null;
  shopId: string | null;
  createdAt: string;
  updatedAt: string;
  /** The request exactly as the till sends it (key included). */
  args: Record<string, unknown> | null;
  /** The client's canonical form of what the request does (not the server's hash). */
  fingerprint: string;
  state: JournalState;
  evidence?: JournalEvidence;
  sends: number;
  firstSentAt?: string;
  lastSentAt?: string;
  /** A later operation entered as this one's replacement (and vice versa). */
  replacedBy?: string;
  replaces?: string[];
  /** A later server answer contradicted the recorded decision (kept as is). */
  contradiction?: string;
  /** Written from an existing queue row / record (created before the journal existed). */
  backfilled?: true;
  // ---- migration 087 (additive; absent on records of older builds) ----
  /** The server-issued recovery epoch the operation was CREATED under (never
   *  replaced). null: created without one (an older build, or a server
   *  without 087) — a legacy operation on an 087 server: never executed or
   *  fenced automatically. */
  opEpoch?: string | null;
  /** The receipt number this till printed for it, and when (first print). */
  printedReceiptNo?: string;
  printedAt?: string;
  /** The server's signed v87 reply binding (org, key, rpc, request_hash,
   *  actor, epoch_no, outcome, response_sha256) and its signature, as received. */
  signedReply?: { signed: unknown; sig: string };
  /** How many times the server acknowledged the decision (duplicates never
   *  overwrite the first evidence). */
  acks?: number;
  /** Pointer to a separate immutable signed snapshot. Older/unenrolled
   * records stay unsigned; the mutable journal never replaces that snapshot. */
  deviceEvidenceHash?: string;
  /** Recovery V1: this observation SHOULD have been signed (an independent trust source is
   *  configured) but no signed evidence could be produced (reason). Makes the gap visible
   *  instead of leaving an unsigned observation indistinguishable from a legacy one. */
  deviceEvidenceGap?: string;
  events: JournalEvent[];
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

/** What the operation does, without its key, time and actor stamp. */
export const fingerprintOf = (rpc: string, args: Record<string, unknown> | null | undefined): string => {
  const { p_idempotency_key: _k, p_created_at: _c, p_expected_actor_id: _a, ...rest } = args ?? {};
  void _k; void _c; void _a;
  return `${rpc}:${canonical(rest)}`;
};

const keyOf = (key: string) => JOURNAL_PREFIX + key;
const now = () => new Date().toISOString();
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

function tillIdOrNull(): string | null {
  try { return getTillId(); } catch { return null; }
}

/** Parse a stored record; null when it is not a readable journal record. */
export function parseJournal(row: Pick<SyncStateEntry, "value"> | undefined): JournalRecord | null {
  if (!row?.value) return null;
  try {
    const r = JSON.parse(row.value) as JournalRecord;
    return r && r.v === 1 && typeof r.key === "string" && typeof r.state === "string" && Array.isArray(r.events) ? r : null;
  } catch {
    return null;
  }
}

function pushEvent(rec: JournalRecord, event: string, detail?: string, at = now()): void {
  rec.events.push({ at, event, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
  if (rec.events.length > MAX_EVENTS) rec.events.splice(5, rec.events.length - MAX_EVENTS);   // keep the first 5 + the latest
}

/** Move a record to `next`, never backwards from a server decision. */
function transitionTo(rec: JournalRecord, next: JournalState, evidence: JournalEvidence | undefined, event: string, detail?: string): void {
  const at = evidence?.at ?? now();
  if (next === "owner-closed") {
    rec.state = next;
    if (evidence) rec.evidence = evidence;
  } else if (SERVER_DECIDED.has(rec.state) && rec.state !== next) {
    if (SERVER_DECIDED.has(next)) {
      // Two different server decisions for one key: never overwritten.
      rec.contradiction = `${rec.state} recorded at ${rec.evidence?.at ?? "?"}, then ${next} at ${at}${detail ? ` (${detail})` : ""}`.slice(0, 400);
      pushEvent(rec, "contradiction", rec.contradiction, at);
      rec.updatedAt = at;
      return;
    }
    // A weaker state after a decision (e.g. "unknown" on a resend): kept as an event only.
  } else if (SERVER_DECIDED.has(rec.state) && rec.state === next && rec.evidence) {
    // The same decision again (a duplicate acknowledgement, a replayed reply):
    // the FIRST evidence stays; a reply that differs is recorded, never applied.
    rec.acks = (rec.acks ?? 1) + 1;
    if (evidence?.response !== undefined && rec.evidence.response !== undefined
        && canonical(evidence.response) !== canonical(rec.evidence.response)) {
      rec.contradiction ??= `a later ${next} acknowledgement carried a different reply (${at})`;
      pushEvent(rec, "duplicate-ack-differs", detail, at);
    } else {
      pushEvent(rec, "duplicate-ack", detail, at);
    }
    rec.updatedAt = at;
    return;
  } else if (rec.state === "owner-closed") {
    // an owner's closing stays; later observations are events
  } else if (rec.state === "reconciliation-required" && !SERVER_DECIDED.has(next)) {
    // stays until the server decides it or an owner closes it (a later
    // "unreachable" or "in doubt" observation does not clear it)
  } else {
    rec.state = next;
    if (evidence) rec.evidence = evidence;
  }
  pushEvent(rec, event, detail, at);
  rec.updatedAt = at;
}

/** Read-modify-write one record INSIDE the caller's transaction (syncState
 *  must be in its scope). `make` builds the record when none exists. */
async function upsert(key: string, make: () => JournalRecord | null, change: (rec: JournalRecord) => void): Promise<void> {
  const transaction = Dexie.currentTransaction;
  if (!transaction) {
    await localDb.transaction("rw", localDb.syncState, () => upsert(key, make, change));
    return;
  }
  const table = transaction.table<SyncStateEntry, string>("syncState");
  const row = await table.get(keyOf(key));
  let rec = parseJournal(row);
  if (row && !rec) {
    // An unreadable record is never overwritten: kept beside the new one.
    await table.put({ key: `${JOURNAL_PREFIX}damaged:${key}:${Date.now()}`, value: row.value, updatedAt: now() });
  }
  if (!rec) rec = make();
  if (!rec) return;
  change(rec);
  if (independentTrustSource()) await captureJournal(rec);
  await table.put({ key: keyOf(key), value: JSON.stringify(rec), updatedAt: rec.updatedAt });
}

/** Is this outbox row a financially significant operation the journal covers? */
export const journaled = (row: Pick<SyncOutboxEntry, "kind" | "idempotencyKey">): row is SyncOutboxEntry & { idempotencyKey: string } =>
  row.kind === "rpc" && typeof row.idempotencyKey === "string" && row.idempotencyKey.length > 0;

/** The state an outbox row's own fields imply (no server decision known). */
export function stateFromRow(row: SyncOutboxEntry): JournalState {
  if (row.serverOutcome === "rejected") return "rejected";
  if (row.serverOutcome === "abandoned") return "abandoned";
  if (row.heldReason === "reconciliation-required") return "reconciliation-required";
  if (row.inDoubt === true || row.fenceRequired === true || row.status === "syncing" || row.statusBeforeArchive === "syncing") return "unknown";
  if (row.writeAhead === true && (row.attempts ?? 0) === 0) return "unknown";   // written just before its first request
  return "never-sent";
}

function newFromRow(row: SyncOutboxEntry & { idempotencyKey: string }, backfilled = false): JournalRecord {
  const at = row.createdAt ?? now();
  const sending = row.status === "syncing";
  return {
    v: 1, key: row.idempotencyKey, rpc: row.name, source: "outbox", ref: row.localId,
    // the operation's own organisation (stamped on the queue row); never the
    // current session's — a row of an older build stays unattributed (null)
    orgId: row.orgId ?? null, actorId: row.actorId ?? null, tillId: tillIdOrNull(), backendOrigin: row.backendOrigin ?? null,
    shopId: row.shopId ?? null, createdAt: at, updatedAt: now(), args: clone(row.args ?? null),
    opEpoch: row.opEpoch ?? null,
    fingerprint: fingerprintOf(row.name, row.args), state: stateFromRow(row), sends: sending ? 1 : 0,
    ...(sending && row.sentAt ? { firstSentAt: row.sentAt, lastSentAt: row.sentAt } : {}),
    ...(backfilled ? { backfilled: true as const } : {}),
    events: [{ at: now(), event: backfilled ? "backfilled" : sending ? "created-sending" : "created-queued" }],
  };
}

// ---- outbox operations (call inside the transaction that writes the row) ----

/** A new outbox row was written. */
export async function journalQueued(row: SyncOutboxEntry): Promise<void> {
  if (!journaled(row)) return;
  await upsert(row.idempotencyKey, () => newFromRow(row), (rec) => {
    if (rec.ref !== row.localId) pushEvent(rec, "requeued", `queue row ${row.localId}`);
  });
}

/** The row's own fields changed meaningfully (staged / in doubt / held / not delivered). */
export async function journalRowChanged(row: SyncOutboxEntry, event: string, detail?: string): Promise<void> {
  if (!journaled(row)) return;
  await upsert(row.idempotencyKey, () => newFromRow(row, true), (rec) => {
    const next = stateFromRow(row);
    if (next !== rec.state) transitionTo(rec, next, undefined, event, detail);
    else pushEvent(rec, event, detail);
    rec.updatedAt = now();
  });
}

/** A request for the operation is about to be sent (its key, unchanged). */
export async function journalSent(row: SyncOutboxEntry, sentAt: string): Promise<void> {
  if (!journaled(row)) return;
  await upsert(row.idempotencyKey, () => newFromRow(row, true), (rec) => {
    rec.sends += 1;
    rec.firstSentAt ??= sentAt;
    rec.lastSentAt = sentAt;
    if (!SERVER_DECIDED.has(rec.state) && rec.state !== "owner-closed" && rec.state !== "reconciliation-required") rec.state = "unknown";
    pushEvent(rec, "sent", undefined, sentAt);
    rec.updatedAt = sentAt;
  });
}

/** The server committed it: its reply (or why the reply is not readable). */
export async function journalCommitted(
  row: SyncOutboxEntry, evidence: Omit<JournalEvidence, "at"> & { at?: string }, signedReply?: { signed: unknown; sig: string } | null,
): Promise<void> {
  if (!journaled(row)) return;
  const ev: JournalEvidence = { ...evidence, at: evidence.at ?? now(), response: clone(evidence.response) };
  await upsert(row.idempotencyKey, () => newFromRow(row, true), (rec) => {
    if (signedReply && !rec.signedReply) rec.signedReply = clone(signedReply);
    transitionTo(rec, "committed", ev, `committed (${ev.source})`);
  });
}

/** 087: the server refused the operation with a recovery code (nothing ran, nothing recorded). An event, never a decision. */
export async function journalRecoveryRefusal(row: SyncOutboxEntry, code: string, detail?: string): Promise<void> {
  if (!journaled(row)) return;
  await upsert(row.idempotencyKey, () => newFromRow(row, true), (rec) => {
    pushEvent(rec, `recovery-refused:${code}`, detail);
    rec.updatedAt = now();
  });
}

/** Sale id -> the key of the operation that created it (this session; an
 *  offline sale carries its key itself). Used to journal printed receipts. */
const saleOperations = new Map<string, string>();
export function rememberSaleOperation(saleId: string, key: string): void {
  saleOperations.set(saleId, key);
  if (saleOperations.size > 500) saleOperations.delete(saleOperations.keys().next().value as string);
}
/** Tests only: a restarted process has no sale->key map. */
export function forgetSaleOperationsForTests(): void {
  saleOperations.clear();
}
export function saleOperationKey(sale: { id: string; idempotencyKey?: string }): string | null {
  return sale.idempotencyKey ?? saleOperations.get(sale.id) ?? null;
}

/**
 * Before a receipt prints (first print or reprint): the printed number goes
 * into the journal record of the operation that created the sale — found by
 * its key, or (after a restart) by the sale id in the server's recorded reply.
 * Throws when that record exists but cannot be written (the print must not
 * happen: fail closed). A sale this till did not create (another till's, or
 * one from before the journal) has no record here and prints as before.
 */
export async function journalReceiptPrint(sale: { id: string; idempotencyKey?: string; receiptNo: string }): Promise<"journaled" | "not-this-till"> {
  let key = saleOperationKey(sale);
  if (!key) {
    const rows = await localDb.syncState.where("key").startsWith(JOURNAL_PREFIX).toArray();
    for (const row of rows) {
      const rec = parseJournal(row);
      const s = (rec?.evidence?.response as { sale?: { id?: string } } | undefined)?.sale;
      if (rec && rec.rpc === "complete_sale" && s?.id === sale.id) { key = rec.key; break; }
    }
  }
  if (!key || !(await getJournalRecord(key))) return "not-this-till";
  await journalPrinted(key, sale.receiptNo);
  return "journaled";
}

/** The receipt number this till printed for an operation (first print kept; reprints are events). */
export async function journalPrinted(key: string, receiptNo: string): Promise<void> {
  await localDb.transaction("rw", localDb.syncState, () => upsert(key, () => null, (rec) => {
    const at = now();
    if (!rec.printedReceiptNo) { rec.printedReceiptNo = receiptNo; rec.printedAt = at; pushEvent(rec, "printed", receiptNo, at); }
    else pushEvent(rec, "reprinted", receiptNo, at);
    rec.updatedAt = at;
  }));
}

/** The server decided it for good: refused, or stopped (fenced). */
export async function journalDecided(row: SyncOutboxEntry, state: "rejected" | "abandoned" | "not-applied", evidence: Omit<JournalEvidence, "at">, detail?: string): Promise<void> {
  if (!journaled(row)) return;
  const ev: JournalEvidence = { ...evidence, at: now() };
  await upsert(row.idempotencyKey, () => newFromRow(row, true), (rec) => transitionTo(rec, state, ev, `${state} (${ev.source})`, detail));
}

/** The server has no record of an operation that was (or may have been) sent. */
export async function journalReconciliationRequired(row: SyncOutboxEntry, detail: string): Promise<void> {
  if (!journaled(row)) return;
  await upsert(row.idempotencyKey, () => newFromRow(row, true), (rec) => {
    if (SERVER_DECIDED.has(rec.state)) {
      // The till holds a server decision the server no longer has: the
      // strongest sign of a restored server. The decision is kept.
      rec.contradiction ??= `server now has no record of this ${rec.state} operation (${now()})`;
      pushEvent(rec, "server-has-no-record", detail);
      rec.updatedAt = now();
      return;
    }
    transitionTo(rec, "reconciliation-required", { source: "lookup", at: now() }, "reconciliation-required", detail);
  });
}

/** An owner action on the operation (set aside, restore, reconcile, stop on server …). */
export async function journalOwner(row: SyncOutboxEntry, event: string, detail?: string, close = false): Promise<void> {
  if (!journaled(row)) return;
  await upsert(row.idempotencyKey, () => newFromRow(row, true), (rec) => {
    if (close) transitionTo(rec, "owner-closed", { source: "owner", at: now() }, event, detail);
    else { pushEvent(rec, event, detail); rec.updatedAt = now(); }
  });
}

/** Link a replacement to the earlier attempts it replaces. */
export async function journalReplacement(replacementKey: string, earlierKeys: string[]): Promise<void> {
  for (const k of earlierKeys) {
    await upsert(k, () => null, (rec) => { rec.replacedBy = replacementKey; pushEvent(rec, "replaced", `by ${replacementKey}`); rec.updatedAt = now(); });
  }
  await upsert(replacementKey, () => null, (rec) => { rec.replaces = [...new Set([...(rec.replaces ?? []), ...earlierKeys])]; rec.updatedAt = now(); });
}

// ---- online-only operations (call inside the transaction on its record) ----

export interface OnlineOpLike {
  id: string; name: string; orgId: string | null; userId: string | null; args: Record<string, unknown>;
  status: "unresolved" | "settled";
  outcome?: "applied" | "refused" | "not-applied" | "abandoned" | "verified-manually";
  createdAt: string; attempts: number; uncertain?: boolean; backendOrigin?: string;
  decidedBy?: "server" | "client" | "owner";
  /** 087: the epoch it was created under (never replaced). */
  opEpoch?: string | null;
}

const onlineState = (op: OnlineOpLike): JournalState => {
  if (op.status === "settled") {
    switch (op.outcome) {
      case "applied": return "committed";
      case "refused": return "rejected";
      case "abandoned": return "abandoned";
      case "not-applied": return "not-applied";
      case "verified-manually": return "owner-closed";
    }
  }
  return op.attempts > 0 || op.uncertain ? "unknown" : "never-sent";
};

/** The online-only record changed (created, attempt claimed, settled, reopened). */
export async function journalOnline(op: OnlineOpLike, event: string, evidence?: Omit<JournalEvidence, "at">): Promise<void> {
  const key = op.args?.p_idempotency_key;
  if (typeof key !== "string" || !key) return;
  const at = now();
  await upsert(key, () => ({
    v: 1, key, rpc: op.name, source: "online-only", ref: op.id, orgId: op.orgId, actorId: op.userId, tillId: tillIdOrNull(),
    backendOrigin: op.backendOrigin ?? null, shopId: typeof op.args.p_shop_id === "string" ? op.args.p_shop_id : null,
    createdAt: op.createdAt, updatedAt: at, args: clone(op.args), fingerprint: fingerprintOf(op.name, op.args),
    opEpoch: op.opEpoch ?? null,
    state: "never-sent", sends: 0, events: [{ at, event: "created" }],
  }), (rec) => {
    if (event === "attempt") {
      rec.sends += 1; rec.firstSentAt ??= at; rec.lastSentAt = at;
    }
    const next = onlineState(op);
    const ev = evidence ? { ...evidence, at, response: clone(evidence.response) } : undefined;
    if (next !== rec.state || ev) transitionTo(rec, next, ev ?? (SERVER_DECIDED.has(next) ? { source: op.decidedBy === "client" ? "client" : "reply", at } : undefined), event);
    else { pushEvent(rec, event); rec.updatedAt = at; }
  });
}

/** By key: the server has no record of a sent (or possibly sent) operation. */
export async function journalKeyReconciliationRequired(key: string, detail: string): Promise<void> {
  await upsert(key, () => null, (rec) => {
    if (SERVER_DECIDED.has(rec.state)) {
      rec.contradiction ??= `server now has no record of this ${rec.state} operation (${now()})`;
      pushEvent(rec, "server-has-no-record", detail);
      rec.updatedAt = now();
      return;
    }
    if (rec.state === "never-sent") { pushEvent(rec, "not-on-server-yet", detail); rec.updatedAt = now(); return; }
    transitionTo(rec, "reconciliation-required", { source: "lookup", at: now() }, "reconciliation-required", detail);
  });
}

// ---- reading -------------------------------------------------------------

/** Every readable record, plus the keys of damaged ones (never acted on). */
/** `orgId`: only that organisation's records; unattributed records (older
 *  builds' rows, organisation unknown) only with `includeUnattributed` (owners). */
export async function listJournal(opts: { orgId?: string | null; includeUnattributed?: boolean } = {}): Promise<{ records: JournalRecord[]; damaged: string[] }> {
  const rows = await localDb.syncState.where("key").startsWith(JOURNAL_PREFIX).toArray();
  const records: JournalRecord[] = [];
  const damaged: string[] = [];
  for (const row of rows) {
    if (row.key.startsWith(`${JOURNAL_PREFIX}damaged:`)) { damaged.push(row.key); continue; }
    const rec = parseJournal(row);
    if (!rec) { damaged.push(row.key); continue; }
    // another organisation's record is never listed; an unattributed one only for an owner who asks
    if (opts.orgId !== undefined && rec.orgId !== opts.orgId && !(rec.orgId === null && opts.includeUnattributed)) continue;
    records.push(rec);
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { records, damaged };
}

export async function getJournalRecord(key: string): Promise<JournalRecord | null> {
  return parseJournal(await localDb.syncState.get(keyOf(key)));
}

export interface JournalSummary {
  total: number;
  byCategory: Record<JournalCategory, number>;
  contradictions: number;
  damaged: number;
}

export async function journalSummary(orgId: string | null): Promise<JournalSummary> {
  const { records, damaged } = await listJournal({ orgId, includeUnattributed: useAuthStore.getState().currentRole === "ADMIN" });
  const byCategory: Record<JournalCategory, number> = {
    "confirmed-committed": 0, "confirmed-not-applied": 0, "never-sent": 0, "unknown-outcome": 0, "reconciliation-required": 0, "owner-decided": 0,
  };
  for (const r of records) byCategory[categoryOf(r.state)] += 1;
  return { total: records.length, byCategory, contradictions: records.filter((r) => r.contradiction).length, damaged: damaged.length };
}

// ---- backfill (startup) ------------------------------------------------------

/** Journal every existing queue row and online-only record that has no
 *  record yet (operations created before this build). Idempotent. What was
 *  acknowledged before this build cannot be recovered: nothing is invented. */
export async function backfillJournal(onlineRows: () => Promise<OnlineOpLike[]>): Promise<number> {
  let n = 0;
  const rows = await localDb.syncOutbox.toArray();
  for (const row of rows) {
    if (!journaled(row)) continue;
    await localDb.transaction("rw", localDb.syncState, async () => {
      if (await localDb.syncState.get(keyOf(row.idempotencyKey))) return;
      const rec = newFromRow(row, true);
      if (row.serverOutcome) rec.evidence = { source: "reply", at: rec.updatedAt, recordedOnServer: true };
      await localDb.syncState.put({ key: keyOf(row.idempotencyKey), value: JSON.stringify(rec), updatedAt: rec.updatedAt });
      n += 1;
    });
  }
  for (const op of await onlineRows().catch(() => [] as OnlineOpLike[])) {
    const key = op.args?.p_idempotency_key;
    if (typeof key !== "string") continue;
    await localDb.transaction("rw", localDb.syncState, async () => {
      if (await localDb.syncState.get(keyOf(key))) return;
      await journalOnline(op, "backfilled");
      const rec = parseJournal(await localDb.syncState.get(keyOf(key)));
      if (rec) {
        rec.backfilled = true;
  await localDb.syncState.put({ key: keyOf(key), value: JSON.stringify(rec), updatedAt: rec.updatedAt });
      }
      n += 1;
    });
  }
  return n;
}

// ---- server continuity evidence (W8 Phase 0) --------------------------------
//
// A full load replaces the local mirror with the server's rows. A sale or
// supplier payment this till had seen FROM THE SERVER that the server no
// longer returns — although it falls inside what the load covers — is the
// clearest sign this till can see of a server restored from an older backup
// (or of server rows removed by hand). Phase 0 cannot detect every rollback
// (a restore that loses nothing this till ever loaded looks normal); when it
// sees one, it keeps the rows as evidence and pauses AUTOMATIC sending until
// an owner acknowledges it (a resend against a rolled-back server could
// re-execute or refuse operations against old data).

// Own prefixes (not "opj:"): evidence and acknowledgements are not journal records.
export const VANISHED_PREFIX = "opjv:";
export const CONTINUITY_ACK_PREFIX = "opjack:";
/** Who the last full load was made for: a load under another user / role
 *  (a narrower RLS view — e.g. a cashier sees only own-shift sales) is never
 *  compared with it. */
export const SNAPSHOT_SCOPE_KEY = "snapshot-scope";
export const CONTINUITY_KEY = "server-continuity:suspect";
/** The newest sales a full load fetches (stores/data/index.ts). */
export const SALES_LOAD_CAP = 1000;

interface VanishCandidate { id: string; shopId?: string | null; createdAt?: string; pendingSync?: boolean; idempotencyKey?: string; receiptNo?: string }

/** Rows of `oldRows` the new snapshot no longer has although it covers them. */
const isProvisional = (r: VanishCandidate) => r.pendingSync === true || Boolean(r.idempotencyKey) || r.receiptNo === "PENDING";

export function vanishedRows<T extends VanishCandidate>(oldRows: readonly T[], newRows: readonly VanishCandidate[], opts: { cap?: number; visibleShops: ReadonlySet<string> }): T[] {
  const present = new Set(newRows.map((r) => r.id));
  // Rows of a capped load older than its oldest SERVER row are simply not
  // loaded (queued offline rows merged into the snapshot never lower it).
  const serverRows = newRows.filter((r) => !isProvisional(r));
  const floor = opts.cap && serverRows.length >= opts.cap
    ? serverRows.reduce((m, r) => (r.createdAt && (!m || r.createdAt < m) ? r.createdAt : m), "" as string)
    : "";
  // Only shops the new load shows rows for (another user's / organisation's
  // narrower view is not a loss).
  const shopsWithRows = new Set(serverRows.map((r) => r.shopId).filter((s): s is string => typeof s === "string"));
  return oldRows.filter((r) =>
    !present.has(r.id) && !isProvisional(r)
    && typeof r.shopId === "string" && opts.visibleShops.has(r.shopId) && shopsWithRows.has(r.shopId)
    && (!floor || (typeof r.createdAt === "string" && r.createdAt > floor)));
}

/** Inside the snapshot-replace transaction (syncState in scope): keep the
 *  vanished rows and raise the continuity flag. Returns how many were new. */
export async function recordVanished(table: string, rows: readonly { id: string }[], related: (id: string) => unknown = () => undefined, orgId: string | null = null): Promise<number> {
  // (the continuity flag below records the organisation whose load saw it)
  let n = 0;
  const at = now();
  for (const row of rows) {
    const key = `${VANISHED_PREFIX}${table}:${row.id}`;
    if (await localDb.syncState.get(key)) continue;
    await localDb.syncState.put({ key, updatedAt: at, value: JSON.stringify({ table, orgId, row: clone(row), related: clone(related(row.id)), detectedAt: at }) });
    n += 1;
  }
  if (n > 0) {
    const cur = await localDb.syncState.get(CONTINUITY_KEY);
    let info: { count: number; firstDetectedAt: string; lastDetectedAt: string; tables: string[] } = { count: 0, firstDetectedAt: at, lastDetectedAt: at, tables: [] };
    try { if (cur?.value) info = { ...info, ...JSON.parse(cur.value) }; } catch { /* rewritten below */ }
    info.count += n; info.lastDetectedAt = at; info.tables = [...new Set([...info.tables, table])];
    await localDb.syncState.put({
      key: CONTINUITY_KEY, flag: true, updatedAt: at, value: JSON.stringify({ ...info, orgId }),
      reason: `${info.count} record(s) this till had loaded from the server are no longer there (${info.tables.join(", ")}): the server may have been restored from an older backup.`,
    });
  }
  return n;
}

export interface ContinuityWarning { since: string; count: number; reason: string }

/** The raised (not yet acknowledged) continuity warning, or null. A storage
 *  error counts as raised: automatic sending fails closed. */
export async function continuityWarning(): Promise<ContinuityWarning | null> {
  try {
    const row = await localDb.syncState.get(CONTINUITY_KEY);
    if (!row?.flag) return null;
    let info: { count?: number; firstDetectedAt?: string } = {};
    try { info = JSON.parse(row.value ?? "{}"); } catch { /* reason stays */ }
    return { since: info.firstDetectedAt ?? row.updatedAt, count: info.count ?? 0, reason: row.reason ?? "" };
  } catch {
    return { since: now(), count: 0, reason: "the till could not read its continuity record" };
  }
}

/** Owner: acknowledge the warning (automatic sending resumes). The evidence
 *  rows are kept; the statement is recorded. */
export async function acknowledgeContinuity(ownerUserId: string | null, statement: string): Promise<void> {
  // Owner (ADMIN, server-verified at sign-in) only — enforced here, not only in the UI.
  const { currentUserId, currentRole } = useAuthStore.getState();
  if (!currentUserId || currentRole !== "ADMIN") throw new Error("Only the owner (administrator) can acknowledge this warning.");
  if (statement.trim().length < 15) throw new Error("Write down what you established (at least 15 characters). Nothing was changed.");
  const at = now();
  await localDb.transaction("rw", localDb.syncState, async () => {
    const row = await localDb.syncState.get(CONTINUITY_KEY);
    if (!row?.flag) return;
    let flagOrg: string | null = null;
    try { flagOrg = (JSON.parse(row.value ?? "{}") as { orgId?: string | null }).orgId ?? null; } catch { /* unreadable: any owner */ }
    if (flagOrg && flagOrg !== (useAuthStore.getState().currentOrgId ?? null)) {
      throw new Error("This warning was raised by another organisation's data on this till; only that organisation's owner can acknowledge it.");
    }
    await localDb.syncState.put({ ...row, flag: false, updatedAt: at });
    await localDb.syncState.put({
      key: `${CONTINUITY_ACK_PREFIX}${Date.now()}`, updatedAt: at,
      value: JSON.stringify({ at, ownerUserId, statement: statement.slice(0, 500), warning: row.reason, detail: row.value }),
    });
  });
}

export async function listVanished(): Promise<{ key: string; table: string; row: unknown; related: unknown; detectedAt: string }[]> {
  const rows = await localDb.syncState.where("key").startsWith(VANISHED_PREFIX).toArray();
  const out: { key: string; table: string; row: unknown; related: unknown; detectedAt: string }[] = [];
  for (const r of rows) {
    try { const v = JSON.parse(r.value ?? "null"); if (v) out.push({ key: r.key, ...v }); } catch { /* kept raw in storage */ }
  }
  return out;
}
