import { createClient } from "npm:@supabase/supabase-js@2";
import { checkUploadedImage, MAX_COMPLETION_BYTES, normaliseContentType } from "./imageCheck.ts";

// phone-upload-token: just-in-time signed upload token for the QR phone
// upload (docs/selfhost-migration/phase-g/phone-upload-jit.md).
//
// Storage signs upload tokens for UPLOAD_SIGNED_URL_EXPIRATION_TIME (60 s on
// the self-hosted stack, kept by owner decision), while a QR session lives 10 minutes.
// So the phone asks THIS function for a token immediately before it uploads.
//
// Who may call it: the anonymous phone page (anon / publishable key only).
// It does not authenticate a user. The caller proves possession of the QR
// session token in the request body, and the session row decides everything
// else:
//   * the raw token is hashed exactly like product_image_upload_token_hash()
//     (019: sha256 over the UTF-8 bytes, lower-case hex) and the row is looked
//     up by token_hash with the service role;
//   * the session must be PENDING and unexpired (an expired PENDING row is
//     stamped EXPIRED through get_product_image_upload_session_by_token, the
//     same non-raising path the phone page and the desktop poll already use);
//   * the object path is re-derived from the row (org/<creator org>/temp/<id>)
//     and must equal the stored storage_path. Nothing from the client is ever
//     used as a path;
//   * the creator must still be an active user of that org, and the session's
//     product and shop (when set) must still belong to that org.
// Only then is storage asked, with the service role, for a signed upload
// token for exactly that path (upsert false, so a second upload to the same
// path fails instead of creating a second object). If the object already
// exists, the transfer has already landed (a lost response, a double tap) and
// the phone is told to go straight to completion instead of uploading again.
//
// Response (200): { token, path, expiresAt } or { alreadyUploaded: true, path }.
// Nothing else: no session/product/shop/user ids, no names, no signed URL
// (it would carry the INTERNAL storage host on the self-hosted stack), never a key.
// Refusals are generic: 404 invalid link, 410 inactive (+ the session status
// the phone is already allowed to read through _by_token), 403 refused.
//
// Completion (G5, migration 083, docs/selfhost-migration/phase-f/migration-083-g5.md):
// body { token, action: "complete" }. Same session / organization / path
// checks as above (no rate-limit claim: completing does not issue a token).
// The object is read back with the service role and its BYTES are checked
// (imageCheck.ts: declared type jpeg/png/webp, <= 100 KB, magic number,
// container sanity, no HTML/SVG markup). A failing object is DELETED and the
// session stays PENDING (422 invalid_image; the phone may upload another
// photo). A passing object is completed through
// complete_product_image_upload_session called with the service role: from
// 083 on, anon/authenticated can no longer call that RPC, so every completion
// passes this check.
// Response (200): the RPC's own answer (sessionId, storagePath, publicUrl,
// bytes, mimeType, expiresAt, status) - what the phone received before.
//
// Refused objects never stay behind (docs/selfhost-migration/phase-f/
// migration-085-png.md): when the byte check refuses (422 invalid_image) OR
// the RPC refuses after it confirmed the session is PENDING (422
// completion_refused: type - e.g. PNG before migration 085 -, size, object
// missing, not configured), discardRefusedObject() deletes the object - only
// at the server-derived session path, only while that session is still
// PENDING and was never completed, never when a product / logo / session URL
// or another session names that path, and only if the object is still
// exactly the one that was validated (same bytes, type, ETag, Last-Modified).
// "No longer active" (another completion won the race, expired, cancelled)
// and unknown RPC failures (503) never delete. The phone's signed URL has
// upsert false, so the freed path takes a fresh upload.
//
// Rate limits (migration 081, docs/selfhost-migration/phase-f/rate-limiting.md):
// before storage is touched, the issue is claimed atomically in the database
// through claim_phone_upload_token_issue (service_role only; per-session
// lifetime cap + burst window, per-organization window). A refusal is
// 429 { error, code: "rate_limited", retry_after_seconds } + Retry-After.
// FAIL CLOSED: if the limiter cannot be asked (RPC missing, DB error,
// unexpected answer), no token is issued (503).

