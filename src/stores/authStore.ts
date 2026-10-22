import { create } from "zustand";
import { supabase } from "../lib/supabase";
import { OFFLINE_AUTHORIZATION_ERROR } from "../lib/errors";
import { classifyFailure, signalOf } from "../lib/failureClass";
import { localDb, SYNC_STATE_KEYS, type CachedAuthUser } from "../lib/localDb";
import { setActiveAuthId } from "./authCache";
import { createBootstrapAccount } from "../lib/staffAdmin";

export interface LoginResult {
  error: string | null;
  role?: string;
  shopId?: string;
  /** Set when the sign-in itself worked but this install has no app users
   *  yet — the login page points the operator at the explicit /setup page. */
  setupNeeded?: boolean;
}

export interface SetupStatus {
  /** True only when the server confirmed `users` is empty (migration 067). */
  needed: boolean;
  /** Why the check could not be made — the UI must NOT offer setup then. */
  error: string | null;
}

interface RequestCodeResult {
  error: string | null;
  expiresAt?: string;
  email?: string;
}

interface EnrollTotpResult {
  error: string | null;
  factorId?: string;
  qrCode?: string;
  secret?: string;
  uri?: string;
}

// A registered authenticator (TOTP) factor, as shown on the Security page.
export interface TotpFactor {
  id: string;
  friendlyName?: string;
  status: "verified" | "unverified";
  createdAt: string;
  updatedAt: string;
  lastChallengedAt?: string;
}

interface AuthState {
  currentUserId: string | null;
  // Role of the signed-in user, captured at login/restore so route guards can
  // gate the admin verification step before the data store's users are loaded.
  currentRole: string | null;
  // Migration 059, Phase 1 of multi-tenant: captured at login/restore like
  // currentRole, but nothing reads it yet — no RLS/RPC enforces org
  // scoping today (single org in production). Exists now so later phases
  // don't have to add auth-store plumbing under pressure.
  currentOrgId: string | null;
  // True once an ADMIN has passed verification this session — via TOTP (the
  // Supabase session is aal2) OR the emailed code. Always true for non-admins.
  adminVerified: boolean;
  // Whether the signed-in admin has a verified authenticator-app (TOTP) factor.
  // Drives whether the verify page asks for the app code or the email code.
  hasTotp: boolean;
  isAuthLoading: boolean;
  /** Password sign-in ONLY. Never creates an auth account: a failed sign-in
   *  returns GoTrue's message as-is. (Phase G — the previous implicit
   *  sign-up fallback created an orphan user on the hosted project.) */
  login: (email: string, password: string) => Promise<LoginResult>;
  /** The explicit first-admin bootstrap behind the /setup page: refuses
   *  unless app_setup_needed() says the install has no users, then creates
   *  (or signs in to) the auth account and calls bootstrap_first_admin()
   *  (migration 076), which creates the first organization + ADMIN row
   *  atomically server-side. The auth account itself is created by the
   *  staff-admin Edge Function (bootstrap_account) — the app never uses
   *  GoTrue's public sign-up, so the backend can disable it. */
  bootstrapFirstAdmin: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  restoreSession: () => Promise<void>;
  // Admin 2FA — email path: send a code, then verify it.
  requestAdminCode: () => Promise<RequestCodeResult>;
  verifyAdminCode: (code: string) => Promise<{ error: string | null }>;
  // Admin 2FA — authenticator-app (TOTP) path via Supabase built-in MFA.
  listTotpFactors: () => Promise<{ error: string | null; factors: TotpFactor[] }>;
  enrollTotp: (friendlyName?: string) => Promise<EnrollTotpResult>;
  verifyTotpEnrollment: (factorId: string, code: string) => Promise<{ error: string | null }>;
  verifyTotpLogin: (code: string) => Promise<{ error: string | null }>;
  unenrollTotp: (factorId: string) => Promise<{ error: string | null }>;
}

// Read the user's current MFA posture: whether they have a verified TOTP factor
// and whether this session has already stepped up to aal2 (TOTP passed).
async function readMfaState(): Promise<{ hasTotp: boolean; isAal2: boolean }> {
  try {
    const [factorsRes, aalRes] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    const hasTotp = (factorsRes.data?.totp ?? []).some((f) => f.status === "verified");
    const isAal2 = aalRes.data?.currentLevel === "aal2";
    return { hasTotp, isAal2 };
  } catch {
    return { hasTotp: false, isAal2: false };
  }
}

