/**
 * Product image storage — uploads compressed product photos to Supabase
 * Storage and returns a public URL.
 *
 * Product rows store a Storage **public URL** in `products.image_url`; base64
 * data URLs are no longer written. The image itself is always the < 100 KB
 * blob produced by `compressProductImage`.
 *
 * Bucket: `product-images` (public). See `supabase/migrations/016_product_images_storage.sql`
 * and `docs/31-product-images-storage-setup.md` for the bucket + policy setup.
 */
import { MAX_PRODUCT_IMAGE_BYTES, type CompressedImage } from "./compressProductImage";

export const PRODUCT_IMAGE_BUCKET = "product-images";

/**
 * Deterministic, human-readable storage path for a product image:
 * `org/<orgId>/products/<productId>/<timestamp>.<ext>`. The organization
 * prefix is what the storage policies authorize (migration 078: a user may
 * only write under its own organization, and never into another
 * organization's product folder). The timestamp makes each upload a fresh
 * object so replacing an image is never blocked by browser/CDN caching.
 * The business logo uses productId `"brand"`. Pure — safe to unit test.
 */
export function buildProductImagePath(orgId: string, productId: string, mimeType: string): string {
  const ext = mimeType === "image/webp" ? "webp" : "jpg";
  return `org/${orgId}/products/${productId}/${Date.now()}.${ext}`;
}

/** One non-empty storage path segment (no "/", not "." or ".."). */
const isPathSegment = (value: string): boolean =>
  value.length > 0 && !value.includes("/") && value !== "." && value !== "..";

/**
 * Upload a compressed product image to Supabase Storage and return its public
 * URL (store this in `products.image_url`).
 *
 * Throws a friendly `Error` if the image is somehow over the 100 KB cap, if no
 * product id or organization is given, or if the Storage upload fails.
 */
export async function uploadProductImage(
  productId: string,
  image: CompressedImage,
  orgId: string | null | undefined,
): Promise<string> {
  // Defensive: never upload anything above the product-image size cap.
  if (image.bytes > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("Compressed image is over the 100 KB limit and was not uploaded.");
  }
  if (!productId || !isPathSegment(productId)) {
    throw new Error("A product id is required before an image can be uploaded.");
  }
  if (!orgId || !isPathSegment(orgId)) {
    throw new Error("Your organization could not be determined. Sign in again and retry the upload.");
  }

  const path = buildProductImagePath(orgId, productId, image.mimeType);

  // Imported lazily so this module (and its pure helpers) can be unit tested
  // without constructing the Supabase client.
  const { supabase } = await import("./supabase");

  const { error } = await supabase.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .upload(path, image.blob, { contentType: image.mimeType, upsert: true });
  if (error) {
    throw new Error(`Image upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
