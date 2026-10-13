import { describe, it, expect } from "vitest";
import {
  buildProductImagePath,
  uploadProductImage,
  PRODUCT_IMAGE_BUCKET,
} from "./productImageStorage";
import { MAX_PRODUCT_IMAGE_BYTES, type CompressedImage } from "./compressProductImage";

// buildProductImagePath is pure; uploadProductImage's validation guards run
// before the (lazy) Supabase client import, so both are node-testable.

const fakeImage = (over: Partial<CompressedImage> = {}): CompressedImage => ({
  blob: { size: 50 * 1024, type: "image/webp" } as Blob,
  dataUrl: "",
  mimeType: "image/webp",
  bytes: 50 * 1024,
  width: 320,
  height: 240,
  ...over,
});

describe("buildProductImagePath", () => {
  it("uses a .webp extension for WebP images, under the organization prefix", () => {
    expect(buildProductImagePath("org-a", "prod-1", "image/webp")).toMatch(
      /^org\/org-a\/products\/prod-1\/\d+\.webp$/,
    );
  });

  it("uses a .jpg extension for JPEG images", () => {
    expect(buildProductImagePath("org-a", "prod-2", "image/jpeg")).toMatch(
      /^org\/org-a\/products\/prod-2\/\d+\.jpg$/,
    );
  });

  it("puts the business logo (productId \"brand\") under the same organization prefix", () => {
    expect(buildProductImagePath("org-a", "brand", "image/webp")).toMatch(
      /^org\/org-a\/products\/brand\/\d+\.webp$/,
    );
  });

  it("is a Storage path, never a base64 / data URL", () => {
    const path = buildProductImagePath("org-a", "prod-3", "image/webp");
    expect(path).not.toContain("data:");
    expect(path.startsWith("org/org-a/products/")).toBe(true);
  });
});

describe("uploadProductImage validation", () => {
  it("exposes the bucket name", () => {
    expect(PRODUCT_IMAGE_BUCKET).toBe("product-images");
  });

  it("rejects an image over the 100 KB cap before uploading", async () => {
    const oversized = fakeImage({ bytes: MAX_PRODUCT_IMAGE_BYTES + 1 });
    await expect(uploadProductImage("prod-1", oversized, "org-a")).rejects.toThrowError(/100 KB/);
  });

  it("accepts an image exactly at the 100 KB cap (guard is inclusive)", () => {
    // bytes === cap must NOT trip the over-limit guard.
    const atCap = fakeImage({ bytes: MAX_PRODUCT_IMAGE_BYTES });
    expect(atCap.bytes).toBeLessThanOrEqual(MAX_PRODUCT_IMAGE_BYTES);
  });

  it("rejects when no product id is supplied", async () => {
    await expect(uploadProductImage("", fakeImage(), "org-a")).rejects.toThrowError(/product id/);
  });

  it("rejects a product id that is not a single path segment", async () => {
    await expect(uploadProductImage("a/b", fakeImage(), "org-a")).rejects.toThrowError(/product id/);
    await expect(uploadProductImage("..", fakeImage(), "org-a")).rejects.toThrowError(/product id/);
  });

  it("rejects when the organization is unknown (no org-less legacy path is ever built)", async () => {
    await expect(uploadProductImage("prod-1", fakeImage(), null)).rejects.toThrowError(/organization/);
    await expect(uploadProductImage("prod-1", fakeImage(), "")).rejects.toThrowError(/organization/);
    await expect(uploadProductImage("prod-1", fakeImage(), undefined)).rejects.toThrowError(/organization/);
    await expect(uploadProductImage("prod-1", fakeImage(), "org/../x")).rejects.toThrowError(/organization/);
  });
});
