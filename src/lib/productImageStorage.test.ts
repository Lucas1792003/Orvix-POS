import { describe, it, expect, vi } from "vitest";
import {
  buildProductImagePath,
  trustedProductImageUrl,
  uploadProductImage,
  PRODUCT_IMAGE_BUCKET,
  type ProductImageUploadDeps,
} from "./productImageStorage";
import { MAX_PRODUCT_IMAGE_BYTES, type CompressedImage } from "./compressProductImage";
import { uploadPhoneProductImage, type PhoneUploadDeps } from "./productImagePhoneUpload";

// G5 follow-up: the desktop uploads through the validated session flow
// (create session -> token just in time -> signed PUT -> validating
// completion) and only ever returns the server-derived URL. Every transport is
// injected, so no Supabase client is constructed here.

const fakeImage = (over: Partial<CompressedImage> = {}): CompressedImage => ({
  blob: { size: 50 * 1024, type: "image/webp" } as Blob,
  dataUrl: "",
  mimeType: "image/webp",
  bytes: 50 * 1024,
  width: 320,
  height: 240,
  ...over,
});

const ORIGIN = "https://pos.example.test";
const SID = "pimg-0123456789abcdef0123456789abcdef";
const PATH = `org/org-a/temp/${SID}`;
const URL_OK = `${ORIGIN}/storage/v1/object/public/product-images/${PATH}`;
const session = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  token: "t".repeat(128),
  storagePath: PATH,
  expiresAt: "2099-01-01T00:00:00Z",
  status: "PENDING" as const,
  ...over,
});
const completed = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  storagePath: PATH,
  publicUrl: URL_OK,
  bytes: 51200,
  mimeType: "image/webp",
  expiresAt: "2099-01-01T00:00:00Z",
  status: "COMPLETED" as const,
  ...over,
});

const depsWith = (over: Partial<ProductImageUploadDeps> = {}) => {
  const createSession = vi.fn(async () => session());
  const upload = vi.fn(async () => completed());
  const cancelSession = vi.fn(async () => undefined);
  return { createSession, upload, cancelSession, ...over } as Required<Pick<ProductImageUploadDeps, "createSession" | "upload" | "cancelSession">> & ProductImageUploadDeps;
};

describe("buildProductImagePath (legacy layout, no longer written)", () => {
  it("keeps the org-prefixed products/ layout for existing objects", () => {
    expect(buildProductImagePath("org-a", "prod-1", "image/webp")).toMatch(/^org\/org-a\/products\/prod-1\/\d+\.webp$/);
    expect(buildProductImagePath("org-a", "brand", "image/jpeg")).toMatch(/^org\/org-a\/products\/brand\/\d+\.jpg$/);
  });
});

describe("uploadProductImage: input guards (before any server call)", () => {
  it("exposes the bucket name", () => {
    expect(PRODUCT_IMAGE_BUCKET).toBe("product-images");
  });

  it("rejects an image over the 100 KB cap before uploading", async () => {
    const d = depsWith();
    await expect(uploadProductImage("prod-1", fakeImage({ bytes: MAX_PRODUCT_IMAGE_BYTES + 1 }), {}, d)).rejects.toThrowError(/100 KB/);
    expect(d.createSession).not.toHaveBeenCalled();
  });

  it("accepts an image exactly at the 100 KB cap (guard is inclusive)", async () => {
    const d = depsWith();
    await expect(uploadProductImage("prod-1", fakeImage({ bytes: MAX_PRODUCT_IMAGE_BYTES }), {}, d)).resolves.toBe(URL_OK);
  });

  it("rejects a missing or multi-segment product id", async () => {
    const d = depsWith();
    for (const id of ["", "a/b", "..", "."]) {
      await expect(uploadProductImage(id, fakeImage(), {}, d)).rejects.toThrowError(/product id/);
    }
    expect(d.createSession).not.toHaveBeenCalled();
  });
});

