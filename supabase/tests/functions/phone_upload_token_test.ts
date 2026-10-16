// phone-upload-token — hermetic tests (see _harness.ts). Runs the real
// supabase/functions/phone-upload-token/index.ts against in-process mocks of
// PostgREST (tables + the _by_token RPC) and storage-api (HEAD object, sign).
// docs/selfhost-migration/phase-g/phone-upload-jit.md
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { loadHandler, makeWorld, readJson, SERVICE_ROLE_KEY, setEnv, test } from "./_harness.ts";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const SESSION_ID = "pimg-0123456789abcdef0123456789abcdef";
const PATH = `org/${ORG}/temp/${SESSION_ID}`;
const QR_TOKEN = "a".repeat(32) + "b".repeat(32) + "c".repeat(32) + "d".repeat(32); // 128 hex, like create_product_image_upload_session

const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

// The digest the database computes for QR_TOKEN:
//   SELECT encode(sha256(convert_to('<QR_TOKEN>', 'UTF8')), 'hex');
// (value returned by product_image_upload_token_hash() on lucashome, schema 079, 2026-10-12)
const EXPECTED_DB_HASH = "674af772e6711f431a11545346445bfd89a6857643adae148392e0360f578c2b";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const req = (body: unknown, init: { method?: string; raw?: string } = {}) =>
  new Request("http://functions.local/phone-upload-token", {
    method: init.method ?? "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer anon-key-jwt", apikey: "anon-key-jwt" },
    body: init.method === "GET" ? undefined : init.raw ?? JSON.stringify(body),
  });

const quiet = async (fn: () => Promise<void>) => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try { await fn(); } finally { console.log = log; console.error = error; }
};

type World = ReturnType<typeof makeWorld>;

const seed = async (world: World, over: Record<string, unknown> = {}) => {
  world.db.seed({
    product_image_upload_sessions: [{
      id: SESSION_ID,
      token_hash: EXPECTED_DB_HASH,
      created_by: "u-admin-a",
      shop_id: "shop-a",
      product_id: "prod-a",
      storage_path: PATH,
      signed_upload_token: null,
      status: "PENDING",
      expires_at: inMinutes(9),
      ...over,
    }],
    users: [
      { id: "u-admin-a", org_id: ORG, is_active: true, name: "Owner A", email: "a@example.test" },
      { id: "u-admin-b", org_id: OTHER_ORG, is_active: true, name: "Owner B", email: "b@example.test" },
    ],
    products: [
      { id: "prod-a", org_id: ORG, name: "Tea" },
      { id: "prod-b", org_id: OTHER_ORG, name: "Coffee" },
    ],
    shops: [
      { id: "shop-a", org_id: ORG, name: "Shop A" },
      { id: "shop-b", org_id: OTHER_ORG, name: "Shop B" },
    ],
    // 085: read by the function before it deletes a refused object (references)
    business_profile: [
      { id: "bp-a", org_id: ORG, logo_url: null },
      { id: "bp-b", org_id: OTHER_ORG, logo_url: "https://pos.test/storage/v1/object/public/product-images/org/org-b/products/brand/logo.webp" },
    ],
  });
  // The real _by_token RPC (019/075): stamps EXPIRED on a PENDING row past
  // expires_at, never raises for a known token.
  world.db.rpcs["get_product_image_upload_session_by_token"] = (args) => {
    const rows = world.db.tables.product_image_upload_sessions;
    const row = rows.find((r) => r.id === SESSION_ID);
    if (!row || args.p_token !== QR_TOKEN) return [400, { code: "P0001", message: "Invalid upload link" }];
    if (row.status === "PENDING" && Date.parse(String(row.expires_at)) <= Date.now()) {
      row.status = "EXPIRED";
      row.signed_upload_token = null;
    }
    return [200, { sessionId: row.id, storagePath: row.storage_path, status: row.status, expiresAt: row.expires_at, uploadToken: null }];
  };
  // The 081 limiter (claim_phone_upload_token_issue), modelled: per-session
  // burst of 5 (no clock here: tests reset it explicitly) and a lifetime cap
  // of 20. Tests override world.db.rpcs[CLAIM] for other answers.
  world.db.rpcs[CLAIM] = (args) => {
    const row = world.db.tables.product_image_upload_sessions.find((r) => r.id === SESSION_ID);
    if (!row || args.p_token !== QR_TOKEN) return [200, { allowed: false, reason: "invalid" }];
    if (row.status !== "PENDING") return [200, { allowed: false, reason: "inactive", status: row.status }];
    const issued = Number(row.token_issue_count ?? 0);
    const windowCount = Number(row.token_window_count ?? 0);
    if (issued >= 20) return [200, { allowed: false, reason: "rate_limited", scope: "session", retry_after_seconds: 412 }];
    if (windowCount >= 5) return [200, { allowed: false, reason: "rate_limited", scope: "session_burst", retry_after_seconds: 7 }];
    row.token_issue_count = issued + 1;
    row.token_window_count = windowCount + 1;
    return [200, { allowed: true, issued: issued + 1, remaining: 19 - issued }];
  };
  return await loadHandler("phone-upload-token");
};

const CLAIM = "claim_phone_upload_token_issue";
const CLAIM_TRACE = `db:POST rpc/${CLAIM}`;

const run = async (fn: (world: World) => Promise<void>) => {
  setEnv();
  const world = makeWorld();
  try {
    await quiet(() => fn(world));
  } finally {
    world.restore();
  }
};

/** Everything a response may never contain. */
const assertNoLeak = (text: string) => {
  assert(!text.includes(SERVICE_ROLE_KEY), "service-role key in the response");
  for (const s of [SESSION_ID.slice(5), "u-admin-a", "prod-a", "shop-a", "Owner A", "Tea", "Shop A", QR_TOKEN]) {
    // the session id is part of the object path by design (org/<org>/temp/<id>); check it only outside `path`
    if (s === SESSION_ID.slice(5)) continue;
    assert(!text.includes(s), `response leaks ${s}`);
  }
};

test("phone-upload-token: the test digest is the database's product_image_upload_token_hash() value", async () => {
  // seed() stores EXPECTED_DB_HASH (the database's own value) as token_hash, so
  // every 200 below also proves the function hashes exactly like the database.
  assertEquals(await sha256Hex(QR_TOKEN), EXPECTED_DB_HASH);
});

