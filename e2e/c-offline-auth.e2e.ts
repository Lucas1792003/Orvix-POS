/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase E · C. Offline authorisation window (docs/selfhost-migration/phase-d/
// offline-authorization.md): the clock is `authCache.cachedAt` in IndexedDB,
// edited through page.evaluate. Results feed
// docs/selfhost-migration/phase-e/offline-authorization-verification.md.
import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { count, inv, keyRows, row, setUserActive, sleep } from "./helpers/db";
import { RESULTS_DIR, qaPassword, qaState, qaTotpSecret } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal } from "./helpers/terminal";

test.describe.configure({ mode: "serial" });

const st = qaState();
const pw = qaPassword();
const { ids, emails } = st;
const USERDATA = path.join(RESULTS_DIR, "userdata-c");
const WRITE_REFUSED = "This device has been offline for more than 12 hours. Reconnect to the internet to verify your sign-in before recording new offline activity — anything already queued is kept and will sync.";

let A: Terminal;

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
    setUserActive(ids.cashA, true);
    await assertConsistency("spec C", [A]);
  } finally {
    await A?.close();
  }
});

test("C1 offline writes: allowed at 11 h since last contact, refused at 13 h (queue preserved)", async () => {
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  await A.setOffline(true);
  const at11 = await A.setAuthCacheAge(11);
  await A.posScan(st.barcodeValue);
  const allowed = await A.posCheckout(1000);
  expect(allowed.receiptNo).toBe("PENDING");
  const queuedAt11 = await A.outbox();
  expect(queuedAt11).toHaveLength(1);

  const at13 = await A.setAuthCacheAge(13);
  await A.posScan(st.barcodeValue);
  await A.posScan(st.barcodeValue);
  const refused = await A.posCheckoutExpectFailure(2000);
  expect(refused).toContain("Checkout failed");
  expect(refused).toContain(WRITE_REFUSED);
  // nothing discarded: the earlier entry is still queued, no second entry
  const queuedAt13 = await A.outbox();
  expect(queuedAt13.map((e) => e.localId)).toEqual(queuedAt11.map((e) => e.localId));
  expect((await A.localSales()).filter((s: any) => s.receiptNo === "PENDING")).toHaveLength(1);
  // the refused checkout left the cart intact for the cashier to retry later
  await expect(A.page.locator("text=1 item")).toBeVisible();
  // the shift page's write (close) is gated the same way
  const closeToast = await A.closeShift(0, "QA variance while offline");
  expect(closeToast ?? "").toContain("Could not close shift");
  expect(closeToast ?? "").toContain("offline for more than 12 hours");
  expect(await A.outbox()).toHaveLength(1);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0);
  record("C", "write window: 11 h allowed, 13 h refused", "PASS",
    `cachedAt=${at11} (11 h ago) -> offline sale queued (PENDING); cachedAt=${at13} (13 h ago) -> checkout refused with the documented message, queue still 1 entry, PENDING record kept, cart kept; offline close_shift refused with the same message; DB untouched (sales ${salesBefore}, stock ${q0})`);
  // Clean up the cart for the next test.
  await A.gotoPos();
  await A.page.getByRole("button", { name: /remove|delete/i }).first().click().catch(() => undefined);
});

test("C2 read-only session: allowed at 23 h, logged out at 25 h; sign-in restores sync and drains the preserved queue", async () => {
  // Still offline from C1 with one queued sale.
  const [entry] = await A.outbox();
  expect(entry.status).toBe("pending");
  const at23 = await A.setAuthCacheAge(23);
  await A.close();
  A = await Terminal.launchElectron(USERDATA, { offline: true });
  await A.waitForApp();
  const user23 = await A.page.locator("aside.sidebar .user-name").innerText();
  expect(user23).toBe("QA Cashier A");
  await expect(A.badge("1 action waiting to sync")).toBeVisible();
  await A.gotoPos();
  await expect(A.page.getByRole("heading", { name: "Point of Sale" })).toBeVisible();

  const at25 = await A.setAuthCacheAge(25);
  await A.close();
  A = await Terminal.launchElectron(USERDATA, { offline: true });
  await A.waitForRoute("/login", 60_000);
  const loggedOut = A.currentRoute();
  // The queue survived the lapse.
  expect((await A.outbox()).map((e) => e.localId)).toEqual([entry.localId]);
  // Offline sign-in is impossible (the server is unreachable): the page shows an error, nothing is lost.
  await A.login(emails.cashA, pw);
  const offlineLoginError = await A.loginError(15_000);
  expect(offlineLoginError).toBeTruthy();
  expect((await A.outbox()).map((e) => e.localId)).toEqual([entry.localId]);

  // Reconnect and sign in: sync resumes and the preserved queue drains.
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  await A.setOffline(false);
  await A.login(emails.cashA, pw);
  await A.waitForRoute("/app");
  await A.waitForApp();
  await expect.poll(async () => (await A.outbox()).length, { timeout: 60_000 }).toBe(0);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 1);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(1);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0 - 1);
  const cache = (await A.authCache())[0];
  expect(Date.now() - Date.parse(cache.cachedAt)).toBeLessThan(60_000);
  record("C", "read-only window: 23 h allowed, 25 h logged out; re-auth drains", "PASS",
    `cachedAt ${at23} (23 h) -> offline boot still signed in as ${user23}, POS visible, badge shows the queued action; cachedAt ${at25} (25 h) -> offline boot lands on ${loggedOut}; queue kept (entry ${entry.localId}); offline sign-in attempt -> "${offlineLoginError}" (queue kept); online sign-in -> drained: sales ${salesBefore}->${salesBefore + 1}, key row present, stock ${q0 - 1}; cachedAt refreshed to now`);
});

