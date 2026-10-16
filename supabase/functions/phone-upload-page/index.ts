// phone-upload-page: the product-image phone upload page, served from the
// API origin itself (docs/selfhost-migration/phase-f/phone-qr-origin.md).
//
// Why: the packaged Electron app runs from file://, so it cannot put its own
// origin in the QR. The tills already know one https origin that every phone
// on the tailnet can reach - the backend (VITE_SUPABASE_URL, the tailnet-only
// `tailscale serve` origin). /functions/v1/* is already routed there by the
// gateway, so a function can serve the page with no gateway change.
//
// QR: https://<api origin>/functions/v1/phone-upload-page#<session token>
// The token stays in the FRAGMENT: browsers never send it to the server, so
// this function never sees it, and it is in no access log or Referer.
//
// What it serves: one self-contained HTML document (no external resources,
// no CDN), its script and style inlined under a per-response CSP nonce. The
// page talks only to its own origin (connect-src 'self') with the PUBLIC anon
// key: the same calls as the React phone page (session status RPC, the
// phone-upload-token function, the signed-URL PUT, the completion RPC).
// Nothing from the request is reflected into the page. The service-role key
// is never read for the page and the function refuses to serve if the key
// it would embed is not an anon key.
//
// Methods: GET / HEAD only (405 otherwise). Path: exactly /phone-upload-page
// (404 for anything below it, so a token can never be "supported" in the
// path by accident).
//
// Router note (self-hosted): the upstream edge-runtime main router checks a
// JWT on every non-OPTIONS request when VERIFY_JWT=true. A browser navigation
// carries no Authorization header, so such a router needs a small
// allow-list for GET/HEAD to this one function only (kept with the
// deployment configuration, not in this repository). See the doc above.
import { phoneUploadPage } from "./client.js";
import { PHONE_UPLOAD_PAGE_MESSAGES } from "./messages.ts";

const FUNCTION_PATH = /^\/(?:functions\/v1\/)?phone-upload-page\/?$/;

const baseHeaders: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), payment=(), usb=()",
};

const text = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8", ...extra } });

/** JWT payload `role`, or null (payload only: the key is not verified here, the gateway does that). */
const jwtRole = (key: string): string | null => {
  const part = key.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const role = (JSON.parse(atob(b64)) as { role?: unknown }).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
};

/** The key the page may embed: the anon key, never anything that could be the service role. */
const publicAnonKey = (): string | null => {
  const anon = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  if (!anon) return null;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (service && anon === service) return null;
  if (anon.startsWith("sb_secret_")) return null;
  const role = jwtRole(anon);
  if (role !== null && role !== "anon") return null;
  return anon;
};

const nonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
};

/** JSON for a <script> body: no "</script" or "<!--" can appear in it. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;background:#f8fafc;color:#0f172a;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Myanmar","Myanmar Text",Padauk,sans-serif;padding:24px 16px;display:flex;align-items:center;justify-content:center}
main{width:100%;max-width:28rem}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:24px;padding:20px;box-shadow:0 20px 25px -5px rgba(15,23,42,.1),0 8px 10px -6px rgba(15,23,42,.1)}
.head{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.badge{width:48px;height:48px;border-radius:16px;background:#d1fae5;color:#047857;display:flex;align-items:center;justify-content:center;font-weight:700}
.grow{flex:1}
h1{font-size:1.125rem;margin:0;font-weight:700}
.sub{margin:0;font-size:.875rem;color:#64748b}
.lang{border:1px solid #e2e8f0;background:#fff;border-radius:999px;padding:4px 12px;font-size:.75rem;font-weight:600;color:#475569}
.status{border:1px solid #e2e8f0;background:#f8fafc;border-radius:16px;padding:12px 16px;font-size:.875rem;font-weight:500;color:#334155}
.compressed{margin:12px 0 0;font-size:.875rem;font-weight:500;color:#047857}
.error{margin-top:12px;border:1px solid #fecdd3;background:#fff1f2;border-radius:16px;padding:12px 16px;font-size:.875rem;color:#be123c}
.buttons{display:grid;gap:12px;margin-top:20px}
.btn{width:100%;border-radius:12px;padding:14px 16px;font-size:1rem;font-weight:600;border:1px solid transparent;background:#059669;color:#fff}
.btn.secondary{background:#fff;color:#0f172a;border-color:#cbd5e1}
.btn:disabled{opacity:.5}
.done{margin-top:20px;border-radius:16px;background:#ecfdf5;padding:12px 16px;text-align:center;font-size:.875rem;font-weight:500;color:#047857}
input[type=file]{display:none}
`;

const renderPage = (anonKey: string, n: string): string => {
  const cfg = scriptJson({ anonKey, messages: PHONE_UPLOAD_PAGE_MESSAGES });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Product photo upload</title>
<style nonce="${n}">${STYLE}</style>
</head>
<body>
<main>
<div class="card">
<div class="head">
<div class="badge" aria-hidden="true">SPL</div>
<div class="grow"><h1 id="title">Product photo upload</h1><p class="sub">ShwePhaLa Retail</p></div>
<button type="button" class="lang" id="lang">မြန်မာ</button>
</div>
<div class="status" id="status" role="status" aria-live="polite">Checking upload link...</div>
<p class="compressed" id="compressed" hidden></p>
<div class="error" id="error" role="alert" hidden></div>
<div class="buttons">
<button type="button" class="btn" id="take" disabled>Take photo</button>
<button type="button" class="btn secondary" id="choose" disabled>Choose from library</button>
</div>
<input id="camera-input" type="file" accept="image/*" capture="environment">
<input id="library-input" type="file" accept="image/*">
<p class="done" id="done" hidden></p>
</div>
</main>
<noscript><p>JavaScript is required to upload a photo.</p></noscript>
<script nonce="${n}">(${phoneUploadPage.toString()})(window, ${cfg});</script>
</body>
</html>
`;
};

Deno.serve((request) => {
  const { pathname } = new URL(request.url);
  if (!FUNCTION_PATH.test(pathname)) return text("Not found.", 404);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text("Method not allowed.", 405, { Allow: "GET, HEAD" });
  }

  const anonKey = publicAnonKey();
  if (!anonKey) {
    console.error("[phone-upload-page] no usable anon key configured");
    return text("Phone upload is temporarily unavailable.", 503);
  }

  const n = nonce();
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${n}'`,
    `style-src 'nonce-${n}'`,
    "img-src blob: data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = { ...baseHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(renderPage(anonKey, n), { status: 200, headers });
});
