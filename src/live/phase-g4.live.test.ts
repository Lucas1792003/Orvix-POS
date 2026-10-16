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
//     live session, 50 invalid-token requests (measured, nothing changed).
//     PRE-081 ONLY (skipped once the schema is >= 081: the limits refuse it)
//   9-13 migration 081 rate limits (run ONLY when the schema is >= 081, i.e.
//     after the owner approved and applied 081 + the rate-limited function;
//     docs/selfhost-migration/phase-f/rate-limiting.md): per-session burst +
//     Retry-After + window reset, concurrent burst, lifetime cap, per-org
//     window, per-user session creation (HTTP 429)
//   G5-1..3 migration 083 (run ONLY when the schema is >= 083;
//     docs/selfhost-migration/phase-f/migration-083-g5.md; placed before 9-13
//     so the 081 tests' org-window / per-user fillers cannot starve them):
//     the function completes only real JPEG/WebP <= 100 KB without markup and
//     DELETES what it refuses; the bucket refuses other declared types and
//     > 5 MiB; cross-org tokens / paths complete nothing
//
// Version-aware completion (src/live/phoneCompletion.ts): below 083 the phone
// completes with the anon RPC, so the RPC's argument checks (tests 2-6) are
// exercised as anon. From 083 anon/authenticated get 42501 on the RPC (tests
// 2-6 assert that too), the phone completes through the function (which sends
// no path / URL / size at all), and the RPC's argument checks are exercised as
// service_role - its only caller, i.e. the function's second line.
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
import { Evidence, liveConfig, makeClient, randomPassword, runSql, createAuthUser, signedInClient, type LiveConfig } from "./liveHelpers";
import {
  BUCKET_MAX_BYTES, COMPLETION_MAX_BYTES, HTML_DOC, JPEG_HTML_POLYGLOT, JPEG_OVER_BUCKET_LIMIT, JPEG_OVER_COMPLETION_LIMIT,
  SVG_DOC, TINY_JPEG, TINY_PNG, TINY_WEBP, jpegWithComment,
} from "./imageFixtures";
import {
  completeThroughFunction, completeThroughRpc, describeCompletion, exactRpcArgs, isInactive, isInvalidImage, isNotUploaded,
  isPermissionDenied, isPost083, phoneCompleter, schemaVersion, signedPut, type PhoneCompletion,
} from "./phoneCompletion";

