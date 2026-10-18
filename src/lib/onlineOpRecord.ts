// ----------------------------------------------------------------------
// Online-only operation records (stores/data/onlineOnly.ts, syncState
// "online-op:<id>"): which stored rows this build can read. Dependency-free:
// shared by the app (replacement check, counts) and the queue export.
// Deployment-blocker pass: a record this build cannot read — corrupt, or
// written by a NEWER build — may be an unresolved payment. It is never
// dropped: callers count it, show it, export it raw and let it block a
// replacement it could be. Nothing is invented for it: `claimed` fields are
// whatever can be read from it, unverified, never used as its identity.
// ----------------------------------------------------------------------

export const ONLINE_OP_PREFIX = "online-op:";
/** An unreadable record the owner set aside (after exporting it): kept raw,
 *  still exported and still blocking an install — its outcome is unknown. */
export const UNREADABLE_SET_ASIDE_PREFIX = "online-op-unreadable-set-aside:";

export interface UnreadableOnlineRecord {
  key: string;
  raw: string;
  reason: "unparseable" | "unknown-format";
  /** Set aside by the owner (no longer blocks new entries; still exported). */
  setAside?: boolean;
  claimed: { name: string | null; scope: string | null; orgId: string | null; userId: string | null; backendOrigin: string | null; version: unknown };
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Classify a stored row: a readable (format 2) operation, or an unreadable record. */
export function classifyOnlineRecord<T = Record<string, unknown>>(row: { key: string; value?: unknown }): { op: T } | { unreadable: UnreadableOnlineRecord } {
  const raw = typeof row.value === "string" ? row.value : JSON.stringify(row.value ?? null) ?? "";
  let parsed: unknown;
  try {
    parsed = typeof row.value === "string" ? JSON.parse(raw) : row.value;
  } catch {
    return { unreadable: { key: row.key, raw, reason: "unparseable", claimed: { name: null, scope: null, orgId: null, userId: null, backendOrigin: null, version: null } } };
  }
  const o = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  // A status this build does not know (a newer build's) is not readable:
  // it is neither provably unresolved nor provably settled.
  if (o.v === 2 && typeof o.id === "string" && o.id && (o.status === "unresolved" || o.status === "settled") && o.args && typeof o.args === "object") {
    return { op: o as unknown as T };
  }
  return {
    unreadable: {
      key: row.key, raw, reason: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? "unknown-format" : "unparseable",
      claimed: { name: strOrNull(o.name), scope: strOrNull(o.scope), orgId: strOrNull(o.orgId), userId: strOrNull(o.userId), backendOrigin: strOrNull(o.backendOrigin), version: o.v ?? null },
    },
  };
}

/** In an export / count scoped to `orgId`: a record that does not CLAIM
 *  another organisation (its own is unknown) is included. */
export const unreadableInScope = (r: UnreadableOnlineRecord, orgId: string | null): boolean =>
  !orgId || r.claimed.orgId === null || r.claimed.orgId === orgId;

/** A set-aside record (stored as {originalKey, raw, reason, …}) as an
 *  unreadable record for counts and exports. */
export function setAsideRecord(row: { key: string; value?: unknown }): UnreadableOnlineRecord {
  let o: Record<string, unknown> = {};
  try { o = JSON.parse(typeof row.value === "string" ? row.value : "{}") as Record<string, unknown>; } catch { /* keep the raw row */ }
  const raw = typeof o.raw === "string" ? o.raw : typeof row.value === "string" ? row.value : "";
  const inner = classifyOnlineRecord({ key: typeof o.originalKey === "string" ? o.originalKey : row.key, value: raw });
  const base = "unreadable" in inner ? inner.unreadable : { key: row.key, raw, reason: "unknown-format" as const, claimed: { name: null, scope: null, orgId: null, userId: null, backendOrigin: null, version: null } };
  return { ...base, key: row.key, setAside: true };
}
