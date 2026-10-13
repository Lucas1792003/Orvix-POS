/// <reference types="node" />
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Phase F LIVE checks: server-side staff creation with public sign-up OFF.
// docs/selfhost-migration/phase-f/staff-creation.md
//
// Target: the self-hosted stack AFTER the coordinator has
//   1. deployed supabase/functions/staff-admin, and
//   2. set DISABLE_SIGNUP=true and recreated the auth service.
// Skipped unless LIVE_SUPABASE_URL is set (same env as the other live suites:
// LIVE_SUPABASE_URL, LIVE_ANON_KEY, LIVE_SERVICE_KEY, LIVE_SSH_HOST,
// LIVE_STACK_DIR). Prepared, NOT yet run against the server.
//
// Checks
//   F1  public sign-up is refused (GoTrue /signup with the anon key)
//   F2  ADMIN (verified TOTP, aal2) creates a CASHIER in their own org:
//       auth user confirmed, users row in the admin's org, USER_CREATED audit
//   F3  the created cashier can sign in and resolves their own row
//   F4  the same ADMIN on an aal1 session (TOTP enrolled) is refused
//   F5  MANAGER and CASHIER callers are refused; nothing created
//   F6  cross-org: org A's ADMIN cannot use org B's shop; org B's ADMIN (no
//       TOTP, emailed-code path) without a consumed code is refused, and with
//       one still cannot use org A's shop
//   F7  duplicate email -> 409; retry with the same key -> replay, no duplicate
//   F8  the existing QA admin with TOTP still logs in (password + TOTP -> aal2)
//   F9  cleanup.sql + audit_purge.sql + verify_clean.sql -> CLEAN
//
// QA data: org A = phase-d seed.sql (`qa-org-<ts>`), org B = service role
// (`qa-f-b-org-<ts>`); every account is @qa.invalid. All removed in F9.
// ---------------------------------------------------------------------------
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Evidence, createAuthUser, liveConfig, makeClient, randomPassword, runSql, runSqlFile, signedInClient, type LiveConfig,
} from "./liveHelpers";

const LIVE = Boolean(process.env.LIVE_SUPABASE_URL);
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const SQL_DIR = new URL("../../supabase/tests/", import.meta.url).pathname;
const SEED_SQL = `${SQL_DIR}phase-d/live/seed.sql`;
const CLEANUP_SQL = `${SQL_DIR}phase-d/live/cleanup.sql`;
const AUDIT_PURGE_SQL = `${SQL_DIR}phase-e/live/audit_purge.sql`;
const VERIFY_CLEAN_SQL = `${SQL_DIR}phase-d/live/verify_clean.sql`;

// RFC 6238 (SHA-1, 6 digits, 30 s) — same algorithm as e2e/helpers/totp.ts.
const b32 = (s: string): Buffer => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v >= 0) bits += v.toString(2).padStart(5, "0");
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
};
const totp = (secret: string, t = Math.floor(Date.now() / 1000)): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30)));
  const h = createHmac("sha1", b32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
};
const waitForFreshWindow = async (minLeft = 4) => {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (left < minLeft) await new Promise((r) => setTimeout(r, (left + 1) * 1000));
};

