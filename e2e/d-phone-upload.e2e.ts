/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase G · D. Phone product-image upload with a JUST-IN-TIME signed upload
// token (docs/selfhost-migration/phase-g/phone-upload-jit.md), in the real UI:
//
//   desktop = the real Electron app (terminal A, QA ADMIN, TOTP) on the
//             product edit page -> "Use phone camera" -> QR modal;
//   phone   = a Chromium page with an iPhone 13 profile that opens the QR URL.
//
// The phone-upload-token Edge Function is NOT deployed to the self-hosted stack: it runs
// in a disposable local supabase/edge-runtime:v1.76.2 container
// (helpers/edgeRuntime.ts, 127.0.0.1 only) and the phone's request for
// <stack>/functions/v1/phone-upload-token is routed to it. Everything else
// (session RPCs, storage upload, completion, the desktop's status poll) is
// the real self-hosted stack. Real timing. QA data only; every QA storage
// object is removed through the Storage API in afterAll, and the non-QA
// objects (574, incl. the 17 orphans) are proven byte-identical.
import { expect, test, type Route } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { runSql, sleep, svc } from "./helpers/db";
import { startLocalPhoneUploadFunction, type LocalFunction } from "./helpers/edgeRuntime";
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
const QA_OBJECT = new RegExp(`^org/${ids.org}/temp/pimg-[0-9a-f]+$`);
// Tiny lossless WebP (34 bytes) for the programmatic race (same constant as phase-g3).
const TINY_WEBP_B64 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const PHONE_READY = "Choose or take a product photo.";
const PHONE_DONE = "Photo uploaded. You can return to the computer.";
const PHONE_EXPIRED = "This upload link has expired. Create a new QR code on the computer.";
const PHONE_CANCELLED = "This upload link was cancelled on the computer. Create a new QR code to upload.";

let A: Terminal;
let fn: LocalFunction;
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
const publicUrl = (p: string) => `${cfg.url}/storage/v1/object/public/${BUCKET}/${p}`;

/** Desktop: open the QR modal; the session comes from the create RPC's response (kept in memory, never logged). */
async function openQr(): Promise<Sess> {
  const created = A.page.waitForResponse((r) => r.url().endsWith("/rest/v1/rpc/create_product_image_upload_session") && r.request().method() === "POST");
  await A.page.getByRole("button", { name: "Use phone camera" }).click();
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
  return { sessionId: j.sessionId, token: j.token, storagePath: j.storagePath, qrUrl: `${DEV_SERVER_URL}/phone-upload/product-image/${encodeURIComponent(j.token)}`, shownAt };
}

