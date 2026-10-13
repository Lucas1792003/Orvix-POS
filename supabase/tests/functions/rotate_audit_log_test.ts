// rotate-audit-log — hermetic tests (see _harness.ts). Runs the real
// supabase/functions/rotate-audit-log/index.ts against in-process mocks.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromBase64, loadHandler, makeWorld, parseCsv, post, readJson, SERVICE_ROLE_KEY, setEnv, test } from "./_harness.ts";

const THRESHOLD = 200;

const ADMINS = [
  { id: "u-admin-1", name: "Owner", email: "owner@example.test", role: "ADMIN", is_active: true },
  { id: "u-admin-2", name: "Second Admin", email: "second@example.test", role: "ADMIN", is_active: true },
  { id: "u-admin-off", name: "Former Admin", email: "former@example.test", role: "ADMIN", is_active: false },
  { id: "u-admin-noemail", name: "No Email", email: null, role: "ADMIN", is_active: true },
  { id: "u-cashier", name: "Cashier", email: "cashier@example.test", role: "CASHIER", is_active: true },
];
const SHOPS = [{ id: "shop-1", name: "Main Branch", code: "MAIN" }];

/** n audit rows with strictly increasing created_at; ids encode their rank. */
const auditRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `log-${String(i).padStart(4, "0")}`,
    shop_id: i % 7 === 0 ? null : "shop-1",
    actor_id: i % 3 === 0 ? "u-cashier" : "u-admin-1",
    action_type: i % 2 ? "SALE_COMPLETED" : "STOCK_ADJUSTED",
    entity_type: "sale",
    entity_id: `sale-${i}`,
    // a formula-looking message to exercise the CSV guard
    message: i === 5 ? "=HYPERLINK(\"x\")" : `event ${i}, "quoted"`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, i, 0)).toISOString(),
  }));

const seed = (world: ReturnType<typeof makeWorld>, n: number) =>
  world.db.seed({ audit_logs: auditRows(n), users: ADMINS, shops: SHOPS });

test("rotate-audit-log: refuses a caller without the service-role bearer (no DB call, no email)", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("rotate-audit-log");
    seed(world, 500);
    for (const bearer of [null, "anon-key", "some-user-jwt", SERVICE_ROLE_KEY.slice(0, -1)]) {
      const res = await readJson(await handler(post(bearer)));
      assertEquals(res.status, 401, `bearer=${bearer}`);
      assertEquals(res.body, { error: "Unauthorized." });
    }
    assertEquals(world.calls.length, 0, "no network call of any kind");
    assertEquals(world.db.tables.audit_logs.length, 500, "nothing deleted");
    // GET / OPTIONS are not rotation triggers either
    assertEquals((await handler(new Request("http://functions.local/", { method: "GET" }))).status, 405);
    assertEquals((await handler(new Request("http://functions.local/", { method: "OPTIONS" }))).status, 200);
  } finally {
    world.restore();
  }
});

test("rotate-audit-log: below threshold → no email, no delete", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("rotate-audit-log");
    seed(world, THRESHOLD - 1);
    const res = await readJson(await handler(post(SERVICE_ROLE_KEY)));
    assertEquals(res.status, 200);
    assertEquals(res.body, { rotated: false, count: THRESHOLD - 1, threshold: THRESHOLD });
    assertEquals(world.trace(), ["db:HEAD audit_logs"], "only the count query runs");
    assertEquals(world.resend.calls.length, 0);
    assertEquals(world.db.tables.audit_logs.length, THRESHOLD - 1);
  } finally {
    world.restore();
  }
});

