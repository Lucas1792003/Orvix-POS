// admin-2fa — hermetic tests (see _harness.ts). Runs the real
// supabase/functions/admin-2fa/index.ts against in-process mocks. The code is
// only ever visible in the (mocked) email body, so the verify test extracts
// it from the recorded Resend call — exactly what a real admin would do.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { loadHandler, makeWorld, post, readJson, setEnv, test } from "./_harness.ts";

const ADMIN_TOKEN = "session-jwt-admin";
const CASHIER_TOKEN = "session-jwt-cashier";
const USERS = [
  { id: "u-admin-1", auth_id: "auth-admin-1", name: "Owner", email: "owner@example.test", role: "ADMIN", is_active: true },
  { id: "u-cashier", auth_id: "auth-cashier", name: "Aye Aye", email: "aye@example.test", role: "CASHIER", is_active: true },
];

const setup = async (world: ReturnType<typeof makeWorld>) => {
  world.db.seed({ users: USERS, admin_login_codes: [] });
  world.auth.users.set(ADMIN_TOKEN, { id: "auth-admin-1", email: "owner@example.test" });
  world.auth.users.set(CASHIER_TOKEN, { id: "auth-cashier", email: "aye@example.test" });
  return await loadHandler("admin-2fa");
};

// silence the function's own console.log/console.error chatter during tests
const quiet = async (fn: () => Promise<void>) => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try { await fn(); } finally { console.log = log; console.error = error; }
};

test("admin-2fa: missing RESEND_API_KEY → 500 before any DB or auth call", async () => {
  setEnv({ RESEND_API_KEY: undefined });
  const world = makeWorld();
  try {
    await quiet(async () => {
      const handler = await setup(world);
      const res = await readJson(await handler(post(ADMIN_TOKEN, { action: "request" })));
      assertEquals(res.status, 500);
      assertEquals(res.body, { error: "Email provider is not configured. Set RESEND_API_KEY and REPORT_EMAIL_FROM." });
      assertEquals(world.calls.length, 0, "no auth lookup, no PostgREST call, no email");
    });
  } finally {
    world.restore();
    setEnv();
  }
});

test("admin-2fa: refuses missing / invalid bearer and non-admin callers; never emails, never writes", async () => {
  setEnv();
  const world = makeWorld();
  try {
    await quiet(async () => {
      const handler = await setup(world);
      const none = await readJson(await handler(post(null, { action: "request" })));
      assertEquals(none.status, 401);
      assertEquals(world.calls.length, 0);
      const bad = await readJson(await handler(post("garbage", { action: "request" })));
      assertEquals(bad.status, 401);
      assertEquals(world.trace(), ["auth:GET user"]);
      const cashier = await readJson(await handler(post(CASHIER_TOKEN, { action: "request" })));
      assertEquals(cashier.status, 403);
      assertEquals(world.resend.calls.length, 0);
      assertEquals(world.db.tables.admin_login_codes.length, 0);
    });
  } finally {
    world.restore();
  }
});

test("admin-2fa: request stores only the SHA-256 hash and emails the code; verify consumes it; wrong code counts an attempt", async () => {
  setEnv();
  const world = makeWorld();
  try {
    await quiet(async () => {
      const handler = await setup(world);
      const req = await readJson(await handler(post(ADMIN_TOKEN, { action: "request" })));
      assertEquals(req.status, 200, JSON.stringify(req.body));
      assertEquals(req.body.sent, true);
      assertEquals(req.body.email, "ow***@example.test");
      assertEquals(world.trace(), ["auth:GET user", "db:GET users", "db:GET admin_login_codes", "db:POST admin_login_codes", "resend:POST"]);

      const email = world.resend.calls[0].body as Record<string, unknown>;
      assertEquals(email.to, ["owner@example.test"]);
      assertEquals(email.subject, "Your Shwe PhaLar admin login code");
      const code = /login code is (\d{6})\./.exec(String(email.text))![1];
      const stored = world.db.tables.admin_login_codes[0];
      assertEquals(stored.auth_id, "auth-admin-1");
      assert(/^[0-9a-f]{64}$/.test(String(stored.code_hash)), "hash stored, not the code");
      assert(!JSON.stringify(stored).includes(code), "plaintext code never reaches the database");

      // cooldown: a second request within 30 s is refused without emailing
      const again = await readJson(await handler(post(ADMIN_TOKEN, { action: "request" })));
      assertEquals(again.status, 429);
      assertEquals(world.resend.calls.length, 1);

      // wrong code → attempts + 1, not consumed
      world.db.tables.admin_login_codes[0].attempts = 0;
      world.db.tables.admin_login_codes[0].consumed_at = null;
      const wrongCode = code === "000000" ? "000001" : "000000";
      const wrong = await readJson(await handler(post(ADMIN_TOKEN, { action: "verify", code: wrongCode })));
      assertEquals(wrong.status, 400);
      assertEquals(wrong.body.verified, false);
      assertEquals(world.db.tables.admin_login_codes[0].attempts, 1);
      assertEquals(world.db.tables.admin_login_codes[0].consumed_at, null);

      // right code → verified and consumed; a replay is refused
      const ok = await readJson(await handler(post(ADMIN_TOKEN, { action: "verify", code })));
      assertEquals(ok.status, 200);
      assertEquals(ok.body, { verified: true });
      assert(typeof world.db.tables.admin_login_codes[0].consumed_at === "string");
      const replay = await readJson(await handler(post(ADMIN_TOKEN, { action: "verify", code })));
      assertEquals(replay.status, 400);
      assertEquals(replay.body.error, "Request a new code.");

      // malformed code / unknown action
      assertEquals((await readJson(await handler(post(ADMIN_TOKEN, { action: "verify", code: "12" })))).status, 400);
      assertEquals((await readJson(await handler(post(ADMIN_TOKEN, { action: "nope" })))).status, 400);
    });
  } finally {
    world.restore();
  }
});

test("admin-2fa: Resend 500 → 502 (hash row already inserted — documents current behaviour)", async () => {
  setEnv();
  const world = makeWorld();
  try {
    await quiet(async () => {
      const handler = await setup(world);
      world.resend.mode = 500;
      const res = await readJson(await handler(post(ADMIN_TOKEN, { action: "request" })));
      assertEquals(res.status, 502);
      assertStringIncludes(String(res.body.error), "Could not send the code");
      assertEquals(world.db.tables.admin_login_codes.length, 1, "the row is inserted before the send and not rolled back");
    });
  } finally {
    world.restore();
  }
});
