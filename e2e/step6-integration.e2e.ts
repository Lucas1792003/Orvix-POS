/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 6 — REAL POS <-> Control integration (tools/recovery-v1/step6/run-integration.sh). Three separately running systems:
//   * the POS: disposable loopback stack (PostgreSQL + PostgREST + edge runtime, phf-iso-*) with Recovery V1 + Step 5,
//     and the real Electron till;
//   * Orvix Control: its own container and database (schema 223), `next start` on localhost:3410, driven in Chromium
//     with a virtual passkey authenticator — every recovery action goes through Control's pages, API and step-up;
//   * the network bridge between them: Control's database -> dblink over phf-iso-net -> the POS login
//     orvix_control_bridge (member of orvix_recovery_operator only) -> recovery_v1.operator_*.
// No mock, no SET ROLE shortcut: the operator never touches the POS database. The owner is a SYNTHETIC signer on the host
// (not an independent production authority). Direct SQL below is EVIDENCE ONLY (reading persisted records).
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Terminal } from "./helpers/terminal";
import { PROJECT_ROOT } from "./helpers/env";
import { P1, profile, serverSales, st, pw } from "./m086-helpers";
import { FIXTURE_OWNER, sqlOne, SyntheticOwner } from "./helpers/step5Owner";
import { ControlConsole } from "./helpers/controlConsole";

test.describe.configure({ mode: "serial" });
test.skip(process.env.STEP6_LIVE !== "1", "Step 6 integration: run via tools/recovery-v1/step6/run-integration.sh");
if (process.env.STEP6_LIVE === "1" && (process.env.E2E_LOOPBACK_ONLY !== "1" || !process.env.E2E_DB_CONTAINER || !process.env.ORVIX_CONTROL_WT)) {
  throw new Error("STEP6_LIVE needs E2E_LOOPBACK_ONLY=1, E2E_DB_CONTAINER and ORVIX_CONTROL_WT");
}
const OUT = process.env.STEP6_OUT ?? path.join(PROJECT_ROOT, "tools/recovery-v1/step6/results/adhoc");
const TOOLS = path.join(PROJECT_ROOT, "tools/recovery-v1/step6");
const evidence: Record<string, unknown> = {};
const note = (id: string, v: unknown) => { evidence[id] = v; console.log(`[step6] ${id} ${JSON.stringify(v)}`); };
const ctl = (...args: string[]) => execFileSync("bash", [path.join(TOOLS, "control-stack.sh"), ...args], { encoding: "utf8" }).trim();
const ctlSql = (q: string) => ctl("sql", q).split("\n").filter(Boolean).pop() ?? "";
const ORG = () => st.ids.org;
const OTHER = () => `s6-other-${st.ts}`;

let owner: SyntheticOwner;
let signingTarget: Record<string, unknown> | null = null;
let T: Terminal | null = null;
let C: ControlConsole;          // the Control owner, in Chromium
let A: ControlConsole | null;   // the Control admin
const tills: Record<string, { deviceId: string; enrollmentId: string }> = {};

test.afterAll(async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "e2e-evidence.json"), JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2));
  await T?.close().catch(() => undefined);
  await C?.close(); await A?.close();
});

// ---------------------------------------------------------------- till helpers (as Step 5)
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
const posState = (org = ORG()) => sqlOne(`SELECT state || '/' || coalesce(recovery_v1.activation_problem('${org}'), 'verified') FROM recovery_v1.org_state WHERE org_id='${org}';`);
const otherOrgsRestricted = () => sqlOne(`SELECT count(*) FILTER (WHERE state <> 'ACTIVE') || '/' || count(*) FROM recovery_v1.org_state WHERE org_id <> '${ORG()}';`);
const lastControlRequest = (action: string) => ctlSql(`SELECT request_id FROM control.audit_events WHERE action = '${action}' AND outcome = 'success' ORDER BY seq DESC LIMIT 1`);
const posAuditByRequest = (rid: string) => sqlOne(`SELECT coalesce(string_agg(kind, ',' ORDER BY id), '') FROM recovery_v1.audit WHERE detail::text LIKE '%${rid}%' OR actor LIKE '%${rid}%';`);

