/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Phase G follow-up LIVE checks for migrations 077-079 against the
// self-hosted Supabase stack (lucashome, schema 080 since 2026-10-13: test 8
// asserts 080's server-derived completion URL), through the public API
// with the real @supabase/supabase-js client (and plain fetch where the exact
// HTTP status matters).
//   077  every new organization gets Retail (default) / Wholesale / Special
//   078  org-scoped storage paths + path-based authorization of legacy objects
//   079  phone-upload sessions on org/<org>/temp/<session>; completion URL
//        must end with the session's own object path; attach rollback fix
// docs/selfhost-migration/phase-g/upload-security-and-077.md
//
// Skipped unless LIVE_SUPABASE_URL is set (same env as phase-g.org-isolation).
// Optional: LIVE_STORAGE_MANIFEST (default
//   ~/shwephala-migration/20261011T2347Z/storage-manifest.sha256)
//
// QA data - every organization is created the CONSOLE way (service-role
// INSERT into organizations, ADMIN row inserted with the service role), ids
// `qa-g3<x>-...`, emails @qa.invalid, names "QA ...". Rows are removed by
// supabase/tests/phase-d/live/cleanup.sql (+ phase-e audit_purge.sql) and
// proven by verify_clean.sql. Storage objects (all under org/qa-g3...) are
// removed by this suite through the Storage API (service role) in afterAll.
// Real-organization storage objects are NEVER written: every API attempt
// against one is preceded by a read-only SQL proof that RLS refuses it.
// ---------------------------------------------------------------------------
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Evidence, liveConfig, makeClient, randomPassword, runSql, signUpUser, signedInClient,
  sleep, uuid, type LiveConfig,
} from "./liveHelpers";

const LIVE = Boolean(process.env.LIVE_SUPABASE_URL);
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const BUCKET = "product-images";
const REAL_ORG = "org-shwe-pha-lar";
// 1x1 lossless WebP (26 bytes): a real image, well under the bucket limits.
const TINY_WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const INACTIVE = "Upload link is no longer active";
const URL_MISMATCH = "Uploaded image URL does not match this upload session";
const PATH_MISMATCH = "Upload path does not match this session";
const NOT_IN_ORG = /not found in your organization/i;
const PHONE_FIELDS = "bytes,expiresAt,mimeType,publicUrl,sessionId,status,storagePath,uploadToken";
// Same expressions as the owner's pre-apply baseline (real org only).
const PL_MD5 = "c49665ae10a46ef70936ccbbe6b4d570";
const PUP_MD5 = "4c64d8b75d68c47c11c205410ff05b72";

type Rpc = { data: any; error: any; status: number };
const rpc = async (client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<Rpc> => {
  const res = await client.rpc(name, args);
  return { data: res.data, error: res.error, status: res.status };
};
const ok = (r: Rpc, what: string): any => {
  if (r.error) throw new Error(`${what} failed: ${r.error.message} (${r.error.code})`);
  return r.data;
};
const short = (s: unknown, n = 80) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const sha = (b: ArrayBuffer | Buffer) => createHash("sha256").update(Buffer.from(b as ArrayBuffer)).digest("hex");
const jwtPayload = (t: string): any => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));

interface Org {
  key: string;
  orgId: string;
  name: string;
  adminId: string; adminAuth: string; email: string;
  admin: SupabaseClient;
  shop: string; prod: string; unit: string; price: number;
  retail: string; // id of the org's own trigger-seeded Retail level
  shift: string;
}

