// phone-upload-page — hermetic tests (see _harness.ts). Runs the real
// supabase/functions/phone-upload-page/index.ts (and the client.js it embeds)
// with synthetic requests. The page function makes no network call at all:
// any fetch would hit the harness router and throw.
// docs/selfhost-migration/phase-f/phone-qr-origin.md
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { loadHandler, makeWorld, SERVICE_ROLE_KEY, setEnv, SUPABASE_URL, test } from "./_harness.ts";

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fakeJwt = (role: string) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ role, iss: "supabase" })}.not-a-real-signature-${role}`;
const ANON_KEY = fakeJwt("anon");
const QR_TOKEN = "a".repeat(32) + "b".repeat(32) + "c".repeat(32) + "d".repeat(32);

const call = async (path: string, init: RequestInit = {}) => {
  const handler = await loadHandler("phone-upload-page");
  const world = makeWorld(); // any network call from the page function is a test failure
  try {
    const res = await handler(new Request(`http://functions.local${path}`, init));
    const body = init.method === "HEAD" ? "" : await res.text();
    assertEquals(world.calls.length, 0, "the page function must not make network calls");
    return { res, body };
  } finally {
    world.restore();
  }
};

const quiet = async (fn: () => Promise<void>) => {
  const { error } = console;
  console.error = () => {};
  try { await fn(); } finally { console.error = error; }
};

const withAnon = (anon: string | undefined, extra: Record<string, string | undefined> = {}) =>
  setEnv({ SUPABASE_ANON_KEY: anon, ...extra });

test("phone-upload-page: GET /phone-upload-page: 200 self-contained text/html with a nonce CSP", async () => {
  withAnon(ANON_KEY);
  const { res, body } = await call("/phone-upload-page");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("x-frame-options"), "DENY");

  const csp = res.headers.get("content-security-policy") ?? "";
  const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9_-]{20,})'/)?.[1];
  assert(nonce, `CSP has a script nonce: ${csp}`);
  for (const d of ["default-src 'none'", `style-src 'nonce-${nonce}'`, "connect-src 'self'", "img-src blob: data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
    assertStringIncludes(csp, d);
  }
  assert(!/unsafe-inline|unsafe-eval|\*/.test(csp), "no unsafe-* or wildcard in the CSP");

  // exactly one inline script and one inline style, both carrying the nonce; no external resources
  assertEquals(body.match(/<script\b/g)?.length, 1);
  assertStringIncludes(body, `<script nonce="${nonce}">`);
  assertStringIncludes(body, `<style nonce="${nonce}">`);
  assert(!/<script[^>]*\ssrc=|<link\b|<iframe\b|<img\b|<object\b|<embed\b/i.test(body), "no external script/style/frame/image");
  const style = body.slice(body.indexOf(`<style nonce="${nonce}">`), body.indexOf("</style>"));
  assert(!/@import|url\(/i.test(style), "the inline style loads nothing");
  assert(!/https?:\/\//i.test(body), "no absolute URL anywhere in the page (same origin only, no CDN)");
  assertStringIncludes(body, '<meta name="referrer" content="no-referrer">');

  // the inline script is syntactically valid JavaScript
  const script = body.slice(body.indexOf(`<script nonce="${nonce}">`) + `<script nonce="${nonce}">`.length, body.lastIndexOf("</script>"));
  new Function(script);
  // it reads the token from the fragment and calls the existing endpoints, same origin
  for (const s of ["location.hash", "/functions/v1/phone-upload-token", "/rest/v1/rpc/", "\"get_product_image_upload_session_by_token\"", "\"complete_product_image_upload_session\"", "/storage/v1/object/upload/sign/", "\"x-upsert\"", "Retry-After"]) {
    assertStringIncludes(script, s);
  }
});

test("phone-upload-page: bilingual: English and Myanmar wording embedded, the same keys as the React page", async () => {
  withAnon(ANON_KEY);
  const { body } = await call("/phone-upload-page");
  for (const s of ["Choose or take a product photo.", "Photo uploaded. You can return to the computer.", "Too many attempts right now. Trying again automatically in {seconds} s...", "This upload link has been used too many times. Create a new QR code on the computer."]) {
    assertStringIncludes(body, s);
  }
  assertStringIncludes(body, "ကုန်ပစ္စည်းဓာတ်ပုံကို ရွေးပါ သို့မဟုတ် ရိုက်ပါ။");
});

test("phone-upload-page: keys: embeds the anon key only; never the service-role key or the internal URL", async () => {
  withAnon(ANON_KEY);
  const { body } = await call("/phone-upload-page");
  assertEquals(body.split(ANON_KEY).length - 1, 1, "anon key embedded exactly once (page config)");
  assert(!body.includes(SERVICE_ROLE_KEY), "service-role key must never be in the page");
  assert(!body.includes(SUPABASE_URL), "the internal SUPABASE_URL must not be in the page");
  assert(!/service_role|SERVICE_ROLE|JWT_SECRET/.test(body), "no service-role / secret names in the page");
});

test("phone-upload-page: keys: refuses to serve (503) when the configured 'anon' key is missing or is not an anon key", async () => {
  await quiet(async () => {
    for (const [label, anon, extra] of [
      ["missing", undefined, {}],
      ["empty", "  ", {}],
      ["same as the service-role key", SERVICE_ROLE_KEY, {}],
      ["a service_role JWT", fakeJwt("service_role"), {}],
      ["an authenticated JWT", fakeJwt("authenticated"), {}],
      ["an sb_secret_ key", "sb_secret_abcdef0123456789", {}],
    ] as const) {
      withAnon(anon, extra);
      const { res, body } = await call("/phone-upload-page");
      assertEquals(res.status, 503, label);
      assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8", label);
      if (anon && anon.trim()) assert(!body.includes(anon), `${label}: key not echoed`);
      assert(!body.includes(SERVICE_ROLE_KEY), label);
    }
  });
  // a publishable (non-JWT) key is accepted
  withAnon("sb_publishable_abcdef0123456789");
  assertEquals((await call("/phone-upload-page")).res.status, 200);
});

test("phone-upload-page: methods: GET and HEAD only (HEAD has headers, no body); everything else 405 with Allow", async () => {
  withAnon(ANON_KEY);
  const head = await call("/phone-upload-page", { method: "HEAD" });
  assertEquals(head.res.status, 200);
  assertEquals(head.res.headers.get("content-type"), "text/html; charset=utf-8");
  assert(head.res.headers.get("content-security-policy"));
  assertEquals(head.res.body, null);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const { res, body } = await call("/phone-upload-page", { method, body: method === "POST" || method === "PUT" || method === "PATCH" ? JSON.stringify({ token: QR_TOKEN }) : undefined });
    assertEquals(res.status, 405, method);
    assertEquals(res.headers.get("allow"), "GET, HEAD", method);
    assert(!body.includes(ANON_KEY), `${method}: no page, no key`);
  }
});

