// imageCheck.ts (phone-upload-token, 083 / G5) - pure byte checks.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkUploadedImage, COMPLETION_TYPES, containsActiveContent, sniffImageType } from "../../functions/phone-upload-token/imageCheck.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...p: (number[] | Uint8Array | string)[]) => {
  const c = p.map((x) => (typeof x === "string" ? enc(x) : x instanceof Uint8Array ? x : new Uint8Array(x)));
  const o = new Uint8Array(c.reduce((n, x) => n + x.length, 0));
  let a = 0;
  for (const x of c) {
    o.set(x, a);
    a += x.length;
  }
  return o;
};
const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

// deterministic xorshift PRNG: "compressed-looking" bytes
const rng = (seed: number) => () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) & 255;
};

Deno.test("imageCheck: sniffs JPEG / PNG / WebP by magic number only", () => {
  assertEquals(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb])), "image/jpeg");
  assertEquals(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assertEquals(sniffImageType(cat("RIFF", le32(4), "WEBP")), "image/webp");
  assertEquals(sniffImageType(cat("RIFF", le32(4), "WAVE")), null);
  assertEquals(sniffImageType(enc("GIF89a")), null);
  assertEquals(sniffImageType(enc("<svg")), null);
});

Deno.test("imageCheck: markup markers are found case-insensitively anywhere; <svg only as a tag", () => {
  for (
    const m of ["<script", "<HTML", "<!DocType", "<?xml", "<iframe", "<object", "<embed", "<Body", "<head", "<meta", "<style", "<form", "<link", "JavaScript:", "<svg ", "<svg>", "<SVG/"]
  ) {
    assert(containsActiveContent(cat([0xff, 0xd8, 0xff, 1, 2, 3], m, [9, 9])), m);
  }
  assert(!containsActiveContent(cat([0xff, 0xd8, 0xff], "<svgX <scrip <htm")), "partial markers are not markup");
});

Deno.test("imageCheck: 2,000 pseudo-random 100 KB bodies -> no false positive", () => {
  const next = rng(0x5eed1234);
  let flagged = 0;
  for (let i = 0; i < 2000; i++) {
    const body = new Uint8Array(100 * 1024 - 32);
    for (let k = 0; k < body.length; k++) body[k] = next();
    if (containsActiveContent(body)) flagged++;
  }
  assertEquals(flagged, 0);
});

Deno.test("imageCheck: verdicts", () => {
  const jpeg = cat([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(100).fill(7), [0xff, 0xd9]);
  const webp = cat("RIFF", le32(4 + 8 + 50), "WEBP", "VP8L", le32(50), new Uint8Array(50).fill(3));
  assertEquals(checkUploadedImage(jpeg, "image/jpeg"), { ok: true, type: "image/jpeg" });
  assertEquals(checkUploadedImage(jpeg, "IMAGE/JPEG; charset=binary"), { ok: true, type: "image/jpeg" });
  assertEquals(checkUploadedImage(webp, "image/webp"), { ok: true, type: "image/webp" });
  assertEquals(checkUploadedImage(jpeg, "image/png").ok, false);
  assertEquals(checkUploadedImage(jpeg, "image/webp"), { ok: false, reason: "magic_mismatch" });
  assertEquals(checkUploadedImage(webp, "image/jpeg"), { ok: false, reason: "magic_mismatch" });
  assertEquals(checkUploadedImage(cat(webp, [0]), "image/webp"), { ok: false, reason: "malformed" });
  assertEquals(checkUploadedImage(cat("RIFF", le32(12), "WEBP", "ABCD", le32(0)), "image/webp"), { ok: false, reason: "malformed" });
  assertEquals(checkUploadedImage(new Uint8Array(0), "image/jpeg"), { ok: false, reason: "empty" });
  assertEquals(checkUploadedImage(new Uint8Array(102401).fill(0xff), "image/jpeg"), { ok: false, reason: "too_large" });
  assertEquals(checkUploadedImage(jpeg, "text/html"), { ok: false, reason: "type_not_allowed" });
  assertEquals(checkUploadedImage(jpeg, ""), { ok: false, reason: "type_not_allowed" });
  assertEquals(checkUploadedImage(cat([0xff, 0xd8, 0xff, 0xe0], "<html>"), "image/jpeg"), { ok: false, reason: "active_content" });
  // 085: PNG completes like JPEG / WebP (same list as the bucket and the RPC)
  const png = cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR", new Uint8Array(30));
  assertEquals(checkUploadedImage(png, "image/png"), { ok: true, type: "image/png" });
  assertEquals(checkUploadedImage(png, "image/png", { allowedTypes: ["image/jpeg"] }), { ok: false, reason: "type_not_allowed" });
  assertEquals(checkUploadedImage(png, "image/jpeg"), { ok: false, reason: "magic_mismatch" });
  assertEquals(checkUploadedImage(cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new Uint8Array(40)), "image/png"), { ok: false, reason: "malformed" });
  assertEquals(checkUploadedImage(cat(png, "<svg onload=x>"), "image/png"), { ok: false, reason: "active_content" });
  assertEquals(checkUploadedImage(cat(png, new Uint8Array(102400)), "image/png"), { ok: false, reason: "too_large" });
});

Deno.test("imageCheck 085: the completion types are exactly JPEG, PNG, WebP (= bucket allowed_mime_types of 083 = the 085 RPC)", () => {
  assertEquals([...COMPLETION_TYPES].sort(), ["image/jpeg", "image/png", "image/webp"]);
});