describe.skipIf(!LIVE)("Phase G live checks for 077-079 (self-hosted stack)", () => {
  const ev = new Evidence();
  let cfg: LiveConfig;
  const ts = String(Date.now());
  const password = randomPassword();
  let svc: SupabaseClient;
  let anon: SupabaseClient;
  const A = { key: "a" } as Org;
  const B = { key: "b" } as Org;
  let realBefore = "";

  const sql1 = (q: string): string => runSql(cfg, q).trim();
  /** Lines of a multi-statement script that start with `R|` (marker), marker stripped. */
  const sqlR = (q: string): string[] => runSql(cfg, q).split("\n").filter((l) => l.startsWith("R|")).map((l) => l.slice(2));
  const publicUrl = (p: string) => `${cfg.url}/storage/v1/object/public/${BUCKET}/${p}`;
  const st = (c: SupabaseClient) => c.storage.from(BUCKET);
  const objCount = (name: string) => sql1(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${name}';`);
  const objRow = (name: string) => sql1(`SELECT name || '|' || COALESCE(metadata->>'size', '-') || '|' || COALESCE(version, '-') || '|' || updated_at || '|' || COALESCE(owner_id, '<null>') FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${name}';`);
  /** psql as `authenticated` with the given auth uid as JWT subject, inside a ROLLBACK-only transaction. */
  const asUser = (authId: string, selects: string): string[] => sqlR(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${authId}","role":"authenticated"}', true), set_config('request.jwt.claim.sub', '${authId}', true), set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
${selects}
ROLLBACK;`);

  const REAL_SQL = `SELECT format('users=%s shops=%s products=%s product_units=%s price_levels=%s product_unit_prices=%s sales=%s sessions=%s storage.objects=%s auth.users(non-qa)=%s pl_md5=%s pup_md5=%s rows_md5=%s',
  (SELECT count(*) FROM users WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM shops WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM products WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM product_units u JOIN products p ON p.id = u.product_id WHERE p.org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM price_levels WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM product_unit_prices WHERE price_level_id IN (SELECT id FROM price_levels WHERE org_id = '${REAL_ORG}')),
  (SELECT count(*) FROM sales s JOIN shops h ON h.id = s.shop_id WHERE h.org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM product_image_upload_sessions s JOIN users u ON u.id = s.created_by WHERE u.org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM storage.objects WHERE name NOT LIKE '%qa-%'),
  (SELECT count(*) FROM auth.users WHERE email NOT LIKE '%@qa.invalid'),
  (SELECT md5(string_agg(id||org_id||code||name||coalesce(is_default::text,'-')||coalesce(sort_order::text,'-'), ',' order by id)) FROM price_levels WHERE org_id = '${REAL_ORG}'),
  (SELECT md5(string_agg(id||price_level_id||price_mmk::text, ',' order by id)) FROM product_unit_prices WHERE price_level_id IN (SELECT id FROM price_levels WHERE org_id = '${REAL_ORG}')),
  md5((SELECT string_agg(z::text, '|' ORDER BY z.id) FROM products z WHERE org_id = '${REAL_ORG}')
      || (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM users z WHERE org_id = '${REAL_ORG}')
      || (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM price_levels z WHERE org_id = '${REAL_ORG}')
      || (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM product_image_upload_sessions z WHERE created_by IN (SELECT id FROM users WHERE org_id = '${REAL_ORG}'))
      || (SELECT string_agg(z.name || z.updated_at::text || COALESCE(z.version, ''), '|' ORDER BY z.name) FROM storage.objects z WHERE name NOT LIKE '%qa-%')));`;
  const realState = (): string => sql1(REAL_SQL);
  const levels = (orgId: string) => sql1(`SELECT COALESCE(string_agg(code || ':' || name || ':' || is_default || ':' || is_active || ':' || sort_order, ',' ORDER BY sort_order, code), '') || ' n=' || count(*) || ' ids_distinct=' || count(DISTINCT id) FROM price_levels WHERE org_id = '${orgId}';`);
  const EXPECTED_LEVELS = "retail:Retail:true:true:10,wholesale:Wholesale:false:true:20,special:Special:false:true:30 n=3 ids_distinct=3";

  /** Console-style org: service-role INSERT organizations + ADMIN row (auth user via GoTrue signup). */
  const createConsoleOrg = async (o: Org) => {
    o.orgId = `qa-g3${o.key}-org-${ts}`;
    o.name = `QA G3 Org ${o.key.toUpperCase()} ${ts}`;
    o.adminId = `qa-g3${o.key}-admin-${ts}`;
    o.email = `qa-g3${o.key}-admin-${ts}@qa.invalid`;
    o.adminAuth = await signUpUser(cfg, o.email, password);
    const oi = await svc.from("organizations").insert({ id: o.orgId, name: o.name }).select("id");
    if (oi.error) throw new Error(`service-role org insert ${o.orgId}: ${oi.error.message}`);
    const ui = await svc.from("users").insert({ id: o.adminId, name: `QA G3 ${o.key.toUpperCase()} Admin`, email: o.email, role: "ADMIN", org_id: o.orgId, auth_id: o.adminAuth, is_active: true, created_at: new Date().toISOString() });
    if (ui.error) throw new Error(`service-role admin insert ${o.adminId}: ${ui.error.message}`);
    o.admin = await signedInClient(cfg, o.email, password);
  };

  /** Shop / product / default unit / stock through the API as the org's ADMIN (org_id never sent). */
  const buildCatalog = async (o: Org, price: number) => {
    o.shop = `qa-g3${o.key}-shop-${ts}`;
    o.prod = `qa-g3${o.key}-prod-${ts}`;
    o.unit = `qa-g3${o.key}-unit-${ts}`;
    o.price = price;
    const sh = await o.admin.from("shops").insert({ id: o.shop, code: `G3${o.key.toUpperCase()}${ts}`, name: `QA G3 ${o.key.toUpperCase()} Shop ${ts}`, address: "QA G3 Street", is_active: true });
    if (sh.error) throw new Error(`${o.key} shop insert: ${sh.error.message}`);
    const pr = await o.admin.from("products").insert({ id: o.prod, sku: `QAG3${o.key.toUpperCase()}-${ts}`, name: `QA G3 ${o.key.toUpperCase()} Product`, category: "QA", unit_type: "pcs", price_mmk: price, cost_mmk: 500, is_active: true });
    if (pr.error) throw new Error(`${o.key} product insert: ${pr.error.message}`);
    const un = await o.admin.from("product_units").insert({ id: o.unit, product_id: o.prod, name: "pcs", base_quantity: 1, is_default: true, is_active: true, sale_price_mmk: price, purchase_price_mmk: 500 });
    if (un.error) throw new Error(`${o.key} unit insert: ${un.error.message}`);
    ok(await rpc(o.admin, "adjust_stock", { p_shop_id: o.shop, p_product_id: o.prod, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 50, p_reason: "QA G3 opening stock", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: o.adminId, p_idempotency_key: uuid() }), `${o.key} opening stock`);
  };

  const uploaded = new Set<string>();

  beforeAll(async () => {
    cfg = liveConfig();
    svc = makeClient(cfg, cfg.serviceKey);
    anon = makeClient(cfg, cfg.anonKey);
    realBefore = realState();
    process.stdout.write(`[real org before] ${realBefore}\n`);
    expect(realBefore).toContain(`pl_md5=${PL_MD5}`);
    expect(realBefore).toContain(`pup_md5=${PUP_MD5}`);
    // 077-079 applied; since 2026-10-13 the stack is at 080 (completion URL
    // derived server-side, object must exist) - test 8 asserts that behaviour.
    expect(sql1(`SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version IN ('077','078','079','080');`)).toBe("077,078,079,080");
    expect(sql1(`SELECT max(version) FROM supabase_migrations.schema_migrations;`)).toBe("080");
  });

  afterAll(async () => {
    // QA storage objects -> Storage API (service role) so the files on disk go too.
    try {
      const left = sql1(`SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}' AND (name LIKE 'org/qa-g3%' OR name LIKE '%qa-g3%');`).split("\n").filter(Boolean);
      const unexpected = left.filter((n) => !/^org\/qa-g3[a-z]-org-\d+\//.test(n) && !/qa-g3[a-z]-prod-\d+/.test(n));
      if (unexpected.length) throw new Error(`refusing to delete unexpected names: ${unexpected.join(",")}`);
      let removed = 0;
      if (left.length) {
        const r = await svc.storage.from(BUCKET).remove(left);
        if (r.error) throw new Error(r.error.message);
        removed = r.data?.length ?? 0;
      }
      const after = sql1(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND (name LIKE 'org/qa-%' OR name LIKE '%qa-g3%');`);
      ev.info("storage cleanup", `QA objects found=${left.length} (tracked uploads=${uploaded.size}); removed via service-role Storage API=${removed}; remaining QA objects=${after}`);
    } catch (err: any) {
      ev.fail("storage cleanup", String(err?.message ?? err));
    }
    try {
      const realAfter = realState();
      ev.add("real org unchanged", realAfter === realBefore ? "PASS" : "FAIL", `before == after: ${realAfter === realBefore}; ${realAfter}`);
    } catch { /* ignore */ }
    process.stdout.write(`\n[results ts=${ts}]\n${ev.table()}\n\n`);
    for (const c of [A.admin, B.admin]) {
      try { await c?.auth.signOut(); } catch { /* ignore */ }
    }
  });

  // =========================================================================
  it("1. 077 price levels: new console org gets exactly Retail/Wholesale/Special; concurrent orgs; re-seed; real org unchanged", async () => {
    const notes: string[] = [];
    // ---- org A and B, console way ------------------------------------------
    await createConsoleOrg(A);
    await createConsoleOrg(B);
    for (const o of [A, B]) {
      const lv = levels(o.orgId);
      expect(lv, `${o.key} levels`).toBe(EXPECTED_LEVELS);
      const bp = sql1(`SELECT count(*) FROM business_profile WHERE org_id = '${o.orgId}';`);
      expect(bp).toBe("1");
      // API view of the same rows (the org's own ADMIN, RLS)
      const api = await o.admin.from("price_levels").select("id, code, name, is_default, is_active, sort_order, org_id").order("sort_order");
      expect(api.error).toBeNull();
      expect(api.data!.map((r: any) => `${r.code}:${r.is_default}:${r.org_id}`)).toEqual([`retail:true:${o.orgId}`, `wholesale:false:${o.orgId}`, `special:false:${o.orgId}`]);
      o.retail = api.data!.find((r: any) => r.code === "retail")!.id;
      expect(o.retail).toMatch(/^plv-[0-9a-f]{32}$/);
      notes.push(`${o.orgId}: SQL ${lv}; ADMIN API sees ${api.data!.length} rows (retail id ${o.retail}); business_profile=${bp}`);
    }
    expect(A.retail).not.toBe(B.retail);

    // ---- two orgs created CONCURRENTLY -------------------------------------
    const C = `qa-g3c-org-${ts}`, D = `qa-g3d-org-${ts}`;
    const [rc, rd] = await Promise.all([
      svc.from("organizations").insert({ id: C, name: `QA G3 Org C ${ts}` }).select("id"),
      svc.from("organizations").insert({ id: D, name: `QA G3 Org D ${ts}` }).select("id"),
    ]);
    expect(rc.error).toBeNull();
    expect(rd.error).toBeNull();
    expect(levels(C)).toBe(EXPECTED_LEVELS);
    expect(levels(D)).toBe(EXPECTED_LEVELS);
    notes.push(`concurrent C+D (Promise.all, service role): both inserted; C ${levels(C)}; D ${levels(D)}`);

    // ---- same org id twice, concurrently ----------------------------------
    const E = `qa-g3e-org-${ts}`;
    const same = await Promise.all([1, 2].map((i) => svc.from("organizations").insert({ id: E, name: `QA G3 Org E${i} ${ts}` }).select("id")));
    const errs = same.filter((r) => r.error).map((r) => `${r.error!.code} ${r.error!.message}`);
    expect(same.filter((r) => !r.error)).toHaveLength(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^23505 .*organizations_pkey/);
    expect(levels(E)).toBe(EXPECTED_LEVELS);
    notes.push(`same id ${E} twice concurrently: 1 ok, 1 -> ${errs[0]}; ${levels(E)}`);

    // ---- re-seed / duplicate inserts -> no duplicates ----------------------
    const reseed = await rpc(svc, "app_seed_default_price_levels", { p_org_id: A.orgId });
    expect(reseed.error).toBeNull();
    expect(reseed.data).toBe(0);
    const reseedAll = await Promise.all([A.orgId, B.orgId, C, D].map((id) => rpc(svc, "app_seed_default_price_levels", { p_org_id: id })));
    expect(reseedAll.map((r) => r.data)).toEqual([0, 0, 0, 0]);
    const asAdmin = await rpc(A.admin, "app_seed_default_price_levels", { p_org_id: A.orgId });
    expect(asAdmin.error?.code).toBe("42501");
    const asAnon = await rpc(anon, "app_seed_default_price_levels", { p_org_id: A.orgId });
    expect(asAnon.error?.code).toBe("42501");
    const dupCode = await svc.from("price_levels").insert({ id: `qa-g3-dup-${ts}`, org_id: A.orgId, code: " RETAIL ", name: "QA dup", is_default: false, is_active: true, sort_order: 99 });
    expect(dupCode.error?.code).toBe("23505");
    const dupDefault = await A.admin.from("price_levels").insert({ id: `qa-g3-dup2-${ts}`, code: `qa-g3-x-${ts}`, name: "QA second default", is_default: true, is_active: true, sort_order: 98 });
    expect(dupDefault.error?.code).toBe("23505");
    for (const id of [A.orgId, B.orgId, C, D, E]) expect(levels(id)).toBe(EXPECTED_LEVELS);
    expect(sql1(`SELECT count(*) FROM price_levels WHERE id LIKE 'qa-g3-dup%';`)).toBe("0");
    notes.push(`app_seed_default_price_levels (service role) A -> ${reseed.data}; A,B,C,D concurrently -> ${reseedAll.map((r) => r.data).join("/")}; as QA ADMIN -> ${asAdmin.error.code} "${short(asAdmin.error.message, 50)}"; as anon -> ${asAnon.error.code}; duplicate code ' RETAIL ' (service role) -> ${dupCode.error!.code} "${short(dupCode.error!.message, 70)}"; second active default (ADMIN API) -> ${dupDefault.error!.code} "${short(dupDefault.error!.message, 70)}"; all 5 QA orgs still exactly 3 levels`);

    // ---- real org unchanged -------------------------------------------------
    const real = realState();
    expect(real).toContain(`pl_md5=${PL_MD5}`);
    expect(real).toContain(`pup_md5=${PUP_MD5}`);
    expect(real).toContain("price_levels=3 product_unit_prices=956");
    notes.push(`real org: price_levels=3 md5 ${PL_MD5}; product_unit_prices=956 md5 ${PUP_MD5} (unchanged)`);
    ev.pass("1 077 price levels", notes.join(" || "));
  });

  // =========================================================================
  it("2. checkout succeeds in two new QA orgs without manual level seeding; real org's default level resolved read-only", async () => {
    const notes: string[] = [];
    await buildCatalog(A, 1000);
    await buildCatalog(B, 2000);
    // org A: a unit price on its OWN (trigger-seeded) Retail level, so the sale is priced through it.
    const pup = await A.admin.from("product_unit_prices").insert({ id: `qa-g3a-pup-${ts}`, product_unit_id: A.unit, price_level_id: A.retail, shop_id: null, price_mmk: 1100, is_active: true });
    expect(pup.error).toBeNull();
    for (const o of [A, B]) {
      const sh = ok(await rpc(o.admin, "open_shift", { p_shop_id: o.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: o.adminId, p_idempotency_key: uuid() }), `${o.key} open_shift`);
      o.shift = sh.shift.id;
      const sale = ok(await rpc(o.admin, "complete_sale", {
        p_shop_id: o.shop, p_shift_id: sh.shift.id, p_payment_method: "CASH", p_paid_mmk: 10_000, p_cart_discount_pct: 0,
        p_items: [{ product_id: o.prod, qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString(), p_idempotency_key: uuid(),
      }), `${o.key} complete_sale`);
      const saleId = sale.sale.id;
      const item = sql1(`SELECT price_level_id || '|' || price_level_name_snapshot || '|' || price_source_snapshot || '|' || unit_price_mmk FROM sale_items WHERE sale_id = '${saleId}';`);
      const expectedPrice = o === A ? 1100 : 2000;
      expect(item.split("|")[0]).toBe(o.retail);
      expect(item.split("|")[1]).toBe("Retail");
      expect(item.split("|")[3]).toBe(String(expectedPrice));
      const inv = sql1(`SELECT qty_base_units FROM inventory WHERE shop_id = '${o.shop}' AND product_id = '${o.prod}';`);
      expect(inv).toBe("49");
      notes.push(`${o.orgId}: complete_sale -> ${saleId} (API ok); sale_items price_level_id|name|source|unit_price = ${item}; stock 50->${inv}`);
    }
    // real org: what complete_sale would pick (its exact lookup), read-only, real ADMIN simulated
    const realAdmin = sql1(`SELECT auth_id FROM users WHERE org_id = '${REAL_ORG}' AND role = 'ADMIN' AND is_active ORDER BY id LIMIT 1;`);
    const pick = asUser(realAdmin, `SELECT 'R|' || (current_app_user()).org_id || '|' || COALESCE((SELECT id || '|' || code || '|' || name FROM price_levels WHERE is_default = true AND is_active = true AND org_id = (current_app_user()).org_id LIMIT 1), '<none>');`);
    expect(pick).toEqual([`${REAL_ORG}|plv-retail|retail|Retail`]);
    // and as supabase_admin (complete_sale is SECURITY DEFINER: no RLS in its lookup)
    const pick2 = sql1(`SELECT id FROM price_levels WHERE is_default = true AND is_active = true AND org_id = '${REAL_ORG}';`);
    expect(pick2).toBe("plv-retail");
    notes.push(`real org (NOT exercised with real data): complete_sale's default lookup evaluated read-only (ROLLBACK) as the real ADMIN -> ${pick[0]}; as supabase_admin -> ${pick2}`);
    ev.pass("2 checkout in new orgs", notes.join(" || "));
  });

  // =========================================================================
  it("3. cross-org price references are blocked (unit price -> other org's level, client-supplied org_id, sale with other org's level)", async () => {
    const notes: string[] = [];
    const reject = async (what: string, p: PromiseLike<{ error: any; data?: any }>) => {
      const r = await p;
      const refused = r.error !== null || (Array.isArray(r.data) && r.data.length === 0);
      expect(refused, `${what}: ${JSON.stringify(r.error)}`).toBe(true);
      notes.push(`${what} -> ${r.error ? `${r.error.code ?? ""} ${short(r.error.message, 60)}` : "0 rows"}`);
    };
    await reject("A ADMIN unit price on A unit -> B Retail level", A.admin.from("product_unit_prices").insert({ id: `qa-g3-x1-${ts}`, product_unit_id: A.unit, price_level_id: B.retail, shop_id: null, price_mmk: 1, is_active: true }));
    await reject("service role unit price A unit -> B level", svc.from("product_unit_prices").insert({ id: `qa-g3-x2-${ts}`, product_unit_id: A.unit, price_level_id: B.retail, shop_id: null, price_mmk: 1, is_active: true }));
    await reject("A ADMIN price_levels insert with org_id=B", A.admin.from("price_levels").insert({ id: `qa-g3-x3-${ts}`, code: `qa-g3-x3`, name: "QA X3", is_default: false, is_active: true, sort_order: 50, org_id: B.orgId }));
    await reject("A ADMIN product insert with org_id=B", A.admin.from("products").insert({ id: `qa-g3-x4-${ts}`, name: "QA X4", category: "QA", unit_type: "pcs", price_mmk: 1, is_active: false, org_id: B.orgId }));
    await reject("A ADMIN repoint own unit price -> B level", A.admin.from("product_unit_prices").update({ price_level_id: B.retail }).eq("id", `qa-g3a-pup-${ts}`).select("id"));
    await reject("A ADMIN move own level to org B", A.admin.from("price_levels").update({ org_id: B.orgId }).eq("id", A.retail).select("id"));
    const sh = A.shift;
    const xs = await rpc(A.admin, "complete_sale", {
      p_shop_id: A.shop, p_shift_id: sh, p_payment_method: "CASH", p_paid_mmk: 10_000, p_cart_discount_pct: 0,
      p_items: [{ product_id: A.prod, qty: 1, units_per_item: 1, price_level_id: B.retail }], p_created_at: new Date().toISOString(), p_idempotency_key: uuid(),
    });
    expect(xs.error).not.toBeNull();
    notes.push(`A complete_sale with B's level id -> ${xs.error.code} "${short(xs.error.message, 60)}"`);
    expect(sql1(`SELECT count(*) FROM product_unit_prices WHERE id LIKE 'qa-g3-x%';`)).toBe("0");
    expect(sql1(`SELECT count(*) FROM price_levels WHERE id LIKE 'qa-g3-x%' OR org_id = '${B.orgId}' AND code LIKE 'qa-g3-x%';`)).toBe("0");
    expect(sql1(`SELECT count(*) FROM products WHERE id LIKE 'qa-g3-x%';`)).toBe("0");
    expect(sql1(`SELECT price_level_id FROM product_unit_prices WHERE id = 'qa-g3a-pup-${ts}';`)).toBe(A.retail);
    expect(sql1(`SELECT org_id FROM price_levels WHERE id = '${A.retail}';`)).toBe(A.orgId);
    expect(sql1(`SELECT count(*) FROM sales s WHERE s.shop_id = '${A.shop}';`)).toBe("1");
    ev.pass("3 cross-org price refs", `${notes.join("; ")}; DB: 0 qa-g3-x rows, A's unit price still on A Retail, A Retail still in A, A sales=1`);
  });

  // =========================================================================
  it("4. catalog / price isolation between the two QA orgs (reads [] / 0 rows affected)", async () => {
    const notes: string[] = [];
    const fp = () => sql1(`SELECT md5(string_agg(z::text, '|' ORDER BY z::text)) FROM (
      SELECT p::text AS z FROM price_levels p WHERE org_id IN ('${A.orgId}', '${B.orgId}')
      UNION ALL SELECT x::text FROM products x WHERE org_id IN ('${A.orgId}', '${B.orgId}')
      UNION ALL SELECT u::text FROM product_units u WHERE product_id IN ('${A.prod}', '${B.prod}')
      UNION ALL SELECT q::text FROM product_unit_prices q WHERE product_unit_id IN ('${A.unit}', '${B.unit}')) t;`);
    const fp0 = fp();
    for (const [x, y] of [[A, B], [B, A]] as const) {
      const reads = [
        await x.admin.from("price_levels").select("id").eq("org_id", y.orgId),
        await x.admin.from("price_levels").select("id").eq("id", y.retail),
        await x.admin.from("products").select("id").eq("id", y.prod),
        await x.admin.from("product_units").select("id").eq("id", y.unit),
        await x.admin.from("product_unit_prices").select("id").in("product_unit_id", [y.unit]),
        await x.admin.from("organizations").select("id").eq("id", y.orgId),
      ];
      for (const r of reads) { expect(r.error).toBeNull(); expect(r.data).toEqual([]); }
      const own = await x.admin.from("price_levels").select("id");
      expect(own.data!.every((r: any) => r.id !== y.retail)).toBe(true);
      expect(own.data!.length).toBe(3);
      const upd = await x.admin.from("price_levels").update({ name: "QA hacked" }).eq("id", y.retail).select("id");
      const del = await x.admin.from("price_levels").delete().eq("id", y.retail).select("id");
      const upP = await x.admin.from("products").update({ name: "QA hacked" }).eq("id", y.prod).select("id");
      const delU = await x.admin.from("product_units").delete().eq("id", y.unit).select("id");
      for (const r of [upd, del, upP, delU]) expect(r.error !== null || r.data!.length === 0).toBe(true);
      notes.push(`${x.key.toUpperCase()}->${y.key.toUpperCase()}: reads price_levels(org)/level/product/unit/unit_prices/org = [] x6; own levels visible=${own.data!.length}; update level/delete level/update product/delete unit -> ${[upd, del, upP, delU].map((r) => r.error ? r.error.code : `${r.data!.length} rows`).join("/")}`);
    }
    const realPl = await A.admin.from("price_levels").select("id").eq("org_id", REAL_ORG);
    const realPup = await A.admin.from("product_unit_prices").select("id").limit(5);
    expect(realPl.data).toEqual([]);
    expect(realPup.data!.every((r: any) => r.id === `qa-g3a-pup-${ts}`)).toBe(true);
    expect(fp()).toBe(fp0);
    ev.pass("4 catalog/price isolation", `${notes.join("; ")}; A reads real org price_levels=[]; A sees only its own unit price; DB fingerprint of both orgs' levels/products/units/prices unchanged`);
  });

  // =========================================================================
  it("5. storage (078): own-org writes only; legacy shape for own product; no cross-org manage; anon lists nothing; real images intact", async () => {
    const notes: string[] = [];
    const own = (o: Org) => `org/${o.orgId}/products/${o.prod}/qa-g3-${ts}.webp`;
    const legacy = (o: Org) => `products/${o.prod}/qa-g3-legacy-${ts}.webp`;
    const tryUp = async (o: Org, path: string, upsert = false) => {
      const r = await st(o.admin).upload(path, TINY_WEBP, { contentType: "image/webp", upsert });
      if (!r.error) uploaded.add(path);
      return r;
    };
    // allowed
    for (const o of [A, B]) {
      const r1 = await tryUp(o, own(o), true);
      expect(r1.error, `${o.key} own org path: ${r1.error?.message}`).toBeNull();
      const r2 = await tryUp(o, legacy(o));
      expect(r2.error, `${o.key} legacy own product: ${r2.error?.message}`).toBeNull();
      expect(objRow(own(o)).endsWith(o.adminAuth)).toBe(true);
      expect(objRow(legacy(o)).endsWith(o.adminAuth)).toBe(true);
    }
    notes.push(`own org/<org>/products/<own product>/x (upsert like the app) and legacy products/<own product>/x -> ok for A and B; owner_id = uploader`);
    // denied
    const denied: [string, string][] = [
      ["A -> org/<B>/products/<B prod>/x", `org/${B.orgId}/products/${B.prod}/qa-g3-x-${ts}.webp`],
      ["A -> org/<A>/products/<B prod>/x", `org/${A.orgId}/products/${B.prod}/qa-g3-x-${ts}.webp`],
      ["A -> legacy products/<B prod>/x", `products/${B.prod}/qa-g3-x-${ts}.webp`],
      ["A -> org/<A>/<bad shape>", `org/${A.orgId}/qa-g3-x-${ts}.webp`],
      ["A -> org/<A>/temp/<no session>", `org/${A.orgId}/temp/pimg-qa-g3-${ts}`],
      ["A -> real org prefix", `org/${REAL_ORG}/products/qa-g3-x-${ts}/x.webp`],
    ];
    for (const [what, path] of denied) {
      const r = await tryUp(A, path, true);
      expect(r.error, `${what} must be denied`).not.toBeNull();
      expect(objCount(path)).toBe("0");
      notes.push(`${what} -> denied (${(r.error as any)?.statusCode ?? (r.error as any)?.status ?? ""} "${short(r.error!.message, 50)}")`);
    }
    // overwrite / update / delete / move another org's object -> denied, object intact
    for (const [x, y] of [[A, B], [B, A]] as const) {
      const before = objRow(own(y));
      const over = await st(x.admin).upload(own(y), Buffer.from("QA overwrite"), { contentType: "image/webp", upsert: true });
      const upd = await st(x.admin).update(own(y), Buffer.from("QA update"), { contentType: "image/webp" });
      const rm = await st(x.admin).remove([own(y), legacy(y)]);
      const mv = await st(x.admin).move(own(y), `org/${x.orgId}/products/${x.prod}/stolen-${ts}.webp`);
      expect(over.error).not.toBeNull();
      expect(upd.error).not.toBeNull();
      expect(rm.data ?? []).toEqual([]);
      expect(mv.error).not.toBeNull();
      expect(objRow(own(y))).toBe(before);
      expect(objCount(legacy(y))).toBe("1");
      const chk = await svc.storage.from(BUCKET).download(own(y));
      expect(sha(await chk.data!.arrayBuffer())).toBe(sha(TINY_WEBP));
      notes.push(`${x.key.toUpperCase()} on ${y.key.toUpperCase()}'s objects: upsert "${short(over.error!.message, 40)}", update "${short(upd.error!.message, 40)}", remove -> [], move "${short(mv.error!.message, 40)}"; row (name|size|version|updated_at|owner) unchanged, sha256 intact`);
    }
    // read (authenticated select): own org only
    for (const [x, y] of [[A, B], [B, A]] as const) {
      const vis = asUser(x.adminAuth, `SELECT 'R|' || (SELECT count(*) FROM storage.objects WHERE name IN ('${own(x)}', '${legacy(x)}')) || '/' || (SELECT count(*) FROM storage.objects WHERE name IN ('${own(y)}', '${legacy(y)}')) || '/' || (SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}');`);
      expect(vis[0]).toBe("2/0/2");
      const lOwn = await st(x.admin).list(`org/${x.orgId}/products/${x.prod}`);
      const lOther = await st(x.admin).list(`org/${y.orgId}/products/${y.prod}`);
      const lLegacyOther = await st(x.admin).list(`products/${y.prod}`);
      const lTemp = await st(x.admin).list("temp", { limit: 1000 });
      expect(lOwn.data!.length).toBe(1);
      expect(lOther.data ?? []).toEqual([]);
      expect(lLegacyOther.data ?? []).toEqual([]);
      expect(lTemp.data ?? []).toEqual([]);
      notes.push(`${x.key.toUpperCase()} under RLS: own objects/other's/all visible = ${vis[0]}; API list own folder=${lOwn.data!.length}, other org folder=[], other legacy folder=[], legacy temp/ (real org)=[]`);
    }
    // anon
    for (const prefix of ["", "org", `org/${A.orgId}/products/${A.prod}`, "temp", "products"]) {
      const l = await anon.storage.from(BUCKET).list(prefix);
      expect(l.data ?? [], `anon list "${prefix}"`).toEqual([]);
    }
    const anonUp = await anon.storage.from(BUCKET).upload(`org/${A.orgId}/products/${A.prod}/anon-${ts}.webp`, TINY_WEBP, { contentType: "image/webp" });
    expect(anonUp.error).not.toBeNull();
    notes.push(`anon list ("", org, A folder, temp, products) -> [] x5; anon upload into A folder -> denied`);

    // legacy real images: 5 real products' public image_url -> 200 + sha256 == migration manifest
    const manifestPath = process.env.LIVE_STORAGE_MANIFEST ?? `${homedir()}/shwephala-migration/20261011T2347Z/storage-manifest.sha256`;
    const manifest = new Map(readFileSync(manifestPath, "utf8").trim().split("\n").map((l) => { const [h, p] = l.split(/\s+/); return [p, h] as const; }));
    const realProds = (await svc.from("products").select("id, image_url").eq("org_id", REAL_ORG).not("image_url", "is", null).order("id").limit(5)).data!;
    expect(realProds).toHaveLength(5);
    const realPaths: string[] = [];
    for (const p of realProds) {
      const path = String(p.image_url).split(`/object/public/${BUCKET}/`)[1];
      realPaths.push(path);
      const res = await fetch(p.image_url);
      expect(res.status).toBe(200);
      const h = sha(await res.arrayBuffer());
      expect(h, `sha256 of ${path}`).toBe(manifest.get(path));
    }
    notes.push(`5 real products (${realProds.map((p) => p.id).join(",")}) public image_url -> 200 x5, sha256 == storage-manifest x5`);

    // QA user cannot manage the real org's legacy objects. SQL proof FIRST (read-only, ROLLBACK),
    // then the API attempts - which only run if RLS demonstrably refuses them.
    const target = realPaths[0];
    const proof = asUser(A.adminAuth, `SELECT 'R|' || (SELECT count(*) FROM storage.objects WHERE name = '${target}') || '|' || COALESCE(public.app_storage_object_in_my_org('${target}')::text, 'null') || '|' || public.app_storage_can_write_path('${target}') || '|' || COALESCE((SELECT (bucket_id = '${BUCKET}' AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update')) AND COALESCE(public.app_storage_object_in_my_org(name), public.app_storage_owner_in_org(owner_id, owner)))::text FROM storage.objects WHERE name = '${target}'), 'not-visible');`);
    // visible=0, in_my_org=false, can_write=false, manage-expression not even evaluable (row invisible)
    expect(proof[0]).toBe("0|false|false|not-visible");
    const exprAsSuper = sql1(`BEGIN; SELECT set_config('request.jwt.claims', '{"sub":"${A.adminAuth}","role":"authenticated"}', true), set_config('request.jwt.claim.sub', '${A.adminAuth}', true); SELECT 'R|' || (COALESCE(public.app_storage_object_in_my_org(name), public.app_storage_owner_in_org(owner_id, owner)))::text FROM storage.objects WHERE name = '${target}'; ROLLBACK;`).split("\n").find((l) => l.startsWith("R|"));
    expect(exprAsSuper).toBe("R|false");
    const rowBefore = objRow(target);
    const rm = await st(A.admin).remove([target]);
    const up = await st(A.admin).update(target, Buffer.from("QA"), { contentType: "image/webp" });
    const ov = await st(A.admin).upload(target, Buffer.from("QA"), { contentType: "image/webp", upsert: true });
    const mv = await st(A.admin).move(target, `org/${A.orgId}/products/${A.prod}/stolen-real-${ts}.webp`);
    expect(rm.data ?? []).toEqual([]);
    expect(up.error).not.toBeNull();
    expect(ov.error).not.toBeNull();
    expect(mv.error).not.toBeNull();
    expect(objRow(target)).toBe(rowBefore);
    const again = await fetch(publicUrl(target));
    expect(sha(await again.arrayBuffer())).toBe(manifest.get(target));
    notes.push(`QA ADMIN A vs real object ${target}: SQL (ROLLBACK, as A) visible|in_my_org|can_write|manage-expr = ${proof[0]}, manage expression on the row = ${exprAsSuper!.slice(2)}; API remove -> [], update "${short(up.error!.message, 40)}", upsert "${short(ov.error!.message, 40)}", move "${short(mv.error!.message, 40)}"; row unchanged, public sha256 still == manifest`);

    // The real org's ADMIN WOULD be authorized (read-only evaluation, ROLLBACK; nothing modified)
    const realAdmin = sql1(`SELECT auth_id FROM users WHERE org_id = '${REAL_ORG}' AND role = 'ADMIN' AND is_active ORDER BY id LIMIT 1;`);
    const legacyProd = sql1(`SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name LIKE 'products/%' AND public.app_storage_object_org(name) = '${REAL_ORG}' LIMIT 1;`);
    const realEval = asUser(realAdmin, `SELECT 'R|' || name || '|' || (SELECT count(*) FROM storage.objects o2 WHERE o2.name = o.name) || '|' || COALESCE(public.app_storage_object_in_my_org(name)::text, 'null') || '|' || (public.app_has_perm('product:create') OR public.app_has_perm('product:update')) || '|' || (bucket_id = '${BUCKET}' AND (public.app_has_perm('product:create') OR public.app_has_perm('product:update')) AND COALESCE(public.app_storage_object_in_my_org(name), public.app_storage_owner_in_org(owner_id, owner))) FROM storage.objects o WHERE name = '${target}';
SELECT 'R|visible_to_real_admin=' || count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}';
SELECT 'R|can_write_new_own_path=' || public.app_storage_can_write_path('org/${REAL_ORG}/products/${realProds[0].id}/x.webp') || ' can_write_qa_path=' || public.app_storage_can_write_path('org/${A.orgId}/products/${A.prod}/x.webp');`);
    expect(realEval[0]).toBe(`${target}|1|true|true|true`);
    expect(realEval[2]).toBe("can_write_new_own_path=true can_write_qa_path=false");
    notes.push(`real ADMIN (simulated JWT sub, ROLLBACK, no write) on ${target}: name|visible|in_my_org|perm|update/delete USING = ${realEval[0]}; ${realEval[1]} of the bucket (557 path-resolved + QA objects excluded; the 17 unresolved orphans stay invisible); ${realEval[2]}; products/ legacy object in org: ${legacyProd || "<none - the only products/ object is the orphan>"}`);
    ev.pass("5 storage 078", notes.join(" || "));
  });

  // =========================================================================
  it("6. phone upload end to end (legitimate path) + wrong product/org, foreign URL/path, expired, cancelled", async () => {
    const notes: string[] = [];
    const create = async (o: Org) => ok(await rpc(o.admin, "create_product_image_upload_session", { p_shop_id: o.shop, p_product_id: o.prod }), `${o.key} create session`);
    const sessRow = (id: string) => sql1(`SELECT status || '|' || storage_path || '|' || COALESCE(public_url, '<null>') || '|' || COALESCE(bytes::text, '<null>') || '|' || (signed_upload_token IS NOT NULL) FROM product_image_upload_sessions WHERE id = '${id}';`);
    const completeArgs = (s: any, over: Record<string, unknown> = {}) => ({ p_token: s.token, p_storage_path: s.storagePath, p_public_url: publicUrl(s.storagePath), p_bytes: TINY_WEBP.length, p_mime_type: "image/webp", ...over });

    // ---- legitimate flow ------------------------------------------------------
    const s1 = await create(A);
    expect(s1.storagePath).toBe(`org/${A.orgId}/temp/${s1.sessionId}`);
    const signed = await st(A.admin).createSignedUploadUrl(s1.storagePath);
    expect(signed.error, `sign: ${signed.error?.message}`).toBeNull();
    const att = ok(await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: s1.sessionId, p_signed_upload_token: signed.data!.token }), "attach");
    expect(att.status).toBe("PENDING");
    const g = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: s1.token }), "by_token");
    expect(Object.keys(g).sort().join(",")).toBe(PHONE_FIELDS);
    expect(g.uploadToken).toBe(signed.data!.token);
    expect(g.storagePath).toBe(s1.storagePath);
    const up = await anon.storage.from(BUCKET).uploadToSignedUrl(g.storagePath, g.uploadToken, TINY_WEBP, { contentType: "image/webp", cacheControl: "31536000" });
    expect(up.error, `phone upload: ${up.error?.message}`).toBeNull();
    uploaded.add(s1.storagePath);
    const pubUrl = anon.storage.from(BUCKET).getPublicUrl(g.storagePath).data.publicUrl;
    const done = ok(await rpc(anon, "complete_product_image_upload_session", completeArgs(s1, { p_public_url: pubUrl })), "complete");
    expect(done).toMatchObject({ sessionId: s1.sessionId, status: "COMPLETED", storagePath: s1.storagePath, publicUrl: pubUrl });
    const r1 = sessRow(s1.sessionId);
    expect(r1).toBe(`COMPLETED|${s1.storagePath}|${pubUrl}|${TINY_WEBP.length}|false`);
    const o1 = objRow(s1.storagePath);
    expect(o1.endsWith(A.adminAuth)).toBe(true);
    const pubGet = await fetch(pubUrl);
    expect(pubGet.status).toBe(200);
    expect(sha(await pubGet.arrayBuffer())).toBe(sha(TINY_WEBP));
    const poll = ok(await rpc(A.admin, "get_product_image_upload_session_status", { p_session_id: s1.sessionId }), "status");
    expect(poll.status).toBe("COMPLETED");
    // a completed object cannot be overwritten with the same token (upsert false)
    const again = await anon.storage.from(BUCKET).uploadToSignedUrl(g.storagePath, g.uploadToken, Buffer.from("QA second"), { contentType: "image/webp" });
    expect(again.error).not.toBeNull();
    notes.push(`legit: create -> ${s1.storagePath}; desktop createSignedUploadUrl ok; attach -> PENDING; anon by_token -> 8 fields, same token/path; anon uploadToSignedUrl ok; complete(getPublicUrl) -> COMPLETED; row status|path|url|bytes|token_kept = ${r1.replace(cfg.url, "<base>")}; object owner = A ADMIN auth uid; public GET 200 sha ok; desktop poll COMPLETED; re-upload with same token -> "${short(again.error!.message, 40)}"`);

    // ---- wrong product / wrong org --------------------------------------------
    const nSess = sql1(`SELECT count(*) FROM product_image_upload_sessions;`);
    const xProd = await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: B.prod });
    const xShop = await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: B.shop, p_product_id: A.prod });
    expect(String(xProd.error?.message)).toMatch(NOT_IN_ORG);
    expect(String(xShop.error?.message)).toMatch(NOT_IN_ORG);
    expect(sql1(`SELECT count(*) FROM product_image_upload_sessions;`)).toBe(nSess);
    const sB = await create(B);
    const signOther = await st(A.admin).createSignedUploadUrl(sB.storagePath);
    expect(signOther.error).not.toBeNull();
    const attOther = await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: sB.sessionId, p_signed_upload_token: "x" });
    expect(attOther.error?.message).toBe("Upload session not found");
    const signFake = await st(A.admin).createSignedUploadUrl(`org/${A.orgId}/temp/pimg-${randomBytes(16).toString("hex")}`);
    expect(signFake.error).not.toBeNull();
    notes.push(`A session for B's product -> "${short(xProd.error.message, 60)}"; for B's shop -> "${short(xShop.error.message, 60)}"; sessions ${nSess}->${nSess}; A signs B's session path -> "${short(signOther.error!.message, 50)}"; A attaches to B's session -> "${attOther.error.message}"; A signs an own-prefix temp path with no session -> "${short(signFake.error!.message, 50)}"`);

    // ---- completion with another session's URL / a different path --------------
    const s2 = await create(A);
    const s3 = await create(A);
    const cUrl = await rpc(anon, "complete_product_image_upload_session", completeArgs(s2, { p_public_url: publicUrl(s3.storagePath) }));
    expect(cUrl.error?.message).toBe(URL_MISMATCH);
    const cUrlB = await rpc(anon, "complete_product_image_upload_session", completeArgs(s2, { p_public_url: publicUrl(sB.storagePath) }));
    expect(cUrlB.error?.message).toBe(URL_MISMATCH);
    const cPath = await rpc(anon, "complete_product_image_upload_session", completeArgs(s2, { p_storage_path: s3.storagePath, p_public_url: publicUrl(s3.storagePath) }));
    expect(cPath.error?.message).toBe(PATH_MISMATCH);
    const cLegacy = await rpc(anon, "complete_product_image_upload_session", completeArgs(s2, { p_storage_path: `temp/${s2.sessionId}`, p_public_url: publicUrl(`temp/${s2.sessionId}`) }));
    expect(cLegacy.error?.message).toBe(PATH_MISMATCH);
    expect(sessRow(s2.sessionId).startsWith("PENDING|")).toBe(true);
    notes.push(`complete s2 with s3's URL -> "${cUrl.error.message}"; with B session's URL -> "${cUrlB.error.message}"; with s3's path -> "${cPath.error.message}"; with legacy temp/<s2> -> "${cLegacy.error.message}"; s2 still PENDING`);

    // ---- expired ---------------------------------------------------------------
    const s4 = await create(A);
    const sig4 = await st(A.admin).createSignedUploadUrl(s4.storagePath);
    expect(sig4.error).toBeNull();
    ok(await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: s4.sessionId, p_signed_upload_token: sig4.data!.token }), "attach s4");
    const ex = await svc.from("product_image_upload_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", s4.sessionId).select("id");
    expect(ex.data).toHaveLength(1);
    const sig4b = await st(A.admin).createSignedUploadUrl(s4.storagePath);
    const att4 = await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: s4.sessionId, p_signed_upload_token: "qa-g3-new-token" });
    const row4a = sql1(`SELECT status || '|' || (signed_upload_token = '${sig4.data!.token}') FROM product_image_upload_sessions WHERE id = '${s4.sessionId}';`);
    const c4 = await rpc(anon, "complete_product_image_upload_session", completeArgs(s4));
    const g4 = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: s4.token }), "by_token s4");
    const c4b = await rpc(anon, "complete_product_image_upload_session", completeArgs(s4));
    expect(sig4b.error).not.toBeNull();
    expect(att4.error?.message).toBe(INACTIVE);
    expect(row4a).toBe("PENDING|true"); // 079: the refused attach wrote nothing (old token kept, derivably expired)
    expect(c4.error?.message).toBe(INACTIVE);
    expect(g4.status).toBe("EXPIRED");
    expect(g4.uploadToken).toBeNull();
    expect(c4b.error?.message).toBe(INACTIVE);
    // residual (documented 2c): the token issued while live can still write its one object until its exp
    const late = await anon.storage.from(BUCKET).uploadToSignedUrl(s4.storagePath, sig4.data!.token, TINY_WEBP, { contentType: "image/webp" });
    if (!late.error) uploaded.add(s4.storagePath);
    const c4c = await rpc(anon, "complete_product_image_upload_session", completeArgs(s4));
    expect(c4c.error?.message).toBe(INACTIVE);
    expect(sql1(`SELECT status FROM product_image_upload_sessions WHERE id = '${s4.sessionId}';`)).toBe("EXPIRED");
    notes.push(`expired s4: new createSignedUploadUrl -> "${short(sig4b.error!.message, 50)}"; attach -> "${att4.error.message}", row status|old token kept = ${row4a} (no write); complete -> "${c4.error.message}"; by_token -> ${g4.status}, uploadToken=${g4.uploadToken}; complete again -> rejected; residual: upload with the token issued BEFORE expiry -> ${late.error ? `rejected "${short(late.error.message, 40)}"` : "ACCEPTED (stateless JWT within its 60 s; object never attached)"}; complete after that -> "${c4c.error.message}"`);

    // ---- cancelled ---------------------------------------------------------------
    const s5 = await create(A);
    const sig5 = await st(A.admin).createSignedUploadUrl(s5.storagePath);
    ok(await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: s5.sessionId, p_signed_upload_token: sig5.data!.token }), "attach s5");
    ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: s5.sessionId }), "cancel s5");
    const sig5b = await st(A.admin).createSignedUploadUrl(s5.storagePath);
    const att5 = await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: s5.sessionId, p_signed_upload_token: "qa-g3-new-token" });
    const g5 = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: s5.token }), "by_token s5");
    const c5 = await rpc(anon, "complete_product_image_upload_session", completeArgs(s5));
    expect(sig5b.error).not.toBeNull();
    expect(att5.error?.message).toBe(INACTIVE);
    expect(g5.status).toBe("CANCELED");
    expect(g5.uploadToken).toBeNull();
    expect(c5.error?.message).toBe(INACTIVE);
    const row5 = sql1(`SELECT status || '|' || COALESCE(signed_upload_token, '<null>') || '|' || COALESCE(public_url, '<null>') FROM product_image_upload_sessions WHERE id = '${s5.sessionId}';`);
    expect(row5).toBe("CANCELED|<null>|<null>");
    notes.push(`cancelled s5: createSignedUploadUrl -> "${short(sig5b.error!.message, 50)}"; attach -> "${att5.error.message}"; by_token -> ${g5.status}, uploadToken=${g5.uploadToken}; complete -> "${c5.error.message}"; row ${row5}`);
    ev.pass("6 phone upload flow", notes.join(" || "));
  });

  // =========================================================================
  it("7. signed upload token lifetime (storage default, UPLOAD_SIGNED_URL_EXPIRATION_TIME unset): used within the window works, after 65 s rejected; desktop re-issue works", async () => {
    const notes: string[] = [];
    const sa = ok(await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: A.prod }), "session a");
    const sb = ok(await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: A.prod }), "session b");
    const ta = await st(A.admin).createSignedUploadUrl(sa.storagePath);
    const tb = await st(A.admin).createSignedUploadUrl(sb.storagePath);
    const t0 = Date.now();
    expect(ta.error).toBeNull();
    expect(tb.error).toBeNull();
    ok(await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: sa.sessionId, p_signed_upload_token: ta.data!.token }), "attach a");
    ok(await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: sb.sessionId, p_signed_upload_token: tb.data!.token }), "attach b");
    const pa = jwtPayload(ta.data!.token);
    const pb = jwtPayload(tb.data!.token);
    const lifetime = pa.exp - pa.iat;
    notes.push(`token JWT claims: exp-iat = ${lifetime} s (a), ${pb.exp - pb.iat} s (b); payload keys {${Object.keys(pa).sort().join(",")}}; url claim = ${pa.url === `${BUCKET}/${sa.storagePath}` ? "bucket/<session path>" : pa.url}`);
    const put = async (path: string, token: string) => {
      const res = await fetch(`${cfg.url}/storage/v1/object/upload/sign/${BUCKET}/${path}?token=${encodeURIComponent(token)}`, {
        method: "PUT", headers: { apikey: cfg.anonKey, "content-type": "image/webp", "x-upsert": "false", "cache-control": "max-age=31536000" }, body: TINY_WEBP,
      });
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    };
    // a: inside the window (~50 s after issue)
    await sleep(Math.max(0, t0 + 50_000 - Date.now()));
    const inWin = await put(sa.storagePath, ta.data!.token);
    const tIn = Math.round((Date.now() - t0) / 1000);
    if (inWin.status === 200) uploaded.add(sa.storagePath);
    expect(inWin.status).toBe(200);
    ok(await rpc(anon, "complete_product_image_upload_session", { p_token: sa.token, p_storage_path: sa.storagePath, p_public_url: publicUrl(sa.storagePath), p_bytes: TINY_WEBP.length, p_mime_type: "image/webp" }), "complete a");
    notes.push(`upload with token a at t+${tIn} s -> HTTP ${inWin.status}; completed`);
    // b: after 65 s
    await sleep(Math.max(0, t0 + 65_000 - Date.now()));
    const late = await put(sb.storagePath, tb.data!.token);
    const tLate = Math.round((Date.now() - t0) / 1000);
    if (late.status === 200) uploaded.add(sb.storagePath);
    expect(late.status).not.toBe(200);
    expect(objCount(sb.storagePath)).toBe("0");
    notes.push(`upload with token b at t+${tLate} s -> HTTP ${late.status} body ${late.body}; no object written`);
    // the session is still PENDING (10 min TTL): the desktop can re-issue a fresh token, the phone re-reads it
    const tb2 = await st(A.admin).createSignedUploadUrl(sb.storagePath);
    expect(tb2.error).toBeNull();
    ok(await rpc(A.admin, "attach_product_image_upload_session_token", { p_session_id: sb.sessionId, p_signed_upload_token: tb2.data!.token }), "re-attach b");
    const gb = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: sb.token }), "by_token b");
    expect(gb.uploadToken).toBe(tb2.data!.token);
    expect(gb.uploadToken).not.toBe(tb.data!.token);
    const fresh = await anon.storage.from(BUCKET).uploadToSignedUrl(gb.storagePath, gb.uploadToken, TINY_WEBP, { contentType: "image/webp" });
    expect(fresh.error).toBeNull();
    uploaded.add(sb.storagePath);
    const cb = ok(await rpc(anon, "complete_product_image_upload_session", { p_token: sb.token, p_storage_path: sb.storagePath, p_public_url: publicUrl(sb.storagePath), p_bytes: TINY_WEBP.length, p_mime_type: "image/webp" }), "complete b");
    expect(cb.status).toBe("COMPLETED");
    notes.push(`same PENDING session b: desktop createSignedUploadUrl again + attach (2nd token accepted) -> by_token returns the NEW token; phone upload with it -> ok; complete -> ${cb.status}`);
    ev.add("7 signed token lifetime", "PASS", `MEASURED EXPIRY: ${lifetime} s (JWT exp-iat), bracketed live: ok at t+${tIn} s, rejected at t+${tLate} s || ${notes.join(" || ")}`);
  });

  // =========================================================================
  it("8. 080: a completion URL on a DIFFERENT host is ignored - refused while the object is missing, then COMPLETED with the trusted URL only", async () => {
    // 079 stored this URL (host not checked, object not required; recorded
    // live 2026-10-13). 080: the object must exist, and what is stored,
    // returned and polled is app_config origin + bucket + session path.
    const trusted = sql1(`SELECT value FROM public.app_config WHERE key = 'supabase_public_url';`);
    const s = ok(await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: A.prod }), "session");
    const foreign = `https://example.invalid/storage/v1/object/public/${BUCKET}/${s.storagePath}`;
    const args = { p_token: s.token, p_storage_path: s.storagePath, p_public_url: foreign, p_bytes: TINY_WEBP.length, p_mime_type: "image/webp" };
    const r0 = await rpc(anon, "complete_product_image_upload_session", args);
    expect(r0.error?.message).toBe("Uploaded image was not found in storage");
    expect(sql1(`SELECT status || '|' || COALESCE(public_url, '<null>') FROM product_image_upload_sessions WHERE id = '${s.sessionId}';`)).toBe("PENDING|<null>");
    const up = await svc.storage.from(BUCKET).upload(s.storagePath, TINY_WEBP, { contentType: "image/webp" });
    expect(up.error, `upload: ${up.error?.message}`).toBeNull();
    uploaded.add(s.storagePath);
    const r = await rpc(anon, "complete_product_image_upload_session", args);
    const derived = `${trusted}/storage/v1/object/public/${BUCKET}/${s.storagePath}`;
    expect(r.error).toBeNull();
    expect(r.data.status).toBe("COMPLETED");
    expect(r.data.publicUrl).toBe(derived);
    const row = sql1(`SELECT status || '|' || COALESCE(public_url, '<null>') FROM product_image_upload_sessions WHERE id = '${s.sessionId}';`);
    expect(row).toBe(`COMPLETED|${derived}`);
    const poll = ok(await rpc(A.admin, "get_product_image_upload_session_status", { p_session_id: s.sessionId }), "status");
    expect(poll.publicUrl).toBe(derived);
    const byToken = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: s.token }), "by_token");
    expect(byToken.publicUrl).toBe(derived);
    expect(sql1(`SELECT count(*) FROM product_image_upload_sessions WHERE id = '${s.sessionId}' AND to_jsonb(product_image_upload_sessions)::text LIKE '%example.invalid%';`)).toBe("0");
    expect(trusted).toBe(cfg.url);
    ev.pass("8 080: foreign host ignored", `complete with https://example.invalid/<exact session path> before the upload -> "${r0.error.message}", row PENDING|<null>; after the object exists -> COMPLETED; returned / stored / desktop poll / by_token publicUrl = <app_config origin>/storage/v1/object/public/${BUCKET}/<session path> (x4); "example.invalid" nowhere in the row`);
  });

  // =========================================================================
  it("9. anonymous surface: exactly the three anon functions; wrong token rejected; only the documented fields", async () => {
    const notes: string[] = [];
    const anonFns = sql1(`SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE');`);
    expect(anonFns).toBe("app_setup_needed,complete_product_image_upload_session,get_product_image_upload_session_by_token");
    notes.push(`anon EXECUTE (pg_proc, public) = ${anonFns}`);
    const calls: [string, Record<string, unknown>][] = [
      ["create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: A.prod }],
      ["attach_product_image_upload_session_token", { p_session_id: "x", p_signed_upload_token: "x" }],
      ["get_product_image_upload_session_status", { p_session_id: "x" }],
      ["cancel_product_image_upload_session", { p_session_id: "x" }],
      ["app_seed_default_price_levels", { p_org_id: A.orgId }],
      ["app_storage_can_write_path", { p_name: "temp/x" }],
      ["app_storage_object_in_my_org", { p_name: "temp/x" }],
      ["app_storage_object_org", { p_name: "temp/x" }],
      ["bootstrap_first_admin", {}],
    ];
    const denied: string[] = [];
    for (const [fn, args] of calls) {
      const r = await rpc(anon, fn, args);
      expect(r.error?.code, `anon ${fn}`).toBe("42501");
      denied.push(`${fn}=${r.error.code}`);
    }
    notes.push(`anon denied: ${denied.join(" ")}`);
    const setup = await rpc(anon, "app_setup_needed", {});
    expect(setup.data).toBe(false);
    // wrong tokens
    const s = ok(await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: A.prod }), "session");
    const hash = sql1(`SELECT token_hash FROM product_image_upload_sessions WHERE id = '${s.sessionId}';`);
    const wrong = [randomBytes(64).toString("hex"), s.token.slice(0, -4) + (s.token.endsWith("0000") ? "1111" : "0000"), "short", hash, s.sessionId];
    for (const t of wrong) {
      const r = await rpc(anon, "get_product_image_upload_session_by_token", { p_token: t });
      expect(r.error?.message).toBe("Invalid upload link");
      expect(r.data).toBeNull();
      const c = await rpc(anon, "complete_product_image_upload_session", { p_token: t, p_storage_path: s.storagePath, p_public_url: publicUrl(s.storagePath), p_bytes: 26, p_mime_type: "image/webp" });
      expect(c.error?.message).toBe("Invalid upload link");
    }
    expect(sql1(`SELECT status FROM product_image_upload_sessions WHERE id = '${s.sessionId}';`)).toBe("PENDING");
    notes.push(`by_token / complete with random 128-hex, one-char-off token, short, stored hash, session id -> "Invalid upload link" x5 each; session still PENDING`);
    const g = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: s.token }), "by_token");
    const keys = Object.keys(g).sort().join(",");
    expect(keys).toBe(PHONE_FIELDS);
    const body = JSON.stringify(g);
    for (const leak of [A.adminId, A.shop, A.prod, A.name, A.email, s.token, hash]) expect(body).not.toContain(leak);
    expect(g.storagePath).toBe(`org/${A.orgId}/temp/${s.sessionId}`);
    notes.push(`valid by_token keys = ${keys}; no creator/shop/product/org name/email/token/hash in the body; storagePath carries the org id (${A.orgId}) by design`);
    ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: s.sessionId }), "cancel");
    ev.pass("9 anonymous surface", notes.join(" || "));
  });
});
