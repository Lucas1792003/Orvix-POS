/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase E · B. Failure injection. Every outage is injected on the client
// (Playwright request interception on the Supabase origin, navigator.onLine
// override, WebSocket routing, localStorage/SQL edits) — the self-hosted stack's
// containers are never stopped. Each scenario is verified against the
// database with the service role.
import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { count, deleteAuthSessions, inv, keyRows, latestSale, row, rows, sleep, svc, userClient } from "./helpers/db";
import { RESULTS_DIR, liveCfg, qaPassword, qaState } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal } from "./helpers/terminal";

test.describe.configure({ mode: "serial" });

const st = qaState();
const pw = qaPassword();
const { ids, emails, authIds } = st;
const USERDATA = path.join(RESULTS_DIR, "userdata-b");

let A: Terminal;
let B: Terminal | undefined;

/** Cashier A at the POS with an open shift (re-usable after a relaunch). */
async function cashierAtPos(t: Terminal): Promise<void> {
  const session = await t.storedSession().catch(() => null);
  if (!session) {
    await t.login(emails.cashA, pw);
    await t.waitForRoute("/app/pos");
  }
  await t.waitForApp();
  if (!(await row("shifts", { cashier_id: ids.cashA, ended_at: null }))) await t.openShift(0);
  await t.gotoPos();
}

test.beforeAll(async () => {
  rmSync(USERDATA, { recursive: true, force: true });
  A = await Terminal.launchElectron(USERDATA);
  await cashierAtPos(A);
});

test.afterAll(async () => {
  try {
    await assertConsistency("spec B", [A, ...(B ? [B] : [])]);
  } finally {
    await A?.close();
    await B?.close();
  }
});

test("B1 network disconnected before checkout -> queued, receipt PENDING; reconnect -> drained once", async () => {
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  await A.setOffline(true);
  await expect(A.badge("Offline — showing cached data")).toBeVisible();
  await A.posScan(st.barcodeValue);
  const queued = await A.posCheckout(1000);
  expect(queued.receiptNo).toBe("PENDING");
  await expect(A.badge("1 action waiting to sync")).toBeVisible();
  const [entry] = await A.outbox();
  expect(entry).toMatchObject({ name: "complete_sale", status: "pending", attempts: 0 });
  const localPending = (await A.localSales()).find((s: any) => s.receiptNo === "PENDING");
  expect(localPending?.pendingSync).toBe(true);
  // the stock badge already reflects the provisional deduction
  await expect.poll(() => A.posStockText("QA Product One")).toBe(`${q0 - 1} in stock`);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0);

  const t0 = Date.now();
  await A.setOffline(false);
  await expect(A.badge("1 action waiting to sync")).toBeHidden({ timeout: 60_000 });
  const drainMs = Date.now() - t0;
  expect(await A.outbox()).toHaveLength(0);
  const sale = await latestSale(ids.shop, ids.cashA);
  const [k] = await keyRows([entry.idempotencyKey!]);
  expect(k).toMatchObject({ rpc: "complete_sale", actor_id: ids.cashA });
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  const rpcCalls = A.requestsMatching(/rpc\/complete_sale/, t0);
  expect(rpcCalls.length).toBe(1);
  const localReal = (await A.localSales()).find((s: any) => s.idempotencyKey === entry.idempotencyKey || s.receiptNo === k?.key);
  expect((await A.localSales()).some((s: any) => s.receiptNo === "PENDING")).toBe(false);
  record("B", "network disconnected before checkout", "PASS",
    `offline sale queued (receipt PENDING, badge "1 action waiting to sync", local record pendingSync, card ${q0}->${q0 - 1} provisionally; DB unchanged); reconnect -> drained in ${drainMs} ms with exactly ${rpcCalls.length} complete_sale call; DB sales ${salesBefore}->${salesBefore + 1}, stock ${q0 - 1}, key row actor ${k.actor_id}; PENDING record replaced${localReal ? "" : ""}; sale ${sale?.receipt_no ?? "n/a"}`);
});