describe.skipIf(!LIVE)("Phase F live: staff-admin with DISABLE_SIGNUP=true", () => {
  const ev = new Evidence();
  let cfg: LiveConfig;
  const ts = String(Date.now());
  const password = randomPassword();
  let svc: SupabaseClient;
  const clients: SupabaseClient[] = [];
  const A = {
    org: `qa-org-${ts}`, shop: `qa-shop-${ts}`, adminId: `qa-user-admin-${ts}`,
    emails: { admin: `qa-admin-${ts}@qa.invalid`, mgr: `qa-manager-${ts}@qa.invalid`, cash: `qa-cashier-a-${ts}@qa.invalid`, cashb: `qa-cashier-b-${ts}@qa.invalid` },
    authAdmin: "", totpSecret: "", factorId: "",
  };
  const B = {
    org: `qa-f-b-org-${ts}`, shop: `qa-f-b-shop-${ts}`, adminId: `qa-f-b-admin-${ts}`,
    email: `qa-f-b-admin-${ts}@qa.invalid`, authId: "",
  };
  const sql1 = (q: string) => runSql(cfg, q).trim();

  /** POST /functions/v1/staff-admin exactly like supabase.functions.invoke does. */
  const staffAdmin = async (accessToken: string | null, body: Record<string, unknown>) => {
    const res = await fetch(`${cfg.url}/functions/v1/staff-admin`, {
      method: "POST",
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${accessToken ?? cfg.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    expect(text).not.toContain(cfg.serviceKey);
    if (typeof body.password === "string") expect(text).not.toContain(body.password);
    return { status: res.status, body: json, text };
  };
  const tokenOf = async (c: SupabaseClient) => (await c.auth.getSession()).data.session!.access_token;
  const aalOf = async (c: SupabaseClient) => (await c.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel;
  const signIn = async (email: string) => {
    const c = await signedInClient(cfg, email, password);
    clients.push(c);
    return c;
  };
  const stepUp = async (c: SupabaseClient) => {
    await waitForFreshWindow();
    const ch = await c.auth.mfa.challenge({ factorId: A.factorId });
    if (ch.error) throw new Error(`challenge: ${ch.error.message}`);
    const v = await c.auth.mfa.verify({ factorId: A.factorId, challengeId: ch.data.id, code: totp(A.totpSecret) });
    if (v.error) throw new Error(`verify: ${v.error.message}`);
  };
  const staffBody = (over: Record<string, unknown> = {}) => ({
    action: "create_staff", name: "QA Staff F", email: `qa-staff-f-${ts}@qa.invalid`, password,
    role: "CASHIER", shopId: A.shop, idempotencyKey: randomUUID(), ...over,
  });
  const usersCount = () => sql1(`SELECT count(*) FROM users WHERE org_id IN ('${A.org}', '${B.org}');`);
  const authCount = () => sql1(`SELECT count(*) FROM auth.users WHERE email LIKE '%-${ts}@qa.invalid';`);

  beforeAll(async () => {
    cfg = liveConfig();
    svc = makeClient(cfg, cfg.serviceKey);
    const verify = runSqlFile(cfg, VERIFY_CLEAN_SQL).trim();
    if (!verify.endsWith("CLEAN")) throw new Error(`stack is not clean before seeding: ${verify}`);

    // org A: phase-d seed (auth accounts through the GoTrue admin API)
    const auth = {
      admin: await createAuthUser(cfg, A.emails.admin, password),
      mgr: await createAuthUser(cfg, A.emails.mgr, password),
      casha: await createAuthUser(cfg, A.emails.cash, password),
      cashb: await createAuthUser(cfg, A.emails.cashb, password),
    };
    A.authAdmin = auth.admin;
    ev.info("setup A", runSqlFile(cfg, SEED_SQL, { ts, auth_admin: auth.admin, auth_mgr: auth.mgr, auth_casha: auth.casha, auth_cashb: auth.cashb }).trim());

    // org A's admin enrols TOTP (as the e2e global setup does)
    const admin = await signIn(A.emails.admin);
    const en = await admin.auth.mfa.enroll({ factorType: "totp", issuer: "Shwe PhaLar", friendlyName: "QA phase-f" });
    if (en.error) throw new Error(`enroll: ${en.error.message}`);
    A.totpSecret = en.data.totp.secret;
    A.factorId = en.data.id;
    await stepUp(admin);
    ev.info("setup A TOTP", `factor ${A.factorId} verified; session ${await aalOf(admin)}`);

    // org B: service role (the only org-creation path since 076), one shop
    B.authId = await createAuthUser(cfg, B.email, password);
    const oi = await svc.from("organizations").insert({ id: B.org, name: `QA F Org B ${ts}` });
    if (oi.error) throw new Error(`org B: ${oi.error.message}`);
    const si = await svc.from("shops").insert({ id: B.shop, code: `QF${ts.slice(-6)}`, name: `QA F Shop B ${ts}`, org_id: B.org, is_active: true });
    if (si.error) throw new Error(`shop B: ${si.error.message}`);
    const ui = await svc.from("users").insert({ id: B.adminId, name: "QA F B Admin", email: B.email, role: "ADMIN", org_id: B.org, auth_id: B.authId, is_active: true, created_at: new Date().toISOString() });
    if (ui.error) throw new Error(`admin B: ${ui.error.message}`);
    ev.info("setup B", `org ${B.org}, shop ${B.shop}, ADMIN ${B.adminId} (service role)`);
  });

  afterAll(async () => {
    process.stdout.write(`\n[phase-f staff results ts=${ts}]\n${ev.table()}\n\n`);
    for (const c of clients) {
      try { await c.auth.signOut(); } catch { /* ignore */ }
    }
  });

  it("F1 public sign-up is refused", async () => {
    const res = await fetch(`${cfg.url}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: `qa-signup-probe-${ts}@qa.invalid`, password }),
    });
    const body: any = await res.json().catch(() => ({}));
    expect(res.ok).toBe(false);
    expect(String(body.error_code ?? body.code ?? body.msg ?? "")).toMatch(/signup_disabled|422|403|disabled/i);
    expect(sql1(`SELECT count(*) FROM auth.users WHERE email = 'qa-signup-probe-${ts}@qa.invalid';`)).toBe("0");
    ev.pass("F1 sign-up disabled", `POST /auth/v1/signup -> ${res.status} ${body.error_code ?? body.msg ?? ""}; no auth row`);
  });

  it("F2 ADMIN (aal2) creates a CASHIER in their own org", async () => {
    const admin = clients[0];
    expect(await aalOf(admin)).toBe("aal2");
    const req = staffBody({ orgId: B.org });
    const r = await staffAdmin(await tokenOf(admin), req);
    expect(r.status, r.text).toBe(201);
    const id = r.body.user.id as string;
    expect(id).toMatch(/^user-[0-9a-f]{32}$/);
    const row = sql1(`SELECT org_id || '|' || role || '|' || shop_id || '|' || is_active || '|' || (auth_id IS NOT NULL) FROM users WHERE id = '${id}';`);
    expect(row).toBe(`${A.org}|CASHIER|${A.shop}|true|true`);
    expect(sql1(`SELECT count(*) FROM auth.users a JOIN users u ON u.auth_id = a.id WHERE u.id = '${id}' AND a.email_confirmed_at IS NOT NULL;`)).toBe("1");
    expect(sql1(`SELECT count(*) FROM audit_logs WHERE entity_id = '${id}' AND action_type = 'USER_CREATED' AND actor_id = '${A.adminId}';`)).toBe("1");
    ev.pass("F2 admin creates cashier", `${id}: ${row}; confirmed auth user; USER_CREATED=1; body orgId ignored`);
  });

  it("F3 the created cashier can sign in and resolves their own row", async () => {
    const c = await signIn(`qa-staff-f-${ts}@qa.invalid`);
    const me = await c.from("users").select("id, org_id, role").eq("email", `qa-staff-f-${ts}@qa.invalid`).single();
    expect(me.error).toBeNull();
    expect(me.data).toMatchObject({ org_id: A.org, role: "CASHIER" });
    ev.pass("F3 new cashier signs in", `${me.data?.id} org ${me.data?.org_id}`);
  });

  it("F4 the same ADMIN on an aal1 session is refused (TOTP enrolled)", async () => {
    const aal1 = await signIn(A.emails.admin);
    expect(await aalOf(aal1)).toBe("aal1");
    const before = authCount();
    const r = await staffAdmin(await tokenOf(aal1), staffBody({ email: `qa-staff-f4-${ts}@qa.invalid` }));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("mfa_required");
    expect(authCount()).toBe(before);
    ev.pass("F4 aal1 refused", `403 ${r.body.code}; auth users unchanged (${before})`);
  });

  it("F5 MANAGER and CASHIER callers are refused", async () => {
    const before = [usersCount(), authCount()];
    for (const email of [A.emails.mgr, A.emails.cash]) {
      const c = await signIn(email);
      const r = await staffAdmin(await tokenOf(c), staffBody({ email: `qa-staff-f5-${ts}@qa.invalid` }));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("forbidden");
    }
    const unauth = await staffAdmin(null, staffBody({ email: `qa-staff-f5-${ts}@qa.invalid` }));
    expect(unauth.status).toBe(401);
    expect([usersCount(), authCount()]).toEqual(before);
    ev.pass("F5 manager / cashier / anon refused", `403 forbidden x2, anon 401; nothing created`);
  });

  it("F6 cross-org shop refused; second org's ADMIN needs a verified sign-in first", async () => {
    const adminA = clients[0]; // the aal2 session from setup
    const before = [usersCount(), authCount()];
    const r = await staffAdmin(await tokenOf(adminA), staffBody({ shopId: B.shop, email: `qa-staff-f6-${ts}@qa.invalid` }));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("shop_not_allowed");

    const adminB = await signIn(B.email);
    const r2 = await staffAdmin(await tokenOf(adminB), staffBody({ shopId: B.shop, email: `qa-staff-f6b-${ts}@qa.invalid` }));
    expect(r2.status).toBe(403);
    expect(r2.body.code).toBe("verification_required");
    // simulate the emailed-code step (admin-2fa stores only a hash; consumed now)
    sql1(`INSERT INTO admin_login_codes (auth_id, code_hash, expires_at, consumed_at) VALUES ('${B.authId}', repeat('0', 64), now() + interval '10 minutes', now());`);
    const r3 = await staffAdmin(await tokenOf(adminB), staffBody({ shopId: A.shop, email: `qa-staff-f6c-${ts}@qa.invalid` }));
    expect(r3.status).toBe(403);
    expect(r3.body.code).toBe("shop_not_allowed");
    expect([usersCount(), authCount()]).toEqual(before);
    ev.pass("F6 cross-org", `A->B shop 403 ${r.body.code}; B unverified 403 ${r2.body.code}; B verified ->A shop 403 ${r3.body.code}; nothing created`);
  });

  it("F7 duplicate email -> 409; same key -> replay without a duplicate", async () => {
    const admin = clients[0];
    const dup = await staffAdmin(await tokenOf(admin), staffBody());
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("email_taken");
    const req = staffBody({ email: `qa-staff-f7-${ts}@qa.invalid`, role: "BUYER" });
    const first = await staffAdmin(await tokenOf(admin), req);
    expect(first.status, first.text).toBe(201);
    const again = await staffAdmin(await tokenOf(admin), req);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(sql1(`SELECT count(*) FROM users WHERE email = 'qa-staff-f7-${ts}@qa.invalid';`)).toBe("1");
    expect(sql1(`SELECT count(*) FROM auth.users WHERE email = 'qa-staff-f7-${ts}@qa.invalid';`)).toBe("1");
    ev.pass("F7 duplicate / replay", `dup 409; replay 200 replayed=true; 1 users row, 1 auth user`);
  });

  it("F8 the existing QA admin with TOTP still logs in (password + TOTP -> aal2)", async () => {
    const c = await signIn(A.emails.admin);
    expect(await aalOf(c)).toBe("aal1");
    await stepUp(c);
    expect(await aalOf(c)).toBe("aal2");
    ev.pass("F8 TOTP login", "password -> aal1, TOTP verify -> aal2");
  });

  it("F9 cleanup to CLEAN", async () => {
    for (const c of clients) {
      try { await c.auth.signOut(); } catch { /* ignore */ }
    }
    clients.length = 0;
    ev.info("cleanup", runSqlFile(cfg, CLEANUP_SQL).trim().split("\n").slice(-3).join(" "));
    ev.info("audit purge", runSqlFile(cfg, AUDIT_PURGE_SQL).trim().split("\n").slice(-1).join(" "));
    const verify = runSqlFile(cfg, VERIFY_CLEAN_SQL).trim();
    expect(verify.endsWith("CLEAN")).toBe(true);
    ev.pass("F9 cleanup", "verify_clean -> CLEAN");
  });
});