test("rotate-audit-log: at threshold → one email with a CSV of exactly the oldest 200; delete only after the 2xx", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("rotate-audit-log");
    seed(world, 250);
    const res = await readJson(await handler(post(SERVICE_ROLE_KEY)));
    assertEquals(res.status, 200, JSON.stringify(res.body));
    assertEquals(res.body.rotated, true);
    assertEquals(res.body.archived, THRESHOLD);
    assertEquals(res.body.remaining, 50);
    assertEquals(res.body.recipients, ["owner@example.test", "second@example.test"], "active admins with an email only");

    // exactly one email, to every active admin, from REPORT_EMAIL_FROM
    assertEquals(world.resend.calls.length, 1);
    const email = world.resend.calls[0].body as Record<string, unknown>;
    assertEquals(email.from, "Shwe PhaLar <reports@example.test>");
    assertEquals(email.to, ["owner@example.test", "second@example.test"]);
    assertStringIncludes(String(email.subject), `Audit log archive (${THRESHOLD} entries`);
    const attachments = email.attachments as { filename: string; content: string }[];
    assertEquals(attachments.length, 1);
    assert(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/.test(attachments[0].filename));

    // CSV = header + exactly the 200 OLDEST rows, in created_at order
    const csv = parseCsv(fromBase64(attachments[0].content));
    assertEquals(csv[0], ["Action", "Actor", "Branch", "Entity", "Message", "Time", "Entity Id", "Log Id"]);
    assertEquals(csv.length, 1 + THRESHOLD);
    const expectedIds = auditRows(250).slice(0, THRESHOLD).map((r) => r.id);
    assertEquals(csv.slice(1).map((r) => r[7]), expectedIds);
    assertEquals(csv[1][1], "Cashier", "actor id resolved to a name");
    assertEquals(csv[1][2], "", "null shop_id → empty Branch");
    assertEquals(csv[2][2], "Main Branch", "shop id resolved to a name");
    assertEquals(csv[6][4], "'=HYPERLINK(\"x\")", "formula-injection guard applied to the message");

    // delete targets exactly those ids, and happens strictly AFTER the Resend 2xx
    const trace = world.trace();
    const resendIdx = trace.indexOf("resend:POST");
    const deleteIdx = trace.indexOf("db:DELETE audit_logs");
    assert(resendIdx >= 0 && deleteIdx > resendIdx, `order was ${trace.join(" → ")}`);
    const del = world.calls[deleteIdx];
    const inList = new URL(del.url).searchParams.get("id") ?? "";
    assert(inList.startsWith("in.("), inList.slice(0, 20));
    assertEquals(inList.slice(4, -1).split(",").length, THRESHOLD);
    assertEquals(world.db.tables.audit_logs.map((r) => r.id as string), auditRows(250).slice(THRESHOLD).map((r) => r.id), "the 50 newest rows survive");
    assertEquals(trace, [
      "db:HEAD audit_logs",
      "db:GET audit_logs",
      "db:GET users",
      "db:GET shops",
      "db:GET users",
      "resend:POST",
      "db:DELETE audit_logs",
    ]);
  } finally {
    world.restore();
  }
});

for (const mode of [500, 429, 422] as const) {
  test(`rotate-audit-log: Resend ${mode} → no delete, non-2xx response`, async () => {
    setEnv();
    const world = makeWorld();
    try {
      const handler = await loadHandler("rotate-audit-log");
      seed(world, 300);
      world.resend.mode = mode;
      const res = await readJson(await handler(post(SERVICE_ROLE_KEY)));
      assertEquals(res.status, 502);
      assertStringIncludes(String(res.body.error), "Email send failed; no data deleted");
      assertEquals(world.resend.calls.length, 1, "one attempt per run — no in-function retry");
      assert(!world.trace().includes("db:DELETE audit_logs"), "no delete after a failed send");
      assertEquals(world.db.tables.audit_logs.length, 300);
    } finally {
      world.restore();
    }
  });
}