test("B2 network cut after the DB commits but before the response -> exactly one sale, replay returns the original", async () => {
  const q0 = await inv(ids.shop, ids.prod3);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  const hit = { hits: 0, serverStatus: 0 };
  const glob = await A.routeCommitThenAbort("/rest/v1/rpc/complete_sale", hit);
  await A.posAddByCard("QA Product Three");
  const t0 = Date.now();
  const first = await A.posCheckout(3000);
  // The server committed (HTTP 200 observed by the interceptor) but the app
  // never saw the reply: it must have fallen back to the queue.
  expect(hit.hits).toBe(1);
  expect(hit.serverStatus).toBe(200);
  expect(first.receiptNo).toBe("PENDING");
  const [entry] = await A.outbox();
  expect(entry.name).toBe("complete_sale");
  const committed = await keyRows([entry.idempotencyKey!]);
  expect(committed).toHaveLength(1);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  await A.unroutePath(glob);
  // Reconnect-style drain: offline -> online transition triggers the full
  // reload + drain (the queue would also be retried by the 30 s tick).
  await A.setOffline(true);
  await A.setOffline(false);
  await expect.poll(async () => (await A.outbox()).length, { timeout: 60_000 }).toBe(0);
  const replays = A.requestsMatching(/rpc\/complete_sale/, t0);
  expect(replays.length).toBe(2);
  const sale = await latestSale(ids.shop, ids.cashA);
  expect(sale.total_mmk).toBe(3000);
  expect(Date.parse(sale.created_at)).toBeGreaterThan(t0 - 60_000);
  const sales = [sale];
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect(await inv(ids.shop, ids.prod3)).toBe(q0 - 1);
  expect(await count("inventory_movements", { reference_id: sales[0].id, type: "SALE_OUT" })).toBe(1);
  const local = (await A.localSales()).find((s: any) => s.id === sales[0].id);
  expect(local?.receiptNo).toBe(sales[0].receipt_no);
  expect((await A.localSales()).some((s: any) => s.receiptNo === "PENDING")).toBe(false);
  record("B", "network cut after commit, before response", "PASS",
    `interceptor let complete_sale reach the server (HTTP ${hit.serverStatus}) then dropped the reply; app queued a provisional sale (PENDING) while the key row ${entry.idempotencyKey!.slice(0, 8)}… already existed; replay (${replays.length - 1} extra call, same key) returned the original response: exactly 1 sale ${sales[0].receipt_no}, stock ${q0}->${q0 - 1}, 1 SALE_OUT, provisional reconciled to the real receipt`);
});