test("phone-upload-token: valid PENDING session -> a signed token for exactly the session path, nothing else", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const res = await handler(req({ token: QR_TOKEN }));
    const text = await res.text();
    assertEquals(res.status, 200, text);
    assertEquals(res.headers.get("cache-control"), "no-store");
    const body = JSON.parse(text);
    assertEquals(Object.keys(body).sort(), ["expiresAt", "path", "token"]);
    assertEquals(body.path, PATH);
    assertEquals(world.storage.signed.length, 1);
    assertEquals(world.storage.signed[0], { bucket: "product-images", path: PATH, upsert: false, token: body.token });
    const payload = JSON.parse(atob(body.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    assertEquals(payload.url, `product-images/${PATH}`);
    assertEquals(body.expiresAt, new Date(payload.exp * 1000).toISOString());
    assertNoLeak(text.replace(body.path, "<path>"));
    // the row is read with the service role; the only write is the limiter's counter (no token stored)
    assertEquals(world.trace(), [
      "db:GET product_image_upload_sessions",
      "db:GET users",
      "db:GET products",
      "db:GET shops",
      CLAIM_TRACE,
      "storage:HEAD object",
      "storage:POST sign",
    ]);
    // the limiter got the raw QR token (it hashes it itself, like _by_token) and nothing else
    const claimCall = world.calls.find((c) => c.path.endsWith(`/rpc/${CLAIM}`))!;
    assertEquals(claimCall.body, { p_token: QR_TOKEN });
    assertEquals(world.db.tables.product_image_upload_sessions[0].token_issue_count, 1);
    assertEquals(world.db.tables.product_image_upload_sessions[0].signed_upload_token, null);
    assertEquals(world.db.tables.product_image_upload_sessions[0].status, "PENDING");
    // the lookup used the hash, never the raw token
    const lookup = world.calls[0].url;
    assertStringIncludes(lookup, `token_hash=eq.${EXPECTED_DB_HASH}`);
    assert(!lookup.includes(QR_TOKEN));
  });
});

test("phone-upload-token: refresh while PENDING issues a new token each time for the same path (only the limiter writes)", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const a = await readJson(await handler(req({ token: QR_TOKEN })));
    const b = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals([a.status, b.status], [200, 200]);
    assert(a.body.token !== b.body.token);
    assertEquals([a.body.path, b.body.path], [PATH, PATH]);
    assertEquals(world.calls.filter((c) => c.method === "PATCH" || c.method === "POST" && c.kind === "postgrest" && !c.path.endsWith(`/rpc/${CLAIM}`)).length, 0);
    assertEquals(world.calls.filter((c) => c.path.endsWith(`/rpc/${CLAIM}`)).length, 2);
  });
});

test("phone-upload-token: wrong / short / missing token -> generic 404, no storage call", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const wrong = [
      QR_TOKEN.slice(0, -1) + "e",
      "f".repeat(128),
      await sha256Hex(QR_TOKEN), // the stored hash itself is not a token
      SESSION_ID,
    ];
    for (const t of wrong) {
      const res = await handler(req({ token: t }));
      const text = await res.text();
      assertEquals(res.status, 404, t);
      assertEquals(JSON.parse(text), { error: "Invalid upload link.", code: "invalid" });
    }
    for (const body of [{ token: "short" }, {}, { token: 123 }, { token: "x".repeat(600) }]) {
      const r = await readJson(await handler(req(body)));
      assertEquals(r.status, 404);
      assertEquals(r.body.code, "invalid");
    }
    const bad = await handler(req(null, { raw: "{not json" }));
    assertEquals(bad.status, 400);
    assertEquals(world.storage.calls.length, 0);
    assertEquals(world.calls.filter((c) => c.method !== "GET").length, 0);
  });
});

test("phone-upload-token: expired PENDING session -> 410 expired, row stamped EXPIRED via _by_token, no token", async () => {
  await run(async (world) => {
    const handler = await seed(world, { expires_at: new Date(Date.now() - 1000).toISOString(), signed_upload_token: "old" });
    const res = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals(res.status, 410);
    assertEquals(res.body, { error: "This upload link has expired.", code: "inactive", status: "EXPIRED" });
    const row = world.db.tables.product_image_upload_sessions[0];
    assertEquals(row.status, "EXPIRED");
    assertEquals(row.signed_upload_token, null);
    assertEquals(world.trace(), ["db:GET product_image_upload_sessions", "db:POST rpc/get_product_image_upload_session_by_token"]);
    assertEquals(world.storage.calls.length, 0);
    // a second call now sees EXPIRED directly
    const again = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals(again.status, 410);
    assertEquals(again.body.status, "EXPIRED");
  });
});

for (const status of ["CANCELED", "COMPLETED", "EXPIRED"]) {
  test(`phone-upload-token: ${status} session -> 410 with that status, no token, no write`, async () => {
    await run(async (world) => {
      const handler = await seed(world, { status });
      const res = await readJson(await handler(req({ token: QR_TOKEN })));
      assertEquals(res.status, 410);
      assertEquals(res.body.code, "inactive");
      assertEquals(res.body.status, status);
      assertEquals(world.trace(), ["db:GET product_image_upload_sessions"]);
      assertEquals(world.storage.signed.length, 0);
    });
  });
}

test("phone-upload-token: product moved to another org -> 403 refused, nothing signed", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    world.db.tables.products[0].org_id = OTHER_ORG;
    const res = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals(res.status, 403);
    assertEquals(res.body, { error: "This upload link can no longer be used.", code: "refused" });
    assertEquals(world.storage.calls.length, 0);
  });
});

test("phone-upload-token: product deleted, shop of another org, creator deactivated or moved -> 403", async () => {
  const cases: [string, (w: World) => void][] = [
    ["product deleted", (w) => { w.db.tables.products = w.db.tables.products.filter((p) => p.id !== "prod-a"); }],
    ["shop in another org", (w) => { w.db.tables.shops[0].org_id = OTHER_ORG; }],
    ["creator deactivated", (w) => { w.db.tables.users[0].is_active = false; }],
    ["creator moved to another org (path no longer matches)", (w) => { w.db.tables.users[0].org_id = OTHER_ORG; }],
    ["creator deleted", (w) => { w.db.tables.users = w.db.tables.users.slice(1); }],
  ];
  for (const [name, mutate] of cases) {
    await run(async (world) => {
      const handler = await seed(world);
      mutate(world);
      const res = await readJson(await handler(req({ token: QR_TOKEN })));
      assertEquals(res.status, 403, name);
      assertEquals(world.storage.signed.length, 0, name);
    });
  }
});

test("phone-upload-token: the path is re-derived from the row; a tampered or legacy storage_path is refused", async () => {
  for (const storage_path of [`temp/${SESSION_ID}`, `org/${OTHER_ORG}/temp/${SESSION_ID}`, `org/${ORG}/temp/pimg-other`, `org/${ORG}/products/prod-a/x.webp`]) {
    await run(async (world) => {
      const handler = await seed(world, { storage_path });
      const res = await readJson(await handler(req({ token: QR_TOKEN, path: PATH })));
      assertEquals(res.status, 403, storage_path);
      assertEquals(world.storage.signed.length, 0);
    });
  }
});

