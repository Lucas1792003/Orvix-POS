/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Phase G LIVE two-organization security suite — runs against the
// self-hosted Supabase stack (lucashome, schema 076: org isolation 067-073,
// remaining fixes 074-076 - see also phase-g2.live.test.ts)
// through the public API with the real @supabase/supabase-js client.
//
// Skipped unless LIVE_SUPABASE_URL is set. Required env:
//   LIVE_SUPABASE_URL, LIVE_ANON_KEY, LIVE_SERVICE_KEY
// Optional: LIVE_SSH_HOST (lucashome), LIVE_STACK_DIR, LIVE_STORAGE_MANIFEST
//   (default ~/shwephala-migration/20261011T2347Z/storage-manifest.sha256)
//
// Two QA organizations:
//   A  `qa-org-<ts>`   seeded by supabase/tests/phase-d/live/seed.sql (SQL,
//                      replica mode) + catalog/operations through the API.
//   B  `org-<uuid>`    onboarded through the TRUSTED path: the deployed
//                      `platform-console` edge function, action
//                      create_organization, called by a QA platform admin
//                      (auth user via GoTrue signup + a platform_admins row
//                      inserted over SQL). Everything else in org B (shops,
//                      staff, catalog, stock, purchasing, sales) is created by
//                      org B's own users through the API, as the app would.
// Every record is identifiable (qa- ids, @qa.invalid emails, "QA " names, or
// membership in a QA organization) and is removed afterwards by
// supabase/tests/phase-d/live/cleanup.sql (+ phase-e audit_purge.sql), proven
// by verify_clean.sql. Storage objects are removed by this suite through the
// Storage API (afterAll) so the files on disk go too.
// ---------------------------------------------------------------------------
import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Evidence, liveConfig, makeClient, randomPassword, runSql, runSqlFile, createAuthUser, signedInClient,
  sleep, uuid, waitFor, type LiveConfig,
} from "./liveHelpers";
// 34-byte lossless 1x1 WebP: a real image, within 083's bucket and completion limits.
import { TINY_WEBP } from "./imageFixtures";
import { completeThroughFunction, isPost083, schemaVersion } from "./phoneCompletion";

const LIVE = Boolean(process.env.LIVE_SUPABASE_URL);
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const SEED_SQL = new URL("../../supabase/tests/phase-d/live/seed.sql", import.meta.url).pathname;
const BUCKET = "product-images";
const NOT_IN_ORG = /not found in your organization/i;
const DENIED = /not found in your organization|not permitted|permission denied|row-level security|not authorized/i;

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

interface Org {
  key: "A" | "B";
  orgId: string;
  name: string;
  shop: string; shop2: string;
  adminId: string; mgrId: string; cashId: string;
  adminAuth: string;
  emails: { admin: string; mgr: string; cash: string };
  admin: SupabaseClient; mgr: SupabaseClient; cash: SupabaseClient;
  prods: string[]; units: string[]; prices: number[];
  sup: string; supCode: string;
  cat: string; brand: string; unitType: string; priceLevel: string; pup: string; tier: string; barcode: string;
  // operations
  po: string; poDraft: string; payment: string;
  transfer: string; shift: string; sale: string; sale2: string; sale3: string;
  request: string; session: string;
  objectPath: string;
}