test("B3 prolonged disconnection: several queued sales + a shift close -> all drained once, in order", async () => {
  const q1 = await inv(ids.shop, ids.prod1);
  const q2 = await inv(ids.shop, ids.prod2);
  const shift = await row("shifts", { cashier_id: ids.cashA, ended_at: null });
  const salesBefore = await count("sales", { shift_id: shift.id });
  await A.setOffline(true);
  // three sales with distinct totals (1x prod1, 2x prod1, 1x prod2)
  await A.posScan(st.barcodeValue);
  const s1 = await A.posCheckout(1000);
  await A.posScan(st.barcodeValue);
  await A.posScan(st.barcodeValue);
  const s2 = await A.posCheckout(2000);
  await A.posAddByCard("QA Product Two");
  const s3 = await A.posCheckout(2000);
  expect([s1.receiptNo, s2.receiptNo, s3.receiptNo]).toEqual(["PENDING", "PENDING", "PENDING"]);
  // close the shift offline at exactly the expected cash the till computed locally
  const expectedCash = await A.expectedCashShown();
  const dbCash = (await rows("sales", { shift_id: shift.id, payment_method: "CASH", status: "NORMAL" })).reduce((n: number, r: any) => n + r.total_mmk, 0);
  const localForShift = (await A.localSales()).filter((s: any) => s.shiftId === shift.id).map((s: any) => `${s.receiptNo}:${s.totalMmk}${s.pendingSync ? ":pending" : ""}`);
  // What the UI store (Zustand) lists for this cashier: Shifts -> Sales Records tab.
  await A.navigate("/app/shifts");
  await A.page.getByRole("button", { name: "Sales Records" }).click().catch(() => undefined);
  const uiReceipts = await A.page.locator("td.font-mono").allInnerTexts();
  const serverExpected = shift.opening_cash_mmk + dbCash + 5000;
  const dupReceipts = uiReceipts.filter((r, i) => r !== "PENDING" && uiReceipts.indexOf(r) !== i);
  record("B", "prolonged disconnection: till's expected cash vs server", dupReceipts.length === 0 && expectedCash === serverExpected ? "PASS" : "FAIL",
    `till shows expected ${expectedCash}; server-side opening ${shift.opening_cash_mmk} + committed CASH sales ${dbCash} + 3 queued (5000) = ${serverExpected}; UI lists ${uiReceipts.length} sales, duplicates: [${dupReceipts.join(",")}]; local mirror for shift: ${localForShift.length} rows`);
  expect(dupReceipts).toEqual([]);
  expect(expectedCash).toBe(serverExpected);
  const closeErr = await A.closeShift(expectedCash);
  expect(closeErr).toBeNull();
  const queued = await A.outbox();
  expect(queued.map((e) => e.name)).toEqual(["complete_sale", "complete_sale", "complete_sale", "close_shift"]);
  expect(queued.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  await expect(A.badge("4 actions waiting to sync")).toBeVisible();
  const keys = queued.map((e) => e.idempotencyKey!);
  await sleep(1500);

  const t0 = Date.now();
  await A.setOffline(false);
  await expect.poll(async () => (await A.outbox()).length, { timeout: 90_000 }).toBe(0);
  const krows = await keyRows(keys);
  expect(krows).toHaveLength(4);
  const order = keys.map((k) => krows.find((r) => r.key === k)!.created_at);
  for (let i = 1; i < order.length; i++) expect(Date.parse(order[i])).toBeGreaterThanOrEqual(Date.parse(order[i - 1]));
  const calls = A.requestsMatching(/rpc\/(complete_sale|close_shift)/, t0).map((r) => r.url.split("/rpc/")[1]);
  expect(calls).toEqual(["complete_sale", "complete_sale", "complete_sale", "close_shift"]);
  expect(await count("sales", { shift_id: shift.id })).toBe(salesBefore + 3);
  const closed = await row("shifts", { id: shift.id });
  expect(closed.ended_at).not.toBeNull();
  expect(closed.closing_cash_mmk).toBe(expectedCash);
  expect(closed.variance_mmk).toBe(0);
  expect(await inv(ids.shop, ids.prod1)).toBe(q1 - 3);
  expect(await inv(ids.shop, ids.prod2)).toBe(q2 - 1);
  const receipts = (await rows("sales", { shift_id: shift.id })).map((s: any) => s.receipt_no).sort();
  expect(new Set(receipts).size).toBe(receipts.length);
  record("B", "prolonged disconnection: 3 sales + shift close queued", "PASS",
    `outbox seq [1..4] = 3x complete_sale + close_shift; reconnect -> replayed in that order (${calls.join(",")}), key rows created in order; sales ${salesBefore}->${salesBefore + 3} on shift ${shift.id}, shift closed with closing ${expectedCash} / variance 0; prod1 ${q1}->${q1 - 3}, prod2 ${q2}->${q2 - 1}; receipts unique`);
});

test("B4 application terminated with pending operations -> relaunch -> pending survive and drain", async () => {
  await A.openShift(0);
  await A.gotoPos();
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  await A.setOffline(true);
  await A.posScan(st.barcodeValue);
  const queued = await A.posCheckout(1000);
  expect(queued.receiptNo).toBe("PENDING");
  const [entry] = await A.outbox();
  // Terminate (no graceful logout, no reconnect) and relaunch the same till.
  await A.close();
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  // Online relaunch; the boot-time drain's complete_sale is held until the
  // surviving outbox row has been read (since 069 the cashier's org-scoped
  // reload is small enough that the drain could otherwise finish first).
  A = await Terminal.launchElectron(USERDATA, { holdRpc: "complete_sale" });
  await A.waitForApp();
  const survived = await A.outbox();
  expect(survived.map((e) => e.localId)).toEqual([entry.localId]);
  A.releaseRpcHold();
  await expect.poll(async () => (await A.outbox()).length, { timeout: 60_000 }).toBe(0);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  expect((await A.localSales()).some((s: any) => s.receiptNo === "PENDING")).toBe(false);
  await A.gotoPos();
  record("B", "terminated with pending operations", "PASS",
    `queued sale ${entry.localId} survived app close + relaunch (outbox row intact, session restored without re-login) and drained on boot: sales ${salesBefore}->${salesBefore + 1}, key row present, stock ${q0}->${q0 - 1}, no PENDING record left`);
});

test("B5 application restarted while offline -> boots from cache, shows pending, drains after reconnect", async () => {
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  await A.setOffline(true);
  await A.posScan(st.barcodeValue);
  await A.posCheckout(1000);
  const [entry] = await A.outbox();
  await A.close();
  A = await Terminal.launchElectron(USERDATA, { offline: true });
  await A.waitForApp();
  expect(await A.page.evaluate(() => navigator.onLine)).toBe(false);
  await expect(A.badge("Offline — showing cached data")).toBeVisible();
  await expect(A.badge("1 action waiting to sync")).toBeVisible();
  const cacheCounts = await A.localSnapshotCounts();
  expect(cacheCounts.products).toBeGreaterThan(0);
  await A.gotoPos();
  await expect(A.page.getByRole("heading", { name: "Point of Sale" })).toBeVisible();
  await expect.poll(() => A.posStockText("QA Product One")).toBe(`${q0 - 1} in stock`);
  const sidebarUser = await A.page.locator("aside.sidebar .user-name").innerText();
  expect(sidebarUser).toBe("QA Cashier A");
  expect(A.hostedRequests).toEqual([]);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  const bootRequests = A.requestsMatching(/rest\/v1|auth\/v1/).length;

  await A.setOffline(false);
  await expect.poll(async () => (await A.outbox()).length, { timeout: 60_000 }).toBe(0);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  record("B", "restarted while offline", "PASS",
    `relaunched with the Supabase origin cut from the first request: navigator.onLine=false, booted from the local mirror (${cacheCounts.products} products, ${cacheCounts.sales} sales cached) as ${sidebarUser} without a round trip, badges "Offline" + "1 action waiting to sync", POS usable (card ${q0 - 1}); ${bootRequests} aborted API attempts during boot; reconnect -> drained: sales ${salesBefore}->${salesBefore + 1}, stock ${q0 - 1}`);
});

test("B6 expired/tampered JWT during sync -> refresh and continue", async () => {
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  await A.gotoPos();
  await A.setOffline(true);
  await A.posScan(st.barcodeValue);
  await A.posCheckout(1000);
  const [entry] = await A.outbox();
  const before = await A.storedSession();
  await sleep(1100); // a refreshed token must get a later iat
  const tail = await A.tamperAccessToken();
  const t0 = Date.now();
  await A.setOffline(false);
  await expect.poll(async () => (await A.outbox()).length, { timeout: 60_000 }).toBe(0);
  const after = await A.storedSession();
  const refreshes = A.requestsMatching(/grant_type=refresh_token/, t0);
  expect(refreshes.length).toBeGreaterThanOrEqual(1);
  expect(after!.access_token).not.toBe(before!.access_token);
  expect(after!.access_token.endsWith(tail)).toBe(false);
  expect(after!.expires_at! * 1000).toBeGreaterThan(Date.now());
  const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  expect(claims(after!.access_token).session_id).toBe(claims(before!.access_token).session_id);
  expect(claims(after!.access_token).iat).toBeGreaterThan(claims(before!.access_token).iat);
  const rpcReqs = A.requestsMatching(/rpc\/complete_sale/, t0);
  expect(rpcReqs.length).toBe(1);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  expect((await A.syncState()).some((s) => s.key === "needs-reauth")).toBe(false);
  record("B", "expired + tampered JWT during sync", "PASS",
    `stored access token tampered (signature) and marked expired with a sale queued; reconnect -> ${refreshes.length} refresh call(s), new token (same session_id, later iat, valid expiry), complete_sale sent once with the new token; sales ${salesBefore}->${salesBefore + 1}, stock ${q0 - 1}, no needs-reauth flag`);
});

test("B7 revoked refresh token -> needs-reauth, queue intact; sign in again -> drains", async () => {
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  await A.gotoPos();
  await A.setOffline(true);
  await A.posScan(st.barcodeValue);
  await A.posCheckout(1000);
  const [entry] = await A.outbox();
  // Revoke every session of cashier A server-side and make the local token
  // look expired, so the next sync must refresh — which the server refuses.
  const deleted = deleteAuthSessions(authIds.cashA);
  expect(deleted).toBeGreaterThan(0);
  await A.writeStoredSession({ expires_at: Math.floor(Date.now() / 1000) - 120, expires_in: 0 });
  const t0 = Date.now();
  await A.setOffline(false);
  // Observed behaviour is recorded whichever way the app lands: the banner
  // inside the shell, or a bounce to /login. Both keep the queue.
  const outcome = await Promise.race([
    A.page.getByRole("alert").filter({ hasText: "Your sign-in has expired on the server" }).waitFor({ state: "visible", timeout: 60_000 }).then(() => "banner" as const),
    expect.poll(() => A.currentRoute(), { timeout: 60_000 }).toMatch(/^\/login/).then(() => "login" as const),
  ]);
  const refreshes = A.requestsMatching(/grant_type=refresh_token/, t0);
  expect(refreshes.some((r) => r.status === 400 || r.status === 401 || r.status === 403)).toBe(true);
  const pending = await A.outbox();
  expect(pending.map((e) => e.localId)).toEqual([entry.localId]);
  expect(pending[0].status).toBe("pending");
  const flagged = (await A.syncState()).find((s) => s.key === "needs-reauth")?.flag === true;
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(0);
  let bannerText = "";
  if (outcome === "banner") {
    bannerText = (await A.page.getByRole("alert").filter({ hasText: "Your sign-in has expired" }).innerText()).replace(/\s+/g, " ");
    await A.page.getByRole("button", { name: "Sign in again" }).click();
    await A.waitForRoute("/login");
  }
  const stillPending = await A.outbox();
  expect(stillPending.map((e) => e.localId)).toEqual([entry.localId]);
  record("B", "revoked refresh token (observed landing)", "INFO",
    `outcome=${outcome}; route=${A.currentRoute()}; needs-reauth flag=${flagged}; console: ${A.consoleErrors.slice(-6).join(" || ")}`);
  const errBefore = A.consoleErrors.length;
  await A.login(emails.cashA, pw);
  const loginErr = await A.loginError(8_000);
  if (loginErr) record("B", "revoked refresh token (re-login error)", "INFO", `login page error: ${loginErr}; console: ${A.consoleErrors.slice(errBefore).join(" || ")}`);
  await A.waitForRoute("/app");
  await A.waitForApp();
  await expect.poll(async () => (await A.outbox()).length, { timeout: 60_000 }).toBe(0);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  expect((await A.syncState()).some((s) => s.key === "needs-reauth" && s.flag)).toBe(false);
  record("B", "revoked refresh token", "PASS",
    `auth.sessions deleted=${deleted}; reconnect -> refresh refused (HTTP ${refreshes.map((r) => r.status).join("/")}), outcome=${outcome === "banner" ? `needs-reauth banner "${bannerText}" + Sign in again` : "bounced to /login (full load ran without a session; see e2e-results.md)"}; needs-reauth flag=${flagged}; queue intact (entry ${entry.localId} pending, no sale, no key row); sign-in again -> drained: sales ${salesBefore}->${salesBefore + 1}, stock ${q0 - 1}, flag cleared`);
});

test("B8 two terminals submit the last units simultaneously -> stock never negative, one wins", async () => {
  await A.gotoPos();
  // Bring QA Product Three down to exactly 1 unit through the manager's RPC (a real movement).
  const mgr = await userClient(emails.mgr, pw);
  const current = await inv(ids.shop, ids.prod3);
  if (current !== 1) {
    const adj = await mgr.rpc("adjust_stock", {
      p_shop_id: ids.shop, p_product_id: ids.prod3, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1 - current,
      p_reason: "QA: leave the last unit for the race", p_product_unit_id: null, p_unit_qty: null, p_created_at: null,
      p_expected_actor_id: ids.mgr, p_idempotency_key: crypto.randomUUID(),
    });
    expect(adj.error).toBeNull();
  }
  await mgr.auth.signOut();
  expect(await inv(ids.shop, ids.prod3)).toBe(1);
  const Bt = await Terminal.launchBrowser();
  B = Bt;
  await Bt.login(emails.cashB, pw);
  await Bt.waitForRoute("/app/pos");
  await Bt.waitForApp();
  if (!(await row("shifts", { cashier_id: ids.cashB, ended_at: null }))) await Bt.openShift(0);
  await Bt.gotoPos();
  await expect.poll(() => A.posStockText("QA Product Three"), { timeout: 20_000 }).toBe("1 in stock");
  await expect.poll(() => Bt.posStockText("QA Product Three"), { timeout: 20_000 }).toBe("1 in stock");
  await A.posAddByCard("QA Product Three");
  await Bt.posAddByCard("QA Product Three");
  const salesBefore = await count("sales", { shop_id: ids.shop });
  // both confirm at the same moment
  const confirm = async (t: Terminal) => {
    await t.page.keyboard.press("F2");
    const amount = t.page.getByLabel("Amount received");
    await amount.waitFor({ state: "visible" });
    await amount.fill("3000");
  };
  await Promise.all([confirm(A), confirm(Bt)]);
  await A.toastsNow();
  await Bt.toastsNow();
  await Promise.all([A.page.getByLabel("Amount received").press("Enter"), Bt.page.getByLabel("Amount received").press("Enter")]);
  const [tA, tB] = await Promise.all([
    A.toast(/Sale recorded|Checkout failed/, 60_000),
    Bt.toast(/Sale recorded|Checkout failed/, 60_000),
  ]);
  const winners = [tA, tB].filter((t) => /Sale recorded/.test(t)).length;
  const losers = [tA, tB].filter((t) => /Checkout failed/.test(t));
  expect(winners).toBe(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]).toMatch(/stock/i);
  await Promise.all([A.page.keyboard.press("Escape"), Bt.page.keyboard.press("Escape")]);
  expect(await inv(ids.shop, ids.prod3)).toBe(0);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  // the loser still holds the unit in its cart ("0 of 0 left"); the winner's cart is empty ("0 in stock")
  await expect.poll(() => A.posStockText("QA Product Three"), { timeout: 20_000 }).toMatch(/^0 (in stock|of 0 left)$/);
  await expect.poll(() => Bt.posStockText("QA Product Three"), { timeout: 20_000 }).toMatch(/^0 (in stock|of 0 left)$/);
  expect(await A.outbox()).toHaveLength(0);
  expect(await Bt.outbox()).toHaveLength(0);
  await A.posClearCart();
  await Bt.posClearCart();
  record("B", "two terminals race for the last unit", "PASS",
    `prod3 set to 1 (manager adjustment); A (Electron) and B (Chromium) confirmed 3000 MMK simultaneously: 1 "Sale recorded", 1 "${losers[0]}"; DB stock 0 (never negative), sales ${salesBefore}->${salesBefore + 1}; both terminals converged on 0 via Realtime; no queued entries`);
});

