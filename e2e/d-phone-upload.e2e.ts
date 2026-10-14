/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase G · D. Phone product-image upload with a JUST-IN-TIME signed upload
// token (docs/selfhost-migration/phase-g/phone-upload-jit.md), in the real UI:
//
//   desktop = the real Electron app (terminal A, QA ADMIN, TOTP) on the
//             product edit page -> "Use phone camera" -> QR modal;
//   phone   = a Chromium page with an iPhone 13 profile that opens the QR URL
//             exactly as the packaged app produces it:
//             <E2E_SUPABASE_URL>/functions/v1/phone-upload-page#<token>
//             (docs/selfhost-migration/phase-f/phone-qr-origin.md). The spec
//             checks that the QR on the desktop encodes exactly that URL -
//             the configured https API origin, never the dev server.
//
// Where the phone page (phone-upload-page Edge Function) comes from
// (E2E_PHONE_PAGE):
//   local (default UNTIL the function + router patch are deployed) - the
//             phone's navigation to <stack>/functions/v1/phone-upload-page
//             is answered by a disposable local edge-runtime container
//             (helpers/edgeRuntime.ts) running this repo's copy. The page
//             still lives on the stack's origin for the browser, so all its
//             API calls go to the real stack.
//   deployed - no routing: the page is served by lucashome. Switch the
//             default to "deployed" once phone-qr-origin.md §6 is done.
//
// Where the phone-upload-token Edge Function runs (E2E_PHONE_FN):
//   deployed (default) - the function deployed on the stack. No container is
//             started and the function request is NOT routed anywhere: the
//             phone page calls <stack>/functions/v1/phone-upload-token itself
//             (observed passively for the evidence ledger).
//   local   - a disposable local supabase/edge-runtime:v1.76.2 container
//             (helpers/edgeRuntime.ts, 127.0.0.1 only) runs this repo's copy
//             and the phone's request for the function is routed to it (the
//             pre-deployment mode; needs Docker).
// Everything else (session RPCs, storage upload, completion, the desktop's
// status poll) is the real stack. The D-ratelimit-* cases (migration 081)
// run only when the stack's schema is >= 081 and are skipped otherwise. Real timing. Since 080 every successful
// case also saves the product and checks that products.image_url is the
// SERVER-DERIVED URL (public.app_config origin + /storage/v1/object/public/
// product-images/<session path>). QA data only; every QA storage object is
// removed through the Storage API in afterAll, and the non-QA objects (574,
// incl. the 17 orphans) are proven byte-identical.
import { expect, test, type Route } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import { ensureQaBarcode, runSql, sleep, svc } from "./helpers/db";
import { startLocalFunctions, type LocalFunctionName, type LocalFunctions } from "./helpers/edgeRuntime";
import { DEV_SERVER_URL, liveCfg, qaPassword, qaState, qaTotpSecret, RESULTS_DIR } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal } from "./helpers/terminal";

test.describe.configure({ mode: "serial" });

const st = qaState();
const pw = qaPassword();
const secret = qaTotpSecret();
const { ids, emails } = st;
const cfg = liveCfg();
const BUCKET = "product-images";
const FN_PATH = "/functions/v1/phone-upload-token";
const FN_MODE = (process.env.E2E_PHONE_FN ?? "deployed").trim();
if (FN_MODE !== "deployed" && FN_MODE !== "local") throw new Error(`E2E_PHONE_FN must be "deployed" or "local", got "${FN_MODE}"`);
const PAGE_PATH = "/functions/v1/phone-upload-page";
// Default "local" until phone-upload-page + the router patch are deployed (phone-qr-origin.md §6), then "deployed".
const PAGE_MODE = (process.env.E2E_PHONE_PAGE ?? "deployed").trim();
if (PAGE_MODE !== "deployed" && PAGE_MODE !== "local") throw new Error(`E2E_PHONE_PAGE must be "deployed" or "local", got "${PAGE_MODE}"`);
const MODES = `fn ${FN_MODE}, page ${PAGE_MODE}`;
const QA_OBJECT = new RegExp(`^org/${ids.org}/temp/pimg-[0-9a-f]+$`);
// Tiny lossless WebP (34 bytes) for the programmatic race (same constant as phase-g3).
const TINY_WEBP_B64 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const PHONE_READY = "Choose or take a product photo.";
const PHONE_DONE = "Photo uploaded. You can return to the computer.";
const PHONE_EXPIRED = "This upload link has expired. Create a new QR code on the computer.";
const PHONE_CANCELLED = "This upload link was cancelled on the computer. Create a new QR code to upload.";

let A: Terminal;
let local: LocalFunctions | undefined;
/** public.app_config.supabase_public_url (080): the only origin a stored image URL may carry. */
let trustedBase = "";
/** max(supabase_migrations.schema_migrations.version); the 081 rate-limit cases need >= "081". */
let schemaVersion = "";
let photo: Buffer;
let storageBefore = "";
let orphansBefore = "";
const timings: string[] = [];

const sql1 = (q: string) => runSql(q).trim();
const secs = (ms: number) => (ms / 1000).toFixed(1);

