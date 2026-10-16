// ----------------------------------------------------------------------
// Digests that bind an owner's reconciliation to exactly one outbox entry
// (1.0.16 RC3). Pure apart from WebCrypto (renderer, Node >= 20).
//
//   entryDigest   what the entry IS: localId + idempotency key + kind / name /
//                 table / op / row id + payload (args or row). Recorded per
//                 entry at export time and again in the reconciliation
//                 record; a later edit of any of these breaks the binding.
//   recordDigest  the reconciliation record's own content (everything but
//                 the owner block and the seal).
//   rowVersion    the WHOLE stored row: the compare-and-set token of the
//                 reconcile transaction (any change since the owner looked
//                 at the entry — a retry, a set aside, a drain — refuses).
// ----------------------------------------------------------------------
import type { SyncOutboxEntry } from "../localDb";
import { canonicalJson } from "../queueExport/format";
import type { ReconciliationRecord } from "./types";

export async function sha256Hex(text: string): Promise<string> {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");
  const buf = await c.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

type EntryLike = Pick<SyncOutboxEntry, "localId" | "kind" | "name" | "args" | "row" | "table" | "op" | "id" | "idempotencyKey">;

/** The identity of an entry: everything that decides what it would do. */
export function entryIdentity(row: EntryLike): Record<string, unknown> {
  const key = row.idempotencyKey ?? (typeof row.args?.p_idempotency_key === "string" ? row.args.p_idempotency_key : null);
  return {
    v: 1,
    localId: row.localId,
    idempotencyKey: key,
    kind: row.kind,
    name: row.name,
    table: row.table ?? null,
    op: row.op ?? null,
    id: row.id ?? null,
    payload: (row.kind === "rpc" ? row.args : row.row) ?? null,
  };
}

export async function entryDigest(row: EntryLike): Promise<string> {
  return sha256Hex(canonicalJson(entryIdentity(row)));
}

/** Everything in the record except the owner block, the digest itself and the seal. */
export function recordCore(record: Omit<ReconciliationRecord, "owner" | "recordDigest" | "seal"> | ReconciliationRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy.owner;
  delete copy.recordDigest;
  delete copy.seal;
  return copy;
}

export async function recordDigest(record: Omit<ReconciliationRecord, "owner" | "recordDigest" | "seal"> | ReconciliationRecord): Promise<string> {
  return sha256Hex(canonicalJson(recordCore(record)));
}

/** Compare-and-set token: the whole stored row. */
export async function rowVersion(row: SyncOutboxEntry): Promise<string> {
  return sha256Hex(canonicalJson(row));
}
