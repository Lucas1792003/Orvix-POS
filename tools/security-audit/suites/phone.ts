// Area "phone": QR phone-upload isolation (migrations 079/080/081).
import type { World } from "./seed";
import { capture, check, fn, gap, http, record, rpc, sql, q, uuid, ANON, MAX_MIG } from "./lib";
import { fixtures, removeObject } from "./storage";

const ALLOWED_FIELDS = ["sessionId", "storagePath", "publicUrl", "bytes", "mimeType", "uploadToken", "expiresAt", "status"].sort();

export async function phoneSuite(w: World) {
  const admin = w.adminA2, A = w.A, B = w.B;

  // 1. A cannot create an upload session for B's shop/product
  for (const [label, args] of [
    ["B shop", { p_shop_id: B.shops[0], p_product_id: A.products[0] }],
    ["B product", { p_shop_id: A.shops[0], p_product_id: B.products[0] }],
    ["B shop + B product", { p_shop_id: B.shops[0], p_product_id: B.products[0] }],
  ] as const) {
    const r = await rpc(admin, "create_product_image_upload_session", args);
    capture(`phone create session ${label}`, r.text, Object.values(args));
    check("phone", `admin A cannot create an upload session for ${label}`, r.status >= 300, ["rpc:public.create_product_image_upload_session"], `status ${r.status}`);
  }

  // 2. B's session token: the by-token reader leaks only the 8 allowed fields
  const bTokenRaw = sql(`SELECT signed_upload_token FROM product_image_upload_sessions WHERE id = ${q(B.sessions[0].id)}`);
  // get_product_image_upload_session_by_token is token-scoped; use the raw QR token held by the phone (B.sessions[0].token)
  const byToken = await rpc(null, "get_product_image_upload_session_by_token", { p_token: B.sessions[0].token });
  // token-scoped call: the token holder (B's phone) legitimately receives this
  // session's own id/path, so those ids are "supplied", not a cross-org leak.
  capture("phone by-token B", byToken.text, [B.id, B.sessions[0].id, B.objects?.legacyTemp ?? "", `org/${B.id}/temp/${B.sessions[0].id}`]);
  const fields = byToken.status < 300 && byToken.json && typeof byToken.json === "object" ? Object.keys(byToken.json).sort() : [];
  check("phone", "get_..._by_token returns only the 8 allowed fields", JSON.stringify(fields) === JSON.stringify(ALLOWED_FIELDS), ["rpc:public.get_product_image_upload_session_by_token"],
    `fields: ${fields.join(",")}`);
  check("phone", "by-token response carries no name/email/price canary of B", !byToken.text.includes(B.can), ["rpc:public.get_product_image_upload_session_by_token"], "");

  // 3. phone-upload-token: a valid B session token is served a token (legitimate: the phone holds it),
  //    but the path is server-derived (org/<B>/temp/<id>) and never A's.
  const tok = await fn(ANON, "phone-upload-token", { token: B.sessions[0].token });
  capture("phone token fn B", tok.text, [B.id, B.sessions[0].id, `org/${B.id}/temp/${B.sessions[0].id}`]);
  if (tok.status === 200 && tok.json?.path) {
    check("phone", "phone-upload-token derives B's own path server-side", tok.json.path === `org/${B.id}/temp/${B.sessions[0].id}`, ["edge-fn:phone-upload-token"], `path ${tok.json.path}`);
  } else {
    record("phone", `phone-upload-token for B session -> ${tok.status} ${tok.json?.code ?? ""}`, "INFO", ["edge-fn:phone-upload-token"]);
  }
  // an invalid / A-context token guess never resolves
  const guess = await fn(ANON, "phone-upload-token", { token: "a".repeat(48) });
  check("phone", "phone-upload-token refuses an unknown token", guess.status >= 400, ["edge-fn:phone-upload-token"], `status ${guess.status}`);

  // 4. completion bound to the session's own path (079/080): B token + A path -> refused, nothing stored
  const beforeB = sql(`SELECT md5(coalesce(string_agg(status||storage_path, '|'),'')) FROM product_image_upload_sessions WHERE created_by IN (SELECT id FROM users WHERE org_id=${q(B.id)})`);
  const compWrong = await rpc(null, "complete_product_image_upload_session", {
    p_token: B.sessions[0].token, p_storage_path: A.objects.orgProduct, p_public_url: "http://127.0.0.1/x", p_bytes: 10, p_mime_type: "image/jpeg" });
  capture("phone complete B token A path", compWrong.text);
  const afterB = sql(`SELECT md5(coalesce(string_agg(status||storage_path, '|'),'')) FROM product_image_upload_sessions WHERE created_by IN (SELECT id FROM users WHERE org_id=${q(B.id)})`);
  check("phone", "completion with B's token + A's path is refused / rebound, B session unchanged", beforeB === afterB, ["rpc:public.complete_product_image_upload_session"], `status ${compWrong.status}`);

  // 5. rate-limit counters are per-organization (081): claim for B's session touches B's org row, not A's
  if (MAX_MIG >= 81) {
    const aOrgBefore = sql(`SELECT coalesce(max(issued)::text,'0') FROM phone_upload_org_rate WHERE org_id=${q(A.id)}`);
    await fn(ANON, "phone-upload-token", { token: B.sessions[0].token });
    const aOrgAfter = sql(`SELECT coalesce(max(issued)::text,'0') FROM phone_upload_org_rate WHERE org_id=${q(A.id)}`);
    const bOrgRow = sql(`SELECT count(*) FROM phone_upload_org_rate WHERE org_id=${q(B.id)}`);
    check("phone", "081 rate-limit counter is per-org (B's claim does not touch A's window)", aOrgBefore === aOrgAfter, ["table:public.phone_upload_org_rate"],
      `A window ${aOrgBefore}->${aOrgAfter}, B rows ${bOrgRow}`);
    const grants = sql(`SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='phone_upload_org_rate' AND grantee IN ('anon','authenticated')`);
    check("phone", "phone_upload_org_rate has no anon/authenticated grants", grants === "0", ["table:public.phone_upload_org_rate"], `grants ${grants}`);
  } else {
    record("phone", "081 rate-limit checks skipped (migration < 081)", "SKIP", ["table:public.phone_upload_org_rate"]);
  }

  await phoneUploadContent(w);
}