// Non-QA objects, every column but last_accessed_at (a public read may touch it).
const STORAGE_FP = `SELECT count(*) || ' objects, md5 ' || md5(string_agg((to_jsonb(z) - 'last_accessed_at')::text, '|' ORDER BY z.bucket_id, z.name)) FROM storage.objects z WHERE z.name NOT LIKE 'org/qa-%';`;
const ORPHANS_FP = `SELECT count(*) || ' orphans, md5 ' || md5(string_agg((to_jsonb(o) - 'last_accessed_at')::text, '|' ORDER BY o.name)) FROM storage.objects o
  WHERE o.bucket_id = '${BUCKET}' AND (
        (o.name LIKE 'temp/%' AND NOT EXISTS (SELECT 1 FROM product_image_upload_sessions s WHERE s.storage_path = o.name))
     OR (o.name LIKE 'products/%' AND o.name NOT LIKE 'products/brand/%' AND NOT EXISTS (SELECT 1 FROM products p WHERE o.name LIKE 'products/' || p.id || '/%')));`;

interface Sess { sessionId: string; token: string; storagePath: string; qrUrl: string; shownAt: number }
interface FnCall { at: number; status: number; kind: "token" | "already" | "refused"; code?: string; sessionStatus?: string; keys: string; path?: string; text: string }
interface Put { at: number; status: number; body: string; dropped?: boolean }

const sessionRow = (id: string) =>
  sql1(`SELECT status || '|' || storage_path || '|' || COALESCE(public_url, '<null>') || '|' || COALESCE(bytes::text, '<null>') || '|' || (completed_at IS NOT NULL) || '|' || (signed_upload_token IS NOT NULL) FROM product_image_upload_sessions WHERE id = '${id}';`);
