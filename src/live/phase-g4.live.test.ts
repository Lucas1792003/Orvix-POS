/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Phase G4 LIVE checks for migration 080 (phone-upload completion URL derived
// server-side from public.app_config; the object must exist) and the deployed
// phone-upload-token Edge Function, against the self-hosted stack through
// its public API (@supabase/supabase-js + plain fetch where the exact HTTP
// status matters). docs/selfhost-migration/phase-g/migration-080.md,
// phone-upload-jit.md.
//
//   1 session creation refused for another org's product / shop, a real-org
//     product, an unknown product, and anon
//   2 completion: wrong bucket, another session's / org's path, encoded and
//     malformed path + URL variants (%2F, %2e%2e, //, upper case, trailing
//     slash, query, fragment, ...) -> all refused, session stays PENDING
//   3 external host with the exact path -> ignored: stored / returned /
//     polled URL is the trusted one, the foreign host is nowhere
//   4 missing storage object -> refused, PENDING; completes once uploaded
//   5 duplicate completion (concurrent + sequential) -> one completion
//   6 expired / cancelled (object present) -> refused
//   7 anon / authenticated: no access to public.app_config, no EXECUTE on
//     app_upload_session_public_url
//   8 function abuse: 50 sequential + 50 concurrent token requests for one
//     live session, 50 invalid-token requests (measured, nothing changed)
//
// Skipped unless LIVE_SUPABASE_URL is set. QA data only: organizations
// created the console way (service-role INSERT + ADMIN row), ids qa-g4<x>-,
// emails @qa.invalid. Rows: supabase/tests/phase-d/live/cleanup.sql (+
// phase-e audit_purge.sql); storage objects (all under org/qa-g4...) are
// removed by this suite through the Storage API in afterAll. Every object is
// created the real way (token from the deployed function, PUT to storage).
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Evidence, liveConfig, makeClient, randomPassword, runSql, signUpUser, signedInClient, type LiveConfig } from "./liveHelpers";

const LIVE = Boolean(process.env.LIVE_SUPABASE_URL);
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const BUCKET = "product-images";
const REAL_ORG = "org-shwe-pha-lar";
const FN = "/functions/v1/phone-upload-token";
// 34-byte lossless WebP (same constant as phase-g3 / spec D).
const TINY_WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const INACTIVE = "Upload link is no longer active";
const PATH_MISMATCH = "Upload path does not match this session";
const URL_MISMATCH = "Uploaded image URL does not match this upload session";
const NOT_FOUND = "Uploaded image was not found in storage";
const NOT_IN_ORG = /not found in your organization/i;

type Rpc = { data: any; error: any; status: number };
const rpc = async (client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<Rpc> => {
  const res = await client.rpc(name, args);
  return { data: res.data, error: res.error, status: res.status };
};
const ok = (r: Rpc, what: string): any => {
  if (r.error) throw new Error(`${what} failed: ${r.error.message} (${r.error.code})`);
  return r.data;
};
const short = (s: unknown, n = 70) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const jwtPayload = (t: string): any => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));

interface Org { key: string; orgId: string; adminId: string; adminAuth: string; email: string; admin: SupabaseClient; shop: string; prod: string }
interface Sess { sessionId: string; token: string; storagePath: string }

