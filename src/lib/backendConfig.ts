// ----------------------------------------------------------------------
// Backend selection, fail-closed.
//
// The app must never fall back to a default backend: a missing or empty
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY is a configuration error that
// stops the app at startup (and the build — vite.config.ts runs the same
// check), not a silent `createClient("undefined", "undefined")`.
//
// VITE_SUPABASE_EXPECTED_HOST pins a build to one backend: when it is set,
// the URL's host must match it exactly, so a production bundle (web or
// Electron; the value comes from the build environment) refuses to start — or
// build — against anything else, e.g. the hosted project that a stray
// .env.local still points at. vite.config.ts requires the pin for every
// production build; see docs/deployment-safety.md.
//
// Dependency-free on purpose: imported by vite.config.ts (node) as well
// as by src/lib/supabase.ts (browser bundle).
// ----------------------------------------------------------------------

export interface BackendEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_SUPABASE_EXPECTED_HOST?: string;
}

export interface BackendConfig {
  url: string;
  anonKey: string;
  /** `host` of the URL (hostname plus port when present) — what the UI shows. */
  host: string;
}

export class BackendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendConfigError";
  }
}

const trimmed = (value: string | undefined): string => (typeof value === "string" ? value.trim() : "");

/**
 * Validate the backend env and return the effective config. Throws
 * BackendConfigError (never returns a default) when a value is missing,
 * the URL is malformed, or the host does not match the expected host.
 */
export function resolveBackendConfig(env: BackendEnv): BackendConfig {
  const url = trimmed(env.VITE_SUPABASE_URL).replace(/\/+$/, "");
  const anonKey = trimmed(env.VITE_SUPABASE_ANON_KEY);
  const expectedHost = trimmed(env.VITE_SUPABASE_EXPECTED_HOST).toLowerCase();

  if (!url) {
    throw new BackendConfigError(
      "VITE_SUPABASE_URL is not set. The app refuses to start without an explicit backend URL — " +
      "set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for the build (see docs/07-setup-deployment.md).",
    );
  }
  if (!anonKey) {
    throw new BackendConfigError(
      "VITE_SUPABASE_ANON_KEY is not set. The app refuses to start without the backend's anon key.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BackendConfigError("VITE_SUPABASE_URL is not a valid URL (expected e.g. https://host[:port]).");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BackendConfigError(`VITE_SUPABASE_URL must be an http(s) URL, got scheme "${parsed.protocol}".`);
  }
  if (!parsed.host) {
    throw new BackendConfigError("VITE_SUPABASE_URL has no host.");
  }

  const host = parsed.host.toLowerCase();
  if (expectedHost && host !== expectedHost) {
    throw new BackendConfigError(
      `Backend host mismatch: this build expects "${expectedHost}" (VITE_SUPABASE_EXPECTED_HOST) ` +
      `but VITE_SUPABASE_URL points at "${host}". Refusing to start against an unexpected backend.`,
    );
  }

  return { url, anonKey, host };
}
