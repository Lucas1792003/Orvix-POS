import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";

// The explicit first-admin bootstrap (Phase G): bootstrapFirstAdmin() is
// the only path that may call auth.signUp(), and it refuses unless the
// server's app_setup_needed() (migration 067) says the install is empty.
// Since migration 076 the organization + ADMIN row are created atomically
// by the bootstrap_first_admin() RPC; the client never inserts them.

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
    // 076: setup never touches tables directly (no RLS-scoped users read,
    // no organizations / users inserts).
    from: (...args: unknown[]) => from(...args),
  },
}));

// rpc() routing: app_setup_needed answers come from `setupAnswers` in order;
// bootstrap_first_admin from `bootstrapAnswer`.
let setupAnswers: Array<{ data: unknown; error: { message: string } | null }> = [];
let bootstrapAnswer: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const routeRpc = () =>
  rpc.mockImplementation((fn: string) => {
    if (fn === "app_setup_needed") {
      const next = setupAnswers.shift();
      if (!next) throw new Error("unexpected extra app_setup_needed call");
      return Promise.resolve(next);
    }
    if (fn === "bootstrap_first_admin") return Promise.resolve(bootstrapAnswer);
    throw new Error(`unexpected rpc ${fn}`);
  });
const bootstrapCalls = () => rpc.mock.calls.filter(([fn]) => fn === "bootstrap_first_admin").length;
const created = { userId: "user-owner-shop-test", orgId: "org-0123abcd", role: "ADMIN", name: "owner", email: "owner@shop.test" };

import { isAppSetupNeeded, useAuthStore } from "./authStore";
import { localDb } from "../lib/localDb";

const authUser = { id: "auth-first", email: "owner@shop.test" };

beforeEach(async () => {
  for (const fn of [signInWithPassword, signUp, signOut, rpc, from]) fn.mockReset();
  from.mockImplementation((table: string) => {
    throw new Error(`setup must not access table ${table} directly`);
  });
  signOut.mockResolvedValue({ error: null });
  setupAnswers = [];
  bootstrapAnswer = { data: null, error: null };
  useAuthStore.setState({ currentUserId: null, currentRole: null, currentOrgId: null, adminVerified: false, hasTotp: false });
  await localDb.authCache.clear();
});

describe("isAppSetupNeeded()", () => {
  it("is true only when the server says so", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await isAppSetupNeeded()).toEqual({ needed: true, error: null });
    expect(rpc).toHaveBeenCalledWith("app_setup_needed");

    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await isAppSetupNeeded()).toEqual({ needed: false, error: null });
  });

  it("fails closed on an RPC error (e.g. migration 067 not deployed) or a thrown network failure", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Could not find the function public.app_setup_needed" } });
    expect(await isAppSetupNeeded()).toEqual({ needed: false, error: "Could not find the function public.app_setup_needed" });

    rpc.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await isAppSetupNeeded()).toEqual({ needed: false, error: "Failed to fetch" });
  });
});