describe.skipIf(!LIVE)("Phase G4 live checks for 080 + the deployed phone-upload-token function (self-hosted stack)", () => {
  const ev = new Evidence();
  let cfg: LiveConfig;
  const ts = String(Date.now());
  const password = randomPassword();
  let svc: SupabaseClient;
  let anon: SupabaseClient;
  const A = { key: "a" } as Org;
  const B = { key: "b" } as Org;
  let trusted = "";
  let configBefore = "";
  let realBefore = "";

  const sql1 = (q: string): string => runSql(cfg, q).trim();
  const derived = (p: string) => `${trusted}/storage/v1/object/public/${BUCKET}/${p}`;
  const url = (p: string, base = cfg.url) => `${base}/storage/v1/object/public/${BUCKET}/${p}`;
  const sessRow = (id: string) => sql1(`SELECT status || '|' || COALESCE(public_url, '<null>') || '|' || COALESCE(bytes::text, '<null>') || '|' || (completed_at IS NOT NULL) FROM product_image_upload_sessions WHERE id = '${id}';`);
  const rowMd5 = (id: string) => sql1(`SELECT md5(to_jsonb(s)::text) FROM product_image_upload_sessions s WHERE id = '${id}';`);
  const objCount = (p: string) => sql1(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${p}';`);
  const CONFIG_SQL = `SELECT count(*) || '|' || md5(string_agg(key || '|' || value || '|' || updated_at::text, ',' ORDER BY key)) FROM public.app_config;`;
  const REAL_SQL = `SELECT md5(
      (SELECT COALESCE(string_agg(z::text, '|' ORDER BY z.id), '') FROM products z WHERE org_id = '${REAL_ORG}')
   || (SELECT COALESCE(string_agg(z::text, '|' ORDER BY z.id), '') FROM product_image_upload_sessions z WHERE created_by IN (SELECT id FROM users WHERE org_id = '${REAL_ORG}'))
   || (SELECT COALESCE(string_agg((to_jsonb(z) - 'last_accessed_at')::text, '|' ORDER BY z.name), '') FROM storage.objects z WHERE name NOT LIKE 'org/qa-%')) || ' sessions=' || (SELECT count(*) FROM product_image_upload_sessions) || ' objects(non-qa)=' || (SELECT count(*) FROM storage.objects WHERE name NOT LIKE 'org/qa-%');`;

  const createSession = async (o: Org): Promise<Sess> => ok(await rpc(o.admin, "create_product_image_upload_session", { p_shop_id: o.shop, p_product_id: o.prod }), `${o.key} create session`);
  const complete = (s: Sess, over: Record<string, unknown> = {}) =>
    rpc(anon, "complete_product_image_upload_session", { p_token: s.token, p_storage_path: s.storagePath, p_public_url: url(s.storagePath), p_bytes: TINY_WEBP.length, p_mime_type: "image/webp", ...over });
  const callFn = async (token: unknown): Promise<{ status: number; body: any; ms: number }> => {
    const t0 = performance.now();
    const res = await fetch(`${cfg.url}${FN}`, {
      method: "POST",
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, ms: performance.now() - t0 };
  };
  const put = async (p: string, uploadToken: string) => {
    const res = await fetch(`${cfg.url}/storage/v1/object/upload/sign/${BUCKET}/${p}?token=${encodeURIComponent(uploadToken)}`, {
      method: "PUT", headers: { apikey: cfg.anonKey, "content-type": "image/webp", "x-upsert": "false" }, body: TINY_WEBP,
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  };
  /** The real phone path: token from the deployed function, then PUT. */
  const phoneUpload = async (s: Sess) => {
    const t = await callFn(s.token);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body.path).toBe(s.storagePath);
    const r = await put(s.storagePath, t.body.token);
    expect(r.status, r.body).toBe(200);
    expect(objCount(s.storagePath)).toBe("1");
  };

  const createConsoleOrg = async (o: Org) => {
    o.orgId = `qa-g4${o.key}-org-${ts}`;
    o.adminId = `qa-g4${o.key}-admin-${ts}`;
    o.email = `qa-g4${o.key}-admin-${ts}@qa.invalid`;
    o.adminAuth = await signUpUser(cfg, o.email, password);
    const oi = await svc.from("organizations").insert({ id: o.orgId, name: `QA G4 Org ${o.key.toUpperCase()} ${ts}` }).select("id");
    if (oi.error) throw new Error(`org insert ${o.orgId}: ${oi.error.message}`);
    const ui = await svc.from("users").insert({ id: o.adminId, name: `QA G4 ${o.key.toUpperCase()} Admin`, email: o.email, role: "ADMIN", org_id: o.orgId, auth_id: o.adminAuth, is_active: true, created_at: new Date().toISOString() });
    if (ui.error) throw new Error(`admin insert ${o.adminId}: ${ui.error.message}`);
    o.admin = await signedInClient(cfg, o.email, password);
    o.shop = `qa-g4${o.key}-shop-${ts}`;
    o.prod = `qa-g4${o.key}-prod-${ts}`;
    const sh = await o.admin.from("shops").insert({ id: o.shop, code: `G4${o.key.toUpperCase()}${ts}`, name: `QA G4 ${o.key.toUpperCase()} Shop ${ts}`, address: "QA G4 Street", is_active: true });
    if (sh.error) throw new Error(`${o.key} shop insert: ${sh.error.message}`);
    const pr = await o.admin.from("products").insert({ id: o.prod, sku: `QAG4${o.key.toUpperCase()}-${ts}`, name: `QA G4 ${o.key.toUpperCase()} Product`, category: "QA", unit_type: "pcs", price_mmk: 1000, cost_mmk: 500, is_active: true });
    if (pr.error) throw new Error(`${o.key} product insert: ${pr.error.message}`);
  };

  beforeAll(async () => {
    cfg = liveConfig();
    svc = makeClient(cfg, cfg.serviceKey);
    anon = makeClient(cfg, cfg.anonKey);
    expect(sql1(`SELECT max(version) FROM supabase_migrations.schema_migrations;`)).toBe("080");
    trusted = sql1(`SELECT value FROM public.app_config WHERE key = 'supabase_public_url';`);
    expect(trusted).toBe(cfg.url);
    configBefore = sql1(CONFIG_SQL);
    expect(configBefore.startsWith("1|")).toBe(true);
    realBefore = sql1(REAL_SQL);
    await createConsoleOrg(A);
    await createConsoleOrg(B);
  });

  afterAll(async () => {
    try {
      const left = sql1(`SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name LIKE 'org/qa-g4%';`).split("\n").filter(Boolean);
      const unexpected = left.filter((n) => !/^org\/qa-g4[a-z]-org-\d+\/temp\/pimg-[0-9a-f]+$/.test(n));
      if (unexpected.length) throw new Error(`refusing to delete unexpected names: ${unexpected.join(",")}`);
      let removed = 0;
      if (left.length) {
        const r = await svc.storage.from(BUCKET).remove(left);
        if (r.error) throw new Error(r.error.message);
        removed = r.data?.length ?? 0;
      }
      const after = sql1(`SELECT count(*) FROM storage.objects WHERE name LIKE 'org/qa-%';`);
      ev.add("storage cleanup", after === "0" ? "PASS" : "FAIL", `QA objects found=${left.length}, removed via service-role Storage API=${removed}, remaining=${after}`);
    } catch (err: any) {
      ev.fail("storage cleanup", String(err?.message ?? err));
    }
    try {
      const cfgAfter = sql1(CONFIG_SQL);
      ev.add("app_config unchanged", cfgAfter === configBefore ? "PASS" : "FAIL", `rows|md5 before == after: ${cfgAfter === configBefore} (${cfgAfter.split("|")[0]} row)`);
      const realAfter = sql1(REAL_SQL);
      // sessions count grows by this suite's QA sessions; compare the md5 part only
      ev.add("real org + non-QA storage unchanged", realAfter.split(" ")[0] === realBefore.split(" ")[0] ? "PASS" : "FAIL", `md5(real products, real sessions, non-QA objects) before == after: ${realAfter.split(" ")[0] === realBefore.split(" ")[0]}; ${realAfter.split(" ").slice(2).join(" ")}`);
    } catch { /* ignore */ }
    process.stdout.write(`\n[phase-g4 results ts=${ts}]\n${ev.table().replaceAll(cfg.url, "<origin>")}\n\n`);
    for (const c of [A.admin, B.admin]) { try { await c?.auth.signOut(); } catch { /* ignore */ } }
  });

  // =========================================================================
  it("1. session creation refused for another org's product / shop, a real-org product / shop, and anon; an unknown product id gives an org-scoped session with no product", async () => {
    const n0 = sql1(`SELECT count(*) FROM product_image_upload_sessions;`);
    const realProd = sql1(`SELECT id FROM products WHERE org_id = '${REAL_ORG}' ORDER BY id LIMIT 1;`);
    const realShop = sql1(`SELECT id FROM shops WHERE org_id = '${REAL_ORG}' ORDER BY id LIMIT 1;`);
    const cases: [string, SupabaseClient, Record<string, unknown>][] = [
      ["A ADMIN, A shop + B product (wrong product)", A.admin, { p_shop_id: A.shop, p_product_id: B.prod }],
      ["A ADMIN, B shop + A product (wrong organization)", A.admin, { p_shop_id: B.shop, p_product_id: A.prod }],
      ["A ADMIN, B shop + B product (wrong organization)", A.admin, { p_shop_id: B.shop, p_product_id: B.prod }],
      ["A ADMIN, A shop + real-org product", A.admin, { p_shop_id: A.shop, p_product_id: realProd }],
      ["A ADMIN, real-org shop + A product", A.admin, { p_shop_id: realShop, p_product_id: A.prod }],
    ];
    const notes: string[] = [];
    for (const [i, [what, c, args]] of cases.entries()) {
      const r = await rpc(c, "create_product_image_upload_session", args);
      expect(r.error, what).not.toBeNull();
      if (i < 3) expect(String(r.error.message), what).toMatch(NOT_IN_ORG);
      notes.push(`${what} -> "${short(r.error.message, 60)}"`);
    }
    const an = await rpc(anon, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: A.prod });
    expect(an.error?.code).toBe("42501");
    notes.push(`anon -> ${an.error.code}`);
    expect(sql1(`SELECT count(*) FROM product_image_upload_sessions;`)).toBe(n0);
    // By design (079, the "new product" form uploads before the product row
    // exists): an id that matches NO product is accepted and stored as
    // product_id NULL; the path is still the caller's own org prefix, so it
    // grants nothing outside the org. The function re-checks product/shop.
    const unk = await createSession(A);
    const unknownCreate = await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: `qa-g4-none-${ts}` });
    expect(unknownCreate.error).toBeNull();
    const unkRow = sql1(`SELECT COALESCE(product_id, '<null>') || '|' || storage_path FROM product_image_upload_sessions WHERE id = '${unknownCreate.data.sessionId}';`);
    expect(unkRow).toBe(`<null>|org/${A.orgId}/temp/${unknownCreate.data.sessionId}`);
    for (const x of [unk, unknownCreate.data]) ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: x.sessionId }), "cancel");
    ev.pass("1 session creation refused", `${notes.join("; ")}; sessions ${n0}->${n0} (no row written by any refused call); unknown product id (new-product form, by design) -> session with product_id NULL on org/<A>/temp/<id> (own org only), cancelled`);
  });

  // =========================================================================
  it("2. completion with wrong bucket, another session's / org's path, encoded and malformed path + URL variants -> refused, session stays PENDING (object present)", async () => {
    const s = await createSession(A);
    const other = await createSession(A);
    const sB = await createSession(B);
    await phoneUpload(s); // the object exists: every refusal below is about the variant only
    const md5Before = rowMd5(s.sessionId);
    const p = s.storagePath;
    const [, org, , id] = p.split("/");
    const pathVariants: [string, unknown][] = [
      ["another session's path (same org)", other.storagePath],
      ["another org's session path", sB.storagePath],
      ["legacy temp/<id>", `temp/${id}`],
      ["org/<A>/products/<A prod>/x", `org/${org}/products/${A.prod}/x.webp`],
      ["%2F instead of /", p.replaceAll("/", "%2F")],
      ["%2f lower", p.replaceAll("/", "%2f")],
      ["%2e%2e segment", `org/${org}/temp/%2e%2e/temp/${id}`],
      ["../ segment", `org/${org}/temp/../temp/${id}`],
      ["./ segment", `org/${org}/./temp/${id}`],
      ["double slash", p.replace("/temp/", "//temp/")],
      ["leading slash", `/${p}`],
      ["trailing slash", `${p}/`],
      ["upper case", p.toUpperCase()],
      ["upper-case id only", `org/${org}/temp/${id.toUpperCase()}`],
      ["query string", `${p}?x=1`],
      ["fragment", `${p}#x`],
      ["Cyrillic о lookalike", p.replace("org/", "оrg/")],
      ["fullwidth slash", p.replace("/temp/", "／temp/")],
      ["zero-width space", p.replace("temp", "te\u200bmp")],
      ["trailing space", `${p} `],
      ["tab", `${p}\t`],
      ["newline", `${p}\n`],
      ["backslash", p.replaceAll("/", "\\")],
      ["empty", ""],
      ["null", null],
    ];
    const pathNotes: string[] = [];
    for (const [what, v] of pathVariants) {
      const r = await complete(s, { p_storage_path: v });
      expect(r.error?.message, `path ${what}`).toBe(PATH_MISMATCH);
      pathNotes.push(what);
    }
    const P = `/storage/v1/object/public/${BUCKET}/${p}`;
    const urlVariants: [string, string, string | RegExp][] = [
      ["another bucket (public/other-bucket)", `${cfg.url}/storage/v1/object/public/other-bucket/${p}`, "Uploaded image URL must point to the product-images bucket"],
      ["bucket-name prefix (product-images-x)", `${cfg.url}/storage/v1/object/public/product-images-x/${p}`, "Uploaded image URL must point to the product-images bucket"],
      ["signed route (object/sign)", `${cfg.url}/storage/v1/object/sign/${BUCKET}/${p}`, "Uploaded image URL must point to the product-images bucket"],
      ["authenticated route", `${cfg.url}/storage/v1/object/authenticated/${BUCKET}/${p}`, "Uploaded image URL must point to the product-images bucket"],
      ["other bucket in front, ours later", `${cfg.url}/storage/v1/object/public/other-bucket${P}`, URL_MISMATCH],
      ["another session's object", url(other.storagePath), URL_MISMATCH],
      ["another org's session object", url(sB.storagePath), URL_MISMATCH],
      ["query ?download=1", `${url(p)}?download=1`, URL_MISMATCH],
      ["query redirect", `${url(p)}?r=https://evil.example/x`, URL_MISMATCH],
      ["bare ?", `${url(p)}?`, URL_MISMATCH],
      ["fragment", `${url(p)}#x`, URL_MISMATCH],
      ["%2F in path", url(p.replaceAll("/", "%2F")), URL_MISMATCH],
      ["%2e%2e in path", url(`org/${org}/temp/%2e%2e/temp/${id}`), URL_MISMATCH],
      [".. in path", url(`org/${org}/temp/../temp/${id}`), URL_MISMATCH],
      ["double slash", `${cfg.url}/storage/v1/object/public/${BUCKET}//${p}`, URL_MISMATCH],
      ["trailing slash", `${url(p)}/`, URL_MISMATCH],
      ["upper-case path", url(p.toUpperCase()), URL_MISMATCH],
      ["upper-case bucket", `${cfg.url}/storage/v1/object/public/PRODUCT-IMAGES/${p}`, "Uploaded image URL must point to the product-images bucket"],
      ["backslash", url(p).replace("/temp/", "\\temp/"), URL_MISMATCH],
      ["space", `${url(p)} `, URL_MISMATCH],
      ["no scheme (path only)", P, URL_MISMATCH],
      ["scheme-relative //host", `//evil.example${P}`, URL_MISMATCH],
      ["javascript:", `javascript:alert(1)//${P}`, URL_MISMATCH],
      ["ftp:", `ftp://evil.example${P}`, URL_MISMATCH],
      ["data:", "data:image/webp;base64,AAAA", "Uploaded image URL must be a Storage URL"],
      ["empty", "", "Uploaded image URL must be a Storage URL"],
    ];
    const urlNotes: string[] = [];
    for (const [what, v, expected] of urlVariants) {
      const r = await complete(s, { p_public_url: v });
      expect(r.error, `url ${what}`).not.toBeNull();
      if (typeof expected === "string") expect(r.error.message, `url ${what}`).toBe(expected);
      else expect(r.error.message, `url ${what}`).toMatch(expected);
      urlNotes.push(`${what} -> "${short(r.error.message, 45)}"`);
    }
    expect(rowMd5(s.sessionId)).toBe(md5Before);
    expect(sessRow(s.sessionId)).toBe("PENDING|<null>|<null>|false");
    expect(objCount(s.storagePath)).toBe("1");
    // control: the exact values complete
    const done = ok(await complete(s), "control complete");
    expect(done.status).toBe("COMPLETED");
    expect(done.publicUrl).toBe(derived(p));
    ev.pass("2 path/URL/bucket variants refused", `object present; ${pathVariants.length} p_storage_path variants -> "${PATH_MISMATCH}" each [${pathNotes.join(", ")}]; ${urlVariants.length} p_public_url variants refused: ${urlNotes.join("; ")}; session row byte-identical (md5) and PENDING after all ${pathVariants.length + urlVariants.length}; control with the exact path/URL -> COMPLETED, publicUrl = trusted derived URL. (An object present ONLY in another bucket is covered by harness t16: lucashome has one bucket and creating a second is a storage config change, not done.)`);
  });

  // =========================================================================
  it("3. external host with the exact session path -> ignored: COMPLETED with the trusted URL; foreign host stored nowhere", async () => {
    const hosts = ["https://evil.example", `https://${new URL(cfg.url).host}@evil.example`, "https://evil.example:8443", "http://evil.example", "https://203.0.113.7", `https://${new URL(cfg.url).host}.evil.example`];
    const notes: string[] = [];
    for (const h of hosts) {
      const s = await createSession(A);
      await phoneUpload(s);
      const r = await complete(s, { p_public_url: url(s.storagePath, h) });
      expect(r.error, `host ${h}: ${r.error?.message}`).toBeNull();
      expect(r.data.status).toBe("COMPLETED");
      expect(r.data.publicUrl).toBe(derived(s.storagePath));
      expect(sessRow(s.sessionId)).toBe(`COMPLETED|${derived(s.storagePath)}|${TINY_WEBP.length}|true`);
      const poll = ok(await rpc(A.admin, "get_product_image_upload_session_status", { p_session_id: s.sessionId }), "poll");
      const byTok = ok(await rpc(anon, "get_product_image_upload_session_by_token", { p_token: s.token }), "by_token");
      expect(poll.publicUrl).toBe(derived(s.storagePath));
      expect(byTok.publicUrl).toBe(derived(s.storagePath));
      expect(sql1(`SELECT count(*) FROM product_image_upload_sessions s WHERE id = '${s.sessionId}' AND to_jsonb(s)::text LIKE '%evil.example%' OR id = '${s.sessionId}' AND to_jsonb(s)::text LIKE '%203.0.113.7%';`)).toBe("0");
      // and what the desktop would save into products.image_url is that same URL: it serves the object
      const get = await fetch(poll.publicUrl);
      expect(get.status).toBe(200);
      notes.push(`${h.replace(new URL(cfg.url).host, "<trusted-host>")} -> COMPLETED`);
    }
    ev.pass("3 external host ignored", `${notes.join("; ")}; for each: returned, stored, desktop-poll and by_token publicUrl = <app_config origin>/storage/v1/object/public/${BUCKET}/<session path>; the foreign host appears nowhere in the row; GET of that URL 200`);
  });

  // =========================================================================
  it("4. missing storage object -> refused, session stays PENDING; completes once the object exists", async () => {
    const s = await createSession(A);
    const md5 = rowMd5(s.sessionId);
    const r = await complete(s);
    expect(r.error?.message).toBe(NOT_FOUND);
    expect(rowMd5(s.sessionId)).toBe(md5);
    expect(sessRow(s.sessionId)).toBe("PENDING|<null>|<null>|false");
    const r2 = await complete(s, { p_bytes: 50_000, p_mime_type: "image/jpeg" });
    expect(r2.error?.message).toBe(NOT_FOUND);
    await phoneUpload(s);
    const done = ok(await complete(s, { p_bytes: 50_000, p_mime_type: "image/jpeg" }), "complete after upload");
    expect(done.status).toBe("COMPLETED");
    expect(done.bytes).toBe(TINY_WEBP.length); // from the object's metadata, not the client's claim
    expect(done.mimeType).toBe("image/webp");
    ev.pass("4 missing object", `complete before the upload -> "${r.error.message}" (x2, also with a different claimed size/type); row byte-identical, PENDING, no URL/bytes/completed_at; after the real phone upload -> COMPLETED with bytes=${done.bytes}/mime=${done.mimeType} from storage metadata (client claimed 50000/image/jpeg)`);
  });

  // =========================================================================
  it("5. duplicate completion: two concurrent + one later -> exactly one completion, no duplicate rows", async () => {
    const s = await createSession(A);
    await phoneUpload(s);
    const n0 = sql1(`SELECT count(*) FROM product_image_upload_sessions;`);
    const both = await Promise.all([complete(s), complete(s)]);
    const wins = both.filter((r) => !r.error);
    const losses = both.filter((r) => r.error);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].error.message).toBe(INACTIVE);
    const md5 = rowMd5(s.sessionId);
    const third = await complete(s, { p_public_url: url(s.storagePath, "https://evil.example") });
    expect(third.error?.message).toBe(INACTIVE);
    expect(rowMd5(s.sessionId)).toBe(md5);
    expect(sql1(`SELECT count(*) FROM product_image_upload_sessions WHERE id = '${s.sessionId}';`)).toBe("1");
    expect(sql1(`SELECT count(*) FROM product_image_upload_sessions;`)).toBe(n0);
    expect(objCount(s.storagePath)).toBe("1");
    expect(sessRow(s.sessionId)).toBe(`COMPLETED|${derived(s.storagePath)}|${TINY_WEBP.length}|true`);
    const fnAfter = await callFn(s.token);
    expect(fnAfter.status).toBe(410);
    ev.pass("5 duplicate completion", `2 concurrent completes -> 1 COMPLETED + 1 "${losses[0].error.message}"; a later complete (external host) -> "${third.error.message}"; row byte-identical after it; 1 row for the session, session count unchanged (${n0}), 1 object; function for the completed session -> ${fnAfter.status} ${fnAfter.body?.code}/${fnAfter.body?.status}`);
  });

  // =========================================================================
  it("6. expired and cancelled sessions (object present) -> completion refused; function 410", async () => {
    const sE = await createSession(A);
    await phoneUpload(sE);
    const ex = await svc.from("product_image_upload_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", sE.sessionId).select("id");
    expect(ex.data).toHaveLength(1);
    const cE = await complete(sE);
    expect(cE.error?.message).toBe(INACTIVE);
    const rowE = sessRow(sE.sessionId);
    expect(rowE.startsWith("PENDING|<null>|<null>|false") || rowE.startsWith("EXPIRED|<null>")).toBe(true);
    const fE = await callFn(sE.token);
    expect(fE.status).toBe(410);
    expect(fE.body.status).toBe("EXPIRED");
    expect(sessRow(sE.sessionId).startsWith("EXPIRED|<null>")).toBe(true);
    const cE2 = await complete(sE);
    expect(cE2.error?.message).toBe(INACTIVE);

    const sC = await createSession(A);
    await phoneUpload(sC);
    ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: sC.sessionId }), "cancel");
    const cC = await complete(sC);
    expect(cC.error?.message).toBe(INACTIVE);
    expect(sessRow(sC.sessionId)).toBe("CANCELED|<null>|<null>|false");
    const fC = await callFn(sC.token);
    expect(fC.status).toBe(410);
    expect(fC.body.status).toBe("CANCELED");
    ev.pass("6 expired / cancelled", `expired (object uploaded first): complete -> "${cE.error.message}" (row ${rowE.split("|")[0]}, no URL); function -> 410 EXPIRED and the row is stamped EXPIRED; complete again -> refused. cancelled (object uploaded first): complete -> "${cC.error.message}", row CANCELED|<null>; function -> 410 CANCELED`);
  });

  // =========================================================================
  it("7. anon / authenticated: public.app_config not readable or writable via REST; app_upload_session_public_url not callable", async () => {
    const notes: string[] = [];
    for (const [who, c] of [["anon", anon], ["authenticated (QA ADMIN)", A.admin]] as const) {
      const sel = await c.from("app_config").select("*");
      const refusedRead = sel.error !== null || (Array.isArray(sel.data) && sel.data.length === 0);
      expect(refusedRead, `${who} select`).toBe(true);
      const ins = await c.from("app_config").insert({ key: "supabase_public_url", value: "https://evil.example" }).select("key");
      const upd = await c.from("app_config").update({ value: "https://evil.example" }).eq("key", "supabase_public_url").select("key");
      const del = await c.from("app_config").delete().eq("key", "supabase_public_url").select("key");
      const up = await c.from("app_config").upsert({ key: "supabase_public_url", value: "https://evil.example" }).select("key");
      for (const [op, r] of [["insert", ins], ["update", upd], ["delete", del], ["upsert", up]] as const) {
        expect(r.error !== null || (Array.isArray(r.data) && r.data.length === 0), `${who} ${op}`).toBe(true);
      }
      const fn = await rpc(c, "app_upload_session_public_url", { p_storage_path: `org/${A.orgId}/temp/pimg-0` });
      expect(fn.error, `${who} rpc`).not.toBeNull();
      expect(["42501", "PGRST202"]).toContain(fn.error.code);
      const fmt = (r: any) => (r.error ? `${r.error.code} ${short(r.error.message, 40)}` : `${r.data?.length ?? 0} rows`);
      notes.push(`${who}: select -> ${fmt(sel)}; insert -> ${fmt(ins)}; update -> ${fmt(upd)}; delete -> ${fmt(del)}; upsert -> ${fmt(up)}; rpc app_upload_session_public_url -> ${fn.error.code} "${short(fn.error.message, 50)}"`);
    }
    const priv = sql1(`SELECT has_table_privilege('anon','public.app_config','SELECT,INSERT,UPDATE,DELETE') || '|' || has_table_privilege('authenticated','public.app_config','SELECT,INSERT,UPDATE,DELETE') || '|' || has_function_privilege('anon','public.app_upload_session_public_url(text)','EXECUTE') || '|' || has_function_privilege('authenticated','public.app_upload_session_public_url(text)','EXECUTE') || '|' || (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.app_config'::regclass);`);
    expect(priv).toBe("false|false|false|false|true");
    expect(sql1(CONFIG_SQL)).toBe(configBefore);
    ev.pass("7 app_config / helper not exposed", `${notes.join(" || ")}; catalog: anon/auth table privilege any of S/I/U/D = false/false, helper EXECUTE anon/auth = false/false, RLS on; app_config rows|md5 unchanged`);
  });

  // =========================================================================
  it("8. function abuse: 50 sequential + 50 concurrent token requests for ONE live session, 50 invalid tokens (measured)", async () => {
    const s = await createSession(A);
    const md5 = rowMd5(s.sessionId);
    const stats = (label: string) => {
      try {
        return execFileSync("ssh", ["-o", "BatchMode=yes", cfg.sshHost, `cd ${cfg.stackDir} && docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' $(docker compose ps -q functions storage api-gw db 2>/dev/null) 2>/dev/null`], { encoding: "utf8" }).trim().replace(/\n/g, "; ");
      } catch (e: any) { return `${label}: n/a (${short(e?.message, 40)})`; }
    };
    const resBefore = stats("before");
    const tokens: string[] = [];
    const statuses: Record<string, number> = {};
    const seqMs: number[] = [];
    const tSeq = performance.now();
    for (let i = 0; i < 50; i++) {
      const r = await callFn(s.token);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      seqMs.push(r.ms);
      if (r.body?.token) tokens.push(r.body.token);
    }
    const seqTotal = performance.now() - tSeq;
    const conMs: number[] = [];
    const conStatuses: Record<string, number> = {};
    const tCon = performance.now();
    const burst = await Promise.all(Array.from({ length: 50 }, () => callFn(s.token)));
    const conTotal = performance.now() - tCon;
    for (const r of burst) {
      conStatuses[r.status] = (conStatuses[r.status] ?? 0) + 1;
      conMs.push(r.ms);
      if (r.body?.token) tokens.push(r.body.token);
    }
    const resAfter = stats("after");
    const distinct = new Set(tokens).size;
    const claims = tokens.map(jwtPayload);
    const lifetimes = new Set(claims.map((c) => c.exp - c.iat));
    const urls = new Set(claims.map((c) => c.url));
    // storage signs {url, iat, exp} (+ owner claims) with HS256 and second
    // resolution: requests within the same second get the SAME token, a new
    // second a new one. Each call still costs a sign request.
    const iatSeconds = new Set(claims.map((c) => c.iat)).size;
    expect(distinct).toBe(iatSeconds);
    expect(statuses["200"]).toBe(50);
    expect(conStatuses["200"] ?? 0).toBeGreaterThan(0);
    expect(urls.size).toBe(1);
    expect([...urls][0]).toBe(`${BUCKET}/${s.storagePath}`);
    // nothing written by issuing: row byte-identical, no object
    expect(rowMd5(s.sessionId)).toBe(md5);
    expect(objCount(s.storagePath)).toBe("0");
    // extra tokens add no capability: the first PUT wins, any other token for the path is refused
    const first = await put(s.storagePath, tokens[0]);
    const last = await put(s.storagePath, tokens[tokens.length - 1]);
    const mid = await put(s.storagePath, tokens[Math.floor(tokens.length / 2)]);
    expect(first.status).toBe(200);
    expect(last.status).not.toBe(200);
    expect(mid.status).not.toBe(200);
    expect(objCount(s.storagePath)).toBe("1");
    const after = await callFn(s.token);
    expect(after.body).toEqual({ alreadyUploaded: true, path: s.storagePath });
    ok(await complete(s), "complete");
    // invalid tokens: same 404 for all, cost = one indexed lookup each
    const badMs: number[] = [];
    const badStatuses: Record<string, number> = {};
    const tBad = performance.now();
    const bad = await Promise.all(Array.from({ length: 50 }, () => callFn(randomBytes(64).toString("hex"))));
    const badTotal = performance.now() - tBad;
    for (const r of bad) { badStatuses[r.status] = (badStatuses[r.status] ?? 0) + 1; badMs.push(r.ms); }
    expect(badStatuses["404"]).toBe(50);
    const fmt = (xs: number[]) => `min ${Math.round(Math.min(...xs))} / p50 ${Math.round(pct(xs, 50))} / p95 ${Math.round(pct(xs, 95))} / max ${Math.round(Math.max(...xs))} ms`;
    const summary = {
      sequential: { statuses, total_ms: Math.round(seqTotal), rate_per_s: +(50 / (seqTotal / 1000)).toFixed(1), latency: fmt(seqMs) },
      concurrent: { statuses: conStatuses, total_ms: Math.round(conTotal), latency: fmt(conMs), non200: burst.filter((r) => r.status !== 200).map((r) => `${r.status}:${short(JSON.stringify(r.body), 60)}`).slice(0, 5) },
      tokens: { minted: tokens.length, distinct, distinct_iat_seconds: iatSeconds, lifetime_s: [...lifetimes], url_claims: urls.size },
      capability: { first_put: first.status, other_token_puts: [mid.status, last.status], other_body: short(last.body, 80), objects_at_path: 1, then_function: "alreadyUploaded" },
      invalid: { statuses: badStatuses, total_ms: Math.round(badTotal), latency: fmt(badMs) },
      server_writes_during_issuing: "none (session row md5 identical, 0 objects before the PUT)",
      resources_before: resBefore, resources_after: resAfter,
    };
    process.stdout.write(`\n[phase-g4 abuse] ${JSON.stringify(summary, null, 1)}\n`);
    ev.info("8 function abuse (measured)", `sequential 50 -> ${JSON.stringify(statuses)} in ${summary.sequential.total_ms} ms (${summary.sequential.rate_per_s}/s, ${summary.sequential.latency}); concurrent 50 -> ${JSON.stringify(conStatuses)} in ${summary.concurrent.total_ms} ms (${summary.concurrent.latency}); every 200 asked storage to sign again: ${tokens.length} tokens returned, ${distinct} distinct (= ${iatSeconds} distinct iat seconds: same-second requests get an identical JWT), lifetime ${[...lifetimes].join("/")} s, all for the one path; no 429 / no server-side limit; issuing wrote nothing; capability unchanged: first PUT ${first.status}, PUT with token #${Math.floor(tokens.length / 2) + 1} -> ${mid.status}, with the last -> ${last.status} "${short(last.body, 60)}", 1 object, function then answers alreadyUploaded; 50 invalid tokens -> ${JSON.stringify(badStatuses)} in ${summary.invalid.total_ms} ms (${summary.invalid.latency}); resources before: ${resBefore} | after: ${resAfter}`);
  });
});
