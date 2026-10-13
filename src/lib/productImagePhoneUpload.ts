import { MAX_PRODUCT_IMAGE_BYTES } from "./compressProductImage";
import { PRODUCT_IMAGE_BUCKET } from "./productImageStorage";

export const PRODUCT_IMAGE_PHONE_UPLOAD_ROUTE = "/phone-upload/product-image";

export type ProductImageUploadSessionStatus = "PENDING" | "COMPLETED" | "EXPIRED" | "CANCELED";

export interface ProductImageUploadSession {
  sessionId: string;
  token: string;
  storagePath: string;
  expiresAt: string;
  status: ProductImageUploadSessionStatus;
}

export interface ProductImageUploadQrSession extends ProductImageUploadSession {
  qrUrl: string;
}

export interface ProductImageUploadSessionStatusResult {
  sessionId: string;
  storagePath: string;
  publicUrl?: string;
  bytes?: number;
  mimeType?: string;
  uploadToken?: string;
  expiresAt: string;
  status: ProductImageUploadSessionStatus;
}

interface SessionRpcRow {
  sessionId: string;
  token?: string;
  storagePath: string;
  publicUrl?: string;
  bytes?: number;
  mimeType?: string;
  uploadToken?: string;
  expiresAt: string;
  status: ProductImageUploadSessionStatus;
}

const assertStorageUrlIsSafe = (url: string): void => {
  if (url.trim().toLowerCase().startsWith("data:")) {
    throw new Error("Product image URL must be a Storage URL, not base64 data.");
  }
};

export function buildProductImagePhoneUploadQrUrl(
  origin: string,
  sessionToken: string,
): string {
  const normalizedOrigin = origin.replace(/\/$/, "");
  const url = new URL(
    `${normalizedOrigin}${PRODUCT_IMAGE_PHONE_UPLOAD_ROUTE}/${encodeURIComponent(sessionToken)}`,
  );
  return url.toString();
}

export function assertCompressedPhoneUpload(bytes: number, publicUrl: string): void {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("Compressed image is over the 100 KB limit and was not uploaded.");
  }
  assertStorageUrlIsSafe(publicUrl);
}

export async function createProductImageUploadSession(input: {
  productId: string;
  shopId?: string | null;
}): Promise<ProductImageUploadSession> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.rpc("create_product_image_upload_session", {
    p_product_id: input.productId || null,
    p_shop_id: input.shopId || null,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Upload session was not created.");

  const session = data as SessionRpcRow;
  if (!session.token) throw new Error("Upload session did not return a token.");

  return {
    sessionId: session.sessionId,
    token: session.token,
    storagePath: session.storagePath,
    expiresAt: session.expiresAt,
    status: session.status,
  };
}

/**
 * Desktop (signed in): create the QR session. The desktop no longer signs a
 * storage upload token or attaches one to the session: a signed token lives
 * only UPLOAD_SIGNED_URL_EXPIRATION_TIME (60 s on lucashome) while the QR is
 * valid for the whole session (10 min), so the phone obtains its token just
 * in time from the `phone-upload-token` Edge Function right before it uploads
 * (docs/selfhost-migration/phase-g/phone-upload-jit.md). The desktop only
 * polls the session status. attach_product_image_upload_session_token stays
 * on the server for older builds but is not called by this flow.
 */
export async function createPhoneProductImageUploadSession(input: {
  productId: string;
  shopId?: string | null;
  origin?: string;
}): Promise<ProductImageUploadQrSession> {
  const session = await createProductImageUploadSession(input);
  const origin = input.origin ?? window.location.origin;
  return {
    ...session,
    qrUrl: buildProductImagePhoneUploadQrUrl(origin, session.token),
  };
}

export const PHONE_UPLOAD_TOKEN_FUNCTION = "phone-upload-token";

/** The session is no longer PENDING (expired, cancelled or completed): the phone must stop. */
export class PhoneUploadInactiveError extends Error {
  readonly status: ProductImageUploadSessionStatus;
  constructor(status: ProductImageUploadSessionStatus, message?: string) {
    super(
      message ??
        (status === "EXPIRED"
          ? "This upload link has expired."
          : status === "CANCELED"
            ? "This upload link was cancelled on the computer."
            : "This upload link is no longer active."),
    );
    this.name = "PhoneUploadInactiveError";
    this.status = status;
  }
}

/** The server refused to issue a token (invalid link, or the session no longer matches its organization). */
export class PhoneUploadRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneUploadRefusedError";
  }
}

