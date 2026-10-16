// Area "storage": org A cannot list, read (authenticated), overwrite, delete,
// move or sign org B's objects (org/<B>/..., legacy temp/ and products/ paths,
// brand logo). Public-bucket reads are documented as public by design.
import type { World, Org } from "./seed";
import { capture, check, gap, http, record, sql, q, MAX_MIG, SERVICE } from "./lib";

const jpeg = () => Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.from(Array(48).fill(1)), Buffer.from("ffd9", "hex")]);

async function listPrefix(token: string, prefix: string) {
  return http("POST", "/storage/v1/object/list/product-images", { token, body: { prefix, limit: 100 } });
}

export async function storageSuite(w: World) {
  const admin = w.adminA2, mgr = w.A.people.mgr.token;
  const B = w.B, A = w.A;
  const cov = ["storage-policy:product_images_read", "storage-policy:product_images_insert", "storage-policy:product_images_update", "storage-policy:product_images_delete"];
  const bPaths = {
    org: B.objects.orgProduct, legacyProduct: B.objects.legacyProduct, legacyTemp: B.objects.legacyTemp, brand: B.objects.brandLogo, brandOld: B.objects.brandOld,
  };

  // list: A listing B's org prefix returns nothing of B
  for (const [role, token] of [["admin", admin], ["manager", mgr]] as const) {
    const l = await listPrefix(token, `org/${B.id}/`);
    capture(`storage list ${role} B prefix`, l.text);
    const names = Array.isArray(l.json) ? l.json.map((o: any) => o.name) : [];
    check("storage", `${role} A cannot list B's org objects`, l.status < 300 && names.length === 0, ["storage-policy:product_images_read"],
      `status ${l.status}, ${names.length} entries`);
  }

  // Reading the BYTES of a known object path in a PUBLIC bucket is public by
  // design (same as a <img src> public URL); isolation for a public bucket is
  // enforced on listing (above), writing, deleting, moving and signing (below),
  // not on byte reads of an already-known path. Documented, not asserted as a leak.
  {
    const r = await http("GET", `/storage/v1/object/authenticated/product-images/${bPaths.org.split("/").map(encodeURIComponent).join("/")}`, { token: admin });
    record("storage", `object byte-read of a known path in the public bucket is public by design (status ${r.status})`, "INFO", ["storage-policy:product_images_read"],
      "see audit doc §storage: enumeration is blocked; byte reads of a known path are public, like the product-images public URLs");
  }

  // overwrite B's object (upsert) -> refused; object bytes unchanged
  const beforeDigest = sql(`SELECT md5(coalesce(string_agg(name,'|' ORDER BY name),'')) FROM storage.objects WHERE bucket_id='product-images' AND name LIKE ${q(`org/${B.id}/%`)} OR name=${q(bPaths.legacyTemp)}`);
  for (const [label, path] of Object.entries(bPaths)) {
    const r = await http("POST", `/storage/v1/object/product-images/${path.split("/").map(encodeURIComponent).join("/")}`,
      { token: admin, raw: jpeg(), headers: { "Content-Type": "image/jpeg", "x-upsert": "true" } });
    capture(`storage overwrite B ${label}`, r.text);
    check("storage", `admin A cannot overwrite B's ${label} object`, r.status >= 300, ["storage-policy:product_images_update", "storage-policy:product_images_insert"], `status ${r.status}`);
  }
  // delete B's object -> refused; object still present
  for (const [label, path] of Object.entries(bPaths)) {
    const r = await http("DELETE", `/storage/v1/object/product-images/${path.split("/").map(encodeURIComponent).join("/")}`, { token: admin });
    capture(`storage delete B ${label}`, r.text);
    const present = sql(`SELECT count(*) FROM storage.objects WHERE bucket_id='product-images' AND name=${q(path)}`) === "1";
    check("storage", `admin A cannot delete B's ${label} object`, present, ["storage-policy:product_images_delete"], `status ${r.status} present ${present}`);
  }
  // create an object under B's org prefix (new path) -> refused
  const evil = `org/${B.id}/products/${B.products[0]}/evil-${A.can}.jpg`;
  const ins = await http("POST", `/storage/v1/object/product-images/${evil.split("/").map(encodeURIComponent).join("/")}`,
    { token: admin, raw: jpeg(), headers: { "Content-Type": "image/jpeg" } });
  capture("storage insert into B prefix", ins.text);
  const created = sql(`SELECT count(*) FROM storage.objects WHERE bucket_id='product-images' AND name=${q(evil)}`) === "1";
  if (created) sql(`DELETE FROM storage.objects WHERE bucket_id='product-images' AND name=${q(evil)}`);
  check("storage", "admin A cannot create an object under B's org prefix", !created, ["storage-policy:product_images_insert"], `status ${ins.status}`);
  // move B's object into A's prefix -> refused
  const mv = await http("POST", "/storage/v1/object/move", { token: admin,
    body: { bucketId: "product-images", sourceKey: bPaths.org, destinationKey: `org/${A.id}/products/${A.products[0]}/stolen.jpg` } });
  capture("storage move B->A", mv.text);
  check("storage", "admin A cannot move B's object into its own prefix", mv.status >= 300, ["storage-policy:product_images_update"], `status ${mv.status}`);

  const afterDigest = sql(`SELECT md5(coalesce(string_agg(name,'|' ORDER BY name),'')) FROM storage.objects WHERE bucket_id='product-images' AND name LIKE ${q(`org/${B.id}/%`)} OR name=${q(bPaths.legacyTemp)}`);
  check("storage", "B's object set unchanged by A's write attempts", beforeDigest === afterDigest, cov, "");

  // signed URL for B's path -> refused
  const sign = await http("POST", `/storage/v1/object/sign/product-images/${bPaths.org.split("/").map(encodeURIComponent).join("/")}`, { token: admin, body: { expiresIn: 60 } });
  capture("storage sign B path", sign.text);
  check("storage", "admin A cannot create a signed URL for B's path", sign.status >= 300, ["storage-policy:product_images_read"], `status ${sign.status}`);

  // a signed URL for A's path cannot be reused for B's path (token names the path)
  const signA = await http("POST", `/storage/v1/object/sign/product-images/${A.objects.orgProduct.split("/").map(encodeURIComponent).join("/")}`, { token: admin, body: { expiresIn: 60 } });
  check("storage", "positive: admin A can sign its OWN path", signA.status < 300 && typeof signA.json?.signedURL === "string", ["storage-policy:product_images_read"], `status ${signA.status}`);
  if (signA.status < 300 && signA.json?.signedURL) {
    const tokenParam = new URL(signA.json.signedURL, "http://127.0.0.1").searchParams.get("token") ?? "";
    const swap = await http("GET", `/storage/v1/object/sign/product-images/${bPaths.org.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(tokenParam)}`, { token: null });
    capture("storage signed-url swap", swap.text);
    check("storage", "A's signed URL token cannot be reused for B's path", swap.status >= 300, ["storage-policy:product_images_read"], `status ${swap.status}`);
  }

  // public reads are public by design (document)
  const pub = await http("GET", `/storage/v1/object/public/product-images/${A.objects.orgProduct.split("/").map(encodeURIComponent).join("/")}`, { token: null });
  record("storage", "product-images public read works (public bucket, by design)", pub.status < 300 ? "INFO" : "FAIL", ["storage-policy:product_images_read"],
    `status ${pub.status} (thumbnails are public by design; see audit doc §storage)`);
  // no OTHER bucket exists that is private and leaks
  const buckets = sql(`SELECT string_agg(id || ':' || public::text, ',') FROM storage.buckets`);
  record("storage", `buckets present: ${buckets}`, "INFO", []);

  await uploadLimits(w);
}