describe.skipIf(!LIVE)("Phase G live two-organization isolation (self-hosted stack)", () => {
  const ev = new Evidence();
  let cfg: LiveConfig;
  const ts = String(Date.now());
  const password = randomPassword();
  let svc: SupabaseClient;
  let anon: SupabaseClient;
  const A = {} as Org;
  const B = {} as Org;
  const REAL_ORG = "org-shwe-pha-lar";
  const uploaded: { client: () => SupabaseClient; path: string }[] = [];
  let platformEmail = "";
  let consoleMode = "";
  let realBefore = "";

  // ---- DB-side readers ----------------------------------------------------
  const svcRows = async (table: string, build: (q: any) => any, cols = "*"): Promise<any[]> => {
    const { data, error } = await build(svc.from(table).select(cols));
    if (error) throw new Error(`svc ${table} read failed: ${error.message}`);
    return data ?? [];
  };
  const svcCount = async (table: string, build: (q: any) => any): Promise<number> => {
    const { count, error } = await build(svc.from(table).select("*", { count: "exact", head: true }));
    if (error) throw new Error(`svc ${table} count failed: ${error.message}`);
    return count ?? 0;
  };
  const inv = async (shop: string, product: string): Promise<number> => {
    const rows = await svcRows("inventory", (q) => q.eq("shop_id", shop).eq("product_id", product), "qty_base_units");
    return rows[0]?.qty_base_units ?? NaN;
  };

  /** md5 over every row that belongs to a QA organization (both orgs), plus
   *  QA actors' idempotency keys and audit rows. Equal before/after a call
   *  => the call changed nothing in either QA org. */
  const FP_SQL = `
WITH o AS (SELECT id FROM organizations WHERE id LIKE 'qa-%' OR name LIKE 'QA %'),
s AS (SELECT id FROM shops WHERE org_id IN (SELECT id FROM o)),
u AS (SELECT id FROM users WHERE org_id IN (SELECT id FROM o)),
p AS (SELECT id FROM products WHERE org_id IN (SELECT id FROM o)),
r(t, x) AS (
  SELECT 'organizations', z::text FROM organizations z WHERE id IN (SELECT id FROM o)
  UNION ALL SELECT 'business_profile', z::text FROM business_profile z WHERE org_id IN (SELECT id FROM o)
  UNION ALL SELECT 'shops', z::text FROM shops z WHERE id IN (SELECT id FROM s)
  UNION ALL SELECT 'users', z::text FROM users z WHERE id IN (SELECT id FROM u)
  UNION ALL SELECT 'products', z::text FROM products z WHERE id IN (SELECT id FROM p)
  UNION ALL SELECT 'product_units', z::text FROM product_units z WHERE product_id IN (SELECT id FROM p)
  UNION ALL SELECT 'product_unit_prices', z::text FROM product_unit_prices z
             WHERE product_unit_id IN (SELECT id FROM product_units WHERE product_id IN (SELECT id FROM p))
  UNION ALL SELECT 'price_tiers', z::text FROM price_tiers z WHERE product_id IN (SELECT id FROM p)
  UNION ALL SELECT 'product_barcodes', z::text FROM product_barcodes z WHERE org_id IN (SELECT id FROM o)
  UNION ALL SELECT 'categories', z::text FROM categories z WHERE org_id IN (SELECT id FROM o)
  UNION ALL SELECT 'brands', z::text FROM brands z WHERE org_id IN (SELECT id FROM o)
  UNION ALL SELECT 'unit_types', z::text FROM unit_types z WHERE org_id IN (SELECT id FROM o)
  UNION ALL SELECT 'price_levels', z::text FROM price_levels z WHERE org_id IN (SELECT id FROM o)
  UNION ALL SELECT 'suppliers', z::text FROM suppliers z WHERE org_id IN (SELECT id FROM o)
  UNION ALL SELECT 'supplier_products', z::text FROM supplier_products z WHERE product_id IN (SELECT id FROM p)
  UNION ALL SELECT 'inventory', z::text FROM inventory z WHERE shop_id IN (SELECT id FROM s) OR product_id IN (SELECT id FROM p)
  UNION ALL SELECT 'inventory_movements', z::text FROM inventory_movements z WHERE shop_id IN (SELECT id FROM s)
  UNION ALL SELECT 'sales', z::text FROM sales z WHERE shop_id IN (SELECT id FROM s)
  UNION ALL SELECT 'sale_items', z::text FROM sale_items z WHERE sale_id IN (SELECT id FROM sales WHERE shop_id IN (SELECT id FROM s))
  UNION ALL SELECT 'shifts', z::text FROM shifts z WHERE shop_id IN (SELECT id FROM s)
  UNION ALL SELECT 'purchase_orders', z::text FROM purchase_orders z WHERE shop_id IN (SELECT id FROM s)
  UNION ALL SELECT 'purchase_order_items', z::text FROM purchase_order_items z
             WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE shop_id IN (SELECT id FROM s))
  UNION ALL SELECT 'supplier_payments', z::text FROM supplier_payments z WHERE shop_id IN (SELECT id FROM s)
  UNION ALL SELECT 'stock_transfers', z::text FROM stock_transfers z
             WHERE from_shop_id IN (SELECT id FROM s) OR to_shop_id IN (SELECT id FROM s)
  UNION ALL SELECT 'stock_transfer_items', z::text FROM stock_transfer_items z
             WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE from_shop_id IN (SELECT id FROM s) OR to_shop_id IN (SELECT id FROM s))
  UNION ALL SELECT 'refund_void_requests', z::text FROM refund_void_requests z WHERE shop_id IN (SELECT id FROM s)
  UNION ALL SELECT 'reprint_logs', z::text FROM reprint_logs z WHERE printed_by IN (SELECT id FROM u)
  UNION ALL SELECT 'audit_logs', z::text FROM audit_logs z WHERE actor_id IN (SELECT id FROM u) OR shop_id IN (SELECT id FROM s)
  UNION ALL SELECT 'idempotency_keys', z::text FROM idempotency_keys z WHERE actor_id IN (SELECT id FROM u)
  UNION ALL SELECT 'product_image_upload_sessions', z::text FROM product_image_upload_sessions z WHERE created_by IN (SELECT id FROM u)
)
SELECT md5(string_agg(t || ':' || x, E'\\n' ORDER BY t, x)) || ' rows=' || count(*) FROM r;`;
  const fp = (): string => runSql(cfg, FP_SQL).trim();

  /** The real organization's catalog / stock / staff shape (read-only). */
  const REAL_SQL = `
SELECT format('products=%s inventory=%s inv_qty_sum=%s users=%s shops=%s business_profile=%s price_levels=%s suppliers=%s categories=%s brands=%s unit_types=%s auth.users(non-qa)=%s storage.objects=%s',
  (SELECT count(*) FROM products WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM inventory i JOIN shops s ON s.id = i.shop_id WHERE s.org_id = '${REAL_ORG}'),
  (SELECT COALESCE(sum(qty_base_units), 0) FROM inventory i JOIN shops s ON s.id = i.shop_id WHERE s.org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM users WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM shops WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM business_profile WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM price_levels WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM suppliers WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM categories WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM brands WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM unit_types WHERE org_id = '${REAL_ORG}'),
  (SELECT count(*) FROM auth.users WHERE email NOT LIKE '%@qa.invalid'),
  (SELECT count(*) FROM storage.objects WHERE name NOT LIKE '%qa-%'))
|| ' md5=' || md5(
  (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM products z WHERE org_id = '${REAL_ORG}')
  || (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM users z WHERE org_id = '${REAL_ORG}')
  || (SELECT string_agg(z::text, '|' ORDER BY z.id) FROM shops z WHERE org_id = '${REAL_ORG}')
  || (SELECT string_agg(z::text, '|' ORDER BY z.org_id) FROM business_profile z WHERE org_id = '${REAL_ORG}')
  || COALESCE((SELECT string_agg(z::text, '|' ORDER BY z.shop_id, z.product_id) FROM inventory z
               WHERE shop_id IN (SELECT id FROM shops WHERE org_id = '${REAL_ORG}')), ''));`;
  const realState = (): string => runSql(cfg, REAL_SQL).trim();

  // ---- org builders ---------------------------------------------------------
  const nextSale = async (o: Org, idx = 0): Promise<string> => {
    const r = ok(await rpc(o.cash, "complete_sale", {
      p_shop_id: o.shop, p_shift_id: o.shift, p_payment_method: "CASH", p_paid_mmk: 10_000, p_cart_discount_pct: 0,
      p_items: [{ product_id: o.prods[idx], qty: 1, units_per_item: 1 }], p_created_at: new Date().toISOString(), p_idempotency_key: uuid(),
    }), `${o.key} complete_sale`);
    return r.sale.id;
  };

  /** Catalog through the API as the org's own ADMIN (org_id never sent:
   *  the 068 BEFORE INSERT triggers fill it from the caller). */
  const buildCatalog = async (o: Org, p: string) => {
    o.cat = `${p}cat-${ts}`; o.brand = `${p}brand-${ts}`; o.unitType = `${p}ut-${ts}`; o.priceLevel = `${p}pl-${ts}`;
    o.pup = `${p}pup-${ts}`; o.tier = `${p}tier-${ts}`; o.barcode = `${p}bc-${ts}`;
    const ins = async (table: string, row: Record<string, unknown>) => {
      const { error } = await o.admin.from(table).insert(row);
      if (error) throw new Error(`${o.key} insert ${table} failed: ${error.message}`);
    };
    await ins("categories", { id: o.cat, name: `QA ${o.key} Category ${ts}`, color: "#888888", is_active: true });
    await ins("brands", { id: o.brand, category_id: o.cat, name: `QA ${o.key} Brand ${ts}`, is_active: true, sort_order: 0 });
    await ins("unit_types", { id: o.unitType, name: `QA ${o.key} Carton ${ts}`, abbreviation: `qc${o.key}${ts.slice(-4)}`, is_active: true, sort_order: 0 });
    // Same code in both orgs on purpose (per-org uniqueness since 068). Org A already has its
    // default level from seed.sql. Org B (console-created): before 077 it had no level at all and
    // got its default here - without one complete_sale raises "No active price level available"
    // (072, per-org lookup). Since 077 the organizations AFTER INSERT trigger already seeded
    // Retail (default) / Wholesale / Special, so a second active default would violate
    // price_levels_one_active_default_per_org: only mark this level default when the org has none.
    const defaults = await svcCount("price_levels", (q) => q.eq("org_id", o.orgId).eq("is_default", true).eq("is_active", true));
    await ins("price_levels", { id: o.priceLevel, code: `QA-RETAIL-${ts}`, name: `QA Retail ${ts}`, is_default: o.key === "B" && defaults === 0, is_active: true, sort_order: 0 });
    if (o.key === "B") ev.info("setup B price levels", `active default levels before buildCatalog=${defaults} (077 trigger seeds 1 for a console-created org); ${o.priceLevel} is_default=${defaults === 0}`);
    await ins("product_unit_prices", { id: o.pup, product_unit_id: o.units[0], price_level_id: o.priceLevel, shop_id: null, price_mmk: o.prices[0], is_active: true });
    await ins("price_tiers", { id: o.tier, product_id: o.prods[0], shop_id: o.shop, min_qty: 50, price_mmk: o.prices[0] - 1, is_active: true, created_by: o.adminId });
    await ins("supplier_products", { supplier_id: o.sup, product_id: o.prods[0] });
    // Same barcode value in both orgs on purpose (per-org uniqueness since 068).
    await ins("product_barcodes", { id: o.barcode, product_id: o.prods[0], product_unit_id: o.units[0], value: `QAGBC${ts}`, type: "CODE128" });
  };

  /** Purchasing, transfers, a shift, sales, a refund request, a reprint and an
   *  upload session — all through the RPCs, as the org's own users. */
  const buildOps = async (o: Org) => {
    const po = ok(await rpc(o.admin, "create_purchase_order", {
      p_shop_id: o.shop, p_supplier_id: o.sup, p_notes: `QA ${o.key} PO`,
      p_items: [{ product_id: o.prods[0], ordered_qty: 10, unit_cost_mmk: 500 }], p_idempotency_key: uuid(),
    }), `${o.key} create_purchase_order`);
    o.po = po.purchaseOrder.id;
    ok(await rpc(o.mgr, "approve_purchase_order", { p_purchase_order_id: o.po, p_idempotency_key: uuid() }), `${o.key} approve_purchase_order`);
    ok(await rpc(o.mgr, "receive_purchase_order", { p_purchase_order_id: o.po, p_received_items: null, p_created_at: null, p_expected_actor_id: o.mgrId, p_idempotency_key: uuid() }), `${o.key} receive_purchase_order`);
    ok(await rpc(o.mgr, "record_supplier_payment", { p_purchase_order_id: o.po, p_amount_mmk: 1000, p_payment_method: "CASH", p_reference_no: `QA-${o.key}`, p_notes: null, p_created_at: null, p_expected_actor_id: o.mgrId, p_idempotency_key: uuid() }), `${o.key} record_supplier_payment`);
    o.payment = (await svcRows("supplier_payments", (q) => q.eq("purchase_order_id", o.po), "id"))[0].id;
    const d = ok(await rpc(o.admin, "create_purchase_order", {
      p_shop_id: o.shop, p_supplier_id: o.sup, p_notes: `QA ${o.key} draft`,
      p_items: [{ product_id: o.prods[1], ordered_qty: 1, unit_cost_mmk: 100 }], p_idempotency_key: uuid(),
    }), `${o.key} create_purchase_order (draft)`);
    o.poDraft = d.purchaseOrder.id;
    const tr = ok(await rpc(o.admin, "create_stock_transfer", {
      p_from_shop_id: o.shop, p_to_shop_id: o.shop2, p_notes: `QA ${o.key} transfer`,
      p_items: [{ product_id: o.prods[0], requested_qty: 1 }], p_idempotency_key: uuid(),
    }), `${o.key} create_stock_transfer`);
    o.transfer = tr.stockTransfer.id;
    const sh = ok(await rpc(o.cash, "open_shift", { p_shop_id: o.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: o.cashId, p_idempotency_key: uuid() }), `${o.key} open_shift`);
    o.shift = sh.shift.id;
    o.sale = await nextSale(o);
    o.sale2 = await nextSale(o);
    o.sale3 = await nextSale(o);
    const req = ok(await rpc(o.cash, "create_refund_void_request", {
      p_sale_id: o.sale, p_type: "PARTIAL", p_reason: `QA ${o.key} refund`,
      p_items: [{ product_id: o.prods[0], qty_units: 1, amount_mmk: o.prices[0] }], p_created_at: null, p_expected_actor_id: o.cashId, p_idempotency_key: uuid(),
    }), `${o.key} create_refund_void_request`);
    o.request = req.request.id;
    ok(await rpc(o.cash, "log_receipt_reprint", { p_sale_id: o.sale, p_idempotency_key: uuid() }), `${o.key} log_receipt_reprint`);
    const ses = ok(await rpc(o.admin, "create_product_image_upload_session", { p_shop_id: o.shop, p_product_id: o.prods[0] }), `${o.key} create_product_image_upload_session`);
    o.session = ses.sessionId;
  };

  const consoleCall = async (token: string | null, body: Record<string, unknown>) => {
    const res = await fetch(`${cfg.url}/functions/v1/platform-console`, {
      method: "POST",
      headers: { apikey: cfg.anonKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  };
  const tokenOf = async (c: SupabaseClient): Promise<string> => (await c.auth.getSession()).data.session!.access_token;

  // =========================================================================
  beforeAll(async () => {
    cfg = liveConfig();
    svc = makeClient(cfg, cfg.serviceKey);
    anon = makeClient(cfg, cfg.anonKey);
    realBefore = realState();
    process.stdout.write(`[real org before] ${realBefore}\n`);

    // ---------------- Org A: Phase D seed (SQL) + API catalog/ops ----------
    Object.assign(A, {
      key: "A", orgId: `qa-org-${ts}`, name: `QA Org ${ts}`, shop: `qa-shop-${ts}`, shop2: `qa-shop2-${ts}`,
      adminId: `qa-user-admin-${ts}`, mgrId: `qa-user-manager-${ts}`, cashId: `qa-user-cashier-a-${ts}`,
      emails: { admin: `qa-admin-${ts}@qa.invalid`, mgr: `qa-manager-${ts}@qa.invalid`, cash: `qa-cashier-a-${ts}@qa.invalid` },
      prods: [`qa-prod-1-${ts}`, `qa-prod-2-${ts}`, `qa-prod-3-${ts}`], units: [`qa-unit-1-${ts}`, `qa-unit-2-${ts}`, `qa-unit-3-${ts}`],
      prices: [1000, 2000, 3000], sup: `qa-sup-${ts}`, supCode: `QASUP${ts}`,
      objectPath: `products/qa-prod-1-${ts}/qa-g-${ts}.webp`,
    });
    const authA = {
      admin: await createAuthUser(cfg, A.emails.admin, password),
      mgr: await createAuthUser(cfg, A.emails.mgr, password),
      casha: await createAuthUser(cfg, A.emails.cash, password),
      cashb: await createAuthUser(cfg, `qa-cashier-b-${ts}@qa.invalid`, password),
    };
    A.adminAuth = authA.admin;
    const seed = runSqlFile(cfg, SEED_SQL, { ts, auth_admin: authA.admin, auth_mgr: authA.mgr, auth_casha: authA.casha, auth_cashb: authA.cashb }).trim();
    process.stdout.write(`[seed A] ${seed}\n`);
    ev.info("setup A (seed.sql)", seed);
    A.admin = await signedInClient(cfg, A.emails.admin, password);
    A.mgr = await signedInClient(cfg, A.emails.mgr, password);
    A.cash = await signedInClient(cfg, A.emails.cash, password);

    // ---------------- Org B: trusted platform-console onboarding -----------
    platformEmail = `qa-platform-${ts}@qa.invalid`;
    const platformAuth = await createAuthUser(cfg, platformEmail, password);
    runSql(cfg, `INSERT INTO platform_admins (auth_id, name, email, is_active) VALUES ('${platformAuth}', 'QA Platform Admin', '${platformEmail}', true);`);
    const platform = await signedInClient(cfg, platformEmail, password);
    const bAdminEmail = `qa-b-admin-${ts}@qa.invalid`;
    const created = await consoleCall(await tokenOf(platform), {
      action: "create_organization", orgName: `QA Org B ${ts}`, adminName: "QA B Admin", adminEmail: bAdminEmail,
    });
    let bAdminPassword = "";
    if (created.status === 200 && created.json?.orgId && created.json?.tempPassword) {
      consoleMode = "deployed edge function platform-console / create_organization (QA platform admin)";
      B.orgId = created.json.orgId;
      bAdminPassword = created.json.tempPassword; // in memory only
    } else {
      // Fallback (documented): replicate the function exactly with the service key.
      consoleMode = `service-role replica of create_organization (edge function answered HTTP ${created.status}: ${short(created.json?.error)})`;
      const cu = await svc.auth.admin.createUser({ email: bAdminEmail, password, email_confirm: true });
      if (cu.error) throw new Error(`fallback createUser: ${cu.error.message}`);
      B.orgId = `org-${uuid().replace(/-/g, "")}`;
      const oi = await svc.from("organizations").insert({ id: B.orgId, name: `QA Org B ${ts}` });
      if (oi.error) throw new Error(`fallback org insert: ${oi.error.message}`);
      const ui = await svc.from("users").insert({ id: `user-${uuid().replace(/-/g, "")}`, name: "QA B Admin", email: bAdminEmail, role: "ADMIN", org_id: B.orgId, auth_id: cu.data.user!.id, is_active: true, created_at: new Date().toISOString() });
      if (ui.error) throw new Error(`fallback admin insert: ${ui.error.message}`);
      bAdminPassword = password;
    }
    await platform.auth.signOut();
    process.stdout.write(`[org B] ${consoleMode} -> ${B.orgId}\n`);
    const bAdminRow = (await svcRows("users", (q) => q.eq("email", bAdminEmail)))[0];
    Object.assign(B, {
      key: "B", name: `QA Org B ${ts}`, shop: `qa-b-shop-${ts}`, shop2: `qa-b-shop2-${ts}`,
      adminId: bAdminRow.id, adminAuth: bAdminRow.auth_id, mgrId: `qa-b-user-manager-${ts}`, cashId: `qa-b-user-cashier-${ts}`,
      emails: { admin: bAdminEmail, mgr: `qa-b-manager-${ts}@qa.invalid`, cash: `qa-b-cashier-${ts}@qa.invalid` },
      prods: [`qa-b-prod-1-${ts}`, `qa-b-prod-2-${ts}`], units: [`qa-b-unit-1-${ts}`, `qa-b-unit-2-${ts}`], prices: [1500, 2500],
      objectPath: `products/qa-b-prod-1-${ts}/qa-g-${ts}.webp`,
    });
    B.admin = await signedInClient(cfg, B.emails.admin, bAdminPassword);
    // B's shops: inserted by B's ADMIN WITHOUT org_id (068 trigger fills it - F17).
    for (const [id, code, name] of [[B.shop, `QX${ts}`, `QA B Shop ${ts}`], [B.shop2, `QY${ts}`, `QA B Shop Two ${ts}`]]) {
      const { error } = await B.admin.from("shops").insert({ id, code, name, address: "QA B Street", is_active: true });
      if (error) throw new Error(`B shop insert failed: ${error.message}`);
    }
    // B's staff through create_app_user (MANAGER first, then CASHIER).
    // 082: staff-admin-marked accounts for org B, and B's ADMIN session must
    // have entered an emailed code after signing in (no TOTP on QA admins).
    const authBm = await createAuthUser(cfg, B.emails.mgr, password, { created_via: "staff-admin", org_id: B.orgId });
    const authBc = await createAuthUser(cfg, B.emails.cash, password, { created_via: "staff-admin", org_id: B.orgId });
    runSql(cfg, `INSERT INTO admin_login_codes (auth_id, code_hash, expires_at, consumed_at) VALUES ('${B.adminAuth}', repeat('0', 64), now() + interval '10 minutes', now());`);
    ok(await rpc(B.admin, "create_app_user", { p_id: B.mgrId, p_name: "QA B Manager", p_email: B.emails.mgr, p_role: "MANAGER", p_shop_id: B.shop, p_auth_id: authBm, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() }), "B create manager");
    ok(await rpc(B.admin, "create_app_user", { p_id: B.cashId, p_name: "QA B Cashier", p_email: B.emails.cash, p_role: "CASHIER", p_shop_id: B.shop, p_auth_id: authBc, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() }), "B create cashier");
    B.mgr = await signedInClient(cfg, B.emails.mgr, password);
    B.cash = await signedInClient(cfg, B.emails.cash, password);
    // B's products + default units, through REST as B's ADMIN (no org_id sent).
    for (let i = 0; i < 2; i++) {
      const pr = await B.admin.from("products").insert({ id: B.prods[i], sku: `QB${i + 1}-${ts}`, name: `QA B Product ${i + 1}`, category: "QA", unit_type: "pcs", price_mmk: B.prices[i], cost_mmk: 500, is_active: true });
      if (pr.error) throw new Error(`B product insert: ${pr.error.message}`);
      const un = await B.admin.from("product_units").insert({ id: B.units[i], product_id: B.prods[i], name: "pcs", base_quantity: 1, is_default: true, is_active: true, sale_price_mmk: B.prices[i], purchase_price_mmk: 500 });
      if (un.error) throw new Error(`B unit insert: ${un.error.message}`);
      ok(await rpc(B.admin, "adjust_stock", { p_shop_id: B.shop, p_product_id: B.prods[i], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 100, p_reason: "QA B opening stock", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: B.adminId, p_idempotency_key: uuid() }), "B opening stock");
    }
    // B's supplier through create_supplier - SAME code as org A's supplier.
    B.supCode = A.supCode;
    const sup = ok(await rpc(B.admin, "create_supplier", { p_code: B.supCode, p_name: `QA B Supplier ${ts}`, p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_idempotency_key: uuid() }), "B create_supplier");
    B.sup = sup.supplier.id;

    await buildCatalog(A, "qa-a-");
    await buildCatalog(B, "qa-b-");
    await buildOps(A);
    await buildOps(B);

    // Evidence of the onboarding (DB state).
    const bOrg = (await svcRows("organizations", (q) => q.eq("id", B.orgId)))[0];
    const bBp = await svcRows("business_profile", (q) => q.eq("org_id", B.orgId));
    const bShops = await svcRows("shops", (q) => q.in("id", [B.shop, B.shop2]), "id, org_id");
    const bUsers = await svcRows("users", (q) => q.eq("org_id", B.orgId), "id, role, shop_id, org_id");
    const bInv = await svcRows("inventory", (q) => q.in("product_id", B.prods), "shop_id, product_id, qty_base_units");
    const bSup = (await svcRows("suppliers", (q) => q.eq("id", B.sup), "org_id, code"))[0];
    const bAuth = runSql(cfg, `SELECT email_confirmed_at IS NOT NULL FROM auth.users WHERE email = '${B.emails.admin}';`).trim();
    expect(bOrg?.name).toBe(B.name);
    expect(bBp).toHaveLength(1);
    expect(bShops.every((s) => s.org_id === B.orgId)).toBe(true);
    expect(bUsers.map((u) => u.role).sort()).toEqual(["ADMIN", "CASHIER", "MANAGER"]);
    expect(bInv).toHaveLength(4); // 2 B shops x 2 B products, nothing cross-org (068 trigger)
    expect(bInv.every((r) => [B.shop, B.shop2].includes(r.shop_id))).toBe(true);
    expect(bSup).toMatchObject({ org_id: B.orgId, code: A.supCode });
    ev.pass("setup B (trusted onboarding)", `${consoleMode}; org ${B.orgId} "${bOrg.name}"; business_profile auto-row=${bBp.length} (trigger); ADMIN ${B.adminId} auth confirmed=${bAuth}; shops inserted by B ADMIN without org_id -> org_id=${B.orgId} (x2); staff via create_app_user: ${bUsers.map((u) => u.role).join("/")}; inventory auto-rows=${bInv.length} (B shops x B products only); supplier code ${bSup.code} == org A's (per-org unique)`);
    ev.info("setup ops", `A: po=${A.po} pay=${A.payment} draft=${A.poDraft} tr=${A.transfer} shift=${A.shift} sales=${A.sale},${A.sale2},${A.sale3} req=${A.request} session=${A.session}; B: po=${B.po} pay=${B.payment} tr=${B.transfer} shift=${B.shift} sale=${B.sale} req=${B.request} session=${B.session}`);
  });

  afterAll(async () => {
    // Remove QA storage objects through the Storage API (deletes the files on disk).
    const removed: string[] = [];
    for (const u of uploaded) {
      try {
        const { data } = await u.client().storage.from(BUCKET).remove([u.path]);
        if (data?.length) removed.push(u.path);
      } catch { /* reported by the SQL check below */ }
    }
    // Belt and braces: anything QA still in the bucket goes via the service role (API, not SQL).
    try {
      const left = runSql(cfg, `SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name LIKE '%qa-%';`).trim().split("\n").filter(Boolean);
      if (left.length) await svc.storage.from(BUCKET).remove(left);
      const after = runSql(cfg, `SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name LIKE '%qa-%';`).trim();
      ev.info("storage cleanup", `removed via owner API: ${removed.length}; leftover removed via service API: ${left.length}; QA objects remaining in storage.objects=${after}`);
    } catch (err: any) {
      ev.fail("storage cleanup", String(err?.message ?? err));
    }
    try { ev.info("real org after", realState()); } catch { /* ignore */ }
    process.stdout.write(`\n[results ts=${ts}]\n${ev.table()}\n\n`);
    for (const c of [A.admin, A.mgr, A.cash, B.admin, B.mgr, B.cash]) {
      try { await c?.removeAllChannels(); await c?.auth.signOut(); } catch { /* ignore */ }
    }
  });

  // =========================================================================
  it("1. setup path: app_setup_needed false; orphan and deactivated accounts cannot bootstrap, insert or read", async () => {
    const notes: string[] = [];
    const sAnon = await rpc(anon, "app_setup_needed", {});
    const sAuth = await rpc(A.admin, "app_setup_needed", {});
    expect(sAnon.error).toBeNull();
    expect(sAnon.data).toBe(false);
    expect(sAuth.data).toBe(false);
    notes.push(`app_setup_needed anon=${sAnon.data} authenticated=${sAuth.data}`);

    const readTables = ["organizations", "shops", "users", "products", "categories", "brands", "suppliers", "price_levels", "unit_types", "business_profile", "inventory", "sales", "shifts", "purchase_orders", "audit_logs"];
    const probe = async (client: SupabaseClient, who: string) => {
      // Since 076 the only client bootstrap path is the bootstrap_first_admin() RPC
      // (SetupPage -> bootstrapFirstAdmin() step 4); on this populated install it must
      // refuse. The direct table inserts the pre-076 client used must stay refused too
      // (organizations_ins WITH CHECK (false); users_ins without the setup branch).
      const bootRpc = await rpc(client, "bootstrap_first_admin", {});
      expect(bootRpc.error, `${who}: bootstrap_first_admin must refuse`).not.toBeNull();
      expect(bootRpc.error.code).toBe("42501");
      expect(String(bootRpc.error.message)).toMatch(/^SETUP_ALREADY_COMPLETED/);
      const orgId = `qa-org-${who}-${ts}`;
      const authId = (await client.auth.getUser()).data.user!.id;
      const orgIns = await client.from("organizations").insert({ id: orgId, name: `QA ${who} Org ${ts}`, created_at: new Date().toISOString() });
      const asAdminNewOrg = await client.from("users").insert({ id: `qa-user-${who}-admin-${ts}`, name: `QA ${who}`, email: `qa-${who}-x-${ts}@qa.invalid`, role: "ADMIN", org_id: orgId, auth_id: authId, is_active: true });
      const asAdminOrgA = await client.from("users").insert({ id: `qa-user-${who}-admin2-${ts}`, name: `QA ${who}`, email: `qa-${who}-y-${ts}@qa.invalid`, role: "ADMIN", org_id: A.orgId, auth_id: authId, is_active: true });
      const asMgrOrgB = await client.from("users").insert({ id: `qa-user-${who}-mgr-${ts}`, name: `QA ${who}`, email: `qa-${who}-z-${ts}@qa.invalid`, role: "MANAGER", org_id: B.orgId, shop_id: B.shop2, auth_id: authId, is_active: true });
      const asCashOrgA = await client.from("users").insert({ id: `qa-user-${who}-cash-${ts}`, name: `QA ${who}`, email: `qa-${who}-w-${ts}@qa.invalid`, role: "CASHIER", org_id: A.orgId, shop_id: A.shop, auth_id: authId, is_active: true });
      for (const [label, r] of [["org insert", orgIns], ["ADMIN of new org", asAdminNewOrg], ["ADMIN of org A", asAdminOrgA], ["MANAGER of org B", asMgrOrgB], ["CASHIER of org A", asCashOrgA]] as const) {
        expect(r.error, `${who}: ${label} must be rejected`).not.toBeNull();
      }
      const dbOrg = await svcCount("organizations", (q) => q.eq("id", orgId));
      const dbUsers = await svcCount("users", (q) => q.like("id", `qa-user-${who}-%`));
      expect(dbOrg).toBe(0);
      expect(dbUsers).toBe(0);
      const reads: string[] = [];
      for (const t of readTables) {
        const r = await client.from(t).select("*").limit(5);
        expect(r.error === null ? r.data : [], `${who} read ${t}`).toEqual([]);
        reads.push(`${t}=${r.error ? r.error.code : r.data!.length}`);
      }
      const op = await rpc(client, "open_shift", { p_shop_id: A.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: null, p_idempotency_key: uuid() });
      expect(op.error).not.toBeNull();
      notes.push(`${who}: bootstrap_first_admin -> ${bootRpc.error.code} "${short(bootRpc.error.message, 40)}"; org insert -> ${orgIns.error?.code}; users insert as ADMIN(new org)/ADMIN(A)/MANAGER(B)/CASHIER(A) -> ${[asAdminNewOrg, asAdminOrgA, asMgrOrgB, asCashOrgA].map((r) => r.error?.code).join("/")}; DB orgs=${dbOrg} users=${dbUsers}; reads all [] (${reads.join(" ")}); open_shift -> "${short(op.error?.message, 40)}"`);
    };

    // (a) orphan: fresh GoTrue signup, no users row
    const orphanEmail = `qa-orphan-${ts}@qa.invalid`;
    await createAuthUser(cfg, orphanEmail, password);
    const orphan = await signedInClient(cfg, orphanEmail, password);
    expect((await rpc(orphan, "app_setup_needed", {})).data).toBe(false);
    await probe(orphan, "orphan");
    await orphan.auth.signOut();

    // (b) deactivated: org A cashier B, is_active=false via SQL
    const deactId = `qa-user-cashier-b-${ts}`;
    const deactEmail = `qa-cashier-b-${ts}@qa.invalid`;
    const before = await signedInClient(cfg, deactEmail, password);
    const sees = await before.from("products").select("id").in("id", A.prods);
    expect(sees.data!.length).toBe(3); // sanity: active, it reads its org
    await before.auth.signOut();
    runSql(cfg, `UPDATE users SET is_active = false WHERE id = '${deactId}';`);
    const deact = await signedInClient(cfg, deactEmail, password);
    await probe(deact, "deact");
    const stillInactive = (await svcRows("users", (q) => q.eq("id", deactId), "is_active, role, org_id"))[0];
    expect(stillInactive).toMatchObject({ is_active: false, role: "CASHIER", org_id: A.orgId });
    // ... and cannot re-activate / elevate its own row
    const selfUpd = await deact.from("users").update({ is_active: true, role: "ADMIN" }).eq("id", deactId).select("id");
    expect(selfUpd.error !== null || selfUpd.data!.length === 0).toBe(true);
    expect((await svcRows("users", (q) => q.eq("id", deactId), "is_active, role"))[0]).toMatchObject({ is_active: false, role: "CASHIER" });
    await deact.auth.signOut();
    notes.push(`deact self re-activate/elevate -> ${selfUpd.error?.code ?? `${selfUpd.data?.length} rows`}, DB still is_active=false role=CASHIER`);

    // (c) the REAL app code path (authStore) for both accounts.
    vi.stubEnv("VITE_SUPABASE_URL", cfg.url);
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", cfg.anonKey);
    const { useAuthStore } = await import("../stores/authStore");
    const boot = await useAuthStore.getState().bootstrapFirstAdmin(orphanEmail, password);
    const loginOrphan = await useAuthStore.getState().login(orphanEmail, password);
    const loginDeact = await useAuthStore.getState().login(deactEmail, password);
    notes.push(`app bootstrapFirstAdmin(orphan) -> "${short(boot.error, 60)}"; app login(orphan) -> "${short(loginOrphan.error, 70)}" setupNeeded=${loginOrphan.setupNeeded}; app login(deactivated) -> "${short(loginDeact.error, 70)}" setupNeeded=${loginDeact.setupNeeded}`);
    expect(boot.error).toMatch(/already been completed/i);
    expect(useAuthStore.getState().currentUserId).toBeNull();
    expect(await svcCount("organizations", (q) => q.like("name", "QA orphan%"))).toBe(0);
    // A populated install must never point an orphan / deactivated account at /setup.
    expect(loginOrphan.setupNeeded, `login(orphan): ${loginOrphan.error}`).not.toBe(true);
    expect(loginDeact.setupNeeded, `login(deactivated): ${loginDeact.error}`).not.toBe(true);
    expect(loginOrphan.error).toBeTruthy();
    expect(loginDeact.error).toBeTruthy();
    ev.pass("1 setup / orphan / deactivated", notes.join("; "));
  });

  // =========================================================================
  for (const which of ["A", "B"] as const) {
    it(`2${which}. org ${which} admin manages its own org (reads, create product, adjust stock, create staff)`, async () => {
      const o = which === "A" ? A : B;
      const other = which === "A" ? B : A;
      const orgShops = [o.shop, o.shop2];
      const reads: string[] = [];
      const own = async (table: string, svcFilter: (q: any) => any) => {
        const { count, error } = await o.admin.from(table).select("*", { count: "exact", head: true });
        expect(error, `${which} read ${table}`).toBeNull();
        const expected = await svcCount(table, svcFilter);
        expect(count, `${which} ${table}: visible == own-org rows`).toBe(expected);
        expect(expected, `${which} ${table} non-empty`).toBeGreaterThan(0);
        reads.push(`${table}=${count}`);
      };
      await own("sales", (q) => q.in("shop_id", orgShops));
      await own("inventory", (q) => q.in("shop_id", orgShops));
      await own("users", (q) => q.eq("org_id", o.orgId));
      await own("products", (q) => q.eq("org_id", o.orgId));
      await own("product_units", (q) => q.in("product_id", o.prods));
      await own("categories", (q) => q.eq("org_id", o.orgId));
      await own("price_levels", (q) => q.eq("org_id", o.orgId));
      await own("suppliers", (q) => q.eq("org_id", o.orgId));
      await own("purchase_orders", (q) => q.in("shop_id", orgShops));

      // create product (no org_id sent) -> org_id = own org; inventory rows only for own shops
      const pid = `qa-${which.toLowerCase()}-newprod-${ts}`;
      const ins = await o.admin.from("products").insert({ id: pid, sku: `QN${which}-${ts}`, name: `QA ${which} New Product`, category: "QA", unit_type: "pcs", price_mmk: 700, cost_mmk: 300, is_active: true }).select("id, org_id").single();
      expect(ins.error).toBeNull();
      expect(ins.data!.org_id).toBe(o.orgId);
      const invRows = await svcRows("inventory", (q) => q.eq("product_id", pid), "shop_id");
      expect(invRows.map((r) => r.shop_id).sort()).toEqual([...orgShops].sort());
      // adjust stock (own shop)
      const q0 = await inv(o.shop, pid);
      const adj = await rpc(o.admin, "adjust_stock", { p_shop_id: o.shop, p_product_id: pid, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 7, p_reason: `QA ${which} adjust`, p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: o.adminId, p_idempotency_key: uuid() });
      expect(adj.error).toBeNull();
      expect(await inv(o.shop, pid)).toBe(q0 + 7);
      // create staff
      const staffEmail = `qa-${which.toLowerCase()}-staff-${ts}@qa.invalid`;
      const staffAuth = await createAuthUser(cfg, staffEmail, password);
      const staffId = `qa-${which.toLowerCase()}-user-staff-${ts}`;
      const cu = await rpc(o.admin, "create_app_user", { p_id: staffId, p_name: `QA ${which} Staff`, p_email: staffEmail, p_role: "CASHIER", p_shop_id: o.shop, p_auth_id: staffAuth, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() });
      expect(cu.error).toBeNull();
      expect(cu.data).toMatchObject({ id: staffId, orgId: o.orgId, shopId: o.shop });
      expect((await svcRows("users", (q) => q.eq("id", staffId), "org_id, role, shop_id, auth_id"))[0]).toMatchObject({ org_id: o.orgId, role: "CASHIER", shop_id: o.shop, auth_id: staffAuth });
      // shop insert without org_id lands in own org (F17) and never in the other one
      const sid = `qa-${which.toLowerCase()}-shop3-${ts}`;
      const shopIns = await o.admin.from("shops").insert({ id: sid, code: `QZ${which}${ts.slice(-6)}`, name: `QA ${which} Shop Three ${ts}`, address: "QA", is_active: false }).select("org_id").single();
      expect(shopIns.error).toBeNull();
      expect(shopIns.data!.org_id).toBe(o.orgId);
      expect(await svcCount("shops", (q) => q.eq("org_id", other.orgId).eq("id", sid))).toBe(0);
      ev.pass(`2${which} own-org management`, `${which} ADMIN visible==own-org counts: ${reads.join(" ")}; product ${pid} org_id=${ins.data!.org_id}, inventory rows only ${invRows.map((r) => r.shop_id).join(",")}; adjust_stock ${q0}->${q0 + 7}; staff ${staffId} org_id=${o.orgId}; shop ${sid} (no org_id sent) -> org_id=${shopIns.data!.org_id}`);
    });
  }

  // =========================================================================
  /** Per-table spec: key column + how to select the rows of org `o` via svc. */
  const tableSpecs = (o: Org) => {
    const shops = [o.shop, o.shop2, `qa-${o.key.toLowerCase()}-shop3-${ts}`];
    const prodsAll = [...o.prods, `qa-${o.key.toLowerCase()}-newprod-${ts}`];
    return [
      { t: "organizations", key: "id", f: (q: any) => q.eq("id", o.orgId), upd: { name: "QA hacked" } },
      { t: "shops", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { name: "QA hacked" } },
      { t: "users", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { name: "QA hacked" } },
      { t: "business_profile", key: "org_id", f: (q: any) => q.eq("org_id", o.orgId), upd: { business_name: "QA hacked" } },
      { t: "products", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { name: "QA hacked" } },
      { t: "product_units", key: "id", f: (q: any) => q.in("product_id", prodsAll), upd: { name: "QA hacked" } },
      { t: "product_unit_prices", key: "id", f: (q: any) => q.in("product_unit_id", o.units), upd: { price_mmk: 1 } },
      { t: "product_barcodes", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { value: "QAHACK" } },
      { t: "price_tiers", key: "id", f: (q: any) => q.in("product_id", prodsAll), upd: { price_mmk: 1 } },
      { t: "categories", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { name: "QA hacked" } },
      { t: "brands", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { name: "QA hacked" } },
      { t: "suppliers", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { name: "QA hacked" } },
      { t: "supplier_products", key: "product_id", f: (q: any) => q.in("product_id", prodsAll), upd: { product_id: o.prods[0] } },
      { t: "price_levels", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { name: "QA hacked" } },
      { t: "unit_types", key: "id", f: (q: any) => q.eq("org_id", o.orgId), upd: { name: "QA hacked" } },
      { t: "inventory", key: "product_id", f: (q: any) => q.in("shop_id", shops), upd: { qty_base_units: 99999 } },
      { t: "inventory_movements", key: "id", f: (q: any) => q.in("shop_id", shops), upd: { reason: "QA hacked" } },
      { t: "sales", key: "id", f: (q: any) => q.in("shop_id", shops), upd: { status: "VOIDED" } },
      { t: "sale_items", key: "sale_id", f: (q: any) => q.in("sale_id", [o.sale, o.sale2, o.sale3]), upd: { qty_units: 99 } },
      { t: "shifts", key: "id", f: (q: any) => q.in("shop_id", shops), upd: { closing_cash_mmk: 1 } },
      { t: "purchase_orders", key: "id", f: (q: any) => q.in("shop_id", shops), upd: { notes: "QA hacked" } },
      { t: "purchase_order_items", key: "purchase_order_id", f: (q: any) => q.in("purchase_order_id", [o.po, o.poDraft]), upd: { ordered_qty: 1 } },
      { t: "supplier_payments", key: "id", f: (q: any) => q.in("shop_id", shops), upd: { notes: "QA hacked" } },
      { t: "stock_transfers", key: "id", f: (q: any) => q.in("from_shop_id", shops), upd: { notes: "QA hacked" } },
      { t: "refund_void_requests", key: "id", f: (q: any) => q.in("shop_id", shops), upd: { reason: "QA hacked" } },
      { t: "reprint_logs", key: "sale_id", f: (q: any) => q.in("sale_id", [o.sale]), upd: { sale_id: o.sale } },
      { t: "audit_logs", key: "id", f: (q: any) => q.in("shop_id", shops), upd: { message: "QA hacked" } },
      { t: "product_image_upload_sessions", key: "id", f: (q: any) => q.eq("created_by", o.adminId), upd: { status: "CANCELED" } },
    ];
  };

  for (const [xKey, yKey] of [["A", "B"], ["B", "A"]] as const) {
    it(`3${xKey}. org ${xKey} admin cannot read/update/delete ANY org ${yKey} row (and never sees the real org)`, async () => {
      const x = xKey === "A" ? A : B;
      const y = yKey === "A" ? A : B;
      const fp0 = fp();
      const lines: string[] = [];
      const realLines: string[] = [];
      for (const spec of tableSpecs(y)) {
        const keys = [...new Set((await svcRows(spec.t, spec.f, spec.key)).map((r) => r[spec.key]))];
        expect(keys.length, `${yKey} has ${spec.t} rows (non-vacuous)`).toBeGreaterThan(0);
        const read = await x.admin.from(spec.t).select("*").in(spec.key, keys);
        expect(read.error, `${xKey} read ${spec.t}`).toBeNull();
        expect(read.data, `${xKey} read ${yKey} ${spec.t}`).toEqual([]);
        const upd = await x.admin.from(spec.t).update(spec.upd).in(spec.key, keys).select();
        const updOk = upd.error !== null || (upd.data ?? []).length === 0;
        expect(updOk, `${xKey} update ${yKey} ${spec.t}: ${JSON.stringify(upd.data)?.slice(0, 120)}`).toBe(true);
        const del = await x.admin.from(spec.t).delete().in(spec.key, keys).select();
        const delOk = del.error !== null || (del.data ?? []).length === 0;
        expect(delOk, `${xKey} delete ${yKey} ${spec.t}: ${JSON.stringify(del.data)?.slice(0, 120)}`).toBe(true);
        lines.push(`${spec.t}(${keys.length}): read=[] upd=${upd.error ? upd.error.code : `${upd.data!.length}rows`} del=${del.error ? del.error.code : `${del.data!.length}rows`}`);
      }
      // the real organization stays invisible: admin's visible count == own-org count for every table,
      // and an explicit probe with real ids returns []
      const realProbes: [string, string, (q: any) => any][] = [
        ["organizations", "id", (q) => q.eq("id", REAL_ORG)],
        ["shops", "id", (q) => q.eq("org_id", REAL_ORG)],
        ["users", "id", (q) => q.eq("org_id", REAL_ORG)],
        ["business_profile", "org_id", (q) => q.eq("org_id", REAL_ORG)],
        ["products", "id", (q) => q.eq("org_id", REAL_ORG).limit(200)],
        ["categories", "id", (q) => q.eq("org_id", REAL_ORG)],
        ["brands", "id", (q) => q.eq("org_id", REAL_ORG)],
        ["suppliers", "id", (q) => q.eq("org_id", REAL_ORG)],
        ["price_levels", "id", (q) => q.eq("org_id", REAL_ORG)],
        ["unit_types", "id", (q) => q.eq("org_id", REAL_ORG)],
        ["product_barcodes", "id", (q) => q.eq("org_id", REAL_ORG).limit(200)],
      ];
      const realShops = (await svcRows("shops", (q) => q.eq("org_id", REAL_ORG), "id")).map((r) => r.id);
      realProbes.push(["inventory", "shop_id", (q) => q.in("shop_id", realShops)]);
      realProbes.push(["sales", "shop_id", (q) => q.in("shop_id", realShops)]);
      realProbes.push(["shifts", "shop_id", (q) => q.in("shop_id", realShops)]);
      realProbes.push(["audit_logs", "shop_id", (q) => q.in("shop_id", realShops)]);
      for (const [t, key, f] of realProbes) {
        const keys = [...new Set((await svcRows(t, f, key)).map((r) => r[key]))];
        const r = keys.length ? await x.admin.from(t).select(key, { count: "exact" }).in(key, keys) : { data: [], error: null, count: 0 };
        expect(r.error).toBeNull();
        expect(r.data, `${xKey} sees real ${t}`).toEqual([]);
        realLines.push(`${t}: real ${keys.length} -> visible ${r.data!.length}`);
      }
      const fp1 = fp();
      expect(fp1, "QA fingerprint unchanged by all cross-org UPDATE/DELETE attempts").toBe(fp0);
      ev.pass(`3${xKey} ${xKey}->${yKey} read/update/delete`, `${lines.join("; ")} || real org: ${realLines.join(", ")} || QA fingerprint before==after ${fp0}`);
    });
  }

  // =========================================================================
  it("4. all mutating RPCs: org A ADMIN with org B ids -> 'not found in your organization', no DB change; positives in own org", async () => {
    const k = () => uuid();
    const neg: [string, string, Record<string, unknown>][] = [
      ["adjust_stock(shop B)", "adjust_stock", { p_shop_id: B.shop, p_product_id: B.prods[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA x", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["adjust_stock(shop A, product B)", "adjust_stock", { p_shop_id: A.shop, p_product_id: B.prods[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA x", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["approve_purchase_order", "approve_purchase_order", { p_purchase_order_id: B.poDraft, p_idempotency_key: k() }],
      ["approve_refund_request", "approve_refund_request", { p_request_id: B.request, p_idempotency_key: k() }],
      ["approve_stock_transfer", "approve_stock_transfer", { p_transfer_id: B.transfer, p_idempotency_key: k() }],
      ["approve_void_request", "approve_void_request", { p_request_id: B.request, p_idempotency_key: k() }],
      ["cancel_purchase_order", "cancel_purchase_order", { p_purchase_order_id: B.poDraft, p_reason: "QA x", p_idempotency_key: k() }],
      ["cancel_stock_transfer", "cancel_stock_transfer", { p_transfer_id: B.transfer, p_reason: "QA x", p_idempotency_key: k() }],
      ["close_shift", "close_shift", { p_shift_id: B.shift, p_closing_cash_mmk: 0, p_variance_reason: "QA x", p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["complete_sale(shop B, shift B)", "complete_sale", { p_shop_id: B.shop, p_shift_id: B.shift, p_payment_method: "CASH", p_paid_mmk: 5000, p_cart_discount_pct: 0, p_items: [{ product_id: B.prods[0], qty: 1, units_per_item: 1 }], p_created_at: null, p_idempotency_key: k() }],
      ["create_app_user(shop B)", "create_app_user", { p_id: `qa-user-xorg-${ts}`, p_name: "QA X", p_email: `qa-xorg-${ts}@qa.invalid`, p_role: "CASHIER", p_shop_id: B.shop, p_auth_id: null, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: k() }],
      ["create_product_image_upload_session(shop B, product B)", "create_product_image_upload_session", { p_shop_id: B.shop, p_product_id: B.prods[0] }],
      ["create_product_image_upload_session(shop A, product B)", "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: B.prods[0] }],
      ["create_purchase_order(shop B)", "create_purchase_order", { p_shop_id: B.shop, p_supplier_id: A.sup, p_notes: "QA x", p_items: [{ product_id: A.prods[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: k() }],
      ["create_purchase_order(shop A, supplier B)", "create_purchase_order", { p_shop_id: A.shop, p_supplier_id: B.sup, p_notes: "QA x", p_items: [{ product_id: A.prods[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: k() }],
      ["create_purchase_order(shop A, supplier A, item product B)", "create_purchase_order", { p_shop_id: A.shop, p_supplier_id: A.sup, p_notes: "QA x", p_items: [{ product_id: B.prods[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: k() }],
      ["create_refund_void_request(sale B)", "create_refund_void_request", { p_sale_id: B.sale2, p_type: "VOID", p_reason: "QA x", p_items: null, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["create_stock_transfer(B -> B2)", "create_stock_transfer", { p_from_shop_id: B.shop, p_to_shop_id: B.shop2, p_notes: "QA x", p_items: [{ product_id: B.prods[0], requested_qty: 1 }], p_idempotency_key: k() }],
      ["create_stock_transfer(A -> B)", "create_stock_transfer", { p_from_shop_id: A.shop, p_to_shop_id: B.shop, p_notes: "QA x", p_items: [{ product_id: A.prods[0], requested_qty: 1 }], p_idempotency_key: k() }],
      ["create_stock_transfer(A -> A2, item product B)", "create_stock_transfer", { p_from_shop_id: A.shop, p_to_shop_id: A.shop2, p_notes: "QA x", p_items: [{ product_id: B.prods[0], requested_qty: 1 }], p_idempotency_key: k() }],
      ["deactivate_app_user(user B)", "deactivate_app_user", { p_id: B.cashId, p_is_active: false, p_idempotency_key: k() }],
      ["delete_product(product B)", "delete_product", { p_product_id: B.prods[1], p_idempotency_key: k() }],
      ["dispatch_stock_transfer", "dispatch_stock_transfer", { p_transfer_id: B.transfer, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["log_audit_event(shop B)", "log_audit_event", { p_action_type: "PRODUCT_EDIT", p_message: "QA x", p_entity_type: "Product", p_entity_id: A.prods[0], p_shop_id: B.shop, p_idempotency_key: k() }],
      ["log_receipt_reprint(sale B)", "log_receipt_reprint", { p_sale_id: B.sale, p_idempotency_key: k() }],
      ["open_shift(shop B)", "open_shift", { p_shop_id: B.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["pay_supplier_lump_sum(supplier B, shop A)", "pay_supplier_lump_sum", { p_supplier_id: B.sup, p_shop_id: A.shop, p_amount_mmk: 100, p_payment_method: "CASH", p_reference_no: null, p_notes: null, p_idempotency_key: k() }],
      ["pay_supplier_lump_sum(supplier A, shop B)", "pay_supplier_lump_sum", { p_supplier_id: A.sup, p_shop_id: B.shop, p_amount_mmk: 100, p_payment_method: "CASH", p_reference_no: null, p_notes: null, p_idempotency_key: k() }],
      ["receive_purchase_order", "receive_purchase_order", { p_purchase_order_id: B.poDraft, p_received_items: null, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["receive_stock_transfer", "receive_stock_transfer", { p_transfer_id: B.transfer, p_received_items: null, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["record_supplier_payment(PO B)", "record_supplier_payment", { p_purchase_order_id: B.po, p_amount_mmk: 100, p_payment_method: "CASH", p_reference_no: null, p_notes: null, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: k() }],
      ["reject_refund_void_request", "reject_refund_void_request", { p_request_id: B.request, p_reason: "QA x", p_idempotency_key: k() }],
      ["reject_stock_transfer", "reject_stock_transfer", { p_transfer_id: B.transfer, p_reason: "QA x", p_idempotency_key: k() }],
      ["replace_manager(shop B, user A)", "replace_manager", { p_shop_id: B.shop, p_new_manager_id: `qa-a-user-staff-${ts}`, p_idempotency_key: k() }],
      ["replace_manager(shop A, user B)", "replace_manager", { p_shop_id: A.shop2, p_new_manager_id: B.cashId, p_idempotency_key: k() }],
      ["update_app_user(user B)", "update_app_user", { p_id: B.cashId, p_name: "QA hacked", p_role: "CASHIER", p_shop_id: B.shop, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: k() }],
      ["update_app_user(user A -> shop B)", "update_app_user", { p_id: `qa-a-user-staff-${ts}`, p_name: "QA A Staff", p_role: "CASHIER", p_shop_id: B.shop, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: k() }],
      ["update_supplier(supplier B)", "update_supplier", { p_id: B.sup, p_code: B.supCode, p_name: "QA hacked", p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_is_active: true, p_idempotency_key: k() }],
      ["void_supplier_payment(payment B)", "void_supplier_payment", { p_payment_id: B.payment, p_reason: "QA x", p_idempotency_key: k() }],
    ];
    const rows: string[] = [];
    const families = new Set<string>();
    let fpPrev = fp();
    const fpStart = fpPrev;
    for (const [label, fn, args] of neg) {
      const r = await rpc(A.admin, fn, args);
      const fpNow = fp();
      expect(r.error, `${label} must fail`).not.toBeNull();
      expect(String(r.error?.message), label).toMatch(DENIED);
      expect(fpNow, `${label}: DB unchanged`).toBe(fpPrev);
      families.add(fn);
      rows.push(`${label} -> ${NOT_IN_ORG.test(r.error.message) ? "NOT_IN_ORG" : "DENIED"} "${short(r.error.message, 60)}"`);
      fpPrev = fpNow;
    }
    // create_supplier has no target entity (063 list, unguarded by design): it must land in the caller's org.
    const cs = ok(await rpc(A.admin, "create_supplier", { p_code: `QASUP2-${ts}`, p_name: `QA A Supplier Two ${ts}`, p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null, p_idempotency_key: uuid() }), "A create_supplier");
    const csRow = (await svcRows("suppliers", (q) => q.eq("id", cs.supplier.id), "org_id"))[0];
    expect(csRow.org_id).toBe(A.orgId);
    families.add("create_supplier");
    expect(families.size).toBe(31); // 30 guarded (070) + create_supplier

    // ---- positives in own org (one per RPC family; setup already ran PO create/approve/receive/
    // record payment, transfer create, open_shift, complete_sale, refund request, reprint, upload session).
    const pos: string[] = [];
    const P = async (label: string, client: SupabaseClient, fn: string, args: Record<string, unknown>) => {
      const r = await rpc(client, fn, args);
      expect(r.error, `${label}: ${r.error?.message}`).toBeNull();
      pos.push(label);
      return r.data;
    };
    await P("adjust_stock", A.admin, "adjust_stock", { p_shop_id: A.shop2, p_product_id: A.prods[1], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 3, p_reason: "QA own", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: uuid() });
    const adminShift = (await P("open_shift (ADMIN, own org shop2)", A.admin, "open_shift", { p_shop_id: A.shop2, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: uuid() })).shift.id;
    await P("close_shift", A.admin, "close_shift", { p_shift_id: adminShift, p_closing_cash_mmk: 0, p_variance_reason: "QA", p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: uuid() });
    await P("approve_refund_request (mgr)", A.mgr, "approve_refund_request", { p_request_id: A.request, p_idempotency_key: uuid() });
    const vreq = (await P("create_refund_void_request VOID", A.cash, "create_refund_void_request", { p_sale_id: A.sale2, p_type: "VOID", p_reason: "QA void", p_items: null, p_created_at: null, p_expected_actor_id: A.cashId, p_idempotency_key: uuid() })).request.id;
    await P("approve_void_request (admin)", A.admin, "approve_void_request", { p_request_id: vreq, p_idempotency_key: uuid() });
    const rreq = (await P("create_refund_void_request PARTIAL", A.cash, "create_refund_void_request", { p_sale_id: A.sale3, p_type: "PARTIAL", p_reason: "QA", p_items: [{ product_id: A.prods[0], qty_units: 1, amount_mmk: A.prices[0] }], p_created_at: null, p_expected_actor_id: A.cashId, p_idempotency_key: uuid() })).request.id;
    await P("reject_refund_void_request", A.mgr, "reject_refund_void_request", { p_request_id: rreq, p_reason: "QA", p_idempotency_key: uuid() });
    await P("cancel_purchase_order", A.admin, "cancel_purchase_order", { p_purchase_order_id: A.poDraft, p_reason: "QA", p_idempotency_key: uuid() });
    await P("pay_supplier_lump_sum", A.mgr, "pay_supplier_lump_sum", { p_supplier_id: A.sup, p_shop_id: A.shop, p_amount_mmk: 500, p_payment_method: "CASH", p_reference_no: null, p_notes: null, p_idempotency_key: uuid() });
    await P("void_supplier_payment", A.admin, "void_supplier_payment", { p_payment_id: A.payment, p_reason: "QA", p_idempotency_key: uuid() });
    await P("approve_stock_transfer (mgr)", A.mgr, "approve_stock_transfer", { p_transfer_id: A.transfer, p_idempotency_key: uuid() });
    await P("dispatch_stock_transfer (mgr)", A.mgr, "dispatch_stock_transfer", { p_transfer_id: A.transfer, p_created_at: null, p_expected_actor_id: A.mgrId, p_idempotency_key: uuid() });
    await P("receive_stock_transfer (admin @ shop2)", A.admin, "receive_stock_transfer", { p_transfer_id: A.transfer, p_received_items: null, p_created_at: null, p_expected_actor_id: A.adminId, p_idempotency_key: uuid() });
    const tr2 = (await P("create_stock_transfer", A.admin, "create_stock_transfer", { p_from_shop_id: A.shop, p_to_shop_id: A.shop2, p_notes: "QA 2", p_items: [{ product_id: A.prods[1], requested_qty: 1 }], p_idempotency_key: uuid() })).stockTransfer.id;
    await P("reject_stock_transfer", A.mgr, "reject_stock_transfer", { p_transfer_id: tr2, p_reason: "QA", p_idempotency_key: uuid() });
    const tr3 = (await P("create_stock_transfer #3", A.admin, "create_stock_transfer", { p_from_shop_id: A.shop, p_to_shop_id: A.shop2, p_notes: "QA 3", p_items: [{ product_id: A.prods[1], requested_qty: 1 }], p_idempotency_key: uuid() })).stockTransfer.id;
    await P("cancel_stock_transfer", A.admin, "cancel_stock_transfer", { p_transfer_id: tr3, p_reason: "QA", p_idempotency_key: uuid() });
    await P("update_supplier", A.admin, "update_supplier", { p_id: A.sup, p_code: A.supCode, p_name: `QA Supplier ${ts}`, p_contact_person: "QA", p_phone: null, p_email: null, p_address: null, p_notes: null, p_is_active: true, p_idempotency_key: uuid() });
    await P("log_audit_event", A.admin, "log_audit_event", { p_action_type: "PRODUCT_EDIT", p_message: "QA own", p_entity_type: "Product", p_entity_id: A.prods[0], p_shop_id: A.shop, p_idempotency_key: uuid() });
    await P("update_app_user", A.admin, "update_app_user", { p_id: `qa-a-user-staff-${ts}`, p_name: "QA A Staff Renamed", p_role: "CASHIER", p_shop_id: A.shop, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() });
    await P("replace_manager (shop2 <- staff)", A.admin, "replace_manager", { p_shop_id: A.shop2, p_new_manager_id: `qa-a-user-staff-${ts}`, p_idempotency_key: uuid() });
    await P("deactivate_app_user", A.admin, "deactivate_app_user", { p_id: `qa-a-user-staff-${ts}`, p_is_active: false, p_idempotency_key: uuid() });
    const delId = `qa-a-delprod-${ts}`;
    const dIns = await A.admin.from("products").insert({ id: delId, name: "QA A Delete Me", category: "QA", unit_type: "pcs", price_mmk: 1, is_active: true });
    expect(dIns.error).toBeNull();
    await P("delete_product", A.admin, "delete_product", { p_product_id: delId, p_idempotency_key: uuid() });
    expect(await svcCount("products", (q) => q.eq("id", delId))).toBe(0);
    const staff = (await svcRows("users", (q) => q.eq("id", `qa-a-user-staff-${ts}`), "org_id, role, shop_id, is_active"))[0];
    expect(staff).toMatchObject({ org_id: A.orgId, role: "MANAGER", shop_id: A.shop2, is_active: false });
    // org B untouched by everything above
    const bState = (await svcRows("users", (q) => q.eq("id", B.cashId), "name, is_active, shop_id"))[0];
    expect(bState).toMatchObject({ name: "QA B Cashier", is_active: true, shop_id: B.shop });
    expect((await svcRows("stock_transfers", (q) => q.eq("id", B.transfer), "status"))[0].status).toMatch(/PENDING|DRAFT|REQUESTED/);
    ev.pass("4 RPC org guards", `${neg.length} cross-org calls over ${families.size - 1} guarded RPCs, all rejected, QA fingerprint unchanged after each (start ${fpStart}): ${rows.join("; ")} || create_supplier (no target) -> new supplier org_id=${csRow.org_id} || own-org positives OK: setup(create/approve/receive PO, record_supplier_payment, create_stock_transfer, open_shift, complete_sale x3, create_refund_void_request, log_receipt_reprint, create_product_image_upload_session, create_app_user, create_supplier) + ${pos.join(", ")}; staff now MANAGER of shop2, inactive`);
  });

  // =========================================================================
  it("5. role boundaries within an org (cashier, manager of another shop, buyer)", async () => {
    const notes: string[] = [];
    const deny = async (label: string, client: SupabaseClient, fn: string, args: Record<string, unknown>) => {
      const r = await rpc(client, fn, args);
      expect(r.error, `${label} must fail`).not.toBeNull();
      expect(String(r.error.message), label).toMatch(DENIED);
      notes.push(`${label} -> "${short(r.error.message, 55)}"`);
    };
    // a fresh DRAFT PO so the permission check (not the status check) is what answers
    const draft = ok(await rpc(A.admin, "create_purchase_order", { p_shop_id: A.shop, p_supplier_id: A.sup, p_notes: "QA draft 5", p_items: [{ product_id: A.prods[1], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: uuid() }), "draft PO").purchaseOrder.id;
    const fp0 = fp();
    // cashier A
    await deny("cashier approve_purchase_order(DRAFT)", A.cash, "approve_purchase_order", { p_purchase_order_id: draft, p_idempotency_key: uuid() });
    await deny("cashier adjust_stock", A.cash, "adjust_stock", { p_shop_id: A.shop, p_product_id: A.prods[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.cashId, p_idempotency_key: uuid() });
    await deny("cashier create_app_user", A.cash, "create_app_user", { p_id: `qa-user-c-${ts}`, p_name: "QA", p_email: `qa-c-${ts}@qa.invalid`, p_role: "CASHIER", p_shop_id: A.shop, p_auth_id: null, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() });
    await deny("cashier create_purchase_order", A.cash, "create_purchase_order", { p_shop_id: A.shop, p_supplier_id: A.sup, p_notes: "QA", p_items: [{ product_id: A.prods[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: uuid() });
    await deny("cashier approve_refund_request", A.cash, "approve_refund_request", { p_request_id: A.request, p_idempotency_key: uuid() });
    const cProd = await A.cash.from("products").insert({ id: `qa-cprod-${ts}`, name: "QA C", category: "QA", unit_type: "pcs", price_mmk: 1, is_active: true });
    expect(cProd.error).not.toBeNull();
    notes.push(`cashier insert product -> ${cProd.error?.code}`);
    // manager A on the other shop of its own org
    await deny("manager open_shift(shop2)", A.mgr, "open_shift", { p_shop_id: A.shop2, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: A.mgrId, p_idempotency_key: uuid() });
    await deny("manager adjust_stock(shop2)", A.mgr, "adjust_stock", { p_shop_id: A.shop2, p_product_id: A.prods[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.mgrId, p_idempotency_key: uuid() });
    await deny("manager create_purchase_order(shop2)", A.mgr, "create_purchase_order", { p_shop_id: A.shop2, p_supplier_id: A.sup, p_notes: "QA", p_items: [{ product_id: A.prods[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: uuid() });
    await deny("manager create_app_user", A.mgr, "create_app_user", { p_id: `qa-user-m-${ts}`, p_name: "QA", p_email: `qa-m-${ts}@qa.invalid`, p_role: "CASHIER", p_shop_id: A.shop, p_auth_id: null, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() });
    const mInv = await A.mgr.from("inventory").select("product_id").eq("shop_id", A.shop2);
    expect(mInv.data).toEqual([]);
    const mOwn = await A.mgr.from("inventory").select("product_id").eq("shop_id", A.shop);
    expect(mOwn.data!.length).toBeGreaterThan(0);
    notes.push(`manager inventory shop2=[] own=${mOwn.data!.length}`);
    // manager of org B on org A
    await deny("B manager adjust_stock(shop A)", B.mgr, "adjust_stock", { p_shop_id: A.shop, p_product_id: A.prods[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: B.mgrId, p_idempotency_key: uuid() });
    expect(fp()).toBe(fp0);
    // buyer: created by the ADMIN (positive), may create a PO for its own shop, nothing else
    const buyerEmail = `qa-buyer-${ts}@qa.invalid`;
    const buyerAuth = await createAuthUser(cfg, buyerEmail, password);
    const buyerId = `qa-user-buyer-${ts}`;
    ok(await rpc(A.admin, "create_app_user", { p_id: buyerId, p_name: "QA Buyer", p_email: buyerEmail, p_role: "BUYER", p_shop_id: A.shop, p_auth_id: buyerAuth, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() }), "create buyer");
    const buyer = await signedInClient(cfg, buyerEmail, password);
    const bpo = await rpc(buyer, "create_purchase_order", { p_shop_id: A.shop, p_supplier_id: A.sup, p_notes: "QA buyer", p_items: [{ product_id: A.prods[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: uuid() });
    expect(bpo.error).toBeNull();
    notes.push(`buyer create_purchase_order(own shop) -> ${bpo.data.purchaseOrder.id}`);
    const fpB = fp();
    await deny("buyer create_purchase_order(shop2)", buyer, "create_purchase_order", { p_shop_id: A.shop2, p_supplier_id: A.sup, p_notes: "QA", p_items: [{ product_id: A.prods[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: uuid() });
    await deny("buyer approve_purchase_order", buyer, "approve_purchase_order", { p_purchase_order_id: bpo.data.purchaseOrder.id, p_idempotency_key: uuid() });
    await deny("buyer adjust_stock", buyer, "adjust_stock", { p_shop_id: A.shop, p_product_id: A.prods[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: buyerId, p_idempotency_key: uuid() });
    await deny("buyer open_shift", buyer, "open_shift", { p_shop_id: A.shop, p_opening_cash_mmk: 0, p_created_at: null, p_expected_actor_id: buyerId, p_idempotency_key: uuid() });
    await deny("buyer create_purchase_order(shop B)", buyer, "create_purchase_order", { p_shop_id: B.shop, p_supplier_id: A.sup, p_notes: "QA", p_items: [{ product_id: A.prods[0], ordered_qty: 1, unit_cost_mmk: 1 }], p_idempotency_key: uuid() });
    const buyerProducts = await buyer.from("products").select("id").in("id", B.prods);
    expect(buyerProducts.data).toEqual([]);
    expect(fp()).toBe(fpB);
    await buyer.auth.signOut();
    ev.pass("5 role boundaries", `${notes.join("; ")}; QA fingerprint unchanged by every denied call`);
  });

  // =========================================================================
  it("6. cross-org foreign references are rejected (incl. a client-supplied org_id of the other org)", async () => {
    const notes: string[] = [];
    const fp0 = fp();
    const reject = async (label: string, p: PromiseLike<{ error: any }>) => {
      const r = await p;
      expect(r.error, `${label} must be rejected`).not.toBeNull();
      notes.push(`${label} -> ${r.error.code ?? ""} "${short(r.error.message, 50)}"`);
    };
    const a = A.admin;
    await reject("product with org B brand_id", a.from("products").insert({ id: `qa-x1-${ts}`, name: "QA X1", category: "QA", unit_type: "pcs", price_mmk: 1, is_active: true, brand_id: B.brand }));
    await reject("product with org B brand_id + org_id=B", a.from("products").insert({ id: `qa-x2-${ts}`, name: "QA X2", category: "QA", unit_type: "pcs", price_mmk: 1, is_active: true, brand_id: B.brand, org_id: B.orgId }));
    await reject("product with org_id=B", a.from("products").insert({ id: `qa-x3-${ts}`, name: "QA X3", category: "QA", unit_type: "pcs", price_mmk: 1, is_active: true, org_id: B.orgId }));
    await reject("brand with org B category", a.from("brands").insert({ id: `qa-x4-${ts}`, category_id: B.cat, name: "QA X4", is_active: true, sort_order: 0 }));
    await reject("brand with org B category + org_id=B", a.from("brands").insert({ id: `qa-x5-${ts}`, category_id: B.cat, name: "QA X5", is_active: true, sort_order: 0, org_id: B.orgId }));
    await reject("category with org_id=B", a.from("categories").insert({ id: `qa-x6-${ts}`, name: "QA X6", color: "#000000", is_active: true, org_id: B.orgId }));
    await reject("supplier with org_id=B", a.from("suppliers").insert({ id: `qa-x7-${ts}`, code: `QAX7${ts}`, name: "QA X7", is_active: true, org_id: B.orgId }));
    await reject("price_level with org_id=B", a.from("price_levels").insert({ id: `qa-x8-${ts}`, code: `QAX8${ts}`, name: "QA X8", is_default: false, is_active: true, sort_order: 0, org_id: B.orgId }));
    await reject("unit price with org B price_level", a.from("product_unit_prices").insert({ id: `qa-x9-${ts}`, product_unit_id: A.units[1], price_level_id: B.priceLevel, shop_id: null, price_mmk: 1, is_active: true }));
    await reject("unit price with org B shop", a.from("product_unit_prices").insert({ id: `qa-x10-${ts}`, product_unit_id: A.units[1], price_level_id: A.priceLevel, shop_id: B.shop, price_mmk: 1, is_active: true }));
    await reject("unit price on org B unit", a.from("product_unit_prices").insert({ id: `qa-x11-${ts}`, product_unit_id: B.units[1], price_level_id: A.priceLevel, shop_id: null, price_mmk: 1, is_active: true }));
    await reject("price tier with org B shop", a.from("price_tiers").insert({ id: `qa-x12-${ts}`, product_id: A.prods[1], shop_id: B.shop, min_qty: 5, price_mmk: 1, is_active: true, created_by: A.adminId }));
    await reject("price tier on org B product", a.from("price_tiers").insert({ id: `qa-x13-${ts}`, product_id: B.prods[1], shop_id: null, min_qty: 5, price_mmk: 1, is_active: true, created_by: A.adminId }));
    await reject("supplier_products with org B supplier", a.from("supplier_products").insert({ supplier_id: B.sup, product_id: A.prods[1] }));
    await reject("supplier_products with org B product", a.from("supplier_products").insert({ supplier_id: A.sup, product_id: B.prods[1] }));
    await reject("product_units on org B product", a.from("product_units").insert({ id: `qa-x14-${ts}`, product_id: B.prods[1], name: "pcs", base_quantity: 1, is_default: false, is_active: true, sale_price_mmk: 1 }));
    await reject("barcode on org B product", a.from("product_barcodes").insert({ id: `qa-x15-${ts}`, product_id: B.prods[1], value: `QAX15${ts}`, type: "CODE128" }));
    await reject("barcode on org B product + org_id=A", a.from("product_barcodes").insert({ id: `qa-x16-${ts}`, product_id: B.prods[1], value: `QAX16${ts}`, type: "CODE128", org_id: A.orgId }));
    await reject("shop with org_id=B", a.from("shops").insert({ id: `qa-x17-${ts}`, code: `QX17${ts.slice(-5)}`, name: `QA X17 ${ts}`, address: "QA", is_active: false, org_id: B.orgId }));
    await reject("users row into org B", a.from("users").insert({ id: `qa-x18-${ts}`, name: "QA X18", email: `qa-x18-${ts}@qa.invalid`, role: "CASHIER", shop_id: B.shop, org_id: B.orgId, is_active: true }));
    // moving an own row to the other org / pointing it at a foreign brand
    const mv = await a.from("products").update({ org_id: B.orgId }).eq("id", A.prods[2]).select("id");
    expect(mv.error !== null || mv.data!.length === 0).toBe(true);
    notes.push(`move own product to org B -> ${mv.error?.code ?? `${mv.data!.length} rows`}`);
    await reject("update own product brand_id -> org B brand", a.from("products").update({ brand_id: B.brand }).eq("id", A.prods[2]).select("id"));
    const leaked = await svcCount("products", (q) => q.like("id", `qa-x%-${ts}`));
    expect(leaked).toBe(0);
    expect((await svcRows("products", (q) => q.eq("id", A.prods[2]), "org_id, brand_id"))[0]).toMatchObject({ org_id: A.orgId, brand_id: null });
    expect(fp()).toBe(fp0);
    // The same references inside one org are accepted (the guard is not just blocking everything).
    const okBrandProd = await a.from("products").insert({ id: `qa-a-brandprod-${ts}`, name: "QA A Branded", category: "QA", unit_type: "pcs", price_mmk: 1, is_active: false, brand_id: A.brand });
    expect(okBrandProd.error).toBeNull();
    ev.pass("6 cross-org references", `${notes.join("; ")}; DB: 0 qa-x rows, QA fingerprint unchanged; same-org brand reference accepted`);
  });

  // =========================================================================
  it("7. storage: org isolation of objects; anon cannot list; public URL reads of real images unchanged", async () => {
    const notes: string[] = [];
    const st = (c: SupabaseClient) => c.storage.from(BUCKET);
    // uploads exactly like the app (src/lib/productImageStorage.ts: upsert true)
    for (const o of [A, B]) {
      const up = await st(o.admin).upload(o.objectPath, TINY_WEBP, { contentType: "image/webp", upsert: true });
      expect(up.error, `${o.key} upload: ${up.error?.message}`).toBeNull();
      uploaded.push({ client: () => o.admin, path: o.objectPath });
    }
    const objRows = runSql(cfg, `SELECT name || '|' || COALESCE(owner_id, owner::text) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name IN ('${A.objectPath}', '${B.objectPath}') ORDER BY name;`).trim().split("\n");
    expect(objRows).toHaveLength(2);
    expect(objRows.find((r) => r.startsWith(A.objectPath))!.endsWith(A.adminAuth)).toBe(true);
    expect(objRows.find((r) => r.startsWith(B.objectPath))!.endsWith(B.adminAuth)).toBe(true);
    notes.push(`uploads OK, owners = each org's ADMIN auth uid`);
    // RLS (071) evaluated exactly as PostgREST/storage-api would for each ADMIN's JWT.
    for (const [x, y] of [[A, B], [B, A]] as const) {
      const vis = runSql(cfg, `BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${x.adminAuth}","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT (SELECT count(*) FROM storage.objects WHERE name = '${x.objectPath}') || '/' || (SELECT count(*) FROM storage.objects WHERE name = '${y.objectPath}');
ROLLBACK;`).trim().split("\n").filter((l) => /^\d+\/\d+$/.test(l))[0];
      expect(vis, `${x.key} RLS view own/other`).toBe("1/0");
      notes.push(`${x.key} ADMIN under RLS sees own object=1, ${y.key}'s=0`);
    }
    const sha = (b: ArrayBuffer | Buffer) => createHash("sha256").update(Buffer.from(b as ArrayBuffer)).digest("hex");
    const original = sha(TINY_WEBP);

    for (const [x, y] of [[A, B], [B, A]] as const) {
      const ownDl = await st(x.admin).download(x.objectPath);
      expect(ownDl.error).toBeNull();
      // GET /object/<bucket>/<path>: for a PUBLIC bucket storage-api serves the object
      // without consulting RLS (same bytes as the public URL). Not an RLS bypass as long as
      // the anonymous key gets the very same answer (checked below) while every RLS-backed
      // operation (sign, list, overwrite, update, remove, move) is refused.
      const dl = await st(x.admin).download(y.objectPath);
      const anonSame = await anon.storage.from(BUCKET).download(y.objectPath);
      expect(dl.error === null, `${x.key} download ${y.key} must behave exactly like anon (public bucket)`).toBe(anonSame.error === null);
      const signed = await st(x.admin).createSignedUrl(y.objectPath, 60);
      expect(signed.error, `${x.key} sign ${y.key}`).not.toBeNull();
      const listOther = await st(x.admin).list(y.objectPath.split("/").slice(0, 2).join("/"));
      expect(listOther.data ?? []).toEqual([]);
      const listOwn = await st(x.admin).list(x.objectPath.split("/").slice(0, 2).join("/"));
      expect((listOwn.data ?? []).length).toBe(1);
      const over = await st(x.admin).upload(y.objectPath, Buffer.from("QA overwrite"), { contentType: "image/webp", upsert: true });
      expect(over.error, `${x.key} overwrite ${y.key}`).not.toBeNull();
      const upd = await st(x.admin).update(y.objectPath, Buffer.from("QA update"), { contentType: "image/webp" });
      expect(upd.error, `${x.key} update ${y.key}`).not.toBeNull();
      const rm = await st(x.admin).remove([y.objectPath]);
      expect(rm.data ?? []).toEqual([]);
      const mv = await st(x.admin).move(y.objectPath, `${y.objectPath}.moved`);
      expect(mv.error, `${x.key} move ${y.key}`).not.toBeNull();
      // still there, byte-identical (service role read)
      const check = await svc.storage.from(BUCKET).download(y.objectPath);
      expect(check.error).toBeNull();
      expect(sha(await check.data!.arrayBuffer())).toBe(original);
      notes.push(`${x.key}->${y.key}: download ${dl.error ? "denied" : "served (public bucket; anon also served)"}, signedUrl ${signed.error ? "denied" : "OK"}, list=[] (own list=${listOwn.data!.length}), upsert-overwrite "${short(over.error?.message, 40)}", update "${short(upd.error?.message, 40)}", remove -> [] , move "${short(mv.error?.message, 30)}", object intact (sha256 ok)`);
    }
    // F13 residual (documented, not fixed by 071): INSERT is permission-only, so org A can create a
    // NEW object under org B's product folder. Recorded as INFO; the object is removed again by its owner.
    const residualPath = `products/${B.prods[0]}/qa-g-residual-${ts}.webp`;
    const residual = await st(A.admin).upload(residualPath, TINY_WEBP, { contentType: "image/webp", upsert: false });
    if (!residual.error) uploaded.push({ client: () => A.admin, path: residualPath });
    notes.push(`F13 residual: org A new object under org B product folder -> ${residual.error ? `rejected (${short(residual.error.message, 40)})` : "ACCEPTED (INSERT not path-scoped; known, frontend change needed)"}`);
    // anon
    for (const prefix of ["", "products", "temp", A.objectPath.split("/").slice(0, 2).join("/")]) {
      const l = await anon.storage.from(BUCKET).list(prefix);
      expect(l.data ?? [], `anon list "${prefix}"`).toEqual([]);
    }
    const anonDl = await anon.storage.from(BUCKET).download(A.objectPath);
    const anonUp = await anon.storage.from(BUCKET).upload(`products/qa-anon-${ts}.webp`, TINY_WEBP, { contentType: "image/webp" });
    expect(anonUp.error).not.toBeNull();
    notes.push(`anon list ("", products, temp, own folder) -> [] x4; anon authenticated-download -> ${anonDl.error ? "denied" : "allowed"}; anon upload -> denied`);
    // public URL reads: a real image (unchanged vs the migration manifest) and the QA object (public bucket, by design)
    const manifestPath = process.env.LIVE_STORAGE_MANIFEST ?? `${homedir()}/shwephala-migration/20261011T2347Z/storage-manifest.sha256`;
    const manifest = readFileSync(manifestPath, "utf8").trim().split("\n").map((l) => l.split(/\s+/));
    const realProduct = (await svcRows("products", (q) => q.eq("org_id", REAL_ORG).not("image_url", "is", null).order("id").limit(1), "id, image_url"))[0];
    const realPath = String(realProduct.image_url).split(`/object/public/${BUCKET}/`)[1];
    const entry = manifest.find(([, p]) => p === realPath);
    expect(entry, `manifest entry for ${realPath}`).toBeTruthy();
    const pub = await fetch(realProduct.image_url);
    expect(pub.status).toBe(200);
    const pubSha = sha(await pub.arrayBuffer());
    expect(pubSha).toBe(entry![0]);
    const pubQa = await fetch(`${cfg.url}/storage/v1/object/public/${BUCKET}/${B.objectPath}`);
    notes.push(`real product ${realProduct.id} image_url GET -> ${pub.status}, sha256 ${pubSha.slice(0, 16)}… == manifest; public URL of org B QA object -> ${pubQa.status} (public bucket by design)`);
    ev.pass("7 storage isolation", notes.join("; "));
  });

  // =========================================================================
  it("8. Realtime: org A cashier (and admin) get own-org inventory updates and nothing for org B within 10 s", async () => {
    const subscribe = async (client: SupabaseClient, name: string) => {
      const events: any[] = [];
      const systemMsgs: any[] = [];
      const channel = client.channel(name);
      channel.on("postgres_changes", { event: "*", schema: "public", table: "inventory" }, (p) => events.push(p));
      (channel as any).on("system", {}, (p: any) => systemMsgs.push(p));
      const status = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("TIMEOUT(20s)"), 20_000);
        channel.subscribe((s, err) => {
          if (s === "SUBSCRIBED") { clearTimeout(timer); resolve(s); }
          if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") { clearTimeout(timer); resolve(`${s}${err ? `: ${err.message}` : ""}`); }
        });
      });
      expect(status).toBe("SUBSCRIBED");
      const ready = await waitFor(() => Promise.resolve(systemMsgs.find((m) => m.extension === "postgres_changes" && m.status === "ok")), 20_000, 100);
      expect(ready, `${name}: postgres_changes never confirmed: ${JSON.stringify(systemMsgs)}`).toBeTruthy();
      return { channel, events };
    };
    const cashSub = await subscribe(A.cash, `qa-g-cash-${ts}`);
    const adminSub = await subscribe(A.admin, `qa-g-admin-${ts}`);
    await sleep(500);

    // own org: manager A adjusts shop A
    const q0 = await inv(A.shop, A.prods[1]);
    ok(await rpc(A.mgr, "adjust_stock", { p_shop_id: A.shop, p_product_id: A.prods[1], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA rt own", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.mgrId, p_idempotency_key: uuid() }), "rt own adjust");
    const t0 = Date.now();
    const ownCash = await waitFor(() => Promise.resolve(cashSub.events.find((e) => e.new?.shop_id === A.shop && e.new?.product_id === A.prods[1])), 10_000, 100);
    const lat = Date.now() - t0;
    const ownAdmin = await waitFor(() => Promise.resolve(adminSub.events.find((e) => e.new?.shop_id === A.shop && e.new?.product_id === A.prods[1])), 10_000, 100);
    expect(ownCash, "cashier A got no own-shop event").toBeTruthy();
    expect(ownAdmin, "admin A got no own-org event").toBeTruthy();
    expect(ownCash!.new.qty_base_units).toBe(q0 + 1);

    // org B change
    const cBefore = cashSub.events.length;
    const aBefore = adminSub.events.length;
    const qb = await inv(B.shop, B.prods[1]);
    ok(await rpc(B.admin, "adjust_stock", { p_shop_id: B.shop, p_product_id: B.prods[1], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA rt org B", p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: B.adminId, p_idempotency_key: uuid() }), "rt B adjust");
    expect(await inv(B.shop, B.prods[1])).toBe(qb + 1);
    await sleep(10_000);
    const leakCash = cashSub.events.slice(cBefore).filter((e) => [B.shop, B.shop2].includes(e.new?.shop_id) || B.prods.includes(e.new?.product_id));
    const leakAdmin = adminSub.events.slice(aBefore).filter((e) => [B.shop, B.shop2].includes(e.new?.shop_id) || B.prods.includes(e.new?.product_id));
    expect(leakCash).toEqual([]);
    expect(leakAdmin).toEqual([]);
    const allForeign = [...cashSub.events, ...adminSub.events].filter((e) => ![A.shop, A.shop2].includes(e.new?.shop_id ?? e.old?.shop_id));
    expect(allForeign).toEqual([]);
    await A.cash.removeChannel(cashSub.channel);
    await A.admin.removeChannel(adminSub.channel);
    ev.pass("8 realtime isolation", `cashier A + admin A subscribed (postgres_changes confirmed); own-shop UPDATE received by cashier in ${lat} ms (qty ${q0}->${q0 + 1}) and by admin; org B update (${B.shop} ${qb}->${qb + 1}) -> 0 events to cashier A and 0 to admin A in 10 s; total events cashier=${cashSub.events.length} admin=${adminSub.events.length}, none outside org A shops`);
  });

  // =========================================================================
  it("9. staff management across orgs", async () => {
    const notes: string[] = [];
    const fp0 = fp();
    const xEmail = `qa-xstaff-${ts}@qa.invalid`;
    const xAuth = await createAuthUser(cfg, xEmail, password);
    const into = await rpc(A.admin, "create_app_user", { p_id: `qa-user-xstaff-${ts}`, p_name: "QA X Staff", p_email: xEmail, p_role: "CASHIER", p_shop_id: B.shop, p_auth_id: xAuth, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() });
    expect(into.error?.message).toMatch(NOT_IN_ORG);
    expect(await svcCount("users", (q) => q.eq("id", `qa-user-xstaff-${ts}`))).toBe(0);
    expect(fp()).toBe(fp0);
    notes.push(`A create_app_user into shop B -> "${into.error?.message}", no row`);
    const own = await rpc(A.admin, "create_app_user", { p_id: `qa-user-xstaff-${ts}`, p_name: "QA X Staff", p_email: xEmail, p_role: "CASHIER", p_shop_id: A.shop, p_auth_id: xAuth, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() });
    expect(own.error).toBeNull();
    const ownRow = (await svcRows("users", (q) => q.eq("id", `qa-user-xstaff-${ts}`), "org_id, shop_id, role"))[0];
    expect(ownRow).toMatchObject({ org_id: A.orgId, shop_id: A.shop, role: "CASHIER" });
    notes.push(`A create_app_user into shop A -> users row org_id=${ownRow.org_id}`);
    const fp1 = fp();
    const deact = await rpc(B.admin, "deactivate_app_user", { p_id: A.cashId, p_is_active: false, p_idempotency_key: uuid() });
    const upd = await rpc(B.admin, "update_app_user", { p_id: A.cashId, p_name: "QA hacked", p_role: "MANAGER", p_shop_id: B.shop, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() });
    const rest = await B.admin.from("users").update({ is_active: false, name: "QA hacked" }).eq("id", A.cashId).select("id");
    const replace = await rpc(B.admin, "replace_manager", { p_shop_id: B.shop2, p_new_manager_id: A.cashId, p_idempotency_key: uuid() });
    expect(deact.error?.message).toMatch(NOT_IN_ORG);
    expect(upd.error?.message).toMatch(NOT_IN_ORG);
    expect(rest.error !== null || rest.data!.length === 0).toBe(true);
    expect(replace.error?.message).toMatch(NOT_IN_ORG);
    const aCash = (await svcRows("users", (q) => q.eq("id", A.cashId), "name, is_active, role, shop_id, org_id"))[0];
    expect(aCash).toMatchObject({ name: "QA Cashier A", is_active: true, role: "CASHIER", shop_id: A.shop, org_id: A.orgId });
    expect(fp()).toBe(fp1);
    notes.push(`B deactivate_app_user(A cashier) -> "${deact.error?.message}"; B update_app_user -> "${upd.error?.message}"; B REST update users -> ${rest.error?.code ?? `${rest.data!.length} rows`}; B replace_manager(B shop2 <- A cashier) -> "${replace.error?.message}"; A cashier row unchanged (active CASHIER of ${A.shop}, org ${A.orgId})`);
    ev.pass("9 staff management", notes.join("; "));
  });

  // =========================================================================
  it("10. anonymous: only app_setup_needed + the phone-upload RPCs (two < 083, one >= 083); every table read empty or denied", async () => {
    // 083 (G5): complete_product_image_upload_session is service_role only; the
    // phone completes through phone-upload-token {action:"complete"}.
    const post083 = isPost083(schemaVersion(cfg));
    const granted = runSql(cfg, `SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE');`).trim();
    expect(granted).toBe(post083 ? "app_setup_needed,get_product_image_upload_session_by_token" : "app_setup_needed,complete_product_image_upload_session,get_product_image_upload_session_by_token");
    const completeArgs = { p_token: "0".repeat(128), p_storage_path: "temp/x", p_public_url: `${cfg.url}/x`, p_bytes: 1, p_mime_type: "image/webp" };
    const allowed: [string, Record<string, unknown>][] = [
      ["app_setup_needed", {}],
      ["get_product_image_upload_session_by_token", { p_token: "0".repeat(128) }],
      ...(post083 ? [] : [["complete_product_image_upload_session", completeArgs] as [string, Record<string, unknown>]]),
    ];
    let fnNote = "";
    if (post083) {
      const fn = await completeThroughFunction(cfg, "0".repeat(128));
      expect(fn.httpStatus).toBe(404);
      expect(fn.code).toBe("invalid");
      fnNote = `; phone-upload-token {action:"complete"} with an unknown token -> ${fn.httpStatus} ${fn.code}`;
    }
    const allowedOut: string[] = [];
    for (const [fn, args] of allowed) {
      const r = await rpc(anon, fn, args as Record<string, unknown>);
      expect(r.error?.code ?? "ok").not.toBe("42501");
      allowedOut.push(`${fn}=${r.error ? `"${short(r.error.message, 25)}"` : JSON.stringify(r.data)}`);
    }
    const sample: Record<string, Record<string, unknown>> = {
      complete_sale: { p_shop_id: A.shop, p_shift_id: A.shift, p_payment_method: "CASH", p_paid_mmk: 1, p_cart_discount_pct: 0, p_items: [], p_created_at: null, p_idempotency_key: uuid() },
      adjust_stock: { p_shop_id: A.shop, p_product_id: A.prods[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "x", p_idempotency_key: uuid() },
      open_shift: { p_shop_id: A.shop, p_opening_cash_mmk: 0, p_idempotency_key: uuid() },
      create_app_user: { p_id: "qa-user-anon", p_name: "QA Anon", p_email: "qa-anon@qa.invalid", p_role: "CASHIER", p_shop_id: A.shop, p_auth_id: null, p_idempotency_key: uuid() },
      create_supplier: { p_code: "QAANON", p_name: "QA Anon", p_idempotency_key: uuid() },
      create_purchase_order: { p_shop_id: A.shop, p_supplier_id: A.sup, p_notes: null, p_items: [], p_idempotency_key: uuid() },
      delete_product: { p_product_id: A.prods[0], p_idempotency_key: uuid() },
      create_product_image_upload_session: { p_shop_id: A.shop, p_product_id: A.prods[0] },
      app_org_id: {}, app_role: {}, app_user_id: {}, current_app_user: {}, app_org_shop_ids: {}, app_shop_in_org: { p_shop_id: A.shop },
      app_storage_owner_in_org: { p_owner_id: null, p_owner: null },
      app_require_org: { p_kind: "shop", p_id: B.shop },
      role_default_permissions: { p_role: "ADMIN" },
      bootstrap_first_admin: {}, // 076: authenticated + service_role only
      ...(post083 ? { complete_product_image_upload_session: completeArgs } : {}), // 083: service_role only
    };
    const codes: string[] = [];
    for (const [fn, args] of Object.entries(sample)) {
      const r = await rpc(anon, fn, args);
      codes.push(`${fn}=${r.error?.code}`);
      expect(r.error?.code, `anon ${fn}`).toBe("42501");
    }
    const tables = ["organizations", "shops", "users", "business_profile", "products", "product_units", "product_unit_prices", "product_barcodes", "price_tiers", "categories", "brands", "suppliers", "supplier_products", "price_levels", "unit_types", "inventory", "inventory_movements", "sales", "sale_items", "shifts", "purchase_orders", "purchase_order_items", "supplier_payments", "stock_transfers", "stock_transfer_items", "refund_void_requests", "reprint_logs", "audit_logs", "product_image_upload_sessions", "platform_admins", "admin_login_codes", "idempotency_keys", "rbac_assignment_violations"];
    const reads: string[] = [];
    for (const t of tables) {
      const r = await anon.from(t).select("*").limit(3);
      const okEmpty = (r.error === null && (r.data ?? []).length === 0) || r.error !== null;
      expect(okEmpty, `anon read ${t}: ${JSON.stringify(r.data)?.slice(0, 80)}`).toBe(true);
      reads.push(`${t}=${r.error ? r.error.code : `[]`}`);
    }
    const anonIns = await anon.from("organizations").insert({ id: `qa-org-anon-${ts}`, name: "QA Anon Org" });
    expect(anonIns.error).not.toBeNull();
    expect(await svcCount("users", (q) => q.eq("id", "qa-user-anon"))).toBe(0);
    ev.pass("10 anonymous surface", `anon EXECUTE (pg_proc) = {${granted}}; allowed calls: ${allowedOut.join(" ")}${fnNote}; denied: ${codes.join(" ")}; table reads: ${reads.join(" ")}; anon organizations insert -> ${anonIns.error?.code}`);
  });
});
