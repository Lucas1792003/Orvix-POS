import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

// staff-admin: server-side creation of auth accounts, so GoTrue can run with
// DISABLE_SIGNUP=true (docs/selfhost-migration/phase-f/staff-creation.md).
//
// Two actions:
//
//   create_staff       an org's ADMIN (or a user granted `user:create`)
//                      creates a staff account in THEIR organization.
//   bootstrap_account  first-time setup only: creates the auth account of the
//                      very first administrator while app_setup_needed() is
//                      true. The organization + ADMIN row are still created by
//                      bootstrap_first_admin() (076, advisory lock) from the
//                      client after it signs in — unchanged.
//
// create_staff, in order (every refusal happens before anything is written):
//   1. Bearer token verified by GoTrue (auth.getUser) -> 401.
//   2. Caller identity and permission from the DATABASE, evaluated with the
//      caller's own JWT: current_app_user() (active row only) and
//      app_has_perm('user:create') — the same functions RLS uses -> 403.
//   3. Assurance level, never weaker than the app's admin gate:
//        * caller has a verified TOTP factor -> the JWT must be aal2;
//        * else, caller is ADMIN -> an emailed login code (admin-2fa) must
//          have been consumed after this session signed in (JWT amr);
//        * else (non-admin without TOTP) -> nothing extra, as in the app.
//   4. Body validation (name, email, password, role, shop, idempotency key).
//   5. Role: ADMIN is never creatable here (one ADMIN per org; the caller
//      ADMIN already exists). A non-ADMIN caller may only create CASHIER or
//      BUYER in their own shop.
//   6. Shop must belong to the caller's organization (service-role lookup).
//   7. Rate limits: per-caller attempts (in-memory, best effort) and
//      successful creations per caller per hour (USER_CREATED audit rows).
//   8. Retry: the users id is derived from the idempotency key; a row that
//      already exists for the same key/org/email is returned as a replay.
//   9. Email uniqueness (users table, any org) -> 409, one generic message.
//  10. GoTrue admin API createUser (service role, email_confirm true).
//  11. create_app_user() RPC with the CALLER's JWT: RLS/guards/020 rules,
//      org derived server-side (v_user.org_id), USER_CREATED audit row,
//      idempotency key bound to the caller (074). On failure the auth user
//      just created is deleted again (compensation).
// The service-role key never leaves this function; the password is never
// logged or returned.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Retry-After",
};

export const PASSWORD_MIN = 8; // above GoTrue's default minimum (6)
export const PASSWORD_MAX = 72; // bcrypt truncates beyond 72 bytes
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const CREATABLE_BY_ADMIN = new Set(["MANAGER", "CASHIER", "BUYER"]);
const CREATABLE_BY_NON_ADMIN = new Set(["CASHIER", "BUYER"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOOTSTRAP_MAX_AUTH_USERS = 10;

const envInt = (name: string, fallback: number): number => {
  const raw = Number(Deno.env.get(name));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

const jsonResponse = (body: Record<string, unknown>, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });

const fail = (status: number, code: string, error: string, extra: Record<string, string> = {}) =>
  jsonResponse({ error, code }, status, extra);

// ---------------------------------------------------------------- rate limit
// Fixed-window attempt counter per key, in this worker's memory. Best effort
// (a cold start resets it); the durable limit is the audit-row count below.
const attempts = new Map<string, { windowStart: number; count: number }>();
const takeAttempt = (key: string, max: number, windowMs: number): number | null => {
  const now = Date.now();
  const cur = attempts.get(key);
  if (!cur || now - cur.windowStart >= windowMs) {
    attempts.set(key, { windowStart: now, count: 1 });
    return null;
  }
  if (cur.count >= max) return Math.ceil((cur.windowStart + windowMs - now) / 1000);
  cur.count += 1;
  return null;
};
const rateLimited = (seconds: number) =>
  fail(429, "rate_limited", "Too many attempts. Please wait and try again.", { "Retry-After": String(Math.max(1, seconds)) });

// ---------------------------------------------------------------- JWT claims
// Only read AFTER GoTrue has verified the token (auth.getUser succeeded).
interface Claims { sub?: string; aal?: string; amr?: { method?: string; timestamp?: number }[]; session_id?: string }
const decodeClaims = (token: string): Claims | null => {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(b64));
    return parsed && typeof parsed === "object" ? (parsed as Claims) : null;
  } catch {
    return null;
  }
};
/** When this session first authenticated (earliest amr entry), in ms. */
const sessionStartMs = (claims: Claims): number | null => {
  const stamps = (claims.amr ?? [])
    .map((e) => (typeof e?.timestamp === "number" ? e.timestamp : NaN))
    .filter((n) => Number.isFinite(n));
  return stamps.length ? Math.min(...stamps) * 1000 : null;
};