const BUCKET = "product-images";
const MIN_TOKEN_LENGTH = 32; // same floor as the _by_token / complete RPCs
const MAX_TOKEN_LENGTH = 512;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Retry-After",
};

const jsonResponse = (body: Record<string, unknown>, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });

const invalidLink = () => jsonResponse({ error: "Invalid upload link.", code: "invalid" }, 404);
const refused = () => jsonResponse({ error: "This upload link can no longer be used.", code: "refused" }, 403);
const inactive = (status: string) =>
  jsonResponse(
    {
      error: status === "EXPIRED" ? "This upload link has expired." : "This upload link is no longer active.",
      code: "inactive",
      status,
    },
    410,
  );
const rateLimited = (retryAfterSeconds: number) => {
  const seconds = Math.min(3600, Math.max(1, Math.ceil(retryAfterSeconds)));
  return jsonResponse(
    { error: "Too many upload attempts. Please wait a moment and try again.", code: "rate_limited", retry_after_seconds: seconds },
    429,
    { "Retry-After": String(seconds) },
  );
};
const unavailable = () => jsonResponse({ error: "Phone upload is temporarily unavailable. Try again.", code: "unavailable" }, 503);

/** Same digest as product_image_upload_token_hash() (migration 019). */
const hashUploadToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** `exp` of a storage-signed JWT as ISO, or null. Payload only; storage verifies. */
const tokenExpiresAt = (jwt: string): string | null => {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64)) as { exp?: unknown };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
};

