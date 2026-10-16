// ----------------------------------------------------------------------
// Sync Conflicts page, "Set aside" rules (RC2, D1). Pure, so the page's
// decisions are unit-tested without a DOM (outboxSetAsidePolicy.test.ts).
// The outbox functions (stores/data/outbox.ts setAsideOutboxEntry /
// restoreSetAsideEntry) enforce the same owner + export rules again.
// ----------------------------------------------------------------------
import type { SyncOutboxEntry } from "./localDb";

export type SetAsideBlock = "not-owner" | "export-first" | "already-set-aside" | null;

/** Why "Set aside" may not run for this entry right now (null = it may,
 *  after the confirmation dialog). */
export function setAsideBlock(
  entry: Pick<SyncOutboxEntry, "localId" | "status">,
  ctx: { isOwner: boolean; wasExported: (localId: string) => boolean },
): SetAsideBlock {
  if (entry.status === "archived") return "already-set-aside";
  if (!ctx.isOwner) return "not-owner";
  if (!ctx.wasExported(entry.localId)) return "export-first";
  return null;
}

export const SET_ASIDE_BLOCK_TEXT: Record<Exclude<SetAsideBlock, null>, string> = {
  "not-owner": "Owner only. Ask the owner (administrator) to sign in on this till.",
  "export-first": "Export pending transactions first (in this session) and keep the file, then set the entry aside.",
  "already-set-aside": "This entry is already set aside.",
};

/** Text of the confirmation dialog: names exactly what will be set aside. */
export function setAsideConfirmText(entry: Pick<SyncOutboxEntry, "createdAt" | "status" | "attempts" | "idempotencyKey">, label: string, shop: string): string {
  const key = entry.idempotencyKey ? ` · key ${entry.idempotencyKey.slice(0, 8)}` : "";
  return `${label} · ${shop} · queued ${new Date(entry.createdAt).toLocaleString()} · status ${entry.status} · ${entry.attempts} attempt${entry.attempts === 1 ? "" : "s"}${key}`;
}

export const SET_ASIDE_DONE_TEXT =
  "It is no longer sent to the server, but it is NOT deleted: it stays on this till under \"Set aside\", is included in every export, " +
  "and the owner can restore it. Reconcile it from the export file.";

/**
 * One action at a time across the whole list. A second call while one is
 * running is refused (returns null) — a double click cannot act on the row
 * that moved under the pointer after the first one finished.
 */
export function createSingleFlight() {
  let running = false;
  return {
    get running() { return running; },
    async run<T>(fn: () => Promise<T>): Promise<T | null> {
      if (running) return null;
      running = true;
      try {
        return await fn();
      } finally {
        running = false;
      }
    },
  };
}
