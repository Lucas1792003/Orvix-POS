import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase F (docs/selfhost-migration/phase-f/staff-creation.md): the Users page
// creates staff through the staff-admin Edge Function. The browser must never
// call GoTrue's sign-up, never swap the admin's session, and never write the
// users row itself — the function does both server-side.

const invoke = vi.fn();
const signUp = vi.fn();
const setSession = vi.fn();
const rpc = vi.fn();
const from = vi.fn();

vi.mock("../../lib/supabase", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
    auth: {
      signUp: (...args: unknown[]) => signUp(...args),
      setSession: (...args: unknown[]) => setSession(...args),
    },
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...args),
  },
}));

import { createShopSlice } from "./slices/shopSlice";
import {
  StaffAdminError,
  STAFF_ADMIN_MISSING_MESSAGE,
  STAFF_ADMIN_UNCONFIRMED_MESSAGE,
  createBootstrapAccount,
} from "../../lib/staffAdmin";
import type { DataState } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeStore = (seed: Record<string, any> = {}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let state: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (u: any) => { state = { ...state, ...(typeof u === "function" ? u(state) : u) }; };
  const get = () => state as DataState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state = { ...(createShopSlice as any)(set, get, {}), ...seed };
  return { get };
};

const input = {
  name: "New Cashier",
  email: "new.cashier@example.test",
  password: "Correct-Horse-9",
  role: "CASHIER" as const,
  shopId: "shop-a1",
  idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e",
};
const serverUser = {
  id: "user-0f8fad5bd9cb469fa16570867728950e", name: "New Cashier", email: "new.cashier@example.test",
  role: "CASHIER", shopId: "shop-a1", authId: "00000000-0000-4000-8000-000000000001", isActive: true,
  createdAt: "2026-10-13T00:00:00Z", orgId: "org-a",
};
const httpError = (status: number, body: unknown) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify(body), { status }) },
});

beforeEach(() => {
  for (const fn of [invoke, signUp, setSession, rpc, from]) fn.mockReset();
});

describe("createStaffUser()", () => {
  it("invokes staff-admin create_staff with exactly the form payload and appends the returned user", async () => {
    invoke.mockResolvedValueOnce({ data: { user: serverUser }, error: null });
    const store = makeStore({ users: [] });

    const user = await store.get().createStaffUser(input);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("staff-admin", { body: { action: "create_staff", ...input } });
    expect(user).toEqual(serverUser);
    expect(store.get().users).toEqual([serverUser]);
    // nothing else: no sign-up, no session swap, no client-side users write
    expect(signUp).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("a replayed answer (same key) does not duplicate the user in the list", async () => {
    invoke.mockResolvedValue({ data: { user: serverUser, replayed: true }, error: null });
    const store = makeStore({ users: [serverUser] });
    await store.get().createStaffUser(input);
    expect(store.get().users).toHaveLength(1);
  });

  it("server refusals become a StaffAdminError with the server's message; nothing is added", async () => {
    invoke.mockResolvedValueOnce(httpError(403, { error: "Verify with your authenticator app before creating staff accounts.", code: "mfa_required" }));
    const store = makeStore({ users: [] });
    const err = await store.get().createStaffUser(input).catch((e) => e);
    expect(err).toBeInstanceOf(StaffAdminError);
    expect(err.message).toBe("Verify with your authenticator app before creating staff accounts.");
    expect(err.status).toBe(403);
    expect(err.reason).toBe("mfa_required");
    expect(err.code).toBeUndefined();
    expect(store.get().users).toEqual([]);
  });

  it("database business-rule refusals keep their Postgres code for the Users form mapping", async () => {
    invoke.mockResolvedValueOnce(httpError(409, { error: "Cashier must be assigned to a shop with an active manager.", code: "rejected", dbCode: "P0001" }));
    const store = makeStore({ users: [] });
    const err = await store.get().createStaffUser(input).catch((e) => e);
    expect(err.code).toBe("P0001");
    expect(err.message).toMatch(/active manager/);
  });

  // docs/selfhost-migration/phase-f/electron-compatibility.md: a build talking
  // to a backend WITHOUT staff-admin (hosted, or a stack before the function
  // was synced) must fail loudly with a clear message, never half-create.
  it("hosted without staff-admin (404 NOT_FOUND) -> clear 'not installed' error, nothing created", async () => {
    invoke.mockResolvedValueOnce(httpError(404, { code: "NOT_FOUND", message: "Requested function was not found" }));
    const store = makeStore({ users: [] });
    const err = await store.get().createStaffUser(input).catch((e) => e);
    expect(err).toBeInstanceOf(StaffAdminError);
    expect(err.reason).toBe("function_missing");
    expect(err.status).toBe(404);
    expect(err.message).toBe(STAFF_ADMIN_MISSING_MESSAGE);
    expect(err.message).toMatch(/Nothing was created/);
    expect(err.code).toBeUndefined(); // UsersPage shows err.message as-is (no Postgres mapping)
    expect(store.get().users).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(signUp).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("self-hosted edge runtime without the function (500 worker boot error) -> same 'not installed' error", async () => {
    invoke.mockResolvedValueOnce(httpError(500, {
      msg: "InvalidWorkerCreation: worker boot error: failed to bootstrap runtime: could not find an appropriate entrypoint",
    }));
    const store = makeStore({ users: [] });
    const err = await store.get().createStaffUser(input).catch((e) => e);
    expect(err.reason).toBe("function_missing");
    expect(err.message).toBe(STAFF_ADMIN_MISSING_MESSAGE);
    expect(store.get().users).toEqual([]);
  });

  it("a gateway error that staff-admin did not write (502, no JSON) -> 'not confirmed, retry is safe'", async () => {
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "Edge Function returned a non-2xx status code", context: new Response("<html>Bad Gateway</html>", { status: 502 }) },
    });
    const store = makeStore({ users: [] });
    const err = await store.get().createStaffUser(input).catch((e) => e);
    expect(err).toBeInstanceOf(StaffAdminError);
    expect(err.reason).toBe("unconfirmed");
    expect(err.status).toBe(502);
    expect(err.message).toBe(STAFF_ADMIN_UNCONFIRMED_MESSAGE);
    expect(store.get().users).toEqual([]);
  });

  it("staff-admin's own 500 (with its error text) is passed through unchanged", async () => {
    invoke.mockResolvedValueOnce(httpError(500, { error: "Could not create the account. Nothing was created.", code: "internal" }));
    const store = makeStore({ users: [] });
    const err = await store.get().createStaffUser(input).catch((e) => e);
    expect(err.reason).toBe("internal");
    expect(err.message).toBe("Could not create the account. Nothing was created.");
  });

  it("first-time setup against a server without staff-admin returns the 'not installed' message", async () => {
    const call = vi.fn().mockResolvedValue({ status: 404, body: { code: "NOT_FOUND", message: "Requested function was not found" } });
    const message = await createBootstrapAccount("owner@example.test", "Correct-Horse-9", call);
    expect(message).toMatch(/staff-admin service is not installed/);
    expect(message).toMatch(/Nothing was created/);
  });

  it("a network failure (no HTTP response) throws a network error", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { message: "Failed to send a request to the Edge Function" } });
    const store = makeStore({ users: [] });
    await expect(store.get().createStaffUser(input)).rejects.toThrow(/Network error/);
  });
});
