// ----------------------------------------------------------------------
// Client identification (release 1.0.16).
//
// One place that says which build this is and what it can do, so a person
// at the till (login page, sidebar) and a machine (the X-Client-Info header
// on every API request) see the same thing. Per-device verification during
// the canary reads either: the screen, or the header on the server side
// (nothing logs it today; Envoy/PostgREST pass it through untouched because
// supabase-js always sends an X-Client-Info header and the CORS allow-list
// already names it).
//
// Header format:  shwephala-pos/<version> (<capability>; <capability>; ...)
//   e.g.          shwephala-pos/1.0.16 (validated-uploads; idem-v1; outbox-origin-v1; update-guard-v1)
//
// Capabilities are facts about THIS build, not about the server:
//   validated-uploads  desktop/logo images go only through the server-
//                      validated session flow (no direct Storage writes)
//   idem-v1            every mutating RPC carries p_idempotency_key
//   outbox-origin-v1   queued entries record their backend origin; entries
//                      for another backend are quarantined, never replayed
//   update-guard-v1    the desktop updater never installs while sales are
//                      unsynced or a sale is in progress
// Dependency-free on purpose (imported by lib/supabase.ts at module load).
// ----------------------------------------------------------------------

export const APP_NAME = "shwephala-pos";

/** package.json version, inlined at build time (vite.config.ts `define`). */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";

export const CLIENT_CAPABILITIES = [
  "validated-uploads",
  "idem-v1",
  "outbox-origin-v1",
  "update-guard-v1",
] as const;

export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number];

/** Value of the X-Client-Info request header. */
export function clientInfoHeader(
  version: string = APP_VERSION,
  capabilities: readonly string[] = CLIENT_CAPABILITIES,
): string {
  return `${APP_NAME}/${version} (${capabilities.join("; ")})`;
}

export const CLIENT_INFO = clientInfoHeader();

/** Parse a header produced by clientInfoHeader() (for tests and tooling). */
export function parseClientInfo(value: string): { name: string; version: string; capabilities: string[] } | null {
  const m = /^([a-z0-9-]+)\/(\S+) \(([^)]*)\)$/.exec(value.trim());
  if (!m) return null;
  const capabilities = m[3].split(";").map((c) => c.trim()).filter(Boolean);
  return { name: m[1], version: m[2], capabilities };
}

/** Human line for the login page / sidebar, e.g. "validated uploads: yes". */
export const CAPABILITY_SUMMARY = "validated uploads: yes · backend-tagged queue: yes · update guard: yes";