describe("bootstrapFirstAdmin()", () => {
  it("refuses to act when the server says setup is not needed — no signUp, no sign-in, no RPC", async () => {
    setupAnswers = [{ data: false, error: null }];
    routeRpc();

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "pw123456");

    expect(result.error).toMatch(/already been completed/i);
    expect(signUp).not.toHaveBeenCalled();
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(bootstrapCalls()).toBe(0);
  });

  it("refuses to act when the setup check itself fails (fail closed)", async () => {
    setupAnswers = [{ data: null, error: { message: "Could not find the function public.app_setup_needed" } }];
    routeRpc();

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "pw123456");

    expect(result.error).toMatch(/Could not confirm that first-time setup is needed/);
    expect(signUp).not.toHaveBeenCalled();
    expect(bootstrapCalls()).toBe(0);
  });

  it("happy path on a brand-new backend: creates the auth account, then ONE bootstrap_first_admin RPC creates org + ADMIN", async () => {
    setupAnswers = [{ data: true, error: null }, { data: true, error: null }];
    bootstrapAnswer = { data: created, error: null };
    routeRpc();
    // No auth account yet: first sign-in fails, signUp creates it, second sign-in works.
    signInWithPassword
      .mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } })
      .mockResolvedValueOnce({ data: { user: authUser }, error: null });
    signUp.mockResolvedValueOnce({ data: { user: authUser }, error: null });

    const result = await useAuthStore.getState().bootstrapFirstAdmin("Owner@Shop.test", "pw123456");

    expect(result).toEqual({ error: null, role: "ADMIN" });
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(signUp).toHaveBeenCalledWith({ email: "Owner@Shop.test", password: "pw123456" });
    // the RPC takes no arguments: identity, ids and names are derived server-side
    expect(rpc).toHaveBeenCalledWith("bootstrap_first_admin");
    expect(bootstrapCalls()).toBe(1);
    expect(from).not.toHaveBeenCalled();
    const state = useAuthStore.getState();
    expect(state.currentUserId).toBe("user-owner-shop-test");
    expect(state.currentRole).toBe("ADMIN");
    expect(state.currentOrgId).toBe("org-0123abcd");
    expect(state.adminVerified).toBe(false);
    expect(signOut).not.toHaveBeenCalled();
    expect(await localDb.authCache.get(authUser.id)).toMatchObject({ userId: "user-owner-shop-test", orgId: "org-0123abcd", role: "ADMIN" });
  });

  it("reuses an existing auth account (sign-in succeeds) without calling signUp", async () => {
    setupAnswers = [{ data: true, error: null }, { data: true, error: null }];
    bootstrapAnswer = { data: created, error: null };
    routeRpc();
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "pw123456");

    expect(result.error).toBeNull();
    expect(signUp).not.toHaveBeenCalled();
    expect(bootstrapCalls()).toBe(1);
  });

  it("surfaces a signUp failure (wrong password for an existing account) and writes nothing", async () => {
    setupAnswers = [{ data: true, error: null }];
    routeRpc();
    signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: { message: "Invalid login credentials" } });
    signUp.mockResolvedValueOnce({ data: { user: null }, error: { message: "User already registered" } });

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "wrong");

    expect(result.error).toBe("User already registered");
    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    expect(bootstrapCalls()).toBe(0);
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it("re-checks with the server (not an RLS-scoped users read) and backs out if setup completed in between", async () => {
    setupAnswers = [{ data: true, error: null }, { data: false, error: null }];
    routeRpc();
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "pw123456");

    expect(result.error).toMatch(/already been completed/i);
    expect(bootstrapCalls()).toBe(0);
    expect(from).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it("backs out (fail closed) when the post-sign-in re-check errors", async () => {
    setupAnswers = [{ data: true, error: null }, { data: null, error: { message: "Failed to fetch" } }];
    routeRpc();
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "pw123456");

    expect(result.error).toBe("Could not confirm that first-time setup is needed: Failed to fetch");
    expect(bootstrapCalls()).toBe(0);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("loses the server-side race: SETUP_ALREADY_COMPLETED from the RPC maps to the 'already completed' message and signs out", async () => {
    setupAnswers = [{ data: true, error: null }, { data: true, error: null }];
    bootstrapAnswer = {
      data: null,
      error: { message: "SETUP_ALREADY_COMPLETED: first-time setup has already been completed on this install" },
    };
    routeRpc();
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "pw123456");

    expect(result.error).toMatch(/already been completed/i);
    expect(result.error).not.toMatch(/SETUP_ALREADY_COMPLETED/);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it("surfaces other RPC errors verbatim (e.g. 076 not deployed) and signs out", async () => {
    setupAnswers = [{ data: true, error: null }, { data: true, error: null }];
    bootstrapAnswer = { data: null, error: { message: "Could not find the function public.bootstrap_first_admin without parameters" } };
    routeRpc();
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "pw123456");

    expect(result.error).toBe("Could not find the function public.bootstrap_first_admin without parameters");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });

  it("rejects a malformed RPC result instead of trusting it", async () => {
    setupAnswers = [{ data: true, error: null }, { data: true, error: null }];
    bootstrapAnswer = { data: { userId: "user-x", role: "MANAGER" }, error: null };
    routeRpc();
    signInWithPassword.mockResolvedValueOnce({ data: { user: authUser }, error: null });

    const result = await useAuthStore.getState().bootstrapFirstAdmin("owner@shop.test", "pw123456");

    expect(result.error).toBe("First-time setup returned no administrator.");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().currentUserId).toBeNull();
  });
});