// ---------------------------------------------------------------- G5 / 083
// Staff (desktop) uploads go straight to storage-api with the user's JWT.
// 083 sets allowed_mime_types {jpeg,png,webp} + file_size_limit 5 MiB on the
// bucket; storage-api enforces both against the DECLARED type and the byte
// count. Before 083 (081/082 = production) these are GAPs (finding G5).
export const fixtures = {
  jpeg: (n = 2000) => Buffer.concat([Buffer.from("ffd8ffe000104a46494600", "hex"), Buffer.alloc(n, 0x11), Buffer.from("ffd9", "hex")]),
  png: () => Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(64, 0x22)]),
  webp: (n = 1500) => {
    const head = Buffer.alloc(20);
    head.write("RIFF", 0); head.writeUInt32LE(n + 12, 4); head.write("WEBP", 8); head.write("VP8 ", 12); head.writeUInt32LE(n, 16);
    return Buffer.concat([head, Buffer.alloc(n, 0x33)]);
  },
  html: () => Buffer.from("<!doctype html><html><body><script>document.title='g5'</script></body></html>"),
  svg: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="document.title=1"><script>1</script></svg>'),
  polyglot: () => Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.from("<html><body><script>document.title='g5'</script></body></html>"), Buffer.from("ffd9", "hex")]),
};
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
/** Remove a test object through storage-api (storage.objects refuses direct DELETE). */
export async function removeObject(name: string) {
  const r = await http("DELETE", `/storage/v1/object/product-images/${enc(name)}`, { token: SERVICE, apikey: SERVICE });
  if (r.status >= 300 && r.status !== 400 && r.status !== 404) throw new Error(`cleanup of a test object failed: ${r.status}`);
}
const rowCount = (name: string) => sql(`SELECT count(*) FROM storage.objects WHERE bucket_id='product-images' AND name=${q(name)}`);

