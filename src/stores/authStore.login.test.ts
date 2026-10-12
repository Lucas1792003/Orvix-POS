import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase G regression coverage — docs/selfhost-migration/phase-g/login-signup-fix.md.
//
// login() must ONLY sign in. The previous implementation fell through to
// supabase.auth.signUp() after any failed password sign-in (to serve the
// "very first user" case it could not detect anonymously), which is how a
// probe pointed at the hosted project created an orphan auth user there
// (evidence/G9/2026-10-12-phase-e.md "Incident"). Now a failed sign-in
// returns GoTrue's own message and never touches signUp; first-time setup
// is the explicit bootstrapFirstAdmin() action (authStore.setup.test.ts).

const signInWithPassword = vi.fn();
const signUp = vi.fn();
const signOut = vi.fn();
const rpc = vi.fn();
const from = vi.fn();

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
      signUp: (...args: unknown[]) => signUp(...args),
      signOut: (...args: unknown[]) => signOut(...args),
      mfa: { listFactors: vi.fn(), getAuthenticatorAssuranceLevel: vi.fn() },
    },
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));

import { useAuthStore } from "./authStore";

beforeEach(() => {
  signInWithPassword.mockReset();
  signUp.mockReset();
  signOut.mockReset().mockResolvedValue({ error: null });
  rpc.mockReset();
  from.mockReset().mockImplementation(() => {
    throw new Error("supabase.from should not be reached in this scenario");
  });
});

describe("login() never creates an account", () => {
  it("returns GoTrue's message for a wrong password and does not call signUp", async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } });

    const result = await useAuthStore.getState().login("admin@shop.test", "wrong-password");

    expect(result.error).toBe("Invalid login credentials");
    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    expect(signUp).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it("returns GoTrue's message for an unknown email and does not call signUp", async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } });

    const result = await useAuthStore.getState().login("nobody@shop.test", "somepassword");

    expect(result.error).toBe("Invalid login credentials");
    expect(signUp).not.toHaveBeenCalled();
  });

  it("surfaces other GoTrue failures (rate limit, confirmation required) verbatim, still without signUp", async () => {
    signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Email not confirmed" } });

    const result = await useAuthStore.getState().login("new-admin@shop.test", "somepassword");

    expect(result.error).toBe("Email not confirmed");
    expect(signUp).not.toHaveBeenCalled();
  });

  // resolveAppUser() finds no row by auth_id or email. Since 069 this is
  // ALSO what an orphan sees on a populated install (users_sel is
  // org-scoped), so the "is the install empty?" decision must come from the
  // server's unfiltered app_setup_needed() — never from a users read.
  const noLinkedRow = () =>
    from.mockImplementation((table: string) => {
      if (table !== "users") throw new Error(`unexpected table ${table}`);
      return {
        select: (fields: string) => {
          if (fields === "id") throw new Error("login must not decide setup from an RLS-scoped users read");
          return {
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
            ilike: () => Promise.resolve({ data: [], error: null }),
          };
        },
        insert: () => {
          throw new Error("login must never insert users");
        },
      };
    });

  it("does not create the first admin from the login page on an empty install — it points at /setup", async () => {
    const authUser = { id: "auth-1", email: "owner@shop.test" };
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });
    noLinkedRow();
    rpc.mockResolvedValueOnce({ data: true, error: null });

    const result = await useAuthStore.getState().login("owner@shop.test", "pw");

    expect(rpc).toHaveBeenCalledWith("app_setup_needed");
    expect(result.error).toMatch(/first-time setup/i);
    expect(result.setupNeeded).toBe(true);
    expect(signUp).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it("an orphan auth account on a POPULATED install (RLS shows it zero users) is told to contact an administrator, not sent to /setup", async () => {
    const authUser = { id: "auth-2", email: "orphan@shop.test" };
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });
    noLinkedRow();
    rpc.mockResolvedValueOnce({ data: false, error: null });

    const result = await useAuthStore.getState().login("orphan@shop.test", "pw");

    expect(rpc).toHaveBeenCalledWith("app_setup_needed");
    expect(result.error).toBe("No staff profile is linked to this account. Contact an administrator.");
    expect(result.setupNeeded).toBeUndefined();
    expect(signUp).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it("fails closed when the setup check errors: orphan message, never /setup", async () => {
    const authUser = { id: "auth-3", email: "orphan@shop.test" };
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });
    noLinkedRow();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Could not find the function public.app_setup_needed" } });

    const result = await useAuthStore.getState().login("orphan@shop.test", "pw");

    expect(result.error).toBe("No staff profile is linked to this account. Contact an administrator.");
    expect(result.setupNeeded).toBeUndefined();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