interface SessionRow {
  id: string;
  status: string;
  expires_at: string;
  storage_path: string;
  product_id: string | null;
  shop_id: string | null;
  created_by: string;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("[phone-upload-token] missing supabase service config");
    return unavailable();
  }

  let token: unknown;
  let action: unknown;
  try {
    const parsed = (await request.json()) as { token?: unknown; action?: unknown } | null;
    token = parsed?.token;
    action = parsed?.action;
  } catch {
    return jsonResponse({ error: "Invalid request body.", code: "bad_request" }, 400);
  }
  if (action !== undefined && action !== "complete") {
    return jsonResponse({ error: "Invalid request body.", code: "bad_request" }, 400);
  }
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    return invalidLink();
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- the session, by token hash (service role: RLS does not apply) ----
  const { data: session, error: sessionError } = await supabase
    .from("product_image_upload_sessions")
    .select("id, status, expires_at, storage_path, product_id, shop_id, created_by")
    .eq("token_hash", await hashUploadToken(token))
    .maybeSingle<SessionRow>();
  if (sessionError) {
    console.error("[phone-upload-token] session lookup failed", sessionError.message);
    return unavailable();
  }
  if (!session) return invalidLink();

  if (session.status !== "PENDING") return inactive(session.status);

  if (!(Date.parse(session.expires_at) > Date.now())) {
    // Persist EXPIRED through the existing non-raising reader (019/075); it
    // re-checks expires_at against the database clock itself.
    const { data: stamped, error: stampError } = await supabase.rpc("get_product_image_upload_session_by_token", {
      p_token: token,
    });
    if (stampError) console.error("[phone-upload-token] expiry stamp failed", stampError.message);
    const status = (stamped as { status?: string } | null)?.status;
    return inactive(status && status !== "PENDING" ? status : "EXPIRED");
  }

  // ---- the session's organization, product and shop, from the server ----
  const { data: creator, error: creatorError } = await supabase
    .from("users")
    .select("org_id, is_active")
    .eq("id", session.created_by)
    .maybeSingle<{ org_id: string | null; is_active: boolean | null }>();
  if (creatorError) {
    console.error("[phone-upload-token] creator lookup failed", creatorError.message);
    return unavailable();
  }
  const orgId = creator?.org_id ?? null;
  if (!creator || creator.is_active === false || !orgId || orgId.includes("/")) return refused();

  const expectedPath = `org/${orgId}/temp/${session.id}`;
  if (session.storage_path !== expectedPath) return refused();

  for (const [table, id] of [["products", session.product_id], ["shops", session.shop_id]] as const) {
    if (!id) continue;
    const { data: owned, error: ownedError } = await supabase
      .from(table)
      .select("org_id")
      .eq("id", id)
      .maybeSingle<{ org_id: string | null }>();
    if (ownedError) {
      console.error(`[phone-upload-token] ${table} lookup failed`, ownedError.message);
      return unavailable();
    }
    if (!owned || owned.org_id !== orgId) return refused();
  }

  if (action === "complete") {
    return await completeUpload(supabase, supabaseUrl, serviceRoleKey, token, session.id, expectedPath);
  }

  // ---- rate limit: claim this issue atomically in the database (081) ----
  // Fail closed: any failure to get a clear "allowed" means no token.
  const { data: claim, error: claimError } = await supabase.rpc("claim_phone_upload_token_issue", { p_token: token });
  if (claimError) {
    console.error("[phone-upload-token] rate-limit claim failed", claimError.code ?? "", claimError.message);
    return unavailable();
  }
  const c = (claim ?? {}) as { allowed?: unknown; reason?: unknown; status?: unknown; scope?: unknown; retry_after_seconds?: unknown };
  if (c.allowed !== true) {
    if (c.reason === "rate_limited" && typeof c.retry_after_seconds === "number" && Number.isFinite(c.retry_after_seconds)) {
      console.log("[phone-upload-token] rate limited", String(c.scope ?? ""), c.retry_after_seconds);
      return rateLimited(c.retry_after_seconds);
    }
    if (c.reason === "inactive" && typeof c.status === "string") return inactive(c.status);
    if (c.reason === "invalid") return invalidLink();
    if (c.reason === "refused") return refused();
    console.error("[phone-upload-token] unexpected rate-limit answer");
    return unavailable();
  }

  const storageHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const objectPath = `${BUCKET}/${encodePath(expectedPath)}`;

  // ---- already uploaded? (a retry after the transfer landed) ----
  const head = await fetch(`${supabaseUrl}/storage/v1/object/${objectPath}`, { method: "HEAD", headers: storageHeaders });
  await head.body?.cancel();
  if (head.ok) return jsonResponse({ alreadyUploaded: true, path: expectedPath });
  if (head.status !== 400 && head.status !== 404) {
    console.error("[phone-upload-token] object check failed", head.status);
    return unavailable();
  }

  // ---- sign exactly that path (upsert false: no overwrite, no duplicate) ----
  const signed = await fetch(`${supabaseUrl}/storage/v1/object/upload/sign/${objectPath}`, {
    method: "POST",
    headers: { ...storageHeaders, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!signed.ok) {
    console.error("[phone-upload-token] sign failed", signed.status);
    await signed.body?.cancel();
    return unavailable();
  }
  let uploadToken: string | null = null;
  try {
    const { url } = (await signed.json()) as { url?: string };
    uploadToken = url ? new URL(url, "http://storage.invalid").searchParams.get("token") : null;
  } catch {
    uploadToken = null;
  }
  if (!uploadToken) {
    console.error("[phone-upload-token] sign returned no token");
    return unavailable();
  }

  return jsonResponse({ token: uploadToken, path: expectedPath, expiresAt: tokenExpiresAt(uploadToken) });
});

const invalidImage = () =>
  jsonResponse(
    { error: "The uploaded file is not a valid JPEG, PNG or WebP photo under 100 KB. Please choose another photo.", code: "invalid_image" },
    422,
  );

/**
 * Read at most `limit` + 1 bytes of a response body (the caller rejects
 * anything longer). The result is cut to exactly `limit` + 1 bytes, so two
 * reads of the same oversized object give the same bytes whatever the chunk
 * boundaries were (085: discardRefusedObject compares them).
 */
const readCapped = async (res: Response, limit: number): Promise<Uint8Array> => {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, limit + 1));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    const take = Math.min(p.length, out.length - at);
    out.set(take === p.length ? p : p.subarray(0, take), at);
    at += take;
  }
  return out;
};