test("phone-upload-token: client-supplied path / bucket / ids in the body are ignored", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const res = await readJson(await handler(req({ token: QR_TOKEN, path: `org/${OTHER_ORG}/temp/x`, bucket: "other", productId: "prod-b", upsert: true })));
    assertEquals(res.status, 200);
    assertEquals(res.body.path, PATH);
    assertEquals(world.storage.signed[0].path, PATH);
    assertEquals(world.storage.signed[0].upsert, false);
  });
});

test("phone-upload-token: session without product/shop is fine (no product/shop lookup)", async () => {
  await run(async (world) => {
    const handler = await seed(world, { product_id: null, shop_id: null });
    const res = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals(res.status, 200);
    assertEquals(world.trace(), ["db:GET product_image_upload_sessions", "db:GET users", CLAIM_TRACE, "storage:HEAD object", "storage:POST sign"]);
  });
});

test("phone-upload-token: object already uploaded -> { alreadyUploaded, path } and NO new token", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    world.storage.objects.add(`product-images/${PATH}`);
    const res = await handler(req({ token: QR_TOKEN }));
    const text = await res.text();
    assertEquals(res.status, 200);
    assertEquals(JSON.parse(text), { alreadyUploaded: true, path: PATH });
    assertEquals(world.storage.signed.length, 0);
    assert(!text.includes(SERVICE_ROLE_KEY));
  });
});

test("phone-upload-token: storage / database failures -> generic 503, no details, no key", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    world.storage.failSign = 500;
    const res = await handler(req({ token: QR_TOKEN }));
    const text = await res.text();
    assertEquals(res.status, 503);
    assertEquals(JSON.parse(text), { error: "Phone upload is temporarily unavailable. Try again.", code: "unavailable" });
    assert(!text.includes(SERVICE_ROLE_KEY));
    assert(!text.includes("simulated"));
  });
  await run(async (world) => {
    const handler = await seed(world);
    world.db.failures.push({ method: "GET", table: "product_image_upload_sessions", status: 500, message: "boom secret detail" });
    const res = await handler(req({ token: QR_TOKEN }));
    const text = await res.text();
    assertEquals(res.status, 503);
    assert(!text.includes("boom"));
  });
});

test("phone-upload-token: missing service config -> 503 before any call; CORS preflight; GET refused", async () => {
  setEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined });
  const world = makeWorld();
  try {
    await quiet(async () => {
      const handler = await loadHandler("phone-upload-token");
      const r = await handler(req({ token: QR_TOKEN }));
      assertEquals(r.status, 503);
      assertEquals(world.calls.length, 0);
      const pre = await handler(new Request("http://functions.local/phone-upload-token", { method: "OPTIONS" }));
      assertEquals(pre.status, 200);
      assertEquals(pre.headers.get("access-control-allow-origin"), "*");
      assertStringIncludes(pre.headers.get("access-control-allow-headers") ?? "", "apikey");
      const get = await handler(req(null, { method: "GET" }));
      assertEquals(get.status, 405);
    });
  } finally {
    world.restore();
    setEnv();
  }
});

// ---------------------------------------------------------------- 081 rate limits
// docs/selfhost-migration/phase-f/rate-limiting.md

test("phone-upload-token 081: burst exceeded -> 429 rate_limited + Retry-After, nothing signed, no storage call", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const ok: number[] = [];
    for (let i = 0; i < 5; i++) ok.push((await handler(req({ token: QR_TOKEN }))).status);
    assertEquals(ok, [200, 200, 200, 200, 200]);
    const storageBefore = world.storage.calls.length;
    const res = await handler(req({ token: QR_TOKEN }));
    const text = await res.text();
    assertEquals(res.status, 429);
    assertEquals(res.headers.get("retry-after"), "7");
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertStringIncludes(res.headers.get("access-control-expose-headers") ?? "", "Retry-After");
    assertEquals(JSON.parse(text), { error: "Too many upload attempts. Please wait a moment and try again.", code: "rate_limited", retry_after_seconds: 7 });
    assertEquals(world.storage.calls.length, storageBefore, "no HEAD / sign after a refusal");
    assertEquals(world.storage.signed.length, 5);
    assertNoLeak(text);
    assert(!text.includes("session_burst"), "the limiter scope stays server-side");
  });
});

test("phone-upload-token 081: lifetime cap -> 429 with Retry-After = seconds until the session expires", async () => {
  await run(async (world) => {
    const handler = await seed(world, { token_issue_count: 20 });
    const res = await handler(req({ token: QR_TOKEN }));
    assertEquals(res.status, 429);
    assertEquals(res.headers.get("retry-after"), "412");
    assertEquals((await res.json()).retry_after_seconds, 412);
    assertEquals(world.storage.calls.length, 0);
  });
});

test("phone-upload-token 081: retry_after is clamped to an integer 1..3600 (header and body agree)", async () => {
  for (const [given, expected] of [[0, 1], [0.2, 1], [9.1, 10], [99999, 3600]] as const) {
    await run(async (world) => {
      const handler = await seed(world);
      world.db.rpcs[CLAIM] = () => [200, { allowed: false, reason: "rate_limited", scope: "org", retry_after_seconds: given }];
      const res = await handler(req({ token: QR_TOKEN }));
      assertEquals(res.status, 429, String(given));
      assertEquals(res.headers.get("retry-after"), String(expected));
      assertEquals((await res.json()).retry_after_seconds, expected);
    });
  }
});

test("phone-upload-token 081: FAIL CLOSED - limiter RPC error / missing (pre-081 schema) / permission denied -> 503, no token, no storage call", async () => {
  const failures: [string, number, unknown][] = [
    ["db error", 500, { code: "XX000", message: "boom secret detail", details: null, hint: null }],
    ["function missing (schema < 081)", 404, { code: "PGRST202", message: "Could not find the function public.claim_phone_upload_token_issue(p_token) in the schema cache", details: null, hint: null }],
    ["permission denied", 403, { code: "42501", message: "permission denied for function claim_phone_upload_token_issue", details: null, hint: null }],
    ["gateway timeout", 504, { message: "upstream timeout" }],
  ];
  for (const [name, status, body] of failures) {
    await run(async (world) => {
      const handler = await seed(world);
      world.db.rpcs[CLAIM] = () => [status, body];
      const res = await handler(req({ token: QR_TOKEN }));
      const text = await res.text();
      assertEquals(res.status, 503, name);
      assertEquals(JSON.parse(text), { error: "Phone upload is temporarily unavailable. Try again.", code: "unavailable" }, name);
      assertEquals(world.storage.calls.length, 0, name);
      assertEquals(world.storage.signed.length, 0, name);
      assert(!text.includes("boom") && !text.includes("PGRST") && !text.includes(SERVICE_ROLE_KEY), name);
    });
  }
});

