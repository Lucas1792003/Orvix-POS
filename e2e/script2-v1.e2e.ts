/* eslint-disable @typescript-eslint/no-explicit-any */
// Recovery Script 2 — the REAL Electron app against Recovery V1 on the DISPOSABLE loopback stack
// (tools/recovery-v1/script2/run-electron.sh). What a real till does, asserted in its IndexedDB AND in PostgreSQL:
//   1. on the legacy (086) server: an online sale is recorded; an offline sale is queued (receipt PENDING);
//   2. V1 is installed (QA organization ACTIVE as a SYNTHETIC fixture; V1 has no reopen path);
//   3. the queued pre-V1 sale is never lost or duplicated (within the till's 60 s "no V1" cache it may still drain under
//      the legacy rules: the server accepts because the organization is ACTIVE);
//   4. a NEW sale online / offline / after a relaunch / with the organization RESTRICTED is refused before anything
//      is saved — because the shipped app has NO independent device-trust source configured (no TOFU), so V1's
//      "independent device authorization" can never be satisfied and no offline capability is ever requested.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Terminal } from "./helpers/terminal";
import { runSql } from "./helpers/db";
import { PROJECT_ROOT } from "./helpers/env";
import { P1, profile, serverSales, st, pw } from "./m086-helpers";

test.describe.configure({ mode: "serial" });
test.skip(process.env.SCRIPT2_LIVE !== "1", "Script 2 Electron: run via tools/recovery-v1/script2/run-electron.sh");
if (process.env.SCRIPT2_LIVE === "1" && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) {
  throw new Error("SCRIPT2_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER");
}
const OUT = process.env.SCRIPT2_OUT ?? path.join(PROJECT_ROOT, "tools/recovery-v1/script2/results/adhoc");
const evidence: Record<string, unknown> = {};
const note = (id: string, v: unknown) => { evidence[id] = v; console.log(`[script2] ${id} ${JSON.stringify(v)}`); };
const sql1 = (q: string) => runSql(q).trim().split("\n").filter(Boolean).pop() ?? "";
const NAME = "s2-v1";
let T: Terminal;

test.afterAll(async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "e2e-evidence.json"), JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
  await T?.close().catch(() => undefined);
});

/** Checkout that the till must refuse: returns the toast text. */
async function checkoutRefused(t: Terminal): Promise<string> {
  await t.page.keyboard.press("F2");
  const amount = t.page.getByLabel("Amount received");
  await amount.waitFor({ state: "visible" });
  await amount.fill("5000");
  await t.toastsNow();
  await amount.press("Enter");
  const toast = await t.toast(/Sale not recorded|Checkout failed|not recorded/i, 60_000);
  await t.page.keyboard.press("Escape").catch(() => undefined);
  return toast;
}

test("S2-E1 legacy 086 server: an online sale is recorded by the server", async () => {
  rmSync(profile(NAME), { recursive: true, force: true });
  T = await Terminal.launchElectron(profile(NAME));
  await T.signIn(st.emails.cashA, pw, "/app");
  await T.waitForApp();
  await T.openShift(10000);
  await T.gotoPos();
  const before = await serverSales();
  await T.posAddByCard(P1);
  const r = await T.posCheckout(5000);
  expect(r.receiptNo).not.toBe("PENDING");
  expect(await serverSales()).toBe(before + 1);
  note("E1", { receipt: r.receiptNo });
});

test("S2-E2 legacy server, network cut: the sale is recorded on the till only (PENDING), queued with its key", async () => {
  const before = await serverSales();
  await T.setOffline(true);
  await T.posAddByCard(P1);
  const r = await T.posCheckout(5000);
  expect(r.receiptNo).toBe("PENDING");
  expect(r.toast).toMatch(/this till only|Sale recorded/);
  const q = (await T.outbox()).filter((e: any) => e.name === "complete_sale");
  expect(q).toHaveLength(1);
  expect(await serverSales()).toBe(before);
  note("E2", { key: q[0].idempotencyKey, toast: r.toast, local: (await T.localSales()).filter((s: any) => s.pendingSync).length });
  evidence.queuedKey = q[0].idempotencyKey;
});