const normaliseEmail = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return null;
  return email;
};
const validPassword = (raw: unknown): raw is string =>
  typeof raw === "string" && raw.length >= PASSWORD_MIN && new TextEncoder().encode(raw).length <= PASSWORD_MAX;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

// Business-rule errors raised by the database are safe and useful to show the
// admin (they are the friendly 020/047 trigger messages and the unique
// constraint names the Users form maps). Anything else stays generic.
const SAFE_DB_CODES = new Set(["P0001", "23505", "23P01"]);
const DUPLICATE_EMAIL = "A user with this email already exists.";

interface CreateStaffBody {
  action: "create_staff";
  name?: unknown;
  email?: unknown;
  password?: unknown;
  role?: unknown;
  shopId?: unknown;
  idempotencyKey?: unknown;
}
interface BootstrapBody { action: "bootstrap_account"; email?: unknown; password?: unknown }

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return fail(405, "method_not_allowed", "Method not allowed.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error("[staff-admin] missing supabase service config");
    return fail(500, "misconfigured", "Server configuration is missing.");
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, "invalid_body", "Invalid request body.");
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  if (body.action === "bootstrap_account") return await bootstrapAccount(admin, body as unknown as BootstrapBody);
  if (body.action !== "create_staff") {
    // Unknown actions are refused only after auth so they reveal nothing.
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return fail(401, "unauthenticated", "Sign in first.");
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return fail(401, "unauthenticated", "Invalid session.");
    return fail(400, "unknown_action", "Unknown action.");
  }
  return await createStaff(request, admin, supabaseUrl, anonKey, body as unknown as CreateStaffBody);
});