test("B9 Supabase API temporarily unavailable (503) -> backoff and recovery, no duplicates", async () => {
  await A.page.keyboard.press("Escape");
  await A.gotoPos();
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  const hits = { hits: 0 };
  const glob = await A.routeStatus("/rest/v1/rpc/complete_sale", 503, { message: "Service Unavailable" }, hits);
  await A.posScan(st.barcodeValue);
  const t0 = Date.now();
  const queued = await A.posCheckout(1000);
  // Online path hit the 503 (a gateway status) and fell back to the queue.
  expect(queued.receiptNo).toBe("PENDING");
  const [entry] = await A.outbox();
  expect(entry.name).toBe("complete_sale");
  // Let the periodic drain (30 s) hit the 503 at least once more: backoff grows.
  await expect.poll(async () => (await A.outbox())[0]?.attempts ?? 0, { timeout: 90_000, intervals: [1000] }).toBeGreaterThanOrEqual(1);
  const during = (await A.outbox())[0];
  expect(during).toMatchObject({ status: "pending", failureKind: "transient" });
  expect(during.nextAttemptAt && Date.parse(during.nextAttemptAt) > Date.now() - 1000).toBe(true);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  const hitsDuring = hits.hits;
  await A.unroutePath(glob);
  await expect.poll(async () => (await A.outbox()).length, { timeout: 120_000, intervals: [1000] }).toBe(0);
  const recoveredMs = Date.now() - t0;
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  const rpcCalls = A.requestsMatching(/rpc\/complete_sale/, t0).length;
  record("B", "API unavailable (503) then restored", "PASS",
    `complete_sale answered 503 ${hitsDuring}x (online attempt + ${hitsDuring - 1} replay(s)); entry stayed pending/transient with attempts=${during.attempts}, backoff nextAttemptAt set; after release the queue drained in ${Math.round(recoveredMs / 1000)} s, ${rpcCalls} total calls; exactly 1 sale (sales ${salesBefore}->${salesBefore + 1}), stock ${q0 - 1}, 1 key row`);
});

