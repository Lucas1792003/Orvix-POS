// ----------------------------------------------------------------------
// Backend origin of the till's local data (release 1.0.16, blocker D-d).
//
// v1.0.15 talks to hosted Supabase; 1.0.16 talks to the self-hosted
// backend. An auto-update from one to the other keeps the same app profile
// (same file:// origin, same IndexedDB and localStorage), so 1.0.16 finds
// data that belongs to another backend:
//   * outbox entries queued by 1.0.15 (for hosted; they carry no backend);
//   * the hosted catalogue snapshot and delta cursors;
//   * the offline auth cache and the hosted auth session
//     (localStorage `sb-<project ref>-auth-token`).
//
// Rule: an outbox entry is only ever sent to the backend it was queued for.
// So at startup, BEFORE supabase-js is created (main.tsx) and before any
// drain:
//   1. every outbox entry whose `backendOrigin` is missing or differs from
//      this build's origin is QUARANTINED: status "quarantined", never
//      sent, never retried, never deleted automatically. Staff export it
//      (queue export); the owner reconciles it (tools/queue-recovery can
//      replay it to an explicitly named target).
//   2. when the profile's recorded origin differs from this build's (or was
//      never recorded: every pre-1.0.16 profile), the backend-specific
//      caches are discarded: snapshot tables + delta cursors (the catalogue
//      is fetched fresh from the new backend), the offline auth cache, the
//      needs-sign-in / drain-lease flags, and every stored auth session
//      (sign-in on the new backend required). Device-local evidence is
//      kept: the outbox and the provisional id map are never cleared.
//   3. the origin is recorded last, so an interrupted run repeats 1-2.
// The drain (stores/data/outbox.ts) re-checks the origin of every entry
// right before sending it, so nothing depends on this having run.
//
// Dependency-free apart from the Dexie database (no supabase-js import) so
// main.tsx can run it before the client exists.
// ----------------------------------------------------------------------
import { SNAPSHOT_TABLE_NAMES, SYNC_STATE_KEYS, type LocalDb, type SyncOutboxEntry } from "./localDb";

/**
 * Origin of the backend this build talks to, from the same build-time
 * VITE_SUPABASE_URL that lib/supabase.ts validates at startup (read here
 * directly so the sync layer does not need the supabase module for it).
 * Returns "" for a missing/invalid URL: nothing then belongs to it, so
 * nothing is sent.
 */
export function currentBackendOrigin(): string {
  try {
    return new URL(String(import.meta.env.VITE_SUPABASE_URL ?? "").trim()).origin;
  } catch {
    return "";
  }
}

/** supabase-js's default storage key: `sb-<first hostname label>-auth-token`. */
export function authStorageKeyFor(url: string): string {
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

const AUTH_KEY_RE = /^sb-.+-auth-token(-code-verifier)?$/;

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

export function quarantineReasonFor(entryOrigin: string | undefined, currentOrigin: string): string {
  return entryOrigin
    ? `Queued for another server (${entryOrigin}), not for this till's server (${currentOrigin}). It was not sent. Export it and give the file to the owner.`
    : "Queued by an older app version (before 1.0.16) that did not record its server; it was meant for the previous backend. It was not sent. Export it and give the file to the owner.";
}

/** True when this build may send the entry: tagged with exactly our origin. */
export function belongsToBackend(entry: Pick<SyncOutboxEntry, "backendOrigin">, origin: string): boolean {
  return origin !== "" && typeof entry.backendOrigin === "string" && entry.backendOrigin === origin;
}

/**
 * Quarantine every outbox entry that is not tagged with `origin`. Returns
 * how many entries were newly quarantined. Idempotent; never deletes and
 * never changes an entry that belongs to this backend.
 */
export async function quarantineForeignOutboxEntries(db: LocalDb, origin: string, now: Date = new Date()): Promise<number> {
  return db.transaction("rw", db.syncOutbox, async () => {
    let n = 0;
    await db.syncOutbox.toCollection().modify((entry: SyncOutboxEntry) => {
      if (belongsToBackend(entry, origin) || entry.status === "quarantined") return;
      entry.statusBeforeQuarantine = entry.status;
      entry.status = "quarantined";
      entry.quarantinedAt = now.toISOString();
      entry.quarantineReason = quarantineReasonFor(entry.backendOrigin, origin);
      entry.nextAttemptAt = undefined;
      n += 1;
    });
    return n;
  });
}

export interface PrepareResult {
  /** The profile's data belonged to another (or an unrecorded) backend. */
  originChanged: boolean;
  previousOrigin: string | null;
  quarantined: number;
  removedAuthSessions: number;
}

/**
 * Run once at startup, before supabase-js is created. See the file header.
 * `backendUrl` is the build's VITE_SUPABASE_URL (already validated).
 */
export async function prepareLocalStateForBackend(opts: {
  db: LocalDb;
  backendUrl: string;
  storage?: StorageLike | null;
  now?: Date;
}): Promise<PrepareResult> {
  const { db } = opts;
  const now = opts.now ?? new Date();
  const origin = new URL(opts.backendUrl).origin;
  const ownAuthKey = authStorageKeyFor(opts.backendUrl);

  const marker = await db.syncState.get(SYNC_STATE_KEYS.backendOrigin);
  const previousOrigin = typeof marker?.value === "string" ? marker.value : null;
  const originChanged = previousOrigin !== origin;

  const quarantined = await quarantineForeignOutboxEntries(db, origin, now);

  if (originChanged) {
    const snapshotTables = SNAPSHOT_TABLE_NAMES.map((name) => db.table(name));
    await db.transaction("rw", [...snapshotTables, db.syncMeta, db.authCache, db.syncState], async () => {
      await Promise.all(snapshotTables.map((t) => t.clear()));
      await db.syncMeta.clear();
      await db.authCache.clear();
      await db.syncState.bulkDelete([SYNC_STATE_KEYS.needsReauth, SYNC_STATE_KEYS.drainLease]);
    });
  }

  // Auth sessions: a foreign backend's session is never ours to use; on an
  // origin change our own key is dropped too (it may predate the marker).
  let removedAuthSessions = 0;
  const storage = opts.storage ?? null;
  if (storage) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && AUTH_KEY_RE.test(k) && (originChanged || !k.startsWith(ownAuthKey))) keys.push(k);
      }
      for (const k of keys) {
        storage.removeItem(k);
        removedAuthSessions += 1;
      }
    } catch (err) {
      console.error("[boot] Could not clear stored auth sessions:", err);
    }
  }

  if (originChanged) {
    await db.syncState.put({ key: SYNC_STATE_KEYS.backendOrigin, value: origin, updatedAt: now.toISOString() });
  }

  return { originChanged, previousOrigin, quarantined, removedAuthSessions };
}