test("C3 cashier deactivated while offline -> queued sale rejected on replay as a permanent conflict", async () => {
  await A.gotoPos();
  const q0 = await inv(ids.shop, ids.prod1);
  const salesBefore = await count("sales", { shop_id: ids.shop });
  await A.setOffline(true);
  await A.posScan(st.barcodeValue);
  const queued = await A.posCheckout(1000);
  expect(queued.receiptNo).toBe("PENDING");
  const [entry] = await A.outbox();
  // Deactivated by an administrator while the till is offline.
  const deactivated = setUserActive(ids.cashA, false);
  expect(deactivated).toBe(`${ids.cashA}:false`);
  await A.setOffline(false);
  await expect.poll(async () => (await A.outbox())[0]?.status, { timeout: 90_000 }).toBe("conflict");
  const conflict = (await A.outbox())[0];
  expect(conflict).toMatchObject({ localId: entry.localId, failureKind: "permanent" });
  expect(conflict.lastError).toMatch(/Not authenticated/i);
  // The reconnect full load no longer sees the cashier's own users row
  // (RLS hides inactive accounts), so the till drops to /login; the
  // conflict badge is then shown to whoever signs in on this till.
  await sleep(1500);
  const landedOn = A.currentRoute();
  const badgeForCashier = landedOn.startsWith("/login") ? "n/a (signed out)" : await A.badge(/1 sync conflict needs attention/).isVisible();
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  expect((await keyRows([entry.idempotencyKey!])).length).toBe(0);
  expect(await inv(ids.shop, ids.prod1)).toBe(q0);
  const localKept = (await A.localSales()).find((s: any) => s.receiptNo === "PENDING");
  expect(localKept?.pendingSync).toBe(true);
  // The server is the authority: a direct replay with this user's own token fails the same way.
  const direct = await A.rpcAsPageUser("complete_sale", conflict.args as Record<string, unknown>);
  record("C", "deactivated cashier: queued sale rejected on replay", "PASS",
    `users.is_active=false set server-side while offline; reconnect -> replay rejected: entry ${entry.localId} status=conflict/permanent, lastError "${conflict.lastError}"; DB: no sale, no key row, stock ${q0}; local PENDING sale kept flagged for manual reconciliation; till landed on ${landedOn} (conflict badge for the cashier: ${badgeForCashier}); direct replay with the same token -> HTTP ${direct.status} "${direct.body?.message}"`);

  // Re-activate, dismiss the conflict (admin's call on this till), sign back in.
  expect(setUserActive(ids.cashA, true)).toBe(`${ids.cashA}:true`);
  await A.goto("/login");
  await A.page.waitForTimeout(500);
  if (!(await A.page.locator('input[type="email"]').isVisible())) await A.logout();
  const secret = qaTotpSecret();
  await A.loginAdminWithTotp(emails.admin, pw, secret);
  await A.waitForApp();
  await expect(A.badge(/1 sync conflict needs attention/)).toBeVisible();
  await A.navigate("/app/admin/sync-conflicts");
  await expect(A.page.getByText("Needs action")).toBeVisible();
  await expect(A.page.getByText("1 conflict · 0 entries still syncing")).toBeVisible();
  await A.toastsNow();
  await A.page.getByRole("button", { name: "Dismiss" }).click();
  await A.toast(/Dismissed/);
  expect(await A.outbox()).toHaveLength(0);
  await A.logout();
  await A.login(emails.cashA, pw);
  const tLogin = Date.now();
  const relogin = await Promise.race([
    expect.poll(() => A.currentRoute(), { timeout: 30_000 }).toMatch(/^\/app/).then(() => "app" as const, () => "timeout" as const),
    A.page.locator('form [role="alert"]').waitFor({ state: "visible", timeout: 30_000 }).then(() => "error" as const, () => "timeout" as const),
  ]);
  if (relogin !== "app") {
    const text = relogin === "error" ? (await A.page.locator('form [role="alert"]').innerText()).replace(/\s+/g, " ").trim() : "(no alert)";
    const reqs = A.requestsMatching(/rest\/v1\/(users|shops)|auth\/v1\/(token|logout)/, tLogin - 2000).map((r) => `${r.method} ${r.url.split("/v1/")[1]?.slice(0, 40)} -> ${r.status}`);
    const diag = `outcome=${relogin}; error="${text}"; route=${A.currentRoute()}; session=${Boolean(await A.storedSession())}; syncState=${JSON.stringify(await A.syncState())}; console: ${A.consoleErrors.slice(-6).join(" || ")}; requests: ${reqs.join(" | ")}`;
    record("C", "deactivated cashier: re-login after re-activation", "INFO", diag);
    throw new Error(`cashier re-login did not reach /app: ${diag}`);
  }
  await A.waitForApp();
  expect((await A.authCache()).some((c) => c.userId === ids.cashA && c.isActive)).toBe(true);
  record("C", "deactivated cashier: re-activation + conflict dismissed", "PASS",
    `users.is_active=true restored; admin signed in on the same till: badge "1 sync conflict needs attention", Sync Conflicts page "1 conflict · 0 entries still syncing" / Needs action; dismissed (outbox empty, provisional record kept locally); cashier A signs in again normally`);
});
