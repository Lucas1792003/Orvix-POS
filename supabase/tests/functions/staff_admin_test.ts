// staff-admin — hermetic tests (see _harness.ts). Runs the real
// supabase/functions/staff-admin/index.ts against in-process mocks.
//
// On top of the shared world this file installs two more mocks in front of
// the harness router (the harness itself is unchanged):
//   * GoTrue admin API  /auth/v1/admin/users[...]  (createUser, deleteUser,
//     listUsers, listFactors) — must carry the service-role key;
//   * PostgREST calls made WITH THE CALLER'S JWT (apikey = anon key):
//     rpc/current_app_user, rpc/app_has_perm, rpc/create_app_user, emulating
//     the database semantics the function relies on (active row only,
//     role defaults + grants - revokes, org derived from the caller,
//     guard trigger: only ADMIN creates elevated roles, USER_CREATED audit).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { loadHandler, makeWorld, post, SERVICE_ROLE_KEY, setEnv, SUPABASE_URL, test, type World } from "./_harness.ts";

const ANON_KEY = "test-anon-key.not-a-real-jwt";
const NOW_S = Math.floor(Date.now() / 1000);

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (sub: string, aal: "aal1" | "aal2", loginAt = NOW_S - 600) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
    sub, aal, role: "authenticated", session_id: `sess-${sub}`,
    amr: aal === "aal2" ? [{ method: "password", timestamp: loginAt }, { method: "totp", timestamp: loginAt + 30 }] : [{ method: "password", timestamp: loginAt }],
  })}.sig-${sub}`;

const T = {
  adminA: jwt("a0000000-0000-4000-8000-00000000000a", "aal1"),
  adminAaal2: jwt("a0000000-0000-4000-8000-00000000000a", "aal2"),
  adminB: jwt("b0000000-0000-4000-8000-00000000000b", "aal1"),
  mgrA: jwt("d0000000-0000-4000-8000-00000000000d", "aal1"),
  cashA: jwt("e0000000-0000-4000-8000-00000000000e", "aal1"),
  grantedMgr: jwt("c0000000-0000-4000-8000-00000000000c", "aal1"),
  inactive: jwt("f0000000-0000-4000-8000-00000000000f", "aal1"),
  orphan: jwt("90000000-0000-4000-8000-000000000009", "aal1"),
};

const USERS = [
  { id: "u-admin-a", auth_id: "a0000000-0000-4000-8000-00000000000a", name: "Owner A", email: "owner-a@example.test", role: "ADMIN", shop_id: null, org_id: "org-a", is_active: true },
  { id: "u-admin-b", auth_id: "b0000000-0000-4000-8000-00000000000b", name: "Owner B", email: "owner-b@example.test", role: "ADMIN", shop_id: null, org_id: "org-b", is_active: true },
  { id: "u-mgr-a", auth_id: "d0000000-0000-4000-8000-00000000000d", name: "Mgr A", email: "mgr-a@example.test", role: "MANAGER", shop_id: "shop-a1", org_id: "org-a", is_active: true },
  { id: "u-cash-a", auth_id: "e0000000-0000-4000-8000-00000000000e", name: "Cash A", email: "cash-a@example.test", role: "CASHIER", shop_id: "shop-a1", org_id: "org-a", is_active: true },
  { id: "u-mgr-granted", auth_id: "c0000000-0000-4000-8000-00000000000c", name: "Mgr G", email: "mgr-g@example.test", role: "MANAGER", shop_id: "shop-a2", org_id: "org-a", is_active: true, granted_permissions: ["user:create"] },
  { id: "u-inactive", auth_id: "f0000000-0000-4000-8000-00000000000f", name: "Gone", email: "gone@example.test", role: "ADMIN", shop_id: null, org_id: "org-c", is_active: false },
];
const SHOPS = [
  { id: "shop-a1", org_id: "org-a", name: "A1" },
  { id: "shop-a2", org_id: "org-a", name: "A2" },
  { id: "shop-b1", org_id: "org-b", name: "B1" },
];
const PASSWORD = "Correct-Horse-9";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KEY2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// ---------------------------------------------------------------- extra mocks
interface AuthAccount { id: string; email: string; password: string; email_confirmed: boolean }
interface Extra {
  accounts: AuthAccount[];
  factors: Record<string, { id: string; factor_type: string; status: string }[]>;
  deleted: string[];
  failDelete: boolean;
  failCreateApp: { code: string; message: string; status: number } | null;
  callerCalls: { fn: string; token: string; body: unknown }[];
  adminCalls: { method: string; path: string; body: unknown }[];
  bodies: string[]; // every request body the function sent anywhere
  dbUsersRpcRole: Record<string, string[]>;
}

const ROLE_DEFAULTS: Record<string, string[]> = {
  ADMIN: ["user:create", "user:update"],
  MANAGER: [],
  CASHIER: [],
  BUYER: [],
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const install = (world: World): Extra => {
  const extra: Extra = {
    accounts: [], factors: {}, deleted: [], failDelete: false, failCreateApp: null,
    callerCalls: [], adminCalls: [], bodies: [], dbUsersRpcRole: {},
  };
  const inner = globalThis.fetch;
  const tokenToAuth = (bearer: string) => world.auth.users.get(bearer)?.id ?? null;
  const callerRow = (bearer: string) => {
    const authId = tokenToAuth(bearer);
    return (world.db.tables.users ?? []).find((u) => u.auth_id === authId && u.is_active === true) ?? null;
  };
  const hasPerm = (row: Record<string, unknown> | null, perm: string) => {
    if (!row) return false;
    const eff = new Set([...(ROLE_DEFAULTS[row.role as string] ?? []), ...((row.granted_permissions as string[]) ?? [])]);
    for (const p of (row.revoked_permissions as string[]) ?? []) eff.delete(p);
    return eff.has(perm);
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(req.url);
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    if (text) extra.bodies.push(text);
    const apikey = req.headers.get("apikey");
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

    // ---- GoTrue admin API
    if (req.url.startsWith(`${SUPABASE_URL}/auth/v1/admin/`)) {
      assertEquals(apikey, SERVICE_ROLE_KEY, "admin API without the service-role apikey");
      assertEquals(bearer, SERVICE_ROLE_KEY, "admin API without the service-role bearer");
      const path = url.pathname.replace("/auth/v1/admin/", "");
      const body = text ? JSON.parse(text) : null;
      extra.adminCalls.push({ method: req.method, path, body });
      const factorsMatch = path.match(/^users\/([^/]+)\/factors$/);
      if (req.method === "GET" && factorsMatch) return json(extra.factors[factorsMatch[1]] ?? [], 200);
      if (req.method === "GET" && path === "users") return json({ users: extra.accounts.map((a) => ({ id: a.id, email: a.email })), aud: "authenticated" }, 200);
      if (req.method === "POST" && path === "users") {
        if (extra.accounts.some((a) => a.email === body.email)) {
          return json({ code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" }, 422);
        }
        const acct = { id: `00000000-0000-4000-8000-${String(extra.accounts.length + 1).padStart(12, "0")}`, email: body.email, password: body.password, email_confirmed: body.email_confirm === true };
        extra.accounts.push(acct);
        return json({ id: acct.id, email: acct.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-13T00:00:00Z" }, 200);
      }
      const delMatch = path.match(/^users\/([^/]+)$/);
      if (req.method === "DELETE" && delMatch) {
        if (extra.failDelete) return json({ code: 500, msg: "boom" }, 500);
        extra.deleted.push(delMatch[1]);
        extra.accounts = extra.accounts.filter((a) => a.id !== delMatch[1]);
        return json({}, 200);
      }
      throw new Error(`unexpected admin call ${req.method} ${path}`);
    }

    // ---- PostgREST as the caller (anon apikey + the caller's JWT)
    if (req.url.startsWith(`${SUPABASE_URL}/rest/v1/`) && apikey === ANON_KEY) {
      const fn = url.pathname.replace("/rest/v1/", "");
      const body = text ? JSON.parse(text) : {};
      extra.callerCalls.push({ fn, token: bearer, body });
      const me = callerRow(bearer);
      if (fn === "rpc/current_app_user") {
        return json(me ?? Object.fromEntries(Object.keys(USERS[0]).map((k) => [k, null])), 200);
      }
      if (fn === "rpc/app_has_perm") return json(hasPerm(me, body.p_perm), 200);
      if (fn === "rpc/create_app_user") {
        if (!me) return json({ code: "P0001", message: "Not authenticated" }, 400);
        if (extra.failCreateApp) {
          const f = extra.failCreateApp;
          return json({ code: f.code, message: f.message, details: null, hint: null }, f.status);
        }
        if (!hasPerm(me, "user:create")) return json({ code: "P0001", message: "You are not permitted to create users" }, 400);
        const shop = world.db.tables.shops.find((s) => s.id === body.p_shop_id);
        if (!shop || shop.org_id !== me.org_id) return json({ code: "P0001", message: "shop not found" }, 400);
        if (me.role !== "ADMIN" && body.p_role === "ADMIN") {
          return json({ code: "P0001", message: "Only an ADMIN can create a user with an elevated role or custom permission overrides." }, 400);
        }
        const row = {
          id: body.p_id, name: body.p_name, email: body.p_email, role: body.p_role, shop_id: body.p_shop_id,
          auth_id: body.p_auth_id, org_id: me.org_id, is_active: true, created_at: "2026-10-13T00:00:00Z",
        };
        world.db.tables.users.push(row);
        world.db.tables.audit_logs.push({ id: `audit-${world.db.tables.audit_logs.length}`, actor_id: me.id, action_type: "USER_CREATED", entity_id: body.p_id, created_at: new Date().toISOString() });
        return json({ id: row.id, name: row.name, email: row.email, role: row.role, shopId: row.shop_id, authId: row.auth_id, isActive: true, createdAt: row.created_at, orgId: row.org_id }, 200);
      }
      throw new Error(`unexpected caller-JWT PostgREST call ${fn}`);
    }
    return inner(req);
  }) as typeof fetch;
  return extra;
};

const quiet = async (fn: (logs: string[]) => Promise<void>) => {
  const { log, error } = console;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try { await fn(logs); } finally { console.log = log; console.error = error; }
};

interface Ctx { world: World; extra: Extra; handler: (r: Request) => Response | Promise<Response>; logs: string[] }
const run = async (fn: (ctx: Ctx) => Promise<void>, opts: { consumedCodeFor?: string[]; env?: Record<string, string> } = {}) => {
  setEnv({
    SUPABASE_ANON_KEY: ANON_KEY,
    STAFF_ADMIN_MAX_ATTEMPTS_PER_10_MIN: "100000",
    STAFF_ADMIN_MAX_BOOTSTRAP_PER_10_MIN: "100000",
    ...opts.env,
  });
  const world = makeWorld();
  const extra = install(world);
  try {
    await quiet(async (logs) => {
      world.db.seed({
        users: USERS,
        shops: SHOPS,
        audit_logs: [],
        organizations: [{ id: "org-a" }, { id: "org-b" }],
        admin_login_codes: (opts.consumedCodeFor ?? ["a0000000-0000-4000-8000-00000000000a", "b0000000-0000-4000-8000-00000000000b"]).map((a, i) => ({
          id: `code-${i}`, auth_id: a, consumed_at: new Date((NOW_S - 300) * 1000).toISOString(),
        })),
      });
      for (const [name, token] of Object.entries(T)) {
        const sub = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
        world.auth.users.set(token, { id: sub, email: `${name}@example.test` });
      }
      world.db.rpcs.app_setup_needed = () => [200, false];
      const handler = await loadHandler("staff-admin");
      await fn({ world, extra, handler, logs });
    });
  } finally {
    world.restore();
  }
};

const body = (over: Record<string, unknown> = {}) => ({
  action: "create_staff", name: "New Cashier", email: "  New.Cashier@Example.TEST ", password: PASSWORD,
  role: "CASHIER", shopId: "shop-a1", idempotencyKey: KEY, ...over,
});
const call = async (ctx: Ctx, token: string | null, b: unknown) => {
  const res = await ctx.handler(post(token, b));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text), retryAfter: res.headers.get("retry-after") };
};
const assertNothingCreated = (ctx: Ctx) => {
  assertEquals(ctx.extra.adminCalls.filter((c) => c.method === "POST").length, 0, "no auth user created");
  assertEquals(ctx.world.db.tables.users.length, USERS.length, "no users row");
  assertEquals(ctx.extra.callerCalls.filter((c) => c.fn === "rpc/create_app_user").length, 0);
};
const assertNoSecrets = (ctx: Ctx, ...texts: string[]) => {
  for (const t of [...texts, ...ctx.logs]) {
    assert(!t.includes(SERVICE_ROLE_KEY), "service-role key leaked");
    assert(!t.includes(PASSWORD), "password leaked");
    for (const tok of Object.values(T)) assert(!t.includes(tok), "caller JWT leaked");
  }
};

// ---------------------------------------------------------------- authn / authz
test("staff-admin: no bearer / invalid bearer -> 401, nothing touched", async () => {
  await run(async (ctx) => {
    const none = await call(ctx, null, body());
    assertEquals(none.status, 401);
    const bad = await call(ctx, "garbage", body());
    assertEquals(bad.status, 401);
    assertNothingCreated(ctx);
    assertEquals(ctx.extra.callerCalls.length, 0);
  });
});

test("staff-admin: cashier, manager without user:create, inactive and orphan callers -> 403", async () => {
  await run(async (ctx) => {
    for (const token of [T.cashA, T.mgrA, T.inactive, T.orphan]) {
      const r = await call(ctx, token, body());
      assertEquals(r.status, 403, r.text);
      assertEquals(r.body.code, "forbidden");
    }
    assertNothingCreated(ctx);
  });
});

test("staff-admin: admin with a verified TOTP factor on an aal1 session -> 403 mfa_required; aal2 -> allowed", async () => {
  await run(async (ctx) => {
    ctx.extra.factors["a0000000-0000-4000-8000-00000000000a"] = [{ id: "f1", factor_type: "totp", status: "verified" }];
    const r = await call(ctx, T.adminA, body());
    assertEquals(r.status, 403, r.text);
    assertEquals(r.body.code, "mfa_required");
    assertNothingCreated(ctx);
    const ok = await call(ctx, T.adminAaal2, body());
    assertEquals(ok.status, 201, ok.text);
  });
});

test("staff-admin: admin without TOTP must have consumed an emailed code after this session signed in", async () => {
  await run(async (ctx) => {
    const r = await call(ctx, T.adminA, body());
    assertEquals(r.status, 403, r.text);
    assertEquals(r.body.code, "verification_required");
    // a code consumed BEFORE this sign-in does not count
    ctx.world.db.tables.admin_login_codes.push({ id: "old", auth_id: "a0000000-0000-4000-8000-00000000000a", consumed_at: new Date((NOW_S - 7200) * 1000).toISOString() });
    const r2 = await call(ctx, T.adminA, body());
    assertEquals(r2.body.code, "verification_required");
    // an unconsumed code does not count either
    ctx.world.db.tables.admin_login_codes.push({ id: "open", auth_id: "a0000000-0000-4000-8000-00000000000a", consumed_at: null });
    assertEquals((await call(ctx, T.adminA, body())).body.code, "verification_required");
    assertNothingCreated(ctx);
    ctx.world.db.tables.admin_login_codes.push({ id: "new", auth_id: "a0000000-0000-4000-8000-00000000000a", consumed_at: new Date((NOW_S - 60) * 1000).toISOString() });
    assertEquals((await call(ctx, T.adminA, body())).status, 201);
  }, { consumedCodeFor: [] });
});

test("staff-admin: unverified (pending) TOTP factor does not force aal2", async () => {
  await run(async (ctx) => {
    ctx.extra.factors["a0000000-0000-4000-8000-00000000000a"] = [{ id: "f1", factor_type: "totp", status: "unverified" }];
    assertEquals((await call(ctx, T.adminA, body())).status, 201);
  });
});

// ---------------------------------------------------------------- happy path
test("staff-admin: happy path -> auth user (email_confirm) + users row in the CALLER's org via create_app_user", async () => {
  await run(async (ctx) => {
    const r = await call(ctx, T.adminA, body({ orgId: "org-b", org_id: "org-b" }));
    assertEquals(r.status, 201, r.text);
    const created = ctx.extra.adminCalls.filter((c) => c.method === "POST" && c.path === "users");
    assertEquals(created.length, 1);
    assertEquals(created[0].body, { email: "new.cashier@example.test", password: PASSWORD, email_confirm: true });
    const rpc = ctx.extra.callerCalls.find((c) => c.fn === "rpc/create_app_user")!;
    assertEquals(rpc.token, T.adminA, "users row written with the caller's JWT, not the service role");
    assertEquals(rpc.body, {
      p_id: `user-${KEY.replace(/-/g, "")}`, p_name: "New Cashier", p_email: "new.cashier@example.test", p_role: "CASHIER",
      p_shop_id: "shop-a1", p_auth_id: "00000000-0000-4000-8000-000000000001", p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: KEY,
    });
    const row = ctx.world.db.tables.users.find((u) => u.auth_id === "00000000-0000-4000-8000-000000000001")!;
    assertEquals(row.org_id, "org-a", "org derived server-side; body orgId ignored");
    assertEquals(r.body.user.orgId, "org-a");
    assertEquals(r.body.user.authId, "00000000-0000-4000-8000-000000000001");
    assertEquals(ctx.world.db.tables.audit_logs.filter((a) => a.action_type === "USER_CREATED" && a.actor_id === "u-admin-a").length, 1);
    assertEquals(Object.keys(r.body), ["user"]);
    assertNoSecrets(ctx, r.text);
  });
});

test("staff-admin: retry with the same idempotency key returns the existing row, creates nothing new", async () => {
  await run(async (ctx) => {
    const first = await call(ctx, T.adminA, body());
    assertEquals(first.status, 201);
    const again = await call(ctx, T.adminA, body());
    assertEquals(again.status, 200, again.text);
    assertEquals(again.body.replayed, true);
    assertEquals(again.body.user.id, first.body.user.id);
    assertEquals(ctx.extra.accounts.length, 1);
    assertEquals(ctx.extra.callerCalls.filter((c) => c.fn === "rpc/create_app_user").length, 1);
    // same key, different payload -> conflict, nothing created
    const other = await call(ctx, T.adminA, body({ email: "someone.else@example.test" }));
    assertEquals(other.status, 409);
    assertEquals(ctx.extra.accounts.length, 1);
  });
});

test("staff-admin: manager granted user:create may create a CASHIER in their own shop only", async () => {
  await run(async (ctx) => {
    const own = await call(ctx, T.grantedMgr, body({ shopId: "shop-a2" }));
    assertEquals(own.status, 201, own.text);
    const otherShop = await call(ctx, T.grantedMgr, body({ shopId: "shop-a1", idempotencyKey: KEY2, email: "x@example.test" }));
    assertEquals(otherShop.status, 403);
    assertEquals(otherShop.body.code, "shop_not_allowed");
  });
});

// ---------------------------------------------------------------- escalation / isolation
test("staff-admin: role escalation refused (ADMIN never; MANAGER only by ADMIN); unknown role refused", async () => {
  await run(async (ctx) => {
    for (const [token, role] of [[T.adminA, "ADMIN"], [T.grantedMgr, "ADMIN"], [T.grantedMgr, "MANAGER"], [T.adminA, "OWNER"], [T.adminA, "admin"]]) {
      const r = await call(ctx, token, body({ role, shopId: token === T.grantedMgr ? "shop-a2" : "shop-a1" }));
      assertEquals(r.status, 403, `${role}: ${r.text}`);
      assertEquals(r.body.code, "role_not_allowed");
    }
    assertNothingCreated(ctx);
    assertEquals((await call(ctx, T.adminA, body({ role: "MANAGER" }))).status, 201);
  });
});

test("staff-admin: a shop of another organization -> 403, nothing created", async () => {
  await run(async (ctx) => {
    const r = await call(ctx, T.adminA, body({ shopId: "shop-b1" }));
    assertEquals(r.status, 403, r.text);
    assertEquals(r.body.code, "shop_not_allowed");
    const missing = await call(ctx, T.adminA, body({ shopId: "shop-nope" }));
    assertEquals(missing.status, 403);
    assertEquals(r.body.error, missing.body.error, "foreign and missing shops look the same");
    assertNothingCreated(ctx);
    // and admin B can use its own shop
    assertEquals((await call(ctx, T.adminB, body({ shopId: "shop-b1" }))).status, 201);
  });
});

// ---------------------------------------------------------------- input / duplicates
test("staff-admin: malformed input -> 400 before anything is created", async () => {
  await run(async (ctx) => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "  " }, "invalid_name"],
      [{ name: "x".repeat(121) }, "invalid_name"],
      [{ email: "not-an-email" }, "invalid_email"],
      [{ email: 42 }, "invalid_email"],
      [{ password: "short" }, "weak_password"],
      [{ password: "x".repeat(73) }, "weak_password"],
      [{ password: ["array"] }, "weak_password"],
      [{ shopId: "" }, "invalid_shop"],
      [{ idempotencyKey: "nope" }, "invalid_request"],
    ];
    for (const [over, code] of cases) {
      const r = await call(ctx, T.adminA, body(over));
      assertEquals(r.status, 400, `${JSON.stringify(over)} -> ${r.text}`);
      assertEquals(r.body.code, code);
    }
    const notJson = await ctx.handler(new Request("http://functions.local/", { method: "POST", headers: { Authorization: `Bearer ${T.adminA}` }, body: "{" }));
    assertEquals(notJson.status, 400);
    const unknown = await call(ctx, T.adminA, { action: "delete_everything" });
    assertEquals(unknown.status, 400);
    assertEquals((await call(ctx, null, { action: "delete_everything" })).status, 401);
    const get = await ctx.handler(new Request("http://functions.local/", { method: "GET" }));
    assertEquals(get.status, 405);
    assertNothingCreated(ctx);
  });
});

test("staff-admin: duplicate email (users row in any org, or existing auth account) -> one generic 409", async () => {
  await run(async (ctx) => {
    const inOtherOrg = await call(ctx, T.adminA, body({ email: "OWNER-B@example.test" }));
    assertEquals(inOtherOrg.status, 409);
    assertEquals(inOtherOrg.body.code, "email_taken");
    assertNothingCreated(ctx);
    ctx.extra.accounts.push({ id: "auth-pa", email: "platform@example.test", password: "x", email_confirmed: true });
    const authOnly = await call(ctx, T.adminA, body({ email: "platform@example.test" }));
    assertEquals(authOnly.status, 409);
    assertEquals(authOnly.body.error, inOtherOrg.body.error, "no org / account-type detail");
    assertEquals(ctx.extra.deleted, [], "an existing account is never deleted");
    assertEquals(ctx.world.db.tables.users.length, USERS.length);
  });
});

// ---------------------------------------------------------------- compensation
test("staff-admin: users-row insert fails -> the new auth user is deleted again; business error surfaced", async () => {
  await run(async (ctx) => {
    ctx.extra.failCreateApp = { code: "P0001", message: "Cashier must be assigned to a shop with an active manager.", status: 400 };
    const r = await call(ctx, T.adminA, body());
    assertEquals(r.status, 409, r.text);
    assertEquals(r.body.dbCode, "P0001");
    assertStringIncludes(r.body.error, "active manager");
    assertEquals(ctx.extra.deleted, ["00000000-0000-4000-8000-000000000001"]);
    assertEquals(ctx.extra.accounts.length, 0);
    assertEquals(ctx.world.db.tables.users.length, USERS.length);
    assertNoSecrets(ctx, r.text);
  });
});

test("staff-admin: unexpected DB error -> generic 500 (no internals), still compensated", async () => {
  await run(async (ctx) => {
    ctx.extra.failCreateApp = { code: "42501", message: "permission denied for table users at internal host db:5432", status: 403 };
    const r = await call(ctx, T.adminA, body());
    assertEquals(r.status, 500);
    assert(!r.text.includes("42501") && !r.text.includes("db:5432"), r.text);
    assertEquals(ctx.extra.deleted, ["00000000-0000-4000-8000-000000000001"]);
  });
});

test("staff-admin: compensation failure is logged with the orphan id (no secrets) and the call still fails", async () => {
  await run(async (ctx) => {
    ctx.extra.failCreateApp = { code: "23505", message: 'duplicate key value violates unique constraint "users_pkey"', status: 409 };
    ctx.extra.failDelete = true;
    const r = await call(ctx, T.adminA, body());
    assertEquals(r.status, 409);
    assert(ctx.logs.some((l) => l.includes("COMPENSATION FAILED") && l.includes("00000000-0000-4000-8000-000000000001")));
    assertNoSecrets(ctx, r.text);
  });
});

// ---------------------------------------------------------------- rate limits
test("staff-admin: more than N successful creations per hour by one caller -> 429", async () => {
  await run(async (ctx) => {
    for (let i = 0; i < 20; i++) {
      ctx.world.db.tables.audit_logs.push({ id: `a${i}`, actor_id: "u-admin-b", action_type: "USER_CREATED", created_at: new Date().toISOString() });
    }
    const r = await call(ctx, T.adminB, body({ shopId: "shop-b1" }));
    assertEquals(r.status, 429, r.text);
    assertEquals(r.body.code, "rate_limited");
    assertNothingCreated(ctx);
  });
});

test("staff-admin: per-caller attempt limit (in-memory) -> 429 with Retry-After, nothing created", async () => {
  await run(async (ctx) => {
    let limited: Awaited<ReturnType<typeof call>> | null = null;
    const k = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    for (let i = 0; i < 3 && !limited; i++) {
      const r = await call(ctx, T.grantedMgr, body({ shopId: "shop-a2", email: `burst${i}@example.test`, idempotencyKey: k[i] }));
      if (r.status === 429) limited = r;
    }
    assert(limited, "expected a 429 within 3 attempts at a limit of 2");
    assertEquals(limited!.body.code, "rate_limited");
    assert(Number(limited!.retryAfter) >= 1, "Retry-After header");
    const before = ctx.world.db.tables.users.length;
    const again = await call(ctx, T.grantedMgr, body({ shopId: "shop-a2", email: "burst9@example.test", idempotencyKey: KEY2 }));
    assertEquals(again.status, 429);
    assertEquals(ctx.world.db.tables.users.length, before);
  }, { env: { STAFF_ADMIN_MAX_ATTEMPTS_PER_10_MIN: "2" } });
});

// ---------------------------------------------------------------- bootstrap
test("staff-admin bootstrap: refused once any user or organization exists; never creates an account", async () => {
  await run(async (ctx) => {
    const r = await call(ctx, null, { action: "bootstrap_account", email: "first@example.test", password: PASSWORD });
    assertEquals(r.status, 403);
    assertEquals(r.body.code, "setup_closed");
    // users empty but an organization exists -> still closed
    ctx.world.db.rpcs.app_setup_needed = () => [200, true];
    const r2 = await call(ctx, ANON_KEY, { action: "bootstrap_account", email: "first@example.test", password: PASSWORD });
    assertEquals(r2.status, 403);
    // the check itself failing -> 503, fail closed
    ctx.world.db.rpcs.app_setup_needed = () => [404, { code: "PGRST202", message: "function not found" }];
    const r3 = await call(ctx, ANON_KEY, { action: "bootstrap_account", email: "first@example.test", password: PASSWORD });
    assertEquals(r3.status, 503);
    assertEquals(ctx.extra.adminCalls.filter((c) => c.method === "POST").length, 0);
  });
});

test("staff-admin bootstrap: on an empty install creates exactly one confirmed auth account; duplicate -> 409; cap enforced", async () => {
  await run(async (ctx) => {
    ctx.world.db.tables.users = [];
    ctx.world.db.tables.organizations = [];
    ctx.world.db.rpcs.app_setup_needed = () => [200, true];
    const weak = await call(ctx, ANON_KEY, { action: "bootstrap_account", email: "first@example.test", password: "short" });
    assertEquals(weak.status, 400);
    const r = await call(ctx, ANON_KEY, { action: "bootstrap_account", email: " First@Example.test ", password: PASSWORD });
    assertEquals(r.status, 201, r.text);
    assertEquals(r.body, { created: true });
    assertEquals(ctx.extra.accounts.map((a) => [a.email, a.email_confirmed]), [["first@example.test", true]]);
    const dup = await call(ctx, ANON_KEY, { action: "bootstrap_account", email: "first@example.test", password: PASSWORD });
    assertEquals(dup.status, 409);
    for (let i = 0; i < 9; i++) ctx.extra.accounts.push({ id: `x${i}`, email: `x${i}@example.test`, password: "x", email_confirmed: true });
    const capped = await call(ctx, ANON_KEY, { action: "bootstrap_account", email: "eleventh@example.test", password: PASSWORD });
    assertEquals(capped.status, 403);
    assertEquals(ctx.world.db.tables.users.length, 0, "bootstrap never writes app rows (076 does)");
    assertNoSecrets(ctx, r.text, dup.text);
  });
});

test("staff-admin: no request the function sends carries a password except the createUser call", async () => {
  await run(async (ctx) => {
    await call(ctx, T.adminA, body());
    const withPw = ctx.extra.bodies.filter((b) => b.includes(PASSWORD));
    assertEquals(withPw.length, 1);
    assertStringIncludes(withPw[0], '"email_confirm":true');
  });
});
