import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Step 6 regression (review 2, finding 3a/3b): a "sign in again" (needs-reauth) flag left by an EARLIER session — e.g. a
// load or drain of the previous user that finished after sign-out — survived a fresh, server-accepted sign-in whenever the
// queue was empty (nothing else clears it: AppLayout is not mounted on /login, the drain returns before its session check).
// While set it disables offline selling and the periodic drain. A sign-in the server accepted supersedes it.

const signInWithPassword = vi.fn();
vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      mfa: { listFactors: vi.fn(), getAuthenticatorAssuranceLevel: vi.fn() },
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    rpc: vi.fn(),
    from: (table: string) => {
      if (table !== "users") throw new Error(`unexpected table ${table}`);
      const row = { id: "user-c1", auth_id: "auth-c1", email: "cashier@shop.test", role: "CASHIER", is_active: true, org_id: "org-1", shop_id: "shop-1", name: "C" };
      const q = { eq: () => q, ilike: () => q, limit: () => q, maybeSingle: () => Promise.resolve({ data: row, error: null }),
        single: () => Promise.resolve({ data: row, error: null }), then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [row], error: null }).then(r) };
      return { select: () => q };
    },
  },
}));

import { useAuthStore } from "./authStore";
import { useSyncStore } from "./syncStore";
import { localDb, SYNC_STATE_KEYS } from "../lib/localDb";

beforeEach(async () => {
  signInWithPassword.mockReset();
  await localDb.syncState.put({ key: SYNC_STATE_KEYS.needsReauth, flag: true, reason: "left by the previous session", updatedAt: new Date().toISOString() });
  useSyncStore.getState().setStatus({ needsReauth: true });
});

describe("a fresh sign-in clears a stale needs-reauth flag", () => {
  it("a server-accepted password sign-in clears the persisted flag and the banner state", async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: { id: "auth-c1", email: "cashier@shop.test" } }, error: null });
    const r = await useAuthStore.getState().login("cashier@shop.test", "pw");
    expect(r.error).toBeNull();
    expect((await localDb.syncState.get(SYNC_STATE_KEYS.needsReauth))?.flag).toBeUndefined();
    expect(useSyncStore.getState().needsReauth).toBe(false);
  });

  it("a refused sign-in leaves the flag as it was", async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } });
    await useAuthStore.getState().login("cashier@shop.test", "wrong");
    expect((await localDb.syncState.get(SYNC_STATE_KEYS.needsReauth))?.flag).toBe(true);
  });
});
