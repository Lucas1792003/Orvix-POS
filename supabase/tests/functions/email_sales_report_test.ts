// email-sales-report — hermetic tests (see _harness.ts). Runs the real
// supabase/functions/email-sales-report/index.ts against in-process mocks.
// This function is client-invoked (admin button), not cron: the bearer is a
// user session JWT validated through GET /auth/v1/user.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromBase64, loadHandler, makeWorld, post, readJson, setEnv, test } from "./_harness.ts";

const ADMIN_TOKEN = "session-jwt-admin";
const CASHIER_TOKEN = "session-jwt-cashier";
const UNLINKED_TOKEN = "session-jwt-unlinked"; // auth user whose users row has no auth_id (email fallback)

const USERS = [
  { id: "u-admin-1", auth_id: "auth-admin-1", name: "Owner", email: "owner@example.test", role: "ADMIN", is_active: true },
  { id: "u-cashier", auth_id: "auth-cashier", name: "Aye Aye", email: "aye@example.test", role: "CASHIER", is_active: true },
  { id: "u-admin-2", auth_id: null, name: "Legacy Admin", email: "Legacy@Example.test", role: "ADMIN", is_active: true },
];

const setup = async (world: ReturnType<typeof makeWorld>) => {
  world.db.seed({ users: USERS });
  world.auth.users.set(ADMIN_TOKEN, { id: "auth-admin-1", email: "owner@example.test" });
  world.auth.users.set(CASHIER_TOKEN, { id: "auth-cashier", email: "aye@example.test" });
  world.auth.users.set(UNLINKED_TOKEN, { id: "auth-legacy", email: "legacy@example.test" });
  return await loadHandler("email-sales-report");
};

const CSV_A = [
  "Report Date,Branch,Branch Code,Receipt No,Sale Date Time,Cashier Name,Cashier Email,Payment Method,Sale Status,Receipt Line,Price Level,Product Name,Product SKU,Product Alias,Unit,Quantity,Unit Price MMK,Item Discount %,Line Total MMK,Subtotal MMK,Sale Discount MMK,Cart Discount %,Total MMK,Paid MMK,Change MMK",
  "2026-10-12,Main Branch,MAIN,MAIN-20261012-0001,2026-10-12T03:00:00.000Z,Aye Aye,aye@example.test,CASH,COMPLETED,1,Retail,\"Oil, 1L\",OIL1,,Bottle,1,5500,,5500,5500,0,,5500,6000,500",
].join("\n");
const CSV_B = "Report Date,Branch\n2026-10-12,Second Branch";

test("email-sales-report: refuses missing / invalid bearer and non-admin callers; never emails", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await setup(world);
    const none = await readJson(await handler(post(null, { subject: "x" })));
    assertEquals(none.status, 401);
    assertEquals(world.calls.length, 0, "no auth lookup without a token");

    const bad = await readJson(await handler(post("garbage-token", { subject: "x" })));
    assertEquals(bad.status, 401);
    assertEquals(bad.body, { error: "Invalid session." });
    assertEquals(world.trace(), ["auth:GET user"]);

    const cashier = await readJson(await handler(post(CASHIER_TOKEN, { subject: "x" })));
    assertEquals(cashier.status, 403);
    assertEquals(world.resend.calls.length, 0);
  } finally {
    world.restore();
  }
});