async function listTotpFactorRows(): Promise<{ error: string | null; factors: TotpFactor[] }> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) return { error: error.message, factors: [] };
  const factors = (data?.all ?? [])
    .filter((factor) => factor.factor_type === "totp")
    .map((factor) => ({
      id: factor.id,
      friendlyName: factor.friendly_name,
      status: factor.status,
      createdAt: factor.created_at,
      updatedAt: factor.updated_at,
      lastChallengedAt: factor.last_challenged_at,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { error: null, factors };
}

// Per-browser-session "this admin already passed the code" marker. sessionStorage
// survives a refresh but clears when the browser/tab closes — so a returning
// session re-verifies, a refresh does not. Stores the auth user id it applies to.
const VERIFIED_KEY = "shwe_admin_verified";
const safeSession = (): Storage | null =>
  typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
const isVerifiedThisSession = (authId: string | undefined): boolean =>
  Boolean(authId) && safeSession()?.getItem(VERIFIED_KEY) === authId;
const markVerified = (authId: string) => safeSession()?.setItem(VERIFIED_KEY, authId);
const clearVerified = () => safeSession()?.removeItem(VERIFIED_KEY);

// Invoke the admin-2fa edge function, surfacing the JSON error body that comes
// back on a non-2xx response (otherwise supabase-js only gives a generic message).
async function invokeAdmin2fa(
  payload: { action: "request" | "verify"; code?: string },
): Promise<{ error: string | null; data: Record<string, unknown> | null }> {
  const { data, error } = await supabase.functions.invoke<Record<string, unknown>>("admin-2fa", {
    body: payload,
  });
  if (error) {
    let message = error.message;
    const ctx = (error as { context?: unknown }).context;
    if (ctx && typeof (ctx as Response).json === "function") {
      try {
        const parsed = await (ctx as Response).json();
        if (parsed?.error) message = String(parsed.error);
      } catch {
        /* keep the generic message */
      }
    }
    return { error: message, data: null };
  }
  return { error: null, data: data ?? null };
}

// App `users` row shape used during auth resolution.
interface AppUserRow {
  id: string;
  role: string;
  shop_id: string | null;
  org_id: string;
  is_active: boolean;
  auth_id: string | null;
  granted_permissions?: string[] | null;
  revoked_permissions?: string[] | null;
}

interface ResolveResult {
  user?: AppUserRow;
  error?: string;
  /** The failure itself, with its HTTP status (B-25): classified by
   *  lib/failureClass.ts, not by its message text. */
  cause?: unknown;
}

const USER_FIELDS = "id, role, shop_id, org_id, is_active, auth_id, granted_permissions, revoked_permissions";

// Escape LIKE wildcards so emails containing _ or % match literally.
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Resolve the app `users` row for an authenticated Supabase user.
 *
 * Trusted path: match on `auth_id` (the identity link).
 * Fallback path: match on email for rows not yet linked, then self-heal by
 *   writing `auth_id` so future logins use the trusted path.
 *
 * Edge cases handled:
 *  - no app row found            -> { } (caller decides: first-admin vs orphan)
 *  - duplicate email             -> { error }
 *  - email row linked elsewhere  -> { error }
 */
/**
 * Can a failed users lookup fall back to the last-known cached resolution?
 * Only when the server was unreachable or temporarily failing (network,
 * gateway, 5xx, 52x, 429 — B-25: these used to sign the cashier out because
 * only the message text was checked). Never for rejected credentials, a
 * suspended organisation or a definitive refusal.
 */
export function mayUseCachedUser(cause: unknown): boolean {
  const failure = classifyFailure(signalOf(cause));
  if (failure.hold === "reauth" || failure.hold === "suspended") return false;
  return failure.retryable && failure.klass !== "WAITING_BACKEND";
}

async function resolveAppUser(authUser: { id: string; email?: string }): Promise<ResolveResult> {
  // 1. Trusted identity link.
  const byAuthId = await supabase
    .from("users")
    .select(USER_FIELDS)
    .eq("auth_id", authUser.id)
    .maybeSingle();
  if (byAuthId.error) return { error: byAuthId.error.message, cause: { ...byAuthId.error, status: byAuthId.status } };
  if (byAuthId.data) return { user: byAuthId.data as AppUserRow };

  // 2. Fallback: email match for un-migrated rows.
  if (!authUser.email) return {};
  const byEmail = await supabase
    .from("users")
    .select(USER_FIELDS)
    .ilike("email", escapeLike(authUser.email));
  if (byEmail.error) return { error: byEmail.error.message, cause: { ...byEmail.error, status: byEmail.status } };

  const rows = (byEmail.data ?? []) as AppUserRow[];
  if (rows.length === 0) return {};
  if (rows.length > 1) {
    return { error: "Multiple staff profiles share this email. Contact an administrator." };
  }

  const row = rows[0];
  if (row.auth_id && row.auth_id !== authUser.id) {
    return { error: "This staff profile is linked to a different account. Contact an administrator." };
  }

  // Self-healing link: write auth_id once (guarded against a concurrent link).
  if (!row.auth_id) {
    const link = await supabase
      .from("users")
      .update({ auth_id: authUser.id })
      .eq("id", row.id)
      .is("auth_id", null);
    if (link.error) console.error("[auth] auth_id link failed:", link.error.message);
    else row.auth_id = authUser.id;
  }

  return { user: row };
}

// How long a device trusts its last-known login for *read-only* use while
// it can't reach the network to re-verify, measured from the last
// successful authenticated server round trip (`authCache.cachedAt`, see
// stores/authCache.ts). A deactivated/reassigned user's access still lapses
// within a day, not indefinitely. See
// docs/selfhost-migration/phase-d/offline-authorization.md.
export const OFFLINE_SESSION_TRUST_MS = 24 * 60 * 60 * 1000;

async function cacheAppUser(authId: string, user: AppUserRow, hasTotp: boolean): Promise<void> {
  try {
    await localDb.authCache.put({
      authId, userId: user.id, role: user.role, shopId: user.shop_id, orgId: user.org_id,
      isActive: user.is_active, hasTotp,
      grantedPermissions: user.granted_permissions ?? undefined,
      revokedPermissions: user.revoked_permissions ?? undefined,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[auth] Failed to cache the resolved user for offline restore:", err);
  }
}

// Returns the cached user only if it's still within the trust window —
// past that, prefer today's "log out" behavior over trusting a
// potentially-stale role/active flag indefinitely.
async function getCachedAppUser(authId: string): Promise<CachedAuthUser | undefined> {
  try {
    const cached = await localDb.authCache.get(authId);
    if (!cached) return undefined;
    const age = Date.now() - Date.parse(cached.cachedAt);
    return age <= OFFLINE_SESSION_TRUST_MS ? cached : undefined;
  } catch (err) {
    console.error("[auth] Failed to read the cached offline user:", err);
    return undefined;
  }
}

// Shorter than OFFLINE_SESSION_TRUST_MS above, and governs a different
// thing: OFFLINE_SESSION_TRUST_MS decides whether a device stays logged in
// to browse cached data offline (fine to be generous — a connectivity blip
// shouldn't log anyone out mid-shift). This window decides whether it may
// keep performing *new* writes offline (stock adjustments, sales, shift
// open/close, transfers, refund/void requests, supplier payments) — a
// deactivated/revoked account should stop being able to do that before
// the read-only session itself expires, since each of those is a
// real-world action (cash taken, stock moved) that only the eventual
// outbox sync would otherwise catch.
//
// Measured from the last successful authenticated round trip (refreshed
// on every full load, delta pull and RPC reply — not just at boot/login),
// so it is effectively "time since the connection was lost". 12 h covers
// a full trading day with the link lost at opening, while still forcing a
// re-validation before the next day; the server re-validates every
// replayed RPC regardless. Rationale and trade-offs:
// docs/selfhost-migration/phase-d/offline-authorization.md §2.
export const OFFLINE_WRITE_TRUST_MS = 12 * 60 * 60 * 1000;

/**
 * Guard called as the first line of every offline-write function (the
 * *Offline variants in src/stores/data/slices/*.ts, before any local
 * optimistic write happens) — throws if this device hasn't confirmed its
 * identity against the live server within OFFLINE_WRITE_TRUST_MS, or if the
 * server has explicitly rejected its session (needs-reauth, see
 * stores/data/outbox.ts). Reads the same authCache row cacheAppUser()
 * populates and the sync layer keeps fresh, so a deactivated/revoked
 * account stops being able to queue new offline activity well before the
 * longer read-only session window lapses. Read-only browsing of
 * already-cached data is unaffected — this only gates new writes, and the
 * queue of already-recorded activity is never touched.
 *
 * This is a UX/latency control, not the security boundary: every replayed
 * RPC is re-validated server-side (current_app_user(), p_expected_actor_id).
 */
export async function assertOfflineWriteEligible(): Promise<void> {
  // Checked before the session: when the server has rejected the refresh
  // token, supabase-js has already dropped the session, and "sign in again"
  // is the actionable message, not "not authenticated".
  const needsReauth = (await localDb.syncState.get(SYNC_STATE_KEYS.needsReauth))?.flag === true;
  if (needsReauth) {
    throw new OfflineAuthorizationError("Your sign-in has expired. Sign in again to continue — queued activity is kept.");
  }
  const { data } = await supabase.auth.getSession();
  const authId = data.session?.user.id;
  if (!authId) throw new OfflineAuthorizationError("Not authenticated.");
  const cached = await localDb.authCache.get(authId);
  const age = cached ? Date.now() - Date.parse(cached.cachedAt) : Infinity;
  if (age > OFFLINE_WRITE_TRUST_MS) {
    const hours = Math.round(OFFLINE_WRITE_TRUST_MS / 3_600_000);
    throw new OfflineAuthorizationError(
      `This device has been offline for more than ${hours} hours. Reconnect to the internet to verify your sign-in before recording new offline activity — anything already queued is kept and will sync.`,
    );
  }
}

/** Thrown by assertOfflineWriteEligible(). Carries a message written for
 *  the cashier; lib/errors.ts's getErrorMessage() shows it verbatim
 *  instead of mapping it to the generic "Network error" text it would
 *  otherwise pick while the device is offline (Phase E finding). */
export class OfflineAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = OFFLINE_AUTHORIZATION_ERROR;
  }
}

/**
 * Ask the server whether first-time setup is still needed — i.e. whether
 * the `users` table is empty — through the read-only SECURITY DEFINER RPC
 * from migration 067, which anon may execute. Fails CLOSED: any error
 * (function not deployed yet, network, RLS) reports `needed: false` with the
 * reason, so the UI never offers to create an administrator on a backend it
 * could not actually confirm is empty.
 */
export async function isAppSetupNeeded(): Promise<SetupStatus> {
  try {
    const { data, error } = await supabase.rpc("app_setup_needed");
    if (error) return { needed: false, error: error.message };
    return { needed: data === true, error: null };
  } catch (err) {
    return { needed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const SETUP_ALREADY_DONE = "Setup has already been completed on this backend. Sign in with your existing account instead.";

/** The jsonb returned by bootstrap_first_admin() (migration 076). */
function parseBootstrapResult(data: unknown): { userId: string; orgId: string } | null {
  if (!data || typeof data !== "object") return null;
  const { userId, orgId, role } = data as Record<string, unknown>;
  if (typeof userId !== "string" || typeof orgId !== "string" || role !== "ADMIN") return null;
  return { userId, orgId };
}

export const useAuthStore = create<AuthState>()((set) => ({
  currentUserId: null,
  currentRole: null,
  currentOrgId: null,
  adminVerified: false,
  hasTotp: false,
  isAuthLoading: true,

  restoreSession: async () => {
    // getSession() reads the already-persisted Supabase session locally —
    // no network needed for this part even when offline.
    const { data } = await supabase.auth.getSession();
    const authUser = data.session?.user;
    if (!authUser) {
      setActiveAuthId(null);
      set({ currentUserId: null, currentRole: null, currentOrgId: null, adminVerified: false, hasTotp: false, isAuthLoading: false });
      return;
    }
    setActiveAuthId(authUser.id);

    let result: ResolveResult;
    try {
      result = await resolveAppUser({ id: authUser.id, email: authUser.email ?? undefined });
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err), cause: err };
    }

    let user = result.user;
    let fromCache = false;
    let cachedHasTotp = false;

    // A valid Supabase session exists but we couldn't reach `users` to
    // confirm the role/active flag — fall back to the last-known-good
    // resolution instead of treating this as "not logged in" (that would
    // log a cashier out of an otherwise fully offline-capable till). A
    // genuine, non-network error (e.g. RLS/data problem) still logs the
    // failure and does NOT fall back, since that's not a connectivity issue.
    if (!user && result.error) {
      if (mayUseCachedUser(result.cause ?? result.error)) {
        const cached = await getCachedAppUser(authUser.id);
        if (cached) {
          user = {
            id: cached.userId, role: cached.role, shop_id: cached.shopId,
            org_id: cached.orgId ?? "", is_active: cached.isActive, auth_id: authUser.id,
          };
          fromCache = true;
          cachedHasTotp = cached.hasTotp;
        }
      } else {
        console.error("[auth] restoreSession:", result.error);
      }
    }

    const active = Boolean(user && user.is_active);
    const isAdmin = active && user!.role === "ADMIN";
    // Offline, there's no way to reach Supabase's MFA endpoints to confirm a
    // fresh aal2 step-up — reuse the last-known hasTotp and rely on
    // isVerifiedThisSession() below (this session's own prior verification,
    // if any) rather than claiming a step-up that didn't happen.
    const { hasTotp, isAal2 } = !isAdmin
      ? { hasTotp: false, isAal2: false }
      : fromCache
        ? { hasTotp: cachedHasTotp, isAal2: false }
        : await readMfaState();
    set({
      currentUserId: active ? user!.id : null,
      currentRole: active ? user!.role : null,
      currentOrgId: active ? user!.org_id : null,
      hasTotp,
      // Admin is verified if the session is aal2 (TOTP) or the email flag is set.
      adminVerified: isAdmin ? isAal2 || isVerifiedThisSession(authUser.id) : true,
      isAuthLoading: false,
    });

    if (user && !fromCache) void cacheAppUser(authUser.id, user, hasTotp);
  },

  login: async (email, password) => {
    // Sign in, and nothing else. A failed password sign-in is reported with
    // GoTrue's own message and the call ends here — the previous "maybe this
    // is the very first user" sign-up fallback is gone (Phase G: it created
    // an orphan auth user on the hosted project; see
    // docs/selfhost-migration/phase-g/login-signup-fix.md). First-time setup
    // is the explicit bootstrapFirstAdmin() action behind /setup.
    const authResult = await supabase.auth.signInWithPassword({ email, password });
    if (authResult.error) return { error: authResult.error.message };

    const authUser = authResult.data.user;
    if (!authUser) return { error: "Authentication failed." };
    setActiveAuthId(authUser.id);

    const result = await resolveAppUser({ id: authUser.id, email: authUser.email ?? undefined });
    if (result.error) {
      await supabase.auth.signOut();
      return { error: result.error };
    }

    // No app `users` row linked to this auth account. Either the install has
    // no users at all yet (point at /setup — the row is created there, never
    // here) or this is an orphan auth account that an admin must link.
    // Decided by the server (app_setup_needed(), migration 067 — an
    // unfiltered count), NOT by reading `users` here: since 069 that read is
    // org-scoped by RLS, so an orphan sees zero rows on a populated install
    // and would be sent to /setup. A failed check counts as "not empty"
    // (fail closed: never offer setup on doubt).
    if (!result.user) {
      const setup = await isAppSetupNeeded();
      await supabase.auth.signOut();
      setActiveAuthId(null);
      if (setup.needed) {
        return {
          error: "This installation has no staff profiles yet. Run first-time setup to create the first administrator.",
          setupNeeded: true,
        };
      }
      return { error: "No staff profile is linked to this account. Contact an administrator." };
    }

    const user = result.user;
    if (!user.is_active) {
      await supabase.auth.signOut();
      return { error: "Account is inactive. Contact your administrator." };
    }

    const isAdmin = user.role === "ADMIN";
    const { hasTotp, isAal2 } = isAdmin ? await readMfaState() : { hasTotp: false, isAal2: false };
    // A fresh sign-in always re-reads the server (same reset as logout()).
    // The till's mirror may hold another account's RLS view - e.g. the reload
    // done while a just-DEACTIVATED cashier was still signed in, which since
    // 069 (users_sel / catalog scoped by app_org_id(), NULL for an inactive
    // account) is EMPTY - and the till can reach /login without logout()
    // (route guard). With isLoaded left true AppLayout never reloaded and the
    // route guards bounced the new user back to /login.
    const { useDataStore } = await import("./dataStore");
    useDataStore.setState({ isLoaded: false, isLoading: false, loadError: null });
    set({
      currentUserId: user.id,
      currentRole: user.role,
      currentOrgId: user.org_id,
      hasTotp,
      adminVerified: isAdmin ? isAal2 || isVerifiedThisSession(authUser.id) : true,
    });
    void cacheAppUser(authUser.id, user, hasTotp);
    // A sign-in the server just accepted supersedes any earlier "sign in again" flag: it may have been written by the
    // PREVIOUS session (a load or drain that finished after sign-out), and nothing else clears it when the queue is empty
    // (AppLayout is not mounted on /login; the drain returns before its session check) — while it stays set, offline
    // selling and the periodic drain are off (Step 6, review 2 finding 3a).
    try {
      const { clearNeedsReauth } = await import("./data/outbox");
      await clearNeedsReauth();
    } catch { /* the drain's own session check clears it later */ }
    return { error: null, role: user.role, shopId: user.shop_id ?? undefined };
  },

  bootstrapFirstAdmin: async (email, password) => {
    // 1. The server must say setup is needed (migration 067). Any doubt —
    //    RPC missing, network, RLS — refuses; nothing is created on a
    //    backend this client could not confirm is empty.
    const status = await isAppSetupNeeded();
    if (status.error) {
      return { error: `Could not confirm that first-time setup is needed: ${status.error}` };
    }
    if (!status.needed) return { error: SETUP_ALREADY_DONE };

    // 2. The auth account. Sign in first (the account may already exist —
    //    e.g. created through the auth admin API, or an earlier attempt that
    //    stopped before the users row); only when that fails, ask the server
    //    to create it: the staff-admin function (bootstrap_account) creates a
    //    confirmed account with the GoTrue admin API, and only while
    //    app_setup_needed() is true and no organization exists. The app never
    //    calls GoTrue's public sign-up endpoint (it is disabled on the
    //    self-hosted backend).
    let authResult = await supabase.auth.signInWithPassword({ email, password });
    if (authResult.error) {
      const createError = await createBootstrapAccount(email, password);
      if (createError) return { error: createError };
      authResult = await supabase.auth.signInWithPassword({ email, password });
      if (authResult.error) return { error: authResult.error.message };
    }
    const authUser = authResult.data.user;
    if (!authUser) return { error: "Authentication failed." };
    setActiveAuthId(authUser.id);

    // 3. Re-check with the server's unfiltered answer (not an RLS-scoped
    //    `users` read, which an orphan session sees as empty). Advisory only:
    //    the authoritative check is repeated inside bootstrap_first_admin()
    //    under an install-wide lock.
    const recheck = await isAppSetupNeeded();
    if (recheck.error || !recheck.needed) {
      await supabase.auth.signOut();
      setActiveAuthId(null);
      return {
        error: recheck.error
          ? `Could not confirm that first-time setup is needed: ${recheck.error}`
          : SETUP_ALREADY_DONE,
      };
    }

    // 4. First-time setup, atomically on the server (migration 076): one
    //    transaction under an install-wide advisory lock re-checks that no
    //    app user exists, then creates the first organization (+ its
    //    business_profile) and the ADMIN row linked by auth_id. Two operators
    //    racing on a fresh install get exactly one organization and one
    //    ADMIN; the loser is refused with SETUP_ALREADY_COMPLETED. The
    //    organizations / users INSERT policies no longer allow a bootstrap
    //    from the client, so this RPC is the only path.
    const { data, error } = await supabase.rpc("bootstrap_first_admin");
    const created = parseBootstrapResult(data);
    if (error || !created) {
      await supabase.auth.signOut();
      setActiveAuthId(null);
      if (error?.message.includes("SETUP_ALREADY_COMPLETED")) return { error: SETUP_ALREADY_DONE };
      return { error: error?.message ?? "First-time setup returned no administrator." };
    }
    const { userId: adminId, orgId } = created;
    // First admin must still verify (no factor yet → email path).
    set({ currentUserId: adminId, currentRole: "ADMIN", currentOrgId: orgId, adminVerified: false, hasTotp: false });
    void cacheAppUser(authUser.id, { id: adminId, role: "ADMIN", shop_id: null, org_id: orgId, is_active: true, auth_id: authUser.id }, false);
    return { error: null, role: "ADMIN" };
  },

  logout: async () => {
    const { data } = await supabase.auth.getSession();
    const authId = data.session?.user.id;
    await supabase.auth.signOut();
    clearVerified();
    setActiveAuthId(null);
    // The outbox (and its needs-reauth flag) is deliberately NOT cleared:
    // queued activity is real till activity and drains after the next
    // sign-in — see docs/selfhost-migration/phase-d/offline-authorization.md.
    if (authId) void localDb.authCache.delete(authId);
    set({ currentUserId: null, currentRole: null, currentOrgId: null, adminVerified: false, hasTotp: false });
    // Clear the shared data mirror immediately so a different user logging
    // in right after (no connectivity gap in between, so no offline→online
    // trigger fires) can't briefly render the previous user's cached
    // cross-shop data. AppLayout's loadData effect re-fires on the next
    // render since it depends on `isLoaded`. Dynamic import: purchaseSlice.ts
    // already imports authStore, so a static import here would create a
    // module cycle (authStore -> dataStore -> data/index -> purchaseSlice
    // -> authStore).
    const { useDataStore } = await import("./dataStore");
    useDataStore.setState({ isLoaded: false, isLoading: false, loadError: null });
    // P-4 / fix 3: purchase cost, purchase-order and supplier-payment money
    // and audit messages must not outlive the session that was allowed to
    // see them (the next person on this device may not be). In memory they
    // go; on disk only those fields of rows the server sent are removed —
    // offline sales, queued operations (their rows included), the outbox and
    // the journal stay. A load still running for this session is discarded
    // (stores/data/index.ts), so it cannot write them back.
    const { stripProductCost, stripUnitCost, stripLineCost } = await import("./data/costPrivacy");
    const { NO_VIEWER, scrubLocalSensitiveCache } = await import("./data/sensitiveCache");
    useDataStore.setState((s) => ({
      products: s.products.map(stripProductCost),
      productUnits: s.productUnits.map(stripUnitCost),
      saleItems: s.saleItems.map(stripLineCost),
      purchaseOrders: [], purchaseOrderItems: [], supplierPayments: [], auditLogs: [],
    }));
    await scrubLocalSensitiveCache(NO_VIEWER).catch((err) => console.error("[auth] sensitive cache scrub on logout failed:", err));
  },

  requestAdminCode: async () => {
    const { error, data } = await invokeAdmin2fa({ action: "request" });
    if (error) return { error };
    return {
      error: null,
      expiresAt: typeof data?.expiresAt === "string" ? data.expiresAt : undefined,
      email: typeof data?.email === "string" ? data.email : undefined,
    };
  },

  verifyAdminCode: async (code: string) => {
    const { error, data } = await invokeAdmin2fa({ action: "verify", code });
    if (error) return { error };
    if (!data?.verified) return { error: "Verification failed. Try again." };
    const { data: sessionData } = await supabase.auth.getSession();
    const authId = sessionData.session?.user.id;
    if (authId) markVerified(authId);
    set({ adminVerified: true });
    return { error: null };
  },

  listTotpFactors: listTotpFactorRows,

  // Start TOTP enrollment: returns the QR + secret to show the admin.
  // `issuer` is the label authenticator apps show as the account title — set it
  // to the brand so the entry reads "Shwe PhaLar", not the site URL.
  enrollTotp: async (friendlyName?: string) => {
    const name = friendlyName?.trim();
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      issuer: "Shwe PhaLar",
      ...(name ? { friendlyName: name } : {}),
    });
    if (error) return { error: error.message };
    return {
      error: null,
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    };
  },

  // Confirm enrollment with the first app code; success upgrades the session
  // to aal2 and marks the admin verified for this session.
  verifyTotpEnrollment: async (factorId: string, code: string) => {
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error) return { error: challenge.error.message };
    const verify = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code,
    });
    if (verify.error) return { error: verify.error.message };
    set({ adminVerified: true, hasTotp: true });
    return { error: null };
  },

  // Step up an existing verified factor at login time.
  verifyTotpLogin: async (code: string) => {
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) return { error: listError.message };
    const verifiedFactors = (factors?.totp ?? []).filter((f) => f.status === "verified");
    if (verifiedFactors.length === 0) return { error: "No authenticator app is set up." };

    let lastError = "Incorrect code. Check your authenticator app and try again.";
    for (const factor of verifiedFactors) {
      const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id });
      if (challenge.error) {
        lastError = challenge.error.message;
        continue;
      }
      const verify = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.data.id,
        code,
      });
      if (!verify.error) {
        set({ adminVerified: true });
        return { error: null };
      }
      lastError = verify.error.message || lastError;
    }
    return { error: lastError };
  },

  unenrollTotp: async (factorId: string) => {
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) return { error: error.message };
    const { factors } = await listTotpFactorRows();
    set({ hasTotp: factors.some((factor) => factor.status === "verified") });
    return { error: null };
  },
}));
