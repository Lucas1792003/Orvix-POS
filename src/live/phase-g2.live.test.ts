/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Phase G follow-up LIVE checks for migrations 074-076 against the
// self-hosted Supabase stack (self-hosted stack, schema 076), through the public API
// with the real @supabase/supabase-js client.
//   074  idempotency replay bound to the caller's organization
//   075  expired phone-upload sessions rejected consistently; expiry persisted
//        by the next status read
//   076  bootstrap_first_admin() is the only bootstrap path and refuses on a
//        populated install
// docs/selfhost-migration/phase-g/remaining-security-fixes.md
//
// Skipped unless LIVE_SUPABASE_URL is set (same env as phase-g.org-isolation).
//
// QA data (removed by supabase/tests/phase-d/live/cleanup.sql +
// supabase/tests/phase-e/live/audit_purge.sql, proven by verify_clean.sql):
//   org A  `qa-org-<ts>`      phase-d seed.sql (supabase_admin, replica mode)
//   org B  `qa-g2b-org-<ts>`  inserted with the SERVICE ROLE (since 076
//                             organizations_ins is WITH CHECK (false) for
//                             `authenticated`, and users_ins has no setup
//                             branch - the platform console / service role is
//                             the only way to create an organization)
// No storage object is uploaded (the upload RPCs validate the URL string only).
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Evidence, liveConfig, makeClient, randomPassword, runSql, runSqlFile, signUpUser, signedInClient,
  uuid, type LiveConfig,
} from "./liveHelpers";

const LIVE = Boolean(process.env.LIVE_SUPABASE_URL);
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SEED_SQL = new URL("../../supabase/tests/phase-d/live/seed.sql", import.meta.url).pathname;
const REAL_ORG = "org-shwe-pha-lar";
const INACTIVE = "Upload link is no longer active";

