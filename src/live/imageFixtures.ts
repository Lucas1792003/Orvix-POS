/// <reference types="node" />
// Image payloads for the live suites and e2e spec D (migration 083 / G5,
// docs/selfhost-migration/phase-f/migration-083-g5.md).
//
// From 083 the phone's completion goes through phone-upload-token
// {action:"complete"}, which reads the stored object back and refuses
// anything that is not a real JPEG/WebP of at most 100 KB without markup
// (supabase/functions/phone-upload-token/imageCheck.ts). The VALID payloads
// here pass that check (proven by imageFixtures.test.ts against the
// function's own module); the NEGATIVE ones each fail it, or the bucket's
// declared-type / 5 MiB limit, for one specific reason.
//
// Node-only (Buffer); no dependencies. Nothing here is secret.

/** 34-byte lossless 1x1 WebP (RIFF size + 8 == length, VP8L chunk). */
export const TINY_WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

/** 8x8 baseline JPEG (macOS sips, quality 60; JFIF + EXIF + APP13, no text markup). */
export const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQAAf/aAAwDAQACEQMRAD8A2vDtr93iu0+y+1c34d/hrtK1xuRYL2r9w4OG6sv7Pgf/2Q==",
  "base64",
);

/** 8x8 RGB PNG (zlib-deflated IDAT, valid CRCs). The bucket accepts PNG; phone completion does not. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAfElEQVR42g3JIQFEIRQAsAvxa9AAjaYBhhAvBIYG02gaYIh1zO73yUkucpNDnvKSj/z71KQWtamhTnWpR33Rk170poc+9aUf/UUkUUQTIaZY4ogXIxnFaEYY01jGMV5IFBrBZHF4sZNd7GaHPe1lH/vFTW5xmxvudJd73D/cBWNhI0fX4AAAAABJRU5ErkJggg==",
  "base64",
);

/** The phone completion limit (= imageCheck MAX_COMPLETION_BYTES, the 080 RPC and both clients). */
export const COMPLETION_MAX_BYTES = 100 * 1024;
/** The bucket limit set by 083 (storage.buckets.file_size_limit). */
export const BUCKET_MAX_BYTES = 5 * 1024 * 1024;

/**
 * TINY_JPEG with JPEG COM segments inserted right after the JFIF APP0
 * segment: still a decodable JPEG with the same pixels. `payload` (default:
 * zero bytes) fills the comment(s); the result is exactly `totalBytes` long
 * when given, otherwise TINY_JPEG + one COM carrying `payload`.
 */
export function jpegWithComment(opts: { payload?: Buffer; totalBytes?: number } = {}): Buffer {
  const app0End = 4 + TINY_JPEG.readUInt16BE(4); // SOI(2) + FFE0(2) + length (includes itself)
  const head = TINY_JPEG.subarray(0, app0End);
  const tail = TINY_JPEG.subarray(app0End);
  const segment = (data: Buffer) => {
    const len = Buffer.alloc(4);
    len[0] = 0xff; len[1] = 0xfe;
    len.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([len, data]);
  };
  if (opts.totalBytes === undefined) return Buffer.concat([head, segment(opts.payload ?? Buffer.alloc(16)), tail]);
  let need = opts.totalBytes - TINY_JPEG.length;
  if (need < 4) throw new Error(`jpegWithComment: totalBytes must be >= ${TINY_JPEG.length + 4}`);
  const parts: Buffer[] = [];
  const MAX_DATA = 0xffff - 2;
  while (need > 0) {
    // every segment costs 4 header bytes; never leave a remainder smaller than one header
    let data = Math.min(MAX_DATA, need - 4);
    if (need - 4 - data > 0 && need - 4 - data < 4) data -= 4;
    parts.push(segment(Buffer.alloc(data)));
    need -= data + 4;
  }
  return Buffer.concat([head, ...parts, tail]);
}

// ---- negative payloads (each refused for one reason) -----------------------

/** A plain HTML document (what a ".jpg" named file with HTML inside carries). */
export const HTML_DOC = Buffer.from("<!doctype html><html><head><title>qa-g5</title></head><body><script>document.title='qa-g5-ran'</script></body></html>\n");

/** An SVG document with script. */
export const SVG_DOC = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><script>document.title='qa-g5-ran'</script><rect width=\"8\" height=\"8\"/></svg>\n");

/** JPEG-header + HTML polyglot: a valid, decodable JPEG whose COM segment carries an HTML document. */
export const JPEG_HTML_POLYGLOT = jpegWithComment({ payload: Buffer.from("<html><body><script>document.title='qa-g5-ran'</script></body></html>") });

/** A real JPEG over the completion limit but far under the bucket's 5 MiB (refused at completion: too_large). */
export const JPEG_OVER_COMPLETION_LIMIT = (): Buffer => jpegWithComment({ totalBytes: 150 * 1024 });

/** A real JPEG one byte over the bucket limit (refused by storage). */
export const JPEG_OVER_BUCKET_LIMIT = (): Buffer => jpegWithComment({ totalBytes: BUCKET_MAX_BYTES + 1 });
