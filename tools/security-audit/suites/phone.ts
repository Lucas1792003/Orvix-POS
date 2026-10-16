// Area "phone": QR phone-upload isolation (migrations 079/080/081).
import type { World } from "./seed";
import { capture, check, fn, gap, http, record, rpc, sql, q, uuid, ANON, MAX_MIG } from "./lib";

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
}