test("phone-upload-token 081: FAIL CLOSED - unexpected limiter answers never issue a token", async () => {
  const answers: unknown[] = [
    null,
    {},
    { allowed: "true" },
    { allowed: 1 },
    { allowed: false },
    { allowed: false, reason: "rate_limited" },
    { allowed: false, reason: "rate_limited", retry_after_seconds: "5" },
    { allowed: false, reason: "rate_limited", retry_after_seconds: null },
    { allowed: false, reason: "something-new" },
    [{ allowed: true }],
    "allowed",
  ];
  for (const answer of answers) {
    await run(async (world) => {
      const handler = await seed(world);
      world.db.rpcs[CLAIM] = () => [200, answer];
      const res = await handler(req({ token: QR_TOKEN }));
      assertEquals(res.status, 503, JSON.stringify(answer));
      assertEquals(world.storage.signed.length, 0, JSON.stringify(answer));
      assertEquals(world.storage.calls.length, 0, JSON.stringify(answer));
    });
  }
});

test("phone-upload-token 081: limiter says inactive / invalid / refused (state changed between the read and the claim) -> 410 / 404 / 403", async () => {
  const cases: [unknown, number, Record<string, unknown>][] = [
    [{ allowed: false, reason: "inactive", status: "COMPLETED" }, 410, { error: "This upload link is no longer active.", code: "inactive", status: "COMPLETED" }],
    [{ allowed: false, reason: "inactive", status: "EXPIRED" }, 410, { error: "This upload link has expired.", code: "inactive", status: "EXPIRED" }],
    [{ allowed: false, reason: "invalid" }, 404, { error: "Invalid upload link.", code: "invalid" }],
    [{ allowed: false, reason: "refused" }, 403, { error: "This upload link can no longer be used.", code: "refused" }],
  ];
  for (const [answer, status, body] of cases) {
    await run(async (world) => {
      const handler = await seed(world);
      world.db.rpcs[CLAIM] = () => [200, answer];
      const res = await readJson(await handler(req({ token: QR_TOKEN })));
      assertEquals(res.status, status, JSON.stringify(answer));
      assertEquals(res.body, body);
      assertEquals(world.storage.calls.length, 0);
    });
  }
});

test("phone-upload-token 081: the limiter is consulted only after every session check (invalid / inactive / refused never count)", async () => {
  await run(async (world) => {
    const handler = await seed(world, { status: "CANCELED" });
    await handler(req({ token: QR_TOKEN }));
    await handler(req({ token: "f".repeat(128) }));
    await handler(req({ token: "short" }));
    assertEquals(world.calls.filter((c) => c.path.endsWith(`/rpc/${CLAIM}`)).length, 0);
  });
  await run(async (world) => {
    const handler = await seed(world);
    world.db.tables.products[0].org_id = OTHER_ORG;
    assertEquals((await handler(req({ token: QR_TOKEN }))).status, 403);
    assertEquals(world.calls.filter((c) => c.path.endsWith(`/rpc/${CLAIM}`)).length, 0);
  });
});

test("phone-upload-token 081: the claim comes BEFORE the storage HEAD, so a rate-limited caller costs storage nothing (alreadyUploaded included)", async () => {
  await run(async (world) => {
    const handler = await seed(world, { token_window_count: 5 });
    world.storage.objects.add(`product-images/${PATH}`);
    const res = await handler(req({ token: QR_TOKEN }));
    assertEquals(res.status, 429);
    assertEquals(world.storage.calls.length, 0);
  });
  await run(async (world) => {
    const handler = await seed(world);
    world.storage.objects.add(`product-images/${PATH}`);
    const res = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals(res.body, { alreadyUploaded: true, path: PATH });
    assertEquals(world.trace().slice(-2), [CLAIM_TRACE, "storage:HEAD object"]);
  });
});

test("phone-upload-token 081: concurrent requests are decided by the database, not the worker (no in-memory counter)", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    // 12 in flight at once: the modelled DB allows exactly 5 (burst), the rest 429
    const results = await Promise.all(Array.from({ length: 12 }, async () => (await handler(req({ token: QR_TOKEN }))).status));
    assertEquals(results.filter((s) => s === 200).length, 5);
    assertEquals(results.filter((s) => s === 429).length, 7);
    assertEquals(world.calls.filter((c) => c.path.endsWith(`/rpc/${CLAIM}`)).length, 12);
    // a fresh DB window (reset in the DB) is honoured immediately by the same worker
    world.db.tables.product_image_upload_sessions[0].token_window_count = 0;
    assertEquals((await handler(req({ token: QR_TOKEN }))).status, 200);
  });
});

// ---------------------------------------------------------------- 083 (G5) completion with a byte check
// docs/selfhost-migration/phase-f/migration-083-g5.md

const KEY = `product-images/${PATH}`;
const COMPLETE = "complete_product_image_upload_session";
const bytesOf = (...parts: (number[] | string | Uint8Array)[]) => {
  const chunks = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};
