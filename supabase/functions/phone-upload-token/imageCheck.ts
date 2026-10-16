// Server-side content check of an uploaded product image (G5, migration 083;
// docs/selfhost-migration/phase-f/migration-083-g5.md §3).
//
// storage-api only compares the DECLARED Content-Type with the bucket's
// allowed_mime_types. This module looks at the BYTES. Pure and dependency
// free (also imported by the hermetic tests).
//
// An object passes only if ALL hold:
//   1. declared type is one of the completion types: image/jpeg, image/png,
//      image/webp - the same list as the bucket (083) and, from migration 085,
//      complete_product_image_upload_session. (Both clients re-encode photos
//      to WebP/JPEG, so PNG reaches this check only from other uploaders. On
//      a database before 085 the RPC still refuses PNG; the function then
//      deletes the object, index.ts discardRefusedObject.)
//   2. 1 <= size <= maxBytes (the clients' 100 KB cap);
//   3. the magic number matches the declared type
//        JPEG  FF D8 FF
//        PNG   89 50 4E 47 0D 0A 1A 0A, then the IHDR chunk
//        WebP  "RIFF" <le32 size> "WEBP" + a VP8 / VP8L / VP8X chunk, and the
//              RIFF size equals the object size - 8 (no trailing payload);
//   4. no HTML / SVG / XML markup start anywhere in the bytes (a valid JPEG
//      header followed by an HTML document is refused). The clients' images
//      come from <canvas>.toBlob(): no EXIF/XMP text, so a legitimate upload
//      matching one of these case-insensitive markers is ~1e-5 per 100 KB of
//      random-looking data (each marker is >= 5 bytes; see the doc).

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

export const COMPLETION_TYPES: readonly ImageType[] = ["image/jpeg", "image/png", "image/webp"];
export const MAX_COMPLETION_BYTES = 100 * 1024; // = the 080 RPC and both clients

export type ImageCheck =
  | { ok: true; type: ImageType }
  | { ok: false; reason: "type_not_allowed" | "empty" | "too_large" | "magic_mismatch" | "malformed" | "active_content" };

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** The type the bytes actually are (by magic number), or null. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

// Tag / document starts that make a browser (or a sniffing one) treat bytes as
// markup. Lower-case ASCII; matched case-insensitively. "<svg" is only counted
// when followed by whitespace, '>' or '/', keeping every marker >= 5 bytes.
const MARKERS = [
  "<script", "<html", "<!doctype", "<?xml", "<iframe", "<object", "<embed",
  "<body", "<head", "<meta", "<style", "<form", "<link", "javascript:",
].map(ascii);
const SVG = ascii("<svg");

const lower = (c: number) => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);

/** True if the bytes contain a markup start anywhere (case-insensitive). */
export function containsActiveContent(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) {
    const c = lower(b[i]);
    if (c !== 0x3c /* < */ && c !== 0x6a /* j */) continue;
    for (const m of MARKERS) {
      if (i + m.length > b.length || m[0] !== c) continue;
      let hit = true;
      for (let k = 1; k < m.length; k++) {
        if (lower(b[i + k]) !== m[k]) { hit = false; break; }
      }
      if (hit) return true;
    }
    if (c === 0x3c && i + 4 < b.length && SVG.every((v, k) => lower(b[i + k]) === v)) {
      const n = b[i + 4];
      if (n === 0x20 || n === 0x09 || n === 0x0a || n === 0x0d || n === 0x0c || n === 0x3e || n === 0x2f) return true;
    }
  }
  return false;
}

const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** Container sanity beyond the first bytes (cheap, no decoding). */
function wellFormed(b: Uint8Array, type: ImageType): boolean {
  switch (type) {
    case "image/jpeg":
      // SOI then a marker segment (FF xx), and at least an EOI-sized tail
      return b.length >= 4 && b[3] !== 0x00;
    case "image/png":
      return b.length >= 33 && startsWith(b, ascii("IHDR"), 12);
    case "image/webp": {
      if (b.length < 20) return false;
      if (le32(b, 4) + 8 !== b.length) return false;
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      return chunk === "VP8 " || chunk === "VP8L" || chunk === "VP8X";
    }
  }
}

/** Normalise a Content-Type header value: "image/JPEG; charset=x" -> "image/jpeg". */
export const normaliseContentType = (v: string | null | undefined) =>
  String(v ?? "").split(";")[0].trim().toLowerCase();

/**
 * Validate an uploaded object for phone-upload completion.
 * `declared` is the type storage-api stored and serves (its Content-Type).
 */
export function checkUploadedImage(
  bytes: Uint8Array,
  declared: string,
  opts: { maxBytes?: number; allowedTypes?: readonly ImageType[] } = {},
): ImageCheck {
  const maxBytes = opts.maxBytes ?? MAX_COMPLETION_BYTES;
  const allowed = opts.allowedTypes ?? COMPLETION_TYPES;
  const type = normaliseContentType(declared) as ImageType;
  if (!allowed.includes(type)) return { ok: false, reason: "type_not_allowed" };
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > maxBytes) return { ok: false, reason: "too_large" };
  if (sniffImageType(bytes) !== type) return { ok: false, reason: "magic_mismatch" };
  if (!wellFormed(bytes, type)) return { ok: false, reason: "malformed" };
  if (containsActiveContent(bytes)) return { ok: false, reason: "active_content" };
  return { ok: true, type };
}