const objectsUnder = (s: Sess) => Number(sql1(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name LIKE '${s.storagePath}%';`));
const objectSize = (s: Sess) => sql1(`SELECT COALESCE(string_agg(metadata->>'size', ','), '') FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${s.storagePath}';`);
/** The server-derived URL (080): trusted base from app_config + bucket + session path. */
const publicUrl = (p: string) => `${trustedBase}/storage/v1/object/public/${BUCKET}/${p}`;
const productImageUrl = () => sql1(`SELECT COALESCE(image_url, '<null>') FROM products WHERE id = '${ids.prod1}';`);

/** Desktop: open the QR modal; the session comes from the create RPC's response (kept in memory, never logged). */
async function openQr(): Promise<Sess> {
  const created = A.page.waitForResponse((r) => r.url().endsWith("/rest/v1/rpc/create_product_image_upload_session") && r.request().method() === "POST");
  created.catch(() => undefined); // awaited below; never an unhandled rejection
  const button = A.page.getByRole("button", { name: "Use phone camera" });
  try {
    await button.click({ timeout: 30_000 });
  } catch (e) {
    // Diagnostics for a desktop that stopped responding (seen once 2026-10-14:
    // click never actionable, then app.close() hung past the teardown timeout).
    const responsive = await Promise.race([
      A.page.evaluate(() => document.readyState).then((s) => `yes (${s})`, (err) => `error ${String(err).slice(0, 80)}`),
      new Promise<string>((r) => setTimeout(() => r("NO (evaluate did not return in 5 s)"), 5_000)),
    ]);
    const diag = `route=${A.currentRoute()}; button visible=${await button.isVisible().catch(() => "?")} enabled=${await button.isEnabled({ timeout: 2_000 }).catch(() => "?")}; renderer responsive=${responsive}; console: ${A.consoleErrors.slice(-5).join(" || ")}`;
    record("phone-upload", "desktop could not open the QR", "INFO", diag);
    throw new Error(`could not open the QR modal: ${(e as Error).message.split("\n")[0]}; ${diag}`);
  }
  const res = await created;
  expect(res.status()).toBe(200);
  const j = await res.json();
  await A.page.locator("svg", { has: A.page.locator("title", { hasText: "Product image phone upload QR code" }) }).waitFor({ state: "visible" });
  const shownAt = Date.now();
  await expect(A.page.getByText("Waiting for upload...")).toBeVisible();
  expect(j.storagePath).toBe(`org/${ids.org}/temp/${j.sessionId}`);
  // The desktop no longer signs or attaches anything: no storage sign request, no attach RPC.
  const signedByDesktop = A.requestsMatching(/\/storage\/v1\/object\/upload\/sign\/|attach_product_image_upload_session_token/, shownAt - 15_000);
  expect(signedByDesktop, "desktop must not sign/attach a token").toHaveLength(0);
  const qrUrl = await assertQrEncodesPhonePage(j.token);
  return { sessionId: j.sessionId, token: j.token, storagePath: j.storagePath, qrUrl, shownAt };
}

/** The URL the packaged app must put in the QR: the configured https API origin's phone page, token in the fragment. */
const expectedQrUrl = (token: string) => `${cfg.url}${PAGE_PATH}#${encodeURIComponent(token)}`;

/** `d` of every <path> of a QR rendered with the modal's own props (ProductImagePhoneUploadModal). */
const qrPaths = (value: string): string[] =>
  [...renderToStaticMarkup(createElement(QRCodeSVG, { value, size: 212, marginSize: 2, level: "Q", bgColor: "#ffffff", fgColor: "#0f172a", title: "Product image phone upload QR code" }))
    .matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);

/**
 * The QR shown on the desktop encodes EXACTLY expectedQrUrl(token): its
 * modules are compared with a QR rendered for that URL (same library, same
 * props). Also asserts the origin is the configured https stack origin, not
 * the dev server the Electron renderer runs from in this suite, and that
 * the renderer resolves the phone page the way a packaged (file://) app does.
 */
async function assertQrEncodesPhonePage(token: string): Promise<string> {
  const url = expectedQrUrl(token);
  const u = new URL(url);
  expect(u.protocol).toBe("https:");
  expect(u.origin).toBe(new URL(cfg.url).origin);
  expect(u.origin).not.toBe(new URL(DEV_SERVER_URL).origin);
  expect(u.pathname).toBe(PAGE_PATH);
  expect(u.search).toBe("");
  const shown = await A.page
    .locator("svg", { has: A.page.locator("title", { hasText: "Product image phone upload QR code" }) })
    .locator("path")
    .evaluateAll((els) => els.map((e) => e.getAttribute("d") ?? ""));
  expect(shown.length).toBeGreaterThan(0);
  expect(shown, "the desktop QR encodes <stack>/functions/v1/phone-upload-page#<token>").toEqual(qrPaths(url));
  expect(shown).not.toEqual(qrPaths(`${DEV_SERVER_URL}/phone-upload/product-image/${encodeURIComponent(token)}`));
  // the renderer's own decision (Electron -> backend-served page), same code as the packaged app
  const page = await A.page.evaluate(async (modulePath) => {
    const m: any = await import(modulePath);
    return m.currentPhoneUploadPage();
  }, "/src/lib/productImagePhoneUpload.ts");
  expect(page).toEqual({ kind: "functionPage", origin: new URL(cfg.url).origin, base: `${new URL(cfg.url).origin}${PAGE_PATH}` });
  return url;
}

const fnCall = (status: number, text: string): FnCall => {
  let b: any = null;
  try { b = JSON.parse(text); } catch { /* keep null */ }
  return {
    at: Date.now(), status,
    kind: b?.token ? "token" : b?.alreadyUploaded ? "already" : "refused",
    code: b?.code, sessionStatus: b?.status, keys: Object.keys(b ?? {}).sort().join(","), path: b?.path, text,
  };
};

/** Phone terminal + request ledgers. The function is reached as configured
 *  by E2E_PHONE_FN (deployed: untouched, observed; local: routed). */
async function launchPhone(opts: { holdFirstPutMs?: number; dropFirstUploadResponse?: boolean } = {}) {
  const P = await Terminal.launchPhone();
  const fnCalls: FnCall[] = [];
  const puts: Put[] = [];
  const completes: { at: number; status: number }[] = [];
  let dropped = false;
  let held = false;
  if (PAGE_MODE === "local") {
    // The phone navigates to <stack>/functions/v1/phone-upload-page#<token>;
    // the browser never sends the fragment. The document is answered by the
    // local container (this repo's function), so the page lives on the
    // stack's origin and its API calls reach the real stack.
    await P.context.route((u) => u.origin === new URL(cfg.url).origin && u.pathname === PAGE_PATH, async (route: Route) => {
      expect(route.request().url(), "the token never reaches the server").not.toMatch(/#|token=/);
      const r = await route.fetch({ url: local!.urlFor("phone-upload-page") });
      await route.fulfill({ response: r });
    });
  }
  if (FN_MODE === "local") {
    await P.context.route(`${cfg.url}${FN_PATH}`, async (route: Route) => {
      const r = await route.fetch({ url: local!.urlFor("phone-upload-token") });
      if (route.request().method() === "OPTIONS") return route.fulfill({ response: r });
      const text = await r.text();
      fnCalls.push(fnCall(r.status(), text));
      await route.fulfill({ response: r, body: text });
    });
  } else {
    // deployed: no route at all - the page's own request reaches the stack's
    // /functions/v1/phone-upload-token; the answer is only observed.
    P.context.on("response", (res) => {
      if (res.url() !== `${cfg.url}${FN_PATH}` || res.request().method() !== "POST") return;
      const status = res.status();
      void res.text().then((text) => fnCalls.push(fnCall(status, text)), () => fnCalls.push(fnCall(status, "")));
    });
  }
  await P.context.route(`${cfg.url}/storage/v1/object/upload/sign/**`, async (route: Route) => {
    if (route.request().method() !== "PUT") return route.continue();
    // stale token: the first PUT leaves the phone only after the hold, so the
    // token it carries (issued just before) is older than storage's 60 s.
    if (opts.holdFirstPutMs && !held) { held = true; await sleep(opts.holdFirstPutMs); }
    const r = await route.fetch();
    const body = (await r.text()).slice(0, 200);
    if (opts.dropFirstUploadResponse && !dropped) {
      dropped = true;
      puts.push({ at: Date.now(), status: r.status(), body, dropped: true });
      return route.abort("connectionreset"); // the server stored it; the phone never hears back
    }
    puts.push({ at: Date.now(), status: r.status(), body });
    return route.fulfill({ response: r, body });
  });
  await P.context.route(`${cfg.url}/rest/v1/rpc/complete_product_image_upload_session`, async (route: Route) => {
    const r = await route.fetch();
    completes.push({ at: Date.now(), status: r.status() });
    return route.fulfill({ response: r });
  });
  return { P, fnCalls, puts, completes };
}

async function phoneOpens(P: Terminal, s: Sess): Promise<void> {
  const doc = P.page.waitForResponse((r) => new URL(r.url()).pathname === PAGE_PATH && r.request().isNavigationRequest());
  await P.page.goto(s.qrUrl);
  const res = await doc;
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("text/html; charset=utf-8");
  expect(res.headers()["content-security-policy"]).toMatch(/default-src 'none'.*connect-src 'self'/);
  expect(new URL(P.page.url()).origin, "the phone is on the configured https origin").toBe(new URL(cfg.url).origin);
  await expect(P.page.getByText(PHONE_READY)).toBeVisible();
}

async function phonePicks(P: Terminal): Promise<number> {
  const at = Date.now();
  await P.page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "qa-photo.png", mimeType: "image/png", buffer: photo });
  return at;
}

/** Desktop shows the image (modal preview AND, after "Use this image", the form thumbnail). */
async function desktopShowsImage(s: Sess): Promise<string> {
  const url = publicUrl(s.storagePath);
  await expect(A.page.getByText("Upload received")).toBeVisible({ timeout: 20_000 });
  const preview = A.page.getByAltText("Uploaded product preview");
  await expect(preview).toHaveAttribute("src", url);
  await expect.poll(() => preview.evaluate((e: HTMLImageElement) => (e.complete ? e.naturalWidth : 0)), { timeout: 15_000 }).toBeGreaterThan(0);
  const w = await preview.evaluate((e: HTMLImageElement) => `${e.naturalWidth}x${e.naturalHeight}`);
  await A.page.getByRole("button", { name: "Use this image", exact: true }).click();
  await expect(A.page.getByAltText("Product preview")).toHaveAttribute("src", url);
  return w;
}

/** Desktop saves the product ("Update Product"); products.image_url must be
 *  exactly the server-derived URL. Returns to the edit page for the next case. */
async function saveProductAndCheckImageUrl(s: Sess): Promise<string> {
  const expected = publicUrl(s.storagePath);
  await A.page.getByRole("button", { name: "Update Product", exact: true }).click();
  await expect.poll(() => A.currentRoute(), { timeout: 30_000 }).toBe("/app/admin/products");
  await expect.poll(productImageUrl, { timeout: 20_000 }).toBe(expected);
  const ok = productImageUrl() === expected && expected.startsWith(`${trustedBase}/storage/v1/object/public/${BUCKET}/org/`);
  await A.navigate(`/app/admin/products/${ids.prod1}/edit`);
  await A.page.getByRole("button", { name: "Use phone camera" }).waitFor({ state: "visible", timeout: 30_000 });
  await expect(A.page.getByAltText("Product preview")).toHaveAttribute("src", expected);
  return `products.image_url == app_config origin + /storage/v1/object/public/${BUCKET}/<session path>: ${ok}`;
}

/** DB + storage after a successful flow: one object, COMPLETED once, size = completion bytes, public GET serves it. */
async function assertCompletedOnce(s: Sess): Promise<string> {
  const row = sessionRow(s.sessionId);
  const [status, p, url, bytes, completed, tokenKept] = row.split("|");
  expect(status).toBe("COMPLETED");
  expect(p).toBe(s.storagePath);
  expect(url).toBe(publicUrl(s.storagePath));
  expect(completed).toBe("true");
  expect(tokenKept).toBe("false");
  expect(objectsUnder(s)).toBe(1);
  expect(objectSize(s)).toBe(bytes);
  const get = await fetch(url);
  expect(get.status).toBe(200);
  expect(String((await get.arrayBuffer()).byteLength)).toBe(bytes);
  // what the desktop poll hands back (080: derived, never the stored column)
  const polled = sql1(`SELECT public.app_upload_session_public_url(storage_path) FROM product_image_upload_sessions WHERE id = '${s.sessionId}';`);
  expect(polled).toBe(url);
  return `session COMPLETED once (completed_at set, signed_upload_token NULL), public_url = derived trusted URL, bytes=${bytes}, objects under session path=1 (size ${bytes}), public GET 200 ${bytes} B`;
}

function assertTokenResponse(c: FnCall, s: Sess): void {
  expect(c.status).toBe(200);
  expect(c.keys).toBe("expiresAt,path,token");
  expect(c.path).toBe(s.storagePath);
  for (const leak of [ids.prod1, ids.shop, ids.admin, ids.org.replace(/^qa-org-/, "QA Org "), s.token, cfg.serviceKey, cfg.anonKey]) {
    expect(c.text.includes(leak), "function response leaks an id/name/key").toBe(false);
  }
  // The only identifier in the answer is the object path (already returned by _by_token by design).
  expect(c.text.replace(s.storagePath, "<path>").includes(s.sessionId)).toBe(false);
}

test.beforeAll(async () => {
  storageBefore = sql1(STORAGE_FP);
  orphansBefore = sql1(ORPHANS_FP);
  expect(storageBefore.startsWith("574 objects")).toBe(true);
  expect(orphansBefore.startsWith("17 orphans")).toBe(true);
  record("phone-upload", "storage baseline", "INFO", `${storageBefore}; ${orphansBefore}`);

  schemaVersion = sql1(`SELECT max(version) FROM supabase_migrations.schema_migrations;`);
  record("phone-upload", "schema", "INFO", `schema ${schemaVersion}; 081 rate-limit cases ${schemaVersion >= "081" ? "RUN" : "SKIPPED (not deployed)"}`);
  trustedBase = sql1(`SELECT value FROM public.app_config WHERE key = 'supabase_public_url';`);
  expect(trustedBase, "080 app_config.supabase_public_url must be set").toMatch(/^https:\/\/[a-z0-9.-]+(:\d+)?$/);
  expect(trustedBase, "the stack's trusted origin is the origin the apps are built for").toBe(cfg.url);
  const localNames: LocalFunctionName[] = [
    ...(FN_MODE === "local" ? (["phone-upload-token"] as const) : []),
    ...(PAGE_MODE === "local" ? (["phone-upload-page"] as const) : []),
  ];
  if (localNames.length) {
    local = await startLocalFunctions(localNames);
    record("phone-upload", "local edge-runtime", "INFO", `container ${local.container} (supabase/edge-runtime:v1.76.2) on ${local.base} serving ${localNames.join(", ")}, router = lucashome main/index.ts copy, VERIFY_JWT=false locally`);
  }
  if (PAGE_MODE === "deployed") {
    // smoke: the deployed page answers a plain browser GET (no Authorization: needs the router patch)
    const r = await fetch(`${cfg.url}${PAGE_PATH}`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(html.includes(cfg.serviceKey)).toBe(false);
    record("phone-upload", "deployed page", "INFO", `E2E_PHONE_PAGE=deployed: GET ${PAGE_PATH} without auth -> ${r.status} ${r.headers.get("content-type")}, CSP present, ${html.length} B, no service key`);
  }
  if (FN_MODE === "deployed") {
    // smoke: the deployed route answers the function's own generic 404 (no data written)
    const r = await fetch(`${cfg.url}${FN_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${cfg.anonKey}`, apikey: cfg.anonKey, "content-type": "application/json" }, body: JSON.stringify({ token: "short" }) });
    const body = await r.json().catch(() => null);
    expect(r.status).toBe(404);
    expect(body).toEqual({ error: "Invalid upload link.", code: "invalid" });
    record("phone-upload", "deployed function", "INFO", `E2E_PHONE_FN=deployed: no local container, no routing; smoke POST {token:"short"} with the anon bearer -> ${r.status} ${JSON.stringify(body)}`);
  }

  rmSync(path.join(RESULTS_DIR, "userdata-d"), { recursive: true, force: true });
  A = await Terminal.launchElectron(path.join(RESULTS_DIR, "userdata-d"));
  await A.loginAdminWithTotp(emails.admin, pw, secret);
  await A.waitForApp();
  await A.navigate(`/app/admin/products/${ids.prod1}/edit`);
  await A.page.getByRole("button", { name: "Use phone camera" }).waitFor({ state: "visible", timeout: 30_000 });
  photo = Buffer.from(await A.page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 480;
    const g = c.getContext("2d")!;
    const grd = g.createLinearGradient(0, 0, 640, 480);
    grd.addColorStop(0, "#0a7"); grd.addColorStop(1, "#fc3");
    g.fillStyle = grd; g.fillRect(0, 0, 640, 480);
    g.fillStyle = "#123"; g.font = "64px sans-serif"; g.fillText("QA photo", 160, 260);
    return c.toDataURL("image/png").split(",")[1];
  }), "base64");
});

