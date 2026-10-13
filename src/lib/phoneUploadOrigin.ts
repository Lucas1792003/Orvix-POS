// ----------------------------------------------------------------------
// Where the phone opens the product-image upload page (the QR target).
//
// docs/selfhost-migration/phase-f/phone-qr-origin.md
//
// The QR must point at an https page that a phone on the tailnet can open.
// It must never be built from the renderer's own origin when that origin is
// not a web origin: the packaged Electron app runs from file:// (origin
// "file://" or "null"), and a custom protocol (app://) is no better.
//
//   * Electron (packaged or dev) and any non-http(s) page origin: the phone
//     page is the `phone-upload-page` Edge Function on the BACKEND origin,
//     i.e. the origin of VITE_SUPABASE_URL (build-time configuration, pinned
//     by VITE_SUPABASE_EXPECTED_HOST). The session token goes in the URL
//     FRAGMENT (#...), which browsers never send to the server (no access
//     log, no Referer).
//   * the web build on an https origin: the SPA route
//     /phone-upload/product-image/<token> on that origin, as before.
//
// Only https is accepted. http is accepted solely for a loopback host and
// only when the caller allows it (dev server / unit tests); the Electron
// build guard (vite.config.ts) never allows it.
//
// Dependency-free on purpose: imported by vite.config.ts (node) as well as
// by the browser bundle.
// ----------------------------------------------------------------------

/** SPA route of the phone page (web build). The token follows as a path segment. */
export const PRODUCT_IMAGE_PHONE_UPLOAD_ROUTE = "/phone-upload/product-image";

/** Edge Function that serves the self-contained phone page (Electron builds). */
export const PHONE_UPLOAD_PAGE_FUNCTION = "phone-upload-page";
export const PHONE_UPLOAD_PAGE_PATH = `/functions/v1/${PHONE_UPLOAD_PAGE_FUNCTION}`;

export class PhoneUploadOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneUploadOriginError";
  }
}

export type PhoneUploadPage =
  /** the backend's phone-upload-page function; the token goes in the fragment */
  | { kind: "functionPage"; origin: string; base: string }
  /** the web build's own SPA route; the token goes in the path (existing route) */
  | { kind: "spaRoute"; origin: string; base: string };

export interface PhoneUploadPageInput {
  /** VITE_SUPABASE_URL of this build. */
  supabaseUrl: string | null | undefined;
  /** window.location.origin of the renderer ("file://", "null", "app://x", "https://..."). */
  locationOrigin: string | null | undefined;
  /** Running inside the Electron app (window.electronAPI.isElectron). */
  isElectron: boolean;
  /** Accept http://localhost / 127.0.0.1 / [::1] (dev server and unit tests only). */
  allowLocalHttp: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const NOT_AVAILABLE =
  "Phone upload is not available in this build: the phone page needs a secure https address.";

/** The https origin of `raw`, or a PhoneUploadOriginError saying why not. */
function secureOrigin(raw: string | null | undefined, what: string, allowLocalHttp: boolean): URL {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value === "null") {
    throw new PhoneUploadOriginError(`${NOT_AVAILABLE} ${what} is not set.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PhoneUploadOriginError(`${NOT_AVAILABLE} ${what} is not a valid URL.`);
  }
  if (url.protocol === "https:" && url.host) return url;
  if (url.protocol === "http:" && allowLocalHttp && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new PhoneUploadOriginError(
    `${NOT_AVAILABLE} ${what} uses "${url.protocol}" (only https:// is allowed${allowLocalHttp ? ", or http://localhost in development" : ""}).`,
  );
}

/**
 * Decide which page the QR opens. Throws PhoneUploadOriginError (never
 * falls back to the renderer's own origin) when no secure page is configured.
 */
export function resolvePhoneUploadPage(input: PhoneUploadPageInput): PhoneUploadPage {
  const location = typeof input.locationOrigin === "string" ? input.locationOrigin.trim() : "";
  const isWebOrigin = /^https?:\/\//i.test(location);

  if (!input.isElectron && isWebOrigin) {
    const url = secureOrigin(location, "This page's address", input.allowLocalHttp);
    return { kind: "spaRoute", origin: url.origin, base: `${url.origin}${PRODUCT_IMAGE_PHONE_UPLOAD_ROUTE}` };
  }

  // Electron (file://, app://, or the dev server inside Electron) or a
  // renderer without a usable web origin: the backend serves the page.
  const url = secureOrigin(input.supabaseUrl, "The backend address (VITE_SUPABASE_URL)", input.allowLocalHttp);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new PhoneUploadOriginError(
      `${NOT_AVAILABLE} The backend address (VITE_SUPABASE_URL) must be a bare origin (https://host[:port]).`,
    );
  }
  return { kind: "functionPage", origin: url.origin, base: `${url.origin}${PHONE_UPLOAD_PAGE_PATH}` };
}

/** The QR URL for a session token on the resolved page. */
export function buildPhoneUploadQrUrl(page: PhoneUploadPage, sessionToken: string): string {
  const token = encodeURIComponent(sessionToken);
  return page.kind === "functionPage" ? `${page.base}#${token}` : `${page.base}/${token}`;
}

/**
 * Build-time check for the Electron build (vite.config.ts): the packaged
 * app always uses the backend-served phone page, so the backend origin must
 * be https and not a loopback host (a phone cannot reach the till's own
 * localhost). Returns the phone page base URL.
 */
export function assertElectronPhoneUploadOrigin(env: { VITE_SUPABASE_URL?: string }): string {
  const page = resolvePhoneUploadPage({
    supabaseUrl: env.VITE_SUPABASE_URL,
    locationOrigin: "file://",
    isElectron: true,
    allowLocalHttp: false,
  });
  if (LOOPBACK_HOSTS.has(new URL(page.origin).hostname)) {
    throw new PhoneUploadOriginError(
      `${NOT_AVAILABLE} The backend address (VITE_SUPABASE_URL) is a loopback host, which a phone cannot open.`,
    );
  }
  return page.base;
}
