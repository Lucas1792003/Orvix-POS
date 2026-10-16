/// <reference types="node" />
// Version-aware phone-upload completion for the live suites (migration 083 /
// G5, docs/selfhost-migration/phase-f/migration-083-g5.md).
//
//   schema < 083  the phone (anon) calls complete_product_image_upload_session
//                 directly, with the path / URL / size / type it claims;
//   schema >= 083 anon and authenticated have no EXECUTE on that RPC (42501).
//                 The phone POSTs {token, action:"complete"} to
//                 /functions/v1/phone-upload-token, which re-derives the path
//                 from the session row, checks the stored BYTES, deletes a
//                 refused object (422 invalid_image, session stays PENDING),
//                 and completes with the service role.
//
// Both answers are normalised into one PhoneCompletion so a suite can assert
// the same outcome (completed / inactive / not uploaded / invalid link) on
// either schema, and assert the version-specific details where they differ.
import type { SupabaseClient } from "@supabase/supabase-js";
import { TINY_WEBP } from "./imageFixtures";
import { runSql, type LiveConfig } from "./liveHelpers";

/** First schema version where completion is function-only. */
export const G5_SCHEMA = "083";
export const PHONE_UPLOAD_FN = "/functions/v1/phone-upload-token";
export const COMPLETE_RPC = "complete_product_image_upload_session";
const BUCKET = "product-images";

// The RPC's own messages (080) and the function's codes (083).
export const RPC_INACTIVE = "Upload link is no longer active";
export const RPC_NOT_FOUND = "Uploaded image was not found in storage";
export const RPC_INVALID_LINK = "Invalid upload link";
export const FN_INVALID_IMAGE = "The uploaded file is not a valid JPEG, PNG or WebP photo under 100 KB. Please choose another photo.";
/** The 083 function's wording (before the 085 function deploy); still accepted so the suites run against either build. */
export const FN_INVALID_IMAGE_083 = "The uploaded file is not a valid JPEG or WebP photo under 100 KB. Please choose another photo.";
/** First schema version where the completion RPC accepts image/png. */
export const PNG_SCHEMA = "085";
export const isPost085 = (version: string): boolean => version >= PNG_SCHEMA;

/** max(supabase_migrations.schema_migrations.version), e.g. "082" / "083". */
export function schemaVersion(cfg: LiveConfig): string {
  return runSql(cfg, "SELECT max(version) FROM supabase_migrations.schema_migrations;").trim();
}
export const isPost083 = (version: string): boolean => version >= G5_SCHEMA;

export interface PhoneCompletion {
  via: "rpc" | "function";
  /** true when the answer is the completed session (same payload shape both ways). */
  ok: boolean;
  /** the RPC payload: sessionId, storagePath, publicUrl, bytes, mimeType, expiresAt, status */
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** HTTP status (the function's own; PostgREST's for the RPC) */
  httpStatus: number;
  /** PostgREST error code (rpc) or the function's `code` (function) */
  code: string | null;
  message: string;
  /** function 410 only: the session status it reports */
  sessionStatus?: string;
}

export interface CompletionSession { token: string; storagePath: string }

/** POST {token, action:"complete"} (+ any extra fields, which the function must ignore) with the anon key. */
export async function completeThroughFunction(cfg: LiveConfig, token: unknown, extra: Record<string, unknown> = {}): Promise<PhoneCompletion> {
  const res = await fetch(`${cfg.url}${PHONE_UPLOAD_FN}`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ...extra, token, action: "complete" }),
  });
  const text = await res.text();
  let body: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = JSON.parse(text); } catch { body = null; }
  const ok = res.status === 200 && body?.status === "COMPLETED";
  return {
    via: "function", ok, data: ok ? body : null, httpStatus: res.status,
    code: ok ? null : (typeof body?.code === "string" ? body.code : null),
    message: ok ? "" : String(body?.error ?? text.slice(0, 200)),
    sessionStatus: typeof body?.status === "string" && !ok ? body.status : undefined,
  };
}

/** The RPC as `client` (anon / authenticated / service role). */
export async function completeThroughRpc(client: SupabaseClient, args: Record<string, unknown>): Promise<PhoneCompletion> {
  const r = await client.rpc(COMPLETE_RPC, args);
  return {
    via: "rpc", ok: !r.error && r.data?.status === "COMPLETED", data: r.error ? null : r.data, httpStatus: r.status,
    code: r.error?.code ?? null, message: r.error?.message ?? "",
  };
}