const filler = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => 0x10 + (i % 64)));
const jpeg = (n = 2000) => bytesOf([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF", [0x00], filler(n), [0xff, 0xd9]);
const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const webp = (n = 1500) => bytesOf("RIFF", le32(n + 12), "WEBP", "VP8 ", le32(n), filler(n));
const png = () => bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR", filler(40));

const completeReq = () => req({ token: QR_TOKEN, action: "complete" });
const touchedStorage = (world: World) => world.trace().some((t) => t.startsWith("storage:"));

/**
 * The completion RPC (called by the function with the service role; 083
 * grants), modelled: schema "085" accepts jpeg/png/webp, "083" (production
 * before 085; the 080 body) only jpeg/webp. Like the real RPC, the size and
 * type it checks second come from the stored object, not the caller.
 */
const withCompleteRpc = (world: World, schema: "083" | "085" = "085") => {
  const calls: Record<string, unknown>[] = [];
  const types = schema === "085" ? ["image/jpeg", "image/png", "image/webp"] : ["image/jpeg", "image/webp"];
  world.db.rpcs[COMPLETE] = (args) => {
    calls.push(args);
    const row = world.db.tables.product_image_upload_sessions.find((r) => r.id === SESSION_ID)!;
    if (args.p_token !== QR_TOKEN) return [400, { code: "P0001", message: "Invalid upload link" }];
    if (row.status !== "PENDING") return [400, { code: "P0001", message: "Upload link is no longer active" }];
    if (args.p_storage_path !== row.storage_path) return [400, { code: "P0001", message: "Upload path does not match this session" }];
    if (Number(args.p_bytes) <= 0 || Number(args.p_bytes) > 102400) return [400, { code: "P0001", message: "Uploaded image must be 100 KB or smaller" }];
    if (!types.includes(String(args.p_mime_type))) return [400, { code: "P0001", message: "Unsupported uploaded image type" }];
    const stored = world.storage.contents.get(KEY);
    if (!world.storage.objects.has(KEY) || !stored) return [400, { code: "P0001", message: "Uploaded image was not found in storage" }];
    if (!types.includes(stored.type)) return [400, { code: "P0001", message: "Unsupported uploaded image type" }];
    row.status = "COMPLETED";
    row.completed_at = new Date().toISOString();
    row.public_url = `https://pos.test/storage/v1/object/public/product-images/${row.storage_path}`;
    return [200, {
      sessionId: row.id,
      storagePath: row.storage_path,
      publicUrl: row.public_url,
      bytes: args.p_bytes,
      mimeType: args.p_mime_type,
      expiresAt: row.expires_at,
      status: "COMPLETED",
    }];
  };
  return calls;
};

test("phone-upload-token 083: valid JPEG and WebP -> completed through the RPC (service role) with values from the stored object; no token, no rate-limit claim", async () => {
  for (const [bytes, type] of [[jpeg(), "image/jpeg"], [webp(), "image/webp"]] as const) {
    await run(async (world) => {
      const handler = await seed(world);
      const rpcCalls = withCompleteRpc(world);
      world.storage.put(KEY, bytes, type);
      const res = await handler(completeReq());
      const text = await res.text();
      assertEquals(res.status, 200, text);
      const body = JSON.parse(text);
      assertEquals(body.status, "COMPLETED");
      assertEquals(body.storagePath, PATH);
      assertEquals(rpcCalls.length, 1);
      assertEquals(rpcCalls[0].p_storage_path, PATH);
      assertEquals(rpcCalls[0].p_bytes, bytes.length);
      assertEquals(rpcCalls[0].p_mime_type, type);
      assertEquals(new URL(String(rpcCalls[0].p_public_url)).pathname, `/storage/v1/object/public/product-images/${PATH}`);
      assertEquals(world.storage.signed.length, 0);
      assertEquals(world.storage.deleted, []);
      assertEquals(world.trace(), [
        "db:GET product_image_upload_sessions",
        "db:GET users",
        "db:GET products",
        "db:GET shops",
        "storage:GET object",
        `db:POST rpc/${COMPLETE}`,
      ]);
      assert(!text.includes(SERVICE_ROLE_KEY));
    });
  }
});

test("phone-upload-token 083: refused content -> 422 invalid_image, the object is DELETED, the session is not completed", async () => {
  const cases: [string, Uint8Array, string][] = [
    ["text/html declared", bytesOf("<!doctype html><html><body>hi</body></html>"), "text/html"],
    ["image/svg+xml declared", bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml"],
    ["application/octet-stream declared (JPEG bytes)", jpeg(), "application/octet-stream"],
    [".jpg with HTML content (declared image/jpeg)", bytesOf("<html><script>alert(document.domain)</script></html>"), "image/jpeg"],
    ["SVG content declared image/jpeg", bytesOf('<svg onload="alert(1)"/>'), "image/jpeg"],
    ["JPEG header + HTML polyglot", bytesOf([0xff, 0xd8, 0xff, 0xe0], "<html><body><script>alert(1)</script>", [0xff, 0xd9]), "image/jpeg"],
    ["JPEG with an upper-case <SCRIPT> in the middle", bytesOf(jpeg(500), "<SCRIPT>x</SCRIPT>", jpeg(500)), "image/jpeg"],
    ["WebP + trailing HTML (RIFF size mismatch)", bytesOf(webp(200), "<html></html>"), "image/webp"],
    ["WebP bytes declared image/jpeg", webp(), "image/jpeg"],
    ["PNG bytes declared image/jpeg (wrong magic)", png(), "image/jpeg"],
    ["JPEG bytes declared image/png (wrong magic)", jpeg(), "image/png"],
    ["PNG signature without an IHDR chunk", bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], filler(40)), "image/png"],
    ["PNG with an <html> payload", bytesOf(png(), "<html><script>alert(1)</script></html>"), "image/png"],
    ["over 100 KB", jpeg(102400), "image/jpeg"],
    ["PNG over 100 KB", bytesOf(png(), filler(102400)), "image/png"],
    ["empty object", new Uint8Array(0), "image/jpeg"],
  ];
  for (const [label, bytes, type] of cases) {
    await run(async (world) => {
      const handler = await seed(world);
      const rpcCalls = withCompleteRpc(world);
      world.storage.put(KEY, bytes, type);
      const res = await handler(completeReq());
      const text = await res.text();
      assertEquals(res.status, 422, `${label}: ${text}`);
      assertEquals(JSON.parse(text).code, "invalid_image", label);
      assertEquals(world.storage.deleted, [KEY], `${label}: the object must be deleted`);
      assert(!world.storage.objects.has(KEY), label);
      assertEquals(rpcCalls.length, 0, `${label}: the RPC must not be called`);
      assertEquals(world.db.tables.product_image_upload_sessions[0].status, "PENDING", label);
      assert(!text.includes(SERVICE_ROLE_KEY));
    });
  }
});

test("phone-upload-token 083: after a refusal the phone can upload a real photo to the same path and complete", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    withCompleteRpc(world);
    world.storage.put(KEY, bytesOf("<html></html>"), "image/jpeg");
    assertEquals((await handler(completeReq())).status, 422);
    // the path is free again: a fresh signed token for it (no alreadyUploaded)
    const tok = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals(tok.status, 200);
    assertEquals(tok.body.path, PATH);
    assert(typeof tok.body.token === "string");
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const done = await readJson(await handler(completeReq()));
    assertEquals(done.status, 200);
    assertEquals(done.body.status, "COMPLETED");
  });
});

test("phone-upload-token 083: nothing uploaded -> 409 not_uploaded; no delete, no RPC", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world);
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 409);
    assertEquals(res.body.code, "not_uploaded");
    assertEquals(world.storage.deleted, []);
    assertEquals(rpcCalls.length, 0);
  });
});

test("phone-upload-token 083: completed / expired / foreign-org sessions are refused before storage is read; nothing is deleted", async () => {
  await run(async (world) => {
    const handler = await seed(world, { status: "COMPLETED" });
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 410);
    assertEquals(res.body.status, "COMPLETED");
    assert(!touchedStorage(world));
  });
  await run(async (world) => {
    const handler = await seed(world, { expires_at: new Date(Date.now() - 1000).toISOString() });
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 410);
    assert(!touchedStorage(world));
  });
  await run(async (world) => {
    const handler = await seed(world, { product_id: "prod-b" });
    world.storage.put(KEY, bytesOf("<html></html>"), "image/jpeg");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 403);
    assert(!touchedStorage(world));
    assert(world.storage.objects.has(KEY), "a refused session must not delete anything");
  });
  await run(async (world) => {
    const handler = await seed(world, { storage_path: `org/${OTHER_ORG}/temp/${SESSION_ID}` });
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 403);
    assert(!touchedStorage(world));
  });
});

