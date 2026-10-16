import { createClient } from "npm:@supabase/supabase-js@2";

// Internal platform-admin console. Every action here requires the caller
// to be an active row in `platform_admins` (migration 061) — a table with
// RLS on and zero client policies, so this Edge Function (service-role
// key, bypasses RLS) is the *only* way in. Mirrors admin-2fa's auth
// pattern: verify the Bearer token via supabase.auth.getUser, then do a
// separate server-side authorization check the client can never perform
// itself.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ConsoleRequest {
  action?: "whoami" | "list_organizations" | "create_organization" | "create_platform_admin";
  orgName?: string;
  adminName?: string;
  adminEmail?: string;
  name?: string;
  email?: string;
}

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const newId = (prefix: string): string => `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;

// Strong random temp password: shown once in the console UI, relayed to
// the customer manually. Never emailed, never logged.
const generateTempPassword = (): string => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 20);
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[platform-console] missing supabase service config");
    return jsonResponse({ error: "Supabase service configuration is missing." }, 500);
  }

  const authorization = request.headers.get("Authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return jsonResponse({ error: "Sign in first." }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) {
    return jsonResponse({ error: "Invalid session." }, 401);
  }
  const authUser = authData.user;

  // The real gate: membership in platform_admins, not just a valid
  // Supabase session. An org's ADMIN passing this same auth.getUser()
  // check gets nothing further — they simply won't have a row here.
  const { data: admin, error: adminError } = await supabase
    .from("platform_admins")
    .select("id, name, email, is_active")
    .eq("auth_id", authUser.id)
    .maybeSingle();
  if (adminError) {
    console.error("[platform-console] admin lookup failed", adminError.message);
    return jsonResponse({ error: adminError.message }, 500);
  }
  if (!admin || !admin.is_active) {
    // Deliberately generic — never confirm/deny "you're just not a
    // platform admin" vs. "wrong credentials" to the caller.
    return jsonResponse({ error: "Not authorized." }, 403);
  }

  let body: ConsoleRequest;
  try {
    body = (await request.json()) as ConsoleRequest;
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  if (body.action === "whoami") {
    return jsonResponse({ name: admin.name, email: admin.email });
  }

  if (body.action === "list_organizations") {
    const { data: orgs, error: orgsError } = await supabase
      .from("organizations")
      .select("id, name, is_active, created_at")
      .order("created_at", { ascending: false });
    if (orgsError) return jsonResponse({ error: orgsError.message }, 500);

    const orgList = orgs ?? [];
    const orgIds = orgList.map((o) => o.id);

    const [{ data: admins }, { data: shops }] = await Promise.all([
      orgIds.length
        ? supabase.from("users").select("org_id, name, email").eq("role", "ADMIN").in("org_id", orgIds)
        : Promise.resolve({ data: [] as { org_id: string; name: string; email: string | null }[] }),
      orgIds.length
        ? supabase.from("shops").select("org_id").in("org_id", orgIds)
        : Promise.resolve({ data: [] as { org_id: string }[] }),
    ]);

    const adminByOrg = new Map((admins ?? []).map((a) => [a.org_id, a]));
    const shopCountByOrg = new Map<string, number>();
    for (const s of shops ?? []) {
      shopCountByOrg.set(s.org_id, (shopCountByOrg.get(s.org_id) ?? 0) + 1);
    }

    return jsonResponse({
      organizations: orgList.map((o) => ({
        id: o.id,
        name: o.name,
        isActive: o.is_active,
        createdAt: o.created_at,
        adminName: adminByOrg.get(o.id)?.name ?? null,
        adminEmail: adminByOrg.get(o.id)?.email ?? null,
        shopCount: shopCountByOrg.get(o.id) ?? 0,
      })),
    });
  }

  if (body.action === "create_organization") {
    const orgName = (body.orgName ?? "").trim();
    const adminName = (body.adminName ?? "").trim();
    const adminEmail = (body.adminEmail ?? "").trim().toLowerCase();
    if (!orgName || !adminName || !adminEmail) {
      return jsonResponse({ error: "Organization name, admin name, and admin email are required." }, 400);
    }

    const tempPassword = generateTempPassword();
    const created = await supabase.auth.admin.createUser({
      email: adminEmail,
      password: tempPassword,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      return jsonResponse({ error: created.error?.message ?? "Could not create the admin account." }, 400);
    }
    const newAuthId = created.data.user.id;

    const orgId = newId("org");
    const orgInsert = await supabase.from("organizations").insert({ id: orgId, name: orgName });
    if (orgInsert.error) {
      await supabase.auth.admin.deleteUser(newAuthId).catch(() => {});
      return jsonResponse({ error: orgInsert.error.message }, 500);
    }

    const userInsert = await supabase.from("users").insert({
      id: newId("user"),
      name: adminName,
      email: adminEmail,
      role: "ADMIN",
      org_id: orgId,
      auth_id: newAuthId,
      is_active: true,
      created_at: new Date().toISOString(),
    });
    if (userInsert.error) {
      await supabase.from("organizations").delete().eq("id", orgId).catch(() => {});
      await supabase.auth.admin.deleteUser(newAuthId).catch(() => {});
      return jsonResponse({ error: userInsert.error.message }, 500);
    }

    console.log("[platform-console] created organization", orgId, "by", admin.email);
    return jsonResponse({ orgId, adminEmail, tempPassword });
  }

  if (body.action === "create_platform_admin") {
    const name = (body.name ?? "").trim();
    const email = (body.email ?? "").trim().toLowerCase();
    if (!name || !email) {
      return jsonResponse({ error: "Name and email are required." }, 400);
    }

    const tempPassword = generateTempPassword();
    const created = await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      return jsonResponse({ error: created.error?.message ?? "Could not create the account." }, 400);
    }
    const newAuthId = created.data.user.id;

    const insert = await supabase.from("platform_admins").insert({ auth_id: newAuthId, name, email });
    if (insert.error) {
      await supabase.auth.admin.deleteUser(newAuthId).catch(() => {});
      return jsonResponse({ error: insert.error.message }, 500);
    }

    console.log("[platform-console] created platform admin", email, "by", admin.email);
    return jsonResponse({ email, tempPassword });
  }

  return jsonResponse({ error: "Unknown action." }, 400);
});
