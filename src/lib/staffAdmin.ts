// Client for the `staff-admin` Edge Function (supabase/functions/staff-admin,
// docs/selfhost-migration/phase-f/staff-creation.md). Every auth account the
// app creates goes through the server now — the browser never calls GoTrue's
// public sign-up endpoint, so the backend can run with sign-up disabled.
import type { Role, User } from "../types";

export const STAFF_ADMIN_FUNCTION = "staff-admin";
/** Mirrors PASSWORD_MIN / PASSWORD_MAX in the function. */
export const STAFF_PASSWORD_MIN = 8;
export const STAFF_PASSWORD_MAX = 72;

export interface StaffAdminResult {
  status: number;
  body: Record<string, unknown> | null;
}
export type StaffAdminCall = (payload: Record<string, unknown>) => Promise<StaffAdminResult>;

/** Default transport: supabase.functions.invoke (sends the session JWT, or the anon key before sign-in). */
export const invokeStaffAdmin: StaffAdminCall = async (payload) => {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.functions.invoke(STAFF_ADMIN_FUNCTION, { body: payload });
  if (!error) return { status: 200, body: (data ?? null) as Record<string, unknown> | null };
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    const body = await context.json().catch(() => null);
    return { status: context.status, body };
  }
  throw new Error("Network error. Please check your connection and try again.");
};

/** Error thrown by createStaffAccount(); `code` carries the Postgres code of a
 *  business-rule refusal (P0001 / 23505 / 23P01) so mapUserFormError() can
 *  turn it into the Users form's own wording. */
export class StaffAdminError extends Error {
  code?: string;
  reason?: string;
  status: number;
  constructor(message: string, status: number, reason?: string, code?: string) {
    super(message);
    this.name = "StaffAdminError";
    this.status = status;
    this.reason = reason;
    this.code = code;
  }
}

export interface CreateStaffInput {
  name: string;
  email: string;
  password: string;
  role: Exclude<Role, "ADMIN">;
  shopId: string;
  /** One per form submission; a retry with the same key is answered with
   *  the row the first attempt created instead of a duplicate. */
  idempotencyKey: string;
}

/** Shown when the server has no staff-admin function at all: the hosted
 *  project (never deployed there), or a self-hosted stack before the
 *  function was synced. The function never ran, so nothing was created. */
export const STAFF_ADMIN_MISSING_MESSAGE =
  "This server cannot create staff accounts: its staff-admin service is not installed. " +
  "Nothing was created. Ask the system administrator to update the server.";
/** Any other answer that did not come from staff-admin itself (gateway
 *  error, timeout, crashed worker). The account may or may not exist; the
 *  form keeps its idempotency key, so a retry cannot create a duplicate. */
export const STAFF_ADMIN_UNCONFIRMED_MESSAGE =
  "The server did not confirm the new staff account. Check the user list, then try again " +
  "(a retry will not create a duplicate).";

/** True when the answer is staff-admin's own JSON (`{ error, code }` or `{ user }`). */
const isStaffAdminBody = (body: Record<string, unknown> | null): boolean =>
  !!body && (typeof body.error === "string" || (typeof body.user === "object" && body.user !== null));

/** Error for a response that did not come from staff-admin itself.
 *  Hosted Supabase answers an unknown function with 404 `{code:"NOT_FOUND"}`;
 *  the self-hosted edge runtime's main router with 500 `{msg:"…worker boot
 *  error…"}` (no entrypoint for the name). Both mean "function missing". */
function foreignResponseError(status: number, body: Record<string, unknown> | null): StaffAdminError {
  const msg = typeof body?.msg === "string" ? body.msg : "";
  const missing =
    status === 404 ||
    body?.code === "NOT_FOUND" ||
    /InvalidWorkerCreation|worker boot error|could not find an appropriate entrypoint/i.test(msg);
  return missing
    ? new StaffAdminError(STAFF_ADMIN_MISSING_MESSAGE, status, "function_missing")
    : new StaffAdminError(STAFF_ADMIN_UNCONFIRMED_MESSAGE, status, "unconfirmed");
}

export async function createStaffAccount(input: CreateStaffInput, call: StaffAdminCall = invokeStaffAdmin): Promise<User> {
  const { status, body } = await call({ action: "create_staff", ...input });
  const user = body?.user as User | undefined;
  if ((status === 200 || status === 201) && user && typeof user.id === "string") return user;
  if (!isStaffAdminBody(body)) throw foreignResponseError(status, body);
  const message = typeof body?.error === "string" ? body.error : "Could not create the staff account.";
  throw new StaffAdminError(
    message,
    status,
    typeof body?.code === "string" ? body.code : undefined,
    typeof body?.dbCode === "string" ? body.dbCode : undefined,
  );
}

/** First-time setup only: ask the server to create the first administrator's
 *  auth account. The server refuses unless app_setup_needed() is true and no
 *  organization exists. Returns null on success, or the message to show. */
export async function createBootstrapAccount(
  email: string,
  password: string,
  call: StaffAdminCall = invokeStaffAdmin,
): Promise<string | null> {
  try {
    const { status, body } = await call({ action: "bootstrap_account", email, password });
    if (status === 200 || status === 201) return null;
    if (typeof body?.error === "string") return body.error;
    const err = foreignResponseError(status, body);
    return err.reason === "function_missing"
      ? "This server cannot run first-time setup: its staff-admin service is not installed. Nothing was created."
      : "Could not create the administrator account.";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
