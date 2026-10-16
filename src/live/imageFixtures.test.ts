// The live/e2e image payloads against the phone-upload-token function's own
// byte check (083 / G5): the valid ones must pass, each negative one must
// fail for its intended reason. Hermetic (no network).
import { describe, expect, it } from "vitest";
import { checkUploadedImage, sniffImageType } from "../../supabase/functions/phone-upload-token/imageCheck.ts";
import {
  BUCKET_MAX_BYTES, COMPLETION_MAX_BYTES, HTML_DOC, JPEG_HTML_POLYGLOT, JPEG_OVER_BUCKET_LIMIT,
  JPEG_OVER_COMPLETION_LIMIT, SVG_DOC, TINY_JPEG, TINY_PNG, TINY_WEBP, jpegWithComment,
} from "./imageFixtures";

describe("live image fixtures vs imageCheck.ts", () => {
  it("valid payloads pass the completion check", () => {
    expect(checkUploadedImage(TINY_WEBP, "image/webp")).toEqual({ ok: true, type: "image/webp" });
    expect(checkUploadedImage(TINY_JPEG, "image/jpeg")).toEqual({ ok: true, type: "image/jpeg" });
    expect(checkUploadedImage(jpegWithComment({ totalBytes: COMPLETION_MAX_BYTES }), "image/jpeg")).toEqual({ ok: true, type: "image/jpeg" });
    // PNG is a real image (the bucket allows it) but not a completion type
    expect(sniffImageType(TINY_PNG)).toBe("image/png");
    expect(checkUploadedImage(TINY_PNG, "image/png", { allowedTypes: ["image/png"] })).toEqual({ ok: true, type: "image/png" });
  });

  it("padded JPEGs have the exact requested size and stay well-formed", () => {
    for (const n of [TINY_JPEG.length + 4, TINY_JPEG.length + 5, TINY_JPEG.length + 7, 70_000, 65_537 + TINY_JPEG.length + 2, COMPLETION_MAX_BYTES]) {
      const b = jpegWithComment({ totalBytes: n });
      expect(b.length).toBe(n);
      expect(b.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(b.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
      // walk the segments up to SOS: every length is consistent
      let at = 2;
      while (b[at + 1] !== 0xda) {
        expect(b[at]).toBe(0xff);
        at += 2 + b.readUInt16BE(at + 2);
      }
    }
    expect(JPEG_OVER_COMPLETION_LIMIT().length).toBe(150 * 1024);
    expect(JPEG_OVER_BUCKET_LIMIT().length).toBe(BUCKET_MAX_BYTES + 1);
  });

  it("each negative payload is refused for its reason", () => {
    expect(checkUploadedImage(HTML_DOC, "image/jpeg")).toEqual({ ok: false, reason: "magic_mismatch" });
    expect(checkUploadedImage(SVG_DOC, "image/jpeg")).toEqual({ ok: false, reason: "magic_mismatch" });
    expect(checkUploadedImage(SVG_DOC, "image/svg+xml")).toEqual({ ok: false, reason: "type_not_allowed" });
    expect(sniffImageType(JPEG_HTML_POLYGLOT)).toBe("image/jpeg");
    expect(checkUploadedImage(JPEG_HTML_POLYGLOT, "image/jpeg")).toEqual({ ok: false, reason: "active_content" });
    expect(checkUploadedImage(JPEG_OVER_COMPLETION_LIMIT(), "image/jpeg")).toEqual({ ok: false, reason: "too_large" });
    expect(checkUploadedImage(TINY_WEBP, "image/jpeg")).toEqual({ ok: false, reason: "magic_mismatch" });
    expect(checkUploadedImage(TINY_JPEG, "image/webp")).toEqual({ ok: false, reason: "magic_mismatch" });
    expect(checkUploadedImage(TINY_PNG, "image/png")).toEqual({ ok: false, reason: "type_not_allowed" });
  });
});