describe("uploadProductImage: validated session flow", () => {
  it("creates a session for the product and shop, uploads with the session token, returns the server-derived URL", async () => {
    const d = depsWith();
    const img = fakeImage();
    await expect(uploadProductImage("prod-1", img, { shopId: "shop-a" }, d)).resolves.toBe(URL_OK);
    expect(d.createSession).toHaveBeenCalledWith({ productId: "prod-1", shopId: "shop-a" });
    expect(d.upload).toHaveBeenCalledTimes(1);
    const [token, image, opts] = d.upload.mock.calls[0] as unknown as [string, CompressedImage, PhoneUploadDeps];
    expect(token).toBe(session().token);
    expect(image).toBe(img);
    expect(opts.sessionExpiresAt).toBe(session().expiresAt);
    expect(d.cancelSession).not.toHaveBeenCalled();
  });

  it("works for the business logo (productId \"brand\", no shop)", async () => {
    const d = depsWith();
    await expect(uploadProductImage("brand", fakeImage(), {}, d)).resolves.toBe(URL_OK);
    expect(d.createSession).toHaveBeenCalledWith({ productId: "brand", shopId: null });
  });

  it("never sends an organization or a path: the session path comes from the server", async () => {
    const d = depsWith();
    await uploadProductImage("prod-1", fakeImage(), { shopId: null }, d);
    const arg = (d.createSession.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["productId", "shopId"]);
  });

  it("refuses a server path that is not a session path, and cancels the session", async () => {
    const d = depsWith({ createSession: vi.fn(async () => session({ storagePath: "org/org-a/products/prod-1/1.webp" })) });
    await expect(uploadProductImage("prod-1", fakeImage(), {}, d)).rejects.toThrowError(/unexpected upload path/);
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.cancelSession).toHaveBeenCalledWith(SID);
  });

  it("a server refusal of the bytes (422 invalid_image) is reported and the session is cancelled", async () => {
    const d = depsWith({
      upload: vi.fn(async () => {
        throw new Error("The uploaded file is not a valid JPEG or WebP photo under 100 KB. Please choose another photo.");
      }),
    });
    await expect(uploadProductImage("prod-1", fakeImage(), {}, d)).rejects.toThrowError(/Image upload failed: The uploaded file is not a valid JPEG or WebP/);
    expect(d.cancelSession).toHaveBeenCalledWith(SID);
  });

  it("a failed cancel does not hide the original error", async () => {
    const d = depsWith({
      upload: vi.fn(async () => { throw new Error("Image upload failed: network"); }),
      cancelSession: vi.fn(async () => { throw new Error("offline"); }),
    });
    await expect(uploadProductImage("prod-1", fakeImage(), {}, d)).rejects.toThrowError("Image upload failed: network");
  });

  it("session creation errors (permission, rate limit) surface unchanged and nothing is uploaded", async () => {
    const d = depsWith({ createSession: vi.fn(async () => { throw new Error("You are not permitted to upload product images"); }) });
    await expect(uploadProductImage("prod-1", fakeImage(), {}, d)).rejects.toThrowError(/not permitted/);
    expect(d.upload).not.toHaveBeenCalled();
  });

  for (const [label, over, re] of [
    ["not COMPLETED", { status: "PENDING" }, /not completed/],
    ["another session path", { storagePath: "org/org-a/temp/pimg-other" }, /different upload/],
    ["no URL (server not configured)", { publicUrl: undefined }, /not configured/],
    ["a URL with another object path", { publicUrl: `${ORIGIN}/storage/v1/object/public/product-images/org/org-b/temp/x` }, /another object/],
    ["a URL with a query string", { publicUrl: `${URL_OK}?x=1` }, /another object/],
    ["a URL with a fragment", { publicUrl: `${URL_OK}#x` }, /another object/],
    ["a URL with credentials", { publicUrl: URL_OK.replace("https://", "https://u:p@") }, /another object/],
    ["a data: URL", { publicUrl: "data:image/webp;base64,AAAA" }, /another object/],
    ["a javascript: URL", { publicUrl: "javascript:alert(1)//" }, /another object|invalid/],
    ["a relative URL", { publicUrl: `/storage/v1/object/public/product-images/${PATH}` }, /invalid/],
  ] as const) {
    it(`refuses a completion answer with ${label}`, async () => {
      const d = depsWith({ upload: vi.fn(async () => completed(over as Record<string, unknown>)) });
      await expect(uploadProductImage("prod-1", fakeImage(), {}, d)).rejects.toThrowError(re);
    });
  }

  it("trustedProductImageUrl accepts http for a local stack and keeps the server's origin", () => {
    const local = `http://127.0.0.1:54321/storage/v1/object/public/product-images/${PATH}`;
    expect(trustedProductImageUrl({ status: "COMPLETED", storagePath: PATH, publicUrl: local }, PATH)).toBe(local);
  });
});

describe("uploadProductImage end to end with the real uploadPhoneProductImage (transports mocked)", () => {
  it("token -> PUT to the server's path -> function completion; the URL comes from the completion answer", async () => {
    const calls: string[] = [];
    const uploadDeps: PhoneUploadDeps = {
      requestTarget: async () => { calls.push("token"); return { kind: "upload", storagePath: PATH, uploadToken: "jwt", expiresAt: null }; },
      uploadToSignedUrl: async (p, t) => { calls.push(`put ${p} ${t}`); return { error: null }; },
      publicUrl: async (p) => `https://client.example/storage/v1/object/public/product-images/${p}`,
      complete: async (input) => { calls.push(`complete ${input.storagePath}`); return completed(); },
      readSession: async () => { throw new Error("not called"); },
    };
    const d: ProductImageUploadDeps = { createSession: async () => session(), cancelSession: async () => undefined, upload: uploadPhoneProductImage, uploadDeps };
    await expect(uploadProductImage("prod-1", fakeImage(), {}, d)).resolves.toBe(URL_OK);
    expect(calls).toEqual(["token", `put ${PATH} jwt`, `complete ${PATH}`]);
  });

  it("the client's own getPublicUrl is never what the form receives", async () => {
    const uploadDeps: PhoneUploadDeps = {
      requestTarget: async () => ({ kind: "upload", storagePath: PATH, uploadToken: "jwt", expiresAt: null }),
      uploadToSignedUrl: async () => ({ error: null }),
      publicUrl: async (p) => `https://client.example/storage/v1/object/public/product-images/${p}`,
      complete: async () => completed({ publicUrl: `${ORIGIN}/storage/v1/object/public/product-images/${PATH}` }),
    };
    const url = await uploadProductImage("prod-1", fakeImage(), {}, { createSession: async () => session(), cancelSession: async () => undefined, uploadDeps });
    expect(url.startsWith(ORIGIN)).toBe(true);
  });
});