test("rotate-audit-log: Resend 2xx but DELETE fails → rows stay, 500 with emailed count; the NEXT run re-emails the same 200 (duplicate)", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("rotate-audit-log");
    seed(world, 300);
    world.db.failures.push({ method: "DELETE", table: "audit_logs", status: 500, message: "simulated delete failure" });
    const first = await readJson(await handler(post(SERVICE_ROLE_KEY)));
    assertEquals(first.status, 500);
    assertStringIncludes(String(first.body.error), "Archived + emailed, but delete failed (will retry next run)");
    assertEquals(first.body.emailed, THRESHOLD);
    assertEquals(world.resend.calls.length, 1, "the email went out");
    assertEquals(world.db.tables.audit_logs.length, 300, "nothing deleted");

    // delete works again (e.g. next cron tick) → the same 200 rows are emailed a second time
    world.db.failures = [];
    const second = await readJson(await handler(post(SERVICE_ROLE_KEY)));
    assertEquals(second.status, 200);
    assertEquals(second.body.archived, THRESHOLD);
    assertEquals(world.resend.calls.length, 2, "duplicate archive email — the function is not idempotent across a delete failure");
    const ids = (c: { body: unknown }) =>
      parseCsv(fromBase64(((c.body as { attachments: { content: string }[] }).attachments[0]).content)).slice(1).map((r) => r[7]);
    assertEquals(ids(world.resend.calls[0]), ids(world.resend.calls[1]), "identical CSV content in both emails");
    assertEquals(world.db.tables.audit_logs.length, 100);
  } finally {
    world.restore();
  }
});

test("rotate-audit-log: invoked twice sequentially drains in 200-row batches without duplicates", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("rotate-audit-log");
    seed(world, 450);
    const a = await readJson(await handler(post(SERVICE_ROLE_KEY)));
    const b = await readJson(await handler(post(SERVICE_ROLE_KEY)));
    const c = await readJson(await handler(post(SERVICE_ROLE_KEY)));
    assertEquals([a.body.archived, b.body.archived, c.body.rotated], [THRESHOLD, THRESHOLD, false]);
    assertEquals(world.resend.calls.length, 2);
    const ids = (i: number) =>
      parseCsv(fromBase64(((world.resend.calls[i].body as { attachments: { content: string }[] }).attachments[0]).content)).slice(1).map((r) => r[7]);
    assertEquals(new Set([...ids(0), ...ids(1)]).size, 400, "no overlap between batches");
    assertEquals(world.db.tables.audit_logs.length, 50);
  } finally {
    world.restore();
  }
});

test("rotate-audit-log: two CONCURRENT invocations (no lock) → both email the same 200 rows; data is safe but the email is duplicated", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("rotate-audit-log");
    seed(world, 300);
    const [a, b] = await Promise.all([handler(post(SERVICE_ROLE_KEY)), handler(post(SERVICE_ROLE_KEY))]).then((rs) => Promise.all(rs.map(readJson)));
    assertEquals([a.status, b.status], [200, 200]);
    assertEquals(world.resend.calls.length, 2, "no mutual exclusion: both runs sent an email");
    const ids = (i: number) =>
      parseCsv(fromBase64(((world.resend.calls[i].body as { attachments: { content: string }[] }).attachments[0]).content)).slice(1).map((r) => r[7]);
    assertEquals(ids(0), ids(1), "both archived the same oldest 200");
    assertEquals(world.db.tables.audit_logs.length, 100, "rows deleted once; the second DELETE matched nothing");
  } finally {
    world.restore();
  }
});

test("rotate-audit-log: no active admin email → 422 and nothing deleted", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("rotate-audit-log");
    world.db.seed({ audit_logs: auditRows(220), users: ADMINS.filter((u) => u.role !== "ADMIN" || !u.is_active || !u.email), shops: SHOPS });
    const res = await readJson(await handler(post(SERVICE_ROLE_KEY)));
    assertEquals(res.status, 422);
    assertEquals(world.resend.calls.length, 0);
    assertEquals(world.db.tables.audit_logs.length, 220);
  } finally {
    world.restore();
  }
});

test("rotate-audit-log: missing RESEND_API_KEY → 500 before auth and before any DB call", async () => {
  setEnv({ RESEND_API_KEY: undefined });
  const world = makeWorld();
  try {
    const handler = await loadHandler("rotate-audit-log");
    seed(world, 300);
    const res = await readJson(await handler(post("not-even-the-service-key")));
    assertEquals(res.status, 500);
    assertStringIncludes(String(res.body.error), "RESEND_API_KEY");
    assertEquals(world.calls.length, 0);
  } finally {
    world.restore();
    setEnv();
  }
});