test.afterAll(async () => {
  try {
    // Saving QA Product One through the form drops its seeded barcode (see
    // ensureQaBarcode); leave the shared fixture as this spec found it.
    record("phone-upload", "QA Product One barcode after the product saves", "INFO", await ensureQaBarcode(st));
    const names = sql1(`SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name LIKE 'org/${ids.org}/%';`).split("\n").filter(Boolean);
    const unexpected = names.filter((n) => !QA_OBJECT.test(n));
    if (unexpected.length) throw new Error(`refusing to delete unexpected names: ${unexpected.join(",")}`);
    let removed = 0;
    if (names.length) {
      const r = await svc().storage.from(BUCKET).remove(names);
      if (r.error) throw new Error(r.error.message);
      removed = r.data?.length ?? 0;
    }
    const left = sql1(`SELECT count(*) FROM storage.objects WHERE name LIKE 'org/qa-%';`);
    const storageAfter = sql1(STORAGE_FP);
    const orphansAfter = sql1(ORPHANS_FP);
    const same = storageAfter === storageBefore && orphansAfter === orphansBefore;
    record("phone-upload", "storage cleanup + untouched", same && left === "0" ? "PASS" : "FAIL",
      `QA objects removed via service-role Storage API=${removed}/${names.length}; QA objects left=${left}; non-QA before=${storageBefore} after=${storageAfter}; ${orphansBefore} -> ${orphansAfter}; identical=${same}`);
    process.stdout.write(`\n[phone-upload timings]\n${timings.join("\n")}\n\n`);
  } finally {
    try { if (A) await assertConsistency("spec D", [A]); } finally {
      await A?.close();
      local?.stop();
    }
  }
});

