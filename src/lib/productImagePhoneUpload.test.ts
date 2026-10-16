import { describe, expect, it } from "vitest";
import { MAX_PRODUCT_IMAGE_BYTES } from "./compressProductImage";
import {
  buildProductImagePhoneUploadQrUrl,
  assertCompressedPhoneUpload,
  completeProductImageUploadSession,
} from "./productImagePhoneUpload";

describe("product image phone upload helpers", () => {
  it("builds a phone upload QR URL with the session token in the route", () => {
    const url = buildProductImagePhoneUploadQrUrl("https://retail.example", "session-token");
    expect(url).toBe(
      "https://retail.example/phone-upload/product-image/session-token",
    );
  });

  it("does not expose the signed upload token in the QR URL", () => {
    const url = buildProductImagePhoneUploadQrUrl("https://retail.example", "session-token");
    expect(url).not.toContain("uploadToken");
    expect(url).not.toContain("#");
  });

  it("rejects base64 public URLs", () => {
    expect(() => assertCompressedPhoneUpload(90 * 1024, "data:image/webp;base64,abc")).toThrowError(
      /Storage URL/,
    );
  });

  it("enforces the 100 KB compressed image limit", () => {
    expect(() =>
      assertCompressedPhoneUpload(MAX_PRODUCT_IMAGE_BYTES + 1, "https://example.com/image.webp"),
    ).toThrowError(/100 KB/);
    expect(() =>
      assertCompressedPhoneUpload(MAX_PRODUCT_IMAGE_BYTES, "https://example.com/image.webp"),
    ).not.toThrow();
  });
});

// 083 (G5): the React phone page completes through phone-upload-token
// {action:"complete"} (server-side byte check), never the RPC directly.
describe("completeProductImageUploadSession (083)", () => {
  const PATH = "org/org-a/temp/pimg-1";
  const input = { token: "t".repeat(64), storagePath: PATH, publicUrl: `https://api.example/storage/v1/object/public/product-images/${PATH}`, bytes: 2048, mimeType: "image/webp" };
  const completed = { sessionId: "pimg-1", storagePath: PATH, status: "COMPLETED", publicUrl: `https://api.example/storage/v1/object/public/product-images/${PATH}`, bytes: 2048, mimeType: "image/webp", expiresAt: "2026-10-16T00:10:00Z" };

  it("sends only the session token to the function and returns the server's answer", async () => {
    const seen: string[] = [];
    const r = await completeProductImageUploadSession(input, async (token) => {
      seen.push(token);
      return { status: 200, body: completed };
    });
    expect(seen).toEqual([input.token]);
    expect(r).toEqual(completed);
  });

  it("422 invalid_image -> the server's message", async () => {
    await expect(
      completeProductImageUploadSession(input, async () => ({
        status: 422,
        body: { error: "The uploaded file is not a valid JPEG or WebP photo under 100 KB. Please choose another photo.", code: "invalid_image" },
      })),
    ).rejects.toThrow(/not a valid JPEG or WebP/);
  });

  it("410 inactive -> PhoneUploadInactiveError with the status", async () => {
    await expect(completeProductImageUploadSession(input, async () => ({ status: 410, body: { code: "inactive", status: "CANCELED" } })))
      .rejects.toMatchObject({ name: "PhoneUploadInactiveError", status: "CANCELED" });
  });

  it("a 200 for another path, or not COMPLETED, is not accepted", async () => {
    await expect(completeProductImageUploadSession(input, async () => ({ status: 200, body: { ...completed, storagePath: "org/org-a/temp/other" } }))).rejects.toThrow();
    await expect(completeProductImageUploadSession(input, async () => ({ status: 200, body: { ...completed, status: "PENDING" } }))).rejects.toThrow();
  });

  it("still refuses an over-limit image locally, before calling the server", async () => {
    let called = false;
    await expect(
      completeProductImageUploadSession({ ...input, bytes: MAX_PRODUCT_IMAGE_BYTES + 1 }, async () => {
        called = true;
        return { status: 200, body: completed };
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
