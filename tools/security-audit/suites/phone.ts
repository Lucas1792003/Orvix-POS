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
}