test("B10 database unavailable then restored (SIMULATED: PostgREST 503 body; the self-hosted stack's database was NOT stopped)", async () => {
  await A.gotoPos();
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  const hits = { hits: 0 };
  // PostgREST's own "no database connection" reply.
  const body = { code: "PGRST001", details: "could not connect to server", hint: null, message: "Database connection error. Retrying the connection." };
  const glob = await A.routeStatus("/rest/v1/", 503, body, hits);
  await A.posScan(st.barcodeValue);
  const t0 = Date.now();
  const queued = await A.posCheckout(1000);
  expect(queued.receiptNo).toBe("PENDING");
  const [entry] = await A.outbox();
  await expect.poll(async () => (await A.outbox())[0]?.attempts ?? 0, { timeout: 90_000, intervals: [1000] }).toBeGreaterThanOrEqual(1);
  const during = (await A.outbox())[0];
  expect(during).toMatchObject({ status: "pending", failureKind: "transient" });
  expect(during.lastError).toMatch(/Database connection error|Service Unavailable|503|timed out/i);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  const hitsDuring = hits.hits;
  await A.unroutePath(glob);
  await expect.poll(async () => (await A.outbox()).length, { timeout: 120_000, intervals: [1000] }).toBe(0);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  record("B", "database unavailable then restored (SIMULATED)", "PASS",
    `every /rest/v1 request answered 503 with PostgREST body PGRST001 "Database connection error" (${hitsDuring} intercepted; the self-hosted stack's db container untouched); sale queued, entry transient with lastError "${during.lastError?.slice(0, 60)}"; after release drained once: sales ${salesBefore}->${salesBefore + 1}, stock ${q0 - 1}, 1 key row; ${Math.round((Date.now() - t0) / 1000)} s end to end`);
});

