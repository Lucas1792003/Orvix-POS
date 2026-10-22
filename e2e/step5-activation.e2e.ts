/* eslint-disable @typescript-eslint/no-explicit-any */
// Recovery V1, Step 5 — the REAL Electron app on the DISPOSABLE loopback stack (tools/recovery-v1/step5/run-electron.sh).
// Device enrollment, owner-signed reopening and aggregate offline budgets, asserted in the till's own state AND in PostgreSQL.
// The owner is a SYNTHETIC test signer (key in a host temp dir, never in the database container) and the operator acts through
// the orvix_recovery_operator role exactly as Orvix Control would. Neither is an independent production authority.
// Scenario numbers refer to the Step 5 brief (Phase 5).
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Terminal } from "./helpers/terminal";
import { userClient } from "./helpers/db";
import { PROJECT_ROOT } from "./helpers/env";
import { P1, profile, serverSales, st, pw } from "./m086-helpers";
import { approveDevice, operator, pendingRequests, reconcile, reopen, sqlOne, submit, SyntheticOwner } from "./helpers/step5Owner";

test.describe.configure({ mode: "serial" });
test.skip(process.env.STEP5_LIVE !== "1", "Step 5 Electron: run via tools/recovery-v1/step5/run-electron.sh");
if (process.env.STEP5_LIVE === "1" && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER)) throw new Error("STEP5_LIVE needs E2E_LOOPBACK_ONLY=1 and E2E_DB_CONTAINER");
const OUT = process.env.STEP5_OUT ?? path.join(PROJECT_ROOT, "tools/recovery-v1/step5/results/adhoc");
const evidence: Record<string, unknown> = {};
const note = (id: string, v: unknown) => { evidence[id] = v; console.log(`[step5] ${id} ${JSON.stringify(v)}`); };
let owner: SyntheticOwner;
let T: Terminal | null = null;
const ORG = () => st.ids.org;

test.afterAll(async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "e2e-evidence.json"), JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
  await T?.close().catch(() => undefined);
});

