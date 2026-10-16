/**
 * Product image storage: uploads a compressed product photo (or the business
 * logo) through the server-validated upload flow and returns the public URL
 * the SERVER derived for it.
 *
 * Product rows store a Storage **public URL** in `products.image_url`; base64
 * data URLs are never written. The image itself is always the < 100 KB blob
 * produced by `compressProductImage`.
 *
 * G5 follow-up (docs/selfhost-migration/phase-f/g5-followups.md): the desktop
 * no longer writes to Storage with the staff JWT. It uses the same flow as
 * the QR phone upload, with itself as the "phone":
 *   1. create_product_image_upload_session (signed in): the server checks the
 *      permission, the organization, the product and shop, and mints the
 *      object path org/<caller org>/temp/<session>. Nothing about the path
 *      comes from this client.
 *   2. phone-upload-token {token}: a 60 s signed upload token for exactly that
 *      path (upsert false), issued with the service role.
 *   3. the PUT to the signed upload URL (storage-api checks the bucket's
 *      declared-type and size limits, migration 083).
 *   4. phone-upload-token {token, action:"complete"}: the function reads the
 *      stored object back, checks its BYTES (magic number, <= 100 KB, no
 *      HTML/SVG markup), deletes a refused object, and completes the session
 *      with the service role. The answer carries the trusted public URL
 *      (app_config origin + bucket + session path, migration 080).
 * Only that server-derived URL is handed back to the form. After every till
 * runs this build, migration 084 removes staff INSERT/UPDATE on the bucket,
 * so this validated flow becomes the only way to write an image.
 *
 * Bucket: `product-images` (public). See `supabase/migrations/016_product_images_storage.sql`.
 */
import { MAX_PRODUCT_IMAGE_BYTES, type CompressedImage } from "./compressProductImage";
import { PRODUCT_IMAGE_BUCKET } from "./productImageBucket";
import {
  cancelProductImageUploadSession,
  createProductImageUploadSession,
  uploadPhoneProductImage,
  ValidatedUploadUnavailableError,
  type PhoneUploadDeps,
  type ProductImageUploadSession,
  type ProductImageUploadSessionStatusResult,
} from "./productImagePhoneUpload";

export { PRODUCT_IMAGE_BUCKET };

/**
 * Legacy (pre-G5) direct-upload path layout:
 * `org/<orgId>/products/<productId>/<timestamp>.<ext>`. No longer used to
 * write: validated uploads are stored at the server-minted session path
 * `org/<orgId>/temp/<sessionId>`. Kept because existing objects use it and the
 * 078 storage helpers still resolve it. Pure; safe to unit test.
 */
export function buildProductImagePath(orgId: string, productId: string, mimeType: string): string {
  const ext = mimeType === "image/webp" ? "webp" : "jpg";
  return `org/${orgId}/products/${productId}/${Date.now()}.${ext}`;
}

/** One non-empty storage path segment (no "/", not "." or ".."). */
const isPathSegment = (value: string): boolean =>
  value.length > 0 && !value.includes("/") && value !== "." && value !== "..";

/** What a validated upload may produce: a session path minted by the server. */
const SESSION_PATH_RE = /^org\/[^/]+\/temp\/[^/]+$/;

/**
 * The server's answer must name a COMPLETED session at the path the server
 * minted, and its public URL must be exactly that object's public URL
 * (http(s), path `/storage/v1/object/public/product-images/<path>`, no query
 * or fragment). Anything else is refused: the form only ever receives a URL
 * the server derived for the object it just validated. Returns the URL.
 */
export function trustedProductImageUrl(
  result: Pick<ProductImageUploadSessionStatusResult, "status" | "storagePath" | "publicUrl">,
  expectedStoragePath: string,
): string {
  if (result.status !== "COMPLETED") {
    throw new Error("The image upload was not completed by the server.");
  }
  if (result.storagePath !== expectedStoragePath || !SESSION_PATH_RE.test(expectedStoragePath)) {
    throw new Error("The server completed a different upload than the one requested.");
  }
  const raw = result.publicUrl;
  if (typeof raw !== "string" || !raw) {
    throw new Error("The server did not return an image URL (image upload is not configured on this server).");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The server returned an invalid image URL.");
  }
  const expectedPath = `/storage/v1/object/public/${PRODUCT_IMAGE_BUCKET}/${expectedStoragePath}`;
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username || url.password || url.search || url.hash ||
    url.pathname !== expectedPath ||
    raw !== `${url.origin}${expectedPath}`
  ) {
    throw new Error("The server returned an image URL for another object.");
  }
  return raw;
}

export interface ProductImageUploadDeps {
  createSession?: (input: { productId: string; shopId?: string | null }) => Promise<ProductImageUploadSession>;
  upload?: (sessionToken: string, image: CompressedImage, deps: PhoneUploadDeps) => Promise<ProductImageUploadSessionStatusResult>;
  cancelSession?: (sessionId: string) => Promise<void>;
  /** passed through to uploadPhoneProductImage (tests replace the transports) */
  uploadDeps?: PhoneUploadDeps;
}

/**
 * Upload a compressed product image (or, with productId "brand", the
 * business logo) through the validated session flow and return the public
 * URL the server derived for it (store this in `products.image_url` /
 * `business_profile.logo_url`).
 *
 * Throws a friendly `Error` if the image is over the 100 KB cap, if no
 * product id is given, if the server refuses the bytes (not a real JPEG/PNG/WebP
 * photo), or if any step fails. A session that did not complete is cancelled
 * (best effort), so its object becomes eligible for the abandoned-upload sweep.
 */
export async function uploadProductImage(
  productId: string,
  image: CompressedImage,
  opts: { shopId?: string | null } = {},
  deps: ProductImageUploadDeps = {},
): Promise<string> {
  // Defensive: never upload anything above the product-image size cap.
  if (image.bytes > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("Compressed image is over the 100 KB limit and was not uploaded.");
  }
  if (!productId || !isPathSegment(productId)) {
    throw new Error("A product id is required before an image can be uploaded.");
  }

  const createSession = deps.createSession ?? createProductImageUploadSession;
  const upload = deps.upload ?? uploadPhoneProductImage;
  const cancelSession = deps.cancelSession ?? cancelProductImageUploadSession;

  // 1. the server mints the session and its org-scoped path (organization,
  //    permission, product and shop are checked server-side)
  const session = await createSession({ productId, shopId: opts.shopId ?? null });
  if (!SESSION_PATH_RE.test(session.storagePath ?? "")) {
    await cancelSession(session.sessionId).catch(() => undefined);
    throw new Error("The server returned an unexpected upload path.");
  }

  let result: ProductImageUploadSessionStatusResult;
  try {
    // 2-4. token just in time -> signed PUT -> validating completion
    result = await upload(session.token, image, { sessionExpiresAt: session.expiresAt, ...(deps.uploadDeps ?? {}) });
  } catch (e) {
    await cancelSession(session.sessionId).catch(() => undefined);
    // A server without the validated flow: say so plainly (nothing was saved).
    if (e instanceof ValidatedUploadUnavailableError) throw e;
    const message = e instanceof Error && e.message ? e.message : "unknown error";
    throw new Error(message.startsWith("Image upload failed") ? message : `Image upload failed: ${message}`);
  }
  return trustedProductImageUrl(result, session.storagePath);
}