test("B11 Realtime disconnected and reconnected -> channel resubscribes and later changes arrive", async () => {
  await A.gotoPos();
  if (!B) {
    B = await Terminal.launchBrowser();
    await B.login(emails.cashB, pw);
    await B.waitForRoute("/app/pos");
    await B.waitForApp();
  }
  const Bt = B;
  // Route B's Realtime socket through a pass-through proxy (see terminal.ts)
  // so it can be cut from the network side; one reload to pick it up.
  await Bt.installRealtimeProxy();
  const tInstall = Date.now();
  await Bt.gotoPos();
  await Bt.waitForRealtimeReady(tInstall);
  const q0 = await inv(ids.shop, ids.prod2);
  await expect.poll(() => Bt.posStockText("QA Product Two")).toBe(`${q0} in stock`);
  await Bt.page.evaluate(() => { (window as any).__e2eMarker2 = "no-reload"; });
  const mgr = await userClient(emails.mgr, pw);
  const adjust = async (delta: number, reason: string) => {
    const r = await mgr.rpc("adjust_stock", {
      p_shop_id: ids.shop, p_product_id: ids.prod2, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: delta, p_reason: reason,
      p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: ids.mgr, p_idempotency_key: crypto.randomUUID(),
    });
    expect(r.error).toBeNull();
  };

  // Cut: the live socket is closed and every reconnect refused.
  const tCut = Date.now();
  await Bt.blockRealtime(true);
  await sleep(3000);
  await adjust(2, `QA realtime cut ${st.ts}`);
  await sleep(6000);
  const duringCut = await Bt.posStockText("QA Product Two");
  const refused = Bt.wsEvents.filter((e) => Number(e.split(" ")[0]) >= tCut && /refused/.test(e)).length;
  expect(refused).toBeGreaterThanOrEqual(1);
  expect(await inv(ids.shop, ids.prod2)).toBe(q0 + 2);

  // Restore: the client's own backoff reconnects and re-subscribes (no reload).
  const tRestore = Date.now();
  await Bt.blockRealtime(false);
  const readyMs = await Bt.waitForRealtimeReady(tRestore, 60_000);
  const afterRestore = await Bt.posStockText("QA Product Two");
  const t0 = Date.now();
  await adjust(3, `QA realtime restored ${st.ts}`);
  await expect.poll(() => Bt.posStockText("QA Product Two"), { timeout: 30_000 }).toBe(`${q0 + 5} in stock`);
  const latency = Date.now() - t0;
  expect(await Bt.page.evaluate(() => (window as any).__e2eMarker2)).toBe("no-reload");
  await mgr.auth.signOut();
  expect(await inv(ids.shop, ids.prod2)).toBe(q0 + 5);
  record("B", "Realtime disconnected and reconnected", "PASS",
    `B's realtime socket cut for ~9 s (${refused} reconnect attempt(s) refused): a +2 adjustment during the cut showed "${duringCut}" on B (DB ${q0 + 2}); socket released -> client reconnected and postgres_changes re-confirmed after ${readyMs} ms without reload; card still "${afterRestore}" until the next event (no catch-up on rejoin — see findings), then a +3 adjustment arrived live in ${latency} ms carrying the full row: "${q0 + 5} in stock"; DB ${q0 + 5}`);
});