const sha256Hex = async (b: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");

/** What was validated: enough to recognise exactly that object again before deleting it. */
interface ObjectIdentity {
  sha256: string;
  length: number;
  type: string;
  etag: string | null;
  lastModified: string | null;
}

const identityOf = async (res: Response, bytes: Uint8Array): Promise<ObjectIdentity> => ({
  sha256: await sha256Hex(bytes),
  length: bytes.length,
  type: normaliseContentType(res.headers.get("content-type")),
  etag: res.headers.get("etag"),
  lastModified: res.headers.get("last-modified"),
});

// The 080 RPC's refusals that are raised only AFTER it locked the session row
// and confirmed it is PENDING and unexpired; the RAISE rolls the call back, so
// the session is still PENDING. Only these lead to a cleanup. "Invalid upload
// link" and "Upload link is no longer active" never do.
const PENDING_REFUSALS = new Set([
  "Upload path does not match this session",
  "Uploaded image must be 100 KB or smaller",
  "Unsupported uploaded image type",
  "Uploaded image URL must be a Storage URL",
  "Uploaded image URL must point to the product-images bucket",
  "Uploaded image URL does not match this upload session",
  "Uploaded image was not found in storage",
  "Phone image upload is not configured on this server",
]);

type Discard =
  | "deleted" | "gone" | "kept_session" | "kept_referenced" | "kept_replaced" | "kept_check_failed" | "kept_delete_failed";

/**
 * Delete a refused object, defensively. `path` is the server-derived session
 * path (never anything from the request), `validated` identifies the object
 * that was checked. Every condition is re-read with the service role right
 * before the DELETE; any doubt keeps the object (the abandoned-upload sweep,
 * part of the deployment configuration, removes it after the session
 * expired, with the same guarantees).
 */
async function discardRefusedObject(
  supabase: ReturnType<typeof createClient>,
  objectUrl: string,
  storageHeaders: Record<string, string>,
  sessionId: string,
  path: string,
  validated: ObjectIdentity,
): Promise<Discard> {
  // 1. the session: still PENDING, never completed, still owns exactly this path
  const { data: row, error: rowError } = await supabase
    .from("product_image_upload_sessions")
    .select("id, status, storage_path, completed_at, public_url")
    .eq("id", sessionId)
    .maybeSingle<{ id: string; status: string; storage_path: string; completed_at: string | null; public_url: string | null }>();
  if (rowError) return "kept_check_failed";
  if (!row || row.status !== "PENDING" || row.completed_at || row.public_url || row.storage_path !== path) return "kept_session";

  // 2. nothing may reference the path: a product image, a logo, a session URL,
  //    or another session holding the same path. ilike '*<path>*' is
  //    deliberately broad ('_' matches any character): it can only keep more.
  const pattern = `*${path}*`;
  const refs = await Promise.all([
    supabase.from("products").select("id").ilike("image_url", pattern).limit(1),
    supabase.from("business_profile").select("id").ilike("logo_url", pattern).limit(1),
    supabase.from("product_image_upload_sessions").select("id").ilike("public_url", pattern).limit(1),
    supabase.from("product_image_upload_sessions").select("id").eq("storage_path", path).neq("id", sessionId).limit(1),
  ]);
  for (const r of refs) {
    if (r.error || !Array.isArray(r.data)) return "kept_check_failed";
    if (r.data.length > 0) return "kept_referenced";
  }

  // 3. the object must still be exactly the validated one (after an earlier
  //    refusal freed the path, a retry may have uploaded a new object)
  const again = await fetch(objectUrl, { method: "GET", headers: storageHeaders });
  if (again.status === 400 || again.status === 404) {
    await again.body?.cancel();
    return "gone";
  }
  if (!again.ok) {
    await again.body?.cancel();
    return "kept_check_failed";
  }
  const now = await identityOf(again, await readCapped(again, MAX_COMPLETION_BYTES));
  if (
    now.sha256 !== validated.sha256 || now.length !== validated.length || now.type !== validated.type ||
    now.etag !== validated.etag || now.lastModified !== validated.lastModified
  ) {
    return "kept_replaced";
  }

  // 4. delete exactly that path
  const del = await fetch(objectUrl, { method: "DELETE", headers: storageHeaders });
  await del.body?.cancel();
  if (del.status === 400 || del.status === 404) return "gone";
  if (!del.ok) return "kept_delete_failed";

  // A completion committing between step 1 and the DELETE would need the RPC
  // to accept the very object it (or the byte check) just refused - only a
  // configuration change in that window could do that. Say so loudly.
  const { data: after } = await supabase
    .from("product_image_upload_sessions").select("status").eq("id", sessionId).maybeSingle<{ status: string }>();
  if (after?.status === "COMPLETED") {
    console.error("[phone-upload-token] a refused object was deleted while its session completed concurrently");
  }
  return "deleted";
}

const logDiscard = (what: string, reason: string, outcome: Discard) => {
  console.log(`[phone-upload-token] ${what}`, reason, outcome);
  if (outcome.startsWith("kept")) console.error("[phone-upload-token] refused object NOT deleted", outcome);
};

/**
 * G5 / 083: validate the stored object's bytes, then complete the session
 * with the service role. `path` is the server-derived session path of
 * `sessionId` (checked by the caller).
 */
async function completeUpload(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceRoleKey: string,
  token: string,
  sessionId: string,
  path: string,
): Promise<Response> {
  const storageHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  const objectUrl = `${supabaseUrl}/storage/v1/object/${BUCKET}/${encodePath(path)}`;

  const got = await fetch(objectUrl, { method: "GET", headers: storageHeaders });
  if (got.status === 400 || got.status === 404) {
    await got.body?.cancel();
    return jsonResponse({ error: "The photo has not been uploaded yet.", code: "not_uploaded" }, 409);
  }
  if (!got.ok) {
    console.error("[phone-upload-token] object read failed", got.status);
    await got.body?.cancel();
    return unavailable();
  }
  const declared = normaliseContentType(got.headers.get("content-type"));
  const bytes = await readCapped(got, MAX_COMPLETION_BYTES);
  const validated = await identityOf(got, bytes);
  const verdict = checkUploadedImage(bytes, declared);
  if (!verdict.ok) {
    // Never leave a refused object on the public origin. The phone's signed
    // URL has upsert false, so the freed path takes another attempt.
    logDiscard("refused uploaded object", verdict.reason,
      await discardRefusedObject(supabase, objectUrl, storageHeaders, sessionId, path, validated));
    return invalidImage();
  }

  const publicBase = (Deno.env.get("SUPABASE_PUBLIC_URL") ?? supabaseUrl).replace(/\/$/, "");
  const { data, error } = await supabase.rpc("complete_product_image_upload_session", {
    p_token: token,
    p_storage_path: path,
    // 080: only the PATH of this URL is checked; the stored URL is derived server-side
    p_public_url: `${publicBase}/storage/v1/object/public/${BUCKET}/${path}`,
    p_bytes: bytes.length,
    p_mime_type: verdict.type,
  });
  if (error) {
    const message = typeof error.message === "string" ? error.message : "";
    if (/no longer active/i.test(message)) {
      // another completion won the race, or expired / cancelled: never delete
      const { data: current } = await supabase.rpc("get_product_image_upload_session_by_token", { p_token: token });
      const status = (current as { status?: string } | null)?.status;
      return inactive(status && status !== "PENDING" ? status : "EXPIRED");
    }
    if (error.code === "P0001" && message) {
      // the 080 RPC's own generic refusals (not found / type / size / not
      // configured), raised while the session is PENDING: the object goes
      if (PENDING_REFUSALS.has(message)) {
        logDiscard("completion refused", "rpc", await discardRefusedObject(supabase, objectUrl, storageHeaders, sessionId, path, validated));
      }
      return jsonResponse({ error: message, code: "completion_refused" }, 422);
    }
    // unknown outcome (the call may even have committed): never delete
    console.error("[phone-upload-token] completion failed", error.code ?? "", message);
    return unavailable();
  }
  if (!data || typeof data !== "object") return unavailable();
  return jsonResponse(data as Record<string, unknown>);
}