// ---------------------------------------------------------------- G5 / 083
// The phone's real flow on the real storage-api: token just in time ->
// multipart PUT to the signed upload URL (x-upsert false) -> completion via
// phone-upload-token {action:"complete"}, which reads the object back, checks
// the bytes and deletes a refused object. 083 also takes EXECUTE on the
// completion RPC away from anon / authenticated.
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function phoneUploadContent(w: World) {
  const admin = w.adminA2, A = w.A;
  const G5 = MAX_MIG >= 83;
  const newSession = async () => {
    const r = await rpc(admin, "create_product_image_upload_session", { p_shop_id: A.shops[0], p_product_id: A.products[0] });
    if (r.status >= 300) throw new Error(`create session: ${r.status}`);
    return { id: String(r.json.sessionId ?? r.json.id), token: String(r.json.token), path: String(r.json.storagePath) };
  };
  const signedPut = async (s: { token: string }, body: Buffer, type: string) => {
    const t = await fn(ANON, "phone-upload-token", { token: s.token });
    if (t.status !== 200 || !t.json?.token) return { status: -t.status, text: t.text, path: "" };
    const form = new FormData();
    form.append("cacheControl", "31536000");
    form.append("", new Blob([body], { type }));
    const r = await http("PUT", `/storage/v1/object/upload/sign/product-images/${enc(t.json.path)}?token=${encodeURIComponent(t.json.token)}`,
      { token: ANON, raw: form, headers: { "x-upsert": "false" } });
    return { status: r.status, text: r.text, path: t.json.path as string, uploadToken: t.json.token as string };
  };
  const complete = (s: { token: string }) => fn(ANON, "phone-upload-token", { token: s.token, action: "complete" });
  const objectRows = (path: string) => sql(`SELECT count(*) FROM storage.objects WHERE bucket_id='product-images' AND name=${q(path)}`);
  const statusOf = (id: string) => sql(`SELECT status FROM product_image_upload_sessions WHERE id=${q(id)}`);
  const covers = ["edge-fn:phone-upload-token", "rpc:public.complete_product_image_upload_session", "storage-policy:product_images_insert"];

  // valid JPEG / WebP: signed upload accepted, completion validates and completes
  for (const [label, body, type] of [["JPEG", fixtures.jpeg(), "image/jpeg"], ["WebP", fixtures.webp(), "image/webp"]] as const) {
    const s = await newSession();
    const up = await signedPut(s, body, type);
    const c = await complete(s);
    capture(`phone g5 complete ${label}`, c.text, [A.id, s.id, s.path]);
    check("phone", `G5 phone: a ${label} via the signed URL completes through the function (200 COMPLETED, object kept)`,
      up.status < 300 && c.status === 200 && c.json?.status === "COMPLETED" && statusOf(s.id) === "COMPLETED" && objectRows(s.path) === "1",
      covers, `put ${up.status}, complete ${c.status} ${c.text.slice(0, 120)}`);
    // signed URL limits: the same token cannot write the path again (upsert false)
    if (up.uploadToken) {
      const form = new FormData();
      form.append("", new Blob([fixtures.html()], { type: "image/jpeg" }));
      const again = await http("PUT", `/storage/v1/object/upload/sign/product-images/${enc(up.path)}?token=${encodeURIComponent(up.uploadToken)}`,
        { token: ANON, raw: form, headers: { "x-upsert": "true" } });
      check("phone", `G5 phone: the ${label}'s signed URL cannot overwrite the completed object (upsert false is in the token)`,
        again.status >= 400 && objectRows(up.path) === "1", covers, `status ${again.status}`);
    }
  }

  // types the bucket refuses at upload (signed URL): nothing stored, session not completed
  const big = Buffer.concat([fixtures.jpeg(0), Buffer.alloc(5242881, 0x44)]);
  for (const [label, body, type] of [
    ["text/html", fixtures.html(), "text/html"],
    ["image/svg+xml", fixtures.svg(), "image/svg+xml"],
    ["application/octet-stream", fixtures.jpeg(), "application/octet-stream"],
    ["over 5 MiB (declared image/jpeg)", big, "image/jpeg"],
  ] as const) {
    const s = await newSession();
    const up = await signedPut(s, body, type);
    const stored = up.path ? objectRows(up.path) !== "0" : false;
    gap("phone", `G5 phone: signed upload declared ${label} is refused by storage-api, nothing stored`, up.status >= 400 && !stored,
      covers, "medium", `status ${up.status}, stored ${stored}`);
    const c = await complete(s);
    check("phone", `G5 phone: ${label} - completion refused, object gone, session still PENDING`,
      c.status >= 400 && statusOf(s.id) === "PENDING" && (!up.path || objectRows(up.path) === "0"), covers,
      `complete ${c.status} ${c.json?.code ?? ""}`);
  }

  // stored by the bucket (declared image/jpeg) but refused by the function's byte check
  for (const [label, body] of [[".jpg with HTML content", fixtures.html()], ["JPEG-header + HTML polyglot", fixtures.polyglot()], ["WebP bytes declared image/jpeg", fixtures.webp()]] as const) {
    const s = await newSession();
    const up = await signedPut(s, body, "image/jpeg");
    const storedBefore = up.path ? objectRows(up.path) : "?";
    const c = await complete(s);
    capture(`phone g5 complete ${label}`, c.text, [A.id, s.id, s.path]);
    check("phone", `G5 phone: ${label} (declared image/jpeg) -> 422 invalid_image, the object is DELETED, the session is not completed`,
      up.status < 300 && storedBefore === "1" && c.status === 422 && c.json?.code === "invalid_image"
        && objectRows(up.path) === "0" && statusOf(s.id) === "PENDING",
      covers, `put ${up.status} stored ${storedBefore}, complete ${c.status} ${c.json?.code ?? ""}, after ${up.path ? objectRows(up.path) : "?"} ${statusOf(s.id)}`);
  }

  // the old direct path: anon (and an org admin) calling the completion RPC
  {
    const s = await newSession();
    const up = await signedPut(s, fixtures.polyglot(), "image/jpeg");
    for (const [who, token] of [["anon", null], ["org ADMIN (authenticated)", admin]] as const) {
      const r = await rpc(token, "complete_product_image_upload_session", {
        p_token: s.token, p_storage_path: up.path, p_public_url: `http://127.0.0.1/storage/v1/object/public/product-images/${up.path}`,
        p_bytes: 100, p_mime_type: "image/jpeg" });
      capture(`phone g5 direct rpc ${who}`, r.text, [A.id, s.id, s.path]);
      gap("phone", `G5 phone: ${who} cannot call complete_product_image_upload_session directly (bypassing the byte check)`,
        r.status >= 400 && statusOf(s.id) === "PENDING", ["rpc:public.complete_product_image_upload_session"], "medium",
        `status ${r.status}, session ${statusOf(s.id)}`);
      if (statusOf(s.id) !== "PENDING") break;
    }
    if (up.path) await removeObject(up.path);
  }
  if (!G5) record("phone", "G5 bucket / grant assertions above are GAPs below migration 083 (production 081/082)", "INFO", []);
  if (G5) await phonePngAndCleanup(w, { newSession, signedPut, complete, objectRows, statusOf, covers });
}

