// weekly-sales-report — hermetic tests (see _harness.ts). Runs the real
// supabase/functions/weekly-sales-report/index.ts against in-process mocks
// with Date.now() pinned.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromBase64, loadHandler, makeWorld, parseCsv, post, readJson, SERVICE_ROLE_KEY, setEnv, test, withClock } from "./_harness.ts";

// Cron fires Sunday 17:30 UTC == Monday 00:00 Asia/Yangon (UTC+6:30).
const CRON_FIRE = "2026-10-11T17:30:00.000Z";
const WEEK_START = "2026-10-04T17:30:00.000Z"; // Mon 2026-10-05 00:00 MMT
const WEEK_END = "2026-10-11T17:30:00.000Z"; // Mon 2026-10-12 00:00 MMT (exclusive)

const USERS = [
  { id: "u-admin-1", name: "Owner", email: "owner@example.test", role: "ADMIN", is_active: true },
  { id: "u-admin-2", name: "Second Admin", email: "second@example.test", role: "ADMIN", is_active: true },
  { id: "u-admin-off", name: "Former Admin", email: "former@example.test", role: "ADMIN", is_active: false },
  { id: "u-admin-noemail", name: "No Email", email: null, role: "ADMIN", is_active: true },
  { id: "u-cashier", name: "Aye Aye", email: "aye@example.test", role: "CASHIER", is_active: true },
];
const SHOPS = [
  { id: "shop-1", name: "Main Branch", code: "MAIN" },
  { id: "shop-2", name: "Second Branch", code: "SB/2" },
];
const PRODUCTS = [
  { id: "p-1", name: "Rice 5kg", sku: "RICE5", alias_code: "R5" },
  { id: "p-2", name: "Oil, 1L", sku: "OIL1", alias_code: null },
];
const sale = (id: string, shop: string, created_at: string, receipt: string) => ({
  id, shop_id: shop, receipt_no: receipt, cashier_id: "u-cashier", status: "COMPLETED",
  subtotal_mmk: 10000, discount_mmk: 0, cart_discount_pct: null, total_mmk: 10000,
  payment_method: "CASH", paid_mmk: 10000, change_mmk: 0, created_at,
});
const SALES = [
  sale("s-before", "shop-1", "2026-10-04T17:29:59.999Z", "MAIN-20261004-0001"), // last ms of the previous week → excluded
  sale("s-start", "shop-1", WEEK_START, "MAIN-20261005-0001"), // exactly Monday 00:00 MMT → included
  sale("s-mid", "shop-1", "2026-10-08T05:00:00.000Z", "MAIN-20261008-0001"),
  sale("s-shop2", "shop-2", "2026-10-10T12:00:00.000Z", "SB2-20261010-0001"),
  sale("s-end", "shop-1", WEEK_END, "MAIN-20261012-0001"), // exactly next Monday 00:00 MMT → excluded (lt)
];
const ITEMS = [
  { id: "i-1", sale_id: "s-start", product_id: "p-1", qty_units: 2, unit_price_mmk: 5000, item_discount_pct: null, line_total_mmk: 10000, unit_label: "bag", unit_name_snapshot: "Bag", price_level_name_snapshot: "Retail" },
  { id: "i-2", sale_id: "s-mid", product_id: "p-1", qty_units: 1, unit_price_mmk: 5000, item_discount_pct: 10, line_total_mmk: 4500, unit_label: "bag", unit_name_snapshot: null, price_level_name_snapshot: null },
  { id: "i-3", sale_id: "s-mid", product_id: "p-2", qty_units: 1, unit_price_mmk: 5500, item_discount_pct: null, line_total_mmk: 5500, unit_label: "btl", unit_name_snapshot: "Bottle", price_level_name_snapshot: "Retail" },
  { id: "i-4", sale_id: "s-shop2", product_id: "p-2", qty_units: 3, unit_price_mmk: 5500, item_discount_pct: null, line_total_mmk: 16500, unit_label: null, unit_name_snapshot: null, price_level_name_snapshot: null },
  // items of out-of-window sales must never be requested
  { id: "i-x", sale_id: "s-before", product_id: "p-1", qty_units: 9, unit_price_mmk: 1, item_discount_pct: null, line_total_mmk: 9, unit_label: null, unit_name_snapshot: null, price_level_name_snapshot: null },
  { id: "i-y", sale_id: "s-end", product_id: "p-1", qty_units: 9, unit_price_mmk: 1, item_discount_pct: null, line_total_mmk: 9, unit_label: null, unit_name_snapshot: null, price_level_name_snapshot: null },
];

