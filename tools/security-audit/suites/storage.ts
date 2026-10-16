// Area "storage": org A cannot list, read (authenticated), overwrite, delete,
// move or sign org B's objects (org/<B>/..., legacy temp/ and products/ paths,
// brand logo). Public-bucket reads are documented as public by design.
import type { World, Org } from "./seed";
import { capture, check, gap, http, record, rpc, sql, q, ANON, MAX_MIG, SERVICE } from "./lib";

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
    if (MAX_MIG >= 84) {
      // 084: staff have no INSERT/UPDATE policy any more - even a valid image is refused on the direct path
      const stored = rowCount(name) !== "0";
      check("storage", `G5/084 desktop: a staff DIRECT upload of a valid ${label} image is refused (only the validated session flow writes)`,
        r.status >= 400 && !stored, ["storage-policy:product_images_read"], `status ${r.status}, stored ${stored}`);
    } else {
      check("storage", `G5 desktop: staff upload of a ${label} image within the limit is accepted`, r.status < 300 && rowCount(name) === "1",
        ["storage-policy:product_images_insert"], `status ${r.status} ${r.text.slice(0, 120)}`);
    }
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

  await desktopValidated(w);
}

// ---------------------------------------------------------------- G5 follow-up / 084
// The desktop build of the G5 follow-up uploads through the validated session
// flow with ITS OWN JWT: create_product_image_upload_session (authenticated;
// org/path derived server-side) -> phone-upload-token {token} -> signed PUT
// -> phone-upload-token {token, action:"complete"} (byte check) -> it saves
// the server-derived URL. This works from 083 on (function + RPC grants); 084
// then removes the staff write policies (the old direct path).
async function desktopValidated(w: World) {
  const admin = w.adminA2, A = w.A;
  if (MAX_MIG < 83) {
    record("storage", "G5 follow-up desktop validated flow: skipped below 083 (the validating completion is not there)", "SKIP", ["edge-fn:phone-upload-token"]);
    return;
  }
  const covers = ["edge-fn:phone-upload-token", "rpc:public.create_product_image_upload_session", "rpc:public.complete_product_image_upload_session"];
  const session = async (productId: string | null) => {
    const r = await rpc(admin, "create_product_image_upload_session", { p_shop_id: A.shops[0], p_product_id: productId });
    if (r.status >= 300) throw new Error(`create session: ${r.status}`);
    return { id: String(r.json.sessionId), token: String(r.json.token), path: String(r.json.storagePath) };
  };
  const signedPut = async (sessionToken: string, body: Buffer, type: string) => {
    const t = await http("POST", "/functions/v1/phone-upload-token", { token: admin, body: { token: sessionToken } });
    if (t.status !== 200 || !t.json?.token) return { status: -t.status, path: "" };
    const form = new FormData();
    form.append("cacheControl", "31536000");
    form.append("", new Blob([body], { type }));
    // the signed PUT carries the upload token in the URL; the bearer is the public anon key (as supabase-js sends it)
    const r = await http("PUT", `/storage/v1/object/upload/sign/product-images/${enc(t.json.path)}?token=${encodeURIComponent(t.json.token)}`,
      { token: ANON, raw: form, headers: { "x-upsert": "false" } });
    return { status: r.status, path: String(t.json.path) };
  };
  const complete = (sessionToken: string) => http("POST", "/functions/v1/phone-upload-token", { token: admin, body: { token: sessionToken, action: "complete" } });
  const statusOf = (id: string) => sql(`SELECT status FROM product_image_upload_sessions WHERE id=${q(id)}`);

  // valid images (product photo and logo) complete; the desktop receives the server-derived URL and saves it
  for (const [label, productId, body, type] of [
    ["product WebP", A.products[0], fixtures.webp(), "image/webp"],
    ["logo JPEG (productId brand)", "brand", fixtures.jpeg(), "image/jpeg"],
  ] as const) {
    const s = await session(productId);
    const up = await signedPut(s.token, body, type);
    const c = await complete(s.token);
    capture(`storage g5 desktop ${label}`, c.text, [A.id, s.id, s.path]);
    const expectedUrl = `http://127.0.0.1/storage/v1/object/public/product-images/${s.path}`;
    check("storage", `G5 follow-up desktop: a ${label} goes create session -> token (user JWT) -> signed PUT -> validating completion; URL = server-derived for org/<A>/temp/<session>`,
      s.path === `org/${A.id}/temp/${s.id}` && up.status < 300 && c.status === 200 && c.json?.status === "COMPLETED"
        && c.json?.publicUrl === expectedUrl && rowCount(s.path) === "1",
      covers, `path ok ${s.path === `org/${A.id}/temp/${s.id}`}, put ${up.status}, complete ${c.status} ${c.text.slice(0, 160)}`);
    if (productId !== "brand" && c.json?.publicUrl) {
      const save = await http("PATCH", `/rest/v1/products?id=eq.${encodeURIComponent(productId)}`,
        { token: admin, body: { image_url: c.json.publicUrl }, headers: { Prefer: "return=minimal" } });
      check("storage", "G5 follow-up desktop: the trusted URL is saved on the product (products.image_url)",
        save.status < 300 && sql(`SELECT image_url FROM products WHERE id=${q(productId)}`) === expectedUrl, ["table:public.products"], `status ${save.status}`);
    }
    // the completed object cannot be replaced afterwards: from 084 not even with the staff JWT
    const over = await http("POST", `/storage/v1/object/product-images/${enc(s.path)}`,
      { token: admin, raw: fixtures.polyglot(), headers: { "Content-Type": "image/jpeg", "x-upsert": "true" } });
    const sizeNow = sql(`SELECT metadata->>'size' FROM storage.objects WHERE bucket_id='product-images' AND name=${q(s.path)}`);
    if (MAX_MIG >= 84) {
      check("storage", `G5/084 desktop: staff cannot overwrite the validated ${label} object with its own JWT (upsert refused, bytes unchanged)`,
        over.status >= 400 && sizeNow === String(body.length), ["storage-policy:product_images_read"], `status ${over.status}, size ${sizeNow}`);
    } else {
      gap("storage", `G5 desktop: staff cannot overwrite the validated ${label} object with its own JWT (closed by 084)`,
        over.status >= 400 && sizeNow === String(body.length), ["storage-policy:product_images_update"], "low", `status ${over.status}, size ${sizeNow}`);
    }
  }

  // markup through the desktop flow: refused and deleted exactly like a phone upload
  {
    const s = await session(A.products[0]);
    const up = await signedPut(s.token, fixtures.polyglot(), "image/jpeg");
    const stored = up.path ? rowCount(up.path) : "?";
    const c = await complete(s.token);
    capture("storage g5 desktop polyglot", c.text, [A.id, s.id, s.path]);
    check("storage", "G5 follow-up desktop: a JPEG-header + HTML polyglot via the desktop flow -> 422 invalid_image, object DELETED, session PENDING",
      up.status < 300 && stored === "1" && c.status === 422 && c.json?.code === "invalid_image" && rowCount(s.path) === "0" && statusOf(s.id) === "PENDING",
      covers, `put ${up.status} stored ${stored}, complete ${c.status} ${c.json?.code ?? ""}`);
    const cancel = await rpc(admin, "cancel_product_image_upload_session", { p_session_id: s.id });
    check("storage", "G5 follow-up desktop: the refused session is cancelled by the desktop (eligible for the abandoned-upload sweep, nothing stored)",
      cancel.status < 300 && statusOf(s.id) === "CANCELED", ["rpc:public.cancel_product_image_upload_session"], `status ${cancel.status}`);
  }

  // 084: the direct path is closed for every staff role and every path shape (incl. the own live session path)
  if (MAX_MIG >= 84) {
    const live = await session(A.products[0]);
    const paths: [string, string][] = [
      ["org product path", `org/${A.id}/products/${A.products[0]}/direct-${A.can}.jpg`],
      ["org logo path", `org/${A.id}/products/brand/direct-${A.can}.jpg`],
      ["its own live session path", live.path],
      ["legacy products/ path", `products/${A.products[0]}/direct-${A.can}.jpg`],
    ];
    for (const [who, token] of [["ADMIN", admin], ["MANAGER", A.people.mgr.token]] as const) {
      for (const [label, p] of paths) {
        const r = await http("POST", `/storage/v1/object/product-images/${enc(p)}`, { token, raw: fixtures.jpeg(), headers: { "Content-Type": "image/jpeg" } });
        const stored = rowCount(p) !== "0";
        if (stored) await removeObject(p);
        check("storage", `G5/084: ${who} direct upload to the ${label} is refused`, r.status >= 400 && !stored, ["storage-policy:product_images_read"], `status ${r.status}`);
      }
      const sign = await http("POST", `/storage/v1/object/upload/sign/product-images/${enc(live.path)}`, { token, body: {} });
      check("storage", `G5/084: ${who} cannot mint a signed upload URL for its own live session path (only phone-upload-token can, as service role)`,
        sign.status >= 400, ["storage-policy:product_images_read"], `status ${sign.status}`);
    }
    await rpc(admin, "cancel_product_image_upload_session", { p_session_id: live.id });
  }
}

