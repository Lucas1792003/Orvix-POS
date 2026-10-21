import { localDb, type CachedAuthUser } from "../lib/localDb";

// Tiny, dependency-free helpers around the `authCache` row (see
// lib/localDb.ts) so the sync layer (outbox, delta pull, RPC helper) can
// record "we just completed an authenticated round trip" without importing
// the auth store — authStore.ts imports the data layer, so an import back
// from the data layer would be a module cycle.
//
// `cachedAt` is the clock the offline authorisation window is measured
// from (docs/selfhost-migration/phase-d/offline-authorization.md): it must
// move forward on every successful authenticated server reply, and only
// then — a failed or network-errored call never touches it.

let activeAuthId: string | null = null;

/** Set by authStore on login/restore (the Supabase auth user id), cleared
 *  on logout. Null means "no session" — touches become no-ops. */
export function setActiveAuthId(authId: string | null): void {
  activeAuthId = authId;
}

/** Record a successful authenticated server round trip. Cheap (one
 *  IndexedDB update), safe to fire-and-forget, never throws. */
export async function touchAuthCache(): Promise<void> {
  if (!activeAuthId) return;
  try {
    await localDb.authCache.update(activeAuthId, { cachedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[auth] Failed to refresh the offline auth cache timestamp:", err);
  }
}

/** Refresh the role/shop/org/permissions snapshot from a server-provided
 *  `users` row (a full load). Only ever called with data that came back
 *  from the server — never from local state — so the cached role cannot
 *  be escalated from the client. Also bumps `cachedAt`. */
export async function refreshAuthCacheSnapshot(
  user: Pick<CachedAuthUser, "role" | "shopId" | "orgId" | "isActive" | "grantedPermissions" | "revokedPermissions">,
): Promise<void> {
  if (!activeAuthId) return;
  try {
    await localDb.authCache.update(activeAuthId, {
      role: user.role,
      shopId: user.shopId,
      orgId: user.orgId,
      isActive: user.isActive,
      grantedPermissions: user.grantedPermissions,
      revokedPermissions: user.revokedPermissions,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[auth] Failed to refresh the offline auth cache snapshot:", err);
  }
}