const seedAll = (world: ReturnType<typeof makeWorld>) =>
  world.db.seed({ users: USERS, shops: SHOPS, products: PRODUCTS, sales: SALES, sale_items: ITEMS });

test("weekly-sales-report: refuses a caller without the service-role bearer (no DB call, no email)", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("weekly-sales-report");
    seedAll(world);
    for (const bearer of [null, "anon-key", "user-jwt"]) {
      const res = await readJson(await handler(post(bearer)));
      assertEquals(res.status, 401, `bearer=${bearer}`);
    }
    assertEquals(world.calls.length, 0);
  } finally {
    world.restore();
  }
});

test("weekly-sales-report: emails every active admin the Mon-00:00-Yangon week window computed from a fixed clock", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("weekly-sales-report");
    seedAll(world);
    const res = await withClock(CRON_FIRE, async () => readJson(await handler(post(SERVICE_ROLE_KEY))));
    assertEquals(res.status, 200, JSON.stringify(res.body));
    assertEquals(res.body.weekStart, WEEK_START);
    assertEquals(res.body.weekEnd, WEEK_END);
    assertEquals(res.body.totalSaleCount, 3);
    assertEquals(res.body.totalRowCount, 4);
    assertEquals(res.body.shops, 2);
    assertEquals(res.body.recipients, ["owner@example.test", "second@example.test"]);

    // the DB query carries the exact window
    const salesCall = world.calls.find((c) => c.path === "/rest/v1/sales")!;
    assertEquals(new URL(salesCall.url).searchParams.getAll("created_at"), [`gte.${WEEK_START}`, `lt.${WEEK_END}`]);
    const itemsCall = world.calls.find((c) => c.path === "/rest/v1/sale_items")!;
    const requested = new URL(itemsCall.url).searchParams.get("sale_id")!;
    assert(!requested.includes("s-before") && !requested.includes("s-end"), requested);

    // one email, one attachment per shop with sales, header row exact, rows only from the window
    assertEquals(world.resend.calls.length, 1);
    const email = world.resend.calls[0].body as Record<string, unknown>;
    assertEquals(email.to, ["owner@example.test", "second@example.test"]);
    assertEquals(email.subject, "Shwe PhaLar weekly sales report — Oct 5, 2026 – Oct 11, 2026");
    const attachments = (email.attachments as { filename: string; content: string }[]);
    assertEquals(attachments.map((a) => a.filename), ["weekly-sales-MAIN-2026-10-04.csv", "weekly-sales-SB-2-2026-10-04.csv"]);
    const main = parseCsv(fromBase64(attachments[0].content));
    assertEquals(main[0], [
      "Report Week", "Branch", "Branch Code", "Receipt No", "Sale Date Time", "Cashier Name", "Cashier Email",
      "Payment Method", "Sale Status", "Receipt Line", "Price Level", "Product Name", "Product SKU", "Product Alias",
      "Unit", "Quantity", "Unit Price MMK", "Item Discount %", "Line Total MMK", "Subtotal MMK", "Sale Discount MMK",
      "Cart Discount %", "Total MMK", "Paid MMK", "Change MMK",
    ]);
    assertEquals(main.length, 1 + 3, "MAIN: s-mid (2 lines) + s-start (1 line)");
    assertEquals(new Set(main.slice(1).map((r) => r[3])), new Set(["MAIN-20261005-0001", "MAIN-20261008-0001"]));
    assertEquals(main[1][0], "Oct 5, 2026 – Oct 11, 2026");
    assertEquals(main[1][5], "Aye Aye");
    const second = parseCsv(fromBase64(attachments[1].content));
    assertEquals(second.length, 2);
    assertEquals(second[1].slice(1, 4), ["Second Branch", "SB/2", "SB2-20261010-0001"]);
    assertEquals(second[1][11], "Oil, 1L", "product name with a comma is quoted correctly");
    // note the s-mid filename uses the UTC date of week start (2026-10-04), not the MMT date — documented quirk
    assertStringIncludes(String(email.html), "Total sales</td><td style=\"padding: 2px 0; font-weight: 600;\">3");
    // nothing was deleted or modified
    assert(world.calls.every((c) => c.kind === "resend" || c.method === "GET"), world.trace().join(" → "));
  } finally {
    world.restore();
  }
});

