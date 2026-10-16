// Release 1.0.16, task 2: the validated session flow is the ONLY desktop /
// logo upload path, it needs nothing from migration 084 (only the session
// RPC, phone-upload-token and the signed PUT that exist at 083/085), and it
// fails with a clear message when the server lacks it.
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  completeProductImageUploadSession,
  requestPhoneUploadTarget,
  PhoneUploadRefusedError,
  ValidatedUploadUnavailableError,
} from "./productImagePhoneUpload";
import { uploadProductImage } from "./productImageStorage";
import type { CompressedImage } from "./compressProductImage";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "live" || name === "test") continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("only the validated flow writes product images", () => {
  const files = sourceFiles(SRC).map((p) => ({ p, s: readFileSync(p, "utf8") }));

  it("no direct Storage write remains in app code", () => {
    const offenders = files.filter(({ s }) =>
      /\.storage\s*\.\s*from\([^)]*\)\s*\.\s*(upload|update|move|copy|createSignedUploadUrl)\s*\(/.test(s) ||
      /createSignedUploadUrl/.test(s));
    expect(offenders.map((o) => o.p)).toEqual([]);
  });

  it("the only signed-URL upload is the phone-upload-token one, and the form uses uploadProductImage", () => {
    const signed = files.filter(({ s }) => /uploadToSignedUrl\(/.test(s)).map((o) => o.p.replace(SRC, "src"));
    expect(signed).toEqual(["src/lib/productImagePhoneUpload.ts"]);
    const form = files.find(({ p }) => p.endsWith("components/forms/ProductImageInput.tsx"));
    expect(form?.s).toMatch(/uploadProductImage\(/);
  });
});

describe("a server without the validated flow fails clearly", () => {
  it("hosted: unknown function 404 {code:NOT_FOUND}", async () => {
    await expect(requestPhoneUploadTarget("t", async () => ({ status: 404, body: { code: "NOT_FOUND", message: "Requested function was not found" } })))
      .rejects.toBeInstanceOf(ValidatedUploadUnavailableError);
  });

  it("self-hosted edge runtime without the function: 500 worker boot error", async () => {
    await expect(requestPhoneUploadTarget("t", async () => ({ status: 500, body: { msg: "InvalidWorkerCreation: worker boot error" } })))
      .rejects.toThrow(/does not support validated image uploads/);
  });

  it("the function's own 404 is still an invalid link, not 'unsupported'", async () => {
    await expect(requestPhoneUploadTarget("t", async () => ({ status: 404, body: { error: "Invalid upload link.", code: "invalid" } })))
      .rejects.toBeInstanceOf(PhoneUploadRefusedError);
  });

  it("a pre-083 function that ignores action:complete is refused (no unvalidated completion)", async () => {
    await expect(completeProductImageUploadSession(
      { token: "t", storagePath: "org/o/temp/s", publicUrl: "https://x.test/storage/v1/object/public/product-images/org/o/temp/s", bytes: 1000, mimeType: "image/webp" },
      async () => ({ status: 200, body: { token: "signed", path: "org/o/temp/s", expiresAt: null } }),
    )).rejects.toBeInstanceOf(ValidatedUploadUnavailableError);
  });

  it("uploadProductImage surfaces it unchanged and cancels the session", async () => {
    const cancelSession = vi.fn(async () => undefined);
    const image: CompressedImage = { blob: { size: 1000, type: "image/webp" } as Blob, dataUrl: "", mimeType: "image/webp", bytes: 1000, width: 10, height: 10 };
    await expect(uploadProductImage("prod-1", image, { shopId: "shop-1" }, {
      createSession: async () => ({ sessionId: "pimg-1", token: "t", storagePath: "org/o/temp/pimg-1", expiresAt: null, status: "PENDING" }),
      cancelSession,
      uploadDeps: { requestTarget: async () => requestPhoneUploadTarget("t", async () => ({ status: 404, body: { code: "NOT_FOUND" } })) },
    })).rejects.toThrow(/^This server does not support validated image uploads/);
    expect(cancelSession).toHaveBeenCalledWith("pimg-1");
  });
});