// ---------------------------------------------------------------- 085
// PNG completes like JPEG/WebP from 085; below 085 the (new) function's RPC
// refusal deletes the object. Every refusal leaves nothing behind; retries,
// concurrent completions, referenced paths and other orgs' objects are safe.
// docs/selfhost-migration/phase-f/migration-085-png.md
type Ctx = {
  newSession: () => Promise<{ id: string; token: string; path: string }>;
  signedPut: (s: { token: string }, body: Buffer, type: string) => Promise<{ status: number; text: string; path: string; uploadToken?: string }>;
  complete: (s: { token: string }) => Promise<{ status: number; json: any; text: string }>;
  objectRows: (path: string) => string;
  statusOf: (id: string) => string;
  covers: string[];
};
async function phonePngAndCleanup(w: World, x: Ctx) {
  const P085 = MAX_MIG >= 85;
  const A = w.A, B = w.B;
  const covers = [...x.covers, "migration:085"];
  const bigPng = () => Buffer.concat([fixtures.png(), Buffer.alloc(150 * 1024, 0x22)]);
  const pngHtml = () => Buffer.concat([fixtures.png(), fixtures.html()]);

  // 1. a valid PNG
  {
    const s = await x.newSession();
    const up = await x.signedPut(s, fixtures.png(), "image/png");
    const c = await x.complete(s);
    if (P085) {
      check("phone", "085 phone: a valid PNG via the signed URL completes (200 COMPLETED image/png, object kept)",
        up.status < 300 && c.status === 200 && c.json?.status === "COMPLETED" && c.json?.mimeType === "image/png"
          && x.statusOf(s.id) === "COMPLETED" && x.objectRows(s.path) === "1", covers, `put ${up.status}, complete ${c.status} ${c.text.slice(0, 120)}`);
    } else {
      check("phone", "pre-085 schema: a valid PNG is refused by the RPC (422 completion_refused) and the function DELETES the object, session PENDING",
        up.status < 300 && c.status === 422 && c.json?.code === "completion_refused" && x.objectRows(s.path) === "0" && x.statusOf(s.id) === "PENDING",
        covers, `put ${up.status}, complete ${c.status} ${c.json?.code ?? ""}, rows ${x.objectRows(s.path)}`);
    }
  }

  // 2. malicious / oversize PNG: byte check refuses, object deleted
  for (const [label, body] of [["PNG with an HTML payload", pngHtml()], ["PNG of 150 KB (> 100 KB completion limit, < 5 MiB bucket limit)", bigPng()]] as const) {
    const s = await x.newSession();
    const up = await x.signedPut(s, body, "image/png");
    const c = await x.complete(s);
    check("phone", `085 phone: ${label} -> 422 invalid_image, object DELETED, session PENDING`,
      up.status < 300 && c.status === 422 && c.json?.code === "invalid_image" && x.objectRows(s.path) === "0" && x.statusOf(s.id) === "PENDING",
      covers, `put ${up.status}, complete ${c.status} ${c.json?.code ?? ""}`);
  }

  // 3. RPC refusal (server not configured) -> object deleted; retry on the freed path completes
  const cfg = sql(`SELECT value FROM public.app_config WHERE key = 'supabase_public_url'`);
  {
    const s = await x.newSession();
    const otherOrg = await (async () => {
      const r = await rpc(w.adminB2, "create_product_image_upload_session", { p_shop_id: B.shops[0], p_product_id: B.products[0] });
      return r.status < 300 ? { id: String(r.json.sessionId), token: String(r.json.token), path: String(r.json.storagePath) } : null;
    })();
    const bUp = otherOrg ? await x.signedPut(otherOrg, fixtures.jpeg(), "image/jpeg") : null;
    const up = await x.signedPut(s, fixtures.jpeg(), "image/jpeg");
    sql(`DELETE FROM public.app_config WHERE key = 'supabase_public_url'`);
    let c: Awaited<ReturnType<Ctx["complete"]>>;
    try {
      c = await x.complete(s);
    } finally {
      sql(`INSERT INTO public.app_config (key, value) VALUES ('supabase_public_url', ${q(cfg)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    }
    check("phone", "085 phone: an RPC refusal for a PENDING session (not configured) -> 422 completion_refused, the session's object DELETED",
      up.status < 300 && c.status === 422 && c.json?.code === "completion_refused" && x.objectRows(s.path) === "0" && x.statusOf(s.id) === "PENDING",
      covers, `put ${up.status}, complete ${c.status} ${c.json?.code ?? ""}, rows ${x.objectRows(s.path)}`);
    if (otherOrg && bUp) {
      check("phone", "085 phone: that cleanup left the other organization's pending object alone",
        bUp.status < 300 && x.objectRows(otherOrg.path) === "1" && x.statusOf(otherOrg.id) === "PENDING", covers, `B put ${bUp.status}, rows ${x.objectRows(otherOrg.path)}`);
      await removeObject(otherOrg.path);
    } else {
      record("phone", "085 phone: cross-org cleanup check skipped (no org B admin session available)", "INFO", covers);
    }
    // retry: the freed path takes a fresh token (not alreadyUploaded) and a new photo completes
    const t = await fn(ANON, "phone-upload-token", { token: s.token });
    const again = await x.signedPut(s, fixtures.webp(), "image/webp");
    const c2 = await x.complete(s);
    check("phone", "085 phone: retry after the refusal - fresh token for the freed path, new WebP uploads (upsert false) and completes",
      t.status === 200 && typeof t.json?.token === "string" && !t.json?.alreadyUploaded && again.status < 300 && c2.status === 200
        && x.statusOf(s.id) === "COMPLETED" && x.objectRows(s.path) === "1", covers, `token ${t.status}, put ${again.status}, complete ${c2.status}`);
  }

  // 4. a referenced path is never deleted, even on a refusal
  {
    const s = await x.newSession();
    const up = await x.signedPut(s, fixtures.html(), "image/jpeg");
    const before = sql(`SELECT coalesce(image_url, '') FROM products WHERE id = ${q(A.products[1])}`);
    sql(`UPDATE products SET image_url = ${q(`${cfg}/storage/v1/object/public/product-images/${s.path}`)} WHERE id = ${q(A.products[1])}`);
    const c = await x.complete(s);
    sql(`UPDATE products SET image_url = ${before ? q(before) : "NULL"} WHERE id = ${q(A.products[1])}`);
    check("phone", "085 phone: a refused object whose path a products.image_url names is NOT deleted (422, object kept)",
      up.status < 300 && c.status === 422 && x.objectRows(s.path) === "1", covers, `complete ${c.status}, rows ${x.objectRows(s.path)}`);
    await removeObject(s.path);
  }

  // 5. concurrent completions of one session: exactly one COMPLETED, the object stays
  {
    const s = await x.newSession();
    const up = await x.signedPut(s, P085 ? fixtures.png() : fixtures.jpeg(), P085 ? "image/png" : "image/jpeg");
    const all = await Promise.all(Array.from({ length: 4 }, () => x.complete(s)));
    const ok = all.filter((r) => r.status === 200).length;
    const lost = all.filter((r) => r.status === 410 && r.json?.status === "COMPLETED").length;
    check("phone", `085 phone: 4 concurrent completions of one ${P085 ? "PNG" : "JPEG"} session -> exactly one 200, the rest 410 COMPLETED, object kept`,
      up.status < 300 && ok === 1 && lost === 3 && x.statusOf(s.id) === "COMPLETED" && x.objectRows(s.path) === "1",
      covers, `statuses ${all.map((r) => r.status).join(",")}, rows ${x.objectRows(s.path)}`);
  }
}