export const publicObjectUrl = (base: string, path: string) => `${base}/storage/v1/object/public/${BUCKET}/${path}`;

/** The exact arguments the pre-083 phone sent (its own path, its public URL, the image's size/type). */
export const exactRpcArgs = (cfg: LiveConfig, s: CompletionSession, over: Record<string, unknown> = {}) => ({
  p_token: s.token, p_storage_path: s.storagePath, p_public_url: publicObjectUrl(cfg.url, s.storagePath),
  p_bytes: TINY_WEBP.length, p_mime_type: "image/webp", ...over,
});

/** The phone's token request (the function without an action). */
export async function requestUploadToken(cfg: LiveConfig, token: unknown): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${cfg.url}${PHONE_UPLOAD_FN}`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

/**
 * PUT bytes to a signed upload URL exactly as the phone does (anon key,
 * x-upsert false). `fileName` sends multipart form-data with that file name
 * and part type instead of a raw body (what a browser form / supabase-js
 * uploadToSignedUrl with a File sends).
 */
export async function signedPut(
  cfg: LiveConfig, path: string, uploadToken: string, body: Buffer, contentType: string, fileName?: string,
): Promise<{ status: number; body: string }> {
  const url = `${cfg.url}/storage/v1/object/upload/sign/${BUCKET}/${path}?token=${encodeURIComponent(uploadToken)}`;
  const headers: Record<string, string> = { apikey: cfg.anonKey, "x-upsert": "false" };
  let payload: BodyInit;
  if (fileName) {
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", new File([new Uint8Array(body)], fileName, { type: contentType }));
    payload = form;
  } else {
    headers["content-type"] = contentType;
    payload = new Uint8Array(body);
  }
  try {
    const res = await fetch(url, { method: "PUT", headers, body: payload });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  } catch (e) {
    // a server may close the connection on an oversized body before answering
    return { status: 0, body: `connection closed before an answer: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
}

/**
 * What the PHONE does to complete, on the stack's schema: < 083 the anon RPC
 * with the exact arguments (+ `rpcOver`, e.g. a claimed size); >= 083 the
 * function (no path / URL / size is sent at all).
 */
export function phoneCompleter(cfg: LiveConfig, anon: SupabaseClient, post083: () => boolean) {
  return (s: CompletionSession, rpcOver: Record<string, unknown> = {}): Promise<PhoneCompletion> =>
    post083() ? completeThroughFunction(cfg, s.token) : completeThroughRpc(anon, exactRpcArgs(cfg, s, rpcOver));
}

// ---- outcome predicates (either schema) ------------------------------------
export const isInactive = (c: PhoneCompletion) =>
  c.via === "rpc" ? c.message === RPC_INACTIVE : c.httpStatus === 410 && c.code === "inactive";
export const isNotUploaded = (c: PhoneCompletion) =>
  c.via === "rpc" ? c.message === RPC_NOT_FOUND : c.httpStatus === 409 && c.code === "not_uploaded";
export const isInvalidLink = (c: PhoneCompletion) =>
  c.via === "rpc" ? c.message === RPC_INVALID_LINK : c.httpStatus === 404 && c.code === "invalid";
export const isInvalidImage = (c: PhoneCompletion) =>
  c.via === "function" && c.httpStatus === 422 && c.code === "invalid_image" && (c.message === FN_INVALID_IMAGE || c.message === FN_INVALID_IMAGE_083);
/** 085 function on a schema < 085: the RPC refused (e.g. PNG type) and the function deleted the object. */
export const isCompletionRefused = (c: PhoneCompletion, message?: string) =>
  c.via === "function" && c.httpStatus === 422 && c.code === "completion_refused" && (message === undefined || c.message === message);
/** 083: the RPC refused for lack of EXECUTE (not for its arguments). */
export const isPermissionDenied = (c: PhoneCompletion) =>
  c.via === "rpc" && c.code === "42501" && /permission denied/i.test(c.message);

export const describeCompletion = (c: PhoneCompletion) =>
  c.ok ? `${c.via} -> COMPLETED` : `${c.via} -> ${c.httpStatus} ${c.code ?? ""} "${c.message.replace(/\s+/g, " ").slice(0, 60)}"${c.sessionStatus ? ` (${c.sessionStatus})` : ""}`;