/**
 * The server refused to issue a token for now (migration 081 rate limits:
 * HTTP 429 {code:"rate_limited", retry_after_seconds} + Retry-After).
 */
export class PhoneUploadRateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message?: string) {
    super(message ?? "Too many upload attempts. Please wait a moment and try again.");
    this.name = "PhoneUploadRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The phone waits and retries a rate-limited token request by itself at most
 *  this many times per upload, and only when the wait is this short. */
export const PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES = 3;
export const PHONE_UPLOAD_MAX_AUTO_WAIT_SECONDS = 60;

export type PhoneUploadRateLimitAdvice =
  /** short wait: the phone waits this long, then retries by itself */
  | { kind: "wait"; seconds: number }
  /** longer wait: tell the user to try again in about this many minutes */
  | { kind: "later"; minutes: number }
  /** the link will expire before it may be used again (per-session cap): a new QR is needed */
  | { kind: "linkExhausted" };

/** How the phone should react to a 429, given the session's expiry. */
export function adviseOnRateLimit(
  retryAfterSeconds: number,
  opts: { expiresAt?: string | null; now?: number; retriesSoFar?: number } = {},
): PhoneUploadRateLimitAdvice {
  const seconds = Math.max(1, Math.ceil(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : PHONE_UPLOAD_MAX_AUTO_WAIT_SECONDS));
  const now = opts.now ?? Date.now();
  const expiresAt = opts.expiresAt ? Date.parse(opts.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && now + seconds * 1000 >= expiresAt) return { kind: "linkExhausted" };
  if (seconds <= PHONE_UPLOAD_MAX_AUTO_WAIT_SECONDS && (opts.retriesSoFar ?? 0) < PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES) {
    return { kind: "wait", seconds };
  }
  return { kind: "later", minutes: Math.max(1, Math.ceil(seconds / 60)) };
}

/** What the phone does next: upload with this fresh token, or (the object is
 *  already there) go straight to completion. */
export type PhoneUploadTarget =
  | { kind: "upload"; storagePath: string; uploadToken: string; expiresAt: string | null }
  | { kind: "alreadyUploaded"; storagePath: string };

/** Raw function answer: HTTP status + JSON body (null when unreadable) + the Retry-After header, if any. */
export type PhoneUploadTokenCall = (sessionToken: string) => Promise<{ status: number; body: unknown; retryAfter?: string | null }>;

const STATUSES: readonly ProductImageUploadSessionStatus[] = ["PENDING", "COMPLETED", "EXPIRED", "CANCELED"];

/** Default transport: supabase.functions.invoke with the anon key only (no user session on the phone). */
const invokePhoneUploadTokenFunction: PhoneUploadTokenCall = async (sessionToken) => {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.functions.invoke(PHONE_UPLOAD_TOKEN_FUNCTION, {
    body: { token: sessionToken },
  });
  if (!error) return { status: 200, body: data };
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    const body = await context.json().catch(() => null);
    return { status: context.status, body, retryAfter: context.headers.get("Retry-After") };
  }
  throw new Error("Could not reach the server. Check the phone's connection and try again.");
};

/**
 * Phone (anonymous): ask the server for a signed upload token RIGHT NOW,
 * immediately before transferring the file. The server issues it only for a
 * PENDING, unexpired session, bound to that session's own object path.
 */