/** Phone terminal with the function routed to the local container + request ledgers. */
async function launchPhone(opts: { holdFirstTokenMs?: number; dropFirstUploadResponse?: boolean } = {}) {
  const P = await Terminal.launchPhone();
  const fnCalls: FnCall[] = [];
  const puts: Put[] = [];
  const completes: { at: number; status: number }[] = [];
  let dropped = false;
  await P.context.route(`${cfg.url}${FN_PATH}`, async (route: Route) => {
    const r = await route.fetch({ url: fn.url });
    if (route.request().method() === "OPTIONS") return route.fulfill({ response: r });
    const text = await r.text();
    let b: any = null;
    try { b = JSON.parse(text); } catch { /* keep null */ }
    fnCalls.push({
      at: Date.now(), status: r.status(),
      kind: b?.token ? "token" : b?.alreadyUploaded ? "already" : "refused",
      code: b?.code, sessionStatus: b?.status, keys: Object.keys(b ?? {}).sort().join(","), path: b?.path, text,
    });
    if (opts.holdFirstTokenMs && fnCalls.length === 1 && b?.token) await sleep(opts.holdFirstTokenMs);
    await route.fulfill({ response: r, body: text });
  });
  await P.context.route(`${cfg.url}/storage/v1/object/upload/sign/**`, async (route: Route) => {
    if (route.request().method() !== "PUT") return route.continue();
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
  await P.page.goto(s.qrUrl);
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
  return `session COMPLETED, bytes=${bytes}, objects under session path=1 (size ${bytes}), public GET 200 ${bytes} B`;
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

  fn = await startLocalPhoneUploadFunction();
  record("phone-upload", "local edge-runtime", "INFO", `container ${fn.container} (supabase/edge-runtime:v1.76.2) on ${fn.url.replace(/\/phone-upload-token$/, "")}, router = stack main/index.ts copy, VERIFY_JWT=false locally`);

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
      fn?.stop();
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
      expect(fnCalls.map((c) => c.kind)).toEqual(["token"]);
      assertTokenResponse(fnCalls[0], s);
      expect(puts.map((p) => p.status)).toEqual([200]);
      expect(completes.map((c) => c.status)).toEqual([200]);
      const tokenAt = fnCalls[0].at - s.shownAt;
      const tokenAgeAtPut = puts[0].at - fnCalls[0].at;
      const line = `| ${delayS} s | phone opened +${secs(openedAfter)} s | file picked +${secs(pickedAt - s.shownAt)} s | token issued +${secs(tokenAt)} s | PUT 200 +${secs(puts[0].at - s.shownAt)} s (token age ${tokenAgeAtPut} ms) | complete 200 | COMPLETED | desktop image ${size} |`;
      timings.push(line);
      record("phone-upload", `D${delayS} upload at +${delayS} s`, "PASS", `${line} ${db}; function answer keys {${fnCalls[0].keys}} path=session path, no ids`);
    } finally {
      await P.close();
    }
  });
}

