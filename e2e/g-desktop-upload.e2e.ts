/* eslint-disable @typescript-eslint/no-explicit-any */
// G5 follow-up · G. Desktop product-image upload through the VALIDATED
// session flow (docs/selfhost-migration/phase-f/g5-followups.md §1), in the
// real Electron app against the deployed stack. PREPARED, run only after the
// deployment:
//
//   G-desktop-validated [083 + function]: the desktop picks a file on the
//     product edit page -> create_product_image_upload_session -> phone-upload-token
//     {token} -> signed PUT -> phone-upload-token {token, action:"complete"};
//     NO direct POST/PUT to /storage/v1/object/product-images/... with the
//     staff JWT; the form and products.image_url get exactly the server-derived
//     URL (app_config origin + /storage/v1/object/public/product-images/<session path>).
//   G-desktop-polyglot [083 + function]: the desktop module with a JPEG-header +
//     HTML polyglot -> 422 invalid_image, object deleted, session CANCELED.
//   G-084-direct-refused [084]: the QA ADMIN's own JWT can no longer write any
//     product-images path directly (product, logo, own live session path).
//
// Gates (test.skip, never a failure on an older stack):
//   * schema (max supabase_migrations version) >= "083" for the first two,
//     >= "084" for the third;
//   * the deployed phone-upload-token has the completion action: a POST
//     {token:"short", action:"probe"} answers 400 bad_request (an older
//     function ignores `action` and answers 404 invalid).
// QA data only; every QA object under org/<qa org>/ is removed through the
// Storage API in afterAll and the 574 non-QA objects (incl. the 17 orphans)
// are proven unchanged.
import { expect, test } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSql, svc, userClient } from "./helpers/db";
import { liveCfg, qaPassword, qaState, qaTotpSecret, RESULTS_DIR } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal } from "./helpers/terminal";

test.describe.configure({ mode: "serial" });

const st = qaState();
const { ids, emails } = st;
const cfg = liveCfg();
const BUCKET = "product-images";
const QA_OBJECT = new RegExp(`^org/${ids.org}/temp/pimg-[0-9a-f]+$`);
const sql1 = (q: string) => runSql(q).trim();
const STORAGE_FP = `SELECT count(*) || ' objects, md5 ' || md5(string_agg((to_jsonb(z) - 'last_accessed_at')::text, '|' ORDER BY z.bucket_id, z.name)) FROM storage.objects z WHERE z.name NOT LIKE 'org/qa-%';`;

let A: Terminal;
let schemaVersion = "";
let functionReady = false;
let trustedBase = "";
let storageBefore = "";
const publicUrl = (p: string) => `${trustedBase}/storage/v1/object/public/${BUCKET}/${p}`;
const sessionStatus = (id: string) => sql1(`SELECT status FROM product_image_upload_sessions WHERE id = '${id}';`);

test.beforeAll(async () => {
  schemaVersion = sql1(`SELECT max(version) FROM supabase_migrations.schema_migrations;`);
  const probe = await fetch(`${cfg.url}/functions/v1/phone-upload-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.anonKey}`, apikey: cfg.anonKey, "content-type": "application/json" },
    body: JSON.stringify({ token: "short", action: "probe" }),
  });
  const body = await probe.json().catch(() => null);
  functionReady = probe.status === 400 && body?.code === "bad_request";
  record("desktop-upload", "gates", "INFO", `schema ${schemaVersion}; phone-upload-token completion action ${functionReady ? "present" : `absent (probe ${probe.status})`}`);
  if (schemaVersion < "083" || !functionReady) return;
  trustedBase = sql1(`SELECT value FROM public.app_config WHERE key = 'supabase_public_url';`);
  expect(trustedBase).toBe(cfg.url);
  storageBefore = sql1(STORAGE_FP);
  rmSync(path.join(RESULTS_DIR, "userdata-g"), { recursive: true, force: true });
  A = await Terminal.launchElectron(path.join(RESULTS_DIR, "userdata-g"));
  await A.loginAdminWithTotp(emails.admin, qaPassword(), qaTotpSecret());
  await A.waitForApp();
});

test.afterAll(async () => {
  if (!A) return;
  try {
    const names = sql1(`SELECT name FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name LIKE 'org/${ids.org}/%';`).split("\n").filter(Boolean);
    const unexpected = names.filter((n) => !QA_OBJECT.test(n));
    if (unexpected.length) throw new Error(`refusing to delete unexpected names: ${unexpected.length}`);
    if (names.length) {
      const r = await svc().storage.from(BUCKET).remove(names);
      if (r.error) throw new Error(r.error.message);
    }
    const after = sql1(STORAGE_FP);
    record("desktop-upload", "storage cleanup + untouched", after === storageBefore ? "PASS" : "FAIL", `QA objects removed=${names.length}; non-QA before=${storageBefore} after=${after}`);
  } finally {
    try { await assertConsistency("spec G", [A]); } finally { await A.close(); }
  }
});