test("S2-E3 Recovery V1 installed while the till is offline; on reconnect the queued pre-V1 sale is never lost and never duplicated", async () => {
  const out = execFileSync("bash", [path.join(PROJECT_ROOT, "tools/recovery-v1/script2/install-v1-stack.sh"), OUT, st.ids.org], { encoding: "utf8" });
  note("install", out.trim());
  expect(out).toMatch(/integrity=none qa_org=ACTIVE/);
  const before = await serverSales();
  await T.setOffline(false);
  await T.page.waitForTimeout(20_000);                         // the drain runs on reconnect
  const q = (await T.outbox()).filter((e: any) => e.name === "complete_sale");
  const key = String(evidence.queuedKey);
  const ledger = sql1(`select coalesce((select state from idempotency_keys where key = '${key}'::uuid and org_id = '${st.ids.org}'), '<none>')`);
  const after = await serverSales();
  // the till had answered "no V1 here" less than 60 s before (ABSENT_RECHECK_MS): it may still drain under the legacy
  // rules; the server accepts because the organization is ACTIVE (V1 enforces organization state, not device trust)
  if (q.length === 0) {
    expect(ledger).toBe("committed");                          // sent: committed exactly once, not lost
    expect(after).toBe(before + 1);
  } else {
    expect(q[0].idempotencyKey).toBe(key);                     // kept: same key, not sent
    expect(ledger).toBe("<none>");
    expect(after).toBe(before);
  }
  note("E3", { drained: q.length === 0, ledger, serverSalesDelta: after - before, status: q[0]?.status ?? null,
    lastError: String((q[0] as any)?.lastError ?? "").slice(0, 200) });
  evidence.queuedDrained = q.length === 0;
  await T.page.waitForTimeout(65_000);                         // past the 60 s "no V1" cache: the till asks the server again
});

test("S2-E4 V1, ACTIVE organization, online: a NEW sale is refused before anything is saved (no independent device trust in the shipped app)", async () => {
  await T.gotoPos();
  const before = await serverSales();
  const queued = (await T.outbox()).length;
  await T.posAddByCard(P1);
  const toast = await checkoutRefused(T);
  expect((await T.outbox()).length).toBe(queued);
  expect(await serverSales()).toBe(before);
  note("E4", { toast: toast.slice(0, 300) });
});

test("S2-E5 V1 offline: no offline capability exists (never requested), so an offline sale is refused; nothing queued", async () => {
  const caps = sql1(`select count(*) from recovery_v1.offline_capabilities where org_id = '${st.ids.org}'`);
  expect(caps).toBe("0");
  await T.setOffline(true);
  await T.gotoPos();
  const queued = (await T.outbox()).length;
  await T.posAddByCard(P1);
  const toast = await checkoutRefused(T);
  expect((await T.outbox()).length).toBe(queued);
  note("E5", { capabilities: caps, toast: toast.slice(0, 300) });
});

test("S2-E6 relaunch while offline: the queue survives unchanged", async () => {
  await T.close();
  T = await Terminal.launchElectron(profile(NAME), { offline: true });
  await T.goto("/login");
  const q = (await T.outbox()).filter((e: any) => e.name === "complete_sale");
  if (evidence.queuedDrained) expect(q).toHaveLength(0);
  else { expect(q).toHaveLength(1); expect(q[0].idempotencyKey).toBe(evidence.queuedKey); }
  note("E6", { queued: q.length });
});

test("S2-E7 organization RESTRICTED (fixture): online sale refused; nothing queued is lost", async () => {
  await T.close();
  T = await Terminal.launchElectron(profile(NAME));
  await T.goto("/app/pos");
  await Promise.race([
    T.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 60_000 }),
    T.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 60_000 }),
  ]);
  if (await T.page.locator('input[type="email"]').isVisible()) { note("E7.session-lost-on-restart", true); await T.signIn(st.emails.cashA, pw, "/app"); }
  await T.waitForApp();
  sql1(`update recovery_v1.org_state set state = 'RESTRICTED' where org_id = '${st.ids.org}'`);
  await T.gotoPos();
  const before = await serverSales();
  await T.posAddByCard(P1);
  const toast = await checkoutRefused(T);
  expect(await serverSales()).toBe(before);
  const q = (await T.outbox()).filter((e: any) => e.name === "complete_sale");
  if (!evidence.queuedDrained) { expect(q).toHaveLength(1); expect(q[0].idempotencyKey).toBe(evidence.queuedKey); }
  note("E7", { toast: toast.slice(0, 300), queued: q.length, offlineEpoch: sql1(`select offline_epoch from recovery_v1.org_state where org_id = '${st.ids.org}'`) });
});