export async function requestPhoneUploadTarget(
  sessionToken: string,
  call: PhoneUploadTokenCall = invokePhoneUploadTokenFunction,
): Promise<PhoneUploadTarget> {
  const { status, body, retryAfter } = await call(sessionToken);
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    if (b.alreadyUploaded === true && typeof b.path === "string") {
      return { kind: "alreadyUploaded", storagePath: b.path };
    }
    if (typeof b.token === "string" && b.token && typeof b.path === "string" && b.path) {
      return {
        kind: "upload",
        storagePath: b.path,
        uploadToken: b.token,
        expiresAt: typeof b.expiresAt === "string" ? b.expiresAt : null,
      };
    }
    throw new Error("The upload server returned an unexpected answer. Try again.");
  }
  const message = typeof b.error === "string" && b.error ? b.error : null;
  if (status === 410 || b.code === "inactive") {
    const s = STATUSES.includes(b.status as ProductImageUploadSessionStatus)
      ? (b.status as ProductImageUploadSessionStatus)
      : "EXPIRED";
    throw new PhoneUploadInactiveError(s);
  }
  if (status === 429 || b.code === "rate_limited") {
    const fromBody = typeof b.retry_after_seconds === "number" ? b.retry_after_seconds : NaN;
    const fromHeader = retryAfter != null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : NaN;
    const seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 10;
    throw new PhoneUploadRateLimitedError(Math.ceil(seconds), message ?? undefined);
  }
  if (status === 404 || status === 403) {
    throw new PhoneUploadRefusedError(message ?? "Invalid upload link.");
  }
  throw new Error(message ?? "Phone upload is temporarily unavailable. Try again.");
}

/** How a failed signed-URL upload should be handled. */
export type StorageUploadFailure = "expired_token" | "duplicate" | "network" | "other";