/** The till asks to be enrolled; the owner reads the request THROUGH CONTROL, compares the short code, signs offline; Control carries it. */
async function enrollThroughControl(t: Terminal, label: string): Promise<{ deviceId: string; enrollmentId: string; rid: string }> {
  await phase(t, "none");
  await t.page.getByTestId("device-trust-request").click();
  await phase(t, "pending");
  const code = (await t.page.getByTestId("device-trust-code").innerText()).replace(/-/g, "");
  const deviceId = await tillDeviceId(t);
  await C.openOrg(ORG());
  await expect(C.page.getByText(code, { exact: true })).toBeVisible();          // the code the owner compares with the till
  const detail = (await C.api(`/api/pos-recovery/orgs/${ORG()}`)).body.organization;
  const req = (detail.deviceRequests as any[]).find((r) => r.deviceId === deviceId);
  expect(req.shortCode).toBe(code);
  const a = owner.authorize("enroll-device", { scope: ORG(), ownerId: FIXTURE_OWNER, device: {
    requestId: req.requestId, orgId: ORG(), shopId: req.shopId, deviceId, keyFingerprint: req.keyFingerprint, requestNonce: req.requestNonce,
    notAfter: new Date(Date.now() + 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z"), replacesEnrollmentId: req.replaces ?? null } });
  const r = await C.submitAuthorization(a);
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  expect(r.text).toMatch(/enrolled/);
  await t.page.getByTestId("device-trust-check").click({ timeout: 3_000 }).catch(() => undefined);
  await phase(t, "trusted");
  const enrollmentId = sqlOne(`SELECT enrollment_id FROM recovery_v1.device_enrollments WHERE org_id='${ORG()}' AND device_id='${deviceId}';`);
  const rid = lastControlRequest("pos.recovery_submitted");
  note(`${label}.enrolled`, { deviceId, code, enrollmentId, controlRequest: rid, posAudit: posAuditByRequest(rid) });
  return { deviceId, enrollmentId, rid, ...{ authorization: a } } as any;
}

// =====================================================================================================================
test("I01 setup: Recovery V1 installed (every organization RESTRICTED); the POS owner creates the bridge login; Control (own database, schema 223) shows BLOCKED until the bridge is configured", async () => {
  sqlOne(`INSERT INTO public.organizations (id, name) VALUES ('${OTHER()}', 'Step 6 other synthetic organization') ON CONFLICT DO NOTHING; SELECT 1;`);
  // the shop is trading before the incident: the cashier's shift is open (V1 refuses opening one while RESTRICTED)
  const t0 = await launch("s6-t1", { fresh: true });
  await ensureShift(t0);
  await t0.close(); T = null;
  const out = execFileSync("bash", [path.join(PROJECT_ROOT, "tools/recovery-v1/step5/install-v1-stack.sh"), OUT, ORG()], { encoding: "utf8" });
  const info = JSON.parse(out.trim().split("\n").pop()!);
  expect(info.integrity).toBe("none"); expect(info.qaState).toBe("RESTRICTED");
  owner = new SyntheticOwner(info.keydir, info.keyId, path.join(OUT, "owner-work"));
  process.env.ORVIX_POS_E2E_OWNER_TRUST = JSON.stringify([info.ownerFingerprint]);
  const installedAt = Date.now();

  // the POS owner's deployment step: the login Control will use (member of orvix_recovery_operator only)
  const role = JSON.parse(execFileSync("bash", [path.join(TOOLS, "control-bridge-role.sh"), OUT], { encoding: "utf8" }).trim().split("\n").pop()!);
  expect(role).toEqual({ user: "orvix_control_bridge", integrity: "none", memberships: ["orvix_recovery_operator"] });
  // what that login can reach, measured AS that login over TCP
  const probe = execFileSync("bash", ["-c", `{ sed -n 's/^ORVIX_POS_BRIDGE_PASSWORD=//p' "${OUT}/bridge.env"; cat "${TOOLS}/bridge-probe.sql"; } | docker exec -i phf-iso-db bash -c 'read -r PGPASSWORD; export PGPASSWORD; psql -X -h 127.0.0.1 -U orvix_control_bridge -d postgres -f - 2>&1'`], { encoding: "utf8" });
  writeFileSync(path.join(OUT, "bridge-probe.txt"), probe);
  const p = JSON.parse(probe.split("\n").find((l) => l.startsWith("{"))!);
  expect(p.attributes).toEqual({ super: false, createrole: false, createdb: false, replication: false, bypassrls: false, inherit: true });
  expect(p.memberOf).toEqual(["orvix_recovery_operator"]);
  // nothing in a POS business, auth, storage or recovery schema; the only reachable tables are extension tables the Supabase
  // image grants to PUBLIC (exactly what anon already has), recorded for the report
  const BUSINESS = /^(public|recovery_v1|recovery|recovery_guard|auth|storage|supabase_migrations|realtime|vault|graphql|graphql_public|pgsodium)\./;
  expect((p.tablePrivileges as any[]).filter((t) => BUSINESS.test(t.rel))).toEqual([]);
  for (const t of p.tablePrivileges as any[]) expect(t.sameAsAnon, t.rel).toBe(true);
  // effective reachability = table privilege AND schema usage; and what those tables actually show this login
  const effective = (p.tablePrivileges as any[]).filter((t) => t.schemaUsage).map((t) => t.rel);
  const visible = Object.fromEntries(probe.split("\n").filter((l) => l.startsWith("visible ")).map((l) => { const w = l.split(" "); return [w.slice(1, -1).join(" "), Number(w.at(-1))]; }));
  // a missing entry = permission denied on the schema = unreachable; a reachable one must show this login nothing
  for (const [k, n] of Object.entries(visible)) expect(n, k).toBe(0);
  const unreachable = ["extensions.pg_stat_statements other_users_query_text", "cron.job", "cron.job_run_details", "net._http_response", "net.http_request_queue"]
    .filter((k) => !(k in visible));
  expect(p.publicDefinerBridgeOnly).toEqual([]);                                 // nothing beyond what anon can already call
  // Step 6 finalization (PNET-A): the database's outgoing-HTTP facility is out of reach — no net.* table privilege, no schema
  // usage (both queue and responses unreachable) and no EXECUTE on net.http_post
  expect((p.tablePrivileges as any[]).filter((t) => t.rel.startsWith("net."))).toEqual([]);
  expect(unreachable).toEqual(expect.arrayContaining(["net._http_response", "net.http_request_queue"]));
  expect(probe).toContain("exec net.http_post false");
  // ... and the new financial RPCs and tables (PFIN-F / PDISC-A) are out of its reach too
  expect(probe).toContain("exec fin_rpcs false");
  expect(probe).toContain("read fin_tables false");
  for (const t of ["table sales", "table sale_items", "table products", "table org_state", "schema auth"]) expect(probe).toContain(`permission denied for ${t}`);
  expect(probe).not.toMatch(/ERROR: {2}(?!permission denied|relation .* does not exist)/);
  note("I01.bridge", { role, probe: { ...p, deniedReads: 5, effective, visible, unreachable } });

  // Control: the first owner (host bootstrap -> passkey in the browser -> sign in), BEFORE the bridge exists
  ctl("notices");                                                   // the owners' out-of-band channel (delivered by the real sentinel)
  C = await ControlConsole.open("owner");
  const token = ctl("owner", "owner@example.invalid", "Step6 Owner");
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  await C.enroll(token);
  await C.login();
  await C.page.goto("/pos-recovery");
  expect(await C.blockedBanner()).toMatch(/BLOCKED: POS recovery interface unavailable/);
  expect((await C.api("/api/pos-recovery")).status).toBe(503);
  expect(ctlSql("SELECT detail->>'bridge' FROM control.audit_events WHERE action = 'pos.recovery_read_refused' ORDER BY seq DESC LIMIT 1")).toBe("not_configured");
  note("I01.control", { contract: ctlSql("SELECT control.api_contract_version()"), blocked: "not_configured", passkeys: await C.credentials() });
  const wait = 65_000 - (Date.now() - installedAt);                                 // past the till's 60 s "no Recovery V1 here" cache
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
});

test("I02 the host configures the bridge: Control lists every POS organization over the network, all RESTRICTED, with the owner authority; nothing is left open on the POS", async () => {
  ctl("bridge", path.join(OUT, "bridge.env"));
  await C.page.goto("/pos-recovery");
  expect(await C.blockedBanner()).toBeNull();
  const o = (await C.api("/api/pos-recovery")).body;
  const ids = (o.organizations as any[]).map((x) => x.orgId);
  expect(ids).toEqual(expect.arrayContaining([ORG(), OTHER()]));
  for (const x of o.organizations) expect(x.state).toBe("RESTRICTED");
  const qa = o.organizations.find((x: any) => x.orgId === ORG());
  expect(qa.ownerAuthority.map((k: any) => k.keyId)).toEqual(["owner-e2e-1"]);
  await expect(C.page.locator("tr", { hasText: ORG() }).getByText("RESTRICTED")).toBeVisible();
  // the POS saw a separate login over TCP, and nothing stays connected between calls
  await new Promise((r) => setTimeout(r, 500));
  expect(sqlOne("SELECT count(*) FROM pg_stat_activity WHERE usename = 'orvix_control_bridge';")).toBe("0");
  expect(sqlOne("SELECT coalesce(recovery_v1.integrity_problem(),'none');")).toBe("none");
  note("I02", { organizations: ids.length, states: o.organizations.map((x: any) => `${x.orgId}:${x.state}`) });
});

test("I03 enrollment through Control: a RESTRICTED org's untrusted till refuses a sale; it requests enrollment; Control shows the same short code; the owner's offline signature, carried by Control with a passkey step-up, makes the till trusted", async () => {
  const t = await launch("s6-t1");
  await t.gotoPos();
  const before = await serverSales(); const queued = (await t.outbox()).length;
  await t.posAddByCard(P1);
  const toast = await checkoutRefused(t);
  expect(await serverSales()).toBe(before); expect((await t.outbox()).length).toBe(queued);
  const e: any = await enrollThroughControl(t, "T1");
  tills.T1 = e; evidence.T1auth = e.authorization;
  expect(sqlOne(`SELECT recovery_v1.device_enrollment_state('${e.enrollmentId}');`)).toBe("ACTIVE");
  // both audit trails name the same Control request; the POS records the bridge login that carried it
  expect(e.rid).toMatch(/^[0-9a-f-]{36}$/);
  const actor = sqlOne(`SELECT submitted_by FROM recovery_v1.device_enrollments WHERE enrollment_id = '${e.enrollmentId}';`);
  expect(sqlOne(`SELECT used_by FROM recovery_v1.owner_authorizations_used WHERE purpose = 'enroll-device' ORDER BY used_at DESC LIMIT 1;`)).toBe("orvix_control_bridge");
  expect(actor).toMatch(new RegExp(`^operator:control:owner:[0-9a-f-]{36}:${e.rid}@orvix_control_bridge$`));
  await C.openOrg(ORG());
  await expect(C.deviceRow(e.deviceId).getByText("ACTIVE")).toBeVisible();
  note("I03", { refusedToast: toast.slice(0, 120), posActor: actor });
});

test("I04 invalid approvals through Control are refused by the POS verifier and audited on both sides (attacker key, other shop, replay, other organization); an admin can never carry a reopening", async () => {
  const t = T!;
  // a second till asks, so that there is an OPEN request to forge approvals for
  await t.close(); T = null;
  const t2 = await launch("s6-t2", { fresh: true });
  await t2.gotoPos(); await t2.posAddByCard(P1); await checkoutRefused(t2);
  await t2.page.getByTestId("device-trust-request").click(); await phase(t2, "pending");
  const deviceId = await tillDeviceId(t2);
  const req = ((await C.api(`/api/pos-recovery/orgs/${ORG()}`)).body.organization.deviceRequests as any[]).find((r) => r.deviceId === deviceId);
  const dev = (over: Record<string, unknown> = {}) => ({ requestId: req.requestId, orgId: ORG(), shopId: req.shopId, deviceId, keyFingerprint: req.keyFingerprint,
    requestNonce: req.requestNonce, notAfter: new Date(Date.now() + 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z"), replacesEnrollmentId: null, ...over });
  owner.keygen("attacker-e2e");
  const before = Number(ctlSql("SELECT count(*) FROM control.audit_events WHERE action = 'pos.recovery_submit_refused' AND reason_code = 'POS_RECOVERY_REFUSED'"));
  const results: Record<string, string> = {};
  for (const [name, a] of [
    ["attacker-key", owner.authorize("enroll-device", { scope: ORG(), ownerId: FIXTURE_OWNER, device: dev() }, { keyId: "attacker-e2e" })],
    ["other-shop", owner.authorize("enroll-device", { scope: ORG(), ownerId: FIXTURE_OWNER, device: dev({ shopId: st.ids.shop2 }) })],
    ["replay-of-T1", evidence.T1auth as { authorization: string; signature: string }],
    ["other-organization", owner.authorize("enroll-device", { scope: OTHER(), ownerId: FIXTURE_OWNER, device: dev({ orgId: OTHER() }) })],
  ] as const) {
    await C.openOrg(ORG());
    const r = await C.submitAuthorization(a);
    expect(r.ok, name).toBe(false);
    results[name] = r.text.slice(0, 120);
  }
  expect(Number(ctlSql("SELECT count(*) FROM control.audit_events WHERE action = 'pos.recovery_submit_refused' AND reason_code = 'POS_RECOVERY_REFUSED'"))).toBe(before + 4);
  expect(sqlOne(`SELECT count(*) FROM recovery_v1.device_enrollments WHERE device_id='${deviceId}';`)).toBe("0");
  await phase(t2, "pending", 15_000);
  tills.T2pending = { deviceId, enrollmentId: "" };

  // an admin, invited by the owner through the Security page (step-up), enrolled with its own passkey, approved by the host
  await C.page.goto("/security");
  await C.page.getByLabel("Email", { exact: true }).fill("admin@example.invalid");
  await C.page.getByLabel("Name", { exact: true }).fill("Step6 Admin");
  await C.page.locator("label", { hasText: /^Role/ }).locator("select").selectOption("admin");
  await C.page.getByRole("button", { name: "Invite 🔑" }).click();
  const link = await C.page.getByText(/\/enroll\/[0-9a-f]{64}/).first().innerText({ timeout: 30_000 });
  A = await ControlConsole.open("admin");
  const fp = await A.enroll(link.match(/[0-9a-f]{64}/)![0]);
  expect(fp).toBeTruthy();
  // the enrolment notice must reach the owners out of band (the real sentinel, file channel) before the host may approve
  let approved = ""; const passes: string[] = [];
  for (let i = 0; i < 4; i++) {
    passes.push(ctl("deliver").split("\n").pop() ?? "");
    approved = ctlSql(`SELECT control.host_approve_operator('admin@example.invalid', '${fp}')::text`);
    if (JSON.parse(approved).ok) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const deliveries = ctlSql(`SELECT coalesce(string_agg(o.action || ':' || c.target || ':' || coalesce(d.delivered_at::text, 'pending') || ':' || coalesce(d.last_error, '-'), ' | '), '') FROM control.notify_outbox o JOIN control.notify_deliveries d ON d.outbox_id = o.id JOIN control.notify_channels c ON c.id = d.channel_id`);
  expect(JSON.parse(approved), `${approved} sentinel=${passes.join(" / ")} deliveries=${deliveries}`).toMatchObject({ ok: true });
  note("I04.notices", { passes, notices: ctl("notices-log").split("\n").filter(Boolean).length });
  await A.login();
  await A.openOrg(ORG());
  const reopenText = JSON.stringify({ protocol: "orvix-owner-authorization-v1", purpose: "reopen-organization", scope: ORG(), keyId: "owner-e2e-1", nonce: crypto.randomUUID() });
  await A.page.getByLabel("Authorization (exact text)").fill(reopenText);
  await A.page.getByLabel("Signature (hex)").fill("abcd");
  await expect(A.page.getByText("Only an owner may carry a reopening.")).toBeVisible();
  expect(await A.submitButtonEnabled()).toBe(false);
  const forced = await A.api("/api/pos-recovery/submit", { authorization: reopenText, signature: "abcd", requestId: crypto.randomUUID() });
  expect([forced.status, forced.body.error]).toEqual([403, "FORBIDDEN"]);
  note("I04", { refused: results, adminReopen: forced.body.error });
});

test("I05 RESTRICTED + trusted till: the sale is refused; the trusted till reports a signed attestation for the incident", async () => {
  const t = await launch("s6-t1");
  await ensureShift(t);
  const before = await serverSales();
  await t.posAddByCard(P1);
  const toast = await checkoutRefused(t);
  expect(await serverSales()).toBe(before);
  await expect.poll(() => sqlOne(`SELECT count(*) FROM recovery_v1.device_attestations WHERE enrollment_id='${tills.T1.enrollmentId}';`), { timeout: 90_000 }).not.toBe("0");
  note("I05", { toast: toast.slice(0, 120) });
});

test("I06 reconciliation and reopening through Control: RECONCILING (step-up), report recorded by Control, the owner signs over Control's digest and signing target, Control carries it, the POS verifies -> ACTIVE; no other organization reopened", async () => {
  await C.openOrg(ORG());
  expect(await C.transition("RECONCILING", "Step 6 synthetic incident review", "INC-S6-001")).toBeNull();
  await expect(C.orgState(ORG())).toHaveText("RECONCILING");
  const rep = (await C.api(`/api/pos-recovery/orgs/${ORG()}/report`, { requestId: crypto.randomUUID() })).body;
  expect(rep).toMatchObject({ ok: true, outcome: "reported" });
  // Control's signing target is the POS database's own binding
  const posTarget = JSON.parse(sqlOne("SELECT recovery_v1.authorization_target()::text;"));
  expect(rep.signingTarget).toEqual({ database: posTarget.database, systemIdentifier: posTarget.systemIdentifier, recoveryV1InstalledAt: posTarget.recoveryV1InstalledAt });
  signingTarget = rep.signingTarget;
  await C.openOrg(ORG());
  await expect(C.page.getByText(rep.digest, { exact: true }).first()).toBeVisible();
  // the second till is pending (not enrolled), so it is not an attestation blocker; the trusted till attested in I05
  expect(rep.blockers).toEqual([]);
  const a = owner.authorize("reopen-organization", { scope: ORG(), ownerId: FIXTURE_OWNER, reopen: {
    orgId: ORG(), incidentId: rep.incidentId, recoveryEpoch: rep.recoveryEpoch, fromState: "RECONCILING", toState: "ACTIVE", reportDigest: rep.digest,
    decision: "verified", acceptedBlockers: [], uncertainties: [], witnessRequired: false, checkpointHashes: [], backupManifestSha256: null, recoveredAsOf: null } },
    { target: signingTarget! });
  const r = await C.submitAuthorization(a);
  expect(r, r.text).toMatchObject({ ok: true });
  expect(r.text).toMatch(/reopened/);
  expect(posState()).toBe("ACTIVE/verified");
  await C.openOrg(ORG());
  await expect(C.orgState(ORG())).toHaveText("ACTIVE");
  const others = otherOrgsRestricted();
  expect(others.split("/")[0]).toBe(others.split("/")[1]); expect(Number(others.split("/")[1])).toBeGreaterThan(0);
  const rid = lastControlRequest("pos.recovery_submitted");
  note("I06", { digest: rep.digest, controlRequest: rid, posReopenings: sqlOne(`SELECT count(*) FROM recovery_v1.reopenings WHERE org_id='${ORG()}';`), others });
});

test("I07 ACTIVE + trusted: an online sale succeeds and the server recorded the device's signature for it", async () => {
  const t = T!;
  await ensureShift(t);
  const before = await serverSales();
  await t.posAddByCard(P1);
  const r = await t.posCheckout(5000);
  expect(r.receiptNo).not.toBe("PENDING");
  expect(await serverSales()).toBe(before + 1);
  const signed = sqlOne(`SELECT count(*) FROM recovery_v1.device_counters c JOIN public.idempotency_keys k ON k.key = c.op_key WHERE c.enrollment_id='${tills.T1.enrollmentId}' AND k.rpc='complete_sale' AND k.org_id='${ORG()}';`);
  expect(Number(signed)).toBeGreaterThan(0);
  await expect.poll(() => capsOf(tills.T1.enrollmentId), { timeout: 60_000 }).toMatch(/20000/);
  note("I07", { receipt: r.receiptNo, signedOps: signed });
});

test("I08 Control DOWN: the POS does not depend on it — online sale, offline sale, reconnect and sync all work; recovery state unchanged; Control comes back with the same state", async () => {
  ctl("stop");
  const t = T!;
  const st0 = posState(); const before = await serverSales();
  await t.posAddByCard(P1);
  expect((await t.posCheckout(5000)).receiptNo).not.toBe("PENDING");
  await t.setOffline(true);
  await t.posAddByCard(P1);
  expect((await t.posCheckout(5000)).receiptNo).toBe("PENDING");
  await t.setOffline(false);
  await expect.poll(async () => (await t.outbox()).filter((e: any) => e.name === "complete_sale").length, { timeout: 90_000 }).toBe(0);
  expect(await serverSales()).toBe(before + 2);
  expect(posState()).toBe(st0);
  ctl("start");
  await C.openOrg(ORG());
  await expect(C.orgState(ORG())).toHaveText("ACTIVE");
  note("I08", { salesWhileControlDown: 2, state: st0 });
});

test("I09 POS unreachable from Control (network partition, then a frozen POS database): Control says BLOCKED, refuses containment WITHOUT using the passkey step-up, audits it; nothing changes on the POS; it recovers by itself", async () => {
  ctl("partition");
  try {
    await C.openOrg(ORG());
    expect(await C.blockedBanner()).toBeTruthy();
    const t0 = Date.now();
    const r = await C.api(`/api/pos-recovery/orgs/${ORG()}/transition`, { to: "RESTRICTED", reason: "partition test (synthetic)", evidenceReference: "INC-S6-NET", requestId: crypto.randomUUID() });
    expect([r.status, r.body.error]).toEqual([503, "POS_RECOVERY_UNAVAILABLE"]);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(ctlSql("SELECT detail->>'bridge' FROM control.audit_events WHERE action = 'pos.recovery_transition_refused' ORDER BY seq DESC LIMIT 1")).toBe("unreachable");
  } finally { ctl("heal"); }
  expect(posState()).toBe("ACTIVE/verified");
  await C.openOrg(ORG());
  expect(await C.blockedBanner()).toBeNull();
  execFileSync("docker", ["pause", "phf-iso-db"]);
  let frozen: { status: number; body: any };
  const t1 = Date.now();
  try { frozen = await C.api("/api/pos-recovery"); } finally { execFileSync("docker", ["unpause", "phf-iso-db"]); }
  expect([frozen.status, frozen.body.error]).toEqual([503, "POS_RECOVERY_UNAVAILABLE"]);
  const frozenMs = Date.now() - t1;
  await expect.poll(async () => (await C.api("/api/pos-recovery")).status, { timeout: 30_000 }).toBe(200);
  expect(posState()).toBe("ACTIVE/verified");
  note("I09", { partition: "POS_RECOVERY_UNAVAILABLE (unreachable)", frozenDbMs: frozenMs });
});

test("I10 device suspension through Control, then the owner's reinstatement naming the suspension event Control shows", async () => {
  await C.openOrg(ORG());
  expect(await C.containDevice(tills.T1.deviceId, "suspend", "Step 6: till left unattended (synthetic)")).toBeNull();
  await expect(C.deviceRow(tills.T1.deviceId).getByText("SUSPENDED")).toBeVisible();
  const ev = Number((await C.deviceRow(tills.T1.deviceId).getByTestId("suspension-event").innerText()).replace(/\D/g, ""));
  expect(ev).toBeGreaterThan(0);
  const t = T!;
  await phase(t, "suspended");
  const before = await serverSales();
  await t.posAddByCard(P1);
  await checkoutRefused(t);
  expect(await serverSales()).toBe(before);
  const fp = sqlOne(`SELECT key_fingerprint FROM recovery_v1.device_enrollments WHERE enrollment_id='${tills.T1.enrollmentId}';`);
  const shownFp = ((await C.api(`/api/pos-recovery/orgs/${ORG()}`)).body.organization.devices.enrollments as any[]).find((x) => x.enrollmentId === tills.T1.enrollmentId).keyFingerprint;
  expect(shownFp).toBe(fp);
  const a = owner.authorize("device-reinstate", { scope: ORG(), ownerId: FIXTURE_OWNER, device: { enrollmentId: tills.T1.enrollmentId, keyFingerprint: shownFp, suspensionEventId: ev } });
  const r = await C.submitAuthorization(a);
  expect(r, r.text).toMatchObject({ ok: true });
  expect(r.text).toMatch(/reinstated/);
  await phase(t, "trusted");
  await ensureShift(t);
  await t.posAddByCard(P1);
  expect((await t.posCheckout(5000)).receiptNo).not.toBe("PENDING");
  note("I10", { suspensionEventId: ev, reinstated: true });
});

test("I11 an incident while a till is offline, then reconnection: Control restricts and reconciles (report from the UI), the owner accepts the open blockers in a LIMITED reopening carried by Control; the till's pre-incident offline sale is held (stale epoch), never accepted, never deleted", async () => {
  let t = T!;
  await t.setOffline(true);
  await t.posAddByCard(P1);
  const r = await t.posCheckout(5000);
  expect(r.receiptNo).toBe("PENDING");
  const key = (await t.outbox()).filter((e: any) => e.name === "complete_sale")[0].idempotencyKey;
  await t.close(); T = null;
  await C.openOrg(ORG());
  expect(await C.transition("RESTRICTED", "Step 6: incident while a till was offline", "INC-S6-002")).toBeNull();
  expect(await C.transition("RECONCILING", "Step 6: reconcile the offline incident", "INC-S6-002")).toBeNull();
  await C.recordReport();
  const o = (await C.api(`/api/pos-recovery/orgs/${ORG()}`)).body.organization;
  const blockers = o.lastReport.blockers as string[];
  expect(o.lastReport.hardBlockers).toEqual([]);
  for (const b of blockers) await expect(C.page.getByText(b, { exact: false }).first()).toBeVisible();
  const decision = blockers.length ? "limited" : "verified";
  const a = owner.authorize("reopen-organization", { scope: ORG(), ownerId: FIXTURE_OWNER, reopen: {
    orgId: ORG(), incidentId: o.incidentId, recoveryEpoch: o.recoveryEpoch, fromState: "RECONCILING", toState: "ACTIVE", reportDigest: o.lastReport.digest,
    decision, acceptedBlockers: decision === "limited" ? blockers : [],
    uncertainties: decision === "limited" ? ["SYNTHETIC: tills that were offline during the incident may hold operations the server has not seen"] : [],
    witnessRequired: false, checkpointHashes: [], backupManifestSha256: null, recoveredAsOf: null } }, { target: signingTarget! });
  const res = await C.submitAuthorization(a);
  expect(res, res.text).toMatchObject({ ok: true });
  expect(posState().split("/")[0]).toBe("ACTIVE");
  t = await launch("s6-t1");
  await expect.poll(async () => { const row: any = (await t.outbox()).find((e: any) => e.idempotencyKey === key); return row ? `${row.heldReason ?? ""}|${row.lastError ?? ""}` : "gone"; },
    { timeout: 180_000 }).toMatch(/offline_capability_stale_epoch/);
  const row: any = (await t.outbox()).find((e: any) => e.idempotencyKey === key);
  expect(row).toBeTruthy(); expect(row.heldReason).toBeTruthy();
  expect(sqlOne(`SELECT count(*) FROM public.idempotency_keys WHERE key='${key}';`)).toBe("0");
  note("I11", { key, decision, blockers, heldReason: row.heldReason });
});

test("I12 a second till enrolled through Control, then REVOKED through Control: refused, no offline authority, the till shows it was revoked", async () => {
  if (T) { await T.close(); T = null; }
  const t = await launch("s6-t2");
  // its earlier request (I04) is still open: the owner approves THAT one now
  await phase(t, "pending", 30_000);
  const req = ((await C.api(`/api/pos-recovery/orgs/${ORG()}`)).body.organization.deviceRequests as any[]).find((r) => r.deviceId === tills.T2pending.deviceId);
  const a = owner.authorize("enroll-device", { scope: ORG(), ownerId: FIXTURE_OWNER, device: {
    requestId: req.requestId, orgId: ORG(), shopId: req.shopId, deviceId: req.deviceId, keyFingerprint: req.keyFingerprint, requestNonce: req.requestNonce,
    notAfter: new Date(Date.now() + 30 * 86400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z"), replacesEnrollmentId: null } });
  await C.openOrg(ORG());
  expect((await C.submitAuthorization(a)).ok).toBe(true);
  await t.page.getByTestId("device-trust-check").click({ timeout: 3_000 }).catch(() => undefined);
  await phase(t, "trusted");
  const enrollmentId = sqlOne(`SELECT enrollment_id FROM recovery_v1.device_enrollments WHERE device_id='${req.deviceId}';`);
  tills.T2 = { deviceId: req.deviceId, enrollmentId };
  await C.openOrg(ORG());
  expect(await C.containDevice(req.deviceId, "revoke", "Step 6: till reported stolen (synthetic)")).toBeNull();
  expect(C.dialogs.some((d) => d.startsWith("confirm: Revoking is permanent"))).toBe(true);
  await expect(C.deviceRow(req.deviceId).getByText("REVOKED")).toBeVisible();
  await phase(t, "revoked");
  await ensureShift(t);
  const before = await serverSales();
  await t.posAddByCard(P1);
  await checkoutRefused(t);
  expect(await serverSales()).toBe(before);
  expect(capsOf(enrollmentId)).toBe("");
  await expect(t.page.getByTestId("device-trust-reenroll")).toBeVisible();
  note("I12", { T2: tills.T2, revoked: true });
  await t.close(); T = null;
});

test("I13 aggregate offline exposure under Control-managed trust: the shop's outstanding offline authority never exceeds its owner-signed budget; revoked or suspended tills hold none issued after containment", async () => {
  const outstanding = Number(sqlOne(`SELECT coalesce(sum(max_amount_mmk),0) FROM recovery_v1.offline_capabilities c WHERE c.org_id='${ORG()}' AND c.shop_id='${st.ids.shop}' AND c.sync_deadline > now()
     AND c.offline_epoch=(SELECT offline_epoch FROM recovery_v1.org_state WHERE org_id='${ORG()}') AND NOT EXISTS (SELECT 1 FROM recovery_v1.offline_surrenders s WHERE s.capability_id=c.id);`));
  expect(outstanding).toBeLessThanOrEqual(30000);
  const afterContain = sqlOne(`SELECT count(*) FROM recovery_v1.offline_capabilities c JOIN recovery_v1.device_events e ON e.enrollment_id = c.enrollment_id AND e.kind = 'revoked' AND c.issued_at > e.at;`);
  expect(afterContain).toBe("0");
  note("I13", { shopOutstandingMmk: outstanding, shopBudgetMmk: 30000, capsAfterRevocation: afterContain });
});

test("I14 cross-organization isolation through Control: another organization's id cannot reach this organization's tills; the other organization stays RESTRICTED and shows none of them", async () => {
  const body = { action: "suspend", reason: "cross-organization attempt (synthetic)", requestId: crypto.randomUUID() };
  const url = `/api/pos-recovery/orgs/${OTHER()}/devices/${tills.T1.enrollmentId}/contain`;
  expect((await C.api(url, body)).body.error).toBe("STEPUP_REQUIRED");
  // even a genuine owner step-up bound to (other organization, this enrollment) does not reach this organization's till
  expect(await C.stepUp("pos_recovery_contain", `${OTHER()}:${tills.T1.enrollmentId}:suspend`)).toBe(true);
  const r = await C.api(url, body);
  expect([r.status, r.body.error]).toEqual([400, "POS_RECOVERY_INVALID"]);
  expect(ctlSql(`SELECT detail->>'pos_error' FROM control.audit_events WHERE request_id = '${body.requestId}'`)).toBe("RECOVERY_V1_DEVICE_CONTAIN_INVALID");
  expect(sqlOne(`SELECT recovery_v1.device_enrollment_state('${tills.T1.enrollmentId}');`)).toBe("ACTIVE");
  const other = (await C.api(`/api/pos-recovery/orgs/${OTHER()}`)).body.organization;
  expect(other.state).toBe("RESTRICTED");
  expect(other.devices.enrollments).toEqual([]);
  expect(other.deviceRequests).toEqual([]);
  const others = otherOrgsRestricted();
  expect(others.split("/")[0]).toBe(others.split("/")[1]);
  note("I14", { crossOrgContain: r.body.error, otherState: other.state, otherOrgsRestricted: others });
});

test("I15 audit trails: every successful Control action has its POS counterpart (by request id); both chains are intact; no money data ever reached Control", async () => {
  const rows = ctlSql(`SELECT coalesce(string_agg(action || '=' || request_id::text, ' ' ORDER BY seq), '') FROM control.audit_events
                        WHERE action IN ('pos.recovery_submitted', 'pos.recovery_transitioned', 'pos.recovery_device_contained', 'pos.recovery_reported') AND outcome = 'success'`)
    .split(" ").filter(Boolean).map((x) => x.split("="));
  expect(rows.length).toBeGreaterThanOrEqual(10);
  const unmatched = rows.filter(([, rid]) => {
    const n = Number(sqlOne(`SELECT (SELECT count(*) FROM recovery_v1.audit WHERE detail::text LIKE '%${rid}%' OR actor LIKE '%${rid}%')
                                  + (SELECT count(*) FROM recovery_v1.device_enrollments WHERE submitted_by LIKE '%${rid}%')
                                  + (SELECT count(*) FROM recovery_v1.reopenings WHERE submitted_by LIKE '%${rid}%')
                                  + (SELECT count(*) FROM recovery_v1.device_events WHERE by_actor LIKE '%${rid}%');`));
    return n === 0;
  });
  expect(unmatched).toEqual([]);
  // and the other direction: every POS action the bridge carried has its Control audit row (a Control-side rollback after
  // the POS committed would show up here — the documented no-two-phase-commit window, review 3 M1)
  const posRids = sqlOne(`SELECT coalesce(string_agg(DISTINCT m[1], ' '), '') FROM (
      SELECT regexp_matches(coalesce(detail->>'by', '') || ' ' || coalesce(detail->>'submittedBy', ''), ':([0-9a-f-]{36})@orvix_control_bridge', 'g') m
        FROM recovery_v1.audit WHERE actor = 'orvix_control_bridge') x;`).split(" ").filter(Boolean);
  const orphans = posRids.filter((rid) => ctlSql(`SELECT count(*) FROM control.audit_events WHERE request_id = '${rid}'`) === "0");
  expect(posRids.length).toBeGreaterThanOrEqual(rows.length);
  expect(orphans).toEqual([]);
  const verify = await C.api("/api/audit/verify", {});
  expect(verify.body).toMatchObject({ ok: true, intact: true });
  expect(ctlSql("SELECT count(*) FROM control.audit_events WHERE reason_code = 'POS_RECOVERY_IN_DOUBT'")).toBe("0");
  // everything Control ever showed or returned about the POS: no amounts, prices, costs, payments or customers
  const shown = JSON.stringify([(await C.api("/api/pos-recovery")).body, (await C.api(`/api/pos-recovery/orgs/${ORG()}`)).body,
    (await C.api(`/api/pos-recovery/orgs/${ORG()}/audit`)).body]);
  // no transaction, payment, price, cost, stock, customer or personal field — only recovery metadata; the offline-exposure
  // figures (owner-signed budgets, issued capability caps, possibly-unsynced maximum) are recovery controls and are shown
  // a sensitive-named key is acceptable only when everything under it is a count (e.g. facts.payments.salesWithPaymentMismatch)
  const countsOnly = (v: unknown): boolean => typeof v === "number" || (!!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(countsOnly));
  const keys = new Set<string>(); const forbidden: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      if ((/^(total|paid|change|discount|price|unit_?price|cost|receipt|payment|tender|sale_?id|sales|items|lines|qty|stock|inventory|customer|email|phone|name)/i.test(k) || /_mmk$/i.test(k)) && !countsOnly(x)) forbidden.push(k);
      walk(x);
    }
  };
  walk(JSON.parse(shown));
  expect(forbidden).toEqual([]);
  const exposureKeys = [...keys].filter((k) => /Mmk$/.test(k)).sort();
  expect(exposureKeys.every((k) => /^(maxAmountMmk|orgBudgetMmk|shopBudgetMmk|deviceBudgetMmk|amountMmk|organizationMmk|shopMmk|deviceMmk|possiblyUnsyncedMaxMmk)$/.test(k)), exposureKeys.join(",")).toBe(true);
  expect(sqlOne("SELECT count(*) FROM pg_stat_activity WHERE usename = 'orvix_control_bridge' AND state LIKE 'idle in transaction%';")).toBe("0");
  expect(sqlOne("SELECT coalesce(recovery_v1.integrity_problem(),'none');")).toBe("none");
  note("I15", { matchedRequests: rows.length, posRequestsCarried: posRids.length, controlChain: verify.body, posIntegrity: "none", exposureFieldsShown: exposureKeys });
});
