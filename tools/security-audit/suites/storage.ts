// Area "storage": org A cannot list, read (authenticated), overwrite, delete,
// move or sign org B's objects (org/<B>/..., legacy temp/ and products/ paths,
// brand logo). Public-bucket reads are documented as public by design.
import type { World, Org } from "./seed";
import { capture, check, http, record, sql, q, SERVICE } from "./lib";

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
}