test("phone-upload-token 083: a concurrent completion that won the race -> 410 with the session's status; the valid object stays", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    world.db.rpcs[COMPLETE] = () => {
      world.db.tables.product_image_upload_sessions[0].status = "COMPLETED";
      return [400, { code: "P0001", message: "Upload link is no longer active" }];
    };
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 410);
    assertEquals(res.body.status, "COMPLETED");
    assertEquals(world.storage.deleted, []);
  });
});

test("phone-upload-token 083: RPC refusal -> 422 completion_refused (its generic message); RPC / storage failure -> 503 without details", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    world.db.rpcs[COMPLETE] = () => [400, { code: "P0001", message: "Phone image upload is not configured on this server" }];
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 422);
    assertEquals(res.body, { error: "Phone image upload is not configured on this server", code: "completion_refused" });
    // 085: the refused (PENDING) session's object is removed, not left behind
    assertEquals(world.storage.deleted, [KEY]);
  });
  await run(async (world) => {
    const handler = await seed(world);
    world.db.rpcs[COMPLETE] = () => [401, { code: "42501", message: "permission denied for function complete_product_image_upload_session" }];
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const res = await handler(completeReq());
    const text = await res.text();
    assertEquals(res.status, 503);
    assert(!text.includes("permission"));
    // unknown outcome: never delete
    assertEquals(world.storage.deleted, []);
  });
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world);
    world.storage.put(KEY, jpeg(), "image/jpeg");
    world.storage.failGet = 500;
    const res = await handler(completeReq());
    assertEquals(res.status, 503);
    await res.body?.cancel();
    assertEquals(rpcCalls.length, 0);
    assertEquals(world.storage.deleted, []);
  });
});

test("phone-upload-token 083: a refused object whose delete fails is still never completed", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world);
    world.storage.put(KEY, bytesOf("<html></html>"), "image/jpeg");
    world.storage.failDelete = 500;
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 422);
    assertEquals(res.body.code, "invalid_image");
    assertEquals(rpcCalls.length, 0);
    assertEquals(world.db.tables.product_image_upload_sessions[0].status, "PENDING");
  });
});

test("phone-upload-token 083: unknown action -> 400 bad_request; wrong token for completion -> 404; neither touches storage", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const bad = await readJson(await handler(req({ token: QR_TOKEN, action: "delete" })));
    assertEquals(bad.status, 400);
    assertEquals(bad.body.code, "bad_request");
    const wrong = await readJson(await handler(req({ token: "z".repeat(64), action: "complete" })));
    assertEquals(wrong.status, 404);
    assert(!touchedStorage(world));
  });
});

// ---------------------------------------------------------------- G5 follow-up: the desktop uses the same flow
// docs/selfhost-migration/phase-f/g5-followups.md §1. The desktop creates the
// session with its own JWT (the server derives org, path, product and shop),
// then calls this function exactly like the phone page. Nothing in the
// request besides the session token may influence what is signed, validated
// or completed.

const desktopReq = (body: unknown) =>
  new Request("http://functions.local/phone-upload-token", {
    method: "POST",
    // a signed-in desktop sends its user JWT; the function must not trust it for anything
    headers: { "Content-Type": "application/json", Authorization: "Bearer user-jwt-claiming-org-b", apikey: "anon-key-jwt", "x-org-id": OTHER_ORG },
    body: JSON.stringify(body),
  });

test("phone-upload-token G5 desktop: a logo session (no product, no shop) gets a token for its own path and completes with a valid WebP", async () => {
  await run(async (world) => {
    const handler = await seed(world, { product_id: null, shop_id: null });
    const rpcCalls = withCompleteRpc(world);
    const tok = await readJson(await handler(desktopReq({ token: QR_TOKEN })));
    assertEquals(tok.status, 200);
    assertEquals(tok.body.path, PATH);
    world.storage.put(KEY, webp(), "image/webp");
    const done = await readJson(await handler(desktopReq({ token: QR_TOKEN, action: "complete" })));
    assertEquals(done.status, 200);
    assertEquals(done.body.status, "COMPLETED");
    assertEquals(done.body.publicUrl, `https://pos.test/storage/v1/object/public/product-images/${PATH}`);
    assertEquals(rpcCalls.length, 1);
    // no product / shop lookups for a session without them
    assert(!world.trace().includes("db:GET products"));
    assert(!world.trace().includes("db:GET shops"));
  });
});

test("phone-upload-token G5 desktop: client-supplied path / org / URL / size / type fields are ignored for the token and the completion", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world);
    const forged = {
      token: QR_TOKEN,
      path: `org/${OTHER_ORG}/products/prod-b/evil.jpg`,
      storagePath: `org/${OTHER_ORG}/temp/pimg-other`,
      orgId: OTHER_ORG,
      publicUrl: "https://evil.example/storage/v1/object/public/product-images/x",
      bytes: 1,
      mimeType: "image/png",
    };
    const tok = await readJson(await handler(desktopReq(forged)));
    assertEquals(tok.status, 200);
    assertEquals(tok.body.path, PATH);
    const bytes = jpeg();
    world.storage.put(KEY, bytes, "image/jpeg");
    const done = await readJson(await handler(desktopReq({ ...forged, action: "complete" })));
    assertEquals(done.status, 200);
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].p_storage_path, PATH);
    assertEquals(rpcCalls[0].p_bytes, bytes.length);
    assertEquals(rpcCalls[0].p_mime_type, "image/jpeg");
    assertEquals(new URL(String(rpcCalls[0].p_public_url)).pathname, `/storage/v1/object/public/product-images/${PATH}`);
    assert(!String(rpcCalls[0].p_public_url).includes("evil.example"));
  });
});

test("phone-upload-token G5 desktop: a polyglot uploaded by the desktop is refused and deleted exactly like a phone upload", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world);
    world.storage.put(KEY, bytesOf([0xff, 0xd8, 0xff, 0xe0], "<html><script>alert(1)</script></html>", [0xff, 0xd9]), "image/jpeg");
    const res = await readJson(await handler(desktopReq({ token: QR_TOKEN, action: "complete" })));
    assertEquals(res.status, 422);
    assertEquals(res.body.code, "invalid_image");
    assertEquals(world.storage.deleted, [KEY]);
    assertEquals(rpcCalls.length, 0);
    assertEquals(world.db.tables.product_image_upload_sessions[0].status, "PENDING");
  });
});

