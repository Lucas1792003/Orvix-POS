// ----------------------------------------------------------------------
// Hosted-backend guard for every automated run (vitest unit suite, the live
// suite in src/live/, and — through its own copy of the host check — the
// Playwright harness in e2e/helpers/).
//
// Background: docs/selfhost-migration/evidence/G9/2026-10-12-phase-e.md
// "Incident". A probe once ran the app against the HOSTED Supabase project
// (`*.supabase.co`, picked up from .env.local) and the old login path
// created an auth account there. Self-hosted testing must never be able to
// reach that host again, so any attempt is (1) refused at the network
// boundary and (2) remembered, so the test harness can turn it into a hard
// failure of the run rather than a swallowed `{ error }`.
//
// Deliberately free of vitest/playwright imports: it is loaded by the
// vitest setup file AND by src/live/liveHelpers.ts (which the e2e tsconfig
// type-checks too).
// ----------------------------------------------------------------------

export const HOSTED_SUPABASE_SUFFIX = ".supabase.co";

export class HostedBackendError extends Error {
  constructor(url: string, context: string) {
    super(`Refusing to contact the hosted Supabase project (${hostOf(url)}) during ${context}. ` +
      "Self-hosted testing must only ever talk to the self-hosted stack.");
    this.name = "HostedBackendError";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable URL)";
  }
}

/** True when `url` targets `*.supabase.co` (any scheme, any port). */
export function isHostedSupabaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Not a URL at all — cannot be the hosted project.
    return false;
  }
  return host === HOSTED_SUPABASE_SUFFIX.slice(1) || host.endsWith(HOSTED_SUPABASE_SUFFIX);
}

/** Throws when `url` targets the hosted project. */
export function assertNotHostedUrl(url: string, context: string): void {
  if (isHostedSupabaseUrl(url)) throw new HostedBackendError(url, context);
}

const attempts: string[] = [];

/** Every refused request since the last `takeHostedAttempts()`. */
export function takeHostedAttempts(): string[] {
  return attempts.splice(0);
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof (input as { url?: unknown }).url === "string") return (input as { url: string }).url;
  return String(input);
}

/**
 * Patch `fetch` and `WebSocket` on `target` so that any request to
 * `*.supabase.co` is refused with HostedBackendError and recorded. Returns
 * an uninstall function. Installing twice is a no-op.
 */
export function installHostedBackendGuard(target: typeof globalThis = globalThis): () => void {
  const marker = "__orvixHostedBackendGuard";
  const holder = target as typeof globalThis & { [marker]?: () => void };
  if (holder[marker]) return holder[marker];

  const originalFetch = target.fetch;
  const guardedFetch: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    if (isHostedSupabaseUrl(url)) {
      attempts.push(url);
      // A thrown error (not a rejected promise) so a caller that maps
      // network failures to `{ error }` cannot quietly absorb it either.
      throw new HostedBackendError(url, "a test run");
    }
    return originalFetch.call(target, input, init);
  };
  target.fetch = guardedFetch;

  const OriginalWebSocket = (target as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof OriginalWebSocket === "function") {
    class GuardedWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const text = url instanceof URL ? url.href : String(url);
        if (isHostedSupabaseUrl(text)) {
          attempts.push(text);
          throw new HostedBackendError(text, "a test run");
        }
        super(url, protocols);
      }
    }
    (target as { WebSocket: typeof WebSocket }).WebSocket = GuardedWebSocket;
  }

  const uninstall = () => {
    if (target.fetch === guardedFetch) target.fetch = originalFetch;
    if (OriginalWebSocket) (target as { WebSocket: typeof WebSocket }).WebSocket = OriginalWebSocket;
    delete holder[marker];
  };
  holder[marker] = uninstall;
  return uninstall;
}