async function uploadLimits(w: World) {
  const admin = w.adminA2, A = w.A;
  const G5 = MAX_MIG >= 83;
  const bucket = sql(`SELECT coalesce(file_size_limit::text,'NULL') || '|' || coalesce(allowed_mime_types::text,'NULL') || '|' || public::text FROM storage.buckets WHERE id='product-images'`);
  gap("storage", "G5: product-images has allowed_mime_types {image/jpeg,image/png,image/webp} and file_size_limit 5242880, still public",
    bucket === "5242880|{image/jpeg,image/png,image/webp}|true", ["storage-policy:product_images_insert"], "medium", `bucket ${bucket}`);

  const base = `org/${A.id}/products/${A.products[0]}/g5-${A.can}`;
  const put = (name: string, body: Buffer, type: string, multipart = false) => {
    if (!multipart) return http("POST", `/storage/v1/object/product-images/${enc(name)}`, { token: admin, raw: body, headers: { "Content-Type": type, "x-upsert": "true" } });
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", new Blob([body], { type }), name.split("/").pop());
    return http("POST", `/storage/v1/object/product-images/${enc(name)}`, { token: admin, raw: form, headers: { "x-upsert": "true" } });
  };

  // allowed: JPEG / PNG / WebP within the limit, raw and multipart (supabase-js sends either)
  for (const [label, body, type, multipart] of [
    ["JPEG raw", fixtures.jpeg(), "image/jpeg", false], ["PNG raw", fixtures.png(), "image/png", false],
    ["WebP raw", fixtures.webp(), "image/webp", false], ["WebP multipart", fixtures.webp(), "image/webp", true],
  ] as const) {
    const name = `${base}-ok-${label.replace(/\W+/g, "-")}`;
    const r = await put(name, body, type, multipart);
    capture(`storage g5 ${label}`, r.text);
    check("storage", `G5 desktop: staff upload of a ${label} image within the limit is accepted`, r.status < 300 && rowCount(name) === "1",
      ["storage-policy:product_images_insert"], `status ${r.status} ${r.text.slice(0, 120)}`);
    await removeObject(name);
  }

  // refused: active / unknown types, oversize - nothing stored
  const big = Buffer.concat([fixtures.jpeg(0), Buffer.alloc(5242881, 0x44)]);
  for (const [label, body, type, multipart] of [
    ["text/html", fixtures.html(), "text/html", false],
    ["text/html (multipart part type)", fixtures.html(), "text/html", true],
    ["image/svg+xml", fixtures.svg(), "image/svg+xml", false],
    ["application/octet-stream", fixtures.jpeg(), "application/octet-stream", false],
    ["text/html with charset", fixtures.html(), "text/html; charset=utf-8", false],
    ["over 5 MiB (declared image/jpeg)", big, "image/jpeg", false],
  ] as const) {
    const name = `${base}-bad-${label.replace(/\W+/g, "-")}`;
    const r = await put(name, body, type, multipart);
    capture(`storage g5 ${label}`, r.text);
    const stored = rowCount(name) !== "0";
    if (stored) await removeObject(name);
    gap("storage", `G5 desktop: staff upload declared ${label} is refused by storage-api, nothing stored`, r.status >= 400 && !stored,
      ["storage-policy:product_images_insert"], "medium", `status ${r.status}, stored ${stored}`);
  }

  // NOT refusable by the bucket: HTML bytes DECLARED image/jpeg (a ".jpg" with HTML,
  // or a JPEG-header polyglot). storage-api checks only the declared type. The
  // desktop path has no server-side byte check (doc §3.3: follow-up). What
  // matters for the browser is what is SERVED: Content-Type image/jpeg (+ the
  // optional gateway nosniff/CSP rule) - recorded below.
  for (const [label, body] of [[".jpg name with HTML content", fixtures.html()], ["JPEG-header + HTML polyglot", fixtures.polyglot()]] as const) {
    const name = `${base}-poly-${label.replace(/\W+/g, "-")}.jpg`;
    const r = await put(name, body, "image/jpeg");
    const stored = rowCount(name) === "1";
    const pub = await http("GET", `/storage/v1/object/public/product-images/${enc(name)}`, { token: null });
    const ct = pub.headers.get("content-type") ?? "";
    gap("storage", `G5 desktop: ${label} declared image/jpeg is not stored (needs a server-side byte check on the desktop path)`, !stored,
      ["storage-policy:product_images_insert"], "low",
      `stored ${stored} (status ${r.status}); served as Content-Type ${ct}, X-Content-Type-Options ${pub.headers.get("x-content-type-options") ?? "-"}, CSP ${pub.headers.get("content-security-policy") ?? "-"}`);
    check("storage", `G5 serving: ${label} is served with its declared image type, never as HTML`, !stored || /^image\/jpeg/i.test(ct),
      ["storage-policy:product_images_read"], `content-type ${ct}`);
    if (stored) await removeObject(name);
  }

  // serving headers of an existing (seeded) object: what the browser gets today
  const pub = await http("GET", `/storage/v1/object/public/product-images/${enc(A.objects.orgProduct)}`, { token: null });
  const h = (k: string) => pub.headers.get(k) ?? "-";
  record("storage", `G5 serving headers (storage-api direct, no gateway rule): status ${pub.status}; content-type ${h("content-type")}; x-content-type-options ${h("x-content-type-options")}; content-disposition ${h("content-disposition")}; content-security-policy ${h("content-security-policy")}; cache-control ${h("cache-control")}`,
    "INFO", ["storage-policy:product_images_read"]);
  check("storage", "G5: an existing image reference still resolves after the limits (public URL 200, image type)", pub.status === 200 && /^image\//.test(h("content-type")),
    ["storage-policy:product_images_read"], `status ${pub.status} ${h("content-type")}`);
  if (!G5) record("storage", "G5 assertions above are GAPs below migration 083 (production 081/082 has NULL limits)", "INFO", []);
}