test("phone-upload-token G5 desktop: completion is refused before storage is read when the creator was deactivated or the product moved to another org", async () => {
  const cases: [string, (w: World) => void][] = [
    ["creator deactivated", (w) => { w.db.tables.users[0].is_active = false; }],
    ["creator moved to another org", (w) => { w.db.tables.users[0].org_id = OTHER_ORG; }],
    ["product now of another org", (w) => { w.db.tables.products[0].org_id = OTHER_ORG; }],
  ];
  for (const [label, mutate] of cases) {
    await run(async (world) => {
      const handler = await seed(world);
      const rpcCalls = withCompleteRpc(world);
      world.storage.put(KEY, jpeg(), "image/jpeg");
      mutate(world);
      const res = await readJson(await handler(desktopReq({ token: QR_TOKEN, action: "complete" })));
      assertEquals(res.status, 403, label);
      assertEquals(rpcCalls.length, 0, label);
      assert(!touchedStorage(world), `${label}: storage must not be touched`);
    });
  }
});

// ---------------------------------------------------------------- 085: PNG completes; refused objects never stay behind
// docs/selfhost-migration/phase-f/migration-085-png.md

const TRUSTED_URL = `https://pos.test/storage/v1/object/public/product-images/${PATH}`;
const sessionRow = (world: World) => world.db.tables.product_image_upload_sessions.find((r) => r.id === SESSION_ID)!;

test("phone-upload-token 085: a valid PNG passes the byte check and completes (schema 085), the object is kept", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world, "085");
    const bytes = png();
    world.storage.put(KEY, bytes, "image/png");
    const done = await readJson(await handler(completeReq()));
    assertEquals(done.status, 200);
    assertEquals(done.body.status, "COMPLETED");
    assertEquals(done.body.mimeType, "image/png");
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].p_mime_type, "image/png");
    assertEquals(rpcCalls[0].p_bytes, bytes.length);
    assertEquals(world.storage.deleted, []);
    assert(world.storage.objects.has(KEY));
  });
});

test("phone-upload-token 085: a PNG of exactly 100 KB completes; one byte more is refused and deleted (same size rule as JPEG/WebP)", async () => {
  const atLimit = bytesOf(png(), filler(102400 - png().length));
  assertEquals(atLimit.length, 102400);
  await run(async (world) => {
    const handler = await seed(world);
    withCompleteRpc(world);
    world.storage.put(KEY, atLimit, "image/png");
    const done = await readJson(await handler(completeReq()));
    assertEquals(done.status, 200);
    assertEquals(done.body.bytes, 102400);
  });
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world);
    world.storage.put(KEY, bytesOf(atLimit, [0]), "image/png");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 422);
    assertEquals(res.body.code, "invalid_image");
    assertEquals(rpcCalls.length, 0);
    assertEquals(world.storage.deleted, [KEY]);
  });
});

test("phone-upload-token 085: an oversized object read in different chunks each time is still recognised and deleted (capped read is cut to limit + 1)", async () => {
  for (const [bytes, type] of [[bytesOf(png(), filler(150 * 1024)), "image/png"], [jpeg(150 * 1024), "image/jpeg"]] as const) {
    await run(async (world) => {
      const handler = await seed(world);
      const rpcCalls = withCompleteRpc(world);
      world.storage.chunked = true;
      world.storage.put(KEY, bytes, type);
      const res = await readJson(await handler(completeReq()));
      assertEquals(res.status, 422, type);
      assertEquals(res.body.code, "invalid_image", type);
      assertEquals(rpcCalls.length, 0, type);
      assertEquals(world.storage.deleted, [KEY], type);
    });
  }
});

test("phone-upload-token 085: new function on a schema BEFORE 085 - a valid PNG is refused by the RPC (422 completion_refused) and its object is DELETED, session PENDING", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world, "083");
    world.storage.put(KEY, png(), "image/png");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 422);
    assertEquals(res.body, { error: "Unsupported uploaded image type", code: "completion_refused" });
    assertEquals(rpcCalls.length, 1);
    assertEquals(world.storage.deleted, [KEY]);
    assertEquals(sessionRow(world).status, "PENDING");
    // the order: re-read the session, check references, re-read the object, then delete exactly the session path
    const t = world.trace();
    const i = t.indexOf(`db:POST rpc/${COMPLETE}`);
    assertEquals(t.slice(i + 1, i + 2), ["db:GET product_image_upload_sessions"]);
    assert(t.slice(i).includes("db:GET products") && t.slice(i).includes("db:GET business_profile"));
    const del = world.storage.calls.filter((c) => c.method === "DELETE");
    assertEquals(del.length, 1);
    assertEquals(decodeURIComponent(del[0].path), `/storage/v1/object/${KEY}`);
  });
});

test("phone-upload-token 085: every RPC refusal raised for a PENDING session deletes only the session's object; 'invalid link' / 'no longer active' never delete", async () => {
  const deleting = [
    "Uploaded image must be 100 KB or smaller",
    "Unsupported uploaded image type",
    "Uploaded image was not found in storage",
    "Phone image upload is not configured on this server",
    "Upload path does not match this session",
    "Uploaded image URL does not match this upload session",
  ];
  for (const message of deleting) {
    await run(async (world) => {
      const handler = await seed(world);
      world.db.rpcs[COMPLETE] = () => [400, { code: "P0001", message }];
      world.storage.put(KEY, jpeg(), "image/jpeg");
      // another org's object and another session's object of the same org must survive
      world.storage.put(`product-images/org/${OTHER_ORG}/temp/${SESSION_ID}`, jpeg(), "image/jpeg");
      world.storage.put(`product-images/org/${ORG}/temp/pimg-ffffffffffffffffffffffffffffffff`, jpeg(), "image/jpeg");
      const res = await readJson(await handler(completeReq()));
      assertEquals(res.status, 422, message);
      assertEquals(res.body.code, "completion_refused", message);
      assertEquals(world.storage.deleted, [KEY], message);
      assertEquals(world.storage.objects.size, 2, message);
    });
  }
  for (const [message, status] of [["Invalid upload link", 422], ["Upload link is no longer active", 410]] as const) {
    await run(async (world) => {
      const handler = await seed(world);
      world.db.rpcs[COMPLETE] = () => [400, { code: "P0001", message }];
      world.storage.put(KEY, jpeg(), "image/jpeg");
      const res = await readJson(await handler(completeReq()));
      assertEquals(res.status, status, message);
      assertEquals(world.storage.deleted, [], message);
      assert(world.storage.objects.has(KEY), message);
    });
  }
});

test("phone-upload-token 085: a client-supplied path never reaches the delete (the server-derived session path is used)", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    withCompleteRpc(world, "083");
    const victim = `product-images/org/${ORG}/products/prod-a/1700000000000.webp`;
    world.storage.put(victim, webp(), "image/webp");
    world.storage.put(KEY, png(), "image/png");
    const res = await readJson(await handler(req({ token: QR_TOKEN, action: "complete", path: victim, storagePath: victim, p_storage_path: victim })));
    assertEquals(res.status, 422);
    assertEquals(world.storage.deleted, [KEY]);
    assert(world.storage.objects.has(victim));
  });
});