test("G-desktop-validated [083]: a desktop upload goes through the validated session flow; only the server-derived URL is saved", async () => {
  test.skip(schemaVersion < "083" || !functionReady, `schema ${schemaVersion} / function completion action ${functionReady}: not deployed`);
  test.setTimeout(120_000);
  await A.navigate(`/app/admin/products/${ids.prod1}/edit`);
  await A.page.getByRole("button", { name: "Use phone camera" }).waitFor({ state: "visible", timeout: 30_000 });
  const since = Date.now();
  const created = A.page.waitForResponse((r) => r.url().endsWith("/rest/v1/rpc/create_product_image_upload_session") && r.request().method() === "POST");
  // a real picture: the app compresses it on a canvas before uploading
  const png = Buffer.from(await A.page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 800; c.height = 600;
    const g = c.getContext("2d")!;
    g.fillStyle = "#2a6"; g.fillRect(0, 0, 800, 600);
    g.fillStyle = "#fff"; g.font = "80px sans-serif"; g.fillText("QA desktop", 120, 320);
    return c.toDataURL("image/png").split(",")[1];
  }), "base64");
  const file = path.join(RESULTS_DIR, "g-desktop.png");
  writeFileSync(file, png);
  await A.page.locator('input[type="file"][accept="image/jpeg,image/png,image/webp"]').setInputFiles(file);
  const j = await (await created).json();
  expect(j.storagePath).toBe(`org/${ids.org}/temp/${j.sessionId}`);
  const url = publicUrl(j.storagePath);
  await expect(A.page.getByAltText("Product preview")).toHaveAttribute("src", url, { timeout: 60_000 });
  const fn = A.requestsMatching(/\/functions\/v1\/phone-upload-token$/, since);
  const puts = A.requestsMatching(/\/storage\/v1\/object\/upload\/sign\/product-images\//, since);
  const direct = A.requestsMatching(/\/storage\/v1\/object\/product-images\//, since);
  expect(fn.map((r) => r.status)).toEqual([200, 200]);   // token, complete
  expect(puts.map((r) => r.status)).toEqual([200]);
  expect(direct).toHaveLength(0);                        // no staff-JWT write to storage
  expect(sessionStatus(j.sessionId)).toBe("COMPLETED");
  await A.page.getByRole("button", { name: "Update Product", exact: true }).click();
  await expect.poll(() => sql1(`SELECT COALESCE(image_url, '<null>') FROM products WHERE id = '${ids.prod1}';`), { timeout: 20_000 }).toBe(url);
  record("desktop-upload", "G-desktop-validated [083]", "PASS", `create session -> function token 200 -> signed PUT 200 -> function complete 200; direct storage writes 0; products.image_url = server-derived URL of org/<qa org>/temp/<session>`);
});

test("G-desktop-polyglot [083]: the desktop module refuses a polyglot: 422, object deleted, session cancelled", async () => {
  test.skip(schemaVersion < "083" || !functionReady, `schema ${schemaVersion} / function completion action ${functionReady}: not deployed`);
  const out = await A.page.evaluate(async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("<html><script>document.title='qa-g5'</script></html>"), 0xff, 0xd9]);
    const mod = await import("/src/lib/productImageStorage.ts" as string).catch(() => null);
    if (!mod) return "module-unavailable";
    try {
      await mod.uploadProductImage("brand", { blob: new Blob([bytes], { type: "image/jpeg" }), bytes: bytes.length, mimeType: "image/jpeg", dataUrl: "", width: 1, height: 1 });
      return "uploaded";
    } catch (e) {
      return `rejected:${String((e as Error).message)}`;
    }
  });
  test.skip(out === "module-unavailable", "packaged build: source modules are not importable from the renderer (covered by the audit suite on the disposable stack)");
  expect(out).toMatch(/^rejected:Image upload failed: The uploaded file is not a valid JPEG or WebP photo/);
  const last = sql1(`SELECT id || '|' || status || '|' || storage_path FROM product_image_upload_sessions s JOIN users u ON u.id = s.created_by WHERE u.org_id = '${ids.org}' ORDER BY s.created_at DESC LIMIT 1;`).split("|");
  expect(last[1]).toBe("CANCELED");
  expect(sql1(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${last[2]}';`)).toBe("0");
  record("desktop-upload", "G-desktop-polyglot [083]", "PASS", "polyglot -> 422 invalid_image (function), object deleted, session CANCELED by the desktop");
});

test("G-084-direct-refused [084]: the QA ADMIN's JWT cannot write product-images directly any more", async () => {
  test.skip(schemaVersion < "084", `schema ${schemaVersion} < 084: staff write policies still in place`);
  const c = await userClient(emails.admin, qaPassword());
  const live = await c.rpc("create_product_image_upload_session", { p_shop_id: ids.shop, p_product_id: ids.prod1 });
  expect(live.error).toBeNull();
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9])], { type: "image/jpeg" });
  const results: string[] = [];
  for (const p of [`org/${ids.org}/products/${ids.prod1}/qa-direct.jpg`, `org/${ids.org}/products/brand/qa-direct.jpg`, (live.data as any).storagePath as string]) {
    const r = await c.storage.from(BUCKET).upload(p, jpeg, { contentType: "image/jpeg", upsert: true });
    results.push(r.error ? "refused" : "STORED");
    expect(r.error, p.replace(ids.org, "<qa org>")).not.toBeNull();
    expect(sql1(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${BUCKET}' AND name = '${p}';`)).toBe("0");
  }
  const sign = await c.storage.from(BUCKET).createSignedUploadUrl((live.data as any).storagePath);
  expect(sign.error).not.toBeNull();
  await c.rpc("cancel_product_image_upload_session", { p_session_id: (live.data as any).sessionId });
  record("desktop-upload", "G-084-direct-refused [084]", "PASS", `direct uploads ${results.join(",")}; createSignedUploadUrl for own live session refused`);
});
