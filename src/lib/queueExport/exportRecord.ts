// ----------------------------------------------------------------------
// Which outbox entries were exported (saved to an encrypted .spqx file) in
// THIS app session. Memory only, on purpose: the desktop updater's
// "install after export" recovery path, setting an entry aside and (RC3)
// reconciling one all require an export the operator made just now, not one
// from an earlier day. RC3 also keeps, per entry, the digest of exactly what
// was exported (lib/reconcile/digest.ts entryDigest), so a reconciliation
// can prove the file holds THIS version of the entry. Dependency-free.
// ----------------------------------------------------------------------

export interface ExportedEntryRef {
  opId: string;
  /** entryDigest of the row as exported; absent for callers that only know ids. */
  digest?: string;
}

const exported = new Map<string, { digest: string | null; at: string }>();
let lastExportAt: string | null = null;
const listeners = new Set<() => void>();

/** Called by exportPendingQueue() after the file was saved / downloaded. */
export function recordQueueExport(entries: readonly (string | ExportedEntryRef)[], at: Date = new Date()): void {
  const when = at.toISOString();
  for (const e of entries) {
    const ref = typeof e === "string" ? { opId: e } : e;
    exported.set(ref.opId, { digest: ref.digest ?? null, at: when });
  }
  lastExportAt = when;
  for (const l of listeners) l();
}

export function wasExported(opId: string): boolean {
  return exported.has(opId);
}

/** The digest and time of this session's latest export of `opId`, or null. */
export function exportedEntry(opId: string): { digest: string | null; at: string } | null {
  return exported.get(opId) ?? null;
}

/** True when every given outbox id was exported in this session (an empty
 *  queue is trivially covered). */
export function exportCovers(opIds: readonly string[]): boolean {
  return opIds.every((id) => exported.has(id));
}

export function lastQueueExportAt(): string | null {
  return lastExportAt;
}

export function onQueueExported(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function resetQueueExportRecord(): void {
  exported.clear();
  lastExportAt = null;
}