test("phone-upload-token 085: concurrent completions of one session - exactly one COMPLETED, the winner's object is never deleted", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const rpcCalls = withCompleteRpc(world);
    world.storage.put(KEY, png(), "image/png");
    const [a, b] = await Promise.all([handler(completeReq()), handler(completeReq())].map(async (p) => readJson(await p)));
    assertEquals([a.status, b.status].sort(), [200, 410]);
    const loser = a.status === 410 ? a : b;
    assertEquals(loser.body.status, "COMPLETED");
    assertEquals(rpcCalls.length, 2);
    assertEquals(sessionRow(world).status, "COMPLETED");
    assertEquals(world.storage.deleted, []);
    assert(world.storage.objects.has(KEY));
  });
  await run(async (world) => {
    const handler = await seed(world);
    withCompleteRpc(world);
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const all = await Promise.all(Array.from({ length: 5 }, async () => (await readJson(await handler(completeReq()))).status));
    assertEquals(all.filter((s) => s === 200).length, 1);
    assertEquals(all.filter((s) => s === 410).length, 4);
    assertEquals(world.storage.deleted, []);
  });
});

test("phone-upload-token 085: refusal while a concurrent completion wins in between -> the re-check sees COMPLETED and keeps the object", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    world.db.rpcs[COMPLETE] = () => {
      // this call is refused, but another request completed the session right after
      const row = sessionRow(world);
      row.status = "COMPLETED";
      row.completed_at = new Date().toISOString();
      row.public_url = TRUSTED_URL;
      return [400, { code: "P0001", message: "Phone image upload is not configured on this server" }];
    };
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 422);
    assertEquals(world.storage.deleted, []);
    assert(world.storage.objects.has(KEY));
  });
});

test("phone-upload-token 085: refused objects whose path is referenced are never deleted (product image, logo, a session URL, another session's path)", async () => {
  const cases: [string, (w: World) => void][] = [
    ["products.image_url", (w) => { w.db.tables.products[0].image_url = TRUSTED_URL; }],
    ["business_profile.logo_url", (w) => { w.db.tables.business_profile[0].logo_url = TRUSTED_URL; }],
    ["another session's public_url", (w) => {
      w.db.tables.product_image_upload_sessions.push({ id: "pimg-other", token_hash: "x", created_by: "u-admin-a", storage_path: `org/${ORG}/temp/pimg-other`, status: "COMPLETED", public_url: TRUSTED_URL, completed_at: new Date().toISOString() });
    }],
    ["another (completed) session with the same storage_path", (w) => {
      w.db.tables.product_image_upload_sessions.push({ id: "pimg-dup", token_hash: "y", created_by: "u-admin-a", storage_path: PATH, status: "COMPLETED", public_url: null, completed_at: new Date().toISOString() });
    }],
  ];
  for (const [label, mutate] of cases) {
    for (const via of ["byte check", "rpc"] as const) {
      await run(async (world) => {
        const handler = await seed(world);
        if (via === "rpc") world.db.rpcs[COMPLETE] = () => [400, { code: "P0001", message: "Unsupported uploaded image type" }];
        else withCompleteRpc(world);
        world.storage.put(KEY, via === "rpc" ? jpeg() : bytesOf("<html></html>"), "image/jpeg");
        mutate(world);
        const res = await readJson(await handler(completeReq()));
        assertEquals(res.status, 422, `${label} / ${via}`);
        assertEquals(world.storage.deleted, [], `${label} / ${via}`);
        assert(world.storage.objects.has(KEY), `${label} / ${via}`);
      });
    }
  }
});

test("phone-upload-token 085: an object replaced after validation (a retry's fresh upload) is not deleted; a failed reference check keeps it too", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    world.db.rpcs[COMPLETE] = () => {
      // meanwhile the path was freed and the phone uploaded a new photo
      world.storage.put(KEY, webp(), "image/webp");
      return [400, { code: "P0001", message: "Phone image upload is not configured on this server" }];
    };
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 422);
    assertEquals(world.storage.deleted, []);
    assertEquals(world.storage.contents.get(KEY)?.type, "image/webp");
  });
  // byte-identical re-upload (same bytes, a new upload): ETag / Last-Modified differ -> kept
  await run(async (world) => {
    const handler = await seed(world);
    withCompleteRpc(world);
    const bad = bytesOf("<html></html>");
    world.storage.put(KEY, bad, "image/jpeg");
    world.storage.onGet = (_key, nth) => { if (nth === 2) world.storage.put(KEY, bad, "image/jpeg"); };
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 422);
    assertEquals(world.storage.deleted, []);
  });
  await run(async (world) => {
    const handler = await seed(world);
    world.db.rpcs[COMPLETE] = () => [400, { code: "P0001", message: "Unsupported uploaded image type" }];
    world.db.failures.push({ method: "GET", table: "business_profile", status: 500, message: "simulated" });
    world.storage.put(KEY, jpeg(), "image/jpeg");
    const res = await readJson(await handler(completeReq()));
    assertEquals(res.status, 422);
    assertEquals(world.storage.deleted, []);
  });
});

test("phone-upload-token 085: retry after an RPC refusal - the freed path gets a fresh token (not alreadyUploaded), a new photo completes", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    withCompleteRpc(world);
    const real = world.db.rpcs[COMPLETE];
    let configured = false;
    world.db.rpcs[COMPLETE] = (args) => configured ? real(args) : [400, { code: "P0001", message: "Phone image upload is not configured on this server" }];
    world.storage.put(KEY, png(), "image/png");
    assertEquals((await readJson(await handler(completeReq()))).status, 422);
    assert(!world.storage.objects.has(KEY));
    const tok = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals(tok.status, 200);
    assert(typeof tok.body.token === "string" && !tok.body.alreadyUploaded);
    assertEquals(world.storage.signed.at(-1)?.upsert, false);
    configured = true;
    world.storage.put(KEY, png(), "image/png");
    const done = await readJson(await handler(completeReq()));
    assertEquals(done.status, 200);
    assertEquals(done.body.status, "COMPLETED");
    assert(world.storage.objects.has(KEY));
  });
});

test("phone-upload-token 085: lost-response flows keep working - alreadyUploaded then complete; a repeated complete after success is 410 and deletes nothing", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    withCompleteRpc(world);
    world.storage.put(KEY, png(), "image/png");
    const tok = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals(tok.body, { alreadyUploaded: true, path: PATH });
    assertEquals((await readJson(await handler(completeReq()))).status, 200);
    const again = await readJson(await handler(completeReq()));
    assertEquals(again.status, 410);
    assertEquals(again.body.status, "COMPLETED");
    assertEquals(world.storage.deleted, []);
    assert(world.storage.objects.has(KEY));
  });
});