// --------------------------------------------------------------------------
for (const delayS of [30, 65, 120, 300]) {
  test(`D${delayS}: upload ${delayS} s after the QR is displayed -> fresh token, one object, COMPLETED once, desktop shows it`, async () => {
    test.setTimeout((delayS + 120) * 1000);
    const s = await openQr();
    const { P, fnCalls, puts, completes } = await launchPhone();
    try {
      await phoneOpens(P, s);
      const openedAfter = Date.now() - s.shownAt;
      await sleep(Math.max(0, s.shownAt + delayS * 1000 - Date.now()));
      const pickedAt = await phonePicks(P);
      await expect(P.page.getByText(PHONE_DONE).first()).toBeVisible({ timeout: 60_000 });
      const size = await desktopShowsImage(s);
      const db = await assertCompletedOnce(s);
      const img = await saveProductAndCheckImageUrl(s);
      expect(fnCalls.map((c) => c.kind)).toEqual(["token"]);
      assertTokenResponse(fnCalls[0], s);
      expect(puts.map((p) => p.status)).toEqual([200]);
      expect(completes.map((c) => c.status)).toEqual([200]);
      const tokenAt = fnCalls[0].at - s.shownAt;
      const tokenAgeAtPut = puts[0].at - fnCalls[0].at;
      const line = `| ${delayS} s | phone opened +${secs(openedAfter)} s | file picked +${secs(pickedAt - s.shownAt)} s | token issued +${secs(tokenAt)} s | PUT 200 +${secs(puts[0].at - s.shownAt)} s (token age ${tokenAgeAtPut} ms) | complete 200 | COMPLETED | desktop image ${size} |`;
      timings.push(line);
      record("phone-upload", `D${delayS} upload at +${delayS} s`, "PASS", `[${MODES}] ${line} ${db}; ${img}; function answer keys {${fnCalls[0].keys}} path=session path, no ids`);
    } finally {
      await P.close();
    }
  });
}