export function classifyStorageUploadError(error: unknown): StorageUploadFailure {
  const e = (error ?? {}) as { name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const status = typeof e.status === "number" ? e.status : Number(e.statusCode);
  const message = typeof e.message === "string" ? e.message : "";
  if (status === 409 || /already exists|duplicate/i.test(message)) return "duplicate";
  if (/InvalidJWT/i.test(String(e.statusCode)) || ((status === 400 || status === 403) && /exp|jwt|signature|token/i.test(message))) {
    return "expired_token";
  }
  if (e.name === "StorageUnknownError" || !Number.isFinite(status) || status === 0) return "network";
  return "other";
}

export interface PhoneUploadImage {
  blob: Blob;
  bytes: number;
  mimeType: string;
}

export interface PhoneUploadDeps {
  requestTarget?: (sessionToken: string) => Promise<PhoneUploadTarget>;
  uploadToSignedUrl?: (path: string, uploadToken: string, image: PhoneUploadImage) => Promise<{ error: unknown }>;
  publicUrl?: (path: string) => Promise<string>;
  complete?: typeof completeProductImageUploadSession;
  readSession?: (sessionToken: string) => Promise<ProductImageUploadSessionStatusResult>;
  /** Waits between rate-limited retries (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each automatic wait after a 429 (UI countdown). */
  onRateLimitWait?: (seconds: number, retry: number) => void;
  /** The session's expiry, so a wait that outlasts the link is not attempted. */
  sessionExpiresAt?: string | null;
}

const defaultUploadToSignedUrl: NonNullable<PhoneUploadDeps["uploadToSignedUrl"]> = async (path, uploadToken, image) => {
  const { supabase } = await import("./supabase");
  const { error } = await supabase.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .uploadToSignedUrl(path, uploadToken, image.blob, {
      cacheControl: "31536000",
      contentType: image.mimeType,
    });
  return { error };
};

const defaultPublicUrl = async (path: string) => {
  const { supabase } = await import("./supabase");
  return supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
};

/**
 * Phone (anonymous): the whole upload. Token just in time -> transfer ->
 * complete, retry-safe:
 *  - storage refuses the token as expired (or the transfer fails on the
 *    network): ask for a fresh token ONCE (the server re-checks the session,
 *    and reports the object as already uploaded when the transfer did land);
 *  - the object already exists (409, or the server says so): go to completion;
 *  - completion refused because the session is already COMPLETED for this
 *    same path (a concurrent/earlier attempt finished it): that is success.
 * The object path is always the server's; upsert is never set, so retries
 * cannot create a second object or overwrite the first.
 */
export async function uploadPhoneProductImage(
  sessionToken: string,
  image: PhoneUploadImage,
  deps: PhoneUploadDeps = {},
): Promise<ProductImageUploadSessionStatusResult> {
  const requestTarget = deps.requestTarget ?? ((t: string) => requestPhoneUploadTarget(t));
  const uploadToSignedUrl = deps.uploadToSignedUrl ?? defaultUploadToSignedUrl;
  const publicUrl = deps.publicUrl ?? defaultPublicUrl;
  const complete = deps.complete ?? completeProductImageUploadSession;
  const readSession = deps.readSession ?? getProductImageUploadSessionByToken;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // 081: a 429 is retried automatically after the server's Retry-After, at
  // most PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES times per upload and only for
  // waits up to PHONE_UPLOAD_MAX_AUTO_WAIT_SECONDS that end before the link
  // expires; otherwise the PhoneUploadRateLimitedError reaches the page.
  let rateLimitRetries = 0;
  const requestTargetPolitely = async (): Promise<PhoneUploadTarget> => {
    for (;;) {
      try {
        return await requestTarget(sessionToken);
      } catch (e) {
        if (!(e instanceof PhoneUploadRateLimitedError)) throw e;
        const advice = adviseOnRateLimit(e.retryAfterSeconds, { expiresAt: deps.sessionExpiresAt, retriesSoFar: rateLimitRetries });
        if (advice.kind !== "wait") throw e;
        rateLimitRetries += 1;
        deps.onRateLimitWait?.(advice.seconds, rateLimitRetries);
        // + up to 1 s jitter so phones that were refused together do not return together
        await sleep(advice.seconds * 1000 + Math.floor(Math.random() * 1000));
      }
    }
  };

  let storagePath = "";
  for (let attempt = 0; ; attempt++) {
    const target = await requestTargetPolitely();
    storagePath = target.storagePath;
    if (target.kind === "alreadyUploaded") break;
    const { error } = await uploadToSignedUrl(target.storagePath, target.uploadToken, image);
    if (!error) break;
    const failure = classifyStorageUploadError(error);
    if (failure === "duplicate") break;
    if ((failure === "expired_token" || failure === "network") && attempt === 0) continue;
    const message = (error as { message?: unknown }).message;
    throw new Error(`Image upload failed: ${typeof message === "string" && message ? message : "unknown error"}`);
  }

  try {
    return await complete({
      token: sessionToken,
      storagePath,
      publicUrl: await publicUrl(storagePath),
      bytes: image.bytes,
      mimeType: image.mimeType,
    });
  } catch (e) {
    const current = await readSession(sessionToken).catch(() => null);
    if (current?.status === "COMPLETED" && current.storagePath === storagePath) return current;
    if (current && current.status !== "PENDING") throw new PhoneUploadInactiveError(current.status);
    throw e;
  }
}

export async function getProductImageUploadSessionStatus(
  sessionId: string,
): Promise<ProductImageUploadSessionStatusResult> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.rpc("get_product_image_upload_session_status", {
    p_session_id: sessionId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Upload session was not found.");
  return data as ProductImageUploadSessionStatusResult;
}

export async function getProductImageUploadSessionByToken(
  token: string,
): Promise<ProductImageUploadSessionStatusResult> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.rpc("get_product_image_upload_session_by_token", {
    p_token: token,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Upload session was not found.");
  return data as ProductImageUploadSessionStatusResult;
}

export async function completeProductImageUploadSession(input: {
  token: string;
  storagePath: string;
  publicUrl: string;
  bytes: number;
  mimeType: string;
}): Promise<ProductImageUploadSessionStatusResult> {
  assertCompressedPhoneUpload(input.bytes, input.publicUrl);

  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.rpc("complete_product_image_upload_session", {
    p_token: input.token,
    p_storage_path: input.storagePath,
    p_public_url: input.publicUrl,
    p_bytes: input.bytes,
    p_mime_type: input.mimeType,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Upload session completion returned no data.");
  return data as ProductImageUploadSessionStatusResult;
}

export async function cancelProductImageUploadSession(sessionId: string): Promise<void> {
  const { supabase } = await import("./supabase");
  const { error } = await supabase.rpc("cancel_product_image_upload_session", {
    p_session_id: sessionId,
  });
  if (error) throw new Error(error.message);
}