// ================================================================ create_staff
async function createStaff(
  request: Request,
  admin: SupabaseClient,
  supabaseUrl: string,
  anonKey: string,
  body: CreateStaffBody,
): Promise<Response> {
  // 1. authenticate
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return fail(401, "unauthenticated", "Sign in first.");
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return fail(401, "unauthenticated", "Invalid session.");
  const authUser = authData.user;
  const claims = decodeClaims(token);
  if (!claims || claims.sub !== authUser.id) return fail(401, "unauthenticated", "Invalid session.");

  // 2. who is calling, per the database, with the caller's own JWT
  const asCaller = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const me = await asCaller.rpc("current_app_user");
  if (me.error) {
    console.error("[staff-admin] current_app_user failed", me.error.code ?? "");
    return fail(500, "server_error", "Could not verify your account.");
  }
  const caller = (Array.isArray(me.data) ? me.data[0] : me.data) as
    | { id?: string | null; role?: string; shop_id?: string | null; org_id?: string | null; is_active?: boolean }
    | null;
  if (!caller?.id || !caller.org_id || caller.is_active !== true) {
    return fail(403, "forbidden", "You are not allowed to create staff accounts.");
  }
  const perm = await asCaller.rpc("app_has_perm", { p_perm: "user:create" });
  if (perm.error) {
    console.error("[staff-admin] app_has_perm failed", perm.error.code ?? "");
    return fail(500, "server_error", "Could not verify your permissions.");
  }
  if (perm.data !== true) return fail(403, "forbidden", "You are not allowed to create staff accounts.");

  // 3. assurance level
  const factors = await admin.auth.admin.mfa.listFactors({ userId: authUser.id });
  if (factors.error) {
    console.error("[staff-admin] listFactors failed");
    return fail(500, "server_error", "Could not verify your sign-in.");
  }
  const hasVerifiedTotp = (factors.data?.factors ?? []).some(
    (f: { factor_type?: string; status?: string }) => f.factor_type === "totp" && f.status === "verified",
  );
  if (hasVerifiedTotp) {
    if (claims.aal !== "aal2") {
      return fail(403, "mfa_required", "Verify with your authenticator app before creating staff accounts.");
    }
  } else if (caller.role === "ADMIN") {
    const since = sessionStartMs(claims);
    if (since === null) return fail(403, "verification_required", "Verify your sign-in before creating staff accounts.");
    const code = await admin
      .from("admin_login_codes")
      .select("consumed_at")
      .eq("auth_id", authUser.id)
      .gte("consumed_at", new Date(since).toISOString())
      .limit(1);
    if (code.error) {
      console.error("[staff-admin] admin_login_codes lookup failed", code.error.code ?? "");
      return fail(500, "server_error", "Could not verify your sign-in.");
    }
    if ((code.data ?? []).length === 0) {
      return fail(403, "verification_required", "Verify your sign-in before creating staff accounts.");
    }
  }

  // 7a. per-caller attempt limit (counts every authorised attempt)
  const retry = takeAttempt(
    `staff:${authUser.id}`,
    envInt("STAFF_ADMIN_MAX_ATTEMPTS_PER_10_MIN", 30),
    10 * 60_000,
  );
  if (retry !== null) return rateLimited(retry);

  // 4. validate the request
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > NAME_MAX) return fail(400, "invalid_name", "Name is required (at most 120 characters).");
  const email = normaliseEmail(body.email);
  if (!email) return fail(400, "invalid_email", "Enter a valid email address.");
  if (!validPassword(body.password)) {
    return fail(400, "weak_password", `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
  }
  const password = body.password;
  const role = typeof body.role === "string" ? body.role : "";
  const shopId = typeof body.shopId === "string" ? body.shopId.trim() : "";
  if (!shopId) return fail(400, "invalid_shop", "Choose a shop.");
  const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey.toLowerCase() : "";
  if (!UUID_RE.test(key)) return fail(400, "invalid_request", "Invalid request.");

  // 5. role the caller may grant
  const allowed = caller.role === "ADMIN" ? CREATABLE_BY_ADMIN : CREATABLE_BY_NON_ADMIN;
  if (!allowed.has(role)) return fail(403, "role_not_allowed", "You cannot create an account with that role.");
  if (caller.role !== "ADMIN" && caller.shop_id !== shopId) {
    return fail(403, "shop_not_allowed", "You can only create staff for your own shop.");
  }

  // 6. shop must belong to the caller's organization
  const shop = await admin.from("shops").select("id").eq("id", shopId).eq("org_id", caller.org_id).limit(1);
  if (shop.error) {
    console.error("[staff-admin] shop lookup failed", shop.error.code ?? "");
    return fail(500, "server_error", "Could not create the staff account.");
  }
  if ((shop.data ?? []).length !== 1) return fail(403, "shop_not_allowed", "Shop not found.");

  // 7b. durable limit: successful creations by this caller in the last hour
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const recent = await admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("actor_id", caller.id)
    .eq("action_type", "USER_CREATED")
    .gte("created_at", hourAgo);
  if (recent.error) {
    console.error("[staff-admin] audit count failed", recent.error.code ?? "");
    return fail(500, "server_error", "Could not create the staff account.");
  }
  if ((recent.count ?? 0) >= envInt("STAFF_ADMIN_MAX_CREATES_PER_HOUR", 20)) return rateLimited(600);

  // 8. retry of a request that already succeeded
  const userId = `user-${key.replace(/-/g, "")}`;
  const existing = await admin.from("users").select("id, name, email, role, shop_id, auth_id, org_id, is_active, created_at")
    .eq("id", userId).limit(1);
  if (existing.error) {
    console.error("[staff-admin] replay lookup failed", existing.error.code ?? "");
    return fail(500, "server_error", "Could not create the staff account.");
  }
  const prior = (existing.data ?? [])[0] as Record<string, unknown> | undefined;
  if (prior) {
    if (prior.org_id === caller.org_id && prior.email === email && prior.role === role && prior.shop_id === shopId) {
      return jsonResponse({ user: toUser(prior), replayed: true }, 200);
    }
    return fail(409, "conflict", "This request was already used. Reload the page and try again.");
  }

  // 9. email uniqueness across the install (auth emails are global)
  const dup = await admin.from("users").select("id").ilike("email", escapeLike(email)).limit(1);
  if (dup.error) {
    console.error("[staff-admin] email lookup failed", dup.error.code ?? "");
    return fail(500, "server_error", "Could not create the staff account.");
  }
  if ((dup.data ?? []).length > 0) return fail(409, "email_taken", DUPLICATE_EMAIL);

  // 10. the auth account (GoTrue admin API; works with DISABLE_SIGNUP=true)
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    const status = (created.error as { status?: number } | null)?.status;
    const errCode = (created.error as { code?: string } | null)?.code;
    if (status === 422 && (errCode === "email_exists" || /already/i.test(created.error?.message ?? ""))) {
      return fail(409, "email_taken", DUPLICATE_EMAIL);
    }
    if (status === 422 && errCode === "weak_password") {
      return fail(400, "weak_password", "Password is too weak.");
    }
    console.error("[staff-admin] createUser failed", status ?? "", errCode ?? "");
    return fail(502, "auth_error", "Could not create the login account.");
  }
  const newAuthId = created.data.user.id;

  // 11. the users row + USER_CREATED audit, as the caller
  const row = await asCaller.rpc("create_app_user", {
    p_id: userId,
    p_name: name,
    p_email: email,
    p_role: role,
    p_shop_id: shopId,
    p_auth_id: newAuthId,
    p_granted_permissions: null,
    p_revoked_permissions: null,
    p_idempotency_key: key,
  });
  if (row.error || !row.data) {
    const del = await admin.auth.admin.deleteUser(newAuthId);
    if (del.error) console.error("[staff-admin] COMPENSATION FAILED: orphan auth user", newAuthId);
    else console.log("[staff-admin] compensated: deleted auth user", newAuthId);
    const pgCode = row.error?.code ?? "";
    console.error("[staff-admin] create_app_user failed", pgCode);
    if (SAFE_DB_CODES.has(pgCode)) {
      return jsonResponse({ error: row.error!.message, code: "rejected", dbCode: pgCode }, 409);
    }
    return fail(500, "server_error", "Could not create the staff profile. Nothing was created.");
  }
  console.log("[staff-admin] created staff", userId, "role", role, "by", caller.id);
  return jsonResponse({ user: row.data as Record<string, unknown> }, 201);
}

const toUser = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, email: r.email, role: r.role, shopId: r.shop_id, authId: r.auth_id,
  isActive: r.is_active, createdAt: r.created_at, orgId: r.org_id,
});

// ================================================================ bootstrap_account
async function bootstrapAccount(admin: SupabaseClient, body: BootstrapBody): Promise<Response> {
  const retry = takeAttempt("bootstrap", envInt("STAFF_ADMIN_MAX_BOOTSTRAP_PER_10_MIN", 10), 10 * 60_000);
  if (retry !== null) return rateLimited(retry);

  const closed = () => fail(403, "setup_closed", "Setup has already been completed on this backend.");

  // Fail closed: setup must be confirmably needed (users empty) AND there
  // must be no organization at all. Checked before validating input.
  const needed = await admin.rpc("app_setup_needed");
  if (needed.error) {
    console.error("[staff-admin] app_setup_needed failed", needed.error.code ?? "");
    return fail(503, "setup_unknown", "Could not confirm that first-time setup is needed.");
  }
  if (needed.data !== true) return closed();
  const orgs = await admin.from("organizations").select("id").limit(1);
  if (orgs.error) {
    console.error("[staff-admin] organizations lookup failed", orgs.error.code ?? "");
    return fail(503, "setup_unknown", "Could not confirm that first-time setup is needed.");
  }
  if ((orgs.data ?? []).length > 0) return closed();

  const email = normaliseEmail(body.email);
  if (!email) return fail(400, "invalid_email", "Enter a valid email address.");
  if (!validPassword(body.password)) {
    return fail(400, "weak_password", `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
  }

  // Cap: an empty install never needs more than a handful of auth accounts.
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: BOOTSTRAP_MAX_AUTH_USERS });
  if (list.error) {
    console.error("[staff-admin] listUsers failed");
    return fail(503, "setup_unknown", "Could not confirm that first-time setup is needed.");
  }
  if ((list.data?.users ?? []).length >= BOOTSTRAP_MAX_AUTH_USERS) return closed();

  const created = await admin.auth.admin.createUser({ email, password: body.password as string, email_confirm: true });
  if (created.error || !created.data.user) {
    const status = (created.error as { status?: number } | null)?.status;
    const errCode = (created.error as { code?: string } | null)?.code;
    if (status === 422 && (errCode === "email_exists" || /already/i.test(created.error?.message ?? ""))) {
      return fail(409, "email_taken", "An account with this email already exists. Use its password.");
    }
    console.error("[staff-admin] bootstrap createUser failed", status ?? "", errCode ?? "");
    return fail(502, "auth_error", "Could not create the login account.");
  }
  console.log("[staff-admin] bootstrap account created", created.data.user.id);
  return jsonResponse({ created: true }, 201);
}