test("D-stale: a token used 66 s after issue is refused by storage; the phone transparently gets a fresh one and completes", async () => {
  test.setTimeout(240_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone({ holdFirstPutMs: 66_000 });
  try {
    await phoneOpens(P, s);
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_DONE).first()).toBeVisible({ timeout: 150_000 });
    const size = await desktopShowsImage(s);
    const db = await assertCompletedOnce(s);
    const img = await saveProductAndCheckImageUrl(s);
    expect(fnCalls.map((c) => c.kind)).toEqual(["token", "token"]);
    assertTokenResponse(fnCalls[1], s);
    expect(puts.map((p) => p.status)).toEqual([400, 200]);
    expect(puts[0].body).toMatch(/exp|jwt/i);
    expect(completes.map((c) => c.status)).toEqual([200]);
    const age = puts[0].at - fnCalls[0].at;
    expect(age).toBeGreaterThanOrEqual(65_000);
    const line = `| stale token | token #1 used ${secs(age)} s after issue -> PUT ${puts[0].status} ${puts[0].body.replace(/\s+/g, " ").slice(0, 90)} | token #2 +${secs(fnCalls[1].at - s.shownAt)} s -> PUT 200 | complete 200 | COMPLETED | desktop image ${size} |`;
    timings.push(line);
    record("phone-upload", "D-stale token refused then refreshed", "PASS", `[${MODES}] ${line} ${db}; ${img}`);
  } finally {
    await P.close();
  }
});

test("D-double-tap: two picks in a row -> one token, one PUT, one completion, one object", async () => {
  test.setTimeout(120_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone();
  try {
    await phoneOpens(P, s);
    const chooser = P.page.waitForEvent("filechooser");
    await P.page.getByRole("button", { name: "Choose from library" }).tap();
    await (await chooser).setFiles({ name: "qa-photo.png", mimeType: "image/png", buffer: photo });
    // second tap + a second picker result while the first is in flight
    await P.page.getByRole("button", { name: "Choose from library" }).tap({ force: true }).catch(() => undefined);
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_DONE).first()).toBeVisible({ timeout: 60_000 });
    await sleep(3_000); // let any (wrong) second attempt surface
    await desktopShowsImage(s);
    const db = await assertCompletedOnce(s);
    const img = await saveProductAndCheckImageUrl(s);
    expect(fnCalls.map((c) => c.kind)).toEqual(["token"]);
    expect(puts.map((p) => p.status)).toEqual([200]);
    expect(completes.map((c) => c.status)).toEqual([200]);
    record("phone-upload", "D-double-tap", "PASS", `[${MODES}] function calls=${fnCalls.length}, PUTs=${puts.map((p) => p.status).join(",")}, completes=${completes.map((c) => c.status).join(",")}; ${db}; ${img}`);
  } finally {
    await P.close();
  }
});

