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
// (value returned by product_image_upload_token_hash() on the self-hosted stack, schema 079, 2026-10-12)
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
  return await loadHandler("phone-upload-token");
};

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
    // the row is read with the service role and NOT written (no token stored)
    assertEquals(world.trace(), [
      "db:GET product_image_upload_sessions",
      "db:GET users",
      "db:GET products",
      "db:GET shops",
      "storage:HEAD object",
      "storage:POST sign",
    ]);
    assertEquals(world.db.tables.product_image_upload_sessions[0].signed_upload_token, null);
    assertEquals(world.db.tables.product_image_upload_sessions[0].status, "PENDING");
    // the lookup used the hash, never the raw token
    const lookup = world.calls[0].url;
    assertStringIncludes(lookup, `token_hash=eq.${EXPECTED_DB_HASH}`);
    assert(!lookup.includes(QR_TOKEN));
  });
});

test("phone-upload-token: refresh while PENDING issues a new token each time for the same path (no state written)", async () => {
  await run(async (world) => {
    const handler = await seed(world);
    const a = await readJson(await handler(req({ token: QR_TOKEN })));
    const b = await readJson(await handler(req({ token: QR_TOKEN })));
    assertEquals([a.status, b.status], [200, 200]);
    assert(a.body.token !== b.body.token);
    assertEquals([a.body.path, b.body.path], [PATH, PATH]);
    assertEquals(world.calls.filter((c) => c.method === "PATCH" || c.method === "POST" && c.kind === "postgrest").length, 0);
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
    assertEquals(world.trace(), ["db:GET product_image_upload_sessions", "db:GET users", "storage:HEAD object", "storage:POST sign"]);
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