type Rpc = { data: any; error: any; status: number };
const rpc = async (client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<Rpc> => {
  const res = await client.rpc(name, args);
  return { data: res.data, error: res.error, status: res.status };
};
const ok = (r: Rpc, what: string): any => {
  if (r.error) throw new Error(`${what} failed: ${r.error.message} (${r.error.code})`);
  return r.data;
};
const short = (s: unknown, n = 90) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

describe.skipIf(!LIVE)("Phase G live checks for 074-076 (self-hosted stack)", () => {
  const ev = new Evidence();
  let cfg: LiveConfig;
  const ts = String(Date.now());
  const password = randomPassword();
  let svc: SupabaseClient;
  let anon: SupabaseClient;
  const A = {
    orgId: "", shop: "", prod: "", adminId: "", mgrId: "",
    admin: null as unknown as SupabaseClient, mgr: null as unknown as SupabaseClient,
  };
  const B = { orgId: "", adminId: "", email: "", admin: null as unknown as SupabaseClient };
  const others: SupabaseClient[] = [];

  const sql1 = (q: string): string => runSql(cfg, q).trim();
  const REAL_SQL = `SELECT format('shops=%s users=%s products=%s inventory=%s auth.users(non-qa)=%s storage.objects=%s md5=%s',
  (SELECT count(*) FROM shops WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM users WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM products WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM inventory i JOIN shops s ON s.id = i.shop_id WHERE s.org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM auth.users WHERE email NOT LIKE '%@qa.invalid'),
  (SELECT count(*) FROM storage.objects),
  md5((SELECT string_agg(z::text, '|' ORDER BY z.id) FROM products z WHERE org_id = '${REAL_ORG}')
      || (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM users z WHERE org_id = '${REAL_ORG}')
      || (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM shops z WHERE org_id = '${REAL_ORG}')
      || (SELECT string_agg(z::text, '|' ORDER BY z.org_id) FROM business_profile z WHERE org_id = '${REAL_ORG}')));`;
  let realBefore = "";

  beforeAll(async () => {
    cfg = liveConfig();
    svc = makeClient(cfg, cfg.serviceKey);
    anon = makeClient(cfg, cfg.anonKey);
    realBefore = sql1(REAL_SQL);
    process.stdout.write(`[real org before] ${realBefore}\n`);

    // ---- org A: phase-d seed (supabase_admin) --------------------------------
    const e = {
      admin: `qa-admin-${ts}@qa.invalid`, mgr: `qa-manager-${ts}@qa.invalid`,
      casha: `qa-cashier-a-${ts}@qa.invalid`, cashb: `qa-cashier-b-${ts}@qa.invalid`,
    };
    const auth = {
      admin: await signUpUser(cfg, e.admin, password), mgr: await signUpUser(cfg, e.mgr, password),
      casha: await signUpUser(cfg, e.casha, password), cashb: await signUpUser(cfg, e.cashb, password),
    };
    const seed = runSqlFile(cfg, SEED_SQL, { ts, auth_admin: auth.admin, auth_mgr: auth.mgr, auth_casha: auth.casha, auth_cashb: auth.cashb }).trim();
    ev.info("setup A (seed.sql as supabase_admin)", seed);
    Object.assign(A, {
      orgId: `qa-org-${ts}`, shop: `qa-shop-${ts}`, prod: `qa-prod-1-${ts}`,
      adminId: `qa-user-admin-${ts}`, mgrId: `qa-user-manager-${ts}`,
      admin: await signedInClient(cfg, e.admin, password), mgr: await signedInClient(cfg, e.mgr, password),
    });

    // ---- org B: service role (the only org-creation path since 076) ---------
    B.orgId = `qa-g2b-org-${ts}`;
    B.adminId = `qa-g2b-admin-${ts}`;
    B.email = `qa-g2b-admin-${ts}@qa.invalid`;
    const bAuth = await signUpUser(cfg, B.email, password);
    const oi = await svc.from("organizations").insert({ id: B.orgId, name: `QA G2 Org B ${ts}` });
    if (oi.error) throw new Error(`service-role org insert: ${oi.error.message}`);
    const ui = await svc.from("users").insert({ id: B.adminId, name: "QA G2 B Admin", email: B.email, role: "ADMIN", org_id: B.orgId, auth_id: bAuth, is_active: true, created_at: new Date().toISOString() });
    if (ui.error) throw new Error(`service-role admin insert: ${ui.error.message}`);
    B.admin = await signedInClient(cfg, B.email, password);
    const bBp = sql1(`SELECT count(*) FROM business_profile WHERE org_id = '${B.orgId}';`);
    expect(bBp).toBe("1");
    ev.info("setup B (service role)", `org ${B.orgId} + ADMIN ${B.adminId} inserted with the service key; business_profile auto-row=${bBp} (068 trigger)`);
  });

  afterAll(async () => {
    try { ev.info("real org after", sql1(REAL_SQL)); } catch { /* ignore */ }
    process.stdout.write(`\n[results ts=${ts}]\n${ev.table()}\n\n`);
    for (const c of [A.admin, A.mgr, B.admin, ...others]) {
      try { await c?.auth.signOut(); } catch { /* ignore */ }
    }
  });

  // =========================================================================
  it("074. idempotency replay is bound to the caller's organization", async () => {
    const notes: string[] = [];
    const keyRow = (k: string) => sql1(`SELECT rpc || '|' || COALESCE(actor_id, '-') || '|' || COALESCE(org_id, '-') || '|' || md5(k::text) FROM idempotency_keys k WHERE key = '${k}';`);
    const mismatch = (r: Rpc) => r.error !== null && r.error.code === "23505" && /^IDEMPOTENCY_MISMATCH: key /.test(String(r.error.message)) && r.data === null;

    // ---- create_supplier ------------------------------------------------------
    const K1 = uuid();
    const P1 = { p_code: `QAG2SUP${ts}`, p_name: `QA G2 Supplier ${ts}`, p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null };
    const first = ok(await rpc(A.admin, "create_supplier", { ...P1, p_idempotency_key: K1 }), "A create_supplier");
    const supId: string = first.supplier.id;
    const row0 = keyRow(K1);
    expect(row0.split("|").slice(0, 3)).toEqual(["create_supplier", A.adminId, A.orgId]);
    const supsB0 = sql1(`SELECT count(*) FROM suppliers WHERE org_id = '${B.orgId}';`);

    const xB = await rpc(B.admin, "create_supplier", { ...P1, p_idempotency_key: K1 });
    expect(mismatch(xB), `org B replay must be IDEMPOTENCY_MISMATCH: ${JSON.stringify(xB.error)}`).toBe(true);
    expect(JSON.stringify(xB)).not.toContain(supId);
    expect(JSON.stringify(xB)).not.toContain(A.adminId);
    expect(sql1(`SELECT count(*) FROM suppliers WHERE org_id = '${B.orgId}';`)).toBe(supsB0);
    expect(sql1(`SELECT count(*) FROM suppliers WHERE code = '${P1.p_code}';`)).toBe("1");
    expect(keyRow(K1)).toBe(row0);
    // the cross-org refusal is indistinguishable from a payload mismatch (no oracle)
    const xPayload = await rpc(A.admin, "create_supplier", { ...P1, p_name: `QA G2 Other ${ts}`, p_idempotency_key: K1 });
    expect(mismatch(xPayload)).toBe(true);
    expect(xB.error.message).toBe(xPayload.error.message);
    expect(xB.status).toBe(xPayload.status);
    // same org, same actor -> stored response
    const replayA = ok(await rpc(A.admin, "create_supplier", { ...P1, p_idempotency_key: K1 }), "A replay");
    expect(replayA).toEqual(first);
    // same org, different actor (MANAGER) -> stored response by design (org binding, not actor)
    const replayMgr = await rpc(A.mgr, "create_supplier", { ...P1, p_idempotency_key: K1 });
    expect(replayMgr.error).toBeNull();
    expect(replayMgr.data).toEqual(first);
    expect(sql1(`SELECT count(*) FROM suppliers WHERE code = '${P1.p_code}';`)).toBe("1");
    expect(keyRow(K1)).toBe(row0);
    notes.push(`create_supplier K1=${K1.slice(0, 8)}…: A ADMIN -> ${supId}; key row rpc|actor|org = ${row0.split("|").slice(0, 3).join("|")}; org B ADMIN same key+payload -> HTTP ${xB.status} ${xB.error.code} "${short(xB.error.message, 70)}", data=null, response contains neither ${supId} nor ${A.adminId}; org B suppliers ${supsB0}->${supsB0}; suppliers with code=1; key row unchanged; A different payload -> identical message/status (no oracle); A ADMIN replay deep-equal; A MANAGER replay deep-equal (org-level binding by design)`);

    // ---- log_audit_event without a shop ------------------------------------
    const K2 = uuid();
    const msg = `QA G2 audit ${ts}`;
    const P2 = { p_action_type: "PRODUCT_EDIT", p_message: msg, p_entity_type: "Product", p_entity_id: A.prod, p_shop_id: null };
    const a1 = ok(await rpc(A.admin, "log_audit_event", { ...P2, p_idempotency_key: K2 }), "A log_audit_event");
    const auditId: string = a1.auditLog.id;
    const row2 = keyRow(K2);
    expect(row2.split("|").slice(0, 3)).toEqual(["log_audit_event", A.adminId, A.orgId]);
    const xB2 = await rpc(B.admin, "log_audit_event", { ...P2, p_idempotency_key: K2 });
    expect(mismatch(xB2), `org B audit replay: ${JSON.stringify(xB2.error)}`).toBe(true);
    expect(JSON.stringify(xB2)).not.toContain(auditId);
    expect(sql1(`SELECT count(*) FROM audit_logs WHERE message = '${msg}';`)).toBe("1");
    expect(sql1(`SELECT count(*) FROM audit_logs WHERE actor_id = '${B.adminId}';`)).toBe("0");
    expect(keyRow(K2)).toBe(row2);
    const a2 = ok(await rpc(A.admin, "log_audit_event", { ...P2, p_idempotency_key: K2 }), "A audit replay");
    expect(a2).toEqual(a1);
    expect(sql1(`SELECT count(*) FROM audit_logs WHERE message = '${msg}';`)).toBe("1");
    notes.push(`log_audit_event(p_shop_id NULL) K2=${K2.slice(0, 8)}…: A ADMIN -> ${auditId}; key row org=${A.orgId}; org B ADMIN same key+payload -> ${xB2.error.code} "${short(xB2.error.message, 40)}", no ${auditId} in response; audit rows with that message=1, by org B admin=0; A replay deep-equal, still 1 row`);

    // ---- every key row carries its actor's org (074 verification query) ---
    const drift = sql1(`SELECT count(*) FROM idempotency_keys k JOIN users u ON u.id = k.actor_id WHERE k.org_id IS DISTINCT FROM u.org_id;`);
    const nullOrg = sql1(`SELECT count(*) FROM idempotency_keys WHERE org_id IS NULL;`);
    expect(drift).toBe("0");
    expect(nullOrg).toBe("0");
    notes.push(`idempotency_keys with org_id != actor's org: ${drift}; with NULL org_id: ${nullOrg}`);
    ev.pass("074 cross-org idempotency replay", notes.join(" || "));
  });

  // =========================================================================
  it("076. bootstrap_first_admin refuses on a populated install (orphan, QA admin, anon); nothing created", async () => {
    const notes: string[] = [];
    const counts = () => sql1(`SELECT (SELECT count(*) FROM organizations) || '/' || (SELECT count(*) FROM users) || '/' || (SELECT count(*) FROM business_profile);`);
    const c0 = counts();
    // deployed objects (076 verification queries)
    const meta = sql1(`SELECT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.bootstrap_first_admin()'::regprocedure)
      || '|' || has_function_privilege('anon', 'public.bootstrap_first_admin()', 'EXECUTE')
      || '|' || has_function_privilege('authenticated', 'public.bootstrap_first_admin()', 'EXECUTE')
      || '|' || (SELECT with_check FROM pg_policies WHERE tablename = 'organizations' AND policyname = 'organizations_ins')
      || '|' || (SELECT with_check NOT LIKE '%app_setup_needed%' FROM pg_policies WHERE tablename = 'users' AND policyname = 'users_ins');`);
    expect(meta).toBe("true|false|true|false|true");
    notes.push(`prosecdef|anon EXECUTE|authenticated EXECUTE|organizations_ins with_check|users_ins without setup branch = ${meta}`);

    const sAnon = await rpc(anon, "app_setup_needed", {});
    expect(sAnon.error).toBeNull();
    expect(sAnon.data).toBe(false);

    const refused = (r: Rpc) => r.error !== null && r.error.code === "42501" && /^SETUP_ALREADY_COMPLETED/.test(String(r.error.message)) && r.data === null;
    // (1) orphan auth user (GoTrue signup, no users row)
    const orphanEmail = `qa-g2-orphan-${ts}@qa.invalid`;
    const orphanAuth = await signUpUser(cfg, orphanEmail, password);
    const orphan = await signedInClient(cfg, orphanEmail, password);
    others.push(orphan);
    const rOrphan = await rpc(orphan, "bootstrap_first_admin", {});
    expect(refused(rOrphan), `orphan: ${JSON.stringify(rOrphan.error)}`).toBe(true);
    // (2) a QA org ADMIN (org A, seeded) and the service-role-created org B ADMIN
    const rAdminA = await rpc(A.admin, "bootstrap_first_admin", {});
    expect(refused(rAdminA), `QA admin A: ${JSON.stringify(rAdminA.error)}`).toBe(true);
    const rAdminB = await rpc(B.admin, "bootstrap_first_admin", {});
    expect(refused(rAdminB), `QA admin B: ${JSON.stringify(rAdminB.error)}`).toBe(true);
    // (3) anon: no EXECUTE grant
    const rAnon = await rpc(anon, "bootstrap_first_admin", {});
    expect(rAnon.error?.code).toBe("42501");
    expect(String(rAnon.error?.message)).toMatch(/permission denied/i);
    // (4) service role: granted, but has no auth.uid()
    const rSvc = await rpc(svc, "bootstrap_first_admin", {});
    expect(rSvc.error).not.toBeNull();
    expect(String(rSvc.error.message)).toMatch(/Not authenticated/);
    // the pre-076 direct path stays closed even for an ADMIN (organizations_ins = false)
    const orgIns = await B.admin.from("organizations").insert({ id: `qa-g2-x-org-${ts}`, name: `QA G2 X ${ts}` });
    expect(orgIns.error?.code).toBe("42501");
    const orphanUsers = await orphan.from("users").insert({ id: `qa-g2-x-user-${ts}`, name: "QA G2 X", email: orphanEmail, role: "ADMIN", org_id: A.orgId, auth_id: orphanAuth, is_active: true });
    expect(orphanUsers.error).not.toBeNull();

    const c1 = counts();
    expect(c1).toBe(c0);
    expect(sql1(`SELECT count(*) FROM users WHERE auth_id = '${orphanAuth}';`)).toBe("0");
    expect(sql1(`SELECT count(*) FROM organizations WHERE id LIKE 'qa-g2-x-%' OR name LIKE 'QA G2 X%';`)).toBe("0");
    const sAfter = await rpc(orphan, "app_setup_needed", {});
    expect(sAfter.data).toBe(false);
    notes.push(`orphan -> ${rOrphan.error.code} "${short(rOrphan.error.message, 60)}"; QA ADMIN A -> ${rAdminA.error.code} SETUP_ALREADY_COMPLETED; QA ADMIN B -> ${rAdminB.error.code} SETUP_ALREADY_COMPLETED; anon -> ${rAnon.error.code} "${short(rAnon.error.message, 50)}"; service role -> ${rSvc.error.code} "${short(rSvc.error.message, 30)}"; ADMIN B direct INSERT organizations -> ${orgIns.error.code}; orphan direct INSERT users(ADMIN) -> ${orphanUsers.error.code}; organizations/users/business_profile ${c0} -> ${c1}; orphan users rows=0; app_setup_needed anon=${sAnon.data} after=${sAfter.data}`);
    ev.pass("076 bootstrap refused on populated install", notes.join("; "));
  });

  it("076c. concurrent first-time setup: not testable live (populated install) - harness evidence referenced", () => {
    // bootstrap_first_admin() refuses before any insert while app_setup_needed() is false, so two
    // concurrent calls on the self-hosted stack can only both be refused. The race (exactly one org/ADMIN
    // under two simultaneous calls on an EMPTY users table) is proven on the disposable harness:
    // supabase/tests/phase-d/sql/t12_bootstrap_{prep,a,b,check}.sql, result recorded in
    // docs/selfhost-migration/phase-g/remaining-security-fixes.md ("Results").
    ev.info("076 concurrent setup", "NOT RUN LIVE: the target stack is populated (app_setup_needed()=false), so every call is refused before the lock-protected inserts; emptying users is out of bounds. Harness t12 (all migrations): session B refused with SETUP_ALREADY_COMPLETED after waiting ~2 s for A; exactly one users row (ADMIN, operator A, A's new org); exactly one new organization with its business_profile (orgs before=4 after=5); 371 assertions, 0 failed");
  });

  // =========================================================================
  it("075. expired upload session: completion rejected, expiry persisted by the next status read; live sessions unaffected", async () => {
    const notes: string[] = [];
    const FAKE_SIGNED = `qa-g2-signed-${ts}`;
    const newSession = async () => ok(await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: A.prod }), "create upload session");
    const expire = async (id: string) => {
      const r = await svc.from("product_image_upload_sessions")
        .update({ expires_at: new Date(Date.now() - 60_000).toISOString(), signed_upload_token: FAKE_SIGNED })
        .eq("id", id).select("id");
      if (r.error || r.data?.length !== 1) throw new Error(`expire ${id}: ${r.error?.message}`);
    };
    const row = (id: string) => sql1(`SELECT status || '|' || (expires_at <= now()) || '|' || COALESCE(signed_upload_token, '<null>') || '|' || COALESCE(bytes::text, '<null>') FROM product_image_upload_sessions WHERE id = '${id}';`);
    const completeArgs = (s: any) => ({
      p_token: s.token, p_storage_path: s.storagePath,
      p_public_url: `${cfg.url}/storage/v1/object/public/product-images/${s.storagePath}`,
      p_bytes: 100, p_mime_type: "image/webp",
    });
    expect(sql1(`SELECT has_function_privilege('anon', 'public.complete_product_image_upload_session(text,text,text,integer,text)', 'EXECUTE');`)).toBe("t");

    // ---- session 1: desktop status poll persists the expiry ---------------
    const s1 = await newSession();
    await expire(s1.sessionId);
    const c1 = await rpc(anon, "complete_product_image_upload_session", completeArgs(s1));
    expect(c1.error?.message).toBe(INACTIVE);
    const r1 = row(s1.sessionId);
    expect(r1).toBe(`PENDING|true|${FAKE_SIGNED}|<null>`); // rejected call changed nothing; derivably expired
    const g1 = ok(await rpc(A.admin, "get_product_image_upload_session_status", { p_session_id: s1.sessionId }), "status poll");
    expect(g1.status).toBe("EXPIRED");
    const r1b = row(s1.sessionId);
    expect(r1b).toBe("EXPIRED|true|<null>|<null>");
    const c1b = await rpc(anon, "complete_product_image_upload_session", completeArgs(s1));
    expect(c1b.error?.message).toBe(INACTIVE);
    expect(row(s1.sessionId)).toBe(r1b);
    notes.push(`S1 ${s1.sessionId}: expires_at -60 s + signed token set (service role); anon complete -> "${c1.error.message}"; row status|expired|signed_token|bytes = ${r1}; admin get_..._status -> ${g1.status}; row -> ${r1b}; complete again -> "${c1b.error.message}", row unchanged`);

    // ---- session 2: the phone page's by-token read persists the expiry ----
    const s2 = await newSession();
    await expire(s2.sessionId);
    const c2 = await rpc(anon, "complete_product_image_upload_session", completeArgs(s2));
    expect(c2.error?.message).toBe(INACTIVE);
    expect(row(s2.sessionId)).toBe(`PENDING|true|${FAKE_SIGNED}|<null>`);
    const g2 = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: s2.token }), "by-token read");
    expect(g2.status).toBe("EXPIRED");
    expect(g2.uploadToken).toBeNull();
    const r2 = row(s2.sessionId);
    expect(r2).toBe("EXPIRED|true|<null>|<null>");
    const c2b = await rpc(anon, "complete_product_image_upload_session", completeArgs(s2));
    expect(c2b.error?.message).toBe(INACTIVE);
    notes.push(`S2 ${s2.sessionId}: anon complete -> "${c2.error.message}", row still PENDING (expired); anon get_..._by_token -> status ${g2.status}, uploadToken ${g2.uploadToken}; row -> ${r2}; complete again -> "${c2b.error.message}"`);

    // ---- session 3: a fresh ACTIVE session still completes -----------------
    const s3 = await newSession();
    const g3 = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: s3.token }), "by-token read (active)");
    expect(g3.status).toBe("PENDING");
    const c3 = ok(await rpc(anon, "complete_product_image_upload_session", completeArgs(s3)), "complete active session");
    expect(c3).toMatchObject({ sessionId: s3.sessionId, status: "COMPLETED", bytes: 100, mimeType: "image/webp", storagePath: s3.storagePath });
    const r3 = row(s3.sessionId);
    expect(r3).toBe("COMPLETED|false|<null>|100");
    const st3 = ok(await rpc(A.admin, "get_product_image_upload_session_status", { p_session_id: s3.sessionId }), "status (completed)");
    expect(st3.status).toBe("COMPLETED");
    const c3b = await rpc(anon, "complete_product_image_upload_session", completeArgs(s3));
    expect(c3b.error?.message).toBe(INACTIVE);
    notes.push(`S3 ${s3.sessionId} (active): by-token -> ${g3.status}; anon complete -> ${c3.status} bytes=${c3.bytes}; row -> ${r3}; admin status -> ${st3.status}; second complete -> "${c3b.error.message}"`);
    const objs = sql1(`SELECT count(*) FROM storage.objects WHERE name IN ('${s1.storagePath}', '${s2.storagePath}', '${s3.storagePath}');`);
    expect(objs).toBe("0");
    notes.push(`storage objects for the 3 session paths: ${objs} (no upload performed)`);
    ev.pass("075 expired upload session", notes.join(" || "));
  });
});
