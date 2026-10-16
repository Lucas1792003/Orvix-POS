// ----------------------------------------------------------------------
// Which outbox entries were exported (saved to an encrypted .spqx file) in
// THIS app session. Memory only, on purpose: the desktop updater's
// "install after export" recovery path and dismissing a quarantined entry
// both require an export the operator made just now, not one from an
// earlier day. Dependency-free.
// ----------------------------------------------------------------------

const exported = new Set<string>();
let lastExportAt: string | null = null;
const listeners = new Set<() => void>();

/** Called by exportPendingQueue() after the file was saved / downloaded. */
export function recordQueueExport(opIds: readonly string[], at: Date = new Date()): void {
  for (const id of opIds) exported.add(id);
  lastExportAt = at.toISOString();
  for (const l of listeners) l();
}

export function wasExported(opId: string): boolean {
  return exported.has(opId);
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