test("D-race: two concurrent uploads of the same session (real client code) -> one object, one completion, both report COMPLETED", async () => {
  test.setTimeout(120_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone();
  try {
    await phoneOpens(P, s);
    const results = await P.page.evaluate(async (b64) => {
      // the phone page's own upload code (phone-upload-page client.js), with
      // the token it read from its own #fragment
      const page = (window as any).shwePhaLaPhoneUpload;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const image = { blob: new Blob([bytes], { type: "image/webp" }), bytes: bytes.length, mimeType: "image/webp" };
      const rs = await Promise.allSettled([page.uploadImage(image), page.uploadImage(image)]);
      return rs.map((r) => (r.status === "fulfilled" ? `${r.value.status}` : `rejected: ${String((r.reason as Error)?.message)}`));
    }, TINY_WEBP_B64);
    expect(results).toEqual(["COMPLETED", "COMPLETED"]);
    await expect(A.page.getByText("Upload received")).toBeVisible({ timeout: 20_000 });
    await expect(A.page.getByAltText("Uploaded product preview")).toHaveAttribute("src", publicUrl(s.storagePath));
    await A.page.getByRole("button", { name: "Use this image", exact: true }).click();
    const db = await assertCompletedOnce(s);
    const img = await saveProductAndCheckImageUrl(s);
    // Exactly one object and one completion are the invariants. How storage
    // answers two simultaneous PUTs of the same JWT (same second -> identical
    // token) varies: seen as 200 + 400 "409 Duplicate" (local function run)
    // and as 200 + 200 within 4 ms (deployed run, 2026-10-13) - the second
    // write landing on the same single object row. Recorded, not hidden.
    const put200 = puts.filter((p) => p.status === 200).length;
    expect(put200).toBeGreaterThanOrEqual(1);
    expect(put200 + puts.filter((p) => /Duplicate|409/.test(p.body)).length).toBe(2);
    expect(objectsUnder(s)).toBe(1);
    const objRow = sql1(`SELECT COALESCE(metadata->>'size','-') || ' B, version ' || COALESCE(version,'-') || ', created ' || created_at || ', updated ' || updated_at FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${s.storagePath}';`);
    expect(completes.filter((c) => c.status === 200)).toHaveLength(1);
    record("phone-upload", "D-race (2 concurrent uploads)", "PASS",
      `[${MODES}] both calls -> ${results.join(" / ")}; function answers=${fnCalls.map((c) => c.kind).join(",")}; PUTs=${puts.map((p) => `${p.status}${p.status !== 200 ? ` "${p.body.replace(/\s+/g, " ").slice(0, 70)}"` : ""}`).join(", ")}; completes=${completes.map((c) => c.status).join(",")}; object row: ${objRow}; ${db}; ${img}`);
  } finally {
    await P.close();
  }
});

test("D-retry: the upload response is lost after storage stored it -> phone retries, server says already uploaded, completes once", async () => {
  test.setTimeout(120_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone({ dropFirstUploadResponse: true });
  try {
    await phoneOpens(P, s);
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_DONE).first()).toBeVisible({ timeout: 60_000 });
    await desktopShowsImage(s);
    const db = await assertCompletedOnce(s);
    const img = await saveProductAndCheckImageUrl(s);
    expect(fnCalls.map((c) => c.kind)).toEqual(["token", "already"]);
    expect(fnCalls[1].keys).toBe("alreadyUploaded,path");
    expect(puts.map((p) => `${p.status}${p.dropped ? "(dropped)" : ""}`)).toEqual(["200(dropped)"]);
    expect(completes.map((c) => c.status)).toEqual([200]);
    record("phone-upload", "D-retry after lost response", "PASS", `[${MODES}] function answers=${fnCalls.map((c) => c.kind).join(",")}; PUTs=200 stored but response dropped, no second PUT; completes=200 x1; ${db}; ${img}`);
  } finally {
    await P.close();
  }
});

test("D-expired: parent session expired (expires_at set to the past) -> phone says expired, no token, no object, row stamped EXPIRED by the function", async () => {
  test.setTimeout(120_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone();
  // Hold the desktop's status poll (it would stamp EXPIRED itself) so the stamp is provably the function's.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const pollGlob = `${cfg.url}/rest/v1/rpc/get_product_image_upload_session_status`;
  await A.page.route(pollGlob, async (route) => { await gate; await route.continue().catch(() => undefined); });
  const imageBefore = productImageUrl();
  try {
    await phoneOpens(P, s);
    await sleep(2_500); // any poll already in flight finishes or is held
    const ex = await svc().from("product_image_upload_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", s.sessionId).select("id");
    expect(ex.error).toBeNull();
    expect(ex.data).toHaveLength(1);
    expect(sessionRow(s.sessionId).startsWith("PENDING|")).toBe(true);
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_EXPIRED)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => fnCalls.length).toBe(1);
    expect(fnCalls.map((c) => `${c.status}:${c.code}:${c.sessionStatus}`)).toEqual(["410:inactive:EXPIRED"]);
    expect(fnCalls[0].text.includes("token\"")).toBe(false);
    expect(puts).toHaveLength(0);
    expect(completes).toHaveLength(0);
    const stamped = sessionRow(s.sessionId);
    expect(stamped.split("|")[0]).toBe("EXPIRED");
    expect(objectsUnder(s)).toBe(0);
    release();
    await A.page.unroute(pollGlob);
    await expect(A.page.getByText("Upload failed / expired")).toBeVisible({ timeout: 20_000 });
    await A.page.getByRole("button", { name: "Close", exact: true }).click();
    expect(productImageUrl()).toBe(imageBefore);
    record("phone-upload", "D-expired session refused", "PASS", `[${MODES}] products.image_url unchanged; phone: "${PHONE_EXPIRED}"; function 410 inactive/EXPIRED, no token; PUTs=0, completes=0; row (desktop poll held) = ${stamped.split("|").slice(0, 1)} (stamped by the function via _by_token); objects=0; desktop after poll: "Upload failed / expired"`);
  } finally {
    release();
    await A.page.unroute(pollGlob).catch(() => undefined);
    await P.close();
  }
});