test("phone-upload-page: paths: the page only at /phone-upload-page (or the full gateway path); a token in the PATH is not served", async () => {
  withAnon(ANON_KEY);
  for (const p of ["/phone-upload-page", "/phone-upload-page/", "/functions/v1/phone-upload-page"]) {
    assertEquals((await call(p)).res.status, 200, p);
  }
  for (const p of [`/phone-upload-page/${QR_TOKEN}`, "/phone-upload-page/x/y", "/phone-upload-pages", "/", "/phone-upload-token"]) {
    const { res, body } = await call(p);
    assertEquals(res.status, 404, p);
    assert(!body.includes(QR_TOKEN) && !body.includes(ANON_KEY), p);
  }
});

test("phone-upload-page: token handling: nothing from the request is reflected; the fragment never reaches the server", async () => {
  withAnon(ANON_KEY);
  // A browser strips "#<token>" before sending; even a token or markup put in
  // the query string is ignored and not reflected.
  const evil = encodeURIComponent(`"><script>alert(1)</script>`);
  const { res, body } = await call(`/phone-upload-page?token=${QR_TOKEN}&x=${evil}`, { headers: { Referer: `https://elsewhere.invalid/${QR_TOKEN}` } });
  assertEquals(res.status, 200);
  assert(!body.includes(QR_TOKEN), "query token not reflected");
  assert(!body.includes("alert(1)"), "markup not reflected");
  // a fresh nonce per response
  const a = (await call("/phone-upload-page")).res.headers.get("content-security-policy");
  const b = (await call("/phone-upload-page")).res.headers.get("content-security-policy");
  assert(a !== b, "nonce differs per response");
  assertMatch(body, /var token = \(function \(\) \{\s*var raw = String\(win\.location\.hash/);
});