test("weekly-sales-report: cron jitter after the boundary keeps the same week; firing BEFORE Monday 00:00 MMT reports the previous week", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("weekly-sales-report");
    seedAll(world);
    const late = await withClock("2026-10-11T17:41:00.000Z", async () => readJson(await handler(post(SERVICE_ROLE_KEY))));
    assertEquals([late.body.weekStart, late.body.weekEnd], [WEEK_START, WEEK_END]);
    const early = await withClock("2026-10-11T17:29:00.000Z", async () => readJson(await handler(post(SERVICE_ROLE_KEY))));
    assertEquals([early.body.weekStart, early.body.weekEnd], ["2026-09-27T17:30:00.000Z", WEEK_START], "one minute early → the week before");
  } finally {
    world.restore();
  }
});

test("weekly-sales-report: zero sales → still emails every active admin a '(no sales)' notice", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("weekly-sales-report");
    world.db.seed({ users: USERS, shops: SHOPS, products: PRODUCTS, sales: [], sale_items: [] });
    const res = await withClock(CRON_FIRE, async () => readJson(await handler(post(SERVICE_ROLE_KEY))));
    assertEquals(res.status, 200);
    assertEquals(res.body.sent, 0);
    assertEquals(res.body.recipients, 2);
    assertEquals(world.resend.calls.length, 1);
    const email = world.resend.calls[0].body as Record<string, unknown>;
    assertEquals(email.to, ["owner@example.test", "second@example.test"]);
    assertStringIncludes(String(email.subject), "(no sales)");
    assertEquals(email.attachments, undefined);
  } finally {
    world.restore();
  }
});

test("weekly-sales-report: Resend 500 → 502 (with sales); but in the zero-sales path the failure is swallowed (documents current behaviour)", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("weekly-sales-report");
    seedAll(world);
    world.resend.mode = 500;
    const withSales = await withClock(CRON_FIRE, async () => readJson(await handler(post(SERVICE_ROLE_KEY))));
    assertEquals(withSales.status, 502);
    assertStringIncludes(String(withSales.body.error), "Email send failed");

    world.db.seed({ sales: [] });
    const noSales = await withClock(CRON_FIRE, async () => readJson(await handler(post(SERVICE_ROLE_KEY))));
    assertEquals(noSales.status, 200, "zero-sales branch ignores the Resend status");
    assertEquals(world.resend.calls.length, 2);
  } finally {
    world.restore();
  }
});

test("weekly-sales-report: no active admin email → 422, no email", async () => {
  setEnv();
  const world = makeWorld();
  try {
    const handler = await loadHandler("weekly-sales-report");
    world.db.seed({ users: USERS.filter((u) => u.role !== "ADMIN"), shops: SHOPS, products: PRODUCTS, sales: SALES, sale_items: ITEMS });
    const res = await withClock(CRON_FIRE, async () => readJson(await handler(post(SERVICE_ROLE_KEY))));
    assertEquals(res.status, 422);
    assertEquals(world.resend.calls.length, 0);
  } finally {
    world.restore();
  }
});