test("B11b Realtime gap reconciled on rejoin: stock changed while the socket was blocked appears without a reload or a later event", async () => {
  // Phase G follow-up to B11 (finding F7): after a Realtime-only outage the
  // client now re-reads the shop's inventory from the server on rejoin
  // (stores/data/inventoryRealtime.ts), so a change made during the cut is
  // shown without a reload and without waiting for the next event.
  await A.gotoPos();
  if (!B) {
    B = await Terminal.launchBrowser();
    await B.login(emails.cashB, pw);
    await B.waitForRoute("/app/pos");
    await B.waitForApp();
  }
  const Bt = B;
  await Bt.installRealtimeProxy();
  const tInstall = Date.now();
  await Bt.gotoPos();
  await Bt.waitForRealtimeReady(tInstall);
  const q0 = await inv(ids.shop, ids.prod2);
  await expect.poll(() => Bt.posStockText("QA Product Two"), { timeout: 30_000 }).toBe(`${q0} in stock`);
  await Bt.page.evaluate(() => { (window as any).__e2eMarker3 = "no-reload"; });
  const badge = Bt.page.locator('[data-testid="inventory-sync-badge"]');

  // Cut the socket, then change the row with the SERVICE ROLE: a direct
  // UPDATE (no RPC, no movement, no actor) — exactly what a change this
  // client cannot otherwise learn about looks like.
  const tCut = Date.now();
  await Bt.blockRealtime(true);
  await sleep(3000);
  const edit = await svc().from("inventory").update({ qty_base_units: q0 + 7 }).match({ shop_id: ids.shop, product_id: ids.prod2 });
  expect(edit.error).toBeNull();
  expect(await inv(ids.shop, ids.prod2)).toBe(q0 + 7);
  await sleep(6000);
  const duringCut = await Bt.posStockText("QA Product Two");
  const refused = Bt.wsEvents.filter((e) => Number(e.split(" ")[0]) >= tCut && /refused/.test(e)).length;
  expect(refused).toBeGreaterThanOrEqual(1);
  // the till tells the cashier its live stock is not confirmed
  await expect(badge).toBeVisible({ timeout: 10_000 });
  const badgeState = await badge.getAttribute("data-state");

  // Restore. NO further change is made: the rejoin's own authoritative
  // refresh has to bring the +7 in.
  const tRestore = Date.now();
  await Bt.blockRealtime(false);
  const readyMs = await Bt.waitForRealtimeReady(tRestore, 60_000);
  const t0 = Date.now();
  await expect.poll(() => Bt.posStockText("QA Product Two"), { timeout: 30_000 }).toBe(`${q0 + 7} in stock`);
  const catchUpMs = Date.now() - t0;
  await expect(badge).toBeHidden({ timeout: 10_000 });
  expect(await Bt.page.evaluate(() => (window as any).__e2eMarker3)).toBe("no-reload");
  // one authoritative read of the shop's rows happened on the rejoin
  const refreshes = Bt.requestsMatching(/\/rest\/v1\/inventory\?/, tRestore).length;
  expect(refreshes).toBeGreaterThanOrEqual(1);

  // Revert the direct edit (keeps the ledger gate inventory = initial +
  // sum(movements) true); the revert must arrive live now the feed is back.
  const revert = await svc().from("inventory").update({ qty_base_units: q0 }).match({ shop_id: ids.shop, product_id: ids.prod2 });
  expect(revert.error).toBeNull();
  await expect.poll(() => Bt.posStockText("QA Product Two"), { timeout: 30_000 }).toBe(`${q0} in stock`);
  expect(await inv(ids.shop, ids.prod2)).toBe(q0);
  record("B", "Realtime gap reconciled on rejoin", "PASS",
    `B's realtime socket cut (${refused} reconnect attempt(s) refused); service-role UPDATE ${q0}->${q0 + 7} during the cut showed "${duringCut}" on B (DB ${q0 + 7}); badge "${badgeState}" shown; socket released -> postgres_changes re-confirmed after ${readyMs} ms; the card reached "${q0 + 7} in stock" ${catchUpMs} ms later from the rejoin refresh (${refreshes} inventory read(s)) with no reload and no further event; badge cleared; service-role revert to ${q0} arrived live; DB ${q0}`);
});

test("B12 no request ever left for the hosted project", async () => {
  expect(A.hostedRequests).toEqual([]);
  expect(B?.hostedRequests ?? []).toEqual([]);
  record("guard", "hosted project untouched (spec B)", "PASS", `0 requests to *.supabase.co from either terminal; all traffic to ${new URL(liveCfg().url).host}`);
});