test("email-sales-report: per-shop attachments → one email to the caller only, CSVs byte-identical after base64, filenames kept", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await setup(world);
    const res = await readJson(await handler(post(ADMIN_TOKEN, {
      subject: "Shwe PhaLar daily sales report - Oct 12, 2026",
      reportDateLabel: "Oct 12, 2026",
      attachments: [
        { filename: "daily-sales-MAIN-2026-10-12.csv", csv: CSV_A },
        { filename: "daily-sales-SB2-2026-10-12.csv", csv: CSV_B },
        { filename: "", csv: "dropped: empty filename" },
        { filename: "no-csv.csv" },
      ],
      shopSummaries: [
        { shopName: "Main Branch", shopCode: "MAIN", filename: "daily-sales-MAIN-2026-10-12.csv", saleCount: 1, rowCount: 1 },
        { shopName: "Second Branch", shopCode: "SB2", filename: "daily-sales-SB2-2026-10-12.csv", saleCount: 1, rowCount: 1 },
      ],
      totalSaleCount: 2,
      totalRowCount: 2,
      openShiftNotice: { openShiftCount: 1, entries: [{ cashier: "Aye Aye", branch: "Main Branch" }], summary: "1 shift still open" },
    })));
    assertEquals(res.status, 200, JSON.stringify(res.body));
    assertEquals(res.body, { sent: true, recipient: "owner@example.test", id: "mock-email-1" });
    assertEquals(world.trace(), ["auth:GET user", "db:GET users", "resend:POST"]);

    const email = world.resend.calls[0].body as Record<string, unknown>;
    assertEquals(email.to, ["owner@example.test"], "only the calling admin, never every admin");
    assertEquals(email.subject, "Shwe PhaLar daily sales report - Oct 12, 2026");
    const attachments = email.attachments as { filename: string; content: string }[];
    assertEquals(attachments.map((a) => a.filename), ["daily-sales-MAIN-2026-10-12.csv", "daily-sales-SB2-2026-10-12.csv"]);
    assertEquals(fromBase64(attachments[0].content), CSV_A, "CSV passes through unmodified (quoting preserved)");
    assertEquals(fromBase64(attachments[1].content), CSV_B);
    assertStringIncludes(String(email.text), "Total sales: 2");
    assertStringIncludes(String(email.text), "⚠ DATA MAY BE INCOMPLETE");
    assertStringIncludes(String(email.html), "Attachments</td><td style=\"padding: 2px 0; font-weight: 600;\">2");
    assertStringIncludes(String(email.html), "Main Branch <span style=\"color:#94a3b8;\">(MAIN)</span>");
  } finally {
    world.restore();
  }
});

test("email-sales-report: legacy single-CSV payload still produces one attachment; missing subject → 400", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await setup(world);
    const res = await readJson(await handler(post(ADMIN_TOKEN, { subject: "legacy", csv: CSV_B, filename: "daily-sales-2026-10-12.csv", saleCount: 1, rowCount: 1 })));
    assertEquals(res.status, 200);
    const attachments = (world.resend.calls[0].body as { attachments: { filename: string; content: string }[] }).attachments;
    assertEquals(attachments.length, 1);
    assertEquals(attachments[0].filename, "daily-sales-2026-10-12.csv");
    assertEquals(fromBase64(attachments[0].content), CSV_B);

    const noSubject = await readJson(await handler(post(ADMIN_TOKEN, { csv: CSV_B, filename: "x.csv" })));
    assertEquals(noSubject.status, 400);
    assertEquals(world.resend.calls.length, 1);
  } finally {
    world.restore();
  }
});

test("email-sales-report: admin matched by email fallback (no auth_id link), case-insensitive; Resend 500 → 502", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await setup(world);
    const ok = await readJson(await handler(post(UNLINKED_TOKEN, { subject: "s", attachments: [] })));
    assertEquals(ok.status, 200);
    assertEquals(ok.body.recipient, "Legacy@Example.test", "profile email wins over auth email");
    assert(world.trace().includes("db:GET users"));
    world.resend.mode = 500;
    const failed = await readJson(await handler(post(ADMIN_TOKEN, { subject: "s", attachments: [] })));
    assertEquals(failed.status, 502);
  } finally {
    world.restore();
  }
});

test("email-sales-report: missing REPORT_EMAIL_FROM → 500 before auth and before any DB call", async () => {
  setEnv({ REPORT_EMAIL_FROM: undefined });
  const world = makeWorld();
  try {
    const handler = await setup(world);
    const res = await readJson(await handler(post(ADMIN_TOKEN, { subject: "s" })));
    assertEquals(res.status, 500);
    assertEquals(world.calls.length, 0);
  } finally {
    world.restore();
    setEnv();
  }
});
