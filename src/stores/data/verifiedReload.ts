// ----------------------------------------------------------------------
// Verified reload (G1 Stage 1 / migration 086). An operation the server
// confirms as COMMITTED but whose reply this till cannot read (it belongs to
// another user, or it was purged) is reconciled by reloading the server's
// own data — never by guessing the effect. Registered by the data store
// (./index.ts) so the queue modules need no import of the store.
// ----------------------------------------------------------------------

type ReloadFn = () => Promise<boolean>;
let reload: ReloadFn | null = null;

export function registerVerifiedReload(fn: ReloadFn | null): void {
  reload = fn;
}

/** Full reload from the server. True only when it completed. */
export async function verifiedReload(): Promise<boolean> {
  if (!reload) return false;
  try {
    return await reload();
  } catch (err) {
    console.error("[sync] verified reload failed:", err);
    return false;
  }
}