async function launch(name: string, opts: { fresh?: boolean; offline?: boolean } = {}): Promise<Terminal> {
  if (T) { await T.close().catch(() => undefined); T = null; }
  if (opts.fresh) rmSync(profile(name), { recursive: true, force: true });
  const t = await Terminal.launchElectron(profile(name), { offline: opts.offline });
  await t.goto("/app/pos");
  await Promise.race([
    t.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 60_000 }),
    t.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 60_000 }),
  ]);
  if (await t.page.locator('input[type="email"]').isVisible()) { await t.signIn(st.emails.cashA, pw, "/app"); }
  await t.waitForApp();
  T = t;
  return t;
}
async function ensureShift(t: Terminal): Promise<void> {
  const open = sqlOne(`SELECT count(*) FROM public.shifts WHERE shop_id='${st.ids.shop}' AND cashier_id='${st.ids.cashA}' AND ended_at IS NULL;`);
  if (open === "0") await t.openShift(10000);
  await t.gotoPos();
}
/** A checkout the till must refuse: returns the toast text. */
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
const panel = (t: Terminal) => t.page.getByTestId("device-trust-panel");
const phase = async (t: Terminal, p: string, timeout = 90_000) => expect(panel(t)).toHaveAttribute("data-phase", p, { timeout });
const tillDeviceId = async (t: Terminal): Promise<string> => t.page.evaluate(async () => {
  const req = indexedDB.open("orvix-recovery-till-v1");
  const db: IDBDatabase = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const rows: any[] = await new Promise((res, rej) => { const g = db.transaction("tills").objectStore("tills").getAll(); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
  db.close();
  return rows.filter((r) => !r.retired).map((r) => r.deviceId)[0] ?? "";
});
const capsOf = (enrollment: string) => sqlOne(`SELECT coalesce(string_agg(max_amount_mmk::text, ',' ORDER BY issued_at), '') FROM recovery_v1.offline_capabilities WHERE enrollment_id='${enrollment}';`);
const otherOrgsRestricted = () => sqlOne(`SELECT count(*) FILTER (WHERE state <> 'ACTIVE') || '/' || count(*) FROM recovery_v1.org_state WHERE org_id <> '${ORG()}';`);

async function requestAndApprove(t: Terminal, label: string): Promise<{ deviceId: string; enrollmentId: string; code: string }> {
  await phase(t, "none");
  await t.page.getByTestId("device-trust-request").click();
  await phase(t, "pending");
  const code = (await t.page.getByTestId("device-trust-code").innerText()).replace(/-/g, "");
  const deviceId = await tillDeviceId(t);
  const req = pendingRequests(ORG()).find((r) => r.deviceId === deviceId)!;
  expect(req.keyFingerprint.slice(0, 16).toUpperCase()).toBe(code);     // the owner compares the code shown on the till
  const r = approveDevice(owner, ORG(), req);
  expect(r.outcome).toBe("enrolled");
  note(`${label}.enrolled`, { deviceId, code, enrollmentId: r.enrollmentId });
  return { deviceId, enrollmentId: String(r.enrollmentId), code };
}

let T1: { deviceId: string; enrollmentId: string } = { deviceId: "", enrollmentId: "" };
let T2: { deviceId: string; enrollmentId: string } = { deviceId: "", enrollmentId: "" };
let T3: { deviceId: string; enrollmentId: string } = { deviceId: "", enrollmentId: "" };

test("S16 before Recovery V1 (legacy 086 server): the till sells online and offline exactly as before, no device enrollment involved", async () => {
  const t = await launch("s5-t1", { fresh: true });
  await ensureShift(t);
  const before = await serverSales();
  await t.posAddByCard(P1);
  const r = await t.posCheckout(5000);
  expect(r.receiptNo).not.toBe("PENDING");
  await t.setOffline(true);
  await t.posAddByCard(P1);
  const off = await t.posCheckout(5000);
  expect(off.receiptNo).toBe("PENDING");
  await t.setOffline(false);
  await expect.poll(async () => (await t.outbox()).filter((e: any) => e.name === "complete_sale").length, { timeout: 60_000 }).toBe(0);
  expect(await serverSales()).toBe(before + 2);
  note("S16", { online: r.receiptNo, offlineThenSynced: true, delta: 2 });
  await t.close(); T = null;
});

test("install Recovery V1 (synthetic owner key on the host; no ACTIVE fixture): every organization RESTRICTED", async () => {
  // a second synthetic organization (before V1: V1 closes onboarding), so S04/S18 prove reopening one never reopens another
  sqlOne(`INSERT INTO public.organizations (id, name) VALUES ('s5-other-${st.ts}', 'Step 5 other synthetic organization') ON CONFLICT DO NOTHING; SELECT 1;`);
  const out = execFileSync("bash", [path.join(PROJECT_ROOT, "tools/recovery-v1/step5/install-v1-stack.sh"), OUT, ORG()], { encoding: "utf8" });
  const info = JSON.parse(out.trim().split("\n").pop()!);
  expect(info.integrity).toBe("none"); expect(info.qaState).toBe("RESTRICTED");
  owner = new SyntheticOwner(info.keydir, info.keyId, path.join(OUT, "owner-work"));
  process.env.ORVIX_POS_E2E_OWNER_TRUST = JSON.stringify([info.ownerFingerprint]);   // the anchor PROVISIONED on every till
  expect(sqlOne("SELECT count(*) FILTER (WHERE state='RESTRICTED') = count(*) FROM recovery_v1.org_state;")).toBe("t");
  note("install", { ownerFingerprint: info.ownerFingerprint, orgs: sqlOne("SELECT count(*) FROM recovery_v1.org_state;") });
  await new Promise((r) => setTimeout(r, 65_000));   // past the till's 60 s "no Recovery V1 here" cache
});

test("S01 V1 installed, organization RESTRICTED, device untrusted: sale refused; nothing saved or sent", async () => {
  const t = await launch("s5-t1");
  await ensureShift(t);
  const before = await serverSales(); const queued = (await t.outbox()).length;
  await t.posAddByCard(P1);
  const toast = await checkoutRefused(t);
  expect(await serverSales()).toBe(before); expect((await t.outbox()).length).toBe(queued);
  await phase(t, "none");
  note("S01", { toast: toast.slice(0, 200) });
});

test("S01b enrollment: a fake approval (key the database does not hold) and an approval for another shop are refused; the genuine one enrolls; replay refused", async () => {
  const t = T!;
  await t.page.getByTestId("device-trust-request").click();
  await phase(t, "pending");
  const deviceId = await tillDeviceId(t);
  const req = pendingRequests(ORG()).find((r) => r.deviceId === deviceId)!;
  owner.keygen("attacker-e2e");
  const fake = approveDevice(owner, ORG(), req, {}, { keyId: "attacker-e2e" });
  const wrongShop = approveDevice(owner, ORG(), req, { shopId: st.ids.shop2 });
  expect(fake.outcome).toBe("refused"); expect(wrongShop.outcome).toBe("refused");
  await t.page.getByTestId("device-trust-check").click({ timeout: 3_000 }).catch(() => undefined);
  await phase(t, "pending", 30_000);
  const a = owner.authorize("enroll-device", { scope: ORG(), ownerId: "SYNTHETIC", device: { requestId: req.requestId, orgId: ORG(), shopId: req.shopId, deviceId,
    keyFingerprint: req.keyFingerprint, requestNonce: req.requestNonce, notAfter: new Date(Date.now() + 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z"), replacesEnrollmentId: null } });
  const ok = submit(a); const replay = submit(a);
  expect(ok.outcome).toBe("enrolled"); expect(replay.outcome).toBe("refused");
  // the panel asks the server every 10 s while pending; "Check approval" only makes it ask at once (it may already be gone)
  await t.page.getByTestId("device-trust-check").click({ timeout: 3_000 }).catch(() => undefined);
  await phase(t, "trusted");
  T1 = { deviceId, enrollmentId: String(ok.enrollmentId) };
  note("S01b", { fake: String(fake.reason).slice(0, 120), wrongShop: String(wrongShop.reason).slice(0, 120), replay: String(replay.reason).slice(0, 120), T1 });
});

test("S02 organization RESTRICTED, device trusted: sale refused; the trusted till reports a signed attestation for the incident", async () => {
  const t = T!;
  const before = await serverSales();
  await t.posAddByCard(P1);
  const toast = await checkoutRefused(t);
  expect(await serverSales()).toBe(before);
  await expect.poll(() => sqlOne(`SELECT count(*) FROM recovery_v1.device_attestations WHERE enrollment_id='${T1.enrollmentId}';`), { timeout: 90_000 }).not.toBe("0");
  note("S02", { toast: toast.slice(0, 160), attestations: sqlOne(`SELECT count(*) FROM recovery_v1.device_attestations WHERE enrollment_id='${T1.enrollmentId}';`) });
});

test("S03 valid owner authorization but insufficient recovery evidence (an approved till has not reported): reopening refused", async () => {
  // a second till requests enrollment and is approved, but is CLOSED before it can attest
  const t = await launch("s5-t2", { fresh: true });
  await ensureShift(t);
  await t.posAddByCard(P1); await checkoutRefused(t);       // the till learns the server runs V1
  T2 = await requestAndApprove(t, "T2");
  await t.close(); T = null;
  const rep = reconcile(ORG());
  expect(rep.blockers).toContain("device_attestation_missing");
  const r = reopen(owner, ORG(), rep, "verified");
  expect(r.outcome).toBe("refused"); expect(String(r.reason)).toContain("REOPEN_BLOCKED");
  expect(sqlOne(`SELECT state FROM recovery_v1.org_state WHERE org_id='${ORG()}';`)).toBe("RECONCILING");
  note("S03", { blockers: rep.blockers, reopen: String(r.reason).slice(0, 160) });
});

test("S04 verified recovery evidence (every approved till attested, nothing unsynced) + valid synthetic owner authorization: transition to ACTIVE; S18 no other organization reopened", async () => {
  const t = await launch("s5-t2");
  await phase(t, "trusted");
  await expect.poll(() => sqlOne(`SELECT count(*) FROM recovery_v1.device_attestations WHERE enrollment_id='${T2.enrollmentId}';`), { timeout: 90_000 }).not.toBe("0");
  const rep = reconcile(ORG());
  expect(rep.blockers).toEqual([]);
  const r = reopen(owner, ORG(), rep, "verified");
  expect(r.outcome).toBe("reopened");
  expect(sqlOne(`SELECT state || '/' || coalesce(recovery_v1.activation_problem('${ORG()}'), 'verified') FROM recovery_v1.org_state WHERE org_id='${ORG()}';`)).toBe("ACTIVE/verified");
  const others = otherOrgsRestricted();
  expect(others.split("/")[0]).toBe(others.split("/")[1]); expect(Number(others.split("/")[1])).toBeGreaterThan(0);
  note("S04", { reopen: r, otherOrgsRestricted: others });
  await t.close(); T = null;
});

test("S05 organization ACTIVE, device untrusted (a third till not yet approved): sale refused", async () => {
  const t = await launch("s5-t3", { fresh: true });
  await ensureShift(t);
  const before = await serverSales();
  await t.posAddByCard(P1);
  const toast = await checkoutRefused(t);
  expect(await serverSales()).toBe(before);
  note("S05", { toast: toast.slice(0, 160) });
  await t.page.getByTestId("device-trust-request").click();   // asks; approved later
  await phase(t, "pending");
  T3 = { deviceId: await tillDeviceId(t), enrollmentId: "" };
  await t.close(); T = null;
});

test("S06 organization ACTIVE, device trusted: online sale succeeds and the server recorded the device's signature for it", async () => {
  const t = await launch("s5-t1");
  await ensureShift(t);
  const before = await serverSales();
  await t.posAddByCard(P1);
  const r = await t.posCheckout(5000);
  expect(r.receiptNo).not.toBe("PENDING");
  expect(await serverSales()).toBe(before + 1);
  const signed = sqlOne(`SELECT count(*) FROM recovery_v1.device_counters c JOIN public.idempotency_keys k ON k.key = c.op_key WHERE c.enrollment_id='${T1.enrollmentId}' AND k.rpc='complete_sale' AND k.org_id='${ORG()}';`);
  expect(Number(signed)).toBeGreaterThan(0);
  // the online sale also refreshed this till's offline authority: issued within its device budget (20,000)
  await expect.poll(() => capsOf(T1.enrollmentId), { timeout: 60_000 }).toMatch(/20000/);
  note("S06", { receipt: r.receiptNo, signedOps: signed, caps: capsOf(T1.enrollmentId) });
});

test("S07/S08/S12 offline: sales are recorded locally as PENDING (not server-confirmed) under the capability; when it is exhausted new offline sales are refused and queued ones are kept", async () => {
  const t = T!;
  const before = await serverSales();
  await t.setOffline(true);
  const keys: string[] = [];
  for (let i = 0; i < 2; i++) {
    await t.posAddByCard(P1);
    const r = await t.posCheckout(5000);
    expect(r.receiptNo).toBe("PENDING"); expect(r.toast).toMatch(/this till only|Sale recorded/);
  }
  const q = (await t.outbox()).filter((e: any) => e.name === "complete_sale");
  expect(q).toHaveLength(2); for (const e of q as any[]) { expect(e.offlineAuth).toBeTruthy(); keys.push(String(e.idempotencyKey)); }
  await t.posAddByCard(P1);
  const refused = await checkoutRefused(t);
  expect((await t.outbox()).filter((e: any) => e.name === "complete_sale")).toHaveLength(2);
  expect(await serverSales()).toBe(before);
  evidence.offlineKeys = keys;
  note("S07-S12", { keys, refused: refused.slice(0, 160) });
});

test("S13 device restart (offline) preserves the pending sales with the same keys", async () => {
  const t = await launch("s5-t1", { offline: true });
  const q = (await t.outbox()).filter((e: any) => e.name === "complete_sale").map((e: any) => e.idempotencyKey).sort();
  expect(q).toEqual([...(evidence.offlineKeys as string[])].sort());
  note("S13", { queued: q.length });
});

test("S14/S09 server crash and restart: the pending sales sync once with their original keys after reconnect (no duplicate execution)", async () => {
  const t = T!;
  const before = await serverSales();
  execFileSync("docker", ["restart", "phf-iso-db"], { encoding: "utf8" });
  await expect.poll(() => { try { return sqlOne("SELECT 1;"); } catch { return ""; } }, { timeout: 120_000 }).toBe("1");
  await new Promise((r) => setTimeout(r, 5_000));
  await t.setOffline(false);
  await expect.poll(async () => (await t.outbox()).filter((e: any) => e.name === "complete_sale").length, { timeout: 120_000 }).toBe(0);
  expect(await serverSales()).toBe(before + 2);
  for (const k of evidence.offlineKeys as string[]) {
    expect(sqlOne(`SELECT count(*) FROM public.idempotency_keys WHERE key='${k}' AND org_id='${ORG()}';`)).toBe("1");
  }
  expect(sqlOne(`SELECT recovery_v1.device_enrollment_state('${T1.enrollmentId}');`)).toBe("ACTIVE");
  note("S14", { synced: 2, enrollment: "ACTIVE after restart", integrity: sqlOne("SELECT coalesce(recovery_v1.integrity_problem(),'none');") });
});

test("S11 aggregate budget: three trusted tills of one shop cannot together exceed the shop's preallocated 30,000", async () => {
  let t = T!;
  await t.posAddByCard(P1); await t.posCheckout(5000);                     // till 1 refreshes its authority (surrenders the exhausted one)
  await expect.poll(() => sqlOne(`SELECT count(*) FROM recovery_v1.offline_surrenders s JOIN recovery_v1.offline_capabilities c ON c.id = s.capability_id WHERE c.enrollment_id='${T1.enrollmentId}';`), { timeout: 60_000 }).not.toBe("0");
  t = await launch("s5-t2"); await ensureShift(t);
  await t.posAddByCard(P1); await t.posCheckout(5000);
  await expect.poll(() => capsOf(T2.enrollmentId), { timeout: 60_000 }).toMatch(/10000/);
  await t.close(); T = null;
  const req = pendingRequests(ORG()).find((r) => r.deviceId === T3.deviceId)!;
  T3.enrollmentId = String(approveDevice(owner, ORG(), req).enrollmentId);
  t = await launch("s5-t3"); await phase(t, "trusted"); await ensureShift(t);
  await t.posAddByCard(P1); await t.posCheckout(5000);
  await new Promise((r) => setTimeout(r, 5_000));
  const refusedCap = sqlOne(`SELECT count(*) FROM recovery_v1.offline_capabilities WHERE enrollment_id='${T3.enrollmentId}';`);
  const outstanding = sqlOne(`SELECT coalesce(sum(max_amount_mmk),0) FROM recovery_v1.offline_capabilities c WHERE c.org_id='${ORG()}' AND c.shop_id='${st.ids.shop}' AND c.sync_deadline > now()
     AND c.offline_epoch=(SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='${ORG()}') AND NOT EXISTS (SELECT 1 FROM recovery_v1.offline_surrenders s WHERE s.capability_id=c.id);`);
  expect(refusedCap).toBe("0"); expect(Number(outstanding)).toBeLessThanOrEqual(30000);
  note("S11", { t1: capsOf(T1.enrollmentId), t2: capsOf(T2.enrollmentId), t3: refusedCap, shopOutstanding: outstanding,
    audit: sqlOne(`SELECT count(*) FROM recovery_v1.audit WHERE org_id='${ORG()}' AND kind='offline_capability_issued';`) });
});

test("S10 a revoked device cannot obtain new authority: sale refused, no new capability, the till shows it was revoked", async () => {
  const t = T!;
  const r = operator(`recovery_v1.operator_contain_device('${ORG()}', '${T3.enrollmentId}', 'revoke', 'synthetic: till reported stolen', 'e2e-control-operator')`) as any;
  expect(r.outcome).toBe("revoked");
  await phase(t, "revoked");
  const before = await serverSales();
  await t.posAddByCard(P1);
  const toast = await checkoutRefused(t);
  expect(await serverSales()).toBe(before);
  const caps = sqlOne(`SELECT count(*) FROM recovery_v1.offline_capabilities WHERE enrollment_id='${T3.enrollmentId}';`);
  expect(caps).toBe("0");
  await expect(t.page.getByTestId("device-trust-reenroll")).toBeVisible();
  note("S10", { toast: toast.slice(0, 160), caps });
  await t.close(); T = null;
});

test("S15 organization restricted while a till was disconnected: its offline sale is never accepted by the server after reconnect, and never deleted", async () => {
  let t = await launch("s5-t2");
  await t.setOffline(true);
  await t.posAddByCard(P1);
  const r = await t.posCheckout(5000);
  expect(r.receiptNo).toBe("PENDING");
  const key = (await t.outbox()).filter((e: any) => e.name === "complete_sale")[0].idempotencyKey;
  await t.close(); T = null;
  operator(`recovery_v1.operator_transition('${ORG()}', 'RESTRICTED', 'synthetic incident while a till was offline', 'e2e-s15', 'e2e-control-operator')`);
  const rep = reconcile(ORG());
  const re = reopen(owner, ORG(), rep, rep.blockers.length ? "limited" : "verified",
    rep.blockers.length ? ["SYNTHETIC: tills that were offline during the incident may hold operations the server has not seen"] : []);
  expect(re.outcome).toBe("reopened");
  t = await launch("s5-t2");
  // the server refuses it (older offline epoch); the till HOLDS it (kept pending with a hold reason), never deletes or resends it blindly
  await expect.poll(async () => { const row: any = (await t.outbox()).find((e: any) => e.idempotencyKey === key); return row ? `${row.heldReason ?? ""}|${row.lastError ?? ""}` : "gone"; },
    { timeout: 180_000 }).toMatch(/offline_capability_stale_epoch/);
  const row: any = (await t.outbox()).find((e: any) => e.idempotencyKey === key);
  expect(row).toBeTruthy();                                                  // never deleted
  expect(row.heldReason).toBeTruthy();
  expect(sqlOne(`SELECT count(*) FROM public.idempotency_keys WHERE key='${key}';`)).toBe("0");
  note("S15", { key, status: row?.status, heldReason: row?.heldReason, lastError: String(row?.lastError ?? "").slice(0, 200), reopen: re.decision, blockers: rep.blockers });
});

test("S17 an old client (no device signature) cannot bypass V1, even with a valid cashier session on the ACTIVE organization", async () => {
  const c = await userClient(st.emails.cashA, pw);
  const shift = sqlOne(`SELECT id FROM public.shifts WHERE shop_id='${st.ids.shop}' AND cashier_id='${st.ids.cashA}' AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1;`);
  const before = await serverSales();
  const { error } = await c.rpc("complete_sale", { p_shop_id: st.ids.shop, p_shift_id: shift, p_payment_method: "CASH", p_paid_mmk: 1000, p_cart_discount_pct: 0,
    p_items: [{ product_id: st.ids.prod1, qty: 1 }], p_created_at: null, p_idempotency_key: crypto.randomUUID() });
  expect(String(error?.message)).toMatch(/device_signature_required/);
  expect(await serverSales()).toBe(before);
  note("S17", { error: String(error?.message).slice(0, 160) });
});

test("S18 (final) reopening the QA organization never reopened any other organization", async () => {
  const others = otherOrgsRestricted();
  expect(others.split("/")[0]).toBe(others.split("/")[1]); expect(Number(others.split("/")[1])).toBeGreaterThan(0);
  note("S18", { otherOrgsRestricted: others, qa: sqlOne(`SELECT state FROM recovery_v1.org_state WHERE org_id='${ORG()}';`) });
});