test("D-stale: a token used 66 s after issue is refused by storage; the phone transparently gets a fresh one and completes", async () => {
  test.setTimeout(240_000);
  const s = await openQr();
  const { P, fnCalls, puts, completes } = await launchPhone({ holdFirstTokenMs: 66_000 });
  try {
    await phoneOpens(P, s);
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_DONE).first()).toBeVisible({ timeout: 150_000 });
    const size = await desktopShowsImage(s);
    const db = await assertCompletedOnce(s);
    expect(fnCalls.map((c) => c.kind)).toEqual(["token", "token"]);
    assertTokenResponse(fnCalls[1], s);
    expect(puts.map((p) => p.status)).toEqual([400, 200]);
    expect(puts[0].body).toMatch(/exp|jwt/i);
    expect(completes.map((c) => c.status)).toEqual([200]);
    const age = puts[0].at - fnCalls[0].at;
    expect(age).toBeGreaterThanOrEqual(65_000);
    const line = `| stale token | token #1 used ${secs(age)} s after issue -> PUT ${puts[0].status} ${puts[0].body.replace(/\s+/g, " ").slice(0, 90)} | token #2 +${secs(fnCalls[1].at - s.shownAt)} s -> PUT 200 | complete 200 | COMPLETED | desktop image ${size} |`;
    timings.push(line);
    record("phone-upload", "D-stale token refused then refreshed", "PASS", `${line} ${db}`);
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
    expect(fnCalls.map((c) => c.kind)).toEqual(["token"]);
    expect(puts.map((p) => p.status)).toEqual([200]);
    expect(completes.map((c) => c.status)).toEqual([200]);
    record("phone-upload", "D-double-tap", "PASS", `function calls=${fnCalls.length}, PUTs=${puts.map((p) => p.status).join(",")}, completes=${completes.map((c) => c.status).join(",")}; ${db}`);
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
    const results = await P.page.evaluate(async ([token, b64, modulePath]) => {
      // the page's own module instance, served by the Vite dev server
      const m: any = await import(modulePath);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const image = { blob: new Blob([bytes], { type: "image/webp" }), bytes: bytes.length, mimeType: "image/webp" };
      const rs = await Promise.allSettled([m.uploadPhoneProductImage(token, image), m.uploadPhoneProductImage(token, image)]);
      return rs.map((r) => (r.status === "fulfilled" ? `${r.value.status}` : `rejected: ${String((r.reason as Error)?.message)}`));
    }, [s.token, TINY_WEBP_B64, "/src/lib/productImagePhoneUpload.ts"] as const);
    expect(results).toEqual(["COMPLETED", "COMPLETED"]);
    await expect(A.page.getByText("Upload received")).toBeVisible({ timeout: 20_000 });
    await A.page.getByRole("button", { name: "Use this image", exact: true }).click();
    const db = await assertCompletedOnce(s);
    expect(puts.filter((p) => p.status === 200)).toHaveLength(1);
    expect(completes.filter((c) => c.status === 200)).toHaveLength(1);
    record("phone-upload", "D-race (2 concurrent uploads)", "PASS",
      `both calls -> ${results.join(" / ")}; function answers=${fnCalls.map((c) => c.kind).join(",")}; PUTs=${puts.map((p) => `${p.status}${p.status !== 200 ? ` "${p.body.replace(/\s+/g, " ").slice(0, 70)}"` : ""}`).join(", ")}; completes=${completes.map((c) => c.status).join(",")}; ${db}`);
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
    expect(fnCalls.map((c) => c.kind)).toEqual(["token", "already"]);
    expect(fnCalls[1].keys).toBe("alreadyUploaded,path");
    expect(puts.map((p) => `${p.status}${p.dropped ? "(dropped)" : ""}`)).toEqual(["200(dropped)"]);
    expect(completes.map((c) => c.status)).toEqual([200]);
    record("phone-upload", "D-retry after lost response", "PASS", `function answers=${fnCalls.map((c) => c.kind).join(",")}; PUTs=200 stored but response dropped, no second PUT; completes=200 x1; ${db}`);
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
  try {
    await phoneOpens(P, s);
    await sleep(2_500); // any poll already in flight finishes or is held
    const ex = await svc().from("product_image_upload_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", s.sessionId).select("id");
    expect(ex.error).toBeNull();
    expect(ex.data).toHaveLength(1);
    expect(sessionRow(s.sessionId).startsWith("PENDING|")).toBe(true);
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_EXPIRED)).toBeVisible({ timeout: 30_000 });
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
    record("phone-upload", "D-expired session refused", "PASS", `phone: "${PHONE_EXPIRED}"; function 410 inactive/EXPIRED, no token; PUTs=0, completes=0; row (desktop poll held) = ${stamped.split("|").slice(0, 1)} (stamped by the function via _by_token); objects=0; desktop after poll: "Upload failed / expired"`);
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
  try {
    await phoneOpens(P, s);
    const cancelled = A.page.waitForResponse((r) => r.url().endsWith("/rest/v1/rpc/cancel_product_image_upload_session"));
    await A.page.getByRole("button", { name: "Close", exact: true }).click();
    expect((await cancelled).status()).toBeLessThan(300);
    await expect(A.page.getByText("Upload from phone")).toBeHidden();
    expect(sessionRow(s.sessionId).split("|")[0]).toBe("CANCELED");
    await phonePicks(P);
    await expect(P.page.getByText(PHONE_CANCELLED)).toBeVisible({ timeout: 30_000 });
    expect(fnCalls.map((c) => `${c.status}:${c.code}:${c.sessionStatus}`)).toEqual(["410:inactive:CANCELED"]);
    expect(puts).toHaveLength(0);
    expect(completes).toHaveLength(0);
    expect(sessionRow(s.sessionId).split("|")[0]).toBe("CANCELED");
    expect(objectsUnder(s)).toBe(0);
    record("phone-upload", "D-cancelled session refused", "PASS", `desktop Close -> cancel RPC, modal gone; phone: "${PHONE_CANCELLED}"; function 410 inactive/CANCELED, no token; PUTs=0, completes=0; row CANCELED; objects=0`);
  } finally {
    await P.close();
  }
});