const LIVE = Boolean(process.env.LIVE_SUPABASE_URL);
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const BUCKET = "product-images";
const REAL_ORG = "org-shwe-pha-lar";
const FN = "/functions/v1/phone-upload-token";
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
  /** max(supabase_migrations.schema_migrations.version), e.g. "080" / "081" / "083" */
  let schema = "";
  const has081 = () => schema >= "081";
  const has083 = () => isPost083(schema);

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
  /**
   * The completion RPC's own argument checks, as the role that may call it:
   * anon (= the phone) before 083, service_role (= the function) from 083.
   */
  const complete = (s: Sess, over: Record<string, unknown> = {}) =>
    rpc(has083() ? svc : anon, "complete_product_image_upload_session", { p_token: s.token, p_storage_path: s.storagePath, p_public_url: url(s.storagePath), p_bytes: TINY_WEBP.length, p_mime_type: "image/webp", ...over });
  /** What the phone does to complete on this schema: the anon RPC < 083, the function >= 083. */
  let phoneComplete: (s: Sess, rpcOver?: Record<string, unknown>) => Promise<PhoneCompletion>;
  const completed = (c: PhoneCompletion, what: string): any => {
    if (!c.ok) throw new Error(`${what} failed: ${describeCompletion(c)}`);
    return c.data;
  };
  /** 083: anon and the org's own ADMIN cannot call the RPC at all, not even with the exact values. Returns evidence. */
  const expectRpcLocked = async (s: Sess, over: Record<string, unknown> = {}): Promise<string> => {
    const out: string[] = [];
    for (const [who, c] of [["anon", anon], ["authenticated (A ADMIN)", A.admin]] as const) {
      const r = await completeThroughRpc(c, exactRpcArgs(cfg, s, over));
      expect(isPermissionDenied(r), `${who}: ${describeCompletion(r)}`).toBe(true);
      out.push(`${who} -> ${r.code}`);
    }
    return out.join(", ");
  };
  const objMeta = (p: string) => sql1(`SELECT COALESCE(string_agg((metadata->>'mimetype') || '/' || (metadata->>'size'), ','), '<none>') FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${p}';`);
  const callFn = async (token: unknown): Promise<{ status: number; body: any; ms: number; retryAfter: string | null }> => {
    const t0 = performance.now();
    const res = await fetch(`${cfg.url}${FN}`, {
      method: "POST",
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, ms: performance.now() - t0, retryAfter: res.headers.get("retry-after") };
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
    o.adminAuth = await createAuthUser(cfg, o.email, password);
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
    schema = schemaVersion(cfg);
    expect(schema >= "080", `schema ${schema} must be >= 080`).toBe(true);
    phoneComplete = phoneCompleter(cfg, anon, has083);
    // 083's grants are present exactly when the schema says so (anon|authenticated|service_role)
    const sig = "public.complete_product_image_upload_session(text,text,text,integer,text)";
    expect(sql1(`SELECT has_function_privilege('anon', '${sig}', 'EXECUTE') || '|' || has_function_privilege('authenticated', '${sig}', 'EXECUTE') || '|' || has_function_privilege('service_role', '${sig}', 'EXECUTE');`))
      .toBe(has083() ? "false|false|true" : "true|true|true");
    // 081's limiter is present exactly when the schema says so (no half-applied state)
    expect(sql1(`SELECT to_regprocedure('public.claim_phone_upload_token_issue(text)') IS NOT NULL;`)).toBe(has081() ? "t" : "f");
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
    // 083: the phone roles cannot reach those checks at all - not with the
    // exact values, not with another session's path or a foreign URL
    let locked = "";
    if (has083()) {
      locked = [
        await expectRpcLocked(s),
        await expectRpcLocked(s, { p_storage_path: other.storagePath, p_public_url: url(other.storagePath) }),
        await expectRpcLocked(s, { p_storage_path: sB.storagePath, p_public_url: url(sB.storagePath) }),
        await expectRpcLocked(s, { p_public_url: url(p, "https://evil.example") }),
      ].join("; ");
    }
    expect(rowMd5(s.sessionId)).toBe(md5Before);
    expect(sessRow(s.sessionId)).toBe("PENDING|<null>|<null>|false");
    expect(objCount(s.storagePath)).toBe("1");
    // control: the phone completes. 083: through the function, which takes
    // nothing from the client but the token - extra fields naming another
    // session's path / a foreign URL / a size are ignored.
    const ctl = has083()
      ? await completeThroughFunction(cfg, s.token, { path: other.storagePath, storagePath: sB.storagePath, p_storage_path: other.storagePath, p_public_url: url(p, "https://evil.example"), publicUrl: url(other.storagePath), bytes: 1, mimeType: "image/png" })
      : await phoneComplete(s);
    const done = completed(ctl, "control complete");
    expect(done.status).toBe("COMPLETED");
    expect(done.storagePath).toBe(p);
    expect(done.publicUrl).toBe(derived(p));
    expect(sessRow(s.sessionId)).toBe(`COMPLETED|${derived(p)}|${TINY_WEBP.length}|true`);
    expect(sessRow(other.sessionId)).toBe("PENDING|<null>|<null>|false");
    expect(sessRow(sB.sessionId)).toBe("PENDING|<null>|<null>|false");
    expect(objCount(other.storagePath)).toBe("0");
    expect(objCount(sB.storagePath)).toBe("0");
    ev.pass("2 path/URL/bucket variants refused", `schema ${schema}; object present; RPC as ${has083() ? "service_role (083: its only caller)" : "anon (the phone)"}: ${pathVariants.length} p_storage_path variants -> "${PATH_MISMATCH}" each [${pathNotes.join(", ")}]; ${urlVariants.length} p_public_url variants refused: ${urlNotes.join("; ")}; ${has083() ? `083 RPC locked for the phone roles: ${locked}; ` : ""}session row byte-identical (md5) and PENDING after all; control ${has083() ? "via the function (body also carried another session's path, B's path, a foreign URL, a fake size/type - all ignored)" : "anon RPC with the exact path/URL"} -> COMPLETED, storagePath = the session's own, publicUrl = trusted derived URL; the other A session and B's session stay PENDING with no object. (An object present ONLY in another bucket is covered by harness t16: lucashome has one bucket and creating a second is a storage config change, not done.)`);
  });

  // =========================================================================
  it("3. external host with the exact session path -> ignored: COMPLETED with the trusted URL; foreign host stored nowhere", async () => {
    const hosts = ["https://evil.example", `https://${new URL(cfg.url).host}@evil.example`, "https://evil.example:8443", "http://evil.example", "https://203.0.113.7", `https://${new URL(cfg.url).host}.evil.example`];
    const notes: string[] = [];
    for (const h of hosts) {
      const s = await createSession(A);
      await phoneUpload(s);
      // 083: the phone roles cannot send a URL at all; the RPC's derivation is checked as its only caller
      if (has083()) await expectRpcLocked(s, { p_public_url: url(s.storagePath, h) });
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
    ev.pass("3 external host ignored", `schema ${schema}; completion RPC called as ${has083() ? "service_role (083; anon + A ADMIN -> 42501 with each foreign URL)" : "anon"}: ${notes.join("; ")}; for each: returned, stored, desktop-poll and by_token publicUrl = <app_config origin>/storage/v1/object/public/${BUCKET}/<session path>; the foreign host appears nowhere in the row; GET of that URL 200`);
  });

  // =========================================================================
  it("4. missing storage object -> refused, session stays PENDING; completes once the object exists", async () => {
    const s = await createSession(A);
    const md5 = rowMd5(s.sessionId);
    const r = await phoneComplete(s);
    expect(isNotUploaded(r), describeCompletion(r)).toBe(true);
    expect(rowMd5(s.sessionId)).toBe(md5);
    expect(sessRow(s.sessionId)).toBe("PENDING|<null>|<null>|false");
    // the RPC's own existence check (anon < 083, service_role >= 083), also with a different claimed size/type
    const r2 = await complete(s, { p_bytes: 50_000, p_mime_type: "image/jpeg" });
    expect(r2.error?.message).toBe(NOT_FOUND);
    expect(rowMd5(s.sessionId)).toBe(md5);
    await phoneUpload(s);
    if (has083()) await expectRpcLocked(s, { p_bytes: 50_000, p_mime_type: "image/jpeg" });
    // < 083 the phone claims 50000/jpeg; >= 083 it cannot claim anything (the function measures)
    const done = completed(await phoneComplete(s, { p_bytes: 50_000, p_mime_type: "image/jpeg" }), "complete after upload");
    expect(done.status).toBe("COMPLETED");
    expect(done.bytes).toBe(TINY_WEBP.length); // from the object, not the client's claim
    expect(done.mimeType).toBe("image/webp");
    ev.pass("4 missing object", `schema ${schema}; phone completion before the upload -> ${describeCompletion(r)}; RPC (${has083() ? "service_role" : "anon"}) with a different claimed size/type -> "${r2.error.message}"; row byte-identical, PENDING, no URL/bytes/completed_at; after the real phone upload -> COMPLETED via ${r.via} with bytes=${done.bytes}/mime=${done.mimeType} from the stored object${has083() ? "" : " (client claimed 50000/image/jpeg)"}`);
  });

  // =========================================================================
  it("5. duplicate completion: two concurrent + one later -> exactly one completion, no duplicate rows", async () => {
    const s = await createSession(A);
    await phoneUpload(s);
    const n0 = sql1(`SELECT count(*) FROM product_image_upload_sessions;`);
    const both = await Promise.all([phoneComplete(s), phoneComplete(s)]);
    const wins = both.filter((r) => r.ok);
    const losses = both.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(isInactive(losses[0]), describeCompletion(losses[0])).toBe(true);
    if (losses[0].via === "function") expect(losses[0].sessionStatus).toBe("COMPLETED");
    const md5 = rowMd5(s.sessionId);
    const third = await complete(s, { p_public_url: url(s.storagePath, "https://evil.example") });
    expect(third.error?.message).toBe(INACTIVE);
    const fourth = await phoneComplete(s);
    expect(isInactive(fourth), describeCompletion(fourth)).toBe(true);
    if (has083()) await expectRpcLocked(s);
    expect(rowMd5(s.sessionId)).toBe(md5);
    expect(sql1(`SELECT count(*) FROM product_image_upload_sessions WHERE id = '${s.sessionId}';`)).toBe("1");
    expect(sql1(`SELECT count(*) FROM product_image_upload_sessions;`)).toBe(n0);
    expect(objCount(s.storagePath)).toBe("1");
    expect(sessRow(s.sessionId)).toBe(`COMPLETED|${derived(s.storagePath)}|${TINY_WEBP.length}|true`);
    const fnAfter = await callFn(s.token);
    expect(fnAfter.status).toBe(410);
    ev.pass("5 duplicate completion", `schema ${schema}; 2 concurrent phone completes (${losses[0].via}) -> 1 COMPLETED + 1 ${describeCompletion(losses[0])}; a later RPC complete (${has083() ? "service_role" : "anon"}, external host) -> "${third.error.message}"; a later phone complete -> ${describeCompletion(fourth)}${has083() ? "; anon / A ADMIN RPC -> 42501" : ""}; row byte-identical after it; 1 row for the session, session count unchanged (${n0}), 1 object; function for the completed session -> ${fnAfter.status} ${fnAfter.body?.code}/${fnAfter.body?.status}`);
  });

  // =========================================================================
  it("6. expired and cancelled sessions (object present) -> completion refused; function 410", async () => {
    const sE = await createSession(A);
    await phoneUpload(sE);
    const ex = await svc.from("product_image_upload_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", sE.sessionId).select("id");
    expect(ex.data).toHaveLength(1);
    const cE = await phoneComplete(sE);
    expect(isInactive(cE), describeCompletion(cE)).toBe(true);
    if (cE.via === "function") expect(cE.sessionStatus).toBe("EXPIRED");
    const rowE = sessRow(sE.sessionId);
    // < 083 the RPC refuses without writing; >= 083 the function stamps EXPIRED (via _by_token) before answering
    expect(rowE.startsWith("PENDING|<null>|<null>|false") || rowE.startsWith("EXPIRED|<null>")).toBe(true);
    const rE = await complete(sE);
    expect(rE.error?.message).toBe(INACTIVE);
    const fE = await callFn(sE.token);
    expect(fE.status).toBe(410);
    expect(fE.body.status).toBe("EXPIRED");
    expect(sessRow(sE.sessionId).startsWith("EXPIRED|<null>")).toBe(true);
    const cE2 = await phoneComplete(sE);
    expect(isInactive(cE2), describeCompletion(cE2)).toBe(true);
    if (has083()) await expectRpcLocked(sE);
    expect(objCount(sE.storagePath)).toBe("1"); // an inactive session's object is not read, not completed

    const sC = await createSession(A);
    await phoneUpload(sC);
    ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: sC.sessionId }), "cancel");
    const cC = await phoneComplete(sC);
    expect(isInactive(cC), describeCompletion(cC)).toBe(true);
    if (cC.via === "function") expect(cC.sessionStatus).toBe("CANCELED");
    const rC = await complete(sC);
    expect(rC.error?.message).toBe(INACTIVE);
    if (has083()) await expectRpcLocked(sC);
    expect(sessRow(sC.sessionId)).toBe("CANCELED|<null>|<null>|false");
    const fC = await callFn(sC.token);
    expect(fC.status).toBe(410);
    expect(fC.body.status).toBe("CANCELED");
    ev.pass("6 expired / cancelled", `schema ${schema}; expired (object uploaded first): phone complete -> ${describeCompletion(cE)} (row ${rowE.split("|")[0]}, no URL); RPC (${has083() ? "service_role" : "anon"}) -> "${rE.error.message}"; token function -> 410 EXPIRED and the row is stamped EXPIRED; phone complete again -> refused${has083() ? "; anon / A ADMIN RPC -> 42501" : ""}. cancelled (object uploaded first): phone complete -> ${describeCompletion(cC)}, RPC -> "${rC.error.message}", row CANCELED|<null>; token function -> 410 CANCELED`);
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
  // 083 / G5 (docs/selfhost-migration/phase-f/migration-083-g5.md). Run ONLY
  // when the schema is >= 083 (bucket limits, RPC service_role only, the
  // validating function deployed first). Every object is written the phone's
  // way (token from the function, PUT to the signed URL as anon).
  // =========================================================================
  /** A fresh upload token for the session from the deployed function. */
  const uploadToken = async (s: Sess): Promise<string> => {
    const t = await callFn(s.token);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body.path).toBe(s.storagePath);
    return t.body.token;
  };
  /** Nothing completed, nothing stored: the refused session is untouched and PENDING. */
  const expectNothingLeft = (s: Sess, what: string) => {
    expect(objCount(s.storagePath), `${what}: object`).toBe("0");
    expect(sessRow(s.sessionId), `${what}: session`).toBe("PENDING|<null>|<null>|false");
  };

  it("G5-1. [083] bucket limits; the phone completes real JPEG / WebP (up to exactly 100 KB) through the function; the RPC refuses anon and authenticated", async (ctx) => {
    if (!has083()) ctx.skip();
    const bucket = sql1(`SELECT public || '|' || file_size_limit || '|' || allowed_mime_types::text FROM storage.buckets WHERE id = '${BUCKET}';`);
    expect(bucket).toBe(`true|${BUCKET_MAX_BYTES}|{image/jpeg,image/png,image/webp}`);
    const notes: string[] = [];
    const boundary = jpegWithComment({ totalBytes: COMPLETION_MAX_BYTES });
    for (const [what, body, type] of [["WebP 34 B", TINY_WEBP, "image/webp"], ["JPEG", TINY_JPEG, "image/jpeg"], [`JPEG exactly ${COMPLETION_MAX_BYTES} B`, boundary, "image/jpeg"]] as const) {
      const s = await createSession(A);
      const locked = await expectRpcLocked(s, { p_bytes: body.length, p_mime_type: type });
      const put = await signedPut(cfg, s.storagePath, await uploadToken(s), body, type);
      expect(put.status, put.body).toBe(200);
      expect(objMeta(s.storagePath)).toBe(`${type}/${body.length}`);
      // still not completable by the phone roles once the object exists
      await expectRpcLocked(s, { p_bytes: body.length, p_mime_type: type });
      const c = await completeThroughFunction(cfg, s.token);
      const done = completed(c, what);
      expect(done).toMatchObject({ sessionId: s.sessionId, status: "COMPLETED", storagePath: s.storagePath, publicUrl: derived(s.storagePath), bytes: body.length, mimeType: type });
      expect(sessRow(s.sessionId)).toBe(`COMPLETED|${derived(s.storagePath)}|${body.length}|true`);
      const get = await fetch(done.publicUrl);
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe(type);
      expect(Buffer.from(await get.arrayBuffer()).equals(body)).toBe(true);
      notes.push(`${what}: RPC ${locked}; PUT 200; function -> COMPLETED ${type}/${body.length} B, trusted URL, public GET 200 ${type} byte-identical`);
    }
    ev.pass("G5-1 [083] valid completions", `bucket public|limit|types = ${bucket}; ${notes.join(" || ")}`);
  });

  it("G5-2. [083] refused content (disguised HTML, SVG, JPEG+HTML polyglot, > function limit, > 5 MiB, wrong magic, PNG): no completed session, no object left", async (ctx) => {
    if (!has083()) ctx.skip();
    const html = Buffer.from(HTML_DOC);
    type Case = { what: string; body: Buffer; type: string; fileName?: string; at: "storage" | "completion" };
    const cases: Case[] = [
      { what: "disguised HTML (qa-photo.jpg, image/jpeg, HTML body, multipart)", body: html, type: "image/jpeg", fileName: "qa-photo.jpg", at: "completion" },
      { what: "HTML declared image/jpeg (raw PUT)", body: html, type: "image/jpeg", at: "completion" },
      { what: "HTML declared text/html", body: html, type: "text/html", at: "storage" },
      { what: "SVG declared image/svg+xml", body: SVG_DOC, type: "image/svg+xml", at: "storage" },
      { what: "SVG declared image/jpeg", body: SVG_DOC, type: "image/jpeg", at: "completion" },
      { what: "JPEG-header + HTML polyglot (valid JPEG, HTML in a COM segment)", body: JPEG_HTML_POLYGLOT, type: "image/jpeg", at: "completion" },
      { what: `real JPEG ${150 * 1024} B (> ${COMPLETION_MAX_BYTES} B function limit, < 5 MiB)`, body: JPEG_OVER_COMPLETION_LIMIT(), type: "image/jpeg", at: "completion" },
      { what: `real JPEG ${BUCKET_MAX_BYTES + 1} B (> 5 MiB bucket limit)`, body: JPEG_OVER_BUCKET_LIMIT(), type: "image/jpeg", at: "storage" },
      { what: "WebP bytes declared image/jpeg (wrong magic)", body: TINY_WEBP, type: "image/jpeg", at: "completion" },
      { what: "JPEG bytes declared image/webp (wrong magic)", body: TINY_JPEG, type: "image/webp", at: "completion" },
      { what: "PNG declared image/png (bucket allows, completion does not)", body: TINY_PNG, type: "image/png", at: "completion" },
    ];
    const notes: string[] = [];
    const sessions: Sess[] = [];
    let recovered = "";
    for (const k of cases) {
      const s = await createSession(A);
      sessions.push(s);
      const put = await signedPut(cfg, s.storagePath, await uploadToken(s), k.body, k.type, k.fileName);
      if (k.at === "storage") {
        // 0 = the connection was closed on the oversized body without an answer (still refused; nothing stored is checked next)
        expect(put.status === 0 || put.status >= 400, `${k.what}: PUT must be refused, got ${put.status} ${put.body}`).toBe(true);
        expect(objCount(s.storagePath), k.what).toBe("0");
        const c = await completeThroughFunction(cfg, s.token);
        expect(isNotUploaded(c), `${k.what}: ${describeCompletion(c)}`).toBe(true);
        expectNothingLeft(s, k.what);
        notes.push(`${k.what}: PUT ${put.status} "${short(put.body, 50)}", nothing stored; complete -> ${c.httpStatus} ${c.code}`);
      } else {
        expect(put.status, `${k.what}: storage checks only the declared type/size: ${put.body}`).toBe(200);
        const stored = objMeta(s.storagePath);
        expect(stored).toBe(`${k.type}/${k.body.length}`);
        const c = await completeThroughFunction(cfg, s.token);
        expect(isInvalidImage(c), `${k.what}: ${describeCompletion(c)}`).toBe(true);
        expectNothingLeft(s, k.what); // the function DELETED the refused object
        // the RPC as its only caller would also not complete it now: the object is gone
        const r = await complete(s, { p_bytes: k.body.length, p_mime_type: k.type });
        // refused either because the object is gone or (claimed size > 100 KB) by the RPC's own size check first
        expect(r.error, `${k.what}: the RPC must refuse`).not.toBeNull();
        expect(r.error?.message === NOT_FOUND || /^Uploaded image must be 100 KB or smaller/.test(r.error?.message ?? ""), `${k.what}: ${r.error?.message}`).toBe(true);
        expectNothingLeft(s, `${k.what} (after RPC)`);
        notes.push(`${k.what}: PUT 200 (stored ${stored}) -> function 422 invalid_image, object deleted, PENDING`);
        if (!recovered) {
          // the freed path takes a real photo; the same session then completes
          const again = await signedPut(cfg, s.storagePath, await uploadToken(s), TINY_WEBP, "image/webp");
          expect(again.status, again.body).toBe(200);
          const ok2 = completed(await completeThroughFunction(cfg, s.token), "recovery");
          expect(ok2.mimeType).toBe("image/webp");
          expect(sessRow(s.sessionId)).toBe(`COMPLETED|${derived(s.storagePath)}|${TINY_WEBP.length}|true`);
          recovered = `after "${k.what}" was refused, the same session took a real WebP on the freed path -> COMPLETED`;
        }
      }
    }
    // across all case sessions: the only completion is the recovery's real WebP
    const ids = sessions.map((s) => `'${s.sessionId}'`).join(",");
    expect(sql1(`SELECT count(*) FILTER (WHERE status = 'COMPLETED') || '|' || count(*) FILTER (WHERE status = 'COMPLETED' AND mime_type = 'image/webp' AND bytes = ${TINY_WEBP.length}) FROM product_image_upload_sessions WHERE id IN (${ids});`)).toBe("1|1");
    expect(sql1(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name IN (${sessions.map((s) => `'${s.storagePath}'`).join(",")});`)).toBe("1");
    ev.pass("G5-2 [083] refused content", `${cases.length} cases, each its own session: ${notes.join("; ")}; ${recovered}`);
  });

  it("G5-3. [083] cross-org: another org's upload token cannot write this session's path; this token cannot complete from another org's object; the other org's ADMIN cannot call the RPC", async (ctx) => {
    if (!has083()) ctx.skip();
    const sA = await createSession(A);
    const sB = await createSession(B);
    const tA = await uploadToken(sA);
    const tB = await uploadToken(sB);
    // signed tokens are bound to their path: swapping them writes nothing
    const aWithB = await signedPut(cfg, sA.storagePath, tB, TINY_WEBP, "image/webp");
    const bWithA = await signedPut(cfg, sB.storagePath, tA, TINY_WEBP, "image/webp");
    expect(aWithB.status, aWithB.body).toBeGreaterThanOrEqual(400);
    expect(bWithA.status, bWithA.body).toBeGreaterThanOrEqual(400);
    expectNothingLeft(sA, "A path with B's token");
    expectNothingLeft(sB, "B path with A's token");
    // B's own object exists; A's token must not complete from it (the function derives A's path)
    const bPut = await signedPut(cfg, sB.storagePath, await uploadToken(sB), TINY_WEBP, "image/webp");
    expect(bPut.status, bPut.body).toBe(200);
    const cA = await completeThroughFunction(cfg, sA.token, { path: sB.storagePath, p_storage_path: sB.storagePath, p_public_url: url(sB.storagePath) });
    expect(isNotUploaded(cA), describeCompletion(cA)).toBe(true);
    expectNothingLeft(sA, "A after completing with B's object present");
    expect(sessRow(sB.sessionId)).toBe("PENDING|<null>|<null>|false");
    // the RPC: B's ADMIN and anon -> 42501 with A's token on either path; the service role's path check refuses the swap
    const lockNotes: string[] = [];
    for (const [who, c] of [["B ADMIN", B.admin], ["A ADMIN", A.admin], ["anon", anon]] as const) {
      for (const p of [sA.storagePath, sB.storagePath]) {
        const r = await completeThroughRpc(c, exactRpcArgs(cfg, sA, { p_storage_path: p, p_public_url: url(p) }));
        expect(isPermissionDenied(r), `${who}: ${describeCompletion(r)}`).toBe(true);
      }
      lockNotes.push(`${who} -> 42501 x2`);
    }
    const svcSwap = await complete(sA, { p_storage_path: sB.storagePath, p_public_url: url(sB.storagePath) });
    expect(svcSwap.error?.message).toBe(PATH_MISMATCH);
    expectNothingLeft(sA, "A after the service-role swap");
    expect(sessRow(sB.sessionId)).toBe("PENDING|<null>|<null>|false");
    // B's legitimate pending object: removed now (the cleanup would too) so nothing is left by this case
    const rm = await svc.storage.from(BUCKET).remove([sB.storagePath]);
    expect(rm.error).toBeNull();
    expect(objCount(sB.storagePath)).toBe("0");
    for (const [o, s] of [[A, sA], [B, sB]] as const) ok(await rpc(o.admin, "cancel_product_image_upload_session", { p_session_id: s.sessionId }), "cancel");
    ev.pass("G5-3 [083] cross-org", `PUT to A's path with B's token -> ${aWithB.status} "${short(aWithB.body, 40)}"; to B's path with A's token -> ${bWithA.status}; nothing stored; with B's real object present, function complete with A's token (body naming B's path) -> ${describeCompletion(cA)}, A PENDING, B PENDING; RPC with A's token on A's / B's path: ${lockNotes.join(", ")}; service_role with A's token + B's path -> "${svcSwap.error.message}"; B's own object removed, both sessions cancelled`);
  });

  // =========================================================================
  it("8. function abuse: 50 sequential + 50 concurrent token requests for ONE live session, 50 invalid tokens (measured; pre-081 only)", async (ctx) => {
    // The pre-081 measurement (no limit at all). With 081 the same load is
    // refused after 5 tokens; tests 9-13 cover that.
    if (has081()) ctx.skip();
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
    completed(await phoneComplete(s), "complete");
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
  // =========================================================================
  // 081 rate limits. Run ONLY when the stack's schema is >= 081 (after the
  // owner approved and applied 081 and deployed the rate-limited function);
  // on an 080 stack they are skipped. Limits: per session 20 lifetime / 5 per
  // 10 s, per organization 60 per 60 s, per creating user 120 sessions/hour.
  // =========================================================================
  const counters = (id: string) => sql1(`SELECT token_issue_count || '|' || token_window_count FROM product_image_upload_sessions WHERE id = '${id}';`);
  const expect429 = (r: { status: number; body: any; retryAfter: string | null }, max: number) => {
    expect(r.status, JSON.stringify(r.body)).toBe(429);
    expect(Object.keys(r.body ?? {}).sort()).toEqual(["code", "error", "retry_after_seconds"]);
    expect(r.body.code).toBe("rate_limited");
    expect(Number.isInteger(r.body.retry_after_seconds)).toBe(true);
    expect(r.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(r.body.retry_after_seconds).toBeLessThanOrEqual(max);
    expect(r.retryAfter).toBe(String(r.body.retry_after_seconds));
  };

  it("9. [081] per-session burst: 5 tokens, then 429 + Retry-After; after the wait a token again and the upload completes; invalid tokens still a plain 404", async (ctx) => {
    if (!has081()) ctx.skip();
    const s = await createSession(A);
    const first = [];
    for (let i = 0; i < 5; i++) first.push(await callFn(s.token));
    expect(first.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const sixth = await callFn(s.token);
    expect429(sixth, 10);
    expect(counters(s.sessionId)).toBe("5|5");
    expect(objCount(s.storagePath)).toBe("0");
    const waitS = sixth.body.retry_after_seconds;
    await new Promise((r) => setTimeout(r, (waitS + 1) * 1000));
    const after = await callFn(s.token);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(counters(s.sessionId)).toBe("6|1");
    const p = await put(s.storagePath, after.body.token);
    expect(p.status, p.body).toBe(200);
    const done = completed(await phoneComplete(s), "complete after the wait");
    expect(done.status).toBe("COMPLETED");
    const bad = await Promise.all(Array.from({ length: 20 }, () => callFn(randomBytes(64).toString("hex"))));
    expect(bad.every((r) => r.status === 404)).toBe(true);
    ev.pass("9 [081] session burst", `5 x 200, 6th -> 429 ${JSON.stringify(sixth.body)} Retry-After ${sixth.retryAfter}; counters 5|5, no object; after ${waitS + 1} s -> 200 (counters 6|1), PUT 200, COMPLETED; 20 invalid tokens -> 404 (not limited by the DB layer; see the Envoy snippet)`);
  });

  it("10. [081] 30 concurrent token requests for ONE session -> exactly 5 issued, 25 x 429", async (ctx) => {
    if (!has081()) ctx.skip();
    const s = await createSession(A);
    const burst = await Promise.all(Array.from({ length: 30 }, () => callFn(s.token)));
    const ok200 = burst.filter((r) => r.status === 200);
    const r429 = burst.filter((r) => r.status === 429);
    expect(ok200).toHaveLength(5);
    expect(r429).toHaveLength(25);
    for (const r of r429) expect429(r, 10);
    expect(counters(s.sessionId)).toBe("5|5");
    ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: s.sessionId }), "cancel");
    ev.pass("10 [081] concurrent burst", `30 concurrent -> ${ok200.length} x 200 + ${r429.length} x 429; session counters 5|5 (atomic in the DB, across function workers)`);
  });

  it("11. [081] per-session lifetime cap: the 20th token is the last; then 429 with Retry-After = the session's remaining lifetime", async (ctx) => {
    if (!has081()) ctx.skip();
    const s = await createSession(A);
    expect(s.sessionId).toMatch(/^pimg-[0-9a-f]+$/);
    // QA session only: fast-forward its counter to 19
    sql1(`UPDATE product_image_upload_sessions SET token_issue_count = 19 WHERE id = '${s.sessionId}' AND created_by = '${A.adminId}';`);
    const last = await callFn(s.token);
    expect(last.status).toBe(200);
    const capped = await callFn(s.token);
    const left = Number(sql1(`SELECT ceil(extract(epoch FROM expires_at - clock_timestamp())) FROM product_image_upload_sessions WHERE id = '${s.sessionId}';`));
    expect429(capped, 600);
    expect(Math.abs(capped.body.retry_after_seconds - left)).toBeLessThanOrEqual(5);
    expect(counters(s.sessionId).split("|")[0]).toBe("20");
    ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: s.sessionId }), "cancel");
    ev.pass("11 [081] lifetime cap", `token #20 -> 200; #21 -> 429 retry_after ${capped.body.retry_after_seconds} s (session lifetime left ${left} s); counter stays 20`);
  });

  it("12. [081] per-organization window: 65 requests over 13 sessions in one minute -> 60 issued, 5 x 429; another org unaffected", async (ctx) => {
    if (!has081()) ctx.skip();
    const sessions: Sess[] = [];
    for (let i = 0; i < 13; i++) sessions.push(await createSession(A));
    const sB = await createSession(B);
    // fresh window for the QA org only (row cascades away with the QA org at cleanup)
    sql1(`DELETE FROM phone_upload_org_rate WHERE org_id = '${A.orgId}';`);
    const results: { status: number; body: any; retryAfter: string | null }[] = [];
    for (const s of sessions) for (let j = 0; j < 5; j++) results.push(await callFn(s.token));
    const n200 = results.filter((r) => r.status === 200).length;
    const n429 = results.filter((r) => r.status === 429);
    expect(n200).toBe(60);
    expect(n429).toHaveLength(5);
    for (const r of n429) expect429(r, 60);
    expect(sql1(`SELECT issued FROM phone_upload_org_rate WHERE org_id = '${A.orgId}';`)).toBe("60");
    const other = await callFn(sB.token);
    expect(other.status).toBe(200);
    for (const s of [...sessions]) ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: s.sessionId }), "cancel");
    ok(await rpc(B.admin, "cancel_product_image_upload_session", { p_session_id: sB.sessionId }), "cancel B");
    ev.pass("12 [081] org window", `13 sessions x 5 -> ${n200} x 200 + ${n429.length} x 429 (retry_after ${n429.map((r) => r.body.retry_after_seconds).join(",")} s); org counter 60; org B session -> 200`);
  });

  it("13. [081] per-user session creation: the 121st session within an hour -> HTTP 429 (PT429); another user unaffected", async (ctx) => {
    if (!has081()) ctx.skip();
    const recent = Number(sql1(`SELECT count(*) FROM product_image_upload_sessions WHERE created_by = '${B.adminId}' AND created_at > now() - interval '1 hour';`));
    // QA filler rows for B's QA admin up to 119 (removed by cleanup.sql with the QA user)
    sql1(`INSERT INTO product_image_upload_sessions (id, token_hash, created_by, shop_id, storage_path, expires_at)
          SELECT 'pimg-qag4fill' || g || '${ts}', md5('qa-g4-fill' || g || clock_timestamp()), '${B.adminId}', '${B.shop}', 'org/${B.orgId}/temp/pimg-qag4fill' || g || '${ts}', now() + interval '10 minutes'
            FROM generate_series(1, ${Math.max(0, 119 - recent)}) g;`);
    const ok120 = await rpc(B.admin, "create_product_image_upload_session", { p_shop_id: B.shop, p_product_id: B.prod });
    expect(ok120.error).toBeNull();
    const refused = await rpc(B.admin, "create_product_image_upload_session", { p_shop_id: B.shop, p_product_id: B.prod });
    expect(refused.status).toBe(429);
    expect(String(refused.error?.message)).toMatch(/^Too many phone upload links were created\. Try again in \d+ minutes\.$/);
    expect(sql1(`SELECT count(*) FROM product_image_upload_sessions WHERE created_by = '${B.adminId}' AND created_at > now() - interval '1 hour';`)).toBe("120");
    const aStill = await rpc(A.admin, "create_product_image_upload_session", { p_shop_id: A.shop, p_product_id: A.prod });
    expect(aStill.error).toBeNull();
    ok(await rpc(A.admin, "cancel_product_image_upload_session", { p_session_id: aStill.data.sessionId }), "cancel");
    ev.pass("13 [081] per-user sessions", `B admin at 119 (filler QA rows) -> 120th created; 121st -> HTTP ${refused.status} ${refused.error?.code} "${short(refused.error?.message, 80)}"; A admin unaffected`);
  });
});