test("D-cancelled: desktop closes the QR (cancel) -> phone refused with a clear message, no token, no object", async () => {
  test.setTimeout(120_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone();
  const imageBefore = productImageUrl();
  try {
    await phoneOpens(P, s);
    const cancelled = A.page.waitForResponse((r) => r.url().endsWith("/rest/v1/rpc/cancel_product_image_upload_session"));
    await A.page.getByRole("button", { name: "Close", exact: true }).click();
    expect((await cancelled).status()).toBeLessThan(300);
    await expect(A.page.getByText("Upload from phone")).toBeHidden();
    expect(sessionRow(s.sessionId).split("|")[0]).toBe("CANCELED");
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_CANCELLED)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => fnCalls.length).toBe(1);
    expect(fnCalls.map((c) => `${c.status}:${c.code}:${c.sessionStatus}`)).toEqual(["410:inactive:CANCELED"]);
    expect(puts).toHaveLength(0);
    expect(completes).toHaveLength(0);
    expect(sessionRow(s.sessionId).split("|")[0]).toBe("CANCELED");
    expect(objectsUnder(s)).toBe(0);
    expect(productImageUrl()).toBe(imageBefore);
    record("phone-upload", "D-cancelled session refused", "PASS", `[${MODES}] products.image_url unchanged; desktop Close -> cancel RPC, modal gone; phone: "${PHONE_CANCELLED}"; function 410 inactive/CANCELED, no token; PUTs=0, completes=0; row CANCELED; objects=0`);
  } finally {
    await P.close();
  }
});

// --------------------------------------------------------------------------
// 081 rate limits (docs/selfhost-migration/phase-f/rate-limiting.md). These
// run ONLY when the stack's schema is >= 081, i.e. after the owner approved
// and applied 081 and deployed the rate-limited function; on an 080 stack
// they are skipped. Limits: 5 tokens per session per 10 s, 20 per session.
const PHONE_WAITING = /Too many attempts right now\. Trying again automatically in \d+ s\.\.\./;
const PHONE_LINK_USED_UP = "This upload link has been used too many times. Create a new QR code on the computer.";

/** Ask the function for tokens directly (the anon key only), as a second phone would. */
async function burnTokens(s: Sess, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${cfg.url}${FN_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${cfg.anonKey}`, apikey: cfg.anonKey, "content-type": "application/json" }, body: JSON.stringify({ token: s.token }) });
    await r.text();
    out.push(r.status);
  }
  return out;
}

test("D-ratelimit-wait [081]: the phone hits the session burst limit (429) -> shows the wait message, retries by itself after Retry-After, completes once", async () => {
  test.skip(schemaVersion < "081", `schema ${schemaVersion} < 081: rate limits not deployed`);
  test.setTimeout(180_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone();
  try {
    await phoneOpens(P, s);
    // 5 tokens taken right before the pick: the phone's own request is the 6th in the 10 s window
    expect(await burnTokens(s, 5)).toEqual([200, 200, 200, 200, 200]);
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_WAITING)).toBeVisible({ timeout: 20_000 });
    await expect(P.page.getByText(PHONE_DONE).first()).toBeVisible({ timeout: 60_000 });
    await desktopShowsImage(s);
    const db = await assertCompletedOnce(s);
    const img = await saveProductAndCheckImageUrl(s);
    expect(fnCalls.map((c) => `${c.status}:${c.kind}:${c.code ?? ""}`)).toEqual(["429:refused:rate_limited", "200:token:"]);
    const wait = JSON.parse(fnCalls[0].text).retry_after_seconds as number;
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(10);
    expect(fnCalls[1].at - fnCalls[0].at).toBeGreaterThanOrEqual(wait * 1000 - 500);
    expect(puts.map((p) => p.status)).toEqual([200]);
    expect(completes.map((c) => c.status)).toEqual([200]);
    record("phone-upload", "D-ratelimit-wait [081]", "PASS", `[${MODES}] 5 tokens taken directly, phone's request -> 429 retry_after=${wait} s, page showed the wait message and retried after ${secs(fnCalls[1].at - fnCalls[0].at)} s -> token -> PUT 200 -> complete 200; ${db}; ${img}`);
  } finally {
    await P.close();
  }
});

test("D-ratelimit-used-up [081]: the session reached its lifetime cap -> 429 until expiry; phone says to create a new QR, no PUT, no completion", async () => {
  test.skip(schemaVersion < "081", `schema ${schemaVersion} < 081: rate limits not deployed`);
  test.setTimeout(120_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone();
  const imageBefore = productImageUrl();
  try {
    await phoneOpens(P, s);
    // QA session only: its 20 tokens are used up
    sql1(`UPDATE product_image_upload_sessions SET token_issue_count = 20 WHERE id = '${s.sessionId}' AND storage_path LIKE 'org/${ids.org}/temp/%';`);
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_LINK_USED_UP)).toBeVisible({ timeout: 30_000 });
    await sleep(2_000);
    expect(fnCalls.map((c) => `${c.status}:${c.code}`)).toEqual(["429:rate_limited"]);
    expect(JSON.parse(fnCalls[0].text).retry_after_seconds).toBeGreaterThan(400);
    expect(puts).toHaveLength(0);
    expect(completes).toHaveLength(0);
    expect(objectsUnder(s)).toBe(0);
    expect(sessionRow(s.sessionId).split("|")[0]).toBe("PENDING");
    await A.page.getByRole("button", { name: "Close", exact: true }).click();
    expect(productImageUrl()).toBe(imageBefore);
    record("phone-upload", "D-ratelimit-used-up [081]", "PASS", `[${MODES}] counter at 20 -> function 429 retry_after=${JSON.parse(fnCalls[0].text).retry_after_seconds} s (until expiry), no automatic retry; phone: "${PHONE_LINK_USED_UP}"; PUTs=0, completes=0, objects=0; desktop closed (cancelled)`);
  } finally {
    await P.close();
  }
});
